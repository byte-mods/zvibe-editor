import { describe, expect, test } from "vitest";
import { zlibSync } from "fflate";
import { createHash } from "node:crypto";

import type { IPsdSmartFilterInfo } from "../../src/assets/psd";

import {
	applyPsdLayerAdjustment,
	applyPsdSmartFilters,
	decodePsd,
	decodePsdAdjustmentMasks,
	decodePsdLayerMasks,
	decodePsdLayers,
	decodePsdPatterns,
	inspectPsd,
	inspectPsdLayers,
	PSD_SMART_OBJECT_PRESET_WARP_STYLES,
	renderPsdSmartObjectPlacement,
	renderPsdSmartObjectPresetWarpPlacement,
	renderPsdSmartObjectQuiltWarpPlacement,
	renderPsdSmartObjectWarpPlacement,
	replacePsdEmbeddedSmartObjectPayloads,
} from "../../src/assets/psd";

function concat(...parts: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

function uint16(value: number): Uint8Array {
	return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function uint32(value: number): Uint8Array {
	return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function uint64(value: number): Uint8Array {
	return concat(uint32(Math.floor(value / 0x100000000)), uint32(value >>> 0));
}

function int16(value: number): Uint8Array {
	return uint16(value & 0xffff);
}

function int32(value: number): Uint8Array {
	return uint32(value >>> 0);
}

function float32(value: number): Uint8Array {
	const result = new Uint8Array(4);
	new DataView(result.buffer).setFloat32(0, value, false);
	return result;
}

function ascii(value: string): Uint8Array {
	return new Uint8Array([...value].map((character) => character.charCodeAt(0)));
}

function section(data: Uint8Array): Uint8Array {
	return concat(uint32(data.byteLength), data);
}

function section64(data: Uint8Array): Uint8Array {
	return concat(uint64(data.byteLength), data);
}

function psd(options: {
	width: number;
	height: number;
	channels: number;
	colorMode: number;
	compression: number;
	imageData: Uint8Array;
	depth?: number;
	version?: number;
	colorModeData?: Uint8Array;
	imageResources?: Uint8Array;
	layerAndMask?: Uint8Array;
}): Uint8Array {
	const header = new Uint8Array(26);
	header.set([0x38, 0x42, 0x50, 0x53], 0);
	header.set(uint16(options.version ?? 1), 4);
	header.set(uint16(options.channels), 12);
	header.set(uint32(options.height), 14);
	header.set(uint32(options.width), 18);
	header.set(uint16(options.depth ?? 8), 22);
	header.set(uint16(options.colorMode), 24);
	return concat(
		header,
		section(options.colorModeData ?? new Uint8Array()),
		section(options.imageResources ?? new Uint8Array()),
		(options.version === 2 ? section64 : section)(options.layerAndMask ?? new Uint8Array()),
		uint16(options.compression),
		options.imageData
	);
}

function literalRow(...values: number[]): Uint8Array {
	return new Uint8Array([values.length - 1, ...values]);
}

function repeatedRow(count: number, value: number): Uint8Array {
	return new Uint8Array([257 - count, value]);
}

function samplePlane(values: number[], depth: 8 | 16 | 32): Uint8Array {
	return depth === 32 ? concat(...values.map(float32)) : depth === 16 ? concat(...values.map(uint16)) : new Uint8Array(values);
}

function predictedPlane(values: number[], width: number, height: number, depth: 8 | 16 | 32): Uint8Array {
	if (depth === 32) {
		const interleaved = samplePlane(values, depth);
		const rowByteLength = width * 4;
		const predicted = new Uint8Array(interleaved.byteLength);
		for (let y = 0; y < height; ++y) {
			const rowOffset = y * rowByteLength;
			for (let byte = 0; byte < 4; ++byte) {
				for (let x = 0; x < width; ++x) {
					predicted[rowOffset + byte * width + x] = interleaved[rowOffset + x * 4 + byte];
				}
			}
			for (let byte = rowByteLength - 1; byte > 0; --byte) {
				predicted[rowOffset + byte] = (predicted[rowOffset + byte] - predicted[rowOffset + byte - 1] + 0x100) & 0xff;
			}
		}
		return predicted;
	}
	const predicted = [...values];
	const modulus = depth === 16 ? 0x10000 : 0x100;
	for (let row = 0; row < height; ++row) {
		for (let x = width - 1; x > 0; --x) {
			predicted[row * width + x] = (predicted[row * width + x] - predicted[row * width + x - 1] + modulus) % modulus;
		}
	}
	return samplePlane(predicted, depth);
}

function rleImage(rows: Uint8Array[], psb = false): Uint8Array {
	return concat(...rows.map((row) => (psb ? uint32(row.byteLength) : uint16(row.byteLength))), ...rows);
}

function additionalInfo(key: string, data: Uint8Array): Uint8Array {
	return concat(ascii("8BIM"), ascii(key), uint32(data.byteLength), data, data.byteLength & 1 ? new Uint8Array(1) : new Uint8Array());
}

function additionalInfo64(key: string, data: Uint8Array): Uint8Array {
	return concat(ascii("8B64"), ascii(key), uint64(data.byteLength), data, data.byteLength & 1 ? new Uint8Array(1) : new Uint8Array());
}

function unicodeName(value: string): Uint8Array {
	return concat(uint32(value.length), ...[...value].map((character) => uint16(character.charCodeAt(0))));
}

function effectColor(red: number, green: number, blue: number): Uint8Array {
	return concat(uint16(0), uint16(red * 257), uint16(green * 257), uint16(blue * 257), uint16(0));
}

function float64(value: number): Uint8Array {
	const result = new Uint8Array(8);
	new DataView(result.buffer).setFloat64(0, value, false);
	return result;
}

function fixedPoint(value: number): Uint8Array {
	return int32(Math.round(value * 0x1000000));
}

function pathRecord(selector: number, data: Uint8Array = new Uint8Array()): Uint8Array {
	if (data.byteLength > 24) {
		throw new Error("PSD test path-record data exceeds 24 bytes.");
	}
	return concat(uint16(selector), data, new Uint8Array(24 - data.byteLength));
}

function pathKnot(x: number, y: number, selector = 1): Uint8Array {
	const point = concat(fixedPoint(y), fixedPoint(x));
	return pathRecord(selector, concat(point, point, point));
}

function vectorMaskRectangle(left: number, top: number, right: number, bottom: number, flags = 0): Uint8Array {
	return concat(
		uint32(3),
		uint32(flags),
		pathRecord(6),
		pathRecord(8, uint16(0)),
		pathRecord(0, uint16(4)),
		pathKnot(left, top),
		pathKnot(right, top),
		pathKnot(right, bottom),
		pathKnot(left, bottom)
	);
}

function vectorMaskPath(points: Array<[number, number]>, open = false, flags = 0): Uint8Array {
	return concat(
		uint32(3),
		uint32(flags),
		pathRecord(6),
		pathRecord(8, uint16(0)),
		pathRecord(open ? 3 : 0, uint16(points.length)),
		...points.map(([x, y]) => pathKnot(x, y, open ? 4 : 1))
	);
}

function levelsRecord(inputFloor = 0, inputCeiling = 255, outputFloor = 0, outputCeiling = 255, gamma = 100): Uint8Array {
	return concat(uint16(inputFloor), uint16(inputCeiling), uint16(outputFloor), uint16(outputCeiling), uint16(gamma));
}

function levelsAdjustment(master = levelsRecord()): Uint8Array {
	return concat(uint16(2), master, ...Array.from({ length: 28 }, () => levelsRecord()));
}

function curve(points: Array<[input: number, output: number]>): Uint8Array {
	return concat(uint16(points.length), ...points.map(([input, output]) => concat(uint16(output), uint16(input))));
}

function curvesAdjustmentV4(curves: Array<Array<[input: number, output: number]>>): Uint8Array {
	return concat(uint16(4), uint16(curves.length), ...curves.map(curve));
}

function vibranceAdjustment(vibrance: number, saturation: number, version = 16): Uint8Array {
	return concat(
		uint32(version),
		descriptorObject("null", [
			{ key: "vibrance", type: "long", value: int32(vibrance) },
			{ key: "Strt", type: "long", value: int32(saturation) },
		])
	);
}

function hueSaturationChannel(range: [number, number, number, number] = [0, 0, 0, 0], hue = 0, saturation = 0, lightness = 0): Uint8Array {
	return concat(...range.map(int16), int16(hue), int16(saturation), int16(lightness));
}

function hueSaturationAdjustment(
	options: {
		version?: number;
		colorize?: boolean;
		paddingByte?: number;
		colorization?: [number, number, number];
		master?: [number, number, number];
		channels?: Uint8Array[];
	} = {}
): Uint8Array {
	return concat(
		uint16(options.version ?? 2),
		new Uint8Array([options.colorize ? 1 : 0, options.paddingByte ?? 0]),
		...(options.colorization ?? [0, 0, 0]).map(int16),
		...(options.master ?? [0, 0, 0]).map(int16),
		...(options.channels ?? Array.from({ length: 6 }, () => hueSaturationChannel()))
	);
}

function colorBalanceTone(cyanRed = 0, magentaGreen = 0, yellowBlue = 0): Uint8Array {
	return concat(int16(cyanRed), int16(magentaGreen), int16(yellowBlue));
}

function colorBalanceAdjustment(
	options: { shadows?: Uint8Array; midtones?: Uint8Array; highlights?: Uint8Array; preserveLuminosity?: number; paddingByte?: number } = {}
): Uint8Array {
	return concat(
		options.shadows ?? colorBalanceTone(),
		options.midtones ?? colorBalanceTone(),
		options.highlights ?? colorBalanceTone(),
		new Uint8Array([options.preserveLuminosity ?? 0, options.paddingByte ?? 0])
	);
}

function descriptorUnicode(value: string): Uint8Array {
	return concat(uint32(value.length), ...[...value].map((character) => uint16(character.charCodeAt(0))));
}

function descriptorClassId(value: string): Uint8Array {
	return value.length === 4 ? concat(int32(0), ascii(value)) : concat(int32(value.length), ascii(value));
}

function descriptorObject(classId: string, entries: Array<{ key: string; type: string; value: Uint8Array }>): Uint8Array {
	return concat(
		descriptorUnicode(""),
		descriptorClassId(classId),
		uint32(entries.length),
		...entries.map((entry) => concat(descriptorClassId(entry.key), ascii(entry.type), entry.value))
	);
}

function descriptorEnum(type: string, value: string): Uint8Array {
	return concat(descriptorClassId(type), descriptorClassId(value));
}

function descriptorUnit(units: string, value: number): Uint8Array {
	return concat(ascii(units), float64(value));
}

function solidColorFillDescriptor(colorClassId: string, entries: Array<{ key: string; type: string; value: Uint8Array }>, version = 16): Uint8Array {
	return concat(
		uint32(version),
		descriptorObject("null", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject(colorClassId, entries),
			},
		])
	);
}

function patternFillDescriptor(
	options: {
		version?: number;
		rootClassId?: string;
		patternClassId?: string;
		name?: string;
		id?: string;
		scale?: number;
		angle?: number;
		align?: boolean;
		linked?: boolean;
		phase?: [number, number];
		extraEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
	} = {}
): Uint8Array {
	const pattern = descriptorObject(options.patternClassId ?? "Ptrn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(options.name ?? "Test Tile") },
		{ key: "Idnt", type: "TEXT", value: descriptorUnicode(options.id ?? "tile-2x2") },
	]);
	const entries: Array<{ key: string; type: string; value: Uint8Array }> = [{ key: "Ptrn", type: "Objc", value: pattern }];
	if (options.scale !== undefined) entries.push({ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", options.scale) });
	if (options.angle !== undefined) entries.push({ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", options.angle) });
	if (options.align !== undefined) entries.push({ key: "Algn", type: "bool", value: new Uint8Array([options.align ? 1 : 0]) });
	if (options.linked !== undefined) entries.push({ key: "Lnkd", type: "bool", value: new Uint8Array([options.linked ? 1 : 0]) });
	if (options.phase) {
		entries.push({
			key: "phase",
			type: "Objc",
			value: descriptorObject("Pnt ", [
				{ key: "Hrzn", type: "doub", value: float64(options.phase[0]) },
				{ key: "Vrtc", type: "doub", value: float64(options.phase[1]) },
			]),
		});
	}
	entries.push(...(options.extraEntries ?? []));
	return concat(uint32(options.version ?? 16), descriptorObject(options.rootClassId ?? "null", entries));
}

function gradientFillDescriptor(
	options: {
		version?: number;
		rootClassId?: string;
		gradientClassId?: string;
		kind?: "solid" | "noise";
		style?: string;
		angle?: number;
		scale?: number;
		align?: boolean;
		reverse?: boolean;
		dither?: boolean;
		padding?: number[];
		extraEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
	} = {}
): Uint8Array {
	const colorStop = (location: number, color: [number, number, number]): Uint8Array =>
		descriptorObject("Clrt", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: float64(color[0]) },
					{ key: "Grn ", type: "doub", value: float64(color[1]) },
					{ key: "Bl  ", type: "doub", value: float64(color[2]) },
				]),
			},
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const opacityStop = (location: number, opacity: number): Uint8Array =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", opacity) },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const gradient =
		options.kind === "noise"
			? descriptorObject(options.gradientClassId ?? "Grdn", [
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "ClNs") },
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Seeded Noise Fill") },
					{ key: "ShTr", type: "bool", value: new Uint8Array([1]) },
					{ key: "VctC", type: "bool", value: new Uint8Array([1]) },
					{ key: "ClrS", type: "enum", value: descriptorEnum("ClrS", "RGBC") },
					{ key: "RndS", type: "long", value: int32(123456) },
					{ key: "Smth", type: "long", value: int32(3072) },
					{ key: "Mnm ", type: "VlLs", value: descriptorLongList(10, 20, 30, 40) },
					{ key: "Mxm ", type: "VlLs", value: descriptorLongList(90, 80, 70, 60) },
				])
			: descriptorObject(options.gradientClassId ?? "Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Red Blue Fill") },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
					{ key: "Intr", type: "doub", value: float64(4096) },
					{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, [255, 0, 0]), colorStop(4096, [0, 0, 255])) },
					{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0, 100), opacityStop(4096, 50)) },
				]);
	const root = descriptorObject(options.rootClassId ?? "null", [
		{ key: "Dthr", type: "bool", value: new Uint8Array([options.dither ? 1 : 0]) },
		{ key: "gradientsInterpolationMethod", type: "enum", value: descriptorEnum("gradientInterpolationMethodType", "Gcls") },
		{ key: "Rvrs", type: "bool", value: new Uint8Array([options.reverse ? 1 : 0]) },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", options.angle ?? 0) },
		{ key: "Type", type: "enum", value: descriptorEnum("GrdT", options.style ?? "Lnr ") },
		{ key: "Algn", type: "bool", value: new Uint8Array([options.align === false ? 0 : 1]) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", options.scale ?? 100) },
		{
			key: "Ofst",
			type: "Objc",
			value: descriptorObject("Pnt ", [
				{ key: "Hrzn", type: "UntF", value: descriptorUnit("#Prc", 0) },
				{ key: "Vrtc", type: "UntF", value: descriptorUnit("#Prc", 0) },
			]),
		},
		{ key: "Grad", type: "Objc", value: gradient },
		...(options.extraEntries ?? []),
	]);
	return concat(uint32(options.version ?? 16), root, new Uint8Array(options.padding ?? []));
}

function descriptorList(...values: Uint8Array[]): Uint8Array {
	return concat(int32(values.length), ...values.map((value) => concat(ascii("Objc"), value)));
}

function descriptorLongList(...values: number[]): Uint8Array {
	return concat(int32(values.length), ...values.map((value) => concat(ascii("long"), int32(value))));
}

function descriptorUnitList(...values: Array<{ units: string; value: number }>): Uint8Array {
	return concat(int32(values.length), ...values.map((entry) => concat(ascii("UntF"), descriptorUnit(entry.units, entry.value))));
}

function vectorStrokeDescriptor(
	options: {
		version?: number;
		classId?: string;
		strokeStyleVersion?: number;
		strokeEnabled?: boolean;
		fillEnabled?: boolean;
		lineWidth?: { units: string; value: number };
		dashOffset?: { units: string; value: number };
		miterLimit?: number;
		cap?: string;
		join?: string;
		alignment?: string;
		scaleLock?: boolean;
		strokeAdjust?: boolean;
		dashes?: Array<{ units: string; value: number }>;
		blendMode?: string;
		opacity?: number;
		content?: Uint8Array;
		resolution?: number;
		padding?: number[];
		extraEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
	} = {}
): Uint8Array {
	const colorContent = descriptorObject("solidColorLayer", [
		{
			key: "Clr ",
			type: "Objc",
			value: descriptorObject("RGBC", [
				{ key: "Rd  ", type: "doub", value: float64(20) },
				{ key: "Grn ", type: "doub", value: float64(100) },
				{ key: "Bl  ", type: "doub", value: float64(240) },
			]),
		},
	]);
	return concat(
		uint32(options.version ?? 16),
		descriptorObject(options.classId ?? "strokeStyle", [
			{ key: "strokeStyleVersion", type: "long", value: int32(options.strokeStyleVersion ?? 2) },
			{ key: "strokeEnabled", type: "bool", value: new Uint8Array([options.strokeEnabled === false ? 0 : 1]) },
			{ key: "fillEnabled", type: "bool", value: new Uint8Array([options.fillEnabled === false ? 0 : 1]) },
			{ key: "strokeStyleLineWidth", type: "UntF", value: descriptorUnit(options.lineWidth?.units ?? "#Pxl", options.lineWidth?.value ?? 4) },
			{ key: "strokeStyleLineDashOffset", type: "UntF", value: descriptorUnit(options.dashOffset?.units ?? "#Pxl", options.dashOffset?.value ?? 1) },
			{ key: "strokeStyleMiterLimit", type: "doub", value: float64(options.miterLimit ?? 10) },
			{ key: "strokeStyleLineCapType", type: "enum", value: descriptorEnum("strokeStyleLineCapType", options.cap ?? "strokeStyleRoundCap") },
			{ key: "strokeStyleLineJoinType", type: "enum", value: descriptorEnum("strokeStyleLineJoinType", options.join ?? "strokeStyleBevelJoin") },
			{
				key: "strokeStyleLineAlignment",
				type: "enum",
				value: descriptorEnum("strokeStyleLineAlignment", options.alignment ?? "strokeStyleAlignCenter"),
			},
			{ key: "strokeStyleScaleLock", type: "bool", value: new Uint8Array([options.scaleLock === false ? 0 : 1]) },
			{ key: "strokeStyleStrokeAdjust", type: "bool", value: new Uint8Array([options.strokeAdjust === false ? 0 : 1]) },
			{
				key: "strokeStyleLineDashSet",
				type: "VlLs",
				value: descriptorUnitList(
					...(options.dashes ?? [
						{ units: "#Pxl", value: 6 },
						{ units: "#Pxl", value: 2 },
					])
				),
			},
			{ key: "strokeStyleBlendMode", type: "enum", value: descriptorEnum("BlnM", options.blendMode ?? "Mltp") },
			{ key: "strokeStyleOpacity", type: "UntF", value: descriptorUnit("#Prc", options.opacity ?? 75) },
			{ key: "strokeStyleContent", type: "Objc", value: options.content ?? colorContent },
			{ key: "strokeStyleResolution", type: "doub", value: float64(options.resolution ?? 72) },
			...(options.extraEntries ?? []),
		]),
		new Uint8Array(options.padding ?? [])
	);
}

function vectorOriginationDescriptor(
	options: {
		recordVersion?: number;
		descriptorVersion?: number;
		rootClassId?: string;
		originIndex?: number;
		secondOriginIndex?: number;
		originResolution?: number;
		quadVersion?: number;
		padding?: number[];
		extraRootEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
		extraItemEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
	} = {}
): Uint8Array {
	const point = (x: number, y: number): Uint8Array =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: float64(x) },
			{ key: "Vrtc", type: "doub", value: float64(y) },
		]);
	const item = (originIndex: number): Uint8Array =>
		descriptorObject("null", [
			{ key: "keyOriginType", type: "long", value: int32(1) },
			{ key: "keyOriginResolution", type: "doub", value: float64(options.originResolution ?? 144) },
			{
				key: "keyOriginRRectRadii",
				type: "Objc",
				value: descriptorObject("radii", [
					{ key: "unitValueQuadVersion", type: "long", value: int32(options.quadVersion ?? 1) },
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
					{ key: "unitValueQuadVersion", type: "long", value: int32(options.quadVersion ?? 1) },
					{ key: "Top ", type: "UntF", value: descriptorUnit("#Pnt", 2) },
					{ key: "Left", type: "UntF", value: descriptorUnit("#Pxl", 3) },
					{ key: "Btom", type: "doub", value: float64(12) },
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
					{ key: "xx", type: "doub", value: float64(1) },
					{ key: "xy", type: "doub", value: float64(0.1) },
					{ key: "yx", type: "doub", value: float64(-0.2) },
					{ key: "yy", type: "doub", value: float64(1) },
					{ key: "tx", type: "doub", value: float64(5) },
					{ key: "ty", type: "doub", value: float64(6) },
				]),
			},
			{ key: "keyShapeInvalidated", type: "bool", value: new Uint8Array([0]) },
			{ key: "keyOriginIndex", type: "long", value: int32(originIndex) },
			...(options.extraItemEntries ?? []),
		]);
	const items = [item(options.originIndex ?? 0), ...(options.secondOriginIndex === undefined ? [] : [item(options.secondOriginIndex)])];
	return concat(
		int32(options.recordVersion ?? 1),
		uint32(options.descriptorVersion ?? 16),
		descriptorObject(options.rootClassId ?? "null", [{ key: "keyDescriptorList", type: "VlLs", value: descriptorList(...items) }, ...(options.extraRootEntries ?? [])]),
		new Uint8Array(options.padding ?? [])
	);
}

function pathListDescriptor(
	options: {
		version?: number;
		rootClassId?: string;
		pathClassId?: string;
		symmetryClassId?: string;
		empty?: boolean;
		padding?: number[];
		extraRootEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
		extraPathEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
		extraSymmetryEntries?: Array<{ key: string; type: string; value: Uint8Array }>;
	} = {}
): Uint8Array {
	const symmetry = descriptorObject(options.symmetryClassId ?? "pathSymmetryClass", [
		{ key: "pathSymmetryMode", type: "enum", value: descriptorEnum("pathSymmetryModeEnum", "pathSymmetryModeBasicPath") },
		...(options.extraSymmetryEntries ?? []),
	]);
	const path = descriptorObject(options.pathClassId ?? "pathInfoClass", [
		{ key: "pathUnicodeName", type: "TEXT", value: descriptorUnicode("Work Path") },
		{ key: "pathSymmetryClass", type: "Objc", value: symmetry },
		...(options.extraPathEntries ?? []),
	]);
	return concat(
		uint32(options.version ?? 16),
		descriptorObject(options.rootClassId ?? "pathsDataClass", [
			{ key: "pathList", type: "VlLs", value: descriptorList(...(options.empty ? [] : [path])) },
			...(options.extraRootEntries ?? []),
		]),
		new Uint8Array(options.padding ?? [])
	);
}

function blackWhiteAdjustment(options: { useTint?: boolean; descriptorVersion?: number; red?: number } = {}): Uint8Array {
	const tint = descriptorObject("RGBC", [
		{ key: "Rd  ", type: "doub", value: float64(120) },
		{ key: "Grn ", type: "doub", value: float64(80) },
		{ key: "Bl  ", type: "doub", value: float64(40) },
	]);
	return concat(
		uint32(options.descriptorVersion ?? 16),
		descriptorObject("null", [
			{ key: "Rd  ", type: "long", value: int32(options.red ?? 40) },
			{ key: "Yllw", type: "long", value: int32(60) },
			{ key: "Grn ", type: "long", value: int32(40) },
			{ key: "Cyn ", type: "long", value: int32(60) },
			{ key: "Bl  ", type: "long", value: int32(20) },
			{ key: "Mgnt", type: "long", value: int32(80) },
			{ key: "useTint", type: "bool", value: new Uint8Array([options.useTint ? 1 : 0]) },
			{ key: "tintColor", type: "Objc", value: tint },
			{ key: "bwPresetKind", type: "long", value: int32(1) },
			{ key: "blackAndWhitePresetFileName", type: "TEXT", value: descriptorUnicode("Custom") },
		])
	);
}

function channelMixerChannel(red: number, green: number, blue: number, constant = 0, reservedWord = 0): Uint8Array {
	return concat(int16(red), int16(green), int16(blue), uint16(reservedWord), int16(constant));
}

function channelMixerAdjustment(
	options: {
		version?: number;
		monochromeFlag?: number;
		red?: Uint8Array;
		green?: Uint8Array;
		blue?: Uint8Array;
		gray?: Uint8Array;
		monochromePadding?: Uint8Array;
	} = {}
): Uint8Array {
	const monochromeFlag = options.monochromeFlag ?? 0;
	return monochromeFlag === 1
		? concat(uint16(options.version ?? 1), uint16(monochromeFlag), options.gray ?? channelMixerChannel(40, 40, 20), options.monochromePadding ?? new Uint8Array(30))
		: concat(
				uint16(options.version ?? 1),
				uint16(monochromeFlag),
				options.red ?? channelMixerChannel(100, 0, 0),
				options.green ?? channelMixerChannel(0, 100, 0),
				options.blue ?? channelMixerChannel(0, 0, 100),
				options.gray ?? channelMixerChannel(40, 40, 20)
			);
}

function selectiveColorRange(cyan = 0, magenta = 0, yellow = 0, black = 0): Uint8Array {
	return concat(int16(cyan), int16(magenta), int16(yellow), int16(black));
}

function selectiveColorAdjustment(
	options: {
		version?: number;
		modeWord?: number;
		reserved?: Uint8Array;
		reds?: Uint8Array;
		yellows?: Uint8Array;
		greens?: Uint8Array;
		cyans?: Uint8Array;
		blues?: Uint8Array;
		magentas?: Uint8Array;
		whites?: Uint8Array;
		neutrals?: Uint8Array;
		blacks?: Uint8Array;
	} = {}
): Uint8Array {
	return concat(
		uint16(options.version ?? 1),
		uint16(options.modeWord ?? 0),
		options.reserved ?? new Uint8Array(8),
		options.reds ?? selectiveColorRange(),
		options.yellows ?? selectiveColorRange(),
		options.greens ?? selectiveColorRange(),
		options.cyans ?? selectiveColorRange(),
		options.blues ?? selectiveColorRange(),
		options.magentas ?? selectiveColorRange(),
		options.whites ?? selectiveColorRange(),
		options.neutrals ?? selectiveColorRange(),
		options.blacks ?? selectiveColorRange()
	);
}

function gradientMapAdjustment(
	options: { version?: number; type?: number; reverse?: number; dither?: number; method?: string; expansionCount?: number; reserved?: Uint8Array } = {}
): Uint8Array {
	const name = "Red Map";
	const unicode = concat(uint32(name.length), ...[...name].map((character) => uint16(character.charCodeAt(0))));
	const colorStop = (location: number, color: [number, number, number]) =>
		concat(uint32(location), uint32(50), uint16(0), uint16(color[0] * 257), uint16(color[1] * 257), uint16(color[2] * 257), uint16(0), uint16(0));
	const opacityStop = (location: number) => concat(uint32(location), uint32(50), uint16(255));
	const version = options.version ?? 1;
	return concat(
		uint16(version),
		new Uint8Array([options.reverse ?? 0, options.dither ?? 0]),
		...(version === 3 ? [ascii(options.method ?? "Gcls")] : []),
		unicode,
		uint16(2),
		colorStop(0, [0, 0, 0]),
		colorStop(4096, [255, 0, 0]),
		uint16(2),
		opacityStop(0),
		opacityStop(4096),
		uint16(options.expansionCount ?? 2),
		uint16(4096),
		uint16(32),
		uint16(options.type ?? 0),
		uint32(12345),
		uint16(0),
		uint16(0),
		uint32(2048),
		uint16(3),
		...Array.from({ length: 4 }, () => uint16(0)),
		...Array.from({ length: 4 }, () => uint16(0x8000)),
		options.reserved ?? new Uint8Array(4)
	);
}

function photoFilterAdjustment(options: { version?: number; density?: number; preserve?: number; padding?: Uint8Array } = {}): Uint8Array {
	const version = options.version ?? 2;
	const color = version === 3 ? concat(int32(5000), int32(2000), int32(3000)) : concat(uint16(0), uint16(65535), uint16(32896), uint16(0), uint16(0));
	return concat(uint16(version), color, uint32(options.density ?? 2500), new Uint8Array([options.preserve ?? 0]), options.padding ?? new Uint8Array(3));
}

function colorLookupAdjustment(options: { version?: number; descriptorVersion?: number; dither?: boolean; lutData?: Uint8Array } = {}): Uint8Array {
	const lut = options.lutData ?? ascii('TITLE "Invert Red"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n1 0 0\n0 0 0\n1 1 0\n0 1 0\n1 0 1\n0 0 1\n1 1 1\n0 1 1\n');
	return concat(
		uint16(options.version ?? 1),
		uint32(options.descriptorVersion ?? 16),
		descriptorObject("null", [
			{ key: "lookupType", type: "enum", value: descriptorEnum("colorLookupType", "3DLUT") },
			{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Invert Red") },
			{ key: "Dthr", type: "bool", value: new Uint8Array([options.dither ? 1 : 0]) },
			{ key: "LUTFormat", type: "enum", value: descriptorEnum("LUTFormatType", "LUTFormatCUBE") },
			{ key: "dataOrder", type: "enum", value: descriptorEnum("colorLookupOrder", "rgbOrder") },
			{ key: "tableOrder", type: "enum", value: descriptorEnum("colorLookupOrder", "rgbOrder") },
			{ key: "LUT3DFileData", type: "tdta", value: concat(uint32(lut.byteLength), lut) },
			{ key: "LUT3DFileName", type: "TEXT", value: descriptorUnicode("invert-red.cube") },
		])
	);
}

function modernStrokeLayerEffects(): Uint8Array {
	const color = descriptorObject("RGBC", [
		{ key: "Rd  ", type: "doub", value: float64(10) },
		{ key: "Grn ", type: "doub", value: float64(20) },
		{ key: "Bl  ", type: "doub", value: float64(30) },
	]);
	const stroke = descriptorObject("FrFX", [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([1]) },
		{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "OutF") },
		{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "SClr") },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 80) },
		{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 2) },
		{ key: "Clr ", type: "Objc", value: color },
	]);
	const root = descriptorObject("null", [
		{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
		{ key: "FrFX", type: "Objc", value: stroke },
	]);
	return concat(uint32(0), uint32(16), root);
}

function modernGradientStrokeLayerEffects(options: { interpolation?: "Perc" | "Lnr " | "Gcls" | "Smoo"; align?: boolean; dither?: boolean } = {}): Uint8Array {
	const colorStop = (location: number, color: [number, number, number]): Uint8Array =>
		descriptorObject("Clrt", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: float64(color[0]) },
					{ key: "Grn ", type: "doub", value: float64(color[1]) },
					{ key: "Bl  ", type: "doub", value: float64(color[2]) },
				]),
			},
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const opacityStop = (location: number, opacity: number): Uint8Array =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", opacity) },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const gradient = descriptorObject("Grdn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Red Blue") },
		{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
		{ key: "Intr", type: "doub", value: float64(4096) },
		{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, [255, 0, 0]), colorStop(4096, [0, 0, 255])) },
		{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0, 100), opacityStop(4096, 100)) },
	]);
	const stroke = descriptorObject("FrFX", [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([1]) },
		{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "OutF") },
		{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "GrFl") },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
		{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Algn", type: "bool", value: new Uint8Array([options.align === false ? 0 : 1]) },
		{ key: "Dthr", type: "bool", value: new Uint8Array([options.dither ? 1 : 0]) },
		{ key: "Rvrs", type: "bool", value: new Uint8Array([0]) },
		...(options.interpolation ? [{ key: "gradientsInterpolationMethod", type: "enum", value: descriptorEnum("gradientInterpolationMethodType", options.interpolation) }] : []),
		{ key: "Grad", type: "Objc", value: gradient },
	]);
	const root = descriptorObject("null", [
		{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
		{ key: "FrFX", type: "Objc", value: stroke },
	]);
	return concat(uint32(0), uint32(16), root);
}

