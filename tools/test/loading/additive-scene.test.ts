import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import "@babylonjs/core/Materials/imageProcessingConfiguration";

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SceneSerializer } from "@babylonjs/core/Misc/sceneSerializer";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, test } from "vitest";
import { Buffer } from "node:buffer";

import { loadSceneAdditive, unloadSceneAdditive } from "../../src/loading/additive-scene";

function createSerializedScene(id = "additive-mesh", name = "Additive mesh"): string {
	const source = new Scene(new NullEngine());
	source.metadata = {
		name: "Additive configuration",
		scripts: [{ key: "scene-script", enabled: true, values: {} }],
	};
	source.clearColor = new Color4(0.1, 0.2, 0.3, 1);
	const mesh = new Mesh(name, source);
	mesh.id = id;
	mesh.metadata = { scripts: [{ key: "mesh-script", enabled: true, values: {} }] };
	mesh.material = new StandardMaterial("Additive material", source);
	const serialized = SceneSerializer.Serialize(source);
	source.dispose();
	return `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
}

describe("runtime additive scene lifecycle", () => {
	test("loads exact scene content without replacing the running scene configuration and unloads idempotently", async () => {
		const scene = new Scene(new NullEngine());
		const baseMetadata = { name: "Base configuration" };
		scene.metadata = baseMetadata;
		scene.clearColor = new Color4(0.9, 0.8, 0.7, 1);
		const baseCamera = new ArcRotateCamera("Base camera", 0, 0, 10, Vector3.Zero(), scene);
		scene.activeCamera = baseCamera;
		const baseMesh = new Mesh("Base mesh", scene);

		let starts = 0;
		let stops = 0;
		const handle = await loadSceneAdditive("", createSerializedScene(), scene, {
			"scene-script": {
				onStart: () => starts++,
				onStop: () => stops++,
			},
			"mesh-script": {
				onStart: () => starts++,
				onStop: () => stops++,
			},
		});

		expect(handle.state).toBe("loaded");
		expect(handle.rootNodes.map((node) => node.name)).toEqual(["Additive mesh"]);
		expect(handle.getNodeById("additive-mesh")?.name).toBe("Additive mesh");
		expect(handle.resourceCounts).toMatchObject({ meshes: 1, materials: 1 });
		expect(scene.metadata).toMatchObject(baseMetadata);
		expect(scene.metadata.scripts).toBeUndefined();
		expect(scene.clearColor.asArray()).toEqual([0.9, 0.8, 0.7, 1]);
		expect(scene.activeCamera).toBe(baseCamera);
		expect(scene.meshes).toContain(baseMesh);
		expect(scene.getMeshById("additive-mesh")).not.toBeNull();

		scene.render();
		expect(starts).toBe(2);

		const first = await handle.unload();
		expect(first).toMatchObject({ unloaded: true, retainedSharedResources: 0 });
		expect(handle.state).toBe("unloaded");
		expect(scene.getMeshById("additive-mesh")).toBeNull();
		expect(scene.meshes).toContain(baseMesh);
		expect(scene.activeCamera).toBe(baseCamera);
		expect(scene.metadata).toBe(baseMetadata);
		expect(stops).toBe(2);

		const second = await unloadSceneAdditive(handle);
		expect(second).toEqual(first);
		scene.dispose();
	});

	test("serializes concurrent loads and supports unloading handles in any order", async () => {
		const scene = new Scene(new NullEngine());
		const [first, second] = await Promise.all([
			loadSceneAdditive("", createSerializedScene("first", "First"), scene, {}),
			loadSceneAdditive("", createSerializedScene("second", "Second"), scene, {}),
		]);
		expect(scene.getMeshById("first")?.name).toBe("First");
		expect(scene.getMeshById("second")?.name).toBe("Second");

		await first.unload();
		expect(scene.getMeshById("first")).toBeNull();
		expect(scene.getMeshById("second")?.name).toBe("Second");
		await second.unload();
		expect(scene.meshes).toHaveLength(0);
		scene.dispose();
	});

	test("rejects ambiguous duplicate node ids without changing the running scene", async () => {
		const scene = new Scene(new NullEngine());
		const base = new Mesh("Base", scene);
		base.id = "duplicate";

		await expect(loadSceneAdditive("", createSerializedScene("duplicate", "Duplicate"), scene, {})).rejects.toThrow('node id "duplicate" is already present');
		expect(scene.meshes).toEqual([base]);
		scene.dispose();
	});

	test("retains an additive material when content outside the handle starts sharing it", async () => {
		const scene = new Scene(new NullEngine());
		const baseMesh = new Mesh("Base mesh", scene);
		const handle = await loadSceneAdditive("", createSerializedScene(), scene, {});
		const material = scene.getMaterialByName("Additive material")!;
		const additiveMesh = scene.getMeshById("additive-mesh")!;
		const sharedMultiMaterial = new MultiMaterial("Base multi material", scene);
		sharedMultiMaterial.subMaterials.push(material);
		baseMesh.material = sharedMultiMaterial;
		baseMesh.position.set(2, 3, 4);
		baseMesh.setParent(additiveMesh);
		const worldPosition = baseMesh.getAbsolutePosition().clone();

		const result = await handle.unload();

		expect(result.retainedSharedResources).toBe(1);
		expect(scene.materials).toContain(material);
		expect(baseMesh.material).toBe(sharedMultiMaterial);
		expect(sharedMultiMaterial.subMaterials).toContain(material);
		expect(baseMesh.isDisposed()).toBe(false);
		expect(baseMesh.parent).toBeNull();
		expect(baseMesh.getAbsolutePosition().asArray()).toEqual(worldPosition.asArray());
		scene.dispose();
	});

	test("rolls back loaded resources when runtime configuration throws", async () => {
		const scene = new Scene(new NullEngine());
		const baseMesh = new Mesh("Base mesh", scene);
		class BrokenScript {
			public constructor() {
				throw new Error("broken additive script");
			}
		}

		await expect(
			loadSceneAdditive("", createSerializedScene(), scene, {
				"mesh-script": { default: BrokenScript },
			})
		).rejects.toThrow("broken additive script");
		expect(scene.meshes).toEqual([baseMesh]);
		expect(scene.getMaterialByName("Additive material")).toBeNull();
		scene.dispose();
	});
});
