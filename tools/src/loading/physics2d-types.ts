import type { IPhysics2DPoint, IPhysics2DPolygonContour } from "./physics2d-polygons";

export const Physics2DBodyContractVersion = 3;
export const MaxPhysics2DCoordinate = 1_000_000;
export const MaxPhysics2DPolygonParts = 4096;
/** Prevents malformed scene metadata from creating unbounded per-frame work. */
export const MaxPhysics2DBodies = 2048;

export type Physics2DBodyType = "dynamic" | "kinematic" | "static";
export type Physics2DCollisionDetectionMode = "discrete" | "continuous";

/** Per-body layer decisions stay explicit so editor and exported runtime resolve conflicts identically. */
export interface IPhysics2DLayerOverrides {
	priority: number;
	includeLayers: number;
	excludeLayers: number;
	forceSendLayers: number;
	forceReceiveLayers: number;
	callbackLayers: number;
	contactCaptureLayers: number;
}

/** One bounded local-space collider; compound polygon pieces remain derived authoring data. */
export interface IPhysics2DColliderConfiguration {
	shape: "box" | "circle" | "capsule" | "polygon" | "edge";
	worldDrawing: boolean;
	offset: IPhysics2DPoint;
	density: number;
	size?: IPhysics2DPoint;
	radius?: number;
	direction?: "horizontal" | "vertical";
	edgeRadius?: number;
	points?: IPhysics2DPoint[];
	parts?: IPhysics2DPoint[][];
	contours?: IPhysics2DPolygonContour[];
	model?: string;
	version?: number;
	revision?: number;
}

/** Canonical persisted body state shared by the Inspector, MCP bridge, and generated games. */
export interface IPhysics2DBodyConfiguration {
	version: typeof Physics2DBodyContractVersion;
	revision: number;
	nodeId: string;
	worldId: string;
	worldDrawing: boolean;
	enabled: boolean;
	bodyType: Physics2DBodyType;
	collider: IPhysics2DColliderConfiguration;
	velocity: IPhysics2DPoint;
	angularVelocity: number;
	mass: number;
	useAutoMass: boolean;
	inertia: number;
	useAutoInertia: boolean;
	centerOfMass: IPhysics2DPoint;
	useAutoCenterOfMass: boolean;
	gravity: IPhysics2DPoint;
	gravityScale: number;
	linearDamping: number;
	angularDamping: number;
	freezePositionX: boolean;
	freezePositionY: boolean;
	freezeRotation: boolean;
	collisionDetection: Physics2DCollisionDetectionMode;
	isTrigger: boolean;
	usedByEffector: boolean;
	collisionLayer: number;
	layerOverrides: IPhysics2DLayerOverrides;
	materialId?: string;
	friction?: number;
	restitution?: number;
}

/** Validation is non-throwing so malformed legacy metadata can be skipped without breaking a scene. */
export type IPhysics2DBodyValidationResult = { ok: true; value: IPhysics2DBodyConfiguration } | { ok: false; error: string };

/** Rejects arrays because authoring objects must use named fields. */
function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Applies a default only to absent fields; explicitly malformed values always fail closed. */
function number(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
	const candidate = value === undefined ? fallback : value;
	return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum ? candidate : null;
}

/** Keeps revision, layer, and mask fields integral after the shared finite-range check. */
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
	const candidate = number(value, fallback, minimum, maximum);
	return candidate !== null && Number.isInteger(candidate) ? candidate : null;
}

/** Copies a finite two-component value so normalization never aliases mutable scene metadata. */
function point(value: unknown, fallback: IPhysics2DPoint, minimum = -MaxPhysics2DCoordinate, maximum = MaxPhysics2DCoordinate): IPhysics2DPoint | null {
	const candidate = value === undefined ? fallback : value;
	if (!Array.isArray(candidate) || candidate.length !== 2) {
		return null;
	}
	const x = typeof candidate[0] === "number" && Number.isFinite(candidate[0]) && candidate[0] >= minimum && candidate[0] <= maximum ? candidate[0] : null;
	const y = typeof candidate[1] === "number" && Number.isFinite(candidate[1]) && candidate[1] >= minimum && candidate[1] <= maximum ? candidate[1] : null;
	return x === null || y === null ? null : [x, y];
}

/** Bounds authoring work before allocating or traversing collider vertices. */
function pointList(value: unknown, minimumLength: number, maximumLength: number): IPhysics2DPoint[] | null {
	if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
		return null;
	}
	const result = value.map((candidate) => point(candidate, [0, 0]));
	return result.some((candidate) => candidate === null) ? null : (result as IPhysics2DPoint[]);
}

