import { createHash, randomUUID } from "crypto";
import { dirname, join, isAbsolute, basename, relative } from "path/posix";
import { ensureDir, lstat, move, pathExists, readFile, remove, writeFile } from "fs-extra";
import ts from "typescript";

import { Tools, Scene } from "babylonjs";
import { scriptsDictionary } from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs";
import { analyzeSerializationSource } from "../../tools/serialization-diagnostics";
import { listInspectorCollectionStyles } from "../../editor/layout/inspector/fields/collection-style";

import { projectConfiguration } from "../../project/configuration";
import { saveProjectConfiguration } from "../../project/save/save";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

/**
 * Returns the absolute path of the project directory.
 */
function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}

	return dirname(projectConfiguration.path);
}

/**
 * Returns the absolute path of the project "src" directory.
 */
function getSrcDirectory(): string {
	return join(getProjectDirectory(), "src");
}

/**
 * Resolves an absolute path under the project "src" directory.
 * Scripts MUST live under src/**.
 */
function resolveScriptPath(path: string): string {
	const absolute = isAbsolute(path) ? path : join(getProjectDirectory(), path);
	const relativePath = relative(getSrcDirectory(), absolute);

	if (!relativePath || relativePath === ".." || relativePath.startsWith("../") || isAbsolute(relativePath)) {
		throw new Error(`Scripts must live under "src/". Got: ${path}`);
	}

	return absolute;
}

/**
 * Returns the script metadata key (path relative to "src/") for the given absolute path.
 */
function getScriptKey(absolutePath: string): string {
	return relative(getSrcDirectory(), absolutePath).replace(/\\/g, "/");
}

/** Returns the transient Inspector extraction bundle owned by one project script. */
function getScriptInspectorCachePath(absolutePath: string): string {
	return join(getProjectDirectory(), ".bjseditor", "scripts", `${getScriptKey(absolutePath).replace(/\//g, "_")}.cjs`);
}

/** Describes typed list/array decorators, mapper styles, bounds, and the shared MCP value-mutation path. */
export function getInspectorCollectionCapabilities(): any {
	return {
		model: "zvibe-inspector-collections-v1",
		decorators: ["visibleAsArray", "visibleAsList"],
		elementTypes: ["number", "boolean", "string", "vector2", "vector3", "color3", "color4", "entity", "texture", "keymap", "asset"],
		maximumEditorItems: 256,
		features: ["add", "remove", "move", "minimum-size", "maximum-size", "default-item", "indices", "density", "variant", "striping", "icon", "accent-color"],
		styles: listInspectorCollectionStyles(),
		valueMutationTool: "set_script_exported_value",
	};
}

