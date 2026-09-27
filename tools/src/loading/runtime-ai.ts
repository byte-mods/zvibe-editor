import type { InferenceSession, Tensor as OnnxTensor } from "onnxruntime-web";

import { getRuntimeAiBackends } from "./runtime-ai-backends";
import { createRuntimeAiLiteRtExecutor } from "./runtime-ai-litert";
import { detectRuntimeAiModelFormat, inspectRuntimeAiModelGraph, IRuntimeAiModelGraph, RuntimeAiModelFormat, RuntimeAiModelFormatSelection } from "./runtime-ai-model";
import { compileRuntimeAiPyTorchExport } from "./runtime-ai-pytorch";

export const RUNTIME_AI_MAXIMUM_TENSOR_RANK = 8;
export const RUNTIME_AI_DEFAULT_MAXIMUM_TENSOR_ELEMENTS = 16_777_216;
export const RUNTIME_AI_MAXIMUM_MODEL_BYTES = 256 * 1024 * 1024;

export type RuntimeAiBackend = "automatic" | "wasm" | "webgpu";
export type RuntimeAiEffectiveBackend = Exclude<RuntimeAiBackend, "automatic">;
export type RuntimeAiGraphOptimizationLevel = "disabled" | "basic" | "extended" | "layout" | "all";
export type RuntimeAiExecutionMode = "sequential" | "parallel";
export type RuntimeAiTensorType =
	| "float32"
	| "uint8"
	| "int8"
	| "uint16"
	| "int16"
	| "int32"
	| "int64"
	| "string"
	| "bool"
	| "float16"
	| "float64"
	| "uint32"
	| "uint64"
	| "uint4"
	| "int4";

export type RuntimeAiTensorValue = number | boolean | string;

export interface IRuntimeAiSessionOptions {
	backend?: RuntimeAiBackend;
	modelFormat?: RuntimeAiModelFormatSelection;
	graphOptimizationLevel?: RuntimeAiGraphOptimizationLevel;
	executionMode?: RuntimeAiExecutionMode;
	enableCpuMemArena?: boolean;
	enableMemPattern?: boolean;
	wasmNumThreads?: number;
	webgpuPreferredLayout?: "NCHW" | "NHWC";
	webgpuValidationMode?: "disabled" | "wgpuOnly" | "basic" | "full";
	maximumTensorElements?: number;
	liteRtWasmPath?: string;
}

export interface IRuntimeAiExternalDataFile {
	path: string;
	data: string | Blob | Uint8Array | ArrayBuffer;
}

export interface IRuntimeAiModelSource {
	model: string | Uint8Array | ArrayBuffer;
	externalData?: IRuntimeAiExternalDataFile[];
}

export interface IRuntimeAiBuildManifest {
	version: 3;
	format: RuntimeAiModelFormat;
	modelBytes: number;
	modelSha256: string;
	externalData: Array<{ path: string; bytes: number; sha256: string }>;
	liteRtWasmPath: string | null;
	liteRtWasmRelativePath: string | null;
	runtimeFiles: Array<{ path: string; bytes: number; sha256: string }>;
	fingerprint: string;
}

export type RuntimeAiModelSource = string | Uint8Array | ArrayBuffer | IRuntimeAiModelSource;

export interface IRuntimeAiTensorMetadata {
	name: string;
	isTensor: boolean;
	type: RuntimeAiTensorType | null;
	shape: Array<number | string>;
}

export interface IRuntimeAiTensorInput {
	type: RuntimeAiTensorType;
	dims: number[];
	data: RuntimeAiTensorValue[];
}

export interface IRuntimeAiTensorOutput {
	type: RuntimeAiTensorType;
	dims: number[];
	data: RuntimeAiTensorValue[];
}

export interface IRuntimeAiRunResult {
	elapsedMilliseconds: number;
	outputs: Record<string, IRuntimeAiTensorOutput>;
}

export interface IRuntimeAiSessionDescription {
	backend: RuntimeAiEffectiveBackend;
	modelFormat: RuntimeAiModelFormat;
	runtimeEngine: "onnxruntime-web" | "litertjs";
	fullyAccelerated: boolean;
	options: Required<IRuntimeAiSessionOptions>;
	inputs: IRuntimeAiTensorMetadata[];
	outputs: IRuntimeAiTensorMetadata[];
	graph: IRuntimeAiModelGraph;
	externalDataFiles: Array<{ path: string; bytes: number | null }>;
	conversion: null | { source: "pytorchExport"; target: "onnx"; schemaVersion: string; supportedOperators: string[] };
}

interface IRuntimeAiModule {
	InferenceSession: typeof import("onnxruntime-web").InferenceSession;
	Tensor: typeof import("onnxruntime-web").Tensor;
	env: typeof import("onnxruntime-web").env;
}

const tensorTypes = new Set<RuntimeAiTensorType>([
	"float32",
	"uint8",
	"int8",
	"uint16",
	"int16",
	"int32",
	"int64",
	"string",
	"bool",
	"float16",
	"float64",
	"uint32",
	"uint64",
	"uint4",
	"int4",
]);

const defaultOptions: Required<IRuntimeAiSessionOptions> = {
	backend: "automatic",
	modelFormat: "automatic",
	graphOptimizationLevel: "all",
	executionMode: "sequential",
	enableCpuMemArena: true,
	enableMemPattern: true,
	wasmNumThreads: 1,
	webgpuPreferredLayout: "NCHW",
	webgpuValidationMode: "basic",
	maximumTensorElements: RUNTIME_AI_DEFAULT_MAXIMUM_TENSOR_ELEMENTS,
	liteRtWasmPath: "",
};

function finiteInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value;
}

function enumValue<T extends string>(value: unknown, label: string, values: readonly T[]): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${label} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

