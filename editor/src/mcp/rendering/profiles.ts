import { Scene, Tools } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { getCameraPostProcesses, setCameraPostProcess } from "./post-process";

const postProcessTypes = ["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"] as const;
type PostProcessType = (typeof postProcessTypes)[number];

function profiles(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorRenderingProfiles ??= []);
}

function profile(scene: Scene, data: any): any {
	const value = profiles(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) throw new Error("Rendering profile not found. Provide id (preferred) or name.");
	return value;
}

function validateConfigurations(value: any): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Rendering profile configurations must be an object keyed by post-process type.");
	for (const type of Object.keys(value)) {
		if (!postProcessTypes.includes(type as PostProcessType)) throw new Error(`Unsupported rendering profile post-process type "${type}".`);
		if (value[type] !== null && (typeof value[type] !== "object" || Array.isArray(value[type])))
			throw new Error(`Rendering profile configuration for "${type}" must be an object or null.`);
	}
}

function snapshot(scene: Scene, data: any): Record<PostProcessType, any> {
	const postProcesses = getCameraPostProcesses(scene, data).postProcesses;
	return Object.fromEntries(postProcessTypes.map((type) => [type, structuredClone(postProcesses[type] ?? null)])) as Record<PostProcessType, any>;
}

/** Lists persisted reusable camera rendering profiles. */
export function listRenderingProfiles(scene: Scene): any {
	return { profiles: structuredClone(profiles(scene)) };
}

/** Creates a reusable rendering profile from explicit configurations or a camera snapshot. */
export function createRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.name?.trim()) throw new Error("Rendering profile name is required.");
	if (profiles(scene).some((candidate) => candidate.name === data.name)) throw new Error(`Rendering profile "${data.name}" already exists.`);
	const configurations = data.configurations ?? snapshot(scene, data);
	validateConfigurations(configurations);
	const value = { id: data.id ?? Tools.RandomId(), name: data.name, configurations: structuredClone(configurations) };
	profiles(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Updates a named persisted rendering profile without changing a camera. */
export function setRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = profile(scene, data);
	if (data.name !== undefined) {
		if (!data.name.trim()) throw new Error("Rendering profile name is required.");
		if (profiles(scene).some((candidate) => candidate !== value && candidate.name === data.name)) throw new Error(`Rendering profile "${data.name}" already exists.`);
		value.name = data.name;
	}
	if (data.configurations !== undefined) {
		validateConfigurations(data.configurations);
		value.configurations = structuredClone(data.configurations);
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Applies every stored post-process enablement/configuration to a target camera. */
export function applyRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = profile(scene, data);
	const results = postProcessTypes.map((type) => {
		const configuration = value.configurations[type] ?? null;
		return setCameraPostProcess(
			scene,
			{ nodeId: data.nodeId, nodeName: data.nodeName, type, enabled: configuration !== null, properties: configuration ?? undefined },
			options
		);
	});
	return { id: value.id, name: value.name, camera: results[0]?.camera, appliedTypes: postProcessTypes };
}

/** Deletes one persisted reusable rendering profile. */
export function deleteRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = profile(scene, data);
	if ((scene.metadata?.babylonEditorRenderingVolumes ?? []).some((volume: any) => volume.profileId === value.id))
		throw new Error(`Rendering profile \"${value.name}\" is assigned to one or more rendering volumes.`);
	profiles(scene).splice(profiles(scene).indexOf(value), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}
