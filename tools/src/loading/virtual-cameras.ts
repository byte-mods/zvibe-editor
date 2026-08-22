import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Scene } from "@babylonjs/core/scene";

import { evaluateCameraNoiseProfile, ICameraNoiseProfile } from "./camera-noise";
import {
	advanceSplineCameraTimeline,
	ISplineCameraTimeline,
	ISplineCameraTimelineSample,
	sampleSplineCameraTimeline,
	validateSplineCameraTimeline,
} from "./spline-camera-timeline";
import { evaluateSplineGeometry } from "./splines";

export interface IVirtualCameraDolly {
	splineId: string;
	t: number;
	speed: number;
	loop: boolean;
	orientToPath: boolean;
}

export interface IVirtualCameraNoiseSettings {
	profileId: string;
	enabled: boolean;
	amplitudeGain: number;
	frequencyGain: number;
	pivotOffset: number[];
	seed: number;
}

export type TVirtualCameraDeocclusionStrategy = "pullForward" | "preserveHeight" | "preserveDistance";

export interface IVirtualCameraShotQualitySettings {
	enabled: boolean;
	optimalDistance: number;
	nearLimit: number;
	farLimit: number;
	maximumQualityBoost: number;
}

export interface IVirtualCameraDeoccluderSettings {
	enabled: boolean;
	avoidObstacles: boolean;
	strategy: TVirtualCameraDeocclusionStrategy;
	collideLayerMask: number;
	transparentLayerMask: number;
	ignoreNodeIds: string[];
	minimumDistanceFromTarget: number;
	distanceLimit: number;
	cameraRadius: number;
	minimumOcclusionTime: number;
	damping: number;
	dampingWhenOccluded: number;
	maximumEffort: number;
	shotQuality: IVirtualCameraShotQualitySettings;
}

export interface IVirtualCamera {
	id: string;
	name?: string;
	cameraId: string;
	followNodeId?: string;
	lookAtNodeId?: string;
	followTargetGroupId?: string;
	lookAtTargetGroupId?: string;
	offset: number[];
	priority: number;
	impulseChannelMask?: number;
	dolly?: IVirtualCameraDolly;
	pathTimeline?: ISplineCameraTimeline;
	noise?: IVirtualCameraNoiseSettings;
	deoccluder?: IVirtualCameraDeoccluderSettings;
}

export interface IVirtualCameraPathTimelineRuntimeState {
	configured: boolean;
	revision: number;
	time: number;
	duration: number;
	playing: boolean;
	direction: 1 | -1;
	loopCount: number;
	pathT: number;
	fromKeyId: string;
	toKeyId: string;
	segmentAmount: number;
	easedAmount: number;
}

export interface IVirtualCameraRuntimeState {
	virtualCameraId: string;
	cameraId: string;
	evaluationCount: number;
	idealPosition: number[];
	resolvedPosition: number[];
	targetPosition: number[] | null;
	targetObscured: boolean;
	cameraDisplaced: boolean;
	displacementDistance: number;
	obstacleNodeId: string | null;
	strategy: TVirtualCameraDeocclusionStrategy | null;
	shotQuality: number;
	noiseProfileId: string | null;
	noisePositionOffset: number[];
	noiseRotationDegrees: number[];
	pathTimeline: IVirtualCameraPathTimelineRuntimeState | null;
	warnings: string[];
}

interface ITargetGroup {
	id: string;
	members: Array<{ nodeId: string; weight: number }>;
}

interface IInternalVirtualCameraState {
	elapsedSeconds: number;
	evaluationCount: number;
	occludedSeconds: number;
	displacement: Vector3;
	lastNoisePosition: Vector3;
	lastNoiseRotation: Vector3;
	timelineRevision: number | null;
	timelineTime: number;
	timelinePlaying: boolean;
	timelineDirection: 1 | -1;
	timelineLoopCount: number;
	publicState: IVirtualCameraRuntimeState;
}

const configuredScenes = new WeakSet<Scene>();
const runtimeStates = new WeakMap<Scene, Map<string, IInternalVirtualCameraState>>();

