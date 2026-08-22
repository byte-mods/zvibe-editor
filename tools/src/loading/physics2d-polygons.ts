export type IPhysics2DPoint = [number, number];

export interface IPhysics2DPolygonHole {
	id: string;
	points: IPhysics2DPoint[];
}

export interface IPhysics2DPolygonContour {
	id: string;
	points: IPhysics2DPoint[];
	holes: IPhysics2DPolygonHole[];
}

export interface IPhysics2DPolygonDecomposition {
	model: "unity-polygon-collider-holes-islands-v1";
	contours: IPhysics2DPolygonContour[];
	parts: IPhysics2DPoint[][];
	outerCount: number;
	holeCount: number;
	vertexCount: number;
	filledArea: number;
	decomposedArea: number;
}

const epsilon = 0.000001;

function area(points: IPhysics2DPoint[]): number {
	return points.reduce((total, point, index) => total + point[0] * points[(index + 1) % points.length][1] - point[1] * points[(index + 1) % points.length][0], 0) / 2;
}

function cross(first: IPhysics2DPoint, second: IPhysics2DPoint, third: IPhysics2DPoint): number {
	return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function samePoint(first: IPhysics2DPoint, second: IPhysics2DPoint): boolean {
	return Math.abs(first[0] - second[0]) <= epsilon && Math.abs(first[1] - second[1]) <= epsilon;
}

function pointOnSegment(point: IPhysics2DPoint, first: IPhysics2DPoint, second: IPhysics2DPoint): boolean {
	return (
		Math.abs(cross(first, second, point)) <= epsilon &&
		point[0] >= Math.min(first[0], second[0]) - epsilon &&
		point[0] <= Math.max(first[0], second[0]) + epsilon &&
		point[1] >= Math.min(first[1], second[1]) - epsilon &&
		point[1] <= Math.max(first[1], second[1]) + epsilon
	);
}

function segmentsIntersect(firstStart: IPhysics2DPoint, firstEnd: IPhysics2DPoint, secondStart: IPhysics2DPoint, secondEnd: IPhysics2DPoint): boolean {
	const first = cross(firstStart, firstEnd, secondStart);
	const second = cross(firstStart, firstEnd, secondEnd);
	const third = cross(secondStart, secondEnd, firstStart);
	const fourth = cross(secondStart, secondEnd, firstEnd);
	if ((first > epsilon && second < -epsilon) || (first < -epsilon && second > epsilon)) {
		return (third > epsilon && fourth < -epsilon) || (third < -epsilon && fourth > epsilon);
	}
	return (
		(Math.abs(first) <= epsilon && pointOnSegment(secondStart, firstStart, firstEnd)) ||
		(Math.abs(second) <= epsilon && pointOnSegment(secondEnd, firstStart, firstEnd)) ||
		(Math.abs(third) <= epsilon && pointOnSegment(firstStart, secondStart, secondEnd)) ||
		(Math.abs(fourth) <= epsilon && pointOnSegment(firstEnd, secondStart, secondEnd))
	);
}

function simplifyRing(value: unknown, label: string): IPhysics2DPoint[] {
	if (!Array.isArray(value) || value.length < 3 || value.length > 128) {
		throw new Error(`${label} requires 3 through 128 vertices.`);
	}
	const points = value.map((point, index) => {
		if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
			throw new Error(`${label} vertex ${index} must be a finite [x, y] pair.`);
		}
		return [point[0], point[1]] as IPhysics2DPoint;
	});
	if (samePoint(points[0], points[points.length - 1])) {
		points.pop();
	}
	let changed = true;
	while (changed && points.length >= 3) {
		changed = false;
		for (let index = 0; index < points.length; index++) {
			const previous = points[(index - 1 + points.length) % points.length];
			const current = points[index];
			const next = points[(index + 1) % points.length];
			if (samePoint(previous, current) || Math.abs(cross(previous, current, next)) <= epsilon) {
				points.splice(index, 1);
				changed = true;
				break;
			}
		}
	}
	if (points.length < 3) {
		throw new Error(`${label} must enclose non-zero area after duplicate/collinear cleanup.`);
	}
	for (let first = 0; first < points.length; first++) {
		for (let second = first + 1; second < points.length; second++) {
			if (second === first + 1 || (first === 0 && second === points.length - 1)) {
				continue;
			}
			if (segmentsIntersect(points[first], points[(first + 1) % points.length], points[second], points[(second + 1) % points.length])) {
				throw new Error(`${label} must be a simple non-self-intersecting ring.`);
			}
		}
	}
	if (Math.abs(area(points)) <= epsilon) {
		throw new Error(`${label} must enclose non-zero area after duplicate/collinear cleanup.`);
	}
	return points;
}

