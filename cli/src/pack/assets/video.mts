import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, dirname, extname, join } from "node:path/posix";

import fs from "fs-extra";
import {
	createVideoProbeArguments,
	createVideoTranscodeArguments,
	IVideoImporterSettings,
	IVideoImportProbe,
	IVideoImportResult,
	parseVideoProbe,
	videoImporterOutputExtension,
	videoImportRequiresTranscode,
} from "babylonjs-editor-tools";

function executable(name: "ffmpeg" | "ffprobe"): string {
	const environment = process.env[name === "ffmpeg" ? "BABYLONJS_EDITOR_FFMPEG_PATH" : "BABYLONJS_EDITOR_FFPROBE_PATH"];
	return environment || (process.platform === "win32" ? `${name}.exe` : name);
}

async function run(command: string, args: string[]): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, { shell: false, windowsHide: true });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		const collect = (target: Buffer[], value: Buffer): void => {
			bytes += value.length;
			if (bytes <= 2 * 1024 * 1024) {
				target.push(value);
			}
		};
		child.stdout.on("data", (value: Buffer) => collect(stdout, value));
		child.stderr.on("data", (value: Buffer) => collect(stderr, value));
		child.on("error", (error) => reject(new Error(`Failed to start ${command}: ${error.message}`)));
		child.on("close", (code) => {
			if (code === 0 && bytes <= 2 * 1024 * 1024) {
				resolve(Buffer.concat(stdout).toString("utf-8"));
			} else {
				reject(
					new Error(
						bytes > 2 * 1024 * 1024
							? `${command} output exceeded 2 MiB.`
							: `${command} exited with code ${code}: ${Buffer.concat(stderr).toString("utf-8").slice(0, 4096)}`
					)
				);
			}
		});
	});
}

async function probe(path: string): Promise<IVideoImportProbe> {
	return parseVideoProbe(JSON.parse(await run(executable("ffprobe"), createVideoProbeArguments(path))));
}

/** Applies the video importer during CLI packing and returns probe evidence for the runtime sidecar. */
export async function processExportedVideo(sourcePath: string, requestedOutputPath: string, settings: IVideoImporterSettings): Promise<IVideoImportResult> {
	const source = await probe(sourcePath);
	const outputPath = join(dirname(requestedOutputPath), `${basename(requestedOutputPath, extname(requestedOutputPath))}${videoImporterOutputExtension(sourcePath, settings)}`);
	const temporary = `${outputPath}.${randomUUID()}.tmp${extname(outputPath)}`;
	const sourceDetails = await fs.stat(sourcePath);
	try {
		const transcoded = videoImportRequiresTranscode(settings, source);
		if (transcoded) {
			await run(executable("ffmpeg"), createVideoTranscodeArguments(sourcePath, temporary, settings, source));
		} else {
			await fs.copyFile(sourcePath, temporary);
		}
		const output = await probe(temporary);
		const outputDetails = await fs.stat(temporary);
		await fs.move(temporary, outputPath, { overwrite: true });
		return { sourcePath, outputPath, transcoded, settings, source, output, sourceBytes: sourceDetails.size, outputBytes: outputDetails.size };
	} catch (error) {
		await fs.remove(temporary).catch(() => undefined);
		throw error;
	}
}
