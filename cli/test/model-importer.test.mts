import { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path/posix";

import { configureGeneratedModelLodDeformations, normalizeModelImporterSettings, serializeModelImporterPlatformOverrides } from "babylonjs-editor-tools";
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
import { afterEach, describe, expect, test } from "vitest";

import { processExportedModel } from "../src/pack/assets/model.mjs";
import { processAssetFile } from "../src/pack/assets/process.mjs";

const require = createRequire(import.meta.url);

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
		meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
		nodes: [{ mesh: 0 }],
		scenes: [{ nodes: [0] }],
		scene: 0,
	};
}

function triangleDae(): string {
	return `<?xml version="1.0"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
	<asset><up_axis>Y_UP</up_axis></asset>
	<library_geometries><geometry id="g"><mesh>
		<source id="p"><float_array id="pa" count="9">0 0 0 1 0 0 0 1 0</float_array><technique_common><accessor source="#pa" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
		<vertices id="v"><input semantic="POSITION" source="#p"/></vertices><triangles count="1"><input semantic="VERTEX" source="#v" offset="0"/><p>0 1 2</p></triangles>
	</mesh></geometry></library_geometries>
	<library_visual_scenes><visual_scene id="s"><node id="n"><instance_geometry url="#g"/></node></visual_scene></library_visual_scenes>
	<scene><instance_visual_scene url="#s"/></scene>
</COLLADA>`;
}

function triangleFbx(): string {
	return `; FBX 7.4.0 project file
FBXHeaderExtension:  { FBXHeaderVersion: 1003 FBXVersion: 7400 Creator: "Babylon Editor Test" }
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",-1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",1
	}
}
Documents: { Count: 1 Document: 999, "Scene", "Scene" { Properties70: { } RootNode: 0 } }
Definitions: {
	Version: 100
	Count: 2
	ObjectType: "Geometry" { Count: 1 }
	ObjectType: "Model" { Count: 1 PropertyTemplate: "FbxNode" { Properties70: { } } }
}
Objects: {
	Geometry: 1, "Geometry::Triangle", "Mesh" {
		Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
		PolygonVertexIndex: *3 { a: 0,1,-3 }
		GeometryVersion: 124
	}
	Model: 2, "Model::Triangle", "Mesh" { Version: 232 Shading: T Culling: "CullingOff" }
}
Connections: { C: "OO",1,2 C: "OO",2,0 }`;
}

async function animatedBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const root = new TransformNode("Root", scene);
	const mesh = new Mesh("Triangle", scene);
	mesh.parent = root;
	const data = new VertexData();
	data.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
	data.indices = [0, 1, 2];
	data.applyToMesh(mesh);
	const group = new AnimationGroup("Take", scene);
	const animation = new Animation("RootPosition", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
	animation.setKeys([
		{ frame: 0, value: Vector3.Zero() },
		{ frame: 30, value: new Vector3(3, 0, 0) },
		{ frame: 60, value: new Vector3(6, 0, 0) },
	]);
	group.addTargetedAnimation(animation, root);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function materialBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const mesh = new Mesh("Body", scene);
	const data = new VertexData();
	data.positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
	data.indices = [0, 1, 2];
	data.applyToMesh(mesh);
	mesh.material = new StandardMaterial("Imported Body", scene);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function lodBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	MeshBuilder.CreateSphere("Planet", { segments: 12 }, scene);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function authoredLodBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	MeshBuilder.CreateSphere("Tree_LOD0", { segments: 12 }, scene);
	MeshBuilder.CreateSphere("Tree_LOD1", { segments: 8 }, scene);
	MeshBuilder.CreateSphere("Tree_LOD2", { segments: 4 }, scene);
	const serialized = (await SceneSerializer.SerializeAsync(scene)) as Record<string, unknown>;
	scene.dispose();
	engine.dispose();
	return serialized;
}

