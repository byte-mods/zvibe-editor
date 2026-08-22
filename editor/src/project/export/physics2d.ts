import { Scene } from "babylonjs";
import { normalizePhysics2DEffectorConfigurations, normalizePhysics2DJointConfigurations, normalizePhysics2DSettingsConfiguration } from "babylonjs-editor-tools";

/** Produces only validated, detached Physics 2D metadata for generated games. */
export function configurePhysics2DExportMetadata(data: any, scene: Scene): void {
	const joints = normalizePhysics2DJointConfigurations(scene.metadata?.babylonEditorPhysics2DJoints ?? []);
	if (!joints.ok) {
		throw new Error(`Cannot export invalid ${joints.error}`);
	}
	const effectors = normalizePhysics2DEffectorConfigurations(scene.metadata?.babylonEditorPhysics2DEffectors ?? []);
	if (!effectors.ok) {
		throw new Error(`Cannot export invalid ${effectors.error}`);
	}
	const settings = normalizePhysics2DSettingsConfiguration(scene.metadata?.babylonEditorPhysics2DSettings);
	if (!settings.ok) {
		throw new Error(`Cannot export invalid ${settings.error}`);
	}

	// Validate every collection before assigning any of them, keeping failed exports side-effect free.
	data.metadata ??= {};
	data.metadata.babylonEditorPhysics2DJoints = joints.value;
	data.metadata.babylonEditorPhysics2DEffectors = effectors.value;
	data.metadata.babylonEditorPhysics2DSettings = settings.value;
}
