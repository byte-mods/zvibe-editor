#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const startAt = process.env.LIVE_SCENARIO_START_AT?.trim();
const only = process.env.LIVE_SCENARIO_ONLY?.trim();

const discoveredScenarios = (await readdir(here))
	.filter((name) => name === "live-scenario.mjs" || name.endsWith("-live-scenario.mjs"))
	.sort((left, right) => left.localeCompare(right));
let scenarios = discoveredScenarios;

if (only) {
	const requested = [...new Set(only.split(",").map((name) => (name.endsWith(".mjs") ? name : `${name}.mjs`)))];
	const missing = requested.filter((name) => !discoveredScenarios.includes(name));
	if (missing.length) {
		throw new Error(`Unknown live scenario(s): ${missing.join(", ")}.`);
	}
	scenarios = requested;
}

if (startAt) {
	const requested = startAt.endsWith(".mjs") ? startAt : `${startAt}.mjs`;
	const index = scenarios.indexOf(requested);
	if (index < 0) throw new Error(`Unknown LIVE_SCENARIO_START_AT value: ${startAt}.`);
	scenarios = scenarios.slice(index);
}

if (!scenarios.length) throw new Error("No live scenarios were selected.");

const startedAt = Date.now();
const results = [];
console.log(`[all-live-scenarios] Running ${scenarios.length} scenarios serially.`);

for (const [index, scenario] of scenarios.entries()) {
	const scenarioStartedAt = Date.now();
	console.log(`[all-live-scenarios] START ${index + 1}/${scenarios.length} ${scenario}`);
	const exitCode = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [join(here, scenario)], {
			cwd: join(here, ".."),
			env: process.env,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
	});
	const durationMs = Date.now() - scenarioStartedAt;
	results.push({ scenario, exitCode, durationMs });
	if (exitCode !== 0) {
		console.error(`[all-live-scenarios] FAIL ${scenario} (${durationMs} ms, exit ${exitCode}).`);
		console.error(JSON.stringify({ verdict: "FAIL", completed: results.length - 1, selected: scenarios.length, failed: scenario, results }, null, 2));
		process.exit(exitCode);
	}
	console.log(`[all-live-scenarios] PASS ${scenario} (${durationMs} ms).`);
}

console.log(JSON.stringify({ verdict: "PASS", completed: results.length, durationMs: Date.now() - startedAt, results }, null, 2));