const scriptTemplates: Record<string, { description: string; content: string }> = {
	component: {
		description: "A mesh-bound component with onStart and an animation-ratio-safe rotation update.",
		content: `import { Mesh } from "@babylonjs/core/Meshes/mesh";

export default class MyScriptComponent {
	public constructor(public mesh: Mesh) {}

	public onStart(): void {}

	public onUpdate(): void {
		this.mesh.rotation.y += 0.04 * this.mesh.getScene().getAnimationRatio();
	}
}
`,
	},
	empty: {
		description: "An empty mesh-bound component with lifecycle methods ready for behavior code.",
		content: `import { Mesh } from "@babylonjs/core/Meshes/mesh";

export default class MyScriptComponent {
	public constructor(public mesh: Mesh) {}

	public onStart(): void {}

	public onUpdate(): void {}

	public onStop(): void {}
}
`,
	},
	"animator-behaviour": {
		description: "A target-node component implementing Unity-style Animator state lifecycle and per-layer IK Pass callbacks.",
		content: `import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { IAnimatorIKInfo, IAnimatorStateInfo, IAnimatorStateMachineInfo } from "babylonjs-editor-tools";

export default class AnimatorStateBehaviour {
	public constructor(public mesh: Mesh) {}

	public onAnimatorStateEnter(_object: Mesh, state: IAnimatorStateInfo): void {
		console.log(\`Entered Animator state \${state.stateName}\`);
	}

	public onAnimatorStateUpdate(_object: Mesh, _state: IAnimatorStateInfo): void {}

	public onAnimatorStateExit(_object: Mesh, state: IAnimatorStateInfo): void {
		console.log(\`Exited Animator state \${state.stateName}\`);
	}

	public onAnimatorStateMachineEnter(_object: Mesh, machine: IAnimatorStateMachineInfo): void {
		console.log(\`Entered Animator state machine \${machine.machinePath.join("/") || "$root"}\`);
	}

	public onAnimatorStateMachineExit(_object: Mesh, machine: IAnimatorStateMachineInfo): void {
		console.log(\`Exited Animator state machine \${machine.machinePath.join("/") || "$root"}\`);
	}

	public onAnimatorIK(_object: Mesh, info: IAnimatorIKInfo): void {
		console.log(\`Animator IK Pass for layer \${info.layerName}\`);
	}
}
`,
	},
	"animation-rig-job": {
		description: "A Unity-style custom weighted Animation Rig job registered by project TypeScript and ready for serialized bone/node bindings.",
		content: `import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { IAnimationRigJobContext, registerAnimationRigJob } from "babylonjs-editor-tools";

interface ICopyPositionJobData extends Record<string, unknown> {
	offset: [number, number, number];
}

registerAnimationRigJob<ICopyPositionJobData, { evaluations: number }>({
	id: "project.copy-position",
	displayName: "Copy Position",
	description: "Moves the first bound bone toward the first bound TransformNode with an authored offset.",
	dataVersion: 1,
	setDefaultValues: () => ({ offset: [0, 0, 0] }),
	validate: (context) => (context.bones.length === 1 && context.nodes.length === 1 ? true : "Bind exactly one bone and one TransformNode."),
	create: () => ({ evaluations: 0 }),
	update: (_context, state) => {
		state.evaluations++;
	},
	processRootMotion: (_context, _state) => {},
	processAnimation: (context: IAnimationRigJobContext<ICopyPositionJobData>) => {
		const bone = context.bones[0];
		const target = context.nodes[0];
		if (!bone || !target || !context.mesh) {
			return false;
		}
		const current = bone.getPosition(Space.WORLD, context.mesh);
		const desired = target.getAbsolutePosition().add(Vector3.FromArray(context.data.offset));
		bone.setPosition(Vector3.Lerp(current, desired, context.weight), Space.WORLD, context.mesh);
		return true;
	},
});

// Attach this registration component to one project node so it is included in generated scripts.ts.
export default class MyScriptComponent {
	public constructor(public mesh: Mesh) {}
}
`,
	},
	"grid-brush": {
		description: "A Unity-style project GridBrush registered from TypeScript for Tile Palette map and palette editing.",
		content: `import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { registerGridBrush } from "babylonjs-editor-tools";

interface ICheckerBrushData extends Record<string, unknown> {
	alternateTileIndex: number;
}

registerGridBrush<ICheckerBrushData>({
	id: "project.checker-grid-brush",
	displayName: "Checker GridBrush",
	description: "Alternates the selected frame with a configured palette frame across the brush footprint.",
	dataVersion: 1,
	setDefaultValues: () => ({ alternateTileIndex: 0 }),
	validate: (context) => (Number.isInteger(context.data.alternateTileIndex) && context.data.alternateTileIndex >= 0 ? true : "alternateTileIndex must be a non-negative integer."),
	paint: (context) => {
		const cells = [];
		for (let y = 0; y < context.brushSize[1]; y++) {
			for (let x = 0; x < context.brushSize[0]; x++) {
				cells.push({ offset: [x, y] as [number, number], tileIndex: (x + y) % 2 === 0 ? context.activeTileIndex : context.data.alternateTileIndex });
			}
		}
		return cells;
	},
});

// Attach this registration component to one project node so it is included in generated scripts.ts.
export default class MyScriptComponent {
	public constructor(public mesh: Mesh) {}
}
`,
	},
	"light2d-providers": {
		description: "Project Light2D and ShadowShape2D providers with versioned data, validation, geometry, and shadow lifecycle callbacks.",
		content: `import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { registerLight2DProvider, registerShadowShape2DProvider } from "babylonjs-editor-tools";

interface IPulseLightData extends Record<string, unknown> {
	radius: number;
	pulseAmount: number;
}

registerLight2DProvider<IPulseLightData, { elapsed: number }>({
	id: "project.pulse-light",
	displayName: "Pulse Light",
	description: "A project radial-light provider that animates its radius without changing authored component data.",
	dataVersion: 1,
	setDefaultValues: () => ({ radius: 500, pulseAmount: 50 }),
	validate: (context) =>
		typeof context.data.radius === "number" && context.data.radius > 0 && typeof context.data.pulseAmount === "number" && context.data.pulseAmount >= 0
			? true
			: "radius must be positive and pulseAmount must be non-negative.",
	create: () => ({ elapsed: 0 }),
	getShape: (context, state) => {
		state.elapsed += context.deltaTimeSeconds;
		return { kind: "radial", radius: context.data.radius + Math.sin(state.elapsed * 2) * context.data.pulseAmount };
	},
});

interface IBoxShadowData extends Record<string, unknown> {
	halfWidth: number;
	halfHeight: number;
}

registerShadowShape2DProvider<IBoxShadowData, { enabled: boolean }>({
	id: "project.box-shadow",
	displayName: "Box Shadow",
	description: "A lifecycle-aware project shadow provider that supplies a local-space box.",
	dataVersion: 1,
	setDefaultValues: () => ({ halfWidth: 50, halfHeight: 50 }),
	validate: (context) =>
		typeof context.data.halfWidth === "number" && context.data.halfWidth > 0 && typeof context.data.halfHeight === "number" && context.data.halfHeight > 0
			? true
			: "halfWidth and halfHeight must be positive.",
	create: () => ({ enabled: false }),
	enabled: (_context, _writer, state) => {
		state.enabled = true;
	},
	disabled: (_context, _writer, state) => {
		state.enabled = false;
	},
	onBeforeRender: (context, writer) => {
		const { halfWidth, halfHeight } = context.data;
		writer.setShape([
			[-halfWidth, -halfHeight],
			[halfWidth, -halfHeight],
			[halfWidth, halfHeight],
			[-halfWidth, halfHeight],
		]);
	},
});

// Attach this registration component to one project node so it is included in generated scripts.ts.
export default class MyScriptComponent {
	public constructor(public mesh: Mesh) {}
}
`,
	},
};

