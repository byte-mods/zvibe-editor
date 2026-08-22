import { extnamePortablePath as extname } from "./portable-path";

export type FontImporterRenderMode = "dynamic" | "bitmap" | "sdf" | "msdf";
export type FontImporterCharacterSet = "ascii" | "latin1" | "custom";

export interface IFontImporterSettings {
	renderMode: FontImporterRenderMode;
	characterSet: FontImporterCharacterSet;
	customCharacters: string;
	fontSize: number;
	padding: number;
	distanceRange: number;
}

export interface IFontAtlasPage {
	path: string;
	width: number;
	height: number;
	bytes: number;
}

export interface IFontAtlasCharacter {
	id: number;
	char: string;
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
	xAdvance: number;
	xOffset: number;
	yOffset: number;
	rotated?: boolean;
}

export interface IFontAtlasKerning {
	first: number;
	second: number;
	amount: number;
}

export interface IFontImportResult {
	sourcePath: string;
	outputDirectory: string;
	manifestPath: string;
	renderMode: FontImporterRenderMode;
	settings: IFontImporterSettings;
	family: string;
	sourceBytes: number;
	glyphCount: number;
	missingCodepoints: number[];
	pages: IFontAtlasPage[];
	dynamicFontPath: string | null;
	/** Browser-loadable source font retained for GUI fallback rendering in every import mode. */
	sourceFontPath?: string | null;
}

export interface IFontAtlasManifest {
	version: 1;
	renderMode: FontImporterRenderMode;
	family: string;
	fontSize: number;
	padding: number;
	distanceRange: number;
	lineHeight: number;
	base: number;
	ascender: number;
	descender: number;
	pages: string[];
	characters: IFontAtlasCharacter[];
	kernings: IFontAtlasKerning[];
	missingCodepoints: number[];
	dynamicFontPath: string | null;
	/** Source font filename retained alongside generated atlas data. */
	sourceFontPath?: string | null;
}

export function normalizeFontImporterSettings(settings: Record<string, unknown>): IFontImporterSettings {
	return {
		renderMode: settings.renderMode as FontImporterRenderMode,
		characterSet: settings.characterSet as FontImporterCharacterSet,
		customCharacters: String(settings.customCharacters ?? ""),
		fontSize: Number(settings.fontSize),
		padding: Number(settings.padding),
		distanceRange: Number(settings.distanceRange),
	};
}

export function getFontImporterCodepoints(settings: IFontImporterSettings): number[] {
	let characters: string;
	if (settings.characterSet === "ascii") {
		characters = Array.from({ length: 95 }, (_, index) => String.fromCodePoint(index + 32)).join("");
	} else if (settings.characterSet === "latin1") {
		characters = Array.from({ length: 224 }, (_, index) => String.fromCodePoint(index + 32)).join("");
	} else {
		characters = settings.customCharacters;
	}
	return [...new Set(Array.from(characters, (character) => character.codePointAt(0)!))].sort((left, right) => left - right);
}

export function validateFontImporterSource(sourcePath: string, settings: IFontImporterSettings): void {
	const extension = extname(sourcePath).toLowerCase();
	if (![".ttf", ".otf", ".woff", ".woff2"].includes(extension)) {
		throw new Error("Font importer supports TTF, OTF, WOFF, and WOFF2 assets.");
	}
	if (settings.renderMode !== "dynamic" && extension === ".woff2") {
		throw new Error("Generated bitmap/SDF/MSDF atlases require TTF, OTF, or WOFF. WOFF2 is supported only in dynamic mode.");
	}
	const codepoints = getFontImporterCodepoints(settings);
	if (settings.renderMode !== "dynamic" && !codepoints.length) {
		throw new Error("Generated font atlases require at least one character.");
	}
	if (codepoints.length > 4096) {
		throw new Error("A font atlas is limited to 4,096 unique Unicode codepoints.");
	}
}
