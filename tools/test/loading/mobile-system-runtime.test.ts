import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "@babylonjs/core";
import { Mesh, SceneSerializer } from "@babylonjs/core";
import { Buffer } from "node:buffer";

import {
	configureMobileSystemRuntime,
	createDefaultMobileSystemConfiguration,
	getMobileSystemCapabilities,
	getMobileSystemRuntime,
	resetMobileSystemRuntime,
	simulateMobileSystemState,
	stopMobileSystemRuntime,
	ThermalFrameRateGate,
	validateMobileSystemConfiguration,
} from "../../src/loading/mobile-system-runtime";
import { loadSceneAdditive, unloadSceneAdditive } from "../../src/loading/additive-scene";
import { loadScene } from "../../src/loading/loader";
import { getGrpcTransportRuntime } from "../../src/loading/grpc-transport";

describe("loading/mobile-system-runtime", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		delete (globalThis as any).ZvibeWindowInsets;
		delete (globalThis as any).ZvibeAdaptivePerformance;
		scene.dispose();
		engine.dispose();
		vi.restoreAllMocks();
	});

	test("defaults to Unity 6.5 Apple 30/15 policy and strictly validates Android inset authoring", () => {
		expect(createDefaultMobileSystemConfiguration()).toMatchObject({
			version: 1,
			revision: 1,
			android: { requestedVisibleWindowInsets: ["statusBars", "navigationBars"], systemBarsBehavior: "default" },
			iosThermalFrameRate: { enabled: true, seriousThermalStateFps: 30, criticalThermalStateFps: 15 },
		});
		expect(() => validateMobileSystemConfiguration({ ...createDefaultMobileSystemConfiguration(), extra: true })).toThrow("unsupported fields");
		expect(() =>
			validateMobileSystemConfiguration({
				...createDefaultMobileSystemConfiguration(),
				android: { ...createDefaultMobileSystemConfiguration().android, requestedVisibleWindowInsets: ["ime", "ime"] },
			})
		).toThrow("unique supported inset types");
		expect(() =>
			validateMobileSystemConfiguration({
				...createDefaultMobileSystemConfiguration(),
				iosThermalFrameRate: { enabled: true, seriousThermalStateFps: 15, criticalThermalStateFps: 30 },
			})
		).toThrow("cannot exceed");
		expect(getMobileSystemCapabilities()).toMatchObject({ version: 1, iosThermalFrameRate: { seriousDefaultFps: 30, criticalDefaultFps: 15 } });
	});

	test("applies native Android policy, consumes live events, labels simulation, and releases the listener", async () => {
		const remove = vi.fn();
		const applyPolicy = vi.fn();
		let listener: ((sample: unknown) => void) | null = null;
		(globalThis as any).ZvibeWindowInsets = {
			applyPolicy,
			getState: vi.fn().mockResolvedValue({
				insets: { left: 2, top: 42, right: 3, bottom: 64 },
				visibleWindowInsets: ["statusBars", "navigationBars"],
			}),
			addListener: vi.fn().mockImplementation(async (_event: string, callback: (sample: unknown) => void) => {
				listener = callback;
				return { remove };
			}),
		};
		configureMobileSystemRuntime(scene, { ...createDefaultMobileSystemConfiguration(), revision: 7, platform: "android" });
		await vi.waitFor(() => expect(getMobileSystemRuntime(scene).windowInsetsSource).toBe("android-native"));
		expect(applyPolicy).toHaveBeenCalledWith(expect.objectContaining({ requestedVisibleWindowInsets: ["statusBars", "navigationBars"] }));
		expect(getMobileSystemRuntime(scene)).toMatchObject({
			configurationRevision: 7,
			androidBridgeAvailable: true,
			androidPolicyApplied: true,
			windowInsets: { top: 42, bottom: 64 },
		});
		(listener as ((sample: unknown) => void) | null)?.({ insets: { left: 0, top: 0, right: 0, bottom: 80 }, visibleWindowInsets: ["navigationBars"] });
		expect(getMobileSystemRuntime(scene)).toMatchObject({ windowInsets: { bottom: 80 }, visibleWindowInsets: ["navigationBars"] });
		for (let index = 0; index < 70; index++) {
			(listener as ((sample: unknown) => void) | null)?.({ insets: { left: -1, top: 0, right: 0, bottom: 0 }, visibleWindowInsets: [] });
		}
		expect(getMobileSystemRuntime(scene).errors).toHaveLength(64);
		simulateMobileSystemState(scene, { windowInsets: { left: 10, top: 20, right: 10, bottom: 30 }, visibleWindowInsets: ["ime"] });
		expect(getMobileSystemRuntime(scene)).toMatchObject({ windowInsetsSource: "editor-simulation", visibleWindowInsets: ["ime"] });
		stopMobileSystemRuntime(scene);
		expect(remove).toHaveBeenCalledOnce();
	});

	test("gates Serious/Critical frames deterministically and restores the exact render baseline", () => {
		const gate = new ThermalFrameRateGate({ enabled: true, seriousThermalStateFps: 30, criticalThermalStateFps: 15 });
		gate.setThermalState("serious");
		expect([0, 16, 34, 50, 68].map((time) => gate.shouldRender(time))).toEqual([true, false, true, false, true]);
		gate.setThermalState("critical");
		expect(gate.targetFrameRate).toBe(15);
		expect([100, 140, 167].map((time) => gate.shouldRender(time))).toEqual([true, false, true]);
		gate.setThermalState("nominal");
		expect(gate.targetFrameRate).toBeNull();
		expect(gate.shouldRender(168)).toBe(true);

		const baselineRender = scene.render;
		configureMobileSystemRuntime(scene, { ...createDefaultMobileSystemConfiguration(), platform: "ios" });
		expect(scene.render).not.toBe(baselineRender);
		expect(simulateMobileSystemState(scene, { thermalState: "serious" })).toMatchObject({
			thermalState: "serious",
			thermalSource: "editor-simulation",
			appliedTargetFrameRate: 30,
		});
		expect(resetMobileSystemRuntime(scene)).toMatchObject({ thermalState: "unknown", appliedTargetFrameRate: null, events: [{ type: "reset" }] });
		stopMobileSystemRuntime(scene);
		expect(scene.render).toBe(baselineRender);
	});

	test("restores Mobile System and gRPC authoring through full and additive exported loading", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		source.metadata = {
			babylonEditorMobileSystem: { ...createDefaultMobileSystemConfiguration(), revision: 11, platform: "android" },
			babylonEditorGrpcTransport: {
				version: 1,
				revision: 12,
				enabled: true,
				endpoint: "http://localhost:8080",
				protocol: "connect",
				defaultTimeoutMs: 1000,
				maximumSendMessageBytes: 1024,
				maximumReceiveMessageBytes: 2048,
				credentials: "omit",
				defaultMetadata: {},
			},
		};
		new Mesh("Mobile system mesh", source);
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(SceneSerializer.Serialize(source))).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		await loadScene("", dataUrl, scene, {}, { skipAssetsPreload: true });
		expect(getMobileSystemRuntime(scene)).toMatchObject({ configured: true, configurationRevision: 11, platform: "android" });
		expect(getGrpcTransportRuntime(scene)).toMatchObject({ configured: true, configurationRevision: 12, enabled: true });

		const additiveEngine = new NullEngine();
		const additiveScene = new Scene(additiveEngine);
		const handle = await loadSceneAdditive("", dataUrl, additiveScene, {});
		expect(getMobileSystemRuntime(additiveScene)).toMatchObject({ configurationRevision: 11 });
		expect(getGrpcTransportRuntime(additiveScene)).toMatchObject({ configurationRevision: 12 });
		await unloadSceneAdditive(handle);
		expect(getMobileSystemRuntime(additiveScene)).toMatchObject({ configurationRevision: 1 });
		expect(getGrpcTransportRuntime(additiveScene)).toMatchObject({ configurationRevision: 1, enabled: false });
		additiveScene.dispose();
		additiveEngine.dispose();
	});
});
