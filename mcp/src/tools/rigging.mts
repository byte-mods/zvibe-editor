import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const vector = z.array(z.number()).length(3);
const twoBoneIKUnityFields = {
	targetPositionWeight: z.number().min(0).max(1).optional().describe("Unity-style target-position influence; defaults to 1."),
	targetRotationWeight: z.number().min(0).max(1).optional().describe("Unity-style Tip world-rotation influence from the target; defaults to 0 and requires a child Tip bone."),
	hintWeight: z
		.number()
		.min(0)
		.max(1)
		.optional()
		.describe("Unity-style pole/hint influence; 0 preserves the original animated bend plane and 1 points fully toward the authored pole target. Defaults to 1."),
	maintainTargetPositionOffset: z
		.boolean()
		.optional()
		.describe("Capture the effective chain endpoint in target-local space and preserve that position offset as the target moves/rotates."),
	maintainTargetRotationOffset: z.boolean().optional().describe("Capture the Tip-to-target quaternion offset and preserve it while applying target rotation."),
};
const humanoidMapping = z.record(z.string(), z.string().nullable()).describe("Human-role to skeleton bone-name map. Use null to clear a role when patching.");
const humanoidBodyParts = z
	.object({
		root: z.boolean().optional(),
		body: z.boolean().optional(),
		head: z.boolean().optional(),
		leftArm: z.boolean().optional(),
		rightArm: z.boolean().optional(),
		leftHand: z.boolean().optional(),
		rightHand: z.boolean().optional(),
		leftLeg: z.boolean().optional(),
		rightLeg: z.boolean().optional(),
	})
	.strict();
const muscleLimit = z.object({ min: z.array(z.number().min(-180).max(180)).length(3), max: z.array(z.number().min(-180).max(180)).length(3) });
const musclePose = z
	.record(z.string().min(1).max(64), z.tuple([z.number().min(-1).max(1), z.number().min(-1).max(1), z.number().min(-1).max(1)]))
	.describe("Canonical human-role to normalized local XYZ muscle values. Each axis is bounded to -1..1, where zero is the captured Avatar rest pose.");
const rigParentSource = z.object({ nodeId: z.string().min(1), weight: z.number().min(0).max(1).optional() }).strict();
const rigTwistBone = z.object({ boneName: z.string().min(1).max(512), weight: z.number().min(0).max(1).optional() }).strict();
const rigFullBodyEffector = z
	.object({
		boneName: z.string().min(1).max(512).describe("Descendant effector bone."),
		targetNodeId: z.string().min(1).max(512).describe("TransformNode target id."),
		positionWeight: z.number().min(0).max(1).optional().describe("Target-position influence; defaults to 1."),
		rotationWeight: z.number().min(0).max(1).optional().describe("Target world-rotation influence; defaults to 0."),
	})
	.strict();
const rigCustomJobData = z
	.record(z.string().min(1).max(128), z.unknown())
	.describe("Bounded JSON data copied into the registered TypeScript job on each update. The editor enforces depth, entry-count, finite-number, safe-key, and 64-KiB limits.");
const rigCustomJobFields = {
	jobType: z
		.string()
		.regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/)
		.optional()
		.describe("Project-script job registration id from list_animation_rig_job_types; required for customJob creation."),
	jobVersion: z.number().int().min(1).max(100000).optional().describe("Serialized job-data version; defaults to the registered type version or 1."),
	boneNames: z.array(z.string().min(1).max(512)).max(64).optional().describe("Ordered, unique skeleton-bone handles exposed to the custom job."),
	nodeIds: z.array(z.string().min(1).max(512)).max(64).optional().describe("Ordered, unique TransformNode handles exposed to the custom job."),
	jobData: rigCustomJobData.optional(),
};
const rigBakeFields = {
	skeletonId: z.string().min(1).max(512).describe("Skeleton whose selected rig layers are evaluated and baked."),
	sourceAnimationGroupName: z.string().min(1).max(256).describe("Existing AnimationGroup sampled before the post-animation rig layers are evaluated."),
	layerIds: z.array(z.string().min(1).max(256)).min(1).max(64).optional().describe("Optional exact rig-layer subset. Omit to use every layer belonging to the skeleton."),
	from: z.number().min(-1000000000).max(1000000000).optional().describe("Optional first source frame, contained within the AnimationGroup range."),
	to: z.number().min(-1000000000).max(1000000000).optional().describe("Optional last source frame, greater than from and contained within the AnimationGroup range."),
	sampleRate: z.number().min(1).max(120).optional().describe("Samples per second; defaults to the source clip frame rate. Bounded to 1–120."),
};
const rigConstraintBakeFields = {
	...rigBakeFields,
	constraintRefs: z
		.array(z.object({ layerId: z.string().min(1).max(256), constraintId: z.string().min(1).max(256) }).strict())
		.min(1)
		.max(256)
		.optional()
		.describe("Optional exact inverse-capable layer/constraint pairs. Omit to use all supported enabled constraints in the selected layers."),
};
const twoBoneIKBakeSchema = z
	.object({
		skeletonId: z.string().min(1).max(512).describe("Skeleton whose enabled native Two-Bone IK controllers are inverted into control curves."),
		sourceAnimationGroupName: z.string().min(1).max(256).describe("Existing ordinary skeleton AnimationGroup sampled as the desired pose."),
		ikControllerIds: z
			.array(z.string().min(1).max(256))
			.min(1)
			.max(128)
			.optional()
			.describe("Optional exact native IK controller ids. Omit to use every enabled native Two-Bone IK controller on the skeleton."),
		from: z.number().min(-1000000000).max(1000000000).optional().describe("Optional first source frame, contained within the AnimationGroup range."),
		to: z.number().min(-1000000000).max(1000000000).optional().describe("Optional last source frame, greater than from and contained within the AnimationGroup range."),
		sampleRate: z.number().min(1).max(120).optional().describe("Samples per second; defaults to the source clip frame rate. Bounded to 1–120."),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.ikControllerIds && new Set(value.ikControllerIds).size !== value.ikControllerIds.length) {
			context.addIssue({ code: "custom", path: ["ikControllerIds"], message: "ikControllerIds must not contain duplicates." });
		}
	});
