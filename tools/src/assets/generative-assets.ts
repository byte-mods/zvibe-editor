export const GENERATIVE_ASSET_CONTRACT = "zvibe-generative-assets-v1" as const;
export const GENERATIVE_ASSET_CONTRACT_VERSION = 1 as const;

export const maximumGenerativePromptCharacters = 8_192;
export const maximumGenerativeReferences = 8;
export const maximumGenerativeReferenceBytes = 64 * 1024 * 1024;
export const maximumGenerativeParameters = 32;
export const maximumGenerativeCandidates = 4;
export const maximumGenerativeArtifacts = 64;
export const maximumGenerativeOutputBytes = 512 * 1024 * 1024;
export const maximumGenerativeInlineArtifactBytes = 64 * 1024 * 1024;

export const generativeAssetModalities = ["image", "sprite", "material", "animation", "audio"] as const;
export type GenerativeAssetModality = (typeof generativeAssetModalities)[number];

export const generativeProviderClassifications = ["generative-ai", "procedural", "test-fixture"] as const;
export type GenerativeProviderClassification = (typeof generativeProviderClassifications)[number];

export const generativeReferenceRoles = ["content", "style", "character", "motion", "audio-guide", "mask"] as const;
export type GenerativeReferenceRole = (typeof generativeReferenceRoles)[number];

export const generativeMaterialMapRoles = ["base-color", "normal", "metallic", "roughness", "ambient-occlusion", "height", "emissive", "opacity"] as const;
export type GenerativeMaterialMapRole = (typeof generativeMaterialMapRoles)[number];

export const generativeArtifactRoles = [
	"image",
	"sprite",
	"spritesheet",
	"material",
	...generativeMaterialMapRoles,
	"animation",
	"audio",
	"preview-image",
	"preview-audio",
	"preview-video",
	"source-video",
	"metadata",
] as const;
export type GenerativeArtifactRole = (typeof generativeArtifactRoles)[number];

export type GenerativeParameterScalar = string | number | boolean;
export type GenerativeParameterValue = GenerativeParameterScalar | GenerativeParameterScalar[];

export interface IGenerativeAssetReference {
	path: string;
	role: GenerativeReferenceRole;
}

export interface IGenerativeImageOptions {
	width: number;
	height: number;
	transparent: boolean;
}

export interface IGenerativeSpriteOptions extends IGenerativeImageOptions {
	removeBackground: boolean;
	pixelsPerUnit: number;
	spritesheet: {
		columns: number;
		rows: number;
		framesPerSecond: number;
	} | null;
}

export interface IGenerativeMaterialOptions {
	resolution: number;
	tileable: boolean;
	maps: GenerativeMaterialMapRole[];
}

export interface IGenerativeAnimationOptions {
	durationSeconds: number;
	framesPerSecond: number;
	loop: boolean;
	rig: "none" | "generic" | "humanoid" | "sprite";
}

export interface IGenerativeAudioOptions {
	durationSeconds: number;
	sampleRate: number;
	channels: 1 | 2;
	loop: boolean;
}

export type GenerativeAssetOptions =
	| { modality: "image"; value: IGenerativeImageOptions }
	| { modality: "sprite"; value: IGenerativeSpriteOptions }
	| { modality: "material"; value: IGenerativeMaterialOptions }
	| { modality: "animation"; value: IGenerativeAnimationOptions }
	| { modality: "audio"; value: IGenerativeAudioOptions };

export interface IGenerativeAssetRequest {
	version: typeof GENERATIVE_ASSET_CONTRACT_VERSION;
	modality: GenerativeAssetModality;
	prompt: string;
	negativePrompt: string | null;
	style: string | null;
	seed: number | null;
	count: number;
	references: IGenerativeAssetReference[];
	parameters: Record<string, GenerativeParameterValue>;
	options: GenerativeAssetOptions;
}

export interface IGenerativeExecutableTransport {
	kind: "executable";
	executable: string;
	args: string[];
	credentialEnvironments: string[];
}

export interface IGenerativeHttpTransport {
	kind: "http";
	endpoint: string;
	authorizationEnvironment: string | null;
	headers: Record<string, string>;
}

export type GenerativeProviderTransport = IGenerativeExecutableTransport | IGenerativeHttpTransport;

