import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { tmpdir } from "os";
import { join } from "path";
import { chmod, mkdtemp, mkdir, remove, writeFile } from "fs-extra";

import { configureBundledMediaExecutables } from "../../src/mcp/assets/media-executables";

describe("configureBundledMediaExecutables", () => {
	let editorPath: string;

	beforeEach(async () => {
		editorPath = await mkdtemp(join(tmpdir(), "zvibe-media-"));
		vi.stubEnv("DEBUG", "true");
		vi.stubEnv("BABYLONJS_EDITOR_FFMPEG_PATH", "");
		vi.stubEnv("BABYLONJS_EDITOR_FFPROBE_PATH", "");
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await remove(editorPath);
	});

	test("points the export pipeline at the FFmpeg/FFprobe binaries shipped in the editor's bin folder", async () => {
		const suffix = process.platform === "win32" ? ".exe" : "";
		await mkdir(join(editorPath, "bin"));
		for (const name of ["ffmpeg", "ffprobe"]) {
			await writeFile(join(editorPath, "bin", `${name}${suffix}`), "");
			await chmod(join(editorPath, "bin", `${name}${suffix}`), 0o755);
		}

		configureBundledMediaExecutables(editorPath);

		expect(process.env.BABYLONJS_EDITOR_FFMPEG_PATH).toBe(join(editorPath, "bin", `ffmpeg${suffix}`));
		expect(process.env.BABYLONJS_EDITOR_FFPROBE_PATH).toBe(join(editorPath, "bin", `ffprobe${suffix}`));
	});

	test("keeps user-provided paths and leaves the variables unset when no binary is bundled", () => {
		vi.stubEnv("BABYLONJS_EDITOR_FFMPEG_PATH", "/custom/ffmpeg");

		configureBundledMediaExecutables(editorPath);

		expect(process.env.BABYLONJS_EDITOR_FFMPEG_PATH).toBe("/custom/ffmpeg");
		expect(process.env.BABYLONJS_EDITOR_FFPROBE_PATH).toBe("");
	});
});
