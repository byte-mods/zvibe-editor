import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, StandardMaterial, Vector3 } from "babylonjs";
import { getShaderVariantCollectionConfiguration, shaderVariantCollectionMetadataKey } from "babylonjs-editor-tools";

import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";
import {
	clearShaderVariants,
	disposeShaderVariantsRuntime,
	getShaderVariants,
	getShaderVariantsRuntime,
	prewarmShaderVariants,
	setShaderVariants,
	traceShaderVariants,
	validateShaderVariants,
} from "../../src/mcp/rendering/shader-variants";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { getEditorCapabilities } from "../../src/mcp/editor";

describe("mcp/shader-variant-collection", () => {
	let engine: NullEngine;
	let scene: Scene;
	let material: StandardMaterial;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, preview: { setRenderScene: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine({ renderWidth: 64, renderHeight: 64 });
		scene = new Scene(engine);
		const camera = new FreeCamera("Camera", new Vector3(0, 0, -10), scene);
		camera.setTarget(Vector3.Zero());
		scene.activeCamera = camera;
		material = new StandardMaterial("Surface", scene);
		const mesh = MeshBuilder.CreateBox("Box", {}, scene);
		mesh.material = material;
		clearUndoRedo();
		vi.clearAllMocks();
	});

	afterEach(() => {
		disposeShaderVariantsRuntime(scene);
		scene.dispose();
		engine.dispose();
		clearUndoRedo();
		vi.restoreAllMocks();
	});

	function lease(): { expectedRevision: number; expectedFingerprint: string } {
		const value = getShaderVariants(scene);
		return { expectedRevision: value.configuration.revision, expectedFingerprint: value.fingerprint };
	}

	test("reads an unpersisted exact default and publishes complete capability/MCP routing", () => {
		expect(getShaderVariants(scene)).toMatchObject({
			configuration: { version: 1, revision: 1, enabled: false, automaticTracing: true, automaticPrewarming: true, variants: [] },
			fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
			validation: { valid: true, variantCount: 0, resolvableVariantCount: 0 },
			runtime: null,
		});
		expect(scene.metadata?.[shaderVariantCollectionMetadataKey]).toBeUndefined();
		expect(
			getEditorCapabilities(scene, {}, { editor: { state: { projectPath: "/project/game.bjseditor", enableExperimentalFeatures: false } } } as any).features
				.shaderVariantAutomaticTracingAndPrewarming
		).toBe(true);
		for (const name of [
			"get_shader_variant_collection",
			"set_shader_variant_collection",
			"clear_shader_variant_collection",
			"trace_shader_variant_frame",
			"prewarm_shader_variant_collection",
			"validate_shader_variant_collection",
			"get_shader_variant_collection_runtime",
		]) {
			expect(MCPEndpoints[name]).toBeTypeOf("function");
		}
		expect(getShaderVariants(scene, { endpoint: "get_shader_variant_collection" })).toMatchObject({ configuration: { revision: 1 } });
		expect(validateShaderVariants(scene, { endpoint: "validate_shader_variant_collection" })).toMatchObject({ valid: true });
		expect(getShaderVariantsRuntime(scene, { endpoint: "get_shader_variant_collection_runtime" })).toBeNull();
		expect(() => getShaderVariants(scene, { unknown: true })).toThrow("unknown field");
	});

	test("authors strict exact settings atomically with Undo/Redo and stale rejection", async () => {
		const initial = lease();
		const changed = await setShaderVariants(
			scene,
			{ ...initial, enabled: true, automaticTracing: false, automaticPrewarming: false, maximumVariants: 32, maximumPrewarmPerLoad: 16 },
			options
		);
		expect(changed).toMatchObject({ configuration: { revision: 2, enabled: true, automaticTracing: false, maximumVariants: 32 }, runtime: { active: true, tracing: false } });
		await expect(setShaderVariants(scene, { ...initial, enabled: false }, options)).rejects.toThrow("changed");
		await expect(setShaderVariants(scene, { ...lease(), enabled: false, unknown: true }, options)).rejects.toThrow("unknown field");
		undo();
		expect(scene.metadata?.[shaderVariantCollectionMetadataKey]).toBeUndefined();
		redo();
		expect(getShaderVariantCollectionConfiguration(scene as any)).toMatchObject({ revision: 2, enabled: true, maximumVariants: 32 });
	});

	test("traces an actual rendered variant with exact leases and Undo/Redo", async () => {
		await setShaderVariants(scene, { ...lease(), enabled: true, automaticTracing: false, automaticPrewarming: false }, options);
		scene.render();
		const traced = await traceShaderVariants(scene, lease(), options);
		expect(traced).toMatchObject({
			configuration: { revision: 3, variants: [expect.objectContaining({ materialId: "Surface", meshId: "Box", backend: "null" })] },
			validation: { valid: true, resolvableVariantCount: 1 },
			runtime: { tracedFrames: 1, tracedVariants: 1 },
		});
		undo();
		expect(getShaderVariants(scene).configuration).toMatchObject({ revision: 2, variants: [] });
		redo();
		expect(getShaderVariants(scene).configuration).toMatchObject({ revision: 3, variants: [expect.any(Object)] });
	});

	test("skips active mesh entries without submeshes", async () => {
		await setShaderVariants(scene, { ...lease(), enabled: true, automaticTracing: false, automaticPrewarming: false }, options);
		vi.spyOn(scene, "getActiveMeshes").mockReturnValue({ length: 1, data: [{ id: "NoSubMeshes" }] } as any);
		await expect(traceShaderVariants(scene, lease(), options)).resolves.toMatchObject({ configuration: { variants: [] } });
	});

	test("prewarms retained variants without authored mutation and reports live evidence", async () => {
		await setShaderVariants(scene, { ...lease(), enabled: true, automaticTracing: false, automaticPrewarming: false }, options);
		scene.render();
		await traceShaderVariants(scene, lease(), options);
		const compilation = vi.spyOn(material, "forceCompilationAsync").mockResolvedValue();
		const before = structuredClone(getShaderVariants(scene).configuration);
		const result = await prewarmShaderVariants(scene, lease());
		expect(result).toMatchObject({ runtime: { prewarmRuns: 1, prewarmAttempted: 1, prewarmed: 1, prewarmFailed: 0 } });
		expect(compilation).toHaveBeenCalledOnce();
		expect(getShaderVariants(scene).configuration).toEqual(before);
		expect(getShaderVariantsRuntime(scene)).toMatchObject({ prewarmed: 1 });
	});

	test("validates stale resources and confirmed clear remains Undo/Redo-able", async () => {
		await setShaderVariants(scene, { ...lease(), enabled: true, automaticTracing: false, automaticPrewarming: false }, options);
		scene.render();
		await traceShaderVariants(scene, lease(), options);
		expect(validateShaderVariants(scene)).toMatchObject({ valid: true, resolvableVariantCount: 1, issues: [] });
		scene.meshes[0].dispose();
		expect(validateShaderVariants(scene)).toMatchObject({
			valid: true,
			resolvableVariantCount: 0,
			issues: [expect.objectContaining({ code: "SVC1002", action: "remove-stale-variant" })],
		});
		await expect(clearShaderVariants(scene, { ...lease(), confirm: false }, options)).rejects.toThrow("confirm: true");
		const cleared = await clearShaderVariants(scene, { ...lease(), confirm: true }, options);
		expect(cleared.configuration).toMatchObject({ revision: 4, variants: [] });
		undo();
		expect(getShaderVariants(scene).configuration.variants).toHaveLength(1);
		redo();
		expect(getShaderVariants(scene).configuration.variants).toHaveLength(0);
	});
});
