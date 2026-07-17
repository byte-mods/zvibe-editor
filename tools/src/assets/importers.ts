import { serializeModelAnimationClipDefinitions } from "./model-animation-clips";
import { serializeModelMaterialRemaps } from "./model-material-remaps";
import { serializeModelAuthoredLodGroups, serializeModelLodDefinitions } from "./model-lods";
import { serializeModelImporterPlatformOverrides } from "./model-platform-overrides";

export const ASSET_IMPORTER_CONFIGURATION_VERSION = 1;

export type AssetImporterKind = "texture" | "model" | "audio" | "video" | "font" | "material" | "animation" | "custom";
export type AssetImporterFieldType = "boolean" | "number" | "string" | "enum";

export interface IAssetImporterFieldDefinition {
	key: string;
	label: string;
	type: AssetImporterFieldType;
	description: string;
	values?: string[];
	minimum?: number;
	maximum?: number;
	step?: number;
	integer?: boolean;
}

export interface IAssetImporterDefinition {
	kind: AssetImporterKind;
	label: string;
	extensions: string[];
	fields: IAssetImporterFieldDefinition[];
}

export interface IAssetImporterConfiguration {
	version: 1;
	kind: AssetImporterKind;
	settings: Record<string, boolean | number | string>;
	extra?: Record<string, unknown>;
}

const commonFields: IAssetImporterFieldDefinition[] = [
	{ key: "includeInBuild", label: "Include In Build", type: "boolean", description: "Copy this asset into generated Web/Desktop build output." },
];

