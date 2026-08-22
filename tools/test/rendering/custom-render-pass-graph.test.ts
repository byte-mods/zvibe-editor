import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Scene } from "@babylonjs/core/scene";

import {
	applyCustomRenderPassGraph,
	captureCustomRenderPassFrame,
	configureCustomRenderPassFrameIsolation,
	configureCustomRenderPassGpuProfiling,
	configureCustomRenderPassGraph,
	defaultCustomRenderPassComputeShader,
	defaultCustomRenderPassFragmentShader,
	disposeCustomRenderPassGraph,
	getCustomRenderPassDiagnostics,
	getCustomRenderPassGpuProfile,
	getCustomRenderPassFrameIsolation,
	getCustomRenderPassFrameSnapshot,
	getCustomRenderPassOutputTexture,
	getCustomRenderPassPostProcesses,
	getCustomRenderPassRuntimeError,
	getCustomRenderPassSceneRasterTargets,
	getCustomRenderPassSchedule,
	ICustomRenderPassDefinition,
	readCustomRenderPassOutputPixels,
	readCustomRenderPassComputeStorageBuffer,
	sortCustomRenderPassGraph,
	updateCustomRenderPassComputeStorageBuffer,
	updateCustomRenderPassComputeUniformBuffer,
} from "../../src/rendering/custom-render-pass-graph";
import { rendererListsMetadataKey } from "../../src/rendering/renderer-lists";

function pass(id: string, order: number, dependencies: string[] = []): ICustomRenderPassDefinition {
	return {
		id,
		name: id,
		passType: "shader",
		injectionPoint: "afterRenderingPostProcessing",
		rendererFeature: null,
		copySource: { source: "screen" },
		rasterSettings: {
			cameraId: null,
			meshIds: [],
			includeDescendants: false,
			layerMask: null,
			materialId: null,
			clearColor: [0, 0, 0, 0],
			clearMode: "colorDepth",
			depthTest: true,
			depthWrite: true,
			cullMode: "back",
			blendMode: "opaque",
			renderParticles: false,
			renderSprites: false,
			useCameraPostProcesses: false,
			refreshRate: "everyFrame",
		},
		computeSettings: {
			wgsl: defaultCustomRenderPassComputeShader,
			entryPoint: "main",
			outputBindingName: "outputTexture",
			outputGroup: 0,
			outputBinding: 0,
			dispatch: [1, 1, 1],
			dispatchMode: "everyFrame",
			dispatchType: "direct",
			indirectBuffer: null,
			indirectOffset: 0,
			uniformBuffers: [],
			storageBuffers: [],
			submitAfterDispatch: false,
			nodeGraph: null,
		},
		enabled: true,
		order,
		dependencies,
		fragmentShader: defaultCustomRenderPassFragmentShader,
		uniforms: {},
		inputs: {},
		output: null,
		outputType: "uint8",
		outputFormat: "rgba",
		outputSamples: 1,
		additionalOutputs: [],
		ratio: 1,
		samplingMode: "bilinear",
	};
}