function booleanValue(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean.`);
	}
	return value;
}

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function liteRtWasmPath(value: unknown): string {
	if (typeof value !== "string" || value.length > 4096) {
		throw new Error("Runtime AI LiteRT Wasm path must be a string of at most 4096 characters.");
	}
	if (value.includes("\\") || hasControlCharacters(value)) {
		throw new Error("Runtime AI LiteRT Wasm path must be a valid forward-slash URL path without control characters.");
	}
	return value;
}

/** Normalizes the portable editor/runtime ONNX session policy. */
export function normalizeRuntimeAiSessionOptions(value: IRuntimeAiSessionOptions = {}): Required<IRuntimeAiSessionOptions> {
	return {
		backend: enumValue(value.backend ?? defaultOptions.backend, "Runtime AI backend", ["automatic", "wasm", "webgpu"]),
		modelFormat: enumValue(value.modelFormat ?? defaultOptions.modelFormat, "Runtime AI model format", ["automatic", "onnx", "litert", "pytorchExport"]),
		graphOptimizationLevel: enumValue(value.graphOptimizationLevel ?? defaultOptions.graphOptimizationLevel, "Runtime AI graph optimization level", [
			"disabled",
			"basic",
			"extended",
			"layout",
			"all",
		]),
		executionMode: enumValue(value.executionMode ?? defaultOptions.executionMode, "Runtime AI execution mode", ["sequential", "parallel"]),
		enableCpuMemArena: booleanValue(value.enableCpuMemArena ?? defaultOptions.enableCpuMemArena, "Runtime AI CPU memory arena"),
		enableMemPattern: booleanValue(value.enableMemPattern ?? defaultOptions.enableMemPattern, "Runtime AI memory pattern"),
		wasmNumThreads: finiteInteger(value.wasmNumThreads ?? defaultOptions.wasmNumThreads, "Runtime AI Wasm thread count", 1, 16),
		webgpuPreferredLayout: enumValue(value.webgpuPreferredLayout ?? defaultOptions.webgpuPreferredLayout, "Runtime AI WebGPU layout", ["NCHW", "NHWC"]),
		webgpuValidationMode: enumValue(value.webgpuValidationMode ?? defaultOptions.webgpuValidationMode, "Runtime AI WebGPU validation mode", [
			"disabled",
			"wgpuOnly",
			"basic",
			"full",
		]),
		maximumTensorElements: finiteInteger(
			value.maximumTensorElements ?? defaultOptions.maximumTensorElements,
			"Runtime AI maximum tensor elements",
			1,
			RUNTIME_AI_DEFAULT_MAXIMUM_TENSOR_ELEMENTS
		),
		liteRtWasmPath: liteRtWasmPath(value.liteRtWasmPath ?? defaultOptions.liteRtWasmPath),
	};
}

/** Returns the portable execution backend selected before model compilation. */
export function resolveRuntimeAiBackend(backend: RuntimeAiBackend): RuntimeAiEffectiveBackend {
	if (backend !== "automatic") {
		return backend;
	}
	return typeof navigator !== "undefined" && "gpu" in navigator && navigator.gpu ? "webgpu" : "wasm";
}

function tensorElementCount(dims: readonly number[], maximum: number): number {
	if (!Array.isArray(dims) || dims.length > RUNTIME_AI_MAXIMUM_TENSOR_RANK) {
		throw new Error(`Runtime AI tensor dimensions must contain at most ${RUNTIME_AI_MAXIMUM_TENSOR_RANK} axes.`);
	}
	let count = 1;
	for (let index = 0; index < dims.length; index++) {
		const dimension = finiteInteger(dims[index], `Runtime AI tensor dimension ${index}`, 0, maximum);
		count *= dimension;
		if (!Number.isSafeInteger(count) || count > maximum) {
			throw new Error(`Runtime AI tensor contains more than ${maximum.toLocaleString()} elements.`);
		}
	}
	return count;
}

function assertNumber(value: RuntimeAiTensorValue, label: string, minimum: number, maximum: number, integer: boolean): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
		throw new Error(`${label} must be a ${integer ? "whole " : "finite "}number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function float32ToFloat16(value: number): number {
	const input = new Float32Array([value]);
	const bits = new Uint32Array(input.buffer)[0];
	const sign = (bits >>> 16) & 0x8000;
	let exponent = ((bits >>> 23) & 0xff) - 127 + 15;
	let mantissa = bits & 0x7fffff;
	if (exponent <= 0) {
		if (exponent < -10) {
			return sign;
		}
		mantissa = (mantissa | 0x800000) >>> (1 - exponent);
		return sign | ((mantissa + 0x1000) >>> 13);
	}
	if (exponent >= 31) {
		return sign | 0x7c00;
	}
	mantissa += 0x1000;
	if (mantissa & 0x800000) {
		mantissa = 0;
		exponent++;
	}
	return exponent >= 31 ? sign | 0x7c00 : sign | (exponent << 10) | (mantissa >>> 13);
}

function float16ToFloat32(value: number): number {
	const sign = (value & 0x8000) << 16;
	let exponent = (value >>> 10) & 0x1f;
	let mantissa = value & 0x03ff;
	if (exponent === 0) {
		if (mantissa === 0) {
			return new Float32Array(new Uint32Array([sign]).buffer)[0];
		}
		while ((mantissa & 0x0400) === 0) {
			mantissa <<= 1;
			exponent--;
		}
		exponent++;
		mantissa &= ~0x0400;
	} else if (exponent === 31) {
		return new Float32Array(new Uint32Array([sign | 0x7f800000 | (mantissa << 13)]).buffer)[0];
	}
	return new Float32Array(new Uint32Array([sign | ((exponent + 112) << 23) | (mantissa << 13)]).buffer)[0];
}

function packFourBit(values: RuntimeAiTensorValue[], signed: boolean): Uint8Array {
	const result = new Uint8Array(Math.ceil(values.length / 2));
	for (let index = 0; index < values.length; index++) {
		const minimum = signed ? -8 : 0;
		const maximum = signed ? 7 : 15;
		const value = assertNumber(values[index], `Runtime AI ${signed ? "int4" : "uint4"} value ${index}`, minimum, maximum, true) & 0xf;
		result[index >> 1] |= index % 2 === 0 ? value : value << 4;
	}
	return result;
}

function unpackFourBit(values: ArrayLike<number>, elementCount: number, signed: boolean): number[] {
	const result: number[] = [];
	for (let index = 0; index < elementCount; index++) {
		let value = (values[index >> 1] >>> ((index % 2) * 4)) & 0xf;
		if (signed && value >= 8) {
			value -= 16;
		}
		result.push(value);
	}
	return result;
}

function tensorData(type: RuntimeAiTensorType, values: RuntimeAiTensorValue[]): OnnxTensor.DataTypeMap[OnnxTensor.Type] | readonly boolean[] | readonly number[] {
	switch (type) {
		case "string":
			return values.map((value, index) => {
				if (typeof value !== "string") {
					throw new Error(`Runtime AI string value ${index} must be a string.`);
				}
				return value;
			});
		case "bool":
			return values.map((value, index) => {
				if (typeof value !== "boolean") {
					throw new Error(`Runtime AI bool value ${index} must be a boolean.`);
				}
				return value;
			});
		case "int64":
			return BigInt64Array.from(values.map((value, index) => BigInt(typeof value === "string" || typeof value === "number" ? value : invalidIntegerValue(index, type))));
		case "uint64":
			return BigUint64Array.from(values.map((value, index) => BigInt(typeof value === "string" || typeof value === "number" ? value : invalidIntegerValue(index, type))));
		case "float16":
			return Uint16Array.from(values.map((value, index) => float32ToFloat16(assertNumber(value, `Runtime AI float16 value ${index}`, -65504, 65504, false))));
		case "int4":
			return packFourBit(values, true);
		case "uint4":
			return packFourBit(values, false);
		case "float32":
		case "float64":
			return values.map((value, index) => assertNumber(value, `Runtime AI ${type} value ${index}`, -Number.MAX_VALUE, Number.MAX_VALUE, false));
		case "int8":
			return values.map((value, index) => assertNumber(value, `Runtime AI int8 value ${index}`, -128, 127, true));
		case "uint8":
			return values.map((value, index) => assertNumber(value, `Runtime AI uint8 value ${index}`, 0, 255, true));
		case "int16":
			return values.map((value, index) => assertNumber(value, `Runtime AI int16 value ${index}`, -32768, 32767, true));
		case "uint16":
			return values.map((value, index) => assertNumber(value, `Runtime AI uint16 value ${index}`, 0, 65535, true));
		case "int32":
			return values.map((value, index) => assertNumber(value, `Runtime AI int32 value ${index}`, -2147483648, 2147483647, true));
		case "uint32":
			return values.map((value, index) => assertNumber(value, `Runtime AI uint32 value ${index}`, 0, 4294967295, true));
	}
}

function invalidIntegerValue(index: number, type: "int64" | "uint64"): never {
	throw new Error(`Runtime AI ${type} value ${index} must be a number or base-10 integer string.`);
}

function metadata(values: readonly InferenceSession.ValueMetadata[]): IRuntimeAiTensorMetadata[] {
	return values.map((value) => ({
		name: value.name,
		isTensor: value.isTensor,
		type: value.isTensor && tensorTypes.has(value.type as RuntimeAiTensorType) ? (value.type as RuntimeAiTensorType) : null,
		shape: value.isTensor ? [...value.shape] : [],
	}));
}

function validateInput(metadataValue: IRuntimeAiTensorMetadata, input: IRuntimeAiTensorInput, maximum: number): void {
	if (!metadataValue.isTensor || !metadataValue.type) {
		throw new Error(`Runtime AI input "${metadataValue.name}" is not a supported tensor value.`);
	}
	if (input.type !== metadataValue.type) {
		throw new Error(`Runtime AI input "${metadataValue.name}" requires ${metadataValue.type}, not ${input.type}.`);
	}
	const count = tensorElementCount(input.dims, maximum);
	if (input.data.length !== count) {
		throw new Error(`Runtime AI input "${metadataValue.name}" has ${input.data.length} values but dimensions require ${count}.`);
	}
	if (input.dims.length !== metadataValue.shape.length) {
		throw new Error(`Runtime AI input "${metadataValue.name}" requires rank ${metadataValue.shape.length}, not ${input.dims.length}.`);
	}
	for (let index = 0; index < input.dims.length; index++) {
		const expected = metadataValue.shape[index];
		if (typeof expected === "number" && expected >= 0 && input.dims[index] !== expected) {
			throw new Error(`Runtime AI input "${metadataValue.name}" dimension ${index} requires ${expected}, not ${input.dims[index]}.`);
		}
	}
}

function outputValues(tensor: OnnxTensor, maximum: number): RuntimeAiTensorValue[] {
	const count = tensorElementCount(tensor.dims, maximum);
	if (tensor.type === "uint4" || tensor.type === "int4") {
		return unpackFourBit(tensor.data as ArrayLike<number>, count, tensor.type === "int4");
	}
	if (tensor.type === "float16" && tensor.data instanceof Uint16Array) {
		return Array.from(tensor.data, float16ToFloat32);
	}
	if (tensor.type === "int64" || tensor.type === "uint64") {
		return Array.from(tensor.data as BigInt64Array | BigUint64Array, (value) => value.toString());
	}
	if (tensor.type === "bool") {
		return Array.from(tensor.data as Uint8Array, (value) => value !== 0);
	}
	return Array.from(tensor.data as ArrayLike<number | string>);
}

async function loadRuntimeModule(backend: RuntimeAiEffectiveBackend): Promise<IRuntimeAiModule> {
	return (await getRuntimeAiBackends().loadOnnxRuntime(backend)) as IRuntimeAiModule;
}

interface IRuntimeAiExecutor {
	inputs: IRuntimeAiTensorMetadata[];
	outputs: IRuntimeAiTensorMetadata[];
	fullyAccelerated: boolean;
	run(inputs: Record<string, IRuntimeAiTensorInput>, outputNames: string[], timeoutMilliseconds: number, maximumTensorElements: number): Promise<IRuntimeAiRunResult>;
	dispose(): Promise<void>;
}

class RuntimeAiOnnxExecutor implements IRuntimeAiExecutor {
	public readonly inputs: IRuntimeAiTensorMetadata[];
	public readonly outputs: IRuntimeAiTensorMetadata[];
	public readonly fullyAccelerated: boolean;

	public constructor(
		private readonly _runtime: IRuntimeAiModule,
		private readonly _session: InferenceSession,
		backend: RuntimeAiEffectiveBackend
	) {
		this.inputs = metadata(_session.inputMetadata);
		this.outputs = metadata(_session.outputMetadata);
		this.fullyAccelerated = backend === "wasm";
	}

	public async run(
		inputs: Record<string, IRuntimeAiTensorInput>,
		outputNames: string[],
		timeoutMilliseconds: number,
		maximumTensorElements: number
	): Promise<IRuntimeAiRunResult> {
		const feeds: Record<string, OnnxTensor> = {};
		for (const metadataValue of this.inputs) {
			const input = inputs[metadataValue.name];
			feeds[metadataValue.name] = new this._runtime.Tensor(input.type as OnnxTensor.Type, tensorData(input.type, input.data) as never, input.dims);
		}
		const runOptions: InferenceSession.RunOptions = { tag: "zvibe-runtime-ai" };
		const timer = setTimeout(() => {
			runOptions.terminate = true;
		}, timeoutMilliseconds);
		const started = performance.now();
		let results: InferenceSession.ReturnType | null = null;
		try {
			results = await this._session.run(feeds, outputNames, runOptions);
			const outputs: Record<string, IRuntimeAiTensorOutput> = {};
			for (const name of outputNames) {
				const value = results[name];
				if (!value || !("dims" in value) || !("type" in value) || !tensorTypes.has(value.type as RuntimeAiTensorType)) {
					throw new Error(`Runtime AI output "${name}" is not a supported tensor.`);
				}
				const tensor = value as OnnxTensor;
				if (tensor.location !== "cpu") {
					await tensor.getData();
				}
				outputs[name] = { type: tensor.type as RuntimeAiTensorType, dims: [...tensor.dims], data: outputValues(tensor, maximumTensorElements) };
			}
			return { elapsedMilliseconds: performance.now() - started, outputs };
		} finally {
			clearTimeout(timer);
			Object.values(feeds).forEach((value) => value.dispose());
			if (results) {
				Object.values(results).forEach((value) => "dispose" in value && value.dispose());
			}
		}
	}

	public async dispose(): Promise<void> {
		await this._session.release();
	}
}

function modelSource(source: RuntimeAiModelSource): IRuntimeAiModelSource {
	if (source && typeof source === "object" && !(source instanceof Uint8Array) && !(source instanceof ArrayBuffer) && "model" in source) {
		return source as IRuntimeAiModelSource;
	}
	return { model: source as string | Uint8Array | ArrayBuffer };
}

function validateModelSource(source: IRuntimeAiModelSource): number {
	if (
		!(source.model instanceof Uint8Array) &&
		!(source.model instanceof ArrayBuffer) &&
		(typeof source.model !== "string" || !source.model.trim() || source.model.length > 4096)
	) {
		throw new Error("Runtime AI model must be non-empty bytes or a model URL/path of at most 4096 characters.");
	}
	if (source.externalData !== undefined && !Array.isArray(source.externalData)) {
		throw new Error("Runtime AI externalData must be an array.");
	}
	if ((source.externalData?.length ?? 0) > 128) {
		throw new Error("Runtime AI accepts at most 128 ONNX external-data files.");
	}
	const paths = new Set<string>();
	let knownExternalBytes = 0;
	for (const [index, file] of (source.externalData ?? []).entries()) {
		if (!file || typeof file !== "object") {
			throw new Error(`Runtime AI externalData[${index}] must be an object.`);
		}
		if (
			typeof file.path !== "string" ||
			!file.path ||
			file.path.length > 2048 ||
			file.path.startsWith("/") ||
			file.path.includes("\\") ||
			file.path.includes("://") ||
			file.path.split("/").some((part) => !part || part === "." || part === "..")
		) {
			throw new Error(`Runtime AI externalData[${index}].path must be a safe relative ONNX location.`);
		}
		if (paths.has(file.path)) {
			throw new Error(`Runtime AI external-data path is duplicated: ${file.path}.`);
		}
		paths.add(file.path);
		if (
			typeof file.data !== "string" &&
			!(file.data instanceof Uint8Array) &&
			!(file.data instanceof ArrayBuffer) &&
			!(typeof Blob !== "undefined" && file.data instanceof Blob)
		) {
			throw new Error(`Runtime AI externalData[${index}].data must be a URL, Blob, Uint8Array, or ArrayBuffer.`);
		}
		if (typeof file.data === "string" && (!file.data.trim() || file.data.length > 4096)) {
			throw new Error(`Runtime AI externalData[${index}].data URL must contain from 1 through 4096 characters.`);
		}
		if (typeof file.data !== "string") {
			knownExternalBytes +=
				typeof Blob !== "undefined" && file.data instanceof Blob
					? file.data.size
					: file.data instanceof Uint8Array
						? file.data.byteLength
						: (file.data as ArrayBuffer).byteLength;
			if (knownExternalBytes > RUNTIME_AI_MAXIMUM_MODEL_BYTES) {
				throw new Error("Runtime AI external-data files exceed 256 MiB.");
			}
		}
	}
	return knownExternalBytes;
}

async function sourceBytes(source: string | Uint8Array | ArrayBuffer, required: boolean): Promise<Uint8Array | null> {
	const bounded = (bytes: Uint8Array): Uint8Array => {
		if (!bytes.length || bytes.byteLength > RUNTIME_AI_MAXIMUM_MODEL_BYTES) {
			throw new Error(`Runtime AI model bytes must contain from 1 byte through ${RUNTIME_AI_MAXIMUM_MODEL_BYTES / (1024 * 1024)} MiB.`);
		}
		return bytes;
	};
	if (source instanceof Uint8Array) {
		return bounded(source);
	}
	if (source instanceof ArrayBuffer) {
		return bounded(new Uint8Array(source));
	}
	if (typeof fetch !== "undefined") {
		try {
			const response = await fetch(source);
			if (response.ok) {
				const declaredLength = response.headers.get("content-length");
				if (
					declaredLength &&
					finiteInteger(Number(declaredLength), "Runtime AI model Content-Length", 1, RUNTIME_AI_MAXIMUM_MODEL_BYTES) > RUNTIME_AI_MAXIMUM_MODEL_BYTES
				) {
					throw new Error("Runtime AI model response exceeds 256 MiB.");
				}
				if (!response.body) {
					return bounded(new Uint8Array(await response.arrayBuffer()));
				}
				const reader = response.body.getReader();
				const chunks: Uint8Array[] = [];
				let length = 0;
				try {
					while (true) {
						const result = await reader.read();
						if (result.done) {
							break;
						}
						length += result.value.byteLength;
						if (length > RUNTIME_AI_MAXIMUM_MODEL_BYTES) {
							throw new Error("Runtime AI model response exceeds 256 MiB.");
						}
						chunks.push(result.value);
					}
				} finally {
					await reader.cancel().catch(() => undefined);
				}
				const bytes = new Uint8Array(length);
				let offset = 0;
				for (const chunk of chunks) {
					bytes.set(chunk, offset);
					offset += chunk.byteLength;
				}
				return bounded(bytes);
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Runtime AI model")) {
				throw error;
			}
			// The runtime can still compile an ONNX/LiteRT URL even when graph prefetch is unavailable.
		}
	}
	if (required) {
		throw new Error("PyTorch Export models must be provided as readable bytes or a fetchable URL before Core ATen lowering.");
	}
	return null;
}

function absoluteRuntimeAiUrl(value: string): URL {
	try {
		return new URL(value, typeof document !== "undefined" ? document.baseURI : undefined);
	} catch {
		throw new Error("Runtime AI build model URL must be absolute outside a browser and must resolve against document.baseURI inside one.");
	}
}

async function fetchRuntimeAiBuildBytes(url: URL, label: string, maximumBytes: number): Promise<Uint8Array> {
	if (url.protocol === "file:") {
		const nodeRequire = (globalThis as unknown as { require?: (id: string) => any }).require;
		if (nodeRequire) {
			const fileURLToPath = nodeRequire("node:url").fileURLToPath as (url: URL) => string;
			const readFileSync = nodeRequire("node:fs").readFileSync as (path: string) => Uint8Array;
			const bytes = new Uint8Array(readFileSync(fileURLToPath(url)));
			if (!bytes.length || bytes.length > maximumBytes) {
				throw new Error(`${label} must contain from 1 through ${maximumBytes.toLocaleString()} bytes.`);
			}
			return bytes;
		}
	}
	if (typeof fetch === "undefined") {
		throw new Error(`${label} requires the Fetch API.`);
	}
	const response = await fetch(url.href);
	if (!response.ok) {
		throw new Error(`${label} request failed with HTTP ${response.status}.`);
	}
	const declared = response.headers.get("content-length");
	if (declared !== null) {
		const size = Number(declared);
		if (!Number.isSafeInteger(size) || size < 0 || size > maximumBytes) {
			throw new Error(`${label} Content-Length must be from 0 through ${maximumBytes.toLocaleString()} bytes.`);
		}
	}
	if (!response.body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (!bytes.length || bytes.length > maximumBytes) {
			throw new Error(`${label} must contain from 1 through ${maximumBytes.toLocaleString()} bytes.`);
		}
		return bytes;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const result = await reader.read();
			if (result.done) {
				break;
			}
			length += result.value.byteLength;
			if (length > maximumBytes) {
				throw new Error(`${label} exceeds ${maximumBytes.toLocaleString()} bytes.`);
			}
			chunks.push(result.value);
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	if (!length) {
		throw new Error(`${label} is empty.`);
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function sha256(bytes: Uint8Array, label: string): Promise<string> {
	if (!globalThis.crypto?.subtle) {
		throw new Error(`${label} integrity verification requires Web Crypto SHA-256 support.`);
	}
	const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", source));
	return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function runtimeAiBuildManifest(value: unknown): IRuntimeAiBuildManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Runtime AI build manifest must be an object.");
	}
	const document = value as Record<string, unknown>;
	const allowed = new Set(["version", "format", "modelBytes", "modelSha256", "externalData", "liteRtWasmPath", "liteRtWasmRelativePath", "runtimeFiles", "fingerprint"]);
	const unknown = Object.keys(document).filter((key) => !allowed.has(key));
	if (unknown.length) {
		throw new Error(`Runtime AI build manifest contains unknown fields: ${unknown.join(", ")}.`);
	}
	if (document.version !== 3) {
		throw new Error("Runtime AI build manifest version must be 3.");
	}
	const format = enumValue(document.format, "Runtime AI build manifest format", ["onnx", "litert", "pytorchExport"]);
	const modelBytes = finiteInteger(document.modelBytes, "Runtime AI build manifest modelBytes", 1, RUNTIME_AI_MAXIMUM_MODEL_BYTES);
	if (typeof document.fingerprint !== "string" || typeof document.modelSha256 !== "string") {
		throw new Error("Runtime AI build manifest fingerprints must be strings.");
	}
	const fingerprint = document.fingerprint;
	const modelSha256 = document.modelSha256;
	if (!/^[a-f0-9]{64}$/.test(fingerprint) || !/^[a-f0-9]{64}$/.test(modelSha256)) {
		throw new Error("Runtime AI build manifest fingerprints must be lowercase SHA-256 values.");
	}
	if (!Array.isArray(document.externalData) || document.externalData.length > 128) {
		throw new Error("Runtime AI build manifest externalData must contain at most 128 entries.");
	}
	const paths = new Set<string>();
	const externalData = document.externalData.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Runtime AI build manifest externalData[${index}] must be an object.`);
		}
		const item = entry as Record<string, unknown>;
		if (Object.keys(item).some((key) => !["path", "bytes", "sha256"].includes(key))) {
			throw new Error(`Runtime AI build manifest externalData[${index}] contains unknown fields.`);
		}
		const path = item.path;
		if (
			typeof path !== "string" ||
			!path ||
			path.length > 2048 ||
			path.startsWith("/") ||
			path.includes("\\") ||
			path.includes("://") ||
			path.split("/").some((part) => !part || part === "." || part === "..")
		) {
			throw new Error(`Runtime AI build manifest externalData[${index}].path is unsafe.`);
		}
		if (paths.has(path)) {
			throw new Error(`Runtime AI build manifest external-data path is duplicated: ${path}.`);
		}
		paths.add(path);
		const bytes = finiteInteger(item.bytes, `Runtime AI build manifest externalData[${index}].bytes`, 1, RUNTIME_AI_MAXIMUM_MODEL_BYTES);
		if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) {
			throw new Error(`Runtime AI build manifest externalData[${index}].sha256 is invalid.`);
		}
		return { path, bytes, sha256: item.sha256 };
	});
	if (externalData.reduce((total, item) => total + item.bytes, modelBytes) > RUNTIME_AI_MAXIMUM_MODEL_BYTES) {
		throw new Error("Runtime AI build manifest model plus external-data bytes exceed 256 MiB.");
	}
	const liteRtWasmPath = document.liteRtWasmPath;
	const liteRtWasmRelativePath = document.liteRtWasmRelativePath;
	if ((liteRtWasmPath !== null && typeof liteRtWasmPath !== "string") || (liteRtWasmRelativePath !== null && typeof liteRtWasmRelativePath !== "string")) {
		throw new Error("Runtime AI build manifest LiteRT paths must be strings or null.");
	}
	if (format === "litert" ? liteRtWasmPath !== "runtime-ai/litert/" || !liteRtWasmRelativePath : liteRtWasmPath !== null || liteRtWasmRelativePath !== null) {
		throw new Error("Runtime AI build manifest LiteRT paths do not match its model format.");
	}
	if (
		liteRtWasmRelativePath &&
		(liteRtWasmRelativePath.length > 4096 || !/^(?:\.\.\/)*runtime-ai\/litert\/$/.test(liteRtWasmRelativePath) || hasControlCharacters(liteRtWasmRelativePath))
	) {
		throw new Error("Runtime AI build manifest liteRtWasmRelativePath must point canonically to runtime-ai/litert/.");
	}
	if (!Array.isArray(document.runtimeFiles) || document.runtimeFiles.length > 256) {
		throw new Error("Runtime AI build manifest runtimeFiles must contain at most 256 entries.");
	}
	const runtimePaths = new Set<string>();
	const runtimeFiles = document.runtimeFiles.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Runtime AI build manifest runtimeFiles[${index}] must be an object.`);
		}
		const item = entry as Record<string, unknown>;
		if (Object.keys(item).some((key) => !["path", "bytes", "sha256"].includes(key))) {
			throw new Error(`Runtime AI build manifest runtimeFiles[${index}] contains unknown fields.`);
		}
		if (typeof item.path !== "string" || !item.path.startsWith("runtime-ai/litert/") || item.path.split("/").some((part) => !part || part === "." || part === "..")) {
			throw new Error(`Runtime AI build manifest runtimeFiles[${index}].path is unsafe.`);
		}
		if (runtimePaths.has(item.path)) {
			throw new Error(`Runtime AI build manifest runtime file is duplicated: ${item.path}.`);
		}
		runtimePaths.add(item.path);
		const bytes = finiteInteger(item.bytes, `Runtime AI build manifest runtimeFiles[${index}].bytes`, 1, RUNTIME_AI_MAXIMUM_MODEL_BYTES);
		if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) {
			throw new Error(`Runtime AI build manifest runtimeFiles[${index}].sha256 is invalid.`);
		}
		return { path: item.path, bytes, sha256: item.sha256 };
	});
	if ((format === "litert") !== Boolean(runtimeFiles.length)) {
		throw new Error("Runtime AI build manifest runtimeFiles do not match its model format.");
	}
	return { version: 3, format, modelBytes, modelSha256, externalData, liteRtWasmPath, liteRtWasmRelativePath, runtimeFiles, fingerprint };
}