export interface IGenerativeAssetProviderManifest {
	version: typeof GENERATIVE_ASSET_CONTRACT_VERSION;
	id: string;
	name: string;
	vendor: string;
	classification: GenerativeProviderClassification;
	modalities: GenerativeAssetModality[];
	hostPlatforms: Array<"darwin" | "win32" | "linux">;
	maximumOutputBytes: number;
	maximumDurationSeconds: number;
	transport: GenerativeProviderTransport;
}

export interface IGenerativeAssetProviderArtifact {
	path: string;
	role: GenerativeArtifactRole;
	mediaType: string;
	displayName: string | null;
	dataBase64: string | null;
}

export interface IGenerativeAssetCandidate {
	id: string;
	reportedModel: string | null;
	reportedSeed: number | null;
	providerRequestId: string | null;
	warnings: string[];
	artifacts: IGenerativeAssetProviderArtifact[];
}

export interface IGenerativeAssetProviderResult {
	version: typeof GENERATIVE_ASSET_CONTRACT_VERSION;
	candidates: IGenerativeAssetCandidate[];
}

export interface IGenerativeAssetResolvedReference extends IGenerativeAssetReference {
	sha256: string;
	sizeBytes: number;
	mediaType: string;
	localPath?: string;
	dataBase64?: string;
}

export interface IGenerativeAssetProviderRequestEnvelope {
	contract: typeof GENERATIVE_ASSET_CONTRACT;
	version: typeof GENERATIVE_ASSET_CONTRACT_VERSION;
	jobId: string;
	requestFingerprint: string;
	request: IGenerativeAssetRequest;
	references: IGenerativeAssetResolvedReference[];
}

export interface IGenerativeAssetArtifactProvenance {
	path: string;
	role: GenerativeArtifactRole;
	mediaType: string;
	sha256: string;
	sizeBytes: number;
}

export interface IGenerativeAssetProvenance {
	contract: typeof GENERATIVE_ASSET_CONTRACT;
	version: typeof GENERATIVE_ASSET_CONTRACT_VERSION;
	generatedAt: string;
	jobId: string;
	provider: {
		id: string;
		name: string;
		vendor: string;
		classification: GenerativeProviderClassification;
		manifestFingerprint: string;
		transport: GenerativeProviderTransport["kind"];
	};
	request: IGenerativeAssetRequest;
	requestFingerprint: string;
	resultFingerprint: string;
	candidateId: string;
	reportedModel: string | null;
	reportedSeed: number | null;
	providerRequestId: string | null;
	references: Array<Omit<IGenerativeAssetResolvedReference, "localPath" | "dataBase64">>;
	artifacts: IGenerativeAssetArtifactProvenance[];
	execution: {
		startedAt: string;
		completedAt: string;
		durationMilliseconds: number;
		exitCode: number | null;
		httpStatus: number | null;
	};
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const providerIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const environmentPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const executablePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const parameterKeyPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const mediaTypePattern = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/i;
const artifactPlaceholderPattern = /\$\{(REQUEST|OUTPUT|JOB_ID|PROJECT)\}/g;

function record(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const result = value as Record<string, unknown>;
	const unknown = Object.keys(result).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
	return result;
}

function openRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, maximum: number, optional = false): string | null {
	if ((value === undefined || value === null || value === "") && optional) {
		return null;
	}
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0]/.test(value)) {
		throw new Error(`${label} must contain 1 through ${maximum} characters without null bytes.`);
	}
	return value.trim();
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) {
		throw new Error(`${label} must be ${integer ? "an integer " : "a finite number "}from ${minimum} through ${maximum}.`);
	}
	return value;
}

