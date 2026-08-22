export const FBX_EXPORT_MODEL = "zvibe-fbx-export-v1";
export const FBX_EXPORT_VERSION = 1;
export const FBX_EXPORT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
export const FBX_EXPORT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

export type FbxExportAxis = "X" | "-X" | "Y" | "-Y" | "Z" | "-Z";

export interface IFbxExportSettings {
	globalScale: number;
	axisForward: FbxExportAxis;
	axisUp: FbxExportAxis;
	applyTransforms: boolean;
	applyModifiers: boolean;
	includeMaterials: boolean;
	embedTextures: boolean;
	includeAnimations: boolean;
	animationSamplingRate: number;
	animationSimplification: number;
	includeCameras: boolean;
	includeLights: boolean;
	exportTangents: boolean;
	exportCustomProperties: boolean;
	addLeafBones: boolean;
	useArmatureDeformOnly: boolean;
}

export interface IFbxExportStatistics {
	objectCount: number;
	meshCount: number;
	armatureCount: number;
	cameraCount: number;
	lightCount: number;
	materialCount: number;
	actionCount: number;
}

export interface IFbxExportEvidence {
	model: typeof FBX_EXPORT_MODEL;
	version: typeof FBX_EXPORT_VERSION;
	generator: "Zvibe Editor Blender FBX Adapter";
	blenderVersion: string;
	source: { bytes: number; sha256: string };
	output: { bytes: number; sha256: string; binaryVersion: number };
	settings: IFbxExportSettings;
	statistics: IFbxExportStatistics;
}

const defaultSettings: IFbxExportSettings = {
	globalScale: 1,
	axisForward: "-Z",
	axisUp: "Y",
	applyTransforms: false,
	applyModifiers: true,
	includeMaterials: true,
	embedTextures: true,
	includeAnimations: true,
	animationSamplingRate: 1,
	animationSimplification: 1,
	includeCameras: true,
	includeLights: true,
	exportTangents: true,
	exportCustomProperties: true,
	addLeafBones: false,
	useArmatureDeformOnly: false,
};

/** Rejects truthy/string stand-ins so every client observes one exact Boolean contract. */
function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

/** Keeps Blender scalar inputs finite and inside the limits used by the shell-free adapter. */
function finite(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

/** Restricts coordinate conversion to Blender's documented orthogonal axis tokens. */
function axis(value: unknown, label: string): FbxExportAxis {
	const values: readonly FbxExportAxis[] = ["X", "-X", "Y", "-Y", "Z", "-Z"];
	if (typeof value !== "string" || !values.includes(value as FbxExportAxis)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}.`);
	}
	return value as FbxExportAxis;
}

/** Normalizes the one bounded FBX authoring contract shared by UI, CLI conversion, and MCP. */
export function normalizeFbxExportSettings(value: unknown): IFbxExportSettings {
	const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const result: IFbxExportSettings = {
		globalScale: finite(source.globalScale ?? defaultSettings.globalScale, "FBX globalScale", 0.0001, 100_000),
		axisForward: axis(source.axisForward ?? defaultSettings.axisForward, "FBX axisForward"),
		axisUp: axis(source.axisUp ?? defaultSettings.axisUp, "FBX axisUp"),
		applyTransforms: boolean(source.applyTransforms ?? defaultSettings.applyTransforms, "FBX applyTransforms"),
		applyModifiers: boolean(source.applyModifiers ?? defaultSettings.applyModifiers, "FBX applyModifiers"),
		includeMaterials: boolean(source.includeMaterials ?? defaultSettings.includeMaterials, "FBX includeMaterials"),
		embedTextures: boolean(source.embedTextures ?? defaultSettings.embedTextures, "FBX embedTextures"),
		includeAnimations: boolean(source.includeAnimations ?? defaultSettings.includeAnimations, "FBX includeAnimations"),
		animationSamplingRate: finite(source.animationSamplingRate ?? defaultSettings.animationSamplingRate, "FBX animationSamplingRate", 0.01, 100),
		animationSimplification: finite(source.animationSimplification ?? defaultSettings.animationSimplification, "FBX animationSimplification", 0, 100),
		includeCameras: boolean(source.includeCameras ?? defaultSettings.includeCameras, "FBX includeCameras"),
		includeLights: boolean(source.includeLights ?? defaultSettings.includeLights, "FBX includeLights"),
		exportTangents: boolean(source.exportTangents ?? defaultSettings.exportTangents, "FBX exportTangents"),
		exportCustomProperties: boolean(source.exportCustomProperties ?? defaultSettings.exportCustomProperties, "FBX exportCustomProperties"),
		addLeafBones: boolean(source.addLeafBones ?? defaultSettings.addLeafBones, "FBX addLeafBones"),
		useArmatureDeformOnly: boolean(source.useArmatureDeformOnly ?? defaultSettings.useArmatureDeformOnly, "FBX useArmatureDeformOnly"),
	};
	if (result.axisForward.replace("-", "") === result.axisUp.replace("-", "")) {
		throw new Error("FBX forward and up axes must use different dimensions.");
	}
	if (result.embedTextures && !result.includeMaterials) {
		throw new Error("FBX embedTextures requires includeMaterials=true.");
	}
	return result;
}

/** Returns a fresh profile so callers cannot mutate the canonical defaults. */
export function getDefaultFbxExportSettings(): IFbxExportSettings {
	return { ...defaultSettings };
}
