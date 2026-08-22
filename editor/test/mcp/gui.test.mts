import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "path/posix";
import { tmpdir } from "os";
import { mkdir, mkdtemp, remove, writeFile } from "fs-extra";

import { NullEngine, Scene } from "babylonjs";
import { Button, Container, Image, TextBlock } from "babylonjs-gui";
import { createDefaultGUIAtlasTextAssignment, createDefaultGUIAuthoringState, guiControlIdentityMetadataKey } from "babylonjs-editor-tools";

vi.mock("../../src/tools/gui/authoring", () => ({
	installEditorGUIFontFamily: vi.fn(async (_root: string, path: string) => `Family-${path}`),
	loadEditorGUIFontAsset: vi.fn(),
}));

import {
	announceGUIAccessibilityAction,
	createGUIControl,
	createGUIEventBinding,
	clearGUIAtlasText,
	detachGUIRetainedDocument,
	deleteGUIAccessibilityNode,
	deleteGUIControl,
	deleteGUIEventBinding,
	deleteGUILocalizationBinding,
	deleteGUIInstance,
	getGUIAuthoring,
	getGUIAtlasText,
	getGUIContent,
	getGUICanvasGroup,
	getGUIInteractionCapabilities,
	getGUIRetainedDocument,
	getGUIUsageTracking,
	inspectGUIAccessibilityHierarchy,
	invokeGUIAccessibilityActionAction,
	listGUIs,
	listGUIRaycastReceivers,
	moveGUIControl,
	setGUICanvasSettings,
	setGUICanvasGroup,
	setGUIAccessibilityNode,
	setGUIAccessibilitySettings,
	setGUIContent,
	setGUIControlFont,
	setGUILocalizationBinding,
	setGUIRetainedDocument,
	setGUIRaycastReceiver,
	setGUIUsageTracking,
	resetGUIUsageTracking,
	refreshGUIRetainedDocument,
	refreshGUIRetainedDocumentsForSource,
	updateGUIControl,
	validateGUIAccessibility,
	writeGUIRetainedDocument,
} from "../../src/mcp/gui/gui";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/gui", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;
	let projectRoot: string | null;
	let previousProjectPath: string | null;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					preview: { scene },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
					console: { error: vi.fn() },
					assets: { refresh: vi.fn() },
				},
			},
		};
		projectRoot = null;
		previousProjectPath = projectConfiguration.path;
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		if (projectRoot) await remove(projectRoot);
		scene.dispose();
		engine.dispose();
	});

	test("atomically compiles, refreshes, leases, and detaches retained UXML/USS controls", async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "zvibe-retained-gui-"));
		projectConfiguration.path = join(projectRoot, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(projectRoot, "assets/ui"), { recursive: true });
		await writeFile(
			join(projectRoot, "assets/ui/hud.uxml"),
			`<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Style src="hud.uss"/><ui:VisualElement name="panel" class="panel"><ui:Label name="title" class="title" text="Ready"/></ui:VisualElement></ui:UXML>`
		);
		await writeFile(join(projectRoot, "assets/ui/hud.uss"), `.panel { width: 640px; height: 240px; } .title { color: #73a7ff; font-size: 32px; }`);
		const root = new Container("Root");
		const gui = {
			uniqueId: 684,
			name: "Retained HUD",
			_isFullscreen: true,
			metadata: { zvibeGUIAuthoring: createDefaultGUIAuthoringState() },
			rootContainer: root,
			idealWidth: 0,
			idealHeight: 0,
			getClassName: () => "AdvancedDynamicTexture",
			getSize: () => ({ width: 1920, height: 1080 }),
			serializeContent: () => ({ root: { name: "Root" } }),
			parseSerializedObject: vi.fn(),
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);
		const attached = await setGUIRetainedDocument(
			scene,
			{ guiId: "684", expectedRevision: 0, expectedSourceFingerprint: null, uxmlPath: "assets/ui/hud.uxml", hotReload: true },
			options
		);
		expect(attached).toMatchObject({ revision: 1, controlCount: 2, retainedDocument: { sourceRevision: 1, hotReload: true } });
		expect(getGUIAuthoring(scene, { guiId: "684" })).toMatchObject({
			authoring: { revision: 1, retainedDocument: { uxmlPath: "assets/ui/hud.uxml" } },
			controls: { total: 2, items: [{ id: "panel" }, { id: "title", parentId: "panel", properties: { text: "Ready", color: "#73a7ff" } }] },
		});
		const retained = await getGUIRetainedDocument(scene, { guiId: "684", includeSources: true });
		expect(retained.sources).toHaveLength(2);
		await expect(updateGUIControl(scene, { guiId: "684", expectedRevision: 1, controlId: "title", properties: { text: "Manual" } }, options)).rejects.toThrow(
			/owned by retained UXML\/USS/
		);
		await writeFile(join(projectRoot, "assets/ui/hud.uss"), `.panel { width: 640px; height: 240px; } .title { color: #ffcc00; font-size: 36px; }`);
		const refreshed = await refreshGUIRetainedDocument(
			scene,
			{ guiId: "684", expectedRevision: 1, expectedSourceFingerprint: retained.retainedDocument.compiled.sourceFingerprint },
			options
		);
		expect(refreshed).toMatchObject({ revision: 2, changed: true, retainedDocument: { sourceRevision: 2 } });
		expect(getGUIAuthoring(scene, { guiId: "684" }).controls.items[1]).toMatchObject({ id: "title", properties: { color: "#ffcc00", fontSize: "36px" } });
		await expect(
			refreshGUIRetainedDocument(scene, { guiId: "684", expectedRevision: 1, expectedSourceFingerprint: retained.retainedDocument.compiled.sourceFingerprint }, options)
		).rejects.toThrow(/expectedRevision 2/);
		const detached = await detachGUIRetainedDocument(
			scene,
			{ guiId: "684", expectedRevision: 2, expectedSourceFingerprint: refreshed.retainedDocument.compiled.sourceFingerprint },
			options
		);
		expect(detached).toMatchObject({ revision: 3, detached: true, preservedControlCount: 2 });
		expect(getGUIAuthoring(scene, { guiId: "684" }).authoring.retainedDocument).toBeNull();
		expect(await updateGUIControl(scene, { guiId: "684", expectedRevision: 3, controlId: "title", properties: { text: "Manual" } }, options)).toMatchObject({
			revision: 4,
			control: { properties: { text: "Manual" } },
		});
		const written = await writeGUIRetainedDocument(
			scene,
			{
				guiId: "684",
				expectedRevision: 4,
				expectedSourceFingerprint: null,
				uxml: {
					path: "assets/ui/generated.uxml",
					source: `<UXML><Style src="generated.uss"/><Label name="generated" class="generated" text="Written"/></UXML>`,
				},
				stylesheets: [{ path: "assets/ui/generated.uss", source: `.generated { color: #12ab34; }` }],
				templates: [],
				hotReload: true,
				overwrite: false,
			},
			options
		);
		expect(written).toMatchObject({ revision: 5, writtenPaths: ["assets/ui/generated.uxml", "assets/ui/generated.uss"], controlCount: 1 });
		expect(await getGUIRetainedDocument(scene, { guiId: "684", includeSources: true })).toMatchObject({
			revision: 5,
			retainedDocument: { uxmlPath: "assets/ui/generated.uxml" },
			sources: [{ path: "assets/ui/generated.uxml" }, { path: "assets/ui/generated.uss" }],
		});
		await writeFile(join(projectRoot, "assets/ui/generated.uss"), `.generated { color: #abcdef; }`);
		expect(await refreshGUIRetainedDocumentsForSource(scene, join(projectRoot, "assets/ui/generated.uss"), options)).toMatchObject([
			{ id: "684", revision: 6, changed: true, sourcePath: "assets/ui/generated.uss" },
		]);
		expect(getGUIAuthoring(scene, { guiId: "684" }).controls.items[0]).toMatchObject({ id: "generated", properties: { color: "#abcdef" } });
		expect(await refreshGUIRetainedDocumentsForSource(scene, "assets/ui/generated.uss", options)).toMatchObject([{ id: "684", revision: 6, changed: false }]);
	});

	test("reads and replaces an active fullscreen GUI control tree", () => {
		const gui = {
			uniqueId: 42,
			name: "HUD",
			_isFullscreen: true,
			rootContainer: {
				children: [{ name: "Title", metadata: {}, getClassName: () => "TextBlock", children: [] }],
				clearControls: vi.fn(),
				paddingLeft: "0px",
				paddingTop: "0px",
				paddingRight: "0px",
				paddingBottom: "0px",
			},
			metadata: {},
			idealWidth: 0,
			idealHeight: 0,
			getClassName: () => "AdvancedDynamicTexture",
			getSize: () => ({ width: 1920, height: 1080 }),
			serializeContent: () => ({ root: { name: "Title", text: "Ready" } }),
			parseSerializedObject: vi.fn(),
			dispose: vi.fn(),
		} as any;
		scene.textures.push(gui);
		const content = getGUIContent(scene, { guiId: gui.uniqueId.toString() }).content;
		expect(listGUIs(scene).guis).toMatchObject([{ id: gui.uniqueId.toString(), name: "HUD", controlCount: 1 }]);
		expect(setGUIContent(scene, { guiId: gui.uniqueId.toString(), name: "HUD Updated", content }, options)).toMatchObject({ name: "HUD Updated", controlCount: 1 });
	});

	test("authors controls, canvas scaling, font fallback, events, hierarchy, and exact cleanup", async () => {
		const root = new Container("Root");
		const gui = {
			uniqueId: 44,
			name: "Menu",
			_isFullscreen: true,
			metadata: {},
			rootContainer: root,
			idealWidth: 0,
			idealHeight: 0,
			getClassName: () => "AdvancedDynamicTexture",
			getSize: () => ({ width: 1920, height: 1080 }),
			serializeContent: () => ({ root: { name: "Root", children: root.children.map((control) => ({ name: control.name, type: control.getClassName() })) } }),
			parseSerializedObject: vi.fn(),
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);

		const container = await createGUIControl(
			scene,
			{
				guiId: "44",
				expectedRevision: 0,
				controlId: "menu-panel",
				type: "rectangle",
				properties: { name: "Menu Panel", width: "600px", height: "400px", background: "#202020" },
			},
			options
		);
		expect(container).toMatchObject({ revision: 1, control: { id: "menu-panel", parentId: null, properties: { width: "600px", background: "#202020" } } });

		const button = await createGUIControl(
			scene,
			{
				guiId: "44",
				expectedRevision: 1,
				controlId: "play-button",
				parentControlId: "menu-panel",
				type: "button",
				properties: { name: "Play Button", text: "Play", width: "240px", height: "64px" },
			},
			options
		);
		expect(button).toMatchObject({ revision: 2, control: { id: "play-button", parentId: "menu-panel", properties: { text: "Play" } } });

		expect(
			await updateGUIControl(scene, { guiId: "44", expectedRevision: 2, controlId: "play-button", properties: { text: "Start Game", alpha: 0.9 } }, options)
		).toMatchObject({
			revision: 3,
			control: { properties: { text: "Start Game", alpha: 0.9 } },
		});
		expect(
			await setGUICanvasSettings(
				scene,
				{
					guiId: "44",
					expectedRevision: 3,
					canvas: { referenceWidth: 1280, referenceHeight: 720, matchWidthOrHeight: 0.25, safeArea: { enabled: true, left: 0.05, right: 0.05 } },
				},
				options
			)
		).toMatchObject({ revision: 4, canvas: { referenceWidth: 1280, safeArea: { enabled: true, left: 0.05, right: 0.05 } } });
		expect(
			await setGUIControlFont(
				scene,
				{
					guiId: "44",
					expectedRevision: 4,
					controlId: "play-button",
					assignment: { assetPaths: ["assets/fonts/primary.ttf", "assets/fonts/fallback.ttf"], fontStyle: "normal", fontWeight: "700" },
				},
				options
			)
		).toMatchObject({ revision: 5, assignment: { assetPaths: ["assets/fonts/primary.ttf", "assets/fonts/fallback.ttf"] } });
		expect(
			await createGUIEventBinding(
				scene,
				{
					guiId: "44",
					expectedRevision: 5,
					binding: { id: "play", controlId: "play-button", event: "pointerClick", enabled: true, target: { kind: "customEvent", eventName: "game.play", detail: null } },
				},
				options
			)
		).toMatchObject({ revision: 6, binding: { id: "play", controlId: "play-button" } });
		expect(await moveGUIControl(scene, { guiId: "44", expectedRevision: 6, controlId: "play-button", parentControlId: null, zIndex: 7 }, options)).toMatchObject({
			revision: 7,
			control: { parentId: null, properties: { zIndex: 7 } },
		});
		expect(() => getGUIAuthoring(scene, { guiId: "44", offset: 0, limit: 20 })).not.toThrow();
		const authored = getGUIAuthoring(scene, { guiId: "44", offset: 0, limit: 20 });
		expect(authored).toMatchObject({
			authoring: { revision: 7, bindings: [{ id: "play" }], fonts: [{ controlId: "play-button" }] },
			controls: { hasMore: false },
		});
		expect(authored.controls.items.find((control: any) => control.id === "play-button")).toMatchObject({ properties: { width: "240px", height: "64px" } });
		expect(await deleteGUIEventBinding(scene, { guiId: "44", expectedRevision: 7, bindingId: "play" }, options)).toMatchObject({ revision: 8, deletedBindingId: "play" });
		expect(await deleteGUIControl(scene, { guiId: "44", expectedRevision: 8, controlId: "play-button" }, options)).toMatchObject({
			revision: 9,
			deletedControlIds: expect.arrayContaining(["play-button"]),
		});
		expect(getGUIAuthoring(scene, { guiId: "44" }).authoring.fonts).toEqual([]);
		await expect(updateGUIControl(scene, { guiId: "44", expectedRevision: 8, controlId: "menu-panel", properties: { alpha: 0.5 } }, options)).rejects.toThrow(
			/expectedRevision 9/
		);
		expect(deleteGUIInstance(scene, { guiId: "44", expectedRevision: 9, confirm: true }, options)).toMatchObject({ id: "44", revision: 9, controlCount: 1, disposed: true });
		expect(gui.dispose).toHaveBeenCalledOnce();
		expect(options.editor.layout.inspector.setEditedObject).toHaveBeenLastCalledWith(scene);
	});

	test("authors CanvasGroup, RaycastReceiver, and local UGUI usage tracking under exact revisions", async () => {
		const root = new Container("Root");
		const gui = {
			uniqueId: 47,
			name: "Interactive HUD",
			_isFullscreen: true,
			metadata: {},
			rootContainer: root,
			idealWidth: 0,
			idealHeight: 0,
			getClassName: () => "AdvancedDynamicTexture",
			getSize: () => ({ width: 1920, height: 1080 }),
			serializeContent: () => ({ root: { name: "Root" } }),
			parseSerializedObject: vi.fn(),
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);
		expect(getGUIInteractionCapabilities()).toMatchObject({ model: "zvibe-gui-interaction-v1", usageTracking: { localOnly: true, externallyTransmitted: false } });
		const group = await createGUIControl(
			scene,
			{
				guiId: "47",
				expectedRevision: 0,
				controlId: "fade-group",
				type: "canvasGroup",
				properties: { name: "Fade", width: "100%", height: "100%", alpha: 0.4, interactable: true, blocksRaycasts: false, ignoreParentGroups: false },
			},
			options
		);
		expect(group).toMatchObject({ revision: 1, control: { type: "CanvasGroup", properties: { alpha: 0.4, blocksRaycasts: false } } });
		expect(getGUICanvasGroup(scene, { guiId: "47", controlId: "fade-group" })).toMatchObject({ revision: 1, assignment: { alpha: 0.4 } });
		expect(
			await setGUICanvasGroup(
				scene,
				{
					guiId: "47",
					expectedRevision: 1,
					controlId: "fade-group",
					assignment: { alpha: 0.7, interactable: false, blocksRaycasts: true, ignoreParentGroups: true },
				},
				options
			)
		).toMatchObject({ revision: 2, assignment: { alpha: 0.7, interactable: false, ignoreParentGroups: true } });
		const receiver = await createGUIControl(
			scene,
			{
				guiId: "47",
				expectedRevision: 2,
				controlId: "screen-hit",
				parentControlId: "fade-group",
				type: "raycastReceiver",
				properties: { name: "Screen Hit", width: "100%", height: "100%" },
			},
			options
		);
		expect(receiver).toMatchObject({ revision: 3, control: { type: "RaycastReceiver" } });
		expect(listGUIRaycastReceivers(scene, { guiId: "47", offset: 0, limit: 10 })).toMatchObject({
			revision: 3,
			receivers: { total: 1, items: [{ controlId: "screen-hit", enabled: true }] },
		});
		expect(await setGUIRaycastReceiver(scene, { guiId: "47", expectedRevision: 3, controlId: "screen-hit", enabled: false }, options)).toMatchObject({
			revision: 4,
			assignment: { enabled: false },
		});
		expect(await setGUIUsageTracking(scene, { guiId: "47", expectedRevision: 4, settings: { enabled: true, maxRecentEvents: 4 } }, options)).toMatchObject({
			revision: 5,
			settings: { enabled: true, maxRecentEvents: 4 },
		});
		const usage = getGUIUsageTracking(scene, { guiId: "47", offset: 0, limit: 10 });
		expect(usage).toMatchObject({ revision: 5, privacy: { localOnly: true, externallyTransmitted: false }, evidence: { canvasGroupCount: 1, raycastReceiverCount: 0 } });
		expect(resetGUIUsageTracking(scene, { guiId: "47", expectedRevision: 5 })).toMatchObject({ revision: 5, evidence: { counters: { pointerEvents: 0 } } });
		await expect(setGUICanvasGroup(scene, { guiId: "47", expectedRevision: 4, controlId: "fade-group", assignment: null }, options)).rejects.toThrow(/expectedRevision 5/);
		expect(await setGUICanvasGroup(scene, { guiId: "47", expectedRevision: 5, controlId: "fade-group", assignment: null }, options)).toMatchObject({
			revision: 6,
			assignment: null,
		});
	});

	test("reports semantic, sizing, and contrast accessibility concerns without changing GUI controls", async () => {
		const gui = {
			uniqueId: 43,
			name: "HUD",
			_isFullscreen: true,
			rootContainer: {
				children: [
					{ name: "Health", fontSize: 10, getClassName: () => "TextBlock" },
					{ name: "Health", getClassName: () => "TextBlock" },
					{ name: "", text: "", getClassName: () => "Button" },
					{ name: "Low Contrast", text: "Status", color: "#777777", background: "#888888", getClassName: () => "TextBlock" },
				],
			},
			getClassName: () => "AdvancedDynamicTexture",
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);

		const report = await validateGUIAccessibility(scene, { guiId: "43" });
		expect(report).toMatchObject({ guiCount: 1, controlCount: 4, errorCount: 2, warningCount: 2 });
		expect(report.issues.map((issue: any) => issue.code)).toEqual(["smallText", "duplicateControlName", "missingSemanticLabel", "lowTextContrast"]);
		expect(report.issues[3].contrastRatio).toBeLessThan(4.5);
	});

	test("authors localized GUI properties and a live semantic action hierarchy under exact revisions", async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "zvibe-gui-localization-"));
		projectConfiguration.path = join(projectRoot, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await writeFile(
			join(projectRoot, "localization.json"),
			JSON.stringify({
				version: 2,
				revision: 0,
				defaultLocale: "en",
				locales: [{ id: "en", name: "English", direction: "ltr", fallbackLocales: [], pseudo: null }],
				tables: [{ name: "UI", fallbackLocale: "en", fallbackLocales: [], preload: false, smartEntries: [], entries: { title: { en: "Localized title" } } }],
				assetTables: [],
			})
		);
		const root = new Container("Root");
		const title = new TextBlock("Title", "Original title");
		title.metadata = { [guiControlIdentityMetadataKey]: "title" };
		const play = Button.CreateSimpleButton("Play", "Play");
		play.metadata = { [guiControlIdentityMetadataKey]: "play" };
		root.addControl(title);
		root.addControl(play);
		const gui = {
			uniqueId: 46,
			name: "Localized HUD",
			_isFullscreen: true,
			metadata: { zvibeGUIAuthoring: createDefaultGUIAuthoringState() },
			rootContainer: root,
			idealWidth: 0,
			idealHeight: 0,
			getClassName: () => "AdvancedDynamicTexture",
			getSize: () => ({ width: 1920, height: 1080 }),
			serializeContent: () => ({ root: { name: "Root" } }),
			parseSerializedObject: vi.fn(),
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);

		expect(
			await setGUILocalizationBinding(
				scene,
				{
					guiId: "46",
					expectedRevision: 0,
					binding: {
						controlId: "title",
						property: "text",
						table: "UI",
						key: "title",
						localeOverride: null,
						arguments: {},
						isolateBidirectionalText: true,
						mirrorHorizontalAlignment: true,
					},
				},
				options
			)
		).toMatchObject({ revision: 1, binding: { controlId: "title", table: "UI" } });
		expect(title.text).toContain("Localized title");
		expect(await setGUIAccessibilitySettings(scene, { guiId: "46", expectedRevision: 1, settings: { enabled: true, autoExposeText: false } }, options)).toMatchObject({
			revision: 2,
		});
		expect(
			await setGUIAccessibilityNode(
				scene,
				{
					guiId: "46",
					expectedRevision: 2,
					node: {
						controlId: "play",
						role: "button",
						label: "Play",
						hint: "Start game",
						value: "",
						focusOrder: 0,
						allowsDirectInteraction: false,
						actions: ["activate"],
						live: "off",
					},
				},
				options
			)
		).toMatchObject({ revision: 3, node: { controlId: "play", role: "button" } });
		let clicks = 0;
		play.onPointerClickObservable.add(() => clicks++);
		expect(invokeGUIAccessibilityActionAction(scene, { guiId: "46", expectedRevision: 3, controlId: "play", action: "activate" })).toMatchObject({ action: "activate" });
		expect(clicks).toBe(1);
		expect(announceGUIAccessibilityAction(scene, { guiId: "46", expectedRevision: 3, message: "Game ready", priority: "polite" })).toMatchObject({ announced: true });
		expect(inspectGUIAccessibilityHierarchy(scene, { guiId: "46", offset: 0, limit: 10 })).toMatchObject({
			revision: 3,
			hierarchy: { total: 3 },
			runtime: { enabled: true, nodeCount: 1 },
		});
		expect(await deleteGUILocalizationBinding(scene, { guiId: "46", expectedRevision: 3, controlId: "title", property: "text" }, options)).toMatchObject({ revision: 4 });
		expect(title.text).toBe("Original title");
		expect(await deleteGUIAccessibilityNode(scene, { guiId: "46", expectedRevision: 4, controlId: "play" }, options)).toMatchObject({ revision: 5 });
	});

	test("reads and exact-revision clears persisted atlas-rich-text state while retaining its Image control", async () => {
		const root = new Container("Root");
		const image = new Image("Title");
		image.metadata = { [guiControlIdentityMetadataKey]: "title" };
		root.addControl(image);
		const state = createDefaultGUIAuthoringState();
		state.atlasTexts = [{ ...createDefaultGUIAtlasTextAssignment("title", ["assets/title.ttf"]), text: "<b>Ready</b>" }];
		const gui = {
			uniqueId: 45,
			name: "Atlas HUD",
			_isFullscreen: true,
			metadata: { zvibeGUIAuthoring: state },
			rootContainer: root,
			idealWidth: 0,
			idealHeight: 0,
			getClassName: () => "AdvancedDynamicTexture",
			getSize: () => ({ width: 1920, height: 1080 }),
			serializeContent: () => ({ root: { name: "Root" } }),
			parseSerializedObject: vi.fn(),
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);
		expect(getGUIAtlasText(scene, { guiId: "45", controlId: "title" })).toMatchObject({ revision: 0, assignment: { text: "<b>Ready</b>" }, runtime: null });
		expect(await clearGUIAtlasText(scene, { guiId: "45", expectedRevision: 0, controlId: "title" }, options)).toMatchObject({
			revision: 1,
			clearedControlId: "title",
			runtimeCleared: true,
			transparentCanvas: null,
		});
		expect(root.children).toContain(image);
		expect(getGUIAuthoring(scene, { guiId: "45" }).authoring.atlasTexts).toEqual([]);
		await expect(clearGUIAtlasText(scene, { guiId: "45", expectedRevision: 0, controlId: "title" }, options)).rejects.toThrow(/expectedRevision 1/);
	});
});
