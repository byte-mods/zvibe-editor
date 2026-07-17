import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

export function registerLightTools(server: McpServer): void {
	const lightingScenarioReference = { id: z.string().optional(), name: z.string().min(1).optional() };
	server.registerTool(
		"list_lighting_scenarios",
		{
			title: "List lighting scenarios",
			description: "List saved realtime-lighting snapshots in the active scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_lighting_scenarios", {})
	);
	server.registerTool(
		"create_lighting_scenario",
		{
			title: "Create lighting scenario",
			description:
				"Capture all active-scene lights, or a selected set, into a named reusable realtime lighting scenario. This captures lights, not baked GI or light probes.",
			inputSchema: z.object({ name: z.string().min(1), lightNodeIds: z.array(z.string()).optional() }),
			annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_lighting_scenario", args)
	);
	server.registerTool(
		"apply_lighting_scenario",
		{
			title: "Apply lighting scenario",
			description: "Restore a saved realtime-lighting snapshot by stable light id, with a captured-name fallback. Returns any lights that are no longer in the scene.",
			inputSchema: z.object(lightingScenarioReference),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_lighting_scenario", args)
	);
	server.registerTool(
		"blend_lighting_scenario",
		{
			title: "Blend lighting scenario",
			description: "Cross-fade realtime light enabled states, transforms, colors, intensity, range, and spot settings to a saved scenario in the active editor preview.",
			inputSchema: z.object({
				...lightingScenarioReference,
				durationMs: z.number().min(0).max(60000).optional().describe("Cross-fade duration in milliseconds; defaults to 1000."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("blend_lighting_scenario", args)
	);
	server.registerTool(
		"delete_lighting_scenario",
		{
			title: "Delete lighting scenario",
			description: "Delete a saved realtime-lighting scenario without altering current lights.",
			inputSchema: z.object(lightingScenarioReference),
			annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_lighting_scenario", args)
	);
	server.registerTool(
		"list_reflection_probes",
		{
			title: "List reflection probes",
			description: "List native realtime reflection probes in the active scene.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_reflection_probes", {})
	);
	server.registerTool(
		"create_reflection_probe",
		{
			title: "Create reflection probe",
			description: "Create a native realtime cubemap reflection probe. Assign its cubemap to PBR/standard materials with set_reflection_probe.",
			inputSchema: z.object({
				name: z.string(),
				size: z.number().int().min(16).max(2048).optional(),
				position: z.array(z.number()).length(3).optional(),
				refreshRate: z.number().int().min(0).optional(),
				samples: z.number().int().min(0).optional(),
				generateMipMaps: z.boolean().optional(),
				useFloat: z.boolean().optional(),
				linearSpace: z.boolean().optional(),
				attachedMeshId: z.string().nullable().optional(),
				attachedMeshName: z.string().nullable().optional(),
				renderListIds: z.array(z.string()).optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_reflection_probe", args)
	);
	server.registerTool(
		"set_reflection_probe",
		{
			title: "Set reflection probe",
			description: "Update a reflection probe's transform/capture settings, optionally attach it to a mesh, restrict its capture render list, and assign it to materials.",
			inputSchema: z.object({
				name: z.string(),
				position: z.array(z.number()).length(3).optional(),
				refreshRate: z.number().int().min(0).optional(),
				samples: z.number().int().min(0).optional(),
				attachedMeshId: z.string().nullable().optional(),
				attachedMeshName: z.string().nullable().optional(),
				renderListIds: z.array(z.string()).optional(),
				assignMaterialIds: z.array(z.string()).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_reflection_probe", args)
	);
	server.registerTool(
		"delete_reflection_probe",
		{ title: "Delete reflection probe", description: "Dispose a reflection probe and its generated cubemap.", inputSchema: z.object({ name: z.string() }) },
		async (args): Promise<CallToolResult> => callTextTool("delete_reflection_probe", args)
	);
	server.registerTool(
		"create_light",
		{
			title: "Create light",
			description:
				"Create a light (directional, point, spot or hemispheric). Positions are in centimeters; `color` is `[r,g,b]` (0..1). " +
				"PERFORMANCE RULE: only lights that CAST SHADOWS should be regular scene lights (e.g. the sun as a directional light with a shadow generator). " +
				"Every light that does NOT cast shadows (street lamps, decorative point lights, etc.) must be placed in the scene's ClusteredLightContainer — create it with `create_clustered_light_container` and move lights into it with `add_light_to_clustered_container`. " +
				"For a sunset, create a directional light with a warm color and tune its intensity/direction, then verify with `get_screenshot`.",
			inputSchema: z.object({
				type: z.enum(["directional", "point", "spot", "hemispheric"]).describe("The light type."),
				name: z.string().optional().describe("Name for the new light."),
				parentId: z
					.string()
					.optional()
					.describe(
						"Id of the parent node. To add a non-shadow light directly under the clustered container, pass its id here or use `add_light_to_clustered_container` afterwards."
					),
				position: z.array(z.number()).length(3).optional().describe("World position `[x,y,z]` in centimeters (point/spot)."),
				direction: z.array(z.number()).length(3).optional().describe("Direction `[x,y,z]` (directional/spot/hemispheric)."),
				color: z.array(z.number()).length(3).optional().describe("Diffuse color `[r,g,b]` in 0..1."),
				intensity: z.number().optional().describe("Light intensity."),
				range: z.number().optional().describe("Range in centimeters (point/spot)."),
				angle: z.number().optional().describe("Cone angle in radians (spot)."),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("create_light", args)
	);

	server.registerTool(
		"get_light",
		{
			title: "Get light",
			description: "Read a light's full inspector-relevant transform, color, intensity, range/cone, and shadow-generator state.",
			inputSchema: z.object({ nodeId: z.string().optional(), nodeName: z.string().optional() }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_light", args)
	);

	server.registerTool(
		"set_light_properties",
		{
			title: "Set light properties",
			description:
				"Update all inspector-visible light values: transform/direction, diffuse/specular color, intensity, range, spot cone/exponent, PBR light parameters, and type-specific fields.",
			inputSchema: z.object({
				nodeId: z.string().optional(),
				nodeName: z.string().optional(),
				position: z.array(z.number()).length(3).optional(),
				direction: z.array(z.number()).length(3).optional(),
				diffuse: z.array(z.number()).length(3).optional(),
				specular: z.array(z.number()).length(3).optional(),
				properties: z.record(z.string(), z.any()).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_light_properties", args)
	);

	server.registerTool(
		"set_ibl_shadows",
		{
			title: "Set IBL shadows",
			description: "Enable/disable and configure the editor IBL Shadows rendering pipeline. Use resolutionExp, sampleDirections, shadowRemanence, and shadowOpacity.",
			inputSchema: z.object({ enabled: z.boolean().optional(), properties: z.record(z.string(), z.any()).optional() }),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_ibl_shadows", args)
	);

	server.registerTool(
		"set_light_shadows",
		{
			title: "Set light shadows",
			description:
				"Enable or disable a shadow generator on a light and configure it. A light that casts shadows must remain a regular scene light (the ClusteredLightContainer does not support shadow-casting lights). " +
				"Typically used for the sun/key directional light. " +
				"Choose `generatorType`: 'classic' (default, works for any shadow light) or 'cascaded' to use a CascadedShadowGenerator — ideal for large outdoor scenes and a directional sun light, but ONLY valid on a directional light. " +
				"To stop a light from casting shadows, prefer `remove_light_shadows`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target light (preferred)."),
				nodeName: z.string().optional().describe("Name of the target light."),
				enabled: z.boolean().describe("Whether the light casts shadows."),
				generatorType: z
					.enum(["classic", "cascaded"])
					.optional()
					.describe(
						"Shadow generator type. 'classic' (default) for any shadow light; 'cascaded' (CascadedShadowGenerator) only for directional lights, best for large outdoor scenes."
					),
				mapSize: z.number().optional().describe("Shadow map resolution (e.g. 1024, 2048)."),
				numCascades: z.number().optional().describe("Number of cascades (cascaded only, e.g. 4). Higher gives better quality at a higher cost."),
				lambda: z.number().optional().describe("Cascade split blend factor in 0..1 (cascaded only). Closer to 1 favors logarithmic splits. Defaults to 1."),
				useBlurExponentialShadowMap: z.boolean().optional().describe("Use a blurred exponential shadow map for softer shadows."),
				darkness: z.number().optional().describe("Shadow darkness (0..1)."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_light_shadows", args)
	);

	server.registerTool(
		"remove_light_shadows",
		{
			title: "Remove light shadows",
			description:
				"Remove the shadow generator from a light so it stops casting shadows. " +
				"After removing shadows, a light can be moved into the scene's ClusteredLightContainer for performance with `add_light_to_clustered_container`.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the target light (preferred)."),
				nodeName: z.string().optional().describe("Name of the target light."),
			}),
			annotations: { destructiveHint: true, idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_light_shadows", args)
	);

	server.registerTool(
		"create_clustered_light_container",
		{
			title: "Create clustered light container",
			description:
				"Create the scene's ClusteredLightContainer if it does not already exist. This is the performance-friendly home for all NON-shadow-casting lights. " +
				"Create it once, then add lights with `add_light_to_clustered_container`.",
			inputSchema: z.object({}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_clustered_light_container", args)
	);

	server.registerTool(
		"add_light_to_clustered_container",
		{
			title: "Add light to clustered container",
			description:
				"Move a non-shadow-casting light into the scene's ClusteredLightContainer for performance (e.g. many street lights in a city scene). " +
				"Do NOT add shadow-casting lights here — the container does not support them; keep those as regular scene lights.",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the light to move (preferred)."),
				nodeName: z.string().optional().describe("Name of the light to move."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("add_light_to_clustered_container", args)
	);

	server.registerTool(
		"remove_light_from_clustered_container",
		{
			title: "Remove light from clustered container",
			description:
				"Remove a light from the scene's ClusteredLightContainer. The light is automatically added back to the scene as a regular light, " +
				"after which it can cast shadows again (e.g. with `set_light_shadows`).",
			inputSchema: z.object({
				nodeId: z.string().optional().describe("Id of the light to remove (preferred)."),
				nodeName: z.string().optional().describe("Name of the light to remove."),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("remove_light_from_clustered_container", args)
	);
}
