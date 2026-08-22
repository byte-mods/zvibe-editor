import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observable } from "@babylonjs/core/Misc/observable";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

import { computePhysics2DMassProperties, IPhysics2DMassProperties } from "./physics2d-mass";
import {
	beginPhysics2DJointStep,
	beginPhysics2DJointSubstep,
	IPhysics2DJointRuntimeState,
	IPhysics2DRuntimeJoint,
	physics2DJointRuntimeState,
	resolvePhysics2DJointAutoConfiguration,
	solvePhysics2DJointPosition,
	solvePhysics2DJointVelocity,
} from "./physics2d-joint-runtime";
import {
	IPhysics2DAreaEffectorConfiguration,
	IPhysics2DBuoyancyEffectorConfiguration,
	IPhysics2DEffectorConfiguration,
	IPhysics2DPlatformEffectorConfiguration,
	IPhysics2DPointEffectorConfiguration,
	IPhysics2DSurfaceEffectorConfiguration,
	MaxPhysics2DJoints,
	normalizePhysics2DEffectorConfigurations,
	normalizePhysics2DJointConfiguration,
} from "./physics2d-joints";
import { IPhysics2DBodyConfiguration, MaxPhysics2DBodies, normalizePhysics2DBodyConfiguration } from "./physics2d-types";
import {
	DefaultPhysics2DWorldId,
	IPhysics2DSettingsConfiguration,
	IPhysics2DTransformPlaneConfiguration,
	IPhysics2DWorldConfiguration,
	normalizePhysics2DSettingsConfiguration,
} from "./physics2d-settings";

/** Mutable solver state kept separately from immutable normalized scene metadata. */
type IRuntimeBody = {
	source: unknown;
	config: IPhysics2DBodyConfiguration;
	node: TransformNode;
	velocity: Vector3;
	angularVelocity: number;
	force: Vector3;
	torque: number;
	massProperties: IPhysics2DMassProperties;
	world: IPhysics2DWorldConfiguration;
	position2D: [number, number];
	angle2D: number;
	lastWrittenPosition2D: [number, number];
	lastWrittenAngle2D: number;
	readPosition2D: () => [number, number];
	readAngle2D: () => number;
	translate2D: (delta: [number, number]) => void;
	rotate2D: (delta: number) => void;
};

/** Distinguishes time-integrated forces from immediate momentum changes. */
export type Physics2DForceMode = "force" | "impulse";

// Closed ceilings keep malformed scripts and MCP requests from poisoning shared solver state.
const MaxPhysics2DForce = 1_000_000_000;
const MaxPhysics2DTorque = 1_000_000_000_000;
const MaxPhysics2DLinearVelocity = 1_000_000;
const MaxPhysics2DAngularVelocity = 100_000;
const Physics2DColliderArcSegments = 12;
const Physics2DBuoyancyCircleSegments = 24;
const MinimumPhysics2DEdgeRadius = 0.0005;
const MaxPhysics2DContinuousSubsteps = 64;
const MaxPhysics2DContinuousPairChecks = 4_000_000;
const MaxPhysics2DJointSolverChecks = 2_000_000;
const MaxPhysics2DEffectorChecks = 2_000_000;

/** Bounded authoring diagnostic for metadata that could not become a runtime body. */
export interface IPhysics2DInvalidBody {
	index: number;
	nodeId: string | null;
	error: string;
}

/** One scene-owned controller prevents preview/export observers from double-stepping bodies. */
interface IRuntimePhysics2D {
	bodies: Map<string, IRuntimeBody>;
	joints: Map<string, IPhysics2DRuntimeJoint>;
	blockedCollisionPairs: Set<string>;
	observer: any;
	paused: boolean;
	executingManualStep: boolean;
	collisions: number;
	triggers: IPhysics2DTriggerEvent[];
	totalAutomaticSteps: number;
	totalManualSteps: number;
	totalManualSeconds: number;
	lastStepSeconds: number | null;
	lastSteppedBodies: number;
	lastError: { message: string; timestamp: number } | null;
	invalidBodyCount: number;
	invalidBodies: IPhysics2DInvalidBody[];
	metadataTruncated: boolean;
	invalidJointCount: number;
	invalidJoints: IPhysics2DInvalidJoint[];
	jointMetadataTruncated: boolean;
	jointBreakEvents: IPhysics2DJointBreakEvent[];
	transformWriteEvents: IPhysics2DTransformWriteEvent[];
}

/** Detached controller evidence for Inspector, MCP, and deterministic manual stepping. */
export interface IPhysics2DSimulationControl {
	available: boolean;
	paused: boolean;
	registeredBodies: number;
	enabledBodies: number;
	dynamicBodies: number;
	kinematicBodies: number;
	staticBodies: number;
	bodyIds: string[];
	executingManualStep: boolean;
	collisions: number;
	triggers: IPhysics2DTriggerEvent[];
	totalAutomaticSteps: number;
	totalManualSteps: number;
	totalManualSeconds: number;
	lastStepSeconds: number | null;
	lastSteppedBodies: number;
	lastError: { message: string; timestamp: number } | null;
	invalidBodyCount: number;
	invalidBodies: IPhysics2DInvalidBody[];
	metadataTruncated: boolean;
	registeredJoints: number;
	enabledJoints: number;
	brokenJoints: number;
	invalidJointCount: number;
	invalidJoints: IPhysics2DInvalidJoint[];
	jointMetadataTruncated: boolean;
	jointBreakEvents: IPhysics2DJointBreakEvent[];
	worldCount: number;
	worlds: Array<{ id: string; enabled: boolean; bodies: number; joints: number; contactFilterMode: IPhysics2DWorldConfiguration["contactFilterMode"] }>;
	transformWriteEvents: IPhysics2DTransformWriteEvent[];
}

/** Detached live body evidence with explicit mass and angular units. */
export interface IPhysics2DBodyRuntimeState extends IPhysics2DMassProperties {
	active: boolean;
	bodyType: IPhysics2DBodyConfiguration["bodyType"] | null;
	revision: number | null;
	velocity: [number, number];
	angularVelocity: number;
	accumulatedForce: [number, number];
	accumulatedTorque: number;
}

const physics2DRuntimes = new WeakMap<Scene, IRuntimePhysics2D>();

export interface IPhysics2DTriggerEvent {
	firstNodeId: string;
	secondNodeId: string;
}

export interface IPhysics2DInvalidJoint {
	index: number;
	id: string | null;
	error: string;
}

export interface IPhysics2DJointBreakEvent {
	jointId: string;
	type: IPhysics2DRuntimeJoint["config"]["type"];
	firstNodeId: string;
	secondNodeId?: string;
	action: IPhysics2DRuntimeJoint["config"]["breakAction"];
	reactionForce: IPoint2D;
	reactionTorque: number;
}

export interface IPhysics2DTransformWriteEvent {
	nodeId: string;
	worldId: string;
	mode: IPhysics2DWorldConfiguration["transformWriteMode"];
	from: [number, number, number];
	target: [number, number, number];
	applied: [number, number, number];
	tweening: boolean;
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		onPhysics2DTriggerObservable?: Observable<IPhysics2DTriggerEvent>;
		physics2DTriggerEvents?: IPhysics2DTriggerEvent[];
		onPhysics2DJointBreakObservable?: Observable<IPhysics2DJointBreakEvent>;
		physics2DJointBreakEvents?: IPhysics2DJointBreakEvent[];
		onPhysics2DTransformWriteObservable?: Observable<IPhysics2DTransformWriteEvent>;
		onPhysics2DTransformTweenObservable?: Observable<IPhysics2DTransformWriteEvent>;
		physics2DTransformWriteEvents?: IPhysics2DTransformWriteEvent[];
	}
}

type IPoint2D = [number, number];
type IPhysics2DContact = { normal: Vector3; penetration: number; point: IPoint2D };
type IPhysics2DContactResponse = { useFriction: boolean; useBounce: boolean };
type IPhysics2DEffectorsByNode = Map<string, IPhysics2DEffectorConfiguration[]>;

function settings(scene: Scene): IPhysics2DSettingsConfiguration {
	const normalized = normalizePhysics2DSettingsConfiguration(scene.metadata?.babylonEditorPhysics2DSettings);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	return normalized.value;
}

function worldById(configuration: IPhysics2DSettingsConfiguration, id: string): IPhysics2DWorldConfiguration | null {
	return configuration.worlds.find((world) => world.id === id) ?? null;
}

function planePosition(node: TransformNode, plane: IPhysics2DTransformPlaneConfiguration): [number, number] {
	const delta = [node.position.x - plane.origin[0], node.position.y - plane.origin[1], node.position.z - plane.origin[2]];
	return [delta[0] * plane.xAxis[0] + delta[1] * plane.xAxis[1] + delta[2] * plane.xAxis[2], delta[0] * plane.yAxis[0] + delta[1] * plane.yAxis[1] + delta[2] * plane.yAxis[2]];
}

