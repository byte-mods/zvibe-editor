import type { CompiledModel, DType, Tensor as LiteRtTensor, TypedArray } from "@litertjs/core";

import type { IRuntimeAiRunResult, IRuntimeAiTensorInput, IRuntimeAiTensorMetadata, IRuntimeAiTensorOutput, RuntimeAiEffectiveBackend } from "./runtime-ai";

export interface IRuntimeAiLiteRtExecutor {
	inputs: IRuntimeAiTensorMetadata[];
	outputs: IRuntimeAiTensorMetadata[];
	fullyAccelerated: boolean;
	run(inputs: Record<string, IRuntimeAiTensorInput>, outputNames: string[], timeoutMilliseconds: number, maximumTensorElements: number): Promise<IRuntimeAiRunResult>;
	dispose(): Promise<void>;
}

interface ILiteRtModule {
	CompiledModel: typeof import("@litertjs/core").CompiledModel;
	Tensor: typeof import("@litertjs/core").Tensor;
	getGlobalLiteRtPromise: typeof import("@litertjs/core").getGlobalLiteRtPromise;
	loadAndCompile: typeof import("@litertjs/core").loadAndCompile;
	loadLiteRt: typeof import("@litertjs/core").loadLiteRt;
	supportsFeature: typeof import("@litertjs/core").supportsFeature;
}

let loadedPath: string | null = null;
let loading: Promise<unknown> | null = null;

function defaultWasmPath(): string {
	if (typeof document === "undefined") {
		throw new Error("LiteRT requires liteRtWasmPath outside a browser or Electron renderer.");
	}
	if (location.protocol === "file:") {
		return new URL("./scene/runtime-ai/litert/", document.baseURI).href;
	}
	return new URL("/scene/runtime-ai/litert/", document.baseURI).href;
}

async function ensureRuntime(runtime: ILiteRtModule, path: string, threads: number, backend: RuntimeAiEffectiveBackend): Promise<void> {
	const resolved = path.trim() || defaultWasmPath();
	const existing = runtime.getGlobalLiteRtPromise();
	if (existing) {
		await existing;
		return;
	}
	if (!loading) {
		loadedPath = resolved;
		loading = (async () => {
			const threaded = threads > 1 && typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
			const jspi = backend === "webgpu" && (await runtime.supportsFeature("jspi"));
			if (resolved.startsWith("file:")) {
				const nodeRequire = (globalThis as unknown as { require?: (id: string) => any }).require;
				if (!nodeRequire) {
					throw new Error("LiteRT file URLs require Electron Node integration or an HTTP-served Wasm directory.");
				}
				const relaxedSimd = await runtime.supportsFeature("relaxedSimd");
				const stem = !relaxedSimd
					? "litert_wasm_compat_internal"
					: threaded
						? "litert_wasm_threaded_internal"
						: jspi
							? "litert_wasm_jspi_internal"
							: "litert_wasm_internal";
				const wasmUrl = new URL(`${stem}.wasm`, resolved);
				const fileURLToPath = nodeRequire("node:url").fileURLToPath as (url: URL) => string;
				const readFileSync = nodeRequire("node:fs").readFileSync as (path: string) => Uint8Array;
				const target = globalThis as unknown as { Module?: { wasmBinary?: Uint8Array } };
				target.Module = { ...(target.Module ?? {}), wasmBinary: new Uint8Array(readFileSync(fileURLToPath(wasmUrl))) };
			}
			await runtime.loadLiteRt(resolved, { threads: threaded, jspi });
		})();
	}
	if (loadedPath !== resolved) {
		throw new Error(`LiteRT is already loading from ${loadedPath}; all retained sessions must share one Wasm asset directory.`);
	}
	try {
		await loading;
	} catch (error) {
		loading = null;
		loadedPath = null;
		throw error;
	}
}

function metadata(values: ReturnType<CompiledModel["getInputDetails"]>): IRuntimeAiTensorMetadata[] {
	return values.map((value) => ({ name: value.name, isTensor: true, type: value.dtype, shape: [...value.shape] }));
}

