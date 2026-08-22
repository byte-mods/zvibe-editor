import { Matrix, Mesh, Quaternion, Scene, TransformNode, Vector3, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

import { getMeshEdges, getMeshTopologyFingerprint } from "./meshes";

const PIVOT_MODEL = "unity-world-stable-mesh-pivot-v1";
const MAXIMUM_VERTEX_COUNT = 500_000;
const MAXIMUM_COMPONENT_COUNT = 4_096;
const MAXIMUM_DESCENDANT_COUNT = 10_000;
const MATRIX_EPSILON = 0.000001;

type MeshPivotMode = "world" | "boundsCenter" | "selectionAverage";
type MeshPivotSelectionMode = "vertex" | "edge" | "face";

export interface IMeshPivotSnapshot {
	position: number[];
	rotation: number[];
	rotationQuaternion: number[] | null;
	scaling: number[];
	pivotMatrix: number[];
	postMultiplyPivotMatrix: boolean;
}

interface IMeshPivotSource {
	mode: MeshPivotMode;
	selectionMode?: MeshPivotSelectionMode;
	componentIndices?: number[];
}

function isFiniteVector(values: unknown): values is number[] {
	return Array.isArray(values) && values.length === 3 && values.every((value) => typeof value === "number" && Number.isFinite(value));
}

function copyMatrixValues(matrix: Matrix): number[] {
	return Array.from(matrix.asArray());
}

function copyWorldMatrix(node: TransformNode): Matrix {
	return node.computeWorldMatrix(true).clone();
}

function matrixMaximumDifference(first: Matrix, second: Matrix): number {
	const firstValues = first.asArray();
	const secondValues = second.asArray();
	let maximum = 0;
	for (let index = 0; index < 16; index++) {
		maximum = Math.max(maximum, Math.abs(firstValues[index] - secondValues[index]));
	}
	return maximum;
}

function matrixTolerance(matrix: Matrix): number {
	let maximum = 1;
	for (const value of matrix.asArray()) {
		maximum = Math.max(maximum, Math.abs(value));
	}
	return maximum * MATRIX_EPSILON;
}

function isTranslationPivotMatrix(matrix: Matrix): boolean {
	const values = matrix.asArray();
	const expected = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
	return expected.every((value, index) => Math.abs(values[index] - value) <= MATRIX_EPSILON) && Math.abs(values[15] - 1) <= MATRIX_EPSILON;
}

function assertEditablePivotState(mesh: Mesh): void {
	if (mesh.isWorldMatrixFrozen) {
		throw new Error(`Mesh "${mesh.name}" has a frozen world matrix. Unfreeze it before editing its pivot.`);
	}
	if (mesh.infiniteDistance || mesh.billboardMode !== 0) {
		throw new Error(`Mesh "${mesh.name}" uses camera-dependent infinite-distance or billboard transforms. Disable them before editing its pivot.`);
	}
	if (!isTranslationPivotMatrix(mesh.getPivotMatrix())) {
		throw new Error(`Mesh "${mesh.name}" uses a non-translation pre-transform. Bake that transform into geometry before editing its Unity-style pivot.`);
	}
	if (!(Math.abs(mesh.scaling.x) > MATRIX_EPSILON && Math.abs(mesh.scaling.y) > MATRIX_EPSILON && Math.abs(mesh.scaling.z) > MATRIX_EPSILON)) {
		throw new Error(`Mesh "${mesh.name}" has singular scaling. Every scale axis must be non-zero before editing its pivot.`);
	}
	const worldMatrix = mesh.computeWorldMatrix(true);
	if (!Number.isFinite(worldMatrix.determinant()) || Math.abs(worldMatrix.determinant()) <= MATRIX_EPSILON) {
		throw new Error(`Mesh "${mesh.name}" has a singular inherited world transform. Fix zero-scaled or non-invertible parents before editing its pivot.`);
	}
}

function getGeometry(mesh: Mesh): { positions: number[]; indices: number[]; vertexCount: number } {
	const positions = mesh.getVerticesData(VertexBuffer.PositionKind, false);
	const indices = mesh.getIndices(false);
	if (!positions || positions.length === 0 || positions.length % 3 !== 0 || !indices || indices.length % 3 !== 0) {
		throw new Error(`Mesh "${mesh.name}" requires complete editable XYZ positions and triangle indices for pivot editing.`);
	}
	const vertexCount = positions.length / 3;
	if (vertexCount > MAXIMUM_VERTEX_COUNT) {
		throw new Error(`Mesh "${mesh.name}" has ${vertexCount} vertices; Unity-style pivot verification is bounded to ${MAXIMUM_VERTEX_COUNT}.`);
	}
	if (positions.some((value) => !Number.isFinite(value)) || indices.some((value) => !Number.isInteger(value) || value < 0 || value >= vertexCount)) {
		throw new Error(`Mesh "${mesh.name}" has non-finite positions or invalid triangle indices. Repair mesh integrity before editing its pivot.`);
	}
	return { positions: Array.from(positions), indices: Array.from(indices), vertexCount };
}

function getBoundsCenter(positions: number[]): Vector3 {
	const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
	const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
	for (let index = 0; index < positions.length; index += 3) {
		minimum.minimizeInPlaceFromFloats(positions[index], positions[index + 1], positions[index + 2]);
		maximum.maximizeInPlaceFromFloats(positions[index], positions[index + 1], positions[index + 2]);
	}
	return minimum.add(maximum).scaleInPlace(0.5);
}

function getSelectedVertices(selectionMode: MeshPivotSelectionMode, componentIndices: number[], vertexCount: number, indices: number[]): number[] {
	if (!componentIndices.length || componentIndices.length > MAXIMUM_COMPONENT_COUNT) {
		throw new Error(`selectionAverage requires 1-${MAXIMUM_COMPONENT_COUNT} unique component indices.`);
	}
	if (new Set(componentIndices).size !== componentIndices.length) {
		throw new Error("Pivot component indices must be unique.");
	}
	const edges = selectionMode === "edge" ? getMeshEdges(indices) : [];
	const maximum = selectionMode === "vertex" ? vertexCount : selectionMode === "edge" ? edges.length : indices.length / 3;
	if (componentIndices.some((index) => !Number.isInteger(index) || index < 0 || index >= maximum)) {
		throw new Error(`${selectionMode} pivot component indices must be integers from 0 to ${maximum - 1}.`);
	}
	const selected = new Set<number>();
	for (const componentIndex of componentIndices) {
		if (selectionMode === "vertex") {
			selected.add(componentIndex);
		} else if (selectionMode === "edge") {
			selected.add(edges[componentIndex][0]);
			selected.add(edges[componentIndex][1]);
		} else {
			selected.add(indices[componentIndex * 3]);
			selected.add(indices[componentIndex * 3 + 1]);
			selected.add(indices[componentIndex * 3 + 2]);
		}
	}
	return [...selected].sort((first, second) => first - second);
}

function getAveragePosition(positions: number[], vertexIndices: number[]): Vector3 {
	const result = Vector3.Zero();
	for (const vertexIndex of vertexIndices) {
		result.addInPlaceFromFloats(positions[vertexIndex * 3], positions[vertexIndex * 3 + 1], positions[vertexIndex * 3 + 2]);
	}
	return result.scaleInPlace(1 / vertexIndices.length);
}

function getCurrentSelection(mesh: Mesh, geometry: ReturnType<typeof getGeometry>): any {
	const selection = mesh.metadata?.babylonEditorMeshSelection;
	if (!selection || !(["vertex", "edge", "face"] as const).includes(selection.mode) || !Array.isArray(selection.indices) || !selection.indices.length) {
		return null;
	}
	try {
		const vertices = getSelectedVertices(selection.mode, selection.indices, geometry.vertexCount, geometry.indices);
		const local = getAveragePosition(geometry.positions, vertices);
		return {
			mode: selection.mode,
			componentIndices: [...selection.indices],
			vertexCount: vertices.length,
			centerLocal: local.asArray(),
			centerWorld: Vector3.TransformCoordinates(local, mesh.getWorldMatrix()).asArray(),
		};
	} catch (error: any) {
		return { mode: selection.mode, componentIndices: [...selection.indices], unavailableReason: error.message };
	}
}

function updateFingerprintNumber(state: { first: number; second: number }, value: number): void {
	const integer = Number.isInteger(value) ? value : Math.round(value * 1_000_000);
	for (let shift = 0; shift < 32; shift += 8) {
		const byte = (integer >>> shift) & 255;
		state.first = Math.imul(state.first ^ byte, 16777619) >>> 0;
		state.second = Math.imul(state.second ^ byte, 3266489917) >>> 0;
	}
}

function updateFingerprintString(state: { first: number; second: number }, value: string): void {
	updateFingerprintNumber(state, value.length);
	for (let index = 0; index < value.length; index++) {
		updateFingerprintNumber(state, value.charCodeAt(index));
	}
}

function getPivotFingerprint(mesh: Mesh, topologyFingerprint: string): string {
	mesh.computeWorldMatrix(true);
	const state = { first: 2166136261, second: 2246822519 };
	updateFingerprintString(state, topologyFingerprint);
	updateFingerprintString(state, mesh.id);
	updateFingerprintString(state, mesh.parent?.id ?? "");
	for (const value of [
		...mesh.position.asArray(),
		...mesh.rotation.asArray(),
		...(mesh.rotationQuaternion?.asArray() ?? []),
		...mesh.scaling.asArray(),
		...copyMatrixValues(mesh.getPivotMatrix()),
		...copyMatrixValues(mesh.getWorldMatrix()),
	]) {
		updateFingerprintNumber(state, value);
	}
	updateFingerprintNumber(state, mesh.rotationQuaternion ? 1 : 0);
	updateFingerprintNumber(state, (mesh as any)._postMultiplyPivotMatrix ? 1 : 0);
	return `mesh-pivot-fnv32x2-v1:${state.first.toString(16).padStart(8, "0")}${state.second.toString(16).padStart(8, "0")}`;
}

function getWorldVertices(positions: number[], matrix: Matrix): Vector3[] {
	const result: Vector3[] = [];
	for (let index = 0; index < positions.length; index += 3) {
		result.push(Vector3.TransformCoordinates(Vector3.FromArray(positions, index), matrix));
	}
	return result;
}

function maximumPointDrift(first: Vector3[], second: Vector3[]): number {
	let maximum = 0;
	for (let index = 0; index < first.length; index++) {
		maximum = Math.max(maximum, Vector3.Distance(first[index], second[index]));
	}
	return maximum;
}

function captureDescendantWorldMatrices(mesh: Mesh): Map<TransformNode, Matrix> {
	const descendants = mesh.getDescendants(false).filter((node): node is TransformNode => node instanceof TransformNode);
	if (descendants.length > MAXIMUM_DESCENDANT_COUNT) {
		throw new Error(`Mesh "${mesh.name}" has ${descendants.length} transform descendants; pivot verification is bounded to ${MAXIMUM_DESCENDANT_COUNT}.`);
	}
	return new Map(descendants.map((node) => [node, copyWorldMatrix(node)]));
}

function maximumDescendantDrift(before: Map<TransformNode, Matrix>): number {
	let maximum = 0;
	for (const [node, matrix] of before) {
		maximum = Math.max(maximum, matrixMaximumDifference(matrix, copyWorldMatrix(node)));
	}
	return maximum;
}

/** Captures the complete transform and pivot state required for exact Inspector Undo/Redo. */
export function captureMeshPivotSnapshot(scene: Scene, data: any): IMeshPivotSnapshot {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not an editable Mesh.`);
	}
	return {
		position: node.position.asArray(),
		rotation: node.rotation.asArray(),
		rotationQuaternion: node.rotationQuaternion?.asArray() ?? null,
		scaling: node.scaling.asArray(),
		pivotMatrix: copyMatrixValues(node.getPivotMatrix()),
		postMultiplyPivotMatrix: Boolean((node as any)._postMultiplyPivotMatrix),
	};
}

/** Restores an exact transform/pivot snapshot without changing geometry. */
export function restoreMeshPivotSnapshot(scene: Scene, data: any, snapshot: IMeshPivotSnapshot, options?: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not an editable Mesh.`);
	}
	node.setPivotMatrix(Matrix.FromArray(snapshot.pivotMatrix), snapshot.postMultiplyPivotMatrix);
	node.position.copyFrom(Vector3.FromArray(snapshot.position));
	node.rotation.copyFrom(Vector3.FromArray(snapshot.rotation));
	node.rotationQuaternion = snapshot.rotationQuaternion ? Quaternion.FromArray(snapshot.rotationQuaternion) : null;
	node.scaling.copyFrom(Vector3.FromArray(snapshot.scaling));
	node.computeWorldMatrix(true);
	options?.editor.layout.inspector.setEditedObject(node);
	options?.editor.layout.inspector.forceUpdate();
	return getMeshPivot(scene, { nodeId: node.id });
}