function getCustomTemplateDirectory(): string {
	return join(getProjectDirectory(), ".babylon-editor/script-templates");
}

interface ICustomScriptTemplateAsset {
	version: 1;
	description: string;
	content: string;
}

interface ICustomScriptTemplate extends ICustomScriptTemplateAsset {
	id: string;
	path: string;
	fingerprint: string;
	contentBytes: number;
}

const maximumCustomTemplateContentBytes = 256 * 1024;
const maximumCustomTemplateDescriptionLength = 2_048;
const maximumCustomTemplates = 256;

function normalizeCustomTemplateId(value: unknown): string {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
		throw new Error("Template id must contain only letters, numbers, hyphens, or underscores.");
	}
	return id;
}

function customTemplatePathForId(id: string): string {
	return join(getCustomTemplateDirectory(), `${id}.script-template.json`);
}

function customTemplateFingerprint(asset: ICustomScriptTemplateAsset): string {
	return createHash("sha256").update(JSON.stringify(asset)).digest("hex");
}

function normalizeCustomTemplateAsset(value: any): ICustomScriptTemplateAsset {
	if (!value || value.version !== 1 || typeof value.description !== "string" || typeof value.content !== "string" || !value.content.trim()) {
		throw new Error("Custom script template must be a version 1 asset with string description and non-empty content.");
	}
	if (value.description.length > maximumCustomTemplateDescriptionLength) {
		throw new Error(`Custom script template description must be at most ${maximumCustomTemplateDescriptionLength} characters.`);
	}
	if (Buffer.byteLength(value.content, "utf8") > maximumCustomTemplateContentBytes) {
		throw new Error(`Custom script template content must be at most ${maximumCustomTemplateContentBytes} UTF-8 bytes.`);
	}
	return { version: 1, description: value.description, content: value.content };
}