const skinWeightInfluence = z
	.object({
		boneName: z.string().min(1).max(512).describe("Exact bone name from the mesh's bound skeleton."),
		weight: z.number().min(0).max(1).describe("Non-negative influence weight. The editor normalizes retained influences."),
	})
	.strict();
const skinWeightVertex = z
	.object({
		vertexIndex: z.number().int().min(0).describe("Zero-based mesh vertex index."),
		influences: z.array(skinWeightInfluence).min(1).max(8).describe("Complete replacement influence set for this vertex."),
	})
	.strict();
const skinWeightTarget = {
	nodeId: z.string().min(1).max(512).optional().describe("Skinned Mesh id. Provide nodeId or nodeName."),
	nodeName: z.string().min(1).max(512).optional().describe("Skinned Mesh name when its id is unavailable."),
};
const skinWeightOptions = {
	maxInfluences: z.number().int().min(1).max(8).optional().describe("Maximum retained influences per vertex; defaults to 8 for authoring or 4 for optimization."),
	minimumWeight: z.number().min(0).max(0.5).optional().describe("Prune influences at or below this threshold before normalization."),
	fallbackBoneName: z.string().min(1).max(512).optional().describe("Bone used when pruning would leave a vertex unweighted; defaults to skeleton bone 0."),
};

