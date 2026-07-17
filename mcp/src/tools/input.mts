import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";
const identity = { mapId: z.string().optional(), mapName: z.string().optional() };
const actions = z.array(z.object({ name: z.string(), type: z.enum(["button", "value", "passThrough"]).optional(), bindings: z.array(z.string()).optional() }));
const controlSchemes = z.array(z.object({ name: z.string().min(1), devices: z.array(z.enum(["keyboard", "gamepad", "touch"])).min(1) }));
export function registerInputTools(server: McpServer): void {
	server.registerTool(
		"simulate_input_touch",
		{
			title: "Simulate preview touch input",
			description: "Inject a normalized touch press/position into an active editor preview Input Actions runtime. Start preview/runtime first; x and y are normalized 0–1.",
			inputSchema: z.object({ pressed: z.boolean().optional(), x: z.number().optional(), y: z.number().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_input_touch", args)
	);
	server.registerTool(
		"list_input_action_maps",
		{ title: "List input maps", description: "List persisted input action maps.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_input_action_maps")
	);
	server.registerTool(
		"create_input_action_map",
		{
			title: "Create input map",
			description:
				"Create a persisted Input System-style action map with keyboard, gamepad, and touch bindings. Use paths such as `<keyboard>/space`, `<gamepad>/buttonSouth`, `<gamepad>/leftStick/x`, `<touch>/press`, or `<touch>/position/x`.",
			inputSchema: z.object({ name: z.string(), actions: actions.optional(), controlSchemes: controlSchemes.optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_input_action_map", args)
	);
	server.registerTool(
		"set_input_action_map",
		{
			title: "Set input map",
			description:
				"Update input actions and keyboard/gamepad/touch binding paths. Exported games expose isPressed() and getValue() for normalized gamepad axes/buttons and touch coordinates.",
			inputSchema: z.object({ ...identity, name: z.string().optional(), actions: actions.optional(), controlSchemes: controlSchemes.optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_action_map", args)
	);
	server.registerTool(
		"set_input_action_binding",
		{
			title: "Set Input Action binding",
			description:
				"Replace or append one persisted Input Action binding without rewriting its map. Use a keyboard/gamepad/touch path such as `<keyboard>/space`, `<gamepad>/buttonSouth`, or `<touch>/press`.",
			inputSchema: z.object({ ...identity, actionName: z.string().min(1), binding: z.string().min(1), bindingIndex: z.number().int().nonnegative().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_input_action_binding", args)
	);
	server.registerTool(
		"delete_input_action_map",
		{ title: "Delete input map", description: "Delete a persisted input action map.", inputSchema: z.object(identity) },
		async (args): Promise<CallToolResult> => callTextTool("delete_input_action_map", args)
	);
	server.registerTool(
		"generate_input_action_wrapper",
		{
			title: "Generate Input Actions wrapper",
			description: "Generate TypeScript map/action constants and a union type for one persisted input action map. Save the returned source in game code as needed.",
			inputSchema: z.object(identity),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("generate_input_action_wrapper", args)
	);
}
