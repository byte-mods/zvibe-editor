import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { basename, dirname, join } from "path/posix";
import { copyFile, ensureDir, move, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";

import {
	audioImportRequiresTranscode,
	createAudioProbeArguments,
	createAudioTranscodeArguments,
	IAudioImporterSettings,
	IAudioImportProbe,
	IAudioImportResult,
	normalizeAudioImporterSettings,
	parseAudioProbe,
} from "babylonjs-editor-tools";

import { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { applyImporterArtifactWithAccelerator } from "./import-accelerator";
import { resolveMediaExecutable, runMediaProcess } from "./media-executables";
import { readAssetMetadata } from "./registry";

export interface IAudioImporterArtifactStatus {
	path: string;
	artifactPath: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IAudioImportResult | null;
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

async function probeAudio(path: string, editor?: Editor): Promise<IAudioImportProbe> {
	const executable = await resolveMediaExecutable(editor, "ffprobe");
	const output = await runMediaProcess(executable, createAudioProbeArguments(path));
	try {
		return parseAudioProbe(JSON.parse(output));
	} catch {
		throw new Error("ffprobe returned malformed JSON.");
	}
}

async function audioImporterFingerprint(path: string, settings: IAudioImporterSettings): Promise<string> {
	return createHash("sha256")
		.update(await contentHash(path))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
}

async function artifactPaths(path: string): Promise<{ artifactPath: string; manifestPath: string }> {
	const metadata = await readAssetMetadata(path);
	const directory = join(projectDirectory(), ".bjseditor/imported-assets", metadata.guid);
	return { artifactPath: join(directory, basename(path)), manifestPath: join(directory, "audio-import.json") };
}

/** Inspects whether the deterministic imported audio artifact matches the source and effective importer settings. */
export async function getAudioImporterArtifactStatus(path: string): Promise<IAudioImporterArtifactStatus> {
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "audio") {
		throw new Error("Audio importer artifacts are only available for audio assets.");
	}
	const settings = normalizeAudioImporterSettings(metadata.importer.settings);
	const fingerprint = await audioImporterFingerprint(path, settings);
	const { artifactPath, manifestPath } = await artifactPaths(path);
	let result: IAudioImportResult | null = null;
	try {
		const manifest = await readJSON(manifestPath);
		if (manifest?.fingerprint === fingerprint && manifest?.result) {
			result = manifest.result as IAudioImportResult;
		}
	} catch {
		// A missing or malformed manifest makes the artifact stale.
	}
	const exists = await pathExists(artifactPath);
	return { path, artifactPath, manifestPath, fingerprint, current: exists && result !== null, exists, result };
}

/** Applies one exact-fingerprint audio importer and atomically publishes its project-local preview artifact. */
export async function applyAudioImporterArtifact(path: string, expectedFingerprint: string, editor?: Editor): Promise<IAudioImporterArtifactStatus> {
	return applyImporterArtifactWithAccelerator({
		kind: "audio",
		sourcePath: path,
		expectedFingerprint,
		inspect: () => getAudioImporterArtifactStatus(path),
		applyLocal: () => applyAudioImporterArtifactLocally(path, expectedFingerprint, editor),
	});
}

async function applyAudioImporterArtifactLocally(path: string, expectedFingerprint: string, editor?: Editor): Promise<IAudioImporterArtifactStatus> {
	const status = await getAudioImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Audio importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeAudioImporterSettings(metadata.importer.settings);
	const sourceDetails = await stat(path);
	const source = await probeAudio(path, editor);
	const temporary = `${status.artifactPath}.${randomUUID()}.tmp${basename(path).match(/(\.[^.]+)$/)?.[1] ?? ""}`;
	await ensureDir(dirname(status.artifactPath));
	try {
		if (audioImportRequiresTranscode(settings)) {
			const executable = await resolveMediaExecutable(editor, "ffmpeg");
			await runMediaProcess(executable, createAudioTranscodeArguments(path, temporary, settings, source));
		} else {
			await copyFile(path, temporary);
		}
		const output = await probeAudio(temporary, editor);
		const outputDetails = await stat(temporary);
		const result: IAudioImportResult = {
			sourcePath: path,
			outputPath: status.artifactPath,
			transcoded: audioImportRequiresTranscode(settings),
			settings,
			source,
			output,
			sourceBytes: sourceDetails.size,
			outputBytes: outputDetails.size,
		};
		await move(temporary, status.artifactPath, { overwrite: true });
		await writeJSON(status.manifestPath, { version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, { spaces: "\t" });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
}

/** Processes an audio file directly into an export/build destination using the same importer semantics. */
export async function processAudioImporterOutput(sourcePath: string, outputPath: string, settings: IAudioImporterSettings, editor?: Editor): Promise<IAudioImportResult> {
	const sourceDetails = await stat(sourcePath);
	const source = await probeAudio(sourcePath, editor);
	const temporary = `${outputPath}.${randomUUID()}.tmp${basename(outputPath).match(/(\.[^.]+)$/)?.[1] ?? ""}`;
	try {
		if (audioImportRequiresTranscode(settings)) {
			const executable = await resolveMediaExecutable(editor, "ffmpeg");
			await runMediaProcess(executable, createAudioTranscodeArguments(sourcePath, temporary, settings, source));
		} else {
			await copyFile(sourcePath, temporary);
		}
		const output = await probeAudio(temporary, editor);
		const outputDetails = await stat(temporary);
		await move(temporary, outputPath, { overwrite: true });
		return {
			sourcePath,
			outputPath,
			transcoded: audioImportRequiresTranscode(settings),
			settings,
			source,
			output,
			sourceBytes: sourceDetails.size,
			outputBytes: outputDetails.size,
		};
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
}
