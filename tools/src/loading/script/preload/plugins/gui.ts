import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";

import { loadJsonFile } from "../../../../tools/request";
import { applyGUIAuthoringRuntime, createDefaultGUIAuthoringState, normalizeGUIAuthoringState } from "../../../gui-authoring";
import { createGUIPanelRendererTexture } from "../../../gui-panel-renderer";

import { IScriptAssetParserParameters, registerScriptAssetParser } from "../../preload";

export async function preloadFullScreenScriptAsset(parameters: IScriptAssetParserParameters) {
	const data = await loadJsonFile<any>(`${parameters.rootUrl}${parameters.key}`);

	let gui: AdvancedDynamicTexture | null = null;

	try {
		switch (data.guiType) {
			case "fullscreen":
			case "worldSpace": {
				const authoring = normalizeGUIAuthoringState(data.zvibeGUIAuthoring ?? createDefaultGUIAuthoringState());
				const created = createGUIPanelRendererTexture<AdvancedDynamicTexture>(parameters.scene, data.name, authoring.toolkit.panelRenderer);
				gui = created;
				created.parseSerializedObject(data.content, false);
				await applyGUIAuthoringRuntime(created, authoring, {
					rootUrl: parameters.rootUrl,
					scene: parameters.scene,
				});
				break;
			}
			default:
				throw new Error(`Unknown GUI type: ${data.guiType}`);
		}
	} catch (e) {
		console.error(`Failed to load GUI asset '${parameters.key}'. Make sure you imported all @babylonjs/gui modules required by this GUI asset.`);
		console.error(e);
	}

	return gui;
}

registerScriptAssetParser("gui", preloadFullScreenScriptAsset);
