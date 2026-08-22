#!/usr/bin/env node
/** Real stdio/editor lifecycle for production server configuration, deployment assets, plans, jobs, instances, endpoints, providers, and exact cleanup. */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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

function rpc(method, params, timeoutMs = 180_000) {
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

async function unusedPort() {
	const server = createServer();
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	await new Promise((resolve) => server.close(resolve));
	return port;
}

async function waitForJob(jobId, expected = ["succeeded", "failed", "canceled"], timeoutMs = 30_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const job = await call("get_console_server_job", { jobId });
		if (expected.includes(job.status)) return job;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`Timed out waiting for Console & Server job ${jobId}.`);
}

const requiredTools = [
	"get_console_server_capabilities",
	"get_console_server_configuration",
	"set_console_server_configuration",
	"list_console_providers",
	"get_console_provider",
	"validate_console_server_target",
	"generate_server_deployment_artifacts",
	"get_server_deployment_artifacts",
	"remove_server_deployment_artifacts",
	"plan_console_server_workflow",
	"get_console_server_workflow_plan",
	"execute_console_server_workflow_plan",
	"get_console_server_job",
	"list_console_server_jobs",
	"cancel_console_server_job",
	"list_server_instances",
	"get_server_instance",
	"stop_server_instance",
	"inspect_server_endpoint",
];

