import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Button, Checkbox, Container, Image, Rectangle, TextBlock } from "@babylonjs/gui";

import {
	applyGUIAuthoringRuntime,
	createDefaultGUIAuthoringState,
	describeGUIControls,
	getGUIAuthoringState,
	IGUIAdvancedDynamicTextureLike,
	guiControlIdentityMetadataKey,
	invokeGUIEventBinding,
	normalizeGUIAuthoringState,
	setGUIAuthoringState,
} from "../../src/loading/gui-authoring";
import { detachGUIInteractionRuntime, getGUIUsageTrackingEvidence } from "../../src/loading/gui-interaction";
import { createDefaultGUIAtlasTextAssignment, guiAtlasTextRuntimeMetadataKey } from "../../src/loading/gui-atlas-text";
import { compileGUIRetainedDocument } from "../../src/loading/gui-retained-ui";
import { ILoadedImportedFont } from "../../src/loading/fonts";
import { LocalizationManager, normalizeLocalizationData } from "../../src/loading/localization";
import { scriptsDictionary } from "../../src/loading/script/apply";
import { IScript } from "../../src/script";

describe("GUI canvas authoring runtime", () => {
	let engine: NullEngine;
	let scene: Scene;
	let gui: IGUIAdvancedDynamicTextureLike;
	let root: Container;

	beforeEach(() => {
		engine = new NullEngine({ renderWidth: 1000, renderHeight: 500, textureSize: 512, deterministicLockstep: false, lockstepMaxSteps: 4 });
		scene = new Scene(engine);
		root = new Container("Root");
		gui = { name: "HUD", metadata: {}, rootContainer: root, idealWidth: 0, idealHeight: 0 };
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		scriptsDictionary.clear();
		scene.dispose();
		engine.dispose();
	});

	test("assigns stable hierarchy ids and enforces exact revisions", () => {
		const panel = new Rectangle("Panel");
		const title = new TextBlock("Title", "Ready");
		panel.addControl(title);
		root.addControl(panel);

		const first = describeGUIControls(gui);
		const second = describeGUIControls(gui);
		expect(first).toEqual(second);
		expect(first).toMatchObject([
			{ id: "control-1", parentId: null, name: "Panel", childCount: 1 },
			{ id: "control-2", parentId: "control-1", name: "Title", childCount: 0 },
		]);

		const current = getGUIAuthoringState(gui);
		const next = setGUIAuthoringState(gui, 0, { ...current, canvas: { ...current.canvas, referenceWidth: 1280 } });
		expect(next).toMatchObject({ revision: 1, canvas: { referenceWidth: 1280 } });
		expect(() => setGUIAuthoringState(gui, 0, next)).toThrow(/expectedRevision 1/);
	});

	test("rejects unsafe state before publication", () => {
		const state = createDefaultGUIAuthoringState();
		expect(() => normalizeGUIAuthoringState({ ...state, canvas: { ...state.canvas, safeArea: { enabled: true, left: 0.6, right: 0.6, top: 0, bottom: 0 } } })).toThrow(
			/positive canvas area/
		);
		expect(() =>
			normalizeGUIAuthoringState({
				...state,
				fonts: [{ controlId: "control-1", assetPaths: ["../outside.ttf"], fontStyle: "normal", fontWeight: "400" }],
			})
		).toThrow(/without traversal/);
	});

	test("applies exact Canvas Scaler math, font fallbacks, and custom events", async () => {
		const button = Button.CreateSimpleButton("Play", "Play");
		root.addControl(button);
		const controlId = describeGUIControls(gui)[0].id;
		const state = createDefaultGUIAuthoringState();
		state.canvas.referenceWidth = 500;
		state.canvas.referenceHeight = 500;
		state.canvas.matchWidthOrHeight = 0.5;
		state.canvas.safeArea = { enabled: true, left: 0.1, top: 0.1, right: 0.1, bottom: 0.1 };
		state.fonts = [{ controlId, assetPaths: ["assets/ui-primary.ttf", "assets/ui-fallback.ttf"], fontStyle: "italic", fontWeight: "700" }];
		state.bindings = [
			{ id: "play-click", controlId, event: "pointerClick", enabled: true, target: { kind: "customEvent", eventName: "game.play", detail: { source: "hud" } } },
		];
		const customEvent = vi.fn();
		const evidence = await applyGUIAuthoringRuntime(gui, state, {
			rootUrl: "assets/",
			scene,
			loadFontFamily: async (_root, path) => `Family-${path}`,
			onCustomEvent: customEvent,
		});

		expect(evidence).toMatchObject({ controlCount: 2, boundEventCount: 1, fontAssignmentCount: 1, loadedFontCount: 2, missingControlIds: [] });
		expect(evidence.canvasScale).toBeCloseTo(Math.sqrt(2), 6);
		expect(gui.idealWidth).toBeCloseTo(1000 / Math.sqrt(2), 6);
		expect(gui.rootContainer.paddingLeft).toBe(`${(1000 * 0.1) / Math.sqrt(2)}px`);
		expect(button.fontFamily).toBe('"Family-assets/ui-primary.ttf", "Family-assets/ui-fallback.ttf"');
		expect(button.fontStyle).toBe("italic");
		expect(button.fontWeight).toBe("700");
		button.onPointerClickObservable.notifyObservers({} as never);
		expect(customEvent).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "play-click", eventName: "game.play", detail: { source: "hud" } }));
	});

	test("applies retained hover, active, focus, disabled, and checked pseudo-state cascade with runtime evidence", async () => {
		const panel = new Rectangle("Panel");
		panel.metadata = { [guiControlIdentityMetadataKey]: "panel" };
		const toggle = new Checkbox("Toggle");
		toggle.metadata = { [guiControlIdentityMetadataKey]: "toggle" };
		root.addControl(panel);
		root.addControl(toggle);
		const compiled = await compileGUIRetainedDocument({
			uxmlPath: "assets/ui/hud.uxml",
			uxml: `<UXML><Style src="hud.uss"/><Panel name="panel" class="panel"/><Toggle name="toggle" class="toggle"/></UXML>`,
			stylesheets: [
				{
					path: "assets/ui/hud.uss",
					source: `.panel { background-color: #000000; } .panel:hover { background-color: #111111; } .panel:active { background-color: #222222; } .panel:focus { background-color: #333333; } .panel:disabled { background-color: #444444; } .toggle:checked { background-color: #55aa55; }`,
				},
			],
		});
		const state = createDefaultGUIAuthoringState();
		state.retainedDocument = {
			model: "unity-retained-ui-document-v1",
			uxmlPath: "assets/ui/hud.uxml",
			stylesheetPaths: ["assets/ui/hud.uss"],
			templatePaths: [],
			hotReload: true,
			sourceRevision: 1,
			compiled,
		};
		const evidence = await applyGUIAuthoringRuntime(gui, state, { rootUrl: "/scene/", scene });
		expect(evidence).toMatchObject({
			retainedDocumentReady: true,
			retainedControlCount: 2,
			retainedPseudoBindingCount: 5,
			retainedSourceFingerprint: compiled.sourceFingerprint,
		});
		expect(panel.background).toBe("#000000");
		panel.onPointerEnterObservable.notifyObservers(panel);
		expect(panel.background).toBe("#111111");
		panel.onPointerDownObservable.notifyObservers(panel as never);
		expect(panel.background).toBe("#222222");
		panel.onPointerUpObservable.notifyObservers(panel as never);
		expect(panel.background).toBe("#111111");
		panel.onPointerOutObservable.notifyObservers(panel);
		panel.onFocusObservable.notifyObservers(panel);
		expect(panel.background).toBe("#333333");
		panel.onBlurObservable.notifyObservers(panel);
		toggle.isChecked = true;
		expect(toggle.background).toBe("#55aa55");
	});

	test("applies hierarchical CanvasGroup and RaycastReceiver policy and restores native authored state", async () => {
		const group = new Container("Group");
		group.metadata = { [guiControlIdentityMetadataKey]: "group" };
		const nested = new Container("Nested");
		nested.metadata = { [guiControlIdentityMetadataKey]: "nested" };
		const button = Button.CreateSimpleButton("Action", "Action");
		button.metadata = { [guiControlIdentityMetadataKey]: "action" };
		const receiver = new Rectangle("Receiver");
		receiver.metadata = { [guiControlIdentityMetadataKey]: "receiver" };
		button.alpha = 0.8;
		receiver.isPointerBlocker = false;
		nested.addControl(button);
		group.addControl(nested);
		group.addControl(receiver);
		root.addControl(group);
		const state = createDefaultGUIAuthoringState();
		state.canvasGroups = [
			{ controlId: "group", alpha: 0.5, interactable: true, blocksRaycasts: true, ignoreParentGroups: false },
			{ controlId: "nested", alpha: 0.25, interactable: false, blocksRaycasts: false, ignoreParentGroups: false },
		];
		state.raycastReceivers = [{ controlId: "receiver", enabled: true }];
		const evidence = await applyGUIAuthoringRuntime(gui, state, { rootUrl: "/scene/", scene });
		expect(evidence).toMatchObject({ canvasGroupCount: 2, raycastReceiverCount: 1 });
		expect((button as unknown as { _processPicking(...args: unknown[]): boolean })._processPicking(0, 0, null, 0, 0, 0)).toBe(false);
		expect(receiver.isPointerBlocker).toBe(true);
		const context = { globalAlpha: 1 };
		(group as unknown as { _applyStates(context: { globalAlpha: number }): void })._applyStates(context);
		(nested as unknown as { _applyStates(context: { globalAlpha: number }): void })._applyStates(context);
		(button as unknown as { _applyStates(context: { globalAlpha: number }): void })._applyStates(context);
		expect(context.globalAlpha).toBeCloseTo(0.8 * 0.5 * 0.25);
		detachGUIInteractionRuntime(gui);
		expect(button).toMatchObject({ alpha: 0.8, isEnabled: true, isHitTestVisible: true });
		expect(receiver.isPointerBlocker).toBe(false);
	});

	test("tracks bounded local GUI usage and preserves counters across runtime reattachment", async () => {
		const button = Button.CreateSimpleButton("Action", "Action");
		button.metadata = { [guiControlIdentityMetadataKey]: "action" };
		root.addControl(button);
		const state = createDefaultGUIAuthoringState();
		state.usageTracking = { enabled: true, maxRecentEvents: 2 };
		await applyGUIAuthoringRuntime(gui, state, { rootUrl: "/scene/", scene });
		button.onPointerEnterObservable.notifyObservers(button);
		button.onPointerDownObservable.notifyObservers(button as never);
		button.onPointerClickObservable.notifyObservers(button as never);
		expect(getGUIUsageTrackingEvidence(gui, 0, 1)).toMatchObject({
			enabled: true,
			controlCount: 2,
			counters: { pointerEvents: 3 },
			recentEvents: { total: 2, count: 1, hasMore: true, items: [{ kind: "pointerDown", controlId: "action" }] },
		});
		await applyGUIAuthoringRuntime(gui, state, { rootUrl: "/scene/", scene });
		expect(getGUIUsageTrackingEvidence(gui).counters.pointerEvents).toBe(3);
	});

	test("invokes attached script methods with static and event arguments", () => {
		const button = Button.CreateSimpleButton("Apply", "Apply");
		root.addControl(button);
		const controlId = describeGUIControls(gui)[0].id;
		const target = new TransformNode("Player", scene);
		const method = vi.fn((amount: number, event: unknown) => ({ amount, event }));
		const script = { applyDamage: method } as IScript & { applyDamage: typeof method };
		scriptsDictionary.set(target, [{ key: "src/player.ts", instance: script, observers: {}, diagnostics: {} as never }]);
		const result = invokeGUIEventBinding({
			gui,
			scene,
			binding: {
				id: "damage",
				controlId,
				event: "pointerClick",
				enabled: true,
				target: { kind: "scriptMethod", targetNodeId: target.id, scriptKey: "src/player.ts", method: "applyDamage", arguments: [25], passEventData: true },
			},
			eventData: { pointerId: 7 },
		});
		expect(method).toHaveBeenCalledWith(25, { pointerId: 7 });
		expect(result).toEqual({ amount: 25, event: { pointerId: 7 } });
	});

	test("applies atlas text through a native Image dom canvas and exposes exact runtime evidence", async () => {
		const image = new Image("Atlas Title");
		root.addControl(image);
		const controlId = describeGUIControls(gui)[0].id;
		const state = createDefaultGUIAuthoringState();
		state.atlasTexts = [{ ...createDefaultGUIAtlasTextAssignment(controlId, ["assets/title.ttf"]), text: "Ready" }];
		const canvas = { width: 512, height: 128 } as HTMLCanvasElement;
		const font = {
			authoredPath: "assets/title.ttf",
			renderMode: "msdf",
			family: "Title",
			manifestUrl: "title.font.json",
			manifest: { renderMode: "msdf" },
			pageUrls: ["title.png"],
			dynamicFontUrl: null,
			sourceFontUrl: "title.ttf",
		} as ILoadedImportedFont;
		const evidence = await applyGUIAuthoringRuntime(gui, state, {
			rootUrl: "/scene/",
			scene,
			loadFontFamily: async () => "Title",
			loadFontAsset: async () => font,
			renderAtlasText: async (assignment) => ({
				canvas,
				layout: {
					assignment,
					placements: [],
					lines: [],
					evidence: {
						model: "unity-atlas-rich-text-v1",
						width: 512,
						height: 128,
						lineCount: 1,
						glyphCount: 5,
						atlasGlyphCount: 5,
						runtimeGlyphCount: 0,
						missingCodepoints: [],
						populatedCodepoints: [],
						fallbackUseCount: 0,
						richTagCount: 0,
						truncated: false,
						clippedGlyphCount: 0,
						renderModes: { dynamic: 0, bitmap: 0, sdf: 0, msdf: 5 },
					},
				},
			}),
		});
		expect(image.domImage).toBe(canvas);
		expect((image.metadata as Record<string, unknown>)[guiAtlasTextRuntimeMetadataKey]).toMatchObject({ glyphCount: 5, renderModes: { msdf: 5 } });
		expect(evidence).toMatchObject({ atlasTextCount: 1, atlasTextReadyCount: 1, atlasFontCount: 1, loadedFontCount: 1 });

		const blankCanvas = { width: 0, height: 0 } as HTMLCanvasElement;
		vi.stubGlobal("document", { createElement: vi.fn(() => blankCanvas) });
		state.atlasTexts = [];
		const cleared = await applyGUIAuthoringRuntime(gui, state, { rootUrl: "/scene/", scene });
		expect(image.domImage).toBe(blankCanvas);
		expect(blankCanvas).toMatchObject({ width: 1, height: 1 });
		expect((image.metadata as Record<string, unknown>)[guiAtlasTextRuntimeMetadataKey]).toBeUndefined();
		expect(cleared).toMatchObject({ atlasTextCount: 0, atlasTextReadyCount: 0, atlasFontCount: 0 });
	});

	test("updates localized GUI strings and assets with RTL isolation and exact cleanup", async () => {
		const title = new TextBlock("Title", "Ready");
		title.textHorizontalAlignment = 0;
		const image = new Rectangle("Logo") as Rectangle & { source: string };
		image.source = "";
		root.addControl(title);
		root.addControl(image);
		const [titleDescription, imageDescription] = describeGUIControls(gui);
		const localization = new LocalizationManager(
			normalizeLocalizationData({
				defaultLocale: "en",
				locales: [{ id: "en" }, { id: "ar", direction: "rtl", fallbackLocales: ["en"] }],
				tables: [{ name: "UI", fallbackLocale: "en", entries: { title: { en: "Ready", ar: "جاهز" } } }],
				assetTables: [
					{
						name: "Art",
						fallbackLocale: "en",
						entries: { logo: { en: { path: "assets/logo.png", type: "texture" }, ar: { path: "assets/logo-ar.png", type: "texture" } } },
					},
				],
			})
		);
		const state = createDefaultGUIAuthoringState();
		state.localizations = [
			{
				controlId: titleDescription.id,
				property: "text",
				table: "UI",
				key: "title",
				localeOverride: null,
				arguments: {},
				isolateBidirectionalText: true,
				mirrorHorizontalAlignment: true,
			},
			{
				controlId: imageDescription.id,
				property: "source",
				table: "Art",
				key: "logo",
				localeOverride: null,
				arguments: {},
				isolateBidirectionalText: true,
				mirrorHorizontalAlignment: true,
			},
		];
		const evidence = await applyGUIAuthoringRuntime(gui, state, { rootUrl: "/scene/", scene, localization });
		expect(evidence).toMatchObject({ localizationBindingCount: 2, localizations: [{ resolvedLocale: "en", direction: "ltr" }, { assetPath: "assets/logo.png" }] });
		expect(title.text).toBe("\u2066Ready\u2069");
		expect(image.source).toBe("/scene/assets/logo.png");
		localization.setLocale("ar");
		await vi.waitFor(() => expect(title.text).toBe("\u2067جاهز\u2069"));
		expect(title.textHorizontalAlignment).toBe(2);
		expect(image.source).toBe("/scene/assets/logo-ar.png");
		state.localizations = [];
		await applyGUIAuthoringRuntime(gui, state, { rootUrl: "/scene/", scene, localization });
		expect(title.textHorizontalAlignment).toBe(0);
		expect(title.text).toBe("Ready");
		expect(image.source).toBe("");
	});
});
