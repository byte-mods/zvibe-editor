import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { pathExists } from "fs-extra";

import sharp from "sharp";

import { Scene, Tools } from "babylonjs";
import {
	applyPhysics2DForce,
	applyPhysics2DTorque,
	configurePhysics2D,
	decomposePhysics2DPolygonContours,
	getPhysics2DBodyRuntimeState,
	getPhysics2DDebugSnapshot,
	getPhysics2DSimulationControl,
	IPhysics2DEffectorConfiguration,
	IPhysics2DJointConfiguration,
	IPhysics2DPolygonContour,
	IPhysics2DPoint,
	MaxPhysics2DBodies,
	MaxPhysics2DJoints,
	normalizePhysics2DEffectorConfigurations,
	normalizePhysics2DBodyConfiguration,
	normalizePhysics2DJointConfigurations,
	normalizePhysics2DSettingsConfiguration,
	Physics2DBodyContractVersion,
	Physics2DEffectorContractVersion,
	Physics2DJointContractVersion,
	physics2DJointTypes,
	setPhysics2DBodyRuntimeVelocity,
} from "babylonjs-editor-tools";

import { isAbstractMesh, isTransformNode } from "../../tools/guards/nodes";
import { projectConfiguration } from "../../project/configuration";
import { registerUndoRedo } from "../../tools/undoredo";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

type IPoint2D = IPhysics2DPoint;

export interface IPhysics2DEffectorCollectionSnapshot {
	present: boolean;
	value: unknown[];
}

export interface IPhysics2DBodyCollectionSnapshot {
	present: boolean;
	value: unknown[];
}

export interface IPhysics2DJointCollectionSnapshot {
	present: boolean;
	value: unknown[];
}

function configs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPhysics2D ??= []);
}
/** Returns persisted body metadata without allocating it during Inspector/list operations. */
function bodyMetadata(scene: Scene): any[] {
	return scene.metadata?.babylonEditorPhysics2D ?? [];
}
function jointMetadata(scene: Scene): unknown[] {
	// Reading the Inspector or listing joints must not add metadata to an otherwise clean scene.
	return scene.metadata?.babylonEditorPhysics2DJoints ?? [];
}
/** Keeps material discovery side-effect free while mutation helpers still allocate their owned collection. */
function materialMetadata(scene: Scene): any[] {
	return scene.metadata?.babylonEditorPhysics2DMaterials ?? [];
}
const Physics2DMaterialContractVersion = 1;

/** Normalizes legacy material records into a detached exact-revision contract. */
function normalizePhysics2DMaterial(value: unknown): any {
	const source = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
	const version = source?.version ?? 1;
	const revision = source?.revision ?? 1;
	if (
		!source ||
		typeof source.id !== "string" ||
		!source.id ||
		source.id.length > 256 ||
		typeof source.name !== "string" ||
		!source.name.trim() ||
		source.name.length > 256 ||
		!Number.isSafeInteger(version) ||
		(version as number) !== Physics2DMaterialContractVersion ||
		!Number.isSafeInteger(revision) ||
		(revision as number) < 1 ||
		typeof source.friction !== "number" ||
		!Number.isFinite(source.friction) ||
		source.friction < 0 ||
		source.friction > 1 ||
		typeof source.restitution !== "number" ||
		!Number.isFinite(source.restitution) ||
		source.restitution < 0 ||
		source.restitution > 1
	) {
		throw new Error("Physics Material 2D requires a bounded id/name, version/revision, friction, and restitution.");
	}
	return { version: Physics2DMaterialContractVersion, revision, id: source.id, name: source.name, friction: source.friction, restitution: source.restitution };
}

function readPhysics2DMaterials(scene: Scene): any[] {
	const source = materialMetadata(scene);
	if (!Array.isArray(source) || source.length > 1024) {
		throw new Error("Physics Material 2D resources must be an array with at most 1024 entries.");
	}
	const result = source.map(normalizePhysics2DMaterial);
	if (new Set(result.map((material) => material.id)).size !== result.length || new Set(result.map((material) => material.name)).size !== result.length) {
		throw new Error("Physics Material 2D resource ids and names must be unique.");
	}
	return result;
}

function commitPhysics2DMaterials(scene: Scene, candidate: unknown[]): any[] {
	const detached = candidate.map(normalizePhysics2DMaterial);
	if (
		detached.length > 1024 ||
		new Set(detached.map((material) => material.id)).size !== detached.length ||
		new Set(detached.map((material) => material.name)).size !== detached.length
	) {
		throw new Error("Physics Material 2D resources require at most 1024 unique ids and names.");
	}
	scene.metadata ??= {};
	scene.metadata.babylonEditorPhysics2DMaterials = detached;
	return detached;
}
function effectorMetadata(scene: Scene): unknown[] {
	// Read paths must not dirty a scene merely because its Inspector is visible.
	return scene.metadata?.babylonEditorPhysics2DEffectors ?? [];
}
/** Returns a detached canonical view while keeping read-only Inspector/MCP discovery side-effect free. */
function readPhysics2DSettings(scene: Scene): any {
	const normalized = normalizePhysics2DSettingsConfiguration(scene.metadata?.babylonEditorPhysics2DSettings);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	return normalized.value;
}

interface IPhysics2DSettingsSnapshot {
	present: boolean;
	value?: unknown;
}

function physics2DSettingsSnapshot(scene: Scene): IPhysics2DSettingsSnapshot {
	return scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, "babylonEditorPhysics2DSettings")
		? { present: true, value: structuredClone(scene.metadata.babylonEditorPhysics2DSettings) }
		: { present: false };
}

function restorePhysics2DSettingsSnapshot(scene: Scene, snapshot: IPhysics2DSettingsSnapshot, options: IMCPActionOptions): void {
	if (snapshot.present) {
		scene.metadata ??= {};
		scene.metadata.babylonEditorPhysics2DSettings = structuredClone(snapshot.value);
	} else if (scene.metadata) {
		delete scene.metadata.babylonEditorPhysics2DSettings;
	}
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
}

function commitPhysics2DSettings(scene: Scene, value: unknown, options: IMCPActionOptions): void {
	const before = physics2DSettingsSnapshot(scene);
	scene.metadata ??= {};
	scene.metadata.babylonEditorPhysics2DSettings = structuredClone(value);
	const after = physics2DSettingsSnapshot(scene);
	registerUndoRedo({ undo: () => restorePhysics2DSettingsSnapshot(scene, before, options), redo: () => restorePhysics2DSettingsSnapshot(scene, after, options) });
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
}
function findMaterial(scene: Scene, id: string): any {
	const material = readPhysics2DMaterials(scene).find((candidate) => candidate.id === id);
	if (!material) {
		throw new Error(`2D physics material "${id}" was not found.`);
	}
	return material;
}
function resolveBodyNode(scene: Scene, nodeId: string): any {
	const node = resolveNode({ scene, nodeId });
	if (!isTransformNode(node) && !isAbstractMesh(node)) {
		throw new Error("A 2D physics body must be attached to a mesh or transform node.");
	}
	return node;
}

/** Validates the complete current body collection once and returns the IDs joints may reference. */
function physics2DBodyNodeIds(scene: Scene): Set<string> {
	const source = scene.metadata?.babylonEditorPhysics2D ?? [];
	if (!Array.isArray(source) || source.length > MaxPhysics2DBodies) {
		throw new Error(`Physics 2D joint connections require a valid body array with at most ${MaxPhysics2DBodies} entries.`);
	}
	const ids = new Set<string>();
	for (let index = 0; index < source.length; index++) {
		const normalized = normalizePhysics2DBodyConfiguration(source[index]);
		if (!normalized.ok) {
			throw new Error(`Physics 2D body ${index}: ${normalized.error}`);
		}
		if (ids.has(normalized.value.nodeId)) {
			throw new Error(`Physics 2D body nodeId "${normalized.value.nodeId}" is duplicated.`);
		}
		resolveBodyNode(scene, normalized.value.nodeId);
		ids.add(normalized.value.nodeId);
	}
	return ids;
}

