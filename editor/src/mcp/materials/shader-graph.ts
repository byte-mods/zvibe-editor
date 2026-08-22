import { createHash, randomUUID } from "crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";

import { CustomBlock, NodeMaterial, NodeMaterialBlockConnectionPointTypes, Scene } from "babylonjs";

import { projectConfiguration } from "../../project/configuration";
import { addNodeMaterial } from "../../project/add/material";
import { findAvailableFilename } from "../../tools/fs";
import { isNodeMaterial } from "../../tools/guards/material";

import { IMCPActionOptions } from "../action";
import { resolveMaterial } from "../tools/resolve";

import { setNodeMaterialCustomBlock } from "./node-material-code";

type ShaderGraphTemplateTarget = "surface" | "decal-projector" | "fullscreen" | "procedural-texture";
type ShaderGraphSwitchMode = "float" | "enum";
type ShaderGraphValueType = "Float" | "Vector2" | "Vector3" | "Vector4" | "Color3" | "Color4" | "Matrix";
type ShaderGraphReflectedTarget = "Vertex" | "Fragment" | "VertexAndFragment";

interface IShaderGraphTemplate {
	id: string;
	name: string;
	category: "Surface" | "Rendering" | "Procedural";
	target: ShaderGraphTemplateTarget;
	description: string;
	tags: string[];
	portableEquivalent: string;
}

interface IShaderGraphSwitchCase {
	label: string;
	match: number;
}

interface IShaderGraphSwitchMetadata {
	version: 1;
	id: string;
	name: string;
	blockName: string;
	mode: ShaderGraphSwitchMode;
	valueType: ShaderGraphValueType;
	target: ShaderGraphReflectedTarget;
	cases: IShaderGraphSwitchCase[];
}

interface IShaderGraphReflectedParameter {
	name: string;
	glslType: "float" | "vec2" | "vec3" | "vec4" | "mat4";
	direction: "in" | "out" | "inout";
	portType: ShaderGraphValueType;
}

interface IShaderGraphReflectedFunction {
	name: string;
	returnType: "void" | "float" | "vec2" | "vec3" | "vec4" | "mat4";
	parameters: IShaderGraphReflectedParameter[];
	source: string;
}

interface IShaderGraphReflectedFunctionMetadata {
	version: 1;
	id: string;
	blockName: string;
	functionName: string;
	sourcePath: string;
	sourceRevision: string;
	target: ShaderGraphReflectedTarget;
}

const maximumShaderSourceBytes = 256 * 1024;
const maximumSwitchCases = 16;
const exactSha256Pattern = /^[0-9a-f]{64}$/;
const safeIdentifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reflectedSourceExtensions = [".fx", ".frag", ".glsl", ".vert"];
const glslTypeToPortType = {
	float: "Float",
	vec2: "Vector2",
	vec3: "Vector3",
	vec4: "Vector4",
	mat4: "Matrix",
} as const;
const portTypeToGlslType: Record<ShaderGraphValueType, string> = {
	Float: "float",
	Vector2: "vec2",
	Vector3: "vec3",
	Vector4: "vec4",
	Color3: "vec3",
	Color4: "vec4",
	Matrix: "mat4",
};

const shaderGraphTemplates: readonly IShaderGraphTemplate[] = [
	{
		id: "surface-unlit",
		name: "Unlit Surface",
		category: "Surface",
		target: "surface",
		description: "A compact color-driven surface graph for unlit and stylized materials.",
		tags: ["surface", "unlit", "color", "starter"],
		portableEquivalent: "Babylon NodeMaterial material-mode graph",
	},
	{
		id: "urp-decal-projector-portable",
		name: "Decal Projector (Portable)",
		category: "Rendering",
		target: "decal-projector",
		description: "A surface graph tagged for the editor decal-projector workflow.",
		tags: ["decal", "projector", "urp", "renderer-feature"],
		portableEquivalent: "Babylon NodeMaterial assigned through the editor decal workflow",
	},
	{
		id: "urp-fullscreen-renderer-portable",
		name: "Fullscreen Renderer (Portable)",
		category: "Rendering",
		target: "fullscreen",
		description: "A post-process Node Material starter for fullscreen renderer features.",
		tags: ["fullscreen", "post-process", "urp", "renderer-feature"],
		portableEquivalent: "Babylon NodeMaterial post-process mode",
	},
	{
		id: "procedural-texture",
		name: "Procedural Texture",
		category: "Procedural",
		target: "procedural-texture",
		description: "A procedural-texture Node Material starter for generated masks and textures.",
		tags: ["procedural", "texture", "mask", "generator"],
		portableEquivalent: "Babylon NodeMaterial procedural-texture mode",
	},
] as const;

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonical(child)])
		);
	}
	return value;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export const shaderGraphTemplateCatalogRevision = sha256(JSON.stringify(canonical(shaderGraphTemplates)));

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function resolveNodeMaterial(scene: Scene, materialId: string): NodeMaterial {
	const material = resolveMaterial({ scene, materialId });
	if (!isNodeMaterial(material)) {
		throw new Error(`Material "${material.name}" is not a Node Material.`);
	}
	return material;
}

