import { Observable } from "@babylonjs/core/Misc/observable";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";

export type TerrainStreamingTileStatus = "resident" | "unloaded" | "queued" | "loading" | "loaded" | "error";

export interface ITerrainStreamingBinaryDescriptor {
	count: number;
	stride: number;
	offset: number;
	dataType: number;
}

export interface ITerrainStreamingBinaryInfo {
	positionsAttrDesc?: ITerrainStreamingBinaryDescriptor;
	normalsAttrDesc?: ITerrainStreamingBinaryDescriptor;
	tangetsAttrDesc?: ITerrainStreamingBinaryDescriptor;
	uvsAttrDesc?: ITerrainStreamingBinaryDescriptor;
	uvs2AttrDesc?: ITerrainStreamingBinaryDescriptor;
	colorsAttrDesc?: ITerrainStreamingBinaryDescriptor;
	matricesIndicesAttrDesc?: ITerrainStreamingBinaryDescriptor;
	matricesWeightsAttrDesc?: ITerrainStreamingBinaryDescriptor;
	matricesIndicesExtraAttrDesc?: ITerrainStreamingBinaryDescriptor;
	matricesWeightsExtraAttrDesc?: ITerrainStreamingBinaryDescriptor;
	indicesAttrDesc?: ITerrainStreamingBinaryDescriptor;
	subMeshesAttrDesc?: ITerrainStreamingBinaryDescriptor;
}

export interface ITerrainStreamingTileAsset {
	terrainId: string;
	url: string;
	sha256: string;
	byteLength: number;
	binaryInfo: ITerrainStreamingBinaryInfo;
}

export interface ITerrainStreamingGroup {
	version?: 1 | 2;
	revision?: number;
	id?: string;
	name?: string;
	terrainIds: string[];
	distance: number;
	targetNodeId?: string;
	enabled: boolean;
	releaseGeometry?: boolean;
	streamGeometry?: boolean;
	preloadDistance?: number;
	unloadDistance?: number;
	unloadDelayMs?: number;
	maxConcurrentLoads?: number;
	retryCount?: number;
	requestTimeoutMs?: number;
	remoteBaseUrl?: string;
	tiles?: ITerrainStreamingTileAsset[];
}

export interface ITerrainStreamingExportArtifact extends ITerrainStreamingTileAsset {}

export interface ITerrainStreamingExportEvidence {
	groupCount: number;
	tileCount: number;
	streamedBytes: number;
	sharedArtifactCount: number;
}

export interface ITerrainStreamingRuntimeOptions {
	fetch?: typeof fetch;
	now?: () => number;
}

export interface ITerrainStreamingTileState {
	terrainId: string;
	groupId: string | null;
	status: TerrainStreamingTileStatus;
	url: string | null;
	distance: number | null;
	attempts: number;
	bytesLoaded: number;
	verified: boolean;
	lastLoadMs: number | null;
	error: string | null;
}

interface ITerrainStreamingTileRuntime extends ITerrainStreamingTileState {
	nextRetryAt: number;
	outsideSince: number | null;
}

interface IReleasedGeometry {
	vertices: Array<{ kind: string; data: number[]; stride: number }>;
	indices: number[];
	subMeshes: Array<{ materialIndex: number; verticesStart: number; verticesCount: number; indexStart: number; indexCount: number }>;
}

const releasedGeometry = new WeakMap<Scene, Map<string, IReleasedGeometry>>();

function cloneSerializable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function terrainGroups(scene: Scene): ITerrainStreamingGroup[] {
	return (scene.metadata?.babylonEditorTerrainStreamingGroups as ITerrainStreamingGroup[] | undefined) ?? [];
}