async function skinnedMorphLodBabylonDocument(): Promise<Record<string, unknown>> {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const mesh = MeshBuilder.CreateSphere("Hero", { segments: 12 }, scene);
	const vertexCount = mesh.getTotalVertices();
	mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: vertexCount }, () => [0, 1, 0, 0]).flat(), false, 4);
	mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: vertexCount }, () => [0.8, 0.2, 0, 0]).flat(), false, 4);
	const skeleton = new Skeleton("HeroRig", "hero-rig", scene);
	const root = new Bone("Root", skeleton, null, Matrix.Identity());
	new Bone("Spine", skeleton, root, Matrix.Identity());
	mesh.skeleton = skeleton;
	const manager = new MorphTargetManager(scene, mesh.name);
	const smile = new MorphTarget("Smile", 0, scene, manager);
	smile.id = "hero-smile";
	const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
	smile.setPositions(positions.map((value, index) => (index % 3 === 1 ? value + 0.15 : value)));
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

describe("CLI executed model importer", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("executes the shared model-import settings and writes Babylon output", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "triangle.gltf");
		const output = join(project, "public", "scene", "assets", "triangle.gltf.bjsmodel.babylon");
		await writeJSON(source, triangleGltf());
		const result = await processExportedModel(
			source,
			output,
			normalizeModelImporterSettings({
				convertUnits: false,
				scaleFactor: 3,
				optimizeGameObjects: true,
				exposedTransforms: "RightHand",
				generateColliders: true,
				normals: "calculate",
				tangents: "calculate",
				meshCompression: "medium",
			}),
			project
		);
		expect(result).toMatchObject({
			supported: true,
			valid: true,
			unitScale: 3,
			meshCount: 1,
			triangleCount: 1,
			colliderCount: 1,
			quantizedMeshCount: 1,
			calculatedNormalMeshCount: 1,
			calculatedTangentMeshCount: 1,
			rigOptimization: {
				enabled: true,
				candidateTransformCount: 0,
				missingExposedTransforms: ["RightHand"],
			},
			errors: [],
		});
		expect(await pathExists(output)).toBe(true);
		expect((await readJSON(output)).meshes.length).toBeGreaterThan(0);
	});

	test("executes Web/Desktop model overrides and invalidates the CLI cache when the target changes", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-platform-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public");
		await ensureDir(assets);
		await ensureDir(publicDir);
		const source = join(assets, "platform.gltf");
		await writeJSON(source, triangleGltf());
		await writeJSON(`${source}.bjsmeta.json`, {
			version: 1,
			guid: "00000000-0000-4000-8000-000000000402",
			importer: {
				version: 1,
				kind: "model",
				settings: {
					convertUnits: false,
					scaleFactor: 1,
					platformOverrides: serializeModelImporterPlatformOverrides({
						web: { enabled: true, scaleFactor: 2, generateColliders: true, meshCompression: "high" },
						desktop: { enabled: true, scaleFactor: 3, generateColliders: false, meshCompression: "none" },
					}),
				},
			},
		});
		const cache: Record<string, string> = {};
		const baseOptions = {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			exportedAssets: [] as string[],
			cache,
			optimize: false,
			compressedTexturesEnabled: false,
		} as any;
		await processAssetFile(source, { ...baseOptions, modelPlatform: "web" });
		const runtimePath = join(publicDir, "assets", "platform.gltf.bjsmodel.json");
		const web = await readJSON(runtimePath);
		const webCache = cache["assets/platform.gltf"];
		expect(web.result).toMatchObject({ platform: "web", platformOverrideApplied: true, unitScale: 2, colliderCount: 1, quantizedMeshCount: 1 });

		await processAssetFile(source, { ...baseOptions, exportedAssets: [], modelPlatform: "desktop" });
		const desktop = await readJSON(runtimePath);
		expect(cache["assets/platform.gltf"]).not.toBe(webCache);
		expect(desktop.result).toMatchObject({ platform: "desktop", platformOverrideApplied: true, unitScale: 3, colliderCount: 0, quantizedMeshCount: 0 });
	});

	test("converts legacy model formats through the same shared importer", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "legacy.dae");
		await writeFile(source, triangleDae());
		const result = await processExportedModel(source, join(project, "public", "legacy.babylon"), normalizeModelImporterSettings({}), project);
		expect(result.errors).toEqual([]);
		expect(result).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "dae",
			meshCount: 1,
			triangleCount: 1,
			legacyConversion: { engine: "assimp", inputFileCount: 1, inputBytes: expect.any(Number), outputBytes: expect.any(Number) },
		});
		expect(await pathExists(result.outputPath!)).toBe(true);

		const fbxSource = join(project, "assets", "triangle.fbx");
		await writeFile(fbxSource, triangleFbx());
		const fbx = await processExportedModel(fbxSource, join(project, "public", "triangle.babylon"), normalizeModelImporterSettings({}), project);
		expect(fbx).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "fbx",
			legacyConversion: { engine: "assimp", inputFileCount: 1, outputBytes: expect.any(Number) },
		});

		const assimpPackage = dirname(require.resolve("assimpjs/package.json"));
		const threeDsSource = join(project, "assets", "cube.3ds");
		await writeFile(threeDsSource, await readFile(join(assimpPackage, "examples", "testfiles", "cube_with_materials.3ds")));
		await writeFile(join(project, "assets", "texture.png"), await readFile(join(assimpPackage, "examples", "testfiles", "texture.png")));
		const threeDs = await processExportedModel(threeDsSource, join(project, "public", "cube.babylon"), normalizeModelImporterSettings({}), project);
		expect(threeDs.errors).toEqual([]);
		expect(threeDs).toMatchObject({
			supported: true,
			valid: true,
			sourceFormat: "3ds",
			meshCount: expect.any(Number),
			embeddedResourceCount: 1,
			dependencyPaths: ["assets/texture.png"],
			legacyConversion: { engine: "assimp", inputFileCount: 1, outputBytes: expect.any(Number) },
		});
		expect(threeDs.meshCount).toBeGreaterThan(0);
	});

	test("invalidates the CLI build cache when a recorded external model dependency changes", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-cache-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public");
		await ensureDir(assets);
		await ensureDir(publicDir);
		const source = join(assets, "external.gltf");
		const bufferPath = join(assets, "external.bin");
		const document = triangleGltf() as { buffers: Array<{ byteLength: number; uri: string }> };
		const bytes = Buffer.from(document.buffers[0].uri.split(",")[1], "base64");
		document.buffers[0].uri = "external.bin";
		await writeJSON(source, document);
		await writeFile(bufferPath, bytes);
		const cache: Record<string, string> = {};
		const options = {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			exportedAssets: [] as string[],
			cache,
			optimize: false,
			compressedTexturesEnabled: false,
		} as any;
		await processAssetFile(source, options);
		const output = join(publicDir, "assets", "external.gltf.bjsmodel.babylon");
		const runtime = await readJSON(join(publicDir, "assets", "external.gltf.bjsmodel.json"));
		expect(runtime.result.dependencyPaths).toEqual(["assets/external.bin"]);
		const firstOutput = await readFile(output, "utf-8");

		const changed = Buffer.from(bytes);
		changed.writeFloatLE(2, 12);
		await writeFile(bufferPath, changed);
		await processAssetFile(source, { ...options, exportedAssets: [] });
		expect(await readFile(output, "utf-8")).not.toBe(firstOutput);
	});

	test("uses the shared per-model clip processor in CLI builds", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-clips-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "animated.babylon");
		const output = join(project, "public", "animated.babylon");
		await writeJSON(source, await animatedBabylonDocument());
		const result = await processExportedModel(
			source,
			output,
			normalizeModelImporterSettings({
				convertUnits: false,
				weldVertices: false,
				optimizeMesh: false,
				animationClips: [
					{
						name: "Run",
						sourceAnimationGroup: "Take",
						from: 15,
						to: 45,
						loopTime: true,
						rootMotionNode: "Root",
						rootMotionPosition: "xyz",
					},
				],
			}),
			project
		);
		expect(result).toMatchObject({
			valid: true,
			animationGroupCount: 1,
			replacedAnimationGroupCount: 1,
			sourceAnimationGroups: [{ name: "Take", from: 0, to: 60 }],
			animationClips: [
				{
					name: "Run",
					sourceFrom: 15,
					sourceTo: 45,
					from: 0,
					to: 30,
					loopTime: true,
					rootMotion: { requestedNode: "Root", resolved: true, positionMode: "xyz" },
				},
			],
		});
		expect(await readJSON(output)).toMatchObject({
			animationGroups: [{ name: "Run", from: 0, to: 30, loopAnimation: true }],
		});
	});

	test("generates and serializes runtime model LODs in CLI builds", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-lods-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "planet.babylon");
		const output = join(project, "public", "planet.babylon");
		await writeJSON(source, await lodBabylonDocument());
		const result = await processExportedModel(
			source,
			output,
			normalizeModelImporterSettings({
				convertUnits: false,
				weldVertices: false,
				optimizeMesh: false,
				generatedLods: [
					{ quality: 0.5, distance: 500 },
					{ quality: 0.25, distance: 1000 },
				],
			}),
			project
		);
		expect(result).toMatchObject({ valid: true, lodSourceMeshCount: 1, generatedLodMeshCount: 2, skippedLodMeshCount: 0 });
		const serialized = await readJSON(output);
		const sourceMesh = serialized.meshes.find((mesh: any) => mesh.name === "Planet");
		const lodMeshes = serialized.meshes.filter((mesh: any) => mesh.metadata?.babylonEditorModelGeneratedLod);
		expect(lodMeshes).toHaveLength(2);
		expect(sourceMesh.lodMeshIds).toEqual(lodMeshes.map((mesh: any) => mesh.id));
		expect(sourceMesh.lodDistances).toEqual([500, 1000]);
	});

	test("preserves artist-authored mesh LOD groups in CLI builds and runtime reload", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-authored-lods-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "tree.babylon");
		const output = join(project, "public", "tree.babylon");
		await writeJSON(source, await authoredLodBabylonDocument());
		const result = await processExportedModel(
			source,
			output,
			normalizeModelImporterSettings({
				convertUnits: false,
				weldVertices: false,
				optimizeMesh: false,
				authoredLods: [
					{
						sourceMesh: "Tree_LOD0",
						levels: [
							{ mesh: "Tree_LOD1", distance: 500 },
							{ mesh: "Tree_LOD2", distance: 1000 },
						],
					},
				],
			}),
			project
		);
		expect(result).toMatchObject({ valid: true, authoredLodSourceMeshCount: 1, authoredLodMeshCount: 2 });
		const serialized = await readJSON(output);
		const sourceMesh = serialized.meshes.find((mesh: any) => mesh.name === "Tree_LOD0");
		expect(sourceMesh.lodMeshIds).toEqual([
			serialized.meshes.find((mesh: any) => mesh.name === "Tree_LOD1").id,
			serialized.meshes.find((mesh: any) => mesh.name === "Tree_LOD2").id,
		]);
		expect(sourceMesh.lodDistances).toEqual([500, 1000]);
		const runtimeScene = new Scene(new NullEngine());
		const container = await LoadAssetContainerAsync(`data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`, runtimeScene, {
			pluginExtension: ".babylon",
		});
		container.addAllToScene();
		const runtimeSource = container.meshes.find((mesh) => mesh.name === "Tree_LOD0") as Mesh;
		expect(runtimeSource.getLODLevels().map((level) => level.mesh?.name)).toEqual(["Tree_LOD2", "Tree_LOD1"]);
	});

	test("builds reloadable deformation-safe skinned morph LODs in the CLI", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-character-lods-"));
		directories.push(project);
		await ensureDir(join(project, "assets"));
		const source = join(project, "assets", "hero.babylon");
		const output = join(project, "public", "hero.babylon");
		await writeJSON(source, await skinnedMorphLodBabylonDocument());
		const result = await processExportedModel(
			source,
			output,
			normalizeModelImporterSettings({ convertUnits: false, weldVertices: false, optimizeMesh: false, generatedLods: [{ quality: 0.5, distance: 500 }] }),
			project
		);
		expect(result).toMatchObject({
			valid: true,
			lodSourceMeshCount: 1,
			generatedLodMeshCount: 1,
			generatedLods: [
				{
					sourceMesh: "Hero",
					deformationMode: "skinnedMorph",
					levels: [{ skinInfluenceStreamsPreserved: true, morphTargetCount: 1, morphAnimationTrackCount: 1 }],
				},
			],
		});
		const serialized = await readJSON(output);
		expect(serialized.animationGroups[0].targetedAnimations).toHaveLength(2);
		const runtimeScene = new Scene(new NullEngine());
		const container = await LoadAssetContainerAsync(`data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`, runtimeScene, {
			pluginExtension: ".babylon",
		});
		container.addAllToScene();
		expect(configureGeneratedModelLodDeformations(container)).toBe(1);
		const hero = container.meshes.find((mesh) => mesh.name === "Hero") as Mesh;
		const lod = hero.getLODLevels()[0].mesh!;
		expect(lod.skeleton?.id).toBe("hero-rig");
		expect(lod.morphTargetManager?.getTarget(0).vertexCount).toBe(lod.getTotalVertices());
		const smile = hero.morphTargetManager!.getTarget(0);
		const lodSmile = lod.morphTargetManager!.getTarget(0);
		smile.influence = 0.45;
		expect(lodSmile.influence).toBe(0.45);
	});

	test("automatically remaps searched project materials and invalidates cache when a new match appears", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-material-search-"));
		directories.push(project);
		const assets = join(project, "assets");
		const models = join(assets, "Models");
		const publicDir = join(project, "public");
		await ensureDir(models);
		await ensureDir(publicDir);
		const source = join(models, "character.babylon");
		await writeJSON(source, await materialBabylonDocument());
		await writeJSON(`${source}.bjsmeta.json`, {
			version: 1,
			guid: "00000000-0000-4000-8000-000000000099",
			importer: { version: 1, kind: "model", settings: { materialNaming: "sourceMaterial", materialSearch: "projectWide" } },
		});
		const cache: Record<string, string> = {};
		const options = {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			exportedAssets: [] as string[],
			cache,
			optimize: false,
			compressedTexturesEnabled: false,
		} as any;
		await processAssetFile(source, options);
		const runtimePath = join(publicDir, "assets", "Models", "character.babylon.bjsmodel.json");
		const first = await readJSON(runtimePath);
		expect(first.result.materialSearch).toMatchObject({ search: "projectWide", searchedMaterialCount: 0, matches: [{ matched: false }] });

		await writeJSON(join(assets, "Imported Body.material"), serializedReplacementMaterial("Auto Hero", Color3.Green()));
		await processAssetFile(source, { ...options, exportedAssets: [] });
		const second = await readJSON(runtimePath);
		expect(second.result).toMatchObject({
			remappedMaterialCount: 1,
			materialSearch: { searchedMaterialCount: 1, matches: [{ materialPath: "assets/Imported Body.material", matched: true }] },
		});
		const output = await readFile(join(publicDir, "assets", "Models", "character.babylon.bjsmodel.babylon"), "utf-8");
		expect(output).toContain("Auto Hero");
	});

	test("executes project-material remaps and invalidates the CLI build cache when replacements change", async () => {
		const project = await mkdtemp(join(tmpdir(), "babylon-cli-model-material-remap-"));
		directories.push(project);
		const assets = join(project, "assets");
		const publicDir = join(project, "public");
		await ensureDir(assets);
		await ensureDir(publicDir);
		const source = join(assets, "character.babylon");
		const replacement = join(assets, "hero.material");
		await writeJSON(source, await materialBabylonDocument());
		await writeJSON(replacement, serializedReplacementMaterial("Hero Blue", Color3.Blue()));
		await writeJSON(`${source}.bjsmeta.json`, {
			version: 1,
			guid: "00000000-0000-4000-8000-000000000001",
			importer: {
				version: 1,
				kind: "model",
				settings: { materialRemaps: JSON.stringify([{ sourceMaterial: "Imported Body", materialPath: "assets/hero.material" }]) },
			},
		});
		const cache: Record<string, string> = {};
		const options = {
			projectDir: project,
			publicDir,
			baseAssetsDir: assets,
			outputAssetsDir: join(publicDir, "assets"),
			exportedAssets: [] as string[],
			cache,
			optimize: false,
			compressedTexturesEnabled: false,
		} as any;
		await processAssetFile(source, options);
		const runtimePath = join(publicDir, "assets", "character.babylon.bjsmodel.json");
		const outputPath = join(publicDir, "assets", "character.babylon.bjsmodel.babylon");
		const runtime = await readJSON(runtimePath);
		expect(runtime.result).toMatchObject({
			valid: true,
			dependencyPaths: ["assets/hero.material"],
			remappedMaterialCount: 1,
			remappedMeshCount: 1,
			materialRemaps: [{ sourceMaterial: "Imported Body", matched: true, replacementMaterialName: "Hero Blue" }],
		});
		const firstOutput = await readFile(outputPath, "utf-8");

		await writeJSON(replacement, serializedReplacementMaterial("Hero Red", Color3.Red()));
		await processAssetFile(source, { ...options, exportedAssets: [] });
		const secondOutput = await readFile(outputPath, "utf-8");
		expect(secondOutput).not.toBe(firstOutput);
		expect(secondOutput).toContain("Hero Red");
	});
});
