import { mkdtemp, readFile, remove } from "fs-extra";
import { join } from "path/posix";
import { tmpdir } from "os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { processExportedFont } from "../src/pack/assets/font.mjs";

describe("CLI font source fallback", () => {
	let directory: string;
	const source = join(process.cwd(), "../editor/test/fixtures/fonts/Amiri-Regular.ttf");

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-cli-font-source-"));
	});

	afterEach(async () => {
		await remove(directory);
	});

	test("retains a byte-identical browser-loadable source beside SDF atlas output", async () => {
		const output = join(directory, "game.ttf");
		const result = await processExportedFont(source, output, {
			renderMode: "sdf",
			characterSet: "custom",
			customCharacters: "GUI 123",
			fontSize: 32,
			padding: 3,
			distanceRange: 4,
		});
		expect(result).toMatchObject({ renderMode: "sdf", dynamicFontPath: null, sourceFontPath: output, glyphCount: expect.any(Number) });
		expect(await readFile(result.sourceFontPath!)).toEqual(await readFile(source));
		expect(JSON.parse(await readFile(result.manifestPath, "utf-8"))).toMatchObject({ renderMode: "sdf", sourceFontPath: "game.ttf" });
	});
});
