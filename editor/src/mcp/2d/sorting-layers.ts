import { Scene, Tools } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

function layers(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorSortingLayers ??= []);
}

export function listSortingLayers(scene: Scene): any {
	return { layers: structuredClone(layers(scene)) };
}

export function createSortingLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (layers(scene).some((layer) => layer.name === data.name)) {
		throw new Error(`Sorting layer "${data.name}" already exists.`);
	}
	const layer = { id: Tools.RandomId(), name: data.name, order: data.order ?? layers(scene).length };
	if (!Number.isInteger(layer.order) || layer.order < 0 || layer.order > 3) {
		throw new Error("Sorting layer order must be an integer from 0 to 3.");
	}
	layers(scene).push(layer);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(layer);
}

export function deleteSortingLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a sorting layer requires confirm=true.");
	}
	const index = layers(scene).findIndex((layer) => layer.id === data.layerId || layer.name === data.layerName);
	if (index === -1) {
		throw new Error("Sorting layer not found.");
	}
	const [layer] = layers(scene).splice(index, 1);
	let clearedNodeCount = 0;
	for (const node of [...scene.meshes, ...scene.transformNodes] as any[]) {
		if (node.metadata?.babylonEditorSortingLayer?.id !== layer.id) {
			continue;
		}
		delete node.metadata.babylonEditorSortingLayer;
		if (node.renderingGroupId !== undefined) {
			node.renderingGroupId = 0;
			node.alphaIndex = 0;
		}
		clearedNodeCount++;
	}
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, layer: structuredClone(layer), clearedNodeCount };
}

export function setNodeSortingLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const layer = layers(scene).find((value) => value.id === data.layerId || value.name === data.layerName);
	if (!layer) {
		throw new Error("Sorting layer not found.");
	}
	const node: any = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (node.renderingGroupId === undefined) {
		throw new Error(`Node "${node.name}" does not support render sorting.`);
	}
	node.renderingGroupId = layer.order;
	node.alphaIndex = data.orderInLayer ?? 0;
	node.metadata ??= {};
	node.metadata.babylonEditorSortingLayer = { id: layer.id, orderInLayer: node.alphaIndex };
	options.editor.layout.inspector.forceUpdate();
	return { nodeId: node.id, layer: structuredClone(layer), orderInLayer: node.alphaIndex };
}
