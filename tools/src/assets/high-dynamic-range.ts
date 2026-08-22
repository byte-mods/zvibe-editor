import { ReadExrDataAsync } from "@babylonjs/core/Materials/Textures/Loaders/exrTextureLoader.js";
import { ExrLoaderGlobalConfiguration } from "@babylonjs/core/Materials/Textures/Loaders/EXR/exrLoader.configuration.js";
import { Tools } from "@babylonjs/core/Misc/tools.pure.js";
import * as fflate from "fflate";

import { ITextureImporterSettings, TextureImporterResizeAlgorithm } from "./texture-importer";
import { textureImporterMipmapDimensions, textureImporterOutputDimensions } from "./texture-processing";

export type HighDynamicRangeFormat = "hdr" | "exr";
export type HighDynamicRangeCompression = "raw" | "rle" | "zips" | "zip" | "piz" | "pxr24";

export interface IHighDynamicRangeStatistics {
	minimum: [number, number, number, number];
	maximum: [number, number, number, number];
	average: [number, number, number, number];
	nonFiniteCount: number;
}

export interface IHighDynamicRangeImage {
	format: HighDynamicRangeFormat;
	width: number;
	height: number;
	channels: number;
	hasAlpha: boolean;
	pixelType: "rgbe8" | "float16" | "float32";
	compression: HighDynamicRangeCompression;
	pixels: Float32Array;
	statistics: IHighDynamicRangeStatistics;
}

export interface IHighDynamicRangeCubeFace {
	face: "px" | "nx" | "py" | "ny" | "pz" | "nz";
	width: number;
	height: number;
	pixels: Float32Array;
}

export interface IExecutedHighDynamicRangeMipmap {
	image: IHighDynamicRangeImage;
	bytes: Uint8Array;
	alphaCoverageBefore?: number;
	alphaCoverageAfter?: number;
	alphaCoverageScale?: number;
}

export interface IExecutedHighDynamicRangeTextureImport {
	source: IHighDynamicRangeImage;
	output: IHighDynamicRangeImage;
	outputBytes: Uint8Array;
	resized: boolean;
	alphaRemoved: boolean;
	transparentColorsDilated: boolean;
	normalMapGenerated: boolean;
	equirectangular: boolean;
	cubeFaceSize: number | null;
	cubeFaces: IHighDynamicRangeCubeFace[];
	environmentBytes: Uint8Array | null;
	mipmaps: IExecutedHighDynamicRangeMipmap[];
}

const maximumDimension = 32_768;
const maximumPixels = 32 * 1024 * 1024;
const maximumHeaderBytes = 1024 * 1024;
const maximumAttributes = 256;
const exrMagic = 20_000_630;
const textDecoder = new TextDecoder("ascii", { fatal: false });

function assertDimensions(width: number, height: number): void {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new Error("High-dynamic-range image dimensions must be positive integers.");
	}
	if (width > maximumDimension || height > maximumDimension) {
		throw new Error(`High-dynamic-range image dimensions may not exceed ${maximumDimension} pixels per side.`);
	}
	if (width * height > maximumPixels) {
		throw new Error(`High-dynamic-range images may not exceed ${maximumPixels.toLocaleString()} pixels.`);
	}
}

function readAsciiLine(bytes: Uint8Array, offset: { value: number }): string {
	const start = offset.value;
	const limit = Math.min(bytes.length, maximumHeaderBytes);
	while (offset.value < limit && bytes[offset.value] !== 0x0a) {
		offset.value++;
	}
	if (offset.value >= limit) {
		throw new Error("Radiance HDR header is unterminated or exceeds 1 MiB.");
	}
	const line = textDecoder.decode(bytes.subarray(start, offset.value)).replace(/\r$/, "");
	offset.value++;
	return line;
}