/** Structurally validates contour identities and vertex ceilings; geometric validity stays with the decomposition module. */
function polygonContours(value: unknown): IPhysics2DPolygonContour[] | null {
	if (!Array.isArray(value) || !value.length || value.length > 16) {
		return null;
	}
	const ids = new Set<string>();
	let vertices = 0;
	const result: IPhysics2DPolygonContour[] = [];
	for (const candidate of value) {
		const source = record(candidate);
		const points = pointList(source?.points, 3, 128);
		const holes = source?.holes;
		if (!source || typeof source.id !== "string" || !source.id || source.id.length > 128 || ids.has(source.id) || !points || !Array.isArray(holes) || holes.length > 16) {
			return null;
		}
		ids.add(source.id);
		const normalizedHoles = holes.map((candidateHole) => {
			const hole = record(candidateHole);
			const holePoints = pointList(hole?.points, 3, 128);
			if (!hole || typeof hole.id !== "string" || !hole.id || hole.id.length > 128 || ids.has(hole.id) || !holePoints) {
				return null;
			}
			ids.add(hole.id);
			vertices += holePoints.length;
			return { id: hole.id, points: holePoints };
		});
		vertices += points.length;
		if (normalizedHoles.some((hole) => hole === null) || vertices > 512) {
			return null;
		}
		result.push({ id: source.id, points, holes: normalizedHoles as IPhysics2DPolygonContour["holes"] });
	}
	return result;
}

/** Normalizes every supported shape while preserving only validated derived polygon data. */
function collider(value: unknown): IPhysics2DColliderConfiguration | null {
	const source = record(value);
	const shape = source?.shape;
	const offset = point(source?.offset, [0, 0]);
	const density = number(source?.density, 0.001, 0.000000001, 1000);
	const worldDrawing = source?.worldDrawing ?? false;
	if (
		!source ||
		!offset ||
		density === null ||
		typeof worldDrawing !== "boolean" ||
		typeof shape !== "string" ||
		!["box", "circle", "capsule", "polygon", "edge"].includes(shape)
	) {
		return null;
	}
	if (shape === "box") {
		const size = point(source.size, [100, 100], 0.001, MaxPhysics2DCoordinate);
		return size ? { shape, worldDrawing, offset, density, size } : null;
	}
	if (shape === "capsule") {
		const size = point(source.size, [100, 100], 0.001, MaxPhysics2DCoordinate);
		const direction = source.direction === undefined ? "vertical" : source.direction;
		return size && (direction === "horizontal" || direction === "vertical") ? { shape, worldDrawing, offset, density, size, direction } : null;
	}
	if (shape === "circle") {
		const radius = number(source.radius, 50, 0.001, MaxPhysics2DCoordinate);
		return radius === null ? null : { shape, worldDrawing, offset, density, radius };
	}
	const minimumPoints = shape === "edge" ? 2 : 3;
	const points = pointList(source.points, minimumPoints, 512);
	const parts =
		source.parts === undefined
			? undefined
			: Array.isArray(source.parts) && source.parts.length >= 1 && source.parts.length <= MaxPhysics2DPolygonParts
				? source.parts.map((part) => pointList(part, 3, 128))
				: null;
	const colliderVersion = source.version === undefined ? undefined : integer(source.version, 1, 1, Physics2DBodyContractVersion);
	const colliderRevision = source.revision === undefined ? undefined : integer(source.revision, 1, 1, Number.MAX_SAFE_INTEGER);
	const contours = source.contours === undefined ? undefined : polygonContours(source.contours);
	if (
		!points ||
		(shape === "edge" && points.slice(1).some((candidate, index) => Math.hypot(candidate[0] - points[index][0], candidate[1] - points[index][1]) <= 0.000001)) ||
		parts === null ||
		parts?.some((part) => part === null) ||
		colliderVersion === null ||
		colliderRevision === null ||
		contours === null ||
		(source.model !== undefined && (typeof source.model !== "string" || !source.model || source.model.length > 128))
	) {
		return null;
	}
	const edgeRadius = number(source.edgeRadius, 0, 0, MaxPhysics2DCoordinate);
	return edgeRadius === null
		? null
		: {
				shape: shape as "polygon" | "edge",
				worldDrawing,
				offset,
				density,
				points,
				edgeRadius,
				...(parts ? { parts: parts as IPhysics2DPoint[][] } : {}),
				...(contours ? { contours } : {}),
				...(typeof source.model === "string" ? { model: source.model } : {}),
				...(colliderVersion !== undefined ? { version: colliderVersion } : {}),
				...(colliderRevision !== undefined ? { revision: colliderRevision } : {}),
			};
}