function shaderGraphRevision(material: NodeMaterial): string {
	return sha256(JSON.stringify(canonical(material.serialize())));
}

function requireGraphRevision(material: NodeMaterial, expectedRevision: unknown): void {
	if (typeof expectedRevision !== "string" || !exactSha256Pattern.test(expectedRevision)) {
		throw new Error("expectedGraphRevision must be an exact lowercase SHA-256 revision.");
	}
	if (shaderGraphRevision(material) !== expectedRevision) {
		throw new Error("Shader Graph changed after inspection; inspect it again before mutating it.");
	}
}

function resolveTemplate(templateId: unknown): IShaderGraphTemplate {
	const template = shaderGraphTemplates.find((candidate) => candidate.id === templateId);
	if (!template) {
		throw new Error(`Shader Graph template was not found: ${String(templateId)}.`);
	}
	return template;
}

function initializeTemplate(material: NodeMaterial, template: IShaderGraphTemplate): void {
	switch (template.target) {
		case "fullscreen":
			material.setToDefaultPostProcess();
			break;
		case "procedural-texture":
			material.setToDefaultProceduralTexture();
			break;
		default:
			material.setToDefault();
			break;
	}
	material.metadata ??= {};
	material.metadata.babylonEditorShaderGraphTemplate = {
		version: 1,
		id: template.id,
		target: template.target,
		catalogRevision: shaderGraphTemplateCatalogRevision,
		portableEquivalent: template.portableEquivalent,
	};
}

