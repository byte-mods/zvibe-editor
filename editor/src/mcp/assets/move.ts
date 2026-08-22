import { createHash, randomUUID } from "crypto";
import { dirname, extname, join, normalize, relative, resolve } from "path/posix";
import { mkdir, move, pathExists, readFile, remove, rename, stat, writeFile } from "fs-extra";

import { projectConfiguration } from "../../project/configuration";
import { AssetArchiveFormat, readRewritableArchive, writeRewritableArchive } from "./archive-rewrite";
import {
	IBinaryModelReferenceRewriteResult,
	isBinaryFbx,
	rewrite3dsReferences,
	rewriteB3dReferences,
	rewriteBinaryFbxReferences,
	rewriteBlendReferences,
	rewriteDxfReferences,
	rewriteLwoReferences,
	rewriteMs3dReferences,
	rewriteXReferences,
} from "./binary-model-rewrite";
import { getIndexedAssetMoveReferencers, readAssetMetadata, resolveAssetDependencyCandidate, resolveBlendDependencyCandidate } from "./registry";

const MAX_MOVE_REFERENCE_FILES = 1000;
const MAX_MOVE_REFERENCE_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_MOVE_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_MEMBER_REWRITE_BYTES = 32 * 1024 * 1024;
const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK = 0x4e4f534a;

export interface IAssetMoveRewrite {
	path: string;
	outputPath: string;
	kind: "text" | "glb" | "fbx" | "3ds" | "ms3d" | "b3d" | "x" | "lwo" | "dxf" | "blend" | "archive";
	replacementCount: number;
	beforeHash: string;
	afterHash: string;
	byteLength: number;
	archiveFormat?: AssetArchiveFormat;
	archiveMemberCount?: number;
}

export interface IAssetMoveBlocker {
	path: string;
	kind: string;
	reason: "unsupportedBinaryFormat" | "oversized" | "malformed" | "semanticMismatch";
	message: string;
}

export interface IAssetMovePlan {
	sourcePath: string;
	destinationPath: string;
	sourceGuid: string | null;
	sourceIsDirectory: boolean;
	sourceSizeBytes: number;
	sourceModifiedAt: string;
	rewrites: IAssetMoveRewrite[];
	blockers: IAssetMoveBlocker[];
	totalReplacementCount: number;
	unchangedReferenceCount: number;
	planFingerprint: string;
}

interface IPreparedAssetMoveRewrite extends IAssetMoveRewrite {
	before: Buffer;
	after: Buffer;
}

interface IPreparedAssetMovePlan extends IAssetMovePlan {
	preparedRewrites: IPreparedAssetMoveRewrite[];
}

interface ITextReferenceRewriteContext {
	extension: string;
	inputReferencerPath: string;
	outputReferencerPath: string;
	sourcePath: string;
	destinationPath: string;
	sourceIsDirectory: boolean;
	rewriteValue?: (value: string) => string | null;
}

interface IArchiveReferenceRewriteResult {
	buffer: Buffer;
	replacementCount: number;
	semanticMatchCount: number;
	archiveFormat?: AssetArchiveFormat;
	archiveMemberCount: number;
	blockers: IAssetMoveBlocker[];
}

interface IArchiveReferenceRewriteContext {
	absolutePath: string;
	before: Buffer;
	referencerPath: string;
	externalMemberPaths: Set<string>;
	sourcePath: string;
	destinationPath: string;
	sourceIsDirectory: boolean;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function resolveProjectPath(path: string): string {
	const root = projectDirectory();
	const absolute = normalize(path.startsWith("/") ? path : join(root, path));
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		throw new Error("Asset paths must stay inside the open project directory.");
	}
	return absolute;
}

function projectPath(path: string): string {
	return relative(projectDirectory(), path).replace(/\\/g, "/");
}

