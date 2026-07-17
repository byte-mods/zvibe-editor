import { dirname, join, isAbsolute, basename, relative } from "path/posix";

import { Attractor, IParticleSystem, Mesh, Scene, Tools, Vector3 } from "babylonjs";

import { normalizedGlob } from "../../tools/fs";
import { isAbstractMesh } from "../../tools/guards/nodes";
import { isNodeParticleSystemSetMesh } from "../../tools/guards/particles";
import { loadImportedParticleSystemFile } from "../../editor/layout/preview/import/particles";

import { addGPUParticleSystem, addParticleSystem } from "../../project/add/particles";

import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";
import { deepSet, resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

function resolveParticleSystem(scene: Scene, data: any): IParticleSystem {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName);
	if (!system) throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	return system;
}

type IVfxBudgetProfile = { id: string; name: string; capacityScale: number; emissionScale: number; maxCapacity?: number };

function budgetProfiles(scene: Scene): IVfxBudgetProfile[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorVfxBudgetProfiles ??= []);
}

function resolveBudgetProfile(scene: Scene, data: { id?: string; name?: string }): IVfxBudgetProfile {
	const profile = budgetProfiles(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!profile) throw new Error("VFX budget profile not found.");
	return profile;
}

function validateBudgetProfile(profile: Omit<IVfxBudgetProfile, "id">): void {
	if (!profile.name.trim()) throw new Error("VFX budget profiles require a name.");
	if (!Number.isFinite(profile.capacityScale) || profile.capacityScale <= 0 || !Number.isFinite(profile.emissionScale) || profile.emissionScale < 0)
		throw new Error("capacityScale must be positive and emissionScale must be zero or greater.");
	if (profile.maxCapacity !== undefined && (!Number.isInteger(profile.maxCapacity) || profile.maxCapacity < 1)) throw new Error("maxCapacity must be a positive integer.");
}

/** Lists persisted scene-wide VFX quality/budget profiles. */
export function listVfxBudgetProfiles(scene: Scene): any {
	return { profiles: structuredClone(budgetProfiles(scene)) };
}

/** Creates a reusable VFX quality profile that can constrain native CPU/GPU particle systems. */
export function createVfxBudgetProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const profile: IVfxBudgetProfile = {
		id: Tools.RandomId(),
		name: data.name,
		capacityScale: data.capacityScale ?? 1,
		emissionScale: data.emissionScale ?? 1,
		maxCapacity: data.maxCapacity,
	};
	validateBudgetProfile(profile);
	if (budgetProfiles(scene).some((candidate) => candidate.name === profile.name)) throw new Error(`VFX budget profile \"${profile.name}\" already exists.`);
	budgetProfiles(scene).push(profile);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(profile);
}

/** Updates one VFX quality profile. */
export function setVfxBudgetProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const profile = resolveBudgetProfile(scene, data);
	const next = { ...profile, ...data, id: profile.id, name: data.name ?? profile.name };
	validateBudgetProfile(next);
	if (data.name !== undefined && budgetProfiles(scene).some((candidate) => candidate !== profile && candidate.name === data.name))
		throw new Error(`VFX budget profile \"${data.name}\" already exists.`);
	Object.assign(profile, next);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(profile);
}

/** Applies a VFX quality profile to every native CPU/GPU particle system and returns resulting budgets. */
export function applyVfxBudgetProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const profile = resolveBudgetProfile(scene, data);
	const systems = scene.particleSystems.map((system: any) => {
		const capacity = typeof system.getCapacity === "function" ? system.getCapacity() : system.capacity;
		const nextCapacity = Math.max(1, Math.floor(Math.min(profile.maxCapacity ?? Infinity, capacity * profile.capacityScale)));
		if (typeof system.setCapacity === "function") system.setCapacity(nextCapacity);
		else system.capacity = nextCapacity;
		system.emitRate = Math.max(0, system.emitRate * profile.emissionScale);
		return { id: system.id, name: system.name, capacity: nextCapacity, emitRate: system.emitRate };
	});
	options.editor.layout.inspector.forceUpdate();
	return { profile: structuredClone(profile), systems };
}

/** Deletes a VFX quality profile without changing any currently applied system settings. */
export function deleteVfxBudgetProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const profile = resolveBudgetProfile(scene, data);
	budgetProfiles(scene).splice(budgetProfiles(scene).indexOf(profile), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: profile.id };
}

