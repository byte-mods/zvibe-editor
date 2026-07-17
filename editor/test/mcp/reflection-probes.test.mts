import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, Scene, Vector3 } from "babylonjs";

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

	test("creates, updates, detaches, and deletes a realtime reflection probe", () => {
		const mesh = MeshBuilder.CreateBox("Capture Mesh", {}, scene);
		const probe = createReflectionProbe(scene, { name: "Local", position: [1, 2, 3], refreshRate: 2, samples: 4, attachedMeshId: mesh.id, renderListIds: [mesh.id] }, options);
		expect(probe).toMatchObject({ name: "Local", position: [1, 2, 3], refreshRate: 2, samples: 4, attachedMeshId: mesh.id, renderList: [mesh.id] });

		const updated = setReflectionProbe(scene, { name: "Local", position: [4, 5, 6], attachedMeshId: null, renderListIds: [] }, options);
		expect(updated).toMatchObject({ position: [4, 5, 6], attachedMeshId: null, renderList: [] });
		expect((scene as any).reflectionProbes[0].position).toEqual(Vector3.FromArray([4, 5, 6]));
		expect(listReflectionProbes(scene).probes).toHaveLength(1);
		expect(deleteReflectionProbe(scene, { name: "Local" }, options)).toEqual({ deleted: true, name: "Local" });
	});
});
