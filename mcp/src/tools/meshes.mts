import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerMeshTools(server: McpServer): void {
	server.registerTool(
		"create_primitive_mesh",
		{
			title: "Create primitive mesh",
			description:
				"Create a built-in primitive mesh (box, sphere, ground, plane, cylinder, capsule, torus, torusknot, skybox) or an `empty` transform node used for grouping. " +
				"Returns the created node summary including its `id`, which you can pass to other tools (set material, set transform, create instances from it, etc.). " +
				"Positions are in centimeters. Pass `options` to shape the primitive (e.g. `{ size }` for a box, `{ diameter }` for a sphere, `{ width, height, subdivisions }` for a ground). " +
				"For a ground with HEIGHT VARIATIONS / terrain, create it with enough `subdivisions` then displace its vertices with an agent script (`write_agent_script` + `run_agent_script`) or apply a heightmap — a flat `ground` cannot be made hilly with `set_node_transform` alone. " +
				"To build a scene, chain `create_primitive_mesh` calls (or `instantiate_mesh_asset`), then assign materials, then verify with `get_screenshot`.",
			inputSchema: z.object({
				type: z.enum(["box", "sphere", "ground", "plane", "cylinder", "capsule", "torus", "torusknot", "skybox", "empty"]).describe("The primitive type to create."),
				name: z.string().optional().describe("Name for the new mesh. A default is used if omitted."),
				parentId: z.string().optional().describe("Id of the parent node. Omit to add at the scene root."),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters."),
				options: z
					.record(z.string(), z.any())
					.optional()
					.describe("Babylon MeshBuilder options for the chosen type (e.g. `{ size, diameter, width, height, subdivisions }`)."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_primitive_mesh", args)
	);

	server.registerTool(
		"get_mesh_geometry",
		{
			title: "Get mesh geometry",
			description: "Get the editor's editable primitive-geometry parameters for a Mesh, including ground terrain metadata when applicable.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target Mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target Mesh."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_geometry", args)
	);

	server.registerTool(
		"set_mesh_geometry",
		{
			title: "Set mesh geometry",
			description:
				"Update and rebuild an editor primitive's geometry. Supply only parameters supported by its type: Box (`width`, `height`, `depth`), Plane (`size`), Sphere (`diameter`, `segments`), Ground (`width`, `height`, `subdivisions`), Capsule, Cylinder, Torus, or TorusKnot. Use `set_ground_heightmap` for heightmapped terrain.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target Mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target Mesh."),
				parameters: z.record(z.string(), z.any()).describe("Geometry parameters to update."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_geometry", args)
	);

	server.registerTool(
		"get_mesh_vertex_data",
		{
			title: "Get editable mesh data",
			description: "Get a mesh's positions, normals, UVs, and triangle indices for ProBuilder-style vertex/face editing.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_vertex_data", args)
	);
	server.registerTool(
		"set_mesh_vertex_data",
		{
			title: "Set editable mesh data",
			description: "Replace selected mesh vertex/index buffers. Omit normals to recompute them. This is the base operation for custom vertex, edge, and face editing.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				positions: z.array(z.number()).optional(),
				normals: z.array(z.number()).optional(),
				uvs: z.array(z.number()).optional(),
				indices: z.array(z.number().int()).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_vertex_data", args)
	);
	server.registerTool(
		"get_mesh_topology",
		{
			title: "Get mesh component topology",
			description: "Get vertex count, triangle-face count, and stable unique-edge pairs for ProBuilder-style component selection.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_topology", args)
	);
	server.registerTool(
		"get_mesh_selection",
		{
			title: "Get mesh component selection",
			description: "Read the persisted vertex, unique-edge, or triangle-face selection for one mesh.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_selection", args)
	);
	server.registerTool(
		"set_mesh_selection",
		{
			title: "Set mesh component selection",
			description: "Persist a validated ProBuilder-style vertex, unique-edge, or triangle-face selection. Use get_mesh_topology first for valid component identifiers.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				mode: z.enum(["vertex", "edge", "face"]),
				indices: z.array(z.number().int().nonnegative()),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_selection", args)
	);
	server.registerTool(
		"weld_mesh_vertices",
		{
			title: "Weld mesh vertices",
			description: "Merge coincident mesh vertices within a local-space tolerance.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), tolerance: z.number().positive().optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("weld_mesh_vertices", args)
	);
	server.registerTool(
		"flip_mesh_normals",
		{
			title: "Flip mesh normals",
			description: "Reverse triangle winding and normals for a mesh.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("flip_mesh_normals", args)
	);
	server.registerTool(
		"extrude_mesh_faces",
		{
			title: "Extrude mesh faces",
			description:
				"ProBuilder-style local mesh operation: extrude selected triangle faces, retaining neighboring faces and creating side walls. Get triangle indices from get_mesh_vertex_data; a box face usually consists of two triangles.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				faceIndices: z.array(z.number().int().nonnegative()).min(1),
				distance: z.number().positive(),
				direction: z.array(z.number()).length(3).optional().describe("Optional explicit local extrusion direction. Omit to use the average selected-face normal."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("extrude_mesh_faces", args)
	);
	server.registerTool(
		"inset_mesh_faces",
		{
			title: "Inset mesh faces",
			description:
				"ProBuilder-style local face inset. Replaces selected triangle faces with an outer boundary ring and inner cap; optional depth recesses the cap along its averaged normal.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				faceIndices: z.array(z.number().int().nonnegative()).min(1),
				amount: z.number().positive().max(0.999999),
				depth: z.number().nonnegative().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("inset_mesh_faces", args)
	);
	server.registerTool(
		"boolean_mesh",
		{
			title: "Boolean mesh operation",
			description:
				"Perform native Babylon CSG union, subtraction, or intersection on two mesh nodes. Returns a new editable result mesh; source meshes are retained unless disposeSources is explicitly true.",
			inputSchema: z.object({
				primaryNodeId: z.string().optional(),
				primaryNodeName: z.string().optional(),
				secondaryNodeId: z.string().optional(),
				secondaryNodeName: z.string().optional(),
				operation: z.enum(["union", "subtract", "intersect"]),
				name: z.string().optional(),
				disposeSources: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("boolean_mesh", args)
	);
	server.registerTool(
		"bridge_mesh_edges",
		{
			title: "Bridge mesh edges",
			description:
				"ProBuilder-style topology operation: connect two disjoint local mesh edges with a quad (two triangles). Inspect vertex indices with get_mesh_vertex_data first.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				firstEdge: z.array(z.number().int().nonnegative()).length(2),
				secondEdge: z.array(z.number().int().nonnegative()).length(2),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("bridge_mesh_edges", args)
	);
	server.registerTool(
		"bevel_mesh_edges",
		{
			title: "Bevel mesh edges",
			description:
				"ProBuilder-style multi-edge chamfer. Bevels selected disjoint manifold unique edges from one topology snapshot; edges cannot share endpoints. Get stable edge indices from get_mesh_topology.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				edgeIndices: z.array(z.number().int().nonnegative()).min(1),
				amount: z.number().positive().max(0.999999),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bevel_mesh_edges", args)
	);
	server.registerTool(
		"bevel_mesh_edge",
		{
			title: "Bevel mesh edge",
			description:
				"ProBuilder-style topology operation: chamfer one manifold unique edge shared by exactly two triangles. Get a stable edgeIndex from get_mesh_topology; amount is the local fraction moved from the edge endpoints toward each incident face's third vertex.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				edgeIndex: z.number().int().nonnegative(),
				amount: z.number().positive().max(0.999999),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bevel_mesh_edge", args)
	);
	server.registerTool(
		"unwrap_mesh_uvs",
		{
			title: "Auto unwrap mesh UVs",
			description:
				"Create a deterministic non-overlapping UV atlas by splitting each triangle into a padded chart. This duplicates shared vertices so arbitrary topology receives safe independent UVs.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), padding: z.number().min(0).max(0.499999).optional() }),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("unwrap_mesh_uvs", args)
	);
	server.registerTool(
		"set_mesh_uv_projection",
		{
			title: "Set planar mesh UV projection",
			description:
				"Generate UVs by projecting local mesh coordinates onto the XY, XZ, or YZ plane. This is useful for ProBuilder-style quick texture mapping and CSG meshes without authored UVs.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				plane: z.enum(["xy", "xz", "yz"]).optional(),
				scale: z.number().positive().optional(),
				offset: z.array(z.number()).length(2).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_uv_projection", args)
	);
	server.registerTool(
		"subdivide_mesh",
		{
			title: "Subdivide mesh",
			description:
				"ProBuilder-style topology operation: split every triangle into four using shared edge midpoints. Positions and UVs are interpolated, normals are recomputed, and the editable mesh is updated in place. Use one level for routine modeling; higher levels grow geometry quickly.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Target Mesh id."),
				nodeName: z.string().optional().describe("Target Mesh name."),
				levels: z.number().int().min(1).max(3).optional().describe("Subdivision passes. Defaults to 1; every pass quadruples triangle count."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("subdivide_mesh", args)
	);

	server.registerTool(
		"set_ground_heightmap",
		{
			title: "Set ground heightmap",
			description:
				"Create or clear terrain on an editor Ground mesh from a project-relative image heightmap. Height values and dimensions use editor centimeters. Set `heightmapPath` to null to restore a flat ground.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the Ground mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the Ground mesh."),
				heightmapPath: z.string().nullable().describe("Project-relative image path, or null to remove the heightmap."),
				minHeight: z.number().optional().describe("Minimum terrain height in centimeters."),
				maxHeight: z.number().optional().describe("Maximum terrain height in centimeters."),
				width: z.number().positive().optional().describe("Ground width in centimeters."),
				height: z.number().positive().optional().describe("Ground depth in centimeters."),
				subdivisions: z.number().int().min(2).optional().describe("Ground grid subdivisions."),
				alphaFilter: z.number().min(0).max(255).optional().describe("Heightmap alpha cutoff."),
				colorFilter: z.array(z.number().min(0).max(1)).length(3).optional().describe("RGB heightmap multiplier."),
				smoothFactor: z.number().int().min(0).max(32).optional().describe("Number of terrain smoothing passes."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_ground_heightmap", args)
	);

	server.registerTool(
		"get_terrain",
		{
			title: "Get terrain",
			description: "Get an editor Ground terrain's persisted grid configuration, heightmap source, current height range, and vertex count.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_terrain", args)
	);

	server.registerTool(
		"sculpt_terrain",
		{
			title: "Sculpt terrain",
			description:
				"Apply one deterministic circular terrain brush in local Ground coordinates. `raise` and `lower` strength is centimeters per application; `flatten` and `smooth` strength is a 0–1 blend. This changes the persisted terrain geometry.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				mode: z.enum(["raise", "lower", "flatten", "smooth"]).default("raise"),
				center: z.array(z.number()).length(2).describe("Terrain-local brush centre `[x, z]` in centimeters."),
				radius: z.number().positive().describe("Brush radius in centimeters."),
				strength: z.number().nonnegative().describe("Brush strength. See tool description for units by mode."),
				targetHeight: z.number().optional().describe("Required target local height in centimeters for flatten mode."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("sculpt_terrain", args)
	);

	server.registerTool(
		"carve_terrain_hole",
		{
			title: "Carve terrain hole",
			description: "Remove triangles inside a circular local-space terrain brush. The hole is persisted with the Ground and exported in scene geometry.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional(), center: z.array(z.number()).length(2), radius: z.number().positive() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("carve_terrain_hole", args)
	);

	server.registerTool(
		"list_terrain_streaming_groups",
		{
			title: "List terrain streaming groups",
			description: "List persisted distance-based Ground tile streaming groups.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_terrain_streaming_groups")
	);
	server.registerTool(
		"set_terrain_streaming_group",
		{
			title: "Set terrain streaming group",
			description:
				"Create or update a distance-activated set of Ground terrain tiles. Tiles outside range are disabled in preview and exported runtime; set `releaseGeometry:true` to release off-range vertex/index buffers and rebuild them before a tile is re-enabled. Distance is centimeters.",
			inputSchema: z.object({
				groupId: z.string().optional(),
				name: z.string().optional(),
				terrainIds: z.array(z.string()).min(1),
				distance: z.number().positive(),
				targetNodeId: z.string().optional(),
				enabled: z.boolean().optional(),
				releaseGeometry: z
					.boolean()
					.optional()
					.describe("Release vertex/index buffers while an off-range tile is disabled. This reconstructs already-loaded geometry; it does not fetch remote assets."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("set_terrain_streaming_group", args)
	);
	server.registerTool(
		"delete_terrain_streaming_group",
		{
			title: "Delete terrain streaming group",
			description: "Delete a terrain streaming group and re-enable its tiles.",
			inputSchema: z.object({ groupId: z.string().optional(), name: z.string().optional() }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_terrain_streaming_group", args)
	);
	server.registerTool(
		"paint_terrain_details",
		{
			title: "Paint terrain details",
			description:
				"Paint a circular Unity-style terrain detail layer as GPU-efficient mesh instances. Density is instances per square meter. Repainting a layer replaces only instances inside its brush, keeping surrounding strokes editable.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Ground terrain id."),
				nodeName: z.string().optional().describe("Ground terrain name."),
				sourceNodeId: z.string().optional().describe("Source mesh id to instance as a detail."),
				sourceNodeName: z.string().optional().describe("Source mesh name to instance as a detail."),
				center: z.array(z.number()).length(2).describe("Terrain-local brush centre [x, z] in centimeters."),
				radius: z.number().positive().describe("Brush radius in centimeters."),
				density: z.number().nonnegative().describe("Instances per square meter."),
				layerId: z.string().optional().describe("Persistent detail-layer id; defaults to the source mesh."),
				seed: z.number().int().optional(),
				minScale: z.number().positive().optional(),
				maxScale: z.number().positive().optional(),
				name: z.string().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("paint_terrain_details", args)
	);
	server.registerTool(
		"scatter_terrain_instances",
		{
			title: "Scatter terrain instances",
			description:
				"Scatter deterministic GPU-efficient instances (for example trees, rocks, or grass clumps) across a Ground terrain. Existing instances in the same scatter group are replaced by default.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Ground terrain id."),
				nodeName: z.string().optional().describe("Ground terrain name."),
				sourceNodeId: z.string().optional().describe("Source mesh id to instance."),
				sourceNodeName: z.string().optional().describe("Source mesh name to instance."),
				count: z.number().int().min(1).max(10000).optional(),
				seed: z.number().int().optional().describe("Deterministic placement seed."),
				minScale: z.number().positive().optional(),
				maxScale: z.number().positive().optional(),
				margin: z.number().nonnegative().optional().describe("Terrain-edge exclusion margin in centimeters."),
				scatterId: z.string().optional().describe("Named scatter group; use the same value to replace it."),
				name: z.string().optional().describe("Generated instance name prefix."),
				replaceExisting: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("scatter_terrain_instances", args)
	);

	server.registerTool(
		"create_instance",
		{
			title: "Create instanced mesh(es)",
			description:
				"Create one or more InstancedMesh objects from an existing source mesh. PREFER THIS over cloning whenever many copies share the same geometry AND material (e.g. 100 trees, a field of grass, repeated walls): instances are far cheaper than clones. " +
				"Provide either `count` (to create N instances) and/or `transforms` (per-instance position/rotation/scaling in centimeters/radians). " +
				"By default each instance shares the SAME PARENT as the source mesh, keeping the scene hierarchy easy to read; pass `parentId` only to override this. " +
				"Tip: call `get_mesh_bounding_info` on the source first to know its size so you can scatter instances without overlap (e.g. spacing trees in a forest). This tool already creates many instances in one call; for very large scenes also batch multiple `create_instance` calls via `execute_batch`. " +
				"Instances always share the source mesh's material; if some copies need a DIFFERENT material, use `clone_mesh` for those variants instead and create instances from each clone.",
			inputSchema: z.object({
				sourceNodeId: z.string().optional().describe("Id of the source mesh to instance (preferred)."),
				sourceNodeName: z.string().optional().describe("Name of the source mesh to instance."),
				name: z.string().optional().describe("Base name for the created instances."),
				count: z.number().optional().describe("Number of instances to create. Per-instance transforms can be supplied via `transforms`."),
				parentId: z.string().optional().describe("Id of the parent node for the instances. Omit to share the source mesh's parent (recommended)."),
				transforms: z
					.array(
						z.object({
							position: z.array(z.number()).length(3).optional().describe("Position `[x,y,z]` in centimeters."),
							rotation: z.array(z.number()).length(3).optional().describe("Euler rotation `[x,y,z]` in radians."),
							scaling: z.array(z.number()).length(3).optional().describe("Scaling `[x,y,z]`."),
						})
					)
					.optional()
					.describe("Per-instance transforms. The number of instances created matches this array when `count` is omitted."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_instance", args)
	);

	server.registerTool(
		"clone_mesh",
		{
			title: "Clone mesh",
			description:
				"Clone a mesh. Use this ONLY when a copy must have a DIFFERENT material than the source; otherwise prefer `create_instance` for performance. " +
				"Keep `cloneGeometry=false` (the default) so the clone shares the source geometry and only the material can diverge — this keeps memory low. " +
				"Typical pattern: clone once per material variant, then `create_instance` from each clone for the many copies of that variant.",
			inputSchema: z.object({
				sourceNodeId: z.string().optional().describe("Id of the source mesh to clone (preferred)."),
				sourceNodeName: z.string().optional().describe("Name of the source mesh to clone."),
				name: z.string().optional().describe("Name for the cloned mesh."),
				cloneGeometry: z.boolean().optional().describe("If true, duplicates the geometry too. Default false (share geometry, only material differs)."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("clone_mesh", args)
	);

	server.registerTool(
		"create_decal",
		{
			title: "Create decal",
			description: "Project a persisted decal mesh onto a source Mesh using an existing material. Positions and decal dimensions are in centimeters; angles are radians.",
			inputSchema: z.object({
				sourceNodeId: z.string().optional().describe("Id of the source Mesh (preferred)."),
				sourceNodeName: z.string().optional().describe("Name of the source Mesh."),
				materialId: z.string().describe("Id of the material to assign to the decal."),
				name: z.string().optional().describe("Name for the decal mesh."),
				position: z.array(z.number()).length(3).describe("Projection position `[x,y,z]` in centimeters."),
				normal: z.array(z.number()).length(3).optional().describe("Surface normal `[x,y,z]`."),
				size: z.array(z.number()).length(3).optional().describe("Decal size `[width,height,depth]` in centimeters."),
				angle: z.number().optional().describe("Decal rotation angle in radians."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_decal", args)
	);

	server.registerTool(
		"get_decal",
		{
			title: "Get decal",
			description: "Get persisted source, projection, size, angle, and material settings for an editor decal mesh.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the decal mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the decal mesh."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_decal", args)
	);

	server.registerTool(
		"set_decal",
		{
			title: "Set decal",
			description: "Update an editor decal's size, angle, and/or material, then regenerate its projection geometry.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the decal mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the decal mesh."),
				size: z.array(z.number()).length(3).optional().describe("Decal size `[width,height,depth]` in centimeters."),
				angle: z.number().optional().describe("Decal rotation angle in radians."),
				materialId: z.string().optional().describe("Replacement material id."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_decal", args)
	);

	server.registerTool(
		"list_skeletons",
		{
			title: "List skeletons",
			description: "List imported skeletons, their bones, bound meshes, animation ranges, and inspector settings.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_skeletons", {})
	);

	server.registerTool(
		"set_skeleton",
		{
			title: "Set skeleton",
			description: "Rename a skeleton, change its initial-skin-matrix setting, and create or delete animation ranges.",
			inputSchema: z.object({
				skeletonId: z.string().optional().describe("Id of the skeleton (preferred)."),
				skeletonName: z.string().optional().describe("Name of the skeleton."),
				name: z.string().optional().describe("New skeleton name."),
				needInitialSkinMatrix: z.boolean().optional().describe("Whether the skeleton needs an initial skin matrix."),
				createRanges: z
					.array(z.object({ name: z.string(), from: z.number(), to: z.number() }))
					.optional()
					.describe("Animation ranges to create."),
				deleteRangeNames: z.array(z.string()).optional().describe("Names of animation ranges to remove."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_skeleton", args)
	);

	server.registerTool(
		"get_mesh_morph_targets",
		{
			title: "Get mesh morph targets",
			description: "List the morph targets and current influences on a Mesh.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target Mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target Mesh."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_morph_targets", args)
	);

	server.registerTool(
		"set_mesh_morph_targets",
		{
			title: "Set mesh morph targets",
			description: "Set one or more mesh morph-target influences. Resolve targets by `index` (preferred) or by name. Influence is normally 0..1.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target Mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target Mesh."),
				targets: z.array(z.object({ index: z.number().int().min(0).optional(), name: z.string().optional(), influence: z.number() })).min(1),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_morph_targets", args)
	);

	server.registerTool(
		"get_mesh_lods",
		{
			title: "Get mesh LODs",
			description: "List a mesh's level-of-detail meshes, transition distances, and whether each LOD is included in exports.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the source mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the source mesh."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_lods", args)
	);

	server.registerTool(
		"set_mesh_lods",
		{
			title: "Set mesh LODs",
			description:
				"Replace a source mesh's complete LOD configuration. Each LOD must reference a different Mesh node and a non-negative distance in centimeters. LOD meshes are reset to origin with no parent, matching the editor inspector. Empty `lods` removes all LODs.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the source mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the source mesh."),
				lods: z.array(
					z.object({
						meshNodeId: z.string().optional().describe("Id of the LOD mesh (preferred)."),
						meshNodeName: z.string().optional().describe("Name of the LOD mesh."),
						distance: z.number().min(0).describe("Camera distance at which this LOD becomes active, in centimeters."),
						includedInExport: z.boolean().optional().describe("Whether to serialize this LOD with the project. Defaults to true."),
					})
				),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_lods", args)
	);

	server.registerTool(
		"get_mesh_collision",
		{
			title: "Get mesh collision",
			description: "Get a mesh's Babylon collision-check setting and its editor collision-mesh type, if one exists.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target mesh."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_collision", args)
	);

	server.registerTool(
		"set_mesh_collision",
		{
			title: "Set mesh collision",
			description:
				"Enable or remove the editor collision mesh for a Mesh. `cube`, `sphere`, and `capsule` create lightweight bounds-based colliders; `lod` creates a simplified mesh collider. `none` removes the collider and disables collision checks.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target mesh."),
				type: z.enum(["none", "cube", "sphere", "capsule", "lod"]).describe("Collision representation to configure."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_collision", args)
	);

	server.registerTool(
		"set_mesh_material",
		{
			title: "Set mesh material",
			description:
				"Assign an existing material to a mesh. Get material ids from `list_materials` or create one with `create_material`. " +
				"Remember: assigning a material to an instanced mesh affects all instances sharing it; clone the mesh first if a subset needs a different material.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target mesh."),
				materialId: z.string().describe("Id of the material to assign."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_material", args)
	);

	server.registerTool(
		"set_mesh_visibility",
		{
			title: "Set mesh visibility",
			description: "Toggle a mesh's visibility/enabled state or set its `visibility` factor (0..1 for transparency). Only the provided fields are changed.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target mesh."),
				isVisible: z.boolean().optional().describe("Whether the mesh is visible."),
				isEnabled: z.boolean().optional().describe("Whether the mesh (and its children) is enabled."),
				visibility: z.number().optional().describe("Visibility factor between 0 (transparent) and 1 (opaque)."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_visibility", args)
	);

	server.registerTool(
		"set_mesh_physics",
		{
			title: "Set mesh physics",
			description:
				"Give a mesh real gameplay physics with a Havok physics body, or update/remove it. Use this for gravity, falling/stacking objects, projectiles, vehicles, character bodies, etc. " +
				"Pass `enabled:false` to remove the body. `motionType`: `static` (immovable world geometry like ground/walls), `dynamic` (affected by gravity & forces), `animated` (moved by script/animation, pushes dynamic bodies). " +
				"`mass` only matters for dynamic bodies. `shapeType`: `box`/`sphere`/`capsule`/`cylinder` are cheap approximations; `mesh` is the exact (expensive) collision shape — use `box`/`capsule` for most gameplay, `mesh` only for static complex geometry. " +
				"`friction` and `restitution` (bounciness) are 0..1. Combine with scripts (see `create_script`/`attach_script`) to apply impulses and build gameplay.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target mesh."),
				enabled: z.boolean().optional().describe("Enable (create if missing) or remove the physics body. Defaults to true."),
				mass: z.number().optional().describe("Mass in kilograms (dynamic bodies only). Default 1 when the body is created."),
				motionType: z.enum(["static", "dynamic", "animated"]).optional().describe("Body motion type. Default static for newly created bodies unless set."),
				shapeType: z.enum(["box", "sphere", "capsule", "cylinder", "mesh"]).optional().describe("Collision shape. Defaults to a sensible shape inferred from the mesh."),
				friction: z.number().optional().describe("Surface friction, 0..1."),
				restitution: z.number().optional().describe("Bounciness, 0..1."),
				collisionGroup: z.number().int().nonnegative().optional().describe("Physics membership bitmask."),
				collisionMask: z.number().int().nonnegative().optional().describe("Physics collision-target bitmask."),
				collisionLayer: z.string().min(1).optional().describe("Named active-scene physics collision layer. Resolves its membership and collision mask."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_physics", args)
	);

	server.registerTool(
		"get_mesh_bounding_info",
		{
			title: "Get mesh bounding info",
			description:
				"Get a mesh's bounding box in local and world space (min, max, center, size in centimeters), plus the world-space bounds of its whole hierarchy (children included). " +
				"Essential for procedural placement: read a tree/rock's `world.size` to space instances without overlap when scattering a forest, align objects to the ground using `world.min`/`world.max`, or compute how many copies fit in an area.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target mesh (preferred)."),
				nodeName: z.string().optional().describe("Name of the target mesh."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_bounding_info", args)
	);
}
