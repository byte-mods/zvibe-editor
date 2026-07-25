import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join, relative } from "path";

const renameFailure = vi.hoisted(() => ({ destinationSuffix: "" }));

vi.mock("fs-extra", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs-extra")>();
	return {
		...actual.default,
		...actual,
		rename: async (source: string, destination: string): Promise<void> => {
			if (renameFailure.destinationSuffix && source.endsWith(".asset-move.tmp") && destination.endsWith(renameFailure.destinationSuffix)) {
				throw new Error("Injected semantic move write failure");
			}
			return actual.rename(source, destination);
		},
	};
});

import { applySemanticAssetMove, inspectSemanticAssetMove } from "../../src/mcp/assets/move";
import { IRewritableArchiveMember, readRewritableArchive, writeRewritableArchive } from "../../src/mcp/assets/archive-rewrite";
import { getIndexedAssetDependencies, rebuildAssetRegistry } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";

function makeGlb(jsonValue: unknown, binary = Buffer.from([1, 2, 3, 4])): Buffer {
	const json = Buffer.from(JSON.stringify(jsonValue));
	const jsonPadding = (4 - (json.length % 4)) % 4;
	const paddedJson = Buffer.concat([json, Buffer.alloc(jsonPadding, 0x20)]);
	const body = Buffer.alloc(8 + paddedJson.length + 8 + binary.length);
	body.writeUInt32LE(paddedJson.length, 0);
	body.writeUInt32LE(0x4e4f534a, 4);
	paddedJson.copy(body, 8);
	const binaryOffset = 8 + paddedJson.length;
	body.writeUInt32LE(binary.length, binaryOffset);
	body.writeUInt32LE(0x004e4942, binaryOffset + 4);
	binary.copy(body, binaryOffset + 8);
	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x46546c67, 0);
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(header.length + body.length, 8);
	return Buffer.concat([header, body]);
}

function parseGlb(buffer: Buffer): { json: any; binary: Buffer } {
	const jsonLength = buffer.readUInt32LE(12);
	const json = JSON.parse(
		buffer
			.subarray(20, 20 + jsonLength)
			.toString("utf-8")
			.trimEnd()
	);
	const binaryHeader = 20 + jsonLength;
	const binaryLength = buffer.readUInt32LE(binaryHeader);
	return { json, binary: buffer.subarray(binaryHeader + 8, binaryHeader + 8 + binaryLength) };
}

function makeBinaryFbx(reference: string, versionNumber = 7400): Buffer {
	const magic = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
	const version = Buffer.alloc(4);
	version.writeUInt32LE(versionNumber);
	const wide = versionNumber >= 7500;
	const headerBytes = wide ? 25 : 13;
	const name = Buffer.from("Texture");
	const bytes = Buffer.from(reference);
	const property = Buffer.alloc(5);
	property[0] = "S".charCodeAt(0);
	property.writeUInt32LE(bytes.length, 1);
	const properties = Buffer.concat([property, bytes]);
	const nodeHeader = Buffer.alloc(headerBytes);
	const nodeEnd = magic.length + version.length + nodeHeader.length + name.length + properties.length + headerBytes;
	if (wide) {
		nodeHeader.writeBigUInt64LE(BigInt(nodeEnd), 0);
		nodeHeader.writeBigUInt64LE(1n, 8);
		nodeHeader.writeBigUInt64LE(BigInt(properties.length), 16);
		nodeHeader[24] = name.length;
	} else {
		nodeHeader.writeUInt32LE(nodeEnd, 0);
		nodeHeader.writeUInt32LE(1, 4);
		nodeHeader.writeUInt32LE(properties.length, 8);
		nodeHeader[12] = name.length;
	}
	return Buffer.concat([magic, version, nodeHeader, name, properties, Buffer.alloc(headerBytes)]);
}

function makeNestedBinaryFbx(reference: string): { buffer: Buffer; footer: Buffer } {
	const magic = Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary");
	const version = Buffer.alloc(4);
	version.writeUInt32LE(7500);
	const headerBytes = 25;
	const parentName = Buffer.from("Material");
	const childName = Buffer.from("Texture");
	const value = Buffer.from(reference);
	const property = Buffer.alloc(5);
	property[0] = "S".charCodeAt(0);
	property.writeUInt32LE(value.length, 1);
	const properties = Buffer.concat([property, value]);
	const parentStart = magic.length + version.length;
	const childStart = parentStart + headerBytes + parentName.length;
	const childEnd = childStart + headerBytes + childName.length + properties.length;
	const parentEnd = childEnd + headerBytes;
	const parentHeader = Buffer.alloc(headerBytes);
	parentHeader.writeBigUInt64LE(BigInt(parentEnd), 0);
	parentHeader[24] = parentName.length;
	const childHeader = Buffer.alloc(headerBytes);
	childHeader.writeBigUInt64LE(BigInt(childEnd), 0);
	childHeader.writeBigUInt64LE(1n, 8);
	childHeader.writeBigUInt64LE(BigInt(properties.length), 16);
	childHeader[24] = childName.length;
	const footer = Buffer.from("preserved-fbx-footer");
	return {
		buffer: Buffer.concat([magic, version, parentHeader, parentName, childHeader, childName, properties, Buffer.alloc(headerBytes), Buffer.alloc(headerBytes), footer]),
		footer,
	};
}