const suffix = `${Date.now()}-${process.pid}`;
const profileId = `server-live-${suffix}`;
const providerId = `console-live-${suffix}`;
let projectDirectory = null;
let baselineConfiguration = null;
let profileCreated = false;
let scaffoldCreated = false;
let artifactsCreated = false;
let providerPath = null;
let fixturePath = null;
let fixtureBefore = null;
let localInstanceId = null;
let configurationUndo = false;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "console-server-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath || !status.activeScenePath) throw new Error("A ready disposable project editor with an active scene is required.");
	projectDirectory = dirname(status.projectPath);
	const capabilities = await call("get_console_server_capabilities");
	if (
		capabilities.version !== 1 ||
		capabilities.mcpToolCount !== 19 ||
		!capabilities.headless?.serverAuthoritativeWebSocket ||
		!capabilities.consoleProviders?.fixedNoShellCommands
	) {
		throw new Error("Console & Server capabilities are incomplete.");
	}

	providerPath = join(projectDirectory, ".zvibe/console-providers", `${providerId}.json`);
	await mkdir(dirname(providerPath), { recursive: true });
	await writeFile(
		providerPath,
		`${JSON.stringify({ version: 1, id: providerId, name: "Live Licensed Provider", vendor: "Fixture Vendor", platforms: ["fixture-devkit"], hostPlatforms: [process.platform], credentialEnvironments: [], operations: { validate: { executable: "node", args: ["--version"] }, certify: { executable: "node", args: ["--version"] } } }, null, "\t")}\n`,
		"utf8"
	);
	const providers = await call("list_console_providers");
	if (!providers.providers.some((entry) => entry.id === providerId)) throw new Error("Licensed provider discovery failed.");
	const provider = await call("get_console_provider", { id: providerId });
	if (provider.id !== providerId || !provider.fingerprint) throw new Error("Licensed provider evidence is incomplete.");

	const profilesBefore = await call("list_build_profiles");
	const createdProfile = await call("create_build_profile", {
		expectedRevision: profilesBefore.revision,
		id: profileId,
		name: `Server Live ${suffix}`,
		target: "headless",
		enabled: true,
	});
	profileCreated = true;
	const scaffoldBefore = await call("get_platform_scaffold", { target: "headless" });
	if (scaffoldBefore.exists) throw new Error("The disposable live project already has a Headless scaffold; use a clean project for exact cleanup.");
	const port = await unusedPort();
	const scaffold = await call("generate_platform_scaffold", {
		target: "headless",
		expectedRevision: 0,
		settings: { host: "127.0.0.1", port, tickRate: 30, maximumCatchUpSteps: 4 },
	});
	scaffoldCreated = true;

	baselineConfiguration = await call("get_console_server_configuration");
	const configured = await call("set_console_server_configuration", {
		expectedRevision: baselineConfiguration.revision,
		changes: {
			headless: { buildProfileId: profileId, initialScenePath: "assets/example.scene", publicHost: "127.0.0.1", port, tickRate: 30, maximumPlayers: 16 },
			container: { image: `zvibe/live-server-${suffix}:test` },
			deployment: { provider: "local", replicas: 1, consoleProviderId: null },
			observability: { logLimitBytes: 65536, metrics: true, portableProfiling: true },
		},
	});
	configurationUndo = true;
	const stale = await call("set_console_server_configuration", { expectedRevision: baselineConfiguration.revision, changes: { headless: { maximumPlayers: 8 } } }, true);
	if (!String(stale).includes("revision is stale")) throw new Error("Console & Server stale revision did not reject.");

	const generated = await call("generate_server_deployment_artifacts", {
		expectedRevision: 0,
		expectedConfigurationRevision: configured.revision,
		expectedScaffoldRevision: scaffold.revision,
	});
	artifactsCreated = true;
	if (!generated.integrity || generated.revision !== 1) throw new Error("Deployment artifact generation evidence is incomplete.");
	const artifacts = await call("get_server_deployment_artifacts");
	if (!artifacts.integrity || !artifacts.files.every((entry) => entry.matches)) throw new Error("Deployment artifact hashes are incomplete.");

	fixturePath = join(projectDirectory, "dist/headless/server.mjs");
	fixtureBefore = await readFile(fixturePath, "utf8").catch(() => null);
	await mkdir(dirname(fixturePath), { recursive: true });
	await writeFile(
		fixturePath,
		'import { createServer } from "node:http";\nlet ticks=0; const timer=setInterval(()=>ticks++,10); const server=createServer((request,response)=>{ if(request.url==="/health"){response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({ok:true,target:"headless",running:true,ticks}));return;} if(request.url==="/metrics"){response.writeHead(200,{"content-type":"text/plain"});response.end("zvibe_server_ticks "+ticks+"\\n");return;} response.writeHead(404).end(); }); server.listen(Number(process.env.PORT),process.env.HOST); const stop=()=>{clearInterval(timer);server.close(()=>process.exit(0));}; process.on("SIGINT",stop);process.on("SIGTERM",stop);\n',
		"utf8"
	);
	const validation = await call("validate_console_server_target");
	if (!validation.valid || validation.profile?.id !== profileId || validation.scaffold.revision !== scaffold.revision || validation.artifacts.revision !== artifacts.revision) {
		throw new Error(`Console & Server validation is incomplete: ${JSON.stringify(validation.errors)}`);
	}

	const validatePlan = await call("plan_console_server_workflow", {
		operation: "validate",
		expectedConfigurationRevision: configured.revision,
		expectedScaffoldRevision: scaffold.revision,
		expectedArtifactsRevision: artifacts.revision,
	});
	if (validatePlan.operation !== "validate" || !validatePlan.expiresAt) throw new Error("Exact validation plan evidence is incomplete.");
	const inspectedPlan = await call("get_console_server_workflow_plan", { planId: validatePlan.id });
	if (inspectedPlan.expired) throw new Error("Fresh workflow plan was reported expired.");
	const validateStarted = await call("execute_console_server_workflow_plan", { planId: validatePlan.id, confirm: true });
	const validateJob = await waitForJob(validateStarted.id);
	if (validateJob.status !== "succeeded" || validateJob.exitCode !== 0) throw new Error(`Validation job failed: ${JSON.stringify(validateJob)}`);

	const deployPlan = await call("plan_console_server_workflow", {
		operation: "deploy",
		expectedConfigurationRevision: configured.revision,
		expectedScaffoldRevision: scaffold.revision,
		expectedArtifactsRevision: artifacts.revision,
	});
	const deployStarted = await call("execute_console_server_workflow_plan", { planId: deployPlan.id, confirm: true });
	const deployJob = await waitForJob(deployStarted.id);
	if (deployJob.status !== "succeeded") throw new Error(`Local deployment job failed: ${JSON.stringify(deployJob)}`);
	const listedInstances = await call("list_server_instances", { provider: "local", state: "running", limit: 10 });
	const local = listedInstances.instances.find((entry) => entry.jobId === deployJob.id);
	if (!local) throw new Error("Local deployment did not retain a running instance.");
	localInstanceId = local.id;
	const instance = await call("get_server_instance", { instanceId: local.id });
	if (instance.state !== "running" || !instance.endpoint) throw new Error("Local instance evidence is incomplete.");
	const health = await call("inspect_server_endpoint", { kind: "health" });
	const metrics = await call("inspect_server_endpoint", { kind: "metrics" });
	if (!health.ok || !JSON.parse(health.body).running || !metrics.body.includes("zvibe_server_ticks")) throw new Error("Health/metrics endpoint inspection failed.");
	const stopped = await call("stop_server_instance", { instanceId: localInstanceId, confirm: true });
	if (stopped.state !== "stopped") throw new Error("Local instance did not stop.");
	localInstanceId = null;

	await mkdir(join(projectDirectory, ".zvibe/server/profiles"), { recursive: true });
	const profilePlan = await call("plan_console_server_workflow", {
		operation: "profile",
		expectedConfigurationRevision: configured.revision,
		expectedScaffoldRevision: scaffold.revision,
		expectedArtifactsRevision: artifacts.revision,
		durationSeconds: 30,
	});
	const profileStarted = await call("execute_console_server_workflow_plan", { planId: profilePlan.id, confirm: true });
	await new Promise((resolve) => setTimeout(resolve, 1_300));
	const canceled = await call("cancel_console_server_job", { jobId: profileStarted.id, confirm: true });
	if (!/[Cc]ancel/.test(canceled.status)) throw new Error("Profile cancellation was not acknowledged.");
	const canceledJob = await waitForJob(profileStarted.id);
	if (canceledJob.status !== "canceled") throw new Error(`Profile job did not cancel: ${JSON.stringify(canceledJob)}`);
	const listedJobs = await call("list_console_server_jobs", { provider: "local", limit: 20 });
	if (!listedJobs.jobs.some((entry) => entry.id === canceledJob.id) || !listedJobs.jobs.some((entry) => entry.id === deployJob.id))
		throw new Error("Retained job pagination is incomplete.");

	const unknown = await call("get_console_server_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Console & Server unknown-field guard did not reject before editor I/O.");

	await call("remove_server_deployment_artifacts", { expectedRevision: artifacts.revision, confirm: true });
	artifactsCreated = false;
	await call("undo_editor");
	configurationUndo = false;
	const restored = await call("get_console_server_configuration");
	if (JSON.stringify(restored) !== JSON.stringify(baselineConfiguration)) throw new Error("Console & Server configuration did not restore exactly through Undo.");
	await call("remove_platform_scaffold", { target: "headless", expectedRevision: scaffold.revision, confirm: true });
	scaffoldCreated = false;
	const profilesAfter = await call("list_build_profiles");
	await call("delete_build_profile", { expectedRevision: profilesAfter.revision, id: createdProfile.profile.id });
	profileCreated = false;

	console.log(
		"[console-server-live] PASS — 19/19 strict tools, provider discovery, exact authoring/artifacts/plans, job execution/cancel, local fleet lifecycle, health/metrics, schema guards, Undo, and exact owned cleanup verified."
	);
} catch (error) {
	console.error(`[console-server-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exitCode = 1;
} finally {
	try {
		if (localInstanceId) await call("stop_server_instance", { instanceId: localInstanceId, confirm: true }).catch(() => undefined);
		if (artifactsCreated) {
			const artifacts = await call("get_server_deployment_artifacts");
			if (artifacts.exists)
				await call("remove_server_deployment_artifacts", { expectedRevision: artifacts.revision, confirm: true, ...(artifacts.integrity ? {} : { forceModified: true }) });
		}
		if (configurationUndo) await call("undo_editor");
		if (scaffoldCreated) {
			const scaffold = await call("get_platform_scaffold", { target: "headless" });
			if (scaffold.exists) await call("remove_platform_scaffold", { target: "headless", expectedRevision: scaffold.revision, confirm: true });
		}
		if (profileCreated) {
			const profiles = await call("list_build_profiles");
			if (profiles.profiles.some((entry) => entry.id === profileId)) await call("delete_build_profile", { expectedRevision: profiles.revision, id: profileId });
		}
	} catch (cleanupError) {
		console.error(`[console-server-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	if (fixturePath) {
		if (fixtureBefore === null) await rm(fixturePath, { force: true });
		else await writeFile(fixturePath, fixtureBefore, "utf8");
	}
	if (projectDirectory) await rm(join(projectDirectory, ".zvibe/server/profiles"), { recursive: true, force: true });
	if (providerPath) await rm(providerPath, { force: true });
	child.stdin.end();
	await new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve();
		}, 2_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}
