import { Scene, Tools } from "babylonjs";

import {
	activeRenderingProfileMetadataKey,
	configureAdaptivePerformance,
	configureActiveRenderingProfile,
	IRenderingProfile,
	renderReconstructionPreset,
	renderingProfilePreset,
	renderingProfileTargets,
	restoreRenderingProfileBaseline,
	stopAdaptivePerformance,
	validateRenderingProfiles,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { getCameraPostProcesses, setCameraPostProcess } from "./post-process";

const postProcessTypes = ["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"] as const;
type PostProcessType = (typeof postProcessTypes)[number];

function profiles(scene: Scene): IRenderingProfile[] {
	scene.metadata ??= {};
	const values = validateRenderingProfiles(scene.metadata.babylonEditorRenderingProfiles);
	scene.metadata.babylonEditorRenderingProfiles = values;
	return values;
}

function profile(scene: Scene, data: any): IRenderingProfile {
	const value = profiles(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) {
		throw new Error("Rendering profile not found. Provide id (preferred) or name.");
	}
	return value;
}

function validateConfigurations(value: any): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Rendering profile configurations must be an object keyed by post-process type.");
	}
	for (const type of Object.keys(value)) {
		if (!postProcessTypes.includes(type as PostProcessType)) {
			throw new Error(`Unsupported rendering profile post-process type "${type}".`);
		}
		if (value[type] !== null && (typeof value[type] !== "object" || Array.isArray(value[type]))) {
			throw new Error(`Rendering profile configuration for "${type}" must be an object or null.`);
		}
	}
}

function snapshot(scene: Scene, data: any): Record<PostProcessType, any> {
	const postProcesses = getCameraPostProcesses(scene, data).postProcesses;
	return Object.fromEntries(postProcessTypes.map((type) => [type, structuredClone(postProcesses[type] ?? null)])) as Record<PostProcessType, any>;
}

function applyCameraConfiguration(scene: Scene, value: IRenderingProfile, data: any, options: IMCPActionOptions): any[] {
	return postProcessTypes.map((type) => {
		const configuration = value.configurations[type] ?? null;
		return setCameraPostProcess(
			scene,
			{ nodeId: data.nodeId, nodeName: data.nodeName, type, enabled: configuration !== null, properties: configuration ?? undefined },
			options
		);
	});
}

/** Lists bounded versioned camera and project rendering profiles plus the active pipeline asset. */
export function listRenderingProfiles(scene: Scene): any {
	return {
		profiles: structuredClone(profiles(scene)),
		activeProfileId: scene.metadata?.[activeRenderingProfileMetadataKey] ?? null,
		runtime: (scene as any).renderingProfileRuntime ?? configureActiveRenderingProfile(scene as any, undefined, false),
	};
}

/** Creates a reusable rendering profile from a target preset plus explicit quality/capability overrides and camera configuration. */
export function createRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.name?.trim()) {
		throw new Error("Rendering profile name is required.");
	}
	if (profiles(scene).some((candidate) => candidate.name === data.name)) {
		throw new Error(`Rendering profile "${data.name}" already exists.`);
	}
	const target = data.target ?? "custom";
	if (!renderingProfileTargets.includes(target)) {
		throw new Error("Rendering profile target is invalid.");
	}
	const configurations = data.configurations ?? snapshot(scene, data);
	validateConfigurations(configurations);
	const candidate = {
		version: 4,
		id: data.id ?? Tools.RandomId(),
		name: data.name,
		revision: 1,
		target,
		quality: data.quality ?? renderingProfilePreset(target),
		dynamicResolution: data.dynamicResolution,
		reconstruction: data.reconstruction ?? renderReconstructionPreset(),
		requirements: data.requirements ?? {},
		configurations: structuredClone(configurations),
	};
	const next = validateRenderingProfiles([...profiles(scene), candidate]);
	scene.metadata.babylonEditorRenderingProfiles = next;
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(next.at(-1));
}

