import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "crypto";
import { deflateSync } from "zlib";
import { copyFile, mkdir, mkdtemp, pathExists, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

import { NullEngine, Scene } from "babylonjs";
import sharp from "sharp";

import {
	decodePsdSmartFilterMasks,
	decodePsdSmartObjectResources,
	inspectPsdLayers,
	replacePsdEmbeddedSmartObjectPayloads,
	replacePsdNestedEmbeddedSmartObjectPayloads,
} from "babylonjs-editor-tools";

import { applyPsdLayerExtraction, getPsdLayerExtractionStatus } from "../../src/mcp/assets/psd-layers";
import { applyPsdSmartObjectPayloadReplacement, getPsdSmartObjectPayloadReplacementStatus } from "../../src/mcp/assets/psd-smart-object-replacement";
import { extractPsdLayers, inspectPsdLayerExtraction, inspectPsdSmartObjectPayloadReplacement, replacePsdSmartObjectPayloads } from "../../src/mcp/assets/assets";
import { projectConfiguration } from "../../src/project/configuration";

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const localizedFormsFixture = join(repositoryDirectory, "editor/test/fixtures/fonts/Geist-Locl-Test.ttf.base64");

function u16(value: number): Buffer {
	const result = Buffer.alloc(2);
	result.writeUInt16BE(value & 0xffff);
	return result;
}

function i16(value: number): Buffer {
	const result = Buffer.alloc(2);
	result.writeInt16BE(value);
	return result;
}

function u32(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeUInt32BE(value >>> 0);
	return result;
}

function u64(value: number): Buffer {
	const result = Buffer.alloc(8);
	result.writeBigUInt64BE(BigInt(value));
	return result;
}

function i32(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeInt32BE(value);
	return result;
}

function pascal(value: string): Buffer {
	const data = Buffer.from(value, "ascii");
	return Buffer.concat([Buffer.from([data.length]), data, Buffer.alloc((4 - ((data.length + 1) % 4)) % 4)]);
}

function unicodeName(value: string): Buffer {
	const data = Buffer.alloc(4 + value.length * 2);
	data.writeUInt32BE(value.length);
	for (let index = 0; index < value.length; ++index) data.writeUInt16BE(value.charCodeAt(index), 4 + index * 2);
	return data;
}

function additional(key: string, data: Buffer): Buffer {
	return Buffer.concat([Buffer.from("8BIM"), Buffer.from(key), u32(data.length), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function additional64(key: string, data: Buffer): Buffer {
	return Buffer.concat([Buffer.from("8B64"), Buffer.from(key), u64(data.length), data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

function globalAdditional(key: string, data: Buffer): Buffer {
	return Buffer.concat([Buffer.from("8BIM"), Buffer.from(key), u32(data.length), data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
}

function globalAdditionalPsb(key: string, data: Buffer): Buffer {
	return Buffer.concat([Buffer.from("8BIM"), Buffer.from(key), u64(data.length), data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
}

function sectionDivider(type: 1 | 2 | 3, blendMode?: string): Buffer {
	return blendMode ? Buffer.concat([u32(type), Buffer.from("8BIM"), Buffer.from(blendMode)]) : u32(type);
}

function effectColor(red: number, green: number, blue: number): Buffer {
	return Buffer.concat([u16(0), u16(red * 257), u16(green * 257), u16(blue * 257), u16(0)]);
}

function f64(value: number): Buffer {
	const result = Buffer.alloc(8);
	result.writeDoubleBE(value);
	return result;
}

function f32(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeFloatBE(value);
	return result;
}

function f32le(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeFloatLE(value);
	return result;
}

function u32le(value: number): Buffer {
	const result = Buffer.alloc(4);
	result.writeUInt32LE(value >>> 0);
	return result;
}

function fixedPoint(value: number): Buffer {
	return i32(Math.round(value * 0x1000000));
}

function pathRecord(selector: number, data: Buffer = Buffer.alloc(0)): Buffer {
	if (data.byteLength > 24) {
		throw new Error("PSD test path-record data exceeds 24 bytes.");
	}
	return Buffer.concat([u16(selector), data, Buffer.alloc(24 - data.byteLength)]);
}

function pathKnot(x: number, y: number): Buffer {
	const point = Buffer.concat([fixedPoint(y), fixedPoint(x)]);
	return pathRecord(1, Buffer.concat([point, point, point]));
}

function vectorMaskRectangle(left: number, top: number, right: number, bottom: number, flags = 0): Buffer {
	return Buffer.concat([
		u32(3),
		u32(flags),
		pathRecord(6),
		pathRecord(8, u16(0)),
		pathRecord(0, u16(4)),
		pathKnot(left, top),
		pathKnot(right, top),
		pathKnot(right, bottom),
		pathKnot(left, bottom),
	]);
}

function levelsRecord(inputFloor = 0, inputCeiling = 255, outputFloor = 0, outputCeiling = 255, gamma = 100): Buffer {
	return Buffer.concat([u16(inputFloor), u16(inputCeiling), u16(outputFloor), u16(outputCeiling), u16(gamma)]);
}

function levelsAdjustment(master = levelsRecord()): Buffer {
	return Buffer.concat([u16(2), master, ...Array.from({ length: 28 }, () => levelsRecord())]);
}

function curve(points: Array<[input: number, output: number]>): Buffer {
	return Buffer.concat([u16(points.length), ...points.map(([input, output]) => Buffer.concat([u16(output), u16(input)]))]);
}

function curvesAdjustmentV4(curves: Array<Array<[input: number, output: number]>>): Buffer {
	return Buffer.concat([u16(4), u16(curves.length), ...curves.map(curve)]);
}

function vibranceAdjustment(vibrance: number, saturation: number): Buffer {
	return Buffer.concat([
		u32(16),
		descriptorObject("null", [
			{ key: "vibrance", type: "long", value: i32(vibrance) },
			{ key: "Strt", type: "long", value: i32(saturation) },
		]),
	]);
}

function hueSaturationChannel(range: [number, number, number, number] = [0, 0, 0, 0], hue = 0, saturation = 0, lightness = 0): Buffer {
	return Buffer.concat([...range.map(i16), i16(hue), i16(saturation), i16(lightness)]);
}

function hueSaturationAdjustment(master: [number, number, number], channels = Array.from({ length: 6 }, () => hueSaturationChannel())): Buffer {
	return Buffer.concat([u16(2), Buffer.from([0, 0]), i16(0), i16(0), i16(0), ...master.map(i16), ...channels]);
}

function colorBalanceTone(cyanRed = 0, magentaGreen = 0, yellowBlue = 0): Buffer {
	return Buffer.concat([i16(cyanRed), i16(magentaGreen), i16(yellowBlue)]);
}

function colorBalanceAdjustment(midtones: [number, number, number], preserveLuminosity = false): Buffer {
	return Buffer.concat([colorBalanceTone(), colorBalanceTone(...midtones), colorBalanceTone(), Buffer.from([preserveLuminosity ? 1 : 0, 0])]);
}

function descriptorUnicode(value: string): Buffer {
	const data = Buffer.alloc(4 + value.length * 2);
	data.writeUInt32BE(value.length);
	for (let index = 0; index < value.length; ++index) data.writeUInt16BE(value.charCodeAt(index), 4 + index * 2);
	return data;
}

function linkedUnicode(value: string): Buffer {
	return descriptorUnicode(`${value}\0`);
}

function linkedResourceRecord(options: {
	type: "liFD" | "liFE" | "liFA";
	id: string;
	name: string;
	fileType?: string;
	creator?: string;
	data?: Buffer;
	external?: { name: string; fullPath: string; originalPath: string; relativePath: string; fileSize: number };
}): Buffer {
	const data = options.data ?? Buffer.alloc(0);
	const externalDescriptor =
		options.type === "liFE"
			? Buffer.concat([
					u32(16),
					descriptorObject("ExternalFileLink", [
						{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(options.external?.name ?? "") },
						{ key: "fullPath", type: "TEXT", value: descriptorUnicode(options.external?.fullPath ?? "") },
						{ key: "originalPath", type: "TEXT", value: descriptorUnicode(options.external?.originalPath ?? "") },
						{ key: "relPath", type: "TEXT", value: descriptorUnicode(options.external?.relativePath ?? "") },
					]),
				])
			: Buffer.alloc(0);
	const body = Buffer.concat([
		Buffer.from(options.type),
		i32(options.type === "liFE" ? 4 : 2),
		Buffer.from([options.id.length]),
		Buffer.from(options.id, "ascii"),
		linkedUnicode(options.name),
		Buffer.from((options.fileType ?? "").padEnd(4, " ").slice(0, 4)),
		Buffer.from((options.creator ?? "").padEnd(4, "\0").slice(0, 4)),
		u64(data.length),
		Buffer.from([0]),
		externalDescriptor,
		...(options.type === "liFE" ? [i32(2026), Buffer.from([6, 22, 10, 30]), f64(15.25), u64(options.external?.fileSize ?? 0)] : []),
		...(options.type === "liFA" ? [Buffer.alloc(8)] : []),
		...(options.type === "liFD" ? [data] : []),
	]);
	return Buffer.concat([u64(body.length), body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
}

function descriptorClassId(value: string): Buffer {
	return value.length === 4 ? Buffer.concat([i32(0), Buffer.from(value)]) : Buffer.concat([i32(value.length), Buffer.from(value)]);
}

function descriptorObject(classId: string, entries: Array<{ key: string; type: string; value: Buffer }>): Buffer {
	return Buffer.concat([
		descriptorUnicode(""),
		descriptorClassId(classId),
		u32(entries.length),
		...entries.map((entry) => Buffer.concat([descriptorClassId(entry.key), Buffer.from(entry.type), entry.value])),
	]);
}

function descriptorEnum(type: string, value: string): Buffer {
	return Buffer.concat([descriptorClassId(type), descriptorClassId(value)]);
}

function descriptorUnit(units: string, value: number): Buffer {
	return Buffer.concat([Buffer.from(units), f64(value)]);
}

function descriptorPath(signature: string, path: string, declaredLengthDelta = 0): Buffer {
	const encoded = Buffer.from(path, "utf16le");
	const length = 12 + encoded.byteLength;
	const payload = Buffer.alloc(length);
	payload.write(signature.padEnd(4, " ").slice(0, 4), 0, 4, "ascii");
	payload.writeInt32LE(length + declaredLengthDelta, 4);
	payload.writeInt32LE(path.length, 8);
	encoded.copy(payload, 12);
	return Buffer.concat([i32(length), payload]);
}

function solidColorFillDescriptor(red: number, green: number, blue: number): Buffer {
	return Buffer.concat([
		u32(16),
		descriptorObject("null", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: f64(red) },
					{ key: "Grn ", type: "doub", value: f64(green) },
					{ key: "Bl  ", type: "doub", value: f64(blue) },
				]),
			},
		]),
	]);
}

function patternFillDescriptor(options: { align?: boolean; scale?: number; angle?: number; linked?: boolean; phaseX?: number; phaseY?: number } = {}): Buffer {
	const pattern = descriptorObject("Ptrn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("RGBA Tile") },
		{ key: "Idnt", type: "TEXT", value: descriptorUnicode("rgba-tile-2x2") },
	]);
	const phase = descriptorObject("Pnt ", [
		{ key: "Hrzn", type: "doub", value: f64(options.phaseX ?? 0) },
		{ key: "Vrtc", type: "doub", value: f64(options.phaseY ?? 0) },
	]);
	return Buffer.concat([
		u32(16),
		descriptorObject("null", [
			{ key: "Ptrn", type: "Objc", value: pattern },
			{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", options.scale ?? 100) },
			{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", options.angle ?? 0) },
			{ key: "Algn", type: "bool", value: Buffer.from([options.align === false ? 0 : 1]) },
			{ key: "Lnkd", type: "bool", value: Buffer.from([options.linked === false ? 0 : 1]) },
			{ key: "phase", type: "Objc", value: phase },
		]),
	]);
}

function gradientFillDescriptor(type: "solid" | "noise" = "solid"): Buffer {
	const colorStop = (location: number, color: [number, number, number]): Buffer =>
		descriptorObject("Clrt", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: f64(color[0]) },
					{ key: "Grn ", type: "doub", value: f64(color[1]) },
					{ key: "Bl  ", type: "doub", value: f64(color[2]) },
				]),
			},
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const opacityStop = (location: number, opacity: number): Buffer =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", opacity) },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const gradient =
		type === "noise"
			? descriptorObject("Grdn", [
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "ClNs") },
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Seeded Noise Fill") },
					{ key: "ShTr", type: "bool", value: Buffer.from([1]) },
					{ key: "VctC", type: "bool", value: Buffer.from([1]) },
					{ key: "ClrS", type: "enum", value: descriptorEnum("ClrS", "RGBC") },
					{ key: "RndS", type: "long", value: i32(123456) },
					{ key: "Smth", type: "long", value: i32(3072) },
					{ key: "Mnm ", type: "VlLs", value: descriptorLongList(10, 20, 30, 40) },
					{ key: "Mxm ", type: "VlLs", value: descriptorLongList(90, 80, 70, 60) },
				])
			: descriptorObject("Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Red Blue Fill") },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
					{ key: "Intr", type: "doub", value: f64(4096) },
					{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, [255, 0, 0]), colorStop(4096, [0, 0, 255])) },
					{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0, 100), opacityStop(4096, 50)) },
				]);
	return Buffer.concat([
		u32(16),
		descriptorObject("null", [
			{ key: "Dthr", type: "bool", value: Buffer.from([0]) },
			{ key: "gradientsInterpolationMethod", type: "enum", value: descriptorEnum("gradientInterpolationMethodType", "Gcls") },
			{ key: "Rvrs", type: "bool", value: Buffer.from([type === "noise" ? 1 : 0]) },
			{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "Type", type: "enum", value: descriptorEnum("GrdT", type === "noise" ? "Rdl " : "Lnr ") },
			{ key: "Algn", type: "bool", value: Buffer.from([type === "noise" ? 0 : 1]) },
			{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{
				key: "Ofst",
				type: "Objc",
				value: descriptorObject("Pnt ", [
					{ key: "Hrzn", type: "UntF", value: descriptorUnit("#Prc", 0) },
					{ key: "Vrtc", type: "UntF", value: descriptorUnit("#Prc", 0) },
				]),
			},
			{ key: "Grad", type: "Objc", value: gradient },
		]),
	]);
}

function descriptorList(...values: Buffer[]): Buffer {
	return Buffer.concat([i32(values.length), ...values.map((value) => Buffer.concat([Buffer.from("Objc"), value]))]);
}

function descriptorEnumReference(enumType: string, ...values: string[]): Buffer {
	return Buffer.concat([
		i32(values.length),
		...values.map((value) => Buffer.concat([Buffer.from("Enmr"), descriptorUnicode("\0"), descriptorClassId(enumType), descriptorClassId(enumType), descriptorClassId(value)])),
	]);
}

function descriptorLongList(...values: number[]): Buffer {
	return Buffer.concat([i32(values.length), ...values.map((value) => Buffer.concat([Buffer.from("long"), i32(value)]))]);
}

function descriptorUnitList(...values: Array<{ units: string; value: number }>): Buffer {
	return Buffer.concat([i32(values.length), ...values.map((entry) => Buffer.concat([Buffer.from("UntF"), descriptorUnit(entry.units, entry.value)]))]);
}

function vectorStrokeDescriptor(): Buffer {
	const content = descriptorObject("solidColorLayer", [
		{
			key: "Clr ",
			type: "Objc",
			value: descriptorObject("RGBC", [
				{ key: "Rd  ", type: "doub", value: f64(20) },
				{ key: "Grn ", type: "doub", value: f64(100) },
				{ key: "Bl  ", type: "doub", value: f64(240) },
			]),
		},
	]);
	return Buffer.concat([
		u32(16),
		descriptorObject("strokeStyle", [
			{ key: "strokeStyleVersion", type: "long", value: i32(2) },
			{ key: "strokeEnabled", type: "bool", value: Buffer.from([1]) },
			{ key: "fillEnabled", type: "bool", value: Buffer.from([1]) },
			{ key: "strokeStyleLineWidth", type: "UntF", value: descriptorUnit("#Pxl", 4) },
			{ key: "strokeStyleLineDashOffset", type: "UntF", value: descriptorUnit("#Pxl", 1) },
			{ key: "strokeStyleMiterLimit", type: "doub", value: f64(10) },
			{ key: "strokeStyleLineCapType", type: "enum", value: descriptorEnum("strokeStyleLineCapType", "strokeStyleRoundCap") },
			{ key: "strokeStyleLineJoinType", type: "enum", value: descriptorEnum("strokeStyleLineJoinType", "strokeStyleBevelJoin") },
			{ key: "strokeStyleLineAlignment", type: "enum", value: descriptorEnum("strokeStyleLineAlignment", "strokeStyleAlignCenter") },
			{ key: "strokeStyleScaleLock", type: "bool", value: Buffer.from([1]) },
			{ key: "strokeStyleStrokeAdjust", type: "bool", value: Buffer.from([1]) },
			{ key: "strokeStyleLineDashSet", type: "VlLs", value: descriptorUnitList({ units: "#Pxl", value: 6 }, { units: "#Pxl", value: 2 }) },
			{ key: "strokeStyleBlendMode", type: "enum", value: descriptorEnum("BlnM", "Mltp") },
			{ key: "strokeStyleOpacity", type: "UntF", value: descriptorUnit("#Prc", 75) },
			{ key: "strokeStyleContent", type: "Objc", value: content },
			{ key: "strokeStyleResolution", type: "doub", value: f64(72) },
		]),
	]);
}

function vectorOriginationDescriptor(): Buffer {
	const point = (x: number, y: number): Buffer =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: f64(x) },
			{ key: "Vrtc", type: "doub", value: f64(y) },
		]);
	const item = descriptorObject("null", [
		{ key: "keyOriginType", type: "long", value: i32(1) },
		{ key: "keyOriginResolution", type: "doub", value: f64(144) },
		{
			key: "keyOriginRRectRadii",
			type: "Objc",
			value: descriptorObject("radii", [
				{ key: "unitValueQuadVersion", type: "long", value: i32(1) },
				{ key: "topRight", type: "UntF", value: descriptorUnit("#Pxl", 1) },
				{ key: "topLeft", type: "UntF", value: descriptorUnit("#Pxl", 2) },
				{ key: "bottomLeft", type: "UntF", value: descriptorUnit("#Pxl", 3) },
				{ key: "bottomRight", type: "UntF", value: descriptorUnit("#Pxl", 4) },
			]),
		},
		{
			key: "keyOriginShapeBBox",
			type: "Objc",
			value: descriptorObject("unitRect", [
				{ key: "unitValueQuadVersion", type: "long", value: i32(1) },
				{ key: "Top ", type: "UntF", value: descriptorUnit("#Pnt", 2) },
				{ key: "Left", type: "UntF", value: descriptorUnit("#Pxl", 3) },
				{ key: "Btom", type: "doub", value: f64(12) },
				{ key: "Rght", type: "UntF", value: descriptorUnit("#Pxl", 13) },
			]),
		},
		{
			key: "keyOriginBoxCorners",
			type: "Objc",
			value: descriptorObject("null", [
				{ key: "rectangleCornerA", type: "Objc", value: point(3, 2) },
				{ key: "rectangleCornerB", type: "Objc", value: point(13, 2) },
				{ key: "rectangleCornerC", type: "Objc", value: point(13, 12) },
				{ key: "rectangleCornerD", type: "Objc", value: point(3, 12) },
			]),
		},
		{
			key: "Trnf",
			type: "Objc",
			value: descriptorObject("Trnf", [
				{ key: "xx", type: "doub", value: f64(1) },
				{ key: "xy", type: "doub", value: f64(0.1) },
				{ key: "yx", type: "doub", value: f64(-0.2) },
				{ key: "yy", type: "doub", value: f64(1) },
				{ key: "tx", type: "doub", value: f64(5) },
				{ key: "ty", type: "doub", value: f64(6) },
			]),
		},
		{ key: "keyShapeInvalidated", type: "bool", value: Buffer.from([0]) },
		{ key: "keyOriginIndex", type: "long", value: i32(0) },
	]);
	return Buffer.concat([i32(1), u32(16), descriptorObject("null", [{ key: "keyDescriptorList", type: "VlLs", value: descriptorList(item) }]), Buffer.from([0, 0])]);
}

function pathListDescriptor(): Buffer {
	const symmetry = descriptorObject("pathSymmetryClass", [{ key: "pathSymmetryMode", type: "enum", value: descriptorEnum("pathSymmetryModeEnum", "pathSymmetryModeBasicPath") }]);
	const path = descriptorObject("pathInfoClass", [
		{ key: "pathUnicodeName", type: "TEXT", value: descriptorUnicode("Work Path") },
		{ key: "pathSymmetryClass", type: "Objc", value: symmetry },
	]);
	return Buffer.concat([u32(16), descriptorObject("pathsDataClass", [{ key: "pathList", type: "VlLs", value: descriptorList(path) }]), Buffer.from([0, 0])]);
}

function descriptorDoubleList(...values: number[]): Buffer {
	return Buffer.concat([i32(values.length), ...values.map((value) => Buffer.concat([Buffer.from("doub"), f64(value)]))]);
}

function descriptorBooleanList(...values: boolean[]): Buffer {
	return Buffer.concat([i32(values.length), ...values.map((value) => Buffer.concat([Buffer.from("bool"), Buffer.from([value ? 1 : 0])]))]);
}

function descriptorBytes(bytes: Buffer): Buffer {
	return Buffer.concat([i32(bytes.byteLength), bytes]);
}

function engineText(value: string): Buffer {
	const encoded = Buffer.alloc(2 + value.length * 2);
	encoded.writeUInt16BE(0xfeff);
	for (let index = 0; index < value.length; ++index) encoded.writeUInt16BE(value.charCodeAt(index), 2 + index * 2);
	return Buffer.concat([Buffer.from("("), encoded, Buffer.from(")")]);
}

function txt2EngineData2(
	editors: Array<{
		text: string;
		runs: Array<{ length: number; fractions?: boolean; ordinals?: boolean; stylisticAlternates?: boolean }>;
	}>
): Buffer {
	return Buffer.concat([
		Buffer.from("<< /1 << /1 [ "),
		...editors.flatMap((editor) => [
			Buffer.from("<< /0 << /0 "),
			engineText(editor.text),
			Buffer.from(" /6 << /0 [ "),
			...editor.runs.map((run) =>
				Buffer.from(
					`<< /0 << /0 << /6 <<${run.fractions === undefined ? "" : ` /23 ${run.fractions}`}${run.ordinals === undefined ? "" : ` /24 ${run.ordinals}`}${run.stylisticAlternates === undefined ? "" : ` /28 ${run.stylisticAlternates}`} >> >> >> /1 ${run.length} >> `
				)
			),
			Buffer.from("] >> >> >> "),
		]),
		Buffer.from("] >> >>"),
	]);
}

function tyshText(
	text: string,
	options?: {
		fonts: string[];
		textIndex?: number;
		smallCapSize?: number;
		superscriptSize?: number;
		superscriptPosition?: number;
		subscriptSize?: number;
		subscriptPosition?: number;
		includeEngineTerminator?: boolean;
		orientation?: "Hrzn" | "Vrtc";
		shape?: { type: "point"; pointBase: [number, number] } | { type: "box"; boxBounds: [number, number, number, number] };
		warp?: {
			style: string;
			value: number;
			perspective: number;
			perspectiveOther: number;
			rotate: "Hrzn" | "Vrtc";
			customMesh?: Array<{ x: number; y: number }>;
			uOrder?: number;
			vOrder?: number;
			deformNumRows?: number;
			deformNumCols?: number;
			quiltSliceX?: number[];
			quiltSliceY?: number[];
		};
		styles: Array<{
			length: number;
			fontIndex: number;
			language?: number;
			fontSize: number;
			fauxBold: boolean;
			fauxItalic: boolean;
			fontCaps?: number;
			fontBaseline?: number;
			baselineDirection?: number;
			proportionalMetrics?: boolean;
			kana?: boolean;
			ruby?: boolean;
			japaneseAlternateFeature?: number;
			oldStyle?: boolean;
			swash?: boolean;
			titling?: boolean;
			ornaments?: boolean;
			slashedZero?: boolean;
			figureStyle?: number;
			connectionForms?: boolean;
			contextualLigatures?: boolean;
			hindiNumbers?: boolean;
			kashida?: number;
			diacriticPosition?: number;
			characterDirection?: number;
			wariChuEnabled?: boolean;
			wariChuLineCount?: number;
			wariChuLineGap?: number;
			wariChuScale?: number;
			wariChuWidow?: number;
			wariChuOrphan?: number;
			wariChuJustification?: number;
			tsume?: number;
			styleRunAlignment?: number;
			autoLeading?: boolean;
			leading?: number;
			tracking: number;
			kerning?: number;
			autoKerning?: boolean;
			ligatures?: boolean;
			discretionaryLigatures?: boolean;
			horizontalScale?: number;
			verticalScale?: number;
			baselineShift?: number;
			underline?: boolean;
			strikethrough?: boolean;
			noBreak?: boolean;
			color: [number, number, number, number];
			strokeColor?: [number, number, number, number];
			fillEnabled?: boolean;
			strokeEnabled?: boolean;
			fillFirst?: boolean;
			outlineWidth?: number;
		}>;
		paragraph?: {
			justification?: number;
			firstLineIndent?: number;
			startIndent?: number;
			endIndent?: number;
			spaceBefore?: number;
			spaceAfter?: number;
			autoHyphenate?: boolean;
			hyphenatedWordSize?: number;
			preHyphen?: number;
			postHyphen?: number;
			consecutiveHyphens?: number;
			hyphenationZone?: number;
			autoLeading?: number;
			everyLineComposer?: boolean;
		};
	}
): Buffer {
	const fonts = options?.fonts ?? ["Inter Test"];
	const styles = options?.styles ?? [
		{ length: text.length, fontIndex: 0, fontSize: 18, fauxBold: true, fauxItalic: false, tracking: 25, color: [255, 64, 32, 255] as [number, number, number, number] },
	];
	const paragraph = options?.paragraph;
	const paragraphProperties = `/Justification ${paragraph?.justification ?? 2}${paragraph?.firstLineIndent === undefined ? "" : ` /FirstLineIndent ${paragraph.firstLineIndent}`}${paragraph?.startIndent === undefined ? "" : ` /StartIndent ${paragraph.startIndent}`}${paragraph?.endIndent === undefined ? "" : ` /EndIndent ${paragraph.endIndent}`}${paragraph?.spaceBefore === undefined ? "" : ` /SpaceBefore ${paragraph.spaceBefore}`}${paragraph?.spaceAfter === undefined ? "" : ` /SpaceAfter ${paragraph.spaceAfter}`}${paragraph?.autoHyphenate === undefined ? "" : ` /AutoHyphenate ${paragraph.autoHyphenate}`}${paragraph?.hyphenatedWordSize === undefined ? "" : ` /HyphenatedWordSize ${paragraph.hyphenatedWordSize}`}${paragraph?.preHyphen === undefined ? "" : ` /PreHyphen ${paragraph.preHyphen}`}${paragraph?.postHyphen === undefined ? "" : ` /PostHyphen ${paragraph.postHyphen}`}${paragraph?.consecutiveHyphens === undefined ? "" : ` /ConsecutiveHyphens ${paragraph.consecutiveHyphens}`}${paragraph?.hyphenationZone === undefined ? "" : ` /Zone ${paragraph.hyphenationZone}`}${paragraph?.autoLeading === undefined ? "" : ` /AutoLeading ${paragraph.autoLeading}`}${paragraph?.everyLineComposer === undefined ? "" : ` /EveryLineComposer ${paragraph.everyLineComposer}`}`;
	const shape = options?.shape;
	const renderedShape = shape
		? ` /Rendered << /Shapes << /Children [ << /Cookie << /Photoshop << /ShapeType ${shape.type === "box" ? 1 : 0}${shape.type === "box" ? ` /BoxBounds [ ${shape.boxBounds.join(" ")} ]` : ` /PointBase [ ${shape.pointBase.join(" ")} ]`} >> >> >> ] >> >>`
		: "";
	const engineData = Buffer.concat([
		Buffer.from("<< /EngineDict << /Editor << /Text "),
		engineText(options?.includeEngineTerminator ? `${text}\r` : text),
		Buffer.from(` >>${renderedShape} /StyleRun << /RunArray [ `),
		...styles.map((style) =>
			Buffer.from(
				`<< /StyleSheet << /StyleSheetData << /Font ${style.fontIndex}${style.language === undefined ? "" : ` /Language ${style.language}`} /FontSize ${style.fontSize} /FauxBold ${style.fauxBold} /FauxItalic ${style.fauxItalic}${style.fontCaps === undefined ? "" : ` /FontCaps ${style.fontCaps}`}${style.fontBaseline === undefined ? "" : ` /FontBaseline ${style.fontBaseline}`}${style.baselineDirection === undefined ? "" : ` /BaselineDirection ${style.baselineDirection}`}${style.proportionalMetrics === undefined ? "" : ` /ProportionalMetrics ${style.proportionalMetrics}`}${style.kana === undefined ? "" : ` /Kana ${style.kana}`}${style.ruby === undefined ? "" : ` /Ruby ${style.ruby}`}${style.japaneseAlternateFeature === undefined ? "" : ` /JapaneseAlternateFeature ${style.japaneseAlternateFeature}`}${style.oldStyle === undefined ? "" : ` /OldStyle ${style.oldStyle}`}${style.swash === undefined ? "" : ` /Swash ${style.swash}`}${style.titling === undefined ? "" : ` /Titling ${style.titling}`}${style.ornaments === undefined ? "" : ` /Ornaments ${style.ornaments}`}${style.slashedZero === undefined ? "" : ` /SlashedZero ${style.slashedZero}`}${style.connectionForms === undefined ? "" : ` /ConnectionForms ${style.connectionForms}`}${style.contextualLigatures === undefined ? "" : ` /ContextualLigatures ${style.contextualLigatures}`}${style.hindiNumbers === undefined ? "" : ` /HindiNumbers ${style.hindiNumbers}`}${style.kashida === undefined ? "" : ` /Kashida ${style.kashida}`}${style.diacriticPosition === undefined ? "" : ` /DiacriticPos ${style.diacriticPosition}`}${style.characterDirection === undefined ? "" : ` /CharacterDirection ${style.characterDirection}`}${style.figureStyle === undefined ? "" : ` /FigureStyle ${style.figureStyle}`}${style.wariChuEnabled === undefined ? "" : ` /EnableWariChu ${style.wariChuEnabled}`}${style.wariChuLineCount === undefined ? "" : ` /WariChuLineCount ${style.wariChuLineCount}`}${style.wariChuLineGap === undefined ? "" : ` /WariChuLineGap ${style.wariChuLineGap}`}${style.wariChuScale === undefined ? "" : ` /WariChuSubLineAmount << /WariChuSubLineScale ${style.wariChuScale} >>`}${style.wariChuWidow === undefined ? "" : ` /WariChuWidowAmount ${style.wariChuWidow}`}${style.wariChuOrphan === undefined ? "" : ` /WariChuOrphanAmount ${style.wariChuOrphan}`}${style.wariChuJustification === undefined ? "" : ` /WariChuJustification ${style.wariChuJustification}`}${style.tsume === undefined ? "" : ` /Tsume ${style.tsume}`}${style.styleRunAlignment === undefined ? "" : ` /StyleRunAlignment ${style.styleRunAlignment}`}${style.autoLeading === undefined ? "" : ` /AutoLeading ${style.autoLeading}`}${style.leading === undefined ? "" : ` /Leading ${style.leading}`} /Tracking ${style.tracking}${style.kerning === undefined ? "" : ` /Kerning ${style.kerning}`}${style.autoKerning === undefined ? "" : ` /AutoKerning ${style.autoKerning}`}${style.ligatures === undefined ? "" : ` /Ligatures ${style.ligatures}`}${style.discretionaryLigatures === undefined ? "" : ` /DLigatures ${style.discretionaryLigatures}`}${style.horizontalScale === undefined ? "" : ` /HorizontalScale ${style.horizontalScale}`}${style.verticalScale === undefined ? "" : ` /VerticalScale ${style.verticalScale}`}${style.baselineShift === undefined ? "" : ` /BaselineShift ${style.baselineShift}`}${style.underline === undefined ? "" : ` /Underline ${style.underline}`}${style.strikethrough === undefined ? "" : ` /Strikethrough ${style.strikethrough}`}${style.noBreak === undefined ? "" : ` /NoBreak ${style.noBreak}`}${style.fillEnabled === undefined ? "" : ` /FillFlag ${style.fillEnabled}`}${style.strokeEnabled === undefined ? "" : ` /StrokeFlag ${style.strokeEnabled}`}${style.fillFirst === undefined ? "" : ` /FillFirst ${style.fillFirst}`}${style.outlineWidth === undefined ? "" : ` /OutlineWidth ${style.outlineWidth}`} /FillColor << /Type 1 /Values [ ${style.color[3] / 255} ${style.color[0] / 255} ${style.color[1] / 255} ${style.color[2] / 255} ] >>${style.strokeColor === undefined ? "" : ` /StrokeColor << /Type 1 /Values [ ${style.strokeColor[3] / 255} ${style.strokeColor[0] / 255} ${style.strokeColor[1] / 255} ${style.strokeColor[2] / 255} ] >>`} >> >> >> `
			)
		),
		Buffer.from(
			`] /RunLengthArray [ ${styles.map((style) => style.length).join(" ")} ] >> /ParagraphRun << /RunArray [ << /ParagraphSheet << /Properties << ${paragraphProperties} >> >> >> ] /RunLengthArray [ ${text.length + (options?.includeEngineTerminator ? 1 : 0)} ] >> >> /ResourceDict <<${options?.smallCapSize === undefined ? "" : ` /SmallCapSize ${options.smallCapSize}`}${options?.superscriptSize === undefined ? "" : ` /SuperscriptSize ${options.superscriptSize}`}${options?.superscriptPosition === undefined ? "" : ` /SuperscriptPosition ${options.superscriptPosition}`}${options?.subscriptSize === undefined ? "" : ` /SubscriptSize ${options.subscriptSize}`}${options?.subscriptPosition === undefined ? "" : ` /SubscriptPosition ${options.subscriptPosition}`} /FontSet [ `
		),
		...fonts.flatMap((font) => [Buffer.from("<< /Name "), engineText(font), Buffer.from(" /Script 0 /FontType 0 /Synthetic 0 >> ")]),
		Buffer.from("] >> >>"),
	]);
	const bounds = descriptorObject("bounds", [
		{ key: "Left", type: "UntF", value: descriptorUnit("#Pxl", 0) },
		{ key: "Top ", type: "UntF", value: descriptorUnit("#Pxl", 0) },
		{ key: "Rght", type: "UntF", value: descriptorUnit("#Pxl", 2) },
		{ key: "Btom", type: "UntF", value: descriptorUnit("#Pxl", 1) },
	]);
	const textDescriptor = descriptorObject("TxLr", [
		{ key: "Txt ", type: "TEXT", value: descriptorUnicode(text) },
		{ key: "textGridding", type: "enum", value: descriptorEnum("textGridding", "None") },
		{ key: "Ornt", type: "enum", value: descriptorEnum("Ornt", options?.orientation ?? "Hrzn") },
		{ key: "AntA", type: "enum", value: descriptorEnum("Annt", "AnSm") },
		{ key: "TextIndex", type: "long", value: i32(options?.textIndex ?? 7) },
		{ key: "EngineData", type: "tdta", value: Buffer.concat([i32(engineData.length), engineData]) },
		{ key: "bounds", type: "Objc", value: bounds },
		{ key: "boundingBox", type: "Objc", value: bounds },
	]);
	const objectArray = (type: string, values: number[]): Buffer =>
		Buffer.concat([descriptorClassId(type), Buffer.from("UnFl"), Buffer.from("#Pxl"), i32(values.length), ...values.map(f64)]);
	const objectArrayDescriptor = (classId: string, fields: Array<{ type: string; values: number[] }>): Buffer =>
		Buffer.concat([i32(16), descriptorUnicode(""), descriptorClassId(classId), i32(fields.length), ...fields.map((field) => objectArray(field.type, field.values))]);
	const customEnvelope = options?.warp?.customMesh
		? descriptorObject("customEnvelopeWarp", [
				{
					key: "meshPoints",
					type: "ObAr",
					value: objectArrayDescriptor("meshPoints", [
						{ type: "Hrzn", values: options.warp.customMesh.map((point) => point.x) },
						{ type: "Vrtc", values: options.warp.customMesh.map((point) => point.y) },
					]),
				},
				...(options.warp.quiltSliceX
					? [
							{
								key: "quiltSliceX",
								type: "ObAr",
								value: objectArrayDescriptor("quiltSliceX", [{ type: "quiltSliceX", values: options.warp.quiltSliceX }]),
							},
						]
					: []),
				...(options.warp.quiltSliceY
					? [
							{
								key: "quiltSliceY",
								type: "ObAr",
								value: objectArrayDescriptor("quiltSliceY", [{ type: "quiltSliceY", values: options.warp.quiltSliceY }]),
							},
						]
					: []),
			])
		: null;
	const warpDescriptor = descriptorObject("warp", [
		{ key: "warpStyle", type: "enum", value: descriptorEnum("warpStyle", options?.warp?.style ?? "warpNone") },
		{ key: "warpValue", type: "doub", value: f64(options?.warp?.value ?? 0) },
		{ key: "warpPerspective", type: "doub", value: f64(options?.warp?.perspective ?? 0) },
		{ key: "warpPerspectiveOther", type: "doub", value: f64(options?.warp?.perspectiveOther ?? 0) },
		{ key: "warpRotate", type: "enum", value: descriptorEnum("Ornt", options?.warp?.rotate ?? "Hrzn") },
		...(options?.warp?.customMesh
			? [
					{ key: "uOrder", type: "long", value: i32(options.warp.uOrder ?? 4) },
					{ key: "vOrder", type: "long", value: i32(options.warp.vOrder ?? 4) },
					...(options.warp.deformNumRows === undefined ? [] : [{ key: "deformNumRows", type: "long", value: i32(options.warp.deformNumRows) }]),
					...(options.warp.deformNumCols === undefined ? [] : [{ key: "deformNumCols", type: "long", value: i32(options.warp.deformNumCols) }]),
					{ key: "customEnvelopeWarp", type: "Objc", value: customEnvelope! },
				]
			: []),
	]);
	return Buffer.concat([
		u16(1),
		f64(1),
		f64(0),
		f64(0),
		f64(1),
		f64(12),
		f64(34),
		u16(50),
		u32(16),
		textDescriptor,
		u16(1),
		u32(16),
		warpDescriptor,
		f32(0),
		f32(0),
		f32(2),
		f32(1),
	]);
}

function puppetWarpFilterDescriptor(options: {
	originalVertices?: Array<{ x: number; y: number }>;
	deformedVertices?: Array<{ x: number; y: number }>;
	triangleIndices?: number[];
	pinVertexIndices?: number[];
	omitBoundaryPath?: boolean;
}): Buffer {
	const originalVertices = options.originalVertices ?? [
		{ x: 0, y: 0 },
		{ x: 8, y: 0 },
		{ x: 8, y: 6 },
		{ x: 0, y: 6 },
	];
	const deformedVertices = options.deformedVertices ?? [originalVertices[0], originalVertices[1], { x: 6, y: 5 }, originalVertices[3]];
	const triangleIndices = options.triangleIndices ?? [0, 1, 2, 0, 2, 3];
	const pinVertexIndices = options.pinVertexIndices ?? [0, 2];
	const point = (x: number, y: number): Buffer =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "UntF", value: descriptorUnit("#Pxl", x) },
			{ key: "Vrtc", type: "UntF", value: descriptorUnit("#Pxl", y) },
		]);
	const boundaryPoints = originalVertices.map(({ x, y }) =>
		descriptorObject("Pthp", [
			{ key: "Anch", type: "Objc", value: point(x, y) },
			{ key: "Fwd ", type: "Objc", value: point(x, y) },
			{ key: "Bwd ", type: "Objc", value: point(x, y) },
			{ key: "Smoo", type: "bool", value: Buffer.from([0]) },
		])
	);
	const boundaryPath = descriptorObject("pathClass", [
		{
			key: "pathComponents",
			type: "VlLs",
			value: descriptorList(
				descriptorObject("PaCm", [
					{ key: "shapeOperation", type: "enum", value: descriptorEnum("shapeOperation", "xor") },
					{
						key: "SbpL",
						type: "VlLs",
						value: descriptorList(
							descriptorObject("Sbpl", [
								{ key: "Clsp", type: "bool", value: Buffer.from([1]) },
								{ key: "Pts ", type: "VlLs", value: descriptorList(...boundaryPoints) },
							])
						),
					},
				])
			),
		},
	]);
	const shapeEntries: Array<{ key: string; type: string; value: Buffer }> = [
		{ key: "rigidType", type: "bool", value: Buffer.from([0]) },
		{ key: "VrsM", type: "long", value: i32(1) },
		{ key: "VrsN", type: "long", value: i32(0) },
		{ key: "originalVertexArray", type: "tdta", value: descriptorBytes(Buffer.concat(originalVertices.flatMap(({ x, y }) => [f32le(x), f32le(y)]))) },
		{ key: "deformedVertexArray", type: "tdta", value: descriptorBytes(Buffer.concat(deformedVertices.flatMap(({ x, y }) => [f32le(x), f32le(y)]))) },
		{ key: "indexArray", type: "tdta", value: descriptorBytes(Buffer.concat(triangleIndices.map(u32le))) },
		{ key: "pinOffsets", type: "VlLs", value: descriptorDoubleList(0, 0, -2, -1) },
		{ key: "posFinalPins", type: "VlLs", value: descriptorDoubleList(0, 0, 6, 5) },
		{ key: "pinVertexIndices", type: "VlLs", value: descriptorDoubleList(...pinVertexIndices) },
		{ key: "PinP", type: "VlLs", value: descriptorDoubleList(0, 0, 8, 6) },
		{ key: "PnRt", type: "VlLs", value: descriptorDoubleList(0, 15) },
		{ key: "PnOv", type: "VlLs", value: descriptorBooleanList(false, true) },
		{ key: "PnDp", type: "VlLs", value: descriptorDoubleList(0, 1) },
		{ key: "meshQuality", type: "doub", value: f64(2) },
		{ key: "meshExpansion", type: "doub", value: f64(0) },
		{ key: "meshRigidity", type: "doub", value: f64(1) },
		{ key: "imageResolution", type: "doub", value: f64(72) },
		...(options.omitBoundaryPath ? [] : [{ key: "meshBoundaryPath", type: "Objc", value: boundaryPath }]),
		{ key: "selectedPin", type: "VlLs", value: descriptorDoubleList(1) },
	];
	return descriptorObject("rigidTransform", [
		{ key: "rigidType", type: "bool", value: Buffer.from([0]) },
		{ key: "puppetShapeList", type: "VlLs", value: descriptorList(descriptorObject("puppetShape", shapeEntries)) },
		...originalVertices.slice(0, 4).map((pointValue, index) => ({ key: `PuX${index}`, type: "doub", value: f64(pointValue.x) })),
		...originalVertices.slice(0, 4).map((pointValue, index) => ({ key: `PuY${index}`, type: "doub", value: f64(pointValue.y) })),
	]);
}

function oilPaintFilterDescriptor(options: {
	variant?: "modern" | "legacyPlugin";
	lightingOn?: boolean;
	stylization?: number;
	cleanliness?: number;
	brushScale?: number;
	bristleDetail?: number;
	lightDirection?: number;
	shine?: number;
	omitControl?: "lightingOn" | "stylization" | "cleanliness" | "brushScale" | "microBrush" | "LghD" | "specularity";
	lightingAsLong?: boolean;
	unknownKey?: boolean;
}): Buffer {
	const values = {
		Stylization: options.stylization ?? 6.5,
		Cleanliness: options.cleanliness ?? 4,
		Scale: options.brushScale ?? 7,
		"Bristle Detail": options.bristleDetail ?? 3.5,
		Angle: options.lightDirection ?? 135,
		Shine: options.shine ?? 5,
	};
	if (options.variant === "legacyPlugin") {
		const omittedLegacyName =
			options.omitControl === "stylization"
				? "Stylization"
				: options.omitControl === "cleanliness"
					? "Cleanliness"
					: options.omitControl === "brushScale"
						? "Scale"
						: options.omitControl === "microBrush"
							? "Bristle Detail"
							: options.omitControl === "LghD"
								? "Angle"
								: options.omitControl === "specularity"
									? "Shine"
									: null;
		const parameters = Object.entries(values).filter(([name]) => name !== omittedLegacyName);
		return descriptorObject("PbPl", [
			{ key: "KnNm", type: "TEXT", value: descriptorUnicode("Oil Paint Plugin") },
			{ key: "GpuY", type: "bool", value: Buffer.from([1]) },
			{ key: "LIWy", type: "bool", value: Buffer.from([options.lightingOn === false ? 0 : 1]) },
			{ key: "FPth", type: "TEXT", value: descriptorUnicode("1") },
			...parameters.flatMap(([name, value], index) => {
				const suffix = `a${String.fromCharCode(97 + index)}`;
				return [
					{ key: `PN${suffix}`, type: "TEXT", value: descriptorUnicode(name) },
					{ key: `PT${suffix}`, type: "long", value: i32(0) },
					{ key: `PF${suffix}`, type: "doub", value: f64(value) },
				];
			}),
			...(options.unknownKey ? [{ key: "futureOil", type: "doub", value: f64(1) }] : []),
		]);
	}
	const controls = [
		options.lightingAsLong
			? { key: "lightingOn", type: "long", value: i32(options.lightingOn === false ? 0 : 1) }
			: { key: "lightingOn", type: "bool", value: Buffer.from([options.lightingOn === false ? 0 : 1]) },
		{ key: "stylization", type: "doub", value: f64(values.Stylization) },
		{ key: "cleanliness", type: "doub", value: f64(values.Cleanliness) },
		{ key: "brushScale", type: "doub", value: f64(values.Scale) },
		{ key: "microBrush", type: "doub", value: f64(values["Bristle Detail"]) },
		{ key: "LghD", type: "doub", value: f64(values.Angle) },
		{ key: "specularity", type: "doub", value: f64(values.Shine) },
	].filter((entry) => entry.key !== options.omitControl);
	return descriptorObject("oilPaint", [...controls, ...(options.unknownKey ? [{ key: "futureOil", type: "doub", value: f64(1) }] : [])]);
}

function liquifyMesh(options: {
	version: 2 | 3;
	meshWidth: number;
	meshHeight: number;
	imageWidth?: number;
	imageHeight?: number;
	displacements: Array<{ x: number; y: number }>;
	signature?: string;
	formatMarker?: number;
	repeatedImageWidth?: number;
	repeatedImageHeight?: number;
	trailingBytes?: Buffer;
}): Buffer {
	if (options.displacements.length !== options.meshWidth * options.meshHeight) {
		throw new Error("Liquify test mesh displacement count mismatch.");
	}
	const header = [
		u32(options.version),
		Buffer.from(options.signature ?? "yfqLhseM", "ascii"),
		u32le(options.formatMarker ?? 2),
		u32le(options.meshWidth),
		u32le(options.meshHeight),
	];
	if (options.version === 2) {
		return Buffer.concat([...header, ...options.displacements.flatMap(({ x, y }) => [f32le(x), f32le(y)]), options.trailingBytes ?? Buffer.alloc(0)]);
	}
	const imageWidth = options.imageWidth ?? options.meshWidth * 4;
	const imageHeight = options.imageHeight ?? options.meshHeight * 4;
	header.push(
		u32le(0),
		u32le(0),
		u32le(0),
		u32le(0),
		u32le(imageHeight),
		u32le(imageWidth),
		u32le(0),
		u32le(0),
		u32le(options.repeatedImageHeight ?? imageHeight),
		u32le(options.repeatedImageWidth ?? imageWidth)
	);
	const rows: Buffer[] = [];
	for (let row = 0; row < options.meshHeight; ++row) {
		let column = 0;
		while (column < options.meshWidth) {
			let zeroRun = 0;
			while (column + zeroRun < options.meshWidth) {
				const displacement = options.displacements[row * options.meshWidth + column + zeroRun];
				if (displacement.x !== 0 || displacement.y !== 0) break;
				++zeroRun;
			}
			rows.push(u32le(zeroRun));
			column += zeroRun;
			if (column === options.meshWidth) break;
			let valueRun = 0;
			while (column + valueRun < options.meshWidth) {
				const displacement = options.displacements[row * options.meshWidth + column + valueRun];
				if (displacement.x === 0 && displacement.y === 0) break;
				++valueRun;
			}
			rows.push(u32le(valueRun));
			for (let index = 0; index < valueRun; ++index) {
				const displacement = options.displacements[row * options.meshWidth + column + index];
				rows.push(f32le(displacement.x), f32le(displacement.y));
			}
			column += valueRun;
		}
	}
	return Buffer.concat([...header, ...rows, options.trailingBytes ?? Buffer.alloc(0)]);
}

function liquifyFilterDescriptor(options: { mesh: Buffer; entryType?: "tdta" | "TEXT"; duplicateMesh?: boolean; unknownKey?: boolean }): Buffer {
	const entry = {
		key: "LqMe",
		type: options.entryType ?? "tdta",
		value: options.entryType === "TEXT" ? descriptorUnicode(options.mesh.toString("hex")) : descriptorBytes(options.mesh),
	};
	return descriptorObject("LqFy", [entry, ...(options.duplicateMesh ? [entry] : []), ...(options.unknownKey ? [{ key: "futureLiquify", type: "long", value: i32(1) }] : [])]);
}

function displaceFilterDescriptor(
	options: {
		horizontalScale?: number;
		verticalScale?: number;
		displacementMap?: "stretchToFit" | "tile" | "unsupported";
		undefinedAreas?: "wrapAround" | "repeatEdgePixels" | "unsupported";
		signature?: string;
		path?: string;
		horizontalAsDouble?: boolean;
		pathEntryType?: "Pth " | "TEXT";
		pathLengthDelta?: number;
		omitPath?: boolean;
		duplicatePath?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const pathEntry = {
		key: "DspF",
		type: options.pathEntryType ?? "Pth ",
		value:
			options.pathEntryType === "TEXT"
				? descriptorUnicode(options.path ?? "/stored/not-followed/displace.psd")
				: descriptorPath(options.signature ?? "Pth ", options.path ?? "/stored/not-followed/displace.psd", options.pathLengthDelta),
	};
	return descriptorObject("Dspl", [
		options.horizontalAsDouble
			? { key: "HrzS", type: "doub", value: f64(options.horizontalScale ?? 12.5) }
			: { key: "HrzS", type: "long", value: i32(options.horizontalScale ?? 12) },
		{ key: "VrtS", type: "long", value: i32(options.verticalScale ?? -8) },
		{
			key: "DspM",
			type: "enum",
			value: descriptorEnum("DspM", ({ stretchToFit: "StrF", tile: "Tile", unsupported: "Nope" } as const)[options.displacementMap ?? "stretchToFit"]),
		},
		{
			key: "UndA",
			type: "enum",
			value: descriptorEnum("UndA", ({ wrapAround: "WrpA", repeatEdgePixels: "RptE", unsupported: "Nope" } as const)[options.undefinedAreas ?? "repeatEdgePixels"]),
		},
		...(options.omitPath ? [] : [pathEntry]),
		...(options.duplicatePath ? [pathEntry] : []),
		...(options.unknownKey ? [{ key: "futureDisplace", type: "long", value: i32(1) }] : []),
	]);
}

function pinchFilterDescriptor(options: { amount?: number; amountAsDouble?: boolean; omitAmount?: boolean; duplicateAmount?: boolean; unknownKey?: boolean } = {}): Buffer {
	const amountEntry = options.amountAsDouble
		? { key: "Amnt", type: "doub", value: f64(options.amount ?? 65.5) }
		: { key: "Amnt", type: "long", value: i32(options.amount ?? 65) };
	return descriptorObject("Pnch", [
		...(options.omitAmount ? [] : [amountEntry]),
		...(options.duplicateAmount ? [amountEntry] : []),
		...(options.unknownKey ? [{ key: "futurePinch", type: "long", value: i32(1) }] : []),
	]);
}

function polarCoordinatesFilterDescriptor(
	options: {
		conversion?: "rectangularToPolar" | "polarToRectangular" | "unsupported";
		entryType?: "enum" | "TEXT";
		enumType?: string;
		omitConversion?: boolean;
		duplicateConversion?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const conversion = ({ rectangularToPolar: "RctP", polarToRectangular: "PlrR", unsupported: "Nope" } as const)[options.conversion ?? "rectangularToPolar"];
	const conversionEntry = {
		key: "Cnvr",
		type: options.entryType ?? "enum",
		value: options.entryType === "TEXT" ? descriptorUnicode(conversion) : descriptorEnum(options.enumType ?? "Cnvr", conversion),
	};
	return descriptorObject("Plr ", [
		...(options.omitConversion ? [] : [conversionEntry]),
		...(options.duplicateConversion ? [conversionEntry] : []),
		...(options.unknownKey ? [{ key: "futurePolarCoordinates", type: "long", value: i32(1) }] : []),
	]);
}

function rippleFilterDescriptor(
	options: {
		amount?: number;
		amountAsDouble?: boolean;
		size?: "small" | "medium" | "large" | "unsupported";
		sizeEntryType?: "enum" | "TEXT";
		sizeEnumType?: string;
		omitAmount?: boolean;
		omitSize?: boolean;
		duplicateAmount?: boolean;
		duplicateSize?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const amountEntry = options.amountAsDouble
		? { key: "Amnt", type: "doub", value: f64(options.amount ?? 240.5) }
		: { key: "Amnt", type: "long", value: i32(options.amount ?? 240) };
	const size = ({ small: "Sml ", medium: "Mdm ", large: "Lrg ", unsupported: "Nope" } as const)[options.size ?? "medium"];
	const sizeEntry = {
		key: "RplS",
		type: options.sizeEntryType ?? "enum",
		value: options.sizeEntryType === "TEXT" ? descriptorUnicode(size) : descriptorEnum(options.sizeEnumType ?? "RplS", size),
	};
	return descriptorObject("Rple", [
		...(options.omitAmount ? [] : [amountEntry]),
		...(options.duplicateAmount ? [amountEntry] : []),
		...(options.omitSize ? [] : [sizeEntry]),
		...(options.duplicateSize ? [sizeEntry] : []),
		...(options.unknownKey ? [{ key: "futureRipple", type: "long", value: i32(1) }] : []),
	]);
}

function shearFilterDescriptor(
	options: {
		points?: Array<{ x: number; y: number }>;
		pointsEntryType?: "VlLs" | "TEXT";
		undefinedAreas?: "wrapAround" | "repeatEdgePixels" | "unsupported";
		undefinedAreaEntryType?: "enum" | "TEXT";
		undefinedAreaEnumType?: string;
		startIndex?: number;
		endIndex?: number;
		startAsDouble?: boolean;
		endAsDouble?: boolean;
		pointClassId?: string;
		pointHorizontalAsLong?: boolean;
		pointMissingVertical?: boolean;
		pointDuplicateHorizontal?: boolean;
		pointUnknownKey?: boolean;
		omitPoints?: boolean;
		omitUndefinedAreas?: boolean;
		omitStart?: boolean;
		omitEnd?: boolean;
		duplicatePoints?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const points = options.points ?? [
		{ x: 0, y: 0 },
		{ x: 18, y: 42 },
		{ x: -12, y: 86 },
		{ x: 6, y: 128 },
	];
	const pointValues = points.map((point) => {
		const horizontalEntry = {
			key: "Hrzn",
			type: options.pointHorizontalAsLong ? "long" : "doub",
			value: options.pointHorizontalAsLong ? i32(point.x) : f64(point.x),
		};
		return descriptorObject(options.pointClassId ?? "Pnt ", [
			horizontalEntry,
			...(options.pointDuplicateHorizontal ? [horizontalEntry] : []),
			...(options.pointMissingVertical ? [] : [{ key: "Vrtc", type: "doub", value: f64(point.y) }]),
			...(options.pointUnknownKey ? [{ key: "futurePoint", type: "long", value: i32(1) }] : []),
		]);
	});
	const pointsEntry = {
		key: "ShrP",
		type: options.pointsEntryType ?? "VlLs",
		value: options.pointsEntryType === "TEXT" ? descriptorUnicode("invalid") : descriptorList(...pointValues),
	};
	const undefinedArea = ({ wrapAround: "WrpA", repeatEdgePixels: "RptE", unsupported: "Nope" } as const)[options.undefinedAreas ?? "wrapAround"];
	return descriptorObject("Shr ", [
		...(options.omitPoints ? [] : [pointsEntry]),
		...(options.duplicatePoints ? [pointsEntry] : []),
		...(options.omitUndefinedAreas
			? []
			: [
					{
						key: "UndA",
						type: options.undefinedAreaEntryType ?? "enum",
						value:
							options.undefinedAreaEntryType === "TEXT" ? descriptorUnicode(undefinedArea) : descriptorEnum(options.undefinedAreaEnumType ?? "UndA", undefinedArea),
					},
				]),
		...(options.omitStart
			? []
			: [
					{
						key: "ShrS",
						type: options.startAsDouble ? "doub" : "long",
						value: options.startAsDouble ? f64(options.startIndex ?? 0) : i32(options.startIndex ?? 0),
					},
				]),
		...(options.omitEnd
			? []
			: [
					{
						key: "ShrE",
						type: options.endAsDouble ? "doub" : "long",
						value: options.endAsDouble ? f64(options.endIndex ?? points.length - 1) : i32(options.endIndex ?? points.length - 1),
					},
				]),
		...(options.unknownKey ? [{ key: "futureShear", type: "long", value: i32(1) }] : []),
	]);
}

function spherizeFilterDescriptor(
	options: {
		amount?: number;
		amountAsDouble?: boolean;
		mode?: "normal" | "horizontalOnly" | "verticalOnly" | "unsupported";
		modeEntryType?: "enum" | "TEXT";
		modeEnumType?: string;
		omitAmount?: boolean;
		omitMode?: boolean;
		duplicateAmount?: boolean;
		duplicateMode?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const amountEntry = options.amountAsDouble
		? { key: "Amnt", type: "doub", value: f64(options.amount ?? 70.5) }
		: { key: "Amnt", type: "long", value: i32(options.amount ?? 70) };
	const mode = ({ normal: "Nrml", horizontalOnly: "HrzO", verticalOnly: "VrtO", unsupported: "Nope" } as const)[options.mode ?? "normal"];
	const modeEntry = {
		key: "SphM",
		type: options.modeEntryType ?? "enum",
		value: options.modeEntryType === "TEXT" ? descriptorUnicode(mode) : descriptorEnum(options.modeEnumType ?? "SphM", mode),
	};
	return descriptorObject("Sphr", [
		...(options.omitAmount ? [] : [amountEntry]),
		...(options.duplicateAmount ? [amountEntry] : []),
		...(options.omitMode ? [] : [modeEntry]),
		...(options.duplicateMode ? [modeEntry] : []),
		...(options.unknownKey ? [{ key: "futureSpherize", type: "long", value: i32(1) }] : []),
	]);
}

function twirlFilterDescriptor(options: { angle?: number; angleAsDouble?: boolean; omitAngle?: boolean; duplicateAngle?: boolean; unknownKey?: boolean } = {}): Buffer {
	const angleEntry = options.angleAsDouble ? { key: "Angl", type: "doub", value: f64(options.angle ?? 420.5) } : { key: "Angl", type: "long", value: i32(options.angle ?? 420) };
	return descriptorObject("Twrl", [
		...(options.omitAngle ? [] : [angleEntry]),
		...(options.duplicateAngle ? [angleEntry] : []),
		...(options.unknownKey ? [{ key: "futureTwirl", type: "long", value: i32(1) }] : []),
	]);
}

type WaveLongDescriptorKey = "NmbG" | "WLMn" | "WLMx" | "AmMn" | "AmMx" | "SclH" | "SclV" | "RndS";

function waveFilterDescriptor(
	options: {
		numberOfGenerators?: number;
		waveType?: "sine" | "triangle" | "square" | "unsupported";
		minimumWavelength?: number;
		maximumWavelength?: number;
		minimumAmplitude?: number;
		maximumAmplitude?: number;
		horizontalScale?: number;
		verticalScale?: number;
		randomSeed?: number;
		undefinedAreas?: "wrapAround" | "repeatEdgePixels" | "unsupported";
		longAsDouble?: WaveLongDescriptorKey;
		waveTypeEntryType?: "enum" | "TEXT";
		waveTypeEnumType?: string;
		undefinedAreaEntryType?: "enum" | "TEXT";
		undefinedAreaEnumType?: string;
		omitKey?: WaveLongDescriptorKey | "Wvtp" | "UndA";
		duplicateKey?: WaveLongDescriptorKey | "Wvtp" | "UndA";
		unknownKey?: boolean;
	} = {}
): Buffer {
	const values: Record<WaveLongDescriptorKey, number> = {
		NmbG: options.numberOfGenerators ?? 3,
		WLMn: options.minimumWavelength ?? 3,
		WLMx: options.maximumWavelength ?? 9,
		AmMn: options.minimumAmplitude ?? 1,
		AmMx: options.maximumAmplitude ?? 4,
		SclH: options.horizontalScale ?? 75,
		SclV: options.verticalScale ?? 55,
		RndS: options.randomSeed ?? 123456,
	};
	const longEntries = (Object.keys(values) as WaveLongDescriptorKey[]).map((key) => ({
		key,
		type: options.longAsDouble === key ? "doub" : "long",
		value: options.longAsDouble === key ? f64(values[key]) : i32(values[key]),
	}));
	const waveType = ({ sine: "WvSn", triangle: "WvTr", square: "WvSq", unsupported: "Nope" } as const)[options.waveType ?? "sine"];
	const waveTypeEntry = {
		key: "Wvtp",
		type: options.waveTypeEntryType ?? "enum",
		value: options.waveTypeEntryType === "TEXT" ? descriptorUnicode(waveType) : descriptorEnum(options.waveTypeEnumType ?? "Wvtp", waveType),
	};
	const undefinedArea = ({ wrapAround: "WrpA", repeatEdgePixels: "RptE", unsupported: "Nope" } as const)[options.undefinedAreas ?? "wrapAround"];
	const undefinedAreaEntry = {
		key: "UndA",
		type: options.undefinedAreaEntryType ?? "enum",
		value: options.undefinedAreaEntryType === "TEXT" ? descriptorUnicode(undefinedArea) : descriptorEnum(options.undefinedAreaEnumType ?? "UndA", undefinedArea),
	};
	const entries = [waveTypeEntry, ...longEntries, undefinedAreaEntry].filter((entry) => entry.key !== options.omitKey);
	const duplicate = [waveTypeEntry, ...longEntries, undefinedAreaEntry].find((entry) => entry.key === options.duplicateKey);
	return descriptorObject("Wave", [...entries, ...(duplicate ? [duplicate] : []), ...(options.unknownKey ? [{ key: "futureWave", type: "long", value: i32(1) }] : [])]);
}

function zigZagFilterDescriptor(
	options: {
		amount?: number;
		ridges?: number;
		style?: "aroundCenter" | "outFromCenter" | "pondRipples" | "unsupported";
		amountAsDouble?: boolean;
		ridgesAsDouble?: boolean;
		styleEntryType?: "enum" | "TEXT";
		styleEnumType?: string;
		omitAmount?: boolean;
		omitRidges?: boolean;
		omitStyle?: boolean;
		duplicateAmount?: boolean;
		duplicateRidges?: boolean;
		duplicateStyle?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const amountEntry = options.amountAsDouble
		? { key: "Amnt", type: "doub", value: f64(options.amount ?? 65.5) }
		: { key: "Amnt", type: "long", value: i32(options.amount ?? 65) };
	const ridgesEntry = options.ridgesAsDouble ? { key: "NmbR", type: "doub", value: f64(options.ridges ?? 5.5) } : { key: "NmbR", type: "long", value: i32(options.ridges ?? 5) };
	const style = ({ aroundCenter: "ArnC", outFromCenter: "OtFr", pondRipples: "PndR", unsupported: "Nope" } as const)[options.style ?? "aroundCenter"];
	const styleEntry = {
		key: "ZZTy",
		type: options.styleEntryType ?? "enum",
		value: options.styleEntryType === "TEXT" ? descriptorUnicode(style) : descriptorEnum(options.styleEnumType ?? "ZZTy", style),
	};
	return descriptorObject("ZgZg", [
		...(options.omitAmount ? [] : [amountEntry]),
		...(options.duplicateAmount ? [amountEntry] : []),
		...(options.omitRidges ? [] : [ridgesEntry]),
		...(options.duplicateRidges ? [ridgesEntry] : []),
		...(options.omitStyle ? [] : [styleEntry]),
		...(options.duplicateStyle ? [styleEntry] : []),
		...(options.unknownKey ? [{ key: "futureZigZag", type: "long", value: i32(1) }] : []),
	]);
}

function hsbHslFilterDescriptor(
	options: {
		inputMode?: "rgb" | "hsb" | "hsl" | "unsupported";
		rowOrder?: "rgb" | "hsb" | "hsl" | "unsupported";
		inputEntryType?: "enum" | "TEXT";
		rowOrderEntryType?: "enum" | "TEXT";
		inputEnumType?: string;
		rowOrderEnumType?: string;
		omitInput?: boolean;
		omitRowOrder?: boolean;
		duplicateInput?: boolean;
		duplicateRowOrder?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const values = { rgb: "RGBC", hsb: "HSBl", hsl: "HSLC", unsupported: "LbCl" } as const;
	const inputValue = values[options.inputMode ?? "rgb"];
	const rowOrderValue = values[options.rowOrder ?? "hsb"];
	const inputEntry = {
		key: "Inpt",
		type: options.inputEntryType ?? "enum",
		value: options.inputEntryType === "TEXT" ? descriptorUnicode(inputValue) : descriptorEnum(options.inputEnumType ?? "ClrS", inputValue),
	};
	const rowOrderEntry = {
		key: "Otpt",
		type: options.rowOrderEntryType ?? "enum",
		value: options.rowOrderEntryType === "TEXT" ? descriptorUnicode(rowOrderValue) : descriptorEnum(options.rowOrderEnumType ?? "ClrS", rowOrderValue),
	};
	return descriptorObject("HsbP", [
		...(options.omitInput ? [] : [inputEntry]),
		...(options.duplicateInput ? [inputEntry] : []),
		...(options.omitRowOrder ? [] : [rowOrderEntry]),
		...(options.duplicateRowOrder ? [rowOrderEntry] : []),
		...(options.unknownKey ? [{ key: "futureHsbHsl", type: "long", value: i32(1) }] : []),
	]);
}

function perspectiveWarpFilterDescriptor(
	options: {
		vertices?: Array<{ x: number; y: number }>;
		warpedVertices?: Array<{ x: number; y: number }>;
		quads?: number[][];
		descriptorClass?: string;
		pointClass?: string;
		quadClass?: string;
		units?: string;
		indicesAsDouble?: boolean;
		omitVertices?: boolean;
		omitWarpedVertices?: boolean;
		omitQuads?: boolean;
		duplicateVertices?: boolean;
		unknownKey?: boolean;
	} = {}
): Buffer {
	const vertices = options.vertices ?? [
		{ x: 1, y: 1 },
		{ x: 7, y: 1 },
		{ x: 7, y: 5 },
		{ x: 1, y: 5 },
	];
	const warpedVertices = options.warpedVertices ?? [
		{ x: 0.5, y: 1.5 },
		{ x: 7.5, y: 0.5 },
		{ x: 6.5, y: 5.5 },
		{ x: 1.5, y: 5 },
	];
	const pointList = (points: Array<{ x: number; y: number }>): Buffer =>
		descriptorList(
			...points.map((point) =>
				descriptorObject(options.pointClass ?? "Pnt ", [
					{ key: "Hrzn", type: "UntF", value: descriptorUnit(options.units ?? "#Pxl", point.x) },
					{ key: "Vrtc", type: "UntF", value: descriptorUnit(options.units ?? "#Pxl", point.y) },
				])
			)
		);
	const verticesEntry = { key: "vertices", type: "VlLs", value: pointList(vertices) };
	const warpedVerticesEntry = { key: "warpedVertices", type: "VlLs", value: pointList(warpedVertices) };
	const quads = options.quads ?? [[0, 1, 2, 3]];
	const indices = (values: number[]): Buffer =>
		options.indicesAsDouble ? Buffer.concat([i32(values.length), ...values.map((value) => Buffer.concat([Buffer.from("doub"), f64(value)]))]) : descriptorLongList(...values);
	const quadsEntry = {
		key: "quads",
		type: "VlLs",
		value: descriptorList(...quads.map((quad) => descriptorObject(options.quadClass ?? "null", [{ key: "indices", type: "VlLs", value: indices(quad) }]))),
	};
	return descriptorObject(options.descriptorClass ?? "perspectiveWarpTransform", [
		...(options.omitVertices ? [] : [verticesEntry]),
		...(options.duplicateVertices ? [verticesEntry] : []),
		...(options.omitWarpedVertices ? [] : [warpedVerticesEntry]),
		...(options.omitQuads ? [] : [quadsEntry]),
		...(options.unknownKey ? [{ key: "futurePerspectiveWarp", type: "long", value: i32(1) }] : []),
	]);
}

type CurvesFilterDescriptorOptions = {
	presetKind?: "custom" | "default" | "unsupported";
	adjustments?: Array<{
		channels: Array<"composite" | "red" | "green" | "blue" | "unsupported">;
		mode: "curve" | "mapping" | "missing" | "both";
		points?: Array<{ input: number; output: number; curved?: boolean }>;
		values?: number[];
		classId?: string;
		channelEnumType?: string;
		channelsAsLong?: boolean;
		mappingAsDouble?: boolean;
		unknownKey?: boolean;
	}>;
	descriptorClass?: string;
	presetEntryType?: "enum" | "TEXT";
	presetEnumType?: string;
	omitPreset?: boolean;
	duplicatePreset?: boolean;
	omitAdjustments?: boolean;
	pointClass?: string;
	pointHorizontalAsLong?: boolean;
	pointOmitVertical?: boolean;
	pointDuplicateHorizontal?: boolean;
	pointUnknownKey?: boolean;
	unknownKey?: boolean;
};

function curvesFilterDescriptor(options: CurvesFilterDescriptorOptions = {}): Buffer {
	const adjustments: NonNullable<CurvesFilterDescriptorOptions["adjustments"]> = options.adjustments ?? [
		{
			channels: ["composite" as const],
			mode: "curve" as const,
			points: [
				{ input: 0, output: 0 },
				{ input: 64, output: 48, curved: true },
				{ input: 128, output: 176, curved: true },
				{ input: 255, output: 255 },
			],
		},
		{
			channels: ["red" as const],
			mode: "curve" as const,
			points: [
				{ input: 0, output: 12 },
				{ input: 96, output: 112 },
				{ input: 255, output: 244 },
			],
		},
		{ channels: ["green" as const, "blue" as const], mode: "mapping" as const, values: Array.from({ length: 256 }, (_, value) => 255 - value) },
	];
	const channelTokens = { composite: "Cmps", red: "Rd  ", green: "Grn ", blue: "Bl  ", unsupported: "Nope" } as const;
	const channelList = (adjustment: (typeof adjustments)[number]): Buffer =>
		adjustment.channelsAsLong
			? descriptorLongList(...adjustment.channels.map((_, index) => index))
			: Buffer.concat([
					i32(adjustment.channels.length),
					...adjustment.channels.map((channel) => Buffer.concat([Buffer.from("enum"), descriptorEnum(adjustment.channelEnumType ?? "Chnl", channelTokens[channel])])),
				]);
	const pointList = (points: Array<{ input: number; output: number; curved?: boolean }>): Buffer =>
		descriptorList(
			...points.map((point, index) =>
				descriptorObject(options.pointClass ?? "Pnt ", [
					options.pointHorizontalAsLong && index === 0 ? { key: "Hrzn", type: "long", value: i32(point.input) } : { key: "Hrzn", type: "doub", value: f64(point.input) },
					...(options.pointDuplicateHorizontal && index === 0 ? [{ key: "Hrzn", type: "doub", value: f64(point.input) }] : []),
					...(options.pointOmitVertical && index === 0 ? [] : [{ key: "Vrtc", type: "doub", value: f64(point.output) }]),
					...(point.curved === undefined ? [] : [{ key: "Cnty", type: "bool", value: Buffer.from([point.curved ? 1 : 0]) }]),
					...(options.pointUnknownKey && index === 0 ? [{ key: "futureCurvePoint", type: "long", value: i32(1) }] : []),
				])
			)
		);
	const adjustmentList = descriptorList(
		...adjustments.map((adjustment) => {
			const points = adjustment.points ?? [
				{ input: 0, output: 0 },
				{ input: 255, output: 255 },
			];
			const values = adjustment.values ?? Array.from({ length: 256 }, (_, value) => value);
			const mapping = adjustment.mappingAsDouble ? descriptorDoubleList(...values) : descriptorLongList(...values);
			return descriptorObject(adjustment.classId ?? "CrvA", [
				{ key: "Chnl", type: "VlLs", value: channelList(adjustment) },
				...(adjustment.mode === "curve" || adjustment.mode === "both" ? [{ key: "Crv ", type: "VlLs", value: pointList(points) }] : []),
				...(adjustment.mode === "mapping" || adjustment.mode === "both" ? [{ key: "Mpng", type: "VlLs", value: mapping }] : []),
				...(adjustment.unknownKey ? [{ key: "futureCurveAdjustment", type: "long", value: i32(1) }] : []),
			]);
		})
	);
	const presetToken = ({ custom: "presetKindCustom", default: "presetKindDefault", unsupported: "Nope" } as const)[options.presetKind ?? "custom"];
	const presetEntry = {
		key: "presetKind",
		type: options.presetEntryType ?? "enum",
		value: options.presetEntryType === "TEXT" ? descriptorUnicode(presetToken) : descriptorEnum(options.presetEnumType ?? "presetKindType", presetToken),
	};
	return descriptorObject(options.descriptorClass ?? "Crvs", [
		...(options.omitPreset ? [] : [presetEntry]),
		...(options.duplicatePreset ? [presetEntry] : []),
		...(options.omitAdjustments ? [] : [{ key: "Adjs", type: "VlLs", value: adjustmentList }]),
		...(options.unknownKey ? [{ key: "futureCurves", type: "long", value: i32(1) }] : []),
	]);
}

type BrightnessContrastFilterDescriptorOptions = {
	brightness?: number;
	contrast?: number;
	useLegacy?: boolean;
	descriptorClass?: string;
	brightnessEntryType?: "long" | "doub";
	contrastEntryType?: "long" | "doub";
	legacyEntryType?: "bool" | "long";
	omitBrightness?: boolean;
	omitContrast?: boolean;
	omitLegacy?: boolean;
	duplicateBrightness?: boolean;
	duplicateContrast?: boolean;
	duplicateLegacy?: boolean;
	unknownKey?: boolean;
};

function brightnessContrastFilterDescriptor(options: BrightnessContrastFilterDescriptorOptions = {}): Buffer {
	const numericEntry = (key: "Brgh" | "Cntr", value: number, type: "long" | "doub") => ({
		key,
		type,
		value: type === "long" ? i32(value) : f64(value),
	});
	const brightnessEntry = numericEntry("Brgh", options.brightness ?? 42, options.brightnessEntryType ?? "long");
	const contrastEntry = numericEntry("Cntr", options.contrast ?? 65, options.contrastEntryType ?? "long");
	const legacyEntry = {
		key: "useLegacy",
		type: options.legacyEntryType ?? "bool",
		value: options.legacyEntryType === "long" ? i32(options.useLegacy ? 1 : 0) : Buffer.from([options.useLegacy ? 1 : 0]),
	};
	return descriptorObject(options.descriptorClass ?? "BrgC", [
		...(options.omitBrightness ? [] : [brightnessEntry]),
		...(options.duplicateBrightness ? [brightnessEntry] : []),
		...(options.omitContrast ? [] : [contrastEntry]),
		...(options.duplicateContrast ? [contrastEntry] : []),
		...(options.omitLegacy ? [] : [legacyEntry]),
		...(options.duplicateLegacy ? [legacyEntry] : []),
		...(options.unknownKey ? [{ key: "futureBrightnessContrast", type: "long", value: i32(1) }] : []),
	]);
}

function smartObjectLayer(
	options: {
		resourceId?: string;
		placedId?: string;
		transform?: [number, number, number, number, number, number, number, number];
		nonAffineTransform?: [number, number, number, number, number, number, number, number] | null;
		warpStyle?: string;
		warpValue?: number;
		warpPerspective?: number;
		warpPerspectiveOther?: number;
		warpRotate?: "horizontal" | "vertical" | "unknown";
		filterCount?: number;
		customMesh?: Array<{ x: number; y: number }>;
		uOrder?: number;
		vOrder?: number;
		deformNumRows?: number;
		deformNumCols?: number;
		quiltSliceX?: number[];
		quiltSliceY?: number[];
		smartFilterStackEnabled?: boolean;
		smartFilterMaskEnabled?: boolean;
		smartFilterMaskLinked?: boolean;
		smartFilterMaskExtendWithWhite?: boolean;
		smartFilters?: Array<{
			type:
				| "addNoise"
				| "average"
				| "blur"
				| "blurMore"
				| "boxBlur"
				| "colorHalftone"
				| "clouds"
				| "crystallize"
				| "curves"
				| "brightnessContrast"
				| "customConvolution"
				| "differenceClouds"
				| "displace"
				| "deInterlace"
				| "diffuse"
				| "emboss"
				| "extrude"
				| "fibers"
				| "despeckle"
				| "dustAndScratches"
				| "facet"
				| "findEdges"
				| "fragment"
				| "gaussianBlur"
				| "highPass"
				| "hsbHsl"
				| "invert"
				| "lensFlare"
				| "liquify"
				| "maximum"
				| "mezzotint"
				| "median"
				| "minimum"
				| "motionBlur"
				| "mosaic"
				| "ntscColors"
				| "offset"
				| "oilPaint"
				| "perspectiveWarp"
				| "pinch"
				| "polarCoordinates"
				| "pointillize"
				| "puppetWarp"
				| "ripple"
				| "shear"
				| "spherize"
				| "twirl"
				| "wave"
				| "zigzag"
				| "radialBlur"
				| "reduceNoise"
				| "sharpen"
				| "sharpenEdges"
				| "sharpenMore"
				| "solarize"
				| "shapeBlur"
				| "smartBlur"
				| "smartSharpen"
				| "unsharpMask"
				| "surfaceBlur"
				| "tiles"
				| "traceContour"
				| "wind"
				| "unsupported";
			name?: string;
			filterIdOverride?: number;
			enabled?: boolean;
			opacity?: number;
			blendMode?: string;
			radius?: number;
			radiusUnits?: string;
			angleDegrees?: number;
			height?: number;
			depth?: number;
			extrudeType?: "blocks" | "pyramids" | "unsupported";
			extrudeDepthMode?: "random" | "levelBased" | "unsupported";
			solidFrontFaces?: boolean;
			maskIncompleteBlocks?: boolean;
			numberOfTiles?: number;
			maximumOffset?: number;
			tilesFill?: "backgroundColor" | "foregroundColor" | "inverseImage" | "unalteredImage" | "unsupported";
			level?: number;
			levelAsDouble?: boolean;
			traceContourEdge?: "lower" | "upper" | "unsupported";
			windMethod?: "wind" | "blast" | "stagger" | "unsupported";
			windDirection?: "left" | "right" | "unsupported";
			deInterlaceEliminate?: "oddLines" | "evenLines" | "unsupported";
			deInterlaceNewFieldsBy?: "duplication" | "interpolation" | "unsupported";
			customScale?: number;
			customOffset?: number;
			customMatrix?: number[];
			customScaleAsDouble?: boolean;
			customOffsetAsDouble?: boolean;
			customMatrixAsDouble?: boolean;
			offsetHorizontal?: number;
			offsetVertical?: number;
			offsetUndefinedAreas?: "setToTransparent" | "repeatEdgePixels" | "wrapAround" | "unsupported";
			offsetHorizontalAsDouble?: boolean;
			offsetVerticalAsDouble?: boolean;
			displaceHorizontalScale?: number;
			displaceVerticalScale?: number;
			displacementMap?: "stretchToFit" | "tile" | "unsupported";
			displaceUndefinedAreas?: "wrapAround" | "repeatEdgePixels" | "unsupported";
			displaceSignature?: string;
			displacePath?: string;
			displaceHorizontalAsDouble?: boolean;
			displacePathEntryType?: "Pth " | "TEXT";
			displacePathLengthDelta?: number;
			displaceOmitPath?: boolean;
			displaceDuplicatePath?: boolean;
			displaceUnknownKey?: boolean;
			pinchAmount?: number;
			pinchAmountAsDouble?: boolean;
			pinchOmitAmount?: boolean;
			pinchDuplicateAmount?: boolean;
			pinchUnknownKey?: boolean;
			polarConversion?: "rectangularToPolar" | "polarToRectangular" | "unsupported";
			polarConversionEntryType?: "enum" | "TEXT";
			polarEnumType?: string;
			polarOmitConversion?: boolean;
			polarDuplicateConversion?: boolean;
			polarUnknownKey?: boolean;
			rippleAmount?: number;
			rippleAmountAsDouble?: boolean;
			rippleSize?: "small" | "medium" | "large" | "unsupported";
			rippleSizeEntryType?: "enum" | "TEXT";
			rippleSizeEnumType?: string;
			rippleOmitAmount?: boolean;
			rippleOmitSize?: boolean;
			rippleDuplicateAmount?: boolean;
			rippleDuplicateSize?: boolean;
			rippleUnknownKey?: boolean;
			shearPoints?: Array<{ x: number; y: number }>;
			shearPointsEntryType?: "VlLs" | "TEXT";
			shearUndefinedAreas?: "wrapAround" | "repeatEdgePixels" | "unsupported";
			shearUndefinedAreaEntryType?: "enum" | "TEXT";
			shearUndefinedAreaEnumType?: string;
			shearStartIndex?: number;
			shearEndIndex?: number;
			shearStartAsDouble?: boolean;
			shearEndAsDouble?: boolean;
			shearPointClassId?: string;
			shearPointHorizontalAsLong?: boolean;
			shearPointMissingVertical?: boolean;
			shearPointDuplicateHorizontal?: boolean;
			shearPointUnknownKey?: boolean;
			shearOmitPoints?: boolean;
			shearOmitUndefinedAreas?: boolean;
			shearOmitStart?: boolean;
			shearOmitEnd?: boolean;
			shearDuplicatePoints?: boolean;
			shearUnknownKey?: boolean;
			spherizeAmount?: number;
			spherizeAmountAsDouble?: boolean;
			spherizeMode?: "normal" | "horizontalOnly" | "verticalOnly" | "unsupported";
			spherizeModeEntryType?: "enum" | "TEXT";
			spherizeModeEnumType?: string;
			spherizeOmitAmount?: boolean;
			spherizeOmitMode?: boolean;
			spherizeDuplicateAmount?: boolean;
			spherizeDuplicateMode?: boolean;
			spherizeUnknownKey?: boolean;
			twirlAngle?: number;
			twirlAngleAsDouble?: boolean;
			twirlOmitAngle?: boolean;
			twirlDuplicateAngle?: boolean;
			twirlUnknownKey?: boolean;
			waveNumberOfGenerators?: number;
			waveType?: "sine" | "triangle" | "square" | "unsupported";
			waveMinimumWavelength?: number;
			waveMaximumWavelength?: number;
			waveMinimumAmplitude?: number;
			waveMaximumAmplitude?: number;
			waveHorizontalScale?: number;
			waveVerticalScale?: number;
			waveRandomSeed?: number;
			waveUndefinedAreas?: "wrapAround" | "repeatEdgePixels" | "unsupported";
			waveLongAsDouble?: WaveLongDescriptorKey;
			waveTypeEntryType?: "enum" | "TEXT";
			waveTypeEnumType?: string;
			waveUndefinedAreaEntryType?: "enum" | "TEXT";
			waveUndefinedAreaEnumType?: string;
			waveOmitKey?: WaveLongDescriptorKey | "Wvtp" | "UndA";
			waveDuplicateKey?: WaveLongDescriptorKey | "Wvtp" | "UndA";
			waveUnknownKey?: boolean;
			zigZagAmount?: number;
			zigZagRidges?: number;
			zigZagStyle?: "aroundCenter" | "outFromCenter" | "pondRipples" | "unsupported";
			zigZagAmountAsDouble?: boolean;
			zigZagRidgesAsDouble?: boolean;
			zigZagStyleEntryType?: "enum" | "TEXT";
			zigZagStyleEnumType?: string;
			zigZagOmitAmount?: boolean;
			zigZagOmitRidges?: boolean;
			zigZagOmitStyle?: boolean;
			zigZagDuplicateAmount?: boolean;
			zigZagDuplicateRidges?: boolean;
			zigZagDuplicateStyle?: boolean;
			zigZagUnknownKey?: boolean;
			hsbHslInputMode?: "rgb" | "hsb" | "hsl" | "unsupported";
			hsbHslRowOrder?: "rgb" | "hsb" | "hsl" | "unsupported";
			hsbHslInputEntryType?: "enum" | "TEXT";
			hsbHslRowOrderEntryType?: "enum" | "TEXT";
			hsbHslInputEnumType?: string;
			hsbHslRowOrderEnumType?: string;
			hsbHslOmitInput?: boolean;
			hsbHslOmitRowOrder?: boolean;
			hsbHslDuplicateInput?: boolean;
			hsbHslDuplicateRowOrder?: boolean;
			hsbHslUnknownKey?: boolean;
			perspectiveWarpVertices?: Array<{ x: number; y: number }>;
			perspectiveWarpWarpedVertices?: Array<{ x: number; y: number }>;
			perspectiveWarpQuads?: number[][];
			perspectiveWarpDescriptorClass?: string;
			perspectiveWarpPointClass?: string;
			perspectiveWarpQuadClass?: string;
			perspectiveWarpUnits?: string;
			perspectiveWarpIndicesAsDouble?: boolean;
			perspectiveWarpOmitVertices?: boolean;
			perspectiveWarpOmitWarpedVertices?: boolean;
			perspectiveWarpOmitQuads?: boolean;
			perspectiveWarpDuplicateVertices?: boolean;
			perspectiveWarpUnknownKey?: boolean;
			curvesDescriptor?: CurvesFilterDescriptorOptions;
			brightnessContrastDescriptor?: BrightnessContrastFilterDescriptorOptions;
			oilPaintVariant?: "modern" | "legacyPlugin";
			oilPaintLightingOn?: boolean;
			oilPaintStylization?: number;
			oilPaintCleanliness?: number;
			oilPaintBrushScale?: number;
			oilPaintBristleDetail?: number;
			oilPaintLightDirection?: number;
			oilPaintShine?: number;
			oilPaintOmitControl?: "lightingOn" | "stylization" | "cleanliness" | "brushScale" | "microBrush" | "LghD" | "specularity";
			oilPaintLightingAsLong?: boolean;
			oilPaintUnknownKey?: boolean;
			puppetOriginalVertices?: Array<{ x: number; y: number }>;
			puppetDeformedVertices?: Array<{ x: number; y: number }>;
			puppetTriangleIndices?: number[];
			puppetPinVertexIndices?: number[];
			puppetOmitBoundaryPath?: boolean;
			omitSolidFrontFaces?: boolean;
			omitMaskIncompleteBlocks?: boolean;
			anglesDegrees?: [number, number, number, number];
			omitColorHalftoneAngle4?: boolean;
			distance?: number;
			distanceUnits?: string;
			amount?: number;
			amountUnits?: string;
			distribution?: "uniform" | "gaussian" | "unsupported";
			diffuseMode?: "normal" | "darkenOnly" | "lightenOnly" | "anisotropic" | "unsupported";
			monochromatic?: boolean;
			randomSeed?: number;
			variance?: number;
			strength?: number;
			brightness?: number;
			position?: { x: number; y: number };
			lensType?: "50-300mm zoom" | "32mm prime" | "105mm prime" | "movie prime" | "unsupported";
			liquifyMesh?: Buffer;
			liquifyMeshEntryType?: "tdta" | "TEXT";
			liquifyDuplicateMesh?: boolean;
			liquifyUnknownKey?: boolean;
			moreAccurate?: boolean;
			smartSharpenBlur?: "gaussianBlur" | "lensBlur" | "motionBlur" | "unsupported";
			shadow?: { fadeAmount: number; tonalWidth: number; radius: number };
			highlight?: { fadeAmount: number; tonalWidth: number; radius: number };
			omitRandomSeed?: boolean;
			method?: "spin" | "zoom" | "unsupported";
			quality?: "draft" | "good" | "best" | "low" | "medium" | "high" | "unsupported";
			threshold?: number;
			mode?: "normal" | "edgeOnly" | "overlayEdge" | "unsupported";
			customShapeName?: string;
			customShapeId?: string;
			cellSize?: number;
			cellSizeUnits?: string;
			mezzotintPattern?:
				| "fine dots"
				| "medium dots"
				| "grainy dots"
				| "coarse dots"
				| "short lines"
				| "medium lines"
				| "long lines"
				| "short strokes"
				| "medium strokes"
				| "long strokes"
				| "unsupported";
			preset?: string;
			removeJpegArtifact?: boolean;
			reduceColorNoise?: number;
			sharpenDetails?: number;
			channelDenoise?: Array<{
				channels: Array<"red" | "green" | "blue" | "composite">;
				amount: number;
				preserveDetails?: number;
			}>;
			channelReferenceType?: string;
			foregroundColor?: [number, number, number];
			backgroundColor?: [number, number, number];
			omitForegroundColor?: boolean;
			omitBackgroundColor?: boolean;
		}>;
	} = {}
): Buffer {
	const fraction = (numerator: number, denominator: number) =>
		descriptorObject("fractionClass", [
			{ key: "numerator", type: "long", value: i32(numerator) },
			{ key: "denominator", type: "long", value: i32(denominator) },
		]);
	const objectArray = (type: string, values: number[]): Buffer =>
		Buffer.concat([descriptorClassId(type), Buffer.from("UnFl"), Buffer.from("#Pxl"), i32(values.length), ...values.map(f64)]);
	const objectArrayDescriptor = (classId: string, fields: Array<{ type: string; values: number[] }>): Buffer =>
		Buffer.concat([i32(16), descriptorUnicode(""), descriptorClassId(classId), i32(fields.length), ...fields.map((field) => objectArray(field.type, field.values))]);
	const customEnvelope = options.customMesh
		? descriptorObject("customEnvelopeWarp", [
				{
					key: "meshPoints",
					type: "ObAr",
					value: objectArrayDescriptor("meshPoints", [
						{
							type: "Hrzn",
							values: options.customMesh.map((point) => point.x),
						},
						{
							type: "Vrtc",
							values: options.customMesh.map((point) => point.y),
						},
					]),
				},
				...(options.quiltSliceX
					? [
							{
								key: "quiltSliceX",
								type: "ObAr",
								value: objectArrayDescriptor("quiltSliceX", [{ type: "quiltSliceX", values: options.quiltSliceX }]),
							},
						]
					: []),
				...(options.quiltSliceY
					? [
							{
								key: "quiltSliceY",
								type: "ObAr",
								value: objectArrayDescriptor("quiltSliceY", [{ type: "quiltSliceY", values: options.quiltSliceY }]),
							},
						]
					: []),
			])
		: null;
	const warp = descriptorObject("warp", [
		{ key: "warpStyle", type: "enum", value: descriptorEnum("warpStyle", options.warpStyle ?? "warpNone") },
		{ key: "warpValue", type: "doub", value: f64(options.warpValue ?? 0) },
		{ key: "warpPerspective", type: "doub", value: f64(options.warpPerspective ?? 0) },
		{ key: "warpPerspectiveOther", type: "doub", value: f64(options.warpPerspectiveOther ?? 0) },
		{
			key: "warpRotate",
			type: "enum",
			value: descriptorEnum("Ornt", options.warpRotate === "vertical" ? "Vrtc" : options.warpRotate === "unknown" ? "Unknown" : "Hrzn"),
		},
		...(options.customMesh
			? [
					{ key: "uOrder", type: "long", value: i32(options.uOrder ?? 4) },
					{ key: "vOrder", type: "long", value: i32(options.vOrder ?? 4) },
					...(options.deformNumRows === undefined ? [] : [{ key: "deformNumRows", type: "long", value: i32(options.deformNumRows) }]),
					...(options.deformNumCols === undefined ? [] : [{ key: "deformNumCols", type: "long", value: i32(options.deformNumCols) }]),
					{ key: "customEnvelopeWarp", type: "Objc", value: customEnvelope! },
				]
			: []),
	]);
	const size = descriptorObject("Pnt ", [
		{ key: "Wdth", type: "doub", value: f64(64) },
		{ key: "Hght", type: "doub", value: f64(32) },
	]);
	const compInfo = descriptorObject("null", [
		{ key: "compID", type: "long", value: i32(9) },
		{ key: "originalCompID", type: "long", value: i32(7) },
	]);
	const transform = options.transform ?? [10, 20, 74, 20, 74, 52, 10, 52];
	const nonAffineTransform = options.nonAffineTransform === undefined ? [10, 20, 75, 19, 74, 52, 9, 53] : options.nonAffineTransform;
	const smartFilterIds = {
		addNoise: 1097092723,
		average: 1098281575,
		blur: 1114403360,
		blurMore: 1114403405,
		colorHalftone: 1131180616,
		clouds: 1131177075,
		crystallize: 1131574132,
		customConvolution: 1131639917,
		deInterlace: 1148089458,
		differenceClouds: 1147564611,
		displace: 1148416108,
		diffuse: 1147564832,
		emboss: 1164796531,
		extrude: 1165522034,
		tiles: 1416393504,
		traceContour: 1416782659,
		wind: 1466852384,
		fibers: 1180856947,
		lensFlare: 1282306886,
		liquify: 1282492025,
		despeckle: 1148416099,
		dustAndScratches: 1148417107,
		facet: 1180922912,
		findEdges: 1181639749,
		fragment: 1181902701,
		highPass: 1214736464,
		hsbHsl: 1215521360,
		perspectiveWarp: 442,
		curves: 1131574899,
		brightnessContrast: 1114793795,
		invert: 1231976050,
		maximum: 1299737888,
		mezzotint: 1299870830,
		median: 1298427424,
		minimum: 1299082528,
		motionBlur: 1299476034,
		mosaic: 1299407648,
		ntscColors: 1314149187,
		offset: 1332114292,
		oilPaint: 1122,
		pinch: 1349411688,
		polarCoordinates: 1349284384,
		ripple: 1383099493,
		shear: 1399353888,
		spherize: 1399875698,
		twirl: 1417114220,
		wave: 1466005093,
		zigzag: 1516722791,
		puppetWarp: 991,
		pointillize: 1349416044,
		radialBlur: 1382313026,
		reduceNoise: 633,
		smartSharpen: 698,
		unsharpMask: 1433301837,
		sharpen: 1399353968,
		sharpenEdges: 1399353925,
		sharpenMore: 1399353933,
		solarize: 1399616122,
		shapeBlur: 702,
		smartBlur: 1399681602,
		surfaceBlur: 701,
	} as const;
	const smartFilterRadiusClasses = { boxBlur: "boxblur", gaussianBlur: "GsnB", highPass: "HghP", maximum: "Mxm ", median: "Mdn ", minimum: "Mnm " } as const;
	const smartFilters =
		options.smartFilters ?? Array.from({ length: options.filterCount ?? 0 }, (): NonNullable<typeof options.smartFilters>[number] => ({ type: "unsupported" }));
	const filterFx = descriptorObject("filterFX", [
		{ key: "enab", type: "bool", value: Buffer.from([options.smartFilterStackEnabled === false ? 0 : 1]) },
		{ key: "validAtPosition", type: "bool", value: Buffer.from([1]) },
		{ key: "filterMaskEnable", type: "bool", value: Buffer.from([options.smartFilterMaskEnabled ? 1 : 0]) },
		{ key: "filterMaskLinked", type: "bool", value: Buffer.from([options.smartFilterMaskLinked === false ? 0 : 1]) },
		{ key: "filterMaskExtendWithWhite", type: "bool", value: Buffer.from([options.smartFilterMaskExtendWithWhite === false ? 0 : 1]) },
		{
			key: "filterFXList",
			type: "VlLs",
			value: descriptorList(
				...smartFilters.map((filter, index) => {
					const blendOptions = descriptorObject("blendOptions", [
						{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", filter.opacity ?? 100) },
						{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", filter.blendMode ?? "Nrml") },
					]);
					const filterObject =
						filter.type === "addNoise"
							? descriptorObject("AdNs", [
									{
										key: "Dstr",
										type: "enum",
										value: descriptorEnum("Dstr", filter.distribution === "gaussian" ? "Gsn " : filter.distribution === "unsupported" ? "Nope" : "Unfr"),
									},
									{ key: "Nose", type: "UntF", value: descriptorUnit(filter.amountUnits ?? "#Prc", filter.amount ?? 10) },
									{ key: "Mnch", type: "bool", value: Buffer.from([filter.monochromatic ? 1 : 0]) },
									{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) },
								])
							: filter.type === "dustAndScratches"
								? descriptorObject("DstS", [
										{ key: "Rds ", type: "long", value: i32(filter.radius ?? 1) },
										{ key: "Thsh", type: "long", value: i32(filter.threshold ?? 0) },
									])
								: filter.type === "colorHalftone"
									? descriptorObject("ClrH", [
											{ key: "Rds ", type: "long", value: i32(filter.radius ?? 4) },
											{ key: "Ang1", type: "long", value: i32(filter.anglesDegrees?.[0] ?? 108) },
											{ key: "Ang2", type: "long", value: i32(filter.anglesDegrees?.[1] ?? 162) },
											{ key: "Ang3", type: "long", value: i32(filter.anglesDegrees?.[2] ?? 90) },
											...(filter.omitColorHalftoneAngle4 ? [] : [{ key: "Ang4", type: "long", value: i32(filter.anglesDegrees?.[3] ?? 45) }]),
										])
									: filter.type === "clouds"
										? descriptorObject("Clds", [...(filter.omitRandomSeed ? [] : [{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) }])])
										: filter.type === "differenceClouds"
											? descriptorObject("DfrC", [...(filter.omitRandomSeed ? [] : [{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) }])])
											: filter.type === "diffuse"
												? descriptorObject("Dfs ", [
														{
															key: "Md  ",
															type: "enum",
															value: descriptorEnum(
																"DfsM",
																(
																	{
																		normal: "Nrml",
																		darkenOnly: "DrkO",
																		lightenOnly: "LghO",
																		anisotropic: "anisotropic",
																		unsupported: "Nope",
																	} as const
																)[filter.diffuseMode ?? "normal"]
															),
														},
														...(filter.omitRandomSeed ? [] : [{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) }]),
													])
												: filter.type === "emboss"
													? descriptorObject("Embs", [
															{ key: "Angl", type: "long", value: i32(filter.angleDegrees ?? 135) },
															{ key: "Hght", type: "long", value: i32(filter.height ?? 3) },
															{ key: "Amnt", type: "long", value: i32(filter.amount ?? 150) },
														])
													: filter.type === "extrude"
														? descriptorObject("Extr", [
																{ key: "ExtS", type: "long", value: i32(filter.cellSize ?? 4) },
																{ key: "ExtD", type: "long", value: i32(filter.depth ?? 96) },
																...(filter.omitSolidFrontFaces
																	? []
																	: [{ key: "ExtF", type: "bool", value: Buffer.from([filter.solidFrontFaces === false ? 0 : 1]) }]),
																...(filter.omitMaskIncompleteBlocks
																	? []
																	: [{ key: "ExtM", type: "bool", value: Buffer.from([filter.maskIncompleteBlocks === false ? 0 : 1]) }]),
																{
																	key: "ExtT",
																	type: "enum",
																	value: descriptorEnum(
																		"ExtT",
																		({ blocks: "Blks", pyramids: "Pyrm", unsupported: "Nope" } as const)[filter.extrudeType ?? "blocks"]
																	),
																},
																{
																	key: "ExtR",
																	type: "enum",
																	value: descriptorEnum(
																		"ExtR",
																		({ random: "Rndm", levelBased: "LvlB", unsupported: "Nope" } as const)[filter.extrudeDepthMode ?? "random"]
																	),
																},
																...(filter.omitRandomSeed ? [] : [{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) }]),
															])
														: filter.type === "tiles"
															? descriptorObject("Tls ", [
																	{ key: "TlNm", type: "long", value: i32(filter.numberOfTiles ?? 4) },
																	{ key: "TlOf", type: "long", value: i32(filter.maximumOffset ?? 35) },
																	{
																		key: "FlCl",
																		type: "enum",
																		value: descriptorEnum(
																			"FlCl",
																			(
																				{
																					backgroundColor: "FlBc",
																					foregroundColor: "FlFr",
																					inverseImage: "FlIn",
																					unalteredImage: "FlSm",
																					unsupported: "Nope",
																				} as const
																			)[filter.tilesFill ?? "backgroundColor"]
																		),
																	},
																	...(filter.omitRandomSeed ? [] : [{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) }]),
																])
															: filter.type === "traceContour"
																? descriptorObject("TrcC", [
																		filter.levelAsDouble
																			? { key: "Lvl ", type: "doub", value: f64(filter.level ?? 128.5) }
																			: { key: "Lvl ", type: "long", value: i32(filter.level ?? 128) },
																		{
																			key: "Edg ",
																			type: "enum",
																			value: descriptorEnum(
																				"CntE",
																				({ lower: "Lwr ", upper: "Upr ", unsupported: "Nope" } as const)[filter.traceContourEdge ?? "lower"]
																			),
																		},
																	])
																: filter.type === "wind"
																	? descriptorObject("Wnd ", [
																			{
																				key: "WndM",
																				type: "enum",
																				value: descriptorEnum(
																					"WndM",
																					({ wind: "Wnd ", blast: "Blst", stagger: "Stgr", unsupported: "Nope" } as const)[
																						filter.windMethod ?? "wind"
																					]
																				),
																			},
																			{
																				key: "Drct",
																				type: "enum",
																				value: descriptorEnum(
																					"Drct",
																					({ left: "Left", right: "Rght", unsupported: "Nope" } as const)[filter.windDirection ?? "right"]
																				),
																			},
																		])
																	: filter.type === "deInterlace"
																		? descriptorObject("Dntr", [
																				{
																					key: "IntE",
																					type: "enum",
																					value: descriptorEnum(
																						"IntE",
																						({ oddLines: "ElmO", evenLines: "ElmE", unsupported: "Nope" } as const)[
																							filter.deInterlaceEliminate ?? "oddLines"
																						]
																					),
																				},
																				{
																					key: "IntC",
																					type: "enum",
																					value: descriptorEnum(
																						"IntC",
																						({ duplication: "CrtD", interpolation: "CrtI", unsupported: "Nope" } as const)[
																							filter.deInterlaceNewFieldsBy ?? "interpolation"
																						]
																					),
																				},
																			])
																		: filter.type === "fibers"
																			? descriptorObject("Fbrs", [
																					{ key: "Vrnc", type: "long", value: i32(filter.variance ?? 16) },
																					{ key: "Strg", type: "long", value: i32(filter.strength ?? 32) },
																					...(filter.omitRandomSeed
																						? []
																						: [{ key: "RndS", type: "long", value: i32(filter.randomSeed ?? 123456) }]),
																				])
																			: filter.type === "lensFlare"
																				? descriptorObject("LnsF", [
																						{ key: "Brgh", type: "long", value: i32(filter.brightness ?? 100) },
																						{
																							key: "FlrC",
																							type: "Objc",
																							value: descriptorObject("Pnt ", [
																								{ key: "Hrzn", type: "doub", value: f64(filter.position?.x ?? 4) },
																								{ key: "Vrtc", type: "doub", value: f64(filter.position?.y ?? 3) },
																							]),
																						},
																						{
																							key: "Lns ",
																							type: "enum",
																							value: descriptorEnum(
																								"Lns ",
																								(
																									{
																										"50-300mm zoom": "Zm  ",
																										"32mm prime": "Nkn ",
																										"105mm prime": "Nkn1",
																										"movie prime": "PnVs",
																										unsupported: "Nope",
																									} as const
																								)[filter.lensType ?? "50-300mm zoom"]
																							),
																						},
																					])
																				: filter.type === "smartSharpen"
																					? descriptorObject("smartSharpen", [
																							{
																								key: "Amnt",
																								type: "UntF",
																								value: descriptorUnit(filter.amountUnits ?? "#Prc", filter.amount ?? 150),
																							},
																							{
																								key: "Rds ",
																								type: "UntF",
																								value: descriptorUnit(filter.radiusUnits ?? "#Pxl", filter.radius ?? 1.5),
																							},
																							{ key: "Thsh", type: "long", value: i32(filter.threshold ?? 5) },
																							{ key: "Angl", type: "doub", value: f64(filter.angleDegrees ?? 0) },
																							{
																								key: "moreAccurate",
																								type: "bool",
																								value: Buffer.from([filter.moreAccurate === false ? 0 : 1]),
																							},
																							{
																								key: "blur",
																								type: "enum",
																								value: descriptorEnum(
																									"blurType",
																									(
																										{
																											gaussianBlur: "GsnB",
																											lensBlur: "lensBlur",
																											motionBlur: "MtnB",
																											unsupported: "Nope",
																										} as const
																									)[filter.smartSharpenBlur ?? "gaussianBlur"]
																								),
																							},
																							{
																								key: "preset",
																								type: "TEXT",
																								value: descriptorUnicode(filter.preset ?? "Codex Smart Sharpen"),
																							},
																							{
																								key: "sdwM",
																								type: "Objc",
																								value: descriptorObject("adaptCorrectTones", [
																									{
																										key: "Amnt",
																										type: "UntF",
																										value: descriptorUnit("#Prc", filter.shadow?.fadeAmount ?? 20),
																									},
																									{
																										key: "Wdth",
																										type: "UntF",
																										value: descriptorUnit("#Prc", filter.shadow?.tonalWidth ?? 40),
																									},
																									{ key: "Rds ", type: "long", value: i32(filter.shadow?.radius ?? 2) },
																								]),
																							},
																							{
																								key: "hglM",
																								type: "Objc",
																								value: descriptorObject("adaptCorrectTones", [
																									{
																										key: "Amnt",
																										type: "UntF",
																										value: descriptorUnit("#Prc", filter.highlight?.fadeAmount ?? 30),
																									},
																									{
																										key: "Wdth",
																										type: "UntF",
																										value: descriptorUnit("#Prc", filter.highlight?.tonalWidth ?? 50),
																									},
																									{ key: "Rds ", type: "long", value: i32(filter.highlight?.radius ?? 3) },
																								]),
																							},
																						])
																					: filter.type === "crystallize"
																						? descriptorObject("Crst", [
																								{ key: "ClSz", type: "long", value: i32(filter.cellSize ?? 3) },
																								{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) },
																							])
																						: filter.type === "mezzotint"
																							? descriptorObject("Mztn", [
																									{
																										key: "MztT",
																										type: "enum",
																										value: descriptorEnum(
																											"MztT",
																											(
																												{
																													"fine dots": "FnDt",
																													"medium dots": "MdmD",
																													"grainy dots": "GrnD",
																													"coarse dots": "CrsD",
																													"short lines": "ShrL",
																													"medium lines": "MdmL",
																													"long lines": "LngL",
																													"short strokes": "ShSt",
																													"medium strokes": "MdmS",
																													"long strokes": "LngS",
																													unsupported: "Nope",
																												} as const
																											)[filter.mezzotintPattern ?? "medium strokes"]
																										),
																									},
																									{ key: "FlRs", type: "long", value: i32(filter.randomSeed ?? 123456) },
																								])
																							: filter.type === "mosaic"
																								? descriptorObject("Msc ", [
																										{
																											key: "ClSz",
																											type: "UntF",
																											value: descriptorUnit(
																												filter.cellSizeUnits ?? "#Pxl",
																												filter.cellSize ?? 2
																											),
																										},
																									])
																								: filter.type === "pointillize"
																									? descriptorObject("Pntl", [
																											{ key: "ClSz", type: "long", value: i32(filter.cellSize ?? 3) },
																											...(filter.omitRandomSeed
																												? []
																												: [
																														{
																															key: "FlRs",
																															type: "long",
																															value: i32(filter.randomSeed ?? 123456),
																														},
																													]),
																										])
																									: filter.type === "reduceNoise"
																										? descriptorObject("denoise", [
																												{
																													key: "ClNs",
																													type: "UntF",
																													value: descriptorUnit("#Prc", filter.reduceColorNoise ?? 50),
																												},
																												{
																													key: "Shrp",
																													type: "UntF",
																													value: descriptorUnit("#Prc", filter.sharpenDetails ?? 25),
																												},
																												{
																													key: "removeJPEGArtifact",
																													type: "bool",
																													value: Buffer.from([
																														filter.removeJpegArtifact === false ? 0 : 1,
																													]),
																												},
																												{
																													key: "channelDenoise",
																													type: "VlLs",
																													value: descriptorList(
																														...(
																															filter.channelDenoise ?? [
																																{
																																	channels: ["composite" as const],
																																	amount: 6,
																																	preserveDetails: 40,
																																},
																															]
																														).map((entry) =>
																															descriptorObject("channelDenoiseParams", [
																																{
																																	key: "Chnl",
																																	type: filter.channelReferenceType ?? "obj ",
																																	value: descriptorEnumReference(
																																		"Chnl",
																																		...entry.channels.map(
																																			(channel) =>
																																				({
																																					red: "Rd  ",
																																					green: "Grn ",
																																					blue: "Bl  ",
																																					composite: "Cmps",
																																				})[channel]
																																		)
																																	),
																																},
																																{
																																	key: "Amnt",
																																	type: "long",
																																	value: i32(entry.amount),
																																},
																																...(entry.preserveDetails === undefined
																																	? []
																																	: [
																																			{
																																				key: "EdgF",
																																				type: "long",
																																				value: i32(entry.preserveDetails),
																																			},
																																		]),
																															])
																														)
																													),
																												},
																												{
																													key: "preset",
																													type: "TEXT",
																													value: descriptorUnicode(filter.preset ?? "Codex Reduce Noise"),
																												},
																											])
																										: filter.type === "shapeBlur"
																											? descriptorObject("shapeBlur", [
																													{
																														key: "Rds ",
																														type: "UntF",
																														value: descriptorUnit(
																															filter.radiusUnits ?? "#Pxl",
																															filter.radius ?? 5
																														),
																													},
																													{
																														key: "customShape",
																														type: "Objc",
																														value: descriptorObject("customShape", [
																															{
																																key: "Nm  ",
																																type: "TEXT",
																																value: descriptorUnicode(
																																	filter.customShapeName ?? "Heart Card"
																																),
																															},
																															{
																																key: "Idnt",
																																type: "TEXT",
																																value: descriptorUnicode(
																																	filter.customShapeId ??
																																		"e06d65dd-d132-11d5-9a4a-a011a4cb2b24"
																																),
																															},
																														]),
																													},
																												])
																											: filter.type === "smartBlur"
																												? descriptorObject("SmrB", [
																														{
																															key: "Rds ",
																															type: "doub",
																															value: f64(filter.radius ?? 1),
																														},
																														{
																															key: "Thsh",
																															type: "doub",
																															value: f64(filter.threshold ?? 1),
																														},
																														{
																															key: "SmBQ",
																															type: "enum",
																															value: descriptorEnum(
																																"SmBQ",
																																filter.quality === "low"
																																	? "SBQL"
																																	: filter.quality === "high"
																																		? "SBQH"
																																		: filter.quality === "unsupported"
																																			? "Nope"
																																			: "SBQM"
																															),
																														},
																														{
																															key: "SmBM",
																															type: "enum",
																															value: descriptorEnum(
																																"SmBM",
																																filter.mode === "edgeOnly"
																																	? "SBME"
																																	: filter.mode === "overlayEdge"
																																		? "SBMO"
																																		: filter.mode === "unsupported"
																																			? "Nope"
																																			: "SBMN"
																															),
																														},
																													])
																												: filter.type === "surfaceBlur"
																													? descriptorObject("surfaceBlur", [
																															{
																																key: "Rds ",
																																type: "UntF",
																																value: descriptorUnit(
																																	filter.radiusUnits ?? "#Pxl",
																																	filter.radius ?? 1
																																),
																															},
																															{
																																key: "Thsh",
																																type: "long",
																																value: i32(filter.threshold ?? 1),
																															},
																														])
																													: filter.type === "unsharpMask"
																														? descriptorObject("UnsM", [
																																{
																																	key: "Amnt",
																																	type: "UntF",
																																	value: descriptorUnit(
																																		filter.amountUnits ?? "#Prc",
																																		filter.amount ?? 150
																																	),
																																},
																																{
																																	key: "Rds ",
																																	type: "UntF",
																																	value: descriptorUnit(
																																		filter.radiusUnits ?? "#Pxl",
																																		filter.radius ?? 1.5
																																	),
																																},
																																{
																																	key: "Thsh",
																																	type: "long",
																																	value: i32(filter.threshold ?? 5),
																																},
																															])
																														: filter.type === "motionBlur"
																															? descriptorObject("MtnB", [
																																	{
																																		key: "Angl",
																																		type: "long",
																																		value: i32(filter.angleDegrees ?? 0),
																																	},
																																	{
																																		key: "Dstn",
																																		type: "UntF",
																																		value: descriptorUnit(
																																			filter.distanceUnits ?? "#Pxl",
																																			filter.distance ?? 1
																																		),
																																	},
																																])
																															: filter.type === "radialBlur"
																																? descriptorObject("RdlB", [
																																		{
																																			key: "Amnt",
																																			type: "long",
																																			value: i32(filter.amount ?? 1),
																																		},
																																		{
																																			key: "BlrM",
																																			type: "enum",
																																			value: descriptorEnum(
																																				"BlrM",
																																				filter.method === "zoom"
																																					? "Zm  "
																																					: filter.method ===
																																						  "unsupported"
																																						? "Nope"
																																						: "Spn "
																																			),
																																		},
																																		{
																																			key: "BlrQ",
																																			type: "enum",
																																			value: descriptorEnum(
																																				"BlrQ",
																																				filter.quality === "draft"
																																					? "Drft"
																																					: filter.quality === "best"
																																						? "Bst "
																																						: filter.quality ===
																																							  "unsupported"
																																							? "Nope"
																																							: "Gd  "
																																			),
																																		},
																																	])
																																: filter.type === "oilPaint"
																																	? oilPaintFilterDescriptor({
																																			variant: filter.oilPaintVariant,
																																			lightingOn: filter.oilPaintLightingOn,
																																			stylization: filter.oilPaintStylization,
																																			cleanliness: filter.oilPaintCleanliness,
																																			brushScale: filter.oilPaintBrushScale,
																																			bristleDetail:
																																				filter.oilPaintBristleDetail,
																																			lightDirection:
																																				filter.oilPaintLightDirection,
																																			shine: filter.oilPaintShine,
																																			omitControl: filter.oilPaintOmitControl,
																																			lightingAsLong:
																																				filter.oilPaintLightingAsLong,
																																			unknownKey: filter.oilPaintUnknownKey,
																																		})
																																	: filter.type === "displace"
																																		? displaceFilterDescriptor({
																																				horizontalScale:
																																					filter.displaceHorizontalScale,
																																				verticalScale:
																																					filter.displaceVerticalScale,
																																				displacementMap:
																																					filter.displacementMap,
																																				undefinedAreas:
																																					filter.displaceUndefinedAreas,
																																				signature: filter.displaceSignature,
																																				path: filter.displacePath,
																																				horizontalAsDouble:
																																					filter.displaceHorizontalAsDouble,
																																				pathEntryType:
																																					filter.displacePathEntryType,
																																				pathLengthDelta:
																																					filter.displacePathLengthDelta,
																																				omitPath: filter.displaceOmitPath,
																																				duplicatePath:
																																					filter.displaceDuplicatePath,
																																				unknownKey:
																																					filter.displaceUnknownKey,
																																			})
																																		: filter.type === "pinch"
																																			? pinchFilterDescriptor({
																																					amount: filter.pinchAmount,
																																					amountAsDouble:
																																						filter.pinchAmountAsDouble,
																																					omitAmount:
																																						filter.pinchOmitAmount,
																																					duplicateAmount:
																																						filter.pinchDuplicateAmount,
																																					unknownKey:
																																						filter.pinchUnknownKey,
																																				})
																																			: filter.type === "polarCoordinates"
																																				? polarCoordinatesFilterDescriptor({
																																						conversion:
																																							filter.polarConversion,
																																						entryType:
																																							filter.polarConversionEntryType,
																																						enumType:
																																							filter.polarEnumType,
																																						omitConversion:
																																							filter.polarOmitConversion,
																																						duplicateConversion:
																																							filter.polarDuplicateConversion,
																																						unknownKey:
																																							filter.polarUnknownKey,
																																					})
																																				: filter.type === "ripple"
																																					? rippleFilterDescriptor({
																																							amount: filter.rippleAmount,
																																							amountAsDouble:
																																								filter.rippleAmountAsDouble,
																																							size: filter.rippleSize,
																																							sizeEntryType:
																																								filter.rippleSizeEntryType,
																																							sizeEnumType:
																																								filter.rippleSizeEnumType,
																																							omitAmount:
																																								filter.rippleOmitAmount,
																																							omitSize:
																																								filter.rippleOmitSize,
																																							duplicateAmount:
																																								filter.rippleDuplicateAmount,
																																							duplicateSize:
																																								filter.rippleDuplicateSize,
																																							unknownKey:
																																								filter.rippleUnknownKey,
																																						})
																																					: filter.type === "shear"
																																						? shearFilterDescriptor({
																																								points: filter.shearPoints,
																																								pointsEntryType:
																																									filter.shearPointsEntryType,
																																								undefinedAreas:
																																									filter.shearUndefinedAreas,
																																								undefinedAreaEntryType:
																																									filter.shearUndefinedAreaEntryType,
																																								undefinedAreaEnumType:
																																									filter.shearUndefinedAreaEnumType,
																																								startIndex:
																																									filter.shearStartIndex,
																																								endIndex:
																																									filter.shearEndIndex,
																																								startAsDouble:
																																									filter.shearStartAsDouble,
																																								endAsDouble:
																																									filter.shearEndAsDouble,
																																								pointClassId:
																																									filter.shearPointClassId,
																																								pointHorizontalAsLong:
																																									filter.shearPointHorizontalAsLong,
																																								pointMissingVertical:
																																									filter.shearPointMissingVertical,
																																								pointDuplicateHorizontal:
																																									filter.shearPointDuplicateHorizontal,
																																								pointUnknownKey:
																																									filter.shearPointUnknownKey,
																																								omitPoints:
																																									filter.shearOmitPoints,
																																								omitUndefinedAreas:
																																									filter.shearOmitUndefinedAreas,
																																								omitStart:
																																									filter.shearOmitStart,
																																								omitEnd:
																																									filter.shearOmitEnd,
																																								duplicatePoints:
																																									filter.shearDuplicatePoints,
																																								unknownKey:
																																									filter.shearUnknownKey,
																																							})
																																						: filter.type === "spherize"
																																							? spherizeFilterDescriptor(
																																									{
																																										amount: filter.spherizeAmount,
																																										amountAsDouble:
																																											filter.spherizeAmountAsDouble,
																																										mode: filter.spherizeMode,
																																										modeEntryType:
																																											filter.spherizeModeEntryType,
																																										modeEnumType:
																																											filter.spherizeModeEnumType,
																																										omitAmount:
																																											filter.spherizeOmitAmount,
																																										omitMode:
																																											filter.spherizeOmitMode,
																																										duplicateAmount:
																																											filter.spherizeDuplicateAmount,
																																										duplicateMode:
																																											filter.spherizeDuplicateMode,
																																										unknownKey:
																																											filter.spherizeUnknownKey,
																																									}
																																								)
																																							: filter.type ===
																																								  "twirl"
																																								? twirlFilterDescriptor(
																																										{
																																											angle: filter.twirlAngle,
																																											angleAsDouble:
																																												filter.twirlAngleAsDouble,
																																											omitAngle:
																																												filter.twirlOmitAngle,
																																											duplicateAngle:
																																												filter.twirlDuplicateAngle,
																																											unknownKey:
																																												filter.twirlUnknownKey,
																																										}
																																									)
																																								: filter.type ===
																																									  "wave"
																																									? waveFilterDescriptor(
																																											{
																																												numberOfGenerators:
																																													filter.waveNumberOfGenerators,
																																												waveType:
																																													filter.waveType,
																																												minimumWavelength:
																																													filter.waveMinimumWavelength,
																																												maximumWavelength:
																																													filter.waveMaximumWavelength,
																																												minimumAmplitude:
																																													filter.waveMinimumAmplitude,
																																												maximumAmplitude:
																																													filter.waveMaximumAmplitude,
																																												horizontalScale:
																																													filter.waveHorizontalScale,
																																												verticalScale:
																																													filter.waveVerticalScale,
																																												randomSeed:
																																													filter.waveRandomSeed,
																																												undefinedAreas:
																																													filter.waveUndefinedAreas,
																																												longAsDouble:
																																													filter.waveLongAsDouble,
																																												waveTypeEntryType:
																																													filter.waveTypeEntryType,
																																												waveTypeEnumType:
																																													filter.waveTypeEnumType,
																																												undefinedAreaEntryType:
																																													filter.waveUndefinedAreaEntryType,
																																												undefinedAreaEnumType:
																																													filter.waveUndefinedAreaEnumType,
																																												omitKey:
																																													filter.waveOmitKey,
																																												duplicateKey:
																																													filter.waveDuplicateKey,
																																												unknownKey:
																																													filter.waveUnknownKey,
																																											}
																																										)
																																									: filter.type ===
																																										  "zigzag"
																																										? zigZagFilterDescriptor(
																																												{
																																													amount: filter.zigZagAmount,
																																													ridges: filter.zigZagRidges,
																																													style: filter.zigZagStyle,
																																													amountAsDouble:
																																														filter.zigZagAmountAsDouble,
																																													ridgesAsDouble:
																																														filter.zigZagRidgesAsDouble,
																																													styleEntryType:
																																														filter.zigZagStyleEntryType,
																																													styleEnumType:
																																														filter.zigZagStyleEnumType,
																																													omitAmount:
																																														filter.zigZagOmitAmount,
																																													omitRidges:
																																														filter.zigZagOmitRidges,
																																													omitStyle:
																																														filter.zigZagOmitStyle,
																																													duplicateAmount:
																																														filter.zigZagDuplicateAmount,
																																													duplicateRidges:
																																														filter.zigZagDuplicateRidges,
																																													duplicateStyle:
																																														filter.zigZagDuplicateStyle,
																																													unknownKey:
																																														filter.zigZagUnknownKey,
																																												}
																																											)
																																										: filter.type ===
																																											  "hsbHsl"
																																											? hsbHslFilterDescriptor(
																																													{
																																														inputMode:
																																															filter.hsbHslInputMode,
																																														rowOrder:
																																															filter.hsbHslRowOrder,
																																														inputEntryType:
																																															filter.hsbHslInputEntryType,
																																														rowOrderEntryType:
																																															filter.hsbHslRowOrderEntryType,
																																														inputEnumType:
																																															filter.hsbHslInputEnumType,
																																														rowOrderEnumType:
																																															filter.hsbHslRowOrderEnumType,
																																														omitInput:
																																															filter.hsbHslOmitInput,
																																														omitRowOrder:
																																															filter.hsbHslOmitRowOrder,
																																														duplicateInput:
																																															filter.hsbHslDuplicateInput,
																																														duplicateRowOrder:
																																															filter.hsbHslDuplicateRowOrder,
																																														unknownKey:
																																															filter.hsbHslUnknownKey,
																																													}
																																												)
																																											: filter.type ===
																																												  "perspectiveWarp"
																																												? perspectiveWarpFilterDescriptor(
																																														{
																																															vertices:
																																																filter.perspectiveWarpVertices,
																																															warpedVertices:
																																																filter.perspectiveWarpWarpedVertices,
																																															quads: filter.perspectiveWarpQuads,
																																															descriptorClass:
																																																filter.perspectiveWarpDescriptorClass,
																																															pointClass:
																																																filter.perspectiveWarpPointClass,
																																															quadClass:
																																																filter.perspectiveWarpQuadClass,
																																															units: filter.perspectiveWarpUnits,
																																															indicesAsDouble:
																																																filter.perspectiveWarpIndicesAsDouble,
																																															omitVertices:
																																																filter.perspectiveWarpOmitVertices,
																																															omitWarpedVertices:
																																																filter.perspectiveWarpOmitWarpedVertices,
																																															omitQuads:
																																																filter.perspectiveWarpOmitQuads,
																																															duplicateVertices:
																																																filter.perspectiveWarpDuplicateVertices,
																																															unknownKey:
																																																filter.perspectiveWarpUnknownKey,
																																														}
																																													)
																																												: filter.type ===
																																													  "curves"
																																													? curvesFilterDescriptor(
																																															filter.curvesDescriptor
																																														)
																																													: filter.type ===
																																														  "brightnessContrast"
																																														? brightnessContrastFilterDescriptor(
																																																filter.brightnessContrastDescriptor
																																															)
																																														: filter.type ===
																																															  "liquify"
																																															? liquifyFilterDescriptor(
																																																	{
																																																		mesh:
																																																			filter.liquifyMesh ??
																																																			liquifyMesh(
																																																				{
																																																					version: 3,
																																																					meshWidth: 2,
																																																					meshHeight: 2,
																																																					imageWidth: 8,
																																																					imageHeight: 6,
																																																					displacements:
																																																						[
																																																							{
																																																								x: 0,
																																																								y: 0,
																																																							},
																																																							{
																																																								x: -1,
																																																								y: 0.5,
																																																							},
																																																							{
																																																								x: 0.75,
																																																								y: -0.5,
																																																							},
																																																							{
																																																								x: 0,
																																																								y: 0,
																																																							},
																																																						],
																																																				}
																																																			),
																																																		entryType:
																																																			filter.liquifyMeshEntryType,
																																																		duplicateMesh:
																																																			filter.liquifyDuplicateMesh,
																																																		unknownKey:
																																																			filter.liquifyUnknownKey,
																																																	}
																																																)
																																															: filter.type ===
																																																  "puppetWarp"
																																																? puppetWarpFilterDescriptor(
																																																		{
																																																			originalVertices:
																																																				filter.puppetOriginalVertices,
																																																			deformedVertices:
																																																				filter.puppetDeformedVertices,
																																																			triangleIndices:
																																																				filter.puppetTriangleIndices,
																																																			pinVertexIndices:
																																																				filter.puppetPinVertexIndices,
																																																			omitBoundaryPath:
																																																				filter.puppetOmitBoundaryPath,
																																																		}
																																																	)
																																																: filter.type ===
																																																	  "offset"
																																																	? descriptorObject(
																																																			"Ofst",
																																																			[
																																																				filter.offsetHorizontalAsDouble
																																																					? {
																																																							key: "Hrzn",
																																																							type: "doub",
																																																							value: f64(
																																																								filter.offsetHorizontal ??
																																																									2.5
																																																							),
																																																						}
																																																					: {
																																																							key: "Hrzn",
																																																							type: "long",
																																																							value: i32(
																																																								filter.offsetHorizontal ??
																																																									2
																																																							),
																																																						},
																																																				filter.offsetVerticalAsDouble
																																																					? {
																																																							key: "Vrtc",
																																																							type: "doub",
																																																							value: f64(
																																																								filter.offsetVertical ??
																																																									-1.5
																																																							),
																																																						}
																																																					: {
																																																							key: "Vrtc",
																																																							type: "long",
																																																							value: i32(
																																																								filter.offsetVertical ??
																																																									-1
																																																							),
																																																						},
																																																				{
																																																					key: "Fl  ",
																																																					type: "enum",
																																																					value: descriptorEnum(
																																																						"FlMd",
																																																						(
																																																							{
																																																								setToTransparent:
																																																									"Bckg",
																																																								repeatEdgePixels:
																																																									"Rpt ",
																																																								wrapAround:
																																																									"Wrp ",
																																																								unsupported:
																																																									"Nope",
																																																							} as const
																																																						)[
																																																							filter.offsetUndefinedAreas ??
																																																								"wrapAround"
																																																						]
																																																					),
																																																				},
																																																			]
																																																		)
																																																	: filter.type ===
																																																		  "customConvolution"
																																																		? descriptorObject(
																																																				"Cstm",
																																																				[
																																																					filter.customScaleAsDouble
																																																						? {
																																																								key: "Scl ",
																																																								type: "doub",
																																																								value: f64(
																																																									filter.customScale ??
																																																										1.5
																																																								),
																																																							}
																																																						: {
																																																								key: "Scl ",
																																																								type: "long",
																																																								value: i32(
																																																									filter.customScale ??
																																																										1
																																																								),
																																																							},
																																																					filter.customOffsetAsDouble
																																																						? {
																																																								key: "Ofst",
																																																								type: "doub",
																																																								value: f64(
																																																									filter.customOffset ??
																																																										4.5
																																																								),
																																																							}
																																																						: {
																																																								key: "Ofst",
																																																								type: "long",
																																																								value: i32(
																																																									filter.customOffset ??
																																																										4
																																																								),
																																																							},
																																																					{
																																																						key: "Mtrx",
																																																						type: "VlLs",
																																																						value: filter.customMatrixAsDouble
																																																							? descriptorDoubleList(
																																																									...(filter.customMatrix ??
																																																										Array.from(
																																																											{
																																																												length: 25,
																																																											},
																																																											(
																																																												_,
																																																												index
																																																											) =>
																																																												index ===
																																																												12
																																																													? 1.5
																																																													: 0
																																																										))
																																																								)
																																																							: descriptorLongList(
																																																									...(filter.customMatrix ??
																																																										Array.from(
																																																											{
																																																												length: 25,
																																																											},
																																																											(
																																																												_,
																																																												index
																																																											) =>
																																																												index ===
																																																												12
																																																													? 1
																																																													: 0
																																																										))
																																																								),
																																																					},
																																																				]
																																																			)
																																																		: filter.type in
																																																			  smartFilterRadiusClasses
																																																			? descriptorObject(
																																																					smartFilterRadiusClasses[
																																																						filter.type as keyof typeof smartFilterRadiusClasses
																																																					],
																																																					[
																																																						{
																																																							key: "Rds ",
																																																							type: "UntF",
																																																							value: descriptorUnit(
																																																								filter.radiusUnits ??
																																																									"#Pxl",
																																																								filter.radius ??
																																																									1
																																																							),
																																																						},
																																																					]
																																																				)
																																																			: null;
					return descriptorObject("filterFX", [
						{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(filter.name ?? `Smart Filter ${index + 1}`) },
						{ key: "blendOptions", type: "Objc", value: blendOptions },
						{ key: "enab", type: "bool", value: Buffer.from([filter.enabled === false ? 0 : 1]) },
						...(filter.omitForegroundColor
							? []
							: [
									{
										key: "FrgC",
										type: "Objc",
										value: descriptorObject(
											"RGBC",
											["Rd  ", "Grn ", "Bl  "].map((key, channel) => ({ key, type: "doub", value: f64((filter.foregroundColor ?? [0, 0, 0])[channel]) }))
										),
									},
								]),
						...(filter.omitBackgroundColor
							? []
							: [
									{
										key: "BckC",
										type: "Objc",
										value: descriptorObject(
											"RGBC",
											["Rd  ", "Grn ", "Bl  "].map((key, channel) => ({
												key,
												type: "doub",
												value: f64((filter.backgroundColor ?? [255, 255, 255])[channel]),
											}))
										),
									},
								]),
						...(filterObject ? [{ key: "Fltr", type: "Objc", value: filterObject }] : []),
						...(filter.type in smartFilterIds
							? [
									{
										key: "filterID",
										type: "long",
										value: i32(
											filter.filterIdOverride ??
												(filter.type === "oilPaint" && filter.oilPaintVariant === "legacyPlugin"
													? 1348620396
													: smartFilterIds[filter.type as keyof typeof smartFilterIds])
										),
									},
								]
							: filter.type === "unsupported"
								? [{ key: "filterID", type: "long", value: i32(987654321) }]
								: []),
					]);
				})
			),
		},
	]);
	return Buffer.concat([
		Buffer.from("soLD"),
		i32(4),
		u32(16),
		descriptorObject("null", [
			{ key: "Idnt", type: "TEXT", value: descriptorUnicode(options.resourceId ?? "codex-smart-resource") },
			{ key: "placed", type: "TEXT", value: descriptorUnicode(options.placedId ?? "codex-smart-instance") },
			{ key: "PgNm", type: "long", value: i32(1) },
			{ key: "totalPages", type: "long", value: i32(2) },
			{ key: "frameStep", type: "Objc", value: fraction(1, 24) },
			{ key: "duration", type: "Objc", value: fraction(48, 24) },
			{ key: "frameCount", type: "long", value: i32(48) },
			{ key: "Annt", type: "long", value: i32(16) },
			{ key: "Type", type: "long", value: i32(2) },
			{ key: "Trnf", type: "VlLs", value: descriptorDoubleList(...transform) },
			...(nonAffineTransform ? [{ key: "nonAffineTransform", type: "VlLs", value: descriptorDoubleList(...nonAffineTransform) }] : []),
			{ key: "warp", type: "Objc", value: warp },
			...(smartFilters.length ? [{ key: "filterFX", type: "Objc", value: filterFx }] : []),
			{ key: "Sz  ", type: "Objc", value: size },
			{ key: "Rslt", type: "UntF", value: descriptorUnit("#Rsl", 300) },
			{ key: "Crop", type: "long", value: i32(1) },
			{ key: "comp", type: "long", value: i32(9) },
			{ key: "compInfo", type: "Objc", value: compInfo },
		]),
	]);
}

function smartFilterMaskBlock(options: {
	id?: string;
	left?: number;
	top?: number;
	width: number;
	height: number;
	depth?: 8 | 16 | 32;
	compression?: "raw" | "rle" | "zip" | "zipPrediction";
	coverage: number[];
	psb?: boolean;
}): Buffer {
	const id = options.id ?? "codex-smart-instance";
	const left = options.left ?? 0;
	const top = options.top ?? 0;
	const depth = options.depth ?? 8;
	const compression = options.compression ?? "raw";
	if (options.coverage.length !== options.width * options.height) throw new Error("Smart-filter mask fixture coverage must match its bounds.");
	const sampleByteLength = depth === 32 ? 4 : depth === 16 ? 2 : 1;
	const raw = Buffer.alloc(options.coverage.length * sampleByteLength);
	for (let index = 0; index < options.coverage.length; ++index) {
		if (depth === 32) raw.writeFloatBE(options.coverage[index] / 255, index * 4);
		else if (depth === 16) raw.writeUInt16BE(options.coverage[index] * 257, index * 2);
		else raw[index] = options.coverage[index];
	}
	let payload: Buffer;
	if (compression === "rle") {
		const rows = Array.from({ length: options.height }, (_, y) => {
			const row = raw.subarray(y * options.width * sampleByteLength, (y + 1) * options.width * sampleByteLength);
			if (row.length > 128) throw new Error("Smart-filter mask fixture RLE rows are limited to 128 literal bytes.");
			return Buffer.concat([Buffer.from([row.length - 1]), row]);
		});
		payload = Buffer.concat([...rows.map((row) => u32(row.length)), ...rows]);
	} else if (compression === "zip" || compression === "zipPrediction") {
		const predicted = Buffer.from(raw);
		if (compression === "zipPrediction") {
			const rowByteLength = options.width * sampleByteLength;
			for (let y = 0; y < options.height; ++y) {
				const rowOffset = y * rowByteLength;
				if (depth === 32) {
					const planar = Buffer.alloc(rowByteLength);
					for (let x = 0; x < options.width; ++x) {
						for (let byte = 0; byte < 4; ++byte) planar[byte * options.width + x] = raw[rowOffset + x * 4 + byte];
					}
					for (let byte = rowByteLength - 1; byte > 0; --byte) planar[byte] = (planar[byte] - planar[byte - 1] + 256) & 0xff;
					planar.copy(predicted, rowOffset);
				} else if (depth === 16) {
					for (let x = options.width - 1; x > 0; --x) {
						const value = raw.readUInt16BE(rowOffset + x * 2);
						const previous = raw.readUInt16BE(rowOffset + (x - 1) * 2);
						predicted.writeUInt16BE((value - previous + 65536) & 0xffff, rowOffset + x * 2);
					}
				} else {
					for (let x = options.width - 1; x > 0; --x) predicted[rowOffset + x] = (raw[rowOffset + x] - raw[rowOffset + x - 1] + 256) & 0xff;
				}
			}
		}
		payload = deflateSync(predicted);
	} else {
		payload = raw;
	}
	const effectPayload = Buffer.concat([i32(top), i32(left), i32(top + options.height), i32(left + options.width), i32(depth), i32(0), i32(0), i32(0)]);
	const recordBody = Buffer.concat([
		Buffer.from([id.length]),
		Buffer.from(id, "ascii"),
		i32(1),
		u64(effectPayload.length),
		effectPayload,
		Buffer.from([1]),
		i32(top),
		i32(left),
		i32(top + options.height),
		i32(left + options.width),
		u64(payload.length + 2),
		u16({ raw: 0, rle: 1, zip: 2, zipPrediction: 3 }[compression]),
		payload,
	]);
	const record = Buffer.concat([u64(recordBody.length), recordBody, Buffer.alloc((4 - (recordBody.length % 4)) % 4)]);
	const data = Buffer.concat([i32(3), record]);
	return options.psb ? globalAdditionalPsb("FEid", data) : globalAdditional("FEid", data);
}

function blackWhiteAdjustment(useTint = false): Buffer {
	const tint = descriptorObject("RGBC", [
		{ key: "Rd  ", type: "doub", value: f64(120) },
		{ key: "Grn ", type: "doub", value: f64(80) },
		{ key: "Bl  ", type: "doub", value: f64(40) },
	]);
	return Buffer.concat([
		u32(16),
		descriptorObject("null", [
			{ key: "Rd  ", type: "long", value: i32(40) },
			{ key: "Yllw", type: "long", value: i32(60) },
			{ key: "Grn ", type: "long", value: i32(40) },
			{ key: "Cyn ", type: "long", value: i32(60) },
			{ key: "Bl  ", type: "long", value: i32(20) },
			{ key: "Mgnt", type: "long", value: i32(80) },
			{ key: "useTint", type: "bool", value: Buffer.from([useTint ? 1 : 0]) },
			{ key: "tintColor", type: "Objc", value: tint },
			{ key: "bwPresetKind", type: "long", value: i32(1) },
			{ key: "blackAndWhitePresetFileName", type: "TEXT", value: descriptorUnicode("Custom") },
		]),
	]);
}

function channelMixerChannel(red: number, green: number, blue: number, constant = 0): Buffer {
	return Buffer.concat([i16(red), i16(green), i16(blue), u16(0), i16(constant)]);
}

function channelMixerAdjustment(monochrome = false): Buffer {
	const gray = channelMixerChannel(40, 40, 20);
	return monochrome
		? Buffer.concat([u16(1), u16(1), gray, Buffer.alloc(30)])
		: Buffer.concat([u16(1), u16(0), channelMixerChannel(0, 100, 0, 10), channelMixerChannel(0, 0, 100), channelMixerChannel(100, 0, 0), gray]);
}

function selectiveColorRange(cyan = 0, magenta = 0, yellow = 0, black = 0): Buffer {
	return Buffer.concat([i16(cyan), i16(magenta), i16(yellow), i16(black)]);
}

function selectiveColorAdjustment(): Buffer {
	return Buffer.concat([u16(1), u16(1), Buffer.alloc(8), selectiveColorRange(100), ...Array.from({ length: 8 }, () => selectiveColorRange())]);
}

function gradientMapAdjustment(): Buffer {
	const name = unicodeName("Red Map");
	const colorStop = (location: number, color: [number, number, number]) => Buffer.concat([u32(location), u32(50), effectColor(...color), u16(0)]);
	const opacityStop = (location: number) => Buffer.concat([u32(location), u32(50), u16(255)]);
	return Buffer.concat([
		u16(1),
		Buffer.from([0, 0]),
		name,
		u16(2),
		colorStop(0, [0, 0, 0]),
		colorStop(4096, [255, 0, 0]),
		u16(2),
		opacityStop(0),
		opacityStop(4096),
		u16(2),
		u16(4096),
		u16(32),
		u16(0),
		u32(12345),
		u16(0),
		u16(0),
		u32(2048),
		u16(3),
		...Array.from({ length: 4 }, () => u16(0)),
		...Array.from({ length: 4 }, () => u16(0x8000)),
		Buffer.alloc(4),
	]);
}

function photoFilterAdjustment(): Buffer {
	return Buffer.concat([u16(2), effectColor(255, 128, 0), u32(2500), Buffer.from([0]), Buffer.alloc(3)]);
}

function colorLookupAdjustment(): Buffer {
	const lut = Buffer.from('TITLE "Invert Red"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n1 0 0\n0 0 0\n1 1 0\n0 1 0\n1 0 1\n0 0 1\n1 1 1\n0 1 1\n', "utf8");
	return Buffer.concat([
		u16(1),
		u32(16),
		descriptorObject("null", [
			{ key: "lookupType", type: "enum", value: descriptorEnum("colorLookupType", "3DLUT") },
			{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Invert Red") },
			{ key: "Dthr", type: "bool", value: Buffer.from([0]) },
			{ key: "LUTFormat", type: "enum", value: descriptorEnum("LUTFormatType", "LUTFormatCUBE") },
			{ key: "dataOrder", type: "enum", value: descriptorEnum("colorLookupOrder", "rgbOrder") },
			{ key: "tableOrder", type: "enum", value: descriptorEnum("colorLookupOrder", "rgbOrder") },
			{ key: "LUT3DFileData", type: "tdta", value: Buffer.concat([u32(lut.byteLength), lut]) },
			{ key: "LUT3DFileName", type: "TEXT", value: descriptorUnicode("invert-red.cube") },
		]),
	]);
}

function modernStrokeEffect(options: { color: [number, number, number]; size: number; opacity: number; position?: "OutF" | "CtrF" | "InsF" }): Buffer {
	const color = descriptorObject("RGBC", [
		{ key: "Rd  ", type: "doub", value: f64(options.color[0]) },
		{ key: "Grn ", type: "doub", value: f64(options.color[1]) },
		{ key: "Bl  ", type: "doub", value: f64(options.color[2]) },
	]);
	const stroke = descriptorObject("FrFX", [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([1]) },
		{ key: "Styl", type: "enum", value: descriptorEnum("FStl", options.position ?? "OutF") },
		{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "SClr") },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", options.opacity) },
		{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", options.size) },
		{ key: "Clr ", type: "Objc", value: color },
	]);
	const root = descriptorObject("null", [
		{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
		{ key: "FrFX", type: "Objc", value: stroke },
	]);
	return Buffer.concat([u32(0), u32(16), root]);
}

function modernGradientStrokeEffect(
	options: {
		style?: "Lnr " | "Rdl " | "Angl" | "Rflc" | "Dmnd";
		angle?: number;
		reverse?: boolean;
		interpolation?: "Perc" | "Lnr " | "Gcls" | "Smoo";
		align?: boolean;
		dither?: boolean;
	} = {}
): Buffer {
	const colorStop = (location: number, color: [number, number, number]): Buffer =>
		descriptorObject("Clrt", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: f64(color[0]) },
					{ key: "Grn ", type: "doub", value: f64(color[1]) },
					{ key: "Bl  ", type: "doub", value: f64(color[2]) },
				]),
			},
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const opacityStop = (location: number): Buffer =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const gradient = descriptorObject("Grdn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Red Blue") },
		{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
		{ key: "Intr", type: "doub", value: f64(4096) },
		{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, [255, 0, 0]), colorStop(4096, [0, 0, 255])) },
		{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0), opacityStop(4096)) },
	]);
	const stroke = descriptorObject("FrFX", [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([1]) },
		{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "OutF") },
		{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "GrFl") },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
		{ key: "Type", type: "enum", value: descriptorEnum("GrdT", options.style ?? "Lnr ") },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", options.angle ?? 0) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Algn", type: "bool", value: Buffer.from([options.align === false ? 0 : 1]) },
		{ key: "Dthr", type: "bool", value: Buffer.from([options.dither ? 1 : 0]) },
		{ key: "Rvrs", type: "bool", value: Buffer.from([options.reverse ? 1 : 0]) },
		...(options.interpolation ? [{ key: "gradientsInterpolationMethod", type: "enum", value: descriptorEnum("gradientInterpolationMethodType", options.interpolation) }] : []),
		{ key: "Grad", type: "Objc", value: gradient },
	]);
	const root = descriptorObject("null", [
		{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
		{ key: "FrFX", type: "Objc", value: stroke },
	]);
	return Buffer.concat([u32(0), u32(16), root]);
}

function modernNoiseGradientStrokeEffect(
	options: {
		colorModel?: "RGBC" | "HSBl" | "LbCl" | "HSLC";
		roughness?: number;
		seed?: number;
		restrictColors?: boolean;
		addTransparency?: boolean;
		minimum?: [number, number, number, number];
		maximum?: [number, number, number, number];
	} = {}
): Buffer {
	const gradient = descriptorObject("Grdn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Seeded Noise") },
		{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "ClNs") },
		{ key: "Smth", type: "long", value: i32(options.roughness ?? 4096) },
		{ key: "ClrS", type: "enum", value: descriptorEnum("ClrS", options.colorModel ?? "RGBC") },
		{ key: "RndS", type: "long", value: i32(options.seed ?? 12345) },
		{ key: "VctC", type: "bool", value: Buffer.from([options.restrictColors ? 1 : 0]) },
		{ key: "ShTr", type: "bool", value: Buffer.from([options.addTransparency ? 1 : 0]) },
		{ key: "Mnm ", type: "VlLs", value: descriptorLongList(...(options.minimum ?? [0, 0, 0, 100])) },
		{ key: "Mxm ", type: "VlLs", value: descriptorLongList(...(options.maximum ?? [100, 100, 100, 100])) },
	]);
	const stroke = descriptorObject("FrFX", [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([1]) },
		{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "OutF") },
		{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "GrFl") },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
		{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Algn", type: "bool", value: Buffer.from([1]) },
		{ key: "Dthr", type: "bool", value: Buffer.from([0]) },
		{ key: "Rvrs", type: "bool", value: Buffer.from([0]) },
		{ key: "Grad", type: "Objc", value: gradient },
	]);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: "FrFX", type: "Objc", value: stroke },
		]),
	]);
}

function modernPatternEffect(kind: "stroke" | "overlay", options: { align?: boolean; scale?: number; angle?: number; phaseX?: number; phaseY?: number } = {}): Buffer {
	const pattern = descriptorObject("Ptrn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("RGBA Tile") },
		{ key: "Idnt", type: "TEXT", value: descriptorUnicode("rgba-tile-2x2") },
	]);
	const phase = descriptorObject("Pnt ", [
		{ key: "Hrzn", type: "long", value: i32(options.phaseX ?? 0) },
		{ key: "Vrtc", type: "long", value: i32(options.phaseY ?? 0) },
	]);
	const effect = descriptorObject(kind === "stroke" ? "FrFX" : "patternFill", [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([1]) },
		...(kind === "stroke"
			? [
					{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "OutF") },
					{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "Ptrn") },
					{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
				]
			: []),
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", options.scale ?? 100) },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", options.angle ?? 0) },
		{ key: "Algn", type: "bool", value: Buffer.from([options.align === false ? 0 : 1]) },
		{ key: "Lnkd", type: "bool", value: Buffer.from([1]) },
		{ key: "phase", type: "Objc", value: phase },
		{ key: "Ptrn", type: "Objc", value: pattern },
	]);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: kind === "stroke" ? "FrFX" : "patternFill", type: "Objc", value: effect },
		]),
	]);
}

function modernColorOverlayEffect(): Buffer {
	const color = descriptorObject("RGBC", [
		{ key: "Rd  ", type: "doub", value: f64(200) },
		{ key: "Grn ", type: "doub", value: f64(50) },
		{ key: "Bl  ", type: "doub", value: f64(10) },
	]);
	const overlay = descriptorObject("SoFi", [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([0]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Mltp") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 40) },
		{ key: "Clr ", type: "Objc", value: color },
	]);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: "SoFi", type: "Objc", value: overlay },
		]),
	]);
}

function modernGradientOverlayEffect(type: "solid" | "noise"): Buffer {
	const colorStop = (location: number, color: [number, number, number]): Buffer =>
		descriptorObject("Clrt", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: f64(color[0]) },
					{ key: "Grn ", type: "doub", value: f64(color[1]) },
					{ key: "Bl  ", type: "doub", value: f64(color[2]) },
				]),
			},
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const opacityStop = (location: number): Buffer =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const gradient =
		type === "solid"
			? descriptorObject("Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Overlay Red Blue") },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
					{ key: "Intr", type: "doub", value: f64(4096) },
					{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, [255, 0, 0]), colorStop(4096, [0, 0, 255])) },
					{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0), opacityStop(4096)) },
				])
			: descriptorObject("Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Overlay Seeded Noise") },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "ClNs") },
					{ key: "Smth", type: "long", value: i32(2048) },
					{ key: "ClrS", type: "enum", value: descriptorEnum("ClrS", "RGBC") },
					{ key: "RndS", type: "long", value: i32(3650322) },
					{ key: "VctC", type: "bool", value: Buffer.from([1]) },
					{ key: "ShTr", type: "bool", value: Buffer.from([1]) },
					{ key: "Mnm ", type: "VlLs", value: descriptorLongList(0, 10, 20, 30) },
					{ key: "Mxm ", type: "VlLs", value: descriptorLongList(100, 90, 80, 70) },
				]);
	const overlay = descriptorObject("GrFl", [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([0]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 75) },
		{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Algn", type: "bool", value: Buffer.from([1]) },
		{ key: "Dthr", type: "bool", value: Buffer.from([0]) },
		{ key: "Rvrs", type: "bool", value: Buffer.from([0]) },
		...(type === "solid" ? [{ key: "gs99", type: "enum", value: descriptorEnum("gradientInterpolationMethodType", "Lnr ") }] : []),
		{ key: "Grad", type: "Objc", value: gradient },
	]);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: "GrFl", type: "Objc", value: overlay },
		]),
	]);
}

function modernShadowEffects(options: { choke?: number; noise?: number; contour?: Array<[number, number]>; antialiased?: boolean } = {}): Buffer {
	const contourPoint = (x: number, y: number): Buffer =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: f64(x) },
			{ key: "Vrtc", type: "doub", value: f64(y) },
		]);
	const contour = options.contour
		? descriptorObject("ShpC", [
				{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Shadow Ramp") },
				{ key: "Crv ", type: "VlLs", value: descriptorList(...options.contour.map(([x, y]) => contourPoint(x, y))) },
			])
		: null;
	const effect = (classId: "DrSh" | "IrSh", color: [number, number, number], blend: "Mltp" | "Nrml", dialog: boolean): Buffer =>
		descriptorObject(classId, [
			{ key: "enab", type: "bool", value: Buffer.from([1]) },
			{ key: "present", type: "bool", value: Buffer.from([1]) },
			{ key: "showInDialog", type: "bool", value: Buffer.from([dialog ? 1 : 0]) },
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", blend) },
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: f64(color[0]) },
					{ key: "Grn ", type: "doub", value: f64(color[1]) },
					{ key: "Bl  ", type: "doub", value: f64(color[2]) },
				]),
			},
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 50) },
			{ key: "uglg", type: "bool", value: Buffer.from([0]) },
			{ key: "lagl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "Dstn", type: "UntF", value: descriptorUnit("#Pxl", 1) },
			{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 0) },
			{ key: "Ckmt", type: "UntF", value: descriptorUnit("#Pxl", options.choke ?? 0) },
			...(options.noise === undefined ? [] : [{ key: "Nose", type: "UntF", value: descriptorUnit("#Prc", options.noise) }]),
			{ key: "AntA", type: "bool", value: Buffer.from([options.antialiased === false ? 0 : 1]) },
			...(contour ? [{ key: "TrnS", type: "Objc", value: contour }] : []),
			...(classId === "DrSh" ? [{ key: "layerConceals", type: "bool", value: Buffer.from([1]) }] : []),
		]);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: "DrSh", type: "Objc", value: effect("DrSh", [0, 0, 0], "Mltp", false) },
			{ key: "innerShadowMulti", type: "VlLs", value: descriptorList(effect("IrSh", [255, 0, 0], "Nrml", true)) },
		]),
	]);
}

function modernMultipleInstanceEffects(): Buffer {
	const color = (red: number, green: number, blue: number): Buffer =>
		descriptorObject("RGBC", [
			{ key: "Rd  ", type: "doub", value: f64(red) },
			{ key: "Grn ", type: "doub", value: f64(green) },
			{ key: "Bl  ", type: "doub", value: f64(blue) },
		]);
	const state = (dialog: boolean): Array<{ key: string; type: string; value: Buffer }> => [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([dialog ? 1 : 0]) },
	];
	const shadow = (classId: "DrSh" | "IrSh", red: number): Buffer =>
		descriptorObject(classId, [
			...state(red > 100),
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "uglg", type: "bool", value: Buffer.from([0]) },
			{ key: "lagl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "Dstn", type: "UntF", value: descriptorUnit("#Pxl", 0) },
			{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 0) },
			{ key: "Ckmt", type: "UntF", value: descriptorUnit("#Pxl", 0) },
			{ key: "AntA", type: "bool", value: Buffer.from([1]) },
			...(classId === "DrSh" ? [{ key: "layerConceals", type: "bool", value: Buffer.from([1]) }] : []),
		]);
	const solidFill = (red: number): Buffer =>
		descriptorObject("SoFi", [
			...state(red > 100),
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
		]);
	const colorStop = (location: number, red: number): Buffer =>
		descriptorObject("Clrt", [
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const opacityStop = (location: number): Buffer =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Lctn", type: "long", value: i32(location) },
			{ key: "Mdpn", type: "long", value: i32(50) },
		]);
	const gradientOverlay = (red: number): Buffer =>
		descriptorObject("GrFl", [
			...state(red > 100),
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") },
			{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Algn", type: "bool", value: Buffer.from([1]) },
			{ key: "Dthr", type: "bool", value: Buffer.from([0]) },
			{ key: "Rvrs", type: "bool", value: Buffer.from([0]) },
			{
				key: "Grad",
				type: "Objc",
				value: descriptorObject("Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(`Multi ${red}`) },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
					{ key: "Intr", type: "doub", value: f64(4096) },
					{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, red), colorStop(4096, red)) },
					{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0), opacityStop(4096)) },
				]),
			},
		]);
	const stroke = (red: number): Buffer =>
		descriptorObject("FrFX", [
			...state(red > 100),
			{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "InsF") },
			{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "SClr") },
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
		]);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: "gradientFillMulti", type: "VlLs", value: descriptorList(gradientOverlay(20), gradientOverlay(220)) },
			{ key: "dropShadowMulti", type: "VlLs", value: descriptorList(shadow("DrSh", 30), shadow("DrSh", 230)) },
			{ key: "frameFXMulti", type: "VlLs", value: descriptorList(stroke(40), stroke(240)) },
			{ key: "solidFillMulti", type: "VlLs", value: descriptorList(solidFill(50), solidFill(250)) },
			{ key: "innerShadowMulti", type: "VlLs", value: descriptorList(shadow("IrSh", 60), shadow("IrSh", 255)) },
			{ key: "numModifyingFX", type: "long", value: i32(10) },
		]),
	]);
}

function modernGlowEffects(
	options: {
		choke?: number;
		noise?: number;
		range?: number;
		jitter?: number;
		innerSource?: "SrcE" | "SrcC";
		technique?: "SfBL" | "PrBL";
		antialiased?: boolean;
		contour?: Array<[number, number]>;
	} = {}
): Buffer {
	const contourPoint = (x: number, y: number): Buffer =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: f64(x) },
			{ key: "Vrtc", type: "doub", value: f64(y) },
		]);
	const contourPoints = options.contour ?? [
		[0, 0],
		[255, 255],
	];
	const contour = descriptorObject("ShpC", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(options.contour ? "Glow Ramp" : "Linear") },
		{ key: "Crv ", type: "VlLs", value: descriptorList(...contourPoints.map(([x, y]) => contourPoint(x, y))) },
	]);
	const effect = (classId: "OrGl" | "IrGl", color: [number, number, number], dialog: boolean): Buffer =>
		descriptorObject(classId, [
			{ key: "enab", type: "bool", value: Buffer.from([1]) },
			{ key: "present", type: "bool", value: Buffer.from([1]) },
			{ key: "showInDialog", type: "bool", value: Buffer.from([dialog ? 1 : 0]) },
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: f64(color[0]) },
					{ key: "Grn ", type: "doub", value: f64(color[1]) },
					{ key: "Bl  ", type: "doub", value: f64(color[2]) },
				]),
			},
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 50) },
			{ key: "GlwT", type: "enum", value: descriptorEnum("BETE", options.technique ?? "SfBL") },
			{ key: "glwS", type: "enum", value: descriptorEnum("IGSr", classId === "IrGl" ? (options.innerSource ?? "SrcE") : "SrcE") },
			{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 1) },
			{ key: "Ckmt", type: "UntF", value: descriptorUnit("#Pxl", options.choke ?? 0) },
			{ key: "Nose", type: "UntF", value: descriptorUnit("#Prc", options.noise ?? 0) },
			{ key: "Inpr", type: "UntF", value: descriptorUnit("#Prc", options.range ?? 50) },
			{ key: "ShdN", type: "UntF", value: descriptorUnit("#Prc", options.jitter ?? 0) },
			{ key: "AntA", type: "bool", value: Buffer.from([options.antialiased === false ? 0 : 1]) },
			{ key: "TrnS", type: "Objc", value: contour },
		]);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: "OrGl", type: "Objc", value: effect("OrGl", [255, 255, 255], false) },
			{ key: "IrGl", type: "Objc", value: effect("IrGl", [255, 0, 0], true) },
		]),
	]);
}

function modernBevelSatinEffects(
	options: {
		style?: "OtrB" | "InrB" | "Embs" | "PlEb" | "strokeEmboss";
		technique?: "SfBL" | "PrBL" | "Slmt";
		direction?: "In  " | "Out ";
		useShape?: boolean;
		useTexture?: boolean;
		includeSatin?: boolean;
	} = {}
): Buffer {
	const contourPoint = (x: number, y: number): Buffer =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: f64(x) },
			{ key: "Vrtc", type: "doub", value: f64(y) },
		]);
	const contour = (name: string, points: Array<[number, number]>): Buffer =>
		descriptorObject("ShpC", [
			{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(name) },
			{ key: "Crv ", type: "VlLs", value: descriptorList(...points.map(([x, y]) => contourPoint(x, y))) },
		]);
	const color = (rgb: [number, number, number]): Buffer =>
		descriptorObject("RGBC", [
			{ key: "Rd  ", type: "doub", value: f64(rgb[0]) },
			{ key: "Grn ", type: "doub", value: f64(rgb[1]) },
			{ key: "Bl  ", type: "doub", value: f64(rgb[2]) },
		]);
	const satin = descriptorObject("ChFX", [
		{ key: "enab", type: "bool", value: Buffer.from([options.includeSatin === false ? 0 : 1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([0]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Clr ", type: "Objc", value: color([0, 0, 255]) },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 50) },
		{ key: "lagl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Dstn", type: "UntF", value: descriptorUnit("#Pxl", 1) },
		{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 0) },
		{ key: "AntA", type: "bool", value: Buffer.from([1]) },
		{ key: "Invr", type: "bool", value: Buffer.from([0]) },
		{
			key: "MpgS",
			type: "Objc",
			value: contour("Custom Satin", [
				[0, 0],
				[128, 64],
				[255, 255],
			]),
		},
	]);
	const bevelEntries: Array<{ key: string; type: string; value: Buffer }> = [
		{ key: "enab", type: "bool", value: Buffer.from([1]) },
		{ key: "present", type: "bool", value: Buffer.from([1]) },
		{ key: "showInDialog", type: "bool", value: Buffer.from([1]) },
		{ key: "hglM", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "hglC", type: "Objc", value: color([255, 255, 255]) },
		{ key: "hglO", type: "UntF", value: descriptorUnit("#Prc", 50) },
		{ key: "sdwM", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "sdwC", type: "Objc", value: color([0, 0, 0]) },
		{ key: "sdwO", type: "UntF", value: descriptorUnit("#Prc", 50) },
		{ key: "bvlT", type: "enum", value: descriptorEnum("bvlT", options.technique ?? "SfBL") },
		{ key: "bvlS", type: "enum", value: descriptorEnum("BESl", options.style ?? "InrB") },
		{ key: "uglg", type: "bool", value: Buffer.from([0]) },
		{ key: "lagl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Lald", type: "UntF", value: descriptorUnit("#Ang", 90) },
		{ key: "srgR", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 1) },
		{ key: "bvlD", type: "enum", value: descriptorEnum("BESs", options.direction ?? "In  ") },
		{
			key: "TrnS",
			type: "Objc",
			value: contour("Linear", [
				[0, 0],
				[255, 255],
			]),
		},
		{ key: "antialiasGloss", type: "bool", value: Buffer.from([1]) },
		{ key: "Sftn", type: "UntF", value: descriptorUnit("#Pxl", 0) },
		{ key: "useShape", type: "bool", value: Buffer.from([options.useShape ? 1 : 0]) },
		{ key: "useTexture", type: "bool", value: Buffer.from([options.useTexture ? 1 : 0]) },
	];
	if (options.useShape) {
		bevelEntries.push(
			{
				key: "MpgS",
				type: "Objc",
				value: contour("Shape Ramp", [
					[0, 0],
					[128, 224],
					[255, 255],
				]),
			},
			{ key: "Inpr", type: "UntF", value: descriptorUnit("#Prc", 75) }
		);
	}
	if (options.useTexture) {
		bevelEntries.push(
			{
				key: "Ptrn",
				type: "Objc",
				value: descriptorObject("Ptrn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Checker") },
					{ key: "Idnt", type: "TEXT", value: descriptorUnicode("rgba-tile-2x2") },
				]),
			},
			{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "textureDepth", type: "UntF", value: descriptorUnit("#Prc", 80) },
			{ key: "Invr", type: "bool", value: Buffer.from([1]) }
		);
	}
	const bevel = descriptorObject("ebbl", bevelEntries);
	return Buffer.concat([
		u32(0),
		u32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: Buffer.from([1]) },
			{ key: "ChFX", type: "Objc", value: satin },
			{ key: "ebbl", type: "Objc", value: bevel },
		]),
	]);
}

function patternTaggedBlock(): Buffer {
	const channel = (plane: number[]): Buffer => {
		const data = Buffer.from(plane);
		return Buffer.concat([u32(1), u32(23 + data.length), u32(8), u32(0), u32(0), u32(2), u32(2), u16(8), Buffer.from([0]), data]);
	};
	const memory = Buffer.concat([
		u32(0),
		u32(0),
		u32(2),
		u32(2),
		u32(4),
		channel([255, 0, 0, 255]),
		channel([0, 255, 0, 255]),
		channel([0, 0, 255, 255]),
		channel([255, 128, 255, 255]),
		u32(0),
		u32(0),
	]);
	const body = Buffer.concat([
		u32(1),
		u32(3),
		i16(0),
		i16(0),
		descriptorUnicode("RGBA Tile"),
		Buffer.from([Buffer.byteLength("rgba-tile-2x2")]),
		Buffer.from("rgba-tile-2x2"),
		u32(3),
		u32(memory.length),
		memory,
	]);
	const record = Buffer.concat([u32(body.length), body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
	return Buffer.concat([Buffer.from("8BIMPatt"), u32(record.length), record, Buffer.alloc((4 - (record.length % 4)) % 4)]);
}

function legacySolidFillEffect(options: { color: [number, number, number]; opacity: number; enabled?: boolean; blendMode?: string }): Buffer {
	const common = Buffer.concat([Buffer.from("8BIMcmnS"), u32(7), u32(0), Buffer.from([1]), u16(0)]);
	const color = effectColor(...options.color);
	const solidFill = Buffer.concat([
		u32(2),
		Buffer.from("8BIM"),
		Buffer.from(options.blendMode ?? "norm"),
		color,
		Buffer.from([options.opacity, options.enabled === false ? 0 : 1]),
		color,
	]);
	return Buffer.concat([u16(0), u16(2), common, Buffer.from("8BIMsofi"), u32(solidFill.length), solidFill]);
}

function legacyInnerShadowEffect(options: { color: [number, number, number]; blur: number; intensity: number; angle: number; distance: number; opacity: number }): Buffer {
	const common = Buffer.concat([Buffer.from("8BIMcmnS"), u32(7), u32(0), Buffer.from([1]), u16(0)]);
	const color = effectColor(...options.color);
	const shadow = Buffer.concat([
		u32(2),
		u32(options.blur),
		u32(options.intensity),
		i32(options.angle),
		u32(options.distance),
		color,
		Buffer.from("8BIMnorm"),
		Buffer.from([1, 0, options.opacity]),
		color,
	]);
	return Buffer.concat([u16(0), u16(2), common, Buffer.from("8BIMisdw"), u32(shadow.length), shadow]);
}

function legacyInnerGlowEffect(options: { color: [number, number, number]; blur: number; intensity: number; opacity: number; invert?: boolean }): Buffer {
	const common = Buffer.concat([Buffer.from("8BIMcmnS"), u32(7), u32(0), Buffer.from([1]), u16(0)]);
	const color = effectColor(...options.color);
	const glow = Buffer.concat([
		u32(2),
		u32(options.blur),
		u32(options.intensity),
		color,
		Buffer.from("8BIMnorm"),
		Buffer.from([1, options.opacity, options.invert ? 1 : 0]),
		color,
	]);
	return Buffer.concat([u16(0), u16(2), common, Buffer.from("8BIMiglw"), u32(glow.length), glow]);
}

function legacyDropShadowEffect(options: { color: [number, number, number]; blur: number; intensity: number; angle: number; distance: number; opacity: number }): Buffer {
	const common = Buffer.concat([Buffer.from("8BIMcmnS"), u32(7), u32(0), Buffer.from([1]), u16(0)]);
	const color = effectColor(...options.color);
	const shadow = Buffer.concat([
		u32(2),
		u32(options.blur),
		u32(options.intensity),
		i32(options.angle),
		u32(options.distance),
		color,
		Buffer.from("8BIMmul "),
		Buffer.from([1, 0, options.opacity]),
		color,
	]);
	return Buffer.concat([u16(0), u16(2), common, Buffer.from("8BIMdsdw"), u32(shadow.length), shadow]);
}

function legacyOuterGlowEffect(options: { color: [number, number, number]; blur: number; intensity: number; opacity: number }): Buffer {
	const common = Buffer.concat([Buffer.from("8BIMcmnS"), u32(7), u32(0), Buffer.from([1]), u16(0)]);
	const color = effectColor(...options.color);
	const glow = Buffer.concat([u32(2), u32(options.blur), u32(options.intensity), color, Buffer.from("8BIMscrn"), Buffer.from([1, options.opacity]), color]);
	return Buffer.concat([u16(0), u16(2), common, Buffer.from("8BIMoglw"), u32(glow.length), glow]);
}

function legacyBevelEffect(options: {
	highlightColor: [number, number, number];
	shadowColor: [number, number, number];
	angle: number;
	strength: number;
	blur: number;
	highlightOpacity: number;
	shadowOpacity: number;
	style?: number;
	direction?: number;
}): Buffer {
	const common = Buffer.concat([Buffer.from("8BIMcmnS"), u32(7), u32(0), Buffer.from([1]), u16(0)]);
	const highlightColor = effectColor(...options.highlightColor);
	const shadowColor = effectColor(...options.shadowColor);
	const bevel = Buffer.concat([
		u32(2),
		i32(options.angle),
		u32(options.strength),
		u32(options.blur),
		Buffer.from("8BIMscrn"),
		Buffer.from("8BIMmul "),
		highlightColor,
		shadowColor,
		Buffer.from([options.style ?? 1, options.highlightOpacity, options.shadowOpacity, 1, 0, options.direction ?? 0]),
		highlightColor,
		shadowColor,
	]);
	return Buffer.concat([u16(0), u16(2), common, Buffer.from("8BIMbevl"), u32(bevel.length), bevel]);
}

function layer(options: {
	name: string;
	id: number;
	left: number;
	top: number;
	width: number;
	height: number;
	visible: boolean;
	opacity: number;
	rgba: number[];
	clipping?: boolean;
	transparencyProtected?: boolean;
	omitAlpha?: boolean;
	blendMode?: string;
	additionalInfo?: Buffer[];
	adjustmentOnly?: boolean;
	psb?: boolean;
	depth?: 8 | 16 | 32;
	mask?: {
		top: number;
		left: number;
		width: number;
		height: number;
		plane: number[];
		defaultColor?: number;
		disabled?: boolean;
		inverted?: boolean;
		positionRelativeToLayer?: boolean;
		userDensity?: number;
		userFeather?: number;
		vectorDensity?: number;
		vectorFeather?: number;
		realUserMask?: {
			top: number;
			left: number;
			width: number;
			height: number;
			plane: number[];
			defaultColor?: number;
			disabled?: boolean;
			inverted?: boolean;
			positionRelativeToLayer?: boolean;
		};
	};
}): {
	record: Buffer;
	data: Buffer;
} {
	const encodePlane = (values: number[], coverage: boolean): Buffer => {
		if (options.depth === 32) {
			return Buffer.concat(
				values.map((value) => {
					const normalized = value / 255;
					const sample = coverage ? normalized : normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
					const bytes = Buffer.alloc(4);
					bytes.writeFloatBE(sample);
					return bytes;
				})
			);
		}
		return options.depth === 16 ? Buffer.from(values.flatMap((value) => [value, value])) : Buffer.from(values);
	};
	const channelEntries = options.adjustmentOnly
		? []
		: [0, 1, 2, ...(options.omitAlpha ? [] : [3])].map((channel, index) => {
				const id = index === 3 ? -1 : index;
				return {
					id,
					plane: encodePlane(
						options.rgba.filter((_value, offset) => offset % 4 === channel),
						id < 0
					),
				};
			});
	if (options.mask) channelEntries.push({ id: -2, plane: encodePlane(options.mask.plane, true) });
	if (options.mask?.realUserMask) channelEntries.push({ id: -3, plane: encodePlane(options.mask.realUserMask.plane, true) });
	const data = channelEntries.map((channel) => Buffer.concat([u16(0), channel.plane]));
	const hasMaskParameters =
		options.mask?.userDensity !== undefined ||
		options.mask?.userFeather !== undefined ||
		options.mask?.vectorDensity !== undefined ||
		options.mask?.vectorFeather !== undefined;
	const maskFlags =
		(options.mask?.positionRelativeToLayer ? 0x01 : 0) | (options.mask?.disabled ? 0x02 : 0) | (options.mask?.inverted ? 0x04 : 0) | (hasMaskParameters ? 0x10 : 0);
	const realMaskFlags =
		(options.mask?.realUserMask?.positionRelativeToLayer ? 0x01 : 0) | (options.mask?.realUserMask?.disabled ? 0x02 : 0) | (options.mask?.realUserMask?.inverted ? 0x04 : 0);
	const parameterFlags =
		(options.mask?.userDensity !== undefined ? 0x01 : 0) |
		(options.mask?.userFeather !== undefined ? 0x02 : 0) |
		(options.mask?.vectorDensity !== undefined ? 0x04 : 0) |
		(options.mask?.vectorFeather !== undefined ? 0x08 : 0);
	const maskParameters = hasMaskParameters
		? Buffer.concat([
				Buffer.from([parameterFlags]),
				...(options.mask?.userDensity !== undefined ? [Buffer.from([options.mask.userDensity])] : []),
				...(options.mask?.userFeather !== undefined ? [f64(options.mask.userFeather)] : []),
				...(options.mask?.vectorDensity !== undefined ? [Buffer.from([options.mask.vectorDensity])] : []),
				...(options.mask?.vectorFeather !== undefined ? [f64(options.mask.vectorFeather)] : []),
			])
		: Buffer.alloc(0);
	const maskData = options.mask
		? Buffer.concat([
				i32(options.mask.top),
				i32(options.mask.left),
				i32(options.mask.top + options.mask.height),
				i32(options.mask.left + options.mask.width),
				Buffer.from([options.mask.defaultColor ?? 255, maskFlags]),
				maskParameters,
				...(options.mask.realUserMask
					? [
							Buffer.from([realMaskFlags, options.mask.realUserMask.defaultColor ?? 255]),
							i32(options.mask.realUserMask.top),
							i32(options.mask.realUserMask.left),
							i32(options.mask.realUserMask.top + options.mask.realUserMask.height),
							i32(options.mask.realUserMask.left + options.mask.realUserMask.width),
						]
					: hasMaskParameters
						? []
						: [Buffer.alloc(2)]),
			])
		: Buffer.alloc(0);
	const extra = Buffer.concat([
		u32(maskData.length),
		maskData,
		u32(0),
		pascal(options.name),
		additional("luni", unicodeName(options.name)),
		additional("lyid", u32(options.id)),
		...(options.additionalInfo ?? []),
	]);
	return {
		record: Buffer.concat([
			i32(options.top),
			i32(options.left),
			i32(options.top + options.height),
			i32(options.left + options.width),
			u16(channelEntries.length),
			...channelEntries.map((channel, index) => Buffer.concat([i16(channel.id), options.psb ? u64(data[index].length) : u32(data[index].length)])),
			Buffer.from(`8BIM${options.blendMode ?? "norm"}`),
			Buffer.from([options.opacity, options.clipping ? 1 : 0, (options.visible ? 0 : 2) | (options.transparencyProtected ? 1 : 0), 0]),
			u32(extra.length),
			extra,
		]),
		data: Buffer.concat(data),
	};
}

function createLayeredPsd(
	layers = [
		layer({ name: "Hero Body", id: 101, left: 2, top: 1, width: 2, height: 1, visible: true, opacity: 128, rgba: [255, 0, 0, 255, 0, 255, 0, 64] }),
		layer({ name: "Hidden FX", id: 102, left: 0, top: 0, width: 1, height: 1, visible: false, opacity: 255, rgba: [0, 0, 255, 255] }),
	],
	dimensions: { width: number; height: number } = { width: 5, height: 4 },
	globalBlocks = Buffer.alloc(0),
	psb = false,
	depth: 8 | 16 | 32 = 8
): Buffer {
	let layerInfo = Buffer.concat([i16(layers.length), ...layers.map((entry) => entry.record), ...layers.map((entry) => entry.data)]);
	if (layerInfo.length & 1) layerInfo = Buffer.concat([layerInfo, Buffer.alloc(1)]);
	const layerAndMask = Buffer.concat([psb ? u64(layerInfo.length) : u32(layerInfo.length), layerInfo, u32(0), globalBlocks]);
	const header = Buffer.alloc(26);
	header.write("8BPS", 0, "ascii");
	header.writeUInt16BE(psb ? 2 : 1, 4);
	header.writeUInt16BE(3, 12);
	header.writeUInt32BE(dimensions.height, 14);
	header.writeUInt32BE(dimensions.width, 18);
	header.writeUInt16BE(depth, 22);
	header.writeUInt16BE(3, 24);
	return Buffer.concat([
		header,
		u32(0),
		u32(0),
		psb ? u64(layerAndMask.length) : u32(layerAndMask.length),
		layerAndMask,
		u16(0),
		Buffer.alloc(dimensions.width * dimensions.height * 3 * (depth === 32 ? 4 : depth === 16 ? 2 : 1)),
	]);
}

function createCompositePsd(width: number, height: number, rgba: number[]): Buffer {
	if (rgba.length !== width * height * 4) throw new Error("Composite PSD fixture requires exact RGBA pixels.");
	const header = Buffer.alloc(26);
	header.write("8BPS", 0, "ascii");
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(4, 12);
	header.writeUInt32BE(height, 14);
	header.writeUInt32BE(width, 18);
	header.writeUInt16BE(8, 22);
	header.writeUInt16BE(3, 24);
	const planes = Buffer.concat(Array.from({ length: 4 }, (_, channel) => Buffer.from(rgba.filter((_, index) => index % 4 === channel))));
	return Buffer.concat([header, u32(0), u32(0), u32(0), u16(0), planes]);
}

describe("layered PSD sprite extraction", () => {
	let directory: string;
	let source: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-psd-layers-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await mkdir(join(directory, "assets"));
		await writeFile(projectConfiguration.path, "{}");
		source = join(directory, "assets", "hero.psd");
		await writeFile(source, createLayeredPsd());
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("plans and publishes deterministic opacity-baked PNG assets without overwriting", async () => {
		const planned = await getPsdLayerExtractionStatus(source);
		expect(planned).toMatchObject({
			path: "assets/hero.psd",
			destinationFolder: "assets/hero_layers",
			selectedLayerCount: 1,
			createdCount: 1,
			conflictCount: 0,
			document: { layerCount: 2 },
			items: [{ layerIndex: 0, name: "Hero Body", path: "assets/hero_layers/0001-Hero Body.png", left: 2, top: 1, width: 2, height: 1 }],
		});
		const applied = await applyPsdLayerExtraction(source, {}, planned.fingerprint);
		expect(applied.createdCount).toBe(1);
		const output = join(directory, applied.items[0].path);
		expect(await pathExists(output)).toBe(true);
		const pixels = await sharp(output).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([255, 0, 0, 128, 0, 255, 0, 32]);
		expect(await getPsdLayerExtractionStatus(source)).toMatchObject({ createdCount: 0, reusedCount: 1, conflictCount: 0 });
		await writeFile(output, Buffer.from("occupied"));
		const conflicted = await getPsdLayerExtractionStatus(source);
		expect(conflicted).toMatchObject({ conflictCount: 1 });
		await expect(applyPsdLayerExtraction(source, {}, planned.fingerprint)).rejects.toThrow("plan changed");
		expect((await readFile(output)).toString()).toBe("occupied");
	});

	test("plans and publishes bounded PSB-v2 layers with 64-bit section, channel, and 8B64 tagged-block lengths", async () => {
		const psbSource = join(directory, "assets", "large-document.psb");
		await writeFile(
			psbSource,
			createLayeredPsd(
				[
					layer({
						name: "PSB Hero",
						id: 554,
						left: 1,
						top: 2,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [220, 40, 60, 255, 10, 140, 230, 128],
						additionalInfo: [additional64("LMsk", Buffer.alloc(0))],
						psb: true,
					}),
				],
				{ width: 4, height: 4 },
				Buffer.alloc(0),
				true
			)
		);
		const planned = await getPsdLayerExtractionStatus(psbSource, { destinationFolder: "assets/psb-layers" });
		expect(planned).toMatchObject({
			path: "assets/large-document.psb",
			document: { version: 2, format: "psb-v2", width: 4, height: 4, layerCount: 1 },
			selectedLayerCount: 1,
			createdCount: 1,
			conflictCount: 0,
			items: [{ layerIndex: 0, name: "PSB Hero", left: 1, top: 2, width: 2, height: 1 }],
		});
		const applied = await applyPsdLayerExtraction(psbSource, { destinationFolder: "assets/psb-layers" }, planned.fingerprint);
		expect(applied).toMatchObject({ createdCount: 1, reusedCount: 0, conflictCount: 0 });
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([220, 40, 60, 255, 10, 140, 230, 128]);
		expect(await getPsdLayerExtractionStatus(psbSource, { destinationFolder: "assets/psb-layers" })).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		["psd", 16, false, "bounded-uint16-to-rgba8-v1"],
		["psb", 16, true, "bounded-uint16-to-rgba8-v1"],
		["psd", 32, false, "bounded-linear-float32-to-rgba8-v1"],
		["psb", 32, true, "bounded-linear-float32-to-rgba8-v1"],
	] as const)("publishes exact %s %i-bit layer, alpha, mask, Inspector, and shared MCP conversion evidence", async (format, depth, psb, conversionModel) => {
		const highDepthSource = join(directory, "assets", `high-depth.${format}`);
		await writeFile(
			highDepthSource,
			createLayeredPsd(
				[
					layer({
						name: `${depth}-bit Hero`,
						id: 500 + depth,
						left: 0,
						top: 0,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [0, 128, 1, 255, 255, 10, 2, 255],
						mask: { top: 0, left: 0, width: 2, height: 1, plane: [255, 128] },
						psb,
						depth,
					}),
				],
				{ width: 2, height: 1 },
				Buffer.alloc(0),
				psb,
				depth
			)
		);
		const planned = await getPsdLayerExtractionStatus(highDepthSource, { destinationFolder: `assets/${format}-${depth}-layers` });
		expect(planned).toMatchObject({
			document: {
				version: psb ? 2 : 1,
				format: psb ? "psb-v2" : "psd-v1",
				depth,
				sampleByteLength: depth / 8,
				channelConversionModel: conversionModel,
				layers: [{ channels: expect.any(Array) }],
			},
			selectedLayerCount: 1,
			createdCount: 1,
		});
		expect(planned.document.layers[0].channels.every((channel) => channel.depth === depth && channel.conversionModel === conversionModel)).toBe(true);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const mcpPlan = await inspectPsdLayerExtraction(scene, { path: `assets/high-depth.${format}`, destinationFolder: `assets/${format}-${depth}-layers` });
		expect(mcpPlan).toMatchObject({
			fingerprint: planned.fingerprint,
			document: { depth, sampleByteLength: depth / 8, channelConversionModel: conversionModel },
		});
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(highDepthSource, { destinationFolder: `assets/${format}-${depth}-layers` }, planned.fingerprint);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([0, 128, 1, 255, 255, 10, 2, 128]);
	});

	test("preserves bounded TySh text semantics while publishing Photoshop embedded raster pixels", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "HUD Label",
					id: 948,
					left: 3,
					top: 4,
					width: 2,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [10, 20, 30, 255, 40, 50, 60, 128],
					additionalInfo: [
						additional(
							"TySh",
							tyshText("Play\rNow", {
								fonts: ["Inter Test"],
								styles: [
									{
										length: 8,
										fontIndex: 0,
										fontSize: 18,
										fauxBold: true,
										fauxItalic: false,
										tracking: 25,
										color: [255, 64, 32, 255],
									},
								],
								paragraph: {
									justification: 2,
									firstLineIndent: 12,
									startIndent: 8,
									endIndent: 6,
									spaceBefore: 4,
									spaceAfter: 5,
									autoHyphenate: true,
									autoLeading: 1.2,
									everyLineComposer: true,
								},
								shape: { type: "box", boxBounds: [0, 0, 160, 80] },
							})
						),
					],
				}),
			])
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/text-layers" });
		expect(plan.document.layers[0].text).toMatchObject({
			text: "Play\nNow",
			textIndex: 7,
			transform: [1, 0, 0, 1, 12, 34],
			orientation: "horizontal",
			antiAlias: "smooth",
			shapeType: "box",
			pointBase: null,
			boxBounds: [0, 0, 160, 80],
			bounds: { left: 0, top: 0, right: 2, bottom: 1, units: "#Pxl" },
			warp: { style: "warpNone", rotate: "horizontal" },
			engineTextMatchesDescriptor: true,
			fonts: [{ index: 0, name: "Inter Test" }],
			styleRuns: [{ length: 8, fontIndex: 0, fontName: "Inter Test", fontSize: 18, fauxBold: true, fauxItalic: false, tracking: 25, fillColor: [255, 64, 32, 255] }],
			paragraphRuns: [
				{
					length: 8,
					justification: "center",
					firstLineIndent: 12,
					startIndent: 8,
					endIndent: 6,
					spaceBefore: 4,
					spaceAfter: 5,
					autoHyphenate: true,
					autoLeading: 1.2,
					everyLineComposer: true,
				},
			],
			engineDataWarning: null,
			executionModel: "bounded-tysh-text-v1",
		});
		expect(plan.items[0].textLayer).toMatchObject({ executionModel: "bounded-tysh-text-v1", rasterExecutionModel: "embedded-text-raster-v1" });
		const applied = await applyPsdLayerExtraction(source, { destinationFolder: "assets/text-layers" }, plan.fingerprint);
		expect(applied.items[0].textLayer?.text).toBe("Play\nNow");
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([10, 20, 30, 255, 40, 50, 60, 128]);
	});

	test("preserves bounded smart-object placement semantics while publishing its embedded preview raster", async () => {
		const sourcePath = join(directory, "assets/smart-object.psd");
		await writeFile(
			sourcePath,
			createLayeredPsd([
				layer({
					name: "Placed Hero",
					id: 4690,
					left: 0,
					top: 0,
					width: 2,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [12, 34, 56, 255, 78, 90, 123, 160],
					additionalInfo: [additional("SoLd", smartObjectLayer())],
				}),
			])
		);
		const status = await getPsdLayerExtractionStatus(sourcePath, { destinationFolder: "assets/smart-object-layers" });
		expect(status.document.layers[0].smartObject).toEqual({
			sourceKey: "SoLd",
			version: 4,
			id: "codex-smart-resource",
			placedId: "codex-smart-instance",
			type: "raster",
			pageNumber: 1,
			totalPages: 2,
			transform: [10, 20, 74, 20, 74, 52, 10, 52],
			nonAffineTransform: [10, 20, 75, 19, 74, 52, 9, 53],
			width: 64,
			height: 32,
			resolution: { units: "#Rsl", value: 300 },
			crop: 1,
			comp: 9,
			compInfo: { compId: 9, originalCompId: 7 },
			frameStep: { numerator: 1, denominator: 24 },
			duration: { numerator: 48, denominator: 24 },
			frameCount: 48,
			warp: {
				style: "warpNone",
				value: 0,
				perspective: 0,
				perspectiveOther: 0,
				rotate: "horizontal",
				bounds: null,
				uOrder: null,
				vOrder: null,
				deformNumRows: null,
				deformNumCols: null,
				meshPoints: [],
				quiltSliceX: [],
				quiltSliceY: [],
				meshExecutionModel: null,
				meshExecutionSupported: false,
				meshWarning: null,
			},
			filterCount: 0,
			smartFilterState: null,
			smartFilters: [],
			smartFilterMask: null,
			smartFilterMaskWarning: null,
			linkedResource: { status: "missing", resourceIndices: [] },
			executionModel: "bounded-smart-object-v1",
		});
		expect(status.items[0].smartObjectLayer).toMatchObject({
			executionModel: "bounded-smart-object-v1",
			rasterExecutionModel: "embedded-smart-object-raster-v1",
		});
		expect(status.items[0].warnings).toContain(
			"Smart-object placement metadata is preserved, while extraction uses the PSD's embedded preview raster by default; opt-in live embedded or explicitly bound external rendering executes the supported ordered smart-filter subset with supported blend modes and FEid/FXid mask coverage plus projective, standard analytical preset, exact tensor, or exact quilt placement."
		);
		const result = await applyPsdLayerExtraction(sourcePath, { destinationFolder: "assets/smart-object-layers" }, status.fingerprint);
		const output = await sharp(join(directory, result.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([12, 34, 56, 255, 78, 90, 123, 160]);
	});

	test("renders an exact embedded PSD-v1 smart-object source through authored placement, masks, leases, and publication", async () => {
		const sourcePath = join(directory, "assets/live-smart-object.psd");
		const embeddedPixels = [255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 255, 255, 255, 0];
		const embeddedPsd = createCompositePsd(2, 2, embeddedPixels);
		const embedded = linkedResourceRecord({
			type: "liFD",
			id: "codex-smart-resource",
			name: "Live Hero.psd",
			fileType: "PSD",
			creator: "8BIM",
			data: embeddedPsd,
		});
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Live Placed Hero",
						id: 4760,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [9, 8, 7, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [5, 7, 7, 7, 7, 9, 5, 9], nonAffineTransform: null }))],
					}),
				],
				{ width: 8, height: 10 },
				globalAdditional("lnk2", embedded)
			)
		);
		const options = { destinationFolder: "assets/live-smart-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan).toMatchObject({
			renderEmbeddedSmartObjects: true,
			requestedSmartObjectRenderLayerIndices: null,
			items: [
				{
					left: 5,
					top: 7,
					width: 2,
					height: 2,
					smartObjectLayer: { rasterExecutionModel: "bounded-projective-smart-object-v1" },
					appliedSmartObjectRenders: [
						{
							layerIndex: 0,
							resourceIndex: 0,
							resourceId: "codex-smart-resource",
							sourceWidth: 2,
							sourceHeight: 2,
							transformSource: "transform",
							corners: [5, 7, 7, 7, 7, 9, 5, 9],
							left: 5,
							top: 7,
							width: 2,
							height: 2,
							sampling: "premultiplied-bilinear",
							warpStyle: "warpNone",
							filterCount: 0,
							maskCoverageMinimum: 255,
							maskCoverageMaximum: 255,
							executionModel: "bounded-projective-smart-object-v1",
						},
					],
				},
			],
		});
		expect(plan.items[0].warnings.some((warning) => warning.includes("embedded preview raster"))).toBe(false);
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 0, 0, 0, 0]);
		const reused = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(reused).toMatchObject({ createdCount: 0, reusedCount: 1 });
		expect(reused.fingerprint).not.toBe(plan.fingerprint);
		await expect(applyPsdLayerExtraction(sourcePath, { ...options, smartObjectRenderLayerIndices: [0] }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("blocks unselected, unknown-warp, unsupported-filter, and non-PSD embedded smart-object live rendering", async () => {
		await expect(getPsdLayerExtractionStatus(source, { smartObjectRenderLayerIndices: [0] })).rejects.toThrow(
			"requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true"
		);
		const fixture = async (name: string, smart: Buffer, payload: Buffer): Promise<string> => {
			const path = join(directory, "assets", name);
			await writeFile(
				path,
				createLayeredPsd(
					[
						layer({
							name: "Blocked Smart",
							id: 4761,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [1, 2, 3, 255],
							additionalInfo: [additional("SoLd", smart)],
						}),
					],
					{ width: 2, height: 2 },
					globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "blocked.psd", fileType: "PSD", data: payload }))
				)
			);
			return path;
		};
		const validPayload = createCompositePsd(1, 1, [1, 2, 3, 255]);
		await expect(
			getPsdLayerExtractionStatus(await fixture("warped.psd", smartObjectLayer({ warpStyle: "warpUnknown" }), validPayload), { renderEmbeddedSmartObjects: true })
		).rejects.toThrow("unsupported warp style");
		await expect(
			getPsdLayerExtractionStatus(await fixture("filtered.psd", smartObjectLayer({ filterCount: 1 }), validPayload), { renderEmbeddedSmartObjects: true })
		).rejects.toThrow("cannot execute");
		await expect(
			getPsdLayerExtractionStatus(await fixture("masked-filter.psd", smartObjectLayer({ smartFilterMaskEnabled: true, smartFilters: [{ type: "invert" }] }), validPayload), {
				renderEmbeddedSmartObjects: true,
			})
		).rejects.toThrow("mask");
		await expect(
			getPsdLayerExtractionStatus(await fixture("blended-filter.psd", smartObjectLayer({ smartFilters: [{ type: "invert", blendMode: "Dslv" }] }), validPayload), {
				renderEmbeddedSmartObjects: true,
			})
		).rejects.toThrow("not supported");
		await expect(
			getPsdLayerExtractionStatus(await fixture("oversized-filter.psd", smartObjectLayer({ smartFilters: [{ type: "gaussianBlur", radius: 17 }] }), validPayload), {
				renderEmbeddedSmartObjects: true,
			})
		).rejects.toThrow("between 0 and 16 pixels");
		await expect(
			getPsdLayerExtractionStatus(
				await fixture("disabled-filter-stack.psd", smartObjectLayer({ smartFilterStackEnabled: false, smartFilters: [{ type: "unsupported" }] }), validPayload),
				{ renderEmbeddedSmartObjects: true }
			)
		).resolves.toMatchObject({
			items: [{ appliedSmartObjectRenders: [{ smartFilterStackEnabled: false, appliedSmartFilters: [], smartFilterExecutionModel: "bounded-smart-filter-stack-v1" }] }],
		});
		await expect(getPsdLayerExtractionStatus(await fixture("non-psd.psd", smartObjectLayer(), Buffer.from("not-a-psd")), { renderEmbeddedSmartObjects: true })).rejects.toThrow(
			"not a supported bounded raster source"
		);
		await expect(
			getPsdLayerExtractionStatus(await fixture("unused.psd", smartObjectLayer(), validPayload), {
				renderEmbeddedSmartObjects: true,
				smartObjectRenderLayerIndices: [0],
				layerIndices: [],
			})
		).rejects.toThrow("do not contribute");
	});

	test.each(
		([false, true] as const).flatMap((psb) =>
			([8, 16, 32] as const).flatMap((depth) => (["raw", "rle", "zip", "zipPrediction"] as const).map((compression) => [psb, depth, compression] as const))
		)
	)("decodes exact %s PSB flag, %i-bit %s FEid smart-filter mask coverage", (psb, depth, compression) => {
		const placedId = `mask-${psb ? "psb" : "psd"}-${depth}-${compression}`;
		const embeddedPsd = createCompositePsd(1, 1, [20, 40, 60, 255]);
		const linked = linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "mask-source.psd", fileType: "PSD", data: embeddedPsd });
		const bytes = createLayeredPsd(
			[
				layer({
					name: "Masked Smart",
					id: 5570,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ placedId, smartFilterMaskEnabled: true, smartFilters: [{ type: "invert" }] }))],
					psb,
					depth,
				}),
			],
			{ width: 3, height: 1 },
			Buffer.concat([
				psb ? globalAdditionalPsb("lnk2", linked) : globalAdditional("lnk2", linked),
				smartFilterMaskBlock({ id: placedId, width: 3, height: 1, depth, compression, coverage: [0, 128, 255], psb }),
			]),
			psb,
			depth
		);
		const document = inspectPsdLayers(bytes);
		expect(document.layers[0].smartObject).toMatchObject({
			placedId,
			smartFilterState: { maskEnabled: true },
			smartFilterMask: {
				id: placedId,
				sourceKey: "FEid",
				version: 3,
				depth,
				compression,
				width: 3,
				height: 1,
				executionModel: "bounded-smart-filter-mask-v1",
			},
			smartFilterMaskWarning: null,
		});
		const decoded = decodePsdSmartFilterMasks(bytes);
		expect(decoded).toHaveLength(1);
		expect(decoded[0]).toMatchObject({ id: placedId, depth, compression, coverageMinimum: 0, coverageMaximum: 255 });
		expect([...decoded[0].coverage]).toEqual([0, 128, 255]);
	});

	test("normalizes the complete supported Photoshop smart-filter blend set with exact execution evidence", () => {
		const modes = [
			["Nrml", "norm"],
			["Mltp", "mul "],
			["Scrn", "scrn"],
			["Ovrl", "over"],
			["Drkn", "dark"],
			["Lghn", "lite"],
			["CDdg", "div "],
			["CBrn", "idiv"],
			["HrdL", "hLit"],
			["SftL", "sLit"],
			["Dfrn", "diff"],
			["Xclu", "smud"],
			["linearDodge", "lddg"],
			["linearBurn", "lbrn"],
			["blendSubtraction", "fsub"],
			["blendDivide", "fdiv"],
			["H   ", "hue "],
			["Strt", "sat "],
			["Clr ", "colr"],
			["Lmns", "lum "],
		] as const;
		const bytes = createLayeredPsd([
			layer({
				name: "Blend Set",
				id: 5572,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: modes.map(([blendMode]) => ({ type: "invert", blendMode })) }))],
			}),
		]);
		const filters = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters ?? [];
		expect(filters.map((filter) => [filter.blendMode, filter.normalizedBlendMode, filter.blendExecutionModel, filter.bakeSupported])).toEqual(
			modes.map(([raw, normalized]) => [raw, normalized, "bounded-smart-filter-blend-v1", true])
		);
	});

	test("maps all seven additional parameter-free smart-filter writer IDs to executable bounded algorithms", () => {
		const cases = [
			["despeckle", 1148416099, "bounded-despeckle-smart-filter-v1"],
			["facet", 1180922912, "bounded-facet-smart-filter-v1"],
			["fragment", 1181902701, "bounded-fragment-smart-filter-v1"],
			["sharpenEdges", 1399353925, "bounded-sharpen-edges-smart-filter-v1"],
			["findEdges", 1181639749, "bounded-find-edges-smart-filter-v1"],
			["solarize", 1399616122, "bounded-solarize-smart-filter-v1"],
			["ntscColors", 1314149187, "bounded-ntsc-colors-smart-filter-v1"],
		] as const;
		const bytes = createLayeredPsd([
			layer({
				name: "Additional Filter Set",
				id: 5580,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: cases.map(([type]) => ({ type })) }))],
			}),
		]);
		const filters = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters ?? [];
		expect(filters.map((filter) => [filter.type, filter.filterId, filter.algorithmExecutionModel, filter.bakeSupported, filter.warning])).toEqual(
			cases.map(([type, filterId, model]) => [type, filterId, model, true, null])
		);
	});

	test("maps parameterized Median, Maximum, Minimum, and High Pass writer descriptors to exact bounded radius evidence", () => {
		const cases = [
			["median", 1298427424, "Mdn ", 1, "bounded-median-smart-filter-v1"],
			["maximum", 1299737888, "Mxm ", 2.5, "bounded-maximum-smart-filter-v1"],
			["minimum", 1299082528, "Mnm ", 3, "bounded-minimum-smart-filter-v1"],
			["highPass", 1214736464, "HghP", 1.5, "bounded-high-pass-smart-filter-v1"],
		] as const;
		const bytes = createLayeredPsd([
			layer({
				name: "Parameterized Filter Set",
				id: 5590,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: cases.map(([type, , , radius]) => ({ type, radius })) }))],
			}),
		]);
		const filters = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters ?? [];
		expect(filters.map((filter) => [filter.type, filter.filterId, filter.filterClassId, filter.radius, filter.algorithmExecutionModel, filter.bakeSupported])).toEqual(
			cases.map(([type, filterId, filterClassId, radius, model]) => [type, filterId, filterClassId, radius, model, true])
		);
	});

	test("preserves but blocks invalid parameterized smart-filter radii and non-pixel units", () => {
		const cases = [
			[{ type: "median" as const, radius: 0 }, "median radius must be between 1 and 64 pixels"],
			[{ type: "maximum" as const, radius: 65 }, "maximum radius must be between 0.1 and 64 pixels"],
			[{ type: "minimum" as const, radius: 1, radiusUnits: "#Prc" }, "radius unit #Prc"],
			[{ type: "highPass" as const, radius: 0 }, "highPass radius must be between 0.1 and 64 pixels"],
		] as const;
		for (const [smartFilter, warning] of cases) {
			const bytes = createLayeredPsd([
				layer({
					name: "Invalid Radius",
					id: 5591,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [smartFilter] }))],
				}),
			]);
			expect(inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0]).toMatchObject({ bakeSupported: false, warning: expect.stringContaining(warning) });
		}
	});

	test("maps Motion Blur and Radial Blur writer descriptors to exact bounded parameter evidence", () => {
		const bytes = createLayeredPsd([
			layer({
				name: "Directional Filter Set",
				id: 5600,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [
					additional(
						"SoLd",
						smartObjectLayer({
							smartFilters: [
								{ type: "motionBlur", angleDegrees: -45, distance: 12.5 },
								{ type: "radialBlur", amount: 50, method: "spin", quality: "best" },
							],
						})
					),
				],
			}),
		]);
		const filters = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters ?? [];
		expect(
			filters.map((filter) => [
				filter.type,
				filter.filterId,
				filter.filterClassId,
				filter.motionBlur,
				filter.radialBlur,
				filter.algorithmExecutionModel,
				filter.bakeSupported,
			])
		).toEqual([
			["motionBlur", 1299476034, "MtnB", { angleDegrees: -45, distance: 12.5, distanceUnits: "#Pxl" }, null, "bounded-motion-blur-smart-filter-v1", true],
			["radialBlur", 1382313026, "RdlB", null, { amount: 50, method: "spin", quality: "best" }, "bounded-radial-blur-smart-filter-v1", true],
		]);
	});

	test("preserves but blocks invalid Motion Blur and Radial Blur parameters", () => {
		const cases = [
			[{ type: "motionBlur" as const, angleDegrees: 361, distance: 10 }, "angle must be an integer between -360 and 360"],
			[{ type: "motionBlur" as const, angleDegrees: 0, distance: 10, distanceUnits: "#Prc" }, "distance unit #Prc"],
			[{ type: "motionBlur" as const, angleDegrees: 0, distance: 2001 }, "distance must be between 1 and 2,000 pixels"],
			[{ type: "radialBlur" as const, amount: 0, method: "spin" as const, quality: "good" as const }, "integer amount 1-100"],
			[{ type: "radialBlur" as const, amount: 50, method: "unsupported" as const, quality: "good" as const }, "supported spin/zoom method"],
			[{ type: "radialBlur" as const, amount: 50, method: "zoom" as const, quality: "unsupported" as const }, "draft/good/best quality"],
		] as const;
		for (const [smartFilter, warning] of cases) {
			const bytes = createLayeredPsd([
				layer({
					name: "Invalid Directional Blur",
					id: 5601,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [smartFilter] }))],
				}),
			]);
			expect(inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0]).toMatchObject({ bakeSupported: false, warning: expect.stringContaining(warning) });
		}
	});

	test("maps Smart Blur and Surface Blur writer descriptors to exact bounded parameter evidence", () => {
		const bytes = createLayeredPsd([
			layer({
				name: "Edge-preserving Filter Set",
				id: 5610,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [
					additional(
						"SoLd",
						smartObjectLayer({
							smartFilters: [
								{ type: "smartBlur", radius: 2.5, threshold: 32.5, quality: "low", mode: "normal" },
								{ type: "smartBlur", radius: 3, threshold: 48, quality: "medium", mode: "edgeOnly" },
								{ type: "smartBlur", radius: 4, threshold: 64, quality: "high", mode: "overlayEdge" },
								{ type: "surfaceBlur", radius: 5, threshold: 72 },
							],
						})
					),
				],
			}),
		]);
		const filters = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters ?? [];
		expect(
			filters.map((filter) => [
				filter.type,
				filter.filterId,
				filter.filterClassId,
				filter.radius,
				filter.smartBlur,
				filter.surfaceBlur,
				filter.algorithmExecutionModel,
				filter.bakeSupported,
			])
		).toEqual([
			["smartBlur", 1399681602, "SmrB", 2.5, { threshold: 32.5, quality: "low", mode: "normal" }, null, "bounded-smart-blur-smart-filter-v1", true],
			["smartBlur", 1399681602, "SmrB", 3, { threshold: 48, quality: "medium", mode: "edgeOnly" }, null, "bounded-smart-blur-smart-filter-v1", true],
			["smartBlur", 1399681602, "SmrB", 4, { threshold: 64, quality: "high", mode: "overlayEdge" }, null, "bounded-smart-blur-smart-filter-v1", true],
			["surfaceBlur", 701, "surfaceBlur", 5, null, { threshold: 72, radiusUnits: "#Pxl" }, "bounded-surface-blur-smart-filter-v1", true],
		]);
	});

	test("preserves but blocks invalid Smart Blur and Surface Blur parameters", () => {
		const cases = [
			[{ type: "smartBlur" as const, radius: 0, threshold: 50, quality: "medium" as const, mode: "normal" as const }, "smartBlur radius must be between 0.1 and 100"],
			[{ type: "smartBlur" as const, radius: 2, threshold: 256, quality: "medium" as const, mode: "normal" as const }, "threshold 0-255"],
			[{ type: "smartBlur" as const, radius: 2, threshold: 50, quality: "unsupported" as const, mode: "normal" as const }, "low/medium/high quality"],
			[{ type: "smartBlur" as const, radius: 2, threshold: 50, quality: "high" as const, mode: "unsupported" as const }, "normal/edge-only/overlay-edge mode"],
			[{ type: "surfaceBlur" as const, radius: 2, threshold: 50, radiusUnits: "#Prc" }, "radius unit #Prc"],
			[{ type: "surfaceBlur" as const, radius: 0, threshold: 50 }, "surfaceBlur radius must be between 1 and 100"],
			[{ type: "surfaceBlur" as const, radius: 2, threshold: 256 }, "threshold must be an integer between 0 and 255"],
		] as const;
		for (const [smartFilter, warning] of cases) {
			const bytes = createLayeredPsd([
				layer({
					name: "Invalid Edge-preserving Blur",
					id: 5611,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [smartFilter] }))],
				}),
			]);
			expect(inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0]).toMatchObject({ bakeSupported: false, warning: expect.stringContaining(warning) });
		}
	});

	test("maps the real Photoshop Heart Card Shape Blur descriptor to exact bounded kernel evidence", () => {
		const bytes = createLayeredPsd([
			layer({
				name: "Heart Card Shape Blur",
				id: 5620,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "shapeBlur", radius: 10 }] }))],
			}),
		]);
		expect(inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0]).toMatchObject({
			type: "shapeBlur",
			filterId: 702,
			filterClassId: "shapeBlur",
			radius: 10,
			shapeBlur: {
				radiusUnits: "#Pxl",
				customShape: { name: "Heart Card", id: "e06d65dd-d132-11d5-9a4a-a011a4cb2b24" },
				kernel: "heartCard",
			},
			algorithmExecutionModel: "bounded-heart-card-shape-blur-smart-filter-v1",
			bakeSupported: true,
			warning: null,
		});
	});

	test("preserves but blocks unsupported or malformed Shape Blur presets", () => {
		const cases = [
			[{ type: "shapeBlur" as const, radius: 4 }, "radius must be between 5 and 1,000"],
			[{ type: "shapeBlur" as const, radius: 10, radiusUnits: "#Prc" }, "bounded execution requires pixels"],
			[{ type: "shapeBlur" as const, radius: 10, customShapeName: "Custom Star", customShapeId: "custom-star" }, "requires an explicit exact project-raster kernel binding"],
		] as const;
		for (const [smartFilter, warning] of cases) {
			const bytes = createLayeredPsd([
				layer({
					name: "Unsupported Shape Blur",
					id: 5621,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [smartFilter] }))],
				}),
			]);
			expect(inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0]).toMatchObject({ bakeSupported: false, warning: expect.stringContaining(warning) });
		}
	});

	test("rejects duplicate FEid identifiers and non-finite 32-bit smart-filter mask samples", () => {
		const duplicateBlock = smartFilterMaskBlock({ id: "duplicate-mask", width: 1, height: 1, coverage: [255] });
		expect(() => inspectPsdLayers(createLayeredPsd(undefined, undefined, Buffer.concat([duplicateBlock, duplicateBlock])))).toThrow("duplicate smart-filter mask identifier");
		const nonFinite = createLayeredPsd(undefined, undefined, smartFilterMaskBlock({ id: "non-finite-mask", width: 1, height: 1, depth: 32, coverage: [Number.NaN] }));
		expect(() => decodePsdSmartFilterMasks(nonFinite)).toThrow("non-finite 32-bit floating-point sample");
	});

	test("executes non-normal smart-filter blending through document-space FEid mask coverage with MCP-visible evidence", async () => {
		const sourcePath = join(directory, "assets/live-masked-blended-smart-object.psd");
		const embeddedPsd = createCompositePsd(2, 1, [100, 50, 20, 255, 50, 100, 200, 255]);
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Masked Multiply",
						id: 5571,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									placedId: "codex-mask-instance",
									transform: [0, 0, 2, 0, 2, 1, 0, 1],
									nonAffineTransform: null,
									smartFilterMaskEnabled: true,
									smartFilterMaskLinked: false,
									smartFilterMaskExtendWithWhite: false,
									smartFilters: [{ type: "invert", name: "Masked Multiply", blendMode: "Mltp" }],
								})
							),
						],
					}),
				],
				{ width: 2, height: 1 },
				Buffer.concat([
					globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "masked.psd", fileType: "PSD", data: embeddedPsd })),
					smartFilterMaskBlock({ id: "codex-mask-instance", width: 2, height: 1, coverage: [0, 128] }),
				])
			)
		);
		const options = { destinationFolder: "assets/live-masked-blended-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan.items[0]).toMatchObject({
			smartObjectLayer: {
				smartFilterMask: { id: "codex-mask-instance", sourceKey: "FEid", compression: "raw", executionModel: "bounded-smart-filter-mask-v1" },
				smartFilters: [
					{
						blendMode: "Mltp",
						normalizedBlendMode: "mul ",
						blendExecutionModel: "bounded-smart-filter-blend-v1",
						bakeSupported: true,
					},
				],
			},
			appliedSmartObjectRenders: [
				{
					smartFilterMaskEnabled: true,
					smartFilterMaskLinked: false,
					smartFilterMaskExtendWithWhite: false,
					smartFilterMaskId: "codex-mask-instance",
					smartFilterMaskCoverageMinimum: 0,
					smartFilterMaskCoverageMaximum: 128,
					smartFilterMaskExecutionModel: "bounded-smart-filter-mask-v1",
					appliedSmartFilters: [{ blendMode: "Mltp", normalizedBlendMode: "mul ", blendExecutionModel: "bounded-smart-filter-blend-v1" }],
				},
			],
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([100, 50, 20, 255, 45, 80, 121, 255]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
		await expect(applyPsdLayerExtraction(sourcePath, { ...options, smartObjectRenderLayerIndices: [0] }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("executes ordered embedded smart filters before authored placement with MCP-visible evidence", async () => {
		const sourcePath = join(directory, "assets/live-filtered-smart-object.psd");
		const embeddedPsd = createCompositePsd(2, 1, [10, 20, 30, 255, 110, 120, 130, 255]);
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Filtered Hero",
						id: 4790,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 2, 0, 2, 1, 0, 1],
									nonAffineTransform: null,
									smartFilters: [
										{ type: "invert", name: "Invert" },
										{ type: "average", name: "Average" },
									],
								})
							),
						],
					}),
				],
				{ width: 2, height: 1 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "filtered.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-filtered-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan.items[0]).toMatchObject({
			smartObjectLayer: {
				smartFilterState: { enabled: true, maskEnabled: false },
				smartFilters: [
					{ index: 0, name: "Invert", type: "invert", bakeSupported: true },
					{ index: 1, name: "Average", type: "average", bakeSupported: true },
				],
			},
			appliedSmartObjectRenders: [
				{
					filterCount: 2,
					smartFilterStackEnabled: true,
					appliedSmartFilters: [
						{ index: 0, type: "invert" },
						{ index: 1, type: "average" },
					],
					smartFilterExecutionModel: "bounded-smart-filter-stack-v1",
				},
			],
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output.slice(0, 4)]).toEqual([195, 185, 175, 255]);
		const reused = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(reused).toMatchObject({ createdCount: 0, reusedCount: 1 });
		await expect(applyPsdLayerExtraction(sourcePath, { ...options, smartObjectRenderLayerIndices: [0] }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("executes all seven additional parameter-free smart-filter families in authored order with exact MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-additional-smart-filters.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		const filters = ["despeckle", "facet", "fragment", "sharpenEdges", "findEdges", "solarize", "ntscColors"] as const;
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Additional Filters",
						id: 5581,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({ transform: [0, 0, 3, 0, 3, 3, 0, 3], nonAffineTransform: null, smartFilters: filters.map((type) => ({ type })) })
							),
						],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "additional.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-additional-smart-filters-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semanticFilters = plan.items[0].smartObjectLayer?.smartFilters ?? [];
		const appliedFilters = plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters;
		expect(semanticFilters.map((filter) => [filter.type, filter.algorithmExecutionModel, filter.bakeSupported])).toEqual([
			["despeckle", "bounded-despeckle-smart-filter-v1", true],
			["facet", "bounded-facet-smart-filter-v1", true],
			["fragment", "bounded-fragment-smart-filter-v1", true],
			["sharpenEdges", "bounded-sharpen-edges-smart-filter-v1", true],
			["findEdges", "bounded-find-edges-smart-filter-v1", true],
			["solarize", "bounded-solarize-smart-filter-v1", true],
			["ntscColors", "bounded-ntsc-colors-smart-filter-v1", true],
		]);
		expect(appliedFilters.map((filter) => [filter.index, filter.type, filter.algorithmExecutionModel])).toEqual(
			semanticFilters.map((filter) => [filter.index, filter.type, filter.algorithmExecutionModel])
		);
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			26, 26, 26, 255, 22, 22, 22, 255, 20, 20, 20, 255, 26, 26, 26, 255, 22, 22, 22, 255, 20, 20, 20, 255, 16, 16, 16, 255, 16, 16, 16, 255, 16, 16, 16, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("executes parameterized Median, Maximum, Minimum, and High Pass filters in authored order with exact MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-parameterized-smart-filters.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		const filters = [
			{ type: "median" as const, radius: 1 },
			{ type: "maximum" as const, radius: 1 },
			{ type: "minimum" as const, radius: 1 },
			{ type: "highPass" as const, radius: 1.5 },
		];
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Parameterized Filters",
						id: 5592,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 3, 0, 3, 3, 0, 3], nonAffineTransform: null, smartFilters: filters }))],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "parameterized.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-parameterized-smart-filters-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semanticFilters = plan.items[0].smartObjectLayer?.smartFilters ?? [];
		expect(semanticFilters.map((filter) => [filter.type, filter.radius, filter.algorithmExecutionModel, filter.bakeSupported])).toEqual([
			["median", 1, "bounded-median-smart-filter-v1", true],
			["maximum", 1, "bounded-maximum-smart-filter-v1", true],
			["minimum", 1, "bounded-minimum-smart-filter-v1", true],
			["highPass", 1.5, "bounded-high-pass-smart-filter-v1", true],
		]);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters.map((filter) => [filter.index, filter.type, filter.radius, filter.algorithmExecutionModel])).toEqual(
			semanticFilters.map((filter) => [filter.index, filter.type, filter.radius, filter.algorithmExecutionModel])
		);
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			88, 128, 115, 255, 50, 101, 117, 255, 184, 112, 118, 255, 75, 202, 97, 255, 86, 133, 101, 255, 172, 104, 104, 255, 109, 121, 174, 255, 140, 129, 141, 255, 189, 136,
			146, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("executes seeded Uniform and Gaussian Add Noise in authored order with exact MCP parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-add-noise-smart-filters.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		const filters = [
			{ type: "addNoise" as const, amount: 25, distribution: "uniform" as const, monochromatic: false, randomSeed: 123456 },
			{ type: "addNoise" as const, amount: 10, distribution: "gaussian" as const, monochromatic: true, randomSeed: -987654321 },
		];
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Seeded Add Noise",
						id: 5642,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 3, 0, 3, 3, 0, 3], nonAffineTransform: null, smartFilters: filters }))],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "add-noise.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-add-noise-smart-filters-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semanticFilters = plan.items[0].smartObjectLayer?.smartFilters ?? [];
		expect(semanticFilters.map((filter) => [filter.type, filter.addNoise, filter.algorithmExecutionModel, filter.bakeSupported])).toEqual([
			[
				"addNoise",
				{ amountPercent: 25, amountUnits: "#Prc", distribution: "uniform", monochromatic: false, randomSeed: 123456 },
				"bounded-seeded-add-noise-smart-filter-v1",
				true,
			],
			[
				"addNoise",
				{ amountPercent: 10, amountUnits: "#Prc", distribution: "gaussian", monochromatic: true, randomSeed: -987654321 },
				"bounded-seeded-add-noise-smart-filter-v1",
				true,
			],
		]);
		expect(
			plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters.map((filter) => [filter.index, filter.type, filter.addNoise, filter.algorithmExecutionModel])
		).toEqual(semanticFilters.map((filter) => [filter.index, filter.type, filter.addNoise, filter.algorithmExecutionModel]));
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			1, 59, 94, 255, 5, 48, 91, 255, 205, 32, 0, 255, 47, 173, 16, 255, 225, 242, 242, 255, 54, 43, 36, 255, 53, 0, 249, 255, 153, 170, 91, 255, 250, 0, 225, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("preserves malformed Add Noise descriptors as explicit non-executable evidence", async () => {
		const sourcePath = join(directory, "assets/malformed-add-noise-smart-filter.psd");
		await writeFile(
			sourcePath,
			createLayeredPsd([
				layer({
					name: "Malformed Add Noise",
					id: 5643,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "addNoise", amount: 401, distribution: "unsupported", randomSeed: 1 }] }))],
				}),
			])
		);
		const inspected = inspectPsdLayers(await readFile(sourcePath)).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({ type: "addNoise", addNoise: null, bakeSupported: false, algorithmExecutionModel: "bounded-seeded-add-noise-smart-filter-v1" });
		expect(inspected?.warning).toContain("0.1-400%");
	});

	test("executes Dust & Scratches with exact radius, threshold, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-dust-and-scratches-smart-filter.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 250, 0, 200, 128, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255]
		);
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Dust & Scratches",
						id: 5652,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 3, 0, 3, 3, 0, 3],
									nonAffineTransform: null,
									smartFilters: [{ type: "dustAndScratches", radius: 1, threshold: 100 }],
								})
							),
						],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "dust-and-scratches.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-dust-and-scratches-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semanticFilter = plan.items[0].smartObjectLayer?.smartFilters[0];
		expect(semanticFilter).toMatchObject({
			type: "dustAndScratches",
			dustAndScratches: { radius: 1, threshold: 100 },
			algorithmExecutionModel: "bounded-thresholded-median-dust-and-scratches-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "dustAndScratches",
			dustAndScratches: { radius: 1, threshold: 100 },
			algorithmExecutionModel: "bounded-thresholded-median-dust-and-scratches-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 128, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("preserves malformed Dust & Scratches descriptors as explicit non-executable evidence", async () => {
		const sourcePath = join(directory, "assets/malformed-dust-and-scratches-smart-filter.psd");
		await writeFile(
			sourcePath,
			createLayeredPsd([
				layer({
					name: "Malformed Dust & Scratches",
					id: 5653,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "dustAndScratches", radius: 101, threshold: 256 }] }))],
				}),
			])
		);
		const inspected = inspectPsdLayers(await readFile(sourcePath)).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "dustAndScratches",
			dustAndScratches: { radius: 101, threshold: 256 },
			bakeSupported: false,
			algorithmExecutionModel: "bounded-thresholded-median-dust-and-scratches-smart-filter-v1",
		});
		expect(inspected?.warning).toContain("radius 1-100");
	});

	test("executes Reduce Noise with exact channel, chroma, JPEG, sharpen, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-reduce-noise-smart-filter.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 128, 0, 0, 0, 0, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		const reduceNoise = {
			type: "reduceNoise" as const,
			preset: "Codex exact",
			removeJpegArtifact: true,
			reduceColorNoise: 60,
			sharpenDetails: 35,
			channelDenoise: [
				{ channels: ["composite" as const], amount: 7, preserveDetails: 25 },
				{ channels: ["red" as const], amount: 4, preserveDetails: 80 },
			],
		};
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Reduce Noise",
						id: 5662,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 3, 0, 3, 3, 0, 3], nonAffineTransform: null, smartFilters: [reduceNoise] }))],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "reduce-noise.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-reduce-noise-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = {
			preset: "Codex exact",
			removeJpegArtifact: true,
			reduceColorNoisePercent: 60,
			sharpenDetailsPercent: 35,
			channelDenoise: [
				{ channels: ["composite"], amount: 7, preserveDetailsPercent: 25 },
				{ channels: ["red"], amount: 4, preserveDetailsPercent: 80 },
			],
		};
		const semanticFilter = plan.items[0].smartObjectLayer?.smartFilters[0];
		expect(semanticFilter).toMatchObject({
			type: "reduceNoise",
			reduceNoise: expectedParameters,
			algorithmExecutionModel: "bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "reduceNoise",
			reduceNoise: expectedParameters,
			algorithmExecutionModel: "bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			0, 25, 18, 255, 57, 62, 77, 255, 191, 43, 33, 255, 78, 177, 115, 255, 255, 255, 255, 128, 0, 0, 0, 0, 71, 51, 159, 255, 164, 107, 125, 255, 226, 24, 155, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("preserves malformed Reduce Noise descriptors as explicit non-executable evidence", async () => {
		const sourcePath = join(directory, "assets/malformed-reduce-noise-smart-filter.psd");
		await writeFile(
			sourcePath,
			createLayeredPsd([
				layer({
					name: "Malformed Reduce Noise",
					id: 5663,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [
						additional(
							"SoLd",
							smartObjectLayer({
								smartFilters: [
									{
										type: "reduceNoise",
										preset: "",
										reduceColorNoise: 101,
										sharpenDetails: -1,
										channelDenoise: [{ channels: ["red"], amount: 11, preserveDetails: 101 }],
									},
								],
							})
						),
					],
				}),
			])
		);
		const inspected = inspectPsdLayers(await readFile(sourcePath)).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "reduceNoise",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1",
		});
		expect(inspected?.warning).toContain("0-100%");
		expect(() =>
			inspectPsdLayers(
				createLayeredPsd([
					layer({
						name: "Malformed Reduce Noise Reference",
						id: 5664,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "reduceNoise", channelReferenceType: "bad!" }] }))],
					}),
				])
			)
		).toThrow(/OSType bad!/);
	});

	test("executes Color Halftone with exact radius, CMYK angles, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-color-halftone-smart-filter.psd");
		const rgba = Array.from({ length: 16 }, (_, index) => [20 + index * 13, 230 - index * 9, 40 + (index % 4) * 45, index === 0 ? 0 : index === 10 ? 128 : 255]).flat();
		const embeddedPsd = createCompositePsd(4, 4, rgba);
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Color Halftone",
						id: 5672,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 4, 0, 4, 4, 0, 4],
									nonAffineTransform: null,
									smartFilters: [{ type: "colorHalftone", radius: 4, anglesDegrees: [108, 162, 90, 45] }],
								})
							),
						],
					}),
				],
				{ width: 4, height: 4 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "color-halftone.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-color-halftone-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { radius: 4, anglesDegrees: [108, 162, 90, 45] };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "colorHalftone",
			colorHalftone: expectedParameters,
			algorithmExecutionModel: "bounded-cmyk-screen-color-halftone-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "colorHalftone",
			colorHalftone: expectedParameters,
			algorithmExecutionModel: "bounded-cmyk-screen-color-halftone-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			0, 0, 0, 0, 143, 96, 255, 255, 48, 0, 255, 255, 0, 0, 48, 255, 255, 239, 255, 255, 255, 0, 255, 255, 255, 0, 239, 255, 159, 0, 80, 255, 143, 96, 143, 255, 223, 0, 207,
			255, 255, 0, 48, 128, 255, 0, 0, 255, 0, 0, 0, 255, 16, 0, 0, 255, 175, 0, 0, 255, 255, 0, 0, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("preserves invalid Color Halftone ranges and rejects missing channel-angle descriptors", async () => {
		const sourcePath = join(directory, "assets/malformed-color-halftone-smart-filter.psd");
		await writeFile(
			sourcePath,
			createLayeredPsd([
				layer({
					name: "Malformed Color Halftone",
					id: 5673,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "colorHalftone", radius: 3, anglesDegrees: [361, 0, 0, 0] }] }))],
				}),
			])
		);
		const inspected = inspectPsdLayers(await readFile(sourcePath)).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "colorHalftone",
			colorHalftone: { radius: 3, anglesDegrees: [361, 0, 0, 0] },
			bakeSupported: false,
			algorithmExecutionModel: "bounded-cmyk-screen-color-halftone-smart-filter-v1",
		});
		expect(inspected?.warning).toContain("radius 4-127");
		const missingAngle = createLayeredPsd([
			layer({
				name: "Missing Color Halftone Angle",
				id: 5674,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "colorHalftone", omitColorHalftoneAngle4: true }] }))],
			}),
		]);
		expect(inspectPsdLayers(missingAngle).layers[0].smartObject?.smartFilters[0]).toMatchObject({ type: "colorHalftone", colorHalftone: null, bakeSupported: false });
	});

	test("executes seeded Voronoi Crystallize with exact cell and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-crystallize-smart-filter.psd");
		const rgba = Array.from({ length: 36 }, (_, index) => [10 + index * 6, 240 - index * 5, 30 + (index % 6) * 35, index === 0 ? 0 : index === 14 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Crystallize",
						id: 5682,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 6, 0, 6, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "crystallize", cellSize: 3, randomSeed: 123456 }],
								})
							),
						],
					}),
				],
				{ width: 6, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "crystallize.psd", fileType: "PSD", data: createCompositePsd(6, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-crystallize-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { cellSize: 3, randomSeed: 123456 };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "crystallize",
			crystallize: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-voronoi-crystallize-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "crystallize",
			crystallize: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-voronoi-crystallize-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("b1828f84fdc8b86e987991ba43f74f3da99f0f0b700cc95af13c72dcc434a85f");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("preserves invalid Crystallize parameters as explicit non-executable evidence", async () => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Crystallize",
				id: 5683,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "crystallize", cellSize: 301, randomSeed: 123456 }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "crystallize",
			crystallize: { cellSize: 301, randomSeed: 123456 },
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-voronoi-crystallize-smart-filter-v1",
		});
		expect(inspected?.warning).toContain("cell size 3-300");
	});

	test("executes seeded Mezzotint with exact pattern and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-mezzotint-smart-filter.psd");
		const rgba = Array.from({ length: 64 }, (_, index) => [
			15 + ((index * 17) % 230),
			240 - ((index * 11) % 220),
			25 + ((index * 29) % 210),
			index === 0 ? 0 : index === 27 ? 128 : 255,
		]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Mezzotint",
						id: 5692,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 8, 0, 8],
									nonAffineTransform: null,
									smartFilters: [{ type: "mezzotint", mezzotintPattern: "medium strokes", randomSeed: 123456 }],
								})
							),
						],
					}),
				],
				{ width: 8, height: 8 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "mezzotint.psd", fileType: "PSD", data: createCompositePsd(8, 8, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-mezzotint-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { pattern: "medium strokes", randomSeed: 123456 };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "mezzotint",
			mezzotint: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-mezzotint-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "mezzotint",
			mezzotint: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-mezzotint-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("0818516bc6f248ab664676f9d3d87a19b31e080d36b91b47cbf854cb19d234fa");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("preserves invalid Mezzotint parameters as explicit non-executable evidence", () => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Mezzotint",
				id: 5693,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "mezzotint", mezzotintPattern: "unsupported", randomSeed: 123456 }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "mezzotint",
			mezzotint: null,
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-mezzotint-smart-filter-v1",
		});
		expect(inspected?.warning).toContain("ten exact dot/line/stroke pattern modes");
	});

	test("executes premultiplied Mosaic with exact cell-size and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-mosaic-smart-filter.psd");
		const rgba = Array.from({ length: 20 }, (_, index) => [10 + index * 9, 220 - index * 7, 30 + (index % 5) * 40, index === 0 ? 0 : index === 7 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Mosaic",
						id: 5702,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 5, 0, 5, 4, 0, 4],
									nonAffineTransform: null,
									smartFilters: [{ type: "mosaic", cellSize: 2 }],
								})
							),
						],
					}),
				],
				{ width: 5, height: 4 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "mosaic.psd", fileType: "PSD", data: createCompositePsd(5, 4, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-mosaic-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { cellSize: 2, cellSizeUnits: "#Pxl" };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "mosaic",
			mosaic: expectedParameters,
			algorithmExecutionModel: "bounded-premultiplied-mosaic-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "mosaic",
			mosaic: expectedParameters,
			algorithmExecutionModel: "bounded-premultiplied-mosaic-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("2b21524a12b428205253d5c46bcc334140dd90ff3582389a7cf412e31403d2ae");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ cellSize: 1 }, "cell size 2-200"],
		[{ cellSize: 2, cellSizeUnits: "#Prc" }, "bounded execution requires pixels"],
	] as const)("preserves invalid Mosaic parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Mosaic",
				id: 5703,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "mosaic", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "mosaic",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-premultiplied-mosaic-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes seeded Pointillize with exact cell-size, seed, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-pointillize-smart-filter.psd");
		const rgba = Array.from({ length: 36 }, (_, index) => [
			15 + ((index * 17) % 220),
			230 - ((index * 13) % 210),
			20 + ((index * 31) % 220),
			index === 0 ? 0 : index === 14 ? 128 : 255,
		]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Pointillize",
						id: 5712,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 6, 0, 6, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "pointillize", cellSize: 3, randomSeed: 123456 }],
								})
							),
						],
					}),
				],
				{ width: 6, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "pointillize.psd", fileType: "PSD", data: createCompositePsd(6, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-pointillize-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { cellSize: 3, randomSeed: 123456 };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "pointillize",
			backgroundColor: [255, 255, 255, 255],
			pointillize: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-authored-canvas-pointillize-smart-filter-v2",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "pointillize",
			backgroundColor: [255, 255, 255, 255],
			pointillize: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-authored-canvas-pointillize-smart-filter-v2",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("8268238f413d9f7052f177827ef60c967e0ebfd0f747f5d48f16a6a64c0f9a4e");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ cellSize: 2, randomSeed: 123456 }, "cell size 3-300"],
		[{ cellSize: 3, omitRandomSeed: true }, "signed 32-bit random seed"],
		[{ cellSize: 3, randomSeed: 123456, omitBackgroundColor: true }, "RGB background canvas"],
	] as const)("preserves invalid Pointillize parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Pointillize",
				id: 5713,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "pointillize", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "pointillize",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-authored-canvas-pointillize-smart-filter-v2",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes seeded fractal Clouds with exact authored colors, seed, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-clouds-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Clouds",
						id: 5722,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "clouds", randomSeed: 123456, foregroundColor: [20, 70, 220], backgroundColor: [240, 180, 30] }],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "clouds.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-clouds-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { randomSeed: 123456 };
		const expectedColors = { foregroundColor: [20, 70, 220, 255], backgroundColor: [240, 180, 30, 255] };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "clouds",
			clouds: expectedParameters,
			...expectedColors,
			algorithmExecutionModel: "bounded-seeded-fractal-clouds-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "clouds",
			clouds: expectedParameters,
			...expectedColors,
			algorithmExecutionModel: "bounded-seeded-fractal-clouds-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("47479d25c4a628cd8a3be90499ccc41c23b286347069e090520abbb5a793b766");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ omitRandomSeed: true }, "signed 32-bit random seed"],
		[{ randomSeed: 123456, omitForegroundColor: true }, "RGB foreground/background colors"],
		[{ randomSeed: 123456, omitBackgroundColor: true }, "RGB foreground/background colors"],
	] as const)("preserves invalid Clouds parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Clouds",
				id: 5723,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "clouds", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "clouds",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-fractal-clouds-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes seeded Difference Clouds with exact source, colors, seed, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-difference-clouds-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Difference Clouds",
						id: 5732,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "differenceClouds", randomSeed: 123456, foregroundColor: [20, 70, 220], backgroundColor: [240, 180, 30] }],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "difference-clouds.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-difference-clouds-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { randomSeed: 123456 };
		const expectedColors = { foregroundColor: [20, 70, 220, 255], backgroundColor: [240, 180, 30, 255] };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "differenceClouds",
			differenceClouds: expectedParameters,
			...expectedColors,
			algorithmExecutionModel: "bounded-seeded-difference-clouds-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "differenceClouds",
			differenceClouds: expectedParameters,
			...expectedColors,
			algorithmExecutionModel: "bounded-seeded-difference-clouds-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("27d41968001d747f6896f3787dc38457f6650d112f1f18e66ec95967eaf46071");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ omitRandomSeed: true }, "signed 32-bit random seed"],
		[{ randomSeed: 123456, omitForegroundColor: true }, "RGB foreground/background colors"],
		[{ randomSeed: 123456, omitBackgroundColor: true }, "RGB foreground/background colors"],
	] as const)("preserves invalid Difference Clouds parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Difference Clouds",
				id: 5733,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "differenceClouds", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "differenceClouds",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-difference-clouds-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes seeded Fibers with exact variance, strength, colors, seed, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-fibers-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Fibers",
						id: 5742,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [
										{ type: "fibers", variance: 16, strength: 32, randomSeed: 123456, foregroundColor: [20, 70, 220], backgroundColor: [240, 180, 30] },
									],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "fibers.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-fibers-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { variance: 16, strength: 32, randomSeed: 123456 };
		const expectedColors = { foregroundColor: [20, 70, 220, 255], backgroundColor: [240, 180, 30, 255] };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "fibers",
			fibers: expectedParameters,
			...expectedColors,
			algorithmExecutionModel: "bounded-seeded-anisotropic-fibers-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "fibers",
			fibers: expectedParameters,
			...expectedColors,
			algorithmExecutionModel: "bounded-seeded-anisotropic-fibers-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("f2aac5d176b6226eb6e8e38ba2744eccf25d23db006ab5c205d688ddc2b0f3b1");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ variance: 0, strength: 32, randomSeed: 123456 }, "variance/strength 1-64"],
		[{ variance: 16, strength: 65, randomSeed: 123456 }, "variance/strength 1-64"],
		[{ variance: 16, strength: 32, omitRandomSeed: true }, "signed 32-bit random seed"],
		[{ variance: 16, strength: 32, randomSeed: 123456, omitForegroundColor: true }, "RGB foreground/background colors"],
		[{ variance: 16, strength: 32, randomSeed: 123456, omitBackgroundColor: true }, "RGB foreground/background colors"],
	] as const)("preserves invalid Fibers parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Fibers",
				id: 5743,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "fibers", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "fibers",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-anisotropic-fibers-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes Lens Flare with exact brightness, pixel center, lens type, and applied MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-lens-flare-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Lens Flare",
						id: 5752,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "lensFlare", brightness: 125, position: { x: 3.5, y: 2.5 }, lensType: "50-300mm zoom" }],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "lens-flare.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-lens-flare-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { brightnessPercent: 125, position: { x: 3.5, y: 2.5 }, lensType: "50-300mm zoom" };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "lensFlare",
			lensFlare: expectedParameters,
			algorithmExecutionModel: "bounded-parameterized-lens-flare-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "lensFlare",
			lensFlare: expectedParameters,
			algorithmExecutionModel: "bounded-parameterized-lens-flare-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("937f64fee0aa6d3696724f87dc34948fac0ceebda9e0d81f93b30aef0631b8dc");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ brightness: 9, position: { x: 3.5, y: 2.5 }, lensType: "50-300mm zoom" }, "brightness 10-300%"],
		[{ brightness: 125, position: { x: Number.POSITIVE_INFINITY, y: 2.5 }, lensType: "50-300mm zoom" }, "finite bounded pixel coordinates"],
		[{ brightness: 125, position: { x: 3.5, y: 2.5 }, lensType: "unsupported" }, "supported lens type"],
	] as const)("preserves invalid Lens Flare parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Lens Flare",
				id: 5753,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "lensFlare", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "lensFlare",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-parameterized-lens-flare-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes full-parameter Smart Sharpen with exact adaptive tonal evidence", async () => {
		const sourcePath = join(directory, "assets/live-smart-sharpen-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		const smartFilter = {
			type: "smartSharpen" as const,
			amount: 150,
			amountUnits: "#Prc",
			radius: 1.5,
			radiusUnits: "#Pxl",
			threshold: 5,
			angleDegrees: 0,
			moreAccurate: true,
			smartSharpenBlur: "gaussianBlur" as const,
			preset: "Codex Smart Sharpen",
			shadow: { fadeAmount: 20, tonalWidth: 40, radius: 2 },
			highlight: { fadeAmount: 30, tonalWidth: 50, radius: 3 },
		};
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Smart Sharpen",
						id: 5762,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [smartFilter],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "smart-sharpen.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-smart-sharpen-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = {
			amountPercent: 150,
			radius: 1.5,
			radiusUnits: "#Pxl",
			threshold: 5,
			angleDegrees: 0,
			moreAccurate: true,
			blur: "gaussianBlur",
			preset: "Codex Smart Sharpen",
			shadow: { fadeAmountPercent: 20, tonalWidthPercent: 40, radius: 2 },
			highlight: { fadeAmountPercent: 30, tonalWidthPercent: 50, radius: 3 },
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "smartSharpen",
			smartSharpen: expectedParameters,
			algorithmExecutionModel: "bounded-adaptive-smart-sharpen-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "smartSharpen",
			smartSharpen: expectedParameters,
			algorithmExecutionModel: "bounded-adaptive-smart-sharpen-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("1cb899ec683fd9d6d18d55c0902de6b2d7408525ac788257131c6f724cdce700");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ amount: 0 }, "amount 1-500%"],
		[{ radius: 1.5, radiusUnits: "#Prc" }, "percent/pixel units"],
		[{ smartSharpenBlur: "unsupported" }, "exact blur"],
		[{ preset: "" }, "preset state"],
		[{ shadow: { fadeAmount: 20, tonalWidth: 40, radius: 0 } }, "shadow/highlight"],
	] as const)("preserves invalid Smart Sharpen parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Smart Sharpen",
				id: 5763,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "smartSharpen", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "smartSharpen",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-adaptive-smart-sharpen-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact-parameter thresholded Gaussian Unsharp Mask", async () => {
		const sourcePath = join(directory, "assets/live-unsharp-mask-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		const smartFilter = { type: "unsharpMask" as const, amount: 150, amountUnits: "#Prc", radius: 1.5, radiusUnits: "#Pxl", threshold: 5 };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Unsharp Mask",
						id: 5772,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "unsharp-mask.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-unsharp-mask-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { amountPercent: 150, amountUnits: "#Prc", radius: 1.5, radiusUnits: "#Pxl", threshold: 5 };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "unsharpMask",
			unsharpMask: expectedParameters,
			algorithmExecutionModel: "bounded-thresholded-gaussian-unsharp-mask-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "unsharpMask",
			unsharpMask: expectedParameters,
			algorithmExecutionModel: "bounded-thresholded-gaussian-unsharp-mask-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("3062b4ba9b6f91b74b9d6a289c89afe5a5edaae0ab06991c97c26e5936afd1b5");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ amount: 0 }, "amount 1-500%"],
		[{ amountUnits: "#Pxl" }, "percent/pixel units"],
		[{ radius: 1.5, radiusUnits: "#Prc" }, "percent/pixel units"],
		[{ threshold: 256 }, "integer threshold 0-255"],
	] as const)("preserves invalid Unsharp Mask parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Unsharp Mask",
				id: 5773,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "unsharpMask", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "unsharpMask",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-thresholded-gaussian-unsharp-mask-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes seeded four-mode Diffuse with exact mode evidence", async () => {
		const sourcePath = join(directory, "assets/live-diffuse-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		const smartFilter = { type: "diffuse" as const, diffuseMode: "normal" as const, randomSeed: 123456 };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Diffuse",
						id: 5782,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "diffuse.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-diffuse-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { mode: "normal", randomSeed: 123456 };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "diffuse",
			diffuse: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-four-mode-diffuse-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "diffuse",
			diffuse: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-four-mode-diffuse-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("1b2c17c8f615c4968314162ddc484e99b95e4ceabd4aa2cae8950cd4e6c5a86d");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ diffuseMode: "unsupported" as const }, "one exact Normal/Darken Only/Lighten Only/Anisotropic mode"],
		[{ omitRandomSeed: true }, "exact signed 32-bit random seed"],
	] as const)("preserves invalid Diffuse parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Diffuse",
				id: 5783,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "diffuse", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "diffuse",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-four-mode-diffuse-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact-angle color Emboss with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-emboss-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		const smartFilter = { type: "emboss" as const, angleDegrees: 135, height: 3, amount: 150 };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Emboss",
						id: 5792,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "emboss.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-emboss-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { angleDegrees: 135, heightPixels: 3, amountPercent: 150 };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "emboss",
			emboss: expectedParameters,
			algorithmExecutionModel: "bounded-directional-color-emboss-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "emboss",
			emboss: expectedParameters,
			algorithmExecutionModel: "bounded-directional-color-emboss-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("a8bd70aca4b75e32c8f2b346e10b9fd00149a8da2923d6e9a7aef0a70ff65182");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ angleDegrees: 361 }, "angle -360..360"],
		[{ height: 0 }, "height 1-10"],
		[{ amount: 0 }, "amount 1-500"],
	] as const)("preserves invalid Emboss parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Emboss",
				id: 5793,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "emboss", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "emboss",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-directional-color-emboss-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact six-control seeded Extrude with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-extrude-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		const smartFilter = {
			type: "extrude" as const,
			extrudeType: "blocks" as const,
			cellSize: 4,
			depth: 96,
			extrudeDepthMode: "random" as const,
			randomSeed: 123456,
			solidFrontFaces: true,
			maskIncompleteBlocks: true,
		};
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Extrude",
						id: 5802,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "extrude.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-extrude-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = {
			type: "blocks",
			sizePixels: 4,
			depth: 96,
			depthMode: "random",
			randomSeed: 123456,
			solidFrontFaces: true,
			maskIncompleteBlocks: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "extrude",
			extrude: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-cell-relief-extrude-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "extrude",
			extrude: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-cell-relief-extrude-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("78e24ef911e01c6e74ba53e44ef5402f5eecbe79e721beea7f76159c5fb3f1f1");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ cellSize: 1 }, "integer size 2-255"],
		[{ depth: 0 }, "integer depth 1-255"],
		[{ extrudeType: "unsupported" as const }, "Blocks/Pyramids"],
		[{ extrudeDepthMode: "unsupported" as const }, "Random/Level-based"],
		[{ omitSolidFrontFaces: true }, "exact Boolean face/mask states"],
		[{ omitMaskIncompleteBlocks: true }, "exact Boolean face/mask states"],
		[{ omitRandomSeed: true }, "exact signed 32-bit random seed"],
	] as const)("preserves invalid Extrude parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Extrude",
				id: 5803,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "extrude", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "extrude",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-cell-relief-extrude-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact four-fill seeded Tiles with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-tiles-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		const smartFilter = {
			type: "tiles" as const,
			numberOfTiles: 4,
			maximumOffset: 35,
			tilesFill: "backgroundColor" as const,
			randomSeed: 123456,
			foregroundColor: [210, 40, 90] as [number, number, number],
			backgroundColor: [12, 34, 56] as [number, number, number],
		};
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Tiles",
						id: 5812,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "tiles.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-tiles-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { numberOfTiles: 4, maximumOffsetPercent: 35, fillEmptyAreaWith: "backgroundColor", randomSeed: 123456 };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "tiles",
			tiles: expectedParameters,
			backgroundColor: [12, 34, 56, 255],
			algorithmExecutionModel: "bounded-seeded-offset-tiles-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "tiles",
			tiles: expectedParameters,
			algorithmExecutionModel: "bounded-seeded-offset-tiles-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("a602fd2274d09226cf6a33d9bc41ddcf45a04a601045f3166f9356c410a55f96");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ numberOfTiles: 0 }, "tile count 1-99"],
		[{ maximumOffset: 100 }, "maximum offset 1-99%"],
		[{ tilesFill: "unsupported" as const }, "one exact fill mode"],
		[{ tilesFill: "backgroundColor" as const, omitBackgroundColor: true }, "required RGB foreground/background color"],
		[{ tilesFill: "foregroundColor" as const, omitForegroundColor: true }, "required RGB foreground/background color"],
		[{ omitRandomSeed: true }, "exact signed 32-bit random seed"],
	] as const)("preserves invalid Tiles parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Tiles",
				id: 5813,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "tiles", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "tiles",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-offset-tiles-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact per-channel threshold Trace Contour with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-trace-contour-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat();
		const smartFilter = { type: "traceContour" as const, level: 128, traceContourEdge: "lower" as const };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Trace Contour",
						id: 5822,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "trace-contour.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-trace-contour-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { level: 128, edge: "lower" };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "traceContour",
			traceContour: expectedParameters,
			algorithmExecutionModel: "bounded-per-channel-threshold-trace-contour-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "traceContour",
			traceContour: expectedParameters,
			algorithmExecutionModel: "bounded-per-channel-threshold-trace-contour-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("5b890020de5ad9aec515740eb98797cfbfe9ac61e01f7c4ce6164bfbdeaa1f05");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ level: -1 }, "integer level 0-255"],
		[{ level: 256 }, "integer level 0-255"],
		[{ level: 128.5, levelAsDouble: true }, "integer level 0-255"],
		[{ traceContourEdge: "unsupported" as const }, "exact Lower/Upper edge mode"],
	] as const)("preserves invalid Trace Contour parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Trace Contour",
				id: 5823,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "traceContour", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "traceContour",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-per-channel-threshold-trace-contour-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact three-method directional Wind with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-wind-smart-filter.psd");
		const rgba = Array.from({ length: 96 }, (_, index) => [index * 11, 255 - index * 7, index * 17, index === 0 ? 0 : index === 35 ? 128 : 255]).flat();
		const smartFilter = { type: "wind" as const, windMethod: "wind" as const, windDirection: "right" as const };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Wind",
						id: 5832,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 16, 0, 16, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 16, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "wind.psd", fileType: "PSD", data: createCompositePsd(16, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-wind-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { method: "wind", direction: "right" };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "wind",
			wind: expectedParameters,
			algorithmExecutionModel: "bounded-directional-horizontal-wind-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "wind",
			wind: expectedParameters,
			algorithmExecutionModel: "bounded-directional-horizontal-wind-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("c21054bfc470bba201058d23c6f61394882f9e31104892850598782ad7b5c91b");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ windMethod: "unsupported" as const }, "exact Wind/Blast/Stagger method"],
		[{ windDirection: "unsupported" as const }, "exact Left/Right direction"],
	] as const)("preserves invalid Wind parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Wind",
				id: 5833,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "wind", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "wind",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-directional-horizontal-wind-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact field-selective De-Interlace reconstruction with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-de-interlace-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 7, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat();
		const smartFilter = { type: "deInterlace" as const, deInterlaceEliminate: "oddLines" as const, deInterlaceNewFieldsBy: "interpolation" as const };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "De-Interlace",
						id: 5842,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "de-interlace.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-de-interlace-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { eliminate: "oddLines", newFieldsBy: "interpolation" };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "deInterlace",
			deInterlace: expectedParameters,
			algorithmExecutionModel: "bounded-field-reconstruction-de-interlace-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "deInterlace",
			deInterlace: expectedParameters,
			algorithmExecutionModel: "bounded-field-reconstruction-de-interlace-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("c0183f930299a220090fb3bec0120867d8cd72dfb4360b5d3a97a26d657b3f1d");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ deInterlaceEliminate: "unsupported" as const }, "exact odd/even field elimination"],
		[{ deInterlaceNewFieldsBy: "unsupported" as const }, "exact duplication/interpolation reconstruction method"],
	] as const)("preserves invalid De-Interlace parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed De-Interlace",
				id: 5843,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "deInterlace", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "deInterlace",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-field-reconstruction-de-interlace-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact 5x5 Custom convolution with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-custom-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 7, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat();
		const matrix = [0, 0, 0, 0, 0, 0, -1, -1, -1, 0, 0, -1, 9, -1, 0, 0, -1, -1, -1, 0, 0, 0, 0, 0, 0];
		const smartFilter = { type: "customConvolution" as const, customScale: 1, customOffset: 4, customMatrix: matrix };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Custom",
						id: 5852,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "custom.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-custom-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { scale: 1, offset: 4, matrix };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "customConvolution",
			customConvolution: expectedParameters,
			algorithmExecutionModel: "bounded-custom-5x5-convolution-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "customConvolution",
			customConvolution: expectedParameters,
			algorithmExecutionModel: "bounded-custom-5x5-convolution-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("f41c5017a40e3e7fe8a9881ad8a6c25c82b7855a6f685f08235244912f548aea");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ customMatrix: Array.from({ length: 24 }, () => 0) }, "exactly 25 integer matrix weights"],
		[{ customMatrix: Array.from({ length: 25 }, (_, index) => (index === 12 ? 1000 : 0)) }, "matrix weights from -999 to 999"],
		[{ customScale: 0 }, "nonzero signed 32-bit integer scale"],
		[{ customScaleAsDouble: true }, "nonzero signed 32-bit integer scale"],
		[{ customOffsetAsDouble: true }, "signed 32-bit integer offset"],
		[{ customMatrixAsDouble: true }, "integer matrix weights"],
	] as const)("preserves invalid Custom parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Custom",
				id: 5853,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "customConvolution", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "customConvolution",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-custom-5x5-convolution-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact three-mode Offset displacement with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-offset-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 7, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat();
		const smartFilter = { type: "offset" as const, offsetHorizontal: 2, offsetVertical: -1, offsetUndefinedAreas: "wrapAround" as const };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Offset",
						id: 5862,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "offset.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-offset-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = { horizontalPixels: 2, verticalPixels: -1, undefinedAreas: "wrapAround" };
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "offset",
			offset: expectedParameters,
			algorithmExecutionModel: "bounded-three-mode-offset-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "offset",
			offset: expectedParameters,
			algorithmExecutionModel: "bounded-three-mode-offset-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("b8d9ccfa5b3761f2e0b96242bb45274081f2c0751d9bc48345aa5a2c10bf6ceb");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ offsetHorizontalAsDouble: true }, "signed 32-bit integer horizontal/vertical pixel displacements"],
		[{ offsetVerticalAsDouble: true }, "signed 32-bit integer horizontal/vertical pixel displacements"],
		[{ offsetHorizontal: 2_147_483_648, offsetHorizontalAsDouble: true }, "signed 32-bit integer horizontal/vertical pixel displacements"],
		[{ offsetVertical: -2_147_483_649, offsetVerticalAsDouble: true }, "signed 32-bit integer horizontal/vertical pixel displacements"],
		[{ offsetUndefinedAreas: "unsupported" as const }, "Set To Transparent/Repeat Edge Pixels/Wrap Around"],
	] as const)("preserves invalid Offset parameters as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Offset",
				id: 5863,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "offset", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "offset",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-three-mode-offset-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes an explicitly leased PSD Displace map with complete descriptor and channel evidence", async () => {
		const sourcePath = join(directory, "assets/live-displace-smart-filter.psd");
		const mapPath = join(directory, "assets/displace-map.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 7, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat();
		const mapRgba = Array.from({ length: 12 }, (_, index) => [32 + index * 17, 224 - index * 13, 128 + (index % 3) * 20, 255]).flat();
		const smartFilter = {
			type: "displace" as const,
			displaceHorizontalScale: 12,
			displaceVerticalScale: -8,
			displacementMap: "stretchToFit" as const,
			displaceUndefinedAreas: "repeatEdgePixels" as const,
			displaceSignature: "Pth ",
			displacePath: "/stored/not-followed/displace.psd",
		};
		await writeFile(mapPath, createCompositePsd(4, 3, mapRgba));
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Displace",
						id: 5902,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "displace-source.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const inspectedWithoutBinding = await getPsdLayerExtractionStatus(sourcePath, { destinationFolder: "assets/live-displace-smart-filter-output" });
		expect(inspectedWithoutBinding.document.layers[0].smartObject?.smartFilters[0]).toMatchObject({
			type: "displace",
			filterClassId: "Dspl",
			filterId: 1148416108,
			displace: {
				horizontalScalePercent: 12,
				verticalScalePercent: -8,
				displacementMap: "stretchToFit",
				undefinedAreas: "repeatEdgePixels",
				displacementFile: { signature: "Pth ", path: "/stored/not-followed/displace.psd" },
				mapBinding: null,
			},
			bakeSupported: false,
		});
		expect(inspectedWithoutBinding.document.layers[0].smartObject?.smartFilters[0].warning).toContain("explicit project-contained PSD/PSB");

		const options = {
			destinationFolder: "assets/live-displace-smart-filter-output",
			renderEmbeddedSmartObjects: true,
			displacementMapBindings: [{ layerIndex: 0, filterIndex: 0, sourcePath: "assets/displace-map.psd" }],
		} as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const mapHash = createHash("sha256")
			.update(await readFile(mapPath))
			.digest("hex");
		expect(plan.displacementMapBindings).toEqual([
			expect.objectContaining({
				layerIndex: 0,
				layerName: "Displace",
				filterIndex: 0,
				sourcePath: "assets/displace-map.psd",
				sourceHash: mapHash,
				format: "psd",
				documentVersion: 1,
				depth: 8,
				colorMode: "rgb",
				channelMapping: "red-horizontal-green-vertical",
				width: 4,
				height: 3,
				storedSignature: "Pth ",
				storedPath: "/stored/not-followed/displace.psd",
				executionModel: "bounded-explicit-psd-displacement-map-binding-v1",
			}),
		]);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "displace",
			displace: { mapBinding: { sourceHash: mapHash, channelMapping: "red-horizontal-green-vertical" } },
			algorithmExecutionModel: "bounded-explicit-map-displace-smart-filter-v1",
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-displace-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("d074b20c772b147fbf8719963eb17aa749e1c52bd25f4e5839919d9ff0e661fe");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ displaceHorizontalAsDouble: true }, "exactly one HrzS long"],
		[{ displaceHorizontalScale: 1000 }, "-999 to 999"],
		[{ displacementMap: "unsupported" as const }, "Stretch To Fit or Tile"],
		[{ displaceUndefinedAreas: "unsupported" as const }, "Wrap Around or Repeat Edge Pixels"],
		[{ displacePathEntryType: "TEXT" as const }, "exactly one DspF Pth"],
		[{ displaceOmitPath: true }, "exactly one DspF"],
		[{ displaceDuplicatePath: true }, "duplicate key"],
		[{ displaceUnknownKey: true }, "unsupported key"],
	] as const)("preserves invalid Displace descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Displace",
				id: 5903,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "displace", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({ type: "displace", bakeSupported: false, algorithmExecutionModel: "bounded-explicit-map-displace-smart-filter-v1" });
		expect(inspected?.warning).toContain(warning);
	});

	test("rejects a malformed Displace file-path payload before semantic inspection", () => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Displace Path",
				id: 5905,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "displace", displacePathLengthDelta: 1 }] }))],
			}),
		]);
		expect(() => inspectPsdLayers(bytes)).toThrow("file path length fields do not match");
	});

	test("rejects unsafe, duplicate, and incorrectly targeted Displace map bindings", async () => {
		const sourcePath = join(directory, "assets/displace-binding-validation.psd");
		const mapPath = join(directory, "assets/displace-binding-map.psd");
		await writeFile(mapPath, createCompositePsd(1, 1, [128, 128, 128, 255]));
		await writeFile(
			sourcePath,
			createLayeredPsd([
				layer({
					name: "Binding Validation",
					id: 5904,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "displace" }] }))],
				}),
			])
		);
		const base = { destinationFolder: "assets/displace-binding-output", renderEmbeddedSmartObjects: true } as const;
		await expect(
			getPsdLayerExtractionStatus(sourcePath, { ...base, displacementMapBindings: [{ layerIndex: 0, filterIndex: 0, sourcePath: "../outside.psd" }] })
		).rejects.toThrow("must stay inside");
		await expect(
			getPsdLayerExtractionStatus(sourcePath, {
				...base,
				displacementMapBindings: [
					{ layerIndex: 0, filterIndex: 0, sourcePath: "assets/displace-binding-map.psd" },
					{ layerIndex: 0, filterIndex: 0, sourcePath: "assets/displace-binding-map.psd" },
				],
			})
		).rejects.toThrow("duplicate layer/filter key");
		await expect(
			getPsdLayerExtractionStatus(sourcePath, { ...base, displacementMapBindings: [{ layerIndex: 0, filterIndex: 1, sourcePath: "assets/displace-binding-map.psd" }] })
		).rejects.toThrow("valid Displace smart filter");
		await expect(
			getPsdLayerExtractionStatus(sourcePath, {
				destinationFolder: "assets/displace-binding-output",
				displacementMapBindings: [{ layerIndex: 0, filterIndex: 0, sourcePath: "assets/displace-binding-map.psd" }],
			})
		).rejects.toThrow("requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true");
	});

	test("executes exact-amount radial Pinch with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-pinch-smart-filter.psd");
		const rgba = Array.from({ length: 63 }, (_, index) => [index * 13, 255 - index * 9, index * 19, index === 0 ? 0 : index === 31 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Pinch",
						id: 5912,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 9, 0, 9, 7, 0, 7],
									nonAffineTransform: null,
									smartFilters: [{ type: "pinch", pinchAmount: 65 }],
								})
							),
						],
					}),
				],
				{ width: 9, height: 7 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "pinch-source.psd", fileType: "PSD", data: createCompositePsd(9, 7, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-pinch-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "pinch",
			filterClassId: "Pnch",
			filterId: 1349411688,
			pinch: { amountPercent: 65 },
			algorithmExecutionModel: "bounded-radial-power-pinch-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-pinch-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("2904f1d311c693ddb525a1b922b119ee14004171b59d48eee78c73bc9d4527c8");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ pinchAmountAsDouble: true }, "exactly one Amnt long"],
		[{ pinchAmount: 101 }, "-100 to 100"],
		[{ pinchAmount: -101 }, "-100 to 100"],
		[{ pinchOmitAmount: true }, "exactly one Amnt long"],
		[{ pinchDuplicateAmount: true }, "duplicate key"],
		[{ pinchUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1349411688"],
	] as const)("preserves malformed Pinch descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Pinch",
				id: 5913,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "pinch", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "pinch",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-radial-power-pinch-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes both exact Polar Coordinates modes with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-polar-coordinates-smart-filter.psd");
		const rgba = Array.from({ length: 63 }, (_, index) => [index * 13, 255 - index * 9, index * 19, index === 0 ? 0 : index === 31 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Polar Coordinates",
						id: 5922,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 9, 0, 9, 7, 0, 7],
									nonAffineTransform: null,
									smartFilters: [{ type: "polarCoordinates", polarConversion: "rectangularToPolar" }],
								})
							),
						],
					}),
				],
				{ width: 9, height: 7 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "polar-source.psd", fileType: "PSD", data: createCompositePsd(9, 7, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-polar-coordinates-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "polarCoordinates",
			filterClassId: "Plr ",
			filterId: 1349284384,
			polarCoordinates: { conversion: "rectangularToPolar" },
			algorithmExecutionModel: "bounded-aspect-correct-polar-coordinates-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		const inverse = inspectPsdLayers(
			createLayeredPsd([
				layer({
					name: "Inverse Polar Coordinates",
					id: 5924,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "polarCoordinates", polarConversion: "polarToRectangular" }] }))],
				}),
			])
		).layers[0].smartObject?.smartFilters[0];
		expect(inverse).toMatchObject({
			type: "polarCoordinates",
			polarCoordinates: { conversion: "polarToRectangular" },
			algorithmExecutionModel: "bounded-aspect-correct-polar-coordinates-smart-filter-v1",
			bakeSupported: true,
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-polar-coordinates-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("0cac8098945cb081de6c0d5a0c9995a90a1e8f809f0cb10d03301c2cf0471e46");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ polarConversionEntryType: "TEXT" as const }, "exactly one Cnvr enum"],
		[{ polarConversion: "unsupported" as const }, "Rectangular To Polar or Polar To Rectangular"],
		[{ polarEnumType: "Nope" }, "enum type must be Cnvr"],
		[{ polarOmitConversion: true }, "exactly one Cnvr enum"],
		[{ polarDuplicateConversion: true }, "duplicate key"],
		[{ polarUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1349284384"],
	] as const)("preserves malformed Polar Coordinates descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Polar Coordinates",
				id: 5923,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "polarCoordinates", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "polarCoordinates",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-aspect-correct-polar-coordinates-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact Ripple amount and size with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-ripple-smart-filter.psd");
		const rgba = Array.from({ length: 99 }, (_, index) => [index * 17, 255 - index * 11, index * 23, index === 0 ? 0 : index === 49 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Ripple",
						id: 5932,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 11, 0, 11, 9, 0, 9],
									nonAffineTransform: null,
									smartFilters: [{ type: "ripple", rippleAmount: 240, rippleSize: "medium" }],
								})
							),
						],
					}),
				],
				{ width: 11, height: 9 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "ripple-source.psd", fileType: "PSD", data: createCompositePsd(11, 9, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-ripple-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "ripple",
			filterClassId: "Rple",
			filterId: 1383099493,
			ripple: { amountPercent: 240, size: "medium" },
			algorithmExecutionModel: "bounded-two-axis-sinusoidal-ripple-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		for (const settings of [
			{ rippleAmount: -240, rippleSize: "medium" as const },
			{ rippleAmount: 240, rippleSize: "small" as const },
			{ rippleAmount: 240, rippleSize: "large" as const },
		]) {
			const variant = inspectPsdLayers(
				createLayeredPsd([
					layer({
						name: "Ripple variant",
						id: 5934,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "ripple", ...settings }] }))],
					}),
				])
			).layers[0].smartObject?.smartFilters[0];
			expect(variant).toMatchObject({
				type: "ripple",
				ripple: { amountPercent: settings.rippleAmount, size: settings.rippleSize },
				algorithmExecutionModel: "bounded-two-axis-sinusoidal-ripple-smart-filter-v1",
				bakeSupported: true,
			});
		}
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-ripple-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("03f1994143bd3aafd1753cafe6b5f20a0183c04292b1c285784d0ef78fa22fb8");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ rippleAmountAsDouble: true }, "exactly one Amnt long"],
		[{ rippleAmount: 1000 }, "-999 to 999"],
		[{ rippleAmount: -1000 }, "-999 to 999"],
		[{ rippleOmitAmount: true }, "exactly one Amnt long"],
		[{ rippleSizeEntryType: "TEXT" as const }, "exactly one RplS enum"],
		[{ rippleSize: "unsupported" as const }, "Small, Medium, or Large"],
		[{ rippleSizeEnumType: "Nope" }, "enum type must be RplS"],
		[{ rippleOmitSize: true }, "exactly one RplS enum"],
		[{ rippleDuplicateAmount: true }, "duplicate key"],
		[{ rippleDuplicateSize: true }, "duplicate key"],
		[{ rippleUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1383099493"],
	] as const)("preserves malformed Ripple descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Ripple",
				id: 5933,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "ripple", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "ripple",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-two-axis-sinusoidal-ripple-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes an exact Shear curve and undefined-area mode with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-shear-smart-filter.psd");
		const rgba = Array.from({ length: 108 }, (_, index) => [index * 19, 255 - index * 7, index * 29, index === 0 ? 0 : index === 53 ? 128 : 255]).flat();
		const curvePoints = [
			{ x: 0, y: 0 },
			{ x: 18, y: 42 },
			{ x: -12, y: 86 },
			{ x: 6, y: 128 },
		];
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Shear",
						id: 5942,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 12, 0, 12, 9, 0, 9],
									nonAffineTransform: null,
									smartFilters: [{ type: "shear", shearPoints: curvePoints, shearUndefinedAreas: "wrapAround" }],
								})
							),
						],
					}),
				],
				{ width: 12, height: 9 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "shear-source.psd", fileType: "PSD", data: createCompositePsd(12, 9, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-shear-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "shear",
			filterClassId: "Shr ",
			filterId: 1399353888,
			shear: { curvePoints, curveStartIndex: 0, curveEndIndex: 3, undefinedAreas: "wrapAround" },
			algorithmExecutionModel: "bounded-monotone-cubic-shear-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		const repeatEdge = inspectPsdLayers(
			createLayeredPsd([
				layer({
					name: "Shear Repeat Edge",
					id: 5944,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [
						additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "shear", shearPoints: curvePoints, shearUndefinedAreas: "repeatEdgePixels" }] })),
					],
				}),
			])
		).layers[0].smartObject?.smartFilters[0];
		expect(repeatEdge).toMatchObject({
			type: "shear",
			shear: { curvePoints, curveStartIndex: 0, curveEndIndex: 3, undefinedAreas: "repeatEdgePixels" },
			algorithmExecutionModel: "bounded-monotone-cubic-shear-smart-filter-v1",
			bakeSupported: true,
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-shear-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("6af9bf340a39a99919eadc382e481427668b5a5eb414e06d06450e6e46d2b8f0");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ shearPointsEntryType: "TEXT" as const }, "exactly one ShrP descriptor list"],
		[{ shearPoints: [{ x: 0, y: 0 }] }, "2 through 255"],
		[{ shearPoints: Array.from({ length: 256 }, (_, index) => ({ x: 0, y: index })) }, "2 through 255"],
		[{ shearPointClassId: "Nope" }, "requires class Pnt"],
		[{ shearPointHorizontalAsLong: true }, "exact Hrzn/Vrtc double"],
		[{ shearPointMissingVertical: true }, "exact Hrzn/Vrtc double"],
		[{ shearPointDuplicateHorizontal: true }, "duplicate key"],
		[{ shearPointUnknownKey: true }, "unsupported key"],
		[
			{
				shearPoints: [
					{ x: 0.5, y: 0 },
					{ x: 0, y: 128 },
				],
			},
			"integer horizontal displacement",
		],
		[
			{
				shearPoints: [
					{ x: 1_000_001, y: 0 },
					{ x: 0, y: 128 },
				],
			},
			"integer horizontal displacement",
		],
		[
			{
				shearPoints: [
					{ x: 0, y: -1 },
					{ x: 0, y: 128 },
				],
			},
			"vertical coordinate",
		],
		[
			{
				shearPoints: [
					{ x: 0, y: 64 },
					{ x: 0, y: 32 },
				],
			},
			"strictly ordered",
		],
		[{ shearUndefinedAreaEntryType: "TEXT" as const }, "exactly one UndA enum"],
		[{ shearUndefinedAreas: "unsupported" as const }, "Wrap Around or Repeat Edge Pixels"],
		[{ shearUndefinedAreaEnumType: "Nope" }, "enum type must be UndA"],
		[{ shearStartAsDouble: true }, "exact ShrS/ShrE long"],
		[{ shearEndAsDouble: true }, "exact ShrS/ShrE long"],
		[{ shearStartIndex: 3 }, "ordered nonempty interval"],
		[{ shearEndIndex: 4 }, "ordered nonempty interval"],
		[{ shearOmitPoints: true }, "exactly one ShrP descriptor list"],
		[{ shearOmitUndefinedAreas: true }, "exactly one UndA enum"],
		[{ shearOmitStart: true }, "exact ShrS/ShrE long"],
		[{ shearOmitEnd: true }, "exact ShrS/ShrE long"],
		[{ shearDuplicatePoints: true }, "duplicate key"],
		[{ shearUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1399353888"],
	] as const)("preserves malformed Shear descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Shear",
				id: 5943,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "shear", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "shear",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-monotone-cubic-shear-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact Spherize amount and all three modes with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-spherize-smart-filter.psd");
		const rgba = Array.from({ length: 99 }, (_, index) => [index * 17, 255 - index * 11, index * 23, index === 0 ? 0 : index === 49 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Spherize",
						id: 5952,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 11, 0, 11, 9, 0, 9],
									nonAffineTransform: null,
									smartFilters: [{ type: "spherize", spherizeAmount: 70, spherizeMode: "normal" }],
								})
							),
						],
					}),
				],
				{ width: 11, height: 9 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "spherize-source.psd", fileType: "PSD", data: createCompositePsd(11, 9, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-spherize-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "spherize",
			filterClassId: "Sphr",
			filterId: 1399875698,
			spherize: { amountPercent: 70, mode: "normal" },
			algorithmExecutionModel: "bounded-axis-selective-spherical-spherize-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		for (const settings of [
			{ spherizeAmount: -70, spherizeMode: "normal" as const },
			{ spherizeAmount: 70, spherizeMode: "horizontalOnly" as const },
			{ spherizeAmount: 70, spherizeMode: "verticalOnly" as const },
		]) {
			const variant = inspectPsdLayers(
				createLayeredPsd([
					layer({
						name: "Spherize variant",
						id: 5954,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "spherize", ...settings }] }))],
					}),
				])
			).layers[0].smartObject?.smartFilters[0];
			expect(variant).toMatchObject({
				type: "spherize",
				spherize: { amountPercent: settings.spherizeAmount, mode: settings.spherizeMode },
				algorithmExecutionModel: "bounded-axis-selective-spherical-spherize-smart-filter-v1",
				bakeSupported: true,
			});
		}
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-spherize-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("4fefe8ab76a32d5acda1c4b10ee5e8425fb9f9cee5a53d1f78af77ec37cdeed4");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ spherizeAmountAsDouble: true }, "exactly one Amnt long"],
		[{ spherizeAmount: 101 }, "-100 to 100"],
		[{ spherizeAmount: -101 }, "-100 to 100"],
		[{ spherizeOmitAmount: true }, "exactly one Amnt long"],
		[{ spherizeModeEntryType: "TEXT" as const }, "exactly one SphM enum"],
		[{ spherizeMode: "unsupported" as const }, "Normal, Horizontal Only, or Vertical Only"],
		[{ spherizeModeEnumType: "Nope" }, "enum type must be SphM"],
		[{ spherizeOmitMode: true }, "exactly one SphM enum"],
		[{ spherizeDuplicateAmount: true }, "duplicate key"],
		[{ spherizeDuplicateMode: true }, "duplicate key"],
		[{ spherizeUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1399875698"],
	] as const)("preserves malformed Spherize descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Spherize",
				id: 5953,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "spherize", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "spherize",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-axis-selective-spherical-spherize-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact signed Twirl angles with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-twirl-smart-filter.psd");
		const rgba = Array.from({ length: 99 }, (_, index) => [index * 17, 255 - index * 11, index * 23, index === 0 ? 0 : index === 49 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Twirl",
						id: 5962,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 11, 0, 11, 9, 0, 9],
									nonAffineTransform: null,
									smartFilters: [{ type: "twirl", twirlAngle: 420 }],
								})
							),
						],
					}),
				],
				{ width: 11, height: 9 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "twirl-source.psd", fileType: "PSD", data: createCompositePsd(11, 9, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-twirl-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "twirl",
			filterClassId: "Twrl",
			filterId: 1417114220,
			twirl: { angleDegrees: 420 },
			algorithmExecutionModel: "bounded-radial-falloff-twirl-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		for (const angleDegrees of [-420, 0, 999]) {
			const variant = inspectPsdLayers(
				createLayeredPsd([
					layer({
						name: "Twirl variant",
						id: 5964,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "twirl", twirlAngle: angleDegrees }] }))],
					}),
				])
			).layers[0].smartObject?.smartFilters[0];
			expect(variant).toMatchObject({
				type: "twirl",
				twirl: { angleDegrees },
				algorithmExecutionModel: "bounded-radial-falloff-twirl-smart-filter-v1",
				bakeSupported: true,
			});
		}
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-twirl-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("d2ada68e80696a5a71aeb4143db9565f0954a824816c72ebd47273b0d0b2bc8a");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ twirlAngleAsDouble: true }, "exactly one Angl long"],
		[{ twirlAngle: 1000 }, "-999 through 999"],
		[{ twirlAngle: -1000 }, "-999 through 999"],
		[{ twirlOmitAngle: true }, "exactly one Angl long"],
		[{ twirlDuplicateAngle: true }, "duplicate key"],
		[{ twirlUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1417114220"],
	] as const)("preserves malformed Twirl descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Twirl",
				id: 5963,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "twirl", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "twirl",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-radial-falloff-twirl-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact seeded Wave controls with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-wave-smart-filter.psd");
		const rgba = Array.from({ length: 99 }, (_, index) => [index * 17, 255 - index * 11, index * 23, index === 0 ? 0 : index === 49 ? 128 : 255]).flat();
		const smartFilter = {
			type: "wave" as const,
			waveNumberOfGenerators: 3,
			waveType: "sine" as const,
			waveMinimumWavelength: 3,
			waveMaximumWavelength: 9,
			waveMinimumAmplitude: 1,
			waveMaximumAmplitude: 4,
			waveHorizontalScale: 75,
			waveVerticalScale: 55,
			waveRandomSeed: 123456,
			waveUndefinedAreas: "wrapAround" as const,
		};
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Wave",
						id: 5972,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 11, 0, 11, 9, 0, 9],
									nonAffineTransform: null,
									smartFilters: [smartFilter],
								})
							),
						],
					}),
				],
				{ width: 11, height: 9 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "wave-source.psd", fileType: "PSD", data: createCompositePsd(11, 9, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-wave-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "wave",
			filterClassId: "Wave",
			filterId: 1466005093,
			wave: {
				numberOfGenerators: 3,
				type: "sine",
				wavelength: { minimum: 3, maximum: 9 },
				amplitude: { minimum: 1, maximum: 4 },
				scale: { horizontalPercent: 75, verticalPercent: 55 },
				randomSeed: 123456,
				undefinedAreas: "wrapAround",
			},
			algorithmExecutionModel: "bounded-seeded-multi-generator-wave-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		for (const settings of [{ waveType: "triangle" as const }, { waveType: "square" as const }, { waveUndefinedAreas: "repeatEdgePixels" as const }]) {
			const variant = inspectPsdLayers(
				createLayeredPsd([
					layer({
						name: "Wave variant",
						id: 5974,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ ...smartFilter, ...settings }] }))],
					}),
				])
			).layers[0].smartObject?.smartFilters[0];
			expect(variant).toMatchObject({ type: "wave", bakeSupported: true, algorithmExecutionModel: "bounded-seeded-multi-generator-wave-smart-filter-v1" });
		}
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-wave-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("7c85e26ad646f16c128a01516954e408538f40f35965d101b5e6acba6968ecb4");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ waveLongAsDouble: "NmbG" as const }, "exactly one NmbG long"],
		[{ waveNumberOfGenerators: 0 }, "1 through 999"],
		[{ waveNumberOfGenerators: 1000 }, "1 through 999"],
		[{ waveMinimumWavelength: 0 }, "wavelength"],
		[{ waveMaximumWavelength: 1000 }, "wavelength"],
		[{ waveMinimumWavelength: 9, waveMaximumWavelength: 9 }, "wavelength"],
		[{ waveMinimumAmplitude: 0 }, "amplitude"],
		[{ waveMaximumAmplitude: 1000 }, "amplitude"],
		[{ waveMinimumAmplitude: 4, waveMaximumAmplitude: 4 }, "amplitude"],
		[{ waveHorizontalScale: 0 }, "horizontal and vertical scale"],
		[{ waveVerticalScale: 101 }, "horizontal and vertical scale"],
		[{ waveTypeEntryType: "TEXT" as const }, "exactly one Wvtp enum"],
		[{ waveTypeEnumType: "Nope" }, "enum type must be Wvtp"],
		[{ waveType: "unsupported" as const }, "Sine, Triangle, or Square"],
		[{ waveUndefinedAreaEntryType: "TEXT" as const }, "exactly one UndA enum"],
		[{ waveUndefinedAreaEnumType: "Nope" }, "enum type must be UndA"],
		[{ waveUndefinedAreas: "unsupported" as const }, "Wrap Around or Repeat Edge Pixels"],
		[{ waveOmitKey: "WLMn" as const }, "exactly one WLMn long"],
		[{ waveOmitKey: "UndA" as const }, "exactly one UndA enum"],
		[{ waveDuplicateKey: "RndS" as const }, "duplicate key"],
		[{ waveUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1466005093"],
	] as const)("preserves malformed Wave descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Wave",
				id: 5973,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "wave", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "wave",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-seeded-multi-generator-wave-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact signed ZigZag controls and all three styles with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-zigzag-smart-filter.psd");
		const rgba = Array.from({ length: 99 }, (_, index) => [index * 17, 255 - index * 11, index * 23, index === 0 ? 0 : index === 49 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "ZigZag",
						id: 5982,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 11, 0, 11, 9, 0, 9],
									nonAffineTransform: null,
									smartFilters: [{ type: "zigzag", zigZagAmount: 65, zigZagRidges: 5, zigZagStyle: "aroundCenter" }],
								})
							),
						],
					}),
				],
				{ width: 11, height: 9 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "zigzag-source.psd", fileType: "PSD", data: createCompositePsd(11, 9, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-zigzag-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "zigzag",
			filterClassId: "ZgZg",
			filterId: 1516722791,
			zigzag: { amountPercent: 65, ridges: 5, style: "aroundCenter" },
			algorithmExecutionModel: "bounded-aspect-correct-radial-zigzag-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		for (const settings of [
			{ zigZagAmount: -65, zigZagRidges: 5, zigZagStyle: "aroundCenter" as const },
			{ zigZagAmount: 65, zigZagRidges: 5, zigZagStyle: "outFromCenter" as const },
			{ zigZagAmount: 65, zigZagRidges: 5, zigZagStyle: "pondRipples" as const },
			{ zigZagAmount: 0, zigZagRidges: 20, zigZagStyle: "pondRipples" as const },
		]) {
			const variant = inspectPsdLayers(
				createLayeredPsd([
					layer({
						name: "ZigZag variant",
						id: 5984,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "zigzag", ...settings }] }))],
					}),
				])
			).layers[0].smartObject?.smartFilters[0];
			expect(variant).toMatchObject({
				type: "zigzag",
				zigzag: { amountPercent: settings.zigZagAmount, ridges: settings.zigZagRidges, style: settings.zigZagStyle },
				algorithmExecutionModel: "bounded-aspect-correct-radial-zigzag-smart-filter-v1",
				bakeSupported: true,
			});
		}
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-zigzag-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("70730b49d85e549912dbf23d0e0fe15187b988c44b9d072c8210e6c9ae87ba7b");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ zigZagAmountAsDouble: true }, "exactly one Amnt long"],
		[{ zigZagRidgesAsDouble: true }, "one NmbR long"],
		[{ zigZagAmount: 101 }, "-100 through 100"],
		[{ zigZagAmount: -101 }, "-100 through 100"],
		[{ zigZagRidges: -1 }, "0 through 20"],
		[{ zigZagRidges: 21 }, "0 through 20"],
		[{ zigZagOmitAmount: true }, "exactly one Amnt long"],
		[{ zigZagOmitRidges: true }, "one NmbR long"],
		[{ zigZagStyleEntryType: "TEXT" as const }, "exactly one ZZTy enum"],
		[{ zigZagStyleEnumType: "Nope" }, "enum type must be ZZTy"],
		[{ zigZagStyle: "unsupported" as const }, "Around Center, Out From Center, or Pond Ripples"],
		[{ zigZagOmitStyle: true }, "exactly one ZZTy enum"],
		[{ zigZagDuplicateAmount: true }, "duplicate key"],
		[{ zigZagDuplicateRidges: true }, "duplicate key"],
		[{ zigZagDuplicateStyle: true }, "duplicate key"],
		[{ zigZagUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1516722791"],
	] as const)("preserves malformed ZigZag descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed ZigZag",
				id: 5983,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "zigzag", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "zigzag",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-aspect-correct-radial-zigzag-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact RGB, HSB, and HSL channel-model conversions with complete shared MCP evidence", async () => {
		const sourcePath = join(directory, "assets/live-hsb-hsl-smart-filter.psd");
		const rgba = Array.from({ length: 35 }, (_, index) => [index * 37, 255 - index * 19, index * 53, index === 0 ? 0 : index === 17 ? 128 : 255]).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "HSB/HSL",
						id: 5992,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 7, 0, 7, 5, 0, 5],
									nonAffineTransform: null,
									smartFilters: [{ type: "hsbHsl", hsbHslInputMode: "rgb", hsbHslRowOrder: "hsb" }],
								})
							),
						],
					}),
				],
				{ width: 7, height: 5 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "hsb-hsl-source.psd", fileType: "PSD", data: createCompositePsd(7, 5, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-hsb-hsl-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "hsbHsl",
			filterClassId: "HsbP",
			filterId: 1215521360,
			hsbHsl: { inputMode: "rgb", rowOrder: "hsb" },
			algorithmExecutionModel: "bounded-channel-model-hsb-hsl-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		for (const settings of [
			{ hsbHslInputMode: "rgb" as const, hsbHslRowOrder: "hsl" as const },
			{ hsbHslInputMode: "hsb" as const, hsbHslRowOrder: "rgb" as const },
			{ hsbHslInputMode: "hsl" as const, hsbHslRowOrder: "rgb" as const },
			{ hsbHslInputMode: "hsb" as const, hsbHslRowOrder: "hsl" as const },
			{ hsbHslInputMode: "hsl" as const, hsbHslRowOrder: "hsb" as const },
			{ hsbHslInputMode: "rgb" as const, hsbHslRowOrder: "rgb" as const },
		]) {
			const variant = inspectPsdLayers(
				createLayeredPsd([
					layer({
						name: "HSB/HSL variant",
						id: 5994,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "hsbHsl", ...settings }] }))],
					}),
				])
			).layers[0].smartObject?.smartFilters[0];
			expect(variant).toMatchObject({
				type: "hsbHsl",
				hsbHsl: { inputMode: settings.hsbHslInputMode, rowOrder: settings.hsbHslRowOrder },
				algorithmExecutionModel: "bounded-channel-model-hsb-hsl-smart-filter-v1",
				bakeSupported: true,
			});
		}
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-hsb-hsl-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("4101413ed4898e487c5d586f90de83407634b1bb951404a9ea3dc59913d56ca1");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ hsbHslInputEntryType: "TEXT" as const }, "exactly one Inpt ClrS enum"],
		[{ hsbHslRowOrderEntryType: "TEXT" as const }, "exactly one Otpt ClrS enum"],
		[{ hsbHslInputEnumType: "Nope" }, "Inpt enum type must be ClrS"],
		[{ hsbHslRowOrderEnumType: "Nope" }, "Otpt enum type must be ClrS"],
		[{ hsbHslInputMode: "unsupported" as const }, "input mode LbCl is unsupported"],
		[{ hsbHslRowOrder: "unsupported" as const }, "row order LbCl is unsupported"],
		[{ hsbHslOmitInput: true }, "exactly one Inpt ClrS enum"],
		[{ hsbHslOmitRowOrder: true }, "exactly one Otpt ClrS enum"],
		[{ hsbHslDuplicateInput: true }, "duplicate key"],
		[{ hsbHslDuplicateRowOrder: true }, "duplicate key"],
		[{ hsbHslUnknownKey: true }, "unsupported key"],
		[{ filterIdOverride: 1 }, "filterID 1215521360"],
	] as const)("preserves malformed HSB/HSL descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed HSB/HSL",
				id: 5993,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "hsbHsl", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "hsbHsl",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-channel-model-hsb-hsl-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact single and connected-plane Perspective Warp descriptors end to end", async () => {
		const sourcePath = join(directory, "assets/live-perspective-warp-smart-filter.psd");
		const rgba = Array.from({ length: 63 }, (_, index) => {
			const x = index % 9;
			const y = Math.floor(index / 9);
			return [x * 29, y * 37, (x * 17 + y * 23) % 256, x === 0 && y === 0 ? 0 : x === 4 && y === 3 ? 128 : 255];
		}).flat();
		const vertices = [
			{ x: 1, y: 1 },
			{ x: 7, y: 1 },
			{ x: 7, y: 5 },
			{ x: 1, y: 5 },
		];
		const warpedVertices = [
			{ x: 0.5, y: 1.5 },
			{ x: 7.5, y: 0.5 },
			{ x: 6.5, y: 5.5 },
			{ x: 1.5, y: 5 },
		];
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Perspective Warp",
						id: 6000,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 9, 0, 9, 7, 0, 7],
									nonAffineTransform: null,
									smartFilters: [
										{
											type: "perspectiveWarp",
											perspectiveWarpVertices: vertices,
											perspectiveWarpWarpedVertices: warpedVertices,
											perspectiveWarpQuads: [[0, 1, 2, 3]],
										},
									],
								})
							),
						],
					}),
				],
				{ width: 9, height: 7 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "perspective-warp-source.psd", fileType: "PSD", data: createCompositePsd(9, 7, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-perspective-warp-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "perspectiveWarp",
			filterClassId: "perspectiveWarpTransform",
			filterId: 442,
			perspectiveWarp: { vertices, warpedVertices, quads: [[0, 1, 2, 3]], connectedEdgeCount: 0 },
			algorithmExecutionModel: "bounded-piecewise-projective-perspective-warp-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		const connectedVertices = [
			{ x: 0, y: 0 },
			{ x: 4.5, y: 0 },
			{ x: 9, y: 0 },
			{ x: 0, y: 7 },
			{ x: 4.5, y: 7 },
			{ x: 9, y: 7 },
		];
		const connectedWarpedVertices = [
			{ x: 0, y: 0 },
			{ x: 3.5, y: 0.75 },
			{ x: 9, y: 0 },
			{ x: 0, y: 7 },
			{ x: 5.5, y: 6.25 },
			{ x: 9, y: 7 },
		];
		const connected = inspectPsdLayers(
			createLayeredPsd([
				layer({
					name: "Connected Perspective Warp",
					id: 6001,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [
						additional(
							"SoLd",
							smartObjectLayer({
								smartFilters: [
									{
										type: "perspectiveWarp",
										perspectiveWarpVertices: connectedVertices,
										perspectiveWarpWarpedVertices: connectedWarpedVertices,
										perspectiveWarpQuads: [
											[0, 1, 4, 3],
											[1, 2, 5, 4],
										],
									},
								],
							})
						),
					],
				}),
			])
		).layers[0].smartObject?.smartFilters[0];
		expect(connected).toMatchObject({
			type: "perspectiveWarp",
			perspectiveWarp: {
				vertices: connectedVertices,
				warpedVertices: connectedWarpedVertices,
				quads: [
					[0, 1, 4, 3],
					[1, 2, 5, 4],
				],
				connectedEdgeCount: 1,
			},
			bakeSupported: true,
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-perspective-warp-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("390af730e762612cb9094d476b7583eb0e448a9145e8588403ea6bb537cddc94");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ perspectiveWarpOmitVertices: true }, "exactly one vertices VlLs"],
		[{ perspectiveWarpOmitWarpedVertices: true }, "exactly one warpedVertices VlLs"],
		[{ perspectiveWarpOmitQuads: true }, "exactly one quads VlLs"],
		[{ perspectiveWarpDuplicateVertices: true }, "duplicate key"],
		[{ perspectiveWarpUnknownKey: true }, "unsupported key"],
		[{ perspectiveWarpDescriptorClass: "Nope" }, "class/id Nope"],
		[{ perspectiveWarpPointClass: "Nope" }, "class must be Pnt"],
		[{ perspectiveWarpQuadClass: "Nope" }, "class must be null"],
		[{ perspectiveWarpUnits: "#Prc" }, "finite #Pxl UntF coordinate"],
		[
			{
				perspectiveWarpWarpedVertices: [
					{ x: 0, y: 0 },
					{ x: 1, y: 0 },
					{ x: 1, y: 1 },
					{ x: 0, y: 1 },
					{ x: 2, y: 2 },
				],
			},
			"must match the source vertex count",
		],
		[{ perspectiveWarpQuads: [[0, 1, 2, 4]] }, "in-range integers"],
		[{ perspectiveWarpQuads: [[0, 1, 2, 2]] }, "four distinct vertices"],
		[
			{
				perspectiveWarpVertices: [
					{ x: 1, y: 1 },
					{ x: 7, y: 1 },
					{ x: 7, y: 5 },
					{ x: 1, y: 5 },
					{ x: 8, y: 6 },
				],
				perspectiveWarpWarpedVertices: [
					{ x: 1, y: 1 },
					{ x: 7, y: 1 },
					{ x: 7, y: 5 },
					{ x: 1, y: 5 },
					{ x: 8, y: 6 },
				],
			},
			"every source and warped vertex must be referenced",
		],
		[
			{
				perspectiveWarpWarpedVertices: [
					{ x: 0.5, y: 1.5 },
					{ x: 6.5, y: 5.5 },
					{ x: 7.5, y: 0.5 },
					{ x: 1.5, y: 5 },
				],
			},
			"simple convex plane",
		],
		[{ filterIdOverride: 1 }, "filterID 442"],
	] as const)("preserves malformed Perspective Warp descriptors as explicit non-executable evidence", (settings, warning) => {
		const bytes = createLayeredPsd([
			layer({
				name: "Malformed Perspective Warp",
				id: 6002,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "perspectiveWarp", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: settings.perspectiveWarpDescriptorClass === "Nope" ? "unsupported" : "perspectiveWarp",
			bakeSupported: false,
		});
		if (settings.perspectiveWarpDescriptorClass !== "Nope") {
			expect(inspected?.algorithmExecutionModel).toBe("bounded-piecewise-projective-perspective-warp-v1");
		}
		expect(inspected?.warning).toContain(warning);
	});

	test("executes exact point-curve and mapping-table Curves descriptors end to end", async () => {
		const sourcePath = join(directory, "assets/live-curves-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => {
			const x = index % 8;
			const y = Math.floor(index / 8);
			return [x * 36, y * 49, (x * 19 + y * 31) % 256, x === 0 && y === 0 ? 0 : x === 4 && y === 3 ? 128 : 255];
		}).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Curves",
						id: 6010,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "curves" }],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "curves-source.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-curves-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "curves",
			filterClassId: "Crvs",
			filterId: 1131574899,
			curves: {
				presetKind: "custom",
				adjustments: [
					{
						channels: ["composite"],
						mode: "curve",
						points: [
							{ input: 0, output: 0, curved: false },
							{ input: 64, output: 48, curved: true },
							{ input: 128, output: 176, curved: true },
							{ input: 255, output: 255, curved: false },
						],
					},
					{
						channels: ["red"],
						mode: "curve",
						points: [
							{ input: 0, output: 12, curved: false },
							{ input: 96, output: 112, curved: false },
							{ input: 255, output: 244, curved: false },
						],
					},
					{ channels: ["green", "blue"], mode: "mapping", values: Array.from({ length: 256 }, (_, value) => 255 - value) },
				],
			},
			algorithmExecutionModel: "bounded-authored-channel-curves-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		const defaultFilter = inspectPsdLayers(
			createLayeredPsd([
				layer({
					name: "Default Curves",
					id: 6011,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [
						additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "curves", curvesDescriptor: { presetKind: "default", omitAdjustments: true } }] })),
					],
				}),
			])
		).layers[0].smartObject?.smartFilters[0];
		expect(defaultFilter).toMatchObject({
			type: "curves",
			curves: { presetKind: "default", adjustments: [] },
			algorithmExecutionModel: "bounded-authored-channel-curves-smart-filter-v1",
			bakeSupported: true,
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-curves-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("4854cf06f3b98ca290d38de6f191fc1b623ca6b9ebc77f50960c9c605f7ff4cd");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ curvesDescriptor: { omitPreset: true } }, "presetKindType presetKind enum"],
		[{ curvesDescriptor: { duplicatePreset: true } }, "duplicate key"],
		[{ curvesDescriptor: { unknownKey: true } }, "unsupported key"],
		[{ curvesDescriptor: { descriptorClass: "Nope" } }, "class/id Nope"],
		[{ curvesDescriptor: { presetEntryType: "TEXT" } }, "presetKindType presetKind enum"],
		[{ curvesDescriptor: { presetEnumType: "Nope" } }, "presetKindType presetKind enum"],
		[{ curvesDescriptor: { presetKind: "unsupported" } }, "preset kind Nope"],
		[{ curvesDescriptor: { omitAdjustments: true } }, "Custom preset requires"],
		[{ curvesDescriptor: { presetKind: "default" } }, "Default preset cannot contain"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve", classId: "Nope" }] } }, "class must be CrvA"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve", channelsAsLong: true }] } }, "must be one Chnl enum"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve", channelEnumType: "Nope" }] } }, "must be one Chnl enum"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["unsupported"], mode: "curve" }] } }, "value Nope is unsupported"],
		[
			{
				curvesDescriptor: {
					adjustments: [
						{ channels: ["red"], mode: "curve" },
						{ channels: ["red"], mode: "mapping" },
					],
				},
			},
			"channel red is assigned more than once",
		],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "both" }] } }, "exactly one Crv control-point list or Mpng"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "missing" }] } }, "exactly one Crv control-point list or Mpng"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve" }], pointClass: "Nope" } }, "class must be Pnt"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve" }], pointHorizontalAsLong: true } }, "must be one finite 0-255 double"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve" }], pointOmitVertical: true } }, "must be one finite 0-255 double"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve" }], pointDuplicateHorizontal: true } }, "duplicate key"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve" }], pointUnknownKey: true } }, "unsupported key"],
		[{ curvesDescriptor: { adjustments: [{ channels: ["red"], mode: "curve", points: [{ input: 0, output: 0 }] }] } }, "requires 2-16 control points"],
		[
			{
				curvesDescriptor: {
					adjustments: [
						{
							channels: ["red"],
							mode: "curve",
							points: [
								{ input: 128, output: 0 },
								{ input: 64, output: 255 },
							],
						},
					],
				},
			},
			"inputs must be strictly increasing",
		],
		[{ curvesDescriptor: { adjustments: [{ channels: ["blue"], mode: "mapping", values: Array.from({ length: 255 }, (_, value) => value) }] } }, "exactly 256 mapped values"],
		[{ filterIdOverride: 1 }, "filterID 1131574899"],
	] as Array<[{ curvesDescriptor?: CurvesFilterDescriptorOptions; filterIdOverride?: number }, string]>)(
		"preserves malformed Curves descriptors as explicit non-executable evidence",
		(settings, warning) => {
			const bytes = createLayeredPsd([
				layer({
					name: "Malformed Curves",
					id: 6012,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "curves", ...settings }] }))],
				}),
			]);
			const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
			expect(inspected).toMatchObject({
				type: settings.curvesDescriptor?.descriptorClass === "Nope" ? "unsupported" : "curves",
				bakeSupported: false,
			});
			if (settings.curvesDescriptor?.descriptorClass !== "Nope") {
				expect(inspected?.algorithmExecutionModel).toBe("bounded-authored-channel-curves-smart-filter-v1");
			}
			expect(inspected?.warning).toContain(warning);
		}
	);

	test("executes exact modern and legacy Brightness/Contrast descriptors end to end", async () => {
		const sourcePath = join(directory, "assets/live-brightness-contrast-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => {
			const x = index % 8;
			const y = Math.floor(index / 8);
			return [x * 36, y * 49, (x * 19 + y * 31) % 256, x === 0 && y === 0 ? 0 : x === 4 && y === 3 ? 128 : 255];
		}).flat();
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Brightness Contrast",
						id: 6020,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "brightnessContrast", brightnessContrastDescriptor: { brightness: 42, contrast: 65, useLegacy: false } }],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({
						type: "liFD",
						id: "codex-smart-resource",
						name: "brightness-contrast-source.psd",
						fileType: "PSD",
						data: createCompositePsd(8, 6, rgba),
					})
				)
			)
		);
		const options = { destinationFolder: "assets/live-brightness-contrast-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expected = {
			type: "brightnessContrast",
			filterClassId: "BrgC",
			filterId: 1114793795,
			brightnessContrast: { brightness: 42, contrast: 65, useLegacy: false },
			algorithmExecutionModel: "bounded-modern-legacy-brightness-contrast-smart-filter-v1",
			bakeSupported: true,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject(expected);
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject(expected);
		const legacy = inspectPsdLayers(
			createLayeredPsd([
				layer({
					name: "Legacy Brightness Contrast",
					id: 6021,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [
						additional(
							"SoLd",
							smartObjectLayer({ smartFilters: [{ type: "brightnessContrast", brightnessContrastDescriptor: { brightness: -35, contrast: 40, useLegacy: true } }] })
						),
					],
				}),
			])
		).layers[0].smartObject?.smartFilters[0];
		expect(legacy).toMatchObject({
			type: "brightnessContrast",
			brightnessContrast: { brightness: -35, contrast: 40, useLegacy: true },
			algorithmExecutionModel: "bounded-modern-legacy-brightness-contrast-smart-filter-v1",
			bakeSupported: true,
		});
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(await inspectPsdLayerExtraction(scene, { path: "assets/live-brightness-contrast-smart-filter.psd", ...options })).toMatchObject({ fingerprint: plan.fingerprint });
		scene.dispose();
		engine.dispose();
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("8705f2ca75722b9b2e0ed4af172f268759256474041d78ec445d4836b8acf06f");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[{ brightnessContrastDescriptor: { omitBrightness: true } }, "Brgh must be exactly one long"],
		[{ brightnessContrastDescriptor: { omitContrast: true } }, "Cntr must be exactly one long"],
		[{ brightnessContrastDescriptor: { omitLegacy: true } }, "useLegacy must be exactly one bool"],
		[{ brightnessContrastDescriptor: { duplicateBrightness: true } }, "duplicate key"],
		[{ brightnessContrastDescriptor: { duplicateContrast: true } }, "duplicate key"],
		[{ brightnessContrastDescriptor: { duplicateLegacy: true } }, "duplicate key"],
		[{ brightnessContrastDescriptor: { unknownKey: true } }, "unsupported key"],
		[{ brightnessContrastDescriptor: { descriptorClass: "Nope" } }, "class/id Nope"],
		[{ brightnessContrastDescriptor: { brightnessEntryType: "doub" } }, "Brgh must be exactly one long"],
		[{ brightnessContrastDescriptor: { contrastEntryType: "doub" } }, "Cntr must be exactly one long"],
		[{ brightnessContrastDescriptor: { legacyEntryType: "long" } }, "useLegacy must be exactly one bool"],
		[{ brightnessContrastDescriptor: { brightness: -151 } }, "Brgh must be an exact integer from -150 through 150"],
		[{ brightnessContrastDescriptor: { brightness: 151 } }, "Brgh must be an exact integer from -150 through 150"],
		[{ brightnessContrastDescriptor: { contrast: -51 } }, "Cntr must be an exact integer from -50 through 100"],
		[{ brightnessContrastDescriptor: { contrast: 101 } }, "Cntr must be an exact integer from -50 through 100"],
		[{ filterIdOverride: 1 }, "filterID 1114793795"],
	] as Array<[{ brightnessContrastDescriptor?: BrightnessContrastFilterDescriptorOptions; filterIdOverride?: number }, string]>)(
		"preserves malformed Brightness/Contrast descriptors as explicit non-executable evidence",
		(settings, warning) => {
			const bytes = createLayeredPsd([
				layer({
					name: "Malformed Brightness Contrast",
					id: 6022,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "brightnessContrast", ...settings }] }))],
				}),
			]);
			const inspected = inspectPsdLayers(bytes).layers[0].smartObject?.smartFilters[0];
			expect(inspected).toMatchObject({
				type: settings.brightnessContrastDescriptor?.descriptorClass === "Nope" ? "unsupported" : "brightnessContrast",
				bakeSupported: false,
			});
			if (settings.brightnessContrastDescriptor?.descriptorClass !== "Nope") {
				expect(inspected?.algorithmExecutionModel).toBe("bounded-modern-legacy-brightness-contrast-smart-filter-v1");
			}
			expect(inspected?.warning).toContain(warning);
		}
	);

	test("executes modern Oil Paint with complete controls and preserves legacy plug-in evidence", async () => {
		const sourcePath = join(directory, "assets/live-oil-paint-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 5, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat();
		const smartFilter = {
			type: "oilPaint" as const,
			oilPaintStylization: 6.5,
			oilPaintCleanliness: 4,
			oilPaintBrushScale: 7,
			oilPaintBristleDetail: 3.5,
			oilPaintLightDirection: 135,
			oilPaintShine: 5,
		};
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Oil Paint",
						id: 5882,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "oil-paint.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-oil-paint-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedParameters = {
			descriptorVariant: "modern",
			lightingOn: true,
			stylization: 6.5,
			cleanliness: 4,
			brushScale: 7,
			bristleDetail: 3.5,
			lightDirectionDegrees: 135,
			shine: 5,
			legacyPlugin: null,
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "oilPaint",
			filterClassId: "oilPaint",
			filterId: 1122,
			oilPaint: expectedParameters,
			algorithmExecutionModel: "bounded-anisotropic-kuwahara-oil-paint-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "oilPaint",
			oilPaint: expectedParameters,
			algorithmExecutionModel: "bounded-anisotropic-kuwahara-oil-paint-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("0e52072438ef42703665e1b713080e57291e3e00a35c01c6caf5afb878a80390");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });

		const legacySource = createLayeredPsd([
			layer({
				name: "Legacy Oil Paint",
				id: 5883,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ ...smartFilter, oilPaintVariant: "legacyPlugin" }] }))],
			}),
		]);
		const legacy = inspectPsdLayers(legacySource).layers[0].smartObject?.smartFilters[0];
		expect(legacy).toMatchObject({
			type: "oilPaint",
			filterClassId: "PbPl",
			filterId: 1348620396,
			oilPaint: {
				...expectedParameters,
				descriptorVariant: "legacyPlugin",
				legacyPlugin: {
					kernelName: "Oil Paint Plugin",
					gpuEnabled: true,
					lightingEnabled: true,
					filterPath: "1",
					parameters: [
						{ suffix: "aa", name: "Stylization", parameterType: 0, value: 6.5 },
						{ suffix: "ab", name: "Cleanliness", parameterType: 0, value: 4 },
						{ suffix: "ac", name: "Scale", parameterType: 0, value: 7 },
						{ suffix: "ad", name: "Bristle Detail", parameterType: 0, value: 3.5 },
						{ suffix: "ae", name: "Angle", parameterType: 0, value: 135 },
						{ suffix: "af", name: "Shine", parameterType: 0, value: 5 },
					],
				},
			},
			bakeSupported: true,
		});
	});

	test.each([
		[{ oilPaintStylization: 11 }, "Stylization must be between 0 and 10"],
		[{ oilPaintOmitControl: "cleanliness" as const }, "requires exactly one cleanliness"],
		[{ oilPaintLightingAsLong: true }, "lightingOn must be an exact Boolean"],
		[{ oilPaintLightDirection: 361 }, "light direction must be between -360 and 360"],
		[{ oilPaintUnknownKey: true }, "contains unsupported key(s)"],
		[{ oilPaintVariant: "legacyPlugin" as const, oilPaintOmitControl: "specularity" as const }, "requires 6-64 bounded named parameters"],
	] as const)("preserves malformed Oil Paint descriptors as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Oil Paint",
				id: 5884,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "oilPaint", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "oilPaint",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-anisotropic-kuwahara-oil-paint-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes version-3 Liquify RLE displacement and preserves version-2 raw mesh evidence", async () => {
		const sourcePath = join(directory, "assets/live-liquify-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 5, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat();
		const version3Mesh = liquifyMesh({
			version: 3,
			meshWidth: 2,
			meshHeight: 2,
			imageWidth: 8,
			imageHeight: 6,
			displacements: [
				{ x: 0, y: 0 },
				{ x: -1, y: 0.5 },
				{ x: 0.75, y: -0.5 },
				{ x: 0, y: 0 },
			],
		});
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Liquify",
						id: 5892,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 8, 0, 8, 6, 0, 6],
									nonAffineTransform: null,
									smartFilters: [{ type: "liquify", liquifyMesh: version3Mesh }],
								})
							),
						],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "liquify.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-liquify-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const expectedVersion3 = {
			meshVersion: 3,
			signature: "yfqLhseM",
			formatMarker: 2,
			headerBytes: 64,
			meshWidth: 2,
			meshHeight: 2,
			imageWidth: 8,
			imageHeight: 6,
			repeatedImageWidth: 8,
			repeatedImageHeight: 6,
			reservedHeaderWords: [0, 0, 0, 0, 0, 0],
			meshByteLength: 100,
			trailingPaddingBytes: 0,
			displacementEncoding: "little-endian-zero-run-rle-float32-pairs",
			displacementCount: 4,
			nonzeroDisplacementCount: 2,
			rlePacketCount: 5,
			minimumDisplacement: { x: -1, y: -0.5 },
			maximumDisplacement: { x: 0.75, y: 0.5 },
		};
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			type: "liquify",
			filterClassId: "LqFy",
			filterId: 1282492025,
			liquify: expectedVersion3,
			algorithmExecutionModel: "bounded-authored-displacement-liquify-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "liquify",
			liquify: expectedVersion3,
			algorithmExecutionModel: "bounded-authored-displacement-liquify-smart-filter-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("97a38710f3a92c7d952a45f9da5ed93b1a0cdcc586eea8a23126fdb6749ccd22");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });

		const version2Displacements = Array.from({ length: 48 }, (_, index) => (index === 9 ? { x: 1.25, y: -0.5 } : index === 27 ? { x: -0.75, y: 1 } : { x: 0, y: 0 }));
		const version2Mesh = liquifyMesh({
			version: 2,
			meshWidth: 8,
			meshHeight: 6,
			displacements: version2Displacements,
			trailingBytes: Buffer.alloc(8),
		});
		const version2 = inspectPsdLayers(
			createLayeredPsd([
				layer({
					name: "Raw Liquify",
					id: 5893,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [1, 2, 3, 255],
					additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "liquify", liquifyMesh: version2Mesh }] }))],
				}),
			])
		).layers[0].smartObject?.smartFilters[0];
		expect(version2).toMatchObject({
			type: "liquify",
			liquify: {
				meshVersion: 2,
				headerBytes: 24,
				meshWidth: 8,
				meshHeight: 6,
				imageWidth: 8,
				imageHeight: 6,
				repeatedImageWidth: null,
				repeatedImageHeight: null,
				reservedHeaderWords: [],
				meshByteLength: 416,
				trailingPaddingBytes: 8,
				displacementEncoding: "little-endian-float32-pairs",
				displacementCount: 48,
				nonzeroDisplacementCount: 2,
				rlePacketCount: null,
				minimumDisplacement: { x: -0.75, y: -0.5 },
				maximumDisplacement: { x: 1.25, y: 1 },
			},
			bakeSupported: true,
		});
	});

	test.each([
		[
			{ liquifyMesh: liquifyMesh({ version: 3, meshWidth: 1, meshHeight: 1, imageWidth: 8, imageHeight: 6, signature: "badMesh!", displacements: [{ x: 0, y: 0 }] }) },
			'exact "yfqLhseM" signature',
		],
		[
			{ liquifyMesh: liquifyMesh({ version: 3, meshWidth: 1, meshHeight: 1, imageWidth: 8, imageHeight: 6, repeatedImageWidth: 9, displacements: [{ x: 0, y: 0 }] }) },
			"exactly repeated",
		],
		[{ liquifyMesh: liquifyMesh({ version: 2, meshWidth: 1, meshHeight: 1, displacements: [{ x: Number.NaN, y: 0 }] }) }, "finite displacement"],
		[
			{
				liquifyMesh: liquifyMesh({
					version: 3,
					meshWidth: 1,
					meshHeight: 1,
					imageWidth: 8,
					imageHeight: 6,
					displacements: [{ x: 0, y: 0 }],
					trailingBytes: Buffer.from([1]),
				}),
			},
			"unexpected trailing byte",
		],
		[{ liquifyDuplicateMesh: true }, "exactly one LqMe"],
		[{ liquifyMeshEntryType: "TEXT" as const }, "LqMe tdta"],
		[{ liquifyUnknownKey: true }, "contains unsupported key(s)"],
	] as const)("preserves malformed Liquify descriptors as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Liquify",
				id: 5894,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "liquify", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "liquify",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-authored-displacement-liquify-smart-filter-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes an exact authored Puppet Warp solved triangle mesh with complete parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-puppet-warp-smart-filter.psd");
		const rgba = Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 5, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat();
		const smartFilter = { type: "puppetWarp" as const };
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Puppet Warp",
						id: 5872,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 8, 0, 8, 6, 0, 6], nonAffineTransform: null, smartFilters: [smartFilter] }))],
					}),
				],
				{ width: 8, height: 6 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "puppet.psd", fileType: "PSD", data: createCompositePsd(8, 6, rgba) })
				)
			)
		);
		const options = { destinationFolder: "assets/live-puppet-warp-smart-filter-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semantic = plan.items[0].smartObjectLayer?.smartFilters[0];
		expect(semantic).toMatchObject({
			type: "puppetWarp",
			filterClassId: "rigidTransform",
			filterId: 991,
			puppetWarp: {
				rigidType: false,
				bounds: [
					{ x: 0, y: 0 },
					{ x: 8, y: 0 },
					{ x: 8, y: 6 },
					{ x: 0, y: 6 },
				],
				vertexEncoding: "little-endian-float32-pairs",
				indexEncoding: "little-endian-uint32-triangles",
				shapes: [
					{
						meshVersionMajor: 1,
						meshVersionMinor: 0,
						originalVertices: [
							{ x: 0, y: 0 },
							{ x: 8, y: 0 },
							{ x: 8, y: 6 },
							{ x: 0, y: 6 },
						],
						deformedVertices: [
							{ x: 0, y: 0 },
							{ x: 8, y: 0 },
							{ x: 6, y: 5 },
							{ x: 0, y: 6 },
						],
						triangleIndices: [0, 1, 2, 0, 2, 3],
						pinVertexIndices: [0, 2],
						pinRotationsDegrees: [0, 15],
						pinOverlays: [false, true],
						pinDepths: [0, 1],
						selectedPins: [1],
						meshQuality: 2,
						meshExpansion: 0,
						meshRigidity: 1,
						imageResolution: 72,
						boundaryPath: { pathComponents: [{ shapeOperation: "xor", paths: [{ closed: true }] }] },
					},
				],
			},
			algorithmExecutionModel: "bounded-authored-triangle-mesh-puppet-warp-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			type: "puppetWarp",
			puppetWarp: semantic?.puppetWarp,
			algorithmExecutionModel: "bounded-authored-triangle-mesh-puppet-warp-v1",
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(output).digest("hex")).toBe("d8e4f130706ee7d1ba4852f8f97299109ddcd40603d32bd9299dee940de8ad72");
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test.each([
		[
			{
				puppetDeformedVertices: [
					{ x: 0, y: 0 },
					{ x: 8, y: 0 },
					{ x: 6, y: 5 },
				],
			},
			"original/deformed vertex counts must match",
		],
		[{ puppetTriangleIndices: [0, 1, 4] }, "triangle indices must reference an authored vertex"],
		[{ puppetTriangleIndices: [0, 1, 1] }, "triangle 0 is degenerate"],
		[{ puppetPinVertexIndices: [0] }, "pin arrays must share one bounded count"],
		[{ puppetOmitBoundaryPath: true }, "meshBoundaryPath"],
	] as const)("preserves malformed Puppet Warp meshes as explicit non-executable evidence", (settings, warning) => {
		const source = createLayeredPsd([
			layer({
				name: "Malformed Puppet Warp",
				id: 5873,
				left: 0,
				top: 0,
				width: 1,
				height: 1,
				visible: true,
				opacity: 255,
				rgba: [1, 2, 3, 255],
				additionalInfo: [additional("SoLd", smartObjectLayer({ smartFilters: [{ type: "puppetWarp", ...settings }] }))],
			}),
		]);
		const inspected = inspectPsdLayers(source).layers[0].smartObject?.smartFilters[0];
		expect(inspected).toMatchObject({
			type: "puppetWarp",
			bakeSupported: false,
			algorithmExecutionModel: "bounded-authored-triangle-mesh-puppet-warp-v1",
		});
		expect(inspected?.warning).toContain(warning);
	});

	test("executes Motion Blur and Radial Blur in authored order with exact MCP parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-directional-smart-filters.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		const filters = [
			{ type: "motionBlur" as const, angleDegrees: 0, distance: 2 },
			{ type: "radialBlur" as const, amount: 50, method: "zoom" as const, quality: "best" as const },
		];
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Directional Filters",
						id: 5602,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 3, 0, 3, 3, 0, 3], nonAffineTransform: null, smartFilters: filters }))],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "directional.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-directional-smart-filters-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semanticFilters = plan.items[0].smartObjectLayer?.smartFilters ?? [];
		expect(semanticFilters.map((filter) => [filter.type, filter.motionBlur, filter.radialBlur, filter.algorithmExecutionModel, filter.bakeSupported])).toEqual([
			["motionBlur", { angleDegrees: 0, distance: 2, distanceUnits: "#Pxl" }, null, "bounded-motion-blur-smart-filter-v1", true],
			["radialBlur", null, { amount: 50, method: "zoom", quality: "best" }, "bounded-radial-blur-smart-filter-v1", true],
		]);
		expect(
			plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters.map((filter) => [
				filter.index,
				filter.type,
				filter.motionBlur,
				filter.radialBlur,
				filter.algorithmExecutionModel,
			])
		).toEqual(semanticFilters.map((filter) => [filter.index, filter.type, filter.motionBlur, filter.radialBlur, filter.algorithmExecutionModel]));
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			52, 79, 73, 255, 91, 70, 66, 255, 131, 62, 59, 255, 103, 202, 120, 255, 95, 152, 105, 255, 88, 102, 90, 255, 119, 98, 157, 255, 149, 81, 146, 255, 178, 64, 135, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("executes Smart Blur and Surface Blur in authored order with exact MCP parameter evidence", async () => {
		const sourcePath = join(directory, "assets/live-edge-preserving-smart-filters.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		const filters = [
			{ type: "smartBlur" as const, radius: 2, threshold: 100, quality: "high" as const, mode: "normal" as const },
			{ type: "surfaceBlur" as const, radius: 1, threshold: 50 },
		];
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Edge-preserving Filters",
						id: 5612,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ transform: [0, 0, 3, 0, 3, 3, 0, 3], nonAffineTransform: null, smartFilters: filters }))],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "edge-preserving.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-edge-preserving-smart-filters-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semanticFilters = plan.items[0].smartObjectLayer?.smartFilters ?? [];
		expect(semanticFilters.map((filter) => [filter.type, filter.radius, filter.smartBlur, filter.surfaceBlur, filter.algorithmExecutionModel, filter.bakeSupported])).toEqual([
			["smartBlur", 2, { threshold: 100, quality: "high", mode: "normal" }, null, "bounded-smart-blur-smart-filter-v1", true],
			["surfaceBlur", 1, null, { threshold: 50, radiusUnits: "#Pxl" }, "bounded-surface-blur-smart-filter-v1", true],
		]);
		expect(
			plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters.map((filter) => [
				filter.index,
				filter.type,
				filter.radius,
				filter.smartBlur,
				filter.surfaceBlur,
				filter.algorithmExecutionModel,
			])
		).toEqual(semanticFilters.map((filter) => [filter.index, filter.type, filter.radius, filter.smartBlur, filter.surfaceBlur, filter.algorithmExecutionModel]));
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			37, 38, 52, 255, 90, 47, 55, 255, 146, 44, 47, 255, 71, 123, 124, 255, 255, 255, 255, 255, 30, 9, 8, 255, 101, 88, 151, 255, 158, 69, 147, 255, 208, 48, 148, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("executes the Photoshop Heart Card Shape Blur with exact MCP kernel evidence", async () => {
		const sourcePath = join(directory, "assets/live-heart-card-shape-blur.psd");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Heart Card Shape Blur",
						id: 5622,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({ transform: [0, 0, 3, 0, 3, 3, 0, 3], nonAffineTransform: null, smartFilters: [{ type: "shapeBlur", radius: 5 }] })
							),
						],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "heart-card.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = { destinationFolder: "assets/live-heart-card-shape-blur-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		const semanticFilter = plan.items[0].smartObjectLayer?.smartFilters[0];
		expect(semanticFilter).toMatchObject({
			type: "shapeBlur",
			radius: 5,
			shapeBlur: { radiusUnits: "#Pxl", customShape: { name: "Heart Card", id: "e06d65dd-d132-11d5-9a4a-a011a4cb2b24" }, kernel: "heartCard" },
			algorithmExecutionModel: "bounded-heart-card-shape-blur-smart-filter-v1",
			bakeSupported: true,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			index: semanticFilter?.index,
			type: semanticFilter?.type,
			radius: semanticFilter?.radius,
			shapeBlur: semanticFilter?.shapeBlur,
			algorithmExecutionModel: semanticFilter?.algorithmExecutionModel,
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			86, 47, 60, 255, 109, 45, 54, 255, 132, 40, 51, 255, 91, 51, 78, 255, 113, 48, 71, 255, 136, 43, 68, 255, 101, 53, 101, 255, 122, 49, 94, 255, 144, 43, 91, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
	});

	test("leases and executes an explicit project raster for an arbitrary Shape Blur preset", async () => {
		const sourcePath = join(directory, "assets/live-custom-shape-blur.psd");
		const kernelPath = join(directory, "assets/custom-plus-kernel.png");
		const embeddedPsd = createCompositePsd(
			3,
			3,
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 255, 250, 10, 180, 255]
		);
		await sharp(
			Buffer.from([
				255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255,
				255, 0,
			]),
			{ raw: { width: 3, height: 3, channels: 4 } }
		)
			.png()
			.toFile(kernelPath);
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Custom Plus Shape Blur",
						id: 5630,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									transform: [0, 0, 3, 0, 3, 3, 0, 3],
									nonAffineTransform: null,
									smartFilters: [{ type: "shapeBlur", radius: 5, customShapeName: "Custom Plus", customShapeId: "custom-plus" }],
								})
							),
						],
					}),
				],
				{ width: 3, height: 3 },
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "custom-plus.psd", fileType: "PSD", data: embeddedPsd }))
			)
		);
		const options = {
			destinationFolder: "assets/live-custom-shape-blur-output",
			renderEmbeddedSmartObjects: true,
			shapeBlurKernelBindings: [{ shapeId: "custom-plus", sourcePath: "assets/custom-plus-kernel.png", coverageSource: "auto" as const }],
		};
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan.shapeBlurKernelBindings).toEqual([
			expect.objectContaining({
				shapeId: "custom-plus",
				shapeName: "Custom Plus",
				sourcePath: "assets/custom-plus-kernel.png",
				width: 3,
				height: 3,
				requestedCoverageSource: "auto",
				effectiveCoverageSource: "alpha",
				invert: false,
				coverageMinimum: 0,
				coverageMaximum: 255,
				nonZeroSampleCount: 5,
				executionModel: "bounded-custom-shape-blur-kernel-binding-v1",
			}),
		]);
		expect(plan.items[0].smartObjectLayer?.smartFilters[0]).toMatchObject({
			shapeBlur: { customShape: { name: "Custom Plus", id: "custom-plus" }, kernel: null },
			algorithmExecutionModel: null,
			bakeSupported: false,
		});
		expect(plan.items[0].appliedSmartObjectRenders[0].appliedSmartFilters[0]).toMatchObject({
			shapeBlur: { customShape: { name: "Custom Plus", id: "custom-plus" }, kernel: "customBinding" },
			algorithmExecutionModel: "bounded-custom-raster-shape-blur-smart-filter-v1",
			bakeSupported: true,
			warning: null,
		});
		await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
			.png()
			.toFile(kernelPath);
		await expect(applyPsdLayerExtraction(sourcePath, options, plan.fingerprint)).rejects.toThrow("plan changed");
		await sharp(
			Buffer.from([
				255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 255, 255, 255, 255,
				255, 0,
			]),
			{ raw: { width: 3, height: 3, channels: 4 } }
		)
			.png()
			.toFile(kernelPath);
		const current = await getPsdLayerExtractionStatus(sourcePath, options);
		const applied = await applyPsdLayerExtraction(sourcePath, options, current.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...output]).toEqual([
			94, 48, 84, 255, 116, 45, 80, 255, 138, 42, 76, 255, 102, 49, 105, 255, 124, 45, 101, 255, 145, 42, 97, 255, 111, 50, 126, 255, 132, 46, 122, 255, 153, 42, 117, 255,
		]);
		expect(await getPsdLayerExtractionStatus(sourcePath, options)).toMatchObject({ createdCount: 0, reusedCount: 1 });
		await expect(
			getPsdLayerExtractionStatus(sourcePath, {
				...options,
				shapeBlurKernelBindings: [{ shapeId: "missing-shape", sourcePath: "assets/custom-plus-kernel.png" }],
			})
		).rejects.toThrow("not an unresolved Shape Blur preset");
	});

	test("renders a standard embedded smart-object analytical preset warp with orientation, perspective, and lease evidence", async () => {
		const sourcePath = join(directory, "assets/live-preset-warp-smart-object.psd");
		const embeddedPsd = createCompositePsd(
			4,
			3,
			Array.from({ length: 48 }, (_, index) => (index % 4 === 3 ? 255 : (index * 31) % 256))
		);
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Preset Warped Hero",
						id: 4810,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [9, 8, 7, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									warpStyle: "warpWave",
									warpValue: 65,
									warpPerspective: 20,
									warpPerspectiveOther: -15,
									warpRotate: "vertical",
									transform: [5, 7, 13, 7, 13, 13, 5, 13],
									nonAffineTransform: null,
								})
							),
						],
					}),
				],
				{ width: 20, height: 20 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "Preset Source.psd", fileType: "PSD", creator: "8BIM", data: embeddedPsd })
				)
			)
		);
		const options = { destinationFolder: "assets/live-preset-warp-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan.document.layers[0].smartObject?.warp).toMatchObject({
			style: "warpWave",
			value: 65,
			perspective: 20,
			perspectiveOther: -15,
			rotate: "vertical",
		});
		expect(plan.items[0]).toMatchObject({
			smartObjectLayer: { rasterExecutionModel: "bounded-analytical-preset-smart-object-warp-v1" },
			appliedSmartObjectRenders: [
				{
					warpStyle: "warpWave",
					warpValue: 65,
					warpPerspective: 20,
					warpPerspectiveOther: -15,
					warpRotate: "vertical",
					tessellation: 64,
					executionModel: "bounded-analytical-preset-smart-object-warp-v1",
				},
			],
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(output.info.width).toBeGreaterThan(0);
		expect(output.info.height).toBeGreaterThan(0);
		expect(output.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		const reused = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(reused).toMatchObject({ createdCount: 0, reusedCount: 1 });
		await expect(applyPsdLayerExtraction(sourcePath, { ...options, smartObjectRenderLayerIndices: [0] }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("renders an exact embedded smart-object custom Bezier envelope with mesh evidence", async () => {
		const sourcePath = join(directory, "assets/live-custom-warp-smart-object.psd");
		const embeddedPsd = createCompositePsd(2, 2, [240, 20, 30, 255, 20, 220, 40, 255, 20, 50, 230, 255, 250, 220, 20, 255]);
		const mesh = Array.from({ length: 16 }, (_, index) => {
			const column = index % 4;
			const row = Math.floor(index / 4);
			return { x: (column * 2) / 3 + (column === 2 && row === 1 ? 0.25 : 0), y: (row * 2) / 3 + (column === 1 && row === 2 ? -0.2 : 0) };
		});
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Warped Live Hero",
						id: 4780,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [9, 8, 7, 255],
						additionalInfo: [
							additional("SoLd", smartObjectLayer({ warpStyle: "warpCustom", customMesh: mesh, transform: [5, 7, 9, 7, 9, 11, 5, 11], nonAffineTransform: null })),
						],
					}),
				],
				{ width: 12, height: 12 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "Warp Source.psd", fileType: "PSD", creator: "8BIM", data: embeddedPsd })
				)
			)
		);
		const options = { destinationFolder: "assets/live-custom-warp-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan.document.layers[0].smartObject?.warp).toMatchObject({
			style: "warpCustom",
			uOrder: 4,
			vOrder: 4,
			meshPoints: mesh,
			meshExecutionModel: "tensor",
			meshExecutionSupported: true,
			meshWarning: null,
		});
		expect(plan.items[0]).toMatchObject({
			left: 5,
			top: 7,
			width: 4,
			height: 4,
			smartObjectLayer: { rasterExecutionModel: "bounded-bezier-smart-object-warp-v1" },
			appliedSmartObjectRenders: [
				{
					warpStyle: "warpCustom",
					uOrder: 4,
					vOrder: 4,
					meshPointCount: 16,
					tessellation: 32,
					executionModel: "bounded-bezier-smart-object-warp-v1",
				},
			],
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(output.info).toMatchObject({ width: 4, height: 4, channels: 4 });
		expect(output.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
	});

	test("renders an exact embedded smart-object piecewise-Bezier quilt envelope with slice evidence", async () => {
		const sourcePath = join(directory, "assets/live-quilt-warp-smart-object.psd");
		const embeddedPsd = createCompositePsd(2, 2, [210, 20, 30, 255, 20, 210, 40, 255, 20, 40, 220, 255, 240, 220, 30, 255]);
		const mesh = Array.from({ length: 49 }, (_, index) => {
			const column = index % 7;
			const row = Math.floor(index / 7);
			return { x: column / 3 + (column === 4 && row === 2 ? 0.2 : 0), y: row / 3 + (column === 2 && row === 4 ? -0.15 : 0) };
		});
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Quilt Warped Hero",
						id: 4800,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [9, 8, 7, 255],
						additionalInfo: [
							additional(
								"SoLd",
								smartObjectLayer({
									warpStyle: "warpCustom",
									customMesh: mesh,
									uOrder: 4,
									vOrder: 4,
									deformNumRows: 2,
									deformNumCols: 2,
									quiltSliceX: [0, 1, 2],
									quiltSliceY: [0, 1, 2],
									transform: [5, 7, 9, 7, 9, 11, 5, 11],
									nonAffineTransform: null,
								})
							),
						],
					}),
				],
				{ width: 12, height: 12 },
				globalAdditional(
					"lnk2",
					linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "Quilt Source.psd", fileType: "PSD", creator: "8BIM", data: embeddedPsd })
				)
			)
		);
		const options = { destinationFolder: "assets/live-quilt-warp-output", renderEmbeddedSmartObjects: true } as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan.document.layers[0].smartObject?.warp).toMatchObject({
			style: "warpCustom",
			uOrder: 4,
			vOrder: 4,
			deformNumRows: 2,
			deformNumCols: 2,
			meshPoints: mesh,
			quiltSliceX: [0, 1, 2],
			quiltSliceY: [0, 1, 2],
			meshExecutionModel: "quilt",
			meshExecutionSupported: true,
			meshWarning: null,
		});
		expect(plan.items[0]).toMatchObject({
			left: 5,
			top: 7,
			width: 4,
			height: 4,
			smartObjectLayer: { rasterExecutionModel: "bounded-piecewise-bezier-smart-object-quilt-warp-v1" },
			appliedSmartObjectRenders: [
				{
					warpStyle: "warpCustom",
					uOrder: 4,
					vOrder: 4,
					deformNumRows: 2,
					deformNumCols: 2,
					meshPointCount: 49,
					quiltSliceX: [0, 1, 2],
					quiltSliceY: [0, 1, 2],
					tessellation: 28,
					executionModel: "bounded-piecewise-bezier-smart-object-quilt-warp-v1",
				},
			],
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(output.info).toMatchObject({ width: 4, height: 4, channels: 4 });
		expect(output.data.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		const reused = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(reused).toMatchObject({ createdCount: 0, reusedCount: 1 });
		await expect(applyPsdLayerExtraction(sourcePath, { ...options, smartObjectRenderLayerIndices: [0] }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("blocks malformed tensor and quilt custom smart-object envelopes explicitly", async () => {
		const fixture = async (name: string, smart: Buffer): Promise<string> => {
			const path = join(directory, "assets", name);
			await writeFile(
				path,
				createLayeredPsd(
					[
						layer({
							name: "Malformed Warp",
							id: 4781,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [1, 2, 3, 255],
							additionalInfo: [additional("SoLd", smart)],
						}),
					],
					{ width: 4, height: 4 },
					globalAdditional(
						"lnk2",
						linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "Warp.psd", fileType: "PSD", data: createCompositePsd(1, 1, [1, 2, 3, 255]) })
					)
				)
			);
			return path;
		};
		const malformed = smartObjectLayer({ warpStyle: "warpCustom", customMesh: [{ x: 0, y: 0 }], uOrder: 4, vOrder: 4 });
		await expect(getPsdLayerExtractionStatus(await fixture("malformed-custom-warp.psd", malformed), { renderEmbeddedSmartObjects: true })).rejects.toThrow(
			"Custom envelope requires bounded"
		);
		const grid = Array.from({ length: 16 }, (_, index) => ({ x: (index % 4) / 3, y: Math.floor(index / 4) / 3 }));
		const quilt = smartObjectLayer({ warpStyle: "warpCustom", customMesh: grid, deformNumRows: 4, deformNumCols: 4 });
		await expect(getPsdLayerExtractionStatus(await fixture("quilt-custom-warp.psd", quilt), { renderEmbeddedSmartObjects: true })).rejects.toThrow(
			"Quilt envelope requires an exact piecewise control lattice"
		);
	});

	test("renders only an explicitly bound external raster source and leases its exact bytes", async () => {
		const sourcePath = join(directory, "assets/live-external-smart-object.psd");
		const externalPath = join(directory, "selected-external.png");
		const externalPixels = Buffer.from([220, 20, 30, 255, 40, 210, 50, 128]);
		await sharp(externalPixels, { raw: { width: 2, height: 1, channels: 4 } })
			.png()
			.toFile(externalPath);
		const externalBytes = await readFile(externalPath);
		const external = linkedResourceRecord({
			type: "liFE",
			id: "external-live-resource",
			name: "Untrusted Stored Name.png",
			fileType: "PNG",
			external: {
				name: "Untrusted Stored Name.png",
				fullPath: "/must/not/be/read.png",
				originalPath: "C:/must/not/be/read.png",
				relativePath: "../../must-not-be-read.png",
				fileSize: externalBytes.byteLength,
			},
		});
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Live External Hero",
						id: 4770,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [
							additional("SoLd", smartObjectLayer({ resourceId: "external-live-resource", transform: [3, 4, 7, 4, 7, 6, 3, 6], nonAffineTransform: null })),
						],
					}),
				],
				{ width: 8, height: 8 },
				globalAdditional("lnkE", external)
			)
		);
		const options = {
			destinationFolder: "assets/live-external-output",
			renderExternalSmartObjects: true,
			smartObjectExternalBindings: [{ resourceIndex: 0, sourcePath: externalPath }],
		} as const;
		const plan = await getPsdLayerExtractionStatus(sourcePath, options);
		expect(plan).toMatchObject({
			renderEmbeddedSmartObjects: false,
			renderExternalSmartObjects: true,
			items: [
				{
					left: 3,
					top: 4,
					width: 4,
					height: 2,
					appliedSmartObjectRenders: [
						{
							sourceKind: "external",
							sourcePath: externalPath,
							sourceFormat: "png",
							resourceIndex: 0,
							resourceId: "external-live-resource",
							resourceBytes: externalBytes.byteLength,
							sourceWidth: 2,
							sourceHeight: 1,
							corners: [3, 4, 7, 4, 7, 6, 3, 6],
							executionModel: "bounded-projective-smart-object-v1",
						},
					],
				},
			],
		});
		const applied = await applyPsdLayerExtraction(sourcePath, options, plan.fingerprint);
		const output = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(output.info).toMatchObject({ width: 4, height: 2, channels: 4 });
		expect([...output.data]).toContain(220);
		await writeFile(
			externalPath,
			await sharp(Buffer.from([9, 8, 7, 255]), { raw: { width: 1, height: 1, channels: 4 } })
				.png()
				.toBuffer()
		);
		await expect(
			applyPsdLayerExtraction(
				sourcePath,
				{ ...options, smartObjectExternalBindings: [{ resourceIndex: 0, sourcePath: externalPath, allowSizeMismatch: true }] },
				plan.fingerprint
			)
		).rejects.toThrow("plan changed");
	});

	test("blocks external live rendering without explicit binding and unsupported external formats", async () => {
		const sourcePath = join(directory, "assets/blocked-external-smart-object.psd");
		const external = linkedResourceRecord({
			type: "liFE",
			id: "external-live-resource",
			name: "Blocked.psb",
			fileType: "PSB",
			external: { name: "Blocked.psb", fullPath: "/untrusted.psb", originalPath: "C:/untrusted.psb", relativePath: "../untrusted.psb", fileSize: 4 },
		});
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Blocked External",
						id: 4771,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer({ resourceId: "external-live-resource" }))],
					}),
				],
				{ width: 2, height: 2 },
				globalAdditional("lnkE", external)
			)
		);
		await expect(getPsdLayerExtractionStatus(sourcePath, { renderExternalSmartObjects: true })).rejects.toThrow("requires an explicit smartObjectExternalBindings entry");
		const selected = join(directory, "selected.hdr");
		await writeFile(selected, Buffer.from("HDR!"));
		await expect(
			getPsdLayerExtractionStatus(sourcePath, {
				renderExternalSmartObjects: true,
				smartObjectExternalBindings: [{ resourceIndex: 0, sourcePath: selected }],
			})
		).rejects.toThrow("not supported by bounded RGBA8 rendering");
	});

	test("inventories smart-object link records, associates exact IDs, and publishes only confirmed embedded payloads", async () => {
		const sourcePath = join(directory, "assets/smart-object-links.psd");
		const payload = Buffer.from("embedded-smart-object-payload", "utf8");
		const embedded = linkedResourceRecord({
			type: "liFD",
			id: "codex-smart-resource",
			name: "../../Hero Source.psd",
			fileType: "PSD",
			creator: "8BIM",
			data: payload,
		});
		const alias = linkedResourceRecord({ type: "liFA", id: "alias-resource", name: "Alias Only", fileType: "PNG" });
		const external = linkedResourceRecord({
			type: "liFE",
			id: "external-resource",
			name: "External Hero",
			fileType: "PSB",
			external: {
				name: "External Hero.psb",
				fullPath: "/private/artist/External Hero.psb",
				originalPath: "C:/artist/External Hero.psb",
				relativePath: "../External Hero.psb",
				fileSize: 9876,
			},
		});
		await writeFile(
			sourcePath,
			createLayeredPsd(
				[
					layer({
						name: "Placed Hero",
						id: 4710,
						left: 0,
						top: 0,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [12, 34, 56, 255, 78, 90, 123, 160],
						additionalInfo: [additional("SoLd", smartObjectLayer())],
					}),
				],
				{ width: 2, height: 1 },
				Buffer.concat([globalAdditional("lnk2", Buffer.concat([embedded, alias])), globalAdditional("lnkE", external)])
			)
		);
		const inventory = await getPsdLayerExtractionStatus(sourcePath, { destinationFolder: "assets/smart-object-link-output" });
		expect(inventory.document.smartObjectResources).toEqual([
			expect.objectContaining({
				index: 0,
				sourceKey: "lnk2",
				recordSignature: "liFD",
				type: "embedded",
				version: 2,
				id: "codex-smart-resource",
				name: "../../Hero Source.psd",
				fileType: "PSD",
				creator: "8BIM",
				dataBytes: payload.length,
				payloadAvailable: true,
				executionModel: "bounded-smart-object-link-v1",
			}),
			expect.objectContaining({ index: 1, sourceKey: "lnk2", recordSignature: "liFA", type: "alias", id: "alias-resource", payloadAvailable: false }),
			expect.objectContaining({
				index: 2,
				sourceKey: "lnkE",
				recordSignature: "liFE",
				type: "external",
				id: "external-resource",
				external: {
					fileSize: 9876,
					name: "External Hero.psb",
					fullPath: "/private/artist/External Hero.psb",
					originalPath: "C:/artist/External Hero.psb",
					relativePath: "../External Hero.psb",
					time: "2026-07-22T10:30:15.250Z",
				},
			}),
		]);
		expect(inventory.document.layers[0].smartObject?.linkedResource).toEqual({ status: "embedded", resourceIndices: [0] });
		expect(inventory.smartObjectPayloads).toEqual([]);
		const plan = await getPsdLayerExtractionStatus(sourcePath, {
			destinationFolder: "assets/smart-object-link-output",
			extractSmartObjectPayloads: true,
			smartObjectResourceIds: ["codex-smart-resource"],
		});
		expect(plan.smartObjectPayloads).toEqual([
			expect.objectContaining({
				resourceIndex: 0,
				resourceId: "codex-smart-resource",
				associatedLayerIndices: [0],
				path: "assets/smart-object-link-output/smart-objects/0001-Hero Source.psd",
				byteLength: payload.length,
				action: "create",
				executionModel: "bounded-smart-object-payload-publication-v1",
			}),
		]);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const actionPlan = await inspectPsdLayerExtraction(scene, {
			path: "assets/smart-object-links.psd",
			destinationFolder: "assets/smart-object-link-output",
			extractSmartObjectPayloads: true,
			smartObjectResourceIds: ["codex-smart-resource"],
		});
		expect(actionPlan.smartObjectPayloads[0]).toMatchObject({ resourceId: "codex-smart-resource", action: "create" });
		const applied = await extractPsdLayers(
			scene,
			{
				path: "assets/smart-object-links.psd",
				destinationFolder: "assets/smart-object-link-output",
				extractSmartObjectPayloads: true,
				smartObjectResourceIds: ["codex-smart-resource"],
				expectedFingerprint: actionPlan.fingerprint,
				confirm: true,
			},
			{ editor: { layout: { assets: { refresh: () => undefined } } } } as never
		);
		expect(await readFile(join(directory, applied.smartObjectPayloads[0].path))).toEqual(payload);
		scene.dispose();
		engine.dispose();
		const reused = await getPsdLayerExtractionStatus(sourcePath, {
			destinationFolder: "assets/smart-object-link-output",
			extractSmartObjectPayloads: true,
			smartObjectResourceIds: ["codex-smart-resource"],
		});
		expect(reused.smartObjectPayloadReusedCount).toBe(1);
		await expect(
			getPsdLayerExtractionStatus(sourcePath, {
				destinationFolder: "assets/external-link-output",
				extractSmartObjectPayloads: true,
				smartObjectResourceIds: ["external-resource"],
			})
		).rejects.toThrow("never resolved, read, or copied");
		const externalSourcePath = join(dirname(directory), `${basename(directory)}-external.psb`);
		const externalBytes = Buffer.from("reviewed-external-smart-object", "utf8");
		try {
			await writeFile(externalSourcePath, externalBytes);
			await expect(
				getPsdLayerExtractionStatus(sourcePath, {
					destinationFolder: "assets/external-binding-output",
					extractSmartObjectPayloads: true,
					smartObjectResourceIds: [],
					smartObjectExternalBindings: [{ resourceIndex: 2, sourcePath: externalSourcePath }],
				})
			).rejects.toThrow("set allowSizeMismatch=true only after reviewing");
			const externalOptions = {
				destinationFolder: "assets/external-binding-output",
				extractSmartObjectPayloads: true,
				smartObjectResourceIds: [],
				smartObjectExternalBindings: [{ resourceIndex: 2, sourcePath: externalSourcePath, allowSizeMismatch: true }],
			};
			const externalPlan = await getPsdLayerExtractionStatus(sourcePath, externalOptions);
			expect(externalPlan.smartObjectPayloads).toEqual([
				expect.objectContaining({
					resourceIndex: 2,
					recordSignature: "liFE",
					sourceType: "externalBinding",
					sourcePath: externalSourcePath,
					declaredFileSize: 9876,
					sizeMatches: false,
					byteLength: externalBytes.length,
					path: "assets/external-binding-output/smart-objects/0003-External Hero.psb",
				}),
			]);
			await writeFile(externalSourcePath, Buffer.from("changed-after-inspection"));
			await expect(applyPsdLayerExtraction(sourcePath, externalOptions, externalPlan.fingerprint)).rejects.toThrow("plan changed");
			await writeFile(externalSourcePath, externalBytes);
			const currentExternalPlan = await getPsdLayerExtractionStatus(sourcePath, externalOptions);
			const externalApplied = await applyPsdLayerExtraction(sourcePath, externalOptions, currentExternalPlan.fingerprint);
			expect(await readFile(join(directory, externalApplied.smartObjectPayloads[0].path))).toEqual(externalBytes);
			await expect(
				getPsdLayerExtractionStatus(sourcePath, {
					...externalOptions,
					smartObjectExternalBindings: [{ resourceIndex: 2, sourcePath: "relative/external.psb", allowSizeMismatch: true }],
				})
			).rejects.toThrow("absolute local file path");
		} finally {
			await remove(externalSourcePath);
		}
	});

	test("rejects linked-resource records whose declared size escapes the global tagged block", async () => {
		const malformed = Buffer.concat([u64(1024), Buffer.from("liFD")]);
		await writeFile(source, createLayeredPsd(undefined, undefined, globalAdditional("lnk2", malformed)));
		await expect(getPsdLayerExtractionStatus(source)).rejects.toThrow("linked-resource record");
	});

	test("recursively inspects bounded embedded PSD-v1 smart-object documents with exact ancestry and blockers", async () => {
		const leaf = createLayeredPsd([], { width: 2, height: 3 });
		const malformedPsd = Buffer.concat([Buffer.from("8BPS"), u16(1)]);
		const inner = createLayeredPsd(
			[],
			{ width: 4, height: 5 },
			globalAdditional(
				"lnk2",
				Buffer.concat([
					linkedResourceRecord({ type: "liFD", id: "leaf-psd", name: "leaf.psd", fileType: "PSD", data: leaf }),
					linkedResourceRecord({ type: "liFD", id: "raw-image", name: "image.png", fileType: "PNG", data: Buffer.from("not-a-psd") }),
					linkedResourceRecord({ type: "liFD", id: "broken-psd", name: "broken.psd", fileType: "PSD", data: malformedPsd }),
				])
			)
		);
		await writeFile(
			source,
			createLayeredPsd(
				undefined,
				undefined,
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "inner-psd", name: "inner.psd", fileType: "PSD", data: inner }))
			)
		);

		const baseline = await getPsdLayerExtractionStatus(source);
		expect(baseline).toMatchObject({ inspectNestedSmartObjects: false, nestedSmartObjectMaximumDepth: 4, nestedSmartObjectDocuments: [] });
		await expect(getPsdLayerExtractionStatus(source, { nestedSmartObjectMaximumDepth: 2 })).rejects.toThrow("requires inspectNestedSmartObjects=true");

		const depthLimited = await getPsdLayerExtractionStatus(source, { inspectNestedSmartObjects: true, nestedSmartObjectMaximumDepth: 1 });
		expect(depthLimited.nestedSmartObjectDocuments.map((entry) => ({ path: entry.resourcePath, status: entry.status, format: entry.format }))).toEqual([
			{ path: [0], status: "inspected", format: "psd-v1" },
			{ path: [0, 0], status: "depthLimit", format: "psd-v1" },
			{ path: [0, 1], status: "unsupported", format: "other" },
			{ path: [0, 2], status: "depthLimit", format: "psd-v1" },
		]);

		const engine = new NullEngine();
		const scene = new Scene(engine);
		const inspected = await inspectPsdLayerExtraction(scene, {
			path: "assets/hero.psd",
			inspectNestedSmartObjects: true,
			nestedSmartObjectMaximumDepth: 2,
			offset: 0,
			limit: 10,
		});
		expect(inspected).toMatchObject({
			inspectNestedSmartObjects: true,
			nestedSmartObjectMaximumDepth: 2,
			nestedSmartObjectInspectedCount: 2,
			nestedSmartObjectBlockedCount: 2,
		});
		expect(
			inspected.nestedSmartObjectDocuments.map((entry: { resourcePath: number[]; resourceIdPath: string[]; status: string; document: unknown }) => ({
				path: entry.resourcePath,
				ids: entry.resourceIdPath,
				status: entry.status,
				hasDocument: entry.document !== null,
			}))
		).toEqual([
			{ path: [0], ids: ["inner-psd"], status: "inspected", hasDocument: true },
			{ path: [0, 0], ids: ["inner-psd", "leaf-psd"], status: "inspected", hasDocument: true },
			{ path: [0, 1], ids: ["inner-psd", "raw-image"], status: "unsupported", hasDocument: false },
			{ path: [0, 2], ids: ["inner-psd", "broken-psd"], status: "malformed", hasDocument: false },
		]);
		expect(inspected.nestedSmartObjectDocuments[1].document).toMatchObject({ width: 2, height: 3, layerCount: 0 });
		expect(inspected.nestedSmartObjectDocuments[0].document).toMatchObject({ smartObjectResourceCount: 3, embeddedResourceCount: 3, externalResourceCount: 0 });
		expect(inspected.nestedSmartObjectDocuments[3].message).toContain("Malformed PSD");

		const applied = await extractPsdLayers(
			scene,
			{
				path: "assets/hero.psd",
				inspectNestedSmartObjects: true,
				nestedSmartObjectMaximumDepth: 2,
				expectedFingerprint: inspected.fingerprint,
				confirm: true,
			},
			{ editor: { layout: { assets: { refresh: () => undefined } } } } as never
		);
		expect(applied).toMatchObject({ extracted: true, nestedSmartObjectInspectedCount: 2, nestedSmartObjectBlockedCount: 2 });
		scene.dispose();
		engine.dispose();
	});

	test("rebuilds multiple embedded liFD records with exact replacement bytes while preserving the source", async () => {
		const first = linkedResourceRecord({ type: "liFD", id: "replace-first", name: "first.bin", data: Buffer.from([1, 2]) });
		const second = linkedResourceRecord({ type: "liFD", id: "replace-second", name: "second.bin", data: Buffer.from([3, 4, 5, 6, 7]) });
		const original = createLayeredPsd(undefined, undefined, globalAdditional("lnk2", Buffer.concat([first, second])));
		const originalCopy = Buffer.from(original);
		const rewritten = replacePsdEmbeddedSmartObjectPayloads(original, [
			{ resourceIndex: 0, data: Buffer.from("replacement-one") },
			{ resourceIndex: 1, data: Buffer.from([8]) },
		]);
		expect(original).toEqual(originalCopy);
		expect(rewritten).toMatchObject({
			executionModel: "bounded-smart-object-payload-replacement-v1",
			items: [
				{ resourceIndex: 0, previousByteLength: 2, replacementByteLength: 15 },
				{ resourceIndex: 1, previousByteLength: 5, replacementByteLength: 1 },
			],
		});
		expect(inspectPsdLayers(rewritten.data).smartObjectResources).toMatchObject([
			{ id: "replace-first", dataBytes: 15 },
			{ id: "replace-second", dataBytes: 1 },
		]);
		expect(decodePsdSmartObjectResources(rewritten.data).map((resource) => Buffer.from(resource.data))).toEqual([Buffer.from("replacement-one"), Buffer.from([8])]);
		expect(() =>
			replacePsdEmbeddedSmartObjectPayloads(original, [
				{ resourceIndex: 0, data: Buffer.from([1]) },
				{ resourceIndex: 0, data: Buffer.from([2]) },
			])
		).toThrow("duplicate resourceIndex 0");
	});

	test("recursively rebuilds exact nested liFD resource paths and every ancestor PSD", async () => {
		const leaf = createLayeredPsd(
			undefined,
			undefined,
			globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "recursive-leaf", name: "leaf.bin", data: Buffer.from("LEAF-OLD") }))
		);
		const inner = createLayeredPsd(
			undefined,
			undefined,
			globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "recursive-inner", name: "leaf.psd", fileType: "8BPS", data: leaf }))
		);
		const outer = createLayeredPsd(
			undefined,
			undefined,
			globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "recursive-outer", name: "inner.psd", fileType: "8BPS", data: inner }))
		);
		const original = Buffer.from(outer);
		const replacement = Buffer.from("LEAF-REPLACEMENT-475");
		const rewritten = replacePsdNestedEmbeddedSmartObjectPayloads(outer, [{ resourcePath: [0, 0, 0], data: replacement }]);
		expect(outer).toEqual(original);
		expect(rewritten).toMatchObject({
			executionModel: "bounded-recursive-smart-object-payload-replacement-v1",
			items: [
				{
					resourcePath: [0, 0, 0],
					resourceIdPath: ["recursive-outer", "recursive-inner", "recursive-leaf"],
					previousByteLength: 8,
					replacementByteLength: replacement.byteLength,
				},
			],
			ancestorRebuilds: [{ resourcePath: [0, 0] }, { resourcePath: [0] }],
		});
		const rewrittenInner = Buffer.from(decodePsdSmartObjectResources(rewritten.data)[0].data);
		const rewrittenLeaf = Buffer.from(decodePsdSmartObjectResources(rewrittenInner)[0].data);
		expect(Buffer.from(decodePsdSmartObjectResources(rewrittenLeaf)[0].data)).toEqual(replacement);
		expect(() =>
			replacePsdNestedEmbeddedSmartObjectPayloads(outer, [
				{ resourcePath: [0], data: Buffer.from([1]) },
				{ resourcePath: [0, 0], data: Buffer.from([2]) },
			])
		).toThrow("overlap");
		expect(() => replacePsdNestedEmbeddedSmartObjectPayloads(outer, [{ resourcePath: [0, 0, 1], data: Buffer.from([1]) }])).toThrow("is not an embedded liFD payload");
	});

	test("plans and atomically publishes a leased PSD copy with explicitly selected embedded replacements", async () => {
		const originalPayload = Buffer.from("ORIGINAL-474");
		await writeFile(
			source,
			createLayeredPsd(
				undefined,
				undefined,
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "replace-474", name: "source.psb", fileType: "8BPS", data: originalPayload }))
			)
		);
		const sourceBefore = await readFile(source);
		const replacementPath = join(directory, "replacement-474.psb");
		const replacement = Buffer.from("REPLACED-474");
		await writeFile(replacementPath, replacement);
		const options = { destinationPath: "assets/replaced-474.psd", replacements: [{ resourceIndex: 0, sourcePath: replacementPath }] };
		const planned = await getPsdSmartObjectPayloadReplacementStatus(source, options);
		expect(planned).toMatchObject({
			path: "assets/hero.psd",
			destinationPath: "assets/replaced-474.psd",
			action: "create",
			items: [
				{
					resourceIndex: 0,
					resourceId: "replace-474",
					sourcePath: replacementPath,
					previousByteLength: originalPayload.byteLength,
					replacementByteLength: replacement.byteLength,
					executionModel: "bounded-smart-object-payload-replacement-v1",
				},
			],
			executionModel: "bounded-smart-object-payload-replacement-v1",
		});
		await writeFile(replacementPath, Buffer.from("MUTATED!-474"));
		await expect(applyPsdSmartObjectPayloadReplacement(source, options, planned.fingerprint)).rejects.toThrow("plan changed");
		await writeFile(replacementPath, replacement);
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const bridgePlan = await inspectPsdSmartObjectPayloadReplacement(scene, { path: "assets/hero.psd", ...options });
		expect(bridgePlan).toMatchObject({ action: "create", destinationPath: options.destinationPath, fingerprint: planned.fingerprint });
		let refreshed = 0;
		const applied = await replacePsdSmartObjectPayloads(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: bridgePlan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => refreshed++ } } },
		} as never);
		expect(applied).toMatchObject({ replaced: true, action: "create", destinationPath: options.destinationPath });
		expect(refreshed).toBe(1);
		expect(await readFile(source)).toEqual(sourceBefore);
		const output = await readFile(join(directory, applied.destinationPath));
		expect(createHash("sha256").update(output).digest("hex")).toBe(applied.outputHash);
		expect(Buffer.from(decodePsdSmartObjectResources(output)[0].data)).toEqual(replacement);
		expect(await getPsdSmartObjectPayloadReplacementStatus(source, options)).toMatchObject({ action: "reuse", outputHash: applied.outputHash });
		await expect(getPsdSmartObjectPayloadReplacementStatus(source, { ...options, destinationPath: "assets/hero.psd" })).rejects.toThrow("never rewrites the source in place");
		scene.dispose();
		engine.dispose();
	});

	test("plans and publishes exact recursively nested replacement paths through the editor bridge", async () => {
		const leaf = createLayeredPsd(
			undefined,
			undefined,
			globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "bridge-leaf-475", name: "leaf.bin", data: Buffer.from("OLD-475") }))
		);
		const inner = createLayeredPsd(
			undefined,
			undefined,
			globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "bridge-inner-475", name: "leaf.psd", fileType: "8BPS", data: leaf }))
		);
		await writeFile(
			source,
			createLayeredPsd(
				undefined,
				undefined,
				globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "bridge-outer-475", name: "inner.psd", fileType: "8BPS", data: inner }))
			)
		);
		const replacementPath = join(directory, "replacement-475.bin");
		const replacement = Buffer.from("RECURSIVE-REPLACEMENT-475");
		await writeFile(replacementPath, replacement);
		const options = {
			destinationPath: "assets/recursive-475.psd",
			replacements: [{ resourcePath: [0, 0, 0], sourcePath: replacementPath }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdSmartObjectPayloadReplacement(scene, { path: "assets/hero.psd", ...options });
		expect(plan).toMatchObject({
			action: "create",
			executionModel: "bounded-recursive-smart-object-payload-replacement-v1",
			items: [{ resourcePath: [0, 0, 0], resourceIdPath: ["bridge-outer-475", "bridge-inner-475", "bridge-leaf-475"] }],
			ancestorRebuilds: [{ resourcePath: [0, 0] }, { resourcePath: [0] }],
		});
		let refreshed = 0;
		const applied = await replacePsdSmartObjectPayloads(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => refreshed++ } } },
		} as never);
		expect(applied).toMatchObject({ replaced: true, action: "create", executionModel: "bounded-recursive-smart-object-payload-replacement-v1" });
		expect(refreshed).toBe(1);
		const outerOutput = await readFile(join(directory, applied.destinationPath));
		const innerOutput = Buffer.from(decodePsdSmartObjectResources(outerOutput)[0].data);
		const leafOutput = Buffer.from(decodePsdSmartObjectResources(innerOutput)[0].data);
		expect(Buffer.from(decodePsdSmartObjectResources(leafOutput)[0].data)).toEqual(replacement);
		expect(await getPsdSmartObjectPayloadReplacementStatus(source, options)).toMatchObject({ action: "reuse", outputHash: applied.outputHash });
		scene.dispose();
		engine.dispose();
	});

	test("blocks ambiguous linked-resource ID selection and payload conflicts before publishing any output", async () => {
		const first = linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "one.bin", data: Buffer.from([1]) });
		const second = linkedResourceRecord({ type: "liFD", id: "codex-smart-resource", name: "two.bin", data: Buffer.from([2]) });
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Ambiguous",
						id: 4711,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255],
						additionalInfo: [additional("SoLd", smartObjectLayer())],
					}),
				],
				{ width: 1, height: 1 },
				globalAdditional("lnk2", Buffer.concat([first, second]))
			)
		);
		const inventory = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/ambiguous-output" });
		expect(inventory.document.layers[0].smartObject?.linkedResource).toEqual({ status: "ambiguous", resourceIndices: [0, 1] });
		await expect(
			getPsdLayerExtractionStatus(source, {
				destinationFolder: "assets/ambiguous-output",
				extractSmartObjectPayloads: true,
				smartObjectResourceIds: ["codex-smart-resource"],
			})
		).rejects.toThrow("ambiguous across records 0, 1");

		const conflictSource = join(directory, "assets/payload-conflict.psd");
		await writeFile(
			conflictSource,
			createLayeredPsd(undefined, undefined, globalAdditional("lnk2", linkedResourceRecord({ type: "liFD", id: "payload", name: "asset.bin", data: Buffer.from([5, 6]) })))
		);
		const conflictPath = join(directory, "assets/payload-conflict-output/smart-objects/0001-asset.bin");
		await mkdir(dirname(conflictPath), { recursive: true });
		await writeFile(conflictPath, Buffer.from([9]));
		const conflicted = await getPsdLayerExtractionStatus(conflictSource, {
			destinationFolder: "assets/payload-conflict-output",
			extractSmartObjectPayloads: true,
		});
		expect(conflicted.smartObjectPayloadConflictCount).toBe(1);
		await expect(
			applyPsdLayerExtraction(conflictSource, { destinationFolder: "assets/payload-conflict-output", extractSmartObjectPayloads: true }, conflicted.fingerprint)
		).rejects.toThrow("never overwritten");
		expect(await pathExists(join(directory, conflicted.items[0].path))).toBe(false);
		expect([...(await readFile(conflictPath))]).toEqual([9]);
	});

	test("rerasterizes edited TySh text with one exact project font and no fallback", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Editable HUD",
						id: 949,
						left: 10,
						top: 20,
						width: 96,
						height: 48,
						visible: true,
						opacity: 255,
						rgba: Array.from({ length: 96 * 48 }, () => [200, 10, 10, 255]).flat(),
						mask: { top: 20, left: 10, width: 96, height: 48, plane: Array.from({ length: 96 * 48 }, (_value, index) => (index % 96 < 48 ? 255 : 0)) },
						additionalInfo: [additional("TySh", tyshText("Old"))],
					}),
				],
				{ width: 120, height: 80 }
			)
		);
		const options = {
			destinationFolder: "assets/edited-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					text: "NEW",
					fontPath: "assets/Geist-Regular.ttf",
					fontSize: 24,
					lineHeight: 30,
					tracking: 100,
					justification: "center" as const,
					offsetX: 1,
					offsetY: 2,
					color: [20, 220, 80, 200] as [number, number, number, number],
				},
			],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const bridgePlan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		expect(bridgePlan.items[0].appliedTextRenders[0]).toMatchObject({ text: "NEW", fontPath: "assets/Geist-Regular.ttf" });
		scene.dispose();
		engine.dispose();
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.requestedTextRenders).toEqual([
			{ ...options.textRenders[0], useAuthoredStyleRuns: false, styleRunFontBindings: [], applyAuthoredWarp: false, applyAuthoredBoxLayout: false },
		]);
		expect(plan.items[0].textLayer?.rasterExecutionModel).toBe("bounded-project-font-text-raster-v1");
		expect(plan.items[0].appliedTextRenders).toMatchObject([
			{
				layerIndex: 0,
				text: "NEW",
				fontPath: "assets/Geist-Regular.ttf",
				fontHash: "bde046ddd9f20be35b0bd56cc79eb752b967fb6661a3fe76cb067bb09f871d76",
				fontBytes: 125956,
				fontSize: 24,
				lineHeight: 30,
				tracking: 100,
				justification: "center",
				offsetX: 1,
				offsetY: 2,
				color: [20, 220, 80, 200],
				maskExecutionModel: "bounded-layer-mask-v1",
				maskCoverageMinimum: 0,
				maskCoverageMaximum: 255,
				fontFallback: "none",
				styleSynthesis: "none",
				executionModel: "bounded-project-font-text-raster-v1",
			},
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		const alpha = [...pixels].filter((_value, index) => index % 4 === 3);
		expect(Math.max(...alpha)).toBeLessThanOrEqual(200);
		expect(alpha.some((value) => value > 0)).toBe(true);
		expect(alpha.some((value) => value === 0)).toBe(true);
		for (let offset = 0; offset < pixels.length; offset += 4) {
			if (pixels[offset + 3]) expect([...pixels.subarray(offset, offset + 3)]).toEqual([20, 220, 80]);
		}
		expect(createHash("sha256").update(pixels).digest("hex")).toBe("43482d0e3d3e28d04c5c02aad40c8e0dfda7347156483840ac821f234f73226d");
		const emptyOptions = { ...options, destinationFolder: "assets/empty-text-layers", textRenders: [{ ...options.textRenders[0], text: "" }] };
		const emptyPlan = await getPsdLayerExtractionStatus(source, emptyOptions);
		expect(emptyPlan.items[0].appliedTextRenders[0]).toMatchObject({ text: "", glyphCount: 0, uniqueGlyphCount: 0, inkBounds: null });
		const emptyApplied = await applyPsdLayerExtraction(source, emptyOptions, emptyPlan.fingerprint);
		const emptyPixels = await sharp(join(directory, emptyApplied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(emptyPixels.every((value) => value === 0)).toBe(true);
	});

	test("rerasterizes exact authored TySh style runs with per-FontSet project bindings", async () => {
		const primaryFont = join(directory, "assets", "Geist-Primary.ttf");
		const alternateFont = join(directory, "assets", "Geist-Alternate.ttf");
		const sourceFont = join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf");
		await copyFile(sourceFont, primaryFont);
		await copyFile(sourceFont, alternateFont);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Styled HUD",
						id: 4812,
						left: 4,
						top: 6,
						width: 160,
						height: 64,
						visible: true,
						opacity: 255,
						rgba: new Array(160 * 64 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("REDblue", {
									fonts: ["Geist Primary", "Geist Alternate"],
									includeEngineTerminator: true,
									styles: [
										{ length: 3, fontIndex: 0, fontSize: 20, fauxBold: false, fauxItalic: false, tracking: 0, color: [240, 30, 20, 255] },
										{ length: 5, fontIndex: 1, fontSize: 30, fauxBold: true, fauxItalic: true, tracking: 80, color: [20, 80, 240, 220] },
									],
								})
							),
						],
					}),
				],
				{ width: 180, height: 80 }
			)
		);
		const options = {
			destinationFolder: "assets/styled-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Geist-Primary.ttf",
					useAuthoredStyleRuns: true,
					styleRunFontBindings: [{ fontIndex: 1, fontPath: "assets/Geist-Alternate.ttf" }],
					justification: "left" as const,
					offsetX: 2,
					offsetY: 1,
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text).toMatchObject({ styleRunTerminatorNormalized: true, paragraphRunTerminatorNormalized: true });
		expect(plan.items[0].textLayer?.rasterExecutionModel).toBe("bounded-project-font-text-style-runs-v1");
		expect(plan.items[0].appliedTextRenders[0]).toMatchObject({
			text: "REDblue",
			styleSynthesis: "authored-faux-bold-italic-v1",
			fontFallback: "none",
			executionModel: "bounded-project-font-text-style-runs-v1",
			styleRuns: [
				{
					sourceStyleRunIndex: 0,
					start: 0,
					length: 3,
					fontIndex: 0,
					fontName: "Geist Primary",
					fontPath: "assets/Geist-Primary.ttf",
					fontSize: 20,
					tracking: 0,
					color: [240, 30, 20, 255],
					fauxBold: false,
					fauxItalic: false,
					fauxBoldPixels: 0,
					fauxItalicShear: 0,
				},
				{
					sourceStyleRunIndex: 1,
					start: 3,
					length: 4,
					fontIndex: 1,
					fontName: "Geist Alternate",
					fontPath: "assets/Geist-Alternate.ttf",
					fontSize: 30,
					tracking: 80,
					color: [20, 80, 240, 220],
					fauxBold: true,
					fauxItalic: true,
					fauxBoldPixels: 1,
					fauxItalicShear: expect.closeTo(Math.tan((12 * Math.PI) / 180), 12),
				},
			],
		});
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect(
			Array.from({ length: pixels.length / 4 }, (_, index) => [...pixels.subarray(index * 4, index * 4 + 3)]).some(
				(color) => color[0] === 240 && color[1] === 30 && color[2] === 20
			)
		).toBe(true);
		expect(
			Array.from({ length: pixels.length / 4 }, (_, index) => [...pixels.subarray(index * 4, index * 4 + 3)]).some(
				(color) => color[0] === 20 && color[1] === 80 && color[2] === 240
			)
		).toBe(true);
		const reused = await getPsdLayerExtractionStatus(source, options);
		expect(reused).toMatchObject({ createdCount: 0, reusedCount: 1 });
		await expect(applyPsdLayerExtraction(source, { ...options, textRenders: [{ ...options.textRenders[0], offsetX: 3 }] }, plan.fingerprint)).rejects.toThrow("plan changed");
		await expect(getPsdLayerExtractionStatus(source, { ...options, textRenders: [{ ...options.textRenders[0], text: "changed" }] })).rejects.toThrow(
			"require omitting replacement text"
		);
	});

	test("rerasterizes Arabic TySh text through exact HarfBuzz glyph IDs and leases shaping controls", async () => {
		const fontPath = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Arabic HUD",
						id: 4830,
						left: 2,
						top: 3,
						width: 180,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(180 * 80 * 4).fill(0),
						additionalInfo: [additional("TySh", tyshText("سلام"))],
					}),
				],
				{ width: 190, height: 90 }
			)
		);
		const options = {
			destinationFolder: "assets/arabic-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Amiri-Regular.ttf",
					fontSize: 48,
					color: [245, 220, 60, 255] as [number, number, number, number],
					shaping: { direction: "rtl" as const, script: "Arab", language: "ar", features: [{ tag: "rlig", value: 1 }] },
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.requestedTextRenders[0]).toMatchObject(options.textRenders[0]);
		expect(plan.items[0].textLayer?.rasterExecutionModel).toBe("bounded-project-font-harfbuzz-text-raster-v1");
		expect(plan.items[0].appliedTextRenders[0]).toMatchObject({
			text: "سلام",
			fontPath: "assets/Amiri-Regular.ttf",
			executionModel: "bounded-project-font-harfbuzz-text-raster-v1",
			glyphCount: 4,
			uniqueGlyphCount: 4,
			fontFallback: "none",
			styleSynthesis: "none",
			shaping: {
				engine: "harfbuzz",
				version: "14.2.1",
				direction: "rtl",
				script: "Arab",
				language: "ar",
				features: [{ tag: "rlig", value: 1 }],
			},
		});
		expect(plan.items[0].appliedTextRenders[0].shapedGlyphs.map((glyph) => glyph.cluster)).toEqual([3, 2, 1, 0]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			applyPsdLayerExtraction(
				source,
				{ ...options, textRenders: [{ ...options.textRenders[0], shaping: { ...options.textRenders[0].shaping, features: [{ tag: "rlig", value: 0 }] } }] },
				plan.fingerprint
			)
		).rejects.toThrow("plan changed");
	});

	test("rerasterizes Arabic TySh joining across authored matching-font style runs", async () => {
		const fontPath = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Cross-style Arabic HUD",
						id: 4850,
						left: 2,
						top: 3,
						width: 180,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(180 * 80 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("سلام", {
									fonts: ["Amiri Regular"],
									includeEngineTerminator: true,
									styles: [
										{ length: 2, fontIndex: 0, fontSize: 48, fauxBold: false, fauxItalic: false, tracking: 0, color: [240, 40, 30, 255] },
										{ length: 3, fontIndex: 0, fontSize: 48, fauxBold: false, fauxItalic: false, tracking: 0, color: [30, 100, 240, 255] },
									],
								})
							),
						],
					}),
				],
				{ width: 190, height: 90 }
			)
		);
		const options = {
			destinationFolder: "assets/cross-style-arabic-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Amiri-Regular.ttf",
					useAuthoredStyleRuns: true,
					shaping: { direction: "rtl" as const, script: "Arab", language: "ar", joinAcrossStyleRuns: true },
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(plan.items[0].textLayer?.rasterExecutionModel).toBe("bounded-project-font-harfbuzz-cross-style-runs-v1");
		expect(evidence).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-cross-style-runs-v1",
			shaping: { styleBoundaryModel: "shared-font-cross-style-clusters-v1" },
			styleRuns: [{ glyphCount: 2 }, { glyphCount: 2 }],
		});
		expect([...evidence.shapedGlyphs].sort((left, right) => left.cluster - right.cluster).map((glyph) => glyph.glyphId)).toEqual([1919, 3075, 3080, 85]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		const colors = Array.from({ length: pixels.length / 4 }, (_, index) => [...pixels.subarray(index * 4, index * 4 + 4)]).filter((color) => color[3] > 0);
		expect(colors.some((color) => color[0] === 240 && color[1] === 40 && color[2] === 30)).toBe(true);
		expect(colors.some((color) => color[0] === 30 && color[1] === 100 && color[2] === 240)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			applyPsdLayerExtraction(
				source,
				{ ...options, textRenders: [{ ...options.textRenders[0], shaping: { ...options.textRenders[0].shaping, joinAcrossStyleRuns: false } }] },
				plan.fingerprint
			)
		).rejects.toThrow("plan changed");
	});

	test("executes an authored standard TySh warp after project-font rasterization", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Warped HUD",
						id: 4860,
						left: 4,
						top: 6,
						width: 180,
						height: 72,
						visible: true,
						opacity: 255,
						rgba: new Array(180 * 72 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("WARP", {
									fonts: ["Geist Regular"],
									styles: [{ length: 4, fontIndex: 0, fontSize: 42, fauxBold: false, fauxItalic: false, tracking: 0, color: [245, 80, 30, 255] }],
									warp: { style: "warpWave", value: 65, perspective: 20, perspectiveOther: -15, rotate: "Vrtc" },
								})
							),
						],
					}),
				],
				{ width: 200, height: 90 }
			)
		);
		const baseRequest = { layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", fontSize: 42, offsetX: 4, offsetY: 2 };
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [baseRequest] })).rejects.toThrow("set applyAuthoredWarp=true");
		const options = { destinationFolder: "assets/warped-text-layers", textRenders: [{ ...baseRequest, applyAuthoredWarp: true }] };
		const plan = await getPsdLayerExtractionStatus(source, options);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(evidence.authoredWarp).toMatchObject({
			style: "warpWave",
			value: 65,
			perspective: 20,
			perspectiveOther: -15,
			rotate: "vertical",
			tessellation: 64,
			executionModel: "bounded-analytical-preset-text-warp-v1",
		});
		expect(evidence.authoredWarp!.width * evidence.authoredWarp!.height).toBeGreaterThan(0);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect(decoded.info.width).toBe(evidence.authoredWarp!.width);
		expect(decoded.info.height).toBe(evidence.authoredWarp!.height);
		expect([...decoded.data].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, textRenders: [{ ...options.textRenders[0], applyAuthoredWarp: false }] }, plan.fingerprint)).rejects.toThrow(
			"set applyAuthoredWarp=true"
		);
	});

	test("executes an authored tensor-product TySh custom envelope after glyph rasterization", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const customMesh = Array.from({ length: 16 }, (_, index) => {
			const column = index % 4;
			const row = Math.floor(index / 4);
			return { x: column * 60 + (row === 1 ? -6 : row === 2 ? 7 : 0), y: row * 24 + (column === 1 ? -8 : column === 2 ? 9 : 0) };
		});
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Tensor Envelope Text",
						id: 4880,
						left: 4,
						top: 6,
						width: 180,
						height: 72,
						visible: true,
						opacity: 255,
						rgba: new Array(180 * 72 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("MESH", {
									fonts: ["Geist Regular"],
									styles: [{ length: 4, fontIndex: 0, fontSize: 42, fauxBold: false, fauxItalic: false, tracking: 0, color: [245, 80, 30, 255] }],
									warp: { style: "warpCustom", value: 0, perspective: 0, perspectiveOther: 0, rotate: "Hrzn", customMesh, uOrder: 4, vOrder: 4 },
								})
							),
						],
					}),
				],
				{ width: 200, height: 90 }
			)
		);
		const baseRequest = { layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", fontSize: 42, offsetX: 4, offsetY: 2 };
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [baseRequest] })).rejects.toThrow("applyAuthoredWarp=true");
		const options = { destinationFolder: "assets/tensor-text-layers", textRenders: [{ ...baseRequest, applyAuthoredWarp: true }] };
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.warp).toMatchObject({
			style: "warpCustom",
			uOrder: 4,
			vOrder: 4,
			meshExecutionModel: "tensor",
			meshExecutionSupported: true,
			meshPoints: customMesh,
		});
		const evidence = plan.items[0].appliedTextRenders[0].authoredWarp;
		expect(evidence).toMatchObject({
			type: "tensor",
			style: "warpCustom",
			uOrder: 4,
			vOrder: 4,
			meshPointCount: 16,
			tessellation: 32,
			executionModel: "bounded-bezier-text-warp-v1",
		});
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect([decoded.info.width, decoded.info.height]).toEqual([evidence!.width, evidence!.height]);
		expect([...decoded.data].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
	});

	test("executes an authored piecewise-Bezier TySh quilt envelope with exact slices", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const customMesh = Array.from({ length: 49 }, (_, index) => {
			const column = index % 7;
			const row = Math.floor(index / 7);
			return { x: column * 30 + (row === 2 || row === 4 ? 4 : 0), y: row * 12 + (column === 2 ? -5 : column === 4 ? 6 : 0) };
		});
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Quilt Envelope Text",
						id: 4881,
						left: 4,
						top: 6,
						width: 180,
						height: 72,
						visible: true,
						opacity: 255,
						rgba: new Array(180 * 72 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("QUILT", {
									fonts: ["Geist Regular"],
									styles: [{ length: 5, fontIndex: 0, fontSize: 38, fauxBold: false, fauxItalic: false, tracking: 0, color: [30, 160, 245, 255] }],
									warp: {
										style: "quiltWarp",
										value: 0,
										perspective: 0,
										perspectiveOther: 0,
										rotate: "Hrzn",
										customMesh,
										uOrder: 4,
										vOrder: 4,
										deformNumRows: 2,
										deformNumCols: 2,
										quiltSliceX: [0, 90, 180],
										quiltSliceY: [0, 36, 72],
									},
								})
							),
						],
					}),
				],
				{ width: 200, height: 90 }
			)
		);
		const options = {
			destinationFolder: "assets/quilt-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", fontSize: 38, offsetX: 3, offsetY: 2, applyAuthoredWarp: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.warp).toMatchObject({
			meshExecutionModel: "quilt",
			deformNumRows: 2,
			deformNumCols: 2,
			quiltSliceX: [0, 90, 180],
			quiltSliceY: [0, 36, 72],
		});
		const evidence = plan.items[0].appliedTextRenders[0].authoredWarp;
		expect(evidence).toMatchObject({
			type: "quilt",
			style: "quiltWarp",
			uOrder: 4,
			vOrder: 4,
			deformNumRows: 2,
			deformNumCols: 2,
			meshPointCount: 49,
			quiltSliceX: [0, 90, 180],
			quiltSliceY: [0, 36, 72],
			tessellation: 28,
			executionModel: "bounded-piecewise-bezier-text-quilt-warp-v1",
		});
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
	});

	test("executes exact authored TySh character scale, baseline shift, underline, and strikethrough", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Styled Metrics",
						id: 4890,
						left: 0,
						top: 0,
						width: 240,
						height: 90,
						visible: true,
						opacity: 255,
						rgba: new Array(240 * 90 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("STYLE", {
									fonts: ["Geist Regular"],
									styles: [
										{
											length: 5,
											fontIndex: 0,
											fontSize: 32,
											fauxBold: false,
											fauxItalic: false,
											tracking: 20,
											horizontalScale: 1.4,
											verticalScale: 0.75,
											baselineShift: 6,
											underline: true,
											strikethrough: true,
											color: [230, 70, 40, 255],
										},
									],
									paragraph: {
										justification: 6,
										firstLineIndent: 3,
										startIndent: 4,
										endIndent: 5,
										spaceBefore: 2,
										spaceAfter: 6,
										autoHyphenate: true,
										autoLeading: 1.2,
										everyLineComposer: true,
									},
								})
							),
						],
					}),
				],
				{ width: 240, height: 90 }
			)
		);
		const options = {
			destinationFolder: "assets/styled-metrics-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true, shaping: { direction: "ltr" as const } }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns[0]).toMatchObject({
			horizontalScale: 140,
			verticalScale: 75,
			baselineShift: 6,
			underline: true,
			strikethrough: true,
		});
		expect(plan.document.layers[0].text?.paragraphRuns[0]).toMatchObject({
			length: 5,
			justification: "justify-all",
			firstLineIndent: 3,
			startIndent: 4,
			endIndent: 5,
			spaceBefore: 2,
			spaceAfter: 6,
			autoHyphenate: true,
			autoLeading: 1.2,
			everyLineComposer: true,
		});
		expect(plan.items[0].appliedTextRenders[0].styleRuns[0]).toMatchObject({
			horizontalScale: 140,
			verticalScale: 75,
			baselineShift: 6,
			underline: true,
			strikethrough: true,
			decorationThickness: 1,
			characterStyleExecutionModel: "bounded-authored-character-style-v1",
		});
		expect(plan.items[0].appliedTextRenders[0].paragraphRuns).toMatchObject([
			{
				sourceParagraphRunIndex: 0,
				start: 0,
				length: 5,
				justification: "justify-all",
				firstLineIndent: 3,
				startIndent: 4,
				endIndent: 5,
				spaceBefore: 2,
				spaceAfter: 6,
				autoHyphenate: true,
				autoLeading: 1.2,
				everyLineComposer: true,
				lineIndices: [0],
				lineCount: 1,
				appliedLineHeight: 38.4,
				lineHeightSource: "authored-auto-leading",
				lineBreakModel: "authored-paragraph-breaks-v1",
				executionModel: "bounded-authored-paragraph-run-layout-v1",
			},
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
	});

	test("executes exact authored TySh box geometry through bounded whitespace wrapping", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "ONE TWO THREE FOUR";
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Box Paragraph",
						id: 4910,
						left: 0,
						top: 0,
						width: 140,
						height: 150,
						visible: true,
						opacity: 255,
						rgba: new Array(140 * 150 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									styles: [
										{
											length: text.length,
											fontIndex: 0,
											fontSize: 24,
											fauxBold: false,
											fauxItalic: false,
											tracking: 0,
											color: [230, 120, 40, 255],
										},
									],
									paragraph: {
										justification: 3,
										firstLineIndent: 3,
										startIndent: 4,
										endIndent: 5,
										spaceBefore: 2,
										spaceAfter: 3,
										autoHyphenate: false,
										autoLeading: 1.2,
										everyLineComposer: false,
									},
									shape: { type: "box", boxBounds: [6, 7, 106, 135] },
								})
							),
						],
					}),
				],
				{ width: 140, height: 150 }
			)
		);
		const options = {
			destinationFolder: "assets/box-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true, applyAuthoredBoxLayout: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text).toMatchObject({ shapeType: "box", pointBase: null, boxBounds: [6, 7, 106, 135] });
		await expect(
			getPsdLayerExtractionStatus(source, {
				...options,
				textRenders: [{ ...options.textRenders[0], applyAuthoredBoxLayout: "yes" as unknown as boolean }],
			})
		).rejects.toThrow("applyAuthoredBoxLayout must be a Boolean");
		expect(plan.items[0].appliedTextRenders[0]).toMatchObject({
			lineCount: 4,
			boxLayout: {
				left: 6,
				top: 7,
				right: 106,
				bottom: 135,
				authoredLineCount: 1,
				composedLineCount: 4,
				softBreakCount: 3,
				overflowLineCount: 0,
				wrapModel: "bounded-whitespace-cluster-wrap-v1",
				executionModel: "bounded-authored-box-text-layout-v1",
			},
			paragraphRuns: [{ lineIndices: [0, 1, 2, 3], lineCount: 4, lineBreakModel: "bounded-authored-box-wrap-v1" }],
		});
		const shapedPlan = await getPsdLayerExtractionStatus(source, {
			...options,
			textRenders: [{ ...options.textRenders[0], shaping: { direction: "ltr" as const, bidirectional: true } }],
		});
		expect(shapedPlan.items[0].appliedTextRenders[0]).toMatchObject({
			lineCount: 4,
			boxLayout: { composedLineCount: 4, softBreakCount: 3, overflowLineCount: 0, executionModel: "bounded-authored-box-text-layout-v1" },
		});
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
	});

	test("executes authored dictionary hyphenation and every-line composition through exact PSD extraction", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "characteristically extraordinary localization";
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Hyphenated Paragraph",
						id: 4920,
						left: 0,
						top: 0,
						width: 170,
						height: 250,
						visible: true,
						opacity: 255,
						rgba: new Array(170 * 250 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									styles: [
										{
											length: text.length,
											fontIndex: 0,
											language: 1,
											fontSize: 24,
											fauxBold: false,
											fauxItalic: false,
											tracking: 0,
											color: [230, 120, 40, 255],
										},
									],
									paragraph: {
										justification: 0,
										autoHyphenate: true,
										hyphenatedWordSize: 5,
										preHyphen: 2,
										postHyphen: 2,
										consecutiveHyphens: 3,
										hyphenationZone: 0,
										autoLeading: 1.2,
										everyLineComposer: true,
									},
									shape: { type: "box", boxBounds: [4, 4, 154, 244] },
								})
							),
						],
					}),
				],
				{ width: 170, height: 250 }
			)
		);
		const options = {
			destinationFolder: "assets/hyphenated-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Geist-Regular.ttf",
					useAuthoredStyleRuns: true,
					applyAuthoredBoxLayout: true,
					shaping: { direction: "ltr" as const, bidirectional: true },
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text).toMatchObject({
			shapeType: "box",
			styleRuns: [{ language: 1 }],
			paragraphRuns: [
				{
					autoHyphenate: true,
					hyphenatedWordSize: 5,
					preHyphen: 2,
					postHyphen: 2,
					consecutiveHyphens: 3,
					hyphenationZone: 0,
					everyLineComposer: true,
				},
			],
		});
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(evidence.boxLayout).toMatchObject({
			wrapModel: "bounded-dictionary-hyphenation-wrap-v1",
			composerModel: "bounded-every-line-composer-v1",
			hyphenationLanguages: ["en-US"],
			overflowLineCount: 0,
		});
		expect(evidence.boxLayout!.insertedHyphenCount).toBeGreaterThan(0);
		expect(evidence.paragraphRuns[0]).toMatchObject({
			lineBreakModel: "bounded-authored-box-hyphenation-v1",
			hyphenationExecutionModel: "bounded-liang-pattern-hyphenation-v1",
			composerExecutionModel: "bounded-every-line-composer-v1",
		});
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
	});

	test("executes authored Photoshop Language localized forms through inspect and extract MCP", async () => {
		const fontPath = join(directory, "assets", "Geist-Locl-Test.ttf");
		await writeFile(fontPath, Buffer.from((await readFile(localizedFormsFixture, "utf-8")).trim(), "base64"));
		const localizedPsd = (secondLanguage: number): Buffer =>
			createLayeredPsd(
				[
					layer({
						name: "Localized Forms",
						id: 5070,
						left: 0,
						top: 0,
						width: 140,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(140 * 80 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("AA", {
									fonts: ["Geist Locl Test"],
									styles: [
										{
											length: 1,
											fontIndex: 0,
											language: 0,
											fontSize: 48,
											fauxBold: false,
											fauxItalic: false,
											tracking: 0,
											color: [230, 60, 40, 255],
										},
										{
											length: 1,
											fontIndex: 0,
											language: secondLanguage,
											fontSize: 48,
											fauxBold: false,
											fauxItalic: false,
											tracking: 0,
											color: [40, 100, 230, 255],
										},
									],
								})
							),
						],
					}),
				],
				{ width: 140, height: 80 }
			);
		await writeFile(source, localizedPsd(6));
		const options = {
			destinationFolder: "assets/localized-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Geist-Locl-Test.ttf",
					useAuthoredStyleRuns: true,
					shaping: { direction: "ltr" as const, script: "Latn", language: "en", joinAcrossStyleRuns: true },
				},
			],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const inspected = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		expect(inspected.layers[0].text?.styleRuns.map((run) => run.language)).toEqual([0, 6]);
		const evidence = inspected.items[0].appliedTextRenders[0];
		expect(evidence.shaping).toMatchObject({ language: "en", styleBoundaryModel: "shared-font-cross-style-clusters-v1" });
		expect(evidence.styleRuns).toMatchObject([
			{
				photoshopLanguageIndex: 0,
				photoshopLanguage: "en-US",
				effectiveShapingLanguage: "en-US",
				languageSource: "authored",
				languageExecutionModel: "bounded-authored-photoshop-language-v1",
			},
			{
				photoshopLanguageIndex: 6,
				photoshopLanguage: "de-DE-1996",
				effectiveShapingLanguage: "de-DE-1996",
				languageSource: "authored",
				languageExecutionModel: "bounded-authored-photoshop-language-v1",
			},
		]);
		expect(evidence.shapedGlyphs).toHaveLength(2);
		expect(evidence.shapedGlyphs[0].glyphId).not.toBe(evidence.shapedGlyphs[1].glyphId);
		const extracted = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: inspected.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const decoded = await sharp(join(directory, extracted.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await writeFile(source, localizedPsd(999));
		await expect(getPsdLayerExtractionStatus(source, options)).rejects.toThrow("PSD authored language does not support Photoshop language index 999.");
		scene.dispose();
		engine.dispose();
	});

	test("executes authored TySh fill and stroke paint through inspect and extract MCP", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Fill Stroke Text",
						id: 5080,
						left: 0,
						top: 0,
						width: 240,
						height: 100,
						visible: true,
						opacity: 255,
						rgba: new Array(240 * 100 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("OOO", {
									fonts: ["Geist Regular"],
									styles: [
										{
											length: 1,
											fontIndex: 0,
											fontSize: 64,
											fauxBold: false,
											fauxItalic: false,
											tracking: 0,
											color: [240, 30, 20, 255],
											strokeColor: [20, 80, 240, 255],
											fillEnabled: true,
											strokeEnabled: false,
											fillFirst: true,
											outlineWidth: 8,
										},
										{
											length: 1,
											fontIndex: 0,
											fontSize: 64,
											fauxBold: false,
											fauxItalic: false,
											tracking: 0,
											color: [240, 30, 20, 255],
											strokeColor: [20, 80, 240, 255],
											fillEnabled: false,
											strokeEnabled: true,
											fillFirst: true,
											outlineWidth: 8,
										},
										{
											length: 1,
											fontIndex: 0,
											fontSize: 64,
											fauxBold: false,
											fauxItalic: false,
											tracking: 0,
											color: [30, 220, 70, 255],
											strokeColor: [220, 30, 210, 255],
											fillEnabled: true,
											strokeEnabled: true,
											fillFirst: false,
											outlineWidth: 6,
										},
									],
								})
							),
						],
					}),
				],
				{ width: 240, height: 100 }
			)
		);
		const options = {
			destinationFolder: "assets/fill-stroke-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const inspected = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		expect(inspected.layers[0].text?.styleRuns).toMatchObject([
			{ fillEnabled: true, strokeEnabled: false, fillFirst: true, outlineWidth: 8, strokeColor: [20, 80, 240, 255] },
			{ fillEnabled: false, strokeEnabled: true, fillFirst: true, outlineWidth: 8, strokeColor: [20, 80, 240, 255] },
			{ fillEnabled: true, strokeEnabled: true, fillFirst: false, outlineWidth: 6, strokeColor: [220, 30, 210, 255] },
		]);
		const renderedRuns = inspected.items[0].appliedTextRenders[0].styleRuns;
		expect(renderedRuns).toMatchObject([
			{ fillPixelCount: expect.any(Number), strokePixelCount: 0, textPaintExecutionModel: "bounded-authored-text-fill-stroke-v1", strokeRasterModel: "disabled" },
			{ fillPixelCount: 0, strokePixelCount: expect.any(Number), strokeRasterModel: "bounded-msdf-centered-outline-v1" },
			{ fillFirst: false, textPaintExecutionModel: "bounded-authored-text-fill-stroke-v1", strokeRasterModel: "bounded-msdf-centered-outline-v1" },
		]);
		expect(renderedRuns[0].fillPixelCount).toBeGreaterThan(0);
		expect(renderedRuns[1].strokePixelCount).toBeGreaterThan(0);
		expect(renderedRuns[2].fillPixelCount).toBeGreaterThan(0);
		expect(renderedRuns[2].strokePixelCount).toBeGreaterThan(0);
		const extracted = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: inspected.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const decoded = await sharp(join(directory, extracted.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 2 && value > 180)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: "0".repeat(64), confirm: true }, {
				editor: { layout: { assets: { refresh: () => undefined } } },
			} as never)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();
	});

	test("executes authored no-break style spans through exact PSD extraction", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "ONE TWO THREE";
		const style = {
			fontIndex: 0,
			fontSize: 24,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [230, 120, 40, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "No-Break Paragraph",
						id: 4930,
						left: 0,
						top: 0,
						width: 180,
						height: 180,
						visible: true,
						opacity: 255,
						rgba: new Array(180 * 180 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									styles: [
										{ ...style, length: 7, noBreak: true },
										{ ...style, length: 6, noBreak: false },
									],
									paragraph: { justification: 0, autoHyphenate: false, autoLeading: 1.2, everyLineComposer: false },
									shape: { type: "box", boxBounds: [4, 4, 84, 164] },
								})
							),
						],
					}),
				],
				{ width: 180, height: 180 }
			)
		);
		const options = {
			destinationFolder: "assets/no-break-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Geist-Regular.ttf",
					useAuthoredStyleRuns: true,
					applyAuthoredBoxLayout: true,
					shaping: { direction: "ltr" as const, bidirectional: true },
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toEqual([expect.objectContaining({ length: 7, noBreak: true }), expect.objectContaining({ length: 6, noBreak: false })]);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(evidence.styleRuns).toEqual([
			expect.objectContaining({ noBreak: true, noBreakExecutionModel: "bounded-authored-no-break-v1" }),
			expect.objectContaining({ noBreak: false, noBreakExecutionModel: "disabled" }),
		]);
		expect(evidence.boxLayout).toMatchObject({
			composedLineCount: 2,
			noBreakRunCount: 1,
			noBreakExecutionModel: "bounded-authored-no-break-v1",
			lines: [expect.objectContaining({ logicalStart: 0, logicalEnd: 7, overflow: true }), expect.any(Object)],
		});
		expect(evidence.boxLayout!.noBreakPreventedBreakCount).toBeGreaterThan(0);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
	});

	test("executes authored OpenType auto-kerning and ligature switches through exact PSD extraction", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "fi fi";
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [230, 120, 40, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored OpenType",
						id: 4940,
						left: 0,
						top: 0,
						width: 220,
						height: 100,
						visible: true,
						opacity: 255,
						rgba: new Array(220 * 100 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									styles: [
										{ ...style, length: 2, autoKerning: true, ligatures: true, discretionaryLigatures: false },
										{ ...style, length: 3, autoKerning: false, ligatures: false, discretionaryLigatures: true },
									],
								})
							),
						],
					}),
				],
				{ width: 220, height: 100 }
			)
		);
		const authoredBytes = (await readFile(source)).toString("latin1");
		expect(authoredBytes).toContain("/AutoKerning true");
		expect(authoredBytes).toContain("/Ligatures false");
		expect(authoredBytes).toContain("/DLigatures true");
		const options = {
			destinationFolder: "assets/opentype-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toEqual([
			expect.objectContaining({ autoKerning: true, ligatures: true, discretionaryLigatures: false }),
			expect.objectContaining({ autoKerning: false, ligatures: false, discretionaryLigatures: true }),
		]);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(evidence).toMatchObject({ executionModel: "bounded-project-font-harfbuzz-style-runs-v1", shaping: { engine: "harfbuzz" } });
		expect(evidence.styleRuns).toEqual([
			expect.objectContaining({
				autoKerning: true,
				ligatures: true,
				discretionaryLigatures: false,
				effectiveOpenTypeFeatures: [
					{ tag: "kern", value: 1 },
					{ tag: "liga", value: 1 },
					{ tag: "dlig", value: 0 },
				],
				openTypeFeatureExecutionModel: "bounded-authored-opentype-features-v1",
				glyphCount: 1,
			}),
			expect.objectContaining({
				autoKerning: false,
				ligatures: false,
				discretionaryLigatures: true,
				effectiveOpenTypeFeatures: [
					{ tag: "kern", value: 0 },
					{ tag: "liga", value: 0 },
					{ tag: "dlig", value: 1 },
				],
				openTypeFeatureExecutionModel: "bounded-authored-opentype-features-v1",
				glyphCount: 2,
				shapedGlyphs: expect.arrayContaining([expect.objectContaining({ cluster: 2 }), expect.objectContaining({ cluster: 3 }), expect.objectContaining({ cluster: 4 })]),
			}),
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/opentype-text-layers-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("executes authored pair-specific manual kerning through exact PSD extraction", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "AVA";
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			autoKerning: false,
			ligatures: true,
			color: [230, 120, 40, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Manual Kerning",
						id: 4950,
						left: 0,
						top: 0,
						width: 220,
						height: 100,
						visible: true,
						opacity: 255,
						rgba: new Array(220 * 100 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									styles: [
										{ ...style, length: 1, kerning: 0 },
										{ ...style, length: 1, kerning: 250 },
										{ ...style, length: 1, kerning: -125 },
									],
								})
							),
						],
					}),
				],
				{ width: 220, height: 100 }
			)
		);
		const authoredBytes = (await readFile(source)).toString("latin1");
		expect(authoredBytes).toContain("/Kerning 250");
		expect(authoredBytes).toContain("/Kerning -125");
		const options = {
			destinationFolder: "assets/manual-kerning-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Geist-Regular.ttf",
					useAuthoredStyleRuns: true,
					shaping: { direction: "ltr" as const, joinAcrossStyleRuns: true },
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toEqual([
			expect.objectContaining({ length: 1, kerning: 0 }),
			expect.objectContaining({ length: 1, kerning: 250 }),
			expect.objectContaining({ length: 1, kerning: -125 }),
		]);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(evidence.styleRuns).toEqual([
			expect.objectContaining({ kerning: 0, manualKerningBoundaryUtf16: null, manualKerningPixels: 0, manualKerningExecutionModel: "disabled" }),
			expect.objectContaining({
				kerning: 250,
				manualKerningBoundaryUtf16: 1,
				manualKerningPixels: 12,
				manualKerningAppliedBoundaryCount: 1,
				manualKerningExecutionModel: "bounded-authored-manual-kerning-v1",
			}),
			expect.objectContaining({
				kerning: -125,
				manualKerningBoundaryUtf16: 2,
				manualKerningPixels: -6,
				manualKerningAppliedBoundaryCount: 1,
				manualKerningExecutionModel: "bounded-authored-manual-kerning-v1",
			}),
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/manual-kerning-text-layers-stale" }, plan.fingerprint)).rejects.toThrow(
			"plan changed"
		);
	});

	test("executes authored character auto/explicit leading through exact PSD extraction", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "AB\nC\nD";
		const style = {
			fontIndex: 0,
			fontSize: 20,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [230, 120, 40, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Character Leading",
						id: 4960,
						left: 0,
						top: 0,
						width: 140,
						height: 180,
						visible: true,
						opacity: 255,
						rgba: new Array(140 * 180 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									shape: { type: "box", boxBounds: [0, 0, 140, 180] },
									paragraph: { autoLeading: 1.5 },
									styles: [
										{ ...style, length: 1, autoLeading: false, leading: 30 },
										{ ...style, length: 2, autoLeading: false, leading: 52 },
										{ ...style, length: 2, autoLeading: true, leading: 999 },
										{ ...style, length: 1, autoLeading: false, leading: 40 },
									],
								})
							),
						],
					}),
				],
				{ width: 140, height: 180 }
			)
		);
		const authoredBytes = (await readFile(source)).toString("latin1");
		expect(authoredBytes).toContain("/AutoLeading false /Leading 52");
		expect(authoredBytes).toContain("/AutoLeading true /Leading 999");
		const options = {
			destinationFolder: "assets/character-leading-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Geist-Regular.ttf",
					useAuthoredStyleRuns: true,
					applyAuthoredBoxLayout: true,
					shaping: { direction: "ltr" as const },
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toEqual([
			expect.objectContaining({ autoLeading: false, leading: 30 }),
			expect.objectContaining({ autoLeading: false, leading: 52 }),
			expect.objectContaining({ autoLeading: true, leading: 999 }),
			expect.objectContaining({ autoLeading: false, leading: 40 }),
		]);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(evidence.paragraphRuns[0]).toMatchObject({
			lineIndices: [0, 1, 2],
			lineHeights: [52, 30, 40],
			lineHeightSources: ["authored-explicit-leading", "authored-auto-leading", "authored-explicit-leading"],
			appliedLineHeight: 52,
		});
		expect(evidence.styleRuns).toMatchObject([
			{ autoLeading: false, leading: 30, leadingAppliedLineIndices: [], leadingExecutionModel: "bounded-authored-character-leading-v1" },
			{ autoLeading: false, leading: 52, leadingAppliedLineIndices: [0], leadingAppliedLineHeights: [52] },
			{ autoLeading: true, leading: 999, leadingAppliedLineIndices: [1], leadingAppliedLineHeights: [30] },
			{ autoLeading: false, leading: 40, leadingAppliedLineIndices: [2], leadingAppliedLineHeights: [40] },
		]);
		expect(evidence.boxLayout?.lines).toMatchObject([
			{ lineHeight: 52, lineHeightSource: "authored-explicit-leading", leadingSourceStyleRunIndices: [1] },
			{ lineHeight: 30, lineHeightSource: "authored-auto-leading", leadingSourceStyleRunIndices: [2] },
			{ lineHeight: 40, lineHeightSource: "authored-explicit-leading", leadingSourceStyleRunIndices: [3] },
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/character-leading-text-layers-stale" }, plan.fingerprint)).rejects.toThrow(
			"plan changed"
		);
	});

	test("executes authored normal, all-caps, and OpenType-or-faux small-caps through exact PSD extraction", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "Abß aA Z";
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [230, 120, 40, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Font Caps",
						id: 4970,
						left: 0,
						top: 0,
						width: 300,
						height: 110,
						visible: true,
						opacity: 255,
						rgba: new Array(300 * 110 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									smallCapSize: 0.65,
									styles: [
										{ ...style, length: 3, fontCaps: 2 },
										{ ...style, length: 3, fontCaps: 1 },
										{ ...style, length: 2, fontCaps: 0 },
									],
								})
							),
						],
					}),
				],
				{ width: 300, height: 110 }
			)
		);
		const authoredBytes = (await readFile(source)).toString("latin1");
		expect(authoredBytes).toContain("/FontCaps 2");
		expect(authoredBytes).toContain("/FontCaps 1");
		expect(authoredBytes).toContain("/SmallCapSize 0.65");
		const options = {
			destinationFolder: "assets/font-caps-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text).toMatchObject({
			smallCapSize: 0.65,
			styleRuns: [{ fontCaps: "all-caps" }, { fontCaps: "small-caps" }, { fontCaps: "normal" }],
		});
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(evidence.styleRuns).toMatchObject([
			{
				fontCaps: "all-caps",
				smallCapScale: 0.65,
				capsAppliedScale: 1,
				capsAffectedCharacterCount: 2,
				capsGlyphSource: "unicode-uppercase",
				capsExecutionModel: "bounded-authored-font-caps-v1",
			},
			{
				fontCaps: "small-caps",
				smallCapScale: 0.65,
				capsAppliedScale: 0.65,
				capsAffectedCharacterCount: 1,
				capsGlyphSource: "faux-small-caps",
				capsExecutionModel: "bounded-authored-font-caps-v1",
			},
			{
				fontCaps: "normal",
				smallCapScale: 0.65,
				capsAppliedScale: 1,
				capsAffectedCharacterCount: 0,
				capsGlyphSource: "disabled",
				capsExecutionModel: "bounded-authored-font-caps-v1",
			},
		]);
		expect(evidence.shaping).toMatchObject({ engine: "harfbuzz" });
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/font-caps-text-layers-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");

		const malformed = join(directory, "assets", "font-caps-unsupported.psd");
		await writeFile(
			malformed,
			createLayeredPsd(
				[
					layer({
						name: "Unsupported Font Caps",
						id: 4971,
						left: 0,
						top: 0,
						width: 120,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(120 * 80 * 4).fill(0),
						additionalInfo: [additional("TySh", tyshText("a", { fonts: ["Geist Regular"], styles: [{ ...style, length: 1, fontCaps: 9 }] }))],
					}),
				],
				{ width: 120, height: 80 }
			)
		);
		await expect(getPsdLayerExtractionStatus(malformed, { ...options, textRenders: [{ ...options.textRenders[0], layerIndex: 0 }] })).rejects.toThrow(
			"unsupported FontCaps value"
		);
	});

	test("executes authored normal, superscript, and subscript baselines through exact PSD extraction", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const text = "x2 y3 z";
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [230, 120, 40, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Font Baseline",
						id: 4980,
						left: 0,
						top: 0,
						width: 300,
						height: 120,
						visible: true,
						opacity: 255,
						rgba: new Array(300 * 120 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									superscriptSize: 0.61,
									superscriptPosition: 0.42,
									subscriptSize: 0.57,
									subscriptPosition: 0.31,
									styles: [
										{ ...style, length: 2, fontBaseline: 1 },
										{ ...style, length: 3, fontBaseline: 2 },
										{ ...style, length: 2, fontBaseline: 0 },
									],
								})
							),
						],
					}),
				],
				{ width: 300, height: 120 }
			)
		);
		const options = {
			destinationFolder: "assets/font-baseline-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text).toMatchObject({
			superscriptSize: 0.61,
			superscriptPosition: 0.42,
			subscriptSize: 0.57,
			subscriptPosition: 0.31,
			styleRuns: [{ fontBaseline: "superscript" }, { fontBaseline: "subscript" }, { fontBaseline: "normal" }],
		});
		expect(plan.items[0].appliedTextRenders[0].styleRuns).toMatchObject([
			{
				fontBaseline: "superscript",
				fontBaselineScale: 0.61,
				fontBaselinePosition: 0.42,
				fontBaselineAppliedScale: 1,
				fontBaselineAppliedShift: 0,
				fontBaselineEffectiveFeature: "sups",
				fontBaselineGlyphSource: "opentype-sups",
				fontBaselineExecutionModel: "bounded-authored-font-baseline-v1",
			},
			{
				fontBaseline: "subscript",
				fontBaselineScale: 0.57,
				fontBaselinePosition: 0.31,
				fontBaselineAppliedScale: 1,
				fontBaselineEffectiveFeature: "subs",
				fontBaselineGlyphSource: "opentype-subs",
			},
			{ fontBaseline: "normal", fontBaselineAppliedScale: 1, fontBaselineGlyphSource: "disabled" },
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/font-baseline-text-layers-stale" }, plan.fingerprint)).rejects.toThrow(
			"plan changed"
		);

		const malformed = join(directory, "assets", "font-baseline-unsupported.psd");
		await writeFile(
			malformed,
			createLayeredPsd(
				[
					layer({
						name: "Unsupported Font Baseline",
						id: 4981,
						left: 0,
						top: 0,
						width: 120,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(120 * 80 * 4).fill(0),
						additionalInfo: [additional("TySh", tyshText("a", { fonts: ["Geist Regular"], styles: [{ ...style, length: 1, fontBaseline: 9 }] }))],
					}),
				],
				{ width: 120, height: 80 }
			)
		);
		await expect(getPsdLayerExtractionStatus(malformed, { ...options, textRenders: [{ ...options.textRenders[0], layerIndex: 0 }] })).rejects.toThrow(
			"unsupported FontBaseline value"
		);
	});

	test("executes exact authored Tsume runs through glyph sidebearing compression", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [230, 120, 40, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Tsume",
						id: 4990,
						left: 0,
						top: 0,
						width: 260,
						height: 120,
						visible: true,
						opacity: 255,
						rgba: new Array(260 * 120 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("AAA", {
									fonts: ["Geist Regular"],
									styles: [
										{ ...style, length: 1, tsume: 0 },
										{ ...style, length: 1, tsume: 0.5 },
										{ ...style, length: 1, tsume: 1 },
									],
								})
							),
						],
					}),
				],
				{ width: 260, height: 120 }
			)
		);
		const options = {
			destinationFolder: "assets/tsume-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toMatchObject([{ tsume: 0 }, { tsume: 0.5 }, { tsume: 1 }]);
		expect(plan.items[0].appliedTextRenders[0]).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-style-runs-v1",
			styleRuns: [
				{ tsume: 0, tsumeAppliedGlyphCount: 0, tsumeAdvanceReduction: 0, tsumeExecutionModel: "bounded-authored-tsume-v1" },
				{ tsume: 0.5, tsumeAppliedGlyphCount: 1, tsumeExecutionModel: "bounded-authored-tsume-v1" },
				{ tsume: 1, tsumeAppliedGlyphCount: 1, tsumeExecutionModel: "bounded-authored-tsume-v1" },
			],
		});
		expect(plan.items[0].appliedTextRenders[0].styleRuns[2].tsumeAdvanceReduction).toBeCloseTo(plan.items[0].appliedTextRenders[0].styleRuns[1].tsumeAdvanceReduction * 2, 5);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/tsume-text-layers-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");

		const malformed = join(directory, "assets", "tsume-unsupported.psd");
		await writeFile(
			malformed,
			createLayeredPsd(
				[
					layer({
						name: "Unsupported Tsume",
						id: 4991,
						left: 0,
						top: 0,
						width: 120,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(120 * 80 * 4).fill(0),
						additionalInfo: [additional("TySh", tyshText("a", { fonts: ["Geist Regular"], styles: [{ ...style, length: 1, tsume: 1.01 }] }))],
					}),
				],
				{ width: 120, height: 80 }
			)
		);
		await expect(getPsdLayerExtractionStatus(malformed, { ...options, textRenders: [{ ...options.textRenders[0], layerIndex: 0 }] })).rejects.toThrow(
			"Tsume must be a finite number between 0 and 1"
		);
	});

	test("executes exact authored Photoshop style-run alignment with semantic, apply, reuse, stale, and invalid-value coverage", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const style = {
			fontIndex: 0,
			fontSize: 24,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [50, 180, 240, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Style Alignment",
						id: 5000,
						left: 0,
						top: 0,
						width: 320,
						height: 140,
						visible: true,
						opacity: 255,
						rgba: new Array(320 * 140 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("AAAA", {
									fonts: ["Geist Regular"],
									styles: [
										{ ...style, length: 1, fontSize: 48, styleRunAlignment: 5 },
										{ ...style, length: 1, styleRunAlignment: 0 },
										{ ...style, length: 1, styleRunAlignment: 2 },
										{ ...style, length: 1, styleRunAlignment: 3 },
									],
								})
							),
						],
					}),
				],
				{ width: 320, height: 140 }
			)
		);
		const options = {
			destinationFolder: "assets/style-alignment-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toMatchObject([
			{ styleRunAlignment: "em-box-top-right" },
			{ styleRunAlignment: "em-box-bottom-left" },
			{ styleRunAlignment: "em-box-center" },
			{ styleRunAlignment: "roman-baseline" },
		]);
		const appliedRender = plan.items[0].appliedTextRenders[0];
		expect(appliedRender.executionModel).toBe("bounded-project-font-harfbuzz-style-runs-v1");
		expect(appliedRender.styleRuns).toMatchObject([
			{ styleRunAlignment: "em-box-top-right", styleRunAlignmentExecutionModel: "bounded-authored-style-run-alignment-v1" },
			{ styleRunAlignment: "em-box-bottom-left", styleRunAlignmentExecutionModel: "bounded-authored-style-run-alignment-v1" },
			{ styleRunAlignment: "em-box-center", styleRunAlignmentExecutionModel: "bounded-authored-style-run-alignment-v1" },
			{ styleRunAlignment: "roman-baseline", styleRunAlignmentExecutionModel: "bounded-authored-style-run-alignment-v1" },
		]);
		expect(appliedRender.styleRuns[0].styleRunAlignmentGlyphs[0].appliedShift).toBe(0);
		expect(appliedRender.styleRuns[2].styleRunAlignmentGlyphs[0].appliedShift - appliedRender.styleRuns[1].styleRunAlignmentGlyphs[0].appliedShift).toBeCloseTo(12, 5);
		expect(appliedRender.styleRuns[3].styleRunAlignmentGlyphs[0].appliedShift).toBe(0);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/style-alignment-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");

		const allModes = join(directory, "assets", "style-alignment-semantics.psd");
		await writeFile(
			allModes,
			createLayeredPsd(
				[
					layer({
						name: "All Alignment Semantics",
						id: 5001,
						left: 0,
						top: 0,
						width: 320,
						height: 100,
						visible: true,
						opacity: 255,
						rgba: new Array(320 * 100 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("AAAAAA", {
									fonts: ["Geist Regular"],
									styles: Array.from({ length: 6 }, (_, styleRunAlignment) => ({ ...style, length: 1, styleRunAlignment })),
								})
							),
						],
					}),
				],
				{ width: 320, height: 100 }
			)
		);
		expect((await getPsdLayerExtractionStatus(allModes, { destinationFolder: "assets/alignment-semantic-plan" })).document.layers[0].text?.styleRuns).toMatchObject([
			{ styleRunAlignment: "em-box-bottom-left" },
			{ styleRunAlignment: "icf-bottom-left" },
			{ styleRunAlignment: "em-box-center" },
			{ styleRunAlignment: "roman-baseline" },
			{ styleRunAlignment: "icf-top-right" },
			{ styleRunAlignment: "em-box-top-right" },
		]);
		const invalid = join(directory, "assets", "style-alignment-invalid.psd");
		await writeFile(
			invalid,
			createLayeredPsd(
				[
					layer({
						name: "Invalid Style Alignment",
						id: 5002,
						left: 0,
						top: 0,
						width: 100,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(100 * 80 * 4).fill(0),
						additionalInfo: [additional("TySh", tyshText("A", { fonts: ["Geist Regular"], styles: [{ ...style, length: 1, styleRunAlignment: 9 }] }))],
					}),
				],
				{ width: 100, height: 80 }
			)
		);
		await expect(
			getPsdLayerExtractionStatus(invalid, {
				destinationFolder: "assets/style-alignment-invalid-output",
				textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
			})
		).rejects.toThrow("unsupported StyleRunAlignment value");
	});

	test("executes exact authored Photoshop baseline direction and tate-chu-yoko with semantic, apply, reuse, stale, and invalid-value coverage", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const style = {
			fontIndex: 0,
			fontSize: 40,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 100, 30, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Baseline Direction",
						id: 5010,
						left: 0,
						top: 0,
						width: 240,
						height: 220,
						visible: true,
						opacity: 255,
						rgba: new Array(240 * 220 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("A©12", {
									orientation: "Vrtc",
									fonts: ["Geist Regular"],
									styles: [
										{ ...style, length: 1, baselineDirection: 1 },
										{ ...style, length: 1, baselineDirection: 2 },
										{ ...style, length: 2, baselineDirection: 3 },
									],
								})
							),
						],
					}),
				],
				{ width: 240, height: 220 }
			)
		);
		const options = {
			destinationFolder: "assets/baseline-direction-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toMatchObject([{ baselineDirection: "upright" }, { baselineDirection: "mixed" }, { baselineDirection: "tate-chu-yoko" }]);
		const appliedRender = plan.items[0].appliedTextRenders[0];
		expect(appliedRender).toMatchObject({ orientation: "vertical", executionModel: "bounded-project-font-harfbuzz-vertical-style-runs-v1" });
		expect(appliedRender.styleRuns).toMatchObject([
			{
				baselineDirection: "upright",
				baselineDirectionExecutionModel: "bounded-authored-baseline-direction-v1",
				baselineDirectionGlyphs: [{ renderedOrientation: "upright", shapingDirection: "ttb", rotationDegrees: 0 }],
			},
			{
				baselineDirection: "mixed",
				baselineDirectionExecutionModel: "bounded-authored-baseline-direction-v1",
				baselineDirectionGlyphs: [{ unicodeVerticalOrientation: "U", renderedOrientation: "upright", shapingDirection: "ttb", rotationDegrees: 0 }],
			},
			{
				baselineDirection: "tate-chu-yoko",
				baselineDirectionExecutionModel: "bounded-authored-baseline-direction-v1",
				baselineDirectionGlyphs: [
					{ renderedOrientation: "tate-chu-yoko-horizontal", shapingDirection: "ltr", rotationDegrees: 0 },
					{ renderedOrientation: "tate-chu-yoko-horizontal", shapingDirection: "ltr", rotationDegrees: 0 },
				],
				tateChuYokoBlocks: [{ logicalStart: 2, logicalEnd: 4, glyphCount: 2, cellAdvance: 40 }],
			},
		]);
		expect(appliedRender.styleRuns[2].tateChuYokoBlocks[0].rawAdvance).toBeGreaterThan(0);
		expect(appliedRender.styleRuns[2].tateChuYokoBlocks[0].fittedAdvance).toBeLessThanOrEqual(40);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/baseline-direction-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");

		const invalid = join(directory, "assets", "baseline-direction-invalid.psd");
		await writeFile(
			invalid,
			createLayeredPsd(
				[
					layer({
						name: "Invalid Baseline Direction",
						id: 5011,
						left: 0,
						top: 0,
						width: 100,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(100 * 80 * 4).fill(0),
						additionalInfo: [
							additional("TySh", tyshText("A", { orientation: "Vrtc", fonts: ["Geist Regular"], styles: [{ ...style, length: 1, baselineDirection: 9 }] })),
						],
					}),
				],
				{ width: 100, height: 80 }
			)
		);
		await expect(
			getPsdLayerExtractionStatus(invalid, {
				destinationFolder: "assets/baseline-direction-invalid-output",
				textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
			})
		).rejects.toThrow("unsupported BaselineDirection value");
	});

	test("executes exact authored Photoshop proportional metrics through OpenType palt with semantic, apply, reuse, and stale coverage", async () => {
		const fontPath = join(directory, "assets", "Geist-Palt-Test.ttf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Geist-Palt-Test.ttf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 100, 30, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Proportional Metrics",
						id: 5020,
						left: 0,
						top: 0,
						width: 260,
						height: 120,
						visible: true,
						opacity: 255,
						rgba: new Array(260 * 120 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("AaAa", {
									fonts: ["Geist Palt Test"],
									styles: [
										{ ...style, length: 2, proportionalMetrics: false },
										{ ...style, length: 2, proportionalMetrics: true },
									],
								})
							),
						],
					}),
				],
				{ width: 260, height: 120 }
			)
		);
		const options = {
			destinationFolder: "assets/proportional-metrics-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Palt-Test.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toMatchObject([{ proportionalMetrics: false }, { proportionalMetrics: true }]);
		const appliedRender = plan.items[0].appliedTextRenders[0];
		expect(appliedRender.executionModel).toBe("bounded-project-font-harfbuzz-style-runs-v1");
		expect(appliedRender.styleRuns).toMatchObject([
			{
				proportionalMetrics: false,
				proportionalMetricsFeatureSupported: true,
				proportionalMetricsExecutionModel: "bounded-authored-proportional-metrics-v1",
				effectiveOpenTypeFeatures: [{ tag: "palt", value: 0 }],
				shapedGlyphs: [{ xAdvance: 668 }, { xAdvance: 551 }],
			},
			{
				proportionalMetrics: true,
				proportionalMetricsFeatureSupported: true,
				proportionalMetricsExecutionModel: "bounded-authored-proportional-metrics-v1",
				effectiveOpenTypeFeatures: [{ tag: "palt", value: 1 }],
				shapedGlyphs: [{ xAdvance: 468 }, { xAdvance: 451 }],
			},
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/proportional-metrics-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("executes exact authored Photoshop Kana through OpenType hkna with semantic, apply, reuse, and stale coverage", async () => {
		const fontPath = join(directory, "assets", "Hiragino-Hkna-Test.otf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Hiragino-Hkna-Test.otf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 100, 30, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Horizontal Kana",
						id: 5030,
						left: 0,
						top: 0,
						width: 300,
						height: 120,
						visible: true,
						opacity: 255,
						rgba: new Array(300 * 120 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("かなカナかなカナ", {
									fonts: ["Hiragino Hkna Test"],
									styles: [
										{ ...style, length: 4, kana: false },
										{ ...style, length: 4, kana: true },
									],
								})
							),
						],
					}),
				],
				{ width: 300, height: 120 }
			)
		);
		const options = {
			destinationFolder: "assets/kana-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Hiragino-Hkna-Test.otf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toMatchObject([{ kana: false }, { kana: true }]);
		const appliedRender = plan.items[0].appliedTextRenders[0];
		expect(appliedRender.styleRuns).toMatchObject([
			{
				kana: false,
				kanaFeatureSupported: true,
				kanaExecutionModel: "bounded-authored-kana-v1",
				effectiveOpenTypeFeatures: [{ tag: "hkna", value: 0 }],
				shapedGlyphs: [{ glyphId: 1 }, { glyphId: 2 }, { glyphId: 3 }, { glyphId: 4 }],
			},
			{
				kana: true,
				kanaFeatureSupported: true,
				kanaExecutionModel: "bounded-authored-kana-v1",
				effectiveOpenTypeFeatures: [{ tag: "hkna", value: 1 }],
				shapedGlyphs: [{ glyphId: 5 }, { glyphId: 6 }, { glyphId: 7 }, { glyphId: 8 }],
			},
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/kana-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("executes exact authored Photoshop Ruby through OpenType ruby with semantic, apply, reuse, and stale coverage", async () => {
		const fontPath = join(directory, "assets", "Hiragino-Ruby-Test.otf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Hiragino-Ruby-Test.otf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 100, 30, 255] as [number, number, number, number],
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Ruby Forms",
						id: 5040,
						left: 0,
						top: 0,
						width: 340,
						height: 120,
						visible: true,
						opacity: 255,
						rgba: new Array(340 * 120 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("あいうえおあいうえお", {
									fonts: ["Hiragino Ruby Test"],
									styles: [
										{ ...style, length: 5, ruby: false },
										{ ...style, length: 5, ruby: true },
									],
								})
							),
						],
					}),
				],
				{ width: 340, height: 120 }
			)
		);
		const options = {
			destinationFolder: "assets/ruby-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Hiragino-Ruby-Test.otf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toMatchObject([{ ruby: false }, { ruby: true }]);
		const appliedRender = plan.items[0].appliedTextRenders[0];
		expect(appliedRender.styleRuns).toMatchObject([
			{
				ruby: false,
				rubyFeatureSupported: true,
				rubyExecutionModel: "bounded-authored-ruby-v1",
				effectiveOpenTypeFeatures: [{ tag: "ruby", value: 0 }],
				shapedGlyphs: [{ glyphId: 1 }, { glyphId: 2 }, { glyphId: 3 }, { glyphId: 4 }, { glyphId: 5 }],
			},
			{
				ruby: true,
				rubyFeatureSupported: true,
				rubyExecutionModel: "bounded-authored-ruby-v1",
				effectiveOpenTypeFeatures: [{ tag: "ruby", value: 1 }],
				shapedGlyphs: [{ glyphId: 6 }, { glyphId: 7 }, { glyphId: 8 }, { glyphId: 9 }, { glyphId: 10 }],
			},
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/ruby-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");
	});

	test("executes exact authored Photoshop Japanese alternates through trad, expt, and jp78 with semantic, apply, reuse, stale, and malformed coverage", async () => {
		const fontPath = join(directory, "assets", "Hiragino-Japanese-Alternates-Test.otf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Hiragino-Japanese-Alternates-Test.otf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 100, 30, 255] as [number, number, number, number],
		};
		const makePsd = (values: number[]) =>
			createLayeredPsd(
				[
					layer({
						name: "Authored Japanese Alternates",
						id: 5050,
						left: 0,
						top: 0,
						width: 560,
						height: 120,
						visible: true,
						opacity: 255,
						rgba: new Array(560 * 120 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText("あいうえお".repeat(values.length), {
									fonts: ["Hiragino Japanese Alternates Test"],
									styles: values.map((japaneseAlternateFeature) => ({ ...style, length: 5, japaneseAlternateFeature })),
								})
							),
						],
					}),
				],
				{ width: 560, height: 120 }
			);
		await writeFile(source, makePsd([0, 1, 2, 3]));
		const options = {
			destinationFolder: "assets/japanese-alternate-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Hiragino-Japanese-Alternates-Test.otf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		expect(plan.document.layers[0].text?.styleRuns).toMatchObject([
			{ japaneseAlternateFeature: "normal" },
			{ japaneseAlternateFeature: "traditional" },
			{ japaneseAlternateFeature: "expert" },
			{ japaneseAlternateFeature: "jis78" },
		]);
		const appliedRender = plan.items[0].appliedTextRenders[0];
		expect(appliedRender.styleRuns).toMatchObject([
			{
				japaneseAlternateFeature: "normal",
				japaneseAlternateFeatureTag: null,
				japaneseAlternateFeatureSupported: true,
				japaneseAlternateFeatureAvailableTags: ["trad", "expt", "jp78"],
				japaneseAlternateFeatureExecutionModel: "bounded-authored-japanese-alternate-feature-v1",
				effectiveOpenTypeFeatures: [
					{ tag: "trad", value: 0 },
					{ tag: "expt", value: 0 },
					{ tag: "jp78", value: 0 },
				],
				shapedGlyphs: [{ glyphId: 1 }, { glyphId: 2 }, { glyphId: 3 }, { glyphId: 4 }, { glyphId: 5 }],
			},
			{
				japaneseAlternateFeature: "traditional",
				japaneseAlternateFeatureTag: "trad",
				japaneseAlternateFeatureSupported: true,
				shapedGlyphs: [{ glyphId: 6 }, { glyphId: 7 }, { glyphId: 8 }, { glyphId: 9 }, { glyphId: 10 }],
			},
			{
				japaneseAlternateFeature: "expert",
				japaneseAlternateFeatureTag: "expt",
				japaneseAlternateFeatureSupported: true,
				shapedGlyphs: [{ glyphId: 10 }, { glyphId: 9 }, { glyphId: 8 }, { glyphId: 7 }, { glyphId: 6 }],
			},
			{
				japaneseAlternateFeature: "jis78",
				japaneseAlternateFeatureTag: "jp78",
				japaneseAlternateFeatureSupported: true,
				shapedGlyphs: [{ glyphId: 7 }, { glyphId: 8 }, { glyphId: 9 }, { glyphId: 10 }, { glyphId: 6 }],
			},
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/japanese-alternate-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");

		await writeFile(source, makePsd([4]));
		await expect(getPsdLayerExtractionStatus(source, options)).rejects.toThrow("unsupported JapaneseAlternateFeature value");
	});

	test("executes authored Photoshop Wari-chu fields with all justification modes, exact evidence, apply, reuse, stale, and malformed coverage", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const style = {
			fontIndex: 0,
			fontSize: 48,
			fauxBold: false,
			fauxItalic: false,
			tracking: 20,
			wariChuLineCount: 2,
			wariChuLineGap: 2,
			wariChuScale: 0.5,
			wariChuWidow: 2,
			wariChuOrphan: 2,
			color: [245, 100, 30, 255] as [number, number, number, number],
		};
		const text = "ABCDEFGH".repeat(9);
		const makePsd = (justifications: number[]) =>
			createLayeredPsd(
				[
					layer({
						name: "Authored Wari-chu",
						id: 5060,
						left: 0,
						top: 0,
						width: 920,
						height: 150,
						visible: true,
						opacity: 255,
						rgba: new Array(920 * 150 * 4).fill(0),
						additionalInfo: [
							additional(
								"TySh",
								tyshText(text, {
									fonts: ["Geist Regular"],
									styles: justifications.map((wariChuJustification, index) => ({
										...style,
										length: 8,
										wariChuEnabled: index < 8,
										wariChuJustification,
									})),
								})
							),
						],
					}),
				],
				{ width: 920, height: 150 }
			);
		await writeFile(source, makePsd([0, 1, 2, 3, 4, 5, 6, 7, 7]));
		const options = {
			destinationFolder: "assets/wari-chu-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		const expectedJustifications = ["left", "right", "center", "justify-left", "justify-right", "justify-center", "justify-all", "auto", "auto"];
		expect(plan.document.layers[0].text?.styleRuns.map((run) => run.wariChuJustification)).toEqual(expectedJustifications);
		expect(plan.document.layers[0].text?.styleRuns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					wariChuEnabled: true,
					wariChuLineCount: 2,
					wariChuLineGap: 2,
					wariChuScale: 0.5,
					wariChuWidow: 2,
					wariChuOrphan: 2,
				}),
			])
		);
		const renderedRuns = plan.items[0].appliedTextRenders[0].styleRuns;
		expect(renderedRuns.slice(0, 8).map((run) => run.wariChuJustification)).toEqual(expectedJustifications.slice(0, 8));
		expect(renderedRuns.slice(0, 8).every((run) => run.wariChuExecutionModel === "bounded-authored-wari-chu-v1" && run.wariChuBlocks.length === 1)).toBe(true);
		expect(renderedRuns.slice(0, 8).map((run) => run.wariChuBlocks[0].rows.map((row) => row.resolvedJustification))).toEqual([
			["left", "left"],
			["right", "right"],
			["center", "center"],
			["justify", "left"],
			["justify", "right"],
			["justify", "center"],
			["justify", "justify"],
			["justify", "left"],
		]);
		expect(renderedRuns[8]).toMatchObject({ wariChuEnabled: false, wariChuBlocks: [], wariChuExecutionModel: "bounded-authored-wari-chu-v1" });
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...decoded].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/wari-chu-stale" }, plan.fingerprint)).rejects.toThrow("plan changed");

		await writeFile(source, makePsd([8, 1, 2, 3, 4, 5, 6, 7, 7]));
		await expect(getPsdLayerExtractionStatus(source, options)).rejects.toThrow("unsupported WariChuJustification value");
	});

	test("merges global Txt2 EngineData2 at union style boundaries and executes frac, ordn, and salt through authored PSD rendering", async () => {
		const fontPath = join(directory, "assets", "Geist-EngineData2.ttf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Geist-EngineData2-Test.ttf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const baseStyle = {
			fontIndex: 0,
			fontSize: 52,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 245, 245, 255] as [number, number, number, number],
		};
		const text = "123123123";
		const textLayer = layer({
			name: "Global EngineData2",
			id: 5090,
			left: 0,
			top: 0,
			width: 480,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(480 * 100 * 4).fill(0),
			additionalInfo: [
				additional(
					"TySh",
					tyshText(text, {
						textIndex: 0,
						fonts: ["Geist Regular"],
						styles: [
							{ ...baseStyle, length: 4, color: [255, 80, 80, 255] },
							{ ...baseStyle, length: 5, color: [80, 160, 255, 255] },
						],
					})
				),
			],
		});
		const txt2 = txt2EngineData2([
			{
				text,
				runs: [
					{ length: 3, fractions: true, ordinals: false, stylisticAlternates: false },
					{ length: 3, fractions: false, ordinals: true, stylisticAlternates: false },
					{ length: 3, fractions: false, ordinals: false, stylisticAlternates: true },
				],
			},
		]);
		await writeFile(source, createLayeredPsd([textLayer], { width: 480, height: 100 }, globalAdditional("Txt2", txt2)));

		const raw = inspectPsdLayers(await readFile(source));
		expect(raw.layers[0].text).toMatchObject({
			textIndex: 0,
			engineData2Bytes: txt2.length,
			engineData2Warning: null,
			engineData2ExecutionModel: "bounded-global-txt2-engine-data2-v1",
		});
		expect(raw.layers[0].text?.styleRuns.map((run) => [run.length, run.engineData2StyleRunIndex, run.fractions, run.ordinals, run.stylisticAlternates])).toEqual([
			[3, 0, true, false, false],
			[1, 1, false, true, false],
			[2, 1, false, true, false],
			[3, 2, false, false, true],
		]);

		const options = {
			destinationFolder: "assets/engine-data2-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Geist-EngineData2.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const runs = plan.items[0].appliedTextRenders[0].styleRuns;
		expect(runs.map((run) => [run.length, run.engineData2StyleRunIndex, run.fractions, run.ordinals, run.stylisticAlternates])).toEqual([
			[3, 0, true, false, false],
			[1, 1, false, true, false],
			[2, 1, false, true, false],
			[3, 2, false, false, true],
		]);
		expect(runs.map((run) => run.effectiveOpenTypeFeatures.filter((feature) => ["frac", "ordn", "salt"].includes(feature.tag)))).toEqual([
			[
				{ tag: "frac", value: 1 },
				{ tag: "ordn", value: 0 },
				{ tag: "salt", value: 0 },
			],
			[
				{ tag: "frac", value: 0 },
				{ tag: "ordn", value: 1 },
				{ tag: "salt", value: 0 },
			],
			[
				{ tag: "frac", value: 0 },
				{ tag: "ordn", value: 1 },
				{ tag: "salt", value: 0 },
			],
			[
				{ tag: "frac", value: 0 },
				{ tag: "ordn", value: 0 },
				{ tag: "salt", value: 1 },
			],
		]);
		expect(runs.every((run) => run.fractionsFeatureSupported && run.ordinalsFeatureSupported && run.stylisticAlternatesFeatureSupported)).toBe(true);
		expect(plan.items[0].appliedTextRenders[0].shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 4, 5, 6, 7, 8, 5, 1, 4]);
		expect(runs.every((run) => run.engineData2ExecutionModel === "bounded-global-txt2-engine-data2-v1")).toBe(true);
		expect(runs.every((run) => run.stylisticOpenTypeExecutionModel === "bounded-authored-stylistic-opentype-v1")).toBe(true);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(scene, { path: "assets/hero.psd", ...options, destinationFolder: "assets/engine-data2-stale", expectedFingerprint: plan.fingerprint, confirm: true }, {
				editor: { layout: { assets: { refresh: () => undefined } } },
			} as never)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		await writeFile(
			source,
			createLayeredPsd([textLayer], { width: 480, height: 100 }, globalAdditional("Txt2", txt2EngineData2([{ text: "mismatch", runs: [{ length: 8, fractions: true }] }])))
		);
		const mismatch = inspectPsdLayers(await readFile(source));
		expect(mismatch.layers[0].text?.engineData2ExecutionModel).toBe("disabled");
		expect(mismatch.layers[0].text?.engineData2Warning).toContain("text does not match");

		await writeFile(
			source,
			createLayeredPsd([textLayer], { width: 480, height: 100 }, globalAdditional("Txt2", txt2EngineData2([{ text, runs: [{ length: 8, fractions: true }] }])))
		);
		const incomplete = inspectPsdLayers(await readFile(source));
		expect(incomplete.layers[0].text?.engineData2Warning).toContain("style runs cover 8 UTF-16 code units instead of 9");

		await writeFile(source, createLayeredPsd([textLayer, textLayer], { width: 480, height: 100 }, globalAdditional("Txt2", txt2)));
		const ambiguous = inspectPsdLayers(await readFile(source));
		expect(ambiguous.layers.every((layer) => layer.text?.engineData2Warning?.includes("multiple TySh layers use the same TextIndex"))).toBe(true);

		await writeFile(source, createLayeredPsd([textLayer], { width: 480, height: 100 }, Buffer.concat([globalAdditional("Txt2", txt2), globalAdditional("Txt2", txt2)])));
		const duplicateGlobal = inspectPsdLayers(await readFile(source));
		expect(duplicateGlobal.layers[0].text?.engineData2Warning).toContain("multiple Txt2 blocks");

		const surrogateText = "A😀B";
		const surrogateLayer = layer({
			name: "EngineData2 surrogate boundary",
			id: 5091,
			left: 0,
			top: 0,
			width: 200,
			height: 80,
			visible: true,
			opacity: 255,
			rgba: new Array(200 * 80 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText(surrogateText, { textIndex: 0, fonts: ["Geist Regular"] }))],
		});
		await writeFile(
			source,
			createLayeredPsd(
				[surrogateLayer],
				{ width: 200, height: 80 },
				globalAdditional(
					"Txt2",
					txt2EngineData2([
						{
							text: surrogateText,
							runs: [
								{ length: 2, fractions: true },
								{ length: 2, fractions: false },
							],
						},
					])
				)
			)
		);
		const splitSurrogate = inspectPsdLayers(await readFile(source));
		expect(splitSurrogate.layers[0].text?.engineData2Warning).toContain("splits a surrogate pair");

		const invalidBoolean = Buffer.from(txt2);
		invalidBoolean.write("/23 1   ", invalidBoolean.indexOf(Buffer.from("/23 true")), "ascii");
		await writeFile(source, createLayeredPsd([textLayer], { width: 480, height: 100 }, globalAdditional("Txt2", invalidBoolean)));
		const malformedFeature = inspectPsdLayers(await readFile(source));
		expect(malformedFeature.layers[0].text?.engineData2Warning).toContain("Fractions /23 is not Boolean");
	});

	test("executes authored PSD OldStyle, Swash, Titling, Ornaments, and SlashedZero through exact OpenType tags", async () => {
		const fontPath = join(directory, "assets", "Zvibe-Character-OpenType.ttf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Zvibe-Character-OpenType-Test.ttf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const text = "A0A0A0A0A0";
		const baseStyle = {
			length: 2,
			fontIndex: 0,
			fontSize: 52,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 245, 245, 255] as [number, number, number, number],
		};
		const textLayer = layer({
			name: "Character OpenType",
			id: 5100,
			left: 0,
			top: 0,
			width: 520,
			height: 110,
			visible: true,
			opacity: 255,
			rgba: new Array(520 * 110 * 4).fill(0),
			additionalInfo: [
				additional(
					"TySh",
					tyshText(text, {
						fonts: ["Zvibe Character OpenType Test"],
						styles: [
							{ ...baseStyle, oldStyle: true, color: [255, 80, 80, 255] },
							{ ...baseStyle, swash: true, color: [255, 180, 60, 255] },
							{ ...baseStyle, titling: true, color: [80, 220, 100, 255] },
							{ ...baseStyle, ornaments: true, color: [80, 160, 255, 255] },
							{ ...baseStyle, slashedZero: true, color: [210, 100, 255, 255] },
						],
					})
				),
			],
		});
		await writeFile(source, createLayeredPsd([textLayer], { width: 520, height: 110 }));

		const rawRuns = inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns;
		expect(rawRuns?.map((run) => [run.oldStyle, run.swash, run.titling, run.ornaments, run.slashedZero])).toEqual([
			[true, null, null, null, null],
			[null, true, null, null, null],
			[null, null, true, null, null],
			[null, null, null, true, null],
			[null, null, null, null, true],
		]);
		const options = {
			destinationFolder: "assets/character-opentype-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Zvibe-Character-OpenType.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 6, 3, 2, 4, 2, 5, 2, 1, 7]);
		expect(appliedText.styleRuns.map((run) => run.effectiveOpenTypeFeatures)).toEqual([
			[{ tag: "onum", value: 1 }],
			[{ tag: "swsh", value: 1 }],
			[{ tag: "titl", value: 1 }],
			[{ tag: "ornm", value: 1 }],
			[{ tag: "zero", value: 1 }],
		]);
		expect(
			appliedText.styleRuns.every(
				(run) =>
					run.characterOpenTypeExecutionModel === "bounded-authored-character-opentype-v1" &&
					(run.oldStyleFeatureSupported || run.swashFeatureSupported || run.titlingFeatureSupported || run.ornamentsFeatureSupported || run.slashedZeroFeatureSupported)
			)
		).toBe(true);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(
				scene,
				{ path: "assets/hero.psd", ...options, destinationFolder: "assets/character-opentype-stale", expectedFingerprint: plan.fingerprint, confirm: true },
				{
					editor: { layout: { assets: { refresh: () => undefined } } },
				} as never
			)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		const malformedLayer = layer({
			name: "Malformed Character OpenType",
			id: 5101,
			left: 0,
			top: 0,
			width: 520,
			height: 110,
			visible: true,
			opacity: 255,
			rgba: new Array(520 * 110 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("A0", { fonts: ["Zvibe Character OpenType Test"], styles: [{ ...baseStyle, oldStyle: "[ 2 ]" as never }] }))],
		});
		await writeFile(source, createLayeredPsd([malformedLayer], { width: 520, height: 110 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("OldStyle is not Boolean");
	});

	test("executes authored PSD ConnectionForms as exact contextual alternates", async () => {
		const fontPath = join(directory, "assets", "Zvibe-Connection-Forms.ttf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Zvibe-Connection-Forms-Test.ttf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const baseStyle = {
			length: 1,
			fontIndex: 0,
			fontSize: 52,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [180, 120, 240, 255] as [number, number, number, number],
		};
		const textLayer = layer({
			name: "Connection Forms",
			id: 5120,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [
				additional(
					"TySh",
					tyshText("AA", {
						fonts: ["Zvibe Connection Forms Test"],
						styles: [
							{ ...baseStyle, connectionForms: false, color: [255, 100, 100, 255] },
							{ ...baseStyle, connectionForms: true, color: [100, 180, 255, 255] },
						],
					})
				),
			],
		});
		await writeFile(source, createLayeredPsd([textLayer], { width: 180, height: 100 }));
		const rawRuns = inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns;
		expect(rawRuns?.map((run) => run.connectionForms)).toEqual([false, true]);
		const options = {
			destinationFolder: "assets/connection-forms-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Zvibe-Connection-Forms.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 3]);
		expect(appliedText.styleRuns.map((run) => run.effectiveOpenTypeFeatures)).toEqual([[{ tag: "calt", value: 0 }], [{ tag: "calt", value: 1 }]]);
		expect(appliedText.styleRuns.every((run) => run.connectionFormsFeatureSupported && run.connectionFormsExecutionModel === "bounded-authored-connection-forms-v1")).toBe(
			true
		);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(
				scene,
				{ path: "assets/hero.psd", ...options, destinationFolder: "assets/connection-forms-stale", expectedFingerprint: plan.fingerprint, confirm: true },
				{
					editor: { layout: { assets: { refresh: () => undefined } } },
				} as never
			)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		const malformedLayer = layer({
			name: "Malformed Connection Forms",
			id: 5121,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("A", { fonts: ["Zvibe Connection Forms Test"], styles: [{ ...baseStyle, connectionForms: "[ 2 ]" as never }] }))],
		});
		await writeFile(source, createLayeredPsd([malformedLayer], { width: 180, height: 100 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("ConnectionForms is not Boolean");
	});

	test("executes authored PSD ContextualLigatures as exact contextual ligatures", async () => {
		const fontPath = join(directory, "assets", "Zvibe-Contextual-Ligatures.ttf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Zvibe-Contextual-Ligatures-Test.ttf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const baseStyle = {
			length: 1,
			fontIndex: 0,
			fontSize: 52,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [80, 210, 170, 255] as [number, number, number, number],
		};
		const textLayer = layer({
			name: "Contextual Ligatures",
			id: 5130,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [
				additional(
					"TySh",
					tyshText("AA", {
						fonts: ["Zvibe Contextual Ligatures Test"],
						styles: [
							{ ...baseStyle, contextualLigatures: false, color: [240, 110, 100, 255] },
							{ ...baseStyle, contextualLigatures: true, color: [80, 210, 170, 255] },
						],
					})
				),
			],
		});
		await writeFile(source, createLayeredPsd([textLayer], { width: 180, height: 100 }));
		const rawRuns = inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns;
		expect(rawRuns?.map((run) => run.contextualLigatures)).toEqual([false, true]);
		const options = {
			destinationFolder: "assets/contextual-ligatures-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Zvibe-Contextual-Ligatures.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([1, 3]);
		expect(appliedText.styleRuns.map((run) => run.effectiveOpenTypeFeatures)).toEqual([[{ tag: "clig", value: 0 }], [{ tag: "clig", value: 1 }]]);
		expect(
			appliedText.styleRuns.every((run) => run.contextualLigaturesFeatureSupported && run.contextualLigaturesExecutionModel === "bounded-authored-contextual-ligatures-v1")
		).toBe(true);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(
				scene,
				{ path: "assets/hero.psd", ...options, destinationFolder: "assets/contextual-ligatures-stale", expectedFingerprint: plan.fingerprint, confirm: true },
				{
					editor: { layout: { assets: { refresh: () => undefined } } },
				} as never
			)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		const malformedLayer = layer({
			name: "Malformed Contextual Ligatures",
			id: 5131,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("A", { fonts: ["Zvibe Contextual Ligatures Test"], styles: [{ ...baseStyle, contextualLigatures: "[ 2 ]" as never }] }))],
		});
		await writeFile(source, createLayeredPsd([malformedLayer], { width: 180, height: 100 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("ContextualLigatures is not Boolean");
	});

	test("executes authored PSD HindiNumbers as exact Arabic/Western or Hindi/Arabic-Indic digits", async () => {
		const fontPath = join(directory, "assets", "Zvibe-Hindi-Numbers.ttf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Zvibe-Hindi-Numbers-Test.ttf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const baseStyle = {
			length: 1,
			fontIndex: 0,
			fontSize: 52,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [240, 170, 70, 255] as [number, number, number, number],
		};
		const textLayer = layer({
			name: "Hindi Numbers",
			id: 5140,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [
				additional(
					"TySh",
					tyshText("00", {
						fonts: ["Zvibe Hindi Numbers Test"],
						styles: [
							{ ...baseStyle, hindiNumbers: false, color: [240, 110, 100, 255] },
							{ ...baseStyle, hindiNumbers: true, color: [240, 170, 70, 255] },
						],
					})
				),
			],
		});
		await writeFile(source, createLayeredPsd([textLayer], { width: 180, height: 100 }));
		const rawRuns = inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns;
		expect(rawRuns?.map((run) => run.hindiNumbers)).toEqual([false, true]);
		const options = {
			destinationFolder: "assets/hindi-numbers-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Zvibe-Hindi-Numbers.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([2, 6]);
		expect(appliedText.styleRuns.map((run) => run.hindiNumbersEffectiveDigits)).toEqual(["arabic-western", "hindi-arabic-indic"]);
		expect(appliedText.styleRuns.map((run) => run.hindiNumbersAffectedCharacterCount)).toEqual([0, 1]);
		expect(appliedText.styleRuns.every((run) => run.hindiNumbersExecutionModel === "bounded-authored-hindi-numbers-v1")).toBe(true);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(
				scene,
				{ path: "assets/hero.psd", ...options, destinationFolder: "assets/hindi-numbers-stale", expectedFingerprint: plan.fingerprint, confirm: true },
				{
					editor: { layout: { assets: { refresh: () => undefined } } },
				} as never
			)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		const malformedLayer = layer({
			name: "Malformed Hindi Numbers",
			id: 5141,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("0", { fonts: ["Zvibe Hindi Numbers Test"], styles: [{ ...baseStyle, hindiNumbers: "[ 2 ]" as never }] }))],
		});
		await writeFile(source, createLayeredPsd([malformedLayer], { width: 180, height: 100 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("HindiNumbers is not Boolean");
	});

	test("executes authored PSD CharacterDirection as exact Default, LTR, and RTL character runs", async () => {
		const fontPath = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		const baseStyle = {
			length: 3,
			fontIndex: 0,
			fontSize: 42,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [240, 170, 70, 255] as [number, number, number, number],
		};
		const textLayer = layer({
			name: "Character Direction",
			id: 5150,
			left: 0,
			top: 0,
			width: 320,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(320 * 100 * 4).fill(0),
			additionalInfo: [
				additional(
					"TySh",
					tyshText("ABCDEFGHI", {
						fonts: ["Amiri Regular"],
						styles: [
							{ ...baseStyle, characterDirection: 0, color: [240, 100, 90, 255] },
							{ ...baseStyle, characterDirection: 1, color: [100, 220, 120, 255] },
							{ ...baseStyle, characterDirection: 2, color: [100, 150, 250, 255] },
						],
					})
				),
			],
		});
		await writeFile(source, createLayeredPsd([textLayer], { width: 320, height: 100 }));
		const rawRuns = inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns;
		expect(rawRuns?.map((run) => run.characterDirection)).toEqual(["default", "left-to-right", "right-to-left"]);
		const options = {
			destinationFolder: "assets/character-direction-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Amiri-Regular.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.styleRuns.map((run) => run.characterDirection)).toEqual(["default", "left-to-right", "right-to-left"]);
		expect(appliedText.styleRuns.map((run) => run.characterDirectionOverrideCharacterCount)).toEqual([0, 3, 3]);
		expect(appliedText.styleRuns.map((run) => run.characterDirectionResolvedEmbeddingLevels)).toEqual([[0], [0], [1]]);
		expect(appliedText.styleRuns.every((run) => run.characterDirectionExecutionModel === "bounded-authored-character-direction-v1")).toBe(true);
		expect(appliedText.styleRuns[2].shapedGlyphs.map((glyph) => glyph.cluster)).toEqual([8, 7, 6]);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(
				scene,
				{ path: "assets/hero.psd", ...options, destinationFolder: "assets/character-direction-stale", expectedFingerprint: plan.fingerprint, confirm: true },
				{ editor: { layout: { assets: { refresh: () => undefined } } } } as never
			)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		const malformedLayer = layer({
			name: "Malformed Character Direction",
			id: 5151,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("ABC", { fonts: ["Amiri Regular"], styles: [{ ...baseStyle, characterDirection: "[ 2 ]" as never }] }))],
		});
		await writeFile(source, createLayeredPsd([malformedLayer], { width: 180, height: 100 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("CharacterDirection is not an integer");

		const unknownLayer = layer({
			name: "Unknown Character Direction",
			id: 5152,
			left: 0,
			top: 0,
			width: 180,
			height: 100,
			visible: true,
			opacity: 255,
			rgba: new Array(180 * 100 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("ABC", { fonts: ["Amiri Regular"], styles: [{ ...baseStyle, characterDirection: 3 }] }))],
		});
		await writeFile(source, createLayeredPsd([unknownLayer], { width: 180, height: 100 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns[0].characterDirection).toBe("unknown");
		const unknownEngine = new NullEngine();
		const unknownScene = new Scene(unknownEngine);
		await expect(inspectPsdLayerExtraction(unknownScene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 })).rejects.toThrow(
			"unsupported CharacterDirection value"
		);
		unknownScene.dispose();
		unknownEngine.dispose();
	});

	test("executes authored PSD Kashida as exact off/on Arabic full-justification eligibility", async () => {
		const fontPath = join(directory, "assets", "Amiri-Kashida.ttf");
		await copyFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		const baseStyle = {
			length: 4,
			fontIndex: 0,
			fontSize: 42,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [230, 160, 60, 255] as [number, number, number, number],
		};
		const createKashidaLayer = (kashida: number | string, id: number) =>
			layer({
				name: `Kashida ${kashida}`,
				id,
				left: 0,
				top: 0,
				width: 260,
				height: 90,
				visible: true,
				opacity: 255,
				rgba: new Array(260 * 90 * 4).fill(0),
				additionalInfo: [
					additional(
						"TySh",
						tyshText("سلام", {
							fonts: ["Amiri Regular"],
							styles: [{ ...baseStyle, kashida: kashida as number }],
							paragraph: { justification: 6, autoHyphenate: false },
							shape: { type: "box", boxBounds: [4, 4, 220, 86] },
						})
					),
				],
			});
		await writeFile(source, createLayeredPsd([createKashidaLayer(1, 5160)], { width: 260, height: 90 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns[0].kashida).toBe("on");
		const options = {
			destinationFolder: "assets/kashida-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Amiri-Kashida.ttf", useAuthoredStyleRuns: true, applyAuthoredBoxLayout: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.styleRuns[0]).toMatchObject({
			kashida: true,
			kashidaExecutionModel: "bounded-authored-kashida-justification-v1",
		});
		expect(appliedText.styleRuns[0].kashidaEligibleJoinCount).toBeGreaterThan(0);
		expect(appliedText.styleRuns[0].kashidaInsertedCount).toBeGreaterThan(0);
		expect(appliedText.styleRuns[0].kashidaInsertedAdvance).toBeGreaterThan(0);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(scene, { path: "assets/hero.psd", ...options, destinationFolder: "assets/kashida-stale", expectedFingerprint: plan.fingerprint, confirm: true }, {
				editor: { layout: { assets: { refresh: () => undefined } } },
			} as never)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		await writeFile(source, createLayeredPsd([createKashidaLayer("[ 1 ]", 5161)], { width: 260, height: 90 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("Kashida is not an integer");
		await writeFile(source, createLayeredPsd([createKashidaLayer(2, 5162)], { width: 260, height: 90 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns[0].kashida).toBe("unknown");
		const unknownEngine = new NullEngine();
		const unknownScene = new Scene(unknownEngine);
		await expect(inspectPsdLayerExtraction(unknownScene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 })).rejects.toThrow("unsupported Kashida value");
		unknownScene.dispose();
		unknownEngine.dispose();
	});

	test("executes authored PSD DiacriticPos as exact OpenType, Loose, Medium, and Tight mark positioning", async () => {
		const fontPath = join(directory, "assets", "Amiri-Diacritics.ttf");
		await copyFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		const baseStyle = {
			length: 6,
			fontIndex: 0,
			fontSize: 42,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [240, 190, 70, 255] as [number, number, number, number],
		};
		const createDiacriticLayer = (diacriticPosition: number | string, id: number) =>
			layer({
				name: `Diacritic ${diacriticPosition}`,
				id,
				left: 0,
				top: 0,
				width: 260,
				height: 110,
				visible: true,
				opacity: 255,
				rgba: new Array(260 * 110 * 4).fill(0),
				additionalInfo: [
					additional(
						"TySh",
						tyshText("كُتِبَ", {
							fonts: ["Amiri Regular"],
							styles: [{ ...baseStyle, diacriticPosition: diacriticPosition as number }],
						})
					),
				],
			});
		await writeFile(
			source,
			createLayeredPsd([createDiacriticLayer(0, 5170), createDiacriticLayer(1, 5171), createDiacriticLayer(2, 5172), createDiacriticLayer(3, 5173)], {
				width: 260,
				height: 110,
			})
		);
		expect(
			inspectPsdLayers(await readFile(source))
				.layers.map((record) => [record.name, record.text?.styleRuns[0].diacriticPosition])
				.sort(([left], [right]) => String(left).localeCompare(String(right)))
		).toEqual([
			["Diacritic 0", "opentype"],
			["Diacritic 1", "loose"],
			["Diacritic 2", "medium"],
			["Diacritic 3", "tight"],
		]);
		await writeFile(source, createLayeredPsd([createDiacriticLayer(1, 5170)], { width: 260, height: 110 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns[0].diacriticPosition).toBe("loose");
		const options = {
			destinationFolder: "assets/diacritic-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Amiri-Diacritics.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.styleRuns[0]).toMatchObject({
			diacriticPosition: "loose",
			diacriticAffectedGlyphCount: 3,
			diacriticExecutionModel: "bounded-authored-diacritic-position-v1",
		});
		expect(appliedText.styleRuns[0].diacriticGlyphs.map((glyph) => glyph.placement).sort()).toEqual(["above", "above", "below"]);
		expect(appliedText.styleRuns[0].diacriticGlyphs.map((glyph) => Math.abs(glyph.authoredVerticalShift))).toEqual([5.04, 5.04, 5.04]);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(scene, { path: "assets/hero.psd", ...options, destinationFolder: "assets/diacritic-stale", expectedFingerprint: plan.fingerprint, confirm: true }, {
				editor: { layout: { assets: { refresh: () => undefined } } },
			} as never)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		await writeFile(source, createLayeredPsd([createDiacriticLayer("[ 2 ]", 5171)], { width: 260, height: 110 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("DiacriticPos is not an integer");
		await writeFile(source, createLayeredPsd([createDiacriticLayer(4, 5172)], { width: 260, height: 110 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns[0].diacriticPosition).toBe("unknown");
		const unknownEngine = new NullEngine();
		const unknownScene = new Scene(unknownEngine);
		await expect(inspectPsdLayerExtraction(unknownScene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 })).rejects.toThrow("unsupported DiacriticPos value");
		unknownScene.dispose();
		unknownEngine.dispose();
	});

	test("executes authored PSD FigureStyle as exact mutually exclusive figure-form and width features", async () => {
		const fontPath = join(directory, "assets", "Zvibe-Figure-Style.ttf");
		const encodedFont = await readFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Zvibe-Figure-Style-Test.ttf.base64"), "utf8");
		await writeFile(fontPath, Buffer.from(encodedFont.trim(), "base64"));
		const baseStyle = {
			length: 1,
			fontIndex: 0,
			fontSize: 52,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [245, 245, 245, 255] as [number, number, number, number],
		};
		const textLayer = layer({
			name: "Figure Style",
			id: 5110,
			left: 0,
			top: 0,
			width: 320,
			height: 110,
			visible: true,
			opacity: 255,
			rgba: new Array(320 * 110 * 4).fill(0),
			additionalInfo: [
				additional(
					"TySh",
					tyshText("00000", {
						fonts: ["Zvibe Figure Style Test"],
						styles: [0, 1, 2, 3, 4].map((figureStyle, index) => ({
							...baseStyle,
							figureStyle,
							color: [80 + index * 35, 220 - index * 20, 100 + index * 25, 255] as [number, number, number, number],
						})),
					})
				),
			],
		});
		await writeFile(source, createLayeredPsd([textLayer], { width: 320, height: 110 }));
		const rawRuns = inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns;
		expect(rawRuns?.map((run) => run.figureStyle)).toEqual(["default", "tabular-lining", "proportional-oldstyle", "proportional-lining", "tabular-oldstyle"]);
		const options = {
			destinationFolder: "assets/figure-style-text-layers",
			textRenders: [{ layerIndex: 0, fontPath: "assets/Zvibe-Figure-Style.ttf", useAuthoredStyleRuns: true }],
		};
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const plan = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 });
		const appliedText = plan.items[0].appliedTextRenders[0];
		expect(appliedText.shapedGlyphs.map((glyph) => glyph.glyphId)).toEqual([2, 4, 5, 3, 7]);
		expect(
			appliedText.styleRuns.map((run) => ["lnum", "onum", "pnum", "tnum"].map((tag) => run.effectiveOpenTypeFeatures.find((feature) => feature.tag === tag)?.value))
		).toEqual([
			[0, 0, 0, 0],
			[1, 0, 0, 1],
			[0, 1, 1, 0],
			[1, 0, 1, 0],
			[0, 1, 0, 1],
		]);
		expect(
			appliedText.styleRuns.every(
				(run) =>
					run.figureStyleExecutionModel === "bounded-authored-figure-style-v1" &&
					run.figureStyleLiningFeatureSupported &&
					run.figureStyleOldStyleFeatureSupported &&
					run.figureStyleProportionalFeatureSupported &&
					run.figureStyleTabularFeatureSupported
			)
		).toBe(true);
		const applied = await extractPsdLayers(scene, { path: "assets/hero.psd", ...options, expectedFingerprint: plan.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => undefined } } },
		} as never);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			extractPsdLayers(scene, { path: "assets/hero.psd", ...options, destinationFolder: "assets/figure-style-stale", expectedFingerprint: plan.fingerprint, confirm: true }, {
				editor: { layout: { assets: { refresh: () => undefined } } },
			} as never)
		).rejects.toThrow("plan changed");
		scene.dispose();
		engine.dispose();

		const malformedLayer = layer({
			name: "Malformed Figure Style",
			id: 5111,
			left: 0,
			top: 0,
			width: 320,
			height: 110,
			visible: true,
			opacity: 255,
			rgba: new Array(320 * 110 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("0", { fonts: ["Zvibe Figure Style Test"], styles: [{ ...baseStyle, figureStyle: 1.5 }] }))],
		});
		await writeFile(source, createLayeredPsd([malformedLayer], { width: 320, height: 110 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.engineDataWarning).toContain("FigureStyle is not an integer");

		const unsupportedLayer = layer({
			name: "Unsupported Figure Style",
			id: 5112,
			left: 0,
			top: 0,
			width: 320,
			height: 110,
			visible: true,
			opacity: 255,
			rgba: new Array(320 * 110 * 4).fill(0),
			additionalInfo: [additional("TySh", tyshText("0", { fonts: ["Zvibe Figure Style Test"], styles: [{ ...baseStyle, figureStyle: 5 }] }))],
		});
		await writeFile(source, createLayeredPsd([unsupportedLayer], { width: 320, height: 110 }));
		expect(inspectPsdLayers(await readFile(source)).layers[0].text?.styleRuns[0].figureStyle).toBe("unknown");
		const unsupportedEngine = new NullEngine();
		const unsupportedScene = new Scene(unsupportedEngine);
		await expect(inspectPsdLayerExtraction(unsupportedScene, { path: "assets/hero.psd", ...options, offset: 0, limit: 10 })).rejects.toThrow("unsupported FigureStyle");
		unsupportedScene.dispose();
		unsupportedEngine.dispose();
	});

	test("rerasterizes vertical TySh text as top-to-bottom HarfBuzz columns", async () => {
		const fontPath = join(directory, "assets", "Geist-Regular.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Vertical HUD",
						id: 4870,
						left: 5,
						top: 7,
						width: 140,
						height: 220,
						visible: true,
						opacity: 255,
						rgba: new Array(140 * 220 * 4).fill(0),
						additionalInfo: [additional("TySh", tyshText("VERT\nTEXT", { orientation: "Vrtc", fonts: ["Geist Regular"] }))],
					}),
				],
				{ width: 160, height: 240 }
			)
		);
		const options = {
			destinationFolder: "assets/vertical-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					text: "VERT\nTEXT",
					fontPath: "assets/Geist-Regular.ttf",
					fontSize: 34,
					lineHeight: 42,
					tracking: 20,
					justification: "left" as const,
					offsetX: 2,
					offsetY: 3,
					color: [245, 90, 30, 255] as [number, number, number, number],
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(plan.items[0].textLayer).toMatchObject({ orientation: "vertical", rasterExecutionModel: "bounded-project-font-harfbuzz-vertical-text-raster-v1" });
		expect(evidence).toMatchObject({
			orientation: "vertical",
			executionModel: "bounded-project-font-harfbuzz-vertical-text-raster-v1",
			lineCount: 2,
			glyphCount: 8,
			lineHeight: 42,
			shaping: { engine: "harfbuzz", version: "14.2.1", direction: "ltr" },
		});
		expect(evidence.shapedGlyphs).toHaveLength(8);
		expect(evidence.shapedGlyphs.every((glyph) => glyph.xAdvance === 0 && glyph.yAdvance < 0)).toBe(true);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const decoded = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect([decoded.info.width, decoded.info.height]).toEqual([140, 220]);
		expect([...decoded.data].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, textRenders: [{ ...options.textRenders[0], lineHeight: 43 }] }, plan.fingerprint)).rejects.toThrow(
			"plan changed"
		);
	});

	test("rerasterizes mixed-direction TySh paragraphs through exact UAX #9 visual runs", async () => {
		const fontPath = join(directory, "assets", "Amiri-Regular.ttf");
		await copyFile(join(repositoryDirectory, "editor/test/fixtures/fonts/Amiri-Regular.ttf"), fontPath);
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Mixed BiDi HUD",
						id: 4840,
						left: 2,
						top: 3,
						width: 320,
						height: 80,
						visible: true,
						opacity: 255,
						rgba: new Array(320 * 80 * 4).fill(0),
						additionalInfo: [additional("TySh", tyshText("ABC سلام 123 DEF"))],
					}),
				],
				{ width: 330, height: 90 }
			)
		);
		const options = {
			destinationFolder: "assets/mixed-bidi-text-layers",
			textRenders: [
				{
					layerIndex: 0,
					fontPath: "assets/Amiri-Regular.ttf",
					fontSize: 42,
					color: [245, 220, 60, 255] as [number, number, number, number],
					shaping: { direction: "ltr" as const, language: "ar", bidirectional: true },
				},
			],
		};
		const plan = await getPsdLayerExtractionStatus(source, options);
		const evidence = plan.items[0].appliedTextRenders[0];
		expect(plan.items[0].textLayer?.rasterExecutionModel).toBe("bounded-project-font-harfbuzz-bidi-text-raster-v1");
		expect(evidence).toMatchObject({
			executionModel: "bounded-project-font-harfbuzz-bidi-text-raster-v1",
			shaping: {
				bidirectional: {
					engine: "bidi-js",
					version: "1.0.3",
					unicodeVersion: "13.0.0",
					executionModel: "bounded-uax9-bidi-runs-v1",
					baseDirection: "ltr",
					paragraphCount: 1,
					codePointCount: 16,
					controlCount: 0,
					mirroredCharacterCount: 0,
				},
			},
		});
		expect(evidence.shaping!.bidirectional!.visualRuns.map((run) => [run.logicalStart, run.logicalLength, run.embeddingLevel, run.direction])).toEqual([
			[0, 4, 0, "ltr"],
			[9, 3, 2, "ltr"],
			[4, 5, 1, "rtl"],
			[12, 4, 0, "ltr"],
		]);
		const applied = await applyPsdLayerExtraction(source, options, plan.fingerprint);
		const pixels = await sharp(join(directory, applied.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels].some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		expect((await getPsdLayerExtractionStatus(source, options)).reusedCount).toBe(1);
		await expect(
			applyPsdLayerExtraction(
				source,
				{ ...options, textRenders: [{ ...options.textRenders[0], shaping: { ...options.textRenders[0].shaping, direction: "rtl" as const } }] },
				plan.fingerprint
			)
		).rejects.toThrow("plan changed");
	});

	test("rejects unsafe or unsupported project-font text rerasterization without approximation", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Editable",
					id: 950,
					left: 0,
					top: 0,
					width: 32,
					height: 32,
					visible: true,
					opacity: 255,
					rgba: Array.from({ length: 32 * 32 }, () => [0, 0, 0, 0]).flat(),
					additionalInfo: [additional("TySh", tyshText("Text"))],
				}),
				layer({ name: "Ordinary Pixel", id: 951, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [1, 2, 3, 255] }),
			])
		);
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [{ layerIndex: 0, text: "No", fontPath: "../outside.ttf" }] })).rejects.toThrow("must stay inside");
		await copyFile(join(repositoryDirectory, "editor/fonts/Inter-Regular.woff2"), join(directory, "assets", "Inter-Regular.woff2"));
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [{ layerIndex: 0, text: "No", fontPath: "assets/Inter-Regular.woff2" }] })).rejects.toThrow(
			"TTF, OTF, or WOFF"
		);
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [{ layerIndex: 1, text: "No", fontPath: "assets/Inter-Regular.woff2" }] })).rejects.toThrow(
			"not an extractable TySh text layer"
		);
		const fontPath = join(directory, "assets", "Geist-Reject.ttf");
		await copyFile(join(repositoryDirectory, "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"), fontPath);
		const fontPathRequest = "assets/Geist-Reject.ttf";
		await expect(
			getPsdLayerExtractionStatus(source, {
				textRenders: [{ layerIndex: 0, fontPath: fontPathRequest, styleRunFontBindings: [{ fontIndex: 0, fontPath: fontPathRequest }] }],
			})
		).rejects.toThrow("styleRunFontBindings require useAuthoredStyleRuns=true");
		await expect(
			getPsdLayerExtractionStatus(source, { textRenders: [{ layerIndex: 0, text: "Text", fontPath: fontPathRequest, useAuthoredStyleRuns: true }] })
		).rejects.toThrow("require omitting replacement text");
		await expect(
			getPsdLayerExtractionStatus(source, {
				textRenders: [
					{
						layerIndex: 0,
						fontPath: fontPathRequest,
						useAuthoredStyleRuns: true,
						styleRunFontBindings: [
							{ fontIndex: 0, fontPath: fontPathRequest },
							{ fontIndex: 0, fontPath: fontPathRequest },
						],
					},
				],
			})
		).rejects.toThrow("duplicate fontIndex 0");

		const style = (length: number) => ({
			length,
			fontIndex: 0,
			fontSize: 18,
			fauxBold: false,
			fauxItalic: false,
			tracking: 0,
			color: [255, 255, 255, 255] as [number, number, number, number],
		});
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "False terminator",
					id: 954,
					left: 0,
					top: 0,
					width: 32,
					height: 32,
					visible: true,
					opacity: 255,
					rgba: new Array(32 * 32 * 4).fill(0),
					additionalInfo: [additional("TySh", tyshText("Text", { fonts: ["Geist"], styles: [style(5)] }))],
				}),
			])
		);
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [{ layerIndex: 0, fontPath: fontPathRequest, useAuthoredStyleRuns: true }] })).rejects.toThrow(
			"invalid UTF-16 length"
		);
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Incomplete runs",
					id: 952,
					left: 0,
					top: 0,
					width: 32,
					height: 32,
					visible: true,
					opacity: 255,
					rgba: new Array(32 * 32 * 4).fill(0),
					additionalInfo: [additional("TySh", tyshText("Text", { fonts: ["Geist"], styles: [style(3)] }))],
				}),
			])
		);
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [{ layerIndex: 0, fontPath: fontPathRequest, useAuthoredStyleRuns: true }] })).rejects.toThrow(
			"cover 3 of 4 UTF-16 code units"
		);
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Split surrogate",
					id: 953,
					left: 0,
					top: 0,
					width: 32,
					height: 32,
					visible: true,
					opacity: 255,
					rgba: new Array(32 * 32 * 4).fill(0),
					additionalInfo: [additional("TySh", tyshText("A😀B", { fonts: ["Geist"], styles: [style(2), style(2)] }))],
				}),
			])
		);
		await expect(getPsdLayerExtractionStatus(source, { textRenders: [{ layerIndex: 0, fontPath: fontPathRequest, useAuthoredStyleRuns: true }] })).rejects.toThrow(
			"splits a Unicode surrogate pair"
		);
	});

	test("plans and publishes primary plus real-user masks with independent bounds and exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Primary Plus Real User Mask",
						id: 447,
						left: 7,
						top: 4,
						width: 3,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [10, 40, 70, 200, 20, 50, 80, 200, 30, 60, 90, 200],
						mask: {
							top: 4,
							left: 7,
							width: 3,
							height: 1,
							plane: [255, 128, 255],
							realUserMask: { top: 4, left: 8, width: 1, height: 1, plane: [64] },
						},
					}),
				],
				{ width: 12, height: 8 }
			)
		);
		const options = { destinationFolder: "assets/real-user-mask" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0]).toMatchObject({
			left: 7,
			top: 4,
			width: 3,
			height: 1,
			warnings: [],
			appliedMasks: [
				{ type: "primary", channelId: -2, left: 7, top: 4, width: 3, height: 1, defaultColor: 255, inverted: false, positionRelativeToLayer: false },
				{ type: "realUser", channelId: -3, left: 8, top: 4, width: 1, height: 1, defaultColor: 255, inverted: false, positionRelativeToLayer: false },
			],
		});
		expect(planned.document.layers[0]).toMatchObject({
			mask: {
				left: 7,
				top: 4,
				width: 3,
				height: 1,
				realUserMask: { channelId: -3, left: 8, top: 4, width: 1, height: 1, defaultColor: 255, disabled: false, inverted: false },
			},
			channels: expect.arrayContaining([expect.objectContaining({ id: -3, width: 1, height: 1, compression: "raw" })]),
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([10, 40, 70, 200, 20, 50, 80, 25, 30, 60, 90, 200]);
	});

	test("plans and publishes bounded vector-mask paths with density, feather, and exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Feathered Vector Mask",
						id: 448,
						left: 0,
						top: 0,
						width: 4,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [10, 50, 90, 200, 20, 60, 100, 200, 30, 70, 110, 200, 40, 80, 120, 200],
						mask: { top: 0, left: 0, width: 4, height: 1, plane: [255, 255, 255, 255], vectorDensity: 128, vectorFeather: 1 },
						additionalInfo: [additional("vmsk", vectorMaskRectangle(0.25, 0, 0.75, 1))],
					}),
				],
				{ width: 4, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/vector-mask" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0]).toMatchObject({
			mask: { vectorDensity: 128, vectorFeather: 1 },
			vectorMask: {
				sourceKey: "vmsk",
				version: 3,
				initialFill: 0,
				fillRule: "evenOdd",
				knotCount: 4,
				executionModel: "bounded-vector-mask-v1",
				bakeSupported: true,
			},
		});
		expect(planned.items[0]).toMatchObject({
			warnings: [],
			appliedMasks: [
				{ type: "primary", channelId: -2, density: null, feather: null, executionModel: "bounded-mask-parameters-v1" },
				{
					type: "vector",
					sourceKey: "vmsk",
					initialFill: 0,
					fillRule: "evenOdd",
					subpathCount: 1,
					knotCount: 4,
					density: 128,
					feather: 1,
					executionModel: "bounded-vector-mask-v1",
				},
			],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([10, 50, 90, 133, 20, 60, 100, 166, 30, 70, 110, 166, 40, 80, 120, 133]);
	});

	test("applies bounded core adjustments in stack order and only propagates them through pass-through groups", async () => {
		const adjustmentLayer = (name: string, id: number, key: string, data: Buffer) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional(key, data)],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					adjustmentLayer("Threshold 128", 4490, "thrs", u16(128)),
					adjustmentLayer("Posterize 4", 4491, "post", u16(4)),
					adjustmentLayer("Invert", 4492, "nvrt", Buffer.alloc(0)),
					adjustmentLayer("Levels Invert", 4493, "levl", levelsAdjustment(levelsRecord(0, 255, 255, 0, 100))),
					adjustmentLayer("Brightness +10", 4494, "brit", Buffer.concat([i16(10), i16(0), i16(127), Buffer.from([0])])),
					layer({
						name: "Base Pixels",
						id: 4495,
						left: 0,
						top: 0,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [10, 20, 30, 255, 200, 150, 100, 128],
					}),
				],
				{ width: 2, height: 1 }
			)
		);

		const options = { destinationFolder: "assets/core-adjustments", applyAdjustments: true };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned).toMatchObject({ applyAdjustments: true, selectedLayerCount: 1, createdCount: 1, conflictCount: 0 });
		expect(planned.document.layers.map((entry) => entry.kind)).toEqual(["adjustment", "adjustment", "adjustment", "adjustment", "adjustment", "pixel"]);
		expect(planned.document.layers.slice(0, 5).map((entry) => entry.adjustment?.key)).toEqual(["thrs", "post", "nvrt", "levl", "brit"]);
		expect(planned.items[0]).toMatchObject({
			warnings: [],
			appliedAdjustments: [
				{ layerIndex: 4, layerId: 4494, name: "Brightness +10", key: "brit", opacity: 255, clipping: false, executionModel: "bounded-adjustment-v1" },
				{ layerIndex: 3, layerId: 4493, name: "Levels Invert", key: "levl", opacity: 255, clipping: false, executionModel: "bounded-adjustment-v1" },
				{ layerIndex: 2, layerId: 4492, name: "Invert", key: "nvrt", opacity: 255, clipping: false, executionModel: "bounded-adjustment-v1" },
				{ layerIndex: 1, layerId: 4491, name: "Posterize 4", key: "post", opacity: 255, clipping: false, executionModel: "bounded-adjustment-v1" },
				{ layerIndex: 0, layerId: 4490, name: "Threshold 128", key: "thrs", opacity: 255, clipping: false, executionModel: "bounded-adjustment-v1" },
			],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([0, 0, 0, 255, 255, 255, 255, 128]);

		const optOutOptions = { destinationFolder: "assets/no-adjustments", applyAdjustments: false };
		const optOut = await getPsdLayerExtractionStatus(source, optOutOptions);
		expect(optOut).toMatchObject({ applyAdjustments: false, selectedLayerCount: 1, items: [{ appliedAdjustments: [] }] });
		expect(optOut.items[0].warnings.filter((warning) => warning.includes("adjustment compositing is disabled"))).toHaveLength(5);
		await applyPsdLayerExtraction(source, optOutOptions, optOut.fingerprint);
		const originalPixels = await sharp(join(directory, optOut.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...originalPixels]).toEqual([10, 20, 30, 255, 200, 150, 100, 128]);

		await writeFile(
			source,
			createLayeredPsd(
				[
					adjustmentLayer("Root Invert", 4496, "nvrt", Buffer.alloc(0)),
					layer({
						name: "Group End",
						id: 4497,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(3))],
					}),
					layer({ name: "Grouped Pixel", id: 4498, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
					layer({
						name: "Group",
						id: 4499,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(1, "norm"))],
					}),
				],
				{ width: 1, height: 1 }
			)
		);
		const groupScoped = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/group-scoped-adjustment" });
		expect(groupScoped.items[0].appliedAdjustments).toEqual([]);
		expect(groupScoped.items[0].warnings).toContain(
			"Adjustment layer Root Invert (nvrt) crosses a PSD group boundary; bounded isolated-layer extraction preserves it as evidence instead of applying it to the wrong scope."
		);

		await writeFile(
			source,
			createLayeredPsd(
				[
					adjustmentLayer("Root Invert", 4500, "nvrt", Buffer.alloc(0)),
					layer({
						name: "Outer Group End",
						id: 4501,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(3))],
					}),
					layer({
						name: "Inner Group End",
						id: 4502,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(3))],
					}),
					layer({ name: "Grouped Pixel", id: 4503, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
					layer({
						name: "Inner Pass Through Group",
						id: 4504,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(1, "pass"))],
					}),
					layer({
						name: "Outer Pass Through Group",
						id: 4505,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(1, "pass"))],
					}),
				],
				{ width: 1, height: 1 }
			)
		);
		const passThroughOptions = { destinationFolder: "assets/pass-through-group-adjustment" };
		const passThrough = await getPsdLayerExtractionStatus(source, passThroughOptions);
		expect(passThrough.groupComposites).toHaveLength(2);
		expect(passThrough.groupComposites).toMatchObject([
			{
				groupStartIndex: 4,
				executionModel: "bounded-pass-through-flatten-v1",
				supported: true,
				passThroughGroupIndices: [4],
				warnings: [],
			},
			{
				groupStartIndex: 5,
				executionModel: "bounded-pass-through-flatten-v1",
				supported: true,
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
				warnings: [],
			},
		]);
		expect(passThrough.items[0]).toMatchObject({
			warnings: [],
			appliedAdjustments: [
				{
					layerIndex: 0,
					layerId: 4500,
					key: "nvrt",
					groupExecutionModel: "bounded-pass-through-groups-v1",
					crossedGroupIndices: [5, 4],
				},
			],
		});
		await applyPsdLayerExtraction(source, passThroughOptions, passThrough.fingerprint);
		const passThroughPixels = await sharp(join(directory, passThrough.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...passThroughPixels]).toEqual([245, 235, 225, 255]);

		const flattenOptions = { destinationFolder: "assets/pass-through-group-flatten", compositeGroups: true, layerIndices: [5] };
		const flattened = await getPsdLayerExtractionStatus(source, flattenOptions);
		expect(flattened.items).toMatchObject([
			{
				layerIndex: 5,
				warnings: [],
				groupComposite: {
					executionModel: "bounded-pass-through-flatten-v1",
					groupStartIndex: 5,
					groupEndIndex: 1,
					childLayerIndices: [4],
					childLayerNames: ["Inner Pass Through Group"],
					nestedGroupIndices: [4],
					passThroughGroupIndices: [5, 4],
					maximumDepth: 2,
				},
				appliedAdjustments: [{ layerIndex: 0, key: "nvrt" }],
			},
		]);
		await applyPsdLayerExtraction(source, flattenOptions, flattened.fingerprint);
		const flattenedPixels = await sharp(join(directory, flattened.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...flattenedPixels]).toEqual([245, 235, 225, 255]);
	});

	test("flattens a nested backdrop-independent pass-through group inside an isolated parent", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, blendMode = "norm") =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? blendMode : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 4780, 3),
					groupBoundary("Pass End", 4781, 3),
					layer({ name: "Pass White", id: 4782, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 255, 255, 128] }),
					groupBoundary("Nested Pass", 4783, 1, "pass"),
					layer({ name: "Outer Black", id: 4784, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 0, 0, 255] }),
					groupBoundary("Outer Isolated", 4785, 1),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/nested-pass-through", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{ groupStartIndex: 3, executionModel: "bounded-pass-through-flatten-v1", supported: true, passThroughGroupIndices: [3] },
			{
				groupStartIndex: 5,
				executionModel: "bounded-nested-isolated-group-v1",
				supported: true,
				nestedGroupIndices: [3],
				passThroughGroupIndices: [3],
			},
		]);
		expect(planned.items[0].groupComposite).toMatchObject({
			executionModel: "bounded-nested-isolated-group-v1",
			nestedGroupIndices: [3],
			passThroughGroupIndices: [3],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([128, 128, 128, 255]);
	});

	test("executes reduced pass-through group opacity against the bounded document backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 4786, 3),
					layer({ name: "Orange Child", id: 4787, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 100, 0, 255] }),
					groupBoundary("Half Pass", 4788, 1, 128),
					layer({ name: "Blue Backdrop", id: 4789, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-opacity", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-opacity-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [3],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0].groupComposite).toMatchObject({
			executionModel: "bounded-backdrop-pass-through-opacity-v1",
			groupOpacity: 128,
			backdropLayerIndices: [3],
			backdropIncluded: true,
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([110, 70, 30, 255]);
	});

	test("executes a pass-through group mask as per-pixel backdrop interpolation", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: type === 1 ? { top: 0, left: 0, width: 1, height: 1, plane: [128], defaultColor: 255 } : undefined,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47890, 3),
					layer({ name: "Orange Child", id: 47891, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 100, 0, 255] }),
					groupBoundary("Masked Half Pass", 47892, 1, 128),
					layer({ name: "Blue Backdrop", id: 47893, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-mask", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-mask-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [3],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			groupComposite: {
				executionModel: "bounded-backdrop-pass-through-mask-v1",
				groupOpacity: 128,
				backdropLayerIndices: [3],
				backdropIncluded: true,
			},
			appliedGroupMasks: [
				{
					executionModel: "bounded-backdrop-pass-through-mask-v1",
					application: "backdrop-interpolation",
					maskCoverageMinimum: 128,
					maskCoverageMaximum: 128,
				},
			],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([65, 55, 45, 255]);
	});

	test("executes pass-through group effects against the bounded document backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(type === 1 ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47894, 3),
					layer({ name: "Child", id: 47895, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
					groupBoundary("Styled Half Pass", 47896, 1, 128),
					layer({ name: "Backdrop", id: 47897, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-effects", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-effects-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [3],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedLayerEffects: [{ layerIndex: 2, layerName: "Styled Half Pass", key: "sofi", type: "solidFill", opacity: 128 }],
			groupComposite: {
				executionModel: "bounded-backdrop-pass-through-effects-v1",
				groupOpacity: 128,
				backdropLayerIndices: [3],
				backdropIncluded: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([60, 33, 33, 255]);

		const raw = await getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-effects-disabled", applyLayerEffects: false });
		expect(raw.groupComposites).toMatchObject([{ groupStartIndex: 2, executionModel: "bounded-backdrop-pass-through-opacity-v1", supported: true }]);
		expect(raw.items[0]).toMatchObject({ appliedLayerEffects: [], warnings: [expect.stringContaining("Layer effect sofi #2")] });
	});

	test("combines pass-through group effects with per-pixel backdrop mask interpolation", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: type === 1 ? { top: 0, left: 0, width: 1, height: 1, plane: [128], defaultColor: 255 } : undefined,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(type === 1 ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47903, 3),
					layer({ name: "Child", id: 47904, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
					groupBoundary("Masked Styled Half Pass", 47905, 1, 128),
					layer({ name: "Backdrop", id: 47906, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-mask-effects", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-mask-effects-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [3],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedLayerEffects: [{ layerIndex: 2, key: "sofi", type: "solidFill", opacity: 128 }],
			appliedGroupMasks: [
				{
					executionModel: "bounded-backdrop-pass-through-mask-effects-v1",
					application: "backdrop-interpolation",
					maskCoverageMinimum: 128,
					maskCoverageMaximum: 128,
				},
			],
			groupComposite: { executionModel: "bounded-backdrop-pass-through-mask-effects-v1" },
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([35, 26, 31, 255]);

		const raw = await getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-mask-effects-disabled", applyLayerEffects: false });
		expect(raw.groupComposites).toMatchObject([{ groupStartIndex: 2, executionModel: "bounded-backdrop-pass-through-mask-v1", supported: true }]);
		expect(raw.items[0]).toMatchObject({ appliedLayerEffects: [], appliedGroupMasks: [{ executionModel: "bounded-backdrop-pass-through-mask-v1" }] });
	});

	test("executes free pass-through adjustments after initializing the authored stack with the backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47898, 3),
					layer({
						name: "Free Invert",
						id: 47899,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Half Child", id: 47900, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [100, 50, 0, 128] }),
					groupBoundary("Adjusted Half Pass", 47901, 1, 128),
					layer({ name: "Backdrop", id: 47902, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-adjustments", compositeGroups: true, layerIndices: [3] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 3,
				executionModel: "bounded-backdrop-pass-through-adjustments-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [4],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedAdjustments: [{ layerIndex: 1, name: "Free Invert", key: "nvrt", clipping: false, executionModel: "bounded-adjustment-v1" }],
			groupComposite: {
				executionModel: "bounded-backdrop-pass-through-adjustments-v1",
				groupOpacity: 128,
				backdropLayerIndices: [4],
				backdropIncluded: true,
				childLayerIndices: [2, 1],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([105, 120, 135, 255]);

		const raw = await getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-adjustments-disabled", applyAdjustments: false });
		expect(raw.groupComposites).toMatchObject([{ groupStartIndex: 3, executionModel: "bounded-backdrop-pass-through-opacity-v1", supported: true }]);
		expect(raw.items[0]).toMatchObject({ appliedAdjustments: [], warnings: [expect.stringContaining("was not applied because adjustment compositing is disabled")] });
	});

	test("executes non-normal pass-through child and backdrop blend stacks against the exact backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47907, 3),
					layer({
						name: "Multiply Child",
						id: 47908,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						blendMode: "mul ",
						rgba: [200, 100, 50, 255],
					}),
					groupBoundary("Blended Half Pass", 47909, 1, 128),
					layer({ name: "Screen Backdrop", id: 47910, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47911, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-blends", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-blends-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [3, 4],
				backdropBlendModes: ["scrn", "norm"],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			blendModes: ["mul "],
			groupComposite: {
				executionModel: "bounded-backdrop-pass-through-blends-v1",
				backdropLayerIndices: [3, 4],
				backdropBlendModes: ["scrn", "norm"],
				blendModes: ["mul "],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([100, 57, 36, 255]);
	});

	test("executes nested pass-through group opacity against each authored parent canvas", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 47912, 3),
					groupBoundary("Inner End", 47913, 3),
					layer({ name: "Inner Child", id: 47914, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 100, 200, 255] }),
					groupBoundary("Inner Half Pass", 47915, 1, 128),
					layer({ name: "Outer Lower Child", id: 47916, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [100, 50, 0, 255] }),
					groupBoundary("Outer Half Pass", 47917, 1, 128),
					layer({ name: "Document Backdrop", id: 47918, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 3,
				executionModel: "bounded-nested-backdrop-pass-through-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
				backdropIncluded: false,
			},
			{
				groupStartIndex: 5,
				executionModel: "bounded-nested-backdrop-pass-through-v1",
				supported: true,
				requiresParentBackdrop: false,
				groupOpacity: 128,
				backdropLayerIndices: [6],
				backdropBlendModes: ["norm"],
				backdropIncluded: true,
				nestedGroupIndices: [3],
				passThroughGroupIndices: [5, 3],
				maximumDepth: 2,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-v1",
				backdropLayerIndices: [6],
				backdropBlendModes: ["norm"],
				nestedGroupIndices: [3],
				passThroughGroupIndices: [5, 3],
				maximumDepth: 2,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([35, 58, 80, 255]);

		await expect(getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-nested-child", layerIndices: [3] })).rejects.toThrow(
			"Requested PSD layer(s) 3 are hidden or cannot be extracted"
		);
	});

	test("executes nested pass-through non-normal child and backdrop blends against each authored parent canvas", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 47960, 3),
					groupBoundary("Inner End", 47961, 3),
					layer({ name: "Inner Multiply", id: 47962, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Blended Half Pass", 47963, 1, 128),
					groupBoundary("Outer Blended Half Pass", 47964, 1, 128),
					layer({ name: "Screen Backdrop", id: 47965, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47966, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-blends", compositeGroups: true, layerIndices: [4] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 3,
				executionModel: "bounded-nested-backdrop-pass-through-blends-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
				backdropIncluded: false,
			},
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-blends-v1",
				supported: true,
				requiresParentBackdrop: false,
				groupOpacity: 128,
				backdropLayerIndices: [5, 6],
				backdropBlendModes: ["scrn", "norm"],
				backdropIncluded: true,
				nestedGroupIndices: [3],
				passThroughGroupIndices: [4, 3],
				maximumDepth: 2,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			blendModes: ["pass"],
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-blends-v1",
				backdropLayerIndices: [5, 6],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [3],
				passThroughGroupIndices: [4, 3],
				maximumDepth: 2,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([106, 69, 48, 255]);

		await expect(getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-nested-blend-child", layerIndices: [3] })).rejects.toThrow(
			"Requested PSD layer(s) 3 are hidden or cannot be extracted"
		);
	});

	test("modulates each masked nested pass-through boundary against its exact authored parent canvas", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, masked = false) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: masked ? { top: 0, left: 0, width: 1, height: 1, plane: [128], defaultColor: 255 } : undefined,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 47967, 3),
					groupBoundary("Inner End", 47968, 3),
					layer({ name: "Inner Multiply", id: 47969, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Masked Half Pass", 47970, 1, 128, true),
					groupBoundary("Outer Half Pass", 47971, 1, 128),
					layer({ name: "Screen Backdrop", id: 47972, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47973, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-mask", compositeGroups: true, layerIndices: [4] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 3,
				executionModel: "bounded-nested-backdrop-pass-through-mask-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
			},
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-mask-v1",
				supported: true,
				backdropLayerIndices: [5, 6],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [3],
				passThroughGroupIndices: [4, 3],
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedGroupMasks: [
				{
					groupIndex: 3,
					executionModel: "bounded-nested-backdrop-pass-through-mask-v1",
					application: "backdrop-interpolation",
					maskCoverageMinimum: 128,
					maskCoverageMaximum: 128,
				},
			],
			groupComposite: { executionModel: "bounded-nested-backdrop-pass-through-mask-v1" },
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([109, 75, 54, 255]);
	});

	test("bakes nested pass-through effects from an independent group shape over each exact parent canvas", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, styled = false) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(styled ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 47974, 3),
					groupBoundary("Inner End", 47975, 3),
					layer({ name: "Inner Multiply", id: 47976, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Styled Half Pass", 47977, 1, 128, true),
					groupBoundary("Outer Half Pass", 47978, 1, 128),
					layer({ name: "Screen Backdrop", id: 47979, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47980, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-effects", compositeGroups: true, layerIndices: [4] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 3,
				executionModel: "bounded-nested-backdrop-pass-through-effects-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
			},
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-effects-v1",
				supported: true,
				backdropLayerIndices: [5, 6],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [3],
				passThroughGroupIndices: [4, 3],
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedLayerEffects: [{ layerIndex: 3, key: "sofi", type: "solidFill", opacity: 128 }],
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-effects-v1",
				backdropLayerIndices: [5, 6],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [3],
				passThroughGroupIndices: [4, 3],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([120, 71, 47, 255]);

		const raw = await getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-nested-backdrop-effects-disabled", applyLayerEffects: false });
		expect(raw.groupComposites).toMatchObject([
			{ groupStartIndex: 3, executionModel: "bounded-nested-backdrop-pass-through-blends-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-blends-v1", supported: true },
		]);
		expect(raw.items[0].appliedLayerEffects).toEqual([]);

		const behindBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, styled = false) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(styled ? [additional("lrFX", legacyDropShadowEffect({ color: [0, 0, 0], blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					behindBoundary("Outer End", 47981, 3),
					behindBoundary("Inner End", 47982, 3),
					layer({ name: "Inner Multiply", id: 47983, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					behindBoundary("Inner Shadow Half Pass", 47984, 1, 128, true),
					behindBoundary("Outer Half Pass", 47985, 1, 128),
					layer({ name: "Backdrop", id: 47986, left: 0, top: 0, width: 2, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255, 20, 40, 60, 255] }),
				],
				{ width: 2, height: 1 }
			)
		);
		const behindOptions = { destinationFolder: "assets/pass-through-nested-backdrop-behind-effects", compositeGroups: true, layerIndices: [4] };
		const behind = await getPsdLayerExtractionStatus(source, behindOptions);
		expect(behind.groupComposites).toMatchObject([
			{ groupStartIndex: 3, executionModel: "bounded-nested-backdrop-pass-through-effects-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-effects-v1", supported: true },
		]);
		expect(behind.items[0]).toMatchObject({
			appliedLayerEffects: [{ layerIndex: 3, key: "dsdw", type: "dropShadow", opacity: 100 }],
			groupComposite: { executionModel: "bounded-nested-backdrop-pass-through-effects-v1", passThroughGroupIndices: [4, 3] },
		});
		await applyPsdLayerExtraction(source, behindOptions, behind.fingerprint);
		const behindPixels = await sharp(join(directory, behind.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...behindPixels]).toEqual([19, 34, 48, 255, 15, 30, 45, 255]);
	});

	test("combines nested pass-through masks and group effects at their exact parent-canvas boundaries", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, maskedAndStyled = false) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: maskedAndStyled ? { top: 0, left: 0, width: 1, height: 1, plane: [128], defaultColor: 255 } : undefined,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(maskedAndStyled ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 47995, 3),
					groupBoundary("Inner End", 47996, 3),
					layer({ name: "Inner Multiply", id: 47997, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Masked Styled Half Pass", 47998, 1, 128, true),
					groupBoundary("Outer Half Pass", 47999, 1, 128),
					layer({ name: "Screen Backdrop", id: 48000, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 48001, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-mask-effects", compositeGroups: true, layerIndices: [4] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 3,
				executionModel: "bounded-nested-backdrop-pass-through-mask-effects-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
			},
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-mask-effects-v1",
				supported: true,
				backdropLayerIndices: [5, 6],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [3],
				passThroughGroupIndices: [4, 3],
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedGroupMasks: [
				{
					groupIndex: 3,
					executionModel: "bounded-nested-backdrop-pass-through-mask-effects-v1",
					application: "backdrop-interpolation",
					maskCoverageMinimum: 128,
					maskCoverageMaximum: 128,
				},
			],
			appliedLayerEffects: [{ layerIndex: 3, key: "sofi", type: "solidFill", opacity: 128 }],
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-mask-effects-v1",
				backdropLayerIndices: [5, 6],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [3],
				passThroughGroupIndices: [4, 3],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([116, 77, 54, 255]);

		const effectsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/pass-through-nested-backdrop-mask-effects-disabled",
			applyLayerEffects: false,
		});
		expect(effectsDisabled.groupComposites).toMatchObject([
			{ groupStartIndex: 3, executionModel: "bounded-nested-backdrop-pass-through-mask-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-mask-v1", supported: true },
		]);
		expect(effectsDisabled.items[0].appliedLayerEffects).toEqual([]);
		expect(effectsDisabled.items[0].appliedGroupMasks).toMatchObject([{ groupIndex: 3, application: "backdrop-interpolation" }]);
	});

	test("combines nested pass-through masks and free adjustments at their exact parent-canvas boundaries", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, masked = false) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: masked ? { top: 0, left: 0, width: 1, height: 1, plane: [128], defaultColor: 255 } : undefined,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 48002, 3),
					groupBoundary("Inner End", 48003, 3),
					layer({
						name: "Inner Free Invert",
						id: 48004,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Inner Multiply", id: 48005, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Masked Adjusted Half Pass", 48006, 1, 128, true),
					groupBoundary("Outer Half Pass", 48007, 1, 128),
					layer({ name: "Screen Backdrop", id: 48008, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 48009, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-mask-adjustments", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-mask-adjustments-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
			},
			{
				groupStartIndex: 5,
				executionModel: "bounded-nested-backdrop-pass-through-mask-adjustments-v1",
				supported: true,
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedGroupMasks: [
				{
					groupIndex: 4,
					executionModel: "bounded-nested-backdrop-pass-through-mask-adjustments-v1",
					application: "backdrop-interpolation",
					maskCoverageMinimum: 128,
					maskCoverageMaximum: 128,
				},
			],
			appliedAdjustments: [{ layerIndex: 2, key: "nvrt", clipping: false, executionModel: "bounded-adjustment-v1" }],
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-mask-adjustments-v1",
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([119, 100, 83, 255]);

		const adjustmentsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/pass-through-nested-backdrop-mask-adjustments-disabled",
			applyAdjustments: false,
		});
		expect(adjustmentsDisabled.groupComposites).toMatchObject([
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-mask-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 5, executionModel: "bounded-nested-backdrop-pass-through-mask-v1", supported: true },
		]);
		expect(adjustmentsDisabled.items[0].appliedAdjustments).toEqual([]);
		expect(adjustmentsDisabled.items[0].appliedGroupMasks).toMatchObject([{ groupIndex: 4, application: "backdrop-interpolation" }]);
	});

	test("combines nested pass-through group effects and free adjustments in exact authored phase order", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, styled = false) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(styled ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 48010, 3),
					groupBoundary("Inner End", 48011, 3),
					layer({
						name: "Inner Free Invert",
						id: 48012,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Inner Multiply", id: 48013, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Styled Adjusted Half Pass", 48014, 1, 128, true),
					groupBoundary("Outer Half Pass", 48015, 1, 128),
					layer({ name: "Screen Backdrop", id: 48016, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 48017, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-effects-adjustments", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-effects-adjustments-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
			},
			{
				groupStartIndex: 5,
				executionModel: "bounded-nested-backdrop-pass-through-effects-adjustments-v1",
				supported: true,
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedLayerEffects: [{ layerIndex: 4, key: "sofi", type: "solidFill", opacity: 128 }],
			appliedAdjustments: [{ layerIndex: 2, key: "nvrt", clipping: false, executionModel: "bounded-adjustment-v1" }],
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-effects-adjustments-v1",
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([130, 96, 77, 255]);

		const effectsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/pass-through-nested-backdrop-effects-adjustments-effects-disabled",
			applyLayerEffects: false,
		});
		expect(effectsDisabled.groupComposites).toMatchObject([
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-adjustments-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 5, executionModel: "bounded-nested-backdrop-pass-through-adjustments-v1", supported: true },
		]);
		expect(effectsDisabled.items[0].appliedLayerEffects).toEqual([]);
		expect(effectsDisabled.items[0].appliedAdjustments).toMatchObject([{ layerIndex: 2, key: "nvrt" }]);

		const adjustmentsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/pass-through-nested-backdrop-effects-adjustments-adjustments-disabled",
			applyAdjustments: false,
		});
		expect(adjustmentsDisabled.groupComposites).toMatchObject([
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-effects-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 5, executionModel: "bounded-nested-backdrop-pass-through-effects-v1", supported: true },
		]);
		expect(adjustmentsDisabled.items[0].appliedAdjustments).toEqual([]);
		expect(adjustmentsDisabled.items[0].appliedLayerEffects).toMatchObject([{ layerIndex: 4, key: "sofi" }]);
	});

	test("combines nested pass-through masks, group effects, and free adjustments at exact parent-canvas boundaries", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, combined = false) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: combined ? { top: 0, left: 0, width: 1, height: 1, plane: [128], defaultColor: 255 } : undefined,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(combined ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 48018, 3),
					groupBoundary("Inner End", 48019, 3),
					layer({
						name: "Inner Free Invert",
						id: 48020,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Inner Multiply", id: 48021, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Masked Styled Adjusted Half Pass", 48022, 1, 128, true),
					groupBoundary("Outer Half Pass", 48023, 1, 128),
					layer({ name: "Screen Backdrop", id: 48024, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 48025, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-mask-effects-adjustments", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
			},
			{
				groupStartIndex: 5,
				executionModel: "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1",
				supported: true,
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedGroupMasks: [
				{
					groupIndex: 4,
					executionModel: "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1",
					application: "backdrop-interpolation",
					maskCoverageMinimum: 128,
					maskCoverageMaximum: 128,
				},
			],
			appliedLayerEffects: [{ layerIndex: 4, key: "sofi", type: "solidFill", opacity: 128 }],
			appliedAdjustments: [{ layerIndex: 2, key: "nvrt", clipping: false, executionModel: "bounded-adjustment-v1" }],
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1",
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([121, 89, 69, 255]);

		const effectsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/pass-through-nested-backdrop-mask-effects-adjustments-effects-disabled",
			applyLayerEffects: false,
		});
		expect(effectsDisabled.groupComposites).toMatchObject([
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-mask-adjustments-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 5, executionModel: "bounded-nested-backdrop-pass-through-mask-adjustments-v1", supported: true },
		]);
		expect(effectsDisabled.items[0].appliedLayerEffects).toEqual([]);
		expect(effectsDisabled.items[0].appliedAdjustments).toMatchObject([{ layerIndex: 2, key: "nvrt" }]);
		expect(effectsDisabled.items[0].appliedGroupMasks).toMatchObject([{ groupIndex: 4, application: "backdrop-interpolation" }]);

		const adjustmentsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/pass-through-nested-backdrop-mask-effects-adjustments-adjustments-disabled",
			applyAdjustments: false,
		});
		expect(adjustmentsDisabled.groupComposites).toMatchObject([
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-mask-effects-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 5, executionModel: "bounded-nested-backdrop-pass-through-mask-effects-v1", supported: true },
		]);
		expect(adjustmentsDisabled.items[0].appliedAdjustments).toEqual([]);
		expect(adjustmentsDisabled.items[0].appliedLayerEffects).toMatchObject([{ layerIndex: 4, key: "sofi" }]);
		expect(adjustmentsDisabled.items[0].appliedGroupMasks).toMatchObject([{ groupIndex: 4, application: "backdrop-interpolation" }]);
	});

	test("applies lmgm Layer Mask Hides Effects as a final styled-layer mask", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Masked Shadow",
						id: 48026,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [200, 100, 50, 255],
						mask: { top: 0, left: 0, width: 1, height: 1, plane: [255], defaultColor: 0 },
						additionalInfo: [
							additional("lrFX", legacyDropShadowEffect({ color: [0, 0, 0], blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100 })),
							additional("lmgm", Buffer.from([1, 0, 0, 0])),
						],
					}),
				],
				{ width: 2, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/layer-mask-hides-effects", applyLayerEffects: true };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0].advancedBlending).toEqual({
			blendClippedLayersAsGroup: null,
			blendInteriorEffectsAsGroup: null,
			transparencyShapesLayer: null,
			knockout: "none",
			layerMaskAsGlobalMask: true,
			vectorMaskAsGlobalMask: null,
			executionModel: "psd-advanced-layer-style-flags-v1",
		});
		expect(planned.items[0]).toMatchObject({
			appliedLayerEffects: [{ layerIndex: 0, key: "dsdw", type: "dropShadow" }],
			appliedLayerStyleMask: {
				sourceKey: "lmgm",
				layerMaskAsGlobalMask: true,
				application: "final-layer-and-effects-crossfade",
				maskCoverageMinimum: 0,
				maskCoverageMaximum: 255,
				executionModel: "bounded-layer-mask-hides-effects-v1",
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect({ width: pixels.info.width, height: pixels.info.height, data: [...pixels.data] }).toEqual({
			width: 2,
			height: 1,
			data: [200, 100, 50, 255, 0, 0, 0, 0],
		});

		const effectsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/layer-mask-hides-effects-disabled",
			applyLayerEffects: false,
		});
		expect(effectsDisabled.items[0].appliedLayerEffects).toEqual([]);
		expect(effectsDisabled.items[0].appliedLayerStyleMask).toMatchObject({ executionModel: "bounded-layer-mask-hides-effects-v1" });
	});

	test("applies vmgm Vector Mask Hides Effects as a final styled-layer mask", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Vector Masked Shadow",
						id: 48027,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [200, 100, 50, 255],
						additionalInfo: [
							additional("vmsk", vectorMaskRectangle(0, 0, 0.5, 1)),
							additional("lrFX", legacyDropShadowEffect({ color: [0, 0, 0], blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100 })),
							additional("vmgm", Buffer.from([1, 0, 0, 0])),
						],
					}),
				],
				{ width: 2, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/vector-mask-hides-effects", applyLayerEffects: true };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0].advancedBlending).toEqual({
			blendClippedLayersAsGroup: null,
			blendInteriorEffectsAsGroup: null,
			transparencyShapesLayer: null,
			knockout: "none",
			layerMaskAsGlobalMask: null,
			vectorMaskAsGlobalMask: true,
			executionModel: "psd-advanced-layer-style-flags-v1",
		});
		expect(planned.items[0]).toMatchObject({
			appliedLayerEffects: [{ layerIndex: 0, key: "dsdw", type: "dropShadow" }],
			appliedVectorStyleMask: {
				sourceKey: "vmgm",
				vectorMaskAsGlobalMask: true,
				application: "final-layer-and-effects-crossfade",
				maskCoverageMinimum: 0,
				maskCoverageMaximum: 255,
				executionModel: "bounded-vector-mask-hides-effects-v1",
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect({ width: pixels.info.width, height: pixels.info.height, data: [...pixels.data] }).toEqual({
			width: 2,
			height: 1,
			data: [200, 100, 50, 255, 0, 0, 0, 0],
		});

		const effectsDisabled = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/vector-mask-hides-effects-disabled",
			applyLayerEffects: false,
		});
		expect(effectsDisabled.items[0].appliedLayerEffects).toEqual([]);
		expect(effectsDisabled.items[0].appliedVectorStyleMask).toMatchObject({ executionModel: "bounded-vector-mask-hides-effects-v1" });
	});

	test("executes both infx Blend Interior Effects as Group compositing orders against an exact bounded backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "norm" : undefined))],
			});
		for (const grouped of [true, false]) {
			for (const opacity of [255, 128]) {
				await writeFile(
					source,
					createLayeredPsd(
						[
							groupBoundary("Group End", 48030, 3),
							layer({
								name: grouped ? "Grouped Interior Effects" : "Independent Interior Effects",
								id: (grouped ? 48031 : 48032) + (opacity === 128 ? 10 : 0),
								left: 0,
								top: 0,
								width: 1,
								height: 1,
								visible: true,
								opacity,
								blendMode: "mul ",
								rgba: [200, 100, 50, 255],
								additionalInfo: [
									additional("lrFX", legacySolidFillEffect({ color: [100, 200, 250], opacity: 128, blendMode: "scrn" })),
									additional("infx", Buffer.from([grouped ? 1 : 0, 0, 0, 0])),
								],
							}),
							layer({ name: "Backdrop", id: 48033, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [80, 120, 160, 255] }),
							groupBoundary("Interior Effects Group", 48034, 1),
						],
						{ width: 1, height: 1 }
					)
				);
				const options = {
					destinationFolder: `assets/interior-effects-${grouped ? "grouped" : "independent"}-${opacity}`,
					compositeGroups: true,
					layerIndices: [3],
					applyLayerEffects: true,
				};
				const planned = await getPsdLayerExtractionStatus(source, options);
				expect(planned.document.layers[1].advancedBlending).toEqual({
					blendClippedLayersAsGroup: null,
					blendInteriorEffectsAsGroup: grouped,
					transparencyShapesLayer: null,
					knockout: "none",
					layerMaskAsGlobalMask: null,
					vectorMaskAsGlobalMask: null,
					executionModel: "psd-advanced-layer-style-flags-v1",
				});
				expect(planned.items[0].appliedInteriorEffectBlending).toEqual([
					{
						layerIndex: 1,
						layerId: (grouped ? 48031 : 48032) + (opacity === 128 ? 10 : 0),
						name: grouped ? "Grouped Interior Effects" : "Independent Interior Effects",
						sourceKey: "infx",
						blendInteriorEffectsAsGroup: grouped,
						layerBlendMode: "mul ",
						application: grouped ? "interior-effects-then-layer-blend" : "layer-blend-then-interior-effects",
						interiorEffectTypes: ["solidFill"],
						executionModel: "bounded-blend-interior-effects-as-group-v1",
					},
				]);
				await applyPsdLayerExtraction(source, options, planned.fingerprint);
				const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
				const expected = opacity === 255 ? (grouped ? [66, 76, 95, 255] : [101, 129, 141, 255]) : grouped ? [73, 98, 127, 255] : [89, 117, 135, 255];
				expect([...pixels]).toEqual(expected);
			}
		}
	});

	test("executes infx on a styled isolated-group boundary against its parent backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, additionalInfo: Buffer[] = [], blendMode = "norm") =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? blendMode : undefined)), ...additionalInfo],
			});
		for (const grouped of [true, false]) {
			await writeFile(
				source,
				createLayeredPsd(
					[
						groupBoundary("Outer End", 48040, 3),
						groupBoundary("Styled Group End", 48041, 3),
						layer({ name: "Styled Group Child", id: 48042, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 100, 50, 255] }),
						groupBoundary(
							"Styled Interior Group",
							grouped ? 48043 : 48044,
							1,
							[
								additional("lrFX", legacySolidFillEffect({ color: [100, 200, 250], opacity: 128, blendMode: "scrn" })),
								additional("infx", Buffer.from([grouped ? 1 : 0, 0, 0, 0])),
							],
							"mul "
						),
						layer({ name: "Outer Backdrop", id: 48045, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [80, 120, 160, 255] }),
						groupBoundary("Outer Group", 48046, 1),
					],
					{ width: 1, height: 1 }
				)
			);
			const options = {
				destinationFolder: grouped ? "assets/interior-group-boundary-grouped" : "assets/interior-group-boundary-independent",
				compositeGroups: true,
				layerIndices: [5],
				applyLayerEffects: true,
			};
			const planned = await getPsdLayerExtractionStatus(source, options);
			expect(planned.items[0].appliedInteriorEffectBlending).toMatchObject([
				{
					layerIndex: 3,
					blendInteriorEffectsAsGroup: grouped,
					application: grouped ? "interior-effects-then-layer-blend" : "layer-blend-then-interior-effects",
					interiorEffectTypes: ["solidFill"],
					executionModel: "bounded-blend-interior-effects-as-group-v1",
				},
			]);
			await applyPsdLayerExtraction(source, options, planned.fingerprint);
			const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...pixels]).toEqual(grouped ? [66, 76, 95, 255] : [101, 129, 141, 255]);
		}
	});

	test("rejects standalone and pass-through group-level infx without the exact bounded parent-boundary model", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, blendMode: string, additionalInfo: Buffer[] = []) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? blendMode : undefined)), ...additionalInfo],
			});
		for (const blendMode of ["mul ", "pass"]) {
			await writeFile(
				source,
				createLayeredPsd(
					[
						groupBoundary("Styled Group End", 48050, 3, "norm"),
						layer({ name: "Styled Group Child", id: 48051, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 100, 50, 255] }),
						groupBoundary("Standalone Interior Group", 48052, 1, blendMode, [
							additional("lrFX", legacySolidFillEffect({ color: [100, 200, 250], opacity: 128, blendMode: "scrn" })),
							additional("infx", Buffer.from([1, 0, 0, 0])),
						]),
					],
					{ width: 1, height: 1 }
				)
			);
			const options = {
				destinationFolder: `assets/interior-group-unsupported-${blendMode.trim()}`,
				compositeGroups: true,
				applyLayerEffects: true,
			};
			if (blendMode === "pass") {
				const planned = await getPsdLayerExtractionStatus(source, options);
				expect(planned.groupComposites[0]).toMatchObject({
					supported: false,
					executionModel: "bounded-pass-through-flatten-v1",
					warnings: ["Pass-through group effects are outside the backdrop-independent flattening model."],
				});
				expect(planned.items.every((item) => item.appliedInteriorEffectBlending.length === 0)).toBe(true);
				await expect(getPsdLayerExtractionStatus(source, { ...options, layerIndices: [2] })).rejects.toThrow("hidden or cannot be extracted");
			} else {
				await expect(getPsdLayerExtractionStatus(source, options)).rejects.toThrow("exact group-level execution requires a bounded non-pass parent canvas");
			}
		}
	});

	test("executes both clbl Blend Clipped Layers as Group orders against an exact bounded backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "norm" : undefined))],
			});
		for (const grouped of [true, false]) {
			await writeFile(
				source,
				createLayeredPsd(
					[
						groupBoundary("Clipped Group End", 48060, 3),
						layer({
							name: "Clipped Screen",
							id: 48061,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							blendMode: "scrn",
							clipping: true,
							rgba: [100, 200, 250, 255],
						}),
						layer({
							name: grouped ? "Grouped Clipping Base" : "Independent Clipping Base",
							id: grouped ? 48062 : 48063,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							blendMode: "mul ",
							rgba: [200, 100, 50, 255],
							additionalInfo: [additional("clbl", Buffer.from([grouped ? 1 : 0, 0, 0, 0]))],
						}),
						layer({ name: "Clipping Backdrop", id: 48064, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [80, 120, 160, 255] }),
						groupBoundary("Clbl Comparison", 48065, 1),
					],
					{ width: 1, height: 1 }
				)
			);
			const options = {
				destinationFolder: grouped ? "assets/clbl-grouped" : "assets/clbl-independent",
				compositeGroups: true,
				layerIndices: [4],
				compositeClippingGroups: true,
			};
			const planned = await getPsdLayerExtractionStatus(source, options);
			if (!grouped) {
				const defaultPlan = await getPsdLayerExtractionStatus(source, {
					destinationFolder: "assets/clbl-independent-default-plan",
					compositeGroups: true,
					compositeClippingGroups: true,
				});
				expect(defaultPlan.items.some((item) => item.layerIndex === 2 && item.groupComposite === null)).toBe(false);
				expect(defaultPlan.items.find((item) => item.layerIndex === 4)?.appliedClippedLayerBlending).toHaveLength(1);
			}
			expect(planned.document.layers[2].advancedBlending).toEqual({
				blendClippedLayersAsGroup: grouped,
				blendInteriorEffectsAsGroup: null,
				transparencyShapesLayer: null,
				knockout: "none",
				layerMaskAsGlobalMask: null,
				vectorMaskAsGlobalMask: null,
				executionModel: "psd-advanced-layer-style-flags-v1",
			});
			expect(planned.items[0].appliedClippedLayerBlending).toEqual([
				{
					baseLayerIndex: 2,
					baseLayerId: grouped ? 48062 : 48063,
					baseLayerName: grouped ? "Grouped Clipping Base" : "Independent Clipping Base",
					sourceKey: "clbl",
					blendClippedLayersAsGroup: grouped,
					baseBlendMode: "mul ",
					clippedLayerIndices: [1],
					clippedLayerNames: ["Clipped Screen"],
					clippedBlendModes: ["scrn"],
					application: grouped ? "clipped-composite-then-base-blend" : "base-blend-then-independent-clipped-blends",
					executionModel: "bounded-blend-clipped-layers-as-group-v1",
				},
			]);
			await applyPsdLayerExtraction(source, options, planned.fingerprint);
			const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...pixels]).toEqual(grouped ? [70, 104, 157, 255] : [138, 210, 251, 255]);
		}
	});

	test("rejects standalone clbl=false extraction without a bounded parent backdrop", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Standalone Clipped",
						id: 48070,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						blendMode: "scrn",
						clipping: true,
						rgba: [100, 200, 250, 255],
					}),
					layer({
						name: "Standalone Clipping Base",
						id: 48071,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						blendMode: "mul ",
						rgba: [200, 100, 50, 255],
						additionalInfo: [additional("clbl", Buffer.from([0, 0, 0, 0]))],
					}),
				],
				{ width: 1, height: 1 }
			)
		);
		await expect(
			getPsdLayerExtractionStatus(source, {
				destinationFolder: "assets/clbl-standalone",
				layerIndices: [1],
				compositeClippingGroups: true,
			})
		).rejects.toThrow("requires extraction through a bounded parent group backdrop");
	});

	test("executes both tsly Transparency Shapes Layer effect shapes with exact fill opacity", async () => {
		for (const transparencyShapesLayer of [true, false]) {
			await writeFile(
				source,
				createLayeredPsd(
					[
						layer({
							name: transparencyShapesLayer ? "Transparency Shape" : "Bounds Shape",
							id: transparencyShapesLayer ? 48080 : 48081,
							left: 0,
							top: 0,
							width: 2,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [20, 40, 60, 128, 80, 100, 120, 0],
							additionalInfo: [
								additional("tsly", Buffer.from([transparencyShapesLayer ? 1 : 0, 0, 0, 0])),
								additional("iOpa", Buffer.from([128, 0, 0, 0])),
								additional("lrFX", legacySolidFillEffect({ color: [255, 0, 0], opacity: 255 })),
							],
						}),
					],
					{ width: 2, height: 1 }
				)
			);
			const options = { destinationFolder: transparencyShapesLayer ? "assets/tsly-transparency" : "assets/tsly-bounds" };
			const planned = await getPsdLayerExtractionStatus(source, options);
			expect(planned.document.layers[0]).toMatchObject({
				fillOpacity: 128,
				advancedBlending: { transparencyShapesLayer, executionModel: "psd-advanced-layer-style-flags-v1" },
			});
			expect(planned.items[0].appliedTransparencyShaping).toEqual([
				{
					layerIndex: 0,
					layerId: transparencyShapesLayer ? 48080 : 48081,
					name: transparencyShapesLayer ? "Transparency Shape" : "Bounds Shape",
					sourceKey: "tsly",
					transparencyShapesLayer,
					fillOpacity: 128,
					application: transparencyShapesLayer ? "transparency-shapes-effects" : "bounds-shape-effects-transparency-as-fill",
					effectTypes: ["solidFill"],
					executionModel: "bounded-transparency-shapes-layer-v1",
				},
			]);
			await applyPsdLayerExtraction(source, options, planned.fingerprint);
			const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...pixels]).toEqual(transparencyShapesLayer ? [255, 0, 0, 64, 80, 100, 120, 0] : [255, 0, 0, 255, 255, 0, 0, 255]);

			const raw = await getPsdLayerExtractionStatus(source, { ...options, destinationFolder: `${options.destinationFolder}-effects-disabled`, applyLayerEffects: false });
			expect(raw.items[0].appliedTransparencyShaping).toEqual([]);
			await applyPsdLayerExtraction(source, { ...options, destinationFolder: `${options.destinationFolder}-effects-disabled`, applyLayerEffects: false }, raw.fingerprint);
			const rawPixels = await sharp(join(directory, raw.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...rawPixels]).toEqual([20, 40, 60, 64, 80, 100, 120, 0]);
		}

		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Masked Bounds Shape",
					id: 48082,
					left: 0,
					top: 0,
					width: 2,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [20, 40, 60, 128, 80, 100, 120, 0],
					mask: { top: 0, left: 0, width: 2, height: 1, plane: [255, 255] },
					additionalInfo: [additional("tsly", Buffer.from([0, 0, 0, 0])), additional("lrFX", legacySolidFillEffect({ color: [255, 0, 0], opacity: 255 }))],
				}),
			])
		);
		await expect(getPsdLayerExtractionStatus(source, { destinationFolder: "assets/tsly-masked" })).rejects.toThrow("combined transparency-shape and mask ordering");

		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Modulating Bounds Shape",
					id: 48083,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					blendMode: "div ",
					rgba: [20, 40, 60, 128],
					additionalInfo: [
						additional("tsly", Buffer.from([0, 0, 0, 0])),
						additional("iOpa", Buffer.from([128, 0, 0, 0])),
						additional("lrFX", legacySolidFillEffect({ color: [255, 0, 0], opacity: 255 })),
					],
				}),
			])
		);
		await expect(getPsdLayerExtractionStatus(source, { destinationFolder: "assets/tsly-modulating" })).rejects.toThrow("fill-opacity blend modulation");
	});

	test("executes shallow and deep knko stopping boundaries with fill opacity", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		for (const knockout of ["shallow", "deep"] as const) {
			await writeFile(
				source,
				createLayeredPsd(
					[
						groupBoundary("Knockout End", 48084, 3),
						layer({
							name: `${knockout} Punch`,
							id: knockout === "shallow" ? 48085 : 48086,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [255, 255, 255, 255],
							additionalInfo: [additional("knko", Buffer.from([knockout === "deep" ? 1 : 0, 0, 0, 0])), additional("iOpa", Buffer.from([0, 0, 0, 0]))],
						}),
						layer({ name: "Punched Layer", id: 48087, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 0, 0, 255] }),
						groupBoundary("Knockout Group", 48088, 1),
						layer({ name: "Shallow Stop", id: 48089, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 200, 0, 255] }),
						layer({
							name: "Background",
							id: 48090,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [0, 0, 200, 255],
							transparencyProtected: true,
							omitAlpha: true,
						}),
					],
					{ width: 1, height: 1 }
				)
			);
			const options = { destinationFolder: `assets/knockout-${knockout}`, compositeGroups: true, layerIndices: [3] };
			const planned = await getPsdLayerExtractionStatus(source, options);
			const defaultPlan = await getPsdLayerExtractionStatus(source, { destinationFolder: `assets/knockout-${knockout}-default`, compositeGroups: true });
			expect(defaultPlan.items.some((item) => item.layerIndex === 3 && item.appliedKnockouts.length === 1)).toBe(true);
			expect(defaultPlan.items.some((item) => item.layerIndex === 1)).toBe(false);
			expect(planned.groupComposites).toMatchObject([{ groupStartIndex: 3, executionModel: "bounded-knockout-group-v1", supported: true }]);
			expect(planned.items[0].appliedKnockouts).toEqual([
				{
					layerIndex: 1,
					layerId: knockout === "shallow" ? 48085 : 48086,
					name: `${knockout} Punch`,
					sourceKey: "knko",
					knockout,
					fillOpacity: 0,
					stoppingBoundary: knockout === "shallow" ? "containing-group" : "background",
					destinationLayerIndices: knockout === "shallow" ? [4, 5] : [5],
					executionModel: "bounded-knockout-v1",
				},
			]);
			await applyPsdLayerExtraction(source, options, planned.fingerprint);
			const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...pixels]).toEqual(knockout === "shallow" ? [0, 200, 0, 255] : [0, 0, 200, 255]);
		}
	});

	test("executes deep knko to transparency when the PSD has no protected Background", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Transparency End", 48091, 3),
					layer({
						name: "Deep Transparency Punch",
						id: 48092,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [255, 255, 255, 255],
						additionalInfo: [additional("knko", Buffer.from([1, 0, 0, 0])), additional("iOpa", Buffer.from([0, 0, 0, 0]))],
					}),
					layer({ name: "Punched Layer", id: 48093, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 0, 0, 255] }),
					groupBoundary("Transparency Group", 48094, 1),
					layer({ name: "Ordinary Bottom", id: 48095, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 200, 0, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/knockout-transparency", compositeGroups: true, layerIndices: [3] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedKnockouts).toMatchObject([
			{ knockout: "deep", stoppingBoundary: "transparency", destinationLayerIndices: [], executionModel: "bounded-knockout-v1" },
		]);
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([0, 0, 0, 0]);
	});

	test("executes shallow and deep knko from a clipping mask to the exact clipping base or Background", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		for (const knockout of ["shallow", "deep"] as const) {
			await writeFile(
				source,
				createLayeredPsd(
					[
						groupBoundary("Clipping Knockout End", 48096, 3),
						layer({
							name: `${knockout} Clipped Punch`,
							id: knockout === "shallow" ? 48097 : 48098,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							clipping: true,
							rgba: [255, 255, 255, 255],
							additionalInfo: [additional("knko", Buffer.from([knockout === "deep" ? 1 : 0, 0, 0, 0])), additional("iOpa", Buffer.from([0, 0, 0, 0]))],
						}),
						layer({ name: "Clipping Base", id: 48099, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 0, 0, 255] }),
						groupBoundary("Clipping Knockout Group", 48100, 1),
						layer({ name: "Between Group and Background", id: 48101, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 200, 0, 255] }),
						layer({
							name: "Background",
							id: 48102,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [0, 0, 200, 255],
							transparencyProtected: true,
							omitAlpha: true,
						}),
					],
					{ width: 1, height: 1 }
				)
			);
			const options = { destinationFolder: `assets/knockout-clipping-${knockout}`, compositeGroups: true, layerIndices: [3], compositeClippingGroups: true };
			const planned = await getPsdLayerExtractionStatus(source, options);
			expect(planned.groupComposites).toMatchObject([{ groupStartIndex: 3, executionModel: "bounded-knockout-group-v1", supported: true }]);
			expect(planned.items[0].appliedKnockouts).toMatchObject([
				{
					layerIndex: 1,
					knockout,
					stoppingBoundary: knockout === "shallow" ? "clipping-base" : "background",
					destinationLayerIndices: knockout === "shallow" ? [2] : [5],
					executionModel: "bounded-knockout-v1",
				},
			]);
			await applyPsdLayerExtraction(source, options, planned.fingerprint);
			const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...pixels]).toEqual(knockout === "shallow" ? [200, 0, 0, 255] : [0, 0, 200, 255]);
		}
	});

	test("executes standalone and top-level clipping knko against full flat-document stopping canvases", async () => {
		for (const knockout of ["shallow", "deep"] as const) {
			await writeFile(
				source,
				createLayeredPsd(
					[
						layer({
							name: `${knockout} Standalone Punch`,
							id: knockout === "shallow" ? 48103 : 48104,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [255, 255, 255, 255],
							additionalInfo: [additional("knko", Buffer.from([knockout === "deep" ? 1 : 0, 0, 0, 0])), additional("iOpa", Buffer.from([0, 0, 0, 0]))],
						}),
						layer({ name: "Standalone Punched Layer", id: 48105, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 0, 0, 255] }),
						layer({
							name: "Background",
							id: 48106,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [0, 0, 200, 255],
							transparencyProtected: true,
							omitAlpha: true,
						}),
					],
					{ width: 1, height: 1 }
				)
			);
			const standaloneOptions = { destinationFolder: `assets/knockout-standalone-${knockout}`, layerIndices: [0] };
			const standalonePlan = await getPsdLayerExtractionStatus(source, standaloneOptions);
			expect(standalonePlan.items[0].appliedKnockouts).toMatchObject([
				{ layerIndex: 0, knockout, stoppingBoundary: "background", destinationLayerIndices: [2], executionModel: "bounded-knockout-v1" },
			]);
			await applyPsdLayerExtraction(source, standaloneOptions, standalonePlan.fingerprint);
			const standalonePixels = await sharp(join(directory, standalonePlan.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...standalonePixels]).toEqual([0, 0, 200, 255]);

			await writeFile(
				source,
				createLayeredPsd(
					[
						layer({
							name: `${knockout} Top-level Clipped Punch`,
							id: knockout === "shallow" ? 48107 : 48108,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							clipping: true,
							rgba: [255, 255, 255, 255],
							additionalInfo: [additional("knko", Buffer.from([knockout === "deep" ? 1 : 0, 0, 0, 0])), additional("iOpa", Buffer.from([0, 0, 0, 0]))],
						}),
						layer({ name: "Top-level Clipping Base", id: 48109, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 0, 0, 255] }),
						layer({ name: "Top-level Middle", id: 48110, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 200, 0, 255] }),
						layer({
							name: "Background",
							id: 48111,
							left: 0,
							top: 0,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [0, 0, 200, 255],
							transparencyProtected: true,
							omitAlpha: true,
						}),
					],
					{ width: 1, height: 1 }
				)
			);
			const clippingOptions = {
				destinationFolder: `assets/knockout-top-level-clipping-${knockout}`,
				layerIndices: [1],
				compositeClippingGroups: true,
			};
			const clippingPlan = await getPsdLayerExtractionStatus(source, clippingOptions);
			expect(clippingPlan.items[0].appliedKnockouts).toMatchObject([
				{
					layerIndex: 0,
					knockout,
					stoppingBoundary: knockout === "shallow" ? "clipping-base" : "background",
					destinationLayerIndices: knockout === "shallow" ? [1] : [3],
					executionModel: "bounded-knockout-v1",
				},
			]);
			await applyPsdLayerExtraction(source, clippingOptions, clippingPlan.fingerprint);
			const clippingPixels = await sharp(join(directory, clippingPlan.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...clippingPixels]).toEqual(knockout === "shallow" ? [200, 0, 0, 255] : [0, 0, 200, 255]);
		}
	});

	test("preserves exact lspf Protected Settings, explicit unlocked state, and unknown future bits", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "All Protected Plus Future",
						id: 48112,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [20, 40, 60, 255],
						additionalInfo: [additional("lspf", Buffer.from([0x80, 0, 0, 0x0f]))],
					}),
					layer({
						name: "Explicitly Unlocked",
						id: 48113,
						left: 1,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [80, 100, 120, 255],
						additionalInfo: [additional("lspf", Buffer.from([0, 0, 0, 0]))],
					}),
					layer({ name: "Absent Protection", id: 48114, left: 2, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [140, 160, 180, 255] }),
				],
				{ width: 3, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/protected-settings", layerIndices: [0, 1, 2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0].protectedSettings).toEqual({
			transparency: true,
			composite: true,
			position: true,
			artboardAutonest: true,
			rawFlags: 0x8000000f,
			unknownFlags: 0x80000000,
			executionModel: "psd-protected-settings-v1",
		});
		expect(planned.document.layers[1].protectedSettings).toEqual({
			transparency: false,
			composite: false,
			position: false,
			artboardAutonest: false,
			rawFlags: 0,
			unknownFlags: 0,
			executionModel: "psd-protected-settings-v1",
		});
		expect(planned.document.layers[2].protectedSettings).toBeUndefined();
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(3);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(3);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/protected-settings-stale" }, planned.fingerprint)).rejects.toThrow("plan changed");
		const pixels = await Promise.all(planned.items.map((item) => sharp(join(directory, item.path)).ensureAlpha().raw().toBuffer()));
		expect(pixels.map((value) => [...value])).toEqual([
			[20, 40, 60, 255],
			[80, 100, 120, 255],
			[140, 160, 180, 255],
		]);
	});

	test("preserves exact lclr Sheet Color, explicit none, absent state, and future fields", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({ name: "Absent Color", id: 48115, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
					layer({
						name: "Explicit None",
						id: 48116,
						left: 1,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [80, 100, 120, 255],
						additionalInfo: [additional("lclr", Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]))],
					}),
					layer({
						name: "Violet",
						id: 48117,
						left: 2,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [140, 160, 180, 255],
						additionalInfo: [additional("lclr", Buffer.from([0, 6, 0, 0, 0, 0, 0, 0]))],
					}),
					layer({
						name: "Future Color And Reserved Values",
						id: 48118,
						left: 3,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [200, 220, 240, 255],
						additionalInfo: [additional("lclr", Buffer.from([0x12, 0x34, 0, 1, 0, 2, 0xff, 0xff]))],
					}),
				],
				{ width: 4, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/sheet-color", layerIndices: [0, 1, 2, 3] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0].sheetColor).toBeUndefined();
		expect(planned.document.layers[1].sheetColor).toEqual({
			color: "none",
			colorCode: 0,
			reservedValues: [0, 0, 0],
			reservedNonZero: false,
			executionModel: "psd-sheet-color-v1",
		});
		expect(planned.document.layers[2].sheetColor).toEqual({
			color: "violet",
			colorCode: 6,
			reservedValues: [0, 0, 0],
			reservedNonZero: false,
			executionModel: "psd-sheet-color-v1",
		});
		expect(planned.document.layers[3].sheetColor).toEqual({
			color: "unknown",
			colorCode: 0x1234,
			reservedValues: [1, 2, 0xffff],
			reservedNonZero: true,
			executionModel: "psd-sheet-color-v1",
		});
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(4);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(4);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/sheet-color-stale" }, planned.fingerprint)).rejects.toThrow("plan changed");
		const pixels = await Promise.all(planned.items.map((item) => sharp(join(directory, item.path)).ensureAlpha().raw().toBuffer()));
		expect(pixels.map((value) => [...value])).toEqual([
			[20, 40, 60, 255],
			[80, 100, 120, 255],
			[140, 160, 180, 255],
			[200, 220, 240, 255],
		]);
	});

	test("preserves exact fxrp Effects Reference Points, explicit origin, and absent state", async () => {
		const referencePoint = (x: number, y: number): Buffer => {
			const result = Buffer.alloc(16);
			result.writeDoubleBE(x, 0);
			result.writeDoubleBE(y, 8);
			return result;
		};
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({ name: "Absent Reference", id: 48119, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [25, 45, 65, 255] }),
					layer({
						name: "Explicit Origin",
						id: 48120,
						left: 1,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [85, 105, 125, 255],
						additionalInfo: [additional("fxrp", referencePoint(0, 0))],
					}),
					layer({
						name: "Signed Fractional Reference",
						id: 48121,
						left: 2,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [145, 165, 185, 255],
						additionalInfo: [additional("fxrp", referencePoint(12.5, -3.25))],
					}),
				],
				{ width: 3, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/effects-reference-point", layerIndices: [0, 1, 2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0].effectsReferencePoint).toBeUndefined();
		expect(planned.document.layers[1].effectsReferencePoint).toEqual({
			sourceKey: "fxrp",
			x: 0,
			y: 0,
			axisOrder: "x-y",
			executionModel: "psd-effects-reference-point-v1",
		});
		expect(planned.document.layers[2].effectsReferencePoint).toEqual({
			sourceKey: "fxrp",
			x: 12.5,
			y: -3.25,
			axisOrder: "x-y",
			executionModel: "psd-effects-reference-point-v1",
		});
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(3);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(3);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/effects-reference-point-stale" }, planned.fingerprint)).rejects.toThrow(
			"plan changed"
		);
		const pixels = await Promise.all(planned.items.map((item) => sharp(join(directory, item.path)).ensureAlpha().raw().toBuffer()));
		expect(pixels.map((value) => [...value])).toEqual([
			[25, 45, 65, 255],
			[85, 105, 125, 255],
			[145, 165, 185, 255],
		]);
	});

	test("preserves and executes exact brst Channel Blending Restrictions", async () => {
		const restrictions = (...channelIds: number[]): Buffer => Buffer.concat(channelIds.map(i32));
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Red Restricted Clipped Layer",
						id: 48122,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						clipping: true,
						rgba: [200, 150, 100, 255],
						additionalInfo: [additional("brst", restrictions(0))],
					}),
					layer({ name: "Clipping Base", id: 48123, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
					layer({
						name: "Explicit Empty Restrictions",
						id: 48124,
						left: 1,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [70, 80, 90, 255],
						additionalInfo: [additional("brst", restrictions())],
					}),
					layer({
						name: "Duplicate Unsupported Restrictions",
						id: 48125,
						left: 2,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [110, 120, 130, 255],
						additionalInfo: [additional("brst", restrictions(2, 2, -1, 3))],
					}),
				],
				{ width: 3, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/channel-blending-restrictions", layerIndices: [1, 2, 3], compositeClippingGroups: true };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0].channelBlendingRestrictions).toEqual({
			sourceKey: "brst",
			channelIds: [0],
			restrictedChannels: ["red"],
			unsupportedChannelIds: [],
			duplicateChannelIds: [],
			executionModel: "bounded-channel-blending-restrictions-v1",
		});
		expect(planned.document.layers[1].channelBlendingRestrictions).toBeUndefined();
		expect(planned.document.layers[2].channelBlendingRestrictions).toEqual({
			sourceKey: "brst",
			channelIds: [],
			restrictedChannels: [],
			unsupportedChannelIds: [],
			duplicateChannelIds: [],
			executionModel: "bounded-channel-blending-restrictions-v1",
		});
		expect(planned.document.layers[3].channelBlendingRestrictions).toEqual({
			sourceKey: "brst",
			channelIds: [2, 2, -1, 3],
			restrictedChannels: ["blue", "blue"],
			unsupportedChannelIds: [-1, 3],
			duplicateChannelIds: [2],
			executionModel: "bounded-channel-blending-restrictions-v1",
		});
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(3);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(3);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/channel-blending-restrictions-stale" }, planned.fingerprint)).rejects.toThrow(
			"plan changed"
		);
		const pixels = await Promise.all(planned.items.map((item) => sharp(join(directory, item.path)).ensureAlpha().raw().toBuffer()));
		expect(pixels.map((value) => [...value])).toEqual([
			[10, 150, 100, 255],
			[70, 80, 90, 255],
			[110, 120, 130, 255],
		]);
	});

	test("preserves and executes SoCo Solid Color Fill layers through the shared extraction lease", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Coverage Fill",
						id: 48126,
						left: 0,
						top: 0,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [1, 2, 3, 255, 4, 5, 6, 64],
						additionalInfo: [additional("SoCo", solidColorFillDescriptor(210, 40, 80))],
					}),
					layer({
						name: "Generated Document Fill",
						id: 48127,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("SoCo", solidColorFillDescriptor(12, 145, 231))],
					}),
				],
				{ width: 2, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/solid-color-fill" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers.map((layerInfo) => layerInfo.solidColorFill)).toMatchObject([
			{
				sourceKey: "SoCo",
				colorModel: "rgb",
				authoredValues: [210, 40, 80],
				rgba: [210, 40, 80, 255],
				renderBounds: "layer",
				coverageSource: "transparency-channel",
				executionModel: "bounded-solid-color-fill-layer-v1",
			},
			{
				sourceKey: "SoCo",
				colorModel: "rgb",
				authoredValues: [12, 145, 231],
				rgba: [12, 145, 231, 255],
				renderBounds: "document",
				coverageSource: "opaque-generated",
				executionModel: "bounded-solid-color-fill-layer-v1",
			},
		]);
		expect(planned.items).toMatchObject([
			{ name: "Authored Coverage Fill", width: 2, height: 1, solidColorFill: { renderBounds: "layer", coverageSource: "transparency-channel" } },
			{ name: "Generated Document Fill", left: 0, top: 0, width: 2, height: 1, solidColorFill: { renderBounds: "document", coverageSource: "opaque-generated" } },
		]);
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(2);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(2);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/solid-color-fill-stale" }, planned.fingerprint)).rejects.toThrow("plan changed");
		const pixels = await Promise.all(planned.items.map((item) => sharp(join(directory, item.path)).ensureAlpha().raw().toBuffer()));
		expect(pixels.map((value) => [...value])).toEqual([
			[210, 40, 80, 255, 210, 40, 80, 64],
			[12, 145, 231, 255, 12, 145, 231, 255],
		]);
	});

	test("preserves and executes PtFl Pattern Fill layers through the shared extraction lease", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Pattern Coverage",
						id: 48128,
						left: 4,
						top: 3,
						width: 2,
						height: 2,
						visible: true,
						opacity: 255,
						rgba: [7, 8, 9, 255, 7, 8, 9, 128, 7, 8, 9, 0, 7, 8, 9, 64],
						additionalInfo: [additional("PtFl", patternFillDescriptor())],
					}),
					layer({
						name: "Generated Document Pattern",
						id: 48129,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("PtFl", patternFillDescriptor({ align: false, linked: false, phaseX: 1, phaseY: -1 }))],
					}),
				],
				{ width: 2, height: 2 },
				patternTaggedBlock()
			)
		);
		const options = { destinationFolder: "assets/pattern-fill" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers.map((layerInfo) => layerInfo.patternFill)).toMatchObject([
			{
				sourceKey: "PtFl",
				descriptorClassId: "null",
				patternClassId: "Ptrn",
				renderBounds: "layer",
				coverageSource: "transparency-channel",
				executionModel: "bounded-pattern-fill-layer-v1",
				bakeSupported: true,
				pattern: { id: "rgba-tile-2x2", resolutionStatus: "resolved", resolvedPatternIndices: [0], resolvedPatternIndex: 0 },
			},
			{
				renderBounds: "document",
				coverageSource: "opaque-generated",
				pattern: { align: false, linked: false, phaseX: 1, phaseY: -1 },
			},
		]);
		expect(planned.items).toMatchObject([
			{ name: "Authored Pattern Coverage", left: 4, top: 3, width: 2, height: 2, patternFill: { renderBounds: "layer" } },
			{ name: "Generated Document Pattern", left: 0, top: 0, width: 2, height: 2, patternFill: { renderBounds: "document" } },
		]);
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(2);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(2);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/pattern-fill-stale" }, planned.fingerprint)).rejects.toThrow("plan changed");
		const pixels = await Promise.all(planned.items.map((item) => sharp(join(directory, item.path)).ensureAlpha().raw().toBuffer()));
		expect(pixels.map((value) => [...value])).toEqual([
			[255, 0, 0, 255, 0, 255, 0, 64, 0, 0, 255, 0, 255, 255, 255, 64],
			[255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 128, 255, 0, 0, 255],
		]);
	});

	test("preserves and executes GdFl Gradient Fill layers through the shared extraction lease", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Authored Gradient Coverage",
						id: 48130,
						left: 4,
						top: 3,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [7, 8, 9, 128, 10, 11, 12, 255],
						additionalInfo: [additional("GdFl", gradientFillDescriptor("solid"))],
					}),
					layer({
						name: "Generated Noise Gradient",
						id: 48131,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("GdFl", gradientFillDescriptor("noise"))],
					}),
				],
				{ width: 4, height: 2 }
			)
		);
		const options = { destinationFolder: "assets/gradient-fill" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers.map((layerInfo) => layerInfo.gradientFill)).toMatchObject([
			{
				sourceKey: "GdFl",
				descriptorClassId: "null",
				gradientClassId: "Grdn",
				renderBounds: "layer",
				coverageSource: "transparency-channel",
				executionModel: "bounded-gradient-fill-layer-v1",
				bakeSupported: true,
				gradient: { type: "solid", name: "Red Blue Fill", style: "linear", interpolation: "classic", bakeSupported: true },
			},
			{
				renderBounds: "document",
				coverageSource: "opaque-generated",
				gradient: { type: "noise", name: "Seeded Noise Fill", style: "radial", randomSeed: 123456, bakeSupported: true },
			},
		]);
		expect(planned.items).toMatchObject([
			{ name: "Authored Gradient Coverage", left: 4, top: 3, width: 2, height: 1, gradientFill: { renderBounds: "layer" } },
			{ name: "Generated Noise Gradient", left: 0, top: 0, width: 4, height: 2, gradientFill: { renderBounds: "document" } },
		]);
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(2);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(2);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/gradient-fill-stale" }, planned.fingerprint)).rejects.toThrow("plan changed");
		const pixels = await Promise.all(planned.items.map((item) => sharp(join(directory, item.path)).ensureAlpha().raw().toBuffer()));
		expect([...pixels[0]]).toEqual([215, 0, 40, 118, 40, 0, 215, 147]);
		expect([...pixels[1].slice(0, 16)]).toEqual([144, 128, 136, 133, 113, 123, 126, 124, 113, 123, 126, 124, 144, 128, 136, 133]);
	});

	test("preserves and executes vscg/vstk Vector Stroke layers through the shared extraction lease", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Vector Stroke Solid",
						id: 48132,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [
							additional("vscg", Buffer.concat([Buffer.from("SoCo"), solidColorFillDescriptor(220, 40, 60)])),
							additional("vstk", vectorStrokeDescriptor()),
							additional("vmsk", vectorMaskRectangle(0.25, 0.25, 0.75, 0.75)),
							additional("vogk", vectorOriginationDescriptor()),
							additional("vowv", u32(2)),
							additional("pths", pathListDescriptor()),
						],
					}),
				],
				{ width: 16, height: 16 }
			)
		);
		const options = { destinationFolder: "assets/vector-stroke" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.document.layers[0]).toMatchObject({
			extractionSupported: true,
			vectorFill: {
				sourceKey: "vscg",
				contentKey: "SoCo",
				executionModel: "bounded-vector-fill-v1",
				content: { type: "color", color: { rgba: [220, 40, 60, 255] } },
				bakeSupported: true,
			},
			vectorStroke: {
				sourceKey: "vstk",
				lineWidth: { value: 4, units: "#Pxl", pixels: 4 },
				lineDashOffset: { value: 1, units: "#Pxl", pixels: 1 },
				lineCap: "round",
				lineJoin: "bevel",
				lineAlignment: "center",
				blendMode: "mul ",
				opacity: 75,
				content: { type: "color", color: { rgba: [20, 100, 240, 255] } },
				executionModel: "bounded-vector-stroke-v1",
				bakeSupported: true,
			},
			vectorOrigination: {
				sourceKey: "vogk",
				recordVersion: 1,
				descriptorVersion: 16,
				descriptorPaddingBytes: 2,
				association: "vector-mask",
				executionModel: "psd-vector-origination-v1",
				entries: [
					{
						originIndex: 0,
						originType: 1,
						originResolution: 144,
						shapeBoundingBox: { top: { value: 2, units: "#Pnt", pixels: 4 } },
						roundedRectangleRadii: { topRight: { value: 1, units: "#Pxl", pixels: 1 } },
						boxCorners: {
							corners: [
								{ x: 3, y: 2 },
								{ x: 13, y: 2 },
								{ x: 13, y: 12 },
								{ x: 3, y: 12 },
							],
						},
						transform: { matrix: [1, 0.1, -0.2, 1, 5, 6] },
					},
				],
			},
			vectorRenderingVersion: {
				sourceKey: "vowv",
				value: 2,
				observedPhotoshopValue: true,
				executionModel: "psd-vector-rendering-version-v1",
			},
			pathList: {
				sourceKey: "pths",
				descriptorVersion: 16,
				descriptorClassId: "pathsDataClass",
				descriptorPaddingBytes: 2,
				executionModel: "psd-path-list-v1",
				paths: [
					{
						listIndex: 0,
						unicodeName: "Work Path",
						symmetry: { modeType: "enum", enumType: "pathSymmetryModeEnum", value: "pathSymmetryModeBasicPath" },
					},
				],
			},
		});
		expect(planned.items).toMatchObject([
			{
				name: "Vector Stroke Solid",
				left: 0,
				top: 0,
				width: 16,
				height: 16,
				vectorFill: { sourceKey: "vscg" },
				vectorStroke: { sourceKey: "vstk", executionModel: "bounded-vector-stroke-v1" },
				vectorOrigination: { sourceKey: "vogk", executionModel: "psd-vector-origination-v1" },
				vectorRenderingVersion: { sourceKey: "vowv", value: 2, executionModel: "psd-vector-rendering-version-v1" },
				pathList: { sourceKey: "pths", executionModel: "psd-path-list-v1" },
			},
		]);
		const applied = await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect(applied.createdCount).toBe(1);
		const reuse = await getPsdLayerExtractionStatus(source, options);
		expect(reuse.reusedCount).toBe(1);
		await expect(applyPsdLayerExtraction(source, { ...options, destinationFolder: "assets/vector-stroke-stale" }, planned.fingerprint)).rejects.toThrow("plan changed");
		const { data, info } = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
		expect([info.width, info.height]).toEqual([16, 16]);
		const pixel = (x: number, y: number): number[] => [...data.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4)];
		expect(pixel(8, 8)).toEqual([220, 40, 60, 255]);
		expect(pixel(0, 0)).toEqual([220, 40, 60, 0]);
	});

	test("executes nested pass-through free adjustments in authored order over each exact parent canvas", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 47987, 3),
					groupBoundary("Inner End", 47988, 3),
					layer({
						name: "Inner Free Invert",
						id: 47989,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Inner Multiply", id: 47990, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Inner Adjusted Half Pass", 47991, 1, 128),
					groupBoundary("Outer Half Pass", 47992, 1, 128),
					layer({ name: "Screen Backdrop", id: 47993, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47994, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-nested-backdrop-adjustments", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 4,
				executionModel: "bounded-nested-backdrop-pass-through-adjustments-v1",
				supported: false,
				requiresParentBackdrop: true,
				groupOpacity: 128,
			},
			{
				groupStartIndex: 5,
				executionModel: "bounded-nested-backdrop-pass-through-adjustments-v1",
				supported: true,
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		]);
		expect(planned.items[0]).toMatchObject({
			appliedAdjustments: [{ layerIndex: 2, name: "Inner Free Invert", key: "nvrt", clipping: false, executionModel: "bounded-adjustment-v1" }],
			groupComposite: {
				executionModel: "bounded-nested-backdrop-pass-through-adjustments-v1",
				backdropLayerIndices: [6, 7],
				backdropBlendModes: ["scrn", "norm"],
				nestedGroupIndices: [4],
				passThroughGroupIndices: [5, 4],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([126, 118, 106, 255]);

		const raw = await getPsdLayerExtractionStatus(source, {
			...options,
			destinationFolder: "assets/pass-through-nested-backdrop-adjustments-disabled",
			applyAdjustments: false,
		});
		expect(raw.groupComposites).toMatchObject([
			{ groupStartIndex: 4, executionModel: "bounded-nested-backdrop-pass-through-blends-v1", requiresParentBackdrop: true },
			{ groupStartIndex: 5, executionModel: "bounded-nested-backdrop-pass-through-blends-v1", supported: true },
		]);
		expect(raw.items[0]).toMatchObject({ appliedAdjustments: [], warnings: [expect.stringContaining("was not applied because adjustment compositing is disabled")] });
	});

	test("combines non-normal pass-through child and backdrop blends with exact group-mask interpolation", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: type === 1 ? { top: 0, left: 0, width: 1, height: 1, plane: [128], defaultColor: 255 } : undefined,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47919, 3),
					layer({
						name: "Multiply Child",
						id: 47920,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						blendMode: "mul ",
						rgba: [200, 100, 50, 255],
					}),
					groupBoundary("Masked Blended Half Pass", 47921, 1, 128),
					layer({ name: "Screen Backdrop", id: 47922, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47923, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-blends-mask", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-blends-mask-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [3, 4],
				backdropBlendModes: ["scrn", "norm"],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			blendModes: ["mul "],
			appliedGroupMasks: [
				{
					executionModel: "bounded-backdrop-pass-through-blends-mask-v1",
					application: "backdrop-interpolation",
					maskCoverageMinimum: 128,
					maskCoverageMaximum: 128,
				},
			],
			groupComposite: {
				executionModel: "bounded-backdrop-pass-through-blends-mask-v1",
				backdropLayerIndices: [3, 4],
				backdropBlendModes: ["scrn", "norm"],
				blendModes: ["mul "],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([106, 69, 48, 255]);
	});

	test("combines non-normal pass-through blending with foreground group effects over an independent shape", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(type === 1 ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47924, 3),
					layer({
						name: "Multiply Child",
						id: 47925,
						left: 0,
						top: 0,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						blendMode: "mul ",
						rgba: [200, 100, 50, 255],
					}),
					groupBoundary("Styled Blended Half Pass", 47926, 1, 128),
					layer({ name: "Screen Backdrop", id: 47927, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47928, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-blends-effects", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-blends-effects-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [3, 4],
				backdropBlendModes: ["scrn", "norm"],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			blendModes: ["mul "],
			appliedLayerEffects: [{ layerIndex: 2, key: "sofi", type: "solidFill", opacity: 128 }],
			groupComposite: {
				executionModel: "bounded-backdrop-pass-through-blends-effects-v1",
				backdropLayerIndices: [3, 4],
				backdropBlendModes: ["scrn", "norm"],
				blendModes: ["mul "],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([128, 61, 35, 255]);

		const raw = await getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-blends-effects-disabled", applyLayerEffects: false });
		expect(raw.groupComposites).toMatchObject([{ groupStartIndex: 2, executionModel: "bounded-backdrop-pass-through-blends-v1", supported: true }]);
		expect(raw.items[0]).toMatchObject({ appliedLayerEffects: [] });

		const behindBoundary = (name: string, id: number, type: 1 | 3) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)),
					...(type === 1 ? [additional("lrFX", legacyDropShadowEffect({ color: [0, 0, 0], blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					behindBoundary("Pass End", 47929, 3),
					layer({ name: "Multiply Child", id: 47930, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					behindBoundary("Behind Effect Pass", 47931, 1),
					layer({ name: "Backdrop", id: 47932, left: 0, top: 0, width: 2, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255, 20, 40, 60, 255] }),
				],
				{ width: 2, height: 1 }
			)
		);
		const behindOptions = { destinationFolder: "assets/pass-through-blends-behind-effects", compositeGroups: true, layerIndices: [2] };
		const behind = await getPsdLayerExtractionStatus(source, behindOptions);
		expect(behind.groupComposites).toMatchObject([
			{
				groupStartIndex: 2,
				executionModel: "bounded-backdrop-pass-through-blends-effects-behind-v1",
				supported: true,
				backdropLayerIndices: [3],
				backdropBlendModes: ["norm"],
				backdropIncluded: true,
			},
		]);
		expect(behind.items[0]).toMatchObject({
			blendModes: ["mul "],
			appliedLayerEffects: [{ layerIndex: 2, key: "dsdw", type: "dropShadow", opacity: 100 }],
			groupComposite: { executionModel: "bounded-backdrop-pass-through-blends-effects-behind-v1", blendModes: ["mul "] },
		});
		await applyPsdLayerExtraction(source, behindOptions, behind.fingerprint);
		const behindPixels = await sharp(join(directory, behind.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...behindPixels]).toEqual([16, 16, 12, 255, 0, 0, 0, 255]);
	});

	test("splits outer glows, center strokes, and outer or mixed bevels around non-normal pass-through child blending", async () => {
		const cases = [
			{ name: "outer-glow", tag: "lmfx", effects: modernGlowEffects(), effectTypes: ["outerGlow", "innerGlow"] },
			{ name: "center-stroke", tag: "lfx2", effects: modernStrokeEffect({ color: [255, 0, 0], size: 2, opacity: 100, position: "CtrF" }), effectTypes: ["stroke"] },
			{ name: "outer-bevel", tag: "lmfx", effects: modernBevelSatinEffects({ style: "OtrB", includeSatin: false }), effectTypes: ["bevel"] },
			{ name: "emboss", tag: "lmfx", effects: modernBevelSatinEffects({ style: "Embs", includeSatin: false }), effectTypes: ["bevel"] },
		] as const;
		for (const [caseIndex, item] of cases.entries()) {
			const boundary = (name: string, id: number, type: 1 | 3) =>
				layer({
					name,
					id,
					left: 0,
					top: 0,
					width: 0,
					height: 0,
					visible: true,
					opacity: type === 1 ? 128 : 255,
					rgba: [],
					adjustmentOnly: true,
					additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined)), ...(type === 1 ? [additional(item.tag, item.effects)] : [])],
				});
			await writeFile(
				source,
				createLayeredPsd(
					[
						boundary("Pass End", 47939 + caseIndex * 4, 3),
						layer({
							name: "Multiply Child",
							id: 47940 + caseIndex * 4,
							left: 1,
							top: 1,
							width: 3,
							height: 3,
							visible: true,
							opacity: 255,
							blendMode: "mul ",
							rgba: Array.from({ length: 9 }, () => [200, 100, 50, 255]).flat(),
						}),
						boundary(`${item.name} Half Pass`, 47941 + caseIndex * 4, 1),
						layer({
							name: "Backdrop",
							id: 47942 + caseIndex * 4,
							left: 0,
							top: 0,
							width: 5,
							height: 5,
							visible: true,
							opacity: 255,
							rgba: Array.from({ length: 25 }, () => [20, 40, 60, 255]).flat(),
						}),
					],
					{ width: 5, height: 5 }
				)
			);
			const options = { destinationFolder: `assets/pass-through-blends-${item.name}`, compositeGroups: true, layerIndices: [2] };
			const planned = await getPsdLayerExtractionStatus(source, options);
			expect(planned.groupComposites).toMatchObject([
				{ groupStartIndex: 2, executionModel: "bounded-backdrop-pass-through-blends-effects-behind-v1", supported: true, groupOpacity: 128 },
			]);
			expect(planned.items[0].appliedLayerEffects.map((effect) => effect.type).sort()).toEqual([...item.effectTypes].sort());
			await applyPsdLayerExtraction(source, options, planned.fingerprint);
			const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
			expect(pixels.byteLength).toBeGreaterThanOrEqual(5 * 5 * 4);
			expect(createHash("sha256").update(pixels).digest("hex")).not.toBe(
				createHash("sha256")
					.update(Buffer.from(Array.from({ length: 25 }, () => [20, 40, 60, 255]).flat()))
					.digest("hex")
			);
		}
	});

	test("combines non-normal pass-through blending with free adjustments in authored stack order", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "pass" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 47933, 3),
					layer({
						name: "Free Invert",
						id: 47934,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Multiply Child", id: 47935, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [200, 100, 50, 255] }),
					groupBoundary("Adjusted Blended Half Pass", 47936, 1, 128),
					layer({ name: "Screen Backdrop", id: 47937, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "scrn", rgba: [100, 50, 0, 255] }),
					layer({ name: "Normal Backdrop", id: 47938, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [20, 40, 60, 255] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/pass-through-blends-adjustments", compositeGroups: true, layerIndices: [3] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 3,
				executionModel: "bounded-backdrop-pass-through-blends-adjustments-v1",
				supported: true,
				groupOpacity: 128,
				backdropLayerIndices: [4, 5],
				backdropBlendModes: ["scrn", "norm"],
				backdropIncluded: true,
			},
		]);
		expect(planned.items[0]).toMatchObject({
			blendModes: ["mul "],
			appliedAdjustments: [{ layerIndex: 1, name: "Free Invert", key: "nvrt", clipping: false, executionModel: "bounded-adjustment-v1" }],
			groupComposite: {
				executionModel: "bounded-backdrop-pass-through-blends-adjustments-v1",
				backdropLayerIndices: [4, 5],
				backdropBlendModes: ["scrn", "norm"],
				childLayerIndices: [2, 1],
				blendModes: ["mul "],
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([140, 153, 152, 255]);

		const raw = await getPsdLayerExtractionStatus(source, { ...options, destinationFolder: "assets/pass-through-blends-adjustments-disabled", applyAdjustments: false });
		expect(raw.groupComposites).toMatchObject([{ groupStartIndex: 3, executionModel: "bounded-backdrop-pass-through-blends-v1", supported: true }]);
		expect(raw.items[0]).toMatchObject({ appliedAdjustments: [], warnings: [expect.stringContaining("was not applied because adjustment compositing is disabled")] });
	});

	test("rejects pass-through groups whose flattened pixels depend on an external backdrop", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255, blendMode = "pass") =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				mask: type === 1 ? { top: 0, left: 0, width: 1, height: 1, plane: [255], defaultColor: 255 } : undefined,
				additionalInfo: [
					additional("lsct", sectionDivider(type, type === 1 ? blendMode : undefined)),
					...(type === 1 ? [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))] : []),
				],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Pass End", 4790, 3),
					layer({ name: "Multiply Child", id: 4791, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, blendMode: "mul ", rgba: [10, 20, 30, 255] }),
					layer({
						name: "Free Invert",
						id: 4792,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Normal Child", id: 4793, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [100, 110, 120, 255] }),
					groupBoundary("Backdrop Dependent Pass", 4794, 1, 128),
				],
				{ width: 1, height: 1 }
			)
		);
		const planned = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/unsupported-pass-through" });
		expect(planned.groupComposites).toMatchObject([{ groupStartIndex: 4, executionModel: "bounded-pass-through-flatten-v1", supported: false }]);
		expect(planned.groupComposites[0].warnings).toEqual(
			expect.arrayContaining([
				"Pass-through flattening requires full group opacity because reduced group opacity depends on an external backdrop.",
				"Pass-through group masks are outside the backdrop-independent flattening model.",
				"Pass-through group effects are outside the backdrop-independent flattening model.",
				"Pass-through flattening requires normal blend mode on every visible un-clipped pixel child so the result is backdrop-independent.",
				"Un-clipped adjustments inside a pass-through group can affect layers outside the group and cannot be flattened without that backdrop.",
			])
		);
	});

	test("extracts a bounded flat isolated group with internal and external adjustment order", async () => {
		const adjustmentLayer = (name: string, id: number, key: string) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional(key, Buffer.alloc(0))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					adjustmentLayer("External Invert", 4640, "nvrt"),
					layer({
						name: "Group End",
						id: 4641,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(3))],
					}),
					layer({ name: "Top Blue", id: 4642, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 0, 255, 128] }),
					adjustmentLayer("Internal Invert", 4643, "nvrt"),
					layer({ name: "Bottom", id: 4644, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
					layer({
						name: "Isolated Group",
						id: 4645,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 128,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("lsct", sectionDivider(1, "norm"))],
					}),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/isolated-group", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 5,
				groupEndIndex: 1,
				name: "Isolated Group",
				blendMode: "norm",
				supported: true,
				childLayerIndices: [2, 3, 4],
				warnings: [],
			},
		]);
		expect(planned.items).toMatchObject([
			{
				layerIndex: 5,
				name: "Isolated Group",
				opacity: 128,
				warnings: [],
				groupComposite: {
					executionModel: "bounded-isolated-group-v1",
					groupStartIndex: 5,
					groupEndIndex: 1,
					childLayerIndices: [4, 3, 2],
					childLayerNames: ["Bottom", "Internal Invert", "Top Blue"],
					blendModes: ["norm", "norm"],
				},
				appliedAdjustments: [
					{ layerIndex: 3, name: "Internal Invert", key: "nvrt" },
					{ layerIndex: 0, name: "External Invert", key: "nvrt" },
				],
			},
		]);
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([133, 138, 15, 128]);
	});

	test("recursively composites bounded nested isolated groups without double-applying parent adjustments", async () => {
		const adjustmentLayer = (name: string, id: number, key: string) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional(key, Buffer.alloc(0))],
			});
		const groupBoundary = (name: string, id: number, type: 1 | 3, opacity = 255) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "norm" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					adjustmentLayer("External Invert", 4650, "nvrt"),
					groupBoundary("Outer End", 4651, 3),
					layer({ name: "Outer Top Red", id: 4652, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 0, 0, 128] }),
					groupBoundary("Inner End", 4653, 3),
					adjustmentLayer("Inner Invert", 4654, "nvrt"),
					layer({ name: "Inner Bottom", id: 4655, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 255] }),
					groupBoundary("Inner Isolated", 4656, 1, 128),
					layer({ name: "Outer Bottom", id: 4657, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [100, 100, 100, 255] }),
					groupBoundary("Outer Isolated", 4658, 1, 200),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/nested-isolated-group", compositeGroups: true, layerIndices: [8] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([
			{
				groupStartIndex: 6,
				groupEndIndex: 3,
				supported: true,
				directChildLayerIndices: [5, 4],
				nestedGroupIndices: [],
				maximumDepth: 1,
			},
			{
				groupStartIndex: 8,
				groupEndIndex: 1,
				supported: true,
				directChildLayerIndices: [7, 6, 2],
				nestedGroupIndices: [6],
				maximumDepth: 2,
			},
		]);
		expect(planned.items).toMatchObject([
			{
				layerIndex: 8,
				opacity: 200,
				warnings: [],
				groupComposite: {
					executionModel: "bounded-nested-isolated-group-v1",
					groupStartIndex: 8,
					groupEndIndex: 1,
					childLayerIndices: [7, 6, 2],
					childLayerNames: ["Outer Bottom", "Inner Isolated", "Outer Top Red"],
					blendModes: ["norm", "norm", "norm"],
					nestedGroupIndices: [6],
					maximumDepth: 2,
				},
				appliedAdjustments: [
					{ layerIndex: 4, name: "Inner Invert", key: "nvrt" },
					{ layerIndex: 0, name: "External Invert", key: "nvrt" },
				],
			},
		]);
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([41, 171, 174, 200]);
	});

	test("reports nested isolated groups beyond the bounded recursion depth without rendering them", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "norm" : undefined))],
			});
		const depth = 33;
		const ends = Array.from({ length: depth }, (_, index) => groupBoundary(`End ${index}`, 4660 + index, 3));
		const starts = Array.from({ length: depth }, (_, index) => groupBoundary(`Start ${depth - index}`, 4700 + index, 1));
		await writeFile(
			source,
			createLayeredPsd(
				[...ends, layer({ name: "Deep Pixel", id: 4699, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [1, 2, 3, 255] }), ...starts],
				{
					width: 1,
					height: 1,
				}
			)
		);
		const planned = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/deep-isolated-groups" });
		const outer = planned.groupComposites.find((group) => group.maximumDepth === depth);
		expect(outer).toMatchObject({ supported: false, maximumDepth: 33 });
		expect(outer?.warnings).toContain("Nested isolated-group compositing is limited to 32 levels; this group reaches 33.");
	});

	test("bakes bounded group-level raster masks and effects after child compositing", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, options: { mask?: number[]; effects?: Buffer } = {}) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				mask: options.mask ? { top: 0, left: 0, width: 2, height: 1, plane: options.mask, defaultColor: 255 } : undefined,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "norm" : undefined)), ...(options.effects ? [additional("lrFX", options.effects)] : [])],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Group End", 4760, 3),
					layer({
						name: "Two Pixels",
						id: 4761,
						left: 0,
						top: 0,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [20, 40, 60, 255, 20, 40, 60, 255],
					}),
					groupBoundary("Masked Effect Group", 4762, 1, {
						mask: [128, 255],
						effects: legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }),
					}),
				],
				{ width: 2, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/group-mask-effect", compositeGroups: true, layerIndices: [2] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.groupComposites).toMatchObject([{ groupStartIndex: 2, supported: true, warnings: [] }]);
		expect(planned.items).toMatchObject([
			{
				warnings: [],
				appliedGroupMasks: [
					{
						groupIndex: 2,
						groupId: 4762,
						name: "Masked Effect Group",
						executionModel: "bounded-group-mask-v1",
						maskCoverageMinimum: 128,
						maskCoverageMaximum: 255,
					},
				],
				appliedLayerEffects: [{ layerIndex: 2, layerName: "Masked Effect Group", key: "sofi", type: "solidFill", opacity: 128 }],
				groupComposite: { executionModel: "bounded-isolated-group-v1" },
			},
		]);
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([110, 45, 35, 128, 110, 45, 35, 255]);

		const rawOptions = { ...options, destinationFolder: "assets/raw-group-mask-effect", applyLayerEffects: false };
		const raw = await getPsdLayerExtractionStatus(source, rawOptions);
		expect(raw.items).toMatchObject([{ appliedGroupMasks: [{ groupIndex: 2 }], appliedLayerEffects: [], warnings: [expect.stringContaining("Layer effect sofi #2")] }]);
		await applyPsdLayerExtraction(source, rawOptions, raw.fingerprint);
		const rawPixels = await sharp(join(directory, raw.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...rawPixels]).toEqual([20, 40, 60, 128, 20, 40, 60, 255]);
	});

	test("applies a nested group mask before compositing the nested result into its parent", async () => {
		const groupBoundary = (name: string, id: number, type: 1 | 3, mask?: number[]) =>
			layer({
				name,
				id,
				left: 0,
				top: 0,
				width: 0,
				height: 0,
				visible: true,
				opacity: 255,
				rgba: [],
				adjustmentOnly: true,
				mask: mask ? { top: 0, left: 0, width: 1, height: 1, plane: mask, defaultColor: 255 } : undefined,
				additionalInfo: [additional("lsct", sectionDivider(type, type === 1 ? "norm" : undefined))],
			});
		await writeFile(
			source,
			createLayeredPsd(
				[
					groupBoundary("Outer End", 4770, 3),
					groupBoundary("Inner End", 4771, 3),
					layer({ name: "Inner White", id: 4772, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 255, 255, 255] }),
					groupBoundary("Inner Masked", 4773, 1, [128]),
					layer({ name: "Outer Black", id: 4774, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [0, 0, 0, 255] }),
					groupBoundary("Outer Isolated", 4775, 1),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/nested-group-mask", compositeGroups: true, layerIndices: [5] };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items).toMatchObject([
			{
				appliedGroupMasks: [
					{
						groupIndex: 3,
						name: "Inner Masked",
						executionModel: "bounded-group-mask-v1",
						maskCoverageMinimum: 128,
						maskCoverageMaximum: 128,
					},
				],
				groupComposite: { executionModel: "bounded-nested-isolated-group-v1", nestedGroupIndices: [3], maximumDepth: 2 },
			},
		]);
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([128, 128, 128, 255]);
	});

	test("executes a version-4 Curves adjustment with exact MCP point evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Master Invert Curve",
						id: 4500,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [
							additional(
								"curv",
								curvesAdjustmentV4([
									[
										[0, 255],
										[255, 0],
									],
								])
							),
						],
					}),
					layer({ name: "Curve Base", id: 4501, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 200] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/curves-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0]).toMatchObject({
			warnings: [],
			appliedAdjustments: [
				{
					layerIndex: 0,
					key: "curv",
					executionModel: "bounded-adjustment-v1",
					settings: {
						key: "curv",
						version: 4,
						curves: [
							{
								channel: 0,
								points: [
									{ input: 0, output: 255 },
									{ input: 255, output: 0 },
								],
							},
						],
					},
				},
			],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([245, 235, 225, 200]);
	});

	test("executes a linear-light Exposure adjustment with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Exposure +1",
						id: 4510,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("expA", Buffer.concat([u16(1), f32(1), f32(0), f32(1)]))],
					}),
					layer({ name: "Exposure Base", id: 4511, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [64, 128, 200, 150] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/exposure-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0]).toMatchObject({
			warnings: [],
			appliedAdjustments: [
				{
					layerIndex: 0,
					key: "expA",
					executionModel: "bounded-adjustment-v1",
					settings: { key: "expA", version: 1, exposure: 1, offset: 0, gamma: 1, colorModel: "linear-srgb-v1", bakeSupported: true },
				},
			],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([90, 176, 255, 150]);
	});

	test("executes a bounded Vibrance adjustment with exact MCP descriptor evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Vibrance +100",
						id: 4520,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("vibA", Buffer.concat([vibranceAdjustment(100, 0), Buffer.alloc(2)]))],
					}),
					layer({ name: "Vibrance Base", id: 4521, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [200, 100, 100, 123] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/vibrance-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0]).toMatchObject({
			warnings: [],
			appliedAdjustments: [
				{
					layerIndex: 0,
					key: "vibA",
					executionModel: "bounded-adjustment-v1",
					settings: {
						key: "vibA",
						descriptorVersion: 16,
						paddingBytes: 2,
						vibrance: 100,
						saturation: 0,
						colorModel: "bounded-hsl-vibrance-v1",
						bakeSupported: true,
					},
				},
			],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([221, 79, 79, 123]);
	});

	test("executes a bounded master Hue/Saturation adjustment with exact MCP channel evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Hue +120",
						id: 4530,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("hue2", hueSaturationAdjustment([120, 0, 0]))],
					}),
					layer({ name: "Hue Base", id: 4531, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 0, 0, 111] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/hue-saturation-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0]).toMatchObject({
			warnings: [],
			appliedAdjustments: [
				{
					layerIndex: 0,
					key: "hue2",
					executionModel: "bounded-adjustment-v1",
					settings: {
						key: "hue2",
						version: 2,
						sourceModel: "photoshop-5+",
						hueUnitScale: 1,
						colorize: false,
						paddingByte: 0,
						colorization: { hue: 0, saturation: 0, lightness: 0 },
						master: { hue: 120, saturation: 0, lightness: 0 },
						localAdjustmentsPresent: false,
						localRangeModel: "normalized-hextant-feather-v1",
						colorModel: "bounded-hsl-hue-v2",
						bakeSupported: true,
					},
				},
			],
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([0, 255, 0, 111]);
	});

	test("executes feathered local Hue/Saturation ranges and legacy Photoshop 4 hue units through extraction", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Local reds +120",
						id: 4540,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [
							additional(
								"hue2",
								hueSaturationAdjustment([0, 0, 0], [hueSaturationChannel([-100, -50, 50, 100], 120), ...Array.from({ length: 5 }, () => hueSaturationChannel())])
							),
						],
					}),
					layer({ name: "Local Hue Base", id: 4541, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 0, 0, 112] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const localOptions = { destinationFolder: "assets/hue-saturation-local-adjustment" };
		const localPlan = await getPsdLayerExtractionStatus(source, localOptions);
		expect(localPlan.items[0].appliedAdjustments[0]).toMatchObject({
			key: "hue2",
			settings: {
				sourceModel: "photoshop-5+",
				localAdjustmentsPresent: true,
				localRangeModel: "normalized-hextant-feather-v1",
				colorModel: "bounded-hsl-hue-v2",
				channels: expect.arrayContaining([{ name: "reds", range: [-100, -50, 50, 100], hue: 120, saturation: 0, lightness: 0 }]),
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, localOptions, localPlan.fingerprint);
		expect([...(await sharp(join(directory, localPlan.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([0, 255, 0, 112]);

		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Legacy hue +100",
						id: 4542,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("hue ", hueSaturationAdjustment([100, 0, 0]))],
					}),
					layer({ name: "Legacy Hue Base", id: 4543, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 0, 0, 113] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const legacyOptions = { destinationFolder: "assets/hue-saturation-legacy-adjustment" };
		const legacyPlan = await getPsdLayerExtractionStatus(source, legacyOptions);
		expect(legacyPlan.items[0].appliedAdjustments[0]).toMatchObject({
			key: "hue ",
			settings: { sourceModel: "photoshop-4", hueUnitScale: 1.8, master: { hue: 100, saturation: 0, lightness: 0 }, bakeSupported: true },
		});
		await applyPsdLayerExtraction(source, legacyOptions, legacyPlan.fingerprint);
		expect([...(await sharp(join(directory, legacyPlan.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([0, 255, 255, 113]);
	});

	test("executes bounded Color Balance tones with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Midtone Color Balance",
						id: 4550,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("blnc", colorBalanceAdjustment([20, -10, 30]))],
					}),
					layer({ name: "Color Balance Base", id: 4551, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [100, 100, 100, 114] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/color-balance-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "blnc",
			settings: {
				shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
				midtones: { cyanRed: 20, magentaGreen: -10, yellowBlue: 30 },
				highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
				preserveLuminosity: false,
				paddingByte: 0,
				tonalModel: "piecewise-luminance-tones-v1",
				colorModel: "bounded-rgb-color-balance-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([140, 80, 160, 114]);
	});

	test("executes bounded Black & White channel mixes with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Black White Mix",
						id: 4560,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("blwh", blackWhiteAdjustment())],
					}),
					layer({ name: "Black White Base", id: 4561, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 0, 0, 115] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/black-white-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "blwh",
			settings: {
				descriptorVersion: 16,
				reds: 40,
				yellows: 60,
				greens: 40,
				cyans: 60,
				blues: 20,
				magentas: 80,
				useTint: false,
				tintColor: { rgba: [120, 80, 40, 255] },
				presetKind: 1,
				presetFileName: "Custom",
				colorModel: "bounded-hue-mix-black-white-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([102, 102, 102, 115]);
	});

	test("executes bounded Channel Mixer matrices with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Channel Mixer Matrix",
						id: 4570,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("mixr", channelMixerAdjustment())],
					}),
					layer({ name: "Channel Mixer Base", id: 4571, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [100, 50, 25, 116] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/channel-mixer-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "mixr",
			settings: {
				version: 1,
				monochrome: false,
				red: { red: 0, green: 100, blue: 0, constant: 10, reservedWord: 0, total: 100 },
				green: { red: 0, green: 0, blue: 100, constant: 0, reservedWord: 0, total: 100 },
				blue: { red: 100, green: 0, blue: 0, constant: 0, reservedWord: 0, total: 100 },
				gray: { red: 40, green: 40, blue: 20, constant: 0, reservedWord: 0, total: 100 },
				monochromePaddingBytes: 0,
				colorModel: "bounded-linear-channel-mixer-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([76, 25, 100, 116]);
	});

	test("executes bounded Selective Color ranges with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Selective Red Cyan",
						id: 4580,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("selc", selectiveColorAdjustment())],
					}),
					layer({ name: "Selective Color Base", id: 4581, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [255, 0, 0, 118] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/selective-color-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "selc",
			settings: {
				version: 1,
				mode: "absolute",
				reservedBytes: 8,
				reds: { cyan: 100, magenta: 0, yellow: 0, black: 0 },
				rangeModel: "bounded-extrema-range-weights-v1",
				colorModel: "bounded-cmyk-selective-color-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([0, 0, 0, 118]);
	});

	test("executes bounded Gradient Map stops with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Gradient Map Red",
						id: 4590,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("grdm", gradientMapAdjustment())],
					}),
					layer({ name: "Gradient Map Base", id: 4591, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [128, 128, 128, 119] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/gradient-map-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "grdm",
			settings: {
				version: 1,
				name: "Red Map",
				gradientType: "solid",
				method: "classic",
				smoothnessRaw: 4096,
				gradientModel: "bounded-gradient-map-v1",
				noiseModel: "bounded-seeded-multioctave-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([128, 0, 0, 119]);
	});

	test("executes bounded Photo Filter tint with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Photo Filter Orange",
						id: 4600,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("phfl", photoFilterAdjustment())],
					}),
					layer({ name: "Photo Filter Base", id: 4601, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [100, 100, 100, 120] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/photo-filter-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "phfl",
			settings: {
				version: 2,
				color: { rgba: [255, 128, 0, 255] },
				density: 25,
				preserveLuminosity: false,
				colorModel: "bounded-hsl-photo-filter-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([139, 107, 75, 120]);
	});

	test("executes bounded embedded CUBE Color Lookup with exact MCP evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Color Lookup Invert Red",
						id: 4610,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						additionalInfo: [additional("clrL", colorLookupAdjustment())],
					}),
					layer({ name: "Color Lookup Base", id: 4611, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [64, 128, 192, 121] }),
				],
				{ width: 1, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/color-lookup-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "clrL",
			settings: {
				version: 1,
				lookupType: "3dlut",
				name: "Invert Red",
				lutFormat: "cube",
				lut3DFileName: "invert-red.cube",
				lutSize: 2,
				lutEntryCount: 8,
				colorModel: "bounded-trilinear-color-lookup-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([191, 128, 192, 121]);
	});

	test("executes raster-masked adjustments with exact MCP coverage evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Masked Invert",
						id: 4620,
						left: 0,
						top: 0,
						width: 0,
						height: 0,
						visible: true,
						opacity: 255,
						rgba: [],
						adjustmentOnly: true,
						mask: { top: 0, left: 0, width: 2, height: 1, plane: [0, 255], defaultColor: 0 },
						additionalInfo: [additional("nvrt", Buffer.alloc(0))],
					}),
					layer({ name: "Masked Invert Base", id: 4621, left: 0, top: 0, width: 2, height: 1, visible: true, opacity: 255, rgba: [10, 20, 30, 123, 10, 20, 30, 124] }),
				],
				{ width: 2, height: 1 }
			)
		);
		const options = { destinationFolder: "assets/masked-adjustment" };
		const planned = await getPsdLayerExtractionStatus(source, options);
		expect(planned.items[0].appliedAdjustments[0]).toMatchObject({
			key: "nvrt",
			maskExecutionModel: "bounded-adjustment-mask-v1",
			maskCoverageMinimum: 0,
			maskCoverageMaximum: 255,
		});
		expect(planned.items[0].warnings).not.toContain(expect.stringContaining("cannot yet sample"));
		await applyPsdLayerExtraction(source, options, planned.fingerprint);
		expect([...(await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer())]).toEqual([10, 20, 30, 123, 245, 235, 225, 124]);
	});

	test("exposes paginated inspect and exact confirmed extraction through editor MCP actions", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const inspected = await inspectPsdLayerExtraction(scene, { path: "assets/hero.psd", includeHidden: true, offset: 0, limit: 1 });
		expect(inspected).toMatchObject({ selectedLayerCount: 2, returnedLayerCount: 1, hasMore: true, nextOffset: 1, layers: [{ name: "Hero Body" }] });
		await expect(
			extractPsdLayers(scene, { path: "assets/hero.psd", includeHidden: true, expectedFingerprint: inspected.fingerprint, confirm: false }, {} as never)
		).rejects.toThrow("confirm=true");
		let refreshed = 0;
		const extracted = await extractPsdLayers(scene, { path: "assets/hero.psd", includeHidden: true, expectedFingerprint: inspected.fingerprint, confirm: true }, {
			editor: { layout: { assets: { refresh: () => refreshed++ } } },
		} as never);
		expect(extracted).toMatchObject({ extracted: true, selectedLayerCount: 2, createdCount: 2 });
		expect(refreshed).toBe(1);
		expect(await pathExists(join(directory, "assets/hero_layers/0002-Hidden FX.png"))).toBe(true);
		scene.dispose();
		engine.dispose();
	});

	test("composites a clipped multiply layer into the base bounds and retains exact group evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({ name: "Tint", id: 201, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, clipping: true, blendMode: "mul ", rgba: [128, 255, 128, 255] }),
				layer({ name: "Base", id: 202, left: 0, top: 0, width: 2, height: 1, visible: true, opacity: 255, rgba: [200, 100, 50, 255, 20, 40, 60, 128] }),
			])
		);
		const planned = await getPsdLayerExtractionStatus(source);
		expect(planned).toMatchObject({
			compositeClippingGroups: true,
			selectedLayerCount: 1,
			items: [{ layerIndex: 1, name: "Base", clippedLayerIndices: [0], clippedLayerNames: ["Tint"], blendModes: ["mul "] }],
		});
		await applyPsdLayerExtraction(source, {}, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([100, 100, 25, 255, 20, 40, 60, 128]);

		const isolated = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/isolated", compositeClippingGroups: false });
		expect(isolated).toMatchObject({ compositeClippingGroups: false, selectedLayerCount: 2 });
		expect(isolated.items.find((item) => item.layerIndex === 0)?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Clipping-group")]));
	});

	test.each([
		["hue ", [197, 77, 170, 255]],
		["sat ", [59, 178, 0, 255]],
		["colr", [233, 53, 193, 255]],
		["lum ", [67, 147, 27, 255]],
	] as const)("composites the non-separable %s clipping blend with exact color math", async (blendMode, expectedPixels) => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({ name: "Blend", id: 301, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, clipping: true, blendMode, rgba: [220, 40, 180, 255] }),
				layer({ name: "Base", id: 302, left: 0, top: 0, width: 1, height: 1, visible: true, opacity: 255, rgba: [80, 160, 40, 255] }),
			])
		);
		const planned = await getPsdLayerExtractionStatus(source, { destinationFolder: `assets/${blendMode.trim()}-layers` });
		expect(planned).toMatchObject({ selectedLayerCount: 1, items: [{ clippedLayerIndices: [0], clippedLayerNames: ["Blend"], blendModes: [blendMode], warnings: [] }] });
		await applyPsdLayerExtraction(source, { destinationFolder: `assets/${blendMode.trim()}-layers` }, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual(expectedPixels);
	});

	test("bakes a bounded legacy Solid Fill effect with exact plan evidence and an opt-out", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Overlay",
					id: 501,
					left: 0,
					top: 0,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [20, 40, 60, 128],
					additionalInfo: [additional("lrFX", legacySolidFillEffect({ color: [200, 50, 10], opacity: 128 }))],
				}),
			])
		);
		const planned = await getPsdLayerExtractionStatus(source);
		expect(planned).toMatchObject({
			applyLayerEffects: true,
			items: [
				{
					warnings: [],
					appliedLayerEffects: [
						{ layerIndex: 0, layerName: "Overlay", effectIndex: 1, key: "sofi", type: "solidFill", blendMode: "norm", opacity: 128, color: [200, 50, 10, 255] },
					],
				},
			],
		});
		await applyPsdLayerExtraction(source, {}, planned.fingerprint);
		const pixels = await sharp(join(directory, planned.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([110, 45, 35, 128]);

		const raw = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/raw-effects", applyLayerEffects: false });
		expect(raw).toMatchObject({ applyLayerEffects: false, items: [{ appliedLayerEffects: [], warnings: [expect.stringContaining("Layer effect sofi #2")] }] });
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/raw-effects", applyLayerEffects: false }, raw.fingerprint);
		const rawPixels = await sharp(join(directory, raw.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...rawPixels]).toEqual([20, 40, 60, 128]);
	});

	test("bakes bounded legacy inner-shadow and inner-glow effects with exact evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Shadow",
					id: 601,
					left: 0,
					top: 0,
					width: 3,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255],
					additionalInfo: [additional("lrFX", legacyInnerShadowEffect({ color: [0, 0, 0], blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100 }))],
				}),
			])
		);
		const shadowPlan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/shadow-layers" });
		expect(shadowPlan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({ key: "isdw", type: "innerShadow", blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100, useGlobalAngle: false }),
		]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/shadow-layers" }, shadowPlan.fingerprint);
		const shadowPixels = await sharp(join(directory, shadowPlan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...shadowPixels]).toEqual([0, 0, 0, 255, 100, 100, 100, 255, 100, 100, 100, 255]);

		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Glow",
					id: 602,
					left: 0,
					top: 0,
					width: 3,
					height: 3,
					visible: true,
					opacity: 255,
					rgba: Array.from({ length: 9 }, () => [100, 100, 100, 255]).flat(),
					additionalInfo: [additional("lrFX", legacyInnerGlowEffect({ color: [255, 255, 255], blur: 1, intensity: 100, opacity: 100 }))],
				}),
			])
		);
		const glowPlan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/glow-layers" });
		expect(glowPlan.items[0].appliedLayerEffects).toEqual([expect.objectContaining({ key: "iglw", type: "innerGlow", blur: 1, intensity: 100, opacity: 100, invert: false })]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/glow-layers" }, glowPlan.fingerprint);
		const glowPixels = await sharp(join(directory, glowPlan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...glowPixels]).toEqual([
			186, 186, 186, 255, 152, 152, 152, 255, 186, 186, 186, 255, 152, 152, 152, 255, 100, 100, 100, 255, 152, 152, 152, 255, 186, 186, 186, 255, 152, 152, 152, 255, 186,
			186, 186, 255,
		]);
	});

	test("expands bounds for legacy drop-shadow and outer-glow effects without clipping", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Drop",
					id: 701,
					left: 4,
					top: 5,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255],
					additionalInfo: [additional("lrFX", legacyDropShadowEffect({ color: [0, 0, 0], blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100 }))],
				}),
			])
		);
		const dropPlan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/drop-layers" });
		expect(dropPlan.items[0]).toMatchObject({ left: 4, top: 5, width: 2, height: 1, warnings: [] });
		expect(dropPlan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({ key: "dsdw", type: "dropShadow", blur: 0, intensity: 100, angle: 0, distance: 1, opacity: 100 }),
		]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/drop-layers" }, dropPlan.fingerprint);
		const dropPixels = await sharp(join(directory, dropPlan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...dropPixels]).toEqual([100, 100, 100, 255, 0, 0, 0, 255]);

		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Outer",
					id: 702,
					left: 4,
					top: 5,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255],
					additionalInfo: [additional("lrFX", legacyOuterGlowEffect({ color: [255, 255, 255], blur: 1, intensity: 100, opacity: 100 }))],
				}),
			])
		);
		const outerPlan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/outer-layers" });
		expect(outerPlan.items[0]).toMatchObject({ left: 3, top: 4, width: 3, height: 3, warnings: [] });
		expect(outerPlan.items[0].appliedLayerEffects).toEqual([expect.objectContaining({ key: "oglw", type: "outerGlow", blur: 1, intensity: 100, opacity: 100 })]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/outer-layers" }, outerPlan.fingerprint);
		const outerPixels = await sharp(join(directory, outerPlan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...outerPixels]).toEqual([
			255, 255, 255, 28, 255, 255, 255, 28, 255, 255, 255, 28, 255, 255, 255, 28, 100, 100, 100, 255, 255, 255, 255, 28, 255, 255, 255, 28, 255, 255, 255, 28, 255, 255, 255,
			28,
		]);
	});

	test("bakes bounded legacy bevel highlight and shadow edges with exact evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Bevel",
					id: 801,
					left: 4,
					top: 5,
					width: 3,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255],
					additionalInfo: [
						additional(
							"lrFX",
							legacyBevelEffect({
								highlightColor: [255, 255, 255],
								shadowColor: [0, 0, 0],
								angle: 0,
								strength: 1,
								blur: 0,
								highlightOpacity: 100,
								shadowOpacity: 100,
							})
						),
					],
				}),
			])
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/bevel-layers" });
		expect(plan.items[0]).toMatchObject({ left: 4, top: 5, width: 3, height: 1, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "bevl",
				type: "bevel",
				angle: 0,
				strength: 1,
				blur: 0,
				highlightBlendMode: "scrn",
				shadowBlendMode: "mul ",
				highlightOpacity: 100,
				shadowOpacity: 100,
				style: 1,
				styleName: "outer bevel",
				direction: 0,
			}),
		]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/bevel-layers" }, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([255, 255, 255, 255, 100, 100, 100, 255, 0, 0, 0, 255]);
	});

	test("bakes a modern lfx2 solid-color outside Stroke with expanded bounds and exact evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Modern Stroke",
					id: 901,
					left: 4,
					top: 5,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255],
					additionalInfo: [additional("lfx2", modernStrokeEffect({ color: [255, 0, 0], size: 1, opacity: 100 }))],
				}),
			])
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/stroke-layers" });
		expect(plan.items[0]).toMatchObject({ left: 3, top: 4, width: 3, height: 3, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "FrFX",
				type: "stroke",
				position: "outside",
				fillType: "solidColor",
				size: 1,
				sizeUnits: "#Pxl",
				blendMode: "norm",
				opacity: 100,
				color: [255, 0, 0, 255],
				present: true,
				showInDialog: true,
			}),
		]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/stroke-layers" }, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([
			255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 100, 100, 100, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
		]);
	});

	test("bakes a modern lfx2 Color Overlay with percent opacity and exact evidence", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Color Overlay",
					id: 901,
					left: 4,
					top: 5,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255],
					additionalInfo: [additional("lfx2", modernColorOverlayEffect())],
				}),
			])
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/color-overlay-layers" });
		expect(plan.items[0]).toMatchObject({ left: 4, top: 5, width: 1, height: 1, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "sofi",
				type: "solidFill",
				source: "lfx2",
				blendMode: "mul ",
				opacity: 40,
				color: [200, 50, 10, 255],
			}),
		]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/color-overlay-layers" }, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([91, 68, 62, 255]);
	});

	test("bakes modern lfx2 solid and seeded-noise Gradient Overlays with exact evidence and deterministic pixels", async () => {
		const actual: Record<string, number[]> = {};
		for (const type of ["solid", "noise"] as const) {
			const caseSource = join(directory, `gradient-overlay-${type}.psd`);
			await writeFile(
				caseSource,
				createLayeredPsd([
					layer({
						name: `Gradient Overlay ${type}`,
						id: type === "solid" ? 903 : 904,
						left: 4,
						top: 5,
						width: 2,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [100, 100, 100, 255, 100, 100, 100, 255],
						additionalInfo: [additional("lfx2", modernGradientOverlayEffect(type))],
					}),
				])
			);
			const destinationFolder = `assets/gradient-overlay-${type}`;
			const plan = await getPsdLayerExtractionStatus(caseSource, { destinationFolder });
			expect(plan.items[0]).toMatchObject({ left: 4, top: 5, width: 2, height: 1, warnings: [] });
			expect(plan.items[0].appliedLayerEffects).toEqual([
				expect.objectContaining({
					key: "GrFl",
					type: "gradientOverlay",
					source: "lfx2",
					blendMode: "norm",
					opacity: 75,
					present: true,
					showInDialog: false,
					gradient: expect.objectContaining({
						type,
						executionModel: type === "solid" ? "bounded-solid-v2" : "bounded-seeded-v1",
						bakeSupported: true,
					}),
				}),
			]);
			await applyPsdLayerExtraction(caseSource, { destinationFolder }, plan.fingerprint);
			actual[type] = [...(await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer())];
		}
		expect(actual).toEqual({
			solid: [193, 25, 128, 255, 128, 25, 193, 255],
			noise: [111, 110, 112, 255, 107, 112, 107, 255],
		});
	});

	test("bakes modern lfx2 Drop Shadow and innerShadowMulti in descriptor order with exact evidence", async () => {
		const caseSource = join(directory, "modern-shadows.psd");
		await writeFile(
			caseSource,
			createLayeredPsd([
				layer({
					name: "Modern Shadows",
					id: 905,
					left: 4,
					top: 5,
					width: 2,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255, 100, 100, 100, 255],
					additionalInfo: [additional("lmfx", modernShadowEffects())],
				}),
			])
		);
		const options = { destinationFolder: "assets/modern-shadows" };
		const plan = await getPsdLayerExtractionStatus(caseSource, options);
		expect(plan.items[0]).toMatchObject({ left: 4, top: 5, width: 3, height: 1, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "dsdw",
				type: "dropShadow",
				effectIndex: 0,
				source: "lfx2",
				opacity: 50,
				blur: 0,
				distance: 1,
				present: true,
				showInDialog: false,
				choke: 0,
				antialiased: true,
				noise: 0,
				contour: null,
				layerConceals: true,
				executionModel: "bounded-shadow-v2",
			}),
			expect.objectContaining({
				key: "isdw",
				type: "innerShadow",
				effectIndex: 1,
				source: "lfx2",
				opacity: 50,
				blur: 0,
				distance: 1,
				present: true,
				showInDialog: true,
				choke: 0,
				antialiased: true,
				noise: 0,
				contour: null,
				executionModel: "bounded-shadow-v2",
			}),
		]);
		await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([178, 50, 50, 255, 100, 100, 100, 255, 0, 0, 0, 128]);
	});

	test("bakes all five valid lmfx multiple-instance families with exact list provenance", async () => {
		const caseSource = join(directory, "all-multiple-effects.psd");
		await writeFile(
			caseSource,
			createLayeredPsd([
				layer({
					name: "All Multiple Effects",
					id: 954,
					left: 2,
					top: 3,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [20, 40, 60, 255],
					additionalInfo: [additional("lmfx", modernMultipleInstanceEffects())],
				}),
			])
		);
		const options = { destinationFolder: "assets/all-multiple-effects" };
		const plan = await getPsdLayerExtractionStatus(caseSource, options);
		expect(plan.items[0]).toMatchObject({ left: 2, top: 3, width: 1, height: 1, warnings: [] });
		expect(
			plan.items[0].appliedLayerEffects.map((effect) => ({
				effectIndex: effect.effectIndex,
				descriptorKey: effect.descriptorKey,
				descriptorListIndex: effect.descriptorListIndex,
			}))
		).toEqual([
			{ effectIndex: 0, descriptorKey: "gradientFillMulti", descriptorListIndex: 0 },
			{ effectIndex: 1, descriptorKey: "gradientFillMulti", descriptorListIndex: 1 },
			{ effectIndex: 2, descriptorKey: "dropShadowMulti", descriptorListIndex: 0 },
			{ effectIndex: 3, descriptorKey: "dropShadowMulti", descriptorListIndex: 1 },
			{ effectIndex: 4, descriptorKey: "frameFXMulti", descriptorListIndex: 0 },
			{ effectIndex: 5, descriptorKey: "frameFXMulti", descriptorListIndex: 1 },
			{ effectIndex: 6, descriptorKey: "solidFillMulti", descriptorListIndex: 0 },
			{ effectIndex: 7, descriptorKey: "solidFillMulti", descriptorListIndex: 1 },
			{ effectIndex: 8, descriptorKey: "innerShadowMulti", descriptorListIndex: 0 },
			{ effectIndex: 9, descriptorKey: "innerShadowMulti", descriptorListIndex: 1 },
		]);
		await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([132, 7, 11, 255]);
	});

	test("bakes modern shadow choke, custom contour, hard-contour sampling, and deterministic noise", async () => {
		const caseSource = join(directory, "advanced-modern-shadows.psd");
		await writeFile(
			caseSource,
			createLayeredPsd(
				[
					layer({
						name: "Advanced Modern Shadows",
						id: 951,
						left: 4,
						top: 5,
						width: 3,
						height: 3,
						visible: true,
						opacity: 255,
						rgba: Array.from({ length: 9 }, () => [100, 100, 100, 255]).flat(),
						additionalInfo: [
							additional(
								"lmfx",
								modernShadowEffects({
									choke: 1,
									noise: 30,
									antialiased: false,
									contour: [
										[0, 0],
										[128, 224],
										[255, 255],
									],
								})
							),
						],
					}),
				],
				{ width: 12, height: 12 }
			)
		);
		const options = { destinationFolder: "assets/advanced-modern-shadows" };
		const plan = await getPsdLayerExtractionStatus(caseSource, options);
		expect(plan.items[0]).toMatchObject({ left: 3, top: 4, width: 6, height: 5, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "dsdw",
				type: "dropShadow",
				choke: 1,
				noise: 30,
				antialiased: false,
				contour: expect.objectContaining({ name: "Shadow Ramp", valid: true, linear: false }),
				executionModel: "bounded-shadow-v2",
			}),
			expect.objectContaining({
				key: "isdw",
				type: "innerShadow",
				choke: 1,
				noise: 30,
				antialiased: false,
				contour: expect.objectContaining({ name: "Shadow Ramp", valid: true, linear: false }),
				executionModel: "bounded-shadow-v2",
			}),
		]);
		await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(pixels).digest("hex")).toBe("c39040720730f4651c63c11763558f5abd49428317f952e381d72637c59eb079");
	});

	test("bakes modern lmfx Outer Glow and Inner Glow in descriptor order with exact evidence", async () => {
		const caseSource = join(directory, "modern-glows.psd");
		await writeFile(
			caseSource,
			createLayeredPsd([
				layer({
					name: "Modern Glows",
					id: 906,
					left: 4,
					top: 5,
					width: 2,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255, 100, 100, 100, 255],
					additionalInfo: [additional("lmfx", modernGlowEffects())],
				}),
			])
		);
		const options = { destinationFolder: "assets/modern-glows" };
		const plan = await getPsdLayerExtractionStatus(caseSource, options);
		expect(plan.items[0]).toMatchObject({ left: 3, top: 4, width: 4, height: 3, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "oglw",
				type: "outerGlow",
				effectIndex: 0,
				source: "lfx2",
				opacity: 50,
				blur: 1,
				present: true,
				showInDialog: false,
				choke: 0,
				antialiased: true,
				noise: 0,
				range: 50,
				jitter: 0,
				glowSource: "edge",
				technique: "softer",
				executionModel: "bounded-glow-v2",
				contour: {
					name: "Linear",
					points: [
						{ x: 0, y: 0 },
						{ x: 255, y: 255 },
					],
					linear: true,
					valid: true,
				},
			}),
			expect.objectContaining({
				key: "iglw",
				type: "innerGlow",
				effectIndex: 1,
				source: "lfx2",
				opacity: 50,
				blur: 1,
				present: true,
				showInDialog: true,
				glowSource: "edge",
				technique: "softer",
				executionModel: "bounded-glow-v2",
				invert: false,
			}),
		]);
		await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([
			255, 255, 255, 14, 255, 255, 255, 28, 255, 255, 255, 28, 255, 255, 255, 14, 255, 255, 255, 14, 160, 61, 61, 255, 160, 61, 61, 255, 255, 255, 255, 14, 255, 255, 255, 14,
			255, 255, 255, 28, 255, 255, 255, 28, 255, 255, 255, 14,
		]);
	});

	test("keeps a precise Outer Glow visible at the first pixel beyond an opaque edge without jitter", async () => {
		const caseSource = join(directory, "precise-outer-glow.psd");
		await writeFile(
			caseSource,
			createLayeredPsd([
				layer({
					name: "Precise Outer Glow",
					id: 9062,
					left: 4,
					top: 5,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255],
					additionalInfo: [additional("lmfx", modernGlowEffects({ technique: "PrBL" }))],
				}),
			])
		);
		const options = { destinationFolder: "assets/precise-outer-glow" };
		const plan = await getPsdLayerExtractionStatus(caseSource, options);
		expect(plan.items[0]).toMatchObject({ left: 3, top: 4, width: 3, height: 3, warnings: [] });
		await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(pixels[1 * 4 + 3]).toBeGreaterThan(0);
		expect(pixels[4 * 4 + 3]).toBe(255);
	});

	test("bakes advanced modern Glow choke, noise, jitter, range, contour, center source, and precise technique", async () => {
		const caseSource = join(directory, "advanced-modern-glows.psd");
		await writeFile(
			caseSource,
			createLayeredPsd([
				layer({
					name: "Advanced Modern Glows",
					id: 9061,
					left: 4,
					top: 5,
					width: 3,
					height: 3,
					visible: true,
					opacity: 255,
					rgba: Array.from({ length: 9 }, () => [100, 100, 100, 255]).flat(),
					additionalInfo: [
						additional(
							"lmfx",
							modernGlowEffects({
								choke: 1,
								noise: 30,
								range: 75,
								jitter: 100,
								innerSource: "SrcC",
								technique: "PrBL",
								antialiased: false,
								contour: [
									[0, 0],
									[128, 224],
									[255, 255],
								],
							})
						),
					],
				}),
			])
		);
		const options = { destinationFolder: "assets/advanced-modern-glows" };
		const plan = await getPsdLayerExtractionStatus(caseSource, options);
		expect(plan.items[0]).toMatchObject({ left: 1, top: 2, width: 9, height: 9, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "oglw",
				type: "outerGlow",
				effectIndex: 0,
				choke: 1,
				noise: 30,
				range: 75,
				jitter: 100,
				glowSource: "edge",
				technique: "precise",
				antialiased: false,
				contour: expect.objectContaining({ name: "Glow Ramp", valid: true, linear: false }),
				executionModel: "bounded-glow-v2",
			}),
			expect.objectContaining({
				key: "iglw",
				type: "innerGlow",
				effectIndex: 1,
				choke: 1,
				noise: 30,
				range: 75,
				jitter: 100,
				glowSource: "center",
				technique: "precise",
				antialiased: false,
				contour: expect.objectContaining({ name: "Glow Ramp", valid: true, linear: false }),
				executionModel: "bounded-glow-v2",
			}),
		]);
		await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect(createHash("sha256").update(pixels).digest("hex")).toBe("b7d0ef6988a5da3bafbcf1ea91eadd4b00b91db8e513878f99b9c89e1f66eae5");
	});

	test("bakes modern lmfx Satin and inner Bevel in descriptor order with exact evidence", async () => {
		const caseSource = join(directory, "modern-bevel-satin.psd");
		await writeFile(
			caseSource,
			createLayeredPsd([
				layer({
					name: "Modern Bevel Satin",
					id: 907,
					left: 4,
					top: 5,
					width: 3,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255],
					additionalInfo: [additional("lmfx", modernBevelSatinEffects())],
				}),
			])
		);
		const options = { destinationFolder: "assets/modern-bevel-satin" };
		const plan = await getPsdLayerExtractionStatus(caseSource, options);
		expect(plan.items[0]).toMatchObject({ left: 4, top: 5, width: 3, height: 1, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "ChFX",
				type: "satin",
				effectIndex: 0,
				source: "lfx2",
				opacity: 50,
				angle: 0,
				distance: 1,
				size: 0,
				antialiased: true,
				invert: false,
				present: true,
				showInDialog: false,
				contour: {
					name: "Custom Satin",
					points: [
						{ x: 0, y: 0 },
						{ x: 128, y: 64 },
						{ x: 255, y: 255 },
					],
					linear: false,
					valid: true,
				},
				executionModel: "bounded-satin-v1",
			}),
			expect.objectContaining({
				key: "bevl",
				type: "bevel",
				effectIndex: 1,
				source: "lfx2",
				styleName: "inner bevel",
				size: 1,
				depth: 100,
				soften: 0,
				altitude: 90,
				technique: "smooth",
				present: true,
				showInDialog: true,
				contour: {
					name: "Linear",
					points: [
						{ x: 0, y: 0 },
						{ x: 255, y: 255 },
					],
					linear: true,
					valid: true,
				},
				executionModel: "bounded-bevel-v2",
			}),
		]);
		await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([153, 153, 217, 255, 100, 100, 100, 255, 25, 25, 89, 255]);
	});

	test("bakes every modern Bevel style with smooth/chisel, shape-contour, and embedded-texture evidence", async () => {
		const cases = [
			{ name: "outer", style: "OtrB", styleName: "outer bevel", technique: "SfBL", techniqueName: "smooth", width: 5 },
			{ name: "inner", style: "InrB", styleName: "inner bevel", technique: "PrBL", techniqueName: "chisel hard", width: 3 },
			{ name: "emboss", style: "Embs", styleName: "emboss", technique: "Slmt", techniqueName: "chisel soft", width: 5 },
			{ name: "pillow", style: "PlEb", styleName: "pillow emboss", technique: "SfBL", techniqueName: "smooth", width: 5 },
			{ name: "stroke", style: "strokeEmboss", styleName: "stroke emboss", technique: "PrBL", techniqueName: "chisel hard", width: 5 },
		] as const;
		const hashes: Record<string, string> = {};
		for (const item of cases) {
			const caseSource = join(directory, `${item.name}-advanced-bevel.psd`);
			await writeFile(
				caseSource,
				createLayeredPsd(
					[
						layer({
							name: `${item.styleName} advanced`,
							id: 950,
							left: 4,
							top: 4,
							width: 3,
							height: 3,
							visible: true,
							opacity: 255,
							rgba: [
								100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100,
								100, 100, 255, 100, 100, 100, 255,
							],
							additionalInfo: [
								additional(
									"lmfx",
									modernBevelSatinEffects({
										style: item.style,
										technique: item.technique,
										direction: "Out ",
										useShape: true,
										useTexture: true,
										includeSatin: false,
									})
								),
							],
						}),
					],
					{ width: 12, height: 12 },
					patternTaggedBlock()
				)
			);
			const options = { destinationFolder: `assets/${item.name}-advanced-bevel` };
			const plan = await getPsdLayerExtractionStatus(caseSource, options);
			expect(plan.items[0]).toMatchObject({ width: item.width, height: item.width, warnings: [] });
			expect(plan.items[0].appliedLayerEffects).toEqual([
				expect.objectContaining({
					key: "bevl",
					type: "bevel",
					styleName: item.styleName,
					technique: item.techniqueName,
					direction: 1,
					useShape: true,
					shapeContour: expect.objectContaining({ name: "Shape Ramp", valid: true }),
					shapeRange: 75,
					useTexture: true,
					texturePattern: expect.objectContaining({ id: "rgba-tile-2x2", resolvedPatternIndex: 0, bakeSupported: true }),
					embeddedTexturePattern: expect.objectContaining({ name: "RGBA Tile", width: 2, height: 2 }),
					textureDepth: 80,
					textureInvert: true,
					executionModel: "bounded-bevel-v2",
				}),
			]);
			await applyPsdLayerExtraction(caseSource, options, plan.fingerprint);
			const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
			hashes[item.name] = createHash("sha256").update(pixels).digest("hex");
		}
		expect(hashes).toEqual({
			outer: "132f1a106813f26073ba862b6254b443cbb0457e997e40ded3ccabbccbfe3e71",
			inner: "1317a8bfb06c972b90f89295116ad72c7b8fd0fa667a1e05e3db19130a91806e",
			emboss: "47201b41bd32a8ff5d8a7a604a813b56211a4c2a0155e46a8ee2ef1f456cbca8",
			pillow: "3d44c627f4424bd36e521d4a93d58a2f259450c1d116ba20668e1fd5050cd1bb",
			stroke: "0c1a25078f1e0bbf43d08881772b2165956e78b8bfbd2bc244279d4b9d95be37",
		});
	});

	test("bakes a modern lfx2 aligned classic solid-gradient outside Stroke with exact stops and pixels", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Gradient Stroke",
					id: 902,
					left: 4,
					top: 5,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255],
					additionalInfo: [additional("lfx2", modernGradientStrokeEffect())],
				}),
			])
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/gradient-stroke-layers" });
		expect(plan.items[0]).toMatchObject({ left: 3, top: 4, width: 3, height: 3, warnings: [] });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "FrFX",
				type: "stroke",
				position: "outside",
				fillType: "gradient",
				color: null,
				gradient: expect.objectContaining({
					type: "solid",
					name: "Red Blue",
					style: "linear",
					interpolation: "classic",
					angle: 0,
					scale: 100,
					executionModel: "bounded-solid-v2",
					bakeSupported: true,
				}),
			}),
		]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/gradient-stroke-layers" }, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([
			236, 0, 19, 255, 128, 0, 128, 255, 19, 0, 236, 255, 236, 0, 19, 255, 100, 100, 100, 255, 19, 0, 236, 255, 236, 0, 19, 255, 128, 0, 128, 255, 19, 0, 236, 255,
		]);
	});

	test("bakes radial, angle, reflected, and diamond modern solid-gradient Stroke styles deterministically", async () => {
		const cases: Array<{ style: "Rdl " | "Angl" | "Rflc" | "Dmnd"; name: string; pixels: number[] }> = [
			{
				style: "Rdl ",
				name: "radial",
				pixels: [2, 0, 253, 255, 66, 0, 189, 255, 2, 0, 253, 255, 66, 0, 189, 255, 100, 100, 100, 255, 66, 0, 189, 255, 2, 0, 253, 255, 66, 0, 189, 255, 2, 0, 253, 255],
			},
			{
				style: "Angl",
				name: "angle",
				pixels: [
					81, 0, 174, 255, 40, 0, 215, 255, 11, 0, 244, 255, 128, 0, 128, 255, 100, 100, 100, 255, 255, 0, 0, 255, 174, 0, 81, 255, 215, 0, 40, 255, 244, 0, 11, 255,
				],
			},
			{
				style: "Rflc",
				name: "reflected",
				pixels: [66, 0, 189, 255, 255, 0, 0, 255, 66, 0, 189, 255, 66, 0, 189, 255, 100, 100, 100, 255, 66, 0, 189, 255, 66, 0, 189, 255, 255, 0, 0, 255, 66, 0, 189, 255],
			},
			{
				style: "Dmnd",
				name: "diamond",
				pixels: [0, 0, 255, 255, 66, 0, 189, 255, 0, 0, 255, 255, 66, 0, 189, 255, 100, 100, 100, 255, 66, 0, 189, 255, 0, 0, 255, 255, 66, 0, 189, 255, 0, 0, 255, 255],
			},
		];
		for (const item of cases) {
			const caseSource = join(directory, `${item.name}.psd`);
			await writeFile(
				caseSource,
				createLayeredPsd([
					layer({
						name: `${item.name} gradient`,
						id: 910,
						left: 4,
						top: 5,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [100, 100, 100, 255],
						additionalInfo: [additional("lfx2", modernGradientStrokeEffect({ style: item.style }))],
					}),
				])
			);
			const destinationFolder = `assets/${item.name}-gradient-stroke`;
			const plan = await getPsdLayerExtractionStatus(caseSource, { destinationFolder });
			expect(plan.items[0].appliedLayerEffects[0]).toMatchObject({ fillType: "gradient", gradient: { style: item.name, bakeSupported: true } });
			await applyPsdLayerExtraction(caseSource, { destinationFolder }, plan.fingerprint);
			const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
			expect([...pixels], item.name).toEqual(item.pixels);
		}
	});

	test("bakes document-aligned dithered Classic, Linear, Perceptual, and Smooth solid gradients with exact pixels", async () => {
		const cases = [
			{ name: "classic-v2", encoded: "Gcls" as const, interpolation: "classic" },
			{ name: "linear-light", encoded: "Lnr " as const, interpolation: "linear" },
			{ name: "perceptual", encoded: "Perc" as const, interpolation: "perceptual" },
			{ name: "smooth", encoded: "Smoo" as const, interpolation: "smooth" },
		];
		const actual: Record<string, number[]> = {};
		for (const item of cases) {
			const caseSource = join(directory, `${item.name}.psd`);
			await writeFile(
				caseSource,
				createLayeredPsd(
					[
						layer({
							name: `${item.interpolation} unaligned dither`,
							id: 920,
							left: 3,
							top: 2,
							width: 1,
							height: 1,
							visible: true,
							opacity: 255,
							rgba: [100, 100, 100, 255],
							additionalInfo: [additional("lfx2", modernGradientStrokeEffect({ interpolation: item.encoded, align: false, dither: true }))],
						}),
					],
					{ width: 8, height: 6 }
				)
			);
			const destinationFolder = `assets/${item.name}-gradient-stroke`;
			const plan = await getPsdLayerExtractionStatus(caseSource, { destinationFolder });
			expect(plan.items[0]).toMatchObject({ left: 2, top: 1, width: 3, height: 3, warnings: [] });
			expect(plan.items[0].appliedLayerEffects[0]).toMatchObject({
				fillType: "gradient",
				gradient: {
					interpolation: item.interpolation,
					align: false,
					dither: true,
					executionModel: "bounded-solid-v2",
					bakeSupported: true,
				},
			});
			await applyPsdLayerExtraction(caseSource, { destinationFolder }, plan.fingerprint);
			const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
			actual[item.name] = [...pixels];
		}
		expect(actual).toEqual({
			"classic-v2": [
				196, 0, 59, 255, 151, 0, 104, 255, 104, 0, 151, 255, 195, 0, 59, 255, 100, 100, 100, 255, 103, 0, 151, 255, 196, 0, 59, 255, 151, 0, 104, 255, 104, 0, 151, 255,
			],
			"linear-light": [
				216, 0, 152, 255, 198, 0, 177, 255, 177, 0, 198, 255, 216, 0, 151, 255, 100, 100, 100, 255, 176, 0, 197, 255, 216, 0, 152, 255, 197, 0, 176, 255, 177, 0, 198, 255,
			],
			perceptual: [
				184, 78, 124, 255, 155, 83, 150, 255, 126, 82, 174, 255, 183, 77, 123, 255, 100, 100, 100, 255, 125, 82, 174, 255, 184, 78, 123, 255, 155, 82, 150, 255, 126, 82,
				175, 255,
			],
			smooth: [209, 0, 46, 255, 157, 0, 98, 255, 98, 0, 157, 255, 209, 0, 45, 255, 100, 100, 100, 255, 98, 0, 157, 255, 209, 0, 46, 255, 157, 0, 98, 255, 98, 0, 157, 255],
		});
	});

	test("bakes a resolved embedded Patt tile into a modern pattern outside Stroke", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Pattern Stroke",
						id: 930,
						left: 4,
						top: 5,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [100, 100, 100, 255],
						additionalInfo: [additional("lfx2", modernPatternEffect("stroke"))],
					}),
				],
				{ width: 8, height: 8 },
				patternTaggedBlock()
			)
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/pattern-stroke-layers" });
		expect(plan.document.patterns).toEqual([
			expect.objectContaining({ name: "RGBA Tile", id: "rgba-tile-2x2", width: 2, height: 2, colorMode: "rgb", channelCount: 4, bakeSupported: true }),
		]);
		expect(plan.items[0]).toMatchObject({ left: 3, top: 4, width: 3, height: 3, warnings: [] });
		expect(plan.items[0].appliedLayerEffects[0]).toMatchObject({
			key: "FrFX",
			type: "stroke",
			fillType: "pattern",
			pattern: {
				id: "rgba-tile-2x2",
				resolvedPatternIndex: 0,
				resolvedWidth: 2,
				resolvedHeight: 2,
				executionModel: "bounded-pattern-v1",
			},
			embeddedPattern: { name: "RGBA Tile", width: 2, height: 2, channelCount: 4 },
		});
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/pattern-stroke-layers" }, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([
			255, 0, 0, 255, 0, 255, 0, 128, 255, 0, 0, 255, 0, 0, 255, 255, 100, 100, 100, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 128, 255, 0, 0, 255,
		]);
	});

	test("bakes a resolved embedded Patt tile into a modern Pattern Overlay", async () => {
		await writeFile(
			source,
			createLayeredPsd(
				[
					layer({
						name: "Pattern Overlay",
						id: 931,
						left: 0,
						top: 0,
						width: 2,
						height: 2,
						visible: true,
						opacity: 255,
						rgba: [100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255, 100, 100, 100, 255],
						additionalInfo: [additional("lfx2", modernPatternEffect("overlay"))],
					}),
				],
				{ width: 2, height: 2 },
				patternTaggedBlock()
			)
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/pattern-overlay-layers" });
		expect(plan.items[0].appliedLayerEffects).toEqual([
			expect.objectContaining({
				key: "patternFill",
				type: "patternOverlay",
				blendMode: "norm",
				opacity: 100,
				pattern: expect.objectContaining({ id: "rgba-tile-2x2", executionModel: "bounded-pattern-v1" }),
				embeddedPattern: expect.objectContaining({ id: "rgba-tile-2x2", width: 2, height: 2 }),
			}),
		]);
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/pattern-overlay-layers" }, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([255, 0, 0, 255, 50, 178, 50, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
	});

	test("bakes a seeded RGB modern noise-gradient outside Stroke with exact metadata and pixels", async () => {
		await writeFile(
			source,
			createLayeredPsd([
				layer({
					name: "Noise Gradient Stroke",
					id: 935,
					left: 4,
					top: 5,
					width: 1,
					height: 1,
					visible: true,
					opacity: 255,
					rgba: [100, 100, 100, 255],
					additionalInfo: [additional("lfx2", modernNoiseGradientStrokeEffect())],
				}),
			])
		);
		const plan = await getPsdLayerExtractionStatus(source, { destinationFolder: "assets/noise-gradient-stroke-layers" });
		expect(plan.items[0]).toMatchObject({ left: 3, top: 4, width: 3, height: 3, warnings: [] });
		expect(plan.items[0].appliedLayerEffects[0]).toMatchObject({
			key: "FrFX",
			type: "stroke",
			fillType: "gradient",
			gradient: {
				type: "noise",
				name: "Seeded Noise",
				roughness: 1,
				roughnessRaw: 4096,
				colorModel: "rgb",
				randomSeed: 12345,
				restrictColors: false,
				addTransparency: false,
				minimum: [0, 0, 0, 1],
				maximum: [1, 1, 1, 1],
				executionModel: "bounded-seeded-v1",
				bakeSupported: true,
			},
		});
		await applyPsdLayerExtraction(source, { destinationFolder: "assets/noise-gradient-stroke-layers" }, plan.fingerprint);
		const pixels = await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer();
		expect([...pixels]).toEqual([
			144, 128, 193, 255, 95, 240, 142, 255, 212, 110, 141, 255, 144, 128, 193, 255, 100, 100, 100, 255, 212, 110, 141, 255, 144, 128, 193, 255, 95, 240, 142, 255, 212, 110,
			141, 255,
		]);
	});

	test("executes HSB, HSL, and Lab noise-gradient color models with restriction and transparency evidence", async () => {
		const cases = [
			{ name: "hsb", model: "HSBl" as const, restrictColors: true, addTransparency: true, minimum: [0, 50, 50, 50] as const, maximum: [100, 100, 100, 100] as const },
			{ name: "hsl", model: "HSLC" as const, restrictColors: false, addTransparency: false, minimum: [0, 25, 25, 100] as const, maximum: [100, 75, 75, 100] as const },
			{ name: "lab", model: "LbCl" as const, restrictColors: false, addTransparency: false, minimum: [30, 30, 30, 100] as const, maximum: [70, 70, 70, 100] as const },
		];
		const actual: Record<string, number[]> = {};
		for (const item of cases) {
			const caseSource = join(directory, `${item.name}-noise.psd`);
			await writeFile(
				caseSource,
				createLayeredPsd([
					layer({
						name: `${item.name} noise`,
						id: 936,
						left: 4,
						top: 5,
						width: 1,
						height: 1,
						visible: true,
						opacity: 255,
						rgba: [100, 100, 100, 255],
						additionalInfo: [
							additional(
								"lfx2",
								modernNoiseGradientStrokeEffect({
									colorModel: item.model,
									restrictColors: item.restrictColors,
									addTransparency: item.addTransparency,
									minimum: [...item.minimum],
									maximum: [...item.maximum],
								})
							),
						],
					}),
				])
			);
			const destinationFolder = `assets/${item.name}-noise-gradient-stroke`;
			const plan = await getPsdLayerExtractionStatus(caseSource, { destinationFolder });
			expect(plan.items[0].appliedLayerEffects[0]).toMatchObject({
				gradient: { colorModel: item.name, restrictColors: item.restrictColors, addTransparency: item.addTransparency, bakeSupported: true },
			});
			await applyPsdLayerExtraction(caseSource, { destinationFolder }, plan.fingerprint);
			actual[item.name] = [...(await sharp(join(directory, plan.items[0].path)).ensureAlpha().raw().toBuffer())];
		}
		expect(actual).toEqual({
			hsb: [
				114, 117, 163, 225, 56, 183, 94, 198, 155, 64, 134, 151, 114, 117, 163, 225, 100, 100, 100, 255, 155, 64, 134, 151, 114, 117, 163, 225, 56, 183, 94, 198, 155, 64,
				134, 151,
			],
			hsl: [
				146, 145, 182, 255, 73, 219, 109, 255, 152, 101, 149, 255, 146, 145, 182, 255, 100, 100, 100, 255, 152, 101, 149, 255, 146, 145, 182, 255, 73, 219, 109, 255, 152,
				101, 149, 255,
			],
			lab: [
				125, 118, 82, 255, 173, 71, 99, 255, 101, 157, 142, 255, 125, 118, 82, 255, 100, 100, 100, 255, 101, 157, 142, 255, 125, 118, 82, 255, 173, 71, 99, 255, 101, 157,
				142, 255,
			],
		});
	});
});
