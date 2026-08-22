import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { callTextTool } from "./helpers.mjs";

const guiIdentityShape = {
	guiId: z.string().min(1).max(128).optional().describe("GUI/PanelRenderer id (preferred)."),
	guiName: z.string().min(1).max(128).optional().describe("GUI/PanelRenderer name when the id is not known."),
};

const safeAreaSchema = z
	.object({
		enabled: z.boolean().optional(),
		left: z.number().min(0).max(0.99).optional().describe("Normalized left inset."),
		top: z.number().min(0).max(0.99).optional().describe("Normalized top inset."),
		right: z.number().min(0).max(0.99).optional().describe("Normalized right inset."),
		bottom: z.number().min(0).max(0.99).optional().describe("Normalized bottom inset."),
	})
	.strict();

const canvasSettingsSchema = z
	.object({
		referenceWidth: z.number().min(1).max(16384).optional(),
		referenceHeight: z.number().min(1).max(16384).optional(),
		scaleMode: z.enum(["constantPixelSize", "scaleWithScreenSize", "constantPhysicalSize"]).optional(),
		screenMatchMode: z.enum(["matchWidthOrHeight", "expand", "shrink"]).optional(),
		matchWidthOrHeight: z.number().min(0).max(1).optional(),
		referencePixelsPerUnit: z.number().min(1).max(1000).optional(),
		fallbackScreenDpi: z.number().min(1).max(1000).optional(),
		defaultSpriteDpi: z.number().min(1).max(1000).optional(),
		safeArea: safeAreaSchema.optional(),
	})
	.strict();

const dimensionSchema = z.string().regex(/^-?\d+(?:\.\d+)?(?:px|%)$/, "Use a pixel or percentage value such as 320px or 50%.");

const controlPropertiesSchema = z
	.object({
		name: z.string().min(1).max(128).optional(),
		width: dimensionSchema.optional(),
		height: dimensionSchema.optional(),
		left: dimensionSchema.optional(),
		top: dimensionSchema.optional(),
		horizontalAlignment: z.enum(["left", "center", "right"]).optional(),
		verticalAlignment: z.enum(["top", "center", "bottom"]).optional(),
		alpha: z.number().min(0).max(1).optional(),
		zIndex: z.number().int().min(-32768).max(32767).optional(),
		isVisible: z.boolean().optional(),
		isEnabled: z.boolean().optional(),
		isHitTestVisible: z.boolean().optional(),
		color: z.string().min(1).max(128).optional(),
		background: z.string().min(1).max(128).optional(),
		fontSize: z.number().min(1).max(1024).optional(),
		text: z.string().max(16384).optional(),
		source: z.string().max(4096).optional(),
		thickness: z.number().min(0).max(4096).optional(),
		cornerRadius: z.number().min(0).max(4096).optional(),
		spacing: z.number().min(0).max(4096).optional(),
		isVertical: z.boolean().optional(),
		minimum: z.number().finite().optional(),
		maximum: z.number().finite().optional(),
		value: z.number().finite().optional(),
		isChecked: z.boolean().optional(),
		interactable: z.boolean().optional().describe("CanvasGroup interaction policy."),
		blocksRaycasts: z.boolean().optional().describe("CanvasGroup descendant raycast policy."),
		ignoreParentGroups: z.boolean().optional().describe("CanvasGroup resets inherited group policy before applying its own settings."),
		paddingLeft: dimensionSchema.optional(),
		paddingTop: dimensionSchema.optional(),
		paddingRight: dimensionSchema.optional(),
		paddingBottom: dimensionSchema.optional(),
	})
	.strict();

const createControlPropertiesSchema = controlPropertiesSchema.extend({ name: z.string().min(1).max(128) }).strict();
const controlTypeSchema = z.enum([
	"container",
	"rectangle",
	"ellipse",
	"text",
	"button",
	"image",
	"stackPanel",
	"grid",
	"scrollViewer",
	"checkbox",
	"radioButton",
	"slider",
	"inputText",
	"inputTextArea",
	"canvasGroup",
	"raycastReceiver",
]);
const eventNameSchema = z.enum(["pointerClick", "pointerDown", "pointerUp", "pointerEnter", "pointerOut", "valueChanged", "textChanged", "focus", "blur", "enterPressed"]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(16384), z.array(jsonValueSchema).max(64), z.record(z.string().min(1).max(128), jsonValueSchema)])
);

