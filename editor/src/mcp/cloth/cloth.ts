import { Mesh, Scene, Tools, Vector3, VertexBuffer, VertexData } from "babylonjs";
import {
	configureCloths,
	getClothSimulationControl,
	IClothTriangleCollider,
	IClothVertexConstraint,
	MaxClothTriangleColliders,
	MaxClothTrianglesPerCollider,
	resetClothSimulation,
} from "babylonjs-editor-tools";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

function configs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorCloths ??= []);
}

export type ClothConstraintChannel = "maxDistance" | "surfacePenetration";
export type ClothConstraintFalloff = "constant" | "linear" | "smooth";

export interface IClothConstraintPaintViewportState {
	revision: number;
	enabled: boolean;
	clothId: string | null;
	channel: ClothConstraintChannel;
	value: number;
	radius: number;
	strength: number;
	falloff: ClothConstraintFalloff;
}

export interface IClothConstraintSnapshot {
	id: string;
	constraintRevision: number;
	vertexConstraints: IClothVertexConstraint[];
}

export interface IClothConstraintViewportData {
	id: string;
	meshId: string;
	constraintRevision: number;
	vertexIndices: number[];
	total: number;
}

const clothConstraintPaintStates = new WeakMap<Scene, IClothConstraintPaintViewportState>();

function getConstraintRevision(config: any): number {
	return Number.isInteger(config.constraintRevision) && config.constraintRevision >= 1 ? config.constraintRevision : 1;
}