function unavailableGraph(format: RuntimeAiModelFormat): IRuntimeAiModelGraph {
	return {
		name: `${format} model`,
		format,
		producer: "Graph bytes unavailable",
		version: null,
		inputs: [],
		outputs: [],
		nodes: [],
		initializers: 0,
		warnings: ["The model URL compiled, but its bytes could not be prefetched for graph visualization."],
	};
}

async function createOnnxExecutor(source: IRuntimeAiModelSource, options: Required<IRuntimeAiSessionOptions>, backend: RuntimeAiEffectiveBackend): Promise<IRuntimeAiExecutor> {
	const runtime = await loadRuntimeModule(backend);
	runtime.env.wasm.numThreads = options.wasmNumThreads;
	const executionProviders: InferenceSession.SessionOptions["executionProviders"] =
		backend === "webgpu" ? [{ name: "webgpu", preferredLayout: options.webgpuPreferredLayout, validationMode: options.webgpuValidationMode }, "wasm"] : ["wasm"];
	const sessionOptions: InferenceSession.SessionOptions = {
		executionProviders,
		graphOptimizationLevel: options.graphOptimizationLevel,
		executionMode: options.executionMode,
		enableCpuMemArena: options.enableCpuMemArena,
		enableMemPattern: options.enableMemPattern,
		externalData: source.externalData,
	};
	const session =
		typeof source.model === "string"
			? await runtime.InferenceSession.create(source.model, sessionOptions)
			: source.model instanceof Uint8Array
				? await runtime.InferenceSession.create(source.model, sessionOptions)
				: await runtime.InferenceSession.create(source.model, sessionOptions);
	return new RuntimeAiOnnxExecutor(runtime, session, backend);
}

