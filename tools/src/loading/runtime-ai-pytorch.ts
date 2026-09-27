import { unzip } from "fflate";
import type { onnx } from "onnx-proto";
import { onnxProto } from "../tools/onnx-proto";

import { IRuntimeAiModelGraph } from "./runtime-ai-model";

export interface IRuntimeAiPyTorchCompilation {
	onnxBytes: Uint8Array;
	graph: IRuntimeAiModelGraph;
	schemaVersion: string;
	supportedOperators: string[];
}

type JsonObject = Record<string, unknown>;
type OnnxNode = onnx.INodeProto;
type OnnxTensor = onnx.ITensorProto;

const maximumArchiveEntries = 4096;
const maximumArchiveBytes = 256 * 1024 * 1024;
const maximumJsonBytes = 64 * 1024 * 1024;
const maximumNodes = 16_384;
const maximumLoweredNodes = maximumNodes * 4;
const maximumGraphValues = 65_536;
const maximumTensorElements = 67_108_864;
const decoder = new TextDecoder("utf-8", { fatal: true });

const pytorchDtypes: Record<number, { onnx: number; bytes: number }> = {
	1: { onnx: 2, bytes: 1 },
	2: { onnx: 3, bytes: 1 },
	3: { onnx: 5, bytes: 2 },
	4: { onnx: 6, bytes: 4 },
	5: { onnx: 7, bytes: 8 },
	6: { onnx: 10, bytes: 2 },
	7: { onnx: 1, bytes: 4 },
	8: { onnx: 11, bytes: 8 },
	12: { onnx: 9, bytes: 1 },
	13: { onnx: 16, bytes: 2 },
	28: { onnx: 4, bytes: 2 },
};

const unaryOperators: Record<string, string> = {
	"torch.ops.aten.abs.default": "Abs",
	"torch.ops.aten.acos.default": "Acos",
	"torch.ops.aten.acosh.default": "Acosh",
	"torch.ops.aten.asin.default": "Asin",
	"torch.ops.aten.asinh.default": "Asinh",
	"torch.ops.aten.atan.default": "Atan",
	"torch.ops.aten.atanh.default": "Atanh",
	"torch.ops.aten.ceil.default": "Ceil",
	"torch.ops.aten.cos.default": "Cos",
	"torch.ops.aten.cosh.default": "Cosh",
	"torch.ops.aten.erf.default": "Erf",
	"torch.ops.aten.exp.default": "Exp",
	"torch.ops.aten.floor.default": "Floor",
	"torch.ops.aten.log.default": "Log",
	"torch.ops.aten.neg.default": "Neg",
	"torch.ops.aten.reciprocal.default": "Reciprocal",
	"torch.ops.aten.relu.default": "Relu",
	"torch.ops.aten.round.default": "Round",
	"torch.ops.aten.sigmoid.default": "Sigmoid",
	"torch.ops.aten.sign.default": "Sign",
	"torch.ops.aten.sin.default": "Sin",
	"torch.ops.aten.sinh.default": "Sinh",
	"torch.ops.aten.sqrt.default": "Sqrt",
	"torch.ops.aten.tan.default": "Tan",
	"torch.ops.aten.tanh.default": "Tanh",
};

const binaryOperators: Record<string, string> = {
	"torch.ops.aten.add.Tensor": "Add",
	"torch.ops.aten.div.Tensor": "Div",
	"torch.ops.aten.eq.Tensor": "Equal",
	"torch.ops.aten.ge.Tensor": "GreaterOrEqual",
	"torch.ops.aten.gt.Tensor": "Greater",
	"torch.ops.aten.le.Tensor": "LessOrEqual",
	"torch.ops.aten.lt.Tensor": "Less",
	"torch.ops.aten.maximum.default": "Max",
	"torch.ops.aten.minimum.default": "Min",
	"torch.ops.aten.mul.Tensor": "Mul",
	"torch.ops.aten.ne.Tensor": "Not",
	"torch.ops.aten.pow.Tensor_Tensor": "Pow",
	"torch.ops.aten.pow.Tensor_Scalar": "Pow",
	"torch.ops.aten.sub.Tensor": "Sub",
};

function object(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`${label} must be an array.`);
	}
	return value;
}

function string(value: unknown, label: string): string {
	if (typeof value !== "string" || !value || value.length > 4096) {
		throw new Error(`${label} must be a non-empty string of at most 4096 characters.`);
	}
	return value;
}

function integer(value: unknown, label: string, minimum = -2_147_483_648, maximum = 2_147_483_647): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value;
}

function finite(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} must be a finite number.`);
	}
	return value;
}

function json(bytes: Uint8Array, label: string): JsonObject {
	if (!bytes.length || bytes.length > maximumJsonBytes) {
		throw new Error(`${label} must contain from 1 byte through ${maximumJsonBytes / (1024 * 1024)} MiB.`);
	}
	try {
		return object(JSON.parse(decoder.decode(bytes)), label);
	} catch (error) {
		throw new Error(`${label} is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function member(value: JsonObject, key: string, label: string): JsonObject {
	return object(value[key], `${label}.${key}`);
}

function optionalMember(value: JsonObject, key: string): JsonObject | null {
	const candidate = value[key];
	return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? (candidate as JsonObject) : null;
}

function tensorName(arg: unknown, label: string): string {
	return string(member(object(arg, label), "as_tensor", label).name, `${label}.as_tensor.name`);
}

function outputNames(node: JsonObject, label: string): string[] {
	return array(node.outputs, `${label}.outputs`).map((value, index) => tensorName(value, `${label}.outputs[${index}]`));
}

