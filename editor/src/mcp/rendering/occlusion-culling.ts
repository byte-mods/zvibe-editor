import { AbstractMesh, Camera, Color4, Mesh, MeshBuilder, Observable, Scene, Tools, Vector3 } from "babylonjs";
import type { Camera as CoreCamera } from "@babylonjs/core/Cameras/camera";
import type { AbstractMesh as CoreAbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene as CoreScene } from "@babylonjs/core/scene";
import {
	bakeOcclusionCulling,
	configureOcclusionCulling,
	createDefaultOcclusionCullingConfiguration,
	getOcclusionCullingCameraSettings,
	getOcclusionCullingConfiguration,
	getOcclusionCullingMeshSettings,
	inspectOcclusionCullingBake as inspectSharedOcclusionCullingBake,
	IOcclusionCullingArea,
	IOcclusionCullingBakePlan,
	IOcclusionCullingBakeProgress,
	IOcclusionCullingConfiguration,
	maximumOcclusionAreas,
	maximumOcclusionCells,
	maximumOcclusionMeshes,
	maximumOcclusionRayTests,
	maximumOcclusionRelationships,
	normalizeOcclusionCullingArea,
	normalizeOcclusionCullingCameraSettings,
	normalizeOcclusionCullingConfiguration,
	normalizeOcclusionCullingMeshSettings,
	normalizeOcclusionCullingSettings,
	occlusionCullingMetadataKey,
	occlusionCullingObjectMetadataKey,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

export type OcclusionCullingBakeJobStatus = "running" | "completed" | "cancelled" | "failed";

export interface IOcclusionCullingBakeJob {
	id: string;
	revision: number;
	status: OcclusionCullingBakeJobStatus;
	configurationRevision: number;
	sourceFingerprint: string;
	startedAt: string;
	completedAt: string | null;
	progress: IOcclusionCullingBakeProgress;
	cancelRequested: boolean;
	bakeFingerprint: string | null;
	error: string | null;
}

export interface IOcclusionCullingVisualizationState {
	enabled: boolean;
	showCells: boolean;
	showVisible: boolean;
	showOccluded: boolean;
	selectedCellId: string | null;
	lineCount: number;
}

interface IOcclusionCullingEditorState {
	changed: Observable<void>;
	job: IOcclusionCullingBakeJob | null;
	controller: AbortController | null;
	visualization: IOcclusionCullingVisualizationState;
	visualizationMesh: Mesh | null;
}

const states = new WeakMap<Scene, IOcclusionCullingEditorState>();

function portableScene(scene: Scene): CoreScene {
	return scene as unknown as CoreScene;
}

function portableMesh(mesh: AbstractMesh): CoreAbstractMesh {
	return mesh as unknown as CoreAbstractMesh;
}

function portableCamera(camera: Camera): CoreCamera {
	return camera as unknown as CoreCamera;
}

function state(scene: Scene): IOcclusionCullingEditorState {
	let value = states.get(scene);
	if (!value) {
		value = {
			changed: new Observable<void>(),
			job: null,
			controller: null,
			visualization: { enabled: false, showCells: true, showVisible: true, showOccluded: true, selectedCellId: null, lineCount: 0 },
			visualizationMesh: null,
		};
		states.set(scene, value);
		scene.onDisposeObservable.addOnce(() => {
			value!.controller?.abort();
			value!.visualizationMesh?.dispose();
			value!.changed.clear();
			states.delete(scene);
		});
	}
	return value;
}

function configuration(scene: Scene): IOcclusionCullingConfiguration {
	return getOcclusionCullingConfiguration(portableScene(scene)) ?? createDefaultOcclusionCullingConfiguration();
}

function ensureNoRunningBake(scene: Scene): void {
	const job = state(scene).job;
	if (job?.status === "running") {
		throw new Error(`Occlusion Culling bake job "${job.id}" is still running. Cancel it or wait before changing authoring state.`);
	}
}

function exactRevision(value: IOcclusionCullingConfiguration, expected: unknown): void {
	if (!Number.isSafeInteger(expected)) {
		throw new Error("Occlusion Culling mutation requires expectedRevision.");
	}
	if (value.revision !== expected) {
		throw new Error(`Occlusion Culling revision is stale: expected ${expected}, current ${value.revision}. Read the configuration again.`);
	}
}

function notify(scene: Scene, options?: IMCPActionOptions): void {
	configureOcclusionCulling(portableScene(scene));
	refreshOcclusionCullingVisualization(scene);
	state(scene).changed.notifyObservers();
	options?.editor.layout.inspector?.forceUpdate?.();
}

function commit(scene: Scene, value: IOcclusionCullingConfiguration, options?: IMCPActionOptions): IOcclusionCullingConfiguration {
	const normalized = normalizeOcclusionCullingConfiguration(value);
	scene.metadata ??= {};
	scene.metadata[occlusionCullingMetadataKey] = normalized;
	notify(scene, options);
	return structuredClone(normalized);
}

function meshById(scene: Scene, id: unknown): AbstractMesh {
	if (typeof id !== "string" || !id || id.length > 256) {
		throw new Error("meshId must be a non-empty string of at most 256 characters.");
	}
	const matches = scene.meshes.filter((mesh) => mesh.id === id);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `Mesh id "${id}" is ambiguous.` : `Mesh "${id}" was not found.`);
	}
	return matches[0];
}

