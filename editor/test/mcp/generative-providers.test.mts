import { mkdtemp, readFile, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { ensureDir, remove, writeJSON } from "fs-extra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { deleteGenerativeAssetProvider, readGenerativeAssetProviderInventory, setGenerativeAssetProvider } from "../../src/mcp/ai/generative-providers";
import { projectConfiguration } from "../../src/project/configuration";

describe("Generative asset provider inventory", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-generative-providers-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeJSON(projectConfiguration.path, {});
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("creates, lists, exact-leases, replaces, and deletes a provider without persisting credentials", async () => {
		const empty = await readGenerativeAssetProviderInventory();
		const created = await setGenerativeAssetProvider({
			expectedInventoryFingerprint: empty.inventoryFingerprint,
			provider: {
				version: 1,
				id: "fixture-provider",
				name: "Fixture Provider",
				vendor: "Zvibe Tests",
				classification: "test-fixture",
				modalities: ["image", "sprite", "material", "animation", "audio"],
				hostPlatforms: [process.platform],
				transport: { kind: "executable", executable: "node", args: ["${PROJECT}/fixture.mjs", "${REQUEST}", "${OUTPUT}"], credentialEnvironments: ["ZVIBE_TEST_TOKEN"] },
			},
		});
		expect(created).toMatchObject({ created: true, provider: { id: "fixture-provider", classification: "test-fixture", executableAvailable: true } });
		expect(created.provider.warnings).toEqual(expect.arrayContaining([expect.stringContaining("never evidence of AI")]));
		const manifest = await readFile(join(directory, ".zvibe/generative-providers/fixture-provider.json"), "utf8");
		expect(manifest).toContain("ZVIBE_TEST_TOKEN");
		expect(manifest).not.toContain(process.env.ZVIBE_TEST_TOKEN ?? "definitely-not-present");
		await expect(setGenerativeAssetProvider({ expectedInventoryFingerprint: empty.inventoryFingerprint, provider: JSON.parse(manifest) })).rejects.toThrow(
			/inventory changed/i
		);
		const replaced = await setGenerativeAssetProvider({
			expectedInventoryFingerprint: created.inventoryFingerprint,
			expectedProviderFingerprint: created.provider.fingerprint,
			provider: { ...JSON.parse(manifest), name: "Renamed Fixture" },
		});
		expect(replaced).toMatchObject({ created: false, provider: { name: "Renamed Fixture" } });
		await expect(
			deleteGenerativeAssetProvider({
				id: "fixture-provider",
				expectedInventoryFingerprint: replaced.inventoryFingerprint,
				expectedProviderFingerprint: replaced.provider.fingerprint,
				confirm: false,
			})
		).rejects.toThrow(/confirm=true/i);
		const deleted = await deleteGenerativeAssetProvider({
			id: "fixture-provider",
			expectedInventoryFingerprint: replaced.inventoryFingerprint,
			expectedProviderFingerprint: replaced.provider.fingerprint,
			confirm: true,
		});
		expect(deleted).toMatchObject({ deleted: true, id: "fixture-provider" });
		expect((await readGenerativeAssetProviderInventory()).providers).toEqual([]);
	});

	test("isolates malformed, symlinked, duplicate, and credential-bearing provider inputs", async () => {
		const providerDirectory = join(directory, ".zvibe/generative-providers");
		await ensureDir(providerDirectory);
		const valid = {
			version: 1,
			id: "valid-provider",
			name: "Valid",
			vendor: "Tests",
			classification: "procedural",
			modalities: ["image"],
			hostPlatforms: [],
			transport: { kind: "http", endpoint: "http://127.0.0.1:4567/generate", authorizationEnvironment: null, headers: {} },
		};
		await writeJSON(join(providerDirectory, "valid.json"), valid);
		await writeJSON(join(providerDirectory, "duplicate.json"), valid);
		await writeJSON(join(providerDirectory, "unsafe.json"), { ...valid, id: "unsafe", transport: { kind: "http", endpoint: "https://user:secret@example.com/generate" } });
		await symlink(join(providerDirectory, "valid.json"), join(providerDirectory, "linked.json"));
		const inventory = await readGenerativeAssetProviderInventory();
		expect(inventory.providers).toHaveLength(1);
		expect(inventory.providers[0]).toMatchObject({ id: "valid-provider", classification: "procedural", available: true });
		expect(inventory.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ error: expect.stringContaining("Duplicate") }),
				expect.objectContaining({ path: expect.stringContaining("unsafe.json"), error: expect.stringContaining("credentials") }),
				expect.objectContaining({ path: expect.stringContaining("linked.json"), error: expect.stringContaining("cannot be a symlink") }),
			])
		);
	});

	test("rejects a symlinked provider directory and an exact write through it", async () => {
		const target = join(directory, "providers-outside");
		await ensureDir(target);
		await ensureDir(join(directory, ".zvibe"));
		await symlink(target, join(directory, ".zvibe/generative-providers"), "dir");
		const inventory = await readGenerativeAssetProviderInventory();
		expect(inventory.providers).toEqual([]);
		expect(inventory.errors).toEqual([expect.objectContaining({ path: ".zvibe/generative-providers", error: expect.stringContaining("cannot be a symbolic link") })]);
		await expect(
			setGenerativeAssetProvider({
				expectedInventoryFingerprint: inventory.inventoryFingerprint,
				provider: {
					version: 1,
					id: "blocked",
					name: "Blocked",
					vendor: "Tests",
					classification: "test-fixture",
					modalities: ["image"],
					hostPlatforms: [],
					transport: { kind: "executable", executable: "node", args: [], credentialEnvironments: [] },
				},
			})
		).rejects.toThrow(/symbolic link/i);
	});

	test("bounds manifest bytes and ignores non-JSON files", async () => {
		const providerDirectory = join(directory, ".zvibe/generative-providers");
		await ensureDir(providerDirectory);
		await writeFile(join(providerDirectory, "README.md"), "not a provider");
		await writeFile(join(providerDirectory, "huge.json"), Buffer.alloc(64 * 1024 + 1, 65));
		const inventory = await readGenerativeAssetProviderInventory();
		expect(inventory.providers).toEqual([]);
		expect(inventory.errors).toEqual([expect.objectContaining({ path: expect.stringContaining("huge.json"), error: expect.stringContaining("64 KiB") })]);
	});
});
