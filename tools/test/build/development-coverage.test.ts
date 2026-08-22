import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { createDevelopmentBuildCoveragePlugin, instrumentDevelopmentCoverageSource } from "../../src/build/development-coverage";

const previousCoverage = process.env.BJS_EDITOR_CODE_COVERAGE;

afterEach(() => {
	if (previousCoverage === undefined) {
		delete process.env.BJS_EDITOR_CODE_COVERAGE;
	} else {
		process.env.BJS_EDITOR_CODE_COVERAGE = previousCoverage;
	}
	delete (globalThis as any).__zvibeDevelopmentBuildCoverageProbeV1;
	delete (globalThis as any).__zvibeDevelopmentBuildCoverageV1;
});

describe("development build coverage", () => {
	test("instruments functions, statements, and branches without changing ordinary execution", () => {
		const result = instrumentDevelopmentCoverageSource("export function choose(value: boolean) { if (value) return 1; return 2; }", "src/choose.ts");
		expect(new Set(result.points.map((point) => point.kind))).toEqual(new Set(["function", "statement", "branch"]));
		expect(result.contents).toContain("__zvibeDevelopmentBuildCoverageProbeV1");
	});

	test("emits a fingerprinted manifest, prepends the runtime, and writes the exact external manifest", async () => {
		process.env.BJS_EDITOR_CODE_COVERAGE = "true";
		const directory = await mkdtemp(join(tmpdir(), "zvibe-development-coverage-"));
		try {
			const manifestPath = join(directory, ".bjseditor", "build-coverage", "desktop.json");
			const plugin = createDevelopmentBuildCoveragePlugin({ profileId: "desktop", targetPlatform: "darwin", manifestPath });
			plugin.configResolved({ root: directory });
			const transformed = plugin.transform("export function run(flag) { return flag ? 1 : 2; }", join(directory, "src", "run.ts"));
			const bundle = { "index.js": { type: "chunk", isEntry: true, code: `${transformed.code.replace("export ", "")}\nrun(true);` } };
			const assets: any[] = [];
			plugin.generateBundle.call({ emitFile: (asset: any) => assets.push(asset) }, {}, bundle);
			await plugin.closeBundle();
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			expect(manifest).toMatchObject({ version: 1, profileId: "desktop", targetPlatform: "darwin", files: 1 });
			expect(manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
			expect(assets[0].fileName).toBe("zvibe-code-coverage-manifest.json");
			expect(bundle["index.js"].code).toContain("__zvibeDevelopmentBuildCoverageV1");
			new Function(bundle["index.js"].code)();
			const snapshot = (globalThis as any).__zvibeDevelopmentBuildCoverageV1.snapshot();
			expect(snapshot.summary.functions.covered).toBe(1);
			expect(snapshot.summary.branches.covered).toBe(1);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	test("is inert unless the build profile explicitly enables coverage", () => {
		delete process.env.BJS_EDITOR_CODE_COVERAGE;
		const plugin = createDevelopmentBuildCoveragePlugin();
		plugin.configResolved({ root: "/project" });
		expect(plugin.transform("export const value = 1;", "/project/src/value.ts")).toBeNull();
	});
});