describe("rendering/custom-render-pass-graph", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
	});

	afterEach(() => {
		disposeCustomRenderPassGraph(camera);
		scene.dispose();
		engine.dispose();
	});

	test("topologically orders dependency-ready passes by authored order", () => {
		const first = pass("first", 10);
		const independent = pass("independent", 0);
		const dependent = pass("dependent", -10, ["first"]);
		expect(sortCustomRenderPassGraph([dependent, first, independent]).map((value) => value.id)).toEqual(["independent", "first", "dependent"]);
		expect(() => sortCustomRenderPassGraph([pass("a", 0, ["b"]), pass("b", 0, ["a"])] as ICustomRenderPassDefinition[])).toThrow("cycle");
		expect(() => sortCustomRenderPassGraph([pass("a", 0, ["missing"])] as ICustomRenderPassDefinition[])).toThrow("missing dependency");
	});

	test("normalizes and validates honest runtime injection points", () => {
		const legacy = pass("legacy", 0) as any;
		delete legacy.injectionPoint;
		delete legacy.rendererFeature;
		expect(sortCustomRenderPassGraph([legacy])[0]).toMatchObject({ injectionPoint: "afterRenderingPostProcessing", rendererFeature: null });

		expect(() =>
			sortCustomRenderPassGraph([{ ...pass("invalid-raster", 0), passType: "raster", injectionPoint: "afterRenderingPostProcessing", output: "rasterColor" }])
		).toThrow("must use beforeRendering");
		expect(() => sortCustomRenderPassGraph([{ ...pass("invalid-compute", 0), passType: "compute", injectionPoint: "beforeRendering", output: "computeColor" }])).toThrow(
			"must use afterRenderingPrePasses"
		);
		const later = { ...pass("later", 0), injectionPoint: "afterRenderingPostProcessing" as const };
		const earlier = { ...pass("earlier", 0, [later.id]), injectionPoint: "beforeRenderingPostProcessing" as const };
		expect(() => sortCustomRenderPassGraph([earlier, later])).toThrow("cannot depend on later injection point");
	});

	test("places before/after feature subpasses around the existing camera post-process chain", () => {
		const baseline = new PostProcess("Baseline Camera Effect", "pass", [], [], 1, camera);
		const before = { ...pass("before-camera-effects", 10), injectionPoint: "beforeRenderingPostProcessing" as const };
		const after = { ...pass("after-camera-effects", -10), injectionPoint: "afterRenderingPostProcessing" as const };
		applyCustomRenderPassGraph(scene, camera, [after, before]);
		const chain = ((camera as any)._postProcesses as PostProcess[]).filter(Boolean).map((value) => value.name);
		expect(chain).toEqual([before.name, baseline.name, after.name]);
		baseline.dispose(camera);
	});

	test("culls filtered renderer-feature passes and their external dependency closure", () => {
		const producer = {
			...pass("filtered-feature", 0),
			output: "filteredColor",
			rendererFeature: {
				instanceId: "feature-instance",
				assetId: "feature-asset",
				assetPath: "assets/rendering/feature.renderfeature.json",
				assetRevision: "a".repeat(64),
				sourcePassId: "source-pass",
				sourceEnabled: true,
				sourceOrder: 0,
				cameraFilter: { cameraIds: ["different-camera"], excludeCameraIds: [], projection: "any" as const, layerMask: null },
			},
		};
		const consumer = {
			...pass("external-consumer", 1, [producer.id]),
			fragmentShader:
				"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D featureSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(featureSampler, vUV); }",
			inputs: { featureSampler: { source: "pass" as const, output: producer.output } },
		};
		const unrelated = pass("unrelated", 2);
		expect(applyCustomRenderPassGraph(scene, camera, [producer, consumer, unrelated]).map((value) => value.id)).toEqual([unrelated.id]);
		scene.render();
		const snapshot = captureCustomRenderPassFrame(camera);
		expect(snapshot.passes.find((value) => value.id === producer.id)).toMatchObject({ active: false, culledReason: "cameraFilter" });
		expect(snapshot.passes.find((value) => value.id === consumer.id)).toMatchObject({ active: false, culledReason: "cameraFilterDependency" });
	});

	test("builds enabled shader passes with uniforms and disposes the prior chain", () => {
		const lookup = RawTexture.CreateRGBATexture(new Uint8Array([255, 128, 0, 255]), 1, 1, scene);
		lookup.name = "assets/lookup.png";
		const shader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D lookupSampler; uniform float amount; void main(void) { vec4 c = texture2D(textureSampler, vUV); gl_FragColor = mix(c, texture2D(lookupSampler, vUV), amount); }`;
		const definitions = [
			{
				...pass("grade", 0),
				fragmentShader: shader,
				uniforms: { amount: 0.5 },
				inputs: { lookupSampler: { source: "texture" as const, path: "assets/lookup.png" } },
				ratio: 0.5,
				samplingMode: "nearest" as const,
			},
			{ ...pass("disabled", 1, ["grade"]), enabled: false },
		];
		expect(applyCustomRenderPassGraph(scene, camera, definitions).map((value) => value.id)).toEqual(["grade", "disabled"]);
		expect(getCustomRenderPassPostProcesses(camera)).toHaveLength(1);
		expect((getCustomRenderPassPostProcesses(camera)[0] as any)._babylonEditorCustomRenderPassId).toBe("grade");
		expect(getCustomRenderPassDiagnostics(camera)[0]).toMatchObject({
			id: "grade",
			name: "grade",
			compilationError: null,
			resources: [{ name: "lookupSampler", source: "texture", path: "assets/lookup.png", ready: expect.any(Boolean) }],
		});
		applyCustomRenderPassGraph(scene, camera, []);
		expect(getCustomRenderPassPostProcesses(camera)).toHaveLength(0);
	});

	test("resolves camera depth and geometry-buffer normal resources", () => {
		const normalTexture = RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 255, 255]), 1, 1, scene);
		(scene as any).enableGeometryBufferRenderer = () => ({
			isSupported: true,
			enableDepth: true,
			enableNormal: true,
			enablePosition: false,
			enableVelocity: false,
			enableVelocityLinear: false,
			enableReflectivity: false,
			enableScreenspaceDepth: false,
			enableIrradiance: false,
			getTextureIndex: () => 0,
			getGBuffer: () => ({ textures: [normalTexture], getSize: () => ({ width: 1, height: 1 }), isReady: () => true, count: 1 }),
		});
		const shader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D depthSampler; uniform sampler2D normalSampler; void main(void) { vec4 c = texture2D(textureSampler, vUV); float d = texture2D(depthSampler, vUV).r; vec3 n = texture2D(normalSampler, vUV).xyz; gl_FragColor = vec4(c.rgb * n * d, c.a); }`;
		const definition = {
			...pass("resources", 0),
			fragmentShader: shader,
			inputs: { depthSampler: { source: "depth" as const }, normalSampler: { source: "normal" as const } },
		};
		applyCustomRenderPassGraph(scene, camera, [definition]);
		expect(getCustomRenderPassDiagnostics(camera)[0].resources.map((resource) => resource.source)).toEqual(["depth", "normal"]);
		disposeCustomRenderPassGraph(camera);
		expect((scene as any)._depthRenderer[camera.uniqueId].enabled).toBe(false);
	});

	test("cleans up a partial chain when a render resource is unsupported", () => {
		const shader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D normalSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) * texture2D(normalSampler, vUV); }`;
		const definition = { ...pass("normal", 0), fragmentShader: shader, inputs: { normalSampler: { source: "normal" as const } } };
		expect(() => applyCustomRenderPassGraph(scene, camera, [pass("first", 0), definition])).toThrow("does not support a geometry buffer");
		expect(getCustomRenderPassPostProcesses(camera)).toHaveLength(0);
	});

	test("captures named outputs and aliases non-overlapping compatible lifetimes", () => {
		const first = { ...pass("first", 0), output: "firstColor" };
		const consumeFirst = {
			...pass("consumeFirst", 1, [first.id]),
			fragmentShader: `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D firstSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(firstSampler, vUV); }`,
			inputs: { firstSampler: { source: "pass" as const, output: "firstColor" } },
		};
		const second = { ...pass("second", 2, [consumeFirst.id]), output: "secondColor" };
		const consumeSecond = {
			...pass("consumeSecond", 3, [second.id]),
			fragmentShader: `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D secondSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(secondSampler, vUV); }`,
			inputs: { secondSampler: { source: "pass" as const, output: "secondColor" } },
		};
		const definitions = [consumeSecond, second, consumeFirst, first];
		const schedule = getCustomRenderPassSchedule(definitions);
		expect(schedule).toMatchObject({
			allocationCount: 1,
			outputs: [
				{ name: "firstColor", allocationSlot: 0 },
				{ name: "secondColor", allocationSlot: 0 },
			],
		});
		expect(getCustomRenderPassSchedule([consumeSecond, { ...second, outputFormat: "rg" as const }, consumeFirst, first]).allocationCount).toBe(2);
		applyCustomRenderPassGraph(scene, camera, definitions);
		const captures = getCustomRenderPassPostProcesses(camera).filter((postProcess) => (postProcess as any)._babylonEditorInternalOutputCapture);
		expect(captures).toHaveLength(2);
		expect((captures[1] as any)._shareOutputWithPostProcess).toBe(captures[0]);
		expect((captures[0] as any)._textureType).toBe(Constants.TEXTURETYPE_UNSIGNED_BYTE);
		expect((captures[0] as any)._textureFormat).toBe(Constants.TEXTUREFORMAT_RGBA);
		expect(captures[0].samples).toBe(1);
		expect(getCustomRenderPassOutputTexture(camera, "firstColor")).not.toBe(getCustomRenderPassOutputTexture(camera, "secondColor"));
		expect(getCustomRenderPassDiagnostics(camera)[3].resources[0]).toMatchObject({ source: "pass", output: "secondColor" });
	});

	test("reports unsupported output precision and MSAA capabilities before replacing the graph", () => {
		const capabilities = engine.getCaps();
		const originalFloatRender = capabilities.textureFloatRender;
		const originalSamples = capabilities.maxMSAASamples;
		capabilities.textureFloatRender = false;
		const floatOutput = { ...pass("float", 0), output: "hdr", outputType: "float" as const, samplingMode: "nearest" as const };
		expect(() => applyCustomRenderPassGraph(scene, camera, [floatOutput])).toThrow("float render-target support");
		capabilities.textureFloatRender = originalFloatRender;
		capabilities.maxMSAASamples = 1;
		const multisampled = { ...pass("msaa", 0), output: "color", outputSamples: 2 };
		expect(() => applyCustomRenderPassGraph(scene, camera, [multisampled])).toThrow("supports at most 1x");
		capabilities.maxMSAASamples = originalSamples;
	});

	test("schedules real multi-render-target attachments and validates the shader contract", () => {
		const fragmentShader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; void main(void) { vec4 color = texture2D(textureSampler, vUV); gl_FragData[0] = color; gl_FragData[1] = vec4(color.rgb * 0.5, 1.0); }`;
		const producer = {
			...pass("mrt", 0),
			output: "sceneColor",
			fragmentShader,
			additionalOutputs: [{ name: "bloomMask", outputType: "halfFloat" as const, outputFormat: "r" as const, outputSamples: 1 }],
		};
		const schedule = getCustomRenderPassSchedule([producer]);
		expect(schedule).toMatchObject({
			allocationCount: 2,
			outputs: [
				{ name: "sceneColor", attachmentIndex: 0, multiTarget: true },
				{ name: "bloomMask", attachmentIndex: 1, multiTarget: true, outputType: "halfFloat", outputFormat: "r" },
			],
		});
		expect(() => sortCustomRenderPassGraph([{ ...producer, fragmentShader: defaultCustomRenderPassFragmentShader }])).toThrow("gl_FragData[0]");
		expect(() => sortCustomRenderPassGraph([{ ...producer, additionalOutputs: [{ ...producer.additionalOutputs[0], outputSamples: 2 }] }])).toThrow("same outputSamples");
		expect(() => applyCustomRenderPassGraph(scene, camera, [producer])).toThrow("draw-buffer support");
	});

	test("executes explicit copy passes and schedules their source and destination resources", () => {
		const producer = { ...pass("producer", 0), output: "sourceColor" };
		const copy = {
			...pass("copy", 1, [producer.id]),
			passType: "copy" as const,
			copySource: { source: "pass" as const, output: "sourceColor" },
			output: "copiedColor",
		};
		const consumer = {
			...pass("consumer", 2, [copy.id]),
			fragmentShader: `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D copiedSampler; void main(void) { gl_FragColor = texture2D(copiedSampler, vUV); }`,
			inputs: { copiedSampler: { source: "pass" as const, output: "copiedColor" } },
		};
		const schedule = getCustomRenderPassSchedule([consumer, copy, producer]);
		expect(schedule.executionOrder).toEqual([producer.id, copy.id, consumer.id]);
		expect(schedule.outputs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "sourceColor", consumerIds: [copy.id] }),
				expect.objectContaining({ name: "copiedColor", consumerIds: [consumer.id] }),
			])
		);
		applyCustomRenderPassGraph(scene, camera, [consumer, copy, producer]);
		expect(getCustomRenderPassDiagnostics(camera)).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: copy.id, passType: "copy", resources: [expect.objectContaining({ source: "pass", output: "sourceColor" })] })])
		);
		const lookup = RawTexture.CreateRGBATexture(new Uint8Array([12, 34, 56, 255]), 1, 1, scene);
		lookup.name = "assets/copy-source.png";
		const textureCopy = { ...pass("texture-copy", 0), passType: "copy" as const, copySource: { source: "texture" as const, path: lookup.name }, output: "textureCopy" };
		applyCustomRenderPassGraph(scene, camera, [textureCopy]);
		expect(getCustomRenderPassDiagnostics(camera)[0]).toMatchObject({ passType: "copy", resources: [{ source: "texture", path: lookup.name }] });
		const screenCopy = { ...pass("screen-copy", 0), passType: "copy" as const, copySource: { source: "screen" as const }, output: "screenCopy" };
		applyCustomRenderPassGraph(scene, camera, [screenCopy]);
		expect(getCustomRenderPassDiagnostics(camera)[0]).toMatchObject({ passType: "copy", resources: [] });
		expect(() => sortCustomRenderPassGraph([{ ...copy, output: null }])).toThrow("requires a named output destination");
		expect(() => sortCustomRenderPassGraph([{ ...copy, dependencies: [] }, producer])).toThrow("must directly depend");
		expect(() => sortCustomRenderPassGraph([{ ...textureCopy, copySource: { source: "texture" as const } }])).toThrow("requires a project-relative path");
	});

	test("creates owned scene-raster targets with selected meshes and graph outputs", () => {
		const included = CreateBox("Included", {}, scene);
		const excluded = CreateBox("Excluded", {}, scene);
		const raster = {
			...pass("raster", 0),
			passType: "raster" as const,
			injectionPoint: "beforeRendering" as const,
			output: "rasterColor",
			ratio: 0.5,
			rasterSettings: {
				...pass("raster-defaults", 0).rasterSettings,
				cameraId: camera.id,
				meshIds: [included.id],
				clearColor: [0.1, 0.2, 0.3, 1] as [number, number, number, number],
				renderParticles: false,
				renderSprites: false,
				useCameraPostProcesses: false,
				refreshRate: "everyTwoFrames" as const,
			},
		};
		const schedule = getCustomRenderPassSchedule([raster]);
		expect(schedule.outputs[0]).toMatchObject({ name: "rasterColor", sceneRaster: true, multiTarget: false });
		applyCustomRenderPassGraph(scene, camera, [raster]);
		expect(getCustomRenderPassSceneRasterTargets(camera)[0]).toMatchObject({
			id: raster.id,
			output: "rasterColor",
			cameraId: camera.id,
			meshIds: [included.id],
			ready: expect.any(Boolean),
		});
		expect(getCustomRenderPassDiagnostics(camera)[0]).toMatchObject({ id: raster.id, passType: "raster", resources: [{ name: included.id, source: "mesh", ready: true }] });
		expect(scene.customRenderTargets[0].renderList?.map((mesh) => mesh.id)).toEqual([included.id]);
		expect(scene.customRenderTargets[0].renderList?.map((mesh) => mesh.id)).not.toContain(excluded.id);
		disposeCustomRenderPassGraph(camera);
		expect(scene.customRenderTargets).toHaveLength(0);
		expect(() => applyCustomRenderPassGraph(scene, camera, [{ ...raster, rasterSettings: { ...raster.rasterSettings, meshIds: ["missing"] } }])).toThrow("missing mesh ids");
		expect(() =>
			sortCustomRenderPassGraph([
				{ ...raster, dependencies: ["shader"] },
				{ ...pass("shader", 0), output: "shaderColor" },
			])
		).toThrow("only on other raster passes");
	});

	test("executes reusable renderer-list camera/layer/group/queue selection in a raster pass", () => {
		const opaque = CreateBox("Renderer List Opaque", {}, scene);
		opaque.layerMask = 0x02;
		opaque.renderingGroupId = 0;
		const transparent = CreateBox("Renderer List Transparent", {}, scene);
		transparent.layerMask = 0x04;
		transparent.renderingGroupId = 1;
		transparent.alphaIndex = 11;
		const material = new StandardMaterial("Renderer List Transparent Material", scene);
		material.alpha = 0.5;
		transparent.material = material;
		camera.layerMask = 0x06;
		scene.metadata = {
			[rendererListsMetadataKey]: [
				{
					version: 1,
					id: "transparent-renderers",
					name: "Transparent Renderers",
					revision: 4,
					enabled: true,
					cameraId: null,
					meshIds: [],
					includeDescendants: false,
					includeLayerMask: 0x04,
					excludeLayerMask: 0,
					respectCameraLayerMask: true,
					renderingGroupIds: [1],
					queue: "transparent",
					sortMode: "backToFront",
					includeDisabled: false,
					includeInvisible: false,
				},
			],
		};
		const unrelatedActiveCamera = new FreeCamera("Unrelated Active Camera", new Vector3(0, 0, -5), scene);
		unrelatedActiveCamera.layerMask = 0x02;
		scene.activeCamera = unrelatedActiveCamera;
		const raster = {
			...pass("renderer-list-raster", 0),
			passType: "raster" as const,
			injectionPoint: "beforeRendering" as const,
			output: "transparentColor",
			rasterSettings: { ...pass("defaults", 0).rasterSettings, rendererListId: "transparent-renderers" },
		};
		applyCustomRenderPassGraph(scene, camera, [raster]);
		expect(scene.customRenderTargets[0].renderList?.map((mesh) => mesh.id)).toEqual([transparent.id]);
		expect(scene.customRenderTargets[0].customRenderFunction).toBeTypeOf("function");
		expect(getCustomRenderPassSceneRasterTargets(camera)[0]).toMatchObject({
			rendererListId: "transparent-renderers",
			rendererListRevision: 4,
			queue: "transparent",
			sortMode: "backToFront",
			meshIds: [transparent.id],
			resolutionError: null,
		});
		transparent.layerMask = 0x02;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getCustomRenderPassSceneRasterTargets(camera)[0]).toMatchObject({ meshIds: [], resolutionError: null });
		transparent.layerMask = 0x04;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getCustomRenderPassSceneRasterTargets(camera)[0].meshIds).toEqual([transparent.id]);
		expect(opaque).not.toBe(transparent);
		expect(() => sortCustomRenderPassGraph([{ ...raster, rasterSettings: { ...raster.rasterSettings, meshIds: [opaque.id] } }])).toThrow(
			"must leave cameraId, meshIds, includeDescendants, and layerMask at their defaults"
		);
		(scene.metadata[rendererListsMetadataKey] as any[])[0] = {
			...(scene.metadata[rendererListsMetadataKey] as any[])[0],
			enabled: false,
			cameraId: "missing-disabled-camera",
			meshIds: ["missing-disabled-mesh"],
		};
		expect(() => applyCustomRenderPassGraph(scene, camera, [raster])).not.toThrow();
		expect(scene.customRenderTargets.at(-1)?.renderList).toHaveLength(0);
		expect(getCustomRenderPassSceneRasterTargets(camera)[0].meshIds).toEqual([]);
	});

	test("applies isolated general graphics-pass filtering, material, depth, culling, blending, and clear state", () => {
		const parent = CreateBox("Graphics Parent", {}, scene);
		const child = CreateBox("Graphics Child", {}, scene);
		child.parent = parent;
		parent.layerMask = 0x02;
		child.layerMask = 0x02;
		const filtered = CreateBox("Filtered", {}, scene);
		filtered.layerMask = 0x04;
		const source = new StandardMaterial("Graphics Override", scene);
		source.backFaceCulling = true;
		source.disableDepthWrite = false;
		source.alphaMode = Constants.ALPHA_DISABLE;
		const raster = {
			...pass("graphics-state", 0),
			passType: "raster" as const,
			injectionPoint: "beforeRendering" as const,
			output: "graphicsColor",
			rasterSettings: {
				...pass("defaults", 0).rasterSettings,
				meshIds: [parent.id],
				includeDescendants: true,
				layerMask: 0x02,
				materialId: source.id,
				clearMode: "depthOnly" as const,
				depthTest: false,
				depthWrite: false,
				cullMode: "front" as const,
				blendMode: "additive" as const,
			},
		};
		applyCustomRenderPassGraph(scene, camera, [raster]);
		const target = scene.customRenderTargets[0];
		expect(target.renderList?.map((mesh) => mesh.id)).toEqual([parent.id, child.id]);
		expect(target.renderList?.map((mesh) => mesh.id)).not.toContain(filtered.id);
		expect(target.onClearObservable.hasObservers()).toBe(true);
		expect(getCustomRenderPassSceneRasterTargets(camera)[0]).toMatchObject({
			meshIds: [parent.id, child.id],
			materialId: source.id,
			clearMode: "depthOnly",
			depthTest: false,
			depthWrite: false,
			cullMode: "front",
			blendMode: "additive",
			layerMask: 0x02,
			includeDescendants: true,
		});
		const clone = scene.materials.find((material) => material !== source && material.name.includes("graphics override"))!;
		expect(clone).toMatchObject({ backFaceCulling: true, cullBackFaces: false, disableDepthWrite: true, depthFunction: Constants.ALWAYS, alphaMode: Constants.ALPHA_ADD });
		expect(source).toMatchObject({ backFaceCulling: true, disableDepthWrite: false, alphaMode: Constants.ALPHA_DISABLE });
		disposeCustomRenderPassGraph(camera);
		expect(scene.materials).not.toContain(clone);
	});

	test("resolves named raster outputs and normalizes/flips GPU byte readback to RGBA8", async () => {
		const raster = { ...pass("capture-raster", 0), passType: "raster" as const, injectionPoint: "beforeRendering" as const, output: "captureColor" };
		applyCustomRenderPassGraph(scene, camera, [raster]);
		const target = scene.customRenderTargets[0] as any;
		target.getSize = () => ({ width: 2, height: 2 });
		target.readPixels = async () => new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
		const captured = await readCustomRenderPassOutputPixels(camera, "captureColor");
		expect(captured).toMatchObject({
			passId: "capture-raster",
			output: "captureColor",
			kind: "raster",
			width: 2,
			height: 2,
			outputType: "uint8",
			outputFormat: "rgba",
			runtimeReady: expect.any(Boolean),
		});
		expect([...captured.pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
		target.getSize = () => ({ width: 1, height: 1 });
		target.readPixels = async () => new Float32Array([1, 0.5, Number.NaN, 1]);
		const floatCapture = await readCustomRenderPassOutputPixels(camera, "captureColor", false);
		expect([...floatCapture.pixels]).toEqual([255, 128, 0, 255]);
		expect(floatCapture.nonFiniteValueCount).toBe(1);
		await expect(readCustomRenderPassOutputPixels(camera, "missingOutput")).rejects.toThrow("was not found");

		disposeCustomRenderPassGraph(camera);
		applyCustomRenderPassGraph(scene, camera, [{ ...pass("single-shader", 0), output: "singleColor" }]);
		const shaderTarget = getCustomRenderPassOutputTexture(camera, "singleColor") as any;
		expect(shaderTarget).toBeTruthy();
		shaderTarget.getSize = () => ({ width: 1, height: 1 });
		shaderTarget.readPixels = async () => new Uint8Array([12, 34, 56, 255]);
		expect(await readCustomRenderPassOutputPixels(camera, "singleColor", false)).toMatchObject({
			passId: "single-shader",
			output: "singleColor",
			kind: "shader",
			pixels: new Uint8Array([12, 34, 56, 255]),
		});

		const copy = { ...pass("single-copy", 0), passType: "copy" as const, copySource: { source: "screen" as const }, output: "copiedColor" };
		applyCustomRenderPassGraph(scene, camera, [copy]);
		const copyTarget = getCustomRenderPassOutputTexture(camera, "copiedColor") as any;
		expect(copyTarget).toBeTruthy();
		copyTarget.getSize = () => ({ width: 1, height: 1 });
		copyTarget.readPixels = async () => new Float32Array([0.25, 0.5, 1, 1]);
		expect(await readCustomRenderPassOutputPixels(camera, "copiedColor", false)).toMatchObject({
			passId: "single-copy",
			output: "copiedColor",
			kind: "copy",
			pixels: new Uint8Array([64, 128, 255, 255]),
		});
	});

	test("collects isolated timestamp-query samples by rotating WebGL passes across frames", () => {
		const capabilities = engine.getCaps() as any;
		capabilities.timerQuery = {};
		capabilities.canUseTimestampForTimerQuery = true;
		vi.spyOn(engine, "getClassName").mockReturnValue("Engine");
		let tokenId = 0;
		(engine as any).startTimeQuery = vi.fn(() => ({ id: ++tokenId, polls: 0 }));
		(engine as any).endTimeQuery = vi.fn((token: any) => (++token.polls === 1 ? -1 : token.id * 1_250_000));
		configureCustomRenderPassGpuProfiling(camera, true, 8);
		applyCustomRenderPassGraph(scene, camera, [pass("profile-a", 0), pass("profile-b", 1)]);
		const runtimePasses = getCustomRenderPassPostProcesses(camera);
		runtimePasses[0].onBeforeRenderObservable.notifyObservers(runtimePasses[0].getEffect()!);
		runtimePasses[0].onAfterRenderObservable.notifyObservers(runtimePasses[0].getEffect()!);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		runtimePasses[1].onBeforeRenderObservable.notifyObservers(runtimePasses[1].getEffect()!);
		runtimePasses[1].onAfterRenderObservable.notifyObservers(runtimePasses[1].getEffect()!);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const profile = getCustomRenderPassGpuProfile(camera, true, 8);
		expect(profile).toMatchObject({
			enabled: true,
			supported: true,
			mode: "webgl-timestamp",
			samplingStrategy: "roundRobinAcrossFrames",
			passes: [
				{ id: "profile-a", source: "timerQuery", available: true, sampleCount: 1, lastMs: 1.25, samplesMs: [1.25] },
				{ id: "profile-b", source: "timerQuery", available: true, sampleCount: 1, lastMs: 2.5, samplesMs: [2.5] },
			],
		});
		expect((engine as any).startTimeQuery).toHaveBeenCalledTimes(2);
		expect(() => configureCustomRenderPassGpuProfiling(camera, true, 7)).toThrow("8 through 600");
		expect(() => getCustomRenderPassGpuProfile(camera, true, 121)).toThrow("1 through 120");
	});

	test("reports unsupported GPU timestamp profiling without fabricating CPU or frame durations", () => {
		configureCustomRenderPassGpuProfiling(camera, true, 16);
		applyCustomRenderPassGraph(scene, camera, [pass("unsupported-profile", 0)]);
		expect(getCustomRenderPassGpuProfile(camera)).toMatchObject({
			enabled: true,
			supported: false,
			mode: "unavailable",
			samplingStrategy: "unavailable",
			passes: [{ id: "unsupported-profile", source: "unavailable", available: false, sampleCount: 0, lastMs: null }],
		});
	});

	test("collects isolated WebGPU render-target counters without using frame timing", () => {
		const capabilities = engine.getCaps() as any;
		capabilities.timerQuery = true;
		Object.defineProperty(engine, "isWebGPU", { configurable: true, value: true });
		Object.defineProperty(engine, "enableGPUTimingMeasurements", { configurable: true, writable: true, value: false });
		configureCustomRenderPassGpuProfiling(camera, true, 8);
		applyCustomRenderPassGraph(scene, camera, [{ ...pass("profile-webgpu", 0), output: "profileColor" }]);
		const capture = getCustomRenderPassPostProcesses(camera).find((candidate) => (candidate as any)._babylonEditorInternalOutputCapture) as any;
		const wrapper = capture.activate(camera);
		wrapper.gpuTimeInFrame = { counter: { count: 1, current: 875_000 } };
		scene.onAfterRenderObservable.notifyObservers(scene);
		expect(getCustomRenderPassGpuProfile(camera)).toMatchObject({
			supported: true,
			mode: "webgpu-timestamp",
			samplingStrategy: "parallelPerResourceCounters",
			passes: [{ id: "profile-webgpu", source: "renderTarget", available: true, sampleCount: 1, lastMs: 0.875 }],
		});
	});

	test("validates and schedules native WebGPU compute storage-texture passes", () => {
		const compute = {
			...pass("compute", 0),
			passType: "compute" as const,
			injectionPoint: "afterRenderingPrePasses" as const,
			output: "computedColor",
		};
		const schedule = getCustomRenderPassSchedule([compute]);
		expect(schedule).toMatchObject({
			allocationCount: 1,
			outputs: [{ name: "computedColor", compute: true, sceneRaster: false, multiTarget: false }],
		});
		expect(() => applyCustomRenderPassGraph(scene, camera, [compute])).toThrow("WebGPU backend with compute-shader support");
		expect(() => sortCustomRenderPassGraph([{ ...compute, output: null }])).toThrow("requires a named output destination");
		expect(() => sortCustomRenderPassGraph([{ ...compute, outputFormat: "rg" as const }])).toThrow("RGBA storage-texture output");
		expect(() => sortCustomRenderPassGraph([{ ...compute, outputSamples: 2 }])).toThrow("cannot use MSAA");
		expect(() => sortCustomRenderPassGraph([{ ...compute, computeSettings: { ...compute.computeSettings, dispatch: [0, 1, 1] } }])).toThrow("dispatch");
		expect(() =>
			sortCustomRenderPassGraph([
				{
					...compute,
					inputs: { sourceTexture: { source: "texture", path: "assets/source.png" } },
					computeSettings: { ...compute.computeSettings, wgsl: `${compute.computeSettings.wgsl}\nvar sourceTexture: texture_2d<f32>;` },
				},
			])
		).toThrow("requires group and binding");
		expect(() =>
			sortCustomRenderPassGraph([
				{ ...compute, dependencies: ["shader"] },
				{ ...pass("shader", 0), output: "shaderColor" },
			])
		).toThrow("only on raster or compute passes");
	});

	test("validates compute uniform/storage buffers and indirect dispatch", () => {
		const buffered = {
			...pass("buffered-compute", 0),
			passType: "compute" as const,
			injectionPoint: "afterRenderingPrePasses" as const,
			output: "bufferedColor",
			computeSettings: {
				...pass("defaults", 0).computeSettings,
				wgsl: `${defaultCustomRenderPassComputeShader}\nstruct Params { tint: vec4<f32>, count: u32 };\n@group(0) @binding(1) var<uniform> params: Params;\n@group(0) @binding(2) var<storage, read_write> dispatchArgs: array<u32>;`,
				dispatchType: "indirect" as const,
				indirectBuffer: "dispatchArgs",
				indirectOffset: 0,
				uniformBuffers: [
					{
						name: "params",
						group: 0,
						binding: 1,
						uniforms: [
							{ name: "tint", type: "vec4" as const, value: [1, 0.5, 0.25, 1] },
							{ name: "count", type: "uint" as const, value: [12] },
						],
					},
				],
				storageBuffers: [
					{
						name: "dispatchArgs",
						group: 0,
						binding: 2,
						dataType: "uint32" as const,
						data: [4, 3, 1, 0],
						indirect: true,
						sharedResource: null,
						access: "readWrite" as const,
					},
				],
			},
		};
		expect(() => sortCustomRenderPassGraph([buffered])).not.toThrow();
		expect(getCustomRenderPassSchedule([buffered]).outputs[0]).toMatchObject({ name: "bufferedColor", compute: true });
		expect(() =>
			sortCustomRenderPassGraph([
				{ ...buffered, computeSettings: { ...buffered.computeSettings, uniformBuffers: [{ ...buffered.computeSettings.uniformBuffers[0], binding: 0 }] } },
			])
		).toThrow("duplicates binding location");
		expect(() =>
			sortCustomRenderPassGraph([
				{
					...buffered,
					computeSettings: {
						...buffered.computeSettings,
						uniformBuffers: [{ ...buffered.computeSettings.uniformBuffers[0], uniforms: [{ name: "tint", type: "vec4" as const, value: [1, 2] }] }],
					},
				},
			])
		).toThrow("requires 4 finite value");
		expect(() => sortCustomRenderPassGraph([{ ...buffered, computeSettings: { ...buffered.computeSettings, indirectOffset: 8 } }])).toThrow("requires three uint32 values");
		expect(() =>
			sortCustomRenderPassGraph([
				{
					...buffered,
					computeSettings: {
						...buffered.computeSettings,
						storageBuffers: [{ ...buffered.computeSettings.storageBuffers[0], dataType: "float32" as const }],
					},
				},
			])
		).toThrow("must use uint32 data");
		expect(() => updateCustomRenderPassComputeStorageBuffer(camera, buffered.id, "dispatchArgs", [1], 0)).toThrow("no live WebGPU runtime");
		expect(() => updateCustomRenderPassComputeUniformBuffer(camera, buffered.id, "params", { tint: [1, 1, 1, 1] })).toThrow("no live WebGPU runtime");
		return expect(readCustomRenderPassComputeStorageBuffer(camera, buffered.id, "dispatchArgs")).rejects.toThrow("no live WebGPU runtime");
	});

	test("shares compute storage allocations through dependency-validated WebGPU ordering", () => {
		const writer = {
			...pass("shared-writer", 0),
			passType: "compute" as const,
			injectionPoint: "afterRenderingPrePasses" as const,
			output: "writerColor",
			computeSettings: {
				...pass("writer-defaults", 0).computeSettings,
				wgsl: `${defaultCustomRenderPassComputeShader}\n@group(0) @binding(1) var<storage, read_write> writerData: array<u32>;`,
				submitAfterDispatch: true,
				storageBuffers: [
					{
						name: "writerData",
						group: 0,
						binding: 1,
						dataType: "uint32" as const,
						data: [1, 2, 3, 4],
						indirect: false,
						sharedResource: "simulationData",
						access: "write" as const,
					},
				],
			},
		};
		const reader = {
			...pass("shared-reader", 1, [writer.id]),
			passType: "compute" as const,
			injectionPoint: "afterRenderingPrePasses" as const,
			output: "readerColor",
			computeSettings: {
				...pass("reader-defaults", 0).computeSettings,
				wgsl: `${defaultCustomRenderPassComputeShader}\n@group(0) @binding(1) var<storage, read> readerData: array<u32>;`,
				storageBuffers: [{ ...writer.computeSettings.storageBuffers[0], name: "readerData", access: "read" as const }],
			},
		};
		const schedule = getCustomRenderPassSchedule([reader, writer]);
		expect(schedule.sharedComputeResources).toEqual([
			{
				name: "simulationData",
				dataType: "uint32",
				elementCount: 4,
				indirect: false,
				synchronization: "implicitWebGPUCommandOrder",
				usages: [
					{ passId: writer.id, passName: writer.name, bufferName: "writerData", access: "write" },
					{ passId: reader.id, passName: reader.name, bufferName: "readerData", access: "read" },
				],
			},
		]);
		expect(() => sortCustomRenderPassGraph([{ ...reader, dependencies: [] }, writer])).toThrow("unordered write→read hazard");
		expect(() =>
			sortCustomRenderPassGraph([
				{
					...reader,
					computeSettings: {
						...reader.computeSettings,
						storageBuffers: [{ ...reader.computeSettings.storageBuffers[0], data: [9, 2, 3, 4] }],
					},
				},
				writer,
			])
		).toThrow("identical dataType, element count, initial data");
		expect(() =>
			sortCustomRenderPassGraph([
				{
					...reader,
					dependencies: [],
					computeSettings: { ...reader.computeSettings, storageBuffers: [{ ...reader.computeSettings.storageBuffers[0], access: "read" as const }] },
				},
				{ ...writer, computeSettings: { ...writer.computeSettings, storageBuffers: [{ ...writer.computeSettings.storageBuffers[0], access: "read" as const }] } },
			])
		).not.toThrow();
	});

	test("requires pass-output consumers to declare the producer dependency", () => {
		const producer = { ...pass("producer", 0), output: "color" };
		const consumer = {
			...pass("consumer", 1),
			fragmentShader: `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D colorSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(colorSampler, vUV); }`,
			inputs: { colorSampler: { source: "pass" as const, output: "color" } },
		};
		expect(() => getCustomRenderPassSchedule([producer, consumer])).toThrow("must directly depend");
	});

	test("restores persisted passes when an exported scene renders", () => {
		scene.metadata = { babylonEditorCustomRenderPasses: [pass("runtime", 0)] };
		configureCustomRenderPassGraph(scene);
		expect(getCustomRenderPassPostProcesses(camera)).toHaveLength(0);
		scene.render();
		expect(getCustomRenderPassPostProcesses(camera)).toHaveLength(1);
	});

	test("restores persisted general graphics-pass state in exported scenes", () => {
		const mesh = CreateBox("Exported Graphics Mesh", {}, scene);
		const material = new StandardMaterial("Exported Override", scene);
		const raster = {
			...pass("exported-graphics", 0),
			passType: "raster" as const,
			injectionPoint: "beforeRendering" as const,
			output: "exportedGraphicsColor",
			rasterSettings: {
				...pass("exported-defaults", 0).rasterSettings,
				meshIds: [mesh.id],
				materialId: material.id,
				clearMode: "none" as const,
				depthWrite: false,
				cullMode: "none" as const,
				blendMode: "multiply" as const,
			},
		};
		scene.metadata = { babylonEditorCustomRenderPasses: [raster] };
		configureCustomRenderPassGraph(scene);
		scene.render();
		expect(getCustomRenderPassSceneRasterTargets(camera)[0]).toMatchObject({
			meshIds: [mesh.id],
			materialId: material.id,
			clearMode: "none",
			depthWrite: false,
			cullMode: "none",
			blendMode: "multiply",
		});
	});

	test("captures immutable frame debugger evidence and isolates one pass dependency closure without persisting enablement", () => {
		const mesh = CreateBox("Frame Debug Mesh", {}, scene);
		const raster = {
			...pass("frame-raster", 0),
			passType: "raster" as const,
			injectionPoint: "beforeRendering" as const,
			output: "frameSceneColor",
			rasterSettings: { ...pass("frame-defaults", 0).rasterSettings, meshIds: [mesh.id] },
		};
		const consumer = {
			...pass("frame-consumer", 1, [raster.id]),
			output: "frameFinalColor",
			fragmentShader:
				"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D sceneSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(sceneSampler, vUV); }",
			inputs: { sceneSampler: { source: "pass" as const, output: raster.output } },
		};
		const unrelated = { ...pass("frame-unrelated", 2), output: "frameUnrelatedColor" };
		const definitions = [raster, consumer, unrelated];
		applyCustomRenderPassGraph(scene, camera, definitions);
		scene.render();
		const first = captureCustomRenderPassFrame(camera);
		expect(first).toMatchObject({ version: 1, captureId: 1, isolationPassId: null, authoredPassCount: 3, activePassCount: 3, culledPassCount: 0, resourceCount: 3 });
		expect(first.passes.find((entry) => entry.id === raster.id)).toMatchObject({ phase: "beforeRendering", active: true, writes: ["frameSceneColor"] });
		expect(first.resources.find((entry) => entry.name === "frameFinalColor")).toMatchObject({ producerId: consumer.id, allocated: true, allocationSlot: expect.any(Number) });
		const frozenFrame = first.frameId;
		scene.render();
		expect(getCustomRenderPassFrameSnapshot(camera)?.frameId).toBe(frozenFrame);

		const isolated = configureCustomRenderPassFrameIsolation(scene, camera, definitions, consumer.id);
		expect(isolated).toMatchObject({ isolationPassId: consumer.id, executionOrder: [raster.id, consumer.id], activePassCount: 2 });
		expect(getCustomRenderPassFrameSnapshot(camera)).toBeNull();
		scene.render();
		const isolatedFrame = captureCustomRenderPassFrame(camera);
		expect(isolatedFrame).toMatchObject({ isolationPassId: consumer.id, activePassCount: 2, culledPassCount: 1 });
		expect(isolatedFrame.passes.find((entry) => entry.id === unrelated.id)).toMatchObject({ active: false, culledReason: "debugIsolation", executionIndex: null });
		expect(isolatedFrame.resources.find((entry) => entry.name === "frameUnrelatedColor")).toMatchObject({ allocated: false, ready: false });
		expect(() => configureCustomRenderPassFrameIsolation(scene, camera, definitions, "missing-pass")).toThrow("was not found");
		expect(getCustomRenderPassFrameIsolation(camera)).toBe(consumer.id);
		const cleared = configureCustomRenderPassFrameIsolation(scene, camera, definitions, null);
		expect(cleared).toMatchObject({ isolationPassId: null, activePassCount: 3 });
		expect(definitions.map((definition) => definition.enabled)).toEqual([true, true, true]);
	});

	test("keeps exported scenes rendering and reports an unsupported named-output target", () => {
		const capabilities = engine.getCaps();
		const originalFloatRender = capabilities.textureFloatRender;
		capabilities.textureFloatRender = false;
		scene.metadata = {
			babylonEditorCustomRenderPasses: [{ ...pass("runtime-hdr", 0), output: "hdrColor", outputType: "float", samplingMode: "nearest" }],
		};
		configureCustomRenderPassGraph(scene);
		expect(() => scene.render()).not.toThrow();
		expect(getCustomRenderPassPostProcesses(camera)).toHaveLength(0);
		expect(getCustomRenderPassRuntimeError(camera)).toContain("float render-target support");
		capabilities.textureFloatRender = originalFloatRender;
	});
});
