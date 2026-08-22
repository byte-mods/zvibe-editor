#!/usr/bin/env node
/** Real stdio MCP + Electron + loopback-provider lifecycle for all ten portable project-service categories. */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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
	for (let newline; (newline = stdout.indexOf("\n")) >= 0; ) {
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

async function waitFor(read, predicate, label, timeoutMs = 45_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

async function connectCdp() {
	const port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315);
	const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
	for (const target of targets.filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
		const socket = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			socket.addEventListener("open", resolve, { once: true });
			socket.addEventListener("error", reject, { once: true });
		});
		let requestId = 1;
		const requests = new Map();
		const runtimeErrors = [];
		socket.addEventListener("message", (event) => {
			const message = JSON.parse(event.data);
			if (message.id !== undefined && requests.has(message.id)) {
				requests.get(message.id)(message);
				requests.delete(message.id);
			} else if (message.method === "Runtime.exceptionThrown")
				runtimeErrors.push(message.params?.exceptionDetails?.exception?.description ?? message.params?.exceptionDetails?.text);
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
			if (result.exceptionDetails) throw new Error(`CDP evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
			return result.result.value;
		};
		if (
			await evaluate(
				"Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html') && document.querySelector('[data-project-services-panel]'))"
			)
		) {
			await send("Runtime.enable");
			await send("Log.enable");
			const click = async (selector) => {
				await evaluate(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); element?.scrollIntoView({block:'center',inline:'center'}); })()`);
				await new Promise((resolve) => setTimeout(resolve, 50));
				const rect = await evaluate(
					`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element)return null; const r=element.getBoundingClientRect(); const x=r.left+r.width/2; const y=r.top+r.height/2; return {x,y,visible:r.width>0&&r.height>0&&x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&(document.elementFromPoint(x,y)===element||element.contains(document.elementFromPoint(x,y))),disabled:Boolean(element.disabled)}; })()`
				);
				if (!rect?.visible || rect.disabled) throw new Error(`UI selector is missing, hidden, or disabled: ${selector}`);
				await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
				await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			};
			const setValue = async (selector, value) =>
				evaluate(
					`(() => { const element=document.querySelector(${JSON.stringify(selector)}); if(!element) throw new Error('Missing UI selector'); const prototype=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(String(value))}); element.dispatchEvent(new Event(element instanceof HTMLSelectElement?'change':'input',{bubbles:true})); return element.value; })()`
				);
			return { socket, evaluate, click, setValue, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Electron Services workspace was found on CDP port ${port}.`);
}

const requiredTools = [
	"get_project_services_capabilities",
	"get_project_services_configuration",
	"set_project_service_environment",
	"set_active_project_service_environment",
	"delete_project_service_environment",
	"set_project_service_category",
	"set_project_service_resources",
	"validate_project_services_readiness",
	"plan_project_services_deployment",
	"deploy_project_services",
	"cancel_project_services_deployment",
	"list_project_services_deployment_reports",
	"get_project_services_deployment_report",
	"delete_project_services_deployment_report",
	"start_project_services_emulator",
	"stop_project_services_emulator",
	"get_project_services_emulator_status",
	"get_project_services_emulator_events",
	"reset_project_services_emulator",
];

const expectedCategories = ["auth", "cloudSave", "analytics", "iap", "ads", "matchmaking", "leaderboards", "remoteConfig", "contentDelivery", "cloudFunctions"];
const suffix = Date.now().toString(36);
const environmentId = `codex-hosted-${suffix}`;
const deploymentRelative = `.zvibe/hosted-services-deploy-${suffix}.mjs`;
const functionRelative = `.zvibe/hosted-services-function-${suffix}.mjs`;
const fixtureAgentName = `services-live-fixture-${suffix}.js`;
const cleanupAgentName = `services-live-cleanup-${suffix}.js`;
let projectRoot = null;
let packagePath = null;
let packageBytes = null;
let cdp = null;
let reportId = null;
let emulatorRunning = false;

const resources = {
	analyticsEvents: [],
	iapProducts: [],
	adPlacements: [],
	matchmakingQueues: [],
	leaderboards: [{ id: "career", name: "Career", sortOrder: "descending", keepBest: true, maxEntries: 100 }],
	remoteConfig: [{ key: "difficulty", value: "hard" }],
	contentDeliveryBuckets: [
		{
			id: "game",
			badges: [{ id: "latest", releaseId: "r1" }],
			releases: [{ id: "r1", entries: [{ key: "level", url: "https://cdn.example.test/level.glb", sha256: "a".repeat(64), bytes: 1024, contentType: "model/gltf-binary" }] }],
		},
	],
	cloudFunctions: [{ id: "grant", entryPoint: functionRelative, timeoutMs: 5_000, authenticated: true, emulatorResponse: { granted: true } }],
};

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "services-live-scenario", version: "2.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or open.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
	}

	const status = await waitFor(
		() => call("get_editor_status").catch(() => null),
		(value) => value?.ready && value?.projectPath,
		"ready project editor",
		60_000
	);
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for the Services live scenario.");
	projectRoot = dirname(status.projectPath);
	packagePath = join(projectRoot, "package.json");
	packageBytes = await readFile(packagePath);
	await call("run_agent_script", {
		name: fixtureAgentName,
		content: `
import { join } from "path";
import { ensureDir, readJSON, writeFile, writeJSON } from "fs-extra";
export async function main(editor) {
	void editor;
	const root = ${JSON.stringify(projectRoot)};
	const packagePath = join(root, "package.json");
	const packageJson = await readJSON(packagePath);
	packageJson.scripts = { ...(packageJson.scripts ?? {}), "services:deploy": ${JSON.stringify(`node ${deploymentRelative}`)} };
	await ensureDir(join(root, ".zvibe"));
	await writeFile(join(root, ${JSON.stringify(deploymentRelative)}), "console.log(JSON.stringify({deployed:true,args:process.argv.slice(2)}));\\n");
	await writeFile(join(root, ${JSON.stringify(functionRelative)}), "export default async function grant(input){ return { granted:true, input }; }\\n");
	await writeJSON(packagePath, packageJson, { spaces: "\\t" });
	return JSON.stringify({ configured: true });
}`,
	});

	const capabilities = await call("get_project_services_capabilities");
	if (capabilities.version !== 2 || JSON.stringify(capabilities.categories) !== JSON.stringify(expectedCategories) || capabilities.resources?.length !== 8) {
		throw new Error("Hosted Services capability contract is incomplete.");
	}
	if (
		capabilities.deployment?.credentialValuesPersisted !== false ||
		capabilities.emulator?.loopbackOnly !== true ||
		JSON.stringify(capabilities.notCoreAdapters) !== JSON.stringify(["lobbyRelay"])
	) {
		throw new Error("Hosted Services security/provider boundary evidence is incomplete.");
	}
	const before = await call("get_project_services_configuration");
	let configuration = await call("set_project_service_environment", {
		expectedRevision: before.revision,
		id: environmentId,
		name: `Hosted Live ${suffix}`,
		kind: "development",
		deployment: { script: "services:deploy", credentialEnvironmentVariables: [] },
	});
	configuration = await call("set_active_project_service_environment", { expectedRevision: configuration.revision, id: environmentId });
	configuration = await call("set_project_service_resources", { expectedRevision: configuration.revision, environmentId, resources });
	const emulator = await call("start_project_services_emulator", { expectedRevision: configuration.revision, environmentId, port: 0 });
	emulatorRunning = true;
	if (!emulator.running || emulator.host !== "127.0.0.1") throw new Error("Loopback Services emulator did not start.");
	for (const category of ["leaderboards", "remoteConfig", "contentDelivery", "cloudFunctions"]) {
		configuration = await call("set_project_service_category", {
			expectedRevision: configuration.revision,
			environmentId,
			category,
			settings: { enabled: true, provider: "local", endpoint: emulator.endpoint, options: {} },
		});
	}
	const readiness = await call("validate_project_services_readiness", { environmentId });
	if (!readiness.readiness?.runtime || !readiness.readiness?.deployment || readiness.environment?.id !== environmentId) {
		throw new Error(`Hosted Services readiness evidence is incomplete: ${JSON.stringify(readiness)}`);
	}

	let accessToken = "";
	async function provider(path, init = {}, authenticated = true) {
		const response = await fetch(`${emulator.endpoint}${path}`, {
			...init,
			headers: {
				"X-Zvibe-Environment": environmentId,
				...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
				...(authenticated && accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
				...(init.headers ?? {}),
			},
		});
		const payload = await response.json();
		if (!response.ok) throw new Error(`Provider ${path} failed: ${JSON.stringify(payload)}`);
		return payload;
	}
	const session = await provider("/v1/auth/anonymous", { method: "POST", body: JSON.stringify({ profile: `hosted-${suffix}` }) }, false);
	accessToken = session.accessToken;
	const score = await provider("/v1/leaderboards/career/score", { method: "POST", body: JSON.stringify({ score: 42, metadata: { level: 3 } }) });
	if (score.rank !== 1 || score.score !== 42) throw new Error("Leaderboard score submission failed.");
	if ((await provider("/v1/leaderboards/career/scores?offset=0&limit=20")).entries?.[0]?.playerId !== session.playerId) throw new Error("Leaderboard paging failed.");
	if ((await provider("/v1/remote-config?keys=difficulty")).values?.difficulty !== "hard") throw new Error("Remote Config fetch failed.");
	if ((await provider("/v1/content-delivery/game/latest", {}, false)).releaseId !== "r1") throw new Error("Content Delivery manifest failed.");
	const functionHeaders = { "X-Idempotency-Key": "function_0001" };
	const functionResult = await provider("/v1/cloud-functions/grant", { method: "POST", headers: functionHeaders, body: JSON.stringify({ payload: { amount: 1 } }) });
	const functionReplay = await provider("/v1/cloud-functions/grant", { method: "POST", headers: functionHeaders, body: JSON.stringify({ payload: { amount: 2 } }) });
	if (functionResult.executionId !== functionReplay.executionId || functionResult.result?.granted !== true) throw new Error("Cloud Function idempotent emulator call failed.");
	const emulatorStatus = await call("get_project_services_emulator_status");
	if (emulatorStatus.counts?.leaderboardScores !== 1 || emulatorStatus.counts?.functionExecutions !== 1) throw new Error("Hosted Services emulator evidence is incomplete.");
	const events = await call("get_project_services_emulator_events", { afterSequence: 0, limit: 200 });
	for (const category of ["leaderboards", "remoteConfig", "contentDelivery", "cloudFunctions"])
		if (!events.events.some((event) => event.category === category)) throw new Error(`${category} emulator event is missing.`);
	const resetEmulator = await call("reset_project_services_emulator", { confirm: true });
	const resetStatus = await call("get_project_services_emulator_status");
	if (!resetEmulator.reset || Object.values(resetStatus.counts ?? {}).some((count) => count !== 0)) {
		throw new Error(`Hosted Services emulator reset evidence is incomplete: ${JSON.stringify({ resetEmulator, resetStatus })}`);
	}

	const stalePlan = await call("plan_project_services_deployment", { expectedRevision: configuration.revision, environmentId, dryRun: true, reconcile: true });
	if (!stalePlan.valid) throw new Error(`Hosted Services deployment plan is blocked: ${JSON.stringify(stalePlan.findings)}`);
	const directReport = await call("deploy_project_services", { planId: stalePlan.id, expectedFingerprint: stalePlan.fingerprint, confirm: true });
	reportId = directReport.id;
	const inspectedDirectReport = await call("get_project_services_deployment_report", { reportId });
	if (inspectedDirectReport.status !== "succeeded" || !inspectedDirectReport.stdout.includes("deployed")) {
		throw new Error(`Direct Hosted Services deployment evidence is incomplete: ${JSON.stringify(inspectedDirectReport)}`);
	}
	const idleCancellation = await call("cancel_project_services_deployment", {});
	if (idleCancellation.canceled !== false || idleCancellation.active !== null) throw new Error(`Idle deployment cancellation evidence is incomplete: ${JSON.stringify(idleCancellation)}`);
	await call("delete_project_services_deployment_report", { reportId, confirm: true });
	reportId = null;
	await call("select_editor_tab", { tab: "services" });
	cdp = await connectCdp();
	await waitFor(
		() =>
			cdp.evaluate(
				`(() => { const workspace=document.querySelector('[data-project-services-workspace]'); const refresh=document.querySelector('[data-project-services-refresh]'); const rect=refresh?.getBoundingClientRect(); return { categoryCount: document.querySelectorAll('[data-project-services-category]').length, state: workspace?.getAttribute('data-project-services-state'), refreshReady: Boolean(refresh && !refresh.disabled && rect && rect.width>0 && rect.height>0 && rect.left>=0 && rect.top>=0 && rect.right<=innerWidth && rect.bottom<=innerHeight) }; })()`
			),
		(value) => value?.categoryCount === 10 && value.state === "ready" && value.refreshReady,
		"visible ready Services workspace with ten hosted-service category cards"
	);
	await cdp.click("[data-project-services-refresh]");
	await waitFor(
		() => cdp.evaluate(`Boolean(document.querySelector('#service-environment option[value=${JSON.stringify(environmentId)}]'))`),
		Boolean,
		"externally-created hosted-service environment in the refreshed UI"
	);
	await cdp.setValue("#service-environment", environmentId);
	await waitFor(
		() =>
			cdp.evaluate(
				`document.querySelector('#service-environment')?.value===${JSON.stringify(environmentId)} && document.querySelector('[data-project-services-workspace]')?.getAttribute('data-project-services-state')==='ready'`
			),
		Boolean,
		"selected hosted-service environment"
	);
	await cdp.setValue("[data-project-services-resources-json]", JSON.stringify(resources, null, 2));
	await cdp.click("[data-project-services-apply-resources]");
	configuration = await waitFor(
		() => call("get_project_services_configuration"),
		(value) => value.revision > stalePlan.configurationRevision && value.environments.find((entry) => entry.id === environmentId)?.resources?.leaderboards?.length === 1,
		"UI resource publication"
	);
	await call("deploy_project_services", { planId: stalePlan.id, expectedFingerprint: stalePlan.fingerprint, confirm: true }, true);
	await waitFor(
		() => cdp.evaluate("document.querySelector('[data-project-services-workspace]')?.getAttribute('data-project-services-state')==='ready'"),
		Boolean,
		"ready Services deployment UI"
	);
	await cdp.click("[data-project-services-plan-deployment]");
	await waitFor(() => cdp.evaluate("document.querySelector('[data-project-services-deployment-plan]')?.textContent?.includes('VALID')"), Boolean, "valid UI deployment plan");
	await cdp.click("[data-project-services-execute-deployment]");
	await cdp.click("[data-project-services-confirm]");
	const reports = await waitFor(
		() => call("list_project_services_deployment_reports"),
		(value) => value.find((entry) => entry.environmentId === environmentId && entry.status === "succeeded"),
		"successful UI deployment report"
	);
	const report = reports.find((entry) => entry.environmentId === environmentId && entry.status === "succeeded");
	reportId = report.id;
	const inspectedUiReport = await call("get_project_services_deployment_report", { reportId });
	if (!report.stdout.includes("deployed") || inspectedUiReport.id !== reportId) throw new Error("Deployment script did not execute through the reviewed plan.");
	if (cdp.runtimeErrors.length) throw new Error(`Electron renderer reported errors: ${cdp.runtimeErrors.join(" | ")}`);

	await call("stop_project_services_emulator");
	emulatorRunning = false;
	await call("delete_project_services_deployment_report", { reportId, confirm: true });
	reportId = null;
	configuration = await call("get_project_services_configuration");
	configuration = await call("set_active_project_service_environment", { expectedRevision: configuration.revision, id: before.activeEnvironmentId });
	await call("delete_project_service_environment", { expectedRevision: configuration.revision, id: environmentId, confirm: true });
	const after = await call("get_project_services_configuration");
	if (after.environments.some((entry) => entry.id === environmentId)) throw new Error("Disposable hosted-service environment remains after cleanup.");
	await call("get_project_services_capabilities", { unknown: true }, true);
	console.log(
		"[services-live] PASS — 19/19 strict tools, ten categories, eight catalogs, direct permanent UI resource/deployment events, Leaderboards, Remote Config, Content Delivery, Cloud Functions, stale-plan rejection, real package-script deployment, and exact disposable-environment cleanup verified."
	);
} catch (error) {
	console.error(`[services-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-8).join("\n"));
	process.exitCode = 1;
} finally {
	if (emulatorRunning) await call("stop_project_services_emulator").catch(() => undefined);
	if (reportId) await call("delete_project_services_deployment_report", { reportId, confirm: true }).catch(() => undefined);
	await call("get_project_services_configuration")
		.then((configuration) => {
			if (configuration.environments.some((entry) => entry.id === environmentId)) {
				return call("delete_project_service_environment", { expectedRevision: configuration.revision, id: environmentId, confirm: true });
			}
		})
		.catch(() => undefined);
	cdp?.socket?.close();
	if (packagePath && packageBytes) {
		await call("run_agent_script", {
			name: cleanupAgentName,
			content: `
import { join } from "path";
import { remove, writeFile } from "fs-extra";
export async function main(editor) {
	void editor;
	const root = ${JSON.stringify(projectRoot)};
	await writeFile(join(root, "package.json"), Buffer.from(${JSON.stringify(packageBytes.toString("base64"))}, "base64"));
	for (const path of [${[deploymentRelative, functionRelative, `.zvibe/services/environments/${environmentId}.json`, `.zvibe/services/emulator/${environmentId}.json`]
		.map((value) => JSON.stringify(value))
		.join(", ")}]) await remove(join(root, path));
	return JSON.stringify({ restored: true });
}`,
		}).catch(() => undefined);
	}
	for (const path of [`agentdata/${fixtureAgentName}`, `agentdata/${cleanupAgentName}`]) await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	child.stdin.end();
	child.kill();
}
