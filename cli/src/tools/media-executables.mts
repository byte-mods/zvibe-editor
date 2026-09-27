import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.filename);

/**
 * Resolves FFmpeg/FFprobe for audio and video export: an explicit BABYLONJS_EDITOR_FFMPEG_PATH / BABYLONJS_EDITOR_FFPROBE_PATH
 * (set by the editor to its bundled binaries), then the binaries from the optional "ffmpeg-static" and
 * "@ffprobe-installer/ffprobe" dependencies, then the executable on PATH.
 */
export function resolveMediaExecutable(name: "ffmpeg" | "ffprobe"): string {
	const environment = process.env[name === "ffmpeg" ? "BABYLONJS_EDITOR_FFMPEG_PATH" : "BABYLONJS_EDITOR_FFPROBE_PATH"];
	if (environment) {
		return environment;
	}

	try {
		const bundled: string | null = name === "ffmpeg" ? require("ffmpeg-static") : require("@ffprobe-installer/ffprobe").path;
		if (bundled && existsSync(bundled)) {
			return bundled;
		}
	} catch {
		// Optional dependency not installed for this platform: fall back to PATH.
	}

	return process.platform === "win32" ? `${name}.exe` : name;
}