function nodeArguments(node: JsonObject, label: string): Map<string, JsonObject> {
	const result = new Map<string, JsonObject>();
	array(node.inputs, `${label}.inputs`).forEach((value, index) => {
		const input = object(value, `${label}.inputs[${index}]`);
		const name = string(input.name, `${label}.inputs[${index}].name`);
		if (result.has(name)) {
			throw new Error(`${label} contains duplicate input argument "${name}".`);
		}
		result.set(name, object(input.arg, `${label}.inputs[${index}].arg`));
	});
	return result;
}

function intArg(arg: JsonObject | undefined, label: string, fallback?: number): number {
	if (!arg) {
		if (fallback !== undefined) {
			return fallback;
		}
		throw new Error(`${label} is required.`);
	}
	return integer(arg.as_int, label);
}

function floatArg(arg: JsonObject | undefined, label: string, fallback?: number): number {
	if (!arg) {
		if (fallback !== undefined) {
			return fallback;
		}
		throw new Error(`${label} is required.`);
	}
	return finite(arg.as_float ?? arg.as_int, label);
}

function boolArg(arg: JsonObject | undefined, label: string, fallback?: boolean): boolean {
	if (!arg) {
		if (fallback !== undefined) {
			return fallback;
		}
		throw new Error(`${label} is required.`);
	}
	if (typeof arg.as_bool !== "boolean") {
		throw new Error(`${label} must be a boolean.`);
	}
	return arg.as_bool;
}

function intsArg(arg: JsonObject | undefined, label: string, fallback?: number[]): number[] {
	if (!arg) {
		if (fallback) {
			return fallback;
		}
		throw new Error(`${label} is required.`);
	}
	return array(arg.as_ints, label).map((value, index) => integer(value, `${label}[${index}]`));
}

function tensorArg(arg: JsonObject | undefined, label: string): string {
	if (!arg) {
		throw new Error(`${label} is required.`);
	}
	return tensorName(arg, label);
}

function isNone(arg: JsonObject | undefined): boolean {
	return !arg || arg.as_none === true;
}

function rejectNonNoneArgument(arg: JsonObject | undefined, label: string): void {
	if (!isNone(arg)) {
		throw new Error(`${label} is not supported by the bounded Core ATen lowering; use its default value or export the model as ONNX.`);
	}
}

function shape(tensorValues: JsonObject, name: string): number[] {
	const value = member(tensorValues, name, `tensor_values.${name}`);
	const sizes = array(value.sizes, `tensor_values.${name}.sizes`);
	if (sizes.length > 8) {
		throw new Error(`PyTorch tensor "${name}" has more than eight dimensions.`);
	}
	let elements = 1;
	const result = sizes.map((entry, index) => {
		const dimension = integer(object(entry, `tensor_values.${name}.sizes[${index}]`).as_int, `tensor_values.${name}.sizes[${index}].as_int`, 0, maximumTensorElements);
		elements *= dimension;
		if (!Number.isSafeInteger(elements) || elements > maximumTensorElements) {
			throw new Error(`PyTorch tensor "${name}" exceeds ${maximumTensorElements.toLocaleString()} elements.`);
		}
		return dimension;
	});
	return result;
}

function dtype(tensorValues: JsonObject, name: string): { onnx: number; bytes: number } {
	const code = integer(member(tensorValues, name, `tensor_values.${name}`).dtype, `tensor_values.${name}.dtype`, 0, 255);
	const result = pytorchDtypes[code];
	if (!result) {
		throw new Error(`PyTorch tensor "${name}" uses unsupported scalar type ${code}.`);
	}
	return result;
}

function valueInfo(tensorValues: JsonObject, name: string): onnx.IValueInfoProto {
	return {
		name,
		type: { tensorType: { elemType: dtype(tensorValues, name).onnx, shape: { dim: shape(tensorValues, name).map((dimValue) => ({ dimValue })) } } },
	};
}

function tensorInitializer(name: string, tensorValues: JsonObject, bytes: Uint8Array): OnnxTensor {
	const type = dtype(tensorValues, name);
	const dimensions = shape(tensorValues, name);
	const expected = dimensions.reduce((total, value) => total * value, 1) * type.bytes;
	if (bytes.length !== expected) {
		throw new Error(`PyTorch tensor "${name}" contains ${bytes.length} bytes; its metadata requires ${expected}.`);
	}
	const metadata = member(tensorValues, name, `tensor_values.${name}`);
	if (integer(object(metadata.storage_offset, `tensor_values.${name}.storage_offset`).as_int, `tensor_values.${name}.storage_offset.as_int`) !== 0) {
		throw new Error(`PyTorch tensor "${name}" uses a non-zero storage offset, which is not portable.`);
	}
	const actualStrides = array(metadata.strides, `tensor_values.${name}.strides`).map((value, index) =>
		integer(object(value, `tensor_values.${name}.strides[${index}]`).as_int, `tensor_values.${name}.strides[${index}].as_int`, 0, maximumTensorElements)
	);
	let stride = 1;
	const expectedStrides = Array(dimensions.length);
	for (let index = dimensions.length - 1; index >= 0; index--) {
		expectedStrides[index] = stride;
		stride *= Math.max(dimensions[index], 1);
	}
	if (actualStrides.length !== expectedStrides.length || actualStrides.some((value, index) => value !== expectedStrides[index])) {
		throw new Error(`PyTorch tensor "${name}" uses non-contiguous storage; export contiguous state tensors or convert the model to ONNX.`);
	}
	return { name, dataType: type.onnx, dims: dimensions, rawData: bytes };
}

function attributeInt(name: string, value: number): onnx.IAttributeProto {
	return { name, type: 2, i: value };
}

function attributeInts(name: string, values: number[]): onnx.IAttributeProto {
	return { name, type: 7, ints: values };
}

function attributeFloat(name: string, value: number): onnx.IAttributeProto {
	return { name, type: 1, f: value };
}

