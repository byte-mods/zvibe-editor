import { IParticleSystem, Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

export type IParticleEvent = { name: string; count: number; enabled?: boolean };

function configurations(scene: Scene): Record<string, IParticleEvent[]> {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorParticleEvents ??= {});
}

function resolveParticleSystem(scene: Scene, data: any): IParticleSystem {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName);
	if (!system) {
		throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	}
	return system;
}

function validate(events: IParticleEvent[]): void {
	if (!Array.isArray(events) || events.length > 32) {
		throw new Error("Particle events must contain from zero to thirty-two events.");
	}
	const names = new Set<string>();
	for (const event of events) {
		if (!event.name?.trim()) {
			throw new Error("Every particle event requires a non-empty name.");
		}
		if (names.has(event.name)) {
			throw new Error(`Particle event name "${event.name}" is duplicated.`);
		}
		if (!Number.isInteger(event.count) || event.count < 1) {
			throw new Error(`Particle event "${event.name}" count must be a positive integer.`);
		}
		names.add(event.name);
	}
}

/** Lists persistent named burst events for a native CPU or GPU particle system. */
export function getParticleEvents(scene: Scene, data: any): any {
	const system = resolveParticleSystem(scene, data);
	return { particleSystemId: system.id, particleSystemName: system.name, events: structuredClone(configurations(scene)[system.id] ?? []) };
}

/** Replaces named gameplay burst events for a native CPU or GPU particle system. */
export function setParticleEvents(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolveParticleSystem(scene, data);
	const events = data.events ?? [];
	validate(events);
	configurations(scene)[system.id] = structuredClone(events);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleEvents(scene, { particleSystemId: system.id });
}

/** Fires a named configured VFX event, adding its burst count to every matching CPU/GPU system. */
export function triggerParticleEvent(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.eventName?.trim()) {
		throw new Error("eventName must be a non-empty particle event name.");
	}
	const systems = data.particleSystemId || data.particleSystemName ? [resolveParticleSystem(scene, data)] : scene.particleSystems;
	const triggered: any[] = [];
	for (const system of systems as IParticleSystem[]) {
		const event = (configurations(scene)[system.id] ?? []).find((candidate) => candidate.name === data.eventName);
		if (!event || event.enabled === false) {
			continue;
		}
		const native = system as any;
		if (!system.isStarted()) {
			system.start();
		}
		native.manualEmitCount = Math.max(0, native.manualEmitCount ?? 0) + event.count;
		triggered.push({ particleSystemId: system.id, particleSystemName: system.name, count: event.count });
	}
	if (!triggered.length) {
		throw new Error(`No enabled particle event named "${data.eventName}" was found. Configure it with set_particle_events first.`);
	}
	options.editor.layout.inspector.forceUpdate();
	return { eventName: data.eventName, triggered, totalCount: triggered.reduce((total, event) => total + event.count, 0) };
}
