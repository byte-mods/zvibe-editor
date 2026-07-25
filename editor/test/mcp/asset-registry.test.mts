import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, pathExists, readJSON, remove, truncate, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync, zstdCompressSync } from "zlib";

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
import {
	extractBlendReferences,
	extractDxfReferences,
	extractLwoReferences,
	inspectBlendFile,
	rewriteBlendReferences,
	rewriteDxfReferences,
	rewriteLwoReferences,
} from "../../src/mcp/assets/binary-model-rewrite";
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

function makeMs3d(texture: string, alphaMap = ""): Buffer {
	const header = Buffer.alloc(22);
	header.write("MS3D000000", 0, "ascii");
	header.writeInt32LE(4, 10);
	header.writeUInt16LE(1, 20);
	const material = Buffer.alloc(361);
	material.write(texture, 105, 128, "utf-8");
	material.write(alphaMap, 233, 128, "utf-8");
	return Buffer.concat([header, material]);
}

function makeB3d(texture: string): Buffer {
	const chunk = (tag: string, payload: Buffer): Buffer => {
		const header = Buffer.alloc(8);
		header.write(tag, 0, 4, "ascii");
		header.writeUInt32LE(payload.length, 4);
		return Buffer.concat([header, payload]);
	};
	const version = Buffer.alloc(4);
	version.writeInt32LE(1);
	const textureRecord = Buffer.concat([Buffer.from(`${texture}\0`), Buffer.alloc(28)]);
	return chunk("BB3D", Buffer.concat([version, chunk("TEXS", textureRecord)]));
}

function makeXText(texture: string, unrelated = texture): Buffer {
	return Buffer.from(`xof 0303txt 0032\nTextureFilename { "${texture}"; }\nMetadata { "${unrelated}"; }\n`, "utf-8");
}

function makeXBinary(texture: string, unrelated = texture): Buffer {
	const name = (value: string): Buffer => {
		const bytes = Buffer.from(value, "ascii");
		const header = Buffer.alloc(6);
		header.writeUInt16LE(1, 0);
		header.writeUInt32LE(bytes.length, 2);
		return Buffer.concat([header, bytes]);
	};
	const string = (value: string): Buffer => {
		const bytes = Buffer.from(`${value}\0`, "utf-8");
		const header = Buffer.alloc(6);
		header.writeUInt16LE(2, 0);
		header.writeUInt32LE(bytes.length, 2);
		const terminator = Buffer.alloc(4);
		terminator.writeUInt32LE(20);
		return Buffer.concat([header, bytes, terminator]);
	};
	const token = (value: number): Buffer => {
		const result = Buffer.alloc(2);
		result.writeUInt16LE(value);
		return result;
	};
	return Buffer.concat([
		Buffer.from("xof 0303bin 0032", "ascii"),
		token(31),
		name("TextureFilename"),
		token(10),
		string("template-ignored.png"),
		token(11),
		name("TextureFilename"),
		token(10),
		string(texture),
		token(11),
		name("Metadata"),
		token(10),
		string(unrelated),
		token(11),
	]);
}

function makeLwoString(value: string): Buffer {
	const terminated = Buffer.from(`${value}\0`, "utf-8");
	return terminated.length & 1 ? Buffer.concat([terminated, Buffer.from([0])]) : terminated;
}

function makeLwoChunk(tag: string, payload: Buffer, lengthBytes: 2 | 4 = 4, padByte = 0): Buffer {
	const header = Buffer.alloc(4 + lengthBytes);
	header.write(tag, 0, 4, "ascii");
	if (lengthBytes === 2) {
		header.writeUInt16BE(payload.length, 4);
	} else {
		header.writeUInt32BE(payload.length, 4);
	}
	return payload.length & 1 ? Buffer.concat([header, payload, Buffer.from([padByte])]) : Buffer.concat([header, payload]);
}

