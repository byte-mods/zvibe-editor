import type { IPhysics2DBodyConfiguration } from "./physics2d-types";
import type { IPhysics2DPoint } from "./physics2d-polygons";

/** Solver-ready scalar mass properties; inverse values are zero for bodies that cannot respond. */
export interface IPhysics2DMassProperties {
	mass: number;
	inverseMass: number;
	centerOfMass: IPhysics2DPoint;
	inertia: number;
	inverseInertia: number;
}

/** Area moments are density-independent so custom and automatic mass share one geometry pass. */
interface IShapeMoments {
	area: number;
	center: IPhysics2DPoint;
	polarMoment: number;
}

/** Accumulates signed polygon area, centroid, and polar area moment in local centimeters. */
function polygonMoments(parts: IPhysics2DPoint[][]): IShapeMoments {
	const moments: IShapeMoments[] = [];
	for (const points of parts) {
		let area = 0;
		let centerX = 0;
		let centerY = 0;
		let polarMoment = 0;
		for (let index = 0; index < points.length; index++) {
			const [x, y] = points[index];
			const [nextX, nextY] = points[(index + 1) % points.length];
			const cross = x * nextY - nextX * y;
			area += cross / 2;
			centerX += (x + nextX) * cross;
			centerY += (y + nextY) * cross;
			polarMoment += cross * (x * x + x * nextX + nextX * nextX + y * y + y * nextY + nextY * nextY);
		}
		if (Math.abs(area) < 0.000001) {
			continue;
		}
		const sign = Math.sign(area);
		const center: IPhysics2DPoint = [centerX / (6 * area), centerY / (6 * area)];
		const magnitude = Math.abs(area);
		const originMoment = (polarMoment / 12) * sign;
		moments.push({ area: magnitude, center, polarMoment: Math.max(0, originMoment - magnitude * (center[0] * center[0] + center[1] * center[1])) });
	}
	return combineMoments(moments);
}

/** Uses the exact planar stadium formula so capsule inertia is independent of tessellation. */
function capsuleMoments(size: IPhysics2DPoint, offset: IPhysics2DPoint): IShapeMoments {
	const radius = Math.min(size[0], size[1]) / 2;
	const length = Math.max(size[0], size[1]) - radius * 2;
	const rectangleArea = radius * 2 * length;
	const circleArea = Math.PI * radius * radius;
	const rectangleMoment = (rectangleArea * (radius * radius * 4 + length * length)) / 12;
	const capsMoment = (Math.PI * radius ** 4) / 2 + (Math.PI * radius * radius * length * length) / 4 + (4 * length * radius ** 3) / 3;
	return { area: rectangleArea + circleArea, center: offset, polarMoment: rectangleMoment + capsMoment };
}

/** Combines independent pieces around their shared centroid using the parallel-axis theorem. */
function combineMoments(parts: IShapeMoments[]): IShapeMoments {
	const area = parts.reduce((total, part) => total + part.area, 0);
	if (area <= 0) {
		return { area: 0, center: [0, 0], polarMoment: 0 };
	}
	const center: IPhysics2DPoint = [
		parts.reduce((total, part) => total + part.center[0] * part.area, 0) / area,
		parts.reduce((total, part) => total + part.center[1] * part.area, 0) / area,
	];
	const polarMoment = parts.reduce((total, part) => total + part.polarMoment + part.area * ((part.center[0] - center[0]) ** 2 + (part.center[1] - center[1]) ** 2), 0);
	return { area, center, polarMoment };
}

/** Derives collider-area moments before body mass and custom center/inertia overrides are applied. */
function shapeMoments(config: IPhysics2DBodyConfiguration): IShapeMoments {
	const { collider } = config;
	if (collider.shape === "circle") {
		const radius = collider.radius!;
		const area = Math.PI * radius * radius;
		return { area, center: collider.offset, polarMoment: (area * radius * radius) / 2 };
	}
	if (collider.shape === "box") {
		const [width, height] = collider.size!;
		const area = width * height;
		return { area, center: collider.offset, polarMoment: (area * (width * width + height * height)) / 12 };
	}
	if (collider.shape === "capsule") {
		return capsuleMoments(collider.size!, collider.offset);
	}
	if (collider.shape === "edge" && !collider.parts?.length && collider.edgeRadius! > 0) {
		return combineMoments(
			collider.points!.slice(0, -1).map((first, index) => {
				const second = collider.points![index + 1];
				const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
				return capsuleMoments(
					[collider.edgeRadius! * 2, length + collider.edgeRadius! * 2],
					[(first[0] + second[0]) / 2 + collider.offset[0], (first[1] + second[1]) / 2 + collider.offset[1]]
				);
			})
		);
	}
	const parts = collider.parts ?? (collider.points && collider.points.length >= 3 ? [collider.points] : []);
	const result = polygonMoments(parts);
	return { ...result, center: [result.center[0] + collider.offset[0], result.center[1] + collider.offset[1]] };
}

/** Computes finite response quantities using kg, cm, seconds, and kg·cm². */
export function computePhysics2DMassProperties(config: IPhysics2DBodyConfiguration): IPhysics2DMassProperties {
	const shape = shapeMoments(config);
	const mass = config.useAutoMass ? Math.max(0.001, Math.min(1_000_000_000, shape.area * config.collider.density)) : config.mass;
	const centerOfMass = config.useAutoCenterOfMass && shape.area > 0 ? shape.center : config.centerOfMass;
	const displacementX = shape.center[0] - centerOfMass[0];
	const displacementY = shape.center[1] - centerOfMass[1];
	const automaticInertia = shape.area > 0 ? (shape.polarMoment / shape.area + displacementX * displacementX + displacementY * displacementY) * mass : mass;
	const inertia = config.useAutoInertia ? Math.max(0.001, Math.min(1_000_000_000_000, automaticInertia)) : config.inertia;
	const dynamic = config.bodyType === "dynamic" && config.enabled;
	return {
		mass,
		inverseMass: dynamic ? 1 / mass : 0,
		centerOfMass: [...centerOfMass],
		inertia,
		inverseInertia: dynamic && !config.freezeRotation ? 1 / inertia : 0,
	};
}