async function resolveWritableProjectDirectory(path: string): Promise<string> {
	if (!path || path.length > 1024 || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
		throw new Error("Shader Graph output folders must be non-empty project-relative POSIX paths.");
	}
	const normalized = normalize(path);
	if (normalized === ".." || normalized.startsWith("../")) {
		throw new Error("Shader Graph output folders must stay inside the open project.");
	}
	const root = projectDirectory();
	const realRoot = await realpath(root);
	let output = root;
	for (const segment of normalized.split("/").filter((entry) => entry && entry !== ".")) {
		output = join(output, segment);
		let details = await lstat(output).catch((error: any) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
		if (!details) {
			await mkdir(output).catch((error: any) => {
				if (error?.code !== "EEXIST") {
					throw error;
				}
			});
			details = await lstat(output);
		}
		if (details.isSymbolicLink() || !details.isDirectory()) {
			throw new Error("Shader Graph output folders must contain only regular project directories.");
		}
		const canonical = await realpath(output);
		if (canonical !== realRoot && !canonical.startsWith(`${realRoot}/`)) {
			throw new Error("Shader Graph output folders cannot escape the open project through symbolic links.");
		}
	}
	return output;
}

async function persistNodeMaterial(material: NodeMaterial, folderPath: string): Promise<string> {
	const folder = await resolveWritableProjectDirectory(folderPath);
	const filename = await findAvailableFilename(folder, material.name, ".material");
	const path = join(folder, filename);
	material.metadata ??= {};
	material.metadata.babylonEditorShaderGraphAssetPath = relative(projectDirectory(), path);
	await writeFile(path, `${JSON.stringify(material.serialize(), null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
	return relative(projectDirectory(), path);
}

async function resolveExistingProjectFile(pathValue: string, extension: string, maximumBytes: number): Promise<{ path: string; absolutePath: string }> {
	if (!pathValue || pathValue.length > 1024 || isAbsolute(pathValue) || pathValue.includes("\\") || pathValue.includes("\0")) {
		throw new Error("Shader Graph asset paths must be project-relative POSIX paths.");
	}
	const path = normalize(pathValue);
	if (path === ".." || path.startsWith("../") || !path.toLowerCase().endsWith(extension)) {
		throw new Error(`Shader Graph asset paths must stay inside the project and use ${extension}.`);
	}
	const root = projectDirectory();
	const absolutePath = join(root, path);
	const [realRoot, realAsset, details] = await Promise.all([realpath(root), realpath(absolutePath), lstat(absolutePath)]);
	if (details.isSymbolicLink() || !details.isFile() || details.size > maximumBytes || (realAsset !== realRoot && !realAsset.startsWith(`${realRoot}/`))) {
		throw new Error("Shader Graph assets must be bounded regular non-symlink project files.");
	}
	return { path, absolutePath };
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, "\t")}\n`, { encoding: "utf-8", flag: "wx" });
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function switchMetadata(material: NodeMaterial, create = true): IShaderGraphSwitchMetadata[] {
	if (!create) {
		return material.metadata?.babylonEditorShaderGraphSwitches ?? [];
	}
	material.metadata ??= {};
	return (material.metadata.babylonEditorShaderGraphSwitches ??= []);
}

function reflectedMetadata(material: NodeMaterial, create = true): IShaderGraphReflectedFunctionMetadata[] {
	if (!create) {
		return material.metadata?.babylonEditorShaderGraphReflectedFunctions ?? [];
	}
	material.metadata ??= {};
	return (material.metadata.babylonEditorShaderGraphReflectedFunctions ??= []);
}

function refreshMaterial(material: NodeMaterial, options: IMCPActionOptions): void {
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
}

function validateSwitchCases(value: unknown): IShaderGraphSwitchCase[] {
	if (!Array.isArray(value) || value.length < 2 || value.length > maximumSwitchCases) {
		throw new Error(`Shader Graph Switch nodes require 2-${maximumSwitchCases} cases.`);
	}
	const cases = value.map((candidate: any, index) => {
		if (!candidate || typeof candidate.label !== "string" || !candidate.label.trim() || candidate.label.length > 64 || !Number.isFinite(candidate.match)) {
			throw new Error(`Shader Graph Switch case ${index} requires a finite match and a 1-64 character label.`);
		}
		return { label: candidate.label.trim(), match: candidate.match };
	});
	if (new Set(cases.map((candidate) => candidate.match)).size !== cases.length) {
		throw new Error("Shader Graph Switch case match values must be unique.");
	}
	return cases;
}

function switchBlockOptions(metadata: IShaderGraphSwitchMetadata): Record<string, unknown> {
	const functionIdentifier = `zvibeSwitch_${metadata.id.replace(/-/g, "")}`;
	const glslType = portTypeToGlslType[metadata.valueType];
	const caseParameters = metadata.cases.map((_candidate, index) => `${glslType} case${index}`);
	const inParameters = [
		{ name: "selector", type: "Float" },
		...metadata.cases.map((_candidate, index) => ({ name: `case${index}`, type: metadata.valueType })),
		{ name: "fallback", type: metadata.valueType },
	];
	const comparisons = metadata.cases.map((candidate, index) => {
		const match = Number(candidate.match).toString();
		const predicate = metadata.mode === "enum" ? `int(floor(selector + 0.5)) == int(${match})` : `abs(selector - ${match}) <= 0.00001`;
		return `\tif (${predicate}) { result = case${index}; return; }`;
	});
	const code = [
		`void ${functionIdentifier}(float selector, ${caseParameters.join(", ")}, ${glslType} fallback, out ${glslType} result) {`,
		...comparisons,
		"\tresult = fallback;",
		"}",
	];
	return {
		name: metadata.blockName,
		target: metadata.target,
		functionName: functionIdentifier,
		code,
		inParameters,
		outParameters: [{ name: "result", type: metadata.valueType }],
	};
}

function disconnectAndRemoveCustomBlock(material: NodeMaterial, blockName: string): void {
	const index = material.attachedBlocks.findIndex((block) => block.getClassName() === "CustomBlock" && block.name === blockName);
	if (index < 0) {
		throw new Error(`Shader Graph extension block was not found: ${blockName}.`);
	}
	const block = material.attachedBlocks[index];
	for (const input of block.inputs) {
		if (input.connectedPoint) {
			input.connectedPoint.disconnectFrom(input);
		}
	}
	for (const output of block.outputs) {
		for (const endpoint of [...output.endpoints]) {
			output.disconnectFrom(endpoint);
		}
	}
	material.attachedBlocks.splice(index, 1);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskShaderComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\r\n]/g, " ")).replace(/\/\/[^\r\n]*/g, (match) => " ".repeat(match.length));
}

function findFunctionEnd(source: string, bodyStart: number): number {
	let depth = 0;
	let quote: string | null = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	for (let index = bodyStart; index < source.length; index++) {
		const character = source[index];
		const next = source[index + 1];
		if (lineComment) {
			if (character === "\n" || character === "\r") {
				lineComment = false;
			}
			continue;
		}
		if (blockComment) {
			if (character === "*" && next === "/") {
				blockComment = false;
				index++;
			}
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (character === "\\") {
				escaped = true;
			} else if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === "/" && next === "/") {
			lineComment = true;
			index++;
		} else if (character === "/" && next === "*") {
			blockComment = true;
			index++;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === "{") {
			depth++;
		} else if (character === "}") {
			depth--;
			if (depth === 0) {
				return index + 1;
			}
		}
	}
	throw new Error("Reflected GLSL function has an unbalanced body.");
}

