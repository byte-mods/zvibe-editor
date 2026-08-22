import { createElement } from "react";

import type { Editor } from "../editor/main";

import { EditorInspector } from "../editor/layout/inspector";

import { EditorExtensionHost } from "./host";
import { EditorExtensionErrorBoundary } from "./error-boundary";
import type { IEditorExtensionTrustStorage, IInstalledEditorExtension } from "./types";

/** Connects the framework-neutral lifecycle host to live editor layout and inspector surfaces. */
export function createEditorExtensionHost(
	editor: Editor,
	reinspect: (packageName: string) => Promise<IInstalledEditorExtension | null>,
	trustStorage: IEditorExtensionTrustStorage = localStorage
): EditorExtensionHost {
	return new EditorExtensionHost({
		editor,
		trustStorage,
		reinspect,
		registerInspector: (registration) => EditorInspector.registerExtensionInspector(registration),
		openWindow: (contribution, registration) => {
			editor.layout.addLayoutTab(createElement(EditorExtensionErrorBoundary, { extensionId: contribution.id }, createElement(registration.component)), {
				id: contribution.id,
				title: contribution.title,
				neighborId: contribution.neighborId,
				enableClose: true,
				setAsActiveTab: true,
			});
		},
		closeWindow: (id) => editor.layout.removeLayoutTab(id),
		selectWindow: (id) => editor.layout.selectTab(id),
		updateMenus: (descriptors) => editor.setExtensionMenus(descriptors),
	});
}