function clearPreviousActiveCameraNoise(scene: Scene, nextId: string): void {
	const previousId = scene.metadata?.babylonEditorActiveVirtualCameraId;
	if (!previousId || previousId === nextId) {
		return;
	}
	const previousState = runtimeStates.get(scene)?.get(previousId);
	const previousValue = (scene.metadata?.babylonEditorVirtualCameras as IVirtualCamera[] | undefined)?.find((value) => value.id === previousId);
	const previousCamera = previousValue ? (scene.getCameraById(previousValue.cameraId) as any) : null;
	if (previousState && previousCamera) {
		removeLastNoise(previousCamera, previousState);
	}
}

function stateFor(scene: Scene, value: IVirtualCamera): IInternalVirtualCameraState {
	let states = runtimeStates.get(scene);
	if (!states) {
		states = new Map();
		runtimeStates.set(scene, states);
	}
	let state = states.get(value.id);
	if (!state) {
		state = {
			elapsedSeconds: 0,
			evaluationCount: 0,
			occludedSeconds: 0,
			displacement: Vector3.Zero(),
			lastNoisePosition: Vector3.Zero(),
			lastNoiseRotation: Vector3.Zero(),
			timelineRevision: null,
			timelineTime: 0,
			timelinePlaying: false,
			timelineDirection: 1,
			timelineLoopCount: 0,
			publicState: {
				virtualCameraId: value.id,
				cameraId: value.cameraId,
				evaluationCount: 0,
				idealPosition: [0, 0, 0],
				resolvedPosition: [0, 0, 0],
				targetPosition: null,
				targetObscured: false,
				cameraDisplaced: false,
				displacementDistance: 0,
				obstacleNodeId: null,
				strategy: null,
				shotQuality: 1,
				noiseProfileId: null,
				noisePositionOffset: [0, 0, 0],
				noiseRotationDegrees: [0, 0, 0],
				pathTimeline: null,
				warnings: [],
			},
		};
		states.set(value.id, state);
	}
	return state;
}

function getTargetGroupPosition(scene: Scene, groupId: string): Vector3 | null {
	const groups = scene.metadata?.babylonEditorCameraTargetGroups as ITargetGroup[] | undefined;
	const group = groups?.find((candidate) => candidate.id === groupId);
	if (!group) {
		return null;
	}
	let totalWeight = 0;
	const position = Vector3.Zero();
	for (const member of group.members) {
		const node = scene.getNodeById(member.nodeId) as any;
		if (!node?.getAbsolutePosition) {
			continue;
		}
		node.computeWorldMatrix?.(true);
		position.addInPlace(node.getAbsolutePosition().scale(member.weight));
		totalWeight += member.weight;
	}
	return totalWeight ? position.scale(1 / totalWeight) : null;
}

function getNodePosition(scene: Scene, nodeId: string | undefined): Vector3 | null {
	if (!nodeId) {
		return null;
	}
	const node = scene.getNodeById(nodeId) as any;
	if (!node?.getAbsolutePosition) {
		return null;
	}
	node.computeWorldMatrix?.(true);
	return node.getAbsolutePosition().clone();
}

function resolveFollowPosition(scene: Scene, value: IVirtualCamera): Vector3 | null {
	if (value.followNodeId) {
		return getNodePosition(scene, value.followNodeId);
	}
	if (value.followTargetGroupId) {
		return getTargetGroupPosition(scene, value.followTargetGroupId);
	}
	return null;
}

function resolveLookAtPosition(scene: Scene, value: IVirtualCamera): Vector3 | null {
	if (value.lookAtNodeId) {
		return getNodePosition(scene, value.lookAtNodeId);
	}
	if (value.lookAtTargetGroupId) {
		return getTargetGroupPosition(scene, value.lookAtTargetGroupId);
	}
	return resolveFollowPosition(scene, value);
}

function applyDolly(scene: Scene, camera: any, dolly: IVirtualCameraDolly, elapsedSeconds: number): void {
	const spline = scene.getNodeById(dolly.splineId) as any;
	const sample = spline && evaluateSplineGeometry(spline, dolly.t);
	if (!sample) {
		return;
	}
	if (elapsedSeconds > 0) {
		const delta = (dolly.speed * elapsedSeconds) / sample.length;
		dolly.t = dolly.loop ? (((dolly.t + delta) % 1) + 1) % 1 : Math.min(1, dolly.t + delta);
	}
	const current = evaluateSplineGeometry(spline, dolly.t);
	if (!current) {
		return;
	}
	const position = Vector3.TransformCoordinates(current.position, spline.getWorldMatrix());
	camera.position.copyFrom(position);
	if (dolly.orientToPath) {
		const tangent = Vector3.TransformNormal(current.tangent, spline.getWorldMatrix()).normalize();
		camera.setTarget?.(position.add(tangent));
	}
}

