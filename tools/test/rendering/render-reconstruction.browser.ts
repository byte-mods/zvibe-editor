import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import "@babylonjs/core/Engines/Extensions/engine.readTexture";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.readTexture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";
import { PassPostProcess } from "@babylonjs/core/PostProcesses/passPostProcess";
import glslangFactory from "@babylonjs/core/assets/glslang/glslang.cjs";
import twgslFactory from "@babylonjs/core/assets/twgsl/twgsl.cjs";
import "@babylonjs/core/Rendering/prePassRendererSceneComponent";

import { configureDynamicResolution, dynamicResolutionPreset, sampleDynamicResolutionFrame, stopDynamicResolution } from "../../src/loading/dynamic-resolution";
import {
	configureRenderReconstruction,
	getRenderReconstructionRuntime,
	renderReconstructionPreset,
	resetRenderReconstructionHistory,
	stopRenderReconstruction,
} from "../../src/loading/render-reconstruction";

declare const __RENDER_RECONSTRUCTION_TARGET__: "webgl2" | "webgpu";

async function createEngine(canvas: HTMLCanvasElement): Promise<Engine | WebGPUEngine | null> {
	if (__RENDER_RECONSTRUCTION_TARGET__ === "webgpu") {
		const adapter = await (navigator as any).gpu?.requestAdapter();
		if (!adapter) {
			return null;
		}
		const glslang = glslangFactory(new URL("./glslang.wasm", location.href).href);
		const twgsl = await twgslFactory(new URL("./twgsl.wasm", location.href).href);
		return WebGPUEngine.CreateAsync(canvas, { glslangOptions: { glslang }, twgslOptions: { twgsl } });
	}
	return new Engine(canvas, false, { disableWebGL2Support: false, preserveDrawingBuffer: true, stencil: true });
}

function delay(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 16));
}

async function renderUntil(scene: Scene, predicate: () => boolean, frames = 90): Promise<number> {
	for (let frame = 1; frame <= frames; frame++) {
		const engine = scene.getEngine();
		engine.beginFrame();
		scene.render();
		engine.endFrame();
		if (predicate()) {
			return frame;
		}
		await delay();
	}
	throw new Error(`Reconstruction did not become ready after ${frames} frames: ${JSON.stringify(getRenderReconstructionRuntime(scene))}`);
}

async function presentationPixel(scene: Scene, presentation: RenderTargetTexture): Promise<number[]> {
	const engine = scene.getEngine();
	engine.beginFrame();
	scene.render();
	engine.endFrame();
	const pending = presentation.readPixels(0, 0, null, true, false, 0, 0, 320, 180);
	if (!pending) {
		throw new Error("The camera output target does not support readback.");
	}
	const pixels = await pending;
	const bytes = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	const offset = (90 * 320 + 160) * 4;
	return Array.from(bytes.subarray(offset, offset + 4));
}