/** Ensures restored joints cannot reference deleted nodes or nodes without authored 2D bodies. */
function validatePhysics2DJointConnections(scene: Scene, joints: IPhysics2DJointConfiguration[]): void {
	if (!joints.length) {
		return;
	}
	const bodyIds = physics2DBodyNodeIds(scene);
	for (const joint of joints) {
		if (!bodyIds.has(joint.firstNodeId) || (joint.secondNodeId !== undefined && !bodyIds.has(joint.secondNodeId))) {
			throw new Error(`Physics 2D joint "${joint.id}" must reference authored 2D bodies, or omit secondNodeId for the fixed world.`);
		}
	}
}

function readPhysics2DJoints(scene: Scene): IPhysics2DJointConfiguration[] {
	const normalized = normalizePhysics2DJointConfigurations(jointMetadata(scene));
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	return normalized.value;
}

function commitPhysics2DJoints(scene: Scene, candidate: unknown): IPhysics2DJointConfiguration[] {
	const normalized = normalizePhysics2DJointConfigurations(candidate);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	// Replace only after the complete candidate validates so a failed request cannot corrupt scene metadata.
	scene.metadata ??= {};
	scene.metadata.babylonEditorPhysics2DJoints = normalized.value;
	return normalized.value;
}

function readPhysics2DEffectors(scene: Scene): IPhysics2DEffectorConfiguration[] {
	const normalized = normalizePhysics2DEffectorConfigurations(effectorMetadata(scene));
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	return normalized.value;
}

function commitPhysics2DEffectors(scene: Scene, candidate: unknown): IPhysics2DEffectorConfiguration[] {
	const normalized = normalizePhysics2DEffectorConfigurations(candidate);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	scene.metadata ??= {};
	scene.metadata.babylonEditorPhysics2DEffectors = normalized.value;
	return normalized.value;
}

/** Captures exact persisted bodies, including legacy fields and whether the collection key existed. */
export function capturePhysics2DBodySnapshot(scene: Scene): IPhysics2DBodyCollectionSnapshot {
	const present = Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorPhysics2D");
	return {
		present,
		value: present ? structuredClone(scene.metadata.babylonEditorPhysics2D) : [],
	};
}

/** Restores a validated raw collection so Undo/Redo never rewrites legacy representation or loses fields. */
export function restorePhysics2DBodySnapshot(scene: Scene, snapshot: IPhysics2DBodyCollectionSnapshot, options: IMCPActionOptions): void {
	if (typeof snapshot.present !== "boolean" || !Array.isArray(snapshot.value)) {
		throw new Error("Physics 2D body snapshots require a boolean present flag and body array.");
	}
	if (!snapshot.present && snapshot.value.length > 0) {
		throw new Error("An absent Physics 2D body snapshot cannot contain hidden body values.");
	}
	if (snapshot.value.length > MaxPhysics2DBodies) {
		throw new Error(`Physics 2D body snapshots support at most ${MaxPhysics2DBodies} bodies.`);
	}
	const nodeIds = new Set<string>();
	for (const value of snapshot.value) {
		const result = normalizePhysics2DBodyConfiguration(value);
		if (!result.ok) {
			throw new Error(result.error);
		}
		if (nodeIds.has(result.value.nodeId)) {
			throw new Error(`Physics 2D body snapshot contains duplicate nodeId "${result.value.nodeId}".`);
		}
		nodeIds.add(result.value.nodeId);
		resolveBodyNode(scene, result.value.nodeId);
		if (result.value.materialId && !(scene.metadata?.babylonEditorPhysics2DMaterials ?? []).some((material: any) => material?.id === result.value.materialId)) {
			throw new Error(`2D physics material "${result.value.materialId}" was not found.`);
		}
	}
	// Publish only after every body, node, and material reference validates, preserving failed-restore atomicity.
	scene.metadata ??= {};
	if (snapshot.present) {
		scene.metadata.babylonEditorPhysics2D = structuredClone(snapshot.value);
	} else {
		delete scene.metadata.babylonEditorPhysics2D;
	}
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
}

/** Captures exact persisted joints, including legacy fields, order, and collection-key presence. */
export function capturePhysics2DJointSnapshot(scene: Scene): IPhysics2DJointCollectionSnapshot {
	const present = Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorPhysics2DJoints");
	const source = present ? scene.metadata.babylonEditorPhysics2DJoints : [];
	if (!Array.isArray(source)) {
		throw new Error("Physics 2D joint metadata must be an array before it can be captured.");
	}
	return { present, value: structuredClone(source) };
}

/** Restores one exact raw joint collection after atomically validating every joint, body, and node reference. */
export function restorePhysics2DJointSnapshot(scene: Scene, snapshot: IPhysics2DJointCollectionSnapshot, options: IMCPActionOptions): void {
	if (typeof snapshot.present !== "boolean" || !Array.isArray(snapshot.value)) {
		throw new Error("Physics 2D joint snapshots require a boolean present flag and joint array.");
	}
	if (!snapshot.present && snapshot.value.length > 0) {
		throw new Error("An absent Physics 2D joint snapshot cannot contain hidden joint values.");
	}
	if (snapshot.value.length > MaxPhysics2DJoints) {
		throw new Error(`Physics 2D joint snapshots support at most ${MaxPhysics2DJoints} joints.`);
	}
	const normalized = normalizePhysics2DJointConfigurations(snapshot.value);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	validatePhysics2DJointConnections(scene, normalized.value);

	// Publish only after all validation succeeds, retaining legacy/unknown raw fields for byte-exact Undo/Redo.
	scene.metadata ??= {};
	if (snapshot.present) {
		scene.metadata.babylonEditorPhysics2DJoints = structuredClone(snapshot.value);
	} else {
		delete scene.metadata.babylonEditorPhysics2DJoints;
	}
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
}

/** Captures the exact persisted collection, including legacy fields and whether the metadata key existed. */
export function capturePhysics2DEffectorSnapshot(scene: Scene): IPhysics2DEffectorCollectionSnapshot {
	const present = Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorPhysics2DEffectors");
	return {
		present,
		value: present ? structuredClone(scene.metadata.babylonEditorPhysics2DEffectors) : [],
	};
}

/** Restores an Inspector/viewport transaction without silently upgrading its raw persisted representation. */
export function restorePhysics2DEffectorSnapshot(scene: Scene, snapshot: IPhysics2DEffectorCollectionSnapshot, options: IMCPActionOptions): void {
	const normalized = normalizePhysics2DEffectorConfigurations(snapshot.value);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	normalized.value.forEach((effector) => validatePhysics2DEffectorAttachment(scene, effector));
	scene.metadata ??= {};
	if (snapshot.present) {
		scene.metadata.babylonEditorPhysics2DEffectors = structuredClone(snapshot.value);
	} else {
		delete scene.metadata.babylonEditorPhysics2DEffectors;
	}
	// Runtime ownership is scene-wide, so an Undo/Redo restore must refresh the same controller used by Play/export.
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
}

function expectPhysics2DRevision(kind: "body" | "joint" | "effector" | "material", id: string, revision: number, expectedRevision: unknown): void {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== revision) {
		throw new Error(`2D ${kind} "${id}" is stale: expected revision ${expectedRevision ?? "missing"}, current revision is ${revision}. Read it again.`);
	}
}

function resolveProjectImagePath(path: string): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	const directory = dirname(projectConfiguration.path);
	const absolutePath = normalize(isAbsolute(path) ? path : join(directory, path));
	if (absolutePath !== directory && !absolutePath.startsWith(`${directory}/`)) {
		throw new Error("Image paths must stay inside the open project directory.");
	}
	return absolutePath;
}

function convexHull(points: IPoint2D[]): IPoint2D[] {
	const sorted = [...new Map(points.map((point) => [`${point[0]},${point[1]}`, point])).values()].sort((first, second) => first[0] - second[0] || first[1] - second[1]);
	if (sorted.length < 3) {
		return sorted;
	}
	const cross = (origin: IPoint2D, first: IPoint2D, second: IPoint2D): number =>
		(first[0] - origin[0]) * (second[1] - origin[1]) - (first[1] - origin[1]) * (second[0] - origin[0]);
	const lower: IPoint2D[] = [];
	for (const point of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
			lower.pop();
		}
		lower.push(point);
	}
	const upper: IPoint2D[] = [];
	for (const point of [...sorted].reverse()) {
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
			upper.pop();
		}
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

