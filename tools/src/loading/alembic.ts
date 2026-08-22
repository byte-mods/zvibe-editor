import { Camera } from "@babylonjs/core/Cameras/camera";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import { GreasedLineBaseMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineBaseMesh";
import { GreasedLineMesh } from "@babylonjs/core/Meshes/GreasedLine/greasedLineMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { Node } from "@babylonjs/core/node";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Tools } from "@babylonjs/core/Misc/tools";
import { Scene } from "@babylonjs/core/scene";

import {
	AlembicFrameState,
	AlembicInterpolation,
	decodeAlembicFrame,
	getAlembicFrameBlend,
	IAlembicCacheDocument,
	IAlembicDecodedFrame,
	IAlembicMeshFrameState,
	IAlembicPointsFrameState,
	IAlembicCurvesFrameState,
	IAlembicCameraFrameState,
	parseAlembicCache,
} from "../assets/alembic";

export const ALEMBIC_PLAYER_CONFIGURATION_VERSION = 1;
export const ALEMBIC_PLAYER_METADATA_KEY = "babylonEditorAlembicPlayer";
export const ALEMBIC_OBJECT_METADATA_KEY = "babylonEditorAlembicObject";
const ALEMBIC_MATERIAL_METADATA_KEY = "babylonEditorAlembicMaterial";

export interface IAlembicPlayerConfiguration {
	version: typeof ALEMBIC_PLAYER_CONFIGURATION_VERSION;
	id: string;
	name: string;
	assetPath: string;
	revision: number;
	enabled: boolean;
	playOnAwake: boolean;
	loop: boolean;
	speed: number;
	interpolation: AlembicInterpolation;
	startTimeSeconds: number | null;
	endTimeSeconds: number | null;
	pointSize: number;
	curveWidth: number;
}

export interface IAlembicRuntimeState {
	id: string;
	revision: number;
	playing: boolean;
	currentTimeSeconds: number;
	startTimeSeconds: number;
	endTimeSeconds: number;
	durationSeconds: number;
	speed: number;
	loop: boolean;
	interpolation: AlembicInterpolation;
	currentFrame: number;
	nextFrame: number;
	blendAmount: number;
	loadedFrameIndices: number[];
	objectCount: number;
	lastError: string | null;
}

export interface ICreateAlembicPlayerOptions {
	root?: TransformNode;
	existingNodes?: readonly Node[];
	attachMetadata?: boolean;
}

type AlembicRuntimeNode = Mesh | FreeCamera;

function finite(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function nullableFinite(value: unknown, label: string): number | null {
	return value === null || value === undefined ? null : finite(value, label, -1_000_000, 1_000_000);
}

function requiredString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
		throw new Error(`${label} must be a non-empty string of at most ${maximum} characters.`);
	}
	return value;
}

/** Strictly normalizes serialized player metadata before it can allocate runtime resources. */
export function normalizeAlembicPlayerConfiguration(value: unknown): IAlembicPlayerConfiguration {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Alembic player configuration must be an object.");
	}
	const source = value as Partial<IAlembicPlayerConfiguration>;
	if (source.version !== ALEMBIC_PLAYER_CONFIGURATION_VERSION) {
		throw new Error(`Alembic player configuration requires version ${ALEMBIC_PLAYER_CONFIGURATION_VERSION}.`);
	}
	const revision = source.revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1 || revision > Number.MAX_SAFE_INTEGER) {
		throw new Error("Alembic player revision must be a positive safe integer.");
	}
	if (typeof source.enabled !== "boolean" || typeof source.playOnAwake !== "boolean" || typeof source.loop !== "boolean") {
		throw new Error("Alembic enabled, playOnAwake, and loop values must be Booleans.");
	}
	if (source.interpolation !== "hold" && source.interpolation !== "linear") {
		throw new Error("Alembic interpolation must be hold or linear.");
	}
	const speed = finite(source.speed, "Alembic playback speed", -100, 100);
	if (speed === 0) {
		throw new Error("Alembic playback speed must be non-zero.");
	}
	const startTimeSeconds = nullableFinite(source.startTimeSeconds, "Alembic playback startTimeSeconds");
	const endTimeSeconds = nullableFinite(source.endTimeSeconds, "Alembic playback endTimeSeconds");
	if (startTimeSeconds !== null && endTimeSeconds !== null && endTimeSeconds < startTimeSeconds) {
		throw new Error("Alembic playback endTimeSeconds must be greater than or equal to startTimeSeconds.");
	}
	return {
		version: ALEMBIC_PLAYER_CONFIGURATION_VERSION,
		id: requiredString(source.id, "Alembic player id", 256),
		name: requiredString(source.name, "Alembic player name", 512),
		assetPath: requiredString(source.assetPath, "Alembic assetPath", 4096).replace(/\\/g, "/"),
		revision,
		enabled: source.enabled,
		playOnAwake: source.playOnAwake,
		loop: source.loop,
		speed,
		interpolation: source.interpolation,
		startTimeSeconds,
		endTimeSeconds,
		pointSize: finite(source.pointSize, "Alembic pointSize", 0.01, 1_000),
		curveWidth: finite(source.curveWidth, "Alembic curveWidth", 0.01, 1_000),
	};
}

