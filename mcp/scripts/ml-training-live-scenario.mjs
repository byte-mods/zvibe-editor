#!/usr/bin/env node
/** Real stdio MCP + Electron lifecycle for Agent authoring, demonstrations, trainers, cancellation/retry, ONNX publication, and cleanup. */
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import onnxProto from "onnx-proto";

const { onnx } = onnxProto;

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
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status} on port ${port}.`);
	for (const target of (await response.json()).filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
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
				"Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html') && document.querySelector('[data-ml-training-workspace]'))"
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
	throw new Error(`No Electron ML Training workspace was found on CDP port ${port}.`);
}

function policyModel(inputSize, outputSize) {
	const tensorType = (size) => ({ tensorType: { elemType: 1, shape: { dim: [{ dimValue: 1 }, { dimValue: size }] } } });
	const model = onnx.ModelProto.create({
		irVersion: 8,
		producerName: "Zvibe ML live external trainer",
		opsetImport: [{ domain: "", version: 18 }],
		graph: {
			name: "Live Policy",
			input: [{ name: "observations", type: tensorType(inputSize) }],
			output: [{ name: "actions", type: tensorType(outputSize) }],
			node: [{ name: "Linear", opType: "Gemm", input: ["observations", "weights", "bias"], output: ["actions"] }],
			initializer: [
				{ name: "weights", dataType: 1, dims: [inputSize, outputSize], floatData: new Array(inputSize * outputSize).fill(0.1) },
				{ name: "bias", dataType: 1, dims: [outputSize], floatData: new Array(outputSize).fill(0) },
			],
		},
	});
	const error = onnx.ModelProto.verify(model);
	if (error) throw new Error(error);
	return Buffer.from(onnx.ModelProto.encode(model).finish());
}

const mlTools = [
	"get_ml_training_capabilities",
	"get_ml_training_configuration",
	"set_ml_training_configuration",
	"list_ml_training_providers",
	"set_ml_training_provider",
	"delete_ml_training_provider",
	"record_ml_training_episode",
	"list_ml_training_episodes",
	"get_ml_training_episode",
	"clear_ml_training_dataset",
	"start_ml_training_job",
	"list_ml_training_jobs",
	"get_ml_training_job",
	"cancel_ml_training_job",
	"retry_ml_training_job",
	"inspect_ml_training_checkpoint_publication",
	"publish_ml_training_checkpoint",
	"delete_ml_training_job",
];
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const behaviorId = `live-behavior-${suffix}`;
const episodeId = `live-episode-${suffix}`;
const providerId = `live-trainer-${suffix}`;
const providerScript = `/tmp/zvibe-ml-training-live-${suffix}.mjs`;
const publishedPath = `assets/.mcp-ml-policy-${suffix}.onnx`;
const jobs = [];
let nodeId = null;
let previousConfiguration = null;
let currentConfigurationRevision = null;
let datasetFingerprint = null;
let providerFingerprint = null;
let cdp = null;
let completed = false;

async function terminalJob(id) {
	return waitFor(
		() => call("get_ml_training_job", { jobId: id }),
		(value) => ["succeeded", "failed", "canceled", "timed-out"].includes(value.status),
		`terminal job ${id}`
	);
}

async function deleteJob(id) {
	let job;
	try {
		job = await call("get_ml_training_job", { jobId: id });
	} catch {
		return;
	}
	if (["queued", "running", "canceling"].includes(job.status)) {
		await call("cancel_ml_training_job", { jobId: id, expectedRevision: job.revision, confirm: true }).catch(() => undefined);
		job = await terminalJob(id).catch(() => job);
	}
	await call("delete_ml_training_job", { jobId: id, expectedRevision: job.revision, confirm: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ml-training-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	for (const name of mlTools) {
		const tool = tools.find((entry) => entry.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or open in real stdio discovery.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"])
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
	}
	const closedError = await call("get_ml_training_capabilities", { unknown: true }, true);
	if (!String(closedError).includes("-32602")) throw new Error("Closed ML schema did not reject an unknown field.");
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required.");
	previousConfiguration = (await call("get_ml_training_configuration")).configuration;
	const created = await call("create_primitive_mesh", { type: "empty", name: `ML Live Agent ${suffix}` });
	nodeId = created.id;
	const behavior = {
		id: behaviorId,
		name: `Live Behavior ${suffix}`,
		agentNodeIds: [nodeId],
		behaviorGraphId: null,
		observations: [{ name: "state", size: 2, stacking: 1, normalization: null }],
		actions: { continuousSize: 1, discreteBranches: [2] },
		decisionPeriod: 1,
		maxEpisodeSteps: 16,
		inferenceModelPath: null,
	};
	const configured = await call("set_ml_training_configuration", {
		expectedRevision: previousConfiguration.revision,
		configuration: { enabled: true, timeScale: 2, behaviors: [behavior], curriculum: [{ id: "start", name: "Start", minimumMeanReward: null, parameters: { distance: 1 } }] },
	});
	currentConfigurationRevision = configured.configuration.revision;
	const capabilities = await call("get_ml_training_capabilities");
	if (capabilities.contract !== "zvibe-ml-training-v1" || !capabilities.features?.builtInBehaviorCloning || !capabilities.features?.externalPpoSacImitationProviders)
		throw new Error("ML capabilities are incomplete.");

	await call("select_editor_tab", { tab: "ml-training" });
	cdp = await connectCdp();
	await cdp.click('[data-ml-training-tab="dataset"]');
	const episode = {
		id: episodeId,
		behaviorId,
		agentId: `agent-${suffix}`,
		lessonId: "start",
		parameters: { distance: 1 },
		steps: [
			{ observations: [0, 0], continuousActions: [0], discreteActions: [0], reward: 0, done: false, interrupted: false },
			{ observations: [1, 1], continuousActions: [1], discreteActions: [1], reward: 1, done: true, interrupted: false },
		],
	};
	await call("record_ml_training_episode", { expectedConfigurationRevision: currentConfigurationRevision, episode });
	const dataset = await waitFor(
		() => call("list_ml_training_episodes", { behaviorId, offset: 0, limit: 100 }),
		(value) => value.episodes.some((entry) => entry.id === episodeId),
		"UI-recorded episode"
	);
	datasetFingerprint = dataset.datasetFingerprint;
	const exactEpisode = await call("get_ml_training_episode", { behaviorId, episodeId, expectedDatasetFingerprint: datasetFingerprint, stepOffset: 0, stepLimit: 100 });
	if (exactEpisode.episode.steps.length !== 2) throw new Error("Exact episode step page is incomplete.");

	await cdp.click('[data-ml-training-tab="trainers"]');
	const providers = await call("list_ml_training_providers");
	const builtIn = providers.providers.find((entry) => entry.builtIn);
	await cdp.setValue("[data-ml-training-start-provider]", builtIn.id);
	await cdp.setValue("[data-ml-training-settings-json]", JSON.stringify({ algorithm: "behavior-cloning", epochs: 4, learningRate: 0.01 }));
	const beforeJobs = await call("list_ml_training_jobs", { offset: 0, limit: 100 });
	await cdp.click("[data-ml-training-start-job]");
	const uiStarted = await waitFor(
		() => call("list_ml_training_jobs", { behaviorId, offset: 0, limit: 100 }),
		(value) => value.jobs.find((entry) => !beforeJobs.jobs.some((old) => old.id === entry.id)),
		"UI-started built-in training"
	).then((value) => value.jobs.find((entry) => !beforeJobs.jobs.some((old) => old.id === entry.id)));
	jobs.push(uiStarted.id);
	let uiJob = await terminalJob(uiStarted.id);
	if (uiJob.status !== "succeeded" || uiJob.result?.metrics.length !== 4) throw new Error(`Built-in training failed: ${JSON.stringify(uiJob)}`);
	await cdp.click('[data-ml-training-tab="results"]');
	await cdp.click(`[data-ml-training-job="${uiJob.id}"]`);
	const publicationPlan = await call("inspect_ml_training_checkpoint_publication", {
		jobId: uiJob.id,
		expectedRevision: uiJob.revision,
		expectedResultFingerprint: uiJob.resultFingerprint,
		path: publishedPath,
		overwrite: false,
	});
	await call("publish_ml_training_checkpoint", {
		jobId: uiJob.id,
		expectedRevision: uiJob.revision,
		expectedResultFingerprint: uiJob.resultFingerprint,
		path: publishedPath,
		overwrite: false,
		expectedPlanFingerprint: publicationPlan.planFingerprint,
		confirm: true,
	});
	uiJob = await waitFor(
		() => call("get_ml_training_job", { jobId: uiJob.id }),
		(value) => value.publications.length === 1,
		"UI Runtime AI publication"
	);
	const runtimeInspection = await call("inspect_runtime_ai_model", { modelPath: publishedPath });
	if (runtimeInspection.description.inputs[0].name !== "observations" || runtimeInspection.description.outputs[0].name !== "actions")
		throw new Error("Published ONNX did not compile through Runtime AI.");
	await call(
		"publish_ml_training_checkpoint",
		{
			jobId: uiJob.id,
			expectedRevision: uiJob.revision,
			expectedResultFingerprint: uiJob.resultFingerprint,
			path: `assets/stale-${suffix}.onnx`,
			overwrite: false,
			expectedPlanFingerprint: "0".repeat(64),
			confirm: true,
		},
		true
	);

	const modelBase64 = policyModel(2, 3).toString("base64");
	await writeFile(
		providerScript,
		`import { writeFile } from "node:fs/promises"; let text=""; for await (const chunk of process.stdin) text += chunk; const request=JSON.parse(text); if(request.settings.algorithm==="external") await new Promise(resolve=>setTimeout(resolve,10000)); await writeFile(request.outputDirectory+"/policy.onnx",Buffer.from("${modelBase64}","base64")); process.stdout.write(JSON.stringify({modelPath:"policy.onnx",inputName:"observations",outputName:"actions",metrics:[{step:2,epoch:1,loss:0.125,meanReward:1}]}));\n`
	);
	await cdp.click('[data-ml-training-tab="trainers"]');
	await waitFor(
		() =>
			cdp.evaluate(
				"document.querySelector('[data-ml-training-workspace]')?.getAttribute('data-ml-training-state') === 'ready' && !document.querySelector('[data-ml-training-save-provider]')?.disabled"
			),
		Boolean,
		"ready Trainer Provider UI"
	);
	const providerManifest = {
		version: 1,
		id: providerId,
		name: `Live External ${suffix}`,
		algorithms: ["ppo", "external"],
		executable: "node",
		args: [providerScript],
		credentialEnvironments: [],
		maximumDurationSeconds: 30,
	};
	await call("set_ml_training_provider", { provider: providerManifest });
	const externalProvider = await waitFor(
		() => call("list_ml_training_providers"),
		(value) => value.providers.find((entry) => entry.id === providerId),
		"UI-created external provider"
	).then((value) => value.providers.find((entry) => entry.id === providerId));
	providerFingerprint = externalProvider.fingerprint;
	const externalStarted = await call("start_ml_training_job", {
		behaviorId,
		expectedConfigurationRevision: currentConfigurationRevision,
		providerId,
		expectedProviderFingerprint: providerFingerprint,
		expectedDatasetFingerprint: datasetFingerprint,
		settings: { algorithm: "ppo", epochs: 1 },
		confirm: true,
	});
	jobs.push(externalStarted.id);
	const externalJob = await terminalJob(externalStarted.id);
	if (externalJob.status !== "succeeded" || externalJob.execution.exitCode !== 0 || externalJob.result.metrics[0].loss !== 0.125)
		throw new Error("External PPO adapter evidence is incomplete.");

	const slowStarted = await call("start_ml_training_job", {
		behaviorId,
		expectedConfigurationRevision: currentConfigurationRevision,
		providerId,
		expectedProviderFingerprint: providerFingerprint,
		expectedDatasetFingerprint: datasetFingerprint,
		settings: { algorithm: "external", epochs: 1 },
		confirm: true,
	});
	jobs.push(slowStarted.id);
	const running = await waitFor(
		() => call("get_ml_training_job", { jobId: slowStarted.id }),
		(value) => value.status === "running",
		"running cancel target"
	);
	await call("cancel_ml_training_job", { jobId: running.id, expectedRevision: running.revision, confirm: true });
	const canceled = await terminalJob(running.id);
	if (canceled.status !== "canceled") throw new Error("External trainer cancellation did not reach canceled.");
	const retried = await call("retry_ml_training_job", {
		jobId: canceled.id,
		expectedRevision: canceled.revision,
		expectedConfigurationRevision: currentConfigurationRevision,
		expectedProviderFingerprint: providerFingerprint,
		expectedDatasetFingerprint: datasetFingerprint,
		confirm: true,
	});
	jobs.push(retried.id);
	const retryRunning = await waitFor(
		() => call("get_ml_training_job", { jobId: retried.id }),
		(value) => value.status === "running",
		"running retry target"
	);
	await call("cancel_ml_training_job", { jobId: retryRunning.id, expectedRevision: retryRunning.revision, confirm: true });
	if ((await terminalJob(retried.id)).status !== "canceled") throw new Error("Retried external job did not cancel cleanly.");

	await call("delete_asset", { path: publishedPath, confirm: true });
	for (const id of [...jobs]) await deleteJob(id);
	jobs.length = 0;
	await call("delete_ml_training_provider", { id: providerId, expectedFingerprint: providerFingerprint, confirm: true });
	providerFingerprint = null;
	await call("clear_ml_training_dataset", { behaviorId, expectedDatasetFingerprint: datasetFingerprint, confirm: true });
	datasetFingerprint = null;
	const { version: _version, revision: _revision, ...configurationReplacement } = previousConfiguration;
	const restored = await call("set_ml_training_configuration", { expectedRevision: currentConfigurationRevision, configuration: configurationReplacement });
	currentConfigurationRevision = restored.configuration.revision;
	previousConfiguration = null;
	await call("delete_node", { nodeId });
	nodeId = null;
	const residueJobs = await call("list_ml_training_jobs", { offset: 0, limit: 100 });
	if (residueJobs.jobs.some((entry) => entry.behavior.id === behaviorId)) throw new Error("ML live jobs remain after cleanup.");
	if (cdp.runtimeErrors.length) throw new Error(`Electron renderer reported errors: ${cdp.runtimeErrors.join(" | ")}`);
	completed = true;
	console.log(
		"[ml-training-live] PASS — 18/18 tools, Agent/curriculum authoring, direct demonstration/trainer/results UI, built-in real ONNX training, external PPO, cancellation/retry, Runtime AI publication, stale-plan rejection, and exact cleanup verified."
	);
} catch (error) {
	console.error(`[ml-training-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-8).join("\n"));
	process.exitCode = 1;
} finally {
	for (const id of [...jobs]) await deleteJob(id).catch(() => undefined);
	await call("delete_asset", { path: publishedPath, confirm: true }).catch(() => undefined);
	if (providerFingerprint) await call("delete_ml_training_provider", { id: providerId, expectedFingerprint: providerFingerprint, confirm: true }).catch(() => undefined);
	if (datasetFingerprint) await call("clear_ml_training_dataset", { behaviorId, expectedDatasetFingerprint: datasetFingerprint, confirm: true }).catch(() => undefined);
	if (previousConfiguration && currentConfigurationRevision) {
		const { version: _version, revision: _revision, ...configurationReplacement } = previousConfiguration;
		await call("set_ml_training_configuration", { expectedRevision: currentConfigurationRevision, configuration: configurationReplacement }).catch(() => undefined);
	}
	if (nodeId) await call("delete_node", { nodeId }).catch(() => undefined);
	cdp?.socket?.close();
	await rm(providerScript, { force: true }).catch(() => undefined);
	child.stdin.end();
	child.kill();
	if (!completed && !process.exitCode) process.exitCode = 1;
}
