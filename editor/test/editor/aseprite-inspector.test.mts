import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { EditorFileInspector, FileInspectorObject } from "../../src/editor/layout/inspector/file";
import { EditorInspectorAsepriteComponent } from "../../src/editor/layout/inspector/file/aseprite";

function artifact(layerMode: "composite" | "compositeAndLayers" = "compositeAndLayers"): any {
	return {
		current: true,
		exists: true,
		dependencies: [{ path: "assets/shared.aseprite" }],
		result: {
			atlasImageBytes: 4096,
			settings: { layerMode },
			document: {
				width: 64,
				height: 32,
				colorDepth: 32,
				frameCount: 3,
				layers: [
					{ index: 0, name: "Character", type: "group", childLevel: 0, visible: true, blendMode: "normal", opacity: 255 },
					{ index: 1, name: "Sword", type: "image", childLevel: 1, visible: false, blendMode: "multiply", opacity: 128 },
				],
				tags: [],
				slices: [{ name: "Body", ninePatch: true }],
				tilesets: [{}],
				celUserData: [{ frameIndex: 1, layerIndex: 1, text: "Hit" }],
				warnings: ["External tileset rebound."],
			},
			dependencies: [{ path: "assets/shared.aseprite" }],
			atlas: {
				width: 128,
				height: 64,
				statistics: { entryCount: 9 },
				frameTags: [{ name: "Attack", from: 0, to: 2, direction: "pingpong", repeat: 0 }],
			},
		},
	};
}

describe("Aseprite File Inspector", () => {
	test("renders artifact fidelity, hierarchy, playback controls, and both scene creation modes", () => {
		const markup = renderToStaticMarkup(createElement(EditorInspectorAsepriteComponent, { artifact: artifact(), onInstantiate: vi.fn() }));
		for (const text of [
			"Aseprite Sprite Import",
			"Current",
			"64×32",
			"3 frames",
			"Layer hierarchy",
			"Sword",
			"Attack (0–2, pingpong, repeat ∞)",
			"Body (9-slice)",
			"External dependencies: 1",
			"Events: 1",
			"External tileset rebound.",
			"Instantiate Composite",
			"Instantiate Layer Hierarchy",
		]) {
			expect(markup).toContain(text);
		}
		expect(markup).not.toContain('Instantiate Layer Hierarchy" disabled');
	});

	test("disables layer instantiation without layer artifacts and routes both Aseprite extensions to the specialized panel", () => {
		const markup = renderToStaticMarkup(createElement(EditorInspectorAsepriteComponent, { artifact: artifact("composite"), onInstantiate: vi.fn() }));
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Instantiate Layer Hierarchy<\/button>/);
		for (const extension of ["ase", "aseprite"]) {
			const routed = renderToStaticMarkup(
				createElement(EditorFileInspector, {
					object: new FileInspectorObject(`/project/assets/hero.${extension}`),
					editor: {} as any,
				})
			);
			expect(routed).toContain("Aseprite Sprite Import");
			expect(routed).toContain("Apply the Aseprite Importer");
		}
	});
});
