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
			description: "Read persisted CPU or native GPU particle collision planes and exact execution-backend evidence.",
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
				"Replace up to eight CPU or native GPU particle collision planes. Collision positions/normals are in particle simulation space; restitution 0..1 controls bounce. GPU systems execute in the WebGL2 transform-feedback or WebGPU compute update shader without CPU particle readback.",
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
			description: "Read persisted CPU or native GPU particle collision spheres and exact execution-backend evidence.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_particle_collision_spheres", args)
	);
	server.registerTool(
		"set_particle_collision_spheres",
		{
			title: "Set particle collision spheres",
			description:
				"Replace up to eight CPU or native GPU particle collision spheres. GPU systems execute projection and restitution in the WebGL2 transform-feedback or WebGPU compute update shader without CPU particle readback.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional(), spheres: collisionSpheres }),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_particle_collision_spheres", args)
	);
	const gpuParticleInteractionReference = {
		particleSystemId: z.string().optional(),
		particleSystemName: z.string().optional(),
	};
	server.registerTool(
		"get_gpu_particle_interactions",
		{
			title: "Get native GPU particle interactions",
			description:
				"Read bounded GPU-particle collision settings plus exact backend, support, shader, compilation, dispatch, workload, and WebGL2 occupancy-field evidence. WebGPU uses direct storage-buffer pairs; WebGL2 uses a GPU-only 3D occupancy raster without CPU readback.",
			inputSchema: z.object(gpuParticleInteractionReference).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gpu_particle_interactions", args)
	);
	server.registerTool(
		"set_gpu_particle_interactions",
		{
			title: "Set native GPU particle interactions",
			description:
				"Configure bounded native GPU particle collisions without CPU readback. WebGPU directly reads prior particle storage; WebGL2 rasterizes a GPU-only 3D occupancy field inside boundsMin/boundsMax at gridResolution 4..64 and samples a 3x3x3 voxel stencil. Radius is in centimeters; restitution and separationStrength are 0..1. At most 4096 particles and 64 accepted neighbors are processed.",
			inputSchema: z
				.object({
					...gpuParticleInteractionReference,
					enabled: z.boolean().optional(),
					radius: z.number().positive().max(100000).optional(),
					restitution: z.number().min(0).max(1).optional(),
					separationStrength: z.number().min(0).max(1).optional(),
					maximumParticles: z.number().int().min(2).max(4096).optional(),
					maximumNeighbors: z.number().int().min(1).max(64).optional(),
					boundsMin: z.array(z.number()).length(3).optional(),
					boundsMax: z.array(z.number()).length(3).optional(),
					gridResolution: z.number().int().min(4).max(64).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gpu_particle_interactions", args)
	);
	server.registerTool(
		"get_gpu_particle_collision_events",
		{
			title: "Get native GPU collision events",
			description:
				"Read collision-triggered secondary-particle output settings and exact native backend, shader, dispatch, reserved-capacity, WebGL2 event-texture, capture, latency, and no-readback evidence for one GPU particle system.",
			inputSchema: z.object(gpuParticleInteractionReference).strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gpu_particle_collision_events", args)
	);
	server.registerTool(
		"set_gpu_particle_collision_events",
		{
			title: "Set native GPU collision events",
			description:
				"Configure GPU-only secondary particles spawned by native plane/sphere collisions in the same GPU system. Reserve 1..2048 source particles and 1..4 outputs per source (4096 total maximum), then set event lifetime, speed, size, velocity inheritance, spread, and RGBA. WebGPU reads the prior storage buffer; WebGL2 transports collision position/direction through two float event textures. No particle data is read back to the CPU. Configure a collision plane or sphere first.",
			inputSchema: z
				.object({
					...gpuParticleInteractionReference,
					enabled: z.boolean().optional(),
					maximumSourceParticles: z.number().int().min(1).max(2048).optional(),
					spawnCount: z.number().int().min(1).max(4).optional(),
					lifetime: z.number().min(0.001).max(3600).optional(),
					speed: z.number().min(0).max(100000).optional(),
					size: z.number().min(0.0001).max(100000).optional(),
					inheritVelocity: z.number().min(0).max(1).optional(),
					spread: z.number().min(0).max(1).optional(),
					color: z.array(z.number().min(0).max(1)).length(4).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gpu_particle_collision_events", args)
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
		"list_vfx_graph_templates",
		{
			title: "Search VFX Graph templates",
			description:
				"Search and category-filter the deterministic portable Babylon Node Particle template catalog. Use the exact catalogRevision returned here when creating a .npss VFX Graph asset.",
			inputSchema: z
				.object({
					query: z.string().max(256).optional(),
					category: z.enum(["Starter", "Environment", "Impact"]).optional(),
					offset: z.number().int().min(0).max(10000).optional(),
					limit: z.number().int().min(1).max(50).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_vfx_graph_templates", args)
	);

	server.registerTool(
		"create_vfx_graph_from_template",
		{
			title: "Create VFX Graph from template",
			description:
				"Compile-check and persist one real .npss Babylon Node Particle asset from a searched VFX template under its exact catalog revision. The asset remains editable in the normal Node Particle editor.",
			inputSchema: z
				.object({
					templateId: z.string().min(1).max(128),
					expectedCatalogRevision: z.string().regex(/^[a-f0-9]{64}$/),
					name: z.string().min(1).max(128).optional(),
					folder: z.string().min(1).max(1024).optional().describe("Project-relative output folder; defaults to assets."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_vfx_graph_from_template", args)
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

	const nodeParticleReference = z.object({ nodeId: z.string().min(1).max(256).optional(), nodeName: z.string().min(1).max(256).optional() }).strict();
	server.registerTool(
		"get_node_particle_batch_release",
		{
			title: "Get VFX batch-release lifecycle",
			description:
				"Read one Node Particle mesh's release-on-disable policy, exact state revision, live batch allocation, release/rebuild counts, and explicit Unity compatibility boundary.",
			inputSchema: nodeParticleReference,
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_particle_batch_release", args)
	);

	server.registerTool(
		"set_node_particle_batch_release",
		{
			title: "Set VFX batch release on disable",
			description:
				"Under the exact inspected lifecycle revision, opt one Node Particle mesh into or out of releasing its live particle-system batch when disabled. Re-enabling rebuilds from its retained graph; a failed change rolls the policy back.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(256).optional(),
					nodeName: z.string().min(1).max(256).optional(),
					expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
					releaseOnDisable: z.boolean(),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_particle_batch_release", args)
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
				type: z
					.enum(["standard", "gpu", "node"])
					.optional()
					.describe("When creating a default system, choose CPU standard (default), GPU particles, or a Node Particle VFX graph."),
				name: z.string().optional().describe("Name for the created particle system."),
				emitterNodeId: z.string().optional().describe("Id of the node to use as the emitter."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters when no emitter node is set."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_particle_system", args)
	);

	server.registerTool(
		"delete_particle_system",
		{
			title: "Delete particle system",
			description:
				"Dispose one native CPU or GPU particle system and remove its persisted events, collision volumes, GPU collision-event output, pairwise GPU interactions, vector fields, texture fields, and incoming proximity-event references. The emitter node is retained and can be deleted separately.",
			inputSchema: z.object({ particleSystemId: z.string().optional(), particleSystemName: z.string().optional() }),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_particle_system", args)
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
		"get_node_particle_code_graph",
		{
			title: "Get visual VFX Graph",
			description:
				"Read a bounded paginated Node Particle graph for the Inspector canvas: exact block ids, classes, typed ports, embedded values, reachability to SystemBlocks, edges, and a canonical fingerprint. Prefer numeric block ids when names are duplicated.",
			inputSchema: z
				.object({
					nodeId: z.string().optional(),
					nodeName: z.string().optional(),
					query: z.string().max(256).optional(),
					offset: z.number().int().min(0).optional(),
					limit: z.number().int().min(1).max(256).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_node_particle_code_graph", args)
	);

	server.registerTool(
		"connect_node_particle_blocks",
		{
			title: "Connect VFX Graph blocks",
			description:
				"Connect exact typed Node Particle ports with compatibility, hierarchy/cycle, and occupied-input validation. The complete candidate graph is rebuilt first; the live particle set changes only after a successful build.",
			inputSchema: z
				.object({
					nodeId: z.string().optional(),
					nodeName: z.string().optional(),
					sourceBlockId: z.number().int().positive().optional(),
					sourceBlockName: z.string().min(1).optional(),
					sourceOutput: z.string().min(1),
					targetBlockId: z.number().int().positive().optional(),
					targetBlockName: z.string().min(1).optional(),
					targetInput: z.string().min(1),
					replace: z.boolean().optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("connect_node_particle_blocks", args)
	);

	server.registerTool(
		"disconnect_node_particle_blocks",
		{
			title: "Disconnect VFX Graph blocks",
			description:
				"Disconnect one exact Node Particle target input. Optional source block/output fields are stale guards. The live particle set changes only after the resulting complete graph rebuilds successfully.",
			inputSchema: z
				.object({
					nodeId: z.string().optional(),
					nodeName: z.string().optional(),
					targetBlockId: z.number().int().positive().optional(),
					targetBlockName: z.string().min(1).optional(),
					targetInput: z.string().min(1),
					sourceBlockId: z.number().int().positive().optional(),
					sourceBlockName: z.string().min(1).optional(),
					sourceOutput: z.string().min(1).optional(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("disconnect_node_particle_blocks", args)
	);

	server.registerTool(
		"set_node_particle_block_input",
		{
			title: "Set VFX Graph block input",
			description:
				"Set one disconnected embedded Node Particle input value by exact block id/name and port. Connected inputs reject until disconnected. The graph is atomically rebuilt before publication.",
			inputSchema: z
				.object({
					nodeId: z.string().optional(),
					nodeName: z.string().optional(),
					blockId: z.number().int().positive().optional(),
					blockName: z.string().min(1).optional(),
					input: z.string().min(1),
					value: z.any(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_node_particle_block_input", args)
	);

	server.registerTool(
		"validate_node_particle_code_graph",
		{
			title: "Validate VFX Graph",
			description:
				"Build an isolated clone of a Node Particle graph and report exact compiler/runtime errors, disconnected required inputs, unreachable blocks, block/edge/SystemBlock counts, built system count, and fingerprint without changing the active effect.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_node_particle_code_graph", args)
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
			description:
				"Start or stop a standard or GPU particle system in the editor preview. When starting, optional bounded simulationSteps waits for render readiness and runs 1–120 update-only steps for deterministic external verification; set manualEmitCount first when particles must be emitted immediately.",
			inputSchema: z.object({
				particleSystemId: z.string().optional(),
				particleSystemName: z.string().optional(),
				playing: z.boolean(),
				simulationSteps: z.number().int().min(1).max(120).optional(),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
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
			description:
				"Read persistent image-sampled 2D or depth-stacked 3D XYZ vector fields for a CPU or GPU particle system. GPU responses include exact native WebGPU/WebGL2 3D-atlas, compile, dispatch, sampling-bound, and no-readback evidence.",
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
				"Import one image (2D) or ordered image slices (3D) as a capped 1–64 voxel CPU/GPU particle vector field. RGB maps to signed XYZ direction (-1 to +1); the portable grid is embedded in scene metadata. GPU systems atomically upload enabled fields into one bounded native RGBA8 3D atlas sampled by WebGPU compute or WebGL2 transform feedback without readback.",
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
				"Atomically replace all persistent 2D or depth-stacked 3D image-sampled CPU/GPU particle vector-field grids. GPU resources are built before publication and rolled back on failure. Prefer create_particle_texture_vector_field for normal image importing.",
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
							vectors: z.array(z.number().finite()).max(64 * 64 * 64 * 3),
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