function makeLwo(formType: "LWOB" | "LWO2" | "LWO3" | "LXOB", chunks: Buffer[]): Buffer {
	const body = Buffer.concat([Buffer.from(formType, "ascii"), ...chunks]);
	const header = Buffer.alloc(8);
	header.write("FORM", 0, 4, "ascii");
	header.writeUInt32BE(body.length, 4);
	return Buffer.concat([header, body]);
}

function makeLwo2Clip(sourceTag: string, sourcePayload: Buffer, formType: "LWO2" | "LXOB" = "LWO2"): Buffer {
	const index = Buffer.alloc(4);
	index.writeUInt32BE(1);
	const ignored = makeLwoChunk("TEXT", makeLwoString("assets/ignored-lwo.png"), 2, 0x5a);
	return makeLwo(formType, [
		makeLwoChunk("CLIP", Buffer.concat([index, makeLwoChunk(sourceTag, sourcePayload, 2), ignored])),
		makeLwoChunk("TEXT", makeLwoString("assets/ignored-root.png")),
	]);
}

function makeLwo3Clip(path: string): Buffer {
	const index = Buffer.alloc(4);
	index.writeUInt32BE(1);
	const clip = Buffer.concat([index, makeLwoChunk("STIL", makeLwoString(path), 4, 0x7f)]);
	return makeLwo("LWO3", [makeLwoChunk("FORM", Buffer.concat([Buffer.from("CLIP", "ascii"), clip]))]);
}

function makeLwobTexture(path: string): Buffer {
	const surface = Buffer.concat([makeLwoString("Default"), makeLwoChunk("CTEX", makeLwoString("Planar Image Map"), 2), makeLwoChunk("TIMG", makeLwoString(path), 2)]);
	return makeLwo("LWOB", [makeLwoChunk("SURF", surface)]);
}

function makeLwoSequence(prefix: string, suffix: string, start = 1, end = 2): Buffer {
	const header = Buffer.alloc(10);
	header.writeUInt8(4, 0);
	header.writeInt16BE(0, 2);
	header.writeInt16BE(start, 6);
	header.writeInt16BE(end, 8);
	return makeLwo2Clip("ISEQ", Buffer.concat([header, makeLwoString(prefix), makeLwoString(suffix)]));
}

function makeDxf(
	references: { block: string; image: string; underlay: string; coordination: string } = {
		block: "assets/reference.dxf",
		image: "assets/image.png",
		underlay: "assets/sheet.pdf",
		coordination: "assets/model.nwd",
	},
	lineEnding = "\r\n"
): Buffer {
	const pairs: Array<[number, string]> = [
		[0, "SECTION"],
		[2, "BLOCKS"],
		[0, "BLOCK"],
		[2, "External"],
		[70, "4"],
		[1, references.block],
		[0, "ENDBLK"],
		[0, "ENDSEC"],
		[0, "SECTION"],
		[2, "OBJECTS"],
		[0, "IMAGEDEF"],
		[1, `  ${references.image}\t`],
		[0, "PDFDEFINITION"],
		[1, references.underlay],
		[0, "AcDbNavisworksModelDef"],
		[1, references.coordination],
		[0, "TEXT"],
		[1, "assets/ignored-dxf.png"],
		[0, "ENDSEC"],
		[0, "EOF"],
	];
	return Buffer.from(`${pairs.flatMap(([code, value]) => [String(code), value]).join(lineEnding)}${lineEnding}`, "utf-8");
}

