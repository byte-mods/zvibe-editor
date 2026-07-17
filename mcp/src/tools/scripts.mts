import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerScriptTools(server: McpServer): void {
	server.registerTool(
		"list_script_templates",
		{
			title: "List script templates",
			description: "List built-in TypeScript behavior-script templates for use with create_script.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_script_templates", args)
	);
	server.registerTool(
		"list_scripts",
		{
			title: "List scripts",
			description: "List the TypeScript scripts under the project's `src/` folder. Scripts implement behaviors (`onStart`/`onUpdate`/`onStop`) and are attached to nodes.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_scripts", args)
	);
	server.registerTool(
		"list_custom_script_templates",
		{ title: "List custom script templates", description: "List reusable project-local script templates.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (args): Promise<CallToolResult> => callTextTool("list_custom_script_templates", args)
	);
	server.registerTool(
		"set_custom_script_template",
		{
			title: "Set custom script template",
			description: "Create or replace a reusable project-local TypeScript script template.",
			inputSchema: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), description: z.string().optional(), content: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_script_template", args)
	);

	server.registerTool(
		"create_script",
		{
			title: "Create script",
			description:
				"Create a new TypeScript script using the editor's default skeleton. The path MUST live under `src/**` (scripts outside `src/` are not valid editor scripts). " +
				"Scripts are for runtime BEHAVIOR ONLY (input, movement, game rules, AI, collision reactions, runtime spawning) — NOT for building the scene. " +
				"Before writing a script, author the geometry, materials, lights and props with the editor tools (`create_primitive_mesh`, `instantiate_mesh_asset`, `create_material`, `create_instance`, `create_light`, `set_mesh_physics`) so they remain real, hand-editable assets. " +
				"After creating, edit it with `write_script` and attach it to a node with `attach_script`.",
			inputSchema: z.object({
				path: z.string().describe("Project path for the new script under `src/`, e.g. `src/door.ts`."),
				className: z.string().optional().describe("Optional class name to use in the skeleton."),
				template: z.enum(["component", "empty", "animator-behaviour"]).optional().describe("Built-in script template. Defaults to component."),
				templatePath: z.string().optional().describe("Project-local custom template path from list_custom_script_templates; overrides template."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_script", args)
	);

	server.registerTool(
		"read_script",
		{
			title: "Read script",
			description: "Read the content of a TypeScript script file. Use before `write_script` to make incremental edits without losing existing code.",
			inputSchema: z.object({
				path: z.string().describe("Project path of the script under `src/`."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("read_script", args)
	);

	server.registerTool(
		"write_script",
		{
			title: "Write script",
			description:
				"Overwrite a script's content. The file must be under `src/**`. Implement runtime behaviors with the editor's `IScript` interface (`onStart`/`onUpdate`/`onStop`) and export inspector-editable values where it helps reuse. " +
				"Keep scripts to LOGIC, not scene construction: do not use `new Mesh`/`MeshBuilder`/`new StandardMaterial`/`new ...Light` to build geometry, materials or lighting in code — that content must be authored with the editor tools so the user can hand-edit it. " +
				"Reference already-authored assets from the script (e.g. look them up by name, or expose exported values set via `set_script_exported_value`). " +
				"Example: a door that opens when the player is near checks distance in `onUpdate` and plays an animation on the existing authored door mesh.",
			inputSchema: z.object({
				path: z.string().describe("Project path of the script under `src/`."),
				content: z.string().describe("The full new content of the script file."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("write_script", args)
	);

	server.registerTool(
		"rename_script",
		{ title: "Rename script", description: "Move or rename a TypeScript script inside src/.", inputSchema: z.object({ sourcePath: z.string(), destinationPath: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("rename_script", args)
	);
	server.registerTool(
		"delete_script",
		{
			title: "Delete script",
			description: "Permanently delete a script in src/. Requires confirmation.",
			inputSchema: z.object({ path: z.string(), confirm: z.literal(true) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_script", args)
	);
	server.registerTool(
		"validate_script",
		{
			title: "Validate script",
			description: "TypeScript-transpile a script and return syntax diagnostics.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_script", args)
	);
	server.registerTool(
		"get_script_semantic_diagnostics",
		{
			title: "Get script semantic diagnostics",
			description:
				"Type-check one TypeScript behavior script and return semantic/syntax diagnostics with project-relative file, line, and column. Unlike validate_script, this catches type errors.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_script_semantic_diagnostics", args)
	);
	server.registerTool(
		"get_project_script_semantic_diagnostics",
		{
			title: "Get project script diagnostics",
			description: "Type-check every TypeScript behavior script under src/ and return semantic diagnostics with source locations.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_project_script_semantic_diagnostics", {})
	);
	server.registerTool(
		"get_script_runtime_diagnostics",
		{
			title: "Get script runtime diagnostics",
			description:
				"Read live lifecycle call counts and the latest error for behavior scripts currently running on a scene node. Start the preview/game first; an empty scripts array means no behavior is currently active on that node.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_script_runtime_diagnostics", args)
	);
	server.registerTool(
		"get_script_exported_fields",
		{
			title: "Get script exported fields",
			description: "Discover @visibleInInspector-decorated script fields and their declared types/defaults.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_script_exported_fields", args)
	);

	server.registerTool(
		"attach_script",
		{
			title: "Attach script",
			description:
				"Attach a script file to a node (the scene itself can also have scripts). This writes the node's script metadata exactly as the inspector's Scripts section does, so the attachment is visible to the user.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				path: z.string().describe("Project path of the script under `src/` to attach."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("attach_script", args)
	);

	server.registerTool(
		"list_attached_scripts",
		{
			title: "List attached scripts",
			description:
				"List the scripts attached to a node along with their exported inspector values. Use this to discover which exported values you can tune with `set_script_exported_value`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_attached_scripts", args)
	);

	server.registerTool(
		"set_script_exported_value",
		{
			title: "Set script exported value",
			description:
				"Set an exported/inspector value of a script attached to a node. This lets you configure the same reusable script differently per object (e.g. open distance, speed).",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				path: z.string().describe("Project path of the attached script."),
				key: z.string().describe("Name of the exported value to set."),
				value: z.any().describe("The new value."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_script_exported_value", args)
	);

	server.registerTool(
		"set_attached_script_execution_order",
		{
			title: "Set attached script execution order",
			description:
				"Set a deterministic execution order for one script attached to a node. Lower values initialize and update before higher values on that same object; equal values retain attachment order.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				path: z.string().describe("Project path of the attached script under src/."),
				executionOrder: z.number().int().min(-32000).max(32000).describe("Integer order from -32000 to 32000; lower executes first."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_attached_script_execution_order", args)
	);
	server.registerTool(
		"list_scene_script_execution_orders",
		{
			title: "List scene script execution orders",
			description: "List scene-wide execution orders by script path. These override individual attachment orders when this exported scene loads.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_scene_script_execution_orders", args)
	);
	server.registerTool(
		"set_scene_script_execution_order",
		{
			title: "Set scene script execution order",
			description:
				"Set a scene-wide order for every attachment of one script path. Lower values execute first across the loaded scene; pass null to remove the global override.",
			inputSchema: z.object({
				path: z.string().describe("Project path of a script under src/."),
				executionOrder: z.number().int().min(-32000).max(32000).nullable().describe("Global integer order, or null to restore attachment-specific ordering."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_scene_script_execution_order", args)
	);
	server.registerTool(
		"list_project_script_execution_orders",
		{
			title: "List project script execution orders",
			description:
				"List persisted project-wide TypeScript behavior-script execution orders. They apply to every scene when exported; scene-specific overrides take precedence.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_project_script_execution_orders", args)
	);
	server.registerTool(
		"set_project_script_execution_order",
		{
			title: "Set project script execution order",
			description:
				"Set or clear a persisted Unity-style project-wide execution order for a TypeScript script. Lower values execute first across exported scenes; a scene-specific order overrides it.",
			inputSchema: z.object({ path: z.string(), executionOrder: z.number().int().min(-32000).max(32000).nullable() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_project_script_execution_order", args)
	);

	server.registerTool(
		"detach_script",
		{
			title: "Detach script",
			description: "Remove an attached script from a node.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target node (preferred)."),
				nodeName: z.string().optional().describe("Name of the target node."),
				path: z.string().describe("Project path of the attached script to remove."),
			}),
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("detach_script", args)
	);
}
