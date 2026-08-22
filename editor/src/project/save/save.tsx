import { dirname, join, relative } from "path/posix";
import { ipcRenderer } from "electron";

import { toast } from "sonner";

import packageJson from "../../../package.json";

import { Editor } from "../../editor/main";

import { IEditorProject } from "../typings";
import { discoverProjectScenes, normalizeSceneBuildSettings } from "../scenes";
import { activateSceneInWorkspaceSettings } from "../scene-workspace";
import { normalizeProjectEditorExtensions } from "../../extensions/project";
import { writeSerializedJSON } from "../serialization-session";

// import { exportProject } from "../export/export";

import { projectsKey } from "../../tools/project";
import { onProjectSavedObservable } from "../../tools/observables";
import { getBase64SceneScreenshot } from "../../tools/scene/screenshot";
import { tryGetProjectsFromLocalStorage } from "../../tools/local-storage";

import { saveScene } from "./scene";
import { EditorSaveProjectProgressComponent } from "./progress";
import { getScenePathsToSave } from "./ownership";

let saving = false;

export async function saveProject(editor: Editor): Promise<void> {
	if (saving) {
		return;
	}
	try {
		await saveProjectForRestart(editor);
	} catch (e) {
		if (e instanceof Error) {
			editor.layout.console.error(`Error saving project:\n ${e.message}`);
			toast.error("Error saving project");
		}
	}
}

/** Saves with error propagation so a platform restart can be aborted safely on persistence failure. */
export async function saveProjectForRestart(editor: Editor): Promise<void> {
	if (saving) {
		throw new Error("A project save is already in progress. Wait for it to finish before restarting the editor.");
	}
	saving = true;
	try {
		await _saveProject(editor);
	} finally {
		saving = false;
		editor.layout.preview.setRenderScene(true);
	}
}

export async function saveProjectConfiguration(editor: Editor): Promise<Partial<IEditorProject>> {
	const projectDirectory = dirname(editor.state.projectPath!);
	const relativeActiveScene = editor.state.lastOpenedScenePath ? relative(projectDirectory, editor.state.lastOpenedScenePath) : null;
	const discoveredScenes = await discoverProjectScenes(projectDirectory);
	const sceneBuildSettings = normalizeSceneBuildSettings(editor.state.sceneBuildSettings, relativeActiveScene, discoveredScenes);
	const sceneWorkspace = activateSceneInWorkspaceSettings(editor.sceneWorkspace.getSettings(), relativeActiveScene, discoveredScenes);
	if (JSON.stringify(sceneWorkspace) !== JSON.stringify(editor.sceneWorkspace.getSettings())) {
		editor.sceneWorkspace.applySettings(sceneWorkspace);
	}
	if (
		sceneBuildSettings.scenes.length !== editor.state.sceneBuildSettings.scenes.length ||
		sceneBuildSettings.scenes.some(
			(entry, index) => entry.path !== editor.state.sceneBuildSettings.scenes[index]?.path || entry.enabled !== editor.state.sceneBuildSettings.scenes[index]?.enabled
		)
	) {
		editor.setState({ sceneBuildSettings });
	}

	const project: Partial<IEditorProject> = {
		plugins: editor.state.plugins.map((plugin) => ({
			nameOrPath: plugin,
		})),
		editorExtensions: normalizeProjectEditorExtensions(editor.state.editorExtensions),
		version: packageJson.version,
		packageManager: editor.state.packageManager,
		lastOpenedScene: sceneWorkspace.activeScene ? `/${sceneWorkspace.activeScene}` : null,
		sceneBuildSettings,
		sceneWorkspace,
		prefabStage: editor.state.prefabStage,

		compressedTextureSoftware: editor.state.compressedTextureSoftware,
		compressedTexturesEnabled: editor.state.compressedTexturesEnabled,
		compressedTexturesEnabledInPreview: editor.state.compressedTexturesEnabledInPreview,
		compressedEtc2Enabled: editor.state.compressedEtc2Enabled,
		compressedPvrtcEnabled: editor.state.compressedPvrtcEnabled,
		compressedTextureQuality: editor.state.compressedTextureQuality,
		externalEditorCommand: editor.state.externalEditorCommand,
		projectSettings: editor.state.projectSettings,
		scriptExecutionOrders: editor.state.scriptExecutionOrders,

		gizmoSnap: editor.layout.preview?.state.gizmoSnap,
	};

	if (!editor.props.editedScenePath) {
		await writeSerializedJSON(editor.state.projectPath!, project, {
			spaces: 4,
		});
	}

	return project;
}

async function _saveProject(editor: Editor) {
	if (!editor.state.projectPath) {
		return;
	}

	const toastId = toast(<EditorSaveProjectProgressComponent />, {
		duration: Infinity,
		dismissible: false,
	});

	const directory = dirname(editor.state.projectPath);
	await saveProjectConfiguration(editor);

	const loadedScenes = editor.sceneWorkspace.getLoadedSceneStates();
	for (const scenePath of getScenePathsToSave(loadedScenes)) {
		editor.layout.console.log(`Saving scene "${scenePath}"`);
		await saveScene(editor, directory, join(directory, scenePath), { ownerScenePath: scenePath });
		editor.sceneWorkspace.setDirty(scenePath, false);
		editor.layout.console.log(`Scene "${scenePath}" saved.`);
	}

	toast.dismiss(toastId);
	toast.success("Project saved");

	if (!editor.props.editedScenePath) {
		try {
			const base64 = await getBase64SceneScreenshot(editor.layout.preview.scene);

			const projects = tryGetProjectsFromLocalStorage();
			const project = projects.find((project) => project.absolutePath === editor.state.projectPath);
			if (project) {
				project.preview = base64;
				project.updatedAt = new Date();

				localStorage.setItem(projectsKey, JSON.stringify(projects));
				ipcRenderer.send("dashboard:update-projects");
			}
		} catch (e) {
			// Catch silently.
		}
	}

	try {
		onProjectSavedObservable.notifyObservers();
	} catch (e) {
		// Catch silently.
	}

	// exportProject(editor, {
	// 	optimize: false,
	// 	noProgress: true,
	// 	noDialog: false,
	// });
}
