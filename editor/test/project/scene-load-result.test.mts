import { MeshBuilder, NullEngine, PointLight, Scene, StandardMaterial, TransformNode, Vector3 } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import {
	captureAddedSceneResources,
	createSceneLoadLookupScope,
	createSceneLoadResult,
	disposeSceneLoadResult,
	getSceneLoadResultObjects,
	resolveSceneLoadResultParents,
	snapshotSceneResources,
} from "../../src/project/load/result";

const scenes: Scene[] = [];

afterEach(() => scenes.splice(0).forEach((scene) => scene.dispose()));

function createScene(): Scene {
	const scene = new Scene(new NullEngine());
	scenes.push(scene);
	return scene;
}

describe("project/load/scene result ownership", () => {
	test("resolves duplicate unique IDs only inside the authored load", () => {
		const scene = createScene();
		const priorSceneParent = new TransformNode("Prior", scene);
		priorSceneParent.uniqueId = 41;
		const localParent = new TransformNode("Local", scene);
		localParent.uniqueId = 41;
		const localChild = new TransformNode("Child", scene);
		localChild.metadata = { _waitingParentId: 41 };
		const result = createSceneLoadResult();
		result.transformNodes.push(localParent, localChild);

		resolveSceneLoadResultParents(result);

		expect(localChild.parent).toBe(localParent);
		expect(localChild.parent).not.toBe(priorSceneParent);
		expect(localChild.metadata._waitingParentId).toBeUndefined();
	});

	test("scopes Babylon parser lookups and collections to one authored scene", () => {
		const scene = createScene();
		const priorLight = new PointLight("Prior", Vector3.Zero(), scene);
		priorLight.id = "shared-light";
		const localLight = new PointLight("Local", Vector3.Zero(), scene);
		localLight.id = "shared-light";
		const localMesh = MeshBuilder.CreateBox("Local Mesh", {}, scene);
		const result = createSceneLoadResult();
		result.lights.push(localLight);
		result.meshes.push(localMesh);
		const scope = createSceneLoadLookupScope(scene, result);

		expect(scene.getLightById("shared-light")).toBe(priorLight);
		expect(scope.getLightById("shared-light")).toBe(localLight);
		expect(scope.meshes).toEqual([localMesh]);
	});

	test("captures a scene-local resource delta and excludes nested-link resources", () => {
		const scene = createScene();
		const snapshot = snapshotSceneResources(scene);
		const ownedMaterial = new StandardMaterial("Owned", scene);
		const nestedMaterial = new StandardMaterial("Nested", scene);
		const result = createSceneLoadResult();

		captureAddedSceneResources(scene, snapshot, result, new Set([nestedMaterial]));

		expect(result.materials).toEqual([ownedMaterial]);
		expect(getSceneLoadResultObjects(result)).toContain(ownedMaterial);
	});

	test("unloads owned nodes while preserving resources referenced by another scene", () => {
		const scene = createScene();
		const ownedMesh = MeshBuilder.CreateBox("Owned", {}, scene);
		const survivor = ownedMesh.clone("Survivor")!;
		const sharedMaterial = new StandardMaterial("Shared", scene);
		ownedMesh.material = sharedMaterial;
		survivor.material = sharedMaterial;
		const sharedGeometry = ownedMesh.geometry!;
		const result = createSceneLoadResult();
		result.meshes.push(ownedMesh);
		result.materials.push(sharedMaterial);
		result.geometries.push(sharedGeometry);

		disposeSceneLoadResult(scene, result);

		expect(scene.meshes).not.toContain(ownedMesh);
		expect(scene.meshes).toContain(survivor);
		expect(scene.materials).toContain(sharedMaterial);
		expect(sharedGeometry.isDisposed()).toBe(false);
	});
});
