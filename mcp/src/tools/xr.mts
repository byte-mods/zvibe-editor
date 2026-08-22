import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const identifier = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)
	.describe("Stable editor id returned by scene/configuration tools.");
const expectedRevision = z.number().int().min(1).safe().describe("Exact current XR configuration revision; stale or missing values are rejected.");
const finite = z.number().finite();
const tuple3 = z.tuple([finite, finite, finite]).describe("Exactly three finite values.");
const sessionFeature = z.enum([
	"anchors",
	"bounded-floor",
	"depth-sensing",
	"dom-overlay",
	"hand-tracking",
	"hit-test",
	"layers",
	"light-estimation",
	"local",
	"local-floor",
	"plane-detection",
	"unbounded",
]);
const interactionMode = z.enum(["select", "grab", "teleport"]);
const interactionLayers = z
	.array(identifier)
	.min(1)
	.max(16)
	.refine((values) => new Set(values).size === values.length, "Interaction layers must be unique.");
const uniqueIdentifiers = (maximum: number) =>
	z
		.array(identifier)
		.max(maximum)
		.refine((values) => new Set(values).size === values.length, "Ids must be unique.");
const uniqueFeatures = z
	.array(sessionFeature)
	.max(12)
	.refine((values) => new Set(values).size === values.length, "Session features must be unique.");
