import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import {
	cancelAssetStreamingRequest,
	getAssetStreamingCapabilities,
	getAssetStreamingRuntime,
	prepareAssetStreamingRuntime,
	resetAssetStreamingRuntime,
	shutdownAssetStreamingRuntime,
	startAssetStreamingFileProbe,
} from "../../src/mcp/project/asset-streaming";
import { createBuildProfile, getBuildProfileAssetStreamingPlan, getBuildProfileEnvironment, listBuildProfiles, setBuildProfile } from "../../src/mcp/project/export";

async function waitForTerminal(scene: Scene, requestId: string): Promise<any> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const status = getAssetStreamingRuntime(scene);
		const job = status.jobs.find((candidate: any) => candidate.requestId === requestId);
		if (job && ["completed", "cancelled", "timed-out", "failed"].includes(job.status)) return { status, job };
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Asset streaming job did not finish: ${requestId}`);
}

describe("mcp/asset streaming", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let options: any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-asset-streaming-"));
		await mkdir(join(projectDirectory, "assets"), { recursive: true });
		await mkdir(join(projectDirectory, "public", "scene"), { recursive: true });
		await writeFile(join(projectDirectory, "assets", "probe.bin"), Buffer.from("streamed-zvibe-asset"));
		options = { editor: { state: { projectPath: join(projectDirectory, "Game.bjseditor"), sceneBuildSettings: {}, projectSettings: {} } } };
	});

	afterEach(async () => {
		shutdownAssetStreamingRuntime(scene);
		scene.dispose();
		engine.dispose();
		await rm(projectDirectory, { recursive: true, force: true });
	});

	test("persists disabled defaults and projects exact Windows settings into the build environment", () => {
		const created = createBuildProfile(scene, { expectedRevision: 0, id: "windows", name: "Windows", target: "electron", settings: { electronPlatform: "win32" } });
		expect(created.profile.settings.assetStreaming).toMatchObject({ version: 1, windows: { enableDirectStorage: false, maximumConcurrentReads: 8 } });
		const updated = setBuildProfile(scene, {
			expectedRevision: 1,
			id: "windows",
			settings: {
				electronPlatform: "win32",
				assetStreaming: { windows: { enableDirectStorage: true, maximumConcurrentReads: 4, maximumQueuedRequests: 32, chunkSizeBytes: 65_536 } },
			},
		});
		expect(updated.configuration.revision).toBe(2);
		expect(getBuildProfileAssetStreamingPlan(scene, { id: "windows" })).toMatchObject({
			configurationRevision: 2,
			plan: { enabled: true, backend: "electron-asynchronous-file-streams", settings: { windows: { maximumConcurrentReads: 4, maximumQueuedRequests: 32 } } },
		});
		const environment = getBuildProfileEnvironment(scene, { id: "windows" }, options).environment;
		expect(JSON.parse(environment.BJS_EDITOR_ASSET_STREAMING_SETTINGS)).toMatchObject({ windows: { enableDirectStorage: true, chunkSizeBytes: 65_536 } });
		expect(JSON.parse(environment.BJS_EDITOR_ASSET_STREAMING_PLAN)).toMatchObject({ platform: "win32", enabled: true, directStorage: { nativeBackendUsed: false } });
	});

	test("rejects malformed settings atomically and disables a requested setting on non-Windows targets", () => {
		createBuildProfile(scene, { expectedRevision: 0, id: "desktop", name: "Desktop", target: "electron", settings: { electronPlatform: "darwin" } });
		expect(() =>
			setBuildProfile(scene, {
				expectedRevision: 1,
				id: "desktop",
				settings: { electronPlatform: "darwin", assetStreaming: { windows: { enableDirectStorage: true, maximumConcurrentReads: 0 } } },
			})
		).toThrow("maximumConcurrentReads");
		expect(listBuildProfiles(scene).revision).toBe(1);
		setBuildProfile(scene, {
			expectedRevision: 1,
			id: "desktop",
			settings: { electronPlatform: "darwin", assetStreaming: { windows: { enableDirectStorage: true } } },
		});
		expect(getBuildProfileAssetStreamingPlan(scene, { id: "desktop" }).plan).toMatchObject({ requested: true, enabled: false, warnings: [expect.stringContaining("Windows")] });
	});

	test("streams a real project asset into hash-only evidence under exact revisions", async () => {
		createBuildProfile(scene, {
			expectedRevision: 0,
			id: "windows",
			name: "Windows",
			target: "electron",
			settings: { electronPlatform: "win32", assetStreaming: { windows: { enableDirectStorage: true, chunkSizeBytes: 65_536 } } },
		});
		expect(() => prepareAssetStreamingRuntime(scene, { id: "windows", expectedBuildRevision: 0 }, options)).toThrow("expectedBuildRevision 1");
		const prepared = prepareAssetStreamingRuntime(scene, { id: "windows", expectedBuildRevision: 1 }, options);
		expect(prepared.runtime).toMatchObject({ platform: "win32", plan: { enabled: true } });
		await expect(startAssetStreamingFileProbe(scene, { expectedRuntimeRevision: prepared.runtime.revision, path: "../.env" })).rejects.toThrow("restricted");
		await symlink(join(projectDirectory, "assets", "probe.bin"), join(projectDirectory, "assets", "linked.bin"));
		await expect(startAssetStreamingFileProbe(scene, { expectedRuntimeRevision: prepared.runtime.revision, path: "assets/linked.bin" })).rejects.toThrow("symbolic links");
		const started = await startAssetStreamingFileProbe(scene, {
			expectedRuntimeRevision: prepared.runtime.revision,
			path: "assets/probe.bin",
			priority: "critical",
		});
		const terminal = await waitForTerminal(scene, started.job.requestId);
		expect(terminal.job).toMatchObject({
			status: "completed",
			path: "assets/probe.bin",
			bytesRead: 20,
			sha256: "3b603ce58df8dd88a81be576a62349e5b113a38e3c1353c6f152f9b485277d6b",
		});
		expect(terminal.status.runtime.totals).toMatchObject({ completed: 1, bytesRead: 20 });
		const reset = resetAssetStreamingRuntime(scene, { expectedRuntimeRevision: terminal.status.runtime.revision, confirm: true });
		expect(reset).toMatchObject({ reset: true, jobs: [], runtime: { totals: { completed: 0, bytesRead: 0 } } });
	});

	test("cancels an active delayed range probe and exposes bounded capabilities", async () => {
		await writeFile(join(projectDirectory, "public", "scene", "large.bin"), Buffer.alloc(1024 * 1024, 7));
		createBuildProfile(scene, {
			expectedRevision: 0,
			id: "windows",
			name: "Windows",
			target: "electron",
			settings: { electronPlatform: "win32", assetStreaming: { windows: { enableDirectStorage: true, chunkSizeBytes: 65_536 } } },
		});
		const prepared = prepareAssetStreamingRuntime(scene, { id: "windows", expectedBuildRevision: 1 }, options);
		const started = await startAssetStreamingFileProbe(scene, {
			expectedRuntimeRevision: prepared.runtime.revision,
			path: "public/scene/large.bin",
			length: 1024 * 1024,
			chunkDelayMs: 50,
			priority: "background",
		});
		const cancelled = cancelAssetStreamingRequest(scene, { expectedRuntimeRevision: started.runtime.revision, requestId: started.job.requestId });
		expect(cancelled.runtime.totals.cancelled).toBe(1);
		expect((await waitForTerminal(scene, started.job.requestId)).job.status).toBe("cancelled");
		expect(getAssetStreamingCapabilities()).toMatchObject({
			buildProfiles: { target: "electron", platform: "win32", setting: "Enable Direct Storage", default: false },
			limits: { maximumProbeBytes: 67_108_864, maximumRetainedJobs: 256 },
		});
	});
});