function playerMap(scene: Scene): Map<string, AlembicPlayer> {
	const existing = (scene as Scene & { alembicPlayers?: Map<string, AlembicPlayer> }).alembicPlayers;
	if (existing instanceof Map) {
		return existing;
	}
	const created = new Map<string, AlembicPlayer>();
	(scene as Scene & { alembicPlayers?: Map<string, AlembicPlayer> }).alembicPlayers = created;
	return created;
}

function materialColor(name: string, index: number): Color3 {
	let hash = 2166136261 ^ index;
	for (let character = 0; character < name.length; character++) {
		hash = Math.imul(hash ^ name.charCodeAt(character), 16777619);
	}
	const hue = ((hash >>> 0) % 360) / 360;
	return Color3.FromHSV(hue * 360, 0.45, 0.8);
}

function createMaterials(scene: Scene, playerId: string, objectIndex: number, slots: readonly string[]): StandardMaterial[] {
	const names = slots.length ? slots : ["Default"];
	return names.map((name, index) => {
		const material = new StandardMaterial(`Alembic:${playerId}:${objectIndex}:${name}`, scene);
		material.metadata = { ...(material.metadata ?? {}), [ALEMBIC_MATERIAL_METADATA_KEY]: { version: 1, playerId } };
		material.diffuseColor = materialColor(name, index);
		material.specularColor = new Color3(0.08, 0.08, 0.08);
		return material;
	});
}

function configureMeshMaterials(mesh: Mesh, materials: StandardMaterial[], playerId: string): Material {
	if (materials.length === 1) {
		mesh.material = materials[0];
		return materials[0];
	}
	const multi = new MultiMaterial(`${mesh.name}:AlembicMaterials`, mesh.getScene());
	multi.metadata = { ...(multi.metadata ?? {}), [ALEMBIC_MATERIAL_METADATA_KEY]: { version: 1, playerId } };
	multi.subMaterials = materials;
	mesh.material = multi;
	return multi;
}

function applySubMeshes(mesh: Mesh, state: IAlembicMeshFrameState, slotCount: number): void {
	mesh.releaseSubMeshes();
	if (!state.indices.length) {
		return;
	}
	if (!state.materialIndices?.length) {
		new SubMesh(0, 0, state.positions.length / 3, 0, state.indices.length, mesh);
		return;
	}
	let startTriangle = 0;
	let materialIndex = Math.min(slotCount - 1, state.materialIndices[0]);
	for (let triangle = 1; triangle <= state.materialIndices.length; triangle++) {
		const nextMaterial = triangle < state.materialIndices.length ? Math.min(slotCount - 1, state.materialIndices[triangle]) : -1;
		if (nextMaterial !== materialIndex) {
			new SubMesh(materialIndex, 0, state.positions.length / 3, startTriangle * 3, (triangle - startTriangle) * 3, mesh);
			startTriangle = triangle;
			materialIndex = nextMaterial;
		}
	}
}

function applyMesh(mesh: Mesh, state: IAlembicMeshFrameState, slotCount: number): void {
	mesh.setEnabled(state.visible);
	mesh.setVerticesData(VertexBuffer.PositionKind, state.positions, true, 3);
	if (state.normals) {
		mesh.setVerticesData(VertexBuffer.NormalKind, state.normals, true, 3);
	} else {
		mesh.removeVerticesData(VertexBuffer.NormalKind);
	}
	if (state.uvs) {
		mesh.setVerticesData(VertexBuffer.UVKind, state.uvs, true, 2);
	} else {
		mesh.removeVerticesData(VertexBuffer.UVKind);
	}
	if (state.colors) {
		mesh.setVerticesData(VertexBuffer.ColorKind, state.colors, true, 4);
	} else {
		mesh.removeVerticesData(VertexBuffer.ColorKind);
	}
	mesh.setIndices(state.indices, null, true);
	applySubMeshes(mesh, state, Math.max(1, slotCount));
	mesh.refreshBoundingInfo({ applySkeleton: false, applyMorph: false });
}

