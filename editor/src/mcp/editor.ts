import { Engine, EngineInstrumentation, Scene, Tools } from "babylonjs";

import { getUndoRedoState, redo, undo } from "../tools/undoredo";

import { IMCPActionOptions } from "./action";

const engineInstrumentation = new WeakMap<Engine, EngineInstrumentation>();

function getEngineInstrumentation(engine: Engine): EngineInstrumentation {
	let instrumentation = engineInstrumentation.get(engine);
	if (!instrumentation) {
		instrumentation = new EngineInstrumentation(engine);
		instrumentation.captureGPUFrameTime = true;
		engineInstrumentation.set(engine, instrumentation);
	}
	return instrumentation;
}

/**
 * Gets the live editor state needed by MCP clients before they mutate a project.
 */
export function getEditorStatus(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const editor = options.editor;
	const play = editor.layout.preview.play;

	return {
		ready: Boolean(editor.layout?.preview?.scene),
		projectPath: editor.state.projectPath,
		activeScenePath: editor.state.lastOpenedScenePath,
		experimentalFeaturesEnabled: editor.state.enableExperimentalFeatures,
		play: {
			playing: play.state.playing,
			preparing: play.state.preparingPlay,
			loading: play.state.loading,
			canPlay: play.canPlayScene,
		},
		undoRedo: getUndoRedoState(),
		scene: {
			meshes: scene.meshes.length,
			lights: scene.lights.length,
			cameras: scene.cameras.length,
			materials: scene.materials.length,
			particleSystems: scene.particleSystems.length,
			animationGroups: scene.animationGroups.length,
		},
	};
}

/**
 * Gets the editor feature areas exposed by this version of the MCP bridge.
 */
export function getEditorCapabilities(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	return {
		projectOpen: Boolean(options.editor.state.projectPath),
		experimentalFeaturesEnabled: options.editor.state.enableExperimentalFeatures,
		features: {
			scene: true,
			nodes: true,
			meshes: true,
			lights: true,
			cameras: true,
			rendering: true,
			materials: true,
			assets: true,
			persistentAssetRegistry: true,
			assetRegistryDuplicateGuidRepair: true,
			persistentAssetDependencyGraph: true,
			assetDependencyDiagnostics: true,
			binaryModelAssetDependencyScanners: true,
			semanticAssetMovePlanning: true,
			assetMoveRollback: true,
			backgroundAssetIndexing: true,
			assetIndexingWorkerIsolates: true,
			cancellableAssetIndexing: true,
			assetTags: true,
			projectAssetFavorites: true,
			assetImportStateDiagnostics: true,
			typedAssetImporters: true,
			buildAwareAssetImporters: true,
			particles: true,
			sounds: true,
			animationGroups: true,
			animatorControllers: true,
			animatorRuntime: true,
			terrain: true,
			splines: true,
			virtualCameras: true,
			diagnostics: true,
			inputActions: true,
			inputActionsRuntime: true,
			audioMixer: true,
			buildProfiles: true,
			reflectionProbes: true,
			materialVariants: true,
			physicsConstraints: true,
			navAgents: true,
			navOffMeshLinks: true,
			navAgentPathFollowing: true,
			riggingIK: true,
			humanoidAvatars: true,
			humanoidAnimationRetargeting: true,
			humanoidMuscleLimits: true,
			humanoidAvatarMasks: true,
			clothPhysics: true,
			physics2D: true,
			proBuilderFaceExtrusion: true,
			proBuilderCSG: true,
			proBuilderBridge: true,
			proBuilderUVProjection: true,
			prefabVariants: true,
			prefabDynamicVariantRebase: true,
			prefabMode: true,
			prefabArbitraryPropertyOverrides: true,
			prefabStructuralOverrides: true,
			prefabComponentOverrides: true,
			prefabNestedAssets: true,
			prefabInstanceBoundaryLinks: true,
			prefabInstanceUnpack: true,
			prefabBoundaryOverridePromotion: true,
			prefabRootApplyRevert: true,
			prefabNestedApplyRevert: true,
			visualScripting: true,
			sceneTestRunner: true,
			addressablesCatalog: true,
			addressablesRuntime: true,
			localizationRuntime: true,
			behaviorTrees: true,
			projectPackages: true,
			sourceControlStatus: true,
			collaborationAssetLocks: true,
			semanticSceneDiff: true,
			semanticSceneMerge: true,
			semanticMergeRules: true,
			projectCollaborationRoles: true,
			projectCollaborationPresence: true,
			remoteCollaborationGateway: true,
			remoteCollaborationOperationStream: true,
			projectChangelists: true,
			scripts: true,
			marketplace: true,
			mcpAutomation: true,
			undoRedo: true,
			previewPlayMode: true,
			navMesh: true,
			ragdoll: true,
			sprites: true,
			gui: true,
			cinematic: true,
			projectPreferences: true,
			export: true,
			editorControls: true,
		},
	};
}

