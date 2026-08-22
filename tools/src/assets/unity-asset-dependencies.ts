import { parseAllDocuments, parseDocument } from "yaml";

import { HumanoidBodyPart, defaultHumanoidBodyParts } from "./humanoid-avatar";

export interface IUnityAssetMetaSubAsset {
	fileId: string;
	name: string;
}

export interface IUnityAssetMeta {
	guid: string;
	subAssets: IUnityAssetMetaSubAsset[];
}

export interface IUnityAvatarMaskAsset {
	fileId: string;
	name: string;
	bodyParts: Record<HumanoidBodyPart, boolean>;
	transformNames: string[];
	disabledTransformNames: string[];
	ignoredIkBodyParts: Array<{ name: string; active: boolean }>;
}

const UNITY_GUID_PATTERN = /^[0-9a-f]{32}$/;
const UNITY_AVATAR_MASK_BODY_PART_COUNT = 13;
const UNITY_AVATAR_MASK_HEX_LENGTH = UNITY_AVATAR_MASK_BODY_PART_COUNT * 8;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function finiteNumber(value: unknown): number | null {
	const result = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(result) ? result : null;
}

function visitMetaSubAssets(value: unknown, result: Map<string, string>): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			visitMetaSubAssets(item, result);
		}
		return;
	}
	const valueRecord = record(value);
	if (!valueRecord) {
		return;
	}
	const table = valueRecord.internalIDToNameTable;
	if (Array.isArray(table)) {
		for (const item of table) {
			const itemRecord = record(item);
			const first = record(itemRecord?.first);
			const second = text(itemRecord?.second).trim();
			if (!first || !second) {
				continue;
			}
			for (const [classId, fileIdValue] of Object.entries(first)) {
				const fileId = text(fileIdValue).trim();
				if (classId === "74" && /^-?\d+$/.test(fileId)) {
					const previous = result.get(fileId);
					if (previous && previous !== second) {
						throw new Error(`Unity meta fileID ${fileId} maps to both "${previous}" and "${second}".`);
					}
					result.set(fileId, second.slice(0, 512));
				}
			}
		}
	}
	for (const child of Object.values(valueRecord)) {
		visitMetaSubAssets(child, result);
	}
}

/** Parses one Unity .meta identity and its exact AnimationClip fileID/name table without accepting duplicate GUID declarations. */
export function parseUnityAssetMeta(source: string): IUnityAssetMeta {
	if (Buffer.byteLength(source, "utf-8") > 1024 * 1024) {
		throw new Error("Unity .meta files are limited to 1 MiB for dependency indexing.");
	}
	const declarations = [...source.matchAll(/^guid:\s*([0-9a-fA-F]+)\s*$/gm)].map((match) => match[1].toLowerCase());
	if (declarations.length !== 1 || !UNITY_GUID_PATTERN.test(declarations[0]) || /^0+$/.test(declarations[0])) {
		throw new Error("Unity .meta files must contain exactly one non-zero 32-character hexadecimal guid declaration.");
	}
	const document = parseDocument(source, { logLevel: "silent", prettyErrors: true, schema: "failsafe" });
	if (document.errors.length) {
		throw new Error(`Unity .meta YAML is malformed: ${document.errors[0].message}`);
	}
	const subAssets = new Map<string, string>();
	visitMetaSubAssets(document.toJS({ maxAliasCount: 0 }), subAssets);
	return {
		guid: declarations[0],
		subAssets: [...subAssets].map(([fileId, name]) => ({ fileId, name })).sort((left, right) => left.fileId.localeCompare(right.fileId)),
	};
}

function decodeUnityAvatarMaskBits(value: unknown): boolean[] {
	const encoded = text(value).trim().toLowerCase();
	if (!new RegExp(`^[0-9a-f]{${UNITY_AVATAR_MASK_HEX_LENGTH}}$`).test(encoded)) {
		throw new Error(`Unity AvatarMask m_Mask must contain exactly ${UNITY_AVATAR_MASK_BODY_PART_COUNT} little-endian UInt32 values.`);
	}
	const bytes = Buffer.from(encoded, "hex");
	return Array.from({ length: UNITY_AVATAR_MASK_BODY_PART_COUNT }, (_, index) => bytes.readUInt32LE(index * 4) !== 0);
}

/** Converts one Unity class-319 AvatarMask YAML asset into the editor's humanoid body-part and transform contract. */
export function parseUnityAvatarMaskAsset(source: string): IUnityAvatarMaskAsset {
	if (Buffer.byteLength(source, "utf-8") > 8 * 1024 * 1024) {
		throw new Error("Unity AvatarMask assets are limited to 8 MiB.");
	}
	const headers = [...source.matchAll(/^---\s+!u!(\d+)\s+&(-?\d+)\s*$/gm)].map((match) => ({ classId: Number(match[1]), fileId: match[2] }));
	const documents = parseAllDocuments(source, { logLevel: "silent", prettyErrors: true, schema: "failsafe" });
	if (headers.length !== 1 || documents.length !== 1 || headers[0].classId !== 319) {
		throw new Error("Unity AvatarMask YAML must contain exactly one !u!319 serialized object.");
	}
	if (documents[0].errors.length) {
		throw new Error(`Unity AvatarMask YAML is malformed: ${documents[0].errors[0].message}`);
	}
	const root = record(documents[0].toJS({ maxAliasCount: 0 }));
	const mask = record(root?.AvatarMask);
	if (!mask) {
		throw new Error("Unity class-319 YAML does not contain an AvatarMask mapping.");
	}
	const name = text(mask.m_Name).trim();
	if (!name || name.length > 256) {
		throw new Error("Unity AvatarMask names must contain 1 through 256 characters.");
	}
	const bits = decodeUnityAvatarMaskBits(mask.m_Mask);
	const bodyParts = defaultHumanoidBodyParts(false);
	const mappings: Array<[number, HumanoidBodyPart]> = [
		[0, "root"],
		[1, "body"],
		[2, "head"],
		[3, "leftLeg"],
		[4, "rightLeg"],
		[5, "leftArm"],
		[6, "rightArm"],
		[7, "leftHand"],
		[8, "rightHand"],
	];
	for (const [index, part] of mappings) {
		bodyParts[part] = bits[index];
	}
	const elements = Array.isArray(mask.m_Elements) ? mask.m_Elements : [];
	if (elements.length > 4096) {
		throw new Error("Unity AvatarMask assets support at most 4096 transform elements.");
	}
	const enabled = new Set<string>();
	const disabled = new Set<string>();
	for (const [index, value] of elements.entries()) {
		const element = record(value);
		const path = text(element?.m_Path).trim();
		const weight = finiteNumber(element?.m_Weight);
		if (!element || path.length > 512 || weight === null || weight < 0 || weight > 1) {
			throw new Error(`Unity AvatarMask transform element ${index} requires a path up to 512 characters and a finite 0..1 weight.`);
		}
		if (!path) {
			continue;
		}
		(weight > 0.5 ? enabled : disabled).add(path);
	}
	return {
		fileId: headers[0].fileId,
		name,
		bodyParts,
		transformNames: [...enabled].sort(),
		disabledTransformNames: [...disabled].sort(),
		ignoredIkBodyParts: [
			{ name: "LeftFootIK", active: bits[9] },
			{ name: "RightFootIK", active: bits[10] },
			{ name: "LeftHandIK", active: bits[11] },
			{ name: "RightHandIK", active: bits[12] },
		],
	};
}
