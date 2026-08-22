import "@babylonjs/core/Loading/Plugins/babylonFileLoader";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Buffer } from "node:buffer";

import { FreeCamera, Mesh, NullEngine, Scene, SceneSerializer, Vector3 } from "@babylonjs/core";

import {
	adaptivePerformancePreset,
	configureAdaptivePerformance,
	getAdaptivePerformanceCapabilities,
	getAdaptivePerformanceRuntime,
	resetAdaptivePerformanceRuntime,
	sampleAdaptivePerformanceFrame,
	simulateAdaptivePerformanceThermalState,
	stopAdaptivePerformance,
	validateAdaptivePerformanceConfiguration,
} from "../../src/loading/adaptive-performance";
import { loadSceneAdditive, unloadSceneAdditive } from "../../src/loading/additive-scene";
import { loadScene } from "../../src/loading/loader";

describe("loading/adaptive-performance", () => {
	let engine: NullEngine;
	let scene: Scene;
	let hardwareScalingLevel: number;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Camera", Vector3.Zero(), scene);
		hardwareScalingLevel = 1.25;
		vi.spyOn(engine, "getHardwareScalingLevel").mockImplementation(() => hardwareScalingLevel);
		vi.spyOn(engine, "setHardwareScalingLevel").mockImplementation((value) => {
			hardwareScalingLevel = value;
		});
	});

	afterEach(() => {
		delete (globalThis as any).ZvibeAdaptivePerformance;
		scene.dispose();
		engine.dispose();
		vi.restoreAllMocks();
	});

	test("migrates defaults and strictly validates providers, bounds, and unique scaler ids", () => {
		expect(validateAdaptivePerformanceConfiguration(undefined)).toMatchObject({ version: 1, revision: 1, provider: "auto", scalers: { length: 6 } });
		expect(() => validateAdaptivePerformanceConfiguration({ ...adaptivePerformancePreset(), unexpected: true })).toThrow("Unknown Adaptive Performance configuration field");
		expect(() => validateAdaptivePerformanceConfiguration({ ...adaptivePerformancePreset(), provider: "vendor" })).toThrow("provider is invalid");
		const duplicate = adaptivePerformancePreset()
			.scalers.slice(0, 2)
			.map((scaler) => ({ ...scaler, id: "render-scale" as const }));
		expect(() => validateAdaptivePerformanceConfiguration({ ...adaptivePerformancePreset(), scalers: duplicate })).toThrow("ids must be unique");
		expect(getAdaptivePerformanceCapabilities()).toMatchObject({ version: 1, providers: [{ id: "basic" }, { id: "apple" }], scalers: { length: 6 } });
	});

	test("uses the Basic provider to reduce and recover concrete quality after complete windows", () => {
		configureAdaptivePerformance(scene, {
			...adaptivePerformancePreset(),
			enabled: true,
			provider: "basic",
			sampleFrames: 2,
			thermalActionDelaySeconds: 0,
			performanceActionDelaySeconds: 0,
		});
		sampleAdaptivePerformanceFrame(scene, 30);
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ lastDecision: "collecting", windowSamples: 1 });
		sampleAdaptivePerformanceFrame(scene, 30);
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({
			activeProvider: "basic",
			bottleneck: "unknown",
			lastDecision: "decrease-quality",
			actions: [{ reason: "performance", scalerId: "particles", fromLevel: 0, toLevel: 1 }],
		});
		expect(scene.particlesEnabled).toBe(false);

		simulateAdaptivePerformanceThermalState(scene, "nominal", 0.2, false);
		sampleAdaptivePerformanceFrame(scene, 5);
		sampleAdaptivePerformanceFrame(scene, 5);
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({
			lastDecision: "increase-quality",
			actions: [{ reason: "performance" }, { reason: "recovery", scalerId: "particles", fromLevel: 1, toLevel: 0 }],
			qualityIndex: 1,
		});
		expect(scene.particlesEnabled).toBe(true);
	});

	test("drives thermal scaler actions from clearly labeled Apple simulation and resets exact baselines", () => {
		scene.shadowsEnabled = true;
		scene.postProcessesEnabled = true;
		scene.particlesEnabled = true;
		const baselineMaxZ = scene.activeCamera!.maxZ;
		configureAdaptivePerformance(scene, {
			...adaptivePerformancePreset(),
			enabled: true,
			provider: "apple",
			platform: "ios",
			sampleFrames: 2,
			thermalActionDelaySeconds: 0,
			performanceActionDelaySeconds: 600,
		});
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ activeProvider: "basic", providerSource: "basic-fallback", providerAvailable: false });
		simulateAdaptivePerformanceThermalState(scene, "critical", 0.95, true);
		sampleAdaptivePerformanceFrame(scene, 16);
		sampleAdaptivePerformanceFrame(scene, 16);
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({
			thermalWarning: true,
			lastDecision: "decrease-quality",
			actions: [{ reason: "thermal", scalerId: "particles" }],
			providerEvents: [{ source: "editor-simulation", thermalState: "critical", temperatureLevel: 0.95, lowPowerMode: true }],
		});
		expect(scene.particlesEnabled).toBe(false);

		expect(resetAdaptivePerformanceRuntime(scene)).toMatchObject({ thermalState: "unknown", qualityIndex: 1, actions: [], lastDecision: "reset" });
		expect(scene.particlesEnabled).toBe(true);
		expect(scene.activeCamera!.maxZ).toBe(baselineMaxZ);
		expect(hardwareScalingLevel).toBe(1.25);
	});

	test("connects an injected Apple bridge and releases its listener and every baseline", async () => {
		const remove = vi.fn();
		let listener: ((value: unknown) => void) | null = null;
		(globalThis as any).ZvibeAdaptivePerformance = {
			getState: vi.fn().mockResolvedValue({ thermalState: "fair", temperatureLevel: 0.4, lowPowerMode: false }),
			addListener: vi.fn().mockImplementation(async (_name: string, callback: (value: unknown) => void) => {
				listener = callback;
				return { remove };
			}),
		};
		configureAdaptivePerformance(scene, { ...adaptivePerformancePreset(), enabled: true, provider: "apple", platform: "visionos", sampleFrames: 2 });
		await vi.waitFor(() => expect(getAdaptivePerformanceRuntime(scene).providerEvents).toHaveLength(1));
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({
			activeProvider: "apple",
			providerAvailable: true,
			providerSource: "apple-native-bridge",
			thermalState: "fair",
		});
		(listener as ((value: unknown) => void) | null)?.({ thermalState: "serious", temperatureLevel: 0.8 });
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ thermalState: "serious", thermalWarning: true, providerEvents: { length: 2 } });
		stopAdaptivePerformance(scene);
		expect(remove).toHaveBeenCalledOnce();
		expect(hardwareScalingLevel).toBe(1.25);
	});

	test("does not claim an injected Apple bridge outside Apple target platforms", () => {
		(globalThis as any).ZvibeAdaptivePerformance = { getState: vi.fn() };
		configureAdaptivePerformance(scene, { ...adaptivePerformancePreset(), enabled: true, provider: "apple", platform: "web" });
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({
			activeProvider: "basic",
			providerAvailable: false,
			providerSource: "basic-fallback",
			warnings: expect.arrayContaining([expect.stringContaining("supported only for iOS, tvOS, and visionOS")]),
		});
		expect((globalThis as any).ZvibeAdaptivePerformance.getState).not.toHaveBeenCalled();
	});

	test("restores the same runtime after full exported scene loading", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		source.metadata = { babylonEditorAdaptivePerformance: { ...adaptivePerformancePreset(), revision: 7, enabled: true, provider: "basic", sampleFrames: 2 } };
		new Mesh("Exported adaptive mesh", source);
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(SceneSerializer.Serialize(source))).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		await loadScene("", dataUrl, scene, {}, { skipAssetsPreload: true });
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ configured: true, running: true, configurationRevision: 7, activeProvider: "basic" });
	});

	test("recomposes and removes Adaptive Performance through additive scene lifecycle", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		source.metadata = { babylonEditorAdaptivePerformance: { ...adaptivePerformancePreset(), revision: 9, enabled: true, provider: "basic", sampleFrames: 2 } };
		new Mesh("Additive adaptive mesh", source);
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(SceneSerializer.Serialize(source))).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const handle = await loadSceneAdditive("", dataUrl, scene, {});
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ configured: true, running: true, configurationRevision: 9, activeProvider: "basic" });
		await unloadSceneAdditive(handle);
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ configured: true, running: false, configurationRevision: 1 });
	});
});
