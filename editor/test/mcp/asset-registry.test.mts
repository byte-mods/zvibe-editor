import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, pathExists, readJSON, remove, truncate, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";

import {
	ASSET_REGISTRY_VERSION,
	getAssetDependencyDiagnostics,
	getAssetDependencyGraph,
	getAssetRegistryStatus,
	getIndexedAssetDependencies,
	listAssetDependencyScanners,
	queryAssetRegistry,
	rebuildAssetRegistry,
	refreshAssetRegistryPaths,
} from "../../src/mcp/assets/registry";
import { formatAssetDependencyGraph } from "../../src/mcp/assets/dependency-graph";
import { projectConfiguration } from "../../src/project/configuration";

function makeChunk3ds(id: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(id, 0);
	header.writeUInt32LE(payload.length + 6, 2);
	return Buffer.concat([header, payload]);
}

function makeTexture3ds(path: string): Buffer {
	return makeChunk3ds(0x4d4d, makeChunk3ds(0x3d3d, makeChunk3ds(0xafff, makeChunk3ds(0xa200, makeChunk3ds(0xa300, Buffer.from(`${path}\0`))))));
}

function makeBinaryFbx(strings: string[]): Buffer {
	const magic = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
	const version = Buffer.alloc(4);
	version.writeUInt32LE(7400);
	const name = Buffer.from("Texture");
	const properties = Buffer.concat(
		strings.map((value) => {
			const bytes = Buffer.from(value);
			const header = Buffer.alloc(5);
			header[0] = "S".charCodeAt(0);
			header.writeUInt32LE(bytes.length, 1);
			return Buffer.concat([header, bytes]);
		})
	);
	const nodeHeader = Buffer.alloc(13);
	const nodeEnd = magic.length + version.length + nodeHeader.length + name.length + properties.length + 13;
	nodeHeader.writeUInt32LE(nodeEnd, 0);
	nodeHeader.writeUInt32LE(strings.length, 4);
	nodeHeader.writeUInt32LE(properties.length, 8);
	nodeHeader[12] = name.length;
	return Buffer.concat([magic, version, nodeHeader, name, properties, Buffer.alloc(13)]);
}

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makeStoredZip(files: Record<string, string | Buffer>): Buffer {
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(files)) {
		const nameBytes = Buffer.from(name);
		const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
		const checksum = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(0, 8);
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		localParts.push(local, nameBytes, data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, nameBytes);
		offset += local.length + nameBytes.length + data.length;
	}
	const centralDirectory = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(centralDirectory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, centralDirectory, end]);
}