function modernNoiseGradientStrokeLayerEffects(): Uint8Array {
	const gradient = descriptorObject("Grdn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Seeded Noise") },
		{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "ClNs") },
		{ key: "Smth", type: "long", value: int32(2048) },
		{ key: "ClrS", type: "enum", value: descriptorEnum("ClrS", "RGBC") },
		{ key: "RndS", type: "long", value: int32(3650322) },
		{ key: "VctC", type: "bool", value: new Uint8Array([1]) },
		{ key: "ShTr", type: "bool", value: new Uint8Array([1]) },
		{ key: "Mnm ", type: "VlLs", value: descriptorLongList(0, 10, 20, 30) },
		{ key: "Mxm ", type: "VlLs", value: descriptorLongList(100, 90, 80, 70) },
	]);
	const stroke = descriptorObject("FrFX", [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([1]) },
		{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "OutF") },
		{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "GrFl") },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
		{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Algn", type: "bool", value: new Uint8Array([1]) },
		{ key: "Dthr", type: "bool", value: new Uint8Array([0]) },
		{ key: "Rvrs", type: "bool", value: new Uint8Array([0]) },
		{ key: "Grad", type: "Objc", value: gradient },
	]);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: "FrFX", type: "Objc", value: stroke },
		])
	);
}

function modernPatternLayerEffects(kind: "stroke" | "overlay"): Uint8Array {
	const pattern = descriptorObject("Ptrn", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Test Tile") },
		{ key: "Idnt", type: "TEXT", value: descriptorUnicode("tile-2x2") },
	]);
	const phase = descriptorObject("Pnt ", [
		{ key: "Hrzn", type: "long", value: int32(1) },
		{ key: "Vrtc", type: "long", value: int32(-1) },
	]);
	const common = [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([1]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 75) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 200) },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 90) },
		{ key: "Algn", type: "bool", value: new Uint8Array([0]) },
		{ key: "Lnkd", type: "bool", value: new Uint8Array([0]) },
		{ key: "phase", type: "Objc", value: phase },
		{ key: "Ptrn", type: "Objc", value: pattern },
	];
	const effect = descriptorObject(kind === "stroke" ? "FrFX" : "patternFill", [
		...(kind === "stroke"
			? [
					{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "OutF") },
					{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "Ptrn") },
					{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
				]
			: []),
		...common,
	]);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: kind === "stroke" ? "FrFX" : "patternFill", type: "Objc", value: effect },
		])
	);
}

function modernColorOverlayLayerEffects(): Uint8Array {
	const color = descriptorObject("RGBC", [
		{ key: "Rd  ", type: "doub", value: float64(200) },
		{ key: "Grn ", type: "doub", value: float64(50) },
		{ key: "Bl  ", type: "doub", value: float64(10) },
	]);
	const overlay = descriptorObject("SoFi", [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([0]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Mltp") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 40) },
		{ key: "Clr ", type: "Objc", value: color },
	]);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: "SoFi", type: "Objc", value: overlay },
		])
	);
}

function modernGradientOverlayLayerEffects(type: "solid" | "noise", includeColorAfter = false, useMulti = false): Uint8Array {
	const colorStop = (location: number, color: [number, number, number]): Uint8Array =>
		descriptorObject("Clrt", [
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: float64(color[0]) },
					{ key: "Grn ", type: "doub", value: float64(color[1]) },
					{ key: "Bl  ", type: "doub", value: float64(color[2]) },
				]),
			},
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const opacityStop = (location: number): Uint8Array =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const gradient =
		type === "solid"
			? descriptorObject("Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Overlay Red Blue") },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
					{ key: "Intr", type: "doub", value: float64(4096) },
					{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, [255, 0, 0]), colorStop(4096, [0, 0, 255])) },
					{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0), opacityStop(4096)) },
				])
			: descriptorObject("Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Overlay Seeded Noise") },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "ClNs") },
					{ key: "Smth", type: "long", value: int32(2048) },
					{ key: "ClrS", type: "enum", value: descriptorEnum("ClrS", "RGBC") },
					{ key: "RndS", type: "long", value: int32(3650322) },
					{ key: "VctC", type: "bool", value: new Uint8Array([1]) },
					{ key: "ShTr", type: "bool", value: new Uint8Array([1]) },
					{ key: "Mnm ", type: "VlLs", value: descriptorLongList(0, 10, 20, 30) },
					{ key: "Mxm ", type: "VlLs", value: descriptorLongList(100, 90, 80, 70) },
				]);
	const overlay = descriptorObject("GrFl", [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([0]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 75) },
		{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") },
		{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
		{ key: "Algn", type: "bool", value: new Uint8Array([1]) },
		{ key: "Dthr", type: "bool", value: new Uint8Array([0]) },
		{ key: "Rvrs", type: "bool", value: new Uint8Array([0]) },
		...(type === "solid" ? [{ key: "gs99", type: "enum", value: descriptorEnum("gradientInterpolationMethodType", "Lnr ") }] : []),
		{ key: "Grad", type: "Objc", value: gradient },
	]);
	const color = descriptorObject("RGBC", [
		{ key: "Rd  ", type: "doub", value: float64(200) },
		{ key: "Grn ", type: "doub", value: float64(50) },
		{ key: "Bl  ", type: "doub", value: float64(10) },
	]);
	const colorOverlay = descriptorObject("SoFi", [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Mltp") },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 40) },
		{ key: "Clr ", type: "Objc", value: color },
	]);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: useMulti ? "gradientFillMulti" : "GrFl", type: useMulti ? "VlLs" : "Objc", value: useMulti ? descriptorList(overlay) : overlay },
			...(includeColorAfter ? [{ key: "SoFi", type: "Objc", value: colorOverlay }] : []),
		])
	);
}

function modernShadowLayerEffects(options: { choke?: number; noise?: number; contour?: Array<[number, number]>; antialiased?: boolean } = {}): Uint8Array {
	const contourPoint = (x: number, y: number): Uint8Array =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: float64(x) },
			{ key: "Vrtc", type: "doub", value: float64(y) },
		]);
	const contour = options.contour
		? descriptorObject("ShpC", [
				{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Shadow Ramp") },
				{ key: "Crv ", type: "VlLs", value: descriptorList(...options.contour.map(([x, y]) => contourPoint(x, y))) },
			])
		: null;
	const effect = (classId: "DrSh" | "IrSh", color: [number, number, number], blend: "Mltp" | "Nrml", dialog: boolean): Uint8Array =>
		descriptorObject(classId, [
			{ key: "enab", type: "bool", value: new Uint8Array([1]) },
			{ key: "present", type: "bool", value: new Uint8Array([1]) },
			{ key: "showInDialog", type: "bool", value: new Uint8Array([dialog ? 1 : 0]) },
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", blend) },
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: float64(color[0]) },
					{ key: "Grn ", type: "doub", value: float64(color[1]) },
					{ key: "Bl  ", type: "doub", value: float64(color[2]) },
				]),
			},
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 60) },
			{ key: "uglg", type: "bool", value: new Uint8Array([0]) },
			{ key: "lagl", type: "UntF", value: descriptorUnit("#Ang", -45) },
			{ key: "Dstn", type: "UntF", value: descriptorUnit("#Pxl", 2) },
			{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 3) },
			{ key: "Ckmt", type: "UntF", value: descriptorUnit("#Pxl", options.choke ?? 0) },
			...(options.noise === undefined ? [] : [{ key: "Nose", type: "UntF", value: descriptorUnit("#Prc", options.noise) }]),
			{ key: "AntA", type: "bool", value: new Uint8Array([options.antialiased === false ? 0 : 1]) },
			...(contour ? [{ key: "TrnS", type: "Objc", value: contour }] : []),
			...(classId === "DrSh" ? [{ key: "layerConceals", type: "bool", value: new Uint8Array([1]) }] : []),
		]);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: "DrSh", type: "Objc", value: effect("DrSh", [10, 20, 30], "Mltp", false) },
			{ key: "innerShadowMulti", type: "VlLs", value: descriptorList(effect("IrSh", [200, 100, 50], "Nrml", true)) },
		])
	);
}

function modernMultipleInstanceLayerEffects(): Uint8Array {
	const color = (red: number, green: number, blue: number): Uint8Array =>
		descriptorObject("RGBC", [
			{ key: "Rd  ", type: "doub", value: float64(red) },
			{ key: "Grn ", type: "doub", value: float64(green) },
			{ key: "Bl  ", type: "doub", value: float64(blue) },
		]);
	const state = (dialog: boolean): Array<{ key: string; type: string; value: Uint8Array }> => [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([dialog ? 1 : 0]) },
	];
	const shadow = (classId: "DrSh" | "IrSh", red: number): Uint8Array =>
		descriptorObject(classId, [
			...state(red > 100),
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "uglg", type: "bool", value: new Uint8Array([0]) },
			{ key: "lagl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "Dstn", type: "UntF", value: descriptorUnit("#Pxl", 0) },
			{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 0) },
			{ key: "Ckmt", type: "UntF", value: descriptorUnit("#Pxl", 0) },
			{ key: "AntA", type: "bool", value: new Uint8Array([1]) },
			...(classId === "DrSh" ? [{ key: "layerConceals", type: "bool", value: new Uint8Array([1]) }] : []),
		]);
	const solidFill = (red: number): Uint8Array =>
		descriptorObject("SoFi", [
			...state(red > 100),
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
		]);
	const colorStop = (location: number, red: number): Uint8Array =>
		descriptorObject("Clrt", [
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
			{ key: "Type", type: "enum", value: descriptorEnum("Clry", "UsrS") },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const opacityStop = (location: number): Uint8Array =>
		descriptorObject("TrnS", [
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Lctn", type: "long", value: int32(location) },
			{ key: "Mdpn", type: "long", value: int32(50) },
		]);
	const gradientOverlay = (red: number): Uint8Array =>
		descriptorObject("GrFl", [
			...state(red > 100),
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") },
			{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Algn", type: "bool", value: new Uint8Array([1]) },
			{ key: "Dthr", type: "bool", value: new Uint8Array([0]) },
			{ key: "Rvrs", type: "bool", value: new Uint8Array([0]) },
			{
				key: "Grad",
				type: "Objc",
				value: descriptorObject("Grdn", [
					{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(`Multi ${red}`) },
					{ key: "GrdF", type: "enum", value: descriptorEnum("GrdF", "CstS") },
					{ key: "Intr", type: "doub", value: float64(4096) },
					{ key: "Clrs", type: "VlLs", value: descriptorList(colorStop(0, red), colorStop(4096, red)) },
					{ key: "Trns", type: "VlLs", value: descriptorList(opacityStop(0), opacityStop(4096)) },
				]),
			},
		]);
	const stroke = (red: number): Uint8Array =>
		descriptorObject("FrFX", [
			...state(red > 100),
			{ key: "Styl", type: "enum", value: descriptorEnum("FStl", "InsF") },
			{ key: "PntT", type: "enum", value: descriptorEnum("FrFl", "SClr") },
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 25) },
			{ key: "Sz  ", type: "UntF", value: descriptorUnit("#Pxl", 1) },
			{ key: "Clr ", type: "Objc", value: color(red, 0, 0) },
		]);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: "gradientFillMulti", type: "VlLs", value: descriptorList(gradientOverlay(20), gradientOverlay(220)) },
			{ key: "dropShadowMulti", type: "VlLs", value: descriptorList(shadow("DrSh", 30), shadow("DrSh", 230)) },
			{ key: "frameFXMulti", type: "VlLs", value: descriptorList(stroke(40), stroke(240)) },
			{ key: "solidFillMulti", type: "VlLs", value: descriptorList(solidFill(50), solidFill(250)) },
			{ key: "innerShadowMulti", type: "VlLs", value: descriptorList(shadow("IrSh", 60), shadow("IrSh", 255)) },
			{ key: "numModifyingFX", type: "long", value: int32(10) },
		])
	);
}

function modernGlowLayerEffects(
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
): Uint8Array {
	const contourPoint = (x: number, y: number): Uint8Array =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: float64(x) },
			{ key: "Vrtc", type: "doub", value: float64(y) },
		]);
	const contourPoints = options.contour ?? [
		[0, 0],
		[255, 255],
	];
	const contour = descriptorObject("ShpC", [
		{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(options.contour ? "Glow Ramp" : "Linear") },
		{ key: "Crv ", type: "VlLs", value: descriptorList(...contourPoints.map(([x, y]) => contourPoint(x, y))) },
	]);
	const effect = (classId: "OrGl" | "IrGl", color: [number, number, number], dialog: boolean): Uint8Array =>
		descriptorObject(classId, [
			{ key: "enab", type: "bool", value: new Uint8Array([1]) },
			{ key: "present", type: "bool", value: new Uint8Array([1]) },
			{ key: "showInDialog", type: "bool", value: new Uint8Array([dialog ? 1 : 0]) },
			{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
			{
				key: "Clr ",
				type: "Objc",
				value: descriptorObject("RGBC", [
					{ key: "Rd  ", type: "doub", value: float64(color[0]) },
					{ key: "Grn ", type: "doub", value: float64(color[1]) },
					{ key: "Bl  ", type: "doub", value: float64(color[2]) },
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
			{ key: "AntA", type: "bool", value: new Uint8Array([options.antialiased === false ? 0 : 1]) },
			{ key: "TrnS", type: "Objc", value: contour },
		]);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: "OrGl", type: "Objc", value: effect("OrGl", [255, 255, 255], false) },
			{ key: "IrGl", type: "Objc", value: effect("IrGl", [255, 0, 0], true) },
		])
	);
}

function modernBevelSatinLayerEffects(
	options: {
		style?: "OtrB" | "InrB" | "Embs" | "PlEb" | "strokeEmboss";
		technique?: "SfBL" | "PrBL" | "Slmt";
		direction?: "In  " | "Out ";
		useShape?: boolean;
		useTexture?: boolean;
	} = {}
): Uint8Array {
	const contourPoint = (x: number, y: number): Uint8Array =>
		descriptorObject("Pnt ", [
			{ key: "Hrzn", type: "doub", value: float64(x) },
			{ key: "Vrtc", type: "doub", value: float64(y) },
		]);
	const contour = (name: string, points: Array<[number, number]>): Uint8Array =>
		descriptorObject("ShpC", [
			{ key: "Nm  ", type: "TEXT", value: descriptorUnicode(name) },
			{ key: "Crv ", type: "VlLs", value: descriptorList(...points.map(([x, y]) => contourPoint(x, y))) },
		]);
	const color = (rgb: [number, number, number]): Uint8Array =>
		descriptorObject("RGBC", [
			{ key: "Rd  ", type: "doub", value: float64(rgb[0]) },
			{ key: "Grn ", type: "doub", value: float64(rgb[1]) },
			{ key: "Bl  ", type: "doub", value: float64(rgb[2]) },
		]);
	const satin = descriptorObject("ChFX", [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([0]) },
		{ key: "Md  ", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "Clr ", type: "Objc", value: color([0, 0, 255]) },
		{ key: "Opct", type: "UntF", value: descriptorUnit("#Prc", 50) },
		{ key: "lagl", type: "UntF", value: descriptorUnit("#Ang", 0) },
		{ key: "Dstn", type: "UntF", value: descriptorUnit("#Pxl", 1) },
		{ key: "blur", type: "UntF", value: descriptorUnit("#Pxl", 0) },
		{ key: "AntA", type: "bool", value: new Uint8Array([1]) },
		{ key: "Invr", type: "bool", value: new Uint8Array([0]) },
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
	const bevelEntries: Array<{ key: string; type: string; value: Uint8Array }> = [
		{ key: "enab", type: "bool", value: new Uint8Array([1]) },
		{ key: "present", type: "bool", value: new Uint8Array([1]) },
		{ key: "showInDialog", type: "bool", value: new Uint8Array([1]) },
		{ key: "hglM", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "hglC", type: "Objc", value: color([255, 255, 255]) },
		{ key: "hglO", type: "UntF", value: descriptorUnit("#Prc", 50) },
		{ key: "sdwM", type: "enum", value: descriptorEnum("BlnM", "Nrml") },
		{ key: "sdwC", type: "Objc", value: color([0, 0, 0]) },
		{ key: "sdwO", type: "UntF", value: descriptorUnit("#Prc", 50) },
		{ key: "bvlT", type: "enum", value: descriptorEnum("bvlT", options.technique ?? "SfBL") },
		{ key: "bvlS", type: "enum", value: descriptorEnum("BESl", options.style ?? "InrB") },
		{ key: "uglg", type: "bool", value: new Uint8Array([0]) },
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
		{ key: "antialiasGloss", type: "bool", value: new Uint8Array([1]) },
		{ key: "Sftn", type: "UntF", value: descriptorUnit("#Pxl", 0) },
		{ key: "useShape", type: "bool", value: new Uint8Array([options.useShape ? 1 : 0]) },
		{ key: "useTexture", type: "bool", value: new Uint8Array([options.useTexture ? 1 : 0]) },
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
					{ key: "Idnt", type: "TEXT", value: descriptorUnicode("tile-2x2") },
				]),
			},
			{ key: "Scl ", type: "UntF", value: descriptorUnit("#Prc", 100) },
			{ key: "Angl", type: "UntF", value: descriptorUnit("#Ang", 0) },
			{ key: "textureDepth", type: "UntF", value: descriptorUnit("#Prc", 80) },
			{ key: "Invr", type: "bool", value: new Uint8Array([1]) }
		);
	}
	const bevel = descriptorObject("ebbl", bevelEntries);
	return concat(
		uint32(0),
		uint32(16),
		descriptorObject("null", [
			{ key: "masterFXSwitch", type: "bool", value: new Uint8Array([1]) },
			{ key: "ChFX", type: "Objc", value: satin },
			{ key: "ebbl", type: "Objc", value: bevel },
		])
	);
}

function embeddedRgbPattern(compression: 0 | 1 | 2 | 3 = 0, depth: 8 | 16 | 32 = 8): Uint8Array {
	const channel = (values: number[]): Uint8Array => {
		const samples = depth === 32 ? values.map((value) => value / 255) : depth === 16 ? values.map((value) => value * 257) : values;
		const plane = samplePlane(samples, depth);
		let data: Uint8Array = plane;
		const rowByteLength = 2 * (depth === 32 ? 4 : depth === 16 ? 2 : 1);
		if (compression === 1) data = rleImage([literalRow(...plane.subarray(0, rowByteLength)), literalRow(...plane.subarray(rowByteLength, rowByteLength * 2))]);
		if (compression === 2) data = zlibSync(plane);
		if (compression === 3) data = zlibSync(predictedPlane(samples, 2, 2, depth));
		return concat(uint32(1), uint32(23 + data.byteLength), uint32(depth), uint32(0), uint32(0), uint32(2), uint32(2), uint16(depth), new Uint8Array([compression]), data);
	};
	const memory = concat(
		uint32(0),
		uint32(0),
		uint32(2),
		uint32(2),
		uint32(3),
		channel([255, 0, 0, 255]),
		channel([0, 255, 0, 255]),
		channel([0, 0, 255, 255]),
		uint32(0),
		uint32(0)
	);
	const body = concat(
		uint32(1),
		uint32(3),
		int16(0),
		int16(0),
		descriptorUnicode("Test Tile"),
		new Uint8Array([8]),
		ascii("tile-2x2"),
		uint32(3),
		uint32(memory.byteLength),
		memory
	);
	return concat(uint32(body.byteLength), body, new Uint8Array((4 - (body.byteLength % 4)) % 4));
}

function patternTaggedBlock(compression: 0 | 1 | 2 | 3 = 0, depth: 8 | 16 | 32 = 8): Uint8Array {
	const data = embeddedRgbPattern(compression, depth);
	return concat(ascii("8BIM"), ascii("Patt"), uint32(data.byteLength), data, new Uint8Array((4 - (data.byteLength % 4)) % 4));
}

function singleChannelPatternTaggedBlock(colorMode: 1 | 2): Uint8Array {
	const plane = colorMode === 1 ? new Uint8Array([25, 200]) : new Uint8Array([1, 2]);
	const channel = concat(uint32(1), uint32(23 + plane.byteLength), uint32(8), uint32(0), uint32(0), uint32(1), uint32(2), uint16(8), new Uint8Array([0]), plane);
	const memory = concat(uint32(0), uint32(0), uint32(1), uint32(2), uint32(1), channel, uint32(0), uint32(0));
	const palette = new Uint8Array(772);
	palette.set([10, 20, 30], 3);
	palette.set([40, 50, 60], 6);
	const id = colorMode === 1 ? "gray-2x1" : "indexed-2x1";
	const body = concat(
		uint32(1),
		uint32(colorMode),
		int16(0),
		int16(0),
		descriptorUnicode(colorMode === 1 ? "Gray Tile" : "Indexed Tile"),
		new Uint8Array([id.length]),
		ascii(id),
		...(colorMode === 2 ? [palette] : []),
		uint32(3),
		uint32(memory.byteLength),
		memory
	);
	const record = concat(uint32(body.byteLength), body, new Uint8Array((4 - (body.byteLength % 4)) % 4));
	return concat(ascii("8BIM"), ascii("Patt"), uint32(record.byteLength), record, new Uint8Array((4 - (record.byteLength % 4)) % 4));
}

function legacyLayerEffects(options: { color: [number, number, number]; opacity: number; enabled?: boolean; blendMode?: string; visible?: boolean }): Uint8Array {
	const common = concat(ascii("8BIMcmnS"), uint32(7), uint32(0), new Uint8Array([options.visible === false ? 0 : 1]), uint16(0));
	const color = effectColor(...options.color);
	const solidFillData = concat(uint32(2), ascii("8BIM"), ascii(options.blendMode ?? "norm"), color, new Uint8Array([options.opacity, options.enabled === false ? 0 : 1]), color);
	return concat(uint16(0), uint16(2), common, ascii("8BIMsofi"), uint32(solidFillData.byteLength), solidFillData);
}

function legacyInteriorLayerEffects(): Uint8Array {
	const common = concat(ascii("8BIMcmnS"), uint32(7), uint32(0), new Uint8Array([1]), uint16(0));
	const shadowColor = effectColor(10, 20, 30);
	const shadow = concat(uint32(2), uint32(3), uint32(75), int32(-45), uint32(4), shadowColor, ascii("8BIMmul "), new Uint8Array([1, 1, 60]), shadowColor);
	const glowColor = effectColor(200, 150, 100);
	const glow = concat(uint32(2), uint32(2), uint32(80), glowColor, ascii("8BIMscrn"), new Uint8Array([1, 70, 1]), glowColor);
	const dropColor = effectColor(1, 2, 3);
	const drop = concat(uint32(2), uint32(1), uint32(50), int32(90), uint32(2), dropColor, ascii("8BIMmul "), new Uint8Array([1, 0, 40]), dropColor);
	const outerColor = effectColor(30, 60, 90);
	const outer = concat(uint32(2), uint32(2), uint32(70), outerColor, ascii("8BIMscrn"), new Uint8Array([1, 80]), outerColor);
	const highlightColor = effectColor(240, 230, 220);
	const bevelShadowColor = effectColor(20, 30, 40);
	const bevel = concat(
		uint32(2),
		int32(135),
		uint32(4),
		uint32(2),
		ascii("8BIMscrn"),
		ascii("8BIMmul "),
		highlightColor,
		bevelShadowColor,
		new Uint8Array([5, 75, 65, 1, 1, 0]),
		highlightColor,
		bevelShadowColor
	);
	return concat(
		uint16(0),
		uint16(6),
		common,
		ascii("8BIMisdw"),
		uint32(shadow.byteLength),
		shadow,
		ascii("8BIMiglw"),
		uint32(glow.byteLength),
		glow,
		ascii("8BIMdsdw"),
		uint32(drop.byteLength),
		drop,
		ascii("8BIMoglw"),
		uint32(outer.byteLength),
		outer,
		ascii("8BIMbevl"),
		uint32(bevel.byteLength),
		bevel
	);
}

interface ITestLayerChannel {
	id: number;
	compression: 0 | 1 | 2 | 3;
	plane: number[];
	width?: number;
	height?: number;
}

function layerChannelData(channel: ITestLayerChannel, width: number, height: number, psb = false, depth: 8 | 16 | 32 = 8): Uint8Array {
	const plane = samplePlane(channel.plane, depth);
	if (channel.compression === 0) return concat(uint16(0), plane);
	if (channel.compression === 1) {
		const rowByteLength = width * (depth === 32 ? 4 : depth === 16 ? 2 : 1);
		const rows = Array.from({ length: height }, (_, row) => literalRow(...plane.subarray(row * rowByteLength, (row + 1) * rowByteLength)));
		return concat(uint16(1), rleImage(rows, psb));
	}
	if (channel.compression === 2) return concat(uint16(2), zlibSync(plane));
	return concat(uint16(3), zlibSync(predictedPlane(channel.plane, width, height, depth)));
}

function layeredPsdLayer(options: {
	name: string;
	id: number;
	top: number;
	left: number;
	width: number;
	height: number;
	opacity?: number;
	visible?: boolean;
	blendMode?: string;
	additionalInfo?: Uint8Array[];
	mask?: {
		top: number;
		left: number;
		width: number;
		height: number;
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
			defaultColor?: number;
			disabled?: boolean;
			inverted?: boolean;
			positionRelativeToLayer?: boolean;
		};
	};
	channels: ITestLayerChannel[];
	psb?: boolean;
	depth?: 8 | 16 | 32;
}): { record: Uint8Array; data: Uint8Array } {
	const channelData = options.channels.map((channel) => layerChannelData(channel, channel.width ?? options.width, channel.height ?? options.height, options.psb, options.depth));
	const pascal = ascii(options.name.slice(0, 255));
	const pascalBlock = concat(new Uint8Array([pascal.byteLength]), pascal, new Uint8Array((4 - ((1 + pascal.byteLength) % 4)) % 4));
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
		? concat(
				new Uint8Array([parameterFlags]),
				...(options.mask?.userDensity !== undefined ? [new Uint8Array([options.mask.userDensity])] : []),
				...(options.mask?.userFeather !== undefined ? [float64(options.mask.userFeather)] : []),
				...(options.mask?.vectorDensity !== undefined ? [new Uint8Array([options.mask.vectorDensity])] : []),
				...(options.mask?.vectorFeather !== undefined ? [float64(options.mask.vectorFeather)] : [])
			)
		: new Uint8Array();
	const mask = options.mask
		? concat(
				int32(options.mask.top),
				int32(options.mask.left),
				int32(options.mask.top + options.mask.height),
				int32(options.mask.left + options.mask.width),
				new Uint8Array([options.mask.defaultColor ?? 255, maskFlags]),
				maskParameters,
				...(options.mask.realUserMask
					? [
							new Uint8Array([realMaskFlags, options.mask.realUserMask.defaultColor ?? 255]),
							int32(options.mask.realUserMask.top),
							int32(options.mask.realUserMask.left),
							int32(options.mask.realUserMask.top + options.mask.realUserMask.height),
							int32(options.mask.realUserMask.left + options.mask.realUserMask.width),
						]
					: hasMaskParameters
						? []
						: [new Uint8Array([0, 0])])
			)
		: new Uint8Array();
	const extra = concat(
		section(mask),
		uint32(0),
		pascalBlock,
		additionalInfo("luni", unicodeName(options.name)),
		additionalInfo("lyid", uint32(options.id)),
		...(options.additionalInfo ?? [])
	);
	const record = concat(
		int32(options.top),
		int32(options.left),
		int32(options.top + options.height),
		int32(options.left + options.width),
		uint16(options.channels.length),
		...options.channels.map((channel, index) => concat(int16(channel.id), options.psb ? uint64(channelData[index].byteLength) : uint32(channelData[index].byteLength))),
		ascii("8BIM"),
		ascii(options.blendMode ?? "norm"),
		new Uint8Array([options.opacity ?? 255, 0, options.visible === false ? 2 : 0, 0]),
		uint32(extra.byteLength),
		extra
	);
	return { record, data: concat(...channelData) };
}

function layeredPsd(
	layers: ReturnType<typeof layeredPsdLayer>[],
	width: number,
	height: number,
	mergedCompression: 0 | 2 = 0,
	globalBlocks: Uint8Array = new Uint8Array(),
	psb = false,
	depth: 8 | 16 | 32 = 8
): Uint8Array {
	let layerInfo = concat(int16(layers.length), ...layers.map((layer) => layer.record), ...layers.map((layer) => layer.data));
	const layerInfoPadding = (4 - (layerInfo.byteLength % 4)) % 4;
	if (layerInfoPadding) layerInfo = concat(layerInfo, new Uint8Array(layerInfoPadding));
	const layerAndMask = concat(psb ? uint64(layerInfo.byteLength) : uint32(layerInfo.byteLength), layerInfo, uint32(0), globalBlocks);
	const composite = new Uint8Array(width * height * 3 * (depth === 32 ? 4 : depth === 16 ? 2 : 1));
	return psd({
		width,
		height,
		channels: 3,
		colorMode: 3,
		compression: mergedCompression,
		imageData: mergedCompression === 2 ? zlibSync(composite) : composite,
		layerAndMask,
		version: psb ? 2 : 1,
		depth,
	});
}

function alternateLayerInfoPsd(layer: ReturnType<typeof layeredPsdLayer>, width: number, height: number, psb = false): Uint8Array {
	let layerInfo = concat(int16(1), layer.record, layer.data);
	layerInfo = concat(layerInfo, new Uint8Array((4 - (layerInfo.byteLength % 4)) % 4));
	const taggedLayerInfo = concat(ascii("8BIM"), ascii("Lr32"), psb ? uint64(layerInfo.byteLength) : uint32(layerInfo.byteLength), layerInfo);
	const layerAndMask = concat(psb ? uint64(0) : uint32(0), uint32(0), taggedLayerInfo);
	return psd({
		width,
		height,
		channels: 3,
		colorMode: 3,
		compression: 0,
		imageData: new Uint8Array(width * height * 3 * 4),
		layerAndMask,
		version: psb ? 2 : 1,
		depth: 32,
	});
}

