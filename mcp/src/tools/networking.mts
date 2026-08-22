import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

type TJson = null | boolean | number | string | TJson[] | { [key: string]: TJson };

const exactRevision = z.number().int().safe().min(1);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const sessionId = z.string().uuid();
const joinCode = z.string().regex(/^[A-Z0-9]{6,12}$/);
const token = z.string().regex(/^[A-Za-z0-9_-]{24,256}$/);
const vector3 = z.tuple([
	z.number().finite().min(-1_000_000).max(1_000_000),
	z.number().finite().min(-1_000_000).max(1_000_000),
	z.number().finite().min(-1_000_000).max(1_000_000),
]);
const jsonValue: z.ZodType<TJson> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(32_768), z.array(jsonValue).max(256), z.record(z.string().min(1).max(128), jsonValue)])
);

const endpoint = z
	.string()
	.min(1)
	.max(2_048)
	.refine((value) => {
		try {
			const url = new URL(value);
			const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
			return ["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && (url.protocol === "wss:" || loopback);
		} catch {
			return false;
		}
	}, "Use an absolute credential-free ws:// loopback or wss:// URL without query or fragment.");

const nonEmpty = <T extends z.ZodRawShape>(schema: z.ZodObject<T>) =>
	schema
		.strict()
		.partial()
		.refine((value) => Object.keys(value).length > 0, "Provide at least one change.");

const transportChanges = nonEmpty(
	z.object({
		mode: z.literal("websocket"),
		endpoint: endpoint.nullable(),
		autoConnect: z.boolean(),
		reconnect: z.boolean(),
		connectionTimeoutMs: z.number().int().min(250).max(120_000),
		maximumMessageBytes: z.number().int().min(1_024).max(4_194_304),
	})
);
const replicationChanges = nonEmpty(
	z.object({
		tickRateHz: z.number().int().min(1).max(240),
		snapshotRateHz: z.number().int().min(1).max(120),
		interpolationDelayMs: z.number().int().min(0).max(2_000),
		maximumExtrapolationMs: z.number().int().min(0).max(2_000),
		positionEpsilon: z.number().finite().min(0).max(1_000),
		rotationEpsilonDegrees: z.number().finite().min(0).max(180),
	})
);
const predictionChanges = nonEmpty(
	z.object({
		enabled: z.boolean(),
		rollbackReplay: z.boolean(),
		historySize: z.number().int().min(8).max(2_048),
		reconciliationThreshold: z.number().finite().min(0).max(10_000),
	})
);
const simulationChanges = nonEmpty(
	z.object({
		enabled: z.boolean(),
		latencyMs: z.number().int().min(0).max(10_000),
		jitterMs: z.number().int().min(0).max(10_000),
		packetLossPercent: z.number().finite().min(0).max(100),
		packetReorderPercent: z.number().finite().min(0).max(100),
		seed: z.number().int().min(0).max(2_147_483_647),
	})
);
const sessionChanges = nonEmpty(
	z.object({
		maximumPlayers: z.number().int().min(1).max(64),
		reconnectGraceMs: z.number().int().min(0).max(300_000),
		allowHostMigration: z.boolean(),
		publicLobby: z.boolean(),
	})
);
const gameplaySessionChanges = nonEmpty(
	z.object({
		name: z.string().trim().min(1).max(80),
		maximumPlayers: z.number().int().min(1).max(64),
		reconnectGraceMs: z.number().int().min(0).max(300_000),
		allowHostMigration: z.boolean(),
		publicLobby: z.boolean(),
	})
);
const configurationChanges = nonEmpty(
	z.object({
		enabled: z.boolean(),
		topology: z.literal("client-server"),
		transport: transportChanges,
		replication: replicationChanges,
		prediction: predictionChanges,
		simulation: simulationChanges,
		session: sessionChanges,
		maximumTraceEvents: z.number().int().min(16).max(10_000),
	})
);
const connection = z
	.object({
		endpoint: endpoint.optional(),
		clientId: identifier.optional(),
		displayName: z.string().trim().min(1).max(80).optional(),
		joinCode: joinCode.optional(),
		hostToken: token.optional(),
		reconnectToken: token.optional(),
	})
	.strict();

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const authoredWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const networkWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const destructiveNetworkWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function readTool(title: string, description: string, schema: z.ZodTypeAny = z.object({}).strict()) {
	return { title, description, inputSchema: schema, annotations: readOnly };
}

export function registerNetworkingTools(server: McpServer): void {
	server.registerTool(
		"get_networking_capabilities",
		readTool(
			"Get Networking capabilities",
			"Read the shipped client/server transport, replication, prediction, session, Multiplayer Play Mode, simulation, integration, and provider-boundary contract."
		),
		async (): Promise<CallToolResult> => callTextTool("get_networking_capabilities")
	);
	server.registerTool(
		"get_networking_configuration",
		readTool("Get Networking configuration", "Read the complete versioned scene networking configuration and exact authoring revision."),
		async (): Promise<CallToolResult> => callTextTool("get_networking_configuration")
	);
	server.registerTool(
		"set_networking_configuration",
		{
			title: "Set Networking configuration",
			description:
				"Exact-revision patch the scene transport, replication, prediction/reconciliation, simulation, session, or trace configuration. Connection credentials are never accepted here.",
			inputSchema: z.object({ expectedRevision: exactRevision, changes: configurationChanges }).strict(),
			annotations: authoredWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_networking_configuration", args)
	);
	server.registerTool(
		"validate_networking_target",
		readTool(
			"Validate Networking target",
			"Audit configuration, unique Network Replication ids, target security, authored readiness, and optional local runtime status without connecting.",
			z
				.object({ target: z.enum(["authoring", "web", "electron", "headless"]).optional(), requireEnabled: z.boolean().optional(), checkRuntime: z.boolean().optional() })
				.strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("validate_networking_target", args)
	);

	server.registerTool(
		"start_gameplay_session_host",
		{
			title: "Start gameplay session host",
			description:
				"Start the bounded authenticated WebSocket gameplay host. Defaults to loopback and an automatic port; LAN exposure requires confirm=true and should use a trusted network or TLS terminator.",
			inputSchema: z
				.object({
					host: z
						.string()
						.regex(/^[A-Za-z0-9.:-]{1,255}$/)
						.optional(),
					advertisedHost: z
						.string()
						.regex(/^[A-Za-z0-9.:-]{1,255}$/)
						.optional(),
					port: z
						.number()
						.int()
						.min(0)
						.max(65_535)
						.refine((value) => value === 0 || value >= 1_024, "Port must be 0 or 1024-65535.")
						.optional(),
					confirm: z.literal(true).optional(),
				})
				.strict(),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_gameplay_session_host", args)
	);
	server.registerTool(
		"stop_gameplay_session_host",
		{
			title: "Stop gameplay session host",
			description: "Disconnect all gameplay players, destroy every transient session, stop Multiplayer Play Mode, and close the listener.",
			inputSchema: z.object({ confirm: z.literal(true) }).strict(),
			annotations: destructiveNetworkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_gameplay_session_host", args)
	);
	server.registerTool(
		"get_gameplay_session_host_status",
		readTool("Get gameplay session host status", "Read listener endpoint, bounded counts, errors, and transport security without exposing any credential."),
		async (): Promise<CallToolResult> => callTextTool("get_gameplay_session_host_status")
	);
	server.registerTool(
		"create_gameplay_session",
		{
			title: "Create gameplay session",
			description:
				"Create one transient private/public lobby under the exact scene revision and return its one-time host credential plus join code. Copy the host token immediately; it is never persisted.",
			inputSchema: z
				.object({
					expectedRevision: exactRevision,
					name: z.string().trim().min(1).max(80).optional(),
					maximumPlayers: z.number().int().min(1).max(64).optional(),
					publicLobby: z.boolean().optional(),
					allowHostMigration: z.boolean().optional(),
					reconnectGraceMs: z.number().int().min(0).max(300_000).optional(),
				})
				.strict(),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_gameplay_session", args)
	);
	server.registerTool(
		"list_gameplay_sessions",
		readTool(
			"List gameplay sessions",
			"Page transient local lobbies. Public-only reads expose browseable join codes; editor-visible reads never expose host or reconnect tokens.",
			z.object({ publicOnly: z.boolean().optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("list_gameplay_sessions", args)
	);
	server.registerTool(
		"get_gameplay_session",
		readTool(
			"Get gameplay session",
			"Read one lobby, players, ownership/manifest counts, and relay metrics without host or reconnect tokens.",
			z.object({ sessionId }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_gameplay_session", args)
	);
	server.registerTool(
		"set_gameplay_session",
		{
			title: "Set gameplay session",
			description: "Exact-revision update one transient lobby's name, capacity, visibility, host migration, or reconnect grace.",
			inputSchema: z.object({ sessionId, expectedRevision: exactRevision, changes: gameplaySessionChanges }).strict(),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gameplay_session", args)
	);
	server.registerTool(
		"delete_gameplay_session",
		{
			title: "Delete gameplay session",
			description: "Delete one exact-revision transient lobby and disconnect its players. An active Multiplayer Play session must be stopped first.",
			inputSchema: z.object({ sessionId, expectedRevision: exactRevision, confirm: z.literal(true) }).strict(),
			annotations: destructiveNetworkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gameplay_session", args)
	);

	server.registerTool(
		"connect_networking_runtime",
		{
			title: "Connect Play networking runtime",
			description:
				"Connect the exact compiled Play scene using memory-only host, join, or reconnect credentials. Credentials are never authored or returned in status/trace.",
			inputSchema: z.object({ expectedRevision: exactRevision, connection }).strict(),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("connect_networking_runtime", args)
	);
	server.registerTool(
		"disconnect_networking_runtime",
		{
			title: "Disconnect Play networking runtime",
			description: "Close the compiled Play gameplay connection and cancel reconnect/simulation work without changing authored configuration.",
			inputSchema: z.object({ confirm: z.literal(true) }).strict(),
			annotations: destructiveNetworkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("disconnect_networking_runtime", args)
	);
	server.registerTool(
		"get_networking_runtime",
		readTool(
			"Get Play networking runtime",
			"Read credential-free compiled Play connection state, authority, ownership, peers, replication metrics, simulation, and paged protocol trace.",
			z.object({ offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1_000).optional() }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_networking_runtime", args)
	);
	server.registerTool(
		"set_networking_ownership",
		{
			title: "Set networking ownership",
			description: "Claim or release one owner-authority Network Replication object through the connected gameplay host.",
			inputSchema: z.object({ networkId: identifier, claim: z.boolean() }).strict(),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_networking_ownership", args)
	);
	server.registerTool(
		"submit_networking_input",
		{
			title: "Submit predicted networking input",
			description: "Apply and transmit one bounded owner input translation/rotation for client anticipation plus authoritative reconciliation and rollback/replay evidence.",
			inputSchema: z.object({ networkId: identifier, translation: vector3, rotationDegrees: vector3 }).strict(),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("submit_networking_input", args)
	);
	server.registerTool(
		"send_networking_rpc",
		{
			title: "Send networking RPC",
			description: "Send one bounded reliable or best-effort-simulated RPC to the server, all peers, or an object's owner.",
			inputSchema: z
				.object({
					name: identifier,
					target: z.enum(["server", "all", "owner"]),
					channel: z.enum(["reliable", "unreliable"]).optional(),
					networkId: identifier.optional(),
					payload: jsonValue,
				})
				.strict()
				.refine((value) => value.target !== "owner" || Boolean(value.networkId), "Owner-targeted RPC requires networkId."),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("send_networking_rpc", args)
	);
	server.registerTool(
		"clear_networking_evidence",
		{
			title: "Clear networking evidence",
			description: "Clear retained Play networking metrics and protocol trace without disconnecting.",
			inputSchema: z.object({ confirm: z.literal(true) }).strict(),
			annotations: { ...destructiveNetworkWrite, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_networking_evidence", args)
	);

	server.registerTool(
		"start_multiplayer_play_mode",
		{
			title: "Start Multiplayer Play Mode",
			description:
				"Start one exact compiled 1–4-player local test lease: the primary editor Play scene plus isolated compiled headless scenes/engines, optional unique owner assignments, and per-player adverse-network simulation.",
			inputSchema: z
				.object({
					expectedRevision: exactRevision,
					playerCount: z.number().int().min(1).max(4),
					playerNames: z.array(z.string().trim().min(1).max(80)).min(1).max(4).optional(),
					assignments: z.array(identifier.nullable()).min(1).max(4).optional(),
					simulations: z.array(simulationChanges.nullable()).min(1).max(4).optional(),
				})
				.strict(),
			annotations: networkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_multiplayer_play_mode", args)
	);
	server.registerTool(
		"get_multiplayer_play_mode",
		readTool("Get Multiplayer Play Mode", "Read credential-free exact run revision, per-player roles, scenes, assignments, runtime metrics/simulation, and errors."),
		async (): Promise<CallToolResult> => callTextTool("get_multiplayer_play_mode")
	);
	server.registerTool(
		"control_multiplayer_play_mode",
		{
			title: "Control Multiplayer Play Mode",
			description:
				"Apply one exact-run pause/resume, deterministic virtual frame step, input, RPC, ownership, simulation, disconnect, or reconnect operation. Primary rendering remains editor-owned.",
			inputSchema: z
				.object({
					expectedRunRevision: exactRevision,
					command: z.enum(["pause", "resume", "render-frames", "input", "rpc", "ownership", "set-simulation", "disconnect-player", "reconnect-player"]),
					playerIndex: z.number().int().min(0).max(3).optional(),
					frames: z.number().int().min(1).max(600).optional(),
					networkId: identifier.optional(),
					translation: vector3.optional(),
					rotationDegrees: vector3.optional(),
					name: identifier.optional(),
					target: z.enum(["server", "all", "owner"]).optional(),
					channel: z.enum(["reliable", "unreliable"]).optional(),
					payload: jsonValue.optional(),
					claim: z.boolean().optional(),
					simulation: simulationChanges.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					const needsPlayer = ["input", "rpc", "ownership", "disconnect-player", "reconnect-player"].includes(value.command);
					if (needsPlayer && value.playerIndex === undefined) {
						context.addIssue({ code: "custom", message: `${value.command} requires playerIndex.` });
					}
					if (value.command === "render-frames" && value.frames === undefined) {
						context.addIssue({ code: "custom", message: "render-frames requires frames." });
					}
					if (["input", "ownership"].includes(value.command) && !value.networkId) {
						context.addIssue({ code: "custom", message: `${value.command} requires networkId.` });
					}
					if (value.command === "input" && (!value.translation || !value.rotationDegrees)) {
						context.addIssue({ code: "custom", message: "input requires translation and rotationDegrees." });
					}
					if (value.command === "rpc" && (!value.name || !value.target || value.payload === undefined)) {
						context.addIssue({ code: "custom", message: "rpc requires name, target, and payload." });
					}
					if (value.command === "rpc" && value.target === "owner" && !value.networkId) {
						context.addIssue({ code: "custom", message: "Owner-targeted rpc requires networkId." });
					}
					if (value.command === "ownership" && value.claim === undefined) {
						context.addIssue({ code: "custom", message: "ownership requires claim." });
					}
					if (value.command === "set-simulation" && !value.simulation) {
						context.addIssue({ code: "custom", message: "set-simulation requires simulation." });
					}
				}),
			annotations: destructiveNetworkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("control_multiplayer_play_mode", args)
	);
	server.registerTool(
		"stop_multiplayer_play_mode",
		{
			title: "Stop Multiplayer Play Mode",
			description: "Disconnect every test player, dispose isolated scenes/engines, delete the transient session, and release only host/Play leases created by this run.",
			inputSchema: z.object({ confirm: z.literal(true) }).strict(),
			annotations: destructiveNetworkWrite,
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_multiplayer_play_mode", args)
	);
}