/** Lists native particle attractors, usable as radial VFX force fields on CPU and GPU systems. */
export function getParticleAttractors(scene: Scene, data: any): any {
	const system = resolveParticleSystem(scene, data) as any;
	return {
		particleSystem: describeParticleSystem(system),
		attractors: (system.attractors ?? []).map((attractor: Attractor) => ({ position: attractor.position.asArray(), strength: attractor.strength })),
	};
}

/** Replaces native particle attractors with persisted radial VFX force-field settings. */
export function setParticleAttractors(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolveParticleSystem(scene, data) as any;
	const attractors = data.attractors ?? [];
	if (!Array.isArray(attractors) || attractors.length > 16) throw new Error("Particle attractors must contain from zero to sixteen force fields.");
	for (const [index, attractor] of attractors.entries()) {
		if (!Array.isArray(attractor.position) || attractor.position.length !== 3 || attractor.position.some((value: any) => !Number.isFinite(value)))
			throw new Error(`Particle attractor ${index} position must be three finite numbers.`);
		if (!Number.isFinite(attractor.strength)) throw new Error(`Particle attractor ${index} strength must be finite.`);
	}
	for (const attractor of system.attractors ?? []) system.removeAttractor(attractor);
	for (const configuration of attractors) {
		const attractor = new Attractor();
		attractor.position = Vector3.FromArray(configuration.position);
		attractor.strength = configuration.strength;
		system.addAttractor(attractor);
	}
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleAttractors(scene, { particleSystemId: system.id });
}

function describeParticleSystem(system: IParticleSystem): any {
	return {
		id: system.id,
		name: system.name,
		className: system.getClassName(),
		emitterId: (system.emitter as any)?.id ?? null,
		isStarted: system.isStarted(),
		emitRate: (system as any).emitRate,
		minSize: (system as any).minSize,
		maxSize: (system as any).maxSize,
		minLifeTime: (system as any).minLifeTime,
		maxLifeTime: (system as any).maxLifeTime,
	};
}

function resolveNodeParticleSystem(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isNodeParticleSystemSetMesh(node)) throw new Error(`Node "${node.name}" is not a Node Particle System Set.`);
	return node;
}

export function listParticleSystems(scene: Scene): any {
	return { particleSystems: scene.particleSystems.map(describeParticleSystem) };
}

/** Lists node-based particle graph meshes in the active scene. */
export function listNodeParticleSystems(scene: Scene): any {
	return {
		nodeParticleSystems: scene.meshes
			.filter(isNodeParticleSystemSetMesh)
			.map((node) => ({ ...toNodeSummary(node), graphId: node.nodeParticleSystemSet?.id ?? null, systemCount: node.particleSystemSet?.systems.length ?? 0 })),
	};
}

/** Gets the serialized Node Particle System Set graph. */
export function getNodeParticleSystemGraph(scene: Scene, data: any): any {
	const node = resolveNodeParticleSystem(scene, data);
	if (!node.nodeParticleSystemSet) throw new Error(`Node Particle System "${node.name}" has no graph.`);
	return {
		node: toNodeSummary(node),
		graph: { ...node.nodeParticleSystemSet.serialize(), id: node.nodeParticleSystemSet.id, uniqueId: node.nodeParticleSystemSet.uniqueId },
	};
}

/** Rebuilds a node particle system mesh from a serialized Node Particle System Set graph. */
export async function replaceNodeParticleSystemGraph(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const node = resolveNodeParticleSystem(scene, data);
	await node.buildNodeParticleSystemSet(data.graph);
	options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(node));
	options.editor.layout.inspector.setEditedObject(node);
	return getNodeParticleSystemGraph(scene, { nodeId: node.id });
}

/**
 * Returns the absolute path of the project directory.
 */
function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	return dirname(projectConfiguration.path);
}

/**
 * Resolves an absolute path from a project-relative or absolute path.
 */
function resolveProjectPath(path: string): string {
	return isAbsolute(path) ? path : join(getProjectDirectory(), path);
}

/**
 * Lists all the `.npss` node particle system assets in the project.
 */
export async function listParticleAssets(): Promise<any> {
	const directory = getProjectDirectory();

	const matches = await normalizedGlob(join(directory, "/**/*.npss"), {
		nodir: true,
		ignore: ["**/node_modules/**"],
	});

	return {
		assets: (matches as string[]).map((matchPath) => {
			const path = matchPath.toString();
			return {
				name: basename(path, ".npss"),
				path: relative(directory, path),
			};
		}),
	};
}