/** Registers skeleton-discovery and native two-bone IK authoring tools. */
export function registerRiggingTools(server: McpServer): void {
	server.registerTool(
		"get_mesh_skin_weights",
		{
			title: "Get Mesh Skin Weights",
			description:
				"Inspect a skinned mesh's Babylon bone-index/weight vertex buffers with up to eight influences per vertex. Returns a complete validation summary, exact SHA-256 edit lease, bone names, local vertex positions, normalized sums, and a bounded paginated vertex page. Filter by explicit vertex ids or one bone name before editing.",
			inputSchema: z
				.object({
					...skinWeightTarget,
					vertexIndices: z.array(z.number().int().min(0)).max(256).optional().describe("Optional exact vertices to inspect."),
					boneName: z.string().min(1).max(512).optional().describe("Return only vertices currently influenced by this bone."),
					offset: z.number().int().min(0).optional().describe("Matched vertices to skip; defaults to 0."),
					limit: z.number().int().min(1).max(256).optional().describe("Maximum returned vertices; defaults to 100."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_skin_weights", args)
	);
	server.registerTool(
		"set_mesh_skin_weights",
		{
			title: "Set Mesh Skin Weights",
			description:
				"Replace the complete named-bone influence set for up to 256 explicit vertices. Duplicate bones are combined, invalid/weak influences are removed, the strongest 1–8 are retained and normalized, and Babylon main/extra skin buffers plus numBoneInfluencers are updated. Requires the exact fingerprint returned by get_mesh_skin_weights.",
			inputSchema: z
				.object({
					...skinWeightTarget,
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current fingerprint from get_mesh_skin_weights."),
					vertices: z.array(skinWeightVertex).min(1).max(256),
					...skinWeightOptions,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_skin_weights", args)
	);
	server.registerTool(
		"paint_mesh_skin_weights",
		{
			title: "Paint Mesh Skin Weights",
			description:
				"Paint one bone using replace, add, subtract, or topology-neighbor smooth mode. Target either explicit vertex ids or a local-space spherical brush with linear/smoothstep falloff. Other weights are proportionally redistributed, pruned, limited to 1–8, and normalized. Requires an exact inspected fingerprint.",
			inputSchema: z
				.object({
					...skinWeightTarget,
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					boneName: z.string().min(1).max(512),
					vertexIndices: z.array(z.number().int().min(0)).max(10000).optional().describe("Exact paint vertices; when provided, center/radius are optional."),
					center: z.tuple([z.number(), z.number(), z.number()]).optional().describe("Brush center in mesh-local centimeters."),
					radius: z.number().positive().max(1000000).optional().describe("Local-space brush radius in centimeters."),
					mode: z.enum(["replace", "add", "subtract", "smooth"]).optional().describe("Defaults to replace."),
					weight: z.number().min(0).max(1).optional().describe("Replace target or add/subtract amount; defaults to 1."),
					opacity: z.number().min(0).max(1).optional().describe("Stroke opacity multiplied by spatial falloff; defaults to 1."),
					falloff: z.enum(["linear", "smoothstep"]).optional().describe("Spherical brush falloff; defaults to smoothstep."),
					...skinWeightOptions,
				})
				.strict()
				.superRefine((value, context) => {
					if (!value.vertexIndices?.length && (!value.center || value.radius === undefined)) {
						context.addIssue({ code: "custom", message: "Provide non-empty vertexIndices or both center and radius." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("paint_mesh_skin_weights", args)
	);
	server.registerTool(
		"optimize_mesh_skin_weights",
		{
			title: "Optimize Mesh Skin Weights",
			description:
				"Repair selected or all skin weights by removing invalid bone indices/non-finite values, combining duplicates, pruning weak influences, retaining the strongest bounded influence count, restoring unweighted vertices to a fallback bone, and normalizing every result. Requires an exact inspected fingerprint.",
			inputSchema: z
				.object({
					...skinWeightTarget,
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					vertexIndices: z.array(z.number().int().min(0)).max(10000).optional().describe("Optional vertices; omit to optimize the entire mesh."),
					...skinWeightOptions,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("optimize_mesh_skin_weights", args)
	);
	server.registerTool(
		"mirror_mesh_skin_weights",
		{
			title: "Mirror Mesh Skin Weights",
			description:
				"Mirror source-side weights to matching opposite-side vertices across local X, Y, or Z. Bone names are automatically swapped for common Left/Right and L/R conventions, with explicit name-pair overrides available. Requires an exact inspected fingerprint and a geometric match within tolerance.",
			inputSchema: z
				.object({
					...skinWeightTarget,
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					axis: z.enum(["x", "y", "z"]).optional().describe("Local mirror axis; defaults to X."),
					direction: z.enum(["negativeToPositive", "positiveToNegative"]).optional().describe("Source side to destination side; defaults to negative-to-positive."),
					tolerance: z.number().positive().max(1000).optional().describe("Maximum local position match distance; defaults to 0.001 cm."),
					bonePairs: z.record(z.string().min(1).max(512), z.string().min(1).max(512)).optional().describe("Explicit source-bone to mirrored-bone name overrides."),
					...skinWeightOptions,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("mirror_mesh_skin_weights", args)
	);
	server.registerTool(
		"list_humanoid_avatar_masks",
		{
			title: "List Humanoid Avatar Masks",
			description: "List reusable humanoid body-part Avatar Masks, their owning Avatars, enabled body parts, additional transforms, and resolved animation target names.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_humanoid_avatar_masks", {})
	);
	server.registerTool(
		"create_humanoid_avatar_mask",
		{
			title: "Create Humanoid Avatar Mask",
			description:
				"Create a reusable Unity-style humanoid Avatar Mask for Animator states/layers. Body parts resolve through one valid Humanoid Avatar; additional transform names support props and non-humanoid branches.",
			inputSchema: z.object({
				id: z.string().min(1).max(256).optional(),
				name: z.string().min(1).max(256).optional(),
				avatarId: z.string().min(1).max(256),
				bodyParts: humanoidBodyParts.optional().describe("Omit to enable all nine body-part groups."),
				transformNames: z.array(z.string().min(1).max(512)).max(512).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_humanoid_avatar_mask", args)
	);
	server.registerTool(
		"set_humanoid_avatar_mask",
		{
			title: "Set Humanoid Avatar Mask",
			description: "Rename a reusable Avatar Mask, change its Humanoid Avatar, patch any body-part toggles, or replace its additional transform-name list.",
			inputSchema: z.object({
				maskId: z.string().min(1).max(256),
				name: z.string().min(1).max(256).optional(),
				avatarId: z.string().min(1).max(256).optional(),
				bodyParts: humanoidBodyParts.optional(),
				transformNames: z.array(z.string().min(1).max(512)).max(512).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_humanoid_avatar_mask", args)
	);
	server.registerTool(
		"delete_humanoid_avatar_mask",
		{
			title: "Delete Humanoid Avatar Mask",
			description: "Delete a reusable Avatar Mask. Referenced masks are protected unless force=true, which also clears Animator state/layer references.",
			inputSchema: z.object({ maskId: z.string().min(1).max(256), force: z.boolean().optional() }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_humanoid_avatar_mask", args)
	);
	server.registerTool(
		"set_humanoid_muscle_limits",
		{
			title: "Set Humanoid Muscle Limits",
			description:
				"Enable/disable live humanoid muscle clamping and patch or replace per-role local XYZ rotation limits in degrees. Each axis is bounded to -180..180 and minimum must not exceed maximum.",
			inputSchema: z.object({
				avatarId: z.string().min(1).max(256),
				enabled: z.boolean().optional(),
				limits: z.record(z.string(), muscleLimit.nullable()).optional().describe("Patch canonical human roles; null clears one role."),
				replaceLimits: z.record(z.string(), muscleLimit).optional().describe("Replace the complete authored limit map."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_humanoid_muscle_limits", args)
	);
	server.registerTool(
		"get_humanoid_muscle_pose",
		{
			title: "Get Humanoid Muscle Pose",
			description:
				"Read every mapped Humanoid bone as normalized -1..1 local XYZ muscle values plus degree deltas, effective limits, limit violations, and active temporary-preview state. This is read-only and does not change Avatar, skeleton, or animation data.",
			inputSchema: z.object({ avatarId: z.string().min(1).max(256).describe("Persisted Humanoid Avatar id.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_humanoid_muscle_pose", args)
	);
	server.registerTool(
		"set_humanoid_pose_preview",
		{
			title: "Set Humanoid Pose Preview",
			description:
				"Start or update a temporary Humanoid pose preview in the editor viewport. Use preset=muscles with a canonical role map of normalized -1..1 XYZ values, preset=rest to inspect the captured rest pose, or preset=tPose to align both mapped arm chains horizontally. Preview values are reapplied after animation evaluation, are not written to Avatar/clip data, and are automatically restored before scene save.",
			inputSchema: z
				.object({
					avatarId: z.string().min(1).max(256).describe("Persisted Humanoid Avatar id."),
					preset: z.enum(["muscles", "rest", "tPose"]).optional().describe("Preview mode. Defaults to the currently active mode or muscles for a new preview."),
					pose: musclePose.optional().describe("Normalized pose patch used by the muscles preset."),
					replace: z.boolean().optional().describe("When true, replace the complete active muscle-pose map before applying this patch."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_humanoid_pose_preview", args)
	);
	server.registerTool(
		"stop_humanoid_pose_preview",
		{
			title: "Stop Humanoid Pose Preview",
			description:
				"Stop one temporary Humanoid pose preview and restore the exact mapped-bone rotations captured when previewing began. It is safe and idempotent when no preview is active.",
			inputSchema: z.object({ avatarId: z.string().min(1).max(256).describe("Persisted Humanoid Avatar id.") }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_humanoid_pose_preview", args)
	);

	server.registerTool(
		"list_humanoid_avatars",
		{
			title: "List Humanoid Avatars",
			description:
				"List persisted Unity-style Generic/Humanoid Avatar definitions, skeletons, canonical human-bone mappings, required/optional coverage, hierarchy errors, and rest-pose/T-pose validation.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_humanoid_avatars", {})
	);
	server.registerTool(
		"get_humanoid_avatar",
		{
			title: "Get Humanoid Avatar",
			description: "Inspect one persisted Avatar including its complete role mapping, captured local rest pose, human scale, skeleton name, and current validation evidence.",
			inputSchema: z.object({ avatarId: z.string().min(1).max(256) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_humanoid_avatar", args)
	);
	server.registerTool(
		"create_humanoid_avatar",
		{
			title: "Create Humanoid Avatar",
			description:
				"Create the persisted Rig/Avatar definition for one skeleton. It can deterministically auto-map common DCC, Mixamo, Unreal, and glTF bone names, apply manual role overrides, or reuse another Avatar's mapped role coverage. One Avatar is allowed per skeleton.",
			inputSchema: z.object({
				id: z.string().min(1).max(256).optional(),
				name: z.string().min(1).max(256).optional(),
				skeletonId: z.string().min(1),
				animationType: z.enum(["none", "generic", "humanoid"]).optional(),
				autoMap: z.boolean().optional(),
				copyFromAvatarId: z.string().min(1).max(256).optional(),
				mapping: humanoidMapping.optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_humanoid_avatar", args)
	);
	server.registerTool(
		"set_humanoid_avatar",
		{
			title: "Set Humanoid Avatar",
			description:
				"Update an Avatar's name or rig type, rerun deterministic automatic mapping, replace the complete mapping, patch/clear individual roles, or recapture the skeleton's local rest pose. Validation is returned after every change.",
			inputSchema: z.object({
				avatarId: z.string().min(1).max(256),
				name: z.string().min(1).max(256).optional(),
				animationType: z.enum(["none", "generic", "humanoid"]).optional(),
				autoMap: z.boolean().optional(),
				mapping: humanoidMapping.optional(),
				replaceMapping: humanoidMapping.optional(),
				refreshRestPose: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_humanoid_avatar", args)
	);
	server.registerTool(
		"validate_humanoid_avatar",
		{
			title: "Validate Humanoid Avatar",
			description:
				"Validate required human roles, unique assignments, referenced bone existence, canonical ancestry, and available T-pose arm evidence without changing the Avatar.",
			inputSchema: z.object({ avatarId: z.string().min(1).max(256) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_humanoid_avatar", args)
	);
	server.registerTool(
		"retarget_humanoid_animation",
		{
			title: "Retarget Humanoid Animation",
			description:
				"Bake a new editable AnimationGroup from a valid source Humanoid Avatar to a valid target Humanoid Avatar. Canonical roles redirect tracks, local rest-pose quaternion deltas correct rotations, and hips translation is scaled by avatar height. Use inspect_humanoid_retarget first to review blockers, skipped tracks, correction angles, and scale evidence without mutating the scene.",
			inputSchema: z.object({
				sourceAvatarId: z.string().min(1).max(256),
				targetAvatarId: z.string().min(1).max(256),
				animationGroupName: z.string().min(1).max(256),
				outputName: z.string().min(1).max(256),
				includeRootTranslation: z.boolean().optional(),
				includeScale: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("retarget_humanoid_animation", args)
	);
	server.registerTool(
		"inspect_humanoid_retarget",
		{
			title: "Inspect Humanoid Retarget",
			description:
				"Analyze one source AnimationGroup against source and target Humanoid Avatars without creating a clip. Returns Avatar validation, human-scale ratio, total/recognized/compatible/skipped track counts, and all 55 role mappings with source/target bones, rest-pose correction Euler/angle evidence, track properties, and actionable skip reasons.",
			inputSchema: z
				.object({
					sourceAvatarId: z.string().min(1).max(256).describe("Source Humanoid Avatar whose mapped bones own the AnimationGroup tracks."),
					targetAvatarId: z.string().min(1).max(256).describe("Target Humanoid Avatar that would receive the baked tracks."),
					animationGroupName: z.string().min(1).max(256).describe("Existing source AnimationGroup name."),
					includeRootTranslation: z.boolean().optional().describe("Analyze Hips position tracks as compatible. Defaults to true."),
					includeScale: z.boolean().optional().describe("Analyze mapped scale tracks as compatible. Defaults to false."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_humanoid_retarget", args)
	);
	server.registerTool(
		"set_humanoid_retarget_debug_visualization",
		{
			title: "Set Humanoid Retarget Debug Visualization",
			description:
				"Show color-coded temporary source (cyan) and target (magenta) skeleton overlays in the editor viewport, optionally with local bone axes, or disable the current overlay. Debug meshes are non-persisted and are disposed before scene save.",
			inputSchema: z
				.object({
					enabled: z.boolean().optional().describe("Set false to dispose the active overlay. Defaults to true."),
					sourceAvatarId: z.string().min(1).max(256).optional().describe("Required when enabling: source Humanoid Avatar id."),
					targetAvatarId: z.string().min(1).max(256).optional().describe("Required when enabling: target Humanoid Avatar id."),
					showAxes: z.boolean().optional().describe("Show local XYZ axes on both skeletons."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_humanoid_retarget_debug_visualization", args)
	);
	server.registerTool(
		"delete_humanoid_avatar",
		{
			title: "Delete Humanoid Avatar",
			description: "Delete one persisted Avatar definition. Previously baked retargeted AnimationGroups remain ordinary editable scene content.",
			inputSchema: z.object({ avatarId: z.string().min(1).max(256) }),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_humanoid_avatar", args)
	);

	server.registerTool(
		"list_sprite_ik_controllers",
		{
			title: "List 2D Sprite IK controllers",
			description: "List persistent planar cutout/sprite root-joint-tip IK controllers and their preview state.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_sprite_ik_controllers", {})
	);
	server.registerTool(
		"list_animation_rig_job_types",
		{
			title: "List Custom Animation Rig Job Types",
			description:
				"List Unity-style custom weighted Animation Rig job definitions registered by loaded project TypeScript modules. Returns stable id, display name, description, serialized data version, root-motion support, and bounded default data for authoring customJob constraints.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_animation_rig_job_types", args)
	);
	server.registerTool(
		"get_animation_rig_profile",
		{
			title: "Get Animation Rig CPU Profile",
			description:
				"Read opt-in CPU timing from the exact shared Animation Rig evaluator used by editor preview, manual/bake evaluation, and exported projects. Returns bounded newest-first timeline samples, scene/layer/constraint min/max/average/last duration summaries, applied/failed/skipped counters, sampling settings, pagination, and explicit dropped/truncated evidence. Timings are CPU wall-clock measurements and are never presented as GPU timing.",
			inputSchema: z
				.object({
					skeletonId: z.string().min(1).max(512).optional().describe("Optional exact skeleton id filter."),
					layerId: z.string().min(1).max(256).optional().describe("Optional exact rig-layer id filter."),
					constraintId: z.string().min(1).max(256).optional().describe("Optional exact constraint id; requires layerId."),
					includeSamples: z.boolean().optional().describe("Include bounded newest-first hierarchical timeline samples; defaults to false."),
					sampleOffset: z.number().int().min(0).optional().describe("Matching retained samples to skip; defaults to 0."),
					sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum returned timeline samples; defaults to 20."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.constraintId && !value.layerId) {
						context.addIssue({ code: "custom", path: ["constraintId"], message: "constraintId requires layerId." });
					}
				}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animation_rig_profile", args)
	);
	server.registerTool(
		"set_animation_rig_profile",
		{
			title: "Set Animation Rig CPU Profiling",
			description:
				"Enable or disable transient CPU profiling around the shared Animation Rig evaluator and configure a 1–256-sample ring plus a 1–120-evaluation sampling interval. Enabling is opt-in because fine-grained per-layer/per-constraint timers add CPU overhead. Existing history is retained; reducing capacity drops oldest samples with an explicit counter.",
			inputSchema: z
				.object({
					enabled: z.boolean().optional(),
					sampleCapacity: z.number().int().min(1).max(256).optional().describe("Retained newest timeline sample capacity; defaults to 120."),
					sampleEveryNEvaluations: z.number().int().min(1).max(120).optional().describe("Capture one detailed sample every N rig evaluations; defaults to 1."),
				})
				.strict()
				.refine((value) => value.enabled !== undefined || value.sampleCapacity !== undefined || value.sampleEveryNEvaluations !== undefined, {
					message: "Provide enabled, sampleCapacity, or sampleEveryNEvaluations.",
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animation_rig_profile", args)
	);
	server.registerTool(
		"clear_animation_rig_profile",
		{
			title: "Clear Animation Rig CPU Profile",
			description:
				"Clear transient Animation Rig timeline samples, summaries, overflow counters, and evaluation counters while retaining the current enabled/capacity/interval settings.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_animation_rig_profile", args)
	);
	server.registerTool(
		"list_rig_layers",
		{
			title: "List Animation Rig Layers",
			description:
				"List persisted post-animation rig layers in deterministic evaluation order, including layer weights, enabled state, all built-in and custom constraints, captured offsets/rest rotations, and validity. Custom jobs report registration/version validation plus create/update/root-motion/animation/error/timing lifecycle evidence.",
			inputSchema: z.object({ skeletonId: z.string().min(1).optional().describe("Optional skeleton id filter.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_rig_layers", args)
	);
	server.registerTool(
		"inspect_rig_to_skeleton_bake",
		{
			title: "Inspect Rig To Skeleton Bake",
			description:
				"Plan a Unity-style Bake To Skeleton operation without changing the scene. Resolves the source AnimationGroup, ordered rig-layer subset, constrained bone closure, temporal Damped Transform count, exact sample/track/key bounds, invalid references, and an exact SHA-256 lease. The bake samples source motion, evaluates the real post-animation rig backend at a fixed step, and produces ordinary editable bone position/quaternion/scale curves.",
			inputSchema: z.object(rigBakeFields).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_rig_to_skeleton_bake", args)
	);
	server.registerTool(
		"bake_rig_to_skeleton_animation",
		{
			title: "Bake Rig To Skeleton Animation",
			description:
				"Execute an inspected Unity-style Bake To Skeleton plan into a new ordinary editable AnimationGroup. Requires the exact fingerprint from inspect_rig_to_skeleton_bake, never overwrites an existing group, bounds work to 4,096 samples/256 bones/1,000,000 keys, uses deterministic fixed-step Damped Transform history, preserves quaternion continuity, and restores the complete source properties, skeleton pose, and temporal state on success or failure.",
			inputSchema: z
				.object({
					...rigBakeFields,
					outputName: z.string().min(1).max(256).describe("Unique name for the new editable AnimationGroup."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current fingerprint from inspect_rig_to_skeleton_bake using identical plan options."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_rig_to_skeleton_animation", args)
	);
	server.registerTool(
		"inspect_rig_to_constraint_bake",
		{
			title: "Inspect Rig To Constraint Bake",
			description:
				"Plan Unity-style Bake To Constraint without changing the scene. Selects only inverse-capable Multi-Parent, Multi-Position, and Multi-Aim constraints, identifies exact skeleton curves transferred to rig controls and source tracks preserved, validates full-weight/axis/reference requirements, bounds samples/controls/keys, and returns an exact SHA-256 lease. Forward-only constraint types are explicitly reported rather than falsely inverted.",
			inputSchema: z.object(rigConstraintBakeFields).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_rig_to_constraint_bake", args)
	);
	server.registerTool(
		"bake_rig_to_constraint_animation",
		{
			title: "Bake Rig To Constraint Animation",
			description:
				"Execute an exact inspected skeleton-to-rig-control transfer into a new ordinary editable AnimationGroup. Removes only the selected constraints' driven skeleton channels, preserves unrelated source tracks, bakes local control position/quaternion curves, forward-validates every sample through the real rig evaluator within 0.05 cm/0.25 degrees, never overwrites, and restores source properties, controls, skeleton pose, and temporal state on success or failure.",
			inputSchema: z
				.object({
					...rigConstraintBakeFields,
					outputName: z.string().min(1).max(256).describe("Unique name for the new editable control AnimationGroup."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current fingerprint from inspect_rig_to_constraint_bake using identical plan options."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_rig_to_constraint_animation", args)
	);
	server.registerTool(
		"inspect_two_bone_ik_constraint_bake",
		{
			title: "Inspect Two-Bone IK Constraint Bake",
			description:
				"Plan an exact native Two-Bone IK Bake To Constraint transfer without changing the scene. Resolves root/mid/tip chains and target plus optional pole/hint controls, identifies root/mid and enabled Tip rotation tracks removed, reports target position/quaternion and hint position curves to create, supports captured target position/rotation offsets, requires exact inverse-capable weights, rejects overlapping controls/chains, bounds samples/controllers/keys, and returns an exact SHA-256 lease for deterministic forward validation through the real shared runtime.",
			inputSchema: twoBoneIKBakeSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_two_bone_ik_constraint_bake", args)
	);
	server.registerTool(
		"bake_two_bone_ik_constraint_animation",
		{
			title: "Bake Two-Bone IK Constraint Animation",
			description:
				"Execute an inspected native Two-Bone IK skeleton-to-control transfer into a new ordinary editable AnimationGroup. Writes local target position/quaternion and optional pole/hint position curves, exactly inverts captured target offsets, removes only selected root/mid and enabled Tip rotation tracks, preserves unrelated source tracks, forward-validates every sample within 0.05 cm and 0.25 degrees through the shared runtime, never overwrites, and restores source, skeleton, mesh, and control state on success or failure.",
			inputSchema: twoBoneIKBakeSchema.extend({
				outputName: z.string().min(1).max(256).describe("Unique name for the new editable IK-control AnimationGroup."),
				expectedFingerprint: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.describe("Exact current fingerprint from inspect_two_bone_ik_constraint_bake using identical plan options."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_two_bone_ik_constraint_animation", args)
	);
	server.registerTool(
		"create_rig_layer",
		{
			title: "Create Animation Rig Layer",
			description: "Create a persisted weighted rig layer for one skeleton. Layers evaluate after animation by ascending order, then by constraint list order.",
			inputSchema: z
				.object({
					id: z.string().min(1).max(256).optional(),
					name: z.string().min(1).max(256).optional(),
					skeletonId: z.string().min(1),
					order: z.number().int().min(-1000).max(1000).optional(),
					weight: z.number().min(0).max(1).optional(),
					enabled: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_rig_layer", args)
	);
	server.registerTool(
		"set_rig_layer",
		{
			title: "Set Animation Rig Layer",
			description: "Rename, enable/disable, reweight, or reorder one persisted post-animation rig layer.",
			inputSchema: z
				.object({
					layerId: z.string().min(1).max(256),
					name: z.string().min(1).max(256).optional(),
					order: z.number().int().min(-1000).max(1000).optional(),
					weight: z.number().min(0).max(1).optional(),
					enabled: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rig_layer", args)
	);
	server.registerTool(
		"delete_rig_layer",
		{
			title: "Delete Animation Rig Layer",
			description: "Delete one rig layer and every constraint owned by it.",
			inputSchema: z.object({ layerId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_rig_layer", args)
	);
	server.registerTool(
		"create_rig_constraint",
		{
			title: "Create Animation Rig Constraint",
			description:
				"Append an ordered constraint to one rig layer. Supports all built-ins plus customJob, which binds serialized JSON and ordered bone/node handles to a project-registered TypeScript Animation Rig job. The shared preview/export runtime runs create, update, ProcessRootMotion, ProcessAnimation, and destroy lifecycle stages with the layer/constraint weight.",
			inputSchema: z
				.object({
					layerId: z.string().min(1).max(256),
					id: z.string().min(1).max(256).optional(),
					name: z.string().min(1).max(256).optional(),
					type: z.enum([
						"multiParent",
						"twist",
						"chainIk",
						"multiPosition",
						"multiAim",
						"fullBodyIk",
						"overrideTransform",
						"dampedTransform",
						"blendTransform",
						"customJob",
					]),
					weight: z.number().min(0).max(1).optional(),
					enabled: z.boolean().optional(),
					boneName: z.string().min(1).max(512).optional().describe("Target bone for multiParent, multiPosition, or multiAim."),
					sources: z.array(rigParentSource).min(1).max(8).optional().describe("Weighted TransformNode sources for multiParent, multiPosition, or multiAim."),
					sourceBoneName: z.string().min(1).max(512).optional().describe("twist source bone."),
					axis: vector.optional().describe("twist source local axis; defaults to +X."),
					twistBones: z.array(rigTwistBone).min(1).max(16).optional(),
					rootBoneName: z.string().min(1).max(512).optional().describe("chainIk or fullBodyIk root bone; must be an ancestor of every solved effector."),
					tipBoneName: z.string().min(1).max(512).optional().describe("chainIk terminal bone."),
					targetNodeId: z.string().min(1).max(512).optional().describe("chainIk TransformNode target id."),
					maxIterations: z.number().int().min(1).max(64).optional().describe("chainIk/fullBodyIk iteration cap; defaults to 15/12 respectively."),
					tolerance: z.number().min(0.0001).max(100).optional().describe("chainIk/fullBodyIk target tolerance in centimeters; defaults to 0.01/0.1 respectively."),
					chainRotationWeight: z.number().min(0).max(1).optional().describe("chainIk position/rotation solve weight; defaults to 1."),
					tipRotationWeight: z.number().min(0).max(1).optional().describe("chainIk target world-rotation influence on the tip; defaults to 0."),
					maintainOffset: z.boolean().optional().describe("Capture the current target offset for multiPosition or multiAim; defaults to true."),
					positionAxes: z.tuple([z.boolean(), z.boolean(), z.boolean()]).optional().describe("multiPosition or Override/Damped/Blend world-position XYZ channel mask."),
					aimAxis: vector.optional().describe("multiAim target-local direction axis; defaults to +X."),
					upAxis: vector.optional().describe("multiAim target-local up axis; defaults to +Y and cannot be parallel to aimAxis."),
					worldUpAxis: vector.optional().describe("multiAim world stabilization axis; defaults to +Y."),
					effectors: z.array(rigFullBodyEffector).min(1).max(8).optional().describe("fullBodyIk descendant bone targets; effector bones must be unique."),
					sourceNodeId: z.string().min(1).max(512).optional().describe("overrideTransform/dampedTransform source TransformNode id."),
					sourceNodeIdA: z.string().min(1).max(512).optional().describe("blendTransform first source TransformNode id."),
					sourceNodeIdB: z.string().min(1).max(512).optional().describe("blendTransform second, different source TransformNode id."),
					positionWeight: z.number().min(0).max(1).optional().describe("Override/damped/blend position influence; defaults to 1."),
					rotationWeight: z.number().min(0).max(1).optional().describe("Override/damped/blend rotation influence; defaults to 1."),
					rotationAxes: z.tuple([z.boolean(), z.boolean(), z.boolean()]).optional().describe("Override/damped/blend world-rotation XYZ mask."),
					positionDamping: z.number().min(0).max(1).optional().describe("dampedTransform position damping; 0 is responsive and 1 is slow."),
					rotationDamping: z.number().min(0).max(1).optional().describe("dampedTransform rotation damping; 0 is responsive and 1 is slow."),
					blend: z.number().min(0).max(1).optional().describe("blendTransform source interpolation; 0 selects A and 1 selects B."),
					...rigCustomJobFields,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_rig_constraint", args)
	);
	server.registerTool(
		"set_rig_constraint",
		{
			title: "Set Animation Rig Constraint",
			description:
				"Rename, enable/disable, or reweight one constraint. Structural edits recapture/validate type-specific data, including custom job type/version, ordered bone/node handles, and complete bounded JSON data.",
			inputSchema: z
				.object({
					layerId: z.string().min(1).max(256),
					constraintId: z.string().min(1).max(256),
					name: z.string().min(1).max(256).optional(),
					weight: z.number().min(0).max(1).optional(),
					enabled: z.boolean().optional(),
					boneName: z.string().min(1).max(512).optional(),
					sources: z.array(rigParentSource).min(1).max(8).optional(),
					sourceBoneName: z.string().min(1).max(512).optional(),
					axis: vector.optional(),
					twistBones: z.array(rigTwistBone).min(1).max(16).optional(),
					rootBoneName: z.string().min(1).max(512).optional(),
					tipBoneName: z.string().min(1).max(512).optional(),
					targetNodeId: z.string().min(1).max(512).optional(),
					maxIterations: z.number().int().min(1).max(64).optional(),
					tolerance: z.number().min(0.0001).max(100).optional(),
					chainRotationWeight: z.number().min(0).max(1).optional(),
					tipRotationWeight: z.number().min(0).max(1).optional(),
					maintainOffset: z.boolean().optional(),
					positionAxes: z.tuple([z.boolean(), z.boolean(), z.boolean()]).optional(),
					aimAxis: vector.optional(),
					upAxis: vector.optional(),
					worldUpAxis: vector.optional(),
					effectors: z.array(rigFullBodyEffector).min(1).max(8).optional(),
					sourceNodeId: z.string().min(1).max(512).optional(),
					sourceNodeIdA: z.string().min(1).max(512).optional(),
					sourceNodeIdB: z.string().min(1).max(512).optional(),
					positionWeight: z.number().min(0).max(1).optional(),
					rotationWeight: z.number().min(0).max(1).optional(),
					rotationAxes: z.tuple([z.boolean(), z.boolean(), z.boolean()]).optional(),
					positionDamping: z.number().min(0).max(1).optional(),
					rotationDamping: z.number().min(0).max(1).optional(),
					blend: z.number().min(0).max(1).optional(),
					...rigCustomJobFields,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rig_constraint", args)
	);
	server.registerTool(
		"delete_rig_constraint",
		{
			title: "Delete Animation Rig Constraint",
			description: "Delete one ordered rig constraint, including Full-Body IK and its complete effector set.",
			inputSchema: z.object({ layerId: z.string().min(1).max(256), constraintId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_rig_constraint", args)
	);
	server.registerTool(
		"get_rig_constraint_graph",
		{
			title: "Get Rig Constraint Graph",
			description:
				"Inspect one Animation Rig layer as a visual data-flow graph. Returns Transform and bone inputs, constraint nodes, driven-bone outputs, labeled dependency edges, persisted freeform positions, canvas bounds, validity, and an exact SHA-256 layout fingerprint.",
			inputSchema: z.object({ layerId: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_rig_constraint_graph", args)
	);
	server.registerTool(
		"set_rig_constraint_graph_layout",
		{
			title: "Set Rig Constraint Graph Layout",
			description:
				"Persist freeform positions for existing source, constraint, and driven-bone graph nodes, or apply deterministic source/constraint/output auto-layout. Requires the exact fingerprint returned by get_rig_constraint_graph and never changes constraint evaluation behavior.",
			inputSchema: z
				.object({
					layerId: z.string().min(1).max(256),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current graph fingerprint from get_rig_constraint_graph."),
					positions: z
						.array(
							z
								.object({
									nodeId: z.string().min(1).max(1024),
									position: z.tuple([z.number().min(0).max(100000), z.number().min(0).max(100000)]),
								})
								.strict()
						)
						.max(512)
						.optional(),
					replace: z.boolean().optional().describe("Replace the stored layout before applying positions. Defaults to patching the current layout."),
					autoLayout: z.boolean().optional().describe("Ignore supplied positions and apply deterministic three-column auto-layout."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.autoLayout !== true && !value.positions?.length) {
						context.addIssue({ code: "custom", message: "Provide at least one position or set autoLayout=true." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rig_constraint_graph_layout", args)
	);
	server.registerTool(
		"bake_sprite_ik_animation",
		{
			title: "Bake 2D Sprite IK animation",
			description:
				"Bake a sequence of planar Sprite IK target positions into a real editable AnimationGroup with root/joint rotation tracks. Positions are centimeters; frames must increase.",
			inputSchema: z.object({
				id: z.string().describe("Existing Sprite IK controller id."),
				name: z.string().min(1),
				framesPerSecond: z.number().positive().optional(),
				poses: z.array(z.object({ frame: z.number(), targetPosition: vector })).min(2),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("bake_sprite_ik_animation", args)
	);
	server.registerTool(
		"create_sprite_ik_rig",
		{
			title: "Create 2D Sprite IK rig",
			description: "Create editable Root → Joint → Tip and Target TransformNodes plus a persisted planar cutout Sprite IK controller. Lengths and positions are centimeters.",
			inputSchema: z.object({
				id: z.string().optional(),
				name: z.string().min(1).optional(),
				firstLength: z.number().positive().optional(),
				secondLength: z.number().positive().optional(),
				position: vector.optional(),
				targetPosition: vector.optional(),
				bendDirection: z.enum(["clockwise", "counterClockwise"]).optional(),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_ik_rig", args)
	);
	server.registerTool(
		"create_sprite_ik_controller",
		{
			title: "Create 2D Sprite IK controller",
			description:
				"Create a persistent planar cutout/sprite two-bone IK chain. rootNodeId -> jointNodeId -> tipNodeId must be TransformNode parents with non-zero XY segment offsets; targetNodeId is a TransformNode.",
			inputSchema: z.object({
				id: z.string().optional(),
				rootNodeId: z.string(),
				jointNodeId: z.string(),
				tipNodeId: z.string(),
				targetNodeId: z.string(),
				bendDirection: z.enum(["clockwise", "counterClockwise"]).optional(),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_sprite_ik_controller", args)
	);
	server.registerTool(
		"set_sprite_ik_controller",
		{
			title: "Set 2D Sprite IK controller",
			description: "Update a Sprite IK target, bend direction, or enabled state.",
			inputSchema: z.object({
				id: z.string(),
				targetNodeId: z.string().optional(),
				bendDirection: z.enum(["clockwise", "counterClockwise"]).optional(),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_sprite_ik_controller", args)
	);
	server.registerTool(
		"delete_sprite_ik_controller",
		{ title: "Delete 2D Sprite IK controller", description: "Stop and delete a persistent planar Sprite IK controller.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_sprite_ik_controller", args)
	);

	server.registerTool(
		"list_look_at_constraints",
		{
			title: "List bone look-at constraints",
			description: "List persisted bone look-at constraints and their preview activation state.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_look_at_constraints", {})
	);
	server.registerTool(
		"create_look_at_constraint",
		{
			title: "Create bone look-at constraint",
			description: "Create a persistent BoneLookController that rotates a skeleton bone toward a mesh/transform target in preview and exported games.",
			inputSchema: z.object({
				id: z.string().optional(),
				skeletonId: z.string(),
				boneName: z.string(),
				meshId: z.string(),
				targetNodeId: z.string(),
				minYaw: z.number().optional(),
				maxYaw: z.number().optional(),
				minPitch: z.number().optional(),
				maxPitch: z.number().optional(),
				slerpAmount: z.number().min(0).max(1).optional(),
				adjustYaw: z.number().optional(),
				adjustPitch: z.number().optional(),
				adjustRoll: z.number().optional(),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_look_at_constraint", args)
	);
	server.registerTool(
		"set_look_at_constraint",
		{
			title: "Set bone look-at constraint",
			description: "Update a look-at target, enabled state, yaw/pitch limits, smoothing, or rotation adjustments.",
			inputSchema: z.object({
				id: z.string(),
				targetNodeId: z.string().optional(),
				enabled: z.boolean().optional(),
				minYaw: z.number().optional(),
				maxYaw: z.number().optional(),
				minPitch: z.number().optional(),
				maxPitch: z.number().optional(),
				slerpAmount: z.number().min(0).max(1).optional(),
				adjustYaw: z.number().optional(),
				adjustPitch: z.number().optional(),
				adjustRoll: z.number().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_look_at_constraint", args)
	);
	server.registerTool(
		"delete_look_at_constraint",
		{ title: "Delete bone look-at constraint", description: "Stop and delete a persistent bone look-at constraint.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_look_at_constraint", args)
	);

	server.registerTool(
		"get_skeleton_bones",
		{
			title: "Get skeleton bones",
			description: "Get a skeleton hierarchy, including bone names, parents, lengths, and child counts. Choose a non-root bone with a child for two-bone IK.",
			inputSchema: z.object({ skeletonId: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_skeleton_bones", args)
	);
	server.registerTool(
		"list_ik_controllers",
		{
			title: "List IK controllers",
			description: "List persistent native Babylon two-bone IK controllers and live status.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_ik_controllers", {})
	);
	server.registerTool(
		"create_ik_controller",
		{
			title: "Create two-bone IK controller",
			description:
				"Create a persistent native Two-Bone IK constraint shared by editor preview and exported games. The selected mid/lower bone needs a parent and length/child; target rotation additionally needs a child Tip. Supports Unity-style target position/rotation weights, pole/hint weight, and captured target-local position/quaternion offsets.",
			inputSchema: z
				.object({
					id: z.string().optional(),
					skeletonId: z.string(),
					boneName: z.string(),
					meshId: z.string(),
					targetNodeId: z.string(),
					poleTargetNodeId: z.string().optional(),
					poleAngle: z.number().optional(),
					bendAxis: vector.optional(),
					maxAngle: z.number().positive().optional(),
					slerpAmount: z.number().min(0).max(1).optional(),
					...twoBoneIKUnityFields,
					enabled: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_ik_controller", args)
	);
	server.registerTool(
		"set_ik_controller",
		{
			title: "Set IK controller",
			description:
				"Update a native Two-Bone IK constraint, including Unity-style target position/rotation/hint weights and maintain-offset toggles. Hint Weight blends from the original animated bend plane toward the pole target. Enabling a maintain-offset toggle recaptures the current target-local endpoint or Tip rotation offset. Null detaches the pole target.",
			inputSchema: z
				.object({
					id: z.string(),
					enabled: z.boolean().optional(),
					poleTargetNodeId: z
						.string()
						.min(1)
						.nullable()
						.optional()
						.describe("Transform/mesh pole target, or null to detach the current pole target; changes recreate only the live controller."),
					poleAngle: z.number().optional(),
					bendAxis: vector.optional(),
					maxAngle: z.number().positive().optional(),
					slerpAmount: z.number().min(0).max(1).optional(),
					...twoBoneIKUnityFields,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_ik_controller", args)
	);
	server.registerTool(
		"delete_ik_controller",
		{
			title: "Delete IK controller",
			description: "Stop and delete a persistent IK controller.",
			inputSchema: z.object({ id: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_ik_controller", args)
	);
}
