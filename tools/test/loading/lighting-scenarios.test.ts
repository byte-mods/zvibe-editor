import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import { configureLightingScenarios } from "../../src/loading/lighting-scenarios";

describe("loading/lighting-scenarios", () => {
	let engine: NullEngine;
	let scene: Scene;
	let light: PointLight;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		light = new PointLight("Lamp", Vector3.Zero(), scene);
		light.intensity = 0;
		light.diffuse = new Color3(0, 0, 1);
		scene.metadata = {
			babylonEditorLightingScenarios: [
				{
					id: "night",
					name: "Night",
					lights: [{ nodeId: light.id, nodeName: light.name, enabled: true, intensity: 2, diffuse: [1, 0, 0], specular: [1, 1, 1], position: [50, 0, 0] }],
				},
			],
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("exposes persisted scenarios and applies an immediate cross-fade target", () => {
		configureLightingScenarios(scene);
		expect(scene.lightingScenarios?.blendTo("Night", 0)).toBe(true);
		expect(light.intensity).toBe(2);
		expect(light.diffuse.asArray()).toEqual([1, 0, 0]);
		expect(light.position.x).toBe(50);
	});
});
