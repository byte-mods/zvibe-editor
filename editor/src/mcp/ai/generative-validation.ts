import { createHash, randomUUID } from "crypto";
import { realpath } from "fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "path";

import { ensureDir, lstat, move, pathExists, readFile, readdir, remove, writeFile } from "fs-extra";
import sharp from "sharp";
import {
	executeAnimationImporterSource,
	GenerativeArtifactRole,
	IGenerativeAssetCandidate,
	IGenerativeAssetProviderResult,
	IGenerativeAssetRequest,
	normalizeAnimationImporterSettings,
	parseAudioProbe,
	createAudioProbeArguments,
} from "babylonjs-editor-tools";

import { Editor } from "../../editor/main";
import { resolveMediaExecutable, runMediaProcess } from "../assets/media-executables";

const maximumResultManifestBytes = 1024 * 1024;
const maximumOutputFiles = 65;
const maximumOutputDirectories = 128;
const maximumOutputDepth = 8;
const maximumImagePixels = 67_108_864;
const maximumPreviewBytes = 8 * 1024 * 1024;

export interface IValidatedGenerativeArtifact {
	path: string;
	role: GenerativeArtifactRole;
	mediaType: string;
	displayName: string | null;
	sha256: string;
	sizeBytes: number;
	inspection: Record<string, unknown>;
}

export interface IValidatedGenerativePreview {
	path: string;
	mediaType: string;
	sha256: string;
	sizeBytes: number;
}

export interface IValidatedGenerativeCandidate extends Omit<IGenerativeAssetCandidate, "artifacts"> {
	artifacts: IValidatedGenerativeArtifact[];
	preview: IValidatedGenerativePreview | null;
}

export interface IValidatedGenerativeResult {
	result: IGenerativeAssetProviderResult;
	candidates: IValidatedGenerativeCandidate[];
	resultFingerprint: string;
	outputBytes: number;
}

export interface IGenerativeOutputValidationOptions {
	editor: Editor;
	createPreviews: boolean;
}

