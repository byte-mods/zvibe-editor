import { cpus } from "os";
import { join } from "path/posix";
import { Worker as NodeWorker } from "worker_threads";

export interface IAssetFileWorkerAnalysis {
	absolutePath: string;
	sizeBytes: number;
	modifiedAt: string;
	contentHash: string | null;
	hashDeferred: boolean;
	dependencyCandidates: string[];
	dependencyScanKind: "text" | "glb" | "fbx" | "3ds" | "archive" | "none";
	dependencyScanStatus: "complete" | "deferred" | "malformed" | "notApplicable";
	dependencyScanMessage?: string;
	dependencyScanDeferred: boolean;
	containerEntries: Array<{ path: string; sizeBytes: number; type: string; scannable: boolean }>;
	containerDependencies: Array<{ sourcePath: string; targetPath: string; missing: boolean; external: boolean }>;
}

interface IWorkerResponse {
	id: number;
	analysis?: IAssetFileWorkerAnalysis;
	error?: string;
}

export interface IAssetWorkerPoolOptions {
	workerCount?: number;
	isCancelled?: () => boolean;
	onProgress?: (completed: number, total: number) => void;
}

export class AssetIndexingCancelledError extends Error {
	public constructor() {
		super("Asset indexing was cancelled before the registry was published.");
		this.name = "AssetIndexingCancelledError";
	}
}

export function defaultAssetIndexingWorkerCount(): number {
	return Math.min(4, Math.max(1, cpus().length - 1));
}

type AssetAnalysisWorker = NodeWorker | Worker;

export function assetIndexingWorkerRuntime(): "electron-web-worker" | "worker_threads" {
	return process.versions.electron && (process as NodeJS.Process & { type?: string }).type === "renderer" ? "electron-web-worker" : "worker_threads";
}

function createAnalysisWorker(): AssetAnalysisWorker {
	const path = join(__dirname, "registry-worker.js");
	return assetIndexingWorkerRuntime() === "electron-web-worker" ? new globalThis.Worker(path) : new NodeWorker(path);
}

async function terminateAnalysisWorker(worker: AssetAnalysisWorker): Promise<void> {
	await Promise.resolve(worker.terminate()).then(() => undefined);
}

/** Runs bounded file analysis outside the renderer event loop, with an inline test adapter for deterministic unit tests. */
export async function analyzeAssetFilesWithWorkers(
	files: string[],
	projectRoot: string,
	inlineAnalyze: (path: string, root: string) => Promise<IAssetFileWorkerAnalysis>,
	options: IAssetWorkerPoolOptions = {}
): Promise<IAssetFileWorkerAnalysis[]> {
	if (!files.length) {
		return [];
	}
	const workerCount = Math.min(8, Math.max(1, options.workerCount ?? defaultAssetIndexingWorkerCount()), files.length);
	if (process.env.VITEST === "true") {
		const analyses: IAssetFileWorkerAnalysis[] = [];
		for (const file of files) {
			if (options.isCancelled?.()) {
				throw new AssetIndexingCancelledError();
			}
			analyses.push(await inlineAnalyze(file, projectRoot));
			options.onProgress?.(analyses.length, files.length);
		}
		return analyses;
	}

	const workers = Array.from({ length: workerCount }, () => createAnalysisWorker());
	const analyses = new Array<IAssetFileWorkerAnalysis>(files.length);
	let nextIndex = 0;
	let completed = 0;
	let settled = false;
	return new Promise<IAssetFileWorkerAnalysis[]>((resolve, reject) => {
		const stop = async (error?: Error): Promise<void> => {
			if (settled) {
				return;
			}
			settled = true;
			await Promise.all(workers.map((worker) => terminateAnalysisWorker(worker).catch(() => undefined)));
			error ? reject(error) : resolve(analyses);
		};
		const dispatch = (worker: AssetAnalysisWorker): void => {
			if (options.isCancelled?.()) {
				void stop(new AssetIndexingCancelledError());
				return;
			}
			if (nextIndex >= files.length) {
				if (completed === files.length) {
					void stop();
				}
				return;
			}
			const id = nextIndex++;
			worker.postMessage({ id, absolutePath: files[id], projectRoot });
		};
		for (const worker of workers) {
			const onMessage = (response: IWorkerResponse): void => {
				if (settled) {
					return;
				}
				if (response.error || !response.analysis) {
					void stop(new Error(`Asset indexing worker failed: ${response.error ?? "missing analysis result"}`));
					return;
				}
				analyses[response.id] = response.analysis;
				completed++;
				options.onProgress?.(completed, files.length);
				dispatch(worker);
			};
			if (worker instanceof NodeWorker) {
				worker.on("message", onMessage);
				worker.on("error", (error) => void stop(new Error(`Asset indexing worker crashed: ${error.message}`)));
				worker.on("exit", (code) => {
					if (!settled && code !== 0) {
						void stop(new Error(`Asset indexing worker exited unexpectedly with code ${code}.`));
					}
				});
			} else {
				worker.addEventListener("message", (event) => onMessage(event.data as IWorkerResponse));
				worker.addEventListener("error", (event) => void stop(new Error(`Asset indexing worker crashed: ${event.message}`)));
			}
			dispatch(worker);
		}
	});
}
