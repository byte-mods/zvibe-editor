import { dirname, join, isAbsolute, basename, relative } from "path/posix";

import { Scene, Node, Tools } from "babylonjs";

import {
	AudioMixerTransitionShape,
	AudioMixerEffectType,
	IAudioMixerBus,
	IAudioMixerDucking,
	IAudioMixerEffect,
	IAudioMixerSend,
	IAudioMixerSnapshot,
	IAudioReverbZone,
	getOrCreateAudioMixer,
	createDefaultAudioMixerEffectParameters,
	validateAudioMixerConfiguration,
	validateAudioReverbZones,
} from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs";
import { isSoundNode } from "../../tools/guards/sound";

import { SoundNode } from "../../editor/nodes/sound";

import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

function getAudioBuses(scene: Scene): IAudioMixerBus[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorAudioBuses ??= []);
}
function getAudioSnapshots(scene: Scene): IAudioMixerSnapshot[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorAudioMixerSnapshots ??= []);
}
function getAudioReverbZones(scene: Scene): IAudioReverbZone[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorAudioReverbZones ??= []);
}

function getAudioBus(scene: Scene, data: any): IAudioMixerBus {
	const bus = getAudioBuses(scene).find((candidate) => candidate.id === data.busId || candidate.name === data.busName);
	if (!bus) {
		throw new Error("Audio bus not found.");
	}
	return bus;
}

function getAudioSend(scene: Scene, data: any): { bus: IAudioMixerBus; send: IAudioMixerSend } {
	const bus = getAudioBus(scene, { busId: data.sourceBusId, busName: data.sourceBusName });
	const send = (bus.sends ?? []).find((candidate) => candidate.id === data.sendId || candidate.name === data.sendName);
	if (!send) {
		throw new Error("Audio send not found.");
	}
	return { bus, send };
}

function getAudioEffect(scene: Scene, data: any): { bus: IAudioMixerBus; effect: IAudioMixerEffect } {
	const bus = getAudioBus(scene, { busId: data.busId, busName: data.busName });
	const effect = (bus.effects ?? []).find((candidate) => candidate.id === data.effectId || candidate.name === data.effectName);
	if (!effect) {
		throw new Error("Audio effect not found.");
	}
	return { bus, effect };
}

function defaultDucking(): IAudioMixerDucking {
	return { threshold: 0.25, ratio: 4, attackSeconds: 0.05, releaseSeconds: 0.25, maxReductionDb: 12 };
}

function getAudioMixer(scene: Scene) {
	return getOrCreateAudioMixer(scene as any, getAudioBuses(scene), getAudioSnapshots(scene));
}

function validateAudioBuses(scene: Scene): void {
	const errors = [...validateAudioMixerConfiguration(getAudioBuses(scene)), ...validateAudioReverbZones(getAudioBuses(scene), getAudioReverbZones(scene))];
	if (errors.length) {
		throw new Error(errors.join(" "));
	}
}

function validateSoundNodeIds(scene: Scene, nodeIds: string[]): void {
	for (const id of nodeIds) {
		const node = scene.getNodeById(id);
		if (!node || !isSoundNode(node)) {
			throw new Error(`Node "${id}" is not a SoundNode.`);
		}
	}
}

