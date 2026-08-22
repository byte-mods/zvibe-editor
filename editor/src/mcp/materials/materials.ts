import { dirname, join, isAbsolute, relative, extname, normalize } from "path/posix";
import { createHash, randomUUID } from "crypto";
import { ensureDir, lstat, mkdir, pathExists, readFile, realpath, writeJSON } from "fs-extra";

import sharp from "sharp";

import {
	Color3,
	Color4,
	CubeTexture,
	CustomBlock,
	EXRCubeTexture,
	HDRCubeTexture,
	Material,
	NodeMaterial,
	NodeMaterialBlockConnectionPointTypes,
	Scene,
	SerializationHelper,
	Texture,
	Vector2,
	Vector3,
	Vector4,
} from "babylonjs";
import { TerrainMaterial } from "babylonjs-materials";
import { getDeferredLightingRuntimes } from "babylonjs-editor-tools";

import { findAvailableFilename } from "../../tools/fs";
import { configureImportedTexture } from "../../editor/layout/preview/import/import";

import {
	addPBRMaterial,
	addStandardMaterial,
	addNodeMaterial,
	addSkyMaterial,
	addGridMaterial,
	addNormalMaterial,
	addWaterMaterial,
	addLavaMaterial,
	addTriPlanarMaterial,
	addTerrainMaterial,
	addCellMaterial,
	addFireMaterial,
	addGradientMaterial,
} from "../../project/add/material";

import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";
import { resolveMaterial, deepSet } from "../tools/resolve";
import { isNodeMaterial } from "../../tools/guards/material";
import { getOrApplyTextureImporterArtifact, requiresDecodedTextureImporterArtifact } from "../assets/texture-importer";

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
 * Resolves an absolute path from a project-relative or absolute path.
 */
function resolveProjectPath(path: string): string {
	return isAbsolute(path) ? path : join(getProjectDirectory(), path);
}

/** Resolves a generated texture path while preventing writes outside the open project. */
function resolveGeneratedProjectPath(path: string): string {
	if (isAbsolute(path)) {
		throw new Error("Generated terrain texture paths must be relative to the open project.");
	}
	const projectDirectory = getProjectDirectory();
	const absolutePath = join(projectDirectory, path);
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("Generated terrain texture paths must stay inside the open project directory.");
	}
	return absolutePath;
}

async function resolveShaderSubgraphOutputPath(pathValue: string, createParents = true): Promise<string> {
	if (!pathValue || pathValue.length > 1024 || isAbsolute(pathValue) || pathValue.includes("\\") || pathValue.includes("\0")) {
		throw new Error("Shader subgraph paths must be project-relative POSIX paths.");
	}
	const normalized = normalize(pathValue);
	if (normalized === ".." || normalized.startsWith("../") || !normalized.toLowerCase().endsWith(".shadergraph.json")) {
		throw new Error("Shader subgraph paths must stay inside the project and use .shadergraph.json.");
	}
	const root = getProjectDirectory();
	const realRoot = await realpath(root);
	let current = root;
	for (const segment of dirname(normalized)
		.split("/")
		.filter((entry) => entry && entry !== ".")) {
		current = join(current, segment);
		let details = await lstat(current).catch((error: any) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
		if (!details) {
			if (!createParents) {
				throw new Error(`Shader subgraph asset not found: ${pathValue}`);
			}
			await mkdir(current).catch((error: any) => {
				if (error?.code !== "EEXIST") {
					throw error;
				}
			});
			details = await lstat(current);
		}
		if (details.isSymbolicLink() || !details.isDirectory()) {
			throw new Error("Shader subgraph parent folders must be regular project directories.");
		}
		const canonical = await realpath(current);
		if (canonical !== realRoot && !canonical.startsWith(`${realRoot}/`)) {
			throw new Error("Shader subgraph paths cannot escape the project through symbolic links.");
		}
	}
	const output = join(root, normalized);
	const existing = await lstat(output).catch((error: any) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
	if (existing) {
		if (existing.isSymbolicLink() || !existing.isFile()) {
			throw new Error("Shader subgraph outputs must be regular non-symlink files.");
		}
		const canonical = await realpath(output);
		if (canonical !== realRoot && !canonical.startsWith(`${realRoot}/`)) {
			throw new Error("Shader subgraph outputs cannot escape the project through symbolic links.");
		}
	}
	return output;
}

async function resolveExistingShaderSubgraphPath(pathValue: string): Promise<string> {
	const path = await resolveShaderSubgraphOutputPath(pathValue, false);
	const details = await lstat(path).catch((error: any) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
	if (!details) {
		throw new Error(`Shader subgraph asset not found: ${pathValue}`);
	}
	if (!details.isFile() || details.size > 4 * 1024 * 1024) {
		throw new Error("Shader subgraph assets must be regular files no larger than 4 MiB.");
	}
	return path;
}

/**
 * Lists all the materials available in the scene/project.
 */
export function listMaterials(scene: Scene): any {
	return {
		materials: scene.materials
			.filter((material) => !material.doNotSerialize)
			.map((material) => ({
				id: material.id,
				name: material.name,
				className: material.getClassName(),
			})),
	};
}

/**
 * Catalog of the material types the editor can create, with their key controllable properties.
 * The "library" materials come from the Babylon.js Materials Library (babylonjs-materials) and mirror
 * the editor's dedicated inspectors. Properties listed here can all be set with `set_material_properties`.
 */
const materialTypesCatalog = [
	{
		type: "pbr",
		className: "PBRMaterial",
		library: false,
		use: "Realistic physically-based surfaces (metal, plastic, wood, stone). The default choice for most meshes.",
		keyProperties: ["albedoColor [r,g,b]", "metallic (0..1)", "roughness (0..1)", "emissiveColor [r,g,b]", "alpha (0..1)", "albedoTexture", "bumpTexture", "metallicTexture"],
	},
	{
		type: "standard",
		className: "StandardMaterial",
		library: false,
		use: "Simple, cheap non-PBR surfaces and unlit/flat looks.",
		keyProperties: ["diffuseColor [r,g,b]", "specularColor [r,g,b]", "emissiveColor [r,g,b]", "alpha (0..1)", "diffuseTexture", "bumpTexture"],
	},
	{
		type: "node",
		className: "NodeMaterial",
		library: false,
		use: "Custom shader graphs (advanced). Prefer authoring these by hand in the Node Material Editor.",
		keyProperties: [],
	},
	{
		type: "sky",
		className: "SkyMaterial",
		library: true,
		use: "Procedural physically-based sky (no HDR needed). Apply it to a `skybox` mesh. Animate `inclination` for a day/night cycle.",
		keyProperties: [
			"inclination (-0.6..0.6, sun height / time of day)",
			"azimuth (0..1, sun horizontal direction)",
			"luminance (>=0.01, overall brightness)",
			"turbidity (>=0, haziness)",
			"rayleigh (sky scattering)",
			"mieCoefficient (0..1)",
			"mieDirectionalG (0..1)",
			"useSunPosition (bool)",
			"sunPosition [x,y,z]",
			"dithering (bool)",
		],
	},
	{
		type: "grid",
		className: "GridMaterial",
		library: true,
		use: "Blueprint / editor-style reference grid. Great for prototyping floors and level blockouts.",
		keyProperties: ["mainColor [r,g,b]", "lineColor [r,g,b]", "gridRatio", "majorUnitFrequency", "minorUnitVisibility (0..1)", "opacity (0..1)"],
	},
	{
		type: "normal",
		className: "NormalMaterial",
		library: true,
		use: "Renders surface normals as colors. Useful for debugging or a stylized look.",
		keyProperties: ["diffuseColor [r,g,b]", "diffuseTexture"],
	},
	{
		type: "water",
		className: "WaterMaterial",
		library: true,
		use: "Animated water for lakes/oceans/rivers. Apply to a ground or plane.",
		keyProperties: ["waterColor [r,g,b]", "waveHeight", "waveLength", "windForce", "windDirection [x,y]", "bumpHeight", "colorBlendFactor (0..1)", "waveSpeed"],
	},
	{
		type: "lava",
		className: "LavaMaterial",
		library: true,
		use: "Animated lava / flowing molten surfaces (needs a noise/diffuse texture for the full effect).",
		keyProperties: ["speed", "movingSpeed", "lowFrequencySpeed", "fogColor [r,g,b]", "diffuseTexture", "noiseTexture"],
	},
	{
		type: "triplanar",
		className: "TriPlanarMaterial",
		library: true,
		use: "Texture meshes that have no UVs (terrain, voxels, CSG) by projecting on the 3 axes.",
		keyProperties: ["tileSize", "diffuseColor [r,g,b]", "diffuseTextureX", "diffuseTextureY", "diffuseTextureZ", "normalTextureX/Y/Z"],
	},
	{
		type: "cell",
		className: "CellMaterial",
		library: true,
		use: "Toon / cel shading for stylized games.",
		keyProperties: ["diffuseColor [r,g,b]", "computeHighLevel (bool)", "diffuseTexture"],
	},
	{
		type: "fire",
		className: "FireMaterial",
		library: true,
		use: "Animated fire surface (needs diffuse/distortion/opacity textures for the full effect).",
		keyProperties: ["speed", "diffuseTexture", "distortionTexture", "opacityTexture"],
	},
	{
		type: "gradient",
		className: "GradientMaterial",
		library: true,
		use: "Two-color gradient (sky-like / stylized backgrounds and surfaces).",
		keyProperties: ["topColor [r,g,b]", "bottomColor [r,g,b]", "offset", "smoothness", "scale"],
	},
	{
		type: "terrain",
		className: "TerrainMaterial",
		library: true,
		use: "Three-surface terrain material. It blends diffuseTexture1/2/3 with an RGB mixTexture (splat map).",
		keyProperties: [
			"mixTexture",
			"diffuseTexture1",
			"diffuseTexture2",
			"diffuseTexture3",
			"bumpTexture1",
			"bumpTexture2",
			"bumpTexture3",
			"diffuseColor",
			"specularColor",
			"specularPower",
		],
	},
];

const presetPropertyKeys: Record<string, string[]> = {
	PBRMaterial: ["albedoColor", "metallic", "roughness", "emissiveColor", "alpha", "backFaceCulling", "disableLighting"],
	StandardMaterial: ["diffuseColor", "specularColor", "emissiveColor", "alpha", "backFaceCulling", "disableLighting"],
	GridMaterial: ["mainColor", "lineColor", "gridRatio", "majorUnitFrequency", "minorUnitVisibility", "opacity"],
	GradientMaterial: ["topColor", "bottomColor", "offset", "smoothness", "scale"],
	WaterMaterial: ["waterColor", "waveHeight", "waveLength", "windForce", "windDirection", "bumpHeight", "colorBlendFactor", "waveSpeed"],
	SkyMaterial: ["inclination", "azimuth", "luminance", "turbidity", "rayleigh", "mieCoefficient", "mieDirectionalG", "useSunPosition", "sunPosition", "dithering"],
	CellMaterial: ["diffuseColor", "computeHighLevel"],
	FireMaterial: ["speed"],
	LavaMaterial: ["speed", "movingSpeed", "lowFrequencySpeed", "fogColor"],
	TriPlanarMaterial: ["tileSize", "diffuseColor"],
	TerrainMaterial: ["diffuseColor", "specularColor", "specularPower"],
};

type IMaterialVariantState = Record<string, any>;
type IMaterialVariantMetadata = {
	version?: 2;
	baseMaterialId: string;
	overrides: Record<string, any>;
	baseSnapshot?: IMaterialVariantState;
	assetPath?: string;
};

type IMaterialVariantPathValue = { exists: boolean; value?: any };
type IMaterialVariantConflict = {
	path: string;
	previousBaseExists: boolean;
	previousBaseValue?: any;
	currentBaseExists: boolean;
	currentBaseValue?: any;
	variantExists: boolean;
	variantValue?: any;
};

const materialVariantIdentityKeys = new Set(["name", "id", "uniqueId", "metadata", "tags", "customType"]);
const materialVariantMaximumDepth = 16;
const materialVariantMaximumStateBytes = 1024 * 1024;

function getMaterialVariantMetadata(material: Material): IMaterialVariantMetadata | null {
	const metadata = material.metadata?.babylonEditorMaterialVariant;
	return metadata && typeof metadata.baseMaterialId === "string" && metadata.overrides && typeof metadata.overrides === "object" ? metadata : null;
}

function canonicalMaterialVariantValue(value: any): any {
	if (Array.isArray(value)) {
		return value.map(canonicalMaterialVariantValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalMaterialVariantValue(child)])
		);
	}
	return value;
}

function materialVariantValuesEqual(left: any, right: any): boolean {
	return JSON.stringify(canonicalMaterialVariantValue(left)) === JSON.stringify(canonicalMaterialVariantValue(right));
}

function captureMaterialVariantState(material: Material): IMaterialVariantState {
	const serialized = structuredClone(material.serialize()) as IMaterialVariantState;
	for (const key of materialVariantIdentityKeys) {
		delete serialized[key];
	}
	const state = canonicalMaterialVariantValue(serialized) as IMaterialVariantState;
	const byteLength = Buffer.byteLength(JSON.stringify(state), "utf-8");
	if (byteLength > materialVariantMaximumStateBytes) {
		throw new Error(`Material variant state is ${byteLength} bytes; the maximum supported state is ${materialVariantMaximumStateBytes} bytes.`);
	}
	return state;
}

function materialVariantStateFingerprint(state: IMaterialVariantState): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalMaterialVariantValue(state)))
		.digest("hex");
}

