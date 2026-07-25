import { dirname, normalize } from "path/posix";

import { readJSON } from "fs-extra";

import { IEditorProject, IEditorSceneWorkspaceSettings } from "./typings";
import { discoverProjectScenes } from "./scenes";

export const maximumLoadedAuthoringScenes = 64;
const maximumPersistedWorkspaceEntries = 512;

/** Matches project scene discovery's canonical separator and leading-slash rules. */
function normalizeRelativeScenePath(path: string): string {
	return normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Migrates and bounds the persisted workspace against scenes that still exist.
 * Active and lighting scenes are inserted before truncation so neither can refer
 * to unloaded content after a project is moved or externally edited.
 */
export function normalizeSceneWorkspaceSettings(
	settings: IEditorSceneWorkspaceSettings | undefined,
	lastOpenedScene: string | null,
	discoveredScenePaths: string[]
): IEditorSceneWorkspaceSettings {
	const discovered = [...new Set(discoveredScenePaths.map(normalizeRelativeScenePath))];
	const discoveredSet = new Set(discovered);
	const normalizeCandidate = (path: unknown): string | null => {
		if (typeof path !== "string") {
			return null;
		}

		const normalized = normalizeRelativeScenePath(path);
		return discoveredSet.has(normalized) ? normalized : null;
	};

	const legacyActive = normalizeCandidate(lastOpenedScene);
	const configuredActive = settings?.version === 1 ? normalizeCandidate(settings.activeScene) : null;
	const configuredLighting = settings?.version === 1 ? normalizeCandidate(settings.lightingScene) : null;
	const preferredActive = configuredActive ?? legacyActive;
	const preferredLighting = configuredLighting ?? preferredActive;
	const candidates: string[] = [];
	const candidateSet = new Set<string>();
	const add = (path: unknown): void => {
		const normalized = normalizeCandidate(path);
		if (normalized && !candidateSet.has(normalized)) {
			candidateSet.add(normalized);
			candidates.push(normalized);
		}
	};

	if (settings?.version === 1 && Array.isArray(settings.loadedScenes)) {
		settings.loadedScenes.slice(0, maximumPersistedWorkspaceEntries).forEach(add);
	}
	add(preferredActive);
	add(preferredLighting);
	if (!candidates.length) {
		add(discovered[0]);
	}

	const required = new Set([preferredActive, preferredLighting].filter((path): path is string => path !== null));
	const retained = new Set(candidates.filter((path) => required.has(path)));
	for (const path of candidates) {
		if (retained.size >= maximumLoadedAuthoringScenes) {
			break;
		}
		retained.add(path);
	}
	// Filter in the authored order after choosing the bounded set.
	const loadedScenes = candidates.filter((path) => retained.has(path));

	const activeScene = preferredActive && loadedScenes.includes(preferredActive) ? preferredActive : (loadedScenes[0] ?? null);
	const lightingScene = preferredLighting && loadedScenes.includes(preferredLighting) ? preferredLighting : activeScene;

	return { version: 1, loadedScenes, activeScene, lightingScene };
}

/**
 * Bridges legacy single-scene callers until they use explicit additive actions.
 * Selecting a loaded scene changes only the authoring target; selecting any other
 * valid scene represents the historical reset-and-open workflow.
 */
export function activateSceneInWorkspaceSettings(
	settings: IEditorSceneWorkspaceSettings,
	activeScene: string | null,
	discoveredScenePaths: string[]
): IEditorSceneWorkspaceSettings {
	const normalizedActive = activeScene ? normalizeRelativeScenePath(activeScene) : null;
	const discovered = new Set(discoveredScenePaths.map(normalizeRelativeScenePath));
	if (!normalizedActive || !discovered.has(normalizedActive)) {
		return normalizeSceneWorkspaceSettings(settings, null, discoveredScenePaths);
	}
	if (settings.loadedScenes.map(normalizeRelativeScenePath).includes(normalizedActive)) {
		return normalizeSceneWorkspaceSettings({ ...settings, activeScene: normalizedActive }, normalizedActive, discoveredScenePaths);
	}

	return normalizeSceneWorkspaceSettings(
		{ version: 1, loadedScenes: [normalizedActive], activeScene: normalizedActive, lightingScene: normalizedActive },
		normalizedActive,
		discoveredScenePaths
	);
}

/** Reads and migrates a project's persisted additive authoring workspace. */
export async function readSceneWorkspaceSettings(projectPath: string, project?: IEditorProject): Promise<IEditorSceneWorkspaceSettings> {
	project ??= (await readJSON(projectPath, "utf-8")) as IEditorProject;
	return normalizeSceneWorkspaceSettings(project.sceneWorkspace, project.lastOpenedScene, await discoverProjectScenes(dirname(projectPath)));
}
