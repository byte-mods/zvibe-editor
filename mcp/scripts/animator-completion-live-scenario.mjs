#!/usr/bin/env node
/** Positive end-to-end lifecycle for every previously uncovered Animator MCP tool. */
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
	const failed = Boolean(response.error) || result?.isError === true;
	if (failed) throw new Error(`${name} failed: ${JSON.stringify(response.error ?? result)}`);
	const content = result?.content?.find((entry) => entry.type === "text")?.text;
	return content ? JSON.parse(content) : result;
}

const required = [
	"get_animator_controller_asset_import",
	"import_animator_controller_asset",
	"create_animator_controller",
	"get_animator_controller",
	"get_animator_compiled_graph",
	"get_animator_runtime_debug",
	"get_animator_humanoid_muscle_trace",
	"set_animator_humanoid_muscle_trace",
	"set_animator_runtime_debug",
	"step_animator_runtime_debug",
	"open_animator_runtime_debugger",
	"set_animator_controller",
	"set_animator_subgraph",
	"delete_animator_subgraph",
	"set_animator_sub_state_machine",
	"set_animator_root_motion",
	"set_animator_layer",
	"set_animator_layer_blending",
	"set_animator_synchronized_layer_overrides",
	"set_animator_layer_ik_pass",
	"set_animator_transition",
	"set_animator_entry_transitions",
	"set_animator_entry_state",
	"set_animator_state_avatar_mask",
	"set_animator_state_behaviours",
	"set_animator_layer_state",
	"set_animator_blend_tree",
	"set_animator_state_mask",
	"set_animator_state_graph_position",
	"set_animator_state",
	"set_animator_parameter",
	"set_animator_parameter_definition",
	"set_animator_trigger",
	"reset_animator_trigger",
	"delete_animator_controller",
];
const suffix = `${Date.now()}-${process.pid}`;
const controllerName = `MCP Animator ${suffix}`;
const importedName = `MCP Imported Animator ${suffix}`;
const targetName = `MCP Animator Target ${suffix}`;
const rootTargetName = `MCP Animator Root ${suffix}`;
const idleGroup = `MCP Animator Idle ${suffix}`;
const runGroup = `MCP Animator Run ${suffix}`;
const sprintGroup = `MCP Animator Sprint ${suffix}`;
const assetFolder = `assets/mcp-animator-${suffix}`;
const controllerPath = `${assetFolder}/controller.controller`;
const setupScriptName = `animator-import-setup-${suffix}.js`;
const nodeIds = new Set();
const groupNames = [idleGroup, runGroup, sprintGroup];
const controllerNames = new Set();

async function cleanup() {
	for (const name of [...controllerNames]) {
		await call("delete_animator_controller", { controllerName: name }).catch(() => undefined);
		controllerNames.delete(name);
	}
	for (const name of groupNames) await call("delete_animation_group", { name }).catch(() => undefined);
	for (const nodeId of [...nodeIds].reverse()) await call("delete_node", { nodeId }).catch(() => undefined);
	for (const assetPath of [
		`${controllerPath}.bjsmeta.json`,
		controllerPath,
		assetFolder,
		`agentdata/${setupScriptName}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs")}`,
		`.bjseditor/agent-scripts/${setupScriptName.replace(/\.js$/, ".cjs.map")}`,
	]) {
		await call("delete_asset", { path: assetPath, confirm: true }).catch(() => undefined);
	}
}

