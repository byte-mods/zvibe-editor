import { IFontAtlasCharacter, IFontAtlasManifest } from "../assets/font-importer";
import { ILoadedImportedFont } from "./fonts";

export const guiAtlasTextModel = "unity-atlas-rich-text-v1" as const;
export const guiAtlasTextRuntimeMetadataKey = "zvibeGUIAtlasTextRuntime" as const;

export type GUIAtlasTextHorizontalAlignment = "left" | "center" | "right";
export type GUIAtlasTextVerticalAlignment = "top" | "center" | "bottom";
export type GUIAtlasTextWrapMode = "none" | "word" | "character";
export type GUIAtlasTextOverflowMode = "overflow" | "clip" | "ellipsis";

export interface IGUIAtlasTextAssignment {
	model: typeof guiAtlasTextModel;
	controlId: string;
	fontAssetPaths: string[];
	text: string;
	width: number;
	height: number;
	fontSize: number;
	color: string;
	outlineColor: string;
	outlineWidth: number;
	characterSpacing: number;
	lineSpacing: number;
	horizontalAlignment: GUIAtlasTextHorizontalAlignment;
	verticalAlignment: GUIAtlasTextVerticalAlignment;
	wrapMode: GUIAtlasTextWrapMode;
	overflowMode: GUIAtlasTextOverflowMode;
	richText: boolean;
	populateMissingGlyphs: boolean;
	maxRuntimeGlyphs: number;
}

export interface IGUIAtlasTextStyle {
	fontSize: number;
	color: string;
	bold: boolean;
	italic: boolean;
	underline: boolean;
	strikethrough: boolean;
}

export interface IGUIAtlasRichTextToken {
	character: string;
	style: IGUIAtlasTextStyle;
	newline: boolean;
}

export interface IGUIAtlasGlyphPlacement {
	character: string;
	renderCharacter: string;
	codepoint: number;
	assetIndex: number;
	glyph: IFontAtlasCharacter | null;
	dynamic: boolean;
	style: IGUIAtlasTextStyle;
	x: number;
	y: number;
	width: number;
	height: number;
	advance: number;
	lineIndex: number;
	scale: number;
}

export interface IGUIAtlasTextLineLayout {
	index: number;
	x: number;
	y: number;
	width: number;
	height: number;
	glyphCount: number;
}

export interface IGUIAtlasTextLayoutEvidence {
	model: typeof guiAtlasTextModel;
	width: number;
	height: number;
	lineCount: number;
	glyphCount: number;
	atlasGlyphCount: number;
	runtimeGlyphCount: number;
	missingCodepoints: number[];
	populatedCodepoints: number[];
	fallbackUseCount: number;
	richTagCount: number;
	truncated: boolean;
	clippedGlyphCount: number;
	renderModes: Record<"dynamic" | "bitmap" | "sdf" | "msdf", number>;
}

export interface IGUIAtlasTextLayoutResult {
	assignment: IGUIAtlasTextAssignment;
	placements: IGUIAtlasGlyphPlacement[];
	lines: IGUIAtlasTextLineLayout[];
	evidence: IGUIAtlasTextLayoutEvidence;
}

export interface IGUIAtlasPagePixels {
	width: number;
	height: number;
	pixels: Uint8ClampedArray;
}

export interface IGUIAtlasTextRenderResult {
	canvas: HTMLCanvasElement;
	layout: IGUIAtlasTextLayoutResult;
}

interface IPreparedGlyph {
	character: string;
	renderCharacter: string;
	codepoint: number;
	assetIndex: number;
	glyph: IFontAtlasCharacter | null;
	dynamic: boolean;
	style: IGUIAtlasTextStyle;
	advance: number;
	width: number;
	height: number;
	xOffset: number;
	yOffset: number;
	scale: number;
	newline: boolean;
	whitespace: boolean;
	missing: boolean;
}

interface IWorkingLine {
	glyphs: Array<{ prepared: IPreparedGlyph; localX: number }>;
	width: number;
	height: number;
}

interface IGUIAtlasRenderedGlyphCacheEntry {
	key: string;
	canvas: HTMLCanvasElement;
}

const maximumRichTextDepth = 32;
const maximumRichTextTags = 4096;
const maximumTextPixels = 8_388_608;
const maximumPageCacheEntries = 64;
const maximumGlyphCacheEntries = 1024;
const pageCache = new Map<string, Promise<IGUIAtlasPagePixels>>();
const renderedGlyphCache: IGUIAtlasRenderedGlyphCacheEntry[] = [];

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function assertFiniteRange(value: number, minimum: number, maximum: number, label: string): void {
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
	}
}

