import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path/posix";
import { join as joinNativePath } from "path";

import { pathExists } from "fs-extra";

import { Editor } from "../../editor/main";

/** Returns the platform-native executable filename without invoking a shell. */
function executableName(name: "ffmpeg" | "ffprobe"): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

function environmentVariable(name: "ffmpeg" | "ffprobe"): string {
	return name === "ffmpeg" ? "BABYLONJS_EDITOR_FFMPEG_PATH" : "BABYLONJS_EDITOR_FFPROBE_PATH";
}

/**
 * Points the media environment variables at the FFmpeg/FFprobe binaries shipped in the editor's "bin" folder (copied there
 * by postinstall and packaged as extra files), unless the user already set them. The export pipeline from
 * babylonjs-editor-cli runs in this process and reads the same variables, so audio/video export works without a system FFmpeg.
 * @param editorPath defines the editor's application path.
 */
export function configureBundledMediaExecutables(editorPath: string): void {
	for (const name of ["ffmpeg", "ffprobe"] as const) {
		const variable = environmentVariable(name);
		if (process.env[variable]) {
			continue;
		}
		const bundled = joinNativePath(editorPath, process.env.DEBUG ? "bin" : "../../bin", executableName(name));
		if (existsSync(bundled)) {
			process.env[variable] = bundled;
		}
	}
}

/** Resolves an explicit environment path, packaged editor binary, or PATH executable in that order. */
export async function resolveMediaExecutable(editor: Editor | undefined, name: "ffmpeg" | "ffprobe"): Promise<string> {
	const environment = process.env[environmentVariable(name)];
	const candidates = [environment, editor?.path ? join(editor.path, process.env.DEBUG ? "bin" : "../../bin", executableName(name)) : null, executableName(name)].filter(
		(candidate): candidate is string => Boolean(candidate)
	);
	for (const candidate of candidates) {
		if (!candidate.includes("/") || (await pathExists(candidate))) {
			return candidate;
		}
	}
	throw new Error(`${name} is unavailable. Install it or set ${environmentVariable(name)}.`);
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
