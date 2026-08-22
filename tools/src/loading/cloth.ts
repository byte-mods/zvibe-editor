import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";

import { resolveClothTriangleCollisions } from "./cloth-triangle-collision";
import { IClothRuntimeDiagnostics, IClothVertexConstraint } from "./cloth-types";

type IRuntimeCloth = {
	config: any;
	initialPositions: Float32Array;
	initialNormals: Float32Array;
	velocities: Float32Array;
	springs: Array<[number, number, number]>;
	mesh: Mesh;
	diagnostics: IClothRuntimeDiagnostics;
};

interface IRuntimeClothSimulation {
	cloths: Map<string, IRuntimeCloth>;
	observer: any;
	paused: boolean;
	executingManualStep: boolean;
	totalAutomaticSteps: number;
	totalManualSteps: number;
	totalManualSeconds: number;
	lastStepSeconds: number | null;
	lastSteppedCloths: number;
	clothDiagnostics: IClothRuntimeDiagnostics[];
	lastError: { message: string; completedCloths: number; timestamp: number } | null;
}

export interface IClothSimulationControl {
	available: boolean;
	paused: boolean;
	registeredCloths: number;
	enabledCloths: number;
	clothIds: string[];
	executingManualStep: boolean;
	totalAutomaticSteps: number;
	totalManualSteps: number;
	totalManualSeconds: number;
	lastStepSeconds: number | null;
	lastSteppedCloths: number;
	clothDiagnostics: IClothRuntimeDiagnostics[];
	lastError: { message: string; completedCloths: number; timestamp: number } | null;
}

const runtimeClothSimulations = new WeakMap<Scene, IRuntimeClothSimulation>();

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
			if (column < subdivisions) {
				add(index, index + 1);
			}
			if (row < subdivisions) {
				add(index, index + columns);
			}
			if (row < subdivisions && column < subdivisions) {
				add(index, index + columns + 1);
			}
			if (row < subdivisions && column > 0) {
				add(index, index + columns - 1);
			}
		}
	}
	return springs;
}

function resolvePlaneCollision(positions: any, velocities: Float32Array, pinned: Set<number>, plane: any): void {
	if (!plane) {
		return;
	}
	const normal = Vector3.FromArray(plane.normal ?? [0, 1, 0]);
	if (normal.lengthSquared() < 0.0000001) {
		return;
	}
	normal.normalize();
	const offset = plane.offset ?? 0;
	const restitution = Math.max(0, Math.min(1, plane.restitution ?? 0));
	for (let index = 0; index < positions.length / 3; index++) {
		if (pinned.has(index)) {
			continue;
		}
		const positionOffset = index * 3;
		const distance = positions[positionOffset] * normal.x + positions[positionOffset + 1] * normal.y + positions[positionOffset + 2] * normal.z - offset;
		if (distance >= 0) {
			continue;
		}
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
			if (pinned.has(index)) {
				continue;
			}
			const offset = index * 3;
			let x = positions[offset] - center[0];
			let y = positions[offset + 1] - center[1];
			let z = positions[offset + 2] - center[2];
			let length = Math.hypot(x, y, z);
			if (length >= radius) {
				continue;
			}
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
			if (pinned.has(index)) {
				continue;
			}
			const offset = index * 3;
			const local = [positions[offset] - box.center[0], positions[offset + 1] - box.center[1], positions[offset + 2] - box.center[2]];
			if (local.some((value: number, axis: number) => Math.abs(value) >= half[axis])) {
				continue;
			}
			const axis = local
				.map((value: number, candidate: number) => half[candidate] - Math.abs(value))
				.reduce((best: number, value: number, candidate: number, values: number[]) => (value < values[best] ? candidate : best), 0);
			const normal = local[axis] >= 0 ? 1 : -1;
			positions[offset + axis] = box.center[axis] + normal * half[axis];
			const normalVelocity = velocities[offset + axis] * normal;
			if (normalVelocity < 0) {
				velocities[offset + axis] -= normal * normalVelocity * (1 + box.restitution);
			}
		}
	}
}