function sequentialIndices(vertexCount: number): Uint32Array {
	return Uint32Array.from({ length: vertexCount }, (_, index) => index);
}

function applyPoints(mesh: Mesh, state: IAlembicPointsFrameState, pointSize: number): void {
	mesh.setEnabled(state.visible);
	mesh.setVerticesData(VertexBuffer.PositionKind, state.positions, true, 3);
	if (state.colors) {
		mesh.setVerticesData(VertexBuffer.ColorKind, state.colors, true, 4);
	} else {
		mesh.removeVerticesData(VertexBuffer.ColorKind);
	}
	mesh.setIndices(sequentialIndices(state.positions.length / 3), null, true);
	const material = mesh.material as StandardMaterial;
	material.pointsCloud = true;
	material.pointSize = state.widths?.length ? Math.max(0.01, state.widths.reduce((sum, width) => sum + width, 0) / state.widths.length) : pointSize;
	mesh.refreshBoundingInfo({ applySkeleton: false, applyMorph: false });
}

function curvePoints(state: IAlembicCurvesFrameState): number[][] {
	const points: number[][] = [];
	let vertexOffset = 0;
	for (const length of state.segmentLengths) {
		const end = (vertexOffset + length) * 3;
		points.push(Array.from(state.positions.subarray(vertexOffset * 3, end)));
		vertexOffset += length;
	}
	return points;
}

function curveWidths(state: IAlembicCurvesFrameState): number[] {
	const widths: Float32Array = state.widths ?? new Float32Array(state.positions.length / 3).fill(1);
	return Array.from(widths).flatMap((width) => [Math.max(0.01, width), Math.max(0.01, width)]);
}

function curveColors(state: IAlembicCurvesFrameState): Color3[] | null {
	if (!state.colors) {
		return null;
	}
	const colors: Color3[] = [];
	for (let offset = 0; offset < state.colors.length; offset += 4) {
		colors.push(new Color3(state.colors[offset], state.colors[offset + 1], state.colors[offset + 2]));
	}
	return colors;
}

function applyCurves(mesh: GreasedLineBaseMesh, state: IAlembicCurvesFrameState, curveWidth: number): void {
	mesh.setEnabled(state.visible);
	const points = curvePoints(state);
	const widths = curveWidths(state);
	// GreasedLine setPoints rebuilds its vertex buffers from the already-owned width table;
	// update widths first so a larger or variable sample never leaves a shorter GPU attribute buffer.
	mesh.widths = widths;
	mesh.setPoints(points, { points, widths, updatable: true });
	if (mesh.greasedLineMaterial) {
		mesh.greasedLineMaterial.width = curveWidth;
		mesh.greasedLineMaterial.useColors = state.colors !== null;
		mesh.greasedLineMaterial.setColors(curveColors(state), false, true);
	}
	if (mesh instanceof GreasedLineMesh) {
		mesh.intersectionThreshold = curveWidth;
	}
	mesh.refreshBoundingInfo({ applySkeleton: false, applyMorph: false });
}

function applyCamera(camera: FreeCamera, state: IAlembicCameraFrameState): void {
	camera.setEnabled(state.visible);
	camera.position.copyFromFloats(...state.position);
	camera.upVector.copyFromFloats(...state.up).normalize();
	camera.setTarget(Vector3.FromArray(state.target));
	camera.fov = state.fovRadians;
	camera.minZ = Math.max(0.001, state.near);
	camera.maxZ = Math.max(camera.minZ + 0.001, state.far);
	camera.mode = state.orthographic ? Camera.ORTHOGRAPHIC_CAMERA : Camera.PERSPECTIVE_CAMERA;
	if (state.orthographic) {
		const aspect = camera.getEngine().getAspectRatio(camera);
		camera.orthoTop = state.orthographicSize;
		camera.orthoBottom = -state.orthographicSize;
		camera.orthoLeft = -state.orthographicSize * aspect;
		camera.orthoRight = state.orthographicSize * aspect;
	}
}

