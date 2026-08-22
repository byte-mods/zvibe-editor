import { Observable } from "babylonjs";
import { dirname, join } from "path/posix";

import type { IEditorImportAcceleratorSettings } from "./typings";

export interface IProjectConfiguration {
	path: string | null;
	compressedTexturesEnabled: boolean;
	importAccelerator: IEditorImportAcceleratorSettings | null;
}

export const projectConfiguration: IProjectConfiguration = {
	path: null,
	compressedTexturesEnabled: false,
	importAccelerator: null,
};

export const onProjectConfigurationChangedObservable = new Observable<IProjectConfiguration>();

/**
 * Returns the rootUrl for assets for the current project.
 */
export function getProjectAssetsRootUrl() {
	return projectConfiguration.path ? join(dirname(projectConfiguration.path), "/") : null;
}
