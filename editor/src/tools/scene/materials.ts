import { AbstractMesh, Material, Scene } from "babylonjs";

import { isInstancedMesh } from "../guards/nodes";

/**
 * Force compile all materials of the given scene.
 * This is useful to ensure that all materials are compiled and ready to use to avoid lag in the editor.
 * @param scene The scene to force compile all materials
 */
async function forceCompilationUntilSceneDisposes(scene: Scene, material: Material, mesh: AbstractMesh): Promise<void> {
	if (scene.isDisposed) {
		return;
	}

	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const observer = scene.onDisposeObservable.addOnce(() => {
			settled = true;
			resolve();
		});
		material
			.forceCompilationAsync(mesh, {
				clipPlane: !!scene.clipPlane,
				useInstances: mesh.hasInstances,
			})
			.then(
				() => {
					if (!settled) {
						scene.onDisposeObservable.remove(observer);
						resolve();
					}
				},
				(error) => {
					if (!settled) {
						scene.onDisposeObservable.remove(observer);
						reject(error);
					}
				}
			);
	});
}

export async function forceCompileAllSceneMaterials(scene: Scene): Promise<void> {
	return Promise.all(
		scene.materials.map(async (material) => {
			const meshes = material.getBindedMeshes();

			await Promise.all(
				meshes.map(async (mesh) => {
					if (isInstancedMesh(mesh)) {
						return;
					}

					await forceCompilationUntilSceneDisposes(scene, material, mesh);
				})
			);
		})
	).then(() => undefined);
}
