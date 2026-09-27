import type { onnx } from "onnx-proto";
import { onnxProto } from "../tools/onnx-proto";

export type RuntimeAiModelFormat = "onnx" | "litert" | "pytorchExport";
export type RuntimeAiModelFormatSelection = "automatic" | RuntimeAiModelFormat;

export interface IRuntimeAiGraphNode {
	id: string;
	name: string;
	operator: string;
	domain: string;
	inputs: string[];
	outputs: string[];
}

export interface IRuntimeAiModelGraph {
	name: string;
	format: RuntimeAiModelFormat;
	producer: string;
	version: string | null;
	inputs: string[];
	outputs: string[];
	nodes: IRuntimeAiGraphNode[];
	initializers: number;
	warnings: string[];
}

const maximumGraphNodes = 16_384;
const maximumGraphValues = 65_536;
const maximumFlatBufferStringBytes = 65_536;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function hasControlCharacters(value: string): boolean {
	return [...value].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
}

function extensionFormat(source: string): RuntimeAiModelFormat | null {
	const path = source.split(/[?#]/, 1)[0].toLowerCase();
	if (path.endsWith(".tflite")) {
		return "litert";
	}
	if (path.endsWith(".pt2")) {
		return "pytorchExport";
	}
	if (path.endsWith(".onnx")) {
		return "onnx";
	}
	return null;
}

/** Detects one supported runtime model container without trusting only its filename. */
export function detectRuntimeAiModelFormat(source: string | Uint8Array | ArrayBuffer, selection: RuntimeAiModelFormatSelection = "automatic"): RuntimeAiModelFormat {
	if (selection !== "automatic") {
		return selection;
	}
	if (typeof source === "string") {
		const format = extensionFormat(source);
		if (!format) {
			throw new Error("Runtime AI model URLs must end in .onnx, .tflite, or .pt2 when modelFormat is automatic.");
		}
		return format;
	}
	const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
	if (bytes.length >= 8 && bytes[4] === 0x54 && bytes[5] === 0x46 && bytes[6] === 0x4c && bytes[7] === 0x33) {
		return "litert";
	}
	if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
		return "pytorchExport";
	}
	return "onnx";
}

function numberValue(value: number | { toNumber(): number } | null | undefined): number {
	if (typeof value === "number") {
		return value;
	}
	return value?.toNumber() ?? 0;
}

function onnxGraph(bytes: Uint8Array): IRuntimeAiModelGraph {
	const model = onnxProto.ModelProto.decode(bytes);
	if (!model.graph) {
		throw new Error("ONNX model does not contain a graph.");
	}
	const graph = model.graph;
	const nodes = graph.node ?? [];
	const initializers = graph.initializer ?? [];
	if (nodes.length > maximumGraphNodes) {
		throw new Error(`Runtime AI graph contains more than ${maximumGraphNodes.toLocaleString()} nodes.`);
	}
	const initializerNames = new Set(initializers.map((value) => value.name ?? ""));
	return {
		name: graph.name || "ONNX model",
		format: "onnx",
		producer: model.producerName || "Unknown ONNX producer",
		version: model.opsetImport.length ? model.opsetImport.map((value) => `${value.domain || "ai.onnx"}:${numberValue(value.version)}`).join(", ") : null,
		inputs: (graph.input ?? []).map((value) => value.name ?? "").filter((name) => name && !initializerNames.has(name)),
		outputs: (graph.output ?? []).map((value) => value.name ?? "").filter(Boolean),
		nodes: nodes.map((node, index) => ({
			id: `onnx-${index}`,
			name: node.name || `${node.opType || "Operator"} ${index + 1}`,
			operator: node.opType || "Unknown",
			domain: node.domain || "ai.onnx",
			inputs: [...(node.input ?? [])],
			outputs: [...(node.output ?? [])],
		})),
		initializers: initializers.length,
		warnings: [],
	};
}

/** Lists safe project-relative companion blobs referenced by an ONNX model's external-data initializers. */
export function getRuntimeAiOnnxExternalDataPaths(bytes: Uint8Array): string[] {
	let model: onnx.IModelProto;
	try {
		model = onnxProto.ModelProto.decode(bytes);
	} catch (error) {
		throw new Error(`ONNX external-data metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const paths = new Set<string>();
	for (const tensor of model.graph?.initializer ?? []) {
		const location = (tensor.externalData ?? []).find((entry) => entry.key === "location")?.value;
		if (!location) {
			continue;
		}
		if (
			location.length > 2048 ||
			location.startsWith("/") ||
			location.includes("\\") ||
			location.includes("://") ||
			hasControlCharacters(location) ||
			location.split("/").some((part) => part === ".." || part === "." || part === "")
		) {
			throw new Error(`ONNX external-data location is unsafe: ${location}.`);
		}
		paths.add(location);
		if (paths.size > 128) {
			throw new Error("ONNX model references more than 128 external-data files.");
		}
	}
	return [...paths].sort();
}

class FlatBufferReader {
	private readonly _view: DataView;

	public constructor(private readonly _bytes: Uint8Array) {
		this._view = new DataView(_bytes.buffer, _bytes.byteOffset, _bytes.byteLength);
	}

	public root(): number {
		return this._uint32(0);
	}

	public int8(offset: number): number {
		this._range(offset, 1, "int8");
		return this._view.getInt8(offset);
	}

	public int32(offset: number): number {
		this._range(offset, 4, "int32");
		return this._view.getInt32(offset, true);
	}

	public uint32(offset: number): number {
		return this._uint32(offset);
	}

	public field(table: number, index: number): number {
		this._range(table, 4, "table");
		if (!Number.isSafeInteger(index) || index < 0 || index > 1024) {
			throw new Error("LiteRT FlatBuffer field index is invalid.");
		}
		const vtable = table - this.int32(table);
		this._range(vtable, 4, "vtable");
		const vtableLength = this._view.getUint16(vtable, true);
		if (vtableLength < 4) {
			throw new Error("LiteRT FlatBuffer vtable length is invalid.");
		}
		this._range(vtable, vtableLength, "vtable");
		const entry = vtable + 4 + index * 2;
		if (entry + 2 > vtable + vtableLength) {
			return 0;
		}
		const relative = this._view.getUint16(entry, true);
		return relative ? table + relative : 0;
	}

	public indirect(offset: number): number {
		const target = offset + this._uint32(offset);
		this._range(target, 1, "indirect table");
		return target;
	}

	public vector(field: number, maximum: number, elementBytes: number): { start: number; length: number } {
		if (!field) {
			return { start: 0, length: 0 };
		}
		const vector = this.indirect(field);
		const length = this._uint32(vector);
		if (length > maximum) {
			throw new Error(`LiteRT FlatBuffer vector contains more than ${maximum.toLocaleString()} values.`);
		}
		const bytes = length * elementBytes;
		if (!Number.isSafeInteger(bytes)) {
			throw new Error("LiteRT FlatBuffer vector size is invalid.");
		}
		this._range(vector + 4, bytes, "vector");
		return { start: vector + 4, length };
	}

	public tableVector(table: number, index: number, maximum = maximumGraphValues): number[] {
		const vector = this.vector(this.field(table, index), maximum, 4);
		return Array.from({ length: vector.length }, (_, item) => this.indirect(vector.start + item * 4));
	}

	public int32Vector(table: number, index: number, maximum = maximumGraphValues): number[] {
		const vector = this.vector(this.field(table, index), maximum, 4);
		return Array.from({ length: vector.length }, (_, item) => this.int32(vector.start + item * 4));
	}

	public string(field: number): string {
		if (!field) {
			return "";
		}
		const start = this.indirect(field);
		const length = this._uint32(start);
		if (length > maximumFlatBufferStringBytes) {
			throw new Error(`LiteRT FlatBuffer string exceeds ${maximumFlatBufferStringBytes.toLocaleString()} bytes.`);
		}
		this._range(start + 4, length, "string");
		return textDecoder.decode(this._bytes.subarray(start + 4, start + 4 + length));
	}

	private _uint32(offset: number): number {
		this._range(offset, 4, "uint32");
		return this._view.getUint32(offset, true);
	}

	private _range(offset: number, length: number, label: string): void {
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this._bytes.length) {
			throw new Error(`LiteRT FlatBuffer ${label} is outside the model bytes.`);
		}
	}
}

const liteRtBuiltinOperators: Record<number, string> = {
	0: "ADD",
	1: "AVERAGE_POOL_2D",
	2: "CONCATENATION",
	3: "CONV_2D",
	4: "DEPTHWISE_CONV_2D",
	6: "DEQUANTIZE",
	9: "FULLY_CONNECTED",
	17: "MAX_POOL_2D",
	18: "MUL",
	19: "RELU",
	21: "RELU6",
	22: "RESHAPE",
	25: "SOFTMAX",
	28: "TANH",
	34: "PAD",
	39: "TRANSPOSE",
	40: "MEAN",
	41: "SUB",
	42: "DIV",
	43: "SQUEEZE",
	47: "EXP",
	49: "SPLIT",
	53: "CAST",
	55: "MAXIMUM",
	57: "MINIMUM",
	58: "LESS",
	61: "GREATER",
	62: "GREATER_EQUAL",
	63: "LESS_EQUAL",
	65: "SLICE",
	67: "TRANSPOSE_CONV",
	71: "EQUAL",
	72: "NOT_EQUAL",
	83: "PACK",
	88: "UNPACK",
	92: "SQUARE",
	98: "LEAKY_RELU",
	101: "ABS",
	114: "QUANTIZE",
	118: "IF",
	119: "WHILE",
	126: "BATCH_MATMUL",
	130: "GELU",
	136: "RANDOM_STANDARD_NORMAL",
	142: "REDUCE_ALL",
	144: "COS",
	145: "WHERE",
	150: "LOG",
	155: "SCATTER_ND",
	157: "DILATE",
	158: "STABLEHLO_LOGISTIC",
};

function liteRtGraph(bytes: Uint8Array): IRuntimeAiModelGraph {
	if (bytes.length < 16 || textDecoder.decode(bytes.subarray(4, 8)) !== "TFL3") {
		throw new Error("LiteRT model is not a valid TFL3 FlatBuffer.");
	}
	const reader = new FlatBufferReader(bytes);
	const model = reader.root();
	const operatorCodes = reader.tableVector(model, 1, maximumGraphNodes).map((table) => {
		const builtinField = reader.field(table, 3);
		const deprecatedField = reader.field(table, 0);
		const code = builtinField ? reader.int32(builtinField) : deprecatedField ? reader.int8(deprecatedField) : 0;
		const custom = reader.string(reader.field(table, 1));
		return custom || liteRtBuiltinOperators[code] || `BUILTIN_${code}`;
	});
	const subgraphs = reader.tableVector(model, 2, 1024);
	if (!subgraphs.length) {
		throw new Error("LiteRT model does not contain a subgraph.");
	}
	const subgraph = subgraphs[0];
	const tensors = reader.tableVector(subgraph, 0, maximumGraphValues).map((table, index) => reader.string(reader.field(table, 3)) || `tensor_${index}`);
	const operators = reader.tableVector(subgraph, 3, maximumGraphNodes);
	if (operators.length > maximumGraphNodes) {
		throw new Error(`Runtime AI graph contains more than ${maximumGraphNodes.toLocaleString()} nodes.`);
	}
	const description = reader.string(reader.field(model, 3));
	return {
		name: reader.string(reader.field(subgraph, 4)) || "LiteRT subgraph 0",
		format: "litert",
		producer: description || "LiteRT FlatBuffer",
		version: String(reader.field(model, 0) ? reader.int32(reader.field(model, 0)) : 0),
		inputs: reader.int32Vector(subgraph, 1, maximumGraphValues).map((index) => tensors[index] ?? `tensor_${index}`),
		outputs: reader.int32Vector(subgraph, 2, maximumGraphValues).map((index) => tensors[index] ?? `tensor_${index}`),
		nodes: operators.map((table, index) => {
			const opcodeField = reader.field(table, 0);
			const opcode = opcodeField ? reader.uint32(opcodeField) : 0;
			const operator = operatorCodes[opcode] ?? `OPERATOR_CODE_${opcode}`;
			return {
				id: `litert-${index}`,
				name: `${operator} ${index + 1}`,
				operator,
				domain: "litert.builtin",
				inputs: reader
					.int32Vector(table, 1, maximumGraphValues)
					.filter((value) => value >= 0)
					.map((value) => tensors[value] ?? `tensor_${value}`),
				outputs: reader
					.int32Vector(table, 2, maximumGraphValues)
					.filter((value) => value >= 0)
					.map((value) => tensors[value] ?? `tensor_${value}`),
			};
		}),
		initializers: Math.max(0, reader.tableVector(model, 4).length - 1),
		warnings: subgraphs.length > 1 ? [`Visualizer shows the primary subgraph; ${subgraphs.length - 1} nested subgraph(s) remain compiled and executable.`] : [],
	};
}

/** Decodes a bounded model graph for the Runtime AI workspace and MCP inspection. */
export function inspectRuntimeAiModelGraph(format: RuntimeAiModelFormat, bytes: Uint8Array): IRuntimeAiModelGraph {
	try {
		if (format === "onnx") {
			return onnxGraph(bytes);
		}
		if (format === "litert") {
			return liteRtGraph(bytes);
		}
		throw new Error("PyTorch Export graphs are decoded while lowering their Core ATen program.");
	} catch (error) {
		throw new Error(`Runtime AI ${format} graph is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
}
