import { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";
import type { Light } from "@babylonjs/core/Lights/light";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";

export const areaLightMetadataKey = "babylonEditorAreaLight" as const;
export const areaLightBackend = "unity-style-area-light-v1" as const;
export const areaLightDiscSegments = 16;

export type AreaLightShape = "rectangle" | "disc";

export interface IAreaLightMetadata {
	version: 1;
	revision: number;
	shape: AreaLightShape;
	width: number;
	height: number;
	radius: number;
	direction: [number, number, number];
	upDirection: [number, number, number];
}

export interface IAreaLightBasis {
	position: Vector3;
	direction: Vector3;
	right: Vector3;
	up: Vector3;
	halfWidth: Vector3;
	halfHeight: Vector3;
}

export interface IAreaLightEvidence extends IAreaLightMetadata {
	backend: typeof areaLightBackend;
	lightId: string;
	lightName: string;
	enabled: boolean;
	intensity: number;
	range: number;
	diffuse: [number, number, number];
	position: [number, number, number];
	worldDirection: [number, number, number];
	worldRight: [number, number, number];
	worldUp: [number, number, number];
	worldHalfWidth: [number, number, number];
	worldHalfHeight: [number, number, number];
	area: number;
	oneSided: true;
	nativeForwardModel: "babylon-ltc-rectangle" | "bounded-ltc-disc-rectangle";
	deferredModel: "babylon-ltc-rectangle" | "bounded-ltc-disc-16-gon";
	bakedModel: "deterministic-stratified-rectangle" | "deterministic-concentric-disc";
	castsRealtimeShadows: false;
}

interface IRectAreaLightInternals {
	_width: Vector3;
	_height: Vector3;
	_markMeshesAsLightDirty?: () => void;
}

function finite(value: unknown, fallback: number, minimum: number, maximum: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function positive(value: unknown, fallback: number): number {
	return finite(value, fallback, 0.0001, 10_000_000);
}

function tuple3(value: unknown, fallback: [number, number, number]): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
		return [...fallback];
	}
	const vector = Vector3.FromArray(value);
	if (vector.lengthSquared() < 0.000001) {
		return [...fallback];
	}
	vector.normalize();
	return vector.asArray() as [number, number, number];
}

function localBasis(metadata: IAreaLightMetadata): { direction: Vector3; right: Vector3; up: Vector3 } {
	const direction = Vector3.FromArray(metadata.direction).normalize();
	let up = Vector3.FromArray(metadata.upDirection).normalize();
	up.subtractInPlace(direction.scale(Vector3.Dot(up, direction)));
	if (up.lengthSquared() < 0.000001) {
		up = Math.abs(direction.y) < 0.999 ? Vector3.Up() : Vector3.Right();
		up.subtractInPlace(direction.scale(Vector3.Dot(up, direction)));
	}
	up.normalize();
	const right = Vector3.Cross(direction, up).normalize();
	up = Vector3.Cross(right, direction).normalize();
	return { direction, right, up };
}

function writeMetadata(light: RectAreaLight, metadata: IAreaLightMetadata): void {
	light.metadata ??= {};
	light.metadata[areaLightMetadataKey] = metadata;
}

function applyNativeBasis(light: RectAreaLight, metadata: IAreaLightMetadata): void {
	const { right, up } = localBasis(metadata);
	const width = metadata.shape === "disc" ? metadata.radius * 2 : metadata.width;
	const height = metadata.shape === "disc" ? metadata.radius * 2 : metadata.height;
	const native = light as unknown as IRectAreaLightInternals;
	native._width.copyFrom(right.scale(width));
	native._height.copyFrom(up.scale(height));
	native._markMeshesAsLightDirty?.();
}

export function isAreaLight(light: unknown): light is RectAreaLight {
	return Boolean(light && typeof light === "object" && (light as Light).getTypeID?.() === 4 && (light as Light).getClassName?.() === "RectAreaLight");
}

/** Returns normalized portable metadata without changing the scene. */
export function getAreaLightMetadata(light: RectAreaLight): IAreaLightMetadata {
	const source = light.metadata?.[areaLightMetadataKey] as Partial<IAreaLightMetadata> | undefined;
	const shape: AreaLightShape = source?.shape === "disc" ? "disc" : "rectangle";
	const width = positive(source?.width, positive(light.width, 100));
	const height = positive(source?.height, positive(light.height, 100));
	const radius = positive(source?.radius, Math.max(width, height) * 0.5);
	return {
		version: 1,
		revision: Number.isInteger(source?.revision) && source!.revision! > 0 ? source!.revision! : 1,
		shape,
		width,
		height,
		radius,
		direction: tuple3(source?.direction, [0, 0, -1]),
		upDirection: tuple3(source?.upDirection, [0, 1, 0]),
	};
}

export interface ISetAreaLightOptions {
	shape?: AreaLightShape;
	width?: number;
	height?: number;
	radius?: number;
	direction?: [number, number, number];
	upDirection?: [number, number, number];
	revision?: number;
}

/** Applies one Unity-style rectangle or disc authoring state to Babylon's native LTC area-light holder. */
export function setAreaLightProperties(light: RectAreaLight, options: ISetAreaLightOptions): IAreaLightEvidence {
	if (!isAreaLight(light)) {
		throw new Error("Unity-style area-light properties require a Babylon RectAreaLight holder.");
	}
	const current = getAreaLightMetadata(light);
	const shape = options.shape ?? current.shape;
	const metadata: IAreaLightMetadata = {
		version: 1,
		revision: options.revision ?? current.revision + 1,
		shape,
		width: positive(options.width, current.width),
		height: positive(options.height, current.height),
		radius: positive(options.radius, current.radius),
		direction: tuple3(options.direction, current.direction),
		upDirection: tuple3(options.upDirection, current.upDirection),
	};
	writeMetadata(light, metadata);
	applyNativeBasis(light, metadata);
	return getAreaLightEvidence(light);
}

