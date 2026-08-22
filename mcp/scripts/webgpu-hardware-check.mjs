#!/usr/bin/env node
/** Runs the real Babylon WebGPU compute/MRT/readback and timestamp-query pages in local Chrome. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { connectEditorUi } from "./electron-ui-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "../..");
const chromeCandidates =
	process.platform === "darwin"
		? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
		: process.platform === "win32"
			? [join(process.env.PROGRAMFILES ?? "", "Google/Chrome/Application/chrome.exe"), join(process.env["PROGRAMFILES(X86)"] ?? "", "Google/Chrome/Application/chrome.exe")]
			: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const chromeExecutable = process.env.BJS_WEBGPU_CHROME_PATH ?? chromeCandidates.find(existsSync);
if (!chromeExecutable) throw new Error("Chrome or Chromium is required for the WebGPU hardware gate. Set BJS_WEBGPU_CHROME_PATH to its executable.");

const fixtureRoot = await mkdtemp(join(tmpdir(), "zvibe-webgpu-hardware-"));
const profilePath = await mkdtemp(join(tmpdir(), "zvibe-webgpu-profile-"));
const sourceDirectory = join(repositoryRoot, "tools/test/rendering");
const pageDirectory = join(fixtureRoot, "test/rendering");
const outputDirectory = join(fixtureRoot, "build/test/rendering");
await mkdir(pageDirectory, { recursive: true });
await mkdir(outputDirectory, { recursive: true });

for (const fileName of ["custom-render-pass-mrt-webgpu.browser.html", "custom-render-pass-gpu-profile.browser.html"]) {
	await copyFile(join(sourceDirectory, fileName), join(pageDirectory, fileName));
}
for (const fileName of ["glslang.wasm", "twgsl.wasm"]) {
	await copyFile(join(repositoryRoot, `node_modules/@babylonjs/core/assets/${fileName === "glslang.wasm" ? "glslang" : "twgsl"}/${fileName}`), join(pageDirectory, fileName));
}

await Promise.all([
	build({
		entryPoints: [join(sourceDirectory, "custom-render-pass-mrt-webgpu.browser.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "chrome120",
		external: ["fs", "path"],
		outfile: join(outputDirectory, "custom-render-pass-mrt-webgpu.browser.js"),
	}),
	build({
		entryPoints: [join(sourceDirectory, "custom-render-pass-gpu-profile.browser.ts")],
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "chrome120",
		outfile: join(outputDirectory, "custom-render-pass-gpu-profile.browser.js"),
	}),
]);

const contentTypes = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".wasm", "application/wasm"],
]);
const server = createServer(async (request, response) => {
	try {
		const requestPath = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname).replace(/^\/+/, "");
		if (requestPath === "favicon.ico") {
			response.writeHead(204);
			response.end();
			return;
		}
		const absolutePath = normalize(join(fixtureRoot, requestPath));
		if (!absolutePath.startsWith(`${fixtureRoot}/`)) throw new Error("Unsafe fixture path.");
		const bytes = await readFile(absolutePath);
		response.writeHead(200, { "Content-Type": contentTypes.get(extname(absolutePath)) ?? "application/octet-stream", "Cache-Control": "no-store" });
		response.end(bytes);
	} catch {
		response.writeHead(404);
		response.end("Not found");
	}
});
await new Promise((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
const serverAddress = server.address();
if (!serverAddress || typeof serverAddress === "string") throw new Error("The WebGPU fixture server did not bind a TCP port.");
const baseUrl = `http://127.0.0.1:${serverAddress.port}/test/rendering`;
const firstUrl = `${baseUrl}/custom-render-pass-mrt-webgpu.browser.html`;
const debuggingPort = Number(process.env.BJS_WEBGPU_CDP_PORT ?? 8317);
const chrome = spawn(
	chromeExecutable,
	[
		"--headless=new",
		`--remote-debugging-port=${debuggingPort}`,
		`--user-data-dir=${profilePath}`,
		"--no-first-run",
		"--disable-background-networking",
		"--disable-background-timer-throttling",
		"--disable-backgrounding-occluded-windows",
		"--disable-renderer-backgrounding",
		"--enable-unsafe-webgpu",
		"--enable-features=WebGPUDeveloperFeatures",
		"--use-angle=metal",
		firstUrl,
	],
	{ stdio: "ignore" }
);

let ui;
async function waitForResult(label) {
	const deadline = Date.now() + 120_000;
	let result = "running";
	let details = "";
	while (Date.now() < deadline) {
		({ result, details } = await ui.evaluate(`({ result: document.body?.dataset.result ?? "loading", details: document.body?.dataset.details ?? "" })`));
		if (result !== "running" && result !== "loading") return { result, details };
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`${label} timed out; last result ${result}: ${details}`);
}

try {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json();
			if (targets.some((target) => target.type === "page" && target.url === firstUrl)) break;
		} catch {
			// Chrome is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	ui = await connectEditorUi("body", debuggingPort, `location.href === ${JSON.stringify(firstUrl)}`);
	const mrt = await waitForResult("WebGPU compute/MRT/readback");
	if (mrt.result !== "passed") throw new Error(`WebGPU compute/MRT/readback ${mrt.result}: ${mrt.details}`);

	const profileUrl = `${baseUrl}/custom-render-pass-gpu-profile.browser.html`;
	await ui.send("Page.navigate", { url: profileUrl });
	const profile = await waitForResult("WebGPU timestamp profiling");
	if (profile.result !== "passed") throw new Error(`WebGPU timestamp profiling ${profile.result}: ${profile.details}`);
	if (ui.runtimeErrors.length) throw new Error(`Unexpected WebGPU renderer errors: ${JSON.stringify(ui.runtimeErrors)}`);
	console.log(
		`[webgpu-hardware] PASS — native Chrome WebGPU compute dispatch, MRT attachments, four output readbacks, render-graph conformance, and isolated timestamp-query profiling passed.`
	);
} finally {
	ui?.socket.close();
	const chromeExited = new Promise((resolve) => {
		if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
		else chrome.once("exit", resolve);
	});
	chrome.kill("SIGTERM");
	await Promise.race([chromeExited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
	await new Promise((resolve) => server.close(resolve));
	await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	await rm(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