/** Converts legacy metadata into the bounded v3 body contract without mutating saved project data. */
export function normalizePhysics2DBodyConfiguration(value: unknown): IPhysics2DBodyValidationResult {
	const source = record(value);
	const nodeId = source?.nodeId;
	const bodyType = source?.bodyType ?? "dynamic";
	const worldId = source?.worldId ?? "default";
	const normalizedCollider = collider(source?.collider);
	if (
		!source ||
		typeof nodeId !== "string" ||
		!nodeId ||
		nodeId.length > 256 ||
		typeof worldId !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(worldId) ||
		typeof bodyType !== "string" ||
		!["dynamic", "kinematic", "static"].includes(bodyType) ||
		!normalizedCollider
	) {
		return { ok: false, error: "Physics 2D body requires a valid nodeId, bodyType, and bounded collider." };
	}
	const revision = integer(source.revision, 1, 1, Number.MAX_SAFE_INTEGER);
	const sourceVersion = integer(source.version, 1, 1, Physics2DBodyContractVersion);
	const velocity = point(source.velocity, [0, 0]);
	const angularVelocity = number(source.angularVelocity, 0, -100_000, 100_000);
	const mass = number(source.mass, 1, 0.001, 1_000_000_000);
	const inertia = number(source.inertia, 1, 0.001, 1_000_000_000_000);
	const centerOfMass = point(source.centerOfMass, [0, 0]);
	const gravity = point(source.gravity, [0, -981]);
	const gravityScale = number(source.gravityScale, 1, -100, 100);
	const linearDamping = number(source.linearDamping, 0, 0, 0.999);
	const angularDamping = number(source.angularDamping, 0.05, 0, 0.999);
	const collisionLayer = integer(source.collisionLayer, 0, 0, 31);
	const collisionDetection = source.collisionDetection ?? "discrete";
	const overrides = record(source.layerOverrides) ?? {};
	const priority = integer(overrides.priority, 0, -256, 256);
	const masks = ["includeLayers", "excludeLayers", "forceSendLayers", "forceReceiveLayers", "callbackLayers", "contactCaptureLayers"] as const;
	const normalizedMasks = masks.map((key) => integer(overrides[key], key === "includeLayers" || key === "excludeLayers" ? 0 : 0xffffffff, 0, 0xffffffff));
	const friction = source.friction === undefined ? undefined : number(source.friction, 0, 0, 1);
	const restitution = source.restitution === undefined ? undefined : number(source.restitution, 0, 0, 1);
	const booleanKeys = [
		"enabled",
		"useAutoMass",
		"useAutoInertia",
		"useAutoCenterOfMass",
		"freezePositionX",
		"freezePositionY",
		"freezeRotation",
		"isTrigger",
		"usedByEffector",
		"worldDrawing",
	] as const;
	if (
		[
			sourceVersion,
			revision,
			angularVelocity,
			mass,
			inertia,
			gravityScale,
			linearDamping,
			angularDamping,
			collisionLayer,
			priority,
			friction,
			restitution,
			...normalizedMasks,
		].some((candidate) => candidate === null) ||
		booleanKeys.some((key) => source[key] !== undefined && typeof source[key] !== "boolean") ||
		(source.layerOverrides !== undefined && !record(source.layerOverrides)) ||
		(source.materialId !== undefined && (typeof source.materialId !== "string" || !source.materialId || source.materialId.length > 256)) ||
		!velocity ||
		!centerOfMass ||
		!gravity ||
		(collisionDetection !== "discrete" && collisionDetection !== "continuous")
	) {
		return { ok: false, error: `Physics 2D body "${nodeId}" contains non-finite or out-of-range values.` };
	}
	return {
		ok: true,
		value: {
			version: Physics2DBodyContractVersion,
			revision: revision!,
			nodeId,
			worldId,
			worldDrawing: source.worldDrawing === true,
			enabled: source.enabled !== false,
			bodyType: bodyType as Physics2DBodyType,
			collider: normalizedCollider,
			velocity,
			angularVelocity: angularVelocity!,
			mass: mass!,
			useAutoMass: source.useAutoMass === true,
			inertia: inertia!,
			useAutoInertia: source.useAutoInertia !== false,
			centerOfMass,
			useAutoCenterOfMass: source.useAutoCenterOfMass !== false,
			gravity,
			gravityScale: gravityScale!,
			linearDamping: linearDamping!,
			angularDamping: angularDamping!,
			freezePositionX: source.freezePositionX === true,
			freezePositionY: source.freezePositionY === true,
			freezeRotation: source.freezeRotation === true,
			collisionDetection,
			isTrigger: source.isTrigger === true,
			usedByEffector: source.usedByEffector !== false,
			collisionLayer: collisionLayer!,
			layerOverrides: {
				priority: priority!,
				includeLayers: normalizedMasks[0]!,
				excludeLayers: normalizedMasks[1]!,
				forceSendLayers: normalizedMasks[2]!,
				forceReceiveLayers: normalizedMasks[3]!,
				callbackLayers: normalizedMasks[4]!,
				contactCaptureLayers: normalizedMasks[5]!,
			},
			...(typeof source.materialId === "string" && source.materialId ? { materialId: source.materialId } : {}),
			...(friction !== undefined ? { friction: friction! } : {}),
			...(restitution !== undefined ? { restitution: restitution! } : {}),
		},
	};
}
