import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

type TAnimationEventArgument = null | boolean | number | string | TAnimationEventArgument[] | { [key: string]: TAnimationEventArgument };

const animationEventArgumentSchema: z.ZodType<TAnimationEventArgument> = z.lazy(() =>
	z.union([
		z.null(),
		z.boolean(),
		z.number().finite(),
		z.string().max(2048),
		z.array(animationEventArgumentSchema).max(64),
		z.record(z.string().min(1).max(128), animationEventArgumentSchema),
	])
);

const animationEventBase = {
	frame: z.number().finite().describe("Exact AnimationGroup frame at which this callback fires."),
	parameter: z.string().min(1).max(2048).optional().describe("Optional author note/runtime log parameter."),
	onlyOnce: z.boolean().optional().describe("True removes Babylon's callback after its first dispatch."),
};

const animationEventSchema = z.discriminatedUnion("action", [
	z.object({ ...animationEventBase, action: z.literal("log") }).strict(),
	z
		.object({
			...animationEventBase,
			action: z.literal("setEnabled"),
			nodeId: z.string().min(1).max(1024).optional(),
			nodeName: z.string().min(1).max(1024).optional(),
			enabled: z.boolean().optional(),
		})
		.strict()
		.refine((value) => Boolean(value.nodeId || value.nodeName), "setEnabled requires nodeId or nodeName."),
	z
		.object({
			...animationEventBase,
			action: z.literal("playAnimationGroup"),
			animationGroupName: z.string().min(1).max(1024),
			loop: z.boolean().optional(),
		})
		.strict(),
	z.object({ ...animationEventBase, action: z.literal("stopAnimationGroup"), animationGroupName: z.string().min(1).max(1024) }).strict(),
	z
		.object({
			...animationEventBase,
			action: z.literal("scriptMethod"),
			nodeId: z.string().min(1).max(1024).optional().describe('Explicit script target node id, "scene", or omitted for the first animated target.'),
			nodeName: z.string().min(1).max(1024).optional().describe('Explicit script target node name, "scene", or omitted for the first animated target.'),
			methodName: z
				.string()
				.min(1)
				.max(128)
				.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
			scriptKey: z.string().min(1).max(1024).optional().describe("Optional attached-script key filter; omit to invoke every matching receiver."),
			arguments: z.array(animationEventArgumentSchema).max(16).optional(),
			missingMethodPolicy: z.enum(["error", "warning", "ignore"]).optional().describe("How missing target scripts or methods are reported; defaults to error."),
		})
		.strict(),
]);

const animationRecordingEntrySchema = z
	.object({
		targetTrackIndex: z.number().int().min(0).optional().describe("Any existing track index for the intended target object, from get_animation_window."),
		nodeId: z.string().min(1).max(256).optional().describe("Scene node id when recording a new target that has no track in this clip."),
		nodeName: z.string().min(1).max(256).optional().describe("Scene node name when no nodeId is available."),
		property: z
			.string()
			.min(1)
			.max(512)
			.regex(/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*){0,15}$/)
			.describe('Exact dotted Inspector property path, such as "position.x", "scaling", "intensity", or "material.albedoColor".'),
		framesPerSecond: z.number().finite().min(1).max(1000).optional().describe("FPS for a newly created track; defaults to the clip's first track or 60."),
		loopMode: z.enum(["cycle", "constant", "relative"]).optional().describe("Loop mode for a newly created track; defaults to the clip's first track or cycle."),
		interpolation: z.enum(["linear", "step"]).optional().describe("Interpolation for a new key. Existing-key interpolation is preserved when omitted."),
	})
	.strict()
	.superRefine((value, context) => {
		const usesTrack = value.targetTrackIndex !== undefined;
		const usesNode = value.nodeId !== undefined || value.nodeName !== undefined;
		if (usesTrack === usesNode) {
			context.addIssue({ code: "custom", message: "Use exactly one target mode: targetTrackIndex or nodeId/nodeName." });
		}
		if (["__proto__", "prototype", "constructor"].some((segment) => value.property.split(".").includes(segment))) {
			context.addIssue({ code: "custom", path: ["property"], message: "Unsafe property path segment." });
		}
	});