/**
 * Undoes the most recent editor operation when one is available.
 */
export function undoEditor(_scene: Scene, _data: any, _options: IMCPActionOptions): any {
	const previous = getUndoRedoState();
	if (previous.canUndo) {
		undo();
	}

	return {
		undone: previous.canUndo,
		undoRedo: getUndoRedoState(),
	};
}

/**
 * Redoes the next editor operation when one is available.
 */
export function redoEditor(_scene: Scene, _data: any, _options: IMCPActionOptions): any {
	const previous = getUndoRedoState();
	if (previous.canRedo) {
		redo();
	}

	return {
		redone: previous.canRedo,
		undoRedo: getUndoRedoState(),
	};
}

/**
 * Controls the editor preview play mode without starting an external development server.
 */
export async function setPreviewPlayMode(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const play = options.editor.layout.preview.play;

	switch (data.action) {
		case "play":
			if (!play.state.playing) {
				await play.play();
			}
			break;
		case "stop":
			if (play.state.playing) {
				play.stop();
			}
			break;
		case "restart":
			if (!play.state.playing) {
				throw new Error("Preview is not playing. Call set_preview_play_mode with action 'play' first.");
			}
			await play.restart();
			break;
		default:
			throw new Error(`Unsupported preview play action: ${data.action}`);
	}

	return {
		action: data.action,
		playing: play.state.playing,
		preparing: play.state.preparingPlay,
		loading: play.state.loading,
	};
}

/** Returns live renderer and scene metrics for profiling/debugging a preview. */
export function getSceneDiagnostics(scene: Scene): any {
	const engine = scene.getEngine();
	const gpuCounter = getEngineInstrumentation(engine as Engine).gpuFrameTimeCounter;
	return {
		frameRate: engine.getFps(),
		frameTimeMs: engine.getDeltaTime(),
		drawCalls: (engine as any)._drawCalls?.current ?? null,
		activeMeshes: scene.getActiveMeshes().length,
		totalVertices: scene.getTotalVertices(),
		meshes: scene.meshes.length,
		materials: scene.materials.length,
		textures: scene.textures.length,
		lights: scene.lights.length,
		cameras: scene.cameras.length,
		particleSystems: scene.particleSystems.length,
		gpuFrameTimeMs: gpuCounter ? gpuCounter.lastSecAverage * 0.000001 : null,
		gpuFrameTimeAverageMs: gpuCounter ? gpuCounter.average * 0.000001 : null,
	};
}

function deviceSimulation(scene: Scene): any {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorDeviceSimulation ??= { enabled: false, width: 1170, height: 2532, dpi: 460, orientation: "portrait", safeArea: [0, 0, 0, 0] });
}

/** Gets the persisted editor preview device simulator profile. */
export function getDeviceSimulation(scene: Scene): any {
	return structuredClone(deviceSimulation(scene));
}

