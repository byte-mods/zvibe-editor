import { afterEach, describe, expect, test, vi } from "vitest";

import { existsSync } from "node:fs";

import { resolveMediaExecutable } from "../src/tools/media-executables.mjs";

describe("resolveMediaExecutable", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("prefers the explicit environment path set by the editor", () => {
		vi.stubEnv("BABYLONJS_EDITOR_FFMPEG_PATH", "/opt/editor/bin/ffmpeg");
		vi.stubEnv("BABYLONJS_EDITOR_FFPROBE_PATH", "/opt/editor/bin/ffprobe");

		expect(resolveMediaExecutable("ffmpeg")).toBe("/opt/editor/bin/ffmpeg");
		expect(resolveMediaExecutable("ffprobe")).toBe("/opt/editor/bin/ffprobe");
	});

	test("falls back to the bundled ffmpeg-static and @ffprobe-installer binaries instead of requiring FFmpeg on PATH", () => {
		vi.stubEnv("BABYLONJS_EDITOR_FFMPEG_PATH", "");
		vi.stubEnv("BABYLONJS_EDITOR_FFPROBE_PATH", "");

		for (const name of ["ffmpeg", "ffprobe"] as const) {
			const resolved = resolveMediaExecutable(name);
			expect(resolved).toContain(name);
			expect(resolved).not.toBe(name);
			expect(existsSync(resolved)).toBe(true);
		}
	});
});