function readMaterialVariantPath(state: IMaterialVariantState, path: string): IMaterialVariantPathValue {
	let current: any = state;
	for (const part of path.split(".")) {
		if (!current || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, part)) {
			return { exists: false };
		}
		current = current[part];
	}
	return { exists: true, value: structuredClone(current) };
}

function writeMaterialVariantPath(state: IMaterialVariantState, path: string, value: any, exists = true): void {
	const parts = path.split(".");
	let current: any = state;
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index];
		if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) {
			current[part] = {};
		}
		current = current[part];
	}
	if (exists) {
		current[parts.at(-1)!] = structuredClone(value);
	} else {
		delete current[parts.at(-1)!];
	}
}

function isMaterialVariantRecord(value: any): value is Record<string, any> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function collectMaterialVariantComparisonPaths(values: IMaterialVariantPathValue[], prefix = "", result = new Set<string>()): Set<string> {
	const existingValues = values.filter((entry) => entry.exists).map((entry) => entry.value);
	if (!existingValues.length) {
		return result;
	}
	if (existingValues.every(isMaterialVariantRecord)) {
		const keys = new Set(existingValues.flatMap((value) => Object.keys(value)));
		for (const key of [...keys].sort()) {
			collectMaterialVariantComparisonPaths(
				values.map((entry) =>
					entry.exists && isMaterialVariantRecord(entry.value) && Object.prototype.hasOwnProperty.call(entry.value, key)
						? { exists: true, value: entry.value[key] }
						: { exists: false }
				),
				prefix ? `${prefix}.${key}` : key,
				result
			);
		}
	} else if (prefix) {
		result.add(prefix);
	}
	return result;
}

function materialVariantPathIsExplicit(path: string, overrides: Record<string, any>): boolean {
	return Object.keys(overrides).some((overridePath) => path === overridePath || path.startsWith(`${overridePath}.`) || overridePath.startsWith(`${path}.`));
}

function resolveMaterialVariantChain(scene: Scene, variant: Material): Material[] {
	const chain = [variant];
	const visited = new Set([variant.id]);
	let current = variant;
	for (let depth = 0; depth < materialVariantMaximumDepth; depth++) {
		const metadata = getMaterialVariantMetadata(current);
		if (!metadata) {
			return chain;
		}
		const base = scene.getMaterialById(metadata.baseMaterialId);
		if (!base) {
			throw new Error(`Base material not found for variant "${current.name}": ${metadata.baseMaterialId}`);
		}
		if (visited.has(base.id)) {
			throw new Error(`Material variant inheritance cycle detected at "${base.name}".`);
		}
		if (base.getClassName() !== current.getClassName()) {
			throw new Error(`Variant "${current.name}" is ${current.getClassName()} but its base is ${base.getClassName()}.`);
		}
		chain.push(base);
		visited.add(base.id);
		current = base;
	}
	if (getMaterialVariantMetadata(current)) {
		throw new Error(`Material variant inheritance exceeds the maximum depth of ${materialVariantMaximumDepth}.`);
	}
	return chain;
}

function inspectMaterialVariant(material: Material): {
	metadata: IMaterialVariantMetadata;
	chain: Material[];
	baseState: IMaterialVariantState;
	previousBaseState: IMaterialVariantState;
	variantState: IMaterialVariantState;
	pendingOverridePaths: string[];
	inheritedChangedPaths: string[];
	conflicts: IMaterialVariantConflict[];
	fingerprint: string;
} {
	const metadata = getMaterialVariantMetadata(material);
	if (!metadata) {
		throw new Error(`Material "${material.name}" is not a base-linked material variant.`);
	}
	const chain = resolveMaterialVariantChain(material.getScene(), material);
	const baseState = captureMaterialVariantState(chain[1]);
	const variantState = captureMaterialVariantState(material);
	const previousBaseState = structuredClone(metadata.baseSnapshot ?? variantState);
	if (!metadata.baseSnapshot) {
		for (const path of Object.keys(metadata.overrides)) {
			const inherited = readMaterialVariantPath(baseState, path);
			writeMaterialVariantPath(previousBaseState, path, inherited.value, inherited.exists);
		}
	}
	const paths = collectMaterialVariantComparisonPaths([
		{ exists: true, value: previousBaseState },
		{ exists: true, value: baseState },
		{ exists: true, value: variantState },
	]);
	const pendingOverridePaths: string[] = [];
	const inheritedChangedPaths: string[] = [];
	const conflicts: IMaterialVariantConflict[] = [];
	for (const path of paths) {
		const previousBase = readMaterialVariantPath(previousBaseState, path);
		const currentBase = readMaterialVariantPath(baseState, path);
		const currentVariant = readMaterialVariantPath(variantState, path);
		const baseChanged = previousBase.exists !== currentBase.exists || !materialVariantValuesEqual(previousBase.value, currentBase.value);
		const variantChanged = previousBase.exists !== currentVariant.exists || !materialVariantValuesEqual(previousBase.value, currentVariant.value);
		if (baseChanged) {
			inheritedChangedPaths.push(path);
		}
		if (!variantChanged || materialVariantPathIsExplicit(path, metadata.overrides)) {
			continue;
		}
		if (!baseChanged) {
			pendingOverridePaths.push(path);
		} else if (currentBase.exists !== currentVariant.exists || !materialVariantValuesEqual(currentBase.value, currentVariant.value)) {
			conflicts.push({
				path,
				previousBaseExists: previousBase.exists,
				previousBaseValue: previousBase.value,
				currentBaseExists: currentBase.exists,
				currentBaseValue: currentBase.value,
				variantExists: currentVariant.exists,
				variantValue: currentVariant.value,
			});
		}
	}
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify(
				canonicalMaterialVariantValue({
					materialId: material.id,
					baseMaterialId: metadata.baseMaterialId,
					baseState,
					previousBaseState,
					variantState,
					overrides: metadata.overrides,
				})
			)
		)
		.digest("hex");
	return { metadata, chain, baseState, previousBaseState, variantState, pendingOverridePaths, inheritedChangedPaths, conflicts, fingerprint };
}

