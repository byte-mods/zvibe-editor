import { dirname, isAbsolute, join, normalize, relative } from "path/posix";

import { pathExists } from "fs-extra";
import { Scene } from "babylonjs";

import { closePrefabMode, openPrefabMode, type IOpenPrefabModeOptions } from "../../editor/layout/assets-browser/viewers/prefab-mode";
import { IMCPActionOptions } from "../action";
import { inspectPrefabInstanceLinks } from "./prefabs";
import { getPrefabStageSettingsForEditor, replacePrefabStageSettingsForEditor } from "./stage-settings";

function projectDirectory(options: IMCPActionOptions): string {
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectPath);
}

function resolvePrefabStagePath(path: unknown, options: IMCPActionOptions): { absolutePath: string; path: string } {
	if (typeof path !== "string" || !path.trim()) {
		throw new Error("Prefab Stage requires a project-relative .prefab path.");
	}
	const directory = projectDirectory(options);
	const absolutePath = normalize(isAbsolute(path) ? path : join(directory, path));
	if ((absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) || !absolutePath.toLowerCase().endsWith(".prefab")) {
		throw new Error("Prefab Stage paths must identify a .prefab asset inside the open project.");
	}
	return { absolutePath, path: relative(directory, absolutePath).replace(/\\/g, "/") };
}

/** Reads the complete normalized Prefab Stage settings and exact mutation lease. */
export function getPrefabStageSettings(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return getPrefabStageSettingsForEditor(options.editor);
}

/** Replaces the complete Prefab Stage settings document under an exact fingerprint lease. */
export async function setPrefabStageSettings(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	return replacePrefabStageSettingsForEditor(options.editor, data.expectedFingerprint, data.settings);
}

/** Opens the shared Prefab Stage for an asset or an exact live instance boundary. */
export async function openPrefabStage(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const resolved = resolvePrefabStagePath(data.path, options);
	if (!(await pathExists(resolved.absolutePath))) {
		throw new Error(`Prefab asset not found: ${resolved.path}`);
	}
	const hasNodeId = typeof data.nodeId === "string" && !!data.nodeId;
	const hasNodeName = typeof data.nodeName === "string" && !!data.nodeName;
	if (hasNodeId && hasNodeName) {
		throw new Error("Provide nodeId or nodeName, not both, when opening Prefab Stage.");
	}
	if (data.targetIndex !== undefined && !hasNodeId && !hasNodeName) {
		throw new Error("targetIndex requires a live prefab nodeId or nodeName.");
	}
	if (data.mode === "context" && !hasNodeId && !hasNodeName) {
		throw new Error("Context Prefab Stage requires a live prefab nodeId or nodeName.");
	}
	let instance: IOpenPrefabModeOptions["instance"];
	if (hasNodeId || hasNodeName) {
		const links = await inspectPrefabInstanceLinks(scene, { nodeId: data.nodeId, nodeName: data.nodeName });
		const targetIndex = data.targetIndex ?? 0;
		const target = links.links[targetIndex];
		if (!target) {
			throw new Error(`Prefab source boundary ${targetIndex} is not available on the selected live instance.`);
		}
		if (target.path !== resolved.path) {
			throw new Error(`The selected live boundary references ${target.path}, not ${resolved.path}.`);
		}
		instance = { nodeId: links.nodeId, targetIndex };
	}
	const mode = instance ? (data.mode ?? options.editor.state.prefabStage.mode) : "isolation";
	openPrefabMode(options.editor, resolved.absolutePath, { instance, mode });
	return { opened: true, path: resolved.path, mode, instance: instance ?? null };
}

/** Closes the active shared Prefab Stage without mutating its asset. */
export function closePrefabStage(_scene: Scene, _data: any, _options: IMCPActionOptions): any {
	return { closed: closePrefabMode() };
}
