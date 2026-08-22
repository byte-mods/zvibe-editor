#!/usr/bin/env node
/** Real stdio/Electron lifecycle for portable Unity 6.5 Shader Graph additions. */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

import WebSocket from "ws";

import { getExpectedMcpToolCount } from "./live-scenario-contract.mjs";

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
			} else if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
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
		if (await evaluate("Boolean(document.body && location.protocol === 'file:' && location.pathname.endsWith('/editor/index.html'))")) {
			await send("Runtime.enable");
			await send("Log.enable");
			return { socket, evaluate, runtimeErrors };
		}
		socket.close();
	}
	throw new Error(`No Zvibe Editor page was found on CDP port ${port}.`);
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
	"get_shader_graph_capabilities",
	"list_shader_graph_templates",
	"create_shader_graph_from_template",
	"apply_shader_graph_template",
	"get_shader_graph_extensions",
	"open_shader_graph_inspector",
	"set_shader_graph_switch",
	"delete_shader_graph_switch",
	"inspect_shader_graph_reflected_function",
	"add_shader_graph_reflected_function",
	"set_shader_graph_subgraph_input",
];
const supportTools = [
	"get_editor_status",
	"validate_node_material_graph",
	"get_node_material_graph",
	"set_node_material_blackboard",
	"save_node_material_subgraph",
	"get_node_material_subgraph",
	"delete_material",
	"delete_asset",
];
const suffix = `${Date.now()}-${process.pid}`;
const materialName = `Codex Shader Graph 748 ${suffix}`;
const sourcePath = `assets/.codex-shader-graph-${suffix}.glsl`;
const subgraphPath = `assets/.codex-shader-graph-${suffix}.shadergraph.json`;
let projectDirectory;
let material;
let cdp;
let sourceCreated = false;
let subgraphCreated = false;

