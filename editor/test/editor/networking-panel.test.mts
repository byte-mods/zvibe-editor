import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { readJSON } from "fs-extra";
import { join } from "path/posix";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { createDefaultNetworkingConfiguration } from "babylonjs-editor-tools";

import { EditorNetworking } from "../../src/editor/layout/networking";

describe("EditorNetworking", () => {
	test("ships a permanent layout tab and renders the complete authored/runtime workflow", async () => {
		const layout = await readJSON(join(import.meta.dirname, "../../src/editor/layout.json"));
		const tabs: any[] = [];
		const visit = (node: any): void => {
			if (node?.type === "tab") {
				tabs.push(node);
			}
			node?.children?.forEach(visit);
		};
		visit(layout.layout);
		expect(tabs).toContainEqual(expect.objectContaining({ id: "networking", name: "Networking", component: "networking", enableClose: false, enableRenderOnDemand: false }));

		const engine = new NullEngine();
		const scene = new Scene(engine);
		const configuration = createDefaultNetworkingConfiguration();
		configuration.enabled = true;
		scene.metadata = { babylonEditorNetworking: configuration };
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
						data: { networkId: "player", authority: "owner", syncTransform: true, syncAnimation: true, sendRateHz: 30, interpolate: true },
					},
				],
			},
		};
		const editor = {
			layout: {
				preview: { scene, play: { state: { playing: false }, scene: null } },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				networking: { forceUpdate: vi.fn() },
			},
		} as any;
		const markup = renderToStaticMarkup(createElement(EditorNetworking, { editor }));
		expect(markup).toContain("Network Manager");
		expect(markup).toContain("Gameplay Session Host");
		expect(markup).toContain("Replication");
		expect(markup).toContain("Prediction and Reconciliation");
		expect(markup).toContain("Multiplayer Play Mode (1–4 players)");
		expect(markup).toContain("Network Simulation");
		expect(markup).toContain("Session Policy and Diagnostics");
		expect(markup).toContain("1 replicated objects");
		expect(markup).toContain("Start Loopback Host");
		expect(markup).toContain("Start Players");
		scene.dispose();
		engine.dispose();
	});
});
