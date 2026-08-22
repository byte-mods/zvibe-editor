import { Scene } from "babylonjs";
import {
	configureGpuParticleCollisionEvents,
	configureGpuParticleCollisions,
	getGpuParticleCollisionEventRuntimeEvidence,
	IGpuParticleCollisionEventConfiguration,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

const defaults: IGpuParticleCollisionEventConfiguration = {
	enabled: false,
	maximumSourceParticles: 128,
	spawnCount: 2,
	lifetime: 1,
	speed: 30,
	size: 5,
	inheritVelocity: 0.5,
	spread: 0.5,
	color: [1, 0.5, 0.1, 1],
};

function configurations(scene: Scene): Record<string, IGpuParticleCollisionEventConfiguration> {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorGpuParticleCollisionEvents ??= {});
}

function resolve(scene: Scene, data: any): any {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName) as any;
	if (!system) {
		throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	}
	if (system.getClassName?.() !== "GPUParticleSystem") {
		throw new Error("Native GPU collision events require a GPU particle system.");
	}
	return system;
}

function currentConfiguration(scene: Scene, system: any): IGpuParticleCollisionEventConfiguration {
	return { ...structuredClone(defaults), ...structuredClone(configurations(scene)[system.id] ?? {}) };
}

function collisionVolumes(scene: Scene, system: any): { planes: any[]; spheres: any[] } {
	return {
		planes: structuredClone(scene.metadata?.babylonEditorParticleCollisionPlanes?.[system.id] ?? []),
		spheres: structuredClone(scene.metadata?.babylonEditorParticleCollisionSpheres?.[system.id] ?? []),
	};
}

function validate(configuration: IGpuParticleCollisionEventConfiguration): void {
	const allowed = new Set(Object.keys(defaults));
	for (const key of Object.keys(configuration)) {
		if (!allowed.has(key)) {
			throw new Error(`Unknown GPU collision-event setting "${key}".`);
		}
	}
	if (typeof configuration.enabled !== "boolean") {
		throw new Error("enabled must be a boolean.");
	}
	if (!Number.isInteger(configuration.maximumSourceParticles) || configuration.maximumSourceParticles < 1 || configuration.maximumSourceParticles > 2048) {
		throw new Error("maximumSourceParticles must be an integer from 1 to 2048.");
	}
	if (!Number.isInteger(configuration.spawnCount) || configuration.spawnCount < 1 || configuration.spawnCount > 4) {
		throw new Error("spawnCount must be an integer from 1 to 4.");
	}
	for (const [name, value, minimum, maximum] of [
		["lifetime", configuration.lifetime, 0.001, 3600],
		["speed", configuration.speed, 0, 100000],
		["size", configuration.size, 0.0001, 100000],
		["inheritVelocity", configuration.inheritVelocity, 0, 1],
		["spread", configuration.spread, 0, 1],
	] as Array<[string, number, number, number]>) {
		if (!Number.isFinite(value) || value < minimum || value > maximum) {
			throw new Error(`${name} must be from ${minimum} to ${maximum}.`);
		}
	}
	if (!Array.isArray(configuration.color) || configuration.color.length !== 4 || configuration.color.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
		throw new Error("color must contain four values from 0 to 1.");
	}
}

/** Reads persisted collision-triggered native GPU secondary-particle output and runtime evidence. */
export function getGpuParticleCollisionEvents(scene: Scene, data: any): any {
	const system = resolve(scene, data);
	return {
		particleSystemId: system.id,
		particleSystemName: system.name,
		configuration: currentConfiguration(scene, system),
		runtime: getGpuParticleCollisionEventRuntimeEvidence(system),
	};
}

/** Atomically configures collision-triggered secondary particles inside one native GPU system. */
export function setGpuParticleCollisionEvents(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolve(scene, data);
	const current = currentConfiguration(scene, system);
	const update = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "endpoint" && key !== "particleSystemId" && key !== "particleSystemName"));
	const next = { ...current, ...structuredClone(update) } as IGpuParticleCollisionEventConfiguration;
	validate(next);
	const required = next.maximumSourceParticles * (1 + next.spawnCount);
	if (required > 4096) {
		throw new Error("maximumSourceParticles and spawnCount may reserve at most 4096 total particles.");
	}
	if (required > system.getCapacity()) {
		throw new Error(`Collision-event output requires particle capacity ${required}; this system has ${system.getCapacity()}.`);
	}
	const volumes = collisionVolumes(scene, system);
	if (next.enabled && !volumes.planes.length && !volumes.spheres.length) {
		throw new Error("Enable at least one native GPU collision plane or sphere before enabling collision-triggered events.");
	}
	const storage = configurations(scene);
	const previous = storage[system.id] ? structuredClone(storage[system.id]) : undefined;
	storage[system.id] = structuredClone(next);
	try {
		configureGpuParticleCollisions(system, volumes.planes, volumes.spheres);
		configureGpuParticleCollisionEvents(system, next);
	} catch (error) {
		if (previous) {
			storage[system.id] = previous;
		} else {
			delete storage[system.id];
		}
		try {
			configureGpuParticleCollisionEvents(system, previous ?? null);
		} catch {
			// Preserve the original setup error; metadata has already been rolled back.
		}
		throw error;
	}
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getGpuParticleCollisionEvents(scene, { particleSystemId: system.id });
}
