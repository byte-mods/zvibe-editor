import { EngineInstrumentation } from "@babylonjs/core/Instrumentation/engineInstrumentation";
import { SceneInstrumentation } from "@babylonjs/core/Instrumentation/sceneInstrumentation";
import { Scene } from "@babylonjs/core/scene";

import {
	IPortableProfilerAssetEvent,
	IPortableProfilerAssetMetrics,
	IPortableProfilerAvailability,
	IPortableProfilerCapture,
	IPortableProfilerCaptureOptions,
	IPortableProfilerCaptureQuery,
	IPortableProfilerCaptureQueryResult,
	IPortableProfilerCallbacks,
	IPortableProfilerFrame,
	IPortableProfilerMarker,
	IPortableProfilerMarkerHandle,
	IPortableProfilerMarkerSummary,
	IPortableProfilerMemoryComparison,
	IPortableProfilerMemoryMetrics,
	IPortableProfilerMemorySnapshot,
	IPortableProfilerNumericSummary,
	IPortableProfilerSession,
	IPortableProfilerState,
	PortableProfilerMarkerCategory,
	PortableProfilerModule,
	PORTABLE_PROFILER_VERSION,
} from "./types";
import { measurePortableProfiler2D } from "./two-d";

const allModules: PortableProfilerModule[] = ["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio", "2d"];
const legacyV1Modules = ["cpu", "gpu", "rendering", "memory", "assets", "scripts", "physics", "audio"] as const;
const defaultModules: PortableProfilerModule[] = [...legacyV1Modules];
export const PORTABLE_PROFILER_MAXIMUM_MARKERS = 250_000;
export const PORTABLE_PROFILER_MAXIMUM_ASSET_EVENTS = 50_000;
export const PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS = 200;
export const PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES = 50 * 1024 * 1024;
export const PORTABLE_PROFILER_MAXIMUM_EVIDENCE_BYTES = 40 * 1024 * 1024;
const maximumRetainedCaptureBytes = 64 * 1024 * 1024;
const maximumRetainedSnapshotBytes = 32 * 1024 * 1024;
export const PORTABLE_PROFILER_MAXIMUM_RETAINED_STATE_BYTES = maximumRetainedCaptureBytes + maximumRetainedSnapshotBytes;
const maximumMarkerDepth = 128;
const maximumMarkerSummaryCount = 10_000;
const maximumHierarchyVisits = 2_000_000;
const maximumLimitations = 128;
const maximumRetainedCaptureCandidates = 100;
const maximumRetainedSnapshotCandidates = 200;
const maximumMemoryEstimateCadenceFrames = 60;
const activeSessions = new WeakMap<Scene, IProfilerRuntime>();

interface IProfilerRuntime {
	capture: IPortableProfilerCapture;
	startedMs: number;
	frameCounter: number;
	currentFrameIndex: number;
	resourceEntryNames: Set<string>;
	resourceEntryCursor: number;
	resourceEntryBoundary: { entry: unknown; key: string } | null;
	assetCollectionStopped: boolean;
	markerStack: IPortableProfilerMarker[];
	markersByFrame: Map<number, IPortableProfilerMarker[]>;
	sceneInstrumentation: SceneInstrumentation;
	engineInstrumentation: EngineInstrumentation;
	observer: any;
	disposeObserver: any;
	durationTimer: ReturnType<typeof setTimeout> | null;
	retainedDataBytes: number;
	stopped: boolean;
	finalCapture: IPortableProfilerCapture | null;
	memoryMetrics: IPortableProfilerMemoryMetrics | null;
	memoryLastMeasuredFrame: number;
	memoryDirty: boolean;
	memoryObservers: Array<{ observable: { remove(observer: any): boolean }; observer: any }>;
}

function now(): number {
	return globalThis.performance?.now?.() ?? Date.now();
}

function identifier(prefix: string): string {
	const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	return `${prefix}-${random}`;
}

function availability(available: boolean, precision: IPortableProfilerAvailability["precision"], reason: string | null = null): IPortableProfilerAvailability {
	return { available, precision, reason };
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jsonByteLength(value: unknown): number {
	return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

/** Adds derived/runtime caveats without allowing public capture mutation to overflow the portable schema. */
function appendProfilerLimitations(capture: { limitations: string[] }, limitations: string[]): void {
	const additions = [...new Set(limitations)].filter((limitation) => !capture.limitations.includes(limitation)).slice(0, maximumLimitations);
	if (!additions.length) {
		return;
	}
	capture.limitations = [...capture.limitations.slice(0, maximumLimitations - additions.length), ...additions];
}

function reserveRuntimeData(runtime: IProfilerRuntime, value: unknown, limitation: string): boolean {
	const bytes = jsonByteLength(value) + 1;
	if (runtime.retainedDataBytes + bytes > PORTABLE_PROFILER_MAXIMUM_EVIDENCE_BYTES) {
		appendProfilerLimitations(runtime.capture, [limitation]);
		return false;
	}
	runtime.retainedDataBytes += bytes;
	return true;
}

function percentile(values: number[], amount: number): number {
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * amount) - 1))];
}

function numericSummary(values: number[]): IPortableProfilerNumericSummary {
	let average = 0;
	for (let index = 0; index < values.length; index++) {
		average += (values[index] - average) / (index + 1);
	}
	return {
		minimum: Math.min(...values),
		maximum: Math.max(...values),
		average,
		median: percentile(values, 0.5),
		p95: percentile(values, 0.95),
		latest: values[values.length - 1],
		samples: values.length,
	};
}

function collectFrameNumbers(frame: IPortableProfilerFrame, output: Record<string, number[]>): void {
	const collect = (prefix: string, value: unknown): void => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			return;
		}
		for (const [key, entry] of Object.entries(value)) {
			if (typeof entry === "number" && Number.isFinite(entry)) {
				(output[`${prefix}.${key}`] ??= []).push(entry);
			}
		}
	};
	collect("cpu", frame.cpu);
	if (typeof frame.gpuFrameTimeMs === "number" && Number.isFinite(frame.gpuFrameTimeMs)) {
		(output.gpuFrameTimeMs ??= []).push(frame.gpuFrameTimeMs);
	}
	collect("rendering", frame.rendering);
	collect("memory", frame.memory);
	collect("assets", frame.assets);
	collect("audio", frame.audio);
	collect("twoD", frame.twoD);
}

function estimateGeometryBytes(scene: Scene): number {
	let bytes = 0;
	const resources = new Set<unknown>();
	for (const mesh of scene.meshes) {
		const value = mesh as any;
		const resource = value.geometry ?? value.sourceMesh?.geometry ?? value;
		if (resources.has(resource)) {
			continue;
		}
		resources.add(resource);
		for (const kind of value.getVerticesDataKinds?.() ?? []) {
			const data = value.getVerticesData?.(kind, false, false);
			bytes += finite(data?.byteLength) ?? (finite(data?.length) ?? 0) * (finite(data?.BYTES_PER_ELEMENT) ?? 4);
		}
		const indices = value.getIndices?.(false, false);
		bytes += finite(indices?.byteLength) ?? (finite(indices?.length) ?? 0) * (finite(indices?.BYTES_PER_ELEMENT) ?? (value.getTotalVertices?.() > 65_535 ? 4 : 2));
	}
	return Math.max(0, Math.round(bytes));
}

function estimateTextureBytes(scene: Scene): number {
	let bytes = 0;
	const resources = new Set<unknown>();
	for (const texture of scene.textures) {
		const resource = (texture as any).getInternalTexture?.() ?? texture;
		if (resources.has(resource)) {
			continue;
		}
		resources.add(resource);
		const size = (texture as any).getSize?.();
		if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) {
			continue;
		}
		const faces = (texture as any).isCube ? 6 : 1;
		const mipFactor = (texture as any).noMipmap ? 1 : 4 / 3;
		bytes += size.width * size.height * 4 * faces * mipFactor;
	}
	return Math.max(0, Math.round(bytes));
}

/** Captures the memory counters the browser exposes plus deterministic scene-resource estimates. */
export function measurePortableProfilerMemory(scene: Scene): IPortableProfilerMemoryMetrics {
	const memory = (globalThis.performance as any)?.memory;
	const estimatedGeometryBytes = estimateGeometryBytes(scene);
	const estimatedTextureBytes = estimateTextureBytes(scene);
	const sceneObjectCount = scene.meshes.length + scene.transformNodes.length + scene.materials.length + scene.textures.length + scene.lights.length + scene.cameras.length;
	return {
		usedHeapBytes: finite(memory?.usedJSHeapSize),
		totalHeapBytes: finite(memory?.totalJSHeapSize),
		heapLimitBytes: finite(memory?.jsHeapSizeLimit),
		estimatedGeometryBytes,
		estimatedTextureBytes,
		estimatedSceneBytes: estimatedGeometryBytes + estimatedTextureBytes,
		sceneObjectCount,
		gcEvents: null,
		gcDurationMs: null,
	};
}

/** Reuses expensive resource estimates on the hot frame path while keeping browser heap counters current. */
function samplePortableProfilerMemory(scene: Scene, runtime: IProfilerRuntime): IPortableProfilerMemoryMetrics {
	if (runtime.memoryDirty || !runtime.memoryMetrics || runtime.currentFrameIndex - runtime.memoryLastMeasuredFrame >= maximumMemoryEstimateCadenceFrames) {
		runtime.memoryMetrics = measurePortableProfilerMemory(scene);
		runtime.memoryLastMeasuredFrame = runtime.currentFrameIndex;
		runtime.memoryDirty = false;
	}
	const memory = (globalThis.performance as any)?.memory;
	return {
		...runtime.memoryMetrics,
		usedHeapBytes: finite(memory?.usedJSHeapSize),
		totalHeapBytes: finite(memory?.totalJSHeapSize),
		heapLimitBytes: finite(memory?.jsHeapSizeLimit),
		sceneObjectCount: scene.meshes.length + scene.transformNodes.length + scene.materials.length + scene.textures.length + scene.lights.length + scene.cameras.length,
	};
}

