import type { IPhysics2DPoint } from "./physics2d-polygons";
import { MaxPhysics2DCoordinate } from "./physics2d-types";

export const Physics2DJointContractVersion = 2;
export const Physics2DEffectorContractVersion = 2;
/** Bounds authored constraint work before a runtime starts iterating scene metadata. */
export const MaxPhysics2DJoints = 1024;
/** Bounds authored effector work before it becomes per-body, per-step work. */
export const MaxPhysics2DEffectors = 1024;

export const physics2DJointTypes = ["distance", "fixed", "friction", "hinge", "relative", "slider", "spring", "target", "wheel"] as const;
export type Physics2DJointType = (typeof physics2DJointTypes)[number];
export type Physics2DJointBreakAction = "ignore" | "callback-only" | "disable" | "destroy";

export interface IPhysics2DJointBaseConfiguration {
	version: typeof Physics2DJointContractVersion;
	revision: number;
	id: string;
	type: Physics2DJointType;
	enabled: boolean;
	firstNodeId: string;
	/** Omit to connect the joint to a fixed world-space anchor. Target joints always omit this field. */
	secondNodeId?: string;
	enableCollision: boolean;
	worldDrawing: boolean;
	breakAction: Physics2DJointBreakAction;
	/** Omitted means unbreakable by force. */
	breakForce?: number;
	/** Omitted means unbreakable by torque. */
	breakTorque?: number;
}

export interface IPhysics2DAnchoredJointConfiguration extends IPhysics2DJointBaseConfiguration {
	firstAnchor: IPhysics2DPoint;
	/** Local to the second body, or world-space when secondNodeId is omitted. */
	secondAnchor: IPhysics2DPoint;
	/** Legacy joints capture a connected anchor from their initial scene pose before simulation. */
	autoConfigureConnectedAnchor: boolean;
}

export interface IPhysics2DDistanceJointConfiguration extends IPhysics2DAnchoredJointConfiguration {
	type: "distance";
	distance: number;
	maxDistanceOnly: boolean;
}

export interface IPhysics2DFixedJointConfiguration extends IPhysics2DAnchoredJointConfiguration {
	type: "fixed";
	referenceAngle: number;
	frequency: number;
	dampingRatio: number;
}

export interface IPhysics2DFrictionJointConfiguration extends IPhysics2DAnchoredJointConfiguration {
	type: "friction";
	maxForce: number;
	maxTorque: number;
}

export interface IPhysics2DHingeJointConfiguration extends IPhysics2DAnchoredJointConfiguration {
	type: "hinge";
	referenceAngle: number;
	useLimits: boolean;
	minAngle: number;
	maxAngle: number;
	useMotor: boolean;
	motorSpeed: number;
	maxMotorTorque: number;
}

export interface IPhysics2DRelativeJointConfiguration extends IPhysics2DJointBaseConfiguration {
	type: "relative";
	linearOffset: IPhysics2DPoint;
	angularOffset: number;
	maxForce: number;
	maxTorque: number;
	correctionScale: number;
}

export interface IPhysics2DSliderJointConfiguration extends IPhysics2DAnchoredJointConfiguration {
	type: "slider";
	angle: number;
	referenceAngle: number;
	useLimits: boolean;
	lowerTranslation: number;
	upperTranslation: number;
	useMotor: boolean;
	motorSpeed: number;
	maxMotorForce: number;
}

export interface IPhysics2DSpringJointConfiguration extends IPhysics2DAnchoredJointConfiguration {
	type: "spring";
	distance: number;
	frequency: number;
	dampingRatio: number;
}

export interface IPhysics2DTargetJointConfiguration extends IPhysics2DJointBaseConfiguration {
	type: "target";
	target: IPhysics2DPoint;
	maxForce: number;
	frequency: number;
	dampingRatio: number;
}

export interface IPhysics2DWheelJointConfiguration extends IPhysics2DAnchoredJointConfiguration {
	type: "wheel";
	angle: number;
	frequency: number;
	dampingRatio: number;
	useMotor: boolean;
	motorSpeed: number;
	maxMotorTorque: number;
}