function cameraById(scene: Scene, id: unknown): Camera {
	if (typeof id !== "string" || !id || id.length > 256) {
		throw new Error("cameraId must be a non-empty string of at most 256 characters.");
	}
	const matches = scene.cameras.filter((camera) => camera.id === id);
	if (matches.length !== 1) {
		throw new Error(matches.length ? `Camera id "${id}" is ambiguous.` : `Camera "${id}" was not found.`);
	}
	return matches[0];
}

function areaById(value: IOcclusionCullingConfiguration, id: unknown): IOcclusionCullingArea {
	if (typeof id !== "string" || !id || id.length > 128) {
		throw new Error("areaId must be a non-empty string of at most 128 characters.");
	}
	const result = value.areas.find((area) => area.id === id);
	if (!result) {
		throw new Error(`Occlusion Area "${id}" was not found.`);
	}
	return result;
}

function exactObjectRevision(label: string, current: number, expected: unknown): void {
	if (!Number.isSafeInteger(expected)) {
		throw new Error(`${label} mutation requires expectedObjectRevision.`);
	}
	if (current !== expected) {
		throw new Error(`${label} revision is stale: expected ${expected}, current ${current}. Read Occlusion Culling again.`);
	}
}

function finiteVector(value: unknown, label: string, positive = false): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || value.some((component) => !Number.isFinite(component))) {
		throw new Error(`${label} must contain exactly three finite numbers.`);
	}
	const result = value.map(Number) as [number, number, number];
	if (result.some((component) => component < (positive ? 0.001 : -1_000_000_000) || component > 1_000_000_000)) {
		throw new Error(`${label} components must be ${positive ? "from 0.001" : "from -1000000000"} through 1000000000.`);
	}
	return result;
}

function name(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128) {
		throw new Error(`${label} must contain 1 through 128 characters.`);
	}
	return value.trim();
}

function page(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(result) || Number(result) < minimum || Number(result) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return Number(result);
}

function patchConfigurationRevision(value: IOcclusionCullingConfiguration, affectsBake: boolean): void {
	value.revision++;
	if (affectsBake) {
		value.bakeRevision++;
	}
}

function copyJob(job: IOcclusionCullingBakeJob | null): IOcclusionCullingBakeJob | null {
	return job ? structuredClone(job) : null;
}

function lineBox(minimum: readonly number[], maximum: readonly number[]): Vector3[][] {
	const min = Vector3.FromArray(minimum);
	const max = Vector3.FromArray(maximum);
	const points = [
		new Vector3(min.x, min.y, min.z),
		new Vector3(max.x, min.y, min.z),
		new Vector3(max.x, max.y, min.z),
		new Vector3(min.x, max.y, min.z),
		new Vector3(min.x, min.y, max.z),
		new Vector3(max.x, min.y, max.z),
		new Vector3(max.x, max.y, max.z),
		new Vector3(min.x, max.y, max.z),
	];
	const edges = [
		[0, 1],
		[1, 2],
		[2, 3],
		[3, 0],
		[4, 5],
		[5, 6],
		[6, 7],
		[7, 4],
		[0, 4],
		[1, 5],
		[2, 6],
		[3, 7],
	];
	return edges.map(([first, second]) => [points[first], points[second]]);
}

function addBox(lines: Vector3[][], colors: Color4[][], minimum: readonly number[], maximum: readonly number[], color: Color4): void {
	const box = lineBox(minimum, maximum);
	lines.push(...box);
	colors.push(...box.map(() => [color, color]));
}

