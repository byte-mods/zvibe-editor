import { afterEach, describe, expect, test } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { onnx } from "onnx-proto";

import { normalizeRuntimeAiSessionOptions, resolveRuntimeAiBackend, RuntimeAiSession } from "../../src/loading/runtime-ai";
import { detectRuntimeAiModelFormat, inspectRuntimeAiModelGraph } from "../../src/loading/runtime-ai-model";

const identityModel = Uint8Array.from(
	Buffer.from(
		"CAgSCVp2aWJlVGVzdDpjCicKBWlucHV0EgZvdXRwdXQaDElkZW50aXR5Tm9kZSIISWRlbnRpdHkSDUlkZW50aXR5R3JhcGhaEwoFaW5wdXQSCgoICAESBAoCCAFiFAoGb3V0cHV0EgoKCAgBEgQKAggBQgIQDQ==",
		"base64"
	)
);

const liteRtIdentityModel = Uint8Array.from(
	Buffer.from(
		"HAAAAFRGTDMUACAAHAAYABQAEAAMAAAACAAEABQAAAAcAAAAHAAAAHQAAAAgAQAAMAEAAHQCAAADAAAAAAAAAAIAAAA0AAAABAAAANz///8FAAAABAAAABMAAABDT05WRVJTSU9OX01FVEFEQVRBAAgADAAIAAQACAAAAAQAAAAEAAAAEwAAAG1pbl9ydW50aW1lX3ZlcnNpb24ABgAAAKgAAACgAAAAmAAAAJAAAABwAAAABAAAAJ7///8EAAAAVAAAAAwAAAAIAA4ACAAEAAgAAAAQAAAAJAAAAAAABgAIAAQABgAAAAQAAAAAAAAAAAAKABAADAAIAAQACgAAAAMAAAACAAAABAAAAAYAAAAyLjE2LjEAAAAABgAIAAQABgAAAAQAAAAQAAAAMS41LjAAAAAAAAAAAAAAAIz+//+Q/v//lP7//5j+//8PAAAATUxJUiBDb252ZXJ0ZWQuAAEAAAAUAAAAAAAOABgAFAAQAAwACAAEAA4AAAAUAAAAHAAAAFwAAABgAAAAaAAAAAQAAABtYWluAAAAAAEAAAAUAAAAAAAOABQAAAAQAAwACwAEAA4AAAAQAAAAAAAACwwAAAAQAAAAGP///wEAAAACAAAAAgAAAAAAAAABAAAAAQAAAAIAAAACAAAAAAAAAAEAAAADAAAAhAAAADwAAAAEAAAAnv///wAAAAEQAAAAEAAAAAMAAAAYAAAAbP///wgAAABJZGVudGl0eQAAAAABAAAABwAAANL///8AAAABEAAAABAAAAACAAAAEAAAAKD///8BAAAAeQAAAAEAAAAHAAAAAAAWABgAFAAAABAADAAIAAAAAAAAAAcAFgAAAAAAAAEQAAAAEAAAAAEAAAAQAAAA5P///wEAAAB4AAAAAQAAAAEAAAABAAAACAAAAAQABAAEAAAA",
		"base64"
	)
);

function externalOnnxModel(): Uint8Array {
	const model = onnx.ModelProto.create({
		irVersion: 8,
		producerName: "Zvibe Runtime AI test",
		opsetImport: [{ domain: "", version: 18 }],
		graph: {
			name: "External weights",
			input: [{ name: "input", type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: 1 }] } } } }],
			output: [{ name: "output", type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: 1 }] } } } }],
			node: [{ name: "Add", opType: "Add", input: ["input", "weight"], output: ["output"] }],
			initializer: [{ name: "weight", dataType: 1, dims: [1], dataLocation: 1, externalData: [{ key: "location", value: "weights/weight.bin" }] }],
		},
	});
	const verification = onnx.ModelProto.verify(model);
	if (verification) throw new Error(verification);
	return onnx.ModelProto.encode(model).finish();
}

function tensorMetadata(sizes: number[], dtype = 7): Record<string, unknown> {
	return {
		dtype,
		sizes: sizes.map((as_int) => ({ as_int })),
		requires_grad: false,
		device: { type: "cpu", index: null },
		strides: sizes.map((_, index) => ({ as_int: sizes.slice(index + 1).reduce((total, value) => total * value, 1) })),
		storage_offset: { as_int: 0 },
		layout: 7,
	};
}

function rewritePt2(transform: (document: Record<string, any>) => void): Uint8Array {
	const files = unzipSync(arithmeticPt2());
	const modelPath = Object.keys(files).find((path) => path.endsWith("/models/model.json"))!;
	const document = JSON.parse(new TextDecoder().decode(files[modelPath]));
	transform(document);
	files[modelPath] = strToU8(JSON.stringify(document));
	return zipSync(files);
}