function parseReflectedFunction(source: string, functionName: string): IShaderGraphReflectedFunction {
	if (!safeIdentifierPattern.test(functionName)) {
		throw new Error("Reflected functionName must be a GLSL-safe identifier.");
	}
	const expression = new RegExp(`\\b(void|float|vec2|vec3|vec4|mat4)\\s+${escapeRegExp(functionName)}\\s*\\(([^)]*)\\)\\s*\\{`, "g");
	const matches = [...maskShaderComments(source).matchAll(expression)];
	if (matches.length !== 1 || matches[0].index === undefined) {
		throw new Error(matches.length ? `Reflected GLSL function "${functionName}" is overloaded.` : `Reflected GLSL function was not found: ${functionName}.`);
	}
	const match = matches[0];
	const returnType = match[1] as IShaderGraphReflectedFunction["returnType"];
	const rawParameters = match[2].trim();
	const parameters: IShaderGraphReflectedParameter[] = rawParameters
		? rawParameters.split(",").map((raw, index) => {
				const normalized = raw.trim().replace(/^const\s+/, "");
				const parameterMatch = /^(?:(in|out|inout)\s+)?(float|vec2|vec3|vec4|mat4)\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(normalized);
				if (!parameterMatch) {
					throw new Error(`Reflected GLSL parameter ${index} is unsupported: ${raw.trim()}.`);
				}
				return {
					name: parameterMatch[3],
					glslType: parameterMatch[2] as IShaderGraphReflectedParameter["glslType"],
					direction: (parameterMatch[1] ?? "in") as IShaderGraphReflectedParameter["direction"],
					portType: glslTypeToPortType[parameterMatch[2] as keyof typeof glslTypeToPortType],
				};
			})
		: [];
	if (new Set(parameters.map((parameter) => parameter.name)).size !== parameters.length) {
		throw new Error("Reflected GLSL parameter names must be unique.");
	}
	if (parameters.some((parameter) => parameter.direction === "inout")) {
		throw new Error("Initial reflected-function support rejects inout parameters; split them into explicit in and out parameters.");
	}
	if (returnType === "void" && !parameters.some((parameter) => parameter.direction === "out")) {
		throw new Error("Reflected void functions require at least one out parameter.");
	}
	const bodyStart = source.indexOf("{", match.index);
	const sourceEnd = findFunctionEnd(source, bodyStart);
	return { name: functionName, returnType, parameters, source: source.slice(match.index, sourceEnd) };
}

async function readProjectShaderSource(sourcePath: string): Promise<{ path: string; source: string; revision: string }> {
	if (!sourcePath || sourcePath.length > 1024 || isAbsolute(sourcePath) || sourcePath.includes("\\") || sourcePath.includes("\0")) {
		throw new Error("Reflected shader sourcePath must be a project-relative POSIX path.");
	}
	const normalized = normalize(sourcePath);
	if (normalized === ".." || normalized.startsWith("../") || !reflectedSourceExtensions.some((extension) => normalized.toLowerCase().endsWith(extension))) {
		throw new Error(`Reflected shader sources must stay inside the project and use ${reflectedSourceExtensions.join(", ")}.`);
	}
	const root = projectDirectory();
	const path = join(root, normalized);
	const [realRoot, realSource, details] = await Promise.all([realpath(root), realpath(path), lstat(path)]);
	if (details.isSymbolicLink() || !details.isFile() || (realSource !== realRoot && !realSource.startsWith(`${realRoot}/`))) {
		throw new Error("Reflected shader sources must be regular non-symlink project files.");
	}
	if (details.size > maximumShaderSourceBytes) {
		throw new Error(`Reflected shader sources cannot exceed ${maximumShaderSourceBytes} bytes.`);
	}
	const bytes = await readFile(path);
	if (bytes.includes(0)) {
		throw new Error("Reflected shader sources must be UTF-8 text without NUL bytes.");
	}
	return { path: normalized, source: bytes.toString("utf-8"), revision: sha256(bytes) };
}

function reflectedBlockOptions(reflected: IShaderGraphReflectedFunction, id: string, target: ShaderGraphReflectedTarget): Record<string, unknown> {
	const wrapperName = `zvibeReflected_${id.replace(/-/g, "")}`;
	const inputs = reflected.parameters.filter((parameter) => parameter.direction === "in");
	const outputParameters = reflected.parameters.filter((parameter) => parameter.direction === "out");
	const outputs = outputParameters.map((parameter) => ({ name: parameter.name, type: parameter.portType }));
	let returnOutputName: string | null = null;
	if (reflected.returnType !== "void") {
		returnOutputName = outputs.some((output) => output.name === "returnValue") ? "functionResult" : "returnValue";
		outputs.push({ name: returnOutputName, type: glslTypeToPortType[reflected.returnType] });
	}
	const wrapperParameters = [
		...inputs.map((parameter) => `${parameter.glslType} ${parameter.name}`),
		...outputParameters.map((parameter) => `out ${parameter.glslType} ${parameter.name}`),
		...(returnOutputName ? [`out ${reflected.returnType} ${returnOutputName}`] : []),
	];
	const originalArguments = reflected.parameters.map((parameter) => parameter.name).join(", ");
	const invocation = reflected.returnType === "void" ? `${reflected.name}(${originalArguments});` : `${returnOutputName} = ${reflected.name}(${originalArguments});`;
	const code = [reflected.source, "", `void ${wrapperName}(${wrapperParameters.join(", ")}) {`, `\t${invocation}`, "}"];
	return {
		name: wrapperName,
		target,
		functionName: wrapperName,
		code,
		inParameters: inputs.map((parameter) => ({ name: parameter.name, type: parameter.portType })),
		outParameters: outputs,
	};
}