function synchronizeTimelineState(value: IVirtualCamera, state: IInternalVirtualCameraState): ISplineCameraTimeline | null {
	const timeline = value.pathTimeline;
	if (!timeline) {
		state.timelineRevision = null;
		state.timelineTime = 0;
		state.timelinePlaying = false;
		state.timelineDirection = 1;
		state.timelineLoopCount = 0;
		return null;
	}
	validateSplineCameraTimeline(timeline);
	if (state.timelineRevision !== timeline.revision) {
		state.timelineRevision = timeline.revision;
		state.timelineTime = 0;
		state.timelinePlaying = timeline.autoPlay;
		state.timelineDirection = 1;
		state.timelineLoopCount = 0;
	}
	return timeline;
}

function timelineRuntime(value: IVirtualCamera, state: IInternalVirtualCameraState, sample: ISplineCameraTimelineSample): IVirtualCameraPathTimelineRuntimeState {
	return {
		configured: true,
		revision: value.pathTimeline!.revision,
		time: state.timelineTime,
		duration: value.pathTimeline!.duration,
		playing: state.timelinePlaying,
		direction: state.timelineDirection,
		loopCount: state.timelineLoopCount,
		pathT: sample.t,
		fromKeyId: sample.fromKeyId,
		toKeyId: sample.toKeyId,
		segmentAmount: sample.segmentAmount,
		easedAmount: sample.easedAmount,
	};
}

function applyPathTimeline(value: IVirtualCamera, state: IInternalVirtualCameraState, elapsedSeconds: number): IVirtualCameraPathTimelineRuntimeState | null {
	const timeline = synchronizeTimelineState(value, state);
	if (!timeline) {
		return null;
	}
	if (state.timelinePlaying && elapsedSeconds > 0) {
		const advanced = advanceSplineCameraTimeline(state.timelineTime, elapsedSeconds, timeline.duration, timeline.wrapMode, state.timelineDirection);
		state.timelineTime = advanced.time;
		state.timelineDirection = advanced.direction;
		state.timelinePlaying = advanced.playing;
		state.timelineLoopCount += advanced.boundaryCrossings;
	}
	const sample = sampleSplineCameraTimeline(timeline, state.timelineTime);
	if (value.dolly) {
		value.dolly.t = sample.t;
	}
	return timelineRuntime(value, state, sample);
}

function removeLastNoise(camera: any, state: IInternalVirtualCameraState): void {
	camera.position.subtractInPlace(state.lastNoisePosition);
	if (camera.rotationQuaternion) {
		const correction = Quaternion.FromEulerAngles(state.lastNoiseRotation.x, state.lastNoiseRotation.y, state.lastNoiseRotation.z);
		camera.rotationQuaternion.multiplyInPlace(correction.conjugate());
	} else if (camera.rotation) {
		camera.rotation.subtractInPlace(state.lastNoiseRotation);
	}
	state.lastNoisePosition.setAll(0);
	state.lastNoiseRotation.setAll(0);
}

function layerMatches(mesh: any, settings: IVirtualCameraDeoccluderSettings): boolean {
	const layerMask = Number.isInteger(mesh.layerMask) ? mesh.layerMask : 0x0fffffff;
	return (layerMask & settings.collideLayerMask) !== 0 && (layerMask & settings.transparentLayerMask) === 0;
}

function firstObstacle(scene: Scene, target: Vector3, candidate: Vector3, settings: IVirtualCameraDeoccluderSettings): { distance: number; nodeId: string | null } | null {
	const delta = candidate.subtract(target);
	const actualDistance = delta.length();
	const distance = settings.distanceLimit > 0 ? Math.min(actualDistance, settings.distanceLimit) : actualDistance;
	if (distance <= settings.minimumDistanceFromTarget) {
		return null;
	}
	const ignored = new Set(settings.ignoreNodeIds);
	const ray = new Ray(target, delta.normalize(), distance);
	const predicate = (mesh: any): boolean => mesh.isPickable && mesh.isEnabled() && !ignored.has(mesh.id) && layerMatches(mesh, settings);
	for (const mesh of scene.meshes) {
		if (predicate(mesh)) {
			mesh.computeWorldMatrix(true);
		}
	}
	const picks = scene.multiPickWithRay(ray, predicate) ?? [];
	const hit = picks.filter((pick) => pick.hit && pick.pickedMesh && pick.distance >= settings.minimumDistanceFromTarget).sort((left, right) => left.distance - right.distance)[0];
	return hit ? { distance: hit.distance, nodeId: hit.pickedMesh?.id ?? null } : null;
}

