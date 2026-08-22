import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false } as const;
const transientMutation = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false } as const;
const destructiveMutation = { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false } as const;
const reportMutation = { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false } as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePath = z
	.string()
	.min(6)
	.max(1_024)
	.regex(/^src\/(?!.*\.\.\/).+\.(?:ts|tsx)$/);
const sceneNodeIdentity = {
	nodeId: z.string().min(1).max(256).optional().describe("Id of the target node (preferred)."),
	nodeName: z.string().min(1).max(256).optional().describe("Name of the target node."),
};
const exportedFieldKey = z
	.string()
	.regex(/^[A-Za-z_$][\w$]{0,127}$/)
	.refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "Unsafe exported-field key.");
const debuggerLease = {
	expectedManifestFingerprint: sha256.describe("Exact manifest fingerprint returned by get_script_debugger."),
	expectedConfigurationRevision: z.number().int().min(1).describe("Exact debugger configuration revision returned by get_script_debugger."),
};
const sourceBreakpoint = z
	.object({
		id: z
			.string()
			.regex(/^[a-zA-Z0-9._:-]{1,128}$/)
			.optional(),
		path: sourcePath,
		line: z.number().int().min(1).max(1_000_000),
		column: z.number().int().min(1).max(1_000_000).optional(),
		enabled: z.boolean().optional(),
		hitCondition: z.number().int().min(1).max(1_000_000).optional(),
	})
	.strict();
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(16_384), z.array(jsonValueSchema).max(256), z.record(z.string().min(1).max(128), jsonValueSchema)])
);