async function readCustomTemplateAsset(path: string, id: string): Promise<ICustomScriptTemplate> {
	if (!(await pathExists(path))) {
		throw new Error(`Custom script template "${id}" does not exist.`);
	}
	const stats = await lstat(path);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new Error(`Custom script template "${id}" must be a regular project file, not a symlink.`);
	}
	if (stats.size > maximumCustomTemplateContentBytes + 16_384) {
		throw new Error(`Custom script template "${id}" asset is too large.`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(`Custom script template "${id}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	const asset = normalizeCustomTemplateAsset(parsed);
	return {
		id,
		...asset,
		path: relative(getProjectDirectory(), path),
		fingerprint: customTemplateFingerprint(asset),
		contentBytes: Buffer.byteLength(asset.content, "utf8"),
	};
}

/** Lists project-local script templates stored as portable JSON assets. */
export async function listCustomScriptTemplates(): Promise<any> {
	const directory = getCustomTemplateDirectory();
	const paths = (await normalizedGlob(join(directory, "/*.script-template.json"), { nodir: true })) as string[];
	if (paths.length > maximumCustomTemplates) {
		throw new Error(`Projects may contain at most ${maximumCustomTemplates} custom script templates.`);
	}
	const templates = (await Promise.all(paths.map((path) => readCustomTemplateAsset(path, basename(path).replace(".script-template.json", ""))))).map((template) => ({
		id: template.id,
		description: template.description,
		path: template.path,
		fingerprint: template.fingerprint,
		contentBytes: template.contentBytes,
	}));
	templates.sort((left, right) => left.id.localeCompare(right.id));
	return { templates };
}

/** Reads exact content and a stale-write fingerprint for one project-local template. */
export async function getCustomScriptTemplate(_scene: Scene, data: any): Promise<any> {
	const id = normalizeCustomTemplateId(data.id);
	return readCustomTemplateAsset(customTemplatePathForId(id), id);
}

/** Creates a template, or replaces an inspected exact fingerprint atomically. */
export async function setCustomScriptTemplate(_scene: Scene, data: any): Promise<any> {
	const id = normalizeCustomTemplateId(data.id);
	if (typeof data.content !== "string" || !data.content.trim()) {
		throw new Error("Template content must be non-empty.");
	}
	if (data.description !== undefined && typeof data.description !== "string") {
		throw new Error("Template description must be a string when provided.");
	}
	const asset = normalizeCustomTemplateAsset({ version: 1, description: data.description?.trim() ?? "", content: data.content });
	const path = customTemplatePathForId(id);
	const exists = await pathExists(path);
	if (exists) {
		const current = await readCustomTemplateAsset(path, id);
		if (typeof data.expectedFingerprint !== "string") {
			throw new Error(`Template "${id}" already exists. Inspect it first and provide expectedFingerprint to replace it.`);
		}
		if (data.expectedFingerprint !== current.fingerprint) {
			throw new Error(`Template "${id}" changed since it was inspected. Read it again before replacing it.`);
		}
	} else if (data.expectedFingerprint !== undefined) {
		throw new Error(`Template "${id}" does not exist, so expectedFingerprint must be omitted when creating it.`);
	}
	await ensureDir(dirname(path));
	const temporaryPath = join(dirname(path), `.${id}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporaryPath, `${JSON.stringify(asset, null, "\t")}\n`, "utf8");
		await move(temporaryPath, path, { overwrite: true });
	} finally {
		if (await pathExists(temporaryPath)) {
			await remove(temporaryPath);
		}
	}
	return { id, path: relative(getProjectDirectory(), path), fingerprint: customTemplateFingerprint(asset), contentBytes: Buffer.byteLength(asset.content, "utf8") };
}