const scriptMethodTargetSchema = z
	.object({
		kind: z.literal("scriptMethod"),
		targetNodeId: z.string().min(1).max(256).describe('Scene node id/name, or "scene" for a scene-attached script.'),
		scriptKey: z.string().min(1).max(512).describe("Project-relative key of the attached script."),
		method: z.string().regex(/^[A-Za-z_$][\w$]{0,127}$/),
		arguments: z.array(jsonValueSchema).max(16).default([]),
		passEventData: z.boolean().default(false),
	})
	.strict();

const customEventTargetSchema = z
	.object({
		kind: z.literal("customEvent"),
		eventName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
		detail: jsonValueSchema.default(null),
	})
	.strict();

const eventTargetSchema = z.discriminatedUnion("kind", [scriptMethodTargetSchema, customEventTargetSchema]);
const eventBindingSchema = z
	.object({
		id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
		controlId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
		event: eventNameSchema,
		enabled: z.boolean().default(true),
		target: eventTargetSchema,
	})
	.strict();

const eventBindingUpdatesSchema = z
	.object({
		controlId: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
			.optional(),
		event: eventNameSchema.optional(),
		enabled: z.boolean().optional(),
		target: eventTargetSchema.optional(),
	})
	.strict();

const fontAssignmentSchema = z
	.object({
		assetPaths: z.array(z.string().min(1).max(1024)).min(1).max(8).describe("Ordered project-relative TTF/OTF/WOFF fallback chain."),
		fontStyle: z.enum(["normal", "italic"]).default("normal"),
		fontWeight: z.enum(["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"]).default("normal"),
	})
	.strict();

const atlasTextAssignmentSchema = z
	.object({
		fontAssetPaths: z.array(z.string().min(1).max(1024)).min(1).max(8).describe("Ordered project-relative dynamic/bitmap/SDF/MSDF font asset fallback chain."),
		text: z.string().max(16384).describe("Plain text or the supported TMP-style b/i/u/s/color/size/br markup subset."),
		width: z.number().int().min(1).max(4096).describe("Raster surface width in pixels."),
		height: z.number().int().min(1).max(4096).describe("Raster surface height in pixels."),
		fontSize: z.number().finite().min(1).max(512),
		color: z.string().regex(/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i),
		outlineColor: z
			.string()
			.regex(/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)
			.default("#000000ff"),
		outlineWidth: z.number().finite().min(0).max(16).default(0),
		characterSpacing: z.number().finite().min(-64).max(256).default(0),
		lineSpacing: z.number().finite().min(0.25).max(4).default(1),
		horizontalAlignment: z.enum(["left", "center", "right"]).default("left"),
		verticalAlignment: z.enum(["top", "center", "bottom"]).default("top"),
		wrapMode: z.enum(["none", "word", "character"]).default("word"),
		overflowMode: z.enum(["overflow", "clip", "ellipsis"]).default("clip"),
		richText: z.boolean().default(true),
		populateMissingGlyphs: z.boolean().default(true),
		maxRuntimeGlyphs: z.number().int().min(0).max(1024).default(256),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.width * value.height > 8_388_608) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Atlas text surfaces are limited to 8,388,608 pixels.", path: ["height"] });
		}
		if (new Set(value.fontAssetPaths).size !== value.fontAssetPaths.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Atlas text fallback paths must be unique.", path: ["fontAssetPaths"] });
		}
	});

const controlIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const controlDimensionSchema = z.string().regex(/^-?\d+(?:\.\d+)?(?:px|%)$/);
const sourceFingerprintSchema = z.string().regex(/^[a-f\d]{64}$/);
const retainedSourceSchema = z.object({ path: z.string().min(1).max(1024), source: z.string().max(1024 * 1024) }).strict();
const retainedStylesheetSchema = z.object({ path: z.string().min(1).max(1024), source: z.string().max(512 * 1024) }).strict();
const toolkitPropertySchema = z.enum([
	"width",
	"height",
	"left",
	"top",
	"horizontalAlignment",
	"verticalAlignment",
	"alpha",
	"zIndex",
	"isVisible",
	"isEnabled",
	"isHitTestVisible",
	"color",
	"background",
	"fontSize",
	"text",
	"source",
	"thickness",
	"cornerRadius",
	"spacing",
	"isVertical",
	"minimum",
	"maximum",
	"value",
	"isChecked",
	"interactable",
	"blocksRaycasts",
	"ignoreParentGroups",
	"paddingLeft",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
]);
const panelRendererSchema = z
	.object({
		renderMode: z.enum(["overlay", "worldSpace"]),
		targetMeshId: z.string().min(1).max(256).nullable(),
		textureWidth: z.number().int().min(64).max(8192),
		textureHeight: z.number().int().min(64).max(8192),
		supportPointerMove: z.boolean(),
		onlyAlphaTesting: z.boolean(),
		invertY: z.boolean(),
		foreground: z.boolean(),
		releaseRootOnDispose: z.boolean(),
	})
	.strict();
