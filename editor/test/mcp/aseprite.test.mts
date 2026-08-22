import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdir, mkdtemp, remove, writeFile, writeJSON } from "fs-extra";
import sharp from "sharp";
import { NullEngine, Scene, SceneSerializer, TransformNode } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SpriteManagerNode } from "../../src/editor/nodes/sprite-manager";
import {
	applyAsepriteImport,
	controlAsepriteAnimation,
	deleteAsepriteInstance,
	getAsepriteCapabilities,
	getAsepriteInstance,
	inspectAsepriteImport,
	instantiateAsepriteAsset,
	listAsepriteInstances,
} from "../../src/mcp/assets/aseprite";
import { applyAsepriteImporterArtifact, getAsepriteImporterArtifactStatus } from "../../src/mcp/assets/aseprite-importer";
import { readAssetMetadata } from "../../src/mcp/assets/registry";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { projectConfiguration } from "../../src/project/configuration";

vi.mock("../../src/mcp/assets/aseprite-importer", async (importOriginal) => ({
	...(await importOriginal<any>()),
	getAsepriteImporterArtifactStatus: vi.fn(),
	applyAsepriteImporterArtifact: vi.fn(),
}));

function frame(name: string, frameIndex: number, layerIndex: number | null, x: number): any {
	return {
		name,
		frameIndex,
		layerIndex,
		durationMs: frameIndex ? 120 : 50,
		frame: { x, y: 0, w: 2, h: 2 },
		rotated: false,
		trimmed: true,
		empty: false,
		spriteSourceSize: { x: 0, y: 0, w: 2, h: 2 },
		sourceSize: { w: 2, h: 2 },
		pivot: { x: 0.5, y: 0.5 },
	};
}