const animationTargetBindingSchema = z.union([
	z
		.object({
			kind: z.literal("node"),
			sourceTarget: z.string().min(1).max(512).describe('Exact serialized target identity, such as "$root" or "Armature/Hips".'),
			nodeId: z.string().min(1).max(256).optional().describe("Destination scene node id."),
			nodeName: z.string().min(1).max(256).optional().describe("Destination scene node name when no nodeId is supplied."),
		})
		.strict()
		.superRefine((value, context) => {
			if ((value.nodeId ? 1 : 0) + (value.nodeName ? 1 : 0) !== 1) {
				context.addIssue({ code: "custom", message: "Node bindings require exactly one of nodeId or nodeName." });
			}
		}),
	z
		.object({
			kind: z.literal("morphTarget"),
			sourceTarget: z.string().min(1).max(512).describe('Exact serialized blend-shape target identity, such as "Face#blendShape:Smile".'),
			meshId: z.string().min(1).max(256).optional().describe("Destination mesh id containing the MorphTargetManager."),
			meshName: z.string().min(1).max(256).optional().describe("Destination mesh name when no meshId is supplied."),
			morphTargetName: z.string().min(1).max(256).describe("Exact destination MorphTarget name."),
		})
		.strict()
		.superRefine((value, context) => {
			if ((value.meshId ? 1 : 0) + (value.meshName ? 1 : 0) !== 1) {
				context.addIssue({ code: "custom", message: "Morph-target bindings require exactly one of meshId or meshName." });
			}
		}),
	z
		.object({
			kind: z.literal("sprite"),
			sourceTarget: z.string().min(1).max(512).describe("Exact serialized Unity object-reference target identity."),
			spriteName: z.string().min(1).max(256).describe("Exact destination Babylon Sprite name."),
			managerName: z.string().min(1).max(256).optional().describe("Exact SpriteManager name; provide it when sprite names are ambiguous."),
		})
		.strict(),
]);

const unityAnimationObjectReferenceValueSchema = z.union([
	z.object({ kind: z.literal("null") }).strict(),
	z.object({ kind: z.literal("number"), value: z.number().finite().min(-1_000_000_000).max(1_000_000_000) }).strict(),
	z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
	z.object({ kind: z.literal("string"), value: z.string().max(4096) }).strict(),
	z
		.object({
			kind: z.literal("node"),
			nodeId: z.string().min(1).max(256).optional(),
			nodeName: z.string().min(1).max(256).optional(),
		})
		.strict()
		.superRefine((value, context) => {
			if ((value.nodeId ? 1 : 0) + (value.nodeName ? 1 : 0) !== 1) {
				context.addIssue({ code: "custom", message: "Node values require exactly one nodeId or nodeName." });
			}
		}),
	z
		.object({
			kind: z.literal("material"),
			materialId: z.string().min(1).max(256).optional(),
			materialName: z.string().min(1).max(256).optional(),
		})
		.strict()
		.superRefine((value, context) => {
			if ((value.materialId ? 1 : 0) + (value.materialName ? 1 : 0) !== 1) {
				context.addIssue({ code: "custom", message: "Material values require exactly one materialId or materialName." });
			}
		}),
	z.object({ kind: z.literal("texture"), path: z.string().min(1).max(1024).describe("Contained project-relative texture path.") }).strict(),
]);

const unityAnimationObjectReferenceBindingSchema = z
	.object({
		curveId: z.string().min(1).max(128).describe("Exact object-reference curve id reported by get_animation_importer_result."),
		propertyPath: z
			.string()
			.min(1)
			.max(512)
			.regex(/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*){0,15}$/)
			.refine((value) => !value.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment)), "Unsafe property path segment."),
		references: z
			.array(
				z
					.object({
						referenceKey: z.string().min(1).max(128).describe("Exact GUID/fileID/type key reported for this curve."),
						value: unityAnimationObjectReferenceValueSchema,
					})
					.strict()
			)
			.min(1)
			.max(8192),
	})
	.strict();

const animationRuntimeBreakpointSchema = z
	.object({
		id: z.string().min(1).max(128).describe("Stable runtime-only breakpoint id."),
		frame: z.number().finite().describe("Exact frame inside the AnimationGroup's current from/to range."),
		enabled: z.boolean().describe("Whether live playback and deterministic stepping should halt at this frame."),
	})
	.strict();

