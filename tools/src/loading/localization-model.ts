import { getECSStableHash } from "../ecs/hash";

export const localizationDataVersion = 2 as const;

export type LocalizationDirection = "auto" | "ltr" | "rtl";

export interface ILocalizationPseudoLocale {
	enabled: boolean;
	expansionPercent: number;
	accent: boolean;
	wrap: boolean;
	mirror: boolean;
}

export interface ILocalizationLocale {
	id: string;
	name: string;
	direction: LocalizationDirection;
	fallbackLocales: string[];
	pseudo: ILocalizationPseudoLocale | null;
}

export interface ILocalizationTable {
	name: string;
	fallbackLocale: string;
	fallbackLocales: string[];
	preload: boolean;
	smartEntries: string[];
	entries: Record<string, Record<string, string>>;
}

export interface ILocalizedAssetReference {
	path: string;
	type: "audio" | "binary" | "font" | "model" | "texture" | "video";
	addressableGroup?: string;
	address?: string;
}

export interface ILocalizationAssetTable {
	name: string;
	fallbackLocale: string;
	fallbackLocales: string[];
	preload: boolean;
	entries: Record<string, Record<string, ILocalizedAssetReference>>;
}

export interface ILocalizationData {
	version: typeof localizationDataVersion;
	revision: number;
	defaultLocale: string;
	locales: ILocalizationLocale[];
	tables: ILocalizationTable[];
	assetTables: ILocalizationAssetTable[];
}

const localePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const namePattern = /^[^\0\r\n]{1,128}$/;

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function name(value: unknown, label: string): string {
	if (typeof value !== "string" || !namePattern.test(value.trim())) {
		throw new Error(`${label} must contain 1-128 characters without line breaks.`);
	}
	return value.trim();
}

/** Canonicalizes bounded BCP-47-like locale identifiers without accepting arbitrary text. */
export function normalizeLocaleId(value: unknown): string {
	if (typeof value !== "string" || !localePattern.test(value.trim())) {
		throw new Error("Locale id must be a bounded BCP-47 language tag.");
	}
	try {
		return Intl.getCanonicalLocales(value.trim())[0];
	} catch {
		throw new Error(`Locale id is invalid: ${value}`);
	}
}

function unique(values: unknown, maximum: number, label: string): string[] {
	if (!Array.isArray(values) || values.length > maximum) {
		throw new Error(`${label} must be an array with at most ${maximum} entries.`);
	}
	const result = values.map(normalizeLocaleId);
	if (new Set(result).size !== result.length) {
		throw new Error(`${label} cannot contain duplicates.`);
	}
	return result;
}

function normalizePseudoLocale(value: unknown): ILocalizationPseudoLocale | null {
	if (value === null || value === undefined) {
		return null;
	}
	const source = object(value, "Pseudo-locale settings");
	for (const key of ["enabled", "accent", "wrap", "mirror"] as const) {
		if (source[key] !== undefined && typeof source[key] !== "boolean") {
			throw new Error(`Pseudo-locale ${key} must be boolean.`);
		}
	}
	const expansionPercent = Number(source.expansionPercent ?? 30);
	if (!Number.isFinite(expansionPercent) || expansionPercent < 0 || expansionPercent > 200) {
		throw new Error("Pseudo-locale expansionPercent must be between 0 and 200.");
	}
	return {
		enabled: source.enabled !== false,
		expansionPercent,
		accent: source.accent !== false,
		wrap: source.wrap !== false,
		mirror: source.mirror === true,
	};
}

function normalizeLocales(value: unknown, discovered: Set<string>): ILocalizationLocale[] {
	const values = value === undefined ? [] : value;
	if (!Array.isArray(values) || values.length > 256) {
		throw new Error("Localization supports at most 256 locales.");
	}
	const result = values.map((entry): ILocalizationLocale => {
		const source = object(entry, "Locale");
		const id = normalizeLocaleId(source.id);
		return {
			id,
			name: source.name === undefined ? id : name(source.name, "Locale name"),
			direction: source.direction === undefined ? "auto" : (source.direction as LocalizationDirection),
			fallbackLocales: source.fallbackLocales === undefined ? [] : unique(source.fallbackLocales, 16, "Locale fallbackLocales"),
			pseudo: normalizePseudoLocale(source.pseudo),
		};
	});
	for (const id of discovered) {
		if (!result.some((locale) => locale.id === id)) {
			result.push({ id, name: id, direction: "auto", fallbackLocales: [], pseudo: null });
		}
	}
	if (new Set(result.map((locale) => locale.id)).size !== result.length) {
		throw new Error("Locale ids must be unique.");
	}
	if (result.some((locale) => !["auto", "ltr", "rtl"].includes(locale.direction))) {
		throw new Error("Locale direction must be auto, ltr, or rtl.");
	}
	return result;
}

