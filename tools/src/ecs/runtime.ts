import { Observer } from "@babylonjs/core/Misc/observable";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import { ECSBaker, ECSBakeMode, IBakedECSChunk, IBakedECSWorld, createECSWorldSnapshot } from "./baker";
import { ECSCommandBuffer, ECSRuntimeCommand, queryECSWorld } from "./commands";
import { ICompiledECSBatch, ICompiledECSSchedule, ICompiledECSSystem, compileECSConfiguration, matchesCompiledECSQuery } from "./compiler";
import { executeCompiledECSSystemOnChunk } from "./kernel";
import { IECSConfiguration, getSceneECSConfiguration, normalizeECSConfiguration } from "./model";
import { ECSWorkerKernelPool, supportsECSWorkers } from "./worker";

export type ECSRuntimeStatus = "stopped" | "running" | "paused" | "disposed";
export type ECSExecutionBackend = "main-thread" | "worker";

export interface IECSExecutionTrace {
	sequence: number;
	frame: number;
	phase: "fixed" | "update" | "late";
	batchIndex: number;
	systemIds: string[];
	backend: ECSExecutionBackend;
	chunkIds: string[];
	entityCount: number;
	scalarWrites: number;
}

export interface IECSRuntimeReport {
	status: ECSRuntimeStatus;
	frame: number;
	generation: number;
	entityCount: number;
	activeEntityCount: number;
	configurationRevision: number;
	scheduleHash: string;
	kernelBackend: "portable-typed-array";
	lastExecutionBackend: ECSExecutionBackend | null;
	workerSupported: boolean;
	workerCount: number;
	workerFallbackReason: string | null;
	lastError: string | null;
	queuedCommands: number;
	traceCount: number;
}

export interface IECSRuntimeStepResult {
	frame: number;
	fixedSteps: number;
	deltaSeconds: number;
	commandsApplied: number;
	backend: ECSExecutionBackend;
	scalarWrites: number;
	generation: number;
}

export interface IECSRuntimeRebakeOptions {
	mode?: ECSBakeMode;
	expectedGeneration?: number;
	expectedSourceHashes?: Record<string, string>;
}

const sceneRuntimes = new WeakMap<Scene, ECSRuntime>();

function activeChunks(world: IBakedECSWorld): IBakedECSChunk[] {
	const ids = new Set(world.activeChunkIds);
	return world.chunks.filter((chunk) => ids.has(chunk.id));
}

function matchedChunkIds(systems: readonly ICompiledECSSystem[], chunks: readonly IBakedECSChunk[]): string[] {
	return [...new Set(chunks.filter((chunk) => systems.some((system) => matchesCompiledECSQuery(chunk, system.query))).map((chunk) => chunk.id))].sort();
}

/** Live deterministic ECS world with fixed/update/late scheduling and deferred structural commands. */
export class ECSRuntime {
	private readonly _scene: Scene;
	private readonly _baker = new ECSBaker();
	private readonly _commands = new ECSCommandBuffer();
	private _configuration: IECSConfiguration;
	private _schedule: ICompiledECSSchedule;
	private _world: IBakedECSWorld;
	private _status: ECSRuntimeStatus = "stopped";
	private _frame = 0;
	private _fixedAccumulator = 0;
	private _traceSequence = 0;
	private readonly _traces: IECSExecutionTrace[] = [];
	private _lastExecutionBackend: ECSExecutionBackend | null = null;
	private _workerFallbackReason: string | null = null;
	private _lastError: string | null = null;
	private _workerPool: ECSWorkerKernelPool | null = null;
	private _beforeRenderObserver: Observer<Scene> | null = null;
	private _disposeObserver: Observer<Scene> | null = null;
	private _framePending = false;
	private _queuedFrameSeconds = 0;