function rotateByQuaternion(vector: [number, number, number], quaternion: Quaternion): [number, number, number] {
	const [x, y, z] = vector;
	const qx = quaternion.x,
		qy = quaternion.y,
		qz = quaternion.z,
		qw = quaternion.w;
	const ix = qw * x + qy * z - qz * y;
	const iy = qw * y + qz * x - qx * z;
	const iz = qw * z + qx * y - qy * x;
	const iw = -qx * x - qy * y - qz * z;
	return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

function planeAngle(node: TransformNode, plane: IPhysics2DTransformPlaneConfiguration): number {
	if (plane.mode === "xy" && !node.rotationQuaternion) {
		return node.rotation.z;
	}
	if (plane.mode === "xz" && !node.rotationQuaternion) {
		return -node.rotation.y;
	}
	if (plane.mode === "yz" && !node.rotationQuaternion) {
		return node.rotation.x;
	}
	const quaternion = node.rotationQuaternion ?? Quaternion.FromEulerAngles(node.rotation.x, node.rotation.y, node.rotation.z);
	const rotated = rotateByQuaternion(plane.xAxis, quaternion);
	return Math.atan2(
		rotated[0] * plane.yAxis[0] + rotated[1] * plane.yAxis[1] + rotated[2] * plane.yAxis[2],
		rotated[0] * plane.xAxis[0] + rotated[1] * plane.xAxis[1] + rotated[2] * plane.xAxis[2]
	);
}

function planeVector(plane: IPhysics2DTransformPlaneConfiguration, position: [number, number]): [number, number, number] {
	return [
		plane.origin[0] + plane.xAxis[0] * position[0] + plane.yAxis[0] * position[1],
		plane.origin[1] + plane.xAxis[1] * position[0] + plane.yAxis[1] * position[1],
		plane.origin[2] + plane.xAxis[2] * position[0] + plane.yAxis[2] * position[1],
	];
}

function writePlaneAngle(node: TransformNode, plane: IPhysics2DTransformPlaneConfiguration, angle: number): void {
	if (plane.mode === "xy" && !node.rotationQuaternion) {
		node.rotation.z = angle;
		return;
	}
	if (plane.mode === "xz" && !node.rotationQuaternion) {
		node.rotation.y = -angle;
		return;
	}
	if (plane.mode === "yz" && !node.rotationQuaternion) {
		node.rotation.x = angle;
		return;
	}
	const normal: [number, number, number] = [
		plane.xAxis[1] * plane.yAxis[2] - plane.xAxis[2] * plane.yAxis[1],
		plane.xAxis[2] * plane.yAxis[0] - plane.xAxis[0] * plane.yAxis[2],
		plane.xAxis[0] * plane.yAxis[1] - plane.xAxis[1] * plane.yAxis[0],
	];
	const sine = Math.sin(angle / 2);
	node.rotationQuaternion = new Quaternion(normal[0] * sine, normal[1] * sine, normal[2] * sine, Math.cos(angle / 2));
}

function isRuntimeTransformNode(node: unknown): node is TransformNode {
	const candidate = node as any;
	return !!candidate?.position && !!candidate?.rotation && typeof candidate.position.x === "number" && typeof candidate.rotation.z === "number";
}

function bodyPoint(body: IRuntimeBody, point: IPoint2D, cosine = Math.cos(body.readAngle2D()), sine = Math.sin(body.readAngle2D())): IPoint2D {
	const [x, y] = point;
	const position = body.readPosition2D();
	return [position[0] + x * cosine - y * sine, position[1] + x * sine + y * cosine];
}

function worldPoint(body: IRuntimeBody, point: IPoint2D, cosine = Math.cos(body.readAngle2D()), sine = Math.sin(body.readAngle2D())): IPoint2D {
	return bodyPoint(body, [point[0] + body.config.collider.offset[0], point[1] + body.config.collider.offset[1]], cosine, sine);
}

function colliderCenter(body: IRuntimeBody): IPoint2D {
	return worldPoint(body, [0, 0]);
}

function roundedSegment(first: IPoint2D, second: IPoint2D, radius: number): IPoint2D[] {
	const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
	const direction: IPoint2D = length ? [(second[0] - first[0]) / length, (second[1] - first[1]) / length] : [1, 0];
	const normal: IPoint2D = [-direction[1], direction[0]];
	return [
		...Array.from({ length: Physics2DColliderArcSegments + 1 }, (_value, index): IPoint2D => {
			const angle = -Math.PI / 2 + (Math.PI * index) / Physics2DColliderArcSegments;
			return [
				second[0] + radius * (direction[0] * Math.cos(angle) + normal[0] * Math.sin(angle)),
				second[1] + radius * (direction[1] * Math.cos(angle) + normal[1] * Math.sin(angle)),
			];
		}),
		...Array.from({ length: Physics2DColliderArcSegments + 1 }, (_value, index): IPoint2D => {
			const angle = Math.PI / 2 + (Math.PI * index) / Physics2DColliderArcSegments;
			return [
				first[0] + radius * (direction[0] * Math.cos(angle) + normal[0] * Math.sin(angle)),
				first[1] + radius * (direction[1] * Math.cos(angle) + normal[1] * Math.sin(angle)),
			];
		}),
	];
}

function polygonPartsForBody(body: IRuntimeBody): IPoint2D[][] {
	const collider = body.config.collider;
	// Shape-specific fields are guaranteed by the normalizer before a runtime body is constructed.
	const parts: IPoint2D[][] =
		collider.shape === "polygon"
			? (collider.parts ?? [collider.points!])
			: collider.shape === "edge"
				? collider
						.points!.slice(0, -1)
						.map((point, index) => roundedSegment(point, collider.points![index + 1], Math.max(collider.edgeRadius!, MinimumPhysics2DEdgeRadius)))
				: collider.shape === "capsule"
					? (() => {
							const radius = Math.min(collider.size![0], collider.size![1]) / 2;
							const horizontal = collider.direction === "horizontal";
							const halfLength = Math.max(0, (collider.size![horizontal ? 0 : 1] - radius * 2) / 2);
							return [roundedSegment(horizontal ? [-halfLength, 0] : [0, -halfLength], horizontal ? [halfLength, 0] : [0, halfLength], radius)];
						})()
					: [
							[
								[-collider.size![0] / 2, -collider.size![1] / 2],
								[collider.size![0] / 2, -collider.size![1] / 2],
								[collider.size![0] / 2, collider.size![1] / 2],
								[-collider.size![0] / 2, collider.size![1] / 2],
							],
						];
	const cosine = Math.cos(body.readAngle2D());
	const sine = Math.sin(body.readAngle2D());
	return parts.map((points) => points.map((point) => worldPoint(body, point, cosine, sine)));
}

/** Produces bounded convex world-space pieces for the area calculations used by buoyancy. */
function areaPartsForBody(body: IRuntimeBody): IPoint2D[][] {
	if (body.config.collider.shape !== "circle") {
		return polygonPartsForBody(body);
	}
	const radius = body.config.collider.radius!;
	return [
		Array.from({ length: Physics2DBuoyancyCircleSegments }, (_value, index): IPoint2D => {
			const angle = (Math.PI * 2 * index) / Physics2DBuoyancyCircleSegments;
			return worldPoint(body, [Math.cos(angle) * radius, Math.sin(angle) * radius]);
		}),
	];
}

function signedPolygonArea(points: IPoint2D[]): number {
	return (
		points.reduce((area, point, index) => {
			const next = points[(index + 1) % points.length];
			return area + point[0] * next[1] - next[0] * point[1];
		}, 0) / 2
	);
}

/** Clips a convex subject against one convex liquid piece without creating unbounded geometry. */
function intersectConvexPolygons(subject: IPoint2D[], clip: IPoint2D[]): IPoint2D[] {
	let output = subject;
	const orientation = Math.sign(signedPolygonArea(clip)) || 1;
	for (let index = 0; index < clip.length && output.length; index++) {
		const first = clip[index];
		const second = clip[(index + 1) % clip.length];
		const input = output;
		output = [];
		const side = (point: IPoint2D): number => orientation * ((second[0] - first[0]) * (point[1] - first[1]) - (second[1] - first[1]) * (point[0] - first[0]));
		for (let subjectIndex = 0; subjectIndex < input.length; subjectIndex++) {
			const current = input[subjectIndex];
			const previous = input[(subjectIndex + input.length - 1) % input.length];
			const currentSide = side(current);
			const previousSide = side(previous);
			if (currentSide >= 0 !== previousSide >= 0) {
				const ratio = previousSide / (previousSide - currentSide);
				output.push([previous[0] + (current[0] - previous[0]) * ratio, previous[1] + (current[1] - previous[1]) * ratio]);
			}
			if (currentSide >= 0) {
				output.push(current);
			}
		}
	}
	return output;
}

/** Clips to the world-space half-plane below the authored horizontal liquid surface. */
function clipBelowSurface(points: IPoint2D[], surfacePoint: IPoint2D, surfaceUp: IPoint2D): IPoint2D[] {
	const distance = (point: IPoint2D): number => (point[0] - surfacePoint[0]) * surfaceUp[0] + (point[1] - surfacePoint[1]) * surfaceUp[1];
	const result: IPoint2D[] = [];
	for (let index = 0; index < points.length; index++) {
		const current = points[index];
		const previous = points[(index + points.length - 1) % points.length];
		const currentDistance = distance(current);
		const previousDistance = distance(previous);
		if (currentDistance <= 0 !== previousDistance <= 0) {
			const ratio = previousDistance / (previousDistance - currentDistance);
			result.push([previous[0] + (current[0] - previous[0]) * ratio, previous[1] + (current[1] - previous[1]) * ratio]);
		}
		if (currentDistance <= 0) {
			result.push(current);
		}
	}
	return result;
}

function polygonAreaCenter(points: IPoint2D[]): { area: number; center: IPoint2D } | null {
	const signedArea = signedPolygonArea(points);
	if (points.length < 3 || Math.abs(signedArea) <= 0.000001) {
		return null;
	}
	let centerX = 0;
	let centerY = 0;
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		const next = points[(index + 1) % points.length];
		const cross = point[0] * next[1] - next[0] * point[1];
		centerX += (point[0] + next[0]) * cross;
		centerY += (point[1] + next[1]) * cross;
	}
	return { area: Math.abs(signedArea), center: [centerX / (6 * signedArea), centerY / (6 * signedArea)] };
}

