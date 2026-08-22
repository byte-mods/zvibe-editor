import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, PassPostProcess, Scene, Vector3 } from "babylonjs";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Logger } from "@babylonjs/core/Misc/logger";
import {
	configureOnTileRendering,
	disposeOnTileRendering,
	getCustomRenderPassPostProcesses,
	getOnTileRenderingConfiguration,
	registerOnTileRendererProvider,
	validateOnTileRenderingConfiguration,
} from "babylonjs-editor-tools";

import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";
import { createCustomRenderPass } from "../../src/mcp/rendering/custom-passes";
import {
	applyOnTile,
	createOnTileExtension,
	deleteOnTileExtension,
	getOnTileRendering,
	getOnTileRuntime,
	listOnTileProviders,
	setOnTileExtension,
	setOnTileRendering,
	validateOnTile,
} from "../../src/mcp/rendering/on-tile";

describe("mcp/on-tile rendering", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, preview: { setRenderScene: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
		Object.defineProperty(engine, "webGLVersion", { configurable: true, value: 2 });
		scene = new Scene(engine);
		camera = new FreeCamera("On-Tile Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		scene.metadata = { babylonEditorCustomRenderPasses: [] };
		clearUndoRedo();
		vi.clearAllMocks();
	});

	afterEach(() => {
		disposeOnTileRendering(scene as any);
		scene.dispose();
		engine.dispose();
		clearUndoRedo();
		vi.restoreAllMocks();
	});

	function lease(): { expectedRevision: number; expectedFingerprint: string } {
		const value = getOnTileRendering(scene);
		return { expectedRevision: value.configuration.revision, expectedFingerprint: value.fingerprint };
	}

	test("reads a disabled exact default and rejects malformed current-version state", () => {
		expect(getOnTileRendering(scene)).toMatchObject({
			configuration: { version: 1, revision: 1, enabled: false, validationMode: "warn", tileOnlyMode: false, extensions: [] },
			fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
			validation: { valid: true, backend: "webgl2", nativeTileMemory: false },
			runtime: { active: false, nativeBandwidthMeasurement: null },
		});
		expect(scene.metadata.babylonEditorOnTileRendering).toBeUndefined();
		expect(() => validateOnTileRenderingConfiguration({ ...getOnTileRendering(scene).configuration, surprise: true })).toThrow("unknown field");
	});

	test("authors the policy with exact leases and one Undo/Redo entry", () => {
		const stale = lease();
		const changed = setOnTileRendering(scene, { ...stale, enabled: true, tileOnlyMode: true, validationMode: "enforce" }, options);
		expect(changed).toMatchObject({ configuration: { revision: 2, enabled: true, tileOnlyMode: true }, runtime: { active: true, portableCompositePassCount: 1 } });
		expect(() => setOnTileRendering(scene, { ...stale, enabled: false }, options)).toThrow("state changed");
		undo();
		expect(getOnTileRenderingConfiguration(scene as any, false)).toBeNull();
		redo();
		expect(getOnTileRendering(scene).configuration).toMatchObject({ revision: 2, enabled: true, tileOnlyMode: true });
	});

	test("creates, updates and confirmed-deletes registered fused extension instances", () => {
		expect(listOnTileProviders()).toMatchObject({ count: 2, providers: expect.arrayContaining([expect.objectContaining({ id: "builtin-color-scale", builtIn: true })]) });
		const created = createOnTileExtension(scene, { ...lease(), name: "Grade", providerId: "builtin-color-scale", settings: { amount: 1.25 } }, options);
		expect(created.extension).toMatchObject({ name: "Grade", settings: { amount: 1.25 } });
		const id = created.extension.id;
		const updated = setOnTileExtension(scene, { ...lease(), id, enabled: false, settings: { amount: 2 } }, options);
		expect(updated.configuration.extensions[0]).toMatchObject({ id, enabled: false, settings: { amount: 2 } });
		expect(() => deleteOnTileExtension(scene, { ...lease(), id, confirm: false }, options)).toThrow("confirm: true");
		expect(deleteOnTileExtension(scene, { ...lease(), id, confirm: true }, options)).toMatchObject({ deleted: true, configuration: { extensions: [] } });
	});

	test("detects and reversibly suppresses incompatible graph and camera passes without deleting authored state", () => {
		const external = new PassPostProcess("External Fullscreen", 1, camera);
		const custom = createCustomRenderPass(scene, { name: "External Graph Pass" }, options);
		const before = structuredClone(scene.metadata.babylonEditorCustomRenderPasses);
		const warnings = setOnTileRendering(scene, { ...lease(), enabled: true, tileOnlyMode: true, validationMode: "warn" }, options);
		expect(warnings.validation.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "ONTILE2001", featureId: "External Fullscreen", action: "none" }),
				expect.objectContaining({ code: "ONTILE2002", featureId: custom.id, action: "none" }),
			])
		);
		const enforced = setOnTileRendering(scene, { ...lease(), validationMode: "enforce" }, options);
		expect(enforced.runtime).toMatchObject({ active: true, suppressedCustomPassIds: [custom.id], suppressedCameraPostProcesses: ["External Fullscreen"] });
		expect(scene.metadata.babylonEditorCustomRenderPasses).toEqual(before);
		expect((camera as any)._postProcesses).not.toContain(external);
		setOnTileRendering(scene, { ...lease(), enabled: false }, options);
		expect((camera as any)._postProcesses).toContain(external);
		expect(getCustomRenderPassPostProcesses(camera as any)).toHaveLength(1);
	});

	test("registers a trusted project provider, validates settings, applies one real composite, and restores through the loader hook", () => {
		const unregister = registerOnTileRendererProvider({
			id: "project-warmth",
			displayName: "Project Warmth",
			version: 1,
			description: "Warms the portable fused color.",
			parameters: { warmth: { defaultValue: 0.1, minimum: 0, maximum: 1 } },
			fragmentBody: "color.r += $warmth;",
		});
		try {
			createOnTileExtension(scene, { ...lease(), name: "Warmth", providerId: "project-warmth", settings: { warmth: 0.5 } }, options);
			setOnTileRendering(scene, { ...lease(), enabled: true, tileOnlyMode: true, validationMode: "enforce" }, options);
			expect(validateOnTile(scene)).toMatchObject({ valid: true, portableCompositePassCount: 1, activeExtensionCount: 1 });
			expect(applyOnTile(scene, lease(), options)).toMatchObject({ runtime: { active: true, portableCompositeAttached: true, activeExtensionIds: [expect.any(String)] } });
			expect(Object.keys(Effect.ShadersStore).filter((key) => key.startsWith("zvibeOnTile_")).length).toBe(1);
			scene.render();
			expect(getOnTileRuntime(scene)).toMatchObject({ portableCompositePassCount: 1, nativeTileMemory: false, nativeBandwidthMeasurement: null });
			disposeOnTileRendering(scene as any);
			expect(Object.keys(Effect.ShadersStore).filter((key) => key.startsWith("zvibeOnTile_")).length).toBe(0);
			configureOnTileRendering(scene as any);
			scene.render();
			expect(getOnTileRuntime(scene).active).toBe(true);
		} finally {
			unregister();
		}
	});

	test("caches disabled restore and reports an invalid exported policy only once instead of retrying every frame", () => {
		const pass = createCustomRenderPass(scene, { name: "Restored Once" }, options);
		setOnTileRendering(scene, { ...lease(), enabled: false }, options);
		const restored = getCustomRenderPassPostProcesses(camera as any)[0];
		configureOnTileRendering(scene as any);
		scene.render();
		scene.render();
		expect(getCustomRenderPassPostProcesses(camera as any)[0]).toBe(restored);
		expect(scene.metadata.babylonEditorCustomRenderPasses[0].id).toBe(pass.id);

		disposeOnTileRendering(scene as any);
		const configuration = getOnTileRendering(scene).configuration;
		scene.metadata.babylonEditorOnTileRendering = {
			...configuration,
			revision: configuration.revision + 1,
			enabled: true,
			tileOnlyMode: true,
			extensions: [{ id: "missing", name: "Missing", providerId: "missing-provider", enabled: true, order: 0, settings: {} }],
		};
		const logger = vi.spyOn(Logger, "Error").mockImplementation(() => undefined);
		configureOnTileRendering(scene as any);
		scene.render();
		scene.render();
		expect(logger).toHaveBeenCalledTimes(1);
		expect(getOnTileRuntime(scene).error).toContain("unregistered provider");
	});
});