function makeBlend(images: Array<{ path: string; packed?: boolean }>, movieClips: string[] = [], version = 300): Buffer {
	const names = ["name[128]", "*packedfile"];
	const types = ["char", "PackedFile", "Image", "MovieClip"];
	const typeLengths = [1, 8, 136, 128];
	const countedStrings = (values: string[]): Buffer => {
		const count = Buffer.alloc(4);
		count.writeUInt32LE(values.length);
		const strings = Buffer.concat(values.map((value) => Buffer.from(`${value}\0`, "utf-8")));
		return Buffer.concat([count, strings, Buffer.alloc((4 - (strings.length & 3)) & 3)]);
	};
	const lengths = Buffer.alloc(typeLengths.length * 2);
	typeLengths.forEach((length, index) => lengths.writeUInt16LE(length, index * 2));
	const structureCount = Buffer.alloc(4);
	structureCount.writeUInt32LE(2);
	const imageStructure = Buffer.alloc(12);
	imageStructure.writeUInt16LE(2, 0);
	imageStructure.writeUInt16LE(2, 2);
	imageStructure.writeUInt16LE(0, 4);
	imageStructure.writeUInt16LE(0, 6);
	imageStructure.writeUInt16LE(1, 8);
	imageStructure.writeUInt16LE(1, 10);
	const movieClipStructure = Buffer.alloc(8);
	movieClipStructure.writeUInt16LE(3, 0);
	movieClipStructure.writeUInt16LE(1, 2);
	movieClipStructure.writeUInt16LE(0, 4);
	movieClipStructure.writeUInt16LE(0, 6);
	const dna = Buffer.concat([
		Buffer.from("SDNANAME", "ascii"),
		countedStrings(names),
		Buffer.from("TYPE", "ascii"),
		countedStrings(types),
		Buffer.from("TLEN", "ascii"),
		lengths,
		Buffer.alloc((4 - (lengths.length & 3)) & 3),
		Buffer.from("STRC", "ascii"),
		structureCount,
		imageStructure,
		movieClipStructure,
	]);
	const block = (code: string, payload: Buffer, sdnaIndex: number, count: number): Buffer => {
		const header = Buffer.alloc(24);
		header.write(code, 0, Math.min(4, code.length), "ascii");
		header.writeUInt32LE(payload.length, 4);
		header.writeUInt32LE(sdnaIndex, 16);
		header.writeUInt32LE(count, 20);
		return Buffer.concat([header, payload]);
	};
	const imagePayload = Buffer.concat(
		images.map(({ path, packed }) => {
			const value = Buffer.alloc(136);
			value.write(path, 0, 127, "utf-8");
			if (packed) value.writeBigUInt64LE(1n, 128);
			return value;
		})
	);
	const moviePayload = Buffer.concat(
		movieClips.map((path) => {
			const value = Buffer.alloc(128);
			value.write(path, 0, 127, "utf-8");
			return value;
		})
	);
	return Buffer.concat([
		Buffer.from(`BLENDER-v${String(version).padStart(3, "0")}`, "ascii"),
		...(images.length ? [block("IM", imagePayload, 0, images.length)] : []),
		...(movieClips.length ? [block("MC", moviePayload, 1, movieClips.length)] : []),
		block("DNA1", dna, 0, 1),
		block("ENDB", Buffer.alloc(0), 0, 0),
	]);
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
		expect(definitions.map((definition) => definition.kind)).toEqual(["text", "glb", "fbx", "3ds", "ms3d", "b3d", "x", "lwo", "dxf", "blend", "archive"]);
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

	test("indexes bounded binary-model and DirectX text/binary texture references, then resolves missing targets incrementally", async () => {
		await writeFile(join(projectDirectory, "assets", "model.fbx"), makeBinaryFbx(["fbx-texture.png", "../../outside.png", "https://example.com/remote.png"]));
		await writeFile(join(projectDirectory, "assets", "model.3ds"), makeTexture3ds("three-texture.png"));
		await writeFile(join(projectDirectory, "assets", "model.ms3d"), makeMs3d("milk-texture.png", "milk-alpha.png"));
		await writeFile(join(projectDirectory, "assets", "model.b3d"), makeB3d("blitz-texture.png"));
		await writeFile(join(projectDirectory, "assets", "model-text.x"), makeXText("x-texture.png", "ignored-text.png"));
		await writeFile(join(projectDirectory, "assets", "model-binary.x"), makeXBinary("x-binary-texture.png", "ignored-binary.png"));
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
		expect(await getIndexedAssetDependencies("assets/model.ms3d")).toMatchObject({
			dependencyScanKind: "ms3d",
			dependencyScanStatus: "complete",
			missingDependencies: ["assets/milk-alpha.png", "assets/milk-texture.png"],
		});
		expect(await getIndexedAssetDependencies("assets/model.b3d")).toMatchObject({
			dependencyScanKind: "b3d",
			dependencyScanStatus: "complete",
			missingDependencies: ["assets/blitz-texture.png"],
		});
		expect(await getIndexedAssetDependencies("assets/model-text.x")).toMatchObject({
			dependencyScanKind: "x",
			dependencyScanStatus: "complete",
			missingDependencies: ["assets/x-texture.png"],
		});
		expect(await getIndexedAssetDependencies("assets/model-binary.x")).toMatchObject({
			dependencyScanKind: "x",
			dependencyScanStatus: "complete",
			missingDependencies: ["assets/x-binary-texture.png"],
		});

		const fbxTexture = join(projectDirectory, "assets", "fbx-texture.png");
		const threeTexture = join(projectDirectory, "assets", "three-texture.png");
		const milkTexture = join(projectDirectory, "assets", "milk-texture.png");
		const milkAlpha = join(projectDirectory, "assets", "milk-alpha.png");
		const blitzTexture = join(projectDirectory, "assets", "blitz-texture.png");
		const xTexture = join(projectDirectory, "assets", "x-texture.png");
		const xBinaryTexture = join(projectDirectory, "assets", "x-binary-texture.png");
		await writeFile(fbxTexture, "fbx");
		await writeFile(threeTexture, "3ds");
		await writeFile(milkTexture, "ms3d");
		await writeFile(milkAlpha, "alpha");
		await writeFile(blitzTexture, "b3d");
		await writeFile(xTexture, "x-text");
		await writeFile(xBinaryTexture, "x-binary");
		await refreshAssetRegistryPaths([fbxTexture, threeTexture, milkTexture, milkAlpha, blitzTexture, xTexture, xBinaryTexture]);
		expect((await getIndexedAssetDependencies("assets/model.fbx")).dependencies).toEqual(["assets/fbx-texture.png"]);
		expect((await getIndexedAssetDependencies("assets/model.3ds")).dependencies).toEqual(["assets/three-texture.png"]);
		expect((await getIndexedAssetDependencies("assets/model.ms3d")).dependencies).toEqual(["assets/milk-alpha.png", "assets/milk-texture.png"]);
		expect((await getIndexedAssetDependencies("assets/model.b3d")).dependencies).toEqual(["assets/blitz-texture.png"]);
		expect((await getIndexedAssetDependencies("assets/model-text.x")).dependencies).toEqual(["assets/x-texture.png"]);
		expect((await getIndexedAssetDependencies("assets/model-binary.x")).dependencies).toEqual(["assets/x-binary-texture.png"]);
	});

	test("indexes exact LWOB, LWO2, LWO3, LXOB, and bounded image-sequence references", async () => {
		await writeFile(join(projectDirectory, "assets", "legacy.lwo"), makeLwobTexture("legacy.png"));
		await writeFile(join(projectDirectory, "assets", "modern.lwo"), makeLwo2Clip("STIL", makeLwoString("modern.png")));
		await writeFile(join(projectDirectory, "assets", "modo.lwo"), makeLwo2Clip("STCC", Buffer.concat([Buffer.alloc(4), makeLwoString("modo.png")]), "LXOB"));
		await writeFile(
			join(projectDirectory, "assets", "plugin.lwo"),
			makeLwo2Clip("ANIM", Buffer.concat([makeLwoString("plugin.mov"), makeLwoString("Loader"), Buffer.alloc(2)]))
		);
		await writeFile(join(projectDirectory, "assets", "new.lwo"), makeLwo3Clip("new.png"));
		await writeFile(join(projectDirectory, "assets", "sequence.lwo"), makeLwoSequence("sequence/frame", ".png"));
		await rebuildAssetRegistry();

		for (const [path, missingDependencies] of [
			["assets/legacy.lwo", ["assets/legacy.png"]],
			["assets/modern.lwo", ["assets/modern.png"]],
			["assets/modo.lwo", ["assets/modo.png"]],
			["assets/plugin.lwo", ["assets/plugin.mov"]],
			["assets/new.lwo", ["assets/new.png"]],
			["assets/sequence.lwo", ["assets/sequence/frame0001.png", "assets/sequence/frame0002.png"]],
		] as const) {
			expect(await getIndexedAssetDependencies(path)).toMatchObject({ dependencyScanKind: "lwo", dependencyScanStatus: "complete", missingDependencies });
		}
		expect((await getIndexedAssetDependencies("assets/modern.lwo")).missingDependencies).not.toContain("assets/ignored-lwo.png");
		expect((await getIndexedAssetDependencies("assets/modern.lwo")).missingDependencies).not.toContain("assets/ignored-root.png");

		const source = makeLwo2Clip("STIL", makeLwoString("old.png"));
		const rewritten = rewriteLwoReferences(source, (value) => (value === "old.png" ? "textures/really-long-name.png" : null));
		expect(rewritten).toMatchObject({ replacementCount: 1, semanticMatchCount: 1 });
		expect(rewritten.error).toBeUndefined();
		expect(extractLwoReferences(rewritten.buffer)).toEqual({ values: ["textures/really-long-name.png"] });
		expect(rewritten.buffer.subarray(rewritten.buffer.length - 2)).toEqual(source.subarray(source.length - 2));
	});

	test("indexes semantic LightWave members inside bounded archives", async () => {
		await writeFile(join(projectDirectory, "assets", "shared.png"), "texture");
		await writeFile(
			join(projectDirectory, "assets", "lightwave-models.zip"),
			makeStoredZip({
				"legacy/model.lwo": makeLwobTexture("assets/shared.png"),
				"modern/model.lwo": makeLwo3Clip("assets/shared.png"),
			})
		);
		await rebuildAssetRegistry();

		const indexed = await getIndexedAssetDependencies("assets/lightwave-models.zip");
		expect(indexed).toMatchObject({ dependencyScanKind: "archive", dependencyScanStatus: "complete", dependencies: ["assets/shared.png"], containerEntryCount: 2 });
		expect(indexed.containerDependencies).toEqual([
			{ sourcePath: "legacy/model.lwo", targetPath: "assets/shared.png", missing: false, external: true },
			{ sourcePath: "modern/model.lwo", targetPath: "assets/shared.png", missing: false, external: true },
		]);
	});

	test("rejects malformed LWO padding and oversized sequences while ignoring XREF instance names", () => {
		const xrefIndex = Buffer.alloc(4);
		xrefIndex.writeUInt32BE(9);
		expect(extractLwoReferences(makeLwo2Clip("XREF", Buffer.concat([xrefIndex, makeLwoString("assets/not-a-file-reference.png")])))).toEqual({ values: [] });

		const oversizedSequence = makeLwoSequence("sequence/frame", ".png", 1, 4097);
		expect(extractLwoReferences(oversizedSequence)).toMatchObject({ values: [], error: expect.stringContaining("4,096") });

		const padded = makeLwo("LWO2", [makeLwoChunk("JUNK", Buffer.from([1, 2, 3]))]);
		const missingPad = Buffer.from(padded.subarray(0, -1));
		missingPad.writeUInt32BE(missingPad.length - 8, 4);
		expect(extractLwoReferences(missingPad)).toMatchObject({ values: [], error: expect.stringContaining("boundary") });
	});

	test("indexes and rewrites only documented ASCII DXF external-reference records", async () => {
		await writeFile(join(projectDirectory, "assets", "reference.dxf"), Buffer.from("0\nEOF\n"));
		await writeFile(join(projectDirectory, "assets", "image.png"), "texture");
		await writeFile(join(projectDirectory, "assets", "sheet.pdf"), "pdf");
		await writeFile(join(projectDirectory, "assets", "model.nwd"), "coordination");
		await writeFile(join(projectDirectory, "assets", "drawing.dxf"), makeDxf());
		await rebuildAssetRegistry();

		expect(await getIndexedAssetDependencies("assets/drawing.dxf")).toMatchObject({
			dependencyScanKind: "dxf",
			dependencyScanStatus: "complete",
			dependencies: ["assets/image.png", "assets/model.nwd", "assets/reference.dxf", "assets/sheet.pdf"],
			missingDependencies: [],
		});
		const extracted = extractDxfReferences(makeDxf());
		expect(extracted).toEqual({ values: ["assets/reference.dxf", "assets/image.png", "assets/sheet.pdf", "assets/model.nwd"] });
		expect(extracted.values).not.toContain("assets/ignored-dxf.png");

		const shared = { block: "assets/shared.png", image: "assets/shared.png", underlay: "assets/shared.png", coordination: "assets/shared.png" };
		const rewritten = rewriteDxfReferences(makeDxf(shared, "\n"), (value) => (value === "assets/shared.png" ? "assets/textures/longer-name.png" : null));
		expect(rewritten).toMatchObject({ replacementCount: 4, semanticMatchCount: 4 });
		expect(rewritten.error).toBeUndefined();
		expect(extractDxfReferences(rewritten.buffer)).toEqual({
			values: ["assets/textures/longer-name.png", "assets/textures/longer-name.png", "assets/textures/longer-name.png", "assets/textures/longer-name.png"],
		});
		expect(rewritten.buffer.toString("utf-8")).toContain("\n  assets/textures/longer-name.png\t\n");
		expect(rewritten.buffer.toString("utf-8")).toContain("\nassets/ignored-dxf.png\n");
	});

	test("indexes semantic ASCII DXF members inside archives and rejects binary DXF explicitly", async () => {
		await writeFile(join(projectDirectory, "assets", "shared.png"), "texture");
		const shared = { block: "assets/shared.png", image: "assets/shared.png", underlay: "assets/shared.png", coordination: "assets/shared.png" };
		await writeFile(join(projectDirectory, "assets", "drawings.zip"), makeStoredZip({ "models/drawing.dxf": makeDxf(shared) }));
		await writeFile(join(projectDirectory, "assets", "binary.dxf"), Buffer.from("AutoCAD Binary DXF\r\n\x1a\0", "binary"));
		await rebuildAssetRegistry();

		const archive = await getIndexedAssetDependencies("assets/drawings.zip");
		expect(archive).toMatchObject({ dependencyScanKind: "archive", dependencyScanStatus: "complete", dependencies: ["assets/shared.png"], containerEntryCount: 1 });
		expect(archive.containerDependencies).toEqual([{ sourcePath: "models/drawing.dxf", targetPath: "assets/shared.png", missing: false, external: true }]);
		expect(await getIndexedAssetDependencies("assets/binary.dxf")).toMatchObject({
			dependencyScanKind: "dxf",
			dependencyScanStatus: "malformed",
			dependencies: [],
			dependencyScanMessage: expect.stringContaining("Binary DXF is unsupported"),
		});
	});

	test("parses and fixed-width rewrites exact Blender SDNA path fields across raw, GZip, and Zstandard streams", () => {
		const raw = makeBlend([{ path: "//textures/shared.png" }, { path: "//textures/packed.png", packed: true }], ["//clips/preview.mp4"]);
		for (const [compression, source] of [
			["none", raw],
			["gzip", gzipSync(raw)],
			["zstd", zstdCompressSync(raw)],
		] as const) {
			expect(inspectBlendFile(source)).toMatchObject({ compression, version: 300, pointerSize: 8, littleEndian: true });
			expect(extractBlendReferences(source)).toEqual({ values: ["//textures/shared.png", "//clips/preview.mp4"] });
			const rewritten = rewriteBlendReferences(source, (value) => (value === "//textures/shared.png" ? "//textures/a-longer-shared-name.png" : null));
			expect(rewritten).toMatchObject({ replacementCount: 1, semanticMatchCount: 1 });
			expect(rewritten.error).toBeUndefined();
			expect(extractBlendReferences(rewritten.buffer)).toEqual({ values: ["//textures/a-longer-shared-name.png", "//clips/preview.mp4"] });
		}
		const tooLong = rewriteBlendReferences(raw, () => `//${"x".repeat(126)}`);
		expect(tooLong).toMatchObject({ replacementCount: 0, errorKind: "semanticMismatch", error: expect.stringContaining("128") });
		expect(extractBlendReferences(Buffer.from("not-a-blend"))).toMatchObject({ values: [], error: expect.stringContaining("header") });
	});

	test("indexes Blender relative resources and semantic Blender members inside archives", async () => {
		await mkdir(join(projectDirectory, "assets", "models", "textures"), { recursive: true });
		await writeFile(join(projectDirectory, "assets", "models", "textures", "shared.png"), "texture");
		await writeFile(join(projectDirectory, "assets", "models", "scene.blend"), makeBlend([{ path: "//textures/shared.png" }]));
		await writeFile(
			join(projectDirectory, "assets", "blender-models.zip"),
			makeStoredZip({
				"models/scene.blend": makeBlend([{ path: "//textures/shared.png" }]),
				"models/textures/shared.png": Buffer.from("texture"),
			})
		);
		await rebuildAssetRegistry();

		expect(await getIndexedAssetDependencies("assets/models/scene.blend")).toMatchObject({
			dependencyScanKind: "blend",
			dependencyScanStatus: "complete",
			dependencies: ["assets/models/textures/shared.png"],
			missingDependencies: [],
		});
		const archive = await getIndexedAssetDependencies("assets/blender-models.zip");
		expect(archive).toMatchObject({ dependencyScanKind: "archive", dependencyScanStatus: "complete", containerEntryCount: 2 });
		expect(archive.containerDependencies).toContainEqual({
			sourcePath: "models/scene.blend",
			targetPath: "models/textures/shared.png",
			missing: false,
			external: false,
		});
	});

	test("indexes semantic DirectX text and binary members inside bounded archives", async () => {
		await writeFile(join(projectDirectory, "assets", "shared.png"), "texture");
		await writeFile(
			join(projectDirectory, "assets", "directx-models.zip"),
			makeStoredZip({
				"text/model.x": makeXText("assets/shared.png", "assets/ignored-text.png"),
				"binary/model.x": makeXBinary("assets/shared.png", "assets/ignored-binary.png"),
			})
		);
		await rebuildAssetRegistry();
		const indexed = await getIndexedAssetDependencies("assets/directx-models.zip");
		expect(indexed).toMatchObject({ dependencyScanKind: "archive", dependencyScanStatus: "complete", containerEntryCount: 2 });
		expect(indexed.containerDependencies.filter((dependency: { external: boolean }) => dependency.external)).toEqual([
			{ sourcePath: "binary/model.x", targetPath: "assets/shared.png", missing: false, external: true },
			{ sourcePath: "text/model.x", targetPath: "assets/shared.png", missing: false, external: true },
		]);
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
		await writeFile(join(projectDirectory, "assets", "bad.ms3d"), Buffer.from("MS3D000000"));
		await writeFile(join(projectDirectory, "assets", "bad.b3d"), Buffer.from("BB3D\x40\0\0\0", "binary"));
		await writeFile(join(projectDirectory, "assets", "bad.x"), Buffer.from("xof 0303tzip0032compressed", "ascii"));
		await writeFile(join(projectDirectory, "assets", "bad.lwo"), Buffer.from("FORM\0\0\0\x20LWO2", "binary"));
		await writeFile(join(projectDirectory, "assets", "bad.dxf"), Buffer.from("0\nSECTION\n2\nENTITIES\n0\nENDSEC\n", "ascii"));
		await rebuildAssetRegistry();

		const diagnostics = await getAssetDependencyDiagnostics();
		expect(diagnostics.malformedScanCount).toBe(8);
		expect(diagnostics.malformedScans.map((item: { path: string }) => item.path)).toEqual([
			"assets/bad.3ds",
			"assets/bad.b3d",
			"assets/bad.dxf",
			"assets/bad.fbx",
			"assets/bad.glb",
			"assets/bad.lwo",
			"assets/bad.ms3d",
			"assets/bad.x",
		]);
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