function toStatistics(pixels: Float32Array): IHighDynamicRangeStatistics {
	const minimum: [number, number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
	const maximum: [number, number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
	const totals = [0, 0, 0, 0];
	let nonFiniteCount = 0;
	for (let offset = 0; offset < pixels.length; offset += 4) {
		for (let channel = 0; channel < 4; channel++) {
			const value = pixels[offset + channel];
			if (!Number.isFinite(value)) {
				nonFiniteCount++;
				continue;
			}
			minimum[channel] = Math.min(minimum[channel], value);
			maximum[channel] = Math.max(maximum[channel], value);
			totals[channel] += value;
		}
	}
	const pixelCount = pixels.length / 4;
	return {
		minimum: minimum.map((value) => (Number.isFinite(value) ? value : 0)) as [number, number, number, number],
		maximum: maximum.map((value) => (Number.isFinite(value) ? value : 0)) as [number, number, number, number],
		average: totals.map((value) => value / pixelCount) as [number, number, number, number],
		nonFiniteCount,
	};
}

function rgbeToFloat(red: number, green: number, blue: number, exponent: number, output: Float32Array, offset: number): void {
	if (exponent === 0) {
		output[offset] = 0;
		output[offset + 1] = 0;
		output[offset + 2] = 0;
	} else {
		const scale = Math.pow(2, exponent - 136);
		output[offset] = red * scale;
		output[offset + 1] = green * scale;
		output[offset + 2] = blue * scale;
	}
	output[offset + 3] = 1;
}

function decodeHdrScanline(bytes: Uint8Array, dataOffset: { value: number }, width: number): Uint8Array {
	if (dataOffset.value + 4 > bytes.length) {
		throw new Error("Radiance HDR pixel data ends before the next scanline header.");
	}
	const start = dataOffset.value;
	const headerWidth = (bytes[start + 2] << 8) | bytes[start + 3];
	if (width < 8 || width > 0x7fff || bytes[start] !== 2 || bytes[start + 1] !== 2 || (bytes[start + 2] & 0x80) !== 0) {
		const byteLength = width * 4;
		if (dataOffset.value + byteLength > bytes.length) {
			throw new Error("Radiance HDR raw scanline is truncated.");
		}
		const result = bytes.slice(dataOffset.value, dataOffset.value + byteLength);
		dataOffset.value += byteLength;
		return result;
	}
	if (headerWidth !== width) {
		throw new Error(`Radiance HDR scanline declares width ${headerWidth}, expected ${width}.`);
	}
	dataOffset.value += 4;
	const planar = new Uint8Array(width * 4);
	for (let channel = 0; channel < 4; channel++) {
		let written = 0;
		while (written < width) {
			if (dataOffset.value + 2 > bytes.length) {
				throw new Error("Radiance HDR RLE packet header is truncated.");
			}
			const code = bytes[dataOffset.value++];
			if (code > 128) {
				const count = code - 128;
				const value = bytes[dataOffset.value++];
				if (count === 0 || written + count > width) {
					throw new Error("Radiance HDR RLE run exceeds its channel scanline.");
				}
				planar.fill(value, channel * width + written, channel * width + written + count);
				written += count;
			} else {
				const count = code;
				if (count === 0 || written + count > width || dataOffset.value + count > bytes.length) {
					throw new Error("Radiance HDR RLE literal exceeds its channel scanline or source bytes.");
				}
				planar.set(bytes.subarray(dataOffset.value, dataOffset.value + count), channel * width + written);
				dataOffset.value += count;
				written += count;
			}
		}
	}
	const interleaved = new Uint8Array(width * 4);
	for (let x = 0; x < width; x++) {
		for (let channel = 0; channel < 4; channel++) {
			interleaved[x * 4 + channel] = planar[channel * width + x];
		}
	}
	return interleaved;
}

/** Decodes a bounded Radiance RGBE panorama into top-left-origin linear RGBA32F pixels. */
export function decodeRadianceHdr(bytes: Uint8Array): IHighDynamicRangeImage {
	const offset = { value: 0 };
	const signature = readAsciiLine(bytes, offset);
	if (signature !== "#?RADIANCE" && signature !== "#?RGBE") {
		throw new Error("Radiance HDR signature must be #?RADIANCE or #?RGBE.");
	}
	let formatFound = false;
	while (true) {
		const line = readAsciiLine(bytes, offset);
		if (!line) {
			break;
		}
		if (line === "FORMAT=32-bit_rle_rgbe") {
			formatFound = true;
		}
	}
	if (!formatFound) {
		throw new Error("Radiance HDR requires FORMAT=32-bit_rle_rgbe.");
	}
	const resolution = readAsciiLine(bytes, offset).match(/^([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)$/);
	if (!resolution) {
		throw new Error("Radiance HDR resolution must use the ±Y height ±X width form.");
	}
	const height = Number(resolution[2]);
	const width = Number(resolution[4]);
	assertDimensions(width, height);
	const pixels = new Float32Array(width * height * 4);
	for (let fileY = 0; fileY < height; fileY++) {
		const scanline = decodeHdrScanline(bytes, offset, width);
		const targetY = resolution[1] === "-" ? fileY : height - fileY - 1;
		for (let fileX = 0; fileX < width; fileX++) {
			const targetX = resolution[3] === "+" ? fileX : width - fileX - 1;
			const sourceOffset = fileX * 4;
			rgbeToFloat(scanline[sourceOffset], scanline[sourceOffset + 1], scanline[sourceOffset + 2], scanline[sourceOffset + 3], pixels, (targetY * width + targetX) * 4);
		}
	}
	if (offset.value !== bytes.length) {
		throw new Error(`Radiance HDR contains ${bytes.length - offset.value} trailing byte(s) after its exact pixel payload.`);
	}
	return { format: "hdr", width, height, channels: 3, hasAlpha: false, pixelType: "rgbe8", compression: "rle", pixels, statistics: toStatistics(pixels) };
}

interface IExrHeaderEvidence {
	width: number;
	height: number;
	hasAlpha: boolean;
	channels: number;
	pixelType: "float16" | "float32";
	compression: HighDynamicRangeCompression;
}

function readNullTerminated(bytes: Uint8Array, offset: { value: number }, limit: number, label: string): string {
	const start = offset.value;
	while (offset.value < limit && bytes[offset.value] !== 0) {
		offset.value++;
	}
	if (offset.value >= limit) {
		throw new Error(`OpenEXR ${label} is unterminated.`);
	}
	const value = textDecoder.decode(bytes.subarray(start, offset.value));
	offset.value++;
	return value;
}

function inspectOpenExr(bytes: Uint8Array): IExrHeaderEvidence {
	if (bytes.byteLength < 16) {
		throw new Error("OpenEXR data is shorter than its required header.");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== exrMagic) {
		throw new Error("OpenEXR magic number is invalid.");
	}
	const version = view.getUint32(4, true);
	if ((version & 0xff) !== 2) {
		throw new Error(`OpenEXR version ${version & 0xff} is unsupported; version 2 scanline images are required.`);
	}
	if ((version & 0x00001a00) !== 0) {
		throw new Error("Tiled, deep, and multipart OpenEXR files are not supported by this importer.");
	}
	const offset = { value: 8 };
	let attributeCount = 0;
	let dataWindow: [number, number, number, number] | null = null;
	let compressionCode: number | null = null;
	let channels: Array<{ name: string; pixelType: number; xSampling: number; ySampling: number }> | null = null;
	while (true) {
		if (offset.value >= bytes.length || offset.value >= maximumHeaderBytes) {
			throw new Error("OpenEXR header is unterminated or exceeds 1 MiB.");
		}
		const name = readNullTerminated(bytes, offset, Math.min(bytes.length, maximumHeaderBytes), "attribute name");
		if (!name) {
			break;
		}
		if (++attributeCount > maximumAttributes) {
			throw new Error(`OpenEXR header may contain at most ${maximumAttributes} attributes.`);
		}
		const type = readNullTerminated(bytes, offset, Math.min(bytes.length, maximumHeaderBytes), "attribute type");
		if (offset.value + 4 > bytes.length) {
			throw new Error("OpenEXR attribute size is truncated.");
		}
		const size = view.getUint32(offset.value, true);
		offset.value += 4;
		const start = offset.value;
		const end = start + size;
		if (!Number.isSafeInteger(end) || end > bytes.length || end > maximumHeaderBytes) {
			throw new Error(`OpenEXR attribute "${name}" exceeds the bounded header bytes.`);
		}
		if (name === "dataWindow" && type === "box2i" && size === 16) {
			dataWindow = [view.getInt32(start, true), view.getInt32(start + 4, true), view.getInt32(start + 8, true), view.getInt32(start + 12, true)];
		} else if (name === "compression" && type === "compression" && size === 1) {
			compressionCode = view.getUint8(start);
		} else if (name === "channels" && type === "chlist") {
			channels = [];
			const channelOffset = { value: start };
			while (channelOffset.value < end - 1) {
				const channelName = readNullTerminated(bytes, channelOffset, end, "channel name");
				if (channelOffset.value + 16 > end) {
					throw new Error("OpenEXR channel descriptor is truncated.");
				}
				channels.push({
					name: channelName,
					pixelType: view.getInt32(channelOffset.value, true),
					xSampling: view.getInt32(channelOffset.value + 8, true),
					ySampling: view.getInt32(channelOffset.value + 12, true),
				});
				channelOffset.value += 16;
			}
			if (bytes[end - 1] !== 0 || channelOffset.value !== end - 1) {
				throw new Error("OpenEXR channel list does not end at its declared boundary.");
			}
		}
		offset.value = end;
	}
	if (!dataWindow || compressionCode === null || !channels?.length) {
		throw new Error("OpenEXR requires channels, compression, and dataWindow attributes.");
	}
	const width = dataWindow[2] - dataWindow[0] + 1;
	const height = dataWindow[3] - dataWindow[1] + 1;
	assertDimensions(width, height);
	const relevant = channels.filter((channel) => ["R", "G", "B", "A", "Y"].includes(channel.name));
	const names = new Set(relevant.map((channel) => channel.name));
	if (!(names.has("R") && names.has("G") && names.has("B")) && !names.has("R") && !names.has("Y")) {
		throw new Error("OpenEXR must contain RGB, R, or Y image channels.");
	}
	if (relevant.some((channel) => channel.xSampling !== 1 || channel.ySampling !== 1)) {
		throw new Error("Subsampled OpenEXR image channels are unsupported.");
	}
	const pixelTypes = new Set(relevant.map((channel) => channel.pixelType));
	if (pixelTypes.size !== 1 || ![1, 2].includes(relevant[0].pixelType)) {
		throw new Error("OpenEXR image channels must consistently use HALF or FLOAT samples.");
	}
	const compressions: HighDynamicRangeCompression[] = ["raw", "rle", "zips", "zip", "piz", "pxr24"];
	if (compressionCode < 0 || compressionCode >= compressions.length) {
		throw new Error(`OpenEXR compression code ${compressionCode} is unsupported.`);
	}
	const scanlineBlockSizes = [1, 1, 1, 16, 32, 16];
	const blockCount = Math.ceil(height / scanlineBlockSizes[compressionCode]);
	if (offset.value + blockCount * 8 > bytes.length) {
		throw new Error("OpenEXR scanline offset table is truncated.");
	}
	for (let index = 0; index < blockCount; index++) {
		const low = view.getUint32(offset.value + index * 8, true);
		const high = view.getUint32(offset.value + index * 8 + 4, true);
		const chunkOffset = low + high * 0x1_0000_0000;
		if (!Number.isSafeInteger(chunkOffset) || chunkOffset < offset.value + blockCount * 8 || chunkOffset + 8 > bytes.length) {
			throw new Error("OpenEXR scanline offset points outside the source bytes.");
		}
		const chunkBytes = view.getUint32(chunkOffset + 4, true);
		if (chunkOffset + 8 + chunkBytes > bytes.length) {
			throw new Error("OpenEXR scanline chunk exceeds the source bytes.");
		}
	}
	return {
		width,
		height,
		hasAlpha: names.has("A"),
		channels: names.has("R") && names.has("G") && names.has("B") ? (names.has("A") ? 4 : 3) : 1,
		pixelType: relevant[0].pixelType === 1 ? "float16" : "float32",
		compression: compressions[compressionCode],
	};
}

let installedBundledExrInflater = false;

function ensureBundledExrInflater(): void {
	if (installedBundledExrInflater) {
		return;
	}
	installedBundledExrInflater = true;
	(globalThis as typeof globalThis & { fflate?: typeof fflate }).fflate = fflate;
	const originalLoadScriptAsync = Tools.LoadScriptAsync.bind(Tools);
	Tools.LoadScriptAsync = async (url: string, id?: string): Promise<void> => {
		if (url === ExrLoaderGlobalConfiguration.FFLATEUrl) {
			return;
		}
		return originalLoadScriptAsync(url, id);
	};
}

/** Decodes bounded single-part scanline OpenEXR HALF/FLOAT images through Babylon's bundled decoder with a local ZIP inflater. */
export async function decodeOpenExr(bytes: Uint8Array): Promise<IHighDynamicRangeImage> {
	const evidence = inspectOpenExr(bytes);
	ensureBundledExrInflater();
	const copy = bytes.slice().buffer;
	const decoded = await ReadExrDataAsync(copy);
	if (!decoded.data || decoded.width !== evidence.width || decoded.height !== evidence.height) {
		throw new Error("OpenEXR pixel decoding failed after its bounded header validation.");
	}
	const sourceChannels = decoded.data.length / (evidence.width * evidence.height);
	if (![1, 4].includes(sourceChannels)) {
		throw new Error(`OpenEXR decoded to unsupported ${sourceChannels}-channel pixels.`);
	}
	const pixels = new Float32Array(evidence.width * evidence.height * 4);
	for (let index = 0; index < evidence.width * evidence.height; index++) {
		if (sourceChannels === 1) {
			pixels[index * 4] = decoded.data[index];
			pixels[index * 4 + 1] = decoded.data[index];
			pixels[index * 4 + 2] = decoded.data[index];
			pixels[index * 4 + 3] = 1;
		} else {
			pixels.set(decoded.data.subarray(index * 4, index * 4 + 4), index * 4);
		}
	}
	return { format: "exr", ...evidence, pixels, statistics: toStatistics(pixels) };
}

/** Decodes a supported HDR or EXR source based on its explicit format. */
export async function decodeHighDynamicRange(bytes: Uint8Array, format: HighDynamicRangeFormat): Promise<IHighDynamicRangeImage> {
	return format === "hdr" ? decodeRadianceHdr(bytes) : decodeOpenExr(bytes);
}

function kernelRadius(algorithm: TextureImporterResizeAlgorithm): number {
	return algorithm === "nearest" ? 0.5 : algorithm === "bilinear" ? 1 : algorithm === "bicubic" ? 2 : 3;
}

function sinc(value: number): number {
	return value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
}

function kernelWeight(value: number, algorithm: TextureImporterResizeAlgorithm): number {
	const distance = Math.abs(value);
	if (algorithm === "nearest") {
		return distance < 0.5 ? 1 : 0;
	}
	if (algorithm === "bilinear") {
		return Math.max(0, 1 - distance);
	}
	if (algorithm === "bicubic") {
		const b = 1 / 3;
		const c = 1 / 3;
		if (distance < 1) {
			return ((12 - 9 * b - 6 * c) * distance ** 3 + (-18 + 12 * b + 6 * c) * distance ** 2 + (6 - 2 * b)) / 6;
		}
		if (distance < 2) {
			return ((-b - 6 * c) * distance ** 3 + (6 * b + 30 * c) * distance ** 2 + (-12 * b - 48 * c) * distance + (8 * b + 24 * c)) / 6;
		}
		return 0;
	}
	return distance < 3 ? sinc(distance) * sinc(distance / 3) : 0;
}

interface IResampleContribution {
	indices: number[];
	weights: number[];
}

function resampleContributions(sourceSize: number, targetSize: number, algorithm: TextureImporterResizeAlgorithm): IResampleContribution[] {
	const scale = sourceSize / targetSize;
	const filterScale = Math.max(1, scale);
	const radius = kernelRadius(algorithm) * filterScale;
	const result: IResampleContribution[] = [];
	for (let target = 0; target < targetSize; target++) {
		const centre = (target + 0.5) * scale - 0.5;
		const first = Math.ceil(centre - radius);
		const last = Math.floor(centre + radius);
		const indices: number[] = [];
		const weights: number[] = [];
		let total = 0;
		for (let source = first; source <= last; source++) {
			const weight = kernelWeight((source - centre) / filterScale, algorithm);
			if (weight === 0) {
				continue;
			}
			indices.push(Math.max(0, Math.min(sourceSize - 1, source)));
			weights.push(weight);
			total += weight;
		}
		if (total === 0) {
			indices.push(Math.max(0, Math.min(sourceSize - 1, Math.round(centre))));
			weights.push(1);
		} else {
			for (let index = 0; index < weights.length; index++) {
				weights[index] /= total;
			}
		}
		result.push({ indices, weights });
	}
	return result;
}

/** Aspect-safely resizes linear RGBA32F pixels using the requested nearest, bilinear, Mitchell, or Lanczos3 kernel. */
export function resizeHighDynamicRange(image: IHighDynamicRangeImage, maximumSize: number, algorithm: TextureImporterResizeAlgorithm): IHighDynamicRangeImage {
	if (image.width <= maximumSize && image.height <= maximumSize) {
		return image;
	}
	const scale = Math.min(maximumSize / image.width, maximumSize / image.height);
	const width = Math.max(1, Math.round(image.width * scale));
	const height = Math.max(1, Math.round(image.height * scale));
	return resizeHighDynamicRangeExact(image, width, height, algorithm);
}

/** Resamples linear RGBA32F pixels to exact dimensions so NPOT and complete-mip policies cannot drift from LDR builds. */
export function resizeHighDynamicRangeExact(image: IHighDynamicRangeImage, width: number, height: number, algorithm: TextureImporterResizeAlgorithm): IHighDynamicRangeImage {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > maximumDimension || height > maximumDimension) {
		throw new Error("High-dynamic-range target dimensions must be positive integers no larger than " + maximumDimension + ".");
	}
	if (width * height > maximumPixels) {
		throw new Error("High-dynamic-range target dimensions may not exceed " + maximumPixels.toLocaleString() + " pixels.");
	}
	if (image.width === width && image.height === height) {
		return image;
	}
	const horizontal = resampleContributions(image.width, width, algorithm);
	const vertical = resampleContributions(image.height, height, algorithm);
	const intermediate = new Float32Array(width * image.height * 4);
	for (let y = 0; y < image.height; y++) {
		for (let x = 0; x < width; x++) {
			const contribution = horizontal[x];
			for (let channel = 0; channel < 4; channel++) {
				let value = 0;
				for (let index = 0; index < contribution.indices.length; index++) {
					value += image.pixels[(y * image.width + contribution.indices[index]) * 4 + channel] * contribution.weights[index];
				}
				intermediate[(y * width + x) * 4 + channel] = value;
			}
		}
	}
	const pixels = new Float32Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const contribution = vertical[y];
		for (let x = 0; x < width; x++) {
			for (let channel = 0; channel < 4; channel++) {
				let value = 0;
				for (let index = 0; index < contribution.indices.length; index++) {
					value += intermediate[(contribution.indices[index] * width + x) * 4 + channel] * contribution.weights[index];
				}
				pixels[(y * width + x) * 4 + channel] = value;
			}
		}
	}
	return { ...image, width, height, pixels, statistics: toStatistics(pixels) };
}

/** Measures float alpha-test coverage with an optional scale used by the bounded preservation search. */
function highDynamicRangeAlphaCoverage(pixels: Float32Array, alphaTestReference: number, scale = 1): number {
	let covered = 0;
	for (let index = 3; index < pixels.length; index += 4) {
		covered += Math.max(0, Math.min(1, pixels[index] * scale)) >= alphaTestReference ? 1 : 0;
	}
	return covered / (pixels.length / 4);
}

/** Rescales HDR mip alpha toward the base cutout coverage without clipping color values. */
function preserveHighDynamicRangeAlphaCoverage(pixels: Float32Array, targetCoverage: number, alphaTestReference: number): { before: number; after: number; scale: number } {
	const before = highDynamicRangeAlphaCoverage(pixels, alphaTestReference);
	if (before === targetCoverage || targetCoverage === 0) {
		return { before, after: before, scale: 1 };
	}
	let lower = 0;
	let upper = 255;
	for (let iteration = 0; iteration < 24; iteration++) {
		const scale = (lower + upper) / 2;
		if (highDynamicRangeAlphaCoverage(pixels, alphaTestReference, scale) < targetCoverage) {
			lower = scale;
		} else {
			upper = scale;
		}
	}
	for (let index = 3; index < pixels.length; index += 4) {
		pixels[index] = Math.max(0, Math.min(1, pixels[index] * upper));
	}
	return { before, after: highDynamicRangeAlphaCoverage(pixels, alphaTestReference), scale: upper };
}

/** Resolves HDR height-map neighbors with the same per-axis wrap modes later applied by Babylon. */
function highDynamicRangeWrappedCoordinate(value: number, size: number, mode: ITextureImporterSettings["wrapModeU"]): number {
	if (mode === "clamp" || size === 1) {
		return Math.max(0, Math.min(size - 1, value));
	}
	if (mode === "repeat") {
		return ((value % size) + size) % size;
	}
	const period = size * 2;
	const repeated = ((value % period) + period) % period;
	return repeated < size ? repeated : period - repeated - 1;
}

/** Bleeds finite HDR edge colors through eight transparent texels without clamping color intensity. */
function dilateHighDynamicRangeTransparentColors(pixels: Float32Array, width: number, height: number): boolean {
	const resolvedPass = new Uint8Array(width * height);
	for (let pixel = 0; pixel < resolvedPass.length; pixel++) {
		resolvedPass[pixel] = pixels[pixel * 4 + 3] > 0 ? 1 : 0;
	}
	let changed = false;
	for (let pass = 2; pass <= 9; pass++) {
		let passChanged = false;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const pixel = y * width + x;
				if (resolvedPass[pixel]) {
					continue;
				}
				let red = 0;
				let green = 0;
				let blue = 0;
				let samples = 0;
				for (let offsetY = -1; offsetY <= 1; offsetY++) {
					for (let offsetX = -1; offsetX <= 1; offsetX++) {
						if ((!offsetX && !offsetY) || x + offsetX < 0 || x + offsetX >= width || y + offsetY < 0 || y + offsetY >= height) {
							continue;
						}
						const neighbor = (y + offsetY) * width + x + offsetX;
						if (!resolvedPass[neighbor] || resolvedPass[neighbor] >= pass) {
							continue;
						}
						const index = neighbor * 4;
						red += pixels[index];
						green += pixels[index + 1];
						blue += pixels[index + 2];
						samples++;
					}
				}
				if (samples) {
					const index = pixel * 4;
					pixels[index] = red / samples;
					pixels[index + 1] = green / samples;
					pixels[index + 2] = blue / samples;
					resolvedPass[pixel] = pass;
					passChanged = true;
					changed = true;
				}
			}
		}
		if (!passChanged) {
			break;
		}
	}
	return changed;
}