async function run(): Promise<void> {
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 180;
	canvas.style.width = "320px";
	canvas.style.height = "180px";
	document.body.appendChild(canvas);
	const engine = await createEngine(canvas);
	if (!engine) {
		document.body.dataset.result = "unavailable";
		document.body.dataset.details = JSON.stringify({ target: __RENDER_RECONSTRUCTION_TARGET__, navigatorGpu: Boolean((navigator as any).gpu) });
		return;
	}
	const scene = new Scene(engine);
	scene.clearColor = new Color4(0.02, 0.03, 0.05, 1);
	const camera = new FreeCamera("Reconstruction Camera", new Vector3(0, 0, -6), scene);
	camera.setTarget(Vector3.Zero());
	const presentation = new RenderTargetTexture("Reconstruction Presentation", { width: 320, height: 180 }, scene, {
		generateMipMaps: false,
		doNotChangeAspectRatio: true,
		generateDepthBuffer: true,
	});
	camera.outputRenderTarget = presentation;
	scene.activeCamera = camera;
	const material = new StandardMaterial("Emissive", scene);
	material.disableLighting = true;
	material.emissiveColor = new Color3(0.82, 0.18, 0.06);
	const subject = MeshBuilder.CreateBox("Reconstruction Subject", { size: 2 }, scene);
	subject.material = material;
	await renderUntil(scene, () => material.isReady(subject));
	const controlPixel = await presentationPixel(scene, presentation);
	const controlPass = new PassPostProcess("Native Pass Control", 1, camera, undefined, engine);
	await renderUntil(scene, () => controlPass.isReady());
	const controlPassPixel = await presentationPixel(scene, presentation);
	controlPass.dispose(camera);
	const controlLowPass = new PassPostProcess("Native Low-Resolution Pass Control", 0.5, camera, undefined, engine);
	const controlFullPass = new PassPostProcess("Native Full-Resolution Pass Control", 1, camera, undefined, engine);
	await renderUntil(scene, () => controlLowPass.isReady() && controlFullPass.isReady());
	const controlLowPassPixel = await presentationPixel(scene, presentation);
	controlFullPass.dispose(camera);
	controlLowPass.dispose(camera);

	configureRenderReconstruction(scene, camera, "cross-backend", 1, { ...renderReconstructionPreset(), mode: "spatial" }, 0.5);
	const spatialFrames = await renderUntil(scene, () => {
		const runtime = getRenderReconstructionRuntime(scene);
		return runtime.spatialReady && runtime.presentationReady && runtime.sourceSize?.width === 160 && runtime.sourceSize.height === 90;
	});
	const spatial = structuredClone(getRenderReconstructionRuntime(scene));
	const spatialPostProcess = (
		camera as unknown as { _postProcesses: Array<{ shaderLanguage: number; getEffect: () => { getCompilationError: () => string; _fragmentSourceCode?: string } } | null> }
	)._postProcesses[0];
	const spatialShader = spatialPostProcess
		? {
				language: spatialPostProcess.shaderLanguage,
				compilationError: spatialPostProcess.getEffect().getCompilationError(),
				fragmentPrefix: spatialPostProcess.getEffect()._fragmentSourceCode?.slice(0, 160) ?? null,
			}
		: null;
	const spatialPixel = await presentationPixel(scene, presentation);

	stopRenderReconstruction(scene);
	configureRenderReconstruction(
		scene,
		camera,
		"cross-backend",
		2,
		{ ...renderReconstructionPreset(), mode: "temporal", historyWeight: 0.8, jitterSamples: 8, reprojectHistory: true },
		1
	);
	configureDynamicResolution(scene, "cross-backend", 2, { ...dynamicResolutionPreset(), mode: "fixed", fixedScale: 0.5 }, 1);
	const temporalFrames = await renderUntil(scene, () => {
		const runtime = getRenderReconstructionRuntime(scene);
		return runtime.spatialReady && runtime.temporalReady === true && runtime.presentationReady && runtime.historyFrames >= 4 && runtime.sourceSize?.width === 160;
	});
	const temporal = structuredClone(getRenderReconstructionRuntime(scene));
	const temporalPixel = await presentationPixel(scene, presentation);
	const reset = structuredClone(resetRenderReconstructionHistory(scene, "Cross-backend gate reset."));

	configureDynamicResolution(
		scene,
		"cross-backend",
		3,
		{
			...dynamicResolutionPreset(),
			mode: "adaptive",
			minimumScale: 0.5,
			maximumScale: 1,
			initialScale: 1,
			sampleFrames: 2,
			cooldownFrames: 0,
			downscaleStep: 0.25,
			upscaleStep: 0.25,
		},
		1
	);
	sampleDynamicResolutionFrame(scene, 30);
	sampleDynamicResolutionFrame(scene, 30);
	const downscaled = structuredClone(getRenderReconstructionRuntime(scene));
	sampleDynamicResolutionFrame(scene, 8);
	sampleDynamicResolutionFrame(scene, 8);
	const recovered = structuredClone(getRenderReconstructionRuntime(scene));

	const evidence = {
		target: __RENDER_RECONSTRUCTION_TARGET__,
		backend: engine.getClassName(),
		output: [engine.getRenderWidth(), engine.getRenderHeight()],
		controlPixel,
		controlPassPixel,
		controlLowPassPixel,
		spatialFrames,
		spatial: {
			source: spatial.sourceSize,
			output: spatial.outputSize,
			ready: spatial.spatialReady,
			presentationReady: spatial.presentationReady,
			shader: spatialShader,
			order: spatial.postProcessOrder,
			pixel: spatialPixel,
		},
		temporalFrames,
		temporal: {
			source: temporal.sourceSize,
			output: temporal.outputSize,
			spatialReady: temporal.spatialReady,
			temporalReady: temporal.temporalReady,
			presentationReady: temporal.presentationReady,
			velocityRequested: temporal.velocityRequested,
			velocityAvailable: temporal.velocityAvailable,
			historyFrames: temporal.historyFrames,
			jitterFrame: temporal.jitterFrame,
			order: temporal.postProcessOrder,
			pixel: temporalPixel,
		},
		reset: { valid: reset.historyValid, frames: reset.historyFrames, reason: reset.lastHistoryResetReason },
		dynamic: { downscaled: downscaled.sourceSize, recovered: recovered.sourceSize, output: recovered.outputSize },
	};
	const colored = (pixel: number[]) => pixel[0] > 80 && pixel[3] === 255;
	const passed =
		engine.getRenderWidth() === 320 &&
		engine.getRenderHeight() === 180 &&
		colored(controlPixel) &&
		colored(controlPassPixel) &&
		colored(controlLowPassPixel) &&
		spatial.sourceSize?.width === 160 &&
		spatial.sourceSize.height === 90 &&
		spatial.outputSize.width === 320 &&
		spatial.outputSize.height === 180 &&
		spatial.spatialReady &&
		spatial.presentationReady &&
		colored(spatialPixel) &&
		temporal.sourceSize?.width === 160 &&
		temporal.sourceSize.height === 90 &&
		temporal.outputSize.width === 320 &&
		temporal.outputSize.height === 180 &&
		temporal.spatialReady &&
		temporal.temporalReady === true &&
		temporal.presentationReady &&
		temporal.velocityRequested &&
		temporal.velocityAvailable &&
		temporal.historyFrames >= 4 &&
		temporal.jitterFrame >= 4 &&
		colored(temporalPixel) &&
		!reset.historyValid &&
		reset.historyFrames === 0 &&
		reset.lastHistoryResetReason === "Cross-backend gate reset." &&
		downscaled.sourceSize?.width === 240 &&
		recovered.sourceSize?.width === 320 &&
		recovered.outputSize.width === 320;
	document.body.dataset.result = passed ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify(evidence);
	stopDynamicResolution(scene);
	stopRenderReconstruction(scene);
	scene.dispose();
	engine.dispose();
}

run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
});