function submergedArea(body: IRuntimeBody, liquid: IRuntimeBody, effector: IPhysics2DBuoyancyEffectorConfiguration): { area: number; center: IPoint2D } | null {
	// Unity keeps the liquid plane horizontal in world space while scaling only its authored Y offset.
	const liquidPosition = liquid.readPosition2D();
	const surfacePoint: IPoint2D = [liquidPosition[0], liquidPosition[1] + effector.surfaceLevel * liquid.node.scaling.y];
	const surfaceUp: IPoint2D = [0, 1];
	const pieces = areaPartsForBody(body).flatMap((bodyPart) =>
		areaPartsForBody(liquid).flatMap((liquidPart) => {
			const clipped = clipBelowSurface(intersectConvexPolygons(bodyPart, liquidPart), surfacePoint, surfaceUp);
			const moments = polygonAreaCenter(clipped);
			return moments ? [moments] : [];
		})
	);
	const area = pieces.reduce((total, piece) => total + piece.area, 0);
	if (area <= 0) {
		return null;
	}
	return {
		area,
		center: [pieces.reduce((total, piece) => total + piece.center[0] * piece.area, 0) / area, pieces.reduce((total, piece) => total + piece.center[1] * piece.area, 0) / area],
	};
}
function center(points: IPoint2D[]): IPoint2D {
	return points.reduce(([x, y], point) => [x + point[0] / points.length, y + point[1] / points.length], [0, 0]);
}
function axes(points: IPoint2D[]): IPoint2D[] {
	return points.flatMap((point, index) => {
		const next = points[(index + 1) % points.length];
		const length = Math.hypot(next[0] - point[0], next[1] - point[1]);
		return length ? [[-(next[1] - point[1]) / length, (next[0] - point[0]) / length] as IPoint2D] : [];
	});
}
function polygonRange(points: IPoint2D[], axis: IPoint2D): [number, number] {
	const values = points.map((point) => point[0] * axis[0] + point[1] * axis[1]);
	return [Math.min(...values), Math.max(...values)];
}
function supportPoint(points: IPoint2D[], axis: IPoint2D, maximum: boolean): IPoint2D {
	const projections = points.map((point) => point[0] * axis[0] + point[1] * axis[1]);
	const target = maximum ? Math.max(...projections) : Math.min(...projections);
	const candidates = points.filter((_point, index) => Math.abs(projections[index] - target) <= 0.000001);
	return center(candidates);
}
function polygonHit(first: IPoint2D[], second: IPoint2D[]): IPhysics2DContact | null {
	let penetration = Infinity;
	let normal: IPoint2D = [0, 0];
	for (const axis of [...axes(first), ...axes(second)]) {
		const [firstMin, firstMax] = polygonRange(first, axis);
		const [secondMin, secondMax] = polygonRange(second, axis);
		const overlap = Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin);
		if (overlap <= 0) {
			return null;
		}
		if (overlap < penetration) {
			penetration = overlap;
			normal = axis;
		}
	}
	const firstCenter = center(first);
	const secondCenter = center(second);
	if ((secondCenter[0] - firstCenter[0]) * normal[0] + (secondCenter[1] - firstCenter[1]) * normal[1] < 0) {
		normal = [-normal[0], -normal[1]];
	}
	const firstSupport = supportPoint(first, normal, true);
	const secondSupport = supportPoint(second, normal, false);
	return { normal: new Vector3(normal[0], normal[1], 0), penetration, point: [(firstSupport[0] + secondSupport[0]) / 2, (firstSupport[1] + secondSupport[1]) / 2] };
}
function circlePolygonHit(circle: IRuntimeBody, points: IPoint2D[]): IPhysics2DContact | null {
	const circleCenter = colliderCenter(circle);
	let nearest = points[0];
	for (const point of points) {
		if (Math.hypot(point[0] - circleCenter[0], point[1] - circleCenter[1]) < Math.hypot(nearest[0] - circleCenter[0], nearest[1] - circleCenter[1])) {
			nearest = point;
		}
	}
	const delta: IPoint2D = [nearest[0] - circleCenter[0], nearest[1] - circleCenter[1]];
	const distance = Math.hypot(delta[0], delta[1]);
	const candidateAxes = [...axes(points), ...(distance ? [[delta[0] / distance, delta[1] / distance] as IPoint2D] : [])];
	let penetration = Infinity;
	let normal: IPoint2D = [0, 0];
	for (const axis of candidateAxes) {
		const [polygonMin, polygonMax] = polygonRange(points, axis);
		const projection = circleCenter[0] * axis[0] + circleCenter[1] * axis[1];
		const overlap = Math.min(polygonMax, projection + circle.config.collider.radius!) - Math.max(polygonMin, projection - circle.config.collider.radius!);
		if (overlap <= 0) {
			return null;
		}
		if (overlap < penetration) {
			penetration = overlap;
			normal = axis;
		}
	}
	const polygonCenter = center(points);
	if ((polygonCenter[0] - circleCenter[0]) * normal[0] + (polygonCenter[1] - circleCenter[1]) * normal[1] < 0) {
		normal = [-normal[0], -normal[1]];
	}
	const radius = circle.config.collider.radius!;
	const polygonSupport = supportPoint(points, normal, false);
	return {
		normal: new Vector3(normal[0], normal[1], 0),
		penetration,
		point: [(circleCenter[0] + normal[0] * radius + polygonSupport[0]) / 2, (circleCenter[1] + normal[1] * radius + polygonSupport[1]) / 2],
	};
}
function compoundHit(hits: Array<IPhysics2DContact | null>): IPhysics2DContact | null {
	return hits.filter((result): result is IPhysics2DContact => !!result).sort((first, second) => first.penetration - second.penetration)[0] ?? null;
}
function hit(first: IRuntimeBody, second: IRuntimeBody): IPhysics2DContact | null {
	if (first.config.collider.shape === "circle" && second.config.collider.shape === "circle") {
		const firstCenter = colliderCenter(first);
		const secondCenter = colliderCenter(second);
		const dx = secondCenter[0] - firstCenter[0];
		const dy = secondCenter[1] - firstCenter[1];
		const distance = Math.hypot(dx, dy);
		const radius = first.config.collider.radius! + second.config.collider.radius!;
		const normal: IPoint2D = distance ? [dx / distance, dy / distance] : [1, 0];
		return distance < radius
			? {
					normal: new Vector3(normal[0], normal[1], 0),
					penetration: radius - distance,
					point: [
						firstCenter[0] + normal[0] * (first.config.collider.radius! - (radius - distance) / 2),
						firstCenter[1] + normal[1] * (first.config.collider.radius! - (radius - distance) / 2),
					],
				}
			: null;
	}
	if (first.config.collider.shape === "circle") {
		return compoundHit(polygonPartsForBody(second).map((points) => circlePolygonHit(first, points)));
	}
	if (second.config.collider.shape === "circle") {
		const result = compoundHit(polygonPartsForBody(first).map((points) => circlePolygonHit(second, points)));
		return result ? { ...result, normal: result.normal.scale(-1) } : null;
	}
	return compoundHit(polygonPartsForBody(first).flatMap((firstPoints) => polygonPartsForBody(second).map((secondPoints) => polygonHit(firstPoints, secondPoints))));
}
function properties(config: any, materials: Map<string, any>): { friction: number; restitution: number } {
	const material = config.materialId ? materials.get(config.materialId) : null;
	return { friction: config.friction ?? material?.friction ?? 0, restitution: config.restitution ?? material?.restitution ?? 0 };
}
function layerBit(config: any): number {
	return (2 ** Math.max(0, Math.min(31, config.collisionLayer ?? 0))) >>> 0;
}
function includesLayer(mask: unknown, config: any, fallback: number): boolean {
	const value = typeof mask === "number" && Number.isSafeInteger(mask) ? mask >>> 0 : fallback >>> 0;
	return (value & layerBit(config)) !== 0;
}
function layerDecision(config: any, other: any): { allowed: boolean; priority: number } | null {
	const overrides = config.layerOverrides ?? {};
	if (includesLayer(overrides.excludeLayers, other, 0)) {
		return { allowed: false, priority: overrides.priority ?? 0 };
	}
	if (includesLayer(overrides.includeLayers, other, 0)) {
		return { allowed: true, priority: overrides.priority ?? 0 };
	}
	return null;
}
function allowsLayerCollision(first: IRuntimeBody, second: IRuntimeBody): boolean {
	const firstDecision = layerDecision(first.config, second.config);
	const secondDecision = layerDecision(second.config, first.config);
	if (!firstDecision && !secondDecision) {
		return true;
	}
	if (!firstDecision) {
		return secondDecision!.allowed;
	}
	if (!secondDecision) {
		return firstDecision.allowed;
	}
	if (firstDecision.priority !== secondDecision.priority) {
		return firstDecision.priority > secondDecision.priority ? firstDecision.allowed : secondDecision.allowed;
	}
	return firstDecision.allowed && secondDecision.allowed;
}
function sendsForce(source: IRuntimeBody, target: IRuntimeBody): boolean {
	return (
		includesLayer(source.config.layerOverrides?.forceSendLayers, target.config, 0xffffffff) &&
		includesLayer(target.config.layerOverrides?.forceReceiveLayers, source.config, 0xffffffff)
	);
}
function reportsCallback(first: IRuntimeBody, second: IRuntimeBody): boolean {
	const firstReports =
		includesLayer(first.config.layerOverrides?.callbackLayers, second.config, 0xffffffff) &&
		includesLayer(second.config.layerOverrides?.contactCaptureLayers, first.config, 0xffffffff);
	const secondReports =
		includesLayer(second.config.layerOverrides?.callbackLayers, first.config, 0xffffffff) &&
		includesLayer(first.config.layerOverrides?.contactCaptureLayers, second.config, 0xffffffff);
	return firstReports || secondReports;
}
function resolve(
	first: IRuntimeBody,
	second: IRuntimeBody,
	result: IPhysics2DContact,
	materials: Map<string, any>,
	mode: "position" | "velocity",
	response: IPhysics2DContactResponse = { useFriction: true, useBounce: true }
): void {
	const firstResponds = first.config.bodyType === "dynamic" && sendsForce(second, first);
	const secondResponds = second.config.bodyType === "dynamic" && sendsForce(first, second);
	const firstMassX = firstResponds && !first.config.freezePositionX ? first.massProperties.inverseMass : 0;
	const firstMassY = firstResponds && !first.config.freezePositionY ? first.massProperties.inverseMass : 0;
	const secondMassX = secondResponds && !second.config.freezePositionX ? second.massProperties.inverseMass : 0;
	const secondMassY = secondResponds && !second.config.freezePositionY ? second.massProperties.inverseMass : 0;
	const firstInertia = firstResponds ? first.massProperties.inverseInertia : 0;
	const secondInertia = secondResponds ? second.massProperties.inverseInertia : 0;
	const firstCenter = bodyPoint(first, first.massProperties.centerOfMass);
	const secondCenter = bodyPoint(second, second.massProperties.centerOfMass);
	const firstArm: IPoint2D = [result.point[0] - firstCenter[0], result.point[1] - firstCenter[1]];
	const secondArm: IPoint2D = [result.point[0] - secondCenter[0], result.point[1] - secondCenter[1]];
	const normalDenominator =
		(firstMassX + secondMassX) * result.normal.x ** 2 +
		(firstMassY + secondMassY) * result.normal.y ** 2 +
		(firstArm[0] * result.normal.y - firstArm[1] * result.normal.x) ** 2 * firstInertia +
		(secondArm[0] * result.normal.y - secondArm[1] * result.normal.x) ** 2 * secondInertia;
	const positionDenominator = (firstMassX + secondMassX) * result.normal.x ** 2 + (firstMassY + secondMassY) * result.normal.y ** 2;
	if (mode === "position") {
		if (positionDenominator > 0) {
			first.translate2D([
				-(result.normal.x * result.penetration * firstMassX) / positionDenominator,
				-(result.normal.y * result.penetration * firstMassY) / positionDenominator,
			]);
			second.translate2D([
				(result.normal.x * result.penetration * secondMassX) / positionDenominator,
				(result.normal.y * result.penetration * secondMassY) / positionDenominator,
			]);
		}
		return;
	}
	if (normalDenominator <= 0) {
		return;
	}
	let relativeX = second.velocity.x - second.angularVelocity * secondArm[1] - first.velocity.x + first.angularVelocity * firstArm[1];
	let relativeY = second.velocity.y + second.angularVelocity * secondArm[0] - first.velocity.y - first.angularVelocity * firstArm[0];
	const alongNormal = relativeX * result.normal.x + relativeY * result.normal.y;
	if (alongNormal >= 0) {
		return;
	}
	const firstProperties = properties(first.config, materials),
		secondProperties = properties(second.config, materials);
	const restitution = response.useBounce ? (firstProperties.restitution + secondProperties.restitution) / 2 : 0;
	const impulse = (-(1 + restitution) * alongNormal) / normalDenominator;
	const applyImpulse = (body: IRuntimeBody, mass: IPoint2D, inverseInertia: number, arm: IPoint2D, impulseValue: IPoint2D): void => {
		const [massX, massY] = mass;
		const [x, y] = impulseValue;
		body.velocity.x = Math.max(-MaxPhysics2DLinearVelocity, Math.min(MaxPhysics2DLinearVelocity, body.velocity.x + x * massX));
		body.velocity.y = Math.max(-MaxPhysics2DLinearVelocity, Math.min(MaxPhysics2DLinearVelocity, body.velocity.y + y * massY));
		body.angularVelocity = Math.max(-MaxPhysics2DAngularVelocity, Math.min(MaxPhysics2DAngularVelocity, body.angularVelocity + (arm[0] * y - arm[1] * x) * inverseInertia));
	};
	applyImpulse(first, [firstMassX, firstMassY], firstInertia, firstArm, [-result.normal.x * impulse, -result.normal.y * impulse]);
	applyImpulse(second, [secondMassX, secondMassY], secondInertia, secondArm, [result.normal.x * impulse, result.normal.y * impulse]);
	if (!response.useFriction) {
		return;
	}
	relativeX = second.velocity.x - second.angularVelocity * secondArm[1] - first.velocity.x + first.angularVelocity * firstArm[1];
	relativeY = second.velocity.y + second.angularVelocity * secondArm[0] - first.velocity.y - first.angularVelocity * firstArm[0];
	const tangentX = relativeX - result.normal.x * (relativeX * result.normal.x + relativeY * result.normal.y);
	const tangentY = relativeY - result.normal.y * (relativeX * result.normal.x + relativeY * result.normal.y);
	const tangentLength = Math.hypot(tangentX, tangentY);
	if (tangentLength < 0.0000001) {
		return;
	}
	const tangent: IPoint2D = [tangentX / tangentLength, tangentY / tangentLength];
	const tangentDenominator =
		(firstMassX + secondMassX) * tangent[0] ** 2 +
		(firstMassY + secondMassY) * tangent[1] ** 2 +
		(firstArm[0] * tangent[1] - firstArm[1] * tangent[0]) ** 2 * firstInertia +
		(secondArm[0] * tangent[1] - secondArm[1] * tangent[0]) ** 2 * secondInertia;
	if (tangentDenominator <= 0) {
		return;
	}
	const maximum = Math.abs(impulse) * Math.sqrt(firstProperties.friction * secondProperties.friction);
	const frictionImpulse = Math.max(-maximum, Math.min(-(relativeX * tangent[0] + relativeY * tangent[1]) / tangentDenominator, maximum));
	applyImpulse(first, [firstMassX, firstMassY], firstInertia, firstArm, [-tangent[0] * frictionImpulse, -tangent[1] * frictionImpulse]);
	applyImpulse(second, [secondMassX, secondMassY], secondInertia, secondArm, [tangent[0] * frictionImpulse, tangent[1] * frictionImpulse]);
}

function stableVariation(first: string, second: string): number {
	let hash = 2166136261;
	for (const character of `${first}\0${second}`) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return ((hash >>> 0) / 0xffffffff) * 2 - 1;
}

function rigidBodyCenter(body: IRuntimeBody): IPoint2D {
	return bodyPoint(body, body.massProperties.centerOfMass);
}

/** Applies a Unity-style force in newtons at either the mass center or collider center. */
function applyEffectorForce(body: IRuntimeBody, force: IPoint2D, target: IPoint2D | null, step: number): void {
	const velocityScale = body.massProperties.inverseMass * 100 * step;
	if (!body.config.freezePositionX) {
		body.velocity.x += force[0] * velocityScale;
	}
	if (!body.config.freezePositionY) {
		body.velocity.y += force[1] * velocityScale;
	}
	if (target && !body.config.freezeRotation && body.massProperties.inverseInertia > 0) {
		const centerOfMass = rigidBodyCenter(body);
		const arm: IPoint2D = [target[0] - centerOfMass[0], target[1] - centerOfMass[1]];
		body.angularVelocity += (arm[0] * force[1] - arm[1] * force[0]) * body.massProperties.inverseInertia * 100 * step;
	}
}

/** Exponential retention is stable across different fixed-step sizes and cannot reverse a body. */
function applyEffectorDrag(body: IRuntimeBody, linearDrag: number, angularDrag: number, step: number): void {
	const linearRetention = Math.exp(-linearDrag * step);
	body.velocity.x *= body.config.freezePositionX ? 0 : linearRetention;
	body.velocity.y *= body.config.freezePositionY ? 0 : linearRetention;
	body.angularVelocity *= body.config.freezeRotation ? 0 : Math.exp(-angularDrag * step);
}

function passesEffectorMask(effector: IPhysics2DEffectorConfiguration, body: IRuntimeBody): boolean {
	return !effector.useColliderMask || includesLayer(effector.colliderMask, body.config, 0);
}

/** A current effector owns a Collider2D marked Used by Effector; body opt-in is not a target-side flag. */
function currentEffectorSource(bodies: IRuntimeBody[], effector: IPhysics2DEffectorConfiguration): IRuntimeBody | null {
	return bodies.find((body) => body.config.nodeId === effector.nodeId && body.config.enabled !== false && body.config.usedByEffector) ?? null;
}

/** Keeps pre-v2 scenes operational when their old radial effector node never had a Physics 2D collider. */
function applyLegacyRadialEffector(
	body: IRuntimeBody,
	node: TransformNode,
	effector: IPhysics2DPointEffectorConfiguration | IPhysics2DAreaEffectorConfiguration,
	step: number
): void {
	const delta = node.position.subtract(body.node.position);
	const distance = Math.hypot(delta.x, delta.y);
	if (distance > effector.radius) {
		return;
	}
	const strength = effector.force * Math.pow(1 - distance / effector.radius, effector.falloff);
	if (effector.type === "area") {
		const angle = (effector.forceAngle * Math.PI) / 180;
		body.velocity.x += Math.cos(angle) * strength * step;
		body.velocity.y += Math.sin(angle) * strength * step;
	} else if (distance > 0) {
		// Legacy positive point force attracted toward the node; v2 collider-backed point force follows Unity's outward-positive convention.
		body.velocity.x += (delta.x / distance) * strength * step;
		body.velocity.y += (delta.y / distance) * strength * step;
	}
}

function variedEffectorForce(id: string, nodeId: string, sampleIndex: number, magnitude: number, variation: number): number {
	return magnitude + stableVariation(id, `${nodeId}\0${sampleIndex}`) * variation;
}

