import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

type TCinematicJson = null | boolean | number | string | TCinematicJson[] | { [key: string]: TCinematicJson };

const finite = z.number().finite();
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const assetPath = z
	.string()
	.trim()
	.min(1)
	.max(1024)
	.refine((value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), "Use a project-relative POSIX path without traversal.");
const cinematicPath = assetPath.refine((value) => value.toLowerCase().endsWith(".cinematic"), "Path must end in .cinematic.");
const expectedRevision = z.number().int().min(0).safe();
const expectedFingerprint = z.string().regex(/^[0-9a-f]{16}$/i);
const lease = { path: cinematicPath, expectedRevision, expectedFingerprint };
const frame = finite.min(0).max(20_736_000);
const framesPerSecond = finite.min(1).max(240);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const propertyValue = z
	.union([finite, z.boolean(), z.array(finite).min(2).max(16)])
	.refine((value) => !Array.isArray(value) || [2, 3, 4, 16].includes(value.length), "Property arrays must contain exactly 2, 3, 4, or 16 finite numbers.");
const jsonValue: z.ZodType<TCinematicJson> = z.lazy(() =>
	z.union([z.null(), z.boolean(), finite, z.string().max(32768), z.array(jsonValue).max(256), z.record(z.string().min(1).max(128), jsonValue)])
);

const key = z.discriminatedUnion("type", [
	z
		.object({
			id: identifier,
			type: z.literal("key"),
			frame,
			value: propertyValue,
			interpolation: z.enum(["linear", "step", "cubic"]),
			inTangent: propertyValue.optional(),
			outTangent: propertyValue.optional(),
		})
		.strict(),
	z.object({ id: identifier, type: z.literal("cut"), frame, incomingValue: propertyValue, outgoingValue: propertyValue }).strict(),
]);

const marker = z
	.object({
		id: identifier,
		name: z.string().trim().min(1).max(128),
		type: z.enum(["signal", "event"]),
		frame,
		emitOnce: z.boolean(),
		retroactive: z.boolean(),
		payload: jsonValue,
	})
	.strict();

const clipBase = {
	id: identifier,
	name: z.string().trim().min(1).max(128),
	startFrame: frame,
	durationFrames: finite.min(0.000001).max(20_736_000),
	clipInFrame: frame,
	timeScale: finite
		.min(-1000)
		.max(1000)
		.refine((value) => value !== 0, "timeScale cannot be zero."),
	enabled: z.boolean(),
	blendInFrames: frame,
	blendOutFrames: frame,
	easeIn: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]),
	easeOut: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]),
	preExtrapolation: z.enum(["none", "hold", "loop", "pingPong", "continue"]),
	postExtrapolation: z.enum(["none", "hold", "loop", "pingPong", "continue"]),
};
const clip = z.discriminatedUnion("type", [
	z
		.object({
			...clipBase,
			type: z.literal("animation"),
			animationGroupId: identifier,
			sourceStartFrame: frame,
			sourceEndFrame: frame,
			loopCount: z.number().int().min(0).max(1_000_000),
		})
		.strict(),
	z.object({ ...clipBase, type: z.literal("audio"), soundId: identifier, volume: finite.min(0).max(8), loop: z.boolean() }).strict(),
	z
		.object({
			...clipBase,
			type: z.literal("video"),
			timeScale: finite.min(0.000001).max(1000),
			videoPlayerId: identifier,
			volume: finite.min(0).max(1),
			loop: z.boolean(),
			muteAudio: z.boolean(),
		})
		.strict(),
	z.object({ ...clipBase, type: z.literal("activation"), nodeId: identifier, active: z.boolean() }).strict(),
	z.object({ ...clipBase, type: z.literal("camera"), cameraId: identifier, blendMode: z.enum(["cut", "crossFade"]) }).strict(),
	z
		.object({
			...clipBase,
			type: z.literal("control"),
			targetType: z.enum(["particleSystem", "cinematic"]),
			targetId: z.string().trim().min(1).max(1024),
			action: z.enum(["play", "stop"]),
		})
		.strict(),
	z.object({ ...clipBase, type: z.literal("recorder"), profileId: identifier }).strict(),
]);

