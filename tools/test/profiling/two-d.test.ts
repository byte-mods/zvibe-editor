import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, test } from "vitest";

import { parsePortableProfilerCapture, serializePortableProfilerCapture, startPortableProfilerCapture } from "../../src/profiling/profiling";
import { measurePortableProfiler2D } from "../../src/profiling/two-d";

describe("portable 2D atlas profiling", () => {
	let engine: NullEngine | null = null;

	afterEach(() => {
		engine?.dispose();
		engine = null;
	});

	function scene(): Scene {
		engine = new NullEngine();
		const result = new Scene(engine);
		result.activeCamera = new FreeCamera("Camera", Vector3.Zero(), result);
		return result;
	}

	test("measures grid and packed atlas occupancy while deduplicating shared textures", () => {
		const target = scene();
		const sharedTexture = {
			name: "sprites.png",
			getSize: () => ({ width: 128, height: 64 }),
			getInternalTexture: () => {
				throw new Error("provider is disposed");
			},
		};
		const gridManager = {
			name: "Grid",
			texture: sharedTexture,
			cellWidth: 32,
			cellHeight: 32,
			sprites: [
				{ cellIndex: 0, isVisible: true },
				{ cellIndex: 3, isVisible: false },
			],
			dispose: () => undefined,
		};
		(target as any).spriteManagers = [gridManager];

		const mapNode = new TransformNode("Map", target) as any;
		mapNode.id = "map-node";
		mapNode.getClassName = () => "SpriteMapNode";
		mapNode.tiles = [{ tile: "grass" }, { tile: "grass" }];
		mapNode.spriteMap = {
			name: "Map",
			spriteSheet: sharedTexture,
			atlasJSON: {
				frames: {
					grass: { frame: { x: 0, y: 0, w: 16, h: 16 } },
					stone: { frame: { x: 16, y: 0, w: 16, h: 16 }, rotated: true },
				},
			},
		};

		const snapshot = measurePortableProfiler2D(target);
		expect(snapshot.metrics).toMatchObject({
			atlasOwners: 2,
			spriteManagers: 1,
			spriteMaps: 1,
			uniqueTextures: 1,
			texturePixels: 8_192,
			estimatedTextureBytes: 32_768,
			definedRegions: 10,
			usedRegions: 3,
			spriteCount: 2,
			visibleSpriteCount: 1,
			tileCount: 2,
			estimatedDrawCalls: 2,
		});
		expect(snapshot.atlases.find((atlas) => atlas.kind === "sprite-map")).toMatchObject({
			regionCount: 2,
			usedRegionCount: 1,
			regions: [expect.objectContaining({ name: "grass", used: true, usageCount: 2 }), expect.objectContaining({ name: "stone", rotated: true, used: false })],
		});
	});

	test("bounds usage scans without losing total owner counts", () => {
		const target = scene();
		(target as any).spriteManagers = [
			{
				name: "Large",
				texture: { name: "large.png", getSize: () => ({ width: 32, height: 32 }) },
				cellWidth: 32,
				cellHeight: 32,
				sprites: Array.from({ length: 65_537 }, () => ({ cellIndex: 0, isVisible: true })),
				dispose: () => undefined,
			},
		];

		const snapshot = measurePortableProfiler2D(target);
		expect(snapshot).toMatchObject({ truncated: true, metrics: { spriteCount: 65_537, visibleSpriteCount: 65_536 } });
		expect(snapshot.atlases[0].warnings).toContain("Usage evidence is bounded to 65,536 sprite/tile records across all atlases.");
		expect(snapshot.limitations.at(-1)).toContain("usage-record ceiling");
	});

	test("records aggregate 2D frames and strictly upgrades v1 captures", () => {
		const target = scene();
		(target as any).spriteManagers = [
			{
				name: "Grid",
				texture: { name: "grid.png", getSize: () => ({ width: 64, height: 64 }) },
				cellWidth: 32,
				cellHeight: 32,
				sprites: [{ cellIndex: 0, isVisible: true }],
				dispose: () => undefined,
			},
		];
		const session = startPortableProfilerCapture(target, { name: "2D capture", maximumFrames: 1, modules: ["2d"] });
		target.onAfterRenderObservable.notifyObservers(target);
		expect(session.capture.frames[0].twoD).toMatchObject({ atlasOwners: 1, definedRegions: 4, usedRegions: 1 });
		expect(session.capture.summary.metrics["twoD.usedRegions"].latest).toBe(1);

		const v1 = JSON.parse(serializePortableProfilerCapture(session.capture));
		v1.version = 1;
		v1.modules = ["cpu"];
		delete v1.availability["2d"];
		v1.availability.cpu = { available: true, precision: "engine-counter", reason: null };
		v1.frames[0].cpu = {
			frameTimeMs: 1,
			interFrameTimeMs: null,
			renderTimeMs: null,
			activeMeshesEvaluationTimeMs: null,
			renderTargetsTimeMs: null,
			animationsTimeMs: null,
			physicsTimeMs: null,
			particlesTimeMs: null,
			spritesTimeMs: null,
			cameraRenderTimeMs: null,
			scriptTimeMs: 0,
			scriptCalls: 0,
			scriptErrors: 0,
		};
		v1.frames[0].twoD = undefined;
		delete v1.frames[0].twoD;
		v1.summary = { frames: 1, durationMs: v1.frames[0].elapsedMs, metrics: {}, markers: [], assetRequests: 0, assetTransferBytes: null };
		const upgraded = parsePortableProfilerCapture(JSON.stringify(v1));
		expect(upgraded).toMatchObject({ version: 2, availability: { "2d": { available: false, precision: "unavailable" } } });
		expect(upgraded.frames[0].twoD).toBeNull();

		v1.frames[0].unexpected = true;
		expect(() => parsePortableProfilerCapture(JSON.stringify(v1))).toThrow("invalid");
	});
});