interface IPreparedHighDynamicRangeSource {
	image: IHighDynamicRangeImage;
	alphaRemoved: boolean;
	transparentColorsDilated: boolean;
	normalMapGenerated: boolean;
}

/** Executes float-preserving alpha, edge, and height-to-normal semantics before resize and encoding. */
function prepareHighDynamicRangeSource(source: IHighDynamicRangeImage, settings: ITextureImporterSettings): IPreparedHighDynamicRangeSource {
	const alphaRemoved = source.hasAlpha && settings.alphaSource === "none";
	const normalMapGenerated = settings.textureType === "normalMap" && settings.normalMapSource === "height";
	const needsPixels = alphaRemoved || settings.alphaSource === "grayscale" || settings.alphaIsTransparency || normalMapGenerated;
	if (!needsPixels) {
		return { image: source, alphaRemoved, transparentColorsDilated: false, normalMapGenerated };
	}
	const pixels = source.pixels.slice();
	// Sampling the untouched source prevents earlier normal writes from feeding later height gradients.
	const luminance = (x: number, y: number): number => {
		const resolvedX = highDynamicRangeWrappedCoordinate(x, source.width, settings.wrapModeU);
		const resolvedY = highDynamicRangeWrappedCoordinate(y, source.height, settings.wrapModeV);
		const index = (resolvedY * source.width + resolvedX) * 4;
		return source.pixels[index] * 0.2126 + source.pixels[index + 1] * 0.7152 + source.pixels[index + 2] * 0.0722;
	};
	if (normalMapGenerated) {
		for (let y = 0; y < source.height; y++) {
			for (let x = 0; x < source.width; x++) {
				const gradientX = (luminance(x + 1, y) - luminance(x - 1, y)) * settings.normalMapStrength * 2;
				const gradientY = (luminance(x, y + 1) - luminance(x, y - 1)) * settings.normalMapStrength * 2;
				const inverseLength = 1 / Math.hypot(gradientX, gradientY, 1);
				const index = (y * source.width + x) * 4;
				pixels[index] = -gradientX * inverseLength * 0.5 + 0.5;
				pixels[index + 1] = -gradientY * inverseLength * 0.5 + 0.5;
				pixels[index + 2] = inverseLength * 0.5 + 0.5;
			}
		}
	}
	for (let offset = 0; offset < pixels.length; offset += 4) {
		pixels[offset + 3] =
			settings.alphaSource === "none"
				? 1
				: settings.alphaSource === "grayscale"
					? Math.max(0, Math.min(1, source.pixels[offset] * 0.2126 + source.pixels[offset + 1] * 0.7152 + source.pixels[offset + 2] * 0.0722))
					: pixels[offset + 3];
	}
	const transparentColorsDilated =
		settings.alphaIsTransparency && settings.alphaSource !== "none" ? dilateHighDynamicRangeTransparentColors(pixels, source.width, source.height) : false;
	const hasAlpha = settings.alphaSource === "grayscale" || (settings.alphaSource === "input" && source.hasAlpha);
	return {
		image: {
			...source,
			channels: hasAlpha ? 4 : 3,
			hasAlpha,
			pixels,
			statistics: toStatistics(pixels),
		},
		alphaRemoved,
		transparentColorsDilated,
		normalMapGenerated,
	};
}

