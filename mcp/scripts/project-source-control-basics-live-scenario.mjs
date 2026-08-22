#!/usr/bin/env node
/** Positive real-editor MCP verification for portable Git workspace, shelvesets, commits, refs, remotes, and authentication diagnostics. */
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
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

function rpc(method, params, timeoutMs = 120_000) {
	const id = nextId++;
	return new Promise((resolveValue, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}.`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolveValue(message);
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

async function git(cwd, ...args) {
	const result = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" });
	return result.stdout.trim();
}

let ownedGitDirectory = null;
let remoteDirectory = null;
let projectDirectory = null;
let originalText = null;
let textChanged = false;
const textPath = "assets/README.md";
const suffix = `${Date.now()}-${process.pid}`;
const marker = `\nZvibe MCP source-control live verification ${suffix}\n`;

async function initializeDisposableRepository(projectPath) {
	projectDirectory = dirname(projectPath);
	try {
		const root = await git(projectDirectory, "rev-parse", "--show-toplevel");
		if (resolve(root) === resolve(projectDirectory)) throw new Error("The active project already owns a Git repository; refusing to replace or mutate it for isolated live verification.");
	} catch (error) {
		if (String(error).includes("already owns")) throw error;
	}
	const gitDirectory = join(projectDirectory, ".git");
	if (
		await access(gitDirectory)
			.then(() => true)
			.catch(() => false)
	) {
		throw new Error("The project has unreadable Git metadata; refusing to replace it.");
	}
	await git(projectDirectory, "init", "--initial-branch=zvibe-live-main");
	ownedGitDirectory = gitDirectory;
	await writeFile(join(gitDirectory, "info", "exclude"), "*\n!project.bjseditor\n!assets/\nassets/*\n!assets/README.md\n", "utf8");
	await git(projectDirectory, "config", "user.name", "Zvibe Live Verification");
	await git(projectDirectory, "config", "user.email", "live-verification@zvibe.invalid");
	await git(projectDirectory, "add", "--", basename(projectPath), textPath);
	await git(projectDirectory, "commit", "-m", "Zvibe source-control live baseline");
	remoteDirectory = await mkdtemp(join(tmpdir(), "zvibe-source-control-remote-"));
	await git(remoteDirectory, "init", "--bare", "--initial-branch=zvibe-live-main");
	await git(projectDirectory, "remote", "add", "origin", remoteDirectory);
}

async function appendMarker() {
	const initial = await call("get_collaborative_text_document", { path: textPath, limit: 5000 });
	originalText ??= initial.text;
	await call("apply_collaborative_text_operations", {
		path: textPath,
		actorId: "zvibe-git-live",
		operationId: `append-${suffix}-${Date.now()}`,
		operations: [{ type: "insert", afterId: initial.items.at(-1)?.id ?? null, text: marker }],
	});
	textChanged = true;
}

async function restoreText() {
	if (!textChanged) return;
	const current = await call("get_collaborative_text_document", { path: textPath, limit: 5000 });
	if (current.text === originalText) {
		textChanged = false;
		return;
	}
	const insertedIds = current.items.slice([...originalText].length).map((entry) => entry.id);
	if (insertedIds.length) {
		await call("apply_collaborative_text_operations", {
			path: textPath,
			actorId: "zvibe-git-live",
			operationId: `restore-${suffix}-${Date.now()}`,
			operations: [{ type: "delete", ids: insertedIds }],
		});
	}
	const restored = await call("get_collaborative_text_document", { path: textPath, limit: 5000 });
	assert(restored.text === originalText, "MCP text cleanup did not restore the source-control fixture", { before: originalText.length, after: restored.text.length });
	await call("rebase_collaborative_text_document", { path: textPath, expectedSourceHash: restored.sourceHash });
	textChanged = false;
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "project-source-control-basics-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	assert(status.ready && status.projectPath, "A ready editor project is required", status);
	await initializeDisposableRepository(status.projectPath);

	await appendMarker();
	let workspace = await call("get_project_source_control_workspace", { limit: 100 });
	assert(workspace.pending.totalMatching >= 1, "Tracked MCP text edit was not visible in the Git workspace", workspace.pending);
	const diff = await call("get_project_source_control_diff", { path: textPath });
	assert(diff.diff?.includes("Zvibe MCP source-control") || String(diff).includes("Zvibe MCP source-control"), "Working-tree diff omitted the MCP fixture marker", diff);
	const history = await call("get_project_source_control_history", { limit: 10 });
	assert((history.commits ?? history.history)?.length >= 1, "Source-control history is empty", history);

	const shelveset = await call("create_project_source_control_shelveset", {
		message: `Zvibe shelveset ${suffix}`,
		expectedWorkspaceFingerprint: workspace.workspaceFingerprint,
		confirm: true,
	});
	assert(shelveset.created === true && shelveset.shelveset?.hash, "Shelveset creation failed", shelveset);
	const inspectedShelveset = await call("inspect_project_source_control_shelveset", { shelvesetHash: shelveset.shelveset.hash });
	assert(inspectedShelveset.diff?.includes("Zvibe MCP source-control"), "Shelveset inspection omitted the tracked change", inspectedShelveset);
	workspace = await call("get_project_source_control_workspace", { limit: 100 });
	const undone = await call("apply_project_source_control_folder_action", {
		action: "undo",
		path: "assets",
		expectedWorkspaceFingerprint: workspace.workspaceFingerprint,
		confirm: true,
	});
	assert(undone.applied === true, "Folder undo did not apply", undone);
	textChanged = false;
	workspace = await call("get_project_source_control_workspace", { limit: 100 });
	const appliedShelveset = await call("apply_project_source_control_shelveset_paths", {
		shelvesetHash: shelveset.shelveset.hash,
		paths: [textPath],
		expectedWorkspaceFingerprint: workspace.workspaceFingerprint,
		confirm: true,
	});
	assert(appliedShelveset.applied === true && appliedShelveset.retained === true, "Partial shelveset apply failed", appliedShelveset);
	textChanged = true;
	const deletedShelveset = await call("delete_project_source_control_shelveset", { shelvesetHash: shelveset.shelveset.hash, confirm: true });
	assert(deletedShelveset.deleted === true, "Shelveset deletion failed", deletedShelveset);

	workspace = await call("get_project_source_control_workspace", { limit: 100 });
	const folderAdded = await call("apply_project_source_control_folder_action", { action: "add", path: "assets", expectedWorkspaceFingerprint: workspace.workspaceFingerprint });
	assert(folderAdded.applied === true && folderAdded.status?.stagedCount >= 1, "Folder Add to Source Control did not stage the fixture", folderAdded);
	const stagedDiff = await call("get_project_source_control_diff", { path: textPath, staged: true });
	assert(String(stagedDiff.diff ?? stagedDiff).includes("Zvibe MCP source-control"), "Staged diff omitted the fixture", stagedDiff);
	const unstaged = await call("unstage_project_source_control_paths", { paths: [textPath] });
	assert(unstaged.status?.stagedCount === 0 || unstaged.stagedCount === 0, "Unstage did not clear the index", unstaged);
	const staged = await call("stage_project_source_control_paths", { paths: [textPath] });
	assert(staged.status?.stagedCount >= 1 || staged.stagedCount >= 1, "Stage did not populate the index", staged);
	const committed = await call("commit_project_source_control", { message: `Verify MCP source control ${suffix}`, signoff: true, confirm: true });
	assert(committed.committed === true && committed.commit?.hash, "Commit did not complete", committed);

	const pushed = await call("push_project_source_control", { remote: "origin", branch: "zvibe-live-main", setUpstream: true, confirm: true });
	assert(pushed.pushed === true, "Initial push failed", pushed);
	const authentication = await call("inspect_project_source_control_authentication", { remote: "origin" });
	assert(authentication.status === "ready" && authentication.fetch?.transports?.includes("local"), "Local remote authentication diagnostics are incomplete", authentication);
	const fetched = await call("fetch_project_source_control", { remote: "origin", prune: true, tags: true, confirm: true });
	assert(fetched.fetched === true, "Fetch failed", fetched);
	const pulled = await call("pull_project_source_control", { remote: "origin", branch: "zvibe-live-main", confirm: true });
	assert(pulled.pulled === true || pulled.fastForwarded === false || pulled.status, "Fast-forward pull returned no completion evidence", pulled);
	let remoteRefs = await call("inspect_project_source_control_remote_refs", { remote: "origin" });
	assert(remoteRefs.branches?.some((entry) => entry.name === "zvibe-live-main"), "Authoritative remote inspection omitted the pushed main branch", remoteRefs);

	await call("create_project_source_control_branch", { name: "zvibe-live-old", confirm: true });
	let refs = await call("list_project_source_control_refs");
	const oldBranch = refs.localBranches.find((entry) => entry.name === "zvibe-live-old");
	const renamedBranch = await call("rename_project_source_control_ref", {
		kind: "branch",
		name: "zvibe-live-old",
		newName: "zvibe-live-feature",
		expectedHash: oldBranch.hash,
		confirm: true,
	});
	assert(renamedBranch.renamed === true, "Branch rename failed", renamedBranch);
	await call("switch_project_source_control_branch", { name: "zvibe-live-feature", confirm: true });
	await call("switch_project_source_control_branch", { name: "zvibe-live-main", confirm: true });
	const publishedBranch = await call("publish_project_source_control_remote_branch", {
		remote: "origin",
		localBranch: "zvibe-live-feature",
		remoteBranch: "zvibe-live-feature",
		confirm: true,
	});
	assert(publishedBranch.published === true || publishedBranch.branches?.some((entry) => entry.name === "zvibe-live-feature"), "Remote branch publication failed", publishedBranch);
	remoteRefs = await call("inspect_project_source_control_remote_refs", { remote: "origin" });
	const remoteFeature = remoteRefs.branches.find((entry) => entry.name === "zvibe-live-feature");
	const removedRemoteBranch = await call("delete_project_source_control_remote_branch", {
		remote: "origin",
		branch: "zvibe-live-feature",
		expectedHash: remoteFeature.hash,
		confirm: true,
	});
	assert(removedRemoteBranch.deleted === true, "Remote branch deletion failed", removedRemoteBranch);
	const removedLocalBranch = await call("delete_project_source_control_branch", { name: "zvibe-live-feature", confirm: true });
	assert(removedLocalBranch.deleted === true, "Local branch deletion failed", removedLocalBranch);

	await call("create_project_source_control_tag", { name: "zvibe-live-label-old", message: "Zvibe live annotated label", confirm: true });
	refs = await call("list_project_source_control_refs");
	const oldLabel = refs.tags.find((entry) => entry.name === "zvibe-live-label-old");
	const renamedLabel = await call("rename_project_source_control_ref", {
		kind: "label",
		name: "zvibe-live-label-old",
		newName: "zvibe-live-label",
		expectedHash: oldLabel.hash,
		confirm: true,
	});
	assert(renamedLabel.renamed === true, "Annotated label rename failed", renamedLabel);
	const publishedTag = await call("publish_project_source_control_remote_tag", { remote: "origin", tag: "zvibe-live-label", confirm: true });
	assert(publishedTag.published === true || publishedTag.tags?.some((entry) => entry.name === "zvibe-live-label"), "Remote tag publication failed", publishedTag);
	remoteRefs = await call("inspect_project_source_control_remote_refs", { remote: "origin" });
	const remoteTag = remoteRefs.tags.find((entry) => entry.name === "zvibe-live-label");
	const removedRemoteTag = await call("delete_project_source_control_remote_tag", { remote: "origin", tag: "zvibe-live-label", expectedHash: remoteTag.hash, confirm: true });
	assert(removedRemoteTag.deleted === true, "Remote tag deletion failed", removedRemoteTag);
	const removedLocalTag = await call("delete_project_source_control_tag", { name: "zvibe-live-label", confirm: true });
	assert(removedLocalTag.deleted === true, "Local tag deletion failed", removedLocalTag);

	await restoreText();
	console.log(JSON.stringify({ ok: true, verified: 27, commit: committed.commit.hash, exactTextRestored: true, disposableGitRemoved: true }, null, 2));
} finally {
	try {
		await restoreText();
	} catch (cleanupError) {
		stderr += `\nText cleanup error: ${cleanupError?.stack ?? cleanupError}`;
	}
	if (ownedGitDirectory) await rm(ownedGitDirectory, { recursive: true, force: true });
	if (remoteDirectory) await rm(remoteDirectory, { recursive: true, force: true });
	child.kill();
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}
