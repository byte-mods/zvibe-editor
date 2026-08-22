import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { randomUUID } from "crypto";
import { move, pathExists, readFile, readJSON, remove, stat, writeJSON } from "fs-extra";

import { Scene } from "babylonjs";
import {
	formatLocalizationString,
	getLocalizationFingerprint,
	ILocalizationAssetTable,
	ILocalizationData,
	ILocalizationLocale,
	ILocalizationTable,
	ILocalizedAssetReference,
	LocalizationManager,
	normalizeLocaleId,
	normalizeLocalizationData,
	pseudoLocalizeString,
	validateLocalizationStringTemplate,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl, projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";

interface ILocalizationMutationLease {
	expectedRevision?: number;
	expectedFingerprint?: string;
}

interface ILocalizationIssue {
	table?: string;
	key?: string;
	locale?: string;
	path?: string;
	code: string;
	severity: "error" | "warning";
	message: string;
}

let localizationMutationQueue: Promise<void> = Promise.resolve();

async function withLocalizationMutationLock<T>(action: () => Promise<T>): Promise<T> {
	const previous = localizationMutationQueue;
	let release!: () => void;
	localizationMutationQueue = new Promise<void>((resolve) => (release = resolve));
	await previous;
	try {
		return await action();
	} finally {
		release();
	}
}

function localizationFile(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return join(dirname(projectConfiguration.path), "localization.json");
}

function projectDirectory(): string {
	return dirname(localizationFile());
}

function resolveProjectPath(path: string): string {
	const root = projectDirectory();
	const absolute = normalize(isAbsolute(path) ? path : join(root, path));
	if (absolute !== root && !absolute.startsWith(`${root}/`)) {
		throw new Error("Localized asset paths must stay inside the open project directory.");
	}
	return absolute;
}

function synchronizeScene(scene: Scene | undefined, value: ILocalizationData): LocalizationManager | undefined {
	if (!scene) {
		return undefined;
	}
	const localizationScene = scene as Scene & { localization?: LocalizationManager };
	scene.metadata = { ...(scene.metadata ?? {}), babylonEditorLocalization: structuredClone(value) };
	if (localizationScene.localization) {
		localizationScene.localization.updateData(value, getProjectAssetsRootUrl() ?? "");
		localizationScene.localization.attachScene(scene as any);
		return localizationScene.localization;
	}
	const locale = value.defaultLocale;
	const manager = new LocalizationManager(value, locale, getProjectAssetsRootUrl() ?? "");
	manager.attachScene(scene as any);
	localizationScene.localization = manager;
	return manager;
}

async function readLocalizationData(scene?: Scene): Promise<ILocalizationData> {
	const path = localizationFile();
	const value = normalizeLocalizationData((await pathExists(path)) ? await readJSON(path) : undefined);
	synchronizeScene(scene, value);
	return value;
}

function assertLease(value: ILocalizationData, lease: ILocalizationMutationLease): void {
	const fingerprint = getLocalizationFingerprint(value);
	if (lease.expectedRevision !== undefined && lease.expectedRevision !== value.revision) {
		throw new Error(`Localization revision changed. Inspect again and use expectedRevision ${value.revision}.`);
	}
	if (lease.expectedFingerprint !== undefined && lease.expectedFingerprint !== fingerprint) {
		throw new Error(`Localization content changed. Inspect again and use expectedFingerprint ${fingerprint}.`);
	}
}

async function writeLocalizationData(scene: Scene, current: ILocalizationData, nextValue: unknown, options: IMCPActionOptions): Promise<ILocalizationData> {
	const next = normalizeLocalizationData({ ...(nextValue as Record<string, unknown>), revision: current.revision + 1 });
	const path = localizationFile();
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeJSON(temporary, next, { spaces: "\t" });
		await move(temporary, path, { overwrite: true });
	} finally {
		await remove(temporary).catch(() => undefined);
	}
	synchronizeScene(scene, next);
	options.editor.layout.assets.refresh();
	return next;
}