/** Inspects the current pivot, exact lease, bounds-center candidate, and current component-selection candidate. */
export function getMeshPivot(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not an editable Mesh.`);
	}
	assertEditablePivotState(node);
	const geometry = getGeometry(node);
	const worldMatrix = copyWorldMatrix(node);
	const topologyFingerprint = getMeshTopologyFingerprint(geometry.positions, geometry.indices);
	const boundsCenterLocal = getBoundsCenter(geometry.positions);
	const localPivot = node.getPivotPoint();
	return {
		model: PIVOT_MODEL,
		node: toNodeSummary(node),
		pivotFingerprint: getPivotFingerprint(node, topologyFingerprint),
		topologyFingerprint,
		pivot: {
			local: localPivot.asArray(),
			world: Vector3.TransformCoordinates(localPivot, worldMatrix).asArray(),
			matrix: copyMatrixValues(node.getPivotMatrix()),
			postMultiplyPivotMatrix: Boolean((node as any)._postMultiplyPivotMatrix),
		},
		transform: {
			localPosition: node.position.asArray(),
			worldOrigin: node.getAbsolutePosition().asArray(),
			worldMatrix: copyMatrixValues(worldMatrix),
			parentId: node.parent?.id ?? null,
		},
		geometry: {
			vertexCount: geometry.vertexCount,
			faceCount: geometry.indices.length / 3,
			boundsCenterLocal: boundsCenterLocal.asArray(),
			boundsCenterWorld: Vector3.TransformCoordinates(boundsCenterLocal, worldMatrix).asArray(),
		},
		selection: getCurrentSelection(node, geometry),
		limits: {
			maximumVertices: MAXIMUM_VERTEX_COUNT,
			maximumComponents: MAXIMUM_COMPONENT_COUNT,
			maximumDescendants: MAXIMUM_DESCENDANT_COUNT,
			worldStabilityToleranceModel: "max(0.000001, maxAbsWorldMatrix*0.000001)",
		},
	};
}

/** Relocates a Unity-style pivot while preserving the exact current world geometry and descendant placement. */
export function setMeshPivot(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not an editable Mesh.`);
	}
	assertEditablePivotState(node);
	const geometry = getGeometry(node);
	const beforeInspection = getMeshPivot(scene, { nodeId: node.id });
	if (data.expectedPivotFingerprint !== beforeInspection.pivotFingerprint) {
		throw new Error(
			`Mesh pivot state is stale: expected "${data.expectedPivotFingerprint}", current fingerprint is "${beforeInspection.pivotFingerprint}". Call get_mesh_pivot again.`
		);
	}
	const mode = data.mode as MeshPivotMode;
	if (!(mode === "world" || mode === "boundsCenter" || mode === "selectionAverage")) {
		throw new Error('Pivot mode must be "world", "boundsCenter", or "selectionAverage".');
	}
	if (mode === "world" && (!isFiniteVector(data.worldPosition) || data.selectionMode !== undefined || data.componentIndices !== undefined)) {
		throw new Error("World pivot mode requires only one finite worldPosition [x,y,z].");
	}
	if (mode === "boundsCenter" && (data.worldPosition !== undefined || data.selectionMode !== undefined || data.componentIndices !== undefined)) {
		throw new Error("boundsCenter pivot mode does not accept worldPosition or component selection fields.");
	}
	if (
		mode === "selectionAverage" &&
		(!(["vertex", "edge", "face"] as const).includes(data.selectionMode) || !Array.isArray(data.componentIndices) || data.worldPosition !== undefined)
	) {
		throw new Error("selectionAverage pivot mode requires selectionMode and unique componentIndices, and does not accept worldPosition.");
	}

	const beforeSnapshot = captureMeshPivotSnapshot(scene, { nodeId: node.id });
	const beforeWorld = copyWorldMatrix(node);
	const beforeVertices = getWorldVertices(geometry.positions, beforeWorld);
	const beforeDescendants = captureDescendantWorldMatrices(node);
	const beforeLocalMatrix = (node as any)._localMatrix.clone() as Matrix;
	let targetLocal: Vector3;
	let selectedVertexCount = 0;
	if (mode === "world") {
		const inverse = Matrix.Invert(beforeWorld);
		if (!inverse.asArray().every((value) => Number.isFinite(value))) {
			throw new Error(`Mesh "${node.name}" has a non-invertible world transform; fix its parent and scaling before setting a world pivot.`);
		}
		targetLocal = Vector3.TransformCoordinates(Vector3.FromArray(data.worldPosition), inverse);
	} else if (mode === "boundsCenter") {
		targetLocal = getBoundsCenter(geometry.positions);
	} else {
		const selectedVertices = getSelectedVertices(data.selectionMode, data.componentIndices, geometry.vertexCount, geometry.indices);
		selectedVertexCount = selectedVertices.length;
		targetLocal = getAveragePosition(geometry.positions, selectedVertices);
	}
	const targetWorld = Vector3.TransformCoordinates(targetLocal, beforeWorld);
	const source: IMeshPivotSource = {
		mode,
		selectionMode: mode === "selectionAverage" ? data.selectionMode : undefined,
		componentIndices: mode === "selectionAverage" ? [...data.componentIndices] : undefined,
	};

	try {
		node.setPivotMatrix(Matrix.Translation(-targetLocal.x, -targetLocal.y, -targetLocal.z), true);
		node.computeWorldMatrix(true);
		const afterPivotLocalMatrix = (node as any)._localMatrix as Matrix;
		node.position.addInPlaceFromFloats(
			beforeLocalMatrix.m[12] - afterPivotLocalMatrix.m[12],
			beforeLocalMatrix.m[13] - afterPivotLocalMatrix.m[13],
			beforeLocalMatrix.m[14] - afterPivotLocalMatrix.m[14]
		);
		const afterWorld = copyWorldMatrix(node);
		const worldMatrixDrift = matrixMaximumDifference(beforeWorld, afterWorld);
		const worldVertexDrift = maximumPointDrift(beforeVertices, getWorldVertices(geometry.positions, afterWorld));
		const descendantWorldMatrixDrift = maximumDescendantDrift(beforeDescendants);
		const pivotTargetDrift = Vector3.Distance(targetWorld, node.getAbsolutePivotPoint());
		const tolerance = matrixTolerance(beforeWorld);
		if (
			![worldMatrixDrift, worldVertexDrift, descendantWorldMatrixDrift, pivotTargetDrift].every(Number.isFinite) ||
			worldMatrixDrift > tolerance ||
			worldVertexDrift > tolerance ||
			descendantWorldMatrixDrift > tolerance ||
			pivotTargetDrift > tolerance
		) {
			throw new Error(
				`Pivot verification failed (matrix=${worldMatrixDrift}, vertices=${worldVertexDrift}, descendants=${descendantWorldMatrixDrift}, target=${pivotTargetDrift}, tolerance=${tolerance}).`
			);
		}
		const afterInspection = getMeshPivot(scene, { nodeId: node.id });
		if (afterInspection.topologyFingerprint !== beforeInspection.topologyFingerprint) {
			throw new Error("Pivot editing unexpectedly changed mesh topology.");
		}
		options.editor.layout.inspector.setEditedObject(node);
		options.editor.layout.inspector.forceUpdate();
		return {
			...afterInspection,
			source,
			selectedVertexCount,
			before: {
				pivotFingerprint: beforeInspection.pivotFingerprint,
				localPivot: beforeInspection.pivot.local,
				worldPivot: beforeInspection.pivot.world,
				localPosition: beforeInspection.transform.localPosition,
			},
			verification: {
				worldGeometryPreserved: true,
				worldMatrixDrift,
				maximumWorldVertexDrift: worldVertexDrift,
				preservedDescendantCount: beforeDescendants.size,
				maximumDescendantWorldMatrixDrift: descendantWorldMatrixDrift,
				pivotTargetDrift,
				tolerance,
				topologyPreserved: true,
			},
		};
	} catch (error) {
		restoreMeshPivotSnapshot(scene, { nodeId: node.id }, beforeSnapshot);
		throw error;
	}
}
