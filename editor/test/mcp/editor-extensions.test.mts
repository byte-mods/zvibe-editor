import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { NullEngine, Scene } from "babylonjs";

const { saveProjectConfiguration } = vi.hoisted(() => ({ saveProjectConfiguration: vi.fn(async () => ({})) }));
vi.mock("../../src/project/save/save", () => ({ saveProjectConfiguration }));

import type { Editor } from "../../src/editor/main";
import { EditorExtensionHost } from "../../src/extensions/host";
import { inspectProjectEditorExtension } from "../../src/extensions/project";
import {
	applyEditorExtensionPlan,
	getEditorExtensionSdk,
	invokeBuildProfileFooterAction,
	invokeEditorExtensionMenu,
	listBuildProfileFooterActions,
	listEditorExtensions,
	openEditorExtensionWindow,
	planEditorExtensionChange,
	reloadEditorExtension,
	runEditorExtensionTests,
} from "../../src/mcp/project/extensions";
import { createBuildProfile } from "../../src/mcp/project/export";
import { MCPEndpoints } from "../../src/mcp/mcp";

describe("mcp/editor-extensions", () => {
	let root: string;
	let engine: NullEngine;
	let scene: Scene;
	let editor: Editor;
	let options: { editor: Editor };
	let openedWindows: string[];

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "zvibe-mcp-extension-"));
		const packageRoot = join(root, "node_modules", "example-extension");
		await mkdir(packageRoot, { recursive: true });
		await writeFile(join(root, "package.json"), JSON.stringify({ name: "game", version: "1.0.0", dependencies: { "example-extension": "1.0.0" } }));
		await writeFile(
			join(packageRoot, "package.json"),
			JSON.stringify({
				name: "example-extension",
				version: "1.0.0",
				main: "index.js",
				zvibeEditor: {
					apiVersion: 1,
					id: "com.example.extension",
					displayName: "Example Extension",
					capabilities: ["windows", "menus", "tests", "buildProfiles"],
					contributes: {
						windows: [{ id: "com.example.extension.window", title: "Example" }],
						menus: [{ id: "com.example.extension.menu", path: "Extensions/Example" }],
						tests: [{ id: "com.example.extension.test", title: "Example test" }],
						buildProfileFooterActions: [{ id: "com.example.extension.build", title: "Audit Build", order: 10, targets: ["web"], activeProfileOnly: true }],
					},
				},
			})
		);
		await writeFile(
			join(packageRoot, "index.js"),
			[
				"exports.activate = (context) => {",
				'  context.windows.register({ id: "com.example.extension.window", component: () => null });',
				'  context.menus.register({ id: "com.example.extension.menu", execute: () => undefined });',
				'  context.tests.register({ id: "com.example.extension.test", run: () => undefined });',
				'  context.buildProfiles.registerFooterAction({ id: "com.example.extension.build", execute: () => undefined });',
				"};",
			].join("\n")
		);
		const values = new Map<string, string>();
		vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
		openedWindows = [];
		const state = {
			projectPath: join(root, "game.bjseditor"),
			packageManager: "npm",
			editorExtensions: [{ packageName: "example-extension", enabled: false }],
			plugins: [],
		};
		editor = {
			state,
			extensionHost: null,
			layout: {
				addLayoutTab(_component: unknown, configuration: { id: string }): void {
					openedWindows.push(configuration.id);
				},
				removeLayoutTab(): void {},
				selectTab(): void {},
			},
			setState(update: Record<string, unknown>, callback?: () => void): void {
				Object.assign(state, update);
				callback?.();
			},
			setExtensionMenus(): void {},
		} as unknown as Editor;
		options = { editor };
		engine = new NullEngine();
		scene = new Scene(engine);
		saveProjectConfiguration.mockClear();
	});

	afterEach(async () => {
		await editor.extensionHost?.disposeAll();
		scene.dispose();
		engine.dispose();
		vi.unstubAllGlobals();
		await rm(root, { recursive: true, force: true });
	});

	test("publishes the SDK and maps all ten strict editor endpoints", () => {
		expect(getEditorExtensionSdk()).toMatchObject({
			apiVersion: 1,
			packageManifestField: "zvibeEditor",
			capabilities: ["inspectors", "windows", "menus", "tests", "buildProfiles", "editor"],
			security: { directDependenciesOnly: true, trustBoundToExactFingerprint: true },
		});
		for (const endpoint of [
			"get_editor_extension_sdk",
			"list_editor_extensions",
			"plan_editor_extension_change",
			"apply_editor_extension_plan",
			"reload_editor_extension",
			"open_editor_extension_window",
			"invoke_editor_extension_menu",
			"list_build_profile_footer_actions",
			"invoke_build_profile_footer_action",
			"run_editor_extension_tests",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
	});

	test("inspects without executing code and paginates exact package evidence", async () => {
		const result = await listEditorExtensions(scene, { query: "example", limit: 1 }, options);
		expect(editor.extensionHost).toBeNull();
		expect(result).toMatchObject({ count: 1, total: 1, hasMore: false, configured: [{ packageName: "example-extension", enabled: false }] });
		expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect((result.extensions as Array<Record<string, unknown>>)[0]).toMatchObject({
			packageName: "example-extension",
			packageVersion: "1.0.0",
			enabled: false,
			trusted: false,
		});
		expect((result.extensions as Array<Record<string, unknown>>)[0]).not.toHaveProperty("entryPath");
	});

	test("applies exact single-use trust and enable plans, then drives active contributions", async () => {
		const first = await listEditorExtensions(scene, {}, options);
		editor.extensionHost = new EditorExtensionHost({
			editor,
			trustStorage: localStorage,
			reinspect: (packageName) => inspectProjectEditorExtension(editor, packageName),
			registerInspector: () => () => undefined,
			openWindow: (contribution) => openedWindows.push(contribution.id),
			closeWindow: () => undefined,
			selectWindow: () => undefined,
			updateMenus: () => undefined,
		});
		const trustPlan = await planEditorExtensionChange(
			scene,
			{
				operation: "trust",
				packageName: "example-extension",
				expectedStateFingerprint: first.fingerprint,
				capabilities: ["windows", "menus", "tests", "buildProfiles"],
			},
			options
		);
		await expect(applyEditorExtensionPlan(scene, { planId: trustPlan.id, expectedStateFingerprint: trustPlan.sourceFingerprint, confirm: false }, options)).rejects.toThrow(
			"confirm must be true"
		);
		const trusted = await applyEditorExtensionPlan(scene, { planId: trustPlan.id, expectedStateFingerprint: trustPlan.sourceFingerprint, confirm: true }, options);
		expect((trusted.state as { extensions: Array<{ trusted: boolean }> }).extensions[0].trusted).toBe(true);
		await expect(applyEditorExtensionPlan(scene, { planId: trustPlan.id, expectedStateFingerprint: trustPlan.sourceFingerprint, confirm: true }, options)).rejects.toThrow(
			"missing or expired"
		);

		const afterTrust = await listEditorExtensions(scene, {}, options);
		const enablePlan = await planEditorExtensionChange(
			scene,
			{ operation: "enable", packageName: "example-extension", expectedStateFingerprint: afterTrust.fingerprint },
			options
		);
		const enabled = await applyEditorExtensionPlan(scene, { planId: enablePlan.id, expectedStateFingerprint: enablePlan.sourceFingerprint, confirm: true }, options);
		const extension = (enabled.state as { extensions: Array<{ fingerprint: string; runtime: { state: string } }> }).extensions[0];
		expect(extension.runtime.state).toBe("active");
		expect(saveProjectConfiguration).toHaveBeenCalledTimes(1);

		expect(
			await openEditorExtensionWindow(
				scene,
				{ packageName: "example-extension", expectedExtensionFingerprint: extension.fingerprint, windowId: "com.example.extension.window" },
				options
			)
		).toMatchObject({
			opened: true,
		});
		expect(openedWindows).toEqual(["com.example.extension.window"]);
		expect(
			await invokeEditorExtensionMenu(
				scene,
				{ packageName: "example-extension", expectedExtensionFingerprint: extension.fingerprint, menuId: "com.example.extension.menu" },
				options
			)
		).toMatchObject({
			invoked: true,
		});
		expect(
			await runEditorExtensionTests(
				scene,
				{ packageName: "example-extension", expectedExtensionFingerprint: extension.fingerprint, ids: ["com.example.extension.test"] },
				options
			)
		).toMatchObject({
			passed: 1,
			failed: 0,
			timedOut: 0,
		});
		const profile = createBuildProfile(scene, { expectedRevision: 0, id: "web-profile", name: "Web", target: "web" }).profile;
		const actions = listBuildProfileFooterActions(scene, { profileId: profile.id }, options);
		expect(actions).toMatchObject({ configurationRevision: 1, profile: { id: "web-profile", target: "web" }, total: 1 });
		expect(
			await invokeBuildProfileFooterAction(
				scene,
				{
					packageName: "example-extension",
					expectedExtensionFingerprint: extension.fingerprint,
					actionId: "com.example.extension.build",
					profileId: "web-profile",
					expectedConfigurationRevision: 1,
					confirm: true,
				},
				options
			)
		).toMatchObject({ invoked: true, profileId: "web-profile" });
		expect(await reloadEditorExtension(scene, { packageName: "example-extension", expectedExtensionFingerprint: extension.fingerprint }, options)).toMatchObject({
			reloaded: true,
			runtime: { state: "active" },
		});
	});

	test("rejects stale plan and runtime fingerprints before changing extension state", async () => {
		const listed = await listEditorExtensions(scene, {}, options);
		await expect(
			planEditorExtensionChange(scene, { operation: "enable", packageName: "example-extension", expectedStateFingerprint: "0".repeat(64) }, options)
		).rejects.toThrow("state changed since inspection");
		await expect(reloadEditorExtension(scene, { packageName: "example-extension", expectedExtensionFingerprint: "0".repeat(64) }, options)).rejects.toThrow("not active");
		expect((await listEditorExtensions(scene, {}, options)).fingerprint).toBe(listed.fingerprint);
	});
});
