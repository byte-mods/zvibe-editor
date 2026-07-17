import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

type ITerrainStreamingGroup = { terrainIds: string[]; distance: number; targetNodeId?: string; enabled: boolean; releaseGeometry?: boolean };

const releasedGeometry = new WeakMap<Scene, Map<string, { vertices: Array<{ kind: string; data: number[] }>; indices: number[] }>>();

/** Restores distance-based Ground tile activation. Tiles remain serialized in the scene, avoiding loader churn while culling off-range terrain. */
export function configureTerrainStreaming(scene: Scene): void {
	const groups = scene.metadata?.babylonEditorTerrainStreamingGroups as ITerrainStreamingGroup[] | undefined;
	if (!groups?.length) return;
	scene.onBeforeRenderObservable.add(() => {
		for (const group of groups) {
			if (!group.enabled) {
				for (const terrainId of group.terrainIds) {
					const terrain = scene.getNodeById(terrainId) as any;
					restoreGeometry(scene, terrain);
					terrain?.setEnabled?.(true);
				}
				continue;
			}
			const target = group.targetNodeId ? scene.getNodeById(group.targetNodeId) : scene.activeCamera;
			if (!(target as any)?.position) continue;
			(target as any).computeWorldMatrix?.(true);
			const targetPosition = (target as any).getAbsolutePosition?.() ?? (target as any).position;
			for (const terrainId of group.terrainIds) {
				const terrain = scene.getNodeById(terrainId) as any;
				if (!terrain?.setEnabled || !terrain.getAbsolutePosition) continue;
				terrain.computeWorldMatrix?.(true);
				const enabled = Vector3.Distance(targetPosition, terrain.getAbsolutePosition()) <= group.distance;
				if (enabled) restoreGeometry(scene, terrain);
				else if (group.releaseGeometry) releaseGeometry(scene, terrain);
				terrain.setEnabled(enabled);
			}
		}
	});
}

function releaseGeometry(scene: Scene, terrain: any): void {
	const snapshots = releasedGeometry.get(scene) ?? new Map();
	if (snapshots.has(terrain.id)) return;
	const vertices = terrain.getVerticesDataKinds().map((kind: string) => ({ kind, data: Array.from(terrain.getVerticesData(kind) ?? []) }));
	const indices = Array.from(terrain.getIndices() ?? []);
	if (!vertices.length || !indices.length) return;
	snapshots.set(terrain.id, { vertices, indices });
	releasedGeometry.set(scene, snapshots);
	terrain.geometry?.dispose();
}

function restoreGeometry(scene: Scene, terrain: any): void {
	if (!terrain) return;
	const snapshot = releasedGeometry.get(scene)?.get(terrain.id);
	if (!snapshot) return;
	snapshot.vertices.forEach(({ kind, data }) => terrain.setVerticesData(kind, Float32Array.from(data)));
	terrain.setIndices(snapshot.indices);
	releasedGeometry.get(scene)?.delete(terrain.id);
}
