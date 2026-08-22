import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identifier = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[^\0\r\n]+$/);
const key = z
	.string()
	.trim()
	.min(1)
	.max(128)
	.regex(/^[^\0\r\n]+$/);
const locale = z
	.string()
	.min(2)
	.max(64)
	.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
const exactRevision = z.number().int().min(0).safe().describe("Exact localization revision returned by list_localization_tables.");
const exactFingerprint = z
	.string()
	.length(16)
	.regex(/^[a-f0-9]{16}$/)
	.describe("Exact localization fingerprint returned by list_localization_tables.");
const authoringLease = { expectedRevision: exactRevision, expectedFingerprint: exactFingerprint };
const fallbackLocales = z
	.array(locale)
	.max(16)
	.refine((values) => new Set(values).size === values.length, "Fallback locales must be unique.");
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const replaceAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const networkReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

type JsonValue = null | boolean | number | string | JsonValue[] | { [name: string]: JsonValue };
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(32_768), z.array(jsonValue).max(64), z.record(z.string().min(1).max(128), jsonValue)])
);
const smartArguments = z.record(z.string().min(1).max(128), jsonValue).refine((value) => Object.keys(value).length <= 64, "Smart arguments support at most 64 fields.");
const pseudo = z
	.object({
		enabled: z.boolean().default(true),
		expansionPercent: z.number().min(0).max(200).default(30),
		accent: z.boolean().default(true),
		wrap: z.boolean().default(true),
		mirror: z.boolean().default(false),
	})
	.strict();
const localeDefinition = z.object({ id: locale, name: identifier, direction: z.enum(["auto", "ltr", "rtl"]), fallbackLocales, pseudo: pseudo.nullable() }).strict();
const assetPath = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part && part !== ".."), "Use a normalized project-relative path.");
const assetReference = z
	.object({
		path: assetPath,
		type: z.enum(["audio", "binary", "font", "model", "texture", "video"]),
		addressableGroup: identifier.optional(),
		address: z.string().min(1).max(512).optional(),
	})
	.strict()
	.refine((value) => (value.addressableGroup === undefined) === (value.address === undefined), "Addressable assets require both addressableGroup and address.");

// eslint-disable-next-line max-params -- Mirrors the SDK registration fields and keeps all localization declarations uniform.
function register(server: McpServer, name: string, title: string, description: string, inputSchema: z.ZodTypeAny, annotations: typeof readAnnotations, endpoint = name): void {
	server.registerTool(name, { title, description, inputSchema, annotations }, async (args): Promise<CallToolResult> => callTextTool(endpoint, args));
}

