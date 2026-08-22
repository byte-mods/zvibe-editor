import { Constants } from "@babylonjs/core/Engines/constants";
import { Effect } from "@babylonjs/core/Materials/effect";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Node } from "@babylonjs/core/node";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";
import { Sprite } from "@babylonjs/core/Sprites/sprite";
import { SpriteManager } from "@babylonjs/core/Sprites/spriteManager";

import type { SpriteMapNode, SpriteManagerNode } from "../tools/sprite";

export const lighting2DModel = "unity-light2d-v1" as const;
export const shadowCaster2DModel = "unity-shadow-caster2d-v1" as const;

export const maximumLighting2DComponents = 256;
export const maximumActiveLightsPerReceiver = 8;
export const maximumLight2DShapePoints = 32;
export const maximumShadowCaster2DShapePoints = 64;
export const maximumShadowCaster2DSegmentsPerReceiver = 64;
export const maximumLighting2DProviderDataBytes = 64 * 1024;

const lightDataTextureWidth = 512;
const lightRecordTexels = 5 + maximumLight2DShapePoints;
const shadowSegmentTexelOffset = maximumActiveLightsPerReceiver * lightRecordTexels;
const providerIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export type Light2DType = "global" | "point" | "freeform" | "sprite" | "provider";
export type Light2DOverlapOperation = "additive" | "alpha-blend";
export type ShadowCaster2DSourceType = "shape-editor" | "node-bounds" | "provider";
export type ShadowCaster2DCastingOption = "cast-shadow" | "self-shadow" | "cast-and-self-shadow" | "no-shadow";

export interface ILight2DComponentData extends Record<string, unknown> {
	model: typeof lighting2DModel;
	version: 1;
	lightType: Light2DType;
	providerId: string;
	providerVersion: number;
	providerData: Record<string, unknown>;
	color: [number, number, number, number];
	intensity: number;
	falloffIntensity: number;
	innerRadius: number;
	outerRadius: number;
	innerAngleDegrees: number;
	outerAngleDegrees: number;
	shapePath: Array<[number, number]>;
	overlapOperation: Light2DOverlapOperation;
	lightOrder: number;
	shadowsEnabled: boolean;
	shadowIntensity: number;
	targetSortingLayerIds: string[];
}

export interface IShadowCaster2DComponentData extends Record<string, unknown> {
	model: typeof shadowCaster2DModel;
	version: 1;
	sourceType: ShadowCaster2DSourceType;
	providerId: string;
	providerVersion: number;
	providerData: Record<string, unknown>;
	shapePath: Array<[number, number]>;
	castingOption: ShadowCaster2DCastingOption;
	priority: number;
	targetSortingLayerIds: string[];
}

export interface ILight2DProviderContext<TData extends Record<string, unknown> = Record<string, unknown>> {
	readonly scene: Scene;
	readonly node: Node;
	readonly componentId: string;
	readonly component: Readonly<ILight2DComponentData>;
	readonly data: Readonly<TData>;
	readonly deltaTimeSeconds: number;
}

export interface IShadowShape2DProviderContext<TData extends Record<string, unknown> = Record<string, unknown>> {
	readonly scene: Scene;
	readonly node: Node;
	readonly componentId: string;
	readonly component: Readonly<IShadowCaster2DComponentData>;
	readonly data: Readonly<TData>;
	readonly deltaTimeSeconds: number;
}

export interface ILight2DGlobalShape {
	kind: "global";
}

export interface ILight2DRadialShape {
	kind: "radial";
	center?: [number, number];
	radius?: number;
	directionDegrees?: number;
	space?: "local" | "world";
}

export interface ILight2DPolygonShape {
	kind: "polygon";
	points: Array<[number, number]>;
	space?: "local" | "world";
}

export type Light2DProviderShape = ILight2DGlobalShape | ILight2DRadialShape | ILight2DPolygonShape;

export interface ILight2DProviderDefinition<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown> {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly dataVersion: number;
	readonly menuPriority?: number;
	readonly usesNodeData?: boolean;
	setDefaultValues?(): TData;
	validate?(context: ILight2DProviderContext<TData>): true | string;
	create?(context: ILight2DProviderContext<TData>): TState;
	onAwake?(context: ILight2DProviderContext<TData>, state: TState): void;
	getShape(context: ILight2DProviderContext<TData>, state: TState): Light2DProviderShape;
	destroy?(state: TState): void;
}

export interface IShadowShape2DWriter {
	setShape(points: Array<[number, number]>, space?: "local" | "world"): void;
	clear(): void;
}

export interface IShadowShape2DProviderDefinition<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown> {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly dataVersion: number;
	readonly menuPriority?: number;
	readonly usesNodeData?: boolean;
	setDefaultValues?(): TData;
	validate?(context: IShadowShape2DProviderContext<TData>): true | string;
	create?(context: IShadowShape2DProviderContext<TData>): TState;
	onInitialized?(context: IShadowShape2DProviderContext<TData>, writer: IShadowShape2DWriter, state: TState): void;
	enabled?(context: IShadowShape2DProviderContext<TData>, writer: IShadowShape2DWriter, state: TState): void;
	disabled?(context: IShadowShape2DProviderContext<TData>, writer: IShadowShape2DWriter, state: TState): void;
	onBeforeRender(context: IShadowShape2DProviderContext<TData>, writer: IShadowShape2DWriter, state: TState): void;
	destroy?(state: TState): void;
}

export interface ILighting2DProviderType {
	id: string;
	displayName: string;
	description: string;
	dataVersion: number;
	menuPriority: number;
	usesNodeData: boolean;
	defaultData: Record<string, unknown>;
	builtIn: boolean;
}

export interface IResolvedLight2D {
	node: Node;
	componentId: string;
	data: ILight2DComponentData;
	shape: Light2DProviderShape;
	worldCenter: [number, number];
	worldRadius: number;
	worldDirectionRadians: number;
	worldPoints: Array<[number, number]>;
}

export interface IResolvedShadowCaster2D {
	node: Node;
	componentId: string;
	data: IShadowCaster2DComponentData;
	worldPoints: Array<[number, number]>;
}

interface IProviderLifecycleEvidence {
	kind: "light" | "shadow";
	nodeId: string;
	nodeName: string;
	componentId: string;
	providerId: string;
	providerVersion: number;
	registeredVersion: number | null;
	active: boolean;
	valid: boolean;
	initializedCount: number;
	enabledCount: number;
	disabledCount: number;
	beforeRenderCount: number;
	shapeRevision: number;
	shapePointCount: number;
	errorCount: number;
	lastError: string | null;
	lastDurationMilliseconds: number;
}

interface IProviderRuntimeState {
	kind: "light" | "shadow";
	node: Node;
	componentId: string;
	providerId: string;
	providerVersion: number;
	definition: ILight2DProviderDefinition | IShadowShape2DProviderDefinition | null;
	state: unknown;
	active: boolean;
	initialized: boolean;
	shape: Light2DProviderShape | null;
	shapePoints: Array<[number, number]>;
	shapeSpace: "local" | "world";
	lastShadowContext: IShadowShape2DProviderContext | null;
	evidence: IProviderLifecycleEvidence;
}

interface ISpriteMapLightingState {
	data: Float32Array;
	texture: RawTexture;
	material: ShaderMaterial;
}

interface ILighting2DRuntime {
	observer: Observer<Scene> | null;
	disposeObserver: Observer<Scene> | null;
	evaluating: boolean;
	providerStates: Map<string, IProviderRuntimeState>;
	spriteMapStates: Map<object, ISpriteMapLightingState>;
	litSprites: Set<Sprite>;
	frameCount: number;
	configuredAt: string;
	lastFrameAt: string | null;
	lastFrameDurationMilliseconds: number;
	activeLightCount: number;
	activeCasterCount: number;
	spriteManagerCount: number;
	litSpriteCount: number;
	spriteMapCount: number;
	droppedLightCount: number;
	droppedCasterSegmentCount: number;
	warnings: string[];
}

const lightProviderDefinitions = new Map<string, ILight2DProviderDefinition>();
const shadowProviderDefinitions = new Map<string, IShadowShape2DProviderDefinition>();
const providerDefaultData = new WeakMap<object, Record<string, unknown>>();
const lighting2DRuntimes = new WeakMap<Scene, ILighting2DRuntime>();
const spriteLightingMultipliers = new WeakMap<Sprite, [number, number, number]>();
const patchedSpriteManagers = new WeakSet<SpriteManager>();

function elapsedStart(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function clamp(value: unknown, minimum: number, maximum: number, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function integer(value: unknown, minimum: number, maximum: number, fallback: number): number {
	return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value as number)) : fallback;
}