/** Returns the bounded portable Shader Graph feature surface and explicit Unity compatibility boundary. */
export function getShaderGraphCapabilities(): Record<string, unknown> {
	return {
		version: 1,
		templateCatalogRevision: shaderGraphTemplateCatalogRevision,
		templateCount: shaderGraphTemplates.length,
		templates: { search: true, createMaterial: true, applyToExisting: true, decalProjectorPortable: true, fullscreenRendererPortable: true },
		switchNode: { modes: ["float", "enum"], minimumCases: 2, maximumCases: maximumSwitchCases, valueTypes: Object.keys(portTypeToGlslType) },
		subgraphInputs: { connectorDisable: true, staticValue: true, floatModes: ["default", "slider", "integer", "enum"] },
		reflectedFunctions: {
			language: "GLSL",
			extensions: reflectedSourceExtensions,
			maximumSourceBytes: maximumShaderSourceBytes,
			in: true,
			out: true,
			returnValue: true,
			inout: false,
		},
		boundary: "Portable Babylon Node Material behavior; not Unity Shader Graph, HLSL/SRP, Unity serialization, or binary compatibility.",
	};
}

/** Searches the deterministic Shader Graph template catalog. */
export function listShaderGraphTemplates(_scene: Scene, data: any): Record<string, unknown> {
	const query = String(data.query ?? "")
		.trim()
		.toLowerCase();
	const category = data.category as IShaderGraphTemplate["category"] | undefined;
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	if (query.length > 256 || (category !== undefined && !["Surface", "Rendering", "Procedural"].includes(category))) {
		throw new Error("Shader Graph template query or category is invalid.");
	}
	if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
		throw new Error("Shader Graph template paging requires offset 0-10000 and limit 1-50.");
	}
	const matches = shaderGraphTemplates.filter((template) => {
		const categoryMatches = !category || template.category === category;
		const searchable = [template.id, template.name, template.description, template.category, template.target, template.portableEquivalent, ...template.tags]
			.join(" ")
			.toLowerCase();
		return categoryMatches && (!query || searchable.includes(query));
	});
	return {
		catalogRevision: shaderGraphTemplateCatalogRevision,
		query,
		category: category ?? null,
		total: matches.length,
		offset,
		limit,
		templates: structuredClone(matches.slice(offset, offset + limit)),
	};
}

/** Creates and persists a real Node Material from one exact catalog revision. */
export async function createShaderGraphFromTemplate(scene: Scene, data: any, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	if (data.expectedCatalogRevision !== shaderGraphTemplateCatalogRevision) {
		throw new Error("Shader Graph template catalog changed after inspection; search it again before creating a material.");
	}
	const template = resolveTemplate(data.templateId);
	const name = String(data.name ?? template.name).trim();
	if (!name || name.length > 128 || name.includes("/") || name.includes("\\")) {
		throw new Error("Shader Graph material names must be 1-128 characters and cannot contain path separators.");
	}
	const material = addNodeMaterial(scene);
	material.name = name;
	initializeTemplate(material, template);
	material.build(false, true, false);
	let path: string;
	try {
		path = await persistNodeMaterial(material, data.folder ?? "assets");
	} catch (error) {
		material.dispose(false, false);
		throw error;
	}
	options.editor.layout.assets.refresh();
	refreshMaterial(material, options);
	return { id: material.id, name: material.name, path, template: structuredClone(template), graphRevision: shaderGraphRevision(material) };
}

/** Replaces an existing Node Material with one template under an exact graph lease. */
export async function applyShaderGraphTemplate(scene: Scene, data: any, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	if (data.confirm !== true) {
		throw new Error("Applying a Shader Graph template requires confirm=true after reviewing the destructive replacement.");
	}
	if (data.expectedCatalogRevision !== shaderGraphTemplateCatalogRevision) {
		throw new Error("Shader Graph template catalog changed after inspection; search it again before applying a template.");
	}
	const previous = resolveNodeMaterial(scene, data.materialId);
	requireGraphRevision(previous, data.expectedGraphRevision);
	const template = resolveTemplate(data.templateId);
	const replacement = addNodeMaterial(scene);
	initializeTemplate(replacement, template);
	replacement.build(false, true, false);
	replacement.name = previous.name;
	const previousId = previous.id;
	const replacementId = replacement.id;
	const retainedMetadata = structuredClone(previous.metadata ?? {});
	delete retainedMetadata.babylonEditorShaderBlackboard;
	delete retainedMetadata.babylonEditorShaderVariants;
	delete retainedMetadata.babylonEditorShaderGraphSwitches;
	delete retainedMetadata.babylonEditorShaderGraphReflectedFunctions;
	replacement.metadata = { ...retainedMetadata, ...structuredClone(replacement.metadata ?? {}) };
	const assetPath = replacement.metadata?.babylonEditorShaderGraphAssetPath;
	if (typeof assetPath === "string") {
		try {
			const path = await resolveExistingProjectFile(assetPath, ".material", 16 * 1024 * 1024);
			replacement.id = previousId;
			const serialized = replacement.serialize();
			replacement.id = replacementId;
			await writeJsonAtomically(path.absolutePath, serialized);
		} catch (error) {
			replacement.id = replacementId;
			replacement.dispose(false, false);
			throw error;
		}
	}
	const assignedMeshes = scene.meshes.filter((mesh) => mesh.material === previous);
	previous.dispose(false, false);
	replacement.id = previousId;
	for (const mesh of assignedMeshes) {
		mesh.material = replacement;
	}
	refreshMaterial(replacement, options);
	return { id: replacement.id, name: replacement.name, assetPath: assetPath ?? null, template: structuredClone(template), graphRevision: shaderGraphRevision(replacement) };
}

