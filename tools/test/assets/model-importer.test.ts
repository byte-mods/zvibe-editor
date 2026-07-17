import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Animation } from "@babylonjs/core/Animations/animation";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { CreateSphereVertexData } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { SceneSerializer } from "@babylonjs/core/Misc/sceneSerializer";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import { describe, expect, test } from "vitest";
import { Buffer } from "node:buffer";

import { executeModelAnimationClipDefinitions, normalizeModelAnimationClipDefinitions } from "../../src/assets/model-animation-clips";
import { executeModelImporterEntries, normalizeModelImporterSettings } from "../../src/assets/model-importer";
import { normalizeModelMaterialRemaps } from "../../src/assets/model-material-remaps";
import { planModelMaterialSearch } from "../../src/assets/model-material-search";
import {
	defaultModelMaterialExtractionFolder,
	modelMaterialExtractionFilename,
	normalizeModelMaterialExtractionFolder,
	planModelMaterialExtraction,
} from "../../src/assets/model-material-extraction";
import { defaultModelTextureExtractionFolder, planModelTextureExtraction } from "../../src/assets/model-texture-extraction";
import {
	configureGeneratedModelLodDeformations,
	configureSerializedModelGeneratedLods,
	normalizeModelAuthoredLodGroups,
	normalizeModelLodDefinitions,
	suggestModelAuthoredLodGroups,
} from "../../src/assets/model-lods";
import { getOptimizedModelRigExposedTransform, synchronizeOptimizedModelRigExposedTransforms } from "../../src/assets/model-rig-optimizer";
import { prepareModelImporterSource } from "../../src/assets/model-source";
import { convertAssimpModelToGlb, IAssimpRuntime } from "../../src/assets/assimp-model";
import { normalizeModelImporterPlatformOverrides, resolveModelImporterPlatformSettings, serializeModelImporterPlatformOverrides } from "../../src/assets/model-platform-overrides";

