#!/usr/bin/env node
/** Real MCP stdio -> rebuilt Electron verification for the portable Unity 6.5 Version Control workspace. */
import { execFile, spawn } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import WebSocket from "ws";

import { getExpectedMcpToolCount } from "./live-scenario-contract.mjs";

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

async function connectCdp() {
	const port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315);
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status}.`);
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
			} else if (message.method === "Runtime.exceptionThrown") {
				runtimeErrors.push(message.params?.exceptionDetails?.text ?? "Runtime.exceptionThrown");
			} else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
				runtimeErrors.push(message.params.entry.text);
			}
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
		if (await evaluate("location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html') && Boolean(document.querySelector('.flexlayout__tab_button'))")) {
			await send("Runtime.enable");
			await send("Log.enable");
			return { socket, evaluate, runtimeErrors };
		}
		socket.close();
	}
	throw new Error("No Zvibe Editor CDP page was found.");
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
	"get_project_source_control_workspace",
	"get_project_source_control_workspace_layout",
	"set_project_source_control_workspace_layout",
	"inspect_project_source_control_changeset",
	"inspect_project_source_control_shelveset",
	"apply_project_source_control_folder_action",
	"create_project_source_control_shelveset",
	"apply_project_source_control_shelveset_paths",
	"delete_project_source_control_shelveset",
	"rename_project_source_control_ref",
];
let originalLayout = null;
let changedLayout = null;
let cdp;
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
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "version-control-65-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} tools, received ${tools.length}.`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is absent or has an open schema.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} lacks ${hint}.`);
		}
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required.");
	await ensureProjectGitRepository(status.projectPath);
	const workspace = await call("get_project_source_control_workspace", { pendingFilter: "definitely-no-match-live-751", limit: 50 });
	if (
		workspace.contract !== "portable-git-source-control-workspace-v1" ||
		workspace.boundaries.provider !== "Git" ||
		workspace.boundaries.unityVersionControlServiceIdentity !== false ||
		workspace.boundaries.remoteContacted !== false ||
		!workspace.pending.emptyState?.includes("filter") ||
		!workspace.branchExplorer.commits.length
	) {
		throw new Error(`Workspace evidence is incomplete: ${JSON.stringify(workspace)}`);
	}
	const changeset = await call("inspect_project_source_control_changeset", { hash: workspace.branchExplorer.commits[0].hash });
	if (changeset.changeset.hash !== workspace.branchExplorer.commits[0].hash || !changeset.comparison.mode || typeof changeset.diff !== "string") {
		throw new Error(`Changeset properties/diff evidence is incomplete: ${JSON.stringify(changeset)}`);
	}
	originalLayout = await call("get_project_source_control_workspace_layout");
	const preset = originalLayout.branchExplorerPercent === 30 && originalLayout.changesPercent === 45 ? [32, 43, 25] : [30, 45, 25];
	const saved = await call("set_project_source_control_workspace_layout", {
		expectedRevision: originalLayout.revision,
		branchExplorerPercent: preset[0],
		changesPercent: preset[1],
		propertiesPercent: preset[2],
		activePanel: "branches",
	});
	changedLayout = saved.layout;
	const stale = await call(
		"set_project_source_control_workspace_layout",
		{ expectedRevision: originalLayout.revision, branchExplorerPercent: 32, changesPercent: 43, propertiesPercent: 25, activePanel: "pending" },
		true
	);
	if (!String(stale).includes("changed after inspection")) throw new Error("Layout exact-revision guard was not enforced.");
	const guardedFolder = await call("apply_project_source_control_folder_action", { action: "add", path: "assets", expectedWorkspaceFingerprint: "0".repeat(64) }, true);
	if (!String(guardedFolder).includes("changed after inspection")) throw new Error("Folder-action workspace fingerprint guard was not enforced.");
	const currentBranch = workspace.branchExplorer.refs.localBranches.find((branch) => branch.current);
	if (currentBranch) {
		const guardedRename = await call(
			"rename_project_source_control_ref",
			{ kind: "branch", name: currentBranch.name, newName: `${currentBranch.name}-live-guard`, expectedHash: "0".repeat(40), confirm: true },
			true
		);
		if (!String(guardedRename).includes("worktree root") && !String(guardedRename).includes("changed after inspection")) {
			throw new Error("Ref rename ownership or exact-hash guard was not enforced.");
		}
	}

	cdp = await connectCdp();
	await cdp.evaluate(
		`(() => {
			const sceneName = ${JSON.stringify(basename(status.scenePath ?? ""))};
			const sceneLabel = [...document.querySelectorAll('span.truncate')].find((element) => element.textContent?.trim() === sceneName);
			sceneLabel?.closest('.bp5-tree-node-content')?.click();
			return Boolean(sceneLabel);
		})()`
	);
	await waitFor(
		() =>
			cdp.evaluate(`(() => {
				if (document.querySelector('[data-testid="source-control-65-workspace"]')) return true;
				const heading = [...document.querySelectorAll('div')].find((element) => element.children.length === 0 && element.textContent?.trim() === 'Source Control');
				if (!heading) {
					const sceneName = ${JSON.stringify(basename(status.scenePath ?? ""))};
					const sceneLabel = [...document.querySelectorAll('span.truncate')].find((element) => element.textContent?.trim() === sceneName);
					(sceneLabel?.closest('.bp5-tree-node-content') ?? document.querySelector('.bp5-tree-root > .bp5-tree-node > .bp5-tree-node-content'))?.click();
					return false;
				}
				const header = heading?.parentElement?.parentElement;
				const section = header?.parentElement;
				if (header && section?.children.length === 1) header.click();
				const refresh = [...document.querySelectorAll('button')].find((element) => element.textContent?.trim() === 'Refresh Git Status');
				if (refresh && !refresh.dataset.liveVerificationClicked) {
					refresh.dataset.liveVerificationClicked = 'true';
					refresh.click();
				}
				return Boolean(heading && refresh);
			})()`),
		(value) => value === true,
		"Scene Inspector Source Control section",
		60_000
	);
	const ui = await waitFor(
		() =>
			cdp.evaluate(
				`(() => { const root = document.querySelector('[data-testid=source-control-65-workspace]'); return root ? { text: root.textContent, title: document.title } : null; })()`
			),
		(value) =>
			value?.text?.includes("Version Control 6.5 Workspace") &&
			value?.text?.includes("Branch Explorer") &&
			value?.text?.includes("Pending Changes") &&
			value?.text?.includes("Shelvesets") &&
			Boolean(value?.title?.trim()),
		"Version Control 6.5 visible workspace"
	);
	if (cdp.runtimeErrors.length) throw new Error(`Renderer errors were captured: ${JSON.stringify(cdp.runtimeErrors)}`);
	console.log(
		`[version-control-65-live] PASS — ${tools.length} tools; ${requiredTools.length}/10 strict tools; branch graph ${workspace.branchExplorer.commits.length} changesets; exact changeset diff, filtered empty state, persisted splitter mutation/stale guard, folder fingerprint guard, ref guard, and visible “${ui.title}” workspace verified.`
	);
} catch (error) {
	console.error(`[version-control-65-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	if (originalLayout && changedLayout) {
		try {
			await call("set_project_source_control_workspace_layout", {
				expectedRevision: changedLayout.revision,
				branchExplorerPercent: originalLayout.branchExplorerPercent,
				changesPercent: originalLayout.changesPercent,
				propertiesPercent: originalLayout.propertiesPercent,
				activePanel: originalLayout.activePanel,
			});
		} catch (cleanupError) {
			console.error(`[version-control-65-live] layout cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			process.exitCode = 1;
		}
	}
	if (ownedGitDirectory) {
		try {
			await rm(ownedGitDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		} catch (cleanupError) {
			console.error(`[version-control-65-live] Git cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
			process.exitCode = 1;
		}
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
}
