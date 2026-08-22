import { Matrix, Mesh, MeshBuilder, Node, Ray, Scene, Vector3, VertexData } from "babylonjs";
import { dirname, isAbsolute, join, normalize, relative } from "path/posix";
import { mkdir, pathExists, readJSON, writeJSON } from "fs-extra";

import { addSplineMesh } from "../../project/add/spline";
import { projectConfiguration } from "../../project/configuration";
import { normalizedGlob } from "../../tools/fs";
import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

const splineFollowerPreviewState = new WeakMap<Scene, Map<string, { t: number }>>();
const splineFollowerPreviewConfigured = new WeakSet<Scene>();
const SPLINE_ASSET_TYPE = "babylonEditorSpline";

type ISplineAsset = {
	version: 1;
	type: typeof SPLINE_ASSET_TYPE;
	name: string;
	points: number[][];
	knots: IBezierKnot[] | null;
	radius: number;
	tessellation: number;
	closed: boolean;
};

function getProjectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function resolveSplineAssetPath(path: string): string {
	const projectDirectory = getProjectDirectory();
	const absolutePath = normalize(isAbsolute(path) ? path : join(projectDirectory, path));
	if (absolutePath !== projectDirectory && !absolutePath.startsWith(`${projectDirectory}/`)) {
		throw new Error("Spline asset paths must stay inside the open project directory.");
	}
	if (!absolutePath.endsWith(".spline.json")) {
		throw new Error("Spline assets must use the .spline.json extension.");
	}
	return absolutePath;
}

function toProjectRelativePath(path: string): string {
	return relative(getProjectDirectory(), path);
}

function getSplineMesh(scene: Scene, data: any): Mesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node) || node.metadata?.type !== "Spline") {
		throw new Error(`Node "${node.name}" is not an editor spline.`);
	}
	return node;
}

function getSplinePoints(data: any): Vector3[] {
	if (!Array.isArray(data.points) || data.points.length < 2) {
		throw new Error("A spline requires at least two control points.");
	}
	return data.points.map((point: unknown) => {
		if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)) {
			throw new Error("Spline control points must be finite [x, y, z] coordinates.");
		}
		return toVector3(point);
	});
}

type IBezierKnot = { position: number[]; inTangent: number[]; outTangent: number[] };

function getSplineKnots(data: any): IBezierKnot[] {
	if (!Array.isArray(data.knots) || data.knots.length < 2) {
		throw new Error("A Bezier spline requires at least two knots.");
	}
	return data.knots.map((knot: any, index: number) => {
		const values = [knot?.position, knot?.inTangent ?? [0, 0, 0], knot?.outTangent ?? [0, 0, 0]];
		if (!values.every((value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite))) {
			throw new Error(`Bezier knot ${index} position and tangents must be finite [x, y, z] coordinates.`);
		}
		return { position: [...knot.position], inTangent: [...(knot.inTangent ?? [0, 0, 0])], outTangent: [...(knot.outTangent ?? [0, 0, 0])] };
	});
}

function evaluateBezier(start: IBezierKnot, end: IBezierKnot, t: number): Vector3 {
	const p0 = Vector3.FromArray(start.position);
	const p1 = p0.add(Vector3.FromArray(start.outTangent));
	const p3 = Vector3.FromArray(end.position);
	const p2 = p3.add(Vector3.FromArray(end.inTangent));
	const inverse = 1 - t;
	return p0
		.scale(inverse * inverse * inverse)
		.add(p1.scale(3 * inverse * inverse * t))
		.add(p2.scale(3 * inverse * t * t))
		.add(p3.scale(t * t * t));
}

function getSplinePath(metadata: any): Vector3[] {
	if (!Array.isArray(metadata.knots)) {
		return getTubePath(getSplinePoints(metadata), metadata.closed);
	}
	const knots = getSplineKnots(metadata);
	const segmentCount = metadata.closed ? knots.length : knots.length - 1;
	const points: Vector3[] = [];
	for (let segment = 0; segment < segmentCount; segment++) {
		const start = knots[segment];
		const end = knots[(segment + 1) % knots.length];
		for (let step = 0; step < 12; step++) {
			points.push(evaluateBezier(start, end, step / 12));
		}
	}
	points.push(
		(metadata.closed ? knots[0] : knots[knots.length - 1]).position ? Vector3.FromArray((metadata.closed ? knots[0] : knots[knots.length - 1]).position) : Vector3.Zero()
	);
	return points;
}

