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
	".zip": "application/zip",
}));

function envPublicUrl(url) {
	if (url.endsWith("/")) {
		return url.slice(0, -1);
	}
	return url;
}

const strcmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;


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
		return directoryPage(this);
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
		return directoryPage(this);
	}
}

function entryPath(entry) {
	return "/" + entry.path.replace(/\\/g, "/") + "/" + entry.name;
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
		if (entry.isDirectory()) {
			const dir = new Dir(parent, entry.name, realPath);
			tree.set(dir.path, dir);
		}
		if (entry.isFile()) {
			const stat = await fs.stat(realPath);
			const file = new File(parent, entry.name, realPath, stat);
			tree.set(file.path, file);
		}
	}
	return tree;
}

console.log("Scanning files");
const tree = await buildTree();

// additional resources
tree.set("/style.css", new File(tree.get("/"), "style.css", "style.css", await fs.stat("style.css")));

function directoryPage(node) {
	return el("html", { "lang": "en" },
		el("link", { rel: "stylesheet", href: PUBLIC_URL + "/style.css" }),
		el("title", `Directory listing for ${node.path}`),
		el("h1", `Directory listing for ${node.path}`),
		[...node.entries.values()].map(directoryEntry),
		el("h2", "About"),
		el("p", "A minimal viable hosting of the saves from the Eternity Cluster."),
		el("p", "Supports scripted access, for example to get a plain text list of downloadable resources in this directory:"),
		el("pre", `curl ${PUBLIC_URL}${node.path}`),
		el("p",
			"Setting the Accept header to ",
			el("code", "application/json"),
			" is also suppoorted and gives structured data",
		),
	);
}

function directoryEntry(entry) {
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
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Vary": "Accept",
			});
			res.end(htmlDocument(prettify(node.toHTML())));
		} else if (req.headers.accept && /application\/json/.test(req.headers.accept)) {
			res.writeHead(200, {
				"Content-Type": "application/json; charset=utf-8",
				"Vary": "Accept",
			});
			res.end(JSON.stringify(node, undefined, "\t"));
		} else {
			res.writeHead(200, {
				"Content-Type": "text/plain; charset=utf-8",
				"Vary": "Accept",
			});
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
			res.end(lines.join(""));
		}
		return;
	}

	if (node instanceof File) {
		const fh = await fs.open(node.realPath);
		const fileStream = fh.createReadStream();
		res.writeHead(200, {
			"Content-Type": node.mime,
			"Content-Length": `${node.stat.size}`,
		});
		await stream.pipeline(fileStream, res);
	}
}

console.log(`Listening on ${PORT}`);
server.listen(PORT);