function applyPointEffector(bodies: IRuntimeBody[], source: IRuntimeBody, effector: IPhysics2DPointEffectorConfiguration, step: number, sampleIndex: number): void {
	const sourcePoint = effector.forceSource === "collider" ? colliderCenter(source) : rigidBodyCenter(source);
	for (const body of bodies) {
		if (body.config.enabled === false || body.config.bodyType !== "dynamic" || body === source || !passesEffectorMask(effector, body) || !hit(source, body)) {
			continue;
		}
		const targetPoint = effector.forceTarget === "collider" ? colliderCenter(body) : rigidBodyCenter(body);
		const delta: IPoint2D = [targetPoint[0] - sourcePoint[0], targetPoint[1] - sourcePoint[1]];
		const distance = Math.hypot(delta[0], delta[1]);
		if (distance > 0) {
			const scaledDistance = Math.max(0.01, (distance / 100) * effector.distanceScale);
			const attenuation = effector.forceMode === "constant" ? 1 : effector.forceMode === "inverse-linear" ? 1 / scaledDistance : 1 / scaledDistance ** 2;
			const magnitude = variedEffectorForce(effector.id, body.config.nodeId, sampleIndex, effector.forceMagnitude, effector.forceVariation) * attenuation;
			applyEffectorForce(body, [(delta[0] / distance) * magnitude, (delta[1] / distance) * magnitude], effector.forceTarget === "collider" ? targetPoint : null, step);
		}
		applyEffectorDrag(body, effector.linearDrag, effector.angularDrag, step);
	}
}

function applyAreaEffector(bodies: IRuntimeBody[], source: IRuntimeBody, effector: IPhysics2DAreaEffectorConfiguration, step: number, sampleIndex: number): void {
	const angle = (effector.forceAngle * Math.PI) / 180 + (effector.useGlobalAngle ? 0 : source.readAngle2D());
	for (const body of bodies) {
		if (body.config.enabled === false || body.config.bodyType !== "dynamic" || body === source || !passesEffectorMask(effector, body) || !hit(source, body)) {
			continue;
		}
		const magnitude = variedEffectorForce(effector.id, body.config.nodeId, sampleIndex, effector.forceMagnitude, effector.forceVariation);
		const target = effector.forceTarget === "collider" ? colliderCenter(body) : null;
		applyEffectorForce(body, [Math.cos(angle) * magnitude, Math.sin(angle) * magnitude], target, step);
		applyEffectorDrag(body, effector.linearDrag, effector.angularDrag, step);
	}
}

function velocityAtPoint(body: IRuntimeBody, point: IPoint2D): IPoint2D {
	const centerOfMass = rigidBodyCenter(body);
	const arm: IPoint2D = [point[0] - centerOfMass[0], point[1] - centerOfMass[1]];
	return [body.velocity.x - body.angularVelocity * arm[1], body.velocity.y + body.angularVelocity * arm[0]];
}

/** Drives relative contact velocity toward the authored conveyor speed without applying reaction force to the source. */
function applySurfaceContact(
	source: IRuntimeBody,
	target: IRuntimeBody,
	normal: Vector3,
	contactPoint: IPoint2D,
	effector: IPhysics2DSurfaceEffectorConfiguration,
	sampleIndex: number
): void {
	if (target.config.bodyType !== "dynamic" || !passesEffectorMask(effector, target) || effector.forceScale === 0) {
		return;
	}
	const tangent: IPoint2D = [normal.y, -normal.x];
	const applicationPoint = effector.useContactForce ? contactPoint : rigidBodyCenter(target);
	const targetVelocity = velocityAtPoint(target, applicationPoint);
	const sourceVelocity = velocityAtPoint(source, contactPoint);
	const relativeSpeed = (targetVelocity[0] - sourceVelocity[0]) * tangent[0] + (targetVelocity[1] - sourceVelocity[1]) * tangent[1];
	const variation = ((stableVariation(effector.id, `${target.config.nodeId}\0${sampleIndex}`) + 1) / 2) * effector.speedVariation;
	const speedChange = (effector.speed + variation - relativeSpeed) * effector.forceScale;
	const centerOfMass = rigidBodyCenter(target);
	const arm: IPoint2D = [applicationPoint[0] - centerOfMass[0], applicationPoint[1] - centerOfMass[1]];
	const inverseMassX = target.config.freezePositionX ? 0 : target.massProperties.inverseMass;
	const inverseMassY = target.config.freezePositionY ? 0 : target.massProperties.inverseMass;
	const cross = arm[0] * tangent[1] - arm[1] * tangent[0];
	const denominator = tangent[0] ** 2 * inverseMassX + tangent[1] ** 2 * inverseMassY + cross ** 2 * target.massProperties.inverseInertia;
	if (denominator <= 0) {
		return;
	}
	const impulse = speedChange / denominator;
	target.velocity.x = Math.max(-MaxPhysics2DLinearVelocity, Math.min(MaxPhysics2DLinearVelocity, target.velocity.x + tangent[0] * impulse * inverseMassX));
	target.velocity.y = Math.max(-MaxPhysics2DLinearVelocity, Math.min(MaxPhysics2DLinearVelocity, target.velocity.y + tangent[1] * impulse * inverseMassY));
	target.angularVelocity = Math.max(
		-MaxPhysics2DAngularVelocity,
		Math.min(MaxPhysics2DAngularVelocity, target.angularVelocity + cross * impulse * target.massProperties.inverseInertia)
	);
}

function indexPhysics2DEffectors(effectors: IPhysics2DEffectorConfiguration[]): IPhysics2DEffectorsByNode {
	const result: IPhysics2DEffectorsByNode = new Map();
	for (const effector of effectors) {
		const nodeEffectors = result.get(effector.nodeId) ?? [];
		nodeEffectors.push(effector);
		result.set(effector.nodeId, nodeEffectors);
	}
	return result;
}

/** Applies every enabled Surface Effector owned by either collider exactly once per velocity iteration group. */
function applySurfaceContacts(first: IRuntimeBody, second: IRuntimeBody, result: IPhysics2DContact, effectorsByNode: IPhysics2DEffectorsByNode, sampleIndex: number): void {
	for (const [source, target, normal] of [
		[first, second, result.normal],
		[second, first, result.normal.scale(-1)],
	] as [IRuntimeBody, IRuntimeBody, Vector3][]) {
		if (source.config.enabled === false || !source.config.usedByEffector) {
			continue;
		}
		for (const effector of effectorsByNode.get(source.config.nodeId) ?? []) {
			if (effector.type === "surface" && effector.enabled) {
				applySurfaceContact(source, target, normal, result.point, effector, sampleIndex);
			}
		}
	}
}

/** Applies displaced-area lift at the submerged centroid plus Unity-style drag and flow controls. */
function applyBuoyancyEffector(bodies: IRuntimeBody[], liquid: IRuntimeBody, effector: IPhysics2DBuoyancyEffectorConfiguration, step: number, sampleIndex: number): void {
	for (const body of bodies) {
		if (
			body.config.enabled === false ||
			body.config.bodyType !== "dynamic" ||
			body.config.nodeId === effector.nodeId ||
			(effector.useColliderMask && !includesLayer(effector.colliderMask, body.config, 0))
		) {
			continue;
		}
		const submerged = submergedArea(body, liquid, effector);
		if (!submerged) {
			continue;
		}
		const bodyArea = areaPartsForBody(body).reduce((total, points) => total + Math.abs(signedPolygonArea(points)), 0);
		const fraction = Math.min(1, submerged.area / Math.max(bodyArea, 0.000001));
		const displacement = effector.density * submerged.area * body.massProperties.inverseMass;
		const acceleration: IPoint2D = [-body.config.gravity[0] * body.config.gravityScale * displacement, -body.config.gravity[1] * body.config.gravityScale * displacement];
		const velocityChange: IPoint2D = [body.config.freezePositionX ? 0 : acceleration[0] * step, body.config.freezePositionY ? 0 : acceleration[1] * step];
		body.velocity.x += velocityChange[0];
		body.velocity.y += velocityChange[1];

		// Applying lift at the center of buoyancy lets asymmetric submersion right a freely rotating body.
		if (!body.config.freezeRotation && body.massProperties.inverseInertia > 0) {
			const cosine = Math.cos(body.readAngle2D());
			const sine = Math.sin(body.readAngle2D());
			const massCenter = bodyPoint(body, body.massProperties.centerOfMass, cosine, sine);
			const arm: IPoint2D = [submerged.center[0] - massCenter[0], submerged.center[1] - massCenter[1]];
			body.angularVelocity += (arm[0] * velocityChange[1] - arm[1] * velocityChange[0]) * body.massProperties.mass * body.massProperties.inverseInertia;
		}

		const flowAngle = (effector.flowAngle * Math.PI) / 180;
		const variation = ((stableVariation(effector.id, `${body.config.nodeId}\0${sampleIndex}`) + 1) / 2) * effector.flowVariation;
		const flow = (effector.flowMagnitude + variation) * fraction;
		applyEffectorForce(body, [Math.cos(flowAngle) * flow, Math.sin(flowAngle) * flow], null, step);
		const linearRetention = Math.exp(-effector.linearDrag * fraction * step);
		const angularRetention = Math.exp(-effector.angularDrag * fraction * step);
		body.velocity.x *= body.config.freezePositionX ? 0 : linearRetention;
		body.velocity.y *= body.config.freezePositionY ? 0 : linearRetention;
		body.angularVelocity *= body.config.freezeRotation ? 0 : angularRetention;
	}
}

function applyEffectors(bodies: IRuntimeBody[], scene: Scene, effectors: IPhysics2DEffectorConfiguration[], step: number, sampleIndex: number): void {
	for (const effector of effectors) {
		if (effector.enabled === false) {
			continue;
		}
		const node = scene.getNodeById(effector.nodeId);
		if (!isRuntimeTransformNode(node)) {
			continue;
		}
		if (effector.type === "platform") {
			continue;
		}
		if (effector.type === "buoyancy") {
			const liquid = bodies.find(
				(body) => body.config.nodeId === effector.nodeId && body.config.enabled !== false && body.config.bodyType === "static" && body.config.usedByEffector
			);
			if (liquid) {
				applyBuoyancyEffector(bodies, liquid, effector, step, sampleIndex);
			}
			continue;
		}
		const source = currentEffectorSource(bodies, effector);
		if (effector.type === "point" || effector.type === "area") {
			if (source) {
				if (effector.type === "point") {
					applyPointEffector(bodies, source, effector, step, sampleIndex);
				} else {
					applyAreaEffector(bodies, source, effector, step, sampleIndex);
				}
			} else if (!bodies.some((body) => body.config.nodeId === effector.nodeId)) {
				for (const body of bodies) {
					if (body.config.enabled !== false && body.config.bodyType === "dynamic" && passesEffectorMask(effector, body)) {
						applyLegacyRadialEffector(body, node, effector, step);
					}
				}
			}
			continue;
		}
		// Collider-backed Surface Effectors run against the solver's actual contact; this branch is only the v1 collider-less ring fallback.
		if (bodies.some((body) => body.config.nodeId === effector.nodeId)) {
			continue;
		}
		for (const body of bodies) {
			if (body.config.enabled === false || body.config.bodyType !== "dynamic" || body.config.nodeId === effector.nodeId) {
				continue;
			}
			const delta = node.position.subtract(body.node.position);
			const distance = Math.hypot(delta.x, delta.y);
			if (distance > effector.radius) {
				continue;
			}
			if (!distance || Math.abs(distance - effector.radius) > effector.surfaceThickness / 2) {
				continue;
			}
			body.velocity.x += (-delta.y / distance) * effector.force * step;
			body.velocity.y += (delta.x / distance) * effector.force * step;
		}
	}
}

function platformUp(platform: IRuntimeBody, effector: IPhysics2DPlatformEffectorConfiguration): Vector3 {
	const angle = effector.usesLegacyWorldAngle ? (effector.platformAngle * Math.PI) / 180 : platform.readAngle2D() + Math.PI / 2 + (effector.rotationalOffset * Math.PI) / 180;
	return new Vector3(Math.cos(angle), Math.sin(angle), 0);
}

function normalWithinArc(normal: Vector3, axis: Vector3, arc: number): boolean {
	return arc > 0 && (arc >= 360 || Vector3.Dot(normal, axis) >= Math.cos((arc * Math.PI) / 360));
}

function normalWithinSideArc(normal: Vector3, up: Vector3, arc: number): boolean {
	const right = new Vector3(up.y, -up.x, 0);
	return arc > 0 && Math.abs(Vector3.Dot(normal, right)) >= Math.cos((arc * Math.PI) / 360);
}

function allowsPlatformCollision(first: IRuntimeBody, second: IRuntimeBody, result: { normal: Vector3 }, effectorsByNode: IPhysics2DEffectorsByNode): boolean {
	for (const [platform, other, normal] of [
		[first, second, result.normal],
		[second, first, result.normal.scale(-1)],
	] as [IRuntimeBody, IRuntimeBody, Vector3][]) {
		if (platform.config.enabled === false || !platform.config.usedByEffector) {
			continue;
		}
		for (const effector of effectorsByNode.get(platform.config.nodeId) ?? []) {
			if (
				effector.type === "platform" &&
				effector.enabled &&
				effector.useOneWay &&
				passesEffectorMask(effector, other) &&
				!normalWithinArc(normal, platformUp(platform, effector), effector.surfaceArc)
			) {
				// One runtime body owns one collider, so Unity's multi-collider one-way grouping is already atomic for the supported data model.
				return false;
			}
		}
	}
	return true;
}