function getTubePath(points: Vector3[], closed: boolean): Vector3[] {
	return closed ? [...points, points[0].clone()] : points;
}

function setFollowerPreviewTransform(
	spline: Mesh,
	follower: Node & { position?: Vector3; rotation?: Vector3; rotationQuaternion?: unknown; setAbsolutePosition?: (position: Vector3) => void },
	t: number,
	orientToPath: boolean
): number | null {
	const sample = evaluateSpline(spline.getScene(), { nodeId: spline.id, t });
	const position = Vector3.TransformCoordinates(Vector3.FromArray(sample.position), spline.getWorldMatrix());
	if (follower.setAbsolutePosition) {
		follower.setAbsolutePosition(position);
	} else {
		follower.position?.copyFrom(position);
	}
	if (orientToPath && follower.rotation) {
		const tangent = Vector3.TransformNormal(Vector3.FromArray(sample.tangent), spline.getWorldMatrix()).normalize();
		follower.rotationQuaternion = null;
		follower.rotation.y = Math.atan2(tangent.x, tangent.z);
	}
	return sample.length;
}

function ensureSplineFollowerPreview(scene: Scene): Map<string, { t: number }> {
	const state = splineFollowerPreviewState.get(scene) ?? new Map<string, { t: number }>();
	splineFollowerPreviewState.set(scene, state);
	if (splineFollowerPreviewConfigured.has(scene)) {
		return state;
	}
	splineFollowerPreviewConfigured.add(scene);
	scene.onBeforeRenderObservable.add(() => {
		const elapsedSeconds = scene.getEngine().getDeltaTime() / 1000;
		for (const follower of scene.getNodes() as Array<
			Node & { position?: Vector3; rotation?: Vector3; rotationQuaternion?: unknown; setAbsolutePosition?: (position: Vector3) => void }
		>) {
			const configuration = follower.metadata?.babylonEditorSplineFollower;
			if (!configuration) {
				continue;
			}
			const spline = scene.getNodeById(configuration.splineId);
			if (!isMesh(spline) || spline.metadata?.type !== "Spline") {
				continue;
			}
			const playback = state.get(follower.id) ?? { t: configuration.t };
			const length = setFollowerPreviewTransform(spline, follower, playback.t, configuration.orientToPath);
			if (!length) {
				continue;
			}
			const delta = (configuration.speed * elapsedSeconds) / length;
			playback.t = configuration.loop ? (playback.t + delta) % 1 : Math.min(1, playback.t + delta);
			state.set(follower.id, playback);
			setFollowerPreviewTransform(spline, follower, playback.t, configuration.orientToPath);
		}
	});
	return state;
}

function rebuildSpline(spline: Mesh): void {
	const metadata = spline.metadata;
	const points = getSplinePath(metadata);
	const radius = metadata.radius;
	const tessellation = metadata.tessellation;
	if (!Number.isFinite(radius) || radius <= 0) {
		throw new Error("Spline radius must be greater than zero.");
	}
	if (!Number.isInteger(tessellation) || tessellation < 3) {
		throw new Error("Spline tessellation must be an integer of at least 3.");
	}
	// Tube instances cannot safely change path length (for example when toggling closed),
	// so generate fresh vertex data and apply it to the persisted mesh identity instead.
	const generated = MeshBuilder.CreateTube(`${spline.name}__generated`, { path: points, radius, tessellation, cap: Mesh.CAP_ALL }, spline.getScene());
	const vertexData = VertexData.ExtractFromMesh(generated, true, true);
	generated.dispose();
	vertexData.applyToMesh(spline, true);
	spline.refreshBoundingInfo({ updatePositionsArray: true });
}

