import { Scene } from "babylonjs";
import { normalizeMlTrainingConfiguration } from "babylonjs-editor-tools";

/** Writes canonical portable ML agent/training metadata into exported full and additive scenes. */
export function configureMlTrainingExportMetadata(data: any, scene: Scene): void {
	data.metadata ??= {};
	data.metadata.babylonEditorMlTraining = structuredClone(normalizeMlTrainingConfiguration(scene.metadata?.babylonEditorMlTraining));
}
