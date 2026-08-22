#!/usr/bin/env node
/** Positive real-editor lifecycle for every previously uncovered Materials MCP tool. */
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

async function call(name, args = {}) {
	const response = await rpc("tools/call", { name, arguments: args });
	const result = response.result;
	if (response.error || result?.isError === true) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

const required = [
	"create_material_preset",
	"apply_material_preset",
	"delete_material_preset",
	"create_material_variant",
	"get_material_variant",
	"rebase_material_variant",
	"clear_material_variant_overrides",
	"set_material_properties",
	"assign_texture_to_material",
	"get_material_lightmap",
	"paint_terrain_layer",
	"apply_shader_graph_template",
	"delete_shader_graph_switch",
	"get_node_material_blackboard",
	"set_node_material_blackboard_values",
	"list_node_material_variants",
	"set_node_material_variant",
	"apply_node_material_variant",
	"delete_node_material_variant",
	"list_node_material_custom_blocks",
	"add_node_material_custom_block",
	"set_node_material_custom_block",
	"delete_node_material_custom_block",
	"get_node_material_code_graph",
	"connect_node_material_blocks",
	"disconnect_node_material_blocks",
	"inspect_node_material_optimization",
	"optimize_node_material_graph",
	"apply_node_material_subgraph",
	"strip_node_material_unused_blocks",
	"set_node_material_inputs",
	"replace_node_material_graph",
	"set_environment_texture",
	"set_diffusion_profile",
	"refresh_subsurface_profile_assignments",
];

const suffix = `${Date.now()}-${process.pid}`;
const folder = `assets/mcp-materials-${suffix}`;
const texturePath = `${folder}/checker.png`;
const splatPath = `${folder}/terrain-splat.png`;
const subgraphPath = `${folder}/completion.shadergraph.json`;
const profilePath = `${folder}/skin.diffusionprofile.json`;
const setupScriptName = `materials-texture-setup-${suffix}.js`;
const presetName = `MCP Preset ${suffix}`;
const shaderVariantName = `MCP Shader Variant ${suffix}`;
const materials = [];
let presetCreated = false;
let profile;

async function cleanup() {
	if (presetCreated) await call("delete_material_preset", { name: presetName }).catch(() => undefined);
	for (const material of [...materials].reverse()) {
		if (material?.id) await call("delete_material", { materialId: material.id }).catch(() => undefined);
	}
	if (profile?.path) {
		const current = await call("get_diffusion_profile", { path: profile.path }).catch(() => undefined);
		if (current?.contentRevision)
			await call("delete_diffusion_profile", { path: profile.path, expectedRevision: current.contentRevision, confirm: true }).catch(() => undefined);
	}
	for (const assetPath of [
		...materials.map((material) => material?.path),
		`${texturePath}.bjsmeta.json`,
		texturePath,
		`${splatPath}.bjsmeta.json`,
		splatPath,
		`${subgraphPath}.bjsmeta.json`,
		subgraphPath,
		`${profilePath}.bjsmeta.json`,
		profilePath,
		folder,
		`agentdata/${setupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
	].filter(Boolean)) {
		await call("delete_asset", { path: assetPath, confirm: true }).catch(() => undefined);
	}
	const environment = await call("get_environment_lighting").catch(() => undefined);
	if (environment?.revision) await call("set_environment_texture", { expectedRevision: environment.revision, iblIntensity: 1, removeSkyboxes: true }).catch(() => undefined);
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "materials-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Materials completion testing.");

	const textureSource = `
import { dirname, join } from "path";
import { ensureDir } from "fs-extra";
import sharp from "sharp";
export async function main(editor) {
	const folder = join(dirname(editor.state.projectPath), ${JSON.stringify(folder)});
	await ensureDir(folder);
	const pixels = Buffer.from([255,64,32,255, 32,128,255,255, 32,128,255,255, 255,64,32,255]);
	await sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(join(folder, "checker.png"));
	return "material texture created";
}`;
	await call("run_agent_script", { name: setupScriptName, content: textureSource });

	const standard = await call("create_material", { type: "standard", name: `MCP Standard ${suffix}`, folder });
	materials.push(standard);
	await call("set_material_properties", { materialId: standard.id, properties: { diffuseColor: [0.2, 0.4, 0.8], alpha: 0.9, specularPower: 32 } });
	const preset = await call("create_material_preset", { materialId: standard.id, name: presetName, properties: { alpha: 0.8 } });
	presetCreated = true;
	if (preset.name !== presetName) throw new Error("Material preset creation evidence is incomplete.");
	await call("set_material_properties", { materialId: standard.id, properties: { alpha: 0.2 } });
	const appliedPreset = await call("apply_material_preset", { materialId: standard.id, name: presetName });
	if (appliedPreset.preset?.properties?.alpha !== 0.8) throw new Error("Material preset application evidence is incomplete.");
	await call("delete_material_preset", { name: presetName });
	presetCreated = false;

	const variant = await call("create_material_variant", { baseMaterialId: standard.id, name: `MCP Standard Variant ${suffix}`, folder, properties: { alpha: 0.7 } });
	materials.push(variant);
	let variantRead = await call("get_material_variant", { materialId: variant.id, paths: ["alpha"] });
	if (!variantRead.fingerprint || !variantRead.overridePaths.includes("alpha")) throw new Error("Material variant readback is incomplete.");
	await call("set_material_properties", { materialId: standard.id, properties: { diffuseColor: [0.6, 0.3, 0.1] } });
	variantRead = await call("get_material_variant", { materialId: variant.id, paths: ["alpha", "diffuseColor"] });
	variantRead = await call("rebase_material_variant", { materialId: variant.id, expectedFingerprint: variantRead.fingerprint, conflictPolicy: "keepVariant" });
	if (!variantRead.rebased) throw new Error("Material variant rebase evidence is incomplete.");
	variantRead = await call("clear_material_variant_overrides", { materialId: variant.id, paths: ["alpha"] });
	if (!variantRead.clearedOverridePaths?.includes("alpha")) throw new Error("Material variant override clearing evidence is incomplete.");

	await call("assign_texture_to_material", { materialId: standard.id, channel: "diffuseTexture", texturePath });
	const lightmap = await call("get_material_lightmap", { materialId: standard.id });
	if (lightmap.materialId !== standard.id) throw new Error("Material lightmap readback is incomplete.");

	const terrain = await call("create_material", { type: "terrain", name: `MCP Terrain ${suffix}`, folder });
	materials.push(terrain);
	const painted = await call("paint_terrain_layer", {
		materialId: terrain.id,
		outputPath: splatPath,
		center: [0.5, 0.5],
		radius: 0.25,
		strength: 0.8,
		layer: 1,
		hardness: 2,
		width: 16,
		height: 16,
	});
	if (!painted.outputPath?.endsWith("terrain-splat.png")) throw new Error("Terrain layer painting evidence is incomplete.");

	const templates = await call("list_shader_graph_templates", { query: "decal", category: "Rendering", offset: 0, limit: 10 });
	const template = templates.templates[0];
	if (!template) throw new Error("No Shader Graph template was available.");
	const node = await call("create_shader_graph_from_template", {
		templateId: template.id,
		expectedCatalogRevision: templates.catalogRevision,
		name: `MCP Node ${suffix}`,
		folder,
	});
	materials.push(node);
	let extensions = await call("get_shader_graph_extensions", { materialId: node.id });
	await call("apply_shader_graph_template", {
		materialId: node.id,
		templateId: template.id,
		expectedCatalogRevision: templates.catalogRevision,
		expectedGraphRevision: extensions.graphRevision,
		confirm: true,
	});

	let graph = await call("get_node_material_graph", { materialId: node.id });
	const input = graph.graph.blocks.find((block) => block.customType === "BABYLON.InputBlock" && block.name === "color");
	if (!input) throw new Error("Template Node Material did not expose the expected color input.");
	await call("set_node_material_blackboard", {
		materialId: node.id,
		parameters: [{ name: "Tint", inputName: "color", label: "Tint", defaultValue: [0.8, 0.8, 0.8, 1], connectorEnabled: true, floatMode: "default" }],
	});
	const blackboard = await call("get_node_material_blackboard", { materialId: node.id });
	if (blackboard.parameters?.[0]?.name !== "Tint") throw new Error("Shader Graph blackboard readback is incomplete.");
	await call("set_node_material_blackboard_values", { materialId: node.id, values: [{ name: "Tint", value: [0.3, 0.6, 0.9, 1] }] });
	await call("set_node_material_variant", { materialId: node.id, name: shaderVariantName, values: [{ name: "Tint", value: [0.9, 0.2, 0.1, 1] }] });
	let shaderVariants = await call("list_node_material_variants", { materialId: node.id });
	if (!shaderVariants.variants?.some((entry) => entry.name === shaderVariantName)) throw new Error("Shader Graph variant readback is incomplete.");
	await call("apply_node_material_variant", { materialId: node.id, name: shaderVariantName });
	await call("delete_node_material_variant", { materialId: node.id, name: shaderVariantName });
	shaderVariants = await call("list_node_material_variants", { materialId: node.id });
	if (shaderVariants.variants?.some((entry) => entry.name === shaderVariantName)) throw new Error("Shader Graph variant deletion evidence is incomplete.");

	extensions = await call("get_shader_graph_extensions", { materialId: node.id });
	const switched = await call("set_shader_graph_switch", {
		materialId: node.id,
		expectedGraphRevision: extensions.graphRevision,
		name: "CompletionSwitch",
		mode: "float",
		valueType: "Float",
		cases: [
			{ label: "Low", match: 0 },
			{ label: "High", match: 1 },
		],
	});
	await call("delete_shader_graph_switch", { materialId: node.id, switchId: switched.switch.id, expectedGraphRevision: switched.graphRevision });

	await call("add_node_material_custom_block", {
		materialId: node.id,
		name: "CompletionPass",
		target: "Fragment",
		functionName: "void completionPass(float value, out float result)",
		code: "void completionPass(float value, out float result) { result = value; }",
		inputs: [{ name: "value", type: "Float" }],
		outputs: [{ name: "result", type: "Float" }],
	});
	let customBlocks = await call("list_node_material_custom_blocks", { materialId: node.id });
	if (!customBlocks.blocks?.some((block) => block.name === "CompletionPass")) throw new Error("Custom Shader Graph block creation evidence is incomplete.");
	await call("set_node_material_custom_block", {
		materialId: node.id,
		name: "CompletionPass",
		functionName: "void completionPass(float value, out float result)",
		code: "void completionPass(float value, out float result) { result = value * 1.0; }",
		target: "Fragment",
	});
	customBlocks = await call("list_node_material_custom_blocks", { materialId: node.id });
	if (!customBlocks.blocks?.some((block) => JSON.stringify(block.code).includes("1.0"))) throw new Error("Custom Shader Graph block update evidence is incomplete.");
	await call("delete_node_material_custom_block", { materialId: node.id, name: "CompletionPass" });

	let codeGraph = await call("get_node_material_code_graph", { materialId: node.id, offset: 0, limit: 256, includeCode: true });
	const edge = codeGraph.edges[0];
	if (!edge) throw new Error("Shader Graph has no edge available for connection lifecycle testing.");
	await call("disconnect_node_material_blocks", {
		materialId: node.id,
		targetBlockId: edge.targetBlockId,
		targetInput: edge.targetInput,
		sourceBlockId: edge.sourceBlockId,
		sourceOutput: edge.sourceOutput,
	});
	await call("connect_node_material_blocks", {
		materialId: node.id,
		sourceBlockId: edge.sourceBlockId,
		sourceOutput: edge.sourceOutput,
		targetBlockId: edge.targetBlockId,
		targetInput: edge.targetInput,
	});

	const optimization = await call("inspect_node_material_optimization", {
		materialId: node.id,
		settings: { stripUnreachable: false, simplifyIdentityMath: false, foldConstants: false, mergeDuplicateConstants: false, minifyCustomCode: false },
	});
	await call("optimize_node_material_graph", {
		materialId: node.id,
		expectedFingerprint: optimization.fingerprint,
		settings: optimization.settings,
		confirm: true,
	});

	await call("save_node_material_subgraph", { materialId: node.id, outputPath: subgraphPath, name: `MCP Completion Subgraph ${suffix}` });
	await call("apply_node_material_subgraph", { materialId: node.id, path: subgraphPath, name: `MCP Applied Subgraph ${suffix}` });
	await call("strip_node_material_unused_blocks", { materialId: node.id });
	await call("set_node_material_inputs", { materialId: node.id, inputs: [{ name: "color", value: [0.4, 0.7, 0.2, 1] }] });
	graph = await call("get_node_material_graph", { materialId: node.id });
	await call("replace_node_material_graph", { materialId: node.id, graph: graph.graph, name: `MCP Replaced Node ${suffix}` });

	let environment = await call("get_environment_lighting");
	const updatedEnvironment = await call("set_environment_texture", { expectedRevision: environment.revision, iblIntensity: 0.75, removeSkyboxes: true });
	if (updatedEnvironment.iblIntensity !== 0.75) throw new Error("Environment lighting mutation evidence is incomplete.");
	environment = await call("get_environment_lighting");
	await call("set_environment_texture", { expectedRevision: environment.revision, iblIntensity: 1, removeSkyboxes: true });

	profile = await call("create_diffusion_profile", {
		path: profilePath,
		name: `MCP Skin ${suffix}`,
		scatteringDistance: [1.2, 0.5, 0.25],
		transmissionTint: [1, 0.4, 0.3],
		thicknessRemap: [0.2, 5],
		worldScale: 1,
		indexOfRefraction: 1.4,
	});
	profile = await call("set_diffusion_profile", {
		path: profile.path,
		expectedRevision: profile.contentRevision,
		scatteringDistance: [1.5, 0.6, 0.3],
		worldScale: 1.25,
	});
	const refreshed = await call("refresh_subsurface_profile_assignments", { path: profile.path, expectedRevision: profile.contentRevision });
	if (refreshed.refreshed !== 0 || refreshed.profile?.contentRevision !== profile.contentRevision) throw new Error("Diffusion profile refresh evidence is incomplete.");

	await cleanup();
	console.log(
		`[materials-completion-live] PASS — ${required.length}/${required.length} previously uncovered tools, material/variant/terrain/Shader Graph/environment/profile lifecycles, and MCP-only cleanup verified.`
	);
} catch (error) {
	await cleanup().catch(() => undefined);
	console.error(`[materials-completion-live] FAIL — ${error.stack ?? error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}