function lerpArray(left: Float32Array, right: Float32Array, amount: number): Float32Array {
	const result = new Float32Array(left.length);
	for (let index = 0; index < left.length; index++) {
		result[index] = left[index] + (right[index] - left[index]) * amount;
	}
	return result;
}

function equalArray(left: Uint32Array, right: Uint32Array): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function lerpTuple(left: [number, number, number], right: [number, number, number], amount: number): [number, number, number] {
	return [left[0] + (right[0] - left[0]) * amount, left[1] + (right[1] - left[1]) * amount, left[2] + (right[2] - left[2]) * amount];
}

function interpolatedState(left: AlembicFrameState, right: AlembicFrameState, amount: number): AlembicFrameState {
	if (left.kind !== right.kind || left.objectIndex !== right.objectIndex || amount <= 0) {
		return left;
	}
	if (left.kind === "camera" && right.kind === "camera") {
		return {
			...left,
			position: lerpTuple(left.position, right.position, amount),
			target: lerpTuple(left.target, right.target, amount),
			up: lerpTuple(left.up, right.up, amount),
			fovRadians: left.fovRadians + (right.fovRadians - left.fovRadians) * amount,
			near: left.near + (right.near - left.near) * amount,
			far: left.far + (right.far - left.far) * amount,
			orthographicSize: left.orthographicSize + (right.orthographicSize - left.orthographicSize) * amount,
		};
	}
	if (left.kind === "camera" || right.kind === "camera") {
		return left;
	}
	if (left.positions.length !== right.positions.length) {
		return left;
	}
	if (left.kind === "mesh" && right.kind === "mesh" && equalArray(left.indices, right.indices)) {
		return {
			...left,
			positions: lerpArray(left.positions, right.positions, amount),
			normals: left.normals && right.normals && left.normals.length === right.normals.length ? lerpArray(left.normals, right.normals, amount) : left.normals,
		};
	}
	if (left.kind === "points" && right.kind === "points") {
		return {
			...left,
			positions: lerpArray(left.positions, right.positions, amount),
			widths: left.widths && right.widths && left.widths.length === right.widths.length ? lerpArray(left.widths, right.widths, amount) : left.widths,
		};
	}
	if (left.kind === "curves" && right.kind === "curves" && equalArray(left.segmentLengths, right.segmentLengths)) {
		return {
			...left,
			positions: lerpArray(left.positions, right.positions, amount),
			widths: left.widths && right.widths && left.widths.length === right.widths.length ? lerpArray(left.widths, right.widths, amount) : left.widths,
		};
	}
	return left;
}

function nodeMetadata(node: Node): { version: 1; playerId: string; objectIndex: number; objectId: string; kind: string } | null {
	const value = node.metadata?.[ALEMBIC_OBJECT_METADATA_KEY];
	return value?.version === 1 && typeof value.playerId === "string" && Number.isSafeInteger(value.objectIndex) ? value : null;
}

function playerOwnsMaterial(material: Material | null, playerId: string): material is Material {
	const metadata = material?.metadata?.[ALEMBIC_MATERIAL_METADATA_KEY];
	return metadata?.version === 1 && metadata.playerId === playerId;
}

export class AlembicPlayer {
	public readonly root: TransformNode;
	public readonly document: IAlembicCacheDocument;
	public readonly nodes: ReadonlyMap<number, AlembicRuntimeNode>;

	private _configuration: IAlembicPlayerConfiguration;
	private _playing: boolean;
	private _currentTimeSeconds: number;
	private _currentFrame = 0;
	private _nextFrame = 0;
	private _blendAmount = 0;
	private _lastError: string | null = null;
	private _observer: Observer<Scene> | null;
	private _rootDisposeObserver: Observer<Node> | null;
	private _disposed = false;
	private _generation = 0;
	private _frames = new Map<number, IAlembicDecodedFrame>();
	private readonly _materials: Material[] = [];

	public constructor(
		private readonly _scene: Scene,
		document: IAlembicCacheDocument,
		configuration: IAlembicPlayerConfiguration,
		root: TransformNode,
		nodes: Map<number, AlembicRuntimeNode>,
		materials: Material[]
	) {
		this.document = document;
		this._configuration = configuration;
		this.root = root;
		this.nodes = nodes;
		this._materials = materials;
		this._playing = configuration.enabled && configuration.playOnAwake;
		this._currentTimeSeconds = this.startTimeSeconds;
		this._observer = _scene.onBeforeRenderObservable.add(() => this._tick(_scene.getEngine().getDeltaTime() / 1000));
		this._rootDisposeObserver = root.onDisposeObservable.add(() => this.dispose(false));
	}

