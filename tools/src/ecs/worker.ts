import { IBakedECSChunk } from "./baker";
import { ICompiledECSSystem, matchesCompiledECSQuery } from "./compiler";

export interface IECSWorkerExecutionEvidence {
	backend: "worker";
	workerSupported: true;
	workerCount: number;
	jobs: number;
	systemIds: string[];
	chunkIds: string[];
	scalarWrites: number;
}

interface IECSWorkerResponse {
	id: number;
	columns?: Record<string, number[]>;
	scalarWrites?: number;
	error?: string;
}

interface IWorkerEntry {
	worker: Worker;
	pending: Map<number, { resolve: (response: IECSWorkerResponse) => void; reject: (error: Error) => void }>;
}

const workerSource = `
self.onmessage = function(event) {
	const id = event.data.id;
	try {
		const task = event.data.task;
		let scalarWrites = 0;
		for (const operation of task.operations) {
			const target = task.columns[operation.targetKey];
			const source = operation.sourceKey ? task.columns[operation.sourceKey] : null;
			const factor = operation.useDeltaTime ? task.deltaSeconds : 1;
			const lanes = task.count * operation.targetArity;
			for (let index = 0; index < lanes; index++) {
				switch (operation.kind) {
					case "set": target[index] = operation.constant * factor; break;
					case "add": target[index] += operation.constant * factor; break;
					case "multiply": target[index] *= operation.constant * factor; break;
					case "copy": target[index] = source[index] * factor; break;
					case "integrate": target[index] += source[index] * operation.constant * factor; break;
					case "clamp": target[index] = Math.min(operation.maximum, Math.max(operation.minimum, target[index])); break;
				}
			}
			scalarWrites += lanes;
		}
		self.postMessage({ id, columns: task.columns, scalarWrites });
	} catch (error) {
		self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
};`;

/** Reports whether real browser/Electron Web Workers can be created. */
export function supportsECSWorkers(): boolean {
	return typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

/** Persistent real-Worker pool used only for conflict-free compiled batches. */
export class ECSWorkerKernelPool {
	private readonly _workers: IWorkerEntry[] = [];
	private _nextRequestId = 1;
	private _roundRobin = 0;
	private _disposed = false;

	public constructor(workerCount: number) {
		if (!supportsECSWorkers()) {
			throw new Error("ECS Web Workers are unavailable in this environment.");
		}
		const count = Math.min(8, Math.max(1, Math.floor(workerCount)));
		const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
		try {
			for (let index = 0; index < count; index++) {
				const worker = new Worker(url, { name: `zvibe-ecs-${index + 1}` });
				const entry: IWorkerEntry = { worker, pending: new Map() };
				worker.onmessage = (event: MessageEvent<IECSWorkerResponse>) => {
					const pending = entry.pending.get(event.data.id);
					if (!pending) {
						return;
					}
					entry.pending.delete(event.data.id);
					event.data.error ? pending.reject(new Error(event.data.error)) : pending.resolve(event.data);
				};
				worker.onerror = (event: ErrorEvent) => {
					const error = new Error(event.message || "ECS worker failed.");
					entry.pending.forEach((pending) => pending.reject(error));
					entry.pending.clear();
				};
				this._workers.push(entry);
			}
		} catch (error) {
			this._workers.forEach((entry) => entry.worker.terminate());
			this._workers.length = 0;
			throw error;
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	public get workerCount(): number {
		return this._workers.length;
	}

	private _run(system: ICompiledECSSystem, chunk: IBakedECSChunk, deltaSeconds: number): Promise<IECSWorkerResponse> {
		if (this._disposed) {
			return Promise.reject(new Error("ECS worker pool is disposed."));
		}
		const entry = this._workers[this._roundRobin++ % this._workers.length];
		const id = this._nextRequestId++;
		const keys = new Set(system.operations.flatMap((operation) => [operation.targetKey, ...(operation.sourceKey ? [operation.sourceKey] : [])]));
		const columns = Object.fromEntries([...keys].map((key) => [key, Array.from(chunk.columns[key].values)]));
		return new Promise<IECSWorkerResponse>((resolve, reject) => {
			entry.pending.set(id, { resolve, reject });
			entry.worker.postMessage({ id, task: { operations: system.operations, count: chunk.count, deltaSeconds, columns } });
		});
	}

	public async executeBatch(systems: readonly ICompiledECSSystem[], chunks: readonly IBakedECSChunk[], deltaSeconds: number): Promise<IECSWorkerExecutionEvidence> {
		const jobs: Array<Promise<{ response: IECSWorkerResponse; system: ICompiledECSSystem; chunk: IBakedECSChunk }>> = [];
		const chunkIds = new Set<string>();
		const systemIds = new Set<string>();
		for (const system of systems) {
			if (!system.workerEligible) {
				throw new Error(`ECS system "${system.id}" is not worker eligible.`);
			}
			for (const chunk of chunks) {
				if (matchesCompiledECSQuery(chunk, system.query)) {
					jobs.push(this._run(system, chunk, deltaSeconds).then((response) => ({ response, system, chunk })));
					chunkIds.add(chunk.id);
					systemIds.add(system.id);
				}
			}
		}
		// Publish only after every worker succeeds. A partial worker failure can
		// then fall back on the main thread without double-applying completed jobs.
		const results = await Promise.all(jobs);
		for (const { response, system, chunk } of results) {
			for (const key of new Set(system.operations.map((operation) => operation.targetKey))) {
				chunk.columns[key].values.set(response.columns![key]);
			}
		}
		return {
			backend: "worker",
			workerSupported: true,
			workerCount: this.workerCount,
			jobs: jobs.length,
			systemIds: [...systemIds].sort(),
			chunkIds: [...chunkIds].sort(),
			scalarWrites: results.reduce((total, result) => total + (result.response.scalarWrites ?? 0), 0),
		};
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const entry of this._workers) {
			entry.worker.terminate();
			entry.pending.forEach((pending) => pending.reject(new Error("ECS worker pool was disposed.")));
			entry.pending.clear();
		}
		this._workers.length = 0;
	}
}
