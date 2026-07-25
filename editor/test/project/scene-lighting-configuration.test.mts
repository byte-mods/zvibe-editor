import { NullEngine, Scene } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import { applySceneEnvironmentConfiguration } from "../../src/project/load/configuration";
import { createSceneLoadResult } from "../../src/project/load/result";

const scenes: Scene[] = [];

afterEach(() => scenes.splice(0).forEach((scene) => scene.dispose()));

describe("project authored lighting-scene configuration", () => {
	test("replaces global environment, fog, colors, metadata, and clustered-light settings", () => {
		const scene = new Scene(new NullEngine());
		scenes.push(scene);
		const clusteredLightContainer = { horizontalTiles: 1, verticalTiles: 1, depthSlices: 1, maxRange: 1 };
		const editor = {
			layout: {
				preview: {
					scene,
					camera: undefined,
					clusteredLightContainer,
				},
			},
		} as any;
		const result = createSceneLoadResult();
		const configuration = {
			metadata: { owner: "Lighting" },
			clearColor: [0.1, 0.2, 0.3, 1],
			ambientColor: [0.4, 0.5, 0.6],
			environment: { iblIntensity: 0.7, environmentIntensity: 0.8 },
			fog: { fogEnabled: true, fogMode: Scene.FOGMODE_EXP2, fogStart: 4, fogEnd: 80, fogDensity: 0.03, fogColor: [0.6, 0.7, 0.8] },
			clusteredLight: { horizontalTiles: 12, verticalTiles: 8, depthSlices: 16, maxRange: 5_000 },
		};

		expect(applySceneEnvironmentConfiguration(editor, "/project", configuration, result, {})).toEqual([]);
		expect(scene.metadata).toEqual({ owner: "Lighting" });
		expect(scene.clearColor.asArray()).toEqual([0.1, 0.2, 0.3, 1]);
		expect(scene.ambientColor.asArray()).toEqual([0.4, 0.5, 0.6]);
		expect(scene.iblIntensity).toBe(0.7);
		expect(scene.environmentIntensity).toBe(0.8);
		expect(scene.environmentTexture).toBeNull();
		expect(scene.fogEnabled).toBe(true);
		expect(scene.fogDensity).toBe(0.03);
		expect(clusteredLightContainer).toEqual({ horizontalTiles: 12, verticalTiles: 8, depthSlices: 16, maxRange: 5_000 });
	});
});
