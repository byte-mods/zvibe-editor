import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdir, mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import {
	createLocalizedAssetTable,
	createLocalizationTable,
	preloadLocalizedAssets,
	deleteLocalizationEntry,
	deleteLocalizationTable,
	listLocalizationTables,
	pseudoLocalizeEntry,
	resolveLocalizedAsset,
	resolveLocalizationEntry,
	setLocalizedAssetEntry,
	setLocalizationEntry,
	upsertLocalizationLocale,
	validateLocalization,
} from "../../src/mcp/localization/localization";

describe("mcp/localization", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-localization-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("persists editor-authored localized entries and resolves pseudo previews", async () => {
		await createLocalizationTable(scene, { name: "UI", fallbackLocale: "en" }, options);
		await setLocalizationEntry(scene, { name: "UI", key: "play", locale: "en", value: "Play Game" }, options);
		await setLocalizationEntry(scene, { name: "UI", key: "play", locale: "fr", value: "Jouer" }, options);
		expect(await resolveLocalizationEntry(scene, { name: "UI", key: "play", locale: "de" })).toMatchObject({ value: "Play Game", resolvedLocale: "en" });
		expect(await pseudoLocalizeEntry(scene, { name: "UI", key: "play", locale: "en" })).toMatchObject({ value: "[Plày Gàmë~~~]", pseudoLocalized: true });
		expect((await listLocalizationTables()).tables).toMatchObject([{ name: "UI", entries: { play: { en: "Play Game", fr: "Jouer" } } }]);
		expect(await deleteLocalizationEntry(scene, { name: "UI", key: "play", locale: "fr" }, options)).toMatchObject({ deleted: true, key: "play", locale: "fr" });
		expect((await listLocalizationTables()).tables[0].entries.play).toEqual({ en: "Play Game" });
		expect(await deleteLocalizationTable(scene, { name: "UI" }, options)).toMatchObject({ deleted: true, name: "UI" });
		expect((await listLocalizationTables()).tables).toEqual([]);
	});

	test("leases locale policy, Smart Strings, localized assets, and preload evidence", async () => {
		const lease = async () => {
			const inspected = await listLocalizationTables(scene);
			return { expectedRevision: inspected.revision, expectedFingerprint: inspected.fingerprint };
		};
		await upsertLocalizationLocale(scene, { ...(await lease()), locale: { id: "fr", name: "French", direction: "ltr", fallbackLocales: ["en"], pseudo: null } }, options);
		await createLocalizationTable(scene, { ...(await lease()), name: "HUD", fallbackLocale: "en" }, options);
		await setLocalizationEntry(scene, { ...(await lease()), name: "HUD", key: "items", locale: "en", value: "{count:plural:one item|# items}", smart: true }, options);
		expect(await resolveLocalizationEntry(scene, { name: "HUD", key: "items", locale: "fr", arguments: { count: 2 } })).toMatchObject({
			value: "2 items",
			resolvedLocale: "en",
			direction: "ltr",
		});

		await mkdir(join(directory, "assets"));
		await writeFile(join(directory, "assets/logo.png"), Buffer.from([1, 2, 3, 4]));
		await createLocalizedAssetTable(scene, { ...(await lease()), name: "Images", fallbackLocale: "en", preload: true }, options);
		await setLocalizedAssetEntry(scene, { ...(await lease()), name: "Images", key: "logo", locale: "en", asset: { path: "assets/logo.png", type: "texture" } }, options);
		expect(await resolveLocalizedAsset(scene, { name: "Images", key: "logo", locale: "fr" })).toMatchObject({ resolvedLocale: "en", exists: true, value: { type: "texture" } });
		expect(await preloadLocalizedAssets(scene, { locale: "fr" })).toMatchObject({ tableCount: 1, assetCount: 1, byteCount: 4 });

		const stale = await lease();
		await setLocalizationEntry(scene, { ...stale, name: "HUD", key: "ready", locale: "en", value: "Ready" }, options);
		await expect(setLocalizationEntry(scene, { ...stale, name: "HUD", key: "stale", locale: "en", value: "No" }, options)).rejects.toThrow(/revision changed/);
		const concurrentLease = await lease();
		const concurrent = await Promise.allSettled([
			setLocalizationEntry(scene, { ...concurrentLease, name: "HUD", key: "first", locale: "en", value: "First" }, options),
			setLocalizationEntry(scene, { ...concurrentLease, name: "HUD", key: "second", locale: "en", value: "Second" }, options),
		]);
		expect(concurrent.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
		expect(concurrent.filter((entry) => entry.status === "rejected")).toHaveLength(1);
	});

	test("reports fallback, coverage, empty-value, and placeholder validation issues without changing strings", async () => {
		await createLocalizationTable(scene, { name: "UI", fallbackLocale: "en" }, options);
		await setLocalizationEntry(scene, { name: "UI", key: "welcome", locale: "en", value: "Welcome {player}" }, options);
		await setLocalizationEntry(scene, { name: "UI", key: "welcome", locale: "fr", value: "Bienvenue {joueur}" }, options);
		await setLocalizationEntry(scene, { name: "UI", key: "missing", locale: "fr", value: "" }, options);

		const result = await validateLocalization(scene, { name: "UI" });
		expect(result).toMatchObject({ tables: ["UI"], errorCount: 2, warningCount: 1 });
		expect(result.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "welcome", locale: "fr", code: "placeholderMismatch", severity: "error" }),
				expect.objectContaining({ key: "missing", locale: "en", code: "missingFallback", severity: "error" }),
				expect.objectContaining({ key: "missing", locale: "fr", code: "emptyValue", severity: "warning" }),
			])
		);
		expect(await resolveLocalizationEntry(scene, { name: "UI", key: "welcome", locale: "en" })).toMatchObject({ value: "Welcome {player}" });
	});
});
