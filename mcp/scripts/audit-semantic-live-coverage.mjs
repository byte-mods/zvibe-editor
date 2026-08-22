#!/usr/bin/env node
/** Audits positive, valid-state tool calls in real-editor live scenarios. */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "acorn";
import { simple } from "acorn-walk";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const manifestTools = manifest.server?.tools ?? manifest.tools;
if (!Array.isArray(manifestTools)) throw new Error("MCPB manifest does not contain a packaged tool catalog.");

const scenarioFiles = (await readdir(here))
	.filter((file) => (file.endsWith("live-scenario.mjs") || file === "whole-editor-ui-audit.mjs") && file !== "all-tools-live-dispatch-scenario.mjs")
	.sort();
const positiveHelpers = new Set(["call", "callImage", "callResult", "callBackground"]);
const callsByTool = new Map();

for (const file of scenarioFiles) {
	const source = await readFile(join(here, file), "utf8");
	const ast = parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true });
	simple(ast, {
		CallExpression(node) {
			if (node.callee.type !== "Identifier" || !positiveHelpers.has(node.callee.name)) return;
			const nameArgument = node.arguments[0];
			if (nameArgument?.type !== "Literal" || typeof nameArgument.value !== "string") return;
			const expectedError = node.arguments[2]?.type === "Literal" && node.arguments[2].value === true;
			if (expectedError) return;
			const evidence = callsByTool.get(nameArgument.value) ?? [];
			evidence.push({ file, line: node.loc.start.line, helper: node.callee.name });
			callsByTool.set(nameArgument.value, evidence);
		},
	});
}

const toolSourceDirectory = join(root, "src", "tools");
const sourceFiles = (await readdir(toolSourceDirectory)).filter((file) => file.endsWith(".mts")).sort();
const sources = new Map(await Promise.all(sourceFiles.map(async (file) => [file, await readFile(join(toolSourceDirectory, file), "utf8")])));
const tools = manifestTools.map((tool) => ({
	name: tool.name,
	registrationModule: [...sources].find(([, source]) => source.includes(`"${tool.name}"`) || source.includes(`'${tool.name}'`))?.[0] ?? null,
	evidence: callsByTool.get(tool.name) ?? [],
}));
const covered = tools.filter((tool) => tool.evidence.length > 0);
const uncovered = tools.filter((tool) => tool.evidence.length === 0);
const uncoveredByRegistrationModule = Object.fromEntries(
	[...new Set(uncovered.map((tool) => tool.registrationModule ?? "unmapped"))]
		.sort()
		.map((module) => [module, uncovered.filter((tool) => (tool.registrationModule ?? "unmapped") === module).length])
);
const result = {
	verdict: uncovered.length === 0 ? "PASS" : "GAPS",
	definition:
		"A covered tool has at least one literal positive call/callImage/callResult/callBackground invocation in a real-editor scenario. Calls explicitly marked expectError=true and the guarded exhaustive-dispatch probe do not count.",
	manifestToolCount: manifestTools.length,
	liveScenarioCount: scenarioFiles.length,
	coveredToolCount: covered.length,
	uncoveredToolCount: uncovered.length,
	coveragePercent: Number(((covered.length / manifestTools.length) * 100).toFixed(2)),
	uncoveredByRegistrationModule,
	uncoveredTools: uncovered.map((tool) => tool.name),
	tools,
};
const summary = process.argv.includes("--summary");
console.log(JSON.stringify(summary ? { ...result, uncoveredTools: undefined, tools: undefined } : result, null, 2));
if (process.argv.includes("--require-complete") && uncovered.length) process.exitCode = 1;
