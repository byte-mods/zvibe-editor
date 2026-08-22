import { describe, expect, test } from "vitest";

import { MeshBuilder, NullEngine, Scene, StandardMaterial } from "@babylonjs/core";

import {
	createDefaultGUIToolkitState,
	createGUIPanelRendererTexture,
	getGUIPanelRendererEvidence,
	normalizeGUIToolkitState,
	planGUIUXMLUpgrades,
	releaseGUIPanelRendererTexture,
	sampleGUIAnimation,
} from "../../src";

describe("portable UI Toolkit 6.5 runtime", () => {
	test("plans deterministic exact UXML upgrades without evaluating source", async () => {
		const source = `<ui:UXML xmlns:ui="UnityEngine.Experimental.UIElements"><ui:Button name="play" className="primary" picking-mode="Ignore" focus-index="2" visible="false"/></ui:UXML>`;
		const first = await planGUIUXMLUpgrades("assets/ui/legacy.uxml", source);
		const second = await planGUIUXMLUpgrades("assets/ui/legacy.uxml", source);
		expect(first).toEqual(second);
		expect(first.sourceRevision).toMatch(/^[a-f\d]{64}$/);
		expect(first.edits.map((edit) => edit.rule)).toEqual(["legacy-namespace", "class-name", "picking-mode", "focus-index", "visible"]);
		expect(first.upgradedSource).toContain(`xmlns:ui="UnityEngine.UIElements"`);
		expect(first.upgradedSource).toContain(`class="primary" pointer-events="none" tabindex="2" display="none"`);
	});

	test("normalizes references, overrides, animations, staging, and exact constraints", () => {
		const state = normalizeGUIToolkitState({
			...createDefaultGUIToolkitState(),
			references: [{ id: "play-ref", controlId: "play", expectedTypeName: "Button" }],
			attributeOverrides: [{ controlId: "play", property: "alpha", value: 0.75 }],
			animations: [{ id: "pulse", controlId: "play", property: "alpha", from: 0, to: 1, durationMs: 1000, delayMs: 0, easing: "easeInOut", loop: false, autoplay: true }],
			stylesheetStage: { contextId: "root", activeStylesheetPath: "assets/ui/hud.uss", stylesheetOrder: ["assets/ui/hud.uss"] },
		});
		expect(state.references[0]).toMatchObject({ id: "play-ref", expectedTypeName: "Button" });
		expect(sampleGUIAnimation(state.animations[0], 500).value).toBeCloseTo(0.5);
		expect(sampleGUIAnimation(state.animations[0], 1000)).toMatchObject({ completed: true, value: 1 });
		expect(() => normalizeGUIToolkitState({ ...state, references: [...state.references, state.references[0]] })).toThrow(/duplicated/);
		expect(() => normalizeGUIToolkitState({ ...state, panelRenderer: { ...state.panelRenderer, renderMode: "worldSpace", targetMeshId: null } })).toThrow(
			/requires targetMeshId/
		);
	});

	test("creates and releases a real Babylon mesh-backed PanelRenderer while restoring material ownership", () => {
		const previousOffscreenCanvas = globalThis.OffscreenCanvas;
		class TestOffscreenCanvas {
			public width: number;
			public height: number;

			public constructor(width: number, height: number) {
				this.width = width;
				this.height = height;
			}

			public getContext(): object {
				return {};
			}
		}
		Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, writable: true, value: TestOffscreenCanvas });
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const mesh = MeshBuilder.CreatePlane("panel-mesh", { size: 2 }, scene);
		const originalMaterial = new StandardMaterial("original", scene);
		mesh.material = originalMaterial;
		const settings = {
			...createDefaultGUIToolkitState().panelRenderer,
			renderMode: "worldSpace" as const,
			targetMeshId: mesh.id,
			textureWidth: 512,
			textureHeight: 256,
		};
		const gui = createGUIPanelRendererTexture(scene, "World HUD", settings);
		expect(getGUIPanelRendererEvidence(gui, settings)).toMatchObject({
			renderMode: "worldSpace",
			nativeFullscreen: false,
			nativeMeshAttached: true,
			textureSize: { width: 512, height: 256 },
		});
		expect(mesh.material).not.toBe(originalMaterial);
		expect(releaseGUIPanelRendererTexture(gui, true)).toMatchObject({ restoredMaterial: true, releasedControlCount: 0 });
		expect(mesh.material).toBe(originalMaterial);
		scene.dispose();
		engine.dispose();
		Object.defineProperty(globalThis, "OffscreenCanvas", { configurable: true, writable: true, value: previousOffscreenCanvas });
	});
});
