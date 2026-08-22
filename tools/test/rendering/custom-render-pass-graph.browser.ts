import { Engine } from "@babylonjs/core/Engines/engine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import { Scene } from "@babylonjs/core/scene";

import {
	applyCustomRenderPassGraph,
	defaultCustomRenderPassComputeShader,
	defaultCustomRenderPassFragmentShader,
	getCustomRenderPassDiagnostics,
	getCustomRenderPassMultiRenderTargets,
	getCustomRenderPassPostProcesses,
	getCustomRenderPassSceneRasterTargets,
	ICustomRenderPassDefinition,
	readCustomRenderPassOutputPixels,
} from "../../src/rendering/custom-render-pass-graph";
import { captureRenderGraphConformanceRun, recordRenderGraphConformanceRun } from "../../src/rendering/render-graph-conformance";

function definition(id: string): ICustomRenderPassDefinition {
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
		samplingMode: "nearest",
	};
}

async function run(): Promise<void> {
	const canvas = document.createElement("canvas");
	canvas.width = 32;
	canvas.height = 32;
	document.body.appendChild(canvas);
	const engine = new Engine(canvas, false, { disableWebGL2Support: false, preserveDrawingBuffer: true });
	const scene = new Scene(engine);
	const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
	scene.activeCamera = camera;
	camera.setTarget(new Vector3(0, 0, 2));
	const plane = CreatePlane("Raster Plane", { size: 10 }, scene);
	plane.position.z = 2;
	const rasterMaterial = new StandardMaterial("Raster Material", scene);
	rasterMaterial.disableLighting = true;
	rasterMaterial.backFaceCulling = false;
	rasterMaterial.emissiveColor = new Color3(1, 0.05, 0.02);
	plane.material = rasterMaterial;
	const raster: ICustomRenderPassDefinition = {
		...definition("Scene Raster"),
		passType: "raster",
		injectionPoint: "beforeRendering",
		order: -1,
		output: "rasterColor",
		rasterSettings: {
			cameraId: camera.id,
			meshIds: [plane.id],
			includeDescendants: false,
			layerMask: null,
			materialId: null,
			clearColor: [0, 0, 1, 1],
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
	};
	const producer: ICustomRenderPassDefinition = {
		...definition("MRT Producer"),
		output: "sceneColor",
		fragmentShader:
			"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; void main(void) { gl_FragData[0] = vec4(0.2, 0.4, 0.6, 1.0); gl_FragData[1] = vec4(0.9, 0.1, 0.2, 1.0); }",
		additionalOutputs: [{ name: "auxColor", outputType: "uint8", outputFormat: "rgba", outputSamples: 1 }],
	};
	const copy: ICustomRenderPassDefinition = {
		...definition("Copy Auxiliary Output"),
		order: 1,
		dependencies: [producer.id],
		passType: "copy",
		copySource: { source: "pass", output: "auxColor" },
		output: "copiedAuxColor",
	};
	const presenter: ICustomRenderPassDefinition = {
		...definition("Present Copied Output"),
		order: 2,
		dependencies: [copy.id],
		fragmentShader:
			"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D copiedSampler; void main(void) { gl_FragColor = texture2D(copiedSampler, vUV); }",
		inputs: { copiedSampler: { source: "pass", output: "copiedAuxColor" } },
		output: "presentedColor",
	};
	const definitions = [raster, producer, copy, presenter];
	applyCustomRenderPassGraph(scene, camera, definitions);
	for (let frame = 0; frame < 10; frame++) {
		scene.render();
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	const readback = await engine.readPixels(16, 16, 1, 1, true, true);
	const pixels = new Uint8Array(readback.buffer as ArrayBuffer, readback.byteOffset, readback.byteLength);
	const rasterTarget = scene.customRenderTargets.find((target) => target.name === "Raster Scene Raster");
	const rasterReadback = await rasterTarget?.readPixels(0, 0, undefined, true, false, 16, 16, 1, 1);
	const rasterPixels = rasterReadback ? new Uint8Array(rasterReadback.buffer as ArrayBuffer, rasterReadback.byteOffset, rasterReadback.byteLength) : new Uint8Array();
	const copyOutput = await readCustomRenderPassOutputPixels(camera, "copiedAuxColor", false);
	const shaderOutput = await readCustomRenderPassOutputPixels(camera, "presentedColor", false);
	const centerOffset = (Math.floor(copyOutput.height / 2) * copyOutput.width + Math.floor(copyOutput.width / 2)) * 4;
	const copyOutputPixel = copyOutput.pixels.slice(centerOffset, centerOffset + 4);
	const shaderOutputPixel = shaderOutput.pixels.slice(centerOffset, centerOffset + 4);
	const diagnostics = getCustomRenderPassDiagnostics(camera);
	const targets = getCustomRenderPassMultiRenderTargets(camera);
	const rasterTargets = getCustomRenderPassSceneRasterTargets(camera);
	const conformanceRun = captureRenderGraphConformanceRun(scene, camera, definitions, 10);
	const conformanceManifest = recordRenderGraphConformanceRun(scene, conformanceRun);
	const passed =
		conformanceRun.backend === "webgl2" &&
		conformanceRun.passed &&
		conformanceManifest.runs.webgl2?.passed === true &&
		diagnostics.every((pass) => pass.ready && !pass.compilationError) &&
		diagnostics.some((pass) => pass.id === copy.id && pass.passType === "copy" && pass.resources[0]?.output === "auxColor") &&
		diagnostics.some((pass) => pass.id === raster.id && pass.passType === "raster" && pass.resources[0]?.name === plane.id) &&
		targets.length === 1 &&
		rasterTargets.length === 1 &&
		rasterTargets[0].ready &&
		targets[0].attachmentCount === 2 &&
		targets[0].attachments.every((attachment) => attachment.ready) &&
		rasterPixels[0] > 180 &&
		rasterPixels[0] > rasterPixels[1] * 3 &&
		rasterPixels[0] > rasterPixels[2] * 3 &&
		copyOutput.kind === "copy" &&
		copyOutput.runtimeReady &&
		shaderOutput.kind === "shader" &&
		shaderOutput.runtimeReady &&
		copyOutputPixel[0] >= 220 &&
		copyOutputPixel[0] <= 235 &&
		copyOutputPixel[1] >= 20 &&
		copyOutputPixel[1] <= 35 &&
		copyOutputPixel[2] >= 45 &&
		copyOutputPixel[2] <= 60 &&
		shaderOutputPixel[0] >= 220 &&
		shaderOutputPixel[0] <= 235 &&
		shaderOutputPixel[1] >= 20 &&
		shaderOutputPixel[1] <= 35 &&
		shaderOutputPixel[2] >= 45 &&
		shaderOutputPixel[2] <= 60 &&
		pixels[0] >= 220 &&
		pixels[0] <= 235 &&
		pixels[1] >= 20 &&
		pixels[1] <= 35 &&
		pixels[2] >= 45 &&
		pixels[2] <= 60;
	document.body.dataset.result = passed ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify({
		diagnostics,
		targets,
		rasterTargets,
		pixels: Array.from(pixels),
		rasterPixels: Array.from(rasterPixels),
		copyOutput: { kind: copyOutput.kind, ready: copyOutput.runtimeReady, pixel: Array.from(copyOutputPixel) },
		shaderOutput: { kind: shaderOutput.kind, ready: shaderOutput.runtimeReady, pixel: Array.from(shaderOutputPixel) },
		conformanceRun,
		conformanceManifest,
		fragmentSources: getCustomRenderPassPostProcesses(camera).map((postProcess) => postProcess.getEffect()?.fragmentSourceCode),
	});
	scene.dispose();
	engine.dispose();
}

void run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
});