/**
 * Instantiates a `.npss` asset into the scene, or creates a default particle system.
 */
export async function instantiateParticleSystem(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	// Resolve the emitter mesh.
	let emitter: Mesh;
	if (data.emitterNodeId || data.emitterNodeName) {
		const node = resolveNode({ scene, nodeId: data.emitterNodeId, nodeName: data.emitterNodeName });
		if (!isAbstractMesh(node)) {
			throw new Error(`Emitter node "${node.name}" is not a mesh.`);
		}
		emitter = node as Mesh;
	} else {
		// Create an empty mesh to act as the emitter when none is provided.
		emitter = new Mesh(data.name ? `${data.name} Emitter` : "Particle System Emitter", scene);
	}

	if (data.position) {
		emitter.position.copyFrom(toVector3(data.position));
	}

	if (data.path) {
		const absolutePath = resolveProjectPath(data.path);
		const node = await loadImportedParticleSystemFile(scene, emitter, absolutePath);

		if (data.name) {
			node.name = data.name;
		}

		options.editor.layout.graph.refresh().then(() => {
			options.editor.layout.graph.setSelectedNode(node);
		});
		options.editor.layout.inspector.setEditedObject(node);

		return toNodeSummary(node);
	}

	// No asset path: create a default particle system on the emitter.
	if (data.type === "gpu") addGPUParticleSystem(options.editor, emitter);
	else addParticleSystem(options.editor, emitter);

	options.editor.layout.graph.refresh();

	return toNodeSummary(emitter);
}

/** Updates any serializable particle properties using the editor's dotted-path setter. */
export function setParticleSystemProperties(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolveParticleSystem(scene, data);
	for (const [path, value] of Object.entries(data.properties)) deepSet(system, path, value);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return describeParticleSystem(system);
}

/** Starts or stops a standard or GPU particle system. */
export function setParticleSystemPlaying(scene: Scene, data: any): any {
	const system = resolveParticleSystem(scene, data);
	if (data.playing) system.start();
	else system.stop();
	return describeParticleSystem(system);
}

/** Validates common CPU/GPU particle authoring errors and reports the particle budget. */
export function validateParticleSystem(scene: Scene, data: any): any {
	const system = resolveParticleSystem(scene, data) as any;
	const errors: string[] = [];
	const warnings: string[] = [];
	const capacity = typeof system.getCapacity === "function" ? system.getCapacity() : (system.capacity ?? 0);
	const emitRate = system.emitRate ?? 0;
	const minLifeTime = system.minLifeTime ?? 0;
	const maxLifeTime = system.maxLifeTime ?? 0;
	const minSize = system.minSize ?? 0;
	const maxSize = system.maxSize ?? 0;
	if (!system.emitter) errors.push("No emitter is assigned. Assign a mesh or position before starting the particle system.");
	if (!Number.isFinite(capacity) || capacity < 1) errors.push("Particle capacity must be at least 1.");
	if (!Number.isFinite(emitRate) || emitRate < 0) errors.push("Emit rate must be zero or greater.");
	if (!Number.isFinite(minLifeTime) || !Number.isFinite(maxLifeTime) || minLifeTime < 0 || maxLifeTime < minLifeTime)
		errors.push("Particle lifetimes must be non-negative and maxLifeTime must be at least minLifeTime.");
	if (!Number.isFinite(minSize) || !Number.isFinite(maxSize) || minSize < 0 || maxSize < minSize)
		errors.push("Particle sizes must be non-negative and maxSize must be at least minSize.");
	if (!system.particleTexture) warnings.push("No particle texture is assigned; the effect may render as fallback particles or not look as intended.");
	if (emitRate === 0) warnings.push("Emit rate is zero, so no new particles will be emitted.");
	const estimatedAliveParticles = Math.ceil(emitRate * maxLifeTime);
	if (capacity > 0 && estimatedAliveParticles > capacity) warnings.push(`Estimated peak (${estimatedAliveParticles}) exceeds capacity (${capacity}); particles can be dropped.`);
	if (system.getClassName() === "GPUParticleSystem" && !scene.getEngine().getCaps().supportComputeShaders)
		warnings.push("GPU particle system is running without compute-shader support; validate the intended WebGL/WebGPU target.");
	return {
		particleSystem: describeParticleSystem(system),
		valid: errors.length === 0,
		errors,
		warnings,
		budget: { capacity, emitRate, maxLifeTime, estimatedAliveParticles },
	};
}
