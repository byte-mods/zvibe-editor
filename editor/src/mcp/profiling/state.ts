import { Scene } from "babylonjs";
import {
	createPortableProfilerState,
	IPortableProfilerCapture,
	IPortableProfilerFrame,
	IPortableProfilerMemorySnapshot,
	IPortableProfilerState,
	normalizePortableProfilerState,
	PORTABLE_PROFILER_VERSION,
	summarizePortableProfilerCapture,
} from "babylonjs-editor-tools";

const metadataKey = "babylonEditorProfilerState";
const stateCache = new WeakMap<Scene, IPortableProfilerState>();

function immutableProfilerState(state: IPortableProfilerState): IPortableProfilerState {
	const pending: object[] = [state];
	const visited = new WeakSet<object>();
	while (pending.length) {
		const value = pending.pop()!;
		if (visited.has(value)) {
			continue;
		}
		visited.add(value);
		for (const child of Object.values(value)) {
			if (child && typeof child === "object") {
				pending.push(child);
			}
		}
		Object.freeze(value);
	}
	return state;
}

function legacyFrame(sample: any, index: number, interval: number): IPortableProfilerFrame {
	const metrics = sample?.metrics ?? {};
	const finite = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
	const nullable = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
	return {
		index,
		capturedAt: typeof sample?.capturedAt === "string" ? sample.capturedAt : new Date().toISOString(),
		elapsedMs: index * interval,
		cpu: {
			frameTimeMs: finite(metrics.frameTimeMs),
			interFrameTimeMs: null,
			renderTimeMs: null,
			activeMeshesEvaluationTimeMs: null,
			renderTargetsTimeMs: null,
			animationsTimeMs: null,
			physicsTimeMs: null,
			particlesTimeMs: null,
			spritesTimeMs: null,
			cameraRenderTimeMs: null,
			scriptTimeMs: 0,
			scriptCalls: 0,
			scriptErrors: 0,
		},
		gpuFrameTimeMs: nullable(metrics.gpuFrameTimeMs),
		rendering: {
			drawCalls: finite(metrics.drawCalls),
			batches: finite(metrics.drawCalls),
			setPassCalls: null,
			activeMeshes: finite(metrics.activeMeshes),
			vertices: finite(metrics.totalVertices),
			indices: 0,
			triangles: 0,
			materials: finite(metrics.materials),
			textures: finite(metrics.textures),
			lights: finite(metrics.lights),
			cameras: finite(metrics.cameras),
			particleSystems: finite(metrics.particleSystems),
			shaderCompilationTimeMs: null,
		},
		memory: null,
		assets: null,
		audio: null,
		twoD: null,
	};
}

function migrateLegacyCapture(value: any): IPortableProfilerCapture | null {
	if (!value || typeof value.id !== "string" || typeof value.name !== "string") {
		return null;
	}
	const interval = Number.isSafeInteger(value.sampleIntervalMs) ? value.sampleIntervalMs : 100;
	const frames = Array.isArray(value.samples) ? value.samples.slice(0, 36_000).map((sample: any, index: number) => legacyFrame(sample, index, interval)) : [];
	const capture: IPortableProfilerCapture = {
		version: PORTABLE_PROFILER_VERSION,
		id: value.id,
		name: value.name,
		target: "editor-edit",
		status: "completed",
		startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date().toISOString(),
		finishedAt: typeof value.stoppedAt === "string" ? value.stoppedAt : new Date().toISOString(),
		failure: null,
		modules: ["cpu", "gpu", "rendering"],
		sampleEveryFrames: 1,
		maximumFrames: Number.isSafeInteger(value.maxSamples) ? value.maxSamples : Math.max(1, frames.length),
		maximumDurationMs: Math.max(100, interval * Math.max(1, frames.length)),
		availability: {
			cpu: { available: true, precision: "engine-counter", reason: "Migrated from a legacy flat diagnostic capture." },
			gpu: { available: true, precision: "engine-counter", reason: "Migrated from a legacy flat diagnostic capture." },
			rendering: { available: true, precision: "engine-counter", reason: "Migrated from a legacy flat diagnostic capture." },
			memory: { available: false, precision: "unavailable", reason: "The legacy capture did not record memory." },
			assets: { available: false, precision: "unavailable", reason: "The legacy capture did not record asset loading." },
			scripts: { available: false, precision: "unavailable", reason: "The legacy capture did not record script markers." },
			physics: { available: false, precision: "unavailable", reason: "The legacy capture did not record physics timing." },
			audio: { available: false, precision: "unavailable", reason: "The legacy capture did not record audio counters." },
			"2d": { available: false, precision: "unavailable", reason: "The legacy capture did not record 2D atlas counters." },
		},
		frames,
		markers: [],
		assetEvents: [],
		memorySnapshots: [],
		summary: { frames: 0, durationMs: 0, metrics: {}, markers: [], assetRequests: 0, assetTransferBytes: null },
		limitations: ["This capture was migrated from the pre-v1 flat profiler and contains only the metrics originally sampled."],
	};
	capture.summary = summarizePortableProfilerCapture(capture);
	return capture;
}

