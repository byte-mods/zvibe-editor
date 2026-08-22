import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import {
	activateDeviceSimulatorProfile,
	deleteDeviceSimulatorProfile,
	getDeviceSimulation,
	listDeviceSimulatorProfiles,
	setDeviceSimulation,
	setDeviceSimulatorProfile,
} from "../../src/mcp/editor";

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
		(globalThis as any).__ZVIBE_DEVICE_SIMULATION__ = null;
		scene.dispose();
		engine.dispose();
	});

	test("persists a validated profile and applies oriented dimensions to the preview", () => {
		const result = setDeviceSimulation(scene, { enabled: true, width: 1170, height: 2532, dpi: 460, orientation: "landscape", safeArea: [20, 10, 20, 10] }, options);
		expect(result).toMatchObject({ version: 2, revision: 1, enabled: true, width: 1170, height: 2532, orientation: "landscape", safeArea: [20, 10, 20, 10] });
		expect(result.resolved).toMatchObject({ width: 2532, height: 1170, safeArea: [10, 20, 10, 20], systemInfo: { performanceSimulated: false } });
		expect(setDeviceSimulationPreview).toHaveBeenCalledWith(expect.objectContaining({ width: 2532, height: 1170, dpi: 460, safeArea: [10, 20, 10, 20] }));
		expect(getDeviceSimulation(scene)).toEqual(result);
		expect((globalThis as any).__ZVIBE_DEVICE_SIMULATION__).toEqual(result.resolved);
		expect(() => setDeviceSimulation(scene, { safeArea: [2000, 0, 2000, 0] }, options)).toThrow("visible area");
	});

	test("migrates legacy state without inventing simulated hardware performance", () => {
		scene.metadata = { babylonEditorDeviceSimulation: { enabled: true, width: 1080, height: 2400, dpi: 420, orientation: "portrait", safeArea: [80, 0, 80, 0] } };
		const result = getDeviceSimulation(scene);
		expect(result).toMatchObject({ version: 2, revision: 0, enabled: true, width: 1080, height: 2400 });
		expect(result.resolved).toMatchObject({ application: { isMobile: true }, screen: { orientation: "portrait" }, systemInfo: { performanceSimulated: false } });
		expect(result.limitations.join(" ")).toContain("Hardware performance");
	});

	test("authors exact custom profiles, activates rotated safe areas, and deletes safely", () => {
		expect(listDeviceSimulatorProfiles(scene)).toMatchObject({
			version: 1,
			revision: 0,
			profiles: expect.arrayContaining([expect.objectContaining({ id: "generic-ios-phone", builtIn: true })]),
		});
		const created = setDeviceSimulatorProfile(
			scene,
			{
				expectedRevision: 0,
				id: "qa-phone",
				name: "QA Phone",
				platform: "android",
				width: 1000,
				height: 2000,
				dpi: 400,
				devicePixelRatio: 2,
				safeArea: [10, 20, 30, 40],
				operatingSystem: "QA OS",
				deviceModel: "QA Model",
				cpuCores: 8,
				memoryMB: 4096,
				graphicsApi: "WebGL2",
				touchPoints: 5,
				endpoint: "set_device_simulator_profile",
			},
			options
		);
		expect(created).toMatchObject({ configuration: { revision: 1 }, profile: { id: "qa-phone", builtIn: false } });
		expect(created.profile).not.toHaveProperty("endpoint");
		expect(() => setDeviceSimulatorProfile(scene, { ...created.profile, expectedRevision: 0 }, options)).toThrow("Stale");

		const active = activateDeviceSimulatorProfile(scene, { id: "qa-phone", expectedRevision: 0, enabled: true, orientation: "landscape" }, options);
		expect(active).toMatchObject({ revision: 1, profileId: "qa-phone", resolved: { width: 2000, height: 1000, safeArea: [40, 10, 20, 30] } });
		expect(() => deleteDeviceSimulatorProfile(scene, { id: "qa-phone", expectedRevision: 1 }, options)).toThrow("confirm=true");
		expect(deleteDeviceSimulatorProfile(scene, { id: "qa-phone", expectedRevision: 1, confirm: true }, options)).toMatchObject({
			deleted: true,
			configuration: { revision: 2 },
		});
		expect(getDeviceSimulation(scene)).toMatchObject({ profileId: null, revision: 2 });
	});

	test("rejects immutable built-ins, unknown fields, stale revisions, and invalid ranges", () => {
		expect(() => setDeviceSimulatorProfile(scene, { expectedRevision: 0, id: "generic-ios-phone" }, options)).toThrow("immutable");
		expect(() => setDeviceSimulation(scene, { expectedRevision: 99, enabled: true }, options)).toThrow("Stale");
		expect(() => setDeviceSimulation(scene, { mystery: true }, options)).toThrow("Unknown Device Simulator field");
		expect(() => setDeviceSimulation(scene, { touchPoints: 33 }, options)).toThrow("touchPoints");
	});
});
