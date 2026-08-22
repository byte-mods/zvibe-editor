import { describe, expect, test } from "vitest";

import { basenamePortablePath, dirnamePortablePath, extnamePortablePath, isAbsolutePortablePath, joinPortablePath, normalizePortablePath } from "../../src/assets/portable-path";

describe("portable asset paths", () => {
	test("normalizes separators and dot segments without Node path polyfills", () => {
		expect(normalizePortablePath("assets\\characters/./hero/../hero.glb")).toBe("assets/characters/hero.glb");
		expect(normalizePortablePath("/assets/../../hero.glb")).toBe("/hero.glb");
		expect(joinPortablePath("assets", "characters", "../hero.glb")).toBe("assets/hero.glb");
	});

	test("matches the importer basename, dirname, extension, and absolute-path cases", () => {
		expect(basenamePortablePath("assets/models/hero.glb")).toBe("hero.glb");
		expect(dirnamePortablePath("assets/models/hero.glb")).toBe("assets/models");
		expect(dirnamePortablePath("hero.glb")).toBe(".");
		expect(extnamePortablePath("assets/.hidden")).toBe("");
		expect(extnamePortablePath("assets/hero.model.glb")).toBe(".glb");
		expect(isAbsolutePortablePath("/assets/hero.glb")).toBe(true);
		expect(isAbsolutePortablePath("assets/hero.glb")).toBe(false);
	});
});