function cloneProviderData(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	try {
		const text = JSON.stringify(value);
		if (new TextEncoder().encode(text).byteLength > maximumLighting2DProviderDataBytes) {
			return {};
		}
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function normalizeColor(value: unknown): [number, number, number, number] {
	if (!Array.isArray(value) || value.length !== 4) {
		return [1, 1, 1, 1];
	}
	return [clamp(value[0], 0, 16, 1), clamp(value[1], 0, 16, 1), clamp(value[2], 0, 16, 1), clamp(value[3], 0, 1, 1)];
}

function normalizePoints(value: unknown, maximum: number, fallback: Array<[number, number]>): Array<[number, number]> {
	if (!Array.isArray(value) || value.length < 3) {
		return fallback.map((point) => [...point]);
	}
	const points = value.slice(0, maximum).map((point): [number, number] | null => {
		if (!Array.isArray(point) || point.length !== 2 || !point.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
			return null;
		}
		return [clamp(point[0], -1_000_000, 1_000_000, 0), clamp(point[1], -1_000_000, 1_000_000, 0)];
	});
	return points.every(Boolean) && points.length >= 3 ? (points as Array<[number, number]>) : fallback.map((point) => [...point]);
}

function normalizeSortingLayerIds(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 128))].slice(0, 32);
}

function builtInLightProviderId(lightType: Light2DType): string {
	return lightType === "provider" ? "" : `builtin.${lightType}`;
}

function builtInShadowProviderId(sourceType: ShadowCaster2DSourceType): string {
	return sourceType === "provider" ? "" : `builtin.${sourceType}`;
}

export function normalizeLight2DComponentData(value: unknown): ILight2DComponentData {
	const candidate = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<ILight2DComponentData>) : {};
	const lightTypes: Light2DType[] = ["global", "point", "freeform", "sprite", "provider"];
	const lightType = lightTypes.includes(candidate.lightType as Light2DType) ? (candidate.lightType as Light2DType) : "point";
	const providerId = typeof candidate.providerId === "string" && providerIdPattern.test(candidate.providerId) ? candidate.providerId : builtInLightProviderId(lightType);
	const innerRadius = clamp(candidate.innerRadius, 0, 1_000_000, 0);
	const outerRadius = Math.max(innerRadius, clamp(candidate.outerRadius, 0.001, 1_000_000, 500));
	const innerAngleDegrees = clamp(candidate.innerAngleDegrees, 0, 360, 360);
	const outerAngleDegrees = Math.max(innerAngleDegrees, clamp(candidate.outerAngleDegrees, 0.001, 360, 360));
	return {
		model: lighting2DModel,
		version: 1,
		lightType,
		providerId,
		providerVersion: integer(candidate.providerVersion, 1, 100_000, 1),
		providerData: cloneProviderData(candidate.providerData),
		color: normalizeColor(candidate.color),
		intensity: clamp(candidate.intensity, 0, 64, 1),
		falloffIntensity: clamp(candidate.falloffIntensity, 0, 1, 0.5),
		innerRadius,
		outerRadius,
		innerAngleDegrees,
		outerAngleDegrees,
		shapePath: normalizePoints(candidate.shapePath, maximumLight2DShapePoints, [
			[-50, -50],
			[50, -50],
			[50, 50],
			[-50, 50],
		]),
		overlapOperation: candidate.overlapOperation === "alpha-blend" ? "alpha-blend" : "additive",
		lightOrder: integer(candidate.lightOrder, -32_000, 32_000, 0),
		shadowsEnabled: candidate.shadowsEnabled !== false,
		shadowIntensity: clamp(candidate.shadowIntensity, 0, 1, 0.75),
		targetSortingLayerIds: normalizeSortingLayerIds(candidate.targetSortingLayerIds),
	};
}

export function normalizeShadowCaster2DComponentData(value: unknown): IShadowCaster2DComponentData {
	const candidate = value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<IShadowCaster2DComponentData>) : {};
	const sourceTypes: ShadowCaster2DSourceType[] = ["shape-editor", "node-bounds", "provider"];
	const sourceType = sourceTypes.includes(candidate.sourceType as ShadowCaster2DSourceType) ? (candidate.sourceType as ShadowCaster2DSourceType) : "shape-editor";
	const castingOptions: ShadowCaster2DCastingOption[] = ["cast-shadow", "self-shadow", "cast-and-self-shadow", "no-shadow"];
	return {
		model: shadowCaster2DModel,
		version: 1,
		sourceType,
		providerId: typeof candidate.providerId === "string" && providerIdPattern.test(candidate.providerId) ? candidate.providerId : builtInShadowProviderId(sourceType),
		providerVersion: integer(candidate.providerVersion, 1, 100_000, 1),
		providerData: cloneProviderData(candidate.providerData),
		shapePath: normalizePoints(candidate.shapePath, maximumShadowCaster2DShapePoints, [
			[-50, -50],
			[50, -50],
			[50, 50],
			[-50, 50],
		]),
		castingOption: castingOptions.includes(candidate.castingOption as ShadowCaster2DCastingOption) ? (candidate.castingOption as ShadowCaster2DCastingOption) : "cast-shadow",
		priority: integer(candidate.priority, -32_000, 32_000, 0),
		targetSortingLayerIds: normalizeSortingLayerIds(candidate.targetSortingLayerIds),
	};
}

export function validateLight2DComponentData(value: unknown): ILight2DComponentData {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Light2D data must be an object.");
	}
	const allowed = new Set([
		"model",
		"version",
		"lightType",
		"providerId",
		"providerVersion",
		"providerData",
		"color",
		"intensity",
		"falloffIntensity",
		"innerRadius",
		"outerRadius",
		"innerAngleDegrees",
		"outerAngleDegrees",
		"shapePath",
		"overlapOperation",
		"lightOrder",
		"shadowsEnabled",
		"shadowIntensity",
		"targetSortingLayerIds",
	]);
	const unknown = Object.keys(value as Record<string, unknown>).find((key) => !allowed.has(key));
	if (unknown) {
		throw new Error(`Light2D data.${unknown} is not supported.`);
	}
	const source = value as Record<string, unknown>;
	if (source.model !== undefined && source.model !== lighting2DModel) {
		throw new Error(`Light2D data.model must be "${lighting2DModel}".`);
	}
	if (source.version !== undefined && source.version !== 1) {
		throw new Error("Light2D data.version must be 1.");
	}
	if (source.lightType !== undefined && !["global", "point", "freeform", "sprite", "provider"].includes(String(source.lightType))) {
		throw new Error("Light2D data.lightType must be global, point, freeform, sprite, or provider.");
	}
	assertProviderFields(source, "Light2D data");
	assertNumberTuple(source.color, "Light2D data.color", [0, 0, 0, 0], [16, 16, 16, 1]);
	assertOptionalNumber(source.intensity, "Light2D data.intensity", 0, 64);
	assertOptionalNumber(source.falloffIntensity, "Light2D data.falloffIntensity", 0, 1);
	assertOptionalNumber(source.innerRadius, "Light2D data.innerRadius", 0, 1_000_000);
	assertOptionalNumber(source.outerRadius, "Light2D data.outerRadius", 0.001, 1_000_000);
	assertOptionalNumber(source.innerAngleDegrees, "Light2D data.innerAngleDegrees", 0, 360);
	assertOptionalNumber(source.outerAngleDegrees, "Light2D data.outerAngleDegrees", 0.001, 360);
	if (typeof source.innerRadius === "number" && typeof source.outerRadius === "number" && source.innerRadius > source.outerRadius) {
		throw new Error("Light2D innerRadius cannot exceed outerRadius.");
	}
	if (typeof source.innerAngleDegrees === "number" && typeof source.outerAngleDegrees === "number" && source.innerAngleDegrees > source.outerAngleDegrees) {
		throw new Error("Light2D innerAngleDegrees cannot exceed outerAngleDegrees.");
	}
	assertShapePath(source.shapePath, "Light2D data.shapePath", maximumLight2DShapePoints);
	if (source.overlapOperation !== undefined && source.overlapOperation !== "additive" && source.overlapOperation !== "alpha-blend") {
		throw new Error("Light2D data.overlapOperation must be additive or alpha-blend.");
	}
	assertOptionalInteger(source.lightOrder, "Light2D data.lightOrder", -32_000, 32_000);
	assertOptionalBoolean(source.shadowsEnabled, "Light2D data.shadowsEnabled");
	assertOptionalNumber(source.shadowIntensity, "Light2D data.shadowIntensity", 0, 1);
	assertSortingLayerIds(source.targetSortingLayerIds, "Light2D data.targetSortingLayerIds");
	const normalized = normalizeLight2DComponentData(value);
	if (normalized.lightType === "provider" && (!normalized.providerId || normalized.providerId.startsWith("builtin."))) {
		throw new Error("Custom Light2D data requires a non-built-in providerId.");
	}
	if (normalized.lightType !== "provider" && normalized.providerId !== builtInLightProviderId(normalized.lightType)) {
		throw new Error(`Built-in ${normalized.lightType} Light2D must use providerId "${builtInLightProviderId(normalized.lightType)}".`);
	}
	return normalized;
}

