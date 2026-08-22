import { serializeModelAnimationClipDefinitions } from "./model-animation-clips";
import { serializeModelMaterialRemaps } from "./model-material-remaps";
import { serializeModelAuthoredLodGroups, serializeModelLodDefinitions } from "./model-lods";
import { serializeModelImporterPlatformOverrides } from "./model-platform-overrides";
import { serializeTextureImporterPlatformOverrides } from "./texture-platform-overrides";
import { serializeVideoImporterPlatformOverrides } from "./video-platform-overrides";
import { normalizeAsepriteImporterSettings } from "./aseprite";

export const ASSET_IMPORTER_CONFIGURATION_VERSION = 1;

export type AssetImporterKind = "texture" | "model" | "alembic" | "aseprite" | "audio" | "video" | "font" | "material" | "animation" | "aiModel" | "custom";
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
		extensions: ["png", "jpg", "jpeg", "bmp", "webp", "gif", "tif", "tiff", "tga", "psd", "psb", "svg", "exr", "hdr", "env", "dds"],
		fields: [
			...commonFields,
			{
				key: "textureType",
				label: "Texture Type",
				type: "enum",
				description: "How the texture will be interpreted by authoring/runtime workflows.",
				values: ["default", "normalMap", "sprite", "lightmap", "cursor"],
			},
			{
				key: "outputFormat",
				label: "Output Format",
				type: "enum",
				description: "Portable output container selected for optimized builds.",
				values: ["automatic", "png", "jpeg", "webp"],
			},
			{ key: "colorSpace", label: "Color Space", type: "enum", description: "Decode color channels as sRGB or linear data.", values: ["sRGB", "linear"] },
			{
				key: "alphaSource",
				label: "Alpha Source",
				type: "enum",
				description: "Keep source alpha, discard it, or derive it from grayscale luminance.",
				values: ["input", "none", "grayscale"],
			},
			{
				key: "alphaIsTransparency",
				label: "Alpha Is Transparency",
				type: "boolean",
				description: "Dilate visible edge colors into transparent texels to avoid filtered dark fringes.",
			},
			{
				key: "nonPowerOfTwo",
				label: "Non Power Of Two",
				type: "enum",
				description: "Keep NPOT dimensions or resize each axis to its nearest, larger, or smaller power of two.",
				values: ["none", "toNearest", "toLarger", "toSmaller"],
			},
			{ key: "generateMipmaps", label: "Generate Mipmaps", type: "boolean", description: "Generate downscaled texture variants during optimized builds." },
			{
				key: "mipmapFilter",
				label: "Mipmap Filter",
				type: "enum",
				description: "Box or higher-quality Kaiser-style filtering for the full mip chain.",
				values: ["box", "kaiser"],
			},
			{ key: "mipmapPreserveCoverage", label: "Preserve Alpha Coverage", type: "boolean", description: "Rescale mip alpha to retain base-level cutout coverage." },
			{
				key: "mipmapAlphaTestReference",
				label: "Alpha Test Reference",
				type: "number",
				description: "Cutout threshold used when preserving mip alpha coverage.",
				minimum: 0,
				maximum: 1,
				step: 0.01,
			},
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
			{
				key: "filterMode",
				label: "Filter Mode",
				type: "enum",
				description: "Runtime point, bilinear, or trilinear texture sampling.",
				values: ["point", "bilinear", "trilinear"],
			},
			{ key: "wrapModeU", label: "Wrap Mode U", type: "enum", description: "Runtime horizontal repeat, clamp, or mirror addressing.", values: ["repeat", "clamp", "mirror"] },
			{ key: "wrapModeV", label: "Wrap Mode V", type: "enum", description: "Runtime vertical repeat, clamp, or mirror addressing.", values: ["repeat", "clamp", "mirror"] },
			{ key: "anisoLevel", label: "Aniso Level", type: "number", description: "Runtime anisotropic filtering level.", minimum: 0, maximum: 16, step: 1, integer: true },
			{
				key: "normalMapSource",
				label: "Normal Map Source",
				type: "enum",
				description: "Use authored normal colors or convert grayscale height into tangent-space normals.",
				values: ["color", "height"],
			},
			{ key: "normalMapStrength", label: "Normal Strength", type: "number", description: "Height-to-normal gradient strength.", minimum: 0, maximum: 2, step: 0.01 },
			{
				key: "spritePixelsPerUnit",
				label: "Pixels Per Unit",
				type: "number",
				description: "Sprite pixel density used by 2D placement and metadata.",
				minimum: 0.001,
				maximum: 1000000,
				step: 1,
			},
			{
				key: "spriteMeshType",
				label: "Sprite Mesh Type",
				type: "enum",
				description: "Use a full rectangle or a tight alpha-derived sprite mesh.",
				values: ["fullRect", "tight"],
			},
			{
				key: "spriteExtrude",
				label: "Sprite Extrude",
				type: "number",
				description: "Transparent edge pixels reserved around a generated sprite mesh.",
				minimum: 0,
				maximum: 32,
				step: 1,
				integer: true,
			},
			{
				key: "platformOverrides",
				label: "Platform Overrides",
				type: "string",
				description: "Strict JSON Web/Desktop texture-processing overrides authored by the Texture Inspector.",
			},
		],
	},
	{
		kind: "model",
		label: "Model Importer",
		extensions: ["glb", "gltf", "babylon", "fbx", "obj", "stl", "dae", "3ds", "ms3d", "b3d", "x", "lwo", "dxf", "blend"],
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
		kind: "alembic",
		label: "Alembic Importer",
		extensions: ["abc"],
		fields: [
			...commonFields,
			{
				key: "scaleFactor",
				label: "Scale Factor",
				type: "number",
				description: "Scale applied while converting sampled Alembic geometry.",
				minimum: 0.0001,
				maximum: 100000,
				step: 0.01,
			},
			{ key: "convertUnits", label: "Convert Units", type: "boolean", description: "Convert authored source units into editor centimeters when metadata is available." },
			{
				key: "handedness",
				label: "Coordinate System",
				type: "enum",
				description: "Convert to Babylon left-handed coordinates or retain source right-handed coordinates.",
				values: ["babylonLeftHanded", "sourceRightHanded"],
			},
			{ key: "flipFaces", label: "Flip Faces", type: "boolean", description: "Reverse triangle winding after coordinate conversion." },
			{ key: "importMeshes", label: "Import Meshes", type: "boolean", description: "Sample polygon mesh objects." },
			{ key: "importPoints", label: "Import Points", type: "boolean", description: "Sample Alembic point-cloud objects." },
			{ key: "importCurves", label: "Import Curves", type: "boolean", description: "Sample curve objects as bounded Babylon line systems." },
			{ key: "importCameras", label: "Import Cameras", type: "boolean", description: "Sample Alembic camera visibility and optical properties." },
			{ key: "normals", label: "Normals", type: "enum", description: "Import, calculate, or omit sampled mesh normals.", values: ["import", "calculate", "none"] },
			{ key: "sampleRate", label: "Sample Rate", type: "number", description: "Geometry samples captured per second.", minimum: 0.1, maximum: 240, step: 1 },
			{
				key: "startTimeSeconds",
				label: "Start Time",
				type: "number",
				description: "First sampled source time in seconds, or -1 for the authored start.",
				minimum: -1,
				maximum: 1000000,
				step: 0.01,
			},
			{
				key: "endTimeSeconds",
				label: "End Time",
				type: "number",
				description: "Last sampled source time in seconds, or -1 for the authored end.",
				minimum: -1,
				maximum: 1000000,
				step: 0.01,
			},
			{
				key: "maximumSamples",
				label: "Maximum Samples",
				type: "number",
				description: "Hard authoring/build ceiling for generated samples.",
				minimum: 1,
				maximum: 10000,
				step: 1,
				integer: true,
			},
			{
				key: "interpolation",
				label: "Interpolation",
				type: "enum",
				description: "Linearly blend stable topology or hold exact discrete samples.",
				values: ["hold", "linear"],
			},
			{ key: "playOnAwake", label: "Play On Awake", type: "boolean", description: "Start sampled playback when the scene loads." },
			{ key: "loopByDefault", label: "Loop", type: "boolean", description: "Loop the imported cache during preview and runtime playback." },
			{ key: "speed", label: "Playback Speed", type: "number", description: "Signed non-zero playback speed multiplier.", minimum: -100, maximum: 100, step: 0.1 },
			{ key: "pointSize", label: "Point Size", type: "number", description: "Default rendered point-cloud size.", minimum: 0.01, maximum: 1000, step: 0.1 },
			{ key: "curveWidth", label: "Curve Width", type: "number", description: "Default rendered curve width.", minimum: 0.01, maximum: 1000, step: 0.1 },
		],
	},
	{
		kind: "aseprite",
		label: "Aseprite Importer",
		extensions: ["ase", "aseprite"],
		fields: [
			...commonFields,
			{ key: "includeHiddenLayers", label: "Include Hidden Layers", type: "boolean", description: "Composite hidden image/group layers into generated frames." },
			{
				key: "layerMode",
				label: "Layer Output",
				type: "enum",
				description: "Generate only composited frames or composited frames plus one animation stream per image layer.",
				values: ["composite", "compositeAndLayers"],
			},
			{ key: "trimSprites", label: "Trim Transparent Pixels", type: "boolean", description: "Trim each generated atlas entry while retaining exact source bounds." },
			{ key: "ignoreEmptyFrames", label: "Ignore Empty Frames", type: "boolean", description: "Exclude completely transparent generated entries from the atlas." },
			{ key: "mergeDuplicates", label: "Merge Duplicate Frames", type: "boolean", description: "Reuse one atlas rectangle for byte-identical generated entries." },
			{
				key: "padding",
				label: "Shape Padding",
				type: "number",
				description: "Transparent pixels reserved between packed atlas entries.",
				minimum: 0,
				maximum: 32,
				step: 1,
				integer: true,
			},
			{
				key: "extrude",
				label: "Edge Extrusion",
				type: "number",
				description: "Duplicate border texels around each frame to prevent filtered seams.",
				minimum: 0,
				maximum: 16,
				step: 1,
				integer: true,
			},
			{ key: "powerOfTwo", label: "Power Of Two Atlas", type: "boolean", description: "Round atlas dimensions up to powers of two." },
			{
				key: "maximumAtlasSize",
				label: "Maximum Atlas Size",
				type: "number",
				description: "Maximum generated atlas width or height.",
				minimum: 64,
				maximum: 8192,
				step: 64,
				integer: true,
			},
			{
				key: "importTags",
				label: "Import Animation Tags",
				type: "boolean",
				description: "Preserve tag frame ranges, loop directions, repeat counts, colors, and durations.",
			},
			{ key: "importSlices", label: "Import Slices", type: "boolean", description: "Preserve slices, per-frame pivots, and nine-patch centers." },
			{
				key: "pivotMode",
				label: "Pivot",
				type: "enum",
				description: "Use the active Aseprite slice pivot when present, frame center, or top-left.",
				values: ["sliceOrCenter", "center", "topLeft"],
			},
			{
				key: "pixelsPerUnit",
				label: "Pixels Per Unit",
				type: "number",
				description: "Sprite pixel density used when a generated atlas is instantiated in the scene.",
				minimum: 0.01,
				maximum: 100000,
				step: 1,
			},
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
			{
				key: "videoCodec",
				label: "Video Codec",
				type: "enum",
				description: "Use the target-container default or explicitly encode H.264, H.265, VP8, or VP9.",
				values: ["auto", "h264", "h265", "vp8", "vp9"],
			},
			{
				key: "encoder",
				label: "Encoder",
				type: "enum",
				description: "Select deterministic software encoding or an explicitly available hardware backend.",
				values: ["auto", "software", "videotoolbox", "nvenc", "qsv", "amf"],
			},
			{ key: "quality", label: "Quality", type: "number", description: "Requested transcoding quality.", minimum: 0, maximum: 1, step: 0.01 },
			{ key: "maxWidth", label: "Max Width", type: "number", description: "Maximum output width.", minimum: 64, maximum: 8192, step: 2, integer: true },
			{ key: "maxHeight", label: "Max Height", type: "number", description: "Maximum output height.", minimum: 64, maximum: 8192, step: 2, integer: true },
			{ key: "includeAudio", label: "Include Audio", type: "boolean", description: "Retain the source audio track." },
			{
				key: "colorDefinition",
				label: "Color Definition",
				type: "enum",
				description: "Preserve source color metadata or tag transcoded output explicitly as limited-range Rec.709.",
				values: ["preserve", "rec709"],
			},
			{
				key: "platformOverrides",
				label: "Platform Overrides",
				type: "string",
				description: "Strict JSON Web/Desktop codec, encoder, dimensions, audio, quality, and color overrides authored by the Video Inspector.",
			},
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
		extensions: ["animation", "animations", "anim", "animator", "controller"],
		fields: [
			...commonFields,
			{ key: "importClips", label: "Import Clips", type: "boolean", description: "Import clip data from the source." },
			{
				key: "resampleCurves",
				label: "Resample Curves",
				type: "boolean",
				description: "Bake source curves at the requested sample rate; disable to preserve source key times and tangents.",
			},
			{ key: "resampleRate", label: "Resample Rate", type: "number", description: "Requested animation sample rate.", minimum: 1, maximum: 240, step: 1, integer: true },
			{
				key: "compression",
				label: "Compression",
				type: "enum",
				description: "Unity-style animation compression profile. Error-bounded modes report their effective per-track encoding.",
				values: ["none", "keyframeReduction", "keyframeReductionAndCompression", "optimal"],
			},
			{
				key: "positionErrorPercent",
				label: "Position Error %",
				type: "number",
				description: "Maximum position deviation as a percentage of the track's spatial range.",
				minimum: 0,
				maximum: 100,
				step: 0.01,
			},
			{
				key: "rotationErrorDegrees",
				label: "Rotation Error",
				type: "number",
				description: "Maximum quaternion/Euler angular deviation in degrees.",
				minimum: 0,
				maximum: 180,
				step: 0.01,
			},
			{
				key: "scaleErrorPercent",
				label: "Scale Error %",
				type: "number",
				description: "Maximum component-relative scale deviation in percent.",
				minimum: 0,
				maximum: 100,
				step: 0.01,
			},
			{
				key: "floatError",
				label: "Float Error",
				type: "number",
				description: "Maximum absolute error for non-transform float, vector, color, and custom-property curves.",
				minimum: 0,
				maximum: 1000000,
				step: 0.0001,
			},
			{
				key: "quantizationBits",
				label: "Quantization Bits",
				type: "number",
				description: "Requested bounded component quantization for compression profiles that include value compression.",
				minimum: 8,
				maximum: 24,
				step: 1,
				integer: true,
			},
			{
				key: "removeConstantScaleCurves",
				label: "Remove Constant Scale Curves",
				type: "boolean",
				description: "Remove only exact all-one scale tracks; disabled by default because standalone clips do not carry bind-pose scale evidence.",
			},
			{ key: "loopByDefault", label: "Loop By Default", type: "boolean", description: "Mark imported clips as looping by default." },
			{ key: "rootMotionNode", label: "Root Motion Node", type: "string", description: "Optional source node name used for root motion." },
		],
	},
	{
		kind: "aiModel",
		label: "AI Model Importer",
		extensions: ["onnx", "tflite", "pt2"],
		fields: [
			...commonFields,
			{
				key: "backend",
				label: "Execution Backend",
				type: "enum",
				description: "Select WebGPU when available, force portable WebAssembly, or require WebGPU.",
				values: ["automatic", "wasm", "webgpu"],
			},
			{
				key: "graphOptimizationLevel",
				label: "Graph Optimization",
				type: "enum",
				description: "ONNX Runtime graph optimization level used while compiling the inference session.",
				values: ["disabled", "basic", "extended", "layout", "all"],
			},
			{
				key: "executionMode",
				label: "Execution Mode",
				type: "enum",
				description: "Execute graph nodes sequentially or permit parallel scheduling when supported.",
				values: ["sequential", "parallel"],
			},
			{ key: "enableCpuMemArena", label: "CPU Memory Arena", type: "boolean", description: "Reuse CPU tensor allocations between inference runs." },
			{ key: "enableMemPattern", label: "Memory Pattern", type: "boolean", description: "Precompute tensor allocation patterns for fixed-shape models." },
			{
				key: "wasmNumThreads",
				label: "WebAssembly Threads",
				type: "number",
				description: "Maximum WebAssembly worker threads. Browsers can still reduce this when cross-origin isolation is unavailable.",
				minimum: 1,
				maximum: 16,
				step: 1,
				integer: true,
			},
			{
				key: "webgpuPreferredLayout",
				label: "WebGPU Layout",
				type: "enum",
				description: "Preferred convolution tensor layout for the WebGPU execution provider.",
				values: ["NCHW", "NHWC"],
			},
			{
				key: "webgpuValidationMode",
				label: "WebGPU Validation",
				type: "enum",
				description: "WebGPU validation strictness. Full validation is intended for diagnosis and costs runtime performance.",
				values: ["disabled", "wgpuOnly", "basic", "full"],
			},
			{
				key: "maximumTensorElements",
				label: "Maximum Tensor Elements",
				type: "number",
				description: "Safety limit applied to every input and output tensor handled by the editor runtime.",
				minimum: 1,
				maximum: 16777216,
				step: 1,
				integer: true,
			},
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
		outputFormat: "automatic",
		colorSpace: "sRGB",
		alphaSource: "input",
		alphaIsTransparency: false,
		nonPowerOfTwo: "none",
		generateMipmaps: true,
		mipmapFilter: "kaiser",
		mipmapPreserveCoverage: false,
		mipmapAlphaTestReference: 0.5,
		maxSize: 4096,
		resizeAlgorithm: "lanczos3",
		compression: "normal",
		readable: false,
		filterMode: "trilinear",
		wrapModeU: "repeat",
		wrapModeV: "repeat",
		anisoLevel: 1,
		normalMapSource: "color",
		normalMapStrength: 0.25,
		spritePixelsPerUnit: 100,
		spriteMeshType: "tight",
		spriteExtrude: 1,
		platformOverrides: "{}",
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
	alembic: {
		includeInBuild: true,
		scaleFactor: 1,
		convertUnits: true,
		handedness: "babylonLeftHanded",
		flipFaces: false,
		importMeshes: true,
		importPoints: true,
		importCurves: true,
		importCameras: true,
		normals: "import",
		sampleRate: 30,
		startTimeSeconds: -1,
		endTimeSeconds: -1,
		maximumSamples: 300,
		interpolation: "linear",
		playOnAwake: true,
		loopByDefault: true,
		speed: 1,
		pointSize: 2,
		curveWidth: 1,
	},
	aseprite: {
		includeInBuild: true,
		includeHiddenLayers: false,
		layerMode: "composite",
		trimSprites: true,
		ignoreEmptyFrames: false,
		mergeDuplicates: true,
		padding: 2,
		extrude: 1,
		powerOfTwo: true,
		maximumAtlasSize: 4096,
		importTags: true,
		importSlices: true,
		pivotMode: "sliceOrCenter",
		pixelsPerUnit: 100,
	},
	audio: { includeInBuild: true, loadType: "compressedInMemory", compressionFormat: "preserve", quality: 0.8, sampleRate: "preserve", forceMono: false, normalize: false },
	video: {
		includeInBuild: true,
		transcode: "preserve",
		videoCodec: "auto",
		encoder: "auto",
		quality: 0.8,
		maxWidth: 1920,
		maxHeight: 1080,
		includeAudio: true,
		colorDefinition: "preserve",
		platformOverrides: "{}",
	},
	font: { includeInBuild: true, renderMode: "dynamic", characterSet: "ascii", customCharacters: "", fontSize: 48, padding: 4, distanceRange: 4 },
	material: { includeInBuild: true, validateTextures: true, extractEmbeddedTextures: true, compileNodeMaterial: true },
	animation: {
		includeInBuild: true,
		importClips: true,
		resampleCurves: true,
		resampleRate: 60,
		compression: "keyframeReduction",
		positionErrorPercent: 0.5,
		rotationErrorDegrees: 0.5,
		scaleErrorPercent: 0.5,
		floatError: 0.0005,
		quantizationBits: 16,
		removeConstantScaleCurves: false,
		loopByDefault: false,
		rootMotionNode: "",
	},
	aiModel: {
		includeInBuild: true,
		backend: "automatic",
		graphOptimizationLevel: "all",
		executionMode: "sequential",
		enableCpuMemArena: true,
		enableMemPattern: true,
		wasmNumThreads: 1,
		webgpuPreferredLayout: "NCHW",
		webgpuValidationMode: "disabled",
		maximumTensorElements: 1048576,
	},
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
	if (kind === "texture") {
		settings.platformOverrides = serializeTextureImporterPlatformOverrides(settings.platformOverrides);
	}
	if (kind === "model") {
		settings.animationClips = serializeModelAnimationClipDefinitions(settings.animationClips);
		settings.materialRemaps = serializeModelMaterialRemaps(settings.materialRemaps);
		settings.authoredLods = serializeModelAuthoredLodGroups(settings.authoredLods);
		settings.generatedLods = serializeModelLodDefinitions(settings.generatedLods);
		settings.platformOverrides = serializeModelImporterPlatformOverrides(settings.platformOverrides);
	}
	if (kind === "alembic") {
		if (![settings.importMeshes, settings.importPoints, settings.importCurves, settings.importCameras].some((value) => value === true)) {
			throw new Error("Alembic Importer must enable at least one object family.");
		}
		if (settings.speed === 0) {
			throw new Error("Alembic Playback Speed must be non-zero.");
		}
		if ((settings.startTimeSeconds as number) >= 0 && (settings.endTimeSeconds as number) >= 0 && (settings.endTimeSeconds as number) < (settings.startTimeSeconds as number)) {
			throw new Error("Alembic End Time must be automatic (-1) or greater than or equal to Start Time.");
		}
	}
	if (kind === "aseprite") {
		Object.assign(settings, normalizeAsepriteImporterSettings(settings));
	}
	if (kind === "video") {
		if ((settings.maxWidth as number) % 2 !== 0 || (settings.maxHeight as number) % 2 !== 0) {
			throw new Error("Video Max Width and Max Height must be even integers.");
		}
		settings.platformOverrides = serializeVideoImporterPlatformOverrides(settings.platformOverrides);
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
