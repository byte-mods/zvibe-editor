import { readFile } from "fs/promises";
import { join } from "path";

import { describe, expect, test } from "vitest";

describe("portable asset Inspector UI hooks", () => {
	test("exposes Alembic direct-instantiation evidence hooks", async () => {
		const source = await readFile(join(import.meta.dirname, "../../src/editor/layout/inspector/file/alembic.tsx"), "utf8");
		for (const hook of ["data-alembic-inspector", "data-alembic-instantiate", "data-alembic-message"]) {
			expect(source).toContain(hook);
		}
	});

	test("exposes Aseprite option and both instantiation paths", async () => {
		const source = await readFile(join(import.meta.dirname, "../../src/editor/layout/inspector/file/aseprite.tsx"), "utf8");
		for (const hook of [
			"data-aseprite-inspector",
			"data-aseprite-animation",
			"data-aseprite-speed",
			"data-aseprite-play-on-awake",
			"data-aseprite-instantiate-composite",
			"data-aseprite-instantiate-layers",
			"data-aseprite-message",
		]) {
			expect(source).toContain(hook);
		}
	});
});
