#!/usr/bin/env node
/** Real stdio/editor lifecycle for platform inventory, diagnostics, scaffolds, matrix validation, guards, and cleanup. */
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "server", "index.mjs");
const child = spawn("node", [server], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;

child.stdout.on("data", (chunk) => {
	stdout += chunk.toString();
	let newline;
	while ((newline = stdout.indexOf("\n")) >= 0) {
		const line = stdout.slice(0, newline).trim();
		stdout = stdout.slice(newline + 1);
		if (!line) continue;
		const message = JSON.parse(line);
		if (message.id !== undefined && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		}
	}
});
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

function rpc(method, params, timeoutMs = 180_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}, expectError = false) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

const requiredTools = [
	"list_platform_capabilities",
	"get_platform_diagnostics",
	"get_platform_scaffold",
	"generate_platform_scaffold",
	"remove_platform_scaffold",
	"validate_platform_build_matrix",
	"get_installed_platform_restart_status",
	"plan_installed_platform_restart",
	"restart_editor_for_installed_platform",
	"get_ios_project_generation_capabilities",
	"validate_ios_generated_project",
];
const targets = ["headless", "android", "ios"];
const settings = {
	headless: { baseBuildScript: "build", host: "127.0.0.1", port: 17777, tickRate: 30, maximumCatchUpSteps: 4 },
	android: { baseBuildScript: "build", minimumSdk: 24, targetSdk: 35, format: "aab", orientation: "landscape", syncNativeProject: false },
	ios: { baseBuildScript: "build", deploymentTarget: "16.0", deviceFamily: "universal", orientation: "landscape", syncNativeProject: false, projectType: "swift" },
};

let projectDirectory;
let packagePath;
let packageBaseline;
const generatedTargets = [];

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "platforms-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const listed = await rpc("tools/list", {});
	const available = new Set(listed.result?.tools?.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing Platforms tools: ${missing.join(", ")}`);

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the Platforms live scenario.");
	projectDirectory = dirname(status.projectPath);
	packagePath = join(projectDirectory, "package.json");
	packageBaseline = await readFile(packagePath);

	const capabilities = await call("list_platform_capabilities");
	for (const [target, support] of [
		["web", "built-in"],
		["electron", "built-in"],
		["android", "scaffolded"],
		["ios", "scaffolded"],
		["headless", "scaffolded"],
		["webxr", "integrated"],
		["console", "unsupported"],
	]) {
		if (!capabilities.platforms.some((platform) => platform.target === target && platform.support === support)) {
			throw new Error(`Platform inventory did not report ${target} as ${support}.`);
		}
	}

	const diagnostics = await call("get_platform_diagnostics");
	if (diagnostics.diagnostics.length !== 7 || !diagnostics.diagnostics.every((entry) => entry.host && entry.descriptor)) {
		throw new Error("All-platform host/toolchain diagnostics were incomplete.");
	}
	const iosCapabilities = await call("get_ios_project_generation_capabilities");
	if (!iosCapabilities.projectTypes?.some((entry) => entry.id === "swift" && entry.status === "experimental" && entry.minimumIosVersion === "16.0")) {
		throw new Error("Experimental Swift iOS capability evidence was incomplete.");
	}

	for (const target of targets) {
		const baseline = await call("get_platform_scaffold", { target });
		if (baseline.exists) throw new Error(`The live project already has a ${target} scaffold; use a disposable project so the scenario does not overwrite user files.`);
		const generated = await call("generate_platform_scaffold", { target, expectedRevision: 0, settings: settings[target] });
		generatedTargets.push(target);
		if (!generated.exists || generated.revision !== 1 || !generated.integrity) throw new Error(`${target} scaffold generation evidence was incomplete.`);
		const roundTrip = await call("get_platform_scaffold", { target });
		if (!roundTrip.integrity || roundTrip.files.some((file) => !file.matches)) throw new Error(`${target} scaffold hash verification failed.`);
		if (target === "ios") {
			const validation = await call("validate_ios_generated_project", { expectedRevision: 1 });
			if (!validation.valid || validation.scheme !== "ZvibeGame") throw new Error("Generated Swift iOS project validation failed.");
		}
		await call("generate_platform_scaffold", { target, expectedRevision: 0, settings: settings[target] }, true);
	}

	await call("generate_platform_scaffold", { target: "android", expectedRevision: 1, settings: { unknown: true } }, true);
	const matrix = await call("validate_platform_build_matrix");
	if (!Number.isSafeInteger(matrix.configurationRevision) || !Array.isArray(matrix.profiles)) throw new Error("Platform Build Profile matrix evidence was incomplete.");
	const restartStatus = await call("get_installed_platform_restart_status", { target: "web" });
	if (!restartStatus.installed || !/^[a-f0-9]{64}$/.test(restartStatus.diagnosticFingerprint)) throw new Error("Installed-platform restart status was incomplete.");
	await call("plan_installed_platform_restart", { target: "web", expectedDiagnosticFingerprint: "0".repeat(64) }, true);
	const restartPlan = await call("plan_installed_platform_restart", { target: "web", expectedDiagnosticFingerprint: restartStatus.diagnosticFingerprint });
	if (restartPlan.target !== "web" || !restartPlan.id || Date.parse(restartPlan.expiresAt) <= Date.now()) throw new Error("Installed-platform restart lease was incomplete.");

	for (const target of [...generatedTargets].reverse()) {
		const current = await call("get_platform_scaffold", { target });
		const removed = await call("remove_platform_scaffold", { target, expectedRevision: current.revision, confirm: true });
		if (!removed.removed || (await call("get_platform_scaffold", { target })).exists) throw new Error(`${target} scaffold did not remove cleanly.`);
		generatedTargets.splice(generatedTargets.indexOf(target), 1);
		await rm(join(projectDirectory, ".zvibe", "platforms", target), { recursive: true, force: true });
	}

	const packageAfter = JSON.parse(await readFile(packagePath, "utf8"));
	const packageBefore = JSON.parse(packageBaseline.toString("utf8"));
	if (JSON.stringify(packageAfter) !== JSON.stringify(packageBefore)) throw new Error("package.json was not restored to its semantic baseline.");
	console.log(
		`[platforms-live] PASS — ${requiredTools.length}/11 tools present; seven-platform inventory/diagnostics, three exact-revision scaffolds, experimental Swift project validation, restart status/lease, strict/stale rejection, Build Profile matrix, and semantic cleanup verified.`
	);
} catch (error) {
	console.error(`[platforms-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		for (const target of [...generatedTargets].reverse()) {
			const current = await call("get_platform_scaffold", { target });
			if (current.exists) await call("remove_platform_scaffold", { target, expectedRevision: current.revision, confirm: true });
			if (projectDirectory) await rm(join(projectDirectory, ".zvibe", "platforms", target), { recursive: true, force: true });
		}
		if (packagePath && packageBaseline) await writeFile(packagePath, packageBaseline);
	} catch (cleanupError) {
		console.error(`[platforms-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}