/** Updates a version-leased rendering pipeline asset without changing the active runtime until explicitly applied. */
export function setRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = profiles(scene);
	const value = values.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) {
		throw new Error("Rendering profile not found. Provide id (preferred) or name.");
	}
	if (data.revision !== undefined && data.revision !== value.revision) {
		throw new Error(`Rendering profile revision is stale. Expected ${value.revision}.`);
	}
	const candidate: any = structuredClone(value);
	if (data.name !== undefined) {
		if (!data.name.trim()) {
			throw new Error("Rendering profile name is required.");
		}
		if (values.some((other) => other.id !== value.id && other.name === data.name)) {
			throw new Error(`Rendering profile "${data.name}" already exists.`);
		}
		candidate.name = data.name;
	}
	for (const property of ["target", "quality", "dynamicResolution", "reconstruction", "requirements", "configurations"] as const) {
		if (data[property] !== undefined) {
			candidate[property] = structuredClone(data[property]);
		}
	}
	candidate.revision = value.revision + 1;
	const index = values.findIndex((entry) => entry.id === value.id);
	const next = values.map((entry, entryIndex) => (entryIndex === index ? candidate : entry));
	scene.metadata.babylonEditorRenderingProfiles = validateRenderingProfiles(next);
	const updated = scene.metadata.babylonEditorRenderingProfiles[index] as IRenderingProfile;
	if (scene.metadata[activeRenderingProfileMetadataKey] === updated.id && scene.activeCamera) {
		applyRenderingProfile(scene, { id: updated.id, revision: updated.revision, nodeId: scene.activeCamera.id, activateProject: true }, options);
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(updated);
}

/** Applies camera post-processes and optionally activates the profile as the scene's project render-pipeline asset. */
export function applyRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = profile(scene, data);
	if (data.revision !== undefined && data.revision !== value.revision) {
		throw new Error(`Rendering profile revision is stale. Expected ${value.revision}.`);
	}
	stopAdaptivePerformance(scene as any);
	const results = applyCameraConfiguration(scene, value, data, options);
	if (data.activateProject) {
		scene.metadata[activeRenderingProfileMetadataKey] = value.id;
		const runtime = configureActiveRenderingProfile(scene as any, undefined, false);
		if (!runtime.compatible) {
			scene.metadata[activeRenderingProfileMetadataKey] = null;
			configureActiveRenderingProfile(scene as any, undefined, false);
			configureAdaptivePerformance(scene as any);
			throw new Error(`Rendering profile is incompatible with this device: ${runtime.errors.join(" ")}`);
		}
	}
	const adaptivePerformance = configureAdaptivePerformance(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return {
		id: value.id,
		name: value.name,
		revision: value.revision,
		camera: results[0]?.camera,
		appliedTypes: postProcessTypes,
		activeProjectProfile: scene.metadata[activeRenderingProfileMetadataKey] === value.id,
		runtime: (scene as any).renderingProfileRuntime,
		adaptivePerformance,
	};
}

/** Returns exact backend capability and active pipeline-application evidence. */
export function getRenderingProfileRuntime(scene: Scene): any {
	return (scene as any).renderingProfileRuntime ?? configureActiveRenderingProfile(scene as any, undefined, false);
}

/** Clears the exact active project profile lease and restores the pre-activation global render baseline. */
export function clearActiveRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const activeId = scene.metadata?.[activeRenderingProfileMetadataKey];
	if (typeof activeId !== "string") {
		throw new Error("No active project rendering profile is configured.");
	}
	const value = profiles(scene).find((candidate) => candidate.id === activeId);
	if (!value) {
		throw new Error(`Active rendering profile "${activeId}" was not found.`);
	}
	if (data.id !== value.id || data.revision !== value.revision) {
		throw new Error(`Active rendering profile lease is stale. Expected id ${value.id} revision ${value.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Clearing the active rendering profile requires confirm: true.");
	}
	scene.metadata[activeRenderingProfileMetadataKey] = null;
	stopAdaptivePerformance(scene as any);
	const runtime = restoreRenderingProfileBaseline(scene as any);
	const adaptivePerformance = configureAdaptivePerformance(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return { cleared: true, id: value.id, revision: value.revision, runtime, adaptivePerformance };
}

/** Deletes one inactive profile under an exact revision and literal confirmation. */
export function deleteRenderingProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = profile(scene, data);
	if (data.confirm !== true) {
		throw new Error("Deleting a rendering profile requires confirm: true.");
	}
	if (data.revision !== value.revision) {
		throw new Error(`Rendering profile revision is stale. Expected ${value.revision}.`);
	}
	if (scene.metadata?.[activeRenderingProfileMetadataKey] === value.id) {
		throw new Error(`Rendering profile "${value.name}" is the active project profile.`);
	}
	if ((scene.metadata?.babylonEditorRenderingVolumes ?? []).some((volume: any) => volume.profileId === value.id)) {
		throw new Error(`Rendering profile "${value.name}" is assigned to one or more rendering volumes.`);
	}
	const values = profiles(scene);
	values.splice(
		values.findIndex((candidate) => candidate.id === value.id),
		1
	);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id, revision: value.revision };
}