function validateDescriptor(descriptor: ITerrainStreamingBinaryDescriptor, bytes: ArrayBuffer, bytesPerValue: number, multiplier = 1): void {
	if (
		!Number.isSafeInteger(descriptor.offset) ||
		descriptor.offset < 0 ||
		!Number.isSafeInteger(descriptor.count) ||
		descriptor.count < 1 ||
		descriptor.offset % bytesPerValue !== 0 ||
		descriptor.offset + descriptor.count * multiplier * bytesPerValue > bytes.byteLength
	) {
		throw new Error("Terrain geometry contains an invalid or out-of-range binary descriptor.");
	}
}

function floatValues(bytes: ArrayBuffer, descriptor: ITerrainStreamingBinaryDescriptor): Float32Array {
	validateDescriptor(descriptor, bytes, Float32Array.BYTES_PER_ELEMENT);
	return new Float32Array(bytes, descriptor.offset, descriptor.count);
}

function integerValues(bytes: ArrayBuffer, descriptor: ITerrainStreamingBinaryDescriptor, multiplier = 1): Int32Array {
	validateDescriptor(descriptor, bytes, Int32Array.BYTES_PER_ELEMENT, multiplier);
	return new Int32Array(bytes, descriptor.offset, descriptor.count * multiplier);
}

function unpackBoneIndices(values: Int32Array): Float32Array {
	const result = new Float32Array(values.length * 4);
	for (let index = 0; index < values.length; index++) {
		const packed = values[index] >>> 0;
		result[index * 4] = packed & 0xff;
		result[index * 4 + 1] = (packed >>> 8) & 0xff;
		result[index * 4 + 2] = (packed >>> 16) & 0xff;
		result[index * 4 + 3] = (packed >>> 24) & 0xff;
	}
	return result;
}

function applyStream(mesh: Mesh, bytes: ArrayBuffer, descriptor: ITerrainStreamingBinaryDescriptor | undefined, kind: string, stride: number): void {
	if (descriptor) {
		mesh.setVerticesData(kind, floatValues(bytes, descriptor), false, stride);
	}
}

function applyRemoteGeometry(mesh: Mesh, bytes: ArrayBuffer, binaryInfo: ITerrainStreamingBinaryInfo): void {
	if (!binaryInfo.positionsAttrDesc || !binaryInfo.indicesAttrDesc) {
		throw new Error("Terrain geometry requires position and index descriptors.");
	}
	applyStream(mesh, bytes, binaryInfo.positionsAttrDesc, VertexBuffer.PositionKind, 3);
	applyStream(mesh, bytes, binaryInfo.normalsAttrDesc, VertexBuffer.NormalKind, 3);
	applyStream(mesh, bytes, binaryInfo.tangetsAttrDesc, VertexBuffer.TangentKind, binaryInfo.tangetsAttrDesc?.stride ?? 4);
	applyStream(mesh, bytes, binaryInfo.uvsAttrDesc, VertexBuffer.UVKind, 2);
	applyStream(mesh, bytes, binaryInfo.uvs2AttrDesc, VertexBuffer.UV2Kind, 2);
	applyStream(mesh, bytes, binaryInfo.colorsAttrDesc, VertexBuffer.ColorKind, binaryInfo.colorsAttrDesc?.stride ?? 4);
	applyStream(mesh, bytes, binaryInfo.matricesWeightsAttrDesc, VertexBuffer.MatricesWeightsKind, 4);
	applyStream(mesh, bytes, binaryInfo.matricesWeightsExtraAttrDesc, VertexBuffer.MatricesWeightsExtraKind, 4);
	if (binaryInfo.matricesIndicesAttrDesc) {
		mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, unpackBoneIndices(integerValues(bytes, binaryInfo.matricesIndicesAttrDesc)), false, 4);
	}
	if (binaryInfo.matricesIndicesExtraAttrDesc) {
		mesh.setVerticesData(VertexBuffer.MatricesIndicesExtraKind, unpackBoneIndices(integerValues(bytes, binaryInfo.matricesIndicesExtraAttrDesc)), false, 4);
	}
	mesh.setIndices(Array.from(integerValues(bytes, binaryInfo.indicesAttrDesc)));
	mesh.releaseSubMeshes(true);
	if (binaryInfo.subMeshesAttrDesc) {
		const subMeshes = integerValues(bytes, binaryInfo.subMeshesAttrDesc, 5);
		for (let index = 0; index < binaryInfo.subMeshesAttrDesc.count; index++) {
			const offset = index * 5;
			new SubMesh(subMeshes[offset], subMeshes[offset + 1], subMeshes[offset + 2], subMeshes[offset + 3], subMeshes[offset + 4], mesh, mesh, false, true);
		}
	} else {
		new SubMesh(0, 0, mesh.getTotalVertices(), 0, mesh.getTotalIndices(), mesh, mesh, false, true);
	}
	mesh.refreshBoundingInfo({ applySkeleton: false, applyMorph: false });
}

