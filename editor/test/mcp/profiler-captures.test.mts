import { access, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MeshBuilder, NullEngine, Scene } from "babylonjs";
import { beginPortableProfilerMarker } from "babylonjs-editor-tools";

import {
	captureProfilerSnapshot,
	compareProfilerSnapshots,
	deleteProfilerCapture,
	deleteProfilerSnapshot,
	exportProfilerCapture,
	getProfilerCapabilities,
	getProfilerCapture,
	getProfiler2DState,
	getProfilerState,
	importProfilerCapture,
	listProfilerCaptures,
	startProfilerCapture,
	stopProfilerCapture,
} from "../../src/mcp/editor";
import { projectConfiguration } from "../../src/project/configuration";
import { profilingState } from "../../src/mcp/profiling/state";

describe("mcp/profiling", () => {
	let engine: NullEngine;
	let scene: Scene;
	const forceUpdate = vi.fn();
	const options = {
		editor: {
			layout: {
				inspector: { forceUpdate },
				profiler: { forceUpdate },
				preview: { play: { state: { playing: false, preparingPlay: false, loading: false }, canPlayScene: false, scene: null, stop: vi.fn() } },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("records, pages, summarizes, and exactly deletes a bounded Edit capture", async () => {
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		expect(getProfilerCapabilities()).toMatchObject({
			version: 2,
			targets: ["editor-edit", "editor-play", "connected-player"],
			modules: expect.arrayContaining(["2d"]),
			views: expect.arrayContaining(["2d-atlas"]),
			bounds: { maximum2DUsageRecords: 65_536 },
		});
		const initial = getProfilerState(scene);
		const started = await startProfilerCapture(
			scene,
			{
				expectedRevision: initial.revision,
				name: "Gameplay",
				target: "editor-edit",
				maximumFrames: 3,
				maximumDurationMs: 10_000,
				modules: ["cpu", "rendering", "memory", "scripts"],
			},
			options
		);
		expect(started).toMatchObject({ revision: initial.revision + 1, active: { name: "Gameplay", target: "editor-edit", status: "recording" } });
		beginPortableProfilerMarker(scene, "State marker", "User").end();
		scene.onAfterRenderObservable.notifyObservers(scene);
		scene.onAfterRenderObservable.notifyObservers(scene);
		const stopped = await stopProfilerCapture(scene, { expectedRevision: started.revision, id: started.active.id, confirm: true }, options);
		expect(stopped).toMatchObject({ active: null, capture: { frameCount: 2, status: "completed" } });
		await expect(startProfilerCapture(scene, { expectedRevision: stopped.revision, id: started.active.id, name: "Duplicate", target: "editor-edit" }, options)).rejects.toThrow(
			"already exists"
		);

		const compactState = getProfilerState(scene);
		expect(compactState.captures[0].summary.markers).toEqual([]);
		expect(listProfilerCaptures(scene).captures[0].summary.markers).toEqual([]);
		const detail = getProfilerCapture(scene, { id: started.active.id, frameLimit: 1, view: "hierarchy" });
		expect(detail.frames).toMatchObject({ total: 2, limit: 1, entries: [expect.objectContaining({ gpuFrameTimeMs: null })] });
		expect(detail.capture.summary.markers).toEqual([]);
		expect(detail.markers.total).toBe(1);
		expect(detail.capture.summary.metrics["cpu.frameTimeMs"]).toMatchObject({ minimum: 16, maximum: 16, average: 16, samples: 2 });
		expect(listProfilerCaptures(scene).captures).toEqual([expect.objectContaining({ id: started.active.id, name: "Gameplay", frameCount: 2 })]);

		await expect(startProfilerCapture(scene, { expectedRevision: initial.revision, name: "Stale" }, options)).rejects.toThrow("stale or missing expectedRevision");
		const revision = getProfilerState(scene).revision;
		expect(deleteProfilerCapture(scene, { expectedRevision: revision, id: started.active.id, confirm: true }, options)).toMatchObject({
			deleted: true,
			id: started.active.id,
			revision: revision + 1,
		});
	});

	test("inspects live 2D atlases and retained aggregate frames", async () => {
		(scene as any).spriteManagers = [
			{
				name: "Characters",
				texture: { name: "characters.png", getSize: () => ({ width: 128, height: 64 }) },
				cellWidth: 32,
				cellHeight: 32,
				sprites: [{ cellIndex: 2, isVisible: true }],
				dispose: () => undefined,
			},
		];
		const live = getProfiler2DState(scene);
		expect(live).toMatchObject({
			source: "editor-edit",
			available: true,
			snapshot: { metrics: { atlasOwners: 1, definedRegions: 8, usedRegions: 1 }, atlases: [expect.objectContaining({ name: "Characters" })] },
		});

		const initial = getProfilerState(scene);
		const started = await startProfilerCapture(scene, { expectedRevision: initial.revision, id: "2d-capture", name: "2D", modules: ["2d"], maximumFrames: 1 }, options);
		scene.onAfterRenderObservable.notifyObservers(scene);
		const retained = getProfiler2DState(scene, { captureId: started.active.id, frameIndex: 0 });
		expect(retained).toMatchObject({ source: "retained-capture", detailed: false, frame: { index: 0, metrics: { usedRegions: 1 } } });
		expect(() => getProfiler2DState(scene, { captureId: started.active.id, frameIndex: 1 })).toThrow("outside capture");
	});

	test("rejects malformed persisted captures without crashing state reads", () => {
		scene.metadata = {
			babylonEditorProfilerState: {
				version: 1,
				revision: 7,
				maximumRetainedCaptures: 20,
				maximumRetainedSnapshots: 40,
				captures: [{ version: 1, id: "broken" }],
				memorySnapshots: [{ id: "broken-memory" }],
			},
		};
		expect(getProfilerState(scene)).toMatchObject({ revision: 7, captures: [], memorySnapshots: [] });
	});

	test("reuses canonical validated state until scene metadata identity changes", () => {
		const canonical = profilingState(scene);
		expect(profilingState(scene)).toBe(canonical);
		expect(Object.isFrozen(canonical)).toBe(true);
		expect(Object.isFrozen(canonical.captures)).toBe(true);
		expect(() => (canonical.captures as any[]).push({ id: "in-place-invalid" })).toThrow();
		expect(profilingState(scene)).toBe(canonical);
		scene.metadata.babylonEditorProfilerState = { version: 1, revision: 9, captures: [{ id: "invalid" }] };
		const replaced = profilingState(scene);
		expect(replaced).not.toBe(canonical);
		expect(replaced).toMatchObject({ revision: 9, captures: [] });
	});

	test("cleans up an active run when its completion id becomes occupied", async () => {
		let state = getProfilerState(scene);
		const base = await startProfilerCapture(scene, { expectedRevision: state.revision, id: "collision-base", name: "Base", target: "editor-edit" }, options);
		await stopProfilerCapture(scene, { expectedRevision: base.revision, id: base.active.id, confirm: true }, options);
		state = getProfilerState(scene);
		const active = await startProfilerCapture(scene, { expectedRevision: state.revision, id: "collision-active", name: "Active", target: "editor-edit" }, options);
		const persisted = scene.metadata.babylonEditorProfilerState;
		const occupied = { ...structuredClone(persisted.captures[0]), id: active.active.id, name: "Occupied" };
		scene.metadata.babylonEditorProfilerState = { ...persisted, captures: [occupied, ...persisted.captures] };

		await expect(stopProfilerCapture(scene, { expectedRevision: active.revision, id: active.active.id, confirm: true }, options)).rejects.toThrow("became occupied");
		expect(getProfilerState(scene).active).toBeNull();
	});

	test("keeps profiler exports inside the real project directory", async () => {
		const projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-profiler-project-"));
		const outsideDirectory = await mkdtemp(join(tmpdir(), "zvibe-profiler-outside-"));
		const previousPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}\n");
		try {
			const initial = getProfilerState(scene);
			await mkdir(join(projectDirectory, "directory.json"));
			await expect(importProfilerCapture(scene, { expectedRevision: initial.revision, path: ".", confirm: true }, options)).rejects.toThrow("regular file");
			const oversized = await open(join(projectDirectory, "oversized.json"), "w");
			await oversized.truncate(50 * 1024 * 1024 + 1);
			await oversized.close();
			await expect(importProfilerCapture(scene, { expectedRevision: initial.revision, path: "oversized.json", confirm: true }, options)).rejects.toThrow("50 MiB");
			const started = await startProfilerCapture(
				scene,
				{ expectedRevision: initial.revision, id: "path-profile", name: "Path", target: "editor-edit", maximumFrames: 1 },
				options
			);
			scene.onAfterRenderObservable.notifyObservers(scene);
			const revision = getProfilerState(scene).revision;
			if (getProfilerState(scene).active) {
				await stopProfilerCapture(scene, { expectedRevision: revision, id: started.active.id, confirm: true }, options);
			}
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: "../escaped.json", confirm: true })).rejects.toThrow("inside the open project");
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: "directory.json", confirm: true })).rejects.toThrow("regular file");
			await symlink(outsideDirectory, join(projectDirectory, "linked-outside"));
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: "linked-outside/escaped.json", confirm: true })).rejects.toThrow("inside the open project");
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: "linked-outside/new-directory/escaped.json", confirm: true })).rejects.toThrow(
				"inside the open project"
			);
			await expect(access(join(outsideDirectory, "new-directory"))).rejects.toThrow();
			await writeFile(join(projectDirectory, "package.json"), '{"preserved":true}\n');
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: "package.json" })).rejects.toThrow("confirm=true");
			expect(await readFile(join(projectDirectory, "package.json"), "utf8")).toBe('{"preserved":true}\n');
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: ".bjseditor/unconfirmed/new.json" })).rejects.toThrow("confirm=true");
			await expect(access(join(projectDirectory, ".bjseditor/unconfirmed"))).rejects.toThrow();
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: ".bjseditor/profiler/safe.json", confirm: true })).resolves.toMatchObject({ exported: true });
			const safePath = join(projectDirectory, ".bjseditor/profiler/safe.json");
			const preserved = await readFile(safePath, "utf8");
			const probe = await open(safePath, "r");
			const fileHandlePrototype = Object.getPrototypeOf(probe);
			await probe.close();
			const failedWrite = vi.spyOn(fileHandlePrototype, "writeFile").mockRejectedValueOnce(new Error("simulated write failure"));
			await expect(exportProfilerCapture(scene, { id: "path-profile", path: ".bjseditor/profiler/safe.json", confirm: true })).rejects.toThrow("simulated write failure");
			failedWrite.mockRestore();
			expect(await readFile(safePath, "utf8")).toBe(preserved);
			let state = getProfilerState(scene);
			deleteProfilerCapture(scene, { expectedRevision: state.revision, id: "path-profile", confirm: true }, options);
			state = getProfilerState(scene);
			const active = await startProfilerCapture(
				scene,
				{ expectedRevision: state.revision, id: "path-profile", name: "Active collision", target: "editor-edit", maximumFrames: 10 },
				options
			);
			await expect(importProfilerCapture(scene, { expectedRevision: active.revision, path: ".bjseditor/profiler/safe.json", confirm: true }, options)).rejects.toThrow(
				"active run"
			);
			await stopProfilerCapture(scene, { expectedRevision: active.revision, id: "path-profile", confirm: true }, options);
		} finally {
			projectConfiguration.path = previousPath;
			await rm(projectDirectory, { recursive: true, force: true });
			await rm(outsideDirectory, { recursive: true, force: true });
		}
	});

	test("captures and compares memory snapshots with honest estimates", async () => {
		let state = getProfilerState(scene);
		const before = await captureProfilerSnapshot(scene, { expectedRevision: state.revision, name: "Before" }, options);
		MeshBuilder.CreateBox("Added", {}, scene);
		state = getProfilerState(scene);
		const after = await captureProfilerSnapshot(scene, { expectedRevision: state.revision, name: "After" }, options);
		const comparison = compareProfilerSnapshots(scene, { baseline: before.snapshot.id, current: after.snapshot.id });
		expect(comparison.comparison.countDelta.meshes).toBe(1);
		expect(comparison.comparison.metricDelta.estimatedGeometryBytes).toBeGreaterThan(0);
		expect(after.snapshot.limitations).toEqual(expect.arrayContaining([expect.stringContaining("GPU residency")]));
	});

	test("restores embedded capture snapshots into the editor-visible standalone list on import", async () => {
		const projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-profiler-import-"));
		const previousPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}\n");
		try {
			let state = getProfilerState(scene);
			const active = await startProfilerCapture(scene, { expectedRevision: state.revision, id: "snapshot-import", name: "Snapshot import", target: "editor-edit" }, options);
			const memory = await captureProfilerSnapshot(scene, { expectedRevision: active.revision, name: "Imported memory" }, options);
			await stopProfilerCapture(scene, { expectedRevision: memory.revision, id: active.active.id, confirm: true }, options);
			await exportProfilerCapture(scene, { id: active.active.id, path: ".bjseditor/profiler/snapshot-import.json", confirm: true });
			state = getProfilerState(scene);
			deleteProfilerCapture(scene, { expectedRevision: state.revision, id: active.active.id, confirm: true }, options);
			state = getProfilerState(scene);
			deleteProfilerSnapshot(scene, { expectedRevision: state.revision, id: memory.snapshot.id, confirm: true }, options);
			state = getProfilerState(scene);
			const imported = await importProfilerCapture(scene, { expectedRevision: state.revision, path: ".bjseditor/profiler/snapshot-import.json", confirm: true }, options);
			expect(imported).toMatchObject({ imported: true, importedMemorySnapshots: 1, droppedMemorySnapshots: 0 });
			expect(getProfilerState(scene).memorySnapshots).toEqual([expect.objectContaining({ name: "Imported memory" })]);
			expect(getProfilerCapture(scene, { id: active.active.id }).memorySnapshots).toMatchObject({
				total: 1,
				entries: [expect.objectContaining({ captureId: active.active.id })],
			});
		} finally {
			projectConfiguration.path = previousPath;
			await rm(projectDirectory, { recursive: true, force: true });
		}
	});

	test("profiles the real Play scene and stops only Play sessions it started", async () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		const play = {
			state: { playing: false, preparingPlay: false, loading: false },
			canPlayScene: false,
			scene: playScene,
			play: vi.fn(async function (this: any): Promise<void> {
				this.state.playing = true;
				this.canPlayScene = true;
			}),
			stop: vi.fn(),
		};
		options.editor.layout.preview.play = play;
		try {
			const initial = getProfilerState(scene);
			const started = await startProfilerCapture(
				scene,
				{ expectedRevision: initial.revision, name: "Play", target: "editor-play", maximumFrames: 10, maximumDurationMs: 10_000 },
				options
			);
			playScene.onAfterRenderObservable.notifyObservers(playScene);
			await stopProfilerCapture(scene, { expectedRevision: started.revision, id: started.active.id, confirm: true }, options);
			expect(play.play).toHaveBeenCalledOnce();
			expect(play.stop).toHaveBeenCalledOnce();
			expect(getProfilerState(scene).captures[0]).toMatchObject({ target: "editor-play", frameCount: 1 });
		} finally {
			playScene.dispose();
			playEngine.dispose();
		}
	});

	test("rejects concurrent retained-evidence mutation while asynchronous Play startup owns the lane", async () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		let releasePlay: (() => void) | null = null;
		const play = {
			state: { playing: false, preparingPlay: true, loading: false },
			canPlayScene: false,
			scene: playScene,
			play: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						releasePlay = (): void => {
							play.state.playing = true;
							play.state.preparingPlay = false;
							play.canPlayScene = true;
							resolve();
						};
					})
			),
			stop: vi.fn(),
		};
		options.editor.layout.preview.play = play;
		try {
			const initial = getProfilerState(scene);
			const pending = startProfilerCapture(scene, { expectedRevision: initial.revision, name: "Pending Play", target: "editor-play" }, options);
			await vi.waitFor(() => expect(releasePlay).toBeTypeOf("function"));
			const preparing = getProfilerState(scene);
			expect(() => deleteProfilerCapture(scene, { expectedRevision: preparing.revision, id: "anything", confirm: true }, options)).toThrow("asynchronous profiler mutation");
			releasePlay!();
			const started = await pending;
			await stopProfilerCapture(scene, { expectedRevision: started.revision, id: started.active.id, confirm: true }, options);
		} finally {
			playScene.dispose();
			playEngine.dispose();
		}
	});

	test("migrates legacy flat captures and snapshots once", () => {
		scene.metadata = {
			babylonEditorProfilerCaptures: [
				{
					id: "legacy-capture",
					name: "Legacy",
					startedAt: "2026-01-01T00:00:00.000Z",
					stoppedAt: "2026-01-01T00:00:01.000Z",
					sampleIntervalMs: 100,
					maxSamples: 2,
					samples: [{ capturedAt: "2026-01-01T00:00:00.100Z", metrics: { frameTimeMs: 12, drawCalls: 5, meshes: 1 } }],
				},
			],
			babylonEditorProfilerSnapshots: [{ id: "legacy-memory", name: "Legacy memory", capturedAt: "2026-01-01T00:00:00.000Z", metrics: { meshes: 1, textures: 2 } }],
		};
		const state = getProfilerState(scene);
		expect(state.captures[0]).toMatchObject({ id: "legacy-capture", frameCount: 1, status: "completed" });
		expect(state.memorySnapshots[0]).toMatchObject({ id: "legacy-memory", counts: { meshes: 1, textures: 2 } });
	});

	test("bounds legacy migration candidates before converting captures and snapshots", () => {
		scene.metadata = {
			babylonEditorProfilerCaptures: [
				...new Array(100).fill({ invalid: true }),
				{ id: "outside-capture-bound", name: "Outside", samples: new Array(36_000).fill({ metrics: { frameTimeMs: 1 } }) },
			],
			babylonEditorProfilerSnapshots: [...new Array(200).fill({ invalid: true }), { id: "outside-snapshot-bound", name: "Outside", metrics: {} }],
		};
		expect(getProfilerState(scene)).toMatchObject({ captures: [], memorySnapshots: [] });
	});
});