const definitions: IAssetImporterDefinition[] = [
	{
		kind: "texture",
		label: "Texture Importer",
		extensions: ["png", "jpg", "jpeg", "bmp", "webp", "gif", "tif", "tiff", "svg", "exr", "hdr", "env", "dds"],
		fields: [
			...commonFields,
			{
				key: "textureType",
				label: "Texture Type",
				type: "enum",
				description: "How the texture will be interpreted by authoring/runtime workflows.",
				values: ["default", "normalMap", "sprite", "lightmap", "cursor"],
			},
			{ key: "colorSpace", label: "Color Space", type: "enum", description: "Decode color channels as sRGB or linear data.", values: ["sRGB", "linear"] },
			{ key: "alphaSource", label: "Alpha Source", type: "enum", description: "Keep source alpha or treat the texture as opaque.", values: ["input", "none"] },
			{ key: "generateMipmaps", label: "Generate Mipmaps", type: "boolean", description: "Generate downscaled texture variants during optimized builds." },
			{ key: "maxSize", label: "Max Size", type: "number", description: "Maximum output width or height in pixels.", minimum: 32, maximum: 16384, step: 32, integer: true },
			{
				key: "resizeAlgorithm",
				label: "Resize Algorithm",
				type: "enum",
				description: "Sampling kernel used when the build pipeline limits texture size.",
				values: ["nearest", "bilinear", "bicubic", "lanczos3"],
			},
			{ key: "compression", label: "Compression", type: "enum", description: "Requested build compression preference.", values: ["none", "low", "normal", "high"] },
			{ key: "readable", label: "CPU Readable", type: "boolean", description: "Declare that gameplay code needs CPU pixel access." },
		],
	},
	{
		kind: "model",
		label: "Model Importer",
		extensions: ["glb", "gltf", "babylon", "fbx", "obj", "stl", "dae", "3ds"],
		fields: [
			...commonFields,
			{
				key: "scaleFactor",
				label: "Scale Factor",
				type: "number",
				description: "Scale applied when the model is instantiated/imported.",
				minimum: 0.0001,
				maximum: 100000,
				step: 0.01,
			},
			{ key: "convertUnits", label: "Convert Units", type: "boolean", description: "Convert source units to editor centimeters." },
			{ key: "importMaterials", label: "Import Materials", type: "boolean", description: "Import model material data." },
			{
				key: "materialNaming",
				label: "Material Naming",
				type: "enum",
				description: "Name used when automatically searching for an existing project material.",
				values: ["sourceMaterial", "baseTextureName", "modelAndMaterial"],
			},
			{
				key: "materialSearch",
				label: "Material Search",
				type: "enum",
				description: "Search no materials, the adjacent Materials folder, parent Materials folders, or the full project.",
				values: ["none", "local", "recursiveUp", "projectWide"],
			},
			{
				key: "materialRemaps",
				label: "Material Remaps",
				type: "string",
				description: "Strict JSON source-material to project .material replacements authored by the Model Inspector.",
			},
			{
				key: "authoredLods",
				label: "Authored LOD Groups",
				type: "string",
				description: "Strict JSON source mesh and existing lower-detail mesh assignments authored by the Model Inspector.",
			},
			{
				key: "generatedLods",
				label: "Generated LODs",
				type: "string",
				description: "Strict JSON distance/quality levels generated for every eligible static, skinned, or morph-target imported mesh.",
			},
			{
				key: "platformOverrides",
				label: "Platform Overrides",
				type: "string",
				description: "Strict JSON Web/Desktop model-processing overrides authored by the Model Inspector.",
			},
			{ key: "importTextures", label: "Import Textures", type: "boolean", description: "Import texture references embedded by the model." },
			{ key: "importAnimations", label: "Import Animations", type: "boolean", description: "Import animation clips contained in the model." },
			{
				key: "animationClips",
				label: "Animation Clips",
				type: "string",
				description:
					"Strict JSON clip definitions authored by the Model Inspector: source AnimationGroup, frame range, loop controls, target mask, and root-motion selection.",
			},
			{
				key: "animationType",
				label: "Rig Animation Type",
				type: "enum",
				description: "Interpret the imported skeleton as no animation rig, a Generic rig, or a canonical Humanoid Avatar candidate.",
				values: ["none", "generic", "humanoid"],
			},
			{
				key: "optimizeGameObjects",
				label: "Optimize Game Object",
				type: "boolean",
				description: "Remove skeleton-only Transform nodes, retarget animation to Babylon bones, and flatten retained attachment proxies for lower character CPU overhead.",
			},
			{
				key: "exposedTransforms",
				label: "Extra Transforms to Expose",
				type: "string",
				description:
					"Comma- or line-separated full hierarchy paths or unique bone names that remain available to scripts and attachments when Optimize Game Object is enabled.",
			},
			{ key: "generateColliders", label: "Generate Colliders", type: "boolean", description: "Request collider generation for imported meshes." },
			{ key: "meshCompression", label: "Mesh Compression", type: "enum", description: "Requested mesh-data compression level.", values: ["none", "low", "medium", "high"] },
			{ key: "optimizeMesh", label: "Optimize Mesh", type: "boolean", description: "Request vertex/index optimization." },
			{ key: "weldVertices", label: "Weld Vertices", type: "boolean", description: "Merge equivalent imported vertices." },
			{ key: "normals", label: "Normals", type: "enum", description: "Import, calculate, or omit vertex normals.", values: ["import", "calculate", "none"] },
			{ key: "tangents", label: "Tangents", type: "enum", description: "Import, calculate, or omit vertex tangents.", values: ["import", "calculate", "none"] },
		],
	},
	{
		kind: "audio",
		label: "Audio Importer",
		extensions: ["mp3", "ogg", "wav", "wave", "flac", "m4a"],
		fields: [
			...commonFields,
			{
				key: "loadType",
				label: "Load Type",
				type: "enum",
				description: "Requested runtime loading strategy.",
				values: ["decompressOnLoad", "compressedInMemory", "streaming"],
			},
			{ key: "compressionFormat", label: "Compression Format", type: "enum", description: "Requested output encoding strategy.", values: ["preserve", "browser"] },
			{ key: "quality", label: "Quality", type: "number", description: "Requested lossy encoding quality.", minimum: 0, maximum: 1, step: 0.01 },
			{ key: "sampleRate", label: "Sample Rate", type: "enum", description: "Requested output sample rate.", values: ["preserve", "22050", "44100", "48000"] },
			{ key: "forceMono", label: "Force Mono", type: "boolean", description: "Downmix the source to one channel." },
			{ key: "normalize", label: "Normalize", type: "boolean", description: "Normalize amplitude during transcoding." },
		],
	},
	{
		kind: "video",
		label: "Video Importer",
		extensions: ["mp4", "webm", "ogv", "mov"],
		fields: [
			...commonFields,
			{ key: "transcode", label: "Transcode", type: "enum", description: "Requested build output codec/container.", values: ["preserve", "webm", "mp4"] },
			{ key: "quality", label: "Quality", type: "number", description: "Requested transcoding quality.", minimum: 0, maximum: 1, step: 0.01 },
			{ key: "maxWidth", label: "Max Width", type: "number", description: "Maximum output width.", minimum: 64, maximum: 8192, step: 2, integer: true },
			{ key: "maxHeight", label: "Max Height", type: "number", description: "Maximum output height.", minimum: 64, maximum: 8192, step: 2, integer: true },
			{ key: "includeAudio", label: "Include Audio", type: "boolean", description: "Retain the source audio track." },
		],
	},
	{
		kind: "font",
		label: "Font Importer",
		extensions: ["ttf", "otf", "woff", "woff2"],
		fields: [
			...commonFields,
			{
				key: "renderMode",
				label: "Render Mode",
				type: "enum",
				description: "Requested bitmap or distance-field atlas representation.",
				values: ["dynamic", "bitmap", "sdf", "msdf"],
			},
			{ key: "characterSet", label: "Character Set", type: "enum", description: "Characters included in a generated atlas.", values: ["ascii", "latin1", "custom"] },
			{ key: "customCharacters", label: "Custom Characters", type: "string", description: "Custom atlas character sequence, limited to 4096 code units." },
			{ key: "fontSize", label: "Font Size", type: "number", description: "Requested atlas font size.", minimum: 8, maximum: 256, step: 1, integer: true },
			{ key: "padding", label: "Padding", type: "number", description: "Atlas glyph padding.", minimum: 0, maximum: 64, step: 1, integer: true },
			{ key: "distanceRange", label: "Distance Range", type: "number", description: "SDF/MSDF distance range.", minimum: 1, maximum: 32, step: 1, integer: true },
		],
	},
	{
		kind: "material",
		label: "Material Importer",
		extensions: ["material", "mtl"],
		fields: [
			...commonFields,
			{ key: "validateTextures", label: "Validate Textures", type: "boolean", description: "Validate referenced project textures." },
			{ key: "extractEmbeddedTextures", label: "Extract Embedded Textures", type: "boolean", description: "Extract embedded texture payloads during optimized builds." },
			{ key: "compileNodeMaterial", label: "Compile Node Material", type: "boolean", description: "Validate/compile node-material graphs before build." },
		],
	},
	{
		kind: "animation",
		label: "Animation Importer",
		extensions: ["animation", "animations", "animator", "controller"],
		fields: [
			...commonFields,
			{ key: "importClips", label: "Import Clips", type: "boolean", description: "Import clip data from the source." },
			{ key: "resampleRate", label: "Resample Rate", type: "number", description: "Requested animation sample rate.", minimum: 1, maximum: 240, step: 1, integer: true },
			{ key: "compression", label: "Compression", type: "enum", description: "Requested keyframe compression.", values: ["none", "keyframeReduction"] },
			{ key: "loopByDefault", label: "Loop By Default", type: "boolean", description: "Mark imported clips as looping by default." },
			{ key: "rootMotionNode", label: "Root Motion Node", type: "string", description: "Optional source node name used for root motion." },
		],
	},
	{
		kind: "custom",
		label: "Custom Importer",
		extensions: [],
		fields: [
			...commonFields,
			{ key: "importerId", label: "Importer ID", type: "string", description: "Project/plugin importer identifier." },
			{ key: "enabled", label: "Enabled", type: "boolean", description: "Enable the selected custom importer." },
		],
	},
];