/** Sets a persisted preview device profile and resizes the live Babylon engine view when enabled. */
export function setDeviceSimulation(scene: Scene, data: any, options: any): any {
	const current = deviceSimulation(scene);
	const next = {
		...current,
		...data,
		safeArea: data.safeArea ?? current.safeArea,
	};
	if (!Number.isInteger(next.width) || next.width < 160 || next.width > 16384 || !Number.isInteger(next.height) || next.height < 160 || next.height > 16384) {
		throw new Error("Device simulation width and height must be integers from 160 to 16384 pixels.");
	}
	if (!Number.isFinite(next.dpi) || next.dpi <= 0 || next.dpi > 2000) {
		throw new Error("Device simulation dpi must be greater than 0 and no more than 2000.");
	}
	if (!["portrait", "landscape"].includes(next.orientation)) {
		throw new Error("Device simulation orientation must be portrait or landscape.");
	}
	if (!Array.isArray(next.safeArea) || next.safeArea.length !== 4 || next.safeArea.some((value: any) => !Number.isFinite(value) || value < 0)) {
		throw new Error("safeArea must be [top, right, bottom, left] non-negative pixels.");
	}
	const [top, right, bottom, left] = next.safeArea;
	if (top + bottom >= next.height || left + right >= next.width) {
		throw new Error("safeArea must leave a positive visible area.");
	}
	Object.assign(current, next);
	const dimensions = next.orientation === "landscape" ? { width: next.height, height: next.width } : { width: next.width, height: next.height };
	options.editor?.layout?.preview?.setDeviceSimulation(next.enabled ? { ...dimensions, dpi: next.dpi, safeArea: next.safeArea } : null);
	options.editor?.layout?.inspector?.forceUpdate();
	return structuredClone(current);
}

function snapshots(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorProfilerSnapshots ??= []);
}

type IProfilerCaptureRuntime = { observer: any; elapsedMilliseconds: number };
const profilerCaptureRuntimes = new WeakMap<Scene, Map<string, IProfilerCaptureRuntime>>();

function captures(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorProfilerCaptures ??= []);
}

function captureRuntime(scene: Scene): Map<string, IProfilerCaptureRuntime> {
	let values = profilerCaptureRuntimes.get(scene);
	if (!values) {
		profilerCaptureRuntimes.set(scene, (values = new Map()));
	}
	return values;
}

function summarizeCapture(capture: any): any {
	const samples = capture.samples ?? [];
	const summary: any = {};
	for (const key of Object.keys(samples[0]?.metrics ?? {})) {
		const values = samples.map((sample: any) => sample.metrics[key]).filter((value: unknown) => typeof value === "number" && Number.isFinite(value));
		if (!values.length) {
			continue;
		}
		summary[key] = { min: Math.min(...values), max: Math.max(...values), average: values.reduce((total: number, value: number) => total + value, 0) / values.length };
	}
	return summary;
}

function describeCapture(capture: any, includeSamples = false): any {
	return {
		id: capture.id,
		name: capture.name,
		startedAt: capture.startedAt,
		stoppedAt: capture.stoppedAt ?? null,
		sampleIntervalMs: capture.sampleIntervalMs,
		maxSamples: capture.maxSamples,
		sampleCount: capture.samples.length,
		summary: summarizeCapture(capture),
		...(includeSamples ? { samples: structuredClone(capture.samples) } : {}),
	};
}

/** Lists bounded profiler captures and numeric summaries without returning every sample. */
export function listProfilerCaptures(scene: Scene): any {
	const active = captureRuntime(scene);
	return { captures: captures(scene).map((capture) => ({ ...describeCapture(capture), active: active.has(capture.id) })) };
}

/** Reads one profiler capture including its timestamped samples. */
export function getProfilerCapture(scene: Scene, data: any): any {
	const capture = captures(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!capture) {
		throw new Error("Profiler capture not found. Provide id (preferred) or name.");
	}
	return { ...describeCapture(capture, true), active: captureRuntime(scene).has(capture.id) };
}