function normalizeStringTables(value: unknown, discovered: Set<string>): ILocalizationTable[] {
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("Localization supports at most 128 string tables.");
	}
	let entryCount = 0;
	const tables = value.map((entry): ILocalizationTable => {
		const source = object(entry, "Localization string table");
		const fallbackLocale = normalizeLocaleId(source.fallbackLocale ?? "en");
		discovered.add(fallbackLocale);
		const entriesSource = object(source.entries ?? {}, "Localization string table entries");
		const entries: Record<string, Record<string, string>> = {};
		for (const [key, localizedValue] of Object.entries(entriesSource)) {
			if (++entryCount > 10_000) {
				throw new Error("Localization string tables support at most 10,000 entries.");
			}
			const localized = object(localizedValue, `Localization entry ${key}`);
			entries[name(key, "Localization key")] = Object.fromEntries(
				Object.entries(localized).map(([locale, text]) => {
					const localeId = normalizeLocaleId(locale);
					discovered.add(localeId);
					if (typeof text !== "string" || text.length > 32_768) {
						throw new Error(`Localized value ${key}/${localeId} must contain at most 32,768 characters.`);
					}
					return [localeId, text];
				})
			);
		}
		if (source.smartEntries !== undefined && !Array.isArray(source.smartEntries)) {
			throw new Error("Localization smartEntries must be an array.");
		}
		const smartEntries = source.smartEntries === undefined ? [] : source.smartEntries.map((key) => name(key, "Smart entry key"));
		if (smartEntries.length > Object.keys(entries).length || smartEntries.some((key) => !(key in entries)) || new Set(smartEntries).size !== smartEntries.length) {
			throw new Error("Smart entry keys must be unique existing string-table keys.");
		}
		const fallbackLocales = source.fallbackLocales === undefined ? [] : unique(source.fallbackLocales, 16, "Table fallbackLocales");
		fallbackLocales.forEach((locale) => discovered.add(locale));
		if (source.preload !== undefined && typeof source.preload !== "boolean") {
			throw new Error("Localization table preload must be boolean.");
		}
		return {
			name: name(source.name, "Localization table name"),
			fallbackLocale,
			fallbackLocales,
			preload: source.preload === true,
			smartEntries,
			entries,
		};
	});
	if (new Set(tables.map((table) => table.name)).size !== tables.length) {
		throw new Error("Localization string table names must be unique.");
	}
	return tables;
}

function normalizeAssetReference(value: unknown): ILocalizedAssetReference {
	const source = object(value, "Localized asset reference");
	const path = name(source.path, "Localized asset path");
	if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "..")) {
		throw new Error(`Localized asset path must be normalized and project-relative: ${path}`);
	}
	const type = source.type ?? "binary";
	if (!["audio", "binary", "font", "model", "texture", "video"].includes(String(type))) {
		throw new Error("Localized asset type is unsupported.");
	}
	const result: ILocalizedAssetReference = { path, type: type as ILocalizedAssetReference["type"] };
	if (source.addressableGroup !== undefined) {
		result.addressableGroup = name(source.addressableGroup, "Addressable group");
	}
	if (source.address !== undefined) {
		result.address = name(source.address, "Addressable address");
	}
	if ((result.addressableGroup === undefined) !== (result.address === undefined)) {
		throw new Error("Localized Addressable references require both addressableGroup and address.");
	}
	return result;
}