function rotateAroundY(vector: Vector3, radians: number): Vector3 {
	const cosine = Math.cos(radians);
	const sine = Math.sin(radians);
	return new Vector3(vector.x * cosine - vector.z * sine, vector.y, vector.x * sine + vector.z * cosine);
}

function resolveDeoccludedPosition(
	scene: Scene,
	target: Vector3,
	ideal: Vector3,
	settings: IVirtualCameraDeoccluderSettings,
	firstHit: { distance: number; nodeId: string | null }
): { position: Vector3; obstacleNodeId: string | null } {
	const direction = ideal.subtract(target);
	const distance = direction.length();
	const pullDistance = Math.max(settings.minimumDistanceFromTarget, Math.min(distance, firstHit.distance - settings.cameraRadius));
	const pulled = target.add(direction.normalize().scale(pullDistance));
	if (settings.strategy === "pullForward" || settings.maximumEffort <= 1) {
		return { position: pulled, obstacleNodeId: firstHit.nodeId };
	}
	const step = Math.PI / 12;
	for (let effort = 1; effort < settings.maximumEffort; effort++) {
		const sign = effort % 2 ? 1 : -1;
		const multiplier = Math.ceil(effort / 2);
		const rotated = rotateAroundY(direction, sign * multiplier * step);
		const candidate = target.add(rotated);
		if (settings.strategy === "preserveHeight") {
			candidate.y = ideal.y;
		}
		if (!firstObstacle(scene, target, candidate, settings)) {
			return { position: candidate, obstacleNodeId: firstHit.nodeId };
		}
	}
	return { position: pulled, obstacleNodeId: firstHit.nodeId };
}

function dampingAmount(seconds: number, elapsedSeconds: number): number {
	return seconds <= 0 || elapsedSeconds <= 0 ? 1 : 1 - Math.exp(-elapsedSeconds / seconds);
}

function evaluateShotQuality(settings: IVirtualCameraDeoccluderSettings, targetDistance: number, displacement: number, obscured: boolean): number {
	let quality = obscured ? 0.25 : Math.max(0.25, 1 - displacement / Math.max(targetDistance, 0.0001));
	const evaluation = settings.shotQuality;
	if (!evaluation.enabled) {
		return quality;
	}
	let distanceFactor = 0;
	if (targetDistance <= evaluation.optimalDistance) {
		distanceFactor = (targetDistance - evaluation.nearLimit) / Math.max(evaluation.optimalDistance - evaluation.nearLimit, 0.0001);
	} else {
		distanceFactor = (evaluation.farLimit - targetDistance) / Math.max(evaluation.farLimit - evaluation.optimalDistance, 0.0001);
	}
	quality *= 1 + Math.max(0, Math.min(1, distanceFactor)) * evaluation.maximumQualityBoost;
	return quality;
}