async function mutateLocalization(
	scene: Scene,
	input: ILocalizationMutationLease,
	options: IMCPActionOptions,
	mutation: (draft: ILocalizationData) => void
): Promise<{ data: ILocalizationData; fingerprint: string }> {
	return withLocalizationMutationLock(async () => {
		const current = await readLocalizationData(scene);
		assertLease(current, input);
		const draft = structuredClone(current);
		mutation(draft);
		const data = await writeLocalizationData(scene, current, draft, options);
		return { data, fingerprint: getLocalizationFingerprint(data) };
	});
}

function stringTable(value: ILocalizationData, name: string): ILocalizationTable {
	const result = value.tables.find((candidate) => candidate.name === name);
	if (!result) {
		throw new Error(`Localization string table "${name}" not found.`);
	}
	return result;
}

function assetTable(value: ILocalizationData, name: string): ILocalizationAssetTable {
	const result = value.assetTables.find((candidate) => candidate.name === name);
	if (!result) {
		throw new Error(`Localization asset table "${name}" not found.`);
	}
	return result;
}

function result(value: ILocalizationData): ILocalizationData & { fingerprint: string } {
	return { ...structuredClone(value), fingerprint: getLocalizationFingerprint(value) };
}

/** Reads, migrates, validates, and attaches the project localization document to an editor scene. */
export async function configureEditorLocalization(scene: Scene): Promise<LocalizationManager> {
	const value = await readLocalizationData(scene);
	return (scene as Scene & { localization?: LocalizationManager }).localization ?? synchronizeScene(scene, value)!;
}

export async function listLocalizationTables(scene?: Scene): Promise<any> {
	return result(await readLocalizationData(scene));
}

export async function setLocalizationSettings(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		if (input.defaultLocale !== undefined) {
			draft.defaultLocale = normalizeLocaleId(input.defaultLocale);
		}
	});
	return result(saved.data);
}

export async function upsertLocalizationLocale(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const id = normalizeLocaleId(input.locale.id);
		const index = draft.locales.findIndex((candidate) => candidate.id === id);
		const locale = {
			...(index < 0 ? { id, name: id, direction: "auto", fallbackLocales: [], pseudo: null } : draft.locales[index]),
			...input.locale,
			id,
		} as ILocalizationLocale;
		if (index < 0) {
			draft.locales.push(locale);
		} else {
			draft.locales[index] = locale;
		}
	});
	return { locale: saved.data.locales.find((candidate) => candidate.id === normalizeLocaleId(input.locale.id)), revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function deleteLocalizationLocale(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	if (input.confirm !== true) {
		throw new Error("Deleting a localization locale requires confirm: true.");
	}
	const id = normalizeLocaleId(input.locale);
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		if (draft.defaultLocale === id) {
			throw new Error("The default locale cannot be deleted. Choose another default locale first.");
		}
		if (!draft.locales.some((candidate) => candidate.id === id)) {
			throw new Error(`Localization locale "${id}" not found.`);
		}
		const blockers: string[] = [];
		draft.locales.forEach((locale) => locale.fallbackLocales.includes(id) && blockers.push(`locale ${locale.id} fallback`));
		draft.tables.forEach((table) => {
			if (table.fallbackLocale === id || table.fallbackLocales.includes(id)) {
				blockers.push(`string table ${table.name} fallback`);
			}
			if (Object.values(table.entries).some((entry) => entry[id] !== undefined)) {
				blockers.push(`string table ${table.name} entries`);
			}
		});
		draft.assetTables.forEach((table) => {
			if (table.fallbackLocale === id || table.fallbackLocales.includes(id)) {
				blockers.push(`asset table ${table.name} fallback`);
			}
			if (Object.values(table.entries).some((entry) => entry[id] !== undefined)) {
				blockers.push(`asset table ${table.name} entries`);
			}
		});
		if (blockers.length) {
			throw new Error(`Locale "${id}" is still referenced by: ${blockers.join(", ")}.`);
		}
		draft.locales = draft.locales.filter((candidate) => candidate.id !== id);
	});
	return { deleted: true, locale: id, revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function createLocalizationTable(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		if (draft.tables.some((candidate) => candidate.name === input.name) || draft.assetTables.some((candidate) => candidate.name === input.name)) {
			throw new Error(`Localization table "${input.name}" already exists.`);
		}
		draft.tables.push({
			name: input.name,
			fallbackLocale: input.fallbackLocale ?? draft.defaultLocale,
			fallbackLocales: input.fallbackLocales ?? [],
			preload: input.preload === true,
			smartEntries: [],
			entries: input.entries ?? {},
		});
	});
	return { table: stringTable(saved.data, input.name), revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function setLocalizationTableSettings(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = stringTable(draft, input.name);
		if (input.fallbackLocale !== undefined) {
			target.fallbackLocale = input.fallbackLocale;
		}
		if (input.fallbackLocales !== undefined) {
			target.fallbackLocales = input.fallbackLocales;
		}
		if (input.preload !== undefined) {
			target.preload = input.preload;
		}
	});
	return { table: stringTable(saved.data, input.name), revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function setLocalizationEntry(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = stringTable(draft, input.name);
		const locale = normalizeLocaleId(input.locale);
		target.entries[input.key] = { ...(target.entries[input.key] ?? {}), [locale]: input.value };
		const smartEntries = new Set(target.smartEntries);
		if (input.smart === true) {
			smartEntries.add(input.key);
		}
		if (input.smart === false) {
			smartEntries.delete(input.key);
		}
		target.smartEntries = [...smartEntries];
	});
	const target = stringTable(saved.data, input.name);
	return {
		table: target.name,
		key: input.key,
		locale: normalizeLocaleId(input.locale),
		value: input.value,
		smart: target.smartEntries.includes(input.key),
		revision: saved.data.revision,
		fingerprint: saved.fingerprint,
	};
}

