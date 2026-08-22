import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createServer, Server } from "http";
import { mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";
import { NullEngine, Scene } from "babylonjs";

import { getProjectPackageDependencyGraph, getProjectPackageUpdates } from "../../src/mcp/project/packages";

describe("mcp/project-package-dependencies", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "", packageManager: "npm" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-package-dependencies-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeJSON(join(directory, "package.json"), { name: "dependency-game", dependencies: { alpha: "^1.0.0" } });
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	test("reads npm package-lock direct and transitive resolution", async () => {
		options.editor.state.packageManager = "npm";
		await writeJSON(join(directory, "package-lock.json"), {
			name: "dependency-game",
			lockfileVersion: 3,
			packages: {
				"": { name: "dependency-game", dependencies: { alpha: "^1.0.0" } },
				"node_modules/alpha": { name: "alpha", version: "1.1.0", integrity: "sha512-alpha", dependencies: { beta: "^2.0.0" } },
				"node_modules/beta": { name: "beta", version: "2.1.0", integrity: "sha512-beta" },
			},
		});
		const result = await getProjectPackageDependencyGraph(scene, { offset: 0, limit: 10 }, options);
		expect(result).toMatchObject({ format: "package-lock", count: 2, total: 2, hasMore: false });
		expect(result.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "alpha", version: "1.1.0", direct: true, dependencyTypes: ["dependencies"] }),
				expect.objectContaining({ name: "beta", version: "2.1.0", direct: false }),
			])
		);
		expect(result.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ from: "root", name: "alpha", missing: false }),
				expect.objectContaining({ name: "beta", requested: "^2.0.0", missing: false }),
			])
		);
	});

	test("reads Yarn classic lock entries and dependency edges", async () => {
		options.editor.state.packageManager = "yarn";
		await writeFile(
			join(directory, "yarn.lock"),
			["# yarn lockfile v1", "", "alpha@^1.0.0:", '  version "1.1.0"', "  dependencies:", '    beta "^2.0.0"', "", "beta@^2.0.0:", '  version "2.1.0"', ""].join("\n")
		);
		const result = await getProjectPackageDependencyGraph(scene, {}, options);
		expect(result).toMatchObject({ format: "yarn", total: 2 });
		expect(result.edges).toEqual(expect.arrayContaining([expect.objectContaining({ name: "beta", to: expect.stringContaining("beta"), missing: false })]));
	});

	test("reads pnpm import/snapshot-style lock entries", async () => {
		options.editor.state.packageManager = "pnpm";
		await writeFile(
			join(directory, "pnpm-lock.yaml"),
			[
				"lockfileVersion: '9.0'",
				"packages:",
				"  alpha@1.1.0:",
				"    resolution: {integrity: sha512-alpha}",
				"  beta@2.1.0:",
				"    resolution: {integrity: sha512-beta}",
				"snapshots:",
				"  alpha@1.1.0:",
				"    dependencies:",
				"      beta: 2.1.0",
				"  beta@2.1.0: {}",
			].join("\n")
		);
		const result = await getProjectPackageDependencyGraph(scene, {}, options);
		expect(result).toMatchObject({ format: "pnpm", total: 2 });
		expect(result.nodes).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "alpha", version: "1.1.0" }), expect.objectContaining({ name: "beta", version: "2.1.0" })])
		);
		expect(result.edges).toEqual(expect.arrayContaining([expect.objectContaining({ name: "beta", requested: "2.1.0", missing: false })]));
	});

	test("reads Bun text lock package tuples", async () => {
		options.editor.state.packageManager = "bun";
		await writeFile(
			join(directory, "bun.lock"),
			JSON.stringify(
				{ lockfileVersion: 1, packages: { alpha: ["alpha@1.1.0", "", { beta: "2.1.0" }, "sha512-alpha"], beta: ["beta@2.1.0", "", {}, "sha512-beta"] } },
				null,
				2
			)
		);
		const result = await getProjectPackageDependencyGraph(scene, {}, options);
		expect(result).toMatchObject({ format: "bun-text", total: 2 });
		expect(result.edges).toEqual(expect.arrayContaining([expect.objectContaining({ name: "beta", requested: "2.1.0", missing: false })]));
	});

	test("paginates and filters the graph while preserving lock evidence", async () => {
		options.editor.state.packageManager = "npm";
		await writeJSON(join(directory, "package-lock.json"), {
			lockfileVersion: 3,
			packages: {
				"": {},
				"node_modules/alpha": { name: "alpha", version: "1.1.0" },
				"node_modules/beta": { name: "beta", version: "2.1.0" },
			},
		});
		const result = await getProjectPackageDependencyGraph(scene, { query: "a", offset: 1, limit: 1 }, options);
		expect(result).toMatchObject({
			offset: 1,
			limit: 1,
			count: 1,
			total: 2,
			hasMore: false,
			nextOffset: null,
			lockfile: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
		});
	});

	test("reports wanted and latest versions from registry metadata", async () => {
		options.editor.state.packageManager = "npm";
		await writeJSON(join(directory, "package-lock.json"), {
			lockfileVersion: 3,
			packages: { "": {}, "node_modules/alpha": { name: "alpha", version: "1.0.0" } },
		});
		let server: Server;
		let acceptHeader: string | undefined;
		server = createServer((request, response) => {
			acceptHeader = request.headers.accept;
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ name: "alpha", "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {}, "1.2.0": {}, "2.0.0": {} } }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Update registry did not bind.");
		await writeFile(join(directory, ".npmrc"), `registry=http://127.0.0.1:${address.port}/\n`);
		try {
			const result = await getProjectPackageUpdates(scene, { offset: 0, limit: 10 }, options);
			expect(acceptHeader).toContain("application/vnd.npm.install-v1+json");
			expect(result).toMatchObject({ count: 1, total: 1, availableCount: 1 });
			expect(result.updates[0]).toMatchObject({
				name: "alpha",
				current: "1.0.0",
				wanted: "1.2.0",
				latest: "2.0.0",
				wantedUpdateAvailable: true,
				latestUpdateAvailable: true,
				wantedChange: "minor",
				latestChange: "major",
				error: null,
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