/** Traces every opaque 4-connected raster boundary in grid coordinates, retaining holes and disconnected islands. */
function traceOpaqueOutlines(data: Buffer, width: number, height: number, channels: number, alphaThreshold: number, stride: number): IPoint2D[][] {
	const opaque = new Set<string>();
	const columns = Math.ceil(width / stride);
	const rows = Math.ceil(height / stride);
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const offset = (Math.min(height - 1, row * stride) * width + Math.min(width - 1, column * stride)) * channels;
			if (data[offset + 3] >= alphaThreshold) {
				opaque.add(`${column},${row}`);
			}
		}
	}
	if (!opaque.size) {
		throw new Error("Image contains no pixels at or above the requested alpha threshold.");
	}

	const edges = new Map<string, IGridEdge>();
	const addEdge = (first: IGridPoint, second: IGridPoint): void => {
		const key = `${gridPointKey(first)}>${gridPointKey(second)}`;
		const reverse = `${gridPointKey(second)}>${gridPointKey(first)}`;
		if (edges.has(reverse)) {
			edges.delete(reverse);
		} else {
			edges.set(key, { first, second });
		}
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
			if (!next) {
				throw new Error("Could not trace a simple opaque image outline. Use a 4-connected silhouette.");
			}
			edges.delete(`${gridPointKey(next.first)}>${gridPointKey(next.second)}`);
			loop.push(next.second);
		}
		loop.pop();
		const simplified = loop.filter((point, index) => {
			const previous = loop[(index - 1 + loop.length) % loop.length];
			const next = loop[(index + 1) % loop.length];
			return (point[0] - previous[0]) * (next[1] - point[1]) !== (point[1] - previous[1]) * (next[0] - point[0]);
		});
		if (simplified.length >= 3) {
			loops.push(simplified);
		}
	}
	if (!loops.length) {
		throw new Error("Image alpha silhouette does not form a usable polygon collider.");
	}
	return loops
		.map((loop) => loop.map(([column, row]): IPoint2D => [Math.min(width, column * stride), Math.min(height, row * stride)]))
		.sort((first, second) => Math.abs(gridPolygonArea(second)) - Math.abs(gridPolygonArea(first)) || first[0][0] - second[0][0] || first[0][1] - second[0][1]);
}

function pointInGridPolygon(point: IPoint2D, points: IPoint2D[]): boolean {
	let inside = false;
	for (let index = 0; index < points.length; index++) {
		const first = points[index];
		const second = points[(index + 1) % points.length];
		if (first[1] > point[1] !== second[1] > point[1] && point[0] < ((second[0] - first[0]) * (point[1] - first[1])) / (second[1] - first[1]) + first[0]) {
			inside = !inside;
		}
	}
	return inside;
}

function opaqueOutlinesToContours(outlines: IPoint2D[][], width: number, height: number, size: IPoint2D): IPhysics2DPolygonContour[] {
	const records = outlines.map((points, index) => ({
		index,
		points,
		area: Math.abs(gridPolygonArea(points)),
		depth: outlines.reduce((depth, candidate, candidateIndex) => depth + Number(index !== candidateIndex && pointInGridPolygon(points[0], candidate)), 0),
	}));
	const outers = records.filter((record) => record.depth % 2 === 0);
	return outers.map((outer, outerIndex) => {
		const mapPoints = (points: IPoint2D[]): IPoint2D[] => points.map(([x, y]) => [(x / width - 0.5) * size[0], (0.5 - y / height) * size[1]]);
		const holes = records
			.filter((record) => {
				if (record.depth !== outer.depth + 1 || !pointInGridPolygon(record.points[0], outer.points)) {
					return false;
				}
				return !outers.some(
					(candidate) =>
						candidate.index !== outer.index && candidate.depth > outer.depth && candidate.depth < record.depth && pointInGridPolygon(record.points[0], candidate.points)
				);
			})
			.sort((first, second) => second.area - first.area || first.index - second.index)
			.map((hole, holeIndex) => ({ id: `alpha-hole-${outerIndex + 1}-${holeIndex + 1}`, points: mapPoints(hole.points) }));
		return { id: `alpha-contour-${outerIndex + 1}`, points: mapPoints(outer.points), holes };
	});
}

function localPhysics2DPoint(node: any, world: IPoint2D): IPoint2D {
	const x = world[0] - node.position.x;
	const y = world[1] - node.position.y;
	const cosine = Math.cos(node.rotation.z);
	const sine = Math.sin(node.rotation.z);
	return [x * cosine + y * sine, -x * sine + y * cosine];
}

function worldPhysics2DPoint(node: any, local: IPoint2D): IPoint2D {
	const cosine = Math.cos(node.rotation.z);
	const sine = Math.sin(node.rotation.z);
	return [node.position.x + local[0] * cosine - local[1] * sine, node.position.y + local[0] * sine + local[1] * cosine];
}

function createPhysics2DJointCandidate(scene: Scene, data: any): unknown {
	if (data.expectedRevision !== undefined) {
		throw new Error("A new 2D joint does not accept expectedRevision. Omit it and retry.");
	}
	const type = data.type ?? "distance";
	if (!(physics2DJointTypes as readonly unknown[]).includes(type)) {
		throw new Error(`2D joint type must be one of: ${physics2DJointTypes.join(", ")}.`);
	}
	if (!configs(scene).some((body) => body.nodeId === data.firstNodeId)) {
		throw new Error("The first joint node must have a 2D physics body.");
	}
	const first = resolveBodyNode(scene, data.firstNodeId);
	const secondNodeId = data.secondNodeId ?? undefined;
	if (secondNodeId !== undefined && !configs(scene).some((body) => body.nodeId === secondNodeId)) {
		throw new Error("The connected joint node must have a 2D physics body, or be omitted for a world connection.");
	}
	const second = secondNodeId === undefined ? undefined : resolveBodyNode(scene, secondNodeId);
	const firstBody = configs(scene).find((body) => body.nodeId === data.firstNodeId);
	const secondBody = secondNodeId === undefined ? undefined : configs(scene).find((body) => body.nodeId === secondNodeId);
	if (secondBody && (firstBody.worldId ?? "default") !== (secondBody.worldId ?? "default")) {
		throw new Error("A Physics 2D joint cannot connect bodies assigned to different worlds.");
	}
	const candidate: any = { ...structuredClone(data), version: Physics2DJointContractVersion, revision: 1, id: data.id ?? Tools.RandomId(), type };
	delete candidate.anchor;
	delete candidate.expectedRevision;

	if (type === "target") {
		candidate.target ??= [first.position.x, first.position.y];
		return candidate;
	}
	if (type === "relative") {
		candidate.linearOffset ??= second ? localPhysics2DPoint(first, [second.position.x, second.position.y]) : [first.position.x, first.position.y];
		candidate.angularOffset ??= (second?.rotation.z ?? 0) - first.rotation.z;
		return candidate;
	}

	const centerAnchored = type === "distance" || type === "spring";
	const worldAnchor: IPoint2D =
		data.anchor ??
		(centerAnchored
			? [first.position.x, first.position.y]
			: second
				? [(first.position.x + second.position.x) / 2, (first.position.y + second.position.y) / 2]
				: [first.position.x, first.position.y]);
	candidate.firstAnchor ??= centerAnchored && data.anchor === undefined ? [0, 0] : localPhysics2DPoint(first, worldAnchor);
	candidate.secondAnchor ??= second ? (centerAnchored && data.anchor === undefined ? [0, 0] : localPhysics2DPoint(second, worldAnchor)) : worldAnchor;
	candidate.autoConfigureConnectedAnchor ??= false;
	if ((type === "distance" || type === "spring") && candidate.distance === undefined) {
		const firstWorld = worldPhysics2DPoint(first, candidate.firstAnchor);
		const secondWorld = second ? worldPhysics2DPoint(second, candidate.secondAnchor) : candidate.secondAnchor;
		candidate.distance = Math.hypot(secondWorld[0] - firstWorld[0], secondWorld[1] - firstWorld[1]);
	}
	if (["fixed", "hinge", "slider"].includes(type)) {
		candidate.referenceAngle ??= (second?.rotation.z ?? 0) - first.rotation.z;
	}
	return candidate;
}

