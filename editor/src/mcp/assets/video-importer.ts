import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { createReadStream } from "fs";
import { basename, dirname, extname, join } from "path/posix";
import { copyFile, ensureDir, move, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";

import {
	createVideoProbeArguments,
	createVideoTranscodeArguments,
	IVideoImporterSettings,
	IVideoImportProbe,
	IVideoImportResult,
	normalizeVideoImporterSettings,
	parseVideoProbe,
	videoImporterOutputExtension,
	videoImportRequiresTranscode,
} from "babylonjs-editor-tools";

import { Editor } from "../../editor/main";
import { projectConfiguration } from "../../project/configuration";
import { readAssetMetadata } from "./registry";

export interface IVideoImporterArtifactStatus {
	path: string;
	artifactPath: string;
	manifestPath: string;
	fingerprint: string;
	current: boolean;
	exists: boolean;
	result: IVideoImportResult | null;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function executableName(name: "ffmpeg" | "ffprobe"): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

async function resolveMediaExecutable(editor: Editor | undefined, name: "ffmpeg" | "ffprobe"): Promise<string> {
	const environment = process.env[name === "ffmpeg" ? "BABYLONJS_EDITOR_FFMPEG_PATH" : "BABYLONJS_EDITOR_FFPROBE_PATH"];
	const candidates = [environment, editor?.path ? join(editor.path, process.env.DEBUG ? "bin" : "../../bin", executableName(name)) : null, executableName(name)].filter(
		(candidate): candidate is string => Boolean(candidate)
	);
	for (const candidate of candidates) {
		if (!candidate.includes("/") || (await pathExists(candidate))) {
			return candidate;
		}
	}
	throw new Error(`${name} is unavailable. Install it or set ${name === "ffmpeg" ? "BABYLONJS_EDITOR_FFMPEG_PATH" : "BABYLONJS_EDITOR_FFPROBE_PATH"}.`);
}

async function runProcess(command: string, args: string[], maximumOutputBytes = 2 * 1024 * 1024): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, { shell: false, windowsHide: true });
		const output: Buffer[] = [];
		const errors: Buffer[] = [];
		let bytes = 0;
		const collect = (target: Buffer[], value: Buffer): void => {
			bytes += value.length;
			if (bytes <= maximumOutputBytes) {
				target.push(value);
			}
		};
		child.stdout.on("data", (value: Buffer) => collect(output, value));
		child.stderr.on("data", (value: Buffer) => collect(errors, value));
		child.on("error", (error) => reject(new Error(`Failed to start ${command}: ${error.message}`)));
		child.on("close", (code) => {
			if (code === 0 && bytes <= maximumOutputBytes) {
				resolve(Buffer.concat(output).toString("utf-8"));
			} else {
				const message = Buffer.concat(errors).toString("utf-8").trim().slice(0, 4096);
				reject(
					new Error(
						bytes > maximumOutputBytes ? `${command} output exceeded the 2 MiB diagnostic limit.` : `${command} exited with code ${code}: ${message || "no diagnostic"}`
					)
				);
			}
		});
	});
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
		return parseVideoProbe(JSON.parse(await runProcess(executable, createVideoProbeArguments(path))));
	} catch (error) {
		if (error instanceof Error && !error.message.startsWith("Unexpected token")) {
			throw error;
		}
		throw new Error("ffprobe returned malformed JSON.");
	}
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
export async function getVideoImporterArtifactStatus(path: string): Promise<IVideoImporterArtifactStatus> {
	const metadata = await readAssetMetadata(path);
	if (metadata.importer.kind !== "video") {
		throw new Error("Video importer artifacts are only available for video assets.");
	}
	const settings = normalizeVideoImporterSettings(metadata.importer.settings);
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
	return { path, artifactPath, manifestPath, fingerprint, current: exists && result !== null, exists, result };
}

/** Applies one exact-fingerprint video importer and atomically publishes its project-local preview artifact. */
export async function applyVideoImporterArtifact(path: string, expectedFingerprint: string, editor?: Editor): Promise<IVideoImporterArtifactStatus> {
	const status = await getVideoImporterArtifactStatus(path);
	if (status.fingerprint !== expectedFingerprint) {
		throw new Error(`Video importer plan changed. Inspect again and use current fingerprint ${status.fingerprint}.`);
	}
	const metadata = await readAssetMetadata(path);
	const settings = normalizeVideoImporterSettings(metadata.importer.settings);
	const sourceDetails = await stat(path);
	const source = await probeVideo(path, editor);
	const temporary = `${status.artifactPath}.${randomUUID()}.tmp${extname(status.artifactPath)}`;
	await ensureDir(dirname(status.artifactPath));
	try {
		const transcoded = videoImportRequiresTranscode(settings, source);
		if (transcoded) {
			await runProcess(await resolveMediaExecutable(editor, "ffmpeg"), createVideoTranscodeArguments(path, temporary, settings, source));
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
		};
		await move(temporary, status.artifactPath, { overwrite: true });
		await writeJSON(status.manifestPath, { version: 1, fingerprint: status.fingerprint, generatedAt: new Date().toISOString(), result }, { spaces: "\t" });
		return { ...status, current: true, exists: true, result };
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
}

/** Processes a video file into a build destination and returns the actual output path plus probe evidence. */
export async function processVideoImporterOutput(sourcePath: string, requestedOutputPath: string, settings: IVideoImporterSettings, editor?: Editor): Promise<IVideoImportResult> {
	const source = await probeVideo(sourcePath, editor);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${videoImporterOutputExtension(sourcePath, settings)}`);
	const temporary = `${outputPath}.${randomUUID()}.tmp${extname(outputPath)}`;
	const sourceDetails = await stat(sourcePath);
	try {
		const transcoded = videoImportRequiresTranscode(settings, source);
		if (transcoded) {
			await runProcess(await resolveMediaExecutable(editor, "ffmpeg"), createVideoTranscodeArguments(sourcePath, temporary, settings, source));
		} else {
			await copyFile(sourcePath, temporary);
		}
		const output = await probeVideo(temporary, editor);
		const outputDetails = await stat(temporary);
		await move(temporary, outputPath, { overwrite: true });
		return { sourcePath, outputPath, transcoded, settings, source, output, sourceBytes: sourceDetails.size, outputBytes: outputDetails.size };
	} catch (error) {
		await remove(temporary).catch(() => undefined);
		throw error;
	}
}
