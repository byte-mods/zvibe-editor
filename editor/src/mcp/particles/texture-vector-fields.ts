import { dirname, isAbsolute, join, relative } from "path/posix";

import { pathExists } from "fs-extra";
import sharp from "sharp";

import { Scene, Vector3 } from "babylonjs";

import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";

export type ITextureVectorField = {
	min: number[];
	max: number[];
	strength: number;
	width: number;
	height: number;
	depth?: number;
	vectors: number[];
	sourcePath: string;
	enabled?: boolean;
};

const configuredScenes = new WeakSet<Scene>();

function getProjectDirectory(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return dirname(projectConfiguration.path);
}

function resolveProjectPath(path: string): string {
	return isAbsolute(path) ? path : join(getProjectDirectory(), path);
}

function fields(scene: Scene): Record<string, ITextureVectorField[]> {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorParticleTextureVectorFields ??= {});
}

function resolveParticleSystem(scene: Scene, data: any): any {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName) as any;
	if (!system) throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	if (system.getClassName?.() === "GPUParticleSystem") throw new Error("Sampled texture vector fields currently support CPU particle systems only.");
	return system;
}

function validate(field: ITextureVectorField, index: number): void {
	if (![field.min, field.max].every((value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)))
		throw new Error(`Texture vector field ${index} min and max must contain three finite values.`);
	if (field.min.some((value, axis) => value >= field.max[axis])) throw new Error(`Texture vector field ${index} min must be less than max on every axis.`);
	if (!Number.isFinite(field.strength)) throw new Error(`Texture vector field ${index} strength must be finite.`);
	const depth = field.depth ?? 1;
	if (
		!Number.isInteger(field.width) ||
		!Number.isInteger(field.height) ||
		!Number.isInteger(depth) ||
		field.width < 1 ||
		field.height < 1 ||
		depth < 1 ||
		field.width > 64 ||
		field.height > 64 ||
		depth > 64
	)
		throw new Error(`Texture vector field ${index} resolution must be from 1×1×1 through 64×64×64.`);
	if (!Array.isArray(field.vectors) || field.vectors.length !== field.width * field.height * depth * 3 || field.vectors.some((value) => !Number.isFinite(value)))
		throw new Error(`Texture vector field ${index} must contain exactly width × height × depth × 3 finite vector values.`);
}

/** Samples 2D XZ texture fields and applies RGB-mapped vector forces to CPU particles. */
export function applyParticleTextureVectorFields(particles: any[], configurations: ITextureVectorField[], deltaSeconds: number): number {
	let affected = 0;
	for (const field of configurations) {
		if (field.enabled === false) continue;
		const min = Vector3.FromArray(field.min),
			max = Vector3.FromArray(field.max);
		for (const particle of particles) {
			const position = particle.position as Vector3;
			const direction = particle.direction as Vector3;
			if (!position || !direction || position.x < min.x || position.x > max.x || position.y < min.y || position.y > max.y || position.z < min.z || position.z > max.z)
				continue;
			const x = Math.min(field.width - 1, Math.max(0, Math.round(((position.x - min.x) / (max.x - min.x)) * (field.width - 1))));
			const y = Math.min(field.height - 1, Math.max(0, Math.round(((position.y - min.y) / (max.y - min.y)) * (field.height - 1))));
			const z = Math.min((field.depth ?? 1) - 1, Math.max(0, Math.round(((position.z - min.z) / (max.z - min.z)) * ((field.depth ?? 1) - 1))));
			const offset = ((z * field.height + y) * field.width + x) * 3;
			direction.addInPlace(new Vector3(field.vectors[offset], field.vectors[offset + 1], field.vectors[offset + 2]).scale(field.strength * deltaSeconds));
			affected++;
		}
	}
	return affected;
}

/** Enables preview restoration for persistent image-sampled CPU particle vector fields. */
export function configureParticleTextureVectorFields(scene: Scene): void {
	if (configuredScenes.has(scene)) return;
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => {
		const deltaSeconds = scene.getEngine().getDeltaTime() / 1000;
		if (!deltaSeconds) return;
		for (const system of scene.particleSystems as any[]) {
			if (system.getClassName?.() === "GPUParticleSystem") continue;
			applyParticleTextureVectorFields(system.particles ?? [], fields(scene)[system.id] ?? [], deltaSeconds);
		}
	});
}

/** Lists persistent image-sampled XZ vector fields for one CPU particle system. */
export function getParticleTextureVectorFields(scene: Scene, data: any): any {
	const system = resolveParticleSystem(scene, data);
	return { particleSystemId: system.id, fields: structuredClone(fields(scene)[system.id] ?? []) };
}

/** Imports a raster image's RGB values as a capped 2D XZ CPU-particle vector field. */
export async function createParticleTextureVectorField(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const system = resolveParticleSystem(scene, data);
	const sourcePaths = data.sourcePaths?.length ? data.sourcePaths : [data.sourcePath];
	if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.length > 64) throw new Error("Provide from one to 64 raster source paths for a 3D vector field.");
	const resolvedPaths = sourcePaths.map(resolveProjectPath);
	for (const [index, sourcePath] of resolvedPaths.entries()) if (!(await pathExists(sourcePath))) throw new Error(`Image asset not found: ${sourcePaths[index]}`);
	const outputs = await Promise.all(
		resolvedPaths.map((sourcePath) =>
			sharp(sourcePath, { animated: false })
				.rotate()
				.resize({ width: data.width ?? 32, height: data.height ?? 32, fit: "fill", withoutEnlargement: false })
				.ensureAlpha()
				.raw()
				.toBuffer({ resolveWithObject: true })
		)
	);
	const output = outputs[0];
	const field: ITextureVectorField = {
		min: data.min,
		max: data.max,
		strength: data.strength ?? 1,
		width: output.info.width,
		height: output.info.height,
		depth: outputs.length,
		vectors: outputs.flatMap((slice) => Array.from(slice.data).reduce<number[]>((result, value, index) => (index % 4 !== 3 ? [...result, value / 127.5 - 1] : result), [])),
		sourcePath: relative(getProjectDirectory(), resolvedPaths[0]),
		enabled: data.enabled,
	};
	validate(field, 0);
	const current = fields(scene)[system.id] ?? [];
	if (current.length >= 8) throw new Error("Texture vector fields must contain from zero to eight fields.");
	fields(scene)[system.id] = [...current, field];
	configureParticleTextureVectorFields(scene);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleTextureVectorFields(scene, { particleSystemId: system.id });
}

/** Replaces all image-sampled texture vector fields, useful for removal or declarative restoration. */
export function setParticleTextureVectorFields(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolveParticleSystem(scene, data);
	const configurations = data.fields ?? [];
	if (!Array.isArray(configurations) || configurations.length > 8) throw new Error("Texture vector fields must contain from zero to eight fields.");
	for (const [index, field] of configurations.entries()) validate(field, index);
	fields(scene)[system.id] = structuredClone(configurations);
	configureParticleTextureVectorFields(scene);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleTextureVectorFields(scene, { particleSystemId: system.id });
}
