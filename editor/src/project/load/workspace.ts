import { join, relative } from "path/posix";

import type { Editor } from "../../editor/main";
import { IEditorSceneWorkspaceSettings } from "../typings";
import { loadSavedAssetsCache } from "../../tools/assets/cache";
import { updateAllLights } from "../../tools/light/shadows";
import { updateIblShadowsRenderPipeline } from "../../tools/light/ibl";

import { loadScene, SceneLoaderOptions } from "./scene";
import { disposeSceneLoadResult, getSceneLoadResultObjects, SceneLoadResult } from "./result";
import { applyLoadedSceneGlobalConfiguration } from "./configuration";

export type AuthoredSceneLoader = (editor: Editor, projectDirectory: string, scenePath: string, options?: SceneLoaderOptions) => ReturnType<typeof loadScene>;

/**
 * Loads authored scenes sequentially into the shared Babylon preview scene. Sequential loading
 * keeps resource deltas deterministic while the lighting scene alone supplies global settings.
 */
export async function loadSceneWorkspace(
	editor: Editor,
	projectDirectory: string,
	settings: IEditorSceneWorkspaceSettings,
	loadAuthoredScene: AuthoredSceneLoader = loadScene
): Promise<void> {
	try {
		for (const [index, path] of settings.loadedScenes.entries()) {
			const result = await loadAuthoredScene(editor, projectDirectory, join(projectDirectory, path), {
				applySceneConfiguration: path === settings.lightingScene,
				deferReady: index < settings.loadedScenes.length - 1,
			});
			attachLoadedSceneResult(editor, projectDirectory, path, result);
		}
	} catch (error) {
		// Configuring the same persisted workspace disposes every completed handle and clears claims.
		editor.sceneWorkspace.configure(settings);
		editor.layout.preview.setRenderScene(true);
		throw error;
	}
}

/** Replaces the preview with one independently owned scene for legacy reset-and-open entry points. */
export async function replaceWithSingleSceneWorkspace(
	editor: Editor,
	projectDirectory: string,
	scenePath: string,
	loadAuthoredScene: AuthoredSceneLoader = loadScene
): Promise<void> {
	const relativeScenePath = relative(projectDirectory, scenePath);
	const settings: IEditorSceneWorkspaceSettings = {
		version: 1,
		loadedScenes: [relativeScenePath],
		activeScene: relativeScenePath,
		lightingScene: relativeScenePath,
	};
	editor.sceneWorkspace.configure(settings);
	await editor.layout.preview.reset();
	await loadSceneWorkspace(editor, projectDirectory, settings, loadAuthoredScene);
}

/** Adds one authored scene to the existing preview without resetting already loaded content. */
export async function loadAuthoringSceneAdditive(
	editor: Editor,
	projectDirectory: string,
	scenePath: string,
	options?: { makeActive?: boolean },
	loadAuthoredScene: AuthoredSceneLoader = loadScene
): Promise<boolean> {
	const path = normalizeContainedScenePath(projectDirectory, scenePath);
	const previousSettings = editor.sceneWorkspace.getSettings();
	if (previousSettings.loadedScenes.includes(path)) {
		if (options?.makeActive) {
			editor.sceneWorkspace.setActiveScene(path);
		}
		return false;
	}

	editor.sceneWorkspace.addLoadedScene(path);
	try {
		const result = await loadAuthoredScene(editor, projectDirectory, join(projectDirectory, path), {
			applySceneConfiguration: false,
			deferReady: false,
		});
		attachLoadedSceneResult(editor, projectDirectory, path, result);
		if (options?.makeActive) {
			editor.sceneWorkspace.setActiveScene(path);
		}
		return true;
	} catch (error) {
		editor.sceneWorkspace.applySettings(previousSettings);
		editor.layout.preview.setRenderScene(true);
		throw error;
	}
}

/** Selects a loaded scene as the sole source of global lighting/render settings. */
export async function setLightingAuthoringScene(editor: Editor, path: string): Promise<void> {
	if (editor.sceneWorkspace.getSettings().lightingScene === path) {
		return;
	}
	await editor.sceneWorkspace.applyLoadedSceneLighting(path);
	editor.sceneWorkspace.setLightingScene(path);
	updateAllLights(editor.layout.preview.scene);
	updateIblShadowsRenderPipeline(editor.layout.preview.scene, true);
}

