import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { setProjectSettings } from "../project/project";
import {
	checkImportAcceleratorConnection,
	clearImportAcceleratorDiagnostics,
	getImportAcceleratorCapabilities,
	getImportAcceleratorConfiguration,
	getImportAcceleratorDiagnostics,
} from "./import-accelerator";

export function getImportAcceleratorCapabilitiesAction(_scene: Scene, _data: any): any {
	return getImportAcceleratorCapabilities();
}

export function getImportAcceleratorConfigurationAction(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return { projectRevision: options.editor.state.projectSettings.revision, ...getImportAcceleratorConfiguration() };
}

export async function setImportAcceleratorConfigurationAction(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await setProjectSettings(scene, { expectedRevision: data.expectedRevision, settings: { assetPipeline: { accelerator: data.configuration } } }, options);
	return getImportAcceleratorConfigurationAction(scene, data, options);
}

export async function checkImportAcceleratorConnectionAction(_scene: Scene, _data: any): Promise<any> {
	return checkImportAcceleratorConnection();
}

export async function getImportAcceleratorDiagnosticsAction(_scene: Scene, data: any): Promise<any> {
	return getImportAcceleratorDiagnostics(data);
}

export async function clearImportAcceleratorDiagnosticsAction(_scene: Scene, data: any): Promise<any> {
	return clearImportAcceleratorDiagnostics(data.expectedRevision, data.confirm);
}