	public constructor(scene: Scene, configuration = getSceneECSConfiguration(scene), observeScene = true) {
		this._scene = scene;
		this._configuration = normalizeECSConfiguration(configuration);
		this._schedule = compileECSConfiguration(this._configuration);
		this._world = this._baker.bake(scene, this._configuration, { mode: "full" }).world;
		if (observeScene) {
			this._beforeRenderObserver = scene.onBeforeRenderObservable.add(() => {
				if (this._status === "running") {
					const deltaSeconds = Math.min(1, Math.max(0, scene.getEngine().getDeltaTime() / 1000));
					if (this._usesWorkersForSceneFrame()) {
						this.requestFrame(deltaSeconds);
					} else {
						try {
							this.step(deltaSeconds);
						} catch (error) {
							this._lastError = error instanceof Error ? error.message : String(error);
							this._status = "paused";
						}
					}
				}
			});
			this._disposeObserver = scene.onDisposeObservable.add(() => this.dispose());
		}
		if (this._configuration.settings.enabled && this._configuration.settings.autoStart) {
			this._status = "running";
		}
	}

	public get status(): ECSRuntimeStatus {
		return this._status;
	}

	public get world(): IBakedECSWorld {
		return this._world;
	}

	public get schedule(): ICompiledECSSchedule {
		return this._schedule;
	}

	public get traces(): readonly IECSExecutionTrace[] {
		return this._traces;
	}

	public get report(): IECSRuntimeReport {
		return {
			status: this._status,
			frame: this._frame,
			generation: this._world.generation,
			entityCount: this._world.entityCount,
			activeEntityCount: this._world.activeEntityCount,
			configurationRevision: this._configuration.revision,
			scheduleHash: this._schedule.scheduleHash,
			kernelBackend: this._schedule.backend,
			lastExecutionBackend: this._lastExecutionBackend,
			workerSupported: supportsECSWorkers(),
			workerCount: this._workerPool?.workerCount ?? 0,
			workerFallbackReason: this._workerFallbackReason,
			lastError: this._lastError,
			queuedCommands: this._commands.count,
			traceCount: this._traces.length,
		};
	}

	private _assertUsable(): void {
		if (this._status === "disposed") {
			throw new Error("ECS runtime is disposed.");
		}
	}

	private _pushTrace(trace: Omit<IECSExecutionTrace, "sequence" | "frame">): void {
		this._traces.push({ sequence: ++this._traceSequence, frame: this._frame, ...trace });
		while (this._traces.length > this._configuration.settings.traceLimit) {
			this._traces.shift();
		}
	}

	private _executeBatchMain(batch: ICompiledECSBatch, phase: "fixed" | "update" | "late", chunks: readonly IBakedECSChunk[], deltaSeconds: number): number {
		const systems = batch.systemIds.map((id) => this._schedule.systems[id]);
		let scalarWrites = 0;
		for (const system of systems) {
			for (const chunk of chunks) {
				scalarWrites += executeCompiledECSSystemOnChunk(system, chunk, deltaSeconds);
			}
		}
		const chunkIds = matchedChunkIds(systems, chunks);
		this._pushTrace({
			phase,
			batchIndex: batch.index,
			systemIds: [...batch.systemIds],
			backend: "main-thread",
			chunkIds,
			entityCount: chunks.filter((chunk) => chunkIds.includes(chunk.id)).reduce((total, chunk) => total + chunk.count, 0),
			scalarWrites,
		});
		return scalarWrites;
	}

	private _shouldUseWorkers(systems: readonly ICompiledECSSystem[]): boolean {
		if (this._configuration.settings.executionMode === "main-thread" || !systems.every((system) => system.workerEligible)) {
			return false;
		}
		return this._configuration.settings.executionMode === "worker" || this._world.activeEntityCount >= this._configuration.settings.minimumWorkerEntities;
	}

	private _usesWorkersForSceneFrame(): boolean {
		const systems = Object.values(this._schedule.systems);
		return systems.length > 0 && systems.every((system) => system.workerEligible) && this._shouldUseWorkers(systems);
	}

	private _getWorkerPool(): ECSWorkerKernelPool | null {
		if (this._workerPool) {
			return this._workerPool;
		}
		if (!supportsECSWorkers()) {
			this._workerFallbackReason = "Web Workers are unavailable; portable kernels executed on the main thread.";
			return null;
		}
		const hardware = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 2;
		const count = this._configuration.settings.workerCount || Math.min(8, Math.max(1, hardware - 1));
		try {
			this._workerPool = new ECSWorkerKernelPool(count);
			this._workerFallbackReason = null;
			return this._workerPool;
		} catch (error) {
			this._workerFallbackReason = `Worker initialization failed; main-thread fallback used: ${error instanceof Error ? error.message : String(error)}`;
			return null;
		}
	}

