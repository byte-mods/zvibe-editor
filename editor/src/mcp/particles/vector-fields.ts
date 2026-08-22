import { Scene, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";

type IVectorField = { min: number[]; max: number[]; direction: number[]; strength: number; enabled?: boolean };
const configuredScenes = new WeakSet<Scene>();

function fields(scene: Scene): Record<string, IVectorField[]> {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorParticleVectorFields ??= {});
}

function validate(field: IVectorField, index: number): void {
	if (![field.min, field.max, field.direction].every((value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite))) {
		throw new Error(`Vector field ${index} min, max, and direction must contain three finite values.`);
	}
	if (field.min.some((value, axis) => value >= field.max[axis])) {
		throw new Error(`Vector field ${index} min must be less than max on every axis.`);
	}
	if (!Number.isFinite(field.strength)) {
		throw new Error(`Vector field ${index} strength must be finite.`);
	}
}

/** Applies bounded directional fields to CPU particles. Exported for deterministic editor tests. */
export function applyParticleVectorFields(particles: any[], configurations: IVectorField[], deltaSeconds: number): number {
	let affected = 0;
	for (const field of configurations) {
		if (field.enabled === false) {
			continue;
		}
		const min = Vector3.FromArray(field.min);
		const max = Vector3.FromArray(field.max);
		const force = Vector3.FromArray(field.direction).scale(field.strength * deltaSeconds);
		for (const particle of particles) {
			const position = particle.position as Vector3;
			const direction = particle.direction as Vector3;
			if (!position || !direction || position.x < min.x || position.y < min.y || position.z < min.z || position.x > max.x || position.y > max.y || position.z > max.z) {
				continue;
			}
			direction.addInPlace(force);
			affected++;
		}
	}
	return affected;
}

/** Enables scene-level preview updates for persisted CPU particle vector fields. */
export function configureParticleVectorFields(scene: Scene): void {
	if (configuredScenes.has(scene)) {
		return;
	}
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => {
		const deltaSeconds = scene.getEngine().getDeltaTime() / 1000;
		if (!deltaSeconds) {
			return;
		}
		for (const system of scene.particleSystems as any[]) {
			if (system.getClassName?.() === "GPUParticleSystem") {
				continue;
			}
			applyParticleVectorFields(system.particles ?? [], fields(scene)[system.id] ?? [], deltaSeconds);
		}
	});
}

/** Gets persisted bounded directional fields for one CPU particle system. */
export function getParticleVectorFields(scene: Scene, data: any): any {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName) as any;
	if (!system) {
		throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	}
	return { particleSystemId: system.id, fields: structuredClone(fields(scene)[system.id] ?? []) };
}

/** Replaces persistent bounded directional fields for a CPU particle system. */
export function setParticleVectorFields(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName) as any;
	if (!system) {
		throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	}
	if (system.getClassName?.() === "GPUParticleSystem") {
		throw new Error("Vector fields currently support CPU particle systems only.");
	}
	const configurations = data.fields ?? [];
	if (!Array.isArray(configurations) || configurations.length > 8) {
		throw new Error("Vector fields must contain from zero to eight fields.");
	}
	for (const [index, field] of configurations.entries()) {
		validate(field, index);
	}
	fields(scene)[system.id] = structuredClone(configurations);
	configureParticleVectorFields(scene);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleVectorFields(scene, { particleSystemId: system.id });
}
