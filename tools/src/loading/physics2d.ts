import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observable } from "@babylonjs/core/Misc/observable";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

type IRuntimeBody = { config: any; node: TransformNode; velocity: Vector3 };

export interface IPhysics2DTriggerEvent {
	firstNodeId: string;
	secondNodeId: string;
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		onPhysics2DTriggerObservable?: Observable<IPhysics2DTriggerEvent>;
		physics2DTriggerEvents?: IPhysics2DTriggerEvent[];
	}
}

type IPoint2D = [number, number];

function polygonPartsForBody(body: IRuntimeBody): IPoint2D[][] {
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
function circlePolygonHit(circle: IRuntimeBody, points: IPoint2D[]): { normal: Vector3; penetration: number } | null {
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
	return hits.filter((result): result is { normal: Vector3; penetration: number } => !!result).sort((first, second) => first.penetration - second.penetration)[0] ?? null;
}
function hit(first: IRuntimeBody, second: IRuntimeBody): { normal: Vector3; penetration: number } | null {
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
function properties(config: any, materials: Map<string, any>): { friction: number; restitution: number } {
	const material = config.materialId ? materials.get(config.materialId) : null;
	return { friction: config.friction ?? material?.friction ?? 0, restitution: config.restitution ?? material?.restitution ?? 0 };
}
function resolve(first: IRuntimeBody, second: IRuntimeBody, result: { normal: Vector3; penetration: number }, materials: Map<string, any>): void {
	const firstDynamic = first.config.bodyType === "dynamic",
		secondDynamic = second.config.bodyType === "dynamic",
		count = (firstDynamic ? 1 : 0) + (secondDynamic ? 1 : 0);
	if (!count) return;
	if (firstDynamic) first.node.position.subtractInPlace(result.normal.scale(result.penetration / count));
	if (secondDynamic) second.node.position.addInPlace(result.normal.scale(result.penetration / count));
	const alongNormal = Vector3.Dot(second.velocity.subtract(first.velocity), result.normal);
	if (alongNormal >= 0) return;
	const firstProperties = properties(first.config, materials),
		secondProperties = properties(second.config, materials);
	const impulse = (-(1 + (firstProperties.restitution + secondProperties.restitution) / 2) * alongNormal) / count;
	if (firstDynamic) first.velocity.subtractInPlace(result.normal.scale(impulse));
	if (secondDynamic) second.velocity.addInPlace(result.normal.scale(impulse));
	const tangent = second.velocity.subtract(first.velocity).subtract(result.normal.scale(alongNormal));
	if (tangent.lengthSquared() < 0.0000001) return;
	tangent.normalize();
	const maximum = Math.abs(impulse) * Math.sqrt(firstProperties.friction * secondProperties.friction);
	const frictionImpulse = Math.max(-maximum, Math.min(-Vector3.Dot(second.velocity.subtract(first.velocity), tangent) / count, maximum));
	if (firstDynamic) first.velocity.subtractInPlace(tangent.scale(frictionImpulse));
	if (secondDynamic) second.velocity.addInPlace(tangent.scale(frictionImpulse));
}

function applyEffectors(bodies: IRuntimeBody[], scene: Scene, effectors: any[], step: number): void {
	for (const effector of effectors) {
		if (effector.enabled === false) continue;
		const node = scene.getNodeById(effector.nodeId);
		if (!(node instanceof TransformNode)) continue;
		if (effector.type === "platform") continue;
		for (const body of bodies) {
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

function allowsPlatformCollision(first: IRuntimeBody, second: IRuntimeBody, result: { normal: Vector3 }, effectors: any[]): boolean {
	for (const [platform, other, normal] of [
		[first, second, result.normal],
		[second, first, result.normal.scale(-1)],
	] as [IRuntimeBody, IRuntimeBody, Vector3][]) {
		const effector = effectors.find((candidate) => candidate.nodeId === platform.config.nodeId && candidate.type === "platform" && candidate.enabled !== false);
		if (!effector) continue;
		const angle = ((effector.platformAngle ?? 90) * Math.PI) / 180;
		const outward = new Vector3(Math.cos(angle), Math.sin(angle), 0);
		if (Vector3.Dot(normal, outward) < Math.cos(Math.PI / 4) || (other.config.bodyType === "dynamic" && Vector3.Dot(other.velocity, outward) >= 0)) return false;
	}
	return true;
}

/** Recreates editor-authored 2D rigidbody/collider simulation in generated projects. */
export function configurePhysics2D(scene: Scene): void {
	const configs = scene.metadata?.babylonEditorPhysics2D;
	if (!Array.isArray(configs)) return;
	const bodies = configs.flatMap((config) => {
		const node = scene.getNodeById(config.nodeId);
		return node instanceof TransformNode ? [{ config, node, velocity: Vector3.FromArray([...(config.velocity ?? [0, 0]), 0]) }] : [];
	});
	const joints = scene.metadata?.babylonEditorPhysics2DJoints ?? [];
	const solverIterations = Math.max(1, Math.min(16, scene.metadata?.babylonEditorPhysics2DSettings?.solverIterations ?? 1));
	const effectors = scene.metadata?.babylonEditorPhysics2DEffectors ?? [];
	const materials = new Map<string, any>((scene.metadata?.babylonEditorPhysics2DMaterials ?? []).map((material: any): [string, any] => [material.id, material]));
	scene.onPhysics2DTriggerObservable ??= new Observable<IPhysics2DTriggerEvent>();
	scene.onBeforeRenderObservable.add(() => {
		scene.physics2DTriggerEvents = [];
		const step = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		const solverStep = step / solverIterations;
		if (!step) return;
		for (const body of bodies)
			if (body.config.enabled !== false && body.config.bodyType === "dynamic") {
				const gravity = body.config.gravity ?? [0, -981],
					damping = Math.max(0, Math.min(0.999, body.config.linearDamping ?? 0));
				body.velocity.x = (body.velocity.x + gravity[0] * (body.config.gravityScale ?? 1) * step) * (1 - damping);
				body.velocity.y = (body.velocity.y + gravity[1] * (body.config.gravityScale ?? 1) * step) * (1 - damping);
			}
		applyEffectors(bodies, scene, effectors, step);
		for (const body of bodies)
			if (body.config.enabled !== false && body.config.bodyType === "dynamic") {
				body.node.position.x += body.velocity.x * step;
				body.node.position.y += body.velocity.y * step;
			}
		for (let iteration = 0; iteration < solverIterations; iteration++) {
			for (let first = 0; first < bodies.length; first++)
				for (let second = first + 1; second < bodies.length; second++) {
					if (bodies[first].config.enabled === false || bodies[second].config.enabled === false) continue;
					const result = hit(bodies[first], bodies[second]);
					if (!result || !allowsPlatformCollision(bodies[first], bodies[second], result, effectors)) continue;
					if (bodies[first].config.isTrigger || bodies[second].config.isTrigger) {
						if (iteration === 0) {
							const event = { firstNodeId: bodies[first].config.nodeId, secondNodeId: bodies[second].config.nodeId };
							scene.physics2DTriggerEvents.push(event);
							scene.onPhysics2DTriggerObservable?.notifyObservers(event);
						}
						continue;
					}
					resolve(bodies[first], bodies[second], result, materials);
				}
			for (const joint of joints) {
				const first = bodies.find((body) => body.config.nodeId === joint.firstNodeId),
					second = bodies.find((body) => body.config.nodeId === joint.secondNodeId);
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
						const delta = Math.sign(joint.motorSpeed) * Math.min(Math.abs(joint.motorSpeed * solverStep), (joint.maxMotorTorque ?? 10000) * solverStep * solverStep);
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
				const delta = second.node.position.subtract(first.node.position),
					distance = Math.hypot(delta.x, delta.y) || 0.0001,
					correction = delta.scale((distance - joint.distance) / distance);
				if (firstDynamic) first.node.position.addInPlace(correction.scale(1 / count));
				if (secondDynamic) second.node.position.subtractInPlace(correction.scale(1 / count));
			}
		}
	});
}