const defaults: Record<AssetImporterKind, Record<string, boolean | number | string>> = {
	texture: {
		includeInBuild: true,
		textureType: "default",
		colorSpace: "sRGB",
		alphaSource: "input",
		generateMipmaps: true,
		maxSize: 4096,
		resizeAlgorithm: "lanczos3",
		compression: "normal",
		readable: false,
	},
	model: {
		includeInBuild: true,
		scaleFactor: 1,
		convertUnits: true,
		importMaterials: true,
		materialNaming: "sourceMaterial",
		materialSearch: "none",
		materialRemaps: "[]",
		authoredLods: "[]",
		generatedLods: "[]",
		platformOverrides: "{}",
		importTextures: true,
		importAnimations: true,
		animationClips: "[]",
		animationType: "generic",
		optimizeGameObjects: false,
		exposedTransforms: "",
		generateColliders: false,
		meshCompression: "none",
		optimizeMesh: true,
		weldVertices: true,
		normals: "import",
		tangents: "import",
	},
	audio: { includeInBuild: true, loadType: "compressedInMemory", compressionFormat: "preserve", quality: 0.8, sampleRate: "preserve", forceMono: false, normalize: false },
	video: { includeInBuild: true, transcode: "preserve", quality: 0.8, maxWidth: 1920, maxHeight: 1080, includeAudio: true },
	font: { includeInBuild: true, renderMode: "dynamic", characterSet: "ascii", customCharacters: "", fontSize: 48, padding: 4, distanceRange: 4 },
	material: { includeInBuild: true, validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true },
	animation: { includeInBuild: true, importClips: true, resampleRate: 60, compression: "keyframeReduction", loopByDefault: false, rootMotionNode: "" },
	custom: { includeInBuild: true, importerId: "", enabled: true },
};

export function listAssetImporterDefinitions(): IAssetImporterDefinition[] {
	return definitions.map((definition) => ({
		...definition,
		extensions: [...definition.extensions],
		fields: definition.fields.map((field) => ({ ...field, values: field.values ? [...field.values] : undefined })),
	}));
}