/** Browser/Electron-safe ONNX, LiteRT, and PyTorch Export session shared by editor preview and exported TypeScript games. */
export class RuntimeAiSession {
	private _busy = false;
	private _disposed = false;
	private _disposePromise: Promise<void> | null = null;

	private constructor(
		private readonly _executor: IRuntimeAiExecutor,
		public readonly description: IRuntimeAiSessionDescription
	) {}

	/** Loads and compiles a supported model from a contained URL, file path, byte buffer, and optional ONNX companion weights. */
	public static async Create(sourceValue: RuntimeAiModelSource, options: IRuntimeAiSessionOptions = {}): Promise<RuntimeAiSession> {
		const normalized = normalizeRuntimeAiSessionOptions(options);
		const source = modelSource(sourceValue);
		const knownExternalBytes = validateModelSource(source);
		const format = detectRuntimeAiModelFormat(source.model, normalized.modelFormat);
		const backend = resolveRuntimeAiBackend(normalized.backend);
		const originalBytes = await sourceBytes(source.model, format === "pytorchExport");
		if (originalBytes && originalBytes.byteLength + knownExternalBytes > RUNTIME_AI_MAXIMUM_MODEL_BYTES) {
			throw new Error("Runtime AI model plus external-data files exceed 256 MiB.");
		}
		let graph = format === "pytorchExport" ? unavailableGraph(format) : originalBytes ? inspectRuntimeAiModelGraph(format, originalBytes) : unavailableGraph(format);
		let executor: IRuntimeAiExecutor;
		let conversion: IRuntimeAiSessionDescription["conversion"] = null;
		if (format === "litert") {
			if (source.externalData?.length) {
				throw new Error("LiteRT models do not accept ONNX external-data companions.");
			}
			executor = await createRuntimeAiLiteRtExecutor(
				source.model instanceof ArrayBuffer ? new Uint8Array(source.model) : source.model,
				backend,
				normalized.wasmNumThreads,
				normalized.liteRtWasmPath
			);
		} else {
			let onnxSource = source;
			if (format === "pytorchExport") {
				if (source.externalData?.length) {
					throw new Error("PyTorch Export archives contain their state tensors and do not accept ONNX external-data companions.");
				}
				const lowered = await compileRuntimeAiPyTorchExport(originalBytes!);
				graph = lowered.graph;
				conversion = { source: "pytorchExport", target: "onnx", schemaVersion: lowered.schemaVersion, supportedOperators: lowered.supportedOperators };
				onnxSource = { model: lowered.onnxBytes };
			}
			executor = await createOnnxExecutor(onnxSource, normalized, backend);
		}
		return new RuntimeAiSession(executor, {
			backend,
			modelFormat: format,
			runtimeEngine: format === "litert" ? "litertjs" : "onnxruntime-web",
			fullyAccelerated: executor.fullyAccelerated,
			options: { ...normalized, liteRtWasmPath: normalized.liteRtWasmPath ? "configured" : "" },
			inputs: executor.inputs,
			outputs: executor.outputs,
			graph,
			externalDataFiles: (source.externalData ?? []).map((value) => ({
				path: value.path,
				bytes:
					typeof value.data === "string"
						? null
						: typeof Blob !== "undefined" && value.data instanceof Blob
							? value.data.size
							: value.data instanceof Uint8Array
								? value.data.byteLength
								: (value.data as ArrayBuffer).byteLength,
			})),
			conversion,
		});
	}

