import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import { evaluateCameraNoiseProfile, ICameraNoiseProfile } from "./camera-noise";
import { IVirtualCamera } from "./virtual-cameras";

export interface ICameraImpulseCollisionTrigger {
	type: "collision";
	nodeId: string;
	minimumImpact: number;
	includeContinued: boolean;
	cooldownSeconds: number;
	useImpactDirection: boolean;
}

export interface ICameraImpulseSource {
	id: string;
	name: string;
	amplitude: number;
	duration: number;
	frequency: number;
	direction: number[];
	cameraId?: string;
	channelMask?: number;
	noiseProfileId?: string;
	rotationGain?: number;
	dissipationDistance?: number;
	sourceNodeId?: string;
	trigger?: ICameraImpulseCollisionTrigger;
}

export interface ICameraImpulseTriggerContext {
	origin?: Vector3;
	direction?: Vector3;
	impact?: number;
	reason?: "manual" | "collision";
}

interface IActiveCameraImpulse {
	source: ICameraImpulseSource;
	elapsed: number;
	origin: Vector3 | null;
	direction: Vector3;
	impactScale: number;
	lastPositionOffset: Vector3;
	lastRotationOffset: Vector3;
	appliedCameraId: string | null;
}

interface ICameraImpulseRuntime {
	active: IActiveCameraImpulse[];
	configured: boolean;
	collisionObservable: any;
	collisionObserver: any;
	enabledBodies: Set<any>;
	lastCollisionAt: Map<string, number>;
}

const runtimes = new WeakMap<Scene, ICameraImpulseRuntime>();

function runtime(scene: Scene): ICameraImpulseRuntime {
	let value = runtimes.get(scene);
	if (!value) {
		value = { active: [], configured: false, collisionObservable: null, collisionObserver: null, enabledBodies: new Set(), lastCollisionAt: new Map() };
		runtimes.set(scene, value);
	}
	return value;
}

function sources(scene: Scene): ICameraImpulseSource[] {
	return (scene.metadata?.babylonEditorCameraImpulseSources as ICameraImpulseSource[] | undefined) ?? [];
}

function profiles(scene: Scene): ICameraNoiseProfile[] {
	return (scene.metadata?.babylonEditorCameraNoiseProfiles as ICameraNoiseProfile[] | undefined) ?? [];
}

function idSeed(id: string): number {
	let value = 2166136261;
	for (let index = 0; index < id.length; index++) {
		value = Math.imul(value ^ id.charCodeAt(index), 16777619);
	}
	return value | 0;
}

function sourceOrigin(scene: Scene, source: ICameraImpulseSource): Vector3 | null {
	if (!source.sourceNodeId) {
		return null;
	}
	const node = scene.getNodeById(source.sourceNodeId) as any;
	if (!node?.getAbsolutePosition) {
		return null;
	}
	node.computeWorldMatrix?.(true);
	return node.getAbsolutePosition().clone();
}

function triggerSource(scene: Scene, source: ICameraImpulseSource, context: ICameraImpulseTriggerContext): boolean {
	const direction = context.direction?.clone() ?? Vector3.FromArray(source.direction);
	if (!direction.lengthSquared()) {
		return false;
	}
	runtime(scene).active.push({
		source: structuredClone(source),
		elapsed: 0,
		origin: context.origin?.clone() ?? sourceOrigin(scene, source),
		direction: direction.normalize(),
		impactScale: Math.max(0, context.impact ?? 1),
		lastPositionOffset: Vector3.Zero(),
		lastRotationOffset: Vector3.Zero(),
		appliedCameraId: null,
	});
	return true;
}

/** Triggers a persisted source in an exported game or editor preview. Event scripts can supply world-space origin/direction/impact context. */
export function triggerCameraImpulse(scene: Scene, impulseIdOrName: string, context: ICameraImpulseTriggerContext = {}): boolean {
	const source = sources(scene).find((value) => value.id === impulseIdOrName || value.name === impulseIdOrName);
	return source ? triggerSource(scene, source, { ...context, reason: context.reason ?? "manual" }) : false;
}

function resolveCamera(scene: Scene, source: ICameraImpulseSource): any | null {
	const camera = source.cameraId ? scene.getCameraById(source.cameraId) : scene.activeCamera;
	if (!camera) {
		return null;
	}
	const activeId = scene.metadata?.babylonEditorActiveVirtualCameraId;
	const virtualCameras = (scene.metadata?.babylonEditorVirtualCameras as IVirtualCamera[] | undefined) ?? [];
	const virtualCamera = virtualCameras.find((value) => value.id === activeId && value.cameraId === camera.id);
	const listenerMask = virtualCamera?.impulseChannelMask ?? 0x7fffffff;
	return ((source.channelMask ?? 1) & listenerMask) !== 0 ? camera : null;
}

function removePreviousOffset(camera: any, impulse: IActiveCameraImpulse): void {
	camera.position.subtractInPlace(impulse.lastPositionOffset);
	if (camera.rotationQuaternion) {
		camera.rotationQuaternion.multiplyInPlace(Quaternion.FromEulerAngles(impulse.lastRotationOffset.x, impulse.lastRotationOffset.y, impulse.lastRotationOffset.z).conjugate());
	} else if (camera.rotation) {
		camera.rotation.subtractInPlace(impulse.lastRotationOffset);
	}
	impulse.lastPositionOffset.setAll(0);
	impulse.lastRotationOffset.setAll(0);
}

