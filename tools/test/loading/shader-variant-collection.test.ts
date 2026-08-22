import { describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, Scene, SceneSerializer, StandardMaterial, Vector3 } from "@babylonjs/core";

import {
	configureShaderVariantCollection,
	createDefaultShaderVariantCollectionConfiguration,
	disposeShaderVariantCollection,
	getShaderVariantCollectionConfiguration,
	getShaderVariantCollectionFingerprint,
	getShaderVariantCollectionRuntimeStatus,
	normalizeShaderVariantCollectionConfiguration,
	prewarmShaderVariantCollection,
	shaderVariantCollectionMetadataKey,
	traceShaderVariantFrame,
	validateShaderVariantCollection,
} from "../../src/loading/shader-variant-collection";
import { loadScene } from "../../src/loading/loader";

function createScene(): { engine: NullEngine; scene: Scene; material: StandardMaterial } {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const camera = new FreeCamera("Camera", new Vector3(0, 0, -10), scene);
	camera.setTarget(Vector3.Zero());
	scene.activeCamera = camera;
	const material = new StandardMaterial("Surface", scene);
	const mesh = MeshBuilder.CreateBox("Box", {}, scene);
	mesh.material = material;
	return { engine, scene, material };
}

function enable(scene: Scene, overrides: Record<string, unknown> = {}): void {
	scene.metadata = {
		[shaderVariantCollectionMetadataKey]: {
			...createDefaultShaderVariantCollectionConfiguration(),
			enabled: true,
			automaticTracing: true,
			automaticPrewarming: false,
			...overrides,
		},
	};
}