export function registerLocalizationTools(server: McpServer): void {
	register(
		server,
		"list_localization_tables",
		"Inspect localization",
		"Read the normalized version-2 localization document, exact revision/fingerprint, locales, Smart String tables, fallback policy, pseudo-locales, and localized asset tables.",
		z.object({}).strict(),
		readAnnotations
	);
	register(
		server,
		"set_localization_settings",
		"Set localization settings",
		"Set the project default locale under an exact revision and fingerprint lease.",
		z.object({ ...authoringLease, defaultLocale: locale }).strict(),
		replaceAnnotations
	);
	register(
		server,
		"upsert_localization_locale",
		"Upsert localization locale",
		"Create or replace a locale definition including direction, ordered fallbacks, and optional pseudo-locale policy.",
		z.object({ ...authoringLease, locale: localeDefinition }).strict(),
		replaceAnnotations
	);
	register(
		server,
		"delete_localization_locale",
		"Delete localization locale",
		"Delete an unreferenced non-default locale. Referenced locales are rejected and confirm must be true.",
		z.object({ ...authoringLease, locale, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"create_localization_table",
		"Create string table",
		"Create an empty localized string table with deterministic locale fallback and preload policy.",
		z.object({ ...authoringLease, name: identifier, fallbackLocale: locale, fallbackLocales: fallbackLocales.default([]), preload: z.boolean().default(false) }).strict(),
		writeAnnotations
	);
	register(
		server,
		"set_localization_table_settings",
		"Set string table settings",
		"Set fallback locale order and preload policy for one string table under an exact lease.",
		z.object({ ...authoringLease, name: identifier, fallbackLocale: locale.optional(), fallbackLocales: fallbackLocales.optional(), preload: z.boolean().optional() }).strict(),
		replaceAnnotations
	);
	register(
		server,
		"delete_localization_table",
		"Delete string table",
		"Delete one string table and all localized values. Requires exact lease and confirm true.",
		z.object({ ...authoringLease, name: identifier, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"set_localization_entry",
		"Set localized string",
		"Set one locale value and optionally enable or disable Smart String formatting for its key.",
		z.object({ ...authoringLease, name: identifier, key, locale, value: z.string().max(32_768), smart: z.boolean().optional() }).strict(),
		replaceAnnotations
	);
	register(
		server,
		"delete_localization_entry",
		"Delete localized string",
		"Delete one locale value and remove an empty key. Requires exact lease and confirm true.",
		z.object({ ...authoringLease, name: identifier, key, locale, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"resolve_localization_entry",
		"Resolve localized string",
		"Resolve locale, regional/table/locale fallback order, Smart String arguments, direction, and pseudo-localization without mutation.",
		z.object({ name: identifier, key, locale, arguments: smartArguments.default({}) }).strict(),
		readAnnotations
	);
	register(
		server,
		"pseudo_localize_entry",
		"Preview pseudo-localization",
		"Resolve an entry then preview bounded expansion, accents, wrapping, and optional bidi mirroring.",
		z
			.object({
				name: identifier,
				key,
				locale,
				arguments: smartArguments.default({}),
				expansionPercent: z.number().min(0).max(200).default(30),
				accent: z.boolean().default(true),
				wrap: z.boolean().default(true),
				mirror: z.boolean().default(false),
			})
			.strict(),
		readAnnotations
	);
	register(
		server,
		"create_localized_asset_table",
		"Create localized asset table",
		"Create an empty localized asset table for textures, audio, fonts, video, models, or binary data.",
		z.object({ ...authoringLease, name: identifier, fallbackLocale: locale, fallbackLocales: fallbackLocales.default([]), preload: z.boolean().default(false) }).strict(),
		writeAnnotations
	);
	register(
		server,
		"set_localized_asset_table_settings",
		"Set localized asset table settings",
		"Set fallback locale order and preload behavior for one localized asset table.",
		z.object({ ...authoringLease, name: identifier, fallbackLocale: locale.optional(), fallbackLocales: fallbackLocales.optional(), preload: z.boolean().optional() }).strict(),
		replaceAnnotations
	);
	register(
		server,
		"delete_localized_asset_table",
		"Delete localized asset table",
		"Delete one localized asset table and every locale reference. Requires exact lease and confirm true.",
		z.object({ ...authoringLease, name: identifier, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"set_localized_asset_entry",
		"Set localized asset",
		"Set one localized project-relative or Addressable-backed asset reference under an exact lease.",
		z.object({ ...authoringLease, name: identifier, key, locale, asset: assetReference }).strict(),
		replaceAnnotations
	);
	register(
		server,
		"delete_localized_asset_entry",
		"Delete localized asset",
		"Delete one locale asset reference and remove an empty key. Requires exact lease and confirm true.",
		z.object({ ...authoringLease, name: identifier, key, locale, confirm: z.literal(true) }).strict(),
		destructiveAnnotations
	);
	register(
		server,
		"resolve_localized_asset",
		"Resolve localized asset",
		"Resolve an asset reference, fallback locale, direction, project path, and local existence without loading bytes.",
		z.object({ name: identifier, key, locale }).strict(),
		readAnnotations
	);
	register(
		server,
		"preload_localized_assets",
		"Verify localized asset preload",
		"Load every asset in preload-enabled tables for one locale and report deterministic byte evidence. Addressable sources may perform network reads.",
		z.object({ locale: locale.optional() }).strict(),
		networkReadAnnotations
	);
	register(
		server,
		"validate_localization",
		"Validate localization",
		"Audit fallback coverage, missing/empty strings, placeholders, Smart String formatting, asset coverage, and missing local asset files.",
		z.object({ name: identifier.optional(), assetTableName: identifier.optional(), sampleArguments: smartArguments.default({}) }).strict(),
		readAnnotations
	);
}
