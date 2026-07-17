import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, MeshBuilder, NullEngine, RawTexture, Scene, Vector3 } from "babylonjs";
import { defaultCustomRenderPassComputeShader, disposeCustomRenderPassGraph, getCustomRenderPassPostProcesses } from "babylonjs-editor-tools";

import {
	createCustomRenderPass,
	deleteCustomRenderPass,
	evaluateCustomRenderPassGraph,
	getCustomRenderPassGraphDiagnostics,
	getCustomRenderPassGpuProfiling,
	listCustomRenderPasses,
	readCustomComputeStorageBuffer,
	setCustomComputeStorageBufferData,
	setCustomComputeUniformBufferValues,
	setCustomRenderPass,
	setCustomRenderPassGpuProfiling,
} from "../../src/mcp/rendering/custom-passes";

describe("mcp/custom-render-passes", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
	});

	afterEach(() => {
		disposeCustomRenderPassGraph(camera as any);
		scene.dispose();
		engine.dispose();
	});

	test("persists, orders, evaluates, updates, and deletes custom passes", () => {
		const lookup = RawTexture.CreateRGBATexture(new Uint8Array([255, 255, 255, 255]), 1, 1, scene);
		lookup.name = "assets/lookup.png";
		const first = createCustomRenderPass(scene, { name: "Grade", order: 10, uniforms: { amount: 0.5 }, output: "gradeColor" }, options);
		const shader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D lookupSampler; uniform sampler2D gradeSampler; void main(void) { gl_FragColor = texture2D(lookupSampler, vUV) * texture2D(textureSampler, vUV) * texture2D(gradeSampler, vUV); }`;
		const second = createCustomRenderPass(
			scene,
			{
				name: "Outline",
				order: 0,
				dependencies: [first.id],
				fragmentShader: shader,
				inputs: { lookupSampler: { source: "texture", path: "assets/lookup.png" }, gradeSampler: { source: "pass", output: "gradeColor" } },
				ratio: 0.5,
				samplingMode: "nearest",
			},
			options
		);
		expect(listCustomRenderPasses(scene).executionOrder).toEqual([first.id, second.id]);
		expect(listCustomRenderPasses(scene).schedule).toMatchObject({ allocationCount: 1, outputs: [{ name: "gradeColor", consumerIds: [second.id] }] });
		expect(evaluateCustomRenderPassGraph(scene, {}, options)).toMatchObject({ activePassCount: 2, executionOrder: [first.id, second.id] });
		expect(getCustomRenderPassPostProcesses(camera as any)).toHaveLength(4);
		expect(getCustomRenderPassGraphDiagnostics(scene).passes[1].resources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "lookupSampler", source: "texture", path: "assets/lookup.png", ready: expect.any(Boolean) }),
				expect.objectContaining({ name: "gradeSampler", source: "pass", output: "gradeColor", ready: expect.any(Boolean) }),
			])
		);
		expect(() => setCustomRenderPass(scene, { id: first.id, output: null }, options)).toThrow("missing pass output");
		setCustomRenderPass(scene, { id: first.id, output: "renamedGradeColor" }, options);
		expect(listCustomRenderPasses(scene).passes.find((pass: any) => pass.id === second.id).inputs.gradeSampler.output).toBe("renamedGradeColor");
		expect(setCustomRenderPass(scene, { id: second.id, enabled: false, uniforms: { threshold: 0.2 } }, options)).toMatchObject({ enabled: false });
		expect(getCustomRenderPassPostProcesses(camera as any)).toHaveLength(3);
		expect(deleteCustomRenderPass(scene, { id: first.id }, options)).toMatchObject({ deleted: true });
		expect(listCustomRenderPasses(scene).passes[0]).toMatchObject({ id: second.id, dependencies: [] });
	});

	test("configures isolated GPU profiling and reports unsupported backends honestly", () => {
		const value = createCustomRenderPass(scene, { name: "Profiled", output: "profiledColor" }, options);
		const configured = setCustomRenderPassGpuProfiling(scene, { enabled: true, sampleCapacity: 32, includeSamples: true, sampleLimit: 12 }, options);
		expect(configured).toMatchObject({
			enabled: true,
			supported: false,
			mode: "unavailable",
			sampleCapacity: 32,
			passes: [{ id: value.id, available: false, sampleCount: 0 }],
			preview: { applied: true, error: null },
		});
		expect(getCustomRenderPassGpuProfiling(scene, { includeSamples: true, sampleLimit: 12 })).toMatchObject({ enabled: true, supported: false });
		expect(setCustomRenderPassGpuProfiling(scene, { enabled: false }, options)).toMatchObject({ enabled: false, supported: false, reason: "GPU pass profiling is disabled." });
		expect(() => getCustomRenderPassGpuProfiling(scene, { sampleLimit: 121 })).toThrow("1 through 120");
	});

	test("rejects dependency cycles and invalid shader contracts without corrupting metadata", () => {
		const first = createCustomRenderPass(scene, { name: "First" }, options);
		const second = createCustomRenderPass(scene, { name: "Second", dependencies: [first.id] }, options);
		expect(() => setCustomRenderPass(scene, { id: first.id, dependencies: [second.id] }, options)).toThrow("cycle");
		expect(() => setCustomRenderPass(scene, { id: first.id, fragmentShader: "void main(void) {}" }, options)).toThrow("textureSampler");
		expect(() => setCustomRenderPass(scene, { id: first.id, inputs: { lookupSampler: { source: "texture" } } }, options)).toThrow("requires a project-relative path");
		expect(listCustomRenderPasses(scene).passes.find((pass: any) => pass.id === first.id).dependencies).toEqual([]);
	});

	test("persists target resource inputs while reporting unsupported preview capabilities", () => {
		const shader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D normalSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) * texture2D(normalSampler, vUV); }`;
		const result = createCustomRenderPass(scene, { name: "Normals", fragmentShader: shader, inputs: { normalSampler: { source: "normal" } } }, options);
		expect(result.preview).toMatchObject({ applied: false, error: expect.stringContaining("geometry buffer") });
		expect(listCustomRenderPasses(scene).passes[0].inputs).toEqual({ normalSampler: { source: "normal" } });
	});

	test("persists named-output target settings while reporting unsupported preview capabilities", () => {
		const capabilities = engine.getCaps();
		const originalFloatRender = capabilities.textureFloatRender;
		capabilities.textureFloatRender = false;
		try {
			const result = createCustomRenderPass(
				scene,
				{ name: "HDR", output: "hdrColor", outputType: "float", outputFormat: "rg", outputSamples: 1, samplingMode: "nearest" },
				options
			);
			expect(result.preview).toMatchObject({ applied: false, error: expect.stringContaining("float render-target support") });
			expect(listCustomRenderPasses(scene).passes[0]).toMatchObject({ output: "hdrColor", outputType: "float", outputFormat: "rg", outputSamples: 1 });
			expect(() => setCustomRenderPass(scene, { id: result.id, outputSamples: 0 }, options)).toThrow("outputSamples");
			expect(listCustomRenderPasses(scene).passes[0].outputSamples).toBe(1);
		} finally {
			capabilities.textureFloatRender = originalFloatRender;
		}
	});

	test("persists MRT attachments and atomically migrates additional-output consumers", () => {
		const fragmentShader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; void main(void) { vec4 color = texture2D(textureSampler, vUV); gl_FragData[0] = color; gl_FragData[1] = vec4(color.rgb * 0.5, 1.0); }`;
		const producer = createCustomRenderPass(
			scene,
			{
				name: "MRT",
				output: "sceneColor",
				fragmentShader,
				additionalOutputs: [{ name: "bloomMask", outputType: "halfFloat", outputFormat: "r", outputSamples: 1 }],
			},
			options
		);
		expect(producer.preview).toMatchObject({ applied: false, error: expect.stringContaining("draw-buffer support") });
		const consumerShader = `precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D maskSampler; void main(void) { gl_FragColor = texture2D(textureSampler, vUV) + texture2D(maskSampler, vUV); }`;
		const consumer = createCustomRenderPass(
			scene,
			{
				name: "Consume Mask",
				dependencies: [producer.id],
				fragmentShader: consumerShader,
				inputs: { maskSampler: { source: "pass", output: "bloomMask" } },
			},
			options
		);
		expect(listCustomRenderPasses(scene).schedule.outputs).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "bloomMask", attachmentIndex: 1, consumerIds: [consumer.id] })])
		);
		setCustomRenderPass(scene, { id: producer.id, additionalOutputs: [{ name: "renamedBloomMask", outputType: "halfFloat", outputFormat: "r", outputSamples: 1 }] }, options);
		expect(listCustomRenderPasses(scene).passes.find((pass: any) => pass.id === consumer.id).inputs.maskSampler.output).toBe("renamedBloomMask");
	});

	test("persists copy passes and migrates or clears their named source safely", () => {
		const producer = createCustomRenderPass(scene, { name: "Source", output: "sourceColor" }, options);
		const copy = createCustomRenderPass(
			scene,
			{ name: "Copy", passType: "copy", dependencies: [producer.id], copySource: { source: "pass", output: "sourceColor" }, output: "copiedColor" },
			options
		);
		expect(copy).toMatchObject({ passType: "copy", copySource: { source: "pass", output: "sourceColor" }, output: "copiedColor", preview: { applied: true } });
		expect(listCustomRenderPasses(scene).schedule.outputs).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "sourceColor", consumerIds: [copy.id] }), expect.objectContaining({ name: "copiedColor" })])
		);
		setCustomRenderPass(scene, { id: producer.id, output: "renamedSourceColor" }, options);
		expect(listCustomRenderPasses(scene).passes.find((pass: any) => pass.id === copy.id).copySource.output).toBe("renamedSourceColor");
		deleteCustomRenderPass(scene, { id: producer.id }, options);
		expect(listCustomRenderPasses(scene).passes[0]).toMatchObject({ id: copy.id, dependencies: [], copySource: { source: "screen" } });
		expect(() => createCustomRenderPass(scene, { name: "Invalid Copy", passType: "copy" }, options)).toThrow("requires a named output destination");
	});

	test("persists and validates scene-raster pass targets", () => {
		const mesh = MeshBuilder.CreateBox("Raster Mesh", {}, scene);
		const raster = createCustomRenderPass(
			scene,
			{
				name: "Raster",
				passType: "raster",
				output: "rasterColor",
				rasterSettings: { meshIds: [mesh.id], clearColor: [0.1, 0.2, 0.3, 1], refreshRate: "everyTwoFrames" },
			},
			options
		);
		expect(raster).toMatchObject({ passType: "raster", output: "rasterColor", preview: { applied: true }, rasterSettings: { cameraId: null, meshIds: [mesh.id] } });
		expect(getCustomRenderPassGraphDiagnostics(scene)).toMatchObject({
			ready: false,
			sceneRasterTargets: [expect.objectContaining({ id: raster.id, output: "rasterColor", meshIds: [mesh.id], ready: false })],
		});
		const updated = setCustomRenderPass(scene, { id: raster.id, rasterSettings: { refreshRate: "once", renderSprites: true } }, options);
		expect(updated.rasterSettings).toMatchObject({ meshIds: [mesh.id], refreshRate: "once", renderSprites: true });
		const unsupported = createCustomRenderPass(
			scene,
			{ name: "Missing Mesh Raster", passType: "raster", output: "missingRaster", rasterSettings: { meshIds: ["missing"] } },
			options
		);
		expect(unsupported.preview).toMatchObject({ applied: false, error: expect.stringContaining("missing mesh ids") });
		expect(listCustomRenderPasses(scene).passes.find((pass: any) => pass.id === unsupported.id).rasterSettings.meshIds).toEqual(["missing"]);
	});

	test("persists native compute passes and supports authored buffer workflows while reporting WebGPU capability", async () => {
		const wgsl = `${defaultCustomRenderPassComputeShader}\nstruct Params { tint: vec4<f32> };\n@group(0) @binding(1) var<uniform> params: Params;\n@group(0) @binding(2) var<storage, read_write> dispatchArgs: array<u32>;`;
		const compute = createCustomRenderPass(
			scene,
			{
				name: "Compute Gradient",
				passType: "compute",
				output: "computedColor",
				computeSettings: {
					wgsl,
					dispatch: [4, 3, 1],
					dispatchMode: "once",
					dispatchType: "indirect",
					indirectBuffer: "dispatchArgs",
					uniformBuffers: [{ name: "params", group: 0, binding: 1, uniforms: [{ name: "tint", type: "vec4", value: [1, 0.5, 0.25, 1] }] }],
					storageBuffers: [
						{
							name: "dispatchArgs",
							group: 0,
							binding: 2,
							dataType: "uint32",
							data: [4, 3, 1],
							indirect: true,
							sharedResource: "dispatchCounters",
							access: "readWrite",
						},
					],
				},
			},
			options
		);
		expect(compute).toMatchObject({
			passType: "compute",
			output: "computedColor",
			outputFormat: "rgba",
			outputSamples: 1,
			computeSettings: {
				entryPoint: "main",
				outputBindingName: "outputTexture",
				dispatch: [4, 3, 1],
				dispatchMode: "once",
				dispatchType: "indirect",
				indirectBuffer: "dispatchArgs",
				uniformBuffers: [{ name: "params" }],
				storageBuffers: [{ name: "dispatchArgs", indirect: true, sharedResource: "dispatchCounters", access: "readWrite" }],
			},
			preview: { applied: false, error: expect.stringContaining("WebGPU backend") },
		});
		const reader = createCustomRenderPass(
			scene,
			{
				name: "Compute Reader",
				passType: "compute",
				output: "readerColor",
				dependencies: [compute.id],
				computeSettings: {
					wgsl: `${defaultCustomRenderPassComputeShader}\n@group(0) @binding(1) var<storage, read> readerArgs: array<u32>;`,
					storageBuffers: [
						{
							name: "readerArgs",
							group: 0,
							binding: 1,
							dataType: "uint32",
							data: [4, 3, 1],
							indirect: true,
							sharedResource: "dispatchCounters",
							access: "read",
						},
					],
				},
			},
			options
		);
		expect(listCustomRenderPasses(scene).schedule.sharedComputeResources[0]).toMatchObject({
			name: "dispatchCounters",
			synchronization: "implicitWebGPUCommandOrder",
			usages: [
				{ passId: compute.id, access: "readWrite" },
				{ passId: reader.id, access: "read" },
			],
		});
		expect(listCustomRenderPasses(scene).schedule.outputs[0]).toMatchObject({ name: "computedColor", compute: true });
		const updated = setCustomRenderPass(scene, { id: compute.id, computeSettings: { dispatchMode: "everyFrame" } }, options);
		expect(updated.computeSettings).toMatchObject({
			dispatch: [4, 3, 1],
			dispatchMode: "everyFrame",
			uniformBuffers: [{ name: "params" }],
			storageBuffers: [{ name: "dispatchArgs", data: [4, 3, 1] }],
		});
		expect(getCustomRenderPassGraphDiagnostics(scene)).toMatchObject({ computeTargets: [], ready: true });
		expect(() => setCustomRenderPass(scene, { id: compute.id, outputSamples: 2 }, options)).toThrow("cannot use MSAA");
		expect(listCustomRenderPasses(scene).passes[0].outputSamples).toBe(1);
		expect(() => setCustomRenderPass(scene, { id: compute.id, computeSettings: { indirectOffset: 4 } }, options)).toThrow("requires three uint32 values");
		expect(listCustomRenderPasses(scene).passes[0].computeSettings.indirectOffset).toBe(0);
		const storageUpdate = setCustomComputeStorageBufferData(scene, { id: compute.id, bufferName: "dispatchArgs", elementOffset: 1, data: [7, 2] }, options);
		expect(storageUpdate).toMatchObject({
			persisted: true,
			sharedResource: "dispatchCounters",
			affectedPassIds: [compute.id, reader.id],
			elementOffset: 1,
			elementCount: 2,
			runtime: { applied: false, error: expect.stringContaining("no live WebGPU runtime") },
		});
		expect(await readCustomComputeStorageBuffer(scene, { id: compute.id, bufferName: "dispatchArgs", source: "authored", elementOffset: 1, elementCount: 2 })).toMatchObject({
			dataType: "uint32",
			source: "authored",
			data: [7, 2],
		});
		const uniformUpdate = setCustomComputeUniformBufferValues(scene, { id: compute.id, bufferName: "params", values: { tint: [0.2, 0.4, 0.6, 1] } }, options);
		expect(uniformUpdate).toMatchObject({ persisted: true, updatedUniforms: ["tint"], runtime: { applied: false } });
		expect(listCustomRenderPasses(scene).passes[0].computeSettings.uniformBuffers[0].uniforms[0].value).toEqual([0.2, 0.4, 0.6, 1]);
		expect(() => setCustomComputeStorageBufferData(scene, { id: compute.id, bufferName: "dispatchArgs", data: [-1] }, options)).toThrow("non-negative integer data");
		expect(listCustomRenderPasses(scene).passes[0].computeSettings.storageBuffers[0].data).toEqual([4, 7, 2]);
		expect(listCustomRenderPasses(scene).passes.find((pass: any) => pass.id === reader.id).computeSettings.storageBuffers[0].data).toEqual([4, 7, 2]);
		expect(() => setCustomComputeStorageBufferData(scene, { id: compute.id, bufferName: "dispatchArgs", data: [1], persist: false }, options)).toThrow(
			"no live WebGPU runtime"
		);
		await expect(readCustomComputeStorageBuffer(scene, { id: compute.id, bufferName: "dispatchArgs", source: "runtime" })).rejects.toThrow("no live WebGPU runtime");
	});
});