const trackBase = {
	id: identifier,
	name: z.string().trim().min(1).max(128),
	order: z.number().int().min(0).max(255),
	parentId: identifier.nullable(),
	muted: z.boolean(),
	solo: z.boolean(),
	locked: z.boolean(),
	color,
};
const track = z.discriminatedUnion("type", [
	z.object({ ...trackBase, type: z.literal("group"), collapsed: z.boolean() }).strict(),
	z
		.object({
			...trackBase,
			type: z.literal("property"),
			targetType: z.enum(["node", "renderingPipeline"]),
			targetId: identifier.nullable(),
			propertyPath: z.string().min(1).max(512),
			keys: z.array(key).max(10_000),
		})
		.strict(),
	z.object({ ...trackBase, type: z.literal("animation"), clips: z.array(clip).max(4096), weightKeys: z.array(key).max(10_000) }).strict(),
	z.object({ ...trackBase, type: z.literal("audio"), clips: z.array(clip).max(4096), volumeKeys: z.array(key).max(10_000) }).strict(),
	z.object({ ...trackBase, type: z.literal("video"), clips: z.array(clip).max(4096) }).strict(),
	z.object({ ...trackBase, type: z.literal("activation"), clips: z.array(clip).max(4096) }).strict(),
	z.object({ ...trackBase, type: z.literal("camera"), clips: z.array(clip).max(4096) }).strict(),
	z.object({ ...trackBase, type: z.literal("signal"), markers: z.array(marker).max(10_000) }).strict(),
	z.object({ ...trackBase, type: z.literal("control"), clips: z.array(clip).max(4096) }).strict(),
	z.object({ ...trackBase, type: z.literal("recorder"), clips: z.array(clip).max(4096) }).strict(),
]);
const recorderProfile = z
	.object({
		id: identifier,
		name: z.string().trim().min(1).max(128),
		format: z.enum(["webm", "mp4", "png", "jpeg", "webp"]),
		width: z.number().int().min(16).max(8192),
		height: z.number().int().min(16).max(8192),
		framesPerSecond,
		quality: finite.min(0).max(1),
		includeAudio: z.boolean(),
	})
	.strict();
const document = z
	.object({
		version: z.literal(2),
		id: identifier,
		revision: expectedRevision,
		name: z.string().trim().min(1).max(128),
		framesPerSecond,
		outputFramesPerSecond: framesPerSecond,
		durationMode: z.enum(["automatic", "fixed"]),
		durationFrames: frame,
		wrapMode: z.enum(["once", "loop", "hold"]),
		tracks: z.array(track).max(256),
		recorderProfiles: z.array(recorderProfile).max(32),
	})
	.strict();

const settingsChanges = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		framesPerSecond: framesPerSecond.optional(),
		outputFramesPerSecond: framesPerSecond.optional(),
		durationMode: z.enum(["automatic", "fixed"]).optional(),
		durationFrames: frame.optional(),
		wrapMode: z.enum(["once", "loop", "hold"]).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Settings changes cannot be empty.");
const trackChanges = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		parentId: identifier.nullable().optional(),
		muted: z.boolean().optional(),
		solo: z.boolean().optional(),
		locked: z.boolean().optional(),
		color: color.optional(),
		collapsed: z.boolean().optional(),
		targetType: z.enum(["node", "renderingPipeline"]).optional(),
		targetId: identifier.nullable().optional(),
		propertyPath: z.string().min(1).max(512).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Track changes cannot be empty.");
const clipChanges = z
	.object({
		name: z.string().trim().min(1).max(128).optional(),
		startFrame: frame.optional(),
		durationFrames: finite.min(0.000001).max(20_736_000).optional(),
		clipInFrame: frame.optional(),
		timeScale: finite
			.min(-1000)
			.max(1000)
			.refine((value) => value !== 0)
			.optional(),
		enabled: z.boolean().optional(),
		blendInFrames: frame.optional(),
		blendOutFrames: frame.optional(),
		easeIn: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]).optional(),
		easeOut: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]).optional(),
		preExtrapolation: z.enum(["none", "hold", "loop", "pingPong", "continue"]).optional(),
		postExtrapolation: z.enum(["none", "hold", "loop", "pingPong", "continue"]).optional(),
		animationGroupId: identifier.optional(),
		sourceStartFrame: frame.optional(),
		sourceEndFrame: frame.optional(),
		loopCount: z.number().int().min(0).max(1_000_000).optional(),
		soundId: identifier.optional(),
		videoPlayerId: identifier.optional(),
		volume: finite.min(0).max(8).optional(),
		loop: z.boolean().optional(),
		muteAudio: z.boolean().optional(),
		nodeId: identifier.optional(),
		active: z.boolean().optional(),
		cameraId: identifier.optional(),
		blendMode: z.enum(["cut", "crossFade"]).optional(),
		targetType: z.enum(["particleSystem", "cinematic"]).optional(),
		targetId: z.string().trim().min(1).max(1024).optional(),
		action: z.enum(["play", "stop"]).optional(),
		profileId: identifier.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Clip changes cannot be empty.");
