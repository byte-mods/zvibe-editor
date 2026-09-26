#!/usr/bin/env node
/** Real stdio/editor verification for Unity-style project package workflows without mutating the active project. */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
let originalManifestBytes;
let fixtureRoot;
let importedTarget;
let cdp;

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

function rpc(method, params, timeoutMs = 90_000) {
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

async function call(name, args = {}, expectError = false, timeoutMs = 90_000) {
	const response = await rpc("tools/call", { name, arguments: args }, timeoutMs);
	const result = response.result;
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed !== expectError) throw new Error(`${name} ${failed ? "failed" : "unexpectedly succeeded"}: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	if (expectError) return content ?? JSON.stringify(response.error);
	return content ? JSON.parse(content) : result;
}

async function listTools() {
	const tools = [];
	let cursor;
	do {
		const response = await rpc("tools/list", cursor ? { cursor } : {});
		if (response.error) throw new Error(`tools/list failed: ${JSON.stringify(response.error)}`);
		tools.push(...(response.result?.tools ?? []));
		cursor = response.result?.nextCursor;
	} while (cursor);
	return tools;
}

async function connectCdp() {
	const port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315);
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status} on port ${port}.`);
	for (const target of (await response.json()).filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		let requestId = 1;
		const requests = new Map();
		const runtimeErrors = [];
		socket.on("message", (raw) => {
			const message = JSON.parse(raw.toString());
			if (message.id !== undefined && requests.has(message.id)) {
				requests.get(message.id)(message);
				requests.delete(message.id);
			} else if (message.method === "Runtime.exceptionThrown") runtimeErrors.push(message.params?.exceptionDetails?.text ?? "Runtime.exceptionThrown");
			else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") runtimeErrors.push(message.params.entry.text);
		});
		const send = (method, params = {}) =>
			new Promise((resolve, reject) => {
				const id = requestId++;
				const timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP ${method}.`)), 15_000);
				requests.set(id, (message) => {
					clearTimeout(timer);
					if (message.error) reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
					else resolve(message.result);
				});
				socket.send(JSON.stringify({ id, method, params }));
			});
		const evaluate = async (expression) => {
			const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
			if (result.exceptionDetails) throw new Error(`CDP evaluation failed: ${result.exceptionDetails.text}`);
			return result.result.value;
		};
		if (await evaluate("Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html'))")) {
			await send("Runtime.enable");
			await send("Log.enable");
			return { socket, evaluate, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Electron editor page was found on CDP port ${port}.`);
}

async function waitFor(read, predicate, label, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

const requiredTools = [
	"list_project_packages",
	"get_project_package_manager",
	"list_project_package_registries",
	"search_project_package_registry",
	"get_project_package_details",
	"plan_project_package_registry_change",
	"apply_project_package_registry_plan",
	"get_project_package_dependency_graph",
	"get_project_package_updates",
	"plan_project_package_changes",
	"apply_project_package_plan",
	"cancel_project_package_operation",
	"list_project_package_samples",
	"get_project_package_sample_details",
	"locate_project_package_sample",
	"plan_project_package_sample_import",
	"apply_project_package_sample_import",
	"set_project_development_package_technical_name",
	"modify_project_package",
];

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "package-manager-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	const available = new Set(tools.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing Package Manager tools: ${missing.join(", ")}`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} does not expose a closed input schema.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const editorStatus = await call("get_editor_status");
	if (!editorStatus.ready || !editorStatus.projectPath) throw new Error("A ready project editor is required for the Package Manager live scenario.");
	const projectRoot = dirname(editorStatus.projectPath);
	const manifestPath = join(projectRoot, "package.json");
	originalManifestBytes = await readFile(manifestPath);
	const originalManifest = JSON.parse(originalManifestBytes.toString("utf8"));
	if (typeof originalManifest.name !== "string" || !originalManifest.name) throw new Error("The live project requires a development package technical name.");
	const fixtureName = "@zvibe/live-samples-745";
	fixtureRoot = join(projectRoot, "node_modules", "@zvibe", "live-samples-745");
	importedTarget = join(projectRoot, "assets", ".zvibe-package-manager-live-745");
	await rm(fixtureRoot, { recursive: true, force: true });
	await rm(importedTarget, { recursive: true, force: true });
	await mkdir(join(fixtureRoot, "Samples~", "Starter"), { recursive: true });
	await mkdir(join(fixtureRoot, "Documentation~"), { recursive: true });
	await writeFile(join(fixtureRoot, "Samples~", "Starter", "sample.json"), '{"name":"Package Manager Live"}\n');
	await writeFile(
		join(fixtureRoot, "Documentation~", "cover.png"),
		Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVwAAAABJRU5ErkJggg==", "base64")
	);
	await writeFile(
		join(fixtureRoot, "package.json"),
		`${JSON.stringify(
			{
				name: fixtureName,
				version: "1.0.0",
				samples: [
					{
						displayName: "New Live Sample",
						description: "Newer bounded sample",
						path: "Samples~/Starter",
						publishedAt: "2026-07-01T00:00:00.000Z",
						images: [{ path: "Documentation~/cover.png", caption: "Live preview", alt: "One pixel preview" }],
					},
					...Array.from({ length: 20 }, (_, index) => ({
						displayName: index === 0 ? "Older Live Sample" : `Older Live Sample ${index + 1}`,
						description: "Older bounded sample",
						path: "Samples~/Starter",
						publishedAt: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(),
					})),
				],
			},
			null,
			"\t"
		)}\n`
	);
	await writeFile(manifestPath, `${JSON.stringify({ ...originalManifest, dependencies: { ...(originalManifest.dependencies ?? {}), [fixtureName]: "1.0.0" } }, null, "\t")}\n`);

	let development = await call("list_project_packages", { limit: 500 });
	const renamed = await call("set_project_development_package_technical_name", {
		technicalName: "zvibe-live-technical-745",
		expectedTechnicalName: originalManifest.name,
		expectedFingerprint: development.fingerprint,
		expectedManifestSha256: development.manifest.sha256,
		confirm: true,
	});
	if (!renamed.changed || renamed.technicalName !== "zvibe-live-technical-745") throw new Error("Development technical-name mutation failed.");
	development = await call("list_project_packages", { limit: 500 });
	const restoredName = await call("set_project_development_package_technical_name", {
		technicalName: originalManifest.name,
		expectedTechnicalName: "zvibe-live-technical-745",
		expectedFingerprint: development.fingerprint,
		expectedManifestSha256: development.manifest.sha256,
		confirm: true,
	});
	if (!restoredName.changed || restoredName.technicalName !== originalManifest.name) throw new Error("Development technical-name restoration failed.");
	await call("cancel_project_package_operation");
	await new Promise((resolve) => setTimeout(resolve, 250));
	const manager = await call("get_project_package_manager");
	if (!manager.available || !["npm", "yarn", "pnpm", "bun"].includes(manager.packageManager) || !manager.fingerprint) {
		throw new Error("Package-manager executable/version/fingerprint evidence is incomplete.");
	}
	const packages = await call("list_project_packages", { limit: 500 });
	const registries = await call("list_project_package_registries", { limit: 100 });
	const graph = await call("get_project_package_dependency_graph", { limit: 500 });
	const samples = await call("list_project_package_samples", { packageName: fixtureName, sortBy: "publish-date", sortDirection: "desc", limit: 1 });
	if (packages.fingerprint !== manager.fingerprint || graph.fingerprint !== manager.fingerprint || samples.fingerprint !== manager.fingerprint) {
		throw new Error("Package manifest/manager/dependency/sample fingerprints disagree.");
	}
	if (!registries.registries.length || !registries.fingerprint || !Array.isArray(graph.nodes) || !Array.isArray(samples.samples)) {
		throw new Error("Registry/dependency/sample inspection evidence is incomplete.");
	}
	if (samples.total !== 21 || !samples.hasMore || samples.nextOffset !== 1 || samples.samples[0]?.displayName !== "New Live Sample") {
		throw new Error("Publish-date sorting or View More pagination evidence is incomplete.");
	}
	const moreSamples = await call("list_project_package_samples", {
		packageName: fixtureName,
		sortBy: "publish-date",
		sortDirection: "desc",
		offset: samples.nextOffset,
		limit: 1,
	});
	if (moreSamples.samples[0]?.displayName !== "Older Live Sample 20" || !moreSamples.hasMore) throw new Error("View More Samples continuation is incorrect.");
	const selectedSample = samples.samples[0];
	const sampleLease = {
		sampleId: selectedSample.id,
		expectedSourceSha256: selectedSample.sourceSha256,
		expectedPackageFingerprint: samples.fingerprint,
	};
	const sampleDetails = await call("get_project_package_sample_details", sampleLease);
	if (
		sampleDetails.cards?.length !== 2 ||
		sampleDetails.images?.[0]?.format !== "png" ||
		sampleDetails.images[0].width !== 1 ||
		sampleDetails.images[0].height !== 1 ||
		sampleDetails.imported.exists
	)
		throw new Error("Sample Overview/Details/image metadata is incomplete.");
	const samplePlan = await call("plan_project_package_sample_import", {
		...sampleLease,
		targetPath: "assets/.zvibe-package-manager-live-745",
		collision: "fail",
	});
	const imported = await call("apply_project_package_sample_import", { planId: samplePlan.id, expectedSourceSha256: selectedSample.sourceSha256, confirm: true });
	if (!imported.imported || imported.target.sha256 !== selectedSample.sourceSha256) throw new Error("Exact sample import failed.");
	const located = await call("locate_project_package_sample", { ...sampleLease, targetPath: "assets/.zvibe-package-manager-live-745" });
	if (!located.located || !located.matchesSource || located.targetPath !== "assets/.zvibe-package-manager-live-745") throw new Error("Imported sample Locate failed.");
	await call("select_editor_tab", { tab: "inspector" });
	cdp = await connectCdp();
	await cdp.evaluate(`(() => {
		const label = [...document.querySelectorAll('[title]')].find((element) => String(element.getAttribute('title')).split('\\n')[0].endsWith('.scene'));
		const row = label?.closest('.bp5-tree-node-content');
		if (!row) return false;
		row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return true;
	})()`);
	await waitFor(() => cdp.evaluate(`document.body?.innerText.includes('Package Manager')`), Boolean, "normal Package Manager Inspector");
	await cdp.evaluate(`(() => {
		if ([...document.querySelectorAll('button')].some((element) => element.textContent?.trim() === 'Samples')) return true;
		const sectionLabel = [...document.querySelectorAll('*')].find((element) => element.children.length === 0 && element.textContent?.trim() === 'Package Manager');
		const clickable = sectionLabel?.closest('button,[role="button"],.cursor-pointer');
		clickable?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return Boolean(clickable);
	})()`);
	await waitFor(() => cdp.evaluate(`[...document.querySelectorAll('button')].some((element) => element.textContent?.trim() === 'Samples')`), Boolean, "Package Manager tabs");
	await cdp.evaluate(`(() => {
		const samples = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Samples');
		samples?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return Boolean(samples);
	})()`);
	await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-testid="package-manager-samples-view"]'))`), Boolean, "dedicated Samples view");
	await cdp.evaluate(`(() => {
		const root = document.querySelector('[data-testid="package-manager-samples-view"]');
		const refresh = [...(root?.querySelectorAll('button') ?? [])].find((element) => element.textContent?.trim() === 'Refresh');
		refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		return Boolean(refresh);
	})()`);
	await waitFor(
		() =>
			cdp.evaluate(
				`document.querySelector('[data-testid="package-samples-view-more"]') ? true : document.querySelector('[data-testid="package-manager-samples-view"]')?.closest('section,div')?.innerText.slice(0, 1500) ?? false`
			),
		(value) => value === true,
		"View More Samples button",
		// Listing samples reads every installed package's manifest, which takes seconds on a slow machine.
		120_000
	);
	const normalUi = await cdp.evaluate(`({
		samples: Boolean(document.querySelector('[data-testid="package-manager-samples-view"]')),
		viewMore: Boolean(document.querySelector('[data-testid="package-samples-view-more"]')),
		publishSort: [...document.querySelectorAll('option')].some((element) => element.textContent?.trim() === 'Publish Date')
	})`);
	if (!normalUi.samples || !normalUi.viewMore || !normalUi.publishSort) throw new Error("Normal dedicated Samples/Publish Date/View More UI evidence is incomplete.");

	const registrySearch = await call("search_project_package_registry", { query: "babylonjs", limit: 3, timeoutMs: 30_000 }, false, 60_000);
	if (!registrySearch.packages.length) throw new Error("Configured registry search returned no Babylon.js packages.");
	const detail = await call(
		"get_project_package_details",
		{ name: registrySearch.packages[0].name, version: registrySearch.packages[0].version ?? undefined, limit: 5, timeoutMs: 30_000 },
		false,
		60_000
	);
	if (!detail.name || !detail.selected?.version || detail.readmeIncluded !== false) throw new Error("Bounded registry package details/version history is incomplete.");

	const defaultRegistry = registries.registries.find((registry) => registry.scope === null) ?? registries.registries[0];
	const registryPlan = await call("plan_project_package_registry_change", {
		action: "upsert",
		scope: defaultRegistry.scope,
		url: defaultRegistry.url,
		expectedFingerprint: registries.fingerprint,
	});
	if (!registryPlan.id || registryPlan.sourceFingerprint !== registries.fingerprint || !registryPlan.resultSha256) {
		throw new Error("Exact no-write registry plan evidence is incomplete.");
	}

	const direct = packages.directDependencies.find((dependency) => graph.nodes.some((node) => node.direct && node.name === dependency.name && node.version));
	if (!direct) throw new Error("The active project needs at least one resolved direct dependency for deterministic live package planning.");
	const resolved = graph.nodes.find((node) => node.direct && node.name === direct.name && node.version);
	const packagePlan = await call("plan_project_package_changes", {
		expectedFingerprint: packages.fingerprint,
		allowWorkspaceRoot: manager.capabilities.workspaceRootOptIn === true,
		changes: [{ operation: "update", name: direct.name, version: resolved.version, dependencyType: direct.dependencyType, source: { type: "registry" } }],
	});
	if (!packagePlan.id || packagePlan.sourceFingerprint !== packages.fingerprint || packagePlan.changes[0]?.version !== resolved.version) {
		throw new Error("Exact no-write package plan evidence is incomplete.");
	}

	const updateResult = await call("get_project_package_updates", { names: [direct.name], limit: 1, timeoutMs: 30_000 }, false, 60_000);
	if (updateResult.count !== 1 || updateResult.updates[0]?.name !== direct.name) throw new Error("Bounded wanted/latest update inspection is incomplete.");
	const cancel = await call("cancel_project_package_operation");
	if (cancel.canceled !== false || !cancel.reason) throw new Error("Idle package-operation cancellation did not return an explicit no-op result.");

	for (const [name, argumentsValue, expectedText] of [
		["apply_project_package_plan", { planId: "00000000-0000-4000-8000-000000000000", expectedFingerprint: packages.fingerprint, confirm: true }, "missing or expired"],
		[
			"apply_project_package_registry_plan",
			{ planId: "00000000-0000-4000-8000-000000000000", expectedFingerprint: registries.fingerprint, confirm: true },
			"missing or expired",
		],
		["apply_project_package_sample_import", { planId: "00000000-0000-4000-8000-000000000000", expectedSourceSha256: "0".repeat(64), confirm: true }, "missing or expired"],
	]) {
		const failure = await call(name, argumentsValue, true);
		if (!String(failure).includes(expectedText)) throw new Error(`${name} did not reach its exact-plan stale guard.`);
	}
	const unknown = await call("list_project_packages", { unexpected: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Package tool did not reject an unknown field at the MCP boundary.");
	const missingConfirm = await call("modify_project_package", { operation: "remove", name: direct.name, expectedFingerprint: packages.fingerprint }, true);
	if (!String(missingConfirm).includes("-32602")) throw new Error("Compatibility mutation did not require confirm:true at the MCP boundary.");
	const staleTechnicalName = await call(
		"set_project_development_package_technical_name",
		{
			technicalName: "zvibe-should-not-apply",
			expectedTechnicalName: originalManifest.name,
			expectedFingerprint: "0".repeat(64),
			expectedManifestSha256: packages.manifest.sha256,
			confirm: true,
		},
		true
	);
	if (!String(staleTechnicalName).includes("Package state changed")) throw new Error("Development technical-name stale guard failed.");
	if (cdp.runtimeErrors.length) throw new Error(`Electron recorded runtime errors: ${cdp.runtimeErrors.join(" | ")}`);

	console.log(
		`[package-manager-live] PASS — ${requiredTools.length}/19 strict tools, exact technical-name edit/restore, 21-sample publish sorting/View More, verified image/detail cards, atomic import, normal Assets Browser Locate, normal Samples UI, registry/package plans, stale/closed guards, zero renderer errors, and exact cleanup verified.`
	);
} catch (error) {
	console.error(`[package-manager-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (originalManifestBytes) {
			const status = await call("get_editor_status");
			await writeFile(join(dirname(status.projectPath), "package.json"), originalManifestBytes);
		}
		if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
		if (importedTarget) await rm(importedTarget, { recursive: true, force: true });
	} catch (cleanupError) {
		console.error(`[package-manager-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
}