	public get configuration(): IAlembicPlayerConfiguration {
		return structuredClone(this._configuration);
	}

	public get startTimeSeconds(): number {
		return Math.max(this.document.manifest.startTimeSeconds, this._configuration.startTimeSeconds ?? this.document.manifest.startTimeSeconds);
	}

	public get endTimeSeconds(): number {
		return Math.min(this.document.manifest.endTimeSeconds, this._configuration.endTimeSeconds ?? this.document.manifest.endTimeSeconds);
	}

	public get state(): IAlembicRuntimeState {
		return {
			id: this._configuration.id,
			revision: this._configuration.revision,
			playing: this._playing,
			currentTimeSeconds: this._currentTimeSeconds,
			startTimeSeconds: this.startTimeSeconds,
			endTimeSeconds: this.endTimeSeconds,
			durationSeconds: this.endTimeSeconds - this.startTimeSeconds,
			speed: this._configuration.speed,
			loop: this._configuration.loop,
			interpolation: this._configuration.interpolation,
			currentFrame: this._currentFrame,
			nextFrame: this._nextFrame,
			blendAmount: this._blendAmount,
			loadedFrameIndices: [...this._frames.keys()].sort((left, right) => left - right),
			objectCount: this.nodes.size,
			lastError: this._lastError,
		};
	}

	public play(): void {
		this._assertAlive();
		if (this._configuration.enabled) {
			this._playing = true;
		}
	}

	public pause(): void {
		this._assertAlive();
		this._playing = false;
	}

	public async stop(): Promise<void> {
		this._assertAlive();
		this._playing = false;
		await this.seek(this._configuration.speed >= 0 ? this.startTimeSeconds : this.endTimeSeconds);
	}

	public async seek(timeSeconds: number): Promise<IAlembicRuntimeState> {
		this._assertAlive();
		if (!Number.isFinite(timeSeconds)) {
			throw new Error("Alembic seek time must be finite.");
		}
		const clamped = Math.min(this.endTimeSeconds, Math.max(this.startTimeSeconds, timeSeconds));
		const generation = ++this._generation;
		const blend = getAlembicFrameBlend(this.document.manifest, clamped);
		const current = await this._frame(blend.current);
		const next = blend.next === blend.current ? current : await this._frame(blend.next);
		if (this._disposed || generation !== this._generation) {
			return this.state;
		}
		this._apply(current, next, this._configuration.interpolation === "linear" ? blend.amount : 0);
		this._currentTimeSeconds = clamped;
		this._currentFrame = blend.current;
		this._nextFrame = blend.next;
		this._blendAmount = this._configuration.interpolation === "linear" ? blend.amount : 0;
		this._lastError = null;
		return this.state;
	}

	public async updateConfiguration(configuration: IAlembicPlayerConfiguration): Promise<IAlembicRuntimeState> {
		this._assertAlive();
		const normalized = normalizeAlembicPlayerConfiguration(configuration);
		if (normalized.id !== this._configuration.id || normalized.assetPath !== this._configuration.assetPath) {
			throw new Error("Alembic player id and assetPath cannot be changed by runtime configuration updates.");
		}
		this._configuration = normalized;
		this.root.metadata ??= {};
		this.root.metadata[ALEMBIC_PLAYER_METADATA_KEY] = structuredClone(normalized);
		this._playing = normalized.enabled && this._playing;
		this._materials.forEach((material) => {
			if (material instanceof StandardMaterial && material.pointsCloud) {
				material.pointSize = normalized.pointSize;
			}
		});
		this.nodes.forEach((node) => {
			if (node instanceof GreasedLineBaseMesh && node.greasedLineMaterial) {
				node.greasedLineMaterial.width = normalized.curveWidth;
				if (node instanceof GreasedLineMesh) {
					node.intersectionThreshold = normalized.curveWidth;
				}
			}
		});
		return this.seek(this._currentTimeSeconds);
	}