function releaseResidentGeometry(scene: Scene, terrain: Mesh): void {
	const snapshots = releasedGeometry.get(scene) ?? new Map<string, IReleasedGeometry>();
	if (snapshots.has(terrain.id)) {
		return;
	}
	const vertices = terrain.getVerticesDataKinds().map((kind) => ({
		kind,
		data: Array.from(terrain.getVerticesData(kind, false) ?? []),
		stride: terrain.getVertexBuffer(kind)?.getStrideSize() ?? 0,
	}));
	const indices = Array.from(terrain.getIndices(false) ?? []);
	if (!vertices.length || !indices.length || vertices.some((stream) => stream.stride < 1)) {
		return;
	}
	const subMeshes = terrain.subMeshes.map((subMesh) => ({
		materialIndex: subMesh.materialIndex,
		verticesStart: subMesh.verticesStart,
		verticesCount: subMesh.verticesCount,
		indexStart: subMesh.indexStart,
		indexCount: subMesh.indexCount,
	}));
	snapshots.set(terrain.id, { vertices, indices, subMeshes });
	releasedGeometry.set(scene, snapshots);
	terrain.geometry?.dispose();
}

function restoreResidentGeometry(scene: Scene, terrain: Mesh | null): void {
	if (!terrain) {
		return;
	}
	const snapshot = releasedGeometry.get(scene)?.get(terrain.id);
	if (!snapshot) {
		return;
	}
	snapshot.vertices.forEach(({ kind, data, stride }) => terrain.setVerticesData(kind, Float32Array.from(data), false, stride));
	terrain.setIndices(snapshot.indices);
	terrain.releaseSubMeshes(true);
	snapshot.subMeshes.forEach(
		(subMesh) => new SubMesh(subMesh.materialIndex, subMesh.verticesStart, subMesh.verticesCount, subMesh.indexStart, subMesh.indexCount, terrain, terrain, false, true)
	);
	releasedGeometry.get(scene)?.delete(terrain.id);
}

function resolveAssetUrl(rootUrl: string, group: ITerrainStreamingGroup, asset: ITerrainStreamingTileAsset): string {
	if (/^https?:\/\//i.test(asset.url)) {
		return asset.url;
	}
	const base = group.remoteBaseUrl ?? rootUrl;
	return `${base.replace(/\/$/, "")}/${asset.url.replace(/^\//, "")}`;
}

