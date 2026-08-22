import type { ITextureImporterSettings, ITextureImportSpriteMetadata, TextureImporterWrapMode } from "./texture-importer";

export interface ITextureImporterDimensions {
	width: number;
	height: number;
}

export interface ITextureImporterPixelTransformResult {
	pixels: Uint8Array;
	alphaDerivedFromGrayscale: boolean;
	alphaRemoved: boolean;
	transparentColorsDilated: boolean;
	normalMapGenerated: boolean;
}

export interface ITextureImporterAlphaCoverageResult {
	before: number;
	after: number;
	scale: number;
	adjusted: boolean;
}

const maximumPixelTransformPixels = 16_777_216;

/** Rejects invalid dimensions before multiplication can overflow or allocate an unbounded pixel buffer. */
function validateDimensions(width: number, height: number): number {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new Error("Texture dimensions must be positive integers.");
	}
	const pixels = width * height;
	if (!Number.isSafeInteger(pixels)) {
		throw new Error("Texture dimensions exceed the safe pixel-count range.");
	}
	return pixels;
}

/** Finds the previous power-of-two dimension without using 32-bit bitwise truncation. */
function lowerPowerOfTwo(value: number): number {
	return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

/** Applies one Unity-style NPOT policy independently to a post-Max-Size dimension. */
function powerOfTwoDimension(value: number, policy: ITextureImporterSettings["nonPowerOfTwo"]): number {
	if (policy === "none" || (value & (value - 1)) === 0) {
		return value;
	}
	const lower = lowerPowerOfTwo(value);
	const upper = lower * 2;
	if (policy === "toSmaller") {
		return lower;
	}
	if (policy === "toLarger") {
		return upper;
	}
	return value - lower <= upper - value ? lower : upper;
}

/** Resolves aspect-preserving Max Size followed by the authored NPOT conversion policy. */
export function textureImporterOutputDimensions(width: number, height: number, settings: Pick<ITextureImporterSettings, "maxSize" | "nonPowerOfTwo">): ITextureImporterDimensions {
	validateDimensions(width, height);
	const scale = Math.min(1, settings.maxSize / Math.max(width, height));
	const limitedWidth = Math.max(1, Math.round(width * scale));
	const limitedHeight = Math.max(1, Math.round(height * scale));
	return {
		width: powerOfTwoDimension(limitedWidth, settings.nonPowerOfTwo),
		height: powerOfTwoDimension(limitedHeight, settings.nonPowerOfTwo),
	};
}

/** Produces the complete GPU mip chain after the base level, ending exactly at 1x1. */
export function textureImporterMipmapDimensions(width: number, height: number): ITextureImporterDimensions[] {
	validateDimensions(width, height);
	const result: ITextureImporterDimensions[] = [];
	while (width > 1 || height > 1) {
		width = Math.max(1, Math.floor(width / 2));
		height = Math.max(1, Math.floor(height / 2));
		result.push({ width, height });
	}
	return result;
}

/** Resolves height-map neighborhood coordinates using the same per-axis wrap contract persisted for runtime sampling. */
function wrappedCoordinate(value: number, size: number, mode: TextureImporterWrapMode): number {
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

/** Uses a stable Rec.709 luminance projection for grayscale alpha and height-map conversion. */
function luminance(pixels: Uint8Array, index: number): number {
	return (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) / 255;
}

/** Converts one bounded grayscale height field into tangent-space RGB normals without retaining a second full image. */
function convertHeightToNormalMap(source: Uint8Array, output: Uint8Array, width: number, height: number, settings: ITextureImporterSettings): void {
	const sample = (x: number, y: number): number => {
		const resolvedX = wrappedCoordinate(x, width, settings.wrapModeU);
		const resolvedY = wrappedCoordinate(y, height, settings.wrapModeV);
		return luminance(source, (resolvedY * width + resolvedX) * 4);
	};
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const gradientX = (sample(x + 1, y) - sample(x - 1, y)) * settings.normalMapStrength * 2;
			const gradientY = (sample(x, y + 1) - sample(x, y - 1)) * settings.normalMapStrength * 2;
			const inverseLength = 1 / Math.hypot(gradientX, gradientY, 1);
			const index = (y * width + x) * 4;
			output[index] = Math.round((-gradientX * inverseLength * 0.5 + 0.5) * 255);
			output[index + 1] = Math.round((-gradientY * inverseLength * 0.5 + 0.5) * 255);
			output[index + 2] = Math.round((inverseLength * 0.5 + 0.5) * 255);
		}
	}
}

