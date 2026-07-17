import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { getSceneDiagnostics } from "../../src/mcp/editor";

describe("mcp/editor-diagnostics", () => {
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

	test("reports stable GPU timing fields even when a backend has no timer-query result", () => {
		const diagnostics = getSceneDiagnostics(scene);
		expect(diagnostics).toHaveProperty("gpuFrameTimeMs");
		expect(diagnostics).toHaveProperty("gpuFrameTimeAverageMs");
		for (const value of [diagnostics.gpuFrameTimeMs, diagnostics.gpuFrameTimeAverageMs])
			expect(value === null || (typeof value === "number" && Number.isFinite(value))).toBe(true);
	});
});
