import { Observable } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

import type { AddressableCatalog } from "./addressables";
import { formatLocalizationString, LocalizationSmartValue, pseudoLocalizeString } from "./localization-smart";
import {
	getLocalizationDirection,
	ILocalizationAssetTable,
	ILocalizationData,
	ILocalizationLocale,
	ILocalizationTable,
	ILocalizedAssetReference,
	normalizeLocaleId,
	normalizeLocalizationData,
} from "./localization-model";

export * from "./localization-model";
export * from "./localization-smart";

export interface ILocalizationResolution<T> {
	table: string;
	key: string;
	requestedLocale: string;
	resolvedLocale: string;
	direction: "ltr" | "rtl";
	value: T;
}

export interface ILocalizedAssetLoad extends ILocalizationResolution<ILocalizedAssetReference> {
	bytes: ArrayBuffer;
}

function parentLocales(locale: string): string[] {
	const parts = locale.split("-");
	const result: string[] = [];
	while (parts.length > 1) {
		parts.pop();
		result.push(parts.join("-"));
	}
	return result;
}

/** Resolves strings and assets through one locale/fallback lifecycle shared by every loader. */
export class LocalizationManager {
	private _data: ILocalizationData;
	private _locale: string;
	private _rootUrl: string;
	private _assetCache = new Map<string, Promise<ArrayBuffer>>();
	public readonly onLocaleChangedObservable = new Observable<string>();

	public constructor(data: ILocalizationData, locale?: string, rootUrl = "") {
		this._data = normalizeLocalizationData(data);
		this._locale = normalizeLocaleId(locale ?? this._data.defaultLocale);
		this._rootUrl = rootUrl;
	}

	public get locale(): string {
		return this._locale;
	}

	public get direction(): "ltr" | "rtl" {
		const locale = this._data.locales.find((candidate) => candidate.id === this._locale);
		return getLocalizationDirection(this._locale, locale?.direction);
	}

	public setLocale(locale: string): void {
		const canonical = normalizeLocaleId(locale);
		if (!this._data.locales.some((candidate) => candidate.id === canonical)) {
			throw new Error(`Localization locale is not configured: ${canonical}`);
		}
		if (canonical === this._locale) {
			return;
		}
		this._locale = canonical;
		this._assetCache.clear();
		this.onLocaleChangedObservable.notifyObservers(canonical);
	}

	/** Replaces authored tables without invalidating live GUI subscribers or their locale selection. */
	public updateData(data: ILocalizationData, rootUrl = this._rootUrl): void {
		const normalized = normalizeLocalizationData(data);
		this._data = normalized;
		this._rootUrl = rootUrl;
		if (!normalized.locales.some((candidate) => candidate.id === this._locale)) {
			this._locale = normalized.defaultLocale;
		}
		this._assetCache.clear();
		this.onLocaleChangedObservable.notifyObservers(this._locale);
	}

	public hasTable(name: string): boolean {
		return this._data.tables.some((table) => table.name === name) || this._data.assetTables.some((table) => table.name === name);
	}

	public getLocales(): ILocalizationLocale[] {
		return structuredClone(this._data.locales);
	}

	public getTables(): ILocalizationTable[] {
		return structuredClone(this._data.tables);
	}

	public getAssetTables(): ILocalizationAssetTable[] {
		return structuredClone(this._data.assetTables);
	}

	private _fallbackChain(locale: string, table: { fallbackLocale: string; fallbackLocales: string[] }): string[] {
		const locales = new Map(this._data.locales.map((candidate) => [candidate.id, candidate]));
		const result: string[] = [];
		const append = (candidate: string): void => {
			if (result.includes(candidate)) {
				return;
			}
			result.push(candidate);
			parentLocales(candidate).forEach((parent) => !result.includes(parent) && result.push(parent));
			locales.get(candidate)?.fallbackLocales.forEach(append);
		};
		append(normalizeLocaleId(locale));
		table.fallbackLocales.forEach(append);
		append(table.fallbackLocale);
		return result;
	}

	public resolve(tableName: string, key: string, locale = this._locale, argumentsValue?: LocalizationSmartValue): string | undefined {
		return this.resolveString(tableName, key, locale, argumentsValue)?.value;
	}

