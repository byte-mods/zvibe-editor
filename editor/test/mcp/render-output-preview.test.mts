import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import sharp from "sharp";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { disposeCustomRenderPassGraph, getCustomRenderPassOutputTexture } from "babylonjs-editor-tools";

import { createCustomRenderPass } from "../../src/mcp/rendering/custom-passes";
import { captureCustomRenderPassOutput } from "../../src/mcp/rendering/render-output-preview";

describe("mcp/render-output-preview", () => {
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

	test("encodes a bounded upright PNG and deterministic diagnostics from live named raster output bytes", async () => {
		const pass = createCustomRenderPass(scene, { name: "Capture Raster", passType: "raster", output: "captureColor" }, options);
		const target = scene.customRenderTargets[0] as any;
		target.getSize = () => ({ width: 2, height: 2 });
		target.readPixels = async () => new Uint8Array([0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
		const result = await captureCustomRenderPassOutput(scene, { output: "captureColor", width: 16, height: 16, sampling: "nearest" });
		expect(result).toMatchObject({
			passId: pass.id,
			passName: "Capture Raster",
			output: "captureColor",
			kind: "raster",
			runtimeReady: expect.any(Boolean),
			source: {
				width: 2,
				height: 2,
				outputType: "uint8",
				outputFormat: "rgba",
				pixelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				flipY: true,
				nonFiniteValueCount: 0,
			},
			preview: {
				width: 16,
				height: 16,
				channels: 4,
				sampling: "nearest",
				mimeType: "image/png",
				pixelSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				averageRgba: [0.5, 0.5, 0.5, 1],
				minimumRgba: [0, 0, 0, 1],
				maximumRgba: [1, 1, 1, 1],
				alphaCoverage: 1,
				imageBase64: expect.any(String),
			},
		});
		const decoded = await sharp(Buffer.from(result.preview.imageBase64, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect([...decoded.data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
		expect([...decoded.data.subarray((15 * 16 + 15) * 4, (15 * 16 + 15) * 4 + 4)]).toEqual([255, 255, 255, 255]);
	});

	test("supports metadata-only raster, shader, and copy capture and rejects invalid dimensions", async () => {
		createCustomRenderPass(scene, { name: "Capture Raster", passType: "raster", output: "captureColor" }, options);
		const target = scene.customRenderTargets[0] as any;
		target.getSize = () => ({ width: 1, height: 1 });
		target.readPixels = async () => new Float32Array([1, 0.5, 0, 1]);
		const metadata = await captureCustomRenderPassOutput(scene, { output: "captureColor", width: 16, height: 16, includeImage: false, flipY: false });
		expect(metadata.preview).toMatchObject({ averageRgba: [1, 0.501961, 0, 1] });
		expect(metadata.preview).not.toHaveProperty("imageBase64");
		await expect(captureCustomRenderPassOutput(scene, { output: "captureColor", width: 257 })).rejects.toThrow("16 through 256");

		createCustomRenderPass(scene, { name: "Stable Shader", output: "shaderColor" }, options);
		const shaderTarget = getCustomRenderPassOutputTexture(camera as any, "shaderColor") as any;
		shaderTarget.getSize = () => ({ width: 1, height: 1 });
		shaderTarget.readPixels = async () => new Uint8Array([10, 20, 30, 255]);
		const shaderCapture = await captureCustomRenderPassOutput(scene, { output: "shaderColor", width: 16, height: 16, includeImage: false, flipY: false });
		expect(shaderCapture).toMatchObject({ kind: "shader", preview: { minimumRgba: [0.039216, 0.078431, 0.117647, 1] } });

		createCustomRenderPass(scene, { name: "Stable Copy", passType: "copy", copySource: { source: "screen" }, output: "copyColor" }, options);
		const copyTarget = getCustomRenderPassOutputTexture(camera as any, "copyColor") as any;
		copyTarget.getSize = () => ({ width: 1, height: 1 });
		copyTarget.readPixels = async () => new Uint8Array([40, 50, 60, 255]);
		const copyCapture = await captureCustomRenderPassOutput(scene, { output: "copyColor", width: 16, height: 16, includeImage: false, flipY: false });
		expect(copyCapture).toMatchObject({ kind: "copy", preview: { maximumRgba: [0.156863, 0.196078, 0.235294, 1] } });
		scene.activeCamera = null;
		await expect(captureCustomRenderPassOutput(scene, { output: "captureColor" })).rejects.toThrow("No active camera");
	});
});
