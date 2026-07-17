import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

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
			description: "List persistent frame-event callbacks for one animation group or every group, plus recent editor callback activity.",
			inputSchema: z.object({ name: z.string().optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_animation_events", args)
	);

	server.registerTool(
		"set_animation_events",
		{
			title: "Set animation events",
			description:
				"Replace an AnimationGroup's persistent frame-event callbacks. Actions: log, setEnabled, playAnimationGroup, and stopAnimationGroup. Events run at their authored frame on the first track.",
			inputSchema: z.object({
				name: z.string(),
				events: z.array(
					z.object({
						frame: z.number(),
						action: z.enum(["log", "setEnabled", "playAnimationGroup", "stopAnimationGroup"]),
						nodeId: z.string().optional(),
						nodeName: z.string().optional(),
						enabled: z.boolean().optional(),
						animationGroupName: z.string().optional(),
						loop: z.boolean().optional(),
						parameter: z.string().optional(),
						onlyOnce: z.boolean().optional(),
					})
				),
			}),
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
		"open_animation_window",
		{
			title: "Open Animation Window",
			description:
				"Open the editor's shared standalone Animation Window on one existing AnimationGroup, selecting its multi-track Dope Sheet/Curve workflow without changing animation data.",
			inputSchema: z.object({ name: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
			description: "Export a real AnimationGroup (all tracks and curves) to a project-relative JSON file.",
			inputSchema: z.object({ name: z.string(), path: z.string(), overwrite: z.literal(true).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("export_animation_group", args)
	);

	server.registerTool(
		"import_animation_group",
		{
			title: "Import animation group",
			description: "Import a serialized AnimationGroup JSON from inside the project. An existing group with the same final name is replaced.",
			inputSchema: z.object({ path: z.string(), name: z.string().optional() }),
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
