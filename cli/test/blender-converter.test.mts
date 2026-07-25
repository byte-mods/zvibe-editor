import { chmod, mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { convertBlendFileToGlb } from "../src/blender/converter.mjs";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => remove(directory)));
});

describe("Blender CLI conversion", () => {
	test("uses exact argv without a shell and validates the generated GLB", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-blender-test-"));
		directories.push(directory);
		const sourcePath = join(directory, "source file.blend");
		const executable = join(directory, "fake blender");
		await writeFile(sourcePath, "BLENDER-v300");
		await writeFile(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
const output = process.argv[process.argv.length - 1];
const glb = Buffer.alloc(20);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
fs.writeFileSync(output, glb);
process.stdout.write("converted");
`,
			"utf-8"
		);
		await chmod(executable, 0o755);

		const result = await convertBlendFileToGlb(sourcePath, { executable, timeoutMs: 5_000 });
		expect(result).toMatchObject({ executable, outputBytes: 20, stdout: "converted" });
		expect(Buffer.from(result.content).readUInt32LE(0)).toBe(0x46546c67);
	});

	test("rejects unsafe timeout bounds before launching Blender", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-blender-test-"));
		directories.push(directory);
		const sourcePath = join(directory, "source.blend");
		await writeFile(sourcePath, "BLENDER-v300");
		await expect(convertBlendFileToGlb(sourcePath, { timeoutMs: 999 })).rejects.toThrow("1,000 through 900,000");
	});
});
