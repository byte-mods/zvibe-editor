import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { cancelAssetIndexingJob, getAssetIndexingStatus, queryAssetRegistry, rebuildAssetRegistry, startAssetIndexingJob } from "../../src/mcp/assets/registry";
import { projectConfiguration } from "../../src/project/configuration";
import { analyzeAssetFilesWithWorkers, IAssetFileWorkerAnalysis } from "../../src/mcp/assets/registry-worker-client";

async function waitForJob(id: string): Promise<any> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const status = await getAssetIndexingStatus();
		const job = status.recentJobs.find((candidate) => candidate.id === id);
		if (job && ["completed", "cancelled", "failed"].includes(job.status)) {
			return job;
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for asset indexing job ${id}.`);
}

describe("background asset indexing", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-background-indexing-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		const active = (await getAssetIndexingStatus()).activeJob;
		if (active) {
			cancelAssetIndexingJob(active.id);
			await waitForJob(active.id);
		}
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("starts non-blocking, reports bounded progress, and atomically publishes worker analysis", async () => {
		await writeFile(join(directory, "assets", "texture.png"), "texture");
		await writeFile(join(directory, "assets", "scene.json"), JSON.stringify({ texture: "assets/texture.png" }));
		const started = startAssetIndexingJob({ mode: "rebuild", workerCount: 2 });
		expect(started).toMatchObject({ mode: "rebuild", workerCount: 2, cancelRequested: false });
		expect(["queued", "running"]).toContain(started.status);
		expect(() => startAssetIndexingJob({ mode: "rebuild" })).toThrow("already running");

		const completed = await waitForJob(started.id);
		expect(completed).toMatchObject({ status: "completed", phase: "complete", processedFiles: 2, totalFiles: 2, result: { entryCount: 2, dependencyEdgeCount: 1 } });
		const query = await queryAssetRegistry({ folder: "assets" });
		expect(query.entries.map((entry: any) => entry.path)).toEqual(["assets/scene.json", "assets/texture.png"]);
		expect(query.entries[0]).toMatchObject({ dependencies: ["assets/texture.png"], contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
		const status = await getAssetIndexingStatus();
		expect(status).toMatchObject({ workerRuntime: "worker_threads", workerAvailable: true, activeJob: null });
		expect(status.recentJobs.length).toBeLessThanOrEqual(20);
	});

	test("cancels before publication and leaves the previous complete registry authoritative", async () => {
		await writeFile(join(directory, "assets", "existing.json"), JSON.stringify({ version: 1 }));
		const previous = await rebuildAssetRegistry();
		const registryBytes = await readFile(join(directory, ".bjseditor", "asset-registry.json"));
		await writeFile(join(directory, "assets", "new.json"), JSON.stringify({ version: 2 }));
		const started = startAssetIndexingJob({ mode: "rebuild", workerCount: 1 });
		const cancellation = cancelAssetIndexingJob(started.id);
		expect(cancellation.cancelRequested).toBe(true);
		const cancelled = await waitForJob(started.id);
		expect(cancelled).toMatchObject({ status: "cancelled", cancelRequested: true });
		expect(await readFile(join(directory, ".bjseditor", "asset-registry.json"))).toEqual(registryBytes);
		expect((await queryAssetRegistry()).entries.map((entry: any) => entry.path)).toEqual(previous.entries.map((entry) => entry.path));
	});

	test("reports metadata publication failures without replacing the last complete registry", async () => {
		await writeFile(join(directory, "assets", "existing.json"), "{}");
		await rebuildAssetRegistry();
		const registryPath = join(directory, ".bjseditor", "asset-registry.json");
		const registryBytes = await readFile(registryPath);
		const broken = join(directory, "assets", "broken.json");
		await writeFile(broken, "{}");
		await mkdir(`${broken}.bjsmeta.json`);
		const started = startAssetIndexingJob({ mode: "refresh", paths: ["assets/broken.json"] });
		const failed = await waitForJob(started.id);
		expect(failed.status).toBe("failed");
		expect(failed.error).toBeTruthy();
		expect(await readFile(registryPath)).toEqual(registryBytes);
	});

	test("validates refresh scope, worker bounds, exact job ids, and project containment", async () => {
		expect(() => startAssetIndexingJob({ mode: "refresh", paths: [] })).toThrow("1 to 100");
		expect(() => startAssetIndexingJob({ mode: "refresh", paths: ["../escape"] })).toThrow("inside the open project");
		expect(() => startAssetIndexingJob({ mode: "rebuild", workerCount: 9 })).toThrow("1 to 8");
		expect(() => cancelAssetIndexingJob("missing-job")).toThrow("not found");
	});

	test("treats a file deleted after discovery as a completed skipped analysis", async () => {
		const progress: Array<[number, number]> = [];
		const retained = join(directory, "assets", "retained.json");
		const deleted = join(directory, "assets", "deleted.json");
		const analysis: IAssetFileWorkerAnalysis = {
			absolutePath: retained,
			sizeBytes: 2,
			modifiedAt: new Date(0).toISOString(),
			contentHash: "hash",
			hashDeferred: false,
			dependencyCandidates: [],
			dependencyScanKind: "text",
			dependencyScanStatus: "complete",
			dependencyScanDeferred: false,
			containerEntries: [],
			containerDependencies: [],
		};
		const result = await analyzeAssetFilesWithWorkers(
			[retained, deleted],
			directory,
			async (path) => {
				if (path === deleted) {
					const error = new Error("gone") as NodeJS.ErrnoException;
					error.code = "ENOENT";
					throw error;
				}
				return analysis;
			},
			{ onProgress: (completed, total) => progress.push([completed, total]) }
		);

		expect(result).toEqual([analysis]);
		expect(progress).toEqual([
			[1, 2],
			[2, 2],
		]);
	});
});