function getPaintState(scene: Scene): IClothConstraintPaintViewportState {
	let state = clothConstraintPaintStates.get(scene);
	if (!state) {
		state = { revision: 1, enabled: false, clothId: null, channel: "maxDistance", value: 50, radius: 50, strength: 1, falloff: "smooth" };
		clothConstraintPaintStates.set(scene, state);
		scene.onDisposeObservable.addOnce(() => clothConstraintPaintStates.delete(scene));
	}
	return state;
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

function normalizeCollisionSpheres(spheres: any): any[] | undefined {
	if (spheres === undefined || spheres === null) {
		return spheres;
	}
	if (!Array.isArray(spheres) || spheres.length > 32) {
		throw new Error("collisionSpheres must contain from zero to 32 local-space spheres.");
	}
	return spheres.map((sphere, index) => {
		if (!Array.isArray(sphere?.center) || sphere.center.length !== 3 || sphere.center.some((value: any) => !Number.isFinite(value))) {
			throw new Error(`collisionSpheres[${index}].center must be three finite numbers.`);
		}
		if (!(sphere.radius > 0) || !Number.isFinite(sphere.radius)) {
			throw new Error(`collisionSpheres[${index}].radius must be greater than zero.`);
		}
		if (sphere.restitution !== undefined && (!(sphere.restitution >= 0) || !(sphere.restitution <= 1))) {
			throw new Error(`collisionSpheres[${index}].restitution must be from 0 to 1.`);
		}
		return { center: [...sphere.center], radius: sphere.radius, restitution: sphere.restitution ?? 0 };
	});
}

function normalizeCollisionPlane(plane: any): any | undefined | null {
	if (plane === undefined || plane === null) {
		return plane;
	}
	if (
		!Array.isArray(plane.normal) ||
		plane.normal.length !== 3 ||
		plane.normal.some((value: any) => !Number.isFinite(value)) ||
		!Vector3.FromArray(plane.normal).lengthSquared()
	) {
		throw new Error("collisionPlane.normal must be a non-zero vector of three finite numbers.");
	}
	if (plane.offset !== undefined && !Number.isFinite(plane.offset)) {
		throw new Error("collisionPlane.offset must be finite.");
	}
	if (plane.restitution !== undefined && (!(plane.restitution >= 0) || !(plane.restitution <= 1))) {
		throw new Error("collisionPlane.restitution must be from 0 to 1.");
	}
	return { normal: Vector3.FromArray(plane.normal).normalize().asArray(), offset: plane.offset ?? 0, restitution: plane.restitution ?? 0 };
}

function normalizePinnedVertices(pinnedVertices: any, subdivisions: number): number[] | undefined {
	if (pinnedVertices === undefined) {
		return undefined;
	}
	if (!Array.isArray(pinnedVertices)) {
		throw new Error("pinnedVertices must be an array of vertex indices.");
	}
	const maximum = (subdivisions + 1) ** 2;
	const unique = [...new Set(pinnedVertices)];
	if (unique.some((index) => !Number.isInteger(index) || index < 0 || index >= maximum)) {
		throw new Error(`pinnedVertices must contain integer indices from 0 to ${maximum - 1}.`);
	}
	return unique;
}

function normalizeVertexConstraints(constraints: any, subdivisions: number): IClothVertexConstraint[] | undefined {
	if (constraints === undefined || constraints === null) {
		return constraints;
	}
	const maximum = (subdivisions + 1) ** 2;
	if (!Array.isArray(constraints) || constraints.length > maximum) {
		throw new Error(`vertexConstraints must contain from zero to ${maximum} sparse vertex constraints.`);
	}
	const seen = new Set<number>();
	const normalized = constraints.map((constraint, index) => {
		if (!Number.isInteger(constraint?.vertexIndex) || constraint.vertexIndex < 0 || constraint.vertexIndex >= maximum) {
			throw new Error(`vertexConstraints[${index}].vertexIndex must be an integer from 0 to ${maximum - 1}.`);
		}
		if (seen.has(constraint.vertexIndex)) {
			throw new Error(`vertexConstraints contains duplicate vertex ${constraint.vertexIndex}.`);
		}
		seen.add(constraint.vertexIndex);
		for (const property of ["maxDistance", "surfacePenetration"] as const) {
			if (constraint[property] !== undefined && (!Number.isFinite(constraint[property]) || constraint[property] < 0 || constraint[property] > 100000)) {
				throw new Error(`vertexConstraints[${index}].${property} must be from 0 through 100000 centimeters.`);
			}
		}
		if (constraint.maxDistance === undefined && constraint.surfacePenetration === undefined) {
			throw new Error(`vertexConstraints[${index}] must define maxDistance, surfacePenetration, or both.`);
		}
		return {
			vertexIndex: constraint.vertexIndex,
			...(constraint.maxDistance !== undefined ? { maxDistance: constraint.maxDistance } : {}),
			...(constraint.surfacePenetration !== undefined ? { surfacePenetration: constraint.surfacePenetration } : {}),
		};
	});
	return normalized.sort((first, second) => first.vertexIndex - second.vertexIndex);
}

function normalizeCollisionBoxes(boxes: any): any[] | undefined {
	if (boxes === undefined || boxes === null) {
		return boxes;
	}
	if (!Array.isArray(boxes) || boxes.length > 32) {
		throw new Error("collisionBoxes must contain from zero to 32 local-space boxes.");
	}
	return boxes.map((box, index) => {
		if (!Array.isArray(box?.center) || box.center.length !== 3 || box.center.some((value: any) => !Number.isFinite(value))) {
			throw new Error(`collisionBoxes[${index}].center must be three finite numbers.`);
		}
		if (!Array.isArray(box?.size) || box.size.length !== 3 || box.size.some((value: any) => !(value > 0) || !Number.isFinite(value))) {
			throw new Error(`collisionBoxes[${index}].size must be three positive finite numbers.`);
		}
		if (box.restitution !== undefined && (!(box.restitution >= 0) || !(box.restitution <= 1))) {
			throw new Error(`collisionBoxes[${index}].restitution must be from 0 to 1.`);
		}
		return { center: [...box.center], size: [...box.size], restitution: box.restitution ?? 0 };
	});
}

function normalizeCollisionMeshIds(scene: Scene, clothMeshId: string, ids: any): string[] | undefined {
	if (ids === undefined || ids === null) {
		return ids;
	}
	if (!Array.isArray(ids) || ids.length > 16 || ids.some((id) => typeof id !== "string" || !id.trim())) {
		throw new Error("collisionMeshIds must contain from zero to 16 non-empty mesh ids.");
	}
	if (new Set(ids).size !== ids.length) {
		throw new Error("collisionMeshIds must not contain duplicates.");
	}
	for (const id of ids) {
		if (id === clothMeshId) {
			throw new Error("A cloth cannot use its own mesh as a collision mesh.");
		}
		const node = resolveNode({ scene, nodeId: id });
		if (!isMesh(node)) {
			throw new Error(`Collision mesh "${id}" was not found.`);
		}
	}
	return [...ids];
}

function normalizeTriangleColliders(scene: Scene, clothMeshId: string, colliders: any): IClothTriangleCollider[] | undefined {
	if (colliders === undefined || colliders === null) {
		return colliders;
	}
	if (!Array.isArray(colliders) || colliders.length > MaxClothTriangleColliders) {
		throw new Error(`triangleColliders must contain from zero to ${MaxClothTriangleColliders} mesh colliders.`);
	}
	const seen = new Set<string>();
	return colliders.map((collider, index) => {
		if (typeof collider?.meshId !== "string" || !collider.meshId.trim()) {
			throw new Error(`triangleColliders[${index}].meshId must be a non-empty string.`);
		}
		if (collider.meshId === clothMeshId) {
			throw new Error("A cloth cannot use its own mesh as a triangle collider.");
		}
		if (seen.has(collider.meshId)) {
			throw new Error(`triangleColliders contains duplicate mesh "${collider.meshId}".`);
		}
		seen.add(collider.meshId);
		const mesh = scene.getMeshById(collider.meshId) as Mesh | null;
		const positions = mesh?.getVerticesData(VertexBuffer.PositionKind);
		const indices = mesh?.getIndices();
		const triangleCount = indices?.length ? indices.length / 3 : (positions?.length ?? 0) / 9;
		if (
			!mesh ||
			!positions ||
			positions.length < 9 ||
			positions.length % 3 !== 0 ||
			positions.some((value) => !Number.isFinite(value)) ||
			!Number.isInteger(triangleCount) ||
			triangleCount < 1
		) {
			throw new Error(`Triangle collider mesh "${collider.meshId}" has no valid triangle geometry.`);
		}
		if (indices?.some((vertexIndex) => !Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= positions.length / 3)) {
			throw new Error(`Triangle collider mesh "${collider.meshId}" contains an out-of-range vertex index.`);
		}
		if (triangleCount > MaxClothTrianglesPerCollider) {
			throw new Error(`Triangle collider mesh "${collider.meshId}" has ${triangleCount} triangles; the per-collider limit is ${MaxClothTrianglesPerCollider}.`);
		}
		const thickness = collider.thickness ?? 2;
		const restitution = collider.restitution ?? 0;
		const friction = collider.friction ?? 0.2;
		if (!Number.isFinite(thickness) || thickness <= 0 || thickness > 1000) {
			throw new Error(`triangleColliders[${index}].thickness must be greater than 0 and at most 1000 centimeters.`);
		}
		if (!Number.isFinite(restitution) || restitution < 0 || restitution > 1 || !Number.isFinite(friction) || friction < 0 || friction > 1) {
			throw new Error(`triangleColliders[${index}] restitution and friction must be from 0 through 1.`);
		}
		return { meshId: collider.meshId, thickness, restitution, friction };
	});
}

function normalizeSelfCollisionRadius(radius: any): number | undefined {
	if (radius === undefined) {
		return undefined;
	}
	if (!(radius > 0) || !Number.isFinite(radius)) {
		throw new Error("selfCollisionRadius must be a positive finite number.");
	}
	return radius;
}

/** Recreates saved cloth simulations through the shared editor/export runtime. */
export function restoreCloths(scene: Scene): void {
	configureCloths(scene);
}

/** Lists persistent cloth components and shared live simulation status. */
export function listCloths(scene: Scene): any {
	const control = getClothSimulationControl(scene);
	const activeIds = new Set(control.clothIds);
	return {
		cloths: structuredClone(configs(scene)).map((config) => {
			const { vertexConstraints = [], ...summary } = config;
			return {
				...summary,
				constraintRevision: getConstraintRevision(config),
				vertexConstraintCount: vertexConstraints.length,
				active: activeIds.has(config.id),
				diagnostics: control.clothDiagnostics.find((diagnostics) => diagnostics.clothId === config.id) ?? null,
			};
		}),
		simulation: control,
	};
}

/** Creates a gridded, pinned cloth mesh owned by the shared runtime solver. */
export function createCloth(scene: Scene, data: any, options: IMCPActionOptions): any {
	const subdivisions = data.subdivisions ?? 16;
	if (!Number.isInteger(subdivisions) || subdivisions < 2 || subdivisions > 64) {
		throw new Error("subdivisions must be an integer from 2 to 64.");
	}
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
		constraintRevision: 1,
		vertexConstraints: normalizeVertexConstraints(data.vertexConstraints, subdivisions) ?? [],
		collisionPlane: normalizeCollisionPlane(data.collisionPlane),
		collisionSpheres: normalizeCollisionSpheres(data.collisionSpheres),
		collisionBoxes: normalizeCollisionBoxes(data.collisionBoxes),
		collisionMeshIds: normalizeCollisionMeshIds(scene, mesh.id, data.collisionMeshIds),
		triangleColliders: normalizeTriangleColliders(scene, mesh.id, data.triangleColliders) ?? [],
		selfCollision: data.selfCollision ?? false,
		selfCollisionRadius: normalizeSelfCollisionRadius(data.selfCollisionRadius) ?? 5,
		enabled: data.enabled ?? true,
	};
	if (configs(scene).some((candidate) => candidate.id === config.id)) {
		mesh.dispose();
		throw new Error(`Cloth "${config.id}" already exists.`);
	}
	configs(scene).push(config);
	configureCloths(scene);
	const active = getClothSimulationControl(scene).clothIds.includes(config.id);
	if (!active) {
		configs(scene).splice(configs(scene).indexOf(config), 1);
		mesh.dispose();
		throw new Error(`Cloth "${config.id}" could not start because its shared runtime mesh was unavailable.`);
	}
	options.editor.layout.inspector.setEditedObject(mesh);
	options.editor.layout.inspector.forceUpdate();
	const { vertexConstraints, ...summary } = config;
	return { ...summary, vertexConstraintCount: vertexConstraints.length, mesh: toNodeSummary(mesh), active };
}

