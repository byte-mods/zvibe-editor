import { basenamePortablePath as basename, extnamePortablePath as extname } from "./portable-path";

import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationKeyInterpolation } from "@babylonjs/core/Animations/animationKey";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { parseAllDocuments } from "yaml";

import {
	IUnityAnimationObjectReferenceCurve,
	UNITY_ANIMATION_ACTIVE_STATE_PROPERTY,
	UNITY_ANIMATION_CLIP_METADATA_KEY,
	UNITY_ANIMATION_OBJECT_REFERENCE_PROPERTY_PREFIX,
} from "../loading/unity-animation-clip-runtime";

export interface IUnityAnimationClipConversion {
	document: Record<string, unknown>;
	name: string;
	framesPerSecond: number;
	curveCount: number;
	keyCount: number;
	eventCount: number;
	activeStateCurveCount: number;
	compressedRotationCurveCount: number;
	objectReferenceCurves: IUnityAnimationObjectReferenceCurve[];
	loop: boolean;
	preservedFeatures: string[];
	approximatedFeatures: string[];
	unsupportedFeatures: string[];
	errors: string[];
	warnings: string[];
}

interface IUnityCurveDefinition {
	target: string;
	property: string;
	dataType: number;
	curve: Record<string, unknown>;
	valueScale: number;
	discrete?: boolean;
	compressedRotation?: boolean;
}

const MAX_CURVES = 8192;
const MAX_KEYS = 2_000_000;
const MAX_PACKED_BYTES = 64 * 1024 * 1024;
const MAX_OBJECT_REFERENCE_CURVES = 512;
const MAX_OBJECT_REFERENCE_KEYS_PER_CURVE = 8192;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function entries(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
}

function numberValue(value: unknown, fallback = Number.NaN): number {
	const converted = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(converted) ? converted : fallback;
}

function textValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
}

function booleanValue(value: unknown): boolean {
	return value === true || value === 1 || value === "1" || value === "true";
}

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => character.charCodeAt(0) < 32);
}

function vector3(value: unknown, scale = 1): Vector3 {
	const source = record(value);
	if (!source) {
		throw new Error("Unity vector curve keys require x/y/z values.");
	}
	const components = [numberValue(source.x), numberValue(source.y), numberValue(source.z)];
	if (components.some((component) => !Number.isFinite(component))) {
		throw new Error("Unity vector curve keys require finite x/y/z values.");
	}
	return new Vector3(components[0] * scale, components[1] * scale, components[2] * scale);
}

function quaternion(value: unknown): Quaternion {
	const source = record(value);
	if (!source) {
		throw new Error("Unity rotation curve keys require x/y/z/w values.");
	}
	const components = [numberValue(source.x), numberValue(source.y), numberValue(source.z), numberValue(source.w)];
	if (components.some((component) => !Number.isFinite(component))) {
		throw new Error("Unity rotation curve keys require finite x/y/z/w values.");
	}
	const result = new Quaternion(components[0], components[1], components[2], components[3]);
	if (result.lengthSquared() <= Number.EPSILON) {
		throw new Error("Unity rotation curve keys cannot contain a zero-length quaternion.");
	}
	return result.normalize();
}

function scaledValue(value: unknown, dataType: number, scale: number): number | Vector3 | Quaternion {
	if (dataType === Animation.ANIMATIONTYPE_FLOAT) {
		const result = numberValue(value) * scale;
		if (!Number.isFinite(result)) {
			throw new Error("Unity float curve keys require finite values.");
		}
		return result;
	}
	if (dataType === Animation.ANIMATIONTYPE_VECTOR3) {
		return vector3(value, scale);
	}
	return quaternion(value);
}

