export type SpriteShapePoint2D = [number, number];
export type SpriteShapeColor = [number, number, number, number];
export type SpriteShapeTangentMode = "linear" | "continuous" | "broken";

export interface ISpriteShapeControlPoint {
	id: string;
	position: SpriteShapePoint2D;
	leftTangent: SpriteShapePoint2D;
	rightTangent: SpriteShapePoint2D;
	tangentMode: SpriteShapeTangentMode;
	height: number;
	corner: boolean;
}

export interface ISpriteShapeAngleRange {
	id: string;
	name: string;
	minimumDegrees: number;
	maximumDegrees: number;
	order: number;
	texturePath: string | null;
	color: SpriteShapeColor;
}

export interface ISpriteShapeProfile {
	model: "unity-sprite-shape-profile-v1";
	version: 1;
	id: string;
	name: string;
	revision: number;
	edgeTexturePath: string | null;
	fillTexturePath: string | null;
	edgeColor: SpriteShapeColor;
	fillColor: SpriteShapeColor;
	pixelsPerUnit: number;
	useSpriteBorders: boolean;
	angleRanges: ISpriteShapeAngleRange[];
}

export interface ISpriteShapeColliderSettings {
	enabled: boolean;
	type: "edge" | "polygon";
	detail: number;
	offset: number;
	edgeRadius: number;
	optimize: boolean;
	isTrigger: boolean;
	friction: number;
	restitution: number;
}

export interface ISpriteShapeDefinition {
	model: "unity-sprite-shape-controller-v1";
	version: 1;
	revision: number;
	profileId: string;
	closed: boolean;
	detail: number;
	adaptiveUV: boolean;
	stretchUV: boolean;
	worldSpaceUV: boolean;
	fillOffset: number;
	geometryOptimization: boolean;
	enableTangents: boolean;
	points: ISpriteShapeControlPoint[];
	collider: ISpriteShapeColliderSettings;
}

export interface ISpriteShapeMaterialSlot {
	kind: "fill" | "edge";
	angleRangeId: string | null;
	texturePath: string | null;
	color: SpriteShapeColor;
}

export interface ISpriteShapeSubMesh {
	materialIndex: number;
	indexStart: number;
	indexCount: number;
}

export interface ISpriteShapeColliderGeometry {
	type: "edge" | "polygon";
	points: SpriteShapePoint2D[];
	parts: SpriteShapePoint2D[][];
	contours: Array<{ id: string; points: SpriteShapePoint2D[]; holes: [] }>;
}

export interface ISpriteShapeGeometry {
	model: "unity-sprite-shape-generated-geometry-v1";
	positions: number[];
	indices: number[];
	normals: number[];
	uvs: number[];
	colors: number[];
	tangents: number[] | null;
	subMeshes: ISpriteShapeSubMesh[];
	materialSlots: ISpriteShapeMaterialSlot[];
	sampleCount: number;
	edgeQuadCount: number;
	fillTriangleCount: number;
	length: number;
	closed: boolean;
	collider: ISpriteShapeColliderGeometry | null;
}

type ISampledPoint = {
	position: SpriteShapePoint2D;
	tangent: SpriteShapePoint2D;
	normal: SpriteShapePoint2D;
	height: number;
	distance: number;
};

const EPSILON = 0.000001;
const MAXIMUM_COORDINATE = 100_000_000;
const MAXIMUM_CONTROL_POINTS = 64;
const MAXIMUM_GENERATED_SAMPLES = 2_048;

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value;
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 256) {
		throw new Error(`${label} must contain 1 through 256 characters.`);
	}
	return value;
}

function optionalPath(value: unknown, label: string): string | null {
	if (value === null || value === undefined || value === "") {
		return null;
	}
	if (typeof value !== "string" || value.length > 1_024 || value.includes("\0")) {
		throw new Error(`${label} must be null or a path containing at most 1024 characters.`);
	}
	return value;
}

function point(value: unknown, label: string): SpriteShapePoint2D {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error(`${label} must be a finite [x, y] pair.`);
	}
	return [finite(value[0], -MAXIMUM_COORDINATE, MAXIMUM_COORDINATE, `${label}[0]`), finite(value[1], -MAXIMUM_COORDINATE, MAXIMUM_COORDINATE, `${label}[1]`)];
}

