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

	test("persists video player configuration with safe browser-autoplay defaults", () => {
		const material = scene.getMaterialByName("Screen Material")!;
		const created = createVideoPlayer(scene, { name: "Intro", path: "assets/intro.webm", materialId: material.id }, options);
		expect(created).toMatchObject({
			name: "Intro",
			path: "assets/intro.webm",
			materialId: material.id,
			textureSlot: "diffuseTexture",
			autoPlay: true,
			loop: true,
			muted: true,
			volume: 1,
		});
		expect(setVideoPlayer(scene, { id: created.id, loop: false, volume: 0.4, startTime: 2 }, options)).toMatchObject({ loop: false, volume: 0.4, startTime: 2 });
		expect(listVideoPlayers(scene).players).toHaveLength(1);
		expect(deleteVideoPlayer(scene, { id: created.id }, options)).toMatchObject({ deleted: true, id: created.id });
	});

	test("rejects unsupported assets and missing materials", () => {
		expect(() => createVideoPlayer(scene, { name: "Bad", path: "assets/intro.avi", materialId: "missing" }, options)).toThrow(".mp4, .webm, .ogv, or .mov");
		expect(() => createVideoPlayer(scene, { name: "Bad", path: "assets/intro.mov", materialId: "missing" }, options)).toThrow("was not found");
		expect(() => createVideoPlayer(scene, { name: "Bad", path: "assets/intro.mp4", materialId: "missing" }, options)).toThrow("was not found");
	});

	test("reports that live controls require an available project preview", async () => {
		const material = scene.getMaterialByName("Screen Material")!;
		const created = createVideoPlayer(scene, { name: "Intro", path: "assets/intro.webm", materialId: material.id }, options);
		expect(created.previewAttached).toBe(false);
		await expect(controlVideoPlayer(scene, { id: created.id, action: "play" })).rejects.toThrow("Video preview is unavailable");
	});
});
