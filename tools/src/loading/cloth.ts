import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Matrix } from "@babylonjs/core/Maths/math.vector";

type IRuntimeCloth = { initialPositions: Float32Array; velocities: Float32Array; springs: Array<[number, number, number]>; mesh: Mesh };

function buildSprings(initialPositions: Float32Array, subdivisions: number): Array<[number, number, number]> {
	const columns = subdivisions + 1;
	const springs: Array<[number, number, number]> = [];
	const distance = (first: number, second: number): number => {
		const a = first * 3;
		const b = second * 3;
		return Math.hypot(initialPositions[a] - initialPositions[b], initialPositions[a + 1] - initialPositions[b + 1], initialPositions[a + 2] - initialPositions[b + 2]);
	};
	const add = (first: number, second: number): void => {
		springs.push([first, second, distance(first, second)]);
	};
	for (let row = 0; row <= subdivisions; row++)
		for (let column = 0; column <= subdivisions; column++) {
			const index = row * columns + column;
			if (column < subdivisions) add(index, index + 1);
			if (row < subdivisions) add(index, index + columns);
			if (row < subdivisions && column < subdivisions) add(index, index + columns + 1);
			if (row < subdivisions && column > 0) add(index, index + columns - 1);
		}
	return springs;
}

function resolvePlaneCollision(positions: any, velocities: Float32Array, pinned: Set<number>, plane: any): void {
	if (!plane) return;
	const normal = Vector3.FromArray(plane.normal ?? [0, 1, 0]);
	if (normal.lengthSquared() < 0.0000001) return;
	normal.normalize();
	const offset = plane.offset ?? 0;
	const restitution = Math.max(0, Math.min(1, plane.restitution ?? 0));
	for (let index = 0; index < positions.length / 3; index++) {
		if (pinned.has(index)) continue;
		const positionOffset = index * 3;
		const distance = positions[positionOffset] * normal.x + positions[positionOffset + 1] * normal.y + positions[positionOffset + 2] * normal.z - offset;
		if (distance >= 0) continue;
		positions[positionOffset] -= normal.x * distance;
		positions[positionOffset + 1] -= normal.y * distance;
		positions[positionOffset + 2] -= normal.z * distance;
		const normalVelocity = velocities[positionOffset] * normal.x + velocities[positionOffset + 1] * normal.y + velocities[positionOffset + 2] * normal.z;
		if (normalVelocity < 0) {
			velocities[positionOffset] -= normal.x * normalVelocity * (1 + restitution);
			velocities[positionOffset + 1] -= normal.y * normalVelocity * (1 + restitution);
			velocities[positionOffset + 2] -= normal.z * normalVelocity * (1 + restitution);
		}
	}
}

function resolveSphereCollisions(positions: any, velocities: Float32Array, pinned: Set<number>, spheres: any): void {
	for (const sphere of spheres ?? []) {
		const center = sphere.center;
		const radius = sphere.radius;
		const restitution = sphere.restitution ?? 0;
		for (let index = 0; index < positions.length / 3; index++) {
			if (pinned.has(index)) continue;
			const offset = index * 3;
			let x = positions[offset] - center[0];
			let y = positions[offset + 1] - center[1];
			let z = positions[offset + 2] - center[2];
			let length = Math.hypot(x, y, z);
			if (length >= radius) continue;
			if (length < 0.000001) {
				x = 0;
				y = 1;
				z = 0;
				length = 1;
			}
			x /= length;
			y /= length;
			z /= length;
			positions[offset] = center[0] + x * radius;
			positions[offset + 1] = center[1] + y * radius;
			positions[offset + 2] = center[2] + z * radius;
			const normalVelocity = velocities[offset] * x + velocities[offset + 1] * y + velocities[offset + 2] * z;
			if (normalVelocity < 0) {
				velocities[offset] -= x * normalVelocity * (1 + restitution);
				velocities[offset + 1] -= y * normalVelocity * (1 + restitution);
				velocities[offset + 2] -= z * normalVelocity * (1 + restitution);
			}
		}
	}
}

