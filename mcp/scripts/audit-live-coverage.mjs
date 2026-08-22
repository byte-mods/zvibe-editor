#!/usr/bin/env node
/** Audits whether every packaged MCP tool is named by at least one real-editor live scenario. */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const manifestTools = manifest.server?.tools ?? manifest.tools;
if (!Array.isArray(manifestTools)) {
	throw new Error("MCPB manifest does not contain a packaged tool catalog.");
}

async function listSourceFiles(directory) {
	const result = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) result.push(...(await listSourceFiles(path)));
		else if (/\.(?:m?[jt]s|tsx)$/.test(entry.name)) result.push(path);
	}
	return result;
}

const scenarioFiles = (await readdir(here))
	.filter((file) => file.endsWith("live-scenario.mjs") || file === "all-tools-live-dispatch-scenario.mjs" || file === "whole-editor-ui-audit.mjs")
	.sort();
const scenarioSources = new Map(await Promise.all(scenarioFiles.map(async (file) => [file, await readFile(join(here, file), "utf8")])));
const toolSourceDirectory = join(root, "src/tools");
const toolSourceFiles = (await readdir(toolSourceDirectory)).filter((file) => file.endsWith(".mts")).sort();
const toolSources = new Map(await Promise.all(toolSourceFiles.map(async (file) => [file, await readFile(join(toolSourceDirectory, file), "utf8")])));
const testRoots = [join(root, "..", "editor/test"), join(root, "..", "tools/test"), join(root, "..", "cli/test")];
const testFiles = (await Promise.all(testRoots.map((directory) => listSourceFiles(directory))))
	.flat()
	.concat((await readdir(here)).filter((file) => file.includes(".test.")).map((file) => join(here, file)));
const testSources = new Map(await Promise.all(testFiles.map(async (file) => [file, await readFile(file, "utf8")])));
const coverage = manifestTools.map((tool) => {
	const quotedDouble = `"${tool.name}"`;
	const quotedSingle = `'${tool.name}'`;
	const scenarios = [...scenarioSources].filter(([, source]) => source.includes(quotedDouble) || source.includes(quotedSingle)).map(([file]) => file);
	const tests = [...testSources].filter(([, source]) => source.includes(quotedDouble) || source.includes(quotedSingle)).map(([file]) => file);
	const registrationModule = [...toolSources].find(([, source]) => source.includes(quotedDouble) || source.includes(quotedSingle))?.[0] ?? null;
	return { name: tool.name, registrationModule, scenarios, tests };
});
const covered = coverage.filter((entry) => entry.scenarios.length > 0);
const uncovered = coverage.filter((entry) => entry.scenarios.length === 0);
const testMentioned = coverage.filter((entry) => entry.tests.length > 0);
const neitherLiveNorTestMentioned = coverage.filter((entry) => entry.scenarios.length === 0 && entry.tests.length === 0);
const uncoveredByRegistrationModule = Object.fromEntries(
	[...new Set(uncovered.map((entry) => entry.registrationModule ?? "unmapped"))]
		.sort()
		.map((module) => [module, uncovered.filter((entry) => (entry.registrationModule ?? "unmapped") === module).length])
);
const result = {
	verdict: uncovered.length === 0 ? "PASS" : "GAPS",
	manifestToolCount: manifestTools.length,
	liveScenarioCount: scenarioFiles.length,
	coveredToolCount: covered.length,
	uncoveredToolCount: uncovered.length,
	coveragePercent: Number(((covered.length / manifestTools.length) * 100).toFixed(2)),
	testMentionedToolCount: testMentioned.length,
	neitherLiveNorTestMentionedToolCount: neitherLiveNorTestMentioned.length,
	uncoveredByRegistrationModule,
	uncoveredTools: uncovered.map((entry) => entry.name),
	coverage,
};

const output = process.argv.includes("--summary") ? { ...result, uncoveredTools: undefined, coverage: undefined } : result;
console.log(JSON.stringify(output, null, 2));
if (process.argv.includes("--require-complete") && uncovered.length > 0) {
	process.exitCode = 1;
}