/** Deletes one exact inspected template only after explicit confirmation. */
export async function deleteCustomScriptTemplate(_scene: Scene, data: any): Promise<any> {
	const id = normalizeCustomTemplateId(data.id);
	if (data.confirm !== true) {
		throw new Error("Deleting a custom script template requires confirm: true.");
	}
	if (typeof data.expectedFingerprint !== "string") {
		throw new Error("Deleting a custom script template requires its inspected expectedFingerprint.");
	}
	const path = customTemplatePathForId(id);
	const current = await readCustomTemplateAsset(path, id);
	if (data.expectedFingerprint !== current.fingerprint) {
		throw new Error(`Template "${id}" changed since it was inspected. Read it again before deleting it.`);
	}
	await remove(path);
	return { deleted: true, id, path: current.path, fingerprint: current.fingerprint };
}

/** Lists built-in TypeScript script templates available to editor and MCP authoring. */
export function listScriptTemplates(): any {
	return { templates: Object.entries(scriptTemplates).map(([id, template]) => ({ id, description: template.description })) };
}

/**
 * Lists all the TypeScript scripts under the project "src" directory.
 */
export async function listScripts(): Promise<any> {
	const srcDir = getSrcDirectory();

	const matches = await normalizedGlob(join(srcDir, "/**/*.{ts,tsx}"), {
		nodir: true,
		ignore: ["**/node_modules/**"],
	});

	return {
		scripts: (matches as string[]).map((matchPath) => {
			const path = matchPath.toString();
			return {
				name: basename(path),
				path: relative(getProjectDirectory(), path),
			};
		}),
	};
}

/**
 * Creates a new TypeScript script with the editor's default skeleton under "src/".
 */
export async function createScript(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveScriptPath(data.path);
	await ensureDir(dirname(absolutePath));

	const templateId = data.template ?? "component";
	const selectedTemplatePath = data.templatePath ? resolveProjectTemplatePath(data.templatePath) : null;
	const template = selectedTemplatePath
		? await readCustomTemplateAsset(selectedTemplatePath, basename(selectedTemplatePath).replace(".script-template.json", ""))
		: scriptTemplates[templateId];
	if (!template) {
		throw new Error(`Unknown script template "${templateId}". Use list_script_templates to discover available templates.`);
	}
	let content = template.content;

	if (data.className) {
		content = content.replace("MyScriptComponent", data.className);
	}

	await writeFile(absolutePath, content, { encoding: "utf-8" });

	return { path: relative(getProjectDirectory(), absolutePath) };
}

function resolveProjectTemplatePath(path: string): string {
	const absolute = isAbsolute(path) ? path : join(getProjectDirectory(), path);
	if (dirname(absolute) !== getCustomTemplateDirectory() || !/^[a-zA-Z0-9_-]+\.script-template\.json$/.test(basename(absolute))) {
		throw new Error("Custom templates must be project-local .babylon-editor/script-templates assets.");
	}
	return absolute;
}

/**
 * Reads a script's content.
 */
export async function readScript(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveScriptPath(data.path);

	if (!(await pathExists(absolutePath))) {
		throw new Error(`Script not found: ${data.path}`);
	}

	const content = await readFile(absolutePath, { encoding: "utf-8" });
	return { content };
}

/**
 * Overwrites/updates a script's content.
 */
export async function writeScript(_scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveScriptPath(data.path);
	await ensureDir(dirname(absolutePath));

	await writeFile(absolutePath, data.content ?? "", { encoding: "utf-8" });

	return { path: relative(getProjectDirectory(), absolutePath) };
}

/**
 * Attaches a script file to a node, writing the node script metadata as the inspector does.
 */