export type IPhysics2DJointConfiguration =
	| IPhysics2DDistanceJointConfiguration
	| IPhysics2DFixedJointConfiguration
	| IPhysics2DFrictionJointConfiguration
	| IPhysics2DHingeJointConfiguration
	| IPhysics2DRelativeJointConfiguration
	| IPhysics2DSliderJointConfiguration
	| IPhysics2DSpringJointConfiguration
	| IPhysics2DTargetJointConfiguration
	| IPhysics2DWheelJointConfiguration;

export const physics2DEffectorTypes = ["point", "area", "surface", "platform", "buoyancy"] as const;
export type Physics2DEffectorType = (typeof physics2DEffectorTypes)[number];
export type Physics2DEffectorForceTarget = "collider" | "rigidbody";
export type Physics2DPointEffectorForceSource = "collider" | "rigidbody";
export type Physics2DPointEffectorForceMode = "constant" | "inverse-linear" | "inverse-squared";

export interface IPhysics2DEffectorBaseConfiguration {
	version: typeof Physics2DEffectorContractVersion;
	revision: number;
	id: string;
	type: Physics2DEffectorType;
	nodeId: string;
	enabled: boolean;
	useColliderMask: boolean;
	colliderMask: number;
}

export interface IPhysics2DPointEffectorConfiguration extends IPhysics2DEffectorBaseConfiguration {
	type: "point";
	/** Deprecated v1 radial fields remain normalized until every persisted legacy scene has an owner collider. */
	radius: number;
	force: number;
	falloff: number;
	forceMagnitude: number;
	forceVariation: number;
	distanceScale: number;
	linearDrag: number;
	angularDrag: number;
	forceSource: Physics2DPointEffectorForceSource;
	forceTarget: Physics2DEffectorForceTarget;
	forceMode: Physics2DPointEffectorForceMode;
}

export interface IPhysics2DAreaEffectorConfiguration extends IPhysics2DEffectorBaseConfiguration {
	type: "area";
	/** Deprecated v1 radial fields preserve old scenes while v2 uses the owner collider as its area. */
	radius: number;
	force: number;
	falloff: number;
	forceMagnitude: number;
	forceVariation: number;
	linearDrag: number;
	angularDrag: number;
	forceTarget: Physics2DEffectorForceTarget;
	useGlobalAngle: boolean;
	/** Degrees. Global when useGlobalAngle is true, otherwise local to the effector node. */
	forceAngle: number;
}

export interface IPhysics2DSurfaceEffectorConfiguration extends IPhysics2DEffectorBaseConfiguration {
	type: "surface";
	/** Deprecated v1 ring fields preserve old scenes while v2 uses actual collider contacts. */
	radius: number;
	force: number;
	falloff: number;
	surfaceThickness: number;
	speed: number;
	speedVariation: number;
	forceScale: number;
	useContactForce: boolean;
	useFriction: boolean;
	useBounce: boolean;
}

export interface IPhysics2DPlatformEffectorConfiguration extends IPhysics2DEffectorBaseConfiguration {
	type: "platform";
	/** Legacy world-space outward direction retained only for deterministic v1 migration. */
	platformAngle: number;
	/** Degrees from the collider's local up direction. */
	rotationalOffset: number;
	/** Migration marker that prevents old world-space platformAngle scenes from changing orientation after normalization. */
	usesLegacyWorldAngle: boolean;
	useOneWay: boolean;
	useOneWayGrouping: boolean;
	surfaceArc: number;
	useSideFriction: boolean;
	useSideBounce: boolean;
	sideArc: number;
}

export interface IPhysics2DBuoyancyEffectorConfiguration extends IPhysics2DEffectorBaseConfiguration {
	type: "buoyancy";
	/** World-Y offset from the effector node, scaled by the node's Y transform scale. */
	surfaceLevel: number;
	density: number;
	linearDrag: number;
	angularDrag: number;
	flowAngle: number;
	flowMagnitude: number;
	flowVariation: number;
}