	public resolveString(tableName: string, key: string, locale = this._locale, argumentsValue?: LocalizationSmartValue): ILocalizationResolution<string> | undefined {
		const table = this._data.tables.find((candidate) => candidate.name === tableName);
		const entry = table?.entries[key];
		if (!table || !entry) {
			return undefined;
		}
		const resolvedLocale = this._fallbackChain(locale, table).find((candidate) => entry[candidate] !== undefined);
		if (!resolvedLocale) {
			return undefined;
		}
		const localeDefinition = this._data.locales.find((candidate) => candidate.id === normalizeLocaleId(locale));
		let value = entry[resolvedLocale];
		if (table.smartEntries.includes(key)) {
			value = formatLocalizationString(value, argumentsValue ?? {}, resolvedLocale);
		}
		if (localeDefinition?.pseudo?.enabled) {
			value = pseudoLocalizeString(value, localeDefinition.pseudo);
		}
		return {
			table: tableName,
			key,
			requestedLocale: normalizeLocaleId(locale),
			resolvedLocale,
			direction: getLocalizationDirection(locale, localeDefinition?.direction),
			value,
		};
	}

	public resolveAsset(tableName: string, key: string, locale = this._locale): ILocalizationResolution<ILocalizedAssetReference> | undefined {
		const table = this._data.assetTables.find((candidate) => candidate.name === tableName);
		const entry = table?.entries[key];
		if (!table || !entry) {
			return undefined;
		}
		const resolvedLocale = this._fallbackChain(locale, table).find((candidate) => entry[candidate] !== undefined);
		if (!resolvedLocale) {
			return undefined;
		}
		const localeDefinition = this._data.locales.find((candidate) => candidate.id === normalizeLocaleId(locale));
		return {
			table: tableName,
			key,
			requestedLocale: normalizeLocaleId(locale),
			resolvedLocale,
			direction: getLocalizationDirection(locale, localeDefinition?.direction),
			value: structuredClone(entry[resolvedLocale]),
		};
	}

	public async loadAsset(tableName: string, key: string, locale = this._locale): Promise<ILocalizedAssetLoad> {
		const resolved = this.resolveAsset(tableName, key, locale);
		if (!resolved) {
			throw new Error(`Localized asset was not found: ${tableName}/${key}/${locale}`);
		}
		const cacheKey = `${resolved.resolvedLocale}:${resolved.value.addressableGroup ?? ""}:${resolved.value.address ?? resolved.value.path}`;
		let promise = this._assetCache.get(cacheKey);
		if (!promise) {
			const scene = this._scene;
			promise = (
				resolved.value.addressableGroup && resolved.value.address && scene?.addressables
					? scene.addressables.loadArrayBuffer(resolved.value.addressableGroup, resolved.value.address)
					: fetch(`${this._rootUrl}${resolved.value.path}`).then((response) => {
							if (!response.ok) {
								throw new Error(`Localized asset request failed with HTTP ${response.status}: ${resolved.value.path}`);
							}
							return response.arrayBuffer();
						})
			).catch((error) => {
				this._assetCache.delete(cacheKey);
				throw error;
			});
			this._assetCache.set(cacheKey, promise);
		}
		return { ...resolved, bytes: (await promise).slice(0) };
	}

	private _scene: Scene | null = null;

	public attachScene(scene: Scene): void {
		this._scene = scene;
	}

	public async preload(locale = this._locale): Promise<{ tableCount: number; assetCount: number; byteCount: number }> {
		const entries: Array<{ table: string; key: string }> = [];
		for (const table of this._data.assetTables.filter((candidate) => candidate.preload)) {
			for (const key of Object.keys(table.entries)) {
				entries.push({ table: table.name, key });
			}
		}
		let byteCount = 0;
		// Sequential loading keeps a malicious preload table from creating thousands of simultaneous requests.
		for (const entry of entries) {
			byteCount += (await this.loadAsset(entry.table, entry.key, locale)).bytes.byteLength;
		}
		return { tableCount: this._data.assetTables.filter((table) => table.preload).length, assetCount: entries.length, byteCount };
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		localization?: LocalizationManager;
		addressables?: AddressableCatalog;
	}
}

export function configureLocalization(scene: Scene, rootUrl = ""): void {
	const data = scene.metadata?.babylonEditorLocalization as ILocalizationData | undefined;
	if (data) {
		scene.localization = new LocalizationManager(data, undefined, rootUrl);
		scene.localization.attachScene(scene);
	}
}
