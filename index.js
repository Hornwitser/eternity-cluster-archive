import fs from "node:fs/promises";
import http from "node:http";
import stream from "node:stream/promises";
import { el, htmlDocument, prettify } from "antihtml";
import yazl from "yazl";
import { TarFile } from "./ustar.js";

const PORT = process.env.PORT ? Number.parse(process.env.PORT, 10) : 8000;
const PUBLIC_URL = envPublicUrl(process.env.PUBLIC_URL ?? "");
const ROOT_DIR = process.env.ROOT_DIR ?? "public";

const mimeTypes = new Map(Object.entries({
	".css": "text/css; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".zip": "application/zip",
}));

function envPublicUrl(url) {
	if (url.endsWith("/")) {
		return url.slice(0, -1);
	}
	return url;
}

// Encode header token as quoted string
function quotedString(str) {
	str = str.replace(/"/, '\"');
	// Remove non iso-8859-1 characters
	str = str.replace(/[^\t\x20-\x7e\x80-\xff]/g, "?");
	return `"${str}"`;
}

const strcmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

function* map(fn, iter) {
	for (const item of iter) {
		yield fn(item);
	}
}

function basePage(title, ...body) {
	return el("html", { "lang": "en" },
		el("head",
			el("link", { rel: "stylesheet", href: PUBLIC_URL + "/style.css" }),
			el("title", title),
		),
		el("body",
			el("h1", title),
			body
		),
	);
}

function aboutSection(node) {
	return [
		el("h2", "About"),
		el("p", "A minimal viable hosting of the saves from the Eternity Cluster."),
	];
}

function directoryListing(dir) {
	return el("div",
		dir instanceof Root ? null : parentEntry(),
		map(directoryEntry, dir.entries.values()),
		el("p",
			"Download as ",
			el("a", { href: `${PUBLIC_URL}/pack?format=zip&path=${dir.path}` }, "zip file"),
			" or ",
			el("a", { href: `${PUBLIC_URL}/pack?format=tar&path=${dir.path}` }, "tar file"),
		),
		el("p",
			"Also available as: ",
			el("a", { href: `${PUBLIC_URL}/files?format=plain&path=${dir.path}` }, "Plain text listing"),
			" ",
			el("a", { href: `${PUBLIC_URL}/meta?path=${dir.path}` }, "JSON structure"),
		),
	);
}

function parentEntry() {
	return el("div",
		el("a", { href: "../" }, "../"),
	);
}

function directoryEntry(entry) {
	if (entry instanceof Instance) {
		return el("div",
			el("a", { href: entry.name + "/" }, entry.title),
		);
	}
	if (entry instanceof File) {
		return el("div",
			el("a", { href: entry.name }, entry.name),
			` ${entry.stat.size} Bytes`,
		);
	}
	if (entry instanceof Dir) {
		return el("div",
			el("a", { href: entry.name + "/" }, `${entry.name}/`),
		);
	}
	throw new Error("Unexpected entry");
}


class Root {
	entries = new Map();
	realPath = ROOT_DIR;
	get path() {
		return "/";
	}
	toJSON() {
		return { type: "root", entries: [...this.entries.values()] };
	}
	toHTML() {
		return basePage(
			"Eternity Cluster Saves",
			directoryListing(this),
			aboutSection(this),
		);
	}
}

class Node {
	parent;
	name;
	realPath
	constructor(parent, name, realPath) {
		this.name = name;
		this.parent = parent;
		this.realPath = realPath;
		parent.entries.set(name, this);
	}
}

function mimeFor(name) {
	const ext = name.slice(name.lastIndexOf("."));
	const mime = mimeTypes.get(ext);
	if (!mime) {
		throw new Error(`Missing MIME type for ${name}`);
	}
	return mime;
}

class File extends Node {
	stat;
	constructor(parent, name, realPath, stat) {
		super(parent, name, realPath)
		this.stat = stat;
		this.mime = mimeFor(name);
	}
	get path() {
		return this.parent.path + this.name;
	}
	toJSON() {
		return { type: "file", name: this.name, size: this.stat.size };
	}
}

class Dir extends Node {
	entries = new Map();
	get path() {
		return this.parent.path + this.name + "/";
	}
	toJSON() {
		return { type: "dir", name: this.name, entries: [...this.entries.values()] };
	}
	toHTML() {
		return basePage(
			`${this.path} - Eternity Cluster`,
			directoryListing(this),
		);
	}
}

class InstancesDir extends Dir {
	toHTML() {
		return basePage(
			"Eternity Cluster Instances",
			directoryListing(this),
		);
	}
}

class Instance extends Dir {
	config;
	title;
	id;
	constructor(parent, name, realPath, config) {
		super(parent, name, realPath)
		this.config = config;
		this.title = config["instance.name"];
		this.id = config["instance.id"];
	}
	toJSON() {
		return {
			type: "instance",
			name: this.name,
			title: this.title,
			id: this.id,
			entries: [...this.entries.values()]
		};
	}
	toHTML() {
		return basePage(
			`${this.title} - Eternity Cluster`,
			directoryListing(this),
		);
	}
}

function entryPath(entry) {
	return "/" + entry.path.replace(/\\/g, "/") + "/" + entry.name;
}

async function buildEntry(tree, parent, entry, realPath) {
	if (entry.isDirectory()) {
		let dir;
		if (parent instanceof Root && entry.name === "instances") {
			dir = new InstancesDir(parent, entry.name, realPath);
		} else if (parent instanceof InstancesDir) {
			const config = JSON.parse(await fs.readFile(realPath + "/instance.json", "utf8"));
			dir = new Instance(parent, entry.name, realPath, config);
		} else {
			dir = new Dir(parent, entry.name, realPath);
		}
		tree.set(dir.path, dir);
	}
	if (entry.isFile()) {
		const stat = await fs.stat(realPath);
		const file = new File(parent, entry.name, realPath, stat);
		tree.set(file.path, file);
	}
}

async function buildTree() {
	const tree = new Map();
	const root = new Root();
	tree.set("/", root);

	const entries = await fs.readdir(ROOT_DIR, { withFileTypes: true, recursive: true });
	entries.sort((a, b) => strcmp(entryPath(a), entryPath(b)));
	for (const entry of entries) {
		const parentPath = entry.path.slice(ROOT_DIR.length).replace(/\\/g, "/");
		const parent = tree.get(parentPath + "/");
		const realPath = entry.path + "/" + entry.name;
		await buildEntry(tree, parent, entry, realPath);
	}
	return tree;
}

console.log("Scanning files");
const tree = await buildTree();

class VirtualFile {
	content;
	constructor(name, content) {
		this.content = content;
		this.name = name;
		this.mime = mimeFor(name);
	}
	async get(_req, res) {
		res.writeHead(200, {
			"Content-Type": this.mime,
			"Content-Length": `${this.content.length}`,
		});
		res.end(this.content);
	}
}

class FileListing {
	tree;
	constructor(tree) {
		this.tree = tree;
	}
	async get(req, res) {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const format = url.searchParams.get("format") ?? "plain";
		const node = this.tree.get(url.searchParams.get("path") ?? "/");
		if (!node) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
			return;
		}

		if (format === "plain") {
			const stack = [node];
			const lines = [];
			while (stack.length) {
				const current = stack.pop();
				if (current instanceof Dir || current instanceof Root) {
					stack.push(...[...current.entries.values()].toReversed());
				}
				if (current instanceof File) {
					lines.push(PUBLIC_URL + current.path + "\n");
				}
			}
			const content = Buffer.from(lines.join(""), "utf8");
			res.writeHead(200, {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": `${content.length}`,
			});
			res.end(content);
		} else if (format === "json") {
			const stack = [node];
			const lines = [];
			while (stack.length) {
				const current = stack.pop();
				if (current instanceof Dir || current instanceof Root) {
					stack.push(...[...current.entries.values()].toReversed());
				}
				if (current instanceof File) {
					lines.push({ type: "file", path: current.path, size: current.stat.size });
				}
			}
			const content = Buffer.from(JSON.stringify(lines, undefined, "\t"), "utf8");
			res.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
				"Content-Length": `${content.length}`,
			});
			res.end(content);
		} else {
			const content = Buffer.from(`Invalid format ${format}, valid values: plain, json`, "utf8");
			res.writeHead(400, {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": `${content.length}`,
			});
			res.end(content);
		}
	}
}

