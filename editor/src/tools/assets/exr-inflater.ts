import { ExrLoaderGlobalConfiguration, Tools } from "babylonjs";
import * as fflate from "fflate";

let installed = false;

/** Installs the bundled ZIP inflater used by Babylon's EXR loader without loading remote scripts. */
export function installBundledExrInflater(): void {
	if (installed) {
		return;
	}

	installed = true;
	(globalThis as typeof globalThis & { fflate?: typeof fflate }).fflate = fflate;
	const originalLoadScriptAsync = Tools.LoadScriptAsync.bind(Tools);
	Tools.LoadScriptAsync = async (url: string, id?: string): Promise<void> => {
		if (url === ExrLoaderGlobalConfiguration.FFLATEUrl) {
			return;
		}
		return originalLoadScriptAsync(url, id);
	};
}