function scaledTangent(value: unknown, dataType: number, valueScale: number, framesPerSecond: number): number | Vector3 | Quaternion | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	const perFrameScale = valueScale / framesPerSecond;
	if (dataType === Animation.ANIMATIONTYPE_QUATERNION) {
		const source = record(value);
		if (!source) {
			throw new Error("Unity quaternion tangents require x/y/z/w values.");
		}
		const components = [numberValue(source.x), numberValue(source.y), numberValue(source.z), numberValue(source.w)];
		if (components.some((component) => !Number.isFinite(component))) {
			throw new Error("Unity quaternion tangents require finite x/y/z/w values.");
		}
		return new Quaternion(...(components.map((component) => component / framesPerSecond) as [number, number, number, number]));
	}
	return scaledValue(value, dataType, perFrameScale);
}

function multiplyTangent(value: number | Vector3 | Quaternion | undefined, amount: number): number | Vector3 | Quaternion | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "number") {
		return value * amount;
	}
	return value.scale(amount);
}

function componentValues(value: number | Vector3 | Quaternion | undefined): number[] {
	if (value === undefined) {
		return [];
	}
	return typeof value === "number" ? [value] : value.asArray();
}

function stableToken(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

function packedBytes(value: unknown, label: string): Uint8Array {
	if (typeof value === "string") {
		const compact = value.replace(/\s+/g, "");
		if (compact.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(compact)) {
			throw new Error(`${label} m_Data must be an even-length hexadecimal byte string.`);
		}
		if (compact.length / 2 > MAX_PACKED_BYTES) {
			throw new Error(`${label} m_Data exceeds the ${MAX_PACKED_BYTES.toLocaleString()}-byte limit.`);
		}
		return Uint8Array.from({ length: compact.length / 2 }, (_, index) => Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16));
	}
	if (Array.isArray(value)) {
		if (value.length > MAX_PACKED_BYTES || value.some((entry) => !Number.isInteger(entry) || Number(entry) < 0 || Number(entry) > 255)) {
			throw new Error(`${label} m_Data must contain at most ${MAX_PACKED_BYTES.toLocaleString()} byte values from 0 through 255.`);
		}
		return Uint8Array.from(value as number[]);
	}
	throw new Error(`${label} m_Data must be a hexadecimal string or byte array.`);
}

function packedItemCount(source: Record<string, unknown>, label: string): number {
	const count = numberValue(source.m_NumItems);
	if (!Number.isInteger(count) || count < 0 || count > MAX_KEYS * 4) {
		throw new Error(`${label} m_NumItems must be an integer from 0 through ${(MAX_KEYS * 4).toLocaleString()}.`);
	}
	return count;
}

function readPackedUnsigned(data: Uint8Array, bitSize: number, count: number, label: string): number[] {
	if (!Number.isInteger(bitSize) || bitSize < 1 || bitSize > 32) {
		throw new Error(`${label} m_BitSize must be an integer from 1 through 32.`);
	}
	const requiredBytes = Math.ceil((bitSize * count) / 8);
	if (data.length < requiredBytes || data.length > requiredBytes + 3) {
		throw new Error(`${label} m_Data byte length ${data.length} does not match ${count} packed ${bitSize}-bit item(s).`);
	}
	const output: number[] = [];
	let bitOffset = 0;
	for (let item = 0; item < count; item++) {
		let value = 0;
		for (let bit = 0; bit < bitSize; bit++, bitOffset++) {
			value += ((data[Math.floor(bitOffset / 8)] >> (bitOffset % 8)) & 1) * 2 ** bit;
		}
		output.push(value);
	}
	return output;
}

function unpackPackedInts(value: unknown, label: string): number[] {
	const source = record(value);
	if (!source) {
		throw new Error(`${label} must be a packed integer object.`);
	}
	const count = packedItemCount(source, label);
	if (count === 0) {
		return [];
	}
	return readPackedUnsigned(packedBytes(source.m_Data, label), numberValue(source.m_BitSize), count, label);
}

