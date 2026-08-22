import { Scene } from "babylonjs";
import { normalizeTouchControlsConfiguration, validateTouchControlsConfiguration } from "babylonjs-editor-tools";

/** Writes canonical runtime Touch Controls and removes editor-only deployment credentials references. */
export function configureTouchControlsExportMetadata(data: any, scene: Scene): void {
	const configuration = normalizeTouchControlsConfiguration(scene.metadata?.babylonEditorTouchControls);
	validateTouchControlsConfiguration(configuration);
	data.metadata ??= {};
	data.metadata.babylonEditorTouchControls = structuredClone(configuration);
	delete data.metadata.babylonEditorMobileDeployment;
}
