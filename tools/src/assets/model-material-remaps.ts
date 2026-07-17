import { extname, isAbsolute, normalize } from "path/posix";

export interface IModelMaterialRemapDefinition {
	sourceMaterial: string;
	materialPath: string;
}

export interface IModelSourceMaterialResult {
	name: string;
	materialObjectCount: number;
	meshReferenceCount: number;
	textureCount: number;
	remapPath: string | null;
	remapped: boolean;
}

export interface IModelMaterialRemapResult extends IModelMaterialRemapDefinition {
	matched: boolean;
	materialObjectCount: number;
	meshReferenceCount: number;
	replacementMaterialName: string | null;
}

const MAX_MODEL_MATERIAL_REMAPS = 128;

function requiredString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} must be a non-empty string.`);
	}
	const result = value.trim();
	if (result.length > maximum) {
		throw new Error(`${label} is limited to ${maximum} characters.`);
	}
	return result;
}

function normalizeMaterialPath(value: unknown): string {
	const path = normalize(requiredString(value, "Material remap path", 1024).replace(/\\/g, "/")).replace(/^\.\//, "");
	if (isAbsolute(path) || path === ".." || path.startsWith("../")) {
		throw new Error("Material remap paths must stay inside the project.");
	}
	if (extname(path).toLowerCase() !== ".material") {
		throw new Error(`Material remap path "${path}" must reference a .material asset.`);
	}
	return path;
}

/** Normalizes the persisted complete source-material replacement table. */
export function normalizeModelMaterialRemaps(value: unknown): IModelMaterialRemapDefinition[] {
	let input = value;
	if (typeof input === "string") {
		try {
			input = JSON.parse(input || "[]");
		} catch (error) {
			throw new Error(`Material remaps must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (input === undefined || input === null) {
		return [];
	}
	if (!Array.isArray(input)) {
		throw new Error("Material remaps must be an array.");
	}
	if (input.length > MAX_MODEL_MATERIAL_REMAPS) {
		throw new Error(`Model importers support at most ${MAX_MODEL_MATERIAL_REMAPS} material remaps.`);
	}
	const result = input.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Material remap ${index + 1} must be an object.`);
		}
		const record = entry as Record<string, unknown>;
		const unknown = Object.keys(record).filter((key) => key !== "sourceMaterial" && key !== "materialPath");
		if (unknown.length) {
			throw new Error(`Material remap ${index + 1} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
		}
		return {
			sourceMaterial: requiredString(record.sourceMaterial, `Material remap ${index + 1} sourceMaterial`, 512),
			materialPath: normalizeMaterialPath(record.materialPath),
		};
	});
	const sourceNames = new Set<string>();
	for (const definition of result) {
		if (sourceNames.has(definition.sourceMaterial)) {
			throw new Error(`Material remap source names must be unique; duplicate "${definition.sourceMaterial}".`);
		}
		sourceNames.add(definition.sourceMaterial);
	}
	return result;
}

export function serializeModelMaterialRemaps(value: unknown): string {
	return JSON.stringify(normalizeModelMaterialRemaps(value));
}