function rawInt64(values: number[]): Uint8Array {
	const buffer = new ArrayBuffer(values.length * 8);
	const view = new DataView(buffer);
	values.forEach((value, index) => view.setBigInt64(index * 8, BigInt(value), true));
	return new Uint8Array(buffer);
}

function float32Bits(value: number): number {
	return new Uint32Array(new Float32Array([value]).buffer)[0];
}

function float16Bits(value: number): number {
	const bits = float32Bits(value);
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

function rawScalar(value: number | boolean, onnxType: number): Uint8Array {
	const widths: Record<number, number> = { 1: 4, 2: 1, 3: 1, 5: 2, 6: 4, 7: 8, 9: 1, 10: 2, 11: 8, 16: 2 };
	const width = widths[onnxType];
	if (!width) {
		throw new Error(`Scalar initializer uses unsupported ONNX type ${onnxType}.`);
	}
	const buffer = new ArrayBuffer(width);
	const view = new DataView(buffer);
	const numberValue = typeof value === "boolean" ? (value ? 1 : 0) : value;
	if ([2, 3, 4, 5, 6, 7, 9].includes(onnxType) && !Number.isInteger(numberValue)) {
		throw new Error(`Integer scalar initializer cannot encode non-integer value ${numberValue}.`);
	}
	const integerRange: Record<number, [number, number]> = {
		2: [0, 255],
		3: [-128, 127],
		4: [0, 65_535],
		5: [-32_768, 32_767],
		6: [-2_147_483_648, 2_147_483_647],
		7: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
		9: [0, 1],
	};
	const range = integerRange[onnxType];
	if (range && (numberValue < range[0] || numberValue > range[1])) {
		throw new Error(`Scalar initializer value ${numberValue} is outside the target tensor type range.`);
	}
	if (onnxType === 1) {
		view.setFloat32(0, numberValue, true);
	} else if (onnxType === 11) {
		view.setFloat64(0, numberValue, true);
	} else if (onnxType === 7) {
		view.setBigInt64(0, BigInt(numberValue), true);
	} else if (onnxType === 6) {
		view.setInt32(0, numberValue, true);
	} else if (onnxType === 5) {
		view.setInt16(0, numberValue, true);
	} else if (onnxType === 4) {
		view.setUint16(0, numberValue, true);
	} else if (onnxType === 10) {
		view.setUint16(0, float16Bits(numberValue), true);
	} else if (onnxType === 16) {
		view.setUint16(0, (float32Bits(numberValue) + 0x7fff + ((float32Bits(numberValue) >>> 16) & 1)) >>> 16, true);
	} else if (onnxType === 3) {
		view.setInt8(0, numberValue);
	} else {
		view.setUint8(0, numberValue);
	}
	return new Uint8Array(buffer);
}

class GraphBuilder {
	public readonly nodes: OnnxNode[] = [];
	public readonly initializers: OnnxTensor[] = [];
	public readonly supported = new Set<string>();
	private _counter = 0;

	public constructor(private readonly _tensorValues: JsonObject) {}

	public addNode(opType: string, inputs: string[], outputs: string[], attributes: onnx.IAttributeProto[] = [], name?: string): void {
		if (this.nodes.length >= maximumLoweredNodes) {
			throw new Error(`Lowered PyTorch graph exceeds ${maximumLoweredNodes.toLocaleString()} ONNX nodes.`);
		}
		this.nodes.push({ name: name || `${opType}_${this._counter++}`, opType, input: inputs, output: outputs, attribute: attributes });
	}

	public axes(values: number[], label: string): string {
		if (this.initializers.length >= maximumGraphValues) {
			throw new Error(`Lowered PyTorch graph exceeds ${maximumGraphValues.toLocaleString()} initializers.`);
		}
		const name = `zvibe_${label}_${this._counter++}`;
		this.initializers.push({ name, dataType: 7, dims: [values.length], rawData: rawInt64(values) });
		return name;
	}

	public scalar(arg: JsonObject, reference: string, label: string): string {
		if (this.initializers.length >= maximumGraphValues) {
			throw new Error(`Lowered PyTorch graph exceeds ${maximumGraphValues.toLocaleString()} initializers.`);
		}
		const value = typeof arg.as_bool === "boolean" ? arg.as_bool : finite(arg.as_float ?? arg.as_int, label);
		const name = `zvibe_${label}_${this._counter++}`;
		const type = dtype(this._tensorValues, reference).onnx;
		this.initializers.push({ name, dataType: type, dims: [], rawData: rawScalar(value, type) });
		return name;
	}

	public input(arg: JsonObject | undefined, reference: string, label: string): string {
		if (!arg) {
			throw new Error(`${label} is required.`);
		}
		if (arg.as_tensor) {
			return tensorName(arg, label);
		}
		if (arg.as_int !== undefined || arg.as_float !== undefined || arg.as_bool !== undefined) {
			return this.scalar(arg, reference, label);
		}
		throw new Error(`${label} must be a tensor or scalar.`);
	}
}

function normalizedAxis(axis: number, rank: number, label: string): number {
	const result = axis < 0 ? axis + rank : axis;
	if (result < 0 || result >= rank) {
		throw new Error(`${label} axis ${axis} is outside rank ${rank}.`);
	}
	return result;
}

function positiveDimensions(values: number[], label: string, allowZero: boolean): void {
	for (const [index, value] of values.entries()) {
		if (value < (allowZero ? 0 : 1)) {
			throw new Error(`${label}[${index}] must be ${allowZero ? "non-negative" : "positive"}.`);
		}
	}
}

function lowerNode(builder: GraphBuilder, node: JsonObject, tensorValues: JsonObject, index: number): void {
	const label = `graph.nodes[${index}]`;
	const target = string(node.target, `${label}.target`);
	const args = nodeArguments(node, label);
	const outputs = outputNames(node, label);
	if (!outputs.length) {
		throw new Error(`${label} does not produce an output tensor.`);
	}
	const reference = outputs[0];
	const unary = unaryOperators[target];
	if (unary) {
		builder.addNode(unary, [tensorArg(args.get("self"), `${label}.self`)], outputs, [], `aten_${index}_${unary}`);
		builder.supported.add(target);
		return;
	}
	const binary = binaryOperators[target];
	if (binary) {
		const leftArgument = args.get("self");
		const rightArgument = args.get("other") ?? args.get("exponent");
		const tensorReference = leftArgument?.as_tensor ? tensorName(leftArgument, `${label}.self`) : rightArgument?.as_tensor ? tensorName(rightArgument, `${label}.other`) : null;
		if (!tensorReference) {
			throw new Error(`${label} requires at least one tensor operand.`);
		}
		const left = builder.input(leftArgument, tensorReference, `${label}.self`);
		let right = builder.input(rightArgument, tensorReference, `${label}.other`);
		if (target === "torch.ops.aten.add.Tensor" || target === "torch.ops.aten.sub.Tensor") {
			const alpha = args.get("alpha");
			if (alpha && !isNone(alpha)) {
				const alphaValue = floatArg(alpha, `${label}.alpha`);
				if (alphaValue !== 1) {
					const scaled = `zvibe_alpha_scaled_${index}`;
					builder.addNode("Mul", [right, builder.scalar(alpha, tensorReference, `${label}.alpha`)], [scaled], [], `aten_${index}_Alpha`);
					right = scaled;
				}
			}
		}
		if (target === "torch.ops.aten.div.Tensor") {
			rejectNonNoneArgument(args.get("rounding_mode"), `${label}.rounding_mode`);
		}
		if (target === "torch.ops.aten.ne.Tensor") {
			const equal = `zvibe_ne_equal_${index}`;
			builder.addNode("Equal", [left, right], [equal], [], `aten_${index}_Equal`);
			builder.addNode("Not", [equal], outputs, [], `aten_${index}_Not`);
		} else {
			builder.addNode(binary, [left, right], outputs, [], `aten_${index}_${binary}`);
		}
		builder.supported.add(target);
		return;
	}
	if (["torch.ops.aten.alias.default", "torch.ops.aten.clone.default", "torch.ops.aten.contiguous.default", "torch.ops.aten.detach.default"].includes(target)) {
		builder.addNode("Identity", [tensorArg(args.get("self") ?? args.get("input"), `${label}.input`)], outputs, [], `aten_${index}_Identity`);
		builder.supported.add(target);
		return;
	}
	if (["torch.ops.aten.matmul.default", "torch.ops.aten.mm.default", "torch.ops.aten.bmm.default"].includes(target)) {
		builder.addNode(
			"MatMul",
			[builder.input(args.get("self"), reference, `${label}.self`), builder.input(args.get("other") ?? args.get("mat2"), reference, `${label}.other`)],
			outputs
		);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.linear.default") {
		const weight = tensorArg(args.get("weight"), `${label}.weight`);
		const transposed = `zvibe_linear_weight_${index}`;
		const product = isNone(args.get("bias")) ? outputs[0] : `zvibe_linear_product_${index}`;
		builder.addNode("Transpose", [weight], [transposed], [attributeInts("perm", [1, 0])], `aten_${index}_TransposeWeight`);
		builder.addNode("MatMul", [tensorArg(args.get("input"), `${label}.input`), transposed], [product], [], `aten_${index}_MatMul`);
		if (!isNone(args.get("bias"))) {
			builder.addNode("Add", [product, tensorArg(args.get("bias"), `${label}.bias`)], outputs, [], `aten_${index}_Bias`);
		}
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.conv2d.default") {
		const input = tensorArg(args.get("input"), `${label}.input`);
		const rank = shape(tensorValues, input).length - 2;
		if (rank !== 2) {
			throw new Error(`${label}.input must be a rank-4 NCHW tensor.`);
		}
		const stride = intsArg(args.get("stride"), `${label}.stride`, Array(rank).fill(1));
		const padding = intsArg(args.get("padding"), `${label}.padding`, Array(rank).fill(0));
		const dilation = intsArg(args.get("dilation"), `${label}.dilation`, Array(rank).fill(1));
		for (const [name, values] of [
			["stride", stride],
			["padding", padding],
			["dilation", dilation],
		] as const) {
			if (values.length !== 2) {
				throw new Error(`${label}.${name} must contain exactly two values.`);
			}
		}
		positiveDimensions(stride, `${label}.stride`, false);
		positiveDimensions(padding, `${label}.padding`, true);
		positiveDimensions(dilation, `${label}.dilation`, false);
		const groups = intArg(args.get("groups"), `${label}.groups`, 1);
		if (groups < 1) {
			throw new Error(`${label}.groups must be positive.`);
		}
		const inputs = [input, tensorArg(args.get("weight"), `${label}.weight`)];
		if (!isNone(args.get("bias"))) {
			inputs.push(tensorArg(args.get("bias"), `${label}.bias`));
		}
		builder.addNode(
			"Conv",
			inputs,
			outputs,
			[attributeInts("strides", stride), attributeInts("pads", [...padding, ...padding]), attributeInts("dilations", dilation), attributeInt("group", groups)],
			`aten_${index}_Conv`
		);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.batch_norm.default") {
		if (boolArg(args.get("training"), `${label}.training`, false)) {
			throw new Error(`${label} requests training-mode batch normalization; Runtime AI supports inference graphs only.`);
		}
		const epsilon = floatArg(args.get("eps"), `${label}.eps`, 1e-5);
		const momentum = floatArg(args.get("momentum"), `${label}.momentum`, 0.1);
		if (epsilon <= 0) {
			throw new Error(`${label}.eps must be positive.`);
		}
		if (momentum < 0 || momentum > 1) {
			throw new Error(`${label}.momentum must be from 0 through 1.`);
		}
		builder.addNode(
			"BatchNormalization",
			["input", "weight", "bias", "running_mean", "running_var"].map((name) => tensorArg(args.get(name), `${label}.${name}`)),
			outputs,
			[attributeFloat("epsilon", epsilon), attributeFloat("momentum", 1 - momentum)],
			`aten_${index}_BatchNormalization`
		);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.max_pool2d.default" || target === "torch.ops.aten.avg_pool2d.default") {
		const operator = target.includes("max_pool") ? "MaxPool" : "AveragePool";
		const kernel = intsArg(args.get("kernel_size"), `${label}.kernel_size`);
		const stride = intsArg(args.get("stride"), `${label}.stride`, kernel);
		const padding = intsArg(args.get("padding"), `${label}.padding`, Array(kernel.length).fill(0));
		if (kernel.length !== 2 || stride.length !== 2 || padding.length !== 2) {
			throw new Error(`${label} requires two-dimensional kernel, stride, and padding values.`);
		}
		positiveDimensions(kernel, `${label}.kernel_size`, false);
		positiveDimensions(stride, `${label}.stride`, false);
		positiveDimensions(padding, `${label}.padding`, true);
		if (operator === "AveragePool") {
			rejectNonNoneArgument(args.get("divisor_override"), `${label}.divisor_override`);
		}
		const attributes = [
			attributeInts("kernel_shape", kernel),
			attributeInts("strides", stride),
			attributeInts("pads", [...padding, ...padding]),
			attributeInt("ceil_mode", boolArg(args.get("ceil_mode"), `${label}.ceil_mode`, false) ? 1 : 0),
		];
		if (operator === "MaxPool") {
			const dilation = intsArg(args.get("dilation"), `${label}.dilation`, [1, 1]);
			if (dilation.length !== 2) {
				throw new Error(`${label}.dilation must contain exactly two values.`);
			}
			positiveDimensions(dilation, `${label}.dilation`, false);
			attributes.push(attributeInts("dilations", dilation));
		}
		if (operator === "AveragePool") {
			attributes.push(attributeInt("count_include_pad", boolArg(args.get("count_include_pad"), `${label}.count_include_pad`, true) ? 1 : 0));
		}
		builder.addNode(operator, [tensorArg(args.get("self"), `${label}.self`)], outputs, attributes, `aten_${index}_${operator}`);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.flatten.using_ints") {
		const input = tensorArg(args.get("self"), `${label}.self`);
		const rank = shape(tensorValues, input).length;
		const start = normalizedAxis(intArg(args.get("start_dim"), `${label}.start_dim`, 0), rank, `${label}.start_dim`);
		const end = normalizedAxis(intArg(args.get("end_dim"), `${label}.end_dim`, -1), rank, `${label}.end_dim`);
		if (end !== rank - 1) {
			throw new Error(`${label} uses end_dim ${end}; the portable ONNX Flatten lowering requires the final axis.`);
		}
		builder.addNode("Flatten", [input], outputs, [attributeInt("axis", start)], `aten_${index}_Flatten`);
		builder.supported.add(target);
		return;
	}
	if (["torch.ops.aten.reshape.default", "torch.ops.aten.view.default"].includes(target)) {
		const dimensions = intsArg(args.get("shape") ?? args.get("size"), `${label}.shape`);
		if (dimensions.some((value) => value < -1)) {
			throw new Error(`${label}.shape dimensions must be -1 or non-negative.`);
		}
		if (dimensions.filter((value) => value === -1).length > 1) {
			throw new Error(`${label}.shape can infer at most one dimension.`);
		}
		builder.addNode("Reshape", [tensorArg(args.get("self"), `${label}.self`), builder.axes(dimensions, "shape")], outputs, [], `aten_${index}_Reshape`);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.permute.default") {
		const input = tensorArg(args.get("self"), `${label}.self`);
		const rank = shape(tensorValues, input).length;
		const permutation = intsArg(args.get("dims"), `${label}.dims`).map((axis) => normalizedAxis(axis, rank, `${label}.dims`));
		if (permutation.length !== rank || new Set(permutation).size !== rank) {
			throw new Error(`${label}.dims must contain each input axis exactly once.`);
		}
		builder.addNode("Transpose", [input], outputs, [attributeInts("perm", permutation)], `aten_${index}_Transpose`);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.transpose.int") {
		const input = tensorArg(args.get("self"), `${label}.self`);
		const rank = shape(tensorValues, input).length;
		const first = normalizedAxis(intArg(args.get("dim0"), `${label}.dim0`), rank, `${label}.dim0`);
		const second = normalizedAxis(intArg(args.get("dim1"), `${label}.dim1`), rank, `${label}.dim1`);
		const permutation = Array.from({ length: rank }, (_, value) => value);
		[permutation[first], permutation[second]] = [permutation[second], permutation[first]];
		builder.addNode("Transpose", [input], outputs, [attributeInts("perm", permutation)], `aten_${index}_Transpose`);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.unsqueeze.default" || target === "torch.ops.aten.squeeze.dim") {
		const input = tensorArg(args.get("self"), `${label}.self`);
		const inputRank = shape(tensorValues, input).length;
		const axis = normalizedAxis(intArg(args.get("dim"), `${label}.dim`), target.includes("unsqueeze") ? inputRank + 1 : inputRank, `${label}.dim`);
		if (target === "torch.ops.aten.squeeze.dim" && shape(tensorValues, input)[axis] !== 1) {
			builder.addNode("Identity", [input], outputs, [], `aten_${index}_SqueezeIdentity`);
			builder.supported.add(target);
			return;
		}
		const operator = target.includes("unsqueeze") ? "Unsqueeze" : "Squeeze";
		builder.addNode(operator, [input, builder.axes([axis], "axes")], outputs, [], `aten_${index}_${operator}`);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.cat.default") {
		const tensors = array(args.get("tensors")?.as_tensors, `${label}.tensors`).map((value, item) =>
			string(object(value, `${label}.tensors[${item}]`).name, `${label}.tensors[${item}].name`)
		);
		if (!tensors.length) {
			throw new Error(`${label}.tensors must contain at least one tensor.`);
		}
		const axis = normalizedAxis(intArg(args.get("dim"), `${label}.dim`, 0), shape(tensorValues, tensors[0]).length, `${label}.dim`);
		builder.addNode("Concat", tensors, outputs, [attributeInt("axis", axis)], `aten_${index}_Concat`);
		builder.supported.add(target);
		return;
	}
	if (
		target === "torch.ops.aten.softmax.int" ||
		target === "torch.ops.aten.log_softmax.int" ||
		target === "torch.ops.aten._softmax.default" ||
		target === "torch.ops.aten._log_softmax.default"
	) {
		rejectNonNoneArgument(args.get("dtype"), `${label}.dtype`);
		if (args.has("half_to_float") && boolArg(args.get("half_to_float"), `${label}.half_to_float`, false)) {
			throw new Error(`${label}.half_to_float is not supported by the bounded Core ATen lowering; export the model as ONNX.`);
		}
		const operator = target.includes("log_softmax") ? "LogSoftmax" : "Softmax";
		const input = tensorArg(args.get("self"), `${label}.self`);
		const axis = normalizedAxis(intArg(args.get("dim"), `${label}.dim`, -1), shape(tensorValues, input).length, `${label}.dim`);
		builder.addNode(operator, [input], outputs, [attributeInt("axis", axis)], `aten_${index}_${operator}`);
		builder.supported.add(target);
		return;
	}
	if (["torch.ops.aten.mean.dim", "torch.ops.aten.sum.dim_IntList"].includes(target)) {
		const operator = target.includes("mean") ? "ReduceMean" : "ReduceSum";
		rejectNonNoneArgument(args.get("dtype"), `${label}.dtype`);
		const input = tensorArg(args.get("self"), `${label}.self`);
		const rank = shape(tensorValues, input).length;
		const axes = intsArg(args.get("dim"), `${label}.dim`).map((axis) => normalizedAxis(axis, rank, `${label}.dim`));
		if (new Set(axes).size !== axes.length) {
			throw new Error(`${label}.dim contains a duplicate reduction axis.`);
		}
		builder.addNode(
			operator,
			[input, builder.axes(axes, "reduce_axes")],
			outputs,
			[attributeInt("keepdims", boolArg(args.get("keepdim"), `${label}.keepdim`, false) ? 1 : 0)],
			`aten_${index}_${operator}`
		);
		builder.supported.add(target);
		return;
	}
	if (target === "torch.ops.aten.embedding.default") {
		builder.addNode(
			"Gather",
			[tensorArg(args.get("weight"), `${label}.weight`), tensorArg(args.get("indices"), `${label}.indices`)],
			outputs,
			[attributeInt("axis", 0)],
			`aten_${index}_Gather`
		);
		builder.supported.add(target);
		return;
	}
	throw new Error(`Unsupported PyTorch Core ATen operator: ${target}. Export this model as ONNX or rewrite the model with supported inference operators.`);
}

function archiveFile(files: Record<string, Uint8Array>, suffix: string, required = true): { path: string; bytes: Uint8Array } | null {
	const normalizedSuffix = suffix.replace(/^\//, "");
	const matches = Object.entries(files).filter(([path]) => path === normalizedSuffix || path.endsWith(`/${normalizedSuffix}`));
	if (matches.length !== 1) {
		if (!required && matches.length === 0) {
			return null;
		}
		throw new Error(`PyTorch Export archive must contain exactly one ${suffix}; found ${matches.length}.`);
	}
	return { path: matches[0][0], bytes: matches[0][1] };
}

function safeArchivePath(path: string): boolean {
	return !!path && path.length <= 4096 && !path.startsWith("/") && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === "..");
}

function safeArchiveEntry(path: string): boolean {
	return path.endsWith("/") ? safeArchivePath(path.slice(0, -1)) : safeArchivePath(path);
}

async function expandArchive(source: Uint8Array): Promise<Record<string, Uint8Array>> {
	if (!source.length || source.length > maximumArchiveBytes) {
		throw new Error(`PyTorch Export archive must contain from 1 byte through ${maximumArchiveBytes / (1024 * 1024)} MiB.`);
	}
	let count = 0;
	let totalBytes = 0;
	const paths = new Set<string>();
	return new Promise((resolve, reject) => {
		unzip(
			source,
			{
				filter: (file) => {
					count++;
					if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
						throw new Error(`PyTorch Export archive entry has an invalid expanded size: ${file.name}.`);
					}
					totalBytes += file.originalSize;
					if (count > maximumArchiveEntries) {
						throw new Error(`PyTorch Export archive contains more than ${maximumArchiveEntries} entries.`);
					}
					if (!safeArchiveEntry(file.name)) {
						throw new Error(`PyTorch Export archive contains an unsafe path: ${file.name}.`);
					}
					if (paths.has(file.name)) {
						throw new Error(`PyTorch Export archive contains a duplicate path: ${file.name}.`);
					}
					paths.add(file.name);
					if (file.originalSize > maximumArchiveBytes || totalBytes > maximumArchiveBytes) {
						throw new Error(`PyTorch Export expanded archive exceeds ${maximumArchiveBytes / (1024 * 1024)} MiB.`);
					}
					return !file.name.endsWith("/");
				},
			},
			(error, files) => {
				if (error) {
					reject(error);
				} else {
					resolve(files);
				}
			}
		);
	});
}

