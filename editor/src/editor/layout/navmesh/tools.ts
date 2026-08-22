import { Scene, AbstractMesh, Vector3, Quaternion, Mesh } from "babylonjs";
import { GetPositionsAndIndices } from "babylonjs-addons";
import { INavMeshSurfaceGeometry } from "babylonjs-editor-tools";

import { isInstancedMesh, isMesh } from "../../../tools/guards/nodes";
import { setNodeSerializable, setNodeVisibleInGraph } from "../../../tools/node/metadata";

import { INavMeshObstacleConfiguration, INavMeshStaticMeshConfiguration } from "./types";

export function getStaticMeshes(scene: Scene, configurations: INavMeshStaticMeshConfiguration[]) {
	const clonedMeshes: AbstractMesh[] = [];

	const staticMeshEntries = configurations
		.filter((config) => config.enabled)
		.map((config) => {
			const mesh = scene.getNodeById(config.id);
			if (!mesh || isMesh(mesh)) {
				return mesh ? { mesh, config } : null;
			}

			if (isInstancedMesh(mesh)) {
				const clone = mesh.sourceMesh.clone("mergedClone", null, true, false);
				clone.metadata = null;
				clone.position.copyFrom(mesh.position);
				clone.rotation.copyFrom(mesh.rotation);
				clone.scaling.copyFrom(mesh.scaling);

				if (mesh.rotationQuaternion) {
					clone.rotationQuaternion = mesh.rotationQuaternion.clone();
				}

				clone.setEnabled(false);

				setNodeSerializable(clone, false);
				setNodeVisibleInGraph(clone, false);

				clonedMeshes.push(clone);

				return { mesh: clone, config };
			}

			return null;
		});

	const effectiveStaticMeshEntries = staticMeshEntries.filter((entry) => entry !== null);

	return {
		clonedMeshes,
		effectiveStaticMeshes: effectiveStaticMeshEntries.map((entry) => entry.mesh),
		effectiveStaticMeshEntries,
	};
}

/** Flattens each enabled source mesh separately so every generated triangle retains its authored area id. */
export function getNavMeshSurfaceGeometry(entries: ReturnType<typeof getStaticMeshes>["effectiveStaticMeshEntries"], doNotReverseIndices = false): INavMeshSurfaceGeometry {
	const positions: number[] = [];
	const indices: number[] = [];
	const triangleAreaIds: number[] = [];
	let vertexOffset = 0;

	for (const entry of entries) {
		const [meshPositions, meshIndices] = GetPositionsAndIndices([entry.mesh as Mesh], { doNotReverseIndices });
		for (const position of meshPositions) {
			positions.push(position);
		}
		for (const index of meshIndices) {
			indices.push(index + vertexOffset);
		}
		for (let triangleIndex = 0; triangleIndex < meshIndices.length / 3; triangleIndex++) {
			triangleAreaIds.push(entry.config.area ?? 0);
		}
		vertexOffset += meshPositions.length / 3;
	}

	return { positions, indices, triangleAreaIds };
}

export function getObstacleMeshes(scene: Scene, configurations: INavMeshObstacleConfiguration[]) {
	const position = Vector3.Zero();
	const rotationQuaternion = Quaternion.Identity();
	const scaling = Vector3.One();

	const obstacleMeshes = configurations
		.filter((config) => config.enabled && config.carving !== false)
		.map((config) => {
			const mesh = scene.getNodeById(config.id);
			if (!mesh) {
				return null;
			}

			const effectiveMesh = isMesh(mesh) ? mesh : isInstancedMesh(mesh) ? mesh.sourceMesh : null;

			if (!effectiveMesh) {
				return null;
			}

			const matrix = mesh.computeWorldMatrix(true);
			matrix.decompose(scaling, rotationQuaternion, position);

			const clone = effectiveMesh.clone("obstacleClone", null, true, false);
			clone.parent = null;
			clone.metadata = null;
			clone.position.copyFrom(position);
			clone.scaling.copyFrom(scaling);
			clone.rotationQuaternion = rotationQuaternion.clone();

			setNodeSerializable(clone, false);
			setNodeVisibleInGraph(clone, false);

			return {
				clone,
				config,
			};
		});

	return obstacleMeshes.filter((mesh) => mesh !== null);
}
