import type { ITextureImporterSettings, TextureImporterCompression, TextureImporterResizeAlgorithm } from "./texture-importer";

export type TextureImporterPlatform = "default" | "web" | "desktop";
export type TextureImporterOverridePlatform = Exclude<TextureImporterPlatform, "default">;

export interface ITextureImporterPlatformOverride {
	enabled: boolean;
	maxSize?: number;
	resizeAlgorithm?: TextureImporterResizeAlgorithm;
	compression?: TextureImporterCompression;
	generateMipmaps?: boolean;
	readable?: boolean;
}

export type ITextureImporterPlatformOverrides = Partial<Record<TextureImporterOverridePlatform, ITextureImporterPlatformOverride>>;

export interface IResolvedTextureImporterPlatformSettings {
	platform: TextureImporterPlatform;
	overrideApplied: boolean;
	override: ITextureImporterPlatformOverride | null;
	settings: ITextureImporterSettings;
}

const maximumJsonLength = 65_536;
const maximumSizes = new Set([32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384]);
const overrideKeys = new Set(["enabled", "maxSize", "resizeAlgorithm", "compression", "generateMipmaps", "readable"]);

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function optionalBoolean(source: Record<string, unknown>, key: "generateMipmaps" | "readable"): boolean | undefined {
	const value = source[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`Texture platform override ${key} must be a boolean.`);
	}
	return value;
}

function optionalEnum<T extends string>(source: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
	const value = source[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`Texture platform override ${key} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

function normalizeOverride(value: unknown): ITextureImporterPlatformOverride {
	const source = record(value, "Texture platform override");
	const unknown = Object.keys(source).filter((key) => !overrideKeys.has(key));
	if (unknown.length) {
		throw new Error(`Unsupported texture platform override setting(s): ${unknown.sort().join(", ")}.`);
	}
	if (typeof source.enabled !== "boolean") {
		throw new Error("Texture platform override enabled must be a boolean.");
	}
	if (source.maxSize !== undefined && (typeof source.maxSize !== "number" || !maximumSizes.has(source.maxSize))) {
		throw new Error("Texture platform override maxSize must be a power of two from 32 through 16384.");
	}
	const resizeAlgorithm = optionalEnum(source, "resizeAlgorithm", ["nearest", "bilinear", "bicubic", "lanczos3"] as const);
	const compression = optionalEnum(source, "compression", ["none", "low", "normal", "high"] as const);
	const generateMipmaps = optionalBoolean(source, "generateMipmaps");
	const readable = optionalBoolean(source, "readable");
	return {
		enabled: source.enabled,
		...(source.maxSize !== undefined ? { maxSize: source.maxSize as number } : {}),
		...(resizeAlgorithm !== undefined ? { resizeAlgorithm } : {}),
		...(compression !== undefined ? { compression } : {}),
		...(generateMipmaps !== undefined ? { generateMipmaps } : {}),
		...(readable !== undefined ? { readable } : {}),
	};
}

/** Parses the persisted closed Web/Desktop texture override map. */
export function normalizeTextureImporterPlatformOverrides(value: unknown): ITextureImporterPlatformOverrides {
	if (value === undefined || value === null || value === "") {
		return {};
	}
	let parsed = value;
	if (typeof parsed === "string") {
		if (parsed.length > maximumJsonLength) {
			throw new Error(`Texture platform overrides JSON is limited to ${maximumJsonLength} characters.`);
		}
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error("Texture platform overrides must be valid JSON.");
		}
	}
	const source = record(parsed, "Texture platform overrides");
	const unknown = Object.keys(source).filter((key) => key !== "web" && key !== "desktop");
	if (unknown.length) {
		throw new Error(`Unsupported texture importer platform(s): ${unknown.sort().join(", ")}.`);
	}
	return {
		...(source.web !== undefined ? { web: normalizeOverride(source.web) } : {}),
		...(source.desktop !== undefined ? { desktop: normalizeOverride(source.desktop) } : {}),
	};
}

/** Serializes platform overrides deterministically for metadata and cache fingerprints. */
export function serializeTextureImporterPlatformOverrides(value: unknown): string {
	const overrides = normalizeTextureImporterPlatformOverrides(value);
	return JSON.stringify({ ...(overrides.web ? { web: overrides.web } : {}), ...(overrides.desktop ? { desktop: overrides.desktop } : {}) });
}

/** Maps build-profile and CLI target names to executable texture target families. */
export function normalizeTextureImporterPlatform(value: unknown): TextureImporterPlatform {
	if (value === "web") {
		return "web";
	}
	if (value === "desktop" || value === "electron") {
		return "desktop";
	}
	return "default";
}

/** Resolves immutable effective settings for one target while retaining the authored override map. */
export function resolveTextureImporterPlatformSettings(settings: ITextureImporterSettings, requestedPlatform: unknown): IResolvedTextureImporterPlatformSettings {
	const platform = normalizeTextureImporterPlatform(requestedPlatform);
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