describe("bounded PSD merged-composite decoder", () => {
	test("decodes a raw planar RGB composite and exposes skipped section evidence", () => {
		const source = psd({
			width: 2,
			height: 1,
			channels: 3,
			colorMode: 3,
			compression: 0,
			imageData: new Uint8Array([255, 0, 0, 255, 0, 0]),
			imageResources: new Uint8Array([1, 2, 3]),
			layerAndMask: new Uint8Array([4, 5, 6, 7]),
		});
		expect(inspectPsd(source)).toMatchObject({
			version: 1,
			width: 2,
			height: 1,
			depth: 8,
			channels: 3,
			hasAlpha: false,
			colorMode: "rgb",
			compression: "raw",
			imageResourcesBytes: 3,
			layerAndMaskBytes: 4,
			layerDataPresent: true,
			compositeOnly: true,
		});
		expect([...decodePsd(source).pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
	});

	test("decodes bounded PSB-v2 merged raw and 32-bit-row RLE composites", () => {
		const raw = psd({
			version: 2,
			width: 2,
			height: 1,
			channels: 3,
			colorMode: 3,
			compression: 0,
			imageData: new Uint8Array([255, 0, 0, 255, 0, 0]),
		});
		expect(inspectPsd(raw)).toMatchObject({ version: 2, format: "psb-v2", width: 2, height: 1, compression: "raw", layerAndMaskBytes: 0 });
		expect([...decodePsd(raw).pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);

		const rows = [literalRow(10, 20), literalRow(30, 40), literalRow(50, 60)];
		const rle = psd({
			version: 2,
			width: 2,
			height: 1,
			channels: 3,
			colorMode: 3,
			compression: 1,
			imageData: rleImage(rows, true),
		});
		expect(decodePsd(rle)).toMatchObject({
			version: 2,
			format: "psb-v2",
			pixels: new Uint8Array([10, 30, 50, 255, 20, 40, 60, 255]),
		});
	});

	test("decodes 16-bit PSD/PSB merged raw, RLE, ZIP, and sample-predicted ZIP channels into exact RGBA8", () => {
		const planes = [
			[0, 65535],
			[32896, 2570],
			[257, 514],
			[65535, 32896],
		];
		const expected = new Uint8Array([0, 128, 1, 255, 255, 10, 2, 128]);
		for (const version of [1, 2] as const) {
			for (const compression of [0, 1, 2, 3] as const) {
				const raw = concat(...planes.map((plane) => samplePlane(plane, 16)));
				const imageData =
					compression === 0
						? raw
						: compression === 1
							? rleImage(
									planes.map((plane) => literalRow(...samplePlane(plane, 16))),
									version === 2
								)
							: zlibSync(compression === 2 ? raw : concat(...planes.map((plane) => predictedPlane(plane, 2, 1, 16))));
				const source = psd({ version, width: 2, height: 1, channels: 4, colorMode: 3, compression, imageData, depth: 16 });
				expect(inspectPsd(source)).toMatchObject({
					version,
					format: version === 2 ? "psb-v2" : "psd-v1",
					depth: 16,
					sampleByteLength: 2,
					channelConversionModel: "bounded-uint16-to-rgba8-v1",
					compression: ["raw", "rle", "zip", "zipPrediction"][compression],
				});
				expect(decodePsd(source).pixels).toEqual(expected);
			}
		}
	});

	test("decodes real-writer-style concatenated per-channel 16-bit merged ZIP streams", () => {
		const planes = [
			[0, 32896, 65535],
			[0, 32896, 65535],
			[0, 32896, 65535],
			[65535, 65535, 65535],
		];
		for (const compression of [2, 3] as const) {
			const imageData = concat(...planes.map((plane) => zlibSync(compression === 2 ? samplePlane(plane, 16) : predictedPlane(plane, 3, 1, 16))));
			const source = psd({ width: 3, height: 1, channels: 4, colorMode: 3, compression, imageData, depth: 16 });
			expect([...decodePsd(source).pixels]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
		}
	});

	test("decodes 32-bit linear-float PSD/PSB merged raw, RLE, ZIP, and byte-planar predicted ZIP channels", () => {
		const planes = [
			[0, 0.18, 1.5],
			[0.25, 0.5, 0.75],
			[1, 0, 2],
			[1, 0.5, -0.1],
		];
		const expected = new Uint8Array([0, 137, 255, 255, 118, 188, 0, 128, 255, 225, 255, 0]);
		for (const version of [1, 2] as const) {
			for (const compression of [0, 1, 2, 3] as const) {
				const raw = concat(...planes.map((plane) => samplePlane(plane, 32)));
				const imageData =
					compression === 0
						? raw
						: compression === 1
							? rleImage(
									planes.map((plane) => literalRow(...samplePlane(plane, 32))),
									version === 2
								)
							: zlibSync(compression === 2 ? raw : concat(...planes.map((plane) => predictedPlane(plane, 3, 1, 32))));
				const source = psd({ version, width: 3, height: 1, channels: 4, colorMode: 3, compression, imageData, depth: 32 });
				expect(inspectPsd(source)).toMatchObject({
					version,
					format: version === 2 ? "psb-v2" : "psd-v1",
					depth: 32,
					sampleByteLength: 4,
					channelConversionModel: "bounded-linear-float32-to-rgba8-v1",
					compression: ["raw", "rle", "zip", "zipPrediction"][compression],
				});
				expect(decodePsd(source).pixels).toEqual(expected);
			}
		}
	});

	test("decodes 32-bit layer color, transparency, and mask channels across PSD/PSB compression modes", () => {
		for (const psb of [false, true]) {
			for (const compression of [0, 1, 2, 3] as const) {
				const layer = layeredPsdLayer({
					name: "32-bit masked",
					id: 556,
					top: 0,
					left: 0,
					width: 3,
					height: 1,
					psb,
					depth: 32,
					mask: { top: 0, left: 0, width: 3, height: 1 },
					channels: [
						{ id: -2, compression, plane: [1, 0.5, 0] },
						{ id: -1, compression, plane: [1, 0.5, 1] },
						{ id: 0, compression, plane: [0, 0.18, 1] },
						{ id: 1, compression, plane: [0.25, 0.5, 0.75] },
						{ id: 2, compression, plane: [1, 0, 2] },
					],
				});
				const source = layeredPsd([layer], 3, 1, 0, new Uint8Array(), psb, 32);
				const document = inspectPsdLayers(source);
				expect(document).toMatchObject({
					version: psb ? 2 : 1,
					depth: 32,
					sampleByteLength: 4,
					channelConversionModel: "bounded-linear-float32-to-rgba8-v1",
					layers: [{ extractionSupported: true }],
				});
				expect(document.layers[0].channels.every((channel) => channel.depth === 32 && channel.sampleByteLength === 4)).toBe(true);
				expect(decodePsdLayers(source)).toMatchObject([{ pixels: new Uint8Array([0, 137, 255, 255, 118, 188, 0, 64, 255, 225, 255, 0]) }]);
			}
		}
	});

	test("uses authoritative Lr32 alternate layer info with PSD lengths and PSB 8BIM 64-bit tagged lengths", () => {
		for (const psb of [false, true]) {
			const layer = layeredPsdLayer({
				name: "Lr32 writer layer",
				id: 55632,
				top: 0,
				left: 0,
				width: 3,
				height: 1,
				psb,
				depth: 32,
				channels: [
					{ id: 0, compression: 3, plane: [0, 0.18, 1] },
					{ id: 1, compression: 3, plane: [0.25, 0.5, 0.75] },
					{ id: 2, compression: 3, plane: [1, 0, 2] },
				],
			});
			const source = alternateLayerInfoPsd(layer, 3, 1, psb);
			const document = inspectPsdLayers(source);
			expect(document).toMatchObject({ version: psb ? 2 : 1, depth: 32, layerInfoSource: "Lr32", layerCount: 1 });
			expect(decodePsdLayers(source)).toMatchObject([{ pixels: new Uint8Array([0, 137, 255, 255, 118, 188, 0, 255, 255, 225, 255, 255]) }]);
		}
	});

	test("rejects non-finite 32-bit channel samples before publishing RGBA8 pixels", () => {
		const source = psd({
			width: 1,
			height: 1,
			channels: 3,
			colorMode: 3,
			compression: 0,
			imageData: concat(float32(Number.NaN), float32(0), float32(0)),
			depth: 32,
		});
		expect(() => decodePsd(source)).toThrow("non-finite 32-bit floating-point sample");
	});

	test("decodes 16-bit PSD/PSB layer color, transparency, and mask channels across all compression modes", () => {
		for (const psb of [false, true]) {
			const layer = layeredPsdLayer({
				name: "16-bit masked",
				id: 555,
				top: 0,
				left: 0,
				width: 2,
				height: 1,
				psb,
				depth: 16,
				mask: { top: 0, left: 0, width: 2, height: 1 },
				channels: [
					{ id: -2, compression: 0, plane: [65535, 32896] },
					{ id: -1, compression: 0, plane: [65535, 65535] },
					{ id: 0, compression: 1, plane: [0, 65535] },
					{ id: 1, compression: 2, plane: [32896, 2570] },
					{ id: 2, compression: 3, plane: [257, 514] },
				],
			});
			const source = layeredPsd([layer], 2, 1, 0, new Uint8Array(), psb, 16);
			const document = inspectPsdLayers(source);
			expect(document).toMatchObject({
				version: psb ? 2 : 1,
				depth: 16,
				sampleByteLength: 2,
				channelConversionModel: "bounded-uint16-to-rgba8-v1",
				layers: [{ extractionSupported: true }],
			});
			expect(document.layers[0].channels).toHaveLength(5);
			expect(
				document.layers[0].channels.every((channel) => channel.depth === 16 && channel.sampleByteLength === 2 && channel.conversionModel === "bounded-uint16-to-rgba8-v1")
			).toBe(true);
			expect(decodePsdLayers(source)).toMatchObject([{ pixels: new Uint8Array([0, 128, 1, 255, 255, 10, 2, 128]) }]);
		}
	});

	test("decodes bounded PSB-v2 layers with 64-bit channel lengths, 32-bit RLE rows, and 8B64 metadata", () => {
		const layer = layeredPsdLayer({
			name: "PSB RLE Layer",
			id: 554,
			top: 0,
			left: 0,
			width: 2,
			height: 1,
			psb: true,
			additionalInfo: [additionalInfo64("LMsk", new Uint8Array())],
			channels: [
				{ id: -1, compression: 1, plane: [255, 128] },
				{ id: 0, compression: 1, plane: [10, 20] },
				{ id: 1, compression: 1, plane: [30, 40] },
				{ id: 2, compression: 1, plane: [50, 60] },
			],
		});
		const source = layeredPsd([layer], 2, 1, 0, new Uint8Array(), true);
		const document = inspectPsdLayers(source);
		expect(document).toMatchObject({ version: 2, format: "psb-v2", width: 2, height: 1, layerCount: 1, layers: [{ name: "PSB RLE Layer", extractionSupported: true }] });
		expect(decodePsdLayers(source)).toMatchObject([{ name: "PSB RLE Layer", width: 2, height: 1, pixels: new Uint8Array([10, 30, 50, 255, 20, 40, 60, 128]) }]);
		expect(() => replacePsdEmbeddedSmartObjectPayloads(source, [{ resourceIndex: 0, data: new Uint8Array([1]) }])).toThrow("PSB-v2 sources are inspection/extraction-only");
	});

	test("decodes grayscale plus alpha into RGBA8", () => {
		const source = psd({ width: 2, height: 1, channels: 2, colorMode: 1, compression: 0, imageData: new Uint8Array([40, 200, 16, 240]) });
		expect(decodePsd(source)).toMatchObject({
			colorMode: "grayscale",
			channels: 2,
			hasAlpha: true,
			pixels: new Uint8Array([40, 40, 40, 16, 200, 200, 200, 240]),
		});
	});

	test("decodes every PackBits row in channel-major order and preserves alpha", () => {
		const rows = [
			repeatedRow(4, 10),
			repeatedRow(4, 100),
			repeatedRow(4, 20),
			repeatedRow(4, 150),
			repeatedRow(4, 30),
			repeatedRow(4, 200),
			repeatedRow(4, 128),
			repeatedRow(4, 255),
		];
		const source = psd({ width: 4, height: 2, channels: 4, colorMode: 3, compression: 1, imageData: rleImage(rows) });
		const decoded = decodePsd(source);
		expect(decoded).toMatchObject({ compression: "rle", channels: 4, hasAlpha: true });
		expect([...decoded.pixels.subarray(0, 4)]).toEqual([10, 20, 30, 128]);
		expect([...decoded.pixels.subarray(4 * 4 * 1, 4 * 4 * 1 + 4)]).toEqual([100, 150, 200, 255]);
	});

	test("supports literal PackBits rows and validates signature, version, reserved bytes, depth, and color mode", () => {
		const valid = psd({ width: 3, height: 1, channels: 1, colorMode: 1, compression: 1, imageData: rleImage([literalRow(1, 2, 3)]) });
		expect([...decodePsd(valid).pixels]).toEqual([1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255]);

		const signature = valid.slice();
		signature[0] = 0;
		expect(() => inspectPsd(signature)).toThrow("8BPS");
		expect(() => inspectPsd(psd({ width: 1, height: 1, channels: 3, colorMode: 3, compression: 0, imageData: new Uint8Array(3), version: 3 }))).toThrow("document version 3");
		const reserved = valid.slice();
		reserved[6] = 1;
		expect(() => inspectPsd(reserved)).toThrow("reserved header bytes");
		expect(() => inspectPsd(psd({ width: 1, height: 1, channels: 3, colorMode: 3, compression: 0, imageData: new Uint8Array(3), depth: 1 }))).toThrow("channel depth 1");
		expect(() => inspectPsd(psd({ width: 1, height: 1, channels: 4, colorMode: 4, compression: 0, imageData: new Uint8Array(4) }))).toThrow("color mode 4");
	});

	test("rejects unsupported compression and inconsistent raw/RLE/PackBits byte counts", () => {
		expect(() => inspectPsd(psd({ width: 1, height: 1, channels: 3, colorMode: 3, compression: 4, imageData: new Uint8Array() }))).toThrow("compression 4");
		expect(() => decodePsd(psd({ width: 2, height: 1, channels: 3, colorMode: 3, compression: 0, imageData: new Uint8Array(5) }))).toThrow("exactly 6");
		expect(() => decodePsd(psd({ width: 2, height: 1, channels: 1, colorMode: 1, compression: 1, imageData: concat(uint16(4), literalRow(1, 2)) }))).toThrow(
			"declares 4 bytes"
		);
		expect(() => decodePsd(psd({ width: 2, height: 1, channels: 1, colorMode: 1, compression: 1, imageData: rleImage([repeatedRow(3, 1)]) }))).toThrow(
			"exceeds the declared row width"
		);
		expect(() => decodePsd(psd({ width: 3, height: 1, channels: 1, colorMode: 1, compression: 1, imageData: rleImage([literalRow(1, 2)]) }))).toThrow("decoded 2 bytes");
	});

	test("inspects named bounded layers and decodes raw, RLE, ZIP, and ZIP-predicted channels", () => {
		const hero = layeredPsdLayer({
			name: "Hérø",
			id: 17,
			top: 1,
			left: 2,
			width: 2,
			height: 1,
			opacity: 128,
			channels: [
				{ id: 0, compression: 0, plane: [255, 0] },
				{ id: 1, compression: 1, plane: [0, 255] },
				{ id: 2, compression: 2, plane: [40, 50] },
				{ id: -1, compression: 3, plane: [64, 255] },
			],
		});
		const source = layeredPsd([hero], 5, 4, 2);
		const inspected = inspectPsdLayers(source);
		expect(inspected).toMatchObject({ width: 5, height: 4, layerCount: 1, totalPixelLayerPixels: 2 });
		expect(inspected.layers[0]).toMatchObject({ id: 17, name: "Hérø", kind: "pixel", left: 2, top: 1, width: 2, height: 1, opacity: 128, extractionSupported: true });
		expect(inspected.layers[0].channels.map((channel) => channel.compression)).toEqual(["raw", "rle", "zip", "zipPrediction"]);
		const decoded = decodePsdLayers(source);
		expect(decoded).toHaveLength(1);
		expect([...decoded[0].pixels]).toEqual([255, 0, 40, 64, 0, 255, 50, 255]);
	});

	test("reports non-pixel layers and isolated-composition warnings without decoding them", () => {
		const layer = layeredPsdLayer({
			name: "Multiply",
			id: 9,
			top: -2,
			left: -3,
			width: 1,
			height: 1,
			blendMode: "mul ",
			visible: false,
			channels: [
				{ id: 0, compression: 0, plane: [1] },
				{ id: 1, compression: 0, plane: [2] },
				{ id: 2, compression: 0, plane: [3] },
				{ id: -2, compression: 0, plane: [255] },
			],
		});
		const source = layeredPsd([layer], 2, 2);
		const info = inspectPsdLayers(source).layers[0];
		expect(info.visible).toBe(false);
		expect(info.warnings).toEqual(expect.arrayContaining([expect.stringContaining("mask"), expect.stringContaining("Blend mode")]));
		expect(decodePsdLayers(source)[0].pixels).toEqual(new Uint8Array([1, 2, 3, 255]));
	});

	test("reads the exact pass-through blend key from a real PSD section-divider record", () => {
		const groupEnd = layeredPsdLayer({
			name: "</Layer group>",
			id: 18,
			top: 0,
			left: 0,
			width: 0,
			height: 0,
			channels: [],
			additionalInfo: [additionalInfo("lsct", uint32(3))],
		});
		const groupStart = layeredPsdLayer({
			name: "Pass Through Group",
			id: 19,
			top: 0,
			left: 0,
			width: 0,
			height: 0,
			blendMode: "norm",
			channels: [],
			additionalInfo: [additionalInfo("lsct", concat(uint32(1), ascii("8BIM"), ascii("pass")))],
		});
		const layers = inspectPsdLayers(layeredPsd([groupEnd, groupStart], 1, 1)).layers;
		expect(layers).toMatchObject([
			{ kind: "groupEnd", blendMode: "norm" },
			{ kind: "groupStart", blendMode: "pass" },
		]);
	});

	test("decodes a bounded primary layer mask with independent dimensions and multiplies it into alpha", () => {
		const layer = layeredPsdLayer({
			name: "Masked",
			id: 21,
			top: 4,
			left: 7,
			width: 2,
			height: 1,
			mask: { top: 4, left: 7, width: 1, height: 1, defaultColor: 255 },
			channels: [
				{ id: 0, compression: 0, plane: [10, 20] },
				{ id: 1, compression: 0, plane: [30, 40] },
				{ id: 2, compression: 0, plane: [50, 60] },
				{ id: -1, compression: 0, plane: [200, 100] },
				{ id: -2, compression: 3, plane: [128], width: 1, height: 1 },
			],
		});
		const source = layeredPsd([layer], 12, 8);
		const info = inspectPsdLayers(source).layers[0];
		expect(info.mask).toMatchObject({ top: 4, left: 7, width: 1, height: 1, defaultColor: 255, disabled: false, inverted: false });
		expect(info.channels.find((channel) => channel.id === -2)).toMatchObject({ compression: "zipPrediction", width: 1, height: 1 });
		expect(info.warnings).toEqual([]);
		expect(info.fillOpacity).toBe(255);
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([10, 30, 50, 100, 20, 40, 60, 100]);
	});

	test("preserves the exact lmgm Layer Mask Hides Effects flag and can defer its raster mask", () => {
		const layerOptions: Parameters<typeof layeredPsdLayer>[0] = {
			name: "Global Layer Mask",
			id: 210,
			top: 0,
			left: 0,
			width: 2,
			height: 1,
			mask: { top: 0, left: 0, width: 2, height: 1, defaultColor: 255 },
			additionalInfo: [additionalInfo("lmgm", new Uint8Array([1, 0, 0, 0]))],
			channels: [
				{ id: 0, compression: 0, plane: [10, 20] },
				{ id: 1, compression: 0, plane: [30, 40] },
				{ id: 2, compression: 0, plane: [50, 60] },
				{ id: -1, compression: 0, plane: [200, 100] },
				{ id: -2, compression: 0, plane: [128, 64], width: 2, height: 1 },
			],
		};
		const layer = layeredPsdLayer(layerOptions);
		const source = layeredPsd([layer], 2, 1);
		expect(inspectPsdLayers(source).layers[0].advancedBlending).toEqual({
			blendClippedLayersAsGroup: null,
			blendInteriorEffectsAsGroup: null,
			transparencyShapesLayer: null,
			knockout: "none",
			layerMaskAsGlobalMask: true,
			vectorMaskAsGlobalMask: null,
			executionModel: "psd-advanced-layer-style-flags-v1",
		});
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([10, 30, 50, 100, 20, 40, 60, 25]);
		expect([...decodePsdLayers(source, { deferGlobalLayerMasks: true })[0].pixels]).toEqual([10, 30, 50, 200, 20, 40, 60, 100]);
		expect([...decodePsdLayerMasks(source, [0], { left: 0, top: 0, width: 2, height: 1 }, { includeVector: false })[0].coverage]).toEqual([128, 64]);

		const malformed = layeredPsd(
			[
				layeredPsdLayer({
					...layerOptions,
					additionalInfo: [additionalInfo("lmgm", new Uint8Array([2, 0, 0, 0]))],
				}),
			],
			2,
			1
		);
		expect(() => inspectPsdLayers(malformed)).toThrow("lmgm advanced-blending flag");
	});

	test("preserves the exact vmgm Vector Mask Hides Effects flag and can defer its vector mask", () => {
		const layerOptions: Parameters<typeof layeredPsdLayer>[0] = {
			name: "Global Vector Mask",
			id: 211,
			top: 0,
			left: 0,
			width: 4,
			height: 1,
			additionalInfo: [additionalInfo("vmsk", concat(vectorMaskRectangle(0.25, 0, 0.75, 1), new Uint8Array(2))), additionalInfo("vmgm", new Uint8Array([1, 0, 0, 0]))],
			channels: [
				{ id: 0, compression: 0, plane: [10, 20, 30, 40] },
				{ id: 1, compression: 0, plane: [50, 60, 70, 80] },
				{ id: 2, compression: 0, plane: [90, 100, 110, 120] },
				{ id: -1, compression: 0, plane: [200, 200, 200, 200] },
			],
		};
		const source = layeredPsd([layeredPsdLayer(layerOptions)], 4, 1);
		expect(inspectPsdLayers(source).layers[0].advancedBlending).toEqual({
			blendClippedLayersAsGroup: null,
			blendInteriorEffectsAsGroup: null,
			transparencyShapesLayer: null,
			knockout: "none",
			layerMaskAsGlobalMask: null,
			vectorMaskAsGlobalMask: true,
			executionModel: "psd-advanced-layer-style-flags-v1",
		});
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([10, 50, 90, 0, 20, 60, 100, 200, 30, 70, 110, 200, 40, 80, 120, 0]);
		expect([...decodePsdLayers(source, { deferGlobalVectorMasks: true })[0].pixels]).toEqual([10, 50, 90, 200, 20, 60, 100, 200, 30, 70, 110, 200, 40, 80, 120, 200]);
		expect([...decodePsdLayerMasks(source, [0], { left: 0, top: 0, width: 4, height: 1 }, { includeRaster: false })[0].coverage]).toEqual([0, 255, 255, 0]);

		const malformed = layeredPsd(
			[
				layeredPsdLayer({
					...layerOptions,
					additionalInfo: [
						additionalInfo("vmsk", concat(vectorMaskRectangle(0.25, 0, 0.75, 1), new Uint8Array(2))),
						additionalInfo("vmgm", new Uint8Array([1, 0, 1, 0])),
					],
				}),
			],
			4,
			1
		);
		expect(() => inspectPsdLayers(malformed)).toThrow("vmgm advanced-blending flag");
		const malformedPadding = layeredPsd(
			[
				layeredPsdLayer({
					...layerOptions,
					additionalInfo: [additionalInfo("vmsk", concat(vectorMaskRectangle(0.25, 0, 0.75, 1), new Uint8Array([0, 1])))],
				}),
			],
			4,
			1
		);
		expect(() => inspectPsdLayers(malformedPadding)).toThrow("path-record padding must be zero");
	});

	test("preserves exact infx Blend Interior Effects as Group true and false flags", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Interior Effects Grouped",
					id: 212,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("infx", new Uint8Array([1, 0, 0, 0]))],
					channels: [
						{ id: 0, compression: 0, plane: [10] },
						{ id: 1, compression: 0, plane: [20] },
						{ id: 2, compression: 0, plane: [30] },
						{ id: -1, compression: 0, plane: [255] },
					],
				}),
				layeredPsdLayer({
					name: "Interior Effects Independent",
					id: 213,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("infx", new Uint8Array([0, 0, 0, 0]))],
					channels: [
						{ id: 0, compression: 0, plane: [40] },
						{ id: 1, compression: 0, plane: [50] },
						{ id: 2, compression: 0, plane: [60] },
						{ id: -1, compression: 0, plane: [255] },
					],
				}),
			],
			1,
			1
		);
		expect(inspectPsdLayers(source).layers.map((layer) => layer.advancedBlending)).toEqual([
			{
				blendClippedLayersAsGroup: null,
				blendInteriorEffectsAsGroup: true,
				transparencyShapesLayer: null,
				knockout: "none",
				layerMaskAsGlobalMask: null,
				vectorMaskAsGlobalMask: null,
				executionModel: "psd-advanced-layer-style-flags-v1",
			},
			{
				blendClippedLayersAsGroup: null,
				blendInteriorEffectsAsGroup: false,
				transparencyShapesLayer: null,
				knockout: "none",
				layerMaskAsGlobalMask: null,
				vectorMaskAsGlobalMask: null,
				executionModel: "psd-advanced-layer-style-flags-v1",
			},
		]);
		const malformed = layeredPsd(
			[
				layeredPsdLayer({
					name: "Malformed Interior Effects",
					id: 214,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("infx", new Uint8Array([0, 0, 0, 1]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(malformed)).toThrow("infx advanced-blending flag");
	});

	test("preserves exact clbl Blend Clipped Layers as Group true and false flags", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Clipped Layers Grouped",
					id: 215,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("clbl", new Uint8Array([1, 0, 0, 0]))],
					channels: [],
				}),
				layeredPsdLayer({
					name: "Clipped Layers Independent",
					id: 216,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("clbl", new Uint8Array([0, 0, 0, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(inspectPsdLayers(source).layers.map((layer) => layer.advancedBlending)).toEqual([
			{
				blendClippedLayersAsGroup: true,
				blendInteriorEffectsAsGroup: null,
				transparencyShapesLayer: null,
				knockout: "none",
				layerMaskAsGlobalMask: null,
				vectorMaskAsGlobalMask: null,
				executionModel: "psd-advanced-layer-style-flags-v1",
			},
			{
				blendClippedLayersAsGroup: false,
				blendInteriorEffectsAsGroup: null,
				transparencyShapesLayer: null,
				knockout: "none",
				layerMaskAsGlobalMask: null,
				vectorMaskAsGlobalMask: null,
				executionModel: "psd-advanced-layer-style-flags-v1",
			},
		]);
		const malformed = layeredPsd(
			[
				layeredPsdLayer({
					name: "Malformed Clipped Layers",
					id: 217,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("clbl", new Uint8Array([1, 0, 1, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(malformed)).toThrow("clbl advanced-blending flag");
	});

	test("preserves exact tsly Transparency Shapes Layer and iOpa fill opacity records", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Transparency Is Shape",
					id: 218,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("tsly", new Uint8Array([1, 0, 0, 0])), additionalInfo("iOpa", new Uint8Array([96, 0, 0, 0]))],
					channels: [],
				}),
				layeredPsdLayer({
					name: "Transparency Is Fill",
					id: 219,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("tsly", new Uint8Array([0, 0, 0, 0])), additionalInfo("iOpa", new Uint8Array([160, 0, 0, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		const layers = inspectPsdLayers(source).layers;
		expect(layers.map((layer) => ({ fillOpacity: layer.fillOpacity, advancedBlending: layer.advancedBlending }))).toEqual([
			{
				fillOpacity: 96,
				advancedBlending: {
					blendClippedLayersAsGroup: null,
					blendInteriorEffectsAsGroup: null,
					transparencyShapesLayer: true,
					knockout: "none",
					layerMaskAsGlobalMask: null,
					vectorMaskAsGlobalMask: null,
					executionModel: "psd-advanced-layer-style-flags-v1",
				},
			},
			{
				fillOpacity: 160,
				advancedBlending: {
					blendClippedLayersAsGroup: null,
					blendInteriorEffectsAsGroup: null,
					transparencyShapesLayer: false,
					knockout: "none",
					layerMaskAsGlobalMask: null,
					vectorMaskAsGlobalMask: null,
					executionModel: "psd-advanced-layer-style-flags-v1",
				},
			},
		]);
		const malformedFlag = layeredPsd(
			[
				layeredPsdLayer({
					name: "Malformed Transparency Shape",
					id: 220,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("tsly", new Uint8Array([0, 1, 0, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(malformedFlag)).toThrow("tsly advanced-blending flag");
		const malformedFill = layeredPsd(
			[
				layeredPsdLayer({
					name: "Malformed Fill Opacity",
					id: 221,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("iOpa", new Uint8Array([128, 0, 1, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(malformedFill)).toThrow("iOpa fill-opacity record");
	});

	test("preserves exact absent, shallow, and deep knko Knockout states", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({ name: "None", id: 222, top: 0, left: 0, width: 1, height: 1, channels: [] }),
				layeredPsdLayer({
					name: "Shallow",
					id: 223,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("knko", new Uint8Array([0, 0, 0, 0]))],
					channels: [],
				}),
				layeredPsdLayer({
					name: "Deep",
					id: 224,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("knko", new Uint8Array([1, 0, 0, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(inspectPsdLayers(source).layers.map((layer) => layer.advancedBlending.knockout)).toEqual(["none", "shallow", "deep"]);
		const malformed = layeredPsd(
			[
				layeredPsdLayer({
					name: "Malformed Knockout",
					id: 225,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("knko", new Uint8Array([1, 0, 1, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(malformed)).toThrow("knko advanced-blending setting");
	});

	test("preserves exact lspf protection flags and unknown future bits", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({ name: "No Locks", id: 226, top: 0, left: 0, width: 1, height: 1, channels: [] }),
				layeredPsdLayer({
					name: "All Known Plus Future",
					id: 227,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("lspf", new Uint8Array([0x80, 0, 0, 0x0f]))],
					channels: [],
				}),
			],
			1,
			1
		);
		const layers = inspectPsdLayers(source).layers;
		expect(layers[0].protectedSettings).toBeUndefined();
		expect(layers[1].protectedSettings).toEqual({
			transparency: true,
			composite: true,
			position: true,
			artboardAutonest: true,
			rawFlags: 0x8000000f,
			unknownFlags: 0x80000000,
			executionModel: "psd-protected-settings-v1",
		});
		expect(layers[1].warnings).toContain("Protected Settings preserves unknown lspf flags 0x80000000; their meaning is not interpreted.");
		const malformedLength = layeredPsd(
			[
				layeredPsdLayer({
					name: "Malformed Protection",
					id: 228,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("lspf", new Uint8Array([0, 0, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(malformedLength)).toThrow("lspf protected-settings record");
		const duplicate = layeredPsd(
			[
				layeredPsdLayer({
					name: "Duplicate Protection",
					id: 229,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("lspf", new Uint8Array([0, 0, 0, 1])), additionalInfo("lspf", new Uint8Array([0, 0, 0, 2]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(duplicate)).toThrow("more than one lspf");
	});

	test("preserves exact lclr sheet colors, explicit none, unknown codes, and reserved values", () => {
		const colorNames = ["none", "red", "orange", "yellow", "green", "blue", "violet", "gray"];
		const source = layeredPsd(
			[
				layeredPsdLayer({ name: "Absent Color", id: 230, top: 0, left: 0, width: 1, height: 1, channels: [] }),
				...colorNames.map((name, colorCode) =>
					layeredPsdLayer({
						name,
						id: 231 + colorCode,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("lclr", new Uint8Array([0, colorCode, 0, 0, 0, 0, 0, 0]))],
						channels: [],
					})
				),
				layeredPsdLayer({
					name: "Future Color And Reserved Values",
					id: 239,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("lclr", new Uint8Array([0x12, 0x34, 0, 1, 0, 2, 0xff, 0xff]))],
					channels: [],
				}),
			],
			1,
			1
		);
		const layers = inspectPsdLayers(source).layers;
		expect(layers[0].sheetColor).toBeUndefined();
		expect(layers.slice(1, 9).map((layer) => layer.sheetColor)).toEqual(
			colorNames.map((color, colorCode) => ({
				color,
				colorCode,
				reservedValues: [0, 0, 0],
				reservedNonZero: false,
				executionModel: "psd-sheet-color-v1",
			}))
		);
		expect(layers[9].sheetColor).toEqual({
			color: "unknown",
			colorCode: 0x1234,
			reservedValues: [1, 2, 0xffff],
			reservedNonZero: true,
			executionModel: "psd-sheet-color-v1",
		});
		expect(layers[9].warnings).toContain("Sheet Color preserves unknown lclr color code 4660; its label color is not interpreted.");
		expect(layers[9].warnings).toContain("Sheet Color preserves non-zero lclr reserved values 1, 2, 65535; their meaning is not interpreted.");
		for (const payloadLength of [7, 9]) {
			const malformed = layeredPsd(
				[
					layeredPsdLayer({
						name: `Malformed Color ${payloadLength}`,
						id: 240 + payloadLength,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("lclr", new Uint8Array(payloadLength))],
						channels: [],
					}),
				],
				1,
				1
			);
			expect(() => inspectPsdLayers(malformed)).toThrow("lclr sheet-color record");
		}
		const duplicate = layeredPsd(
			[
				layeredPsdLayer({
					name: "Duplicate Color",
					id: 250,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("lclr", new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0])), additionalInfo("lclr", new Uint8Array([0, 2, 0, 0, 0, 0, 0, 0]))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(duplicate)).toThrow("more than one lclr");
	});

	test("preserves exact fxrp effects reference points and rejects malformed coordinates", () => {
		const referencePoint = (x: number, y: number): Uint8Array => {
			const result = new Uint8Array(16);
			const view = new DataView(result.buffer);
			view.setFloat64(0, x, false);
			view.setFloat64(8, y, false);
			return result;
		};
		const source = layeredPsd(
			[
				layeredPsdLayer({ name: "Absent Reference", id: 251, top: 0, left: 0, width: 1, height: 1, channels: [] }),
				layeredPsdLayer({
					name: "Explicit Origin",
					id: 252,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("fxrp", referencePoint(0, 0))],
					channels: [],
				}),
				layeredPsdLayer({
					name: "Signed Fractional Reference",
					id: 253,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("fxrp", referencePoint(12.5, -3.25))],
					channels: [],
				}),
			],
			1,
			1
		);
		const layers = inspectPsdLayers(source).layers;
		expect(layers[0].effectsReferencePoint).toBeUndefined();
		expect(layers[1].effectsReferencePoint).toEqual({
			sourceKey: "fxrp",
			x: 0,
			y: 0,
			axisOrder: "x-y",
			executionModel: "psd-effects-reference-point-v1",
		});
		expect(layers[2].effectsReferencePoint).toEqual({
			sourceKey: "fxrp",
			x: 12.5,
			y: -3.25,
			axisOrder: "x-y",
			executionModel: "psd-effects-reference-point-v1",
		});
		for (const payloadLength of [15, 17]) {
			const malformed = layeredPsd(
				[
					layeredPsdLayer({
						name: `Malformed Reference ${payloadLength}`,
						id: 254 + payloadLength,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("fxrp", new Uint8Array(payloadLength))],
						channels: [],
					}),
				],
				1,
				1
			);
			expect(() => inspectPsdLayers(malformed)).toThrow("fxrp effects-reference-point record");
		}
		for (const [x, y] of [
			[Number.NaN, 0],
			[0, Number.POSITIVE_INFINITY],
		]) {
			const malformed = layeredPsd(
				[
					layeredPsdLayer({
						name: "Non-Finite Reference",
						id: 272,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("fxrp", referencePoint(x, y))],
						channels: [],
					}),
				],
				1,
				1
			);
			expect(() => inspectPsdLayers(malformed)).toThrow("fxrp effects-reference-point coordinates must be finite");
		}
		const duplicate = layeredPsd(
			[
				layeredPsdLayer({
					name: "Duplicate Reference",
					id: 273,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("fxrp", referencePoint(1, 2)), additionalInfo("fxrp", referencePoint(3, 4))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(duplicate)).toThrow("more than one fxrp");
	});

	test("preserves and validates exact brst channel blending restrictions", () => {
		const restrictions = (...channelIds: number[]): Uint8Array => {
			const result = new Uint8Array(channelIds.length * 4);
			const view = new DataView(result.buffer);
			channelIds.forEach((channelId, index) => view.setInt32(index * 4, channelId, false));
			return result;
		};
		const source = layeredPsd(
			[
				layeredPsdLayer({ name: "Absent Restrictions", id: 274, top: 0, left: 0, width: 1, height: 1, channels: [] }),
				layeredPsdLayer({
					name: "Explicit Empty Restrictions",
					id: 275,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("brst", restrictions())],
					channels: [],
				}),
				layeredPsdLayer({
					name: "Ordered Restrictions",
					id: 276,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("brst", restrictions(2, 0, 2, -1, 3))],
					channels: [],
				}),
			],
			1,
			1
		);
		const layers = inspectPsdLayers(source).layers;
		expect(layers[0].channelBlendingRestrictions).toBeUndefined();
		expect(layers[1].channelBlendingRestrictions).toEqual({
			sourceKey: "brst",
			channelIds: [],
			restrictedChannels: [],
			unsupportedChannelIds: [],
			duplicateChannelIds: [],
			executionModel: "bounded-channel-blending-restrictions-v1",
		});
		expect(layers[2].channelBlendingRestrictions).toEqual({
			sourceKey: "brst",
			channelIds: [2, 0, 2, -1, 3],
			restrictedChannels: ["blue", "red", "blue"],
			unsupportedChannelIds: [-1, 3],
			duplicateChannelIds: [2],
			executionModel: "bounded-channel-blending-restrictions-v1",
		});
		expect(layers[2].warnings).toContain("Channel Blending Restrictions preserves unsupported brst channel id(s) -1, 3; only document color channels execute.");
		expect(layers[2].warnings).toContain("Channel Blending Restrictions preserves duplicate brst channel id(s) 2; restriction execution is idempotent.");
		for (const payloadLength of [1, 3, 5]) {
			const malformed = layeredPsd(
				[
					layeredPsdLayer({
						name: `Malformed Restrictions ${payloadLength}`,
						id: 277 + payloadLength,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("brst", new Uint8Array(payloadLength))],
						channels: [],
					}),
				],
				1,
				1
			);
			expect(() => inspectPsdLayers(malformed)).toThrow("brst channel-blending-restrictions record length must be divisible by four");
		}
		const duplicate = layeredPsd(
			[
				layeredPsdLayer({
					name: "Duplicate Restrictions",
					id: 283,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("brst", restrictions()), additionalInfo("brst", restrictions(0))],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(duplicate)).toThrow("more than one brst");
	});

	test("parses and executes bounded SoCo solid-color fill layers with generated or authored coverage", () => {
		const numeric = (key: string, value: number): { key: string; type: string; value: Uint8Array } => ({ key, type: "doub", value: float64(value) });
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "RGB Coverage",
					id: 284,
					top: 0,
					left: 0,
					width: 2,
					height: 1,
					additionalInfo: [additionalInfo("SoCo", solidColorFillDescriptor("RGBC", [numeric("Rd  ", 210), numeric("Grn ", 40), numeric("Bl  ", 80)]))],
					channels: [
						{ id: -1, compression: 0, plane: [255, 64] },
						{ id: 0, compression: 0, plane: [1, 2] },
						{ id: 1, compression: 0, plane: [3, 4] },
						{ id: 2, compression: 0, plane: [5, 6] },
					],
				}),
				layeredPsdLayer({
					name: "Generated Gray",
					id: 285,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [additionalInfo("SoCo", solidColorFillDescriptor("GRYC", [numeric("Gry ", 50)]))],
					channels: [],
				}),
				layeredPsdLayer({
					name: "HSB",
					id: 286,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [
						additionalInfo(
							"SoCo",
							solidColorFillDescriptor("HSBC", [{ key: "H   ", type: "UntF", value: descriptorUnit("#Ang", 0) }, numeric("Strt", 100), numeric("Brgh", 100)])
						),
					],
					channels: [{ id: -1, compression: 0, plane: [255] }],
				}),
				layeredPsdLayer({
					name: "CMYK",
					id: 287,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("SoCo", solidColorFillDescriptor("CMYC", [numeric("Cyn ", 100), numeric("Mgnt", 0), numeric("Ylw ", 0), numeric("Blck", 0)]))],
					channels: [{ id: -1, compression: 0, plane: [255] }],
				}),
				layeredPsdLayer({
					name: "Float RGB",
					id: 288,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("SoCo", solidColorFillDescriptor("RGBC", [numeric("redFloat", 0.25), numeric("greenFloat", 0.5), numeric("blueFloat", 0.75)]))],
					channels: [{ id: -1, compression: 0, plane: [255] }],
				}),
				layeredPsdLayer({
					name: "Lab",
					id: 289,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("SoCo", solidColorFillDescriptor("LABC", [numeric("Lmnc", 100), numeric("A   ", 0), numeric("B   ", 0)]))],
					channels: [{ id: -1, compression: 0, plane: [255] }],
				}),
				layeredPsdLayer({
					name: "Unsupported",
					id: 290,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("SoCo", solidColorFillDescriptor("XYZC", [numeric("X   ", 1)]))],
					channels: [{ id: -1, compression: 0, plane: [255] }],
				}),
			],
			2,
			1
		);
		const inspected = inspectPsdLayers(source);
		expect(inspected.layers[0].solidColorFill).toMatchObject({
			sourceKey: "SoCo",
			descriptorVersion: 16,
			colorModel: "rgb",
			authoredValues: [210, 40, 80],
			rgba: [210, 40, 80, 255],
			renderBounds: "layer",
			coverageSource: "transparency-channel",
			executionModel: "bounded-solid-color-fill-layer-v1",
			bakeSupported: true,
		});
		expect(inspected.layers[1].solidColorFill).toMatchObject({
			colorModel: "gray",
			authoredValues: [50],
			rgba: [128, 128, 128, 255],
			renderBounds: "document",
			coverageSource: "opaque-generated",
		});
		expect(inspected.layers.map((layer) => layer.solidColorFill?.colorModel)).toEqual(["rgb", "gray", "hsb", "cmyk", "floatRgb", "lab", "unknown"]);
		expect(inspected.layers[6].extractionSupported).toBe(false);
		expect(inspected.layers[6].warnings[0]).toContain("unsupported XYZC descriptor");
		const decoded = decodePsdLayers(source);
		expect([...decoded[0].pixels]).toEqual([210, 40, 80, 255, 210, 40, 80, 64]);
		expect([decoded[1].left, decoded[1].top, decoded[1].width, decoded[1].height, ...decoded[1].pixels]).toEqual([0, 0, 2, 1, 128, 128, 128, 255, 128, 128, 128, 255]);
		expect([...decoded[2].pixels]).toEqual([255, 0, 0, 255]);
		expect([...decoded[3].pixels]).toEqual([0, 255, 255, 255]);
		expect([...decoded[4].pixels]).toEqual([64, 128, 191, 255]);
		expect([...decoded[5].pixels]).toEqual([255, 255, 255, 255]);

		const malformedPayloads = [
			solidColorFillDescriptor("RGBC", [numeric("Rd  ", 1), numeric("Grn ", 2), numeric("Bl  ", 3)], 15),
			concat(solidColorFillDescriptor("RGBC", [numeric("Rd  ", 1), numeric("Grn ", 2), numeric("Bl  ", 3)]), new Uint8Array([1])),
			concat(uint32(16), descriptorObject("null", [])),
			solidColorFillDescriptor("RGBC", [numeric("Gry ", 50)]),
			solidColorFillDescriptor("RGBC", [
				numeric("Rd  ", 1),
				numeric("Grn ", 2),
				numeric("Bl  ", 3),
				numeric("redFloat", 0.1),
				numeric("greenFloat", 0.2),
				numeric("blueFloat", 0.3),
			]),
		];
		for (const [index, payload] of malformedPayloads.entries()) {
			const malformed = layeredPsd(
				[
					layeredPsdLayer({
						name: `Malformed SoCo ${index}`,
						id: 291 + index,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("SoCo", payload)],
						channels: [],
					}),
				],
				1,
				1
			);
			expect(() => inspectPsdLayers(malformed)).toThrow(/SoCo/);
		}
		const duplicate = layeredPsd(
			[
				layeredPsdLayer({
					name: "Duplicate SoCo",
					id: 294,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [
						additionalInfo("SoCo", solidColorFillDescriptor("RGBC", [numeric("Rd  ", 1), numeric("Grn ", 2), numeric("Bl  ", 3)])),
						additionalInfo("SoCo", solidColorFillDescriptor("RGBC", [numeric("Rd  ", 4), numeric("Grn ", 5), numeric("Bl  ", 6)])),
					],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(duplicate)).toThrow("more than one SoCo");
	});

	test("parses, resolves, and executes bounded PtFl pattern-fill layers with exact coverage and document bounds", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Pattern Coverage",
					id: 295,
					top: 3,
					left: 4,
					width: 2,
					height: 2,
					additionalInfo: [additionalInfo("PtFl", patternFillDescriptor({ linked: true })), patternTaggedBlock()],
					channels: [
						{ id: -1, compression: 0, plane: [255, 128, 0, 64] },
						{ id: 0, compression: 0, plane: [7, 7, 7, 7] },
						{ id: 1, compression: 0, plane: [8, 8, 8, 8] },
						{ id: 2, compression: 0, plane: [9, 9, 9, 9] },
					],
				}),
				layeredPsdLayer({
					name: "Generated Pattern",
					id: 296,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [
						additionalInfo("PtFl", concat(patternFillDescriptor({ scale: 100, angle: 0, align: false, linked: false, phase: [1, -1] }), new Uint8Array([0]))),
					],
					channels: [],
				}),
			],
			2,
			2,
			0
		);
		const inspected = inspectPsdLayers(source);
		expect(inspected.layers[0].patternFill).toMatchObject({
			sourceKey: "PtFl",
			descriptorVersion: 16,
			descriptorClassId: "null",
			patternClassId: "Ptrn",
			renderBounds: "layer",
			coverageSource: "transparency-channel",
			executionModel: "bounded-pattern-fill-layer-v1",
			bakeSupported: true,
			pattern: {
				name: "Test Tile",
				id: "tile-2x2",
				resolutionStatus: "resolved",
				resolvedPatternIndices: [0],
				resolvedPatternIndex: 0,
				resolvedWidth: 2,
				resolvedHeight: 2,
				bakeSupported: true,
			},
		});
		expect(inspected.layers[1].patternFill).toMatchObject({
			descriptorPaddingBytes: 1,
			renderBounds: "document",
			coverageSource: "opaque-generated",
			pattern: { align: false, linked: false, phaseX: 1, phaseY: -1 },
		});
		const decoded = decodePsdLayers(source);
		expect([...decoded[0].pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 64]);
		expect([decoded[1].left, decoded[1].top, decoded[1].width, decoded[1].height, ...decoded[1].pixels]).toEqual([
			0, 0, 2, 2, 255, 255, 255, 255, 0, 0, 255, 255, 0, 255, 0, 255, 255, 0, 0, 255,
		]);
	});

	test("rejects malformed or duplicate PtFl descriptors and blocks ambiguous embedded-pattern IDs", () => {
		const ptrn = descriptorObject("Ptrn", [
			{ key: "Nm  ", type: "TEXT", value: descriptorUnicode("Test Tile") },
			{ key: "Idnt", type: "TEXT", value: descriptorUnicode("tile-2x2") },
		]);
		const malformedPayloads = [
			patternFillDescriptor({ version: 15 }),
			concat(patternFillDescriptor(), new Uint8Array([1])),
			patternFillDescriptor({ rootClassId: "PtFl" }),
			concat(uint32(16), descriptorObject("null", [])),
			patternFillDescriptor({ patternClassId: "null" }),
			patternFillDescriptor({ extraEntries: [{ key: "Ptrn", type: "Objc", value: ptrn }] }),
			patternFillDescriptor({ extraEntries: [{ key: "Scl ", type: "doub", value: float64(100) }] }),
			patternFillDescriptor({ scale: 0 }),
			patternFillDescriptor({ phase: [Number.NaN, 0] }),
		];
		for (const [index, payload] of malformedPayloads.entries()) {
			const malformed = layeredPsd(
				[
					layeredPsdLayer({
						name: `Malformed PtFl ${index}`,
						id: 300 + index,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("PtFl", payload)],
						channels: [],
					}),
				],
				1,
				1
			);
			expect(() => inspectPsdLayers(malformed), `malformed case ${index}`).toThrow(/PtFl/);
		}
		const duplicate = layeredPsd(
			[
				layeredPsdLayer({
					name: "Duplicate PtFl",
					id: 310,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("PtFl", patternFillDescriptor()), additionalInfo("PtFl", patternFillDescriptor())],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(duplicate)).toThrow("more than one PtFl");
		const ambiguous = layeredPsd(
			[
				layeredPsdLayer({
					name: "Ambiguous Pattern",
					id: 311,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("PtFl", patternFillDescriptor())],
					channels: [],
				}),
			],
			1,
			1,
			0,
			concat(patternTaggedBlock(), patternTaggedBlock())
		);
		expect(inspectPsdLayers(ambiguous).layers[0]).toMatchObject({
			extractionSupported: false,
			patternFill: { bakeSupported: false, pattern: { resolutionStatus: "ambiguous", resolvedPatternIndices: [0, 1], resolvedPatternIndex: null } },
		});
		expect(decodePsdLayers(ambiguous)).toEqual([]);
	});

	test("parses and executes bounded solid and seeded-noise GdFl gradient-fill layers", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Gradient Coverage",
					id: 312,
					top: 0,
					left: 1,
					width: 2,
					height: 1,
					additionalInfo: [additionalInfo("GdFl", gradientFillDescriptor({ padding: [0, 0] }))],
					channels: [
						{ id: -1, compression: 0, plane: [128, 255] },
						{ id: 0, compression: 0, plane: [7, 7] },
						{ id: 1, compression: 0, plane: [8, 8] },
						{ id: 2, compression: 0, plane: [9, 9] },
					],
				}),
				layeredPsdLayer({
					name: "Generated Noise",
					id: 313,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [additionalInfo("GdFl", gradientFillDescriptor({ kind: "noise", style: "Rdl ", align: false, reverse: true, dither: true }))],
					channels: [],
				}),
			],
			4,
			2
		);
		const inspected = inspectPsdLayers(source);
		expect(inspected.layers[0].gradientFill).toMatchObject({
			sourceKey: "GdFl",
			descriptorVersion: 16,
			descriptorClassId: "null",
			descriptorPaddingBytes: 2,
			gradientClassId: "Grdn",
			renderBounds: "layer",
			coverageSource: "transparency-channel",
			executionModel: "bounded-gradient-fill-layer-v1",
			bakeSupported: true,
			gradient: { type: "solid", name: "Red Blue Fill", style: "linear", interpolation: "classic", samples: 4096, bakeSupported: true },
		});
		expect(inspected.layers[1].gradientFill).toMatchObject({
			renderBounds: "document",
			coverageSource: "opaque-generated",
			gradient: {
				type: "noise",
				style: "radial",
				roughness: 0.75,
				randomSeed: 123456,
				minimumRaw: [10, 20, 30, 40],
				maximumRaw: [90, 80, 70, 60],
				bakeSupported: true,
			},
		});
		const decoded = decodePsdLayers(source);
		expect([decoded[0].left, decoded[0].top, decoded[0].width, decoded[0].height, ...decoded[0].pixels]).toEqual([1, 0, 2, 1, 215, 0, 40, 118, 40, 0, 215, 147]);
		expect([decoded[1].left, decoded[1].top, decoded[1].width, decoded[1].height]).toEqual([0, 0, 4, 2]);
		expect([...decoded[1].pixels.slice(0, 16)]).toEqual([144, 128, 136, 133, 113, 123, 126, 124, 112, 123, 125, 124, 145, 129, 137, 133]);
	});

	test("rejects malformed, duplicate, and mixed GdFl generated-fill descriptors", () => {
		const malformedPayloads = [
			gradientFillDescriptor({ version: 15 }),
			gradientFillDescriptor({ padding: [1] }),
			gradientFillDescriptor({ rootClassId: "GdFl" }),
			gradientFillDescriptor({ gradientClassId: "null" }),
			gradientFillDescriptor({ scale: 0 }),
			gradientFillDescriptor({ extraEntries: [{ key: "Type", type: "enum", value: descriptorEnum("GrdT", "Lnr ") }] }),
			gradientFillDescriptor({ extraEntries: [{ key: "Scl ", type: "doub", value: float64(100) }] }),
		];
		for (const [index, payload] of malformedPayloads.entries()) {
			const malformed = layeredPsd(
				[
					layeredPsdLayer({
						name: `Malformed GdFl ${index}`,
						id: 320 + index,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo("GdFl", payload)],
						channels: [],
					}),
				],
				1,
				1
			);
			expect(() => inspectPsdLayers(malformed), `malformed case ${index}`).toThrow(/GdFl/);
		}
		const duplicate = layeredPsd(
			[
				layeredPsdLayer({
					name: "Duplicate GdFl",
					id: 330,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [additionalInfo("GdFl", gradientFillDescriptor()), additionalInfo("GdFl", gradientFillDescriptor())],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(duplicate)).toThrow("more than one GdFl");
		const mixed = layeredPsd(
			[
				layeredPsdLayer({
					name: "Mixed generated fills",
					id: 331,
					top: 0,
					left: 0,
					width: 1,
					height: 1,
					additionalInfo: [
						additionalInfo(
							"SoCo",
							solidColorFillDescriptor("RGBC", [
								{ key: "Rd  ", type: "doub", value: float64(1) },
								{ key: "Grn ", type: "doub", value: float64(2) },
								{ key: "Bl  ", type: "doub", value: float64(3) },
							])
						),
						additionalInfo("GdFl", gradientFillDescriptor()),
					],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(mixed)).toThrow("multiple SoCo/PtFl/GdFl");
	});

	test("parses and executes vscg/vstk vector fill and dashed solid stroke content", () => {
		const fill = solidColorFillDescriptor("RGBC", [
			{ key: "Rd  ", type: "doub", value: float64(220) },
			{ key: "Grn ", type: "doub", value: float64(40) },
			{ key: "Bl  ", type: "doub", value: float64(60) },
		]);
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Vector Stroke Solid",
					id: 332,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [
						additionalInfo("vscg", concat(ascii("SoCo"), fill)),
						additionalInfo("vstk", vectorStrokeDescriptor({ padding: [0] })),
						additionalInfo("vmsk", vectorMaskRectangle(0.25, 0.25, 0.75, 0.75)),
					],
					channels: [],
				}),
			],
			16,
			16
		);
		const inspected = inspectPsdLayers(source).layers[0];
		expect(inspected).toMatchObject({
			kind: "pixel",
			extractionSupported: true,
			vectorFill: {
				sourceKey: "vscg",
				contentKey: "SoCo",
				descriptorVersion: 16,
				executionModel: "bounded-vector-fill-v1",
				bakeSupported: true,
				content: { type: "color", color: { rgba: [220, 40, 60, 255] } },
			},
			vectorStroke: {
				sourceKey: "vstk",
				descriptorVersion: 16,
				descriptorClassId: "strokeStyle",
				descriptorPaddingBytes: 1,
				strokeStyleVersion: 2,
				strokeEnabled: true,
				fillEnabled: true,
				lineWidth: { value: 4, units: "#Pxl", pixels: 4 },
				lineDashOffset: { value: 1, units: "#Pxl", pixels: 1 },
				miterLimit: 10,
				lineCap: "round",
				lineJoin: "bevel",
				lineAlignment: "center",
				scaleLock: true,
				strokeAdjust: true,
				lineDashSet: [
					{ value: 6, units: "#Pxl", pixels: 6 },
					{ value: 2, units: "#Pxl", pixels: 2 },
				],
				blendMode: "mul ",
				opacity: 75,
				content: { type: "color", color: { rgba: [20, 100, 240, 255] } },
				resolution: 72,
				executionModel: "bounded-vector-stroke-v1",
				bakeSupported: true,
			},
		});
		const decoded = decodePsdLayers(source)[0];
		expect([decoded.left, decoded.top, decoded.width, decoded.height]).toEqual([0, 0, 16, 16]);
		const pixel = (x: number, y: number): number[] => [...decoded.pixels.slice((y * 16 + x) * 4, (y * 16 + x + 1) * 4)];
		expect(pixel(8, 8)).toEqual([220, 40, 60, 255]);
		expect(pixel(0, 0)).toEqual([220, 40, 60, 0]);
		expect(decoded.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
	});

	test("executes open vector paths with point-unit gradient strokes and no fill coverage", () => {
		const gradient = gradientFillDescriptor({ style: "Lnr ", scale: 100 });
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Open Gradient Stroke",
					id: 333,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [
						additionalInfo("vscg", concat(ascii("GdFl"), gradient)),
						additionalInfo(
							"vstk",
							vectorStrokeDescriptor({
								lineWidth: { units: "#Pnt", value: 6 },
								dashOffset: { units: "#Pnt", value: 0 },
								dashes: [],
								cap: "strokeStyleSquareCap",
								join: "strokeStyleMiterJoin",
								alignment: "strokeStyleAlignCenter",
								blendMode: "Scrn",
								opacity: 60,
								content: gradient.slice(4),
								resolution: 144,
							})
						),
						additionalInfo(
							"vmsk",
							vectorMaskPath(
								[
									[0.125, 0.5],
									[0.5, 0.125],
									[0.875, 0.5],
								],
								true
							)
						),
					],
					channels: [],
				}),
			],
			40,
			30
		);
		const inspected = inspectPsdLayers(source).layers[0];
		expect(inspected.vectorMask).toMatchObject({ bakeSupported: false, subpaths: [{ closed: false }] });
		expect(inspected.vectorStroke).toMatchObject({
			lineWidth: { value: 6, units: "#Pnt", pixels: 12 },
			lineCap: "square",
			lineJoin: "miter",
			lineAlignment: "center",
			blendMode: "scrn",
			opacity: 60,
			content: { type: "gradient", gradient: { type: "solid", bakeSupported: true } },
			bakeSupported: true,
		});
		const decoded = decodePsdLayers(source)[0];
		const alpha = (x: number, y: number): number => decoded.pixels[(y * decoded.width + x) * 4 + 3];
		expect(alpha(20, 4)).toBeGreaterThan(0);
		expect(alpha(20, 25)).toBe(0);
	});

	test("keeps standalone vector-stroke raster channels at their authored document offset", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Offset Raster Stroke",
					id: 336,
					top: 5,
					left: 5,
					width: 2,
					height: 1,
					additionalInfo: [
						additionalInfo("vstk", vectorStrokeDescriptor({ fillEnabled: false, lineWidth: { units: "#Pxl", value: 1 }, dashes: [], blendMode: "Nrml", opacity: 100 })),
						additionalInfo("vmsk", vectorMaskRectangle(0, 0, 0.25, 0.25)),
					],
					channels: [
						{ id: 0, compression: 0, plane: [10, 20] },
						{ id: 1, compression: 0, plane: [30, 40] },
						{ id: 2, compression: 0, plane: [50, 60] },
					],
				}),
			],
			8,
			8
		);
		const decoded = decodePsdLayers(source)[0];
		const pixel = (x: number, y: number): number[] => [...decoded.pixels.slice((y * decoded.width + x) * 4, (y * decoded.width + x + 1) * 4)];
		expect([decoded.left, decoded.top, decoded.width, decoded.height]).toEqual([0, 0, 8, 8]);
		expect(pixel(5, 5)).toEqual([10, 30, 50, 255]);
		expect(pixel(6, 5)).toEqual([20, 40, 60, 255]);
		expect(pixel(5, 0)).toEqual([0, 0, 0, 0]);
		expect(decoded.pixels.some((value, index) => index % 4 === 3 && value > 0 && Math.floor(index / 4 / decoded.width) < 3)).toBe(true);
	});

	test("resolves and executes embedded-pattern vscg fills and vstk stroke content", () => {
		const pattern = patternFillDescriptor({ scale: 100, angle: 0, align: true, linked: true, phase: [0, 0] });
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Vector Pattern Stroke",
					id: 335,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [
						additionalInfo("vscg", concat(ascii("PtFl"), pattern)),
						additionalInfo("vstk", vectorStrokeDescriptor({ content: pattern.slice(4), dashes: [], blendMode: "Nrml", opacity: 100 })),
						additionalInfo("vmsk", vectorMaskRectangle(0.25, 0.25, 0.75, 0.75)),
					],
					channels: [],
				}),
			],
			8,
			8,
			0,
			patternTaggedBlock()
		);
		const inspected = inspectPsdLayers(source).layers[0];
		expect(inspected.vectorFill).toMatchObject({
			contentKey: "PtFl",
			bakeSupported: true,
			content: { type: "pattern", pattern: { id: "tile-2x2", resolutionStatus: "resolved", resolvedPatternIndex: 0, bakeSupported: true } },
		});
		expect(inspected.vectorStroke).toMatchObject({
			content: { type: "pattern", pattern: { id: "tile-2x2", resolutionStatus: "resolved", resolvedPatternIndex: 0, bakeSupported: true } },
			bakeSupported: true,
		});
		const decoded = decodePsdLayers(source)[0];
		expect(decoded.width).toBe(8);
		expect(decoded.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
	});

	test("rejects malformed, duplicate, orphaned, and mixed vscg/vstk records", () => {
		const fill = solidColorFillDescriptor("RGBC", [
			{ key: "Rd  ", type: "doub", value: float64(1) },
			{ key: "Grn ", type: "doub", value: float64(2) },
			{ key: "Bl  ", type: "doub", value: float64(3) },
		]);
		const make = (additional: Uint8Array[]): Uint8Array =>
			layeredPsd([layeredPsdLayer({ name: "Malformed Vector Stroke", id: 334, top: 0, left: 0, width: 0, height: 0, additionalInfo: additional, channels: [] })], 8, 8);
		expect(() => inspectPsdLayers(make([additionalInfo("vscg", concat(ascii("SoCo"), fill)), additionalInfo("vmsk", vectorMaskRectangle(0, 0, 1, 1))]))).toThrow(
			"without its required vstk"
		);
		expect(() => inspectPsdLayers(make([additionalInfo("vstk", vectorStrokeDescriptor()), additionalInfo("vmsk", vectorMaskRectangle(0, 0, 1, 1))]))).not.toThrow();
		expect(() => inspectPsdLayers(make([additionalInfo("vstk", vectorStrokeDescriptor())]))).toThrow("without a vmsk/vsms");
		expect(() =>
			inspectPsdLayers(
				make([
					additionalInfo("vscg", concat(ascii("SoCo"), fill)),
					additionalInfo("vscg", concat(ascii("SoCo"), fill)),
					additionalInfo("vstk", vectorStrokeDescriptor()),
					additionalInfo("vmsk", vectorMaskRectangle(0, 0, 1, 1)),
				])
			)
		).toThrow("more than one vscg");
		expect(() =>
			inspectPsdLayers(
				make([
					additionalInfo("vscg", concat(ascii("SoCo"), fill)),
					additionalInfo("vstk", vectorStrokeDescriptor()),
					additionalInfo("vstk", vectorStrokeDescriptor()),
					additionalInfo("vmsk", vectorMaskRectangle(0, 0, 1, 1)),
				])
			)
		).toThrow("more than one vstk");
		expect(() =>
			inspectPsdLayers(
				make([
					additionalInfo("SoCo", fill),
					additionalInfo("vscg", concat(ascii("SoCo"), fill)),
					additionalInfo("vstk", vectorStrokeDescriptor()),
					additionalInfo("vmsk", vectorMaskRectangle(0, 0, 1, 1)),
				])
			)
		).toThrow("combines vscg");
		expect(() =>
			inspectPsdLayers(
				make([
					additionalInfo("vscg", concat(ascii("XXXX"), fill)),
					additionalInfo("vstk", vectorStrokeDescriptor()),
					additionalInfo("vmsk", vectorMaskRectangle(0, 0, 1, 1)),
				])
			)
		).toThrow(/vscg content key/);
		for (const payload of [
			vectorStrokeDescriptor({ version: 15 }),
			vectorStrokeDescriptor({ classId: "null" }),
			vectorStrokeDescriptor({ strokeStyleVersion: 1 }),
			vectorStrokeDescriptor({ opacity: 101 }),
			vectorStrokeDescriptor({ padding: [1] }),
			vectorStrokeDescriptor({ extraEntries: [{ key: "strokeEnabled", type: "bool", value: new Uint8Array([1]) }] }),
		]) {
			expect(() =>
				inspectPsdLayers(
					make([additionalInfo("vscg", concat(ascii("SoCo"), fill)), additionalInfo("vstk", payload), additionalInfo("vmsk", vectorMaskRectangle(0, 0, 1, 1))])
				)
			).toThrow(/vstk/);
		}
	});

	test("preserves exact vogk Vector Origination geometry and associates it with the vector path", () => {
		const fill = solidColorFillDescriptor("RGBC", [
			{ key: "Rd  ", type: "doub", value: float64(220) },
			{ key: "Grn ", type: "doub", value: float64(40) },
			{ key: "Bl  ", type: "doub", value: float64(60) },
		]);
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Vector Origination",
					id: 337,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [
						additionalInfo("vscg", concat(ascii("SoCo"), fill)),
						additionalInfo("vstk", vectorStrokeDescriptor({ dashes: [] })),
						additionalInfo("vmsk", vectorMaskRectangle(0.25, 0.25, 0.75, 0.75)),
						additionalInfo(
							"vogk",
							vectorOriginationDescriptor({
								padding: [0, 0],
								extraRootEntries: [{ key: "futureRoot", type: "long", value: int32(7) }],
								extraItemEntries: [{ key: "futureShape", type: "TEXT", value: descriptorUnicode("kept") }],
							})
						),
					],
					channels: [],
				}),
			],
			16,
			16
		);
		const inspected = inspectPsdLayers(source).layers[0];
		expect(inspected.vectorOrigination).toMatchObject({
			sourceKey: "vogk",
			recordVersion: 1,
			descriptorVersion: 16,
			descriptorClassId: "null",
			descriptorEntryKeys: ["keyDescriptorList", "futureRoot"],
			descriptorEntryTypes: ["VlLs", "long"],
			descriptorPaddingBytes: 2,
			association: "vector-mask",
			executionModel: "psd-vector-origination-v1",
			entries: [
				{
					listIndex: 0,
					originIndex: 0,
					shapeInvalidated: false,
					originType: 1,
					originResolution: 144,
					unknownEntryKeys: ["futureShape"],
					shapeBoundingBox: {
						unitValueQuadVersion: 1,
						top: { value: 2, units: "#Pnt", pixels: 4 },
						left: { value: 3, units: "#Pxl", pixels: 3 },
						bottom: { value: 12, units: null, pixels: 12 },
						right: { value: 13, units: "#Pxl", pixels: 13 },
					},
					roundedRectangleRadii: {
						topRight: { value: 1, units: "#Pxl", pixels: 1 },
						topLeft: { value: 2, units: "#Pxl", pixels: 2 },
						bottomLeft: { value: 3, units: "#Pxl", pixels: 3 },
						bottomRight: { value: 4, units: "#Pxl", pixels: 4 },
					},
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
		});
		expect(inspected.warnings).toContain("Vector Origination preserves unknown root descriptor key(s): futureRoot.");
		expect(inspected.warnings).toContain("Vector Origination item 0 preserves unknown descriptor key(s): futureShape.");
		const decoded = decodePsdLayers(source)[0];
		expect([...decoded.pixels.slice((8 * 16 + 8) * 4, (8 * 16 + 9) * 4)]).toEqual([220, 40, 60, 255]);
	});

	test("rejects malformed and duplicate vogk Vector Origination records", () => {
		const make = (additional: Uint8Array[]): Uint8Array =>
			layeredPsd([layeredPsdLayer({ name: "Malformed Vector Origination", id: 338, top: 0, left: 0, width: 0, height: 0, additionalInfo: additional, channels: [] })], 8, 8);
		expect(inspectPsdLayers(make([additionalInfo("vogk", vectorOriginationDescriptor())])).layers[0].vectorOrigination).toMatchObject({ association: "metadata-only" });
		for (const payload of [
			vectorOriginationDescriptor({ recordVersion: 2 }),
			vectorOriginationDescriptor({ descriptorVersion: 15 }),
			vectorOriginationDescriptor({ rootClassId: "bad!" }),
			vectorOriginationDescriptor({ originResolution: 0 }),
			vectorOriginationDescriptor({ quadVersion: 2 }),
			vectorOriginationDescriptor({ padding: [1] }),
			vectorOriginationDescriptor({ extraItemEntries: [{ key: "keyOriginIndex", type: "long", value: int32(1) }] }),
			vectorOriginationDescriptor({ secondOriginIndex: 0 }),
		]) {
			expect(() => inspectPsdLayers(make([additionalInfo("vogk", payload)]))).toThrow(/vogk/);
		}
		expect(() => inspectPsdLayers(make([additionalInfo("vogk", vectorOriginationDescriptor()), additionalInfo("vogk", vectorOriginationDescriptor())]))).toThrow(
			"more than one vogk"
		);
	});

	test("preserves exact vowv Vector Rendering Version values and rejects malformed records", () => {
		const make = (additional: Uint8Array[]): Uint8Array =>
			layeredPsd([layeredPsdLayer({ name: "Vector Rendering Version", id: 339, top: 0, left: 0, width: 0, height: 0, additionalInfo: additional, channels: [] })], 8, 8);
		const observed = inspectPsdLayers(make([additionalInfo("vowv", uint32(2))])).layers[0];
		expect(observed.vectorRenderingVersion).toEqual({
			sourceKey: "vowv",
			value: 2,
			observedPhotoshopValue: true,
			executionModel: "psd-vector-rendering-version-v1",
		});
		expect(observed.warnings).toContain("Vector Rendering Version preserves observed Photoshop vowv value 2 through psd-vector-rendering-version-v1.");
		const future = inspectPsdLayers(make([additionalInfo("vowv", uint32(0xffffffff))])).layers[0];
		expect(future.vectorRenderingVersion).toMatchObject({ value: 0xffffffff, observedPhotoshopValue: false });
		expect(future.warnings).toContain(
			"Vector Rendering Version preserves unrecognized vowv value 4294967295; the value is retained exactly without assigning guessed semantics."
		);
		expect(() => inspectPsdLayers(make([additionalInfo("vowv", new Uint8Array([0, 0, 2]))]))).toThrow(/vowv/);
		expect(() => inspectPsdLayers(make([additionalInfo("vowv", uint32(2)), additionalInfo("vowv", uint32(2))]))).toThrow("more than one vowv");
	});

	test("preserves exact pths Photoshop Path List descriptors and rejects malformed records", () => {
		const make = (additional: Uint8Array[]): Uint8Array =>
			layeredPsd([layeredPsdLayer({ name: "Path List", id: 340, top: 0, left: 0, width: 0, height: 0, additionalInfo: additional, channels: [] })], 8, 8);
		const inspected = inspectPsdLayers(
			make([
				additionalInfo(
					"pths",
					pathListDescriptor({
						padding: [0, 0],
						extraRootEntries: [{ key: "futureRoot", type: "long", value: int32(7) }],
						extraPathEntries: [{ key: "futurePath", type: "TEXT", value: descriptorUnicode("kept") }],
						extraSymmetryEntries: [{ key: "futureSymmetry", type: "bool", value: new Uint8Array([1]) }],
					})
				),
			])
		).layers[0];
		expect(inspected.pathList).toMatchObject({
			sourceKey: "pths",
			descriptorVersion: 16,
			descriptorClassId: "pathsDataClass",
			descriptorEntryKeys: ["pathList", "futureRoot"],
			descriptorEntryTypes: ["VlLs", "long"],
			descriptorPaddingBytes: 2,
			unknownEntryKeys: ["futureRoot"],
			executionModel: "psd-path-list-v1",
			paths: [
				{
					listIndex: 0,
					descriptorClassId: "pathInfoClass",
					unicodeName: "Work Path",
					unknownEntryKeys: ["futurePath"],
					symmetry: {
						descriptorClassId: "pathSymmetryClass",
						modeType: "enum",
						enumType: "pathSymmetryModeEnum",
						value: "pathSymmetryModeBasicPath",
						unknownEntryKeys: ["futureSymmetry"],
					},
				},
			],
		});
		expect(inspected.warnings).toContain("Path List preserves unknown root descriptor key(s): futureRoot.");
		expect(inspectPsdLayers(make([additionalInfo("pths", pathListDescriptor({ empty: true }))])).layers[0].pathList?.paths).toEqual([]);
		for (const payload of [
			pathListDescriptor({ version: 15 }),
			pathListDescriptor({ rootClassId: "bad!" }),
			pathListDescriptor({ pathClassId: "bad!" }),
			pathListDescriptor({ symmetryClassId: "bad!" }),
			pathListDescriptor({ padding: [1] }),
			pathListDescriptor({ extraRootEntries: [{ key: "pathList", type: "VlLs", value: descriptorList() }] }),
		]) {
			expect(() => inspectPsdLayers(make([additionalInfo("pths", payload)]))).toThrow(/pths/);
		}
		expect(() => inspectPsdLayers(make([additionalInfo("pths", pathListDescriptor()), additionalInfo("pths", pathListDescriptor())]))).toThrow("more than one pths");
	});

	test("decodes and multiplies a bounded real-user mask with its independent extended-record bounds", () => {
		const layer = layeredPsdLayer({
			name: "Primary Plus Real User Mask",
			id: 47,
			top: 4,
			left: 7,
			width: 3,
			height: 1,
			mask: {
				top: 4,
				left: 7,
				width: 3,
				height: 1,
				defaultColor: 255,
				realUserMask: { top: 4, left: 8, width: 1, height: 1, defaultColor: 255 },
			},
			channels: [
				{ id: 0, compression: 0, plane: [10, 20, 30] },
				{ id: 1, compression: 0, plane: [40, 50, 60] },
				{ id: 2, compression: 0, plane: [70, 80, 90] },
				{ id: -1, compression: 0, plane: [200, 200, 200] },
				{ id: -2, compression: 2, plane: [255, 128, 255], width: 3, height: 1 },
				{ id: -3, compression: 3, plane: [64], width: 1, height: 1 },
			],
		});
		const source = layeredPsd([layer], 12, 8);
		const info = inspectPsdLayers(source).layers[0];
		expect(info.mask).toMatchObject({
			width: 3,
			height: 1,
			userDensity: null,
			userFeather: null,
			vectorDensity: null,
			vectorFeather: null,
			realUserMask: { channelId: -3, top: 4, left: 8, width: 1, height: 1, defaultColor: 255, disabled: false, inverted: false },
		});
		expect(info.channels.find((channel) => channel.id === -3)).toMatchObject({ compression: "zipPrediction", width: 1, height: 1 });
		expect(info.warnings).toEqual([]);
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([10, 40, 70, 200, 20, 50, 80, 25, 30, 60, 90, 200]);
	});

	test("executes bounded primary-mask density and feather parameters", () => {
		const layer = layeredPsdLayer({
			name: "Feathered Primary Mask",
			id: 48,
			top: 0,
			left: 0,
			width: 4,
			height: 1,
			mask: { top: 0, left: 0, width: 4, height: 1, userDensity: 128, userFeather: 1 },
			channels: [
				{ id: 0, compression: 0, plane: [10, 20, 30, 40] },
				{ id: 1, compression: 0, plane: [50, 60, 70, 80] },
				{ id: 2, compression: 0, plane: [90, 100, 110, 120] },
				{ id: -1, compression: 0, plane: [200, 200, 200, 200] },
				{ id: -2, compression: 0, plane: [0, 255, 255, 0], width: 4, height: 1 },
			],
		});
		const source = layeredPsd([layer], 4, 1);
		const info = inspectPsdLayers(source).layers[0];
		expect(info.mask).toMatchObject({ userDensity: 128, userFeather: 1 });
		expect(info.warnings).toEqual([]);
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([10, 50, 90, 133, 20, 60, 100, 166, 30, 70, 110, 166, 40, 80, 120, 133]);
	});

	test("parses and rasterizes a bounded closed vector mask with vector density and feather", () => {
		const layer = layeredPsdLayer({
			name: "Feathered Vector Mask",
			id: 49,
			top: 0,
			left: 0,
			width: 4,
			height: 1,
			mask: { top: 0, left: 0, width: 4, height: 1, vectorDensity: 128, vectorFeather: 1 },
			additionalInfo: [additionalInfo("vmsk", vectorMaskRectangle(0.25, 0, 0.75, 1))],
			channels: [
				{ id: 0, compression: 0, plane: [10, 20, 30, 40] },
				{ id: 1, compression: 0, plane: [50, 60, 70, 80] },
				{ id: 2, compression: 0, plane: [90, 100, 110, 120] },
				{ id: -1, compression: 0, plane: [200, 200, 200, 200] },
				{ id: -2, compression: 0, plane: [255, 255, 255, 255], width: 4, height: 1 },
			],
		});
		const source = layeredPsd([layer], 4, 1);
		const info = inspectPsdLayers(source).layers[0];
		expect(info.vectorMask).toMatchObject({
			sourceKey: "vmsk",
			version: 3,
			initialFill: 0,
			fillRule: "evenOdd",
			knotCount: 4,
			executionModel: "bounded-vector-mask-v1",
			bakeSupported: true,
			subpaths: [{ closed: true, knots: expect.arrayContaining([expect.objectContaining({ linked: true, anchor: { x: 0.25, y: 0 } })]) }],
		});
		expect(info.mask).toMatchObject({ vectorDensity: 128, vectorFeather: 1 });
		expect(info.warnings).toEqual([]);
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([10, 50, 90, 133, 20, 60, 100, 166, 30, 70, 110, 166, 40, 80, 120, 133]);
	});

	test("parses bounded core, Curves, Exposure, and Vibrance PSD adjustment-layer tagged blocks", () => {
		const adjustmentLayer = (name: string, id: number, key: string, data: Uint8Array) =>
			layeredPsdLayer({ name, id, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo(key, data)], channels: [] });
		const source = layeredPsd(
			[
				adjustmentLayer("Brightness", 51, "brit", concat(int16(10), int16(20), int16(127), new Uint8Array([0]))),
				adjustmentLayer(
					"Curves",
					56,
					"curv",
					curvesAdjustmentV4([
						[
							[0, 255],
							[255, 0],
						],
					])
				),
				adjustmentLayer("Exposure", 58, "expA", concat(uint16(1), float32(1.25), float32(-0.125), float32(2))),
				adjustmentLayer("Vibrance", 60, "vibA", concat(vibranceAdjustment(35, -12), new Uint8Array(2))),
				adjustmentLayer("Hue Saturation", 61, "hue2", hueSaturationAdjustment({ master: [30, 25, -10] })),
				adjustmentLayer("Levels", 52, "levl", levelsAdjustment(levelsRecord(10, 200, 20, 240, 120))),
				adjustmentLayer("Invert", 53, "nvrt", new Uint8Array()),
				adjustmentLayer("Posterize", 54, "post", uint16(4)),
				adjustmentLayer("Threshold", 55, "thrs", uint16(128)),
			],
			1,
			1
		);
		const layers = inspectPsdLayers(source).layers;
		expect(layers.map((layer) => layer.kind)).toEqual([
			"adjustment",
			"adjustment",
			"adjustment",
			"adjustment",
			"adjustment",
			"adjustment",
			"adjustment",
			"adjustment",
			"adjustment",
		]);
		expect(layers.map((layer) => layer.adjustment)).toMatchObject([
			{ key: "brit", brightness: 10, contrast: 20, mean: 127, labOnly: false, executionModel: "bounded-adjustment-v1", bakeSupported: true },
			{
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
			{ key: "expA", version: 1, exposure: 1.25, offset: -0.125, gamma: 2, colorModel: "linear-srgb-v1", executionModel: "bounded-adjustment-v1", bakeSupported: true },
			{
				key: "vibA",
				descriptorVersion: 16,
				paddingBytes: 2,
				vibrance: 35,
				saturation: -12,
				colorModel: "bounded-hsl-vibrance-v1",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			},
			{
				key: "hue2",
				version: 2,
				sourceModel: "photoshop-5+",
				hueUnitScale: 1,
				colorize: false,
				paddingByte: 0,
				colorization: { hue: 0, saturation: 0, lightness: 0 },
				master: { hue: 30, saturation: 25, lightness: -10 },
				localAdjustmentsPresent: false,
				localRangeModel: "normalized-hextant-feather-v1",
				colorModel: "bounded-hsl-hue-v2",
				bakeSupported: true,
			},
			{ key: "levl", version: 2, master: { inputFloor: 10, inputCeiling: 200, outputFloor: 20, outputCeiling: 240, gamma: 120 } },
			{ key: "nvrt", executionModel: "bounded-adjustment-v1", bakeSupported: true },
			{ key: "post", levels: 4, executionModel: "bounded-adjustment-v1", bakeSupported: true },
			{ key: "thrs", threshold: 128, executionModel: "bounded-adjustment-v1", bakeSupported: true },
		]);
		expect(layers.every((layer) => !layer.extractionSupported && layer.warnings.some((warning) => warning.includes("applied only while composing")))).toBe(true);
	});

	test("parses version-1 Curves bitmaps and exact Crv channel overrides", () => {
		const data = concat(
			uint16(1),
			uint16(1),
			curve([
				[0, 0],
				[255, 255],
			]),
			ascii("Crv "),
			uint16(4),
			uint32(1),
			uint16(1),
			curve([
				[0, 20],
				[255, 240],
			])
		);
		const source = layeredPsd(
			[layeredPsdLayer({ name: "Curves v1", id: 57, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("curv", data)], channels: [] })],
			1,
			1
		);
		expect(inspectPsdLayers(source).layers[0].adjustment).toMatchObject({
			key: "curv",
			version: 1,
			curves: [
				{
					channel: 0,
					points: [
						{ input: 0, output: 0 },
						{ input: 255, output: 255 },
					],
				},
				{
					channel: 1,
					points: [
						{ input: 0, output: 20 },
						{ input: 255, output: 240 },
					],
				},
			],
		});
	});

	test("rejects malformed Exposure versions, lengths, and gamma values", () => {
		const exposureSource = (data: Uint8Array) =>
			layeredPsd([layeredPsdLayer({ name: "Exposure", id: 59, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("expA", data)], channels: [] })], 1, 1);
		expect(() => inspectPsdLayers(exposureSource(concat(uint16(2), float32(0), float32(0), float32(1))))).toThrow("version 2");
		expect(() => inspectPsdLayers(exposureSource(concat(uint16(1), float32(0), float32(0))))).toThrow("14 bytes");
		expect(() => inspectPsdLayers(exposureSource(concat(uint16(1), float32(0), float32(0), float32(0))))).toThrow("gamma");
	});

	test("rejects malformed Vibrance descriptors and bounded values", () => {
		const vibranceSource = (data: Uint8Array) =>
			layeredPsd([layeredPsdLayer({ name: "Vibrance", id: 60, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("vibA", data)], channels: [] })], 1, 1);
		expect(() => inspectPsdLayers(vibranceSource(vibranceAdjustment(0, 0, 15)))).toThrow("version 15");
		expect(() => inspectPsdLayers(vibranceSource(vibranceAdjustment(101, 0)))).toThrow("integer from -100 to 100");
		expect(() => inspectPsdLayers(vibranceSource(concat(vibranceAdjustment(0, 0), new Uint8Array([1]))))).toThrow("trailing descriptor byte");
	});

	test("rejects malformed Hue/Saturation records and parses modern local plus legacy records", () => {
		const hueSource = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Hue Saturation", id: 61, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("hue2", data)], channels: [] })],
				1,
				1
			);
		expect(() => inspectPsdLayers(hueSource(hueSaturationAdjustment({ version: 1 })))).toThrow("version 1");
		expect(() => inspectPsdLayers(hueSource(hueSaturationAdjustment().subarray(0, 98)))).toThrow("exactly 100 bytes");
		const invalidFlag = hueSaturationAdjustment();
		invalidFlag[2] = 2;
		expect(() => inspectPsdLayers(hueSource(invalidFlag))).toThrow("flag must be 0 or 1");
		const local = inspectPsdLayers(
			hueSource(hueSaturationAdjustment({ channels: [hueSaturationChannel([0, 0, 0, 0], 10), ...Array.from({ length: 5 }, () => hueSaturationChannel())] }))
		).layers[0].adjustment;
		expect(local).toMatchObject({ key: "hue2", localAdjustmentsPresent: true, localRangeModel: "normalized-hextant-feather-v1", bakeSupported: true });
		expect(local?.key === "hue2" ? local.channels[0] : null).toMatchObject({ name: "reds", hue: 10 });
		const legacy = inspectPsdLayers(
			layeredPsd(
				[
					layeredPsdLayer({
						name: "Legacy Hue",
						id: 62,
						top: 0,
						left: 0,
						width: 0,
						height: 0,
						additionalInfo: [additionalInfo("hue ", hueSaturationAdjustment({ master: [100, 0, 0] }))],
						channels: [],
					}),
				],
				1,
				1
			)
		).layers[0].adjustment;
		expect(legacy).toMatchObject({ key: "hue ", sourceModel: "photoshop-4", hueUnitScale: 1.8, master: { hue: 100 }, bakeSupported: true });
	});

	test("parses strict Color Balance tone records and bounded execution evidence", () => {
		const source = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Color Balance", id: 63, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("blnc", data)], channels: [] })],
				1,
				1
			);
		const adjustment = inspectPsdLayers(
			source(
				colorBalanceAdjustment({
					shadows: colorBalanceTone(-20, 10, 5),
					midtones: colorBalanceTone(20, -10, 30),
					highlights: colorBalanceTone(5, 15, -25),
					preserveLuminosity: 1,
				})
			)
		).layers[0].adjustment;
		expect(adjustment).toEqual({
			key: "blnc",
			shadows: { cyanRed: -20, magentaGreen: 10, yellowBlue: 5 },
			midtones: { cyanRed: 20, magentaGreen: -10, yellowBlue: 30 },
			highlights: { cyanRed: 5, magentaGreen: 15, yellowBlue: -25 },
			preserveLuminosity: true,
			paddingByte: 0,
			tonalModel: "piecewise-luminance-tones-v1",
			colorModel: "bounded-rgb-color-balance-v1",
			executionModel: "bounded-adjustment-v1",
			bakeSupported: true,
		});
		expect(() => inspectPsdLayers(source(colorBalanceAdjustment().subarray(0, 19)))).toThrow("exactly 20 bytes");
		expect(() => inspectPsdLayers(source(colorBalanceAdjustment({ midtones: colorBalanceTone(101, 0, 0) })))).toThrow("within -100..100");
		expect(() => inspectPsdLayers(source(colorBalanceAdjustment({ preserveLuminosity: 2 })))).toThrow("flag must be 0 or 1");
		expect(() => inspectPsdLayers(source(colorBalanceAdjustment({ paddingByte: 1 })))).toThrow("padding byte must be zero");
	});

	test("parses strict Black & White descriptor mixes and tint evidence", () => {
		const source = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Black White", id: 64, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("blwh", data)], channels: [] })],
				1,
				1
			);
		expect(inspectPsdLayers(source(blackWhiteAdjustment({ useTint: true }))).layers[0].adjustment).toEqual({
			key: "blwh",
			descriptorVersion: 16,
			paddingBytes: 0,
			reds: 40,
			yellows: 60,
			greens: 40,
			cyans: 60,
			blues: 20,
			magentas: 80,
			useTint: true,
			tintColor: { space: 0, components: [30840, 20560, 10280, 0], rgba: [120, 80, 40, 255] },
			presetKind: 1,
			presetFileName: "Custom",
			colorModel: "bounded-hue-mix-black-white-v1",
			executionModel: "bounded-adjustment-v1",
			bakeSupported: true,
		});
		expect(() => inspectPsdLayers(source(blackWhiteAdjustment({ descriptorVersion: 15 })))).toThrow("version 15");
		expect(() => inspectPsdLayers(source(blackWhiteAdjustment({ red: 301 })))).toThrow("integer from -200 to 300");
	});

	test("parses strict Channel Mixer RGB and monochrome records", () => {
		const source = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Channel Mixer", id: 65, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("mixr", data)], channels: [] })],
				1,
				1
			);
		expect(inspectPsdLayers(source(channelMixerAdjustment())).layers[0].adjustment).toEqual({
			key: "mixr",
			version: 1,
			monochrome: false,
			red: { red: 100, green: 0, blue: 0, constant: 0, reservedWord: 0, total: 100 },
			green: { red: 0, green: 100, blue: 0, constant: 0, reservedWord: 0, total: 100 },
			blue: { red: 0, green: 0, blue: 100, constant: 0, reservedWord: 0, total: 100 },
			gray: { red: 40, green: 40, blue: 20, constant: 0, reservedWord: 0, total: 100 },
			monochromePaddingBytes: 0,
			colorModel: "bounded-linear-channel-mixer-v1",
			executionModel: "bounded-adjustment-v1",
			bakeSupported: true,
		});
		expect(inspectPsdLayers(source(channelMixerAdjustment({ monochromeFlag: 1 }))).layers[0].adjustment).toMatchObject({
			key: "mixr",
			monochrome: true,
			red: null,
			green: null,
			blue: null,
			gray: { red: 40, green: 40, blue: 20, constant: 0, total: 100 },
			monochromePaddingBytes: 30,
		});
		expect(() => inspectPsdLayers(source(channelMixerAdjustment().subarray(0, 43)))).toThrow("exactly 44 bytes");
		expect(() => inspectPsdLayers(source(channelMixerAdjustment({ version: 2 })))).toThrow("version 2");
		expect(() => inspectPsdLayers(source(channelMixerAdjustment({ monochromeFlag: 2 })))).toThrow("flag must be 0 or 1");
		expect(() => inspectPsdLayers(source(channelMixerAdjustment({ red: channelMixerChannel(201, 0, 0) })))).toThrow("within -200..200");
		expect(() => inspectPsdLayers(source(channelMixerAdjustment({ red: channelMixerChannel(100, 0, 0, 0, 1) })))).toThrow("reserved word must be zero");
		const padding = new Uint8Array(30);
		padding[29] = 1;
		expect(() => inspectPsdLayers(source(channelMixerAdjustment({ monochromeFlag: 1, monochromePadding: padding })))).toThrow("padding must be zero");
	});

	test("parses strict Selective Color mode and nine CMYK ranges", () => {
		const source = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Selective Color", id: 66, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("selc", data)], channels: [] })],
				1,
				1
			);
		const zero = { cyan: 0, magenta: 0, yellow: 0, black: 0 };
		expect(
			inspectPsdLayers(source(selectiveColorAdjustment({ modeWord: 1, reds: selectiveColorRange(25, -10, 5, 20), neutrals: selectiveColorRange(-5, 10, 15, -20) }))).layers[0]
				.adjustment
		).toEqual({
			key: "selc",
			version: 1,
			mode: "absolute",
			reservedBytes: 8,
			reds: { cyan: 25, magenta: -10, yellow: 5, black: 20 },
			yellows: zero,
			greens: zero,
			cyans: zero,
			blues: zero,
			magentas: zero,
			whites: zero,
			neutrals: { cyan: -5, magenta: 10, yellow: 15, black: -20 },
			blacks: zero,
			rangeModel: "bounded-extrema-range-weights-v1",
			colorModel: "bounded-cmyk-selective-color-v1",
			executionModel: "bounded-adjustment-v1",
			bakeSupported: true,
		});
		expect(() => inspectPsdLayers(source(selectiveColorAdjustment().subarray(0, 83)))).toThrow("exactly 84 bytes");
		expect(() => inspectPsdLayers(source(selectiveColorAdjustment({ version: 2 })))).toThrow("version 2");
		expect(() => inspectPsdLayers(source(selectiveColorAdjustment({ modeWord: 2 })))).toThrow("relative (0) or absolute (1)");
		const reserved = new Uint8Array(8);
		reserved[7] = 1;
		expect(() => inspectPsdLayers(source(selectiveColorAdjustment({ reserved })))).toThrow("reserved bytes must be zero");
		expect(() => inspectPsdLayers(source(selectiveColorAdjustment({ reds: selectiveColorRange(101) })))).toThrow("within -100..100");
	});

	test("parses strict solid and noise Gradient Map records", () => {
		const source = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Gradient Map", id: 67, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("grdm", data)], channels: [] })],
				1,
				1
			);
		expect(inspectPsdLayers(source(gradientMapAdjustment())).layers[0].adjustment).toMatchObject({
			key: "grdm",
			version: 1,
			name: "Red Map",
			gradientType: "solid",
			reverse: false,
			dither: false,
			method: "classic",
			smoothnessRaw: 4096,
			colorStops: [
				{ rawLocation: 0, location: 0, midpoint: 0.5, color: { rgba: [0, 0, 0, 255] } },
				{ rawLocation: 4096, location: 1, midpoint: 0.5, color: { rgba: [255, 0, 0, 255] } },
			],
			opacityStops: [
				{ rawLocation: 0, location: 0, midpoint: 0.5, opacity: 1 },
				{ rawLocation: 4096, location: 1, midpoint: 0.5, opacity: 1 },
			],
			gradientModel: "bounded-gradient-map-v1",
			noiseModel: "bounded-seeded-multioctave-v1",
			bakeSupported: true,
		});
		expect(inspectPsdLayers(source(gradientMapAdjustment({ version: 3, type: 1, method: "Smoo" }))).layers[0].adjustment).toMatchObject({
			key: "grdm",
			version: 3,
			gradientType: "noise",
			method: "smooth",
			randomSeed: 12345,
			roughnessRaw: 2048,
			colorModel: "rgb",
		});
		expect(() => inspectPsdLayers(source(gradientMapAdjustment({ version: 2 })))).toThrow("version 2");
		expect(() => inspectPsdLayers(source(gradientMapAdjustment({ version: 3, method: "Nope" })))).toThrow("interpolation method");
		expect(() => inspectPsdLayers(source(gradientMapAdjustment({ expansionCount: 3 })))).toThrow("expansion count must be 2");
		const reserved = new Uint8Array(4);
		reserved[3] = 1;
		expect(() => inspectPsdLayers(source(gradientMapAdjustment({ reserved })))).toThrow("four zero reserved bytes");
	});

	test("parses strict Photo Filter v2 color and v3 Lab records", () => {
		const source = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Photo Filter", id: 68, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("phfl", data)], channels: [] })],
				1,
				1
			);
		expect(inspectPsdLayers(source(photoFilterAdjustment())).layers[0].adjustment).toEqual({
			key: "phfl",
			version: 2,
			color: { space: 0, components: [65535, 32896, 0, 0], rgba: [255, 128, 0, 255] },
			labColor: null,
			density: 25,
			densityRaw: 2500,
			preserveLuminosity: false,
			paddingBytes: 3,
			colorModel: "bounded-hsl-photo-filter-v1",
			executionModel: "bounded-adjustment-v1",
			bakeSupported: true,
		});
		expect(inspectPsdLayers(source(photoFilterAdjustment({ version: 3, preserve: 1 }))).layers[0].adjustment).toMatchObject({
			key: "phfl",
			version: 3,
			labColor: { lightness: 50, a: 20, b: 30 },
			preserveLuminosity: true,
			colorModel: "bounded-hsl-photo-filter-v1",
		});
		expect(() => inspectPsdLayers(source(photoFilterAdjustment({ version: 1 })))).toThrow("version 1");
		expect(() => inspectPsdLayers(source(photoFilterAdjustment({ density: 10001 })))).toThrow("density must be 0..100");
		expect(() => inspectPsdLayers(source(photoFilterAdjustment({ preserve: 2 })))).toThrow("preserve-luminosity");
		const padding = new Uint8Array(3);
		padding[2] = 1;
		expect(() => inspectPsdLayers(source(photoFilterAdjustment({ padding })))).toThrow("zero padding");
	});

	test("parses strict embedded CUBE Color Lookup records", () => {
		const source = (data: Uint8Array) =>
			layeredPsd(
				[layeredPsdLayer({ name: "Color Lookup", id: 69, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("clrL", data)], channels: [] })],
				1,
				1
			);
		expect(inspectPsdLayers(source(colorLookupAdjustment())).layers[0].adjustment).toMatchObject({
			key: "clrL",
			version: 1,
			descriptorVersion: 16,
			lookupType: "3dlut",
			name: "Invert Red",
			dither: false,
			profileBytes: 0,
			lutFormat: "cube",
			dataOrder: "rgb",
			tableOrder: "rgb",
			lut3DFileName: "invert-red.cube",
			lutSize: 2,
			lutEntryCount: 8,
			domainMinimum: [0, 0, 0],
			domainMaximum: [1, 1, 1],
			colorModel: "bounded-trilinear-color-lookup-v1",
			bakeSupported: true,
		});
		expect(() => inspectPsdLayers(source(colorLookupAdjustment({ version: 2 })))).toThrow("version 1");
		expect(() => inspectPsdLayers(source(colorLookupAdjustment({ descriptorVersion: 15 })))).toThrow("version 15");
		expect(() => inspectPsdLayers(source(colorLookupAdjustment({ lutData: ascii("LUT_3D_SIZE 2\n0 0 0\n") })))).toThrow("exactly N³");
	});

	test("decodes adjustment-layer raster masks over target bounds", () => {
		const source = layeredPsd(
			[
				layeredPsdLayer({
					name: "Masked Invert",
					id: 70,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					mask: { top: 0, left: 0, width: 2, height: 1, defaultColor: 0 },
					additionalInfo: [additionalInfo("nvrt", new Uint8Array())],
					channels: [{ id: -2, plane: [0, 255], width: 2, height: 1, compression: 0 }],
				}),
			],
			2,
			1
		);
		const adjustment = inspectPsdLayers(source).layers[0].adjustment!;
		const mask = decodePsdAdjustmentMasks(source, [0], { left: 0, top: 0, width: 2, height: 1 })[0];
		expect(mask).toMatchObject({ layerIndex: 0, executionModel: "bounded-adjustment-mask-v1" });
		expect([...mask.coverage]).toEqual([0, 255]);
		const genericMask = decodePsdLayerMasks(source, [0], { left: 0, top: 0, width: 2, height: 1 })[0];
		expect(genericMask).toMatchObject({ layerIndex: 0, executionModel: "bounded-layer-mask-v1" });
		expect([...genericMask.coverage]).toEqual([0, 255]);
		expect([...applyPsdLayerAdjustment(new Uint8Array([10, 20, 30, 123, 10, 20, 30, 124]), adjustment, 255, mask.coverage)]).toEqual([10, 20, 30, 123, 245, 235, 225, 124]);
		expect(() => applyPsdLayerAdjustment(new Uint8Array([10, 20, 30, 123]), adjustment, 255, new Uint8Array(2))).toThrow("one byte per RGBA8 pixel");
	});

	test("executes bounded core adjustments with opacity while preserving alpha", () => {
		const pixel = new Uint8Array([10, 20, 30, 200]);
		const selectiveDefaults = {
			version: 1 as const,
			reservedBytes: 8 as const,
			yellows: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			greens: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			cyans: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			blues: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			magentas: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			whites: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			neutrals: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			blacks: { cyan: 0, magenta: 0, yellow: 0, black: 0 },
			rangeModel: "bounded-extrema-range-weights-v1" as const,
			colorModel: "bounded-cmyk-selective-color-v1" as const,
			executionModel: "bounded-adjustment-v1" as const,
			bakeSupported: true,
		};
		const parsedGradient = inspectPsdLayers(
			layeredPsd(
				[
					layeredPsdLayer({
						name: "Gradient Map",
						id: 67,
						top: 0,
						left: 0,
						width: 0,
						height: 0,
						additionalInfo: [additionalInfo("grdm", gradientMapAdjustment())],
						channels: [],
					}),
				],
				1,
				1
			)
		).layers[0].adjustment!;
		expect([...applyPsdLayerAdjustment(new Uint8Array([128, 128, 128, 120]), parsedGradient)]).toEqual([128, 0, 0, 120]);
		const parsedPhotoFilter = inspectPsdLayers(
			layeredPsd(
				[
					layeredPsdLayer({
						name: "Photo Filter",
						id: 68,
						top: 0,
						left: 0,
						width: 0,
						height: 0,
						additionalInfo: [additionalInfo("phfl", photoFilterAdjustment())],
						channels: [],
					}),
				],
				1,
				1
			)
		).layers[0].adjustment!;
		expect([...applyPsdLayerAdjustment(new Uint8Array([100, 100, 100, 121]), parsedPhotoFilter)]).toEqual([139, 107, 75, 121]);
		const parsedColorLookup = inspectPsdLayers(
			layeredPsd(
				[
					layeredPsdLayer({
						name: "Color Lookup",
						id: 69,
						top: 0,
						left: 0,
						width: 0,
						height: 0,
						additionalInfo: [additionalInfo("clrL", colorLookupAdjustment())],
						channels: [],
					}),
				],
				1,
				1
			)
		).layers[0].adjustment!;
		expect([...applyPsdLayerAdjustment(new Uint8Array([64, 128, 192, 122]), parsedColorLookup)]).toEqual([191, 128, 192, 122]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([255, 0, 0, 118]), {
				key: "selc",
				mode: "absolute",
				reds: { cyan: 100, magenta: 0, yellow: 0, black: 0 },
				...selectiveDefaults,
			}),
		]).toEqual([0, 0, 0, 118]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([255, 0, 0, 119]), {
				key: "selc",
				mode: "relative",
				reds: { cyan: 100, magenta: 0, yellow: 0, black: 0 },
				...selectiveDefaults,
			}),
		]).toEqual([255, 0, 0, 119]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([100, 50, 25, 116]), {
				key: "mixr",
				version: 1,
				monochrome: false,
				red: { red: 0, green: 100, blue: 0, constant: 10, reservedWord: 0, total: 100 },
				green: { red: 0, green: 0, blue: 100, constant: 0, reservedWord: 0, total: 100 },
				blue: { red: 100, green: 0, blue: 0, constant: 0, reservedWord: 0, total: 100 },
				gray: { red: 40, green: 40, blue: 20, constant: 0, reservedWord: 0, total: 100 },
				monochromePaddingBytes: 0,
				colorModel: "bounded-linear-channel-mixer-v1",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([76, 25, 100, 116]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([100, 50, 0, 117]), {
				key: "mixr",
				version: 1,
				monochrome: true,
				red: null,
				green: null,
				blue: null,
				gray: { red: 40, green: 40, blue: 20, constant: 0, reservedWord: 0, total: 100 },
				monochromePaddingBytes: 30,
				colorModel: "bounded-linear-channel-mixer-v1",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([60, 60, 60, 117]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([255, 0, 0, 115]), {
				key: "blwh",
				descriptorVersion: 16,
				paddingBytes: 0,
				reds: 40,
				yellows: 60,
				greens: 40,
				cyans: 60,
				blues: 20,
				magentas: 80,
				useTint: false,
				tintColor: { space: 0, components: [0, 0, 0, 0], rgba: [0, 0, 0, 255] },
				presetKind: 0,
				presetFileName: "",
				colorModel: "bounded-hue-mix-black-white-v1",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([102, 102, 102, 115]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([100, 100, 100, 114]), {
				key: "blnc",
				shadows: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
				midtones: { cyanRed: 20, magentaGreen: -10, yellowBlue: 30 },
				highlights: { cyanRed: 0, magentaGreen: 0, yellowBlue: 0 },
				preserveLuminosity: false,
				paddingByte: 0,
				tonalModel: "piecewise-luminance-tones-v1",
				colorModel: "bounded-rgb-color-balance-v1",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([140, 80, 160, 114]);
		expect([
			...applyPsdLayerAdjustment(pixel, {
				key: "brit",
				brightness: 10,
				contrast: 0,
				mean: 127,
				labOnly: false,
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([36, 46, 56, 200]);
		expect([
			...applyPsdLayerAdjustment(pixel, {
				key: "curv",
				version: 4,
				curves: [],
				master: [
					{ input: 0, output: 255 },
					{ input: 255, output: 0 },
				],
				red: [
					{ input: 0, output: 0 },
					{ input: 255, output: 255 },
				],
				green: [
					{ input: 0, output: 0 },
					{ input: 255, output: 255 },
				],
				blue: [
					{ input: 0, output: 0 },
					{ input: 255, output: 255 },
				],
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([245, 235, 225, 200]);
		expect([
			...applyPsdLayerAdjustment(pixel, {
				key: "expA",
				version: 1,
				exposure: 1,
				offset: 0,
				gamma: 1,
				colorModel: "linear-srgb-v1",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([18, 31, 45, 200]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([200, 100, 100, 123]), {
				key: "vibA",
				descriptorVersion: 16,
				paddingBytes: 0,
				vibrance: 100,
				saturation: 0,
				colorModel: "bounded-hsl-vibrance-v1",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([221, 79, 79, 123]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([255, 0, 0, 111]), {
				key: "hue2",
				version: 2,
				sourceModel: "photoshop-5+",
				hueUnitScale: 1,
				colorize: false,
				paddingByte: 0,
				colorization: { hue: 0, saturation: 0, lightness: 0 },
				master: { hue: 120, saturation: 0, lightness: 0 },
				channels: [],
				localAdjustmentsPresent: false,
				localRangeModel: "normalized-hextant-feather-v1",
				colorModel: "bounded-hsl-hue-v2",
				executionModel: "bounded-adjustment-v1",
				bakeSupported: true,
			}),
		]).toEqual([0, 255, 0, 111]);
		const hueBase = {
			version: 2 as const,
			colorize: false,
			paddingByte: 0,
			colorization: { hue: 0, saturation: 0, lightness: 0 },
			master: { hue: 0, saturation: 0, lightness: 0 },
			localRangeModel: "normalized-hextant-feather-v1" as const,
			colorModel: "bounded-hsl-hue-v2" as const,
			executionModel: "bounded-adjustment-v1" as const,
			bakeSupported: true,
		};
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([255, 0, 0, 112]), {
				...hueBase,
				key: "hue2",
				sourceModel: "photoshop-5+",
				hueUnitScale: 1,
				channels: [{ name: "reds", range: [-100, -50, 50, 100], hue: 120, saturation: 0, lightness: 0 }],
				localAdjustmentsPresent: true,
			}),
		]).toEqual([0, 255, 0, 112]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([255, 0, 0, 113]), {
				...hueBase,
				key: "hue ",
				sourceModel: "photoshop-4",
				hueUnitScale: 1.8,
				master: { hue: 100, saturation: 0, lightness: 0 },
				channels: [],
				localAdjustmentsPresent: false,
			}),
		]).toEqual([0, 255, 255, 113]);
		expect([
			...applyPsdLayerAdjustment(
				pixel,
				{
					key: "levl",
					version: 2,
					records: [],
					master: { inputFloor: 0, inputCeiling: 255, outputFloor: 255, outputCeiling: 0, gamma: 100 },
					red: { inputFloor: 0, inputCeiling: 255, outputFloor: 0, outputCeiling: 255, gamma: 100 },
					green: { inputFloor: 0, inputCeiling: 255, outputFloor: 0, outputCeiling: 255, gamma: 100 },
					blue: { inputFloor: 0, inputCeiling: 255, outputFloor: 0, outputCeiling: 255, gamma: 100 },
					executionModel: "bounded-adjustment-v1",
					bakeSupported: true,
				},
				128
			),
		]).toEqual([128, 128, 128, 200]);
		expect([...applyPsdLayerAdjustment(pixel, { key: "nvrt", executionModel: "bounded-adjustment-v1", bakeSupported: true }, 128)]).toEqual([128, 128, 128, 200]);
		expect([...applyPsdLayerAdjustment(pixel, { key: "post", levels: 2, executionModel: "bounded-adjustment-v1", bakeSupported: true })]).toEqual([0, 0, 0, 200]);
		expect([
			...applyPsdLayerAdjustment(new Uint8Array([200, 160, 180, 99]), { key: "thrs", threshold: 128, executionModel: "bounded-adjustment-v1", bakeSupported: true }),
		]).toEqual([255, 255, 255, 99]);
	});

	test("inspects bounded legacy solid-fill layer effects without mutating raw decoded pixels", () => {
		const layer = layeredPsdLayer({
			name: "Overlay",
			id: 31,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lrFX", legacyLayerEffects({ color: [200, 50, 10], opacity: 128, blendMode: "mul " }))],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [128] },
			],
		});
		const source = layeredPsd([layer], 1, 1);
		const inspected = inspectPsdLayers(source).layers[0];
		expect(inspected.effects).toEqual({
			version: 0,
			visible: true,
			effectCount: 2,
			unsupportedKeys: [],
			innerShadows: [],
			innerGlows: [],
			dropShadows: [],
			outerGlows: [],
			bevels: [],
			satins: [],
			strokes: [],
			gradientOverlays: [],
			patternOverlays: [],
			solidFills: [
				{
					key: "sofi",
					index: 1,
					version: 2,
					enabled: true,
					opacity: 128,
					blendMode: "mul ",
					color: { space: 0, components: [51400, 12850, 2570, 0], rgba: [200, 50, 10, 255] },
					nativeColor: { space: 0, components: [51400, 12850, 2570, 0], rgba: [200, 50, 10, 255] },
					bakeSupported: true,
				},
			],
		});
		expect(inspected.warnings).toEqual(expect.arrayContaining([expect.stringContaining("Layer effect sofi #2")]));
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([20, 40, 60, 128]);

		const paddedEffects = concat(legacyLayerEffects({ color: [200, 50, 10], opacity: 128 }), new Uint8Array(3));
		const paddedSource = layeredPsd(
			[layeredPsdLayer({ name: "Padded Effects", id: 32, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("lrFX", paddedEffects)], channels: [] })],
			1,
			1
		);
		expect(inspectPsdLayers(paddedSource).layers[0].effects?.effectCount).toBe(2);
		const invalidPadding = new Uint8Array(paddedEffects);
		invalidPadding[invalidPadding.length - 1] = 1;
		const invalidSource = layeredPsd(
			[layeredPsdLayer({ name: "Invalid Padding", id: 33, top: 0, left: 0, width: 0, height: 0, additionalInfo: [additionalInfo("lrFX", invalidPadding)], channels: [] })],
			1,
			1
		);
		expect(() => inspectPsdLayers(invalidSource)).toThrow("trailing byte(s)");
	});

	test("inspects bounded modern lfx2 solid-color Stroke descriptors", () => {
		const layer = layeredPsdLayer({
			name: "Modern Stroke",
			id: 33,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lfx2", modernStrokeLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [128] },
			],
		});
		const source = layeredPsd([layer], 1, 1);
		const inspected = inspectPsdLayers(source).layers[0];
		expect(inspected.effects?.descriptorVersion).toBe(16);
		expect(inspected.effects?.visible).toBe(true);
		expect(inspected.effects?.strokes).toEqual([
			{
				key: "FrFX",
				descriptorKey: "FrFX",
				descriptorListIndex: null,
				index: 0,
				source: "lfx2",
				enabled: true,
				present: true,
				showInDialog: true,
				position: "outside",
				fillType: "solidColor",
				blendMode: "norm",
				opacity: 80,
				size: 2,
				sizeUnits: "#Pxl",
				color: { space: 0, components: [2570, 5140, 7710, 0], rgba: [10, 20, 30, 255] },
				gradient: null,
				pattern: null,
				bakeSupported: true,
			},
		]);
		expect(inspected.warnings).toEqual(expect.arrayContaining([expect.stringContaining("FrFX #1")]));
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([20, 40, 60, 128]);
		const paddedEffects = concat(modernStrokeLayerEffects(), new Uint8Array(1));
		const paddedSource = layeredPsd(
			[
				layeredPsdLayer({
					name: "Padded Modern Effects",
					id: 34,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [additionalInfo("lfx2", paddedEffects)],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(inspectPsdLayers(paddedSource).layers[0].effects?.strokes).toHaveLength(1);
		const invalidPadding = new Uint8Array(paddedEffects);
		invalidPadding[invalidPadding.length - 1] = 1;
		const invalidSource = layeredPsd(
			[
				layeredPsdLayer({
					name: "Invalid Modern Padding",
					id: 35,
					top: 0,
					left: 0,
					width: 0,
					height: 0,
					additionalInfo: [additionalInfo("lfx2", invalidPadding)],
					channels: [],
				}),
			],
			1,
			1
		);
		expect(() => inspectPsdLayers(invalidSource)).toThrow("trailing descriptor byte(s)");
	});

	test("inspects bounded modern lfx2 Color Overlay descriptors", () => {
		const layer = layeredPsdLayer({
			name: "Modern Color Overlay",
			id: 38,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lfx2", modernColorOverlayLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [255] },
			],
		});
		const overlay = inspectPsdLayers(layeredPsd([layer], 1, 1)).layers[0].effects?.solidFills[0];
		expect(overlay).toEqual({
			key: "sofi",
			descriptorKey: "SoFi",
			descriptorListIndex: null,
			index: 0,
			version: 2,
			source: "lfx2",
			present: true,
			showInDialog: false,
			enabled: true,
			opacity: 40,
			blendMode: "mul ",
			color: { space: 0, components: [51400, 12850, 2570, 0], rgba: [200, 50, 10, 255] },
			nativeColor: { space: 0, components: [51400, 12850, 2570, 0], rgba: [200, 50, 10, 255] },
			bakeSupported: true,
		});
	});

	test("inspects bounded modern lfx2 solid and seeded-noise Gradient Overlay descriptors in descriptor order", () => {
		const create = (type: "solid" | "noise", includeColorAfter = false, useMulti = false): Uint8Array =>
			layeredPsd(
				[
					layeredPsdLayer({
						name: `Gradient Overlay ${type}`,
						id: type === "solid" ? 39 : 40,
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						additionalInfo: [additionalInfo(useMulti ? "lmfx" : "lfx2", modernGradientOverlayLayerEffects(type, includeColorAfter, useMulti))],
						channels: [
							{ id: 0, compression: 0, plane: [20] },
							{ id: 1, compression: 0, plane: [40] },
							{ id: 2, compression: 0, plane: [60] },
							{ id: -1, compression: 0, plane: [255] },
						],
					}),
				],
				1,
				1
			);
		const solidEffects = inspectPsdLayers(create("solid", true)).layers[0].effects!;
		expect(solidEffects.gradientOverlays[0]).toMatchObject({
			key: "GrFl",
			index: 0,
			source: "lfx2",
			enabled: true,
			present: true,
			showInDialog: false,
			blendMode: "norm",
			opacity: 75,
			bakeSupported: true,
			gradient: { type: "solid", name: "Overlay Red Blue", interpolation: "linear", executionModel: "bounded-solid-v2", bakeSupported: true },
		});
		expect(solidEffects.solidFills[0].index).toBe(1);
		expect(inspectPsdLayers(create("noise", false, true)).layers[0].effects?.gradientOverlays[0]).toMatchObject({
			key: "GrFl",
			index: 0,
			bakeSupported: true,
			gradient: {
				type: "noise",
				name: "Overlay Seeded Noise",
				colorModel: "rgb",
				randomSeed: 3650322,
				executionModel: "bounded-seeded-v1",
				bakeSupported: true,
			},
		});
	});

	test("inspects bounded modern lfx2 Drop Shadow and innerShadowMulti descriptors in authored order", () => {
		const layer = layeredPsdLayer({
			name: "Modern Shadows",
			id: 41,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lmfx", modernShadowLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [255] },
			],
		});
		const effects = inspectPsdLayers(layeredPsd([layer], 1, 1)).layers[0].effects!;
		expect(effects.dropShadows[0]).toMatchObject({
			key: "dsdw",
			index: 0,
			source: "lfx2",
			present: true,
			showInDialog: false,
			enabled: true,
			blur: 3,
			intensity: 100,
			angle: -45,
			distance: 2,
			blendMode: "mul ",
			useGlobalAngle: false,
			opacity: 60,
			choke: 0,
			antialiased: true,
			noise: 0,
			contour: null,
			layerConceals: true,
			executionModel: "bounded-shadow-v2",
			bakeSupported: true,
			color: { rgba: [10, 20, 30, 255] },
		});
		expect(effects.innerShadows[0]).toMatchObject({
			key: "isdw",
			index: 1,
			source: "lfx2",
			present: true,
			showInDialog: true,
			enabled: true,
			blur: 3,
			angle: -45,
			distance: 2,
			blendMode: "norm",
			opacity: 60,
			choke: 0,
			antialiased: true,
			noise: 0,
			contour: null,
			executionModel: "bounded-shadow-v2",
			bakeSupported: true,
			color: { rgba: [200, 100, 50, 255] },
		});
	});

	test("inspects every valid lmfx multiple-instance family with exact list provenance and authored order", () => {
		const layer = layeredPsdLayer({
			name: "All Multiple Effects",
			id: 46,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lmfx", modernMultipleInstanceLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [255] },
			],
		});
		const effects = inspectPsdLayers(layeredPsd([layer], 1, 1)).layers[0].effects!;
		const evidence = [...effects.gradientOverlays, ...effects.dropShadows, ...effects.strokes, ...effects.solidFills, ...effects.innerShadows]
			.sort((left, right) => left.index - right.index)
			.map((effect) => ({ index: effect.index, descriptorKey: effect.descriptorKey, descriptorListIndex: effect.descriptorListIndex }));
		expect(evidence).toEqual([
			{ index: 0, descriptorKey: "gradientFillMulti", descriptorListIndex: 0 },
			{ index: 1, descriptorKey: "gradientFillMulti", descriptorListIndex: 1 },
			{ index: 2, descriptorKey: "dropShadowMulti", descriptorListIndex: 0 },
			{ index: 3, descriptorKey: "dropShadowMulti", descriptorListIndex: 1 },
			{ index: 4, descriptorKey: "frameFXMulti", descriptorListIndex: 0 },
			{ index: 5, descriptorKey: "frameFXMulti", descriptorListIndex: 1 },
			{ index: 6, descriptorKey: "solidFillMulti", descriptorListIndex: 0 },
			{ index: 7, descriptorKey: "solidFillMulti", descriptorListIndex: 1 },
			{ index: 8, descriptorKey: "innerShadowMulti", descriptorListIndex: 0 },
			{ index: 9, descriptorKey: "innerShadowMulti", descriptorListIndex: 1 },
		]);
		expect(effects.effectCount).toBe(10);
		expect(effects.unsupportedKeys).toEqual([]);
	});

	test("inspects bounded modern shadow choke, deterministic noise, and custom contour execution", () => {
		const layer = layeredPsdLayer({
			name: "Advanced Shadows",
			id: 45,
			top: 0,
			left: 0,
			width: 2,
			height: 2,
			additionalInfo: [
				additionalInfo(
					"lmfx",
					modernShadowLayerEffects({
						choke: 2,
						noise: 25,
						antialiased: false,
						contour: [
							[0, 0],
							[128, 224],
							[255, 255],
						],
					})
				),
			],
			channels: [
				{ id: 0, compression: 0, plane: [20, 20, 20, 20] },
				{ id: 1, compression: 0, plane: [40, 40, 40, 40] },
				{ id: 2, compression: 0, plane: [60, 60, 60, 60] },
				{ id: -1, compression: 0, plane: [255, 255, 255, 255] },
			],
		});
		const effects = inspectPsdLayers(layeredPsd([layer], 2, 2)).layers[0].effects!;
		for (const effect of [effects.dropShadows[0], effects.innerShadows[0]]) {
			expect(effect).toMatchObject({
				choke: 2,
				noise: 25,
				antialiased: false,
				contour: {
					name: "Shadow Ramp",
					points: [
						{ x: 0, y: 0 },
						{ x: 128, y: 224 },
						{ x: 255, y: 255 },
					],
					linear: false,
					valid: true,
				},
				executionModel: "bounded-shadow-v2",
				bakeSupported: true,
			});
		}
	});

	test("inspects bounded modern lmfx Outer Glow and Inner Glow descriptors in authored order", () => {
		const layer = layeredPsdLayer({
			name: "Modern Glows",
			id: 42,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lmfx", modernGlowLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [255] },
			],
		});
		const effects = inspectPsdLayers(layeredPsd([layer], 1, 1)).layers[0].effects!;
		expect(effects.outerGlows[0]).toMatchObject({
			key: "oglw",
			index: 0,
			source: "lfx2",
			present: true,
			showInDialog: false,
			enabled: true,
			blur: 1,
			intensity: 100,
			blendMode: "norm",
			opacity: 50,
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
			},
			bakeSupported: true,
			color: { rgba: [255, 255, 255, 255] },
		});
		expect(effects.innerGlows[0]).toMatchObject({
			key: "iglw",
			index: 1,
			source: "lfx2",
			present: true,
			showInDialog: true,
			enabled: true,
			blur: 1,
			blendMode: "norm",
			opacity: 50,
			glowSource: "edge",
			technique: "softer",
			executionModel: "bounded-glow-v2",
			invert: false,
			bakeSupported: true,
			color: { rgba: [255, 0, 0, 255] },
		});
		expect(effects.unsupportedKeys).toEqual([]);
	});

	test("inspects advanced bounded modern lmfx Glow execution fields", () => {
		const layer = layeredPsdLayer({
			name: "Advanced Modern Glows",
			id: 421,
			top: 0,
			left: 0,
			width: 3,
			height: 3,
			additionalInfo: [
				additionalInfo(
					"lmfx",
					modernGlowLayerEffects({
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
			channels: [
				{ id: 0, compression: 0, plane: Array(9).fill(20) },
				{ id: 1, compression: 0, plane: Array(9).fill(40) },
				{ id: 2, compression: 0, plane: Array(9).fill(60) },
				{ id: -1, compression: 0, plane: Array(9).fill(255) },
			],
		});
		const effects = inspectPsdLayers(layeredPsd([layer], 3, 3)).layers[0].effects!;
		for (const effect of [effects.outerGlows[0], effects.innerGlows[0]]) {
			expect(effect).toMatchObject({
				choke: 1,
				noise: 30,
				range: 75,
				jitter: 100,
				technique: "precise",
				antialiased: false,
				contour: {
					name: "Glow Ramp",
					points: [
						{ x: 0, y: 0 },
						{ x: 128, y: 224 },
						{ x: 255, y: 255 },
					],
					linear: false,
					valid: true,
				},
				executionModel: "bounded-glow-v2",
				bakeSupported: true,
			});
		}
		expect(effects.outerGlows[0].glowSource).toBe("edge");
		expect(effects.innerGlows[0].glowSource).toBe("center");
	});

	test("inspects bounded modern lmfx Satin and Bevel descriptors in authored order", () => {
		const layer = layeredPsdLayer({
			name: "Modern Bevel Satin",
			id: 43,
			top: 0,
			left: 0,
			width: 3,
			height: 1,
			additionalInfo: [additionalInfo("lmfx", modernBevelSatinLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [100, 100, 100] },
				{ id: 1, compression: 0, plane: [100, 100, 100] },
				{ id: 2, compression: 0, plane: [100, 100, 100] },
				{ id: -1, compression: 0, plane: [255, 255, 255] },
			],
		});
		const effects = inspectPsdLayers(layeredPsd([layer], 3, 1)).layers[0].effects!;
		expect(effects.satins[0]).toMatchObject({
			key: "ChFX",
			index: 0,
			source: "lfx2",
			present: true,
			showInDialog: false,
			enabled: true,
			blendMode: "norm",
			opacity: 50,
			angle: 0,
			distance: 1,
			size: 0,
			antialiased: true,
			invert: false,
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
			bakeSupported: true,
			color: { rgba: [0, 0, 255, 255] },
		});
		expect(effects.bevels[0]).toMatchObject({
			key: "bevl",
			index: 1,
			source: "lfx2",
			present: true,
			showInDialog: true,
			enabled: true,
			angle: 0,
			altitude: 90,
			strength: 1,
			size: 1,
			depth: 100,
			soften: 0,
			style: 2,
			styleName: "inner bevel",
			technique: "smooth",
			direction: 0,
			useGlobalAngle: false,
			useShape: false,
			useTexture: false,
			antialiasGloss: true,
			contour: { name: "Linear", linear: true, valid: true },
			executionModel: "bounded-bevel-v2",
			bakeSupported: true,
			highlightColor: { rgba: [255, 255, 255, 255] },
			shadowColor: { rgba: [0, 0, 0, 255] },
		});
		expect(effects.unsupportedKeys).toEqual([]);
	});

	test.each([
		["OtrB", "outer bevel", 1, "SfBL", "smooth"],
		["InrB", "inner bevel", 2, "PrBL", "chisel hard"],
		["Embs", "emboss", 3, "Slmt", "chisel soft"],
		["PlEb", "pillow emboss", 4, "SfBL", "smooth"],
		["strokeEmboss", "stroke emboss", 5, "PrBL", "chisel hard"],
	] as const)("inspects modern %s Bevel shape and texture execution", (style, styleName, styleCode, technique, techniqueName) => {
		const layer = layeredPsdLayer({
			name: "Advanced Bevel",
			id: 44,
			top: 0,
			left: 0,
			width: 2,
			height: 2,
			additionalInfo: [additionalInfo("lmfx", modernBevelSatinLayerEffects({ style, technique, direction: "Out ", useShape: true, useTexture: true }))],
			channels: [
				{ id: 0, compression: 0, plane: [100, 100, 100, 100] },
				{ id: 1, compression: 0, plane: [100, 100, 100, 100] },
				{ id: 2, compression: 0, plane: [100, 100, 100, 100] },
				{ id: -1, compression: 0, plane: [255, 255, 255, 255] },
			],
		});
		const effect = inspectPsdLayers(layeredPsd([layer], 2, 2, 0, patternTaggedBlock())).layers[0].effects?.bevels[0];
		expect(effect).toMatchObject({
			style: styleCode,
			styleName,
			technique: techniqueName,
			direction: 1,
			useShape: true,
			shapeContour: { name: "Shape Ramp", valid: true, linear: false },
			shapeRange: 75,
			shapeRangeUnits: "#Prc",
			useTexture: true,
			texturePattern: { id: "tile-2x2", resolvedPatternIndex: 0, bakeSupported: true },
			textureDepth: 80,
			textureDepthUnits: "#Prc",
			textureInvert: true,
			executionModel: "bounded-bevel-v2",
			bakeSupported: true,
		});
	});

	test("inspects bounded modern lfx2 aligned classic solid-gradient Stroke descriptors", () => {
		const layer = layeredPsdLayer({
			name: "Gradient Stroke",
			id: 34,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lfx2", modernGradientStrokeLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [255] },
			],
		});
		const stroke = inspectPsdLayers(layeredPsd([layer], 1, 1)).layers[0].effects?.strokes[0];
		expect(stroke).toMatchObject({
			fillType: "gradient",
			position: "outside",
			bakeSupported: true,
			color: { rgba: null },
			gradient: {
				type: "solid",
				name: "Red Blue",
				style: "linear",
				interpolation: "classic",
				samples: 4096,
				angle: 0,
				angleUnits: "#Ang",
				scale: 100,
				scaleUnits: "#Prc",
				reverse: false,
				align: true,
				dither: false,
				offsetX: 0,
				offsetY: 0,
				offsetUnits: "#Prc",
				executionModel: "bounded-solid-v2",
				bakeSupported: true,
			},
		});
		expect(stroke?.gradient?.colorStops).toEqual([
			{ location: 0, rawLocation: 0, midpoint: 0.5, color: { space: 0, components: [65535, 0, 0, 0], rgba: [255, 0, 0, 255] } },
			{ location: 1, rawLocation: 4096, midpoint: 0.5, color: { space: 0, components: [0, 0, 65535, 0], rgba: [0, 0, 255, 255] } },
		]);
		expect(stroke?.gradient?.opacityStops).toEqual([
			{ location: 0, rawLocation: 0, midpoint: 0.5, opacity: 100 },
			{ location: 1, rawLocation: 4096, midpoint: 0.5, opacity: 100 },
		]);
	});

	test("accepts all bounded solid-gradient interpolation, document-alignment, and dither variants", () => {
		const cases = [
			{ encoded: "Gcls" as const, interpolation: "classic" },
			{ encoded: "Lnr " as const, interpolation: "linear" },
			{ encoded: "Perc" as const, interpolation: "perceptual" },
			{ encoded: "Smoo" as const, interpolation: "smooth" },
		];
		for (const item of cases) {
			const layer = layeredPsdLayer({
				name: `${item.interpolation} Gradient Stroke`,
				id: 340,
				top: 0,
				left: 0,
				width: 1,
				height: 1,
				additionalInfo: [additionalInfo("lfx2", modernGradientStrokeLayerEffects({ interpolation: item.encoded, align: false, dither: true }))],
				channels: [
					{ id: 0, compression: 0, plane: [20] },
					{ id: 1, compression: 0, plane: [40] },
					{ id: 2, compression: 0, plane: [60] },
					{ id: -1, compression: 0, plane: [255] },
				],
			});
			const gradient = inspectPsdLayers(layeredPsd([layer], 8, 6)).layers[0].effects?.strokes[0].gradient;
			expect(gradient, item.interpolation).toMatchObject({
				type: "solid",
				interpolation: item.interpolation,
				align: false,
				dither: true,
				executionModel: "bounded-solid-v2",
				bakeSupported: true,
			});
		}
	});

	test("inspects bounded modern lfx2 seeded noise-gradient Stroke descriptors", () => {
		const layer = layeredPsdLayer({
			name: "Noise Gradient Stroke",
			id: 35,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lfx2", modernNoiseGradientStrokeLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [255] },
			],
		});
		const stroke = inspectPsdLayers(layeredPsd([layer], 1, 1)).layers[0].effects?.strokes[0];
		expect(stroke).toMatchObject({
			fillType: "gradient",
			position: "outside",
			bakeSupported: true,
			gradient: {
				type: "noise",
				name: "Seeded Noise",
				style: "linear",
				interpolation: "unknown",
				samples: 0,
				roughness: 0.5,
				roughnessRaw: 2048,
				colorModel: "rgb",
				randomSeed: 3650322,
				restrictColors: true,
				addTransparency: true,
				minimum: [0, 0.1, 0.2, 0.3],
				maximum: [1, 0.9, 0.8, 0.7],
				minimumRaw: [0, 10, 20, 30],
				maximumRaw: [100, 90, 80, 70],
				executionModel: "bounded-seeded-v1",
				colorStops: [],
				opacityStops: [],
				bakeSupported: true,
			},
		});
	});

	test("resolves and decodes embedded Patt tiles for modern pattern Strokes and Pattern Overlays", () => {
		const create = (kind: "stroke" | "overlay"): Uint8Array => {
			const layer = layeredPsdLayer({
				name: kind === "stroke" ? "Pattern Stroke" : "Pattern Overlay",
				id: kind === "stroke" ? 36 : 37,
				top: 0,
				left: 0,
				width: 1,
				height: 1,
				additionalInfo: [additionalInfo("lfx2", modernPatternLayerEffects(kind))],
				channels: [
					{ id: 0, compression: 0, plane: [20] },
					{ id: 1, compression: 0, plane: [40] },
					{ id: 2, compression: 0, plane: [60] },
					{ id: -1, compression: 0, plane: [255] },
				],
			});
			return layeredPsd([layer], 1, 1, 0, patternTaggedBlock());
		};
		const strokeDocument = inspectPsdLayers(create("stroke"));
		expect(strokeDocument.patterns).toEqual([
			expect.objectContaining({
				index: 0,
				sourceTag: "Patt",
				name: "Test Tile",
				id: "tile-2x2",
				width: 2,
				height: 2,
				colorMode: "rgb",
				channelCount: 3,
				compressions: ["raw", "raw", "raw"],
				bakeSupported: true,
			}),
		]);
		expect(strokeDocument.layers[0].effects?.strokes[0]).toMatchObject({
			fillType: "pattern",
			bakeSupported: true,
			pattern: {
				name: "Test Tile",
				id: "tile-2x2",
				scale: 200,
				angle: 90,
				align: false,
				linked: false,
				phaseX: 1,
				phaseY: -1,
				resolvedPatternIndex: 0,
				resolvedPatternName: "Test Tile",
				resolvedWidth: 2,
				resolvedHeight: 2,
				executionModel: "bounded-pattern-v1",
				bakeSupported: true,
			},
		});
		expect([...decodePsdPatterns(create("stroke"))[0].pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
		for (const compression of [1, 2, 3] as const) {
			const layer = layeredPsdLayer({
				name: `Pattern ${compression}`,
				id: 40 + compression,
				top: 0,
				left: 0,
				width: 1,
				height: 1,
				additionalInfo: [additionalInfo("lfx2", modernPatternLayerEffects("stroke"))],
				channels: [
					{ id: 0, compression: 0, plane: [20] },
					{ id: 1, compression: 0, plane: [40] },
					{ id: 2, compression: 0, plane: [60] },
					{ id: -1, compression: 0, plane: [255] },
				],
			});
			const decoded = decodePsdPatterns(layeredPsd([layer], 1, 1, 0, patternTaggedBlock(compression)))[0];
			const expectedCompression = compression === 1 ? "rle" : compression === 2 ? "zip" : "zipPrediction";
			expect(decoded.compressions, `compression ${compression}`).toEqual([expectedCompression, expectedCompression, expectedCompression]);
			expect([...decoded.pixels], `compression ${compression}`).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
		}
		const plainLayer = layeredPsdLayer({
			name: "Pattern color modes",
			id: 50,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
			],
		});
		for (const depth of [16, 32] as const) {
			for (const compression of [0, 1, 2, 3] as const) {
				const decoded = decodePsdPatterns(layeredPsd([plainLayer], 1, 1, 0, patternTaggedBlock(compression, depth)))[0];
				expect(decoded.bakeSupported, `${depth}-bit pattern compression ${compression}`).toBe(true);
				expect([...decoded.pixels], `${depth}-bit pattern compression ${compression}`).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
			}
		}
		expect([...decodePsdPatterns(layeredPsd([plainLayer], 1, 1, 0, singleChannelPatternTaggedBlock(1)))[0].pixels]).toEqual([25, 25, 25, 255, 200, 200, 200, 255]);
		expect([...decodePsdPatterns(layeredPsd([plainLayer], 1, 1, 0, singleChannelPatternTaggedBlock(2)))[0].pixels]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);
		expect(inspectPsdLayers(create("overlay")).layers[0].effects?.patternOverlays[0]).toMatchObject({
			key: "patternFill",
			opacity: 75,
			bakeSupported: true,
			pattern: { id: "tile-2x2", resolvedPatternIndex: 0, executionModel: "bounded-pattern-v1" },
		});
	});

	test("inspects bounded legacy inner-shadow and inner-glow records without mutating raw pixels", () => {
		const layer = layeredPsdLayer({
			name: "Interior FX",
			id: 32,
			top: 0,
			left: 0,
			width: 1,
			height: 1,
			additionalInfo: [additionalInfo("lrFX", legacyInteriorLayerEffects())],
			channels: [
				{ id: 0, compression: 0, plane: [20] },
				{ id: 1, compression: 0, plane: [40] },
				{ id: 2, compression: 0, plane: [60] },
				{ id: -1, compression: 0, plane: [128] },
			],
		});
		const source = layeredPsd([layer], 1, 1);
		const inspected = inspectPsdLayers(source).layers[0];
		expect(inspected.effects?.innerShadows).toEqual([
			expect.objectContaining({
				key: "isdw",
				index: 1,
				version: 2,
				blur: 3,
				intensity: 75,
				angle: -45,
				distance: 4,
				blendMode: "mul ",
				useGlobalAngle: true,
				opacity: 60,
				color: { space: 0, components: [2570, 5140, 7710, 0], rgba: [10, 20, 30, 255] },
				bakeSupported: true,
			}),
		]);
		expect(inspected.effects?.innerGlows).toEqual([
			expect.objectContaining({
				key: "iglw",
				index: 2,
				version: 2,
				blur: 2,
				intensity: 80,
				blendMode: "scrn",
				opacity: 70,
				invert: true,
				color: { space: 0, components: [51400, 38550, 25700, 0], rgba: [200, 150, 100, 255] },
				bakeSupported: true,
			}),
		]);
		expect(inspected.effects?.dropShadows).toEqual([
			expect.objectContaining({
				key: "dsdw",
				index: 3,
				version: 2,
				blur: 1,
				intensity: 50,
				angle: 90,
				distance: 2,
				blendMode: "mul ",
				opacity: 40,
				color: { space: 0, components: [257, 514, 771, 0], rgba: [1, 2, 3, 255] },
				bakeSupported: true,
			}),
		]);
		expect(inspected.effects?.outerGlows).toEqual([
			expect.objectContaining({
				key: "oglw",
				index: 4,
				version: 2,
				blur: 2,
				intensity: 70,
				blendMode: "scrn",
				opacity: 80,
				color: { space: 0, components: [7710, 15420, 23130, 0], rgba: [30, 60, 90, 255] },
				bakeSupported: true,
			}),
		]);
		expect(inspected.effects?.bevels).toEqual([
			expect.objectContaining({
				key: "bevl",
				index: 5,
				version: 2,
				angle: 135,
				strength: 4,
				blur: 2,
				highlightBlendMode: "scrn",
				shadowBlendMode: "mul ",
				highlightColor: { space: 0, components: [61680, 59110, 56540, 0], rgba: [240, 230, 220, 255] },
				shadowColor: { space: 0, components: [5140, 7710, 10280, 0], rgba: [20, 30, 40, 255] },
				realHighlightColor: { space: 0, components: [61680, 59110, 56540, 0], rgba: [240, 230, 220, 255] },
				realShadowColor: { space: 0, components: [5140, 7710, 10280, 0], rgba: [20, 30, 40, 255] },
				style: 5,
				styleName: "stroke emboss",
				highlightOpacity: 75,
				shadowOpacity: 65,
				enabled: true,
				useGlobalAngle: true,
				direction: 0,
				bakeSupported: true,
			}),
		]);
		expect(inspected.warnings).toEqual(
			expect.arrayContaining([
				expect.stringContaining("isdw #2"),
				expect.stringContaining("iglw #3"),
				expect.stringContaining("dsdw #4"),
				expect.stringContaining("oglw #5"),
				expect.stringContaining("bevl #6"),
			])
		);
		expect([...decodePsdLayers(source)[0].pixels]).toEqual([20, 40, 60, 128]);
	});
});

describe("PSD smart-object placement rendering", () => {
	test("executes supported smart filters in authored order with normal opacity", () => {
		const models = { average: "bounded-average-smart-filter-v1", invert: "bounded-invert-smart-filter-v1" } as const;
		const filter = (index: number, type: "average" | "invert", opacity = 100) => ({
			index,
			name: type,
			type,
			filterClassId: null,
			filterId: null,
			enabled: true,
			opacity,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: models[type],
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 2, height: 1, pixels: new Uint8Array([10, 20, 30, 255, 110, 120, 130, 255]) };
		const rendered = applyPsdSmartFilters(source, [filter(0, "invert"), filter(1, "average")]);
		expect(rendered).toMatchObject({ appliedFilterIndices: [0, 1], executionModel: "bounded-smart-filter-stack-v1" });
		expect([...rendered.pixels]).toEqual([195, 185, 175, 255, 195, 185, 175, 255]);
		expect([...applyPsdSmartFilters(source, [filter(0, "invert", 50)]).pixels]).toEqual([128, 128, 128, 255, 128, 128, 128, 255]);
	});

	test("executes exact seeded Uniform and Gaussian Add Noise without changing alpha or leaking transparent RGB", () => {
		const source = { width: 3, height: 1, pixels: new Uint8Array([10, 20, 30, 255, 100, 120, 140, 128, 250, 10, 180, 0]) };
		const filter = (distribution: "uniform" | "gaussian", monochromatic: boolean, randomSeed: number) => ({
			index: 0,
			name: `Add Noise ${distribution}`,
			type: "addNoise" as const,
			filterClassId: "AdNs",
			filterId: 1097092723,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			addNoise: { amountPercent: 25, amountUnits: "#Prc", distribution, monochromatic, randomSeed },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-add-noise-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const uniform = applyPsdSmartFilters(source, [filter("uniform", false, 123456)]);
		expect([...uniform.pixels]).toEqual([0, 58, 93, 255, 57, 83, 106, 128, 0, 0, 0, 0]);
		expect([...applyPsdSmartFilters(source, [filter("uniform", false, 123456)]).pixels]).toEqual([...uniform.pixels]);
		expect([...applyPsdSmartFilters(source, [filter("gaussian", true, -987654321)]).pixels]).toEqual([12, 22, 32, 255, 112, 132, 152, 128, 0, 0, 0, 0]);
		expect(() => applyPsdSmartFilters(source, [{ ...filter("uniform", false, 1), addNoise: null }])).toThrow("missing Add Noise parameters");
	});

	test("executes bounded thresholded-median Dust & Scratches while preserving alpha", () => {
		const pixels = new Uint8Array([
			90, 100, 110, 0, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 250, 0, 200, 128, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
		]);
		const filter = (threshold: number) => ({
			index: 0,
			name: "Dust & Scratches",
			type: "dustAndScratches" as const,
			filterClassId: "DstS",
			filterId: 1148417107,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			dustAndScratches: { radius: 1, threshold },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-thresholded-median-dust-and-scratches-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const removed = applyPsdSmartFilters({ width: 3, height: 3, pixels }, [filter(100)]);
		expect([...removed.pixels]).toEqual([
			0, 0, 0, 0, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 128, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
		]);
		expect([...applyPsdSmartFilters({ width: 3, height: 3, pixels }, [filter(255)]).pixels]).toEqual([
			0, 0, 0, 0, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 250, 0, 200, 128, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255, 10, 20, 30, 255,
		]);
		expect(() => applyPsdSmartFilters({ width: 3, height: 3, pixels }, [{ ...filter(100), dustAndScratches: null }])).toThrow("missing Dust & Scratches parameters");
	});

	test("executes all authored Reduce Noise controls deterministically while preserving alpha", () => {
		const pixels = new Uint8Array(
			Array.from({ length: 18 }, (_, index) => [40 + index * 5, 90 + (index % 4) * 20, 180 - index * 4, index === 0 ? 0 : index === 10 ? 128 : 255]).flat()
		);
		pixels.set([220, 15, 240, 255], 5 * 4);
		const filter = (overrides: Partial<NonNullable<IPsdSmartFilterInfo["reduceNoise"]>> = {}) => ({
			index: 0,
			name: "Reduce Noise",
			type: "reduceNoise" as const,
			filterClassId: "denoise",
			filterId: 633,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			reduceNoise: {
				preset: "Codex exact",
				removeJpegArtifact: true,
				reduceColorNoisePercent: 60,
				sharpenDetailsPercent: 35,
				channelDenoise: [
					{ channels: ["composite" as const], amount: 7, preserveDetailsPercent: 25 },
					{ channels: ["red" as const], amount: 4, preserveDetailsPercent: 80 },
				],
				...overrides,
			},
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 9, height: 2, pixels };
		const rendered = applyPsdSmartFilters(source, [filter()]);
		expect([...rendered.pixels]).toEqual([
			0, 0, 0, 0, 49, 116, 158, 255, 56, 127, 162, 255, 66, 134, 163, 255, 77, 86, 155, 255, 160, 57, 193, 255, 98, 118, 155, 255, 84, 124, 142, 255, 81, 105, 136, 255, 82,
			114, 147, 255, 86, 128, 149, 128, 96, 140, 154, 255, 87, 108, 137, 255, 108, 108, 143, 255, 115, 123, 141, 255, 126, 134, 142, 255, 110, 108, 122, 255, 116, 109, 124,
			255,
		]);
		expect([...applyPsdSmartFilters(source, [filter()]).pixels]).toEqual([...rendered.pixels]);
		expect(rendered.pixels[3]).toBe(0);
		expect(rendered.pixels[10 * 4 + 3]).toBe(128);
		for (const overrides of [
			{ reduceColorNoisePercent: 0 },
			{ sharpenDetailsPercent: 0 },
			{ removeJpegArtifact: false },
			{ channelDenoise: [{ channels: ["composite" as const], amount: 0, preserveDetailsPercent: null }] },
		]) {
			expect([...applyPsdSmartFilters(source, [filter(overrides)]).pixels]).not.toEqual([...rendered.pixels]);
		}
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), reduceNoise: null }])).toThrow("missing Reduce Noise parameters");
	});

	test("executes bounded CMYK-screen Color Halftone with exact radius and channel angles", () => {
		const pixels = new Uint8Array(
			Array.from({ length: 16 }, (_, index) => [20 + index * 13, 230 - index * 9, 40 + (index % 4) * 45, index === 0 ? 0 : index === 10 ? 128 : 255]).flat()
		);
		const filter = (anglesDegrees: [number, number, number, number] = [108, 162, 90, 45]) => ({
			index: 0,
			name: "Color Halftone",
			type: "colorHalftone" as const,
			filterClassId: "ClrH",
			filterId: 1131180616,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			colorHalftone: { radius: 4, anglesDegrees },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-cmyk-screen-color-halftone-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 4, height: 4, pixels };
		const rendered = applyPsdSmartFilters(source, [filter()]);
		expect([...rendered.pixels]).toEqual([
			0, 0, 0, 0, 143, 96, 255, 255, 48, 0, 255, 255, 0, 0, 48, 255, 255, 239, 255, 255, 255, 0, 255, 255, 255, 0, 239, 255, 159, 0, 80, 255, 143, 96, 143, 255, 223, 0, 207,
			255, 255, 0, 48, 128, 255, 0, 0, 255, 0, 0, 0, 255, 16, 0, 0, 255, 175, 0, 0, 255, 255, 0, 0, 255,
		]);
		expect([...applyPsdSmartFilters(source, [filter()]).pixels]).toEqual([...rendered.pixels]);
		expect(rendered.pixels[3]).toBe(0);
		expect(rendered.pixels[10 * 4 + 3]).toBe(128);
		expect([...applyPsdSmartFilters(source, [filter([45, 45, 45, 45])]).pixels]).not.toEqual([...rendered.pixels]);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), colorHalftone: null }])).toThrow("missing Color Halftone parameters");
	});

	test("executes exact seeded Voronoi Crystallize cells while preserving alpha", () => {
		const pixels = new Uint8Array(
			Array.from({ length: 36 }, (_, index) => [10 + index * 6, 240 - index * 5, 30 + (index % 6) * 35, index === 0 ? 0 : index === 14 ? 128 : 255]).flat()
		);
		const filter = (randomSeed = 123456) => ({
			index: 0,
			name: "Crystallize",
			type: "crystallize" as const,
			filterClassId: "Crst",
			filterId: 1131574132,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			crystallize: { cellSize: 3, randomSeed },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-voronoi-crystallize-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 6, height: 6, pixels };
		const rendered = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(rendered.pixels).digest("hex")).toBe("b1828f84fdc8b86e987991ba43f74f3da99f0f0b700cc95af13c72dcc434a85f");
		expect([...applyPsdSmartFilters(source, [filter()]).pixels]).toEqual([...rendered.pixels]);
		expect(rendered.pixels[3]).toBe(0);
		expect(rendered.pixels[14 * 4 + 3]).toBe(128);
		expect([...applyPsdSmartFilters(source, [filter(-987654321)]).pixels]).not.toEqual([...rendered.pixels]);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), crystallize: null }])).toThrow("missing Crystallize parameters");
	});

	test("executes all exact seeded Mezzotint pattern modes while preserving alpha", () => {
		const pixels = new Uint8Array(
			Array.from({ length: 64 }, (_, index) => [
				15 + ((index * 17) % 230),
				240 - ((index * 11) % 220),
				25 + ((index * 29) % 210),
				index === 0 ? 0 : index === 27 ? 128 : 255,
			]).flat()
		);
		const patterns = [
			"fine dots",
			"medium dots",
			"grainy dots",
			"coarse dots",
			"short lines",
			"medium lines",
			"long lines",
			"short strokes",
			"medium strokes",
			"long strokes",
		] as const;
		const filter = (pattern: (typeof patterns)[number] = "medium strokes", randomSeed = 123456) => ({
			index: 0,
			name: "Mezzotint",
			type: "mezzotint" as const,
			filterClassId: "Mztn",
			filterId: 1299870830,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			mezzotint: { pattern, randomSeed },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-mezzotint-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 8, height: 8, pixels };
		const rendered = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(rendered.pixels).digest("hex")).toBe("0818516bc6f248ab664676f9d3d87a19b31e080d36b91b47cbf854cb19d234fa");
		expect(
			new Set(
				patterns.map((pattern) =>
					createHash("sha256")
						.update(applyPsdSmartFilters(source, [filter(pattern)]).pixels)
						.digest("hex")
				)
			).size
		).toBe(patterns.length);
		expect([...applyPsdSmartFilters(source, [filter()]).pixels]).toEqual([...rendered.pixels]);
		expect(rendered.pixels[3]).toBe(0);
		expect(rendered.pixels[27 * 4 + 3]).toBe(128);
		expect([...applyPsdSmartFilters(source, [filter("medium strokes", -987654321)]).pixels]).not.toEqual([...rendered.pixels]);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), mezzotint: null }])).toThrow("missing Mezzotint parameters");
	});

	test("executes exact premultiplied Mosaic cells while preserving destination alpha", () => {
		const pixels = new Uint8Array(
			Array.from({ length: 20 }, (_, index) => [10 + index * 9, 220 - index * 7, 30 + (index % 5) * 40, index === 0 ? 0 : index === 7 ? 128 : 255]).flat()
		);
		const filter = (cellSize = 2) => ({
			index: 0,
			name: "Mosaic",
			type: "mosaic" as const,
			filterClassId: "Msc ",
			filterId: 1299407648,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			mosaic: { cellSize, cellSizeUnits: "#Pxl" },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-premultiplied-mosaic-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 5, height: 4, pixels };
		const rendered = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(rendered.pixels).digest("hex")).toBe("2b21524a12b428205253d5c46bcc334140dd90ff3582389a7cf412e31403d2ae");
		expect([...applyPsdSmartFilters(source, [filter()]).pixels]).toEqual([...rendered.pixels]);
		expect(rendered.pixels[3]).toBe(0);
		expect(rendered.pixels[7 * 4 + 3]).toBe(128);
		expect([...applyPsdSmartFilters(source, [filter(3)]).pixels]).not.toEqual([...rendered.pixels]);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), mosaic: null }])).toThrow("missing Mosaic parameters");
	});

	test("executes seeded Pointillize dots over the exact authored background canvas", () => {
		const pixels = new Uint8Array(
			Array.from({ length: 36 }, (_, index) => [
				15 + ((index * 17) % 220),
				230 - ((index * 13) % 210),
				20 + ((index * 31) % 220),
				index === 0 ? 0 : index === 14 ? 128 : 255,
			]).flat()
		);
		const filter = (cellSize = 3, randomSeed = 123456) => ({
			index: 0,
			name: "Pointillize",
			type: "pointillize" as const,
			filterClassId: "Pntl",
			filterId: 1349416044,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			foregroundColor: [0, 0, 0, 255] as [number, number, number, 255],
			backgroundColor: [255, 255, 255, 255] as [number, number, number, 255],
			pointillize: { cellSize, randomSeed },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-authored-canvas-pointillize-smart-filter-v2" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 6, height: 6, pixels };
		const rendered = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(rendered.pixels).digest("hex")).toBe("8268238f413d9f7052f177827ef60c967e0ebfd0f747f5d48f16a6a64c0f9a4e");
		expect([...applyPsdSmartFilters(source, [filter()]).pixels]).toEqual([...rendered.pixels]);
		expect(rendered.pixels[3]).toBe(0);
		expect(rendered.pixels[14 * 4 + 3]).toBe(128);
		expect([...applyPsdSmartFilters(source, [filter(4)]).pixels]).not.toEqual([...rendered.pixels]);
		expect([...applyPsdSmartFilters(source, [filter(3, -987654321)]).pixels]).not.toEqual([...rendered.pixels]);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), pointillize: null }])).toThrow("missing Pointillize parameters");
	});

	test("executes seeded fractal Clouds between exact authored foreground and background colors", () => {
		const pixels = new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat());
		const filter = (randomSeed = 123456) => ({
			index: 0,
			name: "Clouds",
			type: "clouds" as const,
			filterClassId: "Clds",
			filterId: 1131177075,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			foregroundColor: [20, 70, 220, 255] as [number, number, number, 255],
			backgroundColor: [240, 180, 30, 255] as [number, number, number, 255],
			clouds: { randomSeed },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-fractal-clouds-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 8, height: 6, pixels };
		const rendered = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(rendered.pixels).digest("hex")).toBe("47479d25c4a628cd8a3be90499ccc41c23b286347069e090520abbb5a793b766");
		expect([...applyPsdSmartFilters(source, [filter()]).pixels]).toEqual([...rendered.pixels]);
		expect(rendered.pixels[3]).toBe(0);
		expect(rendered.pixels[19 * 4 + 3]).toBe(128);
		expect([...applyPsdSmartFilters(source, [filter(-987654321)]).pixels]).not.toEqual([...rendered.pixels]);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), clouds: null }])).toThrow("missing Clouds parameters");
	});

	test("executes seeded Difference Clouds against the exact source and authored colors", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const filter = (randomSeed = 123456) => ({
			index: 0,
			name: "Difference Clouds",
			type: "differenceClouds" as const,
			filterClassId: "DfrC",
			filterId: 1147564611,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			foregroundColor: [20, 70, 220, 255] as [number, number, number, 255],
			backgroundColor: [240, 180, 30, 255] as [number, number, number, 255],
			differenceClouds: { randomSeed },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-difference-clouds-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("27d41968001d747f6896f3787dc38457f6650d112f1f18e66ec95967eaf46071");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter(123457)]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), differenceClouds: null }])).toThrow("missing Difference Clouds parameters");
	});

	test("executes seeded anisotropic Fibers between exact authored foreground and background colors", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const filter = (variance = 16, strength = 32, randomSeed = 123456) => ({
			index: 0,
			name: "Fibers",
			type: "fibers" as const,
			filterClassId: "Fbrs",
			filterId: 1180856947,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			foregroundColor: [20, 70, 220, 255] as [number, number, number, 255],
			backgroundColor: [240, 180, 30, 255] as [number, number, number, 255],
			fibers: { variance, strength, randomSeed },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-anisotropic-fibers-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("f2aac5d176b6226eb6e8e38ba2744eccf25d23db006ab5c205d688ddc2b0f3b1");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter(32)]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter(16, 48)]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter(16, 32, 123457)]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), fibers: null }])).toThrow("missing Fibers parameters");
	});

	test("executes parameterized Lens Flare with exact center, brightness, and lens profile", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const filter = (brightnessPercent = 125, position = { x: 3.5, y: 2.5 }, lensType: NonNullable<IPsdSmartFilterInfo["lensFlare"]>["lensType"] = "50-300mm zoom") => ({
			index: 0,
			name: "Lens Flare",
			type: "lensFlare" as const,
			filterClassId: "LnsF",
			filterId: 1282306886,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			lensFlare: { brightnessPercent, position, lensType },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-parameterized-lens-flare-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("937f64fee0aa6d3696724f87dc34948fac0ceebda9e0d81f93b30aef0631b8dc");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter(200)]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter(125, { x: 1.5, y: 4.5 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter(125, { x: 3.5, y: 2.5 }, "movie prime")]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), lensFlare: null }])).toThrow("missing Lens Flare parameters");
	});

	test("executes full-parameter adaptive Smart Sharpen with tonal protection", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["smartSharpen"]> = {
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
		const filter = (smartSharpen = parameters) => ({
			index: 0,
			name: "Smart Sharpen",
			type: "smartSharpen" as const,
			filterClassId: "smartSharpen",
			filterId: 698,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: smartSharpen.radius,
			smartSharpen,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-adaptive-smart-sharpen-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("1cb899ec683fd9d6d18d55c0902de6b2d7408525ac788257131c6f724cdce700");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, blur: "lensBlur" })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, blur: "motionBlur", angleDegrees: 45 })]).pixels).not.toEqual(output.pixels);
		expect(
			applyPsdSmartFilters(source, [
				filter({
					...parameters,
					shadow: { ...parameters.shadow, fadeAmountPercent: 100, tonalWidthPercent: 100 },
					highlight: { ...parameters.highlight, fadeAmountPercent: 100, tonalWidthPercent: 100 },
				}),
			]).pixels
		).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), smartSharpen: null }])).toThrow("missing Smart Sharpen parameters");
	});

	test("executes exact-parameter thresholded Gaussian Unsharp Mask", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["unsharpMask"]> = {
			amountPercent: 150,
			amountUnits: "#Prc",
			radius: 1.5,
			radiusUnits: "#Pxl",
			threshold: 5,
		};
		const filter = (unsharpMask = parameters) => ({
			index: 0,
			name: "Unsharp Mask",
			type: "unsharpMask" as const,
			filterClassId: "UnsM",
			filterId: 1433301837,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: unsharpMask.radius,
			unsharpMask,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-thresholded-gaussian-unsharp-mask-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("3062b4ba9b6f91b74b9d6a289c89afe5a5edaae0ab06991c97c26e5936afd1b5");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, amountPercent: 300 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, radius: 3 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, threshold: 255 })]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), unsharpMask: null }])).toThrow("missing Unsharp Mask parameters");
	});

	test("executes seeded four-mode Diffuse", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["diffuse"]> = { mode: "normal", randomSeed: 123456 };
		const filter = (diffuse = parameters) => ({
			index: 0,
			name: "Diffuse",
			type: "diffuse" as const,
			filterClassId: "Dfs ",
			filterId: 1147564832,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			diffuse,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-four-mode-diffuse-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("1b2c17c8f615c4968314162ddc484e99b95e4ceabd4aa2cae8950cd4e6c5a86d");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ mode: "normal", randomSeed: 654321 })]).pixels).not.toEqual(output.pixels);
		for (const mode of ["darkenOnly", "lightenOnly", "anisotropic"] as const) {
			expect(applyPsdSmartFilters(source, [filter({ ...parameters, mode })]).pixels).not.toEqual(output.pixels);
		}
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), diffuse: null }])).toThrow("missing Diffuse parameters");
	});

	test("executes exact-angle color Emboss", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["emboss"]> = { angleDegrees: 135, heightPixels: 3, amountPercent: 150 };
		const filter = (emboss = parameters) => ({
			index: 0,
			name: "Emboss",
			type: "emboss" as const,
			filterClassId: "Embs",
			filterId: 1164796531,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			emboss,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-directional-color-emboss-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("a8bd70aca4b75e32c8f2b346e10b9fd00149a8da2923d6e9a7aef0a70ff65182");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, angleDegrees: -135 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, heightPixels: 6 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, amountPercent: 300 })]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), emboss: null }])).toThrow("missing Emboss parameters");
	});

	test("executes exact six-control seeded Extrude", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["extrude"]> = {
			type: "blocks",
			sizePixels: 4,
			depth: 96,
			depthMode: "random",
			randomSeed: 123456,
			solidFrontFaces: true,
			maskIncompleteBlocks: true,
		};
		const filter = (extrude = parameters) => ({
			index: 0,
			name: "Extrude",
			type: "extrude" as const,
			filterClassId: "Extr",
			filterId: 1165522034,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			extrude,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-cell-relief-extrude-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("78e24ef911e01c6e74ba53e44ef5402f5eecbe79e721beea7f76159c5fb3f1f1");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, type: "pyramids" })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, sizePixels: 3 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, depth: 192 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, depthMode: "levelBased" })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, randomSeed: 654321 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, solidFrontFaces: false })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, maskIncompleteBlocks: false })]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), extrude: null }])).toThrow("missing Extrude parameters");
	});

	test("executes exact four-fill seeded Tiles", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["tiles"]> = {
			numberOfTiles: 4,
			maximumOffsetPercent: 35,
			fillEmptyAreaWith: "backgroundColor",
			randomSeed: 123456,
		};
		const filter = (tiles = parameters) => ({
			index: 0,
			name: "Tiles",
			type: "tiles" as const,
			filterClassId: "Tls ",
			filterId: 1416393504,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			foregroundColor: [210, 40, 90, 255] as [number, number, number, 255],
			backgroundColor: [12, 34, 56, 255] as [number, number, number, 255],
			tiles,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-seeded-offset-tiles-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("a602fd2274d09226cf6a33d9bc41ddcf45a04a601045f3166f9356c410a55f96");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, numberOfTiles: 3 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, maximumOffsetPercent: 70 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, randomSeed: 654321 })]).pixels).not.toEqual(output.pixels);
		for (const fillEmptyAreaWith of ["foregroundColor", "inverseImage", "unalteredImage"] as const) {
			expect(applyPsdSmartFilters(source, [filter({ ...parameters, fillEmptyAreaWith })]).pixels).not.toEqual(output.pixels);
		}
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), tiles: null }])).toThrow("missing Tiles parameters");
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), backgroundColor: null }])).toThrow("missing the authored Tiles background color");
		expect(() => applyPsdSmartFilters(source, [{ ...filter({ ...parameters, fillEmptyAreaWith: "foregroundColor" }), foregroundColor: null }])).toThrow(
			"missing the authored Tiles foreground color"
		);
	});

	test("executes exact per-channel threshold Trace Contour", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 3, 255 - index * 4, index * 5, index === 0 ? 0 : index === 19 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["traceContour"]> = { level: 128, edge: "lower" };
		const filter = (traceContour = parameters) => ({
			index: 0,
			name: "Trace Contour",
			type: "traceContour" as const,
			filterClassId: "TrcC",
			filterId: 1416782659,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			traceContour,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-per-channel-threshold-trace-contour-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("5b890020de5ad9aec515740eb98797cfbfe9ac61e01f7c4ce6164bfbdeaa1f05");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[19 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, level: 96 })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, edge: "upper" })]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), traceContour: null }])).toThrow("missing Trace Contour parameters");
	});

	test("executes exact three-method directional Wind", () => {
		const source = {
			width: 16,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 96 }, (_, index) => [index * 11, 255 - index * 7, index * 17, index === 0 ? 0 : index === 35 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["wind"]> = { method: "wind", direction: "right" };
		const filter = (wind = parameters) => ({
			index: 0,
			name: "Wind",
			type: "wind" as const,
			filterClassId: "Wnd ",
			filterId: 1466852384,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			wind,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-directional-horizontal-wind-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("c21054bfc470bba201058d23c6f61394882f9e31104892850598782ad7b5c91b");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[35 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, direction: "left" })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, method: "blast" })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, method: "stagger" })]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), wind: null }])).toThrow("missing Wind parameters");
	});

	test("executes exact field-selective De-Interlace reconstruction", () => {
		const source = {
			width: 8,
			height: 6,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => [index * 11, 255 - index * 7, index * 17, index === 0 ? 0 : index === 27 ? 128 : 255]).flat()),
		};
		const parameters: NonNullable<IPsdSmartFilterInfo["deInterlace"]> = { eliminate: "oddLines", newFieldsBy: "interpolation" };
		const filter = (deInterlace = parameters) => ({
			index: 0,
			name: "De-Interlace",
			type: "deInterlace" as const,
			filterClassId: "Dntr",
			filterId: 1148089458,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			deInterlace,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-field-reconstruction-de-interlace-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const output = applyPsdSmartFilters(source, [filter()]);
		expect(createHash("sha256").update(output.pixels).digest("hex")).toBe("c0183f930299a220090fb3bec0120867d8cd72dfb4360b5d3a97a26d657b3f1d");
		expect(output.pixels[3]).toBe(0);
		expect(output.pixels[27 * 4 + 3]).toBe(128);
		expect(applyPsdSmartFilters(source, [filter()]).pixels).toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, eliminate: "evenLines" })]).pixels).not.toEqual(output.pixels);
		expect(applyPsdSmartFilters(source, [filter({ ...parameters, newFieldsBy: "duplication" })]).pixels).not.toEqual(output.pixels);
		expect(() => applyPsdSmartFilters(source, [{ ...filter(), deInterlace: null }])).toThrow("missing De-Interlace parameters");
	});

	test.each([
		["Nrml", "norm", [159, 127, 95, 255]],
		["Mltp", "mul ", [52, 80, 84, 255]],
		["Scrn", "scrn", [171, 175, 204, 255]],
		["Ovrl", "over", [88, 128, 168, 255]],
		["Drkn", "dark", [64, 127, 95, 255]],
		["Lghn", "lite", [159, 128, 192, 255]],
		["CDdg", "div ", [207, 223, 239, 255]],
		["CBrn", "idiv", [16, 32, 48, 255]],
		["HrdL", "hLit", [135, 128, 119, 255]],
		["SftL", "sLit", [88, 128, 174, 255]],
		["Dfrn", "diff", [111, 33, 145, 255]],
		["Xclu", "smud", [135, 128, 168, 255]],
		["linearDodge", "lddg", [207, 223, 239, 255]],
		["linearBurn", "lbrn", [16, 32, 48, 255]],
		["blendSubtraction", "fsub", [16, 33, 145, 255]],
		["blendDivide", "fdiv", [80, 223, 239, 255]],
		["H   ", "hue ", [142, 110, 78, 255]],
		["Strt", "sat ", [64, 128, 192, 255]],
		["Clr ", "colr", [142, 110, 78, 255]],
		["Lmns", "lum ", [81, 145, 209, 255]],
	] as const)("executes smart-filter blend %s through normalized mode %s", (blendMode, normalizedBlendMode, expected) => {
		const source = { width: 1, height: 1, pixels: new Uint8Array([64, 128, 192, 255]) };
		const filter = {
			index: 0,
			name: blendMode,
			type: "invert" as const,
			filterClassId: null,
			filterId: 1231976050,
			enabled: true,
			opacity: 75,
			blendMode,
			normalizedBlendMode,
			radius: null,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-invert-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		expect([...applyPsdSmartFilters(source, [filter]).pixels]).toEqual(expected);
	});

	test("executes bounded blur and sharpen families without leaking transparent RGB", () => {
		const models = {
			blur: "bounded-blur-smart-filter-v1",
			blurMore: "bounded-blur-more-smart-filter-v1",
			boxBlur: "bounded-box-blur-smart-filter-v1",
			gaussianBlur: "bounded-gaussian-blur-smart-filter-v1",
			sharpen: "bounded-sharpen-smart-filter-v1",
			sharpenMore: "bounded-sharpen-more-smart-filter-v1",
		} as const;
		const filter = (index: number, type: keyof typeof models, radius: number | null = null) => ({
			index,
			name: type,
			type,
			filterClassId: null,
			filterId: null,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: models[type],
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		});
		const source = { width: 3, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 255, 255, 255, 0]) };
		const rendered = applyPsdSmartFilters(source, [
			filter(0, "boxBlur", 1),
			filter(1, "gaussianBlur", 0.5),
			filter(2, "blur"),
			filter(3, "blurMore"),
			filter(4, "sharpen"),
			filter(5, "sharpenMore"),
		]);
		expect(rendered.appliedFilterIndices).toEqual([0, 1, 2, 3, 4, 5]);
		expect(rendered.pixels.byteLength).toBe(source.pixels.byteLength);
		for (let offset = 0; offset < rendered.pixels.length; offset += 4) {
			if (rendered.pixels[offset + 3] === 0) expect([...rendered.pixels.slice(offset, offset + 3)]).toEqual([0, 0, 0]);
		}
	});

	test.each([
		[
			"despeckle",
			"bounded-despeckle-smart-filter-v1",
			[48, 99, 82, 255, 40, 80, 120, 255, 220, 30, 10, 255, 75, 108, 122, 241, 97, 91, 98, 213, 125, 70, 67, 184, 104, 117, 167, 227, 104, 109, 139, 170, 0, 0, 0, 0],
		],
		[
			"facet",
			"bounded-facet-smart-filter-v1",
			[84, 139, 116, 255, 84, 139, 116, 255, 110, 15, 5, 255, 84, 139, 116, 255, 84, 139, 116, 255, 110, 15, 5, 255, 113, 67, 173, 192, 113, 67, 173, 192, 0, 0, 0, 0],
		],
		[
			"fragment",
			"bounded-fragment-smart-filter-v1",
			[84, 139, 116, 255, 65, 63, 25, 255, 129, 91, 96, 255, 63, 57, 117, 223, 107, 30, 87, 191, 136, 68, 68, 160, 130, 159, 164, 223, 40, 80, 93, 191, 134, 126, 118, 160],
		],
		[
			"sharpenEdges",
			"bounded-sharpen-edges-smart-filter-v1",
			[0, 0, 0, 255, 0, 72, 184, 255, 255, 0, 0, 255, 0, 255, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 78, 0, 255, 255, 222, 122, 0, 128, 0, 0, 0, 0],
		],
		[
			"findEdges",
			"bounded-find-edges-smart-filter-v1",
			[
				105, 105, 105, 255, 155, 155, 155, 255, 197, 197, 197, 255, 151, 151, 151, 255, 192, 192, 192, 255, 121, 121, 121, 255, 153, 153, 153, 255, 200, 200, 200, 128, 0,
				0, 0, 0,
			],
		],
		[
			"solarize",
			"bounded-solarize-smart-filter-v1",
			[20, 40, 60, 255, 80, 160, 240, 255, 70, 60, 20, 255, 60, 110, 120, 255, 0, 0, 0, 255, 0, 0, 0, 255, 180, 80, 70, 255, 190, 240, 160, 128, 0, 0, 0, 0],
		],
		[
			"ntscColors",
			"bounded-ntsc-colors-smart-filter-v1",
			[16, 19, 21, 255, 40, 80, 120, 255, 209, 34, 16, 255, 30, 200, 60, 255, 235, 235, 235, 255, 16, 16, 16, 255, 90, 40, 220, 255, 160, 120, 80, 128, 0, 0, 0, 0],
		],
	] as const)("executes bounded parameter-free smart filter %s through %s", (type, algorithmExecutionModel, expected) => {
		const source = {
			width: 3,
			height: 3,
			pixels: new Uint8Array([
				10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 128, 250, 10, 180, 0,
			]),
		};
		const filter = {
			index: 0,
			name: type,
			type,
			filterClassId: null,
			filterId: null,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		expect([...applyPsdSmartFilters(source, [filter]).pixels]).toEqual(expected);
	});

	test.each([
		[
			"median",
			1,
			"bounded-median-smart-filter-v1",
			[10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 40, 120, 80, 255, 220, 10, 10, 255, 90, 40, 220, 255, 160, 120, 180, 128, 0, 0, 0, 0],
		],
		[
			"maximum",
			1,
			"bounded-maximum-smart-filter-v1",
			[
				40, 200, 120, 255, 255, 255, 255, 255, 220, 80, 120, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 160, 200, 220, 255, 255, 255, 255, 255, 250,
				120, 180, 255,
			],
		],
		[
			"minimum",
			1,
			"bounded-minimum-smart-filter-v1",
			[10, 20, 30, 255, 10, 20, 10, 255, 0, 0, 0, 255, 10, 20, 30, 255, 0, 0, 0, 128, 0, 0, 0, 0, 30, 40, 60, 128, 0, 0, 0, 0, 0, 0, 0, 0],
		],
		[
			"highPass",
			1.5,
			"bounded-high-pass-smart-filter-v1",
			[78, 79, 83, 255, 76, 143, 180, 255, 222, 106, 89, 255, 87, 245, 82, 255, 255, 255, 255, 255, 16, 68, 65, 255, 134, 87, 204, 255, 192, 167, 85, 128, 0, 0, 0, 0],
		],
	] as const)("executes parameterized smart filter %s at radius %s through %s", (type, radius, algorithmExecutionModel, expected) => {
		const source = {
			width: 3,
			height: 3,
			pixels: new Uint8Array([
				10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 128, 250, 10, 180, 0,
			]),
		};
		const filter = {
			index: 0,
			name: type,
			type,
			filterClassId: null,
			filterId: null,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		expect([...applyPsdSmartFilters(source, [filter]).pixels]).toEqual(expected);
	});

	test("rejects parameterized smart-filter plans that exceed the bounded sampling-work ceiling", () => {
		const filter = {
			index: 0,
			name: "Median 64",
			type: "median" as const,
			filterClassId: "Mdn ",
			filterId: 1298427424,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: 64,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-median-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		const source = { width: 1024, height: 1024, pixels: new Uint8Array(1024 * 1024 * 4) };
		expect(() => applyPsdSmartFilters(source, [filter])).toThrow("sample visits");
	});

	test.each([
		[
			"motionBlur",
			{ angleDegrees: 0, distance: 2, distanceUnits: "#Pxl" },
			null,
			"bounded-motion-blur-smart-filter-v1",
			[20, 40, 60, 255, 90, 43, 53, 255, 160, 47, 47, 255, 105, 218, 125, 255, 95, 152, 105, 255, 85, 85, 85, 255, 104, 56, 192, 213, 113, 67, 173, 128, 160, 120, 80, 43],
		],
		[
			"radialBlur",
			null,
			{ amount: 50, method: "spin", quality: "good" },
			"bounded-radial-blur-smart-filter-v1",
			[66, 78, 83, 255, 62, 78, 63, 255, 77, 33, 40, 215, 62, 115, 104, 232, 255, 255, 255, 255, 86, 53, 54, 194, 66, 96, 110, 187, 76, 101, 94, 179, 103, 38, 70, 164],
		],
		[
			"radialBlur",
			null,
			{ amount: 50, method: "zoom", quality: "best" },
			"bounded-radial-blur-smart-filter-v1",
			[39, 80, 69, 255, 94, 124, 154, 255, 157, 52, 47, 255, 86, 214, 109, 255, 255, 255, 255, 255, 64, 64, 64, 255, 101, 96, 182, 234, 198, 174, 150, 160, 105, 95, 85, 85],
		],
	] as const)("executes bounded %s authored parameters through %s", (type, motionBlur, radialBlur, algorithmExecutionModel, expected) => {
		const source = {
			width: 3,
			height: 3,
			pixels: new Uint8Array([
				10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 128, 250, 10, 180, 0,
			]),
		};
		const filter = {
			index: 0,
			name: type,
			type,
			filterClassId: null,
			filterId: null,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			motionBlur,
			radialBlur,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		expect([...applyPsdSmartFilters(source, [filter]).pixels]).toEqual(expected);
	});

	test("rejects excessive Motion Blur sampling work before pixel execution", () => {
		const filter = {
			index: 0,
			name: "Motion Blur 64",
			type: "motionBlur" as const,
			filterClassId: "MtnB",
			filterId: 1299476034,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			motionBlur: { angleDegrees: 0, distance: 64, distanceUnits: "#Pxl" },
			radialBlur: null,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-motion-blur-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		const source = { width: 1024, height: 1024, pixels: new Uint8Array(1024 * 1024 * 4) };
		expect(() => applyPsdSmartFilters(source, [filter])).toThrow("sample visits");
	});

	test.each([
		[
			"smartBlur",
			{ threshold: 100, quality: "low", mode: "normal" },
			null,
			"bounded-smart-blur-smart-filter-v1",
			[68, 26, 64, 255, 87, 60, 71, 230, 168, 28, 15, 204, 50, 147, 113, 255, 255, 255, 255, 255, 73, 10, 3, 255, 70, 35, 173, 204, 97, 80, 140, 153, 155, 35, 115, 102],
		],
		[
			"smartBlur",
			{ threshold: 100, quality: "high", mode: "normal" },
			null,
			"bounded-smart-blur-smart-filter-v1",
			[20, 30, 47, 255, 86, 59, 67, 253, 163, 40, 35, 247, 52, 152, 99, 239, 255, 255, 255, 255, 30, 9, 8, 255, 86, 67, 184, 230, 108, 107, 124, 132, 159, 89, 91, 43],
		],
		[
			"smartBlur",
			{ threshold: 100, quality: "medium", mode: "edgeOnly" },
			null,
			"bounded-smart-blur-smart-filter-v1",
			[140, 140, 140, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 128, 0, 0, 0, 0],
		],
		[
			"smartBlur",
			{ threshold: 100, quality: "medium", mode: "overlayEdge" },
			null,
			"bounded-smart-blur-smart-filter-v1",
			[
				145, 149, 154, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 128, 0,
				0, 0, 0,
			],
		],
		[
			"surfaceBlur",
			null,
			{ threshold: 100, radiusUnits: "#Pxl" },
			"bounded-surface-blur-smart-filter-v1",
			[45, 35, 65, 255, 80, 57, 50, 244, 128, 33, 30, 234, 64, 115, 133, 239, 255, 255, 255, 255, 100, 24, 21, 255, 77, 78, 155, 213, 89, 89, 148, 151, 157, 63, 103, 77],
		],
	] as const)("executes bounded %s edge-preserving parameters through %s", (type, smartBlur, surfaceBlur, algorithmExecutionModel, expected) => {
		const source = {
			width: 3,
			height: 3,
			pixels: new Uint8Array([
				10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 128, 250, 10, 180, 0,
			]),
		};
		const filter = {
			index: 0,
			name: type,
			type,
			filterClassId: null,
			filterId: null,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: 2,
			motionBlur: null,
			radialBlur: null,
			smartBlur,
			surfaceBlur,
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		expect([...applyPsdSmartFilters(source, [filter]).pixels]).toEqual(expected);
	});

	test("rejects excessive Smart Blur and Surface Blur neighborhood work before pixel execution", () => {
		const base = {
			index: 0,
			name: "Edge-preserving 100",
			filterClassId: null,
			filterId: null,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: 100,
			motionBlur: null,
			radialBlur: null,
			bakeSupported: true,
			warning: null,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		const source = { width: 1024, height: 1024, pixels: new Uint8Array(1024 * 1024 * 4) };
		expect(() =>
			applyPsdSmartFilters(source, [
				{
					...base,
					type: "smartBlur",
					smartBlur: { threshold: 50, quality: "high", mode: "normal" },
					surfaceBlur: null,
					algorithmExecutionModel: "bounded-smart-blur-smart-filter-v1",
				},
			])
		).toThrow("sample visits");
		expect(() =>
			applyPsdSmartFilters(source, [
				{
					...base,
					type: "surfaceBlur",
					smartBlur: null,
					surfaceBlur: { threshold: 50, radiusUnits: "#Pxl" },
					algorithmExecutionModel: "bounded-surface-blur-smart-filter-v1",
				},
			])
		).toThrow("sample visits");
	});

	test("executes the Photoshop Heart Card Shape Blur through its disclosed bounded kernel", () => {
		const source = {
			width: 3,
			height: 3,
			pixels: new Uint8Array([
				10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 128, 250, 10, 180, 0,
			]),
		};
		const filter = {
			index: 0,
			name: "Shape Blur Heart Card",
			type: "shapeBlur" as const,
			filterClassId: "shapeBlur",
			filterId: 702,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: 5,
			motionBlur: null,
			radialBlur: null,
			smartBlur: null,
			surfaceBlur: null,
			shapeBlur: { radiusUnits: "#Pxl", customShape: { name: "Heart Card", id: "e06d65dd-d132-11d5-9a4a-a011a4cb2b24" }, kernel: "heartCard" as const },
			bakeSupported: true,
			warning: null,
			algorithmExecutionModel: "bounded-heart-card-shape-blur-smart-filter-v1" as const,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		expect([...applyPsdSmartFilters(source, [filter]).pixels]).toEqual([
			82, 47, 58, 247, 100, 45, 46, 236, 119, 42, 37, 226, 80, 52, 72, 236, 96, 50, 58, 222, 112, 47, 46, 207, 82, 55, 93, 222, 94, 54, 77, 203, 107, 50, 61, 184,
		]);
		expect(() => applyPsdSmartFilters({ width: 1024, height: 1024, pixels: new Uint8Array(1024 * 1024 * 4) }, [{ ...filter, radius: 1000 }])).toThrow("sample visits");
	});

	test("executes an exact user-bound raster Shape Blur kernel and rejects missing or malformed bindings", () => {
		const source = {
			width: 3,
			height: 3,
			pixels: new Uint8Array([
				10, 20, 30, 255, 40, 80, 120, 255, 220, 30, 10, 255, 30, 200, 60, 255, 255, 255, 255, 255, 0, 0, 0, 255, 90, 40, 220, 255, 160, 120, 80, 128, 250, 10, 180, 0,
			]),
		};
		const filter = {
			index: 0,
			name: "Shape Blur Custom Plus",
			type: "shapeBlur" as const,
			filterClassId: "shapeBlur",
			filterId: 702,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: 5,
			motionBlur: null,
			radialBlur: null,
			smartBlur: null,
			surfaceBlur: null,
			shapeBlur: { radiusUnits: "#Pxl", customShape: { name: "Custom Plus", id: "custom-plus" }, kernel: null },
			bakeSupported: false,
			warning: "custom binding required",
			algorithmExecutionModel: null,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		const binding = { shapeId: "custom-plus", width: 3, height: 3, coverage: new Uint8Array([0, 255, 0, 255, 255, 255, 0, 255, 0]) };
		expect([...applyPsdSmartFilters(source, [filter], true, [binding]).pixels]).toEqual([
			78, 50, 76, 228, 94, 48, 65, 216, 113, 47, 53, 204, 78, 52, 95, 215, 92, 51, 83, 200, 109, 50, 69, 185, 78, 56, 116, 201, 90, 55, 104, 183, 104, 53, 89, 165,
		]);
		expect(() => applyPsdSmartFilters(source, [filter])).toThrow("custom binding required");
		expect(() => applyPsdSmartFilters(source, [filter], true, [{ ...binding, coverage: new Uint8Array(8) }])).toThrow("bounded exact");
		expect(() => applyPsdSmartFilters(source, [filter], true, [{ ...binding, coverage: new Uint8Array(9) }])).toThrow("empty kernel");
	});

	test("honors disabled stacks and rejects unsupported or malformed smart-filter plans", () => {
		const unsupported = {
			index: 0,
			name: "Displace",
			type: "unsupported" as const,
			filterClassId: "Dspc",
			filterId: null,
			enabled: true,
			opacity: 100,
			blendMode: "Nrml",
			normalizedBlendMode: "norm" as const,
			radius: null,
			bakeSupported: false,
			warning: "not executable",
			algorithmExecutionModel: null,
			blendExecutionModel: "bounded-smart-filter-blend-v1" as const,
			executionModel: "bounded-smart-filter-v1" as const,
		};
		const source = { width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 4]) };
		expect(applyPsdSmartFilters(source, [unsupported], false)).toMatchObject({ pixels: source.pixels, appliedFilterIndices: [] });
		expect(() => applyPsdSmartFilters(source, [unsupported])).toThrow("cannot execute");
		expect(() => applyPsdSmartFilters(source, [{ ...unsupported, index: 1 }], false)).toThrow("contiguous indices");
	});

	test("renders affine and projective quadrilaterals with bounded premultiplied bilinear sampling", () => {
		const source = {
			width: 2,
			height: 2,
			pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 0]),
		};
		const affine = renderPsdSmartObjectPlacement(source, [10, 20, 12, 20, 12, 22, 10, 22], 16);
		expect(affine).toMatchObject({ left: 10, top: 20, width: 2, height: 2, sampling: "premultiplied-bilinear", executionModel: "bounded-projective-smart-object-v1" });
		expect([...affine.pixels]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);

		const projective = renderPsdSmartObjectPlacement(source, [0, 0, 3, 0, 2, 2, 0, 2], 16);
		expect(projective).toMatchObject({ left: 0, top: 0, width: 3, height: 2 });
		expect(projective.pixels.some((value) => value !== 0)).toBe(true);
		expect(projective.pixels.slice(20, 24)).toEqual(new Uint8Array(4));
	});

	test("rejects degenerate or oversized placement output before allocation", () => {
		const source = { width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]) };
		expect(() => renderPsdSmartObjectPlacement(source, [0, 0, 1, 0, 2, 0, 3, 0])).toThrow("degenerate");
		expect(() => renderPsdSmartObjectPlacement(source, [0, 0, 10, 0, 10, 10, 0, 10], 99)).toThrow("10x10");
	});

	test("renders every standard analytical smart-object warp preset with authored strength", () => {
		const source = {
			width: 4,
			height: 3,
			pixels: new Uint8Array(Array.from({ length: 48 }, (_, index) => (index % 4 === 3 ? 255 : (index * 37) % 256))),
		};
		for (const style of PSD_SMART_OBJECT_PRESET_WARP_STYLES) {
			const rendered = renderPsdSmartObjectPresetWarpPlacement(
				source,
				[10, 20, 18, 20, 18, 26, 10, 26],
				{ style, value: 60, perspective: 12, perspectiveOther: -8, rotate: "horizontal" },
				256
			);
			expect(rendered).toMatchObject({
				style,
				value: 60,
				perspective: 12,
				perspectiveOther: -8,
				rotate: "horizontal",
				tessellation: 64,
				sampling: "premultiplied-bilinear",
				executionModel: "bounded-analytical-preset-smart-object-warp-v1",
			});
			expect(rendered.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		}
	});

	test("applies preset orientation and both perspective controls and rejects malformed plans", () => {
		const source = { width: 3, height: 2, pixels: new Uint8Array(24).fill(255) };
		const corners: [number, number, number, number, number, number, number, number] = [0, 0, 9, 0, 9, 6, 0, 6];
		const horizontal = renderPsdSmartObjectPresetWarpPlacement(source, corners, {
			style: "warpFlag",
			value: 70,
			perspective: 20,
			perspectiveOther: -15,
			rotate: "horizontal",
		});
		const vertical = renderPsdSmartObjectPresetWarpPlacement(source, corners, {
			style: "warpFlag",
			value: 70,
			perspective: 20,
			perspectiveOther: -15,
			rotate: "vertical",
		});
		expect([horizontal.left, horizontal.top, horizontal.width, horizontal.height]).not.toEqual([vertical.left, vertical.top, vertical.width, vertical.height]);
		expect(() =>
			renderPsdSmartObjectPresetWarpPlacement(source, corners, { style: "warpUnknown" as "warpArc", value: 1, perspective: 0, perspectiveOther: 0, rotate: "horizontal" })
		).toThrow("unsupported");
		expect(() => renderPsdSmartObjectPresetWarpPlacement(source, corners, { style: "warpArc", value: 101, perspective: 0, perspectiveOther: 0, rotate: "horizontal" })).toThrow(
			"-100 through 100"
		);
		expect(() =>
			renderPsdSmartObjectPresetWarpPlacement(source, [0, 0, 0, 0, 0, 0, 0, 0], {
				style: "warpArc",
				value: 50,
				perspective: 0,
				perspectiveOther: 0,
				rotate: "horizontal",
			})
		).toThrow("degenerate");
	});

	test("renders a bounded tensor-product Bezier custom envelope through authored placement", () => {
		const source = {
			width: 2,
			height: 2,
			pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]),
		};
		const meshPoints = Array.from({ length: 16 }, (_, index) => {
			const column = index % 4;
			const row = Math.floor(index / 4);
			return { x: (column * 2) / 3 + (column === 2 && row === 1 ? 0.35 : 0), y: (row * 2) / 3 + (column === 1 && row === 2 ? -0.25 : 0) };
		});
		const rendered = renderPsdSmartObjectWarpPlacement(source, [5, 7, 9, 7, 9, 11, 5, 11], meshPoints, 4, 4, 64);
		expect(rendered).toMatchObject({
			left: 5,
			top: 7,
			width: 4,
			height: 4,
			uOrder: 4,
			vOrder: 4,
			meshPointCount: 16,
			tessellation: 32,
			sampling: "premultiplied-bilinear",
			executionModel: "bounded-bezier-smart-object-warp-v1",
		});
		expect(rendered.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
	});

	test("rejects malformed, degenerate, and oversized custom warp plans", () => {
		const source = { width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 255]) };
		expect(() => renderPsdSmartObjectWarpPlacement(source, [0, 0, 2, 0, 2, 2, 0, 2], [{ x: 0, y: 0 }], 2, 2)).toThrow("control-point grid");
		const grid = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 0, y: 1 },
			{ x: 1, y: 1 },
		];
		expect(() => renderPsdSmartObjectWarpPlacement(source, [0, 0, 0, 0, 0, 0, 0, 0], grid, 2, 2)).toThrow("degenerate");
		expect(() => renderPsdSmartObjectWarpPlacement(source, [0, 0, 10, 0, 10, 10, 0, 10], grid, 2, 2, 99)).toThrow("10x10");
	});

	test("renders an exact bounded piecewise-Bezier quilt envelope with authored slice boundaries", () => {
		const source = {
			width: 2,
			height: 2,
			pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]),
		};
		const meshPoints = Array.from({ length: 49 }, (_, index) => {
			const column = index % 7;
			const row = Math.floor(index / 7);
			return { x: column / 3 + (column === 4 && row === 2 ? 0.2 : 0), y: row / 3 + (column === 2 && row === 4 ? -0.15 : 0) };
		});
		const rendered = renderPsdSmartObjectQuiltWarpPlacement(
			source,
			[5, 7, 9, 7, 9, 11, 5, 11],
			{ meshPoints, uOrder: 4, vOrder: 4, deformNumRows: 2, deformNumCols: 2, quiltSliceX: [0, 1, 2], quiltSliceY: [0, 1, 2] },
			64
		);
		expect(rendered).toMatchObject({
			left: 5,
			top: 7,
			width: 4,
			height: 4,
			uOrder: 4,
			vOrder: 4,
			deformNumRows: 2,
			deformNumCols: 2,
			meshPointCount: 49,
			quiltSliceX: [0, 1, 2],
			quiltSliceY: [0, 1, 2],
			tessellation: 28,
			executionModel: "bounded-piecewise-bezier-smart-object-quilt-warp-v1",
		});
		expect(rendered.pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
	});

	test("rejects malformed quilt lattices, slices, placement, and output bounds", () => {
		const source = { width: 2, height: 2, pixels: new Uint8Array(16).fill(255) };
		const grid = Array.from({ length: 49 }, (_, index) => ({ x: (index % 7) / 3, y: Math.floor(index / 7) / 3 }));
		const options = { meshPoints: grid, uOrder: 4, vOrder: 4, deformNumRows: 2, deformNumCols: 2, quiltSliceX: [] as number[], quiltSliceY: [] as number[] };
		expect(() => renderPsdSmartObjectQuiltWarpPlacement(source, [0, 0, 2, 0, 2, 2, 0, 2], { ...options, meshPoints: grid.slice(1) })).toThrow("control lattice");
		expect(() => renderPsdSmartObjectQuiltWarpPlacement(source, [0, 0, 2, 0, 2, 2, 0, 2], { ...options, quiltSliceX: [0, 1.5, 1], quiltSliceY: [0, 1, 2] })).toThrow(
			"horizontal slices"
		);
		expect(() => renderPsdSmartObjectQuiltWarpPlacement(source, [0, 0, 0, 0, 0, 0, 0, 0], options)).toThrow("degenerate");
		expect(() => renderPsdSmartObjectQuiltWarpPlacement(source, [0, 0, 10, 0, 10, 10, 0, 10], options, 99)).toThrow("bounded 99-pixel");
	});
});