const profileChanges = recorderProfile
	.omit({ id: true })
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Recorder profile changes cannot be empty.");

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const updateMutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const destructiveMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

/** Registers the complete version-2 Timeline authoring, preview, validation, and capture surface. */
export function registerCinematicTools(server: McpServer): void {
	server.registerTool(
		"list_cinematics",
		{ title: "List cinematics", description: "List editable project .cinematic assets.", inputSchema: z.object({}).strict(), annotations: readOnly },
		async (): Promise<CallToolResult> => callTextTool("list_cinematics", {})
	);
	server.registerTool(
		"get_cinematic_capabilities",
		{
			title: "Get cinematic capabilities",
			description: "Read the exact Timeline model, capture formats, safety leases, and built-in offline master-bus audio boundary.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_cinematic_capabilities", {})
	);
	server.registerTool(
		"inspect_cinematic_audio_capture_plan",
		{
			title: "Inspect cinematic audio capture plan",
			description:
				"Preflight one exact leased recorder profile/range and report offline SoundNode sources, master-bus routes, effects, sends, codec, duration, and blocking issues.",
			inputSchema: z
				.object({
					...lease,
					profileId: identifier,
					startFrame: frame.optional(),
					endFrame: frame.optional(),
				})
				.strict()
				.refine(
					(value) => value.startFrame === undefined || value.endFrame === undefined || value.endFrame > value.startFrame,
					"endFrame must be greater than startFrame."
				),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_cinematic_audio_capture_plan", args)
	);
	server.registerTool(
		"get_cinematic",
		{
			title: "Get cinematic",
			description: "Read one complete canonical Timeline document plus exact revision fingerprint lease.",
			inputSchema: z.object({ path: cinematicPath }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_cinematic", args)
	);
	server.registerTool(
		"create_cinematic",
		{
			title: "Create cinematic",
			description: "Create an empty version-2 Timeline asset; add typed tracks/items with granular tools.",
			inputSchema: z
				.object({
					path: cinematicPath,
					name: z.string().trim().min(1).max(128).optional(),
					framesPerSecond: framesPerSecond.optional(),
					outputFramesPerSecond: framesPerSecond.optional(),
					durationMode: z.enum(["automatic", "fixed"]).optional(),
					durationFrames: frame.optional(),
					wrapMode: z.enum(["once", "loop", "hold"]).optional(),
				})
				.strict(),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cinematic", args)
	);
	server.registerTool(
		"fork_cinematic",
		{
			title: "Fork cinematic",
			description: "Copy an exact leased Timeline to a new path with independent stable identity.",
			inputSchema: z.object({ ...lease, destinationPath: cinematicPath }).strict(),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("fork_cinematic", args)
	);
	server.registerTool(
		"delete_cinematic",
		{
			title: "Delete cinematic",
			description: "Delete one exact leased Timeline asset after literal confirmation.",
			inputSchema: z.object({ ...lease, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cinematic", args)
	);
	server.registerTool(
		"replace_cinematic",
		{
			title: "Replace cinematic",
			description: "Replace a complete canonical Timeline under exact lease and literal confirmation; granular tools are preferred.",
			inputSchema: z.object({ ...lease, document, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("replace_cinematic", args)
	);
	server.registerTool(
		"set_cinematic_settings",
		{
			title: "Set cinematic settings",
			description: "Patch name, FPS, duration, or wrap mode under exact revision and fingerprint lease.",
			inputSchema: z.object({ ...lease, changes: settingsChanges }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cinematic_settings", args)
	);
	server.registerTool(
		"create_cinematic_track",
		{
			title: "Create cinematic track",
			description: "Create one fully typed group/property/animation/audio/video/activation/camera/signal/control/recorder track.",
			inputSchema: z.object({ ...lease, track }).strict(),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cinematic_track", args)
	);
	server.registerTool(
		"set_cinematic_track",
		{
			title: "Set cinematic track",
			description: "Patch one exact-id track, including hierarchy, mute/solo/lock, property binding, or collapse state.",
			inputSchema: z.object({ ...lease, trackId: identifier, changes: trackChanges }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cinematic_track", args)
	);
	server.registerTool(
		"move_cinematic_track",
		{
			title: "Move cinematic track",
			description: "Reorder or reparent one exact-id track under an unlocked group.",
			inputSchema: z.object({ ...lease, trackId: identifier, index: z.number().int().min(0).max(255), parentId: identifier.nullable() }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("move_cinematic_track", args)
	);
	server.registerTool(
		"delete_cinematic_track",
		{
			title: "Delete cinematic track",
			description: "Delete one exact-id track and optionally its unlocked descendants after confirmation.",
			inputSchema: z.object({ ...lease, trackId: identifier, deleteChildren: z.boolean().optional(), confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cinematic_track", args)
	);
	server.registerTool(
		"create_cinematic_clip",
		{
			title: "Create cinematic clip",
			description: "Create one fully typed animation/audio/video/activation/camera/control/recorder clip on a compatible track.",
			inputSchema: z.object({ ...lease, trackId: identifier, clip }).strict(),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cinematic_clip", args)
	);
	server.registerTool(
		"set_cinematic_clip",
		{
			title: "Set cinematic clip",
			description: "Patch timing, blend, extrapolation, source, target, action, or profile fields on one clip.",
			inputSchema: z.object({ ...lease, trackId: identifier, clipId: identifier, changes: clipChanges }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cinematic_clip", args)
	);
	server.registerTool(
		"delete_cinematic_clip",
		{
			title: "Delete cinematic clip",
			description: "Delete one exact-id Timeline clip after literal confirmation.",
			inputSchema: z.object({ ...lease, trackId: identifier, clipId: identifier, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cinematic_clip", args)
	);
	server.registerTool(
		"create_cinematic_key",
		{
			title: "Create cinematic key",
			description: "Create a regular key or discontinuous cut in a property, animation-weight, or audio-volume lane.",
			inputSchema: z.object({ ...lease, trackId: identifier, lane: z.enum(["property", "weight", "volume"]), key }).strict(),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cinematic_key", args)
	);
	server.registerTool(
		"set_cinematic_key",
		{
			title: "Set cinematic key",
			description: "Replace one exact-id key/cut while preserving its identity and lane.",
			inputSchema: z.object({ ...lease, trackId: identifier, lane: z.enum(["property", "weight", "volume"]), keyId: identifier, key }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cinematic_key", args)
	);
	server.registerTool(
		"delete_cinematic_key",
		{
			title: "Delete cinematic key",
			description: "Delete one exact-id key or cut after literal confirmation.",
			inputSchema: z.object({ ...lease, trackId: identifier, lane: z.enum(["property", "weight", "volume"]), keyId: identifier, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cinematic_key", args)
	);
	server.registerTool(
		"create_cinematic_marker",
		{
			title: "Create cinematic marker",
			description: "Create a bounded signal/event marker with exact seek and emit-once semantics.",
			inputSchema: z.object({ ...lease, trackId: identifier, marker }).strict(),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cinematic_marker", args)
	);
	server.registerTool(
		"set_cinematic_marker",
		{
			title: "Set cinematic marker",
			description: "Replace one exact-id signal/event marker while preserving identity.",
			inputSchema: z.object({ ...lease, trackId: identifier, markerId: identifier, marker }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cinematic_marker", args)
	);
	server.registerTool(
		"delete_cinematic_marker",
		{
			title: "Delete cinematic marker",
			description: "Delete one exact-id marker after literal confirmation.",
			inputSchema: z.object({ ...lease, trackId: identifier, markerId: identifier, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cinematic_marker", args)
	);
	server.registerTool(
		"create_cinematic_recorder_profile",
		{
			title: "Create cinematic recorder profile",
			description: "Create one bounded output format, resolution, FPS, quality, and audio-request profile.",
			inputSchema: z.object({ ...lease, profile: recorderProfile }).strict(),
			annotations: createMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_cinematic_recorder_profile", args)
	);
	server.registerTool(
		"set_cinematic_recorder_profile",
		{
			title: "Set cinematic recorder profile",
			description: "Patch one exact-id capture profile under the document lease.",
			inputSchema: z.object({ ...lease, profileId: identifier, changes: profileChanges }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_cinematic_recorder_profile", args)
	);
	server.registerTool(
		"delete_cinematic_recorder_profile",
		{
			title: "Delete cinematic recorder profile",
			description: "Delete an unreferenced profile after literal confirmation.",
			inputSchema: z.object({ ...lease, profileId: identifier, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_cinematic_recorder_profile", args)
	);
	server.registerTool(
		"validate_cinematic",
		{
			title: "Validate cinematic",
			description: "Validate the canonical document plus scene nodes, cameras, animation groups, sounds, particles, and nested Timeline references.",
			inputSchema: z.object({ path: cinematicPath }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_cinematic", args)
	);
	server.registerTool(
		"get_cinematic_preview",
		{
			title: "Get cinematic preview",
			description: "Read the active preview path, clock, direction, speed, duration, revision, and error without changing playback.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_cinematic_preview", {})
	);
	server.registerTool(
		"control_cinematic_preview",
		{
			title: "Control cinematic preview",
			description: "Play a saved Timeline or pause, seek, frame-step, and stop the current Babylon scene preview with exact restoration.",
			inputSchema: z
				.object({
					action: z.enum(["play", "pause", "seek", "step", "stop"]),
					path: cinematicPath.optional(),
					loop: z.boolean().optional(),
					speed: finite.min(0.001).max(1000).optional(),
					ignoreSounds: z.boolean().optional(),
					frame: frame.optional(),
					emitRetroactive: z.boolean().optional(),
					frameCount: z
						.number()
						.int()
						.min(-1_000_000)
						.max(1_000_000)
						.refine((value) => value !== 0)
						.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					const allowed: Record<typeof value.action, string[]> = {
						play: ["path", "loop", "speed", "ignoreSounds"],
						pause: [],
						seek: ["frame", "emitRetroactive"],
						step: ["frameCount"],
						stop: [],
					};
					for (const key of Object.keys(value).filter((key) => key !== "action" && !allowed[value.action].includes(key))) {
						context.addIssue({ code: "custom", path: [key], message: `${key} is not supported for ${value.action}.` });
					}
					if (value.action === "play" && value.path === undefined) {
						context.addIssue({ code: "custom", path: ["path"], message: "play requires path." });
					}
					if (value.action === "seek" && value.frame === undefined) {
						context.addIssue({ code: "custom", path: ["frame"], message: "seek requires frame." });
					}
				}),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("control_cinematic_preview", args)
	);
	server.registerTool(
		"play_cinematic",
		{
			title: "Play cinematic (compatibility)",
			description: "Compatibility wrapper that starts the version-2 scene preview. Use control_cinematic_preview for transport control.",
			inputSchema: z
				.object({ path: cinematicPath, loop: z.boolean().optional(), speedRatio: finite.min(0.001).max(1000).optional(), ignoreSounds: z.boolean().optional() })
				.strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("play_cinematic", args)
	);
	server.registerTool(
		"start_cinematic_capture",
		{
			title: "Start cinematic capture",
			description: "Start a cancellable deterministic background capture; audio-enabled WebM/MP4 profiles render the authored offline master bus and mux Opus/AAC.",
			inputSchema: z
				.object({
					...lease,
					profileId: identifier,
					destination: assetPath,
					startFrame: frame.optional(),
					endFrame: frame.optional(),
					overwrite: z.literal(true).optional(),
				})
				.strict()
				.refine(
					(value) => value.startFrame === undefined || value.endFrame === undefined || value.endFrame > value.startFrame,
					"endFrame must be greater than startFrame."
				),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("start_cinematic_capture", args)
	);
	server.registerTool(
		"get_cinematic_capture",
		{
			title: "Get cinematic capture",
			description: "Read the most recent background capture id, status, progress, frame counts, destination, and error.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_cinematic_capture", {})
	);
	server.registerTool(
		"cancel_cinematic_capture",
		{
			title: "Cancel cinematic capture",
			description: "Cancel one exact running capture id and discard unpublished temporary output.",
			inputSchema: z.object({ captureId: z.string().uuid() }).strict(),
			annotations: updateMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_cinematic_capture", args)
	);
}