function memoryCounts(scene: Scene): Record<string, number> {
	return {
		meshes: scene.meshes.length,
		transformNodes: scene.transformNodes.length,
		materials: scene.materials.length,
		textures: scene.textures.length,
		lights: scene.lights.length,
		cameras: scene.cameras.length,
		particleSystems: scene.particleSystems.length,
		animationGroups: scene.animationGroups.length,
		skeletons: scene.skeletons.length,
	};
}

/** Creates a named memory snapshot suitable for deterministic before/after comparison. */
export function capturePortableProfilerMemorySnapshot(
	scene: Scene,
	name: string,
	captureId: string | null = null,
	frameIndex: number | null = null
): IPortableProfilerMemorySnapshot {
	if (!name.trim() || name.length > 120) {
		throw new Error("Profiler memory snapshot name must contain 1-120 characters.");
	}
	const metrics = measurePortableProfilerMemory(scene);
	return {
		id: identifier("memory"),
		name: name.trim(),
		capturedAt: new Date().toISOString(),
		captureId,
		frameIndex,
		metrics,
		counts: memoryCounts(scene),
		limitations: [
			metrics.usedHeapBytes === null
				? "The current runtime does not expose Chromium JavaScript heap counters."
				: "JavaScript heap counters exclude native GPU/driver allocations.",
			"Geometry and texture byte counts are conservative scene-resource estimates; compressed GPU residency and shared resources vary by backend.",
			"Browser runtimes do not expose reliable per-allocation call stacks or garbage-collection events.",
		],
	};
}

/** Compares two memory snapshots without presenting estimates as exact native allocation data. */
export function comparePortableProfilerMemorySnapshots(baseline: IPortableProfilerMemorySnapshot, current: IPortableProfilerMemorySnapshot): IPortableProfilerMemoryComparison {
	const metricDelta = {} as IPortableProfilerMemoryComparison["metricDelta"];
	for (const key of Object.keys(current.metrics) as Array<keyof IPortableProfilerMemoryMetrics>) {
		const left = baseline.metrics[key];
		const right = current.metrics[key];
		metricDelta[key] = typeof left === "number" && typeof right === "number" ? right - left : null;
	}
	const countDelta: Record<string, number> = {};
	for (const key of new Set([...Object.keys(baseline.counts), ...Object.keys(current.counts)])) {
		countDelta[key] = (current.counts[key] ?? 0) - (baseline.counts[key] ?? 0);
	}
	const potentialGrowth = [
		...Object.entries(metricDelta)
			.filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
			.map(([key, delta]) => ({ key, delta, kind: "metric" as const })),
		...Object.entries(countDelta)
			.filter(([, delta]) => delta > 0)
			.map(([key, delta]) => ({ key, delta, kind: "count" as const })),
	].sort((left, right) => right.delta - left.delta);
	return {
		baseline: { id: baseline.id, name: baseline.name, capturedAt: baseline.capturedAt },
		current: { id: current.id, name: current.name, capturedAt: current.capturedAt },
		metricDelta,
		countDelta,
		potentialGrowth,
		limitations: [...new Set([...baseline.limitations, ...current.limitations])],
	};
}

function resourceKey(name: string, startTime: number, duration: number): string {
	let hash = 2_166_136_261;
	for (let index = 0; index < name.length; index++) {
		hash = Math.imul(hash ^ name.charCodeAt(index), 16_777_619);
	}
	return `${(hash >>> 0).toString(16)}|${startTime}|${duration}`;
}

function resourceEntries(runtime: IProfilerRuntime): Array<{ event: IPortableProfilerAssetEvent; key: string; reservationBytes: number }> {
	if (runtime.assetCollectionStopped) {
		return [];
	}
	const entries = globalThis.performance?.getEntriesByType?.("resource") ?? [];
	const result: Array<{ event: IPortableProfilerAssetEvent; key: string; reservationBytes: number }> = [];
	if (entries.length < runtime.resourceEntryCursor) {
		runtime.resourceEntryCursor = 0;
		runtime.resourceEntryBoundary = null;
	} else if (runtime.resourceEntryCursor > 0) {
		const boundary = entries[runtime.resourceEntryCursor - 1] as any;
		const boundaryName = String(boundary?.name ?? "resource").slice(0, 2_048);
		const boundaryStart = finite(boundary?.startTime) ?? runtime.startedMs;
		const boundaryDuration = Math.max(0, finite(boundary?.duration) ?? 0);
		const boundaryKey = resourceKey(boundaryName, boundaryStart, boundaryDuration);
		if (boundary !== runtime.resourceEntryBoundary?.entry && boundaryKey !== runtime.resourceEntryBoundary?.key) {
			runtime.resourceEntryCursor = 0;
			runtime.resourceEntryBoundary = null;
		} else {
			runtime.resourceEntryBoundary = { entry: boundary, key: boundaryKey };
		}
	}
	for (let index = runtime.resourceEntryCursor; index < entries.length; index++) {
		const raw = entries[index] as any;
		runtime.resourceEntryCursor = index + 1;
		const name = String(raw.name ?? "resource").slice(0, 2_048);
		const startTime = finite(raw.startTime) ?? runtime.startedMs;
		const duration = Math.max(0, finite(raw.duration) ?? 0);
		const key = resourceKey(name, startTime, duration);
		runtime.resourceEntryBoundary = { entry: raw, key };
		if (raw.startTime < runtime.startedMs) {
			continue;
		}
		if (runtime.capture.assetEvents.length + result.length >= PORTABLE_PROFILER_MAXIMUM_ASSET_EVENTS) {
			runtime.assetCollectionStopped = true;
			appendProfilerLimitations(runtime.capture, ["Asset event collection stopped at the 50,000-entry capture limit."]);
			break;
		}
		if (runtime.resourceEntryNames.has(key)) {
			continue;
		}
		const transferBytes = finite(raw.transferSize);
		const event: IPortableProfilerAssetEvent = {
			id: identifier("asset"),
			frameIndex: runtime.currentFrameIndex,
			name,
			initiatorType: String(raw.initiatorType ?? "other").slice(0, 80),
			startMs: Math.max(0, startTime - runtime.startedMs),
			durationMs: duration,
			transferBytes,
			encodedBodyBytes: finite(raw.encodedBodySize),
			decodedBodyBytes: finite(raw.decodedBodySize),
			protocol: typeof raw.nextHopProtocol === "string" && raw.nextHopProtocol ? raw.nextHopProtocol.slice(0, 80) : null,
			availability: availability(true, "browser-counter", transferBytes === 0 ? "Cross-origin timing policy or cache reuse may hide transferred byte counts." : null),
		};
		const reservation = { event, key };
		if (!reserveRuntimeData(runtime, reservation, "Asset event collection stopped at the portable capture byte limit.")) {
			runtime.assetCollectionStopped = true;
			break;
		}
		runtime.resourceEntryNames.add(key);
		runtime.capture.assetEvents.push(event);
		result.push({ event, key, reservationBytes: jsonByteLength(reservation) + 1 });
	}
	return result;
}

function assetMetrics(events: IPortableProfilerAssetEvent[]): IPortableProfilerAssetMetrics {
	const transfers = events.map((entry) => entry.transferBytes).filter((value): value is number => value !== null);
	const decoded = events.map((entry) => entry.decodedBodyBytes).filter((value): value is number => value !== null);
	return {
		completedRequests: events.length,
		durationMs: events.reduce((total, entry) => total + entry.durationMs, 0),
		transferBytes: transfers.length ? transfers.reduce((total, value) => total + value, 0) : null,
		decodedBodyBytes: decoded.length ? decoded.reduce((total, value) => total + value, 0) : null,
	};
}

function currentMarkers(runtime: IProfilerRuntime, frameIndex: number): IPortableProfilerMarker[] {
	return runtime.markersByFrame.get(frameIndex) ?? [];
}

function reconcileCapturedScriptMetrics(capture: IPortableProfilerCapture): void {
	if (!capture.modules.includes("scripts") || !capture.frames.length) {
		return;
	}
	const byFrame = new Map<number, { calls: number; errors: number; durationMs: number }>();
	for (const marker of capture.markers) {
		if (marker.category !== "Scripts") {
			continue;
		}
		const metrics = byFrame.get(marker.frameIndex) ?? { calls: 0, errors: 0, durationMs: 0 };
		metrics.calls++;
		metrics.errors += marker.error === null ? 0 : 1;
		metrics.durationMs += marker.durationMs;
		byFrame.set(marker.frameIndex, metrics);
	}
	for (const frame of capture.frames) {
		if (!frame.cpu) {
			continue;
		}
		const metrics = byFrame.get(frame.index) ?? { calls: 0, errors: 0, durationMs: 0 };
		frame.cpu.scriptCalls = metrics.calls;
		frame.cpu.scriptErrors = metrics.errors;
		frame.cpu.scriptTimeMs = metrics.durationMs;
	}
}

