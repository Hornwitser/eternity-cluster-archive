import fs from "node:fs/promises";
import http from "node:http";
import stream from "node:stream/promises";
import { el, htmlDocument, prettify } from "antihtml";

const PORT = process.env.PORT ? Number.parse(process.env.PORT, 10) : 8000;
const PUBLIC_URL = envPublicUrl(process.env.PUBLIC_URL ?? "");
const ROOT_DIR = process.env.ROOT_DIR ?? "public";

function envPublicUrl(url) {
	if (url.endsWith("/")) {
		return url.slice(0, -1);
	}
	return url;
}

const strcmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;


class Root {
	entries = new Map();
	get path() {
		return "/";
	}
	toJSON() {
		return { type: "root", entries: [...this.entries.values()] };
	}
}

class Node {
	parent;
	name;
	constructor(parent, name) {
		this.name = name;
		this.parent = parent;
		parent.entries.set(name, this);
	}
}

class File extends Node {
	stat;
	constructor(parent, name, stat) {
		super(parent, name)
		this.stat = stat;
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
		if (entry.isDirectory()) {
			const dir = new Dir(parent, entry.name);
			tree.set(dir.path, dir);
		}
		if (entry.isFile()) {
			const stat = await fs.stat(entry.path + "/" + entry.name);
			const file = new File(parent, entry.name, stat);
			tree.set(file.path, file);
		}
	}
	return tree;
}

console.log("Scanning files");
const tree = await buildTree();
const stylesheet = `
@media (prefers-color-scheme: dark) {
	html {
		background: #222227;
		color: #ddd;
		max-width: 50rem;
		margin-inline: auto;
	}
}
pre {
	margin-inline: 4rem 0;
}
* {
	color-scheme: light dark;
}
`.replace(/\t|\n/g, "");

function directoryPage(node) {
	return el("html", { "lang": "en" },
		el("title", `Directory listing for ${node.path}`),
		el("style", stylesheet),
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
	console.log(`${req.method} ${req.url} ${address}`);

	// Discard request body (if any) to avoid leaks.
	req.resume();

	if (req.method !== "GET") {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("Bad Request");
		return;
	}

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
			res.end(htmlDocument(prettify(directoryPage(node))));
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
		fs.open(ROOT_DIR + node.path).then((fh) => {
			const fileStream = fh.createReadStream();
			res.writeHead(200, {
				// TODO Add content type of file served.
				"Content-Length": `${node.stat.size}`,
			});
			return stream.pipeline(fileStream, res);
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
		return;
	}
});

console.log(`Listening on ${PORT}`);
server.listen(PORT);
