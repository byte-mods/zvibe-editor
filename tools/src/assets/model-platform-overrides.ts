import { IModelLodDefinition, normalizeModelLodDefinitions } from "./model-lods";

export type ModelImporterPlatform = "default" | "web" | "desktop";
export type ModelImporterOverridePlatform = Exclude<ModelImporterPlatform, "default">;

export interface IModelImporterPlatformOverride {
	enabled: boolean;
	scaleFactor?: number;
	convertUnits?: boolean;
	importMaterials?: boolean;
	generatedLods?: IModelLodDefinition[];
	importTextures?: boolean;
	importAnimations?: boolean;
	animationType?: "none" | "generic" | "humanoid";
	optimizeGameObjects?: boolean;
	generateColliders?: boolean;
	meshCompression?: "none" | "low" | "medium" | "high";
	optimizeMesh?: boolean;
	weldVertices?: boolean;
	normals?: "import" | "calculate" | "none";
	tangents?: "import" | "calculate" | "none";
}

export type IModelImporterPlatformOverrides = Partial<Record<ModelImporterOverridePlatform, IModelImporterPlatformOverride>>;

export interface IModelImporterPlatformSettings {
	scaleFactor: number;
	convertUnits: boolean;
	importMaterials: boolean;
	generatedLods: IModelLodDefinition[];
	importTextures: boolean;
	importAnimations: boolean;
	animationType: "none" | "generic" | "humanoid";
	optimizeGameObjects: boolean;
	generateColliders: boolean;
	meshCompression: "none" | "low" | "medium" | "high";
	optimizeMesh: boolean;
	weldVertices: boolean;
	normals: "import" | "calculate" | "none";
	tangents: "import" | "calculate" | "none";
	platformOverrides: IModelImporterPlatformOverrides;
}

export interface IResolvedModelImporterPlatformSettings<T extends IModelImporterPlatformSettings> {
	platform: ModelImporterPlatform;
	overrideApplied: boolean;
	override: IModelImporterPlatformOverride | null;
	settings: T;
}

const overrideKeys = new Set([
	"enabled",
	"scaleFactor",
	"convertUnits",
	"importMaterials",
	"generatedLods",
	"importTextures",
	"importAnimations",
	"animationType",
	"optimizeGameObjects",
	"generateColliders",
	"meshCompression",
	"optimizeMesh",
	"weldVertices",
	"normals",
	"tangents",
]);

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function optionalBoolean(source: Record<string, unknown>, key: string): boolean | undefined {
	const value = source[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`Model platform override ${key} must be a boolean.`);
	}
	return value;
}

