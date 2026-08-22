import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";

import { getDefaultRenderingPipeline } from "../rendering/default-pipeline";
import { getAnimationTypeForObject } from "../tools/animation";
import { getNodeById } from "../tools/scene";
import { SoundNode } from "../tools/sound";
import { IVideoPlayerRuntime, pauseConfiguredVideoPlayer, seekConfiguredVideoPlayer } from "../loading/videos";
import { parseCinematicKeyValue } from "./parse";
import {
	CinematicPlaybackClock,
	ICinematicAdvanceResult,
	ICinematicControlSample,
	ICinematicFrameEvaluation,
	ICinematicMarkerOccurrence,
	ICinematicRecorderSample,
} from "./evaluation";
import { ICinematicDocument, TCinematicPropertyValue } from "./model";

const activeScenePlayers = new WeakMap<Scene, CinematicScenePlayer>();

/** Supplies host callbacks and sound policy for engine-side playback integration. */
export interface ICinematicScenePlayerOptions {
	ignoreSounds?: boolean;
	onSignal?: (occurrence: ICinematicMarkerOccurrence) => void;
	onEvent?: (occurrence: ICinematicMarkerOccurrence) => void;
	onControl?: (sample: ICinematicControlSample, entering: boolean) => void;
	onRecorder?: (sample: ICinematicRecorderSample, entering: boolean) => void;
}

/** Retains one original property value for deterministic preview restoration. */
interface ICinematicPropertyRestorePoint {
	target: Record<string, unknown>;
	property: string;
	value: unknown;
}

/** Retains the standalone Video Player state temporarily leased by a Timeline clip. */
interface ICinematicVideoRestorePoint {
	runtime: IVideoPlayerRuntime;
	currentTime: number;
	manualTime: number;
	manualPlaying: boolean;
	status: IVideoPlayerRuntime["status"];
	error: string | null;
	browserPlaying: boolean;
	loop: boolean;
	muted: boolean;
	volume: number;
	playbackRate: number;
	textureLevel: number;
}

/** Copies Babylon math values via clone and portable data via structured cloning. */
function cloneRuntimeValue(value: unknown): unknown {
	if (value && typeof value === "object" && "clone" in value && typeof (value as { clone?: unknown }).clone === "function") {
		return (value as { clone: () => unknown }).clone();
	}
	return structuredClone(value);
}

/** Resolves a previously validated dotted path to the exact object and final property slot. */
function propertyTarget(root: unknown, propertyPath: string): { target: Record<string, unknown>; property: string } {
	if (!root || typeof root !== "object") {
		throw new Error(`Cinematic property binding "${propertyPath}" has no runtime target.`);
	}
	const parts = propertyPath.split(".");
	let target = root as Record<string, unknown>;
	for (const part of parts.slice(0, -1)) {
		const next = target[part];
		if (!next || typeof next !== "object") {
			throw new Error(`Cinematic property binding "${propertyPath}" cannot resolve segment "${part}".`);
		}
		target = next as Record<string, unknown>;
	}
	return { target, property: parts[parts.length - 1] };
}

/** Rehydrates numeric arrays into the Babylon math type already held by the binding. */
function runtimePropertyValue(value: TCinematicPropertyValue, current: unknown): unknown {
	if (!Array.isArray(value)) {
		return value;
	}
	const animationType = getAnimationTypeForObject(current);
	return animationType === null ? [...value] : parseCinematicKeyValue(value, animationType);
}

/** Extracts world orientation so unrelated camera subclasses can participate in one blend. */
function cameraRotation(camera: Camera): Quaternion {
	const rotation = Quaternion.Identity();
	camera.computeWorldMatrix().decompose(undefined, rotation);
	return rotation;
}

/** Applies normalized cinematic transport to a Babylon scene while owning and restoring every preview mutation it makes. */
export class CinematicScenePlayer {
	public readonly clock: CinematicPlaybackClock;

	private readonly _scene: Scene;
	private readonly _options: ICinematicScenePlayerOptions;
	private readonly _framesPerSecond: number;
	private readonly _initialActiveCamera: Camera | null;
	private readonly _propertyRestorePoints = new Map<string, ICinematicPropertyRestorePoint>();
	private readonly _activationRestorePoints = new Map<string, { node: Node; enabled: boolean }>();
	private readonly _animationGroups = new Set<AnimationGroup>();
	private readonly _activeSounds = new Map<string, { node: SoundNode; clipId: string }>();
	private readonly _videoRestorePoints = new Map<string, ICinematicVideoRestorePoint>();
	private readonly _activeControlClips = new Map<string, ICinematicControlSample>();
	private readonly _activeRecorderClips = new Map<string, ICinematicRecorderSample>();
	private _blendCamera: UniversalCamera | null = null;
	private _disposed = false;

