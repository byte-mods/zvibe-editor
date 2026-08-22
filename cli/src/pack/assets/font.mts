import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path/posix";

import fs from "fs-extra";
import sharp from "sharp";
import {
	getFontImporterCodepoints,
	IFontAtlasCharacter,
	IFontAtlasKerning,
	IFontAtlasManifest,
	IFontAtlasPage,
	IFontImporterSettings,
	IFontImportResult,
	validateFontImporterSource,
} from "babylonjs-editor-tools";

const require = createRequire(import.meta.filename);
const { Msdfgen } = require("msdfgen-wasm") as typeof import("msdfgen-wasm");

function fontFamily(path: string): string {
	return basename(path, extname(path)).replace(/[^a-zA-Z0-9_-]+/g, "-") || "ImportedFont";
}

async function convertMsdfPage(png: Uint8Array, renderMode: IFontImporterSettings["renderMode"], distanceRange: number): Promise<Buffer> {
	if (renderMode === "msdf") {
		return Buffer.from(png);
	}
	const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const output = Buffer.alloc(info.width * info.height * 4);
	for (let offset = 0; offset < data.length; offset += 4) {
		const channels = [data[offset], data[offset + 1], data[offset + 2]].sort((left, right) => left - right);
		const distance = channels[1];
		if (renderMode === "sdf") {
			output[offset] = distance;
			output[offset + 1] = distance;
			output[offset + 2] = distance;
			output[offset + 3] = data[offset + 3];
		} else {
			const transition = Math.max(1, 128 / Math.max(1, distanceRange));
			const alpha = Math.max(0, Math.min(255, Math.round(((distance - 128) / transition + 0.5) * 255)));
			output[offset] = 255;
			output[offset + 1] = 255;
			output[offset + 2] = 255;
			output[offset + 3] = Math.min(alpha, data[offset + 3]);
		}
	}
	return sharp(output, { raw: { width: info.width, height: info.height, channels: 4 } })
		.png()
		.toBuffer();
}

/** Generates a dynamic or bitmap/SDF/MSDF font artifact set for CLI packing. */
export async function processExportedFont(sourcePath: string, requestedOutputPath: string, settings: IFontImporterSettings): Promise<IFontImportResult> {
	validateFontImporterSource(sourcePath, settings);
	const sourceDetails = await fs.stat(sourcePath);
	const outputDirectory = dirname(requestedOutputPath);
	const base = basename(requestedOutputPath, extname(requestedOutputPath));
	const manifestPath = join(outputDirectory, `${base}.font.json`);
	const family = fontFamily(sourcePath);
	await fs.ensureDir(outputDirectory);
	if (settings.renderMode === "dynamic") {
		await fs.copyFile(sourcePath, requestedOutputPath);
		const manifest: IFontAtlasManifest = {
			version: 1,
			renderMode: "dynamic",
			family,
			fontSize: settings.fontSize,
			padding: settings.padding,
			distanceRange: settings.distanceRange,
			lineHeight: settings.fontSize,
			base: settings.fontSize,
			ascender: settings.fontSize,
			descender: 0,
			pages: [],
			characters: [],
			kernings: [],
			missingCodepoints: [],
			dynamicFontPath: basename(requestedOutputPath),
			sourceFontPath: basename(requestedOutputPath),
		};
		await fs.writeJSON(manifestPath, manifest, { spaces: "\t" });
		return {
			sourcePath,
			outputDirectory,
			manifestPath,
			renderMode: "dynamic",
			settings,
			family,
			sourceBytes: sourceDetails.size,
			glyphCount: 0,
			missingCodepoints: [],
			pages: [],
			dynamicFontPath: requestedOutputPath,
			sourceFontPath: requestedOutputPath,
		};
	}
	await fs.copyFile(sourcePath, requestedOutputPath);
	const wasm = await fs.readFile(require.resolve("msdfgen-wasm/wasm"));
	const generator = await Msdfgen.create(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer);
	generator.loadFont(await fs.readFile(sourcePath));
	const requestedCodepoints = getFontImporterCodepoints(settings);
	generator.loadGlyphs(requestedCodepoints, { preprocess: true });
	const present = new Set(generator.glyphs.map((glyph) => glyph.unicode));
	const missingCodepoints = requestedCodepoints.filter((codepoint) => !present.has(codepoint));
	const msdfOptions = { size: settings.fontSize, range: settings.distanceRange, edgeColoring: "inktrap" as const, edgeThresholdAngle: 3, scanline: false };
	const bins = generator.packGlyphs(msdfOptions, {
		maxWidth: 2048,
		maxHeight: 2048,
		padding: settings.padding,
		pot: true,
		smart: true,
		allowRotation: false,
	});
	const round = (value: number): number => Math.round(value * settings.fontSize * 100) / 100;
	const characters: IFontAtlasCharacter[] = [];
	const kernings: IFontAtlasKerning[] = [];
	const pages: IFontAtlasPage[] = [];
	for (let page = 0; page < bins.length; page++) {
		const bin = bins[page];
		const pageName = `${base}.font-${page}.png`;
		const pagePath = join(outputDirectory, pageName);
		const image = await convertMsdfPage(generator.createAtlasImage(bin), settings.renderMode, settings.distanceRange);
		await fs.writeFile(pagePath, image);
		pages.push({ path: pagePath, width: bin.width, height: bin.height, bytes: image.length });
		for (const rectangle of bin.rects) {
			const glyph = rectangle.glyph;
			const range = rectangle.msdfData.range;
			const hasSize = rectangle.width > 0 && rectangle.height > 0;
			characters.push({
				id: glyph.unicode,
				char: String.fromCodePoint(glyph.unicode),
				page,
				x: rectangle.x,
				y: rectangle.y,
				width: rectangle.width,
				height: rectangle.height,
				xAdvance: round(glyph.advance),
				xOffset: hasSize ? round(glyph.left - range / 2) : 0,
				yOffset: hasSize ? round(generator.metrics.ascenderY - (glyph.top + range / 2)) : 0,
				rotated: rectangle.rot || undefined,
			});
			for (const [second, amount] of glyph.kerning) {
				kernings.push({ first: glyph.unicode, second: second.unicode, amount: round(amount) });
			}
		}
	}
	const manifest: IFontAtlasManifest = {
		version: 1,
		renderMode: settings.renderMode,
		family,
		fontSize: settings.fontSize,
		padding: settings.padding,
		distanceRange: settings.distanceRange,
		lineHeight: round(generator.metrics.lineHeight),
		base: round(generator.metrics.ascenderY),
		ascender: round(generator.metrics.ascenderY),
		descender: round(generator.metrics.descenderY),
		pages: pages.map((page) => basename(page.path)),
		characters: characters.sort((left, right) => left.id - right.id),
		kernings,
		missingCodepoints,
		dynamicFontPath: null,
		sourceFontPath: basename(requestedOutputPath),
	};
	await fs.writeJSON(manifestPath, manifest, { spaces: "\t" });
	return {
		sourcePath,
		outputDirectory,
		manifestPath,
		renderMode: settings.renderMode,
		settings,
		family,
		sourceBytes: sourceDetails.size,
		glyphCount: characters.length,
		missingCodepoints,
		pages,
		dynamicFontPath: null,
		sourceFontPath: requestedOutputPath,
	};
}
