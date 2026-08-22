import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const revision = z.number().int().min(1);
const platform = z.enum(["auto", "web", "electron", "android", "ios", "tvos", "visionos", "unknown"]);
const insetType = z.enum(["statusBars", "navigationBars", "ime", "displayCutout", "systemGestures", "mandatorySystemGestures", "tappableElement", "captionBar"]);
const thermalState = z.enum(["unknown", "nominal", "fair", "serious", "critical"]);
const mobileChanges = z
	.object({
		platform: platform.optional(),
		android: z
			.object({
				enabled: z.boolean().optional(),
				decorFitsSystemWindows: z.boolean().optional(),
				requestedVisibleWindowInsets: z.array(insetType).max(8).optional(),
				systemBarsBehavior: z.enum(["default", "show-transient-bars-by-swipe"]).optional(),
			})
			.strict()
			.optional(),
		iosThermalFrameRate: z
			.object({
				enabled: z.boolean().optional(),
				seriousThermalStateFps: z.number().int().min(1).max(240).optional(),
				criticalThermalStateFps: z.number().int().min(1).max(240).optional(),
			})
			.strict()
			.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, { message: "At least one Mobile System change is required." });
const insets = z
	.object({
		left: z.number().finite().min(0).max(16384),
		top: z.number().finite().min(0).max(16384),
		right: z.number().finite().min(0).max(16384),
		bottom: z.number().finite().min(0).max(16384),
	})
	.strict();

const metadata = z.record(z.string().min(1).max(127), z.string().max(8192));
const grpcChanges = z
	.object({
		enabled: z.boolean().optional(),
		endpoint: z.string().url().max(2048).optional(),
		protocol: z.enum(["grpc-web-binary", "grpc-web-text", "connect"]).optional(),
		defaultTimeoutMs: z.number().int().min(1).max(300000).optional(),
		maximumSendMessageBytes: z.number().int().min(1).max(67108864).optional(),
		maximumReceiveMessageBytes: z.number().int().min(1).max(67108864).optional(),
		credentials: z.enum(["omit", "same-origin", "include"]).optional(),
		defaultMetadata: metadata.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, { message: "At least one gRPC transport change is required." });
const grpcCall = z
	.object({
		expectedRevision: revision,
		service: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,254}$/),
		method: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
		payloadBase64: z
			.string()
			.regex(/^[A-Za-z0-9+/]*={0,2}$/)
			.max(100663296),
		metadata: metadata.optional(),
		timeoutMs: z.number().int().min(1).max(300000).optional(),
	})
	.strict();

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const transient = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const network = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function registerMobileSystemTools(server: McpServer): void {
	server.registerTool(
		"get_mobile_system_capabilities",
		{
			title: "Get Mobile System capabilities",
			description:
				"Discover Android inset visibility/system-bar policy, native bridge contract, CSS evidence fallback, Apple Serious/Critical thermal FPS defaults, frame-gate ownership, simulation labels, and hardware boundaries.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_mobile_system_capabilities")
	);
	server.registerTool(
		"get_mobile_system_configuration",
		{
			title: "Get Mobile System configuration",
			description: "Read the normalized exact-revision Android window-inset and iOS thermal frame-rate authoring plus current bounded runtime evidence.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_mobile_system_configuration")
	);
	server.registerTool(
		"set_mobile_system_configuration",
		{
			title: "Set Mobile System configuration",
			description:
				"Patch Android requested visible inset types/system-bar behavior or Apple Serious/Critical FPS under the exact authored revision, with editor undo/redo and runtime replacement.",
			inputSchema: z.object({ expectedRevision: revision, changes: mobileChanges }).strict(),
			annotations: write,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mobile_system_configuration", args)
	);
	server.registerTool(
		"get_mobile_system_runtime",
		{
			title: "Get Mobile System runtime",
			description:
				"Read bridge availability, applied inset policy, current pixel/visibility evidence, thermal source, applied FPS cap, rendered/skipped frames, warnings, errors, and the newest 64 events.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_mobile_system_runtime")
	);
	server.registerTool(
		"simulate_mobile_system_state",
		{
			title: "Simulate Mobile System state",
			description:
				"Under the exact revision, inject clearly labeled non-hardware Android inset and/or Apple thermal evidence for editor verification. This never claims device evidence or changes authoring.",
			inputSchema: z
				.object({
					expectedRevision: revision,
					windowInsets: insets.optional(),
					visibleWindowInsets: z.array(insetType).max(8).optional(),
					thermalState: thermalState.optional(),
				})
				.strict()
				.refine((value) => value.windowInsets !== undefined || value.visibleWindowInsets !== undefined || value.thermalState !== undefined, {
					message: "Provide simulated inset and/or thermal evidence.",
				}),
			annotations: transient,
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_mobile_system_state", args)
	);
	server.registerTool(
		"reset_mobile_system_runtime",
		{
			title: "Reset Mobile System runtime",
			description: "Clear transient inset, thermal, frame-pacing, warning/error, and event evidence under the exact authored revision without changing configuration.",
			inputSchema: z.object({ expectedRevision: revision }).strict(),
			annotations: transient,
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_mobile_system_runtime", args)
	);

	server.registerTool(
		"get_grpc_transport_capabilities",
		{
			title: "Get gRPC transport capabilities",
			description:
				"Discover the portable fetch-based gRPC-Web binary/text and Connect protocols, unary/server-streaming support, framing, trailers, deadlines, message limits, transient metadata, and browser/native HTTP/2 boundaries.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_grpc_transport_capabilities")
	);
	server.registerTool(
		"get_grpc_transport_configuration",
		{
			title: "Get gRPC transport configuration",
			description: "Read the exact-revision endpoint/protocol/deadline/message limits/non-secret default metadata plus bounded call evidence.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_grpc_transport_configuration")
	);
	server.registerTool(
		"set_grpc_transport_configuration",
		{
			title: "Set gRPC transport configuration",
			description:
				"Patch portable gRPC-Web/Connect transport authoring under the exact revision. Remote endpoints require HTTPS, HTTP is loopback-only, and secret-bearing default metadata is rejected.",
			inputSchema: z.object({ expectedRevision: revision, changes: grpcChanges }).strict(),
			annotations: write,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_grpc_transport_configuration", args)
	);
	server.registerTool(
		"invoke_grpc_unary",
		{
			title: "Invoke gRPC unary call",
			description:
				"Send one protobuf message through the authored endpoint and return bounded base64 response, HTTP/gRPC status, exposed headers/trailers, sizes, and duration. Per-call metadata is transient.",
			inputSchema: grpcCall,
			annotations: network,
		},
		async (args): Promise<CallToolResult> => callTextTool("invoke_grpc_unary", args)
	);
	server.registerTool(
		"invoke_grpc_server_stream",
		{
			title: "Invoke gRPC server stream",
			description:
				"Send one protobuf request and collect at most 256 bounded gRPC-Web/Connect server-stream messages with trailers and status. Browser CORS and fetch streaming constraints still apply.",
			inputSchema: grpcCall,
			annotations: network,
		},
		async (args): Promise<CallToolResult> => callTextTool("invoke_grpc_server_stream", args)
	);
	server.registerTool(
		"get_grpc_transport_runtime",
		{
			title: "Get gRPC transport runtime",
			description: "Read bounded non-secret evidence for the newest 32 calls, including protocol, method, sizes, counts, status, duration, and redacted error text.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_grpc_transport_runtime")
	);
}
