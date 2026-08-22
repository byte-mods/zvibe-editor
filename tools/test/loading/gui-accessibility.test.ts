import { afterEach, describe, expect, test, vi } from "vitest";

import {
	announceGUIAccessibility,
	applyGUIAccessibilityRuntime,
	auditGUIAccessibility,
	createDefaultGUIAccessibilityState,
	focusGUIAccessibilityNode,
	invokeGUIAccessibilityAction,
	updateGUIAccessibilityDirection,
} from "../../src/loading/gui-accessibility";

class FakeElement {
	public readonly attributes = new Map<string, string>();
	public readonly children: FakeElement[] = [];
	public readonly listeners = new Map<string, Array<() => void>>();
	public readonly style = { cssText: "" };
	public tabIndex = -1;
	public textContent = "";
	public removed = false;

	public setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	public appendChild(child: FakeElement): void {
		this.children.push(child);
	}

	public addEventListener(name: string, callback: () => void): void {
		const listeners = this.listeners.get(name) ?? [];
		listeners.push(callback);
		this.listeners.set(name, listeners);
	}

	public focus(): void {
		this.listeners.get("focus")?.forEach((listener) => listener());
	}

	public remove(): void {
		this.removed = true;
	}
}

describe("GUI accessibility runtime", () => {
	afterEach(() => vi.unstubAllGlobals());

	test("bridges semantics, preferences, focus, actions, announcements, direction, and cleanup", () => {
		const body = new FakeElement();
		vi.stubGlobal("document", { body, createElement: vi.fn(() => new FakeElement()) });
		const gui = {};
		const click = vi.fn();
		const focus = vi.fn();
		const controls = new Map([
			["play", { text: "Play", fontSize: 16, fontWeight: "400", onPointerClickObservable: { notifyObservers: click }, onFocusObservable: { notifyObservers: focus } }],
			["title", { text: "Main Menu", fontSize: "20px", fontWeight: "400" }],
		]);
		const state = createDefaultGUIAccessibilityState();
		state.settings.enabled = true;
		state.nodes = [
			{
				controlId: "play",
				role: "button",
				label: "Play game",
				hint: "Starts a new game",
				value: "",
				focusOrder: 1,
				allowsDirectInteraction: false,
				actions: ["activate"],
				live: "off",
			},
		];
		let cleanup: (() => void) | null = null;
		const evidence = applyGUIAccessibilityRuntime({
			gui,
			guiName: "HUD",
			state,
			descriptions: [
				{ id: "play", parentId: null, name: "Play", type: "Button", path: "Play" },
				{ id: "title", parentId: null, name: "Title", type: "TextBlock", path: "Title" },
			],
			controls,
			direction: "ltr",
			platformPreferences: { textScale: 1.5, boldText: true, captionsEnabled: true },
			onCleanup: (callback) => (cleanup = callback),
		});
		expect(evidence).toMatchObject({
			enabled: true,
			bridgeAvailable: true,
			nodeCount: 2,
			autoNodeCount: 1,
			focusableNodeCount: 1,
			preferences: { textScale: 1.5, boldText: true, captionsEnabled: true },
		});
		expect(controls.get("play")).toMatchObject({ fontSize: 24, fontWeight: "bold" });
		focusGUIAccessibilityNode(gui, "play");
		expect(focus).toHaveBeenCalledOnce();
		invokeGUIAccessibilityAction(gui, "play", "activate");
		expect(click).toHaveBeenCalledOnce();
		announceGUIAccessibility(gui, "Level loaded", "assertive");
		updateGUIAccessibilityDirection(gui, "rtl");
		expect(evidence.direction).toBe("rtl");
		expect(body.children[0].attributes.get("dir")).toBe("rtl");
		expect(body.children[0].children.at(-1)?.textContent).toBe("Level loaded");
		cleanup!();
		expect(body.children[0].removed).toBe(true);
		expect(controls.get("play")).toMatchObject({ fontSize: 16, fontWeight: "400" });
	});

	test("audits semantics, focus order, target size, alpha contrast, and image samples", () => {
		const state = createDefaultGUIAccessibilityState();
		state.settings.enabled = true;
		state.nodes = [
			{ controlId: "button", role: "button", label: "", hint: "", value: "", focusOrder: 1, allowsDirectInteraction: false, actions: ["activate"], live: "off" },
			{ controlId: "imageText", role: "staticText", label: "Caption", hint: "", value: "", focusOrder: 1, allowsDirectInteraction: false, actions: [], live: "off" },
		];
		const report = auditGUIAccessibility(
			[
				{
					id: "panel",
					parentId: null,
					name: "Panel",
					type: "Rectangle",
					path: "Panel",
					text: "",
					fontSize: null,
					fontWeight: "400",
					foreground: null,
					background: "#ffffff",
					alpha: 1,
					width: 400,
					height: 300,
					visible: true,
					enabled: true,
					hasImageBackground: false,
					backgroundSamples: null,
				},
				{
					id: "button",
					parentId: "panel",
					name: "Play",
					type: "Button",
					path: "Panel / Play",
					text: "Play",
					fontSize: 11,
					fontWeight: "400",
					foreground: "rgba(119,119,119,0.8)",
					background: "rgba(255,255,255,0.5)",
					alpha: 1,
					width: 32,
					height: 32,
					visible: true,
					enabled: true,
					hasImageBackground: false,
					backgroundSamples: null,
				},
				{
					id: "imageText",
					parentId: null,
					name: "Caption",
					type: "TextBlock",
					path: "Caption",
					text: "Caption",
					fontSize: 16,
					fontWeight: "400",
					foreground: "#777777",
					background: null,
					alpha: 1,
					width: 200,
					height: 40,
					visible: true,
					enabled: true,
					hasImageBackground: true,
					backgroundSamples: [
						[0, 0, 0, 1],
						[255, 255, 255, 1],
					],
				},
			],
			state
		);
		expect(report.errorCount).toBeGreaterThanOrEqual(3);
		expect(report.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining(["smallText", "missingSemanticLabel", "duplicateFocusOrder", "smallTarget", "lowTextContrast"])
		);
		expect(report.issues.filter((issue) => issue.code === "lowTextContrast").some((issue) => issue.contrastRatio! < 4.5)).toBe(true);
	});

	test("replaces a directly-applied bridge without leaking font transforms or DOM roots", () => {
		const body = new FakeElement();
		vi.stubGlobal("document", { body, createElement: vi.fn(() => new FakeElement()) });
		const gui = {};
		const controls = new Map([["title", { text: "Title", fontSize: 20, fontWeight: "400" }]]);
		const state = createDefaultGUIAccessibilityState();
		state.settings.enabled = true;
		state.settings.textScale = 2;
		const cleanups: Array<() => void> = [];
		const options = {
			gui,
			guiName: "HUD",
			state,
			descriptions: [{ id: "title", parentId: null, name: "Title", type: "TextBlock", path: "Title" }],
			controls,
			direction: "ltr" as const,
			onCleanup: (callback: () => void) => cleanups.push(callback),
		};
		applyGUIAccessibilityRuntime(options);
		expect(controls.get("title")?.fontSize).toBe(40);
		state.settings.textScale = 1.5;
		applyGUIAccessibilityRuntime(options);
		expect(body.children[0].removed).toBe(true);
		expect(controls.get("title")?.fontSize).toBe(30);
		cleanups[0]();
		expect(controls.get("title")?.fontSize).toBe(30);
		cleanups[1]();
		expect(controls.get("title")?.fontSize).toBe(20);
	});
});
