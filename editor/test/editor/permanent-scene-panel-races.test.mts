import { readFile } from "fs/promises";
import { join } from "path";

import { describe, expect, test } from "vitest";

describe("permanent scene-dependent panel initialization", () => {
	test.each(["profiler.tsx", "entities.tsx", "lighting-search.tsx"])("resynchronizes %s when the Preview scene reference appears or changes", async (file) => {
		const source = await readFile(join(import.meta.dirname, "../../src/editor/layout", file), "utf8");
		expect(source).toContain("_observedScene");
		expect(source).toContain("scene !== this._observedScene");
	});
});
