import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { chmod, mkdir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import {
	Animation,
	AnimationGroup,
	Bone,
	Color3,
	LoadAssetContainerAsync,
	Matrix,
	Mesh,
	MeshBuilder,
	MorphTarget,
	MorphTargetManager,
	NullEngine,
	Scene,
	SceneSerializer,
	Skeleton,
	StandardMaterial,
	TransformNode,
	Vector3,
	VertexBuffer,
	VertexData,
} from "babylonjs";
import { configureGeneratedModelLodDeformations, normalizeModelImporterSettings, serializeModelMaterialRemaps } from "babylonjs-editor-tools";

import { applyModelImporterArtifact, getModelImporterArtifactStatus, getModelMaterialExtractionStatus, processModelImporterOutput } from "../../src/mcp/assets/model-importer";
import {
	applyModelImporter,
	getModelAnimationClips,
	getModelAuthoredLods,
	getModelImporterResult,
	getModelGeneratedLods,
	getModelMaterialRemaps,
	getModelMaterialSearch,
	getModelPlatformOverrides,
	inspectModelMaterialExtraction,
	extractModelMaterials,
	inspectModelTextureExtraction,
	extractModelTextures,
	setModelAnimationClips,
	setModelAuthoredLods,
	setModelGeneratedLods,
	setModelMaterialRemaps,
	setModelMaterialSearch,
	setModelPlatformOverrides,
	setModelRigOptimization,
} from "../../src/mcp/assets/assets";
import { readAssetMetadata, refreshAssetRegistryPaths, writeAssetMetadata } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";
import { processAssetFile } from "../../src/project/export/assets";

const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/7yMKVQAAAABJRU5ErkJggg==";

function triangleGltf(): Record<string, unknown> {
	const binary = Buffer.alloc(66);
	[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => binary.writeFloatLE(value, index * 4));
	[0, 0, 1, 0, 0, 1].forEach((value, index) => binary.writeFloatLE(value, 36 + index * 4));
	[0, 1, 2].forEach((value, index) => binary.writeUInt16LE(value, 60 + index * 2));
	return {
		asset: { version: "2.0" },
		buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString("base64")}` }],
		bufferViews: [
			{ buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
			{ buffer: 0, byteOffset: 36, byteLength: 24, target: 34962 },
			{ buffer: 0, byteOffset: 60, byteLength: 6, target: 34963 },
		],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
			{ bufferView: 1, componentType: 5126, count: 3, type: "VEC2" },
			{ bufferView: 2, componentType: 5123, count: 3, type: "SCALAR" },
		],
		meshes: [{ name: "Triangle", primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
		nodes: [{ name: "TriangleRoot", mesh: 0 }],
		scenes: [{ nodes: [0] }],
		scene: 0,
	};
}

function triangleGlb(imageUri?: string): Buffer {
	const sourceDocument = triangleGltf() as { buffers: Array<{ byteLength: number; uri: string }>; meshes: Array<{ primitives: Array<Record<string, unknown>> }> } & Record<
		string,
		unknown
	>;
	if (imageUri) {
		sourceDocument.images = [{ uri: imageUri }];
		sourceDocument.textures = [{ source: 0 }];
		sourceDocument.materials = [{ name: "Textured", pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
		sourceDocument.meshes[0].primitives[0].material = 0;
	}
	const binary = Buffer.from(sourceDocument.buffers[0].uri.split(",")[1], "base64");
	const document = { ...sourceDocument, buffers: [{ byteLength: binary.length }] };
	const json = Buffer.from(JSON.stringify(document), "utf-8");
	const paddedJson = Buffer.concat([json, Buffer.alloc((4 - (json.length & 3)) & 3, 0x20)]);
	const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - (binary.length & 3)) & 3)]);
	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x46546c67, 0);
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + paddedBinary.length, 8);
	const jsonHeader = Buffer.alloc(8);
	jsonHeader.writeUInt32LE(paddedJson.length, 0);
	jsonHeader.writeUInt32LE(0x4e4f534a, 4);
	const binaryHeader = Buffer.alloc(8);
	binaryHeader.writeUInt32LE(paddedBinary.length, 0);
	binaryHeader.writeUInt32LE(0x004e4942, 4);
	return Buffer.concat([header, jsonHeader, paddedJson, binaryHeader, paddedBinary]);
}

function triangleDae(): string {
	return `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
	<asset><up_axis>Y_UP</up_axis></asset>
	<library_geometries>
		<geometry id="TriangleGeometry"><mesh>
			<source id="positions">
				<float_array id="positionValues" count="9">0 0 0 1 0 0 0 1 0</float_array>
				<technique_common><accessor source="#positionValues" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common>
			</source>
			<vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices>
			<triangles count="1"><input semantic="VERTEX" source="#vertices" offset="0"/><p>0 1 2</p></triangles>
		</mesh></geometry>
	</library_geometries>
	<library_visual_scenes><visual_scene id="Scene"><node id="Triangle"><instance_geometry url="#TriangleGeometry"/></node></visual_scene></library_visual_scenes>
	<scene><instance_visual_scene url="#Scene"/></scene>
</COLLADA>`;
}

function triangleMs3d(): Buffer {
	const parts: Buffer[] = [];
	const header = Buffer.alloc(14);
	header.write("MS3D000000", 0, "ascii");
	header.writeInt32LE(4, 10);
	parts.push(header);
	const vertexCount = Buffer.alloc(2);
	vertexCount.writeUInt16LE(3);
	parts.push(vertexCount);
	for (const [x, y, z] of [
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
	]) {
		const vertex = Buffer.alloc(15);
		vertex.writeFloatLE(x, 1);
		vertex.writeFloatLE(y, 5);
		vertex.writeFloatLE(z, 9);
		vertex.writeInt8(-1, 13);
		vertex.writeUInt8(1, 14);
		parts.push(vertex);
	}
	const triangleCount = Buffer.alloc(2);
	triangleCount.writeUInt16LE(1);
	parts.push(triangleCount);
	const triangle = Buffer.alloc(70);
	triangle.writeUInt16LE(0, 2);
	triangle.writeUInt16LE(1, 4);
	triangle.writeUInt16LE(2, 6);
	for (let index = 0; index < 3; index++) {
		triangle.writeFloatLE(1, 8 + index * 12 + 8);
	}
	triangle.writeFloatLE(1, 44 + 4);
	triangle.writeFloatLE(1, 56 + 8);
	triangle.writeUInt8(1, 68);
	parts.push(triangle);
	const group = Buffer.alloc(39);
	group.writeUInt16LE(1, 0);
	group.write("Triangle", 3, 32, "ascii");
	group.writeUInt16LE(1, 35);
	group.writeUInt16LE(0, 37);
	parts.push(group, Buffer.from([0xff]));
	const tail = Buffer.alloc(16);
	tail.writeUInt16LE(0, 0);
	tail.writeFloatLE(24, 2);
	tail.writeInt32LE(1, 10);
	tail.writeUInt16LE(0, 14);
	parts.push(tail);
	return Buffer.concat(parts);
}

function triangleB3d(): Buffer {
	const chunk = (tag: string, payload: Buffer): Buffer => {
		const header = Buffer.alloc(8);
		header.write(tag, 0, 4, "ascii");
		header.writeUInt32LE(payload.length, 4);
		return Buffer.concat([header, payload]);
	};
	const vertices = Buffer.alloc(12 + 3 * 24);
	vertices.writeInt32LE(1, 0);
	vertices.writeInt32LE(0, 4);
	vertices.writeInt32LE(0, 8);
	const points = [
		[0, 0, 0],
		[1, 0, 0],
		[0, 1, 0],
	];
	for (let index = 0; index < points.length; index++) {
		const offset = 12 + index * 24;
		points[index].forEach((value, axis) => vertices.writeFloatLE(value, offset + axis * 4));
		vertices.writeFloatLE(1, offset + 20);
	}
	const triangles = Buffer.alloc(16);
	triangles.writeInt32LE(-1, 0);
	triangles.writeInt32LE(0, 4);
	triangles.writeInt32LE(1, 8);
	triangles.writeInt32LE(2, 12);
	const mesh = Buffer.alloc(4);
	mesh.writeInt32LE(-1);
	const transform = Buffer.alloc(40);
	transform.writeFloatLE(1, 12);
	transform.writeFloatLE(1, 16);
	transform.writeFloatLE(1, 20);
	transform.writeFloatLE(1, 24);
	const node = Buffer.concat([Buffer.from("Triangle\0"), transform, chunk("MESH", Buffer.concat([mesh, chunk("VRTS", vertices), chunk("TRIS", triangles)]))]);
	const version = Buffer.alloc(4);
	version.writeInt32LE(1);
	return chunk("BB3D", Buffer.concat([version, chunk("NODE", node)]));
}

function triangleX(): string {
	return `xof 0303txt 0032
Mesh Triangle {
	3;
	0.0;0.0;0.0;,
	1.0;0.0;0.0;,
	0.0;1.0;0.0;;
	1;
	3;0,1,2;;
}
`;
}

function triangleLwo(): Buffer {
	const string = (value: string): Buffer => {
		const terminated = Buffer.from(`${value}\0`, "utf-8");
		return terminated.length & 1 ? Buffer.concat([terminated, Buffer.from([0])]) : terminated;
	};
	const chunk = (tag: string, payload: Buffer): Buffer => {
		const header = Buffer.alloc(8);
		header.write(tag, 0, 4, "ascii");
		header.writeUInt32BE(payload.length, 4);
		return payload.length & 1 ? Buffer.concat([header, payload, Buffer.from([0])]) : Buffer.concat([header, payload]);
	};
	const points = Buffer.alloc(36);
	[0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => points.writeFloatBE(value, index * 4));
	const polygons = Buffer.alloc(12);
	polygons.write("FACE", 0, 4, "ascii");
	polygons.writeUInt16BE(3, 4);
	polygons.writeUInt16BE(0, 6);
	polygons.writeUInt16BE(1, 8);
	polygons.writeUInt16BE(2, 10);
	const tags = Buffer.concat([string("Default")]);
	const polygonTag = Buffer.alloc(8);
	polygonTag.write("SURF", 0, 4, "ascii");
	polygonTag.writeUInt16BE(0, 4);
	polygonTag.writeUInt16BE(0, 6);
	const body = Buffer.concat([
		Buffer.from("LWO2", "ascii"),
		chunk("TAGS", tags),
		chunk("PNTS", points),
		chunk("POLS", polygons),
		chunk("PTAG", polygonTag),
		chunk("SURF", Buffer.concat([string("Default"), string("")])),
	]);
	const header = Buffer.alloc(8);
	header.write("FORM", 0, 4, "ascii");
	header.writeUInt32BE(body.length, 4);
	return Buffer.concat([header, body]);
}

function triangleDxf(): string {
	return `0
SECTION
2
ENTITIES
0
3DFACE
8
0
10
0
20
0
30
0
11
1
21
0
31
0
12
0
22
1
32
0
13
0
23
1
33
0
0
ENDSEC
0
EOF
`;
}

async function animatedBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const root = new TransformNode("Root", scene);
	const hand = new Mesh("Hand", scene);
	hand.parent = root;
	const vertexData = new VertexData();
	vertexData.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
	vertexData.indices = [0, 1, 2];
	vertexData.applyToMesh(hand);
	const group = new AnimationGroup("Take 001", scene);
	const position = new Animation("RootPosition", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
	position.setKeys([
		{ frame: 0, value: Vector3.Zero() },
		{ frame: 30, value: new Vector3(3, 0, 0) },
		{ frame: 60, value: new Vector3(6, 0, 0) },
	]);
	group.addTargetedAnimation(position, root);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function materialBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const mesh = new Mesh("Body", scene);
	const vertexData = new VertexData();
	vertexData.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
	vertexData.indices = [0, 1, 2];
	vertexData.applyToMesh(mesh);
	mesh.material = new StandardMaterial("Imported Body", scene);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

function serializedReplacementMaterial(name: string, color: Color3): Record<string, unknown> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const material = new StandardMaterial(name, scene);
	material.diffuseColor = color;
	const serialized = material.serialize() as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function lodBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	MeshBuilder.CreateSphere("Planet", { segments: 12, diameter: 2 }, scene);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function authoredLodBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	MeshBuilder.CreateSphere("Tree_LOD0", { segments: 12, diameter: 2 }, scene);
	MeshBuilder.CreateSphere("Tree_LOD1", { segments: 8, diameter: 2 }, scene);
	MeshBuilder.CreateSphere("Tree_LOD2", { segments: 4, diameter: 2 }, scene);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function skinnedMorphLodBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const mesh = MeshBuilder.CreateSphere("Hero", { segments: 12, diameter: 2 }, scene);
	const vertexCount = mesh.getTotalVertices();
	mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: vertexCount }, () => [0, 1, 0, 0]).flat(), false, 4);
	mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: vertexCount }, () => [0.75, 0.25, 0, 0]).flat(), false, 4);
	mesh.numBoneInfluencers = 4;
	const skeleton = new Skeleton("HeroRig", "hero-rig", scene);
	const root = new Bone("Root", skeleton, null, Matrix.Identity());
	new Bone("Spine", skeleton, root, Matrix.Identity());
	mesh.skeleton = skeleton;
	const manager = new MorphTargetManager(scene, mesh.name);
	const smile = new MorphTarget("Smile", 0, scene, manager);
	smile.id = "hero-smile";
	const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
	smile.setPositions(positions.map((value, index) => (index % 3 === 1 ? value + 0.2 : value)));
	manager.addTarget(smile);
	mesh.morphTargetManager = manager;
	const group = new AnimationGroup("Face", scene);
	const influence = new Animation("Smile", "influence", 30, Animation.ANIMATIONTYPE_FLOAT);
	influence.setKeys([
		{ frame: 0, value: 0 },
		{ frame: 30, value: 1 },
	]);
	group.addTargetedAnimation(influence, smile);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

describe("executed model importer", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-model-importer-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("loads, transforms, reports, and serializes a portable model", async () => {
		const source = join(directory, "assets", "triangle.gltf");
		const output = join(directory, "build", "triangle.babylon");
		await writeJSON(source, triangleGltf());
		const result = await processModelImporterOutput(
			source,
			output,
			normalizeModelImporterSettings({
				scaleFactor: 2,
				convertUnits: true,
				generateColliders: true,
				weldVertices: true,
				optimizeMesh: true,
				normals: "calculate",
				tangents: "calculate",
				meshCompression: "high",
			})
		);
		expect(result).toMatchObject({
			supported: true,
			valid: true,
			unitScale: 200,
			meshCount: 1,
			triangleCount: 1,
			colliderCount: 1,
			weldedMeshCount: 1,
			optimizedMeshCount: 1,
			quantizedMeshCount: 1,
			calculatedNormalMeshCount: 1,
			calculatedTangentMeshCount: 1,
			errors: [],
		});
		expect(await pathExists(output)).toBe(true);
		expect((await readJSON(output)).meshes.length).toBeGreaterThan(0);
	});

	test("leases and applies portable model evidence through MCP and converts legacy formats through Assimp", async () => {
		const source = join(directory, "assets", "triangle.gltf");
		await writeJSON(source, triangleGltf());
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = { ...metadata.importer.settings, scaleFactor: 0.5, convertUnits: false, generateColliders: true };
		await writeAssetMetadata(source, metadata);
		const planned = await getModelImporterArtifactStatus(source);
		const applied = await applyModelImporterArtifact(source, planned.fingerprint);
		expect(applied).toMatchObject({ current: true, result: { supported: true, valid: true, unitScale: 0.5, colliderCount: 1 } });

		const scene = {} as Scene;
		const mcpPlan = await getModelImporterResult(scene, { path: "assets/triangle.gltf" });
		await expect(applyModelImporter(scene, { path: "assets/triangle.gltf", expectedFingerprint: mcpPlan.fingerprint, confirm: false }, {} as never)).rejects.toThrow(
			"confirm=true"
		);
		const refresh = vi.fn();
		const mcpResult = await applyModelImporter(scene, { path: "assets/triangle.gltf", expectedFingerprint: mcpPlan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh } } },
		} as never);
		expect(mcpResult).toMatchObject({ applied: true, current: true, result: { sourcePath: "assets/triangle.gltf", supported: true, valid: true, meshCount: 1 } });
		expect(JSON.stringify(mcpResult)).not.toContain(directory);
		expect(refresh).toHaveBeenCalledOnce();

		const legacy = join(directory, "assets", "legacy.dae");
		await writeFile(legacy, triangleDae());
		const unsupported = await processModelImporterOutput(legacy, join(directory, "build", "legacy.babylon"), normalizeModelImporterSettings({}));
		expect(unsupported).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "dae",
			meshCount: 1,
			triangleCount: 1,
			legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
		});
		expect(await pathExists(unsupported.outputPath!)).toBe(true);

		const milkShape = join(directory, "assets", "triangle.ms3d");
		await writeFile(milkShape, triangleMs3d());
		const convertedMs3d = await processModelImporterOutput(milkShape, join(directory, "build", "triangle-ms3d.babylon"), normalizeModelImporterSettings({}));
		expect(convertedMs3d).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "ms3d",
			meshCount: 1,
			triangleCount: 1,
			legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
		});

		const blitz = join(directory, "assets", "triangle.b3d");
		await writeFile(blitz, triangleB3d());
		const convertedB3d = await processModelImporterOutput(blitz, join(directory, "build", "triangle-b3d.babylon"), normalizeModelImporterSettings({}));
		expect(convertedB3d).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "b3d",
			meshCount: 1,
			triangleCount: 1,
			legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
		});

		const directX = join(directory, "assets", "triangle.x");
		await writeFile(directX, triangleX());
		const convertedX = await processModelImporterOutput(directX, join(directory, "build", "triangle-x.babylon"), normalizeModelImporterSettings({}));
		expect(convertedX).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "x",
			meshCount: 1,
			triangleCount: 1,
			legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
		});

		const lightWave = join(directory, "assets", "triangle.lwo");
		await writeFile(lightWave, triangleLwo());
		const convertedLwo = await processModelImporterOutput(lightWave, join(directory, "build", "triangle-lwo.babylon"), normalizeModelImporterSettings({}));
		expect(convertedLwo).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "lwo",
			meshCount: 1,
			triangleCount: 1,
			legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
		});

		const drawing = join(directory, "assets", "triangle.dxf");
		await writeFile(drawing, triangleDxf());
		const convertedDxf = await processModelImporterOutput(drawing, join(directory, "build", "triangle-dxf.babylon"), normalizeModelImporterSettings({}));
		expect(convertedDxf).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "dxf",
			meshCount: 1,
			triangleCount: 1,
			legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
		});

		const binaryDrawing = join(directory, "assets", "binary.dxf");
		await writeFile(binaryDrawing, Buffer.from("AutoCAD Binary DXF\r\n\x1a\0", "binary"));
		const rejectedBinaryDxf = await processModelImporterOutput(binaryDrawing, join(directory, "build", "binary-dxf.babylon"), normalizeModelImporterSettings({}));
		expect(rejectedBinaryDxf).toMatchObject({ supported: true, valid: false, sourceFormat: "dxf" });
		expect(rejectedBinaryDxf.errors.join(" ")).toMatch(/binary.*not supported/i);
		await readAssetMetadata(binaryDrawing);
		const rejectedPlan = await getModelImporterArtifactStatus(binaryDrawing);
		const rejectedArtifact = await applyModelImporterArtifact(binaryDrawing, rejectedPlan.fingerprint);
		expect(rejectedArtifact).toMatchObject({ current: true, exists: true, result: { supported: true, valid: false, sourceFormat: "dxf", outputPath: null } });
		expect(await pathExists(rejectedArtifact.manifestPath)).toBe(true);
	});

	test("executes modern Blender conversion through the configured Blender CLI backend", async () => {
		const source = join(directory, "assets", "modern.blend");
		const texture = join(directory, "assets", "texture.png");
		const executable = join(directory, "fake blender");
		await writeFile(source, "BLENDER-v300");
		await writeFile(texture, Buffer.from(ONE_PIXEL_PNG.split(",")[1], "base64"));
		await writeFile(
			executable,
			`#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.argv[process.argv.length - 1], Buffer.from("${triangleGlb("//texture.png").toString("base64")}", "base64"));
`,
			"utf-8"
		);
		await chmod(executable, 0o755);
		const previous = process.env.BJS_EDITOR_BLENDER_EXECUTABLE;
		process.env.BJS_EDITOR_BLENDER_EXECUTABLE = executable;
		try {
			const result = await processModelImporterOutput(source, join(directory, "build", "modern.babylon"), normalizeModelImporterSettings({}));
			expect(result.errors).toEqual([]);
			expect(result).toMatchObject({
				supported: true,
				valid: true,
				sourceFormat: "blend",
				meshCount: 1,
				triangleCount: 1,
				textureCount: 1,
				embeddedResourceCount: 1,
				dependencyPaths: ["assets/texture.png"],
				legacyConversion: { engine: "blender", inputFileCount: 1, outputBytes: expect.any(Number) },
			});
		} finally {
			if (previous === undefined) delete process.env.BJS_EDITOR_BLENDER_EXECUTABLE;
			else process.env.BJS_EDITOR_BLENDER_EXECUTABLE = previous;
		}
	});

	test("invalidates exact model leases and build fingerprints when an indexed external buffer changes", async () => {
		const source = join(directory, "assets", "external.gltf");
		const bufferPath = join(directory, "assets", "external.bin");
		const document = triangleGltf() as { buffers: Array<{ byteLength: number; uri: string }> };
		const bytes = Buffer.from(document.buffers[0].uri.split(",")[1], "base64");
		document.buffers[0].uri = "external.bin";
		await writeJSON(source, document);
		await writeFile(bufferPath, bytes);
		await refreshAssetRegistryPaths([source, bufferPath]);
		const planned = await getModelImporterArtifactStatus(source);
		const applied = await applyModelImporterArtifact(source, planned.fingerprint);
		expect(applied).toMatchObject({ current: true, result: { valid: true, embeddedResourceCount: 1 } });

		const changed = Buffer.from(bytes);
		changed.writeFloatLE(2, 12);
		await writeFile(bufferPath, changed);
		await refreshAssetRegistryPaths([bufferPath]);
		const stale = await getModelImporterArtifactStatus(source);
		expect(stale.current).toBe(false);
		expect(stale.fingerprint).not.toBe(planned.fingerprint);
	});

	test("configures Optimize Game Object through dedicated MCP and returns exact importer evidence", async () => {
		const source = join(directory, "assets", "character.gltf");
		await writeJSON(source, triangleGltf());
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;
		const configured = await setModelRigOptimization(
			{} as Scene,
			{ path: "assets/character.gltf", enabled: true, exposedTransforms: ["Armature/Hips/RightHand", "Head"] },
			options
		);
		expect(configured).toMatchObject({
			current: false,
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			updated: [
				{
					path: "assets/character.gltf",
					importer: { settings: { optimizeGameObjects: true, exposedTransforms: "Armature/Hips/RightHand\nHead" } },
				},
			],
		});
		const applied = await applyModelImporter({} as Scene, { path: "assets/character.gltf", expectedFingerprint: configured.fingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({
			valid: true,
			rigOptimization: {
				enabled: true,
				candidateTransformCount: 0,
				optimizedTransformCount: 0,
				missingExposedTransforms: ["Armature/Hips/RightHand", "Head"],
			},
		});
		expect(applied.result.warnings).toContain("Optimize Game Object found no skeleton-linked Transform nodes to optimize.");
		expect(refresh).toHaveBeenCalled();
	});

	test("configures leased per-model clips and publishes rebased loop/root-motion output", async () => {
		const source = join(directory, "assets", "animated.babylon");
		await writeJSON(source, await animatedBabylonDocument());
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;
		const initial = await getModelAnimationClips({} as Scene, { path: "assets/animated.babylon" });
		expect(initial).toMatchObject({
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			current: false,
			definitions: [],
			sourceAnimationGroups: [],
		});
		const configured = await setModelAnimationClips(
			{} as Scene,
			{
				path: "assets/animated.babylon",
				expectedFingerprint: initial.fingerprint,
				clips: [
					{
						name: "Walk",
						sourceAnimationGroup: "Take 001",
						from: 10,
						to: 40,
						loopTime: true,
						loopPose: true,
						rootMotionNode: "Root",
						rootMotionPosition: "xz",
						rootMotionRotationY: false,
					},
				],
			},
			options
		);
		expect(configured).toMatchObject({
			updated: true,
			fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
			current: false,
			definitions: [{ name: "Walk", sourceAnimationGroup: "Take 001", from: 10, to: 40, loopTime: true, loopPose: true }],
		});
		expect(configured.fingerprint).not.toBe(initial.fingerprint);
		await expect(setModelAnimationClips({} as Scene, { path: "assets/animated.babylon", expectedFingerprint: initial.fingerprint, clips: [] }, options)).rejects.toThrow(
			"plan changed"
		);
		const applied = await applyModelImporter({} as Scene, { path: "assets/animated.babylon", expectedFingerprint: configured.fingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({
			valid: true,
			animationGroupCount: 1,
			replacedAnimationGroupCount: 1,
			sourceAnimationGroups: [{ name: "Take 001", from: 0, to: 60, framePerSecond: 30, trackCount: 1 }],
			animationClips: [
				{
					name: "Walk",
					sourceFrom: 10,
					sourceTo: 40,
					from: 0,
					to: 30,
					durationSeconds: 1,
					loopTime: true,
					loopPose: true,
					rootMotion: { requestedNode: "Root", resolved: true, positionMode: "xz", properties: ["position"] },
				},
			],
		});
		const output = await readJSON(join(directory, applied.result.outputPath));
		expect(output.animationGroups).toMatchObject([
			{
				name: "Walk",
				from: 0,
				to: 30,
				loopAnimation: true,
				metadata: { babylonEditorModelAnimationClip: { sourceAnimationGroup: "Take 001", sourceFrom: 10, sourceTo: 40 } },
			},
		]);
		const inspected = await getModelAnimationClips({} as Scene, { path: "assets/animated.babylon" });
		expect(inspected).toMatchObject({
			current: true,
			definitions: [{ name: "Walk" }],
			sourceAnimationGroups: [{ name: "Take 001" }],
			generatedClips: [{ name: "Walk" }],
		});
		expect(refresh).toHaveBeenCalled();
	});

	test("discovers, leases, executes, and invalidates exact project-material remaps through MCP", async () => {
		const source = join(directory, "assets", "character.babylon");
		const replacement = join(directory, "assets", "hero-blue.material");
		await writeJSON(source, await materialBabylonDocument());
		await writeJSON(replacement, serializedReplacementMaterial("Hero Blue", Color3.Blue()));
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;

		const discovery = await getModelImporterResult({} as Scene, { path: "assets/character.babylon" });
		await applyModelImporter({} as Scene, { path: "assets/character.babylon", expectedFingerprint: discovery.fingerprint, confirm: true }, options);
		const inspected = await getModelMaterialRemaps({} as Scene, { path: "assets/character.babylon" });
		expect(inspected).toMatchObject({
			current: true,
			remaps: [],
			sourceMaterials: [{ name: "Imported Body", materialObjectCount: 1, meshReferenceCount: 1 }],
		});
		const configured = await setModelMaterialRemaps(
			{} as Scene,
			{
				path: "assets/character.babylon",
				expectedFingerprint: inspected.fingerprint,
				remaps: [{ sourceMaterial: "Imported Body", materialPath: "assets/hero-blue.material" }],
			},
			options
		);
		expect(configured).toMatchObject({
			updated: true,
			current: false,
			remaps: [{ sourceMaterial: "Imported Body", materialPath: "assets/hero-blue.material" }],
		});
		await expect(setModelMaterialRemaps({} as Scene, { path: "assets/character.babylon", expectedFingerprint: inspected.fingerprint, remaps: [] }, options)).rejects.toThrow(
			"plan changed"
		);

		const applied = await applyModelImporter({} as Scene, { path: "assets/character.babylon", expectedFingerprint: configured.fingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({
			valid: true,
			remappedMaterialCount: 1,
			remappedMeshCount: 1,
			missingMaterialRemapCount: 0,
			dependencyPaths: ["assets/hero-blue.material"],
			materialRemaps: [{ sourceMaterial: "Imported Body", matched: true, replacementMaterialName: "Hero Blue" }],
		});
		const output = await readJSON(join(directory, applied.result.outputPath));
		const replacementMaterial = output.materials.find((material: any) => material.name === "Hero Blue");
		expect(replacementMaterial).toBeDefined();
		expect(output.meshes.find((mesh: any) => mesh.name === "Body").materialId).toBe(replacementMaterial.id);

		await writeJSON(replacement, serializedReplacementMaterial("Hero Blue", Color3.Red()));
		const stale = await getModelImporterArtifactStatus(source);
		expect(stale.current).toBe(false);
		expect(stale.fingerprint).not.toBe(configured.fingerprint);
		expect(refresh).toHaveBeenCalled();
	});

	test("configures and executes leased Unity-style local material search through MCP", async () => {
		const modelFolder = join(directory, "assets", "Characters");
		const materialsFolder = join(modelFolder, "Materials");
		await mkdir(materialsFolder, { recursive: true });
		const source = join(modelFolder, "character.babylon");
		await writeJSON(source, await materialBabylonDocument());
		await writeJSON(join(materialsFolder, "Imported Body.material"), serializedReplacementMaterial("Searched Hero", Color3.Green()));
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;
		const initial = await getModelMaterialSearch({} as Scene, { path: "assets/Characters/character.babylon" });
		expect(initial).toMatchObject({ current: false, naming: "sourceMaterial", search: "none", result: null });
		const configured = await setModelMaterialSearch(
			{} as Scene,
			{
				path: "assets/Characters/character.babylon",
				expectedFingerprint: initial.fingerprint,
				naming: "sourceMaterial",
				search: "local",
			},
			options
		);
		expect(configured).toMatchObject({ updated: true, current: false, naming: "sourceMaterial", search: "local" });
		await expect(
			setModelMaterialSearch(
				{} as Scene,
				{ path: "assets/Characters/character.babylon", expectedFingerprint: initial.fingerprint, naming: "sourceMaterial", search: "none" },
				options
			)
		).rejects.toThrow("plan changed");
		const applied = await applyModelImporter({} as Scene, { path: "assets/Characters/character.babylon", expectedFingerprint: configured.fingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({
			valid: true,
			remappedMaterialCount: 1,
			materialSearch: {
				naming: "sourceMaterial",
				search: "local",
				searchedMaterialCount: 1,
				matches: [{ sourceMaterial: "Imported Body", materialPath: "assets/Characters/Materials/Imported Body.material", matched: true }],
			},
		});
		const inspected = await getModelMaterialSearch({} as Scene, { path: "assets/Characters/character.babylon" });
		expect(inspected).toMatchObject({ current: true, result: { matches: [{ matched: true }] } });
		expect(refresh).toHaveBeenCalled();
	});

	test("configures exact Web/Desktop model overrides and executes distinct effective target plans", async () => {
		const source = join(directory, "assets", "platform.gltf");
		await writeJSON(source, triangleGltf());
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;
		const initial = await getModelPlatformOverrides({} as Scene, { path: "assets/platform.gltf" });
		expect(initial).toMatchObject({
			current: false,
			overrides: {},
			effective: {
				web: { overrideApplied: false, settings: { scaleFactor: 1, generateColliders: false } },
				desktop: { overrideApplied: false, settings: { scaleFactor: 1, generateColliders: false } },
			},
		});
		const overrides = {
			web: { enabled: true, scaleFactor: 2, convertUnits: false, generateColliders: true, meshCompression: "high" as const },
			desktop: { enabled: true, scaleFactor: 3, convertUnits: false, generateColliders: false, meshCompression: "none" as const },
		};
		const configured = await setModelPlatformOverrides({} as Scene, { path: "assets/platform.gltf", expectedFingerprint: initial.fingerprint, overrides }, options);
		expect(configured).toMatchObject({
			updated: true,
			current: false,
			overrides,
			effective: {
				web: { platform: "web", overrideApplied: true, settings: { scaleFactor: 2, generateColliders: true, meshCompression: "high" } },
				desktop: { platform: "desktop", overrideApplied: true, settings: { scaleFactor: 3, generateColliders: false, meshCompression: "none" } },
			},
		});
		await expect(setModelPlatformOverrides({} as Scene, { path: "assets/platform.gltf", expectedFingerprint: initial.fingerprint, overrides: {} }, options)).rejects.toThrow(
			"plan changed"
		);
		const settings = normalizeModelImporterSettings((await readAssetMetadata(source)).importer.settings);
		expect(settings.platformOverrides).toEqual(overrides);
		const web = await processModelImporterOutput(source, join(directory, "build", "web.babylon"), settings, "web");
		const desktop = await processModelImporterOutput(source, join(directory, "build", "desktop.babylon"), settings, "desktop");
		expect(web).toMatchObject({ platform: "web", platformOverrideApplied: true, unitScale: 2, colliderCount: 1, quantizedMeshCount: 1 });
		expect(desktop).toMatchObject({ platform: "desktop", platformOverrideApplied: true, unitScale: 3, colliderCount: 0, quantizedMeshCount: 0 });
		expect(web.baseSettings.platformOverrides).toEqual(overrides);
		const scenePath = join(directory, "public", "scene");
		await mkdir(scenePath, { recursive: true });
		const cache: Record<string, string> = {};
		const exportOptions = { optimize: false, scenePath, projectDir: directory, exportedAssets: [] as string[], cache };
		await processAssetFile({} as never, source, { ...exportOptions, modelPlatform: "web" });
		const runtimePath = join(scenePath, "assets", "platform.gltf.bjsmodel.json");
		const webRuntime = await readJSON(runtimePath);
		const webCache = cache["assets/platform.gltf"];
		expect(webRuntime.result).toMatchObject({ platform: "web", unitScale: 2, colliderCount: 1 });
		await processAssetFile({} as never, source, { ...exportOptions, exportedAssets: [], modelPlatform: "desktop" });
		expect(cache["assets/platform.gltf"]).not.toBe(webCache);
		expect((await readJSON(runtimePath)).result).toMatchObject({ platform: "desktop", unitScale: 3, colliderCount: 0 });
		expect(refresh).toHaveBeenCalled();
	});

	test("extracts embedded materials into editable assets and persists exact remaps atomically", async () => {
		const source = join(directory, "assets", "character.babylon");
		await writeJSON(source, await materialBabylonDocument());
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;
		const plan = await inspectModelMaterialExtraction({} as Scene, { path: "assets/character.babylon" });
		expect(plan).toMatchObject({
			path: "assets/character.babylon",
			destinationFolder: "assets/Materials",
			createCount: 1,
			reuseCount: 0,
			conflictCount: 0,
			valid: true,
			items: [{ sourceMaterial: "Imported Body", materialPath: "assets/Materials/Imported Body.material", action: "create" }],
		});
		await expect(extractModelMaterials({} as Scene, { path: "assets/character.babylon", expectedFingerprint: plan.fingerprint, confirm: false }, options)).rejects.toThrow(
			"confirm=true"
		);
		const extracted = await extractModelMaterials({} as Scene, { path: "assets/character.babylon", expectedFingerprint: plan.fingerprint, confirm: true }, options);
		expect(extracted).toMatchObject({
			extracted: true,
			created: ["assets/Materials/Imported Body.material"],
			reused: [],
			remaps: [{ sourceMaterial: "Imported Body", materialPath: "assets/Materials/Imported Body.material" }],
			modelImporterCurrent: false,
		});
		expect(await pathExists(join(directory, "assets", "Materials", "Imported Body.material"))).toBe(true);
		expect(normalizeModelImporterSettings((await readAssetMetadata(source)).importer.settings).materialRemaps).toEqual([
			{ sourceMaterial: "Imported Body", materialPath: "assets/Materials/Imported Body.material" },
		]);
		await expect(extractModelMaterials({} as Scene, { path: "assets/character.babylon", expectedFingerprint: plan.fingerprint, confirm: true }, options)).rejects.toThrow(
			"plan changed"
		);
		const reusePlan = await inspectModelMaterialExtraction({} as Scene, { path: "assets/character.babylon" });
		expect(reusePlan).toMatchObject({ createCount: 0, reuseCount: 1, conflictCount: 0, valid: true, items: [{ action: "reuse" }] });
		const reused = await extractModelMaterials({} as Scene, { path: "assets/character.babylon", expectedFingerprint: reusePlan.fingerprint, confirm: true }, options);
		expect(reused).toMatchObject({ created: [], reused: ["assets/Materials/Imported Body.material"] });
		const applied = await applyModelImporter({} as Scene, { path: "assets/character.babylon", expectedFingerprint: reused.modelImporterFingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({ valid: true, remappedMaterialCount: 1, missingMaterialRemapCount: 0 });
		const output = await readJSON(join(directory, applied.result.outputPath));
		const extractedMaterial = output.materials.find((material: any) => material.name === "Imported Body");
		expect(extractedMaterial).toBeDefined();
		expect(output.meshes.find((mesh: any) => mesh.name === "Body").materialId).toBe(extractedMaterial.id);
		const extractedPath = join(directory, "assets", "Materials", "Imported Body.material");
		await writeJSON(extractedPath, serializedReplacementMaterial("Do Not Overwrite", Color3.Red()));
		const conflict = await inspectModelMaterialExtraction({} as Scene, { path: "assets/character.babylon" });
		expect(conflict).toMatchObject({ valid: false, conflictCount: 1, items: [{ action: "conflict" }] });
		await expect(extractModelMaterials({} as Scene, { path: "assets/character.babylon", expectedFingerprint: conflict.fingerprint, confirm: true }, options)).rejects.toThrow(
			"will not be overwritten"
		);
		expect(await readJSON(extractedPath)).toMatchObject({ name: "Do Not Overwrite", diffuse: [1, 0, 0] });
		expect(refresh).toHaveBeenCalled();
	});

	test("extracts embedded model textures and transactionally rewrites editable materials", async () => {
		const source = join(directory, "assets", "textured.babylon");
		const materialPath = join(directory, "assets", "Materials", "Textured Body.material");
		await mkdir(join(directory, "assets", "Materials"));
		const sourceDocument = await materialBabylonDocument();
		(sourceDocument.materials as Array<Record<string, unknown>>)[0].diffuseTexture = {
			name: "body-albedo.png",
			url: "data:123456/#image0",
			base64String: ONE_PIXEL_PNG,
			samplingMode: 3,
			coordinatesMode: 0,
		};
		await writeJSON(source, sourceDocument);
		const materialPlanOne = await getModelMaterialExtractionStatus(source, "assets/Stable Materials");
		const materialPlanTwo = await getModelMaterialExtractionStatus(source, "assets/Stable Materials");
		expect(materialPlanTwo).toMatchObject({ fingerprint: materialPlanOne.fingerprint, items: [{ contentHash: materialPlanOne.items[0].contentHash }] });
		await writeJSON(materialPath, {
			customType: "BABYLON.StandardMaterial",
			id: "Textured Body",
			name: "Textured Body",
			diffuseTexture: { name: "body-albedo.png", url: "", base64String: ONE_PIXEL_PNG, samplingMode: 3, coordinatesMode: 0 },
		});
		const metadata = await readAssetMetadata(source);
		metadata.importer.settings = {
			...metadata.importer.settings,
			materialRemaps: serializeModelMaterialRemaps([{ sourceMaterial: "Imported Body", materialPath: "assets/Materials/Textured Body.material" }]),
		};
		await writeAssetMetadata(source, metadata);
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;
		const plan = await inspectModelTextureExtraction({} as Scene, { path: "assets/textured.babylon" });
		expect(plan).toMatchObject({
			path: "assets/textured.babylon",
			destinationFolder: "assets/Textures",
			createCount: 1,
			reuseCount: 0,
			conflictCount: 0,
			valid: true,
			materialPaths: ["assets/Materials/Textured Body.material"],
			items: [{ suggestedName: "body-albedo.png", texturePath: "assets/Textures/body-albedo.png", action: "create" }],
		});
		await expect(extractModelTextures({} as Scene, { path: "assets/textured.babylon", expectedFingerprint: plan.fingerprint, confirm: false }, options)).rejects.toThrow(
			"confirm=true"
		);
		await mkdir(join(directory, "assets", "Textures"));
		await writeFile(join(directory, "assets", "Textures", "body-albedo.png"), "conflict");
		await expect(extractModelTextures({} as Scene, { path: "assets/textured.babylon", expectedFingerprint: plan.fingerprint, confirm: true }, options)).rejects.toThrow(
			"plan changed"
		);
		expect(await readFile(join(directory, "assets", "Textures", "body-albedo.png"), "utf-8")).toBe("conflict");
		await remove(join(directory, "assets", "Textures", "body-albedo.png"));
		const current = await inspectModelTextureExtraction({} as Scene, { path: "assets/textured.babylon" });
		const extracted = await extractModelTextures({} as Scene, { path: "assets/textured.babylon", expectedFingerprint: current.fingerprint, confirm: true }, options);
		expect(extracted).toMatchObject({
			extracted: true,
			created: ["assets/Textures/body-albedo.png"],
			reused: [],
			rewrittenMaterials: ["assets/Materials/Textured Body.material"],
		});
		const texture = await readFile(join(directory, "assets", "Textures", "body-albedo.png"));
		expect(texture.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
		const rewritten = await readJSON(materialPath);
		expect(rewritten.diffuseTexture).toMatchObject({ name: "assets/Textures/body-albedo.png", url: "assets/Textures/body-albedo.png" });
		expect(JSON.stringify(rewritten)).not.toContain("base64String");
		expect(refresh).toHaveBeenCalled();
	});

	test("configures leased generated LODs and serializes runtime mesh switching", async () => {
		const source = join(directory, "assets", "planet.babylon");
		await writeJSON(source, await lodBabylonDocument());
		const refresh = vi.fn();
		const options = { editor: { layout: { assets: { refresh } } } } as never;
		const initial = await getModelGeneratedLods({} as Scene, { path: "assets/planet.babylon" });
		expect(initial).toMatchObject({ current: false, levels: [], generated: [] });
		const configured = await setModelGeneratedLods(
			{} as Scene,
			{
				path: "assets/planet.babylon",
				expectedFingerprint: initial.fingerprint,
				levels: [
					{ quality: 0.5, distance: 500 },
					{ quality: 0.25, distance: 1000 },
				],
			},
			options
		);
		expect(configured).toMatchObject({
			updated: true,
			current: false,
			levels: [
				{ quality: 0.5, distance: 500 },
				{ quality: 0.25, distance: 1000 },
			],
		});
		await expect(setModelGeneratedLods({} as Scene, { path: "assets/planet.babylon", expectedFingerprint: initial.fingerprint, levels: [] }, options)).rejects.toThrow(
			"plan changed"
		);
		const applied = await applyModelImporter({} as Scene, { path: "assets/planet.babylon", expectedFingerprint: configured.fingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({
			valid: true,
			lodSourceMeshCount: 1,
			generatedLodMeshCount: 2,
			skippedLodMeshCount: 0,
			generatedLods: [
				{
					sourceMesh: "Planet",
					levels: [
						{ meshName: "Planet_LOD1", distance: 500 },
						{ meshName: "Planet_LOD2", distance: 1000 },
					],
				},
			],
		});
		const output = await readJSON(join(directory, applied.result.outputPath));
		const sourceMesh = output.meshes.find((mesh: any) => mesh.name === "Planet");
		const lodMeshes = output.meshes.filter((mesh: any) => mesh.metadata?.babylonEditorModelGeneratedLod);
		expect(lodMeshes).toHaveLength(2);
		expect(sourceMesh.lodMeshIds).toEqual(lodMeshes.map((mesh: any) => mesh.id));
		expect(sourceMesh.lodDistances).toEqual([500, 1000]);
		const runtimeEngine = new NullEngine();
		const runtimeScene = new Scene(runtimeEngine);
		const runtimeContainer = await LoadAssetContainerAsync(`data:application/json;base64,${Buffer.from(JSON.stringify(output)).toString("base64")}`, runtimeScene, {
			pluginExtension: ".babylon",
		});
		runtimeContainer.addAllToScene();
		expect(
			runtimeScene
				.getMeshByName("Planet")
				?.getLODLevels()
				.map((level) => level.distanceOrScreenCoverage)
				.sort((a, b) => a - b)
		).toEqual([500, 1000]);
		runtimeScene.dispose();
		runtimeEngine.dispose();
		const inspected = await getModelGeneratedLods({} as Scene, { path: "assets/planet.babylon" });
		expect(inspected).toMatchObject({ current: true, generatedLodMeshCount: 2, generated: [{ sourceMesh: "Planet" }] });
		expect(refresh).toHaveBeenCalled();
	});

	test("discovers and applies exact artist-authored model LOD groups through leased MCP", async () => {
		const source = join(directory, "assets", "tree.babylon");
		await writeJSON(source, await authoredLodBabylonDocument());
		const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as never;
		const initial = await getModelAuthoredLods({} as Scene, { path: "assets/tree.babylon" });
		expect(initial).toMatchObject({ current: false, groups: [], suggestions: [] });
		await applyModelImporter({} as Scene, { path: "assets/tree.babylon", expectedFingerprint: initial.fingerprint, confirm: true }, options);
		const discovered = await getModelAuthoredLods({} as Scene, { path: "assets/tree.babylon" });
		expect(discovered).toMatchObject({
			current: true,
			suggestions: [
				{
					sourceMesh: "Tree_LOD0",
					levels: [
						{ mesh: "Tree_LOD1", distance: 500 },
						{ mesh: "Tree_LOD2", distance: 1000 },
					],
				},
			],
		});
		const configured = await setModelAuthoredLods(
			{} as Scene,
			{ path: "assets/tree.babylon", expectedFingerprint: discovered.fingerprint, groups: discovered.suggestions },
			options
		);
		await expect(setModelAuthoredLods({} as Scene, { path: "assets/tree.babylon", expectedFingerprint: discovered.fingerprint, groups: [] }, options)).rejects.toThrow(
			"plan changed"
		);
		const applied = await applyModelImporter({} as Scene, { path: "assets/tree.babylon", expectedFingerprint: configured.fingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({
			valid: true,
			authoredLodSourceMeshCount: 1,
			authoredLodMeshCount: 2,
			authoredLods: [
				{
					sourceMesh: "Tree_LOD0",
					levels: [
						{ mesh: "Tree_LOD1", distance: 500 },
						{ mesh: "Tree_LOD2", distance: 1000 },
					],
				},
			],
		});
		const output = await readJSON(join(directory, applied.result.outputPath));
		const sourceMesh = output.meshes.find((mesh: any) => mesh.name === "Tree_LOD0");
		expect(sourceMesh.lodMeshIds).toEqual([output.meshes.find((mesh: any) => mesh.name === "Tree_LOD1").id, output.meshes.find((mesh: any) => mesh.name === "Tree_LOD2").id]);
		expect(sourceMesh.lodDistances).toEqual([500, 1000]);
		const runtimeScene = new Scene(new NullEngine());
		const runtimeContainer = await LoadAssetContainerAsync(`data:application/json;base64,${Buffer.from(JSON.stringify(output)).toString("base64")}`, runtimeScene, {
			pluginExtension: ".babylon",
		});
		runtimeContainer.addAllToScene();
		const runtimeSource = runtimeContainer.meshes.find((mesh) => mesh.name === "Tree_LOD0") as Mesh;
		expect(runtimeSource.getLODLevels().map((level) => level.mesh?.name)).toEqual(["Tree_LOD2", "Tree_LOD1"]);
		const inspected = await getModelAuthoredLods({} as Scene, { path: "assets/tree.babylon" });
		expect(inspected).toMatchObject({ current: true, authoredLodSourceMeshCount: 1, authoredLodMeshCount: 2, applied: [{ sourceMesh: "Tree_LOD0" }] });
	});

	test("applies leased generated LODs to skinned morph models and reloads deformation-safe output", async () => {
		const source = join(directory, "assets", "hero.babylon");
		await writeJSON(source, await skinnedMorphLodBabylonDocument());
		const options = { editor: { layout: { assets: { refresh: vi.fn() } } } } as never;
		const initial = await getModelGeneratedLods({} as Scene, { path: "assets/hero.babylon" });
		const configured = await setModelGeneratedLods(
			{} as Scene,
			{ path: "assets/hero.babylon", expectedFingerprint: initial.fingerprint, levels: [{ quality: 0.5, distance: 500 }] },
			options
		);
		const applied = await applyModelImporter({} as Scene, { path: "assets/hero.babylon", expectedFingerprint: configured.fingerprint, confirm: true }, options);
		expect(applied.result).toMatchObject({
			valid: true,
			lodSourceMeshCount: 1,
			generatedLodMeshCount: 1,
			skippedLodMeshCount: 0,
			generatedLods: [
				{
					sourceMesh: "Hero",
					deformationMode: "skinnedMorph",
					morphTargetCount: 1,
					levels: [{ skinInfluenceStreamsPreserved: true, morphTargetCount: 1, morphAnimationTrackCount: 1 }],
				},
			],
		});
		const output = await readJSON(join(directory, applied.result.outputPath));
		expect(output.animationGroups[0].targetedAnimations).toHaveLength(2);
		const runtimeScene = new Scene(new NullEngine());
		const runtimeContainer = await LoadAssetContainerAsync(`data:application/json;base64,${Buffer.from(JSON.stringify(output)).toString("base64")}`, runtimeScene, {
			pluginExtension: ".babylon",
		});
		runtimeContainer.addAllToScene();
		expect(configureGeneratedModelLodDeformations(runtimeContainer)).toBe(1);
		const hero = runtimeContainer.meshes.find((mesh) => mesh.name === "Hero") as Mesh;
		const lod = hero.getLODLevels()[0].mesh!;
		expect(lod.skeleton?.id).toBe("hero-rig");
		expect(lod.getVerticesData(VertexBuffer.MatricesWeightsKind, false)?.length).toBe(lod.getTotalVertices() * 4);
		expect(lod.morphTargetManager?.getTarget(0).vertexCount).toBe(lod.getTotalVertices());
		const smile = hero.morphTargetManager!.getTarget(0);
		const lodSmile = lod.morphTargetManager!.getTarget(0);
		smile.influence = 0.6;
		expect(lodSmile.influence).toBe(0.6);
	});
});