function restoreAudioBusVolume(scene: Scene, nodeId: string): void {
	const node = scene.getNodeById(nodeId);
	if (!node || !isSoundNode(node)) {
		return;
	}
	const sound = node as SoundNode;
	const baseVolume = sound.metadata?.babylonEditorAudioBusBaseVolume;
	if (typeof baseVolume !== "number") {
		return;
	}
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
	const mixerRuntime = getAudioMixer(scene).getRuntimeState();
	const sounds = scene.transformNodes.filter(isSoundNode).map((node) => {
		const sound = node as SoundNode;
		const bus = buses.find((candidate) => candidate.soundNodeIds.includes(sound.id));
		const runtimeBus = mixerRuntime.buses.find((candidate) => candidate.id === bus?.id);
		const baseVolume = sound.metadata?.babylonEditorAudioBusBaseVolume ?? sound.volume;
		const effectiveVolume = runtimeBus ? baseVolume * runtimeBus.effectiveGain : sound.volume;
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
			effectivePitch: runtimeBus?.effectivePitch ?? 1,
			bus: runtimeBus
				? {
						id: runtimeBus.id,
						name: runtimeBus.name,
						path: runtimeBus.path,
						gain: runtimeBus.gain,
						pitch: runtimeBus.pitch,
						muted: runtimeBus.muted,
						solo: runtimeBus.solo,
						nativeConnected: runtimeBus.nativeConnected,
					}
				: null,
		};
	});
	const assignedNodeIds = new Set(buses.flatMap((bus) => bus.soundNodeIds));
	return {
		summary: {
			soundCount: sounds.length,
			loadedCount: sounds.filter((sound) => sound.loaded).length,
			playingCount: sounds.filter((sound) => sound.isPlaying).length,
			busCount: buses.length,
			nativeAudioGraph: mixerRuntime.nativeAudioGraph,
		},
		sounds,
		mixer: mixerRuntime,
		missingBusSoundNodeIds: [...assignedNodeIds].filter((id) => !scene.getNodeById(id)),
	};
}

/** Returns resolved Master paths, inherited gain/pitch, native graph state, and any active snapshot blend. */
export function getAudioMixerRuntime(scene: Scene): any {
	const mixer = getAudioMixer(scene);
	mixer.apply();
	return mixer.getRuntimeState();
}

/** Reads bounded Audio Mixer CPU, voice, latency, signal, and estimated clipping profile evidence. */
export function getAudioMixerProfile(scene: Scene, data: any = {}): any {
	if (data.busId !== undefined && !getAudioBuses(scene).some((bus) => bus.id === data.busId)) {
		throw new Error(`Audio profiler bus "${data.busId}" was not found.`);
	}
	return getAudioMixer(scene).getProfile({
		busId: data.busId,
		includeSamples: data.includeSamples === true,
		sampleOffset: data.sampleOffset,
		sampleLimit: data.sampleLimit,
	});
}

