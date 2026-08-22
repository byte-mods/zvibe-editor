import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const decalChannelsSchema = z
	.object({
		albedo: z.boolean().optional().describe("Project the material base color/base texture and common opacity mask."),
		normal: z.boolean().optional().describe("Project the material 2D normal/bump texture in projector tangent space, or a flat projector normal when no texture is assigned."),
		metallic: z.boolean().optional().describe("Project metallic and smoothness; a material reflectivity texture uses red=metallic and alpha=smoothness."),
		ambientOcclusion: z.boolean().optional().describe("Project ambient occlusion; a material ambient/AO texture uses its red channel."),
		emissive: z.boolean().optional().describe("Project the material emissive color/texture multiplied by emissiveIntensity."),
	})
	.strict();

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
				"ProBuilder-style atomic multi-edge bevel from one topology snapshot. Supports disjoint edges and adjacent manifold chains, mitered connected endpoints, and 1-8 quadratic rounded-profile segments. Every selected edge must be shared by exactly two triangles; get stable edge indices from get_mesh_topology.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				edgeIndices: z.array(z.number().int().nonnegative()).min(1).max(256),
				amount: z.number().positive().max(0.999999),
				segments: z.number().int().min(1).max(8).optional(),
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
				"ProBuilder-style topology operation: bevel one manifold unique edge shared by exactly two triangles with mitered endpoint caps and 1-8 quadratic rounded-profile segments. Get a stable edgeIndex from get_mesh_topology; amount is the local fraction cut into each incident triangle.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				edgeIndex: z.number().int().nonnegative(),
				amount: z.number().positive().max(0.999999),
				segments: z.number().int().min(1).max(8).optional(),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("bevel_mesh_edge", args)
	);
	server.registerTool(
		"loop_cut_mesh",
		{
			title: "Loop cut mesh",
			description:
				"Insert one to eight evenly spaced edge loops through the manifold logical quad strip crossing a selected raw topology edge. The editor reconstructs deterministic quads from triangles, crosses opposite edges through hard UV/normal seams, preserves every compatible vertex stream and submesh material range, selects the created loop edges, and rejects stale, branched, diagonal, degenerate, morph-target, or unsafe topology before mutation. Call get_mesh_topology immediately first and pass its exact topologyFingerprint.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Target editable Mesh id."),
				nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
				expectedTopologyFingerprint: z.string().min(1).describe("Exact topologyFingerprint returned by the latest get_mesh_topology call."),
				edgeIndex: z.number().int().nonnegative().describe("Stable raw unique-edge ID returned by get_mesh_topology."),
				cuts: z.number().int().min(1).max(8).optional().describe("Number of evenly spaced loops. Defaults to 1."),
				offset: z.number().min(-0.49).max(0.49).optional().describe("Signed interval offset applied to every cut. Defaults to 0."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("loop_cut_mesh", args)
	);
	server.registerTool(
		"detach_mesh_faces",
		{
			title: "Detach mesh faces",
			description:
				"Unity ProBuilder-style face detach under an exact topology lease. Detach 1-4096 selected triangle faces either to a transform-preserving new Game Object or to disconnected vertex/submesh ranges in the source object. Every complete vertex stream, hard seam, skin buffer, material range, and face winding is preserved; stale, complete-selection, morph-target, unsafe-stream, and invalid requests reject before mutation. Call get_mesh_topology immediately first and pass its topologyFingerprint.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Source editable Mesh id."),
				nodeName: z.string().optional().describe("Source editable Mesh name when its id is unavailable."),
				expectedTopologyFingerprint: z.string().min(1).describe("Exact topologyFingerprint returned by the latest get_mesh_topology call."),
				faceIndices: z.array(z.number().int().nonnegative()).min(1).max(4096).describe("Unique current triangle-face IDs returned by get_mesh_topology."),
				mode: z.enum(["gameObject", "submesh"]).describe("Create a separate Mesh Game Object or disconnected ranges in the source Mesh."),
				name: z.string().trim().min(1).max(128).optional().describe("Optional new Game Object name; valid only when mode is gameObject."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("detach_mesh_faces", args)
	);
	server.registerTool(
		"get_mesh_smoothing_groups",
		{
			title: "Get mesh smoothing groups",
			description:
				"Inspect Unity ProBuilder-style per-triangle smoothing groups, exact topology fingerprint/revision, hard/smooth counts, group summaries, last operation, and a bounded face page. Group 0 is hard; groups 1-24 average normals across coincident vertices while retaining all other vertex seams. Use the returned topologyFingerprint and revision for a mutation.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Target editable Mesh id."),
				nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
				group: z.number().int().min(0).max(24).optional().describe("Optional group filter; 0 returns hard faces."),
				offset: z.number().int().nonnegative().optional().describe("Zero-based offset in the filtered face list."),
				limit: z.number().int().min(1).max(256).optional().describe("Maximum face rows to return. Defaults to 128."),
				faceIndices: z.array(z.number().int().nonnegative()).max(256).optional().describe("Optional exact current face IDs; cannot be combined with group/paging fields."),
			}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_smoothing_groups", args)
	);
	server.registerTool(
		"set_mesh_smoothing_group",
		{
			title: "Set mesh smoothing group",
			description:
				"Assign 1-4096 unique current triangle faces to hard group 0 or smooth group 1-24 under the exact topology fingerprint and smoothing revision returned by get_mesh_smoothing_groups. The editor atomically splits/merges only required vertex records, averages normals across coincident same-group corners, orthonormalizes tangents, and preserves every other complete stream, submesh range, winding, UV layout, and face selection.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Target editable Mesh id."),
				nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
				expectedTopologyFingerprint: z.string().min(1).describe("Exact fingerprint returned by get_mesh_smoothing_groups."),
				expectedRevision: z.number().int().nonnegative().describe("Exact smoothing revision returned by get_mesh_smoothing_groups."),
				faceIndices: z.array(z.number().int().nonnegative()).min(1).max(4096).describe("Unique current triangle-face IDs to assign."),
				group: z.number().int().min(0).max(24).describe("Group 0 creates hard faces; groups 1-24 smooth coincident corners in the same group."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_smoothing_group", args)
	);
	server.registerTool(
		"auto_smooth_mesh_faces",
		{
			title: "Auto smooth mesh faces",
			description:
				"Generate isolated Unity ProBuilder-style smoothing groups for 1-4096 selected current triangle faces by joining manifold adjacent faces whose normal angle is at most angleThreshold. Requires the exact topology fingerprint and smoothing revision; available groups 1-24 are assigned deterministically without changing unselected faces, and the same stream-preserving normal/tangent rebuild as manual assignment runs atomically.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Target editable Mesh id."),
				nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
				expectedTopologyFingerprint: z.string().min(1).describe("Exact fingerprint returned by get_mesh_smoothing_groups."),
				expectedRevision: z.number().int().nonnegative().describe("Exact smoothing revision returned by get_mesh_smoothing_groups."),
				faceIndices: z.array(z.number().int().nonnegative()).min(1).max(4096).describe("Unique current triangle-face IDs to classify."),
				angleThreshold: z.number().min(0).max(180).describe("Maximum angle in degrees between adjacent face normals that may share a group."),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("auto_smooth_mesh_faces", args)
	);
	server.registerTool(
		"get_mesh_vertex_colors",
		{
			title: "Get mesh vertex colors",
			description:
				"Inspect Unity ProBuilder-style RGBA vertex colors without changing the mesh. Returns exact topology/color fingerprints and revision, stream/default-white state, channel bounds, unique/painted/selected counts, last operation, and a bounded raw-vertex page. Filter by current component selection or non-white values, or request up to 256 exact current raw vertex IDs. Use all three returned leases for painting.",
			inputSchema: z
				.object({
					nodeId: z.string().optional().describe("Target editable Mesh id."),
					nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
					vertexIndices: z
						.array(z.number().int().nonnegative())
						.min(1)
						.max(256)
						.optional()
						.describe("Optional unique exact raw vertex IDs; cannot be combined with filters or paging."),
					selectedOnly: z.boolean().optional().describe("Return only vertices reached by the current vertex, edge, or face component selection."),
					nonWhiteOnly: z.boolean().optional().describe("Return only vertices whose RGBA color differs from neutral white."),
					offset: z.number().int().nonnegative().optional().describe("Zero-based offset in the filtered vertex list."),
					limit: z.number().int().min(1).max(256).optional().describe("Maximum vertex rows to return. Defaults to 128."),
				})
				.superRefine((value, context) => {
					if (value.vertexIndices && (value.selectedOnly !== undefined || value.nonWhiteOnly !== undefined || value.offset !== undefined || value.limit !== undefined)) {
						context.addIssue({ code: "custom", message: "vertexIndices cannot be combined with filters or paging." });
					}
					if (value.vertexIndices && new Set(value.vertexIndices).size !== value.vertexIndices.length) {
						context.addIssue({ code: "custom", message: "vertexIndices must be unique." });
					}
				}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_vertex_colors", args)
	);
	server.registerTool(
		"paint_mesh_vertex_colors",
		{
			title: "Paint mesh vertex colors",
			description:
				"Paint 1-4096 exact raw vertices or triangle faces with bounded RGBA, replace/add/multiply blending, and opacity under exact topology, color, and revision leases from get_mesh_vertex_colors. Face painting isolates shared selected/unselected corners by default while duplicating every complete vertex stream, so color does not bleed into unselected faces. Existing RGB is upgraded to RGBA; selection, submeshes, smoothing/UV data, skinning, tangent handedness, vertex-alpha flags, and arbitrary streams are preserved atomically. Morph targets reject only when isolation would split vertices.",
			inputSchema: z
				.object({
					nodeId: z.string().optional().describe("Target editable Mesh id."),
					nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
					expectedTopologyFingerprint: z.string().min(1).describe("Exact topologyFingerprint returned by get_mesh_vertex_colors."),
					expectedColorFingerprint: z.string().min(1).describe("Exact colorFingerprint returned by get_mesh_vertex_colors."),
					expectedRevision: z.number().int().nonnegative().describe("Exact revision returned by get_mesh_vertex_colors."),
					targetMode: z.enum(["vertex", "face"]).describe("Paint raw vertices or triangle faces."),
					vertexIndices: z.array(z.number().int().nonnegative()).min(1).max(4096).optional().describe("Unique current raw vertex IDs; required only for vertex mode."),
					faceIndices: z.array(z.number().int().nonnegative()).min(1).max(4096).optional().describe("Unique current triangle-face IDs; required only for face mode."),
					color: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).describe("Linear RGBA target color."),
					blendMode: z.enum(["replace", "add", "multiply"]).optional().describe("Per-channel operation before opacity interpolation. Defaults to replace."),
					opacity: z.number().min(0).max(1).optional().describe("Interpolation strength from current to blended color. Defaults to 1."),
					splitFaceBoundaries: z.boolean().optional().describe("Face mode only. Defaults true to isolate selected corners from unselected faces."),
				})
				.superRefine((value, context) => {
					if (value.targetMode === "vertex" && (!value.vertexIndices || value.faceIndices || value.splitFaceBoundaries !== undefined)) {
						context.addIssue({ code: "custom", message: "Vertex mode requires only vertexIndices and does not accept splitFaceBoundaries." });
					}
					if (value.targetMode === "face" && (!value.faceIndices || value.vertexIndices)) {
						context.addIssue({ code: "custom", message: "Face mode requires only faceIndices." });
					}
					const indices = value.targetMode === "vertex" ? value.vertexIndices : value.faceIndices;
					if (indices && new Set(indices).size !== indices.length) {
						context.addIssue({ code: "custom", message: "Paint component IDs must be unique." });
					}
				}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("paint_mesh_vertex_colors", args)
	);
	server.registerTool(
		"get_mesh_pivot",
		{
			title: "Get mesh pivot",
			description:
				"Inspect one editable Mesh's Unity-style local/world pivot, exact pivot/topology lease, transform origin, raw geometry bounds-center candidate, and current component-selection average candidate. Use the returned pivotFingerprint immediately with set_mesh_pivot. Pivot candidates are derived from undeformed editable vertices and editor units are centimeters.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(128).optional().describe("Target editable Mesh id."),
					nodeName: z.string().min(1).max(128).optional().describe("Target editable Mesh name when its id is unavailable."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_pivot", args)
	);
	server.registerTool(
		"set_mesh_pivot",
		{
			title: "Set mesh pivot",
			description:
				"Relocate an editable Mesh pivot with Unity ProBuilder semantics under the exact lease from get_mesh_pivot. Choose an explicit world point, raw local bounds center, or the average of 1-4096 selected vertex/edge/face components. The operation changes only pivot/transform state and atomically verifies unchanged world matrix, every world vertex, descendants, and topology. Parented meshes plus quaternion and non-uniform/negative scaling are supported; frozen, billboard, infinite-distance, singular, invalid-topology, and arbitrary pre-transform states reject with no mutation.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(128).optional().describe("Target editable Mesh id."),
					nodeName: z.string().min(1).max(128).optional().describe("Target editable Mesh name when its id is unavailable."),
					expectedPivotFingerprint: z.string().min(1).max(128).describe("Exact pivotFingerprint returned by the latest get_mesh_pivot call."),
					mode: z.enum(["world", "boundsCenter", "selectionAverage"]).describe("How to derive the new pivot."),
					worldPosition: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]).optional().describe("Required only for world mode, in centimeters."),
					selectionMode: z.enum(["vertex", "edge", "face"]).optional().describe("Required only for selectionAverage mode."),
					componentIndices: z
						.array(z.number().int().nonnegative())
						.min(1)
						.max(4096)
						.optional()
						.describe("Unique current component IDs required only for selectionAverage mode."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.mode === "world" && (!value.worldPosition || value.selectionMode !== undefined || value.componentIndices !== undefined)) {
						context.addIssue({ code: "custom", message: "world mode requires only worldPosition." });
					}
					if (value.mode === "boundsCenter" && (value.worldPosition !== undefined || value.selectionMode !== undefined || value.componentIndices !== undefined)) {
						context.addIssue({ code: "custom", message: "boundsCenter mode does not accept target fields." });
					}
					if (value.mode === "selectionAverage" && (value.worldPosition !== undefined || !value.selectionMode || !value.componentIndices)) {
						context.addIssue({ code: "custom", message: "selectionAverage mode requires only selectionMode and componentIndices." });
					}
					if (value.componentIndices && new Set(value.componentIndices).size !== value.componentIndices.length) {
						context.addIssue({ code: "custom", message: "componentIndices must be unique." });
					}
				}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_pivot", args)
	);
	server.registerTool(
		"get_mesh_editable_source",
		{
			title: "Get mesh editable source",
			description:
				"Inspect one Mesh's canonical Unity ProBuilder-style editable source and its detached generated-runtime preview. Returns exact source fingerprint/revision and export-settings revision leases; complete stream, index, face, and submesh counts; current optimization policy; generated fingerprint/counts; removed unused or bit-identical vertices; portable-output blockers; persisted artifact evidence; and explicit source/generated ownership. The read does not mutate geometry or settings. Use all three returned leases immediately with set_mesh_export_geometry.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(128).optional().describe("Target editable Mesh id."),
					nodeName: z.string().min(1).max(128).optional().describe("Target editable Mesh name when its id is unavailable."),
				})
				.strict(),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_editable_source", args)
	);
	server.registerTool(
		"set_mesh_export_geometry",
		{
			title: "Set mesh export geometry",
			description:
				"Set whether runtime geometry is generated by preserving source records or by removing unused records and welding only complete bit-identical vertex records. Requires the exact source fingerprint/revision and export-settings revision returned by get_mesh_editable_source. The operation changes only the versioned export policy, rebuilds a detached preview, verifies the canonical live/project source is unchanged, and leaves editor-only topology metadata out of runtime output.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(128).optional().describe("Target editable Mesh id."),
					nodeName: z.string().min(1).max(128).optional().describe("Target editable Mesh name when its id is unavailable."),
					expectedSourceFingerprint: z.string().min(1).max(128).describe("Exact source.fingerprint returned by get_mesh_editable_source."),
					expectedSourceRevision: z.number().int().positive().describe("Exact source.revision returned by get_mesh_editable_source."),
					expectedExportSettingsRevision: z.number().int().positive().describe("Exact exportSettings.revision returned by get_mesh_editable_source."),
					optimize: z
						.boolean()
						.describe("True removes unused vertices and welds only complete bit-identical records in the generated artifact; false preserves source record layout."),
				})
				.strict(),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_export_geometry", args)
	);
	server.registerTool(
		"inspect_mesh_integrity",
		{
			title: "Inspect mesh integrity",
			description:
				"Inspect one editable triangle mesh without mutation using a bounded Unity ProBuilder-style repair report. Returns an exact all-stream/index/submesh integrity fingerprint; structural repairability; vertex/face/component, boundary, non-manifold, winding, unused, and weldable counts; category summaries; and a paginated issue list covering incomplete/non-finite streams, invalid indices/submeshes, zero-area and duplicate faces, unused or safely weldable vertices, boundary/non-manifold edges, winding, normals, and skin weights. Open boundaries and disconnected components remain informational because they can be intentional.",
			inputSchema: z
				.object({
					nodeId: z.string().optional().describe("Target editable Mesh id."),
					nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
					positionTolerance: z.number().positive().max(1).optional().describe("Local-space coincidence and zero-area tolerance. Defaults to 0.000001."),
					categories: z
						.array(
							z.enum([
								"positions",
								"indices",
								"streams",
								"degenerateFaces",
								"duplicateFaces",
								"unusedVertices",
								"weldableVertices",
								"nonManifoldEdges",
								"boundaryEdges",
								"winding",
								"components",
								"normals",
								"skinning",
								"subMeshes",
							])
						)
						.min(1)
						.max(14)
						.optional()
						.describe("Optional unique category filter for the issue page."),
					severity: z.enum(["error", "warning", "info"]).optional().describe("Optional severity filter for the issue page."),
					offset: z.number().int().nonnegative().optional().describe("Zero-based offset in the filtered issue list."),
					limit: z.number().int().min(1).max(256).optional().describe("Maximum issue rows to return. Defaults to 128."),
				})
				.superRefine((value, context) => {
					if (value.categories && new Set(value.categories).size !== value.categories.length) {
						context.addIssue({ code: "custom", message: "categories must be unique." });
					}
				}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_mesh_integrity", args)
	);
	server.registerTool(
		"repair_mesh_integrity",
		{
			title: "Repair mesh integrity",
			description:
				"Atomically apply an explicit bounded repair set under the exact integrityFingerprint from inspect_mesh_integrity. Supported operations remove invalid/trailing, zero-area, or duplicate faces; compact unused vertices; weld only coincident vertices whose complete non-position streams match; make manifold adjacency winding consistent; rebuild normals; normalize four/eight-influence skin weights; and rebuild contiguous material-preserving submesh runs. Every complete arbitrary stream is preserved and remapped together. Smoothing groups follow surviving face identity; stale UV/color metadata is invalidated only when topology changes. Morph targets, incomplete/non-finite streams, contradictory winding, ambiguous non-manifold ownership, stale leases, and all-face removal reject before publication. Requires confirm=true because faces may be deleted.",
			inputSchema: z
				.object({
					nodeId: z.string().optional().describe("Target editable Mesh id."),
					nodeName: z.string().optional().describe("Target editable Mesh name when its id is unavailable."),
					expectedIntegrityFingerprint: z.string().min(1).describe("Exact integrityFingerprint returned by inspect_mesh_integrity."),
					operations: z
						.array(
							z.enum([
								"removeInvalidFaces",
								"removeDegenerateFaces",
								"removeDuplicateFaces",
								"removeUnusedVertices",
								"weldIdenticalVertices",
								"fixWinding",
								"rebuildNormals",
								"normalizeSkinWeights",
								"rebuildSubMeshes",
							])
						)
						.min(1)
						.max(9)
						.describe("Unique explicit repair operations to run in one transaction."),
					positionTolerance: z.number().positive().max(1).optional().describe("Must match the intended inspection tolerance. Defaults to 0.000001."),
					confirm: z.literal(true).describe("Required acknowledgement that repair may delete invalid faces."),
				})
				.superRefine((value, context) => {
					if (new Set(value.operations).size !== value.operations.length) {
						context.addIssue({ code: "custom", message: "operations must be unique." });
					}
				}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("repair_mesh_integrity", args)
	);
	server.registerTool(
		"get_mesh_uv_layout",
		{
			title: "Get mesh UV layout",
			description:
				"Inspect persistent logical UV seams, exact layout revision/fingerprint, bounded chart summaries, UV bounds, surface area, and the last harmonic-relax/atlas-pack execution for one editable mesh.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				offset: z.number().int().nonnegative().optional(),
				limit: z.number().int().min(1).max(256).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_mesh_uv_layout", args)
	);
	server.registerTool(
		"set_mesh_uv_seams",
		{
			title: "Set mesh UV seams",
			description:
				"Atomically replace, add, or remove persistent logical UV seams under an exact layout revision. Edge IDs come from get_mesh_topology; coincident UV-split vertices resolve to the same logical edge, while mesh-boundary edges reject as redundant.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				expectedRevision: z.number().int().nonnegative(),
				mode: z.enum(["replace", "add", "remove"]).optional(),
				edgeIndices: z.array(z.number().int().nonnegative()).max(4096),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_mesh_uv_seams", args)
	);
	server.registerTool(
		"unwrap_mesh_uvs",
		{
			title: "Unwrap and pack mesh UV charts",
			description:
				"Under an exact layout revision, use persistent logical seams to extract UV charts, optionally open closed charts with deterministic auto seams, map chart boundaries harmonically, relax interiors, preserve equal surface texel density and every compatible vertex stream, split only required UV vertices, and deterministically pack optional 90-degree rotations into one atlas.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				expectedRevision: z.number().int().nonnegative(),
				padding: z.number().min(0).max(0.1).optional(),
				relaxIterations: z.number().int().min(0).max(100).optional(),
				relaxStrength: z.number().positive().max(1).optional(),
				allowRotation: z.boolean().optional(),
				autoSeams: z.boolean().optional(),
				normalizeTexelDensity: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
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
			description:
				"List versioned persisted Ground tile groups, exact revisions, embedded or asynchronous streamed-geometry settings, generated tile artifact manifests, current per-tile resident/queued/loading/loaded/error state, distances, attempts, fetched bytes, SHA-256 verification, timing, failures, and bounded limits. Use the returned revision for update or deletion.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_terrain_streaming_groups")
	);
	server.registerTool(
		"set_terrain_streaming_group",
		{
			title: "Set terrain streaming group",
			description:
				"Create or exact-revision update a bounded distance-activated Ground tile group. Embedded mode disables distant tiles and can snapshot/release resident buffers. `streamGeometry:true` makes direct export and CLI pack publish empty Mesh placeholders plus SHA-256/byte-count/binary-layout manifests; exported full/additive runtime asynchronously fetches only tiles inside `preloadDistance`, shows them inside `distance`, unloads them beyond `unloadDistance` after a delay, limits concurrency, retries with backoff, validates response size/hash, and supports an optional HTTPS CDN base. Distances are centimeters. Create requires name, terrainIds, and distance; update requires groupId and expectedRevision.",
			inputSchema: z
				.object({
					groupId: z.string().min(1).max(256).optional().describe("Existing group id for an update."),
					expectedRevision: z.number().int().positive().optional().describe("Exact current revision required for an update."),
					name: z.string().trim().min(1).max(128).optional(),
					terrainIds: z.array(z.string().min(1).max(256)).min(1).max(4096).optional().describe("Unique Ground Mesh ids; a tile can belong to only one group."),
					distance: z.number().finite().positive().max(1_000_000_000).optional().describe("Visibility distance in centimeters."),
					preloadDistance: z.number().finite().positive().max(1_000_000_000).optional().describe("Fetch radius; must be at least distance."),
					unloadDistance: z.number().finite().positive().max(1_000_000_000).optional().describe("Release radius; must be at least preloadDistance."),
					unloadDelayMs: z.number().int().min(0).max(600_000).optional(),
					maxConcurrentLoads: z.number().int().min(1).max(16).optional(),
					retryCount: z.number().int().min(0).max(8).optional(),
					requestTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
					remoteBaseUrl: z
						.string()
						.max(2_048)
						.nullable()
						.optional()
						.describe("Optional HTTPS CDN base; null uses the exported scene root. Loopback HTTP is allowed for development."),
					targetNodeId: z.string().min(1).max(256).nullable().optional(),
					enabled: z.boolean().optional(),
					releaseGeometry: z.boolean().optional().describe("Embedded-only resident buffer snapshot/release. Mutually exclusive with streamGeometry."),
					streamGeometry: z.boolean().optional().describe("Export hashed asynchronous geometry artifacts and leave empty runtime tile placeholders."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.groupId && value.expectedRevision === undefined) {
						context.addIssue({ code: "custom", message: "Updates require expectedRevision." });
					}
					if (!value.groupId && (value.expectedRevision !== undefined || !value.name || !value.terrainIds || value.distance === undefined)) {
						context.addIssue({ code: "custom", message: "Create requires name, terrainIds, and distance and does not accept expectedRevision." });
					}
					if (value.terrainIds && new Set(value.terrainIds).size !== value.terrainIds.length) {
						context.addIssue({ code: "custom", message: "terrainIds must be unique." });
					}
					if (value.distance !== undefined && value.preloadDistance !== undefined && value.preloadDistance < value.distance) {
						context.addIssue({ code: "custom", message: "preloadDistance must be at least distance." });
					}
					if (value.preloadDistance !== undefined && value.unloadDistance !== undefined && value.unloadDistance < value.preloadDistance) {
						context.addIssue({ code: "custom", message: "unloadDistance must be at least preloadDistance." });
					}
					if (value.streamGeometry && value.releaseGeometry) {
						context.addIssue({ code: "custom", message: "streamGeometry and releaseGeometry are mutually exclusive." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_terrain_streaming_group", args)
	);
	server.registerTool(
		"delete_terrain_streaming_group",
		{
			title: "Delete terrain streaming group",
			description: "Delete one terrain streaming group under its exact revision and restore all resident authoring tile geometry before removing the configuration.",
			inputSchema: z
				.object({
					groupId: z.string().min(1).max(256).optional(),
					name: z.string().trim().min(1).max(128).optional(),
					expectedRevision: z.number().int().positive(),
				})
				.strict()
				.superRefine((value, context) => {
					if (!!value.groupId === !!value.name) {
						context.addIssue({ code: "custom", message: "Provide exactly one of groupId or name." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
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
		"list_decals",
		{
			title: "List decals",
			description:
				"List persisted projected-geometry decals and Unity-style screen-space volume projectors with bounded pagination, exact authoring revisions, source/volume/material/channel summaries, and current deferred execution evidence. Returns `{ totalCount, count, offset, limit, hasMore, nextOffset, decals, deferredCameras }`.",
			inputSchema: z
				.object({
					search: z.string().trim().max(256).optional().describe("Optional case-insensitive decal name or id substring."),
					offset: z.number().int().min(0).max(1_000_000).default(0).describe("Zero-based result offset."),
					limit: z.number().int().min(1).max(100).default(50).describe("Maximum decals to return; 1–100."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_decals", args)
	);

	server.registerTool(
		"create_decal",
		{
			title: "Create decal",
			description:
				"Create either a versioned projected-geometry decal on one source Mesh or a Unity-style ordered screen-space volume projector. Volume projectors reconstruct world position and independently project albedo/opacity, projector-space normal, metallic/smoothness, ambient occlusion, and emissive material channels. `decalLayerMask` uses the editor's existing named 32-bit Rendering Layers: a deferred target mesh is affected when its native `layerMask` shares any bit. Positions/dimensions are centimeters and rotations/angles are radians. Returns the complete record plus exact deferred invalidation/readiness evidence.",
			inputSchema: z
				.object({
					projectionMode: z
						.enum(["geometry", "screen-space-volume"])
						.default("geometry")
						.describe("Geometry bakes clipped triangles onto one source; screen-space-volume projects through reconstructed deferred world position."),
					sourceNodeId: z.string().min(1).max(256).optional().describe("Id of the non-decal source Mesh (preferred)."),
					sourceNodeName: z.string().min(1).max(256).optional().describe("Name of the non-decal source Mesh."),
					materialId: z.string().min(1).max(256).describe("Id of the material to assign to the decal."),
					name: z.string().min(1).max(256).optional().describe("Name for the decal mesh."),
					position: z.array(z.number().finite()).length(3).describe("Projection position `[x,y,z]` in centimeters."),
					normal: z.array(z.number().finite()).length(3).optional().describe("Projection surface normal `[x,y,z]`; omit to derive it."),
					rotation: z.array(z.number().finite()).length(3).optional().describe("Screen-space projector Euler rotation `[x,y,z]` in radians."),
					size: z.array(z.number().finite().positive().max(10_000_000)).length(3).optional().describe("Positive decal size `[width,height,depth]` in centimeters."),
					angle: z.number().finite().optional().describe("Decal rotation angle in radians."),
					edgeFade: z.number().finite().min(0).max(1).optional().describe("Screen-space volume boundary fade as a 0..1 fraction of half extent."),
					uvScale: z.array(z.number().finite()).length(2).optional().describe("Screen-space projector UV scale `[x,y]`."),
					uvOffset: z.array(z.number().finite()).length(2).optional().describe("Screen-space projector UV offset `[x,y]`."),
					channels: decalChannelsSchema
						.optional()
						.describe("Screen-space projector channel enablement. Defaults to albedo only; at least one effective channel must be true."),
					normalStrength: z.number().finite().min(0).max(2).optional().describe("Projected normal XY strength in 0..2; default 1."),
					metallic: z.number().finite().min(0).max(1).optional().describe("Projected metallic scalar in 0..1, multiplied by reflectivity texture red; default 0."),
					smoothness: z
						.number()
						.finite()
						.min(0)
						.max(1)
						.optional()
						.describe("Projected smoothness scalar in 0..1, multiplied by reflectivity texture alpha; default 0.5."),
					ambientOcclusion: z.number().finite().min(0).max(1).optional().describe("Projected ambient-occlusion scalar in 0..1, multiplied by AO texture red; default 1."),
					emissiveIntensity: z.number().finite().min(0).max(16).optional().describe("Projected emissive multiplier in 0..16; default 1."),
					decalLayerMask: z.number().int().min(0).max(0xffffffff).optional().describe("Unsigned 32-bit Unity-style Decal Layer mask. Defaults to all bits (4294967295)."),
					alphaIndex: z.number().int().min(-1_000_000).max(1_000_000).optional().describe("Babylon transparent draw-order index; lower values draw first."),
					renderingGroupId: z.number().int().min(0).max(3).default(0).describe("Rendering group. Use 0 for deferred G-buffer execution; later groups remain forward."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.projectionMode === "geometry" && !value.sourceNodeId && !value.sourceNodeName) {
						context.addIssue({ code: "custom", message: "Geometry decals require sourceNodeId or sourceNodeName." });
					}
					if (value.projectionMode === "screen-space-volume" && (value.sourceNodeId || value.sourceNodeName || value.normal || value.angle !== undefined)) {
						context.addIssue({ code: "custom", message: "Screen-space volume projectors do not accept a source mesh, normal, or geometry angle." });
					}
					if (value.projectionMode === "screen-space-volume" && value.renderingGroupId !== 0) {
						context.addIssue({ code: "custom", message: "Screen-space volume projectors execute in deferred rendering group 0." });
					}
					const projectorFields = [
						value.rotation,
						value.edgeFade,
						value.uvScale,
						value.uvOffset,
						value.channels,
						value.normalStrength,
						value.metallic,
						value.smoothness,
						value.ambientOcclusion,
						value.emissiveIntensity,
						value.decalLayerMask,
					];
					if (value.projectionMode === "geometry" && projectorFields.some((field) => field !== undefined)) {
						context.addIssue({ code: "custom", message: "Geometry decals do not accept screen-space projector channel or Decal Layer fields." });
					}
					if (value.channels && !Object.values(value.channels).some(Boolean)) {
						context.addIssue({ code: "custom", message: "At least one projector channel must be true." });
					}
				}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_decal", args)
	);

	server.registerTool(
		"get_decal",
		{
			title: "Get decal",
			description:
				"Get one geometry decal or screen-space volume projector, including exact revision, oriented volume, material, five channel settings, Decal Layer mask, edge/UV controls, draw order, per-channel texture/readiness data, affected mesh count, and deferred execution/invalidation evidence. Use the returned revision as `expectedRevision` for safe updates.",
			inputSchema: z
				.object({
					nodeId: z.string().min(1).max(256).optional().describe("Id of the decal mesh (preferred)."),
					nodeName: z.string().min(1).max(256).optional().describe("Name of the decal mesh."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_decal", args)
	);

	server.registerTool(
		"set_decal",
		{
			title: "Set decal",
			description:
				"Atomically update a geometry decal or screen-space volume projector under its exact revision lease. Geometry edits regenerate source/position/normal/size/angle and reject empty replacement projections without mutation. Volume edits update oriented transform, material, five channel settings, Decal Layer mask, edge/UV controls, name, and order. `channels` merges with current settings and must leave at least one channel enabled. projectionMode is immutable. Returns the incremented record and exact deferred invalidation evidence; rebuild active deferred cameras after mutation.",
			inputSchema: z
				.object({
					projectionMode: z.enum(["geometry", "screen-space-volume"]).optional().describe("Optional assertion of the immutable current mode."),
					nodeId: z.string().min(1).max(256).optional().describe("Id of the decal mesh (preferred)."),
					nodeName: z.string().min(1).max(256).optional().describe("Name of the decal mesh."),
					expectedRevision: z.number().int().positive().optional().describe("Exact current decal revision returned by get_decal."),
					sourceNodeId: z.string().min(1).max(256).optional().describe("Replacement non-decal source Mesh id."),
					sourceNodeName: z.string().min(1).max(256).optional().describe("Replacement non-decal source Mesh name."),
					name: z.string().min(1).max(256).optional().describe("Replacement decal name."),
					position: z.array(z.number().finite()).length(3).optional().describe("Projection position `[x,y,z]` in centimeters."),
					normal: z.array(z.number().finite()).length(3).nullable().optional().describe("Projection normal `[x,y,z]`; null derives it from the source."),
					rotation: z.array(z.number().finite()).length(3).optional().describe("Screen-space projector Euler rotation `[x,y,z]` in radians."),
					size: z.array(z.number().finite().positive().max(10_000_000)).length(3).optional().describe("Positive decal size `[width,height,depth]` in centimeters."),
					angle: z.number().finite().optional().describe("Decal rotation angle in radians."),
					edgeFade: z.number().finite().min(0).max(1).optional().describe("Screen-space volume boundary fade in 0..1."),
					uvScale: z.array(z.number().finite()).length(2).optional().describe("Screen-space projector UV scale `[x,y]`."),
					uvOffset: z.array(z.number().finite()).length(2).optional().describe("Screen-space projector UV offset `[x,y]`."),
					channels: decalChannelsSchema.optional().describe("Partial screen-space projector channel update; omitted keys retain current values."),
					normalStrength: z.number().finite().min(0).max(2).optional().describe("Projected normal XY strength in 0..2."),
					metallic: z.number().finite().min(0).max(1).optional().describe("Projected metallic scalar in 0..1."),
					smoothness: z.number().finite().min(0).max(1).optional().describe("Projected smoothness scalar in 0..1."),
					ambientOcclusion: z.number().finite().min(0).max(1).optional().describe("Projected ambient-occlusion scalar in 0..1."),
					emissiveIntensity: z.number().finite().min(0).max(16).optional().describe("Projected emissive multiplier in 0..16."),
					decalLayerMask: z.number().int().min(0).max(0xffffffff).optional().describe("Unsigned 32-bit Decal Layer mask; overlaps target native Rendering Layers."),
					materialId: z.string().min(1).max(256).optional().describe("Replacement material id."),
					alphaIndex: z.number().int().min(-1_000_000).max(1_000_000).optional().describe("Transparent draw-order index."),
					renderingGroupId: z.number().int().min(0).max(3).optional().describe("Rendering group; use 0 for deferred execution."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