/** Computes material-response removals contributed by Surface and Platform side behavior. */
function effectorContactResponse(first: IRuntimeBody, second: IRuntimeBody, result: IPhysics2DContact, effectorsByNode: IPhysics2DEffectorsByNode): IPhysics2DContactResponse {
	const response: IPhysics2DContactResponse = { useFriction: true, useBounce: true };
	for (const [source, target, normal] of [
		[first, second, result.normal],
		[second, first, result.normal.scale(-1)],
	] as [IRuntimeBody, IRuntimeBody, Vector3][]) {
		if (source.config.enabled === false || !source.config.usedByEffector) {
			continue;
		}
		for (const effector of effectorsByNode.get(source.config.nodeId) ?? []) {
			if (!effector.enabled || !passesEffectorMask(effector, target)) {
				continue;
			}
			if (effector.type === "surface") {
				response.useFriction &&= effector.useFriction;
				response.useBounce &&= effector.useBounce;
			} else if (effector.type === "platform" && normalWithinSideArc(normal, platformUp(source, effector), effector.sideArc)) {
				response.useFriction &&= effector.useSideFriction;
				response.useBounce &&= effector.useSideBounce;
			}
		}
	}
	return response;
}

/** Reconciles replaced metadata objects while retaining velocities for unchanged authored bodies. */
function synchronizePhysics2DBodies(scene: Scene, runtime: IRuntimePhysics2D): void {
	const configurations = Array.isArray(scene.metadata?.babylonEditorPhysics2D) ? scene.metadata.babylonEditorPhysics2D : [];
	const normalizedWorldSettings = normalizePhysics2DSettingsConfiguration(scene.metadata?.babylonEditorPhysics2DSettings);
	const fallbackWorldSettings = normalizePhysics2DSettingsConfiguration(undefined);
	const worldSettings = normalizedWorldSettings.ok ? normalizedWorldSettings.value : fallbackWorldSettings.ok ? fallbackWorldSettings.value : null;
	if (!worldSettings) {
		return;
	}
	const activeIds = new Set<string>();
	const invalidBodies: IPhysics2DInvalidBody[] = [];
	let invalidBodyCount = Math.max(0, configurations.length - MaxPhysics2DBodies);
	for (let index = 0; index < Math.min(configurations.length, MaxPhysics2DBodies); index++) {
		const source = configurations[index];
		const result = normalizePhysics2DBodyConfiguration(source);
		const sourceNodeId = typeof source?.nodeId === "string" ? source.nodeId : null;
		if (!result.ok) {
			invalidBodyCount++;
			if (invalidBodies.length < 64) {
				invalidBodies.push({ index, nodeId: sourceNodeId, error: result.error });
			}
			continue;
		}
		const config = result.value;
		const world = worldById(worldSettings, config.worldId);
		if (!world) {
			invalidBodyCount++;
			if (invalidBodies.length < 64) {
				invalidBodies.push({ index, nodeId: config.nodeId, error: `Physics 2D body "${config.nodeId}" references missing world "${config.worldId}".` });
			}
			continue;
		}
		if (activeIds.has(config.nodeId)) {
			invalidBodyCount++;
			if (invalidBodies.length < 64) {
				invalidBodies.push({ index, nodeId: config.nodeId, error: `Physics 2D body "${config.nodeId}" is duplicated.` });
			}
			continue;
		}
		activeIds.add(config.nodeId);
		const node = scene.getNodeById(config.nodeId);
		const existing = runtime.bodies.get(config.nodeId);
		if (isRuntimeTransformNode(node) && existing?.node === node && existing.source === source && !node.isDisposed()) {
			existing.world = world;
			if (worldSettings.globalTransformReadMode === "authoring") {
				const authoredPosition = planePosition(node, world.transformPlane);
				const authoredAngle = planeAngle(node, world.transformPlane);
				if (
					Math.hypot(authoredPosition[0] - existing.lastWrittenPosition2D[0], authoredPosition[1] - existing.lastWrittenPosition2D[1]) > 0.000001 ||
					Math.abs(authoredAngle - existing.lastWrittenAngle2D) > 0.000001
				) {
					existing.position2D = authoredPosition;
					existing.angle2D = authoredAngle;
				}
				existing.lastWrittenPosition2D = authoredPosition;
				existing.lastWrittenAngle2D = authoredAngle;
			}
			continue;
		}
		if (isRuntimeTransformNode(node)) {
			const runtimeBody: IRuntimeBody = {
				source,
				config,
				node,
				velocity: Vector3.FromArray([...config.velocity, 0]),
				angularVelocity: config.angularVelocity,
				force: Vector3.Zero(),
				torque: 0,
				massProperties: computePhysics2DMassProperties(config),
				world,
				position2D: planePosition(node, world.transformPlane),
				angle2D: planeAngle(node, world.transformPlane),
				lastWrittenPosition2D: planePosition(node, world.transformPlane),
				lastWrittenAngle2D: planeAngle(node, world.transformPlane),
				readPosition2D: () => [...runtimeBody.position2D],
				readAngle2D: () => runtimeBody.angle2D,
				translate2D: (delta) => {
					runtimeBody.position2D[0] += delta[0];
					runtimeBody.position2D[1] += delta[1];
				},
				rotate2D: (delta) => {
					runtimeBody.angle2D += delta;
				},
			};
			runtime.bodies.set(config.nodeId, runtimeBody);
		} else {
			runtime.bodies.delete(config.nodeId);
			invalidBodyCount++;
			if (invalidBodies.length < 64) {
				invalidBodies.push({ index, nodeId: config.nodeId, error: `Physics 2D node "${config.nodeId}" was not found.` });
			}
		}
	}
	for (const id of runtime.bodies.keys()) {
		if (!activeIds.has(id)) {
			runtime.bodies.delete(id);
		}
	}
	runtime.invalidBodyCount = invalidBodyCount;
	runtime.invalidBodies = invalidBodies;
	runtime.metadataTruncated = configurations.length > MaxPhysics2DBodies || invalidBodyCount > invalidBodies.length;
}

function physics2DJointPairKey(firstNodeId: string, secondNodeId: string): string {
	return firstNodeId < secondNodeId ? `${firstNodeId}\u0000${secondNodeId}` : `${secondNodeId}\u0000${firstNodeId}`;
}

function refreshPhysics2DBlockedCollisionPairs(runtime: IRuntimePhysics2D): void {
	runtime.blockedCollisionPairs = new Set(
		[...runtime.joints.values()]
			.filter(
				(joint) =>
					joint.config.enabled &&
					!joint.broken &&
					!joint.config.enableCollision &&
					joint.first.config.enabled &&
					joint.second?.config.enabled &&
					joint.config.secondNodeId !== undefined
			)
			.map((joint) => physics2DJointPairKey(joint.config.firstNodeId, joint.config.secondNodeId!))
	);
}

/** Rebuilds joint ownership atomically while preserving break state for unchanged metadata objects. */
function synchronizePhysics2DJoints(scene: Scene, runtime: IRuntimePhysics2D): void {
	const configurations = Array.isArray(scene.metadata?.babylonEditorPhysics2DJoints) ? scene.metadata.babylonEditorPhysics2DJoints : [];
	const next = new Map<string, IPhysics2DRuntimeJoint>();
	const invalidJoints: IPhysics2DInvalidJoint[] = [];
	const ids = new Set<string>();
	let invalidJointCount = Math.max(0, configurations.length - MaxPhysics2DJoints);
	for (let index = 0; index < Math.min(configurations.length, MaxPhysics2DJoints); index++) {
		const source = configurations[index];
		const normalized = normalizePhysics2DJointConfiguration(source);
		const sourceId = typeof source?.id === "string" ? source.id : null;
		if (!normalized.ok) {
			invalidJointCount++;
			if (invalidJoints.length < 64) {
				invalidJoints.push({ index, id: sourceId, error: normalized.error });
			}
			continue;
		}
		const config = normalized.value;
		if (ids.has(config.id)) {
			invalidJointCount++;
			if (invalidJoints.length < 64) {
				invalidJoints.push({ index, id: config.id, error: `Physics 2D joint id "${config.id}" is duplicated.` });
			}
			continue;
		}
		ids.add(config.id);
		const first = runtime.bodies.get(config.firstNodeId);
		const second = config.secondNodeId === undefined ? undefined : runtime.bodies.get(config.secondNodeId);
		if (!first || (config.secondNodeId !== undefined && !second)) {
			invalidJointCount++;
			if (invalidJoints.length < 64) {
				invalidJoints.push({ index, id: config.id, error: `Physics 2D joint "${config.id}" references a body that is not active.` });
			}
			continue;
		}
		if (second && first.world.id !== second.world.id) {
			invalidJointCount++;
			if (invalidJoints.length < 64) {
				invalidJoints.push({ index, id: config.id, error: `Physics 2D joint "${config.id}" cannot connect worlds "${first.world.id}" and "${second.world.id}".` });
			}
			continue;
		}
		const existing = runtime.joints.get(config.id);
		if (existing && existing.source === source && existing.first === first && existing.second === second) {
			next.set(config.id, existing);
			continue;
		}
		next.set(config.id, {
			source,
			config: resolvePhysics2DJointAutoConfiguration(config, first, second),
			first,
			second,
			broken: false,
			breakNotified: false,
			reactionLinearImpulse: [0, 0],
			reactionAngularImpulse: 0,
			linearMotorImpulse: [0, 0],
			motorImpulse: 0,
			lastStepSeconds: 0,
		});
	}
	runtime.joints = next;
	runtime.invalidJointCount = invalidJointCount;
	runtime.invalidJoints = invalidJoints;
	runtime.jointMetadataTruncated = configurations.length > MaxPhysics2DJoints || invalidJointCount > invalidJoints.length;
	refreshPhysics2DBlockedCollisionPairs(runtime);
}

function evaluatePhysics2DJointBreak(scene: Scene, runtime: IRuntimePhysics2D, joint: IPhysics2DRuntimeJoint): void {
	if (joint.broken || joint.breakNotified || joint.config.breakAction === "ignore") {
		return;
	}
	const state = physics2DJointRuntimeState(joint);
	const force = Math.hypot(state.reactionForce[0], state.reactionForce[1]);
	const exceedsForce = joint.config.breakForce !== undefined && force > joint.config.breakForce;
	const exceedsTorque = joint.config.breakTorque !== undefined && Math.abs(state.reactionTorque) > joint.config.breakTorque;
	if (!exceedsForce && !exceedsTorque) {
		return;
	}
	joint.breakNotified = true;
	joint.broken = joint.config.breakAction === "disable" || joint.config.breakAction === "destroy";
	const event: IPhysics2DJointBreakEvent = {
		jointId: joint.config.id,
		type: joint.config.type,
		firstNodeId: joint.config.firstNodeId,
		...(joint.config.secondNodeId ? { secondNodeId: joint.config.secondNodeId } : {}),
		action: joint.config.breakAction,
		reactionForce: [...state.reactionForce],
		reactionTorque: state.reactionTorque,
	};
	runtime.jointBreakEvents.push(event);
	scene.physics2DJointBreakEvents?.push({ ...event, reactionForce: [...event.reactionForce] });
	scene.onPhysics2DJointBreakObservable?.notifyObservers({ ...event, reactionForce: [...event.reactionForce] });
	if (joint.broken) {
		refreshPhysics2DBlockedCollisionPairs(runtime);
	}
}

function minimumColliderFeature(body: IRuntimeBody): number {
	const collider = body.config.collider;
	if (collider.shape === "circle") {
		return collider.radius! * 2;
	}
	if (collider.shape === "box" || collider.shape === "capsule") {
		return Math.min(...collider.size!);
	}
	if (collider.shape === "edge") {
		return Math.max(collider.edgeRadius! * 2, MinimumPhysics2DEdgeRadius * 2);
	}
	let minimum = Infinity;
	for (const points of collider.parts ?? [collider.points!]) {
		for (const axis of axes(points)) {
			const [start, end] = polygonRange(points, axis);
			minimum = Math.min(minimum, end - start);
		}
	}
	return Number.isFinite(minimum) ? Math.max(minimum, 0.001) : 0.001;
}

function colliderSweepRadius(body: IRuntimeBody): number {
	const collider = body.config.collider;
	if (collider.shape === "circle") {
		return Math.hypot(...collider.offset) + collider.radius!;
	}
	if (collider.shape === "box" || collider.shape === "capsule") {
		return Math.hypot(...collider.offset) + Math.hypot(collider.size![0] / 2, collider.size![1] / 2);
	}
	return Math.max(...collider.points!.map((point) => Math.hypot(point[0] + collider.offset[0], point[1] + collider.offset[1]))) + (collider.edgeRadius ?? 0);
}