async function sha256(bytes: ArrayBuffer): Promise<string | null> {
	if (!globalThis.crypto?.subtle) {
		return null;
	}
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Owns bounded asynchronous terrain geometry fetch, validation, load, visibility, retry, hysteresis, and release state. */
export class TerrainStreamingRuntime {
	public readonly onTileStateChangedObservable = new Observable<ITerrainStreamingTileState>();

	private _observer: any;
	private _updatePromise: Promise<void> | null = null;
	private _disposed = false;
	private readonly _states = new Map<string, ITerrainStreamingTileRuntime>();
	private readonly _groupRoots = new Map<string, string>();
	private readonly _fetch: typeof fetch;
	private readonly _now: () => number;

	public constructor(
		private readonly _scene: Scene,
		private readonly _rootUrl: string,
		options?: ITerrainStreamingRuntimeOptions
	) {
		this._fetch = options?.fetch ?? globalThis.fetch.bind(globalThis);
		this._now = options?.now ?? (() => performance.now());
		this.registerGroups(_rootUrl);
		this._observer = _scene.onBeforeRenderObservable.add(() => void this.updateAsync());
	}

	public registerGroups(rootUrl: string): void {
		terrainGroups(this._scene).forEach((group) => {
			const key = this._groupKey(group);
			if (!this._groupRoots.has(key)) {
				this._groupRoots.set(key, rootUrl);
			}
		});
	}

	public getState(): { groups: ITerrainStreamingGroup[]; tiles: ITerrainStreamingTileState[] } {
		return {
			groups: cloneSerializable(terrainGroups(this._scene)),
			tiles: [...this._states.values()].map(({ nextRetryAt: _nextRetryAt, outsideSince: _outsideSince, ...state }) => ({ ...state })),
		};
	}

	public updateAsync(): Promise<void> {
		if (this._disposed) {
			return Promise.resolve();
		}
		this._updateResidentGroups();
		this._updatePromise ??= this._update().finally(() => (this._updatePromise = null));
		return this._updatePromise;
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._scene.onBeforeRenderObservable.remove(this._observer);
		this.onTileStateChangedObservable.clear();
		if (this._scene.terrainStreaming === this) {
			this._scene.terrainStreaming = undefined;
		}
	}

	private _state(group: ITerrainStreamingGroup, terrainId: string, asset?: ITerrainStreamingTileAsset): ITerrainStreamingTileRuntime {
		let state = this._states.get(terrainId);
		if (!state) {
			state = {
				terrainId,
				groupId: group.id ?? null,
				status: group.streamGeometry ? "unloaded" : "resident",
				url: asset ? resolveAssetUrl(this._groupRoot(group), group, asset) : null,
				distance: null,
				attempts: 0,
				bytesLoaded: 0,
				verified: false,
				lastLoadMs: null,
				error: null,
				nextRetryAt: 0,
				outsideSince: null,
			};
			this._states.set(terrainId, state);
		}
		return state;
	}

	private _publish(state: ITerrainStreamingTileRuntime): void {
		const { nextRetryAt: _nextRetryAt, outsideSince: _outsideSince, ...result } = state;
		this.onTileStateChangedObservable.notifyObservers({ ...result });
	}

	private _targetPosition(group: ITerrainStreamingGroup): Vector3 | null {
		const target = group.targetNodeId ? this._scene.getNodeById(group.targetNodeId) : this._scene.activeCamera;
		if (!(target as any)?.position) {
			return null;
		}
		(target as any).computeWorldMatrix?.(true);
		return ((target as any).getAbsolutePosition?.() ?? (target as any).position) as Vector3;
	}

	private _groupKey(group: ITerrainStreamingGroup): string {
		return group.id ?? group.name ?? group.terrainIds.join("\0");
	}

	private _groupRoot(group: ITerrainStreamingGroup): string {
		return this._groupRoots.get(this._groupKey(group)) ?? this._rootUrl;
	}

	private async _update(): Promise<void> {
		for (const group of terrainGroups(this._scene)) {
			const targetPosition = this._targetPosition(group);
			if (!targetPosition) {
				continue;
			}
			if (group.streamGeometry && group.tiles?.length) {
				await this._updateRemoteGroup(group, targetPosition);
			}
		}
	}

	private _updateResidentGroups(): void {
		for (const group of terrainGroups(this._scene)) {
			if (group.streamGeometry && group.tiles?.length) {
				continue;
			}
			const targetPosition = this._targetPosition(group);
			if (targetPosition) {
				this._updateResidentGroup(group, targetPosition);
			}
		}
	}

	private _updateResidentGroup(group: ITerrainStreamingGroup, targetPosition: Vector3): void {
		for (const terrainId of group.terrainIds) {
			const terrain = this._scene.getMeshById(terrainId) as unknown as Mesh | null;
			if (!terrain || typeof terrain.setVerticesData !== "function") {
				continue;
			}
			const state = this._state(group, terrainId);
			terrain.computeWorldMatrix(true);
			state.distance = Vector3.Distance(targetPosition, terrain.getAbsolutePosition());
			const enabled = !group.enabled || state.distance <= group.distance;
			if (enabled) {
				restoreResidentGeometry(this._scene, terrain);
			} else if (group.releaseGeometry) {
				releaseResidentGeometry(this._scene, terrain);
			}
			terrain.setEnabled(enabled);
			state.status = terrain.getTotalVertices() ? "resident" : "unloaded";
			this._publish(state);
		}
	}

	private async _updateRemoteGroup(group: ITerrainStreamingGroup, targetPosition: Vector3): Promise<void> {
		const assets = new Map(group.tiles?.map((asset) => [asset.terrainId, asset]) ?? []);
		const now = this._now();
		const preloadDistance = group.preloadDistance ?? group.distance;
		const unloadDistance = group.unloadDistance ?? preloadDistance;
		const unloadDelayMs = group.unloadDelayMs ?? 0;
		const candidates: Array<{ distance: number; terrain: Mesh; asset: ITerrainStreamingTileAsset; state: ITerrainStreamingTileRuntime }> = [];
		for (const terrainId of group.terrainIds) {
			const terrain = this._scene.getMeshById(terrainId) as unknown as Mesh | null;
			const asset = assets.get(terrainId);
			if (!terrain || typeof terrain.setVerticesData !== "function" || !asset) {
				continue;
			}
			terrain.computeWorldMatrix(true);
			const state = this._state(group, terrainId, asset);
			state.distance = Vector3.Distance(targetPosition, terrain.getAbsolutePosition());
			const shouldLoad = !group.enabled || state.distance <= preloadDistance;
			const shouldShow = !group.enabled || state.distance <= group.distance;
			if (shouldLoad) {
				state.outsideSince = null;
				if ((state.status === "unloaded" || state.status === "error") && state.nextRetryAt <= now) {
					state.status = "queued";
					candidates.push({ distance: state.distance, terrain, asset, state });
				}
			} else if (group.enabled && state.distance > unloadDistance && terrain.getTotalVertices() > 0) {
				state.outsideSince ??= now;
				if (now - state.outsideSince >= unloadDelayMs) {
					terrain.geometry?.dispose();
					state.status = "unloaded";
					state.bytesLoaded = 0;
					state.verified = false;
					this._publish(state);
				}
			}
			terrain.setEnabled(shouldShow && terrain.getTotalVertices() > 0);
		}
		const maximum = Math.max(1, Math.min(16, group.maxConcurrentLoads ?? 2));
		await Promise.all(
			candidates
				.sort((first, second) => first.distance - second.distance || first.terrain.id.localeCompare(second.terrain.id))
				.slice(0, maximum)
				.map((candidate) => this._load(group, candidate.terrain, candidate.asset, candidate.state))
		);
	}

	private async _load(group: ITerrainStreamingGroup, terrain: Mesh, asset: ITerrainStreamingTileAsset, state: ITerrainStreamingTileRuntime): Promise<void> {
		const started = this._now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(120_000, group.requestTimeoutMs ?? 15_000)));
		state.status = "loading";
		state.attempts++;
		state.error = null;
		this._publish(state);
		try {
			const response = await this._fetch(resolveAssetUrl(this._groupRoot(group), group, asset), { signal: controller.signal });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
			}
			const bytes = await response.arrayBuffer();
			if (bytes.byteLength !== asset.byteLength) {
				throw new Error(`Expected ${asset.byteLength} bytes, received ${bytes.byteLength}.`);
			}
			const hash = await sha256(bytes);
			if (hash && hash !== asset.sha256) {
				throw new Error("SHA-256 verification failed.");
			}
			applyRemoteGeometry(terrain, bytes, asset.binaryInfo);
			state.status = "loaded";
			state.bytesLoaded = bytes.byteLength;
			state.verified = hash === asset.sha256;
			state.lastLoadMs = this._now() - started;
			state.error = null;
			state.nextRetryAt = 0;
			terrain.setEnabled(!group.enabled || (state.distance ?? Number.POSITIVE_INFINITY) <= group.distance);
		} catch (error) {
			terrain.geometry?.dispose();
			state.status = "error";
			state.bytesLoaded = 0;
			state.verified = false;
			state.error = error instanceof Error ? error.message : String(error);
			const retryCount = Math.max(0, Math.min(8, group.retryCount ?? 2));
			state.nextRetryAt = state.attempts <= retryCount ? this._now() + Math.min(30_000, 250 * 2 ** (state.attempts - 1)) : Number.POSITIVE_INFINITY;
		} finally {
			clearTimeout(timeout);
			this._publish(state);
		}
	}
}

