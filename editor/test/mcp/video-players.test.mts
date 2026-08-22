import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, StandardMaterial } from "babylonjs";

import { controlVideoPlayer, createVideoPlayer, deleteVideoPlayer, listVideoPlayers, setVideoPlayer } from "../../src/mcp/videos/videos";

describe("mcp/video-players", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		new StandardMaterial("Screen Material", scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists the complete version-2 player contract with safe browser defaults", async () => {
		const material = scene.getMaterialByName("Screen Material")!;
		const created = await createVideoPlayer(scene, { name: "Intro", path: "assets/intro.webm", materialId: material.id }, options);
		expect(created).toMatchObject({
			version: 2,
			name: "Intro",
			sourceType: "asset",
			path: "assets/intro.webm",
			targetMode: "material",
			materialId: material.id,
			textureSlot: "diffuseTexture",
			playOnAwake: true,
			autoPlay: true,
			waitForFirstFrame: true,
			loop: true,
			skipOnDrop: true,
			playbackSpeed: 1,
			updateMode: "audioTime",
			muted: true,
			volume: 1,
			audioOutputMode: "direct",
			aspectRatio: "fitInside",
			alpha: 1,
			stereoLayout: "none",
			colorSpace: "auto",
		});
		expect(
			await setVideoPlayer(scene, { id: created.id, loop: false, volume: 0.4, startTime: 2, playbackSpeed: 1.5, updateMode: "gameTime", colorSpace: "linear" }, options)
		).toMatchObject({ loop: false, volume: 0.4, startTime: 2, playbackSpeed: 1.5, updateMode: "gameTime", colorSpace: "linear" });
		expect(listVideoPlayers(scene).players).toHaveLength(1);
		expect(deleteVideoPlayer(scene, { id: created.id }, options)).toMatchObject({ deleted: true, id: created.id });
	});

	test("rejects unsupported sources, missing targets, and invalid timing", async () => {
		await expect(createVideoPlayer(scene, { name: "Bad", path: "assets/intro.avi", materialId: "missing" }, options)).rejects.toThrow(".mp4, .webm, .ogv, or .mov");
		await expect(createVideoPlayer(scene, { name: "Bad", path: "assets/intro.mov", materialId: "missing" }, options)).rejects.toThrow("was not found");
		await expect(createVideoPlayer(scene, { name: "Bad", sourceType: "url", path: "file:///secret.mp4", targetMode: "apiOnly" }, options)).rejects.toThrow("HTTP or HTTPS");
		await expect(createVideoPlayer(scene, { name: "Bad", path: "assets/intro.mp4", targetMode: "cameraNearPlane", cameraId: "missing" }, options)).rejects.toThrow(
			"was not found"
		);
		await expect(createVideoPlayer(scene, { name: "Bad", path: "assets/intro.mp4", targetMode: "apiOnly", playbackSpeed: 11 }, options)).rejects.toThrow("between 0.01 and 10");
	});

	test("supports API-only and render-texture-equivalent persisted targets without a material", async () => {
		const api = await createVideoPlayer(scene, { name: "API", path: "assets/api.mp4", targetMode: "apiOnly" }, options);
		const renderTexture = await createVideoPlayer(scene, { name: "Render", path: "assets/render.webm", targetMode: "renderTexture" }, options);
		expect(api).toMatchObject({ targetMode: "apiOnly", materialId: null, previewAttached: false });
		expect(renderTexture).toMatchObject({ targetMode: "renderTexture", materialId: null, previewAttached: false });
		expect(listVideoPlayers(scene).players.map((player: any) => player.targetMode)).toEqual(["apiOnly", "renderTexture"]);
	});

	test("reports that live controls require an available project preview", async () => {
		const material = scene.getMaterialByName("Screen Material")!;
		const created = await createVideoPlayer(scene, { name: "Intro", path: "assets/intro.webm", materialId: material.id }, options);
		expect(created.previewAttached).toBe(false);
		await expect(controlVideoPlayer(scene, { id: created.id, action: "play" })).rejects.toThrow("Video preview is unavailable");
	});
});
