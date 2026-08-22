import { Scene, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";

type IParticleProximityEvent = { targetParticleSystemId: string; radius: number; count: number; cooldownMs?: number; enabled?: boolean };
const configuredScenes = new WeakSet<Scene>();
const lastTriggers = new WeakMap<Scene, Map<string, number>>();

function configurations(scene: Scene): Record<string, IParticleProximityEvent[]> {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorParticleProximityEvents ??= {});
}
function resolve(scene: Scene, data: any): any {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName) as any;
	if (!system) {
		throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	}
	if (system.getClassName?.() === "GPUParticleSystem") {
		throw new Error("Particle proximity events currently support CPU particle systems only.");
	}
	return system;
}
function configure(scene: Scene): void {
	if (configuredScenes.has(scene)) {
		return;
	}
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => {
		const now = Date.now();
		const triggers = lastTriggers.get(scene) ?? new Map<string, number>();
		lastTriggers.set(scene, triggers);
		for (const source of scene.particleSystems as any[]) {
			if (source.getClassName?.() === "GPUParticleSystem") {
				continue;
			}
			for (const [index, event] of (configurations(scene)[source.id] ?? []).entries()) {
				if (event.enabled === false) {
					continue;
				}
				const target = scene.particleSystems.find((candidate) => candidate.id === event.targetParticleSystemId) as any;
				if (!target) {
					continue;
				}
				const key = `${source.id}:${index}`;
				if (now - (triggers.get(key) ?? -Infinity) < (event.cooldownMs ?? 100)) {
					continue;
				}
				const hit = (source.particles ?? []).some((left: any) =>
					(target.particles ?? []).some((right: any) => Vector3.DistanceSquared(left.position, right.position) <= event.radius * event.radius)
				);
				if (!hit) {
					continue;
				}
				if (!target.isStarted()) {
					target.start();
				}
				target.manualEmitCount = Math.max(0, target.manualEmitCount ?? 0) + event.count;
				triggers.set(key, now);
			}
		}
	});
}
export function getParticleProximityEvents(scene: Scene, data: any): any {
	const system = resolve(scene, data);
	return { particleSystemId: system.id, events: structuredClone(configurations(scene)[system.id] ?? []) };
}
export function setParticleProximityEvents(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolve(scene, data);
	const events = data.events ?? [];
	if (!Array.isArray(events) || events.length > 8) {
		throw new Error("Particle proximity events must contain from zero to eight entries.");
	}
	for (const [index, event] of events.entries()) {
		if (!scene.particleSystems.some((candidate) => candidate.id === event.targetParticleSystemId)) {
			throw new Error(`Proximity event ${index} target particle system was not found.`);
		}
		if (!(event.radius > 0) || !Number.isFinite(event.radius) || !Number.isInteger(event.count) || event.count < 1) {
			throw new Error(`Proximity event ${index} requires positive finite radius and positive integer count.`);
		}
		if (event.cooldownMs !== undefined && (!Number.isFinite(event.cooldownMs) || event.cooldownMs < 0 || event.cooldownMs > 60000)) {
			throw new Error(`Proximity event ${index} cooldownMs must be from 0 through 60000.`);
		}
	}
	configurations(scene)[system.id] = structuredClone(events);
	configure(scene);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleProximityEvents(scene, { particleSystemId: system.id });
}