class Metadata {
	tree;
	constructor(tree) {
		this.tree = tree;
	}
	async get(req, res) {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const node = this.tree.get(url.searchParams.get("path") ?? "/");
		if (!node) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
			return;
		}
		const content = Buffer.from(JSON.stringify(node, undefined, "\t"), "utf8");
		res.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": `${content.length}`,
		});
		res.end(content);
	}
}

class Packer {
	tree;
	constructor(tree) {
		this.tree = tree;
	}
	async createZipStream(node) {
		const zipFile = new yazl.ZipFile();
		if (node instanceof File) {
			zipFile.addFile(
				node.realPath,
				node.name,
				{ compress: false },
			);
		} else {
			const stack = [node];
			while (stack.length) {
				const current = stack.pop();
				if (current instanceof Dir || current instanceof Root) {
					stack.push(...[...current.entries.values()].toReversed());
				}
				if (current instanceof File) {
					zipFile.addFile(
						current.realPath,
						current.path.slice(node.path.length),
						{ compress: false },
					);
				}
			}
		}
		const zipLength = await new Promise(resolve => {
			zipFile.end(undefined, resolve);
		});
		return [zipFile.outputStream, zipLength];
	}
	async createTarStream(node) {
		const tarFile = new TarFile();
		if (node instanceof File) {
			tarFile.addFile(
				node.realPath,
				node.name,
				node.stat,
			);
		} else {
			const stack = [node];
			while (stack.length) {
				const current = stack.pop();
				if (current instanceof Dir || current instanceof Root) {
					stack.push(...[...current.entries.values()].toReversed());
				}
				if (current instanceof File) {
					tarFile.addFile(
						current.realPath,
						current.path.slice(node.path.length),
						current.stat,
					);
				}
			}
		}
		const tarLength = tarFile.end();
		return [tarFile.outputStream, tarLength];
	}
	async get(req, res) {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const format = url.searchParams.get("format");
		const node = this.tree.get(url.searchParams.get("path") ?? "/");
		if (!node) {
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Not Found");
			return;
		}
		let fileName;
		if (node instanceof Instance) {
			fileName = node.title.replace(" / ", "");
		} else if (node instanceof InstancesDir) {
			fileName = "Eternity Cluster Instances";
		} else if (node instanceof Root) {
			fileName = "Eternity Cluster";
		} else {
			fileName = node.name;
		}

		if (format === "zip") {
			const [zipStream, zipLength] = await this.createZipStream(node);
			res.writeHead(200, {
				"Content-Type": "application/zip",
				"Content-Length": `${zipLength}`,
				"Content-Disposition": `attachment; filename=${quotedString(fileName + ".zip")}`
			});
			await stream.pipeline(
				zipStream,
				res,
				{ end: false },
			);
			res.end();
		} else if (format === "tar") {
			const [tarStream, tarLength] = await this.createTarStream(node);
			res.writeHead(200, {
				"Content-Type": "application/x-tar",
				"Content-Length": `${tarLength}`,
				"Content-Disposition": `attachment; filename=${quotedString(fileName + ".tar")}`
			});
			await stream.pipeline(
				tarStream,
				res,
				{ end: false },
			);
			res.end();
		} else {
			const content = Buffer.from(`Invalid format ${format}, valid values: zip, tar`, "utf8");
			res.writeHead(400, {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Length": `${content.length}`,
			});
			res.end(content);
		}
	}
}

