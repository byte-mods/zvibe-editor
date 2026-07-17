import { dirname, join, isAbsolute, basename, relative } from "path/posix";

import { Scene, Node, Tools } from "babylonjs";

import { normalizedGlob } from "../../tools/fs";
import { isSoundNode } from "../../tools/guards/sound";

import { SoundNode } from "../../editor/nodes/sound";

import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

function getAudioBuses(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorAudioBuses ??= []);
}
function getAudioSnapshots(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorAudioMixerSnapshots ??= []);
}

function getAudioBus(scene: Scene, data: any): any {
	const bus = getAudioBuses(scene).find((candidate) => candidate.id === data.busId || candidate.name === data.busName);
	if (!bus) throw new Error("Audio bus not found.");
	return bus;
}

function applyAudioBus(scene: Scene, bus: any): void {
	for (const nodeId of bus.soundNodeIds) {
		const node = scene.getNodeById(nodeId);
		if (node && isSoundNode(node)) {
			const sound = node as SoundNode;
			sound.metadata ??= {};
			const baseVolume = sound.metadata.babylonEditorAudioBusBaseVolume ?? sound.volume;
			sound.metadata.babylonEditorAudioBusBaseVolume = baseVolume;
			const hasSolo = getAudioBuses(scene).some((candidate) => candidate.solo === true);
			sound.volume = baseVolume * (bus.muted || (hasSolo && bus.solo !== true) ? 0 : bus.gain);
		}
	}
}

function restoreAudioBusVolume(scene: Scene, nodeId: string): void {
	const node = scene.getNodeById(nodeId);
	if (!node || !isSoundNode(node)) return;
	const sound = node as SoundNode;
	const baseVolume = sound.metadata?.babylonEditorAudioBusBaseVolume;
	if (typeof baseVolume !== "number") return;
	sound.volume = baseVolume;
	delete sound.metadata.babylonEditorAudioBusBaseVolume;
}

/** Lists persisted audio mixer buses. */
export function listAudioBuses(scene: Scene): any {
	return { buses: structuredClone(getAudioBuses(scene)) };
}

/** Lists actual sound-node playback and effective mixer state for preview/runtime diagnostics. */
export function listAudioRuntimeDiagnostics(scene: Scene): any {
	const buses = getAudioBuses(scene);
	const hasSolo = buses.some((bus) => bus.solo === true);
	const sounds = scene.transformNodes.filter(isSoundNode).map((node) => {
		const sound = node as SoundNode;
		const bus = buses.find((candidate) => candidate.soundNodeIds.includes(sound.id));
		const baseVolume = sound.metadata?.babylonEditorAudioBusBaseVolume ?? sound.volume;
		const effectiveVolume = bus ? baseVolume * (bus.muted || (hasSolo && bus.solo !== true) ? 0 : bus.gain) : sound.volume;
		return {
			nodeId: sound.id,
			name: sound.name,
			path: sound.soundRelativePath,
			loaded: !!sound.sound,
			isPlaying: (sound.sound as any)?.isPlaying ?? false,
			playbackState: (sound.sound as any)?.state ?? "unloaded",
			spatial: sound.isSpatial,
			baseVolume,
			effectiveVolume,
			bus: bus ? { id: bus.id, name: bus.name, gain: bus.gain, muted: bus.muted === true, solo: bus.solo === true } : null,
		};
	});
	const assignedNodeIds = new Set(buses.flatMap((bus) => bus.soundNodeIds));
	return {
		summary: {
			soundCount: sounds.length,
			loadedCount: sounds.filter((sound) => sound.loaded).length,
			playingCount: sounds.filter((sound) => sound.isPlaying).length,
			busCount: buses.length,
		},
		sounds,
		missingBusSoundNodeIds: [...assignedNodeIds].filter((id) => !scene.getNodeById(id)),
	};
}

