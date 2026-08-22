import { dirnamePortablePath as dirname, extnamePortablePath as extname, joinPortablePath as join, normalizePortablePath as normalize } from "./portable-path";

export interface IMaterialImporterSettings {
	validateTextures: boolean;
	extractEmbeddedTextures: boolean;
	compileNodeMaterial: boolean;
}

export type MaterialImporterSourceKind = "babylon-material" | "node-material" | "mtl";
export type MaterialTextureReferenceKind = "project" | "embedded" | "remote";

export interface IMaterialTextureReference {
	value: string;
	kind: MaterialTextureReferenceKind;
	resolvedPath: string | null;
	exists: boolean | null;
	locations: string[];
}

export interface IMaterialCompileResult {
	requested: boolean;
	attempted: boolean;
	valid: boolean | null;
	errors: string[];
	warnings: string[];
	statistics: {
		attachedBlockCount: number;
		outputBlockCount: number;
		textureBlockCount: number;
		compiledShaderCharacters: number;
	} | null;
}

export interface IMaterialImportResult {
	sourcePath: string;
	outputPath: string;
	sourceKind: MaterialImporterSourceKind;
	settings: IMaterialImporterSettings;
	sourceBytes: number;
	textureReferences: IMaterialTextureReference[];
	missingTextures: string[];
	extractedTextures: string[];
	compile: IMaterialCompileResult;
	valid: boolean;
	errors: string[];
	warnings: string[];
}

export interface IMaterialTextureCandidate {
	value: string;
	location: string;
	suggestedName?: string;
	setValue?: (value: string) => void;
}

export function normalizeMaterialImporterSettings(settings: Record<string, unknown>): IMaterialImporterSettings {
	return {
		validateTextures: settings.validateTextures === true,
		extractEmbeddedTextures: settings.extractEmbeddedTextures === true,
		compileNodeMaterial: settings.compileNodeMaterial === true,
	};
}

export function getMaterialSourceKind(path: string, data?: Record<string, unknown>): MaterialImporterSourceKind {
	if (extname(path).toLowerCase() === ".mtl") {
		return "mtl";
	}
	return data?.customType === "BABYLON.NodeMaterial" ? "node-material" : "babylon-material";
}

function isRemoteTexture(value: string): boolean {
	return /^(?:https?:)?\/\//i.test(value);
}

function isEmbeddedTexture(value: string): boolean {
	return /^data:image\//i.test(value);
}

