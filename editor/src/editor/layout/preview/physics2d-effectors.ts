import { Camera, Color3, LinesMesh, Matrix, Mesh, MeshBuilder, Plane, Scene, StandardMaterial, Vector3 } from "babylonjs";
import {
	IPhysics2DBodyConfiguration,
	IPhysics2DColliderConfiguration,
	IPhysics2DEffectorConfiguration,
	IPhysics2DPoint,
	normalizePhysics2DBodyConfiguration,
	normalizePhysics2DEffectorConfigurations,
} from "babylonjs-editor-tools";

import { Editor } from "../../main";

import { isAnyTransformNode, isMesh } from "../../../tools/guards/nodes";
import { setNodeSerializable, setNodeVisibleInGraph } from "../../../tools/node/metadata";

import { capturePhysics2DEffectorSnapshot, IPhysics2DEffectorCollectionSnapshot, setPhysics2DEffector } from "../../../mcp/physics2d/physics2d";

import { registerPhysics2DEffectorUndoRedo } from "../inspector/mesh/physics2d-effector-transaction";

export type Physics2DEffectorHandleKind = "area-angle" | "platform-angle" | "platform-arc" | "buoyancy-surface" | "buoyancy-flow";

export interface IPhysics2DEffectorViewportHandle {
	kind: Physics2DEffectorHandleKind;
	effectorId: string;
	point: Vector3;
}

export interface IPhysics2DEffectorViewportModel {
	nodeId: string;
	effectorId: string;
	revision: number;
	bodyRevision: number | null;
	lines: Vector3[][];
	handles: IPhysics2DEffectorViewportHandle[];
	truncated: boolean;
}

const MaxViewportLinePoints = 4096;
const CircleSegments = 48;

type IPhysics2DViewportNode = {
	id: string;
	position: Vector3;
	rotation: Vector3;
	scaling: Vector3;
};

function worldPoint(node: IPhysics2DViewportNode, point: IPhysics2DPoint, offset: IPhysics2DPoint = [0, 0]): Vector3 {
	const x = point[0] + offset[0];
	const y = point[1] + offset[1];
	const cosine = Math.cos(node.rotation.z);
	const sine = Math.sin(node.rotation.z);
	return new Vector3(node.position.x + x * cosine - y * sine, node.position.y + x * sine + y * cosine, node.position.z - 3);
}

function roundedSegment(first: IPhysics2DPoint, second: IPhysics2DPoint, radius: number): IPhysics2DPoint[] {
	const length = Math.hypot(second[0] - first[0], second[1] - first[1]);
	const direction: IPhysics2DPoint = length ? [(second[0] - first[0]) / length, (second[1] - first[1]) / length] : [1, 0];
	const normal: IPhysics2DPoint = [-direction[1], direction[0]];
	return [
		...Array.from({ length: CircleSegments / 2 + 1 }, (_value, index): IPhysics2DPoint => {
			const angle = -Math.PI / 2 + (Math.PI * index) / (CircleSegments / 2);
			return [
				second[0] + radius * (direction[0] * Math.cos(angle) + normal[0] * Math.sin(angle)),
				second[1] + radius * (direction[1] * Math.cos(angle) + normal[1] * Math.sin(angle)),
			];
		}),
		...Array.from({ length: CircleSegments / 2 + 1 }, (_value, index): IPhysics2DPoint => {
			const angle = Math.PI / 2 + (Math.PI * index) / (CircleSegments / 2);
			return [
				first[0] + radius * (direction[0] * Math.cos(angle) + normal[0] * Math.sin(angle)),
				first[1] + radius * (direction[1] * Math.cos(angle) + normal[1] * Math.sin(angle)),
			];
		}),
	];
}