/** Rebuilds the transient scene visualization from the exact persisted bake and current selection. */
export function refreshOcclusionCullingVisualization(scene: Scene): IOcclusionCullingVisualizationState {
	const editorState = state(scene);
	editorState.visualizationMesh?.dispose();
	editorState.visualizationMesh = null;
	editorState.visualization.lineCount = 0;
	if (!editorState.visualization.enabled) {
		return structuredClone(editorState.visualization);
	}
	const value = configuration(scene);
	const bake = value.bake;
	if (!bake) {
		return structuredClone(editorState.visualization);
	}
	const lines: Vector3[][] = [];
	const colors: Color4[][] = [];
	const selected = bake.cells.find((cell) => cell.id === editorState.visualization.selectedCellId) ?? null;
	if (editorState.visualization.showCells) {
		for (const cell of bake.cells.slice(0, maximumOcclusionCells)) {
			const color = cell.id === selected?.id ? new Color4(0.1, 0.9, 1, 1) : cell.valid ? new Color4(0.2, 0.65, 1, 0.75) : new Color4(1, 0.2, 0.2, 0.9);
			addBox(lines, colors, cell.minimum, cell.maximum, color);
		}
	}
	if (selected) {
		const visible = new Set(selected.visibleMeshIds);
		const occluded = new Set(selected.occludedMeshIds);
		for (const source of bake.sources.slice(0, maximumOcclusionMeshes)) {
			if ((visible.has(source.id) && editorState.visualization.showVisible) || (occluded.has(source.id) && editorState.visualization.showOccluded)) {
				addBox(lines, colors, source.minimum, source.maximum, visible.has(source.id) ? new Color4(0.2, 1, 0.35, 1) : new Color4(1, 0.25, 0.2, 1));
			}
		}
	}
	if (lines.length) {
		const mesh = MeshBuilder.CreateLineSystem("Occlusion Culling Visualization", { lines, colors, updatable: false }, scene);
		mesh.isPickable = false;
		mesh.doNotSerialize = true;
		mesh.alwaysSelectAsActiveMesh = true;
		mesh.metadata = { doNotSerialize: true, isVisibleInGraph: false, babylonEditorOcclusionCullingVisualization: true };
		editorState.visualizationMesh = mesh;
		editorState.visualization.lineCount = lines.length;
	}
	return structuredClone(editorState.visualization);
}

/** Lets the permanent workspace observe the same persisted/job state used by MCP. */
export function getOcclusionCullingChangedObservable(scene: Scene): Observable<void> {
	return state(scene).changed;
}

/** Reports the portable Unity-facing authoring, bake, runtime, and safety boundaries. */
export function getOcclusionCullingCapabilities(_scene: Scene): any {
	return {
		version: 1,
		model: "bounded-static-pvs-ray-bake-v1",
		features: {
			staticOccluders: true,
			staticOccludees: true,
			dynamicOccludees: true,
			cameraToggle: true,
			occlusionAreas: true,
			viewVolumes: true,
			smallestOccluder: true,
			smallestHole: true,
			backfaceThreshold: true,
			conservativeRayBake: true,
			bakedPotentiallyVisibleSets: true,
			cellVisualization: true,
			perCameraRuntimeEvidence: true,
			fullAndAdditiveRuntime: true,
			babylonHardwareQueries: true,
		},
		limits: {
			maximumAreas: maximumOcclusionAreas,
			maximumCells: maximumOcclusionCells,
			maximumMeshes: maximumOcclusionMeshes,
			maximumRayTests: maximumOcclusionRayTests,
			maximumRelationships: maximumOcclusionRelationships,
		},
		boundaries: [
			"Baked static PVS is separate from Babylon frustum selection and native hardware queries.",
			"Only enabled opaque triangle meshes at or above Smallest Occluder contribute as occluders.",
			"Dynamic objects are hardware-query occludees and never contribute static bake occlusion.",
			"This portable implementation does not claim Unity/Umbra binary or numerical identity.",
		],
	};
}

