import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { deleteProfilerCapture, getProfilerCapture, listProfilerCaptures, startProfilerCapture, stopProfilerCapture } from "../../src/mcp/editor";

describe("mcp/profiler captures", () => {
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

	test("records bounded timestamped diagnostic samples and summarizes them", () => {
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		const started = startProfilerCapture(scene, { name: "Gameplay", sampleIntervalMs: 1, maxSamples: 3 }, options);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const stopped = stopProfilerCapture(scene, { id: started.id }, options);

		expect(stopped).toMatchObject({ active: false, sampleCount: 2 });
		expect(stopped.summary.frameTimeMs).toMatchObject({ min: 16, max: 16, average: 16 });
		expect(getProfilerCapture(scene, { name: "Gameplay" }).samples).toHaveLength(2);
		expect(listProfilerCaptures(scene).captures).toEqual([expect.objectContaining({ id: started.id, name: "Gameplay", active: false })]);
		expect(deleteProfilerCapture(scene, { id: started.id }, options)).toEqual({ deleted: true, id: started.id });
	});
});
