#!/usr/bin/env node
/** Real stdio/Electron lifecycle for Unity 6.5 Entities hierarchy, quick filters, and assembly registration policy. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn("node", [join(here, "..", "server", "index.mjs")], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let stdout = "";
let stderr = "";
let nextId = 1;
let cdp;
let baseline;
let fixtureId;

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

async function inspect() {
	return call("inspect_ecs");
}

async function author(name, args) {
	const current = await inspect();
	return call(name, { expectedRevision: current.configuration.revision, expectedFingerprint: current.fingerprint, ...args });
}

function replacementConfiguration(configuration) {
	return {
		settings: configuration.settings,
		componentTypes: configuration.componentTypes,
		systems: configuration.systems,
		sections: configuration.sections,
		typeRegistrationPolicies: configuration.typeRegistrationPolicies,
	};
}

function semanticConfiguration(configuration) {
	const value = structuredClone(configuration);
	delete value.revision;
	return value;
}

async function connectCdp() {
	const port = Number(process.env.BJS_EDITOR_CDP_PORT ?? 8315);
	const response = await fetch(`http://127.0.0.1:${port}/json/list`);
	if (!response.ok) throw new Error(`Electron CDP discovery failed with HTTP ${response.status} on port ${port}.`);
	for (const target of (await response.json()).filter((entry) => entry.type === "page" && entry.webSocketDebuggerUrl)) {
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
				const details = message.params?.exceptionDetails;
				runtimeErrors.push(
					JSON.stringify({
						type: "exception",
						text: details?.text ?? "Runtime.exceptionThrown",
						description: details?.exception?.description,
						url: details?.url,
						lineNumber: details?.lineNumber,
						columnNumber: details?.columnNumber,
					})
				);
			} else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
				const entry = message.params.entry;
				runtimeErrors.push(
					JSON.stringify({
						type: "log",
						text: entry.text,
						source: entry.source,
						url: entry.url,
						lineNumber: entry.lineNumber,
						networkRequestId: entry.networkRequestId,
					})
				);
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
		if (
			await evaluate(
				"Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html') && document.querySelector('input[placeholder=\"Search...\"]'))"
			)
		) {
			await send("Runtime.enable");
			await send("Log.enable");
			return { socket, evaluate, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Electron editor page was found on CDP port ${port}.`);
}

async function waitFor(read, predicate, label, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 100));
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(value)}`);
}

const requiredTools = [
	"set_ecs_hierarchy_preferences",
	"query_ecs_hierarchy",
	"query_ecs_systems_window",
	"inspect_ecs_type_registry",
	"set_ecs_type_registration_policy",
	"delete_ecs_type_registration_policy",
];
const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`.slice(-18);
const componentId = `hierarchyMotion${suffix}`.slice(0, 64);
const systemId = `hierarchySystem${suffix}`.slice(0, 64);
const assembly = `live-${suffix}`.slice(0, 128);
const namespace = `Game.Live.${suffix}`.slice(0, 128);
const fixtureName = `Hidden ECS Fixture ${suffix}`;

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "entities-hierarchy-live-scenario", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const tools = await listTools();
	for (const name of requiredTools) {
		const tool = tools.find((candidate) => candidate.name === name);
		if (!tool || tool.inputSchema?.additionalProperties !== false) throw new Error(`${name} is missing or not closed.`);
		for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof tool.annotations?.[hint] !== "boolean") throw new Error(`${name} is missing ${hint}.`);
		}
	}
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready disposable project editor is required.");
	baseline = await inspect();

	await author("create_ecs_component_type", { component: { id: componentId, name: "Hierarchy Motion", namespace: "Game.Entities", assembly, fields: [] } });
	await author("create_ecs_system", {
		system: { id: systemId, name: "Hierarchy System", namespace, enabled: true, phase: "update", query: { all: [componentId], any: [], none: [] } },
	});
	const fixture = await call("create_primitive_mesh", { type: "box", name: fixtureName, position: [0, 0, 0], options: { size: 20 } });
	fixtureId = fixture.id;
	const stack = await call("inspect_game_object_components", { nodeId: fixtureId });
	await call("add_game_object_component", {
		nodeId: fixtureId,
		expectedFingerprint: stack.fingerprint,
		type: "entity",
		name: "Hidden Entity",
		data: { version: 3, archetype: "HiddenLive", sectionId: "main", values: {}, components: { [componentId]: {} }, bakingEnabled: true, hiddenInHierarchy: true },
	});

	let current = await inspect();
	const systems = await call("query_ecs_systems_window", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		search: `namespace:${namespace} phase:update enabled:true component:${componentId}`,
		limit: 10,
	});
	if (systems.total !== 1 || systems.systems[0].id !== systemId || !systems.availableNamespaces.includes(namespace)) throw new Error("Systems namespace/quick filtering failed.");
	const unknown = await call("query_ecs_systems_window", { expectedRevision: current.configuration.revision, expectedFingerprint: current.fingerprint, unknown: true }, true);
	if (!String(unknown).includes("-32602")) throw new Error("Closed schema did not reject an unknown field.");
	const stale = await call(
		"set_ecs_hierarchy_preferences",
		{ expectedRevision: current.configuration.revision - 1, expectedFingerprint: current.fingerprint, showHiddenEntitiesInHierarchy: false },
		true
	);
	if (!String(stale).includes("revision is stale")) throw new Error("Stale hierarchy preference mutation did not reject.");
	const excluded = await call(
		"set_ecs_type_registration_policy",
		{
			expectedRevision: current.configuration.revision,
			expectedFingerprint: current.fingerprint,
			policy: { assembly, disableAutoRegistration: true, registeredTypeIds: [] },
		},
		true
	);
	if (!String(excluded).includes("unregistered component")) throw new Error("Assembly-wide exclusion did not protect a referenced type atomically.");
	current = await inspect();
	await call("set_ecs_type_registration_policy", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		policy: { assembly, disableAutoRegistration: true, registeredTypeIds: [componentId] },
	});
	const registry = await call("inspect_ecs_type_registry", { assembly, limit: 10 });
	if (registry.total !== 1 || registry.types[0].reason !== "explicit" || !registry.types[0].registered) throw new Error("Effective type registry evidence is incomplete.");

	current = await inspect();
	await call("set_ecs_hierarchy_preferences", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		showHiddenEntitiesInHierarchy: false,
		hierarchyWorldMode: "combined",
	});
	current = await inspect();
	let hierarchy = await call("query_ecs_hierarchy", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		expectedGeneration: current.runtime.generation,
		world: "combined",
		showHidden: false,
		search: fixtureName,
		limit: 10,
	});
	if (hierarchy.total !== 0) throw new Error("Hidden Entity leaked into the default hierarchy projection.");
	hierarchy = await call("query_ecs_hierarchy", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		expectedGeneration: current.runtime.generation,
		world: "combined",
		showHidden: true,
		search: fixtureName,
		limit: 10,
	});
	if (hierarchy.total !== 1 || hierarchy.entities[0].entityId !== fixtureId || !hierarchy.entities[0].hiddenInHierarchy)
		throw new Error("Explicit hidden hierarchy read failed.");
	const staleGeneration = await call(
		"query_ecs_hierarchy",
		{
			expectedRevision: current.configuration.revision,
			expectedFingerprint: current.fingerprint,
			expectedGeneration: current.runtime.generation + 1,
			world: "runtime",
		},
		true
	);
	if (!String(staleGeneration).includes("generation is stale")) throw new Error("Stale runtime hierarchy generation did not reject.");

	await call("select_editor_tab", { tab: "graph" });
	cdp = await connectCdp();
	const expandHierarchy = () =>
		cdp.evaluate(`(async () => {
			for (let pass = 0; pass < 6; pass++) {
				const closed = [...document.querySelectorAll('.bp5-tree-node-caret-closed')];
				if (!closed.length) break;
				closed.forEach((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return true;
		})()`);
	await expandHierarchy();
	const hiddenInMainHierarchy = await waitFor(
		() => cdp.evaluate(`![...document.querySelectorAll('.bp5-tree-node-content')].some((element) => element.textContent?.includes(${JSON.stringify(fixtureName)}))`),
		Boolean,
		"hidden Entity to disappear from the main Hierarchy"
	);
	if (!hiddenInMainHierarchy) throw new Error("Main Hierarchy ignored the hidden Entity preference.");
	current = await inspect();
	await call("set_ecs_hierarchy_preferences", {
		expectedRevision: current.configuration.revision,
		expectedFingerprint: current.fingerprint,
		showHiddenEntitiesInHierarchy: true,
	});
	await expandHierarchy();
	await waitFor(
		() => cdp.evaluate(`[...document.querySelectorAll('.bp5-tree-node-content')].some((element) => element.textContent?.includes(${JSON.stringify(fixtureName)}))`),
		Boolean,
		"hidden Entity to appear in the main Hierarchy"
	);
	await call("select_editor_tab", { tab: "entities" });
	await waitFor(
		() => cdp.evaluate(`Boolean([...document.querySelectorAll('button')].find((button) => button.textContent?.trim().toLowerCase() === 'entities'))`),
		Boolean,
		"permanent Entities debugger"
	);
	await cdp.evaluate(`(() => {
		const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().toLowerCase() === 'entities');
		if (!button) throw new Error('Entities debugger view button was not found.');
		button.click();
		return true;
	})()`);
	await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-testid="ecs-hierarchy-preferences"]'))`), Boolean, "Entities hierarchy preference controls");
	await cdp.evaluate(`(() => {
		const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().toLowerCase() === 'systems');
		if (!button) throw new Error('Systems debugger view button was not found.');
		button.click();
		return true;
	})()`);
	await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-testid="ecs-systems-quick-search"]'))`), Boolean, "Systems quick-search controls");
	await cdp.evaluate(`(() => {
		const button = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().toLowerCase() === 'configuration');
		if (!button) throw new Error('Configuration debugger view button was not found.');
		button.click();
		return true;
	})()`);
	await waitFor(() => cdp.evaluate(`Boolean(document.querySelector('[data-testid="ecs-type-registration-policy"]'))`), Boolean, "assembly-wide registration controls");
	await call("select_editor_tab", { tab: "graph" });
	if (cdp.runtimeErrors.length) throw new Error(`Electron recorded runtime errors: ${cdp.runtimeErrors.join(" | ")}`);

	await author("delete_ecs_system", { systemId, confirm: true });
	await call("delete_node", { nodeId: fixtureId });
	fixtureId = undefined;
	await author("delete_ecs_type_registration_policy", { assembly, confirm: true });
	await author("delete_ecs_component_type", { componentId, confirm: true });
	current = await inspect();
	if (!baseline.authored) {
		await author("delete_ecs_configuration", { confirm: true });
	} else if (JSON.stringify(semanticConfiguration(current.configuration)) !== JSON.stringify(semanticConfiguration(baseline.configuration))) {
		await call("replace_ecs_configuration", {
			expectedRevision: current.configuration.revision,
			expectedFingerprint: current.fingerprint,
			configuration: replacementConfiguration(baseline.configuration),
		});
	}
	current = await inspect();
	if (current.authored !== baseline.authored || JSON.stringify(semanticConfiguration(current.configuration)) !== JSON.stringify(semanticConfiguration(baseline.configuration))) {
		throw new Error("Entities hierarchy live cleanup did not restore the semantic baseline.");
	}
	console.log(
		"[entities-hierarchy-live] PASS — 6/6 strict tools, hidden main/world hierarchy, exact stale guards, namespace/additional quick filters, assembly-wide exclusion/explicit registration, permanent UI, zero runtime errors, and semantic cleanup verified."
	);
} catch (error) {
	console.error(`[entities-hierarchy-live] FAIL — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	try {
		if (fixtureId) await call("delete_node", { nodeId: fixtureId });
		if (baseline) {
			let current = await inspect();
			if (!baseline.authored && current.authored) {
				await call("delete_ecs_configuration", { expectedRevision: current.configuration.revision, expectedFingerprint: current.fingerprint, confirm: true });
			} else if (baseline.authored && JSON.stringify(semanticConfiguration(current.configuration)) !== JSON.stringify(semanticConfiguration(baseline.configuration))) {
				await call("replace_ecs_configuration", {
					expectedRevision: current.configuration.revision,
					expectedFingerprint: current.fingerprint,
					configuration: replacementConfiguration(baseline.configuration),
				});
			}
		}
	} catch (cleanupError) {
		console.error(`[entities-hierarchy-live] cleanup failed — ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
		process.exitCode = 1;
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
}