function pointInRing(point: IPhysics2DPoint, ring: IPhysics2DPoint[]): "inside" | "outside" | "boundary" {
	let inside = false;
	for (let index = 0; index < ring.length; index++) {
		const first = ring[index];
		const second = ring[(index + 1) % ring.length];
		if (pointOnSegment(point, first, second)) {
			return "boundary";
		}
		if (first[1] > point[1] !== second[1] > point[1] && point[0] < ((second[0] - first[0]) * (point[1] - first[1])) / (second[1] - first[1]) + first[0]) {
			inside = !inside;
		}
	}
	return inside ? "inside" : "outside";
}

function ringsIntersect(first: IPhysics2DPoint[], second: IPhysics2DPoint[]): boolean {
	return first.some((point, firstIndex) =>
		second.some((other, secondIndex) => segmentsIntersect(point, first[(firstIndex + 1) % first.length], other, second[(secondIndex + 1) % second.length]))
	);
}

function canonicalRing(points: IPhysics2DPoint[], counterClockwise: boolean): IPhysics2DPoint[] {
	return area(points) > 0 === counterClockwise ? points : [...points].reverse();
}

type IEdge = { first: IPhysics2DPoint; second: IPhysics2DPoint; y: number };

function yAt(edge: IEdge, x: number): number {
	return edge.first[1] + ((x - edge.first[0]) * (edge.second[1] - edge.first[1])) / (edge.second[0] - edge.first[0]);
}

function cleanPart(points: IPhysics2DPoint[]): IPhysics2DPoint[] {
	const unique = points.filter((point, index) => !index || !samePoint(point, points[index - 1]));
	if (unique.length > 1 && samePoint(unique[0], unique[unique.length - 1])) {
		unique.pop();
	}
	return canonicalRing(unique, true);
}

function decomposeRings(rings: IPhysics2DPoint[][]): IPhysics2DPoint[][] {
	const xValues = [...new Set(rings.flat().map((point) => point[0]))].sort((first, second) => first - second);
	const parts: IPhysics2DPoint[][] = [];
	for (let slab = 0; slab < xValues.length - 1; slab++) {
		const left = xValues[slab];
		const right = xValues[slab + 1];
		if (right - left <= epsilon) {
			continue;
		}
		const middle = (left + right) / 2;
		const edges: IEdge[] = [];
		for (const ring of rings) {
			for (let index = 0; index < ring.length; index++) {
				const first = ring[index];
				const second = ring[(index + 1) % ring.length];
				if (Math.abs(first[0] - second[0]) <= epsilon || middle <= Math.min(first[0], second[0]) || middle >= Math.max(first[0], second[0])) {
					continue;
				}
				const edge = { first, second, y: 0 };
				edge.y = yAt(edge, middle);
				edges.push(edge);
			}
		}
		edges.sort((first, second) => first.y - second.y);
		if (edges.length % 2) {
			throw new Error("Polygon contour parity is invalid; rings may overlap or touch.");
		}
		for (let index = 0; index < edges.length; index += 2) {
			const lower = edges[index];
			const upper = edges[index + 1];
			const part = cleanPart([
				[left, yAt(lower, left)],
				[right, yAt(lower, right)],
				[right, yAt(upper, right)],
				[left, yAt(upper, left)],
			]);
			if (part.length >= 3 && Math.abs(area(part)) > epsilon) {
				parts.push(part);
			}
		}
	}
	if (!parts.length || parts.length > 4_096) {
		throw new Error("Polygon holes/islands decomposition must produce 1 through 4096 convex parts.");
	}
	return parts;
}

