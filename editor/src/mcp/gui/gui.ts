import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";
import { pathExists, readJSON, writeJSON } from "fs-extra";

import { Scene } from "babylonjs";
import { AdvancedDynamicTexture } from "babylonjs-gui";

import { applyImportedGuiFile } from "../../editor/layout/preview/import/gui";
import { projectConfiguration } from "../../project/configuration";
import { isAdvancedDynamicTexture } from "../../tools/guards/texture";

import { IMCPActionOptions } from "../action";

function getProjectDirectory(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return dirname(projectConfiguration.path);
}

function resolveProjectPath(path: string): string {
	const projectDirectory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(projectDirectory, path));
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) throw new Error("GUI paths must stay inside the open project directory.");
	return absolutePath;
}

function serializeGui(gui: AdvancedDynamicTexture): any {
	const data = gui.serialize();
	data.uniqueId = gui.uniqueId;
	data.content = gui.serializeContent();
	data.guiType = "fullscreen";
	return data;
}

function findGui(scene: Scene, data: any): AdvancedDynamicTexture {
	const gui = scene.textures.find((texture) => isAdvancedDynamicTexture(texture) && (texture.uniqueId.toString() === data.guiId || texture.name === data.guiName)) as
		| AdvancedDynamicTexture
		| undefined;
	if (!gui) throw new Error("Fullscreen GUI not found. Provide guiId (preferred) or guiName.");
	return gui;
}

function getControlType(control: any): string {
	return control.getClassName?.() ?? control.typeName ?? control.constructor?.name ?? "Control";
}

function getControlPath(control: any, parentPath: string, index: number): string {
	const name = typeof control.name === "string" && control.name.trim() ? control.name.trim() : `${getControlType(control)} #${index + 1}`;
	return parentPath ? `${parentPath} / ${name}` : name;
}

function parseColor(value: unknown): [number, number, number] | null {
	if (typeof value !== "string") return null;
	const hex = value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1];
	if (hex) {
		const expanded =
			hex.length === 3
				? hex
						.split("")
						.map((part) => `${part}${part}`)
						.join("")
				: hex;
		return [Number.parseInt(expanded.slice(0, 2), 16), Number.parseInt(expanded.slice(2, 4), 16), Number.parseInt(expanded.slice(4, 6), 16)];
	}
	const rgb = value.trim().match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
	if (!rgb) return null;
	const channels = rgb.slice(1).map(Number);
	return channels.every((channel) => channel >= 0 && channel <= 255) ? (channels as [number, number, number]) : null;
}

function getContrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
	const luminance = (color: [number, number, number]): number => {
		const channels = color.map((channel) => {
			const normalized = channel / 255;
			return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
	};
	const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
	return (lighter + 0.05) / (darker + 0.05);
}

/** Reports basic, deterministic GUI accessibility concerns without modifying controls. */
export function validateGUIAccessibility(scene: Scene, data: any): any {
	const guis = data.guiId || data.guiName ? [findGui(scene, data)] : scene.textures.filter((texture) => isAdvancedDynamicTexture(texture) && texture._isFullscreen);
	const issues: any[] = [];
	const names = new Map<string, string>();
	let controlCount = 0;

	const inspect = (control: any, parentPath: string, index: number, inheritedBackground: [number, number, number] | null): void => {
		controlCount++;
		const type = getControlType(control);
		const path = getControlPath(control, parentPath, index);
		const name = typeof control.name === "string" ? control.name.trim() : "";
		const text = typeof control.text === "string" ? control.text.trim() : "";
		const fontSize = typeof control.fontSize === "number" ? control.fontSize : Number.parseFloat(control.fontSize);
		const background = parseColor(control.background) ?? inheritedBackground;
		const foreground = parseColor(control.color);

		if (name) {
			const existing = names.get(name);
			if (existing)
				issues.push({ severity: "warning", code: "duplicateControlName", path, controlType: type, message: `Control name "${name}" is also used by ${existing}.` });
			else names.set(name, path);
		}
		if (Number.isFinite(fontSize) && fontSize > 0 && fontSize < 12) {
			issues.push({ severity: "warning", code: "smallText", path, controlType: type, message: `Font size ${fontSize}px is below the 12px readability threshold.` });
		}
		if (/(Button|Checkbox|RadioButton|Slider)/i.test(type) && !name && !text) {
			issues.push({
				severity: "warning",
				code: "unlabeledInteractiveControl",
				path,
				controlType: type,
				message: "Interactive control has neither a name nor visible text for an accessible label.",
			});
		}
		if (foreground && background) {
			const ratio = getContrastRatio(foreground, background);
			if (ratio < 4.5) {
				issues.push({
					severity: "warning",
					code: "lowTextContrast",
					path,
					controlType: type,
					contrastRatio: Number(ratio.toFixed(2)),
					message: `Foreground/background contrast is ${ratio.toFixed(2)}:1; normal text should reach 4.5:1.`,
				});
			}
		}
		(control.children ?? []).forEach((child: any, childIndex: number) => inspect(child, path, childIndex, background));
	};

	guis.forEach((gui: any) => (gui.rootContainer?.children ?? []).forEach((control: any, index: number) => inspect(control, gui.name || "GUI", index, null)));
	return {
		guiCount: guis.length,
		controlCount,
		warningCount: issues.length,
		issues,
	};
}

export function listGUIs(scene: Scene): any {
	return {
		guis: scene.textures
			.filter((texture) => isAdvancedDynamicTexture(texture) && texture._isFullscreen)
			.map((texture) => {
				const gui = texture as AdvancedDynamicTexture;
				return {
					id: gui.uniqueId.toString(),
					name: gui.name,
					size: { width: gui.getSize().width, height: gui.getSize().height },
					controlCount: gui.rootContainer.children.length,
				};
			}),
	};
}

export async function createGUIAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (extname(data.path).toLowerCase() !== ".gui") throw new Error("GUI asset paths must end in .gui.");
	const absolutePath = resolveProjectPath(data.path);
	if (await pathExists(absolutePath)) throw new Error(`An asset already exists at: ${data.path}`);

	const gui = AdvancedDynamicTexture.CreateFullscreenUI(data.name ?? "New GUI", true, scene);
	try {
		await writeJSON(absolutePath, serializeGui(gui), { spaces: "\t", encoding: "utf-8" });
	} finally {
		gui.dispose();
	}
	options.editor.layout.assets.refresh();
	return { created: true, path: relative(getProjectDirectory(), absolutePath) };
}

export async function instantiateGUIAsset(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (extname(absolutePath).toLowerCase() !== ".gui") throw new Error("Only .gui assets can be instantiated.");
	const gui = await applyImportedGuiFile(options.editor, absolutePath);
	if (!gui) throw new Error(`Unable to instantiate GUI asset: ${data.path}`);
	options.editor.layout.inspector.setEditedObject(gui);
	return { id: gui.uniqueId.toString(), name: gui.name, path: relative(getProjectDirectory(), absolutePath) };
}

export function getGUIContent(scene: Scene, data: any): any {
	const gui = findGui(scene, data);
	return { id: gui.uniqueId.toString(), name: gui.name, content: gui.serializeContent() };
}

export function setGUIContent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const gui = findGui(scene, data);
	if (data.name !== undefined) gui.name = data.name;
	if (data.content !== undefined) gui.parseSerializedObject(data.content, false);
	options.editor.layout.inspector.setEditedObject(gui);
	options.editor.layout.inspector.forceUpdate();
	return { id: gui.uniqueId.toString(), name: gui.name, controlCount: gui.rootContainer.children.length };
}

export async function saveGUIAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const gui = findGui(scene, data);
	if (extname(data.path).toLowerCase() !== ".gui") throw new Error("GUI asset paths must end in .gui.");
	const absolutePath = resolveProjectPath(data.path);
	if ((await pathExists(absolutePath)) && data.overwrite !== true) throw new Error(`GUI asset already exists at ${data.path}. Set overwrite: true to replace it.`);
	await writeJSON(absolutePath, serializeGui(gui), { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	return { saved: true, path: relative(getProjectDirectory(), absolutePath) };
}

export async function getGUIAsset(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveProjectPath(data.path);
	if (extname(absolutePath).toLowerCase() !== ".gui") throw new Error("GUI asset paths must end in .gui.");
	return readJSON(absolutePath, { encoding: "utf-8" });
}