function unpackPackedQuaternions(value: unknown, label: string): Quaternion[] {
	const source = record(value);
	if (!source) {
		throw new Error(`${label} must be a packed quaternion object.`);
	}
	const count = packedItemCount(source, label);
	const data = packedBytes(source.m_Data, label);
	const raw = count ? readPackedUnsigned(data, 32, count, label) : [];
	return raw.map((packed, index) => {
		const flags = packed % 8;
		let bitOffset = 3;
		const components = [0, 0, 0, 0];
		let sum = 0;
		const omitted = flags & 3;
		for (let component = 0; component < 4; component++) {
			if (component === omitted) {
				continue;
			}
			const bitSize = (omitted + 1) % 4 === component ? 9 : 10;
			const mask = 2 ** bitSize - 1;
			const quantized = Math.floor(packed / 2 ** bitOffset) % 2 ** bitSize;
			const decoded = quantized / (0.5 * mask) - 1;
			components[component] = decoded;
			sum += decoded * decoded;
			bitOffset += bitSize;
		}
		if (sum > 1 + 1e-5) {
			throw new Error(`${label} quaternion ${index} reconstructs with component sum ${sum}, above one.`);
		}
		components[omitted] = Math.sqrt(Math.max(0, 1 - sum)) * (flags & 4 ? -1 : 1);
		return new Quaternion(components[0], components[1], components[2], components[3]).normalize();
	});
}

function unpackPackedFloats(value: unknown, label: string): number[] {
	const source = record(value);
	if (!source) {
		throw new Error(`${label} must be a packed float object.`);
	}
	const count = packedItemCount(source, label);
	if (count === 0) {
		return [];
	}
	const bitSize = numberValue(source.m_BitSize);
	const range = numberValue(source.m_Range);
	const start = numberValue(source.m_Start);
	if (!Number.isInteger(bitSize) || bitSize < 1 || bitSize > 30 || !Number.isFinite(range) || range < 0 || !Number.isFinite(start)) {
		throw new Error(`${label} requires m_BitSize 1–30 plus finite non-negative m_Range and finite m_Start.`);
	}
	const mask = 2 ** bitSize - 1;
	return readPackedUnsigned(packedBytes(source.m_Data, label), bitSize, count, label).map((entry) => (entry * range) / mask + start);
}

function compressedRotationCurve(entry: Record<string, unknown>, index: number): Record<string, unknown> {
	const label = `Unity compressed rotation curve ${index}`;
	const deltas = unpackPackedInts(entry.m_Times, `${label} times`);
	const values = unpackPackedQuaternions(entry.m_Values, `${label} values`);
	const slopes = unpackPackedFloats(entry.m_Slopes, `${label} slopes`);
	if (!deltas.length) {
		throw new Error(`${label} contains no keys.`);
	}
	if (values.length !== deltas.length) {
		throw new Error(`${label} contains ${deltas.length} time item(s) but ${values.length} quaternion value(s).`);
	}
	if (slopes.length !== 0 && slopes.length !== deltas.length * 4) {
		throw new Error(`${label} slopes must be empty or contain four components per quaternion key.`);
	}
	let centiseconds = 0;
	const keys = deltas.map((delta, keyIndex) => {
		centiseconds += delta;
		const slope = slopes.length ? new Quaternion(slopes[keyIndex * 4], slopes[keyIndex * 4 + 1], slopes[keyIndex * 4 + 2], slopes[keyIndex * 4 + 3]) : undefined;
		return {
			time: centiseconds * 0.01,
			value: values[keyIndex],
			...(slope ? { inSlope: slope, outSlope: slope } : {}),
		};
	});
	return { m_Curve: keys };
}

function objectReference(value: unknown, label: string): { key: string; fileId: string; guid: string | null; type: number } {
	const source = record(value);
	if (!source) {
		throw new Error(`${label} must contain one Unity object reference.`);
	}
	const fileId = textValue(source.fileID).trim();
	const guid = textValue(source.guid).trim().toLowerCase();
	const type = numberValue(source.type, 0);
	if (!/^-?\d+$/.test(fileId) || fileId.length > 32) {
		throw new Error(`${label} fileID must be a signed decimal integer with at most 32 characters.`);
	}
	if (guid && !/^[0-9a-f]{32}$/.test(guid)) {
		throw new Error(`${label} guid must be empty or exactly 32 lowercase hexadecimal characters.`);
	}
	if (!Number.isInteger(type) || type < 0 || type > 255) {
		throw new Error(`${label} type must be an integer from 0 through 255.`);
	}
	return { key: `${guid || "local"}:${fileId}:${type}`, fileId, guid: guid || null, type };
}