function sampleFrame(scene: Scene, runtime: IProfilerRuntime): boolean {
	const capture = runtime.capture;
	const modules = new Set(capture.modules);
	runtime.currentFrameIndex = capture.frames.length;
	const resources = modules.has("assets") ? resourceEntries(runtime) : [];
	const retainedEvents = resources.map((entry) => entry.event);
	const markers = currentMarkers(runtime, runtime.currentFrameIndex);
	const scripts = markers.filter((marker) => marker.category === "Scripts");
	const sceneInstrumentation = runtime.sceneInstrumentation;
	const engineInstrumentation = runtime.engineInstrumentation;
	const engine = scene.getEngine() as any;
	const indices = Math.max(0, scene.getActiveIndices());
	const cpu =
		modules.has("cpu") || modules.has("scripts") || modules.has("physics")
			? {
					frameTimeMs: Math.max(0, engine.getDeltaTime()),
					interFrameTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.interFrameTimeCounter.current) : null,
					renderTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.renderTimeCounter.current) : null,
					activeMeshesEvaluationTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.activeMeshesEvaluationTimeCounter.current) : null,
					renderTargetsTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.renderTargetsRenderTimeCounter.current) : null,
					animationsTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.animationsTimeCounter.current) : null,
					physicsTimeMs:
						(modules.has("physics") || modules.has("cpu")) && capture.availability.physics.available ? finite(sceneInstrumentation.physicsTimeCounter.current) : null,
					particlesTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.particlesRenderTimeCounter.current) : null,
					spritesTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.spritesRenderTimeCounter.current) : null,
					cameraRenderTimeMs: modules.has("cpu") ? finite(sceneInstrumentation.cameraRenderTimeCounter.current) : null,
					scriptTimeMs: scripts.reduce((total, marker) => total + marker.durationMs, 0),
					scriptCalls: scripts.length,
					scriptErrors: scripts.filter((marker) => marker.error).length,
				}
			: null;
	const frame: IPortableProfilerFrame = {
		index: runtime.currentFrameIndex,
		capturedAt: new Date().toISOString(),
		elapsedMs: Math.max(0, now() - runtime.startedMs),
		cpu,
		gpuFrameTimeMs: modules.has("gpu") && capture.availability.gpu.available ? finite(engineInstrumentation.gpuFrameTimeCounter.current * 0.000001) : null,
		rendering: modules.has("rendering")
			? {
					drawCalls: Math.max(0, sceneInstrumentation.drawCallsCounter.current),
					batches: Math.max(0, sceneInstrumentation.drawCallsCounter.current),
					setPassCalls: null,
					activeMeshes: scene.getActiveMeshes().length,
					vertices: scene.getTotalVertices(),
					indices,
					triangles: Math.floor(indices / 3),
					materials: scene.materials.length,
					textures: scene.textures.length,
					lights: scene.lights.length,
					cameras: scene.cameras.length,
					particleSystems: scene.particleSystems.length,
					shaderCompilationTimeMs: finite(engineInstrumentation.shaderCompilationTimeCounter.current),
				}
			: null,
		memory: modules.has("memory") ? samplePortableProfilerMemory(scene, runtime) : null,
		assets: modules.has("assets") ? assetMetrics(retainedEvents) : null,
		audio: modules.has("audio")
			? {
					soundCount: (scene as any).sounds?.length ?? 0,
					playingSoundCount: ((scene as any).sounds ?? []).filter((sound: any) => sound.isPlaying).length,
				}
			: null,
		twoD: modules.has("2d") ? measurePortableProfiler2D(scene).metrics : null,
	};
	if (!reserveRuntimeData(runtime, frame, "Frame collection stopped at the portable capture byte limit.")) {
		capture.assetEvents.splice(Math.max(0, capture.assetEvents.length - retainedEvents.length), retainedEvents.length);
		for (const resource of resources) {
			runtime.resourceEntryNames.delete(resource.key);
			runtime.retainedDataBytes -= resource.reservationBytes;
		}
		return false;
	}
	capture.frames.push(frame);
	return true;
}

function moduleAvailability(scene: Scene): Record<PortableProfilerModule, IPortableProfilerAvailability> {
	const memory = (globalThis.performance as any)?.memory;
	const hasResourceTiming = typeof globalThis.performance?.getEntriesByType === "function";
	const engineCapabilities = (scene.getEngine() as any).getCaps?.() ?? {};
	const gpuTimestamps = Boolean(engineCapabilities.timerQuery || engineCapabilities.canUseTimestampForTimerQuery);
	const hasPhysics = Boolean((scene as any).getPhysicsEngine?.());
	return {
		cpu: availability(true, "engine-counter"),
		gpu: availability(
			gpuTimestamps,
			gpuTimestamps ? "engine-counter" : "unavailable",
			gpuTimestamps ? "GPU timestamp queries can remain zero until warmed up by the active backend." : "The active backend does not advertise GPU timestamp-query support."
		),
		rendering: availability(true, "engine-counter", "Babylon does not expose a portable SetPass counter; draw-call batches are reported instead."),
		memory: availability(
			true,
			memory ? "browser-counter" : "estimated",
			memory ? "Native GPU and driver allocations are excluded." : "JavaScript heap counters are unavailable; scene resources remain estimated."
		),
		assets: availability(
			hasResourceTiming,
			hasResourceTiming ? "browser-counter" : "unavailable",
			hasResourceTiming ? "Resource Timing excludes native file I/O and may hide cross-origin byte counts." : "Resource Timing is unavailable."
		),
		scripts: availability(true, "exact", "Attached script lifecycle markers are exact; arbitrary JavaScript without markers is not deep-profiled."),
		physics: availability(hasPhysics, hasPhysics ? "engine-counter" : "unavailable", hasPhysics ? null : "No physics engine is active in this scene."),
		audio: availability(true, "engine-counter", "Browser audio does not expose native DSP graph cost per voice."),
		"2d": availability(true, "estimated", "Atlas residency and draw calls are portable estimates; the detailed occupancy view is sampled on demand."),
	};
}

function configureInstrumentation(runtime: IProfilerRuntime): void {
	const modules = new Set(runtime.capture.modules);
	const scene = runtime.sceneInstrumentation;
	scene.captureFrameTime = modules.has("cpu");
	scene.captureInterFrameTime = modules.has("cpu");
	scene.captureRenderTime = modules.has("cpu");
	scene.captureActiveMeshesEvaluationTime = modules.has("cpu");
	scene.captureRenderTargetsRenderTime = modules.has("cpu");
	scene.captureAnimationsTime = modules.has("cpu");
	scene.capturePhysicsTime = modules.has("cpu") || modules.has("physics");
	scene.captureParticlesRenderTime = modules.has("cpu");
	scene.captureSpritesRenderTime = modules.has("cpu");
	scene.captureCameraRenderTime = modules.has("cpu");
	runtime.engineInstrumentation.captureGPUFrameTime = modules.has("gpu");
	runtime.engineInstrumentation.captureShaderCompilationTime = modules.has("rendering");
}

function markerHierarchy(markers: IPortableProfilerMarker[], inverted: boolean): { summaries: IPortableProfilerMarkerSummary[]; truncated: boolean } {
	const markerById = new Map(markers.map((marker) => [marker.id, marker]));
	const childDurationByParentId = new Map<string, number>();
	for (const marker of markers) {
		if (marker.parentId) {
			childDurationByParentId.set(marker.parentId, (childDurationByParentId.get(marker.parentId) ?? 0) + marker.durationMs);
		}
	}
	const summaries = new Map<string, IPortableProfilerMarkerSummary>();
	const pathIds = new Map<string, string>();
	let nextPathId = 1;
	let visits = 0;
	let truncated = false;
	const recordPath = (chain: IPortableProfilerMarker[], start: number, end: number, step: 1 | -1, marker: IPortableProfilerMarker): boolean => {
		let parentKey: string | null = null;
		let key = "";
		for (let index = start; step === 1 ? index <= end : index >= end; index += step) {
			if (visits >= maximumHierarchyVisits) {
				return false;
			}
			visits++;
			const entry = chain[index];
			const identity = `${parentKey ?? "root"}\u0000${entry.category}\u0000${entry.name}`;
			key = pathIds.get(identity) ?? `marker-path-${nextPathId++}`;
			pathIds.set(identity, key);
			if (index !== end) {
				parentKey = key;
			}
		}
		if (!summaries.has(key) && summaries.size >= maximumMarkerSummaryCount) {
			return false;
		}
		const displayed = chain[end];
		const childDuration = childDurationByParentId.get(marker.id) ?? 0;
		const pathLength = Math.abs(end - start) + 1;
		const summary = summaries.get(key) ?? {
			key,
			name: displayed.name,
			category: displayed.category,
			parentKey,
			depth: pathLength - 1,
			calls: 0,
			totalMs: 0,
			selfMs: 0,
			averageMs: 0,
			maximumMs: 0,
			errors: 0,
		};
		summary.calls++;
		summary.totalMs += marker.durationMs;
		summary.selfMs += inverted && pathLength > 1 ? 0 : Math.max(0, marker.durationMs - childDuration);
		summary.maximumMs = Math.max(summary.maximumMs, marker.durationMs);
		summary.errors += marker.error ? 1 : 0;
		summary.averageMs = summary.totalMs / summary.calls;
		summaries.set(key, summary);
		return true;
	};
	markerLoop: for (const marker of markers) {
		const chain: IPortableProfilerMarker[] = [];
		const seen = new Set<string>();
		let current: IPortableProfilerMarker | undefined = marker;
		while (current && chain.length < maximumMarkerDepth && !seen.has(current.id)) {
			if (visits >= maximumHierarchyVisits) {
				truncated = true;
				break markerLoop;
			}
			visits++;
			chain.push(current);
			seen.add(current.id);
			current = current.parentId ? markerById.get(current.parentId) : undefined;
		}
		if (inverted) {
			for (let end = 0; end < chain.length; end++) {
				if (!recordPath(chain, 0, end, 1, marker)) {
					truncated = true;
					break markerLoop;
				}
			}
		} else if (!recordPath(chain, chain.length - 1, 0, -1, marker)) {
			if (chain.length) {
				truncated = true;
			}
			break;
		}
	}
	return { summaries: [...summaries.values()].sort((left, right) => right.totalMs - left.totalMs || left.key.localeCompare(right.key)), truncated };
}

