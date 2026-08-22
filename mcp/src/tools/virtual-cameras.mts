import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

const identity = { virtualCameraId: z.string().optional(), virtualCameraName: z.string().optional() };
const vector = z.tuple([z.number(), z.number(), z.number()]);
const noiseLayer = z
	.object({
		amplitude: z.number().min(-100000).max(100000).describe("Position amplitude in editor centimeters or rotation amplitude in degrees."),
		frequency: z.number().positive().max(120).describe("Layer frequency in Hz."),
		nonRandom: z.boolean().optional().describe("Use a periodic sine wave instead of deterministic smooth noise."),
		phase: z.number().min(-100000).max(100000).optional(),
	})
	.strict();
const noiseChannels = z.object({ x: z.array(noiseLayer).max(8), y: z.array(noiseLayer).max(8), z: z.array(noiseLayer).max(8) }).strict();
const mutationAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export function registerVirtualCameraTools(server: McpServer): void {
	server.registerTool(
		"list_virtual_cameras",
		{ title: "List virtual cameras", description: "List persisted virtual camera definitions.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_virtual_cameras")
	);
	server.registerTool(
		"list_camera_noise_profiles",
		{
			title: "List Camera Noise Profiles",
			description:
				"List reusable six-axis layered Cinemachine-style noise profiles. Position amplitudes are centimeters; rotation amplitudes are degrees; frequencies are Hz.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("list_camera_noise_profiles")
	);
	server.registerTool(
		"set_camera_noise_profile",
		{
			title: "Set Camera Noise Profile",
			description:
				"Create or atomically replace a reusable deterministic Basic Multi Channel style profile with up to eight smooth-noise or sine layers on each position and rotation axis. At least one layer is required.",
			inputSchema: z
				.object({
					noiseProfileId: z.string().min(1).optional(),
					noiseProfileName: z.string().min(1).optional(),
					name: z.string().min(1).max(256).optional(),
					position: noiseChannels.optional(),
					rotation: noiseChannels.optional(),
				})
				.strict(),
			annotations: mutationAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_noise_profile", args)
	);
	server.registerTool(
		"delete_camera_noise_profile",
		{
			title: "Delete Camera Noise Profile",
			description:
				"Delete one reusable camera-noise profile. Referenced profiles reject unless force is true, which also clears virtual-camera and impulse-source references.",
			inputSchema: z.object({ noiseProfileId: z.string().min(1).optional(), noiseProfileName: z.string().min(1).optional(), force: z.boolean().optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_camera_noise_profile", args)
	);
	server.registerTool(
		"create_virtual_camera",
		{
			title: "Create virtual camera",
			description: "Create a Cinemachine-style virtual camera over an existing editor camera.",
			inputSchema: z.object({
				name: z.string(),
				cameraId: z.string(),
				followNodeId: z.string().optional(),
				lookAtNodeId: z.string().optional(),
				offset: z.array(z.number()).length(3).optional(),
				priority: z.number().optional(),
				activate: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_virtual_camera", args)
	);
	server.registerTool(
		"set_virtual_camera_noise",
		{
			title: "Set Virtual Camera Noise",
			description:
				"Assign, update, mute, or clear continuous post-composition six-axis noise on one virtual camera. The profile's position/rotation amplitudes are scaled by amplitudeGain, its frequencies by frequencyGain, and pivotOffset is in camera-space centimeters.",
			inputSchema: z
				.object({
					...identity,
					noiseProfileId: z.string().min(1).nullable().optional(),
					enabled: z.boolean().optional(),
					amplitudeGain: z.number().min(0).max(1000).optional(),
					frequencyGain: z.number().min(0).max(1000).optional(),
					pivotOffset: vector.optional(),
					seed: z.number().int().min(-2147483648).max(2147483647).optional(),
				})
				.strict(),
			annotations: mutationAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_noise", args)
	);
	server.registerTool(
		"set_virtual_camera_deoccluder",
		{
			title: "Set Virtual Camera Deoccluder",
			description:
				"Configure bounded physics-ray line-of-sight evaluation, obstacle avoidance, damping, and shot quality for a virtual camera with a follow/look-at target. Strategies are pull forward, preserve height, or preserve target distance.",
			inputSchema: z
				.object({
					...identity,
					enabled: z.boolean().optional(),
					clear: z.boolean().optional(),
					avoidObstacles: z.boolean().optional(),
					strategy: z.enum(["pullForward", "preserveHeight", "preserveDistance"]).optional(),
					collideLayerMask: z.number().int().min(0).max(2147483647).optional(),
					transparentLayerMask: z.number().int().min(0).max(2147483647).optional(),
					ignoreNodeIds: z.array(z.string().min(1)).max(128).optional(),
					minimumDistanceFromTarget: z.number().min(0).max(1000000000).optional(),
					distanceLimit: z.number().min(0).max(1000000000).optional(),
					cameraRadius: z.number().min(0).max(1000000).optional(),
					minimumOcclusionTime: z.number().min(0).max(60).optional(),
					damping: z.number().min(0).max(60).optional(),
					dampingWhenOccluded: z.number().min(0).max(60).optional(),
					maximumEffort: z.number().int().min(1).max(16).optional(),
					shotQuality: z
						.object({
							enabled: z.boolean().optional(),
							optimalDistance: z.number().positive().max(1000000000).optional(),
							nearLimit: z.number().min(0).max(1000000000).optional(),
							farLimit: z.number().positive().max(1000000000).optional(),
							maximumQualityBoost: z.number().min(0).max(10).optional(),
						})
						.strict()
						.optional(),
				})
				.strict(),
			annotations: mutationAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_deoccluder", args)
	);
	server.registerTool(
		"set_virtual_camera_impulse_listener",
		{
			title: "Set Virtual Camera Impulse Listener",
			description: "Set the positive 31-bit channel mask used to accept or reject manual, script-event, and collision impulses on one virtual camera.",
			inputSchema: z.object({ ...identity, channelMask: z.number().int().min(1).max(2147483647) }).strict(),
			annotations: mutationAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_impulse_listener", args)
	);
	server.registerTool(
		"get_virtual_camera_runtime",
		{
			title: "Get Virtual Camera Runtime",
			description:
				"Read the latest shared runtime evidence for one virtual camera without advancing it: ideal/resolved pose, obstruction, displacement, obstacle, strategy, shot quality, layered noise correction, and warnings.",
			inputSchema: z.object(identity).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_virtual_camera_runtime", args)
	);
	server.registerTool(
		"list_camera_impulse_sources",
		{
			title: "List camera impulse sources",
			description: "List persisted decaying camera-shake source definitions.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_camera_impulse_sources")
	);
	server.registerTool(
		"set_camera_impulse_source",
		{
			title: "Set camera impulse source",
			description: "Create or update a persisted decaying camera-shake source. Distances are centimeters and duration is seconds.",
			inputSchema: z.object({
				impulseId: z.string().optional(),
				impulseName: z.string().optional(),
				name: z.string().optional(),
				amplitude: z.number().nonnegative(),
				duration: z.number().positive(),
				frequency: z.number().positive(),
				direction: z.array(z.number()).length(3),
				cameraId: z.string().optional(),
				channelMask: z.number().int().min(1).max(2147483647).optional(),
				noiseProfileId: z.string().min(1).optional(),
				rotationGain: z.number().min(0).max(1000).optional(),
				dissipationDistance: z.number().min(0).max(1000000000).optional(),
				sourceNodeId: z.string().min(1).optional(),
				trigger: z
					.object({
						type: z.literal("collision"),
						nodeId: z.string().min(1),
						minimumImpact: z.number().min(0).max(1000000000).default(0),
						includeContinued: z.boolean().default(false),
						cooldownSeconds: z.number().min(0).max(60).default(0),
						useImpactDirection: z.boolean().default(true),
					})
					.strict()
					.optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_impulse_source", args)
	);
	server.registerTool(
		"fire_camera_impulse",
		{
			title: "Fire camera impulse",
			description: "Fire a persisted camera-shake source in the editor preview.",
			inputSchema: z
				.object({
					impulseId: z.string().optional(),
					impulseName: z.string().optional(),
					origin: vector.optional(),
					direction: vector.optional(),
					impact: z.number().min(0).max(1000000000).optional(),
				})
				.strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("fire_camera_impulse", args)
	);
	server.registerTool(
		"delete_camera_impulse_source",
		{
			title: "Delete camera impulse source",
			description: "Delete a persisted camera-shake source.",
			inputSchema: z.object({ impulseId: z.string().optional(), impulseName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_camera_impulse_source", args)
	);
	server.registerTool(
		"list_camera_target_groups",
		{ title: "List camera target groups", description: "List persisted weighted camera target groups.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_camera_target_groups")
	);
	server.registerTool(
		"set_camera_target_group",
		{
			title: "Set camera target group",
			description: "Create or update a weighted group of scene nodes for virtual-camera follow or look-at behavior.",
			inputSchema: z.object({
				targetGroupId: z.string().optional(),
				targetGroupName: z.string().optional(),
				name: z.string().optional(),
				members: z.array(z.object({ nodeId: z.string(), weight: z.number().positive() })).min(1),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_target_group", args)
	);
	server.registerTool(
		"set_virtual_camera_target_groups",
		{
			title: "Set virtual-camera target groups",
			description: "Assign or clear weighted follow/look-at target groups on a virtual camera.",
			inputSchema: z.object({ ...identity, followTargetGroupId: z.string().nullable().optional(), lookAtTargetGroupId: z.string().nullable().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_target_groups", args)
	);
	server.registerTool(
		"delete_camera_target_group",
		{
			title: "Delete camera target group",
			description: "Delete a target group and clear virtual-camera references.",
			inputSchema: z.object({ targetGroupId: z.string().optional(), targetGroupName: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_camera_target_group", args)
	);
	server.registerTool(
		"set_virtual_camera_dolly",
		{
			title: "Set virtual-camera dolly",
			description: "Attach a virtual camera to an editor spline, or clear its dolly with splineId null. Speed is centimeters per second.",
			inputSchema: z.object({
				...identity,
				splineId: z.string().nullable(),
				t: z.number().min(0).max(1).optional(),
				speed: z.number().nonnegative().optional(),
				loop: z.boolean().optional(),
				orientToPath: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_dolly", args)
	);
	server.registerTool(
		"get_virtual_camera_path_timeline",
		{
			title: "Get virtual-camera path timeline",
			description: "Read one persisted exact-revision spline camera-path timeline and its transient playhead, segment, easing, loop, and normalized-path evidence.",
			inputSchema: z
				.object({ virtualCameraId: z.string().min(1).max(256).optional(), virtualCameraName: z.string().min(1).max(256).optional() })
				.strict()
				.superRefine((value, context) => {
					if (!!value.virtualCameraId === !!value.virtualCameraName) {
						context.addIssue({ code: "custom", message: "Provide exactly one virtualCameraId or virtualCameraName." });
					}
				}),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_virtual_camera_path_timeline", args)
	);
	server.registerTool(
		"set_virtual_camera_path_timeline",
		{
			title: "Set virtual-camera path timeline",
			description:
				"Create, exact-revision update, or clear a bounded timeline that maps seconds to normalized spline distance. Keys are strictly time-ordered, include exact 0/duration endpoints, and use outgoing linear/ease/step interpolation.",
			inputSchema: z
				.object({
					virtualCameraId: z.string().min(1).max(256).optional(),
					virtualCameraName: z.string().min(1).max(256).optional(),
					expectedRevision: z.number().int().positive().optional(),
					clear: z.boolean().optional(),
					duration: z.number().min(0.01).max(86_400).optional(),
					autoPlay: z.boolean().optional(),
					wrapMode: z.enum(["once", "loop", "pingPong"]).optional(),
					keys: z
						.array(
							z
								.object({
									id: z.string().min(1).max(256).optional(),
									time: z.number().min(0).max(86_400),
									t: z.number().min(0).max(1),
									easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut", "step"]).optional(),
								})
								.strict()
						)
						.min(2)
						.max(512)
						.optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!!value.virtualCameraId === !!value.virtualCameraName) {
						context.addIssue({ code: "custom", message: "Provide exactly one virtualCameraId or virtualCameraName." });
					}
					if (value.clear && value.expectedRevision === undefined) {
						context.addIssue({ code: "custom", message: "Clearing requires expectedRevision." });
					}
					if (value.clear && (value.duration !== undefined || value.autoPlay !== undefined || value.wrapMode !== undefined || value.keys !== undefined)) {
						context.addIssue({ code: "custom", message: "A clear request cannot include timeline authoring fields." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_virtual_camera_path_timeline", args)
	);
	server.registerTool(
		"control_virtual_camera_path_timeline",
		{
			title: "Control virtual-camera path timeline",
			description: "Play, pause, stop, or seek the transient playhead of one exact-revision spline camera-path timeline and immediately preview its camera pose.",
			inputSchema: z
				.object({
					virtualCameraId: z.string().min(1).max(256).optional(),
					virtualCameraName: z.string().min(1).max(256).optional(),
					expectedRevision: z.number().int().positive(),
					action: z.enum(["play", "pause", "stop", "seek"]),
					time: z.number().min(0).max(86_400).optional(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!!value.virtualCameraId === !!value.virtualCameraName) {
						context.addIssue({ code: "custom", message: "Provide exactly one virtualCameraId or virtualCameraName." });
					}
					if ((value.action === "seek") !== (value.time !== undefined)) {
						context.addIssue({ code: "custom", message: "Seek requires time; other actions do not accept it." });
					}
				}),
			annotations: mutationAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("control_virtual_camera_path_timeline", args)
	);
	server.registerTool(
		"blend_virtual_camera",
		{
			title: "Blend virtual camera",
			description: "Interpolate active camera pose into a destination virtual camera, then activate it.",
			inputSchema: z.object({ ...identity, duration: z.number().nonnegative().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("blend_virtual_camera", args)
	);
	server.registerTool(
		"activate_virtual_camera",
		{ title: "Activate virtual camera", description: "Apply follow/look-at pose and activate a virtual camera.", inputSchema: z.object(identity) },
		async (args): Promise<CallToolResult> => callTextTool("activate_virtual_camera", args)
	);
	server.registerTool(
		"activate_highest_priority_virtual_camera",
		{ title: "Activate highest priority camera", description: "Activate the highest-priority virtual camera.", inputSchema: z.object({}) },
		async (): Promise<CallToolResult> => callTextTool("activate_highest_priority_virtual_camera")
	);
	server.registerTool(
		"delete_virtual_camera",
		{ title: "Delete virtual camera", description: "Delete a virtual camera definition without deleting its real camera.", inputSchema: z.object(identity) },
		async (args): Promise<CallToolResult> => callTextTool("delete_virtual_camera", args)
	);
}
