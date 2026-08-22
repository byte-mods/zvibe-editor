import { Scene, Tools, Vector3 } from "babylonjs";
import { configureCameraImpulses, ICameraImpulseSource, triggerCameraImpulse } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

function sources(scene: Scene): ICameraImpulseSource[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorCameraImpulseSources ??= [];
	return scene.metadata.babylonEditorCameraImpulseSources;
}

function find(scene: Scene, data: any): ICameraImpulseSource {
	const result = sources(scene).find((value) => value.id === data.impulseId || value.name === data.impulseName);
	if (!result) {
		throw new Error("Camera impulse source not found.");
	}
	return result;
}

function validate(scene: Scene, data: any): void {
	if (!Number.isFinite(data.amplitude) || data.amplitude < 0) {
		throw new Error("Impulse amplitude must be zero or greater.");
	}
	if (!Number.isFinite(data.duration) || data.duration <= 0) {
		throw new Error("Impulse duration must be greater than zero.");
	}
	if (!Number.isFinite(data.frequency) || data.frequency <= 0) {
		throw new Error("Impulse frequency must be greater than zero.");
	}
	if (!Array.isArray(data.direction) || data.direction.length !== 3 || !data.direction.every(Number.isFinite) || !Vector3.FromArray(data.direction).lengthSquared()) {
		throw new Error("Impulse direction must be a non-zero finite [x, y, z] vector.");
	}
	if (data.channelMask !== undefined && (!Number.isInteger(data.channelMask) || data.channelMask < 1 || data.channelMask > 0x7fffffff)) {
		throw new Error("Impulse channelMask must be an integer from 1 through 2147483647.");
	}
	if (data.rotationGain !== undefined && (!Number.isFinite(data.rotationGain) || data.rotationGain < 0 || data.rotationGain > 1000)) {
		throw new Error("Impulse rotationGain must be within 0..1000.");
	}
	if (data.dissipationDistance !== undefined && (!Number.isFinite(data.dissipationDistance) || data.dissipationDistance < 0 || data.dissipationDistance > 1000000000)) {
		throw new Error("Impulse dissipationDistance must be within 0..1000000000 centimeters.");
	}
	if (data.cameraId !== undefined && !scene.getCameraById(data.cameraId)) {
		throw new Error(`Camera "${data.cameraId}" was not found.`);
	}
	if (data.noiseProfileId !== undefined && !(scene.metadata?.babylonEditorCameraNoiseProfiles ?? []).some((profile: any) => profile.id === data.noiseProfileId)) {
		throw new Error(`Camera noise profile "${data.noiseProfileId}" was not found.`);
	}
	if (data.sourceNodeId !== undefined && !scene.getNodeById(data.sourceNodeId)) {
		throw new Error(`Impulse source node "${data.sourceNodeId}" was not found.`);
	}
	if (data.trigger) {
		if (data.trigger.type !== "collision") {
			throw new Error("Only collision triggers are persisted; omit trigger for manual or script-event sources.");
		}
		if (!scene.getNodeById(data.trigger.nodeId)) {
			throw new Error(`Collision trigger node "${data.trigger.nodeId}" was not found.`);
		}
	}
}

/** Lists persisted manual, script-event, and collision-driven camera-impulse source definitions. */
export function listCameraImpulseSources(scene: Scene): any {
	return { impulseSources: structuredClone(sources(scene)) };
}

/** Creates or updates one persisted impulse source using the shared editor/export runtime. */
export function setCameraImpulseSource(scene: Scene, data: any, options: IMCPActionOptions): any {
	validate(scene, data);
	const existing = data.impulseId || data.impulseName ? find(scene, data) : undefined;
	if (!existing && sources(scene).some((value) => value.name === data.name)) {
		throw new Error(`Camera impulse source "${data.name}" already exists.`);
	}
	const value: ICameraImpulseSource = existing ?? {
		id: Tools.RandomId(),
		name: data.name,
		amplitude: data.amplitude,
		duration: data.duration,
		frequency: data.frequency,
		direction: data.direction,
	};
	value.name = data.name ?? value.name;
	value.amplitude = data.amplitude;
	value.duration = data.duration;
	value.frequency = data.frequency;
	value.direction = [...data.direction];
	value.cameraId = data.cameraId;
	value.channelMask = data.channelMask ?? value.channelMask ?? 1;
	value.noiseProfileId = data.noiseProfileId;
	value.rotationGain = data.rotationGain ?? value.rotationGain ?? 1;
	value.dissipationDistance = data.dissipationDistance ?? value.dissipationDistance ?? 0;
	value.sourceNodeId = data.sourceNodeId;
	value.trigger = data.trigger
		? {
				type: "collision",
				nodeId: data.trigger.nodeId,
				minimumImpact: data.trigger.minimumImpact ?? 0,
				includeContinued: data.trigger.includeContinued ?? false,
				cooldownSeconds: data.trigger.cooldownSeconds ?? 0,
				useImpactDirection: data.trigger.useImpactDirection ?? true,
			}
		: undefined;
	if (!existing) {
		sources(scene).push(value);
	}
	configureCameraImpulses(scene as any);
	options.editor.layout.inspector?.setEditedObject(scene);
	options.editor.layout.inspector?.forceUpdate();
	return structuredClone(value);
}

/** Triggers an impulse with optional event-space origin, direction, and impact scaling. */
export function fireCameraImpulse(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = find(scene, data);
	configureCameraImpulses(scene as any);
	const origin = data.origin ? Vector3.FromArray(data.origin) : undefined;
	const direction = data.direction ? Vector3.FromArray(data.direction) : undefined;
	if (!triggerCameraImpulse(scene as any, source.id, { origin, direction, impact: data.impact, reason: "manual" } as any)) {
		throw new Error("Camera impulse could not be fired.");
	}
	options.editor.layout.inspector?.setEditedObject(source.cameraId ? scene.getCameraById(source.cameraId) : scene.activeCamera!);
	options.editor.layout.inspector?.forceUpdate();
	return { fired: true, impulseId: source.id, cameraId: source.cameraId ?? scene.activeCamera?.id, origin: origin?.asArray() ?? null, impact: data.impact ?? 1 };
}

/** Deletes a persisted impulse source. Active copied instances finish independently. */
export function deleteCameraImpulseSource(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = find(scene, data);
	sources(scene).splice(sources(scene).indexOf(source), 1);
	options.editor.layout.inspector?.setEditedObject(scene);
	options.editor.layout.inspector?.forceUpdate();
	return { deleted: true, id: source.id };
}
