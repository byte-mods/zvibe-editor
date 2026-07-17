import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

export function registerNavMeshTools(server: McpServer): void {
	const areaSchema = z.object({
		id: z.number().int().min(0).max(63).describe("Stable Detour area id. Area 0 is the required walkable default."),
		name: z.string().min(1).max(64).describe("Unique human-readable area name, for example Walkable or Jump."),
		cost: z.number().positive().max(1000).describe("Positive traversal multiplier used when a path traverses this area."),
	});
	const linkSchema = z.object({
		path: z.string(),
		id: z.string().optional(),
		start: z.array(z.number()).length(3),
		end: z.array(z.number()).length(3),
		radius: z.number().positive().optional(),
		bidirectional: z.boolean().optional(),
		area: z.number().int().nonnegative().optional(),
		flags: z.number().int().nonnegative().optional(),
		userId: z.number().int().nonnegative().optional(),
	});
	server.registerTool(
		"list_navmesh_areas",
		{
			title: "List NavMesh areas",
			description: "List named Detour traversal areas and their path-cost multipliers. Areas are used by off-mesh links and route queries.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_navmesh_areas", args)
	);
	server.registerTool(
		"set_navmesh_areas",
		{
			title: "Set NavMesh areas",
			description: "Replace named traversal areas and costs for a NavMesh. Keep area 0 as Walkable; rebuild if changed off-mesh-link area IDs must be embedded.",
			inputSchema: z.object({ path: z.string(), areas: z.array(areaSchema).min(1).max(64) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_navmesh_areas", args)
	);
	server.registerTool(
		"list_navmesh_links",
		{
			title: "List NavMesh off-mesh links",
			description: "List authored jump, door, ladder, or teleport links that are embedded during NavMesh rebuild.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_navmesh_links", args)
	);
	server.registerTool(
		"create_navmesh_link",
		{
			title: "Create NavMesh off-mesh link",
			description: "Add a persistent off-mesh connection between two world positions. Rebuild the NavMesh to embed it in navigation data.",
			inputSchema: linkSchema,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_navmesh_link", args)
	);
	server.registerTool(
		"set_navmesh_link",
		{
			title: "Set NavMesh off-mesh link",
			description: "Update an off-mesh connection and rebuild to apply it.",
			inputSchema: linkSchema.partial({ start: true, end: true }).extend({ id: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_navmesh_link", args)
	);
	server.registerTool(
		"delete_navmesh_link",
		{
			title: "Delete NavMesh off-mesh link",
			description: "Remove an off-mesh connection and rebuild to apply the change.",
			inputSchema: z.object({ path: z.string(), id: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_navmesh_link", args)
	);
	server.registerTool(
		"compute_navmesh_path",
		{
			title: "Compute NavMesh path",
			description: "Compute a genuine Recast route over a rebuilt NavMesh asset.",
			inputSchema: z.object({
				path: z.string(),
				start: z.array(z.number()).length(3),
				destination: z.array(z.number()).length(3),
				areaCosts: z.record(z.string(), z.number().positive().max(1000)).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("compute_navmesh_path", args)
	);
	server.registerTool(
		"list_nav_agents",
		{
			title: "List navigation agents",
			description: "List persisted node-bound navigation-agent definitions and their planned paths.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_nav_agents", {})
	);
	server.registerTool(
		"create_nav_agent",
		{
			title: "Create navigation agent",
			description: "Create a persisted navigation-agent definition bound to a scene node and a rebuilt NavMesh asset.",
			inputSchema: z.object({
				id: z.string().optional(),
				nodeId: z.string(),
				navMeshPath: z.string(),
				radius: z.number().positive().optional(),
				height: z.number().positive().optional(),
				maxSpeed: z.number().positive().optional(),
				maxAcceleration: z.number().positive().optional(),
				avoidanceEnabled: z.boolean().optional().describe("Enable deterministic local crowd avoidance. Defaults to true."),
				avoidanceRadius: z.number().positive().optional().describe("Personal-space radius used to avoid other active agents, in editor units."),
				avoidanceWeight: z.number().nonnegative().optional().describe("Steering strength for local avoidance. Defaults to 1."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_nav_agent", args)
	);
	server.registerTool(
		"set_nav_agent",
		{
			title: "Set navigation agent",
			description: "Update navigation movement settings and persisted deterministic local crowd-avoidance tuning without clearing the planned route.",
			inputSchema: z.object({
				id: z.string(),
				radius: z.number().positive().optional(),
				height: z.number().positive().optional(),
				maxSpeed: z.number().positive().optional(),
				maxAcceleration: z.number().positive().optional(),
				avoidanceEnabled: z.boolean().optional(),
				avoidanceRadius: z.number().positive().optional(),
				avoidanceWeight: z.number().nonnegative().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_nav_agent", args)
	);
	server.registerTool(
		"set_nav_agent_destination",
		{
			title: "Plan navigation-agent destination",
			description: "Plan and persist a real Recast path from an agent node to a world-space destination.",
			inputSchema: z.object({ id: z.string(), destination: z.array(z.number()).length(3) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_nav_agent_destination", args)
	);
	server.registerTool(
		"delete_nav_agent",
		{
			title: "Delete navigation agent",
			description: "Remove a persisted navigation-agent definition without deleting its scene node.",
			inputSchema: z.object({ id: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_nav_agent", args)
	);
	server.registerTool(
		"start_nav_agent",
		{ title: "Start navigation agent", description: "Start moving an agent along its previously planned Recast route at maxSpeed.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("start_nav_agent", args)
	);
	server.registerTool(
		"stop_nav_agent",
		{ title: "Stop navigation agent", description: "Stop an agent’s live route follower while preserving its planned route.", inputSchema: z.object({ id: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("stop_nav_agent", args)
	);
	server.registerTool(
		"list_navmeshes",
		{ title: "List NavMeshes", description: "List editable .navmesh assets in the project.", inputSchema: z.object({}), annotations: { readOnlyHint: true } },
		async (): Promise<CallToolResult> => callTextTool("list_navmeshes", {})
	);
	server.registerTool(
		"get_navmesh",
		{
			title: "Get NavMesh configuration",
			description: "Read NavMesh parameters, static meshes, obstacle meshes, and whether generated binary data is present.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_navmesh", args)
	);
	server.registerTool(
		"create_navmesh",
		{
			title: "Create NavMesh",
			description: "Create an editable .navmesh asset. Configuration contains native `navMeshParameters`, `staticMeshes`, and `obstacleMeshes` fields.",
			inputSchema: z.object({ path: z.string(), configuration: z.record(z.string(), z.any()).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_navmesh", args)
	);
	server.registerTool(
		"set_navmesh_configuration",
		{
			title: "Set NavMesh configuration",
			description:
				"Update NavMesh build parameters, enabled static mesh IDs, and box/cylinder obstacle configuration. Rebuild afterwards to generate navmesh.bin/tilecache.bin.",
			inputSchema: z.object({ path: z.string(), configuration: z.record(z.string(), z.any()) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_navmesh_configuration", args)
	);
	server.registerTool(
		"rebuild_navmesh",
		{
			title: "Rebuild NavMesh",
			description: "Build the NavMesh using the editor's Recast navigation path and write navmesh.bin plus tilecache.bin into the asset.",
			inputSchema: z.object({ path: z.string() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("rebuild_navmesh", args)
	);
	server.registerTool(
		"get_navmesh_data",
		{
			title: "Get NavMesh data",
			description: "Return generated navmesh and tile-cache binary payloads as base64 for verification or external inspection.",
			inputSchema: z.object({ path: z.string() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_navmesh_data", args)
	);
}