export type IPhysics2DEffectorConfiguration =
	| IPhysics2DPointEffectorConfiguration
	| IPhysics2DAreaEffectorConfiguration
	| IPhysics2DSurfaceEffectorConfiguration
	| IPhysics2DPlatformEffectorConfiguration
	| IPhysics2DBuoyancyEffectorConfiguration;

export type IPhysics2DJointValidationResult = { ok: true; value: IPhysics2DJointConfiguration } | { ok: false; error: string };
export type IPhysics2DEffectorValidationResult = { ok: true; value: IPhysics2DEffectorConfiguration } | { ok: false; error: string };
export type IPhysics2DJointCollectionValidationResult = { ok: true; value: IPhysics2DJointConfiguration[] } | { ok: false; error: string };
export type IPhysics2DEffectorCollectionValidationResult = { ok: true; value: IPhysics2DEffectorConfiguration[] } | { ok: false; error: string };

type IRecord = Record<string, unknown>;

function record(value: unknown): IRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as IRecord) : null;
}

function text(value: unknown, maximumLength = 256): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : null;
}

function number(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
	const candidate = value === undefined ? fallback : value;
	return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum ? candidate : null;
}

function optionalNumber(value: unknown, minimum: number, maximum: number): number | undefined | null {
	return value === undefined ? undefined : number(value, 0, minimum, maximum);
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
	const candidate = number(value, fallback, minimum, maximum);
	return candidate !== null && Number.isInteger(candidate) ? candidate : null;
}

function boolean(value: unknown, fallback: boolean): boolean | null {
	const candidate = value === undefined ? fallback : value;
	return typeof candidate === "boolean" ? candidate : null;
}

/** Validates closed string unions without allowing truthy or coerced legacy values. */
function choice<T extends string>(value: unknown, fallback: T, values: readonly T[]): T | null {
	const candidate = value === undefined ? fallback : value;
	return typeof candidate === "string" && values.includes(candidate as T) ? (candidate as T) : null;
}

function point(value: unknown, fallback: IPhysics2DPoint): IPhysics2DPoint | null {
	const candidate = value === undefined ? fallback : value;
	if (!Array.isArray(candidate) || candidate.length !== 2) {
		return null;
	}
	const x = number(candidate[0], 0, -MaxPhysics2DCoordinate, MaxPhysics2DCoordinate);
	const y = number(candidate[1], 0, -MaxPhysics2DCoordinate, MaxPhysics2DCoordinate);
	return x === null || y === null ? null : [x, y];
}

function commonJoint(source: IRecord, type: Physics2DJointType): IPhysics2DJointBaseConfiguration | null {
	const id = text(source.id);
	const firstNodeId = text(source.firstNodeId);
	const secondNodeId = source.secondNodeId === undefined ? undefined : text(source.secondNodeId);
	const version = integer(source.version, 1, 1, Physics2DJointContractVersion);
	const revision = integer(source.revision, 1, 1, Number.MAX_SAFE_INTEGER);
	const enabled = boolean(source.enabled, true);
	const enableCollision = boolean(source.enableCollision, false);
	const worldDrawing = boolean(source.worldDrawing, false);
	const breakAction = source.breakAction ?? "destroy";
	// JSON cannot preserve Infinity, so an absent threshold is the portable unbreakable representation.
	const breakForce = optionalNumber(source.breakForce, 0, 1_000_000_000_000);
	const breakTorque = optionalNumber(source.breakTorque, 0, 1_000_000_000_000);
	if (
		!id ||
		!firstNodeId ||
		secondNodeId === null ||
		secondNodeId === firstNodeId ||
		version === null ||
		revision === null ||
		enabled === null ||
		enableCollision === null ||
		worldDrawing === null ||
		breakForce === null ||
		breakTorque === null ||
		!(["ignore", "callback-only", "disable", "destroy"] as unknown[]).includes(breakAction) ||
		(type === "target" && secondNodeId !== undefined)
	) {
		return null;
	}
	return {
		version: Physics2DJointContractVersion,
		revision,
		id,
		type,
		enabled,
		firstNodeId,
		...(secondNodeId ? { secondNodeId } : {}),
		enableCollision,
		worldDrawing,
		breakAction: breakAction as Physics2DJointBreakAction,
		...(breakForce !== undefined ? { breakForce } : {}),
		...(breakTorque !== undefined ? { breakTorque } : {}),
	};
}