function applyDeoccluder(scene: Scene, camera: any, value: IVirtualCamera, target: Vector3 | null, state: IInternalVirtualCameraState, elapsedSeconds: number): void {
	const settings = value.deoccluder;
	const ideal = camera.position.clone();
	let resolved = ideal.clone();
	let obstacleNodeId: string | null = null;
	let obscured = false;
	let strategy: TVirtualCameraDeocclusionStrategy | null = null;
	let shotQuality = 1;
	const warnings: string[] = [];
	if (settings?.enabled && target) {
		const effectiveSettings = {
			...settings,
			ignoreNodeIds: [...new Set([...settings.ignoreNodeIds, ...(value.lookAtNodeId ? [value.lookAtNodeId] : []), ...(value.followNodeId ? [value.followNodeId] : [])])],
		};
		const firstHit = firstObstacle(scene, target, ideal, effectiveSettings);
		obscured = !!firstHit;
		state.occludedSeconds = obscured ? state.occludedSeconds + elapsedSeconds : 0;
		let desired = ideal;
		if (firstHit) {
			obstacleNodeId = firstHit.nodeId;
			strategy = settings.strategy;
			if (settings.avoidObstacles && state.occludedSeconds >= settings.minimumOcclusionTime) {
				desired = resolveDeoccludedPosition(scene, target, ideal, effectiveSettings, firstHit).position;
			}
		}
		const previousResolved = ideal.add(state.displacement);
		const damping = firstHit ? settings.dampingWhenOccluded : settings.damping;
		resolved = Vector3.Lerp(previousResolved, desired, dampingAmount(damping, elapsedSeconds));
		const remainingHit = firstObstacle(scene, target, resolved, effectiveSettings);
		obscured = !!remainingHit;
		if (remainingHit) {
			obstacleNodeId = remainingHit.nodeId;
		}
		const displacement = Vector3.Distance(ideal, resolved);
		shotQuality = evaluateShotQuality(settings, Vector3.Distance(target, resolved), displacement, obscured);
		state.displacement.copyFrom(resolved.subtract(ideal));
	} else {
		state.occludedSeconds = 0;
		state.displacement.setAll(0);
		if (settings?.enabled && !target) {
			warnings.push("Deocclusion requires a follow or look-at target.");
		}
	}
	camera.position.copyFrom(resolved);
	state.publicState = {
		virtualCameraId: value.id,
		cameraId: value.cameraId,
		evaluationCount: state.evaluationCount,
		idealPosition: ideal.asArray(),
		resolvedPosition: resolved.asArray(),
		targetPosition: target?.asArray() ?? null,
		targetObscured: obscured,
		cameraDisplaced: !state.displacement.equalsWithEpsilon(Vector3.Zero(), 0.000001),
		displacementDistance: state.displacement.length(),
		obstacleNodeId,
		strategy,
		shotQuality,
		noiseProfileId: null,
		noisePositionOffset: [0, 0, 0],
		noiseRotationDegrees: [0, 0, 0],
		pathTimeline: null,
		warnings,
	};
}

function applyNoise(scene: Scene, camera: any, value: IVirtualCamera, state: IInternalVirtualCameraState): void {
	const settings = value.noise;
	if (!settings?.enabled) {
		return;
	}
	const profiles = (scene.metadata?.babylonEditorCameraNoiseProfiles as ICameraNoiseProfile[] | undefined) ?? [];
	const profile = profiles.find((candidate) => candidate.id === settings.profileId);
	if (!profile) {
		state.publicState.warnings.push(`Camera noise profile "${settings.profileId}" was not found.`);
		return;
	}
	const sample = evaluateCameraNoiseProfile(
		profile,
		state.elapsedSeconds,
		settings.seed,
		settings.amplitudeGain,
		settings.frequencyGain,
		Vector3.FromArray(settings.pivotOffset)
	);
	state.lastNoisePosition.copyFrom(sample.position.add(sample.pivotPosition));
	state.lastNoiseRotation.copyFrom(sample.rotationRadians);
	camera.position.addInPlace(state.lastNoisePosition);
	if (camera.rotationQuaternion) {
		camera.rotationQuaternion.multiplyInPlace(Quaternion.FromEulerAngles(sample.rotationRadians.x, sample.rotationRadians.y, sample.rotationRadians.z));
	} else if (camera.rotation) {
		camera.rotation.addInPlace(sample.rotationRadians);
	}
	state.publicState.noiseProfileId = profile.id;
	state.publicState.noisePositionOffset = state.lastNoisePosition.asArray();
	state.publicState.noiseRotationDegrees = sample.rotationRadians.scale(180 / Math.PI).asArray();
}

