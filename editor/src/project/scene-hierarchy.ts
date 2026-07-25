import { Light, Node, Scene } from "babylonjs";

import { isEditorCamera } from "../tools/guards/nodes";

export interface ISceneHierarchyOwnershipReader {
	getOwner(object: object): string | null;
	getSettings(): { loadedScenes: string[]; activeScene: string | null };
}

/** Resolves UI ownership without mutating the workspace; new objects appear under the active scene. */
export function getEffectiveHierarchyOwner(workspace: ISceneHierarchyOwnershipReader, object: object): string | null {
	return workspace.getOwner(object) ?? workspace.getSettings().activeScene;
}

/** Returns direct Hierarchy roots for one authored scene without adding synthetic Babylon parents. */
export function getAuthoringSceneRootNodes(scene: Scene, workspace: ISceneHierarchyOwnershipReader, scenePath: string, additionalLights: Light[] = []): Node[] {
	const candidates: Node[] = [...scene.transformNodes, ...scene.meshes, ...scene.lights, ...scene.cameras, ...additionalLights];
	return [...new Set(candidates)].filter((node) => {
		if (isEditorCamera(node)) {
			return false;
		}
		if (getEffectiveHierarchyOwner(workspace, node) !== scenePath) {
			return false;
		}
		return !node.parent || getEffectiveHierarchyOwner(workspace, node.parent) !== scenePath;
	});
}

/** Produces a globally unique tree key while retaining authored local IDs in scene files. */
export function getSceneScopedHierarchyId(workspace: ISceneHierarchyOwnershipReader, object: object, localId: string | number): string {
	return `${getEffectiveHierarchyOwner(workspace, object) ?? "global"}::${localId}`;
}
