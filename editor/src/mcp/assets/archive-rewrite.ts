import { extname, normalize } from "path/posix";
import { deflateRawSync, gunzipSync, gzipSync } from "zlib";
import { readFile, stat } from "fs-extra";
import StreamZip from "node-stream-zip";

export type AssetArchiveFormat = "zip" | "tar" | "tarGzip" | "unityPackage";

export interface IRewritableArchiveMember {
	storagePath: string;
	semanticPath: string;
	data: Buffer;
	directory: boolean;
	mode: number;
	uid: number;
	gid: number;
	modifiedAtSeconds: number;
	dosTime: number;
	externalAttributes: number;
	comment: string;
}

export interface IRewritableArchive {
	format: AssetArchiveFormat;
	members: IRewritableArchiveMember[];
	comment: string;
}

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_COUNT = 4096;
const MAX_ARCHIVE_DECLARED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 1024;

function archiveFormat(path: string): AssetArchiveFormat {
	const lower = path.toLowerCase();
	if (lower.endsWith(".zip")) {
		return "zip";
	}
	if (lower.endsWith(".unitypackage")) {
		return "unityPackage";
	}
	if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
		return "tarGzip";
	}
	if (lower.endsWith(".tar")) {
		return "tar";
	}
	throw new Error(`Unsupported archive format: ${extname(path) || path}.`);
}

function normalizedMemberPath(path: string): string | null {
	const cleaned = path.replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (!cleaned || Buffer.byteLength(cleaned) > MAX_ARCHIVE_PATH_BYTES || cleaned.startsWith("/") || /^[a-z]:\//i.test(cleaned)) {
		return null;
	}
	const result = normalize(cleaned).replace(/^\.\/+/, "");
	return !result || result === "." || result === ".." || result.startsWith("../") ? null : result;
}

function assertArchiveBounds(members: IRewritableArchiveMember[]): void {
	if (members.length > MAX_ARCHIVE_ENTRY_COUNT) {
		throw new Error(`Archive contains more than ${MAX_ARCHIVE_ENTRY_COUNT.toLocaleString()} file entries.`);
	}
	const total = members.reduce((sum, member) => sum + member.data.length, 0);
	if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_DECLARED_BYTES) {
		throw new Error("Archive declares more than 1 GiB of expanded file data.");
	}
	const paths = new Set<string>();
	for (const member of members) {
		if (!normalizedMemberPath(member.storagePath) || paths.has(member.storagePath)) {
			throw new Error("Archive contains an unsafe or duplicate normalized member path.");
		}
		paths.add(member.storagePath);
	}
}

function readTarString(header: Buffer, start: number, length: number): string {
	return header
		.subarray(start, start + length)
		.toString("utf-8")
		.replace(/\0.*$/, "")
		.trim();
}

function readTarOctal(header: Buffer, start: number, length: number, fallback = 0): number {
	const value = readTarString(header, start, length).replace(/\0/g, "").trim();
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error("TAR contains an invalid numeric header field.");
	}
	return parsed;
}

