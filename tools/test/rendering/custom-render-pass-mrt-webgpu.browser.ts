import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
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
	ICustomRenderPassDefinition,
	readCustomRenderPassOutputPixels,
} from "../../src/rendering/custom-render-pass-graph";

function definition(id: string): ICustomRenderPassDefinition {
	return {
		id,
		name: id,
		passType: "shader",
		copySource: { source: "screen" },
		rasterSettings: {
			cameraId: null,
			meshIds: [],
			clearColor: [0, 0, 0, 0],
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

function centerPixel(value: Awaited<ReturnType<typeof readCustomRenderPassOutputPixels>>): number[] {
	const offset = (Math.floor(value.height / 2) * value.width + Math.floor(value.width / 2)) * 4;
	return Array.from(value.pixels.slice(offset, offset + 4));
}

function approximately(pixel: number[], expected: number[]): boolean {
	return expected.every((value, index) => Math.abs(pixel[index] - value) <= 3);
}

async function run(): Promise<void> {
	const gpu = (navigator as any).gpu;
	const adapter = await gpu?.requestAdapter();
	if (!adapter) {
		document.body.dataset.result = "unavailable";
		document.body.dataset.details = JSON.stringify({ webgpu: Boolean(gpu), adapter: false });
		return;
	}
	const canvas = document.createElement("canvas");
	canvas.width = 32;
	canvas.height = 32;
	document.body.appendChild(canvas);
	const engine = await WebGPUEngine.CreateAsync(canvas);
	const scene = new Scene(engine);
	const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
	scene.activeCamera = camera;
	camera.setTarget(new Vector3(0, 0, 2));
	const plane = CreatePlane("WebGPU MRT Plane", { size: 10 }, scene);
	plane.position.z = 2;
	const material = new StandardMaterial("WebGPU MRT Material", scene);
	material.disableLighting = true;
	material.backFaceCulling = false;
	material.emissiveColor = Color3.White();
	plane.material = material;
	const producer: ICustomRenderPassDefinition = {
		...definition("WebGPU MRT Producer"),
		output: "sceneColor",
		fragmentShader:
			"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; void main(void) { gl_FragData[0] = vec4(0.2, 0.4, 0.6, 1.0); gl_FragData[1] = vec4(0.9, 0.1, 0.2, 1.0); }",
		additionalOutputs: [{ name: "auxColor", outputType: "uint8", outputFormat: "rgba", outputSamples: 1 }],
	};
	const copy: ICustomRenderPassDefinition = {
		...definition("WebGPU Copy"),
		order: 1,
		dependencies: [producer.id],
		passType: "copy",
		copySource: { source: "pass", output: "auxColor" },
		output: "copiedColor",
	};
	const presenter: ICustomRenderPassDefinition = {
		...definition("WebGPU Presenter"),
		order: 2,
		dependencies: [copy.id],
		fragmentShader:
			"precision highp float; varying vec2 vUV; uniform sampler2D textureSampler; uniform sampler2D copiedSampler; void main(void) { gl_FragColor = texture2D(copiedSampler, vUV); }",
		inputs: { copiedSampler: { source: "pass", output: "copiedColor" } },
		output: "presentedColor",
	};
	applyCustomRenderPassGraph(scene, camera, [producer, copy, presenter]);
	for (let frame = 0; frame < 20; frame++) {
		engine.beginFrame();
		scene.render();
		engine.endFrame();
		await new Promise<void>((resolve) => setTimeout(resolve, 30));
	}
	const sceneColor = await readCustomRenderPassOutputPixels(camera, "sceneColor", false);
	const auxColor = await readCustomRenderPassOutputPixels(camera, "auxColor", false);
	const copiedColor = await readCustomRenderPassOutputPixels(camera, "copiedColor", false);
	const presentedColor = await readCustomRenderPassOutputPixels(camera, "presentedColor", false);
	const pixels = {
		sceneColor: centerPixel(sceneColor),
		auxColor: centerPixel(auxColor),
		copiedColor: centerPixel(copiedColor),
		presentedColor: centerPixel(presentedColor),
	};
	const diagnostics = getCustomRenderPassDiagnostics(camera);
	const targets = getCustomRenderPassMultiRenderTargets(camera);
	const passed =
		diagnostics.every((pass) => pass.ready && !pass.compilationError) &&
		targets.length === 1 &&
		targets[0].attachments.every((attachment) => attachment.ready) &&
		sceneColor.kind === "mrt" &&
		auxColor.kind === "mrt" &&
		copiedColor.kind === "copy" &&
		presentedColor.kind === "shader" &&
		approximately(pixels.sceneColor, [51, 102, 153, 255]) &&
		approximately(pixels.auxColor, [230, 26, 51, 255]) &&
		approximately(pixels.copiedColor, [230, 26, 51, 255]) &&
		approximately(pixels.presentedColor, [230, 26, 51, 255]);
	document.body.dataset.result = passed ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify({ diagnostics, targets, pixels });
	scene.dispose();
	engine.dispose();
}

void run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
});
