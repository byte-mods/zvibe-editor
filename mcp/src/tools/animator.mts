import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identity = { controllerId: z.string().optional(), controllerName: z.string().optional() };
const humanBone = z.enum([
	"hips",
	"spine",
	"chest",
	"upperChest",
	"neck",
	"head",
	"leftShoulder",
	"leftUpperArm",
	"leftLowerArm",
	"leftHand",
	"rightShoulder",
	"rightUpperArm",
	"rightLowerArm",
	"rightHand",
	"leftUpperLeg",
	"leftLowerLeg",
	"leftFoot",
	"leftToes",
	"rightUpperLeg",
	"rightLowerLeg",
	"rightFoot",
	"rightToes",
	"leftEye",
	"rightEye",
	"jaw",
	"leftThumbProximal",
	"leftThumbIntermediate",
	"leftThumbDistal",
	"leftIndexProximal",
	"leftIndexIntermediate",
	"leftIndexDistal",
	"leftMiddleProximal",
	"leftMiddleIntermediate",
	"leftMiddleDistal",
	"leftRingProximal",
	"leftRingIntermediate",
	"leftRingDistal",
	"leftLittleProximal",
	"leftLittleIntermediate",
	"leftLittleDistal",
	"rightThumbProximal",
	"rightThumbIntermediate",
	"rightThumbDistal",
	"rightIndexProximal",
	"rightIndexIntermediate",
	"rightIndexDistal",
	"rightMiddleProximal",
	"rightMiddleIntermediate",
	"rightMiddleDistal",
	"rightRingProximal",
	"rightRingIntermediate",
	"rightRingDistal",
	"rightLittleProximal",
	"rightLittleIntermediate",
	"rightLittleDistal",
]);
let blendTree: z.ZodType<any>;
const blendTreeChild: z.ZodType<any> = z.lazy(() =>
	z
		.object({
			animationGroup: z.string().min(1).optional(),
			blendTree: blendTree.optional(),
			threshold: z.number().optional(),
			position: z.array(z.number()).length(2).optional(),
			directParameter: z.string().min(1).optional().describe("Numeric Animator parameter mapped directly to this child's weight in Direct mode."),
			timeScale: z
				.number()
				.refine((value) => value !== 0, "timeScale must be non-zero.")
				.optional()
				.describe("Relative child playback speed; negative values play in reverse."),
			cycleOffset: z.number().min(0).max(1).optional().describe("Normalized child loop phase offset."),
			mirror: z.boolean().optional().describe("Mirror the child motion across the humanoid left/right axis."),
		})
		.strict()
		.refine((child) => !!child.animationGroup !== !!child.blendTree, "Each Blend Tree child requires exactly one animationGroup or nested blendTree.")
);
blendTree = z.lazy(() =>
	z
		.object({
			parameter: z.string().min(1).optional(),
			parameterX: z.string().min(1).optional(),
			parameterY: z.string().min(1).optional(),
			blendMode: z.enum(["cartesian", "directional", "freeformDirectional", "direct"]).optional(),
			normalizeWeights: z.boolean().optional().describe("Direct mode only: normalize non-negative child weights to sum to one."),
			children: z.array(blendTreeChild).min(2).max(64),
		})
		.strict()
		.refine(
			(value) =>
				(value.blendMode === "direct" &&
					!value.parameter &&
					!value.parameterX &&
					!value.parameterY &&
					value.children.every((child: any) => !!child.directParameter && child.threshold === undefined && child.position === undefined)) ||
				(value.blendMode !== "direct" &&
					value.normalizeWeights === undefined &&
					value.children.every((child: any) => child.directParameter === undefined) &&
					((!!value.parameter && !value.parameterX && !value.parameterY) || (!value.parameter && !!value.parameterX && !!value.parameterY))),
			"Use parameter for 1D, parameterX and parameterY for 2D, or blendMode direct with directParameter on every child."
		)
);
const unityBehaviourSource = z
	.object({
		bindingKey: z.string().startsWith("@unity-behaviour:").max(256),
		behaviourFileId: z.string().min(1).max(64),
		behaviourGuid: z
			.string()
			.regex(/^[a-f0-9]{32}$/)
			.nullable(),
		scriptFileId: z.string().min(1).max(64).nullable(),
		scriptGuid: z
			.string()
			.regex(/^[a-f0-9]{32}$/)
			.nullable(),
		scriptPath: z.string().max(1024).nullable(),
		scriptContentHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		scriptMetaHash: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.nullable(),
		behaviourName: z.string().max(512),
		editorClassIdentifier: z.string().max(1024),
		serializedFieldsJson: z.string().max(65_536).describe("Bounded JSON object retaining Unity-authored fields as import evidence."),
	})
	.strict();
const unityStateSource = z
	.object({
		fileId: z.string().min(1).max(64).describe("Exact Unity AnimatorState local fileID."),
		serializedVersion: z.number().int().nonnegative().nullable().describe("Authored AnimatorState serializedVersion, or null when absent."),
		footIKField: z.enum(["m_IKOnFeet", "m_FootIK"]).nullable().describe("Exact modern or legacy serialized Foot IK field spelling."),
		speedParameter: z.string().min(1).max(256).nullable(),
		mirrorParameter: z.string().min(1).max(256).nullable(),
		cycleOffsetParameter: z.string().min(1).max(256).nullable(),
		timeParameter: z.string().min(1).max(256).nullable(),
	})
	.strict();
const stateBehaviour = z
	.object({
		id: z.string().min(1).max(256).describe("Stable behaviour binding id, unique within this state."),
		scriptKey: z.string().min(1).max(1024).describe('Exact attachment key relative to the project "src" directory for a script attached to the Animator target node.'),
		enabled: z.boolean().optional().describe("False preserves the binding without invoking its state callbacks."),
		unitySource: unityBehaviourSource.optional().describe("Exact immutable Unity MonoBehaviour/MonoScript provenance retained by controller import."),
	})
	.strict();