function colliderLoops(collider: IPhysics2DColliderConfiguration): { points: IPhysics2DPoint[]; closed: boolean }[] {
	const offset = collider.offset;
	if (collider.shape === "circle") {
		return [
			{
				points: Array.from({ length: CircleSegments }, (_value, index): IPhysics2DPoint => {
					const angle = (Math.PI * 2 * index) / CircleSegments;
					return [Math.cos(angle) * collider.radius!, Math.sin(angle) * collider.radius!];
				}),
				closed: true,
			},
		].map((loop) => ({ ...loop, points: loop.points.map((point) => [point[0] + offset[0], point[1] + offset[1]]) }));
	}
	if (collider.shape === "box") {
		const halfWidth = collider.size![0] / 2;
		const halfHeight = collider.size![1] / 2;
		return [
			{
				points: [
					[-halfWidth, -halfHeight],
					[halfWidth, -halfHeight],
					[halfWidth, halfHeight],
					[-halfWidth, halfHeight],
				],
				closed: true,
			},
		].map((loop) => ({
			...loop,
			points: loop.points.map((point) => [point[0] + offset[0], point[1] + offset[1]]),
		}));
	}
	if (collider.shape === "capsule") {
		const radius = Math.min(collider.size![0], collider.size![1]) / 2;
		const horizontal = collider.direction === "horizontal";
		const halfLength = Math.max(0, (collider.size![horizontal ? 0 : 1] - radius * 2) / 2);
		const points = roundedSegment(horizontal ? [-halfLength, 0] : [0, -halfLength], horizontal ? [halfLength, 0] : [0, halfLength], radius);
		return [{ points: points.map((point) => [point[0] + offset[0], point[1] + offset[1]]), closed: true }];
	}
	if (collider.shape === "polygon" && collider.contours?.length) {
		return collider.contours
			.flatMap((contour) => [contour.points, ...contour.holes.map((hole) => hole.points)])
			.map((points) => ({
				points: points.map((point) => [point[0] + offset[0], point[1] + offset[1]]),
				closed: true,
			}));
	}
	return [{ points: collider.points!.map((point) => [point[0] + offset[0], point[1] + offset[1]]), closed: collider.shape === "polygon" }];
}

function normalizedBody(scene: Scene, nodeId: string): IPhysics2DBodyConfiguration | null {
	const source = (scene.metadata?.babylonEditorPhysics2D ?? []).find((candidate: any) => candidate?.nodeId === nodeId);
	const normalized = source ? normalizePhysics2DBodyConfiguration(source) : null;
	return normalized?.ok ? normalized.value : null;
}

function addArrow(lines: Vector3[][], origin: Vector3, angle: number, length: number): Vector3 {
	const endpoint = new Vector3(origin.x + Math.cos(angle) * length, origin.y + Math.sin(angle) * length, origin.z);
	const headLength = Math.max(8, length * 0.18);
	lines.push([origin, endpoint]);
	lines.push([endpoint, new Vector3(endpoint.x + Math.cos(angle + Math.PI * 0.8) * headLength, endpoint.y + Math.sin(angle + Math.PI * 0.8) * headLength, endpoint.z)]);
	lines.push([endpoint, new Vector3(endpoint.x + Math.cos(angle - Math.PI * 0.8) * headLength, endpoint.y + Math.sin(angle - Math.PI * 0.8) * headLength, endpoint.z)]);
	return endpoint;
}

function addArc(lines: Vector3[][], origin: Vector3, angle: number, arcDegrees: number, radius: number): Vector3 {
	const arc = Math.max(0, Math.min(360, arcDegrees));
	const segments = Math.max(2, Math.ceil((CircleSegments * arc) / 360));
	const start = angle - (arc * Math.PI) / 360;
	const points = Array.from({ length: segments + 1 }, (_value, index) => {
		const current = start + ((arc * Math.PI) / 180) * (index / segments);
		return new Vector3(origin.x + Math.cos(current) * radius, origin.y + Math.sin(current) * radius, origin.z);
	});
	lines.push(points, [origin, points[0]], [origin, points[points.length - 1]]);
	return points[points.length - 1];
}

function effectorAngle(node: IPhysics2DViewportNode, effector: IPhysics2DEffectorConfiguration): number {
	if (effector.type === "area") {
		return (effector.forceAngle * Math.PI) / 180 + (effector.useGlobalAngle ? 0 : node.rotation.z);
	}
	if (effector.type === "platform") {
		return effector.usesLegacyWorldAngle ? (effector.platformAngle * Math.PI) / 180 : node.rotation.z + Math.PI / 2 + (effector.rotationalOffset * Math.PI) / 180;
	}
	return effector.type === "buoyancy" ? (effector.flowAngle * Math.PI) / 180 : 0;
}

