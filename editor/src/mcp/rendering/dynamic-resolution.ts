import { Scene } from "babylonjs";

import {
	activeRenderingProfileMetadataKey,
	getDynamicResolutionRuntime,
	resetDynamicResolutionRuntime as resetSharedDynamicResolutionRuntime,
	validateDynamicResolutionConfiguration,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { listRenderingProfiles, setRenderingProfile } from "./profiles";

function selectProfile(scene: Scene, data: any): any {
	const state = listRenderingProfiles(scene);
	const activeId = state.activeProfileId as string | null;
	const value = data.id
		? state.profiles.find((candidate: any) => candidate.id === data.id)
		: data.name
			? state.profiles.find((candidate: any) => candidate.name === data.name)
			: activeId
				? state.profiles.find((candidate: any) => candidate.id === activeId)
				: null;
	if (!value) {
		throw new Error(data.id || data.name ? "Rendering profile not found." : "No active rendering profile is configured; provide id or name.");
	}
	return value;
}

/** Reads one profile's persisted dynamic-resolution policy and live evidence when it owns the active runtime. */
export function getDynamicResolution(scene: Scene, data: any = {}): any {
	const value = selectProfile(scene, data);
	const active = scene.metadata?.[activeRenderingProfileMetadataKey] === value.id;
	return {
		profile: {
			id: value.id,
			name: value.name,
			revision: value.revision,
			active,
			configuration: structuredClone(value.dynamicResolution),
		},
		runtime: active ? structuredClone(getDynamicResolutionRuntime(scene as any)) : null,
	};
}

/** Exact-leased update of one rendering profile's complete dynamic-resolution policy. Active profiles restart atomically through the shared runtime backend. */
export function setDynamicResolution(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = selectProfile(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Dynamic resolution profile lease is stale. Expected revision ${value.revision}.`);
	}
	const patch = data.configuration;
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		throw new Error("Dynamic resolution configuration patch must be an object.");
	}
	const configuration = validateDynamicResolutionConfiguration({ ...value.dynamicResolution, ...structuredClone(patch) }, value.quality.renderScale);
	const updated = setRenderingProfile(scene, { id: value.id, revision: value.revision, dynamicResolution: configuration }, options);
	return getDynamicResolution(scene, { id: updated.id });
}

/** Clears bounded measurements and restores the configured initial/fixed scale under the exact active profile lease. */
export function resetDynamicResolutionRuntime(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = selectProfile(scene, data);
	if (scene.metadata?.[activeRenderingProfileMetadataKey] !== value.id) {
		throw new Error(`Rendering profile "${value.name}" is not the active project profile.`);
	}
	if (data.revision !== value.revision) {
		throw new Error(`Dynamic resolution profile lease is stale. Expected revision ${value.revision}.`);
	}
	const runtime = resetSharedDynamicResolutionRuntime(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return { profileId: value.id, profileRevision: value.revision, runtime: structuredClone(runtime) };
}