export function registerScriptTools(server: McpServer): void {
	server.registerTool(
		"get_inspector_collection_capabilities",
		{
			title: "Get Inspector collection capabilities",
			description: "List typed visibleAsArray/visibleAsList authoring, bounded row operations, and DataTypeStyleMapper-compatible built-in or extension-registered styles.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_inspector_collection_capabilities", {})
	);
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
		{
			title: "List custom script templates",
			description: "List bounded reusable project-local script-template metadata and exact fingerprints without returning source content.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_custom_script_templates", args)
	);
	server.registerTool(
		"get_custom_script_template",
		{
			title: "Get custom script template",
			description: "Inspect exact source content and SHA-256 fingerprint for one project-local custom script template before replacing or deleting it.",
			inputSchema: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/) }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_script_template", args)
	);
	server.registerTool(
		"set_custom_script_template",
		{
			title: "Set custom script template",
			description: "Create a reusable project-local TypeScript template, or atomically replace an inspected template using its exact expectedFingerprint.",
			inputSchema: z
				.object({
					id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
					description: z.string().max(2_048).optional(),
					content: z.string().min(1).max(262_144),
					expectedFingerprint: sha256.optional(),
				})
				.strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_script_template", args)
	);
	server.registerTool(
		"delete_custom_script_template",
		{
			title: "Delete custom script template",
			description: "Permanently delete one exact inspected custom script template. Requires its fingerprint and explicit confirmation.",
			inputSchema: z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/), expectedFingerprint: sha256, confirm: z.literal(true) }).strict(),
			annotations: destructiveMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_script_template", args)
	);

	server.registerTool(
		"get_script_debugger_capabilities",
		{
			title: "Get script debugger capabilities",
			description: "Inspect Debug Play breakpoint, safe-boundary pause, variable snapshot, coverage, export, and explicit limitation contracts without starting Play.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_script_debugger_capabilities", args)
	);
	server.registerTool(
		"prepare_script_debugger",
		{
			title: "Prepare script debugger",
			description:
				"Enable and compile source-instrumented Debug Play, or disable probes and rebuild a running Play scene. This affects only editor Play, never exported builds.",
			inputSchema: z.object({ enabled: z.boolean() }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("prepare_script_debugger", args)
	);
	server.registerTool(
		"get_script_debugger",
		{
			title: "Get script debugger",
			description: "Read the exact instrumented manifest lease, resolved breakpoints, current hit, bounded trace, safe field snapshot, and attached-script pause state.",
			inputSchema: z.object({ traceOffset: z.number().int().min(0).max(511).optional(), traceLimit: z.number().int().min(1).max(512).optional() }).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_script_debugger", args)
	);
	server.registerTool(
		"set_script_breakpoints",
		{
			title: "Set script breakpoints",
			description:
				"Atomically replace up to 64 runtime breakpoints under an exact source-manifest and debugger-configuration lease; requested lines resolve to the next executable point in the same file.",
			inputSchema: z.object({ ...debuggerLease, breakpoints: z.array(sourceBreakpoint).max(64), traceLimit: z.number().int().min(1).max(512).optional() }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_script_breakpoints", args)
	);
	server.registerTool(
		"control_script_debugger",
		{
			title: "Control script debugger",
			description:
				"Pause/resume attached-script lifecycle delivery, advance one bounded fixed step while paused, or clear retained breakpoint-hit evidence under exact expected state.",
			inputSchema: z
				.object({
					...debuggerLease,
					expectedPaused: z.boolean(),
					action: z.enum(["pause", "resume", "step", "clear-trace"]),
					deltaSeconds: z.number().min(0.001).max(0.1).optional(),
				})
				.strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("control_script_debugger", args)
	);
	server.registerTool(
		"get_script_source_coverage",
		{
			title: "Get script source coverage",
			description: "Read source-level file/line/statement/function/branch coverage plus bounded exact source-point hits from instrumented Debug Play.",
			inputSchema: z
				.object({ path: sourcePath.optional(), offset: z.number().int().min(0).max(99_999).optional(), limit: z.number().int().min(1).max(2_000).optional() })
				.strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_script_source_coverage", args)
	);
	server.registerTool(
		"set_script_source_coverage",
		{
			title: "Set script source coverage",
			description: "Enable/disable source coverage and optionally clear accumulated hit counts under the exact debugger lease.",
			inputSchema: z.object({ ...debuggerLease, enabled: z.boolean(), clear: z.boolean().optional() }).strict(),
			annotations: transientMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_script_source_coverage", args)
	);
	server.registerTool(
		"export_script_source_coverage",
		{
			title: "Export script source coverage",
			description:
				"Atomically export an exact coverage revision as deterministic JSON or LCOV below .bjseditor/script-coverage/ without returning the potentially large report body.",
			inputSchema: z
				.object({
					...debuggerLease,
					expectedCoverageRevision: z.number().int().min(0),
					format: z.enum(["json", "lcov"]),
					path: z
						.string()
						.min(36)
						.max(1_024)
						.regex(/^\.bjseditor\/script-coverage\/(?!.*\.\.\/).+\.(?:json|lcov)$/),
				})
				.strict(),
			annotations: reportMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("export_script_source_coverage", args)
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
				template: z
					.enum(["component", "empty", "animator-behaviour", "animation-rig-job", "grid-brush", "light2d-providers"])
					.optional()
					.describe("Built-in script template. Defaults to component."),
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
				"Read live lifecycle, deterministic-manual-step call counts, exact last manual delta, and latest error for attached behavior scripts on a node. Automatically resolves the corresponding runtime node in a ready Play scene; an empty scripts array means no behavior is active.",
			inputSchema: z
				.object({
					nodeId: z.string().optional().describe("Id of the target node (preferred)."),
					nodeName: z.string().optional().describe("Name of the target node."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_script_runtime_diagnostics", args)
	);
	server.registerTool(
		"get_script_exported_fields",
		{
			title: "Get script exported fields",
			description:
				"Discover visibleAs*-decorated script fields, including typed visibleAsArray/visibleAsList declarations, their source types/defaults, and bounded decorator text.",
			inputSchema: z.object({ path: sourcePath }).strict(),
			annotations: readOnly,
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
			inputSchema: z
				.object({
					...sceneNodeIdentity,
					path: sourcePath.describe("Project path of the attached script."),
					key: exportedFieldKey.describe("Name of the exported value to set."),
					value: jsonValueSchema.describe("The new bounded JSON value, including typed list/array contents."),
				})
				.strict(),
			annotations: reportMutation,
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