function color(value: unknown, label: string): SpriteShapeColor {
	if (!Array.isArray(value) || value.length !== 4) {
		throw new Error(`${label} must be an RGBA array containing four numbers from 0 through 1.`);
	}
	return value.map((entry, index) => finite(entry, 0, 1, `${label}[${index}]`)) as SpriteShapeColor;
}

function length(value: SpriteShapePoint2D): number {
	return Math.hypot(value[0], value[1]);
}

function subtract(first: SpriteShapePoint2D, second: SpriteShapePoint2D): SpriteShapePoint2D {
	return [first[0] - second[0], first[1] - second[1]];
}

function add(first: SpriteShapePoint2D, second: SpriteShapePoint2D): SpriteShapePoint2D {
	return [first[0] + second[0], first[1] + second[1]];
}

function scale(value: SpriteShapePoint2D, amount: number): SpriteShapePoint2D {
	return [value[0] * amount, value[1] * amount];
}

function normalize(value: SpriteShapePoint2D, fallback: SpriteShapePoint2D = [1, 0]): SpriteShapePoint2D {
	const magnitude = length(value);
	return magnitude > EPSILON ? [value[0] / magnitude, value[1] / magnitude] : fallback;
}

function cross(first: SpriteShapePoint2D, second: SpriteShapePoint2D, third: SpriteShapePoint2D): number {
	return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function area(points: SpriteShapePoint2D[]): number {
	return (
		points.reduce((total, current, index) => {
			const next = points[(index + 1) % points.length];
			return total + current[0] * next[1] - current[1] * next[0];
		}, 0) / 2
	);
}

function samePoint(first: SpriteShapePoint2D, second: SpriteShapePoint2D): boolean {
	return Math.abs(first[0] - second[0]) <= EPSILON && Math.abs(first[1] - second[1]) <= EPSILON;
}

function pointOnSegment(candidate: SpriteShapePoint2D, first: SpriteShapePoint2D, second: SpriteShapePoint2D): boolean {
	return (
		Math.abs(cross(first, second, candidate)) <= EPSILON &&
		candidate[0] >= Math.min(first[0], second[0]) - EPSILON &&
		candidate[0] <= Math.max(first[0], second[0]) + EPSILON &&
		candidate[1] >= Math.min(first[1], second[1]) - EPSILON &&
		candidate[1] <= Math.max(first[1], second[1]) + EPSILON
	);
}

function segmentsIntersect(firstStart: SpriteShapePoint2D, firstEnd: SpriteShapePoint2D, secondStart: SpriteShapePoint2D, secondEnd: SpriteShapePoint2D): boolean {
	const firstCross = cross(firstStart, firstEnd, secondStart);
	const secondCross = cross(firstStart, firstEnd, secondEnd);
	const thirdCross = cross(secondStart, secondEnd, firstStart);
	const fourthCross = cross(secondStart, secondEnd, firstEnd);
	if ((firstCross > EPSILON && secondCross < -EPSILON) || (firstCross < -EPSILON && secondCross > EPSILON)) {
		return (thirdCross > EPSILON && fourthCross < -EPSILON) || (thirdCross < -EPSILON && fourthCross > EPSILON);
	}
	return (
		(Math.abs(firstCross) <= EPSILON && pointOnSegment(secondStart, firstStart, firstEnd)) ||
		(Math.abs(secondCross) <= EPSILON && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
		(Math.abs(thirdCross) <= EPSILON && pointOnSegment(firstStart, secondStart, secondEnd)) ||
		(Math.abs(fourthCross) <= EPSILON && pointOnSegment(firstEnd, secondStart, secondEnd))
	);
}

function cleanPolygon(points: SpriteShapePoint2D[]): SpriteShapePoint2D[] {
	const result = points.filter((candidate, index) => index === 0 || !samePoint(candidate, points[index - 1]));
	if (result.length > 1 && samePoint(result[0], result[result.length - 1])) {
		result.pop();
	}
	let changed = true;
	while (changed && result.length >= 3) {
		changed = false;
		for (let index = 0; index < result.length; index++) {
			if (Math.abs(cross(result[(index - 1 + result.length) % result.length], result[index], result[(index + 1) % result.length])) <= EPSILON) {
				result.splice(index, 1);
				changed = true;
				break;
			}
		}
	}
	return result;
}

function validateSimplePolygon(points: SpriteShapePoint2D[], label: string): void {
	if (points.length < 3) {
		throw new Error(`${label} must enclose non-zero area.`);
	}
	for (let first = 0; first < points.length; first++) {
		for (let second = first + 1; second < points.length; second++) {
			if (second === first + 1 || (first === 0 && second === points.length - 1)) {
				continue;
			}
			if (segmentsIntersect(points[first], points[(first + 1) % points.length], points[second], points[(second + 1) % points.length])) {
				throw new Error(`${label} must be a simple non-self-intersecting spline.`);
			}
		}
	}
	if (Math.abs(area(points)) <= EPSILON) {
		throw new Error(`${label} must enclose non-zero area.`);
	}
}

function pointInsideTriangle(candidate: SpriteShapePoint2D, first: SpriteShapePoint2D, second: SpriteShapePoint2D, third: SpriteShapePoint2D): boolean {
	const firstCross = cross(first, second, candidate);
	const secondCross = cross(second, third, candidate);
	const thirdCross = cross(third, first, candidate);
	return firstCross >= -EPSILON && secondCross >= -EPSILON && thirdCross >= -EPSILON;
}

function triangulatePolygon(source: SpriteShapePoint2D[]): { points: SpriteShapePoint2D[]; indices: number[] } {
	let points = cleanPolygon(source);
	validateSimplePolygon(points, "Closed Sprite Shape fill");
	if (area(points) < 0) {
		points = [...points].reverse();
	}
	const remaining = points.map((_, index) => index);
	const indices: number[] = [];
	while (remaining.length > 3) {
		let clipped = false;
		for (let cursor = 0; cursor < remaining.length; cursor++) {
			const previous = remaining[(cursor - 1 + remaining.length) % remaining.length];
			const current = remaining[cursor];
			const next = remaining[(cursor + 1) % remaining.length];
			if (cross(points[previous], points[current], points[next]) <= EPSILON) {
				continue;
			}
			if (
				remaining.some(
					(index) => index !== previous && index !== current && index !== next && pointInsideTriangle(points[index], points[previous], points[current], points[next])
				)
			) {
				continue;
			}
			indices.push(previous, current, next);
			remaining.splice(cursor, 1);
			clipped = true;
			break;
		}
		if (!clipped) {
			throw new Error("Closed Sprite Shape fill could not be triangulated. Reduce overlapping curvature or add control points.");
		}
	}
	indices.push(remaining[0], remaining[1], remaining[2]);
	return { points, indices };
}

function normalizeControlPoint(value: unknown, index: number): ISpriteShapeControlPoint {
	if (!value || typeof value !== "object") {
		throw new Error(`Sprite Shape control point ${index} must be an object.`);
	}
	const candidate = value as Partial<ISpriteShapeControlPoint>;
	const tangentMode = candidate.tangentMode ?? "linear";
	if (tangentMode !== "linear" && tangentMode !== "continuous" && tangentMode !== "broken") {
		throw new Error(`Sprite Shape control point ${index} tangentMode must be linear, continuous, or broken.`);
	}
	const leftTangent = point(candidate.leftTangent ?? [0, 0], `Sprite Shape control point ${index} leftTangent`);
	const rightTangent = point(candidate.rightTangent ?? [0, 0], `Sprite Shape control point ${index} rightTangent`);
	if (tangentMode === "continuous" && length(leftTangent) > EPSILON && length(rightTangent) > EPSILON) {
		const normalizedLeft = normalize(leftTangent);
		const normalizedRight = normalize(rightTangent);
		if (
			Math.abs(normalizedLeft[0] * normalizedRight[1] - normalizedLeft[1] * normalizedRight[0]) > 0.0001 ||
			normalizedLeft[0] * normalizedRight[0] + normalizedLeft[1] * normalizedRight[1] > -0.9999
		) {
			throw new Error(`Sprite Shape control point ${index} continuous tangents must be collinear and point in opposite directions.`);
		}
	}
	return {
		id: identifier(candidate.id, `Sprite Shape control point ${index} id`),
		position: point(candidate.position, `Sprite Shape control point ${index} position`),
		leftTangent,
		rightTangent,
		tangentMode,
		height: finite(candidate.height ?? 50, 0.001, 1_000_000, `Sprite Shape control point ${index} height`),
		corner: candidate.corner === true,
	};
}

export function normalizeSpriteShapeProfile(value: unknown): ISpriteShapeProfile {
	if (!value || typeof value !== "object") {
		throw new Error("Sprite Shape profile must be an object.");
	}
	const candidate = value as Partial<ISpriteShapeProfile>;
	if (candidate.model !== "unity-sprite-shape-profile-v1" || candidate.version !== 1) {
		throw new Error('Sprite Shape profile model/version must be "unity-sprite-shape-profile-v1"/1.');
	}
	if (!Array.isArray(candidate.angleRanges) || candidate.angleRanges.length > 16) {
		throw new Error("Sprite Shape profile angleRanges must contain at most 16 entries.");
	}
	const rangeIds = new Set<string>();
	const angleRanges = candidate.angleRanges.map((range, index): ISpriteShapeAngleRange => {
		const id = identifier(range?.id, `Sprite Shape angle range ${index} id`);
		if (rangeIds.has(id)) {
			throw new Error(`Sprite Shape angle range id "${id}" is duplicated.`);
		}
		rangeIds.add(id);
		const minimumDegrees = finite(range.minimumDegrees, -180, 180, `Sprite Shape angle range ${index} minimumDegrees`);
		const maximumDegrees = finite(range.maximumDegrees, -180, 180, `Sprite Shape angle range ${index} maximumDegrees`);
		if (minimumDegrees >= maximumDegrees) {
			throw new Error(`Sprite Shape angle range ${index} requires minimumDegrees below maximumDegrees.`);
		}
		return {
			id,
			name: identifier(range.name, `Sprite Shape angle range ${index} name`),
			minimumDegrees,
			maximumDegrees,
			order: integer(range.order, -1_000, 1_000, `Sprite Shape angle range ${index} order`),
			texturePath: optionalPath(range.texturePath, `Sprite Shape angle range ${index} texturePath`),
			color: color(range.color, `Sprite Shape angle range ${index} color`),
		};
	});
	return {
		model: "unity-sprite-shape-profile-v1",
		version: 1,
		id: identifier(candidate.id, "Sprite Shape profile id"),
		name: identifier(candidate.name, "Sprite Shape profile name"),
		revision: integer(candidate.revision, 0, Number.MAX_SAFE_INTEGER, "Sprite Shape profile revision"),
		edgeTexturePath: optionalPath(candidate.edgeTexturePath, "Sprite Shape profile edgeTexturePath"),
		fillTexturePath: optionalPath(candidate.fillTexturePath, "Sprite Shape profile fillTexturePath"),
		edgeColor: color(candidate.edgeColor, "Sprite Shape profile edgeColor"),
		fillColor: color(candidate.fillColor, "Sprite Shape profile fillColor"),
		pixelsPerUnit: finite(candidate.pixelsPerUnit, 0.001, 1_000_000, "Sprite Shape profile pixelsPerUnit"),
		useSpriteBorders: candidate.useSpriteBorders === true,
		angleRanges,
	};
}

export function createDefaultSpriteShapeProfile(id: string, name = "Default Sprite Shape Profile"): ISpriteShapeProfile {
	return normalizeSpriteShapeProfile({
		model: "unity-sprite-shape-profile-v1",
		version: 1,
		id,
		name,
		revision: 1,
		edgeTexturePath: null,
		fillTexturePath: null,
		edgeColor: [0.2, 0.75, 0.35, 1],
		fillColor: [0.08, 0.3, 0.14, 1],
		pixelsPerUnit: 100,
		useSpriteBorders: true,
		angleRanges: [],
	});
}

export function normalizeSpriteShapeDefinition(value: unknown): ISpriteShapeDefinition {
	if (!value || typeof value !== "object") {
		throw new Error("Sprite Shape controller must be an object.");
	}
	const candidate = value as Partial<ISpriteShapeDefinition>;
	if (candidate.model !== "unity-sprite-shape-controller-v1" || candidate.version !== 1) {
		throw new Error('Sprite Shape controller model/version must be "unity-sprite-shape-controller-v1"/1.');
	}
	if (!Array.isArray(candidate.points) || candidate.points.length < 2 || candidate.points.length > MAXIMUM_CONTROL_POINTS) {
		throw new Error(`Sprite Shape requires 2 through ${MAXIMUM_CONTROL_POINTS} control points.`);
	}
	const points = candidate.points.map(normalizeControlPoint);
	const pointIds = new Set<string>();
	for (const controlPoint of points) {
		if (pointIds.has(controlPoint.id)) {
			throw new Error(`Sprite Shape control point id "${controlPoint.id}" is duplicated.`);
		}
		pointIds.add(controlPoint.id);
	}
	const closed = candidate.closed === true;
	if (closed && points.length < 3) {
		throw new Error("Closed Sprite Shapes require at least three control points.");
	}
	const segmentCount = closed ? points.length : points.length - 1;
	for (let index = 0; index < segmentCount; index++) {
		if (samePoint(points[index].position, points[(index + 1) % points.length].position)) {
			throw new Error(`Sprite Shape control points ${index} and ${(index + 1) % points.length} must not share a position.`);
		}
	}
	const detail = integer(candidate.detail, 1, 32, "Sprite Shape detail");
	if (segmentCount * detail + Number(!closed) > MAXIMUM_GENERATED_SAMPLES) {
		throw new Error(`Sprite Shape detail produces more than ${MAXIMUM_GENERATED_SAMPLES} samples. Reduce detail or control points.`);
	}
	const colliderCandidate = candidate.collider;
	if (!colliderCandidate || typeof colliderCandidate !== "object") {
		throw new Error("Sprite Shape collider settings must be an object.");
	}
	const colliderType = colliderCandidate.type ?? (closed ? "polygon" : "edge");
	if (colliderType !== "edge" && colliderType !== "polygon") {
		throw new Error("Sprite Shape collider type must be edge or polygon.");
	}
	if (!closed && colliderType === "polygon") {
		throw new Error("Open Sprite Shapes require an edge collider. Close the shape before selecting polygon collider geometry.");
	}
	const colliderDetail = integer(colliderCandidate.detail, 1, 8, "Sprite Shape collider detail");
	if (segmentCount * colliderDetail + Number(!closed) > 512) {
		throw new Error("Sprite Shape collider tessellation exceeds 512 points. Reduce collider detail or control points.");
	}
	return {
		model: "unity-sprite-shape-controller-v1",
		version: 1,
		revision: integer(candidate.revision, 0, Number.MAX_SAFE_INTEGER, "Sprite Shape revision"),
		profileId: identifier(candidate.profileId, "Sprite Shape profileId"),
		closed,
		detail,
		adaptiveUV: candidate.adaptiveUV !== false,
		stretchUV: candidate.stretchUV === true,
		worldSpaceUV: candidate.worldSpaceUV === true,
		fillOffset: finite(candidate.fillOffset ?? 0, -1_000_000, 1_000_000, "Sprite Shape fillOffset"),
		geometryOptimization: candidate.geometryOptimization !== false,
		enableTangents: candidate.enableTangents === true,
		points,
		collider: {
			enabled: colliderCandidate.enabled === true,
			type: colliderType,
			detail: colliderDetail,
			offset: finite(colliderCandidate.offset ?? 0, -1_000_000, 1_000_000, "Sprite Shape collider offset"),
			edgeRadius: finite(colliderCandidate.edgeRadius ?? 1, 0.001, 1_000_000, "Sprite Shape collider edgeRadius"),
			optimize: colliderCandidate.optimize !== false,
			isTrigger: colliderCandidate.isTrigger === true,
			friction: finite(colliderCandidate.friction ?? 0, 0, 1, "Sprite Shape collider friction"),
			restitution: finite(colliderCandidate.restitution ?? 0, 0, 1, "Sprite Shape collider restitution"),
		},
	};
}

export function createDefaultSpriteShapeDefinition(profileId: string): ISpriteShapeDefinition {
	return normalizeSpriteShapeDefinition({
		model: "unity-sprite-shape-controller-v1",
		version: 1,
		revision: 1,
		profileId,
		closed: true,
		detail: 8,
		adaptiveUV: true,
		stretchUV: false,
		worldSpaceUV: false,
		fillOffset: 0,
		geometryOptimization: true,
		enableTangents: true,
		points: [
			{ id: "point-1", position: [-150, -75], leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: 40, corner: true },
			{ id: "point-2", position: [150, -75], leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: 40, corner: true },
			{ id: "point-3", position: [150, 75], leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: 40, corner: true },
			{ id: "point-4", position: [-150, 75], leftTangent: [0, 0], rightTangent: [0, 0], tangentMode: "linear", height: 40, corner: true },
		],
		collider: { enabled: true, type: "polygon", detail: 2, offset: 0, edgeRadius: 1, optimize: true, isTrigger: false, friction: 0, restitution: 0 },
	});
}

function evaluateSegment(
	start: ISpriteShapeControlPoint,
	end: ISpriteShapeControlPoint,
	amount: number
): { position: SpriteShapePoint2D; tangent: SpriteShapePoint2D; height: number } {
	const startLinear = start.corner || start.tangentMode === "linear";
	const endLinear = end.corner || end.tangentMode === "linear";
	const first = start.position;
	const second = startLinear ? start.position : add(start.position, start.rightTangent);
	const fourth = end.position;
	const third = endLinear ? end.position : add(end.position, end.leftTangent);
	const inverse = 1 - amount;
	const position: SpriteShapePoint2D = [
		inverse * inverse * inverse * first[0] + 3 * inverse * inverse * amount * second[0] + 3 * inverse * amount * amount * third[0] + amount * amount * amount * fourth[0],
		inverse * inverse * inverse * first[1] + 3 * inverse * inverse * amount * second[1] + 3 * inverse * amount * amount * third[1] + amount * amount * amount * fourth[1],
	];
	let tangent: SpriteShapePoint2D = [
		3 * inverse * inverse * (second[0] - first[0]) + 6 * inverse * amount * (third[0] - second[0]) + 3 * amount * amount * (fourth[0] - third[0]),
		3 * inverse * inverse * (second[1] - first[1]) + 6 * inverse * amount * (third[1] - second[1]) + 3 * amount * amount * (fourth[1] - third[1]),
	];
	if (length(tangent) <= EPSILON) {
		tangent = subtract(end.position, start.position);
	}
	return { position, tangent: normalize(tangent), height: start.height + (end.height - start.height) * amount };
}

function sampleShape(definition: ISpriteShapeDefinition, detail: number, optimize: boolean): ISampledPoint[] {
	const segmentCount = definition.closed ? definition.points.length : definition.points.length - 1;
	const samples: ISampledPoint[] = [];
	for (let segment = 0; segment < segmentCount; segment++) {
		const start = definition.points[segment];
		const end = definition.points[(segment + 1) % definition.points.length];
		const startLinear = start.corner || start.tangentMode === "linear";
		const endLinear = end.corner || end.tangentMode === "linear";
		const segmentDetail = optimize && startLinear && endLinear ? 1 : detail;
		for (let step = 0; step < segmentDetail; step++) {
			const evaluated = evaluateSegment(start, end, step / segmentDetail);
			samples.push({ ...evaluated, normal: [-evaluated.tangent[1], evaluated.tangent[0]], distance: 0 });
		}
	}
	if (!definition.closed) {
		const last = definition.points[definition.points.length - 1];
		const previous = definition.points[definition.points.length - 2];
		const tangent = evaluateSegment(previous, last, 1).tangent;
		samples.push({ position: [...last.position], tangent, normal: [-tangent[1], tangent[0]], height: last.height, distance: 0 });
	}
	let distance = 0;
	for (let index = 0; index < samples.length; index++) {
		if (index > 0) {
			distance += length(subtract(samples[index].position, samples[index - 1].position));
		}
		samples[index].distance = distance;
	}
	return samples;
}

function selectedAngleRange(profile: ISpriteShapeProfile, tangent: SpriteShapePoint2D): ISpriteShapeAngleRange | null {
	const degrees = (Math.atan2(tangent[1], tangent[0]) * 180) / Math.PI;
	return (
		[...profile.angleRanges]
			.filter((range) => degrees >= range.minimumDegrees && degrees < range.maximumDegrees)
			.sort((first, second) => second.order - first.order || first.id.localeCompare(second.id))[0] ?? null
	);
}

function uvU(definition: ISpriteShapeDefinition, profile: ISpriteShapeProfile, sample: ISampledPoint, totalLength: number, index: number): number {
	if (definition.worldSpaceUV) {
		return sample.position[0] / profile.pixelsPerUnit;
	}
	if (definition.stretchUV) {
		return totalLength > EPSILON ? sample.distance / totalLength : 0;
	}
	if (definition.adaptiveUV) {
		return sample.distance / profile.pixelsPerUnit;
	}
	return index;
}

function offsetClosedPoints(samples: ISampledPoint[], amount: number): SpriteShapePoint2D[] {
	if (Math.abs(amount) <= EPSILON) {
		return samples.map((sample) => [...sample.position]);
	}
	const orientation = area(samples.map((sample) => sample.position)) >= 0 ? 1 : -1;
	return samples.map((sample) => add(sample.position, scale(sample.normal, amount * orientation)));
}

function createEdgeColliderParts(samples: ISampledPoint[], closed: boolean, radius: number, offset: number): SpriteShapePoint2D[][] {
	const segmentCount = closed ? samples.length : samples.length - 1;
	const parts: SpriteShapePoint2D[][] = [];
	for (let index = 0; index < segmentCount; index++) {
		const first = samples[index];
		const second = samples[(index + 1) % samples.length];
		const direction = normalize(subtract(second.position, first.position));
		const normal: SpriteShapePoint2D = [-direction[1], direction[0]];
		const centerOffset = scale(normal, offset);
		parts.push([
			add(add(first.position, centerOffset), scale(normal, radius)),
			add(add(second.position, centerOffset), scale(normal, radius)),
			add(add(second.position, centerOffset), scale(normal, -radius)),
			add(add(first.position, centerOffset), scale(normal, -radius)),
		]);
	}
	return parts;
}

function buildCollider(definition: ISpriteShapeDefinition): ISpriteShapeColliderGeometry | null {
	if (!definition.collider.enabled) {
		return null;
	}
	const samples = sampleShape(definition, definition.collider.detail, definition.collider.optimize);
	if (definition.collider.type === "edge") {
		return {
			type: "edge",
			points: samples.map((sample) => [...sample.position]),
			parts: createEdgeColliderParts(samples, definition.closed, definition.collider.edgeRadius, definition.collider.offset),
			contours: [],
		};
	}
	let points = offsetClosedPoints(samples, definition.collider.offset);
	if (definition.collider.optimize) {
		points = cleanPolygon(points);
	}
	validateSimplePolygon(points, "Sprite Shape polygon collider");
	if (area(points) < 0) {
		points = [...points].reverse();
	}
	const triangulated = triangulatePolygon(points);
	const parts = triangulated.indices.reduce<SpriteShapePoint2D[][]>((result, _, index, source) => {
		if (index % 3 === 0) {
			result.push([triangulated.points[source[index]], triangulated.points[source[index + 1]], triangulated.points[source[index + 2]]]);
		}
		return result;
	}, []);
	return { type: "polygon", points, parts, contours: [{ id: "sprite-shape-outer", points, holes: [] }] };
}

/** Generates one bounded Sprite Shape mesh and its optional exact 2D collider from shared profile/controller data. */
export function generateSpriteShapeGeometry(profileValue: unknown, definitionValue: unknown): ISpriteShapeGeometry {
	const profile = normalizeSpriteShapeProfile(profileValue);
	const definition = normalizeSpriteShapeDefinition(definitionValue);
	if (profile.id !== definition.profileId) {
		throw new Error(`Sprite Shape controller references profile "${definition.profileId}" but received profile "${profile.id}".`);
	}
	const samples = sampleShape(definition, definition.detail, definition.geometryOptimization);
	const closedSegmentCount = definition.closed ? samples.length : samples.length - 1;
	const totalLength = samples[samples.length - 1].distance + (definition.closed ? length(subtract(samples[0].position, samples[samples.length - 1].position)) : 0);
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const colors: number[] = [];
	const tangents: number[] | null = definition.enableTangents ? [] : null;
	const materialSlots: ISpriteShapeMaterialSlot[] = [
		{ kind: "fill", angleRangeId: null, texturePath: profile.fillTexturePath, color: profile.fillColor },
		{ kind: "edge", angleRangeId: null, texturePath: profile.edgeTexturePath, color: profile.edgeColor },
		...profile.angleRanges.map((range) => ({ kind: "edge" as const, angleRangeId: range.id, texturePath: range.texturePath ?? profile.edgeTexturePath, color: range.color })),
	];
	const materialIndices = new Map<string, number>(profile.angleRanges.map((range, index) => [range.id, index + 2]));
	const indexBuckets = materialSlots.map(() => [] as number[]);
	const edgeBorderV = profile.useSpriteBorders ? Math.min(0.49, 0.5 / profile.pixelsPerUnit) : 0;
	const pushVertex = (positionValue: SpriteShapePoint2D, uv: SpriteShapePoint2D, colorValue: SpriteShapeColor, tangentValue: SpriteShapePoint2D): number => {
		const vertex = positions.length / 3;
		positions.push(positionValue[0], positionValue[1], 0);
		normals.push(0, 0, -1);
		uvs.push(uv[0], uv[1]);
		colors.push(...colorValue);
		tangents?.push(tangentValue[0], tangentValue[1], 0, 1);
		return vertex;
	};
	for (let index = 0; index < closedSegmentCount; index++) {
		const first = samples[index];
		const second = samples[(index + 1) % samples.length];
		const range = selectedAngleRange(profile, first.tangent);
		const materialIndex = range ? materialIndices.get(range.id)! : 1;
		const slot = materialSlots[materialIndex];
		const firstU = uvU(definition, profile, first, totalLength, index);
		const secondDistance = index === samples.length - 1 && definition.closed ? totalLength : second.distance;
		const secondU = definition.worldSpaceUV
			? second.position[0] / profile.pixelsPerUnit
			: definition.stretchUV
				? totalLength > EPSILON
					? secondDistance / totalLength
					: 0
				: definition.adaptiveUV
					? secondDistance / profile.pixelsPerUnit
					: index + 1;
		const firstLeft = add(first.position, scale(first.normal, first.height / 2));
		const firstRight = add(first.position, scale(first.normal, -first.height / 2));
		const secondLeft = add(second.position, scale(second.normal, second.height / 2));
		const secondRight = add(second.position, scale(second.normal, -second.height / 2));
		const firstLeftIndex = pushVertex(firstLeft, [firstU, edgeBorderV], slot.color, first.tangent);
		const firstRightIndex = pushVertex(firstRight, [firstU, 1 - edgeBorderV], slot.color, first.tangent);
		const secondLeftIndex = pushVertex(secondLeft, [secondU, edgeBorderV], slot.color, second.tangent);
		const secondRightIndex = pushVertex(secondRight, [secondU, 1 - edgeBorderV], slot.color, second.tangent);
		indexBuckets[materialIndex].push(firstLeftIndex, secondLeftIndex, firstRightIndex, firstRightIndex, secondLeftIndex, secondRightIndex);
	}
	let fillTriangleCount = 0;
	if (definition.closed) {
		const triangulation = triangulatePolygon(offsetClosedPoints(samples, definition.fillOffset));
		const minimumX = Math.min(...triangulation.points.map((entry) => entry[0]));
		const maximumX = Math.max(...triangulation.points.map((entry) => entry[0]));
		const minimumY = Math.min(...triangulation.points.map((entry) => entry[1]));
		const maximumY = Math.max(...triangulation.points.map((entry) => entry[1]));
		const fillVertexOffset = positions.length / 3;
		for (const fillPoint of triangulation.points) {
			const uv: SpriteShapePoint2D = definition.worldSpaceUV
				? [fillPoint[0] / profile.pixelsPerUnit, fillPoint[1] / profile.pixelsPerUnit]
				: [(fillPoint[0] - minimumX) / Math.max(EPSILON, maximumX - minimumX), (fillPoint[1] - minimumY) / Math.max(EPSILON, maximumY - minimumY)];
			pushVertex(fillPoint, uv, profile.fillColor, [1, 0]);
		}
		indexBuckets[0].push(...triangulation.indices.map((index) => index + fillVertexOffset));
		fillTriangleCount = triangulation.indices.length / 3;
	}
	const indices: number[] = [];
	const subMeshes: ISpriteShapeSubMesh[] = [];
	for (let materialIndex = 0; materialIndex < indexBuckets.length; materialIndex++) {
		const bucket = indexBuckets[materialIndex];
		if (!bucket.length) {
			continue;
		}
		const indexStart = indices.length;
		indices.push(...bucket);
		subMeshes.push({ materialIndex, indexStart, indexCount: bucket.length });
	}
	return {
		model: "unity-sprite-shape-generated-geometry-v1",
		positions,
		indices,
		normals,
		uvs,
		colors,
		tangents,
		subMeshes,
		materialSlots,
		sampleCount: samples.length,
		edgeQuadCount: closedSegmentCount,
		fillTriangleCount,
		length: totalLength,
		closed: definition.closed,
		collider: buildCollider(definition),
	};
}
