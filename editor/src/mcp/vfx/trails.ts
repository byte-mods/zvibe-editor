import { Material, Scene, TrailMesh, TransformNode } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

export interface ITrailConfiguration {
	generatorId: string;
	diameter: number;
	length: number;
	segments: number;
	sections: number;
	doNotTaper: boolean;
	autoStart: boolean;
}

function resolveGenerator(scene: Scene, data: any): TransformNode {
	if (data.generatorNodeId || data.generatorNodeName) {
		const node = resolveNode({ scene, nodeId: data.generatorNodeId, nodeName: data.generatorNodeName });
		if (!(node instanceof TransformNode)) {
			throw new Error(`Trail generator "${node.name}" must be a transform node or mesh.`);
		}
		return node;
	}
	const generator = new TransformNode(data.generatorName ?? "Trail Generator", scene);
	if (data.position) {
		generator.position.copyFrom(toVector3(data.position));
	}
	return generator;
}

function normalizeConfiguration(data: any, defaults?: Partial<ITrailConfiguration>): Omit<ITrailConfiguration, "generatorId"> {
	const configuration = {
		diameter: data.diameter ?? defaults?.diameter ?? 10,
		length: data.length ?? defaults?.length ?? 60,
		segments: data.segments ?? defaults?.segments ?? 60,
		sections: data.sections ?? defaults?.sections ?? 4,
		doNotTaper: data.doNotTaper ?? defaults?.doNotTaper ?? false,
		autoStart: data.autoStart ?? defaults?.autoStart ?? true,
	};
	if (!(configuration.diameter > 0)) {
		throw new Error("Trail diameter must be greater than zero.");
	}
	if (!(configuration.length > 0)) {
		throw new Error("Trail length must be greater than zero.");
	}
	if (!Number.isInteger(configuration.segments) || configuration.segments < 1) {
		throw new Error("Trail segments must be a positive integer.");
	}
	if (!Number.isInteger(configuration.sections) || configuration.sections < 2) {
		throw new Error("Trail sections must be an integer of at least 2.");
	}
	return configuration;
}

function createTrail(scene: Scene, name: string, generator: TransformNode, configuration: Omit<ITrailConfiguration, "generatorId">): TrailMesh {
	const trail = new TrailMesh(name, generator, scene, configuration);
	trail.metadata ??= {};
	trail.metadata.babylonEditorTrail = { generatorId: generator.id, ...configuration } satisfies ITrailConfiguration;
	return trail;
}

function resolveTrail(scene: Scene, data: any): TrailMesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!(node instanceof TrailMesh)) {
		throw new Error(`Node "${node.name}" is not a VFX trail.`);
	}
	return node;
}

function getConfiguration(trail: TrailMesh): ITrailConfiguration {
	const configuration = trail.metadata?.babylonEditorTrail as ITrailConfiguration | undefined;
	if (!configuration) {
		throw new Error(`Trail "${trail.name}" is missing its editor configuration.`);
	}
	return { ...configuration };
}

function describeTrail(trail: TrailMesh): any {
	const configuration = getConfiguration(trail);
	return { node: toNodeSummary(trail), ...configuration, diameter: trail.diameter, materialId: trail.material?.id ?? null };
}

/** Creates a persistent Babylon TrailMesh following a mesh or transform node. */
export function createVfxTrail(scene: Scene, data: any, options: IMCPActionOptions): any {
	const generator = resolveGenerator(scene, data);
	const configuration = normalizeConfiguration(data);
	const trail = createTrail(scene, data.name ?? "VFX Trail", generator, configuration);
	if (data.materialId) {
		trail.material =
			scene.getMaterialById(data.materialId) ??
			(() => {
				throw new Error(`Material "${data.materialId}" was not found.`);
			})();
	}
	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(trail));
	options.editor.layout.inspector.setEditedObject(trail);
	return describeTrail(trail);
}

/** Lists all VFX trail meshes in the active scene. */
export function listVfxTrails(scene: Scene): any {
	return { trails: scene.meshes.filter((mesh): mesh is TrailMesh => mesh instanceof TrailMesh).map(describeTrail) };
}

/** Reads a VFX trail's generator, geometry settings, material, and playback state. */
export function getVfxTrail(scene: Scene, data: any): any {
	return describeTrail(resolveTrail(scene, data));
}

/** Updates a VFX trail. Structural options rebuild the trail while retaining its id, material, and graph identity. */
export function setVfxTrail(scene: Scene, data: any, options: IMCPActionOptions): any {
	const trail = resolveTrail(scene, data);
	const previous = getConfiguration(trail);
	const existingGenerator = scene.getNodeById(previous.generatorId);
	const generator = data.generatorNodeId || data.generatorNodeName ? resolveGenerator(scene, data) : existingGenerator instanceof TransformNode ? existingGenerator : null;
	if (!generator) {
		throw new Error(`Trail generator "${previous.generatorId}" no longer exists. Provide generatorNodeId or generatorNodeName.`);
	}
	const configuration = normalizeConfiguration(data, previous);
	const material = data.materialId === undefined ? trail.material : scene.getMaterialById(data.materialId);
	if (data.materialId !== undefined && !material) {
		throw new Error(`Material "${data.materialId}" was not found.`);
	}
	const id = trail.id;
	const name = data.name ?? trail.name;
	trail.stop();
	trail.dispose(false, false);
	const replacement = createTrail(scene, name, generator, configuration);
	replacement.id = id;
	replacement.material = material as Material | null;
	if (data.playing === false) {
		replacement.stop();
	} else if (data.playing === true) {
		replacement.start();
	}
	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(replacement));
	options.editor.layout.inspector.setEditedObject(replacement);
	options.editor.layout.inspector.forceUpdate();
	return describeTrail(replacement);
}

/** Deletes a VFX trail mesh; its generator is retained for reuse. */
export function deleteVfxTrail(scene: Scene, data: any, options: IMCPActionOptions): any {
	const trail = resolveTrail(scene, data);
	const result = { deleted: true, id: trail.id, name: trail.name };
	trail.dispose(false, false);
	options.editor.layout.graph.refresh();
	options.editor.layout.inspector.setEditedObject(scene);
	return result;
}
