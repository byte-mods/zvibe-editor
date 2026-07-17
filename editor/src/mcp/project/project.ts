import { pathExists, readdir } from "fs-extra";
import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";

import { Scene } from "babylonjs";

import { saveProjectConfiguration } from "../../project/save/save";
import { openInExternalEditor } from "../../tools/external-editor";
import { IMCPActionOptions } from "../action";

const editableKeys = [
	"plugins",
	"packageManager",
	"compressedTextureSoftware",
	"compressedTexturesEnabled",
	"compressedTexturesEnabledInPreview",
	"compressedEtc2Enabled",
	"compressedPvrtcEnabled",
	"compressedTextureQuality",
	"externalEditorCommand",
];

const supportedExternalEditorExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".json", ".css", ".html", ".md", ".glsl", ".wgsl", ".shader"]);

export function externalEditorCandidatePaths(platform = process.platform): { name: string; command: string }[] {
	if (platform === "darwin")
		return [
			{ name: "Visual Studio Code", command: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" },
			{ name: "Cursor", command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" },
			{ name: "Windsurf", command: "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" },
			{ name: "Sublime Text", command: "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" },
		];
	if (platform === "win32")
		return [
			{ name: "Visual Studio Code", command: "C:/Program Files/Microsoft VS Code/bin/code.cmd" },
			{ name: "Cursor", command: "C:/Program Files/Cursor/resources/app/bin/cursor.cmd" },
			{ name: "Sublime Text", command: "C:/Program Files/Sublime Text/subl.exe" },
		];
	return [
		{ name: "Visual Studio Code", command: "/usr/bin/code" },
		{ name: "Cursor", command: "/usr/bin/cursor" },
		{ name: "Sublime Text", command: "/usr/bin/subl" },
	];
}

/** Detects installed supported graphical source editors without launching any application. */
export async function listInstalledExternalEditors(_scene: Scene, _data: any): Promise<any> {
	const candidates = externalEditorCandidatePaths();
	const checks = await Promise.all(candidates.map(async (candidate) => ({ ...candidate, installed: await pathExists(candidate.command) })));
	return { editors: checks.filter((candidate) => candidate.installed).map(({ name, command }) => ({ name, command })), checked: checks };
}

export function getProjectPreferences(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	const state = options.editor.state;
	return Object.fromEntries(editableKeys.map((key) => [key, (state as any)[key]]));
}

export async function setProjectPreferences(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const update: any = {};
	for (const key of editableKeys) if (data.preferences?.[key] !== undefined) update[key] = data.preferences[key];
	await new Promise<void>((resolve) => options.editor.setState(update, () => resolve()));
	await saveProjectConfiguration(options.editor);
	return getProjectPreferences(_scene, data, options);
}

export async function listProjectTemplates(): Promise<any> {
	const root = join(__dirname, "../../../../templates");
	try {
		return { templates: (await readdir(root)).filter((entry) => !entry.startsWith(".")) };
	} catch {
		return { templates: ["nextjs", "nuxtjs", "solidjs", "vanillajs", "electron"] };
	}
}

/** Opens a project source file using the project's configured external editor. */
export async function openProjectFileInExternalEditor(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const projectPath = options.editor.state.projectPath;
	if (!projectPath) throw new Error("No project is currently open.");
	const directory = dirname(projectPath);
	const absolutePath = normalize(isAbsolute(data.path) ? data.path : join(directory, data.path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) throw new Error("External-editor paths must stay inside the open project directory.");
	if (!supportedExternalEditorExtensions.has(extname(absolutePath).toLowerCase())) {
		throw new Error(`Unsupported source-file extension "${extname(absolutePath)}". Configure a supported text/source file path.`);
	}
	if (!(await pathExists(absolutePath))) throw new Error(`Project file not found: ${data.path}`);

	const exitCode = await openInExternalEditor(options.editor.state.externalEditorCommand, absolutePath);
	if (exitCode !== 0) throw new Error(`External editor exited with code ${exitCode}. Check the configured command.`);
	return { opened: true, path: relative(directory, absolutePath), command: options.editor.state.externalEditorCommand };
}
