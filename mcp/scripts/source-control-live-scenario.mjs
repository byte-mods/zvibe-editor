#!/usr/bin/env node
/** Real stdio/editor lifecycle for Git-stage semantic conflicts and federated Smart Lock policies. */
import { execFile, spawn } from "node:child_process";
import { access, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

function rpc(method, params, timeoutMs = 60_000) {
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

const requiredTools = [
	"inspect_project_source_control_semantic_conflict",
	"apply_project_source_control_semantic_conflict",
	"inspect_project_asset_lock_policy",
	"list_project_asset_lock_rules",
	"create_project_asset_lock_rule",
	"set_project_asset_lock_rule",
	"delete_project_asset_lock_rule",
];
const suffix = `${process.pid}-${Date.now()}`;
let createdRuleId = null;
let ruleStorePath = null;
let ruleStoreExisted = false;
let ownedGitDirectory = null;

async function ensureProjectGitRepository(projectPath) {
	const projectDirectory = dirname(projectPath);
	try {
		const result = await execFileAsync("git", ["-C", projectDirectory, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
		if (resolve(result.stdout.trim()) === resolve(projectDirectory)) return;
	} catch {
		// A disposable repository is created below only when the project owns no Git metadata.
	}
	const gitDirectory = join(projectDirectory, ".git");
	if (
		await access(gitDirectory)
			.then(() => true)
			.catch(() => false)
	) {
		throw new Error("The project has unreadable Git metadata; refusing to replace it for live verification.");
	}
	await execFileAsync("git", ["-C", projectDirectory, "init", "--initial-branch=zvibe-live"], { encoding: "utf8" });
	ownedGitDirectory = gitDirectory;
	await writeFile(join(gitDirectory, "info", "exclude"), "*\n!project.bjseditor\n", "utf8");
	await execFileAsync("git", ["-C", projectDirectory, "config", "user.name", "Zvibe Live Verification"]);
	await execFileAsync("git", ["-C", projectDirectory, "config", "user.email", "live-verification@zvibe.invalid"]);
	await execFileAsync("git", ["-C", projectDirectory, "add", "--", basename(projectPath)]);
	await execFileAsync("git", ["-C", projectDirectory, "commit", "-m", "Zvibe live verification baseline"], { encoding: "utf8" });
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "source-control-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	const available = new Set(tools.map((tool) => tool.name));
	const missing = requiredTools.filter((name) => !available.has(name));
	if (missing.length) throw new Error(`Missing Source Control tools: ${missing.join(", ")}`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} does not expose a closed input schema.`);
	}

	const editorStatus = await call("get_editor_status");
	if (!editorStatus.ready || !editorStatus.projectPath) throw new Error("A ready project editor is required for the Source Control live scenario.");
	await ensureProjectGitRepository(editorStatus.projectPath);
	const status = await call("get_project_source_control_status");
	const refs = await call("list_project_source_control_refs");
	if (!refs.currentBranch || typeof status.clean !== "boolean")
		throw new Error("A named Git branch and project-scoped status are required for live Source Control verification.");
	const projectFile = basename(editorStatus.projectPath);
	ruleStorePath = join(dirname(editorStatus.projectPath), ".babylon-editor", "asset-lock-rules.json");
	ruleStoreExisted = await access(ruleStorePath)
		.then(() => true)
		.catch(() => false);
	const before = await call("list_project_asset_lock_rules");
	const created = await call("create_project_asset_lock_rule", {
		name: `MCP live Smart Lock ${suffix}`,
		pathPattern: projectFile,
		destinationBranch: refs.currentBranch,
		destinationRemote: null,
		retention: "untilMerged",
	});
	createdRuleId = created.rule.id;
	const matched = await call("list_project_asset_lock_rules", { path: projectFile });
	if (!matched.rules.some((rule) => rule.id === createdRuleId)) throw new Error("Created Smart Lock rule did not match the active project file.");
	const policy = await call("inspect_project_asset_lock_policy", { path: projectFile });
	if (!policy.smartLockRequired || policy.rule.id !== createdRuleId || policy.freshness.destinationBranch !== refs.currentBranch || policy.freshness.networkContacted !== false) {
		throw new Error("Smart Lock policy/freshness evidence was incomplete.");
	}
	const missingLease = await call("acquire_project_asset_lock", { path: projectFile, owner: "Live MCP" }, true);
	if (!String(missingLease).includes("expectedHeadHash")) throw new Error("Smart Lock exact-revision acquisition guard was not enforced.");
	const noIntegration = await call("inspect_project_source_control_semantic_conflict", { path: projectFile }, true);
	if (!String(noIntegration).includes("active Git merge or rebase") && !String(noIntegration).includes("Git worktree root")) {
		throw new Error("Semantic Git inspection did not enforce root ownership or active conflict state.");
	}
	await call("set_project_asset_lock_rule", { id: createdRuleId, retention: "manual", enabled: false });
	const disabled = await call("list_project_asset_lock_rules", { path: projectFile });
	if (disabled.rules.some((rule) => rule.id === createdRuleId)) throw new Error("Disabled Smart Lock rule still matched the project path.");
	await call("delete_project_asset_lock_rule", { id: createdRuleId });
	createdRuleId = null;
	const after = await call("list_project_asset_lock_rules");
	if (after.total !== before.total) throw new Error("Smart Lock live scenario did not restore the rule store baseline.");
	await call("inspect_project_asset_lock_policy", { path: projectFile, unexpected: true }, true);

	console.log(
		`[source-control-live] PASS — ${requiredTools.length}/7 new tools discovered with closed schemas; real editor Git status/refs, Smart Lock CRUD/matching/freshness/exact-revision guard, disabled-rule behavior, semantic active-conflict guard, and cleanup verified.`
	);
} catch (error) {
	console.error(`[source-control-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	if (createdRuleId) {
		try {
			await call("delete_project_asset_lock_rule", { id: createdRuleId });
		} catch (cleanupError) {
			console.error(`[source-control-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			process.exitCode = 1;
		}
	}
	if (ruleStorePath && !ruleStoreExisted) {
		try {
			const store = JSON.parse(await readFile(ruleStorePath, "utf-8"));
			if (store?.version !== 1 || !Array.isArray(store.rules) || store.rules.length) {
				throw new Error("Refusing to remove a non-empty or malformed Smart Lock rule store.");
			}
			await unlink(ruleStorePath);
		} catch (cleanupError) {
			if (cleanupError?.code !== "ENOENT") {
				console.error(`[source-control-live] store cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
				process.exitCode = 1;
			}
		}
	}
	if (ownedGitDirectory) {
		try {
			await rm(ownedGitDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch (cleanupError) {
			console.error(`[source-control-live] Git cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			process.exitCode = 1;
		}
	}
	child.kill("SIGTERM");
}