/** Reads a bounded page of complete authoring, bake, runtime, job, and visualization state. */
export function getOcclusionCulling(scene: Scene, data: any = {}): any {
	const value = configuration(scene);
	const offset = page(data.offset, 0, 0, 1_000_000, "offset");
	const limit = page(data.limit, 100, 1, 500, "limit");
	const cameraOffset = page(data.cameraOffset, 0, 0, 1_000_000, "cameraOffset");
	const cameraLimit = page(data.cameraLimit, 100, 1, 500, "cameraLimit");
	const meshes = scene.meshes.slice(offset, offset + limit).map((mesh) => ({
		id: mesh.id,
		name: mesh.name,
		className: mesh.getClassName(),
		settings: getOcclusionCullingMeshSettings(portableMesh(mesh)),
	}));
	const cameras = scene.cameras.slice(cameraOffset, cameraOffset + cameraLimit).map((camera) => ({
		id: camera.id,
		name: camera.name,
		className: camera.getClassName(),
		settings: getOcclusionCullingCameraSettings(portableCamera(camera)),
	}));
	return {
		version: 1,
		authored: Boolean(scene.metadata?.[occlusionCullingMetadataKey]),
		configuration: structuredClone(value),
		bakeStatus: value.bake
			? {
					present: true,
					stale: value.bake.configurationBakeRevision !== value.bakeRevision,
					configurationBakeRevision: value.bake.configurationBakeRevision,
					currentBakeRevision: value.bakeRevision,
					fingerprint: value.bake.bakeFingerprint,
				}
			: { present: false, stale: false, configurationBakeRevision: null, currentBakeRevision: value.bakeRevision, fingerprint: null },
		meshes: { total: scene.meshes.length, offset, limit, items: meshes },
		cameras: { total: scene.cameras.length, offset: cameraOffset, limit: cameraLimit, items: cameras },
		job: copyJob(state(scene).job),
		visualization: structuredClone(state(scene).visualization),
		runtime: configureOcclusionCulling(portableScene(scene))?.getState() ?? {
			configured: false,
			configurationCount: 0,
			hardwareQueriesSupported: Boolean(scene.getEngine().getCaps().supportOcclusionQuery),
			dynamicQueryMeshIds: [],
			cameras: [],
			errors: [],
		},
	};
}

/** Exact-revision patches global enablement and Unity/portable bake settings. */
export function setOcclusionCullingSettings(scene: Scene, data: any, options: IMCPActionOptions): IOcclusionCullingConfiguration {
	ensureNoRunningBake(scene);
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	const next = structuredClone(current);
	if (data.enabled !== undefined) {
		if (typeof data.enabled !== "boolean") {
			throw new Error("enabled must be a Boolean.");
		}
		next.enabled = data.enabled;
	}
	let affectsBake = false;
	if (data.settings !== undefined) {
		next.settings = normalizeOcclusionCullingSettings({ ...next.settings, ...data.settings });
		affectsBake = JSON.stringify(next.settings) !== JSON.stringify(current.settings);
	}
	if (data.enabled === undefined && data.settings === undefined) {
		throw new Error("Set Occlusion Culling settings requires enabled and/or a non-empty settings patch.");
	}
	patchConfigurationRevision(next, affectsBake);
	return commit(scene, next, options);
}

/** Exact-revision replaces one mesh's static and dynamic occlusion authoring. */
export function setOcclusionCullingMesh(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureNoRunningBake(scene);
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	const mesh = meshById(scene, data.meshId);
	const previous = getOcclusionCullingMeshSettings(portableMesh(mesh));
	exactObjectRevision(`Mesh "${mesh.name}" Occlusion Culling`, previous.revision, data.expectedObjectRevision);
	const nextSettings = normalizeOcclusionCullingMeshSettings({
		...previous,
		...data.settings,
		version: 1,
		revision: previous.revision + 1,
	});
	const affectsBake = nextSettings.staticOccluder !== previous.staticOccluder || nextSettings.staticOccludee !== previous.staticOccludee;
	const next = structuredClone(current);
	patchConfigurationRevision(next, affectsBake);
	mesh.metadata ??= {};
	mesh.metadata[occlusionCullingObjectMetadataKey] = nextSettings;
	commit(scene, next, options);
	options.editor.layout.inspector?.setEditedObject?.(mesh);
	return { configurationRevision: next.revision, bakeRevision: next.bakeRevision, mesh: { id: mesh.id, name: mesh.name, settings: structuredClone(nextSettings) } };
}