function booleanValue(value: unknown, label: string, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a Boolean.`);
	}
	return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

function portablePath(value: unknown, label: string, maximum = 2_048, requireAssets = false): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\\") || value.includes("\0") || value.startsWith("/")) {
		throw new Error(`${label} must be a project-relative POSIX path of at most ${maximum} characters.`);
	}
	const result = value.trim().replace(/^\.\//, "");
	const segments = result.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === "..") || (requireAssets && segments[0] !== "assets")) {
		throw new Error(`${label} must ${requireAssets ? "stay under assets/ and " : ""}not contain empty, current-directory, or parent-directory segments.`);
	}
	return result;
}

function normalizedParameters(value: unknown): Record<string, GenerativeParameterValue> {
	const source = openRecord(value ?? {}, "Generative parameters");
	const entries = Object.entries(source);
	if (entries.length > maximumGenerativeParameters) {
		throw new Error(`Generative parameters contain more than ${maximumGenerativeParameters} entries.`);
	}
	const result: Record<string, GenerativeParameterValue> = {};
	for (const [key, raw] of entries) {
		if (!parameterKeyPattern.test(key)) {
			throw new Error(`Generative parameter key "${key}" is invalid.`);
		}
		const values = Array.isArray(raw) ? raw : [raw];
		if (!values.length || values.length > 64) {
			throw new Error(`Generative parameter "${key}" must contain 1 through 64 scalar values.`);
		}
		const normalized = values.map((entry) => {
			if (typeof entry === "string") {
				if (entry.length > 1_024 || entry.includes("\0")) {
					throw new Error(`Generative parameter "${key}" strings are limited to 1024 characters without null bytes.`);
				}
				return entry;
			}
			if (typeof entry === "number") {
				if (!Number.isFinite(entry) || Math.abs(entry) > 1_000_000_000_000) {
					throw new Error(`Generative parameter "${key}" numbers must be finite and bounded.`);
				}
				return entry;
			}
			if (typeof entry !== "boolean") {
				throw new Error(`Generative parameter "${key}" accepts only strings, finite numbers, Booleans, or arrays of those scalars.`);
			}
			return entry;
		});
		result[key] = Array.isArray(raw) ? normalized : normalized[0];
	}
	if (JSON.stringify(result).length > 32_768) {
		throw new Error("Generative parameters exceed the 32 KiB serialized limit.");
	}
	return result;
}

function normalizeReferences(value: unknown): IGenerativeAssetReference[] {
	const source = value ?? [];
	if (!Array.isArray(source)) {
		throw new Error("Generative references must be an array.");
	}
	if (source.length > maximumGenerativeReferences) {
		throw new Error(`Generative requests accept at most ${maximumGenerativeReferences} references.`);
	}
	const paths = new Set<string>();
	return source.map((entry, index) => {
		const source = record(entry, ["path", "role"], `Generative reference ${index + 1}`);
		const path = portablePath(source.path, `Generative reference ${index + 1} path`, 2_048, true);
		const key = path.toLocaleLowerCase("en-US");
		if (paths.has(key)) {
			throw new Error(`Generative reference path is duplicated: ${path}.`);
		}
		paths.add(key);
		return { path, role: enumValue(source.role, generativeReferenceRoles, `Generative reference ${index + 1} role`) };
	});
}

function normalizeImageOptions(value: unknown): IGenerativeImageOptions {
	const source = record(value ?? {}, ["width", "height", "transparent"], "Image generation options");
	return {
		width: finiteNumber(source.width ?? 1024, "Image width", 64, 4096, true),
		height: finiteNumber(source.height ?? 1024, "Image height", 64, 4096, true),
		transparent: booleanValue(source.transparent, "Image transparent", false),
	};
}

function normalizeSpriteOptions(value: unknown): IGenerativeSpriteOptions {
	const source = record(value ?? {}, ["width", "height", "transparent", "removeBackground", "pixelsPerUnit", "spritesheet"], "Sprite generation options");
	let spritesheet: IGenerativeSpriteOptions["spritesheet"] = null;
	if (source.spritesheet !== undefined && source.spritesheet !== null) {
		const sheet = record(source.spritesheet, ["columns", "rows", "framesPerSecond"], "Sprite sheet options");
		const columns = finiteNumber(sheet.columns ?? 4, "Sprite sheet columns", 1, 16, true);
		const rows = finiteNumber(sheet.rows ?? 4, "Sprite sheet rows", 1, 16, true);
		if (columns * rows > 256) {
			throw new Error("Sprite sheets are limited to 256 cells.");
		}
		spritesheet = { columns, rows, framesPerSecond: finiteNumber(sheet.framesPerSecond ?? 12, "Sprite sheet framesPerSecond", 1, 120) };
	}
	return {
		...normalizeImageOptions({ width: source.width, height: source.height, transparent: source.transparent }),
		removeBackground: booleanValue(source.removeBackground, "Sprite removeBackground", true),
		pixelsPerUnit: finiteNumber(source.pixelsPerUnit ?? 100, "Sprite pixelsPerUnit", 0.001, 1_000_000),
		spritesheet,
	};
}

function normalizeMaterialOptions(value: unknown): IGenerativeMaterialOptions {
	const source = record(value ?? {}, ["resolution", "tileable", "maps"], "Material generation options");
	const rawMaps = source.maps ?? ["base-color", "normal", "metallic", "roughness", "ambient-occlusion", "height"];
	if (!Array.isArray(rawMaps) || !rawMaps.length || rawMaps.length > generativeMaterialMapRoles.length) {
		throw new Error(`Material maps must contain 1 through ${generativeMaterialMapRoles.length} roles.`);
	}
	const maps = rawMaps.map((entry, index) => enumValue(entry, generativeMaterialMapRoles, `Material map ${index + 1}`));
	if (new Set(maps).size !== maps.length) {
		throw new Error("Material map roles must be unique.");
	}
	return {
		resolution: finiteNumber(source.resolution ?? 1024, "Material resolution", 64, 4096, true),
		tileable: booleanValue(source.tileable, "Material tileable", true),
		maps,
	};
}

function normalizeAnimationOptions(value: unknown): IGenerativeAnimationOptions {
	const source = record(value ?? {}, ["durationSeconds", "framesPerSecond", "loop", "rig"], "Animation generation options");
	return {
		durationSeconds: finiteNumber(source.durationSeconds ?? 2, "Animation durationSeconds", 0.1, 300),
		framesPerSecond: finiteNumber(source.framesPerSecond ?? 30, "Animation framesPerSecond", 1, 240),
		loop: booleanValue(source.loop, "Animation loop", true),
		rig: enumValue(source.rig ?? "generic", ["none", "generic", "humanoid", "sprite"] as const, "Animation rig"),
	};
}

function normalizeAudioOptions(value: unknown): IGenerativeAudioOptions {
	const source = record(value ?? {}, ["durationSeconds", "sampleRate", "channels", "loop"], "Audio generation options");
	const channels = finiteNumber(source.channels ?? 2, "Audio channels", 1, 2, true);
	return {
		durationSeconds: finiteNumber(source.durationSeconds ?? 5, "Audio durationSeconds", 0.1, 600),
		sampleRate: finiteNumber(source.sampleRate ?? 48_000, "Audio sampleRate", 8_000, 192_000, true),
		channels: channels as 1 | 2,
		loop: booleanValue(source.loop, "Audio loop", false),
	};
}

/** Normalizes one closed prompt/reference/options request shared by Editor UI and MCP clients. */
export function normalizeGenerativeAssetRequest(value: unknown): IGenerativeAssetRequest {
	const source = record(value, ["version", "modality", "prompt", "negativePrompt", "style", "seed", "count", "references", "parameters", "options"], "Generative asset request");
	if (source.version !== undefined && source.version !== GENERATIVE_ASSET_CONTRACT_VERSION) {
		throw new Error(`Generative asset request version must be ${GENERATIVE_ASSET_CONTRACT_VERSION}.`);
	}
	const modality = enumValue(source.modality, generativeAssetModalities, "Generative modality");
	let optionValue = source.options;
	if (optionValue && typeof optionValue === "object" && !Array.isArray(optionValue) && "modality" in optionValue) {
		const normalizedOptions = record(optionValue, ["modality", "value"], "Normalized generative options");
		if (normalizedOptions.modality !== modality) {
			throw new Error(`Normalized generative options modality must match request modality ${modality}.`);
		}
		optionValue = normalizedOptions.value;
	}
	const options: GenerativeAssetOptions =
		modality === "image"
			? { modality, value: normalizeImageOptions(optionValue) }
			: modality === "sprite"
				? { modality, value: normalizeSpriteOptions(optionValue) }
				: modality === "material"
					? { modality, value: normalizeMaterialOptions(optionValue) }
					: modality === "animation"
						? { modality, value: normalizeAnimationOptions(optionValue) }
						: { modality, value: normalizeAudioOptions(optionValue) };
	return {
		version: GENERATIVE_ASSET_CONTRACT_VERSION,
		modality,
		prompt: boundedText(source.prompt, "Generative prompt", maximumGenerativePromptCharacters)!,
		negativePrompt: boundedText(source.negativePrompt, "Generative negativePrompt", maximumGenerativePromptCharacters, true),
		style: boundedText(source.style, "Generative style", 512, true),
		seed: source.seed === undefined || source.seed === null ? null : finiteNumber(source.seed, "Generative seed", 0, 4_294_967_295, true),
		count: finiteNumber(source.count ?? 1, "Generative candidate count", 1, maximumGenerativeCandidates, true),
		references: normalizeReferences(source.references),
		parameters: normalizedParameters(source.parameters),
		options,
	};
}

function normalizeEnvironmentNames(value: unknown, label: string): string[] {
	const source = value ?? [];
	if (!Array.isArray(source) || source.length > 32) {
		throw new Error(`${label} must contain at most 32 environment-variable names.`);
	}
	const result = source.map((entry) => {
		if (typeof entry !== "string" || !environmentPattern.test(entry)) {
			throw new Error(`${label} must contain environment-variable names only.`);
		}
		return entry;
	});
	return [...new Set(result)];
}

function normalizeExecutableTransport(value: Record<string, unknown>): IGenerativeExecutableTransport {
	const source = record(value, ["kind", "executable", "args", "credentialEnvironments"], "Executable generative provider transport");
	if (typeof source.executable !== "string" || !executablePattern.test(source.executable) || source.executable.includes("/") || source.executable.includes("\\")) {
		throw new Error("Executable generative provider executable must be a command basename.");
	}
	const rawArgs = source.args ?? [];
	if (!Array.isArray(rawArgs) || rawArgs.length > 64) {
		throw new Error("Executable generative provider args must contain at most 64 values.");
	}
	const args = rawArgs.map((entry) => {
		if (typeof entry !== "string" || !entry.length || entry.length > 1_024 || /[\0\r\n]/.test(entry)) {
			throw new Error("Executable generative provider arguments must be bounded single-line strings.");
		}
		if (/\$\{/.test(entry.replace(artifactPlaceholderPattern, ""))) {
			throw new Error("Executable generative provider arguments contain an unsupported placeholder.");
		}
		return entry;
	});
	return { kind: "executable", executable: source.executable, args, credentialEnvironments: normalizeEnvironmentNames(source.credentialEnvironments, "Provider credentials") };
}

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.");
}

function normalizeHttpTransport(value: Record<string, unknown>): IGenerativeHttpTransport {
	const source = record(value, ["kind", "endpoint", "authorizationEnvironment", "headers"], "HTTP generative provider transport");
	let endpoint: URL;
	try {
		endpoint = new URL(String(source.endpoint));
	} catch {
		throw new Error("HTTP generative provider endpoint must be a valid URL.");
	}
	if (
		(endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopback(endpoint.hostname))) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new Error("HTTP generative provider endpoints must use HTTPS or loopback HTTP and cannot contain credentials, query parameters, or fragments.");
	}
	const headersSource = openRecord(source.headers ?? {}, "HTTP generative provider headers");
	if (Object.keys(headersSource).length > 16) {
		throw new Error("HTTP generative provider headers are limited to 16 entries.");
	}
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(headersSource)) {
		if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(key) || /authorization|cookie|token|secret|password|key/i.test(key)) {
			throw new Error(`HTTP generative provider header "${key}" is unsafe; credentials must use authorizationEnvironment.`);
		}
		if (typeof entry !== "string" || entry.length > 1_024 || /[\0\r\n]/.test(entry)) {
			throw new Error(`HTTP generative provider header "${key}" must be a bounded single-line string.`);
		}
		headers[key] = entry;
	}
	const authorizationEnvironment = source.authorizationEnvironment ?? null;
	if (authorizationEnvironment !== null && (typeof authorizationEnvironment !== "string" || !environmentPattern.test(authorizationEnvironment))) {
		throw new Error("HTTP generative provider authorizationEnvironment must be null or an environment-variable name.");
	}
	return { kind: "http", endpoint: endpoint.toString(), authorizationEnvironment: authorizationEnvironment as string | null, headers };
}

/** Validates one provider manifest without reading or returning credential values. */
export function normalizeGenerativeAssetProviderManifest(value: unknown): IGenerativeAssetProviderManifest {
	const source = record(
		value,
		["version", "id", "name", "vendor", "classification", "modalities", "hostPlatforms", "maximumOutputBytes", "maximumDurationSeconds", "transport"],
		"Generative provider manifest"
	);
	if (source.version !== GENERATIVE_ASSET_CONTRACT_VERSION || typeof source.id !== "string" || !providerIdentifierPattern.test(source.id)) {
		throw new Error(`Generative provider version must be ${GENERATIVE_ASSET_CONTRACT_VERSION} and id must be a cross-platform filename-safe identifier.`);
	}
	if (!Array.isArray(source.modalities) || !source.modalities.length || source.modalities.length > generativeAssetModalities.length) {
		throw new Error(`Generative provider modalities must contain 1 through ${generativeAssetModalities.length} entries.`);
	}
	const modalities = source.modalities.map((entry, index) => enumValue(entry, generativeAssetModalities, `Provider modality ${index + 1}`));
	if (new Set(modalities).size !== modalities.length) {
		throw new Error("Generative provider modalities must be unique.");
	}
	const rawHostPlatforms = source.hostPlatforms ?? [];
	if (!Array.isArray(rawHostPlatforms) || rawHostPlatforms.length > 3) {
		throw new Error("Generative provider hostPlatforms must be an array with at most three entries.");
	}
	const hostPlatforms = rawHostPlatforms.map((entry, index) => enumValue(entry, ["darwin", "win32", "linux"] as const, `Provider host platform ${index + 1}`));
	const transportSource = record(
		source.transport,
		["kind", "executable", "args", "credentialEnvironments", "endpoint", "authorizationEnvironment", "headers"],
		"Generative provider transport"
	);
	const transportKind = enumValue(transportSource.kind, ["executable", "http"] as const, "Generative provider transport kind");
	return {
		version: GENERATIVE_ASSET_CONTRACT_VERSION,
		id: source.id,
		name: boundedText(source.name, "Generative provider name", 128)!,
		vendor: boundedText(source.vendor, "Generative provider vendor", 128)!,
		classification: enumValue(source.classification, generativeProviderClassifications, "Generative provider classification"),
		modalities,
		hostPlatforms: [...new Set(hostPlatforms)],
		maximumOutputBytes: finiteNumber(source.maximumOutputBytes ?? 256 * 1024 * 1024, "Provider maximumOutputBytes", 1024 * 1024, maximumGenerativeOutputBytes, true),
		maximumDurationSeconds: finiteNumber(source.maximumDurationSeconds ?? 300, "Provider maximumDurationSeconds", 1, 1_800, true),
		transport: transportKind === "executable" ? normalizeExecutableTransport(transportSource) : normalizeHttpTransport(transportSource),
	};
}

function normalizeWarnings(value: unknown, label: string): string[] {
	const source = value ?? [];
	if (!Array.isArray(source) || source.length > 32) {
		throw new Error(`${label} must contain at most 32 strings.`);
	}
	return source.map((entry, index) => boundedText(entry, `${label} ${index + 1}`, 1_024)!);
}

/** Derives exact primary outputs, including every requested material map and the authored sprite-sheet mode. */
function requiredArtifactRoles(request: IGenerativeAssetRequest): GenerativeArtifactRole[] {
	return request.modality === "image"
		? ["image"]
		: request.modality === "sprite"
			? [request.options.modality === "sprite" && request.options.value.spritesheet ? "spritesheet" : "sprite"]
			: request.modality === "material"
				? request.options.modality === "material"
					? request.options.value.maps
					: []
				: request.modality === "animation"
					? ["animation"]
					: ["audio"];
}

/** Validates the closed result manifest written by an executable adapter or returned by an HTTP adapter. */
export function normalizeGenerativeAssetProviderResult(value: unknown, request: IGenerativeAssetRequest): IGenerativeAssetProviderResult {
	const source = record(value, ["version", "candidates"], "Generative provider result");
	if (source.version !== GENERATIVE_ASSET_CONTRACT_VERSION || !Array.isArray(source.candidates) || !source.candidates.length || source.candidates.length > request.count) {
		throw new Error(`Generative provider result version must be ${GENERATIVE_ASSET_CONTRACT_VERSION} and contain 1 through ${request.count} candidates.`);
	}
	let artifactCount = 0;
	const candidateIds = new Set<string>();
	const candidates = source.candidates.map((entry, candidateIndex) => {
		const candidate = record(entry, ["id", "reportedModel", "reportedSeed", "providerRequestId", "warnings", "artifacts"], `Generative candidate ${candidateIndex + 1}`);
		if (typeof candidate.id !== "string" || !identifierPattern.test(candidate.id) || candidateIds.has(candidate.id)) {
			throw new Error(`Generative candidate ${candidateIndex + 1} id must be a unique safe identifier.`);
		}
		candidateIds.add(candidate.id);
		if (!Array.isArray(candidate.artifacts) || !candidate.artifacts.length) {
			throw new Error(`Generative candidate ${candidate.id} must contain at least one artifact.`);
		}
		artifactCount += candidate.artifacts.length;
		if (artifactCount > maximumGenerativeArtifacts) {
			throw new Error(`Generative results are limited to ${maximumGenerativeArtifacts} artifacts.`);
		}
		const artifactPaths = new Set<string>();
		const artifacts = candidate.artifacts.map((artifactValue, artifactIndex) => {
			const artifact = record(
				artifactValue,
				["path", "role", "mediaType", "displayName", "dataBase64"],
				`Generative candidate ${candidate.id} artifact ${artifactIndex + 1}`
			);
			const path = portablePath(artifact.path, `Generative candidate ${candidate.id} artifact path`, 1_024);
			const key = path.toLocaleLowerCase("en-US");
			if (artifactPaths.has(key)) {
				throw new Error(`Generative candidate ${candidate.id} contains duplicate artifact path: ${path}.`);
			}
			artifactPaths.add(key);
			if (typeof artifact.mediaType !== "string" || !mediaTypePattern.test(artifact.mediaType)) {
				throw new Error(`Generative candidate ${candidate.id} artifact mediaType is invalid.`);
			}
			const dataBase64 = artifact.dataBase64 ?? null;
			if (
				dataBase64 !== null &&
				(typeof dataBase64 !== "string" ||
					!dataBase64.length ||
					dataBase64.length > Math.ceil((maximumGenerativeInlineArtifactBytes * 4) / 3) + 4 ||
					!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64))
			) {
				throw new Error(
					`Generative candidate ${candidate.id} artifact dataBase64 must contain at most ${maximumGenerativeInlineArtifactBytes} decoded bytes of canonical base64.`
				);
			}
			return {
				path,
				role: enumValue(artifact.role, generativeArtifactRoles, `Generative candidate ${candidate.id} artifact role`),
				mediaType: artifact.mediaType.toLowerCase(),
				displayName: boundedText(artifact.displayName, `Generative candidate ${candidate.id} artifact displayName`, 256, true),
				dataBase64,
			};
		});
		const artifactRoles = new Set(artifacts.map((artifact) => artifact.role));
		const uniquePrimaryRoles = new Set<GenerativeArtifactRole>();
		for (const artifact of artifacts.filter((entry) => !["preview-image", "preview-audio", "preview-video", "source-video", "metadata"].includes(entry.role))) {
			if (uniquePrimaryRoles.has(artifact.role)) {
				throw new Error(`Generative candidate ${candidate.id} contains duplicate primary artifact role ${artifact.role}.`);
			}
			uniquePrimaryRoles.add(artifact.role);
		}
		const missingRoles = requiredArtifactRoles(request).filter((role) => !artifactRoles.has(role));
		if (missingRoles.length) {
			throw new Error(`Generative candidate ${candidate.id} is missing required ${request.modality} artifact roles: ${missingRoles.join(", ")}.`);
		}
		return {
			id: candidate.id,
			reportedModel: boundedText(candidate.reportedModel, `Generative candidate ${candidate.id} reportedModel`, 256, true),
			reportedSeed:
				candidate.reportedSeed === undefined || candidate.reportedSeed === null
					? null
					: finiteNumber(candidate.reportedSeed, "Candidate reportedSeed", 0, 4_294_967_295, true),
			providerRequestId: boundedText(candidate.providerRequestId, `Generative candidate ${candidate.id} providerRequestId`, 512, true),
			warnings: normalizeWarnings(candidate.warnings, `Generative candidate ${candidate.id} warnings`),
			artifacts,
		};
	});
	return { version: GENERATIVE_ASSET_CONTRACT_VERSION, candidates };
}