try {
	const initialized = await rpc("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "shader-graph-live-scenario", version: "1.0.0" },
	});
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = await listTools();
	const expectedToolCount = await getExpectedMcpToolCount();
	if (tools.length !== expectedToolCount) throw new Error(`Expected ${expectedToolCount} MCP tools, received ${tools.length}.`);
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
	await mkdir(join(projectDirectory, "assets"), { recursive: true });
	await writeFile(join(projectDirectory, sourcePath), "vec4 zvibeTint(vec4 color, float amount) { return color * amount; }\n", "utf8");
	sourceCreated = true;

	const capabilities = await call("get_shader_graph_capabilities");
	if (capabilities.templates?.search !== true || capabilities.switchNode?.maximumCases !== 16 || capabilities.reflectedFunctions?.language !== "GLSL") {
		throw new Error(`Shader Graph capabilities are incomplete: ${JSON.stringify(capabilities)}`);
	}
	const templates = await call("list_shader_graph_templates", { query: "decal", category: "Rendering", offset: 0, limit: 10 });
	if (templates.total !== 1 || templates.templates[0]?.id !== "urp-decal-projector-portable") throw new Error(`Template search failed: ${JSON.stringify(templates)}`);
	material = await call("create_shader_graph_from_template", {
		templateId: templates.templates[0].id,
		expectedCatalogRevision: templates.catalogRevision,
		name: materialName,
		folder: "assets",
	});
	if (!material.path?.endsWith(".material")) throw new Error(`Template material was not persisted: ${JSON.stringify(material)}`);

	const validation = await call("validate_node_material_graph", { materialId: material.id });
	if (validation.valid !== true) throw new Error(`Template graph failed real editor compilation: ${JSON.stringify(validation)}`);
	const graph = await call("get_node_material_graph", { materialId: material.id });
	const color = graph.graph.blocks.find((block) => block.customType === "BABYLON.InputBlock" && block.name === "color");
	if (!color) throw new Error("Built template graph did not expose its authored color input.");
	await call("set_node_material_blackboard", {
		materialId: material.id,
		parameters: [
			{
				name: "Tint",
				inputName: "color",
				label: "Tint",
				defaultValue: [0.8, 0.8, 0.8, 1],
				connectorEnabled: true,
				floatMode: "default",
				description: "Portable decal tint",
			},
		],
	});

	let extensions = await call("get_shader_graph_extensions", { materialId: material.id });
	const switched = await call("set_shader_graph_switch", {
		materialId: material.id,
		expectedGraphRevision: extensions.graphRevision,
		name: "QualitySwitch",
		mode: "enum",
		valueType: "Color4",
		target: "Fragment",
		cases: [
			{ label: "Low", match: 0 },
			{ label: "Medium", match: 1 },
			{ label: "High", match: 2 },
		],
	});
	if (switched.switch?.cases?.length !== 3) throw new Error(`Switch creation failed: ${JSON.stringify(switched)}`);
	await call(
		"set_shader_graph_switch",
		{
			materialId: material.id,
			expectedGraphRevision: extensions.graphRevision,
			name: "StaleSwitch",
			mode: "float",
			valueType: "Float",
			cases: [
				{ label: "A", match: 0 },
				{ label: "B", match: 1 },
			],
		},
		true
	);

	const reflected = await call("inspect_shader_graph_reflected_function", { sourcePath, functionName: "zvibeTint" });
	if (reflected.function?.returnType !== "vec4" || reflected.function?.parameters?.length !== 2) throw new Error(`GLSL reflection failed: ${JSON.stringify(reflected)}`);
	const reflectedAdded = await call("add_shader_graph_reflected_function", {
		materialId: material.id,
		expectedGraphRevision: switched.graphRevision,
		sourcePath,
		expectedSourceRevision: reflected.sourceRevision,
		functionName: "zvibeTint",
		blockName: "Reflected Tint",
		target: "Fragment",
	});
	if (reflectedAdded.reflectedFunction?.blockName !== "Reflected Tint") throw new Error(`Reflected block insertion failed: ${JSON.stringify(reflectedAdded)}`);

	const saved = await call("save_node_material_subgraph", { materialId: material.id, outputPath: subgraphPath, name: "Codex 748 Subgraph" });
	if (saved.version !== 2 || !saved.revision) throw new Error(`V2 subgraph save failed: ${JSON.stringify(saved)}`);
	subgraphCreated = true;
	const staticInput = await call("set_shader_graph_subgraph_input", {
		path: subgraphPath,
		expectedRevision: saved.revision,
		parameterName: "Tint",
		connectorEnabled: false,
		floatMode: "default",
		staticValue: [0.2, 0.4, 0.8, 1],
		description: "Static portable decal tint",
	});
	if (staticInput.parameter?.connectorEnabled !== false || staticInput.revision === saved.revision)
		throw new Error(`Static subgraph update failed: ${JSON.stringify(staticInput)}`);
	await call(
		"set_shader_graph_subgraph_input",
		{
			path: subgraphPath,
			expectedRevision: saved.revision,
			parameterName: "Tint",
			connectorEnabled: true,
			floatMode: "default",
		},
		true
	);
	const subgraph = await call("get_node_material_subgraph", { path: subgraphPath });
	if (subgraph.version !== 2 || subgraph.blackboard[0]?.staticValue?.[2] !== 0.8) throw new Error(`Subgraph readback failed: ${JSON.stringify(subgraph)}`);

	extensions = await call("get_shader_graph_extensions", { materialId: material.id });
	if (extensions.switches.length !== 1 || extensions.reflectedFunctions.length !== 1 || extensions.template?.id !== "urp-decal-projector-portable") {
		throw new Error(`Graph extension evidence is incomplete: ${JSON.stringify(extensions)}`);
	}
	await call("open_shader_graph_inspector", { materialId: material.id });

	cdp = await connectCdp();
	const ui = await waitFor(
		() =>
			cdp.evaluate(`(() => {
				const root = document.querySelector('[data-testid=shader-graph-65-status]');
				return root ? { text: root.textContent, searchPlaceholder: root.querySelector('input')?.placeholder, title: document.title } : null;
			})()`),
		(value) => value?.text?.includes("1 Switch node") && value?.text?.includes("1 reflected function"),
		"Shader Graph 6.5 Inspector evidence"
	);
	if (!ui.searchPlaceholder?.includes("Search templates") || !ui.title?.trim())
		throw new Error(`Visible Shader Graph Inspector evidence is incomplete: ${JSON.stringify(ui)}`);
	await new Promise((resolve) => setTimeout(resolve, 250));
	if (cdp.runtimeErrors.length) throw new Error(`Electron renderer errors: ${JSON.stringify(cdp.runtimeErrors)}`);

	console.log(
		JSON.stringify(
			{
				status: "PASS",
				toolCount: tools.length,
				template: extensions.template.id,
				switchCases: extensions.switches[0].cases.length,
				reflectedFunction: extensions.reflectedFunctions[0].functionName,
				subgraphRevision: subgraph.revision,
				ui,
			},
			null,
			2
		)
	);
} finally {
	const cleanupErrors = [];
	try {
		if (material?.id) await call("delete_material", { materialId: material.id });
	} catch (error) {
		cleanupErrors.push(`delete_material: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const path of [material?.path, subgraphCreated ? subgraphPath : undefined, sourceCreated ? sourcePath : undefined]) {
		if (!path) continue;
		try {
			await call("delete_asset", { path, confirm: true });
		} catch (error) {
			cleanupErrors.push(`delete_asset(${path}): ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	cdp?.socket.close();
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (stderr.trim() && !stderr.includes("Server started")) process.stderr.write(stderr);
	if (cleanupErrors.length) throw new Error(`Live scenario cleanup failed:\n${cleanupErrors.join("\n")}`);
}