	/** Creates an isolated playback clock and snapshots the camera that must be restored on stop. */
	public constructor(document: ICinematicDocument, scene: Scene, options: ICinematicScenePlayerOptions = {}) {
		this.clock = new CinematicPlaybackClock(document);
		this._scene = scene;
		this._options = options;
		this._framesPerSecond = this.clock.document.framesPerSecond;
		this._initialActiveCamera = scene.activeCamera;
	}

	/** Starts real-time clock advances without changing the currently evaluated frame. */
	public play(): void {
		this._assertUsable();
		this._acquireScene();
		this.clock.play();
	}

	/** Pauses real-time clock advances while retaining the current live evaluation. */
	public pause(): void {
		this._assertUsable();
		this.clock.pause();
	}

	/** Advances real time, dispatches crossed markers, and applies the resulting scene state. */
	public advance(deltaSeconds: number): ICinematicAdvanceResult {
		this._assertUsable();
		this._acquireScene();
		const result = this.clock.advance(deltaSeconds);
		this._dispatchMarkers(result.markers);
		this.apply();
		return result;
	}

	/** Advances an exact integer frame count, dispatches markers, and applies the result even while paused. */
	public step(frameCount = 1): ICinematicAdvanceResult {
		this._assertUsable();
		this._acquireScene();
		const result = this.clock.step(frameCount);
		this._dispatchMarkers(result.markers);
		this.apply();
		return result;
	}

	/** Seeks and optionally dispatches retroactive markers before applying the exact destination frame. */
	public seek(frame: number, emitRetroactive = false): ICinematicMarkerOccurrence[] {
		this._assertUsable();
		this._acquireScene();
		this._stopSounds();
		const markers = this.clock.seek(frame, emitRetroactive);
		this._dispatchMarkers(markers);
		this.apply();
		return markers;
	}

	/** Applies the clock's current engine-independent snapshot to supported Babylon scene objects. */
	public apply(): ICinematicFrameEvaluation {
		this._assertUsable();
		this._acquireScene();
		const evaluation = this.clock.evaluate();
		this._applyProperties(evaluation);
		this._applyAnimations(evaluation);
		this._applySounds(evaluation);
		this._applyVideos(evaluation);
		this._applyActivations(evaluation);
		this._applyCameras(evaluation);
		this._applyControls(evaluation);
		this._applyRecorders(evaluation);
		return evaluation;
	}

	/** Stops transport and restores properties, enablement, cameras, sounds, and temporary animation state. */
	public stop(): void {
		this._assertUsable();
		this.clock.stop();
		this._restoreSceneState();
		this._releaseScene();
	}

	/** Restores the scene once and permanently releases the temporary blend camera. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._restoreSceneState();
		this._blendCamera?.dispose();
		this._blendCamera = null;
		this._releaseScene();
		this._disposed = true;
	}

	/** Prevents scene mutation after the player has released its restoration state. */
	private _assertUsable(): void {
		if (this._disposed) {
			throw new Error("Cinematic scene player is disposed.");
		}
	}

	/** Leases one scene so independent players cannot capture and restore over each other. */
	private _acquireScene(): void {
		const active = activeScenePlayers.get(this._scene);
		if (active && active !== this) {
			throw new Error("The Babylon scene is already controlled by another cinematic player.");
		}
		activeScenePlayers.set(this._scene, this);
	}

	/** Releases this player's scene lease without disturbing a later owner. */
	private _releaseScene(): void {
		if (activeScenePlayers.get(this._scene) === this) {
			activeScenePlayers.delete(this._scene);
		}
	}