function migrateLegacySnapshot(value: any): IPortableProfilerMemorySnapshot | null {
	if (!value || typeof value.id !== "string" || typeof value.name !== "string") {
		return null;
	}
	const metrics = value.metrics ?? {};
	return {
		id: value.id,
		name: value.name,
		capturedAt: typeof value.capturedAt === "string" ? value.capturedAt : new Date().toISOString(),
		captureId: null,
		frameIndex: null,
		metrics: {
			usedHeapBytes: null,
			totalHeapBytes: null,
			heapLimitBytes: null,
			estimatedGeometryBytes: 0,
			estimatedTextureBytes: 0,
			estimatedSceneBytes: 0,
			sceneObjectCount: ["meshes", "materials", "textures", "lights", "cameras", "particleSystems"].reduce((total, key) => total + (Number(metrics[key]) || 0), 0),
			gcEvents: null,
			gcDurationMs: null,
		},
		counts: Object.fromEntries(
			["meshes", "materials", "textures", "lights", "cameras", "particleSystems"].map((key) => [key, Number.isFinite(metrics[key]) ? metrics[key] : 0])
		),
		limitations: ["This snapshot was migrated from legacy scene diagnostics and has no heap or byte-allocation evidence."],
	};
}

function migrate(scene: Scene): IPortableProfilerState {
	const state = createPortableProfilerState();
	const legacyCaptures = Array.isArray(scene.metadata?.babylonEditorProfilerCaptures) ? scene.metadata.babylonEditorProfilerCaptures : [];
	const legacySnapshots = Array.isArray(scene.metadata?.babylonEditorProfilerSnapshots) ? scene.metadata.babylonEditorProfilerSnapshots : [];
	// Bound candidate work before legacy conversion; one valid old capture may itself contain tens of thousands of samples.
	state.captures = legacyCaptures
		.slice(0, 100)
		.map(migrateLegacyCapture)
		.filter((capture): capture is IPortableProfilerCapture => Boolean(capture))
		.slice(0, state.maximumRetainedCaptures);
	state.memorySnapshots = legacySnapshots
		.slice(0, 200)
		.map(migrateLegacySnapshot)
		.filter((snapshot): snapshot is IPortableProfilerMemorySnapshot => Boolean(snapshot))
		.slice(0, state.maximumRetainedSnapshots);
	return state;
}

/** Returns the canonical scene-persisted profiler state, migrating legacy flat data once. */
export function profilingState(scene: Scene): IPortableProfilerState {
	scene.metadata ??= {};
	if (!scene.metadata[metadataKey]) {
		scene.metadata[metadataKey] = migrate(scene);
	}
	const cached = stateCache.get(scene);
	if (cached && scene.metadata[metadataKey] === cached) {
		return cached;
	}
	const normalized = immutableProfilerState(normalizePortableProfilerState(scene.metadata[metadataKey]));
	scene.metadata[metadataKey] = normalized;
	stateCache.set(scene, normalized);
	return normalized;
}

export function persistProfilingState(scene: Scene, state: IPortableProfilerState): IPortableProfilerState {
	scene.metadata ??= {};
	const normalized = immutableProfilerState(normalizePortableProfilerState(state));
	scene.metadata[metadataKey] = normalized;
	stateCache.set(scene, normalized);
	return normalized;
}

export function requireProfilingRevision(scene: Scene, expectedRevision: unknown): IPortableProfilerState {
	const state = profilingState(scene);
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== state.revision) {
		throw new Error(`Profiler state revision is ${state.revision}; received stale or missing expectedRevision ${String(expectedRevision)}.`);
	}
	return state;
}

export function bumpProfilingRevision(scene: Scene, state = profilingState(scene)): IPortableProfilerState {
	return persistProfilingState(scene, { ...state, revision: state.revision + 1 });
}