function readTarMembers(buffer: Buffer): IRewritableArchiveMember[] {
	const members: IRewritableArchiveMember[] = [];
	let offset = 0;
	while (offset + 512 <= buffer.length) {
		const header = buffer.subarray(offset, offset + 512);
		if (header.every((value) => value === 0)) {
			break;
		}
		const recordedChecksum = readTarOctal(header, 148, 8);
		const checksumHeader = Buffer.from(header);
		checksumHeader.fill(0x20, 148, 156);
		const calculatedChecksum = [...checksumHeader].reduce((sum, byte) => sum + byte, 0);
		if (recordedChecksum !== calculatedChecksum) {
			throw new Error("TAR contains a header with an invalid checksum.");
		}
		const name = readTarString(header, 0, 100);
		const prefix = readTarString(header, 345, 155);
		const storagePath = normalizedMemberPath(prefix ? `${prefix}/${name}` : name);
		const size = readTarOctal(header, 124, 12);
		const type = header[156];
		const dataStart = offset + 512;
		const dataEnd = dataStart + size;
		if (!storagePath || dataEnd > buffer.length) {
			throw new Error("TAR header table is malformed or contains an unsafe member path.");
		}
		if (type === 0 || type === 48 || type === 53) {
			if (type === 53 && size !== 0) {
				throw new Error(`TAR directory member ${storagePath} unexpectedly contains file data.`);
			}
			members.push({
				storagePath,
				semanticPath: storagePath,
				data: Buffer.from(buffer.subarray(dataStart, dataEnd)),
				directory: type === 53,
				mode: readTarOctal(header, 100, 8, 0o644),
				uid: readTarOctal(header, 108, 8),
				gid: readTarOctal(header, 116, 8),
				modifiedAtSeconds: readTarOctal(header, 136, 12),
				dosTime: 0,
				externalAttributes: 0,
				comment: "",
			});
		} else {
			throw new Error(`TAR member ${storagePath} uses unsupported type ${String.fromCharCode(type || 48)}; repackage it with regular files before moving assets.`);
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	return members;
}

function applyUnityPackageSemanticPaths(members: IRewritableArchiveMember[]): void {
	const targets = new Map<string, string>();
	for (const member of members) {
		const match = member.storagePath.match(/^([0-9a-f]{32})\/pathname$/i);
		if (!match || member.data.length > MAX_ARCHIVE_PATH_BYTES) {
			continue;
		}
		const path = normalizedMemberPath(
			member.data
				.toString("utf-8")
				.trim()
				.replace(/^Assets\//, "assets/")
		);
		if (path) {
			targets.set(match[1].toLowerCase(), path);
		}
	}
	for (const member of members) {
		const match = member.storagePath.match(/^([0-9a-f]{32})\/(asset|asset\.meta|preview\.png)$/i);
		if (!match) {
			continue;
		}
		const target = targets.get(match[1].toLowerCase());
		if (!target) {
			continue;
		}
		const kind = match[2].toLowerCase();
		member.semanticPath = kind === "asset" ? target : kind === "asset.meta" ? `${target}.meta` : `${target}.preview.png`;
	}
}

async function readZip(path: string): Promise<IRewritableArchive> {
	const zip = new StreamZip.async({ file: path, storeEntries: true });
	try {
		const entries = Object.values(await zip.entries());
		if (entries.some((entry) => entry.encrypted)) {
			throw new Error("Encrypted ZIP members cannot be rewritten safely.");
		}
		if (entries.length > MAX_ARCHIVE_ENTRY_COUNT) {
			throw new Error(`Archive contains more than ${MAX_ARCHIVE_ENTRY_COUNT.toLocaleString()} file entries.`);
		}
		const declared = entries.reduce((sum, entry) => sum + entry.size, 0);
		if (!Number.isSafeInteger(declared) || declared > MAX_ARCHIVE_DECLARED_BYTES) {
			throw new Error("Archive declares more than 1 GiB of expanded file data.");
		}
		if (declared > MAX_ARCHIVE_EXPANDED_BYTES) {
			throw new Error("Archive expands beyond the 128 MiB rewrite limit.");
		}
		const members: IRewritableArchiveMember[] = [];
		for (const entry of entries) {
			const storagePath = normalizedMemberPath(entry.name);
			if (!storagePath) {
				throw new Error("ZIP contains an unsafe member path.");
			}
			members.push({
				storagePath,
				semanticPath: storagePath,
				data: entry.isDirectory ? Buffer.alloc(0) : await zip.entryData(entry),
				directory: entry.isDirectory,
				mode: 0o644,
				uid: 0,
				gid: 0,
				modifiedAtSeconds: 0,
				dosTime: entry.time >>> 0,
				externalAttributes: entry.attr >>> 0,
				comment: entry.comment ?? "",
			});
		}
		const archive = { format: "zip" as const, members, comment: (await zip.comment) ?? "" };
		assertArchiveBounds(members);
		return archive;
	} finally {
		await zip.close().catch(() => undefined);
	}
}

export async function readRewritableArchive(path: string): Promise<IRewritableArchive> {
	const details = await stat(path);
	if (details.size > MAX_ARCHIVE_BYTES) {
		throw new Error("Archive exceeds the 64 MiB compressed rewrite limit.");
	}
	const format = archiveFormat(path);
	if (format === "zip") {
		return readZip(path);
	}
	const source = await readFile(path);
	const tar = format === "tar" ? source : gunzipSync(source, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
	if (tar.length > MAX_ARCHIVE_EXPANDED_BYTES) {
		throw new Error("Archive expands beyond the 128 MiB rewrite limit.");
	}
	const members = readTarMembers(tar);
	assertArchiveBounds(members);
	if (format === "unityPackage") {
		applyUnityPackageSemanticPaths(members);
	}
	return { format, members, comment: "" };
}

function crc32(buffer: Buffer): number {
	let value = 0xffffffff;
	for (const byte of buffer) {
		value ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
		}
	}
	return (value ^ 0xffffffff) >>> 0;
}

function writeZip(archive: IRewritableArchive): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let localOffset = 0;
	for (const member of archive.members) {
		const name = Buffer.from(member.directory ? `${member.storagePath}/` : member.storagePath, "utf-8");
		const comment = Buffer.from(member.comment, "utf-8");
		if (name.length > 0xffff || comment.length > 0xffff || member.data.length > 0xffffffff || localOffset > 0xffffffff) {
			throw new Error("ZIP32 rewrite bounds were exceeded.");
		}
		const checksum = crc32(member.data);
		const deflated = deflateRawSync(member.data, { level: 9 });
		const compressed = deflated.length < member.data.length ? deflated : member.data;
		const method = compressed === deflated ? 8 : 0;
		const time = member.dosTime & 0xffff;
		const date = (member.dosTime >>> 16) & 0xffff;
		const localHeader = Buffer.alloc(30);
		localHeader.writeUInt32LE(0x04034b50, 0);
		localHeader.writeUInt16LE(20, 4);
		localHeader.writeUInt16LE(0x0800, 6);
		localHeader.writeUInt16LE(method, 8);
		localHeader.writeUInt16LE(time, 10);
		localHeader.writeUInt16LE(date, 12);
		localHeader.writeUInt32LE(checksum, 14);
		localHeader.writeUInt32LE(compressed.length, 18);
		localHeader.writeUInt32LE(member.data.length, 22);
		localHeader.writeUInt16LE(name.length, 26);
		localHeader.writeUInt16LE(0, 28);
		localParts.push(localHeader, name, compressed);

		const centralHeader = Buffer.alloc(46);
		centralHeader.writeUInt32LE(0x02014b50, 0);
		centralHeader.writeUInt16LE(0x0314, 4);
		centralHeader.writeUInt16LE(20, 6);
		centralHeader.writeUInt16LE(0x0800, 8);
		centralHeader.writeUInt16LE(method, 10);
		centralHeader.writeUInt16LE(time, 12);
		centralHeader.writeUInt16LE(date, 14);
		centralHeader.writeUInt32LE(checksum, 16);
		centralHeader.writeUInt32LE(compressed.length, 20);
		centralHeader.writeUInt32LE(member.data.length, 24);
		centralHeader.writeUInt16LE(name.length, 28);
		centralHeader.writeUInt16LE(0, 30);
		centralHeader.writeUInt16LE(comment.length, 32);
		centralHeader.writeUInt16LE(0, 34);
		centralHeader.writeUInt16LE(0, 36);
		centralHeader.writeUInt32LE(member.externalAttributes, 38);
		if (member.directory && !member.externalAttributes) {
			centralHeader.writeUInt32LE(0x10, 38);
		}
		centralHeader.writeUInt32LE(localOffset, 42);
		centralParts.push(centralHeader, name, comment);
		localOffset += localHeader.length + name.length + compressed.length;
	}
	const local = Buffer.concat(localParts);
	const central = Buffer.concat(centralParts);
	const archiveComment = Buffer.from(archive.comment, "utf-8");
	if (archive.members.length > 0xffff || central.length > 0xffffffff || local.length > 0xffffffff || archiveComment.length > 0xffff) {
		throw new Error("ZIP32 rewrite bounds were exceeded.");
	}
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(archive.members.length, 8);
	end.writeUInt16LE(archive.members.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(local.length, 16);
	end.writeUInt16LE(archiveComment.length, 20);
	return Buffer.concat([local, central, end, archiveComment]);
}

function writeTarOctal(header: Buffer, value: number, start: number, length: number): void {
	const text = Math.max(0, Math.floor(value)).toString(8);
	if (text.length > length - 1) {
		throw new Error("TAR numeric metadata exceeds the portable header limit.");
	}
	header.write(`${text.padStart(length - 1, "0")}\0`, start, length, "ascii");
}

function splitTarPath(path: string): { name: string; prefix: string } {
	if (Buffer.byteLength(path) <= 100) {
		return { name: path, prefix: "" };
	}
	for (let separator = path.lastIndexOf("/"); separator > 0; separator = path.lastIndexOf("/", separator - 1)) {
		const prefix = path.slice(0, separator);
		const name = path.slice(separator + 1);
		if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
			return { name, prefix };
		}
	}
	throw new Error(`TAR member path exceeds portable USTAR limits: ${path}.`);
}

function writeTar(archive: IRewritableArchive): Buffer {
	const parts: Buffer[] = [];
	for (const member of archive.members) {
		const { name, prefix } = splitTarPath(member.storagePath);
		const header = Buffer.alloc(512);
		header.write(name, 0, 100, "utf-8");
		writeTarOctal(header, member.mode || 0o644, 100, 8);
		writeTarOctal(header, member.uid, 108, 8);
		writeTarOctal(header, member.gid, 116, 8);
		writeTarOctal(header, member.directory ? 0 : member.data.length, 124, 12);
		writeTarOctal(header, member.modifiedAtSeconds, 136, 12);
		header.fill(0x20, 148, 156);
		header[156] = member.directory ? 53 : 48;
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		if (prefix) {
			header.write(prefix, 345, 155, "utf-8");
		}
		const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		parts.push(header);
		if (!member.directory) {
			parts.push(member.data, Buffer.alloc((512 - (member.data.length % 512)) % 512));
		}
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

export function writeRewritableArchive(archive: IRewritableArchive): Buffer {
	assertArchiveBounds(archive.members);
	if (archive.format === "zip") {
		const zip = writeZip(archive);
		if (zip.length > MAX_ARCHIVE_BYTES) {
			throw new Error("Rewritten ZIP exceeds the 64 MiB compressed rewrite limit.");
		}
		return zip;
	}
	const tar = writeTar(archive);
	if (tar.length > MAX_ARCHIVE_EXPANDED_BYTES) {
		throw new Error("Rewritten archive expands beyond the 128 MiB limit.");
	}
	const output = archive.format === "tar" ? tar : gzipSync(tar, { level: 9 });
	if (output.length > MAX_ARCHIVE_BYTES) {
		throw new Error("Rewritten archive exceeds the 64 MiB compressed rewrite limit.");
	}
	return output;
}
