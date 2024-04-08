import stream from "node:stream";
import fs from "node:fs/promises";

// Based on https://pubs.opengroup.org/onlinepubs/9699919799/utilities/pax.html#tag_20_92_13_06

// Characters in the ustar header is supposed to be represented in an encoding
// from the ISO/IEC 646:1991 standard, however this is archaic and instead this
// utility encodes characters using UTF-8.  This works because on Unix like
// systems file names are a series of bytes with no associated encoding, and
// most tools now treat them as either an opaque sequence of bytes or UTF-8.

class UstarHeader {
	name = "";
	mode = parseInt("0644", 8);
	uid = 1000;
	gid = 100;
	size = 0;
	mtime = 0;
	typeflag = "0"; // File
	linkname = "";
	uname = "user";
	gname = "users";
	devmajor = 0;
	devminor = 0;

	static splitName(name) {
		if (Buffer.byteLength(name, "utf8") <= 100) {
			return [Buffer.from(name), Buffer.alloc(0)];
		}
		const buf = Buffer.from(name, "utf8");
		const index = buf.indexOf("/", -100, "utf8");
		if (index === -1 || index > 155) {
			throw new Error("Encoded name is too long");
		}
		return [buf.slice(index + 1), buf.slice(0, index)]
	}

	static writeNumeric(buf, field, offset, length, value) {
		const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
		if (encoded.length !== length) {
			throw new Error(`Encoded value for ${field} exceeds the fields maximum length of ${length}`);
		}
		buf.write(encoded, offset);
	}

	static writeString(buf, field, offset, length, string, terminated = true) {
		const stringLength = Buffer.byteLength(string, "utf8");
		if (stringLength + Number(terminated) > length) {
			throw new Error(`Encoded value for ${field} exceeds the fields maximum length of ${length}`);
		}
		const encoded = Buffer.alloc(length);
		encoded.write(string, "utf8");
		encoded.copy(buf, offset);
	}

	toBuffer() {
		const buf = Buffer.alloc(512);
		const [name, prefix] = UstarHeader.splitName(this.name);
		name.copy(buf, 0);
		UstarHeader.writeNumeric(buf, "mode", 100, 8, this.mode);
		UstarHeader.writeNumeric(buf, "uid", 108, 8, this.uid);
		UstarHeader.writeNumeric(buf, "gid", 116, 8, this.gid);
		UstarHeader.writeNumeric(buf, "size", 124, 12, this.size);
		UstarHeader.writeNumeric(buf, "mtime", 136, 12, this.mtime);
		buf.write(" ".repeat(8), 148);
		buf.write(this.typeflag, 156);
		UstarHeader.writeString(buf, "linkname", 157, 100, this.linkname, false);
		buf.write("ustar\n", 257); // magic
		buf.write("00", 263); // version
		UstarHeader.writeString(buf, "uname", 265, 32, this.uname, true);
		UstarHeader.writeString(buf, "gname", 297, 32, this.gname, true);
		UstarHeader.writeNumeric(buf, "devmajor", 329, 8, this.devmajor);
		UstarHeader.writeNumeric(buf, "devminor", 337, 8, this.devminor);
		prefix.copy(buf, 345);

		let chksum = 0;
		for (const byte of buf) {
			chksum += byte;
		}
		UstarHeader.writeNumeric(buf, "chksum", 148, 8, chksum);
		return buf;
	}
}

export class TarFile {
	outputStream;
	_logicalRecords = 0;
	constructor() {
		this.filesRemaining
		this.outputStream = stream.Duplex.from(async function* (records) {
			for await (const record of records) {
				if (record.type === "file") {
					const header = new UstarHeader();
					header.name = record.metadataPath;
					header.size = record.stat.size;
					header.mtime = Math.floor(record.stat.mtimeMs / 1000);
					yield header.toBuffer();

					const fh = await fs.open(record.realPath);
					const fileStream = fh.createReadStream();
					yield* fileStream;

					// Pad last logical record of file with zeros
					const padding = ((-record.stat.size - 511) % 512) + 511;
					if (padding) {
						yield Buffer.alloc(padding);
					}
				} else if (record.type === "end") {
					// End file with to blank logical records
					yield Buffer.alloc(1024);
				}
			}
		});
	}
	addFile(realPath, metadataPath, stat) {
		this.outputStream.write({
			type: "file",
			realPath,
			metadataPath,
			stat,
		});
		this._logicalRecords += 1 + Math.floor((511 + stat.size) / 512);
	}
	end() {
		this.outputStream.end({ type: "end" });
		this._logicalRecords += 2;
		return this._logicalRecords * 512;
	}
}