	/** Resolves and writes property samples while retaining one original value per binding. */
	private _applyProperties(evaluation: ICinematicFrameEvaluation): void {
		for (const sample of evaluation.properties) {
			const root = sample.targetType === "renderingPipeline" ? getDefaultRenderingPipeline() : getNodeById(sample.targetId!, this._scene);
			const binding = propertyTarget(root, sample.propertyPath);
			const bindingId = `${sample.targetType}:${sample.targetId ?? "pipeline"}:${sample.propertyPath}`;
			if (!this._propertyRestorePoints.has(bindingId)) {
				this._propertyRestorePoints.set(bindingId, { ...binding, value: cloneRuntimeValue(binding.target[binding.property]) });
			}
			binding.target[binding.property] = runtimePropertyValue(sample.value, binding.target[binding.property]);
		}
	}

	/** Starts animation groups once, pauses transport, and drives exact source frame and weight. */
	private _applyAnimations(evaluation: ICinematicFrameEvaluation): void {
		const samples = new Map<string, (typeof evaluation.animations)[number]>();
		for (const sample of evaluation.animations) {
			const previous = samples.get(sample.animationGroupId);
			if (!previous || sample.weight >= previous.weight) {
				samples.set(sample.animationGroupId, sample);
			}
		}
		const activeGroups = new Set<AnimationGroup>();
		for (const sample of samples.values()) {
			const group = this._scene.getAnimationGroupByName(sample.animationGroupId);
			if (!group) {
				throw new Error(`Cinematic animation group "${sample.animationGroupId}" was not found.`);
			}
			if (!this._animationGroups.has(group)) {
				group.start(true);
				group.pause();
				this._animationGroups.add(group);
			}
			group.goToFrame(sample.sourceFrame);
			group.setWeightForAllAnimatables(sample.weight);
			activeGroups.add(group);
		}
		for (const group of this._animationGroups) {
			if (!activeGroups.has(group)) {
				group.stop();
				this._animationGroups.delete(group);
			}
		}
	}

	/** Starts newly active sounds at the evaluated offset and stops clips that left the frame. */
	private _applySounds(evaluation: ICinematicFrameEvaluation): void {
		if (this._options.ignoreSounds) {
			return;
		}
		const active = new Map<string, (typeof evaluation.audio)[number]>();
		for (const sample of evaluation.audio) {
			const previous = active.get(sample.soundId);
			if (!previous || sample.volume >= previous.volume) {
				active.set(sample.soundId, sample);
			}
		}
		for (const [soundId, state] of this._activeSounds) {
			if (!active.has(soundId)) {
				state.node.stop();
				this._activeSounds.delete(soundId);
			}
		}
		for (const sample of active.values()) {
			const node = getNodeById(sample.soundId, this._scene) as SoundNode | null;
			if (!node?.sound) {
				throw new Error(`Cinematic sound node "${sample.soundId}" was not found or has no loaded sound.`);
			}
			node.volume = sample.volume;
			const previous = this._activeSounds.get(sample.soundId);
			if (previous?.clipId !== sample.clipId) {
				previous?.node.stop();
				node.play({ startOffset: Math.max(0, sample.sourceFrame / this._framesPerSecond), loop: sample.loop });
				this._activeSounds.set(sample.soundId, { node, clipId: sample.clipId });
			}
		}
	}