/** Enables/disables or bounds transient Audio Mixer profiling. */
export function setAudioMixerProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.enabled === undefined && data.sampleCapacity === undefined && data.sampleEveryNUpdates === undefined) {
		throw new Error("Provide enabled, sampleCapacity, or sampleEveryNUpdates.");
	}
	const result = getAudioMixer(scene).configureProfiler({
		enabled: data.enabled,
		sampleCapacity: data.sampleCapacity,
		sampleEveryNUpdates: data.sampleEveryNUpdates,
	});
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Clears transient Audio Mixer profile samples and summaries without changing settings. */
export function clearAudioMixerProfile(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const result = getAudioMixer(scene).clearProfile();
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Creates an audio mixer bus controlling assigned SoundNode volumes. */
export function createAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (getAudioBuses(scene).some((bus) => bus.name === data.name)) {
		throw new Error(`Audio bus "${data.name}" already exists.`);
	}
	const bus: IAudioMixerBus = {
		id: Tools.RandomId(),
		name: data.name,
		gain: data.gain ?? 1,
		pitch: data.pitch ?? 1,
		muted: data.muted ?? false,
		solo: data.solo ?? false,
		parentBusId: data.parentBusId ?? null,
		soundNodeIds: data.soundNodeIds ?? [],
		sends: [],
		effects: [],
	};
	validateSoundNodeIds(scene, bus.soundNodeIds);
	getAudioBuses(scene).push(bus);
	try {
		validateAudioBuses(scene);
	} catch (error) {
		getAudioBuses(scene).pop();
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(bus);
}

/** Updates mixer bus gain and/or assigned sound nodes. */
export function setAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	const bus = getAudioBus(scene, data);
	const original = structuredClone(bus);
	if (data.name !== undefined) {
		bus.name = data.name;
	}
	if (data.gain !== undefined) {
		bus.gain = data.gain;
	}
	if (data.pitch !== undefined) {
		bus.pitch = data.pitch;
	}
	if (data.muted !== undefined) {
		bus.muted = data.muted;
	}
	if (data.solo !== undefined) {
		bus.solo = data.solo;
	}
	if (data.parentBusId !== undefined) {
		bus.parentBusId = data.parentBusId;
	}
	if (data.soundNodeIds !== undefined) {
		validateSoundNodeIds(scene, data.soundNodeIds);
		bus.soundNodeIds = data.soundNodeIds;
	}
	try {
		validateAudioBuses(scene);
	} catch (error) {
		Object.assign(bus, original);
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(bus);
}

/** Deletes a mixer bus without deleting its sound nodes. */
export function deleteAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	const bus = getAudioBus(scene, data);
	const deletedEffectIds = new Set((bus.effects ?? []).map((effect) => effect.id));
	const removedReverbZoneIds = getAudioReverbZones(scene)
		.filter((zone) => deletedEffectIds.has(zone.effectId))
		.map((zone) => zone.id);
	scene.metadata.babylonEditorAudioReverbZones = getAudioReverbZones(scene).filter((zone) => !deletedEffectIds.has(zone.effectId));
	getAudioBuses(scene).splice(getAudioBuses(scene).indexOf(bus), 1);
	const reparentedBusIds: string[] = [];
	const removedSendIds: string[] = [];
	for (const child of getAudioBuses(scene)) {
		if (child.parentBusId === bus.id) {
			child.parentBusId = bus.parentBusId ?? null;
			reparentedBusIds.push(child.id);
		}
		const retainedSends = (child.sends ?? []).filter((send) => {
			if (send.targetBusId === bus.id) {
				removedSendIds.push(send.id);
				return false;
			}
			return true;
		});
		child.sends = retainedSends;
	}
	bus.soundNodeIds.forEach((nodeId: string) => restoreAudioBusVolume(scene, nodeId));
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: bus.id, reparentedBusIds, removedSendIds, removedReverbZoneIds };
}