function attenuation(camera: any, impulse: IActiveCameraImpulse): number {
	const distance = impulse.source.dissipationDistance ?? 0;
	if (!impulse.origin || distance <= 0) {
		return 1;
	}
	return Math.max(0, 1 - Vector3.Distance(camera.position, impulse.origin) / distance);
}

function applyImpulse(scene: Scene, camera: any, impulse: IActiveCameraImpulse): void {
	const envelope = Math.max(0, 1 - impulse.elapsed / impulse.source.duration);
	const gain = impulse.source.amplitude * impulse.impactScale * envelope * attenuation(camera, impulse);
	if (impulse.source.noiseProfileId) {
		const profile = profiles(scene).find((value) => value.id === impulse.source.noiseProfileId);
		if (profile) {
			const sample = evaluateCameraNoiseProfile(profile, impulse.elapsed, idSeed(impulse.source.id), gain, impulse.source.frequency, Vector3.Zero());
			impulse.lastPositionOffset.copyFrom(sample.position);
			impulse.lastRotationOffset.copyFrom(sample.rotationRadians.scale(impulse.source.rotationGain ?? 1));
		}
	} else {
		const magnitude = gain * Math.sin(2 * Math.PI * impulse.source.frequency * impulse.elapsed);
		impulse.lastPositionOffset.copyFrom(impulse.direction.scale(magnitude));
	}
	camera.position.addInPlace(impulse.lastPositionOffset);
	if (camera.rotationQuaternion) {
		camera.rotationQuaternion.multiplyInPlace(Quaternion.FromEulerAngles(impulse.lastRotationOffset.x, impulse.lastRotationOffset.y, impulse.lastRotationOffset.z));
	} else if (camera.rotation) {
		camera.rotation.addInPlace(impulse.lastRotationOffset);
	}
}

function collisionNodeIds(event: any): [string | null, string | null] {
	return [event.collider?.transformNode?.id ?? null, event.collidedAgainst?.transformNode?.id ?? null];
}

function configureCollisionSources(scene: Scene, value: ICameraImpulseRuntime): void {
	const collisionSources = sources(scene).filter((source) => source.trigger?.type === "collision");
	for (const source of collisionSources) {
		const node = scene.getNodeById(source.trigger!.nodeId) as any;
		const body = node?.physicsAggregate?.body;
		if (body?.setCollisionCallbackEnabled && !value.enabledBodies.has(body)) {
			body.setCollisionCallbackEnabled(true);
			value.enabledBodies.add(body);
		}
	}
	if (!collisionSources.length || value.collisionObserver) {
		return;
	}
	const observable = (scene.getPhysicsEngine() as any)?.getPhysicsPlugin?.()?.onCollisionObservable;
	if (!observable?.add) {
		return;
	}
	value.collisionObservable = observable;
	value.collisionObserver = observable.add((event: any) => {
		const [colliderId, collidedAgainstId] = collisionNodeIds(event);
		const eventType = String(event.type ?? "");
		for (const source of sources(scene)) {
			const trigger = source.trigger;
			if (trigger?.type !== "collision" || (trigger.nodeId !== colliderId && trigger.nodeId !== collidedAgainstId)) {
				continue;
			}
			if (!trigger.includeContinued && eventType.includes("CONTINUED")) {
				continue;
			}
			const impact = Math.abs(Number.isFinite(event.impulse) ? event.impulse : 1);
			if (impact < trigger.minimumImpact) {
				continue;
			}
			const now = performance.now() / 1000;
			if (now - (value.lastCollisionAt.get(source.id) ?? -Infinity) < trigger.cooldownSeconds) {
				continue;
			}
			value.lastCollisionAt.set(source.id, now);
			let direction: Vector3 | undefined;
			if (trigger.useImpactDirection && event.normal) {
				const impactDirection: Vector3 = event.normal.clone?.() ?? Vector3.FromArray(event.normal.asArray?.() ?? event.normal);
				if (trigger.nodeId === collidedAgainstId) {
					impactDirection.scaleInPlace(-1);
				}
				direction = impactDirection;
			}
			const origin = event.point ? (event.point.clone?.() ?? Vector3.FromArray(event.point.asArray?.() ?? event.point)) : (sourceOrigin(scene, source) ?? undefined);
			triggerSource(scene, source, { origin, direction, impact, reason: "collision" });
		}
	});
}

/** Enables shared manual/event/collision impulse evaluation for persisted sources. Safe to call repeatedly after source changes. */
export function configureCameraImpulses(scene: Scene): void {
	const value = runtime(scene);
	configureCollisionSources(scene, value);
	if (value.configured) {
		return;
	}
	value.configured = true;
	scene.onBeforeRenderObservable.add(() => {
		configureCollisionSources(scene, value);
		const elapsedSeconds = Math.max(0, scene.getEngine().getDeltaTime() / 1000);
		for (let index = value.active.length - 1; index >= 0; index--) {
			const impulse = value.active[index];
			const previousCamera = impulse.appliedCameraId ? scene.getCameraById(impulse.appliedCameraId) : null;
			if (previousCamera) {
				removePreviousOffset(previousCamera, impulse);
			}
			const camera = resolveCamera(scene, impulse.source);
			impulse.elapsed += elapsedSeconds;
			if (impulse.elapsed >= impulse.source.duration) {
				value.active.splice(index, 1);
				continue;
			}
			if (camera) {
				applyImpulse(scene, camera, impulse);
				impulse.appliedCameraId = camera.id;
			} else {
				impulse.appliedCameraId = null;
			}
		}
	});
}

export function getActiveCameraImpulseCount(scene: Scene): number {
	return runtime(scene).active.length;
}