export async function deleteLocalizationEntry(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const locale = normalizeLocaleId(input.locale);
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = stringTable(draft, input.name);
		const entry = target.entries[input.key];
		if (!entry || entry[locale] === undefined) {
			throw new Error(`Localization entry "${input.key}" for locale "${locale}" not found.`);
		}
		delete entry[locale];
		if (!Object.keys(entry).length) {
			delete target.entries[input.key];
			target.smartEntries = target.smartEntries.filter((key) => key !== input.key);
		}
	});
	return { deleted: true, table: input.name, key: input.key, locale, revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function deleteLocalizationTable(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	if (input.confirm !== undefined && input.confirm !== true) {
		throw new Error("Deleting a localization table requires confirm: true.");
	}
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = stringTable(draft, input.name);
		draft.tables.splice(draft.tables.indexOf(target), 1);
	});
	return { deleted: true, name: input.name, revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function createLocalizedAssetTable(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		if (draft.tables.some((candidate) => candidate.name === input.name) || draft.assetTables.some((candidate) => candidate.name === input.name)) {
			throw new Error(`Localization table "${input.name}" already exists.`);
		}
		draft.assetTables.push({
			name: input.name,
			fallbackLocale: input.fallbackLocale ?? draft.defaultLocale,
			fallbackLocales: input.fallbackLocales ?? [],
			preload: input.preload === true,
			entries: input.entries ?? {},
		});
	});
	return { table: assetTable(saved.data, input.name), revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function setLocalizedAssetTableSettings(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = assetTable(draft, input.name);
		if (input.fallbackLocale !== undefined) {
			target.fallbackLocale = input.fallbackLocale;
		}
		if (input.fallbackLocales !== undefined) {
			target.fallbackLocales = input.fallbackLocales;
		}
		if (input.preload !== undefined) {
			target.preload = input.preload;
		}
	});
	return { table: assetTable(saved.data, input.name), revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function setLocalizedAssetEntry(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = assetTable(draft, input.name);
		const locale = normalizeLocaleId(input.locale);
		target.entries[input.key] = { ...(target.entries[input.key] ?? {}), [locale]: input.asset as ILocalizedAssetReference };
	});
	return { table: input.name, key: input.key, locale: normalizeLocaleId(input.locale), asset: input.asset, revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function deleteLocalizedAssetEntry(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const locale = normalizeLocaleId(input.locale);
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = assetTable(draft, input.name);
		const entry = target.entries[input.key];
		if (!entry || entry[locale] === undefined) {
			throw new Error(`Localized asset entry "${input.key}" for locale "${locale}" not found.`);
		}
		delete entry[locale];
		if (!Object.keys(entry).length) {
			delete target.entries[input.key];
		}
	});
	return { deleted: true, table: input.name, key: input.key, locale, revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function deleteLocalizedAssetTable(scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	if (input.confirm !== true) {
		throw new Error("Deleting a localized asset table requires confirm: true.");
	}
	const saved = await mutateLocalization(scene, input, options, (draft) => {
		const target = assetTable(draft, input.name);
		draft.assetTables.splice(draft.assetTables.indexOf(target), 1);
	});
	return { deleted: true, name: input.name, revision: saved.data.revision, fingerprint: saved.fingerprint };
}

export async function resolveLocalizationEntry(scene: Scene, input: any): Promise<any> {
	const manager = await configureEditorLocalization(scene);
	const resolved = manager.resolveString(input.name, input.key, input.locale, input.arguments ?? {});
	if (!resolved) {
		throw new Error(`Localized string was not found: ${input.name}/${input.key}/${input.locale}`);
	}
	return resolved;
}

export async function pseudoLocalizeEntry(scene: Scene, input: any): Promise<any> {
	const resolved = await resolveLocalizationEntry(scene, input);
	const settings = { enabled: true, expansionPercent: input.expansionPercent ?? 30, accent: input.accent !== false, wrap: input.wrap !== false, mirror: input.mirror === true };
	return { ...resolved, value: pseudoLocalizeString(resolved.value, settings), pseudoLocalized: true, settings };
}

export async function resolveLocalizedAsset(scene: Scene, input: any): Promise<any> {
	const manager = await configureEditorLocalization(scene);
	const resolved = manager.resolveAsset(input.name, input.key, input.locale);
	if (!resolved) {
		throw new Error(`Localized asset was not found: ${input.name}/${input.key}/${input.locale}`);
	}
	const absolutePath = resolveProjectPath(resolved.value.path);
	return { ...resolved, projectPath: relative(projectDirectory(), absolutePath), exists: await pathExists(absolutePath) };
}

export async function preloadLocalizedAssets(scene: Scene, input: any): Promise<any> {
	const data = await readLocalizationData(scene);
	const localizationScene = scene as Scene & { localization?: LocalizationManager; addressables?: unknown };
	const manager = localizationScene.localization!;
	const locale = normalizeLocaleId(input.locale ?? data.defaultLocale);
	const assets: Array<{ table: string; key: string; path: string; byteCount: number }> = [];
	const maximumAssetBytes = 256 * 1024 * 1024;
	const maximumTotalBytes = 512 * 1024 * 1024;
	let totalBytes = 0;
	for (const table of data.assetTables.filter((candidate) => candidate.preload)) {
		for (const key of Object.keys(table.entries)) {
			const resolved = manager.resolveAsset(table.name, key, locale);
			if (!resolved) {
				throw new Error(`Preload asset was not found: ${table.name}/${key}/${locale}`);
			}
			let byteCount: number;
			if (resolved.value.addressableGroup && resolved.value.address && localizationScene.addressables) {
				byteCount = (await manager.loadAsset(table.name, key, locale)).bytes.byteLength;
			} else {
				const absolutePath = resolveProjectPath(resolved.value.path);
				const source = await stat(absolutePath);
				if (!source.isFile() || source.size > maximumAssetBytes) {
					throw new Error(`Localized preload asset must be a regular file no larger than ${maximumAssetBytes} bytes: ${resolved.value.path}`);
				}
				byteCount = (await readFile(absolutePath)).byteLength;
			}
			if (byteCount > maximumAssetBytes || totalBytes + byteCount > maximumTotalBytes) {
				throw new Error("Localized asset preload exceeds the bounded per-asset or total byte limit.");
			}
			totalBytes += byteCount;
			assets.push({ table: table.name, key, path: resolved.value.path, byteCount });
		}
	}
	return {
		locale,
		tableCount: data.assetTables.filter((table) => table.preload).length,
		assetCount: assets.length,
		byteCount: totalBytes,
		assets,
	};
}

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{([^{}:]+)(?::[^{}]*)?\}/g)]
		.map((match) => match[1].trim())
		.filter(Boolean)
		.sort();
}