/** Validates and decomposes disconnected outer contours with non-overlapping holes into exact convex trapezoids. */
export function decomposePhysics2DPolygonContours(value: unknown): IPhysics2DPolygonDecomposition {
	if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
		throw new Error("Polygon colliders require 1 through 32 disconnected outer contours.");
	}
	const ids = new Set<string>();
	const contours = value.map((candidate: any, contourIndex): IPhysics2DPolygonContour => {
		if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || !candidate.id || candidate.id.length > 256 || ids.has(candidate.id)) {
			throw new Error("Polygon contour and hole ids must be unique strings containing 1 through 256 characters.");
		}
		ids.add(candidate.id);
		const points = canonicalRing(simplifyRing(candidate.points, `Contour ${contourIndex}`), true);
		if (!Array.isArray(candidate.holes) || candidate.holes.length > 32) {
			throw new Error(`Contour ${contourIndex} holes must be an array containing at most 32 rings.`);
		}
		const holes = candidate.holes.map((hole: any, holeIndex: number): IPhysics2DPolygonHole => {
			if (!hole || typeof hole !== "object" || typeof hole.id !== "string" || !hole.id || hole.id.length > 256 || ids.has(hole.id)) {
				throw new Error("Polygon contour and hole ids must be unique strings containing 1 through 256 characters.");
			}
			ids.add(hole.id);
			const holePoints = canonicalRing(simplifyRing(hole.points, `Contour ${contourIndex} hole ${holeIndex}`), false);
			if (pointInRing(holePoints[0], points) !== "inside" || ringsIntersect(points, holePoints)) {
				throw new Error(`Contour ${contourIndex} hole ${holeIndex} must be strictly inside its outer ring without touching it.`);
			}
			return { id: hole.id, points: holePoints };
		});
		for (let first = 0; first < holes.length; first++) {
			for (let second = first + 1; second < holes.length; second++) {
				if (
					ringsIntersect(holes[first].points, holes[second].points) ||
					pointInRing(holes[first].points[0], holes[second].points) !== "outside" ||
					pointInRing(holes[second].points[0], holes[first].points) !== "outside"
				) {
					throw new Error(`Contour ${contourIndex} holes must not intersect, touch, or contain one another.`);
				}
			}
		}
		return { id: candidate.id, points, holes };
	});
	for (let first = 0; first < contours.length; first++) {
		for (let second = first + 1; second < contours.length; second++) {
			if (
				ringsIntersect(contours[first].points, contours[second].points) ||
				pointInRing(contours[first].points[0], contours[second].points) !== "outside" ||
				pointInRing(contours[second].points[0], contours[first].points) !== "outside"
			) {
				throw new Error("Disconnected polygon contours must not intersect, touch, or contain one another.");
			}
		}
	}
	const vertexCount = contours.reduce((total, contour) => total + contour.points.length + contour.holes.reduce((sum, hole) => sum + hole.points.length, 0), 0);
	if (vertexCount > 512) {
		throw new Error("Polygon contours and holes support at most 512 total vertices.");
	}
	const rings = contours.flatMap((contour) => [contour.points, ...contour.holes.map((hole) => hole.points)]);
	const parts = decomposeRings(rings);
	const filledArea = contours.reduce((total, contour) => total + Math.abs(area(contour.points)) - contour.holes.reduce((sum, hole) => sum + Math.abs(area(hole.points)), 0), 0);
	const decomposedArea = parts.reduce((total, part) => total + Math.abs(area(part)), 0);
	if (Math.abs(filledArea - decomposedArea) > Math.max(0.0001, filledArea * 0.000001)) {
		throw new Error(`Polygon decomposition area mismatch: expected ${filledArea}, produced ${decomposedArea}.`);
	}
	return {
		model: "unity-polygon-collider-holes-islands-v1",
		contours,
		parts,
		outerCount: contours.length,
		holeCount: contours.reduce((total, contour) => total + contour.holes.length, 0),
		vertexCount,
		filledArea,
		decomposedArea,
	};
}
