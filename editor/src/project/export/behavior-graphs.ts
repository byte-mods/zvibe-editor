import { Scene } from "babylonjs";
import { normalizeBehaviorGraphs, validateBehaviorGraphs } from "babylonjs-editor-tools";

/** Writes canonical, validated version-2 Behavior Graph authoring into an exported runtime scene. */
export function configureBehaviorGraphExportMetadata(data: any, scene: Scene): void {
	const graphs = normalizeBehaviorGraphs(scene.metadata?.babylonEditorBehaviorTrees);
	validateBehaviorGraphs(graphs);
	data.metadata ??= {};
	data.metadata.babylonEditorBehaviorTrees = structuredClone(graphs);
}