/** Updates shared cloth settings or restores the authored rest pose. */
export function setCloth(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = configs(scene).find((candidate) => candidate.id === data.id);
	if (!config) {
		throw new Error(`Cloth "${data.id}" was not found.`);
	}
	if (data.expectedConstraintRevision !== undefined && data.vertexConstraints === undefined) {
		throw new Error("vertexConstraints is required when expectedConstraintRevision is provided.");
	}
	for (const key of ["gravity", "damping", "constraintIterations", "enabled", "selfCollision", "selfCollisionRadius"] as const) {
		if (data[key] !== undefined) {
			config[key] = data[key];
		}
	}
	if (data.collisionPlane !== undefined) {
		config.collisionPlane = normalizeCollisionPlane(data.collisionPlane);
	}
	if (data.pinnedVertices !== undefined) {
		config.pinnedVertices = normalizePinnedVertices(data.pinnedVertices, config.subdivisions);
	}
	if (data.vertexConstraints !== undefined) {
		if (data.expectedConstraintRevision === undefined) {
			throw new Error("expectedConstraintRevision is required when replacing vertexConstraints.");
		}
		if (data.expectedConstraintRevision !== getConstraintRevision(config)) {
			throw new Error(`Cloth constraint revision is stale: expected ${data.expectedConstraintRevision}, current ${getConstraintRevision(config)}.`);
		}
		config.vertexConstraints = normalizeVertexConstraints(data.vertexConstraints, config.subdivisions) ?? [];
		config.constraintRevision = getConstraintRevision(config) + 1;
	}
	if (data.collisionSpheres !== undefined) {
		config.collisionSpheres = normalizeCollisionSpheres(data.collisionSpheres);
	}
	if (data.collisionBoxes !== undefined) {
		config.collisionBoxes = normalizeCollisionBoxes(data.collisionBoxes);
	}
	if (data.collisionMeshIds !== undefined) {
		config.collisionMeshIds = normalizeCollisionMeshIds(scene, config.meshId, data.collisionMeshIds);
	}
	if (data.triangleColliders !== undefined) {
		config.triangleColliders = normalizeTriangleColliders(scene, config.meshId, data.triangleColliders) ?? [];
	}
	if (data.selfCollisionRadius !== undefined) {
		config.selfCollisionRadius = normalizeSelfCollisionRadius(data.selfCollisionRadius);
	}
	configureCloths(scene);
	if (data.reset) {
		resetClothSimulation(scene, config.id);
	}
	const active = getClothSimulationControl(scene).clothIds.includes(config.id);
	options.editor.layout.inspector.forceUpdate();
	const { vertexConstraints, ...summary } = structuredClone(config);
	return { ...summary, vertexConstraintCount: vertexConstraints?.length ?? 0, active };
}