/** Returns exact extension metadata for template, Switch, and reflected-function authoring. */
export function getShaderGraphExtensions(scene: Scene, data: any): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, data.materialId);
	const switches = switchMetadata(material, false);
	const reflectedFunctions = reflectedMetadata(material, false);
	return {
		materialId: material.id,
		graphRevision: shaderGraphRevision(material),
		template: structuredClone(material.metadata?.babylonEditorShaderGraphTemplate ?? null),
		switches: structuredClone(switches),
		reflectedFunctions: structuredClone(reflectedFunctions),
	};
}

/** Opens the normal top-level Node Material Inspector for one Shader Graph. */
export function openShaderGraphInspector(scene: Scene, data: any, options: IMCPActionOptions): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, data.materialId);
	refreshMaterial(material, options);
	return { opened: true, ...getShaderGraphExtensions(scene, { materialId: material.id }) };
}

/** Creates or updates a multi-case Shader Graph Switch CustomBlock under an exact graph lease. */
export function setShaderGraphSwitch(scene: Scene, data: any, options: IMCPActionOptions): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, data.materialId);
	requireGraphRevision(material, data.expectedGraphRevision);
	if (data.switchId !== undefined && (typeof data.switchId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.switchId))) {
		throw new Error("Shader Graph switchId must be a version-4 UUID returned by get_shader_graph_extensions.");
	}
	const existingSwitches = switchMetadata(material, false);
	const existing = data.switchId ? existingSwitches.find((candidate) => candidate.id === data.switchId) : undefined;
	if (data.switchId && !existing) {
		throw new Error(`Shader Graph Switch was not found: ${String(data.switchId)}.`);
	}
	const name = String(data.name).trim();
	if (!safeIdentifierPattern.test(name)) {
		throw new Error("Shader Graph Switch names must be GLSL-safe identifiers.");
	}
	const cases = validateSwitchCases(data.cases);
	const mode = data.mode as ShaderGraphSwitchMode;
	const valueType = data.valueType as ShaderGraphValueType;
	const target = (data.target ?? "Fragment") as ShaderGraphReflectedTarget;
	if (!["float", "enum"].includes(mode) || !(valueType in portTypeToGlslType) || !["Vertex", "Fragment", "VertexAndFragment"].includes(target)) {
		throw new Error("Shader Graph Switch mode, valueType, or target is unsupported.");
	}
	if (existing && (existing.valueType !== valueType || existing.cases.length !== cases.length)) {
		throw new Error("Updating a connected Switch cannot change its value type or case count; delete and recreate it deliberately.");
	}
	if (existing && existing.name !== name) {
		throw new Error("Updating a connected Switch cannot rename its ports block; delete and recreate it deliberately.");
	}
	if ((!existing || existing.blockName !== name) && material.attachedBlocks.some((block) => block.name === name)) {
		throw new Error(`A Node Material block named "${name}" already exists.`);
	}
	const switches = switchMetadata(material);
	const metadata: IShaderGraphSwitchMetadata = {
		version: 1,
		id: existing?.id ?? randomUUID(),
		name,
		blockName: name,
		mode,
		valueType,
		target,
		cases,
	};
	const blockOptions = switchBlockOptions(metadata);
	if (existing) {
		setNodeMaterialCustomBlock(
			scene,
			{ materialId: material.id, name: existing.blockName, functionName: blockOptions.functionName, code: (blockOptions.code as string[]).join("\n"), target },
			options
		);
		const replacement = material.attachedBlocks.find((block) => block.getClassName() === "CustomBlock" && block.name === existing.blockName);
		if (!replacement) {
			throw new Error(`Updated Shader Graph Switch block was not found: ${existing.blockName}.`);
		}
		switches[switches.indexOf(existing)] = metadata;
	} else {
		const block = new CustomBlock(metadata.blockName);
		block.options = blockOptions;
		block.comments = `Shader Graph ${mode} Switch: ${cases.map((candidate) => `${candidate.label}=${candidate.match}`).join(", ")}`;
		material.attachedBlocks.push(block);
		switches.push(metadata);
	}
	refreshMaterial(material, options);
	return { materialId: material.id, switch: structuredClone(metadata), graphRevision: shaderGraphRevision(material) };
}