function assertAssetPath(value: string): void {
	if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === "" || part === "..")) {
		throw new Error(`GUI atlas font path "${value}" must be normalized, project-relative, and free of traversal.`);
	}
}

function normalizeHexColor(value: string, label: string): string {
	const match = value.trim().match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i);
	if (!match) {
		throw new Error(`${label} must be #RGB, #RGBA, #RRGGBB, or #RRGGBBAA.`);
	}
	let hex = match[1].toLowerCase();
	if (hex.length === 3 || hex.length === 4) {
		hex = Array.from(hex, (part) => `${part}${part}`).join("");
	}
	return `#${hex.length === 6 ? `${hex}ff` : hex}`;
}

function colorChannels(value: string): [number, number, number, number] {
	const normalized = normalizeHexColor(value, "GUI atlas text color").slice(1);
	return [
		Number.parseInt(normalized.slice(0, 2), 16),
		Number.parseInt(normalized.slice(2, 4), 16),
		Number.parseInt(normalized.slice(4, 6), 16),
		Number.parseInt(normalized.slice(6, 8), 16),
	];
}

/** Returns the canonical editable settings for one atlas-backed GUI image control. */
export function createDefaultGUIAtlasTextAssignment(controlId: string, fontAssetPaths: string[] = []): IGUIAtlasTextAssignment {
	return {
		model: guiAtlasTextModel,
		controlId,
		fontAssetPaths,
		text: "Atlas Text",
		width: 512,
		height: 128,
		fontSize: 48,
		color: "#ffffffff",
		outlineColor: "#000000ff",
		outlineWidth: 0,
		characterSpacing: 0,
		lineSpacing: 1,
		horizontalAlignment: "left",
		verticalAlignment: "top",
		wrapMode: "word",
		overflowMode: "clip",
		richText: true,
		populateMissingGlyphs: true,
		maxRuntimeGlyphs: 256,
	};
}

/** Validates and clones an atlas-rich-text assignment before it is persisted or rendered. */
export function normalizeGUIAtlasTextAssignment(value: unknown): IGUIAtlasTextAssignment {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("GUI atlas text assignment must be an object.");
	}
	const candidate = clone(value) as IGUIAtlasTextAssignment;
	if (candidate.model !== guiAtlasTextModel) {
		throw new Error(`GUI atlas text model must be "${guiAtlasTextModel}".`);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.controlId)) {
		throw new Error("GUI atlas text controlId must contain 1-128 letters, digits, dots, underscores, colons, or hyphens.");
	}
	if (!Array.isArray(candidate.fontAssetPaths) || !candidate.fontAssetPaths.length || candidate.fontAssetPaths.length > 8) {
		throw new Error("GUI atlas text requires an ordered fallback chain of 1-8 project font assets.");
	}
	candidate.fontAssetPaths.forEach(assertAssetPath);
	if (new Set(candidate.fontAssetPaths).size !== candidate.fontAssetPaths.length) {
		throw new Error("GUI atlas text font fallback paths must be unique.");
	}
	if (typeof candidate.text !== "string" || candidate.text.length > 16_384) {
		throw new Error("GUI atlas text is limited to 16,384 UTF-16 code units.");
	}
	assertFiniteRange(candidate.width, 1, 4096, "GUI atlas text width");
	assertFiniteRange(candidate.height, 1, 4096, "GUI atlas text height");
	if (!Number.isInteger(candidate.width) || !Number.isInteger(candidate.height) || candidate.width * candidate.height > maximumTextPixels) {
		throw new Error(`GUI atlas text dimensions must be integers totaling at most ${maximumTextPixels.toLocaleString()} pixels.`);
	}
	assertFiniteRange(candidate.fontSize, 1, 512, "GUI atlas text font size");
	candidate.color = normalizeHexColor(candidate.color, "GUI atlas text color");
	candidate.outlineColor = normalizeHexColor(candidate.outlineColor, "GUI atlas text outline color");
	assertFiniteRange(candidate.outlineWidth, 0, 16, "GUI atlas text outline width");
	assertFiniteRange(candidate.characterSpacing, -64, 256, "GUI atlas text character spacing");
	assertFiniteRange(candidate.lineSpacing, 0.25, 4, "GUI atlas text line spacing");
	if (!new Set(["left", "center", "right"]).has(candidate.horizontalAlignment)) {
		throw new Error("GUI atlas text horizontal alignment must be left, center, or right.");
	}
	if (!new Set(["top", "center", "bottom"]).has(candidate.verticalAlignment)) {
		throw new Error("GUI atlas text vertical alignment must be top, center, or bottom.");
	}
	if (!new Set(["none", "word", "character"]).has(candidate.wrapMode)) {
		throw new Error("GUI atlas text wrap mode must be none, word, or character.");
	}
	if (!new Set(["overflow", "clip", "ellipsis"]).has(candidate.overflowMode)) {
		throw new Error("GUI atlas text overflow mode must be overflow, clip, or ellipsis.");
	}
	if (typeof candidate.richText !== "boolean" || typeof candidate.populateMissingGlyphs !== "boolean") {
		throw new Error("GUI atlas text richText and populateMissingGlyphs must be boolean.");
	}
	if (!Number.isInteger(candidate.maxRuntimeGlyphs) || candidate.maxRuntimeGlyphs < 0 || candidate.maxRuntimeGlyphs > 1024) {
		throw new Error("GUI atlas text maxRuntimeGlyphs must be an integer between 0 and 1,024.");
	}
	return candidate;
}

