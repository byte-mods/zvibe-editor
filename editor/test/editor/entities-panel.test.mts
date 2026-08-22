import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { createDefaultECSConfiguration } from "babylonjs-editor-tools";

import { EditorEntities } from "../../src/editor/layout/entities";

describe("EditorEntities", () => {
	test("renders configuration, runtime evidence, sections, and debugger navigation", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.metadata = { babylonEditorECS: createDefaultECSConfiguration() };
		const node = new TransformNode("Unit", scene);
		node.id = "unit";
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "entity", type: "entity", enabled: true, data: { archetype: "Unit", sectionId: "main", values: {}, components: {}, bakingEnabled: true } }],
			},
		};
		const editor = { layout: { preview: { scene }, inspector: { forceUpdate: vi.fn() }, entities: { forceUpdate: vi.fn() } } } as any;
		const markup = renderToStaticMarkup(createElement(EditorEntities, { editor }));
		expect(markup).toContain("Entities · not baked");
		expect(markup).toContain("Bake Incremental");
		expect(markup).toContain("Delete ECS Asset");
		expect(markup).toContain("Configuration revision");
		expect(markup).toContain("Portable Burst-style layout");
		expect(markup).toContain("configuration");
		expect(markup).toContain("traces");
		scene.dispose();
		engine.dispose();
	});
});