const visualElementReferenceSchema = z
	.object({
		id: controlIdSchema,
		controlId: controlIdSchema,
		expectedTypeName: z
			.string()
			.regex(/^[A-Za-z_][\w-]{0,63}$/)
			.nullable(),
	})
	.strict();
const attributeOverrideSchema = z
	.object({ controlId: controlIdSchema, property: toolkitPropertySchema, value: z.union([z.string().max(16384), z.number().finite(), z.boolean()]) })
	.strict();
const guiAnimationSchema = z
	.object({
		id: controlIdSchema,
		controlId: controlIdSchema,
		property: z.enum(["alpha", "value", "fontSize", "left", "top", "width", "height"]),
		from: z.number().finite().min(-1_000_000).max(1_000_000),
		to: z.number().finite().min(-1_000_000).max(1_000_000),
		durationMs: z.number().finite().min(1).max(3_600_000),
		delayMs: z.number().finite().min(0).max(3_600_000),
		easing: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]),
		loop: z.boolean(),
		autoplay: z.boolean(),
	})
	.strict();
const localeSchema = z
	.string()
	.min(2)
	.max(64)
	.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/);
const localizationBindingSchema = z
	.object({
		controlId: controlIdSchema,
		property: z.enum(["text", "source"]),
		table: z.string().trim().min(1).max(128),
		key: z.string().trim().min(1).max(128),
		localeOverride: localeSchema.nullable().default(null),
		arguments: z.record(z.string().min(1).max(128), jsonValueSchema).default({}),
		isolateBidirectionalText: z.boolean().default(true),
		mirrorHorizontalAlignment: z.boolean().default(true),
	})
	.strict();
