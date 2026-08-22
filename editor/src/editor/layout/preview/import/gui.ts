import { readJSON } from "fs-extra";

import { AdvancedDynamicTexture } from "babylonjs-gui";

import { applyGUIAuthoringRuntime, createDefaultGUIAuthoringState, createGUIPanelRendererTexture, normalizeGUIAuthoringState } from "babylonjs-editor-tools";

import { showAlert } from "../../../../ui/dialog";
import { installEditorGUIFontFamily, loadEditorGUIFontAsset } from "../../../../tools/gui/authoring";
import { configureEditorLocalization } from "../../../../mcp/localization/localization";

import { Editor } from "../../../main";

/**
 * Imports the GUI file located at the given absolute path and adds it to the scene.
 * @param editor defines the reference to the editor.
 * @param absolutePath defines the absolute path to the GUI file to import.
 * @param allowDuplicateUniqueId allows independently authored additive scenes to reuse local IDs.
 */
export async function applyImportedGuiFile(editor: Editor, absolutePath: string, allowDuplicateUniqueId = false) {
	const data = await readJSON(absolutePath, {
		encoding: "utf8",
	});

	const existingTexture = editor.layout.preview.scene.getTextureByUniqueId(data.uniqueId);
	if (existingTexture && !allowDuplicateUniqueId) {
		showAlert("Gui already exists", "A Gui already exists in the scene for this file.");
		return;
	}

	if (data.guiType === "fullscreen" || data.guiType === "worldSpace") {
		await configureEditorLocalization(editor.layout.preview.scene);
		const authoring = normalizeGUIAuthoringState(data.zvibeGUIAuthoring ?? createDefaultGUIAuthoringState());
		const gui = createGUIPanelRendererTexture<AdvancedDynamicTexture>(editor.layout.preview.scene, data.name, authoring.toolkit.panelRenderer);
		gui.parseSerializedObject(data.content, false);
		gui.uniqueId = data.uniqueId;
		await applyGUIAuthoringRuntime(gui, authoring, {
			rootUrl: "",
			scene: editor.layout.preview.scene,
			loadFontFamily: installEditorGUIFontFamily,
			loadFontAsset: loadEditorGUIFontAsset,
		});

		return gui;
	}
}
