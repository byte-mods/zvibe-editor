import { beforeEach, describe, expect, test, vi } from "vitest";

const { saveProjectConfiguration } = vi.hoisted(() => ({ saveProjectConfiguration: vi.fn(async () => ({})) }));
vi.mock("../../src/project/save/save", () => ({ saveProjectConfiguration }));

import { NullEngine, Scene } from "babylonjs";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { getEditorPreferences, getProjectSettings, resetEditorPreferences, resetProjectSettings, setEditorPreferences, setProjectSettings } from "../../src/mcp/project/project";
import { createDefaultProjectSettings, normalizeProjectSettings, resolveProjectSettingsForTarget, updateProjectSettings } from "../../src/project/settings";
import { projectConfiguration } from "../../src/project/configuration";
import {
	createDefaultEditorUserPreferences,
	editorUserPreferencesStorageKey,
	normalizeEditorUserPreferences,
	readEditorUserPreferences,
	updateEditorUserPreferences,
	writeEditorUserPreferences,
} from "../../src/editor/preferences";

describe("mcp/editor and project settings", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		const state = {
			projectPath: "/tmp/Game.bjseditor",
			projectSettings: createDefaultProjectSettings("Game"),
			editorUserPreferences: createDefaultEditorUserPreferences(),
			externalEditorCommand: "code",
		};
		options = {
			editor: {
				state,
				setState(update: object, callback?: () => void): void {
					Object.assign(state, update);
					callback?.();
				},
				async setEditorUserPreferences(preferences: any): Promise<void> {
					state.editorUserPreferences = preferences;
					state.externalEditorCommand = preferences.externalTools.scriptEditorCommand;
				},
			},
		};
		projectConfiguration.path = null;
		projectConfiguration.importAccelerator = structuredClone(state.projectSettings.assetPipeline.accelerator);
		saveProjectConfiguration.mockClear();
	});

	test("normalizes the complete schema and resolves bounded per-target overrides", () => {
		const normalized = normalizeProjectSettings({
			revision: 4,
			identity: { productName: "Nebula", version: "2.1.0", applicationId: "com.zvibe.nebula" },
			rendering: { maximumDevicePixelRatio: 99 },
			assetPipeline: { serializationMode: "forceBinary", reduceVersionControlNoise: true },
			platformOverrides: { web: { display: { defaultWidth: 1280 }, unknown: true }, unknown: { display: { defaultWidth: 1 } } },
		});
		expect(normalized).toMatchObject({
			version: 2,
			revision: 4,
			identity: { productName: "Nebula", companyName: "Default Company" },
			rendering: { maximumDevicePixelRatio: 8 },
			assetPipeline: { serializationMode: "forceBinary", reduceVersionControlNoise: false },
		});
		expect(resolveProjectSettingsForTarget(normalized, "web").display.defaultWidth).toBe(1280);
		expect(normalized.platformOverrides).not.toHaveProperty("unknown");
	});

	test("requires exact project revisions and rejects invalid merged settings atomically", () => {
		const current = createDefaultProjectSettings("Game");
		expect(() => updateProjectSettings(current, 1, { identity: { ...current.identity, productName: "Wrong" } })).toThrow("current revision is 0");
		const updated = updateProjectSettings(current, 0, {
			identity: { ...current.identity, productName: "Nebula", applicationId: "com.zvibe.nebula" },
			platformOverrides: { electron: { display: { defaultWidth: 2560 } } },
		});
		expect(updated).toMatchObject({ revision: 1, identity: { productName: "Nebula" } });
		expect(resolveProjectSettingsForTarget(updated, "electron").display.defaultWidth).toBe(2560);
		expect(() => updateProjectSettings(updated, 1, { identity: { ...updated.identity, applicationId: "invalid" } })).toThrow("reverse-domain");
		expect(updated.identity.applicationId).toBe("com.zvibe.nebula");
	});

	test("persists project MCP patches, reports restart boundaries, and resets at exact revisions", async () => {
		const result = await setProjectSettings(
			scene,
			{ expectedRevision: 0, settings: { rendering: { renderingBackend: "webgpu", maximumDevicePixelRatio: 1.5 }, playMode: { muteAudio: true } } },
			options
		);
		expect(result.settings).toMatchObject({ revision: 1, rendering: { renderingBackend: "webgpu", maximumDevicePixelRatio: 1.5 }, playMode: { muteAudio: true } });
		expect(result.restartRequired).toContain("rendering.renderingBackend");
		expect(saveProjectConfiguration).toHaveBeenCalledTimes(1);
		await expect(setProjectSettings(scene, { expectedRevision: 0, settings: { display: { defaultWidth: 1 } } }, options)).rejects.toThrow("current revision is 1");
		await expect(resetProjectSettings(scene, { expectedRevision: 1, confirm: false }, options)).rejects.toThrow("confirm=true");
		expect(options.editor.state.projectSettings.revision).toBe(1);
		const reset = await resetProjectSettings(scene, { expectedRevision: 1, confirm: true }, options);
		expect(reset.settings).toMatchObject({ revision: 2, display: { defaultWidth: 1920 } });
		expect(getProjectSettings(scene, {}, options).resolvedPlatforms.web).toMatchObject({ version: 2, revision: 2 });
	});

	test("does not rebuild asset watchers for unrelated Player Settings patches", async () => {
		const configureProjectAssetWatching = vi.fn(async () => undefined);
		const refreshAutoReimportWatchers = vi.fn(async () => undefined);
		options.editor.layout = { assets: { configureProjectAssetWatching, refreshAutoReimportWatchers } };
		projectConfiguration.path = options.editor.state.projectPath;

		await setProjectSettings(scene, { expectedRevision: 0, settings: { identity: { productName: "No Asset Rescan" }, playMode: { muteAudio: true } } }, options);

		expect(configureProjectAssetWatching).not.toHaveBeenCalled();
		expect(refreshAutoReimportWatchers).not.toHaveBeenCalled();
	});

	test("defaults new projects to a disabled Import Accelerator and preserves legacy upgraded opt-ins", () => {
		const defaults = createDefaultProjectSettings("Game");
		expect(defaults.assetPipeline.accelerator).toMatchObject({
			enabled: false,
			endpoint: "http://127.0.0.1:10080",
			downloadEnabled: true,
			uploadEnabled: true,
			contentValidation: "enabled",
		});
		const upgraded = normalizeProjectSettings({
			version: 1,
			assetPipeline: {
				cacheServerEnabled: true,
				cacheServerEndpoint: "https://cache.example/imports",
				cacheServerNamespace: "studio-main",
				cacheServerUploadEnabled: false,
			},
		});
		expect(upgraded).toMatchObject({
			version: 2,
			assetPipeline: {
				accelerator: { enabled: true, endpoint: "https://cache.example/imports", namespacePrefix: "studio-main", downloadEnabled: true, uploadEnabled: false },
			},
		});
	});

	test("merges Accelerator patches at exact revisions and rejects unsafe remote HTTP endpoints", () => {
		const current = createDefaultProjectSettings("Game");
		const updated = updateProjectSettings(current, 0, {
			assetPipeline: {
				...current.assetPipeline,
				accelerator: { ...current.assetPipeline.accelerator, enabled: true, endpoint: "https://cache.example", downloadBatchSize: 16 },
			},
		});
		expect(updated.assetPipeline.accelerator).toMatchObject({ enabled: true, endpoint: "https://cache.example", downloadBatchSize: 16, uploadEnabled: true });
		expect(updated.revision).toBe(1);
		expect(() =>
			updateProjectSettings(updated, 1, {
				assetPipeline: {
					...updated.assetPipeline,
					accelerator: { ...updated.assetPipeline.accelerator, endpoint: "http://cache.example" },
				},
			})
		).toThrow("requires HTTPS");
	});

	test("migrates, persists, exact-revisions, applies, and resets user preferences", async () => {
		const values = new Map<string, string>([["editor-theme", "light"]]);
		const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
		const migrated = readEditorUserPreferences(storage);
		expect(migrated).toMatchObject({ revision: 0, appearance: { theme: "light", uiScale: 0.8 } });
		const updated = updateEditorUserPreferences(migrated, 0, {
			workflow: { ...migrated.workflow, autoSave: true, autoSaveIntervalMinutes: 2 },
			externalTools: { ...migrated.externalTools, scriptEditorCommand: "cursor" },
		});
		writeEditorUserPreferences(updated, storage);
		expect(normalizeEditorUserPreferences(JSON.parse(values.get(editorUserPreferencesStorageKey)!))).toMatchObject({
			revision: 1,
			workflow: { autoSave: true },
			externalTools: { scriptEditorCommand: "cursor" },
		});
		const result = await setEditorPreferences(scene, { expectedRevision: 0, preferences: { appearance: { theme: "system", uiScale: 1 } } }, options);
		expect(result.preferences).toMatchObject({ revision: 1, appearance: { theme: "system", uiScale: 1 } });
		expect(options.editor.state.externalEditorCommand).toBe("code");
		await expect(setEditorPreferences(scene, { expectedRevision: 0, preferences: { diagnostics: { logLevel: "verbose" } } }, options)).rejects.toThrow("current revision is 1");
		await expect(resetEditorPreferences(scene, { expectedRevision: 1, confirm: false }, options)).rejects.toThrow("confirm=true");
		expect(options.editor.state.editorUserPreferences.revision).toBe(1);
		expect((await resetEditorPreferences(scene, { expectedRevision: 1, confirm: true }, options)).preferences.revision).toBe(2);
		expect(getEditorPreferences(scene, {}, options)).toMatchObject({ scope: "user", persisted: true });
	});

	test("maps settings and Accelerator endpoints and advertises complete settings capabilities", async () => {
		for (const endpoint of [
			"get_project_settings",
			"set_project_settings",
			"reset_project_settings",
			"get_editor_preferences",
			"set_editor_preferences",
			"reset_editor_preferences",
			"get_import_accelerator_capabilities",
			"get_import_accelerator_configuration",
			"set_import_accelerator_configuration",
			"check_import_accelerator_connection",
			"get_import_accelerator_diagnostics",
			"clear_import_accelerator_diagnostics",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		expect(getEditorCapabilities(scene, {}, options).features).toMatchObject({
			projectPlayerSettings: true,
			projectSettingsExactRevisions: true,
			projectSettingsPlatformOverrides: true,
			importAccelerator: true,
			importAcceleratorMcpManagement: true,
			editorUserPreferences: true,
			editorPreferencesExactRevisions: true,
		});
		expect(MCPEndpoints.get_import_accelerator_capabilities(scene, {}, options)).toMatchObject({
			protocol: "zvibe-import-accelerator-v1",
			artifactKinds: ["texture", "model", "audio", "video", "font", "material", "animation"],
		});
		const changed = await MCPEndpoints.set_import_accelerator_configuration(
			scene,
			{ expectedRevision: 0, configuration: { enabled: true, endpoint: "https://cache.example", namespacePrefix: "team-main" } },
			options
		);
		expect(changed).toMatchObject({ projectRevision: 1, configuration: { enabled: true, endpoint: "https://cache.example", namespacePrefix: "team-main" } });
		expect(changed).not.toHaveProperty("authorization");
		await expect(MCPEndpoints.set_import_accelerator_configuration(scene, { expectedRevision: 0, configuration: { enabled: false } }, options)).rejects.toThrow(
			"current revision is 1"
		);
	});
});
