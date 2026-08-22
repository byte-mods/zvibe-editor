import { spawn } from "child_process";
import { join } from "path/posix";

import { pathExists } from "fs-extra";

import { Editor } from "../../editor/main";

/** Returns the platform-native executable filename without invoking a shell. */
function executableName(name: "ffmpeg" | "ffprobe"): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

/** Resolves an explicit environment path, packaged editor binary, or PATH executable in that order. */
export async function resolveMediaExecutable(editor: Editor | undefined, name: "ffmpeg" | "ffprobe"): Promise<string> {
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

/** Executes a media tool with a closed argv array and bounded captured diagnostics. */
export async function runMediaProcess(command: string, args: string[], maximumOutputBytes = 2 * 1024 * 1024): Promise<string> {
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
