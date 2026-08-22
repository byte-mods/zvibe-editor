import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { configureVisualScriptingExportMetadata } from "../../src/project/export/visual-scripting";

describe("Visual Scripting export metadata", () => {
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

	test("exports canonical stable version-2 graphs without mutating legacy authoring", () => {
		scene.metadata = {
			babylonEditorVisualScriptGraphs: [{ name: "Legacy", autoRun: true, variables: { amount: 2 }, nodes: [{ id: "start", type: "event-start" }] }],
		};
		const authored = structuredClone(scene.metadata.babylonEditorVisualScriptGraphs);
		const data: any = {};

		configureVisualScriptingExportMetadata(data, scene);

		expect(data.metadata.babylonEditorVisualScriptGraphs[0]).toMatchObject({ version: 2, revision: 1, kind: "flow", autoStart: true });
		expect(data.metadata.babylonEditorVisualScriptGraphs[0].variables[0]).toMatchObject({ name: "amount", type: "number", defaultValue: 2 });
		expect(scene.metadata.babylonEditorVisualScriptGraphs).toEqual(authored);
	});

	test("rejects malformed authoring instead of exporting a broken runtime", () => {
		scene.metadata = { babylonEditorVisualScriptGraphs: [{ id: "bad", name: "Bad", enabled: "yes" }] };
		expect(() => configureVisualScriptingExportMetadata({}, scene)).toThrow("invalid kind or enable flags");
	});
});
