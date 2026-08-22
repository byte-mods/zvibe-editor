import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electron = require("electron");
const electronMain = resolve(root, "scripts/render-graph-conformance-electron.cjs");
const allowUnavailable = process.argv.includes("--allow-unavailable");
const requestedTarget = process.argv.find((argument) => argument.startsWith("--target="))?.slice("--target=".length);
const temporaryRoot = await mkdtemp(join(tmpdir(), "zvibe-render-conformance-"));

const allProbes = [
	{ target: "webgl2", entry: resolve(root, "test/rendering/custom-render-pass-graph.browser.ts") },
	{ target: "webgpu", entry: resolve(root, "test/rendering/custom-render-pass-mrt-webgpu.browser.ts") },
];
if (requestedTarget && !allProbes.some((probe) => probe.target === requestedTarget)) {
	throw new Error(`Unknown conformance target "${requestedTarget}". Expected webgl2 or webgpu.`);
}
const probes = requestedTarget ? allProbes.filter((probe) => probe.target === requestedTarget) : allProbes;

async function runProbe(probe) {
	const bundle = join(temporaryRoot, `${probe.target}.js`);
	const page = join(temporaryRoot, `${probe.target}.html`);
	if (probe.target === "webgpu") {
		for (const [source, destination] of [
			[resolve(root, "../node_modules/@babylonjs/core/assets/glslang/glslang.wasm"), join(temporaryRoot, "glslang.wasm")],
			[resolve(root, "../node_modules/@babylonjs/core/assets/twgsl/twgsl.wasm"), join(temporaryRoot, "twgsl.wasm")],
		]) {
			await copyFile(source, destination);
		}
	}
	await build({
		entryPoints: [probe.entry],
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "chrome130",
		external: ["fs", "path"],
		outfile: bundle,
		logLevel: "silent",
	});
	await writeFile(
		page,
		`<!doctype html><html><head><meta charset="utf-8"><title>${probe.target} render conformance</title></head><body data-result="running"><script src="./${probe.target}.js"></script></body></html>`
	);
	return new Promise((resolveProbe) => {
		const child = spawn(electron, [electronMain, `--user-data-dir=${join(temporaryRoot, `${probe.target}-profile`)}`], {
			env: { ...process.env, ZVIBE_CONFORMANCE_PAGE: page, ZVIBE_CONFORMANCE_TARGET: probe.target },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			resolveProbe({ target: probe.target, code: 1, evidence: { target: probe.target, result: "failed", details: error.message }, stderr: stderr.trim() });
		});
		child.on("exit", (code) => {
			const lines = stdout.trim().split("\n").filter(Boolean);
			let evidence = null;
			try {
				evidence = JSON.parse(lines.at(-1) ?? "null");
			} catch {
				evidence = { target: probe.target, result: "failed", details: stdout.trim() };
			}
			resolveProbe({ target: probe.target, code, evidence, stderr: stderr.trim() });
		});
	});
}

try {
	const results = [];
	for (const probe of probes) results.push(await runProbe(probe));
	process.stdout.write(`${JSON.stringify({ backend: "electron-cross-backend-render-graph-v1", results }, null, 2)}\n`);
	const failed = results.filter((result) => result.code !== 0 && !(allowUnavailable && result.code === 2));
	if (failed.length) process.exitCode = 1;
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
