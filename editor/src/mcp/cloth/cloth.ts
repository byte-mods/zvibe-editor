import { Matrix, Mesh, Scene, Tools, Vector3, VertexBuffer, VertexData } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

type IRuntimeCloth = { observer: any; initialPositions: Float32Array; velocities: Float32Array; springs: Array<[number, number, number]>; mesh: Mesh; pinned: Set<number> };

const runtimeCloths = new WeakMap<Scene, Map<string, IRuntimeCloth>>();

function configs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorCloths ??= []);
}

function runtime(scene: Scene): Map<string, IRuntimeCloth> {
	let cloths = runtimeCloths.get(scene);
	if (!cloths) runtimeCloths.set(scene, (cloths = new Map()));
	return cloths;
}

function createGrid(mesh: Mesh, width: number, height: number, subdivisions: number): void {
	const columns = subdivisions + 1;
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];
	for (let row = 0; row <= subdivisions; row++) {
		for (let column = 0; column <= subdivisions; column++) {
			positions.push((column / subdivisions - 0.5) * width, (0.5 - row / subdivisions) * height, 0);
			normals.push(0, 0, 1);
			uvs.push(column / subdivisions, 1 - row / subdivisions);
		}
	}
	for (let row = 0; row < subdivisions; row++) {
		for (let column = 0; column < subdivisions; column++) {
			const topLeft = row * columns + column;
			indices.push(topLeft, topLeft + columns, topLeft + 1, topLeft + 1, topLeft + columns, topLeft + columns + 1);
		}
	}
	new VertexData().applyToMesh(mesh, true);
	mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
	mesh.setVerticesData(VertexBuffer.NormalKind, normals, true);
	mesh.setVerticesData(VertexBuffer.UVKind, uvs, true);
	mesh.setIndices(indices, null, true);
}

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
	for (let row = 0; row <= subdivisions; row++) {
		for (let column = 0; column <= subdivisions; column++) {
			const index = row * columns + column;
			if (column < subdivisions) add(index, index + 1);
			if (row < subdivisions) add(index, index + columns);
			if (row < subdivisions && column < subdivisions) add(index, index + columns + 1);
			if (row < subdivisions && column > 0) add(index, index + columns - 1);
		}
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

function normalizeCollisionSpheres(spheres: any): any[] | undefined {
	if (spheres === undefined || spheres === null) return spheres;
	if (!Array.isArray(spheres) || spheres.length > 32) throw new Error("collisionSpheres must contain from zero to 32 local-space spheres.");
	return spheres.map((sphere, index) => {
		if (!Array.isArray(sphere?.center) || sphere.center.length !== 3 || sphere.center.some((value: any) => !Number.isFinite(value)))
			throw new Error(`collisionSpheres[${index}].center must be three finite numbers.`);
		if (!(sphere.radius > 0) || !Number.isFinite(sphere.radius)) throw new Error(`collisionSpheres[${index}].radius must be greater than zero.`);
		if (sphere.restitution !== undefined && (!(sphere.restitution >= 0) || !(sphere.restitution <= 1)))
			throw new Error(`collisionSpheres[${index}].restitution must be from 0 to 1.`);
		return { center: [...sphere.center], radius: sphere.radius, restitution: sphere.restitution ?? 0 };
	});
}

function normalizeCollisionPlane(plane: any): any | undefined | null {
	if (plane === undefined || plane === null) return plane;
	if (!Array.isArray(plane.normal) || plane.normal.length !== 3 || plane.normal.some((value: any) => !Number.isFinite(value)) || !Vector3.FromArray(plane.normal).lengthSquared())
		throw new Error("collisionPlane.normal must be a non-zero vector of three finite numbers.");
	if (plane.offset !== undefined && !Number.isFinite(plane.offset)) throw new Error("collisionPlane.offset must be finite.");
	if (plane.restitution !== undefined && (!(plane.restitution >= 0) || !(plane.restitution <= 1))) throw new Error("collisionPlane.restitution must be from 0 to 1.");
	return { normal: Vector3.FromArray(plane.normal).normalize().asArray(), offset: plane.offset ?? 0, restitution: plane.restitution ?? 0 };
}

function normalizePinnedVertices(pinnedVertices: any, subdivisions: number): number[] | undefined {
	if (pinnedVertices === undefined) return undefined;
	if (!Array.isArray(pinnedVertices)) throw new Error("pinnedVertices must be an array of vertex indices.");
	const maximum = (subdivisions + 1) ** 2;
	const unique = [...new Set(pinnedVertices)];
	if (unique.some((index) => !Number.isInteger(index) || index < 0 || index >= maximum)) throw new Error(`pinnedVertices must contain integer indices from 0 to ${maximum - 1}.`);
	return unique;
}

function normalizeCollisionBoxes(boxes: any): any[] | undefined {
	if (boxes === undefined || boxes === null) return boxes;
	if (!Array.isArray(boxes) || boxes.length > 32) throw new Error("collisionBoxes must contain from zero to 32 local-space boxes.");
	return boxes.map((box, index) => {
		if (!Array.isArray(box?.center) || box.center.length !== 3 || box.center.some((value: any) => !Number.isFinite(value)))
			throw new Error(`collisionBoxes[${index}].center must be three finite numbers.`);
		if (!Array.isArray(box?.size) || box.size.length !== 3 || box.size.some((value: any) => !(value > 0) || !Number.isFinite(value)))
			throw new Error(`collisionBoxes[${index}].size must be three positive finite numbers.`);
		if (box.restitution !== undefined && (!(box.restitution >= 0) || !(box.restitution <= 1))) throw new Error(`collisionBoxes[${index}].restitution must be from 0 to 1.`);
		return { center: [...box.center], size: [...box.size], restitution: box.restitution ?? 0 };
	});
}

function normalizeCollisionMeshIds(scene: Scene, clothMeshId: string, ids: any): string[] | undefined {
	if (ids === undefined || ids === null) return ids;
	if (!Array.isArray(ids) || ids.length > 16 || ids.some((id) => typeof id !== "string" || !id.trim()))
		throw new Error("collisionMeshIds must contain from zero to 16 non-empty mesh ids.");
	if (new Set(ids).size !== ids.length) throw new Error("collisionMeshIds must not contain duplicates.");
	for (const id of ids) {
		if (id === clothMeshId) throw new Error("A cloth cannot use its own mesh as a collision mesh.");
		const node = resolveNode({ scene, nodeId: id });
		if (!isMesh(node)) throw new Error(`Collision mesh "${id}" was not found.`);
	}
	return [...ids];
}

function normalizeSelfCollisionRadius(radius: any): number | undefined {
	if (radius === undefined) return undefined;
	if (!(radius > 0) || !Number.isFinite(radius)) throw new Error("selfCollisionRadius must be a positive finite number.");
	return radius;
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
		const mesh = scene.getMeshById(id);
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

function createRuntimeCloth(scene: Scene, config: any): IRuntimeCloth {
	const node = resolveNode({ scene, nodeId: config.meshId });
	if (!isMesh(node)) throw new Error("Cloth mesh was not found. Create or keep its mesh before enabling the component.");
	const positions = node.getVerticesData(VertexBuffer.PositionKind);
	if (!positions) throw new Error("Cloth mesh has no position vertex buffer.");
	const initialPositions = new Float32Array(positions);
	const velocities = new Float32Array(positions.length);
	const springs = buildSprings(initialPositions, config.subdivisions);
	const columns = config.subdivisions + 1;
	const pinned = new Set<number>(config.pinnedVertices ?? Array.from({ length: columns }, (_, index) => index));
	const observer = scene.onBeforeRenderObservable.add(() => {
		if (config.enabled === false) return;
		const step = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		if (!step) return;
		const gravity = config.gravity ?? [0, -981, 0];
		const damping = Math.max(0, Math.min(0.999, config.damping ?? 0.02));
		for (let index = 0; index < positions.length / 3; index++) {
			const offset = index * 3;
			if (pinned.has(index)) {
				positions[offset] = initialPositions[offset];
				positions[offset + 1] = initialPositions[offset + 1];
				positions[offset + 2] = initialPositions[offset + 2];
				velocities[offset] = velocities[offset + 1] = velocities[offset + 2] = 0;
				continue;
			}
			velocities[offset] = (velocities[offset] + gravity[0] * step) * (1 - damping);
			velocities[offset + 1] = (velocities[offset + 1] + gravity[1] * step) * (1 - damping);
			velocities[offset + 2] = (velocities[offset + 2] + gravity[2] * step) * (1 - damping);
			positions[offset] += velocities[offset] * step;
			positions[offset + 1] += velocities[offset + 1] * step;
			positions[offset + 2] += velocities[offset + 2] * step;
		}
		for (let iteration = 0; iteration < (config.constraintIterations ?? 4); iteration++) {
			for (const [first, second, restLength] of springs) {
				const a = first * 3;
				const b = second * 3;
				const x = positions[b] - positions[a];
				const y = positions[b + 1] - positions[a + 1];
				const z = positions[b + 2] - positions[a + 2];
				const length = Math.hypot(x, y, z) || 1;
				const correction = (length - restLength) / length / 2;
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
		}
		if (config.selfCollision) resolveSelfCollisions(positions, pinned, config.subdivisions, config.selfCollisionRadius ?? 5);
		resolvePlaneCollision(positions, velocities, pinned, config.collisionPlane);
		resolveSphereCollisions(positions, velocities, pinned, config.collisionSpheres);
		resolveBoxCollisions(positions, velocities, pinned, config.collisionBoxes);
		resolveMeshBoundsCollisions(scene, node, positions, velocities, pinned, config.collisionMeshIds);
		const normals: number[] = [];
		VertexData.ComputeNormals(positions, node.getIndices() ?? [], normals);
		node.updateVerticesData(VertexBuffer.PositionKind, positions);
		node.updateVerticesData(VertexBuffer.NormalKind, normals);
		node.refreshBoundingInfo();
	});
	return { observer, initialPositions, velocities, springs, mesh: node, pinned };
}

/** Recreates saved cloth simulations once scene meshes are loaded. */
export function restoreCloths(scene: Scene): void {
	for (const config of configs(scene)) {
		if (runtime(scene).has(config.id)) continue;
		try {
			runtime(scene).set(config.id, createRuntimeCloth(scene, config));
		} catch (error) {
			console.warn(`Failed to restore cloth ${config.id}:`, error);
		}
	}
}

/** Lists persistent cloth components and live simulation status. */
export function listCloths(scene: Scene): any {
	return { cloths: structuredClone(configs(scene)).map((config) => ({ ...config, active: runtime(scene).has(config.id) })) };
}

/** Creates a gridded, pinned cloth mesh with a live Verlet-style constraint simulation. */
export function createCloth(scene: Scene, data: any, options: IMCPActionOptions): any {
	const subdivisions = data.subdivisions ?? 16;
	if (!Number.isInteger(subdivisions) || subdivisions < 2 || subdivisions > 64) throw new Error("subdivisions must be an integer from 2 to 64.");
	const mesh = new Mesh(data.name ?? "Cloth", scene);
	createGrid(mesh, data.width ?? 400, data.height ?? 400, subdivisions);
	mesh.position = Vector3.FromArray(data.position ?? [0, 400, 0]);
	const config = {
		id: data.id ?? Tools.RandomId(),
		meshId: mesh.id,
		subdivisions,
		gravity: data.gravity ?? [0, -981, 0],
		damping: data.damping ?? 0.02,
		constraintIterations: data.constraintIterations ?? 4,
		pinnedVertices: normalizePinnedVertices(data.pinnedVertices, subdivisions),
		collisionPlane: normalizeCollisionPlane(data.collisionPlane),
		collisionSpheres: normalizeCollisionSpheres(data.collisionSpheres),
		collisionBoxes: normalizeCollisionBoxes(data.collisionBoxes),
		collisionMeshIds: normalizeCollisionMeshIds(scene, mesh.id, data.collisionMeshIds),
		selfCollision: data.selfCollision ?? false,
		selfCollisionRadius: normalizeSelfCollisionRadius(data.selfCollisionRadius) ?? 5,
		enabled: data.enabled ?? true,
	};
	if (configs(scene).some((candidate) => candidate.id === config.id)) {
		mesh.dispose();
		throw new Error(`Cloth "${config.id}" already exists.`);
	}
	const active = createRuntimeCloth(scene, config);
	configs(scene).push(config);
	runtime(scene).set(config.id, active);
	options.editor.layout.inspector.setEditedObject(mesh);
	options.editor.layout.inspector.forceUpdate();
	return { ...config, mesh: toNodeSummary(mesh), active: true };
}

/** Updates live cloth simulation settings or resets it to its authored rest pose. */
export function setCloth(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = configs(scene).find((candidate) => candidate.id === data.id);
	if (!config) throw new Error(`Cloth "${data.id}" was not found.`);
	for (const key of ["gravity", "damping", "constraintIterations", "enabled", "selfCollision", "selfCollisionRadius"] as const)
		if (data[key] !== undefined) config[key] = data[key];
	if (data.collisionPlane !== undefined) config.collisionPlane = normalizeCollisionPlane(data.collisionPlane);
	if (data.pinnedVertices !== undefined) {
		config.pinnedVertices = normalizePinnedVertices(data.pinnedVertices, config.subdivisions);
		const pinned = runtime(scene).get(config.id)?.pinned;
		if (pinned) {
			pinned.clear();
			for (const index of config.pinnedVertices ?? []) pinned.add(index);
		}
	}
	if (data.collisionSpheres !== undefined) config.collisionSpheres = normalizeCollisionSpheres(data.collisionSpheres);
	if (data.collisionBoxes !== undefined) config.collisionBoxes = normalizeCollisionBoxes(data.collisionBoxes);
	if (data.collisionMeshIds !== undefined) config.collisionMeshIds = normalizeCollisionMeshIds(scene, config.meshId, data.collisionMeshIds);
	if (data.selfCollisionRadius !== undefined) config.selfCollisionRadius = normalizeSelfCollisionRadius(data.selfCollisionRadius);
	const active = runtime(scene).get(config.id);
	if (data.reset && active) {
		active.mesh.updateVerticesData(VertexBuffer.PositionKind, active.initialPositions);
		active.velocities.fill(0);
	}
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(config), active: !!active };
}

/** Stops and removes a cloth component, leaving its mesh for ordinary scene editing. */
export function deleteCloth(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = configs(scene).findIndex((candidate) => candidate.id === data.id);
	if (index === -1) throw new Error(`Cloth "${data.id}" was not found.`);
	const active = runtime(scene).get(data.id);
	if (active) scene.onBeforeRenderObservable.remove(active.observer);
	runtime(scene).delete(data.id);
	configs(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}
