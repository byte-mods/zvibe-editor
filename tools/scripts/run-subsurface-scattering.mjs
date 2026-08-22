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
const temporaryRoot = await mkdtemp(join(tmpdir(), "zvibe-subsurface-scattering-"));
const requestedTarget = process.argv.find((argument) => argument.startsWith("--target="))?.slice("--target=".length);
const allowUnavailable = process.argv.includes("--allow-unavailable");
const targets = requestedTarget ? [requestedTarget] : ["webgl2", "webgpu"];
if (targets.some((target) => target !== "webgl2" && target !== "webgpu")) {
	throw new Error(`Unknown subsurface-scattering target "${requestedTarget}". Expected webgl2 or webgpu.`);
}

async function runTarget(target) {
	const bundle = join(temporaryRoot, `${target}.js`);
	const page = join(temporaryRoot, `${target}.html`);
	for (const [source, destination] of [
		[resolve(root, "../node_modules/@babylonjs/core/assets/glslang/glslang.wasm"), join(temporaryRoot, "glslang.wasm")],
		[resolve(root, "../node_modules/@babylonjs/core/assets/twgsl/twgsl.wasm"), join(temporaryRoot, "twgsl.wasm")],
	]) {
		await copyFile(source, destination);
	}
	await build({
		entryPoints: [resolve(root, "test/rendering/subsurface-scattering.browser.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "chrome130",
		external: ["fs", "path"],
		define: { __SUBSURFACE_SCATTERING_TARGET__: JSON.stringify(target) },
		outfile: bundle,
		logLevel: "silent",
	});
	await writeFile(
		page,
		`<!doctype html><html><head><meta charset="utf-8"><title>${target} subsurface scattering</title></head><body data-result="running"><script src="./${target}.js"></script></body></html>`
	);
	return new Promise((resolveTarget) => {
		const child = spawn(electron, [electronMain, `--user-data-dir=${join(temporaryRoot, `${target}-profile`)}`], {
			env: { ...process.env, ZVIBE_CONFORMANCE_PAGE: page, ZVIBE_CONFORMANCE_TARGET: target, ZVIBE_CONFORMANCE_TIMEOUT_MS: "90000" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolveTarget({ target, code: 1, evidence: { result: "failed", details: error.message }, stderr: stderr.trim() }));
		child.on("exit", (code) => {
			const lines = stdout.trim().split("\n").filter(Boolean);
			let evidence;
			try {
				evidence = JSON.parse(lines.at(-1) ?? "null");
			} catch {
				evidence = { target, result: "failed", details: stdout.trim() };
			}
			resolveTarget({ target, code, evidence, stderr: stderr.trim() });
		});
	});
}

try {
	const results = [];
	for (const target of targets) {
		results.push(await runTarget(target));
	}
	process.stdout.write(`${JSON.stringify({ backend: "electron-cross-backend-subsurface-scattering-v1", results }, null, 2)}\n`);
	if (results.some((result) => result.code !== 0 && !(allowUnavailable && result.code === 2))) {
		process.exitCode = 1;
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
