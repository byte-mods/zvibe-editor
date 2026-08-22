import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, ReflectionProbe, Scene } from "babylonjs";

import { getEnvironmentLighting, setEnvironmentTexture } from "../../src/mcp/materials/materials";

describe("mcp/environment-lighting", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("reads an exact environment lease, idempotently tunes IBL, rejects stale writes, and clears only owned data", async () => {
		const source = new ReflectionProbe("Environment Source", 4, scene, true, false, true);
		const texture = source.cubeTexture;
		texture.name = "Owned Environment";
		texture.metadata = { babylonEditorEnvironmentTexture: { version: 1, path: "assets/owned.env" } };
		scene.environmentTexture = texture;
		scene.iblIntensity = 1;
		const dispose = vi.spyOn(texture, "dispose");

		const initial = getEnvironmentLighting(scene);
		expect(initial).toMatchObject({
			revision: expect.stringMatching(/^[0-9a-f]{64}$/),
			iblIntensity: 1,
			texture: { name: "Owned Environment", width: 0, height: 0, ownedByEnvironmentTool: true },
			skyboxes: [],
			deferredCameras: [],
		});
		const tuned = await setEnvironmentTexture(scene, { expectedRevision: initial.revision, iblIntensity: 0.65 }, options);
		expect(tuned).toMatchObject({ iblIntensity: 0.65, texture: { name: "Owned Environment" }, removedSkyboxIds: [] });
		expect(tuned.revision).not.toBe(initial.revision);
		expect(dispose).not.toHaveBeenCalled();
		const noOp = await setEnvironmentTexture(scene, { expectedRevision: tuned.revision, iblIntensity: 0.65 }, options);
		expect(noOp.revision).toBe(tuned.revision);
		await expect(setEnvironmentTexture(scene, { expectedRevision: initial.revision, texturePath: null }, options)).rejects.toThrow("changed after inspection");
		expect(scene.environmentTexture).toBe(texture);

		const cleared = await setEnvironmentTexture(scene, { expectedRevision: noOp.revision, texturePath: null }, options);
		expect(cleared).toMatchObject({ texture: null, iblIntensity: 0.65, skyboxes: [] });
		expect(dispose).toHaveBeenCalledOnce();
		await expect(setEnvironmentTexture(scene, { expectedRevision: cleared.revision, createSkybox: true }, options)).rejects.toThrow("requires an environment texture");
		expect(getEnvironmentLighting(scene).revision).toBe(cleared.revision);
	});
});
