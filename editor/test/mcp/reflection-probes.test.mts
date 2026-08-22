import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, ReflectionProbe, Scene, StandardMaterial, Vector3 } from "babylonjs";

import { createReflectionProbe, deleteReflectionProbe, listReflectionProbes, setReflectionProbe } from "../../src/mcp/lights/lights";

describe("mcp/reflection-probes", () => {
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

	test("creates, exact-leases, box-projects, fully reassigns, and safely deletes a realtime reflection probe", () => {
		const mesh = MeshBuilder.CreateBox("Capture Mesh", {}, scene);
		const material = new StandardMaterial("Reflected Material", scene);
		mesh.material = material;
		const probe = createReflectionProbe(
			scene,
			{
				name: "Local",
				position: [1, 2, 3],
				refreshRate: 2,
				samples: 4,
				attachedMeshId: mesh.id,
				renderListIds: [mesh.id],
				intensity: 0.75,
				boxProjection: true,
				influencePosition: [5, 6, 7],
				influenceSize: [100, 200, 300],
				importance: 4,
				blendDistance: 25,
			},
			options
		);
		expect(probe).toMatchObject({
			id: expect.any(String),
			name: "Local",
			revision: 1,
			position: [1, 2, 3],
			refreshRate: 2,
			samples: 4,
			intensity: 0.75,
			boxProjection: true,
			influencePosition: [5, 6, 7],
			influenceSize: [100, 200, 300],
			importance: 4,
			blendDistance: 25,
			blendModel: "unity-priority-box-blend-skybox-v1",
			attachedMeshId: mesh.id,
			renderList: [mesh.id],
			assignedMaterialIds: [],
		});
		const nativeProbe = (scene as any).reflectionProbes[0];
		expect(nativeProbe.cubeTexture.boundingBoxPosition.asArray()).toEqual([5, 6, 7]);
		expect(nativeProbe.cubeTexture.boundingBoxSize.asArray()).toEqual([100, 200, 300]);

		const updated = setReflectionProbe(
			scene,
			{ id: probe.id, expectedRevision: 1, position: [4, 5, 6], attachedMeshId: null, renderListIds: [], assignMaterialIds: [material.id] },
			options
		);
		expect(updated).toMatchObject({ revision: 2, position: [4, 5, 6], influencePosition: [4, 5, 6], attachedMeshId: null, renderList: [], assignedMaterialIds: [material.id] });
		expect(material.reflectionTexture).toBe(nativeProbe.cubeTexture);
		expect((scene as any).reflectionProbes[0].position).toEqual(Vector3.FromArray([4, 5, 6]));
		expect(() => setReflectionProbe(scene, { id: probe.id, expectedRevision: 1, intensity: 2 }, options)).toThrow("changed after inspection");
		expect(setReflectionProbe(scene, { id: probe.id, expectedRevision: 2 }, options)).toMatchObject({ revision: 2 });

		const cleared = setReflectionProbe(scene, { id: probe.id, expectedRevision: 2, assignMaterialIds: [] }, options);
		expect(cleared).toMatchObject({ revision: 3, assignedMaterialIds: [] });
		expect(material.reflectionTexture).toBeNull();
		const reassigned = setReflectionProbe(scene, { id: probe.id, expectedRevision: 3, assignMaterialIds: [material.id] }, options);
		expect(reassigned).toMatchObject({ revision: 4, assignedMaterialIds: [material.id] });
		const runtimeMaterial = new StandardMaterial("Deferred Runtime Clone", scene);
		runtimeMaterial.doNotSerialize = true;
		runtimeMaterial.reflectionTexture = nativeProbe.cubeTexture;
		expect(listReflectionProbes(scene, { id: probe.id })).toMatchObject({ total: 1, count: 1, hasMore: false, probes: [{ revision: 4 }] });
		expect(listReflectionProbes(scene, { id: probe.id }).probes[0].assignedMaterialIds).toEqual([material.id]);
		expect(() => deleteReflectionProbe(scene, { id: probe.id, expectedRevision: 4 }, options)).toThrow("confirm: true");
		expect(deleteReflectionProbe(scene, { id: probe.id, expectedRevision: 4, confirm: true }, options)).toEqual({
			deleted: true,
			id: probe.id,
			name: "Local",
			revision: 4,
			clearedMaterialIds: [material.id],
		});
		expect(material.reflectionTexture).toBeNull();
		expect(runtimeMaterial.reflectionTexture).toBeNull();
		expect(listReflectionProbes(scene).probes).toHaveLength(0);
	});

	test("persists overlapping material assignments, selects the highest-importance native fallback, and rejects invalid blend bounds atomically", () => {
		const mesh = MeshBuilder.CreateBox("Blended Mesh", {}, scene);
		const material = new StandardMaterial("Blended Material", scene);
		mesh.material = material;
		const low = createReflectionProbe(
			scene,
			{
				name: "Low",
				boxProjection: true,
				influenceSize: [100, 100, 100],
				importance: 1,
				blendDistance: 25,
				assignMaterialIds: [material.id],
			},
			options
		);
		const lowNative = (scene as any).reflectionProbes.find((probe: any) => probe.name === "Low");
		expect(material.reflectionTexture).toBe(lowNative.cubeTexture);

		const high = createReflectionProbe(
			scene,
			{
				name: "High",
				boxProjection: true,
				influenceSize: [100, 100, 100],
				importance: 9,
				blendDistance: 10,
				assignMaterialIds: [material.id],
			},
			options
		);
		const highNative = (scene as any).reflectionProbes.find((probe: any) => probe.name === "High");
		expect(material.reflectionTexture).toBe(highNative.cubeTexture);
		expect(listReflectionProbes(scene).probes).toEqual([
			expect.objectContaining({ id: low.id, importance: 1, blendDistance: 25, assignedMaterialIds: [material.id] }),
			expect.objectContaining({ id: high.id, importance: 9, blendDistance: 10, assignedMaterialIds: [material.id] }),
		]);

		expect(() => setReflectionProbe(scene, { id: low.id, expectedRevision: 1, influenceSize: [20, 20, 20] }, options)).toThrow("half the smallest");
		expect(listReflectionProbes(scene, { id: low.id }).probes[0]).toMatchObject({ revision: 1, influenceSize: [100, 100, 100], blendDistance: 25 });
		expect(setReflectionProbe(scene, { id: high.id, expectedRevision: 1, assignMaterialIds: [] }, options)).toMatchObject({ revision: 2, assignedMaterialIds: [] });
		expect(material.reflectionTexture).toBe(lowNative.cubeTexture);

		expect(deleteReflectionProbe(scene, { id: high.id, expectedRevision: 2, confirm: true }, options).clearedMaterialIds).toEqual([]);
		expect(deleteReflectionProbe(scene, { id: low.id, expectedRevision: 1, confirm: true }, options).clearedMaterialIds).toEqual([material.id]);
		expect(material.reflectionTexture).toBeNull();
	});

	test("preserves an authored material cubemap as the deferred blend fallback across assignment and cleanup", () => {
		const material = new StandardMaterial("Authored Cubemap Material", scene);
		const authoredSource = new ReflectionProbe("Unmanaged authored cubemap", 16, scene);
		(scene as any).reflectionProbes.splice((scene as any).reflectionProbes.indexOf(authoredSource), 1);
		const authoredCube = authoredSource.cubeTexture;
		material.reflectionTexture = authoredCube;
		const created = createReflectionProbe(
			scene,
			{
				name: "Cubemap-preserving probe",
				influenceSize: [100, 100, 100],
				blendDistance: 25,
				assignMaterialIds: [material.id],
			},
			options
		);

		expect(material.reflectionTexture).toBe(authoredCube);
		expect(listReflectionProbes(scene, { id: created.id }).probes[0].assignedMaterialIds).toEqual([material.id]);
		expect(deleteReflectionProbe(scene, { id: created.id, expectedRevision: 1, confirm: true }, options).clearedMaterialIds).toEqual([material.id]);
		expect(material.reflectionTexture).toBe(authoredCube);
		authoredSource.dispose();
	});
});
