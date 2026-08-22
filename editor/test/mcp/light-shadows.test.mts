import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CreateBox, DirectionalLight, FreeCamera, NullEngine, PointLight, Scene, ShadowGenerator, Vector3 } from "babylonjs";

import { setLightShadows } from "../../src/mcp/lights/lights";

describe("mcp/light-shadows", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		(engine as any)._features.supportShadowSamplers = true;
		(engine as any)._features.supportCSM = true;
		scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Camera", new Vector3(0, 10, -20), scene);
		CreateBox("Caster", { size: 10 }, scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("authors classic PCSS and returns the effective native quality controls", () => {
		const light = new DirectionalLight("Sun", new Vector3(0, -1, 0), scene);
		const result = setLightShadows(
			scene,
			{
				nodeId: light.id,
				enabled: true,
				filter: "pcss",
				filteringQuality: "medium",
				mapSize: 2048,
				bias: 0.002,
				normalBias: 0.03,
				darkness: 0.25,
				contactHardeningLightSizeUVRatio: 0.15,
			},
			options
		);
		const generator = light.getShadowGenerator() as ShadowGenerator;
		expect(generator.filter).toBe(ShadowGenerator.FILTER_PCSS);
		expect(generator.filteringQuality).toBe(ShadowGenerator.QUALITY_MEDIUM);
		expect(result.shadow).toMatchObject({
			generatorType: "classic",
			filter: "pcss",
			filteringQuality: "medium",
			mapSize: 2048,
			bias: 0.002,
			normalBias: 0.03,
			darkness: 0.25,
			contactHardeningLightSizeUVRatio: 0.15,
			casterCount: 1,
		});
	});

	test("supports point Poisson soft cubes and rejects filters Babylon would silently normalize", () => {
		const light = new PointLight("Lamp", new Vector3(0, 20, 0), scene);
		expect(() => setLightShadows(scene, { nodeId: light.id, enabled: true, filter: "pcss" }, options)).toThrow('do not support "pcss" natively');
		const result = setLightShadows(scene, { nodeId: light.id, enabled: true, filter: "poisson", blurScale: 3 }, options);
		expect(light.getShadowGenerator()?.filter).toBe(ShadowGenerator.FILTER_POISSONSAMPLING);
		expect(result.shadow).toMatchObject({ filter: "poisson", blurScale: 3 });
	});

	test("rejects unsupported exponential cascades before replacing an existing generator", () => {
		const light = new DirectionalLight("Cascaded Sun", new Vector3(0, -1, 0), scene);
		setLightShadows(scene, { nodeId: light.id, enabled: true, filter: "hard" }, options);
		const existing = light.getShadowGenerator();
		expect(() => setLightShadows(scene, { nodeId: light.id, enabled: true, generatorType: "cascaded", filter: "exponential" }, options)).toThrow("Cascaded shadows support");
		expect(light.getShadowGenerator()).toBe(existing);
	});
});
