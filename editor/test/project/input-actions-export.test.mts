import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { configureInputActionsExportMetadata } from "../../src/project/export/input-actions";

describe("Input Actions export metadata", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("exports canonical stable maps and complete runtime settings", () => {
		scene.metadata = {
			babylonEditorInputActionMaps: [{ name: "Legacy", actions: [{ name: "Jump", bindings: ["space"] }] }],
			babylonEditorInputSystemSettings: { updateMode: "manual", maxTraceEvents: 64 },
		};
		const data: any = {};
		configureInputActionsExportMetadata(data, scene);
		expect(data.metadata.babylonEditorInputActionMaps[0]).toMatchObject({ version: 2, revision: 1, id: expect.stringMatching(/^legacy-map-/) });
		expect(data.metadata.babylonEditorInputActionMaps[0].actions[0].bindings[0]).toMatchObject({ id: expect.stringMatching(/^legacy-binding-/), path: "space" });
		expect(data.metadata.babylonEditorInputSystemSettings).toMatchObject({ version: 2, revision: 1, updateMode: "manual", maxTraceEvents: 64 });
	});

	test("rejects malformed authoring instead of shipping an unusable runtime", () => {
		scene.metadata = { babylonEditorInputActionMaps: [{ name: "Broken", enabled: "yes" }] };
		expect(() => configureInputActionsExportMetadata({}, scene)).toThrow("Boolean");
	});
});