/** Creates an audible return send or control-only sidechain ducking send from one mixer bus to another. */
export function createAudioSend(scene: Scene, data: any, options: IMCPActionOptions): any {
	const bus = getAudioBus(scene, { busId: data.sourceBusId, busName: data.sourceBusName });
	getAudioBus(scene, { busId: data.targetBusId });
	if ((bus.sends ?? []).some((send) => send.name === data.name)) {
		throw new Error(`Audio send "${data.name}" already exists on bus "${bus.name}".`);
	}
	const kind = data.kind ?? "return";
	const send: IAudioMixerSend = {
		id: Tools.RandomId(),
		name: data.name,
		targetBusId: data.targetBusId,
		kind,
		gain: data.gain ?? 1,
		enabled: data.enabled ?? true,
		ducking: kind === "sidechain" ? structuredClone(data.ducking ?? defaultDucking()) : undefined,
	};
	bus.sends ??= [];
	bus.sends.push(send);
	try {
		validateAudioBuses(scene);
	} catch (error) {
		bus.sends.pop();
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(send);
}

/** Updates one return or sidechain send atomically. */
export function setAudioSend(scene: Scene, data: any, options: IMCPActionOptions): any {
	const { send } = getAudioSend(scene, data);
	if (data.ducking !== undefined && (data.kind ?? send.kind) !== "sidechain") {
		throw new Error("Ducking settings are valid only for sidechain sends.");
	}
	const original = structuredClone(send);
	if (data.name !== undefined) {
		send.name = data.name;
	}
	if (data.targetBusId !== undefined) {
		getAudioBus(scene, { busId: data.targetBusId });
		send.targetBusId = data.targetBusId;
	}
	if (data.kind !== undefined) {
		send.kind = data.kind;
	}
	if (data.gain !== undefined) {
		send.gain = data.gain;
	}
	if (data.enabled !== undefined) {
		send.enabled = data.enabled;
	}
	if (send.kind === "sidechain") {
		send.ducking = structuredClone(data.ducking ?? send.ducking ?? defaultDucking());
	} else {
		delete send.ducking;
	}
	try {
		validateAudioBuses(scene);
	} catch (error) {
		for (const key of Object.keys(send)) {
			delete (send as any)[key];
		}
		Object.assign(send, original);
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(send);
}

/** Deletes one send without deleting either bus. */
export function deleteAudioSend(scene: Scene, data: any, options: IMCPActionOptions): any {
	const { bus, send } = getAudioSend(scene, data);
	bus.sends!.splice(bus.sends!.indexOf(send), 1);
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: send.id, sourceBusId: bus.id };
}

/** Inserts one ordered DSP effect into a mixer bus. */
export function createAudioEffect(scene: Scene, data: any, options: IMCPActionOptions): any {
	const bus = getAudioBus(scene, data);
	const type = data.type as AudioMixerEffectType;
	const effect: IAudioMixerEffect = {
		id: Tools.RandomId(),
		name: data.name,
		type,
		enabled: data.enabled ?? true,
		wet: data.wet ?? 1,
		parameters: { ...createDefaultAudioMixerEffectParameters(type), ...(data.parameters ?? {}) },
	};
	bus.effects ??= [];
	const index = data.index ?? bus.effects.length;
	if (!Number.isInteger(index) || index < 0 || index > bus.effects.length) {
		throw new Error(`Audio effect index must be between 0 and ${bus.effects.length}.`);
	}
	bus.effects.splice(index, 0, effect);
	try {
		validateAudioBuses(scene);
	} catch (error) {
		bus.effects.splice(index, 1);
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(effect), index };
}

/** Updates, bypasses, or reorders one DSP effect atomically. */
export function setAudioEffect(scene: Scene, data: any, options: IMCPActionOptions): any {
	const { bus, effect } = getAudioEffect(scene, data);
	const originalEffects = structuredClone(bus.effects!);
	try {
		if (data.name !== undefined) {
			effect.name = data.name;
		}
		if (data.enabled !== undefined) {
			effect.enabled = data.enabled;
		}
		if (data.wet !== undefined) {
			effect.wet = data.wet;
		}
		if (data.type !== undefined && data.type !== effect.type) {
			effect.type = data.type;
			effect.parameters = createDefaultAudioMixerEffectParameters(effect.type);
		}
		if (data.parameters !== undefined) {
			effect.parameters = { ...effect.parameters, ...structuredClone(data.parameters) };
		}
		if (data.index !== undefined) {
			if (!Number.isInteger(data.index) || data.index < 0 || data.index >= bus.effects!.length) {
				throw new Error(`Audio effect index must be between 0 and ${bus.effects!.length - 1}.`);
			}
			bus.effects!.splice(bus.effects!.indexOf(effect), 1);
			bus.effects!.splice(data.index, 0, effect);
		}
		validateAudioBuses(scene);
	} catch (error) {
		bus.effects = originalEffects;
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(effect), index: bus.effects!.indexOf(effect) };
}

/** Deletes one DSP effect without deleting its bus. */
export function deleteAudioEffect(scene: Scene, data: any, options: IMCPActionOptions): any {
	const { bus, effect } = getAudioEffect(scene, data);
	const removedReverbZoneIds = getAudioReverbZones(scene)
		.filter((zone) => zone.effectId === effect.id)
		.map((zone) => zone.id);
	scene.metadata.babylonEditorAudioReverbZones = getAudioReverbZones(scene).filter((zone) => zone.effectId !== effect.id);
	bus.effects!.splice(bus.effects!.indexOf(effect), 1);
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: effect.id, busId: bus.id, removedReverbZoneIds };
}