function projectPointToTerrain(spline: Mesh, terrain: Mesh, point: number[], offset: number): Vector3 {
	spline.computeWorldMatrix(true);
	terrain.computeWorldMatrix(true);
	const worldPoint = Vector3.TransformCoordinates(Vector3.FromArray(point), spline.getWorldMatrix());
	const bounds = terrain.getBoundingInfo().boundingBox;
	const padding = Math.max(1_000, bounds.maximumWorld.y - bounds.minimumWorld.y + 100);
	const hit = terrain.intersects(new Ray(new Vector3(worldPoint.x, bounds.maximumWorld.y + padding, worldPoint.z), Vector3.Down(), padding * 2), false);
	if (!hit.hit || !hit.pickedPoint) {
		throw new Error(`Spline point at [${point.join(", ")}] does not intersect Ground terrain "${terrain.name}".`);
	}
	hit.pickedPoint.y += offset;
	return Vector3.TransformCoordinates(hit.pickedPoint, Matrix.Invert(spline.getWorldMatrix()));
}

/** Creates a persisted, editable spline tube using the same editor add path as the UI command. */
export function createSpline(scene: Scene, data: any, options: IMCPActionOptions): any {
	const parent = data.parentId || data.parentName ? resolveNode({ scene, nodeId: data.parentId, nodeName: data.parentName }) : undefined;
	const spline = addSplineMesh(options.editor, parent);
	if (data.name) {
		spline.name = data.name;
	}
	Object.assign(spline.metadata, {
		points: (data.points ? getSplinePoints(data) : spline.metadata.points.map(toVector3)).map((point: Vector3) => point.asArray()),
		knots: data.knots ? getSplineKnots(data) : undefined,
		radius: data.radius ?? spline.metadata.radius,
		tessellation: data.tessellation ?? spline.metadata.tessellation,
		closed: data.closed ?? spline.metadata.closed,
	});
	rebuildSpline(spline);
	return getSpline(scene, { nodeId: spline.id });
}

/** Lists editable spline meshes in the active scene. */
export function listSplines(scene: Scene): any[] {
	return scene.meshes.filter((mesh) => mesh.metadata?.type === "Spline").map((mesh) => getSpline(scene, { nodeId: mesh.id }));
}

/** Gets a spline's editable authoring data. */
export function getSpline(scene: Scene, data: any): any {
	const spline = getSplineMesh(scene, data);
	return {
		node: toNodeSummary(spline),
		points: spline.metadata.points,
		knots: spline.metadata.knots ?? null,
		radius: spline.metadata.radius,
		tessellation: spline.metadata.tessellation,
		closed: spline.metadata.closed,
	};
}

function toSplineAsset(spline: any): ISplineAsset {
	return {
		version: 1,
		type: SPLINE_ASSET_TYPE,
		name: spline.node.name,
		points: spline.points,
		knots: spline.knots,
		radius: spline.radius,
		tessellation: spline.tessellation,
		closed: spline.closed,
	};
}

function getSplineAsset(asset: any, path: string): ISplineAsset {
	if (asset?.version !== 1 || asset?.type !== SPLINE_ASSET_TYPE || typeof asset.name !== "string") {
		throw new Error(`Spline asset at ${path} is not a valid Babylon.js Editor spline asset.`);
	}
	getSplinePoints(asset);
	if (asset.knots !== null && asset.knots !== undefined) {
		getSplineKnots(asset);
	}
	if (!Number.isFinite(asset.radius) || asset.radius <= 0) {
		throw new Error(`Spline asset at ${path} has an invalid radius.`);
	}
	if (!Number.isInteger(asset.tessellation) || asset.tessellation < 3) {
		throw new Error(`Spline asset at ${path} has an invalid tessellation.`);
	}
	if (typeof asset.closed !== "boolean") {
		throw new Error(`Spline asset at ${path} has an invalid closed value.`);
	}
	return { ...asset, knots: asset.knots ?? null };
}

/** Saves one editable spline's authoring data as a project-local reusable .spline.json asset. */
export async function saveSplineAsset(scene: Scene, data: any): Promise<any> {
	const absolutePath = resolveSplineAssetPath(data.path);
	if ((await pathExists(absolutePath)) && data.overwrite !== true) {
		throw new Error(`Spline asset exists at ${data.path}. Set overwrite: true to replace it.`);
	}
	const spline = getSpline(scene, data);
	const asset = toSplineAsset(spline);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeJSON(absolutePath, asset, { spaces: "\t" });
	return { path: toProjectRelativePath(absolutePath), asset };
}