/** Builds a bounded pure visual model in the exact position/rotation frames used by the shared solver. */
export function buildPhysics2DEffectorViewportModel(scene: Scene, nodeId: string): IPhysics2DEffectorViewportModel | null {
	const node = scene.getNodeById(nodeId);
	if (!isAnyTransformNode(node)) {
		return null;
	}
	const normalized = normalizePhysics2DEffectorConfigurations(scene.metadata?.babylonEditorPhysics2DEffectors ?? []);
	if (!normalized.ok) {
		return null;
	}
	const effector = normalized.value.find((candidate) => candidate.nodeId === nodeId);
	if (!effector) {
		return null;
	}
	const body = normalizedBody(scene, nodeId);
	const loops = body
		? colliderLoops(body.collider)
		: "radius" in effector
			? [
					{
						points: Array.from(
							{ length: CircleSegments },
							(_value, index): IPhysics2DPoint => [
								Math.cos((Math.PI * 2 * index) / CircleSegments) * effector.radius,
								Math.sin((Math.PI * 2 * index) / CircleSegments) * effector.radius,
							]
						),
						closed: true,
					},
				]
			: [];
	const lines: Vector3[][] = loops.map((loop) => {
		const points = loop.points.map((point) => worldPoint(node, point));
		return loop.closed && points.length ? [...points, points[0]] : points;
	});
	const handles: IPhysics2DEffectorViewportHandle[] = [];
	const allPoints = lines.flat();
	const origin = body ? worldPoint(node, body.collider.offset) : new Vector3(node.position.x, node.position.y, node.position.z - 3);
	const extent = Math.max(50, ...allPoints.map((point) => Math.hypot(point.x - origin.x, point.y - origin.y)));
	if (effector.type === "point") {
		const directionOffset = effector.forceMagnitude >= 0 ? 0 : Math.PI;
		for (let index = 0; index < 4; index++) {
			const angle = (Math.PI * index) / 2;
			const start = new Vector3(origin.x + Math.cos(angle) * extent * 0.3, origin.y + Math.sin(angle) * extent * 0.3, origin.z);
			addArrow(lines, start, angle + directionOffset, extent * 0.55);
		}
	} else if (effector.type === "area") {
		const endpoint = addArrow(lines, origin, effectorAngle(node, effector), extent);
		handles.push({ kind: "area-angle", effectorId: effector.id, point: endpoint });
	} else if (effector.type === "surface") {
		for (const line of lines.slice(0, loops.length)) {
			const stride = Math.max(1, Math.ceil((line.length - 1) / 8));
			for (let index = 0; index < line.length - 1; index += stride) {
				const first = line[index];
				const second = line[Math.min(line.length - 1, index + 1)];
				// The solver tangent is clockwise from the outward contact normal, opposite a CCW collider outline.
				const angle = Math.atan2(second.y - first.y, second.x - first.x) + (effector.speed >= 0 ? Math.PI : 0);
				addArrow(lines, first.add(second).scale(0.5), angle, Math.min(40, extent * 0.3));
			}
		}
	} else if (effector.type === "platform") {
		const angle = effectorAngle(node, effector);
		const endpoint = addArrow(lines, origin, angle, extent);
		const arcEndpoint = addArc(lines, origin, angle, effector.surfaceArc, extent * 0.75);
		addArc(lines, origin, angle + Math.PI / 2, effector.sideArc, extent * 0.45);
		addArc(lines, origin, angle - Math.PI / 2, effector.sideArc, extent * 0.45);
		handles.push({ kind: "platform-angle", effectorId: effector.id, point: endpoint }, { kind: "platform-arc", effectorId: effector.id, point: arcEndpoint });
	} else {
		const surfaceY = node.position.y + effector.surfaceLevel * node.scaling.y;
		const minimumX = allPoints.length ? Math.min(...allPoints.map((point) => point.x)) : node.position.x - extent;
		const maximumX = allPoints.length ? Math.max(...allPoints.map((point) => point.x)) : node.position.x + extent;
		const margin = Math.max(20, (maximumX - minimumX) * 0.1);
		const first = new Vector3(minimumX - margin, surfaceY, origin.z);
		const second = new Vector3(maximumX + margin, surfaceY, origin.z);
		lines.push([first, second]);
		const flowOrigin = new Vector3(node.position.x, surfaceY, origin.z);
		const flowEndpoint = addArrow(lines, flowOrigin, effectorAngle(node, effector), extent);
		handles.push({ kind: "buoyancy-surface", effectorId: effector.id, point: second }, { kind: "buoyancy-flow", effectorId: effector.id, point: flowEndpoint });
	}
	let pointCount = 0;
	const boundedLines = lines.filter((line) => {
		if (line.length < 2 || pointCount + line.length > MaxViewportLinePoints) {
			return false;
		}
		pointCount += line.length;
		return true;
	});
	return {
		nodeId,
		effectorId: effector.id,
		revision: effector.revision,
		bodyRevision: body?.revision ?? null,
		lines: boundedLines,
		handles,
		truncated: boundedLines.length !== lines.length,
	};
}

