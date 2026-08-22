import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

describe("macOS development launcher", () => {
	test("keeps Electron's executable name while branding the app bundle", () => {
		const source = readFileSync(new URL("../../scripts/start.mjs", import.meta.url), "utf8");

		// Electron only honors the development app-directory argument when its executable keeps this upstream name.
		expect(source).toContain('const brandedExecutable = join(brandedBundle, "Contents", "MacOS", "Electron")');
		expect(source).toContain('["CFBundleExecutable", "Electron"]');
		expect(source).toContain('["CFBundleDisplayName", "Zvibe Editor"]');
		expect(source).not.toContain("rename(temporaryExecutable, renamedExecutable)");
	});
});