export function inferAssetImporterKind(path: string): AssetImporterKind {
	const extension = path.replace(/\\/g, "/").split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";
	return definitions.find((definition) => definition.kind !== "custom" && definition.extensions.includes(extension))?.kind ?? "custom";
}

export function getDefaultAssetImporterConfiguration(pathOrKind: string): IAssetImporterConfiguration {
	const kind = definitions.some((definition) => definition.kind === pathOrKind) ? (pathOrKind as AssetImporterKind) : inferAssetImporterKind(pathOrKind);
	return { version: ASSET_IMPORTER_CONFIGURATION_VERSION, kind, settings: { ...defaults[kind] } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function validateField(field: IAssetImporterFieldDefinition, value: unknown): boolean | number | string {
	if (field.type === "boolean") {
		if (typeof value !== "boolean") {
			throw new Error(`${field.label} must be a boolean.`);
		}
		return value;
	}
	if (field.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`${field.label} must be a finite number.`);
		}
		if (field.integer && !Number.isInteger(value)) {
			throw new Error(`${field.label} must be an integer.`);
		}
		if (field.minimum !== undefined && value < field.minimum) {
			throw new Error(`${field.label} must be at least ${field.minimum}.`);
		}
		if (field.maximum !== undefined && value > field.maximum) {
			throw new Error(`${field.label} must be at most ${field.maximum}.`);
		}
		return value;
	}
	if (typeof value !== "string") {
		throw new Error(`${field.label} must be a string.`);
	}
	if (field.type === "enum" && !field.values?.includes(value)) {
		throw new Error(`${field.label} must be one of: ${field.values?.join(", ")}.`);
	}
	if (
		value.length >
		(field.key === "animationClips" || field.key === "materialRemaps" || field.key === "authoredLods" || field.key === "generatedLods" || field.key === "platformOverrides"
			? 65_536
			: field.key === "customCharacters" || field.key === "exposedTransforms"
				? 4096
				: 512)
	) {
		throw new Error(`${field.label} is too long.`);
	}
	if (field.key === "importerId" && value && !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) {
		throw new Error("Importer ID may contain only letters, numbers, dots, underscores, and hyphens.");
	}
	return value;
}

export function normalizeAssetImporterConfiguration(path: string, value: unknown, strict = false): IAssetImporterConfiguration {
	const inferredKind = inferAssetImporterKind(path);
	const input = asRecord(value) ?? {};
	const versioned = input.version === ASSET_IMPORTER_CONFIGURATION_VERSION && typeof input.kind === "string" && asRecord(input.settings);
	const kind = versioned ? (input.kind as AssetImporterKind) : inferredKind;
	if (!definitions.some((definition) => definition.kind === kind)) {
		throw new Error(`Unknown asset importer kind: ${String(input.kind)}.`);
	}
	if (kind !== inferredKind) {
		throw new Error(`.${path.split(".").pop() ?? ""} assets require the ${inferredKind} importer, not ${kind}.`);
	}
	const source = (versioned ? asRecord(input.settings) : input) ?? {};
	const definition = definitions.find((candidate) => candidate.kind === kind)!;
	const settings: Record<string, boolean | number | string> = { ...defaults[kind] };
	const known = new Set(definition.fields.map((field) => field.key));
	for (const field of definition.fields) {
		if (source[field.key] !== undefined) {
			settings[field.key] = validateField(field, source[field.key]);
		}
	}
	if (kind === "texture" && ![32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384].includes(settings.maxSize as number)) {
		throw new Error("Texture Max Size must be a power of two from 32 through 16384.");
	}
	if (kind === "model") {
		settings.animationClips = serializeModelAnimationClipDefinitions(settings.animationClips);
		settings.materialRemaps = serializeModelMaterialRemaps(settings.materialRemaps);
		settings.authoredLods = serializeModelAuthoredLodGroups(settings.authoredLods);
		settings.generatedLods = serializeModelLodDefinitions(settings.generatedLods);
		settings.platformOverrides = serializeModelImporterPlatformOverrides(settings.platformOverrides);
	}
	const unknown = Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key) && !["version", "kind", "settings", "extra"].includes(key)));
	if (strict && Object.keys(unknown).length) {
		throw new Error(`Unsupported ${kind} importer setting(s): ${Object.keys(unknown).sort().join(", ")}.`);
	}
	const extra = versioned ? asRecord(input.extra) : unknown;
	return { version: ASSET_IMPORTER_CONFIGURATION_VERSION, kind, settings, ...(extra && Object.keys(extra).length ? { extra: structuredClone(extra) } : {}) };
}

export function validateAssetImporterConfiguration(path: string, value: unknown): { valid: true; configuration: IAssetImporterConfiguration } {
	return { valid: true, configuration: normalizeAssetImporterConfiguration(path, value, true) };
}
