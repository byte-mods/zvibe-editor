import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callImageTool, callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().min(0);
const connectionId = z.string().uuid();
const platform = z.enum(["android", "ios", "tablet", "desktop-browser"]);
const orientation = z.enum(["portrait", "landscape"]);
const safeArea = z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]);
const profileId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const profileFields = {
	id: profileId,
	name: z.string().min(1).max(80),
	platform,
	width: z.number().int().min(160).max(16384),
	height: z.number().int().min(160).max(16384),
	dpi: z.number().positive().max(2000),
	devicePixelRatio: z.number().positive().max(16),
	safeArea: safeArea.describe("[top, right, bottom, left] pixels in the profile's natural portrait orientation."),
	operatingSystem: z.string().min(1).max(120),
	deviceModel: z.string().min(1).max(120),
	cpuCores: z.number().int().min(1).max(256),
	memoryMB: z.number().int().min(128).max(1048576),
	graphicsApi: z.string().min(1).max(120),
	touchPoints: z.number().int().min(0).max(32),
};

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const networkReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const networkWriteAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const destructiveAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** Registers exact Device Simulator profile authoring and authenticated remote-player Device Lab tools. */
export function registerDeviceToolingTools(server: McpServer): void {
	server.registerTool(
		"get_device_tooling_capabilities",
		{
			title: "Get device tooling capabilities",
			description:
				"Read the honest Device Simulator and remote Device Lab support inventory, including simulated Application/Screen/SystemInfo classes, transport/security model, supported player commands, platforms, and explicit non-simulated limitations.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("get_device_tooling_capabilities")
	);
	server.registerTool(
		"list_device_simulator_profiles",
		{
			title: "List Device Simulator profiles",
			description: "List immutable built-in and project-owned custom Device Simulator definitions, the exact custom-catalog revision, and the active profile id.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("list_device_simulator_profiles")
	);
	server.registerTool(
		"set_device_simulator_profile",
		{
			title: "Set custom Device Simulator profile",
			description:
				"Create or exactly replace a project-owned custom device definition. Built-in definitions are immutable; pass every device field and the exact catalog revision returned by list_device_simulator_profiles.",
			inputSchema: z.object({ expectedRevision: exactRevision, ...profileFields }).strict(),
			annotations: writeAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_device_simulator_profile", args)
	);
	server.registerTool(
		"delete_device_simulator_profile",
		{
			title: "Delete custom Device Simulator profile",
			description: "Delete a project-owned custom profile under the exact catalog revision. Active references are cleared; immutable built-ins cannot be deleted.",
			inputSchema: z.object({ id: profileId, expectedRevision: exactRevision, confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_device_simulator_profile", args)
	);
	server.registerTool(
		"activate_device_simulator_profile",
		{
			title: "Activate Device Simulator profile",
			description:
				"Apply a built-in or custom definition to the actual preview engine view under the current simulation revision, optionally choosing orientation and enabled state. Returns normalized simulated Application, Screen, and SystemInfo values.",
			inputSchema: z.object({ id: profileId, expectedRevision: exactRevision.optional(), enabled: z.boolean().optional(), orientation: orientation.optional() }).strict(),
			annotations: writeAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("activate_device_simulator_profile", args)
	);
	server.registerTool(
		"start_device_lab",
		{
			title: "Start remote Device Lab",
			description:
				"Start a bounded version-1 WebSocket Device Lab and mint a non-persisted, expiring pairing token. Defaults to loopback and an automatic port; LAN listening requires confirm=true and should only be used on a trusted network because transport TLS is external.",
			inputSchema: z
				.object({
					host: z.string().min(1).max(255).optional(),
					advertisedHost: z.string().min(1).max(255).optional(),
					port: z.number().int().min(0).max(65535).optional(),
					pairingMinutes: z.number().int().min(1).max(1440).optional(),
					confirm: z.boolean().optional(),
				})
				.strict(),
			annotations: networkWriteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_device_lab", args)
	);
	server.registerTool(
		"stop_device_lab",
		{
			title: "Stop remote Device Lab",
			description: "Stop the listener, reject pending commands, discard the ephemeral pairing token, and disconnect all remote players.",
			inputSchema: z.object({ confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_device_lab", args)
	);
	server.registerTool(
		"get_device_lab_status",
		{
			title: "Get Device Lab status",
			description:
				"Read listener state, address, pairing expiry/availability, connection and pending-command counts, errors, and security posture without revealing the live token.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("get_device_lab_status")
	);
	server.registerTool(
		"list_remote_devices",
		{
			title: "List remote Device Lab players",
			description: "List authenticated remote-player identities, advertised capabilities, connection activity, and bounded evidence counts.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("list_remote_devices")
	);
	server.registerTool(
		"get_remote_device_logs",
		{
			title: "Get remote device logs",
			description: "Read a bounded, paginated copy of one connected player's structured console stream with optional level and text filtering.",
			inputSchema: z
				.object({
					connectionId,
					offset: z.number().int().nonnegative().optional(),
					limit: z.number().int().min(1).max(1000).optional(),
					levels: z
						.array(z.enum(["debug", "info", "log", "warn", "error"]))
						.min(1)
						.max(5)
						.optional(),
					query: z.string().max(1024).optional(),
				})
				.strict(),
			annotations: networkReadAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_remote_device_logs", args)
	);
	server.registerTool(
		"get_remote_device_metrics",
		{
			title: "Get remote device metrics",
			description: "Read bounded, paginated remote FPS/frame-time/draw-call/resource samples and numeric min/max/average summaries.",
			inputSchema: z.object({ connectionId, offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(1000).optional() }).strict(),
			annotations: networkReadAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_remote_device_metrics", args)
	);
	server.registerTool(
		"capture_remote_device_screenshot",
		{
			title: "Capture remote device screenshot",
			description: "Request and return a bounded PNG screenshot from a connected player that advertised screenshot support.",
			inputSchema: z.object({ connectionId, timeoutMs: z.number().int().min(250).max(30000).optional() }).strict(),
			annotations: networkReadAnnotations,
		},
		async (args): Promise<CallToolResult> => callImageTool("capture_remote_device_screenshot", args)
	);
	server.registerTool(
		"send_remote_device_input",
		{
			title: "Send remote device pointer input",
			description: "Send one confirmed normalized primary-pointer down/move/up command and wait for the remote player's acknowledgement.",
			inputSchema: z
				.object({
					connectionId,
					action: z.enum(["down", "move", "up"]),
					x: z.number().min(0).max(1),
					y: z.number().min(0).max(1),
					timeoutMs: z.number().int().min(250).max(30000).optional(),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: networkWriteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("send_remote_device_input", args)
	);
	server.registerTool(
		"disconnect_remote_device",
		{
			title: "Disconnect remote Device Lab player",
			description: "Close one authenticated player connection and reject its pending commands.",
			inputSchema: z.object({ connectionId, confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("disconnect_remote_device", args)
	);
	server.registerTool(
		"clear_remote_device_data",
		{
			title: "Clear remote device evidence",
			description: "Discard one connected player's in-memory bounded logs, metrics, and latest screenshot without disconnecting it.",
			inputSchema: z.object({ connectionId, confirm: z.literal(true) }).strict(),
			annotations: destructiveAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_remote_device_data", args)
	);
}
