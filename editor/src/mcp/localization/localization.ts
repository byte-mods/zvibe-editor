import { dirname, join } from "path/posix";
import { pathExists, readJSON, writeJSON } from "fs-extra";
import { Scene } from "babylonjs";
import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
function file(): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	return join(dirname(projectConfiguration.path), "localization.json");
}
async function data(): Promise<any> {
	return (await pathExists(file())) ? readJSON(file()) : { version: 1, tables: [] };
}
async function save(value: any): Promise<void> {
	await writeJSON(file(), value, { spaces: "\t" });
}
function table(value: any, data: any): any {
	const result = value.tables.find((candidate: any) => candidate.name === data.name);
	if (!result) throw new Error(`Localization table "${data.name}" not found.`);
	return result;
}
export async function listLocalizationTables(): Promise<any> {
	return data();
}

function placeholders(value: string): string[] {
	return [...value.matchAll(/\{([^{}]+)\}/g)]
		.map((match) => match[1].trim())
		.filter(Boolean)
		.sort();
}

/** Reports deterministic localization coverage and formatting issues without modifying project tables. */
export async function validateLocalization(_scene: Scene, input: any): Promise<any> {
	const value = await data();
	const tables = input.name ? [table(value, input)] : value.tables;
	const issues: Array<{ table: string; key?: string; locale?: string; code: string; severity: "error" | "warning"; message: string }> = [];
	for (const target of tables) {
		const locales = new Set<string>([target.fallbackLocale]);
		Object.values(target.entries ?? {}).forEach((entry: any) => Object.keys(entry ?? {}).forEach((locale) => locales.add(locale)));
		for (const [key, entry] of Object.entries(target.entries ?? {}) as Array<[string, Record<string, string>]>) {
			const fallback = entry[target.fallbackLocale];
			if (fallback === undefined || !fallback.trim())
				issues.push({
					table: target.name,
					key,
					locale: target.fallbackLocale,
					code: "missingFallback",
					severity: "error",
					message: `Missing non-empty fallback value for locale ${target.fallbackLocale}.`,
				});
			const fallbackPlaceholders = fallback === undefined ? [] : placeholders(fallback);
			for (const locale of locales) {
				const localized = entry[locale];
				if (localized === undefined) {
					if (locale !== target.fallbackLocale)
						issues.push({
							table: target.name,
							key,
							locale,
							code: "missingLocale",
							severity: "warning",
							message: `No ${locale} translation; runtime will use ${target.fallbackLocale}.`,
						});
					continue;
				}
				if (!localized.trim()) issues.push({ table: target.name, key, locale, code: "emptyValue", severity: "warning", message: "Localized value is empty." });
				if (locale !== target.fallbackLocale && localized !== undefined && JSON.stringify(placeholders(localized)) !== JSON.stringify(fallbackPlaceholders))
					issues.push({
						table: target.name,
						key,
						locale,
						code: "placeholderMismatch",
						severity: "error",
						message: `Placeholders do not match fallback locale ${target.fallbackLocale}.`,
					});
			}
		}
	}
	return {
		tables: tables.map((target: any) => target.name),
		issueCount: issues.length,
		errorCount: issues.filter((issue) => issue.severity === "error").length,
		warningCount: issues.filter((issue) => issue.severity === "warning").length,
		issues,
	};
}
export async function createLocalizationTable(_scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const value = await data();
	if (value.tables.some((candidate: any) => candidate.name === input.name)) throw new Error(`Localization table "${input.name}" already exists.`);
	const result = { name: input.name, fallbackLocale: input.fallbackLocale ?? "en", entries: input.entries ?? {} };
	value.tables.push(result);
	await save(value);
	options.editor.layout.assets.refresh();
	return result;
}
export async function setLocalizationEntry(_scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const value = await data(),
		target = table(value, input);
	target.entries[input.key] = { ...(target.entries[input.key] ?? {}), [input.locale]: input.value };
	await save(value);
	options.editor.layout.assets.refresh();
	return { table: target.name, key: input.key, locale: input.locale, value: input.value };
}
/** Deletes one locale value, and removes the entry when it has no remaining localized values. */
export async function deleteLocalizationEntry(_scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const value = await data();
	const target = table(value, input);
	const entry = target.entries[input.key];
	if (!entry || entry[input.locale] === undefined) throw new Error(`Localization entry "${input.key}" for locale "${input.locale}" not found.`);
	delete entry[input.locale];
	if (!Object.keys(entry).length) delete target.entries[input.key];
	await save(value);
	options.editor.layout.assets.refresh();
	return { deleted: true, table: target.name, key: input.key, locale: input.locale };
}
/** Deletes a project localization table. */
export async function deleteLocalizationTable(_scene: Scene, input: any, options: IMCPActionOptions): Promise<any> {
	const value = await data();
	const target = table(value, input);
	value.tables.splice(value.tables.indexOf(target), 1);
	await save(value);
	options.editor.layout.assets.refresh();
	return { deleted: true, name: target.name };
}
export async function resolveLocalizationEntry(_scene: Scene, input: any): Promise<any> {
	const target = table(await data(), input),
		entry = target.entries[input.key];
	if (!entry) throw new Error(`Localization key "${input.key}" not found.`);
	const value = entry[input.locale] ?? entry[target.fallbackLocale];
	if (value === undefined) throw new Error(`No value for locale "${input.locale}" or fallback "${target.fallbackLocale}".`);
	return { table: target.name, key: input.key, locale: input.locale, value, resolvedLocale: entry[input.locale] === undefined ? target.fallbackLocale : input.locale };
}

/** Produces an expanded accented pseudo-locale string for layout and hard-coded-text checks. */
export async function pseudoLocalizeEntry(_scene: Scene, input: any): Promise<any> {
	const resolved = await resolveLocalizationEntry(_scene, input);
	const accents: Record<string, string> = { a: "à", e: "ë", i: "ï", o: "ô", u: "ü", A: "À", E: "Ë", I: "Ï", O: "Ô", U: "Ü" };
	const pseudo = `[${resolved.value.replace(/[aeiouAEIOU]/g, (character: string) => accents[character] ?? character).replace(/ /g, "  ")}]`;
	return { ...resolved, value: pseudo, pseudoLocalized: true };
}