	/** Loads one exported model through its integrity-checked .bjsai.json sidecar and resolves all runtime companions automatically. */
	public static async CreateFromBuildAsset(modelUrlValue: string, options: IRuntimeAiSessionOptions = {}): Promise<RuntimeAiSession> {
		if (typeof modelUrlValue !== "string" || !modelUrlValue.trim() || modelUrlValue.length > 4096) {
			throw new Error("Runtime AI build model URL must contain from 1 through 4096 characters.");
		}
		const modelUrl = absoluteRuntimeAiUrl(modelUrlValue.trim());
		const manifestUrl = new URL(modelUrl.href);
		manifestUrl.pathname += ".bjsai.json";
		manifestUrl.search = "";
		manifestUrl.hash = "";
		const manifestBytes = await fetchRuntimeAiBuildBytes(manifestUrl, "Runtime AI build manifest", 1024 * 1024);
		let manifestValue: unknown;
		try {
			manifestValue = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
		} catch (error) {
			throw new Error(`Runtime AI build manifest is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const manifest = runtimeAiBuildManifest(manifestValue);
		if (options.modelFormat && options.modelFormat !== "automatic" && options.modelFormat !== manifest.format) {
			throw new Error(`Runtime AI requested ${options.modelFormat}, but the build manifest contains ${manifest.format}.`);
		}
		const modelBytes = await fetchRuntimeAiBuildBytes(modelUrl, "Runtime AI build model", RUNTIME_AI_MAXIMUM_MODEL_BYTES);
		if (modelBytes.byteLength !== manifest.modelBytes || (await sha256(modelBytes, "Runtime AI build model")) !== manifest.modelSha256) {
			throw new Error("Runtime AI build model bytes do not match the exported manifest.");
		}
		const externalData: IRuntimeAiExternalDataFile[] = [];
		let totalBytes = modelBytes.byteLength;
		for (const item of manifest.externalData) {
			const bytes = await fetchRuntimeAiBuildBytes(new URL(item.path, modelUrl), `Runtime AI external-data file ${item.path}`, item.bytes);
			if (bytes.byteLength !== item.bytes || (await sha256(bytes, `Runtime AI external-data file ${item.path}`)) !== item.sha256) {
				throw new Error(`Runtime AI external-data file does not match the exported manifest: ${item.path}.`);
			}
			totalBytes += bytes.byteLength;
			if (totalBytes > RUNTIME_AI_MAXIMUM_MODEL_BYTES) {
				throw new Error("Runtime AI build model plus external-data files exceed 256 MiB.");
			}
			externalData.push({ path: item.path, data: bytes });
		}
		const liteRtWasmPath =
			manifest.format === "litert" ? options.liteRtWasmPath || new URL(manifest.liteRtWasmRelativePath!, manifestUrl).href : (options.liteRtWasmPath ?? "");
		if (manifest.format === "litert" && !options.liteRtWasmPath) {
			const wasmUrl = new URL(liteRtWasmPath);
			if (wasmUrl.protocol !== manifestUrl.protocol || (wasmUrl.protocol !== "file:" && wasmUrl.origin !== manifestUrl.origin)) {
				throw new Error("Runtime AI build manifest LiteRT runtime directory resolves outside the model origin.");
			}
			let runtimeBytes = 0;
			for (const runtimeFile of manifest.runtimeFiles) {
				const name = runtimeFile.path.slice("runtime-ai/litert/".length);
				if (!name || name.includes("/")) {
					throw new Error(`Runtime AI build manifest runtime file path is not canonical: ${runtimeFile.path}.`);
				}
				const bytes = await fetchRuntimeAiBuildBytes(new URL(name, wasmUrl), `Runtime AI LiteRT runtime file ${name}`, runtimeFile.bytes);
				if (bytes.byteLength !== runtimeFile.bytes || (await sha256(bytes, `Runtime AI LiteRT runtime file ${name}`)) !== runtimeFile.sha256) {
					throw new Error(`Runtime AI LiteRT runtime file does not match the exported manifest: ${name}.`);
				}
				runtimeBytes += bytes.byteLength;
				if (runtimeBytes > RUNTIME_AI_MAXIMUM_MODEL_BYTES) {
					throw new Error("Runtime AI LiteRT runtime files exceed 256 MiB.");
				}
			}
		}
		return RuntimeAiSession.Create({ model: modelBytes, externalData }, { ...options, modelFormat: manifest.format, liteRtWasmPath });
	}

	/** Executes one bounded tensor feed and copies every selected output back to portable JSON-safe values. */
	public async run(inputs: Record<string, IRuntimeAiTensorInput>, outputNames?: string[], timeoutMilliseconds = 30_000): Promise<IRuntimeAiRunResult> {
		if (this._disposed) {
			throw new Error("Runtime AI session has been disposed.");
		}
		if (this._disposePromise) {
			throw new Error("Runtime AI session is being disposed.");
		}
		if (this._busy) {
			throw new Error("Runtime AI session is already running an inference request.");
		}
		const expectedNames = new Set(this.description.inputs.map((value) => value.name));
		const suppliedNames = Object.keys(inputs);
		const unknown = suppliedNames.filter((name) => !expectedNames.has(name));
		const missing = [...expectedNames].filter((name) => !(name in inputs));
		if (unknown.length || missing.length) {
			throw new Error(
				`Runtime AI feeds must match model inputs exactly.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${unknown.length ? ` Unknown: ${unknown.join(", ")}.` : ""}`
			);
		}
		for (const metadataValue of this.description.inputs) {
			validateInput(metadataValue, inputs[metadataValue.name], this.description.options.maximumTensorElements);
		}
		const selectedOutputs = outputNames?.length ? [...new Set(outputNames)] : this.description.outputs.map((value) => value.name);
		const knownOutputs = new Set(this.description.outputs.map((value) => value.name));
		if (!selectedOutputs.length || selectedOutputs.some((name) => !knownOutputs.has(name))) {
			throw new Error("Runtime AI output selection must contain one or more model output names.");
		}
		const timeout = finiteInteger(timeoutMilliseconds, "Runtime AI timeout", 1, 300_000);
		this._busy = true;
		try {
			return await this._executor.run(inputs, selectedOutputs, timeout, this.description.options.maximumTensorElements);
		} finally {
			this._busy = false;
		}
	}

	/** Releases all model, Wasm, and GPU resources owned by this session. */
	public async dispose(): Promise<void> {
		if (this._busy) {
			throw new Error("Runtime AI session cannot be disposed while inference is running.");
		}
		if (this._disposed) {
			return;
		}
		if (!this._disposePromise) {
			this._disposePromise = this._executor.dispose().then(() => {
				this._disposed = true;
			});
		}
		try {
			await this._disposePromise;
		} catch (error) {
			this._disposePromise = null;
			throw error;
		}
	}
}

export type { IRuntimeAiModelGraph, RuntimeAiModelFormat, RuntimeAiModelFormatSelection } from "./runtime-ai-model";