type IPhysics2DEffectorDrag = {
	nodeId: string;
	effectorId: string;
	kind: Physics2DEffectorHandleKind;
	before: IPhysics2DEffectorCollectionSnapshot;
};

export class EditorPhysics2DEffectorViewport {
	private _lineMesh: LinesMesh | null = null;
	private _handleMeshes: Mesh[] = [];
	private _handleMaterial: StandardMaterial | null = null;
	private _visualKey: string | null = null;
	private _drag: IPhysics2DEffectorDrag | null = null;

	public dispose(disposeMaterial = false): void {
		this._lineMesh?.dispose(false, false);
		this._lineMesh = null;
		this._handleMeshes.forEach((handle) => handle.dispose(false, false));
		this._handleMeshes = [];
		this._visualKey = null;
		if (disposeMaterial) {
			this._handleMaterial?.dispose(true, true);
			this._handleMaterial = null;
			this._drag = null;
		}
	}

	public sync(scene: Scene, selected: unknown): void {
		if (!isAnyTransformNode(selected)) {
			this.dispose();
			return;
		}
		const model = buildPhysics2DEffectorViewportModel(scene, selected.id);
		if (!model) {
			this.dispose();
			return;
		}
		const key = `${model.nodeId}:${model.revision}:${model.bodyRevision ?? "none"}:${selected.position.asArray().join(",")}:${selected.rotation.z}:${selected.scaling.asArray().join(",")}`;
		if (key === this._visualKey && this._lineMesh && !this._lineMesh.isDisposed() && this._handleMeshes.every((handle) => !handle.isDisposed())) {
			return;
		}
		this.dispose();
		this._lineMesh = MeshBuilder.CreateLineSystem("Physics 2D Effector Handles", { lines: model.lines }, scene);
		this._lineMesh.color = new Color3(0.15, 0.85, 1);
		this._lineMesh.alpha = 0.95;
		this._lineMesh.isPickable = false;
		this._lineMesh.alwaysSelectAsActiveMesh = true;
		this._lineMesh.renderingGroupId = 3;
		setNodeSerializable(this._lineMesh, false);
		setNodeVisibleInGraph(this._lineMesh, false);
		this._handleMaterial ??= new StandardMaterial("Physics 2D Effector Handle Material", scene);
		this._handleMaterial.disableLighting = true;
		this._handleMaterial.emissiveColor = new Color3(0.15, 0.85, 1);
		this._handleMaterial.diffuseColor = new Color3(0.15, 0.85, 1);
		for (const descriptor of model.handles) {
			const handle = MeshBuilder.CreateSphere(`Physics 2D ${descriptor.kind}`, { diameter: 16, segments: 8 }, scene);
			handle.position.copyFrom(descriptor.point);
			handle.material = this._handleMaterial;
			handle.renderOverlay = true;
			handle.overlayColor = new Color3(0.15, 0.85, 1);
			handle.overlayAlpha = 0.75;
			handle.renderingGroupId = 3;
			handle.alwaysSelectAsActiveMesh = true;
			handle.metadata = { babylonEditorPhysics2DEffectorHandle: { nodeId: model.nodeId, effectorId: descriptor.effectorId, kind: descriptor.kind } };
			setNodeSerializable(handle, false);
			setNodeVisibleInGraph(handle, false);
			this._handleMeshes.push(handle);
		}
		this._visualKey = key;
	}