describe("Aseprite Editor scene lifecycle", () => {
	let directory: string;
	let sourcePath: string;
	let atlasJsonPath: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	let options: any;
	let result: any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-aseprite-scene-"));
		await mkdir(join(directory, "assets"), { recursive: true });
		await mkdir(join(directory, ".bjseditor", "imported-assets", "fixture"), { recursive: true });
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		sourcePath = join(directory, "assets", "hero.aseprite");
		await writeFile(sourcePath, Buffer.alloc(128));
		await readAssetMetadata(sourcePath);
		const atlasImagePath = join(directory, ".bjseditor", "imported-assets", "fixture", "atlas.png");
		atlasJsonPath = join(directory, ".bjseditor", "imported-assets", "fixture", "atlas.json");
		await sharp({ create: { width: 16, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
			.png()
			.toFile(atlasImagePath);
		const frames = [
			frame("composite/frame-0000", 0, null, 0),
			frame("composite/frame-0001", 1, null, 2),
			frame("layer-0001-Hero/frame-0000", 0, 1, 4),
			frame("layer-0001-Hero/frame-0001", 1, 1, 6),
			frame("layer-0002-Weapon/frame-0000", 0, 2, 8),
			frame("layer-0002-Weapon/frame-0001", 1, 2, 10),
		];
		result = {
			model: "bounded-native-aseprite-importer-v1",
			sourcePath,
			sourceBytes: 128,
			sourceSha256: "b".repeat(64),
			settings: {
				includeHiddenLayers: false,
				layerMode: "compositeAndLayers",
				trimSprites: true,
				ignoreEmptyFrames: false,
				mergeDuplicates: true,
				padding: 2,
				extrude: 1,
				powerOfTwo: true,
				maximumAtlasSize: 4096,
				importTags: true,
				importSlices: true,
				pivotMode: "sliceOrCenter",
				pixelsPerUnit: 100,
			},
			settingsSha256: "c".repeat(64),
			dependencies: [],
			atlasImagePath,
			atlasImageBytes: 1,
			atlasImageSha256: "d".repeat(64),
			atlasJsonPath,
			atlasJsonBytes: 1,
			atlasJsonSha256: "e".repeat(64),
			document: {
				width: 2,
				height: 2,
				colorDepth: 32,
				frameCount: 2,
				frameDurationsMs: [50, 120],
				celUserData: [{ frameIndex: 1, layerIndex: 1, text: "Footstep", color: [1, 2, 3, 255] }],
				layers: [
					{ index: 0, name: "Body", type: "group", parentIndex: null, visible: true },
					{ index: 1, name: "Hero", type: "image", parentIndex: 0, visible: true },
					{ index: 2, name: "Weapon", type: "image", parentIndex: 0, visible: true },
				],
				externalFiles: [],
				tilesets: [],
				tags: [{ name: "Bounce", from: 0, to: 1, direction: "pingpong", repeat: 0, color: [0, 0, 0, 255] }],
				slices: [],
				colorProfile: { type: "srgb", gamma: null, iccBytes: 0 },
				pixelRatio: { width: 1, height: 1 },
				grid: { x: 0, y: 0, width: 16, height: 16 },
				warnings: [],
				statistics: { celCount: 4 },
			},
			atlas: {
				model: "zvibe-aseprite-atlas-v1",
				width: 16,
				height: 2,
				frames,
				frameTags: [{ name: "Bounce", from: 0, to: 1, direction: "pingpong", repeat: 0, color: [0, 0, 0, 255] }],
				slices: [],
				layers: [],
				settings: {},
				statistics: { entryCount: frames.length },
			},
		};
		await writeJSON(atlasJsonPath, {
			frames: Object.fromEntries(frames.map((entry: any) => [entry.name, entry])),
			meta: { image: "atlas.png", size: { w: 16, h: 2 } },
		});
		vi.mocked(getAsepriteImporterArtifactStatus).mockResolvedValue({
			path: sourcePath,
			artifactDirectory: join(directory, ".bjseditor", "imported-assets", "fixture"),
			manifestPath: join(directory, ".bjseditor", "imported-assets", "fixture", "aseprite-import.json"),
			fingerprint: "a".repeat(64),
			sourceSha256: result.sourceSha256,
			dependencies: [],
			current: true,
			exists: true,
			result,
		});
		vi.mocked(applyAsepriteImporterArtifact).mockResolvedValue(await getAsepriteImporterArtifactStatus(sourcePath));
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				sceneWorkspace: { claimNewObjectsForActiveScene: vi.fn() },
				layout: {
					assets: { refresh: vi.fn() },
					graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				},
			},
		};
	});

	afterEach(async () => {
		vi.mocked(getAsepriteImporterArtifactStatus).mockReset();
		vi.mocked(applyAsepriteImporterArtifact).mockReset();
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("inspects bounded evidence and applies only an exact confirmed lease", async () => {
		expect(getAsepriteCapabilities()).toMatchObject({
			importerModel: "bounded-native-aseprite-importer-v1",
			animationDirections: expect.arrayContaining(["pingpong_reverse"]),
		});
		for (const endpoint of [
			"get_aseprite_capabilities",
			"inspect_aseprite_import",
			"apply_aseprite_import",
			"instantiate_aseprite_asset",
			"list_aseprite_instances",
			"get_aseprite_instance",
			"control_aseprite_animation",
			"delete_aseprite_instance",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const inspected = await inspectAsepriteImport(scene, { path: "assets/hero.aseprite", layerLimit: 1, frameOffset: 1, frameLimit: 2 });
		expect(inspected).toMatchObject({
			path: "assets/hero.aseprite",
			current: true,
			artifact: { layers: { total: 3, count: 1, nextOffset: 1 }, frames: { total: 6, offset: 1, count: 2, nextOffset: 3 } },
		});
		await expect(applyAsepriteImport(scene, { path: "assets/hero.aseprite", expectedFingerprint: "a".repeat(64) }, options)).rejects.toThrow(/confirm=true/i);
		const applied = await applyAsepriteImport(scene, { path: "assets/hero.aseprite", expectedFingerprint: "a".repeat(64), confirm: true }, options);
		expect(applied.current).toBe(true);
		expect(applyAsepriteImporterArtifact).toHaveBeenCalledWith(sourcePath, "a".repeat(64));
	});

	test("instantiates composite and mirrored layer hierarchies with exact playback metadata", async () => {
		const parent = new TransformNode("Parent", scene);
		const composite = await instantiateAsepriteAsset(
			scene,
			{ path: "assets/hero.aseprite", id: "hero-composite", parentId: parent.id, position: [10, 20, 30], animationName: "Bounce", playOnAwake: false },
			options
		);
		expect(composite).toMatchObject({
			root: { id: "hero-composite", position: [10, 20, 30] },
			mode: "composite",
			managerCount: 1,
			managers: [{ animationName: "Bounce", frameCount: 2, playing: false }],
		});
		expect(scene.getNodeById("hero-composite")?.parent).toBe(parent);

		const layers = await instantiateAsepriteAsset(scene, { path: sourcePath, id: "hero-layers", mode: "layers", animationName: "Bounce" }, options);
		expect(layers).toMatchObject({ mode: "layers", managerCount: 2, managers: [{ layerIndex: 1 }, { layerIndex: 2 }] });
		const group = scene.getTransformNodeById("hero-layers:group-0")!;
		expect(scene.getTransformNodeById("hero-layers:layer-1")?.parent).toBe(group);
		expect(group.parent?.id).toBe("hero-layers");
		expect(options.editor.sceneWorkspace.claimNewObjectsForActiveScene).toHaveBeenCalledTimes(2);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(50);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const heroSprite = (scene.getTransformNodeById("hero-layers:layer-1") as SpriteManagerNode).spriteManager!.sprites[0];
		expect(heroSprite).toMatchObject({ cellRef: "layer-0001-Hero/frame-0001", metadata: { spriteAnimationPlayback: { frameCursor: 1, elapsedMs: 0 } } });
		expect(scene.metadata.babylonEditorSpriteAnimationEventLog).toEqual([expect.objectContaining({ animationName: "Bounce", sourceFrame: 1, text: "Footstep" })]);
	});

	test("serializes and reparses atlas identity, animations, playback, and local transforms", async () => {
		await instantiateAsepriteAsset(scene, { path: sourcePath, id: "persistent", animationName: "Bounce", playOnAwake: false }, options);
		const serialized: any = SceneSerializer.Serialize(scene);
		const rootData = serialized.transformNodes.find((entry: any) => entry.id === "persistent");
		const managerData = serialized.transformNodes.find((entry: any) => entry.id === "persistent:composite");
		expect(rootData.metadata.babylonEditorAsepriteAsset).toMatchObject({ sourcePath: "assets/hero.aseprite", mode: "composite" });
		expect(managerData.atlasJsonRelativePath).toBe(".bjseditor/imported-assets/fixture/atlas.json");
		expect(managerData.spriteManager.sprites[0].metadata).toMatchObject({
			spriteAnimations: [{ name: "Bounce", frames: [{ durationMs: 50 }, { durationMs: 120 }] }],
			spriteAnimationPlayback: { name: "Bounce", playing: false },
			babylonEditorLocalSpriteTransform: { width: 2, height: 2 },
		});
		const reopenedEngine = new NullEngine();
		const reopened = new Scene(reopenedEngine);
		const parsed = SpriteManagerNode.Parse(managerData, reopened, `${directory}/`);
		expect(parsed.spriteManager?.sprites[0].metadata).toMatchObject({ spriteAnimations: [{ name: "Bounce" }], spriteAnimationPlayback: { playing: false } });
		parsed.dispose();
		reopened.dispose();
		reopenedEngine.dispose();
	});

	test("lists, inspects, revision-controls, seeks, resumes, stops, and deletes a complete layer instance", async () => {
		await instantiateAsepriteAsset(scene, { path: sourcePath, id: "controlled", mode: "layers", animationName: "Bounce", playOnAwake: false }, options);
		expect(listAsepriteInstances(scene)).toMatchObject({ total: 1, instances: [{ id: "controlled", metadata: { revision: 1 }, managerCount: 2, managerPage: { count: 0 } }] });
		expect(getAsepriteInstance(scene, { id: "controlled", managerLimit: 1 })).toMatchObject({ managerPage: { total: 2, count: 1, nextOffset: 1 } });
		const sought = controlAsepriteAnimation(scene, { id: "controlled", expectedRevision: 1, action: "seek", animationName: "Bounce", frameCursor: 1, elapsedMs: 10 }, options);
		expect(sought.metadata.revision).toBe(2);
		expect(sought.managerPage.items.every((item: any) => item.playback.playing === false && item.playback.frameCursor === 1 && item.playback.elapsedMs === 10)).toBe(true);
		expect(() => controlAsepriteAnimation(scene, { id: "controlled", expectedRevision: 1, action: "play" }, options)).toThrow(/revision changed/i);
		const resumed = controlAsepriteAnimation(scene, { id: "controlled", expectedRevision: 2, action: "play" }, options);
		expect(resumed.metadata.revision).toBe(3);
		expect(resumed.managerPage.items.every((item: any) => item.playback.playing === true && item.playback.frameCursor === 1 && item.playback.elapsedMs === 10)).toBe(true);
		const paused = controlAsepriteAnimation(scene, { id: "controlled", expectedRevision: 3, action: "pause" }, options);
		expect(paused.metadata.revision).toBe(4);
		expect(paused.managerPage.items.every((item: any) => item.playback.playing === false && item.playback.frameCursor === 1)).toBe(true);
		const stopped = controlAsepriteAnimation(scene, { id: "controlled", expectedRevision: 4, action: "stop" }, options);
		expect(stopped.metadata.revision).toBe(5);
		expect(stopped.managerPage.items.every((item: any) => item.playback.playing === false && item.playback.frameCursor === 0 && item.playback.elapsedMs === 0)).toBe(true);
		expect(() => controlAsepriteAnimation(scene, { id: "controlled", expectedRevision: 5, action: "play", animationName: "Missing" }, options)).toThrow(/unavailable/i);
		expect(getAsepriteInstance(scene, { id: "controlled" }).metadata.revision).toBe(5);
		expect(() => deleteAsepriteInstance(scene, { id: "controlled", confirm: false }, options)).toThrow(/confirm=true/i);
		expect(deleteAsepriteInstance(scene, { id: "controlled", confirm: true }, options)).toEqual({ deleted: true, id: "controlled" });
		expect(listAsepriteInstances(scene).total).toBe(0);
	});

	test("restarts a completed finite animation instead of resuming its terminal playback state", async () => {
		result.document.tags[0].repeat = 1;
		await instantiateAsepriteAsset(scene, { path: sourcePath, id: "finite", animationName: "Bounce", playOnAwake: false }, options);
		const manager = scene.getTransformNodeById("finite:composite") as SpriteManagerNode;
		const sprite = manager.spriteManager!.sprites[0];
		sprite.metadata.spriteAnimations[0].repeat = 1;
		sprite.metadata.spriteAnimationPlayback.frameCursor = 1;
		sprite.metadata.spriteAnimationPlayback.elapsedMs = 119;
		sprite.metadata.spriteAnimationPlayback.completedCycles = 1;
		const played = controlAsepriteAnimation(scene, { id: "finite", expectedRevision: 1, action: "play" }, options);
		expect(played.managerPage.items[0].playback).toMatchObject({ playing: true, frameCursor: 0, elapsedMs: 0, completedCycles: 0 });
	});

	test("rejects stale choices and rolls back partial roots when animation selection fails", async () => {
		await expect(instantiateAsepriteAsset(scene, { path: "../outside.aseprite" }, options)).rejects.toThrow(/inside the open project/i);
		await expect(instantiateAsepriteAsset(scene, { path: sourcePath, id: "bad", animationName: "Missing" }, options)).rejects.toThrow(/was not found/i);
		expect(scene.getNodeById("bad")).toBeNull();
		await expect(instantiateAsepriteAsset(scene, { path: sourcePath, id: "bad-speed", speed: 0, playOnAwake: false }, options)).rejects.toThrow(/speed/i);
		expect(scene.getNodeById("bad-speed")).toBeNull();
		new TransformNode("duplicate", scene).id = "duplicate-id";
		await expect(instantiateAsepriteAsset(scene, { path: sourcePath, id: "duplicate-id" }, options)).rejects.toThrow(/already uses/i);
		result.settings.layerMode = "composite";
		await expect(instantiateAsepriteAsset(scene, { path: sourcePath, mode: "layers" }, options)).rejects.toThrow(/compositeAndLayers/i);
		vi.mocked(getAsepriteImporterArtifactStatus).mockResolvedValue({ ...(await getAsepriteImporterArtifactStatus(sourcePath)), current: false, result: null });
		await expect(instantiateAsepriteAsset(scene, { path: sourcePath }, options)).rejects.toThrow(/missing or stale/i);
	});
});
