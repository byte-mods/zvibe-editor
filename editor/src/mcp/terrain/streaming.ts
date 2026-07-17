import { Scene, Tools, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

interface ITerrainStreamingGroup {
	id: string;
	name: string;
	terrainIds: string[];
	distance: number;
	targetNodeId?: string;
	enabled: boolean;
	releaseGeometry?: boolean;
}

const configuredScenes = new WeakSet<Scene>();
const releasedGeometry = new WeakMap<Scene, Map<string, { vertices: Array<{ kind: string; data: number[] }>; indices: number[] }>>();

function groups(scene: Scene): ITerrainStreamingGroup[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorTerrainStreamingGroups ??= [];
	return scene.metadata.babylonEditorTerrainStreamingGroups;
}

function find(scene: Scene, data: any): ITerrainStreamingGroup {
	const result = groups(scene).find((value) => value.id === data.groupId || value.name === data.name);
	if (!result) throw new Error("Terrain streaming group not found.");
	return result;
}

function apply(scene: Scene, group: ITerrainStreamingGroup): void {
	if (!group.enabled) {
		for (const terrainId of group.terrainIds) {
			const terrain = scene.getNodeById(terrainId) as any;
			restoreGeometry(scene, terrain);
			terrain?.setEnabled?.(true);
		}
		return;
	}
	const target = group.targetNodeId ? resolveNode({ scene, nodeId: group.targetNodeId }) : scene.activeCamera;
	if (!target || !(target as any).position) return;
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

function configure(scene: Scene): void {
	if (configuredScenes.has(scene)) return;
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => groups(scene).forEach((group) => apply(scene, group)));
}

/** Lists persisted distance-based terrain streaming groups. */
export function listTerrainStreamingGroups(scene: Scene): any {
	return { groups: structuredClone(groups(scene)) };
}

/** Creates or updates a group of Ground terrains that activates near a camera or node. */
export function setTerrainStreamingGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!Array.isArray(data.terrainIds) || !data.terrainIds.length) throw new Error("A terrain streaming group requires at least one terrain id.");
	if (!Number.isFinite(data.distance) || data.distance <= 0) throw new Error("Terrain streaming distance must be greater than zero.");
	for (const terrainId of data.terrainIds) {
		const terrain = resolveNode({ scene, nodeId: terrainId }) as any;
		if (terrain.metadata?.type !== "Ground") throw new Error(`Node \"${terrain.name}\" is not an editor Ground terrain.`);
	}
	if (data.targetNodeId) resolveNode({ scene, nodeId: data.targetNodeId });
	const existing = data.groupId ? find(scene, data) : undefined;
	if (!existing && groups(scene).some((value) => value.name === data.name)) throw new Error(`Terrain streaming group \"${data.name}\" already exists.`);
	const value = existing ?? {
		id: Tools.RandomId(),
		name: data.name,
		terrainIds: data.terrainIds,
		distance: data.distance,
		targetNodeId: data.targetNodeId,
		enabled: data.enabled ?? true,
		releaseGeometry: data.releaseGeometry ?? false,
	};
	value.name = data.name ?? value.name;
	value.terrainIds = [...data.terrainIds];
	value.distance = data.distance;
	value.targetNodeId = data.targetNodeId;
	value.enabled = data.enabled ?? value.enabled;
	value.releaseGeometry = data.releaseGeometry ?? value.releaseGeometry ?? false;
	if (!existing) groups(scene).push(value);
	configure(scene);
	apply(scene, value);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Deletes a terrain streaming group and restores all of its tiles. */
export function deleteTerrainStreamingGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	groups(scene).splice(groups(scene).indexOf(value), 1);
	for (const terrainId of value.terrainIds) {
		const terrain = scene.getNodeById(terrainId) as any;
		restoreGeometry(scene, terrain);
		terrain?.setEnabled?.(true);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}
