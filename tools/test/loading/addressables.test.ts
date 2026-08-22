import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import {
	AddressableCatalog,
	createAddressablePortableBundle,
	createAddressableTypeTreeRegistry,
	extractAddressableTypeTreeSchema,
	getAddressableCatalogHashPayload,
	IAddressableCatalog,
	normalizeAddressableConfiguration,
	serializeAddressablePortableBundle,
	validateAddressableConfiguration,
} from "../../src/loading/addressables";

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function finalize(catalog: IAddressableCatalog): IAddressableCatalog {
	const result = structuredClone(catalog);
	result.catalogHash = hash(getAddressableCatalogHashPayload(result));
	return result;
}

function catalog(buildId: string, assets: Array<{ address: string; value: string; labels?: string[] }>): IAddressableCatalog {
	return finalize({
		version: 2,
		buildId,
		buildType: "full",
		profileId: "production",
		generatedAt: "2026-08-07T00:00:00.000Z",
		catalogHash: "0".repeat(64),
		remoteCatalog: { pointerUrl: "https://cdn.test/addressables.current.json" },
		runtime: { verifyHashes: true, requestTimeoutMs: 5_000, maxConcurrentRequests: 2, cacheMaxBytes: 1024 },
		groups: [
			{
				id: "remote",
				name: "Remote",
				delivery: "remote",
				updateRestriction: "dynamic",
				loadPath: "https://cdn.test",
				assets: assets.map((asset) => ({
					path: `${asset.address}.txt`,
					address: asset.address,
					internalId: `content/${asset.address}.txt`,
					sizeBytes: new TextEncoder().encode(asset.value).byteLength,
					hash: hash(asset.value),
					labels: asset.labels ?? [],
					sourceGroupId: "remote",
				})),
			},
		],
	});
}

