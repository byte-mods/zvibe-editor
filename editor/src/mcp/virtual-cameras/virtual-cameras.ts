import { Scene, Tools, Vector3 } from "babylonjs";
import {
	clearVirtualCameraRuntimeState,
	controlVirtualCameraPathTimeline,
	emptyCameraNoiseChannels,
	evaluateVirtualCamera,
	getVirtualCameraRuntimeState,
	ICameraNoiseProfile,
	ISplineCameraTimeline,
	IVirtualCamera,
	validateCameraNoiseProfile,
	validateSplineCameraTimeline,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

interface ITargetGroup {
	id: string;
	name: string;
	members: Array<{ nodeId: string; weight: number }>;
}

function controllers(scene: Scene): IVirtualCamera[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorVirtualCameras ??= [];
	return scene.metadata.babylonEditorVirtualCameras;
}

function targetGroups(scene: Scene): ITargetGroup[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorCameraTargetGroups ??= [];
	return scene.metadata.babylonEditorCameraTargetGroups;
}

function noiseProfiles(scene: Scene): ICameraNoiseProfile[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorCameraNoiseProfiles ??= [];
	return scene.metadata.babylonEditorCameraNoiseProfiles;
}

function findNoiseProfile(scene: Scene, data: any): ICameraNoiseProfile {
	const result = noiseProfiles(scene).find((value) => value.id === data.noiseProfileId || value.name === data.noiseProfileName);
	if (!result) {
		throw new Error("Camera noise profile not found.");
	}
	return result;
}

function findTargetGroup(scene: Scene, data: any): ITargetGroup {
	const result = targetGroups(scene).find((value) => value.id === data.targetGroupId || value.name === data.targetGroupName);
	if (!result) {
		throw new Error("Camera target group not found.");
	}
	return result;
}

function find(scene: Scene, data: any): IVirtualCamera {
	const result = controllers(scene).find((value) => value.id === data.virtualCameraId || value.name === data.virtualCameraName);
	if (!result) {
		throw new Error("Virtual camera not found.");
	}
	return result;
}

function apply(scene: Scene, value: IVirtualCamera): any {
	const runtime = evaluateVirtualCamera(scene as any, value, 0, true);
	return { ...structuredClone(value), activeCameraId: value.cameraId, position: runtime.resolvedPosition, runtime };
}

/** Lists persisted virtual camera definitions. */
export function listVirtualCameras(scene: Scene): any {
	return { virtualCameras: structuredClone(controllers(scene)) };
}

/** Creates a follow/look-at virtual camera around an existing editor camera. */
export function createVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (controllers(scene).some((candidate) => candidate.name === data.name)) {
		throw new Error(`Virtual camera "${data.name}" already exists.`);
	}
	if (!scene.cameras.some((camera) => camera.id === data.cameraId)) {
		throw new Error(`Camera "${data.cameraId}" was not found.`);
	}
	const value: IVirtualCamera = {
		id: Tools.RandomId(),
		name: data.name,
		cameraId: data.cameraId,
		followNodeId: data.followNodeId,
		lookAtNodeId: data.lookAtNodeId,
		followTargetGroupId: data.followTargetGroupId,
		lookAtTargetGroupId: data.lookAtTargetGroupId,
		offset: data.offset ?? [0, 0, 0],
		priority: data.priority ?? 0,
		impulseChannelMask: 0x7fffffff,
	};
	if (value.offset.length !== 3 || !value.offset.every(Number.isFinite)) {
		throw new Error("Offset must be finite [x, y, z].");
	}
	if (value.followNodeId) {
		resolveNode({ scene, nodeId: value.followNodeId });
	}
	if (value.lookAtNodeId) {
		resolveNode({ scene, nodeId: value.lookAtNodeId });
	}
	if (value.followTargetGroupId) {
		findTargetGroup(scene, { targetGroupId: value.followTargetGroupId });
	}
	if (value.lookAtTargetGroupId) {
		findTargetGroup(scene, { targetGroupId: value.lookAtTargetGroupId });
	}
	controllers(scene).push(value);
	if (data.activate) {
		apply(scene, value);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Lists persisted weighted camera target groups. */
export function listCameraTargetGroups(scene: Scene): any {
	return { targetGroups: structuredClone(targetGroups(scene)) };
}

/** Creates or replaces a weighted camera target group. */
export function setCameraTargetGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!Array.isArray(data.members) || !data.members.length) {
		throw new Error("A camera target group requires at least one member.");
	}
	const members = data.members.map((member: any) => {
		if (!Number.isFinite(member.weight) || member.weight <= 0) {
			throw new Error("Target-group member weights must be greater than zero.");
		}
		resolveNode({ scene, nodeId: member.nodeId });
		return { nodeId: member.nodeId, weight: member.weight };
	});
	const existing = data.targetGroupId || data.targetGroupName ? findTargetGroup(scene, data) : undefined;
	if (!existing && targetGroups(scene).some((candidate) => candidate.name === data.name)) {
		throw new Error(`Camera target group "${data.name}" already exists.`);
	}
	const value = existing ?? { id: Tools.RandomId(), name: data.name, members };
	value.name = data.name ?? value.name;
	value.members = members;
	if (!existing) {
		targetGroups(scene).push(value);
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Assigns weighted camera target groups to a virtual camera's follow and look-at behaviors. */
export function setVirtualCameraTargetGroups(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (data.followTargetGroupId !== undefined) {
		if (data.followTargetGroupId === null) {
			delete value.followTargetGroupId;
		} else {
			findTargetGroup(scene, { targetGroupId: data.followTargetGroupId });
			value.followTargetGroupId = data.followTargetGroupId;
		}
	}
	if (data.lookAtTargetGroupId !== undefined) {
		if (data.lookAtTargetGroupId === null) {
			delete value.lookAtTargetGroupId;
		} else {
			findTargetGroup(scene, { targetGroupId: data.lookAtTargetGroupId });
			value.lookAtTargetGroupId = data.lookAtTargetGroupId;
		}
	}
	apply(scene, value);
	options.editor.layout.inspector.setEditedObject(scene.activeCamera!);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Deletes a target group, clearing virtual-camera references without deleting scene nodes. */
export function deleteCameraTargetGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = findTargetGroup(scene, data);
	targetGroups(scene).splice(targetGroups(scene).indexOf(value), 1);
	for (const camera of controllers(scene)) {
		if (camera.followTargetGroupId === value.id) {
			delete camera.followTargetGroupId;
		}
		if (camera.lookAtTargetGroupId === value.id) {
			delete camera.lookAtTargetGroupId;
		}
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}

/** Activates a virtual camera and applies its current follow/look-at pose. */
export function activateVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = apply(scene, find(scene, data));
	options.editor.layout.inspector.setEditedObject(scene.activeCamera!);
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Activates the highest-priority virtual camera. */
export function activateHighestPriorityVirtualCamera(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const value = [...controllers(scene)].sort((a, b) => b.priority - a.priority)[0];
	if (!value) {
		throw new Error("No virtual cameras exist.");
	}
	return activateVirtualCamera(scene, { virtualCameraId: value.id }, options);
}

/** Interpolates the active camera into a destination virtual camera before activating it. */
export function blendVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	const destination = find(scene, data);
	const source = scene.activeCamera;
	if (!source) {
		throw new Error("No active camera is available to blend from.");
	}
	apply(scene, destination);
	const destinationCamera = scene.activeCamera!;
	const start = source.position.clone(),
		end = destinationCamera.position.clone(),
		duration = Math.max(0, data.duration ?? 0.5);
	if (!duration) {
		return activateVirtualCamera(scene, { virtualCameraId: destination.id }, options);
	}
	scene.activeCamera = source;
	let elapsed = 0;
	const observer = scene.onBeforeRenderObservable.add(() => {
		elapsed += Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		const amount = Math.min(1, elapsed / duration);
		source.position.copyFrom(Vector3.Lerp(start, end, amount));
		if (amount >= 1) {
			scene.activeCamera = destinationCamera;
			scene.onBeforeRenderObservable.remove(observer);
		}
	});
	return { blending: true, fromCameraId: source.id, toVirtualCameraId: destination.id, duration };
}

/** Configures a persisted spline dolly for a virtual camera. */
export function setVirtualCameraDolly(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (data.splineId === null) {
		if (value.pathTimeline) {
			throw new Error("Delete the virtual camera's spline path timeline before detaching its dolly.");
		}
		delete value.dolly;
		options.editor.layout.inspector.setEditedObject(scene);
		options.editor.layout.inspector.forceUpdate();
		return structuredClone(value);
	}
	const spline = resolveNode({ scene, nodeId: data.splineId }) as any;
	if (spline.metadata?.type !== "Spline") {
		throw new Error(`Node "${spline.name}" is not an editor spline.`);
	}
	if (data.t !== undefined && (!Number.isFinite(data.t) || data.t < 0 || data.t > 1)) {
		throw new Error("Dolly t must be between 0 and 1.");
	}
	if (data.speed !== undefined && (!Number.isFinite(data.speed) || data.speed < 0)) {
		throw new Error("Dolly speed must be zero or greater.");
	}
	value.dolly = {
		splineId: spline.id,
		t: data.t ?? value.dolly?.t ?? 0,
		speed: data.speed ?? value.dolly?.speed ?? 100,
		loop: data.loop ?? value.dolly?.loop ?? true,
		orientToPath: data.orientToPath ?? value.dolly?.orientToPath ?? true,
	};
	const camera = scene.cameras.find((candidate) => candidate.id === value.cameraId);
	if (camera) {
		evaluateVirtualCamera(scene as any, value, 0, false);
	}
	options.editor.layout.inspector.setEditedObject(camera ?? scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Reads one exact authored spline camera timeline plus its transient playback evidence. */
export function getVirtualCameraPathTimeline(scene: Scene, data: any): any {
	const value = find(scene, data);
	const runtime = value.pathTimeline ? evaluateVirtualCamera(scene as any, value, 0, false).pathTimeline : null;
	return {
		model: "unity-spline-camera-path-timeline-v1",
		virtualCameraId: value.id,
		cameraId: value.cameraId,
		timeline: structuredClone(value.pathTimeline ?? null),
		runtime,
		limits: { maximumKeys: 512, maximumDurationSeconds: 86_400 },
	};
}

/** Creates, exact-revision updates, or clears a virtual camera's persisted spline path timeline. */
export function setVirtualCameraPathTimeline(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	const existing = value.pathTimeline;
	if (data.clear === true) {
		if (!existing) {
			throw new Error("Virtual camera does not have a spline path timeline.");
		}
		if (data.expectedRevision !== existing.revision) {
			throw new Error(`Spline camera timeline is stale: expected revision ${data.expectedRevision}, current revision is ${existing.revision}. Read it again.`);
		}
		delete value.pathTimeline;
		clearVirtualCameraRuntimeState(scene as any, value.id);
		options.editor.layout.inspector.setEditedObject(scene.getCameraById(value.cameraId) ?? scene);
		options.editor.layout.inspector.forceUpdate();
		return { cleared: true, virtualCameraId: value.id, revision: existing.revision };
	}
	if (!value.dolly) {
		throw new Error("Attach the virtual camera to a spline dolly before creating a path timeline.");
	}
	if (existing && data.expectedRevision !== existing.revision) {
		throw new Error(`Spline camera timeline is stale: expected revision ${data.expectedRevision}, current revision is ${existing.revision}. Read it again.`);
	}
	if (!existing && data.expectedRevision !== undefined) {
		throw new Error("A new spline camera timeline does not accept expectedRevision.");
	}
	if (!existing && (data.duration === undefined || data.keys === undefined)) {
		throw new Error("A new spline camera timeline requires duration and keys.");
	}
	const keys = structuredClone(data.keys ?? existing!.keys).map((key: any) => ({
		id: key.id ?? Tools.RandomId(),
		time: key.time,
		t: key.t,
		easing: key.easing ?? "linear",
	}));
	const next: ISplineCameraTimeline = {
		version: 1,
		revision: (existing?.revision ?? 0) + 1,
		duration: data.duration ?? existing!.duration,
		autoPlay: data.autoPlay ?? existing?.autoPlay ?? false,
		wrapMode: data.wrapMode ?? existing?.wrapMode ?? "once",
		keys,
	};
	validateSplineCameraTimeline(next);
	value.pathTimeline = next;
	clearVirtualCameraRuntimeState(scene as any, value.id);
	const runtime = evaluateVirtualCamera(scene as any, value, 0, scene.metadata?.babylonEditorActiveVirtualCameraId === value.id).pathTimeline;
	options.editor.layout.inspector.setEditedObject(scene.getCameraById(value.cameraId) ?? scene);
	options.editor.layout.inspector.forceUpdate();
	return { model: "unity-spline-camera-path-timeline-v1", virtualCameraId: value.id, timeline: structuredClone(next), runtime };
}

/** Plays, pauses, stops, or seeks one exact-revision spline camera timeline. */
export function controlVirtualCameraPathTimelinePlayback(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (!value.pathTimeline) {
		throw new Error("Virtual camera does not have a spline path timeline.");
	}
	if (data.expectedRevision !== value.pathTimeline.revision) {
		throw new Error(`Spline camera timeline is stale: expected revision ${data.expectedRevision}, current revision is ${value.pathTimeline.revision}. Read it again.`);
	}
	const runtime = controlVirtualCameraPathTimeline(scene as any, value, data.action, data.time, scene.metadata?.babylonEditorActiveVirtualCameraId === value.id);
	options.editor.layout.inspector.setEditedObject(scene.getCameraById(value.cameraId) ?? scene);
	options.editor.layout.inspector.forceUpdate();
	return { model: "unity-spline-camera-path-timeline-v1", virtualCameraId: value.id, revision: value.pathTimeline.revision, runtime };
}

/** Deletes a virtual camera definition without deleting its real camera. */
export function deleteVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	controllers(scene).splice(controllers(scene).indexOf(value), 1);
	clearVirtualCameraRuntimeState(scene as any, value.id);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}

/** Lists reusable six-axis layered camera-noise profile assets. */
export function listCameraNoiseProfiles(scene: Scene): any {
	return { noiseProfiles: structuredClone(noiseProfiles(scene)) };
}

/** Creates or atomically replaces a reusable layered camera-noise profile. */
export function setCameraNoiseProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const existing = data.noiseProfileId || data.noiseProfileName ? findNoiseProfile(scene, data) : undefined;
	if (!existing && noiseProfiles(scene).some((value) => value.name === data.name)) {
		throw new Error(`Camera noise profile "${data.name}" already exists.`);
	}
	if (existing && noiseProfiles(scene).some((value) => value !== existing && value.name === data.name)) {
		throw new Error(`Camera noise profile "${data.name}" already exists.`);
	}
	const value: ICameraNoiseProfile = {
		id: existing?.id ?? Tools.RandomId(),
		name: data.name ?? existing?.name,
		position: structuredClone(data.position ?? existing?.position ?? emptyCameraNoiseChannels()),
		rotation: structuredClone(data.rotation ?? existing?.rotation ?? emptyCameraNoiseChannels()),
	};
	validateCameraNoiseProfile(value);
	if (existing) {
		noiseProfiles(scene)[noiseProfiles(scene).indexOf(existing)] = value;
	} else {
		noiseProfiles(scene).push(value);
	}
	options.editor.layout.inspector?.setEditedObject(scene.getCameraById(data.cameraId) ?? scene);
	options.editor.layout.inspector?.forceUpdate();
	return structuredClone(value);
}

/** Deletes a reusable noise profile, refusing active references unless force is explicit. */
export function deleteCameraNoiseProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const profile = findNoiseProfile(scene, data);
	const references = controllers(scene).filter((value) => value.noise?.profileId === profile.id);
	const impulseReferences = ((scene.metadata?.babylonEditorCameraImpulseSources ?? []) as any[]).filter((value) => value.noiseProfileId === profile.id);
	if ((references.length || impulseReferences.length) && data.force !== true) {
		throw new Error("Camera noise profile is still referenced. Pass force true to clear those references and delete it.");
	}
	for (const value of references) {
		delete value.noise;
	}
	for (const source of impulseReferences) {
		delete source.noiseProfileId;
	}
	noiseProfiles(scene).splice(noiseProfiles(scene).indexOf(profile), 1);
	options.editor.layout.inspector?.forceUpdate();
	return { deleted: true, id: profile.id, clearedVirtualCameraCount: references.length, clearedImpulseSourceCount: impulseReferences.length };
}

/** Assigns or clears Basic Multi Channel style continuous noise on one virtual camera. */
export function setVirtualCameraNoise(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (data.noiseProfileId === null) {
		delete value.noise;
	} else {
		const profile = findNoiseProfile(scene, { noiseProfileId: data.noiseProfileId ?? value.noise?.profileId });
		const amplitudeGain = data.amplitudeGain ?? value.noise?.amplitudeGain ?? 1;
		const frequencyGain = data.frequencyGain ?? value.noise?.frequencyGain ?? 1;
		const pivotOffset = data.pivotOffset ?? value.noise?.pivotOffset ?? [0, 0, 0];
		const seed = data.seed ?? value.noise?.seed ?? 0;
		if (!Number.isFinite(amplitudeGain) || amplitudeGain < 0 || amplitudeGain > 1000) {
			throw new Error("Noise amplitudeGain must be within 0..1000.");
		}
		if (!Number.isFinite(frequencyGain) || frequencyGain < 0 || frequencyGain > 1000) {
			throw new Error("Noise frequencyGain must be within 0..1000.");
		}
		if (!Array.isArray(pivotOffset) || pivotOffset.length !== 3 || !pivotOffset.every(Number.isFinite)) {
			throw new Error("Noise pivotOffset must be finite [x, y, z].");
		}
		if (!Number.isInteger(seed) || seed < -2147483648 || seed > 2147483647) {
			throw new Error("Noise seed must be a signed 32-bit integer.");
		}
		value.noise = { profileId: profile.id, enabled: data.enabled ?? value.noise?.enabled ?? true, amplitudeGain, frequencyGain, pivotOffset: [...pivotOffset], seed };
	}
	const runtime = evaluateVirtualCamera(scene as any, value, 0, scene.metadata?.babylonEditorActiveVirtualCameraId === value.id);
	options.editor.layout.inspector?.setEditedObject(scene.getCameraById(value.cameraId)!);
	options.editor.layout.inspector?.forceUpdate();
	return { virtualCamera: structuredClone(value), runtime };
}

/** Configures ray-based obstacle avoidance and shot-quality evaluation for one virtual camera. */
export function setVirtualCameraDeoccluder(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (data.enabled === false && data.clear === true) {
		delete value.deoccluder;
	} else {
		const previous = value.deoccluder;
		const shotQuality = {
			enabled: data.shotQuality?.enabled ?? previous?.shotQuality.enabled ?? true,
			optimalDistance: data.shotQuality?.optimalDistance ?? previous?.shotQuality.optimalDistance ?? 500,
			nearLimit: data.shotQuality?.nearLimit ?? previous?.shotQuality.nearLimit ?? 100,
			farLimit: data.shotQuality?.farLimit ?? previous?.shotQuality.farLimit ?? 2000,
			maximumQualityBoost: data.shotQuality?.maximumQualityBoost ?? previous?.shotQuality.maximumQualityBoost ?? 0.5,
		};
		if (shotQuality.nearLimit < 0 || shotQuality.optimalDistance <= shotQuality.nearLimit || shotQuality.farLimit <= shotQuality.optimalDistance) {
			throw new Error("Shot-quality distances must satisfy 0 <= nearLimit < optimalDistance < farLimit.");
		}
		value.deoccluder = {
			enabled: data.enabled ?? previous?.enabled ?? true,
			avoidObstacles: data.avoidObstacles ?? previous?.avoidObstacles ?? true,
			strategy: data.strategy ?? previous?.strategy ?? "pullForward",
			collideLayerMask: data.collideLayerMask ?? previous?.collideLayerMask ?? 0x0fffffff,
			transparentLayerMask: data.transparentLayerMask ?? previous?.transparentLayerMask ?? 0,
			ignoreNodeIds: [...(data.ignoreNodeIds ?? previous?.ignoreNodeIds ?? [])],
			minimumDistanceFromTarget: data.minimumDistanceFromTarget ?? previous?.minimumDistanceFromTarget ?? 1,
			distanceLimit: data.distanceLimit ?? previous?.distanceLimit ?? 0,
			cameraRadius: data.cameraRadius ?? previous?.cameraRadius ?? 5,
			minimumOcclusionTime: data.minimumOcclusionTime ?? previous?.minimumOcclusionTime ?? 0,
			damping: data.damping ?? previous?.damping ?? 0.5,
			dampingWhenOccluded: data.dampingWhenOccluded ?? previous?.dampingWhenOccluded ?? 0.1,
			maximumEffort: data.maximumEffort ?? previous?.maximumEffort ?? 4,
			shotQuality,
		};
		const settings = value.deoccluder;
		if (!["pullForward", "preserveHeight", "preserveDistance"].includes(settings.strategy)) {
			throw new Error("Unknown virtual-camera deocclusion strategy.");
		}
		if (!Number.isInteger(settings.collideLayerMask) || settings.collideLayerMask < 0 || settings.collideLayerMask > 0x7fffffff) {
			throw new Error("collideLayerMask must be a non-negative signed 31-bit integer.");
		}
		if (!Number.isInteger(settings.transparentLayerMask) || settings.transparentLayerMask < 0 || settings.transparentLayerMask > 0x7fffffff) {
			throw new Error("transparentLayerMask must be a non-negative signed 31-bit integer.");
		}
		if (settings.ignoreNodeIds.length > 128 || new Set(settings.ignoreNodeIds).size !== settings.ignoreNodeIds.length) {
			throw new Error("ignoreNodeIds must contain up to 128 unique node ids.");
		}
		for (const [name, number, maximum] of [
			["minimumDistanceFromTarget", settings.minimumDistanceFromTarget, 1000000000],
			["distanceLimit", settings.distanceLimit, 1000000000],
			["cameraRadius", settings.cameraRadius, 1000000],
			["minimumOcclusionTime", settings.minimumOcclusionTime, 60],
			["damping", settings.damping, 60],
			["dampingWhenOccluded", settings.dampingWhenOccluded, 60],
		] as const) {
			if (!Number.isFinite(number) || number < 0 || number > maximum) {
				throw new Error(`${name} must be finite and within 0..${maximum}.`);
			}
		}
		if (!Number.isInteger(settings.maximumEffort) || settings.maximumEffort < 1 || settings.maximumEffort > 16) {
			throw new Error("maximumEffort must be an integer from 1 through 16.");
		}
		for (const nodeId of value.deoccluder.ignoreNodeIds) {
			resolveNode({ scene, nodeId });
		}
	}
	clearVirtualCameraRuntimeState(scene as any, value.id);
	const runtime = evaluateVirtualCamera(scene as any, value, 0, scene.metadata?.babylonEditorActiveVirtualCameraId === value.id);
	options.editor.layout.inspector?.setEditedObject(scene.getCameraById(value.cameraId)!);
	options.editor.layout.inspector?.forceUpdate();
	return { virtualCamera: structuredClone(value), runtime };
}

/** Sets the virtual camera's Cinemachine-style impulse listener channel mask. */
export function setVirtualCameraImpulseListener(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (!Number.isInteger(data.channelMask) || data.channelMask < 1 || data.channelMask > 0x7fffffff) {
		throw new Error("channelMask must be an integer from 1 through 2147483647.");
	}
	value.impulseChannelMask = data.channelMask;
	options.editor.layout.inspector?.setEditedObject(scene.getCameraById(value.cameraId)!);
	options.editor.layout.inspector?.forceUpdate();
	return structuredClone(value);
}

/** Reads the latest deocclusion, shot-quality, and correction-noise evidence without advancing the camera. */
export function getVirtualCameraRuntime(scene: Scene, data: any): any {
	const value = find(scene, data);
	return {
		virtualCamera: structuredClone(value),
		evaluated: getVirtualCameraRuntimeState(scene as any, value.id) !== null,
		runtime: getVirtualCameraRuntimeState(scene as any, value.id),
	};
}
