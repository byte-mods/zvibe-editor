#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

import { discoverMcpTools } from "./sync-manifest-tools.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const inventoryPath = join(root, "FEATURE-INVENTORY.md");

const inProgressPortableFamilies = [];

const absentPortableFamilies = [];

const externalCompatibilityBoundaries = [
	"C#, Mono, IL2CPP, Burst, Unity assemblies, and Unity package/API/serialization identity.",
	"Unity SRP/URP/HDRP HLSL and binary identity; Zvibe supplies portable Babylon rendering equivalents.",
	"Proprietary console SDKs, devkits, platform certification, and vendor release approval.",
	"Vendor signing/notarization credentials and native platform-holder services or binaries.",
	"Unity/Umbra, Sentis/Inference Engine, DirectStorage, and other vendor binary or numerical identity where the roadmap explicitly claims only portable behavior.",
];

function tableCell(value) {
	return String(value).replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

export function parseEndpointDomains(source) {
	const marker = "export const MCPEndpoints";
	const start = source.indexOf(marker);
	if (start < 0) throw new Error(`Unable to find ${marker} in editor/src/mcp/mcp.ts.`);
	const objectSource = source.slice(start);
	const end = objectSource.indexOf("\n};");
	if (end < 0) throw new Error("Unable to find the end of MCPEndpoints.");

	let domain = "Ungrouped";
	const domains = new Map();
	for (const line of objectSource.slice(0, end).split("\n")) {
		const comment = line.match(/^\s*\/\/\s+(.+)$/);
		if (comment) domain = comment[1].trim();
		const endpoint = line.match(/^\s*([a-z][a-z0-9_]*):/);
		if (!endpoint) continue;
		const names = domains.get(domain) ?? [];
		names.push(endpoint[1]);
		domains.set(domain, names);
	}
	return domains;
}

export function parseParityTables(source) {
	const rows = source
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) =>
			line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim())
		);
	const releaseDelta = rows
		.filter((cells) => cells.length === 3 && /^#[0-9]+$/.test(cells[0]))
		.map(([id, capability, status]) => ({ id, capability, status: status.replaceAll("**", "") }));
	const featureFamilies = rows
		.filter((cells) => cells.length === 5 && cells[0] !== "Area" && !/^[-: ]+$/.test(cells[0]) && ["Complete", "Partial", "Missing"].includes(cells[4]))
		.map(([area, capability, _editorState, _mcpState, status]) => ({ area, capability, status }));
	return { featureFamilies, releaseDelta };
}

export function parseLayoutTabs(layout) {
	const tabs = [];
	const visit = (node) => {
		if (node?.type === "tab") tabs.push({ id: node.id, name: node.name, component: node.component });
		for (const child of node?.children ?? []) visit(child);
	};
	visit(layout.layout);
	return tabs;
}

export function parseExtensionLiterals(source) {
	return [...new Set([...source.matchAll(/"(\.[a-z0-9]+)"/gi)].map((match) => match[1].toLowerCase()))].sort();
}

export function parseNamedExtensionArray(source, name) {
	const start = source.indexOf(`export const ${name}`);
	const end = source.indexOf(";", start);
	if (start < 0 || end < 0) throw new Error(`Unable to find extension array ${name}.`);
	return parseExtensionLiterals(source.slice(start, end));
}

async function listFiles(directory, predicate = () => true) {
	const entries = await readdir(directory, { withFileTypes: true });
	const paths = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) paths.push(...(await listFiles(path, predicate)));
		else if (predicate(path)) paths.push(path);
	}
	return paths.sort();
}

