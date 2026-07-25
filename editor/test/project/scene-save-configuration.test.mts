import { describe, expect, test } from "vitest";

import { mergeSceneSaveConfiguration } from "../../src/project/save/configuration";

describe("project/save scene configuration", () => {
	test("preserves non-lighting globals while updating scene-local cameras, animations, and clustered lights", () => {
		const retained = {
			clearColor: [1, 0, 0, 1],
			metadata: { scene: "B" },
			unknownFutureField: { retained: true },
			clusteredLight: { horizontalTiles: 12, lights: ["old"] },
		};
		const liveGlobal = { clearColor: [0, 0, 0, 1], metadata: { scene: "A" }, clusteredLight: { horizontalTiles: 99 } };

		expect(mergeSceneSaveConfiguration(retained, liveGlobal, { rendering: [{ cameraId: "B" }], animations: [{ name: "B" }], clusteredLightIds: ["B-light"] }, false)).toEqual({
			clearColor: [1, 0, 0, 1],
			metadata: { scene: "B" },
			unknownFutureField: { retained: true },
			rendering: [{ cameraId: "B" }],
			animations: [{ name: "B" }],
			clusteredLight: { horizontalTiles: 12, lights: ["B-light"] },
		});
	});

	test("uses current globals for the designated lighting scene", () => {
		const result = mergeSceneSaveConfiguration(
			{ clearColor: [1, 0, 0, 1], unknownFutureField: true },
			{ clearColor: [0, 0, 0, 1], metadata: { current: true }, clusteredLight: { depthSlices: 16 } },
			{ rendering: [], animations: [], clusteredLightIds: [] },
			true
		);

		expect(result).toMatchObject({ clearColor: [0, 0, 0, 1], metadata: { current: true }, unknownFutureField: true, clusteredLight: { depthSlices: 16, lights: [] } });
	});
});
