import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

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

	test("length-safely rewrites 32-bit and 64-bit binary FBX plus nested 3DS chunk references", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "model.fbx"), makeBinaryFbx("texture.png"));
		const nested = makeNestedBinaryFbx("texture.png");
		await writeFile(join(directory, "assets", "model-wide.fbx"), nested.buffer);
		await writeFile(join(directory, "assets", "model-ascii.fbx"), 'Texture: "texture.png"\nRelativeFilename: "ignored.png"\n');
		await writeFile(join(directory, "assets", "model.3ds"), makeTexture3ds("texture.png"));
		await rebuildAssetRegistry();
		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/moved/texture.png" });
		expect(plan.blockers).toEqual([]);
		expect(plan.rewrites).toHaveLength(4);
		expect(plan.rewrites).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "assets/model.fbx", kind: "fbx", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model-wide.fbx", kind: "fbx", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model-ascii.fbx", kind: "fbx", replacementCount: 1 }),
				expect.objectContaining({ path: "assets/model.3ds", kind: "3ds", replacementCount: 1 }),
			])
		);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await rebuildAssetRegistry();
		for (const model of ["model.fbx", "model-wide.fbx", "model-ascii.fbx", "model.3ds"]) {
			expect((await getIndexedAssetDependencies(`assets/${model}`)).dependencies, model).toEqual(["assets/moved/texture.png"]);
		}
		expect((await readFile(join(directory, "assets", "model-wide.fbx"))).subarray(-nested.footer.length)).toEqual(nested.footer);
	});

	test("rewrites binary FBX and 3DS members while rebuilding a compound archive", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(
			join(directory, "assets", "models.zip"),
			writeRewritableArchive({
				format: "zip",
				comment: "",
				members: [archiveMember("model.fbx", ""), archiveMember("model.3ds", "")],
			})
		);
		const archive = await readRewritableArchive(join(directory, "assets", "models.zip"));
		archive.members.find((member) => member.storagePath === "model.fbx")!.data = makeBinaryFbx("assets/texture.png", 7500);
		archive.members.find((member) => member.storagePath === "model.3ds")!.data = makeTexture3ds("assets/texture.png");
		await writeFile(join(directory, "assets", "models.zip"), writeRewritableArchive(archive));
		await rebuildAssetRegistry();

		const plan = await inspectSemanticAssetMove({ sourcePath: "assets/texture.png", destinationPath: "assets/moved/texture.png" });
		expect(plan).toMatchObject({ blockers: [], totalReplacementCount: 2 });
		expect(plan.rewrites).toEqual([expect.objectContaining({ path: "assets/models.zip", kind: "archive", archiveFormat: "zip", archiveMemberCount: 2 })]);
		await applySemanticAssetMove({ sourcePath: plan.sourcePath, destinationPath: plan.destinationPath, expectedPlanFingerprint: plan.planFingerprint });
		await rebuildAssetRegistry();
		const dependencies = await getIndexedAssetDependencies("assets/models.zip");
		expect(dependencies.containerDependencies.filter((dependency: { external: boolean }) => dependency.external)).toEqual([
			{ sourcePath: "model.3ds", targetPath: "assets/moved/texture.png", missing: false, external: true },
			{ sourcePath: "model.fbx", targetPath: "assets/moved/texture.png", missing: false, external: true },
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