	public begin(scene: Scene, x: number, y: number): boolean {
		const hit = scene.pick(x, y, (mesh) => Boolean(mesh.metadata?.babylonEditorPhysics2DEffectorHandle), false, scene.activeCamera ?? undefined);
		const handle = isMesh(hit.pickedMesh) ? hit.pickedMesh : null;
		const metadata = handle?.metadata?.babylonEditorPhysics2DEffectorHandle as { nodeId?: string; effectorId?: string; kind?: Physics2DEffectorHandleKind } | undefined;
		if (!metadata?.nodeId || !metadata.effectorId || !metadata.kind) {
			return false;
		}
		this._drag = { nodeId: metadata.nodeId, effectorId: metadata.effectorId, kind: metadata.kind, before: capturePhysics2DEffectorSnapshot(scene) };
		return true;
	}

	public move(scene: Scene, camera: Camera | null, x: number, y: number, editor: Editor): boolean {
		if (!this._drag || !camera) {
			return false;
		}
		const node = scene.getNodeById(this._drag.nodeId);
		if (!isAnyTransformNode(node)) {
			return true;
		}
		const ray = scene.createPickingRay(x, y, Matrix.Identity(), camera);
		const distance = ray.intersectsPlane(Plane.FromPositionAndNormal(new Vector3(node.position.x, node.position.y, node.position.z), new Vector3(0, 0, 1)));
		if (distance === null) {
			return true;
		}
		const point = ray.origin.add(ray.direction.scale(distance));
		const normalized = normalizePhysics2DEffectorConfigurations(scene.metadata?.babylonEditorPhysics2DEffectors ?? []);
		const effector = normalized.ok ? normalized.value.find((candidate) => candidate.id === this._drag!.effectorId) : null;
		if (!effector) {
			return true;
		}
		const body = normalizedBody(scene, node.id);
		const angleOrigin = body ? worldPoint(node, body.collider.offset) : node.position;
		const surfaceY = effector.type === "buoyancy" ? node.position.y + effector.surfaceLevel * node.scaling.y : node.position.y;
		const worldAngle = Math.atan2(
			point.y - (effector.type === "buoyancy" ? surfaceY : angleOrigin.y),
			point.x - (effector.type === "buoyancy" ? node.position.x : angleOrigin.x)
		);
		let patch: Record<string, unknown>;
		if (this._drag.kind === "area-angle" && effector.type === "area") {
			patch = { forceAngle: ((worldAngle - (effector.useGlobalAngle ? 0 : node.rotation.z)) * 180) / Math.PI };
		} else if (this._drag.kind === "platform-angle" && effector.type === "platform") {
			patch = effector.usesLegacyWorldAngle
				? { platformAngle: (worldAngle * 180) / Math.PI }
				: { rotationalOffset: ((worldAngle - node.rotation.z - Math.PI / 2) * 180) / Math.PI };
		} else if (this._drag.kind === "platform-arc" && effector.type === "platform") {
			const axis = effectorAngle(node, effector);
			const delta = Math.atan2(Math.sin(worldAngle - axis), Math.cos(worldAngle - axis));
			patch = { surfaceArc: Math.min(360, Math.max(0, (Math.abs(delta) * 360) / Math.PI)) };
		} else if (this._drag.kind === "buoyancy-surface" && effector.type === "buoyancy" && Math.abs(node.scaling.y) > 0.000001) {
			patch = { surfaceLevel: Math.min(1e6, Math.max(-1e6, (point.y - node.position.y) / node.scaling.y)) };
		} else if (this._drag.kind === "buoyancy-flow" && effector.type === "buoyancy") {
			patch = { flowAngle: (worldAngle * 180) / Math.PI };
		} else {
			return true;
		}
		if (
			Object.entries(patch).every(([property, value]) => typeof value === "number" && Math.abs((effector as unknown as Record<string, number>)[property] - value) < 0.000001)
		) {
			return true;
		}
		setPhysics2DEffector(scene, { id: effector.id, expectedRevision: effector.revision, ...patch }, { editor });
		this._visualKey = null;
		return true;
	}

	public finish(scene: Scene, editor: Editor, onRestored?: () => void): boolean {
		if (!this._drag) {
			return false;
		}
		const before = this._drag.before;
		this._drag = null;
		registerPhysics2DEffectorUndoRedo(scene, editor, before, capturePhysics2DEffectorSnapshot(scene), () => {
			this._visualKey = null;
			onRestored?.();
		});
		return true;
	}
}
