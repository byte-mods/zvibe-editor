import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerRenderingTools(server: McpServer): void {
	const profileReference = z.object({ id: z.string().optional(), name: z.string().optional() });
	const profileConfigurations = z.record(z.enum(["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"]), z.any().nullable());

	server.registerTool(
		"list_rendering_profiles",
		{
			title: "List rendering profiles",
			description: "List persisted reusable camera rendering profiles.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_rendering_profiles", {})
	);
	server.registerTool(
		"create_rendering_profile",
		{
			title: "Create rendering profile",
			description:
				"Create a persisted reusable rendering profile. Omit configurations to snapshot the target camera's current post-processes; use null to explicitly disable a type when applying the profile.",
			inputSchema: z.object({
				name: z.string().min(1),
				nodeId: z.string().optional().describe("Camera to snapshot when configurations are omitted."),
				nodeName: z.string().optional().describe("Camera name to snapshot when configurations are omitted."),
				configurations: profileConfigurations.optional(),
			}),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_rendering_profile", args)
	);
	server.registerTool(
		"set_rendering_profile",
		{
			title: "Set rendering profile",
			description: "Rename or replace the configurations of a persisted reusable rendering profile.",
			inputSchema: profileReference.extend({ name: z.string().min(1).optional(), configurations: profileConfigurations.optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rendering_profile", args)
	);
	server.registerTool(
		"apply_rendering_profile",
		{
			title: "Apply rendering profile",
			description: "Apply every post-process setting in a saved rendering profile to a target camera and persist the resulting camera configuration for exported games.",
			inputSchema: profileReference.extend({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_rendering_profile", args)
	);
	server.registerTool(
		"delete_rendering_profile",
		{
			title: "Delete rendering profile",
			description: "Delete one persisted reusable rendering profile.",
			inputSchema: profileReference,
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_rendering_profile", args)
	);
	const volumeReference = z.object({ id: z.string().optional(), name: z.string().optional() });
	server.registerTool(
		"list_rendering_volumes",
		{
			title: "List rendering volumes",
			description: "List camera rendering volumes, including priority, edge blend distance, and global weight.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_rendering_volumes", {})
	);
	server.registerTool(
		"create_rendering_volume",
		{
			title: "Create rendering volume",
			description: "Create an axis-aligned 3D volume that blends its rendering profile by distance and weight. Overlapping volumes compose from low to high priority.",
			inputSchema: z.object({
				name: z.string().min(1),
				profileId: z.string(),
				center: z.array(z.number()).length(3).optional(),
				size: z.array(z.number().positive()).length(3).optional(),
				priority: z.number().optional(),
				blendDistance: z.number().nonnegative().optional().describe("World-space falloff distance outside the volume bounds. Defaults to 0 (hard edge)."),
				weight: z.number().min(0).max(1).optional().describe("Maximum influence of this volume. Defaults to 1."),
				enabled: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_rendering_volume", args)
	);
	server.registerTool(
		"set_rendering_volume",
		{
			title: "Set rendering volume",
			description: "Change a rendering volume's profile, bounds, priority, edge blend distance, weight, or enabled state.",
			inputSchema: volumeReference.extend({
				profileId: z.string().optional(),
				center: z.array(z.number()).length(3).optional(),
				size: z.array(z.number().positive()).length(3).optional(),
				priority: z.number().optional(),
				blendDistance: z.number().nonnegative().optional(),
				weight: z.number().min(0).max(1).optional(),
				enabled: z.boolean().optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_rendering_volume", args)
	);
	server.registerTool(
		"evaluate_rendering_volumes",
		{
			title: "Evaluate rendering volumes",
			description:
				"Evaluate and apply every enabled rendering volume influencing the active camera. Returns each contribution's blendFactor and the highest-priority volume in the legacy volume field.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("evaluate_rendering_volumes", {})
	);
	server.registerTool(
		"delete_rendering_volume",
		{ title: "Delete rendering volume", description: "Delete a volume without deleting its reusable rendering profile.", inputSchema: volumeReference },
		async (args): Promise<CallToolResult> => callTextTool("delete_rendering_volume", args)
	);

	const customPassReference = z.object({ id: z.string().optional(), name: z.string().optional() });
	const computeNodeType = z.enum([
		"global-id",
		"output-size",
		"constant-color",
		"constant-scalar",
		"uv-color",
		"texture-load",
		"uniform-color",
		"storage-load",
		"add",
		"subtract",
		"multiply",
		"divide",
		"minimum",
		"maximum",
		"lerp",
		"clamp",
		"abs",
		"sin",
		"cos",
		"normalize",
		"dot",
		"length",
		"select",
		"combine-vector",
		"split-component",
		"splat",
		"swizzle",
		"compare",
		"boolean-not",
		"boolean-and",
		"boolean-or",
		"branch",
		"storage-store",
		"output-store",
	]);
	const computeNode = z.object({
		id: z.string().min(1),
		type: computeNodeType,
		position: z.tuple([z.number(), z.number()]),
		value: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional().describe("RGBA value used by constant-color."),
		scalarValue: z.number().optional().describe("Finite scalar used by constant-scalar."),
		resourceName: z.string().min(1).optional().describe("Texture input, uniform-buffer binding, or storage-buffer binding used by resource nodes."),
		fieldName: z.string().min(1).optional().describe("vec4 uniform field used by uniform-color."),
		component: z.enum(["x", "y", "z", "w"]).optional().describe("Component selected by split-component."),
		swizzle: z
			.string()
			.regex(/^[xyzw]{4}$/)
			.optional()
			.describe("Exactly four xyzw selectors used by swizzle, for example wzyx or xxxx."),
		comparison: z.enum(["equal", "notEqual", "less", "lessEqual", "greater", "greaterEqual"]).optional().describe("Operation used by compare."),
	});
	const computeNodeValueType = z.enum(["f32", "vec3u", "vec2u", "vec4f", "vec4b"]);
	const computeSubgraphPort = z.object({ name: z.string().min(1), nodeId: z.string().min(1), port: z.string().min(1), type: computeNodeValueType });
	const computeSubgraphInstance = z.object({
		id: z.string().min(1),
		prefix: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
		assetPath: z.string().min(1),
		assetName: z.string().min(1),
		assetVersion: z.union([z.literal(1), z.literal(2)]),
		assetRevision: z.string().regex(/^[a-f0-9]{64}$/),
		nodeIds: z.array(z.string().min(1)).min(1).max(128),
		inputs: z.array(computeSubgraphPort).max(256),
		output: computeSubgraphPort,
		position: z.tuple([z.number(), z.number()]),
		collapsed: z.boolean(),
	});
	const computeNodeGraph = z.object({
		version: z.literal(1),
		nodes: z.array(computeNode).min(1).max(128),
		edges: z
			.array(
				z.object({
					from: z.string().min(1),
					fromPort: z.literal("value"),
					to: z.string().min(1),
					toPort: z.string().min(1),
				})
			)
			.max(256),
		subgraphInstances: z.array(computeSubgraphInstance).max(64).optional(),
	});
	const customPassFields = {
		passType: z
			.enum(["shader", "copy", "raster", "compute"])
			.optional()
			.describe("Pass execution type. shader runs authored GLSL; copy uses a fixed texture copy; raster draws scene meshes; compute dispatches authored WGSL on WebGPU."),
		copySource: z
			.object({
				source: z.enum(["screen", "depth", "normal", "texture", "pass"]),
				path: z.string().min(1).max(4096).optional().describe("Required project-relative path for a texture copy."),
				output: z.string().min(1).optional().describe("Required named producer output for a pass copy."),
			})
			.optional()
			.describe("Fixed-function copy source. screen copies the prior screen color; other sources copy one graph/external texture through copySampler."),
		rasterSettings: z
			.object({
				cameraId: z.string().min(1).nullable().optional().describe("Camera id for the offscreen draw; null uses the graph camera."),
				meshIds: z.array(z.string().min(1)).max(4096).optional().describe("Explicit mesh ids. An empty array renders all current scene meshes."),
				clearColor: z.array(z.number().min(0).max(1)).length(4).optional().describe("RGBA target clear color."),
				renderParticles: z.boolean().optional(),
				renderSprites: z.boolean().optional(),
				useCameraPostProcesses: z.boolean().optional(),
				refreshRate: z.enum(["once", "everyFrame", "everyTwoFrames"]).optional(),
			})
			.optional()
			.describe("Real offscreen scene-raster configuration. Raster passes require one named output and cannot publish additional MRT attachments."),
		computeSettings: z
			.object({
				wgsl: z.string().max(100_000).optional().describe("WGSL source containing an @compute entry point and writable storage texture."),
				entryPoint: z.string().min(1).optional().describe("WGSL compute entry point. Defaults to main."),
				outputBindingName: z.string().min(1).optional().describe("Storage-texture variable receiving this pass's named output."),
				outputGroup: z.number().int().min(0).max(15).optional(),
				outputBinding: z.number().int().min(0).max(15).optional(),
				dispatch: z.array(z.number().int().min(1).max(65535)).length(3).optional().describe("X/Y/Z workgroup counts."),
				dispatchMode: z.enum(["once", "everyFrame"]).optional(),
				dispatchType: z.enum(["direct", "indirect"]).optional().describe("Direct uses dispatch; indirect reads three uint32 workgroup counts from indirectBuffer."),
				submitAfterDispatch: z
					.boolean()
					.optional()
					.describe("Submit recorded GPU commands immediately after this pass. Defaults to false; use only for an intentional synchronization/readback boundary."),
				indirectBuffer: z.string().min(1).nullable().optional().describe("Storage-buffer binding name used for indirect dispatch."),
				indirectOffset: z.number().int().min(0).max(1_048_576).optional().describe("4-byte-aligned offset of the indirect X/Y/Z uint32 values."),
				uniformBuffers: z
					.array(
						z.object({
							name: z.string().min(1).describe("WGSL uniform-buffer variable name."),
							group: z.number().int().min(0).max(15),
							binding: z.number().int().min(0).max(15),
							uniforms: z
								.array(
									z.object({
										name: z.string().min(1).describe("WGSL struct member name, in declaration order."),
										type: z.enum(["float", "vec2", "vec3", "vec4", "int", "uint"]),
										value: z.array(z.number()).min(1).max(4),
									})
								)
								.min(1)
								.max(64),
						})
					)
					.max(16)
					.optional(),
				storageBuffers: z
					.array(
						z.object({
							name: z.string().min(1).describe("WGSL storage-buffer variable name."),
							group: z.number().int().min(0).max(15),
							binding: z.number().int().min(0).max(15),
							dataType: z.enum(["float32", "int32", "uint32"]),
							data: z.array(z.number()).min(1).max(262_144).describe("Typed initial buffer values."),
							indirect: z.boolean().optional().describe("Allocate with GPU indirect-dispatch usage. Defaults to false."),
							sharedResource: z
								.string()
								.min(1)
								.nullable()
								.optional()
								.describe("Graph-wide resource key. Matching keys share one GPU allocation across compute passes."),
							access: z
								.enum(["read", "write", "readWrite"])
								.optional()
								.describe("Declared hazard access. Defaults to readWrite; conflicting shared usages require dependency ordering."),
						})
					)
					.max(16)
					.optional(),
			})
			.optional()
			.describe(
				"Native WebGPU compute dispatch, uniform/storage-buffer, and indirect-dispatch settings. Compute passes require one RGBA, 1x-MSAA named storage-texture output."
			),
		enabled: z.boolean().optional(),
		order: z.number().optional().describe("Scheduling preference used when multiple dependency-ready passes are available."),
		dependencies: z.array(z.string()).max(64).optional().describe("Ids of passes that must execute before this pass."),
		fragmentShader: z
			.string()
			.max(100_000)
			.optional()
			.describe(
				"Complete GLSL fragment shader containing void main(), textureSampler, and declarations for every supplied uniform. MRT passes must write gl_FragData[0] through gl_FragData[N]."
			),
		uniforms: z
			.record(z.string(), z.union([z.number(), z.array(z.number()).min(2).max(4)]))
			.optional()
			.describe("Named float or vec2/vec3/vec4 values bound on every pass application."),
		inputs: z
			.record(
				z.string(),
				z.object({
					source: z.enum(["depth", "normal", "texture", "pass"]),
					path: z.string().min(1).max(4096).optional().describe("Required project-relative asset path when source is texture."),
					output: z.string().min(1).optional().describe("Required named producer output when source is pass."),
					group: z.number().int().min(0).max(15).optional().describe("Required WebGPU bind group for compute inputs."),
					binding: z.number().int().min(0).max(15).optional().describe("Required WebGPU binding index for compute inputs."),
				})
			)
			.optional()
			.describe(
				"Named texture resources. Shader passes declare each key in fragmentShader. Compute passes accept project textures or prior raster/compute outputs and require group/binding locations matching WGSL."
			),
		output: z.string().min(1).nullable().optional().describe("Optional unique named output captured from this pass. Set null to remove when no consumers remain."),
		outputType: z.enum(["uint8", "halfFloat", "float"]).optional().describe("Named-output precision. Defaults to uint8."),
		outputFormat: z.enum(["r", "rg", "rgba"]).optional().describe("Named-output channel format. Defaults to rgba."),
		outputSamples: z.number().int().min(1).max(8).optional().describe("Named-output MSAA sample count. Defaults to 1 and must be supported by the active backend."),
		additionalOutputs: z
			.array(
				z.object({
					name: z.string().min(1).describe("Unique output name consumed by downstream pass inputs."),
					outputType: z.enum(["uint8", "halfFloat", "float"]),
					outputFormat: z.enum(["r", "rg", "rgba"]),
					outputSamples: z.number().int().min(1).max(8),
				})
			)
			.max(3)
			.optional()
			.describe(
				"Up to three additional real MRT attachments. Requires a primary output; every attachment must use the same MSAA count and fragmentShader must write gl_FragData[0..N]."
			),
		ratio: z.number().positive().max(1).optional().describe("Render resolution ratio from greater than 0 through 1."),
		samplingMode: z.enum(["nearest", "bilinear", "trilinear"]).optional(),
	};
	server.registerTool(
		"list_custom_render_passes",
		{
			title: "List custom render passes",
			description: "List persisted shader/copy/scene-raster/WebGPU-compute passes, settings, dependency execution order, named-output lifetimes, and allocation slots.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_custom_render_passes", {})
	);
	server.registerTool(
		"create_custom_render_pass",
		{
			title: "Create custom render pass",
			description:
				"Create a persisted shader, fixed-function copy, real scene-raster, or native WebGPU compute pass. Raster passes draw selected/all meshes into an offscreen texture. Compute passes dispatch authored WGSL into one RGBA 1x-MSAA storage texture, bind textures/uniform/storage buffers, use direct/indirect dispatch, and may share storage allocations across dependency-ordered passes with declared read/write access. Copy passes copy screen/pass/depth/normal/project textures. Shader passes may publish a primary output plus three MRT attachments. Preview reports backend/resource limitations without discarding authored data.",
			inputSchema: z.object({ name: z.string().min(1), ...customPassFields }),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_custom_render_pass", args)
	);
	server.registerTool(
		"set_custom_render_pass",
		{
			title: "Set custom render pass",
			description:
				"Update pass type, copy source, raster settings, WGSL compute/dispatch/bindings/shared-resource access/submission boundary, GLSL shader, inputs, outputs, target format/MSAA, dependencies, order, ratio, or sampling and rebuild preview. Copy, raster, and compute passes use one output and no MRT additions; compute requires RGBA and 1x MSAA. Renaming outputs migrates consumers atomically. Preview reports backend/resource limitations without discarding authored data.",
			inputSchema: customPassReference.extend({ name: z.string().min(1).optional(), ...customPassFields }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_render_pass", args)
	);
	server.registerTool(
		"delete_custom_render_pass",
		{
			title: "Delete custom render pass",
			description: "Delete one custom pass and remove its id from downstream dependency lists.",
			inputSchema: customPassReference,
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_render_pass", args)
	);
	server.registerTool(
		"evaluate_custom_render_pass_graph",
		{
			title: "Evaluate custom render-pass graph",
			description: "Validate dependency/resource edges, rebuild the active camera's shader/copy/raster/compute graph, and return its resolved execution order.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("evaluate_custom_render_pass_graph", {})
	);
	server.registerTool(
		"get_custom_render_pass_diagnostics",
		{
			title: "Get custom render-pass diagnostics",
			description:
				"Read live shader/compute readiness, compiler or dispatch errors, exported-runtime restoration errors, real MRT/raster/compute target readiness, and external/pass-output resource readiness for every custom pass attached to the active camera. Render or take a screenshot before checking.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_custom_render_pass_diagnostics", {})
	);
	server.registerTool(
		"get_custom_render_pass_schedule",
		{
			title: "Get custom render-pass schedule",
			description:
				"Read dependency execution order, named-output lifetimes/allocation slots, and graph-wide shared compute-buffer usages. Shared resources report read/write access and implicit WebGPU command-order synchronization after hazard validation.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("get_custom_render_pass_schedule", {})
	);
	server.registerTool(
		"set_custom_render_pass_gpu_profiling",
		{
			title: "Set custom render-pass GPU profiling",
			description:
				"Enable or disable isolated hardware GPU timing for the active camera's custom render graph and rebuild its runtime resources. WebGPU uses per-render-target and per-compute-shader timestamp counters; compatible WebGL timestamp backends rotate one pass per query. Unsupported backends return an explicit reason and never substitute CPU or whole-frame timing.",
			inputSchema: z.object({
				enabled: z.boolean().describe("Enable or disable transient GPU pass profiling."),
				sampleCapacity: z.number().int().min(8).max(600).optional().describe("Retained samples per pass. Defaults to 120."),
				includeSamples: z.boolean().optional().describe("Include recent raw millisecond samples in the immediate result. Defaults to false."),
				sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum raw samples returned per pass. Defaults to 60."),
			}),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_render_pass_gpu_profiling", args)
	);
	server.registerTool(
		"get_custom_render_pass_gpu_profile",
		{
			title: "Get custom render-pass GPU profile",
			description:
				"Read isolated hardware GPU duration statistics for every enabled shader, copy, scene-raster, MRT, and compute pass. Returns backend capability/reason, sampling strategy, source, sample count/age, last/average/min/max milliseconds, dropped samples, and optionally bounded raw samples. No CPU or frame-wide value is presented as a pass duration.",
			inputSchema: z.object({
				includeSamples: z.boolean().optional().describe("Include recent raw millisecond samples. Defaults to false."),
				sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum raw samples returned per pass. Defaults to 60."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_render_pass_gpu_profile", args)
	);
	server.registerTool(
		"get_custom_compute_node_graph",
		{
			title: "Get custom compute node graph",
			description: "Read the persisted typed node graph and generated WGSL for one custom WebGPU compute pass.",
			inputSchema: customPassReference,
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_node_graph", args)
	);
	server.registerTool(
		"initialize_custom_compute_node_graph",
		{
			title: "Initialize custom compute node graph",
			description:
				"Create and compile a valid UV-gradient starter graph for a compute pass. Existing graphs are preserved unless replace is true. Generated WGSL becomes the pass source and preview is rebuilt.",
			inputSchema: customPassReference.extend({ replace: z.boolean().optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("initialize_custom_compute_node_graph", args)
	);
	server.registerTool(
		"set_custom_compute_node_graph",
		{
			title: "Set custom compute node graph",
			description:
				"Replace a compute pass's typed graph. Node identities, ports, edge types and cycles are validated; complete graphs compile to WGSL by default. Set compile false to persist an intentionally incomplete graph while authoring.",
			inputSchema: customPassReference.extend({ graph: computeNodeGraph, compile: z.boolean().optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_node_graph", args)
	);
	server.registerTool(
		"add_custom_compute_node",
		{
			title: "Add custom compute node",
			description:
				"Add one typed node to a persisted compute graph. The node library includes invocation/output inputs, scalar/vector constants, texture/uniform/storage loads, vector arithmetic/functions, split/combine/splat/swizzle conversions, typed comparison/Boolean/branch control, storage write, and output write. Connections are authored separately, so incomplete required inputs are allowed until compilation.",
			inputSchema: customPassReference.extend({ node: computeNode.extend({ id: z.string().min(1).optional(), position: z.tuple([z.number(), z.number()]).optional() }) }),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_custom_compute_node", args)
	);
	server.registerTool(
		"set_custom_compute_node",
		{
			title: "Set custom compute node",
			description: "Update a node type, canvas position, constant RGBA value, or bound texture/uniform resource. Existing node id is preserved.",
			inputSchema: customPassReference.extend({
				nodeId: z.string().min(1),
				update: z.object({
					type: computeNodeType.optional(),
					position: z.tuple([z.number(), z.number()]).optional(),
					value: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
					resourceName: z.string().min(1).optional(),
					fieldName: z.string().min(1).optional(),
				}),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_node", args)
	);
	server.registerTool(
		"delete_custom_compute_node",
		{
			title: "Delete custom compute node",
			description: "Delete a node and all of its incident edges. The required output-store node cannot be deleted without replacing the whole graph.",
			inputSchema: customPassReference.extend({ nodeId: z.string().min(1) }),
			annotations: { destructiveHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_compute_node", args)
	);
	server.registerTool(
		"connect_custom_compute_nodes",
		{
			title: "Connect custom compute nodes",
			description: "Connect a source node's typed value output to one named target input. Duplicate, incompatible, unknown-port and cyclic edges are rejected.",
			inputSchema: customPassReference.extend({ from: z.string().min(1), to: z.string().min(1), toPort: z.string().min(1) }),
			annotations: { idempotentHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("connect_custom_compute_nodes", args)
	);
	server.registerTool(
		"disconnect_custom_compute_nodes",
		{
			title: "Disconnect custom compute nodes",
			description: "Remove one connection identified by source node, target node and target port. The graph may remain intentionally incomplete until reconnected.",
			inputSchema: customPassReference.extend({ from: z.string().min(1), to: z.string().min(1), toPort: z.string().min(1) }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("disconnect_custom_compute_nodes", args)
	);
	server.registerTool(
		"compile_custom_compute_node_graph",
		{
			title: "Compile custom compute node graph",
			description:
				"Validate a complete acyclic typed graph, generate full WGSL declarations and compute entry point from current pass resources, store the WGSL on the pass, and rebuild preview.",
			inputSchema: customPassReference,
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("compile_custom_compute_node_graph", args)
	);
	server.registerTool(
		"save_custom_compute_subgraph",
		{
			title: "Save custom compute subgraph",
			description:
				"Save selected pure value-producing nodes from one compute pass as a reusable project-local .computegraph.json graph-function asset. Internal edges are retained, disconnected typed inputs become the asset interface, every node must contribute to outputNodeId, and storage/output sink nodes are rejected.",
			inputSchema: customPassReference.extend({
				path: z.string().min(1).describe("Project-relative .computegraph.json output path."),
				assetName: z.string().min(1).optional(),
				nodeIds: z.array(z.string().min(1)).min(1).max(128),
				outputNodeId: z.string().min(1).describe("Selected value-producing node exported as the function output."),
				inputNames: z.record(z.string(), z.string().min(1)).optional().describe('Optional boundary key (for example "multiply.a") to reusable interface name mapping.'),
				overwrite: z.boolean().optional(),
			}),
			annotations: { idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_custom_compute_subgraph", args)
	);
	server.registerTool(
		"list_custom_compute_subgraphs",
		{
			title: "List custom compute subgraphs",
			description: "List valid reusable .computegraph.json graph-function assets in the open project, including typed input/output interfaces and node counts.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_custom_compute_subgraphs", {})
	);
	server.registerTool(
		"get_custom_compute_subgraph",
		{
			title: "Get custom compute subgraph",
			description: "Read and fully validate one project-local compute graph-function asset without changing the scene.",
			inputSchema: z.object({ path: z.string().min(1) }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_subgraph", args)
	);
	server.registerTool(
		"get_custom_compute_subgraph_migration",
		{
			title: "Get custom compute subgraph migration",
			description:
				"Dry-run the deterministic migration of one legacy .computegraph.json asset. Reports source/target versions and revisions, semantic steps, changed/created nodes, and the content-addressed backup path without modifying the file.",
			inputSchema: z.object({ path: z.string().min(1) }),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_subgraph_migration", args)
	);
	server.registerTool(
		"migrate_custom_compute_subgraph",
		{
			title: "Migrate custom compute subgraph",
			description:
				"Atomically migrate one legacy project-local compute graph-function asset to the current schema. Version 1 numeric select nodes become typed compare-and-branch control while stable interface names/types are preserved. A content-addressed backup is written by default.",
			inputSchema: z.object({
				path: z.string().min(1),
				backup: z.boolean().optional().describe("Write a content-addressed backup before replacement. Defaults to true."),
			}),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("migrate_custom_compute_subgraph", args)
	);
	server.registerTool(
		"insert_custom_compute_subgraph",
		{
			title: "Insert custom compute subgraph",
			description:
				"Insert a renamed instance of a reusable graph-function asset into a compute pass. Returns mapped typed boundary inputs and output for subsequent connect_custom_compute_nodes calls; insertion deliberately permits temporarily unwired inputs.",
			inputSchema: customPassReference.extend({
				path: z.string().min(1),
				instanceId: z.string().min(1).optional().describe("Stable tracked instance id; defaults to prefix."),
				prefix: z
					.string()
					.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
					.optional()
					.describe("Stable WGSL-safe prefix for every inserted node id."),
				position: z.tuple([z.number(), z.number()]).optional().describe("Top-left canvas position for the inserted instance."),
				collapsed: z.boolean().optional().describe("Show one encapsulated call node in the editor. Defaults to true."),
			}),
			annotations: { idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("insert_custom_compute_subgraph", args)
	);
	server.registerTool(
		"delete_custom_compute_subgraph",
		{
			title: "Delete custom compute subgraph",
			description: "Delete one project-local compute graph-function asset without changing any instances already expanded into pass graphs.",
			inputSchema: z.object({ path: z.string().min(1) }),
			annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_compute_subgraph", args)
	);
	server.registerTool(
		"list_custom_compute_subgraph_instances",
		{
			title: "List custom compute subgraph instances",
			description: "List tracked expanded graph-function instances, asset revisions, typed interfaces, owned nodes, positions, and collapse state for one compute pass.",
			inputSchema: customPassReference,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_custom_compute_subgraph_instances", args)
	);
	server.registerTool(
		"set_custom_compute_subgraph_instance",
		{
			title: "Set custom compute subgraph instance",
			description: "Collapse/expand one tracked call node or move its call-node position and every expanded child node together.",
			inputSchema: customPassReference.extend({ instanceId: z.string().min(1), collapsed: z.boolean().optional(), position: z.tuple([z.number(), z.number()]).optional() }),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_subgraph_instance", args)
	);
	server.registerTool(
		"get_custom_compute_subgraph_diagnostics",
		{
			title: "Get custom compute subgraph diagnostics",
			description:
				"Compare tracked instances with project asset revisions and report current/outdated/missing/invalid state, interface compatibility, connection counts, unmanaged internal-node connections, and safe-refresh readiness.",
			inputSchema: customPassReference,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_subgraph_diagnostics", args)
	);
	server.registerTool(
		"refresh_custom_compute_subgraph_instance",
		{
			title: "Refresh custom compute subgraph instance",
			description:
				"Replace expanded child nodes from the latest asset revision while preserving compatible external connections by stable typed interface name. Incompatible interfaces or unmanaged connections are rejected. Compilation is deferred unless compile is true.",
			inputSchema: customPassReference.extend({ instanceId: z.string().min(1), compile: z.boolean().optional() }),
			annotations: { idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_custom_compute_subgraph_instance", args)
	);
	server.registerTool(
		"delete_custom_compute_subgraph_instance",
		{
			title: "Delete custom compute subgraph instance",
			description: "Remove one tracked instance, all expanded child nodes, and every incident connection without deleting its reusable asset.",
			inputSchema: customPassReference.extend({ instanceId: z.string().min(1) }),
			annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_custom_compute_subgraph_instance", args)
	);
	const computePreviewFields = {
		invocationId: z
			.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)])
			.optional()
			.describe("Representative global invocation id. Defaults to [0,0,0]."),
		outputSize: z
			.tuple([z.number().int().min(1), z.number().int().min(1)])
			.optional()
			.describe("Representative output dimensions. Defaults to the current pass target size."),
		textureSamples: z
			.record(z.string(), z.tuple([z.number(), z.number(), z.number(), z.number()]))
			.optional()
			.describe("Deterministic RGBA samples for texture-load nodes, keyed by compute input binding name."),
	};
	server.registerTool(
		"preview_custom_compute_node_graph",
		{
			title: "Preview custom compute nodes",
			description:
				"Evaluate one representative invocation entirely on CPU and return typed values/status for each node without mutating textures or buffers. Authored uniform/storage defaults are used; provide textureSamples for deterministic texture-load previews. This is a debugging preview, not GPU execution.",
			inputSchema: customPassReference.extend({
				...computePreviewFields,
				nodeIds: z.array(z.string().min(1)).max(128).optional().describe("Optional node-id filter for focused output."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("preview_custom_compute_node_graph", args)
	);
	server.registerTool(
		"get_custom_compute_texture_node_previews",
		{
			title: "Get custom compute texture-node previews",
			description:
				"Decode bounded PNG thumbnails for project-backed texture-load nodes in one compute graph. Returns source/thumbnail dimensions, sampling mode, pixel SHA-256, average/min/max RGBA, alpha coverage, and optional base64 PNG data. Live named-pass outputs are reported unavailable rather than fabricated.",
			inputSchema: customPassReference.extend({
				nodeIds: z.array(z.string().min(1)).max(32).optional().describe("Optional texture-load node filter. At most 32 nodes are returned."),
				width: z.number().int().min(16).max(128).optional().describe("Maximum thumbnail width. Defaults to 96."),
				height: z.number().int().min(16).max(128).optional().describe("Maximum thumbnail height. Defaults to 96."),
				sampling: z.enum(["nearest", "bilinear"]).optional().describe("Thumbnail resampling. Defaults from the pass sampling mode."),
				includeImage: z.boolean().optional().describe("Include bounded base64 PNG bytes. Defaults to true; false returns metadata and hashes only."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_texture_node_previews", args)
	);
	server.registerTool(
		"capture_custom_render_pass_output",
		{
			title: "Capture custom render-pass output",
			description:
				"Read one live named shader, copy, scene-raster, WebGPU-compute, or MRT attachment output through its stable texture and encode a bounded PNG preview. Returns source/output formats and dimensions, readiness, orientation, non-finite float count, source/preview pixel hashes, average/min/max RGBA, alpha coverage, and optional base64 PNG bytes.",
			inputSchema: z.object({
				output: z.string().min(1).describe("Named render-graph output or MRT attachment to read."),
				width: z.number().int().min(16).max(256).optional().describe("Maximum preview width. Defaults to 128."),
				height: z.number().int().min(16).max(256).optional().describe("Maximum preview height. Defaults to 128."),
				sampling: z.enum(["nearest", "bilinear"]).optional().describe("Preview resampling. Defaults to bilinear."),
				flipY: z.boolean().optional().describe("Flip GPU bottom-up rows to display orientation. Defaults to true."),
				includeImage: z.boolean().optional().describe("Include bounded base64 PNG bytes. Defaults to true."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("capture_custom_render_pass_output", args)
	);
	server.registerTool(
		"debug_custom_compute_node_graph",
		{
			title: "Debug custom compute node graph",
			description:
				"Return static topology/missing-input/dead-node analysis, compiler status/order, CPU node previews, live target readiness/errors, dispatch counters and CPU submission timing, plus isolated hardware GPU pass timing when profiling is enabled and supported. Whole-frame GPU context remains separately labeled.",
			inputSchema: customPassReference.extend({
				...computePreviewFields,
				includeWgsl: z.boolean().optional().describe("Include generated WGSL in the response. Defaults to false."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("debug_custom_compute_node_graph", args)
	);
	server.registerTool(
		"get_custom_compute_node_profile",
		{
			title: "Get custom compute node profile",
			description:
				"Read live per-pass dispatch count and CPU submission duration plus isolated hardware GPU timestamp statistics from the render-graph profiler. Returns explicit capability/reason and separately labeled frame context; CPU or whole-frame timing is never substituted for pass duration.",
			inputSchema: customPassReference.extend({
				includeSamples: z.boolean().optional().describe("Include recent raw isolated GPU millisecond samples. Defaults to false."),
				sampleLimit: z.number().int().min(1).max(120).optional().describe("Maximum raw samples returned. Defaults to 60."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_custom_compute_node_profile", args)
	);
	server.registerTool(
		"set_custom_compute_storage_buffer_data",
		{
			title: "Set custom compute storage-buffer data",
			description:
				"Update a bounded typed range in a compute pass storage buffer without rebuilding the graph. Persisted updates fan out atomically to every pass using the same sharedResource. By default values become future initial data and are also applied to the live WebGPU allocation. persist false is live-only and errors when no live compute runtime exists.",
			inputSchema: customPassReference.extend({
				bufferName: z.string().min(1).describe("WGSL storage-buffer binding name."),
				data: z.array(z.number()).min(1).max(65_536).describe("Replacement typed values; numeric type and 32-bit range follow the authored buffer dataType."),
				elementOffset: z.number().int().min(0).optional().describe("Destination element offset. Defaults to 0."),
				persist: z.boolean().optional().describe("Persist values as authored initial data. Defaults to true."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_storage_buffer_data", args)
	);
	server.registerTool(
		"set_custom_compute_uniform_buffer_values",
		{
			title: "Set custom compute uniform-buffer values",
			description:
				"Update selected fields of one structured compute uniform buffer without rebuilding the graph. Values are validated against each authored float/vector/int/uint field. Defaults to persisting the values and applying them to the live WebGPU buffer; persist false requires a live runtime.",
			inputSchema: customPassReference.extend({
				bufferName: z.string().min(1).describe("WGSL uniform-buffer binding name."),
				values: z
					.record(z.string(), z.array(z.number()).min(1).max(4))
					.refine((value) => Object.keys(value).length > 0, "Provide at least one uniform field.")
					.describe("Uniform field names mapped to scalar/vector values."),
				persist: z.boolean().optional().describe("Persist values as authored defaults. Defaults to true."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_custom_compute_uniform_buffer_values", args)
	);
	server.registerTool(
		"read_custom_compute_storage_buffer",
		{
			title: "Read custom compute storage buffer",
			description:
				"Read a bounded typed storage-buffer range. source runtime performs real asynchronous GPU readback and requires a live WebGPU compute graph; source authored returns persisted initial values without GPU access. Use small ranges to keep responses focused.",
			inputSchema: customPassReference.extend({
				bufferName: z.string().min(1),
				source: z.enum(["runtime", "authored"]).optional().describe("Defaults to runtime."),
				elementOffset: z.number().int().min(0).optional(),
				elementCount: z.number().int().min(1).max(65_536).optional(),
				noDelay: z.boolean().optional().describe("Request immediate GPU flushing for runtime readback. Defaults to false and may reduce performance when true."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("read_custom_compute_storage_buffer", args)
	);

	server.registerTool(
		"get_camera_post_processes",
		{
			title: "Get camera post-processes",
			description:
				"Read the post-process / rendering pipeline configurations attached to a camera: `default` (bloom, tone mapping, FXAA, vignette, depth of field, chromatic aberration, grain, sharpen, glow, color grading/curves), " +
				"`ssao` (ambient occlusion), `ssr` (screen-space reflections), `motionBlur`, `vls` (volumetric light scattering), `taa` (temporal anti-aliasing), and `customColor` (tint, saturation, contrast, brightness). " +
				"Each entry is the post-process config object, or null when that post-process is disabled for the camera. Use this before `set_camera_post_process` to read current values.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target camera (preferred). Get it from `get_scene_hierarchy`."),
				nodeName: z.string().optional().describe("Name of the target camera."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_camera_post_processes", args)
	);

	server.registerTool(
		"set_camera_post_process",
		{
			title: "Set camera post-process",
			description:
				"Enable, disable and customize a per-camera post-process in realtime. IMPORTANT: post-processes are per-camera, so this switches the editor's active camera to the target camera " +
				"so the effect is set up on it and will be available at runtime in the game. Pass `enabled:false` to remove the post-process. " +
				"Pass `properties` (a flat map) to configure it; create the post-process first by calling with `enabled:true`. " +
				"Examples — type `default`: `{ bloomEnabled:true, bloomWeight:0.6, toneMappingEnabled:true, toneMappingType:1, exposure:1.2, vignetteEnabled:true, depthOfFieldEnabled:true, fStop:1.4, focusDistance:55000, fxaaEnabled:true, grainEnabled:true, grainIntensity:15, chromaticAberrationEnabled:true }`; " +
				"type `ssao`: `{ radius:2, totalStrength:1, samples:16 }`; type `ssr`: `{ strength:1, thickness:0.5, samples:16 }`; type `motionBlur`: `{ motionStrength:1, isObjectBased:true }`; type `vls`: `{ exposure:0.3, decay:0.96, weight:0.4, density:0.9 }`; type `customColor`: `{ tint:[1,0.8,0.7], tintStrength:0.4, saturation:1.15, contrast:1.1, brightness:0.02 }`. " +
				"Returns the resulting config. Verify the look with `get_screenshot`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target camera (preferred)."),
				nodeName: z.string().optional().describe("Name of the target camera."),
				type: z.enum(["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"]).describe("Which post-process / rendering pipeline to configure."),
				enabled: z.boolean().optional().describe("Enable (create if missing) or disable (remove) the post-process for this camera. Defaults to true."),
				properties: z
					.record(z.string(), z.any())
					.optional()
					.describe(
						"Flat map of post-process properties to set. Keys depend on `type` (see the examples in this tool's description). Arrays are coerced to colors/vectors where relevant."
					),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_camera_post_process", args)
	);
}
