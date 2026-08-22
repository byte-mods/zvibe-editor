import { Scene } from "babylonjs";
import { normalizeInputActionMaps, normalizeInputSystemSettings, validateInputActionMaps, validateInputSystemSettings } from "babylonjs-editor-tools";

/** Writes canonical versioned Input System authoring into an exported runtime scene. */
export function configureInputActionsExportMetadata(data: any, scene: Scene): void {
	const maps = normalizeInputActionMaps(scene.metadata?.babylonEditorInputActionMaps);
	const settings = normalizeInputSystemSettings(scene.metadata?.babylonEditorInputSystemSettings);
	validateInputActionMaps(maps);
	validateInputSystemSettings(settings);
	data.metadata ??= {};
	data.metadata.babylonEditorInputActionMaps = structuredClone(maps);
	data.metadata.babylonEditorInputSystemSettings = structuredClone(settings);
}