/** Exact-revision toggles baked culling on one authored or editor camera. */
export function setCameraOcclusionCulling(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureNoRunningBake(scene);
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	const camera = cameraById(scene, data.cameraId);
	const previous = getOcclusionCullingCameraSettings(portableCamera(camera));
	exactObjectRevision(`Camera "${camera.name}" Occlusion Culling`, previous.revision, data.expectedObjectRevision);
	const nextSettings = normalizeOcclusionCullingCameraSettings({ version: 1, revision: previous.revision + 1, enabled: data.enabled });
	const next = structuredClone(current);
	patchConfigurationRevision(next, false);
	camera.metadata ??= {};
	camera.metadata[occlusionCullingObjectMetadataKey] = nextSettings;
	commit(scene, next, options);
	options.editor.layout.inspector?.setEditedObject?.(camera);
	return { configurationRevision: next.revision, bakeRevision: next.bakeRevision, camera: { id: camera.id, name: camera.name, settings: structuredClone(nextSettings) } };
}

/** Creates one exact-revision Occlusion Area or View Volume. */
export function createOcclusionCullingArea(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureNoRunningBake(scene);
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	if (current.areas.length >= maximumOcclusionAreas) {
		throw new Error(`Occlusion Culling supports at most ${maximumOcclusionAreas} areas.`);
	}
	const area = normalizeOcclusionCullingArea({
		version: 1,
		revision: 1,
		id:
			data.id ??
			`occlusion-area-${Tools.RandomId()
				.replace(/[^A-Za-z0-9_-]/g, "")
				.slice(0, 64)}`,
		name: name(data.name, "Occlusion Area name"),
		center: finiteVector(data.center, "Occlusion Area center"),
		size: finiteVector(data.size, "Occlusion Area size", true),
		isViewVolume: data.isViewVolume ?? true,
		enabled: data.enabled ?? true,
	});
	if (current.areas.some((candidate) => candidate.id === area.id || candidate.name === area.name)) {
		throw new Error(`Occlusion Area id or name "${area.id}"/"${area.name}" already exists.`);
	}
	const next = structuredClone(current);
	next.areas.push(area);
	patchConfigurationRevision(next, true);
	commit(scene, next, options);
	return { configurationRevision: next.revision, bakeRevision: next.bakeRevision, area: structuredClone(area) };
}

/** Exact-revision patches one Occlusion Area/View Volume. */
export function updateOcclusionCullingArea(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureNoRunningBake(scene);
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	const existing = areaById(current, data.areaId);
	exactObjectRevision(`Occlusion Area "${existing.name}"`, existing.revision, data.expectedObjectRevision);
	const replacement = normalizeOcclusionCullingArea({
		...existing,
		...data.patch,
		version: 1,
		revision: existing.revision + 1,
		id: existing.id,
		name: data.patch?.name === undefined ? existing.name : name(data.patch.name, "Occlusion Area name"),
		center: data.patch?.center === undefined ? existing.center : finiteVector(data.patch.center, "Occlusion Area center"),
		size: data.patch?.size === undefined ? existing.size : finiteVector(data.patch.size, "Occlusion Area size", true),
	});
	if (current.areas.some((candidate) => candidate.id !== existing.id && candidate.name === replacement.name)) {
		throw new Error(`Occlusion Area name "${replacement.name}" already exists.`);
	}
	const next = structuredClone(current);
	next.areas[next.areas.findIndex((area) => area.id === existing.id)] = replacement;
	patchConfigurationRevision(next, true);
	commit(scene, next, options);
	return { configurationRevision: next.revision, bakeRevision: next.bakeRevision, area: structuredClone(replacement) };
}

/** Confirmation-gated exact-revision deletion of one Occlusion Area/View Volume. */
export function deleteOcclusionCullingArea(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureNoRunningBake(scene);
	if (data.confirm !== true) {
		throw new Error("Deleting an Occlusion Area requires confirm=true.");
	}
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	const existing = areaById(current, data.areaId);
	exactObjectRevision(`Occlusion Area "${existing.name}"`, existing.revision, data.expectedObjectRevision);
	const next = structuredClone(current);
	next.areas = next.areas.filter((area) => area.id !== existing.id);
	patchConfigurationRevision(next, true);
	commit(scene, next, options);
	return { deleted: true, id: existing.id, name: existing.name, configurationRevision: next.revision, bakeRevision: next.bakeRevision };
}

