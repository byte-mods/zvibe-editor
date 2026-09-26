#!/usr/bin/env node
/** Real stdio MCP + Electron UI lifecycle for executable/HTTP generation, preview, publication, provenance, and cleanup. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

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
			} else if (message.method === "Runtime.exceptionThrown") {
				const details = message.params?.exceptionDetails;
				runtimeErrors.push(
					JSON.stringify({
						type: "exception",
						text: details?.text ?? "Runtime.exceptionThrown",
						description: details?.exception?.description,
						value: details?.exception?.value,
						className: details?.exception?.className,
						url: details?.url,
						lineNumber: details?.lineNumber,
						columnNumber: details?.columnNumber,
						stackTrace: details?.stackTrace,
					})
				);
			} else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
				const entry = message.params.entry;
				runtimeErrors.push(JSON.stringify({ type: "log", text: entry.text, url: entry.url, lineNumber: entry.lineNumber, source: entry.source }));
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
			if (result.exceptionDetails) throw new Error(`CDP evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
			return result.result.value;
		};
		if (
			await evaluate(
				"Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html') && document.querySelector('[data-generative-assets-workspace]'))"
			)
		) {
			await send("Runtime.enable");
			await send("Log.enable");
			const click = async (selector) => {
				await evaluate(
					`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element?.scrollIntoView({ block: 'center', inline: 'center' }); })()`
				);
				await new Promise((resolve) => setTimeout(resolve, 50));
				const rect = await evaluate(
					`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; const r = element.getBoundingClientRect(); const x = r.left + r.width / 2; const y = r.top + r.height / 2; return { x, y, visible: r.width > 0 && r.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight && (document.elementFromPoint(x, y) === element || element.contains(document.elementFromPoint(x, y))), disabled: Boolean(element.disabled) }; })()`
				);
				if (!rect?.visible || rect.disabled) throw new Error(`UI selector is missing, hidden, or disabled: ${selector}`);
				await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
				await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
			};
			const setValue = async (selector, value) =>
				evaluate(`(() => {
					const element = document.querySelector(${JSON.stringify(selector)});
					if (!element) throw new Error('Missing UI selector: ' + ${JSON.stringify(selector)});
					const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(String(value))});
					element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
					return element.value;
				})()`);
			return { socket, evaluate, click, setValue, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Electron Generative Assets workspace was found on CDP port ${port}.`);
}

function imageRequest(prompt) {
	return {
		version: 1,
		modality: "image",
		prompt,
		negativePrompt: null,
		style: null,
		seed: 23,
		count: 1,
		references: [],
		parameters: { quality: "live" },
		options: { modality: "image", value: { width: 64, height: 64, transparent: false } },
	};
}

const requiredTools = [
	"get_generative_asset_capabilities",
	"list_generative_asset_providers",
	"set_generative_asset_provider",
	"delete_generative_asset_provider",
	"start_generative_asset_job",
	"list_generative_asset_jobs",
	"get_generative_asset_job",
	"cancel_generative_asset_job",
	"retry_generative_asset_job",
	"get_generative_asset_preview",
	"inspect_generative_asset_publication",
	"publish_generative_asset_candidate",
	"delete_generative_asset_job",
	"get_editor_status",
	"select_editor_tab",
	"delete_asset",
];
const packagedManifest = JSON.parse(await readFile(join(here, "..", "manifest.json"), "utf8"));
const packagedTools = packagedManifest.server?.tools ?? packagedManifest.tools;
if (!Array.isArray(packagedTools)) throw new Error("MCPB manifest does not contain a packaged tool catalog.");
const suffix = `${Date.now().toString(36)}-${process.pid}`;
const executableProviderId = `live-executable-${suffix}`;
const httpProviderId = `live-http-${suffix}`;
const adapterRelativePath = `.zvibe/generative-live-${suffix}.mjs`;
const referenceRelativePath = `assets/.mcp-generative-reference-${suffix}.png`;
const publicationDirectory = `assets/.mcp-generative-publication-${suffix}`;
const executableJobs = [];
const httpJobs = [];
let httpServer = null;
let cdp = null;
let projectDirectory = null;
let publishedPaths = [];
let completed = false;

async function assertNoRendererErrors(label) {
	await new Promise((resolve) => setTimeout(resolve, 250));
	if (cdp?.runtimeErrors.length) {
		throw new Error(`Electron renderer reported errors after ${label}: ${cdp.runtimeErrors.join(" | ")}`);
	}
}

async function deleteProviderIfPresent(id) {
	const inventory = await call("list_generative_asset_providers");
	const provider = inventory.providers.find((entry) => entry.id === id);
	if (provider) {
		await call("delete_generative_asset_provider", {
			id,
			expectedInventoryFingerprint: inventory.inventoryFingerprint,
			expectedProviderFingerprint: provider.fingerprint,
			confirm: true,
		});
	}
}

async function deleteJobIfPresent(id) {
	let job;
	try {
		job = await call("get_generative_asset_job", { jobId: id });
	} catch {
		return;
	}
	if (["queued", "running", "canceling"].includes(job.status)) {
		await call("cancel_generative_asset_job", { jobId: id, expectedRevision: job.revision, confirm: true }).catch(() => undefined);
		job = await waitFor(
			() => call("get_generative_asset_job", { jobId: id }),
			(value) => !["queued", "running", "canceling"].includes(value.status),
			`cleanup of ${id}`
		).catch(() => job);
	}
	await call("delete_generative_asset_job", { jobId: id, expectedRevision: job.revision, confirm: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "generative-assets-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	if (tools.length !== packagedTools.length) throw new Error(`Expected ${packagedTools.length} MCP tools, received ${tools.length}.`);
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`${name} is missing from real stdio discovery.`);
		if (tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}
	const unknown = await call("get_generative_asset_capabilities", { unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Closed generative schema did not reject an unknown field.");

	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required for the Generative Assets live scenario.");
	projectDirectory = dirname(status.projectPath);
	await mkdir(join(projectDirectory, ".zvibe"), { recursive: true });
	await mkdir(join(projectDirectory, "assets"), { recursive: true });
	const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 36, g: 126, b: 220, alpha: 1 } } })
		.png()
		.toBuffer();
	await writeFile(join(projectDirectory, referenceRelativePath), png);
	await writeFile(
		join(projectDirectory, adapterRelativePath),
		`import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [requestPath, outputPath, imagePath] = process.argv.slice(2);
const envelope = JSON.parse(await readFile(requestPath, "utf8"));
await mkdir(outputPath, { recursive: true });
await writeFile(join(outputPath, "candidate.png"), await readFile(imagePath));
await writeFile(join(outputPath, "result.json"), JSON.stringify({ version: 1, candidates: [{ id: "executable-candidate", reportedModel: "live-executable-fixture", reportedSeed: envelope.request.seed, providerRequestId: envelope.jobId, warnings: [], artifacts: [{ path: "candidate.png", role: "image", mediaType: "image/png", displayName: "Executable Live Candidate" }] }] }));
`
	);

	const capabilities = await call("get_generative_asset_capabilities");
	if (capabilities.contract !== "zvibe-generative-assets-v1" || capabilities.modalities?.length !== 5 || !capabilities.publication?.implemented) {
		throw new Error(`Generative capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}

	await call("select_editor_tab", { tab: "generative-assets" });
	cdp = await connectCdp();
	await assertNoRendererErrors("opening Generative Assets");
	await cdp.click('[data-generative-tab="providers"]');
	await waitFor(() => cdp.evaluate("Boolean(document.querySelector('[data-generative-provider-workspace]'))"), Boolean, "Providers workspace");
	await cdp.click("[data-generative-provider-new]");
	const executableManifest = {
		version: 1,
		id: executableProviderId,
		name: `Live Executable ${suffix}`,
		vendor: "Zvibe Live Verification",
		classification: "test-fixture",
		modalities: ["image"],
		hostPlatforms: [],
		maximumOutputBytes: 2 * 1024 * 1024,
		maximumDurationSeconds: 15,
		transport: {
			kind: "executable",
			executable: "node",
			args: [`\${PROJECT}/${adapterRelativePath}`, "$" + "{REQUEST}", "$" + "{OUTPUT}", `\${PROJECT}/${referenceRelativePath}`],
			credentialEnvironments: [],
		},
	};
	await cdp.setValue("[data-generative-provider-json]", JSON.stringify(executableManifest, null, 2));
	await cdp.click("[data-generative-provider-save]");
	const executableProvider = await waitFor(
		() => call("list_generative_asset_providers"),
		(value) => value.providers.find((entry) => entry.id === executableProviderId && entry.available),
		"UI-created executable provider"
	).then((inventory) => inventory.providers.find((entry) => entry.id === executableProviderId));
	if (executableProvider.classification !== "test-fixture") throw new Error("UI provider classification was not preserved.");
	await assertNoRendererErrors("saving the executable provider");

	await cdp.click('[data-generative-tab="generate"]');
	await cdp.setValue("[data-generative-provider-select]", executableProviderId);
	await cdp.setValue("[data-generative-modality]", "image");
	await cdp.setValue("[data-generative-prompt]", `Live executable image ${suffix}`);
	await cdp.setValue('[data-generative-number="width"]', 64);
	await cdp.setValue('[data-generative-number="height"]', 64);
	await cdp.setValue("[data-generative-references]", JSON.stringify([{ path: referenceRelativePath, role: "style" }]));
	await cdp.setValue("[data-generative-parameters]", JSON.stringify({ quality: "live-ui", steps: 4 }));
	const beforeExecutable = await call("list_generative_asset_jobs", { providerId: executableProviderId, limit: 100 });
	await cdp.click("[data-generative-start]");
	const executableJob = await waitFor(
		() => call("list_generative_asset_jobs", { providerId: executableProviderId, limit: 100 }),
		(value) => value.jobs.find((entry) => !beforeExecutable.jobs.some((old) => old.id === entry.id)),
		"UI-started executable job"
	).then((value) => value.jobs.find((entry) => !beforeExecutable.jobs.some((old) => old.id === entry.id)));
	executableJobs.push(executableJob.id);
	const succeededExecutable = await waitFor(
		() => call("get_generative_asset_job", { jobId: executableJob.id }),
		(value) => ["succeeded", "failed", "canceled", "timed-out"].includes(value.status),
		"executable terminal job"
	);
	if (succeededExecutable.status !== "succeeded" || succeededExecutable.execution.exitCode !== 0 || succeededExecutable.candidates[0]?.id !== "executable-candidate") {
		throw new Error(`Executable generation failed: ${JSON.stringify(succeededExecutable)}`);
	}
	await assertNoRendererErrors("running the executable provider");

	await cdp.click('[data-generative-tab="results"]');
	await cdp.click(`[data-generative-job="${executableJob.id}"]`);
	await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-generative-candidate="executable-candidate"]'))`), Boolean, "validated UI candidate");
	await cdp.click('[data-generative-candidate="executable-candidate"]');
	await cdp.click("[data-generative-preview]");
	await waitFor(
		() => cdp.evaluate("document.querySelector('[data-generative-preview-result]')?.getAttribute('data-generative-preview-result')"),
		(value) => value?.startsWith("image/"),
		"verified UI preview"
	);
	await cdp.setValue("[data-generative-destination]", publicationDirectory);
	await cdp.setValue("[data-generative-base-name]", "ui-published");
	await cdp.click("[data-generative-inspect-publication]");
	await waitFor(() => cdp.evaluate("Boolean(document.querySelector('[data-generative-publication-plan]'))"), Boolean, "UI publication plan");
	await cdp.click("[data-generative-publish]");
	// Publishing writes the files and runs them through the registry and importer pipeline, so allow more than a UI round-trip.
	await waitFor(() => cdp.evaluate("Boolean(document.querySelector('[data-generative-publication-history]'))"), Boolean, "UI publication history", 180_000);
	const publishedJob = await call("get_generative_asset_job", { jobId: executableJob.id });
	if (publishedJob.publications.length !== 1 || publishedJob.publications[0].files.length !== 1 || publishedJob.publications[0].files[0].importer.kind !== "texture") {
		throw new Error(`UI publication evidence is incomplete: ${JSON.stringify(publishedJob.publications)}`);
	}
	await assertNoRendererErrors("publishing the executable candidate");
	publishedPaths = publishedJob.publications[0].files.map((entry) => entry.path);
	const stalePublication = await call(
		"publish_generative_asset_candidate",
		{
			jobId: publishedJob.id,
			expectedRevision: publishedJob.revision,
			expectedResultFingerprint: publishedJob.resultFingerprint,
			candidateId: "executable-candidate",
			destinationDirectory: publicationDirectory,
			baseName: "stale",
			expectedPlanFingerprint: "0".repeat(64),
			confirm: true,
		},
		true
	);
	if (!String(stalePublication).match(/plan changed|expectedPlanFingerprint/i)) throw new Error(`Stale publication plan was not rejected: ${stalePublication}`);

	httpServer = createServer(async (requestMessage, response) => {
		let body = "";
		for await (const chunk of requestMessage) body += chunk.toString("utf8");
		const envelope = JSON.parse(body);
		response.writeHead(200, { "Content-Type": "application/json" }).end(
			JSON.stringify({
				version: 1,
				candidates: [
					{
						id: "http-candidate",
						reportedModel: "live-http-fixture",
						reportedSeed: envelope.request.seed,
						providerRequestId: envelope.jobId,
						warnings: [],
						artifacts: [{ path: "http.png", role: "image", mediaType: "image/png", displayName: "HTTP Live Candidate", dataBase64: png.toString("base64") }],
					},
				],
			})
		);
	});
	await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const httpPort = httpServer.address().port;
	let inventory = await call("list_generative_asset_providers");
	const httpProviderResult = await call("set_generative_asset_provider", {
		expectedInventoryFingerprint: inventory.inventoryFingerprint,
		provider: {
			version: 1,
			id: httpProviderId,
			name: `Live HTTP ${suffix}`,
			vendor: "Zvibe Live Verification",
			classification: "test-fixture",
			modalities: ["image"],
			hostPlatforms: [],
			maximumOutputBytes: 2 * 1024 * 1024,
			maximumDurationSeconds: 15,
			transport: { kind: "http", endpoint: `http://127.0.0.1:${httpPort}/generate`, authorizationEnvironment: null, headers: { "X-Zvibe-Live": "1" } },
		},
	});
	const httpStarted = await call("start_generative_asset_job", {
		providerId: httpProviderId,
		expectedProviderFingerprint: httpProviderResult.provider.fingerprint,
		request: imageRequest(`Live HTTP image ${suffix}`),
		confirm: true,
	});
	httpJobs.push(httpStarted.id);
	const succeededHttp = await waitFor(
		() => call("get_generative_asset_job", { jobId: httpStarted.id }),
		(value) => ["succeeded", "failed", "canceled", "timed-out"].includes(value.status),
		"HTTP terminal job"
	);
	if (succeededHttp.status !== "succeeded" || succeededHttp.execution.httpStatus !== 200 || succeededHttp.candidates[0]?.id !== "http-candidate") {
		throw new Error(`HTTP generation failed: ${JSON.stringify(succeededHttp)}`);
	}
	const httpPreview = await call("get_generative_asset_preview", {
		jobId: succeededHttp.id,
		expectedResultFingerprint: succeededHttp.resultFingerprint,
		candidateId: "http-candidate",
		maximumBytes: 1024 * 1024,
	});
	if (!httpPreview.available || !httpPreview.mediaType.startsWith("image/") || !/^[a-f0-9]{64}$/.test(httpPreview.sha256)) {
		throw new Error(`HTTP preview evidence is incomplete: ${JSON.stringify(httpPreview)}`);
	}
	await assertNoRendererErrors("running the HTTP provider");

	await call("delete_asset", { path: publicationDirectory, confirm: true });
	publishedPaths = [];
	const latestExecutable = await call("get_generative_asset_job", { jobId: executableJob.id });
	await call("delete_generative_asset_job", { jobId: latestExecutable.id, expectedRevision: latestExecutable.revision, confirm: true });
	executableJobs.length = 0;
	await call("delete_generative_asset_job", { jobId: succeededHttp.id, expectedRevision: succeededHttp.revision, confirm: true });
	httpJobs.length = 0;
	await deleteProviderIfPresent(httpProviderId);
	await cdp.click('[data-generative-tab="providers"]');
	await cdp.click(`[data-generative-provider="${executableProviderId}"]`);
	await cdp.click("[data-generative-provider-delete]");
	await waitFor(
		() => call("list_generative_asset_providers"),
		(value) => !value.providers.some((entry) => entry.id === executableProviderId),
		"UI provider deletion"
	);

	const remaining = await call("list_generative_asset_jobs", { limit: 100 });
	if (remaining.jobs.some((entry) => [executableProviderId, httpProviderId].includes(entry.provider.id))) throw new Error("Live generative jobs remain after cleanup.");
	await assertNoRendererErrors("generative cleanup");
	completed = true;
	console.log(
		"[generative-assets-live] PASS — 13/13 tools, executable + HTTP providers, project reference leasing, direct provider/generate/results/preview/publication UI events, normal texture importer, provenance/history, stale-plan rejection, and cleanup verified."
	);
} catch (error) {
	console.error(`[generative-assets-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-8).join("\n"));
	process.exitCode = 1;
} finally {
	for (const path of publishedPaths) await call("delete_asset", { path, confirm: true }).catch(() => undefined);
	if (publishedPaths.length) await call("delete_asset", { path: publicationDirectory, confirm: true }).catch(() => undefined);
	for (const id of [...executableJobs, ...httpJobs]) await deleteJobIfPresent(id).catch(() => undefined);
	await deleteProviderIfPresent(httpProviderId).catch(() => undefined);
	await deleteProviderIfPresent(executableProviderId).catch(() => undefined);
	if (httpServer) await new Promise((resolve) => httpServer.close(() => resolve()));
	cdp?.socket?.close();
	if (projectDirectory) {
		await call("delete_asset", { path: referenceRelativePath, confirm: true }).catch(() => undefined);
		await rm(join(projectDirectory, adapterRelativePath), { force: true }).catch(() => undefined);
		await rm(join(projectDirectory, referenceRelativePath), { force: true }).catch(() => undefined);
	}
	child.stdin.end();
	child.kill();
	if (!completed && !process.exitCode) process.exitCode = 1;
}
