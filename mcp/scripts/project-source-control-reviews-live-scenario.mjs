#!/usr/bin/env node
/** Positive real-editor MCP verification for hosted review configuration, CRUD, metadata, checks, decisions, and leased merge. */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
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

async function requestBody(request) {
	const chunks = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	const text = Buffer.concat(chunks).toString("utf8");
	return text ? JSON.parse(text) : null;
}

function json(response, status, value, headers = {}) {
	const body = JSON.stringify(value);
	response.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers });
	response.end(body);
}

const headSha = "a".repeat(40);
const requests = [];
let reviewers = ["alice"];
let teams = ["rendering"];
let labels = ["bug"];
let server;
let providerConfigured = false;
const cleanupScript = `zvibe-review-cleanup-${Date.now()}-${process.pid}.mts`;

function review(number, title) {
	return {
		number,
		title,
		body: "Review body",
		state: "open",
		draft: false,
		user: { login: "reviewer" },
		head: { ref: "feature/rendering", sha: headSha },
		base: { ref: "main", sha: "b".repeat(40) },
		mergeable: true,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-02T00:00:00Z",
		html_url: "https://example.invalid/acme/game/pull/7",
		requested_reviewers: reviewers.map((login) => ({ login })),
		requested_teams: teams.map((slug) => ({ slug })),
		labels: labels.map((name) => ({ name })),
	};
}

