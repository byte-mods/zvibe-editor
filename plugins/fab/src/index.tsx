import { ensureDir } from "fs-extra";
import { dirname, join } from "path/posix";

import { Editor, IEditorExtensionContext } from "babylonjs-editor";

import { FabRoot } from "./ui/root";

export const title = "Fab Plugin";
export const description = "Fab Plugin integration for Babylon.js Editor";

const legacyTabId = "babylonjs-editor-fab-plugin-tab";
const extensionWindowId = "babylon.editor.fab.window";
const extensionMenuId = "babylon.editor.fab.open";

let styles: HTMLLinkElement | null = null;

function addStyles(): void {
	if (styles?.isConnected) {
		return;
	}
	styles = document.createElement("link");
	styles.rel = "stylesheet";
	styles.href = `file://${__dirname}/index.css`;
	document.head.appendChild(styles);
}

function removeStyles(): void {
	styles?.remove();
	styles = null;
}

function ensureFabAssetsFolder(editor: Editor): Promise<void> {
	return editor.state.projectPath ? ensureDir(join(dirname(editor.state.projectPath), "assets/fab")) : Promise.resolve();
}

/** Versioned extension lifecycle used by Package Manager and external MCP automation. */
export async function activate(context: IEditorExtensionContext): Promise<() => void> {
	const editor = context.getEditor();
	await ensureFabAssetsFolder(editor);
	addStyles();
	context.windows.register({ id: extensionWindowId, component: () => <FabRoot editor={editor} /> });
	context.menus.register({ id: extensionMenuId, execute: () => context.windows.open(extensionWindowId) });
	context.windows.open(extensionWindowId);
	return removeStyles;
}

/** Cleans partial activation as well as normal host disposal. */
export function deactivate(): void {
	removeStyles();
}

/** Legacy plugin entry retained while existing project files migrate to zvibeEditor manifests. */
export function main(editor: Editor): void {
	if (!editor.state.projectPath) {
		return;
	}

	addStyles();
	void ensureFabAssetsFolder(editor);

	editor.layout.addLayoutTab(<FabRoot editor={editor} />, {
		id: legacyTabId,
		title: "Fab",
		enableClose: false,
	});
}

export function close(editor: Editor): void {
	deactivate();
	editor.layout.removeLayoutTab(legacyTabId);
}