const poseChanges = z
	.object({ position: tuple3.optional(), rotation: tuple3.optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Pose changes cannot be empty.");
const controllerChanges = z
	.object({ enabled: z.boolean().optional(), position: tuple3.optional(), rotation: tuple3.optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Controller changes cannot be empty.");
const sessionChanges = z
	.object({
		mode: z.enum(["immersive-vr", "immersive-ar"]).optional(),
		referenceSpaceType: z.enum(["local", "local-floor", "bounded-floor", "unbounded"]).optional(),
		initializeOnStartup: z.boolean().optional(),
		showEnterExitUI: z.boolean().optional(),
		requiredFeatures: uniqueFeatures.optional(),
		optionalFeatures: uniqueFeatures.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Session changes cannot be empty.");
const originChanges = z
	.object({
		originNodeId: identifier.nullable().optional(),
		cameraId: identifier.nullable().optional(),
		floorMeshIds: uniqueIdentifiers(128).optional(),
		worldScale: finite.min(0.001).max(1000).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Origin changes cannot be empty.");
const interactionChanges = z
	.object({
		pointerSelection: z.boolean().optional(),
		nearInteraction: z.boolean().optional(),
		handTracking: z.boolean().optional(),
		gazeMode: z.boolean().optional(),
		preferredHandedness: z.enum(["any", "left", "right"]).optional(),
		maxPointerDistance: finite.min(0.01).max(10_000).optional(),
		gazeSelectionTimeMs: finite.min(100).max(60_000).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Interaction changes cannot be empty.");
const locomotionChanges = z
	.object({
		teleportation: z.boolean().optional(),
		continuousMove: z.boolean().optional(),
		continuousTurn: z.boolean().optional(),
		movementSpeed: finite.min(0.01).max(100).optional(),
		rotationSpeed: finite.min(0.01).max(20).optional(),
		rotationAngleDegrees: finite.min(1).max(180).optional(),
		snapPointsOnly: z.boolean().optional(),
		snapPoints: z.array(tuple3).max(256).optional(),
		snapRadius: finite.min(0.01).max(100).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Locomotion changes cannot be empty.");
const simulationChanges = z
	.object({
		enabled: z.boolean().optional(),
		environmentMeshIds: uniqueIdentifiers(128).optional(),
		headset: poseChanges.optional(),
		leftController: controllerChanges.optional(),
		rightController: controllerChanges.optional(),
		maxRayDistance: finite.min(0.01).max(10_000).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Simulation changes cannot be empty.");
const configurationChanges = z
	.object({
		enabled: z.boolean().optional(),
		session: sessionChanges.optional(),
		origin: originChanges.optional(),
		interaction: interactionChanges.optional(),
		locomotion: locomotionChanges.optional(),
		simulation: simulationChanges.optional(),
		maxTraceEvents: z.number().int().min(16).max(4096).optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "XR configuration changes cannot be empty.")
	.refine(
		(value) => !value.session?.requiredFeatures?.some((feature) => value.session?.optionalFeatures?.includes(feature)),
		"A session feature cannot be both required and optional."
	);
const interactableFields = {
	name: z.string().trim().min(1).max(128),
	meshId: identifier,
	enabled: z.boolean(),
	modes: z
		.array(interactionMode)
		.min(1)
		.max(3)
		.refine((values) => new Set(values).size === values.length, "Interaction modes must be unique."),
	interactionLayers,
	rotateWithController: z.boolean(),
	dragSmoothing: finite.min(0).max(1),
	hapticAmplitude: finite.min(0).max(1),
	hapticDurationMs: finite.min(0).max(5000),
};
const createInteractable = z
	.object({
		id: identifier.optional(),
		name: interactableFields.name,
		meshId: interactableFields.meshId,
		enabled: interactableFields.enabled.optional(),
		modes: interactableFields.modes.optional(),
		interactionLayers: interactableFields.interactionLayers.optional(),
		rotateWithController: interactableFields.rotateWithController.optional(),
		dragSmoothing: interactableFields.dragSmoothing.optional(),
		hapticAmplitude: interactableFields.hapticAmplitude.optional(),
		hapticDurationMs: interactableFields.hapticDurationMs.optional(),
	})
	.strict();
const interactableChanges = z
	.object({
		name: interactableFields.name.optional(),
		meshId: interactableFields.meshId.optional(),
		enabled: interactableFields.enabled.optional(),
		modes: interactableFields.modes.optional(),
		interactionLayers: interactableFields.interactionLayers.optional(),
		rotateWithController: interactableFields.rotateWithController.optional(),
		dragSmoothing: interactableFields.dragSmoothing.optional(),
		hapticAmplitude: interactableFields.hapticAmplitude.optional(),
		hapticDurationMs: interactableFields.hapticDurationMs.optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Interactable changes cannot be empty.");
const traceInput = z.object({ traceLimit: z.number().int().min(0).max(4096).optional() }).strict();
const simulationInput = z.discriminatedUnion("type", [
	z
		.object({ type: z.literal("set-pose"), device: z.enum(["headset", "left", "right"]), position: tuple3.optional(), rotation: tuple3.optional() })
		.strict()
		.refine((value) => value.position !== undefined || value.rotation !== undefined, "set-pose requires position and/or rotation."),
	z
		.object({ type: z.literal("move-pose"), device: z.enum(["headset", "left", "right"]), deltaPosition: tuple3.optional(), deltaRotation: tuple3.optional() })
		.strict()
		.refine((value) => value.deltaPosition !== undefined || value.deltaRotation !== undefined, "move-pose requires deltaPosition and/or deltaRotation."),
	z
		.object({
			type: z.literal("press-select"),
			device: z.enum(["left", "right"]),
			interactionMode: z.enum(["auto", "select", "grab", "teleport"]).optional(),
			interactionLayers: interactionLayers.optional(),
		})
		.strict(),
	z.object({ type: z.literal("release-select"), device: z.enum(["left", "right"]) }).strict(),
]);

export function registerXRTools(server: McpServer): void {
	server.registerTool(
		"get_xr_capabilities",
		{
			title: "Get XR capabilities",
			description: "Read portable WebXR session, reference-space, interaction, locomotion, simulation, target, and explicit native-provider-boundary capabilities.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_xr_capabilities", {})
	);
	server.registerTool(
		"get_xr_configuration",
		{
			title: "Get XR configuration",
			description: "Read the complete versioned XR Origin, session, interaction, locomotion, simulator, interactable, and trace configuration for the active scene.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_xr_configuration", {})
	);
	server.registerTool(
		"set_xr_configuration",
		{
			title: "Set XR configuration",
			description:
				"Atomically patch documented XR session, Origin, interaction, locomotion, simulator, or trace fields under the exact current revision. Scene units are centimetres; persisted simulator poses are metres/degrees.",
			inputSchema: z.object({ expectedRevision, changes: configurationChanges }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_xr_configuration", args)
	);
	server.registerTool(
		"create_xr_interactable",
		{
			title: "Create XR interactable",
			description:
				"Create one stable-id mesh select/grab/teleport affordance with interaction layers, drag rotation/smoothing, and bounded haptics under the exact scene XR revision.",
			inputSchema: z.object({ expectedRevision, interactable: createInteractable }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_xr_interactable", args)
	);
	server.registerTool(
		"set_xr_interactable",
		{
			title: "Set XR interactable",
			description: "Patch one exact-id XR interactable without changing its stable id; returns the new scene XR revision and complete affordance.",
			inputSchema: z.object({ expectedRevision, id: identifier, changes: interactableChanges }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_xr_interactable", args)
	);
	server.registerTool(
		"delete_xr_interactable",
		{
			title: "Delete XR interactable",
			description: "Delete one exact-id XR affordance under the scene revision lease after literal confirmation; the mesh itself is preserved.",
			inputSchema: z.object({ expectedRevision, id: identifier, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_xr_interactable", args)
	);
	server.registerTool(
		"validate_xr_target",
		{
			title: "Validate XR target",
			description:
				"Audit enabled state, scene references, cross-field WebXR semantics, and optional current-browser secure-context/API/session support. Native platform/provider boundaries are reported explicitly.",
			inputSchema: z
				.object({ target: z.enum(["authoring", "web", "electron-web"]).optional(), checkCurrentDevice: z.boolean().optional(), requireEnabled: z.boolean().optional() })
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_xr_target", args)
	);
	server.registerTool(
		"get_xr_runtime",
		{
			title: "Get XR runtime",
			description:
				"Read current helper/session phase, controller profiles, enabled Babylon WebXR features, interactable resolution, error, and bounded trace evidence without creating a runtime.",
			inputSchema: traceInput,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_xr_runtime", args)
	);
	server.registerTool(
		"initialize_xr_runtime",
		{
			title: "Initialize XR runtime",
			description:
				"Initialize the enabled scene's reusable WebXR helper at an exact authoring revision without entering a headset session; initialization failures remain inspectable runtime evidence.",
			inputSchema: z.object({ expectedRevision }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("initialize_xr_runtime", args)
	);
	server.registerTool(
		"reconfigure_xr_runtime",
		{
			title: "Reconfigure XR runtime",
			description: "Dispose the prior WebXR helper/session lease and rebuild it from the exact current authoring revision.",
			inputSchema: z.object({ expectedRevision }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("reconfigure_xr_runtime", args)
	);
	server.registerTool(
		"enter_xr_session",
		{
			title: "Enter XR session",
			description:
				"Request entry into the authored immersive-vr or immersive-ar session at an exact revision. Browser policy still requires real user activation; policy rejection is returned as requestSucceeded=false with the inspectable runtime error/trace instead of failing the MCP transport.",
			inputSchema: z.object({ expectedRevision }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("enter_xr_session", args)
	);
	server.registerTool(
		"exit_xr_session",
		{
			title: "Exit XR session",
			description:
				"Exit the active immersive session at the exact authoring revision while keeping its reusable helper ready. Idle/policy-blocked exit evidence is returned as an inspectable snapshot instead of failing the MCP transport.",
			inputSchema: z.object({ expectedRevision }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("exit_xr_session", args)
	);
	server.registerTool(
		"get_xr_simulation",
		{
			title: "Get XR simulation",
			description: "Read active deterministic desktop simulator device poses, rays, held interactables, and bounded trace evidence without starting simulation.",
			inputSchema: traceInput,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_xr_simulation", args)
	);
	server.registerTool(
		"start_xr_simulation",
		{
			title: "Start XR simulation",
			description:
				"Start the enabled authored desktop XR simulator at an exact revision; headset/controller poses are metres/degrees and transient camera/object changes are restored on stop.",
			inputSchema: z.object({ expectedRevision }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_xr_simulation", args)
	);
	server.registerTool(
		"simulate_xr_input",
		{
			title: "Simulate XR input",
			description: "Apply one exact pose set/delta or layer-filtered controller press/release to drive desktop ray select, grab, or teleport behavior.",
			inputSchema: z.object({ expectedRevision, input: simulationInput }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_xr_input", args)
	);
	server.registerTool(
		"stop_xr_simulation",
		{
			title: "Stop XR simulation",
			description: "Stop the current desktop XR simulation and exactly restore every transient camera and grabbed-mesh transform.",
			inputSchema: z.object({ expectedRevision }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("stop_xr_simulation", args)
	);
}