function parseSize(value: string, current: number): number | null {
	if (/^\d+(?:\.\d+)?%$/.test(value)) {
		return (current * Number.parseFloat(value)) / 100;
	}
	if (/^[+-]\d+(?:\.\d+)?$/.test(value)) {
		return current + Number.parseFloat(value);
	}
	if (/^\d+(?:\.\d+)?$/.test(value)) {
		return Number.parseFloat(value);
	}
	return null;
}

/** Parses the bounded TMP-style subset supported by atlas text: b, i, u, s, color, size, and br. */
export function parseGUIAtlasRichText(assignmentValue: IGUIAtlasTextAssignment): { tokens: IGUIAtlasRichTextToken[]; tagCount: number } {
	const assignment = normalizeGUIAtlasTextAssignment(assignmentValue);
	const base: IGUIAtlasTextStyle = {
		fontSize: assignment.fontSize,
		color: assignment.color,
		bold: false,
		italic: false,
		underline: false,
		strikethrough: false,
	};
	if (!assignment.richText) {
		return {
			tokens: Array.from(assignment.text, (character) => ({ character, style: clone(base), newline: character === "\n" })),
			tagCount: 0,
		};
	}
	const tokens: IGUIAtlasRichTextToken[] = [];
	const stack: Array<{ tag: string; style: IGUIAtlasTextStyle }> = [];
	let style = clone(base);
	let tagCount = 0;
	for (let index = 0; index < assignment.text.length; ) {
		if (assignment.text[index] === "<") {
			const end = assignment.text.indexOf(">", index + 1);
			if (end !== -1 && end - index <= 128) {
				const source = assignment.text.slice(index + 1, end).trim();
				const lower = source.toLowerCase();
				if (lower === "br" || lower === "br/") {
					tokens.push({ character: "\n", style: clone(style), newline: true });
					tagCount++;
					index = end + 1;
					continue;
				}
				const close = lower.match(/^\/(b|i|u|s|color|size)$/)?.[1];
				if (close) {
					const stackIndex = stack.map((entry) => entry.tag).lastIndexOf(close);
					if (stackIndex !== -1) {
						style = clone(stack[stackIndex].style);
						stack.splice(stackIndex);
						tagCount++;
						index = end + 1;
						continue;
					}
				}
				const open = lower.match(/^(b|i|u|s)$/)?.[1];
				const color = source.match(/^color\s*=\s*([#\da-f]+)$/i)?.[1];
				const size = source.match(/^size\s*=\s*([+\-\d.%]+)$/i)?.[1];
				let next: IGUIAtlasTextStyle | null = null;
				let tag = "";
				if (open) {
					next = clone(style);
					tag = open;
					if (open === "b") {
						next.bold = true;
					}
					if (open === "i") {
						next.italic = true;
					}
					if (open === "u") {
						next.underline = true;
					}
					if (open === "s") {
						next.strikethrough = true;
					}
				} else if (color) {
					try {
						next = { ...style, color: normalizeHexColor(color, "GUI rich-text color") };
						tag = "color";
					} catch {
						// An invalid tag remains literal text.
					}
				} else if (size) {
					const parsed = parseSize(size, style.fontSize);
					if (parsed !== null && parsed >= 1 && parsed <= 512) {
						next = { ...style, fontSize: parsed };
						tag = "size";
					}
				}
				if (next) {
					if (stack.length >= maximumRichTextDepth || tagCount >= maximumRichTextTags) {
						throw new Error(`GUI rich text supports at most ${maximumRichTextDepth} nested tags and ${maximumRichTextTags} total tags.`);
					}
					stack.push({ tag, style: clone(style) });
					style = next;
					tagCount++;
					index = end + 1;
					continue;
				}
			}
		}
		const codepoint = assignment.text.codePointAt(index)!;
		const character = String.fromCodePoint(codepoint);
		tokens.push({ character, style: clone(style), newline: character === "\n" });
		index += character.length;
	}
	return { tokens, tagCount };
}

function fontGlyphMaps(fonts: ILoadedImportedFont[]): Array<Map<number, IFontAtlasCharacter>> {
	return fonts.map((font) => new Map(font.manifest.characters.map((glyph) => [glyph.id, glyph])));
}

function kerningAmount(manifest: IFontAtlasManifest, first: number, second: number): number {
	return manifest.kernings.find((entry) => entry.first === first && entry.second === second)?.amount ?? 0;
}

function dynamicAdvance(character: string, style: IGUIAtlasTextStyle): number {
	if (/^\s$/u.test(character)) {
		return style.fontSize * 0.33;
	}
	return style.fontSize * (style.bold ? 0.64 : 0.6);
}

function prepareGlyph(
	token: IGUIAtlasRichTextToken,
	fonts: ILoadedImportedFont[],
	maps: Array<Map<number, IFontAtlasCharacter>>,
	assignment: IGUIAtlasTextAssignment,
	populated: Set<number>
): IPreparedGlyph {
	if (token.newline) {
		return {
			character: "\n",
			renderCharacter: "\n",
			codepoint: 10,
			assetIndex: 0,
			glyph: null,
			dynamic: false,
			style: token.style,
			advance: 0,
			width: 0,
			height: 0,
			xOffset: 0,
			yOffset: 0,
			scale: 1,
			newline: true,
			whitespace: false,
			missing: false,
		};
	}
	const codepoint = token.character.codePointAt(0)!;
	let assetIndex = maps.findIndex((map) => map.has(codepoint));
	let renderCodepoint = codepoint;
	let missing = assetIndex === -1;
	if (assetIndex === -1 && assignment.populateMissingGlyphs && populated.size < assignment.maxRuntimeGlyphs) {
		assetIndex = fonts.findIndex((font) => Boolean(font.sourceFontUrl ?? font.dynamicFontUrl));
		if (assetIndex !== -1) {
			populated.add(codepoint);
			return {
				character: token.character,
				renderCharacter: token.character,
				codepoint,
				assetIndex,
				glyph: null,
				dynamic: true,
				style: token.style,
				advance: dynamicAdvance(token.character, token.style) + assignment.characterSpacing,
				width: token.style.fontSize,
				height: token.style.fontSize * 1.2,
				xOffset: 0,
				yOffset: 0,
				scale: 1,
				newline: false,
				whitespace: /^\s$/u.test(token.character),
				missing,
			};
		}
	}
	if (assetIndex === -1) {
		for (const replacement of [0xfffd, 63]) {
			assetIndex = maps.findIndex((map) => map.has(replacement));
			if (assetIndex !== -1) {
				renderCodepoint = replacement;
				break;
			}
		}
	}
	if (assetIndex === -1) {
		return {
			character: token.character,
			renderCharacter: "",
			codepoint,
			assetIndex: 0,
			glyph: null,
			dynamic: false,
			style: token.style,
			advance: assignment.characterSpacing,
			width: 0,
			height: token.style.fontSize * 1.2,
			xOffset: 0,
			yOffset: 0,
			scale: 1,
			newline: false,
			whitespace: /^\s$/u.test(token.character),
			missing: true,
		};
	}
	const font = fonts[assetIndex];
	const glyph = maps[assetIndex].get(renderCodepoint)!;
	const scale = token.style.fontSize / Math.max(1, font.manifest.fontSize);
	return {
		character: token.character,
		renderCharacter: String.fromCodePoint(renderCodepoint),
		codepoint,
		assetIndex,
		glyph,
		dynamic: false,
		style: token.style,
		advance: glyph.xAdvance * scale + assignment.characterSpacing,
		width: glyph.width * scale,
		height: glyph.height * scale,
		xOffset: glyph.xOffset * scale,
		yOffset: glyph.yOffset * scale,
		scale,
		newline: false,
		whitespace: /^\s$/u.test(token.character),
		missing,
	};
}

function lineHeightFor(prepared: IPreparedGlyph, fonts: ILoadedImportedFont[], lineSpacing: number): number {
	const natural = prepared.dynamic ? prepared.style.fontSize * 1.2 : fonts[prepared.assetIndex].manifest.lineHeight * prepared.scale;
	return Math.max(1, natural * lineSpacing);
}

function layoutWorkingLines(prepared: IPreparedGlyph[], fonts: ILoadedImportedFont[], assignment: IGUIAtlasTextAssignment): IWorkingLine[] {
	const lines: IWorkingLine[] = [];
	let line: IWorkingLine = { glyphs: [], width: 0, height: assignment.fontSize * assignment.lineSpacing * 1.2 };
	let previous: IPreparedGlyph | null = null;
	const finish = (): void => {
		lines.push(line);
		line = { glyphs: [], width: 0, height: assignment.fontSize * assignment.lineSpacing * 1.2 };
		previous = null;
	};
	for (let index = 0; index < prepared.length; index++) {
		const item = prepared[index];
		if (item.newline) {
			finish();
			continue;
		}
		if (assignment.wrapMode === "word" && !item.whitespace && (index === 0 || prepared[index - 1].whitespace || prepared[index - 1].newline)) {
			let wordWidth = 0;
			for (let wordIndex = index; wordIndex < prepared.length && !prepared[wordIndex].whitespace && !prepared[wordIndex].newline; wordIndex++) {
				wordWidth += prepared[wordIndex].advance;
			}
			if (line.glyphs.length && line.width + wordWidth > assignment.width) {
				finish();
			}
		}
		let kerning = 0;
		if (previous?.glyph && item.glyph && previous.assetIndex === item.assetIndex && previous.style.fontSize === item.style.fontSize) {
			kerning = kerningAmount(fonts[item.assetIndex].manifest, previous.glyph.id, item.glyph.id) * item.scale;
		}
		const projected = line.width + kerning + item.advance;
		if (assignment.wrapMode !== "none" && assignment.wrapMode !== "word" && line.glyphs.length && projected > assignment.width) {
			finish();
			kerning = 0;
		} else if (assignment.wrapMode === "word" && line.glyphs.length && projected > assignment.width && !item.whitespace) {
			finish();
			kerning = 0;
		}
		if (!line.glyphs.length && item.whitespace && lines.length) {
			previous = item;
			continue;
		}
		line.width += kerning;
		line.glyphs.push({ prepared: item, localX: line.width + item.xOffset });
		line.width += item.advance;
		line.height = Math.max(line.height, lineHeightFor(item, fonts, assignment.lineSpacing));
		previous = item;
	}
	if (line.glyphs.length || !lines.length || prepared.at(-1)?.newline) {
		finish();
	}
	return lines;
}

/** Produces deterministic glyph positions, fallback evidence, wrapping, alignment, clipping, and ellipsis without requiring a DOM canvas. */
export function layoutGUIAtlasText(assignmentValue: IGUIAtlasTextAssignment, fonts: ILoadedImportedFont[]): IGUIAtlasTextLayoutResult {
	const assignment = normalizeGUIAtlasTextAssignment(assignmentValue);
	if (fonts.length !== assignment.fontAssetPaths.length) {
		throw new Error(`GUI atlas text expected ${assignment.fontAssetPaths.length} loaded fonts but received ${fonts.length}.`);
	}
	fonts.forEach((font, index) => {
		if (font.authoredPath !== assignment.fontAssetPaths[index]) {
			throw new Error(`GUI atlas text font ${index} must be "${assignment.fontAssetPaths[index]}" but received "${font.authoredPath}".`);
		}
	});
	const parsed = parseGUIAtlasRichText(assignment);
	const maps = fontGlyphMaps(fonts);
	const populated = new Set<number>();
	const prepared = parsed.tokens.map((token) => prepareGlyph(token, fonts, maps, assignment, populated));
	let working = layoutWorkingLines(prepared, fonts, assignment);
	const missingCodepoints = [...new Set(prepared.filter((item) => item.missing).map((item) => item.codepoint))].sort((left, right) => left - right);
	let visibleHeight = 0;
	let visibleLineCount = working.length;
	if (assignment.overflowMode !== "overflow") {
		visibleLineCount = 0;
		for (const line of working) {
			if (visibleLineCount && visibleHeight + line.height > assignment.height) {
				break;
			}
			visibleHeight += line.height;
			visibleLineCount++;
		}
		visibleLineCount = Math.max(1, visibleLineCount);
	}
	let clippedGlyphCount = working.slice(visibleLineCount).reduce((total, line) => total + line.glyphs.length, 0);
	let truncated = visibleLineCount < working.length;
	working = working.slice(0, visibleLineCount);
	if (truncated && assignment.overflowMode === "ellipsis" && working.length) {
		const lastLine = working.at(-1)!;
		const lastStyle = lastLine.glyphs.at(-1)?.prepared.style ?? {
			fontSize: assignment.fontSize,
			color: assignment.color,
			bold: false,
			italic: false,
			underline: false,
			strikethrough: false,
		};
		const ellipsis = prepareGlyph({ character: "…", style: lastStyle, newline: false }, fonts, maps, assignment, populated);
		while (lastLine.glyphs.length && lastLine.width + ellipsis.advance > assignment.width) {
			const removed = lastLine.glyphs.pop()!;
			lastLine.width = Math.max(0, removed.localX - removed.prepared.xOffset);
			clippedGlyphCount++;
		}
		lastLine.glyphs.push({ prepared: ellipsis, localX: lastLine.width + ellipsis.xOffset });
		lastLine.width += ellipsis.advance;
	}
	visibleHeight = working.reduce((total, line) => total + line.height, 0);
	const verticalOffset =
		assignment.verticalAlignment === "center" ? (assignment.height - visibleHeight) / 2 : assignment.verticalAlignment === "bottom" ? assignment.height - visibleHeight : 0;
	const placements: IGUIAtlasGlyphPlacement[] = [];
	const lines: IGUIAtlasTextLineLayout[] = [];
	let lineTop = Math.max(0, verticalOffset);
	working.forEach((line, lineIndex) => {
		const horizontalOffset =
			assignment.horizontalAlignment === "center" ? (assignment.width - line.width) / 2 : assignment.horizontalAlignment === "right" ? assignment.width - line.width : 0;
		for (const entry of line.glyphs) {
			const item = entry.prepared;
			if (!item.renderCharacter) {
				continue;
			}
			placements.push({
				character: item.character,
				renderCharacter: item.renderCharacter,
				codepoint: item.codepoint,
				assetIndex: item.assetIndex,
				glyph: item.glyph ? clone(item.glyph) : null,
				dynamic: item.dynamic,
				style: clone(item.style),
				x: horizontalOffset + entry.localX,
				y: lineTop + item.yOffset,
				width: item.width,
				height: item.height,
				advance: item.advance,
				lineIndex,
				scale: item.scale,
			});
		}
		lines.push({ index: lineIndex, x: horizontalOffset, y: lineTop, width: line.width, height: line.height, glyphCount: line.glyphs.length });
		lineTop += line.height;
	});
	const renderModes: IGUIAtlasTextLayoutEvidence["renderModes"] = { dynamic: 0, bitmap: 0, sdf: 0, msdf: 0 };
	placements.forEach((placement) => {
		renderModes[placement.dynamic ? "dynamic" : fonts[placement.assetIndex].renderMode]++;
	});
	return {
		assignment,
		placements,
		lines,
		evidence: {
			model: guiAtlasTextModel,
			width: assignment.width,
			height: assignment.height,
			lineCount: lines.length,
			glyphCount: placements.length,
			atlasGlyphCount: placements.filter((placement) => !placement.dynamic).length,
			runtimeGlyphCount: placements.filter((placement) => placement.dynamic).length,
			missingCodepoints,
			populatedCodepoints: [...populated].sort((left, right) => left - right),
			fallbackUseCount: placements.filter((placement) => placement.assetIndex > 0).length,
			richTagCount: parsed.tagCount,
			truncated,
			clippedGlyphCount,
			renderModes,
		},
	};
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
	if (typeof document === "undefined") {
		throw new Error("GUI atlas text rendering requires a browser canvas document.");
	}
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

async function loadAtlasPage(url: string): Promise<IGUIAtlasPagePixels> {
	let cached = pageCache.get(url);
	if (!cached) {
		cached = new Promise<IGUIAtlasPagePixels>((resolve, reject) => {
			if (typeof document === "undefined") {
				reject(new Error("GUI atlas text page loading requires a browser document."));
				return;
			}
			const image = document.createElement("img");
			image.onload = (): void => {
				try {
					const canvas = createCanvas(image.naturalWidth || image.width, image.naturalHeight || image.height);
					const context = canvas.getContext("2d", { willReadFrequently: true });
					if (!context) {
						throw new Error("GUI atlas text could not create a 2D page-decoding context.");
					}
					context.drawImage(image, 0, 0);
					const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
					resolve({ width: canvas.width, height: canvas.height, pixels });
				} catch (error) {
					reject(error);
				}
			};
			image.onerror = (): void => reject(new Error(`GUI atlas text page could not be loaded: ${url}`));
			image.src = url;
		});
		pageCache.set(url, cached);
		void cached.catch(() => {
			if (pageCache.get(url) === cached) {
				pageCache.delete(url);
			}
		});
		while (pageCache.size > maximumPageCacheEntries) {
			pageCache.delete(pageCache.keys().next().value!);
		}
	}
	return cached;
}

function median(left: number, middle: number, right: number): number {
	return Math.max(Math.min(left, middle), Math.min(Math.max(left, middle), right));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
	const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(0.000001, edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

function renderedGlyphKey(placement: IGUIAtlasGlyphPlacement, font: ILoadedImportedFont, assignment: IGUIAtlasTextAssignment): string {
	const glyph = placement.glyph!;
	return [
		font.manifestUrl,
		glyph.page,
		glyph.x,
		glyph.y,
		glyph.width,
		glyph.height,
		placement.width.toFixed(3),
		placement.height.toFixed(3),
		placement.style.color,
		placement.style.bold ? 1 : 0,
		assignment.outlineColor,
		assignment.outlineWidth,
	].join("|");
}

function blendColor(target: Uint8ClampedArray, offset: number, color: [number, number, number, number], alpha: number): void {
	const sourceAlpha = Math.max(0, Math.min(1, alpha * (color[3] / 255)));
	const targetAlpha = target[offset + 3] / 255;
	const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
	if (outputAlpha <= 0) {
		return;
	}
	for (let channel = 0; channel < 3; channel++) {
		target[offset + channel] = Math.round((color[channel] * sourceAlpha + target[offset + channel] * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
	}
	target[offset + 3] = Math.round(outputAlpha * 255);
}

function bitmapOutlineAlpha(page: IGUIAtlasPagePixels, glyph: IFontAtlasCharacter, sourceX: number, sourceY: number, radius: number): number {
	let alpha = 0;
	for (let y = Math.max(0, sourceY - radius); y <= Math.min(glyph.height - 1, sourceY + radius); y++) {
		for (let x = Math.max(0, sourceX - radius); x <= Math.min(glyph.width - 1, sourceX + radius); x++) {
			alpha = Math.max(alpha, page.pixels[((glyph.y + y) * page.width + glyph.x + x) * 4 + 3] / 255);
		}
	}
	return alpha;
}

function renderAtlasGlyph(placement: IGUIAtlasGlyphPlacement, font: ILoadedImportedFont, page: IGUIAtlasPagePixels, assignment: IGUIAtlasTextAssignment): HTMLCanvasElement {
	const key = renderedGlyphKey(placement, font, assignment);
	const cached = renderedGlyphCache.find((entry) => entry.key === key);
	if (cached) {
		return cached.canvas;
	}
	const glyph = placement.glyph!;
	const outline = Math.ceil(assignment.outlineWidth);
	const width = Math.max(1, Math.ceil(placement.width) + outline * 2);
	const height = Math.max(1, Math.ceil(placement.height) + outline * 2);
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("GUI atlas text could not create a glyph rendering context.");
	}
	const image = context.createImageData(width, height);
	const fill = colorChannels(placement.style.color);
	const outlineColor = colorChannels(assignment.outlineColor);
	const scale = Math.max(0.0001, placement.scale);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const localX = x - outline;
			const localY = y - outline;
			const sourceX = Math.max(0, Math.min(glyph.width - 1, Math.floor((localX / Math.max(1, placement.width)) * glyph.width)));
			const sourceY = Math.max(0, Math.min(glyph.height - 1, Math.floor((localY / Math.max(1, placement.height)) * glyph.height)));
			const inside = localX >= 0 && localY >= 0 && localX < placement.width && localY < placement.height;
			const sourceOffset = ((glyph.y + sourceY) * page.width + glyph.x + sourceX) * 4;
			const sourceAlpha = page.pixels[sourceOffset + 3] / 255;
			let fillAlpha = 0;
			let outlineAlpha = 0;
			if (font.renderMode === "bitmap") {
				fillAlpha = inside ? sourceAlpha : 0;
				if (outline > 0) {
					outlineAlpha = bitmapOutlineAlpha(page, glyph, sourceX, sourceY, Math.max(1, Math.ceil(assignment.outlineWidth / scale)));
				}
			} else {
				const encoded =
					font.renderMode === "msdf"
						? median(page.pixels[sourceOffset], page.pixels[sourceOffset + 1], page.pixels[sourceOffset + 2]) / 255
						: page.pixels[sourceOffset] / 255;
				const signedDistance = (encoded - 0.5) * font.manifest.distanceRange * 2;
				const boldBias = placement.style.bold ? Math.max(0.35, placement.style.fontSize * 0.0125) : 0;
				fillAlpha = inside ? smoothstep(-0.5, 0.5, signedDistance * scale + boldBias) * sourceAlpha : 0;
				outlineAlpha = smoothstep(-0.5, 0.5, signedDistance * scale + assignment.outlineWidth + boldBias) * sourceAlpha;
			}
			const offset = (y * width + x) * 4;
			if (outlineAlpha > 0) {
				blendColor(image.data, offset, outlineColor, outlineAlpha);
			}
			if (fillAlpha > 0) {
				blendColor(image.data, offset, fill, fillAlpha);
			}
		}
	}
	context.putImageData(image, 0, 0);
	renderedGlyphCache.push({ key, canvas });
	while (renderedGlyphCache.length > maximumGlyphCacheEntries) {
		renderedGlyphCache.shift();
	}
	return canvas;
}

function cssFont(style: IGUIAtlasTextStyle, family: string): string {
	return `${style.italic ? "italic " : ""}${style.bold ? "700 " : "400 "}${style.fontSize}px ${JSON.stringify(family)}`;
}

/** Rasterizes one deterministic layout from imported atlas pages, with retained source-font population for missing glyphs. */
export async function renderGUIAtlasText(
	assignmentValue: IGUIAtlasTextAssignment,
	fonts: ILoadedImportedFont[],
	loadPage: (url: string) => Promise<IGUIAtlasPagePixels> = loadAtlasPage
): Promise<IGUIAtlasTextRenderResult> {
	const layout = layoutGUIAtlasText(assignmentValue, fonts);
	const canvas = createCanvas(layout.assignment.width, layout.assignment.height);
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("GUI atlas text could not create its output canvas.");
	}
	context.clearRect(0, 0, canvas.width, canvas.height);
	const requiredPages = new Map<string, Promise<IGUIAtlasPagePixels>>();
	for (const placement of layout.placements) {
		if (!placement.dynamic && placement.glyph) {
			const url = fonts[placement.assetIndex].pageUrls[placement.glyph.page];
			if (!url) {
				throw new Error(`GUI atlas text font "${fonts[placement.assetIndex].authoredPath}" is missing page ${placement.glyph.page}.`);
			}
			requiredPages.set(url, requiredPages.get(url) ?? loadPage(url));
		}
	}
	for (const placement of layout.placements) {
		const font = fonts[placement.assetIndex];
		if (placement.dynamic) {
			context.save();
			context.font = cssFont(placement.style, font.family);
			context.textBaseline = "alphabetic";
			context.fillStyle = placement.style.color;
			if (layout.assignment.outlineWidth > 0) {
				context.strokeStyle = layout.assignment.outlineColor;
				context.lineWidth = layout.assignment.outlineWidth * 2;
				context.strokeText(placement.renderCharacter, placement.x, placement.y + placement.style.fontSize);
			}
			context.fillText(placement.renderCharacter, placement.x, placement.y + placement.style.fontSize);
			context.restore();
		} else if (placement.glyph && placement.width > 0 && placement.height > 0) {
			const url = font.pageUrls[placement.glyph.page];
			const page = await requiredPages.get(url)!;
			const glyphCanvas = renderAtlasGlyph(placement, font, page, layout.assignment);
			const outline = Math.ceil(layout.assignment.outlineWidth);
			context.save();
			if (placement.style.italic) {
				context.transform(1, 0, -0.2, 1, placement.style.fontSize * 0.12, 0);
			}
			context.drawImage(glyphCanvas, placement.x - outline, placement.y - outline);
			context.restore();
		}
		if (placement.style.underline || placement.style.strikethrough) {
			context.save();
			context.fillStyle = placement.style.color;
			const thickness = Math.max(1, placement.style.fontSize * 0.06);
			if (placement.style.underline) {
				context.fillRect(placement.x, placement.y + placement.style.fontSize * 1.02, placement.advance, thickness);
			}
			if (placement.style.strikethrough) {
				context.fillRect(placement.x, placement.y + placement.style.fontSize * 0.55, placement.advance, thickness);
			}
			context.restore();
		}
	}
	return { canvas, layout };
}

/** Clears bounded global page/glyph caches, primarily for project changes and deterministic tests. */
export function clearGUIAtlasTextCaches(): void {
	pageCache.clear();
	renderedGlyphCache.length = 0;
}