function physics2DJointUpdateFields(type: string): Set<string> {
	const fields = new Set(["enabled", "firstNodeId", "secondNodeId", "enableCollision", "worldDrawing", "breakAction", "breakForce", "breakTorque"]);
	if (!["relative", "target"].includes(type)) {
		["firstAnchor", "secondAnchor", "autoConfigureConnectedAnchor"].forEach((field) => fields.add(field));
	}
	const typeFields: Record<string, string[]> = {
		distance: ["distance", "maxDistanceOnly"],
		fixed: ["referenceAngle", "frequency", "dampingRatio"],
		friction: ["maxForce", "maxTorque"],
		hinge: ["referenceAngle", "useLimits", "minAngle", "maxAngle", "useMotor", "motorSpeed", "maxMotorTorque"],
		relative: ["linearOffset", "angularOffset", "maxForce", "maxTorque", "correctionScale"],
		slider: ["angle", "referenceAngle", "useLimits", "lowerTranslation", "upperTranslation", "useMotor", "motorSpeed", "maxMotorForce"],
		spring: ["distance", "frequency", "dampingRatio"],
		target: ["target", "maxForce", "frequency", "dampingRatio"],
		wheel: ["angle", "frequency", "dampingRatio", "useMotor", "motorSpeed", "maxMotorTorque"],
	};
	typeFields[type]?.forEach((field) => fields.add(field));
	return fields;
}

/** Lists every persisted Unity-compatible 2D joint through the canonical detached contract. */
export function listPhysics2DJoints(scene: Scene): any {
	return { joints: readPhysics2DJoints(scene) };
}
/** Creates one validated 2D joint between a body and another body or the fixed world. */
export function createPhysics2DJoint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DJoints(scene);
	const candidate = createPhysics2DJointCandidate(scene, data);
	const committed = commitPhysics2DJoints(scene, [...current, candidate]);
	const value = committed[committed.length - 1];
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Applies one exact-revision joint patch atomically. */
export function setPhysics2DJoint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DJoints(scene);
	const index = current.findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`2D joint "${data.id}" was not found.`);
	}
	const joint = current[index];
	expectPhysics2DRevision("joint", joint.id, joint.revision, data.expectedRevision);
	if (data.type !== undefined && data.type !== joint.type) {
		throw new Error(`2D joint "${joint.id}" is ${joint.type}; its family cannot be changed to ${data.type}.`);
	}
	const allowed = physics2DJointUpdateFields(joint.type);
	const requested = Object.keys(data).filter((key) => !["id", "expectedRevision", "type", "endpoint", "collaborationToken"].includes(key));
	const invalid = requested.find((key) => !allowed.has(key));
	if (invalid) {
		throw new Error(`2D ${joint.type} joint field "${invalid}" cannot be updated.`);
	}
	const candidate: any = { ...structuredClone(joint), revision: joint.revision + 1 };
	for (const property of requested) {
		if (["secondNodeId", "breakForce", "breakTorque"].includes(property) && data[property] === null) {
			delete candidate[property];
		} else {
			candidate[property] = structuredClone(data[property]);
		}
	}
	if (
		!configs(scene).some((body) => body.nodeId === candidate.firstNodeId) ||
		(candidate.secondNodeId !== undefined && !configs(scene).some((body) => body.nodeId === candidate.secondNodeId))
	) {
		throw new Error("Updated 2D joint connections must reference authored 2D bodies, or omit secondNodeId for the fixed world.");
	}
	const firstBody = configs(scene).find((body) => body.nodeId === candidate.firstNodeId);
	const secondBody = candidate.secondNodeId === undefined ? undefined : configs(scene).find((body) => body.nodeId === candidate.secondNodeId);
	if (secondBody && (firstBody.worldId ?? "default") !== (secondBody.worldId ?? "default")) {
		throw new Error("Updated Physics 2D joint connections cannot cross world boundaries.");
	}
	resolveBodyNode(scene, candidate.firstNodeId);
	if (candidate.secondNodeId !== undefined) {
		resolveBodyNode(scene, candidate.secondNodeId);
	}
	const next = [...current];
	next[index] = candidate;
	const committed = commitPhysics2DJoints(scene, next);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(committed[index]);
}
/** Removes one exact-revision joint while keeping its bodies and nodes. */
export function deletePhysics2DJoint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DJoints(scene);
	const index = current.findIndex((joint) => joint.id === data.id);
	if (index === -1) {
		throw new Error(`2D joint "${data.id}" was not found.`);
	}
	expectPhysics2DRevision("joint", current[index].id, current[index].revision, data.expectedRevision);
	commitPhysics2DJoints(
		scene,
		current.filter((_, candidateIndex) => candidateIndex !== index)
	);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Restores persisted 2D bodies through the shared editor/export runtime. */
export function restorePhysics2D(scene: Scene): void {
	configurePhysics2D(scene);
}

/** Lists authored 2D bodies, shared live velocities, contacts, and deterministic step evidence. */
export function listPhysics2D(scene: Scene): any {
	configurePhysics2D(scene);
	const simulation = getPhysics2DSimulationControl(scene);
	return {
		bodies: structuredClone(bodyMetadata(scene)).map((config) => {
			const state = getPhysics2DBodyRuntimeState(scene, config.nodeId);
			return {
				...config,
				version: config.version ?? Physics2DBodyContractVersion,
				revision: bodyRevision(config),
				material: config.materialId ? structuredClone(findMaterial(scene, config.materialId)) : null,
				active: state.active,
				velocity: state.active ? state.velocity : (config.velocity ?? [0, 0]),
				angularVelocity: state.active ? state.angularVelocity : (config.angularVelocity ?? 0),
				runtime: state,
			};
		}),
		collisions: simulation.collisions,
		triggers: simulation.triggers,
		settings: structuredClone(readPhysics2DSettings(scene)),
		simulation,
	};
}

/** Resolves one authored body under the exact persisted revision used to authorize a transient command. */
function exactPhysics2DBody(scene: Scene, nodeId: string, expectedRevision: unknown): any {
	const config = bodyMetadata(scene).find((candidate) => candidate?.nodeId === nodeId);
	if (!config) {
		throw new Error(`No 2D physics body is attached to node "${nodeId}".`);
	}
	expectPhysics2DRevision("body", nodeId, bodyRevision(config), expectedRevision);
	return config;
}

/** Applies a transient force/impulse without changing authored body metadata. */
export function applyPhysics2DBodyForce(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = exactPhysics2DBody(scene, data.nodeId, data.expectedRevision);
	configurePhysics2D(scene);
	const state = applyPhysics2DForce(scene as any, data.nodeId, data.value, data.mode ?? "force", data.worldPoint);
	options.editor.layout.inspector.forceUpdate();
	return { nodeId: data.nodeId, revision: bodyRevision(config), persistedStateChanged: false, runtime: state };
}

/** Applies transient torque/angular impulse without changing authored body metadata. */
export function applyPhysics2DBodyTorque(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = exactPhysics2DBody(scene, data.nodeId, data.expectedRevision);
	configurePhysics2D(scene);
	const state = applyPhysics2DTorque(scene as any, data.nodeId, data.value, data.mode ?? "force");
	options.editor.layout.inspector.forceUpdate();
	return { nodeId: data.nodeId, revision: bodyRevision(config), persistedStateChanged: false, runtime: state };
}

/** Replaces transient linear/angular velocity without changing authored defaults. */
export function setPhysics2DRuntimeVelocity(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = exactPhysics2DBody(scene, data.nodeId, data.expectedRevision);
	configurePhysics2D(scene);
	const state = setPhysics2DBodyRuntimeVelocity(scene as any, data.nodeId, data.velocity, data.angularVelocity);
	options.editor.layout.inspector.forceUpdate();
	return { nodeId: data.nodeId, revision: bodyRevision(config), persistedStateChanged: false, runtime: state };
}

