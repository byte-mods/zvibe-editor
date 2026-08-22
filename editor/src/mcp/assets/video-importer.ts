import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, extname, join } from "path/posix";
import { copyFile, ensureDir, move, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";

import {
	createVideoProbeArguments,
	createVideoEncoderListArguments,
	createVideoTranscodeArguments,
	evaluateImportedVideoCompatibility,
	IVideoImporterSettings,
	IVideoEncoderCapabilities,
	IVideoEncoderSelection,
	IVideoImportProbe,
	IVideoImportResult,
	normalizeVideoImporterSettings,
	parseVideoEncoderCapabilities,
	parseVideoProbe,
	resolveVideoCodec,
	resolveVideoImporterPlatformSettings,
	selectVideoEncoder,
	VideoImporterPlatform,
	videoImporterOutputExtension,
	videoImportRequiresTranscode,
} from "babylonjs-editor-tools";

import { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { applyImporterArtifactWithAccelerator } from "./import-accelerator";
import { resolveMediaExecutable, runMediaProcess } from "./media-executables";
import { readAssetMetadata } from "./registry";

export interface IVideoImporterArtifactStatus {
	path: string;
	artifactPath: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IVideoImportResult | null;
	platform: VideoImporterPlatform;
	overrideApplied: boolean;
	settings: IVideoImporterSettings;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

async function contentHash(path: string): Promise<string> {
	const hash = createHash("sha256");
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", resolve);
	});
	return hash.digest("hex");
}

async function probeVideo(path: string, editor?: Editor): Promise<IVideoImportProbe> {
	const executable = await resolveMediaExecutable(editor, "ffprobe");
	try {
		return parseVideoProbe(JSON.parse(await runMediaProcess(executable, createVideoProbeArguments(path))));
	} catch (error) {
		if (error instanceof Error && !error.message.startsWith("Unexpected token")) {
			throw error;
		}
		throw new Error("ffprobe returned malformed JSON.");
	}
}

/** Lists exact FFmpeg encoder names and the logical backends this installation can expose. */
export async function getVideoEncoderCapabilities(editor?: Editor): Promise<IVideoEncoderCapabilities> {
	const executable = await resolveMediaExecutable(editor, "ffmpeg");
	return parseVideoEncoderCapabilities(await runMediaProcess(executable, createVideoEncoderListArguments()));
}

async function transcodeVideo(
	sourcePath: string,
	outputPath: string,
	settings: IVideoImporterSettings,
	source: IVideoImportProbe,
	editor?: Editor
): Promise<IVideoEncoderSelection> {
	const executable = await resolveMediaExecutable(editor, "ffmpeg");
	const capabilities = await getVideoEncoderCapabilities(editor);
	const selection = selectVideoEncoder(resolveVideoCodec(sourcePath, settings, source), settings.encoder, capabilities);
	await runMediaProcess(executable, createVideoTranscodeArguments(sourcePath, outputPath, settings, source, selection));
	return selection;
}

async function videoImporterFingerprint(path: string, settings: IVideoImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await contentHash(path))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

async function artifactPaths(path: string, settings: IVideoImporterSettings): Promise<{ artifactPath: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const directory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	const extension = videoImporterOutputExtension(path, settings);
	return {
		artifactPath: join(directory, `${basename(path, extname(path))}${extension}`),
		manifestPath: join(directory, "video-import.json"),
	};
}

/** Inspects whether the deterministic imported video artifact matches the source and effective importer settings. */
export async function getVideoImporterArtifactStatus(path: string, requestedPlatform: unknown = "default"): Promise<IVideoImporterArtifactStatus> {
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "video") {
		throw new Error("Video importer artifacts are only available for video assets.");
	}
	const resolved = resolveVideoImporterPlatformSettings(normalizeVideoImporterSettings(metadata.importer.settings), requestedPlatform);
	const settings = resolved.settings;
	const fingerprint = await videoImporterFingerprint(path, settings);
	const { artifactPath, manifestPath } = await artifactPaths(path, settings);
	let result: IVideoImportResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.fingerprint === fingerprint && manifest?.result) {
			result = manifest.result as IVideoImportResult;
		}
	} catch {
		// A missing or malformed manifest makes the artifact stale.
	}
	const exists = await pathExists(artifactPath);
	return {
		path,
		artifactPath,
		manifestPath,
		fingerprint,
		current: exists && result !== null,
		exists,
		result,
		platform: resolved.platform,
		overrideApplied: resolved.overrideApplied,
		settings,
	};
}