function anchoredJoint(source: IRecord, common: IPhysics2DJointBaseConfiguration): IPhysics2DAnchoredJointConfiguration | null {
	const firstAnchor = point(source.firstAnchor, [0, 0]);
	const secondAnchor = point(source.secondAnchor, [0, 0]);
	// Old joints omitted anchors; deferring capture to runtime preserves their authored scene-space separation.
	const autoConfigureConnectedAnchor = boolean(source.autoConfigureConnectedAnchor, source.firstAnchor === undefined || source.secondAnchor === undefined);
	return firstAnchor && secondAnchor && autoConfigureConnectedAnchor !== null ? { ...common, firstAnchor, secondAnchor, autoConfigureConnectedAnchor } : null;
}

/** Converts legacy joint metadata into a detached, bounded v1 joint contract. */
export function normalizePhysics2DJointConfiguration(value: unknown): IPhysics2DJointValidationResult {
	const source = record(value);
	const type = source?.type ?? "distance";
	if (!source || typeof type !== "string" || !(physics2DJointTypes as readonly string[]).includes(type)) {
		return { ok: false, error: "Physics 2D joint requires a supported type and an object value." };
	}
	const common = commonJoint(source, type as Physics2DJointType);
	if (!common) {
		return { ok: false, error: `Physics 2D ${type} joint contains invalid identity, connection, revision, break, or collision fields.` };
	}
	if (type === "relative") {
		const linearOffset = point(source.linearOffset, [0, 0]);
		const angularOffset = number(source.angularOffset, 0, -100_000, 100_000);
		const maxForce = number(source.maxForce, 10_000, 0, 1_000_000_000_000);
		const maxTorque = number(source.maxTorque, 10_000, 0, 1_000_000_000_000);
		const correctionScale = number(source.correctionScale, 0.3, 0, 1);
		return linearOffset && angularOffset !== null && maxForce !== null && maxTorque !== null && correctionScale !== null
			? { ok: true, value: { ...common, type, linearOffset, angularOffset, maxForce, maxTorque, correctionScale } }
			: { ok: false, error: "Physics 2D relative joint contains invalid offset, force, torque, or correction values." };
	}
	if (type === "target") {
		const target = point(source.target, [0, 0]);
		const maxForce = number(source.maxForce, 10_000, 0, 1_000_000_000_000);
		const frequency = number(source.frequency, 5, 0, 10_000);
		const dampingRatio = number(source.dampingRatio, 0.7, 0, 1);
		return target && maxForce !== null && frequency !== null && dampingRatio !== null
			? { ok: true, value: { ...common, type, target, maxForce, frequency, dampingRatio } }
			: { ok: false, error: "Physics 2D target joint contains invalid target, force, frequency, or damping values." };
	}
	const anchored = anchoredJoint(source, common);
	if (!anchored) {
		return { ok: false, error: `Physics 2D ${type} joint contains invalid anchor fields.` };
	}
	if (type === "distance") {
		const distance = number(source.distance, 0, 0, MaxPhysics2DCoordinate * 2);
		const maxDistanceOnly = boolean(source.maxDistanceOnly, false);
		return distance !== null && maxDistanceOnly !== null
			? { ok: true, value: { ...anchored, type, distance, maxDistanceOnly } }
			: { ok: false, error: "Physics 2D distance joint contains invalid distance fields." };
	}
	if (type === "fixed") {
		const referenceAngle = number(source.referenceAngle, 0, -100_000, 100_000);
		const frequency = number(source.frequency, 5, 0, 10_000);
		const dampingRatio = number(source.dampingRatio, 0.7, 0, 1);
		return referenceAngle !== null && frequency !== null && dampingRatio !== null
			? { ok: true, value: { ...anchored, type, referenceAngle, frequency, dampingRatio } }
			: { ok: false, error: "Physics 2D fixed joint contains invalid angle, frequency, or damping values." };
	}
	if (type === "friction") {
		const maxForce = number(source.maxForce, 10_000, 0, 1_000_000_000_000);
		const maxTorque = number(source.maxTorque, 10_000, 0, 1_000_000_000_000);
		return maxForce !== null && maxTorque !== null
			? { ok: true, value: { ...anchored, type, maxForce, maxTorque } }
			: { ok: false, error: "Physics 2D friction joint contains invalid force or torque values." };
	}
	if (type === "hinge") {
		const referenceAngle = number(source.referenceAngle, 0, -100_000, 100_000);
		const useLimits = boolean(source.useLimits, source.minAngle !== undefined || source.maxAngle !== undefined);
		const minAngle = number(source.minAngle, -Math.PI, -100_000, 100_000);
		const maxAngle = number(source.maxAngle, Math.PI, -100_000, 100_000);
		const useMotor = boolean(source.useMotor, source.motorSpeed !== undefined);
		const motorSpeed = number(source.motorSpeed, 0, -100_000, 100_000);
		const maxMotorTorque = number(source.maxMotorTorque, 10_000, 0, 1_000_000_000_000);
		return referenceAngle !== null &&
			useLimits !== null &&
			minAngle !== null &&
			maxAngle !== null &&
			minAngle <= maxAngle &&
			useMotor !== null &&
			motorSpeed !== null &&
			maxMotorTorque !== null
			? { ok: true, value: { ...anchored, type, referenceAngle, useLimits, minAngle, maxAngle, useMotor, motorSpeed, maxMotorTorque } }
			: { ok: false, error: "Physics 2D hinge joint contains invalid angle, limit, or motor values." };
	}
	if (type === "slider") {
		const angle = number(source.angle, 0, -100_000, 100_000);
		const referenceAngle = number(source.referenceAngle, 0, -100_000, 100_000);
		const useLimits = boolean(source.useLimits, source.lowerTranslation !== undefined || source.upperTranslation !== undefined);
		const lowerTranslation = number(source.lowerTranslation, 0, -MaxPhysics2DCoordinate * 2, MaxPhysics2DCoordinate * 2);
		const upperTranslation = number(source.upperTranslation, 0, -MaxPhysics2DCoordinate * 2, MaxPhysics2DCoordinate * 2);
		const useMotor = boolean(source.useMotor, source.motorSpeed !== undefined);
		const motorSpeed = number(source.motorSpeed, 0, -100_000, 100_000);
		const maxMotorForce = number(source.maxMotorForce, 10_000, 0, 1_000_000_000_000);
		return angle !== null &&
			referenceAngle !== null &&
			useLimits !== null &&
			lowerTranslation !== null &&
			upperTranslation !== null &&
			lowerTranslation <= upperTranslation &&
			useMotor !== null &&
			motorSpeed !== null &&
			maxMotorForce !== null
			? { ok: true, value: { ...anchored, type, angle, referenceAngle, useLimits, lowerTranslation, upperTranslation, useMotor, motorSpeed, maxMotorForce } }
			: { ok: false, error: "Physics 2D slider joint contains invalid axis, angle, limit, or motor values." };
	}
	if (type === "spring") {
		const distance = number(source.distance, 0, 0, MaxPhysics2DCoordinate * 2);
		const frequency = number(source.frequency, 5, 0, 10_000);
		const dampingRatio = number(source.dampingRatio, 0.7, 0, 1);
		return distance !== null && frequency !== null && dampingRatio !== null
			? { ok: true, value: { ...anchored, type, distance, frequency, dampingRatio } }
			: { ok: false, error: "Physics 2D spring joint contains invalid distance, frequency, or damping values." };
	}
	const angle = number(source.angle, Math.PI / 2, -100_000, 100_000);
	const frequency = number(source.frequency, 5, 0, 10_000);
	const dampingRatio = number(source.dampingRatio, 0.7, 0, 1);
	const useMotor = boolean(source.useMotor, source.motorSpeed !== undefined);
	const motorSpeed = number(source.motorSpeed, 0, -100_000, 100_000);
	const maxMotorTorque = number(source.maxMotorTorque, 10_000, 0, 1_000_000_000_000);
	return angle !== null && frequency !== null && dampingRatio !== null && useMotor !== null && motorSpeed !== null && maxMotorTorque !== null
		? { ok: true, value: { ...anchored, type: "wheel", angle, frequency, dampingRatio, useMotor, motorSpeed, maxMotorTorque } }
		: { ok: false, error: "Physics 2D wheel joint contains invalid axis, suspension, or motor values." };
}

