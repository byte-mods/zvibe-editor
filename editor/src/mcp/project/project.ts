import { pathExists, readdir } from "fs-extra";
import { dirname, extname, isAbsolute, join, normalize, relative } from "path/posix";

import { Scene } from "babylonjs";

import { saveProjectConfiguration } from "../../project/save/save";
import { projectConfiguration } from "../../project/configuration";
import { createDefaultProjectSettings, normalizeProjectSettings, resolveProjectSettingsForTarget, updateProjectSettings } from "../../project/settings";
import { openInExternalEditor } from "../../tools/external-editor";
import { createDefaultEditorUserPreferences, updateEditorUserPreferences } from "../../editor/preferences";
import { getAutoReimportSettings, setAutoReimportSettings } from "../assets/auto-reimport";
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

const supportedExternalEditorExtensions = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".json",
	".css",
	".html",
	".md",
	".txt",
	".xml",
	".yaml",
	".yml",
	".glsl",
	".wgsl",
	".shader",
	".compute",
	".vert",
	".frag",
	".uxml",
	".uss",
]);

export function externalEditorCandidatePaths(platform = process.platform): { name: string; command: string }[] {
	if (platform === "darwin") {
		return [
			{ name: "Visual Studio Code", command: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" },
			{ name: "Cursor", command: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" },
			{ name: "Windsurf", command: "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" },
			{ name: "Sublime Text", command: "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" },
			{ name: "JetBrains Rider", command: "/Applications/Rider.app/Contents/MacOS/rider" },
			{ name: "Zed", command: "/Applications/Zed.app/Contents/MacOS/cli" },
		];
	}
	if (platform === "win32") {
		return [
			{ name: "Visual Studio Code", command: "C:/Program Files/Microsoft VS Code/bin/code.cmd" },
			{ name: "Cursor", command: "C:/Program Files/Cursor/resources/app/bin/cursor.cmd" },
			{ name: "Sublime Text", command: "C:/Program Files/Sublime Text/subl.exe" },
		];
	}
	return [
		{ name: "Visual Studio Code", command: "/usr/bin/code" },
		{ name: "Cursor", command: "/usr/bin/cursor" },
		{ name: "Sublime Text", command: "/usr/bin/subl" },
		{ name: "JetBrains Rider", command: "/usr/bin/rider" },
		{ name: "Zed", command: "/usr/bin/zed" },
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
	const preferences = data.preferences;
	if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
		throw new Error("preferences must be an object.");
	}
	const unknown = Object.keys(preferences).filter((key) => !editableKeys.includes(key));
	if (unknown.length) {
		throw new Error(`Unsupported project preference keys: ${unknown.join(", ")}.`);
	}
	for (const key of editableKeys) {
		if (preferences[key] !== undefined) {
			update[key] = validateLegacyProjectPreference(key, preferences[key]);
		}
	}
	if (!Object.keys(update).length) {
		throw new Error("At least one project preference is required.");
	}
	await new Promise<void>((resolve) => options.editor.setState(update, () => resolve()));
	await saveProjectConfiguration(options.editor);
	return getProjectPreferences(_scene, data, options);
}

function validateLegacyProjectPreference(key: string, value: any): any {
	if (key === "plugins") {
		if (!Array.isArray(value) || value.length > 128 || value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 1024)) {
			throw new Error("plugins must contain at most 128 non-empty strings.");
		}
		return [...value];
	}
	if (key === "packageManager" && !["npm", "yarn", "pnpm", "bun"].includes(value)) {
		throw new Error("Unsupported packageManager.");
	}
	if (key === "compressedTextureSoftware" && !["PVRTexTool", "Khronos KTX-Software"].includes(value)) {
		throw new Error("Unsupported compressedTextureSoftware.");
	}
	if (key === "compressedTextureQuality" && !["very-fast", "fast", "normal", "high"].includes(value)) {
		throw new Error("Unsupported compressedTextureQuality.");
	}
	if (["compressedTexturesEnabled", "compressedTexturesEnabledInPreview", "compressedEtc2Enabled", "compressedPvrtcEnabled"].includes(key) && typeof value !== "boolean") {
		throw new Error(`${key} must be boolean.`);
	}
	if (key === "externalEditorCommand" && (typeof value !== "string" || !value.trim() || value.length > 1024)) {
		throw new Error("externalEditorCommand must be a non-empty bounded string.");
	}
	return value;
}

function projectSettingsResult(options: IMCPActionOptions): any {
	const settings = normalizeProjectSettings(options.editor.state.projectSettings);
	return {
		settings: structuredClone(settings),
		resolvedPlatforms: Object.fromEntries(
			(["web", "electron", "headless", "android", "ios"] as const).map((target) => [target, resolveProjectSettingsForTarget(settings, target)])
		),
		appliedLive: [
			"rendering.maximumDevicePixelRatio",
			"assetPipeline.autoRefresh",
			"assetPipeline.autoRefreshOnFocus",
			"assetPipeline.directoryMonitoring",
			"playMode.muteAudio",
		],
		restartRequired: ["rendering.renderingBackend", "rendering.preserveDrawingBuffer", "runtime.deterministicLockstep", "runtime.lockstepMaxSteps"],
		integrations: { buildProfiles: true, autoReimport: true, importerPresets: true, textSourceSerialization: true },
	};
}

function synchronizeProjectConfiguration(options: IMCPActionOptions): void {
	projectConfiguration.importAccelerator = structuredClone(options.editor.state.projectSettings.assetPipeline.accelerator);
}

function applyLiveProjectSettings(scene: Scene, options: IMCPActionOptions): void {
	const settings = options.editor.state.projectSettings;
	const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
	scene.getEngine().setHardwareScalingLevel(Math.max(1, devicePixelRatio / settings.rendering.maximumDevicePixelRatio));
	scene.getEngine().resize();
}

async function applyAssetPipelineSettings(options: IMCPActionOptions): Promise<void> {
	if (!projectConfiguration.path || !options.editor.layout?.assets) {
		return;
	}
	const policy = options.editor.state.projectSettings.assetPipeline;
	const current = await getAutoReimportSettings();
	if (current.settings.enabled !== policy.autoRefresh || current.settings.watchImportedSources !== policy.directoryMonitoring) {
		await setAutoReimportSettings(current.fingerprint, {
			...current.settings,
			enabled: policy.autoRefresh,
			watchImportedSources: policy.directoryMonitoring,
		});
	}
	await options.editor.layout.assets.configureProjectAssetWatching(policy.directoryMonitoring);
	await options.editor.layout.assets.refreshAutoReimportWatchers();
}

function assetPipelineRuntimePolicyChanged(previous: any, current: any): boolean {
	return previous.autoRefresh !== current.autoRefresh || previous.directoryMonitoring !== current.directoryMonitoring;
}

/** Reads the complete normalized project/player settings contract and target resolutions. */
export function getProjectSettings(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return projectSettingsResult(options);
}

/** Applies one strict nested project/player patch under an exact revision and persists it. */
export async function setProjectSettings(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const current = normalizeProjectSettings(options.editor.state.projectSettings);
	const settings = updateProjectSettings(current, data.expectedRevision, data.settings);
	const reconfigureAssetPipeline = assetPipelineRuntimePolicyChanged(current.assetPipeline, settings.assetPipeline);
	await new Promise<void>((resolve) => options.editor.setState({ projectSettings: settings }, () => resolve()));
	synchronizeProjectConfiguration(options);
	applyLiveProjectSettings(scene, options);
	if (reconfigureAssetPipeline) {
		await applyAssetPipelineSettings(options);
	}
	await saveProjectConfiguration(options.editor);
	return projectSettingsResult(options);
}

/** Restores current defaults under an exact revision without touching unrelated project state. */
export async function resetProjectSettings(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("reset_project_settings requires confirm=true.");
	}
	const current = normalizeProjectSettings(options.editor.state.projectSettings);
	if (current.revision !== data.expectedRevision) {
		throw new Error(`Stale Project Settings revision ${data.expectedRevision}; current revision is ${current.revision}.`);
	}
	const settings = { ...createDefaultProjectSettings(current.identity.productName), revision: current.revision + 1 };
	const reconfigureAssetPipeline = assetPipelineRuntimePolicyChanged(current.assetPipeline, settings.assetPipeline);
	await new Promise<void>((resolve) => options.editor.setState({ projectSettings: settings }, () => resolve()));
	synchronizeProjectConfiguration(options);
	applyLiveProjectSettings(scene, options);
	if (reconfigureAssetPipeline) {
		await applyAssetPipelineSettings(options);
	}
	await saveProjectConfiguration(options.editor);
	return projectSettingsResult(options);
}

