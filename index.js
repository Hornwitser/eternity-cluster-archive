import fs from "node:fs/promises";
import http from "node:http";
import stream from "node:stream/promises";
import { el, htmlDocument, prettify } from "antihtml";

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
		el("p", "Supports scripted access, for example to get a plain text list of downloadable resources in this directory:"),
		el("pre", `curl ${PUBLIC_URL}${node.path}`),
		el("p",
			"Setting the Accept header to ",
			el("code", "application/json"),
			" is also suppoorted and gives structured data",
		),
	];
}

function parentEntry(entry) {
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
			map(directoryEntry, this.entries.values()),
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

class File extends Node {
	stat;
	constructor(parent, name, realPath, stat) {
		super(parent, name, realPath)
		this.stat = stat;
		const ext = name.slice(name.lastIndexOf("."));
		this.mime = mimeTypes.get(ext);
		if (!this.mime) {
			throw new Error(`Missing MIME type for ${name}`);
		}
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
			parentEntry(this.parent),
			map(directoryEntry, this.entries.values()),
		);
	}
}

class InstancesDir extends Dir {
	toHTML() {
		return basePage(
			"Eternity Cluster Instances",
			parentEntry(this.parent),
			map(directoryEntry, this.entries.values()),
			aboutSection(this),
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
			parentEntry(this.parent),
			map(directoryEntry, this.entries.values()),
			aboutSection(this),
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

// additional resources
tree.set("/style.css", new File(tree.get("/"), "style.css", "style.css", await fs.stat("style.css")));
tree.get("/").entries.delete("style.css"); // Hide from directory listing

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
		console.log(`ERR: ${req.method} ${req.url} ${address} ${err.message}`);
		if (res.headersSent) {
			res.socket.resetAndDestroy();
		} else {
			res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
			res.end(err.stack);
			return;
		}
	});
});

async function handleGet(req, res) {
	const url = new URL(req.url, `http://${req.headers.host}`);
	const node = tree.get(url.pathname);
	if (!node) {
		res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Not Found");
		return;
	}

	if (node instanceof Dir || node instanceof Root) {
		// FIXME Hacky content negotation
		if (req.headers.accept && /text\/html/.test(req.headers.accept)) {
			const document = htmlDocument(prettify(node.toHTML()))
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Vary": "Accept",
			});
			res.end(document);
		} else if (req.headers.accept && /application\/json/.test(req.headers.accept)) {
			const data = JSON.stringify(node, undefined, "\t")
			res.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
				"Vary": "Accept",
			});
			res.end(data);
		} else {
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
			res.writeHead(200, {
				"Content-Type": "text/plain; charset=utf-8",
				"Vary": "Accept",
			});
			res.end(lines.join(""));
		}
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
