import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerParticleTools(server: McpServer): void {
	server.registerTool(
		"create_vfx_trail",
		{
			title: "Create VFX trail",
			description:
				"Create a persistent Babylon ribbon/tube trail following a mesh or transform node. When no generator is supplied, a reusable generator transform is created at the optional position.",
			inputSchema: z.object({
				name: z.string().min(1).optional(),
				generatorNodeId: z.string().optional(),
				generatorNodeName: z.string().optional(),
				generatorName: z.string().min(1).optional(),
				position: z.array(z.number()).length(3).optional(),
				diameter: z.number().positive().optional(),
				length: z.number().positive().optional(),
				segments: z.number().int().positive().optional(),
				sections: z.number().int().min(2).optional(),
				doNotTaper: z.boolean().optional(),
				autoStart: z.boolean().optional(),
				materialId: z.string().optional(),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_vfx_trail", args)
	);

	server.registerTool(
		"list_vfx_trails",
		{
			title: "List VFX trails",
			description: "List persistent VFX trail meshes and their generator/geometry configuration.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_vfx_trails", args)
	);

	server.registerTool(
		"get_vfx_trail",
		{
			title: "Get VFX trail",
			description: "Read one VFX trail configuration.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_vfx_trail", args)
	);

	server.registerTool(
		"set_vfx_trail",
		{
			title: "Set VFX trail",
			description: "Update a persistent VFX trail's generator, geometry, material, or playback. Structural edits rebuild the trail while retaining its node id.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				name: z.string().min(1).optional(),
				generatorNodeId: z.string().optional(),
				generatorNodeName: z.string().optional(),
				diameter: z.number().positive().optional(),
				length: z.number().positive().optional(),
				segments: z.number().int().positive().optional(),
				sections: z.number().int().min(2).optional(),
				doNotTaper: z.boolean().optional(),
				autoStart: z.boolean().optional(),
				materialId: z.string().optional(),
				playing: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vfx_trail", args)
	);

	server.registerTool(
		"delete_vfx_trail",
		{
			title: "Delete VFX trail",
			description: "Delete one VFX trail mesh while retaining its generator node.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_vfx_trail", args)
	);

	server.registerTool(
		"get_particle_collision_planes",
		{
			title: "Get particle collision planes",
			description: "Read persisted CPU particle collision planes.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_collision_planes", args)
	);
	server.registerTool(
		"set_particle_collision_planes",
		{
			title: "Set particle collision planes",
			description:
				"Replace up to eight CPU particle collision planes. Collision positions/normals are in particle simulation space; restitution 0..1 controls bounce. GPU particle systems are not supported.",
			inputSchema: z.object({
				particleSystemId: z.string().optional(),
				particleSystemName: z.string().optional(),
				planes: z.array(z.object({ position: z.array(z.number()).length(3), normal: z.array(z.number()).length(3), restitution: z.number().min(0).max(1) })).max(8),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_collision_planes", args)
	);
	const collisionSpheres = z.array(z.object({ center: z.array(z.number()).length(3), radius: z.number().positive(), restitution: z.number().min(0).max(1) })).max(8);
	server.registerTool(
		"get_particle_collision_spheres",
		{
			title: "Get particle collision spheres",
			description: "Read persisted CPU particle collision spheres.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_collision_spheres", args)
	);
	server.registerTool(
		"set_particle_collision_spheres",
		{
			title: "Set particle collision spheres",
			description: "Replace up to eight CPU particle collision spheres. GPU particle systems are not supported.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional(), spheres: collisionSpheres }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_collision_spheres", args)
	);
	server.registerTool(
		"get_particle_attractors",
		{
			title: "Get particle attractors",
			description: "Read native CPU/GPU particle attractors configured as radial VFX force fields. Positive strength attracts; negative strength repels.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_attractors", args)
	);

	server.registerTool(
		"set_particle_attractors",
		{
			title: "Set particle attractors",
			description:
				"Replace a particle system's native radial VFX force fields. Each field has world position `[x,y,z]` in centimeters and signed strength; positive attracts and negative repels.",
			inputSchema: z.object({
				particleSystemId: z.string().optional(),
				particleSystemName: z.string().optional(),
				attractors: z.array(z.object({ position: z.array(z.number()).length(3), strength: z.number() })).max(16),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_attractors", args)
	);

	server.registerTool(
		"list_particle_assets",
		{
			title: "List particle assets",
			description: "List the `.npss` node particle system assets available in the project. Use `instantiate_particle_system` to bring one into the scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_particle_assets", args)
	);

	server.registerTool(
		"list_particle_systems",
		{
			title: "List particle systems",
			description: "List standard and GPU particle systems in the active scene, including their emitter and core settings.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_particle_systems", args)
	);

	server.registerTool(
		"list_node_particle_systems",
		{
			title: "List Node Particle Systems",
			description: "List Node Particle System Set meshes and their graph/system counts in the active scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_node_particle_systems", args)
	);

	server.registerTool(
		"instantiate_particle_system",
		{
			title: "Instantiate particle system",
			description:
				"Instantiate a `.npss` particle system asset into the scene, or create a default one when no `path` is given. Optionally attach it to an emitter node and position it (centimeters). " +
				"Good for effects like fire, smoke, sparks or rain.",
			inputSchema: z.object({
				path: z.string().optional().describe("Project-relative or absolute path to the `.npss` asset. Omit to create a default particle system."),
				type: z.enum(["standard", "gpu"]).optional().describe("When creating a default system, choose CPU standard (default) or GPU particles."),
				name: z.string().optional().describe("Name for the created particle system."),
				emitterNodeId: z.string().optional().describe("Id of the node to use as the emitter."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters when no emitter node is set."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_particle_system", args)
	);

	server.registerTool(
		"get_node_particle_system_graph",
		{
			title: "Get Node Particle graph",
			description: "Read an existing Node Particle System Set's complete serialized graph.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_particle_system_graph", args)
	);

	server.registerTool(
		"replace_node_particle_system_graph",
		{
			title: "Replace Node Particle graph",
			description: "Replace and rebuild a Node Particle System Set from a serialized graph. Read the current graph first, then modify it deliberately.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), graph: z.record(z.string(), z.any()) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("replace_node_particle_system_graph", args)
	);

	server.registerTool(
		"set_particle_system_properties",
		{
			title: "Set particle system properties",
			description:
				"Set serializable standard/GPU particle properties by dotted path, for example `emitRate`, `minSize`, `maxSize`, `minLifeTime`, `maxLifeTime`, `direction1`, `direction2`, `blendMode`, or `particleTexture` settings.",
			inputSchema: z.object({
				particleSystemId: z.string().optional(),
				particleSystemName: z.string().optional(),
				properties: z.record(z.string(), z.any()).describe("Dotted property path to value map."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_system_properties", args)
	);

	server.registerTool(
		"set_particle_system_playing",
		{
			title: "Start or stop particle system",
			description: "Start or stop a standard or GPU particle system in the editor preview.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional(), playing: z.boolean() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_system_playing", args)
	);

	server.registerTool(
		"validate_particle_system",
		{
			title: "Validate particle system",
			description:
				"Validate a CPU or GPU particle effect before export. Reports invalid emitter/capacity/lifetime/size settings, missing texture or zero-rate warnings, and an estimated peak particle budget. It does not modify the effect.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_particle_system", args)
	);
	const budgetProfileReference = { id: z.string().optional(), name: z.string().optional() };
	server.registerTool(
		"list_vfx_budget_profiles",
		{
			title: "List VFX budget profiles",
			description: "List persisted scene-wide CPU/GPU particle quality profiles.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_vfx_budget_profiles", {})
	);
	server.registerTool(
		"create_vfx_budget_profile",
		{
			title: "Create VFX budget profile",
			description: "Create a reusable quality profile that scales particle capacity and emission, optionally clamping capacity.",
			inputSchema: z.object({
				name: z.string(),
				capacityScale: z.number().positive().optional(),
				emissionScale: z.number().nonnegative().optional(),
				maxCapacity: z.number().int().positive().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_vfx_budget_profile", args)
	);
	server.registerTool(
		"set_vfx_budget_profile",
		{
			title: "Set VFX budget profile",
			description: "Update a persisted particle quality profile.",
			inputSchema: z.object({
				...budgetProfileReference,
				capacityScale: z.number().positive().optional(),
				emissionScale: z.number().nonnegative().optional(),
				maxCapacity: z.number().int().positive().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_vfx_budget_profile", args)
	);
	server.registerTool(
		"apply_vfx_budget_profile",
		{
			title: "Apply VFX budget profile",
			description: "Apply capacity/emission scaling to all native CPU/GPU particle systems in the open scene.",
			inputSchema: z.object(budgetProfileReference),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_vfx_budget_profile", args)
	);
	server.registerTool(
		"delete_vfx_budget_profile",
		{ title: "Delete VFX budget profile", description: "Delete a profile without reverting already applied particle settings.", inputSchema: z.object(budgetProfileReference) },
		async (args): Promise<CallToolResult> => callTextTool("delete_vfx_budget_profile", args)
	);
	const vectorField = z.object({
		min: z.array(z.number()).length(3),
		max: z.array(z.number()).length(3),
		direction: z.array(z.number()).length(3),
		strength: z.number(),
		enabled: z.boolean().optional(),
	});
	server.registerTool(
		"get_particle_vector_fields",
		{
			title: "Get particle vector fields",
			description: "Read persisted bounded directional force fields for a CPU particle system.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_vector_fields", args)
	);
	server.registerTool(
		"set_particle_vector_fields",
		{
			title: "Set particle vector fields",
			description: "Replace up to eight bounded directional vector fields on a CPU particle system. Fields apply force per second inside their min/max 3D bounds.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional(), fields: z.array(vectorField).max(8) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_vector_fields", args)
	);
	const textureVectorFieldReference = { particleSystemId: z.string().optional(), particleSystemName: z.string().optional() };
	server.registerTool(
		"get_particle_texture_vector_fields",
		{
			title: "Get particle texture vector fields",
			description: "Read persistent image-sampled 2D or depth-stacked 3D XYZ vector fields for a CPU particle system. The returned grid is portable scene metadata.",
			inputSchema: z.object(textureVectorFieldReference),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_texture_vector_fields", args)
	);
	server.registerTool(
		"create_particle_texture_vector_field",
		{
			title: "Create particle texture vector field",
			description:
				"Import one image (2D) or ordered image slices (3D) as a capped 1–64 voxel CPU-particle vector field. RGB maps to signed XYZ direction (-1 to +1); the sampled grid is embedded in scene metadata so exports do not need to read source images. GPU particle systems are not supported.",
			inputSchema: z.object({
				...textureVectorFieldReference,
				sourcePath: z.string().min(1).describe("Project image path. RGB is decoded as vector components."),
				sourcePaths: z.array(z.string().min(1)).min(1).max(64).optional().describe("Ordered project image slices for a 3D field; overrides sourcePath."),
				min: z.array(z.number()).length(3),
				max: z.array(z.number()).length(3),
				strength: z.number().optional(),
				width: z.number().int().min(1).max(64).optional(),
				height: z.number().int().min(1).max(64).optional(),
				enabled: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_particle_texture_vector_field", args)
	);
	server.registerTool(
		"set_particle_texture_vector_fields",
		{
			title: "Set particle texture vector fields",
			description:
				"Replace all persistent 2D or depth-stacked 3D image-sampled CPU particle vector-field grids. Prefer create_particle_texture_vector_field for normal image importing.",
			inputSchema: z.object({
				...textureVectorFieldReference,
				fields: z
					.array(
						z.object({
							min: z.array(z.number()).length(3),
							max: z.array(z.number()).length(3),
							strength: z.number(),
							width: z.number().int().min(1).max(64),
							height: z.number().int().min(1).max(64),
							depth: z.number().int().min(1).max(64).optional(),
							vectors: z.array(z.number()),
							sourcePath: z.string(),
							enabled: z.boolean().optional(),
						})
					)
					.max(8),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_texture_vector_fields", args)
	);
	const particleEvent = z.object({ name: z.string().min(1), count: z.number().int().positive(), enabled: z.boolean().optional() });
	server.registerTool(
		"get_particle_events",
		{
			title: "Get particle events",
			description: "Read persistent named burst events for one standard or GPU particle system.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_events", args)
	);
	server.registerTool(
		"get_particle_proximity_events",
		{
			title: "Get CPU particle proximity events",
			description: "Read bounded CPU particle proximity rules that emit bursts into a target particle system.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_proximity_events", args)
	);
	server.registerTool(
		"set_particle_proximity_events",
		{
			title: "Set CPU particle proximity events",
			description:
				"Configure bounded CPU particle-to-particle proximity rules. Matching particles emit a count into the target system; GPU particle systems are not supported.",
			inputSchema: z.object({
				particleSystemId: z.string().optional(),
				particleSystemName: z.string().optional(),
				events: z
					.array(
						z.object({
							targetParticleSystemId: z.string(),
							radius: z.number().positive(),
							count: z.number().int().positive(),
							cooldownMs: z.number().min(0).max(60000).optional(),
							enabled: z.boolean().optional(),
						})
					)
					.max(8),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_proximity_events", args)
	);
	server.registerTool(
		"set_particle_events",
		{
			title: "Set particle events",
			description:
				"Replace up to 32 named gameplay burst events on a standard or GPU particle system. Trigger them from game code using the exported triggerParticleEvent helper or in the open editor with trigger_particle_event.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional(), events: z.array(particleEvent).max(32) }),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_events", args)
	);
	server.registerTool(
		"trigger_particle_event",
		{
			title: "Trigger particle event",
			description:
				"Fire a configured named VFX burst event on one particle system or every matching system. Works with CPU and GPU particles; this is an external/gameplay event, not GPU particle-to-particle event chaining.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional(), eventName: z.string().min(1) }),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("trigger_particle_event", args)
	);
}