function sha256(value: Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function contained(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function portablePath(value: string): string {
	return value.replace(/\\/g, "/");
}

async function ensureSafeParent(root: string, target: string): Promise<void> {
	const rootReal = await realpath(root);
	const targetParent = dirname(target);
	if (!contained(root, targetParent)) {
		throw new Error("Generative provider artifact path escaped its staging directory.");
	}
	const segments = relative(root, targetParent).split(sep).filter(Boolean);
	let current = root;
	for (const segment of segments) {
		current = join(current, segment);
		if (!(await pathExists(current))) {
			await ensureDir(current);
		}
		const details = await lstat(current);
		const resolved = await realpath(current);
		if (details.isSymbolicLink() || !details.isDirectory() || !contained(rootReal, resolved)) {
			throw new Error("Generative provider artifact directories must be regular contained directories without symlinks.");
		}
	}
}

function sanitizedResult(result: IGenerativeAssetProviderResult): IGenerativeAssetProviderResult {
	return {
		version: result.version,
		candidates: result.candidates.map((candidate) => ({
			...candidate,
			artifacts: candidate.artifacts.map((artifact) => ({ ...artifact, dataBase64: null })),
		})),
	};
}

/** Materializes canonical inline HTTP artifacts and rewrites result.json without retaining base64 payloads. */
export async function materializeGenerativeProviderResult(
	outputRoot: string,
	result: IGenerativeAssetProviderResult,
	maximumOutputBytes: number
): Promise<IGenerativeAssetProviderResult> {
	let inlineBytes = 0;
	for (const candidate of result.candidates) {
		for (const artifact of candidate.artifacts) {
			if (artifact.path.toLowerCase() === "result.json") {
				throw new Error("Generative provider artifacts cannot replace the reserved result.json manifest.");
			}
			if (artifact.dataBase64 === null) {
				continue;
			}
			const bytes = Buffer.from(artifact.dataBase64, "base64");
			inlineBytes += bytes.byteLength;
			if (inlineBytes > maximumOutputBytes) {
				throw new Error(`Inline generative provider artifacts exceed the ${maximumOutputBytes}-byte output limit.`);
			}
			const destination = join(outputRoot, artifact.path);
			await ensureSafeParent(outputRoot, destination);
			if (await pathExists(destination)) {
				const details = await lstat(destination);
				if (details.isSymbolicLink() || !details.isFile()) {
					throw new Error(`Generative provider artifact is not a regular file: ${artifact.path}.`);
				}
				const existing = await readFile(destination);
				if (!existing.equals(bytes)) {
					throw new Error(`Generative provider supplied conflicting file and inline bytes for ${artifact.path}.`);
				}
			} else {
				await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
			}
		}
	}
	const clean = sanitizedResult(result);
	const manifest = Buffer.from(`${JSON.stringify(clean, null, "\t")}\n`, "utf8");
	if (manifest.byteLength > maximumResultManifestBytes) {
		throw new Error("Sanitized generative provider result.json exceeds 1 MiB.");
	}
	const destination = join(outputRoot, "result.json");
	const temporary = `${destination}.${randomUUID()}.tmp`;
	await writeFile(temporary, manifest, { mode: 0o600, flag: "wx" });
	try {
		await move(temporary, destination, { overwrite: true });
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
	return clean;
}

async function discoverFiles(root: string): Promise<Map<string, { absolutePath: string; sizeBytes: number }>> {
	const rootDetails = await lstat(root);
	const rootReal = await realpath(root);
	if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
		throw new Error("Generative provider output root must be a regular directory without symlinks.");
	}
	const files = new Map<string, { absolutePath: string; sizeBytes: number }>();
	let directories = 0;
	const visit = async (directory: string, depth: number): Promise<void> => {
		if (depth > maximumOutputDepth) {
			throw new Error(`Generative provider output exceeds the ${maximumOutputDepth}-level directory limit.`);
		}
		directories++;
		if (directories > maximumOutputDirectories) {
			throw new Error(`Generative provider output exceeds the ${maximumOutputDirectories}-directory limit.`);
		}
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
			const absolutePath = join(directory, entry.name);
			const details = await lstat(absolutePath);
			if (details.isSymbolicLink()) {
				throw new Error(`Generative provider output cannot contain symlinks: ${portablePath(relative(root, absolutePath))}.`);
			}
			const resolved = await realpath(absolutePath);
			if (!contained(rootReal, resolved)) {
				throw new Error("Generative provider output resolves outside its staging directory.");
			}
			if (details.isDirectory()) {
				await visit(absolutePath, depth + 1);
			} else if (details.isFile()) {
				const path = portablePath(relative(root, absolutePath));
				files.set(path, { absolutePath, sizeBytes: details.size });
				if (files.size > maximumOutputFiles) {
					throw new Error(`Generative provider output exceeds the ${maximumOutputFiles}-file limit including result.json.`);
				}
			} else {
				throw new Error(`Generative provider output contains an unsupported filesystem entry: ${entry.name}.`);
			}
		}
	};
	await visit(root, 0);
	return files;
}

function expectedMediaType(path: string, role: GenerativeArtifactRole): string[] {
	const extension = extname(path).toLowerCase();
	if (["image", "sprite", "spritesheet", "base-color", "normal", "metallic", "roughness", "ambient-occlusion", "height", "emissive", "opacity", "preview-image"].includes(role)) {
		return extension === ".png" ? ["image/png"] : [".jpg", ".jpeg"].includes(extension) ? ["image/jpeg"] : extension === ".webp" ? ["image/webp"] : [];
	}
	if (role === "material" || role === "animation" || role === "metadata") {
		return role === "material" && extension === ".material"
			? ["application/json"]
			: role === "animation" && extension === ".animation"
				? ["application/json"]
				: role === "metadata" && extension === ".json"
					? ["application/json"]
					: [];
	}
	if (role === "audio" || role === "preview-audio") {
		return extension === ".wav" || extension === ".wave"
			? ["audio/wav", "audio/x-wav"]
			: extension === ".mp3"
				? ["audio/mpeg"]
				: extension === ".ogg"
					? ["audio/ogg"]
					: extension === ".flac"
						? ["audio/flac", "audio/x-flac"]
						: extension === ".m4a"
							? ["audio/mp4", "audio/x-m4a"]
							: [];
	}
	if (role === "preview-video" || role === "source-video") {
		return extension === ".mp4" ? ["video/mp4"] : extension === ".webm" ? ["video/webm"] : [];
	}
	return [];
}

function imageRole(role: GenerativeArtifactRole): boolean {
	return ["image", "sprite", "spritesheet", "base-color", "normal", "metallic", "roughness", "ambient-occlusion", "height", "emissive", "opacity", "preview-image"].includes(
		role
	);
}

async function inspectImage(path: string, role: GenerativeArtifactRole, request: IGenerativeAssetRequest): Promise<Record<string, unknown>> {
	const metadata = await sharp(path, { animated: false, limitInputPixels: maximumImagePixels }).metadata();
	if (!metadata.width || !metadata.height || metadata.width * metadata.height > maximumImagePixels) {
		throw new Error(`Generated image ${basename(path)} has invalid or excessive dimensions.`);
	}
	await sharp(path, { animated: false, limitInputPixels: maximumImagePixels }).rotate().ensureAlpha().raw().toBuffer();
	if (role === "image" && request.options.modality === "image" && (metadata.width !== request.options.value.width || metadata.height !== request.options.value.height)) {
		throw new Error(`Generated image dimensions ${metadata.width}x${metadata.height} do not match requested ${request.options.value.width}x${request.options.value.height}.`);
	}
	if (
		["sprite", "spritesheet"].includes(role) &&
		request.options.modality === "sprite" &&
		(metadata.width !== request.options.value.width || metadata.height !== request.options.value.height)
	) {
		throw new Error(`Generated sprite dimensions ${metadata.width}x${metadata.height} do not match requested ${request.options.value.width}x${request.options.value.height}.`);
	}
	if (["base-color", "normal", "metallic", "roughness", "ambient-occlusion", "height", "emissive", "opacity"].includes(role) && request.options.modality === "material") {
		if (metadata.width !== request.options.value.resolution || metadata.height !== request.options.value.resolution) {
			throw new Error(
				`Generated ${role} map dimensions ${metadata.width}x${metadata.height} do not match requested ${request.options.value.resolution}x${request.options.value.resolution}.`
			);
		}
	}
	return {
		kind: "image",
		width: metadata.width,
		height: metadata.height,
		channels: metadata.channels ?? null,
		format: metadata.format ?? null,
		alpha: metadata.hasAlpha ?? false,
	};
}

async function inspectMaterial(path: string): Promise<Record<string, unknown>> {
	const bytes = await readFile(path);
	if (bytes.byteLength > 8 * 1024 * 1024) {
		throw new Error("Generated material JSON exceeds 8 MiB.");
	}
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		throw new Error(`Generated material JSON is malformed: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).customType !== "BABYLON.PBRMaterial") {
		throw new Error("Generated material artifacts must serialize a Babylon PBRMaterial.");
	}
	return {
		kind: "material",
		customType: "BABYLON.PBRMaterial",
		name: typeof (value as Record<string, unknown>).name === "string" ? (value as Record<string, unknown>).name : null,
	};
}

async function inspectAnimation(path: string, request: IGenerativeAssetRequest): Promise<Record<string, unknown>> {
	if (request.options.modality !== "animation") {
		throw new Error("Animation artifacts are valid only for animation generation jobs.");
	}
	const bytes = await readFile(path);
	if (bytes.byteLength > 64 * 1024 * 1024) {
		throw new Error("Generated animation JSON exceeds 64 MiB.");
	}
	const executed = executeAnimationImporterSource(
		bytes.toString("utf8"),
		path,
		normalizeAnimationImporterSettings({
			resampleCurves: true,
			resampleRate: request.options.value.framesPerSecond,
			compression: "none",
			loopByDefault: request.options.value.loop,
		})
	);
	if (executed.errors.length || (!executed.clips.length && !executed.tracks.length)) {
		throw new Error(`Generated animation is not executable: ${executed.errors.join(" ") || "no clips or tracks were found"}.`);
	}
	const durations = [...executed.clips.map((clip) => clip.durationSeconds), ...executed.tracks.map((track) => track.durationSeconds)];
	const durationSeconds = Math.max(...durations);
	const tolerance = Math.max(0.1, 2 / request.options.value.framesPerSecond);
	if (Math.abs(durationSeconds - request.options.value.durationSeconds) > tolerance) {
		throw new Error(`Generated animation duration ${durationSeconds} does not match requested ${request.options.value.durationSeconds} seconds within ${tolerance} seconds.`);
	}
	return {
		kind: "animation",
		sourceKind: executed.sourceKind,
		outputFormat: executed.outputFormat,
		durationSeconds,
		clipCount: executed.clips.length,
		trackCount: executed.tracks.length,
		keyCount: executed.outputKeyCount,
		loop: request.options.value.loop,
	};
}

async function inspectAudio(path: string, request: IGenerativeAssetRequest, editor: Editor): Promise<Record<string, unknown>> {
	const ffprobe = await resolveMediaExecutable(editor, "ffprobe");
	const probe = parseAudioProbe(JSON.parse(await runMediaProcess(ffprobe, createAudioProbeArguments(path), 256 * 1024)));
	if (!probe.codec || !probe.durationSeconds || !probe.sampleRate || !probe.channels) {
		throw new Error(`Generated audio ${basename(path)} has no decodable audio stream.`);
	}
	if (request.options.modality === "audio") {
		const tolerance = Math.max(0.1, 2 / request.options.value.sampleRate);
		if (Math.abs(probe.durationSeconds - request.options.value.durationSeconds) > tolerance) {
			throw new Error(
				`Generated audio duration ${probe.durationSeconds} does not match requested ${request.options.value.durationSeconds} seconds within ${tolerance} seconds.`
			);
		}
		if (probe.sampleRate !== request.options.value.sampleRate || probe.channels !== request.options.value.channels) {
			throw new Error(
				`Generated audio is ${probe.sampleRate} Hz/${probe.channels} channel(s); requested ${request.options.value.sampleRate} Hz/${request.options.value.channels} channel(s).`
			);
		}
	}
	return { kind: "audio", ...probe };
}

async function inspectVideo(path: string, editor: Editor): Promise<Record<string, unknown>> {
	const ffprobe = await resolveMediaExecutable(editor, "ffprobe");
	const output = await runMediaProcess(
		ffprobe,
		["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,r_frame_rate:format=format_name,duration", "-of", "json", path],
		256 * 1024
	);
	const data = JSON.parse(output);
	const stream = Array.isArray(data.streams) ? data.streams[0] : null;
	const durationSeconds = Number(data.format?.duration);
	if (
		!stream?.codec_name ||
		!Number.isFinite(durationSeconds) ||
		durationSeconds <= 0 ||
		!Number.isSafeInteger(Number(stream.width)) ||
		!Number.isSafeInteger(Number(stream.height))
	) {
		throw new Error(`Generated video ${basename(path)} has no valid video stream.`);
	}
	return { kind: "video", codec: stream.codec_name, width: Number(stream.width), height: Number(stream.height), frameRate: stream.r_frame_rate ?? null, durationSeconds };
}

async function inspectMetadata(path: string): Promise<Record<string, unknown>> {
	const bytes = await readFile(path);
	if (bytes.byteLength > 1024 * 1024) {
		throw new Error("Generated metadata JSON exceeds 1 MiB.");
	}
	const value = JSON.parse(bytes.toString("utf8"));
	if (!value || typeof value !== "object") {
		throw new Error("Generated metadata must be a JSON object or array.");
	}
	return { kind: "metadata", serializedBytes: bytes.byteLength };
}

async function inspectArtifact(path: string, role: GenerativeArtifactRole, request: IGenerativeAssetRequest, editor: Editor): Promise<Record<string, unknown>> {
	if (imageRole(role)) {
		return inspectImage(path, role, request);
	}
	if (role === "material") {
		return inspectMaterial(path);
	}
	if (role === "animation") {
		return inspectAnimation(path, request);
	}
	if (role === "audio" || role === "preview-audio") {
		return inspectAudio(path, request, editor);
	}
	if (role === "preview-video" || role === "source-video") {
		return inspectVideo(path, editor);
	}
	return inspectMetadata(path);
}

async function createImagePreview(source: string, previewPath: string): Promise<void> {
	await sharp(source, { animated: false, limitInputPixels: maximumImagePixels })
		.rotate()
		.resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
		.jpeg({ quality: 82 })
		.toFile(previewPath);
}

/** Uses PCM WAV so preview generation does not depend on optional patented/third-party encoder availability. */
async function createAudioPreview(source: string, previewPath: string, editor: Editor): Promise<void> {
	const ffmpeg = await resolveMediaExecutable(editor, "ffmpeg");
	await runMediaProcess(ffmpeg, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-nostdin",
		"-y",
		"-i",
		source,
		"-t",
		"20",
		"-map_metadata",
		"-1",
		"-vn",
		"-ac",
		"2",
		"-ar",
		"44100",
		"-c:a",
		"pcm_s16le",
		previewPath,
	]);
}

async function createPreview(jobRoot: string, outputRoot: string, candidate: IValidatedGenerativeCandidate, editor: Editor): Promise<IValidatedGenerativePreview | null> {
	const explicit = candidate.artifacts.find((artifact) => ["preview-image", "preview-audio", "preview-video"].includes(artifact.role));
	if (explicit && explicit.sizeBytes <= maximumPreviewBytes) {
		return { path: `output/${explicit.path}`, mediaType: explicit.mediaType, sha256: explicit.sha256, sizeBytes: explicit.sizeBytes };
	}
	const image = candidate.artifacts.find((artifact) => imageRole(artifact.role));
	const audio = candidate.artifacts.find((artifact) => artifact.role === "audio");
	if (!image && !audio) {
		return null;
	}
	const previewDirectory = join(jobRoot, "previews");
	await ensureDir(previewDirectory);
	const extension = image ? ".jpg" : ".wav";
	const previewPath = join(previewDirectory, `${candidate.id}${extension}`);
	if (image) {
		await createImagePreview(join(outputRoot, image.path), previewPath);
	} else {
		await createAudioPreview(join(outputRoot, audio!.path), previewPath, editor);
	}
	const bytes = await readFile(previewPath);
	if (!bytes.byteLength || bytes.byteLength > maximumPreviewBytes) {
		await remove(previewPath).catch(() => undefined);
		return null;
	}
	return { path: `previews/${basename(previewPath)}`, mediaType: image ? "image/jpeg" : "audio/wav", sha256: sha256(bytes), sizeBytes: bytes.byteLength };
}

/** Decodes, probes, fingerprints, and strictly reconciles every staged file with the provider manifest. */
export async function validateGenerativeProviderOutput(
	jobRoot: string,
	outputRoot: string,
	result: IGenerativeAssetProviderResult,
	request: IGenerativeAssetRequest,
	maximumOutputBytes: number,
	editorOrOptions: Editor | IGenerativeOutputValidationOptions
): Promise<IValidatedGenerativeResult> {
	const editor = "editor" in editorOrOptions && "createPreviews" in editorOrOptions ? editorOrOptions.editor : editorOrOptions;
	const createPreviews = "editor" in editorOrOptions && "createPreviews" in editorOrOptions ? editorOrOptions.createPreviews : true;
	const files = await discoverFiles(outputRoot);
	const declared = new Set<string>(["result.json"]);
	const globalArtifactPaths = new Set<string>();
	let outputBytes = 0;
	const candidates: IValidatedGenerativeCandidate[] = [];
	for (const candidate of result.candidates) {
		const artifacts: IValidatedGenerativeArtifact[] = [];
		for (const artifact of candidate.artifacts) {
			const key = artifact.path.toLocaleLowerCase("en-US");
			if (globalArtifactPaths.has(key)) {
				throw new Error(`Generative candidates cannot share artifact path ${artifact.path}.`);
			}
			globalArtifactPaths.add(key);
			declared.add(artifact.path);
			const file = files.get(artifact.path);
			if (!file || file.sizeBytes <= 0) {
				throw new Error(`Generative provider did not publish declared artifact ${artifact.path}.`);
			}
			const allowedMediaTypes = expectedMediaType(artifact.path, artifact.role);
			if (!allowedMediaTypes.includes(artifact.mediaType)) {
				throw new Error(`Generative artifact ${artifact.path} role ${artifact.role} does not support media type ${artifact.mediaType} or its file extension.`);
			}
			outputBytes += file.sizeBytes;
			if (outputBytes > maximumOutputBytes) {
				throw new Error(`Generative provider output exceeds the ${maximumOutputBytes}-byte limit.`);
			}
			const bytes = await readFile(file.absolutePath);
			const inspection = await inspectArtifact(file.absolutePath, artifact.role, request, editor);
			artifacts.push({
				path: artifact.path,
				role: artifact.role,
				mediaType: artifact.mediaType,
				displayName: artifact.displayName,
				sha256: sha256(bytes),
				sizeBytes: bytes.byteLength,
				inspection,
			});
		}
		const validated: IValidatedGenerativeCandidate = {
			id: candidate.id,
			reportedModel: candidate.reportedModel,
			reportedSeed: candidate.reportedSeed,
			providerRequestId: candidate.providerRequestId,
			warnings: [...candidate.warnings],
			artifacts,
			preview: null,
		};
		validated.preview = createPreviews ? await createPreview(jobRoot, outputRoot, validated, editor) : null;
		candidates.push(validated);
	}
	const extras = [...files.keys()].filter((path) => !declared.has(path));
	if (extras.length) {
		throw new Error(`Generative provider output contains undeclared files: ${extras.slice(0, 16).join(", ")}.`);
	}
	const resultFingerprint = createHash("sha256")
		.update(
			JSON.stringify(
				candidates.map((candidate) => ({
					id: candidate.id,
					model: candidate.reportedModel,
					seed: candidate.reportedSeed,
					artifacts: candidate.artifacts.map((artifact) => ({
						path: artifact.path,
						role: artifact.role,
						mediaType: artifact.mediaType,
						sha256: artifact.sha256,
						sizeBytes: artifact.sizeBytes,
					})),
				}))
			)
		)
		.digest("hex");
	return { result, candidates, resultFingerprint, outputBytes };
}

/** Reads and bounds an executable adapter's result manifest before inline bytes are materialized. */
export async function readGenerativeProviderResultManifest(path: string): Promise<unknown> {
	const details = await lstat(path);
	if (details.isSymbolicLink() || !details.isFile() || details.size <= 0 || details.size > maximumResultManifestBytes) {
		throw new Error("Generative provider result.json must be a non-empty non-symlink regular file no larger than 1 MiB.");
	}
	return JSON.parse(await readFile(path, "utf8"));
}