export function registerAnimationTools(server: McpServer): void {
	server.registerTool(
		"list_animation_groups",
		{
			title: "List animation groups",
			description:
				"List the scene's animation groups: clips imported with a mesh asset (e.g. a glTF character's 'idle'/'walk' clips) AND groups authored with `create_animation`. " +
				"Use this to discover what is already playable before previewing with `play_animation_group` or authoring a new one.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_animation_groups", args)
	);

	server.registerTool(
		"play_animation_group",
		{
			title: "Play animation group",
			description:
				"Preview an animation group in the editor (e.g. play a character's 'idle' or 'walk' clip, or a freshly authored door-opening animation) so you can verify it with `get_screenshot`. " +
				"This is for in-editor preview only — to make the animation play at runtime in the game, attach a BEHAVIOR script that calls `scene.getAnimationGroupByName(name)?.play()` when the relevant event occurs (e.g. the player approaches).",
			inputSchema: z.object({
				name: z.string().describe("Name of the animation group to play."),
				loop: z.boolean().optional().describe("Whether the animation loops (default true)."),
				speed: z.number().optional().describe("Playback speed ratio (1 = normal speed)."),
				from: z.number().optional().describe("Start frame. Defaults to the group's `from`."),
				to: z.number().optional().describe("End frame. Defaults to the group's `to`."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("play_animation_group", args)
	);

	server.registerTool(
		"stop_animation_group",
		{
			title: "Stop animation group",
			description: "Stop a playing animation group. Omit `name` to stop ALL animation groups in the scene.",
			inputSchema: z.object({
				name: z.string().optional().describe("Name of the animation group to stop. Omit to stop every animation group."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_animation_group", args)
	);

	server.registerTool(
		"create_animation",
		{
			title: "Create animation",
			description:
				"AUTHOR a keyframe `AnimationGroup` that animates a node property over time (e.g. a door opening = animate `rotation.y` from 0 to ~1.57 radians, a platform bobbing up and down = animate `position.y`, a light pulsing = animate `intensity` or `diffuse`). " +
				'`targetProperty` is a dotted path on the resolved node (e.g. `"rotation.y"`, `"position"`, `"scaling"`, `"material.albedoColor"`). `keys` are `{ frame, value }` pairs; `value` is a number for scalar properties or `[x,y,z]` for Vector3/Color3 properties. ' +
				"`loopMode`: 'cycle' (restart from the first key, default), 'constant' (stop and hold the last key), or 'relative' (offset and continue from the end value). " +
				"This creates REAL, hand-editable editor content (visible and tweakable in the Animation Groups inspector) — it does NOT make anything play yet. " +
				"#1 RULE: do NOT animate the property directly from a script's `onUpdate` (e.g. incrementing `rotation.y` every frame) — author the motion HERE as a real AnimationGroup, then have a BEHAVIOR script call `scene.getAnimationGroupByName(name)?.play()` when something happens (the player approaches, a button is pressed, etc.). Preview the result with `play_animation_group` and `get_screenshot`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				name: z.string().describe("Name for the new animation group (used to play it later, e.g. via `scene.getAnimationGroupByName`)."),
				targetProperty: z.string().describe('Dotted property path on the node to animate, e.g. `"rotation.y"`, `"position"`, `"scaling"`, `"material.albedoColor"`.'),
				framesPerSecond: z.number().optional().describe("Frames per second for the animation's frame numbers (default 60)."),
				loopMode: z
					.enum(["cycle", "constant", "relative"])
					.optional()
					.describe(
						"Looping behavior when the group is played: 'cycle' restarts from the start key (default), 'constant' holds the last key, 'relative' offsets and continues."
					),
				keys: z
					.array(
						z.object({
							frame: z.number().describe("Frame number for this keyframe (combined with `framesPerSecond` to get the time)."),
							value: z
								.union([z.number(), z.array(z.number()).length(3)])
								.describe("Value at this frame: a number for scalar properties, or `[x,y,z]` for Vector3/Color3 properties."),
							interpolation: z.enum(["linear", "step"]).optional().describe("Use step to hold this key's value until the next key; defaults to linear."),
							inTangent: z
								.union([z.number(), z.array(z.number()).min(2).max(4)])
								.optional()
								.describe("Optional incoming Hermite tangent; match the key value shape."),
							outTangent: z
								.union([z.number(), z.array(z.number()).min(2).max(4)])
								.optional()
								.describe("Optional outgoing Hermite tangent; match the key value shape."),
						})
					)
					.describe("Ordered keyframes for the animation."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_animation", args)
	);

	server.registerTool(
		"list_animation_events",
		{
			title: "List animation events",
			description:
				"List persistent frame-event callbacks for one AnimationGroup or every group, including exact per-group revisions and bounded runtime dispatch evidence for editor and exported-game parity.",
			inputSchema: z.object({ name: z.string().min(1).max(1024).optional() }).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_animation_events", args)
	);

	server.registerTool(
		"set_animation_events",
		{
			title: "Set animation events",
			description:
				"Under the exact revision from list_animation_events, replace one AnimationGroup's persistent callbacks. Supports log, node enablement, group playback, and attached script-method dispatch with bounded JSON arguments plus error/warning/ignore missing-method reporting. Events execute identically in editor preview and exported games.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(1024),
					expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
					events: z.array(animationEventSchema).max(4096),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_events", args)
	);

	server.registerTool(
		"get_animation_group",
		{
			title: "Get animation group",
			description: "Get an AnimationGroup's serialized graph plus every track, target, curve/keyframe, and timing property.",
			inputSchema: z.object({ name: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animation_group", args)
	);
	server.registerTool(
		"get_animation_window",
		{
			title: "Get Animation Window",
			description:
				"Inspect one AnimationGroup through the standalone Unity-style Animation Window model. Returns an exact SHA-256 edit lease, clip duration, every target/property track, component labels, normalized scalar component values/tangents, interpolation, unique frames, and frame events for multi-track Dope Sheet or Curve editing.",
			inputSchema: z.object({ name: z.string().min(1).max(256).describe("Existing AnimationGroup name.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animation_window", args)
	);
	server.registerTool(
		"get_animation_runtime_debug",
		{
			title: "Get AnimationGroup runtime debug snapshot",
			description:
				"Inspect one standalone AnimationGroup's live started/playing/paused state, current and normalized frame, loop count, speed, weight, animatables, paginated target current/evaluated values and divergence, recent Animation Events, runtime-only frame breakpoints, and bounded play/pause/loop/end/step trace. Returns an exact SHA-256 debugger lease for set_animation_runtime_debug or step_animation_runtime_debug.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256).describe("Existing AnimationGroup name."),
					trackOffset: z.number().int().min(0).max(1000000).optional().describe("Zero-based target-track page offset; defaults to 0."),
					trackLimit: z.number().int().min(1).max(256).optional().describe("Target tracks to return; defaults to 64."),
					historyLimit: z.number().int().min(1).max(256).optional().describe("Newest retained trace entries to return; defaults to 64."),
					eventLimit: z.number().int().min(1).max(128).optional().describe("Newest matching Animation Event log entries to return; defaults to 32."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animation_runtime_debug", args)
	);
	server.registerTool(
		"set_animation_runtime_debug",
		{
			title: "Configure AnimationGroup runtime debugging",
			description:
				"Under the exact debugger fingerprint, atomically pause/resume a started standalone AnimationGroup, replace up to 64 exact-frame runtime breakpoints, clear its bounded trace, or set live loop, non-zero speed, and weight controls. Debug state is runtime-only and does not alter the persisted clip graph.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact debugger fingerprint from get_animation_runtime_debug."),
					paused: z.boolean().optional().describe("Pause or resume this started AnimationGroup."),
					breakpoints: z.array(animationRuntimeBreakpointSchema).max(64).optional().describe("Complete replacement runtime frame-breakpoint list."),
					clearHistory: z.boolean().optional().describe("True clears retained and dropped trace-history counts."),
					speedRatio: z
						.number()
						.finite()
						.min(-100)
						.max(100)
						.refine((value) => value !== 0, "speedRatio cannot be zero.")
						.optional(),
					weight: z.number().finite().min(-1).max(1).optional().describe("Babylon AnimationGroup weight; -1 keeps unweighted playback."),
					loopAnimation: z.boolean().optional(),
				})
				.strict()
				.refine(
					(input) =>
						input.paused !== undefined ||
						input.breakpoints !== undefined ||
						input.clearHistory === true ||
						input.speedRatio !== undefined ||
						input.weight !== undefined ||
						input.loopAnimation !== undefined,
					"Provide paused, breakpoints, clearHistory=true, speedRatio, weight, or loopAnimation."
				),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_runtime_debug", args)
	);
	server.registerTool(
		"step_animation_runtime_debug",
		{
			title: "Step paused AnimationGroup runtime",
			description:
				"Under the exact debugger fingerprint, deterministically sample one started and paused standalone AnimationGroup by 1–120 exact frame steps totaling at most 10,000 frames. Stepping honors loop/clamp behavior and halts at the first enabled frame breakpoint while remaining paused. It does not advance the scene clock or replay Animation Event callbacks.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact debugger fingerprint from get_animation_runtime_debug."),
					frameDelta: z
						.number()
						.finite()
						.min(-10000)
						.max(10000)
						.refine((value) => value !== 0, "frameDelta cannot be zero.")
						.optional()
						.describe("Signed frames per step; defaults to +1."),
					steps: z.number().int().min(1).max(120).optional().describe("Step count; defaults to 1."),
					trackOffset: z.number().int().min(0).max(1000000).optional(),
					trackLimit: z.number().int().min(1).max(256).optional(),
					historyLimit: z.number().int().min(1).max(256).optional(),
					eventLimit: z.number().int().min(1).max(128).optional(),
				})
				.strict()
				.refine((input) => Math.abs((input.frameDelta ?? 1) * (input.steps ?? 1)) <= 10000, "Animation runtime stepping cannot exceed 10,000 frames."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("step_animation_runtime_debug", args)
	);
	server.registerTool(
		"edit_animation_window_keys",
		{
			title: "Edit Animation Window Keys",
			description:
				"Atomically edit 1–2048 exact keys across multiple AnimationGroup tracks using the fingerprint from get_animation_window. Move in time and optionally value, scale around a pivot, duplicate, delete, set linear/step interpolation, or offset selected scalar/vector/color/quaternion components. Rejects stale leases, missing keys, invalid components, empty tracks, and frame collisions.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current fingerprint from get_animation_window."),
					selection: z
						.array(
							z
								.object({
									trackIndex: z.number().int().min(0).describe("Track index from get_animation_window."),
									frame: z.number().finite().min(0).max(1000000000).describe("Exact existing source frame."),
									component: z.number().int().min(0).max(3).optional().describe("Curve component for value editing; omit for whole-key Dope Sheet operations."),
								})
								.strict()
						)
						.min(1)
						.max(2048),
					operation: z.enum(["move", "scale", "duplicate", "delete", "setInterpolation", "offsetValue"]),
					frameDelta: z.number().finite().min(-1000000).max(1000000).optional().describe("Frame offset for move/duplicate, or post-scale offset."),
					frameScale: z.number().finite().min(0.001).max(1000).optional().describe("Time scale for scale; defaults to 1."),
					pivotFrame: z.number().finite().min(0).max(1000000000).optional().describe("Time-scaling pivot; defaults to frame 0."),
					valueDelta: z.number().finite().min(-1000000000).max(1000000000).optional().describe("Component value offset for offsetValue or curve-key move."),
					interpolation: z.enum(["linear", "step"]).optional().describe("Required for setInterpolation."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.operation === "duplicate" && (!value.frameDelta || value.frameDelta === 0)) {
						context.addIssue({ code: "custom", path: ["frameDelta"], message: "duplicate requires a non-zero frameDelta." });
					}
					if (value.operation === "move" && (value.frameDelta ?? 0) === 0 && (value.valueDelta ?? 0) === 0) {
						context.addIssue({ code: "custom", message: "move requires a non-zero frameDelta or valueDelta." });
					}
					if (value.operation === "setInterpolation" && value.interpolation === undefined) {
						context.addIssue({ code: "custom", path: ["interpolation"], message: "setInterpolation requires interpolation." });
					}
					if (value.operation === "offsetValue" && value.valueDelta === undefined) {
						context.addIssue({ code: "custom", path: ["valueDelta"], message: "offsetValue requires valueDelta." });
					}
					if (
						(value.operation === "offsetValue" || (value.operation === "move" && (value.valueDelta ?? 0) !== 0)) &&
						value.selection.some((item) => item.component === undefined)
					) {
						context.addIssue({ code: "custom", path: ["selection"], message: "Value edits require component on every selected curve key." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("edit_animation_window_keys", args)
	);
	server.registerTool(
		"record_animation_window_properties",
		{
			title: "Record Animation Window Properties",
			description:
				"Atomically record 1–128 current Inspector property values at one frame using the exact fingerprint from get_animation_window. Creates missing number/Vector2/Vector3/Quaternion/Color3/Color4 tracks or adds/replaces keys on existing target/property tracks. Returns per-property target, value, track-creation/key-replacement evidence and a fresh fingerprint; rejects stale leases, unsafe/unresolved paths, unsupported/non-finite values, duplicate entries, and type mismatches without partial mutation.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256).describe("Existing AnimationGroup name."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current fingerprint from get_animation_window."),
					frame: z.number().finite().min(0).max(1000000000).describe("Frame at which to add or replace every recorded property key."),
					entries: z.array(animationRecordingEntrySchema).min(1).max(128),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("record_animation_window_properties", args)
	);
	server.registerTool(
		"set_animation_window_tangent_modes",
		{
			title: "Set Animation Window Tangent Modes",
			description:
				"Atomically apply auto, clampedAuto, linear, linked freeSmooth, independent broken, or weighted tangent modes to 1–2048 exact Animation Window key selections under its SHA-256 fingerprint. Whole-key selections affect every component; component selections affect one curve. Weighted mode executes through Babylon's fixed-time Hermite model by scaling authored slopes by 3×weight, making weight 1/3 neutral; the response discloses authored slopes, weights, effective runtime tangents, lock state, persisted mode metadata, and a fresh window. Rejects stale leases, overlaps, invalid mode-specific fields, non-finite values, and out-of-range weights without partial mutation.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current fingerprint from get_animation_window."),
					selection: z
						.array(
							z
								.object({
									trackIndex: z.number().int().min(0),
									frame: z.number().finite().min(0).max(1000000000),
									component: z.number().int().min(0).max(3).optional().describe("Omit to apply the mode to every component of the key."),
								})
								.strict()
						)
						.min(1)
						.max(2048),
					mode: z.enum(["auto", "clampedAuto", "linear", "freeSmooth", "broken", "weighted"]),
					tangent: z.number().finite().min(-1000000000).max(1000000000).optional().describe("Required linked slope for freeSmooth only."),
					inTangent: z.number().finite().min(-1000000000).max(1000000000).optional().describe("Incoming authored slope for broken or weighted mode."),
					outTangent: z.number().finite().min(-1000000000).max(1000000000).optional().describe("Outgoing authored slope for broken or weighted mode."),
					inWeight: z.number().finite().min(0.01).max(1).optional().describe("Required weighted incoming handle time fraction; 1/3 is neutral."),
					outWeight: z.number().finite().min(0.01).max(1).optional().describe("Required weighted outgoing handle time fraction; 1/3 is neutral."),
				})
				.strict()
				.superRefine((value, context) => {
					const manual =
						value.tangent !== undefined ||
						value.inTangent !== undefined ||
						value.outTangent !== undefined ||
						value.inWeight !== undefined ||
						value.outWeight !== undefined;
					if (["auto", "clampedAuto", "linear"].includes(value.mode) && manual) {
						context.addIssue({ code: "custom", message: `${value.mode} does not accept manual tangent or weight values.` });
					}
					if (
						value.mode === "freeSmooth" &&
						(value.tangent === undefined ||
							value.inTangent !== undefined ||
							value.outTangent !== undefined ||
							value.inWeight !== undefined ||
							value.outWeight !== undefined)
					) {
						context.addIssue({ code: "custom", message: "freeSmooth requires only tangent." });
					}
					if (
						value.mode === "broken" &&
						((value.inTangent === undefined && value.outTangent === undefined) ||
							value.tangent !== undefined ||
							value.inWeight !== undefined ||
							value.outWeight !== undefined)
					) {
						context.addIssue({ code: "custom", message: "broken requires inTangent, outTangent, or both, without weights." });
					}
					if (
						value.mode === "weighted" &&
						(value.inTangent === undefined ||
							value.outTangent === undefined ||
							value.inWeight === undefined ||
							value.outWeight === undefined ||
							value.tangent !== undefined)
					) {
						context.addIssue({ code: "custom", message: "weighted requires inTangent, outTangent, inWeight, and outWeight." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_window_tangent_modes", args)
	);
	server.registerTool(
		"open_animation_window",
		{
			title: "Open Animation Window",
			description:
				"Open the editor's shared standalone Animation Window on one existing AnimationGroup, selecting its multi-track Dope Sheet/Curve workflow without changing animation data.",
			inputSchema: z.object({ name: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_animation_window", args)
	);

	server.registerTool(
		"set_animation_keys",
		{
			title: "Set animation keys",
			description: "Replace all keys in one AnimationGroup track. Use get_animation_group to discover target tracks and preserve the target property/type.",
			inputSchema: z.object({
				name: z.string(),
				trackIndex: z.number().int().min(0),
				keys: z
					.array(
						z.object({
							frame: z.number(),
							value: z.union([z.number(), z.array(z.number()).min(2).max(4)]),
							interpolation: z.enum(["linear", "step"]).optional(),
							inTangent: z.union([z.number(), z.array(z.number()).min(2).max(4)]).optional(),
							outTangent: z.union([z.number(), z.array(z.number()).min(2).max(4)]).optional(),
						})
					)
					.min(1),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_keys", args)
	);

	server.registerTool(
		"set_animation_curve_keys",
		{
			title: "Set scalar animation curve keys",
			description:
				"Replace all keys in one scalar AnimationGroup track for the interactive curve-editor workflow. This rejects vector/color/quaternion tracks, duplicate frames, and non-finite values; use set_animation_keys for other track types.",
			inputSchema: z.object({
				name: z.string().describe("AnimationGroup name."),
				trackIndex: z.number().int().min(0).describe("Scalar target track index from get_animation_group."),
				keys: z
					.array(
						z.object({
							frame: z.number().finite().min(0),
							value: z.number().finite(),
							interpolation: z.enum(["linear", "step"]).optional(),
							inTangent: z.number().finite().optional(),
							outTangent: z.number().finite().optional(),
						})
					)
					.min(1),
			}),
			annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_curve_keys", args)
	);

	server.registerTool(
		"set_animation_curve_component_keys",
		{
			title: "Set vector animation curve component keys",
			description:
				"Replace one Vector2/Vector3/Color3/Quaternion component curve while preserving all other channels and requiring the track's existing frame set. Use component 0-3 and scalar values/tangents for multi-channel curve editing.",
			inputSchema: z.object({
				name: z.string().describe("AnimationGroup name."),
				trackIndex: z.number().int().min(0).describe("Vector/color/quaternion target track index from get_animation_group."),
				component: z.number().int().min(0).max(3).describe("Component index: x/r=0, y/g=1, z/b=2, w/a=3."),
				keys: z
					.array(
						z.object({
							frame: z.number().finite().min(0),
							value: z.number().finite(),
							interpolation: z.enum(["linear", "step"]).optional(),
							inTangent: z.number().finite().optional(),
							outTangent: z.number().finite().optional(),
						})
					)
					.min(1),
			}),
			annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_curve_component_keys", args)
	);

	server.registerTool(
		"set_animation_curve_tangents",
		{
			title: "Set animation curve tangents",
			description:
				"Set incoming and/or outgoing Hermite tangents at existing scalar or vector/color/quaternion animation keys without replacing their values. For multi-channel tracks, specify the component index.",
			inputSchema: z.object({
				name: z.string().describe("AnimationGroup name."),
				trackIndex: z.number().int().min(0).describe("Target track index from get_animation_group."),
				component: z.number().int().min(0).max(3).optional().describe("Component for vector/color/quaternion tracks; defaults to 0."),
				keys: z
					.array(z.object({ frame: z.number().finite().min(0), inTangent: z.number().finite().optional(), outTangent: z.number().finite().optional() }))
					.min(1)
					.describe("Existing key frames with one or both tangent slopes, in value units per frame."),
			}),
			annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_curve_tangents", args)
	);

	server.registerTool(
		"auto_smooth_animation_curve_tangents",
		{
			title: "Auto-smooth animation curve tangents",
			description:
				"Recalculate centered tangents for every non-stepped key in one scalar, vector, color, or quaternion AnimationGroup track. Endpoint tangents use the available adjacent segment.",
			inputSchema: z.object({
				name: z.string().describe("AnimationGroup name."),
				trackIndex: z.number().int().min(0).describe("Target track index from get_animation_group."),
			}),
			annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("auto_smooth_animation_curve_tangents", args)
	);

	server.registerTool(
		"sample_animation_curve",
		{
			title: "Sample animation curve",
			description:
				"Evaluate a scalar or vector component of an AnimationGroup track over a bounded frame range for curve visualization or analysis. Step keys hold; other keys interpolate linearly.",
			inputSchema: z.object({
				name: z.string(),
				trackIndex: z.number().int().min(0),
				component: z.number().int().min(0).max(3).optional(),
				from: z.number().optional(),
				to: z.number().optional(),
				samples: z.number().int().min(2).max(512).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("sample_animation_curve", args)
	);
	server.registerTool(
		"export_animation_group",
		{
			title: "Export animation group",
			description:
				"Export one live AnimationGroup, including target identities, all typed curves/keys/tangents, loop state, events metadata, and importer evidence, to a contained project-relative Babylon AnimationGroup JSON file. Existing files require overwrite=true.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(256).describe("Existing AnimationGroup name."),
					path: z.string().min(1).max(1024).describe("Contained project-relative destination path, normally ending in .animation."),
					overwrite: z.literal(true).optional().describe("Required only when replacing an existing destination file."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("export_animation_group", args)
	);

	server.registerTool(
		"import_animation_group",
		{
			title: "Import animation group",
			description:
				"Import a processed or exported Babylon AnimationGroup JSON from inside the project. Every target resolves before mutation through exact node, MorphTarget, or Sprite bindings. Converted Unity object-reference curves require a complete safe destination plus GUID/fileID/type value map; null, primitive, node, material, and contained texture values persist and execute in preview/export runtime. Duplicate, missing, ambiguous, unused, stale, unsafe, and unresolved bindings reject atomically. An existing group requires replaceExisting=true and is replaced only after parsing and runtime configuration succeed.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Contained project-relative AnimationGroup JSON path, including a processed Unity .anim artifact when applicable."),
					name: z.string().min(1).max(256).optional().describe("Optional final group name override."),
					targetBindings: z
						.array(animationTargetBindingSchema)
						.max(2048)
						.optional()
						.describe("Exact source-target to scene-target bindings for converted or relocated clips."),
					objectReferenceBindings: z
						.array(unityAnimationObjectReferenceBindingSchema)
						.max(512)
						.optional()
						.describe("Complete exact binding table for every Unity m_PPtrCurves entry reported by get_animation_importer_result."),
					replaceExisting: z.boolean().optional().describe("Must be true when replacing an existing same-name AnimationGroup."),
					unitySourceAssetPath: z
						.string()
						.min(1)
						.max(1024)
						.optional()
						.describe(
							"Optional original project-relative Unity .anim asset. Its paired .meta GUID and current content hash are verified and persisted for exact controller dependency binding."
						),
					unityFileId: z
						.string()
						.regex(/^-?\d+$/)
						.optional()
						.describe("Exact Unity class-74 fileID when unitySourceAssetPath is provided; defaults to 7400000."),
				})
				.strict()
				.refine((value) => value.unityFileId === undefined || value.unitySourceAssetPath !== undefined, "unityFileId requires unitySourceAssetPath."),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("import_animation_group", args)
	);

	server.registerTool(
		"delete_animation_group",
		{
			title: "Delete animation group",
			description: "Remove and dispose an animation group from the scene by name (e.g. to remove a previously authored animation before re-authoring it).",
			inputSchema: z.object({
				name: z.string().describe("Name of the animation group to delete."),
			}),
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_animation_group", args)
	);
}
