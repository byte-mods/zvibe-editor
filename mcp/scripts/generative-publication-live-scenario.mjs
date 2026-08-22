#!/usr/bin/env node
/** Positive MCP-only lifecycle for generative retry and publication inspection/application. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, "..", "server", "index.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
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

function rpc(method, params = {}, timeoutMs = 180_000) {
	const id = nextId++;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs);
		pending.set(id, (message) => {
			clearTimeout(timer);
			resolve(message);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	});
}

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const text = response.result?.content?.find((entry) => entry.type === "text")?.text ?? "";
	if (response.error || response.result?.isError) throw new Error(`${name}: ${text || JSON.stringify(response.error ?? response.result)}`);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function waitFor(read, predicate, label, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(value)}`);
}

const suffix = `${Date.now().toString(36)}-${process.pid}`;
const providerId = `mcp-gen-${suffix}`;
const publicationDirectory = `assets/mcp-generative-${suffix}`;
const jobs = [];
let providerFingerprint = null;
let server = null;

async function deleteJob(jobId) {
	const job = await call("get_generative_asset_job", { jobId }).catch(() => null);
	if (!job) return;
	await call("delete_generative_asset_job", { jobId, expectedRevision: job.revision, confirm: true }).catch(() => undefined);
}

async function cleanup() {
	await call("delete_asset", { path: publicationDirectory, confirm: true }).catch(() => undefined);
	for (const jobId of jobs.reverse()) await deleteJob(jobId);
	jobs.length = 0;
	const inventory = await call("list_generative_asset_providers").catch(() => null);
	const provider = inventory?.providers?.find((entry) => entry.id === providerId);
	if (provider) {
		await call("delete_generative_asset_provider", {
			id: providerId,
			expectedInventoryFingerprint: inventory.inventoryFingerprint,
			expectedProviderFingerprint: provider.fingerprint,
			confirm: true,
		}).catch(() => undefined);
	}
	providerFingerprint = null;
}

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "generative-publication-live-scenario", version: "1.0.0" },
	});
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready editor project is required.");
	const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 40, g: 140, b: 230, alpha: 1 } } })
		.png()
		.toBuffer();
	server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString("utf8");
		const envelope = JSON.parse(body);
		response.writeHead(200, { "Content-Type": "application/json" }).end(
			JSON.stringify({
				version: 1,
				candidates: [
					{
						id: "live-candidate",
						reportedModel: "mcp-loopback-fixture",
						reportedSeed: envelope.request.seed,
						providerRequestId: envelope.jobId,
						warnings: [],
						artifacts: [{ path: "candidate.png", role: "image", mediaType: "image/png", displayName: "MCP Candidate", dataBase64: png.toString("base64") }],
					},
				],
			})
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const inventory = await call("list_generative_asset_providers");
	const configured = await call("set_generative_asset_provider", {
		expectedInventoryFingerprint: inventory.inventoryFingerprint,
		provider: {
			version: 1,
			id: providerId,
			name: `MCP Loopback ${suffix}`,
			vendor: "Zvibe Verification",
			classification: "test-fixture",
			modalities: ["image"],
			hostPlatforms: [],
			maximumOutputBytes: 2 * 1024 * 1024,
			maximumDurationSeconds: 15,
			transport: { kind: "http", endpoint: `http://127.0.0.1:${server.address().port}/generate`, authorizationEnvironment: null, headers: {} },
		},
	});
	providerFingerprint = configured.provider.fingerprint;
	const request = {
		version: 1,
		modality: "image",
		prompt: "MCP verification image",
		negativePrompt: null,
		style: null,
		seed: 42,
		count: 1,
		references: [],
		parameters: { quality: "verification" },
		options: { modality: "image", value: { width: 64, height: 64, transparent: false } },
	};
	const started = await call("start_generative_asset_job", { providerId, expectedProviderFingerprint: providerFingerprint, request, confirm: true });
	jobs.push(started.id);
	const first = await waitFor(
		() => call("get_generative_asset_job", { jobId: started.id }),
		(job) => ["succeeded", "failed", "canceled", "timed-out"].includes(job.status),
		"first terminal generation"
	);
	if (first.status !== "succeeded") throw new Error(`Initial generation failed: ${JSON.stringify(first)}`);
	const retried = await call("retry_generative_asset_job", {
		jobId: first.id,
		expectedRevision: first.revision,
		expectedProviderFingerprint: providerFingerprint,
		confirm: true,
	});
	jobs.push(retried.id);
	const succeeded = await waitFor(
		() => call("get_generative_asset_job", { jobId: retried.id }),
		(job) => ["succeeded", "failed", "canceled", "timed-out"].includes(job.status),
		"retried terminal generation"
	);
	if (succeeded.status !== "succeeded" || succeeded.attempt !== 2 || succeeded.sourceJobId !== first.id)
		throw new Error(`Retry evidence is incomplete: ${JSON.stringify(succeeded)}`);
	const plan = await call("inspect_generative_asset_publication", {
		jobId: succeeded.id,
		expectedRevision: succeeded.revision,
		expectedResultFingerprint: succeeded.resultFingerprint,
		candidateId: "live-candidate",
		destinationDirectory: publicationDirectory,
		baseName: "verified",
		overwrite: false,
	});
	if (!/^[a-f0-9]{64}$/.test(plan.planFingerprint) || plan.files?.length !== 1 || plan.files[0].importerKind !== "texture") {
		throw new Error(`Generative publication plan is incomplete: ${JSON.stringify(plan)}`);
	}
	const published = await call("publish_generative_asset_candidate", {
		jobId: succeeded.id,
		expectedRevision: succeeded.revision,
		expectedResultFingerprint: succeeded.resultFingerprint,
		candidateId: "live-candidate",
		destinationDirectory: publicationDirectory,
		baseName: "verified",
		overwrite: false,
		expectedPlanFingerprint: plan.planFingerprint,
		confirm: true,
	});
	if (published.publication?.files?.length !== 1 || published.publication.files[0].importer?.current !== true)
		throw new Error(`Generative publication failed: ${JSON.stringify(published)}`);
	await cleanup();
	console.log(
		"[generative-publication-live] PASS — terminal retry, exact publication inspection, normal texture-importer publication, and MCP-only job/provider/asset cleanup verified."
	);
} catch (error) {
	console.error(`[generative-publication-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim().split("\n").slice(-12).join("\n"));
	process.exitCode = 1;
} finally {
	await cleanup();
	if (server) await new Promise((resolve) => server.close(resolve));
	child.kill("SIGTERM");
}