/** Recomputes compact capture summaries after every stop/import/migration boundary. */
export function summarizePortableProfilerCapture(capture: IPortableProfilerCapture): IPortableProfilerCapture["summary"] {
	const values: Record<string, number[]> = {};
	for (const frame of capture.frames) {
		collectFrameNumbers(frame, values);
	}
	const metrics = Object.fromEntries(Object.entries(values).map(([key, entries]) => [key, numericSummary(entries)]));
	const transfers = capture.assetEvents.map((entry) => entry.transferBytes).filter((value): value is number => value !== null);
	const hierarchy = markerHierarchy(capture.markers, false);
	const markerSummaries = hierarchy.summaries;
	if (hierarchy.truncated) {
		appendProfilerLimitations(capture, [
			"Marker hierarchy aggregation stopped at the bounded 10,000-row or 2,000,000-visit ceiling.",
			"Capture summary marker rows were capped at 10,000; query hierarchy pages for current detail.",
		]);
	}
	return {
		frames: capture.frames.length,
		durationMs: capture.frames.at(-1)?.elapsedMs ?? 0,
		metrics,
		markers: markerSummaries.slice(0, maximumMarkerSummaryCount),
		assetRequests: capture.assetEvents.length,
		assetTransferBytes: transfers.length ? transfers.reduce((total, value) => total + value, 0) : null,
	};
}

function finalizePortableProfilerSummary(capture: IPortableProfilerCapture, minimumDurationMs = 0): IPortableProfilerCapture {
	const terminalDurationMs = Math.min(capture.maximumDurationMs, Math.max(0, minimumDurationMs, capture.summary.durationMs));
	capture.summary = summarizePortableProfilerCapture(capture);
	capture.summary.durationMs = Math.max(capture.summary.durationMs, terminalDurationMs);
	const captureBytes = jsonByteLength(capture);
	if (!portableProfilerCapture(capture, true)) {
		throw new Error("Portable profiler derived summary is non-finite or internally inconsistent.");
	}
	if (captureBytes <= PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
		return capture;
	}
	const limitation = "Derived marker summary rows were truncated to keep the capture within the 50 MiB portable JSON limit.";
	appendProfilerLimitations(capture, [limitation]);
	const markers = capture.summary.markers;
	capture.summary.markers = [];
	let retainedBytes = jsonByteLength(capture);
	for (const marker of markers) {
		const markerBytes = jsonByteLength(marker) + (capture.summary.markers.length ? 1 : 0);
		if (retainedBytes + markerBytes > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
			break;
		}
		capture.summary.markers.push(marker);
		retainedBytes += markerBytes;
	}
	if (jsonByteLength(capture) > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
		throw new Error("Portable profiler capture evidence exceeds the 50 MiB JSON limit after derived-summary truncation.");
	}
	return capture;
}

/** Starts one bounded capture for a scene and owns every observer/instrumentation resource it installs. */
export function startPortableProfilerCapture(scene: Scene, options: IPortableProfilerCaptureOptions, callbacks: IPortableProfilerCallbacks = {}): IPortableProfilerSession {
	if (activeSessions.has(scene)) {
		throw new Error("A portable profiler capture is already active for this scene.");
	}
	if (!options.name?.trim() || options.name.length > 120) {
		throw new Error("Profiler capture name must contain 1-120 characters.");
	}
	if (options.id !== undefined && (typeof options.id !== "string" || !options.id || options.id.length > 160)) {
		throw new Error("Profiler capture id must contain 1-160 characters.");
	}
	if (options.target !== undefined && !["editor-edit", "editor-play", "connected-player"].includes(options.target)) {
		throw new Error("Profiler capture target is unsupported.");
	}
	const modules = [...new Set(options.modules ?? defaultModules)];
	if (!modules.length || modules.some((module) => !allModules.includes(module))) {
		throw new Error("Profiler modules must contain one or more supported module names.");
	}
	const sampleEveryFrames = options.sampleEveryFrames ?? 1;
	const maximumFrames = options.maximumFrames ?? 600;
	const maximumDurationMs = options.maximumDurationMs ?? 60_000;
	if (!Number.isInteger(sampleEveryFrames) || sampleEveryFrames < 1 || sampleEveryFrames > 600) {
		throw new Error("sampleEveryFrames must be an integer from 1 to 600.");
	}
	if (!Number.isInteger(maximumFrames) || maximumFrames < 1 || maximumFrames > 36_000) {
		throw new Error("maximumFrames must be an integer from 1 to 36000.");
	}
	if (!Number.isInteger(maximumDurationMs) || maximumDurationMs < 100 || maximumDurationMs > 3_600_000) {
		throw new Error("maximumDurationMs must be an integer from 100 to 3600000.");
	}
	const startedMs = now();
	const capture: IPortableProfilerCapture = {
		version: PORTABLE_PROFILER_VERSION,
		id: options.id ?? identifier("profile"),
		name: options.name.trim(),
		target: options.target ?? "editor-edit",
		status: "recording",
		startedAt: new Date().toISOString(),
		finishedAt: null,
		failure: null,
		modules,
		sampleEveryFrames,
		maximumFrames,
		maximumDurationMs,
		availability: moduleAvailability(scene),
		frames: [],
		markers: [],
		assetEvents: [],
		memorySnapshots: [],
		summary: { frames: 0, durationMs: 0, metrics: {}, markers: [], assetRequests: 0, assetTransferBytes: null },
		limitations: [
			"Portable profiling runs on the Babylon render thread; native OS threads, drivers, and browser internals are outside its call hierarchy.",
			"Deep script profiling covers attached lifecycle methods and explicit user markers, not arbitrary JavaScript call stacks.",
			"GPU timing depends on backend timestamp-query support and can be unavailable or delayed.",
			...(modules.includes("memory")
				? ["Per-frame heap counters remain current; geometry and texture estimates refresh on resource changes or every 60 sampled frames."]
				: []),
		],
	};
	const fallbackAvailability = structuredClone(capture.availability);
	const failureCapture = (error: unknown): IPortableProfilerCapture => ({
		version: PORTABLE_PROFILER_VERSION,
		id: options.id ?? capture.id,
		name: options.name.trim(),
		target: options.target ?? "editor-edit",
		status: "failed",
		startedAt: capture.startedAt,
		finishedAt: new Date().toISOString(),
		failure: (error instanceof Error ? error.message : String(error)).slice(0, 2_048),
		modules: [...modules],
		sampleEveryFrames,
		maximumFrames,
		maximumDurationMs,
		availability: structuredClone(fallbackAvailability),
		frames: [],
		markers: [],
		assetEvents: [],
		memorySnapshots: [],
		summary: { frames: 0, durationMs: Math.max(0, now() - startedMs), metrics: {}, markers: [], assetRequests: 0, assetTransferBytes: null },
		limitations: ["Profiler evidence was discarded because finalization failed; all instrumentation resources were still released."],
	});
	let sceneInstrumentation: SceneInstrumentation | null = null;
	let engineInstrumentation: EngineInstrumentation | null = null;
	try {
		sceneInstrumentation = new SceneInstrumentation(scene);
		engineInstrumentation = new EngineInstrumentation(scene.getEngine());
	} catch (error) {
		try {
			sceneInstrumentation?.dispose();
		} catch {
			// Preserve the original setup failure.
		}
		try {
			engineInstrumentation?.dispose();
		} catch {
			// Preserve the original setup failure.
		}
		throw error;
	}
	const runtime: IProfilerRuntime = {
		capture,
		startedMs,
		frameCounter: 0,
		currentFrameIndex: 0,
		resourceEntryNames: new Set(),
		resourceEntryCursor: 0,
		resourceEntryBoundary: null,
		assetCollectionStopped: false,
		markerStack: [],
		markersByFrame: new Map(),
		sceneInstrumentation,
		engineInstrumentation,
		observer: null,
		disposeObserver: null,
		durationTimer: null,
		retainedDataBytes: jsonByteLength(capture),
		stopped: false,
		finalCapture: null,
		memoryMetrics: null,
		memoryLastMeasuredFrame: -maximumMemoryEstimateCadenceFrames,
		memoryDirty: true,
		memoryObservers: [],
	};
	const stop = (status: "completed" | "canceled" | "failed" = "completed", failure: string | null = null): IPortableProfilerCapture => {
		if (runtime.stopped) {
			return structuredClone(runtime.finalCapture ?? failureCapture("Profiler capture stopped without final evidence."));
		}
		runtime.stopped = true;
		const cleanupErrors: string[] = [];
		const cleanup = (callback: () => void): void => {
			try {
				callback();
			} catch (error) {
				cleanupErrors.push(error instanceof Error ? error.message : String(error));
			}
		};
		cleanup(() => {
			if (runtime.durationTimer) {
				clearTimeout(runtime.durationTimer);
				runtime.durationTimer = null;
			}
		});
		cleanup(() => scene.onAfterRenderObservable.remove(runtime.observer));
		cleanup(() => scene.onDisposeObservable.remove(runtime.disposeObserver));
		cleanup(() => {
			for (const { observable, observer } of runtime.memoryObservers.splice(0)) {
				observable.remove(observer);
			}
		});
		cleanup(() => {
			for (const marker of runtime.markerStack.splice(0)) {
				marker.durationMs = Math.max(0, now() - runtime.startedMs - marker.startMs);
				marker.error ??= "Capture stopped before marker end.";
			}
		});
		cleanup(() => {
			if (capture.frames.length) {
				for (const marker of capture.markers) {
					marker.frameIndex = Math.min(marker.frameIndex, capture.frames.length - 1);
				}
				reconcileCapturedScriptMetrics(capture);
			}
		});
		cleanup(() => runtime.sceneInstrumentation.dispose());
		cleanup(() => {
			runtime.engineInstrumentation.captureGPUFrameTime = false;
			runtime.engineInstrumentation.captureShaderCompilationTime = false;
			runtime.engineInstrumentation.dispose();
		});
		let result: IPortableProfilerCapture;
		try {
			if (cleanupErrors.length) {
				throw new Error(`Profiler cleanup reported: ${cleanupErrors.join("; ")}`);
			}
			capture.status = status;
			capture.failure = failure;
			capture.finishedAt = new Date().toISOString();
			// Round-trip the terminal evidence before publication so non-throwing public mutations cannot escape as an invalid completed capture.
			result = parsePortableProfilerCapture(serializePortableProfilerCapture(finalizePortableProfilerSummary(capture, now() - runtime.startedMs)));
		} catch (error) {
			result = failureCapture(error);
		} finally {
			activeSessions.delete(scene);
		}
		runtime.finalCapture = result;
		try {
			callbacks.onStopped?.(structuredClone(result));
		} catch (error) {
			console.error("Portable profiler onStopped callback failed.", error);
		}
		return structuredClone(result);
	};
	try {
		if (modules.includes("memory")) {
			const dirty = (): void => {
				runtime.memoryDirty = true;
			};
			const observables: any[] = [scene.onNewMeshAddedObservable, scene.onMeshRemovedObservable, scene.onNewTextureAddedObservable, scene.onTextureRemovedObservable];
			for (const observable of observables) {
				runtime.memoryObservers.push({ observable, observer: observable.add(dirty) });
			}
		}
		configureInstrumentation(runtime);
		runtime.observer = scene.onAfterRenderObservable.add(() => {
			try {
				runtime.frameCounter++;
				if (runtime.frameCounter % sampleEveryFrames === 0 && !sampleFrame(scene, runtime)) {
					stop("completed");
					return;
				}
				if (capture.frames.length >= maximumFrames || now() - runtime.startedMs >= maximumDurationMs) {
					stop("completed");
				}
			} catch (error) {
				stop("failed", error instanceof Error ? error.message.slice(0, 2_048) : String(error).slice(0, 2_048));
			}
		});
		runtime.disposeObserver = scene.onDisposeObservable.addOnce(() => stop("canceled", "Scene disposed during profiling."));
		runtime.durationTimer = setTimeout(() => stop("completed"), maximumDurationMs);
		activeSessions.set(scene, runtime);
	} catch (error) {
		const rollback = (callback: () => void): void => {
			try {
				callback();
			} catch {
				// Preserve the original setup failure while continuing to release every remaining resource.
			}
		};
		rollback(() => {
			if (runtime.durationTimer) {
				clearTimeout(runtime.durationTimer);
			}
		});
		rollback(() => {
			if (runtime.observer) {
				scene.onAfterRenderObservable.remove(runtime.observer);
			}
		});
		rollback(() => {
			if (runtime.disposeObserver) {
				scene.onDisposeObservable.remove(runtime.disposeObserver);
			}
		});
		for (const { observable, observer } of runtime.memoryObservers.splice(0)) {
			rollback(() => observable.remove(observer));
		}
		rollback(() => runtime.sceneInstrumentation.dispose());
		rollback(() => {
			runtime.engineInstrumentation.captureGPUFrameTime = false;
			runtime.engineInstrumentation.captureShaderCompilationTime = false;
			runtime.engineInstrumentation.dispose();
		});
		throw error;
	}
	return { capture, stop };
}

