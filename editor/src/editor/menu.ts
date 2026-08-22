import { platform } from "os";
import { BrowserWindow, Menu, MenuItem, MenuItemConstructorOptions, shell } from "electron";

import { cameraCommandItems, lightCommandItems, meshCommandItems, nodeCommandItems, spriteCommandItems } from "./dialogs/command-palette/shared-commands";
import type { IEditorExtensionMenuDescriptor } from "../extensions/types";

/** Serializable renderer-owned state used to rebuild the focused editor window's menu. */
export interface ISetupEditorMenuOptions {
	enableExperimentalFeatures: boolean;
	openedTabs?: string[];
	extensionMenus?: IEditorExtensionMenuDescriptor[];
}

interface IExtensionMenuTreeNode {
	commandId?: string;
	children: Map<string, IExtensionMenuTreeNode>;
}

const extensionContributionIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function validExtensionMenuDescriptor(value: unknown): value is IEditorExtensionMenuDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const descriptor = value as Partial<IEditorExtensionMenuDescriptor>;
	if (
		typeof descriptor.id !== "string" ||
		descriptor.id.length > 160 ||
		!extensionContributionIdPattern.test(descriptor.id) ||
		typeof descriptor.path !== "string" ||
		descriptor.path.length > 196
	) {
		return false;
	}
	const segments = descriptor.path.split("/");
	return (
		segments.length >= 1 &&
		segments.length <= 4 &&
		descriptor.path === segments.map((segment) => segment.trim()).join("/") &&
		segments.every((segment) => {
			const trimmed = segment.trim();
			return trimmed.length >= 1 && trimmed.length <= 48 && ![...trimmed].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
		})
	);
}

