#!/usr/bin/env node
/** Real stdio/editor lifecycle for Addressables authoring, build/update, deployment, runtime, strict rejection, and exact cleanup. */
import { spawn } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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

function rpc(method, params, timeoutMs = 120_000) {
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

async function optionalRead(path) {
	try {
		return await readFile(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function optionalEntries(path) {
	try {
		return new Set(await readdir(path));
	} catch (error) {
		if (error?.code === "ENOENT") return new Set();
		throw error;
	}
}

async function restoreFile(path, bytes) {
	if (bytes === null) await rm(path, { force: true });
	else await writeFile(path, bytes);
}

const suffix = `${Date.now()}-${process.pid}`;
let projectDirectory;
let configurationPath;
let configurationBaseline;
let reportIndexPath;
let reportIndexBaseline;
let receiptDirectory;
let receiptBaseline = new Set();
let outputRoot;
let deploymentRoot;
let fixturePaths = [];
const fixtureBaselines = new Map();

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "addressables-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const listed = await rpc("tools/list", {});
	const addressableTools = listed.result?.tools?.filter((tool) => tool.name.includes("addressable")) ?? [];
	if (addressableTools.length !== 35) throw new Error(`Expected 35 Addressables tools, found ${addressableTools.length}.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the Addressables live scenario.");
	projectDirectory = dirname(status.projectPath);
	configurationPath = join(projectDirectory, "addressables.json");
	reportIndexPath = join(projectDirectory, ".bjseditor/addressables/build-reports.json");
	receiptDirectory = join(projectDirectory, ".bjseditor/addressables/deployments");
	configurationBaseline = await optionalRead(configurationPath);
	reportIndexBaseline = await optionalRead(reportIndexPath);
	receiptBaseline = await optionalEntries(receiptDirectory);
	outputRoot = join(projectDirectory, `AddressableBuilds/__mcp-live-${suffix}`);
	deploymentRoot = join(projectDirectory, `.bjseditor/addressables-live-deploy-${suffix}`);
	fixturePaths = [
		join(projectDirectory, `.bjseditor/addressable-type-tree-hero-${suffix}.json`),
		join(projectDirectory, `.bjseditor/addressable-type-tree-enemy-${suffix}.json`),
	];
	for (const fixturePath of fixturePaths) fixtureBaselines.set(fixturePath, await optionalRead(fixturePath));
	const records = (prefix) =>
		Array.from({ length: 180 }, (_, index) => ({ veryLongDisplayNameProperty: `${prefix} ${index}`, veryLongCategoryProperty: prefix, enabled: index % 2 === 0 }));
	await writeFile(fixturePaths[0], JSON.stringify(records("Hero")));
	await writeFile(fixturePaths[1], JSON.stringify(records("Enemy")));

	let configuration = await call("list_addressable_groups");
	const groupId = `mcp-live-${suffix}`;
	const address = `mcp/live/${suffix}`;
	const heroAddress = `${address}/hero`;
	const enemyAddress = `${address}/enemy`;
	const deploymentPublicBaseUrl = `http://127.0.0.1:8080/addressables-live-${suffix}`;
	configuration = await call("set_addressable_profile", {
		expectedRevision: configuration.revision,
		id: configuration.activeProfileId,
		remoteLoadPath: deploymentPublicBaseUrl,
	});
	for (const existingGroup of configuration.groups.filter((candidate) => candidate.delivery === "remote" && candidate.assets.length)) {
		configuration = await call("set_addressable_group", {
			expectedRevision: configuration.revision,
			id: existingGroup.id,
			loadPath: deploymentPublicBaseUrl,
		});
	}
	configuration = await call("create_addressable_group", {
		expectedRevision: configuration.revision,
		id: groupId,
		name: `MCP Live ${suffix}`,
		delivery: "remote",
		updateRestriction: "dynamic",
		bundleMode: "pack-together",
		loadPath: deploymentPublicBaseUrl,
	});
	configuration = await call("assign_addressable_asset", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPath: "assets/README.md",
		address,
		labels: ["mcp-live", "verification"],
	});
	configuration = await call("assign_addressable_asset", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPath: relative(projectDirectory, fixturePaths[0]),
		address: heroAddress,
		labels: ["mcp-live", "portable"],
	});
	configuration = await call("assign_addressable_asset", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPath: relative(projectDirectory, fixturePaths[1]),
		address: enemyAddress,
		labels: ["mcp-live", "portable"],
	});
	configuration = await call("set_addressable_settings", {
		expectedRevision: configuration.revision,
		remoteCatalog: true,
		verifyHashes: true,
		extractTypeTrees: true,
		maxConcurrentRequests: 3,
		cacheMaxBytes: 1_048_576,
	});
	await call("set_addressable_settings", { expectedRevision: configuration.revision - 1, verifyHashes: false }, true);
	await call("set_addressable_settings", { expectedRevision: configuration.revision, unknownField: true }, true);
	await call("analyze_addressable_type_trees", { unknownField: true }, true);
	const typeTreeAnalysis = await call("analyze_addressable_type_trees", { offset: 0, limit: 1 });
	if (!typeTreeAnalysis.extractionEnabled || typeTreeAnalysis.summary?.schemaCount !== 1 || typeTreeAnalysis.summary?.structuredAssetCount !== 2 || typeTreeAnalysis.total !== 1)
		throw new Error(
			`Live shared TypeTree analysis did not prove one schema and one pack-together bundle for two structured assets: ${JSON.stringify(typeTreeAnalysis)}`
		);

	const validation = await call("validate_addressable_content", {});
	if (!validation.valid || validation.assetCount < 1) throw new Error("Live Addressables source validation did not produce asset evidence.");
	const profile = configuration.profiles.find((candidate) => candidate.id === configuration.activeProfileId);
	const targetId = `mcp-live-target-${suffix}`;
	configuration = await call("set_addressable_deployment_target", {
		expectedRevision: configuration.revision,
		makeActive: true,
		target: {
			id: targetId,
			name: `MCP Live Target ${suffix}`,
			provider: "filesystem",
			destinationPath: relative(projectDirectory, deploymentRoot),
			publicBaseUrl: profile.remoteLoadPath,
		},
	});

	const full = await call("build_addressable_content", {
		expectedRevision: configuration.revision,
		buildType: "full",
		outputPath: relative(projectDirectory, join(outputRoot, "full")),
	});
	const initialDeployment = await call("deploy_addressable_content", { reportPath: full.reportPath, targetId, expectedCatalogHash: full.catalogHash, confirmPublish: true });
	if (!initialDeployment.pointerPublishedLast) throw new Error("Initial portable Addressables build was not published pointer-last.");
	const update = await call("build_addressable_content", {
		expectedRevision: configuration.revision,
		buildType: "update",
		outputPath: relative(projectDirectory, join(outputRoot, "update")),
		previousStatePath: full.statePath,
	});
	if (full.buildType !== "full" || update.buildType !== "update" || update.baseBuildId !== full.buildId || update.unchangedCount < 1) {
		throw new Error("Full/update Addressables build evidence was incomplete.");
	}
	const typeTreeBuild = await call("get_addressable_type_tree_build", { reportPath: full.reportPath, offset: 0, limit: 1 });
	if (typeTreeBuild.summary?.schemaCount !== 1 || typeTreeBuild.summary?.structuredAssetCount !== 2 || typeTreeBuild.total !== 1)
		throw new Error("Built shared TypeTree evidence did not round-trip through MCP.");
	const bundleEvidence = await call("validate_addressable_portable_bundle", { reportPath: full.reportPath, bundleId: typeTreeBuild.bundles[0].id, offset: 0, limit: 1 });
	if (!bundleEvidence.valid || bundleEvidence.total !== 2 || bundleEvidence.count !== 1 || !bundleEvidence.hasMore)
		throw new Error("Portable bundle validation or pagination evidence was incomplete.");
	const schemaEvidence = await call("get_addressable_type_tree_schema", {
		reportPath: full.reportPath,
		schemaId: bundleEvidence.entries[0].schemaId,
		offset: 0,
		limit: 2,
	});
	if (schemaEvidence.schema?.nodeCount < 2 || schemaEvidence.count !== 2 || !schemaEvidence.hasMore)
		throw new Error("TypeTree schema inspection or pagination evidence was incomplete.");
	await call("get_addressable_type_tree_schema", { reportPath: full.reportPath, schemaId: `zvtts-${"0".repeat(64)}` }, true);
	await call("validate_addressable_portable_bundle", { reportPath: full.reportPath, bundleId: `zvpb-${"0".repeat(64)}` }, true);
	const reports = await call("list_addressable_build_reports");
	const report = await call("get_addressable_build_report", { reportPath: update.reportPath });
	if (!reports.reports.some((candidate) => candidate.buildId === update.buildId) || report.catalogHash !== update.catalogHash)
		throw new Error("Addressables build report evidence did not round-trip.");
	const deployment = await call("deploy_addressable_content", { reportPath: update.reportPath, targetId, expectedCatalogHash: update.catalogHash, confirmPublish: true });
	const verified = await call("verify_addressable_deployment", { targetId, expectedBuildId: update.buildId, expectedCatalogHash: update.catalogHash });
	const receipts = await call("list_addressable_deployment_receipts");
	if (!deployment.pointerPublishedLast || !verified.verified || !receipts.receipts.some((receipt) => receipt.buildId === update.buildId))
		throw new Error("Pointer-last deployment verification was incomplete.");

	const runtime = await call("reload_addressable_runtime", { expectedRevision: configuration.revision });
	const portableDownload = await call("download_addressable_dependencies", { addresses: [heroAddress] });
	const size = await call("get_addressable_download_size", { addresses: [address] });
	const cache = await call("clear_addressable_cache", { addresses: [address] });
	if (
		runtime.profileId !== configuration.activeProfileId ||
		runtime.typeTreeSchemaCount !== 1 ||
		runtime.portableBundleCount !== 1 ||
		portableDownload.downloadedCount !== 1 ||
		size.sizeBytes < 1 ||
		cache.clearedEntries !== 0
	)
		throw new Error("Addressables preview runtime/cache evidence did not match the authored catalog.");

	console.log(
		`[addressables-live] PASS — ${addressableTools.length} tools, exact revision + strict rejection, shared TypeTree analysis/build/schema + portable bundle pagination/validation, ${validation.assetCount} validated asset(s), full→update ${full.buildId}→${update.buildId}, pointer-last deploy/verify/receipt, runtime bundle load + size ${size.sizeBytes} B, exact cleanup.`
	);
} catch (error) {
	console.error(`[addressables-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (configurationPath) await restoreFile(configurationPath, configurationBaseline);
		if (reportIndexPath) await restoreFile(reportIndexPath, reportIndexBaseline);
		if (receiptDirectory) {
			for (const entry of await optionalEntries(receiptDirectory)) {
				if (!receiptBaseline.has(entry)) await rm(join(receiptDirectory, entry), { force: true });
			}
		}
		if (outputRoot) await rm(outputRoot, { recursive: true, force: true });
		if (deploymentRoot) await rm(deploymentRoot, { recursive: true, force: true });
		for (const fixturePath of fixturePaths) await restoreFile(fixturePath, fixtureBaselines.get(fixturePath) ?? null);
	} catch (cleanupError) {
		console.error(`[addressables-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}