/** Deletes one exact-leased Switch node and disconnects all of its graph edges. */
export function deleteShaderGraphSwitch(scene: Scene, data: any, options: IMCPActionOptions): Record<string, unknown> {
	const material = resolveNodeMaterial(scene, data.materialId);
	requireGraphRevision(material, data.expectedGraphRevision);
	const switches = switchMetadata(material, false);
	const index = switches.findIndex((candidate) => candidate.id === data.switchId);
	if (index < 0) {
		throw new Error(`Shader Graph Switch was not found: ${String(data.switchId)}.`);
	}
	const metadata = switches[index];
	disconnectAndRemoveCustomBlock(material, metadata.blockName);
	switches.splice(index, 1);
	refreshMaterial(material, options);
	return { materialId: material.id, deleted: true, switchId: metadata.id, graphRevision: shaderGraphRevision(material) };
}

/** Reflects one bounded project-contained GLSL function without changing the graph. */
export async function inspectShaderGraphReflectedFunction(_scene: Scene, data: any): Promise<Record<string, unknown>> {
	const source = await readProjectShaderSource(data.sourcePath);
	const reflected = parseReflectedFunction(source.source, data.functionName);
	return {
		sourcePath: source.path,
		sourceRevision: source.revision,
		function: { name: reflected.name, returnType: reflected.returnType, parameters: reflected.parameters, sourceCharacters: reflected.source.length },
		supported: true,
		limitations: [
			"GLSL only",
			"No inout parameters",
			"Only scalar/vector/matrix value parameters",
			"Dependencies used by the reflected function must be included in its body or built-ins",
		],
	};
}

/** Adds one inspected GLSL function as a real graph-native CustomBlock under exact source and graph leases. */
export async function addShaderGraphReflectedFunction(scene: Scene, data: any, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	const material = resolveNodeMaterial(scene, data.materialId);
	requireGraphRevision(material, data.expectedGraphRevision);
	const source = await readProjectShaderSource(data.sourcePath);
	if (source.revision !== data.expectedSourceRevision) {
		throw new Error("Reflected shader source changed after inspection; inspect it again before adding the function.");
	}
	const reflected = parseReflectedFunction(source.source, data.functionName);
	const id = randomUUID();
	const target = (data.target ?? "Fragment") as ShaderGraphReflectedTarget;
	if (!["Vertex", "Fragment", "VertexAndFragment"].includes(target)) {
		throw new Error(`Unsupported reflected Shader Graph target: ${String(target)}.`);
	}
	const blockOptions = reflectedBlockOptions(reflected, id, target);
	const blockName = String(data.blockName ?? `${reflected.name} Reflected`).trim();
	if (!blockName || blockName.length > 128 || material.attachedBlocks.some((block) => block.name === blockName)) {
		throw new Error("Reflected Shader Graph blockName must be unique and contain 1-128 characters.");
	}
	const block = new CustomBlock(blockName);
	block.options = { ...blockOptions, name: blockName };
	block.comments = `Reflected from ${source.path} at ${source.revision}.`;
	material.attachedBlocks.push(block);
	const metadata: IShaderGraphReflectedFunctionMetadata = {
		version: 1,
		id,
		blockName,
		functionName: reflected.name,
		sourcePath: source.path,
		sourceRevision: source.revision,
		target,
	};
	reflectedMetadata(material).push(metadata);
	refreshMaterial(material, options);
	return { materialId: material.id, reflectedFunction: structuredClone(metadata), graphRevision: shaderGraphRevision(material) };
}

