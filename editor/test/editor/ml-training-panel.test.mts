import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { readFile, readJSON } from "fs-extra";
import { join } from "path/posix";

import { EditorMlTraining } from "../../src/editor/layout/ml-training";

describe("EditorMlTraining", () => {
	test("ships a permanent tab and renders agent, dataset, trainer, and checkpoint workflows", async () => {
		const layout = await readJSON(join(import.meta.dirname, "../../src/editor/layout.json"));
		const tabs: any[] = [];
		const visit = (node: any): void => {
			if (node?.type === "tab") tabs.push(node);
			node?.children?.forEach(visit);
		};
		visit(layout.layout);
		expect(tabs).toContainEqual(expect.objectContaining({ id: "ml-training", name: "ML Training", component: "ml-training", enableClose: false, enableRenderOnDemand: false }));
		expect(tabs).toHaveLength(21);
		const editorControlTools = await readFile(join(import.meta.dirname, "../../../mcp/src/tools/editor-controls.mts"), "utf8");
		expect(editorControlTools).toContain('"ml-training"');

		const markup = renderToStaticMarkup(createElement(EditorMlTraining, { editor: {} as any }));
		const source = await readFile(join(import.meta.dirname, "../../src/editor/layout/ml-training.tsx"), "utf8");
		expect(markup).toContain("data-ml-training-workspace");
		expect(markup).toContain("Agent Authoring");
		expect(markup).toContain("Demonstrations");
		expect(markup).toContain("Trainers");
		expect(markup).toContain("Jobs &amp; Checkpoints");
		expect(markup).toContain("data-ml-training-configuration-json");
		expect(source).toContain("data-ml-training-episode-json");
		expect(source).toContain("data-ml-training-provider-json");
		expect(source).toContain("data-ml-training-start-job");
	});
});
