import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import { GameObjectComponentsInspector } from "../../src/editor/layout/inspector/components/game-object-components";

describe("editor/game-object-components-inspector", () => {
	test("renders the required Transform, persisted data rows, and Add Component controls", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = new TransformNode("Actor", scene);
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "health", type: "data", enabled: true, data: { name: "Health", values: { current: 100 } } }],
			},
		};
		const markup = renderToStaticMarkup(createElement(GameObjectComponentsInspector, { object: node, editor: {} as any }));
		expect(markup).toContain("Component Stack");
		expect(markup).toContain("Transform");
		expect(markup).toContain("Health");
		expect(markup).toContain("Add Component");
		expect(markup).not.toContain("Paste Values");
		scene.dispose();
		engine.dispose();
	});
});
