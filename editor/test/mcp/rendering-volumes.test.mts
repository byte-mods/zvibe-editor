import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { createRenderingProfile } from "../../src/mcp/rendering/profiles";
import { createRenderingVolume, deleteRenderingVolume, evaluateRenderingVolumes, listRenderingVolumes, setRenderingVolume } from "../../src/mcp/rendering/volumes";

describe("mcp/rendering-volumes", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, preview: { scene: null } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		options.editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists priority volumes and applies the highest containing profile", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const profile = createRenderingProfile(scene, { name: "Interior", configurations }, options);
		const low = createRenderingVolume(scene, { name: "Low", profileId: profile.id, center: [0, 0, 0], size: [20, 20, 20], priority: 1 }, options);
		const high = createRenderingVolume(scene, { name: "High", profileId: profile.id, center: [0, 0, 0], size: [10, 10, 10], priority: 2 }, options);
		expect(evaluateRenderingVolumes(scene, {}, options).volume).toMatchObject({ id: high.id });
		expect(setRenderingVolume(scene, { id: low.id, priority: 3 }, options)).toMatchObject({ priority: 3 });
		expect(evaluateRenderingVolumes(scene, {}, options).volume).toMatchObject({ id: low.id });
		setRenderingVolume(scene, { id: low.id, enabled: false }, options);
		setRenderingVolume(scene, { id: high.id, enabled: false }, options);
		expect(evaluateRenderingVolumes(scene, {}, options)).toMatchObject({ volume: null, restoredBaseline: true });
		expect(listRenderingVolumes(scene).volumes).toHaveLength(2);
		expect(deleteRenderingVolume(scene, { id: high.id }, options)).toMatchObject({ deleted: true });
	});

	test("returns weighted edge falloff and every overlapping contribution", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const profile = createRenderingProfile(scene, { name: "Interior", configurations }, options);
		createRenderingVolume(scene, { name: "Soft", profileId: profile.id, center: [0, 0, 0], size: [20, 20, 20], priority: 1, blendDistance: 10, weight: 0.8 }, options);
		createRenderingVolume(scene, { name: "Global", profileId: profile.id, center: [15, 0, 0], size: [20, 20, 20], priority: 0, weight: 0.25 }, options);
		camera.position.x = 15;
		camera.computeWorldMatrix();
		const result = evaluateRenderingVolumes(scene, {}, options);
		expect(result.volume).toMatchObject({ name: "Soft" });
		expect(result.volumes).toEqual([expect.objectContaining({ name: "Global", blendFactor: 0.25 }), expect.objectContaining({ name: "Soft", blendFactor: 0.4 })]);
	});

	test("validates profile references and volume sizes", () => {
		expect(() => createRenderingVolume(scene, { name: "Bad", profileId: "missing" }, options)).toThrow("profileId");
		const profile = createRenderingProfile(
			scene,
			{ name: "Interior", configurations: { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null } },
			options
		);
		expect(() => createRenderingVolume(scene, { name: "Bad", profileId: profile.id, size: [1, 0, 1] }, options)).toThrow("size must be positive");
		expect(() => createRenderingVolume(scene, { name: "Bad Blend", profileId: profile.id, blendDistance: -1 }, options)).toThrow("blendDistance");
		expect(() => createRenderingVolume(scene, { name: "Bad Weight", profileId: profile.id, weight: 1.1 }, options)).toThrow("weight");
	});
});