function applyMaterialVariantState(material: Material, state: IMaterialVariantState, metadata: IMaterialVariantMetadata): void {
	const previousState = captureMaterialVariantState(material);
	for (const key of Object.keys(previousState)) {
		if (
			(!Object.prototype.hasOwnProperty.call(state, key) || state[key] === null) &&
			key in (material as any) &&
			(material as any)[key] &&
			typeof (material as any)[key] === "object"
		) {
			(material as any)[key] = null;
		}
	}
	const identity = { id: material.id, name: material.name };
	SerializationHelper.ParseProperties(state, material, material.getScene(), projectConfiguration.path ? `${getProjectDirectory()}/` : "");
	material.id = identity.id;
	material.name = identity.name;
	material.metadata ??= {};
	material.metadata.babylonEditorMaterialVariant = metadata;
}

function recordMaterialVariantOverrides(material: Material, properties: Record<string, any>): void {
	const metadata = getMaterialVariantMetadata(material);
	if (!metadata) {
		return;
	}
	Object.assign(metadata.overrides, structuredClone(properties));
}

function presets(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorMaterialPresets ??= []);
}

function serializePresetValue(value: any): any {
	if (value instanceof Color3 || value instanceof Color4 || value instanceof Vector2 || value instanceof Vector3 || value instanceof Vector4) {
		return value.asArray();
	}
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
		return value;
	}
	return undefined;
}

function captureMaterialPresetProperties(material: Material): Record<string, any> {
	const properties: Record<string, any> = {};
	for (const key of presetPropertyKeys[material.getClassName()] ?? []) {
		const value = serializePresetValue((material as any)[key]);
		if (value !== undefined) {
			properties[key] = value;
		}
	}
	return properties;
}

/** Lists persistent scene-level material inspector presets. */
export function listMaterialPresets(scene: Scene): any {
	return { presets: structuredClone(presets(scene)) };
}

/** Captures curated serializable inspector values from a material as a reusable named preset. */
export function createMaterialPreset(scene: Scene, data: any, options?: IMCPActionOptions): any {
	const material = resolveMaterial({ scene, materialId: data.materialId });
	const name = data.name?.trim();
	if (!name) {
		throw new Error("Material preset name must be non-empty.");
	}
	if (presets(scene).some((preset) => preset.name === name)) {
		throw new Error(`Material preset "${name}" already exists.`);
	}
	const properties = { ...captureMaterialPresetProperties(material), ...(data.properties ?? {}) };
	const preset = { name, className: material.getClassName(), properties };
	presets(scene).push(preset);
	options?.editor.layout.inspector.forceUpdate();
	return structuredClone(preset);
}

/** Applies a compatible named material preset using the same deep-property coercion as MCP edits. */
export function applyMaterialPreset(scene: Scene, data: any, options?: IMCPActionOptions): any {
	const material = resolveMaterial({ scene, materialId: data.materialId });
	const preset = presets(scene).find((candidate) => candidate.name === data.name);
	if (!preset) {
		throw new Error(`Material preset "${data.name}" was not found.`);
	}
	if (preset.className !== material.getClassName()) {
		throw new Error(`Material preset "${preset.name}" is for ${preset.className}, not ${material.getClassName()}.`);
	}
	for (const [path, value] of Object.entries(preset.properties)) {
		deepSet(material, path, value);
	}
	recordMaterialVariantOverrides(material, preset.properties);
	options?.editor.layout.inspector.setEditedObject(material);
	options?.editor.layout.inspector.forceUpdate();
	return { materialId: material.id, name: material.name, preset: structuredClone(preset) };
}

/** Deletes a named scene-level material inspector preset. */
export function deleteMaterialPreset(scene: Scene, data: any, options?: IMCPActionOptions): any {
	const index = presets(scene).findIndex((preset) => preset.name === data.name);
	if (index === -1) {
		throw new Error(`Material preset "${data.name}" was not found.`);
	}
	presets(scene).splice(index, 1);
	options?.editor.layout.inspector.forceUpdate();
	return { deleted: true, name: data.name };
}

/**
 * Lists the material types the editor can create (including the Materials Library) and their key
 * controllable properties, so the agent knows what is available and how to tune each one.
 */
export function listMaterialTypes(): any {
	return { types: materialTypesCatalog };
}

/**
 * Creates a material and persists it as a `.material` asset so it appears in the assets browser.
 */
export async function createMaterial(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	let material: Material;
	switch (data.type) {
		case "pbr":
			material = addPBRMaterial(scene);
			break;
		case "standard":
			material = addStandardMaterial(scene);
			break;
		case "node":
			material = addNodeMaterial(scene);
			break;
		case "sky":
			material = addSkyMaterial(scene);
			break;
		case "grid":
			material = addGridMaterial(scene);
			break;
		case "normal":
			material = addNormalMaterial(scene);
			break;
		case "water":
			material = addWaterMaterial(scene);
			break;
		case "lava":
			material = addLavaMaterial(scene);
			break;
		case "triplanar":
			material = addTriPlanarMaterial(scene);
			break;
		case "terrain":
			material = addTerrainMaterial(scene);
			break;
		case "cell":
			material = addCellMaterial(scene);
			break;
		case "fire":
			material = addFireMaterial(scene);
			break;
		case "gradient":
			material = addGradientMaterial(scene);
			break;
		default:
			throw new Error(`Unknown material type: ${data.type}`);
	}

	if (data.name) {
		material.name = data.name;
	}

	const folder = data.folder ? resolveProjectPath(data.folder) : join(getProjectDirectory(), "assets");
	await ensureDir(folder);

	const filename = await findAvailableFilename(folder, material.name, ".material");
	const absolutePath = join(folder, filename);

	await writeJSON(absolutePath, material.serialize(), {
		spaces: "\t",
		encoding: "utf-8",
	});

	options.editor.layout.assets.refresh();

	return {
		id: material.id,
		name: material.name,
		path: relative(getProjectDirectory(), absolutePath),
	};
}

/**
 * Sets deep properties on a material using dotted property paths.
 */
export function setMaterialProperties(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveMaterial({ scene, materialId: data.materialId });

	const properties = data.properties ?? {};
	for (const path of Object.keys(properties)) {
		deepSet(material, path, properties[path]);
	}
	recordMaterialVariantOverrides(material, properties);

	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();

	return {
		id: material.id,
		name: material.name,
		className: material.getClassName(),
		deferredCameras: getDeferredLightingRuntimes(scene as any),
	};
}

