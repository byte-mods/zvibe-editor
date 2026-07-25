import { createHash, randomUUID } from "crypto";
import { isAbsolute as isNativeAbsolute, normalize as normalizeNativePath } from "path";
import { basename, dirname, extname, join, relative, resolve } from "path/posix";

import { ensureDir, move, pathExists, readFile, remove, stat, writeFile } from "fs-extra";

import { inspectPsdLayers, replacePsdEmbeddedSmartObjectPayloads, replacePsdNestedEmbeddedSmartObjectPayloads } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";

const MAXIMUM_SOURCE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_REPLACEMENT_BYTES = 256 * 1024 * 1024;

export interface IPsdSmartObjectPayloadReplacementRequest {
	resourceIndex?: number;
	resourcePath?: number[];
	sourcePath: string;
}

export interface IPsdSmartObjectPayloadReplacementOptions {
	destinationPath?: string;
	replacements: IPsdSmartObjectPayloadReplacementRequest[];
}

export interface IPsdSmartObjectPayloadReplacementItem {
	resourceIndex: number;
	resourcePath: number[];
	resourceIdPath: string[];
	depth: number;
	resourceId: string;
	resourceName: string;
	fileType: string;
	sourceKey: "lnk2" | "lnkD" | "lnk3" | "lnkE";
	sourcePath: string;
	sourceByteLength: number;
	sourceHash: string;
	previousByteLength: number;
	replacementByteLength: number;
	executionModel: "bounded-smart-object-payload-replacement-v1" | "bounded-recursive-smart-object-payload-replacement-v1";
}

export interface IPsdSmartObjectPayloadReplacementStatus {
	version: 1;
	path: string;
	destinationPath: string;
	sourceByteLength: number;
	sourceHash: string;
	outputByteLength: number;
	outputHash: string;
	action: "create" | "reuse" | "conflict";
	fingerprint: string;
	items: IPsdSmartObjectPayloadReplacementItem[];
	ancestorRebuilds: Array<{
		resourcePath: number[];
		resourceIdPath: string[];
		depth: number;
		resourceIndex: number;
		resourceId: string;
		resourceName: string;
		previousByteLength: number;
		replacementByteLength: number;
	}>;
	executionModel: "bounded-smart-object-payload-replacement-v1" | "bounded-recursive-smart-object-payload-replacement-v1";
}

interface IPreparedPsdSmartObjectPayloadReplacement {
	status: IPsdSmartObjectPayloadReplacementStatus;
	output: Buffer;
}

interface INormalizedPsdSmartObjectPayloadReplacementRequest {
	resourcePath: number[];
	sourcePath: string;
}

function normalizeResourcePath(request: IPsdSmartObjectPayloadReplacementRequest): number[] {
	const hasIndex = request.resourceIndex !== undefined;
	const hasPath = request.resourcePath !== undefined;
	if (hasIndex === hasPath) {
		throw new Error("Each PSD smart-object replacement must provide exactly one of resourceIndex or resourcePath.");
	}
	const path = hasPath ? request.resourcePath! : [request.resourceIndex!];
	if (!Array.isArray(path) || path.length < 1 || path.length > 8 || path.some((index) => !Number.isSafeInteger(index) || index < 0 || index > 1023)) {
		throw new Error("Each PSD smart-object replacement resourcePath must contain 1-8 integer indices between 0 and 1,023.");
	}
	return [...path];
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return resolve(dirname(projectConfiguration.path));
}

function portablePath(path: string): string {
	return relative(projectDirectory(), path).replace(/\\/g, "/");
}

function assertContained(path: string, label: string): void {
	const root = projectDirectory();
	if (path !== root && !path.startsWith(`${root}/`)) {
		throw new Error(`${label} must stay inside the open project directory.`);
	}
}