/** Produces the exact non-mutating cell/work/source plan required to lease a bake. */
export async function inspectOcclusionCullingBake(scene: Scene, data: any = {}): Promise<IOcclusionCullingBakePlan> {
	const current = configuration(scene);
	if (data.expectedRevision !== undefined) {
		exactRevision(current, data.expectedRevision);
	}
	return inspectSharedOcclusionCullingBake(portableScene(scene), current);
}

/** Runs and atomically publishes one exact-fingerprint bake; cancellation never publishes partial cells. */
export async function bakeOcclusionCullingAction(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	ensureNoRunningBake(scene);
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	const plan = await inspectSharedOcclusionCullingBake(portableScene(scene), current);
	if (data.expectedSourceFingerprint !== plan.sourceFingerprint) {
		throw new Error(`Occlusion Culling source fingerprint is stale: expected ${data.expectedSourceFingerprint}, current ${plan.sourceFingerprint}. Inspect the bake again.`);
	}
	const editorState = state(scene);
	const controller = new AbortController();
	editorState.controller = controller;
	editorState.job = {
		id: `occlusion-bake-${Tools.RandomId()
			.replace(/[^A-Za-z0-9_-]/g, "")
			.slice(0, 64)}`,
		revision: 1,
		status: "running",
		configurationRevision: current.revision,
		sourceFingerprint: plan.sourceFingerprint,
		startedAt: new Date().toISOString(),
		completedAt: null,
		progress: { phase: "planning", completedCells: 0, totalCells: plan.cells.length, rayTests: 0, message: "Starting exact Occlusion Culling bake." },
		cancelRequested: false,
		bakeFingerprint: null,
		error: null,
	};
	editorState.changed.notifyObservers();
	try {
		const bake = await bakeOcclusionCulling(portableScene(scene), current, {
			signal: controller.signal,
			onProgress: (progress) => {
				if (editorState.job?.status === "running") {
					editorState.job.progress = structuredClone(progress);
					// Progress is observational and must not invalidate the exact control lease used to cancel this same running job.
					editorState.changed.notifyObservers();
				}
			},
		});
		const latest = configuration(scene);
		if (latest.revision !== current.revision || latest.bakeRevision !== current.bakeRevision) {
			throw new Error(
				`Occlusion Culling authoring changed during bake; expected revision ${current.revision}/${current.bakeRevision}, current ${latest.revision}/${latest.bakeRevision}.`
			);
		}
		const reinspection = await inspectSharedOcclusionCullingBake(portableScene(scene), latest);
		if (reinspection.sourceFingerprint !== plan.sourceFingerprint) {
			throw new Error("Occlusion Culling sources changed during bake; partial output was discarded.");
		}
		const next = structuredClone(latest);
		next.bake = bake;
		patchConfigurationRevision(next, false);
		commit(scene, next, options);
		editorState.job!.status = "completed";
		editorState.job!.completedAt = new Date().toISOString();
		editorState.job!.bakeFingerprint = bake.bakeFingerprint;
		editorState.job!.revision++;
		editorState.job!.progress = {
			phase: "fingerprinting",
			completedCells: bake.statistics.cellCount,
			totalCells: bake.statistics.cellCount,
			rayTests: bake.statistics.rayTests,
			message: "Occlusion Culling bake published atomically.",
		};
		editorState.changed.notifyObservers();
		return { job: copyJob(editorState.job), configurationRevision: next.revision, bake: structuredClone(bake) };
	} catch (error) {
		const cancelled = controller.signal.aborted;
		if (editorState.job) {
			editorState.job.status = cancelled ? "cancelled" : "failed";
			editorState.job.completedAt = new Date().toISOString();
			editorState.job.error = error instanceof Error ? error.message : String(error);
			editorState.job.revision++;
			editorState.changed.notifyObservers();
		}
		throw error;
	} finally {
		if (editorState.controller === controller) {
			editorState.controller = null;
		}
	}
}

/** Requests exact-job cancellation; the running baker checks between bounded cells and never publishes partial output. */
export function cancelOcclusionCullingBake(scene: Scene, data: any): any {
	const editorState = state(scene);
	const job = editorState.job;
	if (!job || job.status !== "running" || !editorState.controller) {
		throw new Error("No Occlusion Culling bake is currently running.");
	}
	if (data.id !== job.id) {
		throw new Error(`Occlusion Culling bake job "${data.id}" was not found.`);
	}
	if (data.expectedJobRevision !== job.revision) {
		throw new Error(`Occlusion Culling bake job revision is stale: expected ${data.expectedJobRevision}, current ${job.revision}.`);
	}
	job.cancelRequested = true;
	job.revision++;
	editorState.controller.abort();
	editorState.changed.notifyObservers();
	return copyJob(job);
}