/** Reads persisted lightweight 2D solver settings. */
export function getPhysics2DSettings(scene: Scene): any {
	return structuredClone(readPhysics2DSettings(scene));
}
/** Updates persisted lightweight 2D solver settings used by preview and exported runtime. */
export function setPhysics2DSettings(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DSettings(scene);
	if (data.expectedRevision !== undefined && data.expectedRevision !== current.revision) {
		throw new Error(`2D physics settings are stale: expected revision ${data.expectedRevision}, current revision is ${current.revision}. Read them again.`);
	}
	const allowed = new Set([
		"solverIterations",
		"velocityIterations",
		"positionIterations",
		"maximumWorlds",
		"globalTransformReadMode",
		"renderingAvailableInRelease",
		"expectedRevision",
		"endpoint",
		"collaborationToken",
	]);
	const invalid = Object.keys(data).find((key) => !allowed.has(key));
	if (invalid) {
		throw new Error(`2D physics settings field "${invalid}" is not supported.`);
	}
	const legacy = data.solverIterations;
	if (legacy !== undefined) {
		const legacyValidation = normalizePhysics2DSettingsConfiguration({ solverIterations: legacy });
		if (!legacyValidation.ok) {
			throw new Error(legacyValidation.error);
		}
	}
	const candidate = {
		...current,
		revision: current.revision + 1,
		maximumWorlds: data.maximumWorlds ?? current.maximumWorlds,
		globalTransformReadMode: data.globalTransformReadMode ?? current.globalTransformReadMode,
		renderingAvailableInRelease: data.renderingAvailableInRelease ?? current.renderingAvailableInRelease,
		velocityIterations: data.velocityIterations !== undefined ? data.velocityIterations : legacy !== undefined ? legacy : current.velocityIterations,
		positionIterations: data.positionIterations !== undefined ? data.positionIterations : legacy !== undefined ? legacy : current.positionIterations,
		worlds: current.worlds.map((world: any) =>
			world.id === "default"
				? {
						...world,
						velocityIterations: data.velocityIterations !== undefined ? data.velocityIterations : legacy !== undefined ? legacy : world.velocityIterations,
						positionIterations: data.positionIterations !== undefined ? data.positionIterations : legacy !== undefined ? legacy : world.positionIterations,
					}
				: world
		),
	};
	const normalized = normalizePhysics2DSettingsConfiguration(candidate);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	// Assign only after the complete patch validates so mixed valid/invalid fields cannot partially persist.
	commitPhysics2DSettings(scene, normalized.value, options);
	return structuredClone(normalized.value);
}

/** Creates one bounded scene-owned Physics 2D world under the exact settings revision. */
export function createPhysics2DWorld(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DSettings(scene);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`2D physics settings are stale: expected revision ${data.expectedRevision}, current revision is ${current.revision}. Read them again.`);
	}
	if (current.worlds.some((world: any) => world.id === data.id)) {
		throw new Error(`Physics 2D world "${data.id}" already exists.`);
	}
	const candidate = { ...current, revision: current.revision + 1, worlds: [...current.worlds, { ...structuredClone(data), name: data.name ?? data.id }] };
	delete candidate.worlds[candidate.worlds.length - 1].expectedRevision;
	delete candidate.worlds[candidate.worlds.length - 1].endpoint;
	delete candidate.worlds[candidate.worlds.length - 1].collaborationToken;
	const normalized = normalizePhysics2DSettingsConfiguration(candidate);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	commitPhysics2DSettings(scene, normalized.value, options);
	return structuredClone(normalized.value.worlds.find((world) => world.id === data.id));
}

/** Atomically updates one Physics 2D world under the exact scene-settings revision. */
export function setPhysics2DWorld(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DSettings(scene);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`2D physics settings are stale: expected revision ${data.expectedRevision}, current revision is ${current.revision}. Read them again.`);
	}
	const index = current.worlds.findIndex((world: any) => world.id === data.id);
	if (index === -1) {
		throw new Error(`Physics 2D world "${data.id}" was not found.`);
	}
	const patch = structuredClone(data);
	delete patch.id;
	delete patch.expectedRevision;
	delete patch.endpoint;
	delete patch.collaborationToken;
	const worlds = structuredClone(current.worlds);
	worlds[index] = { ...worlds[index], ...patch };
	const normalized = normalizePhysics2DSettingsConfiguration({ ...current, revision: current.revision + 1, worlds });
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	commitPhysics2DSettings(scene, normalized.value, options);
	return structuredClone(normalized.value.worlds[index]);
}

/** Deletes an unused non-default world under the exact scene-settings revision. */
export function deletePhysics2DWorld(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DSettings(scene);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`2D physics settings are stale: expected revision ${data.expectedRevision}, current revision is ${current.revision}. Read them again.`);
	}
	if (data.id === "default") {
		throw new Error("The default Physics 2D world cannot be deleted.");
	}
	if (!current.worlds.some((world: any) => world.id === data.id)) {
		throw new Error(`Physics 2D world "${data.id}" was not found.`);
	}
	if (bodyMetadata(scene).some((body) => (body.worldId ?? "default") === data.id)) {
		throw new Error(`Physics 2D world "${data.id}" still owns bodies. Reassign them before deleting it.`);
	}
	const normalized = normalizePhysics2DSettingsConfiguration({ ...current, revision: current.revision + 1, worlds: current.worlds.filter((world: any) => world.id !== data.id) });
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	commitPhysics2DSettings(scene, normalized.value, options);
	return { deleted: true, id: data.id, settingsRevision: normalized.value.revision };
}

/** Returns the shared bounded per-camera debug render plan without creating scene nodes. */
export function getPhysics2DDebugRendering(scene: Scene, data: any): any {
	return getPhysics2DDebugSnapshot(scene as any, data);
}

function validatePhysics2DEffectorAttachment(scene: Scene, effector: IPhysics2DEffectorConfiguration): void {
	resolveBodyNode(scene, effector.nodeId);
	if (["platform", "buoyancy"].includes(effector.type) && configs(scene).find((body) => body.nodeId === effector.nodeId)?.bodyType !== "static") {
		throw new Error(`2D ${effector.type === "platform" ? "Platform" : "Buoyancy"} Effectors require a static 2D body on the same node.`);
	}
}

const physics2DEffectorCommonFields = ["nodeId", "type", "enabled", "useColliderMask", "colliderMask"];
const physics2DEffectorFieldsByType: Record<string, string[]> = {
	point: ["radius", "force", "falloff", "forceMagnitude", "forceVariation", "distanceScale", "linearDrag", "angularDrag", "forceSource", "forceTarget", "forceMode"],
	area: ["radius", "force", "falloff", "forceMagnitude", "forceVariation", "linearDrag", "angularDrag", "forceTarget", "useGlobalAngle", "forceAngle"],
	surface: ["radius", "force", "falloff", "surfaceThickness", "speed", "speedVariation", "forceScale", "useContactForce", "useFriction", "useBounce"],
	platform: ["platformAngle", "rotationalOffset", "useOneWay", "useOneWayGrouping", "surfaceArc", "useSideFriction", "useSideBounce", "sideArc"],
	buoyancy: ["surfaceLevel", "density", "linearDrag", "angularDrag", "flowAngle", "flowMagnitude", "flowVariation"],
};

/** Rejects cross-type or unknown fields before normalization can harmlessly but misleadingly ignore them. */
function validatePhysics2DEffectorFields(data: any, type: unknown, ignored: string[]): string[] {
	const allowed = new Set([...physics2DEffectorCommonFields, ...(typeof type === "string" ? (physics2DEffectorFieldsByType[type] ?? []) : [])]);
	const requested = Object.keys(data).filter((key) => !ignored.includes(key));
	const invalid = requested.find((key) => !allowed.has(key));
	if (invalid) {
		throw new Error(`2D ${typeof type === "string" ? type : "unknown"} effector field "${invalid}" is not valid for that type.`);
	}
	return requested;
}

