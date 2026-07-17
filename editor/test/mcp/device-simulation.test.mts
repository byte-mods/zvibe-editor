import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { getDeviceSimulation, setDeviceSimulation } from "../../src/mcp/editor";

describe("mcp/device simulation", () => {
	let engine: NullEngine;
	let scene: Scene;
	const setDeviceSimulationPreview = vi.fn();
	const options = { editor: { layout: { preview: { setDeviceSimulation: setDeviceSimulationPreview }, inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		setDeviceSimulationPreview.mockClear();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists a validated profile and applies oriented dimensions to the preview", () => {
		const result = setDeviceSimulation(scene, { enabled: true, width: 1170, height: 2532, dpi: 460, orientation: "landscape", safeArea: [20, 10, 20, 10] }, options);
		expect(result).toMatchObject({ enabled: true, width: 1170, height: 2532, orientation: "landscape", safeArea: [20, 10, 20, 10] });
		expect(setDeviceSimulationPreview).toHaveBeenCalledWith(expect.objectContaining({ width: 2532, height: 1170, dpi: 460 }));
		expect(getDeviceSimulation(scene)).toEqual(result);
		expect(() => setDeviceSimulation(scene, { safeArea: [2000, 0, 2000, 0] }, options)).toThrow("visible area");
	});
});