/** Creates an audio mixer bus controlling assigned SoundNode volumes. */
export function createAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (getAudioBuses(scene).some((bus) => bus.name === data.name)) throw new Error(`Audio bus "${data.name}" already exists.`);
	const bus = { id: Tools.RandomId(), name: data.name, gain: data.gain ?? 1, muted: data.muted ?? false, solo: data.solo ?? false, soundNodeIds: data.soundNodeIds ?? [] };
	if (!Number.isFinite(bus.gain) || bus.gain < 0) throw new Error("Audio bus gain must be zero or greater.");
	bus.soundNodeIds.forEach((id: string) => {
		const node = scene.getNodeById(id);
		if (!node || !isSoundNode(node)) throw new Error(`Node "${id}" is not a SoundNode.`);
	});
	getAudioBuses(scene).push(bus);
	applyAudioBus(scene, bus);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(bus);
}

/** Updates mixer bus gain and/or assigned sound nodes. */
export function setAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	const bus = getAudioBus(scene, data);
	if (data.gain !== undefined) bus.gain = data.gain;
	if (data.muted !== undefined) bus.muted = data.muted;
	if (data.solo !== undefined) bus.solo = data.solo;
	if (data.soundNodeIds !== undefined) bus.soundNodeIds = data.soundNodeIds;
	if (!Number.isFinite(bus.gain) || bus.gain < 0) throw new Error("Audio bus gain must be zero or greater.");
	applyAudioBus(scene, bus);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(bus);
}

/** Deletes a mixer bus without deleting its sound nodes. */
export function deleteAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	const bus = getAudioBus(scene, data);
	getAudioBuses(scene).splice(getAudioBuses(scene).indexOf(bus), 1);
	bus.soundNodeIds.forEach((nodeId: string) => restoreAudioBusVolume(scene, nodeId));
	getAudioBuses(scene).forEach((remainingBus) => applyAudioBus(scene, remainingBus));
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: bus.id };
}

/** Assigns a SoundNode exclusively to one mixer bus, or clears its bus assignment and restores its base volume. */
export function assignSoundNodeToAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = scene.getNodeById(data.nodeId);
	if (!node || !isSoundNode(node)) throw new Error(`Node "${data.nodeId}" is not a SoundNode.`);
	const allBuses = getAudioBuses(scene);
	allBuses.forEach((bus) => (bus.soundNodeIds = bus.soundNodeIds.filter((nodeId: string) => nodeId !== node.id)));
	restoreAudioBusVolume(scene, node.id);
	if (data.busId !== null && data.busId !== undefined) {
		const bus = getAudioBus(scene, { busId: data.busId });
		bus.soundNodeIds.push(node.id);
		applyAudioBus(scene, bus);
	}
	options.editor.layout.inspector.forceUpdate();
	return { nodeId: node.id, busId: data.busId ?? null };
}

export function listAudioMixerSnapshots(scene: Scene): any {
	return { snapshots: structuredClone(getAudioSnapshots(scene)) };
}
export function createAudioMixerSnapshot(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (getAudioSnapshots(scene).some((snapshot) => snapshot.name === data.name)) throw new Error(`Audio mixer snapshot "${data.name}" already exists.`);
	const snapshot = {
		id: Tools.RandomId(),
		name: data.name,
		gains: Object.fromEntries(getAudioBuses(scene).map((bus) => [bus.id, bus.gain])),
		mutes: Object.fromEntries(getAudioBuses(scene).map((bus) => [bus.id, bus.muted === true])),
		solos: Object.fromEntries(getAudioBuses(scene).map((bus) => [bus.id, bus.solo === true])),
	};
	getAudioSnapshots(scene).push(snapshot);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(snapshot);
}
export function applyAudioMixerSnapshot(scene: Scene, data: any, options: IMCPActionOptions): any {
	const snapshot = getAudioSnapshots(scene).find((value) => value.id === data.id || value.name === data.name);
	if (!snapshot) throw new Error("Audio mixer snapshot not found.");
	for (const bus of getAudioBuses(scene))
		if (snapshot.gains[bus.id] !== undefined) {
			bus.gain = snapshot.gains[bus.id];
			if (snapshot.mutes?.[bus.id] !== undefined) bus.muted = snapshot.mutes[bus.id];
			if (snapshot.solos?.[bus.id] !== undefined) bus.solo = snapshot.solos[bus.id];
			applyAudioBus(scene, bus);
		}
	options.editor.layout.inspector.forceUpdate();
	return { id: snapshot.id, name: snapshot.name, appliedBusCount: Object.keys(snapshot.gains).length };
}
export function deleteAudioMixerSnapshot(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = getAudioSnapshots(scene).findIndex((value) => value.id === data.id || value.name === data.name);
	if (index === -1) throw new Error("Audio mixer snapshot not found.");
	const [snapshot] = getAudioSnapshots(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: snapshot.id };
}