function statefulLinearPt2(): Uint8Array {
	const tensor = (name: string): Record<string, unknown> => ({ as_tensor: { name } });
	const weight = tensorMetadata([2, 3]);
	const bias = tensorMetadata([2]);
	const counter = tensorMetadata([], 5);
	const document = {
		schema_version: { major: 8, minor: 15 },
		torch_version: "2.10.0",
		graph_module: {
			graph: {
				inputs: [tensor("p_weight"), tensor("p_bias"), tensor("b_counter"), tensor("x")],
				outputs: [tensor("linear")],
				nodes: [
					{
						target: "torch.ops.aten.linear.default",
						inputs: [
							{ name: "input", arg: tensor("x"), kind: 1 },
							{ name: "weight", arg: tensor("p_weight"), kind: 1 },
							{ name: "bias", arg: tensor("p_bias"), kind: 1 },
						],
						outputs: [tensor("linear")],
						metadata: {},
						is_hop_single_tensor_return: null,
					},
				],
				tensor_values: { p_weight: weight, p_bias: bias, b_counter: counter, x: tensorMetadata([1, 3]), linear: tensorMetadata([1, 2]) },
			},
			signature: {
				input_specs: [
					{ parameter: { arg: { name: "p_weight" }, parameter_name: "linear.weight" } },
					{ parameter: { arg: { name: "p_bias" }, parameter_name: "linear.bias" } },
					{ buffer: { arg: { name: "b_counter" }, buffer_name: "counter", persistent: true } },
					{ user_input: { arg: tensor("x") } },
				],
				output_specs: [{ user_output: { arg: tensor("linear") } }],
			},
		},
	};
	const floatBytes = (values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
	const counterBytes = new Uint8Array(new BigInt64Array([0n]).buffer);
	return zipSync({
		"linear/models/model.json": strToU8(JSON.stringify(document)),
		"linear/data/weights/model_weights_config.json": strToU8(
			JSON.stringify({
				config: {
					"linear.weight": { path_name: "weight_0", is_param: true, use_pickle: false, tensor_meta: weight },
					"linear.bias": { path_name: "weight_1", is_param: true, use_pickle: false, tensor_meta: bias },
					counter: { path_name: "weight_2", is_param: false, use_pickle: false, tensor_meta: counter },
				},
			})
		),
		"linear/data/weights/weight_0": floatBytes([1, 2, 3, 4, 5, 6]),
		"linear/data/weights/weight_1": floatBytes([0.5, -0.5]),
		"linear/data/weights/weight_2": counterBytes,
		"linear/data/constants/model_constants_config.json": strToU8('{"config":{}}'),
		"linear/archive_format": strToU8("pt2"),
		"linear/archive_version": strToU8("0"),
		"linear/byteorder": strToU8("little"),
	});
}

function arithmeticPt2(): Uint8Array {
	const tensor = (name: string): Record<string, unknown> => ({ as_tensor: { name } });
	const node = (target: string, inputs: Array<[string, Record<string, unknown>]>, output: string): Record<string, unknown> => ({
		target,
		inputs: inputs.map(([name, arg]) => ({ name, arg, kind: 1 })),
		outputs: [tensor(output)],
		metadata: {},
		is_hop_single_tensor_return: null,
	});
	const values = Object.fromEntries(["x", "y", "add", "mul", "relu"].map((name) => [name, tensorMetadata([2, 3])]));
	const model = {
		schema_version: { major: 8, minor: 15 },
		torch_version: "2.10.0",
		graph_module: {
			graph: {
				inputs: [tensor("x"), tensor("y")],
				outputs: [tensor("relu")],
				nodes: [
					node(
						"torch.ops.aten.add.Tensor",
						[
							["self", tensor("x")],
							["other", tensor("y")],
						],
						"add"
					),
					node(
						"torch.ops.aten.mul.Tensor",
						[
							["self", tensor("add")],
							["other", { as_float: 2 }],
						],
						"mul"
					),
					node("torch.ops.aten.relu.default", [["self", tensor("mul")]], "relu"),
				],
				tensor_values: values,
			},
			signature: {
				input_specs: ["x", "y"].map((name) => ({ user_input: { arg: tensor(name) } })),
				output_specs: [{ user_output: { arg: tensor("relu") } }],
			},
		},
	};
	return zipSync({
		"arithmetic/models/model.json": strToU8(JSON.stringify(model)),
		"arithmetic/data/weights/model_weights_config.json": strToU8('{"config":{}}'),
		"arithmetic/data/constants/model_constants_config.json": strToU8('{"config":{}}'),
		"arithmetic/archive_format": strToU8("pt2"),
		"arithmetic/archive_version": strToU8("0"),
		"arithmetic/byteorder": strToU8("little"),
	});
}

describe("RuntimeAiSession", () => {
	const sessions: RuntimeAiSession[] = [];

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map((session) => session.dispose()));
	});

	test("normalizes bounded browser-safe ONNX settings", () => {
		expect(normalizeRuntimeAiSessionOptions()).toMatchObject({
			backend: "automatic",
			graphOptimizationLevel: "all",
			executionMode: "sequential",
			wasmNumThreads: 1,
			maximumTensorElements: 16_777_216,
		});
		expect(resolveRuntimeAiBackend("automatic")).toBe("wasm");
		expect(() => normalizeRuntimeAiSessionOptions({ wasmNumThreads: 17 })).toThrow("1 through 16");
		expect(() => normalizeRuntimeAiSessionOptions({ maximumTensorElements: 0 })).toThrow("1 through 16777216");
		expect(() => normalizeRuntimeAiSessionOptions({ enableMemPattern: "yes" as never })).toThrow("must be a boolean");
		expect(() => normalizeRuntimeAiSessionOptions({ liteRtWasmPath: "bad\\path" })).toThrow("forward-slash URL path");
	});

	test("compiles a real ONNX model and executes exact tensor feeds", async () => {
		const session = await RuntimeAiSession.Create(identityModel, { backend: "wasm", wasmNumThreads: 1, maximumTensorElements: 1024 });
		sessions.push(session);
		expect(session.description).toMatchObject({
			backend: "wasm",
			inputs: [{ name: "input", isTensor: true, type: "float32", shape: [1] }],
			outputs: [{ name: "output", isTensor: true, type: "float32", shape: [1] }],
		});

		const result = await session.run({ input: { type: "float32", dims: [1], data: [42.25] } }, ["output"], 5_000);
		expect(result.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
		expect(result.outputs.output).toEqual({ type: "float32", dims: [1], data: [42.25] });
	});

	test("loads exported ONNX external weights through its integrity-checked build manifest", async () => {
		const model = externalOnnxModel();
		const weights = new Uint8Array(new Float32Array([2.5]).buffer);
		const modelSha256 = createHash("sha256").update(model).digest("hex");
		const weightSha256 = createHash("sha256").update(weights).digest("hex");
		const fingerprint = createHash("sha256").update(model).update("\0").update("weights/weight.bin").update("\0").update(weights).digest("hex");
		const manifest = JSON.stringify({
			version: 3,
			format: "onnx",
			modelBytes: model.byteLength,
			modelSha256,
			externalData: [{ path: "weights/weight.bin", bytes: weights.byteLength, sha256: weightSha256 }],
			liteRtWasmPath: null,
			liteRtWasmRelativePath: null,
			runtimeFiles: [],
			fingerprint,
		});
		const server = createServer((request, response) => {
			if (request.url === "/identity.onnx") response.end(model);
			else if (request.url === "/identity.onnx.bjsai.json") response.end(manifest);
			else if (request.url === "/weights/weight.bin") response.end(weights);
			else {
				response.statusCode = 404;
				response.end();
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Test server did not expose a TCP port.");
			const session = await RuntimeAiSession.CreateFromBuildAsset(`http://127.0.0.1:${address.port}/identity.onnx`, { backend: "wasm", maximumTensorElements: 8 });
			sessions.push(session);
			const result = await session.run({ input: { type: "float32", dims: [1], data: [7.5] } });
			expect(result.outputs.output.data).toEqual([10]);
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});

	test("detects and visualizes real ONNX and LiteRT containers", () => {
		expect(detectRuntimeAiModelFormat(identityModel)).toBe("onnx");
		expect(detectRuntimeAiModelFormat(liteRtIdentityModel)).toBe("litert");
		expect(inspectRuntimeAiModelGraph("onnx", identityModel)).toMatchObject({ format: "onnx", nodes: [{ operator: "Identity" }] });
		expect(inspectRuntimeAiModelGraph("litert", liteRtIdentityModel)).toMatchObject({ format: "litert", nodes: [{ operator: "ADD" }] });
	});

	test("lowers a real-format PyTorch Export Core ATen graph and executes it through Wasm", async () => {
		const session = await RuntimeAiSession.Create(arithmeticPt2(), { backend: "wasm", wasmNumThreads: 1, maximumTensorElements: 1024 });
		sessions.push(session);
		expect(session.description).toMatchObject({
			modelFormat: "pytorchExport",
			runtimeEngine: "onnxruntime-web",
			conversion: { source: "pytorchExport", target: "onnx", schemaVersion: "8.15" },
			graph: { nodes: [{ operator: "aten.add.Tensor" }, { operator: "aten.mul.Tensor" }, { operator: "aten.relu.default" }] },
		});
		const result = await session.run(
			{
				x: { type: "float32", dims: [2, 3], data: [-2, 1, 3, 4, -5, 6] },
				y: { type: "float32", dims: [2, 3], data: [1, 2, -4, 1, 6, -8] },
			},
			["relu"],
			5_000
		);
		expect(result.outputs.relu).toEqual({ type: "float32", dims: [2, 3], data: [0, 6, 0, 10, 2, 0] });
	});

	test("loads contiguous raw PT2 parameters and the current serialized int64 dtype", async () => {
		const session = await RuntimeAiSession.Create(statefulLinearPt2(), { backend: "wasm", maximumTensorElements: 1024 });
		sessions.push(session);
		const result = await session.run({ x: { type: "float32", dims: [1, 3], data: [1, 2, 3] } });
		expect(result.outputs.linear.data).toEqual([14.5, 31.5]);
		expect(session.description.graph.initializers).toBe(3);
	});

	test("preserves alpha and scalar comparison semantics while rejecting unsupported PT2 options", async () => {
		const alphaModel = rewritePt2((document) => {
			document.graph_module.graph.nodes[0].inputs.push({ name: "alpha", arg: { as_float: 2 }, kind: 1 });
		});
		const alphaSession = await RuntimeAiSession.Create(alphaModel, { backend: "wasm", maximumTensorElements: 1024 });
		sessions.push(alphaSession);
		const alpha = await alphaSession.run({ x: { type: "float32", dims: [2, 3], data: [1, 1, 1, 1, 1, 1] }, y: { type: "float32", dims: [2, 3], data: [2, 2, 2, 2, 2, 2] } });
		expect(alpha.outputs.relu.data).toEqual([10, 10, 10, 10, 10, 10]);

		const comparisonModel = rewritePt2((document) => {
			const graph = document.graph_module.graph;
			graph.nodes = [
				{
					target: "torch.ops.aten.gt.Tensor",
					inputs: [
						{ name: "self", arg: { as_tensor: { name: "x" } }, kind: 1 },
						{ name: "other", arg: { as_float: 0 }, kind: 1 },
					],
					outputs: [{ as_tensor: { name: "greater" } }],
					metadata: {},
					is_hop_single_tensor_return: null,
				},
			];
			graph.tensor_values.greater = tensorMetadata([2, 3], 12);
			document.graph_module.signature.input_specs = [document.graph_module.signature.input_specs[0]];
			document.graph_module.signature.output_specs = [{ user_output: { arg: { as_tensor: { name: "greater" } } } }];
		});
		const comparisonSession = await RuntimeAiSession.Create(comparisonModel, { backend: "wasm", maximumTensorElements: 1024 });
		sessions.push(comparisonSession);
		const comparison = await comparisonSession.run({ x: { type: "float32", dims: [2, 3], data: [-1, 0, 1, 2, -2, 3] } });
		expect(comparison.outputs.greater).toEqual({ type: "bool", dims: [2, 3], data: [false, false, true, true, false, true] });

		const roundedDivision = rewritePt2((document) => {
			document.graph_module.graph.nodes[0].target = "torch.ops.aten.div.Tensor";
			document.graph_module.graph.nodes[0].inputs.push({ name: "rounding_mode", arg: { as_string: "floor" }, kind: 1 });
		});
		await expect(RuntimeAiSession.Create(roundedDivision, { backend: "wasm" })).rejects.toThrow("rounding_mode is not supported");
	});

	test("rejects unsafe and unsupported PT2 archives before compilation", async () => {
		await expect(RuntimeAiSession.Create(zipSync({ "../models/model.json": strToU8("{}") }), { backend: "wasm" })).rejects.toThrow("unsafe path");
		const futureSchema = rewritePt2((document) => {
			document.schema_version.minor = 16;
		});
		await expect(RuntimeAiSession.Create(futureSchema, { backend: "wasm" })).rejects.toThrow("schema 8.16 is not supported");
	});

	test("rejects incomplete, mistyped, mismatched, and unknown tensor requests before execution", async () => {
		const session = await RuntimeAiSession.Create(identityModel, { backend: "wasm", wasmNumThreads: 1, maximumTensorElements: 8 });
		sessions.push(session);
		await expect(session.run({})).rejects.toThrow("Missing: input");
		await expect(session.run({ input: { type: "int32", dims: [1], data: [1] } })).rejects.toThrow("requires float32");
		await expect(session.run({ input: { type: "float32", dims: [2], data: [1, 2] } })).rejects.toThrow("requires 1, not 2");
		await expect(session.run({ input: { type: "float32", dims: [1], data: [1] }, extra: { type: "float32", dims: [1], data: [2] } })).rejects.toThrow("Unknown: extra");
		await expect(session.run({ input: { type: "float32", dims: [1], data: [1] } }, ["missing"])).rejects.toThrow("output selection");
		await session.dispose();
		await expect(session.run({ input: { type: "float32", dims: [1], data: [1] } })).rejects.toThrow("has been disposed");
	});
});
