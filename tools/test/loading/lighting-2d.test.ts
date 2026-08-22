import { afterEach, describe, expect, test, vi } from "vitest";

import { Buffer } from "node:buffer";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Effect } from "@babylonjs/core/Materials/effect";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SceneSerializer } from "@babylonjs/core/Misc/sceneSerializer";
import { Scene } from "@babylonjs/core/scene";
import { SpriteMap } from "@babylonjs/core/Sprites/spriteMap";

import {
	configureLighting2D,
	disposeLighting2D,
	evaluateLighting2DAtPoint,
	getLighting2DRuntimeEvidence,
	listLight2DProviderTypes,
	listShadowShape2DProviderTypes,
	normalizeLight2DComponentData,
	normalizeShadowCaster2DComponentData,
	registerLight2DProvider,
	registerShadowShape2DProvider,
	validateLight2DComponentData,
	validateShadowCaster2DComponentData,
} from "../../src/loading/lighting-2d";
import type { SpriteMapNode } from "../../src/tools/sprite";
import { loadSceneAdditive } from "../../src/loading/additive-scene";
import { getRuntimeGameObjectComponentsByType } from "../../src/loading/game-object-components";

describe("loading/lighting-2d", () => {
	const disposals: Array<() => void> = [];

	afterEach(() =>
		disposals
			.splice(0)
			.reverse()
			.forEach((dispose) => dispose())
	);

	test("normalizes bounded built-ins and strictly validates custom provider identity", () => {
		expect(normalizeLight2DComponentData({})).toMatchObject({ model: "unity-light2d-v1", version: 1, lightType: "point", providerId: "builtin.point" });
		expect(normalizeShadowCaster2DComponentData({})).toMatchObject({
			model: "unity-shadow-caster2d-v1",
			version: 1,
			sourceType: "shape-editor",
			providerId: "builtin.shape-editor",
		});
		expect(() => validateLight2DComponentData({ lightType: "provider", providerId: "builtin.point" })).toThrow("non-built-in providerId");
		expect(() => validateShadowCaster2DComponentData({ sourceType: "provider", providerId: "builtin.node-bounds" })).toThrow("non-built-in providerId");
		expect(() => validateLight2DComponentData({ lightType: "point", providerId: "project.wrong" })).toThrow("must use providerId");
		expect(() => validateShadowCaster2DComponentData({ unexpected: true })).toThrow("unexpected is not supported");
		expect(() => validateLight2DComponentData({ providerData: { gain: Number.NaN } })).toThrow("finite JSON numbers");
		expect(() => validateShadowCaster2DComponentData({ providerData: { callback: () => true } })).toThrow("only JSON values");
		expect(listLight2DProviderTypes().map((provider) => provider.id)).toEqual(["builtin.global", "builtin.point", "builtin.freeform", "builtin.sprite"]);
		expect(listShadowShape2DProviderTypes().map((provider) => provider.id)).toEqual(["builtin.shape-editor", "builtin.node-bounds"]);
	});

	test("captures provider defaults once and rejects invalid default JSON at registration", () => {
		let defaultCalls = 0;
		disposals.push(
			registerLight2DProvider({
				id: "tests.cached-defaults",
				dataVersion: 1,
				setDefaultValues: () => {
					defaultCalls++;
					return { gain: 2 };
				},
				getShape: () => ({ kind: "global" }),
			})
		);
		expect(listLight2DProviderTypes().find((provider) => provider.id === "tests.cached-defaults")?.defaultData).toEqual({ gain: 2 });
		expect(listLight2DProviderTypes().find((provider) => provider.id === "tests.cached-defaults")?.defaultData).toEqual({ gain: 2 });
		expect(defaultCalls).toBe(1);
		expect(() =>
			registerShadowShape2DProvider({
				id: "tests.invalid-defaults",
				dataVersion: 1,
				setDefaultValues: () => ({ strength: Number.POSITIVE_INFINITY }),
				onBeforeRender: () => undefined,
			})
		).toThrow("finite JSON numbers");
	});

	test("guards runtime evaluation against provider-triggered re-entry", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		disposals.push(() => {
			disposeLighting2D(scene);
			scene.dispose();
			engine.dispose();
		});
		disposals.push(
			registerLight2DProvider({
				id: "tests.reentrant",
				dataVersion: 1,
				getShape: (context) => {
					configureLighting2D(context.scene);
					return { kind: "global" };
				},
			})
		);
		const light = new TransformNode("Reentrant Light", scene);
		light.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "reentrant", type: "light2d", enabled: true, data: { lightType: "provider", providerId: "tests.reentrant" } }],
			},
		};

		configureLighting2D(scene);
		expect(getLighting2DRuntimeEvidence(scene)).toMatchObject({ frameCount: 1, activeLightCount: 1 });
	});

	test("applies CPU Light2D colors through the SpriteManager vertex consumer", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const vertexData = new Float32Array(18);
		const sprite = { position: { x: 0, y: 0 } } as any;
		const renderer = {
			_vertexBufferSize: 18,
			_useInstancing: false,
			_vertexData: vertexData,
			_appendSpriteVertex(index: number): void {
				const offset = index * this._vertexBufferSize;
				this._vertexData[offset + 14] = 1;
				this._vertexData[offset + 15] = 1;
				this._vertexData[offset + 16] = 1;
			},
		};
		const manager = { name: "CPU Sprite Manager", sprites: [sprite], spriteRenderer: renderer } as any;
		const owner = new TransformNode("CPU Sprite Manager", scene) as any;
		owner.isSpriteManager = true;
		owner.spriteManager = manager;
		const light = new TransformNode("Red Global Light", scene);
		light.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "red-global", type: "light2d", enabled: true, data: { lightType: "global", providerId: "builtin.global", color: [1, 0, 0, 1] } }],
			},
		};
		disposals.push(() => {
			disposeLighting2D(scene);
			owner.dispose();
			light.dispose();
			scene.dispose();
			engine.dispose();
		});

		configureLighting2D(scene);
		(renderer._appendSpriteVertex as any)(0, sprite);
		expect(Array.from(vertexData.slice(14, 17))).toEqual([1, 0, 0]);
		expect(getLighting2DRuntimeEvidence(scene)).toMatchObject({ spriteManagerCount: 1, litSpriteCount: 1 });
		disposeLighting2D(scene);
		(renderer._appendSpriteVertex as any)(0, sprite);
		expect(Array.from(vertexData.slice(14, 17))).toEqual([1, 1, 1]);
	});

	test("runs project provider geometry and ShadowShape lifecycle with measured evidence", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		disposals.push(() => {
			disposeLighting2D(scene);
			scene.dispose();
			engine.dispose();
		});

		let shadowDestroyCount = 0;
		disposals.push(
			registerLight2DProvider<{ radius: number }, { evaluations: number }>({
				id: "tests.pulse-light",
				displayName: "Test Pulse",
				dataVersion: 3,
				setDefaultValues: () => ({ radius: 250 }),
				validate: (context) => (context.data.radius > 0 ? true : "radius must be positive"),
				create: () => ({ evaluations: 0 }),
				getShape: (context, state) => {
					state.evaluations++;
					return { kind: "radial", radius: context.data.radius };
				},
			})
		);
		disposals.push(
			registerShadowShape2DProvider<{ halfSize: number }, { enabled: boolean }>({
				id: "tests.box-shadow",
				displayName: "Test Box",
				dataVersion: 2,
				setDefaultValues: () => ({ halfSize: 25 }),
				validate: (context) => (context.data.halfSize > 0 ? true : "halfSize must be positive"),
				create: () => ({ enabled: false }),
				onInitialized: (_context, writer) => writer.clear(),
				enabled: (_context, _writer, state) => (state.enabled = true),
				disabled: (_context, _writer, state) => (state.enabled = false),
				onBeforeRender: (context, writer) => {
					const half = context.data.halfSize;
					writer.setShape([
						[-half, -half],
						[half, -half],
						[half, half],
						[-half, half],
					]);
				},
				destroy: () => shadowDestroyCount++,
			})
		);

		const light = new TransformNode("Provider Light", scene);
		light.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "light-provider",
						type: "light2d",
						enabled: true,
						data: { lightType: "provider", providerId: "tests.pulse-light", providerVersion: 3, providerData: { radius: 250 } },
					},
				],
			},
		};
		const caster = new TransformNode("Provider Caster", scene);
		caster.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "shadow-provider",
						type: "shadowcaster2d",
						enabled: true,
						data: { sourceType: "provider", providerId: "tests.box-shadow", providerVersion: 2, providerData: { halfSize: 25 } },
					},
				],
			},
		};

		configureLighting2D(scene);
		configureLighting2D(scene);
		let evidence = getLighting2DRuntimeEvidence(scene) as any;
		expect(evidence).toMatchObject({ configured: true, activeLightCount: 1, activeCasterCount: 1, frameCount: 2 });
		expect(evidence.providers.find((provider: any) => provider.componentId === "light-provider")).toMatchObject({
			providerId: "tests.pulse-light",
			registeredVersion: 3,
			valid: true,
			initializedCount: 1,
			beforeRenderCount: 2,
		});
		expect(evidence.providers.find((provider: any) => provider.componentId === "shadow-provider")).toMatchObject({
			providerId: "tests.box-shadow",
			registeredVersion: 2,
			valid: true,
			initializedCount: 1,
			enabledCount: 1,
			beforeRenderCount: 2,
			shapePointCount: 4,
		});

		caster.metadata.babylonEditorComponentStack.components[0].enabled = false;
		configureLighting2D(scene);
		evidence = getLighting2DRuntimeEvidence(scene) as any;
		expect(evidence.activeCasterCount).toBe(0);
		expect(evidence.providers.find((provider: any) => provider.componentId === "shadow-provider")).toMatchObject({ active: false, disabledCount: 1 });

		disposeLighting2D(scene);
		expect(shadowDestroyCount).toBe(1);
	});

	test("still destroys a shadow provider when its teardown disabled hook fails", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		let destroyCount = 0;
		disposals.push(
			registerShadowShape2DProvider({
				id: "tests.throwing-disabled",
				dataVersion: 1,
				onBeforeRender: (_context, writer) =>
					writer.setShape([
						[-1, -1],
						[1, -1],
						[0, 1],
					]),
				disabled: () => {
					throw new Error("expected teardown failure");
				},
				destroy: () => destroyCount++,
			})
		);
		const caster = new TransformNode("Throwing Caster", scene);
		caster.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "throwing-caster",
						type: "shadowcaster2d",
						enabled: true,
						data: { sourceType: "provider", providerId: "tests.throwing-disabled", providerVersion: 1 },
					},
				],
			},
		};

		configureLighting2D(scene);
		disposeLighting2D(scene);
		expect(destroyCount).toBe(1);
		caster.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("distinguishes cast-shadow receivers from self-shadow receivers", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const lightNode = new TransformNode("Point", scene);
		const casterNode = new TransformNode("Caster", scene);
		const otherReceiver = new TransformNode("Other Receiver", scene);
		const light = {
			node: lightNode,
			componentId: "point",
			data: normalizeLight2DComponentData({ lightType: "point", providerId: "builtin.point", shadowIntensity: 1 }),
			shape: { kind: "radial" as const, radius: 500 },
			worldCenter: [-10, 0] as [number, number],
			worldRadius: 500,
			worldDirectionRadians: 0,
			worldPoints: [],
		};
		const caster = {
			node: casterNode,
			componentId: "caster",
			data: normalizeShadowCaster2DComponentData({ castingOption: "cast-shadow" }),
			worldPoints: [
				[0, -10],
				[1, -10],
				[1, 10],
				[0, 10],
			] as Array<[number, number]>,
		};
		expect(evaluateLighting2DAtPoint([10, 0], [light], [caster], otherReceiver)).toEqual([0, 0, 0]);
		expect(evaluateLighting2DAtPoint([10, 0], [light], [caster], casterNode)[0]).toBeGreaterThan(0);

		caster.data = normalizeShadowCaster2DComponentData({ castingOption: "self-shadow" });
		expect(evaluateLighting2DAtPoint([10, 0], [light], [caster], casterNode)).toEqual([0, 0, 0]);
		expect(evaluateLighting2DAtPoint([10, 0], [light], [caster], otherReceiver)[0]).toBeGreaterThan(0);
		lightNode.dispose();
		casterNode.dispose();
		otherReceiver.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("patches and feeds a real SpriteMap consumer on a NullEngine", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const originalVertexShader = Effect.ShadersStore.spriteMapVertexShader;
		const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
		const name = "Lighting2DSpriteMapTest";
		const spriteMap = new SpriteMap(
			name,
			{
				frames: [
					{
						filename: "tile.png",
						frame: { x: 0, y: 0, w: 1, h: 1 },
						rotated: false,
						trimmed: false,
						spriteSourceSize: { x: 0, y: 0, w: 1, h: 1 },
						sourceSize: { w: 1, h: 1 },
					},
				],
			},
			texture,
			{ stageSize: new Vector2(2, 2), outputSize: new Vector2(200, 200) },
			scene
		);
		const owner = new TransformNode("Lit Map", scene) as SpriteMapNode;
		owner.isSpriteMap = true;
		owner.spriteMap = spriteMap;
		const light = new TransformNode("Point Light", scene);
		light.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "point", type: "light2d", enabled: true, data: { lightType: "point", providerId: "builtin.point", outerRadius: 500 } }],
			},
		};
		disposals.push(() => {
			disposeLighting2D(scene);
			spriteMap.dispose();
			texture.dispose();
			owner.dispose();
			light.dispose();
			scene.dispose();
			engine.dispose();
			Effect.ShadersStore.spriteMapVertexShader = originalVertexShader;
			delete Effect.ShadersStore[`spriteMap${name}PixelShader`];
		});

		configureLighting2D(scene);
		const evidence = getLighting2DRuntimeEvidence(scene) as any;
		expect(evidence).toMatchObject({ activeLightCount: 1, spriteMapCount: 1 });
		expect(Effect.ShadersStore.spriteMapVertexShader).toContain("babylonEditorLighting2DWorldPosition");
		expect(Effect.ShadersStore[`spriteMap${name}PixelShader`]).toContain("babylonEditorLighting2DEvaluate");
		expect(Effect.ShadersStore[`spriteMap${name}PixelShader`]).toContain("color.xyz*=colorMul;");
		expect((spriteMap as any)._material.options.uniforms).toEqual(expect.arrayContaining(["babylonEditorLighting2DEnabled", "babylonEditorLighting2DLightCount"]));
		const setFloat = vi.spyOn((spriteMap as any)._material, "setFloat");
		disposeLighting2D(scene);
		expect(setFloat).toHaveBeenCalledWith("babylonEditorLighting2DEnabled", 0);
	});

	test("round-trips components through Babylon serialization, additive runtime setup, and unload cleanup", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		const mesh = new Mesh("Serialized 2D Lighting", source);
		mesh.id = "serialized-lighting-2d";
		mesh.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{ id: "serialized-light", type: "light2d", enabled: true, data: { lightType: "global", providerId: "builtin.global" } },
					{ id: "serialized-caster", type: "shadowcaster2d", enabled: true, data: { sourceType: "node-bounds", providerId: "builtin.node-bounds" } },
				],
			},
		};
		const serialized = SceneSerializer.Serialize(source);
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const targetEngine = new NullEngine();
		const target = new Scene(targetEngine);
		const handle = await loadSceneAdditive("", dataUrl, target, {});
		const loaded = handle.getNodeById("serialized-lighting-2d")!;
		expect(getRuntimeGameObjectComponentsByType(loaded, "light2d")[0]).toMatchObject({ id: "serialized-light", enabled: true, data: { providerId: "builtin.global" } });
		expect(getRuntimeGameObjectComponentsByType(loaded, "shadowcaster2d")[0]).toMatchObject({ id: "serialized-caster", enabled: true });
		expect(getLighting2DRuntimeEvidence(target)).toMatchObject({ configured: true, activeLightCount: 1, activeCasterCount: 1 });

		await handle.unload();
		expect(getRuntimeGameObjectComponentsByType(loaded, "light2d")).toEqual([]);
		expect(getLighting2DRuntimeEvidence(target)).toMatchObject({ configured: true, activeLightCount: 0, activeCasterCount: 0 });
		target.dispose();
		targetEngine.dispose();
	});
});