/** Reads sparse per-vertex cloth constraints and the exact mutation lease. */
export function getClothConstraints(scene: Scene, data: any = {}): any {
	const config = configs(scene).find((candidate) => candidate.id === data.id);
	if (!config) {
		throw new Error(`Cloth "${data.id}" was not found.`);
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 200;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new Error("offset must be a non-negative integer and limit must be an integer from 1 through 500.");
	}
	const constraints = structuredClone(config.vertexConstraints ?? []);
	return {
		id: config.id,
		meshId: config.meshId,
		constraintRevision: getConstraintRevision(config),
		vertexCount: (config.subdivisions + 1) ** 2,
		vertexConstraints: constraints.slice(offset, offset + limit),
		page: {
			offset,
			limit,
			returned: Math.max(0, Math.min(limit, constraints.length - offset)),
			total: constraints.length,
			nextOffset: offset + limit < constraints.length ? offset + limit : null,
		},
	};
}

/** Returns an exact content snapshot used by viewport stroke Undo/Redo. */
export function getClothConstraintSnapshot(scene: Scene, id: string): IClothConstraintSnapshot {
	const config = configs(scene).find((candidate) => candidate.id === id);
	if (!config) {
		throw new Error(`Cloth "${id}" was not found.`);
	}
	return { id, constraintRevision: getConstraintRevision(config), vertexConstraints: structuredClone(config.vertexConstraints ?? []) };
}