try {
	const initialized = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "animator-completion-live", version: "1.0.0" } });
	if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const listed = await rpc("tools/list", {});
	for (const name of required) if (!listed.result?.tools?.some((tool) => tool.name === name)) throw new Error(`${name} is not registered.`);
	const status = await call("get_editor_status");
	if (!status.ready || !status.projectPath) throw new Error("A ready project editor is required for Animator completion testing.");

	const target = await call("create_primitive_mesh", { type: "box", name: targetName, position: [-300, 140, -300], options: { size: 100 } });
	const rootTarget = await call("create_primitive_mesh", { type: "box", name: rootTargetName, position: [-300, 140, -450], options: { size: 50 } });
	nodeIds.add(target.id);
	nodeIds.add(rootTarget.id);
	for (const [name, property, end] of [
		[idleGroup, "position.y", 160],
		[runGroup, "position.x", -200],
		[sprintGroup, "rotation.y", Math.PI],
	]) {
		await call("create_animation", {
			nodeId: target.id,
			name,
			targetProperty: property,
			framesPerSecond: 30,
			keys: [
				{ frame: 0, value: property === "rotation.y" ? 0 : property === "position.x" ? -300 : 140 },
				{ frame: 30, value: end },
			],
		});
	}

	const controller = await call("create_animator_controller", {
		name: controllerName,
		targetNodeId: target.id,
		parameters: { Speed: 0, Ready: true, Fire: false },
		parameterTypes: { Speed: "float", Ready: "bool", Fire: "trigger" },
		states: [
			{ name: "Idle", animationGroup: idleGroup, loop: true, graphPosition: [0, 0] },
			{ name: "Run", animationGroup: runGroup, loop: true, graphPosition: [260, 0] },
			{
				name: "Blend",
				blendTree: {
					parameter: "Speed",
					children: [
						{ animationGroup: idleGroup, threshold: 0 },
						{ animationGroup: runGroup, threshold: 1 },
					],
				},
				graphPosition: [520, 0],
			},
		],
		transitions: [{ from: "Idle", to: "Run", duration: 0.1, conditions: [{ parameter: "Fire", equals: true }] }],
		entryState: "Idle",
		activeState: "Idle",
		layers: [
			{
				name: "Upper",
				weight: 0.5,
				states: [
					{ name: "UpperIdle", animationGroup: idleGroup, loop: true },
					{ name: "UpperRun", animationGroup: runGroup, loop: true },
					{ name: "UpperBlend", animationGroup: sprintGroup, loop: true },
				],
				entryState: "UpperIdle",
				activeState: "UpperIdle",
			},
		],
		playOnCreate: true,
	});
	controllerNames.add(controllerName);
	if (!controller.id || controller.activeState !== "Idle") throw new Error("Animator controller creation evidence is incomplete.");
	const id = { controllerId: controller.id };
	const readback = await call("get_animator_controller", id);
	if (readback.name !== controllerName || readback.states.length !== 3) throw new Error("Animator controller readback is incomplete.");
	const compiled = await call("get_animator_compiled_graph", id);
	if (!compiled.states.some((state) => state.name === "Idle")) throw new Error("Compiled Animator graph is incomplete.");

	await call("set_animator_controller", { ...id, baseIKPass: true, name: controllerName });
	const subgraphResult = await call("set_animator_subgraph", {
		...id,
		name: "Locomotion Subgraph",
		states: [
			{ name: "SubIdle", animationGroup: idleGroup },
			{ name: "SubRun", animationGroup: runGroup },
		],
		transitions: [{ from: "SubIdle", to: "SubRun", conditions: [{ parameter: "Speed", greaterThan: 0.5 }] }],
		entryState: "SubIdle",
	});
	const subgraphId = subgraphResult.subgraph?.id;
	if (!subgraphId) throw new Error("Animator reusable subgraph id is missing.");
	await call("set_animator_sub_state_machine", { ...id, name: "Nested", subgraphId, graphPosition: [120, 220] });
	await call("set_animator_sub_state_machine", { ...id, existingName: "Nested", remove: true });
	await call("set_animator_entry_transitions", { ...id, entryTransitions: [{ to: "Idle", conditions: [{ parameter: "Ready", equals: true }] }] });
	await call("set_animator_entry_state", { ...id, state: "Idle", play: true });
	await call("set_animator_root_motion", { ...id, enabled: true, sourceNodeId: target.id, targetNodeId: rootTarget.id, applyPosition: true, applyRotationY: true });
	await call("set_animator_layer", { ...id, layer: "Upper", weight: 0.75, blendingMode: "additive", referencePose: { normalizedTime: 0 } });
	await call("set_animator_layer_state", { ...id, layer: "Upper", state: "UpperRun" });
	await call("set_animator_layer_blending", {
		...id,
		layer: "Upper",
		blendingMode: "override",
		synchronizedLayer: "$base",
		synchronizedTiming: true,
		synchronizedStateMap: { Idle: "UpperIdle", Run: "UpperRun", Blend: "UpperBlend" },
	});
	await call("set_animator_synchronized_layer_overrides", {
		...id,
		layer: "Upper",
		motionOverrides: { Idle: { animationGroup: sprintGroup } },
		behaviourOverrides: { Idle: [] },
	});
	await call("set_animator_layer_ik_pass", { ...id, layer: "Upper", enabled: true });
	await call("set_animator_transition", { ...id, index: 0, duration: 0.2, interruptionSource: "source", orderedInterruption: true });
	await call("set_animator_state_avatar_mask", { ...id, state: "Idle", avatarMaskId: null });
	await call("set_animator_state_behaviours", { ...id, state: "Idle", behaviours: [] });
	await call("set_animator_blend_tree", {
		...id,
		state: "Blend",
		parameter: "Speed",
		children: [
			{ animationGroup: idleGroup, threshold: 0, timeScale: 1 },
			{ animationGroup: sprintGroup, threshold: 1, timeScale: 1.5 },
		],
	});
	await call("set_animator_state_mask", { ...id, state: "Idle", targetNames: [targetName] });
	await call("set_animator_state_graph_position", { ...id, state: "Idle", position: [40, 60] });
	await call("set_animator_state", { ...id, state: "Blend" });
	await call("set_animator_parameter_definition", { ...id, parameter: "Mode", type: "int", defaultValue: 1 });
	await call("set_animator_parameter", { ...id, parameter: "Speed", value: 0.7 });
	await call("set_animator_trigger", { ...id, parameter: "Fire" });
	await call("reset_animator_trigger", { ...id, parameter: "Fire" });

	let debug = await call("get_animator_runtime_debug", { ...id, includeAllClips: true, historyLimit: 32 });
	await call("set_animator_runtime_debug", {
		...id,
		expectedFingerprint: debug.debugger.fingerprint,
		paused: true,
		breakpoints: [{ id: "idle-run", from: "Idle", to: "Run", enabled: true }],
		clearHistory: true,
	});
	debug = await call("get_animator_runtime_debug", { ...id, historyLimit: 32 });
	const stepped = await call("step_animator_runtime_debug", { ...id, expectedFingerprint: debug.debugger.fingerprint, deltaSeconds: 1 / 60, steps: 2 });
	if (stepped.debugger?.paused !== true) throw new Error("Animator deterministic debug stepping did not remain paused.");
	await call("open_animator_runtime_debugger", id);
	let muscles = await call("get_animator_humanoid_muscle_trace", { ...id, limit: 8 });
	await call("set_animator_humanoid_muscle_trace", { ...id, expectedFingerprint: muscles.fingerprint, clearHistory: true, limit: 8 });

	const controllerYaml = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!91 &9100000