	private _executePhaseSync(phase: "fixed" | "update" | "late", deltaSeconds: number): number {
		const chunks = activeChunks(this._world);
		let scalarWrites = 0;
		for (const batch of this._schedule.phases[phase].batches) {
			scalarWrites += this._executeBatchMain(batch, phase, chunks, deltaSeconds);
		}
		this._lastExecutionBackend = "main-thread";
		return scalarWrites;
	}

	private async _executePhaseAsync(phase: "fixed" | "update" | "late", deltaSeconds: number): Promise<{ scalarWrites: number; usedWorker: boolean }> {
		const chunks = activeChunks(this._world);
		let scalarWrites = 0;
		let usedWorker = false;
		for (const batch of this._schedule.phases[phase].batches) {
			const systems = batch.systemIds.map((id) => this._schedule.systems[id]);
			const pool = this._shouldUseWorkers(systems) ? this._getWorkerPool() : null;
			if (!pool) {
				scalarWrites += this._executeBatchMain(batch, phase, chunks, deltaSeconds);
				continue;
			}
			try {
				const evidence = await pool.executeBatch(systems, chunks, deltaSeconds);
				usedWorker = true;
				scalarWrites += evidence.scalarWrites;
				this._pushTrace({
					phase,
					batchIndex: batch.index,
					systemIds: [...batch.systemIds],
					backend: "worker",
					chunkIds: evidence.chunkIds,
					entityCount: chunks.filter((chunk) => evidence.chunkIds.includes(chunk.id)).reduce((total, chunk) => total + chunk.count, 0),
					scalarWrites: evidence.scalarWrites,
				});
			} catch (error) {
				if (this._status === "disposed") {
					throw error;
				}
				this._workerPool?.dispose();
				this._workerPool = null;
				this._workerFallbackReason = `Worker execution failed; main-thread fallback used: ${error instanceof Error ? error.message : String(error)}`;
				scalarWrites += this._executeBatchMain(batch, phase, chunks, deltaSeconds);
			}
		}
		return { scalarWrites, usedWorker };
	}

	private _fixedStepCount(deltaSeconds: number): number {
		this._fixedAccumulator += deltaSeconds;
		const available = Math.floor(this._fixedAccumulator / this._configuration.settings.fixedDeltaSeconds);
		const steps = Math.min(available, this._configuration.settings.maxCatchUpSteps);
		this._fixedAccumulator -= steps * this._configuration.settings.fixedDeltaSeconds;
		if (available > steps) {
			this._fixedAccumulator = Math.min(this._fixedAccumulator, this._configuration.settings.fixedDeltaSeconds);
		}
		return steps;
	}

	private _applyCommands(): number {
		const playback = this._commands.playback(this._world, this._configuration);
		this._world = playback.world;
		return playback.applied;
	}

	private _synchronizeSceneTransforms(): void {
		if (this._scene.isDisposed) {
			return;
		}
		const active = new Set(this._world.activeChunkIds);
		for (const chunk of this._world.chunks) {
			if (!active.has(chunk.id)) {
				continue;
			}
			const position = chunk.columns["transform.position"];
			const rotation = chunk.columns["transform.rotation"];
			const scale = chunk.columns["transform.scale"];
			for (let row = 0; row < chunk.count; row++) {
				const node = this._scene.getNodeById(chunk.entityIds[row]) as any;
				if (!node) {
					continue;
				}
				if (position && node.position?.copyFromFloats) {
					node.position.copyFromFloats(position.values[row * 3], position.values[row * 3 + 1], position.values[row * 3 + 2]);
				}
				if (rotation && (node.rotationQuaternion !== undefined || node.rotation !== undefined)) {
					node.rotationQuaternion ??= Quaternion.Identity();
					node.rotationQuaternion.copyFromFloats(rotation.values[row * 4], rotation.values[row * 4 + 1], rotation.values[row * 4 + 2], rotation.values[row * 4 + 3]);
				}
				if (scale && node.scaling?.copyFromFloats) {
					node.scaling.copyFromFloats(scale.values[row * 3], scale.values[row * 3 + 1], scale.values[row * 3 + 2]);
				}
			}
		}
	}

