import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

export type ICameraImpulseSource = {
	id: string;
	name: string;
	amplitude: number;
	duration: number;
	frequency: number;
	direction: number[];
	cameraId?: string;
};

type IActiveCameraImpulse = { source: ICameraImpulseSource; elapsed: number; lastOffset: Vector3 };
const activeImpulses = new WeakMap<Scene, IActiveCameraImpulse[]>();
const configuredScenes = new WeakSet<Scene>();

function sources(scene: Scene): ICameraImpulseSource[] {
	return (scene.metadata?.babylonEditorCameraImpulseSources as ICameraImpulseSource[] | undefined) ?? [];
}

/** Triggers a persisted camera-impulse source in an exported game. */
export function triggerCameraImpulse(scene: Scene, impulseIdOrName: string): boolean {
	const source = sources(scene).find((value) => value.id === impulseIdOrName || value.name === impulseIdOrName);
	if (!source) return false;
	const active = activeImpulses.get(scene) ?? [];
	activeImpulses.set(scene, active);
	active.push({ source: structuredClone(source), elapsed: 0, lastOffset: Vector3.Zero() });
	return true;
}

/** Enables runtime evaluation for persisted camera-impulse sources. Use triggerCameraImpulse from gameplay scripts to fire a source. */
export function configureCameraImpulses(scene: Scene): void {
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