function continuousSubsteps(bodies: IRuntimeBody[], step: number): number {
	const continuous = bodies.filter((body) => body.config.enabled !== false && body.config.bodyType === "dynamic" && body.config.collisionDetection === "continuous");
	const obstacles = bodies.filter((body) => body.config.enabled !== false && body.config.bodyType !== "dynamic");
	if (!continuous.length || !obstacles.length) {
		return 1;
	}
	const minimumFeature = Math.min(...continuous.map(minimumColliderFeature), ...obstacles.map(minimumColliderFeature));
	const obstacleSweep = Math.max(
		0,
		...obstacles.map((body) => (Math.hypot(body.velocity.x, body.velocity.y) + Math.abs(body.angularVelocity) * colliderSweepRadius(body)) * step)
	);
	const maximumSweep = Math.max(
		...continuous.map((body) => (Math.hypot(body.velocity.x, body.velocity.y) + Math.abs(body.angularVelocity) * colliderSweepRadius(body)) * step + obstacleSweep)
	);
	const required = Math.max(1, Math.ceil(maximumSweep / Math.max(minimumFeature / 2, 0.0005)));
	if (required > MaxPhysics2DContinuousSubsteps) {
		throw new Error(`Physics 2D continuous collision requires ${required} substeps, exceeding the bounded limit of ${MaxPhysics2DContinuousSubsteps}.`);
	}
	return required;
}

function allowsWorldContact(first: IRuntimeBody, second: IRuntimeBody): boolean {
	if (first.world.id !== second.world.id || !first.world.enabled) {
		return false;
	}
	if (first.world.contactFilterMode === "none") {
		return false;
	}
	return first.world.contactFilterMode === "all" || allowsLayerCollision(first, second);
}

/** Commits canonical solver poses through the world's direct/interpolated/tween transform policy and publishes callbacks. */
function flushPhysics2DTransforms(scene: Scene, runtime: IRuntimePhysics2D, bodies: IRuntimeBody[], step: number): void {
	scene.physics2DTransformWriteEvents = [];
	runtime.transformWriteEvents = [];
	for (const body of bodies) {
		if (!body.world.enabled || body.config.bodyType === "static") {
			continue;
		}
		const currentPosition = planePosition(body.node, body.world.transformPlane);
		const currentAngle = planeAngle(body.node, body.world.transformPlane);
		const target: [number, number, number] = [body.position2D[0], body.position2D[1], body.angle2D];
		const direct = body.world.transformWriteMode === "direct" || body.world.syncInterpolation;
		const alpha = direct
			? 1
			: body.world.transformWriteMode === "interpolate"
				? 1 - Math.exp(-12 * step)
				: body.world.tweenDurationSeconds <= 0
					? 1
					: Math.min(1, step / body.world.tweenDurationSeconds);
		const applied: [number, number, number] = [
			currentPosition[0] + (target[0] - currentPosition[0]) * alpha,
			currentPosition[1] + (target[1] - currentPosition[1]) * alpha,
			currentAngle + (target[2] - currentAngle) * alpha,
		];
		const targetVector = planeVector(body.world.transformPlane, [applied[0], applied[1]]);
		body.node.position.set(targetVector[0], targetVector[1], targetVector[2]);
		writePlaneAngle(body.node, body.world.transformPlane, applied[2]);
		body.lastWrittenPosition2D = [applied[0], applied[1]];
		body.lastWrittenAngle2D = applied[2];
		const event: IPhysics2DTransformWriteEvent = {
			nodeId: body.config.nodeId,
			worldId: body.world.id,
			mode: body.world.transformWriteMode,
			from: [currentPosition[0], currentPosition[1], currentAngle],
			target,
			applied,
			tweening: alpha < 1,
		};
		scene.physics2DTransformWriteEvents.push(event);
		runtime.transformWriteEvents.push(event);
		scene.onPhysics2DTransformWriteObservable?.notifyObservers(event);
		if (event.tweening) {
			scene.onPhysics2DTransformTweenObservable?.notifyObservers(event);
		}
	}
}

function advancePhysics2D(scene: Scene, runtime: IRuntimePhysics2D, step: number): number {
	synchronizePhysics2DJoints(scene, runtime);
	const configuration = settings(scene);
	const bodies = [...runtime.bodies.values()].filter((body) => body.world.enabled);
	const joints = [...runtime.joints.values()].filter((joint) => joint.first.world.enabled);
	const velocityIterations = Math.max(...configuration.worlds.filter((world) => world.enabled).map((world) => world.velocityIterations), 1);
	const positionIterations = Math.max(...configuration.worlds.filter((world) => world.enabled).map((world) => world.positionIterations), 1);
	const effectorResult = normalizePhysics2DEffectorConfigurations(scene.metadata?.babylonEditorPhysics2DEffectors ?? []);
	// Runtime work is all-or-nothing: one malformed entry cannot partially apply a different persisted effector set.
	const effectors = effectorResult.ok ? effectorResult.value : [];
	const effectorsByNode = indexPhysics2DEffectors(effectors);
	const effectorSampleIndex = runtime.totalAutomaticSteps + runtime.totalManualSteps;
	const effectorChecks = effectors.length * bodies.length;
	if (effectorChecks > MaxPhysics2DEffectorChecks) {
		throw new Error(`Physics 2D effectors require ${effectorChecks} body checks, exceeding the bounded limit of ${MaxPhysics2DEffectorChecks}.`);
	}
	const materials = new Map<string, any>((scene.metadata?.babylonEditorPhysics2DMaterials ?? []).map((material: any): [string, any] => [material.id, material]));
	runtime.collisions = 0;
	runtime.triggers = [];
	runtime.jointBreakEvents = [];
	scene.physics2DTriggerEvents = [];
	scene.physics2DJointBreakEvents = [];
	joints.forEach((joint) => beginPhysics2DJointStep(joint, step));
	const integrations: Array<{
		body: IRuntimeBody;
		velocityX: number;
		velocityY: number;
		angularVelocity: number;
		previousVelocity: Vector3;
		previousAngularVelocity: number;
		previousForce: Vector3;
		previousTorque: number;
	}> = [];
	for (const body of bodies) {
		if (body.config.enabled !== false && body.config.bodyType === "dynamic") {
			const gravity = body.config.gravity;
			const velocityX = body.config.freezePositionX
				? 0
				: (body.velocity.x + (gravity[0] * body.config.gravityScale + body.force.x * body.massProperties.inverseMass * 100) * step) * (1 - body.config.linearDamping);
			const velocityY = body.config.freezePositionY
				? 0
				: (body.velocity.y + (gravity[1] * body.config.gravityScale + body.force.y * body.massProperties.inverseMass * 100) * step) * (1 - body.config.linearDamping);
			const angularVelocity = body.config.freezeRotation
				? 0
				: (body.angularVelocity + body.torque * body.massProperties.inverseInertia * 100 * step) * (1 - body.config.angularDamping);
			if (
				![velocityX, velocityY, angularVelocity].every(Number.isFinite) ||
				Math.abs(velocityX) > MaxPhysics2DLinearVelocity ||
				Math.abs(velocityY) > MaxPhysics2DLinearVelocity ||
				Math.abs(angularVelocity) > MaxPhysics2DAngularVelocity
			) {
				throw new Error(`Physics 2D body "${body.config.nodeId}" would exceed the bounded runtime velocity range.`);
			}
			integrations.push({
				body,
				velocityX,
				velocityY,
				angularVelocity,
				previousVelocity: body.velocity.clone(),
				previousAngularVelocity: body.angularVelocity,
				previousForce: body.force.clone(),
				previousTorque: body.torque,
			});
		}
	}
	// Apply only after every body passes preflight so one invalid body cannot partially advance peers.
	for (const integration of integrations) {
		integration.body.velocity.x = integration.velocityX;
		integration.body.velocity.y = integration.velocityY;
		integration.body.angularVelocity = integration.angularVelocity;
		integration.body.force.setAll(0);
		integration.body.torque = 0;
	}
	// Successful manual and automatic frames share one deterministic sequence; failed frames retry the same sample.
	for (const world of configuration.worlds.filter((candidate) => candidate.enabled)) {
		const worldBodies = bodies.filter((body) => body.world.id === world.id);
		const worldBodyIds = new Set(worldBodies.map((body) => body.config.nodeId));
		applyEffectors(
			worldBodies,
			scene,
			effectors.filter((effector) => worldBodyIds.has(effector.nodeId) || (world.id === DefaultPhysics2DWorldId && !runtime.bodies.has(effector.nodeId))),
			step,
			effectorSampleIndex
		);
	}
	let substeps = 1;
	try {
		for (const body of bodies) {
			if (
				![body.velocity.x, body.velocity.y, body.angularVelocity].every(Number.isFinite) ||
				Math.abs(body.velocity.x) > MaxPhysics2DLinearVelocity ||
				Math.abs(body.velocity.y) > MaxPhysics2DLinearVelocity ||
				Math.abs(body.angularVelocity) > MaxPhysics2DAngularVelocity
			) {
				throw new Error(`Physics 2D body "${body.config.nodeId}" exceeds the bounded runtime velocity range after effectors.`);
			}
		}
		substeps = continuousSubsteps(bodies, step);
		const pairChecks = configuration.worlds.reduce((total, world) => {
			const count = bodies.filter((body) => body.world.id === world.id).length;
			return total + ((count * (count - 1)) / 2) * substeps * (world.velocityIterations + world.positionIterations);
		}, 0);
		if (substeps > 1 && pairChecks > MaxPhysics2DContinuousPairChecks) {
			throw new Error(`Physics 2D continuous collision requires ${pairChecks} pair checks, exceeding the bounded limit of ${MaxPhysics2DContinuousPairChecks}.`);
		}
		const jointChecks = joints.reduce((total, joint) => total + substeps * (joint.first.world.velocityIterations + joint.first.world.positionIterations), 0);
		if (jointChecks > MaxPhysics2DJointSolverChecks) {
			throw new Error(`Physics 2D joints require ${jointChecks} solver checks, exceeding the bounded limit of ${MaxPhysics2DJointSolverChecks}.`);
		}
	} catch (error) {
		for (const integration of integrations) {
			integration.body.velocity.copyFrom(integration.previousVelocity);
			integration.body.angularVelocity = integration.previousAngularVelocity;
			integration.body.force.copyFrom(integration.previousForce);
			integration.body.torque = integration.previousTorque;
		}
		throw error;
	}
	const substepSeconds = step / substeps;
	const collisionPairs = new Set<number>();
	const triggerPairs = new Set<number>();
	for (let substepIndex = 0; substepIndex < substeps; substepIndex++) {
		joints.forEach(beginPhysics2DJointSubstep);
		// Joint motors and velocity constraints run before integration so their impulses affect this substep's pose.
		for (let iteration = 0; iteration < velocityIterations; iteration++) {
			for (const joint of joints) {
				if (!joint.first.config.enabled || joint.second?.config.enabled === false || iteration >= joint.first.world.velocityIterations) {
					continue;
				}
				solvePhysics2DJointVelocity(joint, substepSeconds);
				evaluatePhysics2DJointBreak(scene, runtime, joint);
			}
		}
		for (const body of bodies) {
			if (body.config.enabled !== false && body.config.bodyType !== "static") {
				if (body.config.freezePositionX) {
					body.velocity.x = 0;
				} else {
					body.translate2D([body.velocity.x * substepSeconds, 0]);
				}
				if (body.config.freezePositionY) {
					body.velocity.y = 0;
				} else {
					body.translate2D([0, body.velocity.y * substepSeconds]);
				}
				if (body.config.freezeRotation) {
					body.angularVelocity = 0;
				} else {
					body.rotate2D(body.angularVelocity * substepSeconds);
				}
			}
		}
		for (let iteration = 0; iteration < velocityIterations; iteration++) {
			for (let first = 0; first < bodies.length; first++) {
				for (let second = first + 1; second < bodies.length; second++) {
					if (
						bodies[first].config.enabled === false ||
						bodies[second].config.enabled === false ||
						iteration >= bodies[first].world.velocityIterations ||
						!allowsWorldContact(bodies[first], bodies[second]) ||
						runtime.blockedCollisionPairs.has(physics2DJointPairKey(bodies[first].config.nodeId, bodies[second].config.nodeId))
					) {
						continue;
					}
					const result = hit(bodies[first], bodies[second]);
					if (!result || !allowsPlatformCollision(bodies[first], bodies[second], result, effectorsByNode)) {
						continue;
					}
					const pair = first * bodies.length + second;
					if (iteration === 0) {
						applySurfaceContacts(bodies[first], bodies[second], result, effectorsByNode, effectorSampleIndex);
					}
					if (bodies[first].config.isTrigger || bodies[second].config.isTrigger) {
						if (iteration === 0 && !triggerPairs.has(pair) && reportsCallback(bodies[first], bodies[second])) {
							const event = { firstNodeId: bodies[first].config.nodeId, secondNodeId: bodies[second].config.nodeId };
							triggerPairs.add(pair);
							runtime.triggers.push(event);
							scene.physics2DTriggerEvents.push(event);
							scene.onPhysics2DTriggerObservable?.notifyObservers(event);
						}
						continue;
					}
					resolve(bodies[first], bodies[second], result, materials, "velocity", effectorContactResponse(bodies[first], bodies[second], result, effectorsByNode));
					if (iteration === 0 && !collisionPairs.has(pair)) {
						collisionPairs.add(pair);
						runtime.collisions++;
					}
				}
			}
		}
		for (let iteration = 0; iteration < positionIterations; iteration++) {
			for (let first = 0; first < bodies.length; first++) {
				for (let second = first + 1; second < bodies.length; second++) {
					if (
						bodies[first].config.enabled === false ||
						bodies[second].config.enabled === false ||
						bodies[first].config.isTrigger ||
						bodies[second].config.isTrigger ||
						iteration >= bodies[first].world.positionIterations ||
						!allowsWorldContact(bodies[first], bodies[second]) ||
						runtime.blockedCollisionPairs.has(physics2DJointPairKey(bodies[first].config.nodeId, bodies[second].config.nodeId))
					) {
						continue;
					}
					const result = hit(bodies[first], bodies[second]);
					if (!result || !allowsPlatformCollision(bodies[first], bodies[second], result, effectorsByNode)) {
						continue;
					}
					resolve(bodies[first], bodies[second], result, materials, "position");
				}
			}
			for (const joint of joints) {
				if (!joint.first.config.enabled || joint.second?.config.enabled === false || iteration >= joint.first.world.positionIterations) {
					continue;
				}
				solvePhysics2DJointPosition(joint, substepSeconds / joint.first.world.positionIterations);
				evaluatePhysics2DJointBreak(scene, runtime, joint);
			}
		}
	}
	flushPhysics2DTransforms(scene, runtime, bodies, step);
	return bodies.filter((body) => body.config.enabled !== false && body.world.enabled).length;
}