/** Disposes one authored scene and reapplies deterministic active/lighting fallbacks. */
export async function unloadAuthoringScene(editor: Editor, path: string, allowEmptyWorkspace = false): Promise<void> {
	const settings = editor.sceneWorkspace.getSettings();
	if (!settings.loadedScenes.includes(path)) {
		throw new Error(`Scene is not loaded for authoring: ${path}`);
	}
	if (!allowEmptyWorkspace && settings.loadedScenes.length === 1) {
		throw new Error("The last authored scene cannot be unloaded.");
	}

	const wasLightingScene = settings.lightingScene === path;
	editor.sceneWorkspace.removeLoadedScene(path);
	const fallbackLightingScene = editor.sceneWorkspace.getSettings().lightingScene;
	if (wasLightingScene && fallbackLightingScene) {
		await editor.sceneWorkspace.applyLoadedSceneLighting(fallbackLightingScene);
	}
	updateAllLights(editor.layout.preview.scene);
	updateIblShadowsRenderPipeline(editor.layout.preview.scene, true);
}

/** Discards one scene's in-memory state and reloads it at the same authored workspace position. */
export async function reloadAuthoringScene(editor: Editor, projectDirectory: string, path: string, loadAuthoredScene: AuthoredSceneLoader = loadScene): Promise<void> {
	const settings = editor.sceneWorkspace.getSettings();
	if (!settings.loadedScenes.includes(path)) {
		throw new Error(`Scene is not loaded for authoring: ${path}`);
	}

	editor.sceneWorkspace.removeLoadedScene(path);
	editor.sceneWorkspace.applySettings(settings);
	try {
		const result = await loadAuthoredScene(editor, projectDirectory, join(projectDirectory, path), {
			applySceneConfiguration: settings.lightingScene === path,
			deferReady: false,
		});
		attachLoadedSceneResult(editor, projectDirectory, path, result);
	} catch (error) {
		const loadedScenes = settings.loadedScenes.filter((candidate) => candidate !== path);
		const fallback = loadedScenes[0] ?? null;
		const fallbackSettings: IEditorSceneWorkspaceSettings = {
			version: 1,
			loadedScenes,
			activeScene: settings.activeScene === path ? fallback : settings.activeScene,
			lightingScene: settings.lightingScene === path ? ((settings.activeScene === path ? fallback : settings.activeScene) ?? fallback) : settings.lightingScene,
		};
		editor.sceneWorkspace.applySettings(fallbackSettings);
		if (fallbackSettings.lightingScene) {
			await editor.sceneWorkspace.applyLoadedSceneLighting(fallbackSettings.lightingScene);
		}
		editor.layout.preview.setRenderScene(true);
		throw error;
	}
}

function attachLoadedSceneResult(editor: Editor, projectDirectory: string, path: string, result: SceneLoadResult): void {
	const scene = editor.layout.preview.scene;
	editor.sceneWorkspace.claimObjects(path, getSceneLoadResultObjects(result));
	editor.sceneWorkspace.setLoadedSceneHandle(path, {
		get configuration(): unknown {
			return result.configuration;
		},
		set configuration(configuration: unknown) {
			result.configuration = configuration;
			if (editor.sceneWorkspace.getSettings().lightingScene === path) {
				result.environmentTexture = scene.environmentTexture;
				if (scene.environmentTexture && !result.textures.includes(scene.environmentTexture)) {
					result.textures.push(scene.environmentTexture);
					if (!editor.sceneWorkspace.getOwner(scene.environmentTexture)) {
						editor.sceneWorkspace.claimObjects(path, [scene.environmentTexture]);
					}
				}
			}
		},
		applyLighting: () => {
			const addedResources = applyLoadedSceneGlobalConfiguration(editor, projectDirectory, result, loadSavedAssetsCache());
			const unownedResources = addedResources.filter((resource) => !editor.sceneWorkspace.getOwner(resource));
			if (unownedResources.length) {
				editor.sceneWorkspace.claimObjects(path, unownedResources);
			}
		},
		dispose: () => disposeSceneLoadResult(scene, result),
	});
}

function normalizeContainedScenePath(projectDirectory: string, scenePath: string): string {
	const path = scenePath.startsWith(`${projectDirectory}/`) ? relative(projectDirectory, scenePath) : scenePath;
	if (!path || path === ".." || path.startsWith("../") || path.startsWith("/")) {
		throw new Error(`Scene path must be contained by the project: ${scenePath}`);
	}
	return path;
}