function validateStateConfiguration(config: JsonObject, tensorValues: JsonObject, graphName: string, stateName: string): void {
	const metadata = object(config.tensor_meta, `state configuration ${stateName}.tensor_meta`);
	const graphMetadata = member(tensorValues, graphName, `tensor_values.${graphName}`);
	const scalarFields = ["dtype", "layout"];
	for (const field of scalarFields) {
		if (metadata[field] !== graphMetadata[field]) {
			throw new Error(`PyTorch state tensor "${stateName}" has mismatched ${field} metadata.`);
		}
	}
	for (const field of ["sizes", "strides"]) {
		const left = JSON.stringify(metadata[field]);
		const right = JSON.stringify(graphMetadata[field]);
		if (left !== right) {
			throw new Error(`PyTorch state tensor "${stateName}" has mismatched ${field} metadata.`);
		}
	}
	const leftOffset = object(metadata.storage_offset, `state configuration ${stateName}.tensor_meta.storage_offset`).as_int;
	const rightOffset = object(graphMetadata.storage_offset, `tensor_values.${graphName}.storage_offset`).as_int;
	if (leftOffset !== rightOffset) {
		throw new Error(`PyTorch state tensor "${stateName}" has mismatched storage_offset metadata.`);
	}
}

/** Validates and lowers a bounded PyTorch Export Core ATen archive to portable ONNX. */
export async function compileRuntimeAiPyTorchExport(source: Uint8Array): Promise<IRuntimeAiPyTorchCompilation> {
	let files: Record<string, Uint8Array>;
	try {
		files = await expandArchive(source);
	} catch (error) {
		throw new Error(`PyTorch Export .pt2 archive is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const paths = Object.keys(files);
	if (!paths.length) {
		throw new Error("PyTorch Export archive does not contain any files.");
	}
	const modelFile = archiveFile(files, "/models/model.json")!;
	const root = modelFile.path.slice(0, -"models/model.json".length);
	const archiveFormat = archiveFile(files, "/archive_format")!;
	if (decoder.decode(archiveFormat.bytes).trim() !== "pt2") {
		throw new Error("PyTorch Export archive_format must be pt2.");
	}
	const byteOrder = archiveFile(files, "/byteorder", false);
	if (byteOrder && decoder.decode(byteOrder.bytes).trim() !== "little") {
		throw new Error("PyTorch Export big-endian tensor archives are not supported.");
	}
	const document = json(modelFile.bytes, "PyTorch Export model.json");
	const schema = member(document, "schema_version", "model");
	const schemaMajor = integer(schema.major, "schema_version.major", 1, 100);
	const schemaMinor = integer(schema.minor, "schema_version.minor", 0, 10_000);
	if (schemaMajor !== 8 || schemaMinor > 15) {
		throw new Error(`PyTorch Export schema ${schemaMajor}.${schemaMinor} is not supported; this lowerer accepts schema 8.0 through 8.15.`);
	}
	const schemaVersion = `${schemaMajor}.${schemaMinor}`;
	const graphModule = member(document, "graph_module", "model");
	const graph = member(graphModule, "graph", "graph_module");
	const signature = member(graphModule, "signature", "graph_module");
	const tensorValues = member(graph, "tensor_values", "graph");
	if (Object.keys(tensorValues).length > maximumGraphValues) {
		throw new Error(`PyTorch Export graph contains more than ${maximumGraphValues.toLocaleString()} tensor values.`);
	}
	const graphNodes = array(graph.nodes, "graph.nodes").map((value, index) => object(value, `graph.nodes[${index}]`));
	if (graphNodes.length > maximumNodes) {
		throw new Error(`PyTorch Export graph contains more than ${maximumNodes.toLocaleString()} nodes.`);
	}
	const inputSpecs = array(signature.input_specs, "signature.input_specs").map((value, index) => object(value, `signature.input_specs[${index}]`));
	const outputSpecs = array(signature.output_specs, "signature.output_specs").map((value, index) => object(value, `signature.output_specs[${index}]`));
	if (inputSpecs.length > maximumGraphValues || outputSpecs.length > maximumGraphValues) {
		throw new Error(`PyTorch Export signature contains more than ${maximumGraphValues.toLocaleString()} inputs or outputs.`);
	}
	const userInputs = inputSpecs
		.map((spec) => optionalMember(spec, "user_input"))
		.filter((value): value is JsonObject => value !== null)
		.map((spec, index) => tensorName(spec.arg, `signature.user_input[${index}].arg`));
	const userOutputs = outputSpecs
		.map((spec) => optionalMember(spec, "user_output"))
		.filter((value): value is JsonObject => value !== null)
		.map((spec, index) => tensorName(spec.arg, `signature.user_output[${index}].arg`));
	if (!userInputs.length || !userOutputs.length) {
		throw new Error("PyTorch Export graph requires at least one tensor user input and output.");
	}
	if (new Set(userInputs).size !== userInputs.length || new Set(userOutputs).size !== userOutputs.length) {
		throw new Error("PyTorch Export graph contains duplicate user input or output tensor names.");
	}
	const weightsFile = archiveFile(files, "/data/weights/model_weights_config.json", false);
	const constantsFile = archiveFile(files, "/data/constants/model_constants_config.json", false);
	const weightConfig = weightsFile ? (optionalMember(json(weightsFile.bytes, "PyTorch weight configuration"), "config") ?? {}) : {};
	const constantConfig = constantsFile ? (optionalMember(json(constantsFile.bytes, "PyTorch constant configuration"), "config") ?? {}) : {};
	const builder = new GraphBuilder(tensorValues);
	const stateNames = new Set<string>();
	const graphStateNames = new Set<string>();
	for (const spec of inputSpecs) {
		const parameter = optionalMember(spec, "parameter");
		const buffer = optionalMember(spec, "buffer");
		const constant = optionalMember(spec, "constant_tensor");
		const source = parameter ?? buffer ?? constant;
		if (!source) {
			continue;
		}
		const graphName = string(member(source, "arg", "signature state input").name, "signature state input arg.name");
		const stateName = string(source.parameter_name ?? source.buffer_name ?? source.constant_name, "signature state input name");
		if (stateNames.has(stateName) || graphStateNames.has(graphName)) {
			throw new Error(`PyTorch state tensor "${stateName}" is declared more than once.`);
		}
		if (userInputs.includes(graphName)) {
			throw new Error(`PyTorch state tensor "${stateName}" collides with a user input named "${graphName}".`);
		}
		stateNames.add(stateName);
		graphStateNames.add(graphName);
		const config = object((parameter || buffer ? weightConfig : constantConfig)[stateName], `state configuration ${stateName}`);
		if (config.use_pickle !== false) {
			throw new Error(`PyTorch state tensor "${stateName}" uses pickle; only raw bounded tensor storage is accepted.`);
		}
		const pathName = string(config.path_name, `state configuration ${stateName}.path_name`);
		if (!safeArchivePath(pathName)) {
			throw new Error(`PyTorch state tensor "${stateName}" uses an unsafe path_name.`);
		}
		validateStateConfiguration(config, tensorValues, graphName, stateName);
		const directory = parameter || buffer ? "weights" : "constants";
		const bytes = files[`${root}data/${directory}/${pathName}`];
		if (!bytes) {
			throw new Error(`PyTorch state tensor "${stateName}" is missing ${pathName}.`);
		}
		builder.initializers.push(tensorInitializer(graphName, tensorValues, bytes));
	}
	const availableTensors = new Set([...userInputs, ...graphStateNames]);
	graphNodes.forEach((node, index) => {
		for (const arg of nodeArguments(node, `graph.nodes[${index}]`).values()) {
			const referenced = arg.as_tensor
				? [tensorName(arg, `graph.nodes[${index}] input`)]
				: Array.isArray(arg.as_tensors)
					? arg.as_tensors.map((value, item) =>
							string(object(value, `graph.nodes[${index}] tensor input ${item}`).name, `graph.nodes[${index}] tensor input ${item}.name`)
						)
					: [];
			for (const name of referenced) {
				if (!Object.hasOwn(tensorValues, name)) {
					throw new Error(`PyTorch graph node ${index} references tensor "${name}" without metadata.`);
				}
				if (!availableTensors.has(name)) {
					throw new Error(`PyTorch graph node ${index} references tensor "${name}" before it is produced.`);
				}
			}
		}
		for (const name of outputNames(node, `graph.nodes[${index}]`)) {
			if (!Object.hasOwn(tensorValues, name)) {
				throw new Error(`PyTorch graph node ${index} produces tensor "${name}" without metadata.`);
			}
			if (availableTensors.has(name)) {
				throw new Error(`PyTorch graph tensor "${name}" is produced more than once.`);
			}
			availableTensors.add(name);
		}
	});
	for (const name of userOutputs) {
		if (!availableTensors.has(name)) {
			throw new Error(`PyTorch user output "${name}" is never produced by the graph.`);
		}
	}
	graphNodes.forEach((node, index) => lowerNode(builder, node, tensorValues, index));
	const onnxGraphValue: onnx.IGraphProto = {
		name: "Zvibe PyTorch Export",
		input: userInputs.map((name) => valueInfo(tensorValues, name)),
		output: userOutputs.map((name) => valueInfo(tensorValues, name)),
		node: builder.nodes,
		initializer: builder.initializers,
	};
	const model = onnxProto.ModelProto.create({
		irVersion: 8,
		producerName: "Zvibe Editor PyTorch Export Lowerer",
		producerVersion: "1.0.0",
		domain: "com.zvibe.runtime-ai",
		modelVersion: 1,
		opsetImport: [{ domain: "", version: 18 }],
		graph: onnxGraphValue,
	});
	const verification = onnxProto.ModelProto.verify(model);
	if (verification) {
		throw new Error(`Lowered PyTorch ONNX graph is invalid: ${verification}.`);
	}
	const onnxBytes = onnxProto.ModelProto.encode(model).finish();
	return {
		onnxBytes,
		schemaVersion,
		supportedOperators: [...builder.supported].sort(),
		graph: {
			name: "PyTorch Export forward",
			format: "pytorchExport",
			producer: typeof document.torch_version === "string" ? `PyTorch ${document.torch_version}` : "PyTorch Export",
			version: schemaVersion,
			inputs: userInputs,
			outputs: userOutputs,
			nodes: graphNodes.map((node, index) => ({
				id: `pytorch-${index}`,
				name: `ATen ${index + 1}`,
				operator: string(node.target, `graph.nodes[${index}].target`).replace(/^torch\.ops\./, ""),
				domain: "pytorch.core-aten",
				inputs: [...nodeArguments(node, `graph.nodes[${index}]`).values()].flatMap((arg) => {
					if (arg.as_tensor) {
						return [tensorName(arg, "node input")];
					}
					if (Array.isArray(arg.as_tensors)) {
						return arg.as_tensors.map((value) => string(object(value, "node tensor input").name, "node tensor input name"));
					}
					return [];
				}),
				outputs: outputNames(node, `graph.nodes[${index}]`),
			})),
			initializers: builder.initializers.length,
			warnings: [
				`Core ATen schema ${schemaVersion} was lowered to ONNX opset 18 for the portable WebGPU/WebAssembly runtime.`,
				"Unsupported operators are rejected during import; no numerical approximation or Python runtime is used.",
			],
		},
	};
}