function floatToRgbe(red: number, green: number, blue: number, output: Uint8Array, offset: number): void {
	red = Number.isFinite(red) ? Math.max(0, red) : 0;
	green = Number.isFinite(green) ? Math.max(0, green) : 0;
	blue = Number.isFinite(blue) ? Math.max(0, blue) : 0;
	const maximum = Math.max(red, green, blue);
	if (maximum < 1e-32) {
		output.fill(0, offset, offset + 4);
		return;
	}
	const exponent = Math.max(-128, Math.min(127, Math.floor(Math.log2(maximum)) + 1));
	const scale = 256 / Math.pow(2, exponent);
	output[offset] = Math.max(0, Math.min(255, Math.floor(red * scale)));
	output[offset + 1] = Math.max(0, Math.min(255, Math.floor(green * scale)));
	output[offset + 2] = Math.max(0, Math.min(255, Math.floor(blue * scale)));
	output[offset + 3] = exponent + 128;
}

function encodeHdrChannel(values: Uint8Array): number[] {
	const output: number[] = [];
	let offset = 0;
	while (offset < values.length) {
		let run = 1;
		while (offset + run < values.length && run < 127 && values[offset + run] === values[offset]) {
			run++;
		}
		if (run >= 4) {
			output.push(128 + run, values[offset]);
			offset += run;
			continue;
		}
		const literalStart = offset;
		offset += run;
		while (offset < values.length && offset - literalStart < 128) {
			run = 1;
			while (offset + run < values.length && run < 127 && values[offset + run] === values[offset]) {
				run++;
			}
			if (run >= 4) {
				break;
			}
			offset += run;
		}
		const count = offset - literalStart;
		output.push(count, ...values.subarray(literalStart, literalStart + count));
	}
	return output;
}

