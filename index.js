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

function formatBytes(bytes) {
	if (bytes === 0) {
		return "0\u{A0}Bytes"; // No-break space
	}
	const base = 1000;
	const units = ["\u{A0}Bytes", "\u{A0}kB", "\u{A0}MB", "\u{A0}GB", "\u{A0}TB"];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(base)), units.length);
	const significant = bytes / base ** exponent;
	const fractionDigits = Number(significant < 99.95) + Number(significant < 9.995);
	return significant.toFixed(fractionDigits) + units[exponent];
}

// Encode header token as quoted string
function quotedString(str) {
	str = str.replace(/"/, '\"');
	// Remove non iso-8859-1 characters
	str = str.replace(/[^\t\x20-\x7e\x80-\xff]/g, "?");
	return `"${str}"`;
}

const strcmp = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

// Functional programming utilities
function* map(fn, iter) {
	for (const item of iter) {
		yield fn(item);
	}
}

function id(value) {
	return value;
}

function* filter(fn, iter) {
	for (const item of iter) {
		if (fn(item)) {
			yield item;
		}
	}
}

function last(iter) {
	let lastItem = undefined;
	for (const item of iter) {
		lastItem = item;
	}
	return lastItem;
}

function* walkFiles(node, transform = id) {
	const stack = [node];
	while (stack.length) {
		const current = transform(stack.pop());
		if (current instanceof Dir || current instanceof Root) {
			stack.push(...[...current.entries.values()].toReversed());
		} else if (current instanceof File) {
			yield current;
		}
	}
}

function fileFilterFromUrl(url) {
	const createdBeforeValue = url.searchParams.get("created-before");
	if (createdBeforeValue !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(createdBeforeValue)) {
		throw new Error(
			`Invalid created-before ${createdBeforeValue}, valid format 'YYYY-MM-DDTHH:MM'`,
		);
	}
	const createdBeforeMs = createdBeforeValue ? new Date(createdBeforeValue+"Z").getTime() : undefined;
	if (createdBeforeMs === undefined) {
		return id;
	}
	return node => node.createdAtMs === undefined || node.createdAtMs < createdBeforeMs;
}

function nodeTransformFromUrl(url, fileFilter) {
	const instancesAs = url.searchParams.get("instances-as") ?? "folder";
	if (!["folder", "last-save", "clusterio-last-save"].includes(instancesAs)) {
		throw new Error(
			`Invalid instances-as ${instancesAs}, valid values: folder, last-save, clusterio-last-save`,
		);
	}
	if (instancesAs === "folder") {
		return node => {
			return fileFilter(node) ? node : undefined;
		};
	}
	if (instancesAs === "last-save") {
		return node => {
			if (!(node instanceof Instance)) {
				return fileFilter(node) ? node : undefined;
			}
			const saves = [...node.entries.get("saves").entries.values()];
			const file = last(filter(fileFilter, saves));
			if (!file) {
				return undefined;
			}
			return new Save(node.parent, node.title.replace(" / ") + ".zip", file.realPath, file.stat);
		};
	}
	if (instancesAs === "clusterio-last-save") {
		return node => {
			if (!(node instanceof Instance)) {
				return fileFilter(node) ? node : undefined;
			}
			const savesDir = node.entries.get("saves");
			const saves = savesDir.entries.values();
			const file = last(filter(fileFilter, saves));
			if (!file) {
				return undefined;
			}
			const instance = new Instance(node.parent, node.name, node.realPath, node.config);
			instance.entries = new Map(node.entries);
			const newSavesDir = new SavesDir(instance, "saves", savesDir.realPath);
			newSavesDir.entries.set(file.name, file);
			instance.entries.set("saves", newSavesDir);
			return instance;
		};
	}
	throw new Error("Impossible branch");
}

function textResponse(res, code, text, mime = "text/plain") {
	const content = Buffer.from(text, "utf8");
	res.writeHead(code, {
		"Content-Type": `${mime}; charset=utf-8`,
		"Content-Length": `${content.length}`,
	});
	res.end(content);
}

function jsonResponse(res, code, json) {
	textResponse(res, code, JSON.stringify(json, undefined, "\t"), "application/json");
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

function downloadSection(node) {
	const fullName = node instanceof Root ? "Whole Archive" : "Whole Directory";
	let instances = null;
	if (node instanceof InstancesDir || node instanceof Instance || node instanceof Root) {
		instances = el("form", { action: `${PUBLIC_URL}/pack`, method: "GET" },
			el("input", { type: "hidden", name: "path", value: node.path }),
			el("h3", `Snapshot`),
			el("label",
				"Format ",
				el("select", { name: "format" },
					el("option", { value: "zip", selected: "" }, "Zip"),
					el("option", { value: "tar" }, "Tar"),
				),
			),
			el("label",
				"Instances as ",
				el("select", { name: "instances-as" },
					el("option", { value: "last-save", selected: "" }, "Single save"),
					el("option", { value: "clusterio-last-save" }, "Clusterio Compatible Folder"),
				),
			),
			el("label",
				"Time point ",
				el("select", { name: "created-before" },
					el("option", { value: "2024-01-29T03:00" }, "1 kSPM"),
					el("option", { value: "2024-01-29T17:00" }, "10 kSPM"),
					el("option", { value: "2024-02-01T03:00" }, "100 kSPM"),
					el("option", { value: "2024-03-10T12:00", selected: "" }, "1000 kSPM"),
					el("option", { value: "2024-03-31T23:59" }, "Last saves"),
				),
			),
			el("button", { type: "submit" }, "Download"),
		);
	}
	return [
		el("h2", "Download"),
		el("form", { action: `${PUBLIC_URL}/pack?path=${node.path}`, method: "GET" },
			el("input", { type: "hidden", name: "path", value: node.path }),
			el("h3", `${fullName} (${formatBytes(node.totalSize)})`),
			el("label",
				"Format ",
				el("select", { name: "format" },
					el("option", { value: "zip", selected: "" }, "Zip"),
					el("option", { value: "tar" }, "Tar"),
				),
			),
			el("button", { type: "submit" }, "Download"),
		),
		instances,
	];
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
	const size = formatBytes(entry.totalSize);
	if (entry instanceof Instance) {
		return el("div",
			el("a", { href: entry.name + "/" }, entry.title),
			` ${entry.entries.get("saves")?.filesCount} Saves ${entry.filesCount} Files ${size}`
		);
	}
	if (entry instanceof File) {
		return el("div",
			el("a", { href: entry.name }, entry.name),
			` ${size}`,
		);
	}
	if (entry instanceof Dir) {
		return el("div",
			el("a", { href: entry.name + "/" }, `${entry.name}/`),
			` ${entry.foldersCount} Folders ${entry.filesCount} Files ${size}`
		);
	}
	throw new Error("Unexpected entry");
}


class Root {
	entries = new Map();
	realPath = ROOT_DIR;
	foldersCount = 0;
	filesCount = 0;
	totalSize = 0;
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
			downloadSection(this),
		);
	}
}