/** Converts exported streamed tiles into empty scene placeholders backed by hashed asynchronous geometry artifacts. */
export function configureTerrainStreamingExport(sceneData: any, artifacts: ITerrainStreamingExportArtifact[]): ITerrainStreamingExportEvidence {
	const sourceGroups = sceneData.metadata?.babylonEditorTerrainStreamingGroups as ITerrainStreamingGroup[] | undefined;
	const streamedGroups = sourceGroups?.filter((group) => group.streamGeometry) ?? [];
	if (!streamedGroups.length) {
		return { groupCount: 0, tileCount: 0, streamedBytes: 0, sharedArtifactCount: 0 };
	}
	const artifactByTerrain = new Map(artifacts.map((artifact) => [artifact.terrainId, artifact]));
	const clonedGroups = cloneSerializable(sourceGroups!);
	const urls = new Set<string>();
	let tileCount = 0;
	let streamedBytes = 0;
	for (const group of clonedGroups) {
		if (!group.streamGeometry) {
			continue;
		}
		group.version = 2;
		group.tiles = group.terrainIds.map((terrainId) => {
			const artifact = artifactByTerrain.get(terrainId);
			if (!artifact) {
				throw new Error(`Terrain streaming export is missing binary geometry for tile "${terrainId}".`);
			}
			const mesh = sceneData.meshes?.find((candidate: any) => candidate.id === terrainId);
			if (!mesh) {
				throw new Error(`Terrain streaming export cannot find tile Mesh "${terrainId}".`);
			}
			delete mesh.delayLoadingFile;
			delete mesh._binaryInfo;
			delete mesh.geometryId;
			mesh.metadata ??= {};
			mesh.metadata.babylonEditorTerrainStreamedPlaceholder = { version: 1, groupId: group.id ?? null, artifact: artifact.url };
			tileCount++;
			streamedBytes += artifact.byteLength;
			urls.add(artifact.url);
			return cloneSerializable(artifact);
		});
	}
	sceneData.metadata = { ...sceneData.metadata, babylonEditorTerrainStreamingGroups: clonedGroups };
	return { groupCount: streamedGroups.length, tileCount, streamedBytes, sharedArtifactCount: tileCount - urls.size };
}

/** Restores embedded culling or configures asynchronous hashed streamed geometry for exported terrain placeholders. */
export function configureTerrainStreaming(scene: Scene, rootUrl = "", options?: ITerrainStreamingRuntimeOptions): TerrainStreamingRuntime | null {
	if (!terrainGroups(scene).length) {
		return null;
	}
	if (scene.terrainStreaming) {
		scene.terrainStreaming.registerGroups(rootUrl);
		void scene.terrainStreaming.updateAsync();
		return scene.terrainStreaming;
	}
	const runtime = new TerrainStreamingRuntime(scene, rootUrl, options);
	scene.terrainStreaming = runtime;
	void runtime.updateAsync();
	return runtime;
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		terrainStreaming?: TerrainStreamingRuntime;
	}
}
