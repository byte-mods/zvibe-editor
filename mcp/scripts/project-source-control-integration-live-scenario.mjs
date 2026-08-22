#!/usr/bin/env node
/** Positive real-editor MCP verification for merge/rebase preview, conflict inspection/resolution, continuation, and abort. */
import { execFile, spawn } from "node:child_process";
import { access, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";

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
	const result = await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }, encoding: "utf8" });
	return result.stdout.trim();
}

const suffix = `${Date.now()}-${process.pid}`;
const fixtureFolder = `agentdata/zvibe-source-control-integration-${suffix}`;
const fixtureScript = `zvibe-source-control-integration-${suffix}.mts`;
const textPath = `${fixtureFolder}/conflict.txt`;
const prefabPath = `${fixtureFolder}/conflict.prefab`;
const imagePath = `${fixtureFolder}/conflict.png`;
const rebasePath = `${fixtureFolder}/rebase.txt`;
const abortPath = `${fixtureFolder}/abort.txt`;
let projectDirectory = null;
let ownedGitDirectory = null;
let fixtureCreated = false;

async function png(color) {
	return (await sharp(Buffer.from([...color, ...color, ...color, ...color]), { raw: { width: 2, height: 2, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()).toString("base64");
}

async function writeFixtures(values) {
	const source = `
import { ensureDir, writeFile } from "fs-extra";
import { join } from "path";
export async function main(editor) {
	const root = editor.state.projectPath.slice(0, editor.state.projectPath.lastIndexOf("/"));
	const folder = join(root, ${JSON.stringify(fixtureFolder)});
	await ensureDir(folder);
	await writeFile(join(folder, "conflict.txt"), ${JSON.stringify(values.text)}, "utf8");
	await writeFile(join(folder, "conflict.prefab"), JSON.stringify(${JSON.stringify(values.prefab)}) + "\\n", "utf8");
	await writeFile(join(folder, "conflict.png"), Buffer.from(${JSON.stringify(values.png)}, "base64"));
	await writeFile(join(folder, "rebase.txt"), ${JSON.stringify(values.rebase)}, "utf8");
	await writeFile(join(folder, "abort.txt"), ${JSON.stringify(values.abort)}, "utf8");
	return { folder: ${JSON.stringify(fixtureFolder)} };
}`;
	const result = await call("run_agent_script", { name: fixtureScript, content: source });
	fixtureCreated = true;
	return result;
}

async function initializeRepository(projectPath) {
	projectDirectory = dirname(projectPath);
	try {
		const root = await git(projectDirectory, "rev-parse", "--show-toplevel");
		if (resolve(root) === resolve(projectDirectory)) throw new Error("The active project already owns a Git repository; refusing to mutate it for isolated integration verification.");
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
	await git(projectDirectory, "init", "--initial-branch=zvibe-integration-main");
	ownedGitDirectory = gitDirectory;
	await writeFile(join(gitDirectory, "info", "exclude"), `*\n!project.bjseditor\n!agentdata/\nagentdata/*\n!${fixtureFolder}/\n!${fixtureFolder}/*\n`, "utf8");
	await git(projectDirectory, "config", "user.name", "Zvibe Integration Verification");
	await git(projectDirectory, "config", "user.email", "integration-verification@zvibe.invalid");
	await git(projectDirectory, "add", "--", "project.bjseditor", fixtureFolder);
	await git(projectDirectory, "commit", "-m", "Zvibe integration fixture baseline");
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "project-source-control-integration-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	assert(status.ready && status.projectPath, "A ready editor project is required", status);
	const red = await png([255, 0, 0, 255]);
	const green = await png([0, 255, 0, 255]);
	const blue = await png([0, 0, 255, 255]);
	const base = { text: "base\n", prefab: { position: [0, 0, 0], health: 100 }, png: red, rebase: "base\n", abort: "base\n" };
	await writeFixtures(base);
	await initializeRepository(status.projectPath);

	await git(projectDirectory, "switch", "-c", "zvibe-integration-feature");
	await writeFixtures({ ...base, text: "feature\n", prefab: { position: [0, 0, 0], health: 80 }, png: blue });
	await git(projectDirectory, "add", "--", fixtureFolder);
	await git(projectDirectory, "commit", "-m", "Incoming integration fixture edits");
	await git(projectDirectory, "switch", "zvibe-integration-main");
	await writeFixtures({ ...base, text: "main\n", prefab: { position: [2, 0, 0], health: 100 }, png: green });
	await git(projectDirectory, "add", "--", fixtureFolder);
	await git(projectDirectory, "commit", "-m", "Local integration fixture edits");

	const preview = await call("preview_project_source_control_integration", { target: "zvibe-integration-feature" });
	assert(preview.relationship === "diverged" && preview.currentOnly === 1 && preview.targetOnly === 1, "Merge preview did not describe divergent branches", preview);
	const cleanState = await call("get_project_source_control_integration_state");
	assert(cleanState.operation === null, "Integration state was active before merge", cleanState);
	const started = await call("start_project_source_control_merge", { target: "zvibe-integration-feature", confirm: true });
	assert(started.completed === false && started.integration?.operation === "merge" && started.integration.conflictCount === 3, "Merge did not stop on all three fixture conflicts", started);

	const details = await call("inspect_project_source_control_conflict_details", { path: textPath });
	assert(details.textEditable === true && details.base?.text === "base\n" && details.ours?.text === "main\n" && details.theirs?.text === "feature\n", "Text conflict details are incomplete", details);
	const image = await call("inspect_project_source_control_image_conflict", { path: imagePath, includePreviews: true });
	assert(image.base?.status === "ready" && image.ours?.status === "ready" && image.theirs?.status === "ready" && image.comparisons?.oursToTheirs?.comparable === true, "Image conflict analysis is incomplete", image);
	const semantic = await call("inspect_project_source_control_semantic_conflict", { path: prefabPath });
	assert(semantic.merge?.summary?.unresolvedConflicts === 0 && semantic.fingerprint && semantic.merge?.outputHash, "Semantic prefab merge did not auto-resolve independent edits", semantic);
	const appliedSemantic = await call("apply_project_source_control_semantic_conflict", {
		path: prefabPath,
		expectedFingerprint: semantic.fingerprint,
		expectedOutputHash: semantic.merge.outputHash,
		confirm: true,
	});
	assert(appliedSemantic.applied === true, "Semantic conflict application failed", appliedSemantic);
	const appliedText = await call("apply_project_source_control_text_resolution", {
		path: textPath,
		content: "resolved by Zvibe MCP\n",
		expectedFingerprint: details.fingerprint,
		confirm: true,
	});
	assert(appliedText.applied === true, "Custom text resolution failed", appliedText);
	const resolvedImage = await call("resolve_project_source_control_conflict", { path: imagePath, resolution: "ours", confirm: true });
	assert(resolvedImage.resolved === true && resolvedImage.integration?.conflictCount === 0, "Image conflict stage resolution failed", resolvedImage);
	const merged = await call("continue_project_source_control_integration", { message: "Verify semantic text and image conflict tools", confirm: true });
	assert(merged.completed === true && merged.integration?.operation === null, "Merge continuation did not complete", merged);

	await git(projectDirectory, "switch", "-c", "zvibe-rebase-feature");
	await writeFixtures({ ...base, text: "resolved by Zvibe MCP\n", prefab: { position: [2, 0, 0], health: 80 }, png: green, rebase: "feature rebase\n" });
	await git(projectDirectory, "add", "--", fixtureFolder);
	await git(projectDirectory, "commit", "-m", "Feature rebase edit");
	await git(projectDirectory, "switch", "zvibe-integration-main");
	await writeFixtures({ ...base, text: "resolved by Zvibe MCP\n", prefab: { position: [2, 0, 0], health: 80 }, png: green, rebase: "main rebase\n" });
	await git(projectDirectory, "add", "--", fixtureFolder);
	await git(projectDirectory, "commit", "-m", "Main rebase edit");
	await git(projectDirectory, "switch", "zvibe-rebase-feature");
	const rebaseStarted = await call("start_project_source_control_rebase", { target: "zvibe-integration-main", confirm: true });
	assert(rebaseStarted.completed === false && rebaseStarted.integration?.operation === "rebase" && rebaseStarted.integration.conflictCount === 1, "Rebase did not stop on its fixture conflict", rebaseStarted);
	await call("resolve_project_source_control_conflict", { path: rebasePath, resolution: "theirs", confirm: true });
	const rebased = await call("continue_project_source_control_integration", { confirm: true });
	assert(rebased.completed === true && rebased.operation === "rebase", "Rebase continuation did not complete", rebased);

	await git(projectDirectory, "switch", "zvibe-integration-main");
	await git(projectDirectory, "switch", "-c", "zvibe-abort-feature");
	await writeFixtures({ ...base, text: "resolved by Zvibe MCP\n", prefab: { position: [2, 0, 0], health: 80 }, png: green, rebase: "main rebase\n", abort: "feature abort\n" });
	await git(projectDirectory, "add", "--", fixtureFolder);
	await git(projectDirectory, "commit", "-m", "Feature abort edit");
	await git(projectDirectory, "switch", "zvibe-integration-main");
	await writeFixtures({ ...base, text: "resolved by Zvibe MCP\n", prefab: { position: [2, 0, 0], health: 80 }, png: green, rebase: "main rebase\n", abort: "main abort\n" });
	await git(projectDirectory, "add", "--", fixtureFolder);
	await git(projectDirectory, "commit", "-m", "Main abort edit");
	await call("start_project_source_control_merge", { target: "zvibe-abort-feature", confirm: true });
	const aborted = await call("abort_project_source_control_integration", { confirm: true });
	assert(aborted.aborted === true && aborted.integration?.operation === null, "Merge abort did not restore the pre-operation state", aborted);

	await call("delete_asset", { path: fixtureFolder, confirm: true });
	await call("delete_asset", { path: `agentdata/${fixtureScript}`, confirm: true }).catch(() => undefined);
	fixtureCreated = false;
	console.log(JSON.stringify({ ok: true, verified: 12, mergeConflicts: 3, semanticResolved: true, textResolved: true, imageCompared: true, rebaseCompleted: true, abortRestored: true }, null, 2));
} finally {
	try {
		if (projectDirectory && ownedGitDirectory) {
			const state = await git(projectDirectory, "status", "--porcelain=v1").catch(() => "");
			void state;
			await git(projectDirectory, "merge", "--abort").catch(() => undefined);
			await git(projectDirectory, "rebase", "--abort").catch(() => undefined);
		}
		if (fixtureCreated) {
			await call("delete_asset", { path: fixtureFolder, confirm: true }).catch(() => undefined);
			await call("delete_asset", { path: `agentdata/${fixtureScript}`, confirm: true }).catch(() => undefined);
		}
	} catch (cleanupError) {
		stderr += `\nCleanup error: ${cleanupError?.stack ?? cleanupError}`;
	}
	if (ownedGitDirectory) await rm(ownedGitDirectory, { recursive: true, force: true });
	child.kill();
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}