const state = z
	.object({
		name: z.string().min(1),
		animationGroup: z.string().min(1).optional(),
		loop: z.boolean().optional(),
		speed: z
			.number()
			.refine((value) => value !== 0, "State speed must be non-zero; negative values play in reverse.")
			.optional(),
		cycleOffset: z.number().min(0).max(1).optional().describe("Static normalized phase offset applied to the complete state Motion."),
		mirror: z.boolean().optional().describe("Mirror the complete state Motion through the current Humanoid Avatar mapping."),
		speedParameter: z
			.string()
			.min(1)
			.max(256)
			.nullable()
			.optional()
			.describe("Float Animator parameter multiplied with authored speed; null explicitly disables an imported binding."),
		mirrorParameter: z
			.string()
			.min(1)
			.max(256)
			.nullable()
			.optional()
			.describe("Bool Animator parameter replacing authored mirror; null explicitly disables an imported binding."),
		cycleOffsetParameter: z
			.string()
			.min(1)
			.max(256)
			.nullable()
			.optional()
			.describe("Float Animator parameter replacing authored cycle offset; null explicitly disables an imported binding."),
		timeParameter: z
			.string()
			.min(1)
			.max(256)
			.nullable()
			.optional()
			.describe("Float Animator parameter directly driving normalized state time; null disables it and root motion is suppressed while active."),
		tag: z.string().max(256).optional().describe("Optional Animator state tag."),
		footIK: z.boolean().optional().describe("Apply bounded automatic Humanoid ground-contact Foot IK after animation sampling in preview and exported runtime."),
		writeDefaultValues: z.boolean().optional().describe("On state entry, restore captured controller defaults for animated properties not written by this state."),
		unitySource: unityStateSource.optional().describe("Exact Unity AnimatorState serialization and active parameter-binding provenance retained by import."),
		behaviours: z
			.array(stateBehaviour)
			.max(16)
			.optional()
			.describe("Ordered StateMachineBehaviour-style script bindings invoking optional onAnimatorStateEnter/Update/Exit callbacks."),
		maskTargetNames: z.array(z.string().min(1)).optional(),
		avatarMaskId: z.string().min(1).max(256).optional().describe("Reusable humanoid body-part Avatar Mask id. It is combined with legacy target names."),
		graphPosition: z.array(z.number()).length(2).optional().describe("Persisted Animator graph canvas position [x, y]."),
		blendTree: blendTree.optional(),
	})
	.strict()
	.refine((value) => !!value.animationGroup || !!value.blendTree, "State requires animationGroup or blendTree.");
const transitionCondition = z
	.object({
		parameter: z.string().min(1),
		equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
		notEquals: z.union([z.string(), z.number(), z.boolean()]).optional(),
		greaterThan: z.number().optional(),
		lessThan: z.number().optional(),
	})
	.strict()
	.refine(
		(value) => [value.equals, value.notEquals, value.greaterThan, value.lessThan].filter((candidate) => candidate !== undefined).length === 1,
		"Provide exactly one equals, notEquals, greaterThan, or lessThan operator."
	);
const transition = z
	.object({
		from: z.string().min(1).describe('Concrete source state name, or "$any" for a Unity-style Any State transition.'),
		to: z.string().min(1).describe('Concrete destination state name, or "$exit" to leave and stop this state machine.'),
		exitTime: z.number().min(0).max(1).optional().describe("Normalized source-clip progress required before this transition can fire."),
		duration: z.number().nonnegative().optional().describe("Cross-fade duration in seconds. Zero or omitted switches immediately."),
		durationMode: z.enum(["seconds", "normalized"]).optional().describe("Interpret duration as fixed seconds or as a fraction of the source-state duration."),
		offset: z.number().min(0).max(1).optional().describe("Normalized destination-clip start offset. Exit transitions cannot use an offset."),
		interruptionSource: z
			.enum(["none", "source", "destination", "sourceThenDestination", "destinationThenSource"])
			.optional()
			.describe("Unity-style state source(s) whose outgoing transitions may interrupt this active cross-fade."),
		orderedInterruption: z.boolean().optional().describe("When true, only eligible transitions earlier than this transition in the ordered transition list may interrupt it."),
		canTransitionToSelf: z.boolean().optional().describe("Allow this transition to restart its evaluated state when the destination is that same state."),
		conditions: z.array(transitionCondition).optional(),
	})
	.strict();
const entryTransition = z
	.object({
		to: z.string().min(1).max(256).describe("Ordered conditional Entry destination: a direct state or child sub-state-machine in the same machine."),
		conditions: z.array(transitionCondition).min(1).max(16).describe("All conditions must match; the first matching ordered Entry transition wins."),
	})
	.strict();
const subStateMachine = z
	.object({
		name: z.string().min(1).max(256).describe('Instance name. Names cannot contain "/" or start with "$".'),
		subgraphId: z.string().min(1).max(256).describe("Reusable Animator subgraph id."),
		graphPosition: z.array(z.number()).length(2).optional().describe("Persisted parent-machine canvas position [x, y]."),
	})
	.strict();
const subgraph = z
	.object({
		id: z.string().min(1).max(256),
		name: z.string().min(1).max(256),
		behaviours: z.array(stateBehaviour).max(16).optional().describe("Ordered callbacks invoked when evaluation enters or exits this reusable state-machine boundary."),
		states: z.array(state).min(1).max(64),
		transitions: z.array(transition).max(512).optional(),
		entryTransitions: z.array(entryTransition).max(64).optional(),
		subStateMachines: z.array(subStateMachine).max(16).optional(),
		entryState: z.string().min(1).max(256).optional().describe("Direct state or child sub-state-machine reached by this reusable graph's Entry node."),
	})
	.strict();
const value = z.union([z.string(), z.number(), z.boolean()]);
const parameterType = z.enum(["float", "int", "bool", "trigger", "string"]);
const rootMotion = z
	.object({
		enabled: z.boolean(),
		sourceNodeId: z.string().min(1).describe("Animated source node whose transform delta is extracted."),
		targetNodeId: z.string().min(1).describe("Separate node that receives extracted motion, normally a character parent."),
		applyPosition: z.boolean().optional(),
		applyRotationY: z.boolean().optional(),
	})
	.strict();