/** Applies one exact-fingerprint video importer and atomically publishes its project-local preview artifact. */
export async function applyVideoImporterArtifact(
	path: string,
	expectedFingerprint: string,
	editor?: Editor,
	requestedPlatform: unknown = "default"
): Promise<IVideoImporterArtifactStatus> {
	return applyImporterArtifactWithAccelerator({
		kind: "video",
		sourcePath: path,
		expectedFingerprint,
		platform: String(requestedPlatform),
		inspect: () => getVideoImporterArtifactStatus(path, requestedPlatform),
		applyLocal: () => applyVideoImporterArtifactLocally(path, expectedFingerprint, editor, requestedPlatform),
	});
}

async function applyVideoImporterArtifactLocally(
	path: string,
	expectedFingerprint: string,
	editor?: Editor,
	requestedPlatform: unknown = "default"
): Promise<IVideoImporterArtifactStatus> {
	const status = await getVideoImporterArtifactStatus(path, requestedPlatform);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Video importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const settings = status.settings;
	const sourceDetails = await stat(path);
	const source = await probeVideo(path, editor);
	const temporary = `${status.artifactPath}.${randomUUID()}.tmp${extname(status.artifactPath)}`;
	await ensureDir(dirname(status.artifactPath));
	try {
		const transcoded = videoImportRequiresTranscode(settings, source);
		let encoder: IVideoEncoderSelection | null = null;
		if (transcoded) {
			encoder = await transcodeVideo(path, temporary, settings, source, editor);
		} else {
			await copyFile(path, temporary);
		}
		const output = await probeVideo(temporary, editor);
		const outputDetails = await stat(temporary);
		const result: IVideoImportResult = {
			sourcePath: path,
			outputPath: status.artifactPath,
			transcoded,
			settings,
			source,
			output,
			sourceBytes: sourceDetails.size,
			outputBytes: outputDetails.size,
			platform: status.platform,
			compatibility: evaluateImportedVideoCompatibility(output, status.platform),
			encoder,
		};
		await move(temporary, status.artifactPath, { overwrite: true });
		await writeJSON(status.manifestPath, { version: 2, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, { spaces: "\t" });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
}

/** Processes a video file into a build destination and returns the actual output path plus probe evidence. */
export async function processVideoImporterOutput(
	sourcePath: string,
	requestedOutputPath: string,
	baseSettings: IVideoImporterSettings,
	editor?: Editor,
	requestedPlatform: unknown = "default"
): Promise<IVideoImportResult> {
	const resolved = resolveVideoImporterPlatformSettings(baseSettings, requestedPlatform);
	const settings = resolved.settings;
	const source = await probeVideo(sourcePath, editor);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${videoImporterOutputExtension(sourcePath, settings)}`);
	const temporary = `${outputPath}.${randomUUID()}.tmp${extname(outputPath)}`;
	const sourceDetails = await stat(sourcePath);
	try {
		const transcoded = videoImportRequiresTranscode(settings, source);
		let encoder: IVideoEncoderSelection | null = null;
		if (transcoded) {
			encoder = await transcodeVideo(sourcePath, temporary, settings, source, editor);
		} else {
			await copyFile(sourcePath, temporary);
		}
		const output = await probeVideo(temporary, editor);
		const outputDetails = await stat(temporary);
		await move(temporary, outputPath, { overwrite: true });
		return {
			sourcePath,
			outputPath,
			transcoded,
			settings,
			source,
			output,
			sourceBytes: sourceDetails.size,
			outputBytes: outputDetails.size,
			platform: resolved.platform,
			compatibility: evaluateImportedVideoCompatibility(output, resolved.platform),
			encoder,
		};
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
}