try {
	server = createServer((request, response) => {
		void (async () => {
			const body = await requestBody(request);
			requests.push({ method: request.method, path: request.url, authorizationPresent: typeof request.headers.authorization === "string", body });
			if (request.method === "GET" && request.url === "/repos/acme/game/pulls?state=open&per_page=2") return json(response, 200, [review(7, "Lighting review")]);
			if (request.method === "GET" && request.url === "/repos/acme/game/pulls/7") return json(response, 200, review(7, "Lighting review"));
			if (request.method === "POST" && request.url === "/repos/acme/game/pulls/7/requested_reviewers") {
				reviewers = [...new Set([...reviewers, ...(body.reviewers ?? [])])];
				teams = [...new Set([...teams, ...(body.team_reviewers ?? [])])];
				return json(response, 200, review(7, "Lighting review"));
			}
			if (request.method === "DELETE" && request.url === "/repos/acme/game/pulls/7/requested_reviewers") {
				reviewers = reviewers.filter((name) => !(body.reviewers ?? []).includes(name));
				teams = teams.filter((name) => !(body.team_reviewers ?? []).includes(name));
				return json(response, 200, review(7, "Lighting review"));
			}
			if (request.method === "PUT" && request.url === "/repos/acme/game/issues/7/labels") {
				labels = body.labels;
				return json(response, 200, labels.map((name) => ({ name })));
			}
			if (request.method === "GET" && request.url === `/repos/acme/game/commits/${headSha}/check-runs?per_page=50`) {
				return json(response, 200, { check_runs: [{ id: 301, name: "Editor tests", status: "completed", conclusion: "success", html_url: "https://example.invalid/check/301" }] });
			}
			if (request.method === "GET" && request.url === `/repos/acme/game/actions/runs?head_sha=${headSha}&per_page=50`) {
				return json(response, 200, { workflow_runs: [{ id: 401, name: "CI", status: "completed", conclusion: "failure", head_sha: headSha, run_attempt: 1 }] });
			}
			if (request.method === "POST" && request.url === "/repos/acme/game/actions/runs/401/rerun-failed-jobs") return json(response, 201, {});
			if (request.method === "POST" && request.url === "/repos/acme/game/pulls") return json(response, 201, review(8, body.title));
			if (request.method === "POST" && request.url === "/repos/acme/game/pulls/7/reviews") return json(response, 200, { id: 91, state: body.event });
			if (request.method === "PUT" && request.url === "/repos/acme/game/pulls/7/merge") return json(response, 200, { merged: true, message: "Pull Request successfully merged" });
			return json(response, 404, { message: `Unhandled ${request.method} ${request.url}` });
		})().catch((error) => json(response, 500, { message: String(error) }));
	});
	await new Promise((resolveValue, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolveValue);
	});
	const address = server.address();
	const apiBaseUrl = `http://127.0.0.1:${address.port}/`;

	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "project-source-control-reviews-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const status = await call("get_editor_status");
	assert(status.ready && status.projectPath, "A ready editor project is required", status);
	const originalProvider = await call("get_project_source_control_review_provider");
	assert(originalProvider.enabled === false, "Isolated review verification requires the project review provider to start disabled", originalProvider);
	const configured = await call("set_project_source_control_review_provider", {
		enabled: true,
		provider: "github",
		apiBaseUrl,
		repository: "acme/game",
		tokenEnvironmentVariable: "USER",
		confirm: true,
	});
	providerConfigured = true;
	assert(configured.enabled === true && configured.provider === "github" && configured.tokenConfigured === true, "Review provider configuration failed", configured);

	const listed = await call("list_project_source_control_reviews", { state: "open", limit: 2 });
	assert(listed.count === 1 && listed.reviews?.[0]?.number === 7, "Review listing failed", listed);
	const detail = await call("get_project_source_control_review", { number: 7 });
	assert(detail.review?.head?.sha === headSha && detail.review?.mergeable === true, "Review detail is incomplete", detail);
	const metadata = await call("get_project_source_control_review_metadata", { number: 7 });
	assert(metadata.fingerprint && metadata.reviewers?.[0] === "alice" && metadata.teams?.[0] === "rendering", "Review metadata inspection failed", metadata);
	const updatedMetadata = await call("set_project_source_control_review_metadata", {
		number: 7,
		expectedFingerprint: metadata.fingerprint,
		reviewers: ["bob"],
		teams: ["engine"],
		labels: ["ready"],
		confirm: true,
	});
	assert(updatedMetadata.updated === true && updatedMetadata.metadata?.reviewers?.[0] === "bob", "Review metadata replacement failed", updatedMetadata);
	const checks = await call("list_project_source_control_review_checks", { number: 7 });
	assert(checks.headSha === headSha && checks.summary?.total === 2 && checks.runs?.[0]?.id === 401, "Review checks inspection failed", checks);
	const rerun = await call("rerun_project_source_control_review_checks", { number: 7, expectedHeadSha: headSha, runId: 401, mode: "failed", confirm: true });
	assert(rerun.accepted === true && rerun.runId === 401, "Review-check rerun failed", rerun);
	const created = await call("create_project_source_control_review", {
		title: "New review",
		body: "Please review",
		head: "feature/rendering",
		base: "main",
		draft: true,
		confirm: true,
	});
	assert(created.created === true && created.review?.number === 8, "Review creation failed", created);
	const submitted = await call("submit_project_source_control_review", { number: 7, action: "requestChanges", body: "Please fix the shader", confirm: true });
	assert(submitted.submitted === true && submitted.action === "requestChanges", "Review decision submission failed", submitted);
	const merged = await call("merge_project_source_control_review", { number: 7, expectedHeadSha: headSha, method: "squash", commitTitle: "Merge rendering", confirm: true });
	assert(merged.merged === true && merged.headSha === headSha && merged.method === "squash", "Leased review merge failed", merged);
	assert(requests.length >= 10 && requests.every((request) => request.authorizationPresent), "Provider requests were missing environment-backed authorization", requests);

	await call("set_project_source_control_review_provider", { enabled: false, provider: "github", confirm: true });
	providerConfigured = false;
	await call("run_agent_script", {
		name: cleanupScript,
		content: `
import { remove } from "fs-extra";
import { join } from "path";
export async function main(editor) {
	const root = editor.state.projectPath.slice(0, editor.state.projectPath.lastIndexOf("/"));
	await remove(join(root, ".babylon-editor", "source-control-review-provider.json"));
	return { removed: true };
}`,
	});
	await call("delete_asset", { path: `agentdata/${cleanupScript}`, confirm: true }).catch(() => undefined);
	console.log(JSON.stringify({ ok: true, verified: 10, requests: requests.length, metadataUpdated: true, checksRerun: true, reviewCreated: true, decisionSubmitted: true, leasedMerge: true }, null, 2));
} finally {
	try {
		if (providerConfigured) await call("set_project_source_control_review_provider", { enabled: false, provider: "github", confirm: true });
	} catch (cleanupError) {
		stderr += `\nCleanup error: ${cleanupError?.stack ?? cleanupError}`;
	}
	child.kill();
	if (server) await new Promise((resolveValue) => server.close(resolveValue));
	if (process.exitCode && stderr.trim()) console.error(stderr.trim());
}