function makeChunk3ds(id: number, payload: Buffer): Buffer {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(id, 0);
	header.writeUInt32LE(payload.length + 6, 2);
	return Buffer.concat([header, payload]);
}

function makeTexture3ds(path: string): Buffer {
	return makeChunk3ds(0x4d4d, makeChunk3ds(0x3d3d, makeChunk3ds(0xafff, makeChunk3ds(0xa200, makeChunk3ds(0xa300, Buffer.from(`${path}\0`))))));
}

function makeMs3d(texture: string, alphaMap = "", footer = Buffer.alloc(0)): Buffer {
	const header = Buffer.alloc(22);
	header.write("MS3D000000", 0, "ascii");
	header.writeInt32LE(4, 10);
	header.writeUInt16LE(1, 20);
	const material = Buffer.alloc(361);
	material.write(texture, 105, 128, "utf-8");
	material.write(alphaMap, 233, 128, "utf-8");
	return Buffer.concat([header, material, footer]);
}

function makeB3d(texture: string, marker = Buffer.from("preserved-b3d-chunk")): Buffer {
	const chunk = (tag: string, payload: Buffer): Buffer => {
		const header = Buffer.alloc(8);
		header.write(tag, 0, 4, "ascii");
		header.writeUInt32LE(payload.length, 4);
		return Buffer.concat([header, payload]);
	};
	const version = Buffer.alloc(4);
	version.writeInt32LE(1);
	const transform = Buffer.from(Array.from({ length: 28 }, (_, index) => index));
	return chunk("BB3D", Buffer.concat([version, chunk("TEXS", Buffer.concat([Buffer.from(`${texture}\0`), transform])), chunk("TEST", marker)]));
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

function makeLwo(formType: "LWOB" | "LWO2" | "LWO3", chunks: Buffer[]): Buffer {
	const body = Buffer.concat([Buffer.from(formType, "ascii"), ...chunks]);
	const header = Buffer.alloc(8);
	header.write("FORM", 0, 4, "ascii");
	header.writeUInt32BE(body.length, 4);
	return Buffer.concat([header, body]);
}

function makeLwo2Texture(path: string): Buffer {
	const index = Buffer.alloc(4);
	index.writeUInt32BE(1);
	return makeLwo("LWO2", [
		makeLwoChunk("CLIP", Buffer.concat([index, makeLwoChunk("STIL", makeLwoString(path), 2, 0x6d), makeLwoChunk("TEXT", Buffer.from("preserved-lwo-marker"), 2)])),
	]);
}

function makeLwo3Texture(path: string): Buffer {
	const index = Buffer.alloc(4);
	index.writeUInt32BE(1);
	const clip = Buffer.concat([index, makeLwoChunk("STIL", makeLwoString(path), 4, 0x72)]);
	return makeLwo("LWO3", [makeLwoChunk("FORM", Buffer.concat([Buffer.from("CLIP", "ascii"), clip]))]);
}

function makeLwobTexture(path: string): Buffer {
	return makeLwo("LWOB", [
		makeLwoChunk("SURF", Buffer.concat([makeLwoString("Default"), makeLwoChunk("CTEX", makeLwoString("Planar Image Map"), 2), makeLwoChunk("TIMG", makeLwoString(path), 2)])),
	]);
}

function makeLwoSequence(prefix: string, suffix: string): Buffer {
	const index = Buffer.alloc(4);
	index.writeUInt32BE(1);
	const header = Buffer.alloc(10);
	header.writeUInt8(4, 0);
	header.writeInt16BE(0, 2);
	header.writeInt16BE(1, 6);
	header.writeInt16BE(2, 8);
	return makeLwo("LWO2", [makeLwoChunk("CLIP", Buffer.concat([index, makeLwoChunk("ISEQ", Buffer.concat([header, makeLwoString(prefix), makeLwoString(suffix)]), 2)]))]);
}

function makeDxf(reference: string, lineEnding = "\r\n"): Buffer {
	const pairs: Array<[number, string]> = [
		[0, "SECTION"],
		[2, "BLOCKS"],
		[0, "BLOCK"],
		[70, "4"],
		[1, reference],
		[0, "ENDBLK"],
		[0, "ENDSEC"],
		[0, "SECTION"],
		[2, "OBJECTS"],
		[0, "IMAGEDEF"],
		[1, ` ${reference}\t`],
		[0, "PDFDEFINITION"],
		[1, reference],
		[0, "TEXT"],
		[1, "assets/preserved-dxf-marker.png"],
		[0, "ENDSEC"],
		[0, "EOF"],
	];
	return Buffer.from(`${pairs.flatMap(([code, value]) => [String(code), value]).join(lineEnding)}${lineEnding}`, "utf-8");
}

function makeBlend(reference: string): Buffer {
	const countedStrings = (values: string[]): Buffer => {
		const count = Buffer.alloc(4);
		count.writeUInt32LE(values.length);
		const strings = Buffer.concat(values.map((value) => Buffer.from(`${value}\0`, "utf-8")));
		return Buffer.concat([count, strings, Buffer.alloc((4 - (strings.length & 3)) & 3)]);
	};
	const lengths = Buffer.alloc(6);
	[1, 8, 136].forEach((length, index) => lengths.writeUInt16LE(length, index * 2));
	const structureCount = Buffer.alloc(4);
	structureCount.writeUInt32LE(1);
	const structure = Buffer.alloc(12);
	structure.writeUInt16LE(2, 0);
	structure.writeUInt16LE(2, 2);
	structure.writeUInt16LE(0, 4);
	structure.writeUInt16LE(0, 6);
	structure.writeUInt16LE(1, 8);
	structure.writeUInt16LE(1, 10);
	const dna = Buffer.concat([
		Buffer.from("SDNANAME", "ascii"),
		countedStrings(["name[128]", "*packedfile"]),
		Buffer.from("TYPE", "ascii"),
		countedStrings(["char", "PackedFile", "Image"]),
		Buffer.from("TLEN", "ascii"),
		lengths,
		Buffer.alloc(2),
		Buffer.from("STRC", "ascii"),
		structureCount,
		structure,
	]);
	const block = (code: string, payload: Buffer, sdnaIndex: number, count: number): Buffer => {
		const header = Buffer.alloc(24);
		header.write(code, 0, Math.min(4, code.length), "ascii");
		header.writeUInt32LE(payload.length, 4);
		header.writeUInt32LE(sdnaIndex, 16);
		header.writeUInt32LE(count, 20);
		return Buffer.concat([header, payload]);
	};
	const image = Buffer.alloc(136);
	image.write(reference, 0, 127, "utf-8");
	return Buffer.concat([Buffer.from("BLENDER-v300", "ascii"), block("IM", image, 0, 1), block("DNA1", dna, 0, 1), block("ENDB", Buffer.alloc(0), 0, 0)]);
}

function makeTar(path: string, value: string): Buffer {
	const data = Buffer.from(value);
	const header = Buffer.alloc(512);
	header.write(path, 0, 100, "utf-8");
	header.write("0000644\0", 100, 8, "ascii");
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
	header.write("00000000000\0", 136, 12, "ascii");
	header.fill(0x20, 148, 156);
	header[156] = "0".charCodeAt(0);
	const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512), Buffer.alloc(1024)]);
}

