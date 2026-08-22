import { tmpdir } from "node:os";
import { dirname, join } from "node:path/posix";

import { symlink, truncate } from "node:fs/promises";

import fs, { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile } from "fs-extra";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createExternalAsepriteFixture, createSimpleAsepriteFixture } from "../../tools/test/assets/aseprite-fixture";
import {
	asepriteBuildOutputIsCurrent,
	exportAsepriteBuildAsset,
	getAsepriteBuildOutputPaths,
	inspectAsepriteBuildSource,
	removeAsepriteBuildOutput,
} from "../src/aseprite/exporter.mjs";

describe("shared Aseprite build exporter", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("publishes exact source and atlas evidence, reuses it, repairs tampering, and removes only owned output", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-aseprite-exporter-"));
		directories.push(project);
		const sourcePath = join(project, "assets", "hero.aseprite");
		const outputRoot = join(project, "public", "scene");
		const destination = join(outputRoot, "assets", "hero.aseprite");
		await ensureDir(join(project, "assets"));
		await writeFile(sourcePath, createSimpleAsepriteFixture());
		const source = await inspectAsepriteBuildSource(sourcePath, project, { maximumAtlasSize: 64, powerOfTwo: true });
		const options = { projectRoot: project, outputRoot, destination, guid: "hero-guid", expectedFingerprint: source.fingerprint };
		const first = await exportAsepriteBuildAsset(source, options);
		expect(first.reused).toBe(false);
		expect(first.exportedPaths).toEqual([first.paths.source, first.paths.runtimeManifest, first.paths.atlasImage, first.paths.atlasJson, first.paths.importManifest]);
		expect(await asepriteBuildOutputIsCurrent(source, options)).toBe(true);
		expect(await readFile(destination)).toEqual(Buffer.from(source.bytes));
		const runtimeBytes = await readFile(first.paths.runtimeManifest);
		expect(await readFile(first.paths.importManifest)).toEqual(runtimeBytes);
		expect(runtimeBytes.toString("utf-8")).not.toContain(project);
		expect(await readJSON(first.paths.atlasJson)).toMatchObject({
			meta: { image: "atlas.png", zvibe: { source: { name: "hero.aseprite", sha256: source.sha256 }, document: { frameCount: 1 } } },
		});

		const reused = await exportAsepriteBuildAsset(source, options);
		expect(reused.reused).toBe(true);
		const concurrent = await Promise.all(Array.from({ length: 16 }, () => exportAsepriteBuildAsset(source, options)));
		expect(concurrent.every((result) => result.reused)).toBe(true);
		await truncate(first.paths.atlasImage, 513 * 1024 * 1024);
		expect(await asepriteBuildOutputIsCurrent(source, options)).toBe(false);
		await exportAsepriteBuildAsset(source, options);
		await writeFile(first.paths.atlasImage, "tampered");
		expect(await asepriteBuildOutputIsCurrent(source, options)).toBe(false);
		const repaired = await exportAsepriteBuildAsset(source, options);
		expect(repaired.reused).toBe(false);
		expect(await asepriteBuildOutputIsCurrent(source, options)).toBe(true);

		const unrelated = join(outputRoot, ".bjseditor", "imported-assets", "unrelated", "keep.txt");
		await ensureDir(join(outputRoot, ".bjseditor", "imported-assets", "unrelated"));
		await writeFile(unrelated, "keep");
		await removeAsepriteBuildOutput(destination, outputRoot, "hero-guid");
		expect(await Promise.all(first.exportedPaths.map((path) => pathExists(path)))).toEqual([false, false, false, false, false]);
		expect(await readFile(unrelated, "utf-8")).toBe("keep");
	});

	test("leases external dependency bytes and rejects stale plans, traversal, cycles, and duplicate GUID ownership", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-aseprite-dependency-"));
		directories.push(project);
		const assets = join(project, "assets");
		const outputRoot = join(project, "public", "scene");
		await ensureDir(assets);
		const fixture = createExternalAsepriteFixture();
		const sourcePath = join(assets, "map.aseprite");
		const dependencyPath = join(assets, "shared.aseprite");
		await writeFile(sourcePath, fixture.source);
		await writeFile(dependencyPath, fixture.dependency);
		const source = await inspectAsepriteBuildSource(sourcePath, project, { maximumAtlasSize: 64 });
		expect(source.dependencies).toEqual([
			expect.objectContaining({ ownerPath: "assets/map.aseprite", path: "assets/shared.aseprite", externalFileId: 9, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
		]);
		const destination = join(outputRoot, "assets", "map.aseprite");
		const options = { projectRoot: project, outputRoot, destination, guid: "shared-guid", expectedFingerprint: source.fingerprint };
		await exportAsepriteBuildAsset(source, options);
		await writeFile(dependencyPath, createExternalAsepriteFixture("shared.aseprite", [1, 2, 3, 255]).dependency);
		const changed = await inspectAsepriteBuildSource(sourcePath, project, { maximumAtlasSize: 64 });
		expect(changed.fingerprint).not.toBe(source.fingerprint);
		expect(await asepriteBuildOutputIsCurrent(changed, options)).toBe(false);
		await expect(exportAsepriteBuildAsset(source, options)).rejects.toThrow(/changed during build/);
		expect(await readJSON(getAsepriteBuildOutputPaths(outputRoot, destination, "shared-guid").runtimeManifest)).toMatchObject({ fingerprint: source.fingerprint });

		const secondPath = join(assets, "second.aseprite");
		await writeFile(secondPath, createSimpleAsepriteFixture());
		const second = await inspectAsepriteBuildSource(secondPath, project, { maximumAtlasSize: 64 });
		await expect(
			exportAsepriteBuildAsset(second, { projectRoot: project, outputRoot, destination: join(outputRoot, "assets", "second.aseprite"), guid: "shared-guid" })
		).rejects.toThrow(/GUID collision/);
		const sourceLink = join(assets, "linked.aseprite");
		await symlink(secondPath, sourceLink);
		await expect(inspectAsepriteBuildSource(sourceLink, project)).rejects.toThrow(/non-symbolic/);
		const symlinkRoot = join(project, "symlink-public");
		const escapedOutput = join(project, "escaped-output");
		await Promise.all([ensureDir(symlinkRoot), ensureDir(escapedOutput)]);
		await symlink(escapedOutput, join(symlinkRoot, "assets"), "dir");
		await expect(
			exportAsepriteBuildAsset(second, { projectRoot: project, outputRoot: symlinkRoot, destination: join(symlinkRoot, "assets", "second.aseprite"), guid: "second-guid" })
		).rejects.toThrow(/outside the output root/);
		expect(await pathExists(join(escapedOutput, "second.aseprite"))).toBe(false);

		const outside = join(dirname(project), "outside.aseprite");
		await writeFile(outside, createSimpleAsepriteFixture());
		try {
			await expect(inspectAsepriteBuildSource(outside, project)).rejects.toThrow(/outside the project/);
		} finally {
			await remove(outside);
		}
		await writeFile(sourcePath, createExternalAsepriteFixture("map.aseprite").source);
		await expect(inspectAsepriteBuildSource(sourcePath, project)).rejects.toThrow(/cycle/);
		const absentRoot = join(project, "never-built");
		await removeAsepriteBuildOutput(join(absentRoot, "assets", "unused.aseprite"), absentRoot, "unused-guid");
		expect(await pathExists(absentRoot)).toBe(false);
	});

	test("restores every prior output byte when publication fails after the first backup", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-aseprite-rollback-"));
		directories.push(project);
		const sourcePath = join(project, "assets", "hero.aseprite");
		const outputRoot = join(project, "public", "scene");
		const destination = join(outputRoot, "assets", "hero.aseprite");
		await ensureDir(join(project, "assets"));
		await writeFile(sourcePath, createSimpleAsepriteFixture([10, 20, 30, 255]));
		const initial = await inspectAsepriteBuildSource(sourcePath, project, { maximumAtlasSize: 64 });
		const options = { projectRoot: project, outputRoot, destination, guid: "rollback-guid" };
		const output = await exportAsepriteBuildAsset(initial, options);
		const priorBytes = await Promise.all(output.exportedPaths.map((path) => readFile(path)));
		await writeFile(sourcePath, createSimpleAsepriteFixture([90, 80, 70, 255]));
		const changed = await inspectAsepriteBuildSource(sourcePath, project, { maximumAtlasSize: 64 });
		const move = fs.move.bind(fs);
		const moveSpy = vi.spyOn(fs, "move").mockImplementation(async (source, target, moveOptions) => {
			if (source === output.paths.runtimeManifest) {
				throw new Error("injected runtime backup failure");
			}
			return move(source, target, moveOptions);
		});
		try {
			await expect(exportAsepriteBuildAsset(changed, options)).rejects.toThrow("injected runtime backup failure");
		} finally {
			moveSpy.mockRestore();
		}
		for (const [index, path] of output.exportedPaths.entries()) {
			expect(await readFile(path)).toEqual(priorBytes[index]);
		}
		expect(await asepriteBuildOutputIsCurrent(initial, options)).toBe(true);
	});
});
