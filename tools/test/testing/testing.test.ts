import { NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createPortableTestingState, normalizePortableTestingState, portableTestRunToJUnit, runPortableTestSuites } from "../../src/testing/testing";

type PortableRunnerScene = Parameters<typeof runPortableTestSuites>[0];

function portableScene(scene: Scene): PortableRunnerScene {
	return scene as unknown as PortableRunnerScene;
}

describe("portable testing", () => {
	let engine: NullEngine;
	let scene: Scene;
	let node: TransformNode;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		node = new TransformNode("Subject", scene);
		node.id = "subject";
		node.position.copyFrom(new Vector3(1, 2, 3));
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("runs filtered scene cases and restores every mutated node", async () => {
		const state = createPortableTestingState();
		state.suites.push({
			id: "play-suite",
			name: "Play Suite",
			enabled: true,
			mode: "play",
			categories: ["smoke"],
			beforeEach: [{ type: "set-node-position", nodeId: node.id, value: [4, 5, 6] }],
			afterEach: [],
			tests: [
				{
					id: "moves-subject",
					name: "Moves subject",
					enabled: true,
					kind: "scene",
					categories: ["integration"],
					repeat: 2,
					setup: [],
					steps: [{ type: "wait-frames", frames: 1 }],
					teardown: [],
					assertions: [
						{ type: "node-exists", nodeId: node.id, exists: true },
						{ type: "node-position", nodeId: node.id, equals: [4, 5, 6] },
						{ type: "scene-count", collection: "nodes", operator: "greater-than-or-equal", expected: 1 },
					],
				},
			],
		});

		const report = await runPortableTestSuites(portableScene(scene), state, { categories: ["integration"] }, { target: "editor-play" });
		expect(report).toMatchObject({ status: "passed", summary: { total: 2, passed: 2 } });
		expect(node.position.asArray()).toEqual([1, 2, 3]);
	});

	test("collects bounded performance samples and fails unavailable metrics by default", async () => {
		const state = createPortableTestingState();
		state.suites.push({
			id: "performance-suite",
			name: "Performance Suite",
			enabled: true,
			mode: "edit",
			categories: [],
			beforeEach: [],
			afterEach: [],
			tests: [
				{
					id: "frame-budget",
					name: "Frame budget",
					enabled: true,
					kind: "performance",
					categories: [],
					repeat: 1,
					setup: [],
					steps: [],
					teardown: [],
					assertions: [],
					performance: {
						warmupFrames: 1,
						measurementFrames: 3,
						thresholds: [
							{ metric: "frameTimeMs", statistic: "p95", operator: "less-than-or-equal", value: 20 },
							{ metric: "gpuFrameTimeMs", statistic: "mean", operator: "less-than-or-equal", value: 20 },
						],
					},
				},
			],
		});
		let sample = 9;
		const report = await runPortableTestSuites(
			portableScene(scene),
			state,
			{},
			{
				target: "editor-edit",
				measureMetrics: () => ({ frameTimeMs: sample++, gpuFrameTimeMs: null }),
			}
		);
		expect(report.status).toBe("failed");
		expect(report.results[0].performance?.summary.frameTimeMs).toMatchObject({ sampleCount: 3, minimum: 9, maximum: 11, median: 10, p95: 11 });
		expect(report.results[0].performance?.thresholds[1]).toMatchObject({ available: false, passed: false });
	});

	test("validates closed bounded authoring data and reports cancellation", async () => {
		const state = createPortableTestingState();
		expect(() => normalizePortableTestingState({ ...state, settings: { ...state.settings, maximumRetainedRuns: 21 } })).toThrow("1 through 20");
		state.suites.push({
			id: "cancel-suite",
			name: "Cancel Suite",
			enabled: true,
			mode: "edit",
			categories: [],
			beforeEach: [],
			afterEach: [],
			tests: [
				{
					id: "cancel-case",
					name: "Cancel Case",
					enabled: true,
					kind: "scene",
					categories: [],
					repeat: 1,
					setup: [],
					steps: [{ type: "wait-frames", frames: 2 }],
					teardown: [],
					assertions: [{ type: "node-exists", nodeId: node.id, exists: true }],
				},
			],
		});
		const controller = new AbortController();
		const report = await runPortableTestSuites(
			portableScene(scene),
			state,
			{},
			{
				target: "editor-edit",
				signal: controller.signal,
				waitFrames: async () => controller.abort("Canceled by test."),
			}
		);
		expect(report.status).toBe("canceled");
		expect(report.results[0]).toMatchObject({ status: "canceled", errors: ["Canceled by test."] });
	});

	test("exports a bounded JUnit-compatible report", async () => {
		const state = createPortableTestingState();
		state.suites.push({
			id: "xml-suite",
			name: "XML & Suite",
			enabled: true,
			mode: "edit",
			categories: [],
			beforeEach: [],
			afterEach: [],
			tests: [
				{
					id: "xml-case",
					name: "XML < Case",
					enabled: true,
					kind: "scene",
					categories: [],
					repeat: 1,
					setup: [],
					steps: [],
					teardown: [],
					assertions: [{ type: "node-exists", nodeId: node.id, exists: true }],
				},
			],
		});
		const report = await runPortableTestSuites(portableScene(scene), state, {}, { target: "headless" });
		const xml = portableTestRunToJUnit(report);
		expect(xml).toContain('tests="1"');
		expect(xml).toContain('classname="XML &amp; Suite"');
		expect(xml).toContain('name="XML &lt; Case"');
	});
});
