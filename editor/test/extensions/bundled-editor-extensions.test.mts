import { fileURLToPath } from "url";
import { join } from "path";

import { pathExists, readJSON } from "fs-extra";
import { describe, expect, test } from "vitest";

import { normalizeEditorExtensionManifest } from "../../src/extensions/manifest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("bundled editor extensions", () => {
	for (const fixture of [
		{
			folder: "fab",
			id: "babylon.editor.fab",
			capabilities: ["windows", "menus", "editor"],
			contributions: ["babylon.editor.fab.window", "babylon.editor.fab.open"],
		},
		{
			folder: "quixel",
			id: "babylon.editor.quixel",
			capabilities: ["tests", "editor"],
			contributions: ["babylon.editor.quixel.listener"],
		},
	] as const) {
		test(`${fixture.folder} publishes a strict versioned extension manifest and CommonJS entry`, async () => {
			const packageRoot = join(repositoryRoot, "plugins", fixture.folder);
			const packageJson = await readJSON(join(packageRoot, "package.json"));
			const manifest = normalizeEditorExtensionManifest(packageJson.zvibeEditor);
			expect(manifest).toMatchObject({ apiVersion: 1, id: fixture.id, capabilities: fixture.capabilities });
			expect(Object.values(manifest.contributes).flatMap((entries) => entries.map((entry) => entry.id))).toEqual(fixture.contributions);
			expect(packageJson.main).toBe("build/index.js");
			expect(await pathExists(join(packageRoot, "src", `index.${fixture.folder === "fab" ? "tsx" : "ts"}`))).toBe(true);
		});
	}
});
