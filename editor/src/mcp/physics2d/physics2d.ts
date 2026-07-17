import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { pathExists } from "fs-extra";

import sharp from "sharp";

import { Scene, Tools, Vector3 } from "babylonjs";

import { isAbstractMesh, isTransformNode } from "../../tools/guards/nodes";
import { projectConfiguration } from "../../project/configuration";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

type IBody2D = { config: any; node: any; velocity: Vector3 };
type IRuntimePhysics2D = { bodies: Map<string, IBody2D>; observer: any; collisions: number; triggers: { firstNodeId: string; secondNodeId: string }[] };
type IPoint2D = [number, number];

const runtimes = new WeakMap<Scene, IRuntimePhysics2D>();

function configs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPhysics2D ??= []);
}
function joints(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPhysics2DJoints ??= []);
}
function materials(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPhysics2DMaterials ??= []);
}
function effectors(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPhysics2DEffectors ??= []);
}
function settings(scene: Scene): any {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPhysics2DSettings ??= { solverIterations: 1 });
}
function findMaterial(scene: Scene, id: string): any {
	const material = materials(scene).find((candidate) => candidate.id === id);
	if (!material) throw new Error(`2D physics material "${id}" was not found.`);
	return material;
}
function materialProperties(scene: Scene, config: any): { friction: number; restitution: number; material: any | null } {
	const material = config.materialId ? findMaterial(scene, config.materialId) : null;
	return { friction: config.friction ?? material?.friction ?? 0, restitution: config.restitution ?? material?.restitution ?? 0, material };
}

function resolveBodyNode(scene: Scene, nodeId: string): any {
	const node = resolveNode({ scene, nodeId });
	if (!isTransformNode(node) && !isAbstractMesh(node)) throw new Error("A 2D physics body must be attached to a mesh or transform node.");
	return node;
}

function signedPolygonArea(points: IPoint2D[]): number {
	return points.reduce((area, point, index) => area + point[0] * points[(index + 1) % points.length][1] - point[1] * points[(index + 1) % points.length][0], 0) / 2;
}