/** Clones a material into a separately persisted variant with optional property overrides. */
export async function createMaterialVariant(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const base = resolveMaterial({ scene, materialId: data.baseMaterialId });
	const name = data.name?.trim();
	if (!name) {
		throw new Error("Material variant name must be non-empty.");
	}
	if (getMaterialVariantMetadata(base)) {
		resolveMaterialVariantChain(scene, base);
	}
	const variant = base.clone(name);
	if (!variant) {
		throw new Error(`Material "${base.name}" could not be cloned.`);
	}
	variant.id = randomUUID();
	variant.name = name;
	for (const path of Object.keys(data.properties ?? {})) {
		deepSet(variant, path, data.properties[path]);
	}

	const folder = data.folder ? resolveProjectPath(data.folder) : join(getProjectDirectory(), "assets");
	await ensureDir(folder);
	const filename = await findAvailableFilename(folder, variant.name, ".material");
	const absolutePath = join(folder, filename);
	variant.metadata = structuredClone(base.metadata ?? {});
	variant.metadata.babylonEditorMaterialVariant = {
		version: 2,
		baseMaterialId: base.id,
		overrides: structuredClone(data.properties ?? {}),
		baseSnapshot: captureMaterialVariantState(base),
		assetPath: relative(getProjectDirectory(), absolutePath),
	} satisfies IMaterialVariantMetadata;
	await writeJSON(absolutePath, variant.serialize(), { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.setEditedObject(variant);
	return { id: variant.id, name: variant.name, baseMaterialId: base.id, path: relative(getProjectDirectory(), absolutePath), className: variant.getClassName() };
}

/** Returns a material variant's base link and explicitly tracked overrides. */
export function getMaterialVariant(scene: Scene, data: any): any {
	const variant = resolveMaterial({ scene, materialId: data.materialId });
	const diagnostics = inspectMaterialVariant(variant);
	const metadata = diagnostics.metadata;
	const requestedPaths = data.paths ?? [];
	if (!Array.isArray(requestedPaths) || requestedPaths.length > 128) {
		throw new Error("Material variant inspection paths must be an array of at most 128 entries.");
	}
	if (new Set(requestedPaths).size !== requestedPaths.length || requestedPaths.some((path: any) => typeof path !== "string" || !path.trim())) {
		throw new Error("Material variant inspection paths must be unique non-empty strings.");
	}
	return {
		id: variant.id,
		name: variant.name,
		className: variant.getClassName(),
		baseMaterialId: metadata.baseMaterialId,
		version: metadata.version ?? 1,
		overrides: structuredClone(metadata.overrides),
		overridePaths: Object.keys(metadata.overrides).sort(),
		assetPath: metadata.assetPath,
		chain: diagnostics.chain.map((material, index) => ({ id: material.id, name: material.name, className: material.getClassName(), depth: index })),
		chainDepth: diagnostics.chain.length - 1,
		baseStateFingerprint: materialVariantStateFingerprint(diagnostics.baseState),
		pendingOverridePaths: diagnostics.pendingOverridePaths,
		inheritedChangedPaths: diagnostics.inheritedChangedPaths,
		conflicts: diagnostics.conflicts,
		properties: Object.fromEntries(
			requestedPaths.map((path: string) => {
				const current = readMaterialVariantPath(diagnostics.variantState, path);
				const base = readMaterialVariantPath(diagnostics.baseState, path);
				return [
					path,
					{
						variantExists: current.exists,
						variantValue: current.value,
						baseExists: base.exists,
						baseValue: base.value,
						overridden: materialVariantPathIsExplicit(path, metadata.overrides),
					},
				];
			})
		),
		fingerprint: diagnostics.fingerprint,
	};
}

/** Refreshes every serializable material property from a variant's base, with nested inheritance and exact conflict resolution. */
export async function rebaseMaterialVariant(scene: Scene, data: any, options?: IMCPActionOptions): Promise<any> {
	const variant = resolveMaterial({ scene, materialId: data.materialId });
	const initialDiagnostics = inspectMaterialVariant(variant);
	if (data.expectedFingerprint !== undefined && data.expectedFingerprint !== initialDiagnostics.fingerprint) {
		throw new Error("Material variant changed after inspection. Read get_material_variant again before rebasing.");
	}
	if (data.recursive === true) {
		const chain = initialDiagnostics.chain;
		for (let index = chain.length - 2; index >= 1; index--) {
			await rebaseMaterialVariant(scene, { materialId: chain[index].id, conflictPolicy: data.conflictPolicy ?? "abort" }, options);
		}
	}
	const diagnostics = data.recursive === true ? inspectMaterialVariant(variant) : initialDiagnostics;
	const conflictPolicy = data.conflictPolicy ?? "abort";
	if (!["abort", "useBase", "keepVariant"].includes(conflictPolicy)) {
		throw new Error(`Unsupported material variant conflict policy: ${conflictPolicy}`);
	}
	const resolutions = data.resolutions ?? {};
	if (!resolutions || typeof resolutions !== "object" || Array.isArray(resolutions)) {
		throw new Error("Material variant conflict resolutions must be an object.");
	}
	const conflictPaths = new Set(diagnostics.conflicts.map((conflict) => conflict.path));
	for (const [path, resolution] of Object.entries(resolutions)) {
		if (!conflictPaths.has(path)) {
			throw new Error(`Material variant resolution path is not a current conflict: ${path}`);
		}
		if (resolution !== "useBase" && resolution !== "keepVariant") {
			throw new Error(`Material variant conflict resolution for "${path}" must be useBase or keepVariant.`);
		}
	}
	const unresolved = diagnostics.conflicts.filter((conflict) => !resolutions[conflict.path] && conflictPolicy === "abort");
	if (unresolved.length) {
		throw new Error(`Material variant has ${unresolved.length} unresolved conflict(s): ${unresolved.map((conflict) => conflict.path).join(", ")}`);
	}

	const previousState = structuredClone(diagnostics.variantState);
	const previousMetadata = structuredClone(diagnostics.metadata);
	const effectiveState = structuredClone(diagnostics.baseState);
	const overrides = structuredClone(diagnostics.metadata.overrides);
	for (const path of diagnostics.pendingOverridePaths) {
		const current = readMaterialVariantPath(diagnostics.variantState, path);
		overrides[path] = current.exists ? structuredClone(current.value) : null;
	}
	for (const conflict of diagnostics.conflicts) {
		const resolution = resolutions[conflict.path] ?? conflictPolicy;
		if (resolution === "keepVariant") {
			overrides[conflict.path] = conflict.variantExists ? structuredClone(conflict.variantValue) : null;
		}
	}
	for (const [path, value] of Object.entries(overrides)) {
		writeMaterialVariantPath(effectiveState, path, value);
	}
	const metadata: IMaterialVariantMetadata = {
		...diagnostics.metadata,
		version: 2,
		overrides,
		baseSnapshot: structuredClone(diagnostics.baseState),
	};
	try {
		applyMaterialVariantState(variant, effectiveState, metadata);
	} catch (error) {
		applyMaterialVariantState(variant, previousState, previousMetadata);
		throw error;
	}
	if (metadata.assetPath) {
		await writeJSON(resolveProjectPath(metadata.assetPath), variant.serialize(), { spaces: "\t", encoding: "utf-8" });
	}
	options?.editor.layout.inspector.setEditedObject(variant);
	options?.editor.layout.inspector.forceUpdate();
	return {
		...getMaterialVariant(scene, { materialId: variant.id }),
		rebased: true,
		inheritedPropertyCount: collectMaterialVariantComparisonPaths([{ exists: true, value: diagnostics.baseState }]).size,
		promotedOverridePaths: diagnostics.pendingOverridePaths,
		resolvedConflicts: diagnostics.conflicts.map((conflict) => ({ path: conflict.path, resolution: resolutions[conflict.path] ?? conflictPolicy })),
	};
}

/** Removes exact explicit override paths and restores those values from the immediate base material. */
export async function clearMaterialVariantOverrides(scene: Scene, data: any, options?: IMCPActionOptions): Promise<any> {
	const variant = resolveMaterial({ scene, materialId: data.materialId });
	const diagnostics = inspectMaterialVariant(variant);
	if (!Array.isArray(data.paths) || !data.paths.length) {
		throw new Error("At least one material variant override path is required.");
	}
	if (data.paths.length > 128) {
		throw new Error("At most 128 material variant override paths can be cleared at once.");
	}
	if (new Set(data.paths).size !== data.paths.length) {
		throw new Error("Material variant override paths must be unique.");
	}
	const state = structuredClone(diagnostics.variantState);
	const overrides = structuredClone(diagnostics.metadata.overrides);
	for (const path of data.paths) {
		if (typeof path !== "string" || !path.trim()) {
			throw new Error("Material variant override paths must be non-empty strings.");
		}
		if (!Object.prototype.hasOwnProperty.call(overrides, path)) {
			throw new Error(`Material variant has no exact override at path: ${path}`);
		}
		delete overrides[path];
		const inherited = readMaterialVariantPath(diagnostics.baseState, path);
		writeMaterialVariantPath(state, path, inherited.value, inherited.exists);
	}
	const metadata: IMaterialVariantMetadata = { ...diagnostics.metadata, version: 2, overrides };
	try {
		applyMaterialVariantState(variant, state, metadata);
	} catch (error) {
		applyMaterialVariantState(variant, diagnostics.variantState, diagnostics.metadata);
		throw error;
	}
	if (metadata.assetPath) {
		await writeJSON(resolveProjectPath(metadata.assetPath), variant.serialize(), { spaces: "\t", encoding: "utf-8" });
	}
	options?.editor.layout.inspector.setEditedObject(variant);
	options?.editor.layout.inspector.forceUpdate();
	return { ...getMaterialVariant(scene, { materialId: variant.id }), clearedOverridePaths: [...data.paths] };
}

/** Disposes a scene material. Persisted .material files are intentionally removed separately via delete_asset. */
export async function deleteMaterial(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const material = resolveMaterial({ scene, materialId: data.materialId });
	scene.meshes.filter((mesh) => mesh.material === material).forEach((mesh) => (mesh.material = null));
	const result = { deleted: true, id: material.id, name: material.name };
	const inspector = options.editor.layout.inspector;
	if (inspector?.state?.editedObject === material) {
		await new Promise<void>((resolveInspector) => inspector.setEditedObject(scene, resolveInspector));
	}
	material.dispose(false, false);
	inspector?.forceUpdate();
	return result;
}

function resolveNodeMaterial(scene: Scene, materialId: string): NodeMaterial {
	const material = resolveMaterial({ scene, materialId });
	if (!isNodeMaterial(material)) {
		throw new Error(`Material "${material.name}" is not a Node Material.`);
	}
	return material;
}

type IShaderGraphFloatMode = "default" | "slider" | "integer" | "enum";
type INodeMaterialBlackboardParameter = {
	name: string;
	inputName: string;
	label: string;
	type: number;
	min?: number;
	max?: number;
	defaultValue: any;
	connectorEnabled: boolean;
	floatMode: IShaderGraphFloatMode;
	enumOptions?: Array<{ label: string; value: number }>;
	staticValue?: any;
	description?: string;
};
type IShaderSubgraphAsset = { version: 1 | 2; name: string; graph: any; blackboard: INodeMaterialBlackboardParameter[] };
type IShaderVariant = { name: string; values: { name: string; value: any }[] };
type INodeMaterialCustomBlockParameter = { name: string; type: string };

const customBlockTypes = new Set(["Float", "Vector2", "Vector3", "Vector4", "Color3", "Color4", "Matrix", "sampler2D", "samplerCube", "sampler2DArray"]);

function customBlocks(material: NodeMaterial): any[] {
	return material.attachedBlocks
		.filter((block) => block.getClassName() === "CustomBlock")
		.map((block) => ({ name: block.name, ...(structuredClone((block as CustomBlock).options) ?? {}) }));
}

function blackboard(material: NodeMaterial): INodeMaterialBlackboardParameter[] {
	material.metadata ??= {};
	const parameters = (material.metadata.babylonEditorShaderBlackboard ??= []);
	material.metadata.babylonEditorShaderBlackboard = parameters.map(normalizeBlackboardParameter);
	return material.metadata.babylonEditorShaderBlackboard;
}

function normalizeBlackboardParameter(parameter: any): INodeMaterialBlackboardParameter {
	const floatMode = ["default", "slider", "integer", "enum"].includes(parameter.floatMode) ? parameter.floatMode : "default";
	return {
		name: parameter.name,
		inputName: parameter.inputName,
		label: parameter.label ?? parameter.name,
		type: parameter.type,
		min: parameter.min,
		max: parameter.max,
		defaultValue: parameter.defaultValue,
		connectorEnabled: parameter.connectorEnabled !== false,
		floatMode,
		enumOptions: floatMode === "enum" && Array.isArray(parameter.enumOptions) ? structuredClone(parameter.enumOptions) : undefined,
		staticValue: parameter.connectorEnabled === false ? structuredClone(parameter.staticValue ?? parameter.defaultValue) : undefined,
		description: typeof parameter.description === "string" ? parameter.description : undefined,
	};
}

function shaderVariants(material: NodeMaterial): IShaderVariant[] {
	material.metadata ??= {};
	return (material.metadata.babylonEditorShaderVariants ??= []);
}

/**
 * Gets the Node Material Editor graph and inspector-visible input blocks.
 */
export function getNodeMaterialGraph(scene: Scene, data: any): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	return {
		id: material.id,
		name: material.name,
		graph: material.serialize(),
		inputs: material
			.getInputBlocks()
			.filter((block) => block.visibleInInspector)
			.map((block) => ({ name: block.name, type: block.type, value: block.value, group: block.groupInInspector, min: block.min, max: block.max, comments: block.comments })),
		textureBlocks: material.getAllTextureBlocks().map((block) => ({ name: block.name, texture: block.texture?.name ?? null })),
		blackboard: structuredClone(blackboard(material)),
		customBlocks: customBlocks(material),
	};
}

/** Lists graph-native Babylon CustomBlock shader snippets attached to a Node Material. */
export function listNodeMaterialCustomBlocks(scene: Scene, data: any): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	return { materialId: material.id, blocks: customBlocks(material) };
}

