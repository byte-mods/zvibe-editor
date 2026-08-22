import { Engine } from "@babylonjs/core/Engines/engine";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import glslangFactory from "@babylonjs/core/assets/glslang/glslang.cjs";
import twgslFactory from "@babylonjs/core/assets/twgsl/twgsl.cjs";

import {
	configureDynamicResolution,
	dynamicResolutionPreset,
	getDynamicResolutionRuntime,
	resetDynamicResolutionRuntime,
	sampleDynamicResolutionFrame,
	stopDynamicResolution,
} from "../../src/loading/dynamic-resolution";

declare const __DYNAMIC_RESOLUTION_TARGET__: "webgl2" | "webgpu";

async function createEngine(canvas: HTMLCanvasElement): Promise<Engine | WebGPUEngine | null> {
	if (__DYNAMIC_RESOLUTION_TARGET__ === "webgpu") {
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
		document.body.dataset.details = JSON.stringify({ target: __DYNAMIC_RESOLUTION_TARGET__, navigatorGpu: Boolean((navigator as any).gpu) });
		return;
	}
	const scene = new Scene(engine);
	scene.activeCamera = new FreeCamera("Dynamic Resolution Camera", Vector3.Zero(), scene);
	scene.clearColor = new Color4(0.2, 0.4, 0.6, 1);
	const initialImageRendering = canvas.style.imageRendering;

	configureDynamicResolution(scene, "live-profile", 1, { ...dynamicResolutionPreset(), mode: "fixed", fixedScale: 0.5, upscaler: "browser-pixelated" }, 1);
	scene.render();
	const fixed = structuredClone(getDynamicResolutionRuntime(scene));
	const fixedWidth = engine.getRenderWidth();
	const fixedHeight = engine.getRenderHeight();
	const pixels = await engine.readPixels(0, 0, fixedWidth, fixedHeight);
	const centerOffset = (Math.floor(fixedHeight / 2) * fixedWidth + Math.floor(fixedWidth / 2)) * 4;
	const pixelBytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
	const centerPixel = Array.from(pixelBytes.subarray(centerOffset, centerOffset + 4));

	configureDynamicResolution(
		scene,
		"live-profile",
		2,
		{
			...dynamicResolutionPreset(),
			mode: "adaptive",
			minimumScale: 0.5,
			maximumScale: 1,
			initialScale: 1,
			sampleFrames: 2,
			cooldownFrames: 1,
			downscaleStep: 0.25,
			upscaleStep: 0.25,
			upscaler: "browser-linear",
		},
		1
	);
	sampleDynamicResolutionFrame(scene, 30);
	sampleDynamicResolutionFrame(scene, 30);
	const downscaled = structuredClone(getDynamicResolutionRuntime(scene));
	const downscaledWidth = engine.getRenderWidth();
	sampleDynamicResolutionFrame(scene, 8);
	sampleDynamicResolutionFrame(scene, 8);
	const upscaled = structuredClone(getDynamicResolutionRuntime(scene));
	const upscaledWidth = engine.getRenderWidth();
	const reset = structuredClone(resetDynamicResolutionRuntime(scene));
	stopDynamicResolution(scene);

	const evidence = {
		target: __DYNAMIC_RESOLUTION_TARGET__,
		backend: engine.getClassName(),
		initialCanvas: [320, 180],
		fixed: { requestedScale: fixed.requestedScale, effectiveScale: fixed.effectiveScale, renderSize: [fixedWidth, fixedHeight], imageRendering: "pixelated", centerPixel },
		downscaled: { requestedScale: downscaled.requestedScale, effectiveScale: downscaled.effectiveScale, renderWidth: downscaledWidth, decision: downscaled.lastDecision },
		upscaled: { requestedScale: upscaled.requestedScale, effectiveScale: upscaled.effectiveScale, renderWidth: upscaledWidth, decision: upscaled.lastDecision },
		reset: { requestedScale: reset.requestedScale, totalFrames: reset.totalFrames, changes: reset.scaleChanges.length },
		presentationRestored: canvas.style.imageRendering === initialImageRendering,
	};
	const colorReadbackPassed =
		(centerPixel[0] >= 48 && centerPixel[1] >= 99 && centerPixel[2] >= 150 && centerPixel[3] === 255) ||
		(centerPixel[0] >= 150 && centerPixel[1] >= 99 && centerPixel[2] >= 48 && centerPixel[3] === 255);
	const passed =
		fixed.requestedScale === 0.5 &&
		Math.abs(fixed.effectiveScale - 0.5) < 0.001 &&
		fixedWidth === 160 &&
		fixedHeight === 90 &&
		colorReadbackPassed &&
		downscaled.requestedScale === 0.75 &&
		Math.abs(downscaled.effectiveScale - 0.75) < 0.001 &&
		downscaled.lastDecision === "downscale" &&
		downscaledWidth === 240 &&
		upscaled.requestedScale === 1 &&
		Math.abs(upscaled.effectiveScale - 1) < 0.001 &&
		upscaled.lastDecision === "upscale" &&
		upscaledWidth === 320 &&
		reset.totalFrames === 0 &&
		reset.scaleChanges.length === 0 &&
		evidence.presentationRestored;
	document.body.dataset.result = passed ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify(evidence);
	scene.dispose();
	engine.dispose();
}

run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
});
