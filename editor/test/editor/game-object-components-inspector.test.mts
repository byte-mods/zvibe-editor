import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { createDefaultECSConfiguration } from "babylonjs-editor-tools";

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

	test("renders structured typed Entity authoring fields and configured streaming sections", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const configuration = createDefaultECSConfiguration();
		configuration.componentTypes.push({
			id: "motion",
			name: "Motion",
			namespace: "Game.Entities",
			assembly: "game",
			builtIn: false,
			fields: [{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0] }],
		});
		configuration.sections.push({ id: "combat", name: "Combat", autoLoad: false, priority: 1 });
		scene.metadata = { babylonEditorECS: configuration };
		const node = new TransformNode("Entity", scene);
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "entity",
						type: "entity",
						enabled: true,
						data: { version: 2, archetype: "Unit", sectionId: "combat", values: {}, components: { motion: { velocity: [1, 2, 3] } }, bakingEnabled: true },
					},
				],
			},
		};
		const markup = renderToStaticMarkup(createElement(GameObjectComponentsInspector, { object: node, editor: {} as any }));
		expect(markup).toContain("Archetype label");
		expect(markup).toContain("Streaming section");
		expect(markup).toContain("Hidden in Hierarchy");
		expect(markup).toContain("Combat");
		expect(markup).toContain("Motion");
		expect(markup).toContain("Velocity");
		expect(markup).toContain("1, 2, 3");
		scene.dispose();
		engine.dispose();
	});

	test("renders every Network Replication authoring control", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = new TransformNode("Player", scene);
		node.id = "player";
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "network",
						type: "network",
						enabled: true,
						data: { networkId: "player-body", authority: "owner", syncTransform: true, syncAnimation: true, sendRateHz: 30, interpolate: false },
					},
				],
			},
		};
		const markup = renderToStaticMarkup(createElement(GameObjectComponentsInspector, { object: node, editor: {} as any }));
		expect(markup).toContain("Network Replication");
		expect(markup).toContain("Network id");
		expect(markup).toContain("player-body");
		expect(markup).toContain("Authority");
		expect(markup).toContain("Server authoritative");
		expect(markup).toContain("Owner authoritative");
		expect(markup).toContain("Sync transform");
		expect(markup).toContain("Sync animation groups");
		expect(markup).toContain("Interpolate remote transforms");
		expect(markup).toContain("Send rate (Hz)");
		scene.dispose();
		engine.dispose();
	});
});
