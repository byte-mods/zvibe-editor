import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { getGUIContent, listGUIs, setGUIContent, validateGUIAccessibility } from "../../src/mcp/gui/gui";

describe("mcp/gui", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("reads and replaces an active fullscreen GUI control tree", () => {
		const gui = {
			uniqueId: 42,
			name: "HUD",
			_isFullscreen: true,
			rootContainer: { children: [{ name: "Title" }] },
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

	test("reports basic accessibility concerns without changing GUI controls", () => {
		const gui = {
			uniqueId: 43,
			name: "HUD",
			_isFullscreen: true,
			rootContainer: {
				children: [
					{ name: "Health", fontSize: 10, getClassName: () => "TextBlock" },
					{ name: "Health", getClassName: () => "TextBlock" },
					{ name: "", text: "", getClassName: () => "Button" },
					{ name: "Low Contrast", color: "#777777", background: "#888888", getClassName: () => "TextBlock" },
				],
			},
			getClassName: () => "AdvancedDynamicTexture",
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);

		const report = validateGUIAccessibility(scene, { guiId: "43" });
		expect(report).toMatchObject({ guiCount: 1, controlCount: 4, warningCount: 4 });
		expect(report.issues.map((issue: any) => issue.code)).toEqual(["smallText", "duplicateControlName", "unlabeledInteractiveControl", "lowTextContrast"]);
		expect(report.issues[3].contrastRatio).toBeLessThan(4.5);
	});
});