function hash(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function replaceFileAtomically(path: string, content: Buffer): Promise<void> {
	const nonce = randomUUID();
	const temporary = `${path}.${nonce}.asset-move.tmp`;
	const backup = `${path}.${nonce}.asset-move.backup`;
	await writeFile(temporary, content);
	await rename(path, backup);
	try {
		await rename(temporary, path);
		await remove(backup);
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		await rename(backup, path).catch(() => undefined);
		throw error;
	}
}

function movedPath(path: string, sourcePath: string, destinationPath: string, sourceIsDirectory: boolean): string {
	return sourceIsDirectory && path.startsWith(`${sourcePath}/`) ? `${destinationPath}${path.slice(sourcePath.length)}` : path;
}

function rewriteReferenceValue(
	value: string,
	inputReferencerPath: string,
	outputReferencerPath: string,
	sourcePath: string,
	destinationPath: string,
	sourceIsDirectory: boolean
): string | null {
	const resolved = resolveAssetDependencyCandidate(inputReferencerPath, value);
	if (!resolved || (resolved !== sourcePath && !(sourceIsDirectory && resolved.startsWith(`${sourcePath}/`)))) {
		return null;
	}
	const targetPath = sourceIsDirectory ? `${destinationPath}${resolved.slice(sourcePath.length)}` : destinationPath;
	const suffixIndex = value.search(/[?#]/);
	const suffix = suffixIndex >= 0 ? value.slice(suffixIndex) : "";
	const pathValue = (suffixIndex >= 0 ? value.slice(0, suffixIndex) : value).trim();
	const usesBackslashes = pathValue.includes("\\");
	const normalizedValue = pathValue.replace(/\\/g, "/");
	let rewritten: string;
	if (/^(?:assets|src|scripts)\//i.test(normalizedValue)) {
		rewritten = normalizedValue.startsWith("scripts/") && targetPath.startsWith("src/") ? `scripts/${targetPath.slice("src/".length)}` : targetPath;
	} else {
		rewritten = relative(dirname(outputReferencerPath), targetPath).replace(/\\/g, "/") || targetPath.split("/").pop()!;
		if (normalizedValue.startsWith("./") && !rewritten.startsWith(".")) {
			rewritten = `./${rewritten}`;
		}
	}
	if (usesBackslashes) {
		rewritten = rewritten.replace(/\//g, "\\");
	}
	return `${rewritten}${suffix}`;
}

function rewriteBlendReferenceValue(
	value: string,
	inputReferencerPath: string,
	outputReferencerPath: string,
	sourcePath: string,
	destinationPath: string,
	sourceIsDirectory: boolean
): string | null {
	if (!value.trim().startsWith("//")) {
		return rewriteReferenceValue(value, inputReferencerPath, outputReferencerPath, sourcePath, destinationPath, sourceIsDirectory);
	}
	const resolved = resolveBlendDependencyCandidate(inputReferencerPath, value);
	if (!resolved || (resolved !== sourcePath && !(sourceIsDirectory && resolved.startsWith(`${sourcePath}/`)))) {
		return null;
	}
	const targetPath = sourceIsDirectory ? `${destinationPath}${resolved.slice(sourcePath.length)}` : destinationPath;
	const suffixIndex = value.search(/[?#]/);
	const suffix = suffixIndex >= 0 ? value.slice(suffixIndex) : "";
	const rawPath = (suffixIndex >= 0 ? value.slice(0, suffixIndex) : value).trim().slice(2);
	const usesBackslashes = rawPath.includes("\\");
	let rewritten = relative(dirname(outputReferencerPath), targetPath).replace(/\\/g, "/") || targetPath.split("/").pop()!;
	if (usesBackslashes) {
		rewritten = rewritten.replace(/\//g, "\\");
	}
	return `//${rewritten}${suffix}`;
}

function encodeQuotedValue(value: string, quote: string): string {
	if (quote === '"') {
		return JSON.stringify(value);
	}
	return `${quote}${value.replace(/\\/g, "\\\\").replace(new RegExp(quote, "g"), `\\${quote}`)}${quote}`;
}

function decodeQuotedValue(token: string): string | null {
	const quote = token[0];
	if (quote === '"') {
		try {
			return JSON.parse(token);
		} catch {
			return null;
		}
	}
	return token
		.slice(1, -1)
		.replace(new RegExp(`\\\\${quote}`, "g"), quote)
		.replace(/\\\\/g, "\\");
}

function rewriteTextReferences(content: string, context: ITextReferenceRewriteContext): { content: string; replacementCount: number; semanticMatchCount: number } {
	const { extension, inputReferencerPath, outputReferencerPath, sourcePath, destinationPath, sourceIsDirectory } = context;
	const rewriteValue =
		context.rewriteValue ??
		((value: string): string | null => rewriteReferenceValue(value, inputReferencerPath, outputReferencerPath, sourcePath, destinationPath, sourceIsDirectory));
	let replacementCount = 0;
	let semanticMatchCount = 0;
	let updated = content.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, (token, offset: number) => {
		if (
			[".json", ".gltf", ".babylon", ".scene", ".prefab", ".material", ".gui", ".npss", ".animation", ".animations", ".anim", ".animator", ".controller"].includes(extension)
		) {
			const after = content.slice(offset + token.length).match(/^\s*(.)/)?.[1];
			if (after === ":") {
				return token;
			}
		}
		const value = decodeQuotedValue(token);
		if (value === null) {
			return token;
		}
		const rewritten = rewriteValue(value);
		if (rewritten === null) {
			return token;
		}
		semanticMatchCount++;
		if (rewritten === value) {
			return token;
		}
		replacementCount++;
		return encodeQuotedValue(rewritten, token[0]);
	});

	if (extension === ".obj" || extension === ".mtl") {
		updated = updated
			.split(/(?<=\n)/)
			.map((line) => {
				const match = line.match(/^(\s*(?:mtllib|map_[a-z0-9_]+|bump|disp|decal|refl)\s+)(.*?)(\r?\n)?$/i);
				if (!match) {
					return line;
				}
				const tokens = match[2].match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
				const candidate = [...tokens].reverse().find((token) => /\.[a-z0-9]{1,16}(?:[?#].*)?$/i.test(token.replace(/^"|"$/g, "")));
				if (!candidate) {
					return line;
				}
				const raw = candidate.replace(/^"|"$/g, "");
				const rewritten = rewriteValue(raw);
				if (rewritten === null) {
					return line;
				}
				semanticMatchCount++;
				if (rewritten === raw) {
					return line;
				}
				replacementCount++;
				return `${match[1]}${match[2].replace(candidate, candidate.startsWith('"') ? `"${rewritten}"` : rewritten)}${match[3] ?? ""}`;
			})
			.join("");
	}
	if (extension === ".dae") {
		updated = updated.replace(/(<init_from(?:\s[^>]*)?>)([^<]{1,4096})(<\/init_from>)/gi, (match, open: string, value: string, close: string) => {
			const rewritten = rewriteValue(value);
			if (rewritten === null) {
				return match;
			}
			semanticMatchCount++;
			if (rewritten === value) {
				return match;
			}
			replacementCount++;
			return `${open}${rewritten}${close}`;
		});
	}
	updated = updated.replace(/(url\(\s*)([^)'"\s][^)]*?)(\s*\))/gi, (match, open: string, value: string, close: string) => {
		const rewritten = rewriteValue(value);
		if (rewritten === null) {
			return match;
		}
		semanticMatchCount++;
		if (rewritten === value) {
			return match;
		}
		replacementCount++;
		return `${open}${rewritten}${close}`;
	});
	return { content: updated, replacementCount, semanticMatchCount };
}

function rewriteJsonValues(value: unknown, rewrite: (value: string) => string | null): { value: unknown; replacementCount: number; semanticMatchCount: number } {
	if (typeof value === "string") {
		const rewritten = rewrite(value);
		return {
			value: rewritten ?? value,
			replacementCount: rewritten !== null && rewritten !== value ? 1 : 0,
			semanticMatchCount: rewritten !== null ? 1 : 0,
		};
	}
	if (Array.isArray(value)) {
		let replacementCount = 0;
		let semanticMatchCount = 0;
		const result = value.map((entry) => {
			const rewritten = rewriteJsonValues(entry, rewrite);
			replacementCount += rewritten.replacementCount;
			semanticMatchCount += rewritten.semanticMatchCount;
			return rewritten.value;
		});
		return { value: result, replacementCount, semanticMatchCount };
	}
	if (value && typeof value === "object") {
		let replacementCount = 0;
		let semanticMatchCount = 0;
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			const rewritten = rewriteJsonValues(entry, rewrite);
			replacementCount += rewritten.replacementCount;
			semanticMatchCount += rewritten.semanticMatchCount;
			result[key] = rewritten.value;
		}
		return { value: result, replacementCount, semanticMatchCount };
	}
	return { value, replacementCount: 0, semanticMatchCount: 0 };
}

function rewriteGlbReferenceValues(
	buffer: Buffer,
	rewriteValue: (value: string) => string | null
): { buffer: Buffer; replacementCount: number; semanticMatchCount: number; error?: string } {
	if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== buffer.length) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: "GLB header is malformed or truncated." };
	}
	const chunks: Array<{ type: number; data: Buffer }> = [];
	let offset = 12;
	let replacementCount = 0;
	let semanticMatchCount = 0;
	let foundJson = false;
	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32LE(offset);
		const type = buffer.readUInt32LE(offset + 4);
		offset += 8;
		if (offset + length > buffer.length) {
			return { buffer, replacementCount: 0, semanticMatchCount: 0, error: "GLB chunk table is truncated." };
		}
		let data = Buffer.from(buffer.subarray(offset, offset + length));
		if (type === GLB_JSON_CHUNK && !foundJson) {
			foundJson = true;
			try {
				const json = JSON.parse(data.toString("utf-8").replace(/[\0 ]+$/, ""));
				const rewritten = rewriteJsonValues(json, rewriteValue);
				replacementCount = rewritten.replacementCount;
				semanticMatchCount = rewritten.semanticMatchCount;
				if (replacementCount) {
					const jsonBytes = Buffer.from(JSON.stringify(rewritten.value));
					const padding = (4 - (jsonBytes.length % 4)) % 4;
					data = Buffer.concat([jsonBytes, Buffer.alloc(padding, 0x20)]);
				}
			} catch {
				return { buffer, replacementCount: 0, semanticMatchCount: 0, error: "GLB JSON chunk is malformed." };
			}
		}
		chunks.push({ type, data });
		offset += length;
	}
	if (!foundJson || offset !== buffer.length) {
		return { buffer, replacementCount: 0, semanticMatchCount: 0, error: "GLB JSON chunk is missing or the chunk table is malformed." };
	}
	if (!replacementCount) {
		return { buffer, replacementCount: 0, semanticMatchCount };
	}
	const body = Buffer.concat(
		chunks.map(({ type, data }) => {
			const header = Buffer.alloc(8);
			header.writeUInt32LE(data.length, 0);
			header.writeUInt32LE(type, 4);
			return Buffer.concat([header, data]);
		})
	);
	const header = Buffer.from(buffer.subarray(0, 12));
	header.writeUInt32LE(header.length + body.length, 8);
	return { buffer: Buffer.concat([header, body]), replacementCount, semanticMatchCount };
}

function rewriteGlbReferences(
	buffer: Buffer,
	inputReferencerPath: string,
	outputReferencerPath: string,
	sourcePath: string,
	destinationPath: string,
	sourceIsDirectory: boolean
): { buffer: Buffer; replacementCount: number; semanticMatchCount: number; error?: string } {
	return rewriteGlbReferenceValues(buffer, (value) => rewriteReferenceValue(value, inputReferencerPath, outputReferencerPath, sourcePath, destinationPath, sourceIsDirectory));
}

function rewriteFbxReferences(
	buffer: Buffer,
	inputReferencerPath: string,
	outputReferencerPath: string,
	sourcePath: string,
	destinationPath: string,
	sourceIsDirectory: boolean
): { buffer: Buffer; replacementCount: number; semanticMatchCount: number; error?: string } {
	if (isBinaryFbx(buffer)) {
		return rewriteBinaryFbxReferences(buffer, (value) =>
			rewriteReferenceValue(value, inputReferencerPath, outputReferencerPath, sourcePath, destinationPath, sourceIsDirectory)
		);
	}
	const result = rewriteTextReferences(buffer.toString("utf-8"), {
		extension: ".fbx",
		inputReferencerPath,
		outputReferencerPath,
		sourcePath,
		destinationPath,
		sourceIsDirectory,
	});
	return { buffer: Buffer.from(result.content), replacementCount: result.replacementCount, semanticMatchCount: result.semanticMatchCount };
}

async function rewriteArchiveReferences(context: IArchiveReferenceRewriteContext): Promise<IArchiveReferenceRewriteResult> {
	const { absolutePath, before, referencerPath, externalMemberPaths, sourcePath, destinationPath, sourceIsDirectory } = context;
	let archive: Awaited<ReturnType<typeof readRewritableArchive>>;
	try {
		archive = await readRewritableArchive(absolutePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const oversized = /\b(?:limit|more than|exceeds|beyond)\b/i.test(message);
		return {
			buffer: before,
			replacementCount: 0,
			semanticMatchCount: 0,
			archiveMemberCount: 0,
			blockers: [{ path: referencerPath, kind: "archive", reason: oversized ? "oversized" : "malformed", message }],
		};
	}
	let replacementCount = 0;
	let semanticMatchCount = 0;
	let scannedBytes = 0;
	let rewrittenMembers = 0;
	const blockers: IAssetMoveBlocker[] = [];
	for (const member of archive.members) {
		if (!externalMemberPaths.has(member.semanticPath)) {
			continue;
		}
		const rewriteExternalReference = (value: string): string | null => {
			const normalized = value.trim().replace(/\\/g, "/");
			if (!/^(?:assets|src|scripts)\//i.test(normalized)) {
				return null;
			}
			return rewriteReferenceValue(value, member.semanticPath, member.semanticPath, sourcePath, destinationPath, sourceIsDirectory);
		};
		const extension = extname(member.semanticPath).toLowerCase();
		const memberLimit =
			extension === ".fbx" ||
			extension === ".3ds" ||
			extension === ".ms3d" ||
			extension === ".b3d" ||
			extension === ".x" ||
			extension === ".lwo" ||
			extension === ".dxf" ||
			extension === ".blend" ||
			extension === ".glb"
				? MAX_MOVE_REFERENCE_BYTES
				: MAX_TEXT_MOVE_REFERENCE_BYTES;
		if (member.data.length > memberLimit || scannedBytes + member.data.length > MAX_ARCHIVE_MEMBER_REWRITE_BYTES) {
			blockers.push({
				path: `${referencerPath}!/${member.semanticPath}`,
				kind: "archive",
				reason: "oversized",
				message: "Archive member exceeds its format-specific 8/64 MiB per-member or 32 MiB aggregate semantic rewrite limit.",
			});
			continue;
		}
		scannedBytes += member.data.length;
		let after: Buffer;
		let memberReplacementCount: number;
		let memberSemanticMatchCount: number;
		let error: string | undefined;
		if (extension === ".fbx") {
			let result: IBinaryModelReferenceRewriteResult;
			if (isBinaryFbx(member.data)) {
				result = rewriteBinaryFbxReferences(member.data, rewriteExternalReference);
			} else {
				const rewritten = rewriteTextReferences(member.data.toString("utf-8"), {
					extension: ".fbx",
					inputReferencerPath: member.semanticPath,
					outputReferencerPath: member.semanticPath,
					sourcePath,
					destinationPath,
					sourceIsDirectory,
					rewriteValue: rewriteExternalReference,
				});
				result = { buffer: Buffer.from(rewritten.content), replacementCount: rewritten.replacementCount, semanticMatchCount: rewritten.semanticMatchCount };
			}
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (extension === ".3ds") {
			const result = rewrite3dsReferences(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (extension === ".ms3d") {
			const result = rewriteMs3dReferences(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (extension === ".b3d") {
			const result = rewriteB3dReferences(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (extension === ".x") {
			const result = rewriteXReferences(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (extension === ".lwo") {
			const result = rewriteLwoReferences(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
			if (error) {
				blockers.push({
					path: `${referencerPath}!/${member.semanticPath}`,
					kind: "archive/lwo",
					reason: result.errorKind ?? "malformed",
					message: error,
				});
				continue;
			}
		} else if (extension === ".dxf") {
			const result = rewriteDxfReferences(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
			if (error) {
				blockers.push({
					path: `${referencerPath}!/${member.semanticPath}`,
					kind: "archive/dxf",
					reason: "malformed",
					message: error,
				});
				continue;
			}
		} else if (extension === ".blend") {
			const result = rewriteBlendReferences(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
			if (error) {
				blockers.push({
					path: `${referencerPath}!/${member.semanticPath}`,
					kind: "archive/blend",
					reason: result.errorKind ?? "malformed",
					message: error,
				});
				continue;
			}
		} else if (extension === ".glb") {
			const result = rewriteGlbReferenceValues(member.data, rewriteExternalReference);
			after = result.buffer;
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else {
			const result = rewriteTextReferences(member.data.toString("utf-8"), {
				extension,
				inputReferencerPath: member.semanticPath,
				outputReferencerPath: member.semanticPath,
				sourcePath,
				destinationPath,
				sourceIsDirectory,
				rewriteValue: rewriteExternalReference,
			});
			after = Buffer.from(result.content);
			memberReplacementCount = result.replacementCount;
			memberSemanticMatchCount = result.semanticMatchCount;
		}
		if (error) {
			blockers.push({ path: `${referencerPath}!/${member.semanticPath}`, kind: `archive/${extension.slice(1)}`, reason: "malformed", message: error });
			continue;
		}
		const rewrittenAggregateBytes = scannedBytes - member.data.length + after.length;
		if (after.length > memberLimit || rewrittenAggregateBytes > MAX_ARCHIVE_MEMBER_REWRITE_BYTES) {
			blockers.push({
				path: `${referencerPath}!/${member.semanticPath}`,
				kind: "archive",
				reason: "oversized",
				message: "Rewritten archive member would exceed its format-specific per-member or 32 MiB aggregate semantic rewrite limit.",
			});
			continue;
		}
		scannedBytes = rewrittenAggregateBytes;
		if (!memberSemanticMatchCount) {
			blockers.push({
				path: `${referencerPath}!/${member.semanticPath}`,
				kind: "archive",
				reason: "semanticMismatch",
				message: "The archive dependency index identifies this external reference, but no supported semantic token matched its original spelling.",
			});
			continue;
		}
		semanticMatchCount += memberSemanticMatchCount;
		replacementCount += memberReplacementCount;
		if (memberReplacementCount) {
			member.data = after;
			rewrittenMembers++;
		}
	}
	if (!semanticMatchCount && !blockers.length) {
		blockers.push({
			path: referencerPath,
			kind: "archive",
			reason: "semanticMismatch",
			message: "The archive registry entry no longer contains the indexed external-reference member. Rebuild the asset registry and inspect the move again.",
		});
	}
	if (!replacementCount) {
		return { buffer: before, replacementCount, semanticMatchCount, archiveFormat: archive.format, archiveMemberCount: 0, blockers };
	}
	try {
		return {
			buffer: writeRewritableArchive(archive),
			replacementCount,
			semanticMatchCount,
			archiveFormat: archive.format,
			archiveMemberCount: rewrittenMembers,
			blockers,
		};
	} catch (error) {
		return {
			buffer: before,
			replacementCount: 0,
			semanticMatchCount: 0,
			archiveFormat: archive.format,
			archiveMemberCount: 0,
			blockers: [
				...blockers,
				{
					path: referencerPath,
					kind: "archive",
					reason: "malformed",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}

function publicPlan(plan: IPreparedAssetMovePlan): IAssetMovePlan {
	const { preparedRewrites: _preparedRewrites, ...result } = plan;
	return result;
}

async function prepareAssetMove(source: string, destination: string): Promise<IPreparedAssetMovePlan> {
	const sourceAbsolutePath = resolveProjectPath(source);
	const destinationAbsolutePath = resolveProjectPath(destination);
	if (sourceAbsolutePath === projectDirectory()) {
		throw new Error("The project root cannot be moved.");
	}
	if (!(await pathExists(sourceAbsolutePath))) {
		throw new Error(`Asset not found: ${source}`);
	}
	if (await pathExists(destinationAbsolutePath)) {
		throw new Error(`An asset or folder already exists at: ${destination}`);
	}
	const sourceDetails = await stat(sourceAbsolutePath);
	const sourceIsDirectory = sourceDetails.isDirectory();
	if (sourceIsDirectory && destinationAbsolutePath.startsWith(`${sourceAbsolutePath}/`)) {
		throw new Error("A folder cannot be moved inside itself.");
	}
	const sourcePath = projectPath(sourceAbsolutePath);
	const destinationPath = projectPath(destinationAbsolutePath);
	const sourceGuid = sourceIsDirectory ? null : (await readAssetMetadata(sourceAbsolutePath)).guid;
	const referencers = await getIndexedAssetMoveReferencers(sourceAbsolutePath, sourceIsDirectory);
	if (referencers.length > MAX_MOVE_REFERENCE_FILES) {
		throw new Error(`Asset move affects ${referencers.length} reference files; the safe limit is ${MAX_MOVE_REFERENCE_FILES}. Narrow the move or split the folder first.`);
	}
	const preparedRewrites: IPreparedAssetMoveRewrite[] = [];
	const blockers: IAssetMoveBlocker[] = [];
	let unchangedReferenceCount = 0;
	let totalBytes = 0;
	for (const referencer of referencers) {
		if (
			referencer.dependencyScanKind !== "text" &&
			referencer.dependencyScanKind !== "glb" &&
			referencer.dependencyScanKind !== "fbx" &&
			referencer.dependencyScanKind !== "3ds" &&
			referencer.dependencyScanKind !== "ms3d" &&
			referencer.dependencyScanKind !== "b3d" &&
			referencer.dependencyScanKind !== "x" &&
			referencer.dependencyScanKind !== "lwo" &&
			referencer.dependencyScanKind !== "dxf" &&
			referencer.dependencyScanKind !== "blend" &&
			referencer.dependencyScanKind !== "archive"
		) {
			continue;
		}
		const absoluteReferencerPath = resolveProjectPath(referencer.path);
		const before = await readFile(absoluteReferencerPath);
		totalBytes += before.length;
		const limit = referencer.dependencyScanKind === "text" ? MAX_TEXT_MOVE_REFERENCE_BYTES : MAX_MOVE_REFERENCE_BYTES;
		if (before.length > limit || totalBytes > MAX_MOVE_REFERENCE_BYTES) {
			blockers.push({
				path: referencer.path,
				kind: referencer.dependencyScanKind,
				reason: "oversized",
				message: "Reference source exceeds the bounded semantic rewrite limit.",
			});
			continue;
		}
		const outputPath = movedPath(referencer.path, sourcePath, destinationPath, sourceIsDirectory);
		let after: Buffer;
		let replacementCount: number;
		let semanticMatchCount: number;
		let error: string | undefined;
		let errorReason: IAssetMoveBlocker["reason"] = "malformed";
		let archiveFormat: AssetArchiveFormat | undefined;
		let archiveMemberCount: number | undefined;
		let archiveBlockerCount = 0;
		if (referencer.dependencyScanKind === "archive") {
			const externalMemberPaths = new Set(
				referencer.containerDependencies
					.filter(
						(dependency) => dependency.external && (dependency.targetPath === sourcePath || (sourceIsDirectory && dependency.targetPath.startsWith(`${sourcePath}/`)))
					)
					.map((dependency) => dependency.sourcePath)
			);
			const result = await rewriteArchiveReferences({
				absolutePath: absoluteReferencerPath,
				before,
				referencerPath: referencer.path,
				externalMemberPaths,
				sourcePath,
				destinationPath,
				sourceIsDirectory,
			});
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			archiveFormat = result.archiveFormat;
			archiveMemberCount = result.archiveMemberCount;
			archiveBlockerCount = result.blockers.length;
			blockers.push(...result.blockers);
		} else if (referencer.dependencyScanKind === "fbx") {
			const result = rewriteFbxReferences(before, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory);
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (referencer.dependencyScanKind === "3ds") {
			const result = rewrite3dsReferences(before, (value) => rewriteReferenceValue(value, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory));
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (referencer.dependencyScanKind === "ms3d") {
			const result = rewriteMs3dReferences(before, (value) => rewriteReferenceValue(value, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory));
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (referencer.dependencyScanKind === "b3d") {
			const result = rewriteB3dReferences(before, (value) => rewriteReferenceValue(value, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory));
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (referencer.dependencyScanKind === "x") {
			const result = rewriteXReferences(before, (value) => rewriteReferenceValue(value, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory));
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (referencer.dependencyScanKind === "lwo") {
			const result = rewriteLwoReferences(before, (value) => rewriteReferenceValue(value, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory));
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
			errorReason = result.errorKind ?? "malformed";
		} else if (referencer.dependencyScanKind === "dxf") {
			const result = rewriteDxfReferences(before, (value) => rewriteReferenceValue(value, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory));
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else if (referencer.dependencyScanKind === "blend") {
			const result = rewriteBlendReferences(before, (value) =>
				rewriteBlendReferenceValue(value, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory)
			);
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
			errorReason = result.errorKind ?? "malformed";
		} else if (referencer.dependencyScanKind === "glb") {
			const result = rewriteGlbReferences(before, referencer.path, outputPath, sourcePath, destinationPath, sourceIsDirectory);
			after = result.buffer;
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
			error = result.error;
		} else {
			const result = rewriteTextReferences(before.toString("utf-8"), {
				extension: extname(referencer.path).toLowerCase(),
				inputReferencerPath: referencer.path,
				outputReferencerPath: outputPath,
				sourcePath,
				destinationPath,
				sourceIsDirectory,
			});
			after = Buffer.from(result.content);
			replacementCount = result.replacementCount;
			semanticMatchCount = result.semanticMatchCount;
		}
		if (error) {
			blockers.push({ path: referencer.path, kind: referencer.dependencyScanKind, reason: errorReason, message: error });
			continue;
		}
		if (after.length > limit) {
			blockers.push({
				path: referencer.path,
				kind: referencer.dependencyScanKind,
				reason: "oversized",
				message: "Rewritten reference source would exceed its format-specific semantic rewrite limit.",
			});
			continue;
		}
		if (!semanticMatchCount) {
			if (referencer.dependencyScanKind === "archive" && archiveBlockerCount) {
				continue;
			}
			blockers.push({
				path: referencer.path,
				kind: referencer.dependencyScanKind,
				reason: "semanticMismatch",
				message: "The dependency index identifies this reference, but no supported semantic token matched its original spelling.",
			});
			continue;
		}
		if (!replacementCount) {
			unchangedReferenceCount += semanticMatchCount;
			continue;
		}
		preparedRewrites.push({
			path: referencer.path,
			outputPath,
			kind: referencer.dependencyScanKind,
			replacementCount,
			beforeHash: hash(before),
			afterHash: hash(after),
			byteLength: before.length,
			archiveFormat,
			archiveMemberCount,
			before,
			after,
		});
	}
	const rewrites: IAssetMoveRewrite[] = preparedRewrites.map(({ before: _before, after: _after, ...rewrite }) => rewrite);
	const fingerprintData = {
		sourcePath,
		destinationPath,
		sourceGuid,
		sourceIsDirectory,
		sourceSizeBytes: sourceDetails.size,
		sourceModifiedAt: sourceDetails.mtime.toISOString(),
		rewrites,
		blockers,
		unchangedReferenceCount,
	};
	return {
		...fingerprintData,
		rewrites,
		blockers,
		totalReplacementCount: rewrites.reduce((count, rewrite) => count + rewrite.replacementCount, 0),
		unchangedReferenceCount,
		planFingerprint: hash(JSON.stringify(fingerprintData)),
		preparedRewrites,
	};
}

export async function inspectSemanticAssetMove(data: { sourcePath: string; destinationPath: string }): Promise<IAssetMovePlan> {
	return publicPlan(await prepareAssetMove(data.sourcePath, data.destinationPath));
}

export async function applySemanticAssetMove(data: {
	sourcePath: string;
	destinationPath: string;
	expectedPlanFingerprint?: string;
	allowUnsupportedReferences?: boolean;
	updateReferences?: boolean;
}): Promise<IAssetMovePlan & { moved: true; updatedReferences: string[] }> {
	const plan = await prepareAssetMove(data.sourcePath, data.destinationPath);
	if (data.expectedPlanFingerprint && data.expectedPlanFingerprint !== plan.planFingerprint) {
		throw new Error(`Asset move plan changed. Inspect again and retry with expectedPlanFingerprint: ${plan.planFingerprint}.`);
	}
	const updateReferences = data.updateReferences !== false;
	if (updateReferences && plan.blockers.length && data.allowUnsupportedReferences !== true) {
		throw new Error(
			`Asset move has ${plan.blockers.length} unsupported or unsafe reference source(s). Inspect the plan and either repair them or retry with allowUnsupportedReferences: true.`
		);
	}
	const sourceAbsolutePath = resolveProjectPath(plan.sourcePath);
	const destinationAbsolutePath = resolveProjectPath(plan.destinationPath);
	const sourceMetadataPath = `${sourceAbsolutePath}.bjsmeta.json`;
	const destinationMetadataPath = `${destinationAbsolutePath}.bjsmeta.json`;
	let assetMoved = false;
	let metadataMoved = false;
	const written: IPreparedAssetMoveRewrite[] = [];
	try {
		await mkdir(dirname(destinationAbsolutePath), { recursive: true });
		await move(sourceAbsolutePath, destinationAbsolutePath);
		assetMoved = true;
		if (!plan.sourceIsDirectory && (await pathExists(sourceMetadataPath))) {
			await move(sourceMetadataPath, destinationMetadataPath);
			metadataMoved = true;
		}
		for (const rewrite of updateReferences ? plan.preparedRewrites : []) {
			const outputAbsolutePath = resolveProjectPath(rewrite.outputPath);
			await replaceFileAtomically(outputAbsolutePath, rewrite.after);
			written.push(rewrite);
		}
	} catch (error) {
		for (const rewrite of [...written].reverse()) {
			const outputAbsolutePath = resolveProjectPath(rewrite.outputPath);
			await writeFile(outputAbsolutePath, rewrite.before).catch(() => undefined);
		}
		if (metadataMoved && (await pathExists(destinationMetadataPath))) {
			await move(destinationMetadataPath, sourceMetadataPath, { overwrite: true }).catch(() => undefined);
		}
		if (assetMoved && (await pathExists(destinationAbsolutePath))) {
			await move(destinationAbsolutePath, sourceAbsolutePath, { overwrite: true }).catch(() => undefined);
		}
		throw error;
	}
	return { ...publicPlan(plan), moved: true, updatedReferences: updateReferences ? plan.rewrites.map((rewrite) => rewrite.outputPath) : [] };
}