/** Evaluates one persisted virtual camera through follow/dolly, deocclusion/shot quality, then correction-channel noise. */
export function evaluateVirtualCamera(scene: Scene, value: IVirtualCamera, elapsedSeconds = 0, activate = true): IVirtualCameraRuntimeState {
	const camera = scene.getCameraById(value.cameraId) as any;
	if (!camera) {
		throw new Error(`Camera "${value.cameraId}" was not found.`);
	}
	const state = stateFor(scene, value);
	removeLastNoise(camera, state);
	state.elapsedSeconds += Math.max(0, elapsedSeconds);
	state.evaluationCount++;
	const pathTimeline = applyPathTimeline(value, state, Math.max(0, elapsedSeconds));
	if (value.dolly) {
		applyDolly(scene, camera, value.dolly, pathTimeline ? 0 : Math.max(0, elapsedSeconds));
	}
	const follow = resolveFollowPosition(scene, value);
	if (follow) {
		camera.position.copyFrom(follow.add(Vector3.FromArray(value.offset)));
	}
	const target = resolveLookAtPosition(scene, value);
	if (target) {
		camera.setTarget?.(target);
	}
	applyDeoccluder(scene, camera, value, target, state, Math.max(0, elapsedSeconds));
	state.publicState.pathTimeline = pathTimeline;
	if (pathTimeline && !value.dolly) {
		state.publicState.warnings.push("Spline camera timeline requires an attached dolly.");
	}
	if (target) {
		camera.setTarget?.(target);
	}
	applyNoise(scene, camera, value, state);
	if (activate) {
		clearPreviousActiveCameraNoise(scene, value.id);
		scene.activeCamera = camera;
		scene.metadata ??= {};
		scene.metadata.babylonEditorActiveVirtualCameraId = value.id;
	}
	return structuredClone(state.publicState);
}

/** Controls one virtual camera's transient path-timeline clock without changing authored keys. */
export function controlVirtualCameraPathTimeline(
	scene: Scene,
	value: IVirtualCamera,
	action: "play" | "pause" | "stop" | "seek",
	time?: number,
	activate = false
): IVirtualCameraPathTimelineRuntimeState {
	const state = stateFor(scene, value);
	const timeline = synchronizeTimelineState(value, state);
	if (!timeline) {
		throw new Error("Virtual camera does not have a spline path timeline.");
	}
	switch (action) {
		case "play":
			state.timelinePlaying = true;
			if (timeline.wrapMode === "once" && state.timelineTime >= timeline.duration) {
				state.timelineTime = 0;
				state.timelineDirection = 1;
			}
			break;
		case "pause":
			state.timelinePlaying = false;
			break;
		case "stop":
			state.timelineTime = 0;
			state.timelinePlaying = false;
			state.timelineDirection = 1;
			state.timelineLoopCount = 0;
			break;
		case "seek":
			assertTimelineSeek(time, timeline.duration);
			state.timelineTime = time!;
			state.timelineDirection = 1;
			break;
	}
	const result = evaluateVirtualCamera(scene, value, 0, activate).pathTimeline;
	if (!result) {
		throw new Error("Spline path timeline did not produce runtime state.");
	}
	return result;
}

function assertTimelineSeek(time: number | undefined, duration: number): void {
	if (!Number.isFinite(time) || time! < 0 || time! > duration) {
		throw new Error(`Timeline seek time must be within 0..${duration}.`);
	}
}

export function getVirtualCameraRuntimeState(scene: Scene, virtualCameraId: string): IVirtualCameraRuntimeState | null {
	return structuredClone(runtimeStates.get(scene)?.get(virtualCameraId)?.publicState ?? null);
}

export function clearVirtualCameraRuntimeState(scene: Scene, virtualCameraId?: string): void {
	if (virtualCameraId) {
		const state = runtimeStates.get(scene)?.get(virtualCameraId);
		const camera = state ? (scene.getCameraById(state.publicState.cameraId) as any) : null;
		if (state && camera) {
			removeLastNoise(camera, state);
		}
		runtimeStates.get(scene)?.delete(virtualCameraId);
	} else {
		for (const state of runtimeStates.get(scene)?.values() ?? []) {
			const camera = scene.getCameraById(state.publicState.cameraId) as any;
			if (camera) {
				removeLastNoise(camera, state);
			}
		}
		runtimeStates.delete(scene);
	}
}

/** Restores the active persisted virtual camera and evaluates its full procedural pipeline every frame. */
export function configureVirtualCameras(scene: Scene): void {
	if (configuredScenes.has(scene)) {
		return;
	}
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => {
		const cameras = scene.metadata?.babylonEditorVirtualCameras as IVirtualCamera[] | undefined;
		if (!cameras?.length) {
			return;
		}
		const activeId = scene.metadata?.babylonEditorActiveVirtualCameraId;
		const value = cameras.find((camera) => camera.id === activeId) ?? [...cameras].sort((left, right) => right.priority - left.priority)[0];
		evaluateVirtualCamera(scene, value, Math.max(0, scene.getEngine().getDeltaTime() / 1000), true);
	});
}
