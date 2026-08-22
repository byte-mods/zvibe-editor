#!/usr/bin/env node
/** Positive real-editor lifecycle for every uncovered custom render-graph MCP tool. */
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

function rpc(method, params, timeoutMs = 240_000) {
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

const required = [
	"set_custom_render_pass",
	"evaluate_custom_render_pass_graph",
	"run_render_graph_conformance",
	"clear_render_graph_conformance",
	"capture_custom_render_pass_frame",
	"set_custom_render_pass_frame_isolation",
	"save_custom_render_graph_asset",
	"get_custom_render_graph_asset",
	"get_custom_render_graph_asset_migration",
	"migrate_custom_render_graph_asset",
	"apply_custom_render_graph_asset",
	"update_assigned_custom_render_graph_asset",
	"detach_custom_render_graph_asset",
	"delete_custom_render_graph_asset",
	"save_renderer_feature_asset",
	"get_renderer_feature_asset",
	"instantiate_renderer_feature",
	"set_renderer_feature_instance",
	"refresh_renderer_feature_instance",
	"delete_renderer_feature_instance",
	"delete_renderer_feature_asset",
	"set_custom_render_pass_gpu_profiling",
	"get_custom_compute_node_graph",
	"initialize_custom_compute_node_graph",
	"set_custom_compute_node_graph",
	"add_custom_compute_node",
	"set_custom_compute_node",
	"delete_custom_compute_node",
	"connect_custom_compute_nodes",
	"disconnect_custom_compute_nodes",
	"compile_custom_compute_node_graph",
	"save_custom_compute_subgraph",
	"get_custom_compute_subgraph",
	"get_custom_compute_subgraph_migration",
	"migrate_custom_compute_subgraph",
	"insert_custom_compute_subgraph",
	"delete_custom_compute_subgraph",
	"list_custom_compute_subgraph_instances",
	"set_custom_compute_subgraph_instance",
	"get_custom_compute_subgraph_diagnostics",
	"refresh_custom_compute_subgraph_instance",
	"delete_custom_compute_subgraph_instance",
	"preview_custom_compute_node_graph",
	"get_custom_compute_texture_node_previews",
	"capture_custom_render_pass_output",
	"debug_custom_compute_node_graph",
	"get_custom_compute_node_profile",
	"set_custom_compute_storage_buffer_data",
	"set_custom_compute_uniform_buffer_values",
	"read_custom_compute_storage_buffer",
];

const suffix = `${Date.now()}-${process.pid}`;
const identifier = `mcp_${Date.now()}_${process.pid}`;
const folder = `assets/mcp-render-graph-${suffix}`;
const paths = {
	texture: `${folder}/pixel.png`,
	graph: `${folder}/main.rendergraph.json`,
	legacyGraph: `${folder}/legacy.rendergraph.json`,
	feature: `${folder}/grade.renderfeature.json`,
	subgraph: `${folder}/uv.computegraph.json`,
	legacySubgraph: `${folder}/legacy.computegraph.json`,
};
const setupScript = `mcp-render-graph-setup-${suffix}.js`;
const legacyGraphScript = `mcp-render-graph-legacy-${suffix}.js`;
const conformanceReadScript = `mcp-render-conformance-read-${suffix}.js`;
const conformanceRestoreScript = `mcp-render-conformance-restore-${suffix}.js`;
const passIds = new Set();
let graphAsset;
let featureAsset;
let featureInstance;
let subgraphInstance;
let conformanceSnapshot;
let conformanceRestored = false;

async function cleanup() {
	await call("set_custom_render_pass_frame_isolation", { clear: true }).catch(() => undefined);
	await call("set_custom_render_pass_gpu_profiling", { enabled: false }).catch(() => undefined);
	if (!conformanceRestored && conformanceSnapshot !== undefined) {
		const source = `export async function main(editor) { const scene = editor.layout.preview.scene; scene.metadata ??= {}; const value = ${JSON.stringify(
			conformanceSnapshot
		)}; if (value === null) delete scene.metadata.babylonEditorRenderGraphConformance; else scene.metadata.babylonEditorRenderGraphConformance = value; return "restored"; }`;
		await call("run_agent_script", { name: conformanceRestoreScript, content: source }).catch(() => undefined);
	}
	const passes = await call("list_custom_render_passes", {}).catch(() => undefined);
	const assignment = passes?.renderGraphAsset?.assignment;
	if (assignment && [paths.graph, paths.legacyGraph].includes(assignment.path))
		await call("detach_custom_render_graph_asset", { id: assignment.id, expectedRevision: assignment.contentRevision }).catch(() => undefined);
	const instances = await call("list_renderer_feature_instances", {}).catch(() => undefined);
	for (const instance of instances?.instances ?? []) {
		if (instance.assetPath === paths.feature) await call("delete_renderer_feature_instance", { instanceId: instance.id, revision: instance.revision, confirm: true }).catch(() => undefined);
	}
	for (const id of [...passIds].reverse()) await call("delete_custom_render_pass", { id }).catch(() => undefined);
	for (const path of [
		paths.graph,
		paths.legacyGraph,
		paths.feature,
		paths.subgraph,
		paths.legacySubgraph,
		`agentdata/${setupScript}`,
		`agentdata/${legacyGraphScript}`,
		`agentdata/${conformanceReadScript}`,
		`agentdata/${conformanceRestoreScript}`,
		`.bjseditor/agent-scripts/${setupScript.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScript.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${legacyGraphScript.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${legacyGraphScript.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${conformanceReadScript.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${conformanceReadScript.replace(/\.js$/, ".cjs.map")}`,
		`.bjseditor/agent-scripts/${conformanceRestoreScript.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${conformanceRestoreScript.replace(/\.js$/, ".cjs.map")}`,
		folder,
	])
		await call("delete_asset", { path, confirm: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "render-graph-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listedTools = await rpc("tools/list", {});
	for (const name of required) if (!listedTools.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for custom render-graph testing.");

	const setupSource = `
import { dirname, join } from "path";
import { ensureDir, writeJSON } from "fs-extra";
import sharp from "sharp";
export async function main(editor) {
	const root = dirname(editor.state.projectPath);
	const folder = join(root, ${JSON.stringify(folder)});
	await ensureDir(folder);
	const pixels = Buffer.from([255,64,32,255, 32,128,255,255, 32,255,128,255, 255,255,32,255]);
	await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(join(root, ${JSON.stringify(paths.texture)}));
	await writeJSON(join(root, ${JSON.stringify(paths.legacySubgraph)}), {
		version: 1,
		type: "babylon-editor-compute-subgraph",
		name: "MCP Legacy Select",
		nodes: [
			{ id: "fallback", type: "constant-color", position: [0,0], value: [0,0,0,1] },
			{ id: "selected", type: "constant-color", position: [0,80], value: [1,1,1,1] },
			{ id: "choose", type: "select", position: [220,40] }
		],
		edges: [
			{ from: "fallback", fromPort: "value", to: "choose", toPort: "whenFalse" },
			{ from: "selected", fromPort: "value", to: "choose", toPort: "whenTrue" }
		],
		inputs: [{ name: "condition", nodeId: "choose", port: "condition", type: "vec4f" }],
		output: { nodeId: "choose", port: "value", type: "vec4f" }
	}, { spaces: "\t" });
	return "render graph fixtures created";
}`;
	await call("run_agent_script", { name: setupScript, content: setupSource });

	const conformanceRead = await call("run_agent_script", {
		name: conformanceReadScript,
		content:
			'export async function main(editor) { const value = editor.layout.preview.scene.metadata?.babylonEditorRenderGraphConformance ?? null; return JSON.stringify(value); }',
	});
	conformanceSnapshot = JSON.parse(conformanceRead.result);

	const shaderPass = await call("create_custom_render_pass", {
		name: `MCP Grade ${suffix}`,
		passType: "shader",
		output: `mcpColor_${identifier}`,
		ratio: 0.5,
		uniforms: { amount: 0.5 },
		fragmentShader:
			"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform float amount; void main(void) { vec4 color = texture2D(textureSampler, vUV); gl_FragColor = vec4(color.rgb * amount, color.a); }",
	});
	passIds.add(shaderPass.id);
	await call("set_custom_render_pass", { id: shaderPass.id, ratio: 0.75, uniforms: { amount: 0.8 } });
	await call("evaluate_custom_render_pass_graph", {});
	await call("get_screenshot", { width: 320, height: 180 });
	await call("capture_custom_render_pass_frame", { passLimit: 32, resourceLimit: 64 });
	await call("set_custom_render_pass_frame_isolation", { id: shaderPass.id });
	await call("get_screenshot", { width: 320, height: 180 });
	await call("set_custom_render_pass_frame_isolation", { clear: true });
	await call("evaluate_custom_render_pass_graph", {});
	await call("get_screenshot", { width: 320, height: 180 });
	const outputPreview = await call("capture_custom_render_pass_output", { output: `mcpColor_${identifier}`, width: 64, height: 64, includeImage: false });
	if (!outputPreview.runtimeReady || !outputPreview.preview?.pixelSha256) throw new Error(`Custom output capture was not ready: ${JSON.stringify(outputPreview)}`);

	const conformanceBefore = await call("get_render_graph_conformance", {});
	const conformance = await call("run_render_graph_conformance", { expectedRevision: conformanceBefore.revision, frameCount: 1 });
	if (!conformance.revision) throw new Error("Render-graph conformance returned no persisted revision.");
	await call("clear_render_graph_conformance", { revision: conformance.revision, confirm: true });
	const restoreSource = `export async function main(editor) { const scene = editor.layout.preview.scene; scene.metadata ??= {}; const value = ${JSON.stringify(
		conformanceSnapshot
	)}; if (value === null) delete scene.metadata.babylonEditorRenderGraphConformance; else scene.metadata.babylonEditorRenderGraphConformance = value; return "restored"; }`;
	await call("run_agent_script", { name: conformanceRestoreScript, content: restoreSource });
	conformanceRestored = true;

	graphAsset = await call("save_custom_render_graph_asset", { path: paths.graph, assetName: `MCP Main Graph ${suffix}` });
	const graphRead = await call("get_custom_render_graph_asset", { path: paths.graph });
	if (graphRead.contentRevision !== graphAsset.contentRevision) throw new Error("Saved render-graph revision does not round-trip.");
	const legacySource = `
import { dirname, join } from "path";
import { readJSON, writeJSON } from "fs-extra";
export async function main(editor) {
	const root = dirname(editor.state.projectPath);
	const current = await readJSON(join(root, ${JSON.stringify(paths.graph)}));
	await writeJSON(join(root, ${JSON.stringify(paths.legacyGraph)}), { version: 1, type: current.type, name: "MCP Legacy Graph", passes: current.passes }, { spaces: "\t" });
	return "legacy graph created";
}`;
	await call("run_agent_script", { name: legacyGraphScript, content: legacySource });
	const migration = await call("get_custom_render_graph_asset_migration", { path: paths.legacyGraph });
	const migrated = await call("migrate_custom_render_graph_asset", {
		path: paths.legacyGraph,
		expectedSourceRevision: migration.sourceRevision,
		backup: false,
	});
	if (!migrated.migrated) throw new Error("Legacy render-graph asset was not migrated.");

	await call("apply_custom_render_graph_asset", { path: paths.graph, expectedRevision: graphAsset.contentRevision });
	await call("set_custom_render_pass", { id: shaderPass.id, ratio: 0.6 });
	graphAsset = await call("update_assigned_custom_render_graph_asset", { expectedRevision: graphAsset.contentRevision, assetName: `MCP Main Graph Updated ${suffix}` });
	await call("detach_custom_render_graph_asset", { id: graphAsset.id, expectedRevision: graphAsset.contentRevision });
	await call("delete_custom_render_graph_asset", { path: paths.graph, expectedRevision: graphAsset.contentRevision, confirm: true });
	graphAsset = undefined;
	await call("delete_custom_render_graph_asset", { path: paths.legacyGraph, expectedRevision: migration.targetRevision, confirm: true });

	featureAsset = await call("save_renderer_feature_asset", { path: paths.feature, assetName: `MCP Grade Feature ${suffix}`, passIds: [shaderPass.id] });
	const featureRead = await call("get_renderer_feature_asset", { path: paths.feature });
	if (featureRead.contentRevision !== featureAsset.contentRevision) throw new Error("Renderer-feature revision does not round-trip.");
	const instantiatedFeature = await call("instantiate_renderer_feature", {
		path: paths.feature,
		expectedRevision: featureAsset.contentRevision,
		instanceName: `MCP Grade Instance ${suffix}`,
		prefix: `mcpGrade_${process.pid}`,
		enabled: true,
	});
	featureInstance = instantiatedFeature.instance;
	featureInstance = (
		await call("set_renderer_feature_instance", { instanceId: featureInstance.id, revision: featureInstance.revision, name: `MCP Grade Active ${suffix}`, order: 5 })
	).instance;
	const refreshedFeature = await call("refresh_renderer_feature_instance", {
		instanceId: featureInstance.id,
		revision: featureInstance.revision,
		expectedAssetRevision: featureAsset.contentRevision,
	});
	featureInstance = refreshedFeature.instance;
	await call("delete_renderer_feature_instance", { instanceId: featureInstance.id, revision: featureInstance.revision, confirm: true });
	featureInstance = undefined;
	await call("delete_renderer_feature_asset", { path: paths.feature, expectedRevision: featureAsset.contentRevision, confirm: true });
	featureAsset = undefined;

	const computePass = await call("create_custom_render_pass", {
		name: `MCP Compute ${suffix}`,
		passType: "compute",
		injectionPoint: "afterRenderingPrePasses",
		output: `mcpCompute_${identifier}`,
		computeSettings: { dispatch: [1, 1, 1], dispatchMode: "once" },
	});
	passIds.add(computePass.id);
	await call("initialize_custom_compute_node_graph", { id: computePass.id, replace: true });
	let computeGraph = await call("get_custom_compute_node_graph", { id: computePass.id });
	await call("set_custom_compute_node_graph", { id: computePass.id, graph: computeGraph.graph, compile: true });
	await call("add_custom_compute_node", { id: computePass.id, node: { id: "mcpColor", type: "constant-color", position: [220, 300], value: [0.2, 0.4, 0.8, 1] } });
	await call("set_custom_compute_node", { id: computePass.id, nodeId: "mcpColor", update: { position: [260, 320], value: [0.3, 0.5, 0.9, 1] } });
	await call("disconnect_custom_compute_nodes", { id: computePass.id, from: "uvColor", to: "output", toPort: "color" });
	await call("connect_custom_compute_nodes", { id: computePass.id, from: "mcpColor", to: "output", toPort: "color" });
	await call("compile_custom_compute_node_graph", { id: computePass.id });
	await call("disconnect_custom_compute_nodes", { id: computePass.id, from: "mcpColor", to: "output", toPort: "color" });
	await call("connect_custom_compute_nodes", { id: computePass.id, from: "uvColor", to: "output", toPort: "color" });
	await call("add_custom_compute_node", {
		id: computePass.id,
		node: { id: "mcpTexture", type: "texture-load", position: [240, 420], resourceName: "sourceTexture" },
	});
	const textureWgsl = `
@group(0) @binding(0) var outputTexture : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var sourceTexture : texture_2d<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
	let size = textureDimensions(outputTexture);
	if (id.x >= size.x || id.y >= size.y) { return; }
	let sourceSize = textureDimensions(sourceTexture);
	let sourcePosition = vec2<i32>(i32(id.x % sourceSize.x), i32(id.y % sourceSize.y));
	textureStore(outputTexture, vec2<i32>(id.xy), textureLoad(sourceTexture, sourcePosition, 0));
}`.trim();
	await call("set_custom_render_pass", {
		id: computePass.id,
		inputs: { sourceTexture: { source: "texture", path: paths.texture, group: 0, binding: 3 } },
		computeSettings: { wgsl: textureWgsl, dispatch: [1, 1, 1], dispatchMode: "once" },
	});
	const texturePreviews = await call("get_custom_compute_texture_node_previews", { id: computePass.id, nodeIds: ["mcpTexture"], width: 32, height: 32, includeImage: false });
	if (!texturePreviews.entries?.some((entry) => entry.status === "ready" && entry.thumbnail?.pixelSha256))
		throw new Error(`Compute texture preview returned no decoded fixture: ${JSON.stringify(texturePreviews)}`);
	await call("delete_custom_compute_node", { id: computePass.id, nodeId: "mcpTexture" });
	const basicWgsl = `
@group(0) @binding(0) var outputTexture : texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
	let size = textureDimensions(outputTexture);
	if (id.x >= size.x || id.y >= size.y) { return; }
	textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(0.25, 0.5, 0.75, 1.0));
}`.trim();
	await call("set_custom_render_pass", { id: computePass.id, inputs: {}, computeSettings: { wgsl: basicWgsl, dispatch: [1, 1, 1], dispatchMode: "once" } });
	await call("preview_custom_compute_node_graph", { id: computePass.id, nodeIds: ["uvColor", "output"], invocationId: [1, 1, 0], outputSize: [4, 4] });
	await call("delete_custom_compute_node", { id: computePass.id, nodeId: "mcpColor" });
	await call("compile_custom_compute_node_graph", { id: computePass.id });

	const bufferWgsl = `
struct Params { tint: vec4<f32>, };
@group(0) @binding(0) var outputTexture : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(1) var<uniform> params : Params;
@group(0) @binding(2) var<storage, read_write> values : array<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
	let size = textureDimensions(outputTexture);
	if (id.x >= size.x || id.y >= size.y) { return; }
	let index = id.x + id.y * size.x;
	if (index < arrayLength(&values)) { values[index] = values[index] + params.tint.x; }
	textureStore(outputTexture, vec2<i32>(id.xy), params.tint);
}`.trim();
	await call("set_custom_render_pass", {
		id: computePass.id,
		computeSettings: {
			wgsl: bufferWgsl,
			dispatch: [1, 1, 1],
			dispatchMode: "once",
			uniformBuffers: [{ name: "params", group: 0, binding: 1, uniforms: [{ name: "tint", type: "vec4", value: [1, 0, 0, 1] }] }],
			storageBuffers: [{ name: "values", group: 0, binding: 2, dataType: "float32", data: [1, 2, 3, 4], access: "readWrite" }],
		},
	});
	await call("set_custom_compute_uniform_buffer_values", { id: computePass.id, bufferName: "params", values: { tint: [0.25, 0.5, 0.75, 1] }, persist: true });
	await call("set_custom_compute_storage_buffer_data", { id: computePass.id, bufferName: "values", data: [9, 8], elementOffset: 1, persist: true });
	const authoredBuffer = await call("read_custom_compute_storage_buffer", { id: computePass.id, bufferName: "values", source: "authored", elementOffset: 0, elementCount: 4 });
	if (!authoredBuffer.data?.includes(9)) throw new Error(`Authored compute storage-buffer update did not round-trip: ${JSON.stringify(authoredBuffer)}`);

	const savedSubgraph = await call("save_custom_compute_subgraph", {
		id: computePass.id,
		path: paths.subgraph,
		assetName: `MCP UV Function ${suffix}`,
		nodeIds: ["uvColor"],
		outputNodeId: "uvColor",
	});
	await call("get_custom_compute_subgraph", { path: paths.subgraph });
	const inserted = await call("insert_custom_compute_subgraph", { id: computePass.id, path: paths.subgraph, prefix: `mcpUv_${process.pid}`, position: [600, 200] });
	subgraphInstance = inserted.instance;
	await call("list_custom_compute_subgraph_instances", { id: computePass.id });
	subgraphInstance = (
		await call("set_custom_compute_subgraph_instance", { id: computePass.id, instanceId: subgraphInstance.id, collapsed: false, position: [650, 260] })
	).instance;
	await call("get_custom_compute_subgraph_diagnostics", { id: computePass.id });
	const refreshedSubgraph = await call("refresh_custom_compute_subgraph_instance", { id: computePass.id, instanceId: subgraphInstance.id, compile: false });
	subgraphInstance = refreshedSubgraph.instance;
	await call("delete_custom_compute_subgraph_instance", { id: computePass.id, instanceId: subgraphInstance.id });
	subgraphInstance = undefined;
	await call("delete_custom_compute_subgraph", { path: savedSubgraph.path });
	const subgraphMigration = await call("get_custom_compute_subgraph_migration", { path: paths.legacySubgraph });
	const migratedSubgraph = await call("migrate_custom_compute_subgraph", { path: paths.legacySubgraph, backup: false });
	if (!migratedSubgraph.migrated || !subgraphMigration.migrationRequired) throw new Error("Legacy compute subgraph was not migrated.");
	await call("delete_custom_compute_subgraph", { path: paths.legacySubgraph });

	await call("set_custom_render_pass_gpu_profiling", { enabled: true, sampleCapacity: 16, includeSamples: false });
	await call("debug_custom_compute_node_graph", { id: computePass.id, includeWgsl: true, invocationId: [0, 0, 0], outputSize: [4, 4] });
	await call("get_custom_compute_node_profile", { id: computePass.id, includeSamples: false });
	await call("set_custom_render_pass_gpu_profiling", { enabled: false });

	await call("delete_custom_render_pass", { id: computePass.id });
	passIds.delete(computePass.id);
	await call("delete_custom_render_pass", { id: shaderPass.id });
	passIds.delete(shaderPass.id);

	console.log(`PASS render-graph completion live scenario (${required.length}/${required.length} tools): ${required.join(", ")}`);
} finally {
	await cleanup().catch((error) => console.error(`Cleanup warning: ${error.message}`));
	child.kill("SIGTERM");
	await new Promise((resolve) => child.once("exit", resolve));
	if (stderr.trim()) console.error(stderr.trim());
}
