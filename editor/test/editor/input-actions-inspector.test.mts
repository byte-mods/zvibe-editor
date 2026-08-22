import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { InputActionsSceneInspector } from "../../src/editor/layout/inspector/scene/input-actions";

describe("editor Input Actions Scene Inspector", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = { layout: { inspector: { forceUpdate: vi.fn() } } };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("renders complete map action binding scheme settings and runtime authoring", () => {
		scene.metadata = {
			babylonEditorInputActionMaps: [
				{
					version: 2,
					revision: 7,
					id: "gameplay",
					name: "Gameplay",
					enabled: true,
					actions: [
						{
							id: "move",
							name: "Move",
							type: "value",
							expectedControlType: "vector2",
							enabled: true,
							initialStateCheck: true,
							processors: [{ type: "stickDeadzone", min: 0.1, max: 0.9 }],
							interactions: [{ type: "hold", duration: 0.4 }],
							bindings: [
								{
									id: "wasd",
									groups: ["KeyboardMouse"],
									composite: {
										type: "vector2",
										parts: [
											{ name: "Up", path: "<keyboard>/keyw" },
											{ name: "Down", path: "<keyboard>/keys" },
											{ name: "Left", path: "<keyboard>/keya" },
											{ name: "Right", path: "<keyboard>/keyd" },
										],
									},
								},
							],
						},
					],
					controlSchemes: [{ id: "keyboard-mouse", name: "Keyboard + Mouse", devices: ["keyboard", "mouse"] }],
				},
			],
		};

		const markup = renderToStaticMarkup(createElement(InputActionsSceneInspector, { scene, editor }));
		for (const label of [
			"Input Actions",
			"Dynamic",
			"Fixed",
			"Manual",
			"Deadzone min",
			"Press point",
			"Trace cap",
			"Gameplay",
			"Actions",
			"Move",
			"Pass-Through",
			"Vector2",
			"Initial state check",
			"Processors",
			"stickDeadzone",
			"Interactions",
			"hold",
			"Bindings",
			"vector2",
			"KeyboardMouse",
			"Control schemes",
			"Keyboard + Mouse",
			"gamepad",
			"touch",
			"TypeScript wrapper",
			"Runtime diagnostics",
			"Start preview/runtime",
		]) {
			expect(markup).toContain(label);
		}
	});

	test("renders the empty authoring state without creating scene metadata", () => {
		const markup = renderToStaticMarkup(createElement(InputActionsSceneInspector, { scene, editor }));
		expect(markup).toContain("Add map");
		expect(markup).toContain("Runtime diagnostics");
		expect(scene.metadata).toBeNull();
	});
});