/** Lists every node-bound 2D effector through the canonical detached contract. */
export function listPhysics2DEffectors(scene: Scene): any {
	return { effectors: readPhysics2DEffectors(scene) };
}
/** Creates a validated Point, Area, Surface, Platform, or Buoyancy effector. */
export function createPhysics2DEffector(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.expectedRevision !== undefined) {
		throw new Error("A new 2D effector does not accept expectedRevision. Omit it and retry.");
	}
	validatePhysics2DEffectorFields(data, data.type ?? "point", ["id", "endpoint", "collaborationToken"]);
	const current = readPhysics2DEffectors(scene);
	const candidate: any = { ...structuredClone(data), version: Physics2DEffectorContractVersion, revision: 1, id: data.id ?? Tools.RandomId() };
	if (candidate.type === "platform" && data.platformAngle !== undefined && data.rotationalOffset === undefined) {
		// platformAngle was the pre-v2 world-space API; preserve it until the caller explicitly adopts local rotationalOffset.
		candidate.usesLegacyWorldAngle = true;
	}
	const normalized = normalizePhysics2DEffectorConfigurations([candidate]);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	validatePhysics2DEffectorAttachment(scene, normalized.value[0]);
	const committed = commitPhysics2DEffectors(scene, [...current, normalized.value[0]]);
	const value = committed[committed.length - 1];
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Applies one exact-revision effector patch atomically. */
export function setPhysics2DEffector(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DEffectors(scene);
	const index = current.findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`2D effector "${data.id}" was not found.`);
	}
	const effector = current[index];
	expectPhysics2DRevision("effector", effector.id, effector.revision, data.expectedRevision);
	const requested = validatePhysics2DEffectorFields(data, data.type ?? effector.type, ["id", "expectedRevision", "endpoint", "collaborationToken"]);
	const candidate: any = { ...structuredClone(effector), revision: effector.revision + 1 };
	requested.forEach((property) => (candidate[property] = structuredClone(data[property])));
	if (candidate.type === "platform" && requested.includes("platformAngle") && !requested.includes("rotationalOffset")) {
		candidate.usesLegacyWorldAngle = true;
	} else if (candidate.type === "platform" && requested.includes("rotationalOffset")) {
		candidate.usesLegacyWorldAngle = false;
	}
	const normalized = normalizePhysics2DEffectorConfigurations([candidate]);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	validatePhysics2DEffectorAttachment(scene, normalized.value[0]);
	const next = [...current];
	next[index] = normalized.value[0];
	const committed = commitPhysics2DEffectors(scene, next);
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(committed[index]);
}
/** Deletes one exact-revision effector while keeping its scene node. */
export function deletePhysics2DEffector(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DEffectors(scene);
	const index = current.findIndex((effector) => effector.id === data.id);
	if (index === -1) {
		throw new Error(`2D effector "${data.id}" was not found.`);
	}
	expectPhysics2DRevision("effector", current[index].id, current[index].revision, data.expectedRevision);
	commitPhysics2DEffectors(
		scene,
		current.filter((_, candidateIndex) => candidateIndex !== index)
	);
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Lists reusable 2D physics materials with friction and restitution response. */
export function listPhysics2DMaterials(scene: Scene): any {
	return { materials: structuredClone(readPhysics2DMaterials(scene)) };
}
/** Creates a reusable 2D physics material. */
export function createPhysics2DMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DMaterials(scene);
	const value = normalizePhysics2DMaterial({
		version: Physics2DMaterialContractVersion,
		revision: 1,
		id: data.id ?? Tools.RandomId(),
		name: data.name,
		friction: data.friction ?? 0.4,
		restitution: data.restitution ?? 0,
	});
	if (current.some((material) => material.id === value.id || material.name === value.name)) {
		throw new Error(`2D physics material "${value.name}" already exists.`);
	}
	commitPhysics2DMaterials(scene, [...current, value]);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Updates a reusable 2D physics material. */
export function setPhysics2DMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DMaterials(scene);
	const index = current.findIndex((material) => material.id === data.id);
	if (index === -1) {
		throw new Error(`2D physics material "${data.id}" was not found.`);
	}
	const material = current[index];
	if (data.expectedRevision !== undefined) {
		expectPhysics2DRevision("material", material.id, material.revision, data.expectedRevision);
	}
	const value = normalizePhysics2DMaterial({
		...material,
		revision: material.revision + 1,
		...(data.name !== undefined ? { name: data.name } : {}),
		...(data.friction !== undefined ? { friction: data.friction } : {}),
		...(data.restitution !== undefined ? { restitution: data.restitution } : {}),
	});
	if (current.some((candidate, candidateIndex) => candidateIndex !== index && candidate.name === value.name)) {
		throw new Error(`2D physics material "${value.name}" already exists.`);
	}
	const next = [...current];
	next[index] = value;
	commitPhysics2DMaterials(scene, next);
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Deletes an unused 2D physics material. Bodies must be reassigned first. */
export function deletePhysics2DMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = readPhysics2DMaterials(scene);
	const index = current.findIndex((material) => material.id === data.id);
	if (index === -1) {
		throw new Error(`2D physics material "${data.id}" was not found.`);
	}
	const material = current[index];
	if (data.expectedRevision !== undefined) {
		expectPhysics2DRevision("material", material.id, material.revision, data.expectedRevision);
	}
	if (configs(scene).some((config) => config.materialId === material.id)) {
		throw new Error(`2D physics material "${material.name}" is assigned to one or more bodies.`);
	}
	commitPhysics2DMaterials(
		scene,
		current.filter((_, candidateIndex) => candidateIndex !== index)
	);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

function polygonRevision(collider: any): number {
	return Number.isSafeInteger(collider?.revision) && collider.revision >= 1 ? collider.revision : 1;
}

/** Treats unversioned legacy bodies as revision one for their first guarded upgrade. */
function bodyRevision(config: any): number {
	return Number.isSafeInteger(config?.revision) && config.revision >= 1 ? config.revision : 1;
}

function normalizePolygonCollider(nodeId: string, collider: any, existingCollider?: any): any {
	const contours = Array.isArray(collider.contours)
		? collider.contours
		: [
				{
					id:
						existingCollider?.version === 2 && existingCollider.contours?.length === 1 && !existingCollider.contours[0].holes?.length
							? existingCollider.contours[0].id
							: `polygon-${nodeId}-outer-1`,
					points: collider.points,
					holes: [],
				},
			];
	const decomposition = decomposePhysics2DPolygonContours(contours);
	const revision =
		Number.isSafeInteger(collider.revision) && collider.revision >= 1 ? collider.revision : existingCollider?.shape === "polygon" ? polygonRevision(existingCollider) + 1 : 1;
	return {
		shape: "polygon",
		version: 2,
		revision,
		model: decomposition.model,
		contours: decomposition.contours,
		points: decomposition.contours[0].points,
		parts: decomposition.parts,
		outerCount: decomposition.outerCount,
		holeCount: decomposition.holeCount,
		vertexCount: decomposition.vertexCount,
		filledArea: decomposition.filledArea,
		decomposedArea: decomposition.decomposedArea,
	};
}

function polygonColliderState(config: any): any {
	if (!config || config.collider?.shape !== "polygon") {
		throw new Error(`Node "${config?.nodeId ?? "unknown"}" does not have a 2D polygon collider. Add one and retry.`);
	}
	const collider = normalizePolygonCollider(config.nodeId, { ...config.collider, revision: polygonRevision(config.collider) }, config.collider);
	return {
		nodeId: config.nodeId,
		bodyType: config.bodyType,
		version: collider.version,
		revision: collider.revision,
		model: collider.model,
		contours: collider.contours,
		parts: collider.parts,
		outerCount: collider.outerCount,
		holeCount: collider.holeCount,
		vertexCount: collider.vertexCount,
		filledArea: collider.filledArea,
		decomposedArea: collider.decomposedArea,
		legacyMigratedView: config.collider.version !== 2,
	};
}

/** Derives canonical rectangular collision pieces for an Edge Collider 2D polyline. */
function physics2DEdgeParts(points: IPoint2D[], radius: number): IPoint2D[][] {
	const parts: IPoint2D[][] = [];
	for (let index = 0; index < points.length - 1; index++) {
		const first = points[index];
		const second = points[index + 1];
		const dx = second[0] - first[0];
		const dy = second[1] - first[1];
		const length = Math.hypot(dx, dy);
		if (length <= 0.000001) {
			throw new Error("Edge colliders require distinct consecutive points.");
		}
		const normal: IPoint2D = [(-dy * radius) / length, (dx * radius) / length];
		parts.push([
			[first[0] + normal[0], first[1] + normal[1]],
			[second[0] + normal[0], second[1] + normal[1]],
			[second[0] - normal[0], second[1] - normal[1]],
			[first[0] - normal[0], first[1] - normal[1]],
		]);
	}
	return parts;
}

/** Adds or replaces an authored 2D rigidbody and collider on a scene node. */
export function setPhysics2DBody(scene: Scene, data: any, options: IMCPActionOptions): any {
	resolveBodyNode(scene, data.nodeId);
	const existing = configs(scene).find((config) => config.nodeId === data.nodeId);
	const worldId = data.worldId ?? existing?.worldId ?? "default";
	if (!readPhysics2DSettings(scene).worlds.some((world: any) => world.id === worldId)) {
		throw new Error(`Physics 2D world "${worldId}" was not found. Create it or choose an existing world.`);
	}
	if (existing) {
		const currentRevision = bodyRevision(existing);
		if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== currentRevision) {
			throw new Error(`2D physics body is stale: expected revision ${data.expectedRevision ?? "missing"}, current revision is ${currentRevision}. Read it again.`);
		}
	} else if (data.expectedRevision !== undefined && data.expectedRevision !== 0) {
		throw new Error("A new 2D physics body requires expectedRevision 0.");
	}
	const collider = structuredClone(data.collider ?? existing?.collider ?? { shape: "box", size: [100, 100] });
	if (collider.shape === "circle" && !(collider.radius > 0)) {
		throw new Error("Circle colliders require a positive radius.");
	}
	if (collider.shape === "box" && (!Array.isArray(collider.size) || collider.size.length !== 2 || collider.size.some((value: number) => value <= 0))) {
		throw new Error("Box colliders require a positive [width, height] size.");
	}
	if (collider.shape === "polygon") {
		if (collider.delaunayFlipCount !== undefined && (!Number.isSafeInteger(collider.delaunayFlipCount) || collider.delaunayFlipCount < 0)) {
			throw new Error("Polygon collider delaunayFlipCount must be a non-negative safe integer when provided.");
		}
		Object.assign(collider, normalizePolygonCollider(data.nodeId, collider, existing?.collider));
	}
	if (collider.shape === "edge") {
		if (
			!Array.isArray(collider.points) ||
			collider.points.length < 2 ||
			collider.points.length > 512 ||
			collider.points.some((point: unknown) => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))
		) {
			throw new Error("Edge colliders require 2 through 512 finite [x, y] points.");
		}
		if (!(collider.edgeRadius > 0) || !Number.isFinite(collider.edgeRadius)) {
			throw new Error("Edge colliders require a positive finite edgeRadius.");
		}
		collider.parts = physics2DEdgeParts(collider.points, collider.edgeRadius);
	}
	const materialId = data.materialId !== undefined ? data.materialId : existing?.materialId;
	if (materialId !== undefined && materialId !== null && (typeof materialId !== "string" || !materialId.trim())) {
		throw new Error("2D physics materialId must be a non-empty string or null to clear it.");
	}
	if (typeof materialId === "string") {
		findMaterial(scene, materialId);
	}
	const collisionLayer = data.collisionLayer ?? existing?.collisionLayer ?? 0;
	if (!Number.isInteger(collisionLayer) || collisionLayer < 0 || collisionLayer > 31) {
		throw new Error("2D physics collisionLayer must be an integer from 0 through 31.");
	}
	const layerOverrides = structuredClone(data.layerOverrides !== undefined ? data.layerOverrides : (existing?.layerOverrides ?? {}));
	if (!layerOverrides || typeof layerOverrides !== "object" || Array.isArray(layerOverrides)) {
		throw new Error("2D physics layerOverrides must be an object of bounded layer masks.");
	}
	const layerOverridePriority = layerOverrides.priority ?? 0;
	if (!Number.isInteger(layerOverridePriority) || layerOverridePriority < -128 || layerOverridePriority > 127) {
		throw new Error("2D physics layer override priority must be an integer from -128 through 127.");
	}
	for (const key of ["includeLayers", "excludeLayers", "forceSendLayers", "forceReceiveLayers", "contactCaptureLayers", "callbackLayers"]) {
		const fallback = key === "includeLayers" || key === "excludeLayers" ? 0 : 0xffffffff;
		const value = layerOverrides[key] ?? fallback;
		if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
			throw new Error(`2D physics ${key} must be an unsigned 32-bit layer mask.`);
		}
		layerOverrides[key] = value >>> 0;
	}
	layerOverrides.priority = layerOverridePriority;
	const friction = data.friction !== undefined ? data.friction : existing?.friction;
	const restitution = data.restitution !== undefined ? data.restitution : existing?.restitution;
	const candidate = {
		version: Physics2DBodyContractVersion,
		revision: existing ? bodyRevision(existing) + 1 : 1,
		nodeId: data.nodeId,
		worldId,
		worldDrawing: data.worldDrawing ?? existing?.worldDrawing ?? false,
		bodyType: data.bodyType ?? existing?.bodyType ?? "dynamic",
		collider,
		velocity: data.velocity ?? existing?.velocity ?? [0, 0],
		angularVelocity: data.angularVelocity ?? existing?.angularVelocity ?? 0,
		mass: data.mass ?? existing?.mass ?? 1,
		useAutoMass: data.useAutoMass ?? existing?.useAutoMass ?? false,
		inertia: data.inertia ?? existing?.inertia ?? 1,
		useAutoInertia: data.useAutoInertia ?? existing?.useAutoInertia ?? true,
		centerOfMass: data.centerOfMass ?? existing?.centerOfMass ?? [0, 0],
		useAutoCenterOfMass: data.useAutoCenterOfMass ?? existing?.useAutoCenterOfMass ?? true,
		gravity: data.gravity ?? existing?.gravity ?? [0, -981],
		gravityScale: data.gravityScale ?? existing?.gravityScale ?? 1,
		linearDamping: data.linearDamping ?? existing?.linearDamping ?? 0,
		angularDamping: data.angularDamping ?? existing?.angularDamping ?? 0.05,
		freezePositionX: data.freezePositionX ?? existing?.freezePositionX ?? false,
		freezePositionY: data.freezePositionY ?? existing?.freezePositionY ?? false,
		freezeRotation: data.freezeRotation ?? existing?.freezeRotation ?? false,
		collisionDetection: data.collisionDetection ?? existing?.collisionDetection ?? "discrete",
		...(typeof materialId === "string" ? { materialId } : {}),
		...(friction !== null && friction !== undefined ? { friction } : {}),
		...(restitution !== null && restitution !== undefined ? { restitution } : {}),
		isTrigger: data.isTrigger ?? existing?.isTrigger ?? false,
		usedByEffector: data.usedByEffector ?? existing?.usedByEffector ?? false,
		collisionLayer,
		layerOverrides,
		enabled: data.enabled ?? existing?.enabled ?? true,
	};
	for (const joint of readPhysics2DJoints(scene).filter((joint) => joint.firstNodeId === data.nodeId || joint.secondNodeId === data.nodeId)) {
		const peerNodeId = joint.firstNodeId === data.nodeId ? joint.secondNodeId : joint.firstNodeId;
		const peer = peerNodeId ? configs(scene).find((body) => body.nodeId === peerNodeId) : undefined;
		if (peer && (peer.worldId ?? "default") !== worldId) {
			throw new Error(`Physics 2D body "${data.nodeId}" cannot move to world "${worldId}" while joint "${joint.id}" connects it to world "${peer.worldId ?? "default"}".`);
		}
	}
	const normalized = normalizePhysics2DBodyConfiguration(candidate);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	// Polygon authoring diagnostics are derived and safe to retain beside the shared canonical collider fields.
	const colliderDiagnostics =
		collider.shape === "polygon"
			? Object.fromEntries(
					["outerCount", "holeCount", "vertexCount", "filledArea", "decomposedArea", "delaunayFlipCount"]
						.filter((key) => collider[key] !== undefined)
						.map((key) => [key, collider[key]])
				)
			: {};
	const config = { ...normalized.value, collider: { ...normalized.value.collider, ...colliderDiagnostics } };
	if (existing) {
		configs(scene)[configs(scene).indexOf(existing)] = config;
	} else {
		configs(scene).push(config);
	}
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(config), active: true };
}