function resolveMeshBoundsCollisions(scene: Scene, clothMesh: Mesh, positions: any, velocities: Float32Array, pinned: Set<number>, meshIds: string[] | undefined): void {
	if (!meshIds?.length) {
		return;
	}
	const inverseClothWorld = Matrix.Invert(clothMesh.getWorldMatrix());
	const boxes: any[] = [];
	for (const id of meshIds) {
		const mesh = scene.getMeshById(id) as Mesh | null;
		if (!mesh || mesh === clothMesh) {
			continue;
		}
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
	if (!(radius > 0)) {
		return;
	}
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
		for (let x = cellX - 1; x <= cellX + 1; x++) {
			for (let y = cellY - 1; y <= cellY + 1; y++) {
				for (let z = cellZ - 1; z <= cellZ + 1; z++) {
					for (const other of cells.get(key(x, y, z)) ?? []) {
						const otherRow = Math.floor(other / columns);
						const otherColumn = other % columns;
						if (Math.abs(row - otherRow) <= 1 && Math.abs(column - otherColumn) <= 1) {
							continue;
						}
						const otherOffset = other * 3;
						let dx = positions[offset] - positions[otherOffset];
						let dy = positions[offset + 1] - positions[otherOffset + 1];
						let dz = positions[offset + 2] - positions[otherOffset + 2];
						let length = Math.hypot(dx, dy, dz);
						if (length >= radius) {
							continue;
						}
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
						if (!movable) {
							continue;
						}
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
				}
			}
		}
		const cellKey = key(cellX, cellY, cellZ);
		const values = cells.get(cellKey) ?? [];
		values.push(index);
		cells.set(cellKey, values);
	}
}

function getVertexConstraints(config: any, vertexCount: number): IClothVertexConstraint[] {
	if (!Array.isArray(config.vertexConstraints)) {
		return [];
	}
	return config.vertexConstraints.filter(
		(constraint: any) =>
			Number.isInteger(constraint?.vertexIndex) &&
			constraint.vertexIndex >= 0 &&
			constraint.vertexIndex < vertexCount &&
			((Number.isFinite(constraint.maxDistance) && constraint.maxDistance >= 0) || (Number.isFinite(constraint.surfacePenetration) && constraint.surfacePenetration >= 0))
	);
}

function removeVelocityToward(velocities: Float32Array, offset: number, normal: Vector3, positiveDirection: boolean): void {
	const velocity = Vector3.FromArray(velocities, offset);
	const component = Vector3.Dot(velocity, normal);
	if ((positiveDirection && component > 0) || (!positiveDirection && component < 0)) {
		velocity.subtractInPlace(normal.scale(component));
		velocities[offset] = velocity.x;
		velocities[offset + 1] = velocity.y;
		velocities[offset + 2] = velocity.z;
	}
}

function resolveVertexConstraints(cloth: IRuntimeCloth, positions: Float32Array | number[], constraints: IClothVertexConstraint[], pinned: Set<number>): void {
	for (const constraint of constraints) {
		const offset = constraint.vertexIndex * 3;
		if (constraint.maxDistance === 0) {
			positions[offset] = cloth.initialPositions[offset];
			positions[offset + 1] = cloth.initialPositions[offset + 1];
			positions[offset + 2] = cloth.initialPositions[offset + 2];
			cloth.velocities[offset] = cloth.velocities[offset + 1] = cloth.velocities[offset + 2] = 0;
			pinned.add(constraint.vertexIndex);
			continue;
		}
		const current = Vector3.FromArray(positions, offset);
		const rest = Vector3.FromArray(cloth.initialPositions, offset);
		const displacement = current.subtract(rest);
		if (constraint.maxDistance !== undefined && displacement.lengthSquared() > constraint.maxDistance * constraint.maxDistance) {
			const direction = displacement.normalize();
			const resolved = rest.add(direction.scale(constraint.maxDistance));
			positions[offset] = resolved.x;
			positions[offset + 1] = resolved.y;
			positions[offset + 2] = resolved.z;
			removeVelocityToward(cloth.velocities, offset, direction, true);
		}
		if (constraint.surfacePenetration !== undefined) {
			const normal = Vector3.FromArray(cloth.initialNormals, offset);
			if (normal.lengthSquared() < 0.0000001) {
				continue;
			}
			normal.normalize();
			const latest = Vector3.FromArray(positions, offset);
			const signedDistance = Vector3.Dot(latest.subtract(rest), normal);
			if (signedDistance < -constraint.surfacePenetration) {
				const resolved = latest.add(normal.scale(-constraint.surfacePenetration - signedDistance));
				positions[offset] = resolved.x;
				positions[offset + 1] = resolved.y;
				positions[offset + 2] = resolved.z;
				removeVelocityToward(cloth.velocities, offset, normal, false);
			}
		}
	}
}

function createRuntimeCloth(scene: Scene, config: any): IRuntimeCloth | null {
	const mesh = scene.getMeshById(config.meshId) as Mesh | null;
	const positions = mesh?.getVerticesData(VertexBuffer.PositionKind);
	if (!mesh || !positions) {
		return null;
	}
	const initialPositions = new Float32Array(positions);
	let normals = mesh.getVerticesData(VertexBuffer.NormalKind);
	if (!normals || normals.length !== positions.length) {
		const computed: number[] = [];
		VertexData.ComputeNormals(positions, mesh.getIndices() ?? [], computed);
		normals = computed;
	}
	return {
		config,
		mesh,
		initialPositions,
		initialNormals: new Float32Array(normals),
		velocities: new Float32Array(positions.length),
		springs: buildSprings(initialPositions, config.subdivisions),
		diagnostics: {
			clothId: config.id,
			vertexConstraints: 0,
			maximumDistanceConstraints: 0,
			surfacePenetrationConstraints: 0,
			configuredColliders: 0,
			activeColliders: 0,
			skippedColliders: 0,
			triangles: 0,
			candidateTests: 0,
			contacts: 0,
			workTruncated: false,
		},
	};
}

function publishClothPositions(cloth: IRuntimeCloth, positions: Float32Array | number[]): void {
	const normals: number[] = [];
	VertexData.ComputeNormals(positions, cloth.mesh.getIndices() ?? [], normals);
	cloth.mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
	cloth.mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
	cloth.mesh.refreshBoundingInfo();
}

function stepRuntimeCloth(scene: Scene, cloth: IRuntimeCloth, step: number): void {
	const config = cloth.config;
	const positions = cloth.mesh.getVerticesData(VertexBuffer.PositionKind);
	if (!positions) {
		throw new Error(`Cloth "${config.id}" has no position vertex buffer.`);
	}
	const columns = config.subdivisions + 1;
	const pinned = new Set<number>(config.pinnedVertices ?? Array.from({ length: columns }, (_, index) => index));
	const vertexConstraints = getVertexConstraints(config, positions.length / 3);
	for (const constraint of vertexConstraints) {
		if (constraint.maxDistance === 0) {
			pinned.add(constraint.vertexIndex);
		}
	}
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
	for (let iteration = 0; iteration < (config.constraintIterations ?? 4); iteration++) {
		for (const [first, second, restLength] of cloth.springs) {
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
		resolveVertexConstraints(cloth, positions, vertexConstraints, pinned);
	}
	if (config.selfCollision) {
		resolveSelfCollisions(positions, pinned, config.subdivisions, config.selfCollisionRadius ?? 5);
	}
	resolvePlaneCollision(positions, cloth.velocities, pinned, config.collisionPlane);
	resolveSphereCollisions(positions, cloth.velocities, pinned, config.collisionSpheres);
	resolveBoxCollisions(positions, cloth.velocities, pinned, config.collisionBoxes);
	resolveMeshBoundsCollisions(scene, cloth.mesh, positions, cloth.velocities, pinned, config.collisionMeshIds);
	const triangleDiagnostics = resolveClothTriangleCollisions({
		scene,
		clothMesh: cloth.mesh,
		positions,
		velocities: cloth.velocities,
		pinned,
		configurations: config.triangleColliders,
		step,
	});
	cloth.diagnostics = {
		clothId: config.id,
		vertexConstraints: vertexConstraints.length,
		maximumDistanceConstraints: vertexConstraints.filter((constraint) => constraint.maxDistance !== undefined).length,
		surfacePenetrationConstraints: vertexConstraints.filter((constraint) => constraint.surfacePenetration !== undefined).length,
		...triangleDiagnostics,
	};
	publishClothPositions(cloth, positions);
}

function synchronizeRuntimeCloths(scene: Scene, runtime: IRuntimeClothSimulation): void {
	const configurations = Array.isArray(scene.metadata?.babylonEditorCloths) ? scene.metadata.babylonEditorCloths : [];
	const activeIds = new Set<string>();
	for (const config of configurations) {
		if (typeof config?.id !== "string" || !config.id) {
			continue;
		}
		activeIds.add(config.id);
		const existing = runtime.cloths.get(config.id);
		const mesh = scene.getMeshById(config.meshId) as Mesh | null;
		if (existing && existing.mesh === mesh && existing.config === config && !existing.mesh.isDisposed()) {
			continue;
		}
		const cloth = createRuntimeCloth(scene, config);
		if (cloth) {
			runtime.cloths.set(config.id, cloth);
		} else {
			runtime.cloths.delete(config.id);
		}
	}
	for (const id of runtime.cloths.keys()) {
		if (!activeIds.has(id)) {
			runtime.cloths.delete(id);
		}
	}
}

function advanceCloths(scene: Scene, runtime: IRuntimeClothSimulation, step: number): number {
	let completedCloths = 0;
	for (const cloth of runtime.cloths.values()) {
		if (cloth.config.enabled === false) {
			continue;
		}
		stepRuntimeCloth(scene, cloth, step);
		completedCloths++;
	}
	return completedCloths;
}

function ensureClothRuntime(scene: Scene): IRuntimeClothSimulation {
	let runtime = runtimeClothSimulations.get(scene);
	if (runtime) {
		synchronizeRuntimeCloths(scene, runtime);
		return runtime;
	}
	runtime = {
		cloths: new Map(),
		observer: null,
		paused: false,
		executingManualStep: false,
		totalAutomaticSteps: 0,
		totalManualSteps: 0,
		totalManualSeconds: 0,
		lastStepSeconds: null,
		lastSteppedCloths: 0,
		clothDiagnostics: [],
		lastError: null,
	};
	runtime.observer = scene.onBeforeRenderObservable.add(() => {
		if (runtime!.paused || runtime!.executingManualStep) {
			return;
		}
		synchronizeRuntimeCloths(scene, runtime!);
		const step = Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		if (!step) {
			return;
		}
		try {
			runtime!.lastSteppedCloths = advanceCloths(scene, runtime!, step);
			runtime!.totalAutomaticSteps++;
			runtime!.lastStepSeconds = step;
			runtime!.lastError = null;
		} catch (error) {
			runtime!.lastError = { message: error instanceof Error ? error.message : String(error), completedCloths: runtime!.lastSteppedCloths, timestamp: Date.now() };
			throw error;
		}
	});
	runtimeClothSimulations.set(scene, runtime);
	synchronizeRuntimeCloths(scene, runtime);
	return runtime;
}

function clothControl(runtime: IRuntimeClothSimulation): IClothSimulationControl {
	runtime.clothDiagnostics = [...runtime.cloths.values()].map((cloth) => structuredClone(cloth.diagnostics));
	return {
		available: runtime.cloths.size > 0,
		paused: runtime.paused,
		registeredCloths: runtime.cloths.size,
		enabledCloths: [...runtime.cloths.values()].filter((cloth) => cloth.config.enabled !== false).length,
		clothIds: [...runtime.cloths.keys()],
		executingManualStep: runtime.executingManualStep,
		totalAutomaticSteps: runtime.totalAutomaticSteps,
		totalManualSteps: runtime.totalManualSteps,
		totalManualSeconds: runtime.totalManualSeconds,
		lastStepSeconds: runtime.lastStepSeconds,
		lastSteppedCloths: runtime.lastSteppedCloths,
		clothDiagnostics: structuredClone(runtime.clothDiagnostics),
		lastError: runtime.lastError ? { ...runtime.lastError } : null,
	};
}

/** Recreates editor-authored cloth simulations and attaches one shared automatic scene observer. */
export function configureCloths(scene: any): void {
	ensureClothRuntime(scene);
}

/** Reads deterministic cloth solver ownership and step evidence without advancing it. */
export function getClothSimulationControl(scene: any): IClothSimulationControl {
	return clothControl(ensureClothRuntime(scene));
}

/** Pauses or resumes only the shared cloth solver while scene rendering may continue. */
export function setClothSimulationPaused(scene: any, paused: boolean): IClothSimulationControl {
	const runtime = ensureClothRuntime(scene);
	runtime.paused = paused;
	return clothControl(runtime);
}

/** Advances every enabled cloth exactly once while the shared solver is paused. */
export function stepPausedClothSimulation(scene: any, deltaSeconds: number): IClothSimulationControl & { steppedCloths: number } {
	const runtime = ensureClothRuntime(scene);
	if (!runtime.paused) {
		throw new Error("Pause the cloth simulation before manually stepping it.");
	}
	if (runtime.executingManualStep) {
		throw new Error("The cloth simulation is already executing a manual step.");
	}
	if (!Number.isFinite(deltaSeconds) || deltaSeconds < 1 / 1000 || deltaSeconds > 0.1) {
		throw new Error("deltaSeconds must be from 0.001 through 0.1 seconds.");
	}
	const snapshots = [...runtime.cloths.values()].map((cloth) => ({
		cloth,
		positions: new Float32Array(cloth.mesh.getVerticesData(VertexBuffer.PositionKind) ?? []),
		velocities: new Float32Array(cloth.velocities),
	}));
	runtime.executingManualStep = true;
	runtime.lastError = null;
	let steppedCloths = 0;
	try {
		steppedCloths = advanceCloths(scene, runtime, deltaSeconds);
		runtime.totalManualSteps++;
		runtime.totalManualSeconds += deltaSeconds;
		runtime.lastStepSeconds = deltaSeconds;
		runtime.lastSteppedCloths = steppedCloths;
	} catch (error) {
		for (const snapshot of snapshots) {
			snapshot.cloth.velocities.set(snapshot.velocities);
			if (snapshot.positions.length) {
				publishClothPositions(snapshot.cloth, snapshot.positions);
			}
		}
		runtime.lastError = { message: error instanceof Error ? error.message : String(error), completedCloths: steppedCloths, timestamp: Date.now() };
		throw error;
	} finally {
		runtime.executingManualStep = false;
	}
	return { ...clothControl(runtime), steppedCloths };
}

/** Restores one cloth's authored positions and clears its runtime velocity. */
export function resetClothSimulation(scene: any, id: string): IClothSimulationControl {
	const runtime = ensureClothRuntime(scene);
	const cloth = runtime.cloths.get(id);
	if (!cloth) {
		throw new Error(`Cloth "${id}" is not active in the current scene.`);
	}
	cloth.velocities.fill(0);
	publishClothPositions(cloth, cloth.initialPositions);
	return clothControl(runtime);
}