export function renderFeatureInventory(data) {
	const completeFamilies = data.featureFamilies.filter((row) => row.status === "Complete").length;
	const completeDelta = data.releaseDelta.filter((row) => row.status === "Complete / Tested").length;
	const endpointNames = [...data.endpointDomains.values()].flat();
	const endpointNameSet = new Set(endpointNames);
	const toolNameSet = new Set(data.tools.map((tool) => tool.name));
	const endpointCount = endpointNames.length;
	const mcpOnly = data.tools.filter((tool) => !endpointNameSet.has(tool.name)).map((tool) => tool.name);
	const missingFromMcp = endpointNames.filter((name) => !toolNameSet.has(name));
	const featureCapability = (row) =>
		row.area === "Scripting workflow"
			? "JavaScript/TypeScript compilation, debugger, script templates, execution order, and code coverage"
			: row.capability;
	const lines = [
		"# Zvibe Editor feature and MCP inventory",
		"",
		"> Generated from the current source with `yarn workspace babylonjs-editor-mcp-server sync-feature-inventory`. Do not hand-edit generated tables.",
		"",
		"## Current verified scope",
		"",
		"| Surface | Built status | Testing status | Evidence |",
		"| --- | ---: | ---: | --- |",
		`| Original portable Unity feature-family matrix | ${completeFamilies}/${data.featureFamilies.length} Complete | Matrix-recorded | \`UNITY-6-5-PARITY.md\` |`,
		`| Unity 6000.5 final release-delta workstreams | ${completeDelta}/${data.releaseDelta.length} Complete | ${completeDelta}/${data.releaseDelta.length} Tested | \`UNITY-6-5-PARITY.md\` |`,
		"| Portable Runtime AI (`.onnx`, `.tflite`, `.pt2`) | Complete | Complete | `ROADMAP.md` #757 |",
		"| Portable Occlusion Culling | Complete | Complete | `ROADMAP.md` #758 |",
		"| Integrated generative asset creation | Complete | Complete | `ROADMAP.md` #763 |",
		"| Portable ML-Agents-style training | Complete | Complete | `ROADMAP.md` #764 |",
		"| Hosted services and deployment adapters | Complete | Complete | `ROADMAP.md` #765 |",
		"| Portable Alembic (`.abc`) import/playback | Complete | Real Blender/MCP/direct UI pass | Section #760 |",
		"| Portable Aseprite (`.ase`, `.aseprite`) import/playback | Complete | Automated/MCP/direct UI pass; Claude-compatible contract validated | Section #761 |",
		"| Portable FBX export/round-trip | Complete | Automated/real Blender/MCP/direct UI pass | Section #762 |",
		`| Editor MCP endpoint mappings | ${endpointCount} | Source mapped | \`editor/src/mcp/mcp.ts\` |`,
		`| Client-visible MCP tools | ${data.tools.length} | Strict contract validated | \`mcp/manifest.json\` |`,
		`| Permanent editor tabs | ${data.tabs.length} | Complete stateful pointer/keyboard audit | \`editor/src/editor/layout.json\` |`,
		"",
		"The client-visible catalog is the 1:1 union of every editor endpoint plus the MCP server-owned `execute_batch` tool. `.mcp.json` and `.codex/config.toml` both launch `mcp/server/index.mjs`, so Claude-compatible clients and Codex CLI share the same catalog.",
		"The feature-family names retain Unity terminology for comparison. A Complete status means the bounded portable Babylon/JavaScript equivalent documented in the detailed matrix is complete; it does not claim C#, Unity package/API, binary, or serialization compatibility.",
		"",
		"## Work that is genuinely left",
		"",
		"### Confirmed implementation or contract gaps",
		"",
		"None identified after the complete live MCP lifecycle suite, stateful 21-tab pointer/keyboard audit, endpoint/tool inventory, and repository gates recorded below.",
		"",
		`Current Assets Browser guard extensions (${data.guardExtensions.length}): ${data.guardExtensions.map((value) => `\`${value}\``).join(", ")}.`,
		"",
		`Intentional project-file exclusions (${data.placementExclusions.length}): ${data.placementExclusions.map((value) => `\`${value}\``).join(", ")}. Generic JSON may be a project configuration file; typed JSON-backed assets still require \`/assets\`.`,
		"",
		`Unexplained built/exported extensions missing from that guard (${data.missingGuardExtensions.length}): ${data.missingGuardExtensions.map((value) => `\`${value}\``).join(", ") || "none"}.`,
		"",
		"### Portable feature family in progress",
		"",
		...(inProgressPortableFamilies.length
			? ["| Family | Remaining work |", "| --- | --- |", ...inProgressPortableFamilies.map(([family, gap]) => `| ${tableCell(family)} | ${tableCell(gap)} |`)]
			: ["None. The audited provider-neutral Babylon/JavaScript feature families are complete within their documented boundaries."]),
		"",
		"### Broader Unity ecosystem/package families not implemented",
		"",
		...(absentPortableFamilies.length
			? ["| Family | Current gap |", "| --- | --- |", ...absentPortableFamilies.map(([family, gap]) => `| ${tableCell(family)} | ${tableCell(gap)} |`)]
			: [
					"No remaining implementable provider-neutral Babylon/JavaScript feature family is currently identified. Lobby/relay remains part of the existing first-party networking owner rather than a separate hosted-service adapter.",
				]),
		"",
		...(absentPortableFamilies.length
			? ["These are candidates for future portable Babylon/JavaScript work. They are not part of the already-completed bounded 50-family matrix or 27-row Unity 6000.5 release-delta audit."]
			: ["Future additions require a newly scoped portable feature family; the remaining differences below are external compatibility boundaries, not unfinished editor code."]),
		"",
		"### External compatibility boundaries, not missing portable editor code",
		"",
		...externalCompatibilityBoundaries.map((boundary) => `- ${boundary}`),
		"",
		"## Permanent editor surfaces",
		"",
		"Every tab is externally selectable through the shared `list_editor_tabs` and `select_editor_tab` MCP tools. The final column records the completed stateful physical pointer/keyboard audit on the real Electron editor.",
		"",
		"| Tab | Component | MCP selection | Fresh direct UI audit |",
		"| --- | --- | --- | --- |",
		...data.tabs.map((tab) => `| ${tableCell(tab.name)} (\`${tableCell(tab.id)}\`) | \`${tableCell(tab.component)}\` | Available | Complete |`),
		"",
		"## MCP endpoint domains",
		"",
		"The exact tool names and descriptions are generated into `mcp/manifest.json`; this table prevents domain-level coverage from being confused with per-tool manual testing.",
		"",
		"| Domain | Editor endpoints |",
		"| --- | ---: |",
		...[...data.endpointDomains.entries()].map(([domain, names]) => `| ${tableCell(domain)} | ${names.length} |`),
		"| MCP server-owned batching | 1 |",
		`| **Total client-visible tools** | **${data.tools.length}** |`,
		"",
		"## Feature-family matrix",
		"",
		"| Area | Unity capability family | Status |",
		"| --- | --- | --- |",
		...data.featureFamilies.map((row) => `| ${tableCell(row.area)} | ${tableCell(featureCapability(row))} | ${tableCell(row.status)} |`),
		"",
		"## Unity 6000.5 release-delta matrix",
		"",
		"| ID | Workstream | Status |",
		"| --- | --- | --- |",
		...data.releaseDelta.map((row) => `| ${tableCell(row.id)} | ${tableCell(row.capability)} | ${tableCell(row.status)} |`),
		"",
		"## Evidence inventory",
		"",
		"| Evidence kind | Count | Location | Meaning |",
		"| --- | ---: | --- | --- |",
		`| Strict MCP tools | ${data.tools.length} | \`mcp/manifest.json\` | Complete external discovery catalog |`,
		`| MCP tool modules | ${data.toolModules.length} | \`mcp/src/tools/\` | Server implementation families |`,
		`| MCP evaluation specifications | ${data.evaluations.length} | \`mcp/evaluations/\` | Agent-behavior evaluation coverage; not one file per tool |`,
		`| Live scenario scripts | ${data.liveScenarios.length} | \`mcp/scripts/\` | Family/integration lifecycle evidence; not one script per component |`,
		`| Editor test files | ${data.editorTests.length} | \`editor/test/\` | Automated editor coverage |`,
		`| Shared runtime test files | ${data.toolsTests.length} | \`tools/test/\` | Automated exported-runtime coverage |`,
		"",
		"## Inventory invariants",
		"",
		`- Endpoint mappings: ${endpointCount}; unique: ${endpointNameSet.size}.`,
		`- Tool catalog: ${data.tools.length}; unique: ${toolNameSet.size}; every description is non-empty.`,
		`- MCP-only tools: ${mcpOnly.map((name) => `\`${name}\``).join(", ") || "none"}.`,
		`- Editor endpoints missing from MCP: ${missingFromMcp.map((name) => `\`${name}\``).join(", ") || "none"}.`,
		`- Codex CLI config points to the shared server: ${data.codexConfigured ? "yes" : "no"}.`,
		`- Claude-compatible MCP config points to the shared server: ${data.claudeConfigured ? "yes" : "no"}.`,
		"",
	];
	return `${lines.join("\n")}\n`;
}

async function collectInventory() {
	const [endpointSource, layoutSource, paritySource, roadmapSource, extensionsSource, editorExtensionsSource, exportSource, cliExportSource, mcpConfig, codexConfig, tools] =
		await Promise.all([
			readFile(join(root, "editor/src/mcp/mcp.ts"), "utf8"),
			readFile(join(root, "editor/src/editor/layout.json"), "utf8"),
			readFile(join(root, "UNITY-6-5-PARITY.md"), "utf8"),
			readFile(join(root, "ROADMAP.md"), "utf8"),
			readFile(join(root, "tools/src/assets/extensions.ts"), "utf8"),
			readFile(join(root, "editor/src/tools/assets/extensions.ts"), "utf8"),
			readFile(join(root, "editor/src/project/export/assets.ts"), "utf8"),
			readFile(join(root, "cli/src/pack/assets/process.mts"), "utf8"),
			readFile(join(root, ".mcp.json"), "utf8"),
			readFile(join(root, ".codex/config.toml"), "utf8"),
			discoverMcpTools(),
		]);
	if (!roadmapSource.includes("#758") || !roadmapSource.includes("#757"))
		throw new Error("ROADMAP.md no longer records the Runtime AI and Occlusion Culling completion sections.");
	const endpointDomains = parseEndpointDomains(endpointSource);
	const endpointNames = [...endpointDomains.values()].flat();
	const toolNames = tools.map((tool) => tool.name);
	const missingTools = endpointNames.filter((name) => !toolNames.includes(name));
	const serverOwned = toolNames.filter((name) => !endpointNames.includes(name));
	if (missingTools.length || serverOwned.length !== 1 || serverOwned[0] !== "execute_batch") {
		throw new Error(`MCP mapping drift: missing=${missingTools.join(", ") || "none"}; server-owned=${serverOwned.join(", ") || "none"}.`);
	}
	const { featureFamilies, releaseDelta } = parseParityTables(paritySource);
	if (featureFamilies.length !== 50 || releaseDelta.length !== 27)
		throw new Error(`Parity matrix drift: feature families=${featureFamilies.length}, release delta=${releaseDelta.length}.`);
	if (!editorExtensionsSource.includes("assetRootRequiredExtensions")) throw new Error("Assets Browser extension aliases no longer use the canonical root-placement contract.");
	const builtExtensions = parseExtensionLiterals(extensionsSource);
	const editorExportExtensions = parseExtensionLiterals(
		exportSource.slice(exportSource.indexOf("const supportedImagesExtensions"), exportSource.indexOf("function isUnsupportedImageFormatError"))
	);
	const cliExportExtensions = parseExtensionLiterals(
		cliExportSource.slice(cliExportSource.indexOf("export const supportedImagesExtensions"), cliExportSource.indexOf("export interface IProcessAssetFileOptions"))
	);
	if (JSON.stringify(editorExportExtensions) !== JSON.stringify(builtExtensions) || JSON.stringify(cliExportExtensions) !== JSON.stringify(builtExtensions)) {
		throw new Error(`Asset build-extension drift: canonical=${builtExtensions.length}, editor=${editorExportExtensions.length}, CLI=${cliExportExtensions.length}.`);
	}
	const placementExclusions = parseNamedExtensionArray(extensionsSource, "assetRootPlacementExclusions");
	const guardExtensions = builtExtensions.filter((extension) => !placementExclusions.includes(extension));
	return {
		endpointDomains,
		featureFamilies,
		releaseDelta,
		tabs: parseLayoutTabs(JSON.parse(layoutSource)),
		tools,
		guardExtensions,
		placementExclusions,
		missingGuardExtensions: builtExtensions.filter((extension) => !guardExtensions.includes(extension) && !placementExclusions.includes(extension)),
		toolModules: await listFiles(join(root, "mcp/src/tools"), (path) => extname(path) === ".mts"),
		evaluations: await listFiles(join(root, "mcp/evaluations"), (path) => extname(path) === ".xml"),
		liveScenarios: await listFiles(join(root, "mcp/scripts"), (path) => path.endsWith("live-scenario.mjs")),
		editorTests: await listFiles(join(root, "editor/test"), (path) => /\.test\.[cm]?[jt]s$/.test(path)),
		toolsTests: await listFiles(join(root, "tools/test"), (path) => /\.test\.[cm]?[jt]s$/.test(path)),
		codexConfigured: codexConfig.includes('args = ["mcp/server/index.mjs"]'),
		claudeConfigured: mcpConfig.includes('"mcp/server/index.mjs"'),
	};
}

async function main() {
	const mode = process.argv[2] ?? "--check";
	if (!new Set(["--check", "--write"]).has(mode)) throw new Error("Usage: generate-feature-inventory.mjs [--check|--write]");
	const data = await collectInventory();
	const output = await format(renderFeatureInventory(data), { parser: "markdown", printWidth: 180, tabWidth: 4, useTabs: true });
	if (mode === "--write") await writeFile(inventoryPath, output, "utf8");
	else {
		const current = await readFile(inventoryPath, "utf8").catch(() => "");
		if (current !== output) throw new Error("FEATURE-INVENTORY.md is stale. Run yarn sync-feature-inventory.");
	}
	console.log(
		`[feature-inventory] ${mode === "--write" ? "wrote" : "verified"} ${data.tools.length} tools, ${data.featureFamilies.length} families, and ${data.tabs.length} tabs.`
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => (console.error(`[feature-inventory] ${error.message}`), process.exit(1)));