/** Validates a complete persisted joint collection atomically, including count and identity bounds. */
export function normalizePhysics2DJointConfigurations(value: unknown): IPhysics2DJointCollectionValidationResult {
	if (!Array.isArray(value) || value.length > MaxPhysics2DJoints) {
		return { ok: false, error: `Physics 2D joints must be an array with at most ${MaxPhysics2DJoints} entries.` };
	}
	const result: IPhysics2DJointConfiguration[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const normalized = normalizePhysics2DJointConfiguration(value[index]);
		if (!normalized.ok) {
			return { ok: false, error: `Physics 2D joint ${index}: ${normalized.error}` };
		}
		if (ids.has(normalized.value.id)) {
			return { ok: false, error: `Physics 2D joint id "${normalized.value.id}" is duplicated.` };
		}
		ids.add(normalized.value.id);
		result.push(normalized.value);
	}
	return { ok: true, value: result };
}

/** Converts legacy radius/force effectors and current Unity-style metadata into a detached v2 contract. */
export function normalizePhysics2DEffectorConfiguration(value: unknown): IPhysics2DEffectorValidationResult {
	const source = record(value);
	const type = source?.type ?? "point";
	const id = text(source?.id);
	const nodeId = text(source?.nodeId);
	const sourceVersion = integer(source?.version, 1, 1, Physics2DEffectorContractVersion);
	const revision = integer(source?.revision, 1, 1, Number.MAX_SAFE_INTEGER);
	const enabled = boolean(source?.enabled, true);
	const useColliderMask = boolean(source?.useColliderMask, false);
	const colliderMask = integer(source?.colliderMask, 0xffffffff, 0, 0xffffffff);
	if (
		!source ||
		!id ||
		!nodeId ||
		sourceVersion === null ||
		revision === null ||
		enabled === null ||
		useColliderMask === null ||
		colliderMask === null ||
		typeof type !== "string" ||
		!(physics2DEffectorTypes as readonly string[]).includes(type)
	) {
		return { ok: false, error: "Physics 2D effector requires valid identity, node, type, revision, enabled, and collider-mask fields." };
	}
	// Normalization always publishes v2; sourceVersion is retained only to choose behavior-preserving migration defaults.
	const common: IPhysics2DEffectorBaseConfiguration = {
		version: Physics2DEffectorContractVersion,
		revision,
		id,
		nodeId,
		type: type as Physics2DEffectorType,
		enabled,
		useColliderMask,
		colliderMask,
	};
	if (type === "platform") {
		const platformAngle = number(source.platformAngle, 90, -360_000, 360_000);
		const rotationalOffset = number(source.rotationalOffset, 0, -360_000, 360_000);
		const usesLegacyWorldAngle = boolean(source.usesLegacyWorldAngle, sourceVersion === 1 && source.rotationalOffset === undefined);
		const useOneWay = boolean(source.useOneWay, true);
		const useOneWayGrouping = boolean(source.useOneWayGrouping, false);
		const surfaceArc = number(source.surfaceArc, sourceVersion === 1 ? 90 : 180, 0, 360);
		const useSideFriction = boolean(source.useSideFriction, true);
		const useSideBounce = boolean(source.useSideBounce, true);
		const sideArc = number(source.sideArc, 1, 0, 180);
		return [platformAngle, rotationalOffset, usesLegacyWorldAngle, useOneWay, useOneWayGrouping, surfaceArc, useSideFriction, useSideBounce, sideArc].some(
			(candidate) => candidate === null
		)
			? { ok: false, error: "Physics 2D platform effector contains invalid one-way, surface, or side fields." }
			: {
					ok: true,
					value: {
						...common,
						type,
						platformAngle: platformAngle!,
						rotationalOffset: rotationalOffset!,
						usesLegacyWorldAngle: usesLegacyWorldAngle!,
						useOneWay: useOneWay!,
						useOneWayGrouping: useOneWayGrouping!,
						surfaceArc: surfaceArc!,
						useSideFriction: useSideFriction!,
						useSideBounce: useSideBounce!,
						sideArc: sideArc!,
					},
				};
	}
	if (type === "buoyancy") {
		const surfaceLevel = number(source.surfaceLevel, 0, -MaxPhysics2DCoordinate, MaxPhysics2DCoordinate);
		const density = number(source.density, 1, 0, 1_000_000);
		const linearDrag = number(source.linearDrag, 1, 0, 1_000_000);
		const angularDrag = number(source.angularDrag, 1, 0, 1_000_000);
		const flowAngle = number(source.flowAngle, 0, -360_000, 360_000);
		const flowMagnitude = number(source.flowMagnitude, 0, -1_000_000_000, 1_000_000_000);
		const flowVariation = number(source.flowVariation, 0, -1_000_000_000, 1_000_000_000);
		return [surfaceLevel, density, linearDrag, angularDrag, flowAngle, flowMagnitude, flowVariation].some((candidate) => candidate === null)
			? { ok: false, error: "Physics 2D buoyancy effector contains invalid surface, density, drag, flow, or mask values." }
			: {
					ok: true,
					value: {
						...common,
						type,
						surfaceLevel: surfaceLevel!,
						density: density!,
						linearDrag: linearDrag!,
						angularDrag: angularDrag!,
						flowAngle: flowAngle!,
						flowMagnitude: flowMagnitude!,
						flowVariation: flowVariation!,
					},
				};
	}
	const radius = number(source.radius, 100, 0.001, MaxPhysics2DCoordinate);
	const forceMagnitude = number(source.forceMagnitude, typeof source.force === "number" ? source.force : 1000, -1_000_000_000, 1_000_000_000);
	const force = number(source.force, forceMagnitude ?? 1000, -1_000_000_000, 1_000_000_000);
	const falloff = number(source.falloff, 1, 0, 1000);
	if (radius === null || force === null || falloff === null || forceMagnitude === null) {
		return { ok: false, error: `Physics 2D ${type} effector contains invalid radius, force, or falloff values.` };
	}
	if (type === "area") {
		const forceAngle = number(source.forceAngle, 0, -360_000, 360_000);
		const forceVariation = number(source.forceVariation, 0, 0, 1_000_000_000);
		const linearDrag = number(source.linearDrag === undefined ? source.drag : source.linearDrag, 0, 0, 1_000_000);
		const angularDrag = number(source.angularDrag, 0, 0, 1_000_000);
		const forceTarget = choice(source.forceTarget, "rigidbody", ["collider", "rigidbody"] as const);
		const useGlobalAngle = boolean(source.useGlobalAngle, sourceVersion === 1);
		return [forceAngle, forceVariation, linearDrag, angularDrag, forceTarget, useGlobalAngle].some((candidate) => candidate === null)
			? { ok: false, error: "Physics 2D area effector contains invalid angle, variation, drag, or target fields." }
			: {
					ok: true,
					value: {
						...common,
						type,
						radius,
						force,
						falloff,
						forceMagnitude,
						forceVariation: forceVariation!,
						linearDrag: linearDrag!,
						angularDrag: angularDrag!,
						forceTarget: forceTarget!,
						useGlobalAngle: useGlobalAngle!,
						forceAngle: forceAngle!,
					},
				};
	}
	if (type === "surface") {
		const surfaceThickness = number(source.surfaceThickness, Math.max(1, radius * 0.1), 0.001, MaxPhysics2DCoordinate);
		const speed = number(source.speed, force, -1_000_000_000, 1_000_000_000);
		const speedVariation = number(source.speedVariation, 0, -1_000_000_000, 1_000_000_000);
		const forceScale = number(source.forceScale, 1, 0, 1);
		const useContactForce = boolean(source.useContactForce, false);
		const useFriction = boolean(source.useFriction, true);
		const useBounce = boolean(source.useBounce, true);
		return [surfaceThickness, speed, speedVariation, forceScale, useContactForce, useFriction, useBounce].some((candidate) => candidate === null)
			? { ok: false, error: "Physics 2D surface effector contains invalid speed, force, contact, friction, or bounce fields." }
			: {
					ok: true,
					value: {
						...common,
						type,
						radius,
						force,
						falloff,
						surfaceThickness: surfaceThickness!,
						speed: speed!,
						speedVariation: speedVariation!,
						forceScale: forceScale!,
						useContactForce: useContactForce!,
						useFriction: useFriction!,
						useBounce: useBounce!,
					},
				};
	}
	const forceVariation = number(source.forceVariation, 0, 0, 1_000_000_000);
	const distanceScale = number(source.distanceScale, 1, 0.000001, 1_000_000);
	const linearDrag = number(source.linearDrag === undefined ? source.drag : source.linearDrag, 0, 0, 1_000_000);
	const angularDrag = number(source.angularDrag, 0, 0, 1_000_000);
	const forceSource = choice(source.forceSource, "rigidbody", ["collider", "rigidbody"] as const);
	const forceTarget = choice(source.forceTarget, "rigidbody", ["collider", "rigidbody"] as const);
	const forceMode = choice(source.forceMode, falloff >= 2 ? "inverse-squared" : falloff > 0 ? "inverse-linear" : "constant", [
		"constant",
		"inverse-linear",
		"inverse-squared",
	] as const);
	return [forceVariation, distanceScale, linearDrag, angularDrag, forceSource, forceTarget, forceMode].some((candidate) => candidate === null)
		? { ok: false, error: "Physics 2D point effector contains invalid variation, distance, drag, source, target, or force-mode fields." }
		: {
				ok: true,
				value: {
					...common,
					type: "point",
					radius,
					force,
					falloff,
					forceMagnitude,
					forceVariation: forceVariation!,
					distanceScale: distanceScale!,
					linearDrag: linearDrag!,
					angularDrag: angularDrag!,
					forceSource: forceSource!,
					forceTarget: forceTarget!,
					forceMode: forceMode!,
				},
			};
}

/** Validates a complete persisted effector collection atomically, including count and identity bounds. */
export function normalizePhysics2DEffectorConfigurations(value: unknown): IPhysics2DEffectorCollectionValidationResult {
	if (!Array.isArray(value) || value.length > MaxPhysics2DEffectors) {
		return { ok: false, error: `Physics 2D effectors must be an array with at most ${MaxPhysics2DEffectors} entries.` };
	}
	const result: IPhysics2DEffectorConfiguration[] = [];
	const ids = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const normalized = normalizePhysics2DEffectorConfiguration(value[index]);
		if (!normalized.ok) {
			return { ok: false, error: `Physics 2D effector ${index}: ${normalized.error}` };
		}
		if (ids.has(normalized.value.id)) {
			return { ok: false, error: `Physics 2D effector id "${normalized.value.id}" is duplicated.` };
		}
		ids.add(normalized.value.id);
		result.push(normalized.value);
	}
	return { ok: true, value: result };
}
