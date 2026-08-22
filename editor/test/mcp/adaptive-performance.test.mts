import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import {
	getAdaptivePerformanceCapabilities,
	getAdaptivePerformanceConfiguration,
	getAdaptivePerformanceRuntime,
	resetAdaptivePerformanceRuntime,
	setAdaptivePerformanceConfiguration,
	simulateAdaptivePerformanceState,
} from "../../src/mcp/mobile/adaptive-performance";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

describe("mcp/adaptive-performance", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				mobile: { forceUpdate: vi.fn() },
				preview: { scene: null as Scene | null },
			},
		},
	} as any;

	beforeEach(() => {
		clearUndoRedo();
		engine = new NullEngine();
		scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Camera", Vector3.Zero(), scene);
		options.editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		clearUndoRedo();
		scene.dispose();
		engine.dispose();
	});

	test("authors an exact configuration with Undo/Redo and rejects stale or unknown changes", () => {
		expect(getAdaptivePerformanceCapabilities()).toMatchObject({ version: 1, mcpTools: { length: 6 }, editorSimulation: { hardwareEvidence: false } });
		expect(getAdaptivePerformanceConfiguration(scene)).toMatchObject({ configuration: { revision: 1, enabled: false, provider: "auto", scalers: { length: 6 } } });

		const configured = setAdaptivePerformanceConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: {
					enabled: true,
					provider: "apple",
					platform: "ios",
					sampleFrames: 2,
					thermalActionDelaySeconds: 0,
					performanceActionDelaySeconds: 600,
					scalers: [
						{ id: "render-scale", enabled: false },
						{ id: "particles", visualImpact: "high" },
					],
				},
			},
			options
		) as any;
		expect(configured).toMatchObject({
			configuration: { revision: 2, enabled: true, provider: "apple", platform: "ios" },
			runtime: { configurationRevision: 2, providerSource: "basic-fallback" },
		});
		expect(configured.configuration.scalers).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "render-scale", enabled: false }), expect.objectContaining({ id: "particles", visualImpact: "high" })])
		);
		expect(() => setAdaptivePerformanceConfiguration(scene, { expectedRevision: 1, changes: { enabled: false } }, options)).toThrow("revision is stale");
		expect(() => setAdaptivePerformanceConfiguration(scene, { expectedRevision: 2, changes: { unknown: true } }, options)).toThrow("unsupported fields");

		undo();
		expect(getAdaptivePerformanceConfiguration(scene)).toMatchObject({ configuration: { revision: 1, enabled: false } });
		redo();
		expect(getAdaptivePerformanceConfiguration(scene)).toMatchObject({ configuration: { revision: 2, enabled: true, provider: "apple" } });
	});

	test("simulates thermal/timing evidence, applies a scaler, resets it, and leases every transient action", () => {
		setAdaptivePerformanceConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: {
					enabled: true,
					provider: "apple",
					platform: "visionos",
					sampleFrames: 2,
					thermalActionDelaySeconds: 0,
					performanceActionDelaySeconds: 600,
				},
			},
			options
		);
		expect(() => simulateAdaptivePerformanceState(scene, { expectedRevision: 1, thermalState: "critical" }, options)).toThrow("revision is stale");
		const simulated = simulateAdaptivePerformanceState(
			scene,
			{ expectedRevision: 2, thermalState: "critical", temperatureLevel: 0.95, lowPowerMode: true, frameTimeMs: 16, repeat: 2 },
			options
		) as any;
		expect(simulated).toMatchObject({
			configurationRevision: 2,
			runtime: {
				thermalWarning: true,
				providerEvents: [{ source: "editor-simulation", thermalState: "critical" }],
				actions: [{ reason: "thermal", direction: "decrease-quality", scalerId: "particles" }],
			},
		});
		expect(scene.particlesEnabled).toBe(false);
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ runtime: { totalFrames: 2, acceptedSamples: 2 } });
		expect(() => resetAdaptivePerformanceRuntime(scene, { expectedRevision: 1 }, options)).toThrow("revision is stale");
		expect(resetAdaptivePerformanceRuntime(scene, { expectedRevision: 2 }, options)).toMatchObject({
			configurationRevision: 2,
			runtime: { lastDecision: "reset", thermalState: "unknown", actions: [], qualityIndex: 1 },
		});
		expect(scene.particlesEnabled).toBe(true);
	});
});