describe("loading/addressables", () => {
	test("migrates legacy groups to exact version-2 profiles, entries, and update rules", () => {
		const result = normalizeAddressableConfiguration({
			version: 1,
			groups: [{ id: "characters", name: "Characters", remoteUrl: "https://cdn.test/content", assets: ["hero.glb"], assetLabels: { "hero.glb": ["featured", "character"] } }],
		});
		expect(result).toMatchObject({
			version: 2,
			revision: 0,
			activeProfileId: "default",
			profiles: [{ id: "default" }],
			groups: [
				{
					id: "characters",
					delivery: "remote",
					updateRestriction: "static",
					loadPath: "https://cdn.test/content",
					assets: [{ path: "hero.glb", address: "hero.glb", labels: ["character", "featured"] }],
				},
			],
			deploymentTargets: [],
		});
		const invalid = structuredClone(result);
		invalid.groups.push({ ...structuredClone(result.groups[0]), id: "duplicate", name: "Duplicate" });
		expect(() => validateAddressableConfiguration(invalid)).toThrow(/addresses must be unique/);
		const emptyPath = structuredClone(result);
		emptyPath.profiles[0].localBuildPath = "";
		expect(() => validateAddressableConfiguration(emptyPath)).toThrow(/Local build path must be a non-empty string/);
		expect(result.settings.extractTypeTrees).toBe(false);
	});

	test("migrates version-2 catalogs without portable bundles into the version-3 runtime model", () => {
		const legacy = catalog("legacy-build", [{ address: "hero", value: "hero" }]);
		legacy.version = 2;
		const runtime = new AddressableCatalog("https://cdn.test", legacy);
		expect(runtime.getRuntimeStatus()).toMatchObject({ buildId: "legacy-build", typeTreeSchemaCount: 0, portableBundleCount: 0 });
	});

	test("deduplicates verified downloads, bounds cache, updates remote catalogs atomically, and prefetches labels", async () => {
		const initial = catalog("old-build", [{ address: "hero", value: "hero", labels: ["featured"] }]);
		const updated = catalog("new-build", [
			{ address: "hero", value: "hero", labels: ["featured"] },
			{ address: "forest", value: "forest", labels: ["environment"] },
		]);
		const pointer = { version: 1, buildId: updated.buildId, catalogHash: updated.catalogHash, catalogUrl: "catalogs/new.catalog.json", hashUrl: "catalogs/new.hash" };
		const values = new Map<string, string>([
			["https://cdn.test/addressables.current.json", JSON.stringify(pointer)],
			["https://cdn.test/catalogs/new.catalog.json", JSON.stringify(updated)],
			["https://cdn.test/catalogs/new.hash", `${updated.catalogHash}\n`],
			["https://cdn.test/content/hero.txt", "hero"],
			["https://cdn.test/content/forest.txt", "forest"],
		]);
		const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const value = values.get(url);
			return value === undefined ? new Response("missing", { status: 404 }) : new Response(value, { status: 200 });
		});
		const runtime = new AddressableCatalog("https://cdn.test", initial, { fetch: fetchMock as typeof fetch });
		const [left, right] = await Promise.all([runtime.loadAddress("hero"), runtime.loadAddress("hero")]);
		expect(new TextDecoder().decode(left)).toBe("hero");
		expect(new TextDecoder().decode(right)).toBe("hero");
		expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("content/hero.txt"))).toHaveLength(1);
		expect(await runtime.checkForCatalogUpdates()).toMatchObject({ available: true, currentBuildId: "old-build", remoteBuildId: "new-build" });
		expect(await runtime.updateCatalog()).toMatchObject({ available: false, currentBuildId: "new-build" });
		expect(runtime.getDownloadSize({ labels: ["environment"] })).toBe(6);
		expect(await runtime.downloadDependencies({ labels: ["environment"] })).toEqual({ assetCount: 1, downloadedCount: 1, cachedCount: 0, downloadedBytes: 6 });
		expect(runtime.getRuntimeStatus()).toMatchObject({ buildId: "new-build", cache: { entryCount: 2, sizeBytes: 10 } });
		expect(runtime.clearDependencyCache({ addresses: ["forest"] })).toBe(1);

		values.set("https://cdn.test/addressables.current.json", JSON.stringify({ ...pointer, buildId: "broken", catalogHash: "f".repeat(64) }));
		await expect(runtime.updateCatalog()).rejects.toThrow(/hash or build identity/);
		expect(runtime.getRuntimeStatus().buildId).toBe("new-build");
	});

	test("loads one shared TypeTree registry and portable bundle concurrently, reconstructing exact JSON", async () => {
		const hero = { veryLongDisplayNameProperty: "Hero", healthPointsProperty: 100 };
		const enemy = { healthPointsProperty: 35, veryLongDisplayNameProperty: "Enemy" };
		const [heroSchema, enemySchema] = await Promise.all([extractAddressableTypeTreeSchema(hero), extractAddressableTypeTreeSchema(enemy)]);
		const registry = await createAddressableTypeTreeRegistry([heroSchema, enemySchema]);
		const registryBytes = new TextEncoder().encode(`${JSON.stringify(registry)}\n`);
		const bundle = await createAddressablePortableBundle([
			{ address: "hero", value: hero, schema: heroSchema },
			{ address: "enemy", value: enemy, schema: enemySchema },
		]);
		const bundleBytes = serializeAddressablePortableBundle(bundle);
		const internalId = `bundles/${bundle.id}.bundle.json`;
		const portableCatalog = finalize({
			version: 3,
			buildId: "portable-build",
			buildType: "full",
			profileId: "production",
			generatedAt: "2026-08-12T00:00:00.000Z",
			catalogHash: "0".repeat(64),
			runtime: { verifyHashes: true, requestTimeoutMs: 5_000, maxConcurrentRequests: 2, cacheMaxBytes: 0 },
			typeTreeRegistry: {
				registryId: registry.id,
				internalId: `type-trees/${registry.id}.registry.json`,
				loadPaths: ["https://cdn.test"],
				sizeBytes: registryBytes.byteLength,
				hash: hashBytes(registryBytes),
				schemaCount: registry.schemas.length,
			},
			portableBundles: [{ id: bundle.id, internalId, sizeBytes: bundleBytes.byteLength, hash: hashBytes(bundleBytes), addresses: ["enemy", "hero"] }],
			typeTreeSummary: {
				enabled: true,
				schemaCount: 1,
				bundleCount: 1,
				structuredAssetCount: 2,
				sourceBytes: JSON.stringify(hero).length + JSON.stringify(enemy).length,
				bundleBytes: bundleBytes.byteLength,
				registryBytes: registryBytes.byteLength,
				savedBytes: 1,
			},
			groups: [
				{
					id: "portable",
					name: "Portable",
					delivery: "remote",
					updateRestriction: "dynamic",
					loadPath: "https://cdn.test",
					assets: bundle.entries.map((entry) => ({
						path: `${entry.address}.json`,
						address: entry.address,
						internalId,
						sizeBytes: entry.sizeBytes,
						hash: entry.hash,
						labels: [],
						sourceGroupId: "portable",
						portableBundleId: bundle.id,
						typeTreeSchemaId: entry.schemaId,
					})),
				},
			],
		});
		const values = new Map<string, Uint8Array>([
			[`https://cdn.test/${portableCatalog.typeTreeRegistry!.internalId}`, registryBytes],
			[`https://cdn.test/${internalId}`, bundleBytes],
		]);
		const fetchMock = vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const value = values.get(url);
			return value ? new Response(value as BodyInit, { status: 200 }) : new Response("missing", { status: 404 });
		});
		const runtime = new AddressableCatalog("https://cdn.test", portableCatalog, { fetch: fetchMock as typeof fetch, cacheMaxBytes: 0 });
		expect(runtime.getDownloadSize({ addresses: ["hero", "enemy"] })).toBe(registryBytes.byteLength + bundleBytes.byteLength);
		const [heroBytes, enemyBytes] = await Promise.all([runtime.loadAddress("hero"), runtime.loadAddress("enemy")]);
		expect(JSON.parse(new TextDecoder().decode(heroBytes))).toEqual(hero);
		expect(JSON.parse(new TextDecoder().decode(enemyBytes))).toEqual(enemy);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(".registry.json"))).toHaveLength(1);
		expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith(".bundle.json"))).toHaveLength(1);
	});
});