export function attachScript(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const absolutePath = resolveScriptPath(data.path);
	const key = getScriptKey(absolutePath);

	node.metadata ??= {};
	node.metadata.scripts ??= [];

	const existing = node.metadata.scripts.find((script: any) => script.key === key);
	if (!existing) {
		node.metadata.scripts.push({
			_id: Tools.RandomId(),
			enabled: true,
			key,
			executionOrder: 0,
		});
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
}

/**
 * Lists the scripts attached to a node and their exported values.
 */
export function listAttachedScripts(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	const scripts = (node.metadata?.scripts ?? []).map((script: any) => ({
		path: join("src", script.key),
		enabled: script.enabled,
		executionOrder: script.executionOrder ?? 0,
		exportedValues: script.values ?? {},
	}));

	return { scripts };
}

/** Sets a deterministic, Unity-style execution order for one script attachment on a node. */
export function setAttachedScriptExecutionOrder(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const key = getScriptKey(resolveScriptPath(data.path));
	const executionOrder = data.executionOrder;
	if (!Number.isInteger(executionOrder) || executionOrder < -32000 || executionOrder > 32000) {
		throw new Error("Script executionOrder must be an integer between -32000 and 32000.");
	}

	const script = node.metadata?.scripts?.find((candidate: any) => candidate.key === key);
	if (!script) {
		throw new Error(`Script "${data.path}" is not attached to node "${node.name}".`);
	}
	script.executionOrder = executionOrder;

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();
	return { ...toNodeSummary(node), path: join("src", key), executionOrder };
}

/** Lists scene-wide execution orders keyed by script path. These override per-attachment order in exported games. */
export function listProjectScriptExecutionOrders(scene: Scene): any {
	return { orders: structuredClone(scene.metadata?.babylonEditorScriptExecutionOrders ?? {}) };
}

/** Sets or clears a scene-wide execution order for one script class/path. */
export function setProjectScriptExecutionOrder(scene: Scene, data: any, options: IMCPActionOptions): any {
	const key = getScriptKey(resolveScriptPath(data.path));
	if (data.executionOrder === null) {
		if (scene.metadata?.babylonEditorScriptExecutionOrders) {
			delete scene.metadata.babylonEditorScriptExecutionOrders[key];
		}
	} else {
		if (!Number.isInteger(data.executionOrder) || data.executionOrder < -32000 || data.executionOrder > 32000) {
			throw new Error("Script executionOrder must be an integer between -32000 and 32000.");
		}
		scene.metadata ??= {};
		scene.metadata.babylonEditorScriptExecutionOrders ??= {};
		scene.metadata.babylonEditorScriptExecutionOrders[key] = data.executionOrder;
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return listProjectScriptExecutionOrders(scene);
}

/** Lists the Unity-style project-wide script execution orders applied to every exported scene. */
export function listProjectWideScriptExecutionOrders(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return { orders: structuredClone(options.editor.state.scriptExecutionOrders ?? {}) };
}

/** Sets or clears a persisted project-wide script execution order without replacing scene-local overrides. */
export async function setProjectWideScriptExecutionOrder(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const key = getScriptKey(resolveScriptPath(data.path));
	const orders = { ...(options.editor.state.scriptExecutionOrders ?? {}) };
	if (data.executionOrder === null) {
		delete orders[key];
	} else {
		if (!Number.isInteger(data.executionOrder) || data.executionOrder < -32000 || data.executionOrder > 32000) {
			throw new Error("Script executionOrder must be an integer between -32000 and 32000.");
		}
		orders[key] = data.executionOrder;
	}
	options.editor.setState({ scriptExecutionOrders: orders });
	await saveProjectConfiguration(options.editor);
	return { orders };
}

/** Returns live lifecycle/error telemetry for behavior scripts currently running on a node. */
export function getScriptRuntimeDiagnostics(scene: Scene, data: any, options?: IMCPActionOptions): any {
	const play = options?.editor.layout.preview?.play;
	const runtimePlay = play?.canPlayScene && play.scene ? play : null;
	const playScene = runtimePlay?.scene ?? null;
	const runtimeScene = playScene ?? scene;
	const node = resolveNode({ scene: runtimeScene, nodeId: data.nodeId, nodeName: data.nodeName });
	// The editor preview and exported runtime use compatible Babylon node instances from separate package entry points.
	const scripts = runtimePlay ? runtimePlay.getScriptRuntimeRegistrations(node) : (scriptsDictionary.get(node as any) ?? []);
	return {
		target: playScene ? "play" : "editor",
		node: toNodeSummary(node),
		scripts: scripts.map((script) => ({
			path: script.key === "runtime" ? null : join("src", script.key),
			key: script.key,
			diagnostics: structuredClone(script.diagnostics),
		})),
	};
}

/**
 * Sets an exported/inspector value of an attached script on a node.
 */
export function setScriptExportedValue(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const absolutePath = resolveScriptPath(data.path);
	const key = getScriptKey(absolutePath);

	const script = node.metadata?.scripts?.find((s: any) => s.key === key);
	if (!script) {
		throw new Error(`Script "${data.path}" is not attached to node "${node.name}".`);
	}

	script.values ??= {};
	if (script.values[data.key] && typeof script.values[data.key] === "object" && "value" in script.values[data.key]) {
		// Preserve the existing exported value descriptor shape ({ type, description, value }).
		script.values[data.key].value = data.value;
	} else {
		script.values[data.key] = { value: data.value };
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
}

/**
 * Removes an attached script from a node.
 */
export function detachScript(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	const absolutePath = resolveScriptPath(data.path);
	const key = getScriptKey(absolutePath);

	if (node.metadata?.scripts) {
		const index = node.metadata.scripts.findIndex((s: any) => s.key === key);
		if (index !== -1) {
			node.metadata.scripts.splice(index, 1);
		}
	}

	options.editor.layout.inspector.setEditedObject(node);
	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(node);
}

export async function renameScript(_scene: Scene, data: any): Promise<any> {
	const source = resolveScriptPath(data.sourcePath);
	const destination = resolveScriptPath(data.destinationPath);
	if (!(await pathExists(source))) {
		throw new Error(`Script not found: ${data.sourcePath}`);
	}
	if (await pathExists(destination)) {
		throw new Error(`A script already exists at ${data.destinationPath}`);
	}
	await remove(getScriptInspectorCachePath(source));
	await remove(getScriptInspectorCachePath(destination));
	await ensureDir(dirname(destination));
	await move(source, destination);
	return { renamed: true, sourcePath: relative(getProjectDirectory(), source), destinationPath: relative(getProjectDirectory(), destination) };
}

export async function deleteScript(_scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a script is destructive. Retry with confirm: true.");
	}
	const path = resolveScriptPath(data.path);
	if (!(await pathExists(path))) {
		throw new Error(`Script not found: ${data.path}`);
	}
	await remove(path);
	await remove(`${path}.bjsmeta.json`);
	await remove(getScriptInspectorCachePath(path));
	return { deleted: true, path: relative(getProjectDirectory(), path) };
}

export async function validateScript(_scene: Scene, data: any): Promise<any> {
	const path = resolveScriptPath(data.path);
	const content = await readFile(path, { encoding: "utf-8" });
	const serializationDiagnostics = analyzeSerializationSource(content, relative(getProjectDirectory(), path));
	const result = ts.transpileModule(content, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true },
		reportDiagnostics: true,
		fileName: path,
	});
	return {
		valid:
			!(result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? false) &&
			!serializationDiagnostics.some((diagnostic) => diagnostic.category === "error"),
		diagnostics: [
			...(result.diagnostics ?? []).map((diagnostic) => ({
				category: ts.DiagnosticCategory[diagnostic.category],
				code: diagnostic.code,
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
				start: diagnostic.start,
				length: diagnostic.length,
			})),
			...serializationDiagnostics.map((diagnostic) => ({
				category: diagnostic.category === "error" ? "Error" : "Warning",
				code: diagnostic.code,
				message: diagnostic.message,
				start: null,
				length: diagnostic.length,
				line: diagnostic.line,
				column: diagnostic.column,
				path: diagnostic.path,
			})),
		],
	};
}