function floatCurveProperty(attribute: string): { property: string; valueScale: number; targetSuffix?: string; unsupported?: string; discrete?: boolean } {
	const mappings: Record<string, { property: string; valueScale: number }> = {
		"m_LocalPosition.x": { property: "position.x", valueScale: 1 },
		"m_LocalPosition.y": { property: "position.y", valueScale: 1 },
		"m_LocalPosition.z": { property: "position.z", valueScale: 1 },
		"m_LocalRotation.x": { property: "rotationQuaternion.x", valueScale: 1 },
		"m_LocalRotation.y": { property: "rotationQuaternion.y", valueScale: 1 },
		"m_LocalRotation.z": { property: "rotationQuaternion.z", valueScale: 1 },
		"m_LocalRotation.w": { property: "rotationQuaternion.w", valueScale: 1 },
		"m_LocalScale.x": { property: "scaling.x", valueScale: 1 },
		"m_LocalScale.y": { property: "scaling.y", valueScale: 1 },
		"m_LocalScale.z": { property: "scaling.z", valueScale: 1 },
		"localEulerAnglesRaw.x": { property: "rotation.x", valueScale: Math.PI / 180 },
		"localEulerAnglesRaw.y": { property: "rotation.y", valueScale: Math.PI / 180 },
		"localEulerAnglesRaw.z": { property: "rotation.z", valueScale: Math.PI / 180 },
	};
	if (attribute === "m_IsActive") {
		return { property: UNITY_ANIMATION_ACTIVE_STATE_PROPERTY, valueScale: 1, discrete: true };
	}
	if (attribute.startsWith("blendShape.")) {
		const name = attribute.slice("blendShape.".length).trim();
		return name
			? { property: "influence", valueScale: 0.01, targetSuffix: `#blendShape:${name}` }
			: { property: attribute, valueScale: 1, unsupported: "Blend-shape curves require a non-empty target name." };
	}
	return mappings[attribute] ?? { property: attribute, valueScale: 1 };
}

function safeTargetPath(value: unknown): string {
	const target = textValue(value).trim() || "$root";
	if (target.length > 512 || hasControlCharacters(target)) {
		throw new Error("Unity curve target paths must be at most 512 characters and contain no control characters.");
	}
	return target;
}

function safePropertyPath(value: string): string {
	if (!value || value.length > 512 || hasControlCharacters(value) || value.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
		throw new Error("Unity float-curve property paths must be non-empty, safe, and at most 512 characters.");
	}
	return value;
}

function unityAnimationClipDocument(source: string): Record<string, unknown> {
	const documents = parseAllDocuments(source, { logLevel: "silent", prettyErrors: true, schema: "failsafe" });
	if (documents.length !== 1) {
		throw new Error("Unity .anim assets must contain exactly one serialized AnimationClip object.");
	}
	if (documents[0].errors.length) {
		throw new Error(`Unity AnimationClip YAML is malformed: ${documents[0].errors[0].message}`);
	}
	const root = record(documents[0].toJS({ maxAliasCount: 0 }));
	const clip = record(root?.AnimationClip);
	if (!clip) {
		throw new Error("Unity .anim YAML does not contain an AnimationClip object.");
	}
	return clip;
}