function normalizeProjectTexturePath(sourcePath: string, value: string): string | null {
	const clean = value.split(/[?#]/, 1)[0].replace(/\\/g, "/");
	if (!clean || clean.startsWith("/") || /^[a-zA-Z]:\//.test(clean)) {
		return null;
	}
	const resolved = clean.startsWith("assets/") ? normalize(clean) : normalize(join(dirname(sourcePath), clean));
	if (resolved === ".." || resolved.startsWith("../")) {
		return null;
	}
	return resolved;
}

export function classifyMaterialTextureReference(sourcePath: string, value: string): { kind: MaterialTextureReferenceKind; resolvedPath: string | null } {
	if (isEmbeddedTexture(value)) {
		return { kind: "embedded", resolvedPath: null };
	}
	if (isRemoteTexture(value)) {
		return { kind: "remote", resolvedPath: null };
	}
	return { kind: "project", resolvedPath: normalizeProjectTexturePath(sourcePath, value) };
}

function collectTextureObjectCandidates(value: unknown, location: string, candidates: IMaterialTextureCandidate[], visited: Set<object>): void {
	if (!value || typeof value !== "object" || visited.has(value as object)) {
		return;
	}
	visited.add(value as object);
	if (Array.isArray(value)) {
		value.forEach((entry, index) => collectTextureObjectCandidates(entry, `${location}[${index}]`, candidates, visited));
		return;
	}
	const record = value as Record<string, unknown>;
	const embeddedBase64 = typeof record.base64String === "string" && isEmbeddedTexture(record.base64String) ? record.base64String : null;
	const textureLike =
		embeddedBase64 !== null ||
		typeof record.url === "string" ||
		(typeof record.name === "string" &&
			("coordinatesMode" in record || "samplingMode" in record || "isCube" in record || isEmbeddedTexture(record.name) || isRemoteTexture(record.name)));
	if (textureLike) {
		const current = embeddedBase64 ?? (typeof record.url === "string" && record.url ? record.url : (record.name as string));
		const candidate: IMaterialTextureCandidate = {
			value: current,
			location,
			suggestedName: typeof record.name === "string" && !isEmbeddedTexture(record.name) && !isRemoteTexture(record.name) ? record.name : undefined,
			setValue: (next) => {
				record.url = next;
				record.name = next;
				delete record.base64String;
				candidate.value = next;
			},
		};
		candidates.push(candidate);
	}
	for (const [key, entry] of Object.entries(record)) {
		if (key === "base64String") {
			continue;
		}
		collectTextureObjectCandidates(entry, location ? `${location}.${key}` : key, candidates, visited);
	}
}

/** Finds serialized Babylon material texture objects and retains setters for safe extraction rewrites. */
export function collectBabylonMaterialTextureCandidates(data: Record<string, unknown>): IMaterialTextureCandidate[] {
	const candidates: IMaterialTextureCandidate[] = [];
	collectTextureObjectCandidates(data, "", candidates, new Set());
	return candidates;
}

/** Rewrites project-contained Babylon texture references to absolute paths before Material.Parse loads them. */
export function resolveBabylonMaterialTextureReferencesForLoading(sourcePath: string, data: Record<string, unknown>, projectRoot: string): string[] {
	const resolvedPaths = new Set<string>();
	for (const candidate of collectBabylonMaterialTextureCandidates(data)) {
		const reference = classifyMaterialTextureReference(sourcePath, candidate.value);
		if (reference.kind === "project" && reference.resolvedPath) {
			const absolutePath = join(projectRoot, reference.resolvedPath);
			candidate.setValue?.(absolutePath);
			resolvedPaths.add(absolutePath);
		}
	}
	return [...resolvedPaths].sort();
}

/** Parses map directives from Wavefront MTL without treating directive options as texture paths. */
export function collectMtlTextureCandidates(source: string): IMaterialTextureCandidate[] {
	const candidates: IMaterialTextureCandidate[] = [];
	for (const [index, line] of source.split(/\r?\n/).entries()) {
		const trimmed = line.trim();
		if (!/^(?:map_[a-z0-9_]+|bump|disp|decal|refl)\s+/i.test(trimmed)) {
			continue;
		}
		const quoted = [...trimmed.matchAll(/"([^"]+)"/g)].at(-1)?.[1];
		const value = quoted ?? trimmed.split(/\s+/).at(-1);
		if (value) {
			candidates.push({ value, location: `line ${index + 1}` });
		}
	}
	return candidates;
}

export function groupMaterialTextureCandidates(
	sourcePath: string,
	candidates: IMaterialTextureCandidate[],
	existsByPath: ReadonlyMap<string, boolean>
): IMaterialTextureReference[] {
	const grouped = new Map<string, IMaterialTextureReference>();
	for (const candidate of candidates) {
		const classified = classifyMaterialTextureReference(sourcePath, candidate.value);
		const key = `${classified.kind}\0${candidate.value}`;
		const current = grouped.get(key);
		if (current) {
			if (!current.locations.includes(candidate.location)) {
				current.locations.push(candidate.location);
			}
			continue;
		}
		grouped.set(key, {
			value: candidate.value,
			kind: classified.kind,
			resolvedPath: classified.resolvedPath,
			exists: classified.kind === "project" ? (classified.resolvedPath ? (existsByPath.get(classified.resolvedPath) ?? false) : false) : null,
			locations: [candidate.location],
		});
	}
	return [...grouped.values()].sort((left, right) => left.value.localeCompare(right.value));
}