// Resources not part of the public files tree
const resources = new Map();
resources.set("/style.css", new VirtualFile("style.css", await fs.readFile("style.css")));
resources.set("/files", new FileListing(tree));
resources.set("/meta", new Metadata(tree));
resources.set("/pack", new Packer(tree));

const server = http.createServer((req, res) => {
	const address = req.headers["x-forwarded-for"] ?? req.socket.remoteAddress;

	// Discard request body (if any) to avoid leaks.
	req.resume();

	if (req.method !== "GET") {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Bad Request");
		return;
	}

	handleGet(req, res).then(() => {
		console.log(`${res.statusCode} ${req.method} ${req.url} ${address}`);
	}).catch(err => {
		console.log(`ERR ${req.method} ${req.url} ${address} ${err.message}`);
		console.error(err);
		if (res.headersSent) {
			res.socket.resetAndDestroy();
		} else {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("Internal Server Error");
			return;
		}
	});
});

async function handleGet(req, res) {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const resource = resources.get(url.pathname);
	if (resource) {
		await resource.get(req, res);
		return;
	}

	const node = tree.get(url.pathname);
	if (!node) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not Found");
		return;
	}

	if (node instanceof Dir || node instanceof Root) {
		const content = Buffer.from(htmlDocument(prettify(node.toHTML())));
		res.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Length": `${content.length}`,
		});
		res.end(content);
		return;
	}

	if (node instanceof File) {
		const fh = await fs.open(node.realPath);
		node.stat = await fh.stat(); // Refresh in case file changed on disk.
		const fileStream = fh.createReadStream();
		res.writeHead(200, {
			"Content-Type": node.mime,
			"Content-Length": `${node.stat.size}`,
		});
		await stream.pipeline(
			fileStream,
			validateLength(node.stat.size, res),
			res,
			// Suppress automatically ending the request stream in case an
			// error is thrown as the request handler will handle it.
			{ end: false },
		);
		res.end();
	}
}

function validateLength(sourceLength, res) {
	return async function* (source, { signal }) {
		let read = 0;
		for await (const chunk of source) {
			read += chunk.length;
			if (read > sourceLength) {
				throw new Error(`Stream too long expected ${sourceLength} bytes got ${read}`);
			}
			yield chunk;
		}
		if (read < sourceLength) {
			throw new Error(`Stream too short expected ${sourceLength} bytes got ${read}`);
		}
	}
}

console.log(`Listening on ${PORT}`);
server.listen(PORT);