function buildExtensionMenuItems(values: unknown): MenuItemConstructorOptions[] {
	if (!Array.isArray(values) || values.length > 512 || !values.every(validExtensionMenuDescriptor)) {
		return [];
	}
	const descriptors = [...values].sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
	if (
		new Set(descriptors.map((descriptor) => descriptor.id)).size !== descriptors.length ||
		new Set(descriptors.map((descriptor) => descriptor.path)).size !== descriptors.length
	) {
		return [];
	}
	const root: IExtensionMenuTreeNode = { children: new Map() };
	for (const descriptor of descriptors) {
		let node = root;
		for (const segment of descriptor.path.split("/").map((entry) => entry.trim())) {
			let child = node.children.get(segment);
			if (!child) {
				child = { children: new Map() };
				node.children.set(segment, child);
			}
			node = child;
		}
		node.commandId = descriptor.id;
	}
	const children = (node: IExtensionMenuTreeNode): MenuItemConstructorOptions[] =>
		[...node.children.entries()].map(([label, child]) => {
			const nested = children(child);
			if (nested.length) {
				return {
					label,
					submenu: [
						...(child.commandId
							? [{ label: "Run", click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:extension-command", child.commandId) }]
							: []),
						...nested,
					],
				};
			}
			return { label, click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:extension-command", child.commandId) };
		});
	return children(root);
}

/** Rebuilds the native menu from built-ins plus validated declarative extension commands. */
export function setupEditorMenu(options: ISetupEditorMenuOptions): void {
	const extensionMenuItems = buildExtensionMenuItems(options?.extensionMenus);
	const openedTabs =
		Array.isArray(options?.openedTabs) && options.openedTabs.length <= 128 && options.openedTabs.every((tab) => typeof tab === "string" && tab.length <= 160)
			? options.openedTabs
			: [];
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: "Zvibe Editor",
				submenu: [
					{
						label: "About Zvibe Editor",
						role: "about",
					},
					{
						type: "separator",
					},
					{
						label: "Preferences...",
						accelerator: "Command+,",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:edit-preferences"),
					},
					{
						type: "separator",
					},
					{
						label: "Exit Zvibe Editor",
						accelerator: "CommandOrControl+Q",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:quit-app"),
					},
				],
			},
			{
				label: "File",
				submenu: [
					{
						label: "Open Project...",
						accelerator: "CommandOrControl+O",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:open-project"),
					},
					{
						type: "separator",
					},
					{
						label: "Save",
						accelerator: "CommandOrControl+S",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("save"),
					},
					{
						type: "separator",
					},
					{
						label: "Scene Manager...",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:scene-manager"),
					},
					{
						label: "Export Scene as FBX...",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:export-scene-fbx"),
					},
					{
						type: "separator",
					},
					{
						label: "Generate Current Scene",
						accelerator: "CommandOrControl+G",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("generate"),
					},
					{
						label: "Generate All Scenes and Assets...",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:generate-project"),
					},
					{
						type: "separator",
					},
					{
						label: "Open in Visual Studio Code",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:open-vscode"),
					},
					{
						type: "separator",
					},
					{
						label: "Run Project...",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:run-project"),
					},
				],
			},
			{
				label: "Edit",
				submenu: [
					{
						label: "Undo",
						accelerator: "CommandOrControl+Z",
						click: () => {
							// BrowserWindow.getFocusedWindow()?.webContents.undo();
							BrowserWindow.getFocusedWindow()?.webContents.send("undo");
						},
					},
					{
						label: "Redo",
						accelerator: platform() === "darwin" ? "CommandOrControl+Shift+Z" : "Control+Y",
						click: () => {
							// BrowserWindow.getFocusedWindow()?.webContents.redo();
							BrowserWindow.getFocusedWindow()?.webContents.send("redo");
						},
					},
					{
						type: "separator",
					},
					{
						label: "Select All",
						accelerator: "CommandOrControl+A",
						role: "selectAll",
					},
					{
						type: "separator",
					},
					{
						role: "copy",
						label: "Copy",
						accelerator: "CommandOrControl+C",
					},
					{
						role: "paste",
						label: "Paste",
						accelerator: "CommandOrControl+V",
					},
					{
						type: "separator",
					},
					{
						label: "Project Settings...",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:edit-project"),
					},
				],
			},
			{
				label: "Preview",
				submenu: [
					{
						label: "Position",
						accelerator: "CommandOrControl+T",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("gizmo:position"),
					},
					{
						label: "Rotation",
						accelerator: "CommandOrControl+R",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("gizmo:rotation"),
					},
					{
						label: "Scaling",
						accelerator: "CommandOrControl+D",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("gizmo:scaling"),
					},
					{
						type: "separator",
					},
					{
						label: "Focus Selected Object",
						accelerator: "CommandOrControl+F",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:focus"),
					},
					{
						type: "separator",
					},
					{
						label: "Edit Camera",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:edit-camera"),
					},
					{
						type: "separator",
					},
					{
						label: "Screenshot",
						submenu: [
							{
								type: "header",
								label: "Landscape",
							},
							{
								label: "720p (1280x720)",
								click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:screenshot", { width: 1280, height: 720 }),
							},
							{
								label: "1080p (1920x1080)",
								click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:screenshot", { width: 1920, height: 1080 }),
							},
							{
								label: "4K (3840x2160)",
								click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:screenshot", { width: 3840, height: 2160 }),
							},
							{
								type: "header",
								label: "Square",
							},
							{
								label: "512x512",
								click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:screenshot", { width: 512, height: 512 }),
							},
							{
								label: "1024x1024",
								click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:screenshot", { width: 1024, height: 1024 }),
							},
							{
								label: "2048x2048",
								click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:screenshot", { width: 2048, height: 2048 }),
							},
							{
								label: "4096x4096",
								click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:screenshot", { width: 4096, height: 4096 }),
							},
						],
					},
					{
						type: "separator",
					},
					{
						label: "Play Scene",
						accelerator: "CommandOrControl+B",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("preview:play-scene"),
					},
				],
			},
			{
				label: "Add",
				submenu: [
					...Object.values(nodeCommandItems).map((command) => ({
						label: command.text,
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send(`add:${command.ipcRendererChannelKey}`),
					})),
					{
						type: "separator",
					},
					...Object.values(meshCommandItems).map((command) => ({
						label: command.text,
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send(`add:${command.ipcRendererChannelKey}`),
					})),
					{
						type: "separator",
					},
					...Object.values(lightCommandItems).map((command) => ({
						label: command.text,
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send(`add:${command.ipcRendererChannelKey}`),
					})),
					{
						type: "separator",
					},
					...Object.values(cameraCommandItems).map((command) => ({
						label: command.text,
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send(`add:${command.ipcRendererChannelKey}`),
					})),
					{
						type: "separator",
					},
					...Object.values(spriteCommandItems).map((command) => ({
						label: command.text,
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send(`add:${command.ipcRendererChannelKey}`),
					})),
				],
			},
			{
				label: "Views",
				submenu: [
					{
						label: "Marketplace",
						type: "checkbox" as MenuItem["type"],
						checked: openedTabs.includes("marketplace"),
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:toggle-marketplace"),
					},
				],
			},
			...(extensionMenuItems.length
				? [
						{
							label: "Extensions",
							submenu: extensionMenuItems,
						},
					]
				: []),
			{
				label: "Window",
				submenu: [
					{
						label: "Minimize",
						accelerator: "Command+M",
						click: () => BrowserWindow.getFocusedWindow()?.minimize(),
					},
					{
						label: "Close",
						accelerator: "Command+W",
						click: () => BrowserWindow.getFocusedWindow()?.webContents.send("editor:close-window"),
					},
				],
			},
			{
				label: "Help",
				submenu: [
					{
						label: "Editor Documentation...",
						click: () => shell.openExternal("https://editor.babylonjs.com/documentation"),
					},
					{
						label: "Engine Documentation...",
						click: () => shell.openExternal("https://doc.babylonjs.com"),
					},
					{
						type: "separator",
					},
					{
						label: "Community Forum...",
						click: () => shell.openExternal("https://forum.babylonjs.com"),
					},
					{
						type: "separator",
					},
					{
						label: "Report an Issue...",
						click: () => shell.openExternal("https://forum.babylonjs.com/c/bugs"),
					},
				],
			},
		])
	);
}