/** Creates a regular scene-owned area light with the same portable model used by editor, MCP, export, and runtime loaders. */
export function createAreaLight(
	name: string,
	position: Vector3,
	shape: AreaLightShape,
	scene: Scene,
	options: Omit<ISetAreaLightOptions, "shape" | "revision"> = {}
): RectAreaLight {
	const width = positive(options.width, 100);
	const height = positive(options.height, 100);
	const radius = positive(options.radius, 50);
	const light = new RectAreaLight(name, position, shape === "disc" ? radius * 2 : width, shape === "disc" ? radius * 2 : height, scene);
	setAreaLightProperties(light, { ...options, shape, width, height, radius, revision: 1 });
	return light;
}

/** Returns the oriented world-space area basis used by deferred lighting and deterministic baking. */
export function getAreaLightBasis(light: RectAreaLight): IAreaLightBasis {
	const metadata = getAreaLightMetadata(light);
	const local = localBasis(metadata);
	const halfWidthLength = (metadata.shape === "disc" ? metadata.radius * 2 : metadata.width) * 0.5;
	const halfHeightLength = (metadata.shape === "disc" ? metadata.radius * 2 : metadata.height) * 0.5;
	let position = light.position.clone();
	let direction = local.direction;
	let right = local.right;
	let up = local.up;
	if (light.parent?.getWorldMatrix) {
		const parentWorld = light.parent.getWorldMatrix();
		position = Vector3.TransformCoordinates(position, parentWorld);
		direction = Vector3.TransformNormal(direction, parentWorld).normalize();
		right = Vector3.TransformNormal(right, parentWorld).normalize();
		up = Vector3.TransformNormal(up, parentWorld).normalize();
	}
	return {
		position,
		direction,
		right,
		up,
		halfWidth: right.scale(halfWidthLength),
		halfHeight: up.scale(halfHeightLength),
	};
}

/** Produces deterministic surface samples for soft baked shadows and SH probe integration. */
export function getAreaLightSamplePoints(light: RectAreaLight, count = areaLightDiscSegments): Vector3[] {
	const sampleCount = Math.max(1, Math.min(64, Math.floor(count)));
	const metadata = getAreaLightMetadata(light);
	const basis = getAreaLightBasis(light);
	if (metadata.shape === "disc") {
		const goldenAngle = Math.PI * (3 - Math.sqrt(5));
		return Array.from({ length: sampleCount }, (_, index) => {
			const radial = Math.sqrt((index + 0.5) / sampleCount);
			const angle = index * goldenAngle;
			return basis.position.add(basis.halfWidth.scale(Math.cos(angle) * radial)).addInPlace(basis.halfHeight.scale(Math.sin(angle) * radial));
		});
	}
	const columns = Math.ceil(Math.sqrt(sampleCount));
	const rows = Math.ceil(sampleCount / columns);
	return Array.from({ length: sampleCount }, (_, index) => {
		const column = index % columns;
		const row = Math.floor(index / columns);
		const x = ((column + 0.5) / columns) * 2 - 1;
		const y = ((row + 0.5) / rows) * 2 - 1;
		return basis.position.add(basis.halfWidth.scale(x)).addInPlace(basis.halfHeight.scale(y));
	});
}

export function getAreaLightEvidence(light: RectAreaLight): IAreaLightEvidence {
	const metadata = getAreaLightMetadata(light);
	const basis = getAreaLightBasis(light);
	return {
		backend: areaLightBackend,
		...metadata,
		lightId: light.id,
		lightName: light.name,
		enabled: light.isEnabled(),
		intensity: light.intensity,
		range: light.range,
		diffuse: light.diffuse.asArray() as [number, number, number],
		position: basis.position.asArray() as [number, number, number],
		worldDirection: basis.direction.asArray() as [number, number, number],
		worldRight: basis.right.asArray() as [number, number, number],
		worldUp: basis.up.asArray() as [number, number, number],
		worldHalfWidth: basis.halfWidth.asArray() as [number, number, number],
		worldHalfHeight: basis.halfHeight.asArray() as [number, number, number],
		area: metadata.shape === "disc" ? Math.PI * metadata.radius * metadata.radius : metadata.width * metadata.height,
		oneSided: true,
		nativeForwardModel: metadata.shape === "disc" ? "bounded-ltc-disc-rectangle" : "babylon-ltc-rectangle",
		deferredModel: metadata.shape === "disc" ? "bounded-ltc-disc-16-gon" : "babylon-ltc-rectangle",
		bakedModel: metadata.shape === "disc" ? "deterministic-concentric-disc" : "deterministic-stratified-rectangle",
		castsRealtimeShadows: false,
	};
}

/** Rehydrates all native/imported area lights after full or additive scene loading. */
export function configureAreaLights(scene: Scene, lights: Light[] = scene.lights): IAreaLightEvidence[] {
	const result: IAreaLightEvidence[] = [];
	for (const candidate of lights) {
		if (!isAreaLight(candidate)) {
			continue;
		}
		const metadata = getAreaLightMetadata(candidate);
		writeMetadata(candidate, metadata);
		applyNativeBasis(candidate, metadata);
		result.push(getAreaLightEvidence(candidate));
	}
	return result;
}