/** Reads one polygon collider's exact revision, authored outer/hole rings, and derived convex collision parts. */
export function getPhysics2DPolygonCollider(scene: Scene, data: any): any {
	resolveBodyNode(scene, data.nodeId);
	const config = configs(scene).find((candidate) => candidate.nodeId === data.nodeId);
	if (!config) {
		throw new Error(`No 2D physics body is attached to node "${data.nodeId}". Add one and retry.`);
	}
	return polygonColliderState(config);
}

/** Creates or exact-revision replaces a compound polygon collider with disconnected outer contours and holes. */
export function setPhysics2DPolygonCollider(scene: Scene, data: any, options: IMCPActionOptions): any {
	resolveBodyNode(scene, data.nodeId);
	const existing = configs(scene).find((candidate) => candidate.nodeId === data.nodeId);
	const existingPolygon = existing?.collider?.shape === "polygon" ? existing.collider : null;
	if (existingPolygon) {
		const currentRevision = polygonRevision(existingPolygon);
		if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== currentRevision) {
			throw new Error(`2D polygon collider is stale: expected revision ${data.expectedRevision ?? "missing"}, current revision is ${currentRevision}. Read it again.`);
		}
	} else if (data.expectedRevision !== undefined && data.expectedRevision !== 0) {
		throw new Error("A new 2D polygon collider requires expectedRevision 0.");
	}
	const decomposition = decomposePhysics2DPolygonContours(data.contours);
	const revision = existingPolygon ? polygonRevision(existingPolygon) + 1 : 1;
	const collider = {
		shape: "polygon",
		offset: existingPolygon?.offset ?? [0, 0],
		density: existingPolygon?.density ?? 0.001,
		version: 2,
		revision,
		model: decomposition.model,
		contours: decomposition.contours,
		points: decomposition.contours[0].points,
		parts: decomposition.parts,
		outerCount: decomposition.outerCount,
		holeCount: decomposition.holeCount,
		vertexCount: decomposition.vertexCount,
		filledArea: decomposition.filledArea,
		decomposedArea: decomposition.decomposedArea,
	};
	setPhysics2DBody(scene, { nodeId: data.nodeId, expectedRevision: existing ? bodyRevision(existing) : undefined, collider }, options);
	return getPhysics2DPolygonCollider(scene, { nodeId: data.nodeId });
}

