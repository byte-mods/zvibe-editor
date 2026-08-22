import { Scene, Tools, Vector3 } from "babylonjs";
import { blendRenderingConfiguration, getRenderingVolumeContributions } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { listRenderingProfiles } from "./profiles";
import { getCameraPostProcesses, setCameraPostProcess } from "./post-process";

const postProcessTypes = ["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"] as const;
type IRenderingVolume = {
	id: string;
	name: string;
	profileId: string;
	center: number[];
	size: number[];
	priority: number;
	blendDistance: number;
	weight: number;
	enabled: boolean;
};
const volumeBaselines = new WeakMap<object, any>();
const activeVolumes = new WeakMap<object, string>();

function snapshotCamera(scene: Scene, camera: any): any {
	return structuredClone(getCameraPostProcesses(scene, { nodeId: camera.id }).postProcesses);
}
function restoreCamera(scene: Scene, camera: any, configurations: any, options: IMCPActionOptions): void {
	for (const type of postProcessTypes) {
		setCameraPostProcess(scene, { nodeId: camera.id, type, enabled: configurations[type] !== null, properties: configurations[type] ?? undefined }, options);
	}
}

function normalizeConfigurations(configurations: any): any {
	return Object.fromEntries(postProcessTypes.map((type) => [type, structuredClone(configurations[type] ?? null)]));
}

function volumes(scene: Scene): IRenderingVolume[] {
	scene.metadata ??= {};
	const values = (scene.metadata.babylonEditorRenderingVolumes ??= []);
	for (const value of values) {
		value.blendDistance ??= 0;
		value.weight ??= 1;
	}
	return values;
}
function volume(scene: Scene, data: any): IRenderingVolume {
	const value = volumes(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) {
		throw new Error("Rendering volume not found.");
	}
	return value;
}
function validate(scene: Scene, value: IRenderingVolume): void {
	if (!value.name.trim()) {
		throw new Error("Rendering volume name is required.");
	}
	if (!listRenderingProfiles(scene).profiles.some((profile: any) => profile.id === value.profileId)) {
		throw new Error("Rendering volume profileId must reference a rendering profile.");
	}
	if (![value.center, value.size].every((vector) => Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite))) {
		throw new Error("Rendering volume center and size must be three finite numbers.");
	}
	if (value.size.some((axis) => axis <= 0)) {
		throw new Error("Rendering volume size must be positive on every axis.");
	}
	if (!Number.isFinite(value.priority)) {
		throw new Error("Rendering volume priority must be finite.");
	}
	if (!Number.isFinite(value.blendDistance) || value.blendDistance < 0) {
		throw new Error("Rendering volume blendDistance must be a non-negative finite number.");
	}
	if (!Number.isFinite(value.weight) || value.weight < 0 || value.weight > 1) {
		throw new Error("Rendering volume weight must be a finite number from 0 to 1.");
	}
}

/** Lists persisted priority-ordered rendering volumes. */
export function listRenderingVolumes(scene: Scene): any {
	return { volumes: structuredClone(volumes(scene)) };
}
/** Creates an axis-aligned camera rendering volume linked to an existing profile. */
export function createRenderingVolume(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value: IRenderingVolume = {
		id: Tools.RandomId(),
		name: data.name,
		profileId: data.profileId,
		center: data.center ?? [0, 0, 0],
		size: data.size ?? [1000, 1000, 1000],
		priority: data.priority ?? 0,
		blendDistance: data.blendDistance ?? 0,
		weight: data.weight ?? 1,
		enabled: data.enabled ?? true,
	};
	validate(scene, value);
	if (volumes(scene).some((candidate) => candidate.name === value.name)) {
		throw new Error(`Rendering volume "${value.name}" already exists.`);
	}
	volumes(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Updates a rendering volume's bounds, blend controls, priority, enabled state, or profile. */
export function setRenderingVolume(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = volume(scene, data);
	const next = { ...value, ...data, id: value.id, name: data.name ?? value.name };
	validate(scene, next);
	if (data.name !== undefined && volumes(scene).some((candidate) => candidate !== value && candidate.name === data.name)) {
		throw new Error(`Rendering volume "${data.name}" already exists.`);
	}
	Object.assign(value, next);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Blends all rendering volumes influencing the active camera in the editor preview. */
export function evaluateRenderingVolumes(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const camera: any = scene.activeCamera;
	if (!camera) {
		throw new Error("No active camera.");
	}
	const position = camera.getAbsolutePosition?.() ?? camera.globalPosition ?? camera.position ?? Vector3.Zero();
	const profiles = listRenderingProfiles(scene).profiles as any[];
	const contributions = getRenderingVolumeContributions(
		volumes(scene).filter((candidate) => candidate.enabled),
		position.asArray()
	).filter((entry) => profiles.some((profile) => profile.id === entry.volume.profileId));
	const winner = contributions.length ? [...contributions].sort((first, second) => second.volume.priority - first.volume.priority)[0].volume : null;
	if (contributions.length) {
		if (!volumeBaselines.has(camera)) {
			volumeBaselines.set(camera, snapshotCamera(scene, camera));
		}
		const configurations = contributions.reduce((current, contribution) => {
			const profile = profiles.find((candidate) => candidate.id === contribution.volume.profileId)!;
			return blendRenderingConfiguration(current, normalizeConfigurations(profile.configurations), contribution.blendFactor);
		}, volumeBaselines.get(camera));
		const signature = JSON.stringify(configurations);
		if (activeVolumes.get(camera) !== signature) {
			restoreCamera(scene, camera, configurations, options);
		}
		activeVolumes.set(camera, signature);
	} else if (volumeBaselines.has(camera)) {
		restoreCamera(scene, camera, volumeBaselines.get(camera), options);
		volumeBaselines.delete(camera);
		activeVolumes.delete(camera);
	}
	return {
		cameraId: camera.id,
		volume: winner ? structuredClone(winner) : null,
		volumes: contributions.map((entry) => ({ ...structuredClone(entry.volume), blendFactor: entry.blendFactor })),
		restoredBaseline: !winner && !volumeBaselines.has(camera),
	};
}
/** Deletes a rendering volume without deleting its reusable profile. */
export function deleteRenderingVolume(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = volume(scene, data);
	volumes(scene).splice(volumes(scene).indexOf(value), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}