/** Bleeds the nearest resolved edge color through eight transparent texels so filtered sprite/mip edges do not acquire a dark matte. */
function dilateTransparentColors(pixels: Uint8Array, width: number, height: number): boolean {
	const count = width * height;
	const resolvedPass = new Uint8Array(count);
	for (let pixel = 0; pixel < count; pixel++) {
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
					pixels[index] = Math.round(red / samples);
					pixels[index + 1] = Math.round(green / samples);
					pixels[index + 2] = Math.round(blue / samples);
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

/** Executes every color/alpha semantic that requires deterministic RGBA8 pixel access in both editor and CLI builds. */
export function transformTextureImporterPixels(pixels: Uint8Array, width: number, height: number, settings: ITextureImporterSettings): ITextureImporterPixelTransformResult {
	const pixelCount = validateDimensions(width, height);
	if (pixels.byteLength !== pixelCount * 4) {
		throw new Error(`Texture RGBA8 payload must contain exactly ${pixelCount * 4} bytes.`);
	}
	if (pixelCount > maximumPixelTransformPixels) {
		throw new Error("Texture pixel transforms are limited to 16,777,216 pixels; lower Max Size or disable grayscale alpha, height-to-normal, and Alpha Is Transparency.");
	}
	const output = pixels.slice();
	const normalMapGenerated = settings.textureType === "normalMap" && settings.normalMapSource === "height";
	if (normalMapGenerated) {
		convertHeightToNormalMap(pixels, output, width, height, settings);
	}
	if (settings.alphaSource === "grayscale") {
		for (let pixel = 0; pixel < pixelCount; pixel++) {
			const index = pixel * 4;
			output[index + 3] = Math.round(luminance(pixels, index) * 255);
		}
	} else if (settings.alphaSource === "none") {
		for (let index = 3; index < output.byteLength; index += 4) {
			output[index] = 255;
		}
	}
	const transparentColorsDilated = settings.alphaIsTransparency && settings.alphaSource !== "none" ? dilateTransparentColors(output, width, height) : false;
	return {
		pixels: output,
		alphaDerivedFromGrayscale: settings.alphaSource === "grayscale",
		alphaRemoved: settings.alphaSource === "none",
		transparentColorsDilated,
		normalMapGenerated,
	};
}

/** Measures binary alpha-test coverage using the importer-authored threshold. */
export function textureImporterAlphaCoverage(pixels: Uint8Array, alphaTestReference: number): number {
	if (pixels.byteLength % 4 !== 0 || !Number.isFinite(alphaTestReference) || alphaTestReference < 0 || alphaTestReference > 1) {
		throw new Error("Texture alpha coverage requires RGBA8 pixels and an alpha reference from 0 through 1.");
	}
	if (!pixels.byteLength) {
		return 0;
	}
	let covered = 0;
	for (let index = 3; index < pixels.byteLength; index += 4) {
		covered += pixels[index] / 255 >= alphaTestReference ? 1 : 0;
	}
	return covered / (pixels.byteLength / 4);
}

/** Rescales one mip's alpha channel toward base-level alpha-test coverage while preserving every RGB channel. */
export function preserveTextureImporterAlphaCoverage(pixels: Uint8Array, targetCoverage: number, alphaTestReference: number): ITextureImporterAlphaCoverageResult {
	if (!Number.isFinite(targetCoverage) || targetCoverage < 0 || targetCoverage > 1) {
		throw new Error("Texture target alpha coverage must be from 0 through 1.");
	}
	const before = textureImporterAlphaCoverage(pixels, alphaTestReference);
	if (before === targetCoverage || targetCoverage === 0 || !pixels.some((value, index) => index % 4 === 3 && value > 0)) {
		return { before, after: before, scale: 1, adjusted: false };
	}
	let lower = 0;
	let upper = 255;
	for (let iteration = 0; iteration < 24; iteration++) {
		const scale = (lower + upper) / 2;
		let covered = 0;
		for (let index = 3; index < pixels.byteLength; index += 4) {
			covered += Math.min(255, pixels[index] * scale) / 255 >= alphaTestReference ? 1 : 0;
		}
		if (covered / (pixels.byteLength / 4) < targetCoverage) {
			lower = scale;
		} else {
			upper = scale;
		}
	}
	for (let index = 3; index < pixels.byteLength; index += 4) {
		pixels[index] = Math.min(255, Math.round(pixels[index] * upper));
	}
	const after = textureImporterAlphaCoverage(pixels, alphaTestReference);
	return { before, after, scale: upper, adjusted: upper !== 1 && after !== before };
}

/** Derives one format-independent full-rect or tight alpha bound for LDR and HDR sprite imports. */
export function textureImporterSpriteMetadata(
	pixels: ArrayLike<number>,
	width: number,
	height: number,
	settings: Pick<ITextureImporterSettings, "textureType" | "spritePixelsPerUnit" | "spriteMeshType" | "spriteExtrude">
): ITextureImportSpriteMetadata | null {
	const pixelCount = validateDimensions(width, height);
	if (pixels.length !== pixelCount * 4) {
		throw new Error("Texture sprite bounds require one RGBA pixel per output texel.");
	}
	if (settings.textureType !== "sprite") {
		return null;
	}
	let bounds = { x: 0, y: 0, width, height };
	if (settings.spriteMeshType === "tight") {
		let minimumX = width;
		let minimumY = height;
		let maximumX = -1;
		let maximumY = -1;
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (pixels[(y * width + x) * 4 + 3] > 0) {
					minimumX = Math.min(minimumX, x);
					minimumY = Math.min(minimumY, y);
					maximumX = Math.max(maximumX, x);
					maximumY = Math.max(maximumY, y);
				}
			}
		}
		if (maximumX >= minimumX && maximumY >= minimumY) {
			minimumX = Math.max(0, minimumX - settings.spriteExtrude);
			minimumY = Math.max(0, minimumY - settings.spriteExtrude);
			maximumX = Math.min(width - 1, maximumX + settings.spriteExtrude);
			maximumY = Math.min(height - 1, maximumY + settings.spriteExtrude);
			bounds = { x: minimumX, y: minimumY, width: maximumX - minimumX + 1, height: maximumY - minimumY + 1 };
		} else {
			bounds = { x: 0, y: 0, width: 0, height: 0 };
		}
	}
	return { pixelsPerUnit: settings.spritePixelsPerUnit, meshType: settings.spriteMeshType, extrude: settings.spriteExtrude, bounds };
}
