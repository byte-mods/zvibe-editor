#!/usr/bin/env node
/** Positive live lifecycle for portable Android Build Profile planning. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "..", "server", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params = {}, timeoutMs = 60_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const text = response.result?.content?.find((entry) => entry.type === "text")?.text ?? "";
	if (response.error || response.result?.isError) throw new Error(`${name}: ${text || JSON.stringify(response.error ?? response.result)}`);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const suffix = `${Date.now()}-${process.pid}`;
const profileId = `mcp-android-plan-${suffix}`;
let created = false;

async function cleanup() {
	if (!created) return;
	try {
		const configuration = await call("list_build_profiles");
		if (configuration.profiles.some((profile) => profile.id === profileId)) {
			await call("delete_build_profile", { expectedRevision: configuration.revision, id: profileId });
		}
	} catch {
		// Best-effort cleanup is retried by the scenario's exact final comparison.
	}
	created = false;
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "android-build-plan-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready) throw new Error("A ready editor is required.");
	const baseline = await call("list_build_profiles");
	const createdProfile = await call("create_build_profile", {
		expectedRevision: baseline.revision,
		id: profileId,
		name: `MCP Android Plan ${suffix}`,
		target: "android",
		settings: {
			productName: "Zvibe MCP Android",
			companyName: "Zvibe",
			version: "1.0.0",
			applicationId: "com.zvibe.mcpandroid",
			buildMode: "release",
			android: { linkTimeOptimization: "thin", xrLinkTimeOptimization: "thin", initializationProfiling: true },
		},
	});
	created = true;
	const plan = await call("get_android_build_profile_plan", { id: profileId });
	if (
		plan.configurationRevision !== createdProfile.configuration.revision ||
		plan.profile.id !== profileId ||
		plan.plan?.backend !== "zvibe-android-project-native-lto-v1" ||
		plan.plan?.lto?.mode !== "thin" ||
		!plan.plan.lto.compilerFlags.includes("-flto=thin") ||
		plan.plan?.xr?.mode !== "thin" ||
		plan.plan?.initializationProfiling?.enabled !== true ||
		plan.plan.initializationProfiling.androidTraceSections.length < 7 ||
		plan.plan?.lto?.prebuiltLibrariesRecompiled !== false ||
		plan.plan?.xr?.prebuiltXrLibrariesRecompiled !== false
	) {
		throw new Error(`Android build-plan evidence is incomplete: ${JSON.stringify(plan)}`);
	}
	await cleanup();
	const finalConfiguration = await call("list_build_profiles");
	if (
		finalConfiguration.profiles.length !== baseline.profiles.length ||
		finalConfiguration.profiles.some((profile) => !baseline.profiles.some((entry) => entry.id === profile.id)) ||
		finalConfiguration.activeProfileId !== baseline.activeProfileId
	) {
		throw new Error("Android build-plan cleanup did not restore the semantic Build Pipeline baseline.");
	}
	console.log("[android-build-plan-live] PASS — Android ThinLTO, XR adapter, early Trace markers, portable boundary, exact revision, and profile cleanup verified.");
} catch (error) {
	console.error(`[android-build-plan-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	await cleanup();
	child.kill("SIGTERM");
}