	public dispose(disposeNodes = false): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._generation++;
		if (this._observer) {
			this._scene.onBeforeRenderObservable.remove(this._observer);
			this._observer = null;
		}
		if (this._rootDisposeObserver) {
			this.root.onDisposeObservable.remove(this._rootDisposeObserver);
			this._rootDisposeObserver = null;
		}
		playerMap(this._scene).delete(this._configuration.id);
		this._frames.clear();
		if (disposeNodes && !this.root.isDisposed()) {
			this.root.dispose(false, false);
		}
		this._materials.splice(0).forEach((material) => material.dispose(true, true, material instanceof MultiMaterial));
	}

	private _tick(deltaSeconds: number): void {
		if (!this._playing || this._disposed || !this._configuration.enabled || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
			return;
		}
		let next = this._currentTimeSeconds + deltaSeconds * this._configuration.speed;
		const start = this.startTimeSeconds;
		const end = this.endTimeSeconds;
		const duration = end - start;
		if (this._configuration.loop && duration > 0) {
			next = start + ((((next - start) % duration) + duration) % duration);
		} else if (next < start || next > end) {
			next = Math.min(end, Math.max(start, next));
			this._playing = false;
		}
		void this.seek(next).catch((error) => {
			this._lastError = error instanceof Error ? error.message : String(error);
			this._playing = false;
		});
	}

	private async _frame(index: number): Promise<IAlembicDecodedFrame> {
		const cached = this._frames.get(index);
		if (cached) {
			this._frames.delete(index);
			this._frames.set(index, cached);
			return cached;
		}
		const decoded = await decodeAlembicFrame(this.document, index);
		this._frames.set(index, decoded);
		while (this._frames.size > 2) {
			const oldest = this._frames.keys().next();
			if (oldest.done) {
				break;
			}
			this._frames.delete(oldest.value);
		}
		return decoded;
	}

	private _apply(current: IAlembicDecodedFrame, next: IAlembicDecodedFrame, amount: number): void {
		for (let objectIndex = 0; objectIndex < current.states.length; objectIndex++) {
			const object = this.document.manifest.objects[objectIndex];
			const state = object.topology === "stable" ? interpolatedState(current.states[objectIndex], next.states[objectIndex], amount) : current.states[objectIndex];
			const node = this.nodes.get(objectIndex);
			if (!node) {
				throw new Error(`Alembic runtime node ${objectIndex} is unavailable.`);
			}
			if (state.kind === "mesh" && node instanceof Mesh && !(node instanceof GreasedLineBaseMesh)) {
				applyMesh(node, state, Math.max(1, object.materialSlots.length));
			} else if (state.kind === "points" && node instanceof Mesh && !(node instanceof GreasedLineBaseMesh)) {
				applyPoints(node, state, this._configuration.pointSize);
			} else if (state.kind === "curves" && node instanceof GreasedLineBaseMesh) {
				applyCurves(node, state, this._configuration.curveWidth);
			} else if (state.kind === "camera" && node instanceof FreeCamera) {
				applyCamera(node, state);
			} else {
				throw new Error(`Alembic runtime node ${objectIndex} does not match its ${state.kind} state.`);
			}
		}
	}

	private _assertAlive(): void {
		if (this._disposed) {
			throw new Error(`Alembic player "${this._configuration.id}" is disposed.`);
		}
	}
}