/** Starts a bounded sampling capture of the preview renderer and scene metrics. */
export function startProfilerCapture(scene: Scene, data: any, options: any): any {
	if (!data.name?.trim()) {
		throw new Error("Profiler capture name is required.");
	}
	const sampleIntervalMs = data.sampleIntervalMs ?? 100;
	const maxSamples = data.maxSamples ?? 600;
	if (!Number.isInteger(sampleIntervalMs) || sampleIntervalMs < 1 || sampleIntervalMs > 10000) {
		throw new Error("sampleIntervalMs must be an integer from 1 to 10000.");
	}
	if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 36000) {
		throw new Error("maxSamples must be an integer from 1 to 36000.");
	}
	if (captures(scene).some((capture) => capture.name === data.name && !capture.stoppedAt)) {
		throw new Error(`Profiler capture "${data.name}" is already active.`);
	}
	const capture = { id: data.id ?? Tools.RandomId(), name: data.name, startedAt: new Date().toISOString(), sampleIntervalMs, maxSamples, samples: [] as any[] };
	captures(scene).push(capture);
	const runtime: IProfilerCaptureRuntime = { observer: null, elapsedMilliseconds: sampleIntervalMs };
	runtime.observer = scene.onBeforeRenderObservable.add(() => {
		runtime.elapsedMilliseconds += Math.max(0, scene.getEngine().getDeltaTime());
		if (runtime.elapsedMilliseconds < capture.sampleIntervalMs) {
			return;
		}
		runtime.elapsedMilliseconds %= capture.sampleIntervalMs;
		capture.samples.push({ capturedAt: new Date().toISOString(), metrics: getSceneDiagnostics(scene) });
		if (capture.samples.length >= capture.maxSamples) {
			stopProfilerCapture(scene, { id: capture.id }, options);
		}
	});
	captureRuntime(scene).set(capture.id, runtime);
	options.editor?.layout?.inspector?.forceUpdate();
	return { ...describeCapture(capture), active: true };
}

/** Stops an active profiler capture while retaining its collected samples and summary. */
export function stopProfilerCapture(scene: Scene, data: any, options: any): any {
	const capture = captures(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!capture) {
		throw new Error("Profiler capture not found. Provide id (preferred) or name.");
	}
	const runtime = captureRuntime(scene).get(capture.id);
	if (runtime) {
		scene.onBeforeRenderObservable.remove(runtime.observer);
	}
	captureRuntime(scene).delete(capture.id);
	capture.stoppedAt ??= new Date().toISOString();
	options?.editor?.layout?.inspector?.forceUpdate();
	return { ...describeCapture(capture), active: false };
}

/** Deletes an inactive profiler capture and its sampled metrics. */
export function deleteProfilerCapture(scene: Scene, data: any, options: any): any {
	const index = captures(scene).findIndex((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (index === -1) {
		throw new Error("Profiler capture not found. Provide id (preferred) or name.");
	}
	const capture = captures(scene)[index];
	if (captureRuntime(scene).has(capture.id)) {
		stopProfilerCapture(scene, { id: capture.id }, options);
	}
	captures(scene).splice(index, 1);
	options?.editor?.layout?.inspector?.forceUpdate();
	return { deleted: true, id: capture.id };
}
/** Lists persisted profiler snapshots. */
export function listProfilerSnapshots(scene: Scene): any {
	return { snapshots: structuredClone(snapshots(scene)) };
}
/** Captures the current renderer diagnostics under a reusable name. */
export function captureProfilerSnapshot(scene: Scene, data: any): any {
	const value = { id: data.id ?? `${Date.now()}`, name: data.name, capturedAt: new Date().toISOString(), metrics: getSceneDiagnostics(scene) };
	const index = snapshots(scene).findIndex((snapshot) => snapshot.name === value.name);
	if (index === -1) {
		snapshots(scene).push(value);
	} else {
		snapshots(scene)[index] = value;
	}
	return structuredClone(value);
}
/** Compares two persisted profiler snapshots metric-by-metric. */
export function compareProfilerSnapshots(scene: Scene, data: any): any {
	const find = (name: string) => snapshots(scene).find((snapshot) => snapshot.id === name || snapshot.name === name);
	const baseline = find(data.baseline),
		current = find(data.current);
	if (!baseline || !current) {
		throw new Error("Both profiler snapshots must exist.");
	}
	const delta: any = {};
	for (const key of Object.keys(current.metrics)) {
		if (typeof current.metrics[key] === "number" && typeof baseline.metrics[key] === "number") {
			delta[key] = current.metrics[key] - baseline.metrics[key];
		}
	}
	return { baseline: baseline.name, current: current.name, delta };
}
