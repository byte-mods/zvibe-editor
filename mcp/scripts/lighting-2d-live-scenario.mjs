#!/usr/bin/env node
/** Real stdio/editor lifecycle for Light2D/ShadowCaster2D authoring, provider discovery, runtime evidence, strict validation, and cleanup. */
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

async function waitForPlayReady() {
	for (let attempt = 0; attempt < 120; attempt++) {
		const status = await call("get_editor_status");
		if (status.play.canPlay) return status;
		if (!status.play.playing && !status.play.preparing && !status.play.loading) throw new Error("Compiled Play stopped before it became ready.");
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error("Timed out waiting 60 seconds for compiled Play to become ready.");
}

const requiredTools = [
	"list_light2d_provider_types",
	"get_lighting2d_runtime",
	"list_game_object_component_types",
	"inspect_game_object_components",
	"add_game_object_component",
	"set_game_object_component",
	"remove_game_object_component",
	"list_script_templates",
];
const fixtureName = `MCP Lighting2D ${Date.now()}-${process.pid}`;
const providerScriptPath = `src/mcp-lighting-2d-${Date.now()}-${process.pid}.ts`;
let fixtureId;
let providerScriptCreated = false;

async function cleanup() {
	try {
		const status = await call("get_editor_status");
		if (status.play.playing) await call("set_preview_play_mode", { action: "stop" });
		if (fixtureId) await call("delete_node", { nodeId: fixtureId });
		if (providerScriptCreated) await call("delete_script", { path: providerScriptPath, confirm: true });
	} catch (error) {
		if (!/not found/i.test(String(error))) throw error;
	} finally {
		fixtureId = undefined;
		providerScriptCreated = false;
	}
}

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "lighting-2d-live-scenario", version: "1.0.0" },
	});
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or its input schema is not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required for the Lighting2D live scenario.");

	const providers = await call("list_light2d_provider_types", { target: "edit", kind: "all", limit: 100 });
	for (const expected of ["builtin.global", "builtin.point", "builtin.freeform", "builtin.sprite", "builtin.shape-editor", "builtin.node-bounds"]) {
		if (!providers.providers.some((provider) => provider.id === expected)) throw new Error(`Provider ${expected} is missing from Edit registry discovery.`);
	}
	if (providers.registryScope !== "editor-tools-module" || providers.nextCursor !== null) throw new Error("Provider pagination/scope evidence is incomplete.");
	const firstPage = await call("list_light2d_provider_types", { target: "edit", kind: "all", limit: 2 });
	const secondPage = await call("list_light2d_provider_types", { target: "edit", kind: "all", cursor: firstPage.nextCursor, limit: 100 });
	if (firstPage.providers.length !== 2 || secondPage.providers.length !== providers.total - 2) throw new Error("Provider cursor pagination is inconsistent.");

	const templates = await call("list_script_templates");
	if (!templates.templates.some((template) => template.id === "light2d-providers")) throw new Error("The project provider script template is missing.");
	const componentTypes = await call("list_game_object_component_types");
	for (const expected of ["light2d", "shadowcaster2d"]) {
		if (!componentTypes.types.some((entry) => entry.type === expected)) throw new Error(`${expected} is missing from the component registry.`);
	}

	const fixture = await call("create_primitive_mesh", { type: "box", name: fixtureName, options: { width: 50, height: 50, depth: 10 } });
	fixtureId = fixture.id;
	let inspection = await call("inspect_game_object_components", { nodeId: fixtureId });
	inspection = await call("add_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: inspection.fingerprint,
		type: "light2d",
		data: { lightType: "point", providerId: "builtin.point", color: [1, 0.5, 0.25, 1], intensity: 2, outerRadius: 500, shadowsEnabled: true },
	});
	const light = inspection.components.find((entry) => entry.type === "light2d");
	inspection = await call("add_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: inspection.fingerprint,
		type: "shadowcaster2d",
		data: { sourceType: "node-bounds", providerId: "builtin.node-bounds", castingOption: "cast-and-self-shadow", priority: 3 },
	});
	const caster = inspection.components.find((entry) => entry.type === "shadowcaster2d");
	inspection = await call("set_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: inspection.fingerprint,
		componentId: light.id,
		data: { intensity: 3, overlapOperation: "alpha-blend" },
	});
	if (inspection.components.find((entry) => entry.id === light.id).data.intensity !== 3) throw new Error("Light2D mutation did not round-trip.");

	const runtime = await call("get_lighting2d_runtime", { target: "edit" });
	for (const componentId of [light.id, caster.id]) {
		const evidence = runtime.providers.find((entry) => entry.componentId === componentId);
		if (!evidence?.valid || evidence.beforeRenderCount < 1) throw new Error(`Runtime evidence is missing or invalid for ${componentId}.`);
	}

	inspection = await call("set_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: inspection.fingerprint,
		componentId: light.id,
		data: { lightType: "provider", providerId: "project.pulse-light", providerVersion: 1, providerData: { radius: 500, pulseAmount: 25 } },
	});
	inspection = await call("set_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: inspection.fingerprint,
		componentId: caster.id,
		data: { sourceType: "provider", providerId: "project.box-shadow", providerVersion: 1, providerData: { halfWidth: 25, halfHeight: 25 } },
	});
	await call("create_script", { path: providerScriptPath, className: "McpLighting2DProviderRegistration", template: "light2d-providers" });
	providerScriptCreated = true;
	const scriptValidation = await call("validate_script", { path: providerScriptPath });
	if (!scriptValidation.valid) throw new Error(`Generated provider template is not valid TypeScript: ${JSON.stringify(scriptValidation.diagnostics)}`);
	await call("attach_script", { nodeId: fixtureId, path: providerScriptPath });
	const play = await call("set_preview_play_mode", { action: "play" });
	if (!play.playing) throw new Error(`Compiled Play did not start: ${JSON.stringify(play)}`);
	await waitForPlayReady();
	const playProviders = await call("list_light2d_provider_types", { target: "play", kind: "all", limit: 100 });
	for (const expected of ["project.pulse-light", "project.box-shadow"]) {
		if (!playProviders.providers.some((provider) => provider.id === expected)) throw new Error(`Compiled Play registry is missing ${expected}.`);
	}
	if (playProviders.registryScope !== "compiled-game-script-bundle") throw new Error("Play provider discovery did not use the compiled bundle registry.");
	const playRuntime = await call("get_lighting2d_runtime", { target: "play" });
	for (const expected of [
		[light.id, "project.pulse-light"],
		[caster.id, "project.box-shadow"],
	]) {
		const evidence = playRuntime.providers.find((entry) => entry.componentId === expected[0]);
		if (!evidence?.valid || evidence.providerId !== expected[1] || evidence.registeredVersion !== 1) {
			throw new Error(`Compiled Play provider lifecycle is incomplete for ${expected[1]}: ${JSON.stringify(evidence)}`);
		}
	}
	await call("set_preview_play_mode", { action: "stop" });
	const malformed = await call(
		"add_game_object_component",
		{ nodeId: fixtureId, expectedFingerprint: inspection.fingerprint, type: "light2d", data: { intensity: "bright" } },
		true
	);
	if (!String(malformed).includes("-32602")) throw new Error("Malformed Light2D schema input was not rejected before editor contact.");
	const unknown = await call("get_lighting2d_runtime", { target: "edit", unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Lighting2D runtime tool did not reject an unknown field.");
	const unavailablePlay = await call("get_lighting2d_runtime", { target: "play" }, true);
	if (!String(unavailablePlay).includes("compiled Play scene is not ready")) throw new Error("Explicit unavailable Play targeting did not fail clearly.");

	inspection = await call("inspect_game_object_components", { nodeId: fixtureId });
	inspection = await call("remove_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: inspection.fingerprint,
		componentId: caster.id,
	});
	inspection = await call("remove_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: inspection.fingerprint,
		componentId: light.id,
	});
	if (inspection.components.some((entry) => entry.type === "light2d" || entry.type === "shadowcaster2d")) throw new Error("Component cleanup failed.");
	await cleanup();
	console.log(
		"[lighting-2d-live] PASS — 8 strict MCP tools, provider discovery/pagination, component authoring/update/removal, measured Edit lifecycle, generated provider TypeScript, exact compiled-Play registry/lifecycle, invalid-input rejection, target guards, and cleanup verified."
	);
} catch (error) {
	console.error(`[lighting-2d-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		await cleanup();
	} catch (error) {
		console.error(`[lighting-2d-live] cleanup failed — ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
	child.kill("SIGTERM");
}