const accessibilitySettingsSchema = z
	.object({
		enabled: z.boolean().optional(),
		autoExposeText: z.boolean().optional(),
		textScale: z.number().min(0.5).max(3).optional(),
		boldText: z.boolean().optional(),
		captionsEnabled: z.boolean().optional(),
		usePlatformPreferences: z.boolean().optional(),
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Accessibility settings cannot be empty.");
const accessibilityActionSchema = z.enum(["activate", "decrement", "increment"]);
const accessibilityNodeSchema = z
	.object({
		controlId: controlIdSchema,
		role: z.enum([
			"button",
			"header",
			"image",
			"keyboardKey",
			"link",
			"list",
			"listItem",
			"none",
			"searchField",
			"slider",
			"staticText",
			"tab",
			"tabBar",
			"textField",
			"toggle",
		]),
		label: z.string().max(512),
		hint: z.string().max(1024).default(""),
		value: z.string().max(512).default(""),
		focusOrder: z.number().int().min(-1).max(100_000),
		allowsDirectInteraction: z.boolean().default(false),
		actions: z
			.array(accessibilityActionSchema)
			.max(3)
			.refine((values) => new Set(values).size === values.length, "Accessibility actions must be unique."),
		live: z.enum(["assertive", "off", "polite"]).default("off"),
	})
	.strict();
const canvasGroupAssignmentSchema = z
	.object({
		alpha: z.number().finite().min(0).max(1),
		interactable: z.boolean(),
		blocksRaycasts: z.boolean(),
		ignoreParentGroups: z.boolean(),
	})
	.strict();
const usageTrackingSettingsSchema = z
	.object({ enabled: z.boolean().optional(), maxRecentEvents: z.number().int().min(0).max(2048).optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0, "Usage tracking settings cannot be empty.");

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const createAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const updateAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const deleteAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

export function registerGUITools(server: McpServer): void {
	server.registerTool(
		"get_gui_interaction_capabilities",
		{
			title: "Get GUI interaction capabilities",
			description: "Describe portable CanvasGroup hierarchy semantics, invisible RaycastReceiver behavior, and privacy-bounded local UGUI usage tracking.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("get_gui_interaction_capabilities", {})
	);
	server.registerTool(
		"list_guis",
		{
			title: "List GUI",
			description: "List fullscreen Advanced Dynamic Texture GUI instances in the active scene, including ids, sizes, and root-control counts.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("list_guis", {})
	);
	server.registerTool(
		"create_gui_asset",
		{
			title: "Create GUI asset",
			description: "Create a saved editable fullscreen .gui asset with a versioned Unity-style Canvas authoring state. Returns the normalized project path.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative .gui path."), name: z.string().min(1).max(128).optional() }).strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_gui_asset", args)
	);
	server.registerTool(
		"get_gui_asset",
		{
			title: "Get GUI asset",
			description: "Read the complete serialized content and versioned authoring metadata from a saved project .gui asset.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_asset", args)
	);
	server.registerTool(
		"instantiate_gui_asset",
		{
			title: "Instantiate GUI asset",
			description: "Load a saved fullscreen .gui asset into the active editor scene and apply its canvas, fonts, and event bindings.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative .gui path.") }).strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_gui_asset", args)
	);
	server.registerTool(
		"delete_gui_instance",
		{
			title: "Delete GUI instance",
			description:
				"Dispose one live fullscreen GUI instance under its exact authoring revision. This does not delete its saved .gui asset; use delete_asset separately after confirming that path.",
			inputSchema: z
				.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), confirm: z.literal(true).describe("Explicit confirmation for live GUI disposal.") })
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gui_instance", args)
	);
	server.registerTool(
		"get_gui_content",
		{
			title: "Get GUI content",
			description: "Get an active GUI's raw Babylon serialized control tree. Prefer get_gui_authoring for stable control ids and editable evidence.",
			inputSchema: z.object(guiIdentityShape).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_content", args)
	);
	server.registerTool(
		"set_gui_content",
		{
			title: "Set GUI content",
			description:
				"Legacy whole-tree replacement for a Babylon GUI serialization. Existing bindings/fonts whose control ids disappear are pruned. Prefer typed control tools for safe edits.",
			inputSchema: z
				.object({ ...guiIdentityShape, name: z.string().min(1).max(128).optional(), content: z.record(z.string().min(1).max(256), jsonValueSchema).optional() })
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_content", args)
	);
	server.registerTool(
		"validate_gui_accessibility",
		{
			title: "Validate GUI accessibility",
			description: "Audit duplicate control names, text smaller than 12px, unlabeled interactive controls, and explicit low-contrast text without modifying the scene.",
			inputSchema: z.object(guiIdentityShape).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_gui_accessibility", args)
	);
	server.registerTool(
		"save_gui_asset",
		{
			title: "Save GUI asset",
			description: "Serialize an active fullscreen GUI, stable control identities, canvas settings, fonts, and bindings to a project-relative .gui asset.",
			inputSchema: z.object({ ...guiIdentityShape, path: z.string().min(1).max(1024), overwrite: z.literal(true).optional() }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("save_gui_asset", args)
	);
	server.registerTool(
		"get_gui_authoring",
		{
			title: "Get GUI authoring",
			description: "Read exact revision, Canvas Scaler/safe-area settings, bindings, font assignments, and a bounded page of stable-id controls with editable properties.",
			inputSchema: z.object({ ...guiIdentityShape, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_authoring", args)
	);
	server.registerTool(
		"set_gui_localization_binding",
		{
			title: "Set GUI localization binding",
			description:
				"Bind one text or image-source property to a localized string/asset key with Smart arguments, locale override, bidi isolation, and RTL alignment mirroring.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), binding: localizationBindingSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_localization_binding", args)
	);
	server.registerTool(
		"delete_gui_localization_binding",
		{
			title: "Delete GUI localization binding",
			description: "Remove one exact text/source localization binding and restore its authored control property.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					controlId: controlIdSchema,
					property: z.enum(["text", "source"]),
					confirm: z.literal(true),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gui_localization_binding", args)
	);
	server.registerTool(
		"set_gui_accessibility_settings",
		{
			title: "Set GUI accessibility settings",
			description: "Enable the portable DOM/ARIA bridge and set automatic text exposure, text scale, bold text, captions, and platform-preference behavior.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), settings: accessibilitySettingsSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_accessibility_settings", args)
	);
	server.registerTool(
		"set_gui_accessibility_node",
		{
			title: "Set GUI accessibility node",
			description: "Set one semantic role, label, hint, value, focus order, action set, direct-interaction flag, and live-region policy for a stable GUI control.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), node: accessibilityNodeSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_accessibility_node", args)
	);
	server.registerTool(
		"delete_gui_accessibility_node",
		{
			title: "Delete GUI accessibility node",
			description: "Delete one authored semantic node; automatic text exposure may still represent the underlying control.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema, confirm: z.literal(true) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gui_accessibility_node", args)
	);
	server.registerTool(
		"inspect_gui_accessibility_hierarchy",
		{
			title: "Inspect GUI accessibility hierarchy",
			description: "Read a bounded page of visual hierarchy controls joined to authored semantics, exact revision, settings, and live bridge evidence.",
			inputSchema: z.object({ ...guiIdentityShape, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_gui_accessibility_hierarchy", args)
	);
	server.registerTool(
		"focus_gui_accessibility_node",
		{
			title: "Focus GUI accessibility node",
			description: "Focus one active semantic node through the DOM bridge or Babylon focus observable under an exact GUI revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema }).strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("focus_gui_accessibility_node", args)
	);
	server.registerTool(
		"invoke_gui_accessibility_action",
		{
			title: "Invoke GUI accessibility action",
			description: "Invoke an authored activate/increment/decrement action on an enabled live semantic control under an exact GUI revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema, action: accessibilityActionSchema }).strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("invoke_gui_accessibility_action", args)
	);
	server.registerTool(
		"announce_gui_accessibility",
		{
			title: "Announce GUI accessibility message",
			description: "Send a bounded polite or assertive message through the active GUI live region under an exact GUI revision.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					message: z.string().min(1).max(2048),
					priority: z.enum(["polite", "assertive"]).default("polite"),
				})
				.strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("announce_gui_accessibility", args)
	);
	server.registerTool(
		"set_gui_canvas_settings",
		{
			title: "Set GUI canvas settings",
			description: "Atomically update Canvas Scaler reference resolution/mode/match/DPI and normalized safe-area insets under an exact authoring revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), canvas: canvasSettingsSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_canvas_settings", args)
	);
	server.registerTool(
		"get_gui_canvas_group",
		{
			title: "Get GUI CanvasGroup",
			description: "Read one CanvasGroup's exact GUI revision, alpha slider value, interaction/raycast policy, ignore-parent policy, and stable hierarchy identity.",
			inputSchema: z.object({ ...guiIdentityShape, controlId: controlIdSchema }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_canvas_group", args)
	);
	server.registerTool(
		"set_gui_canvas_group",
		{
			title: "Set GUI CanvasGroup",
			description: "Set, replace, or remove a container CanvasGroup under the exact GUI revision. Nested alpha and input policy are evaluated hierarchically at runtime.",
			inputSchema: z
				.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema, assignment: canvasGroupAssignmentSchema.nullable() })
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_canvas_group", args)
	);
	server.registerTool(
		"list_gui_raycast_receivers",
		{
			title: "List GUI RaycastReceivers",
			description: "List a bounded page of invisible RaycastReceiver components and their stable control identities.",
			inputSchema: z.object({ ...guiIdentityShape, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(50) }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("list_gui_raycast_receivers", args)
	);
	server.registerTool(
		"set_gui_raycast_receiver",
		{
			title: "Set GUI RaycastReceiver",
			description: "Attach, enable, disable, or remove an invisible pointer hit target on one stable GUI control under the exact GUI revision; null removes it.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema, enabled: z.boolean().nullable() }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_raycast_receiver", args)
	);
	server.registerTool(
		"get_gui_usage_tracking",
		{
			title: "Get GUI usage tracking",
			description:
				"Read local-only bounded UGUI control counts, type usage, layout/render/input counters, and a page of recent events. No telemetry leaves the editor process.",
			inputSchema: z.object({ ...guiIdentityShape, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(200).default(100) }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_usage_tracking", args)
	);
	server.registerTool(
		"set_gui_usage_tracking",
		{
			title: "Set GUI usage tracking",
			description: "Enable or configure bounded local-only UGUI usage tracking under the exact GUI revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), settings: usageTrackingSettingsSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_usage_tracking", args)
	);
	server.registerTool(
		"reset_gui_usage_tracking",
		{
			title: "Reset GUI usage tracking",
			description: "Clear transient local GUI counters and recent events under an exact GUI revision without changing authored tracking settings.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0) }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("reset_gui_usage_tracking", args)
	);
	server.registerTool(
		"create_gui_control",
		{
			title: "Create GUI control",
			description:
				"Create a common Babylon GUI control under the root or a container using a stable optional id and exact revision. Returns its complete authored properties.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					controlId: z
						.string()
						.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
						.optional(),
					parentControlId: z
						.string()
						.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
						.nullable()
						.optional(),
					type: controlTypeSchema,
					properties: createControlPropertiesSchema,
				})
				.strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_gui_control", args)
	);
	server.registerTool(
		"update_gui_control",
		{
			title: "Update GUI control",
			description: "Update bounded layout, alignment, visual, text, image, or value properties on one stable-id GUI control under an exact revision.",
			inputSchema: z
				.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: z.string().min(1).max(128), properties: controlPropertiesSchema })
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("update_gui_control", args)
	);
	server.registerTool(
		"move_gui_control",
		{
			title: "Move GUI control",
			description: "Reparent a stable-id GUI control to the root or another container and set its z-order, rejecting hierarchy cycles atomically.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					controlId: z.string().min(1).max(128),
					parentControlId: z.string().min(1).max(128).nullable(),
					zIndex: z.number().int().min(-32768).max(32767),
				})
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("move_gui_control", args)
	);
	server.registerTool(
		"delete_gui_control",
		{
			title: "Delete GUI control",
			description: "Delete one stable-id GUI control subtree and atomically prune owned event/font records under an exact revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: z.string().min(1).max(128) }).strict(),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gui_control", args)
	);
	server.registerTool(
		"set_gui_control_font",
		{
			title: "Set GUI control font",
			description:
				"Set or clear an ordered 1-8 asset font fallback chain with style/weight on one stable-id control. Every importer mode retains a browser-loadable source fallback.",
			inputSchema: z
				.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: z.string().min(1).max(128), assignment: fontAssignmentSchema.nullable() })
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_control_font", args)
	);
	server.registerTool(
		"create_gui_atlas_text",
		{
			title: "Create GUI atlas text",
			description:
				"Atomically create a native Babylon GUI Image control backed by imported bitmap/SDF/MSDF atlas text, including rich tags, fallback fonts, wrapping, alignment, outlines, and bounded runtime glyph population.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					controlId: controlIdSchema,
					parentControlId: controlIdSchema.nullable().optional(),
					name: z.string().min(1).max(128),
					width: controlDimensionSchema.optional().describe("Optional GUI layout width; defaults to the atlas surface width in pixels."),
					height: controlDimensionSchema.optional().describe("Optional GUI layout height; defaults to the atlas surface height in pixels."),
					left: controlDimensionSchema.optional(),
					top: controlDimensionSchema.optional(),
					assignment: atlasTextAssignmentSchema,
				})
				.strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_gui_atlas_text", args)
	);
	server.registerTool(
		"get_gui_atlas_text",
		{
			title: "Get GUI atlas text",
			description:
				"Read one atlas-rich-text assignment, exact GUI revision, and its last live layout/render evidence including fallbacks, missing glyphs, truncation, and render modes.",
			inputSchema: z.object({ ...guiIdentityShape, controlId: controlIdSchema }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_atlas_text", args)
	);
	server.registerTool(
		"set_gui_atlas_text",
		{
			title: "Set GUI atlas text",
			description: "Atomically replace one complete atlas-rich-text assignment on an existing Babylon GUI Image control under an exact GUI revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema, assignment: atlasTextAssignmentSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_atlas_text", args)
	);
	server.registerTool(
		"refresh_gui_atlas_text",
		{
			title: "Refresh GUI atlas text",
			description: "Rebuild one live atlas-text canvas from its persisted font assets under an exact revision without changing authored state.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_gui_atlas_text", args)
	);
	server.registerTool(
		"clear_gui_atlas_text",
		{
			title: "Clear GUI atlas text",
			description:
				"Delete one atlas-rich-text assignment under an exact revision, clear its live pixels to a transparent canvas, and retain the underlying Babylon GUI Image control with clear-state evidence.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema }).strict(),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("clear_gui_atlas_text", args)
	);
	server.registerTool(
		"get_gui_retained_document",
		{
			title: "Get GUI retained document",
			description:
				"Read an attached bounded UXML/USS document, its exact GUI/source leases, compiler evidence, source graph, controls, selectors, pseudo-states, and optionally current source text.",
			inputSchema: z.object({ ...guiIdentityShape, includeSources: z.boolean().default(false) }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("get_gui_retained_document", args)
	);
	server.registerTool(
		"write_gui_retained_document",
		{
			title: "Write GUI retained document",
			description:
				"Validate and write one complete bounded UXML/USS/template source graph, then atomically replace a fullscreen GUI with its compiled retained control tree under exact GUI and source-fingerprint leases.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					expectedSourceFingerprint: sourceFingerprintSchema.nullable(),
					uxml: retainedSourceSchema,
					stylesheets: z.array(retainedStylesheetSchema).max(128).default([]),
					templates: z.array(retainedSourceSchema).max(128).default([]),
					hotReload: z.boolean().default(true),
					overwrite: z.boolean().default(false),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("write_gui_retained_document", args)
	);
	server.registerTool(
		"set_gui_retained_document",
		{
			title: "Set GUI retained document",
			description: "Compile an existing project-relative UXML/USS/template graph and atomically attach it to a fullscreen GUI under exact GUI and source-fingerprint leases.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					expectedSourceFingerprint: sourceFingerprintSchema.nullable(),
					uxmlPath: z.string().min(1).max(1024),
					hotReload: z.boolean().default(true),
				})
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_retained_document", args)
	);
	server.registerTool(
		"refresh_gui_retained_document",
		{
			title: "Refresh GUI retained document",
			description: "Recompile the attached UXML/USS source graph and atomically replace its owned controls under exact GUI and SHA-256 source leases.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), expectedSourceFingerprint: sourceFingerprintSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_gui_retained_document", args)
	);
	server.registerTool(
		"detach_gui_retained_document",
		{
			title: "Detach GUI retained document",
			description: "Remove UXML/USS source ownership under exact leases while preserving the last compiled live controls for ordinary manual editing.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), expectedSourceFingerprint: sourceFingerprintSchema }).strict(),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("detach_gui_retained_document", args)
	);
	server.registerTool(
		"get_gui_toolkit_capabilities",
		{
			title: "Get GUI Toolkit capabilities",
			description:
				"Describe the bounded portable Unity 6.5 UI Toolkit analogue: UXML upgrades, native overlay/world-space PanelRenderer, USS stats/staging, references, overrides, animations, and synthetic Click.",
			inputSchema: z.object({}).strict(),
			annotations: readAnnotations,
		},
		async (): Promise<CallToolResult> => callTextTool("get_gui_toolkit_capabilities", {})
	);
	server.registerTool(
		"inspect_gui_toolkit_workspace",
		{
			title: "Inspect GUI Toolkit workspace",
			description:
				"Read exact PanelRenderer runtime evidence, retained hierarchy, paginated per-selector USS statistics, staging order, VisualElement references, overrides, and animations.",
			inputSchema: z.object({ ...guiIdentityShape, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(256).default(100) }).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_gui_toolkit_workspace", args)
	);
	server.registerTool(
		"inspect_gui_uxml_upgrades",
		{
			title: "Inspect GUI UXML upgrades",
			description:
				"Plan deterministic bounded replacements for supported legacy UXML namespace/attribute patterns and return the exact source revision without writing files.",
			inputSchema: z.object(guiIdentityShape).strict(),
			annotations: readAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_gui_uxml_upgrades", args)
	);
	server.registerTool(
		"apply_gui_uxml_upgrades",
		{
			title: "Apply GUI UXML upgrades",
			description:
				"Atomically apply the current deterministic UXML upgrade plan and recompile the retained GUI under exact GUI, source-graph, and root-source SHA-256 leases.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					expectedSourceFingerprint: sourceFingerprintSchema,
					expectedSourceRevision: sourceFingerprintSchema,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_gui_uxml_upgrades", args)
	);
	server.registerTool(
		"set_gui_panel_renderer",
		{
			title: "Set GUI PanelRenderer",
			description:
				"Set the complete overlay or native Babylon mesh-backed world-space PanelRenderer policy under an exact GUI revision; incompatible live attachment changes require re-instantiation.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), settings: panelRendererSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_panel_renderer", args)
	);
	server.registerTool(
		"set_gui_stylesheet_stage",
		{
			title: "Set GUI stylesheet stage",
			description: "Reorder every retained USS source, select the active stylesheet, and atomically recompile cascade/source evidence in one exact staging context.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					expectedSourceFingerprint: sourceFingerprintSchema,
					contextId: controlIdSchema,
					activeStylesheetPath: z.string().min(1).max(1024).nullable(),
					stylesheetOrder: z.array(z.string().min(1).max(1024)).max(128),
				})
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_stylesheet_stage", args)
	);
	server.registerTool(
		"set_gui_visual_element_reference",
		{
			title: "Set GUI VisualElement reference",
			description: "Create or replace one stable control reference with optional exact UXML type validation under an exact GUI revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), reference: visualElementReferenceSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_visual_element_reference", args)
	);
	server.registerTool(
		"set_gui_attribute_override",
		{
			title: "Set GUI attribute override",
			description: "Create or replace one final retained-control attribute override and apply its Inspector affordance/runtime value under an exact GUI revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), override: attributeOverrideSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_attribute_override", args)
	);
	server.registerTool(
		"delete_gui_attribute_override",
		{
			title: "Delete GUI attribute override",
			description: "Delete one exact retained-control attribute override and restore stylesheet/inline behavior.",
			inputSchema: z
				.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), controlId: controlIdSchema, property: toolkitPropertySchema, confirm: z.literal(true) })
				.strict(),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gui_attribute_override", args)
	);
	server.registerTool(
		"set_gui_animation",
		{
			title: "Set GUI animation",
			description: "Create or replace one bounded numeric retained-control animation shared by editor preview and exported runtime.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), animation: guiAnimationSchema }).strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("set_gui_animation", args)
	);
	server.registerTool(
		"delete_gui_animation",
		{
			title: "Delete GUI animation",
			description: "Delete one stable retained-control animation under an exact GUI revision.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), animationId: controlIdSchema, confirm: z.literal(true) }).strict(),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gui_animation", args)
	);
	server.registerTool(
		"simulate_gui_world_space_click",
		{
			title: "Simulate GUI world-space Click",
			description: "Dispatch one bounded synthetic pointer down/click/up sequence to a visible enabled hit-testable control on a native mesh-backed PanelRenderer.",
			inputSchema: z
				.object({
					...guiIdentityShape,
					expectedRevision: z.number().int().min(0),
					controlId: controlIdSchema,
					pointerId: z.number().int().min(0).max(65535).default(1),
					eventData: z.record(z.string().min(1).max(128), jsonValueSchema).optional(),
				})
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("simulate_gui_world_space_click", args)
	);
	server.registerTool(
		"release_gui_panel_renderer_resources",
		{
			title: "Release GUI PanelRenderer resources",
			description: "After exact revision and confirmation, release the retained root, dispose the GUI texture, and restore/dispose generated world-space material ownership.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), confirm: z.literal(true) }).strict(),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("release_gui_panel_renderer_resources", args)
	);
	server.registerTool(
		"create_gui_event_binding",
		{
			title: "Create GUI event binding",
			description:
				"Create an exact-revision control event binding to an attached script method or named custom event. Static JSON arguments and optional runtime event data are supported.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), binding: eventBindingSchema }).strict(),
			annotations: createAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("create_gui_event_binding", args)
	);
	server.registerTool(
		"update_gui_event_binding",
		{
			title: "Update GUI event binding",
			description: "Atomically update an existing stable-id GUI event binding under an exact authoring revision.",
			inputSchema: z
				.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), bindingId: z.string().min(1).max(128), updates: eventBindingUpdatesSchema })
				.strict(),
			annotations: updateAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("update_gui_event_binding", args)
	);
	server.registerTool(
		"delete_gui_event_binding",
		{
			title: "Delete GUI event binding",
			description: "Delete one stable-id GUI event binding under an exact revision without modifying its control.",
			inputSchema: z.object({ ...guiIdentityShape, expectedRevision: z.number().int().min(0), bindingId: z.string().min(1).max(128) }).strict(),
			annotations: deleteAnnotations,
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_gui_event_binding", args)
	);
}