	/** Drives persistent Video Players from exact Timeline frames and restores their standalone transport after exit. */
	private _applyVideos(evaluation: ICinematicFrameEvaluation): void {
		const active = new Map<string, (typeof evaluation.videos)[number]>();
		for (const sample of evaluation.videos) {
			const previous = active.get(sample.videoPlayerId);
			if (!previous || sample.weight > previous.weight || (sample.weight === previous.weight && sample.clipId.localeCompare(previous.clipId) < 0)) {
				active.set(sample.videoPlayerId, sample);
			}
		}
		for (const playerId of [...this._videoRestorePoints.keys()]) {
			if (!active.has(playerId)) {
				this._restoreVideoPlayer(playerId);
			}
		}
		for (const sample of active.values()) {
			const runtime = this._scene.videoPlayerRuntimes?.get(sample.videoPlayerId);
			if (!runtime) {
				throw new Error(`Cinematic Video Player "${sample.videoPlayerId}" was not found or is not configured.`);
			}
			if (!this._videoRestorePoints.has(sample.videoPlayerId)) {
				this._videoRestorePoints.set(sample.videoPlayerId, {
					runtime,
					currentTime: runtime.texture.video.currentTime,
					manualTime: runtime.manualTime,
					manualPlaying: runtime.manualPlaying,
					status: runtime.status,
					error: runtime.error,
					browserPlaying: !runtime.texture.video.paused,
					loop: runtime.texture.video.loop,
					muted: runtime.texture.video.muted,
					volume: runtime.texture.video.volume,
					playbackRate: runtime.texture.video.playbackRate,
					textureLevel: runtime.texture.level,
				});
				pauseConfiguredVideoPlayer(runtime);
			}
			const video = runtime.texture.video;
			const desiredTime = sample.sourceFrame / this._framesPerSecond;
			video.loop = sample.loop;
			video.muted = runtime.configuration.audioOutputMode === "none" || runtime.configuration.muted || sample.muteAudio;
			video.volume = runtime.configuration.volume * sample.volume;
			video.playbackRate = runtime.configuration.playbackSpeed * sample.playbackSpeed * this.clock.speed;
			runtime.texture.level = runtime.configuration.alpha * sample.weight;
			if (!this.clock.playing || this.clock.direction === -1) {
				pauseConfiguredVideoPlayer(runtime);
				seekConfiguredVideoPlayer(runtime, desiredTime);
				continue;
			}
			if (Math.abs(video.currentTime - desiredTime) > 0.12) {
				seekConfiguredVideoPlayer(runtime, desiredTime);
			}
			runtime.manualPlaying = false;
			runtime.status = "playing";
			if (video.paused) {
				void video.play().catch((error: unknown) => {
					runtime.status = "error";
					runtime.error = error instanceof Error ? error.message : "Timeline video playback failed.";
				});
			}
		}
	}

	/** Releases one Timeline lease and restores exactly the standalone Video Player state it captured. */
	private _restoreVideoPlayer(playerId: string): void {
		const point = this._videoRestorePoints.get(playerId);
		if (!point) {
			return;
		}
		const { runtime } = point;
		const video = runtime.texture.video;
		video.pause();
		video.currentTime = point.currentTime;
		video.loop = point.loop;
		video.muted = point.muted;
		video.volume = point.volume;
		video.playbackRate = point.playbackRate;
		runtime.texture.level = point.textureLevel;
		runtime.texture.updateTexture(true);
		runtime.manualTime = point.manualTime;
		runtime.manualPlaying = point.manualPlaying;
		runtime.status = point.status;
		runtime.error = point.error;
		if (point.browserPlaying && !point.manualPlaying) {
			void video.play().catch((error: unknown) => {
				runtime.status = "error";
				runtime.error = error instanceof Error ? error.message : "Video playback could not resume after Timeline preview.";
			});
		}
		this._videoRestorePoints.delete(playerId);
	}

	/** Applies active enable-state clips and restores nodes after their final clip leaves the frame. */
	private _applyActivations(evaluation: ICinematicFrameEvaluation): void {
		const activeNodes = new Set(evaluation.activations.map((sample) => sample.nodeId));
		for (const [nodeId, state] of this._activationRestorePoints) {
			if (!activeNodes.has(nodeId)) {
				state.node.setEnabled(state.enabled);
				this._activationRestorePoints.delete(nodeId);
			}
		}
		for (const sample of evaluation.activations) {
			const node = getNodeById(sample.nodeId, this._scene);
			if (!node) {
				throw new Error(`Cinematic activation node "${sample.nodeId}" was not found.`);
			}
			if (!this._activationRestorePoints.has(sample.nodeId)) {
				this._activationRestorePoints.set(sample.nodeId, { node, enabled: node.isEnabled() });
			}
			node.setEnabled(sample.active);
		}
	}

