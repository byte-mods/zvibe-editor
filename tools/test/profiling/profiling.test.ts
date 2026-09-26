import { FreeCamera, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { applyScriptOnObject } from "../../src/loading/script/apply";
import {
	beginPortableProfilerMarker,
	capturePortableProfilerMemorySnapshot,
	comparePortableProfilerMemorySnapshots,
	createPortableProfilerState,
	getActivePortableProfilerCapture,
	normalizePortableProfilerState,
	parsePortableProfilerCapture,
	PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES,
	PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS,
	queryPortableProfilerCapture,
	retainPortableProfilerCapture,
	retainPortableProfilerMemorySnapshot,
	serializePortableProfilerCapture,
	startPortableProfilerCapture,
} from "../../src/profiling/profiling";

describe("portable profiling", () => {
	let engine: NullEngine | null = null;

	afterEach(() => {
		engine?.dispose();
		engine = null;
	});

	function scene(): Scene {
		engine = new NullEngine();
		const result = new Scene(engine);
		result.activeCamera = new FreeCamera("Camera", Vector3.Zero(), result);
		return result;
	}

	test("records bounded frames, nested markers, summaries, and portable pages", () => {
		const target = scene();
		MeshBuilder.CreateBox("Box", {}, target);
		const session = startPortableProfilerCapture(target, { name: "Frame capture", maximumFrames: 2, modules: ["cpu", "rendering", "memory", "scripts"] });
		const outer = beginPortableProfilerMarker(target, "Gameplay", "User");
		const inner = beginPortableProfilerMarker(target, "Tick", "Scripts", { scriptKey: "tick.ts", lifecycle: "onUpdate" });
		inner.end();
		outer.end();
		target.render();
		target.render();

		expect(session.capture.status).toBe("completed");
		expect(session.capture.frames).toHaveLength(2);
		expect(session.capture.frames[0].rendering?.vertices).toBeGreaterThan(0);
		expect(session.capture.frames.every((frame) => frame.gpuFrameTimeMs === null && frame.cpu?.physicsTimeMs === null)).toBe(true);
		expect(session.capture.markers.map((marker) => marker.parentId)).toEqual([null, session.capture.markers[0].id]);
		expect(session.capture.summary.metrics["cpu.frameTimeMs"].samples).toBe(2);

		const hierarchy = queryPortableProfilerCapture(session.capture, { view: "hierarchy", markerLimit: 10 });
		expect(hierarchy.markers.total).toBe(2);
		expect(hierarchy.capture.summary.markers).toEqual([]);
		expect(hierarchy.frames.total).toBe(2);
		const hierarchyEntries = hierarchy.markers.entries as any[];
		const hierarchyKeys = new Set(hierarchyEntries.map((entry) => entry.key));
		expect(hierarchyEntries.every((entry) => entry.parentKey === null || hierarchyKeys.has(entry.parentKey))).toBe(true);
		const inverted = queryPortableProfilerCapture(session.capture, { view: "inverted-hierarchy", markerLimit: 10 });
		const invertedEntries = inverted.markers.entries as any[];
		const invertedKeys = new Set(invertedEntries.map((entry) => entry.key));
		expect(invertedEntries.every((entry) => entry.parentKey === null || invertedKeys.has(entry.parentKey))).toBe(true);
	});

	test("honors module marker gating and wall-clock duration without a render", async () => {
		const target = scene();
		const session = startPortableProfilerCapture(target, { name: "Wall clock", maximumFrames: 10, maximumDurationMs: 100, modules: ["cpu"] });
		const marker = beginPortableProfilerMarker(target, "Disabled user marker", "User");
		marker.end();
		expect(session.capture.markers).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 130));
		expect(session.capture.status).toBe("completed");
		expect(session.capture.summary.durationMs).toBeGreaterThanOrEqual(90);
		expect(session.capture.availability.physics).toMatchObject({ available: false, precision: "unavailable" });
		expect(getActivePortableProfilerCapture(target)).toBeNull();
		const retained = retainPortableProfilerCapture(createPortableProfilerState(), session.capture);
		expect(retained.captures[0].summary.durationMs).toBeGreaterThanOrEqual(90);
		const restored = parsePortableProfilerCapture(serializePortableProfilerCapture(session.capture));
		expect(restored.summary.durationMs).toBeGreaterThanOrEqual(90);
		const rendering = startPortableProfilerCapture(target, { name: "Rendering only", maximumFrames: 1, modules: ["rendering"] });
		beginPortableProfilerMarker(target, "Render pass", "Rendering").end();
		beginPortableProfilerMarker(target, "Dropped user marker", "User").end();
		target.onAfterRenderObservable.notifyObservers(target);
		expect(rendering.capture.markers).toEqual([expect.objectContaining({ name: "Render pass", category: "Rendering" })]);
	});

	test("deduplicates shared resources and avoids full memory rescans on every sampled frame", () => {
		const target = scene();
		const source = MeshBuilder.CreateBox("Shared source", {}, target);
		for (let index = 0; index < 2_000; index++) {
			source.createInstance(`Instance ${index}`);
		}
		const vertices = vi.spyOn(source, "getVerticesData");
		const session = startPortableProfilerCapture(target, { name: "Memory cadence", maximumFrames: 30, modules: ["memory"] });
		for (let index = 0; index < 30; index++) {
			target.onAfterRenderObservable.notifyObservers(target);
		}
		expect(session.capture.status).toBe("completed");
		expect(vertices.mock.calls.length).toBeGreaterThan(0);
		expect(vertices.mock.calls.length).toBeLessThan(20);
		expect(session.capture.frames).toHaveLength(30);
		vertices.mockRestore();
	});

	test("fails and disposes a capture when frame sampling throws", () => {
		const target = scene();
		const failure = vi.spyOn(target, "getActiveIndices").mockImplementation(() => {
			throw new Error("sampling exploded");
		});
		const session = startPortableProfilerCapture(target, { name: "Failure cleanup", maximumFrames: 10 });
		target.onAfterRenderObservable.notifyObservers(target);
		expect(session.capture).toMatchObject({ status: "failed", failure: "sampling exploded" });
		expect(getActivePortableProfilerCapture(target)).toBeNull();
		failure.mockRestore();
	});

	test("rolls back partial instrumentation and observers when capture setup fails", () => {
		const target = scene();
		const afterRenderObservers = target.onAfterRenderObservable.hasObservers();
		const meshObservers = target.onNewMeshAddedObservable.hasObservers();
		const failure = vi.spyOn(target.onDisposeObservable, "addOnce").mockImplementationOnce(() => {
			throw new Error("observer registration failed");
		});
		expect(() => startPortableProfilerCapture(target, { name: "Setup rollback", maximumFrames: 1 })).toThrow("observer registration failed");
		expect(getActivePortableProfilerCapture(target)).toBeNull();
		expect(target.onAfterRenderObservable.hasObservers()).toBe(afterRenderObservers);
		expect(target.onNewMeshAddedObservable.hasObservers()).toBe(meshObservers);
		failure.mockRestore();
		const next = startPortableProfilerCapture(target, { name: "Setup retry", maximumFrames: 1 });
		next.stop();
		expect(next.capture.status).toBe("completed");
	});

	test("falls back to valid failure evidence when public capture mutation breaks finalization", () => {
		const target = scene();
		const onStopped = vi.fn();
		const session = startPortableProfilerCapture(target, { id: "mutated-finalization", name: "Mutation fallback", maximumFrames: 10 }, { onStopped });
		(session.capture as any).circular = session.capture;
		(session.capture as any).id = {};
		const stopped = session.stop();
		expect(stopped).toMatchObject({ id: "mutated-finalization", status: "failed", frames: [], markers: [] });
		expect(stopped.failure).toContain("circular");
		expect(onStopped).toHaveBeenCalledWith(expect.objectContaining({ id: "mutated-finalization", status: "failed" }));
		expect(getActivePortableProfilerCapture(target)).toBeNull();
		const next = startPortableProfilerCapture(target, { name: "Next capture", maximumFrames: 1 });
		next.stop();
		expect(next.capture.status).toBe("completed");
	});

	test("rejects non-throwing invalid mutations and bounds derived limitations before publishing", () => {
		const target = scene();
		const invalid = startPortableProfilerCapture(target, { id: "invalid-number", name: "Invalid number", maximumFrames: 2 });
		target.onAfterRenderObservable.notifyObservers(target);
		expect(invalid.capture.availability).toMatchObject({ gpu: { available: false }, physics: { available: false } });
		expect(invalid.capture.frames[0]).toMatchObject({ gpuFrameTimeMs: null, cpu: { physicsTimeMs: null } });
		(invalid.capture.frames[0].cpu as any).frameTimeMs = null;
		const failed = invalid.stop();
		expect(failed).toMatchObject({ id: "invalid-number", status: "failed", frames: [] });
		expect(() => parsePortableProfilerCapture(serializePortableProfilerCapture(failed))).not.toThrow();

		const bounded = startPortableProfilerCapture(target, { name: "Bounded limitations", maximumFrames: 1, modules: ["cpu", "scripts"] });
		bounded.capture.limitations = Array.from({ length: 128 }, (_, index) => `Existing limitation ${index}`);
		const markers: any[] = [];
		for (let index = 0; index < 10_001; index++) {
			markers.push({
				id: `bounded-marker-${index}`,
				frameIndex: 0,
				name: `Marker ${index}`,
				category: "User",
				startMs: 0,
				durationMs: 1,
				depth: 0,
				parentId: null,
				thread: "main",
				objectId: null,
				objectName: null,
				scriptKey: null,
				lifecycle: null,
				error: null,
			});
		}
		bounded.capture.markers = markers;
		const completed = bounded.stop();
		expect(completed.status).toBe("completed");
		expect(completed.limitations).toHaveLength(128);
		expect(completed.limitations).toEqual(expect.arrayContaining([expect.stringContaining("10,000-row")]));
		expect(() => parsePortableProfilerCapture(serializePortableProfilerCapture(completed))).not.toThrow();
	});

	// Serializes 30,000 entries with ~30 KB names on purpose; allow for CPU contention with parallel workers.
	test("streams and byte-bounds a large Resource Timing buffer", () => {
		const target = scene();
		const base = performance.now();
		const longName = `https://assets.example/${"界".repeat(10_000)}`;
		const entries = Array.from({ length: 30_000 }, (_, index) => ({
			name: longName,
			startTime: base + index + 1,
			duration: 1,
			transferSize: 1,
			encodedBodySize: 1,
			decodedBodySize: 1,
			initiatorType: "fetch",
			nextHopProtocol: "h2",
		}));
		const resources = vi.spyOn(globalThis.performance, "getEntriesByType").mockImplementation((type) => (type === "resource" ? (entries as any) : []));
		try {
			const session = startPortableProfilerCapture(target, { name: "Large resources", maximumFrames: 2, modules: ["cpu", "assets"] });
			target.onAfterRenderObservable.notifyObservers(target);
			target.onAfterRenderObservable.notifyObservers(target);
			expect(session.capture.status).toBe("completed");
			expect(resources).toHaveBeenCalledTimes(1);
			expect(session.capture.assetEvents.length).toBeLessThan(entries.length);
			expect(session.capture.limitations).toEqual(expect.arrayContaining([expect.stringContaining("portable capture byte limit")]));
			expect(new TextEncoder().encode(serializePortableProfilerCapture(session.capture)).byteLength).toBeLessThanOrEqual(PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES);
		} finally {
			resources.mockRestore();
		}
	}, 30_000);

	test("visits an append-only Resource Timing row only once across sampled frames", () => {
		const target = scene();
		const base = performance.now();
		let nameVisits = 0;
		const entries = Array.from({ length: 1_000 }, (_, index) => ({
			get name(): string {
				nameVisits++;
				return `https://assets.example/resource-${index}.bin`;
			},
			startTime: base + index + 1,
			duration: 1,
			transferSize: 1,
			encodedBodySize: 1,
			decodedBodySize: 1,
			initiatorType: "fetch",
			nextHopProtocol: "h2",
		}));
		const resources = vi.spyOn(globalThis.performance, "getEntriesByType").mockImplementation((type) => (type === "resource" ? (entries as any) : []));
		try {
			const session = startPortableProfilerCapture(target, { name: "Resource cursor", maximumFrames: 2, modules: ["cpu", "assets"] });
			target.onAfterRenderObservable.notifyObservers(target);
			const firstVisits = nameVisits;
			target.onAfterRenderObservable.notifyObservers(target);
			expect(session.capture.status).toBe("completed");
			expect(resources).toHaveBeenCalledTimes(2);
			expect(firstVisits).toBe(entries.length);
			// The second sample may read the single boundary row to detect clear/replacement, but it must not revisit the full buffer.
			expect(nameVisits - firstVisits).toBeLessThanOrEqual(1);
		} finally {
			resources.mockRestore();
		}
	});

	test("detects same-length Resource Timing buffer replacement", () => {
		const target = scene();
		const base = performance.now();
		const makeEntries = (prefix: string, offset: number): any[] =>
			Array.from({ length: 8 }, (_, index) => ({
				name: `https://assets.example/${prefix}-${index}.bin`,
				startTime: base + offset + index,
				duration: 1,
				transferSize: 1,
				encodedBodySize: 1,
				decodedBodySize: 1,
				initiatorType: "fetch",
				nextHopProtocol: "h2",
			}));
		let entries = makeEntries("before-clear", 1);
		const resources = vi.spyOn(globalThis.performance, "getEntriesByType").mockImplementation((type) => (type === "resource" ? entries : []));
		try {
			const session = startPortableProfilerCapture(target, { name: "Resource replacement", maximumFrames: 2, modules: ["cpu", "assets"] });
			target.onAfterRenderObservable.notifyObservers(target);
			entries = makeEntries("after-clear", 100);
			target.onAfterRenderObservable.notifyObservers(target);
			expect(session.capture.assetEvents).toHaveLength(16);
			expect(session.capture.frames.map((frame) => frame.assets?.completedRequests)).toEqual([8, 8]);
		} finally {
			resources.mockRestore();
		}
	});

	test("profiles attached script lifecycle methods", () => {
		const target = scene();
		const mesh = MeshBuilder.CreateBox("Scripted", {}, target);
		class Script {
			public onStart(): void {}
			public onUpdate(): void {}
			public onStop(): void {}
		}
		applyScriptOnObject(mesh, Script, target);
		const session = startPortableProfilerCapture(target, { name: "Scripts", maximumFrames: 1, modules: ["cpu", "scripts"] });
		target.render();
		expect(session.capture.markers.map((marker) => marker.name)).toEqual(expect.arrayContaining(["runtime.onStart", "runtime.onUpdate"]));
		expect(session.capture.frames[0].cpu?.scriptCalls).toBe(2);

		const sampled = startPortableProfilerCapture(target, { name: "Sampled scripts", maximumFrames: 10, sampleEveryFrames: 2, modules: ["cpu", "scripts"] });
		target.render();
		target.render();
		target.render();
		const completed = sampled.stop();
		expect(completed).toMatchObject({ status: "completed", frames: [expect.objectContaining({ index: 0 })] });
		expect(completed.frames[0].cpu?.scriptCalls).toBe(completed.markers.filter((marker) => marker.category === "Scripts").length);
		expect(() => parsePortableProfilerCapture(serializePortableProfilerCapture(completed))).not.toThrow();
	});

	test("captures memory growth and round-trips a retained capture", () => {
		const target = scene();
		const baseline = capturePortableProfilerMemorySnapshot(target, "Before");
		MeshBuilder.CreateSphere("Added", { segments: 8 }, target);
		const current = capturePortableProfilerMemorySnapshot(target, "After");
		const comparison = comparePortableProfilerMemorySnapshots(baseline, current);
		expect(comparison.countDelta.meshes).toBe(1);
		expect(comparison.metricDelta.estimatedGeometryBytes).toBeGreaterThan(0);

		const session = startPortableProfilerCapture(target, { name: "Portable", maximumFrames: 2 });
		const marker = beginPortableProfilerMarker(target, "Portable marker", "User");
		marker.end();
		session.capture.memorySnapshots.push(capturePortableProfilerMemorySnapshot(target, "Inside capture", session.capture.id, 0));
		target.render();
		session.stop();
		const serialized = serializePortableProfilerCapture(session.capture);
		expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(PORTABLE_PROFILER_MAXIMUM_CAPTURE_BYTES);
		const restored = parsePortableProfilerCapture(serialized);
		const state = retainPortableProfilerCapture(createPortableProfilerState(), restored);
		expect(state.revision).toBe(2);
		expect(state.captures[0].summary.frames).toBe(1);

		const missingMarkers = JSON.parse(serialized);
		delete missingMarkers.markers;
		expect(() => parsePortableProfilerCapture(JSON.stringify(missingMarkers))).toThrow("invalid");
		const tooManySnapshots = JSON.parse(serialized);
		tooManySnapshots.memorySnapshots = new Array(PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS + 1).fill(current);
		expect(() => parsePortableProfilerCapture(JSON.stringify(tooManySnapshots))).toThrow("invalid");

		const rejects = (mutate: (capture: any) => void): void => {
			const capture = JSON.parse(serialized);
			mutate(capture);
			expect(() => parsePortableProfilerCapture(JSON.stringify(capture))).toThrow("invalid");
		};
		rejects((capture) => (capture.unknown = true));
		for (const key of ["modules", "frames", "markers", "assetEvents", "memorySnapshots"] as const) {
			rejects((capture) => (capture[key] = new Array(1)));
		}
		rejects((capture) => (capture.summary.markers = new Array(1)));
		rejects((capture) => (capture.limitations = new Array(1)));
		rejects((capture) => (capture.availability.cpu.unknown = true));
		rejects((capture) => {
			capture.availability.cpu.available = false;
			capture.availability.cpu.precision = "exact";
		});
		rejects((capture) => (capture.availability.cpu.precision = "unavailable"));
		rejects((capture) => {
			capture.modules = ["cpu"];
			capture.frames[0].rendering = JSON.parse(serialized).frames[0].rendering;
		});
		rejects((capture) => {
			capture.modules = ["rendering"];
			capture.frames[0].cpu = JSON.parse(serialized).frames[0].cpu;
		});
		rejects((capture) => {
			capture.modules = ["cpu"];
			capture.frames[0].gpuFrameTimeMs = 1;
		});
		rejects((capture) => (capture.modules = capture.modules.filter((module: string) => module !== "scripts")));
		rejects((capture) => {
			capture.modules = capture.modules.filter((module: string) => module !== "scripts");
			capture.markers = [];
			capture.frames[0].cpu.scriptCalls = 1;
		});
		rejects((capture) => delete capture.frames[0].cpu.frameTimeMs);
		rejects((capture) => (capture.frames[0].cpu.frameTimeMs = null));
		rejects((capture) => (capture.frames[0].cpu.unknownMetric = 1));
		rejects((capture) => (capture.frames[0].rendering.drawCalls = null));
		rejects((capture) => (capture.frames[0].memory.estimatedSceneBytes = null));
		rejects((capture) => (capture.frames[0].assets.completedRequests = null));
		rejects((capture) => (capture.frames[0].audio.soundCount = null));
		rejects((capture) => (capture.frames[0].rendering.drawCalls = 1.5));
		rejects((capture) => (capture.frames[0].audio.soundCount = 0.25));
		rejects((capture) => (capture.frames[0].memory.sceneObjectCount = 2.7));
		rejects((capture) => (capture.frames[0].memory.gcEvents = 0.5));
		rejects((capture) => (capture.memorySnapshots[0].counts.meshes = 1.1));
		rejects((capture) => (capture.startedAt = ""));
		rejects((capture) => (capture.frames[0].capturedAt = "not-a-date"));
		rejects((capture) => (capture.memorySnapshots[0].capturedAt = "2026-02-30T00:00:00.000Z"));
		rejects((capture) => (capture.finishedAt = "2000-01-01T00:00:00.000Z"));
		rejects((capture) => {
			capture.frames[0].elapsedMs = 100;
			capture.frames.push({ ...capture.frames[0], index: 1, elapsedMs: 1 });
		});
		rejects((capture) => {
			capture.frames[0].cpu.scriptCalls = 1;
			capture.frames[0].cpu.scriptTimeMs = 1;
		});
		rejects((capture) => (capture.frames[0].assets.completedRequests = 1));
		rejects((capture) => (capture.frames[0].index = 4));
		rejects((capture) => (capture.markers[0].objectName = {}));
		rejects((capture) => (capture.markers[0].objectName = "x".repeat(241)));
		rejects((capture) => capture.markers.push({ ...capture.markers[0] }));
		rejects((capture) => {
			capture.markers[0].parentId = capture.markers[0].id;
			capture.markers[0].depth = 1;
		});
		rejects((capture) => (capture.markers[0].frameIndex = capture.frames.length));
		rejects((capture) => {
			const event = {
				id: "asset-duplicate",
				frameIndex: 0,
				name: "asset.glb",
				initiatorType: "fetch",
				startMs: 0,
				durationMs: 1,
				transferBytes: 1,
				encodedBodyBytes: 1,
				decodedBodyBytes: 1,
				protocol: "h2",
				availability: { available: true, precision: "browser-counter", reason: null },
			};
			capture.assetEvents = [event, { ...event }];
		});
		rejects((capture) => (capture.memorySnapshots[0].captureId = "another-capture"));
		rejects((capture) => (capture.memorySnapshots[0].metrics.estimatedSceneBytes = null));
		rejects((capture) => capture.memorySnapshots.push({ ...capture.memorySnapshots[0] }));
		rejects((capture) => (capture.finishedAt = null));
		rejects((capture) => {
			capture.status = "recording";
			capture.finishedAt = new Date().toISOString();
		});
		rejects((capture) => {
			capture.status = "failed";
			capture.failure = null;
		});
		const recording = JSON.parse(serialized);
		recording.status = "recording";
		recording.finishedAt = null;
		recording.failure = null;
		const closedRecording = parsePortableProfilerCapture(JSON.stringify(recording));
		expect(closedRecording).toMatchObject({ status: "canceled", finishedAt: expect.any(String), failure: expect.stringContaining("persistence boundary") });

		const staleSummary = JSON.parse(serialized);
		staleSummary.summary.frames = 999;
		const normalized = normalizePortableProfilerState({
			version: 1,
			revision: 3,
			maximumRetainedCaptures: 100,
			maximumRetainedSnapshots: 200,
			captures: [staleSummary, staleSummary],
			memorySnapshots: [],
		});
		expect(normalized.captures).toHaveLength(1);
		expect(normalized.captures[0].summary.frames).toBe(1);
		expect(normalized.maximumRetainedCaptures).toBe(20);
		expect(normalized.maximumRetainedSnapshots).toBe(40);
		const candidateBound = normalizePortableProfilerState({
			...createPortableProfilerState(),
			captures: [...new Array(100).fill({ version: 1 }), restored],
			memorySnapshots: [...new Array(200).fill({ id: "invalid" }), baseline],
		});
		expect(candidateBound.captures).toEqual([]);
		expect(candidateBound.memorySnapshots).toEqual([]);
		const sparseFrames: any[] = [];
		sparseFrames.length = 4_000_000_000;
		const sparseLimitations: any[] = [];
		sparseLimitations.length = 4_000_000_000;
		expect(normalizePortableProfilerState({ ...createPortableProfilerState(), captures: [{ ...restored, frames: sparseFrames }] }).captures).toEqual([]);
		expect(normalizePortableProfilerState({ ...createPortableProfilerState(), memorySnapshots: [{ ...baseline, limitations: sparseLimitations }] }).memorySnapshots).toEqual(
			[]
		);
		expect(() => retainPortableProfilerMemorySnapshot(createPortableProfilerState(), { ...baseline, counts: new Map([["meshes", 1]]) } as any)).toThrow("invalid");
		expect(() => serializePortableProfilerCapture({ ...restored, limitations: new Array(1) })).toThrow("structurally invalid");

		const large = structuredClone(restored);
		large.maximumFrames = 512;
		large.frames = Array.from({ length: 512 }, (_, index) => ({
			...structuredClone(restored.frames[0]),
			index,
			elapsedMs: restored.frames[0].elapsedMs + index,
		}));
		large.markers = Array.from({ length: 4_096 }, (_, index) => ({
			...structuredClone(restored.markers[0]),
			id: `large-marker-${index}`,
			frameIndex: index % large.frames.length,
			parentId: null,
			depth: 0,
		}));
		large.memorySnapshots = [];
		const filterCalls = vi.spyOn(Array.prototype, "filter");
		expect(() => retainPortableProfilerCapture(createPortableProfilerState(), large)).not.toThrow();
		const relationFilterCalls = filterCalls.mock.calls.length;
		filterCalls.mockRestore();
		expect(relationFilterCalls).toBeLessThan(20);

		const overflowBase = JSON.parse(serialized);
		const summary = { frames: 2, durationMs: 2, metrics: {}, markers: [], assetRequests: 0, assetTransferBytes: null };
		const cpuOverflow = {
			...overflowBase,
			modules: ["cpu"],
			maximumFrames: 2,
			frames: [0, 1].map((index) => ({
				...structuredClone(overflowBase.frames[0]),
				index,
				elapsedMs: index + 1,
				cpu: { ...structuredClone(overflowBase.frames[0].cpu), frameTimeMs: Number.MAX_VALUE, scriptTimeMs: 0, scriptCalls: 0, scriptErrors: 0 },
				gpuFrameTimeMs: null,
				rendering: null,
				memory: null,
				assets: null,
				audio: null,
			})),
			markers: [],
			assetEvents: [],
			memorySnapshots: [],
			summary,
		};
		const stableMaximum = parsePortableProfilerCapture(JSON.stringify(cpuOverflow));
		expect(stableMaximum.summary.metrics["cpu.frameTimeMs"].average).toBe(Number.MAX_VALUE);
		expect(() => parsePortableProfilerCapture(serializePortableProfilerCapture(stableMaximum))).not.toThrow();

		const markerOverflow = {
			...structuredClone(cpuOverflow),
			modules: ["cpu", "scripts"],
			markers: [0, 1].map((index) => ({
				...structuredClone(overflowBase.markers[0]),
				id: `overflow-marker-${index}`,
				frameIndex: index,
				name: "Overflow marker",
				durationMs: Number.MAX_VALUE,
				parentId: null,
				depth: 0,
			})),
		};
		expect(() => parsePortableProfilerCapture(JSON.stringify(markerOverflow))).toThrow("derived summary");

		const assetOverflow = {
			...structuredClone(cpuOverflow),
			modules: ["assets"],
			frames: [0, 1].map((index) => ({
				...structuredClone(cpuOverflow.frames[index]),
				cpu: null,
				assets: { completedRequests: 1, durationMs: 1, transferBytes: Number.MAX_VALUE, decodedBodyBytes: null },
			})),
			assetEvents: [0, 1].map((index) => ({
				id: `overflow-asset-${index}`,
				frameIndex: index,
				name: `asset-${index}.bin`,
				initiatorType: "fetch",
				startMs: index,
				durationMs: 1,
				transferBytes: Number.MAX_VALUE,
				encodedBodyBytes: null,
				decodedBodyBytes: null,
				protocol: null,
				availability: { available: true, precision: "browser-counter", reason: null },
			})),
		};
		expect(() => parsePortableProfilerCapture(JSON.stringify(assetOverflow))).toThrow("derived summary");

		let snapshots = { ...createPortableProfilerState(), maximumRetainedSnapshots: 2 };
		snapshots = retainPortableProfilerMemorySnapshot(snapshots, baseline);
		snapshots = retainPortableProfilerMemorySnapshot(snapshots, current);
		const newest = { ...current, id: "newest-memory", name: "Newest" };
		snapshots = retainPortableProfilerMemorySnapshot(snapshots, newest);
		expect(snapshots.memorySnapshots.map((snapshot) => snapshot.id)).toEqual(["newest-memory", current.id]);
	});

	test("bounds actual inverted-hierarchy entry visits for repeated maximum-depth leaves", () => {
		const target = scene();
		const session = startPortableProfilerCapture(target, { name: "Deep hierarchy", maximumFrames: 1, modules: ["cpu", "scripts"] });
		target.onAfterRenderObservable.notifyObservers(target);
		const markers: any[] = [];
		for (let depth = 0; depth < 127; depth++) {
			markers.push({
				id: `ancestor-${depth}`,
				frameIndex: 0,
				name: `Ancestor ${depth}`,
				category: "User",
				startMs: 0,
				durationMs: 1,
				depth,
				parentId: depth ? `ancestor-${depth - 1}` : null,
				thread: "main",
				objectId: null,
				objectName: null,
				scriptKey: null,
				lifecycle: null,
				error: null,
			});
		}
		for (let index = 0; index < 300; index++) {
			markers.push({ ...markers.at(-1), id: `leaf-${index}`, name: "Repeated leaf", depth: 127, parentId: "ancestor-126" });
		}
		session.capture.markers = markers;
		const hierarchy = queryPortableProfilerCapture(session.capture, { view: "inverted-hierarchy", markerLimit: 2_000 });
		expect(hierarchy.markers.total).toBeLessThanOrEqual(10_000);
		expect(hierarchy.capture.limitations).toEqual(expect.arrayContaining([expect.stringContaining("2,000,000-visit ceiling")]));
	});

	test("bounds intermediate hierarchy rows before paging", () => {
		const target = scene();
		const session = startPortableProfilerCapture(target, { name: "Hierarchy ceiling", maximumFrames: 1, modules: ["cpu", "scripts"] });
		for (let index = 0; index < 10_001; index++) {
			beginPortableProfilerMarker(target, `Marker ${index}`, "User").end();
		}
		target.render();
		const hierarchy = queryPortableProfilerCapture(session.capture, { view: "inverted-hierarchy", markerLimit: 2_000 });
		expect(hierarchy.markers).toMatchObject({ total: 10_000, offset: 0, limit: 2_000 });
		expect(hierarchy.capture.summary.markers).toEqual([]);
		expect(hierarchy.capture.limitations).toEqual(expect.arrayContaining([expect.stringContaining("10,000-row")]));
	});
});