describe("loading/shader-variant-collection", () => {
	test("normalizes defaults and rejects unknown, duplicate, and out-of-range current-version state", () => {
		expect(normalizeShaderVariantCollectionConfiguration(undefined)).toEqual(createDefaultShaderVariantCollectionConfiguration());
		expect(() => normalizeShaderVariantCollectionConfiguration({ ...createDefaultShaderVariantCollectionConfiguration(), unknown: true })).toThrow("unknown field");
		expect(() => normalizeShaderVariantCollectionConfiguration({ ...createDefaultShaderVariantCollectionConfiguration(), maximumVariants: 0 })).toThrow("maximumVariants");
		const variant = {
			id: "0123456789abcdef",
			materialId: "Surface",
			materialClass: "StandardMaterial",
			meshId: "Box",
			subMeshIndex: 0,
			backend: "null",
			clipPlane: false,
			useInstances: false,
			effectKeyHash: "fedcba9876543210",
		};
		expect(() =>
			normalizeShaderVariantCollectionConfiguration({ ...createDefaultShaderVariantCollectionConfiguration(), maximumVariants: 2, variants: [variant, { ...variant }] })
		).toThrow("duplicate variant");
		expect(() =>
			normalizeShaderVariantCollectionConfiguration({
				...createDefaultShaderVariantCollectionConfiguration(),
				variants: [{ ...variant, unknown: true }],
			})
		).toThrow("unknown field");
	});

	test("installs an inactive runtime without tracing when the collection is disabled", async () => {
		const { scene, engine } = createScene();
		const status = await configureShaderVariantCollection(scene);
		expect(status).toMatchObject({ active: false, tracing: false, prewarming: false, variantCount: 0, backend: "null" });
		expect(getShaderVariantCollectionConfiguration(scene)).toEqual(createDefaultShaderVariantCollectionConfiguration());
		expect(scene.metadata?.[shaderVariantCollectionMetadataKey]).toBeUndefined();
		disposeShaderVariantCollection(scene);
		expect(getShaderVariantCollectionRuntimeStatus(scene)).toBeNull();
		scene.dispose();
		engine.dispose();
	});

	test("returns deterministic exact leases and actionable no-write validation", async () => {
		const { scene, engine } = createScene();
		enable(scene);
		await configureShaderVariantCollection(scene);
		scene.render();
		const configuration = getShaderVariantCollectionConfiguration(scene);
		expect(getShaderVariantCollectionFingerprint(configuration)).toMatch(/^[a-f0-9]{16}$/);
		expect(getShaderVariantCollectionFingerprint(structuredClone(configuration))).toBe(getShaderVariantCollectionFingerprint(configuration));
		expect(validateShaderVariantCollection(scene, configuration)).toMatchObject({
			valid: true,
			configurationRevision: 2,
			configurationFingerprint: getShaderVariantCollectionFingerprint(configuration),
			variantCount: 1,
			resolvableVariantCount: 1,
			issues: [],
		});
		scene.meshes[0].dispose();
		expect(validateShaderVariantCollection(scene, configuration)).toMatchObject({
			valid: true,
			resolvableVariantCount: 0,
			issues: [expect.objectContaining({ code: "SVC1002", severity: "warning", action: "remove-stale-variant" })],
		});
		scene.dispose();
		engine.dispose();
	});

	test("automatically traces one actual rendered material/effect variant and deduplicates later frames", async () => {
		const { scene, engine } = createScene();
		enable(scene);
		await configureShaderVariantCollection(scene);
		scene.render();
		const first = getShaderVariantCollectionRuntimeStatus(scene)!;
		expect(first).toMatchObject({ active: true, tracing: true, tracedFrames: 1, tracedVariants: 1, variantCount: 1, backend: "null" });
		const collection = getShaderVariantCollectionConfiguration(scene);
		expect(collection.revision).toBe(2);
		expect(collection.variants[0]).toMatchObject({ materialId: "Surface", materialClass: "StandardMaterial", meshId: "Box", subMeshIndex: 0, backend: "null" });
		expect(collection.variants[0].effectKeyHash).toMatch(/^[a-f0-9]{16}$/);
		scene.render();
		expect(getShaderVariantCollectionRuntimeStatus(scene)).toMatchObject({ tracedFrames: 2, tracedVariants: 1, variantCount: 1 });
		expect(getShaderVariantCollectionConfiguration(scene).revision).toBe(2);
		scene.dispose();
		engine.dispose();
	});

	test("bounds traced collection growth and reports dropped variants", async () => {
		const { scene, engine } = createScene();
		const secondMaterial = new StandardMaterial("Surface2", scene);
		const second = MeshBuilder.CreateSphere("Sphere", {}, scene);
		second.position.x = 2;
		second.material = secondMaterial;
		enable(scene, { maximumVariants: 1 });
		await configureShaderVariantCollection(scene);
		scene.render();
		expect(getShaderVariantCollectionRuntimeStatus(scene)).toMatchObject({ variantCount: 1, tracedVariants: 1, droppedVariants: 1 });
		expect(getShaderVariantCollectionConfiguration(scene).variants).toHaveLength(1);
		scene.dispose();
		engine.dispose();
	});

	test("fails closed instead of overflowing an exact collection revision", async () => {
		const { scene, engine } = createScene();
		enable(scene, { revision: Number.MAX_SAFE_INTEGER });
		await configureShaderVariantCollection(scene);
		scene.render();
		expect(getShaderVariantCollectionRuntimeStatus(scene)).toMatchObject({
			configurationRevision: Number.MAX_SAFE_INTEGER,
			variantCount: 0,
			tracedVariants: 0,
			droppedVariants: 1,
			errors: [expect.stringContaining("Number.MAX_SAFE_INTEGER")],
		});
		scene.dispose();
		engine.dispose();
	});

	test("preserves opaque material and mesh ids exactly when tracing and prewarming", async () => {
		const { scene, engine, material } = createScene();
		material.id = " Surface with spaces ";
		scene.meshes[0].id = " Box with spaces ";
		enable(scene);
		await configureShaderVariantCollection(scene);
		scene.render();
		expect(getShaderVariantCollectionConfiguration(scene).variants[0]).toMatchObject({
			materialId: " Surface with spaces ",
			meshId: " Box with spaces ",
		});
		const compilation = vi.spyOn(material, "forceCompilationAsync").mockResolvedValue();
		expect(await prewarmShaderVariantCollection(scene)).toMatchObject({ prewarmAttempted: 1, prewarmed: 1 });
		expect(compilation).toHaveBeenCalledOnce();
		scene.dispose();
		engine.dispose();
	});

	test("skips ambiguous duplicate resource ids instead of compiling the wrong material", async () => {
		const { scene, engine } = createScene();
		enable(scene);
		await configureShaderVariantCollection(scene);
		scene.render();
		const duplicate = new StandardMaterial("Duplicate", scene);
		duplicate.id = "Surface";
		const compilation = vi.spyOn(duplicate, "forceCompilationAsync").mockResolvedValue();
		expect(await prewarmShaderVariantCollection(scene)).toMatchObject({ prewarmAttempted: 1, prewarmed: 0, prewarmSkipped: 1 });
		expect(compilation).not.toHaveBeenCalled();
		scene.dispose();
		engine.dispose();
	});

	test("prewarms retained variants through Babylon material compilation and shares concurrent calls", async () => {
		const { scene, engine, material } = createScene();
		enable(scene);
		await configureShaderVariantCollection(scene);
		scene.render();
		const compilation = vi.spyOn(material, "forceCompilationAsync").mockResolvedValue();
		const configuration = getShaderVariantCollectionConfiguration(scene);
		scene.metadata[shaderVariantCollectionMetadataKey] = { ...configuration, revision: configuration.revision + 1, automaticTracing: false, automaticPrewarming: true };
		const startup = await configureShaderVariantCollection(scene);
		expect(startup).toMatchObject({ tracing: false, prewarmRuns: 1, prewarmAttempted: 1, prewarmed: 1, prewarmSkipped: 0, prewarmFailed: 0 });
		expect(compilation).toHaveBeenCalledWith(scene.meshes[0], { clipPlane: false, useInstances: false });
		const [left, right] = await Promise.all([prewarmShaderVariantCollection(scene), prewarmShaderVariantCollection(scene)]);
		expect(left.prewarmRuns).toBe(right.prewarmRuns);
		expect(left.prewarmRuns).toBe(2);
		scene.dispose();
		engine.dispose();
	});

	test("skips stale material/mesh records and contains compilation failures", async () => {
		const { scene, engine, material } = createScene();
		enable(scene);
		await configureShaderVariantCollection(scene);
		scene.render();
		material.forceCompilationAsync = vi.fn().mockRejectedValue(new Error("driver compile failed"));
		expect(await prewarmShaderVariantCollection(scene)).toMatchObject({ prewarmAttempted: 1, prewarmFailed: 1, errors: [expect.stringContaining("driver compile failed")] });

		scene.meshes[0].dispose();
		expect(await prewarmShaderVariantCollection(scene)).toMatchObject({ prewarmAttempted: 2, prewarmFailed: 1, prewarmSkipped: 1 });
		expect(() => traceShaderVariantFrame(scene)).not.toThrow();
		scene.dispose();
		expect(getShaderVariantCollectionRuntimeStatus(scene)).toMatchObject({ active: false, tracing: false });
		disposeShaderVariantCollection(scene);
		engine.dispose();
	});

	test("restores and prewarms the retained collection through the exported scene loader", async () => {
		const source = createScene();
		enable(source.scene);
		await configureShaderVariantCollection(source.scene);
		source.scene.render();
		const traced = getShaderVariantCollectionConfiguration(source.scene);
		source.scene.metadata[shaderVariantCollectionMetadataKey] = {
			...traced,
			revision: traced.revision + 1,
			automaticTracing: false,
			automaticPrewarming: true,
		};
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(SceneSerializer.Serialize(source.scene))).toString("base64")}`;
		source.scene.dispose();
		source.engine.dispose();

		const engine = new NullEngine();
		const scene = new Scene(engine);
		await loadScene("", dataUrl, scene, {}, { skipAssetsPreload: true });
		expect(getShaderVariantCollectionRuntimeStatus(scene)).toMatchObject({
			configurationRevision: 3,
			active: true,
			tracing: false,
			prewarmRuns: 1,
			prewarmAttempted: 1,
			prewarmed: 1,
			variantCount: 1,
		});
		scene.dispose();
		engine.dispose();
	});
});