export function validateShadowCaster2DComponentData(value: unknown): IShadowCaster2DComponentData {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("ShadowCaster2D data must be an object.");
	}
	const allowed = new Set(["model", "version", "sourceType", "providerId", "providerVersion", "providerData", "shapePath", "castingOption", "priority", "targetSortingLayerIds"]);
	const unknown = Object.keys(value as Record<string, unknown>).find((key) => !allowed.has(key));
	if (unknown) {
		throw new Error(`ShadowCaster2D data.${unknown} is not supported.`);
	}
	const source = value as Record<string, unknown>;
	if (source.model !== undefined && source.model !== shadowCaster2DModel) {
		throw new Error(`ShadowCaster2D data.model must be "${shadowCaster2DModel}".`);
	}
	if (source.version !== undefined && source.version !== 1) {
		throw new Error("ShadowCaster2D data.version must be 1.");
	}
	if (source.sourceType !== undefined && !["shape-editor", "node-bounds", "provider"].includes(String(source.sourceType))) {
		throw new Error("ShadowCaster2D data.sourceType must be shape-editor, node-bounds, or provider.");
	}
	assertProviderFields(source, "ShadowCaster2D data");
	assertShapePath(source.shapePath, "ShadowCaster2D data.shapePath", maximumShadowCaster2DShapePoints);
	if (
		source.castingOption !== undefined &&
		source.castingOption !== "cast-shadow" &&
		source.castingOption !== "self-shadow" &&
		source.castingOption !== "cast-and-self-shadow" &&
		source.castingOption !== "no-shadow"
	) {
		throw new Error("ShadowCaster2D data.castingOption must be cast-shadow, self-shadow, cast-and-self-shadow, or no-shadow.");
	}
	assertOptionalInteger(source.priority, "ShadowCaster2D data.priority", -32_000, 32_000);
	assertSortingLayerIds(source.targetSortingLayerIds, "ShadowCaster2D data.targetSortingLayerIds");
	const normalized = normalizeShadowCaster2DComponentData(value);
	if (normalized.sourceType === "provider" && (!normalized.providerId || normalized.providerId.startsWith("builtin."))) {
		throw new Error("Custom ShadowCaster2D data requires a non-built-in providerId.");
	}
	if (normalized.sourceType !== "provider" && normalized.providerId !== builtInShadowProviderId(normalized.sourceType)) {
		throw new Error(`Built-in ${normalized.sourceType} ShadowCaster2D must use providerId "${builtInShadowProviderId(normalized.sourceType)}".`);
	}
	return normalized;
}

function assertOptionalNumber(value: unknown, path: string, minimum: number, maximum: number): void {
	if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)) {
		throw new Error(`${path} must be a finite number from ${minimum} through ${maximum}.`);
	}
}

function assertOptionalInteger(value: unknown, path: string, minimum: number, maximum: number): void {
	if (value !== undefined && (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum)) {
		throw new Error(`${path} must be an integer from ${minimum} through ${maximum}.`);
	}
}

function assertOptionalBoolean(value: unknown, path: string): void {
	if (value !== undefined && typeof value !== "boolean") {
		throw new Error(`${path} must be a boolean.`);
	}
}

function assertNumberTuple(value: unknown, path: string, minimum: number[], maximum: number[]): void {
	if (value === undefined) {
		return;
	}
	if (
		!Array.isArray(value) ||
		value.length !== minimum.length ||
		value.some((entry, index) => typeof entry !== "number" || !Number.isFinite(entry) || entry < minimum[index] || entry > maximum[index])
	) {
		throw new Error(`${path} must contain ${minimum.length} finite values inside their supported ranges.`);
	}
}

function assertShapePath(value: unknown, path: string, maximum: number): void {
	if (value === undefined) {
		return;
	}
	if (
		!Array.isArray(value) ||
		value.length < 3 ||
		value.length > maximum ||
		value.some(
			(point) =>
				!Array.isArray(point) ||
				point.length !== 2 ||
				point.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || entry < -1_000_000 || entry > 1_000_000)
		)
	) {
		throw new Error(`${path} must contain 3 through ${maximum} finite [x,y] points inside ±1000000.`);
	}
}

function assertSortingLayerIds(value: unknown, path: string): void {
	if (value === undefined) {
		return;
	}
	if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== "string" || !entry || entry.length > 128)) {
		throw new Error(`${path} must contain at most 32 non-empty string ids of at most 128 characters.`);
	}
}

function assertProviderFields(source: Record<string, unknown>, path: string): void {
	if (source.providerId !== undefined && (typeof source.providerId !== "string" || !providerIdPattern.test(source.providerId))) {
		throw new Error(`${path}.providerId must contain 1 through 128 safe identifier characters.`);
	}
	assertOptionalInteger(source.providerVersion, `${path}.providerVersion`, 1, 100_000);
	if (source.providerData !== undefined) {
		if (!source.providerData || typeof source.providerData !== "object" || Array.isArray(source.providerData)) {
			throw new Error(`${path}.providerData must be a JSON object.`);
		}
		assertJsonValue(source.providerData, `${path}.providerData`, new WeakSet<object>(), { entries: 0 }, 0);
		let text: string;
		try {
			text = JSON.stringify(source.providerData);
		} catch {
			throw new Error(`${path}.providerData must be JSON serializable.`);
		}
		if (new TextEncoder().encode(text).byteLength > maximumLighting2DProviderDataBytes) {
			throw new Error(`${path}.providerData exceeds ${maximumLighting2DProviderDataBytes} UTF-8 bytes.`);
		}
	}
}

function assertJsonValue(value: unknown, path: string, ancestors: WeakSet<object>, budget: { entries: number }, depth: number): void {
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`${path} must contain only finite JSON numbers.`);
		}
		return;
	}
	if (!value || typeof value !== "object") {
		throw new Error(`${path} must contain only JSON values.`);
	}
	if (depth >= 32) {
		throw new Error(`${path} exceeds the maximum JSON nesting depth of 32.`);
	}
	if (ancestors.has(value)) {
		throw new Error(`${path} must not contain circular references.`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
		throw new Error(`${path} must contain only plain JSON objects and arrays.`);
	}
	ancestors.add(value);
	const entries = Array.isArray(value) ? value.map((entry, index) => [String(index), entry] as const) : Object.entries(value);
	for (const [key, entry] of entries) {
		budget.entries++;
		if (budget.entries > 4096) {
			throw new Error(`${path} exceeds the maximum of 4096 JSON entries.`);
		}
		if (!Array.isArray(value) && (!key || key.length > 256 || key === "__proto__" || key === "constructor" || key === "prototype")) {
			throw new Error(`${path} contains an unsupported JSON object key.`);
		}
		assertJsonValue(entry, `${path}${Array.isArray(value) ? `[${key}]` : `.${key}`}`, ancestors, budget, depth + 1);
	}
	ancestors.delete(value);
}

function validateProviderDefinition(definition: { id: string; dataVersion: number }, kind: string): void {
	if (!definition || typeof definition !== "object" || !providerIdPattern.test(definition.id)) {
		throw new Error(`${kind} provider id must contain 1 through 128 safe identifier characters.`);
	}
	if (!Number.isInteger(definition.dataVersion) || definition.dataVersion < 1 || definition.dataVersion > 100_000) {
		throw new Error(`${kind} provider dataVersion must be an integer from 1 through 100000.`);
	}
}