function pointInTriangle(point: IPoint2D, first: IPoint2D, second: IPoint2D, third: IPoint2D): boolean {
	const cross = (origin: IPoint2D, a: IPoint2D, b: IPoint2D): number => (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
	const values = [cross(point, first, second), cross(point, second, third), cross(point, third, first)];
	return values.every((value) => value >= -0.000001) || values.every((value) => value <= 0.000001);
}

function segmentsIntersect(firstStart: IPoint2D, firstEnd: IPoint2D, secondStart: IPoint2D, secondEnd: IPoint2D): boolean {
	const orientation = (origin: IPoint2D, first: IPoint2D, second: IPoint2D): number =>
		(first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
	const first = orientation(firstStart, firstEnd, secondStart);
	const second = orientation(firstStart, firstEnd, secondEnd);
	const third = orientation(secondStart, secondEnd, firstStart);
	const fourth = orientation(secondStart, secondEnd, firstEnd);
	return Math.sign(first) !== Math.sign(second) && Math.sign(third) !== Math.sign(fourth);
}

/** Ear-clips a simple polygon into convex triangle parts for the SAT collision solver. */
function decomposePolygon(points: IPoint2D[]): IPoint2D[][] {
	const winding = Math.sign(signedPolygonArea(points));
	if (!winding) throw new Error("Polygon colliders must enclose a non-zero area.");
	const remaining = points.map((point) => [...point] as IPoint2D);
	const parts: IPoint2D[][] = [];
	while (remaining.length > 3) {
		let earIndex = -1;
		for (let index = 0; index < remaining.length; index++) {
			const first = remaining[(index - 1 + remaining.length) % remaining.length];
			const second = remaining[index];
			const third = remaining[(index + 1) % remaining.length];
			const cross = (second[0] - first[0]) * (third[1] - second[1]) - (second[1] - first[1]) * (third[0] - second[0]);
			if (
				winding * cross <= 0.000001 ||
				remaining.some(
					(point, candidate) =>
						candidate !== index &&
						candidate !== (index - 1 + remaining.length) % remaining.length &&
						candidate !== (index + 1) % remaining.length &&
						pointInTriangle(point, first, second, third)
				)
			)
				continue;
			parts.push([first, second, third]);
			earIndex = index;
			break;
		}
		if (earIndex === -1) throw new Error("Polygon colliders must be simple outlines without holes, self-intersections, or collinear vertices.");
		remaining.splice(earIndex, 1);
	}
	parts.push(remaining);
	return parts;
}

function validatePolygon(points: any): IPoint2D[][] {
	if (!Array.isArray(points) || points.length < 3 || points.some((point) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)))
		throw new Error("Polygon colliders require at least three finite [x, y] vertices.");
	if (points.length > 64) throw new Error("Polygon colliders support at most 64 vertices.");
	for (let first = 0; first < points.length; first++)
		for (let second = first + 1; second < points.length; second++) {
			if (second === first + 1 || (first === 0 && second === points.length - 1)) continue;
			if (segmentsIntersect(points[first], points[(first + 1) % points.length], points[second], points[(second + 1) % points.length]))
				throw new Error("Polygon colliders must be simple outlines without self-intersections or holes.");
		}
	let winding = 0;
	let convex = true;
	for (let index = 0; index < points.length; index++) {
		const first = points[index];
		const second = points[(index + 1) % points.length];
		const third = points[(index + 2) % points.length];
		const cross = (second[0] - first[0]) * (third[1] - second[1]) - (second[1] - first[1]) * (third[0] - second[0]);
		if (Math.abs(cross) < 0.000001) throw new Error("Polygon collider vertices must not be collinear.");
		if (!winding) winding = Math.sign(cross);
		else if (Math.sign(cross) !== winding) convex = false;
	}
	return convex ? [points] : decomposePolygon(points);
}

function resolveProjectImagePath(path: string): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	const directory = dirname(projectConfiguration.path);
	const absolutePath = normalize(isAbsolute(path) ? path : join(directory, path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) throw new Error("Image paths must stay inside the open project directory.");
	return absolutePath;
}

function convexHull(points: IPoint2D[]): IPoint2D[] {
	const sorted = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()].sort((first, second) => first[0] - second[0] || first[1] - second[1]);
	if (sorted.length < 3) return sorted;
	const cross = (origin: IPoint2D, first: IPoint2D, second: IPoint2D): number =>
		(first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
	const lower: IPoint2D[] = [];
	for (const point of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
		lower.push(point);
	}
	const upper: IPoint2D[] = [];
	for (const point of [...sorted].reverse()) {
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
		upper.push(point);
	}
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

type IGridPoint = [number, number];
type IGridEdge = { first: IGridPoint; second: IGridPoint };

function gridPointKey(point: IGridPoint): string {
	return `${point[0]},${point[1]}`;
}

function gridPolygonArea(points: IGridPoint[]): number {
	return points.reduce((area, point, index) => area + point[0] * points[(index + 1) % points.length][1] - point[1] * points[(index + 1) % points.length][0], 0) / 2;
}

/** Traces the largest opaque 4-connected raster boundary in grid coordinates, retaining concavities but not holes or disconnected islands. */
function traceLargestOpaqueOutline(data: Buffer, width: number, height: number, channels: number, alphaThreshold: number, stride: number): IPoint2D[] {
	const opaque = new Set<string>();
	const columns = Math.ceil(width / stride);
	const rows = Math.ceil(height / stride);
	for (let row = 0; row < rows; row++)
		for (let column = 0; column < columns; column++) {
			const offset = (Math.min(height - 1, row * stride) * width + Math.min(width - 1, column * stride)) * channels;
			if (data[offset + 3] >= alphaThreshold) opaque.add(`${column},${row}`);
		}
	if (!opaque.size) throw new Error("Image contains no pixels at or above the requested alpha threshold.");

	const edges = new Map<string, IGridEdge>();
	const addEdge = (first: IGridPoint, second: IGridPoint): void => {
		const key = `${gridPointKey(first)}>${gridPointKey(second)}`;
		const reverse = `${gridPointKey(second)}>${gridPointKey(first)}`;
		if (edges.has(reverse)) edges.delete(reverse);
		else edges.set(key, { first, second });
	};
	for (const cell of opaque) {
		const [column, row] = cell.split(",").map(Number);
		addEdge([column, row], [column + 1, row]);
		addEdge([column + 1, row], [column + 1, row + 1]);
		addEdge([column + 1, row + 1], [column, row + 1]);
		addEdge([column, row + 1], [column, row]);
	}

	const loops: IGridPoint[][] = [];
	while (edges.size) {
		const edge = edges.values().next().value as IGridEdge;
		edges.delete(`${gridPointKey(edge.first)}>${gridPointKey(edge.second)}`);
		const loop = [edge.first, edge.second];
		while (gridPointKey(loop[loop.length - 1]) !== gridPointKey(loop[0])) {
			const next = [...edges.values()].find((candidate) => gridPointKey(candidate.first) === gridPointKey(loop[loop.length - 1]));
			if (!next) throw new Error("Could not trace a simple opaque image outline. Use a 4-connected silhouette.");
			edges.delete(`${gridPointKey(next.first)}>${gridPointKey(next.second)}`);
			loop.push(next.second);
		}
		loop.pop();
		const simplified = loop.filter((point, index) => {
			const previous = loop[(index - 1 + loop.length) % loop.length];
			const next = loop[(index + 1) % loop.length];
			return (point[0] - previous[0]) * (next[1] - point[1]) !== (point[1] - previous[1]) * (next[0] - point[0]);
		});
		if (simplified.length >= 3) loops.push(simplified);
	}
	const largest = loops.sort((first, second) => Math.abs(gridPolygonArea(second)) - Math.abs(gridPolygonArea(first)))[0];
	if (!largest) throw new Error("Image alpha silhouette does not form a usable polygon collider.");
	return largest.map(([column, row]) => [Math.min(width, column * stride), Math.min(height, row * stride)]);
}

function polygonPartsForBody(body: IBody2D): IPoint2D[][] {
	const collider = body.config.collider;
	const parts: IPoint2D[][] =
		collider.shape === "polygon"
			? (collider.parts ?? [collider.points])
			: [
					[
						[-collider.size[0] / 2, -collider.size[1] / 2],
						[collider.size[0] / 2, -collider.size[1] / 2],
						[collider.size[0] / 2, collider.size[1] / 2],
						[-collider.size[0] / 2, collider.size[1] / 2],
					],
				];
	return parts.map((points) => points.map(([x, y]) => [body.node.position.x + x, body.node.position.y + y]));
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

function polygonHit(first: IPoint2D[], second: IPoint2D[]): { normal: Vector3; penetration: number } | null {
	let penetration = Infinity;
	let normal: IPoint2D = [0, 0];
	for (const axis of [...axes(first), ...axes(second)]) {
		const [firstMin, firstMax] = polygonRange(first, axis);
		const [secondMin, secondMax] = polygonRange(second, axis);
		const overlap = Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin);
		if (overlap <= 0) return null;
		if (overlap < penetration) {
			penetration = overlap;
			normal = axis;
		}
	}
	const firstCenter = center(first);
	const secondCenter = center(second);
	if ((secondCenter[0] - firstCenter[0]) * normal[0] + (secondCenter[1] - firstCenter[1]) * normal[1] < 0) normal = [-normal[0], -normal[1]];
	return { normal: new Vector3(normal[0], normal[1], 0), penetration };
}

function circlePolygonHit(circle: IBody2D, points: IPoint2D[]): { normal: Vector3; penetration: number } | null {
	const circleCenter: IPoint2D = [circle.node.position.x, circle.node.position.y];
	let nearest = points[0];
	for (const point of points)
		if (Math.hypot(point[0] - circleCenter[0], point[1] - circleCenter[1]) < Math.hypot(nearest[0] - circleCenter[0], nearest[1] - circleCenter[1])) nearest = point;
	const delta: IPoint2D = [nearest[0] - circleCenter[0], nearest[1] - circleCenter[1]];
	const distance = Math.hypot(delta[0], delta[1]);
	const candidateAxes = [...axes(points), ...(distance ? [[delta[0] / distance, delta[1] / distance] as IPoint2D] : [])];
	let penetration = Infinity;
	let normal: IPoint2D = [0, 0];
	for (const axis of candidateAxes) {
		const [polygonMin, polygonMax] = polygonRange(points, axis);
		const projection = circleCenter[0] * axis[0] + circleCenter[1] * axis[1];
		const overlap = Math.min(polygonMax, projection + circle.config.collider.radius) - Math.max(polygonMin, projection - circle.config.collider.radius);
		if (overlap <= 0) return null;
		if (overlap < penetration) {
			penetration = overlap;
			normal = axis;
		}
	}
	const polygonCenter = center(points);
	if ((polygonCenter[0] - circleCenter[0]) * normal[0] + (polygonCenter[1] - circleCenter[1]) * normal[1] < 0) normal = [-normal[0], -normal[1]];
	return { normal: new Vector3(normal[0], normal[1], 0), penetration };
}

function compoundHit(hits: Array<{ normal: Vector3; penetration: number } | null>): { normal: Vector3; penetration: number } | null {
	return hits.filter((hit): hit is { normal: Vector3; penetration: number } => !!hit).sort((first, second) => first.penetration - second.penetration)[0] ?? null;
}

function collision(first: IBody2D, second: IBody2D): { normal: Vector3; penetration: number } | null {
	if (first.config.collider.shape === "circle" && second.config.collider.shape === "circle") {
		const dx = second.node.position.x - first.node.position.x;
		const dy = second.node.position.y - first.node.position.y;
		const distance = Math.hypot(dx, dy) || 0.0001;
		const radius = first.config.collider.radius + second.config.collider.radius;
		return distance < radius ? { normal: new Vector3(dx / distance, dy / distance, 0), penetration: radius - distance } : null;
	}
	if (first.config.collider.shape === "circle") return compoundHit(polygonPartsForBody(second).map((points) => circlePolygonHit(first, points)));
	if (second.config.collider.shape === "circle") {
		const result = compoundHit(polygonPartsForBody(first).map((points) => circlePolygonHit(second, points)));
		return result ? { ...result, normal: result.normal.scale(-1) } : null;
	}
	return compoundHit(polygonPartsForBody(first).flatMap((firstPoints) => polygonPartsForBody(second).map((secondPoints) => polygonHit(firstPoints, secondPoints))));
}

function resolveCollision(scene: Scene, first: IBody2D, second: IBody2D, hit: { normal: Vector3; penetration: number }): void {
	const firstDynamic = first.config.bodyType === "dynamic";
	const secondDynamic = second.config.bodyType === "dynamic";
	if (!firstDynamic && !secondDynamic) return;
	const total = (firstDynamic ? 1 : 0) + (secondDynamic ? 1 : 0);
	if (firstDynamic) first.node.position.subtractInPlace(hit.normal.scale(hit.penetration / total));
	if (secondDynamic) second.node.position.addInPlace(hit.normal.scale(hit.penetration / total));
	const firstMaterial = materialProperties(scene, first.config);
	const secondMaterial = materialProperties(scene, second.config);
	const restitution = (firstMaterial.restitution + secondMaterial.restitution) / 2;
	const relativeVelocity = second.velocity.subtract(first.velocity);
	const alongNormal = Vector3.Dot(relativeVelocity, hit.normal);
	if (alongNormal >= 0) return;
	const impulse = (-(1 + restitution) * alongNormal) / total;
	if (firstDynamic) first.velocity.subtractInPlace(hit.normal.scale(impulse));
	if (secondDynamic) second.velocity.addInPlace(hit.normal.scale(impulse));
	const tangent = relativeVelocity.subtract(hit.normal.scale(alongNormal));
	if (tangent.lengthSquared() < 0.0000001) return;
	tangent.normalize();
	const frictionImpulse = Math.max(
		-Math.abs(impulse) * Math.sqrt(firstMaterial.friction * secondMaterial.friction),
		Math.min(-Vector3.Dot(relativeVelocity, tangent) / total, Math.abs(impulse) * Math.sqrt(firstMaterial.friction * secondMaterial.friction))
	);
	if (firstDynamic) first.velocity.subtractInPlace(tangent.scale(frictionImpulse));
	if (secondDynamic) second.velocity.addInPlace(tangent.scale(frictionImpulse));
}
function resolveJoints(runtime: IRuntimePhysics2D, scene: Scene, step: number): void {
	for (const joint of joints(scene)) {
		const first = runtime.bodies.get(joint.firstNodeId),
			second = runtime.bodies.get(joint.secondNodeId);
		if (!first || !second) continue;
		const firstDynamic = first.config.bodyType === "dynamic",
			secondDynamic = second.config.bodyType === "dynamic",
			count = Number(firstDynamic) + Number(secondDynamic);
		if (!count) continue;
		if (joint.type === "hinge") {
			const firstAnchor = joint.firstAnchor ?? [0, 0];
			const secondAnchor = joint.secondAnchor ?? [0, 0];
			const correction = new Vector3(
				second.node.position.x + secondAnchor[0] - first.node.position.x - firstAnchor[0],
				second.node.position.y + secondAnchor[1] - first.node.position.y - firstAnchor[1],
				0
			);
			if (firstDynamic) first.node.position.addInPlace(correction.scale(1 / count));
			if (secondDynamic) second.node.position.subtractInPlace(correction.scale(1 / count));
			const referenceAngle = joint.referenceAngle ?? 0;
			if (joint.motorSpeed !== undefined) {
				const delta = Math.sign(joint.motorSpeed) * Math.min(Math.abs(joint.motorSpeed * step), (joint.maxMotorTorque ?? 10000) * step * step);
				if (firstDynamic) first.node.rotation.z -= delta / count;
				if (secondDynamic) second.node.rotation.z += delta / count;
			}
			const relativeAngle = second.node.rotation.z - first.node.rotation.z - referenceAngle;
			const targetAngle =
				joint.minAngle !== undefined && relativeAngle < joint.minAngle
					? joint.minAngle
					: joint.maxAngle !== undefined && relativeAngle > joint.maxAngle
						? joint.maxAngle
						: null;
			if (targetAngle !== null) {
				const angularCorrection = targetAngle - relativeAngle;
				if (firstDynamic) first.node.rotation.z -= angularCorrection / count;
				if (secondDynamic) second.node.rotation.z += angularCorrection / count;
			}
			continue;
		}
		const delta = second.node.position.subtract(first.node.position);
		const distance = Math.hypot(delta.x, delta.y) || 0.0001;
		const target = joint.distance;
		const correction = delta.scale((distance - target) / distance);
		if (firstDynamic) first.node.position.addInPlace(correction.scale(1 / count));
		if (secondDynamic) second.node.position.subtractInPlace(correction.scale(1 / count));
	}
}

function applyEffectors(runtime: IRuntimePhysics2D, scene: Scene, step: number): void {
	for (const effector of effectors(scene)) {
		if (effector.enabled === false) continue;
		let node: any;
		try {
			node = resolveBodyNode(scene, effector.nodeId);
		} catch {
			continue;
		}
		if (effector.type === "platform") continue;
		for (const body of runtime.bodies.values()) {
			if (body.config.enabled === false || body.config.bodyType !== "dynamic" || body.config.nodeId === effector.nodeId) continue;
			const delta = node.position.subtract(body.node.position);
			const distance = Math.hypot(delta.x, delta.y);
			if (distance > effector.radius) continue;
			if (effector.type === "surface") {
				if (!distance || Math.abs(distance - effector.radius) > (effector.surfaceThickness ?? 20) / 2) continue;
				body.velocity.x += (-delta.y / distance) * effector.force * step;
				body.velocity.y += (delta.x / distance) * effector.force * step;
				continue;
			}
			if (effector.type === "area") {
				const angle = ((effector.forceAngle ?? 0) * Math.PI) / 180;
				const strength = effector.force * Math.pow(1 - distance / effector.radius, effector.falloff);
				body.velocity.x += Math.cos(angle) * strength * step;
				body.velocity.y += Math.sin(angle) * strength * step;
				continue;
			}
			if (!distance) continue;
			const strength = effector.force * Math.pow(1 - distance / effector.radius, effector.falloff);
			body.velocity.x += (delta.x / distance) * strength * step;
			body.velocity.y += (delta.y / distance) * strength * step;
		}
	}
}

function allowsPlatformCollision(scene: Scene, first: IBody2D, second: IBody2D, hit: { normal: Vector3 }): boolean {
	for (const [platform, other, normal] of [
		[first, second, hit.normal],
		[second, first, hit.normal.scale(-1)],
	] as [IBody2D, IBody2D, Vector3][]) {
		const effector = effectors(scene).find((candidate) => candidate.nodeId === platform.config.nodeId && candidate.type === "platform" && candidate.enabled !== false);
		if (!effector) continue;
		const angle = ((effector.platformAngle ?? 90) * Math.PI) / 180;
		const outward = new Vector3(Math.cos(angle), Math.sin(angle), 0);
		if (Vector3.Dot(normal, outward) < Math.cos(Math.PI / 4) || (other.config.bodyType === "dynamic" && Vector3.Dot(other.velocity, outward) >= 0)) return false;
	}
	return true;
}

function startRuntime(scene: Scene): IRuntimePhysics2D {
	const existing = runtimes.get(scene);
	if (existing) return existing;
	const runtime: IRuntimePhysics2D = { bodies: new Map(), observer: null, collisions: 0, triggers: [] };
	runtime.observer = scene.onBeforeRenderObservable.add(() => {
		const step = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		if (!step) return;
		for (const body of runtime.bodies.values()) {
			if (body.config.enabled === false || body.config.bodyType !== "dynamic") continue;
			const gravity = body.config.gravity ?? [0, -981];
			const damping = Math.max(0, Math.min(0.999, body.config.linearDamping ?? 0));
			body.velocity.x = (body.velocity.x + gravity[0] * (body.config.gravityScale ?? 1) * step) * (1 - damping);
			body.velocity.y = (body.velocity.y + gravity[1] * (body.config.gravityScale ?? 1) * step) * (1 - damping);
		}
		applyEffectors(runtime, scene, step);
		for (const body of runtime.bodies.values()) {
			if (body.config.enabled === false || body.config.bodyType !== "dynamic") continue;
			body.node.position.x += body.velocity.x * step;
			body.node.position.y += body.velocity.y * step;
		}
		runtime.collisions = 0;
		runtime.triggers = [];
		const bodies = [...runtime.bodies.values()].filter((body) => body.config.enabled !== false);
		const iterations = Math.max(1, Math.min(16, settings(scene).solverIterations ?? 1));
		for (let iteration = 0; iteration < iterations; iteration++) {
			for (let first = 0; first < bodies.length; first++)
				for (let second = first + 1; second < bodies.length; second++) {
					const hit = collision(bodies[first], bodies[second]);
					if (!hit || !allowsPlatformCollision(scene, bodies[first], bodies[second], hit)) continue;
					if (bodies[first].config.isTrigger || bodies[second].config.isTrigger) {
						if (iteration === 0) runtime.triggers.push({ firstNodeId: bodies[first].config.nodeId, secondNodeId: bodies[second].config.nodeId });
						continue;
					}
					resolveCollision(scene, bodies[first], bodies[second], hit);
					if (iteration === 0) runtime.collisions++;
				}
			resolveJoints(runtime, scene, step / iterations);
		}
	});
	runtimes.set(scene, runtime);
	return runtime;
}

/** Lists persisted lightweight 2D distance/fixed/pivot-hinge joints. */
export function listPhysics2DJoints(scene: Scene): any {
	return { joints: structuredClone(joints(scene)) };
}
/** Creates a 2D distance, fixed, or pivot-hinge joint between already-authored 2D bodies. */
export function createPhysics2DJoint(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!configs(scene).some((body) => body.nodeId === data.firstNodeId) || !configs(scene).some((body) => body.nodeId === data.secondNodeId))
		throw new Error("Both joint nodes must have 2D physics bodies.");
	if (data.firstNodeId === data.secondNodeId) throw new Error("A 2D joint requires two different nodes.");
	const first = resolveBodyNode(scene, data.firstNodeId),
		second = resolveBodyNode(scene, data.secondNodeId);
	const type = data.type ?? "distance";
	if (!["distance", "fixed", "hinge"].includes(type)) throw new Error("2D joint type must be distance, fixed, or hinge.");
	const distance = data.distance ?? Vector3.Distance(first.position, second.position);
	if (!(distance >= 0)) throw new Error("Joint distance must be zero or greater.");
	const anchor = data.anchor ?? [(first.position.x + second.position.x) / 2, (first.position.y + second.position.y) / 2];
	if (!Array.isArray(anchor) || anchor.length !== 2 || !anchor.every(Number.isFinite)) throw new Error("2D hinge joint anchor must be a finite [x, y] point.");
	const value = {
		id: data.id ?? Tools.RandomId(),
		type,
		firstNodeId: data.firstNodeId,
		secondNodeId: data.secondNodeId,
		distance,
		...(type === "hinge"
			? {
					firstAnchor: [anchor[0] - first.position.x, anchor[1] - first.position.y],
					secondAnchor: [anchor[0] - second.position.x, anchor[1] - second.position.y],
					referenceAngle: second.rotation.z - first.rotation.z,
					minAngle: data.minAngle,
					maxAngle: data.maxAngle,
					motorSpeed: data.motorSpeed,
					maxMotorTorque: data.maxMotorTorque,
				}
			: {}),
	};
	if (type === "hinge" && data.minAngle !== undefined && data.maxAngle !== undefined && data.minAngle > data.maxAngle)
		throw new Error("2D hinge joint minAngle cannot exceed maxAngle.");
	if (type === "hinge" && data.motorSpeed !== undefined && !Number.isFinite(data.motorSpeed)) throw new Error("2D hinge motor speed must be finite.");
	if (type === "hinge" && data.maxMotorTorque !== undefined && (!(data.maxMotorTorque >= 0) || !Number.isFinite(data.maxMotorTorque)))
		throw new Error("2D hinge max motor torque must be a finite non-negative number.");
	if (joints(scene).some((joint) => joint.id === value.id)) throw new Error(`2D joint "${value.id}" already exists.`);
	joints(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return value;
}
/** Updates persisted distance/fixed/hinge joint settings, including optional hinge motor controls. */
export function setPhysics2DJoint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const joint = joints(scene).find((candidate) => candidate.id === data.id);
	if (!joint) throw new Error(`2D joint "${data.id}" was not found.`);
	if (data.distance !== undefined) joint.distance = data.distance;
	if (joint.type === "hinge") {
		for (const property of ["minAngle", "maxAngle", "motorSpeed", "maxMotorTorque"]) if (data[property] !== undefined) joint[property] = data[property];
		if (joint.minAngle !== undefined && joint.maxAngle !== undefined && joint.minAngle > joint.maxAngle) throw new Error("2D hinge joint minAngle cannot exceed maxAngle.");
		if (joint.motorSpeed !== undefined && !Number.isFinite(joint.motorSpeed)) throw new Error("2D hinge motor speed must be finite.");
		if (joint.maxMotorTorque !== undefined && (!(joint.maxMotorTorque >= 0) || !Number.isFinite(joint.maxMotorTorque)))
			throw new Error("2D hinge max motor torque must be a finite non-negative number.");
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(joint);
}
/** Removes a 2D joint while keeping bodies and nodes. */
export function deletePhysics2DJoint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = joints(scene).findIndex((joint) => joint.id === data.id);
	if (index === -1) throw new Error(`2D joint "${data.id}" was not found.`);
	joints(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

function attach(scene: Scene, config: any): IBody2D {
	const runtime = startRuntime(scene);
	const node = resolveBodyNode(scene, config.nodeId);
	const body = { config, node, velocity: Vector3.FromArray([...(config.velocity ?? [0, 0]), 0]) };
	runtime.bodies.set(config.nodeId, body);
	return body;
}

/** Restores persisted 2D body/collider definitions after scene nodes load. */
export function restorePhysics2D(scene: Scene): void {
	for (const config of configs(scene)) {
		if (startRuntime(scene).bodies.has(config.nodeId)) continue;
		try {
			attach(scene, config);
		} catch (error) {
			console.warn(`Failed to restore 2D physics body ${config.nodeId}:`, error);
		}
	}
}

/** Lists authored 2D bodies, colliders, current velocities, and collision count. */
export function listPhysics2D(scene: Scene): any {
	const runtime = runtimes.get(scene);
	return {
		bodies: structuredClone(configs(scene)).map((config) => ({
			...config,
			material: config.materialId ? structuredClone(findMaterial(scene, config.materialId)) : null,
			active: !!runtime?.bodies.has(config.nodeId),
			velocity: runtime?.bodies.get(config.nodeId)?.velocity.asArray().slice(0, 2) ?? config.velocity ?? [0, 0],
		})),
		collisions: runtime?.collisions ?? 0,
		triggers: structuredClone(runtime?.triggers ?? []),
		settings: structuredClone(settings(scene)),
	};
}

/** Reads persisted lightweight 2D solver settings. */
export function getPhysics2DSettings(scene: Scene): any {
	return structuredClone(settings(scene));
}
/** Updates persisted lightweight 2D solver settings used by preview and exported runtime. */
export function setPhysics2DSettings(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.solverIterations !== undefined) settings(scene).solverIterations = data.solverIterations;
	if (!Number.isInteger(settings(scene).solverIterations) || settings(scene).solverIterations < 1 || settings(scene).solverIterations > 16)
		throw new Error("2D solverIterations must be an integer from 1 to 16.");
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(settings(scene));
}

/** Lists node-bound Point, Area, and Surface effectors that accelerate nearby dynamic 2D bodies. */
export function listPhysics2DEffectors(scene: Scene): any {
	return { effectors: structuredClone(effectors(scene)) };
}
/** Creates a node-bound Point, directional Area, or tangential Surface effector. */
export function createPhysics2DEffector(scene: Scene, data: any, options: IMCPActionOptions): any {
	resolveBodyNode(scene, data.nodeId);
	const value = {
		id: data.id ?? Tools.RandomId(),
		nodeId: data.nodeId,
		type: data.type ?? "point",
		radius: data.radius ?? 100,
		force: data.force ?? 100,
		falloff: data.falloff ?? 1,
		forceAngle: data.forceAngle ?? 0,
		surfaceThickness: data.surfaceThickness ?? 20,
		platformAngle: data.platformAngle ?? 90,
		enabled: data.enabled ?? true,
	};
	if (
		!["point", "area", "surface", "platform"].includes(value.type) ||
		!(value.radius > 0) ||
		!(value.falloff >= 0) ||
		!(value.surfaceThickness > 0) ||
		!Number.isFinite(value.force) ||
		!Number.isFinite(value.forceAngle) ||
		!Number.isFinite(value.platformAngle)
	)
		throw new Error("2D effectors require type point/area/surface/platform, positive radius/thickness, non-negative falloff, and finite force/angles.");
	if (value.type === "platform" && configs(scene).find((body) => body.nodeId === value.nodeId)?.bodyType !== "static")
		throw new Error("2D Platform Effectors require a static 2D body on the same node.");
	if (effectors(scene).some((effector) => effector.id === value.id)) throw new Error(`2D effector "${value.id}" already exists.`);
	effectors(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Updates one 2D effector without recreating its scene-node attachment. */
export function setPhysics2DEffector(scene: Scene, data: any, options: IMCPActionOptions): any {
	const effector = effectors(scene).find((candidate) => candidate.id === data.id);
	if (!effector) throw new Error(`2D effector "${data.id}" was not found.`);
	if (data.nodeId !== undefined) resolveBodyNode(scene, data.nodeId);
	for (const property of ["nodeId", "type", "radius", "force", "falloff", "forceAngle", "surfaceThickness", "platformAngle", "enabled"])
		if (data[property] !== undefined) effector[property] = data[property];
	if (
		!["point", "area", "surface", "platform"].includes(effector.type ?? "point") ||
		!(effector.radius > 0) ||
		!(effector.falloff >= 0) ||
		!((effector.surfaceThickness ?? 20) > 0) ||
		!Number.isFinite(effector.force) ||
		!Number.isFinite(effector.forceAngle ?? 0) ||
		!Number.isFinite(effector.platformAngle ?? 90)
	)
		throw new Error("2D effectors require type point/area/surface/platform, positive radius/thickness, non-negative falloff, and finite force/angles.");
	if (effector.type === "platform" && configs(scene).find((body) => body.nodeId === effector.nodeId)?.bodyType !== "static")
		throw new Error("2D Platform Effectors require a static 2D body on the same node.");
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(effector);
}
/** Deletes an effector while keeping its scene node. */
export function deletePhysics2DEffector(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = effectors(scene).findIndex((effector) => effector.id === data.id);
	if (index === -1) throw new Error(`2D effector "${data.id}" was not found.`);
	effectors(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Lists reusable 2D physics materials with friction and restitution response. */
export function listPhysics2DMaterials(scene: Scene): any {
	return { materials: structuredClone(materials(scene)) };
}
/** Creates a reusable 2D physics material. */
export function createPhysics2DMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = { id: data.id ?? Tools.RandomId(), name: data.name, friction: data.friction ?? 0.4, restitution: data.restitution ?? 0 };
	if (!value.name?.trim()) throw new Error("2D physics materials require a name.");
	if (value.friction < 0 || value.friction > 1 || value.restitution < 0 || value.restitution > 1)
		throw new Error("2D physics material friction and restitution must be from 0 to 1.");
	if (materials(scene).some((material) => material.id === value.id || material.name === value.name)) throw new Error(`2D physics material "${value.name}" already exists.`);
	materials(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Updates a reusable 2D physics material. */
export function setPhysics2DMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = findMaterial(scene, data.id);
	if (data.name !== undefined) material.name = data.name;
	if (data.friction !== undefined) material.friction = data.friction;
	if (data.restitution !== undefined) material.restitution = data.restitution;
	if (!material.name?.trim() || material.friction < 0 || material.friction > 1 || material.restitution < 0 || material.restitution > 1)
		throw new Error("2D physics material requires a name and friction/restitution from 0 to 1.");
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(material);
}
/** Deletes an unused 2D physics material. Bodies must be reassigned first. */
export function deletePhysics2DMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = findMaterial(scene, data.id);
	if (configs(scene).some((config) => config.materialId === material.id)) throw new Error(`2D physics material "${material.name}" is assigned to one or more bodies.`);
	materials(scene).splice(materials(scene).indexOf(material), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Adds or replaces an authored 2D rigidbody and collider on a scene node. */
export function setPhysics2DBody(scene: Scene, data: any, options: IMCPActionOptions): any {
	resolveBodyNode(scene, data.nodeId);
	const existing = configs(scene).find((config) => config.nodeId === data.nodeId);
	const collider = structuredClone(data.collider ?? existing?.collider ?? { shape: "box", size: [100, 100] });
	if (collider.shape === "circle" && !(collider.radius > 0)) throw new Error("Circle colliders require a positive radius.");
	if (collider.shape === "box" && (!Array.isArray(collider.size) || collider.size.length !== 2 || collider.size.some((value: number) => value <= 0)))
		throw new Error("Box colliders require a positive [width, height] size.");
	if (collider.shape === "polygon") collider.parts = validatePolygon(collider.points);
	const materialId = data.materialId !== undefined ? data.materialId : existing?.materialId;
	if (materialId) findMaterial(scene, materialId);
	const config = {
		nodeId: data.nodeId,
		bodyType: data.bodyType ?? existing?.bodyType ?? "dynamic",
		collider,
		gravity: data.gravity ?? existing?.gravity ?? [0, -981],
		gravityScale: data.gravityScale ?? existing?.gravityScale ?? 1,
		linearDamping: data.linearDamping ?? existing?.linearDamping ?? 0,
		materialId,
		friction: data.friction ?? existing?.friction,
		restitution: data.restitution ?? existing?.restitution,
		velocity: data.velocity ?? existing?.velocity ?? [0, 0],
		isTrigger: data.isTrigger ?? existing?.isTrigger ?? false,
		enabled: data.enabled ?? existing?.enabled ?? true,
	};
	if (existing) configs(scene)[configs(scene).indexOf(existing)] = config;
	else configs(scene).push(config);
	attach(scene, config);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(config), active: true };
}

/** Generates a convex-hull or traced concave polygon collider from a raster image's opaque pixels. */
export async function generatePhysics2DPolygonCollider(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	resolveBodyNode(scene, data.nodeId);
	const absolutePath = resolveProjectImagePath(data.imagePath);
	if (!(await pathExists(absolutePath))) throw new Error(`Image asset not found: ${data.imagePath}`);
	const size = data.size ?? [100, 100];
	if (!Array.isArray(size) || size.length !== 2 || size.some((value: number) => !(value > 0) || !Number.isFinite(value)))
		throw new Error("size must be a positive [width, height] in centimeters.");
	const alphaThreshold = data.alphaThreshold ?? 1;
	if (!Number.isInteger(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 255) throw new Error("alphaThreshold must be an integer from 0 to 255.");
	const image = await sharp(absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const channels = image.info.channels ?? 4;
	const maxVertices = data.maxVertices ?? 32;
	if (!Number.isInteger(maxVertices) || maxVertices < 3 || maxVertices > 64) throw new Error("maxVertices must be an integer from 3 to 64.");
	const outline = data.outline ?? "convex";
	if (outline !== "convex" && outline !== "concave") throw new Error('outline must be either "convex" or "concave".');
	let stride = Math.max(1, Math.ceil(Math.max(image.info.width, image.info.height) / 256));
	let sourcePoints: IPoint2D[];
	if (outline === "concave") {
		while (true) {
			sourcePoints = traceLargestOpaqueOutline(image.data, image.info.width, image.info.height, channels, alphaThreshold, stride);
			if (sourcePoints.length <= maxVertices) break;
			if (stride >= Math.max(image.info.width, image.info.height))
				throw new Error(`Concave image outline exceeds the ${maxVertices}-vertex limit. Increase maxVertices or simplify the source image.`);
			stride *= 2;
		}
	} else {
		const opaque: IPoint2D[] = [];
		for (let y = 0; y < image.info.height; y += stride)
			for (let x = 0; x < image.info.width; x += stride) {
				const offset = (y * image.info.width + x) * channels;
				if (image.data[offset + 3] < alphaThreshold) continue;
				opaque.push(
					[x, y],
					[Math.min(image.info.width, x + stride), y],
					[Math.min(image.info.width, x + stride), Math.min(image.info.height, y + stride)],
					[x, Math.min(image.info.height, y + stride)]
				);
			}
		if (!opaque.length) throw new Error("Image contains no pixels at or above the requested alpha threshold.");
		sourcePoints = convexHull(opaque);
		if (sourcePoints.length < 3) throw new Error("Image alpha silhouette does not form a usable polygon collider.");
		sourcePoints = sourcePoints.filter((_point, index) => index % Math.ceil(sourcePoints.length / maxVertices) === 0);
	}
	const points = sourcePoints.map(([x, y]) => [(x / image.info.width - 0.5) * size[0], (0.5 - y / image.info.height) * size[1]]);
	const body = setPhysics2DBody(scene, { nodeId: data.nodeId, collider: { shape: "polygon", points } }, options);
	return {
		...body,
		sourceImagePath: relative(dirname(projectConfiguration.path!), absolutePath),
		sourceImageSize: [image.info.width, image.info.height],
		outline,
		sampledVertexCount: sourcePoints.length,
		sampleStride: stride,
	};
}

/** Removes the authored 2D body/collider without deleting the underlying scene node. */
export function removePhysics2DBody(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = configs(scene).findIndex((config) => config.nodeId === data.nodeId);
	if (index === -1) throw new Error(`No 2D physics body is attached to node "${data.nodeId}".`);
	configs(scene).splice(index, 1);
	runtimes.get(scene)?.bodies.delete(data.nodeId);
	options.editor.layout.inspector.forceUpdate();
	return { removed: true, nodeId: data.nodeId };
}
