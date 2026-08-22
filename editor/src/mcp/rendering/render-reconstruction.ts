import { Scene } from "babylonjs";

import {
	activeRenderingProfileMetadataKey,
	getRenderReconstructionRuntime,
	resetRenderReconstructionHistory as resetSharedRenderReconstructionHistory,
	validateRenderReconstructionConfiguration,
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

/** Reads one profile's persisted reconstruction policy and live evidence when it owns the active runtime. */
export function getRenderReconstruction(scene: Scene, data: any = {}): any {
	const value = selectProfile(scene, data);
	const active = scene.metadata?.[activeRenderingProfileMetadataKey] === value.id;
	return {
		profile: {
			id: value.id,
			name: value.name,
			revision: value.revision,
			active,
			configuration: structuredClone(value.reconstruction),
		},
		runtime: active ? structuredClone(getRenderReconstructionRuntime(scene as any)) : null,
	};
}

/** Exact-leased update of one profile's complete reconstruction policy through the shared editor/export backend. */
export function setRenderReconstruction(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = selectProfile(scene, data);
	if (data.revision !== value.revision) {
		throw new Error(`Render reconstruction profile lease is stale. Expected revision ${value.revision}.`);
	}
	const patch = data.configuration;
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
		throw new Error("Render reconstruction configuration patch must be an object.");
	}
	const configuration = validateRenderReconstructionConfiguration({ ...value.reconstruction, ...structuredClone(patch) });
	const updated = setRenderingProfile(scene, { id: value.id, revision: value.revision, reconstruction: configuration }, options);
	return getRenderReconstruction(scene, { id: updated.id });
}

/** Clears temporal history/jitter under the exact active rendering-profile lease without changing persisted settings. */
export function resetRenderReconstructionHistory(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = selectProfile(scene, data);
	if (scene.metadata?.[activeRenderingProfileMetadataKey] !== value.id) {
		throw new Error(`Rendering profile "${value.name}" is not the active project profile.`);
	}
	if (data.revision !== value.revision) {
		throw new Error(`Render reconstruction profile lease is stale. Expected revision ${value.revision}.`);
	}
	const runtime = resetSharedRenderReconstructionHistory(scene as any, "History reset requested through the exact MCP profile lease.");
	options.editor.layout.inspector.forceUpdate();
	return { id: value.id, revision: value.revision, runtime: structuredClone(runtime) };
}