export function getActivePortableProfilerCapture(scene: Scene): IPortableProfilerCapture | null {
	return activeSessions.get(scene)?.capture ?? null;
}

/** Starts a nested main-thread marker; attached scripts use this same path for hierarchy evidence. */
export function beginPortableProfilerMarker(
	scene: Scene,
	name: string,
	category: PortableProfilerMarkerCategory = "User",
	metadata: Partial<Pick<IPortableProfilerMarker, "objectId" | "objectName" | "scriptKey" | "lifecycle">> = {}
): IPortableProfilerMarkerHandle {
	const runtime = activeSessions.get(scene);
	if (!runtime || runtime.stopped) {
		return { end: () => undefined };
	}
	const normalizedCategory: PortableProfilerMarkerCategory = ["Scripts", "Rendering", "Physics", "Animation", "Assets", "Audio", "User"].includes(category) ? category : "User";
	const requiredModule: Partial<Record<PortableProfilerMarkerCategory, PortableProfilerModule>> = {
		Scripts: "scripts",
		User: "scripts",
		Physics: "physics",
		Assets: "assets",
		Audio: "audio",
		Rendering: "rendering",
		Animation: "cpu",
	};
	if (requiredModule[normalizedCategory] && !runtime.capture.modules.includes(requiredModule[normalizedCategory]!)) {
		return { end: () => undefined };
	}
	if (runtime.capture.markers.length >= PORTABLE_PROFILER_MAXIMUM_MARKERS) {
		appendProfilerLimitations(runtime.capture, ["Marker collection stopped at the 250,000-entry capture limit."]);
		return { end: () => undefined };
	}
	if (runtime.markerStack.length >= maximumMarkerDepth) {
		appendProfilerLimitations(runtime.capture, ["Marker nesting stopped at the 128-level capture limit."]);
		return { end: () => undefined };
	}
	const parent = runtime.markerStack.at(-1) ?? null;
	const boundedMetadata = (value: unknown, maximum: number): string | null => (typeof value === "string" ? value.slice(0, maximum) : null);
	const marker: IPortableProfilerMarker = {
		id: identifier("marker"),
		frameIndex: runtime.capture.frames.length,
		name: name.trim().slice(0, 240) || "Unnamed Marker",
		category: normalizedCategory,
		startMs: Math.max(0, now() - runtime.startedMs),
		durationMs: 0,
		depth: runtime.markerStack.length,
		parentId: parent?.id ?? null,
		thread: "main",
		objectId: boundedMetadata(metadata.objectId, 240),
		objectName: boundedMetadata(metadata.objectName, 240),
		scriptKey: boundedMetadata(metadata.scriptKey, 1_024),
		lifecycle: metadata.lifecycle && ["onStart", "onUpdate", "onStop"].includes(metadata.lifecycle) ? metadata.lifecycle : null,
		error: null,
	};
	if (!reserveRuntimeData(runtime, { ...marker, error: "\uffff".repeat(1_024) }, "Marker collection stopped at the portable capture byte limit.")) {
		return { end: () => undefined };
	}
	runtime.markerStack.push(marker);
	runtime.capture.markers.push(marker);
	const frameMarkers = runtime.markersByFrame.get(marker.frameIndex) ?? [];
	frameMarkers.push(marker);
	runtime.markersByFrame.set(marker.frameIndex, frameMarkers);
	let ended = false;
	return {
		end: (error?: unknown): void => {
			if (ended) {
				return;
			}
			ended = true;
			marker.durationMs = Math.max(0, now() - runtime.startedMs - marker.startMs);
			marker.error = error === undefined ? null : error instanceof Error ? error.message.slice(0, 1_024) : String(error).slice(0, 1_024);
			const index = runtime.markerStack.lastIndexOf(marker);
			if (index !== -1) {
				runtime.markerStack.splice(index, 1);
			}
		},
	};
}

/** Runs synchronous work inside a portable profiler marker while preserving thrown errors. */
export function withPortableProfilerMarker<T>(scene: Scene, name: string, callback: () => T, category: PortableProfilerMarkerCategory = "User"): T {
	const marker = beginPortableProfilerMarker(scene, name, category);
	try {
		const result = callback();
		marker.end();
		return result;
	} catch (error) {
		marker.end(error);
		throw error;
	}
}

export function createPortableProfilerState(): IPortableProfilerState {
	return { version: PORTABLE_PROFILER_VERSION, revision: 1, maximumRetainedCaptures: 20, maximumRetainedSnapshots: 40, captures: [], memorySnapshots: [] };
}

function profilerRecord(value: unknown): value is Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