/**
 * Returns the absolute path of the project directory.
 */
function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	return dirname(projectConfiguration.path);
}

/**
 * Resolves an absolute path from a project-relative or absolute path.
 */
function resolveProjectPath(path: string): string {
	return isAbsolute(path) ? path : join(getProjectDirectory(), path);
}

/**
 * Lists all the `.mp3`, `.ogg` and `.wav` sound assets in the project.
 */
export async function listSoundAssets(): Promise<any> {
	const directory = getProjectDirectory();

	const matches = await normalizedGlob(join(directory, "/**/*.{mp3,ogg,wav}"), {
		nodir: true,
		ignore: ["**/node_modules/**"],
	});

	return {
		assets: (matches as string[]).map((matchPath) => {
			const path = matchPath.toString();
			return {
				name: basename(path),
				path: relative(directory, path),
			};
		}),
	};
}

/**
 * Applies the spatial-related properties (volume, isSpatial, maxDistance, distanceModel, panningModel)
 * provided in the given data object to the given sound node, only when present.
 */
function applySoundProperties(node: SoundNode, data: any): void {
	if (data.volume !== undefined) {
		node.volume = data.volume;
	}

	if (data.spatial !== undefined) {
		node.isSpatial = data.spatial;
	}

	if (data.maxDistance !== undefined) {
		node.maxDistance = data.maxDistance;
	}

	if (data.distanceModel !== undefined) {
		node.distanceModel = data.distanceModel;
	}

	if (data.panningModel !== undefined) {
		node.panningModel = data.panningModel;
	}

	if (data.autoUpdateSpatial !== undefined) {
		node.autoUpdateSpatial = data.autoUpdateSpatial;
	}
}

/**
 * Creates a `SoundNode` in the scene from a sound asset and loads it.
 * Use `spatial: true` (default) with `parentId`/`parentName`/`position` for 3D positional ambience,
 * or `spatial: false` for a global 2D ambience/music bed.
 */
export async function createSound(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (!data.path) {
		throw new Error("`path` to a sound asset (.mp3/.ogg/.wav) is required to create a sound.");
	}

	const node = new SoundNode(data.name ?? "New Sound Node", scene);

	let parent: Node | null = null;
	if (data.parentId || data.parentName) {
		parent = resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName });
	}
	node.parent = parent;

	if (data.position) {
		node.position.copyFrom(toVector3(data.position));
	}

	applySoundProperties(node, data);

	const absolutePath = resolveProjectPath(data.path);
	await node.setSoundAbsolutePath(absolutePath);

	options.editor.layout.graph.refresh().then(() => {
		options.editor.layout.graph.setSelectedNode(node);
	});
	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.preview.gizmo.setAttachedObject(node);

	return toNodeSummary(node);
}

/**
 * Updates the properties of an existing `SoundNode`. Only the provided fields are applied.
 */
export function setSoundProperties(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isSoundNode(node)) {
		throw new Error(`Node "${node.name}" is not a SoundNode.`);
	}

	applySoundProperties(node, data);

	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
}

export function getSound(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isSoundNode(node)) throw new Error(`Node "${node.name}" is not a SoundNode.`);
	const sound = node as SoundNode;
	return {
		...toNodeSummary(sound),
		path: sound.soundRelativePath,
		volume: sound.volume,
		spatial: sound.isSpatial,
		maxDistance: sound.maxDistance,
		distanceModel: sound.distanceModel,
		panningModel: sound.panningModel,
		autoUpdateSpatial: sound.autoUpdateSpatial,
		isPlaying: (sound.sound as any)?.isPlaying ?? false,
	};
}

export function setSoundPlaying(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isSoundNode(node)) throw new Error(`Node "${node.name}" is not a SoundNode.`);
	const sound = node as SoundNode;
	if (data.playing) sound.play({ startOffset: data.startOffset });
	else sound.stop();
	return getSound(scene, { nodeId: sound.id });
}