	public start(): IECSRuntimeReport {
		this._assertUsable();
		if (!this._configuration.settings.enabled) {
			throw new Error("ECS runtime is disabled by scene configuration.");
		}
		this._status = "running";
		return this.report;
	}

	public pause(): IECSRuntimeReport {
		this._assertUsable();
		this._status = "paused";
		return this.report;
	}

	public stop(): IECSRuntimeReport {
		this._assertUsable();
		this._status = "stopped";
		this._fixedAccumulator = 0;
		return this.report;
	}

	public queueCommand(command: ECSRuntimeCommand, expectedGeneration = this._world.generation): number {
		this._assertUsable();
		this._commands.enqueue(command, expectedGeneration);
		return this._commands.count;
	}

	public playbackCommands(): number {
		this._assertUsable();
		const applied = this._applyCommands();
		this._synchronizeSceneTransforms();
		return applied;
	}

	public step(deltaSeconds: number): IECSRuntimeStepResult {
		this._assertUsable();
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			throw new Error("ECS deltaSeconds must be finite and between 0 and 1.");
		}
		this._frame++;
		this._lastError = null;
		const fixedSteps = this._fixedStepCount(deltaSeconds);
		let scalarWrites = 0;
		for (let index = 0; index < fixedSteps; index++) {
			scalarWrites += this._executePhaseSync("fixed", this._configuration.settings.fixedDeltaSeconds);
		}
		scalarWrites += this._executePhaseSync("update", deltaSeconds);
		scalarWrites += this._executePhaseSync("late", deltaSeconds);
		const commandsApplied = this._applyCommands();
		this._synchronizeSceneTransforms();
		this._lastExecutionBackend = "main-thread";
		return { frame: this._frame, fixedSteps, deltaSeconds, commandsApplied, backend: "main-thread", scalarWrites, generation: this._world.generation };
	}

	public async stepAsync(deltaSeconds: number): Promise<IECSRuntimeStepResult> {
		this._assertUsable();
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			throw new Error("ECS deltaSeconds must be finite and between 0 and 1.");
		}
		this._frame++;
		this._lastError = null;
		const fixedSteps = this._fixedStepCount(deltaSeconds);
		let scalarWrites = 0;
		let usedWorker = false;
		for (let index = 0; index < fixedSteps; index++) {
			const result = await this._executePhaseAsync("fixed", this._configuration.settings.fixedDeltaSeconds);
			scalarWrites += result.scalarWrites;
			usedWorker ||= result.usedWorker;
		}
		for (const phase of ["update", "late"] as const) {
			const result = await this._executePhaseAsync(phase, deltaSeconds);
			scalarWrites += result.scalarWrites;
			usedWorker ||= result.usedWorker;
		}
		const commandsApplied = this._applyCommands();
		this._synchronizeSceneTransforms();
		this._lastExecutionBackend = usedWorker ? "worker" : "main-thread";
		return { frame: this._frame, fixedSteps, deltaSeconds, commandsApplied, backend: this._lastExecutionBackend, scalarWrites, generation: this._world.generation };
	}

	public requestFrame(deltaSeconds: number): void {
		this._assertUsable();
		if (this._framePending) {
			this._queuedFrameSeconds = Math.min(1, this._queuedFrameSeconds + deltaSeconds);
			return;
		}
		this._framePending = true;
		void this.stepAsync(deltaSeconds)
			.catch((error) => {
				this._lastError = error instanceof Error ? error.message : String(error);
				if (this._status !== "disposed") {
					this._status = "paused";
				}
			})
			.finally(() => {
				this._framePending = false;
				const queued = this._queuedFrameSeconds;
				this._queuedFrameSeconds = 0;
				if (queued > 0 && this._status === "running") {
					this.requestFrame(queued);
				}
			});
	}

	public rebake(configuration: IECSConfiguration = getSceneECSConfiguration(this._scene), options: IECSRuntimeRebakeOptions = {}): IECSRuntimeReport {
		this._assertUsable();
		if (options.expectedGeneration !== undefined && options.expectedGeneration !== this._world.generation) {
			throw new Error(`ECS runtime generation changed; expected ${options.expectedGeneration}, current ${this._world.generation}.`);
		}
		const loaded = new Map(this._world.sections.map((section) => [section.id, section.loaded]));
		const candidateConfiguration = normalizeECSConfiguration(configuration);
		const candidateSchedule = compileECSConfiguration(candidateConfiguration);
		let world = this._baker.bake(this._scene, candidateConfiguration, { mode: options.mode, expectedSourceHashes: options.expectedSourceHashes }).world;
		for (const section of world.sections) {
			const desired = loaded.get(section.id);
			if (desired !== undefined && desired !== section.loaded) {
				world = this._baker.setSectionLoaded(section.id, desired, world.generation);
			}
		}
		this._configuration = candidateConfiguration;
		this._schedule = candidateSchedule;
		this._world = world;
		this._commands.clear();
		this._workerPool?.dispose();
		this._workerPool = null;
		this._workerFallbackReason = null;
		this._lastError = null;
		if (!this._configuration.settings.enabled) {
			this._status = "stopped";
		}
		return this.report;
	}

	public query(query: Parameters<typeof queryECSWorld>[1] = {}): Record<string, unknown> {
		this._assertUsable();
		return queryECSWorld(this._world, query);
	}

	public snapshot(includeValues = false, chunkOffset = 0, chunkLimit = 64): Record<string, unknown> {
		this._assertUsable();
		return {
			runtime: this.report,
			schedule: this._schedule,
			traces: this._traces.map((trace) => ({ ...trace })),
			world: createECSWorldSnapshot(this._world, { includeValues, chunkOffset, chunkLimit }),
		};
	}

	public dispose(): void {
		if (this._status === "disposed") {
			return;
		}
		if (this._beforeRenderObserver) {
			this._scene.onBeforeRenderObservable.remove(this._beforeRenderObserver);
		}
		if (this._disposeObserver) {
			this._scene.onDisposeObservable.remove(this._disposeObserver);
		}
		this._beforeRenderObserver = null;
		this._disposeObserver = null;
		this._workerPool?.dispose();
		this._workerPool = null;
		this._commands.clear();
		this._status = "disposed";
		if (sceneRuntimes.get(this._scene) === this) {
			sceneRuntimes.delete(this._scene);
		}
	}
}