/** Updates connector/static/float UX metadata in one exact-revision reusable subgraph asset. */
export async function setShaderGraphSubgraphInput(_scene: Scene, data: any, options: IMCPActionOptions): Promise<Record<string, unknown>> {
	if (typeof data.connectorEnabled !== "boolean" || !["default", "slider", "integer", "enum"].includes(data.floatMode)) {
		throw new Error("Shader subgraph connectorEnabled and floatMode are required and must be valid.");
	}
	if (
		typeof data.parameterName !== "string" ||
		!data.parameterName.trim() ||
		data.parameterName.length > 128 ||
		(data.description !== undefined && (typeof data.description !== "string" || data.description.length > 512))
	) {
		throw new Error("Shader subgraph parameterName or description is invalid.");
	}
	if (data.staticValue !== undefined) {
		let serialized: string;
		try {
			serialized = JSON.stringify(data.staticValue);
		} catch {
			throw new Error("Shader subgraph staticValue must be JSON-serializable.");
		}
		if (serialized === undefined || serialized.length > 65536) {
			throw new Error("Shader subgraph staticValue cannot exceed 65536 serialized characters.");
		}
	}
	const source = await readProjectShaderSourceAsset(data.path);
	if (source.revision !== data.expectedRevision) {
		throw new Error("Shader subgraph asset changed after inspection; read it again before changing an input.");
	}
	const asset = JSON.parse(source.bytes.toString("utf-8"));
	if (![1, 2].includes(asset?.version) || !asset.name || !asset.graph || !Array.isArray(asset.blackboard)) {
		throw new Error("Shader subgraph asset is invalid or uses an unsupported version.");
	}
	const parameter = asset.blackboard.find((candidate: any) => candidate.name === data.parameterName);
	if (!parameter) {
		throw new Error(`Shader subgraph input was not found: ${String(data.parameterName)}.`);
	}
	if (data.floatMode !== "default" && parameter.type !== NodeMaterialBlockConnectionPointTypes.Float) {
		throw new Error(`Shader Graph float mode ${String(data.floatMode)} requires a Float subgraph input.`);
	}
	const serializedInput = Array.isArray(asset.graph.blocks)
		? asset.graph.blocks.find((candidate: any) => candidate?.customType === "BABYLON.InputBlock" && candidate.name === parameter.inputName)
		: null;
	if (!serializedInput) {
		throw new Error(`Shader subgraph blackboard input is missing from the serialized graph: ${String(parameter.inputName)}.`);
	}
	parameter.connectorEnabled = data.connectorEnabled;
	parameter.floatMode = data.floatMode;
	parameter.description = data.description;
	if (data.connectorEnabled) {
		delete parameter.staticValue;
	} else {
		parameter.staticValue = structuredClone(data.staticValue ?? parameter.defaultValue);
		if (parameter.staticValue === undefined) {
			throw new Error("A connector-disabled subgraph input requires staticValue or an existing defaultValue.");
		}
	}
	serializedInput.visibleInInspector = true;
	serializedInput.comments = data.description ?? serializedInput.comments;
	if (!data.connectorEnabled) {
		serializedInput.value = structuredClone(parameter.staticValue);
	}
	if (data.floatMode === "enum") {
		parameter.enumOptions = validateEnumOptions(data.enumOptions);
	} else {
		delete parameter.enumOptions;
	}
	asset.version = 2;
	const bytes = Buffer.from(`${JSON.stringify(asset, null, "\t")}\n`, "utf-8");
	const temporary = `${source.absolutePath}.${randomUUID()}.tmp`;
	await writeFile(temporary, bytes, { flag: "wx" });
	try {
		if (sha256(await readFile(source.absolutePath)) !== source.revision) {
			throw new Error("Shader subgraph asset changed while the update was being prepared.");
		}
		await rename(temporary, source.absolutePath);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
	options.editor.layout.assets.refresh();
	return { path: source.path, version: 2, parameter: structuredClone(parameter), previousRevision: source.revision, revision: sha256(bytes) };
}

function validateEnumOptions(value: unknown): Array<{ label: string; value: number }> {
	if (!Array.isArray(value) || !value.length || value.length > 32) {
		throw new Error("Enum float mode requires 1-32 options.");
	}
	const options = value.map((candidate: any, index) => {
		if (!candidate || typeof candidate.label !== "string" || !candidate.label.trim() || candidate.label.length > 64 || !Number.isFinite(candidate.value)) {
			throw new Error(`Enum option ${index} requires a finite value and a 1-64 character label.`);
		}
		return { label: candidate.label.trim(), value: candidate.value };
	});
	if (new Set(options.map((candidate) => candidate.label)).size !== options.length || new Set(options.map((candidate) => candidate.value)).size !== options.length) {
		throw new Error("Enum option labels and values must be unique.");
	}
	return options;
}

async function readProjectShaderSourceAsset(pathValue: string): Promise<{ path: string; absolutePath: string; bytes: Buffer; revision: string }> {
	if (!pathValue || pathValue.length > 1024 || isAbsolute(pathValue) || pathValue.includes("\\") || pathValue.includes("\0")) {
		throw new Error("Shader subgraph paths must be project-relative POSIX paths.");
	}
	const path = normalize(pathValue);
	if (path === ".." || path.startsWith("../") || !path.toLowerCase().endsWith(".shadergraph.json")) {
		throw new Error("Shader subgraph paths must stay inside the project and use .shadergraph.json.");
	}
	const root = projectDirectory();
	const absolutePath = join(root, path);
	const [realRoot, realAsset, details] = await Promise.all([realpath(root), realpath(absolutePath), lstat(absolutePath)]);
	if (details.isSymbolicLink() || !details.isFile() || details.size > 4 * 1024 * 1024 || (realAsset !== realRoot && !realAsset.startsWith(`${realRoot}/`))) {
		throw new Error("Shader subgraphs must be bounded regular non-symlink project files.");
	}
	const bytes = await readFile(absolutePath);
	return { path, absolutePath, bytes, revision: sha256(bytes) };
}
