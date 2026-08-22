import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electron = require("electron");
const electronMain = resolve(root, "scripts/render-graph-conformance-electron.cjs");
const temporaryRoot = await mkdtemp(join(tmpdir(), "zvibe-lighting-2d-"));

try {
	const bundle = join(temporaryRoot, "lighting-2d.js");
	const page = join(temporaryRoot, "lighting-2d.html");
	await build({
		entryPoints: [resolve(root, "test/loading/lighting-2d.browser.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "chrome130",
		outfile: bundle,
		logLevel: "silent",
	});
	await writeFile(
		page,
		'<!doctype html><html><head><meta charset="utf-8"><title>Lighting 2D conformance</title></head><body data-result="running"><script src="./lighting-2d.js"></script></body></html>'
	);
	const result = await new Promise((resolveResult) => {
		const child = spawn(electron, [electronMain, `--user-data-dir=${join(temporaryRoot, "profile")}`], {
			env: { ...process.env, ZVIBE_CONFORMANCE_PAGE: page, ZVIBE_CONFORMANCE_TARGET: "webgl2-lighting-2d", ZVIBE_CONFORMANCE_TIMEOUT_MS: "60000" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolveResult({ code: 1, evidence: { result: "failed", details: error.message }, stderr: stderr.trim() }));
		child.on("exit", (code) => {
			const lines = stdout.trim().split("\n").filter(Boolean);
			let evidence;
			try {
				evidence = JSON.parse(lines.at(-1) ?? "null");
			} catch {
				evidence = { result: "failed", details: stdout.trim() };
			}
			resolveResult({ code, evidence, stderr: stderr.trim() });
		});
	});
	process.stdout.write(`${JSON.stringify({ backend: "electron-webgl2-lighting-2d-v1", ...result }, null, 2)}\n`);
	if (result.code !== 0) process.exitCode = 1;
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
