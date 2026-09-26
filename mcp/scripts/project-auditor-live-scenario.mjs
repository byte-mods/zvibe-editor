#!/usr/bin/env node
/** Real stdio/Electron lifecycle for compile-time serialization diagnostics and the asynchronous Project Auditor. */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

import WebSocket from "ws";

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
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status} on port ${port}.`);
	const targets = (await response.json()).filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
	for (const target of targets) {
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
			} else if (message.method === "Log.entryAdded" && ["error", "warning"].includes(message.params?.entry?.level)) {
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
		if (await evaluate("Boolean(document.querySelector('[data-project-auditor-status]'))")) {
			await send("Runtime.enable");
			await send("Log.enable");
			return { socket, evaluate, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Electron page on CDP port ${port} contains the Project Auditor workspace.`);
}

async function waitFor(read, predicate, label, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

async function waitForAudit(id) {
	return waitFor(
		() => call("get_project_audit", { id }),
		(value) => ["completed", "cancelled", "failed"].includes(value?.job?.status),
		`project audit ${id}`,
		// The scenario audits ~500 generated sources for its cancellation check; slow CI or software-rendered machines need minutes.
		300_000
	);
}

const requiredTools = [
	"get_project_auditor_capabilities",
	"get_project_auditor_state",
	"start_project_audit",
	"get_project_audit",
	"list_project_audit_issues",
	"cancel_project_audit",
	"apply_project_auditor_fix",
];
const supportTools = [
	"get_editor_status",
	"read_script",
	"write_script",
	"validate_script",
	"delete_script",
	"attach_script",
	"detach_script",
	"get_scene_hierarchy",
	"import_asset",
	"set_asset_metadata",
	"get_asset_importer",
	"delete_asset",
	"select_editor_tab",
	"set_preview_play_mode",
];
const suffix = `${Date.now()}-${process.pid}`;
const scriptPath = `src/mcp-project-auditor-${suffix}.ts`;
const texturePath = `assets/mcp-project-auditor-${suffix}-texture.png`;
const atlasPath = `assets/000-mcp-project-auditor-${suffix}-atlas.json`;
const particlePath = `assets/particleSystems/mcp-project-auditor-${suffix}.json`;
const cancellationDirectoryName = `mcp-project-auditor-cancel-${suffix}`;
let projectDirectory;
let scriptCreated = false;
let textureCreated = false;
let atlasCreated = false;
let particleCreated = false;
let attachedNodeId;
let originalScriptsContent;
let cdp;
let fixtureDirectory;
let cancellationSourceDirectory;
let cancellationImported = false;

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "project-auditor-live-scenario", version: "1.0.0" },
	});
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of [...requiredTools, ...supportTools]) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing from real stdio discovery.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable editor project is required.");
	projectDirectory = dirname(status.projectPath);
	const capabilities = await call("get_project_auditor_capabilities");
	if (capabilities.model !== "zvibe-project-auditor-v1" || capabilities.asynchronous !== true || capabilities.particleTextures?.fixable !== true) {
		throw new Error(`Project Auditor capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}

	await call("write_script", {
		path: scriptPath,
		content:
			'import { guiFromAsset, visibleAsNumber } from "babylonjs-editor-tools";\nexport class AuditedComponent {\n @visibleAsNumber() public broken: string = "fast";\n @guiFromAsset<AuditedComponent>("ui.gui") public ui: unknown;\n}\n',
	});
	scriptCreated = true;
	const scriptDiagnostics = await call("validate_script", { path: scriptPath });
	if (scriptDiagnostics.valid !== false || !scriptDiagnostics.diagnostics.some((entry) => entry.code === "SER1006")) {
		throw new Error(`Compile-time serialization diagnostics did not report SER1006: ${JSON.stringify(scriptDiagnostics)}`);
	}
	const hierarchy = await call("get_scene_hierarchy");
	const nodes = [];
	const visit = (node) => {
		nodes.push(node);
		for (const childNode of node.children ?? []) visit(childNode);
	};
	for (const rootNode of hierarchy) visit(rootNode);
	const attachmentTarget = nodes.find((node) => ["Mesh", "GroundMesh", "TransformNode"].includes(node.type));
	if (!attachmentTarget) throw new Error(`The live project has no script-attachable node: ${JSON.stringify(hierarchy)}`);
	originalScriptsContent = (await call("read_script", { path: "src/scripts.ts" })).content;
	await call("attach_script", { nodeId: attachmentTarget.id, path: scriptPath });
	attachedNodeId = attachmentTarget.id;

	fixtureDirectory = join(tmpdir(), `zvibe-project-auditor-${suffix}`);
	await mkdir(fixtureDirectory, { recursive: true });
	const textureSourcePath = join(fixtureDirectory, "texture.png");
	const atlasSourcePath = join(fixtureDirectory, "atlas.json");
	const particleSourcePath = join(fixtureDirectory, "particle.json");
	await writeFile(
		textureSourcePath,
		Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==", "base64")
	);
	await call("import_asset", { sourcePath: textureSourcePath, destinationPath: texturePath });
	textureCreated = true;
	await writeFile(
		atlasSourcePath,
		JSON.stringify({ frames: { hero: { frame: { x: 0, y: 0, w: 8, h: 8 } } }, meta: { image: texturePath.slice("assets/".length), size: { w: 128, h: 128 } } }, null, 2)
	);
	await call("import_asset", { sourcePath: atlasSourcePath, destinationPath: atlasPath });
	atlasCreated = true;
	await writeFile(particleSourcePath, JSON.stringify({ id: `particles-${suffix}`, name: "Audited Particles", textureName: texturePath }, null, 2));
	await call("import_asset", { sourcePath: particleSourcePath, destinationPath: particlePath });
	particleCreated = true;
	await call("set_asset_metadata", { path: texturePath, importer: { readable: true } });

	await call("select_editor_tab", { tab: "project-auditor" });
	cdp = await connectCdp();
	const compileAttempt = await call("set_preview_play_mode", { action: "play" });
	if (compileAttempt.playing !== true || compileAttempt.preparing !== true)
		throw new Error(`Play did not enter its asynchronous compilation phase: ${JSON.stringify(compileAttempt)}`);
	const compileResult = await waitFor(
		() => call("get_editor_status"),
		(value) => value.play?.preparing === false,
		"Play compilation to finish",
		120_000
	);
	if (compileResult.play?.playing !== false) throw new Error(`Invalid serialized field unexpectedly entered Play mode: ${JSON.stringify(compileResult.play)}`);
	await call("select_editor_tab", { tab: "console" });
	await waitFor(
		async () => ({ body: await cdp.evaluate("document.body.innerText"), runtimeErrors: cdp.runtimeErrors }),
		(value) => value.body.includes("SER1006") || value.runtimeErrors.some((message) => message.includes("SER1006")),
		"visible or renderer-captured SER1006 Play compilation failure"
	);
	await call("detach_script", { nodeId: attachedNodeId, path: scriptPath });
	attachedNodeId = undefined;
	await call("write_script", { path: "src/scripts.ts", content: originalScriptsContent });
	originalScriptsContent = undefined;
	await call("select_editor_tab", { tab: "project-auditor" });
	const initialState = await call("get_project_auditor_state");
	if (initialState.active) await waitForAudit(initialState.active.id);
	const stableState = await call("get_project_auditor_state");
	const started = await call("start_project_audit", {
		expectedRevision: stableState.revision,
		settings: {
			categories: ["serialization", "obsolete-api", "particle-texture-readability", "atlas-waste"],
			obsoleteTargetVersion: "2.0.0",
			maximumIssues: 5000,
			atlasAllocationWasteThresholdPercent: 35,
			atlasUnusedRegionThresholdPercent: 50,
		},
	});
	if (!["queued", "running"].includes(started.job.status)) throw new Error(`Audit did not start asynchronously: ${JSON.stringify(started)}`);
	const completed = await waitForAudit(started.job.id);
	if (completed.job.status !== "completed" || !completed.job.issuesFingerprint) throw new Error(`Audit failed: ${JSON.stringify(completed)}`);
	const page = await call("list_project_audit_issues", { id: started.job.id, expectedJobRevision: completed.job.revision, offset: 0, limit: 100 });
	const codes = new Set(page.issues.map((issue) => issue.code));
	for (const code of ["SER1006", "PA2002", "PA3001", "PA4001"]) {
		if (!codes.has(code)) throw new Error(`Completed audit is missing ${code}: ${JSON.stringify(page)}`);
	}
	if (page.issues.some((issue) => "fix" in issue)) throw new Error("Internal fix payload leaked through MCP issue inspection.");

	const staleStart = await call("start_project_audit", { expectedRevision: stableState.revision }, true);
	if (!staleStart.includes("expectedRevision")) throw new Error(`Stale global revision error is not actionable: ${staleStart}`);
	const staleList = await call("list_project_audit_issues", { id: started.job.id, expectedJobRevision: completed.job.revision - 1 }, true);
	if (!staleList.includes("expectedJobRevision")) throw new Error(`Stale job revision error is not actionable: ${staleList}`);

	await waitFor(
		() =>
			cdp.evaluate(
				`(() => ({ status: document.querySelector('[data-project-auditor-status]')?.dataset.projectAuditorStatus, codes: Array.from(document.querySelectorAll('[data-project-auditor-issue]')).map((node) => node.dataset.projectAuditorIssue) }))()`
			),
		(value) => value?.status === "completed" && value.codes.includes("SER1006") && value.codes.includes("PA3001"),
		"visible completed Project Auditor findings"
	);

	const particleIssue = page.issues.find((issue) => issue.code === "PA3001");
	const beforeFix = await call("get_project_auditor_state");
	const fixed = await call("apply_project_auditor_fix", {
		id: started.job.id,
		issueId: particleIssue.id,
		expectedIssueFingerprint: particleIssue.fingerprint,
		expectedRevision: beforeFix.revision,
		expectedJobRevision: completed.job.revision,
		confirm: true,
	});
	if (!fixed.issue.resolvedAt) throw new Error(`Safe fix did not resolve its exact issue: ${JSON.stringify(fixed)}`);
	const importer = await call("get_asset_importer", { path: texturePath });
	if (importer.importer.settings.readable !== false) throw new Error(`Safe fix did not disable CPU Readable: ${JSON.stringify(importer)}`);

	const afterFixState = await call("get_project_auditor_state");
	const rerun = await call("start_project_audit", {
		expectedRevision: afterFixState.revision,
		settings: { categories: ["particle-texture-readability"] },
	});
	const rerunCompleted = await waitForAudit(rerun.job.id);
	if (rerunCompleted.job.status !== "completed") throw new Error(`Particle re-audit failed: ${JSON.stringify(rerunCompleted)}`);
	const rerunPage = await call("list_project_audit_issues", { id: rerun.job.id, expectedJobRevision: rerunCompleted.job.revision, limit: 100 });
	if (rerunPage.issues.some((issue) => issue.code === "PA3001")) throw new Error(`Resolved Read/Write issue returned after re-audit: ${JSON.stringify(rerunPage)}`);

	cancellationSourceDirectory = join(tmpdir(), cancellationDirectoryName);
	await mkdir(cancellationSourceDirectory, { recursive: true });
	await Promise.all(
		Array.from({ length: 512 }, (_, index) => writeFile(join(cancellationSourceDirectory, `source-${index}.ts`), `export const value${index}: number = ${index};\n`))
	);
	await call("import_asset", { sourcePath: cancellationSourceDirectory, destinationPath: `src/${cancellationDirectoryName}` });
	cancellationImported = true;
	const beforeCancel = await call("get_project_auditor_state");
	const cancelRun = await call("start_project_audit", { expectedRevision: beforeCancel.revision });
	const activeState = await call("get_project_auditor_state");
	if (activeState.active?.id !== cancelRun.job.id) throw new Error("Cancellation fixture completed before exposing active asynchronous state.");
	await call("cancel_project_audit", { id: cancelRun.job.id, expectedRevision: activeState.revision });
	const cancelled = await waitForAudit(cancelRun.job.id);
	if (cancelled.job.status !== "cancelled") throw new Error(`Audit did not cancel cooperatively: ${JSON.stringify(cancelled)}`);
	await call("delete_asset", { path: `src/${cancellationDirectoryName}`, confirm: true });
	cancellationImported = false;

	const expectedCompileError = /SER1006|Serialization diagnostics failed|Failed to compile play scripts|Failed to start play mode/;
	const unexpectedRuntimeErrors = cdp.runtimeErrors.filter((message) => !expectedCompileError.test(message));
	if (unexpectedRuntimeErrors.length)
		throw new Error(`Electron emitted unexpected runtime errors during the Project Auditor lifecycle: ${JSON.stringify(unexpectedRuntimeErrors)}`);

	console.log(
		"[project-auditor-live] PASS — 7/7 strict tools, real stdio discovery/calls, live Play emitter blocked by visible SER1006 diagnostics, four-category asynchronous findings, visible workspace state, exact stale guards, safe importer fix, clean re-audit, cooperative cancellation, and zero unexpected renderer exceptions verified."
	);
} catch (error) {
	console.error(`[project-auditor-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (attachedNodeId) await call("detach_script", { nodeId: attachedNodeId, path: scriptPath });
		if (originalScriptsContent !== undefined) await call("write_script", { path: "src/scripts.ts", content: originalScriptsContent });
		if (scriptCreated) await call("delete_script", { path: scriptPath, confirm: true });
		for (const [path, created] of [
			[particlePath, particleCreated],
			[atlasPath, atlasCreated],
			[texturePath, textureCreated],
		]) {
			if (created) await call("delete_asset", { path, confirm: true });
		}
		if (cancellationImported) await call("delete_asset", { path: `src/${cancellationDirectoryName}`, confirm: true });
		if (cancellationSourceDirectory) await rm(cancellationSourceDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	} catch (cleanupError) {
		console.error(`[project-auditor-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
}
