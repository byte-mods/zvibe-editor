import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Color3, NodeMaterialBlockConnectionPointTypes, Vector3 } from "babylonjs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jniac/color-xplr", () => ({
	Color: class {},
	createColorXplr: vi.fn(),
}));

import { EditorNodeMaterialInspector } from "../../src/editor/layout/inspector/material/node";

describe("EditorNodeMaterialInspector", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders every visible input block with a stable React list key", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const inputs = [
			{
				uniqueId: 1,
				name: "Tint",
				visibleInInspector: true,
				groupInInspector: "Surface",
				type: NodeMaterialBlockConnectionPointTypes.Color3,
				value: new Color3(1, 0.5, 0.25),
				comments: "Tint color",
			},
			{
				uniqueId: 2,
				name: "Direction",
				visibleInInspector: true,
				groupInInspector: "Surface",
				type: NodeMaterialBlockConnectionPointTypes.Vector3,
				value: new Vector3(0, 1, 0),
				comments: "Direction vector",
			},
		];
		const inspector = new EditorNodeMaterialInspector({
			material: {
				getInputBlocks: () => inputs,
				metadata: {},
			} as any,
			editor: {} as any,
		});
		const editableBlocks = (inspector as any)._getEditableBlocks();
		const markup = renderToStaticMarkup(createElement(Fragment, null, ...editableBlocks));

		expect(markup).toContain("Tint");
		expect(markup).toContain("Direction");
		expect(consoleError.mock.calls.flat().join(" ")).not.toContain('unique "key" prop');
	});
});