function ensurePhysics2DRuntime(scene: Scene): IRuntimePhysics2D {
	let runtime = physics2DRuntimes.get(scene);
	if (runtime) {
		synchronizePhysics2DBodies(scene, runtime);
		return runtime;
	}
	runtime = {
		bodies: new Map(),
		joints: new Map(),
		blockedCollisionPairs: new Set(),
		observer: null,
		paused: false,
		executingManualStep: false,
		collisions: 0,
		triggers: [],
		totalAutomaticSteps: 0,
		totalManualSteps: 0,
		totalManualSeconds: 0,
		lastStepSeconds: null,
		lastSteppedBodies: 0,
		lastError: null,
		invalidBodyCount: 0,
		invalidBodies: [],
		metadataTruncated: false,
		invalidJointCount: 0,
		invalidJoints: [],
		jointMetadataTruncated: false,
		jointBreakEvents: [],
		transformWriteEvents: [],
	};
	scene.onPhysics2DTriggerObservable ??= new Observable<IPhysics2DTriggerEvent>();
	scene.onPhysics2DJointBreakObservable ??= new Observable<IPhysics2DJointBreakEvent>();
	scene.onPhysics2DTransformWriteObservable ??= new Observable<IPhysics2DTransformWriteEvent>();
	scene.onPhysics2DTransformTweenObservable ??= new Observable<IPhysics2DTransformWriteEvent>();
	runtime.observer = scene.onBeforeRenderObservable.add(() => {
		if (runtime!.paused || runtime!.executingManualStep) {
			return;
		}
		synchronizePhysics2DBodies(scene, runtime!);
		const step = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		if (!step || !runtime!.bodies.size) {
			return;
		}
		try {
			runtime!.lastSteppedBodies = advancePhysics2D(scene, runtime!, step);
			runtime!.totalAutomaticSteps++;
			runtime!.lastStepSeconds = step;
			runtime!.lastError = null;
		} catch (error) {
			runtime!.lastError = { message: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
			throw error;
		}
	});
	physics2DRuntimes.set(scene, runtime);
	synchronizePhysics2DBodies(scene, runtime);
	return runtime;
}

function physics2DControl(runtime: IRuntimePhysics2D): IPhysics2DSimulationControl {
	const bodies = [...runtime.bodies.values()];
	const worlds = new Map<string, { id: string; enabled: boolean; bodies: number; joints: number; contactFilterMode: IPhysics2DWorldConfiguration["contactFilterMode"] }>();
	for (const body of bodies) {
		const value = worlds.get(body.world.id) ?? { id: body.world.id, enabled: body.world.enabled, bodies: 0, joints: 0, contactFilterMode: body.world.contactFilterMode };
		value.bodies++;
		worlds.set(body.world.id, value);
	}
	for (const joint of runtime.joints.values()) {
		const value = worlds.get(joint.first.world.id);
		if (value) {
			value.joints++;
		}
	}
	return {
		available: bodies.length > 0,
		paused: runtime.paused,
		registeredBodies: bodies.length,
		enabledBodies: bodies.filter((body) => body.config.enabled !== false).length,
		dynamicBodies: bodies.filter((body) => body.config.enabled !== false && body.config.bodyType === "dynamic").length,
		kinematicBodies: bodies.filter((body) => body.config.enabled !== false && body.config.bodyType === "kinematic").length,
		staticBodies: bodies.filter((body) => body.config.enabled !== false && body.config.bodyType === "static").length,
		bodyIds: bodies.map((body) => body.config.nodeId),
		executingManualStep: runtime.executingManualStep,
		collisions: runtime.collisions,
		triggers: runtime.triggers.map((event) => ({ ...event })),
		totalAutomaticSteps: runtime.totalAutomaticSteps,
		totalManualSteps: runtime.totalManualSteps,
		totalManualSeconds: runtime.totalManualSeconds,
		lastStepSeconds: runtime.lastStepSeconds,
		lastSteppedBodies: runtime.lastSteppedBodies,
		lastError: runtime.lastError ? { ...runtime.lastError } : null,
		invalidBodyCount: runtime.invalidBodyCount,
		invalidBodies: runtime.invalidBodies.map((body) => ({ ...body })),
		metadataTruncated: runtime.metadataTruncated,
		registeredJoints: runtime.joints.size,
		enabledJoints: [...runtime.joints.values()].filter((joint) => joint.config.enabled && !joint.broken).length,
		brokenJoints: [...runtime.joints.values()].filter((joint) => joint.broken).length,
		invalidJointCount: runtime.invalidJointCount,
		invalidJoints: runtime.invalidJoints.map((joint) => ({ ...joint })),
		jointMetadataTruncated: runtime.jointMetadataTruncated,
		jointBreakEvents: runtime.jointBreakEvents.map((event) => ({ ...event, reactionForce: [...event.reactionForce] })),
		worldCount: worlds.size,
		worlds: [...worlds.values()].sort((first, second) => first.id.localeCompare(second.id)),
		transformWriteEvents: runtime.transformWriteEvents.map((event) => ({
			...event,
			from: [...event.from],
			target: [...event.target],
			applied: [...event.applied],
		})),
	};
}

/** Recreates editor-authored 2D rigidbody/collider simulation behind one shared scene observer. */
export function configurePhysics2D(scene: any): void {
	ensurePhysics2DRuntime(scene);
}

/** Reads deterministic Physics 2D solver ownership and step evidence without advancing it. */
export function getPhysics2DSimulationControl(scene: any): IPhysics2DSimulationControl {
	const runtime = ensurePhysics2DRuntime(scene);
	synchronizePhysics2DJoints(scene, runtime);
	return physics2DControl(runtime);
}

export interface IPhysics2DDebugPrimitive {
	id: string;
	cameraId: string;
	worldId: string;
	kind: "body" | "joint" | "custom";
	order: "automatic" | "custom";
	points: Array<[number, number, number]>;
}

export interface IPhysics2DDebugSnapshot {
	settingsRevision: number;
	releaseBuild: boolean;
	available: boolean;
	cameraIds: string[];
	total: number;
	cursor: number;
	nextCursor: number | null;
	primitives: IPhysics2DDebugPrimitive[];
}

/** Builds a bounded camera-scoped debug draw list; custom elements are appended after automatic bodies and joints. */
export function getPhysics2DDebugSnapshot(
	scene: Scene,
	options: {
		cameraIds?: string[];
		releaseBuild?: boolean;
		cursor?: number;
		limit?: number;
		customElements?: Array<{ id: string; worldId: string; points: Array<[number, number]> }>;
	} = {}
): IPhysics2DDebugSnapshot {
	const runtime = ensurePhysics2DRuntime(scene);
	synchronizePhysics2DJoints(scene, runtime);
	const configuration = settings(scene);
	const releaseBuild = options.releaseBuild === true;
	const cursor = options.cursor ?? 0;
	const limit = options.limit ?? 128;
	if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
		throw new Error("Physics 2D debug cursor must be non-negative and limit must be 1-256.");
	}
	const knownCameraIds = new Set(scene.cameras.map((camera) => camera.id));
	const cameraIds = options.cameraIds?.length
		? [...new Set(options.cameraIds)]
		: scene.activeCameras?.length
			? scene.activeCameras.map((camera) => camera.id)
			: scene.activeCamera
				? [scene.activeCamera.id]
				: ["active"];
	if (
		cameraIds.length > 16 ||
		cameraIds.some((cameraId) => typeof cameraId !== "string" || !cameraId || cameraId.length > 256 || (cameraId !== "active" && !knownCameraIds.has(cameraId)))
	) {
		throw new Error("Physics 2D debug rendering accepts at most 16 unique existing camera ids.");
	}
	const customElements = options.customElements ?? [];
	if (
		!Array.isArray(customElements) ||
		customElements.length > 256 ||
		customElements.some(
			(element) =>
				!element ||
				typeof element.id !== "string" ||
				!element.id ||
				element.id.length > 128 ||
				typeof element.worldId !== "string" ||
				!configuration.worlds.some((world) => world.id === element.worldId) ||
				!Array.isArray(element.points) ||
				element.points.length < 2 ||
				element.points.length > 128 ||
				element.points.some(
					(point) => !Array.isArray(point) || point.length !== 2 || point.some((component) => !Number.isFinite(component) || Math.abs(component) > 1_000_000)
				)
		)
	) {
		throw new Error("Physics 2D custom debug elements require at most 256 unique bounded ids/worlds and 2-128 finite plane points.");
	}
	if (new Set(customElements.map((element) => element.id)).size !== customElements.length) {
		throw new Error("Physics 2D custom debug element ids must be unique.");
	}
	const available = !releaseBuild || configuration.renderingAvailableInRelease;
	const primitives: IPhysics2DDebugPrimitive[] = [];
	if (available) {
		for (const cameraId of cameraIds) {
			for (const world of configuration.worlds) {
				if (!world.enabled || !world.worldDrawing || (world.debugCameraIds.length && !world.debugCameraIds.includes(cameraId))) {
					continue;
				}
				for (const body of runtime.bodies.values()) {
					if (body.world.id !== world.id || (!world.alwaysDraw && !body.config.worldDrawing && !body.config.collider.worldDrawing)) {
						continue;
					}
					for (const [partIndex, points] of areaPartsForBody(body).entries()) {
						primitives.push({
							id: `body:${body.config.nodeId}:${partIndex}`,
							cameraId,
							worldId: world.id,
							kind: "body",
							order: "automatic",
							points: points.slice(0, 128).map((point) => planeVector(world.transformPlane, point)),
						});
					}
				}
				for (const joint of runtime.joints.values()) {
					if (joint.first.world.id !== world.id || (!world.alwaysDraw && !joint.config.worldDrawing)) {
						continue;
					}
					const first = joint.first.readPosition2D();
					const second = joint.second?.readPosition2D() ?? first;
					primitives.push({
						id: `joint:${joint.config.id}`,
						cameraId,
						worldId: world.id,
						kind: "joint",
						order: "automatic",
						points: [planeVector(world.transformPlane, first), planeVector(world.transformPlane, second)],
					});
				}
				for (const element of customElements.filter((candidate) => candidate.worldId === world.id)) {
					primitives.push({
						id: `custom:${element.id}`,
						cameraId,
						worldId: world.id,
						kind: "custom",
						order: "custom",
						points: element.points.map((point) => planeVector(world.transformPlane, point)),
					});
				}
			}
		}
	}
	const page = primitives.slice(cursor, cursor + limit);
	return {
		settingsRevision: configuration.revision,
		releaseBuild,
		available,
		cameraIds,
		total: primitives.length,
		cursor,
		nextCursor: cursor + page.length < primitives.length ? cursor + page.length : null,
		primitives: page,
	};
}

/** Reads one detached joint reaction/break state without advancing simulation. */
export function getPhysics2DJointRuntimeState(scene: Scene, jointId: string): IPhysics2DJointRuntimeState {
	const runtime = ensurePhysics2DRuntime(scene);
	synchronizePhysics2DJoints(scene, runtime);
	const joint = runtime.joints.get(jointId);
	if (!joint) {
		throw new Error(`Physics 2D joint "${jointId}" is not active.`);
	}
	return physics2DJointRuntimeState(joint);
}