function profilerArray(value: unknown, minimumLength: number, maximumLength: number): value is unknown[] {
	if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
		return false;
	}
	try {
		const keys = Reflect.ownKeys(value);
		if (keys.length !== value.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) {
			return false;
		}
		for (let index = 0; index < value.length; index++) {
			if (!Object.prototype.hasOwnProperty.call(value, index)) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function profilerExactRecord(value: unknown, keys: readonly string[]): value is Record<string, any> {
	if (!profilerRecord(value)) {
		return false;
	}
	try {
		const actual = Reflect.ownKeys(value);
		return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
	} catch {
		return false;
	}
}

function profilerText(value: unknown, maximum: number, nullable = false): boolean {
	return (nullable && value === null) || (typeof value === "string" && value.length <= maximum);
}

function profilerTimestamp(value: unknown, nullable = false): boolean {
	if (nullable && value === null) {
		return true;
	}
	if (typeof value !== "string" || value.length > 80) {
		return false;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function profilerNumber(value: unknown, nullable = false): boolean {
	return (nullable && value === null) || (typeof value === "number" && Number.isFinite(value));
}

function profilerMetricRecord(value: unknown, requiredKeys: readonly string[], nullableKeys: readonly string[] = []): boolean {
	const keys = [...requiredKeys, ...nullableKeys];
	return (
		profilerExactRecord(value, keys) &&
		requiredKeys.every((key) => profilerNumber(value[key]) && value[key] >= 0) &&
		nullableKeys.every((key) => profilerNumber(value[key], true) && (value[key] === null || value[key] >= 0))
	);
}

function profilerNumericMap(value: unknown, maximumKeys: number): boolean {
	const keys = profilerRecord(value) ? Reflect.ownKeys(value) : [];
	return (
		profilerRecord(value) &&
		keys.length <= maximumKeys &&
		keys.every((key) => typeof key === "string") &&
		keys.every((key) => typeof key === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,239}$/.test(key) && Number.isSafeInteger(value[key]) && value[key] >= 0)
	);
}

function profilerLimitations(value: unknown): boolean {
	return profilerArray(value, 0, maximumLimitations) && value.every((entry) => profilerText(entry, 2_048));
}

function profilerAvailability(value: unknown): boolean {
	return (
		profilerExactRecord(value, ["available", "precision", "reason"]) &&
		typeof value.available === "boolean" &&
		["exact", "engine-counter", "browser-counter", "estimated", "unavailable"].includes(value.precision) &&
		profilerText(value.reason, 2_048, true) &&
		(value.available ? value.precision !== "unavailable" : value.precision === "unavailable")
	);
}

function profilerMemorySnapshot(value: unknown): value is IPortableProfilerMemorySnapshot {
	return (
		profilerExactRecord(value, ["id", "name", "capturedAt", "captureId", "frameIndex", "metrics", "counts", "limitations"]) &&
		profilerText(value.id, 160) &&
		Boolean(value.id) &&
		profilerText(value.name, 120) &&
		Boolean(value.name?.trim()) &&
		profilerTimestamp(value.capturedAt) &&
		profilerText(value.captureId, 160, true) &&
		(value.frameIndex === null || (Number.isSafeInteger(value.frameIndex) && value.frameIndex >= 0)) &&
		profilerMetricRecord(
			value.metrics,
			["estimatedGeometryBytes", "estimatedTextureBytes", "estimatedSceneBytes", "sceneObjectCount"],
			["usedHeapBytes", "totalHeapBytes", "heapLimitBytes", "gcEvents", "gcDurationMs"]
		) &&
		Number.isSafeInteger(value.metrics.sceneObjectCount) &&
		(value.metrics.gcEvents === null || Number.isSafeInteger(value.metrics.gcEvents)) &&
		profilerNumericMap(value.counts, 64) &&
		profilerLimitations(value.limitations)
	);
}

function profilerMarker(value: unknown): value is IPortableProfilerMarker {
	return (
		profilerExactRecord(value, [
			"id",
			"frameIndex",
			"name",
			"category",
			"startMs",
			"durationMs",
			"depth",
			"parentId",
			"thread",
			"objectId",
			"objectName",
			"scriptKey",
			"lifecycle",
			"error",
		]) &&
		profilerText(value.id, 160) &&
		Boolean(value.id) &&
		Number.isSafeInteger(value.frameIndex) &&
		value.frameIndex >= 0 &&
		profilerText(value.name, 240) &&
		Boolean(value.name?.trim()) &&
		["Scripts", "Rendering", "Physics", "Animation", "Assets", "Audio", "User"].includes(value.category) &&
		profilerNumber(value.startMs) &&
		value.startMs >= 0 &&
		profilerNumber(value.durationMs) &&
		value.durationMs >= 0 &&
		Number.isSafeInteger(value.depth) &&
		value.depth >= 0 &&
		value.depth <= maximumMarkerDepth &&
		profilerText(value.parentId, 160, true) &&
		value.thread === "main" &&
		profilerText(value.objectId, 240, true) &&
		profilerText(value.objectName, 240, true) &&
		profilerText(value.scriptKey, 1_024, true) &&
		(value.lifecycle === null || ["onStart", "onUpdate", "onStop"].includes(value.lifecycle)) &&
		profilerText(value.error, 1_024, true)
	);
}

function profilerAssetEvent(value: unknown): value is IPortableProfilerAssetEvent {
	return (
		profilerExactRecord(value, [
			"id",
			"frameIndex",
			"name",
			"initiatorType",
			"startMs",
			"durationMs",
			"transferBytes",
			"encodedBodyBytes",
			"decodedBodyBytes",
			"protocol",
			"availability",
		]) &&
		profilerText(value.id, 160) &&
		Boolean(value.id) &&
		Number.isSafeInteger(value.frameIndex) &&
		value.frameIndex >= 0 &&
		profilerText(value.name, 2_048) &&
		profilerText(value.initiatorType, 80) &&
		profilerNumber(value.startMs) &&
		value.startMs >= 0 &&
		profilerNumber(value.durationMs) &&
		value.durationMs >= 0 &&
		profilerNumber(value.transferBytes, true) &&
		(value.transferBytes === null || value.transferBytes >= 0) &&
		profilerNumber(value.encodedBodyBytes, true) &&
		(value.encodedBodyBytes === null || value.encodedBodyBytes >= 0) &&
		profilerNumber(value.decodedBodyBytes, true) &&
		(value.decodedBodyBytes === null || value.decodedBodyBytes >= 0) &&
		profilerText(value.protocol, 80, true) &&
		profilerAvailability(value.availability)
	);
}

function profilerFrame(value: unknown): value is IPortableProfilerFrame {
	return (
		profilerExactRecord(value, ["index", "capturedAt", "elapsedMs", "cpu", "gpuFrameTimeMs", "rendering", "memory", "assets", "audio", "twoD"]) &&
		Number.isSafeInteger(value.index) &&
		value.index >= 0 &&
		profilerTimestamp(value.capturedAt) &&
		profilerNumber(value.elapsedMs) &&
		value.elapsedMs >= 0 &&
		(value.cpu === null ||
			(profilerMetricRecord(
				value.cpu,
				["frameTimeMs", "scriptTimeMs", "scriptCalls", "scriptErrors"],
				[
					"interFrameTimeMs",
					"renderTimeMs",
					"activeMeshesEvaluationTimeMs",
					"renderTargetsTimeMs",
					"animationsTimeMs",
					"physicsTimeMs",
					"particlesTimeMs",
					"spritesTimeMs",
					"cameraRenderTimeMs",
				]
			) &&
				Number.isSafeInteger(value.cpu.scriptCalls) &&
				Number.isSafeInteger(value.cpu.scriptErrors))) &&
		profilerNumber(value.gpuFrameTimeMs, true) &&
		(value.gpuFrameTimeMs === null || value.gpuFrameTimeMs >= 0) &&
		(value.rendering === null ||
			(profilerMetricRecord(
				value.rendering,
				["drawCalls", "batches", "activeMeshes", "vertices", "indices", "triangles", "materials", "textures", "lights", "cameras", "particleSystems"],
				["setPassCalls", "shaderCompilationTimeMs"]
			) &&
				["drawCalls", "batches", "activeMeshes", "vertices", "indices", "triangles", "materials", "textures", "lights", "cameras", "particleSystems"].every((key) =>
					Number.isSafeInteger(value.rendering[key])
				) &&
				(value.rendering.setPassCalls === null || Number.isSafeInteger(value.rendering.setPassCalls)))) &&
		(value.memory === null ||
			(profilerMetricRecord(
				value.memory,
				["estimatedGeometryBytes", "estimatedTextureBytes", "estimatedSceneBytes", "sceneObjectCount"],
				["usedHeapBytes", "totalHeapBytes", "heapLimitBytes", "gcEvents", "gcDurationMs"]
			) &&
				Number.isSafeInteger(value.memory.sceneObjectCount) &&
				(value.memory.gcEvents === null || Number.isSafeInteger(value.memory.gcEvents)))) &&
		(value.assets === null ||
			(profilerMetricRecord(value.assets, ["completedRequests", "durationMs"], ["transferBytes", "decodedBodyBytes"]) &&
				Number.isSafeInteger(value.assets.completedRequests))) &&
		(value.audio === null ||
			(profilerMetricRecord(value.audio, ["soundCount", "playingSoundCount"]) &&
				Number.isSafeInteger(value.audio.soundCount) &&
				Number.isSafeInteger(value.audio.playingSoundCount))) &&
		(value.twoD === null ||
			(profilerMetricRecord(value.twoD, [
				"atlasOwners",
				"spriteManagers",
				"spriteMaps",
				"uniqueTextures",
				"texturePixels",
				"estimatedTextureBytes",
				"definedRegions",
				"usedRegions",
				"definedRegionPixels",
				"usedRegionPixels",
				"spriteCount",
				"visibleSpriteCount",
				"tileCount",
				"estimatedDrawCalls",
			]) &&
				Object.values(value.twoD).every(Number.isSafeInteger)))
	);
}

function profilerNumericSummary(value: unknown): boolean {
	return (
		profilerExactRecord(value, ["minimum", "maximum", "average", "median", "p95", "latest", "samples"]) &&
		["minimum", "maximum", "average", "median", "p95", "latest"].every((key) => profilerNumber(value[key]) && value[key] >= 0) &&
		value.minimum <= value.median &&
		value.median <= value.p95 &&
		value.p95 <= value.maximum &&
		value.average >= value.minimum &&
		value.average <= value.maximum &&
		value.latest >= value.minimum &&
		value.latest <= value.maximum &&
		Number.isSafeInteger(value.samples) &&
		value.samples >= 1
	);
}

function profilerMarkerSummary(value: unknown): boolean {
	return (
		profilerExactRecord(value, ["key", "name", "category", "parentKey", "depth", "calls", "totalMs", "selfMs", "averageMs", "maximumMs", "errors"]) &&
		profilerText(value.key, 64_000) &&
		Boolean(value.key) &&
		profilerText(value.name, 240) &&
		Boolean(value.name?.trim()) &&
		["Scripts", "Rendering", "Physics", "Animation", "Assets", "Audio", "User"].includes(value.category) &&
		profilerText(value.parentKey, 64_000, true) &&
		Number.isSafeInteger(value.depth) &&
		value.depth >= 0 &&
		Number.isSafeInteger(value.calls) &&
		value.calls >= 1 &&
		["totalMs", "selfMs", "averageMs", "maximumMs"].every((key) => profilerNumber(value[key]) && value[key] >= 0) &&
		Number.isSafeInteger(value.errors) &&
		value.errors >= 0
	);
}

function profilerSummary(value: unknown): boolean {
	return (
		profilerExactRecord(value, ["frames", "durationMs", "metrics", "markers", "assetRequests", "assetTransferBytes"]) &&
		Number.isSafeInteger(value.frames) &&
		value.frames >= 0 &&
		profilerNumber(value.durationMs) &&
		value.durationMs >= 0 &&
		profilerRecord(value.metrics) &&
		Object.keys(value.metrics).length <= 256 &&
		Object.keys(value.metrics).every((key) => /^[A-Za-z][A-Za-z0-9_.-]{0,239}$/.test(key)) &&
		Object.values(value.metrics).every(profilerNumericSummary) &&
		profilerArray(value.markers, 0, maximumMarkerSummaryCount) &&
		value.markers.every(profilerMarkerSummary) &&
		Number.isSafeInteger(value.assetRequests) &&
		value.assetRequests >= 0 &&
		profilerNumber(value.assetTransferBytes, true) &&
		(value.assetTransferBytes === null || value.assetTransferBytes >= 0)
	);
}

function profilerCaptureRelations(value: IPortableProfilerCapture): boolean {
	if (
		(value.status === "recording" && (value.finishedAt !== null || value.failure !== null)) ||
		(value.status !== "recording" && value.finishedAt === null) ||
		(value.status === "completed" && value.failure !== null) ||
		(value.status === "failed" && !value.failure?.trim())
	) {
		return false;
	}
	if (value.finishedAt !== null && Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
		return false;
	}
	if (!value.frames.every((frame, index) => frame.index === index)) {
		return false;
	}
	const modules = new Set(value.modules);
	const cpuRequested = modules.has("cpu") || modules.has("scripts") || modules.has("physics");
	const markerModules: Record<PortableProfilerMarkerCategory, PortableProfilerModule> = {
		Scripts: "scripts",
		User: "scripts",
		Physics: "physics",
		Assets: "assets",
		Audio: "audio",
		Rendering: "rendering",
		Animation: "cpu",
	};
	const cpuOnlyMetrics = [
		"interFrameTimeMs",
		"renderTimeMs",
		"activeMeshesEvaluationTimeMs",
		"renderTargetsTimeMs",
		"animationsTimeMs",
		"particlesTimeMs",
		"spritesTimeMs",
		"cameraRenderTimeMs",
	] as const;
	let previousElapsedMs = -1;
	for (const frame of value.frames) {
		if (
			frame.elapsedMs < previousElapsedMs ||
			(!cpuRequested && frame.cpu !== null) ||
			(!modules.has("gpu") || !value.availability.gpu.available ? frame.gpuFrameTimeMs !== null : false) ||
			(!modules.has("rendering") && frame.rendering !== null) ||
			(!modules.has("memory") && frame.memory !== null) ||
			(!modules.has("assets") && frame.assets !== null) ||
			(!modules.has("audio") && frame.audio !== null) ||
			(!modules.has("2d") && frame.twoD !== null)
		) {
			return false;
		}
		previousElapsedMs = frame.elapsedMs;
		if (
			frame.cpu &&
			((!modules.has("cpu") && cpuOnlyMetrics.some((key) => frame.cpu?.[key] !== null)) ||
				(!(modules.has("cpu") || modules.has("physics")) || !value.availability.physics.available ? frame.cpu.physicsTimeMs !== null : false) ||
				(!modules.has("scripts") && (frame.cpu.scriptTimeMs !== 0 || frame.cpu.scriptCalls !== 0 || frame.cpu.scriptErrors !== 0)))
		) {
			return false;
		}
	}
	if (!modules.has("assets") && value.assetEvents.length) {
		return false;
	}
	if (Object.values(value.summary.metrics).some((summary) => summary.samples > value.frames.length)) {
		return false;
	}
	const frameOwned = (index: number): boolean => (value.frames.length ? index < value.frames.length : index === 0);
	const markerById = new Map<string, IPortableProfilerMarker>();
	const scriptsByFrame = new Map<number, { calls: number; errors: number; durationMs: number }>();
	for (const marker of value.markers) {
		if (markerById.has(marker.id) || !frameOwned(marker.frameIndex) || !modules.has(markerModules[marker.category])) {
			return false;
		}
		if (marker.parentId === null) {
			if (marker.depth !== 0) {
				return false;
			}
		} else {
			const parent = markerById.get(marker.parentId);
			if (!parent || marker.depth !== parent.depth + 1 || parent.frameIndex > marker.frameIndex) {
				return false;
			}
		}
		markerById.set(marker.id, marker);
		if (marker.category === "Scripts") {
			const scripts = scriptsByFrame.get(marker.frameIndex) ?? { calls: 0, errors: 0, durationMs: 0 };
			scripts.calls++;
			scripts.errors += marker.error === null ? 0 : 1;
			scripts.durationMs += marker.durationMs;
			scriptsByFrame.set(marker.frameIndex, scripts);
		}
	}
	const assetIds = new Set<string>();
	const assetsByFrame = new Map<number, { count: number; durationMs: number; transferBytes: number | null; decodedBodyBytes: number | null }>();
	for (const event of value.assetEvents) {
		if (assetIds.has(event.id) || !frameOwned(event.frameIndex)) {
			return false;
		}
		assetIds.add(event.id);
		const assets = assetsByFrame.get(event.frameIndex) ?? { count: 0, durationMs: 0, transferBytes: null, decodedBodyBytes: null };
		assets.count++;
		assets.durationMs += event.durationMs;
		assets.transferBytes = event.transferBytes === null ? assets.transferBytes : (assets.transferBytes ?? 0) + event.transferBytes;
		assets.decodedBodyBytes = event.decodedBodyBytes === null ? assets.decodedBodyBytes : (assets.decodedBodyBytes ?? 0) + event.decodedBodyBytes;
		assetsByFrame.set(event.frameIndex, assets);
	}
	for (const frame of value.frames) {
		const scripts = scriptsByFrame.get(frame.index) ?? { calls: 0, errors: 0, durationMs: 0 };
		if (
			modules.has("scripts") &&
			(!frame.cpu ||
				!Number.isSafeInteger(frame.cpu.scriptCalls) ||
				!Number.isSafeInteger(frame.cpu.scriptErrors) ||
				frame.cpu.scriptCalls !== scripts.calls ||
				frame.cpu.scriptErrors !== scripts.errors ||
				Math.abs(frame.cpu.scriptTimeMs - scripts.durationMs) > 0.000_001)
		) {
			return false;
		}
		if (modules.has("assets")) {
			const assets = assetsByFrame.get(frame.index) ?? { count: 0, durationMs: 0, transferBytes: null, decodedBodyBytes: null };
			if (
				!frame.assets ||
				frame.assets.completedRequests !== assets.count ||
				Math.abs(frame.assets.durationMs - assets.durationMs) > 0.000_001 ||
				frame.assets.transferBytes !== assets.transferBytes ||
				frame.assets.decodedBodyBytes !== assets.decodedBodyBytes
			) {
				return false;
			}
		}
	}
	const snapshotIds = new Set<string>();
	for (const snapshot of value.memorySnapshots) {
		if (snapshotIds.has(snapshot.id) || snapshot.captureId !== value.id || (snapshot.frameIndex !== null && snapshot.frameIndex > value.frames.length)) {
			return false;
		}
		snapshotIds.add(snapshot.id);
	}
	return true;
}

/** Converts coherent in-flight portable evidence into an explicit canceled terminal record at persistence/import boundaries. */
function closeImportedPortableProfilerCapture(capture: IPortableProfilerCapture): IPortableProfilerCapture {
	if (capture.status === "recording") {
		capture.status = "canceled";
		capture.finishedAt = new Date().toISOString();
		capture.failure = "Capture was still recording when it crossed a persistence boundary.";
	}
	return capture;
}

function portableProfilerCapture(value: unknown, requireSummary: boolean): value is IPortableProfilerCapture {
	return (
		profilerExactRecord(value, [
			"version",
			"id",
			"name",
			"target",
			"status",
			"startedAt",
			"finishedAt",
			"failure",
			"modules",
			"sampleEveryFrames",
			"maximumFrames",
			"maximumDurationMs",
			"availability",
			"frames",
			"markers",
			"assetEvents",
			"memorySnapshots",
			"summary",
			"limitations",
		]) &&
		value.version === PORTABLE_PROFILER_VERSION &&
		profilerText(value.id, 160) &&
		Boolean(value.id) &&
		profilerText(value.name, 120) &&
		Boolean(value.name?.trim()) &&
		["editor-edit", "editor-play", "connected-player"].includes(value.target) &&
		["recording", "completed", "canceled", "failed"].includes(value.status) &&
		profilerTimestamp(value.startedAt) &&
		profilerTimestamp(value.finishedAt, true) &&
		profilerText(value.failure, 2_048, true) &&
		profilerArray(value.modules, 1, allModules.length) &&
		value.modules.every((module: unknown) => allModules.includes(module as PortableProfilerModule)) &&
		new Set(value.modules).size === value.modules.length &&
		Number.isSafeInteger(value.sampleEveryFrames) &&
		value.sampleEveryFrames >= 1 &&
		value.sampleEveryFrames <= 600 &&
		Number.isSafeInteger(value.maximumFrames) &&
		value.maximumFrames >= 1 &&
		value.maximumFrames <= 36_000 &&
		Number.isSafeInteger(value.maximumDurationMs) &&
		value.maximumDurationMs >= 100 &&
		value.maximumDurationMs <= 3_600_000 &&
		profilerExactRecord(value.availability, allModules) &&
		allModules.every((module) => profilerAvailability(value.availability[module])) &&
		profilerArray(value.frames, 0, Math.min(36_000, value.maximumFrames)) &&
		value.frames.every(profilerFrame) &&
		profilerArray(value.markers, 0, PORTABLE_PROFILER_MAXIMUM_MARKERS) &&
		value.markers.every(profilerMarker) &&
		profilerArray(value.assetEvents, 0, PORTABLE_PROFILER_MAXIMUM_ASSET_EVENTS) &&
		value.assetEvents.every(profilerAssetEvent) &&
		profilerArray(value.memorySnapshots, 0, PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS) &&
		value.memorySnapshots.every(profilerMemorySnapshot) &&
		(!requireSummary || profilerSummary(value.summary)) &&
		profilerLimitations(value.limitations) &&
		profilerCaptureRelations(value as IPortableProfilerCapture)
	);
}

/** Upgrades the exact v1 frame envelope before the current strict validator sees it. */
function upgradePortableProfilerCapture(value: unknown): unknown {
	if (!profilerRecord(value) || value.version !== 1) {
		return value;
	}
	const rootKeys = [
		"version",
		"id",
		"name",
		"target",
		"status",
		"startedAt",
		"finishedAt",
		"failure",
		"modules",
		"sampleEveryFrames",
		"maximumFrames",
		"maximumDurationMs",
		"availability",
		"frames",
		"markers",
		"assetEvents",
		"memorySnapshots",
		"summary",
		"limitations",
	];
	const frameKeys = ["index", "capturedAt", "elapsedMs", "cpu", "gpuFrameTimeMs", "rendering", "memory", "assets", "audio"];
	if (
		!profilerExactRecord(value, rootKeys) ||
		!profilerArray(value.modules, 1, legacyV1Modules.length) ||
		!value.modules.every((module: unknown) => legacyV1Modules.includes(module as (typeof legacyV1Modules)[number])) ||
		!profilerExactRecord(value.availability, legacyV1Modules) ||
		!Array.isArray(value.frames) ||
		!value.frames.every((frame: unknown) => profilerExactRecord(frame, frameKeys))
	) {
		return value;
	}
	const upgraded = structuredClone(value);
	upgraded.version = PORTABLE_PROFILER_VERSION;
	upgraded.availability["2d"] = availability(false, "unavailable", "Portable profiler v1 did not record 2D atlas counters.");
	upgraded.frames = upgraded.frames.map((frame: Record<string, unknown>) => ({ ...frame, twoD: null }));
	return upgraded;
}

export function normalizePortableProfilerState(value: unknown): IPortableProfilerState {
	const input = value && typeof value === "object" ? (value as Partial<IPortableProfilerState>) : {};
	const state = createPortableProfilerState();
	state.revision = Number.isSafeInteger(input.revision) && input.revision! > 0 ? input.revision! : 1;
	state.maximumRetainedCaptures = Number.isSafeInteger(input.maximumRetainedCaptures) ? Math.min(20, Math.max(1, input.maximumRetainedCaptures!)) : 20;
	state.maximumRetainedSnapshots = Number.isSafeInteger(input.maximumRetainedSnapshots) ? Math.min(40, Math.max(2, input.maximumRetainedSnapshots!)) : 40;
	const captureIds = new Set<string>();
	let retainedCaptureBytes = 0;
	if (Array.isArray(input.captures)) {
		for (const candidate of input.captures.slice(0, maximumRetainedCaptureCandidates)) {
			if (state.captures.length >= state.maximumRetainedCaptures) {
				break;
			}
			try {
				const capture = upgradePortableProfilerCapture(candidate);
				if (!portableProfilerCapture(capture, true) || captureIds.has(capture.id)) {
					continue;
				}
				const sourceBytes = jsonByteLength(capture);
				if (sourceBytes > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES || retainedCaptureBytes + sourceBytes > maximumRetainedCaptureBytes) {
					continue;
				}
				const normalized = finalizePortableProfilerSummary(closeImportedPortableProfilerCapture(structuredClone(capture)));
				const normalizedBytes = jsonByteLength(normalized);
				if (retainedCaptureBytes + normalizedBytes > maximumRetainedCaptureBytes) {
					continue;
				}
				captureIds.add(normalized.id);
				state.captures.push(normalized);
				retainedCaptureBytes += normalizedBytes;
			} catch {
				continue;
			}
		}
	}
	const snapshotIds = new Set<string>();
	let retainedSnapshotBytes = 0;
	if (Array.isArray(input.memorySnapshots)) {
		for (const snapshot of input.memorySnapshots.slice(0, maximumRetainedSnapshotCandidates)) {
			if (state.memorySnapshots.length >= state.maximumRetainedSnapshots) {
				break;
			}
			try {
				if (!profilerMemorySnapshot(snapshot) || snapshotIds.has(snapshot.id)) {
					continue;
				}
				const snapshotBytes = jsonByteLength(snapshot);
				if (retainedSnapshotBytes + snapshotBytes > maximumRetainedSnapshotBytes) {
					continue;
				}
				snapshotIds.add(snapshot.id);
				state.memorySnapshots.push(structuredClone(snapshot));
				retainedSnapshotBytes += snapshotBytes;
			} catch {
				continue;
			}
		}
	}
	return structuredClone(state);
}

export function retainPortableProfilerCapture(state: IPortableProfilerState, capture: IPortableProfilerCapture): IPortableProfilerState {
	if (!portableProfilerCapture(capture, true)) {
		throw new Error("Portable profiler capture is structurally invalid and cannot be retained.");
	}
	const retained = finalizePortableProfilerSummary(closeImportedPortableProfilerCapture(structuredClone(capture)));
	const next = normalizePortableProfilerState(state);
	next.revision++;
	next.captures = [retained, ...next.captures.filter((candidate) => candidate.id !== retained.id)].slice(0, next.maximumRetainedCaptures);
	return next;
}

export function retainPortableProfilerMemorySnapshot(state: IPortableProfilerState, snapshot: IPortableProfilerMemorySnapshot): IPortableProfilerState {
	const retained = parsePortableProfilerMemorySnapshot(snapshot);
	const next = normalizePortableProfilerState(state);
	next.revision++;
	next.memorySnapshots = [retained, ...next.memorySnapshots.filter((candidate) => candidate.id !== retained.id)].slice(0, next.maximumRetainedSnapshots);
	return next;
}

/** Returns a bounded profiler page and optionally aggregates markers into hierarchy views. */
export function queryPortableProfilerCapture(capture: IPortableProfilerCapture, query: IPortableProfilerCaptureQuery = {}): IPortableProfilerCaptureQueryResult {
	const bounded = (value: number | undefined, fallback: number, maximum: number): number => (Number.isSafeInteger(value) ? Math.min(maximum, Math.max(0, value!)) : fallback);
	const frameOffset = bounded(query.frameOffset, 0, capture.frames.length);
	const frameLimit = bounded(query.frameLimit, 120, 1_000);
	const markerOffset = bounded(query.markerOffset, 0, capture.markers.length);
	const markerLimit = bounded(query.markerLimit, 200, 2_000);
	const assetOffset = bounded(query.assetOffset, 0, capture.assetEvents.length);
	const assetLimit = bounded(query.assetLimit, 200, 2_000);
	const memorySnapshotOffset = bounded(query.memorySnapshotOffset, 0, capture.memorySnapshots.length);
	const memorySnapshotLimit = bounded(query.memorySnapshotLimit, 4, 4);
	const search = query.search?.toLowerCase();
	const filteredMarkers = capture.markers.filter(
		(marker) =>
			(!query.category || marker.category === query.category) &&
			(!search || `${marker.name} ${marker.objectName ?? ""} ${marker.scriptKey ?? ""}`.toLowerCase().includes(search))
	);
	const hierarchy = query.view === "hierarchy" || query.view === "inverted-hierarchy" ? markerHierarchy(filteredMarkers, query.view === "inverted-hierarchy") : null;
	const markerEntries = hierarchy?.summaries ?? filteredMarkers;
	const filteredAssets = capture.assetEvents.filter((entry) => !search || `${entry.name} ${entry.initiatorType} ${entry.protocol ?? ""}`.toLowerCase().includes(search));
	const { frames: _frames, markers: _markers, assetEvents: _assets, memorySnapshots: _memorySnapshots, ...description } = capture;
	if (hierarchy?.truncated) {
		appendProfilerLimitations(description, ["Marker hierarchy aggregation stopped at the bounded 10,000-row or 2,000,000-visit ceiling."]);
	}
	// Marker summaries are derived from the paged raw evidence and must not silently duplicate up to 10,000 hierarchy rows in every query envelope.
	description.summary = { ...description.summary, markers: [] };
	return {
		capture: structuredClone(description),
		frames: { total: capture.frames.length, offset: frameOffset, limit: frameLimit, entries: structuredClone(capture.frames.slice(frameOffset, frameOffset + frameLimit)) },
		markers: { total: markerEntries.length, offset: markerOffset, limit: markerLimit, entries: structuredClone(markerEntries.slice(markerOffset, markerOffset + markerLimit)) },
		assetEvents: {
			total: filteredAssets.length,
			offset: assetOffset,
			limit: assetLimit,
			entries: structuredClone(filteredAssets.slice(assetOffset, assetOffset + assetLimit)),
		},
		memorySnapshots: {
			total: capture.memorySnapshots.length,
			offset: memorySnapshotOffset,
			limit: memorySnapshotLimit,
			entries: structuredClone(capture.memorySnapshots.slice(memorySnapshotOffset, memorySnapshotOffset + memorySnapshotLimit)),
		},
	};
}

export function serializePortableProfilerCapture(capture: IPortableProfilerCapture): string {
	if (!portableProfilerCapture(capture, true)) {
		throw new Error("Portable profiler capture is structurally invalid and cannot be exported.");
	}
	const serialized = `${JSON.stringify(finalizePortableProfilerSummary(closeImportedPortableProfilerCapture(structuredClone(capture))))}\n`;
	if (jsonByteLength(serialized) > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
		throw new Error("Portable profiler capture exceeds the 50 MiB export limit.");
	}
	return serialized;
}

export function parsePortableProfilerCapture(source: string): IPortableProfilerCapture {
	if (jsonByteLength(source) > PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES) {
		throw new Error("Portable profiler capture exceeds the 50 MiB import limit.");
	}
	const parsed = upgradePortableProfilerCapture(JSON.parse(source));
	if (!portableProfilerCapture(parsed, true)) {
		throw new Error("Portable profiler capture is invalid or uses an unsupported version.");
	}
	return structuredClone(finalizePortableProfilerSummary(closeImportedPortableProfilerCapture(parsed)));
}

export function parsePortableProfilerMemorySnapshot(value: unknown): IPortableProfilerMemorySnapshot {
	if (!profilerMemorySnapshot(value)) {
		throw new Error("Portable profiler memory snapshot is invalid.");
	}
	return structuredClone(value);
}