/** Generates a convex, concave, or compound holes/islands polygon collider from raster alpha. */
export async function generatePhysics2DPolygonCollider(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	resolveBodyNode(scene, data.nodeId);
	const starting = configs(scene).find((candidate) => candidate.nodeId === data.nodeId);
	const startingRevision = starting?.collider?.shape === "polygon" ? polygonRevision(starting.collider) : 0;
	if (data.expectedRevision !== undefined && data.expectedRevision !== startingRevision) {
		throw new Error(`2D polygon collider is stale: expected revision ${data.expectedRevision}, current revision is ${startingRevision}. Read it again.`);
	}
	const absolutePath = resolveProjectImagePath(data.imagePath);
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Image asset not found: ${data.imagePath}`);
	}
	const size: IPoint2D = data.size ?? [100, 100];
	if (!Array.isArray(size) || size.length !== 2 || size.some((value: number) => !(value > 0) || !Number.isFinite(value))) {
		throw new Error("size must be a positive [width, height] in centimeters.");
	}
	const alphaThreshold = data.alphaThreshold ?? 1;
	if (!Number.isInteger(alphaThreshold) || alphaThreshold < 0 || alphaThreshold > 255) {
		throw new Error("alphaThreshold must be an integer from 0 to 255.");
	}
	const image = await sharp(absolutePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	const channels = image.info.channels ?? 4;
	const maxVertices = data.maxVertices ?? 32;
	if (!Number.isInteger(maxVertices) || maxVertices < 3 || maxVertices > 512) {
		throw new Error("maxVertices must be an integer from 3 to 512.");
	}
	const outline = data.outline ?? "convex";
	if (outline !== "convex" && outline !== "concave" && outline !== "compound") {
		throw new Error('outline must be "convex", "concave", or "compound".');
	}
	if (outline !== "compound" && maxVertices > 64) {
		throw new Error("Convex and concave outlines support at most 64 vertices; use compound for up to 512.");
	}
	let stride = Math.max(1, Math.ceil(Math.max(image.info.width, image.info.height) / 256));
	let sourcePoints: IPoint2D[] = [];
	let contours: IPhysics2DPolygonContour[] | null = null;
	if (outline === "compound") {
		while (true) {
			const outlines = traceOpaqueOutlines(image.data, image.info.width, image.info.height, channels, alphaThreshold, stride);
			if (outlines.reduce((total, points) => total + points.length, 0) <= maxVertices) {
				contours = opaqueOutlinesToContours(outlines, image.info.width, image.info.height, size);
				decomposePhysics2DPolygonContours(contours);
				sourcePoints = outlines.flat();
				break;
			}
			if (stride >= Math.max(image.info.width, image.info.height)) {
				throw new Error(`Compound image outline exceeds the ${maxVertices}-vertex limit. Increase maxVertices or simplify the source image.`);
			}
			stride *= 2;
		}
	} else if (outline === "concave") {
		while (true) {
			sourcePoints = traceOpaqueOutlines(image.data, image.info.width, image.info.height, channels, alphaThreshold, stride)[0];
			if (sourcePoints.length <= maxVertices) {
				break;
			}
			if (stride >= Math.max(image.info.width, image.info.height)) {
				throw new Error(`Concave image outline exceeds the ${maxVertices}-vertex limit. Increase maxVertices or simplify the source image.`);
			}
			stride *= 2;
		}
	} else {
		const opaque: IPoint2D[] = [];
		for (let y = 0; y < image.info.height; y += stride) {
			for (let x = 0; x < image.info.width; x += stride) {
				const offset = (y * image.info.width + x) * channels;
				if (image.data[offset + 3] < alphaThreshold) {
					continue;
				}
				opaque.push(
					[x, y],
					[Math.min(image.info.width, x + stride), y],
					[Math.min(image.info.width, x + stride), Math.min(image.info.height, y + stride)],
					[x, Math.min(image.info.height, y + stride)]
				);
			}
		}
		if (!opaque.length) {
			throw new Error("Image contains no pixels at or above the requested alpha threshold.");
		}
		sourcePoints = convexHull(opaque);
		if (sourcePoints.length < 3) {
			throw new Error("Image alpha silhouette does not form a usable polygon collider.");
		}
		sourcePoints = sourcePoints.filter((_point, index) => index % Math.ceil(sourcePoints.length / maxVertices) === 0);
	}
	const points = sourcePoints.map(([x, y]): IPoint2D => [(x / image.info.width - 0.5) * size[0], (0.5 - y / image.info.height) * size[1]]);
	const state = setPhysics2DPolygonCollider(
		scene,
		{
			nodeId: data.nodeId,
			...(data.expectedRevision !== undefined ? { expectedRevision: data.expectedRevision } : startingRevision > 0 ? { expectedRevision: startingRevision } : {}),
			contours: contours ?? [{ id: `alpha-contour-1`, points, holes: [] }],
		},
		options
	);
	const body = listPhysics2D(scene).bodies.find((candidate: any) => candidate.nodeId === data.nodeId);
	return {
		...body,
		sourceImagePath: relative(dirname(projectConfiguration.path!), absolutePath),
		sourceImageSize: [image.info.width, image.info.height],
		outline,
		sampledVertexCount: sourcePoints.length,
		sampleStride: stride,
		outerCount: state.outerCount,
		holeCount: state.holeCount,
		partCount: state.parts.length,
		revision: state.revision,
	};
}

/** Removes the authored 2D body/collider without deleting the underlying scene node. */
export function removePhysics2DBody(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = configs(scene).findIndex((config) => config.nodeId === data.nodeId);
	if (index === -1) {
		throw new Error(`No 2D physics body is attached to node "${data.nodeId}".`);
	}
	expectPhysics2DRevision("body", data.nodeId, bodyRevision(configs(scene)[index]), data.expectedRevision);
	configs(scene).splice(index, 1);
	configurePhysics2D(scene);
	options.editor.layout.inspector.forceUpdate();
	return { removed: true, nodeId: data.nodeId };
}