function resolveBoxCollisions(positions: any, velocities: Float32Array, pinned: Set<number>, boxes: any): void {
	for (const box of boxes ?? []) {
		const half = box.size.map((value: number) => value / 2);
		for (let index = 0; index < positions.length / 3; index++) {
			if (pinned.has(index)) continue;
			const offset = index * 3;
			const local = [positions[offset] - box.center[0], positions[offset + 1] - box.center[1], positions[offset + 2] - box.center[2]];
			if (local.some((value: number, axis: number) => Math.abs(value) >= half[axis])) continue;
			const axis = local
				.map((value: number, candidate: number) => half[candidate] - Math.abs(value))
				.reduce((best: number, value: number, candidate: number, values: number[]) => (value < values[best] ? candidate : best), 0);
			const normal = local[axis] >= 0 ? 1 : -1;
			positions[offset + axis] = box.center[axis] + normal * half[axis];
			const normalVelocity = velocities[offset + axis] * normal;
			if (normalVelocity < 0) velocities[offset + axis] -= normal * normalVelocity * (1 + box.restitution);
		}
	}
}

function resolveMeshBoundsCollisions(scene: Scene, clothMesh: Mesh, positions: any, velocities: Float32Array, pinned: Set<number>, meshIds: string[] | undefined): void {
	if (!meshIds?.length) return;
	const inverseClothWorld = Matrix.Invert(clothMesh.getWorldMatrix());
	const boxes: any[] = [];
	for (const id of meshIds) {
		const mesh = scene.getMeshById(id) as Mesh | null;
		if (!mesh || mesh === clothMesh) continue;
		const bounds = mesh.getBoundingInfo().boundingBox;
		const min = bounds.minimumWorld;
		const max = bounds.maximumWorld;
		const points = [
			new Vector3(min.x, min.y, min.z),
			new Vector3(max.x, min.y, min.z),
			new Vector3(min.x, max.y, min.z),
			new Vector3(max.x, max.y, min.z),
			new Vector3(min.x, min.y, max.z),
			new Vector3(max.x, min.y, max.z),
			new Vector3(min.x, max.y, max.z),
			new Vector3(max.x, max.y, max.z),
		].map((point) => Vector3.TransformCoordinates(point, inverseClothWorld));
		const localMin = points.reduce((value, point) => Vector3.Minimize(value, point), points[0].clone());
		const localMax = points.reduce((value, point) => Vector3.Maximize(value, point), points[0].clone());
		boxes.push({ center: localMin.add(localMax).scale(0.5).asArray(), size: localMax.subtract(localMin).asArray(), restitution: 0 });
	}
	resolveBoxCollisions(positions, velocities, pinned, boxes);
}

/** Resolves non-neighbouring grid-vertex contacts with a bounded spatial hash. */
function resolveSelfCollisions(positions: any, pinned: Set<number>, subdivisions: number, radius: number): void {
	if (!(radius > 0)) return;
	const cells = new Map<string, number[]>();
	const columns = subdivisions + 1;
	const key = (x: number, y: number, z: number): string => `${x}:${y}:${z}`;
	for (let index = 0; index < positions.length / 3; index++) {
		const offset = index * 3;
		const cellX = Math.floor(positions[offset] / radius);
		const cellY = Math.floor(positions[offset + 1] / radius);
		const cellZ = Math.floor(positions[offset + 2] / radius);
		const row = Math.floor(index / columns);
		const column = index % columns;
		for (let x = cellX - 1; x <= cellX + 1; x++)
			for (let y = cellY - 1; y <= cellY + 1; y++)
				for (let z = cellZ - 1; z <= cellZ + 1; z++)
					for (const other of cells.get(key(x, y, z)) ?? []) {
						const otherRow = Math.floor(other / columns);
						const otherColumn = other % columns;
						if (Math.abs(row - otherRow) <= 1 && Math.abs(column - otherColumn) <= 1) continue;
						const otherOffset = other * 3;
						let dx = positions[offset] - positions[otherOffset];
						let dy = positions[offset + 1] - positions[otherOffset + 1];
						let dz = positions[offset + 2] - positions[otherOffset + 2];
						let length = Math.hypot(dx, dy, dz);
						if (length >= radius) continue;
						if (length < 0.000001) {
							dx = 0;
							dy = 0;
							dz = 1;
							length = 1;
						}
						dx /= length;
						dy /= length;
						dz /= length;
						const correction = radius - length;
						const movable = (pinned.has(index) ? 0 : 1) + (pinned.has(other) ? 0 : 1);
						if (!movable) continue;
						if (!pinned.has(index)) {
							positions[offset] += (dx * correction) / movable;
							positions[offset + 1] += (dy * correction) / movable;
							positions[offset + 2] += (dz * correction) / movable;
						}
						if (!pinned.has(other)) {
							positions[otherOffset] -= (dx * correction) / movable;
							positions[otherOffset + 1] -= (dy * correction) / movable;
							positions[otherOffset + 2] -= (dz * correction) / movable;
						}
					}
		const cellKey = key(cellX, cellY, cellZ);
		const values = cells.get(cellKey) ?? [];
		values.push(index);
		cells.set(cellKey, values);
	}
}