AnimatorController:
  m_Name: ${importedName}
  m_AnimatorParameters: []
  m_AnimatorLayers:
  - m_Name: Base Layer
    m_StateMachine: {fileID: 110700000}
    m_Mask: {fileID: 0}
    m_DefaultWeight: 1
    m_SyncedLayerIndex: -1
--- !u!1107 &110700000
AnimatorStateMachine:
  m_Name: Base Layer
  m_ChildStates:
  - m_State: {fileID: 110200000}
    m_Position: {x: 100, y: 100, z: 0}
  m_ChildStateMachines: []
  m_AnyStateTransitions: []
  m_EntryTransitions: []
  m_StateMachineBehaviours: []
  m_DefaultState: {fileID: 110200000}
--- !u!1102 &110200000
AnimatorState:
  m_Name: ImportedIdle
  m_Speed: 1
  m_Motion: {fileID: 7400000, guid: 11111111111111111111111111111111, type: 2}
  m_Transitions: []
`;
	const setupSource = `
import { dirname, join } from "path";
import { ensureDir, writeFile } from "fs-extra";
export async function main(editor) {
	const directory = join(dirname(editor.state.projectPath), ${JSON.stringify(assetFolder)});
	await ensureDir(directory);
	await writeFile(join(directory, "controller.controller"), ${JSON.stringify(controllerYaml)}, "utf8");
	return "Unity controller fixture created";
}`;
	await call("run_agent_script", { name: setupScriptName, content: setupSource });
	// The fixture is created outside the Assets Browser. Complete its registry/metadata
	// scan before leasing an importer artifact so an asynchronous first scan cannot
	// rotate the asset GUID between apply and controller import in aggregate runs.
	await call("refresh_asset_registry_paths", { paths: [controllerPath] });
	const importer = await call("get_animation_importer_result", { path: controllerPath });
	await call("apply_animation_importer", { path: controllerPath, expectedFingerprint: importer.fingerprint, confirm: true });
	const importPlan = await call("get_animator_controller_asset_import", { path: controllerPath, targetNodeId: target.id });
	const motionBinding = importPlan.motionBindings?.[0]?.key;
	if (!motionBinding || !importPlan.fingerprint) throw new Error("Unity Animator import plan is incomplete.");
	const imported = await call("import_animator_controller_asset", {
		path: controllerPath,
		targetNodeId: target.id,
		expectedFingerprint: importPlan.fingerprint,
		motionBindings: { [motionBinding]: idleGroup },
		controllerName: importedName,
		playOnImport: true,
		confirm: true,
	});
	controllerNames.add(importedName);
	if (!imported.imported || imported.controller?.name !== importedName) throw new Error("Unity Animator controller import evidence is incomplete.");

	await call("delete_animator_subgraph", { ...id, subgraphId, cascade: true });
	await call("delete_animator_controller", id);
	controllerNames.delete(controllerName);
	await call("delete_animator_controller", { controllerName: importedName });
	controllerNames.delete(importedName);
	await cleanup();
	const leftovers = (await call("list_animator_controllers")).controllers?.filter((entry) => entry.name.includes(suffix)) ?? [];
	if (leftovers.length) throw new Error(`Animator cleanup left ${leftovers.length} controller(s).`);
	console.log(
		`[animator-completion-live] PASS — ${required.length}/${required.length} previously uncovered tools, runtime debugging, layered/subgraph state machines, Unity import, and MCP-only cleanup verified.`
	);
} catch (error) {
	await cleanup().catch(() => undefined);
	console.error(`[animator-completion-live] FAIL — ${error.stack ?? error.message}`);
	if (stderr.trim()) console.error(stderr.trim());
	process.exitCode = 1;
} finally {
	child.kill("SIGTERM");
}
