import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";

import { IClothTriangleCollider, IClothTriangleCollisionDiagnostics, MaxClothTriangleCandidatesPerStep, MaxClothTrianglesPerCollider } from "./cloth-types";

interface IColliderTriangle {
	a: Vector3;
	b: Vector3;
	c: Vector3;
	normal: Vector3;
	minimum: Vector3;
	maximum: Vector3;
}

interface ITriangleTree {
	minimum: Vector3;
	maximum: Vector3;
	left?: ITriangleTree;
	right?: ITriangleTree;
	triangles?: IColliderTriangle[];
}

export interface IClothTriangleCollisionRequest {
	scene: Scene;
	clothMesh: Mesh;
	positions: Float32Array | number[];
	velocities: Float32Array;
	pinned: Set<number>;
	configurations: IClothTriangleCollider[] | undefined;
	step: number;
}

function overlaps(minimumA: Vector3, maximumA: Vector3, minimumB: Vector3, maximumB: Vector3): boolean {
	return minimumA.x <= maximumB.x && maximumA.x >= minimumB.x && minimumA.y <= maximumB.y && maximumA.y >= minimumB.y && minimumA.z <= maximumB.z && maximumA.z >= minimumB.z;
}

function buildTree(triangles: IColliderTriangle[], depth = 0): ITriangleTree {
	const minimum = triangles.reduce((value, triangle) => Vector3.Minimize(value, triangle.minimum), triangles[0].minimum.clone());
	const maximum = triangles.reduce((value, triangle) => Vector3.Maximize(value, triangle.maximum), triangles[0].maximum.clone());
	if (triangles.length <= 8 || depth >= 16) {
		return { minimum, maximum, triangles };
	}
	const size = maximum.subtract(minimum);
	const axis = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
	const sorted = [...triangles].sort((first, second) => (first.minimum[axis] + first.maximum[axis]) * 0.5 - (second.minimum[axis] + second.maximum[axis]) * 0.5);
	const middle = Math.floor(sorted.length / 2);
	return { minimum, maximum, left: buildTree(sorted.slice(0, middle), depth + 1), right: buildTree(sorted.slice(middle), depth + 1) };
}

function collectTriangles(mesh: Mesh, inverseClothWorld: Matrix): IColliderTriangle[] | null {
	const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
	if (!positions || positions.length < 9 || positions.length % 3 !== 0 || positions.some((value) => !Number.isFinite(value))) {
		return null;
	}
	const indices = mesh.getIndices() ?? Array.from({ length: positions.length / 3 }, (_, index) => index);
	if (
		indices.length < 3 ||
		indices.length % 3 !== 0 ||
		indices.length / 3 > MaxClothTrianglesPerCollider ||
		indices.some((vertexIndex) => !Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= positions.length / 3)
	) {
		return null;
	}
	const world = mesh.computeWorldMatrix(true);
	const localPositions: Vector3[] = [];
	for (let index = 0; index < positions.length; index += 3) {
		const worldPoint = Vector3.TransformCoordinates(Vector3.FromArray(positions, index), world);
		localPositions.push(Vector3.TransformCoordinates(worldPoint, inverseClothWorld));
	}
	const triangles: IColliderTriangle[] = [];
	for (let index = 0; index < indices.length; index += 3) {
		const a = localPositions[indices[index]];
		const b = localPositions[indices[index + 1]];
		const c = localPositions[indices[index + 2]];
		if (!a || !b || !c) {
			return null;
		}
		const normal = Vector3.Cross(b.subtract(a), c.subtract(a));
		if (normal.lengthSquared() < 0.0000000001) {
			continue;
		}
		normal.normalize();
		triangles.push({
			a,
			b,
			c,
			normal,
			minimum: Vector3.Minimize(a, Vector3.Minimize(b, c)),
			maximum: Vector3.Maximize(a, Vector3.Maximize(b, c)),
		});
	}
	return triangles.length ? triangles : null;
}

function segmentTriangle(start: Vector3, end: Vector3, triangle: IColliderTriangle): { point: Vector3; normal: Vector3; time: number } | null {
	const direction = end.subtract(start);
	const edge1 = triangle.b.subtract(triangle.a);
	const edge2 = triangle.c.subtract(triangle.a);
	const p = Vector3.Cross(direction, edge2);
	const determinant = Vector3.Dot(edge1, p);
	if (Math.abs(determinant) < 0.00000001) {
		return null;
	}
	const inverse = 1 / determinant;
	const offset = start.subtract(triangle.a);
	const u = Vector3.Dot(offset, p) * inverse;
	if (u < 0 || u > 1) {
		return null;
	}
	const q = Vector3.Cross(offset, edge1);
	const v = Vector3.Dot(direction, q) * inverse;
	if (v < 0 || u + v > 1) {
		return null;
	}
	const time = Vector3.Dot(edge2, q) * inverse;
	if (time < 0 || time > 1) {
		return null;
	}
	const normal = Vector3.Dot(direction, triangle.normal) <= 0 ? triangle.normal.clone() : triangle.normal.scale(-1);
	return { point: start.add(direction.scale(time)), normal, time };
}