/** Reads only the bounded vertex ids needed by the live viewport overlay. */
export function getClothConstraintViewportData(scene: Scene, id: string, channel: ClothConstraintChannel): IClothConstraintViewportData {
	const config = configs(scene).find((candidate) => candidate.id === id);
	if (!config) {
		throw new Error(`Cloth "${id}" was not found.`);
	}
	const matching = (config.vertexConstraints ?? []).filter((constraint: IClothVertexConstraint) => constraint[channel] !== undefined);
	return {
		id,
		meshId: config.meshId,
		constraintRevision: getConstraintRevision(config),
		vertexIndices: matching.slice(0, 512).map((constraint) => constraint.vertexIndex),
		total: matching.length,
	};
}

/** Restores snapshot content while issuing a fresh exact revision. */
export function restoreClothConstraintSnapshot(scene: Scene, snapshot: IClothConstraintSnapshot, options: IMCPActionOptions, expectedCurrentRevision?: number): any {
	const config = configs(scene).find((candidate) => candidate.id === snapshot.id);
	if (!config) {
		throw new Error(`Cloth "${snapshot.id}" was not found.`);
	}
	if (expectedCurrentRevision !== undefined && getConstraintRevision(config) !== expectedCurrentRevision) {
		throw new Error(`Cloth constraint revision is stale: expected ${expectedCurrentRevision}, current ${getConstraintRevision(config)}.`);
	}
	config.vertexConstraints = normalizeVertexConstraints(snapshot.vertexConstraints, config.subdivisions) ?? [];
	config.constraintRevision = getConstraintRevision(config) + 1;
	options.editor.layout.inspector.forceUpdate();
	return getClothConstraints(scene, { id: snapshot.id });
}

