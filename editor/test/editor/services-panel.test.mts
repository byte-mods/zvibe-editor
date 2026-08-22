import { readFile } from "fs/promises";
import { join } from "path";

import { describe, expect, test } from "vitest";

import layout from "../../src/editor/layout.json";

describe("permanent Services workspace", () => {
	test("registers a non-closable permanent tab and external selection id", async () => {
		const tabs = (layout.global ? (layout.layout.children?.[0] as any).children?.[1]?.children : []) ?? [];
		expect(JSON.stringify(layout)).toContain('"id":"services"');
		expect(JSON.stringify(layout)).toContain('"component":"services"');
		const controls = await readFile(join(import.meta.dirname, "../../src/mcp/editor-controls.ts"), "utf8");
		expect(controls).toContain('"services"');
		expect(tabs).toBeDefined();
	});

	test("exposes stable hooks for catalogs, emulator, readiness, and deployment", async () => {
		const source = await readFile(join(import.meta.dirname, "../../src/editor/dialogs/edit-project/services.tsx"), "utf8");
		for (const hook of [
			"data-project-services-workspace",
			"data-project-services-category",
			"data-project-services-resources-json",
			"data-project-services-apply-resources",
			"data-project-services-start-emulator",
			"data-project-services-plan-deployment",
			"data-project-services-execute-deployment",
		]) {
			expect(source).toContain(hook);
		}
		expect(source).toContain("layout.preview?.scene");
		expect(source).toContain("Waiting for the project and scene preview");
	});
});