function createRuntimeNodes(
	scene: Scene,
	document: IAlembicCacheDocument,
	configuration: IAlembicPlayerConfiguration,
	root: TransformNode,
	existingNodes: readonly Node[]
): { nodes: Map<number, AlembicRuntimeNode>; materials: Material[] } {
	const existing = new Map<number, AlembicRuntimeNode>();
	existingNodes.forEach((node) => {
		const metadata = nodeMetadata(node);
		if (metadata?.playerId === configuration.id && metadata.objectIndex >= 0 && metadata.objectIndex < document.manifest.objects.length) {
			existing.set(metadata.objectIndex, node as AlembicRuntimeNode);
		}
	});
	const nodes = new Map<number, AlembicRuntimeNode>();
	const materials: Material[] = [];
	document.manifest.objects.forEach((object, objectIndex) => {
		let node = existing.get(objectIndex);
		if (!node) {
			if (object.kind === "camera") {
				node = new FreeCamera(object.name, Vector3.Zero(), scene);
			} else if (object.kind === "curves") {
				node = CreateGreasedLine(
					object.name,
					{ points: [0, 0, 0, 0, 0, 0], updatable: true },
					{ color: materialColor(object.name, objectIndex), sizeAttenuation: false, useColors: true, width: configuration.curveWidth },
					scene
				);
				if (node.material) {
					node.material.metadata = { ...(node.material.metadata ?? {}), [ALEMBIC_MATERIAL_METADATA_KEY]: { version: 1, playerId: configuration.id } };
					materials.push(node.material);
				}
			} else {
				node = new Mesh(object.name, scene);
			}
			node.parent = root;
		}
		node.id = `${configuration.id}:${object.id}`;
		node.metadata ??= {};
		node.metadata[ALEMBIC_OBJECT_METADATA_KEY] = { version: 1, playerId: configuration.id, objectIndex, objectId: object.id, kind: object.kind };
		if (object.kind === "mesh" && node instanceof Mesh && !(node instanceof GreasedLineBaseMesh) && !node.material) {
			const created = createMaterials(scene, configuration.id, objectIndex, object.materialSlots);
			materials.push(configureMeshMaterials(node, created, configuration.id));
		} else if (object.kind === "points" && node instanceof Mesh && !(node instanceof GreasedLineBaseMesh) && !node.material) {
			const [created] = createMaterials(scene, configuration.id, objectIndex, ["Points"]);
			created.pointsCloud = true;
			created.pointSize = configuration.pointSize;
			materials.push(created);
			node.material = created;
		} else if (node instanceof Mesh && playerOwnsMaterial(node.material, configuration.id) && !materials.includes(node.material)) {
			materials.push(node.material);
		}
		nodes.set(objectIndex, node);
	});
	return { nodes, materials };
}

/** Instantiates or rebinds one validated portable Alembic cache and applies its first sample. */
export async function createAlembicPlayer(
	scene: Scene,
	bytes: Uint8Array,
	configurationValue: IAlembicPlayerConfiguration,
	options: ICreateAlembicPlayerOptions = {}
): Promise<AlembicPlayer> {
	const configuration = normalizeAlembicPlayerConfiguration(configurationValue);
	if (playerMap(scene).has(configuration.id)) {
		throw new Error(`Alembic player id "${configuration.id}" already exists in the scene.`);
	}
	const document = parseAlembicCache(bytes);
	const root = options.root ?? new TransformNode(configuration.name, scene);
	root.id = configuration.id;
	root.metadata ??= {};
	if (options.attachMetadata !== false) {
		root.metadata[ALEMBIC_PLAYER_METADATA_KEY] = structuredClone(configuration);
	}
	const runtimeNodes = createRuntimeNodes(scene, document, configuration, root, options.existingNodes ?? scene.getNodes());
	const player = new AlembicPlayer(scene, document, configuration, root, runtimeNodes.nodes, runtimeNodes.materials);
	playerMap(scene).set(configuration.id, player);
	try {
		await player.seek(configuration.speed >= 0 ? player.startTimeSeconds : player.endTimeSeconds);
		return player;
	} catch (error) {
		player.dispose(!options.root);
		throw error;
	}
}

async function loadBinary(path: string): Promise<Uint8Array> {
	const value: unknown = await Tools.LoadFileAsync(path, true);
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	throw new Error(`Alembic cache "${path}" did not return binary bytes.`);
}

function resolvedAssetPath(rootUrl: string, assetPath: string): string {
	return /^(?:data:|blob:|https?:\/\/|file:)/i.test(assetPath) || assetPath.startsWith("/") ? assetPath : `${rootUrl}${assetPath}`;
}

/** Configures every serialized Alembic root in a full or additive scene scope. */
export async function configureAlembicPlayers(scene: Scene, rootUrl: string, roots: readonly TransformNode[] = scene.transformNodes): Promise<Map<string, AlembicPlayer>> {
	for (const root of roots) {
		const raw = root.metadata?.[ALEMBIC_PLAYER_METADATA_KEY];
		if (!raw) {
			continue;
		}
		const configuration = normalizeAlembicPlayerConfiguration(raw);
		if (playerMap(scene).has(configuration.id)) {
			continue;
		}
		const bytes = await loadBinary(resolvedAssetPath(rootUrl, configuration.assetPath));
		await createAlembicPlayer(scene, bytes, configuration, { root, existingNodes: root.getDescendants(false), attachMetadata: true });
	}
	return playerMap(scene);
}

export function getAlembicPlayer(scene: Scene, id: string): AlembicPlayer | null {
	return playerMap(scene).get(id) ?? null;
}

export function listAlembicPlayers(scene: Scene): AlembicPlayer[] {
	return [...playerMap(scene).values()];
}