/** Configures and owns the one live ECS runtime associated with a scene. */
export function configureECSRuntime(scene: Scene, configuration = getSceneECSConfiguration(scene)): ECSRuntime {
	sceneRuntimes.get(scene)?.dispose();
	const runtime = new ECSRuntime(scene, configuration, true);
	sceneRuntimes.set(scene, runtime);
	return runtime;
}

function hasAuthoredECS(scene: Scene): boolean {
	return (
		Boolean(scene.metadata?.babylonEditorECS) ||
		scene.getNodes().some((node) => node.metadata?.babylonEditorComponentStack?.components?.some((component: any) => component.type === "entity"))
	);
}

/** Configures ECS only when the scene has an ECS asset or Entity component. */
export function configureAuthoredECSRuntime(scene: Scene): ECSRuntime | null {
	if (!hasAuthoredECS(scene)) {
		disposeECSRuntime(scene);
		return null;
	}
	return configureECSRuntime(scene, getSceneECSConfiguration(scene));
}

/** Incrementally refreshes authored ECS content while preserving one scene owner. */
export function refreshAuthoredECSRuntime(scene: Scene): ECSRuntime | null {
	if (!hasAuthoredECS(scene)) {
		disposeECSRuntime(scene);
		return null;
	}
	return refreshECSRuntime(scene, getSceneECSConfiguration(scene));
}

/** Re-bakes a configured runtime, or creates it when a scene has none. */
export function refreshECSRuntime(scene: Scene, configuration = getSceneECSConfiguration(scene)): ECSRuntime {
	const runtime = sceneRuntimes.get(scene);
	if (runtime) {
		runtime.rebake(configuration);
		return runtime;
	}
	return configureECSRuntime(scene, configuration);
}

export function getECSRuntime(scene: Scene): ECSRuntime | null {
	return sceneRuntimes.get(scene) ?? null;
}

export function disposeECSRuntime(scene: Scene): void {
	sceneRuntimes.get(scene)?.dispose();
}