/** Lists detached reaction/break state for every valid authored joint. */
export function listPhysics2DJointRuntimeStates(scene: Scene): IPhysics2DJointRuntimeState[] {
	const runtime = ensurePhysics2DRuntime(scene);
	synchronizePhysics2DJoints(scene, runtime);
	return [...runtime.joints.values()].map(physics2DJointRuntimeState);
}

/** Reads detached linear/angular and mass state without advancing the shared solver. */
export function getPhysics2DBodyRuntimeState(scene: any, nodeId: string): IPhysics2DBodyRuntimeState {
	const body = ensurePhysics2DRuntime(scene).bodies.get(nodeId);
	return body
		? {
				active: true,
				bodyType: body.config.bodyType,
				revision: body.config.revision,
				velocity: [body.velocity.x, body.velocity.y],
				angularVelocity: body.angularVelocity,
				accumulatedForce: [body.force.x, body.force.y],
				accumulatedTorque: body.torque,
				...body.massProperties,
				centerOfMass: [...body.massProperties.centerOfMass],
			}
		: {
				active: false,
				bodyType: null,
				revision: null,
				velocity: [0, 0],
				angularVelocity: 0,
				accumulatedForce: [0, 0],
				accumulatedTorque: 0,
				mass: 0,
				inverseMass: 0,
				centerOfMass: [0, 0],
				inertia: 0,
				inverseInertia: 0,
			};
}

/** Resolves one enabled non-static body for transient runtime commands. */
function commandBody(scene: Scene, nodeId: string): IRuntimeBody {
	const body = ensurePhysics2DRuntime(scene).bodies.get(nodeId);
	if (!body) {
		throw new Error(`Physics 2D body "${nodeId}" is not active.`);
	}
	if (!body.config.enabled || body.config.bodyType === "static") {
		throw new Error(`Physics 2D body "${nodeId}" must be enabled and dynamic or kinematic.`);
	}
	return body;
}

/** Validates bounded two-component runtime commands before they reach solver state. */
function commandVector(value: unknown, label: string, maximum: number): [number, number] {
	if (!Array.isArray(value) || value.length !== 2 || value.some((candidate) => typeof candidate !== "number" || !Number.isFinite(candidate) || Math.abs(candidate) > maximum)) {
		throw new Error(`${label} must be a finite [x, y] pair from -${maximum} through ${maximum}.`);
	}
	return [value[0], value[1]];
}

/** Applies a force/impulse at the center of mass or an optional world-space point. */
export function applyPhysics2DForce(
	scene: Scene,
	nodeId: string,
	value: [number, number],
	mode: Physics2DForceMode = "force",
	worldPoint?: [number, number]
): IPhysics2DBodyRuntimeState {
	const body = commandBody(scene, nodeId);
	if (body.config.bodyType !== "dynamic") {
		throw new Error(`Physics 2D forces require dynamic body "${nodeId}".`);
	}
	if (mode !== "force" && mode !== "impulse") {
		throw new Error('Physics 2D force mode must be "force" or "impulse".');
	}
	const force = commandVector(value, mode === "force" ? "Force in newtons" : "Impulse in newton-seconds", MaxPhysics2DForce);
	const point = worldPoint === undefined ? undefined : commandVector(worldPoint, "World point in centimeters", 1_000_000);
	const angle = body.readAngle2D();
	const localCenter = body.massProperties.centerOfMass;
	const position = body.readPosition2D();
	const centerX = position[0] + localCenter[0] * Math.cos(angle) - localCenter[1] * Math.sin(angle);
	const centerY = position[1] + localCenter[0] * Math.sin(angle) + localCenter[1] * Math.cos(angle);
	const torque = point ? (point[0] - centerX) * force[1] - (point[1] - centerY) * force[0] : 0;
	const linearX = body.config.freezePositionX ? 0 : force[0];
	const linearY = body.config.freezePositionY ? 0 : force[1];
	if (mode === "impulse") {
		const nextX = body.velocity.x + linearX * body.massProperties.inverseMass * 100;
		const nextY = body.velocity.y + linearY * body.massProperties.inverseMass * 100;
		const nextAngular = body.angularVelocity + torque * body.massProperties.inverseInertia * 100;
		if (
			![nextX, nextY, nextAngular].every(Number.isFinite) ||
			Math.abs(nextX) > MaxPhysics2DLinearVelocity ||
			Math.abs(nextY) > MaxPhysics2DLinearVelocity ||
			Math.abs(nextAngular) > MaxPhysics2DAngularVelocity
		) {
			throw new Error("Physics 2D impulse would exceed the bounded runtime velocity range.");
		}
		body.velocity.x = nextX;
		body.velocity.y = nextY;
		body.angularVelocity = nextAngular;
	} else {
		const nextX = body.force.x + linearX;
		const nextY = body.force.y + linearY;
		const nextTorque = body.torque + torque;
		if (
			![nextX, nextY, nextTorque].every(Number.isFinite) ||
			Math.abs(nextX) > MaxPhysics2DForce ||
			Math.abs(nextY) > MaxPhysics2DForce ||
			Math.abs(nextTorque) > MaxPhysics2DTorque
		) {
			throw new Error("Physics 2D force would exceed the bounded accumulated force or torque range.");
		}
		body.force.x = nextX;
		body.force.y = nextY;
		body.torque = nextTorque;
	}
	return getPhysics2DBodyRuntimeState(scene, nodeId);
}

/** Applies center-of-mass torque or angular impulse in explicit centimeter units. */
export function applyPhysics2DTorque(scene: Scene, nodeId: string, value: number, mode: Physics2DForceMode = "force"): IPhysics2DBodyRuntimeState {
	const body = commandBody(scene, nodeId);
	if (body.config.bodyType !== "dynamic") {
		throw new Error(`Physics 2D torque requires dynamic body "${nodeId}".`);
	}
	if ((mode !== "force" && mode !== "impulse") || !Number.isFinite(value) || Math.abs(value) > MaxPhysics2DTorque) {
		throw new Error('Physics 2D torque must be finite within ±1000000000000 and mode must be "force" or "impulse".');
	}
	if (mode === "impulse") {
		const next = body.angularVelocity + value * body.massProperties.inverseInertia * 100;
		if (!Number.isFinite(next) || Math.abs(next) > MaxPhysics2DAngularVelocity) {
			throw new Error("Physics 2D angular impulse would exceed the bounded runtime angular velocity range.");
		}
		body.angularVelocity = next;
	} else {
		const next = body.torque + value;
		if (!Number.isFinite(next) || Math.abs(next) > MaxPhysics2DTorque) {
			throw new Error("Physics 2D torque would exceed the bounded accumulated torque range.");
		}
		body.torque = next;
	}
	return getPhysics2DBodyRuntimeState(scene, nodeId);
}

/** Replaces transient linear/angular velocity without changing persisted authoring metadata. */
export function setPhysics2DBodyRuntimeVelocity(scene: Scene, nodeId: string, velocity?: [number, number], angularVelocity?: number): IPhysics2DBodyRuntimeState {
	const body = commandBody(scene, nodeId);
	if (velocity === undefined && angularVelocity === undefined) {
		throw new Error("Provide velocity, angularVelocity, or both.");
	}
	const nextVelocity = velocity === undefined ? undefined : commandVector(velocity, "Velocity in centimeters per second", MaxPhysics2DLinearVelocity);
	if (angularVelocity !== undefined) {
		if (!Number.isFinite(angularVelocity) || Math.abs(angularVelocity) > MaxPhysics2DAngularVelocity) {
			throw new Error("angularVelocity must be finite from -100000 through 100000 radians per second.");
		}
	}
	if (nextVelocity) {
		body.velocity.x = body.config.freezePositionX ? 0 : nextVelocity[0];
		body.velocity.y = body.config.freezePositionY ? 0 : nextVelocity[1];
	}
	if (angularVelocity !== undefined) {
		body.angularVelocity = body.config.freezeRotation ? 0 : angularVelocity;
	}
	return getPhysics2DBodyRuntimeState(scene, nodeId);
}

/** Pauses or resumes only the shared Physics 2D solver while scene rendering may continue. */
export function setPhysics2DSimulationPaused(scene: any, paused: boolean): IPhysics2DSimulationControl {
	const runtime = ensurePhysics2DRuntime(scene);
	runtime.paused = paused;
	return physics2DControl(runtime);
}

/** Advances the shared Physics 2D solver exactly once while it is paused. */
export function stepPausedPhysics2DSimulation(scene: any, deltaSeconds: number): IPhysics2DSimulationControl & { steppedBodies: number } {
	const runtime = ensurePhysics2DRuntime(scene);
	if (!runtime.paused) {
		throw new Error("Pause the Physics 2D simulation before manually stepping it.");
	}
	if (runtime.executingManualStep) {
		throw new Error("The Physics 2D simulation is already executing a manual step.");
	}
	if (!Number.isFinite(deltaSeconds) || deltaSeconds < 1 / 1000 || deltaSeconds > 0.1) {
		throw new Error("deltaSeconds must be from 0.001 through 0.1 seconds.");
	}
	// The complete mutable body state is captured before manual stepping so any failure is atomic.
	const snapshots = [...runtime.bodies.values()].map((body) => ({
		body,
		position: body.node.position.clone(),
		rotation: body.node.rotation.clone(),
		velocity: body.velocity.clone(),
		angularVelocity: body.angularVelocity,
		force: body.force.clone(),
		torque: body.torque,
		massProperties: { ...body.massProperties, centerOfMass: [...body.massProperties.centerOfMass] as [number, number] },
	}));
	const previousJoints = runtime.joints;
	const jointSnapshots = [...previousJoints.values()].map((joint) => ({
		joint,
		broken: joint.broken,
		breakNotified: joint.breakNotified,
		reactionLinearImpulse: [...joint.reactionLinearImpulse] as IPoint2D,
		reactionAngularImpulse: joint.reactionAngularImpulse,
		linearMotorImpulse: [...joint.linearMotorImpulse] as IPoint2D,
		motorImpulse: joint.motorImpulse,
		lastStepSeconds: joint.lastStepSeconds,
	}));
	const previousBlockedCollisionPairs = runtime.blockedCollisionPairs;
	const previousInvalidJointCount = runtime.invalidJointCount;
	const previousInvalidJoints = runtime.invalidJoints;
	const previousJointMetadataTruncated = runtime.jointMetadataTruncated;
	const previousJointBreakEvents = runtime.jointBreakEvents;
	const previousSceneJointBreakEvents = scene.physics2DJointBreakEvents;
	const previousCollisions = runtime.collisions;
	const previousTriggers = runtime.triggers.map((event) => ({ ...event }));
	runtime.executingManualStep = true;
	runtime.lastError = null;
	let steppedBodies = 0;
	try {
		steppedBodies = advancePhysics2D(scene, runtime, deltaSeconds);
		runtime.totalManualSteps++;
		runtime.totalManualSeconds += deltaSeconds;
		runtime.lastStepSeconds = deltaSeconds;
		runtime.lastSteppedBodies = steppedBodies;
	} catch (error) {
		for (const snapshot of snapshots) {
			snapshot.body.node.position.copyFrom(snapshot.position);
			snapshot.body.node.rotation.copyFrom(snapshot.rotation);
			snapshot.body.velocity.copyFrom(snapshot.velocity);
			snapshot.body.angularVelocity = snapshot.angularVelocity;
			snapshot.body.force.copyFrom(snapshot.force);
			snapshot.body.torque = snapshot.torque;
			snapshot.body.massProperties = snapshot.massProperties;
		}
		for (const snapshot of jointSnapshots) {
			snapshot.joint.broken = snapshot.broken;
			snapshot.joint.breakNotified = snapshot.breakNotified;
			snapshot.joint.reactionLinearImpulse = snapshot.reactionLinearImpulse;
			snapshot.joint.reactionAngularImpulse = snapshot.reactionAngularImpulse;
			snapshot.joint.linearMotorImpulse = snapshot.linearMotorImpulse;
			snapshot.joint.motorImpulse = snapshot.motorImpulse;
			snapshot.joint.lastStepSeconds = snapshot.lastStepSeconds;
		}
		runtime.joints = previousJoints;
		runtime.blockedCollisionPairs = previousBlockedCollisionPairs;
		runtime.invalidJointCount = previousInvalidJointCount;
		runtime.invalidJoints = previousInvalidJoints;
		runtime.jointMetadataTruncated = previousJointMetadataTruncated;
		runtime.jointBreakEvents = previousJointBreakEvents;
		scene.physics2DJointBreakEvents = previousSceneJointBreakEvents;
		runtime.collisions = previousCollisions;
		runtime.triggers = previousTriggers;
		scene.physics2DTriggerEvents = previousTriggers.map((event) => ({ ...event }));
		runtime.lastError = { message: error instanceof Error ? error.message : String(error), timestamp: Date.now() };
		throw error;
	} finally {
		runtime.executingManualStep = false;
	}
	return { ...physics2DControl(runtime), steppedBodies };
}
