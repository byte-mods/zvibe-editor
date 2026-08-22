import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { defaultCustomRenderPassComputeShader, defaultCustomRenderPassFragmentShader, ICustomRenderPassDefinition } from "../../src/rendering/custom-render-pass-graph";
import {
	getRenderGraphConformanceSignature,
	inspectRenderGraphConformance,
	IRenderGraphConformanceRun,
	recordRenderGraphConformanceRun,
	renderGraphConformanceMetadataKey,
	validateRenderGraphConformanceManifest,
} from "../../src/rendering/render-graph-conformance";

function definition(id: string, passType: ICustomRenderPassDefinition["passType"] = "shader"): ICustomRenderPassDefinition {
	return {
		id,
		name: id,
		passType,
		injectionPoint: passType === "raster" ? "beforeRendering" : passType === "compute" ? "afterRenderingPrePasses" : "afterRenderingPostProcessing",
		rendererFeature: null,
		copySource: { source: "screen" },
		rasterSettings: {
			rendererListId: null,
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
		order: 0,
		dependencies: [],
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

function run(backend: "webgl2" | "webgpu", graphSignature: string, passed = true): IRenderGraphConformanceRun {
	return {
		version: 1,
		backend,
		graphSignature,
		capturedAt: "2026-07-28T00:00:00.000Z",
		frameCount: 4,
		frameId: 12,
		cameraId: "camera",
		cameraName: "Camera",
		passed,
		error: passed ? null : "compile failed",
		capabilities: {
			backend,
			webgl2: backend === "webgl2",
			webgpu: backend === "webgpu",
			computeShaders: backend === "webgpu",
			drawBuffers: true,
			maximumDrawBuffers: 4,
			floatRenderTargets: true,
			halfFloatRenderTargets: true,
			floatLinearFiltering: true,
			halfFloatLinearFiltering: true,
			depthTexture: true,
			maximumMsaaSamples: 4,
		},
		requirements: {
			passCount: 0,
			enabledPassCount: 0,
			outputCount: 0,
			shaderPassCount: 0,
			copyPassCount: 0,
			rasterPassCount: 0,
			computePassCount: 0,
			mrtPassCount: 0,
			maximumColorAttachments: 1,
			floatOutputCount: 0,
			halfFloatOutputCount: 0,
			maximumMsaaSamples: 1,
			depthInputCount: 0,
			normalInputCount: 0,
			projectTextureInputCount: 0,
			passOutputInputCount: 0,
		},
		passEvidence: [],
		resourceEvidence: [],
		runtimeTargets: { multiRenderTargets: 0, rasterTargets: 0, computeTargets: 0, readyTargets: 0, dispatchedComputeTargets: 0 },
	};
}

describe("render-graph cross-backend conformance", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("derives exact MRT, precision, MSAA, resource, and compute requirements without certifying a device", () => {
		const mrt = definition("mrt");
		mrt.output = "color";
		mrt.outputType = "float";
		mrt.outputSamples = 4;
		mrt.additionalOutputs = [{ name: "aux", outputType: "float", outputFormat: "rgba", outputSamples: 4 }];
		mrt.inputs = { depthSampler: { source: "depth" }, normalSampler: { source: "normal" }, projectSampler: { source: "texture", path: "assets/test.png" } };
		mrt.fragmentShader =
			"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D depthSampler; uniform sampler2D normalSampler; uniform sampler2D projectSampler; void main(void) { gl_FragData[0] = texture2D(textureSampler, vUV) + texture2D(depthSampler, vUV) + texture2D(normalSampler, vUV); gl_FragData[1] = texture2D(projectSampler, vUV); }";
		const compute = definition("compute", "compute");
		compute.order = 1;
		compute.output = "computed";
		const inspected = inspectRenderGraphConformance(scene, [mrt, compute]);
		expect(inspected.requirements).toMatchObject({
			passCount: 2,
			enabledPassCount: 2,
			outputCount: 3,
			computePassCount: 1,
			mrtPassCount: 1,
			maximumColorAttachments: 2,
			floatOutputCount: 2,
			maximumMsaaSamples: 4,
			depthInputCount: 1,
			normalInputCount: 1,
			projectTextureInputCount: 1,
		});
		expect(inspected.targets.webgl2).toMatchObject({ apiCompatible: false, blockers: ["1 native compute pass(es) require WebGPU."] });
		expect(inspected.targets.webgpu.apiCompatible).toBe(true);
		expect(inspected.targets.webgpu.deviceChecks).toEqual(expect.arrayContaining(["At least 2 simultaneous color attachments.", "At least 4x render-target MSAA."]));
	});

	test("uses a deterministic graph signature and invalidates opposite-backend evidence after a graph change", () => {
		const first = definition("first");
		const signature = getRenderGraphConformanceSignature([first]);
		expect(getRenderGraphConformanceSignature([structuredClone(first)])).toBe(signature);
		const webgl = recordRenderGraphConformanceRun(scene, run("webgl2", signature));
		expect(webgl).toMatchObject({ revision: 1, runs: { webgl2: { passed: true }, webgpu: null } });
		const webgpu = recordRenderGraphConformanceRun(scene, run("webgpu", signature));
		expect(webgpu).toMatchObject({ revision: 2, runs: { webgl2: { passed: true }, webgpu: { passed: true } } });
		first.output = "changed";
		const changed = getRenderGraphConformanceSignature([first]);
		const replaced = recordRenderGraphConformanceRun(scene, run("webgl2", changed, false));
		expect(replaced).toMatchObject({ revision: 3, graphSignature: changed, runs: { webgl2: { passed: false }, webgpu: null } });
	});

	test("strictly validates persisted metadata and rejects forward fields", () => {
		const signature = getRenderGraphConformanceSignature([]);
		recordRenderGraphConformanceRun(scene, run("webgl2", signature));
		expect(validateRenderGraphConformanceManifest(scene.metadata[renderGraphConformanceMetadataKey])).toMatchObject({ revision: 1, graphSignature: signature });
		expect(() => validateRenderGraphConformanceManifest({ ...scene.metadata[renderGraphConformanceMetadataKey], future: true })).toThrow("unsupported fields");
		expect(() => validateRenderGraphConformanceManifest({ ...scene.metadata[renderGraphConformanceMetadataKey], runs: { webgl2: null, webgpu: null, future: true } })).toThrow(
			"unsupported fields"
		);
	});
});