/** Encodes deterministic top-left-origin Radiance RGBE bytes, optionally using per-channel scanline RLE. */
export function encodeRadianceHdr(image: IHighDynamicRangeImage, useRle = true): Uint8Array {
	assertDimensions(image.width, image.height);
	const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${image.height} +X ${image.width}\n`);
	const pixels = new Uint8Array(image.width * image.height * 4);
	for (let index = 0; index < image.width * image.height; index++) {
		floatToRgbe(image.pixels[index * 4], image.pixels[index * 4 + 1], image.pixels[index * 4 + 2], pixels, index * 4);
	}
	if (!useRle || image.width < 8 || image.width > 0x7fff) {
		const output = new Uint8Array(header.length + pixels.length);
		output.set(header);
		output.set(pixels, header.length);
		return output;
	}
	const body: number[] = [];
	for (let y = 0; y < image.height; y++) {
		body.push(2, 2, image.width >> 8, image.width & 0xff);
		for (let channel = 0; channel < 4; channel++) {
			const values = new Uint8Array(image.width);
			for (let x = 0; x < image.width; x++) {
				values[x] = pixels[(y * image.width + x) * 4 + channel];
			}
			body.push(...encodeHdrChannel(values));
		}
	}
	const output = new Uint8Array(header.length + body.length);
	output.set(header);
	output.set(body, header.length);
	return output;
}

function encodeExrAttribute(name: string, type: string, value: Uint8Array): Uint8Array {
	const encoder = new TextEncoder();
	const nameBytes = encoder.encode(name);
	const typeBytes = encoder.encode(type);
	const output = new Uint8Array(nameBytes.length + typeBytes.length + value.length + 6);
	let offset = 0;
	output.set(nameBytes, offset);
	offset += nameBytes.length;
	output[offset++] = 0;
	output.set(typeBytes, offset);
	offset += typeBytes.length;
	output[offset++] = 0;
	new DataView(output.buffer).setUint32(offset, value.length, true);
	offset += 4;
	output.set(value, offset);
	return output;
}

function concatenate(parts: Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

/** Encodes a deterministic single-part, uncompressed FLOAT RGBA OpenEXR scanline image. */
export function encodeOpenExr(image: IHighDynamicRangeImage): Uint8Array {
	assertDimensions(image.width, image.height);
	const channelParts: Uint8Array[] = [];
	for (const name of ["B", "G", "R", "A"]) {
		const channel = new Uint8Array(18);
		channel[0] = name.charCodeAt(0);
		new DataView(channel.buffer).setInt32(2, 2, true);
		new DataView(channel.buffer).setInt32(10, 1, true);
		new DataView(channel.buffer).setInt32(14, 1, true);
		channelParts.push(channel);
	}
	channelParts.push(new Uint8Array([0]));
	const box = new Uint8Array(16);
	const boxView = new DataView(box.buffer);
	boxView.setInt32(8, image.width - 1, true);
	boxView.setInt32(12, image.height - 1, true);
	const oneFloat = new Uint8Array(4);
	new DataView(oneFloat.buffer).setFloat32(0, 1, true);
	const header = concatenate([
		encodeExrAttribute("channels", "chlist", concatenate(channelParts)),
		encodeExrAttribute("compression", "compression", new Uint8Array([0])),
		encodeExrAttribute("dataWindow", "box2i", box),
		encodeExrAttribute("displayWindow", "box2i", box),
		encodeExrAttribute("lineOrder", "lineOrder", new Uint8Array([0])),
		encodeExrAttribute("pixelAspectRatio", "float", oneFloat),
		encodeExrAttribute("screenWindowCenter", "v2f", new Uint8Array(8)),
		encodeExrAttribute("screenWindowWidth", "float", oneFloat),
		new Uint8Array([0]),
	]);
	const prefixLength = 8 + header.length + image.height * 8;
	const scanlineLength = 8 + image.width * 4 * 4;
	const output = new Uint8Array(prefixLength + image.height * scanlineLength);
	const view = new DataView(output.buffer);
	view.setUint32(0, exrMagic, true);
	view.setUint32(4, 2, true);
	output.set(header, 8);
	let tableOffset = 8 + header.length;
	let chunkOffset = prefixLength;
	for (let y = 0; y < image.height; y++) {
		view.setUint32(tableOffset, chunkOffset >>> 0, true);
		view.setUint32(tableOffset + 4, Math.floor(chunkOffset / 0x1_0000_0000), true);
		tableOffset += 8;
		view.setInt32(chunkOffset, y, true);
		view.setUint32(chunkOffset + 4, image.width * 16, true);
		let pixelOffset = chunkOffset + 8;
		const sourceY = image.height - y - 1;
		for (const channel of [2, 1, 0, 3]) {
			for (let x = 0; x < image.width; x++) {
				const value = image.pixels[(sourceY * image.width + x) * 4 + channel];
				view.setFloat32(pixelOffset, Number.isFinite(value) ? value : 0, true);
				pixelOffset += 4;
			}
		}
		chunkOffset += scanlineLength;
	}
	return output;
}

/** Encodes a high-dynamic image back to its requested portable runtime format. */
export function encodeHighDynamicRange(image: IHighDynamicRangeImage, format: HighDynamicRangeFormat, useRle = true): Uint8Array {
	return format === "hdr" ? encodeRadianceHdr(image, useRle) : encodeOpenExr(image);
}

function samplePanorama(pixels: Float32Array, width: number, height: number, direction: [number, number, number], output: Float32Array, outputOffset: number): void {
	const length = Math.hypot(direction[0], direction[1], direction[2]);
	const xDirection = direction[0] / length;
	const yDirection = direction[1] / length;
	const zDirection = direction[2] / length;
	const u = Math.atan2(zDirection, xDirection) / (Math.PI * 2) + 0.5;
	const v = Math.acos(Math.max(-1, Math.min(1, yDirection))) / Math.PI;
	const sourceX = u * width - 0.5;
	const sourceY = v * height - 0.5;
	const x0 = ((Math.floor(sourceX) % width) + width) % width;
	const x1 = (x0 + 1) % width;
	const y0 = Math.max(0, Math.min(height - 1, Math.floor(sourceY)));
	const y1 = Math.max(0, Math.min(height - 1, y0 + 1));
	const tx = sourceX - Math.floor(sourceX);
	const ty = sourceY - Math.floor(sourceY);
	for (let channel = 0; channel < 4; channel++) {
		const top = pixels[(y0 * width + x0) * 4 + channel] * (1 - tx) + pixels[(y0 * width + x1) * 4 + channel] * tx;
		const bottom = pixels[(y1 * width + x0) * 4 + channel] * (1 - tx) + pixels[(y1 * width + x1) * 4 + channel] * tx;
		output[outputOffset + channel] = top * (1 - ty) + bottom * ty;
	}
}

/** Returns whether dimensions match a conventional 2:1 equirectangular panorama within one percent. */
export function isEquirectangularPanorama(width: number, height: number): boolean {
	return Math.abs(width / height - 2) <= 0.02;
}

/** Chooses a bounded power-of-two cube face size from a 2:1 panorama. */
export function defaultCubeFaceSize(width: number, height: number): number {
	const maximum = Math.max(16, Math.min(512, Math.floor(Math.min(width / 4, height / 2))));
	return Math.pow(2, Math.floor(Math.log2(maximum)));
}

/** Converts a linear equirectangular panorama into six bilinearly sampled cube faces. */
export function convertHighDynamicRangePanoramaToCubeFaces(image: IHighDynamicRangeImage, size = defaultCubeFaceSize(image.width, image.height)): IHighDynamicRangeCubeFace[] {
	if (!isEquirectangularPanorama(image.width, image.height)) {
		throw new Error("Cubemap conversion requires a 2:1 equirectangular HDR/EXR panorama.");
	}
	if (!Number.isInteger(size) || size < 16 || size > 2048 || (size & (size - 1)) !== 0) {
		throw new Error("Cubemap face size must be a power of two from 16 through 2048.");
	}
	const mappings: Array<{ face: IHighDynamicRangeCubeFace["face"]; direction: (u: number, v: number) => [number, number, number] }> = [
		{ face: "px", direction: (u, v) => [1, -v, -u] },
		{ face: "nx", direction: (u, v) => [-1, -v, u] },
		{ face: "py", direction: (u, v) => [u, 1, v] },
		{ face: "ny", direction: (u, v) => [u, -1, -v] },
		{ face: "pz", direction: (u, v) => [u, -v, 1] },
		{ face: "nz", direction: (u, v) => [-u, -v, -1] },
	];
	return mappings.map(({ face, direction }) => {
		const pixels = new Float32Array(size * size * 4);
		for (let y = 0; y < size; y++) {
			const v = ((y + 0.5) / size) * 2 - 1;
			for (let x = 0; x < size; x++) {
				const u = ((x + 0.5) / size) * 2 - 1;
				samplePanorama(image.pixels, image.width, image.height, direction(u, v), pixels, (y * size + x) * 4);
			}
		}
		return { face, width: size, height: size, pixels };
	});
}

function linearToSrgb(value: number): number {
	return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

/** Tone-maps linear RGBA32F pixels through a fixed ACES fitted curve into preview-only RGBA8 pixels. */
export function toneMapHighDynamicRange(pixels: Float32Array, exposure = 0): Uint8Array {
	const output = new Uint8Array(pixels.length);
	const multiplier = Math.pow(2, exposure);
	for (let offset = 0; offset < pixels.length; offset += 4) {
		for (let channel = 0; channel < 3; channel++) {
			const input = Number.isFinite(pixels[offset + channel]) ? Math.max(0, pixels[offset + channel] * multiplier) : 0;
			const aces = Math.max(0, Math.min(1, (input * (2.51 * input + 0.03)) / (input * (2.43 * input + 0.59) + 0.14)));
			output[offset + channel] = Math.round(Math.max(0, Math.min(1, linearToSrgb(aces))) * 255);
		}
		const alpha = Number.isFinite(pixels[offset + 3]) ? pixels[offset + 3] : 1;
		output[offset + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
	}
	return output;
}

/** Executes the format-preserving, linear-float portion of HDR/EXR texture importing for editor and CLI consumers. */
export async function executeHighDynamicRangeTextureImport(
	bytes: Uint8Array,
	format: HighDynamicRangeFormat,
	settings: ITextureImporterSettings
): Promise<IExecutedHighDynamicRangeTextureImport> {
	const source = await decodeHighDynamicRange(bytes, format);
	const preparedSource = prepareHighDynamicRangeSource(source, settings);
	const prepared = preparedSource.image;
	const dimensions = textureImporterOutputDimensions(prepared.width, prepared.height, settings);
	const output = resizeHighDynamicRangeExact(prepared, dimensions.width, dimensions.height, settings.resizeAlgorithm);
	const resized = output.width !== source.width || output.height !== source.height;
	const useRle = settings.compression !== "none";
	const outputBytes = encodeHighDynamicRange(output, format, useRle);
	const baseCoverage = settings.mipmapPreserveCoverage && settings.alphaSource !== "none" ? highDynamicRangeAlphaCoverage(output.pixels, settings.mipmapAlphaTestReference) : 0;
	const mipmaps = settings.generateMipmaps
		? textureImporterMipmapDimensions(output.width, output.height).map((size) => {
				const image = resizeHighDynamicRangeExact(output, size.width, size.height, settings.mipmapFilter === "box" ? "bilinear" : "lanczos3");
				let coverage: ReturnType<typeof preserveHighDynamicRangeAlphaCoverage> | null = null;
				if (settings.mipmapPreserveCoverage && settings.alphaSource !== "none") {
					coverage = preserveHighDynamicRangeAlphaCoverage(image.pixels, baseCoverage, settings.mipmapAlphaTestReference);
					image.statistics = toStatistics(image.pixels);
				}
				return {
					image,
					bytes: encodeHighDynamicRange(image, format, useRle),
					...(coverage ? { alphaCoverageBefore: coverage.before, alphaCoverageAfter: coverage.after, alphaCoverageScale: coverage.scale } : {}),
				};
			})
		: [];
	const equirectangular = isEquirectangularPanorama(output.width, output.height);
	const cubeFaceSize = equirectangular ? defaultCubeFaceSize(output.width, output.height) : null;
	const cubeFaces = equirectangular ? convertHighDynamicRangePanoramaToCubeFaces(output, cubeFaceSize!) : [];
	const environmentBytes = equirectangular ? encodeRadianceHdr(output, useRle) : null;
	return {
		source,
		output,
		outputBytes,
		resized,
		alphaRemoved: preparedSource.alphaRemoved,
		transparentColorsDilated: preparedSource.transparentColorsDilated,
		normalMapGenerated: preparedSource.normalMapGenerated,
		equirectangular,
		cubeFaceSize,
		cubeFaces,
		environmentBytes,
		mipmaps,
	};
}