/** Recreates editor-authored pinned cloth simulations in generated projects. */
export function configureCloths(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorCloths;
	if (!Array.isArray(configurations)) return;
	for (const config of configurations) {
		const mesh = scene.getMeshById(config.meshId) as Mesh | null;
		const positions = mesh?.getVerticesData(VertexBuffer.PositionKind);
		if (!mesh || !positions) continue;
		const cloth: IRuntimeCloth = {
			mesh,
			initialPositions: new Float32Array(positions),
			velocities: new Float32Array(positions.length),
			springs: buildSprings(new Float32Array(positions), config.subdivisions),
		};
		const columns = config.subdivisions + 1;
		const pinned = new Set<number>(config.pinnedVertices ?? Array.from({ length: columns }, (_, index) => index));
		scene.onBeforeRenderObservable.add(() => {
			if (config.enabled === false) return;
			const positions = cloth.mesh.getVerticesData(VertexBuffer.PositionKind);
			if (!positions) return;
			const step = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
			if (!step) return;
			const gravity = config.gravity ?? [0, -981, 0];
			const damping = Math.max(0, Math.min(0.999, config.damping ?? 0.02));
			for (let index = 0; index < positions.length / 3; index++) {
				const offset = index * 3;
				if (pinned.has(index)) {
					positions[offset] = cloth.initialPositions[offset];
					positions[offset + 1] = cloth.initialPositions[offset + 1];
					positions[offset + 2] = cloth.initialPositions[offset + 2];
					cloth.velocities[offset] = cloth.velocities[offset + 1] = cloth.velocities[offset + 2] = 0;
					continue;
				}
				cloth.velocities[offset] = (cloth.velocities[offset] + gravity[0] * step) * (1 - damping);
				cloth.velocities[offset + 1] = (cloth.velocities[offset + 1] + gravity[1] * step) * (1 - damping);
				cloth.velocities[offset + 2] = (cloth.velocities[offset + 2] + gravity[2] * step) * (1 - damping);
				positions[offset] += cloth.velocities[offset] * step;
				positions[offset + 1] += cloth.velocities[offset + 1] * step;
				positions[offset + 2] += cloth.velocities[offset + 2] * step;
			}
			for (let iteration = 0; iteration < (config.constraintIterations ?? 4); iteration++)
				for (const [first, second, restLength] of cloth.springs) {
					const a = first * 3,
						b = second * 3,
						x = positions[b] - positions[a],
						y = positions[b + 1] - positions[a + 1],
						z = positions[b + 2] - positions[a + 2],
						length = Math.hypot(x, y, z) || 1,
						correction = (length - restLength) / length / 2;
					if (!pinned.has(first)) {
						positions[a] += x * correction;
						positions[a + 1] += y * correction;
						positions[a + 2] += z * correction;
					}
					if (!pinned.has(second)) {
						positions[b] -= x * correction;
						positions[b + 1] -= y * correction;
						positions[b + 2] -= z * correction;
					}
				}
			if (config.selfCollision) resolveSelfCollisions(positions, pinned, config.subdivisions, config.selfCollisionRadius ?? 5);
			resolvePlaneCollision(positions, cloth.velocities, pinned, config.collisionPlane);
			resolveSphereCollisions(positions, cloth.velocities, pinned, config.collisionSpheres);
			resolveBoxCollisions(positions, cloth.velocities, pinned, config.collisionBoxes);
			resolveMeshBoundsCollisions(scene, cloth.mesh, positions, cloth.velocities, pinned, config.collisionMeshIds);
			const normals: number[] = [];
			VertexData.ComputeNormals(positions, cloth.mesh.getIndices() ?? [], normals);
			cloth.mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
			cloth.mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
			cloth.mesh.refreshBoundingInfo();
		});
	}
}
