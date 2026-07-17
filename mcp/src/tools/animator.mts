import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identity = { controllerId: z.string().optional(), controllerName: z.string().optional() };
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
const stateBehaviour = z
	.object({
		id: z.string().min(1).max(256).describe("Stable behaviour binding id, unique within this state."),
		scriptKey: z.string().min(1).max(1024).describe('Exact attachment key relative to the project "src" directory for a script attached to the Animator target node.'),
		enabled: z.boolean().optional().describe("False preserves the binding without invoking its state callbacks."),
	})
	.strict();
const state = z
	.object({
		name: z.string().min(1),
		animationGroup: z.string().min(1).optional(),
		loop: z.boolean().optional(),
		speed: z.number().positive().optional(),
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

export function registerAnimatorTools(server: McpServer): void {
	server.registerTool(
		"get_animator_controller_asset_import",
		{
			title: "Inspect Unity Animator Controller import",
			description:
				"Inspect a current Animation Importer artifact created from Unity multi-document YAML .controller/.animator data. Returns converted layers, parameters, states, nested state machines, Blend Trees, transitions, unsupported-feature diagnostics, exact source/settings fingerprint, required external Motion and AvatarMask bindings, deterministic matches against current Animation Groups/Avatar Masks, and readiness without changing the scene. Apply the Animation Importer first when ready=false.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative Unity .controller or .animator asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animator_controller_asset_import", args)
	);
	server.registerTool(
		"import_animator_controller_asset",
		{
			title: "Import Unity Animator Controller into scene",
			description:
				"After confirm=true, import one valid current Unity YAML Animator Controller artifact into scene metadata under the exact fingerprint returned by get_animator_controller_asset_import. Every external Unity Motion must map to an existing Babylon Animation Group; AvatarMask references must map to existing mask ids unless explicitly ignored. Creates a controller or atomically replaces a same-name controller only when replaceExisting=true. Returns the persisted controller, applied bindings, ignored masks, and explicit unsupported-feature evidence.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative Unity .controller or .animator asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact current source/settings fingerprint from the inspection tool."),
					motionBindings: z
						.record(z.string().min(1), z.string().min(1))
						.optional()
						.describe("Unity binding key to existing Animation Group name. Suggested exact-name matches are used when omitted."),
					avatarMaskBindings: z.record(z.string().min(1), z.string().min(1)).optional().describe("Unity mask binding key to existing Babylon Avatar Mask id."),
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
				"Create a persistent state machine over existing Animation Groups. States reference one clip, a 1D blend tree, or a two-parameter 2D blend tree with weighted child clips; transitions use parameter conditions.",
			inputSchema: z
				.object({
					name: z.string().min(1),
					targetNodeId: z.string().optional(),
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
			description: "Get base states, transitions, parameters, active state, and independent animation layers.",
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
				"Capture live base/layer active states, Entry destinations, exited state, elapsed and normalized time, current cross-fade or fade-to-exit progress and weights, typed parameter values, Animation Group playback/weight/frame evidence, StateMachineBehaviour and IK Pass callback/error telemetry, root-motion health, warnings, and engine frame delta for one Animator controller.",
			inputSchema: z
				.object({
					...identity,
					includeAllClips: z.boolean().optional().describe("Include every state clip instead of only active and transitioning clips."),
				})
				.strict()
				.refine((input) => !!input.controllerId || !!input.controllerName, "Provide controllerId or controllerName."),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animator_runtime_debug", args)
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
			description: "Update states, transitions, parameters, target node, or active state after validating referenced clips.",
			inputSchema: z
				.object({
					...identity,
					name: z.string().min(1).optional(),
					targetNodeId: z.string().optional(),
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