function captureProviderDefaultData(definition: { id: string; setDefaultValues?(): Record<string, unknown> }, kind: string): Record<string, unknown> {
	let defaults: Record<string, unknown>;
	try {
		defaults = definition.setDefaultValues?.() ?? {};
	} catch (error) {
		throw new Error(`${kind} provider "${definition.id}" setDefaultValues failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	assertProviderFields({ providerData: defaults }, `${kind} provider "${definition.id}" defaults`);
	return cloneProviderData(defaults);
}

export function registerLight2DProvider<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown>(
	definition: ILight2DProviderDefinition<TData, TState>
): () => void {
	validateProviderDefinition(definition, "Light2D");
	if (typeof definition.getShape !== "function") {
		throw new Error(`Light2D provider "${definition.id}" must implement getShape.`);
	}
	providerDefaultData.set(definition, captureProviderDefaultData(definition, "Light2D"));
	lightProviderDefinitions.set(definition.id, definition as ILight2DProviderDefinition);
	return (): void => {
		if (lightProviderDefinitions.get(definition.id) === definition) {
			lightProviderDefinitions.delete(definition.id);
		}
	};
}

export function registerShadowShape2DProvider<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown>(
	definition: IShadowShape2DProviderDefinition<TData, TState>
): () => void {
	validateProviderDefinition(definition, "ShadowShape2D");
	if (typeof definition.onBeforeRender !== "function") {
		throw new Error(`ShadowShape2D provider "${definition.id}" must implement onBeforeRender.`);
	}
	providerDefaultData.set(definition, captureProviderDefaultData(definition, "ShadowShape2D"));
	shadowProviderDefinitions.set(definition.id, definition as IShadowShape2DProviderDefinition);
	return (): void => {
		if (shadowProviderDefinitions.get(definition.id) === definition) {
			shadowProviderDefinitions.delete(definition.id);
		}
	};
}

function providerTypes<T extends ILight2DProviderDefinition | IShadowShape2DProviderDefinition>(definitions: Map<string, T>): ILighting2DProviderType[] {
	return [...definitions.values()]
		.map((definition) => ({
			id: definition.id,
			displayName: definition.displayName?.trim() || definition.id,
			description: definition.description?.trim() || "",
			dataVersion: definition.dataVersion,
			menuPriority: integer(definition.menuPriority, -32_000, 32_000, 0),
			usesNodeData: definition.usesNodeData !== false,
			defaultData: cloneProviderData(providerDefaultData.get(definition) ?? {}),
			builtIn: definition.id.startsWith("builtin."),
		}))
		.sort((left, right) => left.menuPriority - right.menuPriority || left.id.localeCompare(right.id));
}

export function listLight2DProviderTypes(): ILighting2DProviderType[] {
	return providerTypes(lightProviderDefinitions);
}

export function listShadowShape2DProviderTypes(): ILighting2DProviderType[] {
	return providerTypes(shadowProviderDefinitions);
}

function nodeWorldMatrix(node: Node): Matrix {
	return typeof (node as any).computeWorldMatrix === "function" ? (node as any).computeWorldMatrix(true) : Matrix.Identity();
}

function transformPoint(node: Node, point: [number, number]): [number, number] {
	const world = Vector3.TransformCoordinates(new Vector3(point[0], point[1], 0), nodeWorldMatrix(node));
	return [world.x, world.y];
}

function transformShapePoints(node: Node, points: Array<[number, number]>, space: "local" | "world"): Array<[number, number]> {
	return space === "world" ? points.map((point) => [...point]) : points.map((point) => transformPoint(node, point));
}

function nodeScaleAndRotation(node: Node): { scale: number; rotationRadians: number } {
	const scaling = Vector3.One();
	const rotation = Quaternion.Identity();
	nodeWorldMatrix(node).decompose(scaling, rotation, undefined);
	return { scale: Math.max(Math.abs(scaling.x), Math.abs(scaling.y), 0.000001), rotationRadians: rotation.toEulerAngles().z };
}

function nodeBoundsShape(node: Node): Array<[number, number]> {
	const boundingInfo = typeof (node as any).getBoundingInfo === "function" ? (node as any).getBoundingInfo() : null;
	const minimum = boundingInfo?.boundingBox?.minimum;
	const maximum = boundingInfo?.boundingBox?.maximum;
	if (minimum && maximum) {
		return [
			[minimum.x, minimum.y],
			[maximum.x, minimum.y],
			[maximum.x, maximum.y],
			[minimum.x, maximum.y],
		];
	}
	return [
		[-50, -50],
		[50, -50],
		[50, 50],
		[-50, 50],
	];
}

function stateKey(kind: "light" | "shadow", node: Node, componentId: string): string {
	return `${kind}\u0000${node.id}\u0000${componentId}`;
}

function activeNode(node: Node): boolean {
	return typeof (node as any).isEnabled !== "function" || (node as any).isEnabled(true) !== false;
}

function componentRows(scene: Scene, type: "light2d" | "shadowcaster2d"): Array<{ node: Node; component: any }> {
	const nodes = [...new Set<Node>([...scene.transformNodes, ...scene.meshes, ...scene.lights, ...scene.cameras])];
	const rows: Array<{ node: Node; component: any }> = [];
	for (const node of nodes) {
		const components = node.metadata?.babylonEditorComponentStack?.components;
		if (!Array.isArray(components)) {
			continue;
		}
		for (const component of components) {
			if (component?.type === type && typeof component.id === "string") {
				rows.push({ node, component });
				if (rows.length >= maximumLighting2DComponents) {
					return rows;
				}
			}
		}
	}
	return rows;
}

function createEvidence(kind: "light" | "shadow", node: Node, componentId: string, providerId: string, providerVersion: number): IProviderLifecycleEvidence {
	return {
		kind,
		nodeId: node.id,
		nodeName: node.name,
		componentId,
		providerId,
		providerVersion,
		registeredVersion: null,
		active: false,
		valid: false,
		initializedCount: 0,
		enabledCount: 0,
		disabledCount: 0,
		beforeRenderCount: 0,
		shapeRevision: 0,
		shapePointCount: 0,
		errorCount: 0,
		lastError: null,
		lastDurationMilliseconds: 0,
	};
}

function providerError(runtime: IProviderRuntimeState, error: unknown): void {
	runtime.evidence.errorCount++;
	runtime.evidence.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
	runtime.evidence.valid = false;
}

function destroyProviderState(runtime: IProviderRuntimeState): void {
	if (runtime.kind === "light") {
		try {
			(runtime.definition as ILight2DProviderDefinition | null)?.destroy?.(runtime.state);
		} catch {
			// Provider teardown must not prevent scene or hot-reload cleanup.
		}
		return;
	}
	const definition = runtime.definition as IShadowShape2DProviderDefinition | null;
	if (runtime.active && runtime.lastShadowContext) {
		try {
			definition?.disabled?.(runtime.lastShadowContext, new ShadowShapeWriter(runtime), runtime.state);
			runtime.evidence.disabledCount++;
		} catch {
			// A disabled hook failure must not suppress the required destroy hook.
		}
	}
	try {
		definition?.destroy?.(runtime.state);
	} catch {
		// Provider teardown must not prevent scene or hot-reload cleanup.
	}
}

class ShadowShapeWriter implements IShadowShape2DWriter {
	public constructor(private _runtime: IProviderRuntimeState) {}

	public setShape(points: Array<[number, number]>, space: "local" | "world" = "local"): void {
		this._runtime.shapePoints = normalizePoints(points, maximumShadowCaster2DShapePoints, []);
		this._runtime.shapeSpace = space;
		this._runtime.evidence.shapeRevision++;
		this._runtime.evidence.shapePointCount = this._runtime.shapePoints.length;
	}

	public clear(): void {
		this._runtime.shapePoints = [];
		this._runtime.evidence.shapeRevision++;
		this._runtime.evidence.shapePointCount = 0;
	}
}

function lightContext(scene: Scene, node: Node, componentId: string, data: ILight2DComponentData, deltaTimeSeconds: number): ILight2DProviderContext {
	return { scene, node, componentId, component: data, data: data.providerData, deltaTimeSeconds };
}

function shadowContext(scene: Scene, node: Node, componentId: string, data: IShadowCaster2DComponentData, deltaTimeSeconds: number): IShadowShape2DProviderContext {
	return { scene, node, componentId, component: data, data: data.providerData, deltaTimeSeconds };
}

function ensureProviderRuntime(
	runtime: ILighting2DRuntime,
	kind: "light" | "shadow",
	node: Node,
	componentId: string,
	providerId: string,
	providerVersion: number
): IProviderRuntimeState {
	const definition = kind === "light" ? lightProviderDefinitions.get(providerId) : shadowProviderDefinitions.get(providerId);
	const key = stateKey(kind, node, componentId);
	let state = runtime.providerStates.get(key);
	if (state && (state.definition !== definition || state.providerId !== providerId || state.providerVersion !== providerVersion)) {
		destroyProviderState(state);
		runtime.providerStates.delete(key);
		state = undefined;
	}
	if (!state) {
		state = {
			kind,
			node,
			componentId,
			providerId,
			providerVersion,
			definition: definition ?? null,
			state: undefined,
			active: false,
			initialized: false,
			shape: null,
			shapePoints: [],
			shapeSpace: "local",
			lastShadowContext: null,
			evidence: createEvidence(kind, node, componentId, providerId, providerVersion),
		};
		runtime.providerStates.set(key, state);
	}
	state.evidence.registeredVersion = definition?.dataVersion ?? null;
	return state;
}

function resolveLightRows(scene: Scene, runtime: ILighting2DRuntime, deltaTimeSeconds: number, seen: Set<string>): IResolvedLight2D[] {
	const resolved: IResolvedLight2D[] = [];
	for (const { node, component } of componentRows(scene, "light2d")) {
		const data = normalizeLight2DComponentData(component.data);
		const providerId = data.lightType === "provider" ? data.providerId : builtInLightProviderId(data.lightType);
		const definition = lightProviderDefinitions.get(providerId);
		const key = stateKey("light", node, component.id);
		seen.add(key);
		const state = ensureProviderRuntime(runtime, "light", node, component.id, providerId, data.providerVersion);
		const active = component.enabled !== false && activeNode(node);
		state.evidence.active = active;
		if (!active || !definition || definition.dataVersion !== data.providerVersion) {
			state.active = active;
			state.evidence.valid = false;
			state.evidence.lastError = !definition
				? `Light2D provider "${providerId}" is not registered in this runtime.`
				: definition.dataVersion !== data.providerVersion
					? `Registered provider version ${definition.dataVersion} does not match component version ${data.providerVersion}.`
					: null;
			continue;
		}
		const context = lightContext(scene, node, component.id, data, deltaTimeSeconds);
		const started = elapsedStart();
		try {
			const validation = definition.validate?.(context) ?? true;
			if (validation !== true) {
				throw new Error(String(validation));
			}
			if (!state.initialized) {
				state.state = definition.create?.(context);
				definition.onAwake?.(context, state.state);
				state.initialized = true;
				state.evidence.initializedCount++;
			}
			const shape = definition.getShape(context, state.state);
			if (!shape || !["global", "radial", "polygon"].includes(shape.kind)) {
				throw new Error(`Light2D provider "${providerId}" returned an unsupported shape.`);
			}
			state.shape = shape;
			state.active = true;
			state.evidence.beforeRenderCount++;
			state.evidence.valid = true;
			state.evidence.lastError = null;
			const scaleRotation = nodeScaleAndRotation(node);
			const localCenter: [number, number] = shape.kind === "radial" ? (shape.center ?? [0, 0]) : [0, 0];
			const worldCenter = shape.kind === "radial" && shape.space === "world" ? localCenter : transformPoint(node, localCenter);
			const worldPoints = shape.kind === "polygon" ? transformShapePoints(node, normalizePoints(shape.points, maximumLight2DShapePoints, []), shape.space ?? "local") : [];
			state.evidence.shapePointCount = worldPoints.length;
			resolved.push({
				node,
				componentId: component.id,
				data,
				shape,
				worldCenter,
				worldRadius:
					shape.kind === "radial" ? clamp(shape.radius, 0.001, 1_000_000, data.outerRadius) * (shape.space === "world" ? 1 : scaleRotation.scale) : data.outerRadius,
				worldDirectionRadians: ((shape.kind === "radial" ? clamp(shape.directionDegrees, -360_000, 360_000, 0) : 0) * Math.PI) / 180 + scaleRotation.rotationRadians,
				worldPoints,
			});
		} catch (error) {
			providerError(state, error);
		}
		state.evidence.lastDurationMilliseconds = elapsedStart() - started;
	}
	return resolved.sort((left, right) => left.data.lightOrder - right.data.lightOrder || left.componentId.localeCompare(right.componentId));
}

function resolveShadowRows(scene: Scene, runtime: ILighting2DRuntime, deltaTimeSeconds: number, seen: Set<string>): IResolvedShadowCaster2D[] {
	const resolved: IResolvedShadowCaster2D[] = [];
	for (const { node, component } of componentRows(scene, "shadowcaster2d")) {
		const data = normalizeShadowCaster2DComponentData(component.data);
		const providerId = data.sourceType === "provider" ? data.providerId : builtInShadowProviderId(data.sourceType);
		const definition = shadowProviderDefinitions.get(providerId);
		const key = stateKey("shadow", node, component.id);
		seen.add(key);
		const state = ensureProviderRuntime(runtime, "shadow", node, component.id, providerId, data.providerVersion);
		const active = component.enabled !== false && activeNode(node) && data.castingOption !== "no-shadow";
		state.evidence.active = active;
		const context = shadowContext(scene, node, component.id, data, deltaTimeSeconds);
		state.lastShadowContext = context;
		const writer = new ShadowShapeWriter(state);
		if (!active || !definition || definition.dataVersion !== data.providerVersion) {
			if (state.active && definition) {
				try {
					definition.disabled?.(context, writer, state.state);
					state.evidence.disabledCount++;
				} catch (error) {
					providerError(state, error);
				}
			}
			state.active = false;
			state.evidence.valid = false;
			state.evidence.lastError = !definition
				? `ShadowShape2D provider "${providerId}" is not registered in this runtime.`
				: definition.dataVersion !== data.providerVersion
					? `Registered provider version ${definition.dataVersion} does not match component version ${data.providerVersion}.`
					: null;
			continue;
		}
		const started = elapsedStart();
		try {
			const validation = definition.validate?.(context) ?? true;
			if (validation !== true) {
				throw new Error(String(validation));
			}
			if (!state.initialized) {
				state.state = definition.create?.(context);
				definition.onInitialized?.(context, writer, state.state);
				state.initialized = true;
				state.evidence.initializedCount++;
			}
			if (!state.active) {
				definition.enabled?.(context, writer, state.state);
				state.evidence.enabledCount++;
			}
			definition.onBeforeRender(context, writer, state.state);
			state.evidence.beforeRenderCount++;
			state.active = true;
			state.evidence.valid = state.shapePoints.length >= 3;
			state.evidence.lastError = state.evidence.valid ? null : "ShadowShape2D provider did not supply at least three points.";
			if (state.evidence.valid) {
				resolved.push({ node, componentId: component.id, data, worldPoints: transformShapePoints(node, state.shapePoints, state.shapeSpace) });
			}
		} catch (error) {
			providerError(state, error);
		}
		state.evidence.lastDurationMilliseconds = elapsedStart() - started;
	}
	return resolved.sort((left, right) => left.data.priority - right.data.priority || left.componentId.localeCompare(right.componentId));
}

function sortingLayerId(node: Node): string | null {
	return typeof node.metadata?.babylonEditorSortingLayer?.id === "string" ? node.metadata.babylonEditorSortingLayer.id : null;
}

function affectsLayer(targets: string[], receiverLayerId: string | null): boolean {
	return !targets.length || (receiverLayerId !== null && targets.includes(receiverLayerId));
}

function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
	let inside = false;
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		const [x, y] = polygon[index];
		const [previousX, previousY] = polygon[previous];
		if (y > point[1] !== previousY > point[1] && point[0] < ((previousX - x) * (point[1] - y)) / (previousY - y || Number.EPSILON) + x) {
			inside = !inside;
		}
	}
	return inside;
}

function cross(a: [number, number], b: [number, number], c: [number, number]): number {
	return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
	const first = cross(a, b, c);
	const second = cross(a, b, d);
	const third = cross(c, d, a);
	const fourth = cross(c, d, b);
	return first * second < -1e-8 && third * fourth < -1e-8;
}

function shadowed(light: IResolvedLight2D, point: [number, number], casters: IResolvedShadowCaster2D[], receiverNode: Node): boolean {
	if (!light.data.shadowsEnabled || light.shape.kind === "global") {
		return false;
	}
	for (const caster of casters) {
		if (!affectsLayer(caster.data.targetSortingLayerIds, sortingLayerId(receiverNode))) {
			continue;
		}
		if (!casterAffectsReceiver(caster, receiverNode)) {
			continue;
		}
		for (let index = 0; index < caster.worldPoints.length; index++) {
			if (segmentsIntersect(light.worldCenter, point, caster.worldPoints[index], caster.worldPoints[(index + 1) % caster.worldPoints.length])) {
				return true;
			}
		}
	}
	return false;
}

function casterAffectsReceiver(caster: IResolvedShadowCaster2D, receiverNode: Node): boolean {
	return caster.node === receiverNode
		? caster.data.castingOption === "self-shadow" || caster.data.castingOption === "cast-and-self-shadow"
		: caster.data.castingOption === "cast-shadow" || caster.data.castingOption === "cast-and-self-shadow";
}

function angleAttenuation(light: IResolvedLight2D, point: [number, number]): number {
	if (light.shape.kind !== "radial" || light.data.outerAngleDegrees >= 359.999) {
		return 1;
	}
	const angle = Math.atan2(point[1] - light.worldCenter[1], point[0] - light.worldCenter[0]);
	const difference = Math.abs(Math.atan2(Math.sin(angle - light.worldDirectionRadians), Math.cos(angle - light.worldDirectionRadians)));
	const outer = (light.data.outerAngleDegrees * Math.PI) / 360;
	const inner = (light.data.innerAngleDegrees * Math.PI) / 360;
	if (difference >= outer) {
		return 0;
	}
	return difference <= inner ? 1 : 1 - (difference - inner) / Math.max(0.000001, outer - inner);
}

function lightAttenuation(light: IResolvedLight2D, point: [number, number]): number {
	if (light.shape.kind === "global") {
		return 1;
	}
	if (light.shape.kind === "polygon") {
		return pointInPolygon(point, light.worldPoints) ? 1 : 0;
	}
	const distance = Math.hypot(point[0] - light.worldCenter[0], point[1] - light.worldCenter[1]);
	if (distance > light.worldRadius) {
		return 0;
	}
	const inner = Math.min(light.worldRadius, light.data.innerRadius * (light.worldRadius / Math.max(light.data.outerRadius, 0.000001)));
	const radial = distance <= inner ? 1 : 1 - (distance - inner) / Math.max(0.000001, light.worldRadius - inner);
	return Math.pow(Math.max(0, radial), 1 + light.data.falloffIntensity * 7) * angleAttenuation(light, point);
}

export function evaluateLighting2DAtPoint(
	point: [number, number],
	lights: readonly IResolvedLight2D[],
	casters: readonly IResolvedShadowCaster2D[],
	receiverNode: Node
): [number, number, number] {
	if (!lights.length) {
		return [1, 1, 1];
	}
	const result: [number, number, number] = [0, 0, 0];
	for (const light of lights.slice(0, maximumActiveLightsPerReceiver)) {
		if (!affectsLayer(light.data.targetSortingLayerIds, sortingLayerId(receiverNode))) {
			continue;
		}
		let attenuation = lightAttenuation(light, point);
		if (attenuation <= 0) {
			continue;
		}
		if (shadowed(light, point, [...casters], receiverNode)) {
			attenuation *= 1 - light.data.shadowIntensity;
		}
		const alpha = light.data.color[3] * light.data.intensity * attenuation;
		if (light.data.overlapOperation === "alpha-blend") {
			result[0] = result[0] * (1 - Math.min(1, alpha)) + light.data.color[0] * alpha;
			result[1] = result[1] * (1 - Math.min(1, alpha)) + light.data.color[1] * alpha;
			result[2] = result[2] * (1 - Math.min(1, alpha)) + light.data.color[2] * alpha;
		} else {
			result[0] += light.data.color[0] * alpha;
			result[1] += light.data.color[1] * alpha;
			result[2] += light.data.color[2] * alpha;
		}
	}
	return result;
}

function installSpriteManagerLightingHook(manager: SpriteManager): void {
	if (patchedSpriteManagers.has(manager)) {
		return;
	}
	const renderer = manager.spriteRenderer as any;
	const original = renderer._appendSpriteVertex;
	if (typeof original !== "function") {
		throw new Error(`SpriteManager "${manager.name}" does not expose the expected vertex-color hook.`);
	}
	renderer._appendSpriteVertex = function (index: number, sprite: Sprite, ...args: any[]): void {
		original.call(this, index, sprite, ...args);
		const multiplier = spriteLightingMultipliers.get(sprite);
		if (!multiplier) {
			return;
		}
		let arrayOffset = index * this._vertexBufferSize;
		if (this._useInstancing) {
			arrayOffset -= 2;
		}
		this._vertexData[arrayOffset + 14] *= multiplier[0];
		this._vertexData[arrayOffset + 15] *= multiplier[1];
		this._vertexData[arrayOffset + 16] *= multiplier[2];
	};
	patchedSpriteManagers.add(manager);
}

const spriteMapLightingMarker = "babylonEditorLighting2D";

function patchSpriteMapVertexShader(): void {
	const source = Effect.ShadersStore.spriteMapVertexShader;
	if (!source || source.includes(spriteMapLightingMarker)) {
		return;
	}
	const declaration = "varying vec3 vPosition;varying vec2 vUV;varying vec2 tUV;";
	const assignment = "vPosition=p.xyz;vUV=uv;tUV=uv*stageSize;";
	if (!source.includes(declaration) || !source.includes(assignment)) {
		throw new Error("Babylon SpriteMap vertex shader layout changed; Light2D world positions cannot be installed safely.");
	}
	Effect.ShadersStore.spriteMapVertexShader = source
		.replace(declaration, `${declaration}varying vec3 ${spriteMapLightingMarker}WorldPosition;`)
		.replace(assignment, `${assignment}${spriteMapLightingMarker}WorldPosition=(world*p).xyz;`);
}

function spriteMapLightingShaderFunctions(): string {
	return `
varying vec3 ${spriteMapLightingMarker}WorldPosition;
uniform float ${spriteMapLightingMarker}Enabled;
uniform float ${spriteMapLightingMarker}LightCount;
uniform float ${spriteMapLightingMarker}ShadowSegmentCount;
uniform sampler2D ${spriteMapLightingMarker}Data;
vec4 ${spriteMapLightingMarker}Read(float index){return texture2D(${spriteMapLightingMarker}Data,vec2((index+0.5)/${lightDataTextureWidth}.0,0.5));}
float ${spriteMapLightingMarker}Cross(vec2 a,vec2 b,vec2 c){return (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);}
float ${spriteMapLightingMarker}Intersects(vec2 a,vec2 b,vec2 c,vec2 d){float ab0=${spriteMapLightingMarker}Cross(a,b,c);float ab1=${spriteMapLightingMarker}Cross(a,b,d);float cd0=${spriteMapLightingMarker}Cross(c,d,a);float cd1=${spriteMapLightingMarker}Cross(c,d,b);return float(ab0*ab1<-0.00000001&&cd0*cd1<-0.00000001);}
float ${spriteMapLightingMarker}InsidePolygon(vec2 point,float record,float count){float inside=0.0;vec2 previous=${spriteMapLightingMarker}Read(record+5.0+max(count-1.0,0.0)).xy;for(int p=0;p<${maximumLight2DShapePoints};p++){if(float(p)>=count){break;}vec2 current=${spriteMapLightingMarker}Read(record+5.0+float(p)).xy;float crosses=float((current.y>point.y)!=(previous.y>point.y)&&point.x<((previous.x-current.x)*(point.y-current.y))/(previous.y-current.y+0.00000001)+current.x);inside=abs(inside-crosses);previous=current;}return inside;}
float ${spriteMapLightingMarker}Shadow(vec2 lightPosition,vec2 point){float hit=0.0;for(int s=0;s<${maximumShadowCaster2DSegmentsPerReceiver};s++){if(float(s)>=${spriteMapLightingMarker}ShadowSegmentCount){break;}vec4 segment=${spriteMapLightingMarker}Read(${shadowSegmentTexelOffset}.0+float(s));hit=max(hit,${spriteMapLightingMarker}Intersects(lightPosition,point,segment.xy,segment.zw));}return hit;}
vec3 ${spriteMapLightingMarker}Evaluate(vec2 point){if(${spriteMapLightingMarker}Enabled<0.5){return vec3(1.0);}vec3 result=vec3(0.0);for(int l=0;l<${maximumActiveLightsPerReceiver};l++){if(float(l)>=${spriteMapLightingMarker}LightCount){break;}float record=float(l*${lightRecordTexels});vec4 header=${spriteMapLightingMarker}Read(record);vec4 geometry=${spriteMapLightingMarker}Read(record+1.0);vec4 lightColor=${spriteMapLightingMarker}Read(record+2.0);vec4 angular=${spriteMapLightingMarker}Read(record+3.0);vec4 options=${spriteMapLightingMarker}Read(record+4.0);float attenuation=1.0;if(header.y>0.5&&header.y<1.5){float distanceToLight=distance(point,geometry.xy);float inner=min(geometry.z,angular.x);attenuation=distanceToLight<=inner?1.0:max(0.0,1.0-(distanceToLight-inner)/max(0.000001,geometry.z-inner));attenuation=pow(attenuation,1.0+geometry.w*7.0);if(angular.z<6.28317){float angle=atan(point.y-geometry.y,point.x-geometry.x);float difference=abs(atan(sin(angle-angular.w),cos(angle-angular.w)));float outer=angular.z*0.5;float innerAngle=angular.y*0.5;attenuation*=difference>=outer?0.0:(difference<=innerAngle?1.0:1.0-(difference-innerAngle)/max(0.000001,outer-innerAngle));}}else if(header.y>1.5){attenuation=${spriteMapLightingMarker}InsidePolygon(point,record,header.z);}if(attenuation>0.0&&header.y>0.5&&options.x>0.0){attenuation*=1.0-${spriteMapLightingMarker}Shadow(geometry.xy,point)*options.x;}float alpha=lightColor.a*attenuation;if(header.w>0.5){result=mix(result,lightColor.rgb,clamp(alpha,0.0,1.0));}else{result+=lightColor.rgb*alpha;}}return max(result,vec3(0.0));}
`;
}

function patchSpriteMapLightingShader(spriteMap: any): ShaderMaterial {
	patchSpriteMapVertexShader();
	const shaderName = `spriteMap${spriteMap.name}PixelShader`;
	const source = Effect.ShadersStore[shaderName];
	if (!source) {
		throw new Error(`SpriteMap shader "${shaderName}" is unavailable for Light2D.`);
	}
	if (!source.includes(spriteMapLightingMarker)) {
		const declaration = "uniform vec3 colorMul;";
		const multiplication = "color.xyz*=colorMul;";
		if (!source.includes(declaration) || !source.includes(multiplication)) {
			throw new Error("Babylon SpriteMap fragment shader layout changed; Light2D cannot be installed safely.");
		}
		Effect.ShadersStore[shaderName] = source
			.replace(declaration, `${declaration}${spriteMapLightingShaderFunctions()}`)
			.replace(multiplication, `${multiplication}color.xyz*=${spriteMapLightingMarker}Evaluate(${spriteMapLightingMarker}WorldPosition.xy);`);
	}
	const material = spriteMap._material as ShaderMaterial;
	material.options.uniforms.push(
		...[`${spriteMapLightingMarker}Enabled`, `${spriteMapLightingMarker}LightCount`, `${spriteMapLightingMarker}ShadowSegmentCount`].filter(
			(name) => !material.options.uniforms.includes(name)
		)
	);
	if (!material.options.samplers.includes(`${spriteMapLightingMarker}Data`)) {
		material.options.samplers.push(`${spriteMapLightingMarker}Data`);
	}
	material.markDirty();
	return material;
}

function receiverLights(lights: IResolvedLight2D[], receiverNode: Node): IResolvedLight2D[] {
	return lights.filter((light) => affectsLayer(light.data.targetSortingLayerIds, sortingLayerId(receiverNode))).slice(0, maximumActiveLightsPerReceiver);
}

function receiverCasterSegments(casters: IResolvedShadowCaster2D[], receiverNode: Node): Array<[number, number, number, number]> {
	const segments: Array<[number, number, number, number]> = [];
	for (const caster of casters) {
		if (!affectsLayer(caster.data.targetSortingLayerIds, sortingLayerId(receiverNode))) {
			continue;
		}
		if (!casterAffectsReceiver(caster, receiverNode)) {
			continue;
		}
		for (let index = 0; index < caster.worldPoints.length; index++) {
			const start = caster.worldPoints[index];
			const end = caster.worldPoints[(index + 1) % caster.worldPoints.length];
			segments.push([start[0], start[1], end[0], end[1]]);
			if (segments.length >= maximumShadowCaster2DSegmentsPerReceiver) {
				return segments;
			}
		}
	}
	return segments;
}

function writeLightTexture(data: Float32Array, lights: IResolvedLight2D[], segments: Array<[number, number, number, number]>): void {
	data.fill(0);
	const write = (texel: number, values: readonly number[]): void => {
		data.set(values, texel * 4);
	};
	lights.forEach((light, index) => {
		const record = index * lightRecordTexels;
		const kind = light.shape.kind === "global" ? 0 : light.shape.kind === "radial" ? 1 : 2;
		write(record, [1, kind, light.worldPoints.length, light.data.overlapOperation === "alpha-blend" ? 1 : 0]);
		write(record + 1, [light.worldCenter[0], light.worldCenter[1], light.worldRadius, light.data.falloffIntensity]);
		write(record + 2, [light.data.color[0], light.data.color[1], light.data.color[2], light.data.color[3] * light.data.intensity]);
		write(record + 3, [light.data.innerRadius, (light.data.innerAngleDegrees * Math.PI) / 180, (light.data.outerAngleDegrees * Math.PI) / 180, light.worldDirectionRadians]);
		write(record + 4, [light.data.shadowsEnabled ? light.data.shadowIntensity : 0, light.data.lightOrder, 0, 0]);
		light.worldPoints.forEach((point, pointIndex) => write(record + 5 + pointIndex, [point[0], point[1], 0, 0]));
	});
	segments.forEach((segment, index) => write(shadowSegmentTexelOffset + index, segment));
}

function applySpriteMapLighting(scene: Scene, runtime: ILighting2DRuntime, owner: SpriteMapNode, lights: IResolvedLight2D[], casters: IResolvedShadowCaster2D[]): void {
	const spriteMap = owner.spriteMap as any;
	if (!spriteMap) {
		return;
	}
	let state = runtime.spriteMapStates.get(spriteMap);
	if (!state) {
		const data = new Float32Array(lightDataTextureWidth * 4);
		const texture = RawTexture.CreateRGBATexture(data, lightDataTextureWidth, 1, scene, false, false, Texture.NEAREST_NEAREST, Constants.TEXTURETYPE_FLOAT);
		texture.name = `${owner.name}:Light2DData`;
		state = { data, texture, material: patchSpriteMapLightingShader(spriteMap) };
		runtime.spriteMapStates.set(spriteMap, state);
	}
	const selectedLights = receiverLights(lights, owner);
	const segments = receiverCasterSegments(casters, owner);
	writeLightTexture(state.data, selectedLights, segments);
	state.texture.update(state.data);
	state.material.setTexture(`${spriteMapLightingMarker}Data`, state.texture);
	state.material.setFloat(`${spriteMapLightingMarker}Enabled`, selectedLights.length ? 1 : 0);
	state.material.setFloat(`${spriteMapLightingMarker}LightCount`, selectedLights.length);
	state.material.setFloat(`${spriteMapLightingMarker}ShadowSegmentCount`, segments.length);
}

function disposeOrphanSpriteMaps(runtime: ILighting2DRuntime, active: Set<object>): void {
	for (const [spriteMap, state] of runtime.spriteMapStates) {
		if (!active.has(spriteMap)) {
			try {
				state.material.setFloat(`${spriteMapLightingMarker}Enabled`, 0);
			} catch {
				// The owning SpriteMap may already have disposed its material.
			}
			try {
				state.texture.dispose();
			} catch {
				// Consumer cleanup must not interrupt the scene frame.
			}
			runtime.spriteMapStates.delete(spriteMap);
		}
	}
}

function evaluateLightingFrame(scene: Scene, runtime: ILighting2DRuntime): void {
	const started = elapsedStart();
	const deltaTimeSeconds = Math.min(1, Math.max(0, scene.getEngine().getDeltaTime() / 1000 || 1 / 60));
	const seen = new Set<string>();
	const lights = resolveLightRows(scene, runtime, deltaTimeSeconds, seen);
	const casters = resolveShadowRows(scene, runtime, deltaTimeSeconds, seen);
	const frameWarnings: string[] = [];
	for (const [key, state] of runtime.providerStates) {
		if (!seen.has(key)) {
			destroyProviderState(state);
			runtime.providerStates.delete(key);
		}
	}
	let litSpriteCount = 0;
	let spriteManagerCount = 0;
	const activeLitSprites = new Set<Sprite>();
	const spriteManagerOwners = scene.transformNodes.filter((node): node is SpriteManagerNode =>
		Boolean((node as SpriteManagerNode).isSpriteManager && (node as SpriteManagerNode).spriteManager)
	);
	for (const owner of spriteManagerOwners) {
		const manager = owner.spriteManager!;
		try {
			installSpriteManagerLightingHook(manager);
		} catch (error) {
			frameWarnings.push(`SpriteManager "${manager.name}" Light2D consumer is unavailable: ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const selectedLights = receiverLights(lights, owner);
		for (const sprite of manager.sprites) {
			spriteLightingMultipliers.set(sprite, evaluateLighting2DAtPoint([sprite.position.x, sprite.position.y], selectedLights, casters, owner));
			activeLitSprites.add(sprite);
			litSpriteCount++;
		}
		spriteManagerCount++;
	}
	for (const sprite of runtime.litSprites) {
		if (!activeLitSprites.has(sprite)) {
			spriteLightingMultipliers.delete(sprite);
		}
	}
	runtime.litSprites = activeLitSprites;
	const activeSpriteMaps = new Set<object>();
	const spriteMapOwners = scene.transformNodes.filter((node): node is SpriteMapNode => Boolean((node as SpriteMapNode).isSpriteMap && (node as SpriteMapNode).spriteMap));
	for (const owner of spriteMapOwners) {
		try {
			applySpriteMapLighting(scene, runtime, owner, lights, casters);
			activeSpriteMaps.add(owner.spriteMap!);
		} catch (error) {
			frameWarnings.push(`SpriteMap "${owner.name}" Light2D consumer is unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	disposeOrphanSpriteMaps(runtime, activeSpriteMaps);
	runtime.frameCount++;
	runtime.lastFrameAt = new Date().toISOString();
	runtime.lastFrameDurationMilliseconds = elapsedStart() - started;
	runtime.activeLightCount = lights.length;
	runtime.activeCasterCount = casters.length;
	runtime.spriteManagerCount = spriteManagerCount;
	runtime.litSpriteCount = litSpriteCount;
	runtime.spriteMapCount = spriteMapOwners.length;
	runtime.droppedLightCount = Math.max(0, lights.length - maximumActiveLightsPerReceiver);
	const casterSegmentCount = casters.reduce((sum, caster) => sum + caster.worldPoints.length, 0);
	runtime.droppedCasterSegmentCount = Math.max(0, casterSegmentCount - maximumShadowCaster2DSegmentsPerReceiver);
	runtime.warnings = [
		...frameWarnings.slice(0, 8),
		...(componentRows(scene, "light2d").length >= maximumLighting2DComponents ? [`Light2D inspection is capped at ${maximumLighting2DComponents} components.`] : []),
		...(componentRows(scene, "shadowcaster2d").length >= maximumLighting2DComponents
			? [`ShadowCaster2D inspection is capped at ${maximumLighting2DComponents} components.`]
			: []),
		...(runtime.droppedLightCount ? [`${runtime.droppedLightCount} light(s) exceed the per-receiver limit of ${maximumActiveLightsPerReceiver}.`] : []),
		...(runtime.droppedCasterSegmentCount
			? [`${runtime.droppedCasterSegmentCount} caster edge(s) exceed the per-receiver limit of ${maximumShadowCaster2DSegmentsPerReceiver}.`]
			: []),
	];
}

function evaluateFrame(scene: Scene, runtime: ILighting2DRuntime): void {
	if (runtime.evaluating) {
		return;
	}
	runtime.evaluating = true;
	try {
		evaluateLightingFrame(scene, runtime);
	} finally {
		runtime.evaluating = false;
	}
}

function observerIsRegistered(scene: Scene, observer: Observer<Scene> | null): boolean {
	return Boolean(observer && scene.onBeforeRenderObservable.observers.includes(observer));
}

export function configureLighting2D(scene: Scene): void {
	let runtime = lighting2DRuntimes.get(scene);
	if (!runtime) {
		runtime = {
			observer: null,
			disposeObserver: null,
			evaluating: false,
			providerStates: new Map(),
			spriteMapStates: new Map(),
			litSprites: new Set(),
			frameCount: 0,
			configuredAt: new Date().toISOString(),
			lastFrameAt: null,
			lastFrameDurationMilliseconds: 0,
			activeLightCount: 0,
			activeCasterCount: 0,
			spriteManagerCount: 0,
			litSpriteCount: 0,
			spriteMapCount: 0,
			droppedLightCount: 0,
			droppedCasterSegmentCount: 0,
			warnings: [],
		};
		lighting2DRuntimes.set(scene, runtime);
		runtime.disposeObserver = scene.onDisposeObservable.add(() => disposeLighting2D(scene));
	}
	if (!observerIsRegistered(scene, runtime.observer)) {
		runtime.observer = scene.onBeforeRenderObservable.add(() => evaluateFrame(scene, runtime!));
	}
	// Make authoring changes visible before the next rendered frame and allow headless diagnostics.
	evaluateFrame(scene, runtime);
}

export function disposeLighting2D(scene: Scene): void {
	const runtime = lighting2DRuntimes.get(scene);
	if (!runtime) {
		return;
	}
	if (runtime.observer) {
		scene.onBeforeRenderObservable.remove(runtime.observer);
	}
	if (runtime.disposeObserver) {
		scene.onDisposeObservable.remove(runtime.disposeObserver);
	}
	for (const state of runtime.providerStates.values()) {
		destroyProviderState(state);
	}
	for (const state of runtime.spriteMapStates.values()) {
		try {
			state.material.setFloat(`${spriteMapLightingMarker}Enabled`, 0);
		} catch {
			// The owning SpriteMap may already have disposed its material.
		}
		try {
			state.texture.dispose();
		} catch {
			// Runtime cleanup must not interrupt scene disposal.
		}
	}
	for (const sprite of runtime.litSprites) {
		spriteLightingMultipliers.delete(sprite);
	}
	runtime.providerStates.clear();
	runtime.spriteMapStates.clear();
	runtime.litSprites.clear();
	lighting2DRuntimes.delete(scene);
}

export function getLighting2DRuntimeEvidence(scene: Scene): Record<string, unknown> {
	const runtime = lighting2DRuntimes.get(scene);
	return {
		configured: Boolean(runtime),
		configuredAt: runtime?.configuredAt ?? null,
		lastFrameAt: runtime?.lastFrameAt ?? null,
		frameCount: runtime?.frameCount ?? 0,
		lastFrameDurationMilliseconds: runtime?.lastFrameDurationMilliseconds ?? 0,
		activeLightCount: runtime?.activeLightCount ?? 0,
		activeCasterCount: runtime?.activeCasterCount ?? 0,
		spriteManagerCount: runtime?.spriteManagerCount ?? 0,
		litSpriteCount: runtime?.litSpriteCount ?? 0,
		spriteMapCount: runtime?.spriteMapCount ?? 0,
		droppedLightCount: runtime?.droppedLightCount ?? 0,
		droppedCasterSegmentCount: runtime?.droppedCasterSegmentCount ?? 0,
		providers: runtime ? [...runtime.providerStates.values()].map((state) => ({ ...state.evidence })) : [],
		warnings: runtime?.warnings ?? [],
		limits: {
			componentsPerKind: maximumLighting2DComponents,
			activeLightsPerReceiver: maximumActiveLightsPerReceiver,
			lightShapePoints: maximumLight2DShapePoints,
			shadowShapePoints: maximumShadowCaster2DShapePoints,
			shadowSegmentsPerReceiver: maximumShadowCaster2DSegmentsPerReceiver,
			providerDataBytes: maximumLighting2DProviderDataBytes,
		},
	};
}

registerLight2DProvider({
	id: "builtin.global",
	displayName: "Global",
	description: "Shapeless light that affects every receiver in its selected sorting layers.",
	dataVersion: 1,
	menuPriority: 0,
	usesNodeData: false,
	getShape: () => ({ kind: "global" }),
});

registerLight2DProvider({
	id: "builtin.point",
	displayName: "Point",
	description: "Circular or sector-shaped radial light using the Light2D radius and angle controls.",
	dataVersion: 1,
	menuPriority: 10,
	getShape: (context) => ({ kind: "radial", center: [0, 0], radius: context.component.outerRadius }),
});

registerLight2DProvider({
	id: "builtin.freeform",
	displayName: "Freeform",
	description: "Closed polygon light authored from bounded local shape points.",
	dataVersion: 1,
	menuPriority: 20,
	getShape: (context) => ({ kind: "polygon", points: context.component.shapePath }),
});

registerLight2DProvider({
	id: "builtin.sprite",
	displayName: "Sprite Bounds",
	description: "Polygon light derived from the source node bounds; sprite alpha silhouettes can be supplied by a custom provider.",
	dataVersion: 1,
	menuPriority: 30,
	getShape: (context) => ({ kind: "polygon", points: nodeBoundsShape(context.node) }),
});

registerShadowShape2DProvider({
	id: "builtin.shape-editor",
	displayName: "Shape Editor",
	description: "Uses the ShadowCaster2D component's explicitly authored closed path.",
	dataVersion: 1,
	menuPriority: 0,
	onBeforeRender: (context, writer) => writer.setShape(context.component.shapePath),
});

registerShadowShape2DProvider({
	id: "builtin.node-bounds",
	displayName: "Node Bounds",
	description: "Uses the current local bounds of a Babylon render node as the persistent caster shape.",
	dataVersion: 1,
	menuPriority: 10,
	onBeforeRender: (context, writer) => writer.setShape(nodeBoundsShape(context.node)),
});