function resolveDestinationPath(sourcePath: string, value?: string): string {
	const portable = value?.trim().replace(/\\/g, "/") || join(dirname(portablePath(sourcePath)), `${basename(sourcePath, extname(sourcePath))}-smart-objects.psd`);
	if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable) || extname(portable).toLowerCase() !== ".psd") {
		throw new Error("PSD smart-object replacement destinationPath must be a project-relative .psd path.");
	}
	const absolute = resolve(projectDirectory(), portable);
	assertContained(absolute, "PSD smart-object replacement destinationPath");
	if (absolute === sourcePath) {
		throw new Error("PSD smart-object replacement never rewrites the source in place; choose a different destinationPath.");
	}
	return absolute;
}

/** Builds an exact top-level embedded smart-object replacement plan without mutating files. */
export async function preparePsdSmartObjectPayloadReplacement(
	sourcePath: string,
	options: IPsdSmartObjectPayloadReplacementOptions
): Promise<IPreparedPsdSmartObjectPayloadReplacement> {
	const absoluteSource = resolve(sourcePath);
	assertContained(absoluteSource, "PSD smart-object source");
	if (extname(absoluteSource).toLowerCase() !== ".psd" || !(await pathExists(absoluteSource)) || (await stat(absoluteSource)).isDirectory()) {
		throw new Error("Smart-object payload replacement requires an existing project .psd source asset.");
	}
	const sourceDetails = await stat(absoluteSource);
	if (sourceDetails.size > MAXIMUM_SOURCE_BYTES) {
		throw new Error("PSD smart-object replacement is limited to 512 MiB source documents.");
	}
	if (!options || !Array.isArray(options.replacements) || options.replacements.length < 1 || options.replacements.length > 128) {
		throw new Error("PSD smart-object replacement requires 1-128 replacement requests.");
	}
	const source = await readFile(absoluteSource);
	const document = inspectPsdLayers(source);
	const paths = new Set<string>();
	const prepared: Array<{ request: INormalizedPsdSmartObjectPayloadReplacementRequest; data: Buffer; hash: string }> = [];
	for (const request of options.replacements) {
		if (!request || typeof request !== "object") {
			throw new Error("Each PSD smart-object replacement must be an object.");
		}
		const resourcePath = normalizeResourcePath(request);
		const pathKey = resourcePath.join("/");
		if (paths.has(pathKey)) {
			throw new Error(`PSD smart-object replacement contains duplicate resourcePath ${pathKey}.`);
		}
		paths.add(pathKey);
		const topResource = document.smartObjectResources[resourcePath[0]];
		if (!topResource || topResource.index !== resourcePath[0] || topResource.type !== "embedded" || topResource.recordSignature !== "liFD") {
			throw new Error(`PSD smart-object resource path ${pathKey} does not begin with an embedded liFD payload.`);
		}
		if (typeof request.sourcePath !== "string" || !request.sourcePath.trim() || request.sourcePath.length > 4096 || request.sourcePath.includes("\0")) {
			throw new Error(`PSD smart-object replacement ${pathKey} sourcePath must be a non-empty absolute path of at most 4,096 characters with no NUL bytes.`);
		}
		const selectedPath = normalizeNativePath(request.sourcePath.trim());
		if (!isNativeAbsolute(selectedPath) || !(await pathExists(selectedPath))) {
			throw new Error(`PSD smart-object replacement ${pathKey} sourcePath must be an existing absolute local file explicitly selected by the user.`);
		}
		const details = await stat(selectedPath);
		if (!details.isFile() || details.size < 1 || details.size > MAXIMUM_REPLACEMENT_BYTES) {
			throw new Error(`PSD smart-object replacement ${pathKey} sourcePath must be a non-empty file no larger than 256 MiB.`);
		}
		const data = await readFile(selectedPath);
		prepared.push({ request: { resourcePath, sourcePath: selectedPath }, data, hash: createHash("sha256").update(data).digest("hex") });
	}
	const topLevelOnly = prepared.every((entry) => entry.request.resourcePath.length === 1);
	const rewritten = topLevelOnly
		? (() => {
				const result = replacePsdEmbeddedSmartObjectPayloads(
					source,
					prepared.map((entry) => ({ resourceIndex: entry.request.resourcePath[0], data: entry.data }))
				);
				return {
					...result,
					items: result.items.map((item) => ({ ...item, resourcePath: [item.resourceIndex], resourceIdPath: [item.resourceId], depth: 1 })),
					ancestorRebuilds: [],
				};
			})()
		: replacePsdNestedEmbeddedSmartObjectPayloads(
				source,
				prepared.map((entry) => ({ resourcePath: entry.request.resourcePath, data: entry.data }))
			);
	const output = Buffer.from(rewritten.data);
	const destination = resolveDestinationPath(absoluteSource, options.destinationPath);
	const outputHash = createHash("sha256").update(output).digest("hex");
	let action: IPsdSmartObjectPayloadReplacementStatus["action"] = "create";
	if (await pathExists(destination)) {
		action =
			(await stat(destination)).isFile() &&
			createHash("sha256")
				.update(await readFile(destination))
				.digest("hex") === outputHash
				? "reuse"
				: "conflict";
	}
	const items = rewritten.items.map((item): IPsdSmartObjectPayloadReplacementItem => {
		const selected = prepared.find((entry) => entry.request.resourcePath.join("/") === item.resourcePath.join("/"))!;
		return {
			...item,
			sourcePath: selected.request.sourcePath,
			sourceByteLength: selected.data.byteLength,
			sourceHash: selected.hash,
		};
	});
	const sourceHash = createHash("sha256").update(source).digest("hex");
	const fingerprint = createHash("sha256")
		.update(source)
		.update("\0")
		.update(JSON.stringify({ destinationPath: portablePath(destination), action, outputHash, items, ancestorRebuilds: rewritten.ancestorRebuilds }))
		.digest("hex");
	return {
		status: {
			version: 1,
			path: portablePath(absoluteSource),
			destinationPath: portablePath(destination),
			sourceByteLength: source.byteLength,
			sourceHash,
			outputByteLength: output.byteLength,
			outputHash,
			action,
			fingerprint,
			items,
			ancestorRebuilds: rewritten.ancestorRebuilds,
			executionModel: rewritten.executionModel,
		},
		output,
	};
}