/** Adds a graph-native CustomBlock. It can be wired in the Node Material Editor or a serialized graph after creation. */
export function addNodeMaterialCustomBlock(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const name = data.name?.trim();
	if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error("Custom block name must be a GLSL-safe identifier starting with a letter or underscore.");
	}
	if (material.attachedBlocks.some((block) => block.name === name)) {
		throw new Error(`A Node Material block named "${name}" already exists.`);
	}
	if (typeof data.functionName !== "string" || !data.functionName.trim()) {
		throw new Error("Custom block functionName must be a non-empty GLSL function signature.");
	}
	if (typeof data.code !== "string" || !data.code.trim()) {
		throw new Error("Custom block code must be a non-empty GLSL function body.");
	}
	const validateParameters = (parameters: INodeMaterialCustomBlockParameter[], kind: string): INodeMaterialCustomBlockParameter[] => {
		if (!Array.isArray(parameters) || !parameters.length) {
			throw new Error(`Custom block requires at least one ${kind} parameter.`);
		}
		for (const parameter of parameters) {
			if (!parameter.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter.name)) {
				throw new Error(`Custom block ${kind} parameter names must be GLSL-safe identifiers.`);
			}
			if (!customBlockTypes.has(parameter.type)) {
				throw new Error(`Unsupported CustomBlock ${kind} type "${parameter.type}".`);
			}
		}
		if (new Set(parameters.map((parameter) => parameter.name)).size !== parameters.length) {
			throw new Error(`Custom block ${kind} parameter names must be unique.`);
		}
		return parameters.map((parameter) => ({ name: parameter.name, type: parameter.type }));
	};
	const inParameters = validateParameters(data.inputs ?? [], "input");
	const outParameters = validateParameters(data.outputs ?? [], "output");
	const target = data.target ?? "Fragment";
	if (!["Vertex", "Fragment", "VertexAndFragment"].includes(target)) {
		throw new Error("Custom block target must be Vertex, Fragment, or VertexAndFragment.");
	}

	const block = new CustomBlock(name);
	block.options = { name, target, functionName: data.functionName.trim(), code: data.code.replace(/\r\n/g, "\n").split("\n"), inParameters, outParameters };
	material.attachedBlocks.push(block);
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return { materialId: material.id, block: customBlocks(material).find((candidate) => candidate.name === name) };
}

/** Removes one graph-native CustomBlock without modifying the remaining graph. */
export function deleteNodeMaterialCustomBlock(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const index = material.attachedBlocks.findIndex((block) => block.getClassName() === "CustomBlock" && block.name === data.name);
	if (index < 0) {
		throw new Error(`CustomBlock "${data.name}" was not found.`);
	}
	material.attachedBlocks.splice(index, 1);
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, name: data.name };
}

/** Lists persistent Shader Graph-style blackboard parameters bound to Node Material input blocks. */
export function getNodeMaterialBlackboard(scene: Scene, data: any): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	return { materialId: material.id, parameters: structuredClone(blackboard(material)) };
}

/** Saves a reusable Shader Graph subgraph asset from a Node Material graph and its blackboard. */
export async function saveNodeMaterialSubgraph(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const material = resolveNodeMaterial(scene, data.materialId);
	const outputPath = await resolveShaderSubgraphOutputPath(data.outputPath);
	const name = data.name?.trim() || material.name;
	if (!name) {
		throw new Error("Shader subgraph assets require a non-empty name.");
	}
	const asset: IShaderSubgraphAsset = { version: 2, name, graph: material.serialize(), blackboard: structuredClone(blackboard(material)) };
	await writeJSON(outputPath, asset, { spaces: "\t", encoding: "utf-8" });
	options.editor.layout.assets.refresh();
	const revision = createHash("sha256")
		.update(await readFile(outputPath))
		.digest("hex");
	return { name, version: 2, path: relative(getProjectDirectory(), outputPath), blackboardParameterCount: asset.blackboard.length, revision };
}

/** Reads a reusable Shader Graph subgraph asset without changing the active scene. */
export async function getNodeMaterialSubgraph(_scene: Scene, data: any): Promise<any> {
	const assetPath = await resolveExistingShaderSubgraphPath(data.path);
	const bytes = await readFile(assetPath);
	const asset = JSON.parse(bytes.toString("utf-8")) as IShaderSubgraphAsset;
	if (![1, 2].includes(asset?.version) || !asset.name || !asset.graph || !Array.isArray(asset.blackboard)) {
		throw new Error("Shader subgraph asset is invalid or uses an unsupported version.");
	}
	return {
		name: asset.name,
		version: 2,
		sourceVersion: asset.version,
		path: relative(getProjectDirectory(), assetPath),
		revision: createHash("sha256").update(bytes).digest("hex"),
		blackboard: asset.blackboard.map(normalizeBlackboardParameter),
		graph: asset.graph,
	};
}

/** Applies a reusable Shader Graph subgraph asset to an existing Node Material while retaining its scene identity. */
export async function applyNodeMaterialSubgraph(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const previous = resolveNodeMaterial(scene, data.materialId);
	const asset = await getNodeMaterialSubgraph(scene, { path: data.path });
	const replacement = NodeMaterial.Parse(asset.graph, scene, `${getProjectDirectory()}/`);
	replacement.id = previous.id;
	replacement.name = data.name ?? previous.name;
	replacement.metadata = { ...structuredClone(previous.metadata ?? {}), babylonEditorShaderBlackboard: structuredClone(asset.blackboard) };
	for (const parameter of asset.blackboard as INodeMaterialBlackboardParameter[]) {
		if (!parameter.connectorEnabled) {
			const input = replacement.getInputBlocks().find((candidate) => candidate.name === parameter.inputName);
			if (input) {
				input.value = toNodeMaterialInputValue(input.type, parameter.staticValue ?? parameter.defaultValue);
			}
		}
	}
	scene.meshes.filter((mesh) => mesh.material === previous).forEach((mesh) => (mesh.material = replacement));
	previous.dispose(false, false);
	options.editor.layout.inspector.setEditedObject(replacement);
	options.editor.layout.inspector.forceUpdate();
	return { ...getNodeMaterialGraph(scene, { materialId: replacement.id }), appliedSubgraph: { name: asset.name, path: asset.path } };
}

