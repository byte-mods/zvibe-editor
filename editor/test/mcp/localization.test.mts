import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import {
	createLocalizationTable,
	deleteLocalizationEntry,
	deleteLocalizationTable,
	listLocalizationTables,
	pseudoLocalizeEntry,
	resolveLocalizationEntry,
	setLocalizationEntry,
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
		expect(await pseudoLocalizeEntry(scene, { name: "UI", key: "play", locale: "en" })).toMatchObject({ value: "[Plày  Gàmë]", pseudoLocalized: true });
		expect((await listLocalizationTables()).tables).toMatchObject([{ name: "UI", entries: { play: { en: "Play Game", fr: "Jouer" } } }]);
		expect(await deleteLocalizationEntry(scene, { name: "UI", key: "play", locale: "fr" }, options)).toMatchObject({ deleted: true, key: "play", locale: "fr" });
		expect((await listLocalizationTables()).tables[0].entries.play).toEqual({ en: "Play Game" });
		expect(await deleteLocalizationTable(scene, { name: "UI" }, options)).toEqual({ deleted: true, name: "UI" });
		expect((await listLocalizationTables()).tables).toEqual([]);
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
