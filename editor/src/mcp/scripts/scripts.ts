import { dirname, join, isAbsolute, basename, relative } from "path/posix";
import { ensureDir, move, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import ts from "typescript";

import { Tools, Scene } from "babylonjs";
import { scriptsDictionary } from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs";

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

	const srcDir = join(getSrcDirectory(), "/");
	if (!join(absolute, "/").startsWith(srcDir) && !absolute.startsWith(srcDir.slice(0, -1))) {
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
import { IAnimatorIKInfo, IAnimatorStateInfo } from "babylonjs-editor-tools";

export default class AnimatorStateBehaviour {
	public constructor(public mesh: Mesh) {}

	public onAnimatorStateEnter(_object: Mesh, state: IAnimatorStateInfo): void {
		console.log(\`Entered Animator state \${state.stateName}\`);
	}

	public onAnimatorStateUpdate(_object: Mesh, _state: IAnimatorStateInfo): void {}

	public onAnimatorStateExit(_object: Mesh, state: IAnimatorStateInfo): void {
		console.log(\`Exited Animator state \${state.stateName}\`);
	}

	public onAnimatorIK(_object: Mesh, info: IAnimatorIKInfo): void {
		console.log(\`Animator IK Pass for layer \${info.layerName}\`);
	}
}
`,
	},
};

function getCustomTemplateDirectory(): string {
	return join(getProjectDirectory(), ".babylon-editor/script-templates");
}

/** Lists project-local script templates stored as portable JSON assets. */
export async function listCustomScriptTemplates(): Promise<any> {
	const directory = getCustomTemplateDirectory();
	const paths = (await normalizedGlob(join(directory, "/*.script-template.json"), { nodir: true })) as string[];
	const templates = await Promise.all(
		paths.map(async (path) => {
			const template = await readJSON(path);
			return { id: basename(path).replace(".script-template.json", ""), description: template.description ?? "", path: relative(getProjectDirectory(), path) };
		})
	);
	return { templates };
}

/** Creates or replaces a project-local reusable TypeScript script template. */
export async function setCustomScriptTemplate(_scene: Scene, data: any): Promise<any> {
	const id = data.id?.trim();
	if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
		throw new Error("Template id must contain only letters, numbers, hyphens, or underscores.");
	}
	if (typeof data.content !== "string" || !data.content.trim()) {
		throw new Error("Template content must be non-empty.");
	}
	const path = join(getCustomTemplateDirectory(), `${id}.script-template.json`);
	await ensureDir(dirname(path));
	await writeJSON(path, { version: 1, description: data.description?.trim() ?? "", content: data.content }, { spaces: "\t" });
	return { id, path: relative(getProjectDirectory(), path) };
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
	const customTemplatePath = data.templatePath ? resolveProjectTemplatePath(data.templatePath) : null;
	const template = customTemplatePath ? await readJSON(customTemplatePath) : scriptTemplates[templateId];
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
	if (!absolute.startsWith(`${getCustomTemplateDirectory()}/`)) {
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
export function getScriptRuntimeDiagnostics(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	// The editor preview and exported runtime use compatible Babylon node instances from separate package entry points.
	const scripts = scriptsDictionary.get(node as any) ?? [];
	return {
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
	return { deleted: true, path: relative(getProjectDirectory(), path) };
}

export async function validateScript(_scene: Scene, data: any): Promise<any> {
	const path = resolveScriptPath(data.path);
	const content = await readFile(path, { encoding: "utf-8" });
	const result = ts.transpileModule(content, {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, experimentalDecorators: true },
		reportDiagnostics: true,
		fileName: path,
	});
	return {
		valid: !(result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? false),
		diagnostics: (result.diagnostics ?? []).map((diagnostic) => ({
			category: ts.DiagnosticCategory[diagnostic.category],
			code: diagnostic.code,
			message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			start: diagnostic.start,
			length: diagnostic.length,
		})),
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
	return {
		valid: !diagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
		diagnostics: diagnostics.map((diagnostic) => {
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
	const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map((diagnostic) => {
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
			if (decorators?.some((decorator) => decorator.getText(sourceFile).includes("visibleInInspector"))) {
				fields.push({ name: node.name.getText(sourceFile), type: node.type?.getText(sourceFile) ?? null, initializer: node.initializer?.getText(sourceFile) ?? null });
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(sourceFile);
	return { fields };
}
