import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const exactRevision = z.number().int().min(1);
const mapIdentity = { mapId: z.string().min(1).max(128).optional(), mapName: z.string().min(1).max(128).optional() };
const actionIdentity = { actionId: z.string().min(1).max(128).optional(), actionName: z.string().min(1).max(128).optional() };
const schemeIdentity = { schemeId: z.string().min(1).max(128).optional(), schemeName: z.string().min(1).max(128).optional() };
const device = z.enum(["keyboard", "mouse", "gamepad", "touch"]);
const processor = z
	.object({
		type: z.enum(["invert", "scale", "clamp", "normalize", "axisDeadzone", "stickDeadzone"]),
		factor: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		x: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		y: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		z: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		min: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		max: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
		zero: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
	})
	.strict();
const interaction = z
	.object({
		type: z.enum(["press", "hold", "tap", "slowTap", "multiTap"]),
		pressPoint: z.number().finite().positive().max(1).optional(),
		behavior: z.enum(["pressOnly", "releaseOnly", "pressAndRelease"]).optional(),
		duration: z.number().finite().positive().max(60).optional(),
		tapCount: z.number().int().min(2).max(10).optional(),
		tapDelay: z.number().finite().positive().max(60).optional(),
	})
	.strict();
const compositePart = z.object({ name: z.string().min(1).max(128), path: z.string().min(1).max(512) }).strict();
const composite = z
	.object({ type: z.enum(["axis1d", "vector2", "vector3", "oneModifier", "twoModifiers"]), normalize: z.boolean().optional(), parts: z.array(compositePart).min(1).max(8) })
	.strict();
const binding = z
	.object({
		id: z.string().min(1).max(128).optional(),
		name: z.string().max(128).optional(),
		path: z.string().min(1).max(512).optional(),
		groups: z.array(z.string().min(1).max(128)).max(16).optional(),
		processors: z.array(processor).max(8).optional(),
		interactions: z.array(interaction).max(8).optional(),
		composite: composite.optional(),
	})
	.strict();
const action = z
	.object({
		id: z.string().min(1).max(128).optional(),
		name: z.string().min(1).max(128),
		type: z.enum(["button", "value", "passThrough"]).optional(),
		expectedControlType: z.enum(["button", "axis", "vector2", "vector3"]).optional(),
		enabled: z.boolean().optional(),
		initialStateCheck: z.boolean().optional(),
		processors: z.array(processor).max(8).optional(),
		interactions: z.array(interaction).max(8).optional(),
		bindings: z.array(binding).max(32).optional(),
	})
	.strict();
const actionChanges = action.partial().omit({ id: true }).strict();
const controlScheme = z.object({ id: z.string().min(1).max(128).optional(), name: z.string().min(1).max(128), devices: z.array(device).min(1).max(4) }).strict();
const controlSchemeChanges = z.object({ name: z.string().min(1).max(128).optional(), devices: z.array(device).min(1).max(4).optional() }).strict();
const settingsChanges = z
	.object({
		updateMode: z.enum(["dynamic", "fixed", "manual"]).optional(),
		defaultDeadzoneMin: z.number().finite().min(0).max(1).optional(),
		defaultDeadzoneMax: z.number().finite().min(0).max(1).optional(),
		defaultButtonPressPoint: z.number().finite().positive().max(1).optional(),
		defaultTapTime: z.number().finite().positive().max(60).optional(),
		defaultSlowTapTime: z.number().finite().positive().max(60).optional(),
		defaultHoldTime: z.number().finite().positive().max(60).optional(),
		defaultMultiTapDelay: z.number().finite().positive().max(60).optional(),
		autoSwitchControlScheme: z.boolean().optional(),
		maxTraceEvents: z.number().int().min(16).max(4096).optional(),
	})
	.strict();
const simulatedValue = z.union([z.number().finite(), z.array(z.number().finite()).min(2).max(3)]);

function readOnly(title: string, description: string, inputSchema: z.ZodTypeAny = z.object({}).strict()) {
	return { title, description, inputSchema, annotations: { readOnlyHint: true } };
}

