import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createServer, Server } from "http";
import { mkdtemp, readFile, remove, writeFile, writeJSON } from "fs-extra";
import { symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { NullEngine, Scene } from "babylonjs";

import {
	applyProjectPackageRegistryPlan,
	getProjectPackageDetails,
	listProjectPackageRegistries,
	planProjectPackageRegistryChange,
	searchProjectPackageRegistry,
} from "../../src/mcp/project/packages";

describe("mcp/project-package-registry", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let server: Server;
	let registryUrl: string;
	let lastAuthorization: string | undefined;
	let previousToken: string | undefined;
	const options = { editor: { state: { projectPath: "", packageManager: "npm" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-package-registry-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeJSON(join(directory, "package.json"), { name: "registry-game", dependencies: { "private-pkg": "^1.0.0" } });
		engine = new NullEngine();
		scene = new Scene(engine);
		lastAuthorization = undefined;
		previousToken = process.env.ZVIBE_TEST_REGISTRY_TOKEN;
		process.env.ZVIBE_TEST_REGISTRY_TOKEN = "environment-secret-token";
		server = createServer((request, response) => {
			lastAuthorization = request.headers.authorization;
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname.includes("oversize")) {
				response.writeHead(200, { "content-type": "application/json", "content-length": String(32 * 1024 * 1024 + 1) });
				response.end();
				return;
			}
			if (url.pathname.includes("malformed")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end("{not-json");
				return;
			}
			if (url.pathname.endsWith("/-/v1/search")) {
				const packages = ["private-pkg", "private-utils", "private-renderer"];
				const from = Number(url.searchParams.get("from") ?? 0);
				const size = Number(url.searchParams.get("size") ?? 20);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						total: packages.length,
						objects: packages.slice(from, from + size).map((name, index) => ({
							package: {
								name,
								version: `1.${from + index}.0`,
								description: `${name} description`,
								keywords: ["babylon", "editor"],
								date: "2025-01-01T00:00:00.000Z",
								publisher: { username: "publisher" },
								links: { npm: `${registryUrl}${name}` },
							},
							score: { final: 0.9 },
						})),
					})
				);
				return;
			}
			if (decodeURIComponent(url.pathname).endsWith("/private-pkg")) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						name: "private-pkg",
						description: "Private package",
						license: "MIT",
						homepage: "https://example.test/private-pkg",
						repository: { url: "git+https://example.test/private-pkg.git" },
						"dist-tags": { latest: "2.0.0", next: "3.0.0-beta.1" },
						time: {
							created: "2024-01-01T00:00:00.000Z",
							modified: "2025-01-03T00:00:00.000Z",
							"1.0.0": "2024-01-01T00:00:00.000Z",
							"1.1.0": "2024-06-01T00:00:00.000Z",
							"2.0.0": "2025-01-03T00:00:00.000Z",
						},
						versions: {
							"1.0.0": { version: "1.0.0", dependencies: { alpha: "^1.0.0" } },
							"1.1.0": { version: "1.1.0", dependencies: { alpha: "^1.1.0" }, engines: { node: ">=18" } },
							"2.0.0": {
								version: "2.0.0",
								dependencies: { alpha: "^2.0.0" },
								peerDependencies: { babylonjs: "^9.0.0" },
								dist: { integrity: "sha512-test", tarball: `${registryUrl}private-pkg/-/private-pkg-2.0.0.tgz` },
							},
						},
					})
				);
				return;
			}
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "not found" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Test registry did not bind a TCP port.");
		registryUrl = `http://127.0.0.1:${address.port}/`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (previousToken === undefined) delete process.env.ZVIBE_TEST_REGISTRY_TOKEN;
		else process.env.ZVIBE_TEST_REGISTRY_TOKEN = previousToken;
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	test("lists default and scoped registries without exposing literal or environment credentials", async () => {
		await writeFile(
			join(directory, ".npmrc"),
			[
				`registry=${registryUrl}`,
				`//127.0.0.1:${new URL(registryUrl).port}/:_authToken=\${ZVIBE_TEST_REGISTRY_TOKEN}`,
				"@literal:registry=https://packages.example.test/",
				"//packages.example.test/:_authToken=literal-secret-value",
			].join("\n")
		);
		const result = await listProjectPackageRegistries(scene, { offset: 0, limit: 10 }, options);
		expect(result).toMatchObject({ count: 2, total: 2, hasMore: false, nextOffset: null });
		expect(result.registries[0]).toMatchObject({
			scope: null,
			url: registryUrl,
			source: ".npmrc",
			credential: { available: true, environmentVariables: ["ZVIBE_TEST_REGISTRY_TOKEN"] },
		});
		expect(result.registries[1]).toMatchObject({ scope: "@literal", credential: { literalSecretPresent: true, environmentVariables: [] } });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("environment-secret-token");
		expect(serialized).not.toContain("literal-secret-value");
		expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("searches with bounded pagination and resolves an environment credential only in memory", async () => {
		await writeFile(join(directory, ".npmrc"), `registry=${registryUrl}\n//127.0.0.1:${new URL(registryUrl).port}/:_authToken=\${ZVIBE_TEST_REGISTRY_TOKEN}\n`);
		const result = await searchProjectPackageRegistry(scene, { query: "private", offset: 1, limit: 1 }, options);
		expect(lastAuthorization).toBe("Bearer environment-secret-token");
		expect(result).toMatchObject({ query: "private", offset: 1, limit: 1, count: 1, total: 3, hasMore: true, nextOffset: 2 });
		expect(result.packages).toEqual([expect.objectContaining({ name: "private-utils", version: "1.1.0", publisher: "publisher" })]);
		expect(JSON.stringify(result)).not.toContain("environment-secret-token");
	});

	test("returns selected metadata and paginated release history without the readme", async () => {
		await writeFile(join(directory, ".npmrc"), `registry=${registryUrl}\n`);
		const result = await getProjectPackageDetails(scene, { name: "private-pkg", version: "1.1.0", offset: 1, limit: 1 }, options);
		expect(result).toMatchObject({
			name: "private-pkg",
			distTags: { latest: "2.0.0", next: "3.0.0-beta.1" },
			selected: { version: "1.1.0", engines: { node: ">=18" }, dependencies: { alpha: "^1.1.0" } },
			offset: 1,
			limit: 1,
			count: 1,
			total: 3,
			hasMore: true,
			nextOffset: 2,
			readmeIncluded: false,
		});
		expect(result.versions).toEqual([expect.objectContaining({ version: "1.1.0", publishedAt: "2024-06-01T00:00:00.000Z" })]);
	});

	test("rejects insecure remote HTTP registries before a request", async () => {
		await writeFile(join(directory, ".npmrc"), "registry=http://packages.example.test/\n");
		await expect(listProjectPackageRegistries(scene, {}, options)).rejects.toThrow(/HTTPS.*HTTP on loopback/);
	});

	test.skipIf(process.platform === "win32")("rejects a symbolic-link registry configuration", async () => {
		await writeFile(join(directory, "npmrc-target"), `registry=${registryUrl}\n`);
		await symlink(join(directory, "npmrc-target"), join(directory, ".npmrc"));
		await expect(listProjectPackageRegistries(scene, {}, options)).rejects.toThrow(/regular project-root file.*symbolic link/);
	});

	test("rejects oversized and malformed registry responses", async () => {
		await writeFile(join(directory, ".npmrc"), `registry=${registryUrl}oversize/\n`);
		await expect(searchProjectPackageRegistry(scene, { query: "x" }, options)).rejects.toThrow(/response exceeds/);
		await writeFile(join(directory, ".npmrc"), `registry=${registryUrl}malformed/\n`);
		await expect(searchProjectPackageRegistry(scene, { query: "x" }, options)).rejects.toThrow(/malformed JSON/);
	});

	test("rejects malformed package names and versions before registry access", async () => {
		await writeFile(join(directory, ".npmrc"), `registry=${registryUrl}\n`);
		await expect(getProjectPackageDetails(scene, { name: "-bad" }, options)).rejects.toThrow(/normal npm package identifier/);
		await expect(getProjectPackageDetails(scene, { name: "private-pkg", version: "1.0.0;echo" }, options)).rejects.toThrow(/exclude whitespace or control characters/);
	});

	test("plans an exact scoped-registry edit, rejects stale application, and writes only after confirmation", async () => {
		await writeFile(join(directory, ".npmrc"), `registry=${registryUrl}\n//unrelated.example/:_authToken=keep-this-existing-secret\n`);
		const inspected = await listProjectPackageRegistries(scene, {}, options);
		const plan = await planProjectPackageRegistryChange(
			scene,
			{
				action: "upsert",
				scope: "@studio",
				url: "https://packages.example.test/npm/",
				credentialEnvironmentVariable: "STUDIO_NPM_TOKEN",
				expectedFingerprint: inspected.fingerprint,
			},
			options
		);
		expect(plan).toMatchObject({ action: "upsert", scope: "@studio", credentialEnvironmentVariable: "STUDIO_NPM_TOKEN", changed: true, writes: [".npmrc"] });
		expect(JSON.stringify(plan)).not.toContain("keep-this-existing-secret");
		expect(await readFile(join(directory, ".npmrc"), "utf8")).not.toContain("@studio:registry");
		await expect(applyProjectPackageRegistryPlan(scene, { planId: plan.id, expectedFingerprint: plan.sourceFingerprint }, options)).rejects.toThrow(/confirm must be true/);

		await writeFile(join(directory, ".npmrc"), `${await readFile(join(directory, ".npmrc"), "utf8")}# external change\n`);
		await expect(applyProjectPackageRegistryPlan(scene, { planId: plan.id, expectedFingerprint: plan.sourceFingerprint, confirm: true }, options)).rejects.toThrow(
			/changed after planning/
		);

		const refreshed = await listProjectPackageRegistries(scene, {}, options);
		const freshPlan = await planProjectPackageRegistryChange(
			scene,
			{
				action: "upsert",
				scope: "@studio",
				url: "https://packages.example.test/npm/",
				credentialEnvironmentVariable: "STUDIO_NPM_TOKEN",
				expectedFingerprint: refreshed.fingerprint,
			},
			options
		);
		const applied = await applyProjectPackageRegistryPlan(scene, { planId: freshPlan.id, expectedFingerprint: freshPlan.sourceFingerprint, confirm: true }, options);
		expect(applied).toMatchObject({
			applied: true,
			registries: expect.arrayContaining([expect.objectContaining({ scope: "@studio", url: "https://packages.example.test/npm/" })]),
		});
		const content = await readFile(join(directory, ".npmrc"), "utf8");
		expect(content).toContain("@studio:registry=https://packages.example.test/npm/");
		expect(content).toContain("//packages.example.test/npm/:_authToken=${STUDIO_NPM_TOKEN}");
		expect(content).toContain("keep-this-existing-secret");
	});

	test("validates registry-plan credential environment names", async () => {
		await expect(
			planProjectPackageRegistryChange(scene, { action: "upsert", url: "https://packages.example.test/", credentialEnvironmentVariable: "bad-token-name" }, options)
		).rejects.toThrow(/valid environment-variable name/);
	});
});