const layerBlendingMode = z.enum(["override", "additive"]);
const layerReferencePose = z.object({ normalizedTime: z.number().min(0).max(1) }).strict();
const synchronizedStateMap = z
	.record(z.string().min(1), z.string().min(1))
	.refine((mapping) => Object.keys(mapping).length <= 512, "Synchronized state maps cannot contain more than 512 entries.");
const synchronizedMotionOverride = z
	.object({ animationGroup: z.string().min(1).optional(), blendTree: blendTree.optional() })
	.strict()
	.refine((motion) => !!motion.animationGroup !== !!motion.blendTree, "Each synchronized motion override requires exactly one animationGroup or blendTree.");
const synchronizedMotionOverrides = z
	.record(z.string().min(1), synchronizedMotionOverride)
	.refine((mapping) => Object.keys(mapping).length <= 512, "Synchronized motion overrides cannot contain more than 512 entries.");
const synchronizedBehaviourOverrides = z
	.record(z.string().min(1), z.array(stateBehaviour).max(16))
	.refine((mapping) => Object.keys(mapping).length <= 512, "Synchronized behaviour overrides cannot contain more than 512 entries.");
const layer = z
	.object({
		name: z.string().min(1),
		behaviours: z.array(stateBehaviour).max(16).optional().describe("Ordered callbacks invoked when evaluation enters or exits this layer state-machine boundary."),
		weight: z.number().min(0).max(1).optional().describe("Layer influence from 0 to 1."),
		maskTargetNames: z.array(z.string().min(1)).optional().describe("Optional target-name include mask for every state in this layer unless a state mask overrides it."),
		avatarMaskId: z.string().min(1).max(256).optional().describe("Reusable humanoid body-part Avatar Mask used unless a state overrides it."),
		blendingMode: layerBlendingMode.optional().describe("Override replaces masked values; additive applies clip deltas relative to referencePose."),
		referencePose: layerReferencePose.optional().describe("Normalized clip time used as the zero-delta pose for additive blending."),
		synchronizedLayer: z
			.string()
			.min(1)
			.max(256)
			.optional()
			.describe('Source state machine: "$base" or an earlier layer name. Synchronized layers cannot own transitions or conditional Entry routes.'),
		synchronizedTiming: z.boolean().optional().describe("Unity Timing toggle: when true, this layer's clip duration affects shared source timing by layer weight."),
		synchronizedStateMap: synchronizedStateMap.optional().describe("Qualified source-state to qualified target-state mapping."),
		synchronizedMotionOverrides: synchronizedMotionOverrides.optional().describe("Qualified source-state to replacement Animation Group or Blend Tree mapping."),
		synchronizedBehaviourOverrides: synchronizedBehaviourOverrides
			.optional()
			.describe("Qualified source-state to replacement ordered behaviour bindings; an empty list clears callbacks."),
		ikPass: z
			.boolean()
			.optional()
			.describe("Unity-style IK Pass toggle. Active layers call onAnimatorIK on scripts attached to the controller target node after animation sampling."),
		states: z.array(state).min(1),
		transitions: z.array(transition).optional(),
		entryTransitions: z.array(entryTransition).max(64).optional(),
		subStateMachines: z.array(subStateMachine).max(16).optional(),
		entryState: z.string().min(1).optional().describe("Concrete state reached by this layer's Entry node."),
		activeState: z.string().min(1).optional(),
	})
	.strict();
const runtimeDebugBreakpoint = z
	.object({
		id: z.string().min(1).max(128).describe("Unique runtime-only breakpoint id."),
		layer: z.string().min(1).max(256).optional().describe('Machine scope: "$base" by default, or an exact Animator layer name.'),
		from: z.string().min(1).max(512).optional().describe("Optional exact compiled source-state name."),
		to: z.string().min(1).max(512).optional().describe('Optional exact compiled destination-state name, including "$exit".'),
		enabled: z.boolean().optional().describe("False retains the breakpoint without halting execution."),
	})
	.strict()
	.refine((breakpoint) => breakpoint.from !== undefined || breakpoint.to !== undefined, "A transition breakpoint requires from, to, or both.");