/** Replaces the Shader Graph-style parameter blackboard while retaining the Node Material graph. */
export function setNodeMaterialBlackboard(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	if (!Array.isArray(data.parameters)) {
		throw new Error("Blackboard parameters must be an array.");
	}
	const inputBlocks = material.getInputBlocks();
	const parameters = data.parameters.map((parameter: any) => {
		if (!parameter.name?.trim() || !parameter.inputName?.trim()) {
			throw new Error("Every blackboard parameter needs a non-empty name and inputName.");
		}
		const block = inputBlocks.find((candidate) => candidate.name === parameter.inputName);
		if (!block) {
			throw new Error(`Node Material input block not found: ${parameter.inputName}`);
		}
		if (parameter.min !== undefined && !Number.isFinite(parameter.min)) {
			throw new Error(`Blackboard minimum for ${parameter.name} must be finite.`);
		}
		if (parameter.max !== undefined && !Number.isFinite(parameter.max)) {
			throw new Error(`Blackboard maximum for ${parameter.name} must be finite.`);
		}
		if (parameter.min !== undefined && parameter.max !== undefined && parameter.max < parameter.min) {
			throw new Error(`Blackboard maximum for ${parameter.name} must be at least its minimum.`);
		}
		const floatMode: IShaderGraphFloatMode = parameter.floatMode ?? "default";
		if (!["default", "slider", "integer", "enum"].includes(floatMode)) {
			throw new Error(`Unsupported Shader Graph float mode for ${parameter.name}: ${String(floatMode)}.`);
		}
		if (floatMode !== "default" && block.type !== NodeMaterialBlockConnectionPointTypes.Float) {
			throw new Error(`Shader Graph float mode ${floatMode} requires a Float input block: ${parameter.inputName}.`);
		}
		let enumOptions: Array<{ label: string; value: number }> | undefined;
		if (floatMode === "enum") {
			if (!Array.isArray(parameter.enumOptions) || !parameter.enumOptions.length || parameter.enumOptions.length > 32) {
				throw new Error(`Shader Graph enum parameter ${parameter.name} requires 1-32 enum options.`);
			}
			const validatedEnumOptions = parameter.enumOptions.map((option: any) => {
				if (!option?.label?.trim() || option.label.length > 64 || !Number.isFinite(option.value)) {
					throw new Error(`Shader Graph enum options for ${parameter.name} require a finite value and a 1-64 character label.`);
				}
				return { label: option.label.trim(), value: option.value };
			});
			if (
				new Set(validatedEnumOptions.map((option) => option.label)).size !== validatedEnumOptions.length ||
				new Set(validatedEnumOptions.map((option) => option.value)).size !== validatedEnumOptions.length
			) {
				throw new Error(`Shader Graph enum option labels and values for ${parameter.name} must be unique.`);
			}
			enumOptions = validatedEnumOptions;
		}
		const connectorEnabled = parameter.connectorEnabled !== false;
		const staticValue = connectorEnabled ? undefined : (parameter.staticValue ?? parameter.defaultValue ?? block.value);
		if (!connectorEnabled && staticValue === undefined) {
			throw new Error(`Connector-disabled Shader Graph parameter ${parameter.name} requires a static value.`);
		}
		return {
			name: parameter.name,
			inputName: parameter.inputName,
			label: parameter.label ?? parameter.name,
			type: block.type,
			min: parameter.min,
			max: parameter.max,
			defaultValue: parameter.defaultValue ?? block.value,
			connectorEnabled,
			floatMode,
			enumOptions,
			staticValue: structuredClone(staticValue),
			description: parameter.description?.trim() || undefined,
		};
	});
	if (new Set(parameters.map((parameter: INodeMaterialBlackboardParameter) => parameter.name)).size !== parameters.length) {
		throw new Error("Blackboard parameter names must be unique.");
	}
	for (const parameter of parameters) {
		const block = inputBlocks.find((candidate) => candidate.name === parameter.inputName)!;
		block.visibleInInspector = true;
		block.comments = parameter.description ?? block.comments;
		block.min = parameter.min ?? block.min;
		block.max = parameter.max ?? block.max;
		if (!parameter.connectorEnabled) {
			block.value = toNodeMaterialInputValue(block.type, parameter.staticValue);
		}
	}
	material.metadata ??= {};
	material.metadata.babylonEditorShaderBlackboard = structuredClone(parameters);
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return getNodeMaterialBlackboard(scene, { materialId: material.id });
}

/** Sets blackboard-bound input values by parameter name. */
export function setNodeMaterialBlackboardValues(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const parameters = blackboard(material);
	const inputs = material.getInputBlocks();
	for (const update of data.values) {
		const parameter = parameters.find((candidate) => candidate.name === update.name);
		if (!parameter) {
			throw new Error(`Shader blackboard parameter not found: ${update.name}`);
		}
		if (!parameter.connectorEnabled) {
			throw new Error(`Shader blackboard parameter "${update.name}" is statically compiled and has no runtime connector.`);
		}
		const block = inputs.find((candidate) => candidate.name === parameter.inputName);
		if (!block) {
			throw new Error(`Node Material input block not found: ${parameter.inputName}`);
		}
		block.value = toNodeMaterialInputValue(block.type, update.value);
	}
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return getNodeMaterialGraph(scene, { materialId: material.id });
}

/** Lists reusable named Shader Graph blackboard-value variants. */
export function listNodeMaterialVariants(scene: Scene, data: any): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	return { materialId: material.id, variants: structuredClone(shaderVariants(material)) };
}

/** Creates or replaces one named Shader Graph variant after validating all blackboard parameter names. */
export function setNodeMaterialVariant(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	if (!data.name?.trim() || !Array.isArray(data.values) || !data.values.length) {
		throw new Error("Shader Graph variants require a non-empty name and at least one value.");
	}
	const names = new Set(blackboard(material).map((parameter) => parameter.name));
	for (const value of data.values) {
		if (!names.has(value.name)) {
			throw new Error(`Shader blackboard parameter not found: ${value.name}`);
		}
	}
	if (new Set(data.values.map((value: any) => value.name)).size !== data.values.length) {
		throw new Error("Shader Graph variant parameter names must be unique.");
	}
	const variants = shaderVariants(material);
	const variant: IShaderVariant = { name: data.name.trim(), values: structuredClone(data.values) };
	const index = variants.findIndex((candidate) => candidate.name === variant.name);
	if (index >= 0) {
		variants[index] = variant;
	} else {
		variants.push(variant);
	}
	options.editor.layout.inspector.forceUpdate();
	return listNodeMaterialVariants(scene, { materialId: material.id });
}

/** Applies one named Shader Graph variant through its blackboard bindings. */
export function applyNodeMaterialVariant(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const variant = shaderVariants(material).find((candidate) => candidate.name === data.name);
	if (!variant) {
		throw new Error(`Shader Graph variant not found: ${data.name}`);
	}
	setNodeMaterialBlackboardValues(scene, { materialId: material.id, values: variant.values }, options);
	return { ...getNodeMaterialGraph(scene, { materialId: material.id }), appliedVariant: variant.name };
}

/** Deletes a named Shader Graph variant without changing the graph or current values. */
export function deleteNodeMaterialVariant(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const variants = shaderVariants(material);
	const index = variants.findIndex((candidate) => candidate.name === data.name);
	if (index < 0) {
		throw new Error(`Shader Graph variant not found: ${data.name}`);
	}
	variants.splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, name: data.name };
}

/**
 * Builds a Node Material and reports actionable graph diagnostics without replacing the graph.
 * Babylon reports some invalid graph failures through an observable rather than throwing.
 */
export function validateNodeMaterialGraph(scene: Scene, data: any): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const errors: string[] = [];
	const observer = material.onBuildErrorObservable.add((message) => errors.push(message));
	try {
		material.build(false, true, false);
	} catch (error: any) {
		errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		material.onBuildErrorObservable.remove(observer);
	}

	const outputs = [...material._vertexOutputNodes, ...material._fragmentOutputNodes];
	if (!outputs.length) {
		errors.push("The graph has no vertex or fragment output blocks. Add and connect an output block before building.");
	}
	const reachable = new Set<number>();
	const visit = (block: any): void => {
		if (reachable.has(block.uniqueId)) {
			return;
		}
		reachable.add(block.uniqueId);
		block.inputs.forEach((input: any) => {
			if (input.connectedPoint) {
				visit(input.connectedPoint.ownerBlock);
			}
		});
	};
	outputs.forEach(visit);
	const blocks = material.attachedBlocks ?? [];
	const disconnectedInputs = blocks.flatMap((block) =>
		block.inputs.filter((input) => !input.isOptional && !input.isConnected && !input.connectInputBlock).map((input) => `${block.name}.${input.name}`)
	);
	const unreachableBlocks = blocks.filter((block) => !reachable.has(block.uniqueId)).map((block) => block.name);
	const warnings: string[] = [];
	let compiledShaderCharacters = 0;
	try {
		compiledShaderCharacters = material.compiledShaders.length;
	} catch {
		// A failed build has no compilation state to inspect.
	}
	if (disconnectedInputs.length) {
		warnings.push(`Required inputs are disconnected: ${disconnectedInputs.join(", ")}.`);
	}
	if (unreachableBlocks.length) {
		warnings.push(`Blocks do not contribute to an output: ${unreachableBlocks.join(", ")}.`);
	}
	if (!material.getAllTextureBlocks().length) {
		warnings.push("The graph has no texture blocks; this is expected for procedural or color-only materials.");
	}
	return {
		materialId: material.id,
		valid: errors.length === 0,
		errors: [...new Set(errors)],
		warnings,
		statistics: {
			outputBlocks: outputs.map((block) => ({ name: block.name, className: block.getClassName() })),
			attachedBlockCount: blocks.length,
			reachableBlockCount: reachable.size,
			textureBlockCount: material.getAllTextureBlocks().length,
			compiledShaderCharacters,
		},
	};
}

/** Removes only blocks with no dependency path to a vertex or fragment output. */
export function stripNodeMaterialUnusedBlocks(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const reachable = new Set<number>();
	const visit = (block: any): void => {
		if (reachable.has(block.uniqueId)) {
			return;
		}
		reachable.add(block.uniqueId);
		block.inputs.forEach((input: any) => input.connectedPoint && visit(input.connectedPoint.ownerBlock));
	};
	[...material._vertexOutputNodes, ...material._fragmentOutputNodes].forEach(visit);
	const removed = material.attachedBlocks.filter((block) => !reachable.has(block.uniqueId)).map((block) => ({ name: block.name, className: block.getClassName() }));
	material.attachedBlocks = material.attachedBlocks.filter((block) => reachable.has(block.uniqueId));
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return { materialId: material.id, removed, remainingBlockCount: material.attachedBlocks.length };
}

