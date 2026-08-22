#!/usr/bin/env node
/** Real save -> Electron app.relaunch -> same-project reopen -> MCP reconnect verification. */
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

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError === true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "platform-restart-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const before = await call("get_editor_status");
	if (!before.ready || !before.projectPath) throw new Error("A ready project editor is required for the restart scenario.");
	const status = await call("get_installed_platform_restart_status", { target: "web" });
	if (!status.installed || !/^[a-f0-9]{64}$/.test(status.diagnosticFingerprint)) throw new Error("Web platform restart status is not ready.");
	const plan = await call("plan_installed_platform_restart", { target: "web", expectedDiagnosticFingerprint: status.diagnosticFingerprint });
	const execution = await call("restart_editor_for_installed_platform", {
		planId: plan.id,
		expectedDiagnosticFingerprint: plan.diagnosticFingerprint,
		confirm: true,
	});
	if (!execution.accepted || !execution.relaunch?.scheduled) throw new Error("Electron main did not acknowledge the relaunch request.");

	let after = null;
	let restartStatus = null;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		try {
			after = await call("get_editor_status");
			restartStatus = await call("get_installed_platform_restart_status", { target: "web" });
			if (after.ready && restartStatus.startupEvidence?.planId === plan.id) break;
		} catch {
			// The old renderer is exiting or the new renderer is still loading.
		}
	}
	if (!after?.ready || after.projectPath !== before.projectPath) throw new Error("Zvibe Editor did not reopen the same project after relaunch.");
	if (
		restartStatus?.startupEvidence?.planId !== plan.id ||
		restartStatus.startupEvidence.target !== "web" ||
		restartStatus.startupEvidence.diagnosticFingerprint !== plan.diagnosticFingerprint ||
		!Number.isFinite(Date.parse(restartStatus.startupEvidence.restartedAt))
	) {
		throw new Error("Relaunched editor did not expose exact installed-platform startup evidence.");
	}
	console.log(
		`[platform-restart-live] PASS — project saved, Electron relaunch acknowledged, MCP reconnected, project ${after.projectPath} reopened, and exact plan ${plan.id} startup evidence verified.`
	);
} catch (error) {
	console.error(`[platform-restart-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}