	/** Selects camera cuts directly and uses a temporary camera for weighted cross-fades. */
	private _applyCameras(evaluation: ICinematicFrameEvaluation): void {
		if (!evaluation.cameras.length) {
			this._scene.activeCamera = this._initialActiveCamera;
			return;
		}
		const samples = [...evaluation.cameras].sort((left, right) => right.weight - left.weight || left.trackId.localeCompare(right.trackId));
		const primary = this._scene.getCameraById(samples[0].cameraId);
		if (!primary) {
			throw new Error(`Cinematic camera "${samples[0].cameraId}" was not found.`);
		}
		const secondary = samples[1] ? this._scene.getCameraById(samples[1].cameraId) : null;
		if (!secondary || (samples[0].blendMode === "cut" && samples[1].blendMode === "cut")) {
			this._scene.activeCamera = primary;
			return;
		}
		this._blendCamera ??= new UniversalCamera("__zvibeCinematicBlendCamera", Vector3.Zero(), this._scene);
		const totalWeight = samples[0].weight + samples[1].weight;
		const amount = totalWeight > 0 ? samples[1].weight / totalWeight : 0.5;
		primary.computeWorldMatrix();
		secondary.computeWorldMatrix();
		this._blendCamera.position.copyFrom(Vector3.Lerp(primary.globalPosition, secondary.globalPosition, amount));
		this._blendCamera.rotationQuaternion = Quaternion.Slerp(cameraRotation(primary), cameraRotation(secondary), amount);
		this._blendCamera.fov = primary.fov + (secondary.fov - primary.fov) * amount;
		this._blendCamera.minZ = primary.minZ + (secondary.minZ - primary.minZ) * amount;
		this._blendCamera.maxZ = primary.maxZ + (secondary.maxZ - primary.maxZ) * amount;
		this._blendCamera.computeWorldMatrix();
		this._scene.activeCamera = this._blendCamera;
	}

	/** Dispatches particle commands natively and delegates nested-cinematic lifecycle to the host. */
	private _applyControls(evaluation: ICinematicFrameEvaluation): void {
		const active = new Map(evaluation.controls.map((sample) => [sample.clipId, sample]));
		for (const [clipId, previous] of this._activeControlClips) {
			if (!active.has(clipId)) {
				this._options.onControl?.(previous, false);
				this._activeControlClips.delete(clipId);
			}
		}
		for (const sample of active.values()) {
			if (this._activeControlClips.has(sample.clipId)) {
				continue;
			}
			if (sample.targetType === "particleSystem") {
				const system = this._scene.particleSystems.find((candidate) => candidate.id === sample.targetId);
				if (!system) {
					throw new Error(`Cinematic particle system "${sample.targetId}" was not found.`);
				}
				sample.action === "play" ? system.start() : system.stop();
			}
			this._options.onControl?.(sample, true);
			this._activeControlClips.set(sample.clipId, sample);
		}
	}

	/** Reports recorder clip entry/exit exactly once so editor and game hosts choose their capture backend. */
	private _applyRecorders(evaluation: ICinematicFrameEvaluation): void {
		const active = new Map(evaluation.recorders.map((sample) => [sample.clipId, sample]));
		for (const [clipId, previous] of this._activeRecorderClips) {
			if (!active.has(clipId)) {
				this._options.onRecorder?.(previous, false);
				this._activeRecorderClips.delete(clipId);
			}
		}
		for (const sample of active.values()) {
			if (!this._activeRecorderClips.has(sample.clipId)) {
				this._options.onRecorder?.(sample, true);
				this._activeRecorderClips.set(sample.clipId, sample);
			}
		}
	}

	/** Routes authored signal and event markers to separate host callbacks in traversal order. */
	private _dispatchMarkers(markers: readonly ICinematicMarkerOccurrence[]): void {
		for (const occurrence of markers) {
			if (occurrence.marker.type === "signal") {
				this._options.onSignal?.(occurrence);
			} else {
				this._options.onEvent?.(occurrence);
			}
		}
	}

	/** Stops all sounds started by this player without touching unrelated scene audio. */
	private _stopSounds(): void {
		for (const state of this._activeSounds.values()) {
			state.node.stop();
		}
		this._activeSounds.clear();
	}

	/** Restores only scene state captured by this player and clears active clip lifecycle state. */
	private _restoreSceneState(): void {
		for (const point of this._propertyRestorePoints.values()) {
			point.target[point.property] = point.value;
		}
		this._propertyRestorePoints.clear();
		for (const state of this._activationRestorePoints.values()) {
			state.node.setEnabled(state.enabled);
		}
		this._activationRestorePoints.clear();
		for (const group of this._animationGroups) {
			group.stop();
		}
		this._animationGroups.clear();
		this._stopSounds();
		for (const playerId of [...this._videoRestorePoints.keys()]) {
			this._restoreVideoPlayer(playerId);
		}
		for (const sample of this._activeControlClips.values()) {
			this._options.onControl?.(sample, false);
		}
		this._activeControlClips.clear();
		for (const sample of this._activeRecorderClips.values()) {
			this._options.onRecorder?.(sample, false);
		}
		this._activeRecorderClips.clear();
		this._scene.activeCamera = this._initialActiveCamera;
	}
}
