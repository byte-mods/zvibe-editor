import { createHash } from "node:crypto";

import { chmod, mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { getDefaultAlembicImporterSettings, parseAlembicCache } from "babylonjs-editor-tools";

import { createAlembicTestCache, rewriteAlembicManifest } from "../../tools/test/assets/alembic-fixture";
import { convertAlembicFileToCache, convertBlendFileToGlb, convertGlbFileToFbx } from "../src/blender/converter.mjs";

const directories: string[] = [];

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

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

	test("converts an exact GLB into bounded binary FBX evidence without a shell", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-fbx-converter-test-"));
		directories.push(directory);
		const sourcePath = join(directory, "source model.glb");
		const executable = join(directory, "fake blender");
		const glb = Buffer.alloc(20);
		glb.writeUInt32LE(0x46546c67, 0);
		glb.writeUInt32LE(2, 4);
		glb.writeUInt32LE(glb.length, 8);
		await writeFile(sourcePath, glb);
		await writeFile(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
const output = process.argv[process.argv.length - 2];
const settings = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], "utf8"));
if (settings.axisForward !== "X" || settings.axisUp !== "Z") process.exit(12);
const fbx = Buffer.alloc(64);
Buffer.from("Kaydara FBX Binary  \\0\\x1a\\0", "binary").copy(fbx);
fbx.writeUInt32LE(7400, 23);
fs.writeFileSync(output, fbx);
process.stdout.write('ZVIBE_FBX_EXPORT {"blenderVersion":"5.1-test","statistics":{"actionCount":1,"armatureCount":1,"cameraCount":1,"lightCount":1,"materialCount":2,"meshCount":3,"objectCount":7}}\\n');
`,
			"utf-8"
		);
		await chmod(executable, 0o755);

		const result = await convertGlbFileToFbx(sourcePath, { executable, timeoutMs: 5_000, settings: { axisForward: "X", axisUp: "Z" } });
		expect(result).toMatchObject({
			executable,
			outputBytes: 64,
			evidence: {
				model: "zvibe-fbx-export-v1",
				blenderVersion: "5.1-test",
				output: { bytes: 64, binaryVersion: 7400 },
				statistics: { meshCount: 3, armatureCount: 1, actionCount: 1 },
			},
		});
		expect(result.evidence.source.sha256).toBe(createHash("sha256").update(glb).digest("hex"));
		expect(result.evidence.output.sha256).toBe(createHash("sha256").update(result.content).digest("hex"));
	});

	test("rejects malformed FBX output and missing converter evidence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-fbx-converter-test-"));
		directories.push(directory);
		const sourcePath = join(directory, "source.glb");
		const executable = join(directory, "fake blender");
		const glb = Buffer.alloc(20);
		glb.writeUInt32LE(0x46546c67, 0);
		glb.writeUInt32LE(2, 4);
		glb.writeUInt32LE(glb.length, 8);
		await writeFile(sourcePath, glb);
		await writeFile(executable, '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.argv[process.argv.length - 2], "ASCII FBX");\n', "utf-8");
		await chmod(executable, 0o755);

		await expect(convertGlbFileToFbx(sourcePath, { executable, timeoutMs: 5_000 })).rejects.toThrow(/invalid, ASCII, or oversized binary FBX/i);

		await writeFile(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
const output = process.argv[process.argv.length - 2];
const fbx = Buffer.alloc(64);
Buffer.from("Kaydara FBX Binary  \\0\\x1a\\0", "binary").copy(fbx);
fbx.writeUInt32LE(7400, 23);
fs.writeFileSync(output, fbx);
`,
			"utf-8"
		);
		await chmod(executable, 0o755);
		await expect(convertGlbFileToFbx(sourcePath, { executable, timeoutMs: 5_000 })).rejects.toThrow(/did not report its version and object statistics/i);
	});

	test("validates exact Alembic source and settings evidence from a shell-free converter", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zvibe-alembic-converter-test-"));
		directories.push(directory);
		const sourcePath = join(directory, "source file.abc");
		const fixturePath = join(directory, "fixture.zvabc");
		const executable = join(directory, "fake blender");
		const source = Buffer.from("exact-alembic-source");
		const settings = getDefaultAlembicImporterSettings();
		await writeFile(sourcePath, source);
		const content = rewriteAlembicManifest(createAlembicTestCache().bytes, (manifest) => {
			manifest.source.name = "source file.abc";
			manifest.source.bytes = source.byteLength;
			manifest.source.sha256 = createHash("sha256").update(source).digest("hex");
			manifest.settingsSha256 = createHash("sha256").update(canonicalJson(settings)).digest("hex");
		});
		await writeFile(fixturePath, content);
		await writeFile(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
const output = process.argv[process.argv.length - 2];
fs.copyFileSync(${JSON.stringify(fixturePath)}, output);
process.stdout.write("alembic converted");
`,
			"utf-8"
		);
		await chmod(executable, 0o755);

		const result = await convertAlembicFileToCache(sourcePath, { executable, settings, timeoutMs: 5_000 });
		expect(result).toMatchObject({ executable, outputBytes: content.byteLength, stdout: "alembic converted" });
		expect(parseAlembicCache(result.content).manifest).toMatchObject({ source: { bytes: source.byteLength }, sampleCount: 3 });
	});
});