function optionalEnum<T extends string>(source: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
	const value = source[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`Model platform override ${key} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

function normalizeOverride(value: unknown): IModelImporterPlatformOverride {
	const source = record(value, "Model platform override");
	const unknown = Object.keys(source).filter((key) => !overrideKeys.has(key));
	if (unknown.length) {
		throw new Error(`Unsupported model platform override setting(s): ${unknown.sort().join(", ")}.`);
	}
	if (typeof source.enabled !== "boolean") {
		throw new Error("Model platform override enabled must be a boolean.");
	}
	let scaleFactor: number | undefined;
	if (source.scaleFactor !== undefined) {
		if (typeof source.scaleFactor !== "number" || !Number.isFinite(source.scaleFactor) || source.scaleFactor < 0.0001 || source.scaleFactor > 100000) {
			throw new Error("Model platform override scaleFactor must be between 0.0001 and 100000.");
		}
		scaleFactor = source.scaleFactor;
	}
	return {
		enabled: source.enabled,
		...(scaleFactor !== undefined ? { scaleFactor } : {}),
		...(optionalBoolean(source, "convertUnits") !== undefined ? { convertUnits: optionalBoolean(source, "convertUnits") } : {}),
		...(optionalBoolean(source, "importMaterials") !== undefined ? { importMaterials: optionalBoolean(source, "importMaterials") } : {}),
		...(source.generatedLods !== undefined ? { generatedLods: normalizeModelLodDefinitions(source.generatedLods) } : {}),
		...(optionalBoolean(source, "importTextures") !== undefined ? { importTextures: optionalBoolean(source, "importTextures") } : {}),
		...(optionalBoolean(source, "importAnimations") !== undefined ? { importAnimations: optionalBoolean(source, "importAnimations") } : {}),
		...(optionalEnum(source, "animationType", ["none", "generic", "humanoid"] as const) !== undefined
			? { animationType: optionalEnum(source, "animationType", ["none", "generic", "humanoid"] as const) }
			: {}),
		...(optionalBoolean(source, "optimizeGameObjects") !== undefined ? { optimizeGameObjects: optionalBoolean(source, "optimizeGameObjects") } : {}),
		...(optionalBoolean(source, "generateColliders") !== undefined ? { generateColliders: optionalBoolean(source, "generateColliders") } : {}),
		...(optionalEnum(source, "meshCompression", ["none", "low", "medium", "high"] as const) !== undefined
			? { meshCompression: optionalEnum(source, "meshCompression", ["none", "low", "medium", "high"] as const) }
			: {}),
		...(optionalBoolean(source, "optimizeMesh") !== undefined ? { optimizeMesh: optionalBoolean(source, "optimizeMesh") } : {}),
		...(optionalBoolean(source, "weldVertices") !== undefined ? { weldVertices: optionalBoolean(source, "weldVertices") } : {}),
		...(optionalEnum(source, "normals", ["import", "calculate", "none"] as const) !== undefined
			? { normals: optionalEnum(source, "normals", ["import", "calculate", "none"] as const) }
			: {}),
		...(optionalEnum(source, "tangents", ["import", "calculate", "none"] as const) !== undefined
			? { tangents: optionalEnum(source, "tangents", ["import", "calculate", "none"] as const) }
			: {}),
	};
}

/** Parses the persisted closed Web/Desktop override map. */
export function normalizeModelImporterPlatformOverrides(value: unknown): IModelImporterPlatformOverrides {
	if (value === undefined || value === null || value === "") {
		return {};
	}
	let parsed = value;
	if (typeof parsed === "string") {
		if (parsed.length > 65_536) {
			throw new Error("Model platform overrides JSON is limited to 65536 characters.");
		}
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error("Model platform overrides must be valid JSON.");
		}
	}
	const source = record(parsed, "Model platform overrides");
	const unknown = Object.keys(source).filter((key) => key !== "web" && key !== "desktop");
	if (unknown.length) {
		throw new Error(`Unsupported model importer platform(s): ${unknown.sort().join(", ")}.`);
	}
	return {
		...(source.web !== undefined ? { web: normalizeOverride(source.web) } : {}),
		...(source.desktop !== undefined ? { desktop: normalizeOverride(source.desktop) } : {}),
	};
}

/** Serializes platform overrides deterministically for importer metadata and cache fingerprints. */
export function serializeModelImporterPlatformOverrides(value: unknown): string {
	const overrides = normalizeModelImporterPlatformOverrides(value);
	return JSON.stringify({ ...(overrides.web ? { web: overrides.web } : {}), ...(overrides.desktop ? { desktop: overrides.desktop } : {}) });
}

/** Maps build-profile and CLI target names to the two currently executable override families. */
export function normalizeModelImporterPlatform(value: unknown): ModelImporterPlatform {
	if (value === "web") {
		return "web";
	}
	if (value === "desktop" || value === "electron") {
		return "desktop";
	}
	return "default";
}

/** Resolves one immutable effective settings object for editor/CLI execution and evidence. */
export function resolveModelImporterPlatformSettings<T extends IModelImporterPlatformSettings>(settings: T, requestedPlatform: unknown): IResolvedModelImporterPlatformSettings<T> {
	const platform = normalizeModelImporterPlatform(requestedPlatform);
	const override = platform === "default" ? undefined : settings.platformOverrides[platform];
	if (!override?.enabled) {
		return { platform, overrideApplied: false, override: override ?? null, settings: structuredClone(settings) };
	}
	const { enabled: _enabled, ...values } = override;
	return {
		platform,
		overrideApplied: true,
		override: structuredClone(override),
		settings: { ...structuredClone(settings), ...structuredClone(values), platformOverrides: structuredClone(settings.platformOverrides) },
	};
}
