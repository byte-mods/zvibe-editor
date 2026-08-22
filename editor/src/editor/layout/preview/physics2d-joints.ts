import { Camera, Color3, LinesMesh, Matrix, Mesh, MeshBuilder, Plane, Scene, StandardMaterial, Vector3 } from "babylonjs";
import {
	computePhysics2DMassProperties,
	IPhysics2DBodyConfiguration,
	IPhysics2DJointConfiguration,
	IPhysics2DPoint,
	MaxPhysics2DBodies,
	normalizePhysics2DBodyConfiguration,
	normalizePhysics2DJointConfigurations,
} from "babylonjs-editor-tools";

import { isAnyTransformNode } from "../../../tools/guards/nodes";
import { setNodeSerializable, setNodeVisibleInGraph } from "../../../tools/node/metadata";

import { Editor } from "../../main";

import { capturePhysics2DJointSnapshot, IPhysics2DJointCollectionSnapshot, restorePhysics2DJointSnapshot, setPhysics2DJoint } from "../../../mcp/physics2d/physics2d";

import { registerPhysics2DJointUndoRedo } from "../inspector/scene/physics2d-joint-transaction";

export type Physics2DJointHandleKind =
	| "first-anchor"
	| "second-anchor"
	| "rest-length"
	| "hinge-min-angle"
	| "hinge-max-angle"
	| "relative-offset"
	| "relative-angle"
	| "slider-axis"
	| "slider-lower-limit"
	| "slider-upper-limit"
	| "target"
	| "wheel-axis";

export const physics2DJointHandleKinds: readonly Physics2DJointHandleKind[] = [
	"first-anchor",
	"second-anchor",
	"rest-length",
	"hinge-min-angle",
	"hinge-max-angle",
	"relative-offset",
	"relative-angle",
	"slider-axis",
	"slider-lower-limit",
	"slider-upper-limit",
	"target",
	"wheel-axis",
];

export interface IPhysics2DJointViewportHandle {
	kind: Physics2DJointHandleKind;
	jointId: string;
	point: Vector3;
}

export interface IPhysics2DJointViewportModel {
	selectedNodeId: string;
	key: string;
	jointCount: number;
	lines: Vector3[][];
	handles: IPhysics2DJointViewportHandle[];
	truncated: boolean;
}

const MaxViewportJoints = 128;
const MaxViewportLinePoints = 4096;
const MaxViewportHandles = 512;
const CircleSegments = 32;
const MaxCoordinate = 1_000_000;

type IViewportNode = { id: string; position: Vector3; rotation: Vector3 };
type IJointVisual = { lines: Vector3[][]; handles: IPhysics2DJointViewportHandle[] };

/** Rotates one planar vector in the same unscaled frame used by the shared Physics2D solver. */
function rotate(point: IPhysics2DPoint, angle: number): IPhysics2DPoint {
	const cosine = Math.cos(angle);
	const sine = Math.sin(angle);
	return [point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine];
}

/** Converts a local solver point to its planar scene position; Physics2D intentionally ignores parent and scale transforms. */
function worldPoint(node: IViewportNode, local: IPhysics2DPoint): IPhysics2DPoint {
	const rotated = rotate(local, node.rotation.z);
	return [node.position.x + rotated[0], node.position.y + rotated[1]];
}