/** Type-checks one script with TypeScript and returns semantic diagnostics with source locations. */
export async function getScriptSemanticDiagnostics(_scene: Scene, data: any): Promise<any> {
	const path = resolveScriptPath(data.path);
	if (!(await pathExists(path))) {
		throw new Error(`Script not found: ${data.path}`);
	}
	const program = ts.createProgram([path], {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
		experimentalDecorators: true,
		noEmit: true,
		skipLibCheck: true,
	});
	const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
	const serializationDiagnostics = analyzeSerializationSource(await readFile(path, "utf-8"), relative(getProjectDirectory(), path));
	return {
		valid:
			!diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) &&
			!serializationDiagnostics.some((diagnostic) => diagnostic.category === "error"),
		diagnostics: [
			...diagnostics.map((diagnostic) => {
				const position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
				return {
					category: ts.DiagnosticCategory[diagnostic.category],
					code: diagnostic.code,
					message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
					path: diagnostic.file ? relative(getProjectDirectory(), diagnostic.file.fileName) : null,
					line: position ? position.line + 1 : null,
					column: position ? position.character + 1 : null,
				};
			}),
			...serializationDiagnostics.map((diagnostic) => ({
				category: diagnostic.category === "error" ? "Error" : "Warning",
				code: diagnostic.code,
				message: diagnostic.message,
				path: diagnostic.path,
				line: diagnostic.line,
				column: diagnostic.column,
			})),
		],
	};
}

