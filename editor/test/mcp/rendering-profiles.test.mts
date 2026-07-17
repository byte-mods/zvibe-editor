import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { applyRenderingProfile, createRenderingProfile, deleteRenderingProfile, listRenderingProfiles, setRenderingProfile } from "../../src/mcp/rendering/profiles";

describe("mcp/rendering-profiles", () => {
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

	test("creates, updates, applies, lists, and deletes an explicit disabled profile", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const profile = createRenderingProfile(scene, { name: "Mobile", configurations }, options);
		expect(listRenderingProfiles(scene).profiles).toEqual([profile]);

		const updated = setRenderingProfile(scene, { id: profile.id, name: "Mobile Low", configurations }, options);
		expect(updated.name).toBe("Mobile Low");
		expect(applyRenderingProfile(scene, { id: profile.id, nodeId: camera.id }, options)).toMatchObject({
			id: profile.id,
			camera: "Camera",
			appliedTypes: ["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"],
		});
		expect(deleteRenderingProfile(scene, { id: profile.id }, options)).toEqual({ deleted: true, id: profile.id });
		expect(listRenderingProfiles(scene).profiles).toEqual([]);
	});

	test("rejects unsupported profile post-process types", () => {
		expect(() => createRenderingProfile(scene, { name: "Invalid", configurations: { unsupported: null } }, options)).toThrow("Unsupported rendering profile post-process type");
	});
});
