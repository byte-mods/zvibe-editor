import { afterEach, describe, expect, test, vi } from "vitest";

import {
	normalizeVideoPlayerConfiguration,
	resolveConfiguredVideoPlayerSource,
	resolveImportedVideoPath,
	resolveImportedVideoSource,
	seekConfiguredVideoPlayer,
} from "../../src/loading/videos";

describe("video runtime import redirects", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("uses the portable imported output path from the build sidecar", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ version: 2, outputPath: "assets/clip.webm", platform: "web", compatibility: { status: "supported" } }) }))
		);
		await expect(resolveImportedVideoPath("/scene/", "assets/clip.mp4")).resolves.toBe("assets/clip.webm");
		await expect(resolveImportedVideoSource("/scene/", "assets/clip.mp4")).resolves.toMatchObject({
			path: "assets/clip.webm",
			metadata: { version: 2, platform: "web", compatibility: { status: "supported" } },
		});
		expect(fetch).toHaveBeenCalledWith("/scene/assets/clip.mp4.bjsvideo.json");
	});

	test("falls back to the authored path when no sidecar is available", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false }))
		);
		await expect(resolveImportedVideoPath("/scene/", "assets/clip.mp4")).resolves.toBe("assets/clip.mp4");
	});

	test("uses an authoring-host artifact URL without probing a runtime redirect sidecar", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const configuration = normalizeVideoPlayerConfiguration({
			id: "preview",
			name: "Preview",
			path: "assets/clip.mp4",
			targetMode: "apiOnly",
		});
		await expect(resolveConfiguredVideoPlayerSource("file:///project/", configuration, "file:///project/.bjseditor/imported-assets/clip.webm")).resolves.toEqual({
			source: "file:///project/.bjseditor/imported-assets/clip.webm",
			metadata: null,
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("migrates legacy material players to the complete version-2 contract", () => {
		expect(
			normalizeVideoPlayerConfiguration({
				id: "intro",
				name: "Intro",
				path: "assets/intro.webm",
				materialId: "screen",
				textureSlot: "emissiveTexture",
				autoPlay: false,
				loop: false,
				muted: false,
				volume: 0.4,
				startTime: 2,
			})
		).toMatchObject({
			version: 2,
			sourceType: "asset",
			targetMode: "material",
			playOnAwake: false,
			waitForFirstFrame: true,
			skipOnDrop: true,
			playbackSpeed: 1,
			updateMode: "audioTime",
			audioOutputMode: "direct",
			aspectRatio: "fitInside",
			alpha: 1,
			stereoLayout: "none",
			stereoEye: "left",
			colorSpace: "auto",
		});
	});

	test("validates URL sources, target requirements, and bounded playback properties", () => {
		const base = {
			id: "stream",
			name: "Stream",
			sourceType: "url",
			path: "https://cdn.example.com/live/intro.m3u8?token=x",
			targetMode: "apiOnly",
			materialId: null,
			textureSlot: "diffuseTexture",
			cameraId: null,
		};
		expect(normalizeVideoPlayerConfiguration({ ...base, playbackSpeed: 2, colorSpace: "linear", stereoLayout: "sideBySide", stereoEye: "right" })).toMatchObject({
			path: "https://cdn.example.com/live/intro.m3u8?token=x",
			playbackSpeed: 2,
			colorSpace: "linear",
			stereoLayout: "sideBySide",
			stereoEye: "right",
		});
		expect(() => normalizeVideoPlayerConfiguration({ ...base, path: "file:///secret.mp4" })).toThrow("HTTP or HTTPS");
		expect(() => normalizeVideoPlayerConfiguration({ ...base, sourceType: "asset", path: "../outside.mp4" })).toThrow("project-relative");
		expect(() => normalizeVideoPlayerConfiguration({ ...base, targetMode: "material" })).toThrow("require materialId");
		expect(() => normalizeVideoPlayerConfiguration({ ...base, playbackSpeed: 11 })).toThrow("between 0.01 and 10");
		expect(() => normalizeVideoPlayerConfiguration({ ...base, loop: "yes" })).toThrow("must be a boolean");
	});

	test("keeps manual-clock state synchronized when seeking", () => {
		const updateTexture = vi.fn();
		const runtime = {
			manualTime: 1,
			texture: { video: { currentTime: 1, duration: 12 }, updateTexture },
		} as any;
		seekConfiguredVideoPlayer(runtime, 20);
		expect(runtime.manualTime).toBe(12);
		expect(runtime.texture.video.currentTime).toBe(12);
		expect(updateTexture).toHaveBeenCalledWith(true);
		expect(() => seekConfiguredVideoPlayer(runtime, -1)).toThrow("non-negative finite number");
	});
});