function makeTar(files: Record<string, string | Buffer>): Buffer {
	const parts: Buffer[] = [];
	for (const [name, value] of Object.entries(files)) {
		const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
		const header = Buffer.alloc(512);
		header.write(name, 0, 100, "utf-8");
		header.write("0000644\0", 100, 8, "ascii");
		header.write("0000000\0", 108, 8, "ascii");
		header.write("0000000\0", 116, 8, "ascii");
		header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
		header.write("00000000000\0", 136, 12, "ascii");
		header.fill(0x20, 148, 156);
		header[156] = "0".charCodeAt(0);
		header.write("ustar\0", 257, 6, "ascii");
		const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	parts.push(Buffer.alloc(1024));
	return Buffer.concat(parts);
}

describe("persistent asset registry", () => {
	let projectDirectory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		projectDirectory = await mkdtemp(join(tmpdir(), "babylon-asset-registry-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(projectDirectory, "assets"));
		await mkdir(join(projectDirectory, "src"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(projectDirectory);
	});

	test("atomically indexes assets/src with stable sidecars and content fingerprints", async () => {
		await writeFile(join(projectDirectory, "assets", "tree.glb"), "mesh bytes");
		await writeFile(join(projectDirectory, "src", "player.ts"), "export class Player {}");

		const first = await rebuildAssetRegistry();
		expect(first.version).toBe(ASSET_REGISTRY_VERSION);
		expect(first.entries.map((entry) => [entry.path, entry.type])).toEqual([
			["assets/tree.glb", "mesh"],
			["src/player.ts", "script"],
		]);
		expect(first.entries.every((entry) => entry.contentHash?.length === 64)).toBe(true);
		expect(await pathExists(join(projectDirectory, "assets", "tree.glb.bjsmeta.json"))).toBe(true);
		const guid = first.entries[0].guid;
		const second = await rebuildAssetRegistry();
		expect(second.entries[0].guid).toBe(guid);
		expect((await readJSON(join(projectDirectory, ".bjseditor", "asset-registry.json"))).version).toBe(ASSET_REGISTRY_VERSION);
	});

	test("excludes dependency, build, cache, and metadata trees from absolute project scans", async () => {
		for (const folder of ["node_modules/package", "build/chunks", ".next/cache", ".bjseditor/cache", "public/scene/generated"]) {
			await mkdir(join(projectDirectory, folder), { recursive: true });
			await writeFile(join(projectDirectory, folder, "ignored.js"), "ignored");
		}
		await writeFile(join(projectDirectory, "assets", "kept.js"), "kept");
		const registry = await rebuildAssetRegistry();
		expect(registry.entries.map((entry) => entry.path)).toEqual(["assets/kept.js"]);
	});

	test("migrates legacy sidecars without replacing GUIDs and queries tags, favorites, and import status", async () => {
		const path = join(projectDirectory, "assets", "legacy.png");
		await writeFile(path, "legacy");
		await writeFile(`${path}.bjsmeta.json`, JSON.stringify({ guid: "legacy-guid", labels: ["build"], importer: { maxSize: 512 } }));
		const registry = await rebuildAssetRegistry();
		expect(registry.entries[0]).toMatchObject({
			guid: "legacy-guid",
			tags: [],
			favorite: false,
			importer: { version: 1, kind: "texture", settings: { maxSize: 512 } },
			importState: { status: "native" },
		});
		expect(await readJSON(`${path}.bjsmeta.json`)).toMatchObject({ guid: "legacy-guid", importer: { version: 1, kind: "texture", settings: { maxSize: 512 } } });
		expect(await queryAssetRegistry({ favorite: false, importStatus: "native" })).toMatchObject({ totalCount: 1 });
	});

	test("diagnoses duplicate GUIDs and only repairs them with explicit rebuild mode", async () => {
		await writeFile(join(projectDirectory, "assets", "a.png"), "a");
		await writeFile(join(projectDirectory, "assets", "b.png"), "b");
		const metadata = JSON.stringify({ guid: "legacy-shared-guid", labels: [], importer: {} });
		await writeFile(join(projectDirectory, "assets", "a.png.bjsmeta.json"), metadata);
		await writeFile(join(projectDirectory, "assets", "b.png.bjsmeta.json"), metadata);

		const diagnostic = await rebuildAssetRegistry();
		expect(diagnostic.duplicateGuids).toEqual([{ guid: "legacy-shared-guid", paths: ["assets/a.png", "assets/b.png"] }]);
		const repaired = await rebuildAssetRegistry({ repairDuplicateGuids: true });
		expect(repaired.duplicateGuids).toEqual([]);
		expect(repaired.entries[0].guid).toBe("legacy-shared-guid");
		expect(repaired.entries[1].guid).not.toBe("legacy-shared-guid");
	});

	test("incrementally adds, updates, removes, and queries bounded registry entries", async () => {
		const texturePath = join(projectDirectory, "assets", "hero.png");
		await writeFile(texturePath, "v1");
		await mkdir(join(projectDirectory, "assets", "nested"));
		await writeFile(join(projectDirectory, "assets", "nested", "nested.png"), "nested");
		await rebuildAssetRegistry();
		await writeFile(texturePath, "v2");
		await refreshAssetRegistryPaths([texturePath]);
		const query = await queryAssetRegistry({ query: "hero", type: "texture", limit: 1 });
		expect(query).toMatchObject({ totalCount: 1, hasMore: false });
		expect(query.entries[0]).toMatchObject({ path: "assets/hero.png", sizeBytes: 2 });
		expect((await queryAssetRegistry({ folder: "assets", recursive: false })).entries.map((entry: { path: string }) => entry.path)).toEqual(["assets/hero.png"]);
		await remove(texturePath);
		await refreshAssetRegistryPaths([texturePath]);
		expect(await getAssetRegistryStatus()).toMatchObject({ entryCount: 1, duplicateGuidCount: 0 });
	});

	test("atomically migrates a stale registry version before processing a watcher refresh", async () => {
		await writeFile(join(projectDirectory, "assets", "existing.png"), "existing");
		await rebuildAssetRegistry();
		const registryPath = join(projectDirectory, ".bjseditor", "asset-registry.json");
		const stale = await readJSON(registryPath);
		stale.version = ASSET_REGISTRY_VERSION - 1;
		stale.entries.push({ ...stale.entries[0], path: "node_modules/stale/ignored.js", guid: "ignored-guid" });
		await writeJSON(registryPath, stale);
		const added = join(projectDirectory, "assets", "added.png");
		await writeFile(added, "added");

		await refreshAssetRegistryPaths([added]);
		expect((await queryAssetRegistry({ type: "texture" })).entries.map((entry: { path: string }) => entry.path)).toEqual(["assets/added.png", "assets/existing.png"]);
		expect((await readJSON(registryPath)).version).toBe(ASSET_REGISTRY_VERSION);
		expect((await readJSON(registryPath)).entries.some((entry: { path: string }) => entry.path.startsWith("node_modules/"))).toBe(false);
	});

	test("persists forward, reverse, missing, and incrementally resolved dependency edges", async () => {
		await writeFile(join(projectDirectory, "assets", "scene.json"), JSON.stringify({ mesh: "assets/tree.glb", missing: "assets/missing.png" }));
		await writeFile(join(projectDirectory, "assets", "tree.glb"), "mesh");
		await rebuildAssetRegistry();

		const forward = await getAssetDependencyGraph({ path: "assets/scene.json", depth: 2 });
		expect(forward.edges).toEqual([
			{ sourcePath: "assets/scene.json", targetPath: "assets/tree.glb", missing: false, cyclic: false },
			{ sourcePath: "assets/scene.json", targetPath: "assets/missing.png", missing: true, cyclic: false },
		]);
		expect(forward.nodes).toEqual(
			expect.arrayContaining([expect.objectContaining({ path: "assets/scene.json", depth: 0 }), expect.objectContaining({ path: "assets/tree.glb", depth: 1 })])
		);
		const reverse = await getAssetDependencyGraph({ path: "assets/tree.glb", direction: "referencedBy" });
		expect(reverse.edges).toEqual([{ sourcePath: "assets/scene.json", targetPath: "assets/tree.glb", missing: false, cyclic: false }]);
		expect(await getAssetDependencyDiagnostics()).toMatchObject({ missingReferenceCount: 1, cycleCount: 0 });

		const missingPath = join(projectDirectory, "assets", "missing.png");
		await writeFile(missingPath, "now present");
		await refreshAssetRegistryPaths([missingPath]);
		expect(await getAssetDependencyDiagnostics()).toMatchObject({ missingReferenceCount: 0 });
		expect((await getAssetDependencyGraph({ path: "assets/scene.json" })).edges).toEqual([
			{ sourcePath: "assets/scene.json", targetPath: "assets/missing.png", missing: false, cyclic: false },
			{ sourcePath: "assets/scene.json", targetPath: "assets/tree.glb", missing: false, cyclic: false },
		]);
	});

	test("annotates visible cycles and exports deterministic DOT and Mermaid graph text", async () => {
		await writeFile(join(projectDirectory, "assets", "a.json"), JSON.stringify({ next: "assets/b.json" }));
		await writeFile(join(projectDirectory, "assets", "b.json"), JSON.stringify({ next: "assets/a.json" }));
		await rebuildAssetRegistry();

		const graph = await getAssetDependencyGraph({ path: "assets/a.json", depth: 4 });
		expect(graph.cycles).toEqual([["assets/a.json", "assets/b.json", "assets/a.json"]]);
		expect(graph.edges).toEqual([
			{ sourcePath: "assets/a.json", targetPath: "assets/b.json", missing: false, cyclic: true },
			{ sourcePath: "assets/b.json", targetPath: "assets/a.json", missing: false, cyclic: true },
		]);
		expect(formatAssetDependencyGraph(graph, "dot")).toContain('n0 -> n1 [color="#f59e0b", penwidth="2"]');
		expect(formatAssetDependencyGraph(graph, "mermaid")).toContain("flowchart LR");
		expect(JSON.parse(formatAssetDependencyGraph(graph, "json"))).toMatchObject({ rootPath: "assets/a.json", direction: "dependencies" });
	});

	test("discovers immutable bounded scanner definitions", () => {
		const definitions = listAssetDependencyScanners();
		expect(definitions.map((definition) => definition.kind)).toEqual(["text", "glb", "fbx", "3ds", "archive"]);
		expect(definitions.find((definition) => definition.kind === "text")?.extensions).toEqual(expect.arrayContaining([".babylon", ".gltf", ".obj", ".mtl", ".dae"]));
		expect(definitions.find((definition) => definition.kind === "archive")?.extensions).toEqual([".zip", ".tar", ".tgz", ".tar.gz", ".unitypackage"]);
		expect(definitions.every((definition) => definition.maximumBytes > 0)).toBe(true);
		definitions[0].extensions.length = 0;
		expect(listAssetDependencyScanners()[0].extensions.length).toBeGreaterThan(0);
	});

	test("indexes bounded ZIP members, internal missing references, project references, cycles, and virtual graph nodes", async () => {
		await writeFile(join(projectDirectory, "assets", "shared.png"), "project texture");
		await writeFile(
			join(projectDirectory, "assets", "compound.zip"),
			makeStoredZip({
				"models/scene.gltf": JSON.stringify({ images: [{ uri: "texture.png" }, { uri: "missing.png" }, { uri: "assets/shared.png" }], extras: { next: "loop.json" } }),
				"models/texture.png": "texture",
				"models/loop.json": JSON.stringify({ back: "scene.gltf" }),
			})
		);
		await rebuildAssetRegistry();

		const dependencies = await getIndexedAssetDependencies("assets/compound.zip");
		expect(dependencies).toMatchObject({
			dependencyScanKind: "archive",
			dependencyScanStatus: "complete",
			dependencies: ["assets/shared.png"],
			containerEntryCount: 3,
			containerDependencyCount: 5,
			containerMissingDependencyCount: 1,
		});
		expect(dependencies.containerDependencies).toEqual(
			expect.arrayContaining([
				{ sourcePath: "models/scene.gltf", targetPath: "models/texture.png", missing: false, external: false },
				{ sourcePath: "models/scene.gltf", targetPath: "models/missing.png", missing: true, external: false },
				{ sourcePath: "models/scene.gltf", targetPath: "assets/shared.png", missing: false, external: true },
			])
		);

		const graph = await getAssetDependencyGraph({ path: "assets/compound.zip", depth: 3 });
		expect(graph.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "assets/compound.zip!/models/scene.gltf", virtual: true, missing: false }),
				expect.objectContaining({ path: "assets/compound.zip!/models/missing.png", virtual: true, missing: true }),
			])
		);
		expect(graph.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourcePath: "assets/compound.zip",
					targetPath: "assets/compound.zip!/models/scene.gltf",
					relationship: "contains",
				}),
				expect.objectContaining({
					sourcePath: "assets/compound.zip!/models/scene.gltf",
					targetPath: "assets/compound.zip!/models/missing.png",
					missing: true,
				}),
			])
		);
		expect(graph.cycles).toContainEqual(["assets/compound.zip!/models/loop.json", "assets/compound.zip!/models/scene.gltf", "assets/compound.zip!/models/loop.json"]);
		expect(await getAssetDependencyDiagnostics()).toMatchObject({
			archiveMissingReferenceCount: 1,
			archiveMissingReferences: [{ archivePath: "assets/compound.zip", sourceEntry: "models/scene.gltf", missingEntry: "models/missing.png" }],
		});
	});

	test("indexes TAR/GZip compound assets and reports malformed archives without aborting publication", async () => {
		const prefabGuid = "11111111111111111111111111111111";
		const materialGuid = "22222222222222222222222222222222";
		const missingGuid = "33333333333333333333333333333333";
		await writeFile(
			join(projectDirectory, "assets", "bundle.unitypackage"),
			gzipSync(
				makeTar({
					[`${prefabGuid}/pathname`]: "Assets/Prefabs/Hero.prefab",
					[`${prefabGuid}/asset`]: `%YAML 1.1\nMaterial: {fileID: 2100000, guid: ${materialGuid}, type: 2}\nMissing: {fileID: 1, guid: ${missingGuid}, type: 2}\n`,
					[`${materialGuid}/pathname`]: "Assets/Materials/Red.mat",
					[`${materialGuid}/asset`]: "%YAML 1.1\nMaterial:\n  m_Name: Red\n",
				})
			)
		);
		await writeFile(join(projectDirectory, "assets", "broken.zip"), "not a zip");
		await rebuildAssetRegistry();

		expect(await getIndexedAssetDependencies("assets/bundle.unitypackage")).toMatchObject({
			dependencyScanKind: "archive",
			dependencyScanStatus: "complete",
			containerEntryCount: 2,
			containerDependencyCount: 2,
			containerMissingDependencyCount: 1,
		});
		expect((await getIndexedAssetDependencies("assets/bundle.unitypackage")).containerDependencies).toEqual([
			{ sourcePath: "assets/Prefabs/Hero.prefab", targetPath: "assets/Materials/Red.mat", missing: false, external: false },
			{ sourcePath: "assets/Prefabs/Hero.prefab", targetPath: `GUID/${missingGuid}`, missing: true, external: false },
		]);
		expect(await getIndexedAssetDependencies("assets/broken.zip")).toMatchObject({
			dependencyScanKind: "archive",
			dependencyScanStatus: "malformed",
			dependencies: [],
			containerEntryCount: 0,
		});
		expect(await getAssetDependencyDiagnostics()).toMatchObject({ malformedScanCount: 1 });
	});

	test("rejects archive traversal and defers oversized compressed containers without extraction", async () => {
		await writeFile(join(projectDirectory, "assets", "unsafe.zip"), makeStoredZip({ "../outside.json": "{}" }));
		const oversized = join(projectDirectory, "assets", "oversized.zip");
		await writeFile(oversized, "");
		await truncate(oversized, 64 * 1024 * 1024 + 1);
		await rebuildAssetRegistry();

		expect(await getIndexedAssetDependencies("assets/unsafe.zip")).toMatchObject({
			dependencyScanKind: "archive",
			dependencyScanStatus: "malformed",
			containerEntryCount: 0,
		});
		expect(await getIndexedAssetDependencies("assets/oversized.zip")).toMatchObject({
			dependencyScanKind: "archive",
			dependencyScanStatus: "deferred",
			dependencyScanDeferred: true,
			containerEntryCount: 0,
		});
	});

	test("indexes Babylon, glTF, OBJ, MTL, and DAE model references", async () => {
		await writeFile(join(projectDirectory, "assets", "shared.png"), "texture");
		await writeFile(join(projectDirectory, "assets", "scene.gltf"), JSON.stringify({ images: [{ uri: "shared.png" }] }));
		await writeFile(join(projectDirectory, "assets", "scene.babylon"), JSON.stringify({ textures: [{ name: "shared.png" }] }));
		await writeFile(join(projectDirectory, "assets", "model.obj"), "mtllib model.mtl\n");
		await writeFile(join(projectDirectory, "assets", "model.mtl"), "map_Kd shared.png\n");
		await writeFile(join(projectDirectory, "assets", "model.dae"), "<COLLADA><library_images><image><init_from>shared.png</init_from></image></library_images></COLLADA>");
		await rebuildAssetRegistry();

		expect(await getIndexedAssetDependencies("assets/scene.gltf")).toMatchObject({
			dependencyScanKind: "text",
			dependencyScanStatus: "complete",
			dependencies: ["assets/shared.png"],
		});
		expect(await getIndexedAssetDependencies("assets/scene.babylon")).toMatchObject({ dependencies: ["assets/shared.png"] });
		expect(await getIndexedAssetDependencies("assets/model.obj")).toMatchObject({ dependencies: ["assets/model.mtl"] });
		expect(await getIndexedAssetDependencies("assets/model.mtl")).toMatchObject({ dependencies: ["assets/shared.png"] });
		expect(await getIndexedAssetDependencies("assets/model.dae")).toMatchObject({ dependencies: ["assets/shared.png"] });
	});

	test("indexes bounded binary FBX strings and 3DS texture chunks, then resolves missing targets incrementally", async () => {
		await writeFile(join(projectDirectory, "assets", "model.fbx"), makeBinaryFbx(["fbx-texture.png", "../../outside.png", "https://example.com/remote.png"]));
		await writeFile(join(projectDirectory, "assets", "model.3ds"), makeTexture3ds("three-texture.png"));
		await rebuildAssetRegistry();

		expect(await getIndexedAssetDependencies("assets/model.fbx")).toMatchObject({
			dependencyScanKind: "fbx",
			dependencyScanStatus: "complete",
			dependencies: [],
			missingDependencies: ["assets/fbx-texture.png"],
		});
		expect(await getIndexedAssetDependencies("assets/model.3ds")).toMatchObject({
			dependencyScanKind: "3ds",
			dependencyScanStatus: "complete",
			missingDependencies: ["assets/three-texture.png"],
		});

		const fbxTexture = join(projectDirectory, "assets", "fbx-texture.png");
		const threeTexture = join(projectDirectory, "assets", "three-texture.png");
		await writeFile(fbxTexture, "fbx");
		await writeFile(threeTexture, "3ds");
		await refreshAssetRegistryPaths([fbxTexture, threeTexture]);
		expect((await getIndexedAssetDependencies("assets/model.fbx")).dependencies).toEqual(["assets/fbx-texture.png"]);
		expect((await getIndexedAssetDependencies("assets/model.3ds")).dependencies).toEqual(["assets/three-texture.png"]);
	});

	test("reports malformed bounded binary dependency sources without inventing edges", async () => {
		const fbxHeader = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
		const fbxVersion = Buffer.alloc(4);
		fbxVersion.writeUInt32LE(7400);
		const invalid3ds = Buffer.alloc(6);
		invalid3ds.writeUInt16LE(0x4d4d, 0);
		invalid3ds.writeUInt32LE(100, 2);
		await writeFile(join(projectDirectory, "assets", "bad.glb"), "not a glb");
		await writeFile(join(projectDirectory, "assets", "bad.fbx"), Buffer.concat([fbxHeader, fbxVersion, Buffer.from([1])]));
		await writeFile(join(projectDirectory, "assets", "bad.3ds"), invalid3ds);
		await rebuildAssetRegistry();

		const diagnostics = await getAssetDependencyDiagnostics();
		expect(diagnostics.malformedScanCount).toBe(3);
		expect(diagnostics.malformedScans.map((item: { path: string }) => item.path)).toEqual(["assets/bad.3ds", "assets/bad.fbx", "assets/bad.glb"]);
		expect(await getIndexedAssetDependencies("assets/bad.fbx")).toMatchObject({ dependencyScanStatus: "malformed", dependencies: [], missingDependencies: [] });
	});

	test("defers oversized binary model scans without reading their sparse payload", async () => {
		const oversized = join(projectDirectory, "assets", "oversized.fbx");
		await writeFile(oversized, "");
		await truncate(oversized, 64 * 1024 * 1024 + 1);
		await rebuildAssetRegistry();
		expect(await getIndexedAssetDependencies("assets/oversized.fbx")).toMatchObject({
			dependencyScanKind: "fbx",
			dependencyScanStatus: "deferred",
			dependencyScanDeferred: true,
			dependencies: [],
		});
		expect(await getAssetRegistryStatus()).toMatchObject({ deferredDependencyScanCount: 1 });
	});

	test("diagnoses canonical dependency cycles", async () => {
		await writeFile(join(projectDirectory, "assets", "a.json"), JSON.stringify({ next: "assets/b.json" }));
		await writeFile(join(projectDirectory, "assets", "b.json"), JSON.stringify({ next: "assets/a.json" }));
		await rebuildAssetRegistry();
		expect(await getAssetDependencyDiagnostics()).toMatchObject({
			missingReferenceCount: 0,
			cycleCount: 1,
			cycles: [["assets/a.json", "assets/b.json", "assets/a.json"]],
		});
	});
});