export function registerAnimatorTools(server: McpServer): void {
	server.registerTool(
		"get_animator_controller_asset_import",
		{
			title: "Inspect Unity Animator Controller import",
			description:
				"Inspect a current Unity YAML .controller/.animator artifact and build an exact scene import lease. Reports YAML/object serialized-version evidence and legacy/modern field variants; static signed state speed, normalized cycle offset, mirror, loop, tag, Foot IK, Write Defaults, and typed dynamic state-parameter bindings convert into executable settings. Motion, AvatarMask, and class-114 MonoBehaviour/MonoScript references resolve through paired project .meta GUIDs, exact fileIDs, current hashes, source provenance, and the selected target node's attached scripts. A single humanoid Avatar enables planned exact .mask import. Returns bounded dependency diagnostics, automatic/manual matches, target choices, converted controller data, and readiness without changing the scene.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative Unity .controller or .animator asset path."),
					targetNodeId: z.string().min(1).max(512).optional().describe("Scene node whose already attached project scripts will receive imported behaviour callbacks."),
					targetNodeName: z.string().min(1).max(512).optional().describe("Unique scene-node name alternative to targetNodeId."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animator_controller_asset_import", args)
	);
	server.registerTool(
		"import_animator_controller_asset",
		{
			title: "Import Unity Animator Controller into scene",
			description:
				"After confirm=true, import one valid current Unity YAML Animator Controller under the exact dependency-and-scene fingerprint returned by get_animator_controller_asset_import using the same target selector. Serialized-version/field-shape evidence and exact Unity state provenance are retained; executable static signed speed/cycle-offset/mirror settings use the shared preview/export runtime. Exact Motion, AvatarMask, and attached project-script matches bind automatically; explicit mappings remain available. All MonoBehaviours must map to scripts already attached to the selected node, unresolved masks require explicit ignore, stale state rejects, and staged masks roll back if controller creation fails.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative Unity .controller or .animator asset path."),
					targetNodeId: z.string().min(1).max(512).optional().describe("Same selected target node id used to create the exact inspection fingerprint."),
					targetNodeName: z.string().min(1).max(512).optional().describe("Same unique target name used to create the exact inspection fingerprint."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current controller/dependency/live-scene fingerprint from the inspection tool."),
					motionBindings: z
						.record(z.string().min(1), z.string().min(1))
						.optional()
						.describe("Optional Unity binding key to existing AnimationGroup override. Exact GUID/fileID automatic matches are used when omitted."),
					avatarMaskBindings: z.record(z.string().min(1), z.string().min(1)).optional().describe("Unity mask binding key to existing Babylon Avatar Mask id."),
					behaviourBindings: z
						.record(z.string().min(1), z.string().min(1))
						.optional()
						.describe("Unity behaviour binding key to an exact project-script key already attached to the selected target node."),
					ignoreUnresolvedAvatarMasks: z.boolean().optional().describe("Explicitly remove unresolved Unity mask references instead of rejecting the import."),
					controllerName: z.string().min(1).max(256).optional().describe("Optional scene controller name override."),
					replaceExisting: z.boolean().optional().describe("Required to replace a same-name controller; false by default."),
					playOnImport: z.boolean().optional().describe("Start the imported entry state immediately when creating a controller."),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("import_animator_controller_asset", args)
	);
	server.registerTool(
		"list_animator_controllers",
		{ title: "List animator controllers", description: "List persisted editor state-machine controllers.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_animator_controllers")
	);
	server.registerTool(
		"create_animator_controller",
		{
			title: "Create animator controller",
			description:
				"Create a persistent state machine over existing Animation Groups. States reference one clip or a recursive 1D/2D/Direct Blend Tree and may set signed speed, cycle offset, Humanoid mirror, loop, tag, bounded automatic Humanoid ground-contact Foot IK, controller-snapshot Write Defaults restoration, and typed dynamic Speed/Mirror/Cycle Offset/Motion Time parameter bindings; Motion Time suppresses root motion. Transitions use typed parameter conditions.",
			inputSchema: z
				.object({
					name: z.string().min(1),
					targetNodeId: z.string().optional(),
					humanoidAvatarId: z.string().min(1).max(256).optional().describe("Humanoid Avatar sampled by this controller's runtime muscle trace."),
					behaviours: z.array(stateBehaviour).max(16).optional().describe("Ordered callbacks for the Base Layer state-machine boundary."),
					baseIKPass: z.boolean().optional().describe("Call onAnimatorIK for the Base Layer after animation sampling."),
					parameters: z.record(z.string(), value).optional(),
					parameterTypes: z
						.record(z.string(), parameterType)
						.optional()
						.describe("Optional explicit float/int/bool/trigger types. Legacy string is retained for backward compatibility."),
					states: z.array(state).min(1),
					transitions: z.array(transition).optional(),
					entryTransitions: z.array(entryTransition).max(64).optional(),
					subgraphs: z.array(subgraph).max(32).optional().describe("Reusable bounded state-machine graphs shared by base and layer instances."),
					subStateMachines: z.array(subStateMachine).max(16).optional().describe("Reusable subgraph instances placed in the base state machine."),
					layers: z.array(layer).optional().describe("Independent weighted animation layers that run alongside the base state machine."),
					rootMotion: rootMotion.optional(),
					entryState: z.string().optional().describe("Concrete state reached by the base Entry node. Defaults to activeState or the first state."),
					activeState: z.string().optional(),
					playOnCreate: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_animator_controller", args)
	);
	server.registerTool(
		"get_animator_controller",
		{
			title: "Get animator controller",
			description: "Get base states, static and dynamic playback bindings, Unity source evidence, transitions, parameters, active state, and independent animation layers.",
			inputSchema: z.object(identity).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animator_controller", args)
	);
	server.registerTool(
		"get_animator_compiled_graph",
		{
			title: "Get compiled Animator graph",
			description:
				"Inspect the deterministic qualified leaf-state graph used by editor preview and exported runtime after reusable nested sub-state machines are expanded. Returns machine paths, reusable subgraph ids, Entry routing, compiled transitions, and per-machine leaf inventories.",
			inputSchema: z.object({ ...identity, layer: z.string().min(1).optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animator_compiled_graph", args)
	);
	server.registerTool(
		"get_animator_runtime_debug",
		{
			title: "Get Animator runtime debug snapshot",
			description:
				"Capture live base/layer active states, static speed/cycle-offset/mirror/loop/tag settings and retained Unity state evidence, Entry destinations, exited state, elapsed and normalized time, current cross-fade or fade-to-exit progress and weights, typed parameter values, Animation Group playback/weight/frame evidence, StateMachineBehaviour and IK Pass callback/error telemetry, root-motion health, warnings, and engine frame delta for one Animator controller.",
			inputSchema: z
				.object({
					...identity,
					includeAllClips: z.boolean().optional().describe("Include every state clip instead of only active and transitioning clips."),
					historyLimit: z.number().int().min(1).max(256).optional().describe("Newest bounded transition-history entries to return; defaults to 64."),
				})
				.strict()
				.refine((input) => !!input.controllerId || !!input.controllerName, "Provide controllerId or controllerName."),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animator_runtime_debug", args)
	);
	server.registerTool(
		"get_animator_humanoid_muscle_trace",
		{
			title: "Get Animator Humanoid muscle trace",
			description:
				"Read one controller's persisted Humanoid Avatar assignment, available scene Avatars, current normalized Unity-style muscle pose, and a newest-first page of up to 256 post-Animator/post-behaviour/post-IK/pre-limit samples. Each sample includes base/layer states, XYZ degrees and normalized values, per-axis normalized deltas, authored limits, violations, maxima, timing, overflow evidence, and an exact SHA-256 mutation fingerprint. Reads never advance or alter runtime state.",
			inputSchema: z
				.object({
					...identity,
					roles: z.array(humanBone).max(55).optional().describe("Optional unique Humanoid roles to include in current/latest/history muscle arrays."),
					offset: z.number().int().min(0).max(255).optional().describe("Newest-first history offset; defaults to 0."),
					limit: z.number().int().min(1).max(256).optional().describe("History samples to return; defaults to 16."),
				})
				.strict()
				.refine((input) => !!input.controllerId || !!input.controllerName, "Provide controllerId or controllerName.")
				.refine((input) => !input.roles || new Set(input.roles).size === input.roles.length, "roles must not contain duplicates."),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animator_humanoid_muscle_trace", args)
	);
	server.registerTool(
		"set_animator_humanoid_muscle_trace",
		{
			title: "Configure Animator Humanoid muscle trace",
			description:
				"Under the exact fingerprint returned by get_animator_humanoid_muscle_trace, assign or clear one persisted Humanoid Avatar and/or clear that controller's bounded runtime-only muscle history. Assignment requires a current Humanoid Avatar whose skeleton is loaded; changing it resets prior samples. Pause the Animator first when an exact stable lease is needed while live sampling is active.",
			inputSchema: z
				.object({
					...identity,
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current fingerprint from get_animator_humanoid_muscle_trace."),
					humanoidAvatarId: z.string().min(1).max(256).nullable().optional().describe("Avatar id to assign, or null to clear the assignment."),
					clearHistory: z.boolean().optional().describe("True clears samples, dropped count, error, and sequence state."),
					limit: z.number().int().min(1).max(256).optional().describe("History page size in the returned fresh snapshot."),
				})
				.strict()
				.refine((input) => !!input.controllerId || !!input.controllerName, "Provide controllerId or controllerName.")
				.refine((input) => input.humanoidAvatarId !== undefined || input.clearHistory === true, "Provide humanoidAvatarId (string or null) and/or clearHistory=true."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_humanoid_muscle_trace", args)
	);
	server.registerTool(
		"set_animator_runtime_debug",
		{
			title: "Configure Animator runtime debugging",
			description:
				"Under the exact debugger fingerprint from get_animator_runtime_debug, atomically pause or resume one controller, replace up to 64 base/layer transition breakpoints, and optionally clear its bounded 256-entry transition history. Breakpoints match exact evaluated source/destination states, pause after the matching transition is applied, and remain runtime-only without changing the persisted controller graph.",
			inputSchema: z
				.object({
					...identity,
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact debugger fingerprint from get_animator_runtime_debug."),
					paused: z.boolean().optional().describe("Pause or resume only this Animator controller and its active clips."),
					breakpoints: z.array(runtimeDebugBreakpoint).max(64).optional().describe("Complete replacement transition-breakpoint list."),
					clearHistory: z.boolean().optional().describe("True clears retained and dropped transition-history counts."),
				})
				.strict()
				.refine((input) => !!input.controllerId || !!input.controllerName, "Provide controllerId or controllerName.")
				.refine(
					(input) => input.paused !== undefined || input.breakpoints !== undefined || input.clearHistory === true,
					"Provide paused, breakpoints, or clearHistory=true."
				),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_runtime_debug", args)
	);
	server.registerTool(
		"step_animator_runtime_debug",
		{
			title: "Step paused Animator runtime",
			description:
				"Under the exact debugger fingerprint, deterministically advance only one paused Animator controller by 1–120 fixed steps totaling at most five seconds. It updates clips, transitions, triggers, behaviours, IK, layers, fades, and root motion through the same preview backend, stops early on a breakpoint, remains paused, and returns fresh runtime/history evidence.",
			inputSchema: z
				.object({
					...identity,
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact debugger fingerprint from get_animator_runtime_debug."),
					deltaSeconds: z.number().min(0.0001).max(1).optional().describe("Fixed time per step; defaults to 1/60 second."),
					steps: z.number().int().min(1).max(120).optional().describe("Number of fixed steps; defaults to 1 and total time cannot exceed five seconds."),
				})
				.strict()
				.refine((input) => !!input.controllerId || !!input.controllerName, "Provide controllerId or controllerName.")
				.refine((input) => (input.deltaSeconds ?? 1 / 60) * (input.steps ?? 1) <= 5, "Animator debugger stepping cannot exceed five seconds."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("step_animator_runtime_debug", args)
	);
	server.registerTool(
		"open_animator_runtime_debugger",
		{
			title: "Open Animator runtime debugger",
			description: "Open the editor's Animations tab, select one persisted Animator controller, and enable its 4 Hz live runtime debugger panel.",
			inputSchema: z
				.object(identity)
				.strict()
				.refine((input) => !!input.controllerId || !!input.controllerName, "Provide controllerId or controllerName."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_animator_runtime_debugger", args)
	);
	server.registerTool(
		"set_animator_controller",
		{
			title: "Set animator controller",
			description:
				"Update states (including static signed speed, cycle offset, mirror, loop, and tag), transitions, parameters, target node, or active state after validating referenced clips.",
			inputSchema: z
				.object({
					...identity,
					name: z.string().min(1).optional(),
					targetNodeId: z.string().optional(),
					humanoidAvatarId: z.string().min(1).max(256).nullable().optional().describe("Humanoid Avatar to trace, or null to clear the assignment."),
					behaviours: z.array(stateBehaviour).max(16).optional().describe("Complete Base Layer state-machine behaviour list."),
					baseIKPass: z.boolean().optional().describe("Call onAnimatorIK for the Base Layer after animation sampling."),
					parameters: z.record(z.string(), value).optional(),
					parameterTypes: z.record(z.string(), parameterType).optional(),
					states: z.array(state).min(1).optional(),
					transitions: z.array(transition).optional(),
					entryTransitions: z.array(entryTransition).max(64).optional(),
					subgraphs: z.array(subgraph).max(32).optional(),
					subStateMachines: z.array(subStateMachine).max(16).optional(),
					layers: z.array(layer).optional(),
					rootMotion: rootMotion.optional(),
					entryState: z.string().min(1).optional().describe("Concrete state reached by the base Entry node."),
					activeState: z.string().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_controller", args)
	);
	server.registerTool(
		"set_animator_subgraph",
		{
			title: "Set reusable Animator subgraph",
			description:
				"Create or atomically update one reusable bounded Animator subgraph. A subgraph contains direct clip/blend-tree states, transitions, Entry routing, and optional child sub-state-machine instances; multiple base/layer instances may reuse it.",
			inputSchema: z
				.object({
					...identity,
					subgraphId: z.string().min(1).max(256).optional().describe("Existing subgraph id to update; omit to create a generated id."),
					name: z.string().min(1).max(256).optional(),
					behaviours: z.array(stateBehaviour).max(16).optional().describe("Complete reusable state-machine behaviour list."),
					states: z.array(state).min(1).max(64).optional(),
					transitions: z.array(transition).max(512).optional(),
					entryTransitions: z.array(entryTransition).max(64).optional(),
					subStateMachines: z.array(subStateMachine).max(16).optional(),
					entryState: z.string().min(1).max(256).optional(),
				})
				.strict()
				.refine((input) => !!input.subgraphId || (!!input.name && !!input.states), "Creating a subgraph requires name and states."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_subgraph", args)
	);
	server.registerTool(
		"delete_animator_subgraph",
		{
			title: "Delete reusable Animator subgraph",
			description:
				"Delete one reusable Animator subgraph. By default deletion is rejected while any base, layer, or subgraph instance references it; cascade true removes those instances and their connected transitions atomically.",
			inputSchema: z.object({ ...identity, subgraphId: z.string().min(1).max(256), cascade: z.boolean().optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_animator_subgraph", args)
	);
	server.registerTool(
		"set_animator_sub_state_machine",
		{
			title: "Set Animator sub-state-machine instance",
			description:
				"Create, update, reposition, retarget, or remove one reusable subgraph instance in the base machine, one layer, or a parent reusable subgraph. Names are direct transition/Entry endpoints in that owner.",
			inputSchema: z
				.object({
					...identity,
					layer: z.string().min(1).optional().describe("Layer owner; omit for base unless parentSubgraphId is supplied."),
					parentSubgraphId: z.string().min(1).max(256).optional().describe("Reusable subgraph owner; mutually exclusive with layer."),
					existingName: z.string().min(1).max(256).optional().describe("Existing instance name when renaming or removing."),
					name: z.string().min(1).max(256).optional().describe("New/current instance name."),
					subgraphId: z.string().min(1).max(256).optional().describe("Reusable subgraph to instantiate."),
					graphPosition: z.array(z.number()).length(2).optional(),
					remove: z.boolean().optional(),
				})
				.strict()
				.refine((input) => !(input.layer && input.parentSubgraphId), "Choose layer or parentSubgraphId, not both.")
				.refine(
					(input) => (input.remove ? !!input.existingName || !!input.name : !!input.name && !!input.subgraphId),
					"Upsert requires name and subgraphId; removal requires a name."
				),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_sub_state_machine", args)
	);
	server.registerTool(
		"set_animator_root_motion",
		{
			title: "Set animator root motion",
			description:
				"Extract an animated source node's position and optional Y rotation delta onto a separate target node in preview and exported runtime. Set enabled false to remove the configuration.",
			inputSchema: z.object({
				...identity,
				enabled: z.boolean(),
				sourceNodeId: z.string().min(1).optional(),
				targetNodeId: z.string().min(1).optional(),
				applyPosition: z.boolean().optional(),
				applyRotationY: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_root_motion", args)
	);
	server.registerTool(
		"set_animator_layer",
		{
			title: "Set animator layer",
			description:
				"Update one existing weighted animator layer's name, influence, override/additive blending, reference pose, synchronization source/timing/state map, target mask, state machine, or active state.",
			inputSchema: z
				.object({
					...identity,
					layer: z.string().min(1).describe("Existing layer name."),
					name: z.string().min(1).optional(),
					behaviours: z.array(stateBehaviour).max(16).optional().describe("Complete layer state-machine behaviour list."),
					weight: z.number().min(0).max(1).optional(),
					maskTargetNames: z.array(z.string().min(1)).optional(),
					avatarMaskId: z.string().min(1).max(256).nullable().optional().describe("Reusable Avatar Mask id, or null to clear it."),
					blendingMode: layerBlendingMode.optional(),
					referencePose: layerReferencePose.optional(),
					synchronizedLayer: z.string().min(1).max(256).nullable().optional().describe('Use "$base" or an earlier layer name; null restores an independent layer.'),
					synchronizedTiming: z.boolean().optional().describe("Unity Timing toggle: blend this layer's clip duration into the source duration by layer weight."),
					synchronizedStateMap: synchronizedStateMap.optional(),
					synchronizedMotionOverrides: synchronizedMotionOverrides.optional(),
					synchronizedBehaviourOverrides: synchronizedBehaviourOverrides.optional(),
					ikPass: z.boolean().optional().describe("Call target-node onAnimatorIK scripts once per update while this layer has an active state."),
					states: z.array(state).min(1).optional(),
					transitions: z.array(transition).optional(),
					entryTransitions: z.array(entryTransition).max(64).optional(),
					subStateMachines: z.array(subStateMachine).max(16).optional(),
					entryState: z.string().min(1).optional().describe("Concrete state reached by this layer's Entry node."),
					activeState: z.string().min(1).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_layer", args)
	);
	server.registerTool(
		"set_animator_layer_blending",
		{
			title: "Set Animator layer blending",
			description:
				"Focused Unity-style workflow for configuring override/additive blending, additive reference-pose time, or a synchronized source layer with weighted Timing influence and qualified-state mapping.",
			inputSchema: z
				.object({
					...identity,
					layer: z.string().min(1).describe("Existing target layer name."),
					blendingMode: layerBlendingMode.optional(),
					referencePoseNormalizedTime: z.number().min(0).max(1).optional(),
					synchronizedLayer: z.string().min(1).max(256).nullable().optional().describe('Use "$base" or an earlier layer name; null restores independent playback.'),
					synchronizedTiming: z.boolean().optional().describe("Unity Timing toggle: blend this layer's clip duration into the source duration by layer weight."),
					synchronizedStateMap: synchronizedStateMap.optional(),
				})
				.strict()
				.refine(
					(input) =>
						input.blendingMode !== undefined ||
						input.referencePoseNormalizedTime !== undefined ||
						input.synchronizedLayer !== undefined ||
						input.synchronizedTiming !== undefined ||
						input.synchronizedStateMap !== undefined,
					"Provide at least one blending or synchronization setting."
				),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_layer_blending", args)
	);
	server.registerTool(
		"set_animator_synchronized_layer_overrides",
		{
			title: "Set Animator synchronized-layer overrides",
			description:
				"Atomically replace the complete per-source-state Motion and StateMachineBehaviour override maps on one existing synchronized Animator layer. Source keys are qualified states from the source layer. Motion entries choose one Animation Group or Blend Tree; behaviour entries are ordered script bindings and an empty list explicitly clears mapped-state callbacks.",
			inputSchema: z
				.object({
					...identity,
					layer: z.string().min(1).max(256).describe("Existing synchronized target layer name."),
					motionOverrides: synchronizedMotionOverrides.describe("Complete replacement motion map; use {} to clear all motion overrides."),
					behaviourOverrides: synchronizedBehaviourOverrides.describe("Complete replacement behaviour map; use {} to clear all behaviour overrides."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_synchronized_layer_overrides", args)
	);
	server.registerTool(
		"set_animator_layer_ik_pass",
		{
			title: "Set Animator layer IK Pass",
			description:
				"Enable or disable Unity-style per-layer IK Pass execution. When enabled and the layer has an active state, editor preview and exported runtime call onAnimatorIK once per Animator update on every script attached to the controller target node. Returns the updated controller including the persisted layer setting.",
			inputSchema: z
				.object({
					...identity,
					layer: z.string().min(1).max(256).describe('Use "$base" for the Base Layer or an existing additional Animator layer name.'),
					enabled: z.boolean().describe("Whether this layer executes onAnimatorIK after animation sampling."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_layer_ik_pass", args)
	);
	server.registerTool(
		"set_animator_transition",
		{
			title: "Set Animator transition",
			description:
				"Atomically update one ordered base or layer Animator transition, including normalized destination offset, interruption source and priority ordering, self-transition permission, timing, endpoints, and conditions.",
			inputSchema: z
				.object({
					...identity,
					layer: z.string().min(1).optional().describe("Layer name; omit to update the base state machine."),
					index: z.number().int().min(0).describe("Zero-based transition index. Transition list order defines interruption priority."),
					from: z.string().min(1).optional().describe('Concrete source state or "$any".'),
					to: z.string().min(1).optional().describe('Concrete destination state or "$exit".'),
					conditions: z.array(transitionCondition).optional().describe("Complete replacement condition list; send [] to clear conditions."),
					exitTime: z.number().min(0).max(1).nullable().optional().describe("Normalized source exit time, or null to clear it."),
					duration: z.number().nonnegative().nullable().optional().describe("Cross-fade seconds, or null to clear it."),
					offset: z.number().min(0).max(1).nullable().optional().describe("Normalized destination start offset, or null to clear it."),
					interruptionSource: z.enum(["none", "source", "destination", "sourceThenDestination", "destinationThenSource"]).optional(),
					orderedInterruption: z.boolean().optional(),
					canTransitionToSelf: z.boolean().optional(),
				})
				.strict()
				.refine(
					(input) =>
						input.from !== undefined ||
						input.to !== undefined ||
						input.conditions !== undefined ||
						input.exitTime !== undefined ||
						input.duration !== undefined ||
						input.offset !== undefined ||
						input.interruptionSource !== undefined ||
						input.orderedInterruption !== undefined ||
						input.canTransitionToSelf !== undefined,
					"Provide at least one transition field to update."
				),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_transition", args)
	);
	server.registerTool(
		"set_animator_entry_transitions",
		{
			title: "Set Animator Entry transitions",
			description:
				"Atomically replace the complete ordered conditional Entry transition list on the base machine, one independent layer, or one reusable subgraph. The first transition whose complete condition list matches selects its direct-state or child-machine destination; otherwise the authored default Entry state is used.",
			inputSchema: z
				.object({
					...identity,
					layer: z.string().min(1).max(256).optional().describe("Independent layer owner; omit for the base machine."),
					subgraphId: z.string().min(1).max(256).optional().describe("Reusable subgraph owner; mutually exclusive with layer."),
					entryTransitions: z.array(entryTransition).max(64).describe("Complete ordered replacement list; send [] to restore default-only Entry routing."),
				})
				.strict()
				.refine((input) => !(input.layer && input.subgraphId), "Choose layer or subgraphId, not both."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_entry_transitions", args)
	);
	server.registerTool(
		"set_animator_entry_state",
		{
			title: "Set Animator Entry state",
			description:
				"Set the default state reached by the Unity-style Entry node for the base Animator state machine or one named independent layer. Optionally restart the machine through ordered conditional Entry routing, falling back to this default state when no condition matches.",
			inputSchema: z
				.object({
					...identity,
					state: z.string().min(1).describe("Existing direct state or child-state-machine name used as the default Entry destination."),
					layer: z.string().min(1).optional().describe("Independent layer name; omit for the base state machine."),
					play: z.boolean().optional().describe("When true, immediately evaluate ordered Entry conditions and restart at the resolved leaf state."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_entry_state", args)
	);
	server.registerTool(
		"set_animator_state_avatar_mask",
		{
			title: "Set Animator state Avatar Mask",
			description:
				"Assign or clear a reusable humanoid body-part Avatar Mask on an existing base Animator state. The mask resolves canonical Avatar roles to the state clip's skeleton target names in preview and exported runtime.",
			inputSchema: z.object({ ...identity, state: z.string().min(1), avatarMaskId: z.string().min(1).max(256).nullable() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_state_avatar_mask", args)
	);
	server.registerTool(
		"set_animator_state_behaviours",
		{
			title: "Set Animator state behaviours",
			description:
				"Replace the ordered StateMachineBehaviour-style bindings on one direct base, layer, or reusable-subgraph state. Each scriptKey must already be attached to the controller targetNodeId. Editor preview and exported runtime invoke optional onAnimatorStateEnter, onAnimatorStateUpdate, and onAnimatorStateExit methods; script errors are captured without stopping Animator evaluation. Send an empty behaviours list to clear the state.",
			inputSchema: z
				.object({
					...identity,
					state: z.string().min(1).max(256).describe("Direct state name in the selected owner."),
					layer: z.string().min(1).max(256).optional().describe("Layer owner; mutually exclusive with subgraphId."),
					subgraphId: z.string().min(1).max(256).optional().describe("Reusable-subgraph owner; mutually exclusive with layer."),
					behaviours: z.array(stateBehaviour).max(16).describe("Complete ordered replacement list; use [] to clear all bindings."),
				})
				.strict()
				.refine((input) => !(input.layer && input.subgraphId), "Choose layer or subgraphId, not both."),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_state_behaviours", args)
	);
	server.registerTool(
		"set_animator_layer_state",
		{
			title: "Set animator layer state",
			description: "Play a state in one animator layer while preserving the base state and all other layers.",
			inputSchema: z.object({ ...identity, layer: z.string().min(1), state: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_layer_state", args)
	);
	server.registerTool(
		"set_animator_blend_tree",
		{
			title: "Set animator blend tree",
			description:
				"Update a named recursive 1D, two-parameter 2D, or Direct Blend Tree state without replacing the entire controller. Every child contains one Animation Group or another Blend Tree and may independently set non-zero timeScale (negative reverses playback), normalized cycleOffset, and humanoid mirror. Duplicate Animation Groups remain independent motions. Direct mode maps each child's directParameter to its weight and can normalize the resulting weights. Validation bounds recursion to six nested levels and 256 total children.",
			inputSchema: z
				.object({
					...identity,
					state: z.string().min(1).describe("Name of an existing blend-tree state."),
					parameter: z.string().min(1).optional().describe("1D numeric controller parameter; a new parameter initializes at 0."),
					parameterX: z.string().min(1).optional().describe("2D horizontal numeric controller parameter; initializes at 0 when new."),
					parameterY: z.string().min(1).optional().describe("2D vertical numeric controller parameter; initializes at 0 when new."),
					blendMode: z
						.enum(["cartesian", "directional", "freeformDirectional", "direct"])
						.optional()
						.describe("2D Cartesian/directional/freeform-directional weighting, or per-child Direct parameter weighting."),
					normalizeWeights: z.boolean().optional().describe("Direct mode only: normalize non-negative direct child weights to sum to one."),
					children: z
						.array(blendTreeChild)
						.min(2)
						.max(64)
						.optional()
						.describe("Complete child list; each independent Motion is an Animation Group or recursive Blend Tree with optional playback modifiers."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_blend_tree", args)
	);
	server.registerTool(
		"set_animator_state_mask",
		{
			title: "Set animator state mask",
			description: "Set the target-name include mask for an existing state. Target names must be animated by that state's clips; send an empty list to clear the mask.",
			inputSchema: z.object({ ...identity, state: z.string().min(1), targetNames: z.array(z.string().min(1)) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_state_mask", args)
	);
	server.registerTool(
		"set_animator_state_graph_position",
		{
			title: "Set animator state graph position",
			description: "Persist the canvas position of one base Animator state in the editor state-machine graph.",
			inputSchema: z.object({ ...identity, state: z.string().min(1), position: z.array(z.number()).length(2) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_state_graph_position", args)
	);
	server.registerTool(
		"set_animator_state",
		{
			title: "Set animator state",
			description: "Play a controller state and stop the controller's other state clips.",
			inputSchema: z.object({ ...identity, state: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_state", args)
	);
	server.registerTool(
		"set_animator_parameter",
		{
			title: "Set animator parameter",
			description:
				"Set an existing typed controller parameter and apply ordered matching base/layer transitions. A trigger set to true resets automatically only when a matching transition consumes it.",
			inputSchema: z.object({ ...identity, parameter: z.string().min(1), value }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_parameter", args)
	);
	server.registerTool(
		"set_animator_parameter_definition",
		{
			title: "Set Animator parameter definition",
			description:
				"Add or change one Animator parameter's declared float, int, bool, trigger, or backward-compatible string type and validated default/current value. Incompatible existing values reset to the type default unless defaultValue is supplied.",
			inputSchema: z
				.object({
					...identity,
					parameter: z.string().min(1).max(256),
					type: parameterType,
					defaultValue: value.optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_parameter_definition", args)
	);
	server.registerTool(
		"set_animator_trigger",
		{
			title: "Set Animator trigger",
			description:
				"Arm one declared trigger parameter and immediately evaluate ordered base/layer transitions. The trigger resets only if a fired transition has a condition that consumes it; otherwise it remains armed.",
			inputSchema: z.object({ ...identity, parameter: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_animator_trigger", args)
	);
	server.registerTool(
		"reset_animator_trigger",
		{
			title: "Reset Animator trigger",
			description: "Clear one declared trigger parameter without evaluating transitions.",
			inputSchema: z.object({ ...identity, parameter: z.string().min(1).max(256) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_animator_trigger", args)
	);
	server.registerTool(
		"delete_animator_controller",
		{ title: "Delete animator controller", description: "Delete a controller without deleting its Animation Groups.", inputSchema: z.object(identity) },
		async (args): Promise<CallToolResult> => callTextTool("delete_animator_controller", args)
	);
}
