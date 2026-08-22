import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ensureDir, mkdtemp, pathExists, readFile, readdir, remove, writeFile, writeJSON } from "fs-extra";
import { realpath, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NullEngine, Scene } from "babylonjs";
import sharp from "sharp";

import {
	applyProjectPackageSampleImport,
	getProjectPackageSampleDetails,
	listProjectPackageSamples,
	locateProjectPackageSample,
	planProjectPackageSampleImport,
} from "../../src/mcp/project/packages";

describe("mcp/project-package-samples", () => {
	let directory: string;
	let packageRoot: string;
	let sampleRoot: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			state: { projectPath: "", packageManager: "npm" },
			layout: { inspector: { forceUpdate: () => undefined }, assets: { setBrowsePath: vi.fn(), setSelectedFile: vi.fn() }, selectTab: vi.fn() },
		},
	} as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-package-sample-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeJSON(join(directory, "package.json"), { name: "sample-game", dependencies: { "@studio/sample-pack": "1.2.3" } });
		packageRoot = join(directory, "node_modules", "@studio", "sample-pack");
		sampleRoot = join(packageRoot, "Samples~", "Starter");
		await ensureDir(join(sampleRoot, "scenes"));
		await ensureDir(join(packageRoot, "Documentation~"));
		await writeJSON(join(packageRoot, "package.json"), {
			name: "@studio/sample-pack",
			version: "1.2.3",
			samples: [
				{
					displayName: "Starter World",
					description: "A complete starter scene",
					path: "Samples~/Starter",
					publishedAt: "2026-07-01T00:00:00.000Z",
					images: [{ path: "Documentation~/cover.png", caption: "Starter preview", alt: "Preview of the starter world" }],
				},
			],
		});
		await sharp({ create: { width: 4, height: 3, channels: 4, background: { r: 20, g: 40, b: 80, alpha: 1 } } })
			.png()
			.toFile(join(packageRoot, "Documentation~", "cover.png"));
		await writeFile(join(sampleRoot, "README.md"), "Starter sample\n");
		await writeJSON(join(sampleRoot, "scenes", "main.scene.json"), { version: 1, name: "Starter" });
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	test("lists installed package sample manifests with bounded exact evidence", async () => {
		const result = await listProjectPackageSamples(scene, { offset: 0, limit: 10 }, options);
		expect(result).toMatchObject({ count: 1, total: 1, hasMore: false, nextOffset: null, errors: [] });
		expect(result.samples[0]).toMatchObject({
			id: expect.stringMatching(/^[a-f0-9]{32}$/),
			packageName: "@studio/sample-pack",
			packageVersion: "1.2.3",
			displayName: "Starter World",
			description: "A complete starter scene",
			publishedAt: "2026-07-01T00:00:00.000Z",
			sourcePath: "Samples~/Starter",
			imageCount: 1,
			fileCount: 2,
			totalBytes: expect.any(Number),
			sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});

	test("returns exact image/detail cards, publish sorting, and locates an imported target in the normal Assets Browser", async () => {
		const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
		manifest.samples.push({ displayName: "Older Example", path: "Samples~/Starter", publishedAt: "2024-01-01T00:00:00.000Z" });
		await writeJSON(join(packageRoot, "package.json"), manifest);
		const listed = await listProjectPackageSamples(scene, { sortBy: "publish-date", sortDirection: "desc" }, options);
		expect(listed).toMatchObject({ sortBy: "publish-date", sortDirection: "desc", total: 2 });
		expect(listed.samples.map((sample: any) => sample.displayName)).toEqual(["Starter World", "Older Example"]);
		const sample = listed.samples[0];
		const lease = { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256, expectedPackageFingerprint: listed.fingerprint };
		const details = await getProjectPackageSampleDetails(scene, lease, options);
		expect(details).toMatchObject({
			sample: { id: sample.id, publishedAt: "2026-07-01T00:00:00.000Z", imageCount: 1 },
			images: [expect.objectContaining({ format: "png", width: 4, height: 3, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), previewUrl: expect.stringMatching(/^file:/) })],
			imported: { exists: false, matchesSource: false },
			cards: [{ id: "overview" }, { id: "details" }],
		});
		await expect(locateProjectPackageSample(scene, lease, options)).rejects.toThrow(/Import it first/);
		const plan = await planProjectPackageSampleImport(scene, lease, options);
		await applyProjectPackageSampleImport(scene, { planId: plan.id, expectedSourceSha256: sample.sourceSha256, confirm: true }, options);
		const located = await locateProjectPackageSample(scene, { ...lease, targetPath: plan.targetPath }, options);
		expect(located).toMatchObject({ located: true, targetPath: plan.targetPath, fileCount: 2, matchesSource: true });
		expect(options.editor.layout.assets.setBrowsePath).toHaveBeenCalledWith(await realpath(join(directory, ...plan.targetPath.split("/"))));
		expect(options.editor.layout.assets.setSelectedFile).toHaveBeenCalledOnce();
		expect(options.editor.layout.selectTab).toHaveBeenCalledWith("assets-browser");
	});

	test("plans without writing and atomically imports to the default assets target", async () => {
		const listed = await listProjectPackageSamples(scene, {}, options);
		const sample = listed.samples[0];
		const plan = await planProjectPackageSampleImport(
			scene,
			{ sampleId: sample.id, expectedSourceSha256: sample.sourceSha256, expectedPackageFingerprint: listed.fingerprint },
			options
		);
		expect(plan).toMatchObject({
			targetPath: "assets/Samples/studio-sample-pack/1.2.3/Starter World",
			collision: "fail",
			targetBeforeSha256: null,
			writes: ["assets/Samples/studio-sample-pack/1.2.3/Starter World"],
		});
		const target = join(directory, ...plan.targetPath.split("/"));
		expect(await pathExists(target)).toBe(false);
		await expect(applyProjectPackageSampleImport(scene, { planId: plan.id, expectedSourceSha256: sample.sourceSha256 }, options)).rejects.toThrow(/confirm must be true/);
		const result = await applyProjectPackageSampleImport(scene, { planId: plan.id, expectedSourceSha256: sample.sourceSha256, confirm: true }, options);
		expect(result).toMatchObject({ imported: true, target: { path: plan.targetPath, fileCount: 2, sha256: sample.sourceSha256 }, rollback: null });
		expect(await readFile(join(target, "README.md"), "utf8")).toBe("Starter sample\n");
		expect(await readdir(join(directory, "assets", "Samples", "studio-sample-pack", "1.2.3"))).toEqual(["Starter World"]);
	});

	test("rejects a stale sample source before creating a destination", async () => {
		const listed = await listProjectPackageSamples(scene, {}, options);
		const sample = listed.samples[0];
		const plan = await planProjectPackageSampleImport(scene, { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256 }, options);
		await writeFile(join(sampleRoot, "README.md"), "changed after plan\n");
		await expect(applyProjectPackageSampleImport(scene, { planId: plan.id, expectedSourceSha256: sample.sourceSha256, confirm: true }, options)).rejects.toThrow(
			/source changed after planning/
		);
		expect(await pathExists(join(directory, ...plan.targetPath.split("/")))).toBe(false);
	});

	test("handles collisions only through explicit fail, rename, or replace plans", async () => {
		const listed = await listProjectPackageSamples(scene, {}, options);
		const sample = listed.samples[0];
		const first = await planProjectPackageSampleImport(scene, { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256 }, options);
		await applyProjectPackageSampleImport(scene, { planId: first.id, expectedSourceSha256: sample.sourceSha256, confirm: true }, options);
		await expect(planProjectPackageSampleImport(scene, { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256 }, options)).rejects.toThrow(/already exists/);

		const renamed = await planProjectPackageSampleImport(scene, { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256, collision: "rename" }, options);
		expect(renamed.targetPath).toBe(`${first.targetPath} (1)`);
		await applyProjectPackageSampleImport(scene, { planId: renamed.id, expectedSourceSha256: sample.sourceSha256, confirm: true }, options);

		const firstTarget = join(directory, ...first.targetPath.split("/"));
		await writeFile(join(firstTarget, "external.txt"), "replace me");
		const replaced = await planProjectPackageSampleImport(scene, { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256, collision: "replace" }, options);
		expect(replaced.targetBeforeSha256).toMatch(/^[a-f0-9]{64}$/);
		await applyProjectPackageSampleImport(scene, { planId: replaced.id, expectedSourceSha256: sample.sourceSha256, confirm: true }, options);
		expect(await pathExists(join(firstTarget, "external.txt"))).toBe(false);
		expect(await readFile(join(firstTarget, "README.md"), "utf8")).toBe("Starter sample\n");
	});

	test("rejects traversal and symbolic-link source/target paths", async () => {
		const listed = await listProjectPackageSamples(scene, {}, options);
		const sample = listed.samples[0];
		await expect(planProjectPackageSampleImport(scene, { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256, targetPath: "../outside" }, options)).rejects.toThrow(
			/stay inside/
		);
		await expect(
			planProjectPackageSampleImport(scene, { sampleId: sample.id, expectedSourceSha256: sample.sourceSha256, targetPath: "other/sample" }, options)
		).rejects.toThrow(/under.*assets/);

		if (process.platform !== "win32") {
			await symlink(join(sampleRoot, "README.md"), join(sampleRoot, "linked.md"));
			const unsafeSource = await listProjectPackageSamples(scene, {}, options);
			expect(unsafeSource.samples).toEqual([]);
			expect(unsafeSource.errors).toEqual([expect.objectContaining({ packageName: "@studio/sample-pack", error: expect.stringMatching(/symbolic links/) })]);
			await remove(join(sampleRoot, "linked.md"));

			await ensureDir(join(directory, "assets"));
			await symlink(sampleRoot, join(directory, "assets", "linked-target"));
			await expect(
				planProjectPackageSampleImport(
					scene,
					{ sampleId: sample.id, expectedSourceSha256: sample.sourceSha256, targetPath: "assets/linked-target", collision: "replace" },
					options
				)
			).rejects.toThrow(/cannot be a symbolic link/);
		}
	});
});