class Node {
	parent;
	name;
	realPath
	foldersCount = 0;
	filesCount = 0;
	totalSize = 0;
	createdAtMs;
	constructor(parent, name, realPath) {
		this.name = name;
		this.parent = parent;
		this.realPath = realPath;
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

class Save extends File {
	constructor(parent, name, realPath, stat) {
		super(parent, name, realPath, stat)
		this.createdAtMs = new Date(name.replace(/_/g, ":").slice(0, -4)).getTime();
	}
	get path() {
		return this.parent.path + this.name;
	}
	toJSON() {
		return { type: "save", name: this.name, size: this.stat.size, created: this.createdAtMs / 1000 };
	}
}

class Dir extends Node {
	entries = new Map();
	get path() {
		return this.parent.path + this.name + "/";
	}
	toJSON() {
		const created = this.createdAtMs !== undefined ? this.createdAtMs / 1000 : undefined;
		return { type: "dir", name: this.name, created, entries: [...this.entries.values()] };
	}
	toHTML() {
		return basePage(
			`${this.path} - Eternity Cluster`,
			directoryListing(this),
			downloadSection(this),
		);
	}
}

class InstancesDir extends Dir {
	toHTML() {
		return basePage(
			"Eternity Cluster Instances",
			directoryListing(this),
			downloadSection(this),
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
		const created = this.createdAtMs !== undefined ? this.createdAtMs / 1000 : undefined;
		return {
			type: "instance",
			name: this.name,
			title: this.title,
			id: this.id,
			created,
			entries: [...this.entries.values()]
		};
	}
	toHTML() {
		return basePage(
			`${this.title} - Eternity Cluster`,
			directoryListing(this),
			downloadSection(this),
		);
	}
}

class SavesDir extends Dir {
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
		} else if (parent instanceof Instance && entry.name === "saves") {
			dir = new SavesDir(parent, entry.name, realPath);
		} else {
			dir = new Dir(parent, entry.name, realPath);
		}
		parent.entries.set(entry.name, dir);
		tree.set(dir.path, dir);
	}
	if (entry.isFile()) {
		const stat = await fs.stat(realPath);
		let file;
		if (parent instanceof SavesDir) {
			file = new Save(parent, entry.name, realPath, stat);
		} else {
			file = new File(parent, entry.name, realPath, stat);
		}
		parent.entries.set(entry.name, file);
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
	calculateMeta(root);
	return tree;
}

// Calculates total sizes and item counts down the tree
function calculateMeta(node) {
	if (node instanceof Dir || node instanceof Root) {
		for (const child of node.entries.values()) {
			calculateMeta(child);
			node.foldersCount += child.foldersCount + (child instanceof Dir);
			node.filesCount += child.filesCount + (child instanceof File);
			node.totalSize += child.totalSize;
			if (child.createdAtMs !== undefined) {
				node.createdAtMs = Math.min(node.createdAtMs ?? +Infinity, child.createdAtMs);
			}
		}
	} else if (node instanceof File) {
		node.totalSize = node.stat.size;
	}
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
		let fileFilter;
		try {
			fileFilter = fileFilterFromUrl(url);
		} catch (err) {
			textResponse(res, 400, err.message);
		}
		const format = url.searchParams.get("format") ?? "plain";
		const node = this.tree.get(url.searchParams.get("path") ?? "/");
		if (!node) {
			textResponse(res, 404, "Not Found");
			return;
		}

		const files = walkFiles(node, n => fileFilter(n) ? n : undefined);
		if (format === "plain") {
			const lines = map(file => PUBLIC_URL + file.path + "\n", files);
			textResponse(res, 200, [...lines].join(""));
		} else if (format === "json") {
			const lines = map(file => ({ type: "file", path: file.path, size: file.stat.size }), files);
			jsonResponse(res, 200, [...lines]);
		} else {
			textResponse(res, 400, `Invalid format ${format}, valid values: plain, json`);
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
			textResponse(res, 404, "Not Found");
			return;
		}
		jsonResponse(res, 200, node);
	}
}

async function createZipStream(files, nameFn) {
	const zipFile = new yazl.ZipFile();
	for (const file of files) {
		zipFile.addFile(
			file.realPath,
			nameFn(file),
			{ compress: false },
		);
	}
	const zipLength = await new Promise(resolve => {
		zipFile.end(undefined, resolve);
	});
	return [zipFile.outputStream, zipLength];
}

async function createTarStream(files, nameFn) {
	const tarFile = new TarFile();
	for (const file of files) {
		tarFile.addFile(
			file.realPath,
			nameFn(file),
			file.stat,
		);
	}
	const tarLength = tarFile.end();
	return [tarFile.outputStream, tarLength];
}

class Packer {
	tree;
	constructor(tree) {
		this.tree = tree;
	}
	async get(req, res) {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const format = url.searchParams.get("format");
		let fileFilter;
		try {
			fileFilter = fileFilterFromUrl(url);
		} catch (err) {
			textResponse(res, 400, err.message);
		}
		let nodeTransform;
		try {
			nodeTransform = nodeTransformFromUrl(url, fileFilter);
		} catch (err) {
			textResponse(res, 400, err.message);
		}
		const node = this.tree.get(url.searchParams.get("path") ?? "/");
		if (!node) {
			textResponse(res, 404, "Not Found");
			return;
		}
		const files = walkFiles(node, nodeTransform);
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
		const lastSlashIndex = node.path.lastIndexOf("/") + 1;
		const nameFn = file => file.path.slice(Math.min(lastSlashIndex, file.path.lastIndexOf("/") + 1));

		if (format === "zip") {
			const [zipStream, zipLength] = await createZipStream(files, nameFn);
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
			const [tarStream, tarLength] = await createTarStream(files, nameFn);
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
			textResponse(res, 400, `Invalid format ${format}, valid values: zip, tar`);
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
		textResponse(res, 400, "Bad Request");
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
			textResponse(res, 500, "Internal Server Error");
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
		textResponse(res, 404, "Not Found");
		return;
	}

	if (node instanceof Dir || node instanceof Root) {
		textResponse(res, 200, htmlDocument(prettify(node.toHTML())), "text/html");
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