/** Confirmation-gated exact-fingerprint deletion of persisted bake cells without removing authoring. */
export function clearOcclusionCullingBake(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureNoRunningBake(scene);
	if (data.confirm !== true) {
		throw new Error("Clearing Occlusion Culling bake data requires confirm=true.");
	}
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	if (!current.bake) {
		return { cleared: false, configurationRevision: current.revision, bakeRevision: current.bakeRevision };
	}
	if (data.expectedBakeFingerprint !== current.bake.bakeFingerprint) {
		throw new Error(`Occlusion Culling bake fingerprint is stale: expected ${data.expectedBakeFingerprint}, current ${current.bake.bakeFingerprint}.`);
	}
	const fingerprint = current.bake.bakeFingerprint;
	const next = structuredClone(current);
	delete next.bake;
	patchConfigurationRevision(next, false);
	commit(scene, next, options);
	return { cleared: true, bakeFingerprint: fingerprint, configurationRevision: next.revision, bakeRevision: next.bakeRevision };
}

/** Reads exact per-camera baked/hardware runtime evidence without changing persisted authoring. */
export function getOcclusionCullingRuntime(scene: Scene): any {
	return (
		configureOcclusionCulling(portableScene(scene))?.getState() ?? {
			configured: false,
			configurationCount: 0,
			hardwareQueriesSupported: Boolean(scene.getEngine().getCaps().supportOcclusionQuery),
			dynamicQueryMeshIds: [],
			cameras: [],
			errors: [],
		}
	);
}

/** Sets transient cell/PVS visualization; this never changes saved scene data or bake fingerprints. */
export function setOcclusionCullingVisualization(scene: Scene, data: any): IOcclusionCullingVisualizationState {
	const editorState = state(scene);
	const bake = configuration(scene).bake;
	if (data.selectedCellId !== undefined && data.selectedCellId !== null && !bake?.cells.some((cell) => cell.id === data.selectedCellId)) {
		throw new Error(`Occlusion Culling cell "${data.selectedCellId}" was not found in the current bake.`);
	}
	for (const key of ["enabled", "showCells", "showVisible", "showOccluded"] as const) {
		if (data[key] !== undefined) {
			if (typeof data[key] !== "boolean") {
				throw new Error(`${key} must be a Boolean.`);
			}
			(editorState.visualization as any)[key] = data[key];
		}
	}
	if (data.selectedCellId !== undefined) {
		editorState.visualization.selectedCellId = data.selectedCellId;
	}
	const result = refreshOcclusionCullingVisualization(scene);
	editorState.changed.notifyObservers();
	return result;
}

/** Confirmation-gated complete authoring/runtime reset with exact visibility/query restoration. */
export function resetOcclusionCulling(scene: Scene, data: any, options: IMCPActionOptions): any {
	ensureNoRunningBake(scene);
	if (data.confirm !== true) {
		throw new Error("Resetting Occlusion Culling requires confirm=true.");
	}
	const current = configuration(scene);
	exactRevision(current, data.expectedRevision);
	let meshes = 0;
	let cameras = 0;
	for (const mesh of scene.meshes) {
		if (mesh.metadata?.[occlusionCullingObjectMetadataKey] !== undefined) {
			delete mesh.metadata[occlusionCullingObjectMetadataKey];
			meshes++;
		}
	}
	for (const camera of scene.cameras) {
		if (camera.metadata?.[occlusionCullingObjectMetadataKey] !== undefined) {
			delete camera.metadata[occlusionCullingObjectMetadataKey];
			cameras++;
		}
	}
	if (scene.metadata) {
		delete scene.metadata[occlusionCullingMetadataKey];
	}
	const editorState = state(scene);
	editorState.visualizationMesh?.dispose();
	editorState.visualizationMesh = null;
	editorState.visualization = { enabled: false, showCells: true, showVisible: true, showOccluded: true, selectedCellId: null, lineCount: 0 };
	editorState.job = null;
	portableScene(scene).occlusionCulling?.dispose();
	editorState.changed.notifyObservers();
	options.editor.layout.inspector?.forceUpdate?.();
	return { reset: true, removedMeshSettings: meshes, removedCameraSettings: cameras, removedBake: Boolean(current.bake) };
}