/** Returns exact no-overwrite replacement status without writing a PSD. */
export async function getPsdSmartObjectPayloadReplacementStatus(
	sourcePath: string,
	options: IPsdSmartObjectPayloadReplacementOptions
): Promise<IPsdSmartObjectPayloadReplacementStatus> {
	return (await preparePsdSmartObjectPayloadReplacement(sourcePath, options)).status;
}

/** Publishes one exact replacement PSD copy atomically; the original source is never modified. */
export async function applyPsdSmartObjectPayloadReplacement(
	sourcePath: string,
	options: IPsdSmartObjectPayloadReplacementOptions,
	expectedFingerprint: string
): Promise<IPsdSmartObjectPayloadReplacementStatus> {
	if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
		throw new Error("PSD smart-object replacement requires the exact 64-character inspection fingerprint.");
	}
	const prepared = await preparePsdSmartObjectPayloadReplacement(sourcePath, options);
	if (prepared.status.fingerprint !== expectedFingerprint) {
		throw new Error("PSD smart-object replacement plan changed; inspect again before applying.");
	}
	if (prepared.status.action === "conflict") {
		throw new Error("PSD smart-object replacement destination contains different bytes; choose another destinationPath.");
	}
	if (prepared.status.action === "reuse") {
		return prepared.status;
	}
	const destination = resolve(projectDirectory(), prepared.status.destinationPath);
	await ensureDir(dirname(destination));
	const temporary = join(dirname(destination), `.${basename(destination)}.tmp-${randomUUID()}`);
	try {
		await writeFile(temporary, prepared.output);
		await move(temporary, destination, { overwrite: false });
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
	return prepared.status;
}
