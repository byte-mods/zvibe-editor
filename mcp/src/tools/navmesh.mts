import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { callTextTool } from "./helpers.mjs";

export function registerNavMeshTools(server: McpServer): void {
	const areaSchema = z
		.object({
			id: z.number().int().min(0).max(63).describe("Stable Detour area id. Area 0 is the required walkable default."),
			name: z.string().min(1).max(64).describe("Unique human-readable area name, for example Walkable or Jump."),
			cost: z.number().positive().max(1000).describe("Positive traversal multiplier used when a path traverses this area."),
		})
		.strict();
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
	const navAgentTuningSchema = {
		radius: z.number().positive().max(100000).optional().describe("Agent radius in editor world units (centimeters by convention)."),
		height: z.number().positive().max(100000).optional().describe("Agent height in editor world units."),
		maxSpeed: z.number().positive().max(10000).optional().describe("Maximum movement speed in meters per second; converted to editor centimeters at runtime."),
		maxAcceleration: z.number().positive().max(10000).optional().describe("Maximum acceleration in meters per second squared."),
		avoidanceEnabled: z.boolean().optional().describe("Enable Detour obstacle avoidance and separation steering."),
		avoidanceRadius: z.number().positive().max(100000).optional().describe("Legacy alias for collisionQueryRange, retained for scene compatibility."),
		avoidanceWeight: z.number().nonnegative().max(1000).optional().describe("Legacy alias for separationWeight, retained for scene compatibility."),
		collisionQueryRange: z.number().positive().max(100000).optional().describe("Detour steering-neighbor query range in editor units."),
		pathOptimizationRange: z.number().positive().max(1000000).optional().describe("Detour path-visibility optimization range in editor units."),
		separationWeight: z.number().nonnegative().max(1000).optional().describe("Strength of native Detour crowd separation."),
		updateFlags: z.number().int().min(0).max(31).optional().describe("Detour crowd update bitmask: turns, avoidance, separation, visibility, and topology."),
		obstacleAvoidanceType: z.number().int().min(0).max(7).optional().describe("Detour obstacle-avoidance quality slot."),
		queryFilterType: z.number().int().min(0).max(15).optional().describe("Crowd query-filter slot used for polygon flags and area costs."),
		reachRadius: z.number().positive().max(100000).optional().describe("Distance from the destination at which the agent is considered arrived."),
		updateRotation: z.boolean().optional().describe("Rotate the bound transform toward its Detour velocity."),
		angularSpeed: z.number().positive().max(10000).optional().describe("Maximum Y-axis rotation speed in radians per second."),
		autoRepath: z.boolean().optional().describe("Automatically reissue the active destination after carved NavMesh tiles change."),
	};
	const navObstacleTuningSchema = {
		enabled: z.boolean().optional().describe("Include this obstacle in the NavMesh runtime."),
		type: z.enum(["box", "cylinder"]).optional().describe("Recast tile-cache obstacle shape."),
		carving: z.boolean().optional().describe("Carve this obstacle into affected NavMesh tiles."),
		dynamic: z.boolean().optional().describe("Monitor the bound scene node for runtime transform changes."),
		carveOnlyStationary: z.boolean().optional().describe("Remove carving while moving, then restore it after timeToStationary."),
		moveThreshold: z.number().positive().max(1000000).optional().describe("World-space distance required before a transform change triggers carving."),
		timeToStationary: z.number().nonnegative().max(3600).optional().describe("Seconds without threshold movement before stationary-only carving returns."),
		updateInterval: z.number().positive().max(60).optional().describe("Seconds between runtime obstacle transform samples."),
	};
	const crowdFilterSchema = z
		.object({
			index: z.number().int().min(0).max(15).describe("Detour query-filter slot."),
			includeFlags: z.number().int().min(0).max(65535).optional(),
			excludeFlags: z.number().int().min(0).max(65535).optional(),
			areaCosts: z.record(z.string(), z.number().positive().max(1000)).optional().describe("Area-id strings mapped to positive traversal costs."),
		})
		.strict();
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
		"list_navmesh_surfaces",
		{
			title: "List NavMesh source surfaces",
			description:
				"List every configured static source surface with enabled state, authored Detour area id, scene-node name, and missing-node evidence. Use this before painting a surface area.",
			inputSchema: z.object({ path: z.string().min(1).describe("Project-relative .navmesh asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_navmesh_surfaces", args)
	);
	server.registerTool(
		"set_navmesh_surface_area",
		{
			title: "Paint NavMesh source-surface area",
			description:
				"Assign one configured static source mesh to a defined Detour area. The next rebuild applies the area before Recast rasterization, preserving the boundary in generated polygons and obstacle-rebuilt tiles.",
			inputSchema: z
				.object({
					path: z.string().min(1).describe("Project-relative .navmesh asset path."),
					nodeId: z.string().min(1).describe("Exact scene-node id already present in the NavMesh staticMeshes list."),
					area: z.number().int().min(0).max(63).describe("Defined Detour traversal area id to paint across the source surface."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_navmesh_surface_area", args)
	);
	server.registerTool(
		"sample_navmesh_area",
		{
			title: "Sample rebuilt NavMesh area",
			description:
				"Find the nearest generated NavMesh polygon to a world-space point and return its final Detour area id, name, cost, polygon reference, and snapped point. This verifies surface painting after rebuild.",
			inputSchema: z
				.object({
					path: z.string().min(1).describe("Project-relative rebuilt .navmesh asset path."),
					position: z.array(z.number().finite()).length(3).describe("World-space xyz point to sample."),
					halfExtents: z.array(z.number().positive().max(1000000)).length(3).optional().describe("Positive xyz search half-extents. Defaults to 100 on each axis."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("sample_navmesh_area", args)
	);
	server.registerTool(
		"list_navmesh_obstacles",
		{
			title: "List NavMesh carving obstacles",
			description: "List authored box/cylinder carving obstacles, stationary thresholds, scene-node evidence, and live tile-cache state when active.",
			inputSchema: z.object({ path: z.string().min(1) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_navmesh_obstacles", args)
	);
	server.registerTool(
		"create_navmesh_obstacle",
		{
			title: "Create NavMesh carving obstacle",
			description: "Bind a scene node as a dynamic Recast box/cylinder obstacle with Unity-style carving, move threshold, and stationary timing.",
			inputSchema: z.object({ path: z.string().min(1), nodeId: z.string().min(1), ...navObstacleTuningSchema }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_navmesh_obstacle", args)
	);
	server.registerTool(
		"set_navmesh_obstacle",
		{
			title: "Configure NavMesh carving obstacle",
			description: "Update carving shape, dynamic monitoring, stationary-only behavior, movement threshold, and sample interval for an existing obstacle.",
			inputSchema: z.object({ path: z.string().min(1), nodeId: z.string().min(1), ...navObstacleTuningSchema }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_navmesh_obstacle", args)
	);
	server.registerTool(
		"delete_navmesh_obstacle",
		{
			title: "Delete NavMesh carving obstacle",
			description: "Remove a node-bound carving obstacle from the NavMesh asset and its active tile cache.",
			inputSchema: z.object({ path: z.string().min(1), nodeId: z.string().min(1) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_navmesh_obstacle", args)
	);
	server.registerTool(
		"get_navmesh_obstacle_runtime",
		{
			title: "Inspect live NavMesh obstacle",
			description: "Return current/carved position, moving/stationary state, stationary duration, tile update count, and runtime errors for one obstacle.",
			inputSchema: z.object({ path: z.string().min(1), nodeId: z.string().min(1) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_navmesh_obstacle_runtime", args)
	);
	server.registerTool(
		"refresh_navmesh_obstacles",
		{
			title: "Refresh NavMesh obstacle carving",
			description: "Immediately sample all obstacle transforms, drain affected tile rebuilds, and automatically reissue active agent destinations.",
			inputSchema: z.object({ path: z.string().min(1) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_navmesh_obstacles", args)
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
			description: "List persisted node-bound navigation agents, planned paths, and live Detour Crowd evidence when available.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_nav_agents", {})
	);
	server.registerTool(
		"create_nav_agent",
		{
			title: "Create navigation agent",
			description: "Create a persisted agent bound to a scene node, load its rebuilt NavMesh, and add it to a native Detour Crowd.",
			inputSchema: z
				.object({
					id: z.string().optional(),
					nodeId: z.string(),
					navMeshPath: z.string(),
					...navAgentTuningSchema,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_nav_agent", args)
	);
	server.registerTool(
		"set_nav_agent",
		{
			title: "Set navigation agent",
			description: "Update movement, native Detour avoidance/separation, query-filter, arrival, and rotation settings without clearing the planned route.",
			inputSchema: z
				.object({
					id: z.string(),
					...navAgentTuningSchema,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_nav_agent", args)
	);
	server.registerTool(
		"set_nav_agent_destination",
		{
			title: "Plan navigation-agent destination",
			description: "Plan and persist a real Recast path from an agent node to a world-space destination, optionally issuing it immediately to Detour Crowd.",
			inputSchema: z.object({ id: z.string(), destination: z.array(z.number().finite()).length(3), startMoving: z.boolean().optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_nav_agent_destination", args)
	);
	server.registerTool(
		"delete_nav_agent",
		{
			title: "Delete navigation agent",
			description: "Remove a persisted navigation-agent definition without deleting its scene node.",
			inputSchema: z.object({ id: z.string() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_nav_agent", args)
	);
	server.registerTool(
		"start_nav_agent",
		{
			title: "Start navigation agent",
			description: "Issue the persisted destination to the agent's native Detour Crowd.",
			inputSchema: z.object({ id: z.string() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_nav_agent", args)
	);
	server.registerTool(
		"stop_nav_agent",
		{
			title: "Stop navigation agent",
			description: "Cancel an agent's Detour move request while preserving its destination and planned route.",
			inputSchema: z.object({ id: z.string() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_nav_agent", args)
	);
	server.registerTool(
		"list_nav_crowds",
		{
			title: "List Detour crowds",
			description: "List per-NavMesh Detour Crowd capacity, timestep, spatial-query extent, and query-filter settings.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_nav_crowds", {})
	);
	server.registerTool(
		"set_nav_crowd",
		{
			title: "Configure Detour crowd",
			description: "Create or replace native crowd capacity, fixed-step, query-extent, polygon-flag, and area-cost settings for one NavMesh asset.",
			inputSchema: z
				.object({
					navMeshPath: z.string().min(1),
					maxAgents: z.number().int().min(1).max(10000).optional(),
					maxAgentRadius: z.number().positive().max(100000).optional(),
					timeStep: z.number().positive().max(1).optional(),
					maxSubStepCount: z.number().int().min(0).max(100).optional(),
					queryExtent: z.array(z.number().positive().max(1000000)).length(3).optional(),
					filters: z.array(crowdFilterSchema).max(16).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_nav_crowd", args)
	);
	server.registerTool(
		"get_nav_agent_runtime",
		{
			title: "Inspect live Detour agent",
			description: "Return live crowd index, state, position, velocity, corridor corners, next target, off-mesh state, and remaining distance for verification.",
			inputSchema: z.object({ id: z.string().min(1) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_nav_agent_runtime", args)
	);
	server.registerTool(
		"teleport_nav_agent",
		{
			title: "Warp Detour agent",
			description: "Teleport a native crowd agent and its bound scene transform to a world-space position, equivalent to NavMeshAgent.Warp.",
			inputSchema: z.object({ id: z.string().min(1), position: z.array(z.number().finite()).length(3) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("teleport_nav_agent", args)
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
			description:
				"Create an editable .navmesh asset. Configuration contains native `navMeshParameters`, `staticMeshes`, and `obstacleMeshes` fields. Recast `navMeshParameters` are native Recast values: `cs` (cell size) is in scene units (centimeters) and `ch` is the cell height, while `walkableRadius` and `walkableClimb`/`walkableHeight` are voxel counts (multiples of `cs` and `ch`), e.g. a 40 cm agent radius with cs 10 is walkableRadius 4.",
			inputSchema: z.object({ path: z.string(), configuration: z.record(z.string(), z.any()).optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_navmesh", args)
	);
	server.registerTool(
		"set_navmesh_configuration",
		{
			title: "Set NavMesh configuration",
			description:
				"Update NavMesh build parameters, enabled static mesh IDs, and box/cylinder obstacle configuration. Rebuild afterwards to generate navmesh.bin/tilecache.bin. Recast `navMeshParameters` are native Recast values: `cs` (cell size) is in scene units (centimeters) and `ch` is the cell height, while `walkableRadius` and `walkableClimb`/`walkableHeight` are voxel counts (multiples of `cs` and `ch`), e.g. a 40 cm agent radius with cs 10 is walkableRadius 4.",
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
