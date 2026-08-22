import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerSoundTools(server: McpServer): void {
	const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
	const audioGeneratorNode = z
		.object({
			id: z.string().min(1).max(128),
			name: z.string().min(1).max(256),
			type: z.enum(["output", "audioClip", "oscillator", "noise", "gain", "mix", "sequence", "random", "custom"]),
			position: z.tuple([z.number().finite(), z.number().finite()]),
			enabled: z.boolean(),
			data: z.record(z.string(), z.unknown()),
		})
		.strict();
	const audioGeneratorEdge = z
		.object({
			id: z.string().min(1).max(128),
			sourceNodeId: z.string().min(1).max(128),
			targetNodeId: z.string().min(1).max(128),
			order: z.number().int().min(0).max(1_000_000),
			gain: z.number().finite().min(-16).max(16),
			startSeconds: z.number().finite().min(0).max(3600).optional(),
			durationSeconds: z.number().finite().min(0.001).max(3600).optional(),
		})
		.strict();
	const audioGeneratorGraph = z
		.object({
			version: z.literal(1),
			revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
			name: z.string().min(1).max(256),
			sampleRate: z.number().int().min(8000).max(192000),
			channels: z.number().int().min(1).max(8),
			durationSeconds: z.number().finite().min(0.001).max(3600),
			streaming: z.boolean(),
			seed: z.number().int().min(0).max(0x7fffffff),
			outputNodeId: z.string().min(1).max(128),
			nodes: z.array(audioGeneratorNode).min(1).max(128),
			edges: z.array(audioGeneratorEdge).max(256),
		})
		.strict();
	const duckingSchema = z
		.object({
			threshold: z.number().min(0.0001).max(1),
			ratio: z.number().min(1).max(100),
			attackSeconds: z.number().min(0).max(10),
			releaseSeconds: z.number().min(0).max(30),
			maxReductionDb: z.number().min(0).max(80),
		})
		.strict();
	const audioEffectType = z.enum(["gain", "lowpass", "highpass", "parametricEq", "compressor", "distortion", "echo", "chorus", "flanger", "stereoPanner", "convolutionReverb"]);
	const effectParametersSchema = z.union([
		z.object({ volumeDb: z.number().min(-80).max(24).optional() }).strict(),
		z.object({ frequency: z.number().min(20).max(20000).optional(), q: z.number().min(0.0001).max(100).optional() }).strict(),
		z.object({ frequency: z.number().min(20).max(20000).optional(), q: z.number().min(0.0001).max(100).optional(), gainDb: z.number().min(-40).max(40).optional() }).strict(),
		z
			.object({
				thresholdDb: z.number().min(-100).max(0).optional(),
				kneeDb: z.number().min(0).max(40).optional(),
				ratio: z.number().min(1).max(20).optional(),
				attackSeconds: z.number().min(0).max(1).optional(),
				releaseSeconds: z.number().min(0).max(1).optional(),
			})
			.strict(),
		z.object({ amount: z.number().min(0).max(1).optional(), oversample: z.enum(["none", "2x", "4x"]).optional() }).strict(),
		z.object({ delaySeconds: z.number().min(0).max(5).optional(), feedback: z.number().min(0).max(0.95).optional() }).strict(),
		z
			.object({
				rateHz: z.number().min(0.01).max(20).optional(),
				depthSeconds: z.number().min(0).max(0.05).optional(),
				delaySeconds: z.number().min(0).max(0.1).optional(),
				feedback: z.number().min(0).max(0.95).optional(),
			})
			.strict(),
		z.object({ pan: z.number().min(-1).max(1).optional() }).strict(),
		z
			.object({
				decaySeconds: z.number().min(0.05).max(20).optional(),
				preDelaySeconds: z.number().min(0).max(1).optional(),
				dampingHz: z.number().min(20).max(20000).optional(),
			})
			.strict(),
	]);
	const snapshotFields = { id: z.string().optional(), name: z.string().optional() };
	const snapshot = z
		.object(snapshotFields)
		.strict()
		.refine((value) => !!value.id !== !!value.name, "Provide exactly one snapshot id or name.");
	server.registerTool(
		"list_audio_mixer_snapshots",
		{ title: "List audio mixer snapshots", description: "List saved mixer-bus gain and mute snapshots.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_audio_mixer_snapshots", {})
	);
	server.registerTool(
		"create_audio_mixer_snapshot",
		{ title: "Create audio mixer snapshot", description: "Capture current audio-bus gains and mute states as a named snapshot.", inputSchema: z.object({ name: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("create_audio_mixer_snapshot", args)
	);
	server.registerTool(
		"apply_audio_mixer_snapshot",
		{
			title: "Apply audio mixer snapshot",
			description: "Apply a saved snapshot immediately or blend its gain and pitch values over bounded time; mute and solo states switch when the blend completes.",
			inputSchema: z
				.object({
					...snapshotFields,
					durationSeconds: z.number().min(0).max(120).optional().describe("Transition duration; zero applies immediately."),
					shape: z.enum(["linear", "exponential", "logarithmic"]).optional(),
				})
				.strict()
				.refine((value) => !!value.id !== !!value.name, "Provide exactly one snapshot id or name."),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_audio_mixer_snapshot", args)
	);
	server.registerTool(
		"delete_audio_mixer_snapshot",
		{ title: "Delete audio mixer snapshot", description: "Delete a saved mixer snapshot.", inputSchema: snapshot },
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_mixer_snapshot", args)
	);
	server.registerTool(
		"list_audio_buses",
		{ title: "List audio buses", description: "List persisted hierarchical mixer buses.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_audio_buses")
	);
	server.registerTool(
		"get_audio_mixer_runtime",
		{
			title: "Get audio mixer runtime",
			description:
				"Read resolved Master paths, hierarchy depth, inherited gain and pitch, mute/solo audibility, native Babylon AudioV2 bus connectivity, active snapshot-blend progress, and validation warnings.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_audio_mixer_runtime", {})
	);
	server.registerTool(
		"list_audio_runtime_diagnostics",
		{
			title: "List audio runtime diagnostics",
			description:
				"Inspect every SoundNode's loaded/playing state, spatial mode, base/effective volume, mixer-bus influence, and stale mixer assignments. This reads current preview/runtime state without changing playback.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_audio_runtime_diagnostics", {})
	);
	server.registerTool(
		"get_audio_mixer_profile",
		{
			title: "Get Audio Mixer Profile",
			description:
				"Read opt-in newest-first Audio Mixer timeline samples and cumulative summaries for synchronous mixer CPU time, total/playing/spatial/streaming voices, buses/effects/sends, active reverb zones, native connectivity, AudioContext sample rate/latency, per-bus estimated peak, and estimated clipping. The response explicitly distinguishes measurable JavaScript CPU and estimated source levels from native DSP-thread CPU and hardware clipping, which WebAudio does not expose.",
			inputSchema: z
				.object({
					busId: z.string().min(1).max(512).optional().describe("Optional exact mixer-bus id filter."),
					includeSamples: z.boolean().optional().describe("Include bounded newest-first timeline samples; defaults to false."),
					sampleOffset: z.number().int().min(0).optional().describe("Matching retained samples to skip; defaults to 0."),
					sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum returned samples; defaults to 20."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_audio_mixer_profile", args)
	);
	server.registerTool(
		"set_audio_mixer_profile",
		{
			title: "Set Audio Mixer Profiling",
			description:
				"Enable or disable transient Audio Mixer profiling and configure a 1–256-sample ring plus a 1–120-update sampling interval. Profiling measures the exact shared editor/export AudioMixer update path and adds bounded timer/counter overhead; retained history survives stop/start until cleared.",
			inputSchema: z
				.object({
					enabled: z.boolean().optional(),
					sampleCapacity: z.number().int().min(1).max(256).optional(),
					sampleEveryNUpdates: z.number().int().min(1).max(120).optional(),
				})
				.strict()
				.refine((value) => value.enabled !== undefined || value.sampleCapacity !== undefined || value.sampleEveryNUpdates !== undefined, {
					message: "Provide enabled, sampleCapacity, or sampleEveryNUpdates.",
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_audio_mixer_profile", args)
	);
	server.registerTool(
		"clear_audio_mixer_profile",
		{
			title: "Clear Audio Mixer Profile",
			description:
				"Clear transient Audio Mixer samples, CPU/voice/signal summaries, overflow counters, and update counters while retaining enabled/capacity/interval settings.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("clear_audio_mixer_profile", {})
	);
	server.registerTool(
		"create_audio_bus",
		{
			title: "Create audio bus",
			description: "Create a hierarchical mixer bus routed to Master or another bus, with inherited gain/pitch and exclusive SoundNode assignments.",
			inputSchema: z
				.object({
					name: z.string().trim().min(1).max(256),
					gain: z.number().min(0).max(16).optional(),
					pitch: z.number().min(0.01).max(4).optional(),
					muted: z.boolean().optional(),
					solo: z.boolean().optional(),
					parentBusId: z.string().nullable().optional().describe("Parent bus id, or null/omitted to route directly to Master."),
					soundNodeIds: z.array(z.string()).max(2048).optional(),
				})
				.strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_audio_bus", args)
	);
	server.registerTool(
		"set_audio_bus",
		{
			title: "Set audio bus",
			description: "Rename/reparent a mixer bus or change its gain, pitch, mute/solo state, and exclusive SoundNode assignments; cycles reject atomically.",
			inputSchema: z
				.object({
					busId: z.string().optional(),
					busName: z.string().optional(),
					name: z.string().trim().min(1).max(256).optional(),
					gain: z.number().min(0).max(16).optional(),
					pitch: z.number().min(0.01).max(4).optional(),
					muted: z.boolean().optional(),
					solo: z.boolean().optional(),
					parentBusId: z.string().nullable().optional(),
					soundNodeIds: z.array(z.string()).max(2048).optional(),
				})
				.strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_audio_bus", args)
	);
	server.registerTool(
		"create_audio_send",
		{
			title: "Create audio send",
			description:
				"Create an audible post-fader return send or a control-only sidechain send between mixer buses. Sidechains drive bounded threshold/ratio/attack/release ducking without adding their signal to the target output.",
			inputSchema: z
				.object({
					sourceBusId: z.string().optional(),
					sourceBusName: z.string().optional(),
					name: z.string().trim().min(1).max(256),
					targetBusId: z.string(),
					kind: z.enum(["return", "sidechain"]).optional(),
					gain: z.number().min(0).max(16).optional(),
					enabled: z.boolean().optional(),
					ducking: duckingSchema.optional(),
				})
				.strict()
				.refine((value) => !!value.sourceBusId !== !!value.sourceBusName, "Provide exactly one source bus id or name.")
				.refine((value) => value.kind === "sidechain" || value.ducking === undefined, "Ducking settings are valid only for sidechain sends."),
			annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_audio_send", args)
	);
	server.registerTool(
		"set_audio_send",
		{
			title: "Set audio send",
			description: "Update one return/sidechain send, including target, level, enabled state, kind, and complete sidechain ducking envelope.",
			inputSchema: z
				.object({
					sourceBusId: z.string().optional(),
					sourceBusName: z.string().optional(),
					sendId: z.string().optional(),
					sendName: z.string().optional(),
					name: z.string().trim().min(1).max(256).optional(),
					targetBusId: z.string().optional(),
					kind: z.enum(["return", "sidechain"]).optional(),
					gain: z.number().min(0).max(16).optional(),
					enabled: z.boolean().optional(),
					ducking: duckingSchema.optional(),
				})
				.strict()
				.refine((value) => !!value.sourceBusId !== !!value.sourceBusName, "Provide exactly one source bus id or name.")
				.refine((value) => !!value.sendId !== !!value.sendName, "Provide exactly one send id or name."),
			annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_audio_send", args)
	);
	server.registerTool(
		"delete_audio_send",
		{
			title: "Delete audio send",
			description: "Delete one return or sidechain send without deleting either bus.",
			inputSchema: z
				.object({ sourceBusId: z.string().optional(), sourceBusName: z.string().optional(), sendId: z.string().optional(), sendName: z.string().optional() })
				.strict()
				.refine((value) => !!value.sourceBusId !== !!value.sourceBusName, "Provide exactly one source bus id or name.")
				.refine((value) => !!value.sendId !== !!value.sendName, "Provide exactly one send id or name."),
			annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_send", args)
	);
	server.registerTool(
		"create_audio_effect",
		{
			title: "Create audio DSP effect",
			description:
				"Insert an ordered native WebAudio DSP effect on a mixer bus. Supports gain, low/high-pass, parametric EQ, compressor, distortion, echo, chorus, flanger, and stereo panning with wet/dry mix and bypass.",
			inputSchema: z
				.object({
					busId: z.string().optional(),
					busName: z.string().optional(),
					name: z.string().trim().min(1).max(256),
					type: audioEffectType,
					index: z.number().int().min(0).max(1023).optional(),
					enabled: z.boolean().optional(),
					wet: z.number().min(0).max(1).optional(),
					parameters: effectParametersSchema.optional(),
				})
				.strict()
				.refine((value) => !!value.busId !== !!value.busName, "Provide exactly one bus id or name."),
			annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_audio_effect", args)
	);
	server.registerTool(
		"set_audio_effect",
		{
			title: "Set audio DSP effect",
			description: "Rename, bypass, mix, retune, change type, or reorder one mixer DSP effect atomically.",
			inputSchema: z
				.object({
					busId: z.string().optional(),
					busName: z.string().optional(),
					effectId: z.string().optional(),
					effectName: z.string().optional(),
					name: z.string().trim().min(1).max(256).optional(),
					type: audioEffectType.optional(),
					index: z.number().int().min(0).max(1023).optional(),
					enabled: z.boolean().optional(),
					wet: z.number().min(0).max(1).optional(),
					parameters: effectParametersSchema.optional(),
				})
				.strict()
				.refine((value) => !!value.busId !== !!value.busName, "Provide exactly one bus id or name.")
				.refine((value) => !!value.effectId !== !!value.effectName, "Provide exactly one effect id or name."),
			annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_audio_effect", args)
	);
	server.registerTool(
		"delete_audio_effect",
		{
			title: "Delete audio DSP effect",
			description: "Delete one ordered DSP effect without deleting its mixer bus.",
			inputSchema: z
				.object({ busId: z.string().optional(), busName: z.string().optional(), effectId: z.string().optional(), effectName: z.string().optional() })
				.strict()
				.refine((value) => !!value.busId !== !!value.busName, "Provide exactly one bus id or name.")
				.refine((value) => !!value.effectId !== !!value.effectName, "Provide exactly one effect id or name."),
			annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_effect", args)
	);
	server.registerTool(
		"list_audio_reverb_zones",
		{
			title: "List audio reverb zones",
			description:
				"List persisted sphere/box reverb zones and current listener distance, blend weight, priority selection, target bus path, and native convolution connectivity.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_audio_reverb_zones", {})
	);
	server.registerTool(
		"create_audio_reverb_zone",
		{
			title: "Create audio reverb zone",
			description: "Create a spatial sphere or box zone that blends one convolutionReverb mixer effect from the active camera/listener position in centimeters.",
			inputSchema: z
				.object({
					name: z.string().trim().min(1).max(256),
					effectId: z.string(),
					shape: z.enum(["sphere", "box"]).optional(),
					position: z.array(z.number().min(-1_000_000_000).max(1_000_000_000)).length(3).optional(),
					innerRadius: z.number().min(0).max(100_000_000).optional(),
					outerRadius: z.number().min(0).max(100_000_000).optional(),
					size: z.array(z.number().positive().max(100_000_000)).length(3).optional(),
					blendDistance: z.number().min(0).max(100_000_000).optional(),
					priority: z.number().min(-1000).max(1000).optional(),
					enabled: z.boolean().optional(),
				})
				.strict(),
			annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_audio_reverb_zone", args)
	);
	server.registerTool(
		"set_audio_reverb_zone",
		{
			title: "Set audio reverb zone",
			description: "Retarget, move, resize, prioritize, enable, or change the shape and blend geometry of one reverb zone atomically.",
			inputSchema: z
				.object({
					id: z.string().optional(),
					zoneName: z.string().optional(),
					name: z.string().trim().min(1).max(256).optional(),
					effectId: z.string().optional(),
					shape: z.enum(["sphere", "box"]).optional(),
					position: z.array(z.number().min(-1_000_000_000).max(1_000_000_000)).length(3).optional(),
					innerRadius: z.number().min(0).max(100_000_000).optional(),
					outerRadius: z.number().min(0).max(100_000_000).optional(),
					size: z.array(z.number().positive().max(100_000_000)).length(3).optional(),
					blendDistance: z.number().min(0).max(100_000_000).optional(),
					priority: z.number().min(-1000).max(1000).optional(),
					enabled: z.boolean().optional(),
				})
				.strict()
				.refine((value) => !!value.id !== !!value.zoneName, "Provide exactly one reverb-zone id or name."),
			annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_audio_reverb_zone", args)
	);
	server.registerTool(
		"delete_audio_reverb_zone",
		{
			title: "Delete audio reverb zone",
			description: "Delete one spatial reverb zone without deleting its target effect or bus.",
			inputSchema: z
				.object({ id: z.string().optional(), zoneName: z.string().optional() })
				.strict()
				.refine((value) => !!value.id !== !!value.zoneName, "Provide exactly one reverb-zone id or name."),
			annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_reverb_zone", args)
	);
	server.registerTool(
		"assign_sound_node_to_audio_bus",
		{
			title: "Assign sound to audio bus",
			description: "Exclusively assign one SoundNode to a mixer bus, or pass null to clear its assignment and restore its base volume.",
			inputSchema: z.object({ nodeId: z.string(), busId: z.string().nullable() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("assign_sound_node_to_audio_bus", args)
	);
	server.registerTool(
		"delete_audio_bus",
		{
			title: "Delete audio bus",
			description: "Delete a mixer bus without deleting sounds.",
			inputSchema: z.object({ busId: z.string().optional(), busName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_bus", args)
	);
	server.registerTool(
		"list_sound_assets",
		{
			title: "List sound assets",
			description:
				"List native sound clips and `.audio-generator.json` assets available in the project. " +
				"Use this to find ambience/music files before calling `create_sound`. If nothing suitable exists, download more via the marketplace tools.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_sound_assets", args)
	);

	server.registerTool(
		"list_audio_generators",
		{
			title: "List Audio Generators",
			description: "List indexed .audio-generator.json assets with exact dependency and build-readiness evidence.",
			inputSchema: z
				.object({
					folder: z.string().max(1024).optional(),
					recursive: z.boolean().optional(),
					query: z.string().max(256).optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(500).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_audio_generators", args)
	);
	server.registerTool(
		"list_audio_generator_types",
		{
			title: "List Audio Generator Types",
			description: "List built-in and registered project generator node types, defaults, seek support, and portable graph limits.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_audio_generator_types", {})
	);
	server.registerTool(
		"get_audio_generator",
		{
			title: "Get Audio Generator",
			description: "Read one canonical graph, exact source/runtime fingerprints, revision, AudioClip leaves, and build readiness.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_audio_generator", args)
	);
	server.registerTool(
		"create_audio_generator",
		{
			title: "Create Audio Generator",
			description: "Create a canonical generated-audio graph asset; omit graph for an immediately audible oscillator graph. The parent folder must already exist.",
			inputSchema: z.object({ path: z.string().min(1).max(1024), name: z.string().min(1).max(256).optional(), graph: audioGeneratorGraph.optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_audio_generator", args)
	);
	server.registerTool(
		"set_audio_generator",
		{
			title: "Set Audio Generator",
			description: "Replace a complete graph under the exact source fingerprint from get_audio_generator; advances its persisted revision once.",
			inputSchema: z.object({ path: z.string().min(1).max(1024), expectedFingerprint: fingerprint, graph: audioGeneratorGraph }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_audio_generator", args)
	);
	server.registerTool(
		"delete_audio_generator",
		{
			title: "Delete Audio Generator",
			description: "Delete one generated-audio graph and metadata under its exact inspected source fingerprint, with registry rollback on failure.",
			inputSchema: z.object({ path: z.string().min(1).max(1024), expectedFingerprint: fingerprint }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_audio_generator", args)
	);
	server.registerTool(
		"validate_audio_generator",
		{
			title: "Validate Audio Generator",
			description: "Validate exactly one on-disk path (including dependency fingerprints) or one unsaved candidate graph without modifying project state.",
			inputSchema: z
				.object({ path: z.string().min(1).max(1024).optional(), graph: audioGeneratorGraph.optional() })
				.strict()
				.refine((value) => (value.path === undefined) !== (value.graph === undefined), "Provide exactly one path or graph."),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_audio_generator", args)
	);

	server.registerTool(
		"create_sound",
		{
			title: "Create sound",
			description:
				"Create a `SoundNode` in the scene from a sound asset and load it (e.g. 'sounds of nature', 'people talking in the market place'). " +
				"`spatial: true` (default) creates a 3D positional sound emitted FROM the node's transform — parent it under a node and/or set `position` (centimeters) to place the source (a fountain, a market stall, a campfire, a cluster of fireflies). " +
				"`spatial: false` creates a global, non-positional 2D ambience/music bed that plays everywhere. " +
				"Tune falloff with `maxDistance`/`distanceModel` ('linear'|'inverse'|'exponential') and stereo rendering with `panningModel` ('HRTF'|'equalpower'). " +
				"After creation the node is selected and shown in the inspector.",
			inputSchema: z.object({
				path: z.string().describe("Project-relative or absolute path to a native clip or `.audio-generator.json` asset."),
				name: z.string().optional().describe("Name for the created SoundNode."),
				parentId: z.string().optional().describe("Id of the parent node to attach the sound to."),
				parentName: z.string().optional().describe("Name of the parent node to attach the sound to."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters where the sound should be emitted."),
				volume: z.number().optional().describe("Playback volume in 0..1."),
				spatial: z.boolean().optional().describe("Whether the sound is 3D positional (default true). Set false for a global 2D ambience/music bed."),
				maxDistance: z.number().optional().describe("Distance (centimeters) at which the spatial sound becomes inaudible."),
				distanceModel: z.enum(["linear", "inverse", "exponential"]).optional().describe("Falloff curve for the spatial sound's volume over distance."),
				panningModel: z.enum(["HRTF", "equalpower"]).optional().describe("Stereo panning algorithm for the spatial sound."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sound", args)
	);

	server.registerTool(
		"get_sound",
		{
			title: "Get sound",
			description: "Read a SoundNode's asset, spatialization, attenuation, volume, and preview playback state.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_sound", args)
	);

	server.registerTool(
		"set_sound_playing",
		{
			title: "Play or stop sound",
			description: "Start or stop a SoundNode in the editor preview. startOffset is in seconds.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), playing: z.boolean(), startOffset: z.number().min(0).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sound_playing", args)
	);

	server.registerTool(
		"set_sound_properties",
		{
			title: "Set sound properties",
			description:
				"Update properties of an existing `SoundNode` (resolved by `nodeId`/`nodeName`). Only the provided fields are applied. " +
				"Use this to adjust volume, switch between spatial/global, or retune falloff/panning after `create_sound`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target SoundNode (preferred)."),
				nodeName: z.string().optional().describe("Name of the target SoundNode."),
				volume: z.number().optional().describe("Playback volume in 0..1."),
				spatial: z.boolean().optional().describe("Whether the sound is 3D positional."),
				maxDistance: z.number().optional().describe("Distance (centimeters) at which the spatial sound becomes inaudible."),
				distanceModel: z.enum(["linear", "inverse", "exponential"]).optional().describe("Falloff curve for the spatial sound's volume over distance."),
				panningModel: z.enum(["HRTF", "equalpower"]).optional().describe("Stereo panning algorithm for the spatial sound."),
				autoUpdateSpatial: z.boolean().optional().describe("Whether the spatial position auto-updates as the node's transform changes."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sound_properties", args)
	);
}