/** Reads bounded per-cloth triangle broadphase, contact, and truncation evidence without stepping simulation. */
export function getClothCollisionDiagnostics(scene: Scene, data: any = {}): any {
	const control = getClothSimulationControl(scene);
	const diagnostics = data.id ? control.clothDiagnostics.filter((candidate) => candidate.clothId === data.id) : control.clothDiagnostics;
	if (data.id && !configs(scene).some((candidate) => candidate.id === data.id)) {
		throw new Error(`Cloth "${data.id}" was not found.`);
	}
	return { diagnostics: structuredClone(diagnostics), count: diagnostics.length, simulationPaused: control.paused, lastStepSeconds: control.lastStepSeconds };
}

function brushInfluence(distance: number, radius: number, strength: number, falloff: ClothConstraintFalloff): number {
	if (falloff === "constant") {
		return strength;
	}
	const linear = Math.max(0, 1 - distance / radius);
	return strength * (falloff === "smooth" ? linear * linear * (3 - 2 * linear) : linear);
}

/** Paints one persistent cloth-constraint channel in local cloth space without advancing simulation. */
export function paintClothConstraints(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = configs(scene).find((candidate) => candidate.id === data.id);
	if (!config) {
		throw new Error(`Cloth "${data.id}" was not found.`);
	}
	const revision = getConstraintRevision(config);
	if (data.expectedConstraintRevision !== revision) {
		throw new Error(`Cloth constraint revision is stale: expected ${data.expectedConstraintRevision}, current ${revision}.`);
	}
	if (!Array.isArray(data.center) || data.center.length !== 3 || data.center.some((value: any) => !Number.isFinite(value))) {
		throw new Error("center must contain three finite local-space coordinates.");
	}
	if (!Number.isFinite(data.radius) || data.radius <= 0 || data.radius > 100000) {
		throw new Error("radius must be greater than 0 and at most 100000 centimeters.");
	}
	if (!Number.isFinite(data.strength) || data.strength <= 0 || data.strength > 1) {
		throw new Error("strength must be greater than 0 and at most 1.");
	}
	if (!(["maxDistance", "surfacePenetration"] as string[]).includes(data.channel)) {
		throw new Error('channel must be "maxDistance" or "surfacePenetration".');
	}
	if (!(["constant", "linear", "smooth"] as string[]).includes(data.falloff)) {
		throw new Error('falloff must be "constant", "linear", or "smooth".');
	}
	if (!(["paint", "erase"] as string[]).includes(data.mode)) {
		throw new Error('mode must be "paint" or "erase".');
	}
	if (data.mode === "paint" && (!Number.isFinite(data.value) || data.value < 0 || data.value > 100000)) {
		throw new Error("value must be from 0 through 100000 centimeters when painting.");
	}
	const mesh = scene.getMeshById(config.meshId) as Mesh | null;
	const positions = mesh?.getVerticesData(VertexBuffer.PositionKind);
	if (!mesh || !positions) {
		throw new Error(`Cloth "${data.id}" has no editable position buffer.`);
	}
	const center = Vector3.FromArray(data.center);
	const candidates: Array<{ vertexIndex: number; distance: number; influence: number }> = [];
	for (let vertexIndex = 0; vertexIndex < positions.length / 3; vertexIndex++) {
		const distance = Vector3.Distance(Vector3.FromArray(positions, vertexIndex * 3), center);
		if (distance <= data.radius) {
			const influence = brushInfluence(distance, data.radius, data.strength, data.falloff);
			if (influence > 0) {
				candidates.push({ vertexIndex, distance, influence });
			}
		}
	}
	const cap = data.maxAffectedVertices ?? 1024;
	if (!Number.isInteger(cap) || cap < 1 || cap > 4096) {
		throw new Error("maxAffectedVertices must be an integer from 1 through 4096.");
	}
	if (candidates.length > cap) {
		throw new Error(`Brush would affect ${candidates.length} vertices, above maxAffectedVertices ${cap}; reduce radius or increase the explicit cap.`);
	}
	const constraints = new Map<number, IClothVertexConstraint>(
		(config.vertexConstraints ?? []).map((constraint: IClothVertexConstraint) => [constraint.vertexIndex, { ...constraint }])
	);
	const beforeConstraints = JSON.stringify([...constraints.values()]);
	for (const candidate of candidates) {
		const constraint = constraints.get(candidate.vertexIndex) ?? { vertexIndex: candidate.vertexIndex };
		if (data.mode === "erase") {
			if (candidate.influence >= 0.5) {
				delete constraint[data.channel as ClothConstraintChannel];
			}
		} else {
			const previous = constraint[data.channel as ClothConstraintChannel];
			constraint[data.channel as ClothConstraintChannel] = previous === undefined ? data.value : previous + (data.value - previous) * candidate.influence;
		}
		if (constraint.maxDistance === undefined && constraint.surfacePenetration === undefined) {
			constraints.delete(candidate.vertexIndex);
		} else {
			constraints.set(candidate.vertexIndex, constraint);
		}
	}
	config.vertexConstraints = [...constraints.values()].sort((first, second) => first.vertexIndex - second.vertexIndex);
	const mutated = JSON.stringify(config.vertexConstraints) !== beforeConstraints;
	if (mutated) {
		config.constraintRevision = revision + 1;
	}
	options.editor.layout.inspector.forceUpdate();
	return {
		id: config.id,
		constraintRevision: config.constraintRevision,
		channel: data.channel,
		mode: data.mode,
		affectedVertices: candidates.slice(0, 256).map((candidate) => ({ vertexIndex: candidate.vertexIndex, distance: candidate.distance, influence: candidate.influence })),
		affectedCount: candidates.length,
		returnedAffectedVertices: Math.min(256, candidates.length),
		affectedVerticesTruncated: candidates.length > 256,
		constraintCount: config.vertexConstraints.length,
		mutated,
	};
}

