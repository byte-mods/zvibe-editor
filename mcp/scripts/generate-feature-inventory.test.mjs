import assert from "node:assert/strict";
import test from "node:test";

import {
	parseEndpointDomains,
	parseExtensionLiterals,
	parseLayoutTabs,
	parseNamedExtensionArray,
	parseParityTables,
	renderFeatureInventory,
} from "./generate-feature-inventory.mjs";

test("parses endpoint domains, layout tabs, and extension literals deterministically", () => {
	const domains = parseEndpointDomains("export const MCPEndpoints = {\n\t// Scene\n\tget_scene: read,\n\tset_scene: write,\n\n\t// Assets\n\tget_asset: read,\n};\n");
	assert.deepEqual(
		[...domains],
		[
			["Scene", ["get_scene", "set_scene"]],
			["Assets", ["get_asset"]],
		]
	);
	assert.deepEqual(parseLayoutTabs({ layout: { type: "row", children: [{ type: "tab", id: "one", name: "One", component: "one" }] } }), [
		{ id: "one", name: "One", component: "one" },
	]);
	assert.deepEqual(parseExtensionLiterals('const a = [".PNG", ".jpg", ".png"];'), [".jpg", ".png"]);
	assert.deepEqual(parseNamedExtensionArray('export const excluded: readonly string[] = [".JSON"];', "excluded"), [".json"]);
});

test("parses only the two authoritative parity tables", () => {
	const parsed = parseParityTables(
		"| ID | Workstream | Current status |\n| --- | --- | --- |\n| #729 | Atlas | **Complete / Tested** |\n" +
			"| Area | Capability | Editor | MCP | Status |\n| --- | --- | --- | --- | --- |\n| Scene | Hierarchy | Built | Tools | Complete |\n"
	);
	assert.deepEqual(parsed, {
		featureFamilies: [{ area: "Scene", capability: "Hierarchy", status: "Complete" }],
		releaseDelta: [{ id: "#729", capability: "Atlas", status: "Complete / Tested" }],
	});
});

test("renders honest totals and completed direct UI status", () => {
	const output = renderFeatureInventory({
		featureFamilies: [{ area: "Scene", capability: "Hierarchy", status: "Complete" }],
		releaseDelta: [{ id: "#729", capability: "Atlas", status: "Complete / Tested" }],
		endpointDomains: new Map([["Scene", ["get_scene"]]]),
		tools: [
			{ name: "get_scene", description: "Read scene." },
			{ name: "execute_batch", description: "Batch." },
		],
		tabs: [{ id: "preview", name: "Preview", component: "preview" }],
		guardExtensions: [".png"],
		placementExclusions: [".json"],
		missingGuardExtensions: [],
		toolModules: [],
		evaluations: [],
		liveScenarios: [],
		editorTests: [],
		toolsTests: [],
		codexConfigured: true,
		claudeConfigured: true,
	});
	assert.match(output, /1\/1 Complete/);
	assert.match(output, /\| Preview \(`preview`\) \| `preview` \| Available \| Complete \|/);
	assert.match(output, /MCP-only tools: `execute_batch`/);
	assert.match(output, /Intentional project-file exclusions \(1\): `.json`/);
	assert.match(output, /Unexplained built\/exported extensions missing from that guard \(0\): none/);
	assert.match(output, /Hosted services and deployment adapters .* Complete .* Complete/);
	assert.match(output, /Portable Aseprite .* Complete .* Automated\/MCP\/direct UI pass; Claude-compatible contract validated/);
	assert.match(output, /Portable FBX export\/round-trip .* Complete .* Automated\/real Blender\/MCP\/direct UI pass/);
	assert.match(output, /None\. The audited provider-neutral Babylon\/JavaScript feature families are complete/);
	assert.match(output, /No remaining implementable provider-neutral Babylon\/JavaScript feature family is currently identified/);
});
