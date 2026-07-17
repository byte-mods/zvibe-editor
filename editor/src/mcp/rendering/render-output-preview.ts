import { createHash } from "crypto";

import sharp from "sharp";

import { Scene } from "babylonjs";
import { readCustomRenderPassOutputPixels } from "babylonjs-editor-tools";

/** Reads a live texture-backed graph output and returns a bounded PNG plus deterministic pixel diagnostics. */
export async function captureCustomRenderPassOutput(scene: Scene, data: any): Promise<any> {
	if (!scene.activeCamera) throw new Error("No active camera is available for render-graph output capture.");
	const width = data.width ?? 128;
	const height = data.height ?? 128;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || width > 256 || height < 16 || height > 256)
		throw new Error("Render-output preview width and height must be integers from 16 through 256.");
	const sampling: "nearest" | "bilinear" = data.sampling ?? "bilinear";
	if (sampling !== "nearest" && sampling !== "bilinear") throw new Error("Render-output preview sampling must be nearest or bilinear.");
	const flipY = data.flipY !== false;
	const includeImage = data.includeImage !== false;
	const source = await readCustomRenderPassOutputPixels(scene.activeCamera as any, data.output, flipY);
	const resized = await sharp(source.pixels, { raw: { width: source.width, height: source.height, channels: 4 } })
		.resize({ width, height, fit: "inside", withoutEnlargement: false, kernel: sampling === "nearest" ? sharp.kernel.nearest : sharp.kernel.lanczos3 })
		.raw()
		.toBuffer({ resolveWithObject: true });
	const sums = [0, 0, 0, 0];
	const minimum = [255, 255, 255, 255];
	const maximum = [0, 0, 0, 0];
	let coveredPixels = 0;
	for (let offset = 0; offset < resized.data.length; offset += 4) {
		for (let channel = 0; channel < 4; channel++) {
			const value = resized.data[offset + channel];
			sums[channel] += value;
			minimum[channel] = Math.min(minimum[channel], value);
			maximum[channel] = Math.max(maximum[channel], value);
		}
		if (resized.data[offset + 3] > 0) coveredPixels++;
	}
	const pixelCount = resized.info.width * resized.info.height;
	const png = includeImage
		? await sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: 4 } })
				.png({ compressionLevel: 9 })
				.toBuffer()
		: null;
	return {
		passId: source.passId,
		passName: source.passName,
		output: source.output,
		kind: source.kind,
		runtimeReady: source.runtimeReady,
		source: {
			width: source.width,
			height: source.height,
			outputType: source.outputType,
			outputFormat: source.outputFormat,
			pixelSha256: createHash("sha256").update(source.pixels).digest("hex"),
			flipY,
			nonFiniteValueCount: source.nonFiniteValueCount,
		},
		preview: {
			width: resized.info.width,
			height: resized.info.height,
			channels: 4,
			sampling,
			mimeType: "image/png",
			pixelSha256: createHash("sha256").update(resized.data).digest("hex"),
			averageRgba: sums.map((sum) => Number((sum / pixelCount / 255).toFixed(6))),
			minimumRgba: minimum.map((value) => Number((value / 255).toFixed(6))),
			maximumRgba: maximum.map((value) => Number((value / 255).toFixed(6))),
			alphaCoverage: Number((coveredPixels / pixelCount).toFixed(6)),
			...(png ? { imageBase64: png.toString("base64") } : {}),
		},
	};
}