/** Type-checks every project behavior script and returns grouped semantic diagnostics. */
export async function getProjectScriptSemanticDiagnostics(_scene: Scene): Promise<any> {
	const files = (await normalizedGlob(join(getSrcDirectory(), "/**/*.{ts,tsx}"), { nodir: true, ignore: ["**/node_modules/**"] })) as string[];
	const program = ts.createProgram(files, {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.NodeJs,
		experimentalDecorators: true,
		noEmit: true,
		skipLibCheck: true,
	});
	const diagnostics: Array<{ category: string; code: number | string; message: string; path: string | null; line: number | null; column: number | null }> = [
		...program.getSyntacticDiagnostics(),
		...program.getSemanticDiagnostics(),
	].map((diagnostic) => {
		const position = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
		return {
			category: ts.DiagnosticCategory[diagnostic.category],
			code: diagnostic.code,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			path: diagnostic.file ? relative(getProjectDirectory(), diagnostic.file.fileName) : null,
			line: position ? position.line + 1 : null,
			column: position ? position.character + 1 : null,
		};
	});
	for (const file of files) {
		const path = relative(getProjectDirectory(), file).replace(/\\/g, "/");
		diagnostics.push(
			...analyzeSerializationSource(await readFile(file, "utf-8"), path).map((diagnostic) => ({
				category: diagnostic.category === "error" ? "Error" : "Warning",
				code: diagnostic.code,
				message: diagnostic.message,
				path: diagnostic.path,
				line: diagnostic.line,
				column: diagnostic.column,
			}))
		);
	}
	return { valid: !diagnostics.some((diagnostic) => diagnostic.category === "Error"), filesChecked: files.map((file) => relative(getProjectDirectory(), file)), diagnostics };
}

export async function getScriptExportedFields(_scene: Scene, data: any): Promise<any> {
	const path = resolveScriptPath(data.path);
	const content = await readFile(path, { encoding: "utf-8" });
	const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
	const fields: any[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isPropertyDeclaration(node)) {
			const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined;
			const visibleDecorator = decorators?.find((decorator) => /^@visible(?:InInspector|As[A-Za-z0-9_]*)\b/.test(decorator.getText(sourceFile)));
			if (visibleDecorator) {
				fields.push({
					name: node.name.getText(sourceFile),
					type: node.type?.getText(sourceFile) ?? null,
					initializer: node.initializer?.getText(sourceFile) ?? null,
					decorator: visibleDecorator.getText(sourceFile).slice(1, 2049),
				});
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { fields };
}
