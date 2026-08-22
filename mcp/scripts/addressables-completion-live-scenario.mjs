#!/usr/bin/env node
/** Positive live coverage for Addressables profile/asset/catalog/runtime-update compatibility tools with MCP-only project mutations. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
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

function rpc(method, params, timeoutMs = 180_000) {
	const id = nextId++;
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolvePromise(message);
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

async function optionalBytes(path) {
	try {
		return await readFile(path);
	} catch (error) {
		if (error?.code === "ENOENT") return null;
		throw error;
	}
}

async function directorySnapshot(path) {
	try {
		const entries = await readdir(path, { withFileTypes: true });
		const files = {};
		for (const entry of entries) {
			if (entry.isFile()) files[entry.name] = (await readFile(join(path, entry.name))).toString("base64");
		}
		return files;
	} catch (error) {
		if (error?.code === "ENOENT") return {};
		throw error;
	}
}

const required = [
	"create_addressable_profile",
	"delete_addressable_profile",
	"delete_addressable_group",
	"set_addressable_asset",
	"remove_addressable_asset",
	"set_addressable_asset_labels",
	"find_addressable_assets_by_labels",
	"diff_addressable_catalogs",
	"build_addressable_catalog",
	"delete_addressable_deployment_target",
	"get_addressable_runtime_status",
	"check_addressable_catalog_updates",
	"update_addressable_catalog",
];
const suffix = `${Date.now()}-${process.pid}`;
const profileId = `mcp-addressables-profile-${suffix}`;
const groupId = `mcp-addressables-group-${suffix}`;
const targetId = `mcp-addressables-target-${suffix}`;
const assetFolder = `assets/mcp-addressables-${suffix}`;
const assetPath = `${assetFolder}/fixture.json`;
const catalogOnePath = `${assetFolder}/catalog-one.json`;
const catalogTwoPath = `${assetFolder}/catalog-two.json`;
const buildFolder = `AddressableBuilds/mcp-addressables-${suffix}`;
const deploymentFolder = `.bjseditor/addressables-deployment-${suffix}`;
const setupScriptName = `addressables-completion-setup-${suffix}.js`;
const cleanupScriptName = `addressables-completion-cleanup-${suffix}.js`;
let httpServer;
let projectDirectory;
let configurationPath;
let reportIndexPath;
let receiptDirectory;
let configurationBaseline;
let reportIndexBaseline;
let receiptBaseline = {};
let configuration;
let baselineActiveProfileId;
let fixtureInstalled = false;

async function cleanupFiles() {
	if (fixtureInstalled && projectDirectory) {
		const restoreSource = `
import { dirname, join } from "path";
import { ensureDir, readdir, remove, writeFile } from "fs-extra";
export async function main(editor) {
	const project = dirname(editor.state.projectPath);
	const restore = async (path, encoded) => {
		const absolute = join(project, path);
		if (encoded === null) await remove(absolute);
		else { await ensureDir(dirname(absolute)); await writeFile(absolute, Buffer.from(encoded, "base64")); }
	};
	await restore("addressables.json", ${JSON.stringify(configurationBaseline?.toString("base64") ?? null)});
	await restore(".bjseditor/addressables/build-reports.json", ${JSON.stringify(reportIndexBaseline?.toString("base64") ?? null)});
	const receiptDirectory = join(project, ".bjseditor/addressables/deployments");
	await ensureDir(receiptDirectory);
	for (const entry of await readdir(receiptDirectory)) if (!Object.hasOwn(${JSON.stringify(receiptBaseline)}, entry)) await remove(join(receiptDirectory, entry));
	for (const [entry, encoded] of Object.entries(${JSON.stringify(receiptBaseline)})) await writeFile(join(receiptDirectory, entry), Buffer.from(encoded, "base64"));
	return "addressables baseline restored";
}`;
		await call("run_agent_script", { name: cleanupScriptName, content: restoreSource });
		fixtureInstalled = false;
	}
	for (const path of [
		assetFolder,
		buildFolder,
		deploymentFolder,
		`agentdata/${setupScriptName}`,
		`agentdata/${cleanupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${cleanupScriptName.replace(/\.js$/, ".cjs.map")}`,
	]) {
		await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "addressables-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Addressables completion testing.");
	projectDirectory = dirname(status.projectPath);
	configurationPath = join(projectDirectory, "addressables.json");
	reportIndexPath = join(projectDirectory, ".bjseditor/addressables/build-reports.json");
	receiptDirectory = join(projectDirectory, ".bjseditor/addressables/deployments");
	configurationBaseline = await optionalBytes(configurationPath);
	reportIndexBaseline = await optionalBytes(reportIndexPath);
	receiptBaseline = await directorySnapshot(receiptDirectory);

	const deploymentRoot = join(projectDirectory, deploymentFolder);
	httpServer = createServer(async (request, response) => {
		try {
			const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
			const absolute = normalize(resolve(deploymentRoot, `.${pathname}`));
			if (absolute !== deploymentRoot && !absolute.startsWith(`${deploymentRoot}/`)) throw new Error("invalid path");
			const bytes = await readFile(absolute);
			response.writeHead(200, { "content-type": absolute.endsWith(".json") ? "application/json" : "application/octet-stream" });
			response.end(bytes);
		} catch {
			response.writeHead(404);
			response.end("not found");
		}
	});
	await new Promise((resolvePromise, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", resolvePromise);
	});
	const address = httpServer.address();
	const publicBaseUrl = `http://127.0.0.1:${address.port}`;

	const setupSource = `
import { dirname, join } from "path";
import { ensureDir, writeJSON } from "fs-extra";
export async function main(editor) {
	const directory = join(dirname(editor.state.projectPath), ${JSON.stringify(assetFolder)});
	await ensureDir(directory);
	await writeJSON(join(directory, "fixture.json"), { id: ${JSON.stringify(suffix)}, value: 1 }, { spaces: "\\t" });
	return "addressables fixture created";
}`;
	await call("run_agent_script", { name: setupScriptName, content: setupSource });
	fixtureInstalled = true;

	configuration = await call("list_addressable_groups");
	baselineActiveProfileId = configuration.activeProfileId;
	configuration = await call("create_addressable_profile", {
		expectedRevision: configuration.revision,
		id: profileId,
		name: `MCP Addressables ${suffix}`,
		localBuildPath: `${buildFolder}/local`,
		localLoadPath: `${buildFolder}/local`,
		remoteBuildPath: `${buildFolder}/remote`,
		remoteLoadPath: publicBaseUrl,
	});
	configuration = await call("set_addressable_settings", { expectedRevision: configuration.revision, activeProfileId: profileId, remoteCatalog: true });
	for (const existingGroup of configuration.groups.filter((candidate) => candidate.delivery === "remote" && candidate.assets.length)) {
		configuration = await call("set_addressable_group", { expectedRevision: configuration.revision, id: existingGroup.id, loadPath: publicBaseUrl });
	}
	configuration = await call("create_addressable_group", {
		expectedRevision: configuration.revision,
		id: groupId,
		name: `MCP Addressables Group ${suffix}`,
		delivery: "remote",
		updateRestriction: "dynamic",
		bundleMode: "pack-together",
		buildPath: `${buildFolder}/group`,
		loadPath: publicBaseUrl,
	});
	configuration = await call("assign_addressable_asset", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPath,
		address: `mcp/addressables/${suffix}/original`,
		labels: ["mcp-addressables", "original"],
	});
	configuration = await call("set_addressable_asset", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPathOrAddress: assetPath,
		address: `mcp/addressables/${suffix}/updated`,
		labels: ["mcp-addressables", "updated"],
	});
	configuration = await call("set_addressable_asset_labels", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPathOrAddress: assetPath,
		labels: ["mcp-addressables", "catalog-one"],
	});
	const found = await call("find_addressable_assets_by_labels", { labels: ["mcp-addressables", "catalog-one"], match: "all" });
	if (found.assets.length !== 1 || found.assets[0].path !== assetPath) throw new Error("Addressable label lookup evidence is incomplete.");
	const catalogOne = await call("build_addressable_catalog", { expectedRevision: configuration.revision, profileId, outputPath: catalogOnePath });
	configuration = await call("set_addressable_asset_labels", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPathOrAddress: assetPath,
		labels: ["mcp-addressables", "catalog-two"],
	});
	const catalogTwo = await call("build_addressable_catalog", { expectedRevision: configuration.revision, profileId, outputPath: catalogTwoPath });
	const catalogDiff = await call("diff_addressable_catalogs", { previousCatalogPath: catalogOne.outputPath, nextCatalogPath: catalogTwo.outputPath });
	if (catalogDiff.summary.changed !== 1) throw new Error(`Addressable catalog diff evidence is incomplete: ${JSON.stringify(catalogDiff.summary)}`);
	configuration = await call("remove_addressable_asset", { expectedRevision: configuration.revision, id: groupId, assetPathOrAddress: assetPath });
	configuration = await call("assign_addressable_asset", {
		expectedRevision: configuration.revision,
		id: groupId,
		assetPath,
		address: `mcp/addressables/${suffix}/runtime`,
		labels: ["mcp-addressables", "runtime"],
	});
	configuration = await call("set_addressable_deployment_target", {
		expectedRevision: configuration.revision,
		makeActive: true,
		target: { id: targetId, name: `MCP Addressables Target ${suffix}`, provider: "filesystem", destinationPath: deploymentFolder, publicBaseUrl },
	});
	const built = await call("build_addressable_content", { expectedRevision: configuration.revision, profileId, buildType: "full", outputPath: `${buildFolder}/full` });
	await call("deploy_addressable_content", { reportPath: built.reportPath, targetId, expectedCatalogHash: built.catalogHash, confirmPublish: true });
	await call("reload_addressable_runtime", { expectedRevision: configuration.revision, profileId });
	const runtimeBefore = await call("get_addressable_runtime_status");
	const available = await call("check_addressable_catalog_updates");
	const updated = await call("update_addressable_catalog");
	const runtimeAfter = await call("get_addressable_runtime_status");
	if (!available.configured || !updated.configured || runtimeAfter.buildId !== built.buildId || runtimeBefore.buildId === undefined) {
		throw new Error("Addressable runtime catalog check/update evidence is incomplete.");
	}

	configuration = await call("delete_addressable_deployment_target", { expectedRevision: configuration.revision, id: targetId });
	configuration = await call("remove_addressable_asset", { expectedRevision: configuration.revision, id: groupId, assetPathOrAddress: assetPath });
	configuration = await call("delete_addressable_group", { expectedRevision: configuration.revision, id: groupId });
	configuration = await call("set_addressable_settings", { expectedRevision: configuration.revision, activeProfileId: baselineActiveProfileId });
	configuration = await call("delete_addressable_profile", { expectedRevision: configuration.revision, id: profileId });
	await cleanupFiles();
	console.log(
		"[addressables-completion-live] PASS — 13/13 previously uncovered tools, profile/group/asset lifecycle, label search, catalog build/diff, deployment-target deletion, remote runtime check/update, and MCP-only cleanup verified."
	);
} catch (error) {
	console.error(`[addressables-completion-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		await cleanupFiles();
	} catch (cleanupError) {
		console.error(`[addressables-completion-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	await new Promise((resolvePromise) => (httpServer ? httpServer.close(resolvePromise) : resolvePromise()));
	child.kill("SIGTERM");
}
