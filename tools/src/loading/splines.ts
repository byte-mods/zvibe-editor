import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

export type ISplineFollower = {
	splineId: string;
	speed: number;
	t: number;
	loop: boolean;
	orientToPath: boolean;
};

type ITransformNode = Node & {
	position: Vector3;
	rotation: Vector3;
	rotationQuaternion?: unknown;
	setAbsolutePosition?: (position: Vector3) => void;
};

type IBezierKnot = { position: number[]; inTangent: number[]; outTangent: number[] };

function evaluateBezier(start: IBezierKnot, end: IBezierKnot, t: number): Vector3 {
	const p0 = Vector3.FromArray(start.position),
		p1 = p0.add(Vector3.FromArray(start.outTangent));
	const p3 = Vector3.FromArray(end.position),
		p2 = p3.add(Vector3.FromArray(end.inTangent));
	const inverse = 1 - t;
	return p0
		.scale(inverse * inverse * inverse)
		.add(p1.scale(3 * inverse * inverse * t))
		.add(p2.scale(3 * inverse * t * t))
		.add(p3.scale(t * t * t));
}

function splinePath(spline: any): Vector3[] | null {
	const knots = spline.metadata?.knots as IBezierKnot[] | undefined;
	if (!Array.isArray(knots)) {
		const sourcePoints = spline.metadata?.points;
		if (!Array.isArray(sourcePoints) || sourcePoints.length < 2) return null;
		const points = sourcePoints.map((point: number[]) => Vector3.FromArray(point));
		if (spline.metadata?.closed) points.push(points[0].clone());
		return points;
	}
	if (knots.length < 2) return null;
	const points: Vector3[] = [];
	const segmentCount = spline.metadata?.closed ? knots.length : knots.length - 1;
	for (let segment = 0; segment < segmentCount; segment++) {
		for (let step = 0; step < 12; step++) points.push(evaluateBezier(knots[segment], knots[(segment + 1) % knots.length], step / 12));
	}
	points.push(Vector3.FromArray((spline.metadata?.closed ? knots[0] : knots[knots.length - 1]).position));
	return points;
}

function evaluateSpline(spline: any, t: number): { position: Vector3; tangent: Vector3; length: number } | null {
	const points = splinePath(spline);
	if (!points || points.length < 2) return null;
	const lengths = points.slice(0, -1).map((point: Vector3, index: number) => Vector3.Distance(point, points[index + 1]));
	const length = lengths.reduce((total: number, value: number) => total + value, 0);
	if (!length) return null;
	let remaining = Math.min(1, Math.max(0, t)) * length;
	for (let index = 0; index < lengths.length; index++) {
		if (remaining <= lengths[index] || index === lengths.length - 1) {
			const amount = lengths[index] ? remaining / lengths[index] : 0;
			return { position: Vector3.Lerp(points[index], points[index + 1], amount), tangent: points[index + 1].subtract(points[index]).normalize(), length };
		}
		remaining -= lengths[index];
	}
	return null;
}

/** Restores persisted spline-follower components and advances them before each rendered frame. */
export function configureSplineFollowers(scene: Scene): void {
	const followers = scene.getNodes().filter((node) => (node as any).metadata?.babylonEditorSplineFollower) as ITransformNode[];
	if (!followers.length) return;
	scene.onBeforeRenderObservable.add(() => {
		const elapsedSeconds = scene.getEngine().getDeltaTime() / 1000;
		for (const follower of followers) {
			const configuration = follower.metadata?.babylonEditorSplineFollower as ISplineFollower | undefined;
			if (!configuration || !(configuration.speed >= 0)) continue;
			const spline = scene.getNodeById(configuration.splineId);
			const sample = spline && evaluateSpline(spline, configuration.t);
			if (!sample) continue;
			const delta = (configuration.speed * elapsedSeconds) / sample.length;
			configuration.t = configuration.loop ? (configuration.t + delta) % 1 : Math.min(1, configuration.t + delta);
			const current = evaluateSpline(spline, configuration.t);
			if (!current) continue;
			const worldPosition = Vector3.TransformCoordinates(current.position, (spline as any).getWorldMatrix());
			if (follower.setAbsolutePosition) follower.setAbsolutePosition(worldPosition);
			else follower.position.copyFrom(worldPosition);
			if (configuration.orientToPath) {
				const worldTangent = Vector3.TransformNormal(current.tangent, (spline as any).getWorldMatrix()).normalize();
				follower.rotationQuaternion = null;
				follower.rotation.y = Math.atan2(worldTangent.x, worldTangent.z);
			}
		}
	});
}