function archiveMember(storagePath: string, value: string, semanticPath = storagePath): IRewritableArchiveMember {
	return {
		storagePath,
		semanticPath,
		data: Buffer.from(value),
		directory: false,
		mode: 0o644,
		uid: 0,
		gid: 0,
		modifiedAtSeconds: 0,
		dosTime: 0,
		externalAttributes: 0,
		comment: "",
	};
}

describe("semantic asset moves", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-semantic-asset-move-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
		renameFailure.destinationSuffix = "";
	});

	afterEach(async () => {
		renameFailure.destinationSuffix = "";
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("leases the exact plan, preserves GUIDs, rewrites values, and never rewrites JSON keys or prefix lookalikes", async () => {
		await mkdir(join(directory, "assets", "old"), { recursive: true });
		await mkdir(join(directory, "assets", "scenes"), { recursive: true });
		await writeFile(join(directory, "assets", "old", "tree.glb"), "mesh");
		await writeFile(join(directory, "assets", "old", "tree.glb.bjsmeta.json"), JSON.stringify({ guid: "tree-guid", labels: [], importer: {} }));
		const scenePath = join(directory, "assets", "scenes", "scene.json");
		await writeFile(scenePath, JSON.stringify({ "assets/old/tree.glb": "key stays", mesh: "../old/tree.glb?lod=1", root: "assets/old/tree.glb" }));
		await writeFile(join(directory, "assets", "use.ts"), 'const mesh = "assets/old/tree.glb"; const backup = "assets/old/tree.glb.backup";');
		await rebuildAssetRegistry();

		const first = await inspectSemanticAssetMove({ sourcePath: "assets/old/tree.glb", destinationPath: "assets/new/tree.glb" });
		expect(first).toMatchObject({ sourceGuid: "tree-guid", blockers: [], totalReplacementCount: 3, unchangedReferenceCount: 0 });
		expect(first.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
		await writeFile(scenePath, JSON.stringify({ mesh: "assets/other.glb" }));
		await expect(
			applySemanticAssetMove({ sourcePath: first.sourcePath, destinationPath: first.destinationPath, expectedPlanFingerprint: first.planFingerprint })
		).rejects.toThrow("plan changed");
		expect(await pathExists(join(directory, "assets", "old", "tree.glb"))).toBe(true);

		await writeFile(scenePath, JSON.stringify({ "assets/old/tree.glb": "key stays", mesh: "../old/tree.glb?lod=1", root: "assets/old/tree.glb" }));
		const current = await inspectSemanticAssetMove({ sourcePath: first.sourcePath, destinationPath: first.destinationPath });
		await applySemanticAssetMove({ sourcePath: current.sourcePath, destinationPath: current.destinationPath, expectedPlanFingerprint: current.planFingerprint });
		const scene = await readJSON(scenePath);
		expect(scene).toEqual({ "assets/old/tree.glb": "key stays", mesh: "../new/tree.glb?lod=1", root: "assets/new/tree.glb" });
		expect(await readFile(join(directory, "assets", "use.ts"), "utf-8")).toContain('"assets/new/tree.glb"');
		expect(await readFile(join(directory, "assets", "use.ts"), "utf-8")).toContain('"assets/old/tree.glb.backup"');
		expect(await readJSON(join(directory, "assets", "new", "tree.glb.bjsmeta.json"))).toMatchObject({ guid: "tree-guid" });
	});

	test("rewrites GLB JSON URIs while preserving binary chunks", async () => {
		const binary = Buffer.from([9, 8, 7, 6]);
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.glb"), makeGlb({ asset: { version: "2.0" }, images: [{ uri: "texture.png" }] }, binary));
		await rebuildAssetRegistry();
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/textures/texture.png" });
		expect(plan).toMatchObject({ blockers: [], totalReplacementCount: 1 });
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		const parsed = parseGlb(await readFile(join(directory, "assets", "model.glb")));
		expect(parsed.json.images[0].uri).toBe("textures/texture.png");
		expect(parsed.binary).toEqual(binary);
	});

	test("normalizes a relative open-project path before registry and move containment checks", async () => {
		projectConfiguration.path = relative(process.cwd(), join(directory, "Game.bjseditor"));
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.ms3d"), makeMs3d("texture.png"));
		await rebuildAssetRegistry();
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/texture-moved.png" });
		expect(plan).toMatchObject({ blockers: [], totalReplacementCount: 1, rewrites: [expect.objectContaining({ path: "assets/model.ms3d", kind: "ms3d" })] });
	});

	test("accepts unchanged relative references when a whole folder moves", async () => {
		await mkdir(join(directory, "assets", "package"), { recursive: true });
		await writeFile(join(directory, "assets", "package", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "package", "model.gltf"), JSON.stringify({ asset: { version: "2.0" }, images: [{ uri: "texture.png" }] }));
		await rebuildAssetRegistry();
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/package", destinationPath: "assets/moved/package" });
		expect(plan).toMatchObject({ blockers: [], rewrites: [], totalReplacementCount: 0, unchangedReferenceCount: 1 });
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		expect((await readJSON(join(directory, "assets", "moved", "package", "model.gltf"))).images[0].uri).toBe("texture.png");
	});

	test("rewrites indexed external references inside ZIP, TAR, TAR/GZip, and Unity packages", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		const scene = JSON.stringify({ texture: "assets/texture.png", internal: "local.png" });
		await writeFile(
			join(directory, "assets", "package.zip"),
			writeRewritableArchive({
				format: "zip",
				comment: "zip-comment",
				members: [
					archiveMember("scene.json", scene),
					archiveMember("local.png", "local"),
					archiveMember("assets/scenes/collision.json", JSON.stringify({ external: "assets/texture.png", relativeInternal: "../texture.png" })),
					archiveMember("assets/texture.png", "archive-local"),
				],
			})
		);
		await writeFile(
			join(directory, "assets", "package.tar"),
			writeRewritableArchive({ format: "tar", comment: "", members: [archiveMember("scene.json", scene), archiveMember("local.png", "local")] })
		);
		await writeFile(
			join(directory, "assets", "package.tgz"),
			writeRewritableArchive({ format: "tarGzip", comment: "", members: [archiveMember("scene.json", scene), archiveMember("local.png", "local")] })
		);
		const guid = "0123456789abcdef0123456789abcdef";
		await writeFile(
			join(directory, "assets", "package.unitypackage"),
			writeRewritableArchive({
				format: "unityPackage",
				comment: "",
				members: [archiveMember(`${guid}/pathname`, "Assets/scene.json"), archiveMember(`${guid}/asset`, scene)],
			})
		);
		await rebuildAssetRegistry();

		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/moved/texture.png" });
		expect(plan.blockers).toEqual([]);
		expect(plan.totalReplacementCount).toBe(5);
		expect(plan.rewrites.map((rewrite) => [rewrite.path, rewrite.kind, rewrite.archiveFormat, rewrite.archiveMemberCount])).toEqual([
			["assets/package.tar", "archive", "tar", 1],
			["assets/package.tgz", "archive", "tarGzip", 1],
			["assets/package.unitypackage", "archive", "unityPackage", 1],
			["assets/package.zip", "archive", "zip", 2],
		]);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });

		for (const name of ["package.zip", "package.tar", "package.tgz", "package.unitypackage"]) {
			const archive = await readRewritableArchive(join(directory, "assets", name));
			const member = archive.members.find((candidate) => candidate.semanticPath === "scene.json" || candidate.semanticPath === "assets/scene.json");
			expect(member, name).toBeDefined();
			expect(JSON.parse(member!.data.toString("utf-8")), name).toEqual({ texture: "assets/moved/texture.png", internal: "local.png" });
		}
		const zip = await readRewritableArchive(join(directory, "assets", "package.zip"));
		const collision = zip.members.find((member) => member.semanticPath === "assets/scenes/collision.json")!;
		expect(JSON.parse(collision.data.toString("utf-8"))).toEqual({ external: "assets/moved/texture.png", relativeInternal: "../texture.png" });
	});

	test("length-safely rewrites FBX, 3DS, MS3D, B3D, and DirectX text/binary references", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.fbx"), makeBinaryFbx("texture.png"));
		const nested = makeNestedBinaryFbx("texture.png");
		await writeFile(join(directory, "assets", "model-wide.fbx"), nested.buffer);
		await writeFile(join(directory, "assets", "model-ascii.fbx"), 'Texture: "texture.png"\nRelativeFilename: "ignored.png"\n');
		await writeFile(join(directory, "assets", "model.3ds"), makeTexture3ds("texture.png"));
		const ms3dFooter = Buffer.from("preserved-ms3d-animation-extension");
		await writeFile(join(directory, "assets", "model.ms3d"), makeMs3d("texture.png", "", ms3dFooter));
		const b3dMarker = Buffer.from("preserved-b3d-marker");
		await writeFile(join(directory, "assets", "model.b3d"), makeB3d("texture.png", b3dMarker));
		await writeFile(join(directory, "assets", "model-text.x"), makeXText("texture.png"));
		await writeFile(join(directory, "assets", "model-binary.x"), makeXBinary("texture.png"));
		await rebuildAssetRegistry();
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/moved/texture.png" });
		expect(plan.blockers).toEqual([]);
		expect(plan.rewrites).toHaveLength(8);
		expect(plan.rewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "assets/model.fbx", kind: "fbx", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model-wide.fbx", kind: "fbx", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model-ascii.fbx", kind: "fbx", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model.3ds", kind: "3ds", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model.ms3d", kind: "ms3d", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model.b3d", kind: "b3d", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model-text.x", kind: "x", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model-binary.x", kind: "x", replacementCount: 1 }),
			])
		);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await rebuildAssetRegistry();
		for (const model of ["model.fbx", "model-wide.fbx", "model-ascii.fbx", "model.3ds", "model.ms3d", "model.b3d", "model-text.x", "model-binary.x"]) {
			expect((await getIndexedAssetDependencies(`assets/${model}`)).dependencies, model).toEqual(["assets/moved/texture.png"]);
		}
		expect((await readFile(join(directory, "assets", "model-wide.fbx"))).subarray(-nested.footer.length)).toEqual(nested.footer);
		expect((await readFile(join(directory, "assets", "model.ms3d"))).subarray(-ms3dFooter.length)).toEqual(ms3dFooter);
		expect((await readFile(join(directory, "assets", "model.b3d"))).includes(b3dMarker)).toBe(true);
		const textX = await readFile(join(directory, "assets", "model-text.x"), "utf-8");
		expect(textX).toContain('TextureFilename { "moved/texture.png"; }');
		expect(textX).toContain('Metadata { "texture.png"; }');
		const binaryX = await readFile(join(directory, "assets", "model-binary.x"));
		expect(binaryX.includes(Buffer.from("moved/texture.png\0"))).toBe(true);
		expect(binaryX.includes(Buffer.from("texture.png\0"))).toBe(true);
	});

	test("length-safely rewrites LWOB, LWO2, and FORM-wrapped LWO3 texture sources", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "legacy.lwo"), makeLwobTexture("texture.png"));
		await writeFile(join(directory, "assets", "modern.lwo"), makeLwo2Texture("texture.png"));
		await writeFile(join(directory, "assets", "new.lwo"), makeLwo3Texture("texture.png"));
		await rebuildAssetRegistry();

		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/textures/longer-texture-name.png" });
		expect(plan.blockers).toEqual([]);
		expect(plan.rewrites).toEqual([
			expect.objectContaining({ path: "assets/legacy.lwo", kind: "lwo", replacementCount: 1 }),
			expect.objectContaining({ path: "assets/modern.lwo", kind: "lwo", replacementCount: 1 }),
			expect.objectContaining({ path: "assets/new.lwo", kind: "lwo", replacementCount: 1 }),
		]);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await rebuildAssetRegistry();
		for (const model of ["legacy.lwo", "modern.lwo", "new.lwo"]) {
			expect((await getIndexedAssetDependencies(`assets/${model}`)).dependencies, model).toEqual(["assets/textures/longer-texture-name.png"]);
		}
		expect((await readFile(join(directory, "assets", "modern.lwo"))).includes(Buffer.from("preserved-lwo-marker"))).toBe(true);
	});

	test("rewrites a complete LWO ISEQ directory move and blocks an unrepresentable single-frame move", async () => {
		await mkdir(join(directory, "assets", "sequence"), { recursive: true });
		await writeFile(join(directory, "assets", "sequence", "frame0001.png"), "one");
		await writeFile(join(directory, "assets", "sequence", "frame0002.png"), "two");
		await writeFile(join(directory, "assets", "sequence.lwo"), makeLwoSequence("sequence/frame", ".png"));
		await rebuildAssetRegistry();

		const partial = await inspectSemanticAssetMove({ sourcePath: "assets/sequence/frame0001.png", destinationPath: "assets/single/frame0001.png" });
		expect(partial.rewrites).toEqual([]);
		expect(partial.blockers).toEqual([
			expect.objectContaining({ path: "assets/sequence.lwo", kind: "lwo", reason: "semanticMismatch", message: expect.stringContaining("complete sequence") }),
		]);
		expect(await pathExists(join(directory, "assets", "sequence", "frame0001.png"))).toBe(true);

		const complete = await inspectSemanticAssetMove({ sourcePath: "assets/sequence", destinationPath: "assets/moved-sequence" });
		expect(complete.blockers).toEqual([]);
		expect(complete.rewrites).toEqual([expect.objectContaining({ path: "assets/sequence.lwo", kind: "lwo", replacementCount: 2 })]);
		await applySemanticAssetMove({ sourcePath: complete.sourcePath, destinationPath: complete.destinationPath, expectedPlanFingerprint: complete.planFingerprint });
		await rebuildAssetRegistry();
		expect((await getIndexedAssetDependencies("assets/sequence.lwo")).dependencies).toEqual(["assets/moved-sequence/frame0001.png", "assets/moved-sequence/frame0002.png"]);
	});

	test("length-safely rewrites only semantic ASCII DXF external-reference records", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "drawing.dxf"), makeDxf("assets/texture.png", "\n"));
		await rebuildAssetRegistry();

		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/textures/longer-texture-name.png" });
		expect(plan.blockers).toEqual([]);
		expect(plan.rewrites).toEqual([expect.objectContaining({ path: "assets/drawing.dxf", kind: "dxf", replacementCount: 3 })]);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await rebuildAssetRegistry();

		expect((await getIndexedAssetDependencies("assets/drawing.dxf")).dependencies).toEqual(["assets/textures/longer-texture-name.png"]);
		const text = await readFile(join(directory, "assets", "drawing.dxf"), "utf-8");
		expect(text).toContain("\n assets/textures/longer-texture-name.png\t\n");
		expect(text).toContain("\nassets/preserved-dxf-marker.png\n");
		expect(text).not.toContain("\r\n");
	});

	test("rewrites Blender project-file-relative SDNA paths while preserving the double-slash convention", async () => {
		await mkdir(join(directory, "assets", "models", "textures"), { recursive: true });
		await writeFile(join(directory, "assets", "models", "textures", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "models", "scene.blend"), makeBlend("//textures/texture.png"));
		await rebuildAssetRegistry();

		const plan = await inspectSemanticAssetMove({
			sourcePath: "assets/models/textures/texture.png",
			destinationPath: "assets/models/materials/longer-texture-name.png",
		});
		expect(plan.blockers).toEqual([]);
		expect(plan.rewrites).toEqual([expect.objectContaining({ path: "assets/models/scene.blend", kind: "blend", replacementCount: 1 })]);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await rebuildAssetRegistry();

		expect((await getIndexedAssetDependencies("assets/models/scene.blend")).dependencies).toEqual(["assets/models/materials/longer-texture-name.png"]);
		expect((await readFile(join(directory, "assets", "models", "scene.blend"))).includes(Buffer.from("//materials/longer-texture-name.png\0"))).toBe(true);
	});

	test("rewrites binary FBX, 3DS, MS3D, B3D, DirectX, LightWave, ASCII DXF, and Blender members while rebuilding a compound archive", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(
			join(directory, "assets", "models.zip"),
			writeRewritableArchive({
				format: "zip",
				comment: "",
				members: [
					archiveMember("model.fbx", ""),
					archiveMember("model.3ds", ""),
					archiveMember("model.ms3d", ""),
					archiveMember("model.b3d", ""),
					archiveMember("model-text.x", ""),
					archiveMember("model-binary.x", ""),
					archiveMember("legacy.lwo", ""),
					archiveMember("modern.lwo", ""),
					archiveMember("drawing.dxf", ""),
					archiveMember("scene.blend", ""),
				],
			})
		);
		const archive = await readRewritableArchive(join(directory, "assets", "models.zip"));
		archive.members.find((member) => member.storagePath === "model.fbx")!.data = makeBinaryFbx("assets/texture.png", 7500);
		archive.members.find((member) => member.storagePath === "model.3ds")!.data = makeTexture3ds("assets/texture.png");
		archive.members.find((member) => member.storagePath === "model.ms3d")!.data = makeMs3d("assets/texture.png");
		archive.members.find((member) => member.storagePath === "model.b3d")!.data = makeB3d("assets/texture.png");
		archive.members.find((member) => member.storagePath === "model-text.x")!.data = makeXText("assets/texture.png");
		archive.members.find((member) => member.storagePath === "model-binary.x")!.data = makeXBinary("assets/texture.png");
		archive.members.find((member) => member.storagePath === "legacy.lwo")!.data = makeLwobTexture("assets/texture.png");
		archive.members.find((member) => member.storagePath === "modern.lwo")!.data = makeLwo3Texture("assets/texture.png");
		archive.members.find((member) => member.storagePath === "drawing.dxf")!.data = makeDxf("assets/texture.png");
		archive.members.find((member) => member.storagePath === "scene.blend")!.data = makeBlend("assets/texture.png");
		await writeFile(join(directory, "assets", "models.zip"), writeRewritableArchive(archive));
		await rebuildAssetRegistry();

		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/moved/texture.png" });
		expect(plan).toMatchObject({ blockers: [], totalReplacementCount: 12 });
		expect(plan.rewrites).toEqual([expect.objectContaining({ path: "assets/models.zip", kind: "archive", archiveFormat: "zip", archiveMemberCount: 10 })]);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await rebuildAssetRegistry();
		const dependencies = await getIndexedAssetDependencies("assets/models.zip");
		expect(dependencies.containerDependencies.filter((dependency: { external: boolean }) => dependency.external)).toEqual([
			{ sourcePath: "drawing.dxf", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "legacy.lwo", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "model-binary.x", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "model-text.x", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "model.3ds", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "model.b3d", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "model.fbx", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "model.ms3d", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "modern.lwo", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "scene.blend", targetPath: "assets/moved/texture.png", missing: false, external: true },
		]);
	});

	test("turns a stale malformed binary referencer into an explicit blocker instead of guessing a rewrite", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.fbx"), makeBinaryFbx("texture.png"));
		await rebuildAssetRegistry();
		await writeFile(join(directory, "assets", "model.fbx"), Buffer.from("Kaydara FBX Binary  \0\x1a\0", "binary"));

		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/moved/texture.png" });
		expect(plan.rewrites).toEqual([]);
		expect(plan.blockers).toEqual([expect.objectContaining({ path: "assets/model.fbx", kind: "fbx", reason: "malformed" })]);
		await expect(applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint })).rejects.toThrow(
			"unsupported or unsafe"
		);
		expect(await pathExists(join(directory, "assets", "texture.png"))).toBe(true);
	});

	test("blocks a stale malformed B3D chunk table without changing the referenced asset", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.b3d"), makeB3d("texture.png"));
		await rebuildAssetRegistry();
		await writeFile(join(directory, "assets", "model.b3d"), Buffer.from("BB3D\x40\0\0\0", "binary"));
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/texture-moved.png" });
		expect(plan.rewrites).toEqual([]);
		expect(plan.blockers).toEqual([expect.objectContaining({ path: "assets/model.b3d", kind: "b3d", reason: "malformed" })]);
		expect(await pathExists(join(directory, "assets", "texture.png"))).toBe(true);
	});

	test("blocks a stale compressed DirectX referencer instead of treating its bytes as text", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.x"), makeXText("texture.png"));
		await rebuildAssetRegistry();
		await writeFile(join(directory, "assets", "model.x"), Buffer.from("xof 0303tzip0032compressed", "ascii"));
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/texture-moved.png" });
		expect(plan.rewrites).toEqual([]);
		expect(plan.blockers).toEqual([
			expect.objectContaining({ path: "assets/model.x", kind: "x", reason: "malformed", message: expect.stringContaining("compressed or unsupported") }),
		]);
		expect(await pathExists(join(directory, "assets", "texture.png"))).toBe(true);
	});

	test("blocks a stale malformed LWO FORM instead of scanning arbitrary bytes", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.lwo"), makeLwo2Texture("texture.png"));
		await rebuildAssetRegistry();
		await writeFile(join(directory, "assets", "model.lwo"), Buffer.from("FORM\0\0\0\x40LWO2", "binary"));
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/texture-moved.png" });
		expect(plan.rewrites).toEqual([]);
		expect(plan.blockers).toEqual([expect.objectContaining({ path: "assets/model.lwo", kind: "lwo", reason: "malformed", message: expect.stringContaining("declares") })]);
		expect(await pathExists(join(directory, "assets", "texture.png"))).toBe(true);
	});

	test("blocks a stale binary DXF referencer instead of scanning arbitrary group-1 strings", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "drawing.dxf"), makeDxf("assets/texture.png"));
		await rebuildAssetRegistry();
		await writeFile(join(directory, "assets", "drawing.dxf"), Buffer.from("AutoCAD Binary DXF\r\n\x1a\0", "binary"));

		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/texture-moved.png" });
		expect(plan.rewrites).toEqual([]);
		expect(plan.blockers).toEqual([
			expect.objectContaining({ path: "assets/drawing.dxf", kind: "dxf", reason: "malformed", message: expect.stringContaining("Binary DXF is unsupported") }),
		]);
		expect(await pathExists(join(directory, "assets", "texture.png"))).toBe(true);
	});

	test("blocks MS3D moves when the rewritten UTF-8 path cannot fit its fixed 128-byte material field", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.ms3d"), makeMs3d("texture.png"));
		await rebuildAssetRegistry();
		const destinationPath = `assets/${"nested-".repeat(19)}texture.png`;
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath });
		expect(plan.rewrites).toEqual([]);
		expect(plan.blockers).toEqual([
			expect.objectContaining({ path: "assets/model.ms3d", kind: "ms3d", reason: "malformed", message: expect.stringContaining("127 UTF-8 bytes") }),
		]);
		await expect(applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint })).rejects.toThrow(
			"unsupported or unsafe"
		);
		expect(await pathExists(join(directory, "assets", "texture.png"))).toBe(true);
	});

	test("rolls back the asset, sidecar, and already-written references when a later atomic write fails", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "texture.png.bjsmeta.json"), JSON.stringify({ guid: "rollback-guid", labels: [], importer: {} }));
		await writeFile(join(directory, "assets", "a.json"), JSON.stringify({ texture: "assets/texture.png" }));
		await writeFile(join(directory, "assets", "model.fbx"), makeBinaryFbx("texture.png"));
		await writeFile(join(directory, "assets", "package.tar"), makeTar("scene.json", JSON.stringify({ texture: "assets/texture.png" })));
		await writeFile(join(directory, "assets", "z.json"), JSON.stringify({ texture: "assets/texture.png" }));
		await rebuildAssetRegistry();
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/moved/texture.png" });
		renameFailure.destinationSuffix = "/assets/z.json";
		await expect(applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint })).rejects.toThrow(
			"Injected semantic move write failure"
		);
		expect(await readFile(join(directory, "assets", "texture.png"), "utf-8")).toBe("texture");
		expect(await readJSON(join(directory, "assets", "texture.png.bjsmeta.json"))).toMatchObject({ guid: "rollback-guid" });
		expect(await readJSON(join(directory, "assets", "a.json"))).toEqual({ texture: "assets/texture.png" });
		expect(await readJSON(join(directory, "assets", "z.json"))).toEqual({ texture: "assets/texture.png" });
		expect((await readFile(join(directory, "assets", "model.fbx"))).includes(Buffer.from("texture.png"))).toBe(true);
		expect((await readFile(join(directory, "assets", "model.fbx"))).includes(Buffer.from("moved/texture.png"))).toBe(false);
		const archive = await readRewritableArchive(join(directory, "assets", "package.tar"));
		expect(JSON.parse(archive.members[0].data.toString("utf-8"))).toEqual({ texture: "assets/texture.png" });
		expect(await pathExists(join(directory, "assets", "moved", "texture.png"))).toBe(false);
	});
});