/** Converts a bounded Unity YAML AnimationClip into a serialized Babylon AnimationGroup with explicit conversion evidence. */
export function convertUnityAnimationClip(source: string, sourcePath: string): IUnityAnimationClipConversion {
	const clip = unityAnimationClipDocument(source);
	const errors: string[] = [];
	const warnings: string[] = [];
	const unsupported = new Set<string>();
	const approximated = new Set<string>();
	const preserved = new Set<string>();
	const name = textValue(clip.m_Name).trim() || basename(sourcePath, extname(sourcePath)) || "Unity Animation Clip";
	const framesPerSecond = numberValue(clip.m_SampleRate, 60);
	if (!Number.isFinite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 1000) {
		errors.push("Unity AnimationClip sample rate must be between 1 and 1000 FPS.");
	}
	const effectiveFramesPerSecond = errors.length ? 60 : framesPerSecond;
	const settings = record(clip.m_AnimationClipSettings);
	const loop = booleanValue(settings?.m_LoopTime);
	const curves: IUnityCurveDefinition[] = [];
	const objectReferenceCurves: IUnityAnimationObjectReferenceCurve[] = [];
	const tangentModes: Record<string, unknown>[] = [];
	const targetedAnimations: Record<string, unknown>[] = [];
	let keyCount = 0;
	let activeStateCurveCount = 0;
	let compressedRotationCurveCount = 0;
	const append = (sourceKey: string, property: string, dataType: number, valueScale = 1): void => {
		for (const entry of entries(clip[sourceKey])) {
			const curve = record(entry.curve);
			if (!curve) {
				errors.push(`${sourceKey} contains an entry without a curve object.`);
				continue;
			}
			try {
				curves.push({ target: safeTargetPath(entry.path), property, dataType, curve, valueScale });
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
	};
	append("m_PositionCurves", "position", Animation.ANIMATIONTYPE_VECTOR3);
	append("m_RotationCurves", "rotationQuaternion", Animation.ANIMATIONTYPE_QUATERNION);
	for (const [index, entry] of entries(clip.m_CompressedRotationCurves).entries()) {
		try {
			curves.push({
				target: safeTargetPath(entry.m_Path ?? entry.path),
				property: "rotationQuaternion",
				dataType: Animation.ANIMATIONTYPE_QUATERNION,
				curve: compressedRotationCurve(entry, index),
				valueScale: 1,
				compressedRotation: true,
			});
			compressedRotationCurveCount++;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	append("m_EulerCurves", "rotation", Animation.ANIMATIONTYPE_VECTOR3, Math.PI / 180);
	append("m_ScaleCurves", "scaling", Animation.ANIMATIONTYPE_VECTOR3);
	for (const entry of entries(clip.m_FloatCurves)) {
		const curve = record(entry.curve);
		const attribute = textValue(entry.attribute).trim();
		if (!curve || !attribute) {
			errors.push("Unity float curves require a curve object and non-empty attribute.");
			continue;
		}
		const mapped = floatCurveProperty(attribute);
		if (mapped.unsupported) {
			unsupported.add(mapped.unsupported);
			continue;
		}
		try {
			const target = `${safeTargetPath(entry.path)}${mapped.targetSuffix ?? ""}`;
			if (target.length > 512) {
				throw new Error("Unity curve target identities must be at most 512 characters after blend-shape qualification.");
			}
			curves.push({
				target,
				property: safePropertyPath(mapped.property),
				dataType: Animation.ANIMATIONTYPE_FLOAT,
				curve,
				valueScale: mapped.valueScale,
				discrete: mapped.discrete,
			});
			if (mapped.discrete) {
				activeStateCurveCount++;
			}
			if (mapped.targetSuffix) {
				preserved.add("Unity blend-shape percentages are converted to Babylon MorphTarget influence values with explicit target identities.");
			}
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (curves.length > MAX_CURVES) {
		errors.push(`Unity AnimationClips are limited to ${MAX_CURVES.toLocaleString()} curves.`);
	}
	const objectReferenceEntries = entries(clip.m_PPtrCurves);
	if (objectReferenceEntries.length > MAX_OBJECT_REFERENCE_CURVES) {
		errors.push(`Unity AnimationClips are limited to ${MAX_OBJECT_REFERENCE_CURVES} object-reference curves.`);
	}
	for (const [curveIndex, entry] of objectReferenceEntries.slice(0, MAX_OBJECT_REFERENCE_CURVES).entries()) {
		const sourceKeys = entries(entry.curve);
		const attribute = textValue(entry.attribute).trim();
		if (!sourceKeys.length) {
			warnings.push(`Unity object-reference curve ${curveIndex}${attribute ? ` (${attribute})` : ""} is empty and was ignored.`);
			continue;
		}
		try {
			if (sourceKeys.length > MAX_OBJECT_REFERENCE_KEYS_PER_CURVE) {
				throw new Error(`Unity object-reference curve ${curveIndex} is limited to ${MAX_OBJECT_REFERENCE_KEYS_PER_CURVE.toLocaleString()} keys.`);
			}
			if (!attribute) {
				throw new Error(`Unity object-reference curve ${curveIndex} requires a non-empty attribute.`);
			}
			const target = safeTargetPath(entry.path);
			const id = `pptr-${stableToken(`${sourcePath}\0${curveIndex}\0${target}\0${attribute}`)}-${curveIndex}`;
			const trackProperty = `${UNITY_ANIMATION_OBJECT_REFERENCE_PROPERTY_PREFIX}${stableToken(id)}`;
			const references: ReturnType<typeof objectReference>[] = [];
			const referenceIndexes = new Map<string, number>();
			const metadataKeys: Array<{ frame: number; referenceKey: string }> = [];
			const animationKeys = sourceKeys.map((key, keyIndex) => {
				const time = numberValue(key.time);
				if (!Number.isFinite(time) || time < 0) {
					throw new Error(`Unity object-reference curve ${curveIndex} key ${keyIndex} requires a finite non-negative time.`);
				}
				const reference = objectReference(key.value, `Unity object-reference curve ${curveIndex} key ${keyIndex}`);
				let referenceIndex = referenceIndexes.get(reference.key);
				if (referenceIndex === undefined) {
					referenceIndex = references.length;
					references.push(reference);
					referenceIndexes.set(reference.key, referenceIndex);
				}
				const frame = time * effectiveFramesPerSecond;
				metadataKeys.push({ frame, referenceKey: reference.key });
				return { frame, value: referenceIndex, interpolation: AnimationKeyInterpolation.STEP };
			});
			animationKeys.sort((left, right) => left.frame - right.frame);
			metadataKeys.sort((left, right) => left.frame - right.frame);
			if (animationKeys.some((key, index) => index > 0 && key.frame <= animationKeys[index - 1].frame)) {
				throw new Error(`Unity object-reference curve ${curveIndex} key times must be unique and ascending.`);
			}
			const animation = new Animation(
				`${target} ${attribute}`,
				trackProperty,
				effectiveFramesPerSecond,
				Animation.ANIMATIONTYPE_FLOAT,
				loop ? Animation.ANIMATIONLOOPMODE_CYCLE : Animation.ANIMATIONLOOPMODE_CONSTANT
			);
			animation.setKeys(animationKeys);
			targetedAnimations.push({ targetId: target, targetName: target, animation: animation.serialize() });
			objectReferenceCurves.push({ id, target, attribute: safePropertyPath(attribute), trackProperty, references, keys: metadataKeys });
			keyCount += animationKeys.length;
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (curves.length + objectReferenceCurves.length > MAX_CURVES) {
		errors.push(`Unity AnimationClips are limited to ${MAX_CURVES.toLocaleString()} total curves.`);
	}
	if (keyCount > MAX_KEYS) {
		errors.push(`Unity AnimationClips are limited to ${MAX_KEYS.toLocaleString()} keys.`);
	}
	for (const [curveIndex, definition] of curves.entries()) {
		const sourceKeys = entries(definition.curve.m_Curve);
		keyCount += sourceKeys.length;
		if (!sourceKeys.length) {
			errors.push(`Unity curve ${curveIndex} (${definition.target} · ${definition.property}) has no keys.`);
			continue;
		}
		if (keyCount > MAX_KEYS) {
			errors.push(`Unity AnimationClips are limited to ${MAX_KEYS.toLocaleString()} keys.`);
			break;
		}
		try {
			const animation = new Animation(
				`${definition.target} ${definition.property}`,
				definition.property,
				effectiveFramesPerSecond,
				definition.dataType,
				loop ? Animation.ANIMATIONLOOPMODE_CYCLE : Animation.ANIMATIONLOOPMODE_CONSTANT
			);
			const keys = sourceKeys.map((sourceKey, keyIndex) => {
				const time = numberValue(sourceKey.time);
				if (!Number.isFinite(time) || time < 0) {
					throw new Error(`Unity curve ${curveIndex} key ${keyIndex} requires a finite non-negative time.`);
				}
				const frame = time * effectiveFramesPerSecond;
				let value = scaledValue(sourceKey.value, definition.dataType, definition.valueScale);
				if (definition.discrete) {
					if (typeof value !== "number") {
						throw new Error(`Unity discrete curve ${curveIndex} key ${keyIndex} must contain a numeric value.`);
					}
					value = value >= 0.5 ? 1 : 0;
				}
				const rawInTangent = scaledTangent(sourceKey.inSlope, definition.dataType, definition.valueScale, effectiveFramesPerSecond);
				const rawOutTangent = scaledTangent(sourceKey.outSlope, definition.dataType, definition.valueScale, effectiveFramesPerSecond);
				const weightedMode = numberValue(sourceKey.weightedMode, 0);
				if (!Number.isInteger(weightedMode) || weightedMode < 0 || weightedMode > 3) {
					throw new Error(`Unity curve ${curveIndex} key ${keyIndex} weightedMode must be an integer from 0 through 3.`);
				}
				const inWeight = weightedMode & 1 ? numberValue(sourceKey.inWeight, 1 / 3) : 1 / 3;
				const outWeight = weightedMode & 2 ? numberValue(sourceKey.outWeight, 1 / 3) : 1 / 3;
				if (inWeight <= 0 || inWeight > 1 || outWeight <= 0 || outWeight > 1) {
					throw new Error(`Unity curve ${curveIndex} key ${keyIndex} weights must be in (0, 1].`);
				}
				const inTangent = multiplyTangent(rawInTangent, 3 * inWeight);
				const outTangent = multiplyTangent(rawOutTangent, 3 * outWeight);
				if (weightedMode) {
					approximated.add("Unity weighted temporal handles execute through Babylon fixed-time Hermite tangents using slope × 3 × weight.");
				}
				if (!definition.discrete) {
					const componentCount = typeof value === "number" ? 1 : value.asArray().length;
					for (let component = 0; component < componentCount; component++) {
						tangentModes.push({
							targetId: definition.target,
							property: definition.property,
							frame,
							component,
							mode: weightedMode ? "weighted" : "broken",
							authoredInTangent: componentValues(rawInTangent)[component] ?? 0,
							authoredOutTangent: componentValues(rawOutTangent)[component] ?? 0,
							inWeight: weightedMode & 1 ? inWeight : null,
							outWeight: weightedMode & 2 ? outWeight : null,
							effectiveInTangent: componentValues(inTangent)[component] ?? 0,
							effectiveOutTangent: componentValues(outTangent)[component] ?? 0,
							locked: false,
							unityWeightedMode: weightedMode,
							unityTangentMode: numberValue(sourceKey.tangentMode, 0),
						});
					}
				}
				return {
					frame,
					value,
					...(!definition.discrete && inTangent !== undefined ? { inTangent } : {}),
					...(!definition.discrete && outTangent !== undefined ? { outTangent } : {}),
					interpolation: definition.discrete ? AnimationKeyInterpolation.STEP : AnimationKeyInterpolation.NONE,
				};
			});
			keys.sort((left, right) => left.frame - right.frame);
			if (keys.some((key, index) => index > 0 && key.frame <= keys[index - 1].frame)) {
				throw new Error(`Unity curve ${curveIndex} key times must be unique and ascending.`);
			}
			animation.setKeys(keys);
			targetedAnimations.push({ targetId: definition.target, targetName: definition.target, animation: animation.serialize() });
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}

	const events = entries(clip.m_Events)
		.slice(0, 4096)
		.map((event, index) => {
			const time = numberValue(event.time);
			if (!Number.isFinite(time) || time < 0) {
				errors.push(`Unity Animation Event ${index} requires a finite non-negative time.`);
			}
			return {
				index,
				frame: (Number.isFinite(time) && time >= 0 ? time : 0) * effectiveFramesPerSecond,
				functionName: textValue(event.functionName),
				stringParameter: textValue(event.stringParameter),
				floatParameter: numberValue(event.floatParameter, 0),
				intParameter: numberValue(event.intParameter, 0),
				objectReferenceParameter: structuredClone(record(event.objectReferenceParameter) ?? {}),
			};
		});
	if (entries(clip.m_Events).length > events.length) {
		errors.push("Unity AnimationClips are limited to 4096 events.");
	}
	if (events.length) {
		preserved.add("Unity Animation Events are retained as inert metadata with exact parameters; automatic function invocation is not enabled.");
	}
	if (compressedRotationCurveCount) {
		preserved.add(
			"Legacy Unity compressed rotation curves are decoded from exact delta-centisecond times, packed smallest-three quaternions, and packed slopes into editable Babylon quaternion tracks."
		);
	}
	if (activeStateCurveCount) {
		preserved.add("Unity GameObject m_IsActive curves execute as stepped Node.setEnabled state changes in editor preview and exported runtime.");
	}
	if (objectReferenceCurves.length) {
		preserved.add(
			"Unity object-reference curves retain exact GUID/fileID/type identities and stepped keys; explicit safe destination/value bindings drive editor preview and exported runtime."
		);
	}
	preserved.add("Transform/float curve target paths, values, slopes, sample rate, loop state, and clip name are preserved.");
	if (booleanValue(settings?.m_LoopBlend)) {
		preserved.add("Unity Loop Pose intent is retained in metadata for downstream clip processing.");
	}
	preserved.add(
		`Unity clip settings retain loop=${loop}, loopPose=${booleanValue(settings?.m_LoopBlend)}, cycleOffset=${numberValue(settings?.m_CycleOffset, 0)}, orientationOffsetY=${numberValue(settings?.m_OrientationOffsetY, 0)}, level=${numberValue(settings?.m_Level, 0)}, and mirror=${booleanValue(settings?.m_Mirror)}.`
	);
	const frames = targetedAnimations.flatMap((targeted) => entries(record(targeted.animation)?.keys).map((key) => numberValue(key.frame, 0)));
	const from = frames.length ? Math.min(...frames) : 0;
	const to = frames.length ? Math.max(...frames) : 0;
	const metadata = {
		[UNITY_ANIMATION_CLIP_METADATA_KEY]: {
			version: 2,
			sourcePath,
			sampleRate: effectiveFramesPerSecond,
			loopTime: loop,
			loopPose: booleanValue(settings?.m_LoopBlend),
			cycleOffset: numberValue(settings?.m_CycleOffset, 0),
			orientationOffsetY: numberValue(settings?.m_OrientationOffsetY, 0),
			level: numberValue(settings?.m_Level, 0),
			mirror: booleanValue(settings?.m_Mirror),
			events,
			activeStateCurveCount,
			compressedRotationCurveCount,
			objectReferenceCurves,
			objectReferenceBindings: [],
			unsupportedFeatures: [...unsupported],
			approximatedFeatures: [...approximated],
		},
		babylonEditorAnimationTangentModes: tangentModes,
	};
	return {
		document: { name, from, to, loopAnimation: loop, metadata, targetedAnimations },
		name,
		framesPerSecond: effectiveFramesPerSecond,
		curveCount: targetedAnimations.length,
		keyCount,
		eventCount: events.length,
		activeStateCurveCount,
		compressedRotationCurveCount,
		objectReferenceCurves,
		loop,
		preservedFeatures: [...preserved],
		approximatedFeatures: [...approximated],
		unsupportedFeatures: [...unsupported],
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
}