export function listAudioReverbZones(scene: Scene): any {
	return { zones: structuredClone(getAudioReverbZones(scene)), runtime: getAudioMixer(scene).getRuntimeState().reverbZones };
}

/** Creates a bounded sphere or box zone targeting one convolution-reverb effect. */
export function createAudioReverbZone(scene: Scene, data: any, options: IMCPActionOptions): any {
	const zone: IAudioReverbZone = {
		id: Tools.RandomId(),
		name: data.name,
		effectId: data.effectId,
		shape: data.shape ?? "sphere",
		position: data.position ?? [0, 0, 0],
		innerRadius: data.innerRadius ?? 0,
		outerRadius: data.outerRadius ?? 1000,
		size: data.size ?? [1000, 1000, 1000],
		blendDistance: data.blendDistance ?? 100,
		priority: data.priority ?? 0,
		enabled: data.enabled ?? true,
	};
	getAudioReverbZones(scene).push(zone);
	try {
		validateAudioBuses(scene);
	} catch (error) {
		getAudioReverbZones(scene).pop();
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(zone);
}

/** Updates one reverb zone atomically. */
export function setAudioReverbZone(scene: Scene, data: any, options: IMCPActionOptions): any {
	const zone = getAudioReverbZones(scene).find((candidate) => candidate.id === data.id || candidate.name === data.zoneName);
	if (!zone) {
		throw new Error("Audio reverb zone not found.");
	}
	const original = structuredClone(zone);
	for (const key of ["name", "effectId", "shape", "position", "innerRadius", "outerRadius", "size", "blendDistance", "priority", "enabled"] as const) {
		if (data[key] !== undefined) {
			(zone as any)[key] = structuredClone(data[key]);
		}
	}
	try {
		validateAudioBuses(scene);
	} catch (error) {
		for (const key of Object.keys(zone)) {
			delete (zone as any)[key];
		}
		Object.assign(zone, original);
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(zone);
}

export function deleteAudioReverbZone(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = getAudioReverbZones(scene).findIndex((candidate) => candidate.id === data.id || candidate.name === data.zoneName);
	if (index === -1) {
		throw new Error("Audio reverb zone not found.");
	}
	const [zone] = getAudioReverbZones(scene).splice(index, 1);
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: zone.id };
}

/** Assigns a SoundNode exclusively to one mixer bus, or clears its bus assignment and restores its base volume. */
export function assignSoundNodeToAudioBus(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = scene.getNodeById(data.nodeId);
	if (!node || !isSoundNode(node)) {
		throw new Error(`Node "${data.nodeId}" is not a SoundNode.`);
	}
	const allBuses = getAudioBuses(scene);
	const targetBus = data.busId === null || data.busId === undefined ? null : getAudioBus(scene, { busId: data.busId });
	const previousAssignments = new Map(allBuses.map((bus) => [bus.id, [...bus.soundNodeIds]]));
	allBuses.forEach((bus) => (bus.soundNodeIds = bus.soundNodeIds.filter((nodeId: string) => nodeId !== node.id)));
	if (targetBus) {
		targetBus.soundNodeIds.push(node.id);
	}
	try {
		validateAudioBuses(scene);
	} catch (error) {
		for (const bus of allBuses) {
			bus.soundNodeIds = previousAssignments.get(bus.id) ?? [];
		}
		throw error;
	}
	getAudioMixer(scene).apply();
	options.editor.layout.inspector.forceUpdate();
	return { nodeId: node.id, busId: targetBus?.id ?? null };
}

export function listAudioMixerSnapshots(scene: Scene): any {
	return { snapshots: structuredClone(getAudioSnapshots(scene)) };
}
export function createAudioMixerSnapshot(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (getAudioSnapshots(scene).some((snapshot) => snapshot.name === data.name)) {
		throw new Error(`Audio mixer snapshot "${data.name}" already exists.`);
	}
	const snapshot = {
		id: Tools.RandomId(),
		name: data.name,
		gains: Object.fromEntries(getAudioBuses(scene).map((bus) => [bus.id, bus.gain])),
		pitches: Object.fromEntries(getAudioBuses(scene).map((bus) => [bus.id, bus.pitch ?? 1])),
		mutes: Object.fromEntries(getAudioBuses(scene).map((bus) => [bus.id, bus.muted === true])),
		solos: Object.fromEntries(getAudioBuses(scene).map((bus) => [bus.id, bus.solo === true])),
		sendGains: Object.fromEntries(getAudioBuses(scene).flatMap((bus) => (bus.sends ?? []).map((send) => [send.id, send.gain]))),
		effectWets: Object.fromEntries(getAudioBuses(scene).flatMap((bus) => (bus.effects ?? []).map((effect) => [effect.id, effect.wet ?? 1]))),
		effectEnabled: Object.fromEntries(getAudioBuses(scene).flatMap((bus) => (bus.effects ?? []).map((effect) => [effect.id, effect.enabled !== false]))),
		effectParameters: Object.fromEntries(getAudioBuses(scene).flatMap((bus) => (bus.effects ?? []).map((effect) => [effect.id, structuredClone(effect.parameters)]))),
	};
	getAudioSnapshots(scene).push(snapshot);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(snapshot);
}
export function applyAudioMixerSnapshot(scene: Scene, data: any, options: IMCPActionOptions): any {
	const snapshot = getAudioSnapshots(scene).find((value) => value.id === data.id || value.name === data.name);
	if (!snapshot) {
		throw new Error("Audio mixer snapshot not found.");
	}
	const durationSeconds = data.durationSeconds ?? 0;
	const shape = (data.shape ?? "linear") as AudioMixerTransitionShape;
	const mixer = getAudioMixer(scene);
	mixer.applySnapshot(snapshot.id, durationSeconds, shape);
	options.editor.layout.inspector.forceUpdate();
	return { id: snapshot.id, name: snapshot.name, appliedBusCount: Object.keys(snapshot.gains).length, transition: mixer.peekRuntimeState().transition };
}
export function deleteAudioMixerSnapshot(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = getAudioSnapshots(scene).findIndex((value) => value.id === data.id || value.name === data.name);
	if (index === -1) {
		throw new Error("Audio mixer snapshot not found.");
	}
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
 * Lists native clips and generated-audio graphs that can back a SoundNode.
 */
export async function listSoundAssets(): Promise<any> {
	const directory = getProjectDirectory();
	const assetsDirectory = join(directory, "assets");

	const matches = (
		await Promise.all([
			normalizedGlob(join(assetsDirectory, "/**/*.{mp3,ogg,wav,wave,flac,m4a}"), { nodir: true }),
			normalizedGlob(join(assetsDirectory, "/**/*.audio-generator.json"), { nodir: true }),
		])
	).flat();

	return {
		assets: (matches as string[])
			.map((matchPath) => {
				const path = matchPath.toString();
				return {
					name: basename(path),
					path: relative(directory, path),
					type: path.toLowerCase().endsWith(".audio-generator.json") ? "audio-generator" : "sound",
				};
			})
			.sort((left, right) => left.path.localeCompare(right.path)),
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
		throw new Error("`path` to a native clip or .audio-generator.json asset is required to create a sound.");
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
	if (!isSoundNode(node)) {
		throw new Error(`Node "${node.name}" is not a SoundNode.`);
	}
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
	if (!isSoundNode(node)) {
		throw new Error(`Node "${node.name}" is not a SoundNode.`);
	}
	const sound = node as SoundNode;
	if (data.playing) {
		sound.play({ startOffset: data.startOffset });
	} else {
		sound.stop();
	}
	return getSound(scene, { nodeId: sound.id });
}