function typedArray(type: DType, values: IRuntimeAiTensorInput["data"]): TypedArray {
	if (type === "float32") {
		return Float32Array.from(
			values.map((value, index) => {
				if (typeof value !== "number" || !Number.isFinite(value)) {
					throw new Error(`LiteRT float32 value ${index} must be finite.`);
				}
				return value;
			})
		);
	}
	if (type === "int32") {
		return Int32Array.from(
			values.map((value, index) => {
				if (typeof value !== "number" || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
					throw new Error(`LiteRT int32 value ${index} is out of range.`);
				}
				return value;
			})
		);
	}
	return Uint8Array.from(
		values.map((value, index) => {
			if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
				throw new Error(`LiteRT uint8 value ${index} is out of range.`);
			}
			return value;
		})
	);
}

function tensorOutput(tensor: LiteRtTensor, maximumTensorElements: number): IRuntimeAiTensorOutput {
	const dims = [...tensor.type.layout.dimensions];
	const elements = dims.reduce((total, value) => total * value, 1);
	if (!Number.isSafeInteger(elements) || elements > maximumTensorElements) {
		throw new Error(`LiteRT output contains more than ${maximumTensorElements.toLocaleString()} elements.`);
	}
	return { type: tensor.type.dtype, dims, data: Array.from(tensor.toTypedArray()) };
}

class RuntimeAiLiteRtExecutor implements IRuntimeAiLiteRtExecutor {
	public readonly inputs: IRuntimeAiTensorMetadata[];
	public readonly outputs: IRuntimeAiTensorMetadata[];
	public readonly fullyAccelerated: boolean;

	public constructor(
		private readonly _runtime: ILiteRtModule,
		private readonly _model: CompiledModel
	) {
		this.inputs = metadata(_model.getInputDetails());
		this.outputs = metadata(_model.getOutputDetails());
		this.fullyAccelerated = _model.isFullyAccelerated;
	}

	public async run(
		inputs: Record<string, IRuntimeAiTensorInput>,
		outputNames: string[],
		timeoutMilliseconds: number,
		maximumTensorElements: number
	): Promise<IRuntimeAiRunResult> {
		const feeds: Record<string, LiteRtTensor> = {};
		let results: Record<string, LiteRtTensor> | null = null;
		const started = performance.now();
		try {
			for (const input of this.inputs) {
				const value = inputs[input.name];
				feeds[input.name] = new this._runtime.Tensor(typedArray(input.type as DType, value.data), value.dims);
			}
			const raw = await this._model.run(feeds);
			if (Array.isArray(raw)) {
				if (raw.length !== this.outputs.length || raw.some((value) => !value)) {
					raw.filter(Boolean).forEach((value) => value.delete());
					throw new Error(`LiteRT returned ${raw.length} tensors for ${this.outputs.length} declared outputs.`);
				}
				results = Object.fromEntries(this.outputs.map((output, index) => [output.name, raw[index]]));
			} else {
				results = raw;
			}
			const elapsedMilliseconds = performance.now() - started;
			if (elapsedMilliseconds > timeoutMilliseconds) {
				throw new Error(`LiteRT inference exceeded the ${timeoutMilliseconds} ms deadline; LiteRT completed safely before the session was released.`);
			}
			const outputs: Record<string, IRuntimeAiTensorOutput> = {};
			for (const name of outputNames) {
				const tensor = results[name];
				if (!tensor) {
					throw new Error(`LiteRT did not return requested output "${name}".`);
				}
				const host = tensor.bufferType === 1 ? tensor : await tensor.copyTo("wasm");
				try {
					outputs[name] = tensorOutput(host, maximumTensorElements);
				} finally {
					if (host !== tensor) {
						host.delete();
					}
				}
			}
			return { elapsedMilliseconds, outputs };
		} finally {
			Object.values(feeds).forEach((value) => value.delete());
			if (results) {
				Object.values(results)
					.filter(Boolean)
					.forEach((value) => value.delete());
			}
		}
	}

	public async dispose(): Promise<void> {
		this._model.delete();
	}
}

/** Compiles one LiteRT FlatBuffer with Google's browser/Electron runtime. */
export async function createRuntimeAiLiteRtExecutor(
	source: string | Uint8Array,
	backend: RuntimeAiEffectiveBackend,
	wasmThreads: number,
	wasmPath: string
): Promise<IRuntimeAiLiteRtExecutor> {
	const runtime = (await import("@litertjs/core")) as ILiteRtModule;
	await ensureRuntime(runtime, wasmPath, wasmThreads, backend);
	const model = await runtime.loadAndCompile(source, { accelerator: backend, cpuOptions: { numThreads: wasmThreads } });
	return new RuntimeAiLiteRtExecutor(runtime, model);
}
