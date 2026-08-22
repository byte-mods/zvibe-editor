import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const transientMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const idempotentDestructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const modelPath = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+\.(?:onnx|tflite|pt2)$/i, "modelPath must be a relative, traversal-free project .onnx, .tflite, or .pt2 path.")
	.describe("Project-contained .onnx, .tflite, or PyTorch Export .pt2 path, for example assets/models/agent.tflite.");
const sessionId = z
	.string()
	.regex(/^runtime-ai-[1-9][0-9]*$/)
	.describe("Retained session id returned by create_runtime_ai_session.");
const revision = z.number().int().min(1).describe("Exact current session revision returned by list_runtime_ai_sessions or get_runtime_ai_session.");
const fingerprint = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe("Exact lowercase SHA-256 model fingerprint returned by inspect_runtime_ai_model.");
const tensorType = z.enum(["float32", "uint8", "int8", "uint16", "int16", "int32", "int64", "string", "bool", "float16", "float64", "uint32", "uint64", "uint4", "int4"]);
const tensorValue = z.union([z.number().finite(), z.boolean(), z.string().max(256)]);
const tensorInput = z
	.object({
		type: tensorType.describe("Exact model tensor element type reported for this input."),
		dims: z.array(z.number().int().min(0).max(16_777_216)).max(8).describe("Exact concrete tensor shape; use 1 for a symbolic batch axis when running one item."),
		data: z.array(tensorValue).max(1_000_000).describe("Row-major tensor values. int64/uint64 accept base-10 strings to preserve precision."),
	})
	.strict();
const tensorFeeds = z
	.record(z.string().min(1).max(256), tensorInput)
	.refine((value) => Object.keys(value).length <= 64, "A Runtime AI run accepts at most 64 named input tensors.")
	.describe("Exact model feed map. Every model input must be present and unknown names are rejected.");

/** Registers bounded multi-format model inspection, retained sessions, graph evidence, and exact-revision inference tools. */
export function registerRuntimeAiTools(server: McpServer): void {
	server.registerTool(
		"get_runtime_ai_capabilities",
		{
			title: "Get Runtime AI capabilities",
			description:
				"Read ONNX, LiteRT, and bounded Core ATen PyTorch Export support, Wasm/WebGPU availability, graph/external-weight capabilities, exact format limitations, timeout semantics, and memory/tensor/JSON limits.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_runtime_ai_capabilities", {})
	);

	server.registerTool(
		"inspect_runtime_ai_model",
		{
			title: "Inspect Runtime AI model",
			description:
				"Compile one project-contained ONNX, LiteRT, or PyTorch Export asset with its AI Model Importer settings; return exact input/output and bounded node-graph metadata plus SHA-256, then release transient resources.",
			inputSchema: z.object({ modelPath }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_runtime_ai_model", args)
	);

	server.registerTool(
		"create_runtime_ai_session",
		{
			title: "Create Runtime AI session",
			description:
				"Compile and retain one ONNX, LiteRT, or PyTorch Export inference session after optionally leasing the exact inspected model SHA-256; at most four sessions and 512 MiB of model plus companion bytes are retained.",
			inputSchema: z.object({ modelPath, expectedModelSha256: fingerprint.optional() }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_runtime_ai_session", args)
	);

	server.registerTool(
		"list_runtime_ai_sessions",
		{
			title: "List Runtime AI sessions",
			description: "List a bounded page of retained model sessions with exact revisions, fingerprints, backend metadata, run counts, timing, errors, and busy state.",
			inputSchema: z.object({ offset: z.number().int().min(0).max(1_000_000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_runtime_ai_sessions", args)
	);

	server.registerTool(
		"get_runtime_ai_session",
		{
			title: "Get Runtime AI session",
			description:
				"Read one retained multi-format session's exact revision, model identity, graph/tensor metadata, backend, conversion evidence, timing, error, and lifecycle state.",
			inputSchema: z.object({ id: sessionId }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_runtime_ai_session", args)
	);

	server.registerTool(
		"run_runtime_ai_inference",
		{
			title: "Run Runtime AI inference",
			description:
				"Under an exact session revision, validate complete typed tensor feeds, run one bounded ONNX, LiteRT, or lowered-PyTorch inference, and return selected outputs with explicit truncation statistics. ONNX/lowered-PT2 can terminate cooperatively; LiteRT checks its deadline after the non-interruptible native Wasm/WebGPU call completes.",
			inputSchema: z
				.object({
					id: sessionId,
					expectedRevision: revision,
					inputs: tensorFeeds,
					outputNames: z.array(z.string().min(1).max(256)).min(1).max(128).optional(),
					timeoutMilliseconds: z.number().int().min(1).max(300_000).optional(),
					maximumOutputValues: z.number().int().min(1).max(100_000).optional(),
				})
				.strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("run_runtime_ai_inference", args)
	);

	server.registerTool(
		"dispose_runtime_ai_session",
		{
			title: "Dispose Runtime AI session",
			description: "After confirm=true, release one idle retained Runtime AI session under its exact revision and free its CPU/GPU/Wasm model resources.",
			inputSchema: z.object({ id: sessionId, expectedRevision: revision, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("dispose_runtime_ai_session", args)
	);

	server.registerTool(
		"reset_runtime_ai_runtime",
		{
			title: "Reset Runtime AI runtime",
			description:
				"After confirm=true, release every idle retained Runtime AI session. The operation rejects while any inference is running and is safe to repeat once empty.",
			inputSchema: z.object({ confirm: z.literal(true) }).strict(),
			annotations: idempotentDestructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_runtime_ai_runtime", args)
	);
}