function createModel(): { scene: Scene; root: Mesh; mesh: Mesh; material: StandardMaterial; texture: RawTexture; group: AnimationGroup } {
	const scene = new Scene(new NullEngine());
	const root = new Mesh("__root__", scene);
	const mesh = new Mesh("Quad", scene);
	mesh.parent = root;
	const data = new VertexData();
	data.positions = [0, 0, 0, 1.00003, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
	data.uvs = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
	data.indices = [0, 1, 2, 3, 4, 5];
	data.applyToMesh(mesh);
	const material = new StandardMaterial("Surface", scene);
	const texture = RawTexture.CreateRGBTexture(new Uint8Array([255, 0, 0]), 1, 1, scene);
	material.diffuseTexture = texture;
	mesh.material = material;
	const group = new AnimationGroup("Move", scene);
	return { scene, root, mesh, material, texture, group };
}

describe("executed model importer semantics", () => {
	test("normalizes and resolves closed Web/Desktop importer overrides without mutating Default settings", () => {
		const overrides = normalizeModelImporterPlatformOverrides({
			web: { enabled: true, scaleFactor: 0.5, meshCompression: "high", importAnimations: false, generatedLods: [{ quality: 0.4, distance: 400 }] },
			desktop: { enabled: false, scaleFactor: 2 },
		});
		const settings = normalizeModelImporterSettings({ scaleFactor: 1, meshCompression: "none", importAnimations: true, platformOverrides: overrides });
		const web = resolveModelImporterPlatformSettings(settings, "web");
		const desktop = resolveModelImporterPlatformSettings(settings, "electron");
		expect(web).toMatchObject({
			platform: "web",
			overrideApplied: true,
			settings: { scaleFactor: 0.5, meshCompression: "high", importAnimations: false, generatedLods: [{ quality: 0.4, distance: 400 }] },
		});
		expect(desktop).toMatchObject({ platform: "desktop", overrideApplied: false, settings: { scaleFactor: 1, meshCompression: "none", importAnimations: true } });
		expect(settings).toMatchObject({ scaleFactor: 1, meshCompression: "none", importAnimations: true });
		expect(JSON.parse(serializeModelImporterPlatformOverrides(overrides))).toEqual(overrides);
		expect(() => normalizeModelImporterPlatformOverrides({ console: { enabled: true } })).toThrow("Unsupported model importer platform");
		expect(() => normalizeModelImporterPlatformOverrides({ web: { enabled: true, secret: true } })).toThrow("Unsupported model platform override setting");
		expect(() =>
			normalizeModelImporterPlatformOverrides({
				web: {
					enabled: true,
					generatedLods: [
						{ quality: 0.5, distance: 1000 },
						{ quality: 0.6, distance: 2000 },
					],
				},
			})
		).toThrow("quality must strictly decrease");
	});
	test("plans collision-safe editable model-material extraction", () => {
		expect(defaultModelMaterialExtractionFolder("assets/Characters/Hero.fbx")).toBe("assets/Characters/Materials");
		expect(modelMaterialExtractionFilename("Body/Metal:*?")).toBe("Body-Metal---.material");
		expect(() => normalizeModelMaterialExtractionFolder("../outside")).toThrow("inside the project");
		expect(() => normalizeModelMaterialExtractionFolder("src/materials")).toThrow("assets folder");
		const sources = [
			{ sourceMaterial: "Body", contentHash: "a".repeat(64) },
			{ sourceMaterial: "Eyes", contentHash: "b".repeat(64) },
			{ sourceMaterial: "Metal/Trim", contentHash: "c".repeat(64) },
		];
		const plan = planModelMaterialExtraction(sources, "assets/Characters/Materials", [
			{ path: "assets/Characters/Materials/Body.material", contentHash: "a".repeat(64) },
			{ path: "assets/Characters/Materials/Eyes.material", contentHash: "d".repeat(64) },
		]);
		expect(plan).toMatchObject({ createCount: 1, reuseCount: 1, conflictCount: 1, valid: false });
		expect(plan.items).toEqual([
			{ sourceMaterial: "Body", contentHash: "a".repeat(64), materialPath: "assets/Characters/Materials/Body.material", action: "reuse" },
			{ sourceMaterial: "Eyes", contentHash: "b".repeat(64), materialPath: "assets/Characters/Materials/Eyes.material", action: "conflict" },
			{ sourceMaterial: "Metal/Trim", contentHash: "c".repeat(64), materialPath: "assets/Characters/Materials/Metal-Trim.material", action: "create" },
		]);
		expect(() => planModelMaterialExtraction([...sources, sources[0]], "assets/Materials")).toThrow("duplicate source name");
	});
	test("plans bounded collision-safe embedded model-texture extraction", () => {
		expect(defaultModelTextureExtractionFolder("assets/Characters/Hero.glb")).toBe("assets/Characters/Textures");
		const plan = planModelTextureExtraction(
			[
				{ contentHash: "a".repeat(64), suggestedName: "Body/Albedo.png", extension: ".png", byteLength: 64, materialPaths: ["assets/Materials/Body.material"] },
				{ contentHash: "b".repeat(64), suggestedName: "Body Albedo.jpg", extension: ".jpg", byteLength: 32, materialPaths: ["assets/Materials/Eyes.material"] },
			],
			"assets/Characters/Textures",
			[
				{ path: "assets/Characters/Textures/Albedo.png", contentHash: "a".repeat(64) },
				{ path: "assets/Characters/Textures/Body Albedo.jpg", contentHash: "c".repeat(64) },
			]
		);
		expect(plan).toMatchObject({ createCount: 0, reuseCount: 1, conflictCount: 1, totalBytes: 96, valid: false });
		expect(plan.items).toEqual([
			expect.objectContaining({ contentHash: "b".repeat(64), texturePath: "assets/Characters/Textures/Body Albedo.jpg", action: "conflict" }),
			expect.objectContaining({ contentHash: "a".repeat(64), texturePath: "assets/Characters/Textures/Albedo.png", action: "reuse" }),
		]);
	});
	test("plans Unity-style material naming and local/recursive/project-wide search without guessing ambiguity", () => {
		const sources = [
			{ sourceMaterial: "Body", baseTextureName: "hero_albedo" },
			{ sourceMaterial: "Eyes", baseTextureName: null },
		];
		const paths = ["assets/Characters/Materials/Body.material", "assets/Materials/Body.material", "assets/Shared/hero_albedo.material", "assets/Other/hero_albedo.material"];
		expect(planModelMaterialSearch("assets/Characters/Hero.fbx", sources, paths, "sourceMaterial", "local").matches[0]).toMatchObject({
			materialPath: "assets/Characters/Materials/Body.material",
			matched: true,
		});
		expect(planModelMaterialSearch("assets/Characters/Hero.fbx", sources, paths, "sourceMaterial", "recursiveUp").matches[0]).toMatchObject({
			materialPath: "assets/Characters/Materials/Body.material",
			candidates: ["assets/Characters/Materials/Body.material", "assets/Materials/Body.material"],
		});
		expect(planModelMaterialSearch("assets/Characters/Hero.fbx", sources, paths, "baseTextureName", "projectWide").matches[0]).toMatchObject({
			candidateName: "hero_albedo",
			materialPath: null,
			ambiguous: true,
		});
		expect(planModelMaterialSearch("assets/Characters/Hero.fbx", sources, ["assets/Shared/Hero-Eyes.material"], "modelAndMaterial", "projectWide").matches[1]).toMatchObject({
			candidateName: "Hero-Eyes",
			materialPath: "assets/Shared/Hero-Eyes.material",
		});
	});
	test("slices, rebases, masks, closes loop poses, and validates root motion atomically", () => {
		const scene = new Scene(new NullEngine());
		const root = new TransformNode("Root", scene);
		const hand = new TransformNode("Hand", scene);
		hand.parent = root;
		const group = new AnimationGroup("Take 001", scene);
		const position = new Animation("RootPosition", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
		position.setKeys([
			{ frame: 0, value: Vector3.Zero() },
			{ frame: 30, value: new Vector3(3, 0, 0) },
			{ frame: 60, value: new Vector3(6, 0, 0) },
		]);
		const scale = new Animation("HandScale", "scaling", 30, Animation.ANIMATIONTYPE_VECTOR3);
		scale.setKeys([
			{ frame: 0, value: Vector3.One() },
			{ frame: 60, value: new Vector3(2, 2, 2) },
		]);
		group.addTargetedAnimation(position, root);
		group.addTargetedAnimation(scale, hand);

		const execution = executeModelAnimationClipDefinitions(group.getScene().animationGroups, [
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
				targetMask: ["Root"],
			},
		]);
		expect(execution.errors).toEqual([]);
		expect(execution).toMatchObject({
			replacedAnimationGroupCount: 1,
			sourceGroups: [{ name: "Take 001", from: 0, to: 60, framePerSecond: 30, trackCount: 2, keyCount: 5, targets: ["Hand", "Root"] }],
			clips: [
				{
					name: "Walk",
					sourceAnimationGroup: "Take 001",
					sourceFrom: 10,
					sourceTo: 40,
					from: 0,
					to: 30,
					durationSeconds: 1,
					trackCount: 1,
					loopTime: true,
					loopPose: true,
					targets: ["Root"],
					rootMotion: { requestedNode: "Root", resolved: true, positionMode: "xz", rotationY: false, properties: ["position"] },
				},
			],
		});
		expect(scene.animationGroups.map((candidate) => candidate.name)).toEqual(["Walk"]);
		const keys = execution.animationGroups[0].targetedAnimations[0].animation.getKeys();
		expect(keys.map((key) => key.frame)).toEqual([0, 20, 30]);
		expect((keys[0].value as Vector3).asArray()).toEqual([1, 0, 0]);
		expect((keys.at(-1)!.value as Vector3).asArray()).toEqual([1, 0, 0]);
		expect(execution.animationGroups[0].metadata.babylonEditorModelAnimationClip).toMatchObject({
			sourceAnimationGroup: "Take 001",
			sourceFrom: 10,
			sourceTo: 40,
			loopTime: true,
		});
	});

	test("rejects invalid clip definitions and source plans without replacing working source groups", () => {
		expect(() =>
			normalizeModelAnimationClipDefinitions([
				{ name: "Walk", sourceAnimationGroup: "Take", from: 0, to: 10 },
				{ name: "walk", sourceAnimationGroup: "Take", from: 10, to: 20 },
			])
		).toThrow("names must be unique");
		expect(() => normalizeModelAnimationClipDefinitions([{ name: "Walk", sourceAnimationGroup: "Take", from: 0, to: 10, loopPose: true }])).toThrow("requires loopTime=true");

		const scene = new Scene(new NullEngine());
		const target = new TransformNode("Root", scene);
		const group = new AnimationGroup("Take", scene);
		const animation = new Animation("Move", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
		animation.setKeys([
			{ frame: 0, value: Vector3.Zero() },
			{ frame: 10, value: Vector3.One() },
		]);
		group.addTargetedAnimation(animation, target);
		const execution = executeModelAnimationClipDefinitions(scene.animationGroups, [{ name: "Broken", sourceAnimationGroup: "Take", from: 0, to: 20, targetMask: ["Missing"] }]);
		expect(execution.errors).toEqual([
			'Clip "Broken" range 0–20 must stay inside source group "Take" range 0–10.',
			'Clip "Broken" target mask does not match source target "Missing".',
			'Clip "Broken" target mask removes every animation track.',
		]);
		expect(scene.animationGroups).toEqual([group]);
		expect(execution.replacedAnimationGroupCount).toBe(0);
	});

	test("scales, welds, optimizes, calculates vertex data, quantizes, and enables colliders", async () => {
		const { root, mesh, material, texture, group } = createModel();
		const result = await executeModelImporterEntries(
			{
				meshes: [root, mesh],
				transformNodes: [],
				materials: [material],
				textures: [texture],
				animationGroups: [group],
			},
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
		expect(root.scaling.asArray()).toEqual([200, 200, 200]);
		expect(result).toMatchObject({
			unitScale: 200,
			meshCount: 1,
			colliderCount: 1,
			weldedMeshCount: 1,
			optimizedMeshCount: 1,
			quantizedMeshCount: 1,
			calculatedNormalMeshCount: 1,
			calculatedTangentMeshCount: 1,
			materialCount: 1,
			textureCount: 1,
			animationGroupCount: 1,
			errors: [],
			meshes: [{ name: "Quad", collider: true, welded: true, optimized: true, quantized: true, hasNormals: true, hasTangents: true }],
		});
		expect(mesh.checkCollisions).toBe(true);
	});

	test("validates and executes exact project-material remaps across direct and MultiMaterial slots", async () => {
		expect(() =>
			normalizeModelMaterialRemaps([
				{ sourceMaterial: "Surface", materialPath: "assets/one.material" },
				{ sourceMaterial: "Surface", materialPath: "assets/two.material" },
			])
		).toThrow("source names must be unique");
		expect(() => normalizeModelMaterialRemaps([{ sourceMaterial: "Surface", materialPath: "../outside.material" }])).toThrow("inside the project");

		const { scene, root, mesh, material } = createModel();
		const secondary = new StandardMaterial("Secondary", scene);
		const replacement = new StandardMaterial("Project Gold", scene);
		const slotted = mesh.clone("Slotted")!;
		const multi = new MultiMaterial("Slots", scene);
		multi.subMaterials = [material, secondary];
		slotted.material = multi;
		const result = await executeModelImporterEntries(
			{
				meshes: [root, mesh, slotted],
				materials: [material, secondary],
				multiMaterials: [multi],
				materialRemapMaterials: { "assets/gold.material": replacement },
			},
			normalizeModelImporterSettings({
				convertUnits: false,
				weldVertices: false,
				optimizeMesh: false,
				materialRemaps: [{ sourceMaterial: "Surface", materialPath: "assets/gold.material" }],
			})
		);
		expect(mesh.material).toBe(replacement);
		expect(multi.subMaterials[0]).toBe(replacement);
		expect(multi.subMaterials[1]).toBe(secondary);
		expect(result).toMatchObject({
			materialCount: 2,
			remappedMaterialCount: 1,
			remappedMeshCount: 2,
			missingMaterialRemapCount: 0,
			sourceMaterials: [
				{ name: "Secondary", materialObjectCount: 1, meshReferenceCount: 1, remapped: false },
				{ name: "Surface", materialObjectCount: 1, meshReferenceCount: 2, remapPath: "assets/gold.material", remapped: true },
			],
			materialRemaps: [
				{
					sourceMaterial: "Surface",
					materialPath: "assets/gold.material",
					matched: true,
					materialObjectCount: 1,
					meshReferenceCount: 2,
					replacementMaterialName: "Project Gold",
				},
			],
			errors: [],
		});
	});

	test("validates, generates, and attaches bounded static-mesh LOD levels", async () => {
		expect(() =>
			normalizeModelLodDefinitions([
				{ quality: 0.5, distance: 500 },
				{ quality: 0.6, distance: 1000 },
			])
		).toThrow("quality must strictly decrease");
		expect(() =>
			normalizeModelLodDefinitions([
				{ quality: 0.5, distance: 500 },
				{ quality: 0.25, distance: 400 },
			])
		).toThrow("distances must be strictly increasing");

		const scene = new Scene(new NullEngine());
		const sphere = new Mesh("Planet", scene);
		CreateSphereVertexData({ segments: 12, diameter: 2 }).applyToMesh(sphere);
		const result = await executeModelImporterEntries(
			{ meshes: [sphere] },
			normalizeModelImporterSettings({
				convertUnits: false,
				weldVertices: false,
				optimizeMesh: false,
				generatedLods: [
					{ quality: 0.5, distance: 500 },
					{ quality: 0.25, distance: 1000 },
				],
			})
		);
		expect(result).toMatchObject({
			lodSourceMeshCount: 1,
			generatedLodMeshCount: 2,
			skippedLodMeshCount: 0,
			generatedLods: [
				{
					sourceMesh: "Planet",
					levels: [
						{ level: 1, quality: 0.5, distance: 500, meshName: "Planet_LOD1" },
						{ level: 2, quality: 0.25, distance: 1000, meshName: "Planet_LOD2" },
					],
				},
			],
			errors: [],
		});
		expect(result.generatedLods[0].levels[0].triangleCount).toBeLessThan(result.generatedLods[0].sourceTriangleCount);
		expect(result.generatedLods[0].levels[1].triangleCount).toBeLessThanOrEqual(result.generatedLods[0].levels[0].triangleCount);
		expect(
			sphere
				.getLODLevels()
				.map((level) => level.distanceOrScreenCoverage)
				.sort((left, right) => left - right)
		).toEqual([500, 1000]);
		expect(sphere.getLODLevels().every((level) => level.mesh?.metadata?.babylonEditorModelGeneratedLod)).toBe(true);
	});

	test("generates reloadable skinned morph LODs with exact vertex-stream provenance and synchronized animation", async () => {
		const scene = new Scene(new NullEngine());
		const mesh = new Mesh("Hero", scene);
		CreateSphereVertexData({ segments: 12, diameter: 2 }).applyToMesh(mesh);
		const vertexCount = mesh.getTotalVertices();
		const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
		const normals = Array.from(mesh.getVerticesData(VertexBuffer.NormalKind, false) ?? []);
		const uv0 = Array.from(mesh.getVerticesData(VertexBuffer.UVKind, false) ?? []);
		const colors = Array.from({ length: vertexCount }, (_value, index) => [index / vertexCount, 0.5, 0.25, 1]).flat();
		mesh.setVerticesData(VertexBuffer.ColorKind, colors, false, 4);
		mesh.setVerticesData(VertexBuffer.UV2Kind, uv0, false, 2);
		mesh.setVerticesData(VertexBuffer.TangentKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 1]).flat(), false, 4);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: vertexCount }, () => [0, 1, 0, 0]).flat(), false, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, Array.from({ length: vertexCount }, () => [0.75, 0.25, 0, 0]).flat(), false, 4);
		mesh.setVerticesData(VertexBuffer.MatricesIndicesExtraKind, Array.from({ length: vertexCount }, () => [1, 0, 0, 0]).flat(), false, 4);
		mesh.setVerticesData(VertexBuffer.MatricesWeightsExtraKind, Array.from({ length: vertexCount }, () => [0, 0, 0, 0]).flat(), false, 4);
		mesh.numBoneInfluencers = 8;
		const skeleton = new Skeleton("HeroRig", "hero-rig", scene);
		const root = new Bone("Root", skeleton, null, Matrix.Identity());
		new Bone("Spine", skeleton, root, Matrix.Identity());
		mesh.skeleton = skeleton;
		const manager = new MorphTargetManager(scene, mesh.name);
		const smile = new MorphTarget("Smile", 0, scene, manager);
		smile.id = "hero-smile";
		smile.setPositions(positions.map((value, index) => (index % 3 === 1 ? value + 0.25 : value)));
		smile.setNormals(normals);
		smile.setTangents(Array.from({ length: vertexCount }, () => [1, 0, 0]).flat());
		smile.setUVs(uv0);
		smile.setUV2s(uv0);
		smile.setColors(colors);
		manager.addTarget(smile);
		mesh.morphTargetManager = manager;
		const group = new AnimationGroup("Face", scene);
		const influence = new Animation("Smile", "influence", 30, Animation.ANIMATIONTYPE_FLOAT);
		influence.setKeys([
			{ frame: 0, value: 0 },
			{ frame: 30, value: 1 },
		]);
		group.addTargetedAnimation(influence, smile);

		const result = await executeModelImporterEntries(
			{ meshes: [mesh], animationGroups: [group], skeletonCount: 1, skeletons: [skeleton] },
			normalizeModelImporterSettings({ convertUnits: false, weldVertices: false, optimizeMesh: false, generatedLods: [{ quality: 0.5, distance: 500 }] })
		);
		expect(result).toMatchObject({
			lodSourceMeshCount: 1,
			generatedLodMeshCount: 1,
			skippedLodMeshCount: 0,
			generatedLods: [
				{
					sourceMesh: "Hero",
					deformationMode: "skinnedMorph",
					morphTargetCount: 1,
					skinInfluenceStreams: ["matricesIndices", "matricesWeights", "matricesIndicesExtra", "matricesWeightsExtra"],
					levels: [{ skinInfluenceStreamsPreserved: true, morphTargetCount: 1, morphAnimationTrackCount: 1 }],
				},
			],
			errors: [],
		});
		expect(Array.from(mesh.getVerticesData(VertexBuffer.ColorKind, false) ?? [])).toEqual(colors);
		const lod = mesh.getLODLevels()[0].mesh!;
		expect(lod.skeleton).toBe(skeleton);
		expect(lod.numBoneInfluencers).toBe(8);
		for (const [kind, stride] of [
			[VertexBuffer.TangentKind, 4],
			[VertexBuffer.UV2Kind, 2],
			[VertexBuffer.ColorKind, 4],
			[VertexBuffer.MatricesIndicesKind, 4],
			[VertexBuffer.MatricesWeightsKind, 4],
			[VertexBuffer.MatricesIndicesExtraKind, 4],
			[VertexBuffer.MatricesWeightsExtraKind, 4],
		] as Array<[string, number]>) {
			expect(lod.getVerticesData(kind, false)?.length).toBe(lod.getTotalVertices() * stride);
		}
		expect(lod.morphTargetManager?.numTargets).toBe(1);
		const lodSmile = lod.morphTargetManager!.getTarget(0);
		expect(lodSmile.vertexCount).toBe(lod.getTotalVertices());
		const lodBase = Array.from(lod.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
		const lodSmilePositions = Array.from(lodSmile.getPositions() ?? []);
		for (let index = 1; index < lodBase.length; index += 3) expect(lodSmilePositions[index] - lodBase[index]).toBeCloseTo(0.25, 6);
		expect(group.targetedAnimations.map((targeted) => targeted.target)).toEqual([smile, lodSmile]);
		smile.influence = 0.7;
		expect(lodSmile.influence).toBe(0.7);

		const serialized = await SceneSerializer.SerializeAsync(scene);
		configureSerializedModelGeneratedLods(serialized, scene, (meshes) => SceneSerializer.SerializeMesh(meshes));
		const serializedLod = serialized.meshes.find((candidate: any) => candidate.id === lod.id);
		expect(serializedLod).toMatchObject({ skeletonId: "hero-rig", numBoneInfluencers: 8 });
		expect(serializedLod.morphTargetManagerId).toBeTypeOf("number");
		expect(serialized.morphTargetManagers).toHaveLength(2);
		const runtimeScene = new Scene(new NullEngine());
		const container = await LoadAssetContainerAsync(`data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`, runtimeScene, {
			pluginExtension: ".babylon",
		});
		container.addAllToScene();
		expect(configureGeneratedModelLodDeformations(container)).toBe(1);
		const runtimeHero = container.meshes.find((candidate) => candidate.name === "Hero")! as Mesh;
		const runtimeLod = runtimeHero.getLODLevels()[0].mesh!;
		expect(runtimeLod.skeleton?.id).toBe("hero-rig");
		expect(runtimeLod.morphTargetManager?.numTargets).toBe(1);
		const runtimeSmile = runtimeHero.morphTargetManager!.getTarget(0);
		const runtimeLodSmile = runtimeLod.morphTargetManager!.getTarget(0);
		runtimeSmile.influence = 0.35;
		expect(runtimeLodSmile.influence).toBe(0.35);
	});

	test("rolls every generated LOD back when a later deformation source is invalid", async () => {
		const scene = new Scene(new NullEngine());
		const valid = new Mesh("Valid", scene);
		CreateSphereVertexData({ segments: 8, diameter: 2 }).applyToMesh(valid);
		const invalid = new Mesh("InvalidSkin", scene);
		CreateSphereVertexData({ segments: 8, diameter: 2 }).applyToMesh(invalid);
		const skeleton = new Skeleton("BrokenRig", "broken-rig", scene);
		new Bone("Root", skeleton, null, Matrix.Identity());
		invalid.skeleton = skeleton;
		invalid.setVerticesData(VertexBuffer.MatricesIndicesKind, Array.from({ length: invalid.getTotalVertices() }, () => [0, 0, 0, 0]).flat(), false, 4);
		const result = await executeModelImporterEntries(
			{ meshes: [valid, invalid], skeletonCount: 1, skeletons: [skeleton] },
			normalizeModelImporterSettings({ convertUnits: false, weldVertices: false, optimizeMesh: false, generatedLods: [{ quality: 0.5, distance: 500 }] })
		);
		expect(result.generatedLodMeshCount).toBe(0);
		expect(result.generatedLods).toEqual([]);
		expect(result.errors).toEqual([expect.stringContaining("processing failed atomically")]);
		expect(valid.getLODLevels()).toEqual([]);
		expect(invalid.getLODLevels()).toEqual([]);
		expect(scene.meshes.some((mesh) => mesh.metadata?.babylonEditorModelGeneratedLod)).toBe(false);
	});

	test("normalizes explicit authored LOD groups and suggests conventional mesh suffixes", () => {
		expect(
			normalizeModelAuthoredLodGroups([
				{
					sourceMesh: "Hero_LOD0",
					levels: [
						{ mesh: "Hero_LOD1", distance: 500 },
						{ mesh: "Hero_LOD2", distance: 1200 },
					],
				},
			])
		).toEqual([
			{
				sourceMesh: "Hero_LOD0",
				levels: [
					{ mesh: "Hero_LOD1", distance: 500 },
					{ mesh: "Hero_LOD2", distance: 1200 },
				],
			},
		]);
		expect(suggestModelAuthoredLodGroups(["Tree_LOD2", "Hero", "Tree_LOD0", "Tree_LOD1"])).toEqual([
			{
				sourceMesh: "Tree_LOD0",
				levels: [
					{ mesh: "Tree_LOD1", distance: 500 },
					{ mesh: "Tree_LOD2", distance: 1000 },
				],
			},
		]);
		expect(() => normalizeModelAuthoredLodGroups([{ sourceMesh: "Hero", levels: [{ mesh: "Hero", distance: 500 }] }])).toThrow("assigned more than once");
		expect(() =>
			normalizeModelAuthoredLodGroups([
				{
					sourceMesh: "Hero",
					levels: [
						{ mesh: "Hero_LOD1", distance: 500 },
						{ mesh: "Hero_LOD2", distance: 400 },
					],
				},
			])
		).toThrow("strictly increasing");
	});

	test("attaches artist-authored meshes atomically and preserves their runtime LOD links", async () => {
		const scene = new Scene(new NullEngine());
		const source = new Mesh("Hero_LOD0", scene);
		const medium = new Mesh("Hero_LOD1", scene);
		const low = new Mesh("Hero_LOD2", scene);
		CreateSphereVertexData({ segments: 12, diameter: 2 }).applyToMesh(source);
		CreateSphereVertexData({ segments: 8, diameter: 2 }).applyToMesh(medium);
		CreateSphereVertexData({ segments: 4, diameter: 2 }).applyToMesh(low);
		const result = await executeModelImporterEntries(
			{ meshes: [source, medium, low] },
			normalizeModelImporterSettings({
				convertUnits: false,
				weldVertices: false,
				optimizeMesh: false,
				generateColliders: true,
				generatedLods: [{ quality: 0.5, distance: 500 }],
				authoredLods: [
					{
						sourceMesh: "Hero_LOD0",
						levels: [
							{ mesh: "Hero_LOD1", distance: 500 },
							{ mesh: "Hero_LOD2", distance: 1000 },
						],
					},
				],
			})
		);

		expect(result.errors).toEqual([]);
		expect(result.authoredLodSourceMeshCount).toBe(1);
		expect(result.authoredLodMeshCount).toBe(2);
		expect(result.generatedLodMeshCount).toBe(0);
		expect(result.skippedLodMeshCount).toBe(3);
		expect(result.colliderCount).toBe(1);
		expect(result.authoredLods[0]).toMatchObject({
			sourceMesh: "Hero_LOD0",
			levels: [
				{ mesh: "Hero_LOD1", distance: 500 },
				{ mesh: "Hero_LOD2", distance: 1000 },
			],
		});
		expect(source.getLODLevels().map((level) => level.mesh?.name)).toEqual(["Hero_LOD2", "Hero_LOD1"]);
		expect(source.checkCollisions).toBe(true);
		expect(medium.checkCollisions).toBe(false);
		expect(result.meshes.map((mesh) => ({ name: mesh.name, collider: mesh.collider }))).toEqual([
			{ name: "Hero_LOD0", collider: true },
			{ name: "Hero_LOD1", collider: false },
			{ name: "Hero_LOD2", collider: false },
		]);
		expect(low.metadata.babylonEditorModelAuthoredLod).toMatchObject({ sourceMesh: "Hero_LOD0", level: 2, distance: 1000 });

		const serialized = await SceneSerializer.SerializeAsync(scene);
		configureSerializedModelGeneratedLods(serialized, scene, (meshes) => SceneSerializer.SerializeMesh(meshes));
		const serializedSource = serialized.meshes.find((mesh: any) => mesh.name === "Hero_LOD0");
		expect(serializedSource.lodDistances).toEqual([500, 1000]);
		const runtimeScene = new Scene(new NullEngine());
		const container = await LoadAssetContainerAsync(`data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`, runtimeScene, {
			pluginExtension: ".babylon",
		});
		container.addAllToScene();
		expect((container.meshes.find((mesh) => mesh.name === "Hero_LOD0") as Mesh).getLODLevels().map((level) => level.mesh?.name)).toEqual(["Hero_LOD2", "Hero_LOD1"]);
	});

	test("rejects unresolved authored LOD groups without partially attaching earlier groups", async () => {
		const scene = new Scene(new NullEngine());
		const source = new Mesh("Tree_LOD0", scene);
		const level = new Mesh("Tree_LOD1", scene);
		CreateSphereVertexData({ segments: 8 }).applyToMesh(source);
		CreateSphereVertexData({ segments: 4 }).applyToMesh(level);
		const result = await executeModelImporterEntries(
			{ meshes: [source, level] },
			normalizeModelImporterSettings({
				convertUnits: false,
				weldVertices: false,
				optimizeMesh: false,
				authoredLods: [
					{ sourceMesh: "Tree_LOD0", levels: [{ mesh: "Tree_LOD1", distance: 500 }] },
					{ sourceMesh: "Rock_LOD0", levels: [{ mesh: "Rock_LOD1", distance: 500 }] },
				],
			})
		);
		expect(result.authoredLods).toEqual([]);
		expect(result.errors).toEqual([expect.stringContaining('Authored LOD mesh "Rock_LOD0" does not exist')]);
		expect(source.getLODLevels()).toEqual([]);
		expect(level.metadata?.babylonEditorModelAuthoredLod).toBeUndefined();
	});

	test("embeds glTF dependencies and preserves GLB binary chunks", async () => {
		const document = {
			asset: { version: "2.0" },
			buffers: [{ byteLength: 4, uri: "mesh.bin" }],
			images: [{ uri: "albedo.png" }],
		};
		const gltf = await prepareModelImporterSource("assets/model.gltf", new TextEncoder().encode(JSON.stringify(document)), async (reference) => {
			if (reference === "mesh.bin") return new Uint8Array([1, 2, 3, 4]);
			if (reference === "albedo.png") return new Uint8Array([137, 80, 78, 71]);
			return null;
		});
		expect(gltf).toMatchObject({ supported: true, pluginExtension: ".gltf", embeddedResourceCount: 2, errors: [] });
		expect(gltf.dataUrl).toContain("data:model/gltf+json;base64,");

		const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] }));
		const jsonLength = Math.ceil(json.length / 4) * 4;
		const binary = new Uint8Array([9, 8, 7, 6]);
		const glb = new Uint8Array(12 + 8 + jsonLength + 8 + binary.length);
		const view = new DataView(glb.buffer);
		view.setUint32(0, 0x46546c67, true);
		view.setUint32(4, 2, true);
		view.setUint32(8, glb.length, true);
		view.setUint32(12, jsonLength, true);
		view.setUint32(16, 0x4e4f534a, true);
		glb.fill(0x20, 20, 20 + jsonLength);
		glb.set(json, 20);
		view.setUint32(20 + jsonLength, binary.length, true);
		view.setUint32(24 + jsonLength, 0x004e4942, true);
		glb.set(binary, 28 + jsonLength);
		const preparedGlb = await prepareModelImporterSource("assets/model.glb", glb, async () => null);
		expect(preparedGlb).toMatchObject({ supported: true, pluginExtension: ".glb", embeddedResourceCount: 0, errors: [] });
		expect(preparedGlb.dataUrl).toContain("data:model/gltf-binary;base64,");
	});

	test("strips materials, textures, animation groups, normals, and tangents", async () => {
		const { root, mesh, material, texture, group } = createModel();
		mesh.createNormals(false);
		const result = await executeModelImporterEntries(
			{ meshes: [root, mesh], materials: [material], textures: [texture], animationGroups: [group] },
			normalizeModelImporterSettings({
				convertUnits: false,
				scaleFactor: 0.5,
				importMaterials: false,
				importTextures: false,
				importAnimations: false,
				weldVertices: false,
				optimizeMesh: false,
				normals: "none",
				tangents: "none",
			})
		);
		expect(root.scaling.asArray()).toEqual([0.5, 0.5, 0.5]);
		expect(mesh.material).toBeNull();
		expect(result).toMatchObject({
			unitScale: 0.5,
			materialCount: 0,
			textureCount: 0,
			animationGroupCount: 0,
			removedMaterialCount: 1,
			removedTextureCount: 1,
			removedAnimationGroupCount: 1,
			meshes: [{ hasNormals: false, hasTangents: false, collider: false }],
			errors: [],
		});
	});

	test("reports a failed Humanoid rig candidate when a model has no skeleton", async () => {
		const { root, mesh, material, texture, group } = createModel();
		const result = await executeModelImporterEntries(
			{ meshes: [root, mesh], materials: [material], textures: [texture], animationGroups: [group], skeletons: [] },
			normalizeModelImporterSettings({ animationType: "humanoid" })
		);
		expect(result.rig).toMatchObject({
			animationType: "humanoid",
			skeletonName: null,
			boneCount: 0,
			validation: { valid: false, requiredMappedBoneCount: 0 },
		});
		expect(result.errors).toContain("Humanoid rig import requires at least one skeleton.");
	});

	test("optimizes linked character transforms, retargets animation to bones, and synchronizes exposed attachment proxies", async () => {
		const scene = new Scene(new NullEngine());
		const characterRoot = new TransformNode("CharacterRoot", scene);
		const armature = new TransformNode("Armature", scene);
		const hips = new TransformNode("Hips", scene);
		const rightHand = new TransformNode("RightHand", scene);
		armature.parent = characterRoot;
		hips.parent = armature;
		hips.position.y = 1;
		rightHand.parent = hips;
		rightHand.position.x = 1;
		const body = new Mesh("Body", scene);
		body.parent = characterRoot;

		const skeleton = new Skeleton("HeroSkeleton", "hero-skeleton", scene);
		const armatureBone = new Bone("Armature", skeleton, null, Matrix.Identity());
		const hipsBone = new Bone("Hips", skeleton, armatureBone, Matrix.Translation(0, 1, 0));
		const handBone = new Bone("RightHand", skeleton, hipsBone, Matrix.Translation(1, 0, 0));
		armatureBone.linkTransformNode(armature);
		hipsBone.linkTransformNode(hips);
		handBone.linkTransformNode(rightHand);
		body.skeleton = skeleton;

		const group = new AnimationGroup("Wave", scene);
		const hipsTrack = new Animation("HipsPosition", "position", 30, Animation.ANIMATIONTYPE_VECTOR3);
		hipsTrack.setKeys([
			{ frame: 0, value: Vector3.Zero() },
			{ frame: 30, value: new Vector3(0, 2, 0) },
		]);
		const handTrack = new Animation("HandRotation", "rotationQuaternion", 30, Animation.ANIMATIONTYPE_QUATERNION);
		handTrack.setKeys([
			{ frame: 0, value: Quaternion.Identity() },
			{ frame: 30, value: Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2) },
		]);
		group.addTargetedAnimation(hipsTrack, hips);
		group.addTargetedAnimation(handTrack, rightHand);

		const result = await executeModelImporterEntries(
			{
				meshes: [body],
				transformNodes: [characterRoot, armature, hips, rightHand],
				animationGroups: [group],
				skeletonCount: 1,
				skeletons: [skeleton],
			},
			normalizeModelImporterSettings({
				convertUnits: false,
				optimizeGameObjects: true,
				exposedTransforms: "Armature/Hips/RightHand",
				weldVertices: false,
				optimizeMesh: false,
			})
		);

		expect(result.rigOptimization).toMatchObject({
			enabled: true,
			candidateTransformCount: 3,
			optimizedTransformCount: 2,
			exposedTransformCount: 1,
			retargetedAnimationTrackCount: 2,
			resolvedExposedTransforms: ["CharacterRoot/Armature/Hips/RightHand"],
			missingExposedTransforms: [],
		});
		expect(armature.isDisposed()).toBe(true);
		expect(hips.isDisposed()).toBe(true);
		expect(rightHand.isDisposed()).toBe(false);
		expect(rightHand.parent).toBe(characterRoot);
		expect(armatureBone.getTransformNode()).toBeNull();
		expect(hipsBone.getTransformNode()).toBeNull();
		expect(handBone.getTransformNode()).toBeNull();
		expect(group.targetedAnimations.map((targeted) => targeted.target)).toEqual([hipsBone, handBone]);
		expect(getOptimizedModelRigExposedTransform(scene, "RightHand")).toBe(rightHand);
		const serialized = await SceneSerializer.SerializeAsync(scene);
		expect(serialized.skeletons[0].bones.every((bone: any) => bone.linkedTransformNodeId === undefined)).toBe(true);
		expect(serialized.animationGroups[0].targetedAnimations.map((targeted: any) => targeted.targetId)).toEqual(["Hips", "RightHand"]);

		handBone.position = new Vector3(2, 3, 4);
		expect(synchronizeOptimizedModelRigExposedTransforms(scene)).toBe(1);
		expect(rightHand.position.asArray()).toEqual([2, 4, 4]);
	});

	test("automatically exposes a linked transform that owns a non-skeleton attachment", async () => {
		const scene = new Scene(new NullEngine());
		const root = new TransformNode("Root", scene);
		const socket = new TransformNode("WeaponSocket", scene);
		socket.parent = root;
		const weapon = new Mesh("Sword", scene);
		weapon.parent = socket;
		const skeleton = new Skeleton("Skeleton", "skeleton", scene);
		const rootBone = new Bone("Root", skeleton, null, Matrix.Identity());
		const socketBone = new Bone("WeaponSocket", skeleton, rootBone, Matrix.Identity());
		rootBone.linkTransformNode(root);
		socketBone.linkTransformNode(socket);

		const result = await executeModelImporterEntries(
			{ meshes: [weapon], transformNodes: [root, socket], skeletonCount: 1, skeletons: [skeleton] },
			normalizeModelImporterSettings({ convertUnits: false, optimizeGameObjects: true, weldVertices: false, optimizeMesh: false })
		);
		expect(result.rigOptimization).toMatchObject({
			candidateTransformCount: 2,
			optimizedTransformCount: 1,
			exposedTransformCount: 1,
			automaticallyExposedTransforms: ["Root/WeaponSocket"],
		});
		expect(socket.isDisposed()).toBe(false);
		expect(weapon.parent).toBe(socket);
	});

	test("validates bounded Assimp GLB2 conversion output", () => {
		const glb = new Uint8Array(20);
		const view = new DataView(glb.buffer);
		view.setUint32(0, 0x46546c67, true);
		view.setUint32(4, 2, true);
		view.setUint32(8, glb.length, true);
		const runtime = {
			FileList: class {
				public AddFile(_name: string, _content: Uint8Array): void {}
			},
			ConvertFileList: () => ({
				IsSuccess: () => true,
				FileCount: () => 1,
				GetErrorCode: () => "no_error",
				GetFile: () => ({ GetContent: () => glb }),
			}),
			ConvertFile: () => ({
				IsSuccess: () => true,
				FileCount: () => 1,
				GetErrorCode: () => "no_error",
				GetFile: () => ({ GetContent: () => glb }),
			}),
		} as IAssimpRuntime;
		expect(convertAssimpModelToGlb(runtime, [{ name: "model.fbx", content: new Uint8Array([1, 2, 3]) }])).toMatchObject({
			inputFileCount: 1,
			inputBytes: 3,
			outputBytes: 20,
		});
		expect(() => convertAssimpModelToGlb(runtime, [{ name: "../outside.fbx", content: new Uint8Array() }])).toThrow("not contained");
	});
});
