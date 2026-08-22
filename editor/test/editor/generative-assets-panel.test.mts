import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { readFile, readJSON } from "fs-extra";
import { join } from "path/posix";

import { EditorGenerativeAssets } from "../../src/editor/layout/generative-assets";

describe("EditorGenerativeAssets", () => {
	test("ships a permanent layout tab and renders the complete generation workflow", async () => {
		const layout = await readJSON(join(import.meta.dirname, "../../src/editor/layout.json"));
		const tabs: any[] = [];
		const visit = (node: any): void => {
			if (node?.type === "tab") tabs.push(node);
			node?.children?.forEach(visit);
		};
		visit(layout.layout);
		expect(tabs).toContainEqual(
			expect.objectContaining({ id: "generative-assets", name: "Generative Assets", component: "generative-assets", enableClose: false, enableRenderOnDemand: false })
		);
		expect(tabs).toHaveLength(21);
		const editorControlTools = await readFile(join(import.meta.dirname, "../../../mcp/src/tools/editor-controls.mts"), "utf8");
		expect(editorControlTools).toContain('"generative-assets"');

		const markup = renderToStaticMarkup(createElement(EditorGenerativeAssets, { editor: {} as any }));
		expect(markup).toContain("data-generative-assets-workspace");
		expect(markup).toContain("Image · Sprite · PBR Material · Animation · Audio");
		expect(markup).toContain("data-generative-provider-select");
		expect(markup).toContain("data-generative-modality");
		expect(markup).toContain("data-generative-prompt");
		expect(markup).toContain("data-generative-references");
		expect(markup).toContain("data-generative-parameters");
		expect(markup).toContain("data-generative-start");
		expect(markup).toContain("Providers");
		expect(markup).toContain("Results &amp; Publish");
	});
});
