import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const artifactMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const roundTripMutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const projectPath = z
	.string()
	.trim()
	.min(1)
	.max(4096)
	.refine((value) => value.startsWith("assets/") && !value.includes("\\") && !value.split("/").includes(".."), "FBX path must be a project-relative file inside assets/.")
	.refine((value) => value.toLowerCase().endsWith(".fbx"), "FBX path must end with .fbx.")
	.describe("Project-relative binary FBX destination inside `assets/`, for example `assets/models/hero-export.fbx`.");
const fingerprint = z
	.string()
	.regex(/^[a-f0-9]{64}$/)
	.describe("Exact lowercase SHA-256 live-scene/scope/settings/destination lease returned by inspect_fbx_export.");
const nodeId = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !value.includes("\0"), "FBX node ids cannot contain NUL characters.")
	.describe("Exact case-sensitive Babylon node id from the live scene hierarchy.");
const rootNodeIds = z
	.array(nodeId)
	.min(1)
	.max(256)
	.refine((value) => new Set(value).size === value.length, "FBX rootNodeIds must be unique.")
	.optional()
	.describe("Optional exact roots to export. Omit for the whole scene.");
const axis = z.enum(["X", "-X", "Y", "-Y", "Z", "-Z"]);
const coordinate = z.number().finite().min(-1_000_000_000).max(1_000_000_000);

const settings = z
	.object({
		globalScale: z.number().finite().min(0.0001).max(100_000).optional(),
		axisForward: axis.optional(),
		axisUp: axis.optional(),
		applyTransforms: z.boolean().optional(),
		applyModifiers: z.boolean().optional(),
		includeMaterials: z.boolean().optional(),
		embedTextures: z.boolean().optional(),
		includeAnimations: z.boolean().optional(),
		animationSamplingRate: z.number().finite().min(0.01).max(100).optional(),
		animationSimplification: z.number().finite().min(0).max(100).optional(),
		includeCameras: z.boolean().optional(),
		includeLights: z.boolean().optional(),
		exportTangents: z.boolean().optional(),
		exportCustomProperties: z.boolean().optional(),
		addLeafBones: z.boolean().optional(),
		useArmatureDeformOnly: z.boolean().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		const forward = (value.axisForward ?? "-Z").replace("-", "");
		const up = (value.axisUp ?? "Y").replace("-", "");
		if (forward === up) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "FBX forward and up axes must use different dimensions." });
		}
		if (value.includeMaterials === false && value.embedTextures !== false) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["embedTextures"], message: "Set embedTextures=false when includeMaterials=false." });
		}
	})
	.optional()
	.describe("Optional bounded Blender binary-FBX export settings; omitted fields use Zvibe defaults.");

const inspectionFields = {
	path: projectPath,
	rootNodeIds,
	includeDescendants: z.boolean().optional().describe("For node roots, include every descendant. Defaults to true; ignored for whole-scene export."),
	settings,
	nodeOffset: z.number().int().min(0).max(10_000).default(0).describe("Zero-based offset into the exact exported-node-id evidence."),
	nodeLimit: z.number().int().min(1).max(500).default(100).describe("Maximum exported node ids returned in one response."),
};

/** Registers exact scene/selection FBX inspection, publication, and reimport through the Editor's shared owner. */
export function registerFbxExportTools(server: McpServer): void {
	server.registerTool(
		"get_fbx_export_capabilities",
		{
			title: "Get FBX export capabilities",
			description:
				"Read the exact portable FBX authoring boundary: live Babylon scene/node input, Blender prerequisite, binary output, materials/textures, skeletons, animations, cameras/lights, transform-shell selection behavior, round-trip support, defaults, work limits, and Codex/Claude client scope without changing the scene or project.",
			inputSchema: z.object({}).strict(),
			annotations: readOnly,
		},
		async (): Promise<CallToolResult> => callTextTool("get_fbx_export_capabilities", {})
	);

	server.registerTool(
		"inspect_fbx_export",
		{
			title: "Inspect FBX export",
			description:
				"Serialize the exact live scene or selected node roots to an in-memory GLB, then return its SHA-256-bound export fingerprint, normalized settings, bounded node/statistics evidence, and current/stale destination state. This is read-only, restores temporary transform shells, and must precede export_fbx_asset or round_trip_fbx_export.",
			inputSchema: z.object(inspectionFields).strict(),
			annotations: readOnly,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_fbx_export", args)
	);

	server.registerTool(
		"export_fbx_asset",
		{
			title: "Export FBX asset",
			description:
				"After confirm=true, reserialize the exact inspected live scene/node scope, invoke installed/configured Blender without a shell, revalidate the scene after conversion, and transactionally publish a validated binary FBX plus private evidence. A changed scene/settings/path, missing Blender, invalid output, timeout, or failure preserves the previous complete asset and manifest.",
			inputSchema: z.object({ ...inspectionFields, expectedFingerprint: fingerprint, confirm: z.literal(true) }).strict(),
			annotations: artifactMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("export_fbx_asset", args)
	);

	server.registerTool(
		"round_trip_fbx_export",
		{
			title: "Round-trip FBX export",
			description:
				"After confirm=true, publish the exact inspected FBX, run the ordinary model-importer artifact pipeline on that project asset, and instantiate the processed result as normal selectable scene nodes. The export remains valid if later importer/instantiation fails; repeated calls create additional scene instances.",
			inputSchema: z
				.object({
					...inspectionFields,
					expectedFingerprint: fingerprint,
					confirm: z.literal(true),
					name: z.string().trim().min(1).max(512).optional(),
					parentId: nodeId.optional(),
					parentName: z.string().trim().min(1).max(512).optional(),
					position: z.tuple([coordinate, coordinate, coordinate]).optional().describe("Imported root position in Babylon scene centimeters."),
				})
				.strict()
				.superRefine((value, context) => {
					if (value.parentId !== undefined && value.parentName !== undefined) {
						context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide parentId or parentName, not both." });
					}
				}),
			annotations: roundTripMutation,
		},
		async (args): Promise<CallToolResult> => callTextTool("round_trip_fbx_export", args)
	);
}
