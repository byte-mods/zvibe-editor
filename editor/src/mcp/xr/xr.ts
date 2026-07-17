import { Scene } from "babylonjs";
import { IMCPActionOptions } from "../action";

function config(scene: Scene): any {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorXR ??= { enabled: false, referenceSpaceType: "local-floor", floorMeshIds: [], features: [] });
}
export function getXRConfiguration(scene: Scene): any {
	return structuredClone(config(scene));
}
export function setXRConfiguration(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = config(scene);
	if (data.enabled !== undefined) value.enabled = data.enabled;
	if (data.referenceSpaceType !== undefined) value.referenceSpaceType = data.referenceSpaceType;
	if (data.floorMeshIds !== undefined) value.floorMeshIds = data.floorMeshIds;
	if (data.features !== undefined) value.features = data.features;
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