function queryTree(tree: ITriangleTree, minimum: Vector3, maximum: Vector3, result: IColliderTriangle[]): void {
	if (!overlaps(tree.minimum, tree.maximum, minimum, maximum)) {
		return;
	}
	if (tree.triangles) {
		for (const triangle of tree.triangles) {
			if (overlaps(triangle.minimum, triangle.maximum, minimum, maximum)) {
				result.push(triangle);
			}
		}
		return;
	}
	if (tree.left) {
		queryTree(tree.left, minimum, maximum, result);
	}
	if (tree.right) {
		queryTree(tree.right, minimum, maximum, result);
	}
}

function applyVelocityResponse(velocities: Float32Array, offset: number, normal: Vector3, restitution: number, friction: number): void {
	const velocity = Vector3.FromArray(velocities, offset);
	const normalVelocity = Vector3.Dot(velocity, normal);
	const tangent = velocity.subtract(normal.scale(normalVelocity)).scale(1 - friction);
	const reflectedNormal = normal.scale(normalVelocity < 0 ? -normalVelocity * restitution : normalVelocity);
	const resolved = tangent.add(reflectedNormal);
	velocities[offset] = resolved.x;
	velocities[offset + 1] = resolved.y;
	velocities[offset + 2] = resolved.z;
}

/** Resolves swept cloth vertices against current transformed triangle geometry using a bounded BVH query. */
export function resolveClothTriangleCollisions(request: IClothTriangleCollisionRequest): IClothTriangleCollisionDiagnostics {
	const { scene, clothMesh, positions, velocities, pinned, configurations, step } = request;
	const diagnostics: IClothTriangleCollisionDiagnostics = {
		configuredColliders: configurations?.length ?? 0,
		activeColliders: 0,
		skippedColliders: 0,
		triangles: 0,
		candidateTests: 0,
		contacts: 0,
		workTruncated: false,
	};
	if (!configurations?.length) {
		return diagnostics;
	}
	const inverseClothWorld = Matrix.Invert(clothMesh.computeWorldMatrix(true));
	for (const configuration of configurations) {
		const thickness = configuration.thickness ?? 2;
		const restitution = configuration.restitution ?? 0;
		const friction = configuration.friction ?? 0.2;
		if (
			!Number.isFinite(thickness) ||
			thickness <= 0 ||
			thickness > 1000 ||
			!Number.isFinite(restitution) ||
			restitution < 0 ||
			restitution > 1 ||
			!Number.isFinite(friction) ||
			friction < 0 ||
			friction > 1
		) {
			diagnostics.skippedColliders++;
			continue;
		}
		const mesh = scene.getMeshById(configuration.meshId) as Mesh | null;
		const triangles = mesh && mesh !== clothMesh ? collectTriangles(mesh, inverseClothWorld) : null;
		if (!mesh || !triangles) {
			diagnostics.skippedColliders++;
			continue;
		}
		diagnostics.activeColliders++;
		diagnostics.triangles += triangles.length;
		const tree = buildTree(triangles);
		for (let vertexIndex = 0; vertexIndex < positions.length / 3; vertexIndex++) {
			if (pinned.has(vertexIndex)) {
				continue;
			}
			const offset = vertexIndex * 3;
			const end = Vector3.FromArray(positions, offset);
			const start = end.subtract(Vector3.FromArray(velocities, offset).scale(step));
			const padding = new Vector3(thickness, thickness, thickness);
			const minimum = Vector3.Minimize(start, end).subtract(padding);
			const maximum = Vector3.Maximize(start, end).add(padding);
			const candidates: IColliderTriangle[] = [];
			queryTree(tree, minimum, maximum, candidates);
			let best: { point: Vector3; normal: Vector3; distance: number } | null = null;
			for (const triangle of candidates) {
				if (diagnostics.candidateTests >= MaxClothTriangleCandidatesPerStep) {
					diagnostics.workTruncated = true;
					break;
				}
				diagnostics.candidateTests++;
				const swept = segmentTriangle(start, end, triangle);
				if (swept && (!best || swept.time < best.distance)) {
					best = { point: swept.point.add(swept.normal.scale(thickness)), normal: swept.normal, distance: swept.time };
					continue;
				}
				const projected = Vector3.Zero();
				const distance = Vector3.ProjectOnTriangleToRef(end, triangle.a, triangle.b, triangle.c, projected);
				if (distance >= thickness || (best && (best.distance <= 1 || 1 + distance >= best.distance))) {
					continue;
				}
				let normal = end.subtract(projected);
				if (normal.lengthSquared() < 0.0000000001) {
					normal = Vector3.Dot(Vector3.FromArray(velocities, offset), triangle.normal) <= 0 ? triangle.normal.clone() : triangle.normal.scale(-1);
				} else {
					normal.normalize();
				}
				best = { point: projected.add(normal.scale(thickness)), normal, distance: 1 + distance };
			}
			if (best) {
				positions[offset] = best.point.x;
				positions[offset + 1] = best.point.y;
				positions[offset + 2] = best.point.z;
				applyVelocityResponse(velocities, offset, best.normal, restitution, friction);
				diagnostics.contacts++;
			}
			if (diagnostics.workTruncated) {
				break;
			}
		}
		if (diagnostics.workTruncated) {
			break;
		}
	}
	return diagnostics;
}
