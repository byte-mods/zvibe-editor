import { Scene, Tools, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";

interface ICameraImpulseSource {
	id: string;
	name: string;
	amplitude: number;
	duration: number;
	frequency: number;
	direction: number[];
	cameraId?: string;
}

interface IActiveCameraImpulse {
	source: ICameraImpulseSource;
	elapsed: number;
	lastOffset: Vector3;
}

const activeImpulses = new WeakMap<Scene, IActiveCameraImpulse[]>();
const configuredScenes = new WeakSet<Scene>();

function sources(scene: Scene): ICameraImpulseSource[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorCameraImpulseSources ??= [];
	return scene.metadata.babylonEditorCameraImpulseSources;
}

function find(scene: Scene, data: any): ICameraImpulseSource {
	const result = sources(scene).find((value) => value.id === data.impulseId || value.name === data.impulseName);
	if (!result) throw new Error("Camera impulse source not found.");
	return result;
}

function validate(data: any): void {
	if (!Number.isFinite(data.amplitude) || data.amplitude < 0) throw new Error("Impulse amplitude must be zero or greater.");
	if (!Number.isFinite(data.duration) || data.duration <= 0) throw new Error("Impulse duration must be greater than zero.");
	if (!Number.isFinite(data.frequency) || data.frequency <= 0) throw new Error("Impulse frequency must be greater than zero.");
	if (!Array.isArray(data.direction) || data.direction.length !== 3 || !data.direction.every(Number.isFinite) || !Vector3.FromArray(data.direction).lengthSquared()) {
		throw new Error("Impulse direction must be a non-zero finite [x, y, z] vector.");
	}
}

function configure(scene: Scene): void {
	if (configuredScenes.has(scene)) return;
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => {
		const active = activeImpulses.get(scene) ?? [];
		const elapsedSeconds = scene.getEngine().getDeltaTime() / 1000;
		for (let index = active.length - 1; index >= 0; index--) {
			const impulse = active[index];
			const camera = impulse.source.cameraId ? scene.getCameraById(impulse.source.cameraId) : scene.activeCamera;
			if (!camera) continue;
			camera.position.subtractInPlace(impulse.lastOffset);
			impulse.elapsed += elapsedSeconds;
			if (impulse.elapsed >= impulse.source.duration) {
				active.splice(index, 1);
				continue;
			}
			const envelope = 1 - impulse.elapsed / impulse.source.duration;
			const magnitude = impulse.source.amplitude * envelope * Math.sin(2 * Math.PI * impulse.source.frequency * impulse.elapsed);
			impulse.lastOffset = Vector3.FromArray(impulse.source.direction).normalize().scale(magnitude);
			camera.position.addInPlace(impulse.lastOffset);
		}
	});
}

/** Lists persisted camera-impulse source definitions. */
export function listCameraImpulseSources(scene: Scene): any {
	return { impulseSources: structuredClone(sources(scene)) };
}

/** Creates or updates a persisted, decaying camera-impulse source. */
export function setCameraImpulseSource(scene: Scene, data: any, options: IMCPActionOptions): any {
	validate(data);
	if (data.cameraId !== undefined && !scene.getCameraById(data.cameraId)) throw new Error(`Camera \"${data.cameraId}\" was not found.`);
	const existing = data.impulseId || data.impulseName ? find(scene, data) : undefined;
	if (!existing && sources(scene).some((value) => value.name === data.name)) throw new Error(`Camera impulse source \"${data.name}\" already exists.`);
	const value = existing ?? {
		id: Tools.RandomId(),
		name: data.name,
		amplitude: data.amplitude,
		duration: data.duration,
		frequency: data.frequency,
		direction: data.direction,
		cameraId: data.cameraId,
	};
	value.name = data.name ?? value.name;
	value.amplitude = data.amplitude;
	value.duration = data.duration;
	value.frequency = data.frequency;
	value.direction = [...data.direction];
	value.cameraId = data.cameraId;
	if (!existing) sources(scene).push(value);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Triggers a source against its configured camera or the current active camera in the editor preview. */
export function fireCameraImpulse(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = find(scene, data);
	configure(scene);
	const active = activeImpulses.get(scene) ?? [];
	activeImpulses.set(scene, active);
	active.push({ source: structuredClone(source), elapsed: 0, lastOffset: Vector3.Zero() });
	options.editor.layout.inspector.setEditedObject(source.cameraId ? scene.getCameraById(source.cameraId) : scene.activeCamera!);
	options.editor.layout.inspector.forceUpdate();
	return { fired: true, impulseId: source.id, cameraId: source.cameraId ?? scene.activeCamera?.id };
}

/** Deletes a persisted impulse source and stops its active preview instances. */
export function deleteCameraImpulseSource(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = find(scene, data);
	sources(scene).splice(sources(scene).indexOf(source), 1);
	const active = activeImpulses.get(scene);
	if (active)
		activeImpulses.set(
			scene,
			active.filter((value) => value.source.id !== source.id)
		);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: source.id };
}