/** Reads transient viewport brush settings; authored constraint data remains in scene metadata. */
export function getClothConstraintPaintViewport(scene: Scene): IClothConstraintPaintViewportState {
	return { ...getPaintState(scene) };
}

/** Updates transient viewport brush settings under an exact state lease. */
export function setClothConstraintPaintViewport(scene: Scene, data: any, options: IMCPActionOptions): IClothConstraintPaintViewportState {
	const current = getPaintState(scene);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`Cloth paint viewport revision is stale: expected ${data.expectedRevision}, current ${current.revision}.`);
	}
	const next = { ...current };
	if (data.clothId !== undefined) {
		if (data.clothId !== null && !configs(scene).some((candidate) => candidate.id === data.clothId)) {
			throw new Error(`Cloth "${data.clothId}" was not found.`);
		}
		next.clothId = data.clothId;
	}
	for (const property of ["enabled", "channel", "value", "radius", "strength", "falloff"] as const) {
		if (data[property] !== undefined) {
			(next as any)[property] = data[property];
		}
	}
	if (!(<string[]>["maxDistance", "surfacePenetration"]).includes(next.channel) || !(<string[]>["constant", "linear", "smooth"]).includes(next.falloff)) {
		throw new Error("Cloth brush channel or falloff is unsupported.");
	}
	if (next.enabled && !next.clothId) {
		throw new Error("Select clothId before enabling cloth constraint painting.");
	}
	if (
		!Number.isFinite(next.radius) ||
		!(next.radius > 0) ||
		next.radius > 100000 ||
		!Number.isFinite(next.strength) ||
		!(next.strength > 0) ||
		next.strength > 1 ||
		!Number.isFinite(next.value) ||
		next.value < 0 ||
		next.value > 100000
	) {
		throw new Error("Cloth brush value/radius/strength settings are outside their supported ranges.");
	}
	next.revision++;
	clothConstraintPaintStates.set(scene, next);
	options.editor.layout.inspector.forceUpdate();
	return { ...next };
}

/** Stops and removes a cloth component while preserving its ordinary scene mesh. */
export function deleteCloth(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = configs(scene).findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`Cloth "${data.id}" was not found.`);
	}
	configs(scene).splice(index, 1);
	const paint = getPaintState(scene);
	if (paint.clothId === data.id) {
		clothConstraintPaintStates.set(scene, { ...paint, revision: paint.revision + 1, enabled: false, clothId: null });
	}
	configureCloths(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}
