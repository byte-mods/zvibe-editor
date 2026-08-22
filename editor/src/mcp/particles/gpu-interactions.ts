import { Scene } from "babylonjs";
import { configureGpuParticleInteractions, getGpuParticleInteractionRuntimeEvidence, IGpuParticleInteractionConfiguration } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

const defaultConfiguration: IGpuParticleInteractionConfiguration = {
	enabled: false,
	radius: 10,
	restitution: 0.5,
	separationStrength: 1,
	maximumParticles: 1024,
	maximumNeighbors: 16,
	boundsMin: [-500, -500, -500],
	boundsMax: [500, 500, 500],
	gridResolution: 32,
};

function configurations(scene: Scene): Record<string, IGpuParticleInteractionConfiguration> {
	scene.metadata ??= {};
	scene.metadata.babylonEditorGpuParticleInteractions ??= {};
	return scene.metadata.babylonEditorGpuParticleInteractions;
}

function resolve(scene: Scene, data: any): any {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName) as any;
	if (!system) {
		throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	}
	if (system.getClassName?.() !== "GPUParticleSystem") {
		throw new Error("Native pairwise particle interactions require a GPU particle system.");
	}
	return system;
}

function currentConfiguration(scene: Scene, systemId: string): IGpuParticleInteractionConfiguration {
	const stored = configurations(scene)[systemId];
	return structuredClone({
		...defaultConfiguration,
		...stored,
		boundsMin: stored?.boundsMin ?? defaultConfiguration.boundsMin,
		boundsMax: stored?.boundsMax ?? defaultConfiguration.boundsMax,
	});
}

function validate(configuration: IGpuParticleInteractionConfiguration): void {
	if (typeof configuration.enabled !== "boolean") {
		throw new Error("GPU particle interaction enabled must be a boolean.");
	}
	if (!Number.isFinite(configuration.radius) || configuration.radius <= 0 || configuration.radius > 100000) {
		throw new Error("GPU particle interaction radius must be greater than 0 and at most 100000 centimeters.");
	}
	if (!Number.isFinite(configuration.restitution) || configuration.restitution < 0 || configuration.restitution > 1) {
		throw new Error("GPU particle interaction restitution must be between 0 and 1.");
	}
	if (!Number.isFinite(configuration.separationStrength) || configuration.separationStrength < 0 || configuration.separationStrength > 1) {
		throw new Error("GPU particle interaction separationStrength must be between 0 and 1.");
	}
	if (!Number.isInteger(configuration.maximumParticles) || configuration.maximumParticles < 2 || configuration.maximumParticles > 4096) {
		throw new Error("GPU particle interaction maximumParticles must be an integer from 2 to 4096.");
	}
	if (!Number.isInteger(configuration.maximumNeighbors) || configuration.maximumNeighbors < 1 || configuration.maximumNeighbors > 64) {
		throw new Error("GPU particle interaction maximumNeighbors must be an integer from 1 to 64.");
	}
	if (configuration.maximumNeighbors >= configuration.maximumParticles) {
		throw new Error("GPU particle interaction maximumNeighbors must be less than maximumParticles.");
	}
	if (!Array.isArray(configuration.boundsMin) || !Array.isArray(configuration.boundsMax) || configuration.boundsMin.length !== 3 || configuration.boundsMax.length !== 3) {
		throw new Error("GPU particle interaction boundsMin and boundsMax must each contain three numbers.");
	}
	for (let axis = 0; axis < 3; axis++) {
		if (!Number.isFinite(configuration.boundsMin[axis]) || !Number.isFinite(configuration.boundsMax[axis]) || configuration.boundsMax[axis] <= configuration.boundsMin[axis]) {
			throw new Error(`GPU particle interaction bounds require a finite max greater than min on axis ${axis}.`);
		}
	}
	if (!Number.isInteger(configuration.gridResolution) || configuration.gridResolution < 4 || configuration.gridResolution > 64) {
		throw new Error("GPU particle interaction gridResolution must be an integer from 4 to 64.");
	}
}

/** Reads persisted pairwise GPU particle collision settings and exact native-backend evidence. */
export function getGpuParticleInteractions(scene: Scene, data: any): any {
	const system = resolve(scene, data);
	const configuration = currentConfiguration(scene, system.id);
	return {
		particleSystemId: system.id,
		particleSystemName: system.name,
		configuration,
		runtime: getGpuParticleInteractionRuntimeEvidence(system),
	};
}

/** Atomically updates bounded native WebGPU pairwise particle collisions. */
export function setGpuParticleInteractions(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolve(scene, data);
	const storage = configurations(scene);
	const previous = storage[system.id] ? structuredClone(storage[system.id]) : undefined;
	const next: IGpuParticleInteractionConfiguration = {
		...currentConfiguration(scene, system.id),
		...(data.enabled === undefined ? {} : { enabled: data.enabled }),
		...(data.radius === undefined ? {} : { radius: data.radius }),
		...(data.restitution === undefined ? {} : { restitution: data.restitution }),
		...(data.separationStrength === undefined ? {} : { separationStrength: data.separationStrength }),
		...(data.maximumParticles === undefined ? {} : { maximumParticles: data.maximumParticles }),
		...(data.maximumNeighbors === undefined ? {} : { maximumNeighbors: data.maximumNeighbors }),
		...(data.boundsMin === undefined ? {} : { boundsMin: data.boundsMin }),
		...(data.boundsMax === undefined ? {} : { boundsMax: data.boundsMax }),
		...(data.gridResolution === undefined ? {} : { gridResolution: data.gridResolution }),
	};
	validate(next);
	storage[system.id] = structuredClone(next);
	try {
		configureGpuParticleInteractions(system, next);
	} catch (error) {
		if (previous) {
			storage[system.id] = previous;
		} else {
			delete storage[system.id];
		}
		throw error;
	}
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getGpuParticleInteractions(scene, { particleSystemId: system.id });
}
