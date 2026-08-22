import { ipcRenderer } from "electron";

import { isAdvancedDynamicTexture } from "../../../../tools/guards/texture";
import { applyGUIAuthoringRuntime, createDefaultGUIAuthoringState } from "babylonjs-editor-tools";
import { installEditorGUIFontFamily } from "../../../../tools/gui/authoring";
import { configureEditorLocalization } from "../../../../mcp/localization/localization";

import { Editor } from "../../../main";

export function listenGuiAssetsEvents(editor: Editor) {
	ipcRenderer.on("editor:asset-updated", async (_, type, data) => {
		if (type !== "gui") {
			return;
		}

		const texture = editor.layout.preview.scene.getTextureByUniqueId(data.uniqueId);
		if (!texture) {
			return;
		}

		if (isAdvancedDynamicTexture(texture)) {
			try {
				await configureEditorLocalization(editor.layout.preview.scene);
				texture.rootContainer.clearControls();
				texture.parseSerializedObject(data.content, false);
				await applyGUIAuthoringRuntime(texture, data.zvibeGUIAuthoring ?? createDefaultGUIAuthoringState(), {
					rootUrl: "",
					scene: editor.layout.preview.scene,
					loadFontFamily: installEditorGUIFontFamily,
				});
				editor.layout.inspector.forceUpdate();
			} catch (error) {
				console.error(`Failed to reload GUI asset: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	});
}