export function registerInputTools(server: McpServer): void {
	server.registerTool(
		"list_input_action_maps",
		readOnly("List Input Action Maps", "List the complete normalized version-2 maps, revisions, actions, bindings, composites, processors, interactions, and control schemes."),
		async () => callTextTool("list_input_action_maps")
	);
	server.registerTool(
		"create_input_action_map",
		{
			title: "Create Input Action Map",
			description: "Create one stable-id version-2 Input Action Map for keyboard, mouse, gamepad, and touch authoring.",
			inputSchema: z
				.object({
					name: z.string().min(1).max(128),
					enabled: z.boolean().optional(),
					actions: z.array(action).max(128).optional(),
					controlSchemes: z.array(controlScheme).max(16).optional(),
				})
				.strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_input_action_map", args)
	);
	server.registerTool(
		"set_input_action_map",
		{
			title: "Set Input Action Map",
			description: "Exact-revision update map name/enabled state or atomically replace its complete action/scheme collections.",
			inputSchema: z
				.object({
					...mapIdentity,
					expectedRevision: exactRevision,
					name: z.string().min(1).max(128).optional(),
					enabled: z.boolean().optional(),
					actions: z.array(action).max(128).optional(),
					controlSchemes: z.array(controlScheme).max(16).optional(),
				})
				.strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_action_map", args)
	);
	server.registerTool(
		"delete_input_action_map",
		{
			title: "Delete Input Action Map",
			description: "Delete one exact-revision Input Action Map and all owned authoring.",
			inputSchema: z.object({ ...mapIdentity, expectedRevision: exactRevision, confirm: z.literal(true) }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_input_action_map", args)
	);
	server.registerTool(
		"create_input_action",
		{
			title: "Create Input Action",
			description: "Create one Button, Value, or Pass-Through action with scalar/vector type, processors, interactions, and bindings.",
			inputSchema: z.object({ ...mapIdentity, expectedRevision: exactRevision, action }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_input_action", args)
	);
	server.registerTool(
		"set_input_action",
		{
			title: "Set Input Action",
			description: "Exact-map-revision update one action while preserving its stable id.",
			inputSchema: z.object({ ...mapIdentity, ...actionIdentity, expectedRevision: exactRevision, changes: actionChanges }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_action", args)
	);
	server.registerTool(
		"delete_input_action",
		{
			title: "Delete Input Action",
			description: "Delete one action and all owned bindings using the exact current map revision.",
			inputSchema: z.object({ ...mapIdentity, ...actionIdentity, expectedRevision: exactRevision, confirm: z.literal(true) }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_input_action", args)
	);
	server.registerTool(
		"create_input_action_binding",
		{
			title: "Create Input Binding",
			description: "Add one path binding or Axis/Vector/Modifier composite to an action.",
			inputSchema: z.object({ ...mapIdentity, ...actionIdentity, expectedRevision: exactRevision, binding }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_input_action_binding", args)
	);
	server.registerTool(
		"set_input_action_binding",
		{
			title: "Set Input Binding",
			description: "Exact-map-revision update one stable binding path, groups, processors, interactions, or composite.",
			inputSchema: z
				.object({
					...mapIdentity,
					...actionIdentity,
					bindingId: z.string().min(1).max(128).optional(),
					bindingIndex: z.number().int().nonnegative().max(31).optional(),
					expectedRevision: exactRevision,
					changes: binding.partial().omit({ id: true }).strict(),
				})
				.strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_action_binding", args)
	);
	server.registerTool(
		"delete_input_action_binding",
		{
			title: "Delete Input Binding",
			description: "Delete one stable binding from an action using the exact current map revision.",
			inputSchema: z.object({ ...mapIdentity, ...actionIdentity, bindingId: z.string().min(1).max(128), expectedRevision: exactRevision, confirm: z.literal(true) }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_input_action_binding", args)
	);
	server.registerTool(
		"create_input_control_scheme",
		{
			title: "Create Input Control Scheme",
			description: "Add a named keyboard/mouse/gamepad/touch device requirement group.",
			inputSchema: z.object({ ...mapIdentity, expectedRevision: exactRevision, scheme: controlScheme }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_input_control_scheme", args)
	);
	server.registerTool(
		"set_input_control_scheme",
		{
			title: "Set Input Control Scheme",
			description: "Exact-map-revision update one scheme name or device requirements.",
			inputSchema: z.object({ ...mapIdentity, ...schemeIdentity, expectedRevision: exactRevision, changes: controlSchemeChanges }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_control_scheme", args)
	);
	server.registerTool(
		"delete_input_control_scheme",
		{
			title: "Delete Input Control Scheme",
			description: "Delete one exact-revision control scheme without deleting bindings.",
			inputSchema: z.object({ ...mapIdentity, ...schemeIdentity, expectedRevision: exactRevision, confirm: z.literal(true) }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_input_control_scheme", args)
	);
	server.registerTool(
		"get_input_system_settings",
		readOnly("Get Input System Settings", "Read versioned update mode, deadzones, button threshold, interaction timings, auto-switch, and trace capacity."),
		async () => callTextTool("get_input_system_settings")
	);
	server.registerTool(
		"set_input_system_settings",
		{
			title: "Set Input System Settings",
			description: "Exact-revision update the shared editor/export Input System settings atomically.",
			inputSchema: z.object({ expectedRevision: exactRevision, changes: settingsChanges }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_system_settings", args)
	);
	server.registerTool(
		"get_input_runtime",
		readOnly(
			"Get Input Runtime",
			"Inspect connected devices, active schemes, every action phase/value/control, and a bounded phase trace.",
			z.object({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(4096).optional() }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_input_runtime", args)
	);
	server.registerTool(
		"read_input_action_runtime",
		readOnly(
			"Read Input Action Runtime",
			"Read one live action's scalar/vector value, phase, active control/device, frame flags, and trigger timing.",
			z.object({ ...mapIdentity, ...actionIdentity }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("read_input_action_runtime", args)
	);
	server.registerTool(
		"set_input_runtime_map_enabled",
		{
			title: "Enable Input Map Runtime",
			description: "Transiently enable or disable one active runtime map without changing authored state.",
			inputSchema: z.object({ ...mapIdentity, enabled: z.boolean() }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_runtime_map_enabled", args)
	);
	server.registerTool(
		"set_input_runtime_action_enabled",
		{
			title: "Enable Input Action Runtime",
			description: "Transiently enable or disable one active runtime action.",
			inputSchema: z.object({ ...mapIdentity, ...actionIdentity, enabled: z.boolean() }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_runtime_action_enabled", args)
	);
	server.registerTool(
		"set_input_runtime_control_scheme",
		{
			title: "Set Runtime Control Scheme",
			description: "Select one authored control scheme for an active runtime map.",
			inputSchema: z.object({ ...mapIdentity, ...schemeIdentity }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_runtime_control_scheme", args)
	);
	server.registerTool(
		"update_input_runtime",
		{
			title: "Update Manual Input Runtime",
			description: "Advance only a manual-update Input runtime and its interaction timers by an exact bounded delta.",
			inputSchema: z.object({ deltaSeconds: z.number().finite().min(0).max(1).optional(), limit: z.number().int().min(1).max(4096).optional() }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("update_input_runtime", args)
	);
	server.registerTool(
		"simulate_input_control",
		{
			title: "Simulate Input Control",
			description: "Inject a finite scalar, Vector2, or Vector3 value for any supported keyboard/mouse/gamepad/touch path in active preview.",
			inputSchema: z.object({ path: z.string().min(1).max(512), value: simulatedValue }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_input_control", args)
	);
	server.registerTool(
		"clear_simulated_input_control",
		{
			title: "Clear Simulated Input Control",
			description: "Remove one transient simulated control path from active preview.",
			inputSchema: z.object({ path: z.string().min(1).max(512) }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_simulated_input_control", args)
	);
	server.registerTool(
		"simulate_input_touch",
		{
			title: "Simulate Preview Touch",
			description: "Backward-compatible primary-touch press and normalized position injection.",
			inputSchema: z.object({ pressed: z.boolean().optional(), x: z.number().finite().optional(), y: z.number().finite().optional() }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_input_touch", args)
	);
	server.registerTool(
		"apply_input_binding_override",
		{
			title: "Apply Input Binding Override",
			description: "Apply a non-destructive runtime override to one stable binding id and return saveable JSON.",
			inputSchema: z.object({ ...mapIdentity, ...actionIdentity, bindingId: z.string().min(1).max(128), path: z.string().min(1).max(512) }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_input_binding_override", args)
	);
	server.registerTool(
		"clear_input_binding_override",
		{
			title: "Clear Input Binding Override",
			description: "Clear one binding override or all overrides on one action.",
			inputSchema: z.object({ ...mapIdentity, ...actionIdentity, bindingId: z.string().min(1).max(128).optional() }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_input_binding_override", args)
	);
	server.registerTool(
		"save_input_binding_overrides",
		readOnly("Save Input Binding Overrides", "Serialize every active non-destructive binding override as deterministic bounded JSON."),
		async () => callTextTool("save_input_binding_overrides")
	);
	server.registerTool(
		"load_input_binding_overrides",
		{
			title: "Load Input Binding Overrides",
			description: "Validate and load version-1 override JSON, replacing existing overrides unless append mode is requested.",
			inputSchema: z.object({ json: z.string().min(1).max(1_048_576), replace: z.boolean().optional() }).strict(),
		},
		async (args): Promise<CallToolResult> => callTextTool("load_input_binding_overrides", args)
	);
	server.registerTool(
		"get_input_action_trace",
		readOnly(
			"Get Input Action Trace",
			"Read a bounded deterministic page of started/performed/canceled action events.",
			z.object({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(4096).optional() }).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("get_input_action_trace", args)
	);
	server.registerTool(
		"clear_input_action_trace",
		{ title: "Clear Input Action Trace", description: "Clear transient runtime action-phase history.", inputSchema: z.object({ confirm: z.literal(true) }).strict() },
		async (args) => callTextTool("clear_input_action_trace", args)
	);
	server.registerTool(
		"generate_input_action_wrapper",
		readOnly(
			"Generate Input Actions Wrapper",
			"Generate deterministic TypeScript map/action/control-type constants from one exact current authored map.",
			z.object(mapIdentity).strict()
		),
		async (args): Promise<CallToolResult> => callTextTool("generate_input_action_wrapper", args)
	);
}
