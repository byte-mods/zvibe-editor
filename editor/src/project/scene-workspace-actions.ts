import { dirname, join } from "path/posix";

import type { Editor } from "../editor/main";

import { AuthoredSceneLoader, loadAuthoringSceneAdditive, reloadAuthoringScene, setLightingAuthoringScene, unloadAuthoringScene } from "./load/workspace";
import { saveProjectConfiguration } from "./save/save";
import { saveScene } from "./save/scene";

const operationTails = new WeakMap<object, Promise<void>>();

/** Serializes editor and future MCP lifecycle mutations through one workspace command lane. */
export async function runSceneWorkspaceOperation<T>(editor: Editor, operation: () => Promise<T>): Promise<T> {
	const previous = operationTails.get(editor) ?? Promise.resolve();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const tail = previous.then(() => gate);
	operationTails.set(editor, tail);

	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (operationTails.get(editor) === tail) {
			operationTails.delete(editor);
		}
	}
}

export async function loadSceneIntoWorkspace(editor: Editor, path: string, makeActive = false, loader?: AuthoredSceneLoader): Promise<boolean> {
	return runSceneWorkspaceOperation(editor, async () => {
		const projectDirectory = getProjectDirectory(editor);
		const loaded = await loadAuthoringSceneAdditive(editor, projectDirectory, path, { makeActive }, loader);
		if (makeActive) {
			await synchronizeActiveScenePath(editor, projectDirectory);
		}
		await saveProjectConfiguration(editor);
		return loaded;
	});
}

export async function setActiveWorkspaceScene(editor: Editor, path: string): Promise<void> {
	return runSceneWorkspaceOperation(editor, async () => {
		const projectDirectory = getProjectDirectory(editor);
		editor.sceneWorkspace.setActiveScene(path);
		await synchronizeActiveScenePath(editor, projectDirectory);
		await saveProjectConfiguration(editor);
	});
}

export async function setLightingWorkspaceScene(editor: Editor, path: string): Promise<void> {
	return runSceneWorkspaceOperation(editor, async () => {
		await setLightingAuthoringScene(editor, path);
		await saveProjectConfiguration(editor);
	});
}

export async function saveWorkspaceScene(editor: Editor, path: string): Promise<void> {
	return runSceneWorkspaceOperation(editor, async () => {
		const projectDirectory = getProjectDirectory(editor);
		await saveScene(editor, projectDirectory, join(projectDirectory, path), { ownerScenePath: path });
		editor.sceneWorkspace.setDirty(path, false);
		await saveProjectConfiguration(editor);
	});
}

export async function unloadWorkspaceScene(editor: Editor, path: string): Promise<void> {
	return runSceneWorkspaceOperation(editor, async () => {
		const projectDirectory = getProjectDirectory(editor);
		await unloadAuthoringScene(editor, path);
		await synchronizeActiveScenePath(editor, projectDirectory);
		await saveProjectConfiguration(editor);
	});
}

export async function revertWorkspaceScene(editor: Editor, path: string, loader?: AuthoredSceneLoader): Promise<void> {
	return runSceneWorkspaceOperation(editor, async () => {
		const projectDirectory = getProjectDirectory(editor);
		await reloadAuthoringScene(editor, projectDirectory, path, loader);
		editor.sceneWorkspace.setDirty(path, false);
		await synchronizeActiveScenePath(editor, projectDirectory);
		await saveProjectConfiguration(editor);
	});
}

function getProjectDirectory(editor: Editor): string {
	if (!editor.state.projectPath) {
		throw new Error("No project is open.");
	}
	return dirname(editor.state.projectPath);
}

function synchronizeActiveScenePath(editor: Editor, projectDirectory: string): Promise<void> {
	const activeScene = editor.sceneWorkspace.getSettings().activeScene;
	const absolutePath = activeScene ? join(projectDirectory, activeScene) : null;
	return new Promise<void>((resolve) => editor.setState({ lastOpenedScenePath: absolutePath }, resolve));
}