/** Lists valid reusable spline assets inside the open project, excluding malformed JSON files. */
export async function listSplineAssets(): Promise<any> {
	const projectDirectory = getProjectDirectory();
	const paths = await normalizedGlob(join(projectDirectory, "/**/*.spline.json"), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] });
	const assets: Array<{ path: string; asset: ISplineAsset }> = [];
	for (const path of (paths as string[]).sort()) {
		try {
			assets.push({ path: toProjectRelativePath(path), asset: getSplineAsset(await readJSON(path), path) });
		} catch {
			// Ignore unrelated or malformed JSON files so one invalid asset does not hide the rest of the library.
		}
	}
	return { assets };
}

/** Instantiates a reusable spline asset into the active scene with an optional parent and name override. */
export async function instantiateSplineAsset(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = resolveSplineAssetPath(data.path);
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Spline asset not found at ${data.path}.`);
	}
	const asset = getSplineAsset(await readJSON(absolutePath), data.path);
	const spline = createSpline(
		scene,
		{
			name: data.name ?? asset.name,
			parentId: data.parentId,
			parentName: data.parentName,
			points: asset.points,
			knots: asset.knots ?? undefined,
			radius: asset.radius,
			tessellation: asset.tessellation,
			closed: asset.closed,
		},
		options
	);
	return { path: toProjectRelativePath(absolutePath), spline };
}

/** Replaces or updates persisted spline control points and tube settings. */
export function setSpline(scene: Scene, data: any, options: IMCPActionOptions): any {
	const spline = getSplineMesh(scene, data);
	if (data.points !== undefined) {
		spline.metadata.points = getSplinePoints(data).map((point) => point.asArray());
	}
	if (data.knots === null) {
		delete spline.metadata.knots;
	} else if (data.knots !== undefined) {
		spline.metadata.knots = getSplineKnots(data);
	}
	if (data.radius !== undefined) {
		spline.metadata.radius = data.radius;
	}
	if (data.tessellation !== undefined) {
		spline.metadata.tessellation = data.tessellation;
	}
	if (data.closed !== undefined) {
		spline.metadata.closed = data.closed;
	}
	rebuildSpline(spline);
	options.editor.layout.inspector.setEditedObject(spline);
	options.editor.layout.inspector.forceUpdate();
	return getSpline(scene, { nodeId: spline.id });
}

/** Projects persisted spline points or cubic Bezier knots onto a Ground terrain surface. */
export function projectSplineToTerrain(scene: Scene, data: any, options: IMCPActionOptions): any {
	const spline = getSplineMesh(scene, data);
	const terrain = resolveNode({ scene, nodeId: data.terrainId, nodeName: data.terrainName });
	if (!isMesh(terrain) || terrain.metadata?.type !== "Ground") {
		throw new Error(`Node "${terrain.name}" is not an editor Ground terrain.`);
	}
	const offset = data.offset ?? 0;
	if (!Number.isFinite(offset)) {
		throw new Error("Terrain projection offset must be finite.");
	}
	const projectTangents = data.projectTangents ?? true;

	if (Array.isArray(spline.metadata.knots)) {
		const knots = getSplineKnots({ knots: spline.metadata.knots }).map((knot) => {
			const position = projectPointToTerrain(spline, terrain, knot.position, offset);
			if (!projectTangents) {
				return { ...knot, position: position.asArray() };
			}
			const inHandle = projectPointToTerrain(spline, terrain, Vector3.FromArray(knot.position).add(Vector3.FromArray(knot.inTangent)).asArray(), offset);
			const outHandle = projectPointToTerrain(spline, terrain, Vector3.FromArray(knot.position).add(Vector3.FromArray(knot.outTangent)).asArray(), offset);
			return { position: position.asArray(), inTangent: inHandle.subtract(position).asArray(), outTangent: outHandle.subtract(position).asArray() };
		});
		spline.metadata.knots = knots;
	} else {
		spline.metadata.points = getSplinePoints({ points: spline.metadata.points }).map((point) => projectPointToTerrain(spline, terrain, point.asArray(), offset).asArray());
	}

	rebuildSpline(spline);
	options.editor.layout.inspector.setEditedObject(spline);
	options.editor.layout.inspector.forceUpdate();
	return { spline: getSpline(scene, { nodeId: spline.id }), terrain: toNodeSummary(terrain), offset, projectTangents };
}

/** Evaluates a spline's piecewise-linear authored path at normalized distance t. */
export function evaluateSpline(scene: Scene, data: any): any {
	const spline = getSplineMesh(scene, data);
	const points = getSplinePath(spline.metadata);
	const lengths: number[] = [];
	let totalLength = 0;
	for (let index = 0; index < points.length - 1; index++) {
		const length = Vector3.Distance(points[index], points[index + 1]);
		lengths.push(length);
		totalLength += length;
	}
	if (!totalLength) {
		throw new Error("Cannot evaluate a zero-length spline.");
	}
	const target = Math.min(1, Math.max(0, data.t ?? 0)) * totalLength;
	let travelled = 0;
	for (let index = 0; index < lengths.length; index++) {
		if (target <= travelled + lengths[index] || index === lengths.length - 1) {
			const amount = lengths[index] ? (target - travelled) / lengths[index] : 0;
			const tangent = points[index + 1].subtract(points[index]).normalize();
			return {
				node: toNodeSummary(spline),
				t: data.t ?? 0,
				position: Vector3.Lerp(points[index], points[index + 1], amount).asArray(),
				tangent: tangent.asArray(),
				length: totalLength,
			};
		}
		travelled += lengths[index];
	}
	throw new Error("Unable to evaluate spline.");
}

/** Lists every persisted spline-follower component in the active scene. */
export function listSplineFollowers(scene: Scene): any {
	return {
		followers: scene
			.getNodes()
			.filter((node) => node.metadata?.babylonEditorSplineFollower)
			.map((node) => ({ node: toNodeSummary(node), follower: structuredClone(node.metadata.babylonEditorSplineFollower) })),
	};
}

/** Creates or updates a persisted follower component for a transform-capable scene node. */
export function setSplineFollower(scene: Scene, data: any, options: IMCPActionOptions): any {
	const spline = getSplineMesh(scene, { nodeId: data.splineId, nodeName: data.splineName });
	const follower = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName }) as Node & { position?: Vector3; rotation?: Vector3 };
	if (!follower.position) {
		throw new Error(`Node "${follower.name}" cannot follow a spline because it has no position.`);
	}
	if (data.speed !== undefined && (!Number.isFinite(data.speed) || data.speed < 0)) {
		throw new Error("Spline follower speed must be zero or greater.");
	}
	if (data.t !== undefined && (!Number.isFinite(data.t) || data.t < 0 || data.t > 1)) {
		throw new Error("Spline follower t must be between 0 and 1.");
	}
	follower.metadata ??= {};
	follower.metadata.babylonEditorSplineFollower = {
		splineId: spline.id,
		speed: data.speed ?? follower.metadata.babylonEditorSplineFollower?.speed ?? 100,
		t: data.t ?? follower.metadata.babylonEditorSplineFollower?.t ?? 0,
		loop: data.loop ?? follower.metadata.babylonEditorSplineFollower?.loop ?? true,
		orientToPath: data.orientToPath ?? follower.metadata.babylonEditorSplineFollower?.orientToPath ?? true,
	};
	const previewState = ensureSplineFollowerPreview(scene);
	previewState.set(follower.id, { t: follower.metadata.babylonEditorSplineFollower.t });
	setFollowerPreviewTransform(spline, follower, follower.metadata.babylonEditorSplineFollower.t, follower.metadata.babylonEditorSplineFollower.orientToPath);
	options.editor.layout.inspector.setEditedObject(follower);
	options.editor.layout.inspector.forceUpdate();
	return { node: toNodeSummary(follower), follower: structuredClone(follower.metadata.babylonEditorSplineFollower) };
}

/** Removes a persisted spline-follower component from a node. */
export function deleteSplineFollower(scene: Scene, data: any, options: IMCPActionOptions): any {
	const follower = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!follower.metadata?.babylonEditorSplineFollower) {
		throw new Error(`Node "${follower.name}" has no spline follower.`);
	}
	delete follower.metadata.babylonEditorSplineFollower;
	splineFollowerPreviewState.get(scene)?.delete(follower.id);
	options.editor.layout.inspector.setEditedObject(follower);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, node: toNodeSummary(follower) };
}
