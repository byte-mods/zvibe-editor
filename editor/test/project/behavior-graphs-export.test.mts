import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { configureBehaviorGraphExportMetadata } from "../../src/project/export/behavior-graphs";

describe("Behavior Graph export metadata", () => {
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

	test("exports canonical version-2 graphs without mutating legacy authoring", () => {
		scene.metadata = { babylonEditorBehaviorTrees: [{ id: "legacy", name: "Legacy", autoRun: true, root: { id: "log", type: "action-log", value: "ready" } }] };
		const authored = structuredClone(scene.metadata.babylonEditorBehaviorTrees);
		const data: any = {};
		configureBehaviorGraphExportMetadata(data, scene);
		expect(data.metadata.babylonEditorBehaviorTrees[0]).toMatchObject({ version: 2, revision: 1, autoStart: true, blackboard: [], root: { id: "log", enabled: true } });
		expect(scene.metadata.babylonEditorBehaviorTrees).toEqual(authored);
	});

	test("rejects invalid or recursive graphs instead of exporting broken runtime data", () => {
		scene.metadata = {
			babylonEditorBehaviorTrees: [
				{ id: "a", name: "A", root: { id: "call-a", type: "subgraph", subgraphId: "b" } },
				{ id: "b", name: "B", root: { id: "call-b", type: "subgraph", subgraphId: "a" } },
			],
		};
		expect(() => configureBehaviorGraphExportMetadata({}, scene)).toThrow(/cycle/);
	});
});