function normalizeAssetTables(value: unknown, discovered: Set<string>): ILocalizationAssetTable[] {
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error("Localization supports at most 128 asset tables.");
	}
	let entryCount = 0;
	const tables = value.map((entry): ILocalizationAssetTable => {
		const source = object(entry, "Localization asset table");
		const fallbackLocale = normalizeLocaleId(source.fallbackLocale ?? "en");
		discovered.add(fallbackLocale);
		const entries: ILocalizationAssetTable["entries"] = {};
		for (const [key, localizedValue] of Object.entries(object(source.entries ?? {}, "Localization asset table entries"))) {
			if (++entryCount > 10_000) {
				throw new Error("Localization asset tables support at most 10,000 entries.");
			}
			entries[name(key, "Localized asset key")] = Object.fromEntries(
				Object.entries(object(localizedValue, `Localized asset entry ${key}`)).map(([locale, reference]) => {
					const localeId = normalizeLocaleId(locale);
					discovered.add(localeId);
					return [localeId, normalizeAssetReference(reference)];
				})
			);
		}
		const fallbackLocales = source.fallbackLocales === undefined ? [] : unique(source.fallbackLocales, 16, "Asset table fallbackLocales");
		fallbackLocales.forEach((locale) => discovered.add(locale));
		if (source.preload !== undefined && typeof source.preload !== "boolean") {
			throw new Error("Localization asset table preload must be boolean.");
		}
		return {
			name: name(source.name, "Localization asset table name"),
			fallbackLocale,
			fallbackLocales,
			preload: source.preload === true,
			entries,
		};
	});
	if (new Set(tables.map((table) => table.name)).size !== tables.length) {
		throw new Error("Localization asset table names must be unique.");
	}
	return tables;
}

function validateFallbacks(data: ILocalizationData): void {
	const locales = new Map(data.locales.map((locale) => [locale.id, locale]));
	for (const locale of data.locales) {
		if (locale.fallbackLocales.some((fallback) => !locales.has(fallback))) {
			throw new Error(`Locale ${locale.id} references an unknown fallback locale.`);
		}
		const visit = (candidate: string, path: ReadonlySet<string>): void => {
			if (path.has(candidate)) {
				throw new Error(`Locale fallback cycle detected from ${locale.id} through ${candidate}.`);
			}
			const nextPath = new Set(path).add(candidate);
			locales.get(candidate)?.fallbackLocales.forEach((fallback) => visit(fallback, nextPath));
		};
		locale.fallbackLocales.forEach((fallback) => visit(fallback, new Set([locale.id])));
	}
}

/** Migrates legacy version-1 files and validates the complete bounded localization document. */
export function normalizeLocalizationData(value?: unknown): ILocalizationData {
	const source = value === undefined ? {} : object(value, "Localization data");
	if (source.version !== undefined && source.version !== 1 && source.version !== localizationDataVersion) {
		throw new Error(`Localization data version is unsupported: ${String(source.version)}`);
	}
	const discovered = new Set<string>();
	const tables = normalizeStringTables(source.tables ?? [], discovered);
	const assetTables = normalizeAssetTables(source.assetTables ?? [], discovered);
	const defaultLocale = normalizeLocaleId(source.defaultLocale ?? tables[0]?.fallbackLocale ?? assetTables[0]?.fallbackLocale ?? "en");
	discovered.add(defaultLocale);
	const data: ILocalizationData = {
		version: localizationDataVersion,
		revision: source.revision === undefined ? 0 : (source.revision as number),
		defaultLocale,
		locales: normalizeLocales(source.locales, discovered),
		tables,
		assetTables,
	};
	if (!Number.isSafeInteger(data.revision) || data.revision < 0) {
		throw new Error("Localization revision must be a non-negative safe integer.");
	}
	if (!data.locales.some((locale) => locale.id === data.defaultLocale)) {
		throw new Error("Default locale must reference a configured locale.");
	}
	validateFallbacks(data);
	return data;
}

/** Stable authoring fingerprint protects external clients from stale localization writes. */
export function getLocalizationFingerprint(value: ILocalizationData): string {
	return getECSStableHash(normalizeLocalizationData(value));
}

const rtlLanguages = new Set(["ar", "dv", "fa", "he", "ku", "ps", "sd", "ug", "ur", "yi"]);

/** Resolves authored direction or a deterministic language-based default. */
export function getLocalizationDirection(localeId: string, authored: LocalizationDirection = "auto"): "ltr" | "rtl" {
	if (authored !== "auto") {
		return authored;
	}
	return rtlLanguages.has(normalizeLocaleId(localeId).split("-")[0].toLowerCase()) ? "rtl" : "ltr";
}