/** Reads global editor preferences separately from project-owned player settings. */
export function getEditorPreferences(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return {
		preferences: structuredClone(options.editor.state.editorUserPreferences),
		scope: "user",
		persisted: true,
		appliedLive: ["appearance.theme", "appearance.uiScale", "workflow.autoSave", "workflow.autoSaveIntervalMinutes", "diagnostics.logLevel"],
	};
}

/** Applies global appearance/workflow/external-tool preferences under an exact revision. */
export async function setEditorPreferences(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const preferences = updateEditorUserPreferences(options.editor.state.editorUserPreferences, data.expectedRevision, data.preferences);
	await options.editor.setEditorUserPreferences(preferences);
	return getEditorPreferences(_scene, data, options);
}

/** Restores global editor defaults under an exact revision. */
export async function resetEditorPreferences(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("reset_editor_preferences requires confirm=true.");
	}
	const current = options.editor.state.editorUserPreferences;
	if (current.revision !== data.expectedRevision) {
		throw new Error(`Stale Editor Preferences revision ${data.expectedRevision}; current revision is ${current.revision}.`);
	}
	const preferences = { ...createDefaultEditorUserPreferences(), revision: current.revision + 1 };
	await options.editor.setEditorUserPreferences(preferences);
	return getEditorPreferences(_scene, data, options);
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
	if (!projectPath) {
		throw new Error("No project is currently open.");
	}
	const directory = dirname(projectPath);
	const absolutePath = normalize(isAbsolute(data.path) ? data.path : join(directory, data.path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) {
		throw new Error("External-editor paths must stay inside the open project directory.");
	}
	if (!supportedExternalEditorExtensions.has(extname(absolutePath).toLowerCase())) {
		throw new Error(`Unsupported source-file extension "${extname(absolutePath)}". Configure a supported text/source file path.`);
	}
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Project file not found: ${data.path}`);
	}

	const exitCode = await openInExternalEditor(options.editor.state.externalEditorCommand, absolutePath);
	if (exitCode !== 0) {
		throw new Error(`External editor exited with code ${exitCode}. Check the configured command.`);
	}
	return { opened: true, path: relative(directory, absolutePath), command: options.editor.state.externalEditorCommand };
}
