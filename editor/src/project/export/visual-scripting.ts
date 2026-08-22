import { Scene } from "babylonjs";
import { normalizeVisualScriptGraphs, validateVisualScriptGraphs } from "babylonjs-editor-tools";

/** Writes canonical, validated version-2 visual-script authoring into an exported runtime scene. */
export function configureVisualScriptingExportMetadata(data: any, scene: Scene): void {
	const graphs = normalizeVisualScriptGraphs(scene.metadata?.babylonEditorVisualScriptGraphs);
	validateVisualScriptGraphs(graphs);
	data.metadata ??= {};
	data.metadata.babylonEditorVisualScriptGraphs = structuredClone(graphs);
}