/** Converts a solver-world point back into one body's local rotation/translation frame. */
function localPoint(node: IViewportNode, world: IPhysics2DPoint): IPhysics2DPoint {
	return rotate([world[0] - node.position.x, world[1] - node.position.y], -node.rotation.z);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function boundedPoint(point: IPhysics2DPoint): IPhysics2DPoint {
	return [clamp(point[0], -MaxCoordinate, MaxCoordinate), clamp(point[1], -MaxCoordinate, MaxCoordinate)];
}

/** Maps arbitrary pointer rotations into the stable range used by direct viewport angular editing. */
function normalizedAngle(value: number): number {
	return Math.atan2(Math.sin(value), Math.cos(value));
}

/** Compares one proposed scalar/vector patch value without creating revisions for inverse-transform floating-point noise. */
function isEquivalentPatchValue(current: unknown, proposed: unknown): boolean {
	if (typeof current === "number" && typeof proposed === "number") {
		return Math.abs(current - proposed) < 0.000001;
	}
	if (Array.isArray(current) && Array.isArray(proposed) && current.length === proposed.length) {
		return proposed.every((component, index) => typeof component === "number" && typeof current[index] === "number" && Math.abs(component - current[index]) < 0.000001);
	}
	return false;
}

function vector(point: IPhysics2DPoint, depth: number): Vector3 {
	return new Vector3(point[0], point[1], depth);
}

/** Adds a stable cross marker that remains legible even when both anchors coincide. */
function addCross(lines: Vector3[][], point: IPhysics2DPoint, depth: number, radius = 8): void {
	lines.push([vector([point[0] - radius, point[1]], depth), vector([point[0] + radius, point[1]], depth)]);
	lines.push([vector([point[0], point[1] - radius], depth), vector([point[0], point[1] + radius], depth)]);
}

/** Adds a closed circle with a fixed segment count so total viewport work is predictable. */
function addCircle(lines: Vector3[][], center: IPhysics2DPoint, radius: number, depth: number): void {
	const points = Array.from({ length: CircleSegments + 1 }, (_value, index) => {
		const angle = (Math.PI * 2 * index) / CircleSegments;
		return vector([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius], depth);
	});
	lines.push(points);
}

/** Adds an inclusive angular arc and returns both endpoints for optional limit handles. */
function addArc(lines: Vector3[][], center: IPhysics2DPoint, start: number, end: number, radius: number, depth: number): [Vector3, Vector3] {
	const span = Math.max(-Math.PI * 2, Math.min(Math.PI * 2, end - start));
	const segments = Math.max(2, Math.ceil((CircleSegments * Math.abs(span)) / (Math.PI * 2)));
	const points = Array.from({ length: segments + 1 }, (_value, index) => {
		const angle = start + (span * index) / segments;
		return vector([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius], depth);
	});
	lines.push(points, [vector(center, depth), points[0]], [vector(center, depth), points[points.length - 1]]);
	return [points[0], points[points.length - 1]];
}

/** Draws a compact spring coil between two anchors without changing its authored rest length. */
function addSpring(lines: Vector3[][], first: IPhysics2DPoint, second: IPhysics2DPoint, depth: number): void {
	const delta: IPhysics2DPoint = [second[0] - first[0], second[1] - first[1]];
	const length = Math.hypot(delta[0], delta[1]);
	const axis: IPhysics2DPoint = length > 0.000001 ? [delta[0] / length, delta[1] / length] : [1, 0];
	const normal: IPhysics2DPoint = [-axis[1], axis[0]];
	const amplitude = Math.min(12, Math.max(4, length * 0.12));
	const points = Array.from({ length: 10 }, (_value, index) => {
		const ratio = index / 9;
		const offset = index === 0 || index === 9 ? 0 : (index % 2 ? 1 : -1) * amplitude;
		return vector([first[0] + delta[0] * ratio + normal[0] * offset, first[1] + delta[1] * ratio + normal[1] * offset], depth);
	});
	lines.push(points);
}

/** Validates every body once so joint visualization never mixes canonical joints with malformed attachment data. */
function normalizedBodies(scene: Scene): Map<string, IPhysics2DBodyConfiguration> | null {
	const source = scene.metadata?.babylonEditorPhysics2D ?? [];
	if (!Array.isArray(source) || source.length > MaxPhysics2DBodies) {
		return null;
	}
	const bodies = new Map<string, IPhysics2DBodyConfiguration>();
	for (const candidate of source) {
		const normalized = normalizePhysics2DBodyConfiguration(candidate);
		if (!normalized.ok || bodies.has(normalized.value.nodeId)) {
			return null;
		}
		bodies.set(normalized.value.nodeId, normalized.value);
	}
	return bodies;
}

/** Returns the solver center of mass rather than the TransformNode origin used by ordinary scene gizmos. */
function bodyCenter(node: IViewportNode, body: IPhysics2DBodyConfiguration): IPhysics2DPoint {
	return worldPoint(node, computePhysics2DMassProperties(body).centerOfMass);
}

function handle(kind: Physics2DJointHandleKind, jointId: string, point: IPhysics2DPoint, depth: number): IPhysics2DJointViewportHandle {
	return { kind, jointId, point: vector(point, depth) };
}

/** Converts one world-space handle position into the smallest valid canonical joint patch. */
export function getPhysics2DJointHandlePatch(scene: Scene, jointId: string, kind: Physics2DJointHandleKind, pickedPoint: IPhysics2DPoint): Record<string, unknown> | null {
	if (!pickedPoint.every(Number.isFinite)) {
		return null;
	}
	const joints = normalizePhysics2DJointConfigurations(scene.metadata?.babylonEditorPhysics2DJoints ?? []);
	const bodies = normalizedBodies(scene);
	const joint = joints.ok ? joints.value.find((candidate) => candidate.id === jointId) : null;
	if (!joint || !bodies) {
		return null;
	}
	const first = scene.getNodeById(joint.firstNodeId);
	const firstBody = bodies.get(joint.firstNodeId);
	const second = joint.secondNodeId ? scene.getNodeById(joint.secondNodeId) : null;
	const secondBody = joint.secondNodeId ? bodies.get(joint.secondNodeId) : undefined;
	if (!isAnyTransformNode(first) || !firstBody || (joint.secondNodeId && (!isAnyTransformNode(second) || !secondBody))) {
		return null;
	}
	const secondTransform = isAnyTransformNode(second) ? second : null;
	// Preserve the raw world point until after local-frame conversion; clamping world first would corrupt anchors on far-translated bodies.
	const point = pickedPoint;
	if (kind === "target" && joint.type === "target") {
		return { target: boundedPoint(point) };
	}
	if (kind === "relative-offset" && joint.type === "relative") {
		const center = bodyCenter(first, firstBody);
		return { linearOffset: secondTransform ? boundedPoint(rotate([point[0] - center[0], point[1] - center[1]], -first.rotation.z)) : boundedPoint(point) };
	}
	if (kind === "relative-angle" && joint.type === "relative") {
		const center = bodyCenter(first, firstBody);
		return { angularOffset: normalizedAngle(Math.atan2(point[1] - center[1], point[0] - center[0]) - first.rotation.z) };
	}
	if (!("firstAnchor" in joint)) {
		return null;
	}
	const firstAnchor = worldPoint(first, joint.firstAnchor);
	if (kind === "first-anchor") {
		return { firstAnchor: boundedPoint(localPoint(first, point)) };
	}
	if (kind === "second-anchor" && !joint.autoConfigureConnectedAnchor) {
		return { secondAnchor: secondTransform ? boundedPoint(localPoint(secondTransform, point)) : boundedPoint(point) };
	}
	if (kind === "rest-length" && (joint.type === "distance" || joint.type === "spring")) {
		return { distance: clamp(Math.hypot(point[0] - firstAnchor[0], point[1] - firstAnchor[1]), 0, MaxCoordinate * 2) };
	}
	const worldAngle = Math.atan2(point[1] - firstAnchor[1], point[0] - firstAnchor[0]);
	if ((kind === "hinge-min-angle" || kind === "hinge-max-angle") && joint.type === "hinge" && joint.useLimits) {
		const angle = normalizedAngle(worldAngle - first.rotation.z - joint.referenceAngle);
		return kind === "hinge-min-angle" ? { minAngle: Math.min(angle, joint.maxAngle) } : { maxAngle: Math.max(angle, joint.minAngle) };
	}
	if ((kind === "slider-axis" && joint.type === "slider") || (kind === "wheel-axis" && joint.type === "wheel")) {
		return { angle: normalizedAngle(worldAngle - first.rotation.z) };
	}
	if ((kind === "slider-lower-limit" || kind === "slider-upper-limit") && joint.type === "slider" && joint.useLimits) {
		const axis = rotate([Math.cos(joint.angle), Math.sin(joint.angle)], first.rotation.z);
		const translation = clamp((point[0] - firstAnchor[0]) * axis[0] + (point[1] - firstAnchor[1]) * axis[1], -MaxCoordinate * 2, MaxCoordinate * 2);
		return kind === "slider-lower-limit"
			? { lowerTranslation: Math.min(translation, joint.upperTranslation) }
			: { upperTranslation: Math.max(translation, joint.lowerTranslation) };
	}
	return null;
}

/** Builds one family-specific visual in the exact frames used by joint-runtime anchor and axis resolution. */
function buildJointVisual(scene: Scene, joint: IPhysics2DJointConfiguration, bodies: Map<string, IPhysics2DBodyConfiguration>, depth: number): IJointVisual | null {
	const first = scene.getNodeById(joint.firstNodeId);
	const firstBody = bodies.get(joint.firstNodeId);
	const second = joint.secondNodeId ? scene.getNodeById(joint.secondNodeId) : null;
	const secondBody = joint.secondNodeId ? bodies.get(joint.secondNodeId) : undefined;
	if (!isAnyTransformNode(first) || !firstBody || (joint.secondNodeId && (!isAnyTransformNode(second) || !secondBody))) {
		return null;
	}
	const secondTransform = isAnyTransformNode(second) ? second : null;
	const lines: Vector3[][] = [];
	const handles: IPhysics2DJointViewportHandle[] = [];
	if (joint.type === "relative" || joint.type === "target") {
		const firstCenter = bodyCenter(first, firstBody);
		const desired =
			joint.type === "target"
				? joint.target
				: secondTransform && secondBody
					? (() => {
							const offset = rotate(joint.linearOffset, first.rotation.z);
							return [firstCenter[0] + offset[0], firstCenter[1] + offset[1]] as IPhysics2DPoint;
						})()
					: joint.linearOffset;
		lines.push([vector(firstCenter, depth), vector(desired, depth)]);
		addCross(lines, desired, depth);
		if (joint.type === "target") {
			handles.push(handle("target", joint.id, desired, depth));
		} else {
			handles.push(handle("relative-offset", joint.id, desired, depth));
			const angular = first.rotation.z + joint.angularOffset;
			const endpoint: IPhysics2DPoint = [firstCenter[0] + Math.cos(angular) * 55, firstCenter[1] + Math.sin(angular) * 55];
			lines.push([vector(firstCenter, depth), vector(endpoint, depth)]);
			handles.push(handle("relative-angle", joint.id, endpoint, depth));
			if (secondTransform && secondBody) {
				lines.push([vector(desired, depth), vector(bodyCenter(secondTransform, secondBody), depth)]);
			}
		}
		return { lines, handles };
	}

	const firstAnchor = worldPoint(first, joint.firstAnchor);
	const secondAnchor = secondTransform && secondBody ? worldPoint(secondTransform, joint.secondAnchor) : joint.secondAnchor;
	lines.push([vector(firstAnchor, depth), vector(secondAnchor, depth)]);
	addCross(lines, firstAnchor, depth);
	addCross(lines, secondAnchor, depth);
	handles.push(handle("first-anchor", joint.id, firstAnchor, depth));
	if (!joint.autoConfigureConnectedAnchor) {
		handles.push(handle("second-anchor", joint.id, secondAnchor, depth));
	}
	const delta: IPhysics2DPoint = [secondAnchor[0] - firstAnchor[0], secondAnchor[1] - firstAnchor[1]];
	const currentLength = Math.hypot(delta[0], delta[1]);
	const direction: IPhysics2DPoint = currentLength > 0.000001 ? [delta[0] / currentLength, delta[1] / currentLength] : [1, 0];
	if (joint.type === "distance" || joint.type === "spring") {
		addCircle(lines, firstAnchor, joint.distance, depth);
		if (joint.type === "spring") {
			addSpring(lines, firstAnchor, secondAnchor, depth);
		}
		const rest: IPhysics2DPoint = [firstAnchor[0] + direction[0] * joint.distance, firstAnchor[1] + direction[1] * joint.distance];
		handles.push(handle("rest-length", joint.id, rest, depth));
	} else if (joint.type === "hinge") {
		addCircle(lines, firstAnchor, 28, depth);
		if (joint.useLimits) {
			const base = first.rotation.z + joint.referenceAngle;
			const limits = addArc(lines, firstAnchor, base + joint.minAngle, base + joint.maxAngle, 48, depth);
			handles.push({ kind: "hinge-min-angle", jointId: joint.id, point: limits[0] }, { kind: "hinge-max-angle", jointId: joint.id, point: limits[1] });
		}
	} else if (joint.type === "slider" || joint.type === "wheel") {
		const angle = first.rotation.z + joint.angle;
		const axis: IPhysics2DPoint = [Math.cos(angle), Math.sin(angle)];
		const extent = joint.type === "slider" && joint.useLimits ? Math.max(70, Math.abs(joint.lowerTranslation) + 25, Math.abs(joint.upperTranslation) + 25) : 80;
		const start: IPhysics2DPoint = [firstAnchor[0] - axis[0] * extent, firstAnchor[1] - axis[1] * extent];
		const end: IPhysics2DPoint = [firstAnchor[0] + axis[0] * extent, firstAnchor[1] + axis[1] * extent];
		lines.push([vector(start, depth), vector(end, depth)]);
		handles.push(handle(joint.type === "slider" ? "slider-axis" : "wheel-axis", joint.id, end, depth));
		if (joint.type === "slider" && joint.useLimits) {
			const lower: IPhysics2DPoint = [firstAnchor[0] + axis[0] * joint.lowerTranslation, firstAnchor[1] + axis[1] * joint.lowerTranslation];
			const upper: IPhysics2DPoint = [firstAnchor[0] + axis[0] * joint.upperTranslation, firstAnchor[1] + axis[1] * joint.upperTranslation];
			addCross(lines, lower, depth, 6);
			addCross(lines, upper, depth, 6);
			handles.push(handle("slider-lower-limit", joint.id, lower, depth), handle("slider-upper-limit", joint.id, upper, depth));
		}
	}
	return { lines, handles };
}

/** Builds all joints attached to the selected node with deterministic hard caps and no scene mutation. */
export function buildPhysics2DJointViewportModel(scene: Scene, selectedNodeId: string): IPhysics2DJointViewportModel | null {
	const selected = scene.getNodeById(selectedNodeId);
	const jointsResult = normalizePhysics2DJointConfigurations(scene.metadata?.babylonEditorPhysics2DJoints ?? []);
	const bodies = normalizedBodies(scene);
	if (!isAnyTransformNode(selected) || !jointsResult.ok || !bodies) {
		return null;
	}
	const attached = jointsResult.value.filter((joint) => joint.firstNodeId === selectedNodeId || joint.secondNodeId === selectedNodeId);
	if (!attached.length) {
		return null;
	}
	const lines: Vector3[][] = [];
	const handles: IPhysics2DJointViewportHandle[] = [];
	let pointCount = 0;
	let jointCount = 0;
	let truncated = attached.length > MaxViewportJoints;
	const keyParts: string[] = [];
	for (const joint of attached.slice(0, MaxViewportJoints)) {
		const visual = buildJointVisual(scene, joint, bodies, selected.position.z - 4);
		if (!visual) {
			return null;
		}
		const visualPointCount = visual.lines.reduce((total, line) => total + line.length, 0);
		if (pointCount + visualPointCount > MaxViewportLinePoints || handles.length + visual.handles.length > MaxViewportHandles) {
			truncated = true;
			break;
		}
		lines.push(...visual.lines);
		handles.push(...visual.handles);
		pointCount += visualPointCount;
		jointCount++;
		const first = scene.getNodeById(joint.firstNodeId);
		const second = joint.secondNodeId ? scene.getNodeById(joint.secondNodeId) : null;
		if (!isAnyTransformNode(first) || (second && !isAnyTransformNode(second))) {
			return null;
		}
		keyParts.push(
			`${joint.id}:${joint.revision}:${bodies.get(joint.firstNodeId)?.revision}:${first.position.asArray().join(",")}:${first.rotation.z}:${joint.secondNodeId ?? "world"}:${second?.position.asArray().join(",") ?? ""}:${second?.rotation.z ?? ""}:${joint.secondNodeId ? bodies.get(joint.secondNodeId)?.revision : ""}`
		);
	}
	return { selectedNodeId, key: keyParts.join("|"), jointCount, lines, handles, truncated };
}

/** Owns the temporary joint line system and pickable handles without adding them to persistence or the scene graph. */
export class EditorPhysics2DJointViewport {
	private _lineMesh: LinesMesh | null = null;
	private _handleMeshes: Mesh[] = [];
	private _handleMaterial: StandardMaterial | null = null;
	private _visualKey: string | null = null;
	private _drag: { selectedNodeId: string; jointId: string; kind: Physics2DJointHandleKind; before: IPhysics2DJointCollectionSnapshot } | null = null;

	/** Releases per-model meshes, and optionally the reusable material during preview reset/unmount. */
	public dispose(disposeMaterial = false): void {
		this._lineMesh?.dispose(false, false);
		this._lineMesh = null;
		this._handleMeshes.forEach((handleMesh) => handleMesh.dispose(false, false));
		this._handleMeshes = [];
		this._visualKey = null;
		if (disposeMaterial) {
			this._handleMaterial?.dispose(true, true);
			this._handleMaterial = null;
			this._drag = null;
		}
	}

	/** Synchronizes the selected node's bounded model and avoids allocations while its exact key is unchanged. */
	public sync(scene: Scene, selected: unknown): void {
		// Pointer capture owns the active joint until release, even if another editor action changes the graph selection mid-drag.
		const effectiveSelection = this._drag ? scene.getNodeById(this._drag.selectedNodeId) : selected;
		if (!isAnyTransformNode(effectiveSelection)) {
			this.dispose();
			return;
		}
		const model = buildPhysics2DJointViewportModel(scene, effectiveSelection.id);
		if (!model) {
			this.dispose();
			return;
		}
		const visualKey = `${model.selectedNodeId}:${model.key}`;
		if (visualKey === this._visualKey && this._lineMesh && !this._lineMesh.isDisposed() && this._handleMeshes.every((handleMesh) => !handleMesh.isDisposed())) {
			return;
		}
		this.dispose();
		this._lineMesh = MeshBuilder.CreateLineSystem("Physics 2D Joint Visuals", { lines: model.lines }, scene);
		this._lineMesh.color = new Color3(1, 0.45, 0.12);
		this._lineMesh.alpha = 0.95;
		this._lineMesh.isPickable = false;
		this._lineMesh.alwaysSelectAsActiveMesh = true;
		this._lineMesh.renderingGroupId = 3;
		setNodeSerializable(this._lineMesh, false);
		setNodeVisibleInGraph(this._lineMesh, false);

		this._handleMaterial ??= new StandardMaterial("Physics 2D Joint Handle Material", scene);
		this._handleMaterial.disableLighting = true;
		this._handleMaterial.emissiveColor = new Color3(1, 0.45, 0.12);
		this._handleMaterial.diffuseColor = new Color3(1, 0.45, 0.12);
		for (const descriptor of model.handles) {
			const handleMesh = MeshBuilder.CreateSphere(`Physics 2D Joint ${descriptor.kind}`, { diameter: 16, segments: 8 }, scene);
			handleMesh.position.copyFrom(descriptor.point);
			handleMesh.material = this._handleMaterial;
			handleMesh.renderOverlay = true;
			handleMesh.overlayColor = new Color3(1, 0.45, 0.12);
			handleMesh.overlayAlpha = 0.75;
			handleMesh.renderingGroupId = 3;
			handleMesh.alwaysSelectAsActiveMesh = true;
			handleMesh.metadata = {
				babylonEditorPhysics2DJointHandle: { selectedNodeId: model.selectedNodeId, jointId: descriptor.jointId, kind: descriptor.kind },
			};
			setNodeSerializable(handleMesh, false);
			setNodeVisibleInGraph(handleMesh, false);
			this._handleMeshes.push(handleMesh);
		}
		this._visualKey = visualKey;
	}

	/** Starts one exact raw transaction only when the pointer hits a known joint handle. */
	public begin(scene: Scene, x: number, y: number): boolean {
		if (this._drag) {
			return false;
		}
		const hit = scene.pick(x, y, (mesh) => Boolean(mesh.metadata?.babylonEditorPhysics2DJointHandle), false, scene.activeCamera ?? undefined);
		const handleMesh = hit.pickedMesh instanceof Mesh ? hit.pickedMesh : null;
		const metadata = handleMesh?.metadata?.babylonEditorPhysics2DJointHandle as { selectedNodeId?: string; jointId?: string; kind?: Physics2DJointHandleKind } | undefined;
		if (!metadata?.selectedNodeId || !metadata.jointId || !metadata.kind || !physics2DJointHandleKinds.includes(metadata.kind)) {
			return false;
		}
		this._drag = { selectedNodeId: metadata.selectedNodeId, jointId: metadata.jointId, kind: metadata.kind, before: capturePhysics2DJointSnapshot(scene) };
		return true;
	}

	/** Applies live exact-revision patches while retaining the pre-drag raw collection for one final Undo entry. */
	public move(scene: Scene, camera: Camera | null, x: number, y: number, editor: Editor): boolean {
		if (!this._drag || !camera) {
			return false;
		}
		const selected = scene.getNodeById(this._drag.selectedNodeId);
		if (!isAnyTransformNode(selected)) {
			return true;
		}
		const ray = scene.createPickingRay(x, y, Matrix.Identity(), camera);
		const distance = ray.intersectsPlane(Plane.FromPositionAndNormal(selected.position, new Vector3(0, 0, 1)));
		if (distance === null || !Number.isFinite(distance)) {
			return true;
		}
		const picked = ray.origin.add(ray.direction.scale(distance));
		const patch = getPhysics2DJointHandlePatch(scene, this._drag.jointId, this._drag.kind, [picked.x, picked.y]);
		if (!patch) {
			return true;
		}
		const normalized = normalizePhysics2DJointConfigurations(scene.metadata?.babylonEditorPhysics2DJoints ?? []);
		const joint = normalized.ok ? normalized.value.find((candidate) => candidate.id === this._drag!.jointId) : null;
		if (!joint) {
			return true;
		}
		const values = joint as unknown as Record<string, unknown>;
		if (Object.entries(patch).every(([property, value]) => isEquivalentPatchValue(values[property], value))) {
			return true;
		}
		setPhysics2DJoint(scene, { id: joint.id, expectedRevision: joint.revision, ...patch }, { editor });
		this._visualKey = null;
		return true;
	}

	/** Closes a drag as one whole-collection Undo/Redo unit regardless of the number of live pointer updates. */
	public finish(scene: Scene, editor: Editor, onRestored?: () => void): boolean {
		if (!this._drag) {
			return false;
		}
		const before = this._drag.before;
		this._drag = null;
		registerPhysics2DJointUndoRedo(scene, editor, before, capturePhysics2DJointSnapshot(scene), () => {
			this._visualKey = null;
			onRestored?.();
		});
		return true;
	}

	/** Rolls back an interrupted drag exactly, without adding a history entry during preview reset/unmount. */
	public cancel(scene: Scene, editor: Editor, onRestored?: () => void): boolean {
		if (!this._drag) {
			return false;
		}
		const before = this._drag.before;
		this._drag = null;
		restorePhysics2DJointSnapshot(scene, before, { editor });
		this._visualKey = null;
		onRestored?.();
		return true;
	}
}