function toNodeMaterialInputValue(type: NodeMaterialBlockConnectionPointTypes, value: any): any {
	if (!Array.isArray(value)) {
		return value;
	}
	switch (type) {
		case NodeMaterialBlockConnectionPointTypes.Vector2:
			return Vector2.FromArray(value);
		case NodeMaterialBlockConnectionPointTypes.Vector3:
			return Vector3.FromArray(value);
		case NodeMaterialBlockConnectionPointTypes.Vector4:
			return Vector4.FromArray(value);
		case NodeMaterialBlockConnectionPointTypes.Color3:
			return Color3.FromArray(value);
		case NodeMaterialBlockConnectionPointTypes.Color4:
			return Color4.FromArray(value);
		default:
			return value;
	}
}

/**
 * Updates visible Node Material input block values without replacing its graph.
 */
export function setNodeMaterialInputs(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveNodeMaterial(scene, data.materialId);
	const blocks = material.getInputBlocks();
	for (const update of data.inputs) {
		const block = blocks.find((candidate) => candidate.name === update.name);
		if (!block) {
			throw new Error(`Node Material input block not found: ${update.name}`);
		}
		block.value = toNodeMaterialInputValue(block.type, update.value);
	}
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return getNodeMaterialGraph(scene, { materialId: material.id });
}

/**
 * Replaces a Node Material Editor graph using its serialized NodeMaterial format.
 */
export function replaceNodeMaterialGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = resolveNodeMaterial(scene, data.materialId);
	const replacement = NodeMaterial.Parse(data.graph, scene, `${getProjectDirectory()}/`);
	replacement.id = previous.id;
	if (data.name !== undefined) {
		replacement.name = data.name;
	} else {
		replacement.name = previous.name;
	}
	replacement.metadata = structuredClone(previous.metadata ?? {});

	scene.meshes.filter((mesh) => mesh.material === previous).forEach((mesh) => (mesh.material = replacement));
	previous.dispose(false, false);
	options.editor.layout.inspector.setEditedObject(replacement);
	options.editor.layout.inspector.forceUpdate();
	return getNodeMaterialGraph(scene, { materialId: replacement.id });
}

/**
 * Loads a texture asset and assigns it to a material channel.
 */
export async function assignTextureToMaterial(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const material = resolveMaterial({ scene, materialId: data.materialId });

	const absolutePath = resolveProjectPath(data.texturePath);
	const extension = extname(absolutePath).toLowerCase();

	let texture: Texture | CubeTexture;
	if (extension === ".env") {
		texture = configureImportedTexture(CubeTexture.CreateFromPrefilteredData(absolutePath, scene));
	} else if (requiresDecodedTextureImporterArtifact(absolutePath)) {
		const imported = await getOrApplyTextureImporterArtifact(absolutePath);
		texture = configureImportedTexture(new Texture(imported.result!.outputPath, scene));
		const authoredPath = relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/");
		texture.name = authoredPath;
		texture.url = authoredPath;
		texture.metadata = { ...(texture.metadata ?? {}), babylonEditorAuthoredTexturePath: authoredPath };
	} else {
		texture = configureImportedTexture(new Texture(absolutePath, scene));
	}

	(material as any)[data.channel] = texture;
	recordMaterialVariantOverrides(material, { [data.channel]: texture.serialize() });

	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();

	return {
		id: material.id,
		name: material.name,
		className: material.getClassName(),
		channel: data.channel,
		texture: relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/"),
		deferredCameras: getDeferredLightingRuntimes(scene as any),
	};
}

/** Returns the baked-lightmap consumption settings of a PBR or Standard material. */
export function getMaterialLightmap(scene: Scene, data: any): any {
	const material = resolveMaterial({ scene, materialId: data.materialId }) as any;
	if (!("lightmapTexture" in material)) {
		throw new Error(`Material "${material.name}" does not support Babylon lightmaps. Use a PBR or Standard material.`);
	}
	const texture = material.lightmapTexture as Texture | null;
	return {
		materialId: material.id,
		materialName: material.name,
		lightmapTexture: texture ? { name: texture.name, url: texture.url, coordinatesIndex: texture.coordinatesIndex, level: texture.level } : null,
		useLightmapAsShadowmap: material.useLightmapAsShadowmap ?? false,
	};
}

/** Assigns or clears a pre-baked lightmap texture, including UV set/intensity and shadowmap mode. */
export function setMaterialLightmap(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = resolveMaterial({ scene, materialId: data.materialId }) as any;
	if (!("lightmapTexture" in material)) {
		throw new Error(`Material "${material.name}" does not support Babylon lightmaps. Use a PBR or Standard material.`);
	}
	if (data.texturePath === null) {
		material.lightmapTexture?.dispose();
		material.lightmapTexture = null;
	} else if (data.texturePath !== undefined) {
		const absolutePath = resolveProjectPath(data.texturePath);
		const previous = material.lightmapTexture as Texture | null;
		material.lightmapTexture = configureImportedTexture(new Texture(absolutePath, scene));
		previous?.dispose();
	}
	if (data.coordinatesIndex !== undefined) {
		if (!Number.isInteger(data.coordinatesIndex) || data.coordinatesIndex < 0 || data.coordinatesIndex > 5) {
			throw new Error("coordinatesIndex must be an integer UV set from 0 through 5.");
		}
		if (!material.lightmapTexture) {
			throw new Error("Assign a lightmap texture before selecting its UV set.");
		}
		material.lightmapTexture.coordinatesIndex = data.coordinatesIndex;
	}
	if (data.level !== undefined) {
		if (!Number.isFinite(data.level) || data.level < 0) {
			throw new Error("level must be a finite non-negative lightmap intensity.");
		}
		if (!material.lightmapTexture) {
			throw new Error("Assign a lightmap texture before setting its intensity.");
		}
		material.lightmapTexture.level = data.level;
	}
	if (data.useLightmapAsShadowmap !== undefined) {
		material.useLightmapAsShadowmap = data.useLightmapAsShadowmap;
	}
	const variantOverrides: Record<string, any> = {};
	if (data.texturePath !== undefined || data.coordinatesIndex !== undefined || data.level !== undefined) {
		variantOverrides.lightmapTexture = material.lightmapTexture?.serialize() ?? null;
	}
	if (data.useLightmapAsShadowmap !== undefined) {
		variantOverrides.useLightmapAsShadowmap = material.useLightmapAsShadowmap;
	}
	recordMaterialVariantOverrides(material, variantOverrides);
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return getMaterialLightmap(scene, { materialId: material.id });
}

/**
 * Paints one channel of a TerrainMaterial RGB splat map. The generated PNG is deliberately kept
 * as a normal project asset, so it follows the editor's existing texture save/load/export path.
 */
export async function paintTerrainLayer(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const material = resolveMaterial({ scene, materialId: data.materialId });
	if (!(material instanceof TerrainMaterial)) {
		throw new Error(`Material "${material.name}" is not a TerrainMaterial. Create or select a Terrain Material first.`);
	}
	if (!Array.isArray(data.center) || data.center.length !== 2 || !data.center.every(Number.isFinite) || data.center.some((value: number) => value < 0 || value > 1)) {
		throw new Error("Terrain paint center must be normalized UV coordinates [u, v] between 0 and 1.");
	}
	if (!Number.isFinite(data.radius) || data.radius <= 0 || data.radius > 1) {
		throw new Error("Terrain paint radius must be greater than 0 and at most 1 in normalized UV space.");
	}
	if (!Number.isFinite(data.strength) || data.strength < 0 || data.strength > 1) {
		throw new Error("Terrain paint strength must be between 0 and 1.");
	}
	if (![0, 1, 2].includes(data.layer)) {
		throw new Error("Terrain paint layer must be 0 (red), 1 (green), or 2 (blue).");
	}

	const outputPath = resolveGeneratedProjectPath(data.outputPath);
	if (extname(outputPath).toLowerCase() !== ".png") {
		throw new Error("Terrain splat maps must be written as .png files.");
	}
	const sourcePath = data.sourcePath ? resolveGeneratedProjectPath(data.sourcePath) : (await pathExists(outputPath)) ? outputPath : null;
	if (sourcePath && !(await pathExists(sourcePath))) {
		throw new Error(`Terrain paint source image not found: ${data.sourcePath}`);
	}

	const dimensions = sourcePath ? await sharp(sourcePath).metadata() : { width: data.width ?? 1024, height: data.height ?? data.width ?? 1024 };
	const width = dimensions.width;
	const height = dimensions.height;
	if (!width || !height || width < 1 || height < 1 || width > 4096 || height > 4096) {
		throw new Error("Terrain splat maps must be between 1 and 4096 pixels on each side.");
	}

	const rgba = sourcePath
		? await sharp(sourcePath, { animated: false }).ensureAlpha().raw().toBuffer()
		: await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } })
				.ensureAlpha()
				.raw()
				.toBuffer();
	const hardness = data.hardness ?? 1;
	if (!Number.isFinite(hardness) || hardness <= 0 || hardness > 16) {
		throw new Error("Terrain paint hardness must be greater than 0 and at most 16.");
	}

	let changedPixels = 0;
	const centreX = data.center[0] * (width - 1);
	const centreY = data.center[1] * (height - 1);
	const radiusPixels = data.radius * Math.max(width - 1, height - 1);
	const startX = Math.max(0, Math.floor(centreX - radiusPixels));
	const endX = Math.min(width - 1, Math.ceil(centreX + radiusPixels));
	const startY = Math.max(0, Math.floor(centreY - radiusPixels));
	const endY = Math.min(height - 1, Math.ceil(centreY + radiusPixels));
	for (let y = startY; y <= endY; y++) {
		for (let x = startX; x <= endX; x++) {
			const distance = Math.hypot(x - centreX, y - centreY) / radiusPixels;
			if (distance > 1) {
				continue;
			}
			const blend = data.strength * Math.pow(1 - distance, hardness);
			if (!blend) {
				continue;
			}
			const offset = (y * width + x) * 4;
			const current = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
			const sum = current[0] + current[1] + current[2];
			const weights = sum ? current.map((value) => value / sum) : [1, 0, 0];
			for (let channel = 0; channel < 3; channel++) {
				weights[channel] = weights[channel] * (1 - blend) + (channel === data.layer ? blend : 0);
			}
			const normalized = weights.map((value) => Math.round(value * 255));
			normalized[data.layer] += 255 - normalized[0] - normalized[1] - normalized[2];
			if (normalized.some((value, channel) => value !== current[channel])) {
				changedPixels++;
			}
			rgba[offset] = normalized[0];
			rgba[offset + 1] = normalized[1];
			rgba[offset + 2] = normalized[2];
			rgba[offset + 3] = 255;
		}
	}

	await ensureDir(dirname(outputPath));
	await sharp(rgba, { raw: { width, height, channels: 4 } })
		.png()
		.toFile(outputPath);
	const previous = material.mixTexture;
	material.mixTexture = configureImportedTexture(new Texture(outputPath, scene));
	if (previous && previous !== material.mixTexture) {
		previous.dispose();
	}
	material.metadata ??= {};
	material.metadata.babylonEditorTerrainSplatMap = {
		path: relative(getProjectDirectory(), outputPath),
		width,
		height,
		lastBrush: { center: [...data.center], radius: data.radius, strength: data.strength, hardness, layer: data.layer },
	};
	options.editor.layout.assets?.refresh();
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return {
		materialId: material.id,
		outputPath: relative(getProjectDirectory(), outputPath),
		width,
		height,
		changedPixels,
		layer: data.layer,
	};
}

