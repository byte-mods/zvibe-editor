import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "babylonjs";

import {
	applyXRSimulationInput,
	createXRInteractable,
	deleteXRInteractable,
	getXRAuthoringSnapshot,
	getXRCapabilities,
	getXRConfiguration,
	getXRRuntimeState,
	getXRSimulationState,
	initializeXRRuntime,
	enterXRRuntimeSession,
	exitXRRuntimeSession,
	reconfigureXRRuntime,
	restoreXRAuthoringSnapshot,
	setXRConfiguration,
	setXRInteractable,
	startXRDesktopSimulation,
	stopXRDesktopSimulation,
	validateXRConfigurationTarget,
} from "../../src/mcp/xr/xr";
import { XRSceneInspector } from "../../src/editor/layout/inspector/scene/xr";
import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";

describe("mcp/xr editor actions", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("camera", Vector3.Zero(), scene);
		options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("migrates defaults and advertises the portable capability/provider boundary", async () => {
		expect(getXRConfiguration(scene)).toMatchObject({ version: 2, revision: 1, enabled: false, origin: { originNodeId: null, worldScale: 100 } });
		expect(getXRCapabilities(scene)).toMatchObject({
			configurationVersion: 2,
			configurationRevision: 1,
			sessionModes: ["immersive-vr", "immersive-ar"],
			interactionModes: ["select", "grab", "teleport"],
			portableTargets: ["web", "electron-web"],
			nativeProviderBoundary: ["native-openxr", "visionos", "arcore", "arkit"],
		});
		await expect(initializeXRRuntime(scene, { expectedRevision: 1 }, options)).rejects.toThrow("XR is disabled");
	});

	test("deep-merges exact configuration changes under a stale-safe revision lease", async () => {
		const updated = await setXRConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: {
					enabled: true,
					session: { mode: "immersive-ar", optionalFeatures: ["hit-test"] },
					simulation: { enabled: true, rightController: { position: [1, 2, 3] } },
				},
			},
			options
		);
		expect(updated).toMatchObject({
			revision: 2,
			enabled: true,
			session: { mode: "immersive-ar", referenceSpaceType: "local-floor", optionalFeatures: ["hit-test"] },
			simulation: { enabled: true, rightController: { enabled: true, position: [1, 2, 3], rotation: [0, 0, 0] } },
		});
		expect(options.editor.layout.inspector.setEditedObject).toHaveBeenCalledWith(scene);
		await expect(setXRConfiguration(scene, { expectedRevision: 1, changes: { enabled: false } }, options)).rejects.toThrow("revision is stale");
		await expect(setXRConfiguration(scene, { expectedRevision: 2, changes: {} }, options)).rejects.toThrow("at least one field");
		await expect(setXRConfiguration(scene, { expectedRevision: 2, changes: { session: { unknown: true } } }, options)).rejects.toThrow("unsupported fields");
		await expect(setXRConfiguration(scene, { expectedRevision: 2, changes: { enabled: "true" } }, options)).rejects.toThrow("must be a boolean");
	});

	test("returns inspectable MCP snapshots when browser XR policy blocks session entry or exit", async () => {
		const configuration = await setXRConfiguration(scene, { expectedRevision: 1, changes: { enabled: true } }, options);
		const initialized = await initializeXRRuntime(scene, { expectedRevision: configuration.revision }, options);
		expect(initialized).toMatchObject({ configurationRevision: configuration.revision, phase: expect.any(String) });
		const reconfigured = await reconfigureXRRuntime(scene, { expectedRevision: configuration.revision }, options);
		expect(reconfigured).toMatchObject({ configurationRevision: configuration.revision, phase: expect.any(String) });
		const entered = await enterXRRuntimeSession(scene, { expectedRevision: configuration.revision }, options);
		expect(entered).toMatchObject({ configurationRevision: configuration.revision, requestSucceeded: false, requestError: expect.any(String) });
		const exited = await exitXRRuntimeSession(scene, { expectedRevision: configuration.revision }, options);
		expect(exited).toMatchObject({ configurationRevision: configuration.revision, requestSucceeded: expect.any(Boolean) });
	});

	test("creates, updates, and confirmation-deletes stable interactables with complete revision results", async () => {
		const mesh = MeshBuilder.CreateBox("box", {}, scene);
		const created = await createXRInteractable(
			scene,
			{
				expectedRevision: 1,
				interactable: { id: "box-interaction", name: "Box", meshId: mesh.id, modes: ["select", "grab"], interactionLayers: ["gameplay"] },
			},
			options
		);
		expect(created).toMatchObject({ configuration: { revision: 2 }, interactable: { id: "box-interaction", enabled: true, dragSmoothing: 0.2 } });
		const updated = await setXRInteractable(scene, { expectedRevision: 2, id: "box-interaction", changes: { name: "Grab Box", hapticAmplitude: 0.5 } }, options);
		expect(updated).toMatchObject({ configuration: { revision: 3 }, interactable: { id: "box-interaction", name: "Grab Box", hapticAmplitude: 0.5 } });
		await expect(setXRInteractable(scene, { expectedRevision: 3, id: "box-interaction", changes: {} }, options)).rejects.toThrow("at least one field");
		await expect(deleteXRInteractable(scene, { expectedRevision: 3, id: "box-interaction", confirm: false }, options)).rejects.toThrow("confirm=true");
		expect(await deleteXRInteractable(scene, { expectedRevision: 3, id: "box-interaction", confirm: true }, options)).toMatchObject({
			deleted: true,
			id: "box-interaction",
			configuration: { revision: 4, interactables: [] },
		});
	});

	test("captures/restores canonical authoring snapshots and validates real scene references", async () => {
		const floor = MeshBuilder.CreateGround("floor", {}, scene);
		const before = getXRAuthoringSnapshot(scene);
		await setXRConfiguration(
			scene,
			{ expectedRevision: 1, changes: { enabled: true, origin: { cameraId: "camera", floorMeshIds: [floor.id] }, interaction: { handTracking: false } } },
			options
		);
		expect(await validateXRConfigurationTarget(scene, { target: "web" })).toMatchObject({ valid: true, configurationRevision: 2, errors: [] });
		expect(await restoreXRAuthoringSnapshot(scene, before, options)).toMatchObject({ revision: 1, enabled: false });
		expect(await validateXRConfigurationTarget(scene, { target: "web" })).toMatchObject({ valid: false, errors: [expect.objectContaining({ code: "XR_DISABLED" })] });
		await expect(validateXRConfigurationTarget(scene, { target: "native-openxr" })).rejects.toThrow("Unsupported XR validation target");
	});

	test("starts, drives, reads, and stops the desktop simulator under the authoring revision", async () => {
		await setXRConfiguration(
			scene,
			{ expectedRevision: 1, changes: { enabled: true, simulation: { enabled: true }, interaction: { handTracking: false }, locomotion: { teleportation: false } } },
			options
		);
		expect(startXRDesktopSimulation(scene, { expectedRevision: 2 }, options)).toMatchObject({ phase: "active", configurationRevision: 2 });
		expect(applyXRSimulationInput(scene, { expectedRevision: 2, input: { type: "set-pose", device: "right", position: [1, 1, 1] } }, options)).toMatchObject({
			phase: "active",
			devices: expect.arrayContaining([expect.objectContaining({ device: "right", position: [1, 1, 1] })]),
		});
		expect(getXRSimulationState(scene)).toMatchObject({ configurationRevision: 2, simulation: { phase: "active" } });
		expect(stopXRDesktopSimulation(scene, { expectedRevision: 2 }, options)).toMatchObject({ phase: "stopped" });
		expect(getXRSimulationState(scene).simulation).toBeNull();
		expect(getXRRuntimeState(scene)).toEqual({ configurationRevision: 2, runtime: null });
		expect(getXRRuntimeState(scene, { endpoint: "get_xr_runtime", collaborationToken: "transport-only" })).toEqual({ configurationRevision: 2, runtime: null });
		expect(() => getXRRuntimeState(scene, { traceLimit: 5000 })).toThrow("between 0 and 4096");
	});

	test("renders the complete Scene Inspector XR authoring surface", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const markup = renderToStaticMarkup(createElement(XRSceneInspector, { scene, editor: options.editor }));
		for (const label of [
			"XR / WebXR",
			"Session &amp; provider",
			"XR Origin",
			"Interaction &amp; locomotion",
			"Interactables",
			"Desktop XR Simulation",
			"Validation &amp; runtime",
		]) {
			expect(markup).toContain(label);
		}
		expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
		consoleError.mockRestore();
	});

	test("maps and advertises the complete external XR endpoint family", () => {
		for (const endpoint of [
			"get_xr_capabilities",
			"get_xr_configuration",
			"set_xr_configuration",
			"create_xr_interactable",
			"set_xr_interactable",
			"delete_xr_interactable",
			"validate_xr_target",
			"get_xr_runtime",
			"initialize_xr_runtime",
			"reconfigure_xr_runtime",
			"enter_xr_session",
			"exit_xr_session",
			"get_xr_simulation",
			"start_xr_simulation",
			"simulate_xr_input",
			"stop_xr_simulation",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(scene, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			webXRPlatformIntegration: true,
			webXRSessionLifecycle: true,
			webXRInteractionToolkit: true,
			webXRDesktopSimulation: true,
			webXRTargetValidation: true,
			webXRExactRevisionAuthoring: true,
		});
	});
});
