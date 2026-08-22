#!/usr/bin/env node
/** Positive real-editor MCP verification for exact package/registry apply transactions and one-package compatibility mutation. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params, timeoutMs = 1_800_000) {
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

function assert(condition, message, evidence) {
	if (!condition) throw new Error(`${message}: ${JSON.stringify(evidence)}`);
}

const scope = `@zvibe-live-${process.pid}`;
let temporaryRegistryApplied = false;
let initialRegistries;
let initialNpmrcExists = false;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "project-package-mutation-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const status = await call("get_editor_status");
	assert(status.ready && status.projectPath, "A ready editor project is required", status);
	if (process.env.BJS_LIVE_REMOVE_EMPTY_NPMRC === "1") await call("delete_asset", { path: ".npmrc", confirm: true });
	const initialPackages = await call("list_project_packages", { limit: 500 });
	initialRegistries = await call("list_project_package_registries", { limit: 100 });
	initialNpmrcExists = initialRegistries.files.some((file) => file.path === ".npmrc");

	const registryPlan = await call("plan_project_package_registry_change", {
		action: "upsert",
		scope,
		url: "https://registry.npmjs.org/",
		expectedFingerprint: initialRegistries.fingerprint,
	});
	assert(registryPlan.id && registryPlan.changed === true, "Temporary scoped-registry plan was not created", registryPlan);
	const appliedRegistry = await call("apply_project_package_registry_plan", {
		planId: registryPlan.id,
		expectedFingerprint: registryPlan.sourceFingerprint,
		confirm: true,
	});
	assert(appliedRegistry.applied === true && appliedRegistry.registries.some((entry) => entry.scope === scope), "Scoped registry apply failed", appliedRegistry);
	temporaryRegistryApplied = true;
	const configuredRegistries = await call("list_project_package_registries", { limit: 100 });
	const removePlan = await call("plan_project_package_registry_change", {
		action: "remove",
		scope,
		expectedFingerprint: configuredRegistries.fingerprint,
	});
	const removedRegistry = await call("apply_project_package_registry_plan", {
		planId: removePlan.id,
		expectedFingerprint: removePlan.sourceFingerprint,
		confirm: true,
	});
	assert(removedRegistry.applied === true && !removedRegistry.registries.some((entry) => entry.scope === scope), "Scoped registry cleanup failed", removedRegistry);
	temporaryRegistryApplied = false;
	if (!initialNpmrcExists) await call("delete_asset", { path: ".npmrc", confirm: true });
	const restoredRegistries = await call("list_project_package_registries", { limit: 100 });
	assert(restoredRegistries.fingerprint === initialRegistries.fingerprint, "Registry transaction did not restore its exact initial fingerprint", {
		before: initialRegistries.fingerprint,
		after: restoredRegistries.fingerprint,
	});

	const graph = await call("get_project_package_dependency_graph", { directOnly: true, limit: 500 });
	const selected = initialPackages.directDependencies.find((dependency) => dependency.name === "@babylonjs/addons");
	assert(selected, "The live game is missing its direct @babylonjs/addons dependency", initialPackages.directDependencies);
	const resolved = graph.nodes.find((node) => node.direct && node.name === selected.name && node.version);
	const core = initialPackages.directDependencies.find((dependency) => dependency.name === "@babylonjs/core");
	const resolvedCore = graph.nodes.find((node) => node.direct && node.name === core?.name && node.version);
	assert(resolved && core && resolvedCore, "The Babylon.js direct dependency graph is incomplete", { selected, resolved, core, resolvedCore });
	const packagePlan = await call("plan_project_package_changes", {
		expectedFingerprint: initialPackages.fingerprint,
		allowWorkspaceRoot: initialPackages.workspace?.mutationRequiresOptIn === true,
		changes: [
			{ operation: "update", name: selected.name, version: resolved.version, dependencyType: selected.dependencyType, source: { type: "registry" } },
			{ operation: "update", name: core.name, version: resolvedCore.version, dependencyType: core.dependencyType, source: { type: "registry" } },
		],
		timeoutMs: 300000,
	});
	assert(packagePlan.id && packagePlan.changes[0]?.version === resolved.version, "Exact-version package plan was not created", packagePlan);
	const appliedPackage = await call("apply_project_package_plan", {
		planId: packagePlan.id,
		expectedFingerprint: packagePlan.sourceFingerprint,
		confirm: true,
	});
	assert(appliedPackage.applied === true || appliedPackage.status === "completed", "Exact-version package plan did not complete", appliedPackage);
	const afterPlan = await call("list_project_packages", { limit: 500 });
	const selectedAfterPlan = afterPlan.directDependencies.find((dependency) => dependency.name === selected.name);
	const coreAfterPlan = afterPlan.directDependencies.find((dependency) => dependency.name === core.name);
	assert(
		selectedAfterPlan?.specification === resolved.version && coreAfterPlan?.specification === resolvedCore.version,
		"Exact-version package plan did not persist exact Babylon.js dependency versions",
		{ selectedAfterPlan, coreAfterPlan, resolved, resolvedCore }
	);

	const modified = await call("modify_project_package", {
		operation: "update",
		name: selected.name,
		version: resolved.version,
		dependencyType: selected.dependencyType,
		source: { type: "registry" },
		expectedFingerprint: afterPlan.fingerprint,
		allowWorkspaceRoot: afterPlan.workspace?.mutationRequiresOptIn === true,
		timeoutMs: 300000,
		confirm: true,
	});
	assert(modified.transaction?.applied === true || modified.applied === true || modified.status === "completed", "One-package compatibility mutation did not complete", modified);
	const finalPackages = await call("list_project_packages", { limit: 500 });
	assert(finalPackages.fingerprint === afterPlan.fingerprint, "Compatibility mutation caused additional package or lock drift", {
		before: afterPlan.fingerprint,
		after: finalPackages.fingerprint,
		result: modified,
	});

	console.log(
		JSON.stringify(
			{
				ok: true,
				verified: 3,
				package: selected.name,
				version: resolved.version,
				packageManagerNormalizedFiles: afterPlan.fingerprint !== initialPackages.fingerprint,
				compatibilityMutationAddedNoDrift: true,
				exactRegistryFingerprintRestored: true,
			},
			null,
			2
		)
	);
} finally {
	try {
		if (temporaryRegistryApplied && initialRegistries) {
			const current = await call("list_project_package_registries", { limit: 100 });
			const cleanupPlan = await call("plan_project_package_registry_change", { action: "remove", scope, expectedFingerprint: current.fingerprint });
			await call("apply_project_package_registry_plan", { planId: cleanupPlan.id, expectedFingerprint: cleanupPlan.sourceFingerprint, confirm: true });
			if (!initialNpmrcExists) await call("delete_asset", { path: ".npmrc", confirm: true });
		}
	} catch (cleanupError) {
		stderr += `\nCleanup error: ${cleanupError?.stack ?? cleanupError}`;
	}
	child.kill();
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}