const environmentTextureMetadataKey = "babylonEditorEnvironmentTexture";
const environmentSkyboxMetadataKey = "babylonEditorEnvironmentSkybox";

function environmentSkyboxes(scene: Scene): any[] {
	return scene.meshes.filter((mesh: any) => mesh.metadata?.[environmentSkyboxMetadataKey]);
}

function environmentRevision(scene: Scene): string {
	const texture = scene.environmentTexture as any;
	return createHash("sha256")
		.update(
			JSON.stringify({
				texture: texture
					? {
							className: texture.getClassName(),
							name: texture.name,
							url: texture.url ?? null,
							authoredPath: texture.metadata?.babylonEditorAuthoredTexturePath ?? texture.metadata?.[environmentTextureMetadataKey]?.path ?? null,
							level: texture.level,
							gammaSpace: texture.gammaSpace,
						}
					: null,
				iblIntensity: scene.iblIntensity,
				skyboxes: environmentSkyboxes(scene)
					.map((mesh) => ({ id: mesh.id, name: mesh.name }))
					.sort((left, right) => left.id.localeCompare(right.id)),
			})
		)
		.digest("hex");
}

/** Reads exact environment/skybox authorship and deferred IBL execution evidence. */
export function getEnvironmentLighting(scene: Scene): any {
	const texture = scene.environmentTexture as any;
	const size = texture?.getSize?.();
	return {
		revision: environmentRevision(scene),
		iblIntensity: scene.iblIntensity,
		texture: texture
			? {
					className: texture.getClassName(),
					name: texture.name,
					url: texture.url ?? null,
					authoredPath: texture.metadata?.babylonEditorAuthoredTexturePath ?? texture.metadata?.[environmentTextureMetadataKey]?.path ?? null,
					ready: texture.isReadyOrNotBlocking(),
					width: size?.width ?? 0,
					height: size?.height ?? 0,
					level: texture.level,
					gammaSpace: texture.gammaSpace,
					rgbd: texture.isRGBD,
					ownedByEnvironmentTool: Boolean(texture.metadata?.[environmentTextureMetadataKey]),
				}
			: null,
		skyboxes: environmentSkyboxes(scene).map((mesh: any) => ({ id: mesh.id, name: mesh.name, materialId: mesh.material?.id ?? null })),
		deferredCameras: getDeferredLightingRuntimes(scene as any)
			.filter((runtime) => runtime.iblEnvironmentTextureName)
			.map((runtime) => ({
				cameraId: runtime.cameraId,
				cameraName: runtime.cameraName,
				active: runtime.active,
				ready: runtime.iblReady,
				environmentTextureName: runtime.iblEnvironmentTextureName,
				frameCount: runtime.iblFrameCount,
			})),
	};
}

function disposeOwnedEnvironmentSkyboxes(scene: Scene): string[] {
	const removed: string[] = [];
	for (const mesh of environmentSkyboxes(scene)) {
		const material = mesh.material;
		mesh.material = null;
		removed.push(mesh.id);
		mesh.dispose(false, false);
		material?.dispose(false, false);
	}
	return removed;
}

function textureStillReferenced(scene: Scene, texture: any): boolean {
	return scene.materials.some((material: any) =>
		["reflectionTexture", "environmentTexture", "_radianceTexture"].some((property) => property in material && material[property] === texture)
	);
}

/** Sets, tunes, or clears the scene environment under an exact content lease. */
export async function setEnvironmentTexture(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const currentRevision = environmentRevision(scene);
	if (data.expectedRevision !== currentRevision) {
		throw new Error(`Environment lighting changed after inspection. Expected revision ${String(data.expectedRevision)}, but the current revision is ${currentRevision}.`);
	}
	if (data.texturePath === undefined && data.iblIntensity === undefined && data.createSkybox === undefined && data.removeSkyboxes !== true) {
		throw new Error("Set at least one environment field: texturePath, iblIntensity, createSkybox, or removeSkyboxes.");
	}
	let texture: CubeTexture | HDRCubeTexture | EXRCubeTexture | null | undefined;
	if (typeof data.texturePath === "string") {
		const absolutePath = resolveProjectPath(data.texturePath);
		const extension = extname(absolutePath).toLowerCase();
		if (extension === ".env") {
			texture = configureImportedTexture(CubeTexture.CreateFromPrefilteredData(absolutePath, scene));
		} else if (extension === ".hdr" || extension === ".exr") {
			const imported = await getOrApplyTextureImporterArtifact(absolutePath);
			const outputPath = imported.result?.outputPath;
			if (!outputPath || !imported.result?.highDynamicRange?.environmentPath) {
				throw new Error("HDR/EXR environment textures must import successfully as a 2:1 equirectangular panorama.");
			}
			texture =
				extension === ".exr"
					? configureImportedTexture(new EXRCubeTexture(outputPath, scene, imported.result.highDynamicRange.cubeFaceSize ?? 512))
					: configureImportedTexture(new HDRCubeTexture(outputPath, scene, imported.result.highDynamicRange.cubeFaceSize ?? 512));
		} else {
			throw new Error("Environment textures must use .env, .hdr, or .exr assets.");
		}
		const authoredPath = relative(getProjectDirectory(), absolutePath).replace(/\\/g, "/");
		texture.name = authoredPath;
		texture.url = authoredPath;
		texture.metadata = {
			...(texture.metadata ?? {}),
			babylonEditorAuthoredTexturePath: authoredPath,
			[environmentTextureMetadataKey]: { version: 1, path: authoredPath },
		};
	} else if (data.texturePath === null) {
		texture = null;
	}
	if (data.createSkybox === true && !(texture !== undefined ? texture : scene.environmentTexture)) {
		throw new Error("A skybox requires an environment texture. Set texturePath in the same request or first assign one.");
	}
	const previousTexture = scene.environmentTexture as any;
	if (texture !== undefined) {
		scene.environmentTexture = texture;
	}
	if (data.iblIntensity !== undefined) {
		scene.iblIntensity = data.iblIntensity;
	}
	let removedSkyboxIds: string[] = [];
	if (data.removeSkyboxes === true || data.texturePath === null || data.createSkybox === true) {
		removedSkyboxIds = disposeOwnedEnvironmentSkyboxes(scene);
	}
	if (data.createSkybox === true) {
		const skybox = scene.createDefaultSkybox(scene.environmentTexture!, true, data.skyboxSize ?? 10_000, data.skyboxBlur ?? 0.3, false);
		if (!skybox) {
			throw new Error("Babylon could not create the environment skybox.");
		}
		skybox.metadata ??= {};
		skybox.metadata[environmentSkyboxMetadataKey] = { version: 1 };
	} else if (texture && environmentSkyboxes(scene).length) {
		for (const skybox of environmentSkyboxes(scene)) {
			if (skybox.material && "reflectionTexture" in skybox.material) {
				(skybox.material as any).reflectionTexture = texture;
			}
		}
	}
	if (
		previousTexture &&
		previousTexture !== scene.environmentTexture &&
		previousTexture.metadata?.[environmentTextureMetadataKey] &&
		!textureStillReferenced(scene, previousTexture)
	) {
		previousTexture.dispose();
	}

	options.editor.layout.inspector.forceUpdate();
	return { ...getEnvironmentLighting(scene), removedSkyboxIds };
}