/** Reports locale coverage, Smart String, fallback, localized-asset, and visual-binding readiness issues without mutation. */
export async function validateLocalization(scene: Scene, input: any): Promise<any> {
	const value = await readLocalizationData(scene);
	const tables = input.name ? [stringTable(value, input.name)] : value.tables;
	const assetTables = input.assetTableName ? [assetTable(value, input.assetTableName)] : value.assetTables;
	const locales = value.locales.map((locale) => locale.id);
	const issues: ILocalizationIssue[] = [];
	for (const target of tables) {
		for (const [key, entry] of Object.entries(target.entries)) {
			const fallback = entry[target.fallbackLocale];
			if (fallback === undefined || !fallback.trim()) {
				issues.push({
					table: target.name,
					key,
					locale: target.fallbackLocale,
					code: "missingFallback",
					severity: "error",
					message: `Missing non-empty fallback value for locale ${target.fallbackLocale}.`,
				});
			}
			const fallbackPlaceholders = fallback === undefined ? [] : placeholders(fallback);
			for (const locale of locales) {
				const localized = entry[locale];
				if (localized === undefined) {
					if (locale !== target.fallbackLocale) {
						issues.push({
							table: target.name,
							key,
							locale,
							code: "missingLocale",
							severity: "warning",
							message: `No ${locale} translation; runtime fallback resolution will be used.`,
						});
					}
					continue;
				}
				if (!localized.trim()) {
					issues.push({ table: target.name, key, locale, code: "emptyValue", severity: "warning", message: "Localized value is empty." });
				}
				if (!target.smartEntries.includes(key) && locale !== target.fallbackLocale && JSON.stringify(placeholders(localized)) !== JSON.stringify(fallbackPlaceholders)) {
					issues.push({
						table: target.name,
						key,
						locale,
						code: "placeholderMismatch",
						severity: "error",
						message: `Placeholders do not match fallback locale ${target.fallbackLocale}.`,
					});
				}
				if (target.smartEntries.includes(key)) {
					try {
						validateLocalizationStringTemplate(localized);
						if (Object.keys(input.sampleArguments ?? {}).length) {
							formatLocalizationString(localized, input.sampleArguments, locale);
						}
					} catch (error) {
						issues.push({
							table: target.name,
							key,
							locale,
							code: "invalidSmartString",
							severity: "error",
							message: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
		}
	}
	for (const target of assetTables) {
		for (const [key, entry] of Object.entries(target.entries)) {
			if (!entry[target.fallbackLocale]) {
				issues.push({
					table: target.name,
					key,
					locale: target.fallbackLocale,
					code: "missingAssetFallback",
					severity: "error",
					message: `Missing fallback asset for locale ${target.fallbackLocale}.`,
				});
			}
			for (const locale of locales) {
				const asset = entry[locale];
				if (!asset) {
					if (locale !== target.fallbackLocale) {
						issues.push({
							table: target.name,
							key,
							locale,
							code: "missingAssetLocale",
							severity: "warning",
							message: `No ${locale} asset; runtime fallback resolution will be used.`,
						});
					}
					continue;
				}
				if (!asset.addressableGroup && !(await pathExists(resolveProjectPath(asset.path)))) {
					issues.push({
						table: target.name,
						key,
						locale,
						path: asset.path,
						code: "missingAssetFile",
						severity: "error",
						message: `Localized asset file does not exist: ${asset.path}`,
					});
				}
			}
		}
	}
	return {
		revision: value.revision,
		fingerprint: getLocalizationFingerprint(value),
		tables: tables.map((target) => target.name),
		assetTables: assetTables.map((target) => target.name),
		issueCount: issues.length,
		errorCount: issues.filter((issue) => issue.severity === "error").length,
		warningCount: issues.filter((issue) => issue.severity === "warning").length,
		issues,
	};
}
