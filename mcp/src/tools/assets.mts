import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { z } from "zod";

import { callImageTool, callTextTool } from "./helpers.mjs";

const importerKindSchema = z.enum(["texture", "model", "audio", "video", "font", "material", "animation", "custom"]);
const autoReimportImporterKindSchema = z.enum(["texture", "model", "audio", "video", "font", "material", "animation"]);
const autoReimportPathsSchema = z
	.array(z.string().min(1).max(1024))
	.min(1)
	.max(100)
	.superRefine((value, context) => {
		if (new Set(value).size !== value.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Auto Reimport paths must be unique." });
		}
	});
const autoReimportSettingsSchema = z
	.object({
		version: z.literal(1),
		enabled: z.boolean().describe("Automatically execute stale source/dependency importer artifacts after watched project changes."),
		watchImportedSources: z.boolean().describe("Also watch recorded external import origins and atomically synchronize them into project assets."),
		maxBatchSize: z.number().int().min(1).max(256).describe("Maximum affected importer assets allowed in one automatic or manual job."),
		importerKinds: z
			.array(autoReimportImporterKindSchema)
			.min(1)
			.max(7)
			.refine((value) => new Set(value).size === value.length, "importerKinds must be unique.")
			.describe("Complete enabled importer-kind set."),
	})
	.strict();
const psdLayerIndicesSchema = z
	.array(z.number().int().min(0).max(4095))
	.max(512)
	.superRefine((value, context) => {
		if (new Set(value).size !== value.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "layerIndices must be unique." });
		}
	});
const psdTextShapingSchema = z
	.object({
		direction: z.enum(["ltr", "rtl"]).describe("Explicit horizontal shaping direction, used as the paragraph base direction when bidirectional=true."),
		bidirectional: z
			.boolean()
			.optional()
			.describe(
				"Resolve bounded mixed-direction visual runs with Unicode Bidirectional Algorithm 13.0 before shaping each exact LTR/RTL run, including isolates, explicit controls, mirrored characters, and supplementary-plane-safe UTF-16 evidence."
			),
		joinAcrossStyleRuns: z
			.boolean()
			.optional()
			.describe(
				"When useAuthoredStyleRuns=true, shape adjacent style runs together only while they use byte-identical project fonts and compatible authored AutoKerning/Ligatures/DLigatures states, preserving Arabic joining and ligatures across other color/size/tracking/style boundaries. Each shaped glyph is painted by the style owning its HarfBuzz UTF-16 cluster."
			),
		script: z
			.string()
			.regex(/^[A-Za-z]{4}$/)
			.optional()
			.describe("Optional exact four-letter ISO 15924/OpenType script tag such as Arab or Deva; HarfBuzz infers it when omitted."),
		language: z
			.string()
			.min(1)
			.max(35)
			.regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/)
			.optional()
			.describe("Optional BCP 47 language tag such as ar or hi-IN."),
		features: z
			.array(
				z
					.object({
						tag: z
							.string()
							.length(4)
							.regex(/^[\x20-\x7E]{4}$/)
							.describe("Exact four-character OpenType feature tag."),
						value: z.number().int().min(0).max(65535).describe("Feature value; 0 disables and 1 enables a Boolean feature."),
					})
					.strict()
			)
			.max(32)
			.refine((value) => new Set(value.map((feature) => feature.tag)).size === value.length, "OpenType shaping feature tags must be unique.")
			.optional(),
	})
	.strict();
const psdTextRenderSchema = z
	.object({
		layerIndex: z.number().int().min(0).max(4095).describe("Exact TySh text-layer index returned by inspect_psd_layer_extraction."),
		text: z
			.string()
			.max(8192)
			.refine((value) => !value.includes("\0"), "Replacement text cannot contain NUL bytes.")
			.optional()
			.describe("Replacement text; omit to rerasterize the authored TySh text."),
		fontPath: z.string().trim().min(1).max(1024).describe("Project-relative TTF, OTF, or WOFF font asset. WOFF2 and system-font fallback are intentionally unsupported."),
		fontSize: z.number().finite().min(1).max(512).optional().describe("Final pixel font size; defaults to the first TySh style-run size or 32."),
		lineHeight: z.number().finite().min(1).max(2048).nullable().optional().describe("Explicit pixel line height; null/omit uses the project font metric."),
		tracking: z.number().finite().min(-1000).max(10000).optional().describe("Tracking in thousandths of an em; defaults to the first TySh style run."),
		justification: z
			.enum(["left", "center", "right"])
			.optional()
			.describe("Line justification inside the existing PSD layer canvas: left/center/right horizontally, or top/center/bottom along a vertical text column."),
		offsetX: z.number().finite().min(-32768).max(32768).optional().describe("Additional horizontal pixel offset inside the existing layer canvas."),
		offsetY: z.number().finite().min(-32768).max(32768).optional().describe("Additional vertical pixel offset inside the existing layer canvas."),
		color: z
			.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)])
			.optional()
			.describe("Uniform RGBA text color; defaults to the first TySh style-run fill."),
		useAuthoredStyleRuns: z
			.boolean()
			.optional()
			.describe(
				"Authored FillFlag, StrokeFlag, FillFirst, FillColor, StrokeColor, and OutlineWidth execute per style run through bounded-authored-text-fill-stroke-v1 using a bounded centered MSDF outline, exact paint order, and separate fill/stroke sample evidence. " +
					"Document-global Txt2 EngineData2 Fractions, Ordinals, and StylisticAlternates are associated by exact TySh TextIndex, merged at the union of both style-run boundary tables, and execute as HarfBuzz frac/ordn/salt=0/1 with support and source-run evidence through bounded-global-txt2-engine-data2-v1. " +
					"Authored TySh OldStyle, Swash, Titling, Ornaments, and SlashedZero Booleans execute per style run as exact HarfBuzz onum/swsh/titl/ornm/zero=0/1 values through bounded-authored-character-opentype-v1; authored values override caller features, exact project-font support is reported, and unsupported tags remain explicit without synthesized fallback. " +
					"Authored TySh FigureStyle modes 0 Default, 1 Tabular Lining, 2 Proportional Oldstyle, 3 Proportional Lining, and 4 Tabular Oldstyle force mutually explicit HarfBuzz lnum/onum/pnum/tnum values through bounded-authored-figure-style-v1; FigureStyle takes precedence over the narrower OldStyle switch and reports exact support without fallback. " +
					"Authored TySh ConnectionForms Booleans execute exact HarfBuzz calt=0/1 contextual alternates through bounded-authored-connection-forms-v1, override caller calt values, and report exact project-font support without fallback. " +
					"Authored TySh ContextualLigatures Booleans execute exact HarfBuzz clig=0/1 contextual ligatures through bounded-authored-contextual-ligatures-v1, override caller clig values, and report exact project-font support without fallback. " +
					"Authored TySh HindiNumbers Booleans preserve Arabic/Western U+0030-U+0039 when false or substitute Hindi/Arabic-Indic U+0660-U+0669 when true through bounded-authored-hindi-numbers-v1 before exact project-font shaping. " +
					"Authored TySh Kashida integers 0 Off and 1 On execute character-level Arabic elongation eligibility only on fully justified box-text lines through bounded-authored-kashida-justification-v1. Unicode 13 joining types select valid joins, HarfBuzz reshapes every insertion context, whitespace is not stretched on Kashida-eligible lines, and the plan reports eligible joins, inserted Tatweels, and exact added advance. " +
					"Authored TySh DiacriticPos integers 0 OpenType, 1 Loose, 2 Medium, and 3 Tight execute per combining-mark glyph in horizontal text through bounded-authored-diacritic-position-v1. HarfBuzz supplies exact OpenType mark/mkmk placement; the bounded preset adds an explicit above/below em-relative vertical adjustment and reports original/effective offsets and pixel shifts without claiming Photoshop pixel identity. Vertical text is explicitly reported as inactive-vertical-text instead of implying preset execution. " +
					"Authored TySh CharacterDirection integers 0 Default, 1 Left-to-Right, and 2 Right-to-Left execute as exact per-style-run Unicode BiDi directional overrides through bounded-authored-character-direction-v1; they force UAX #9 resolution, preserve paragraph base direction, and report affected characters plus resolved embedding levels. " +
					"Render the original TySh text through every exact decoded style and paragraph run instead of uniform settings. Character execution includes font, dictionary language, size, exact FontCaps normal/all-caps/small-caps behavior, exact FontBaseline normal/superscript/subscript behavior, exact BaselineDirection upright/mixed/tate-chu-yoko behavior, exact ProportionalMetrics OpenType palt state, exact Kana OpenType hkna state, exact Ruby OpenType ruby state, exact JapaneseAlternateFeature Normal/Traditional/Expert/JIS78 state, exact Tsume 0-100% sidebearing compression, Photoshop StyleRunAlignment em-box/ICF/Roman alignment, tracking, pair-specific manual Kerning in 1/1000 em, RGBA, faux bold/italic, horizontal/vertical scale, baseline shift, underline, strikethrough, authored no-break spans, and exact AutoKerning/Ligatures/DLigatures switches. All caps uses bounded Unicode uppercase expansion with source-cluster ownership; small caps uses the project font's OpenType smcp glyphs when available and otherwise scales faux capitals by the exact TySh ResourceDict SmallCapSize (Photoshop default 0.7), returning exact affected-count/source/scale/model evidence through bounded-authored-font-caps-v1. Superscript/subscript uses the exact project font's OpenType sups/subs glyphs when available; otherwise it applies the authored ResourceDict size and position (Photoshop defaults 0.583/0.333), combines the faux offset additively with explicit BaselineShift, scales decorations with the glyph, overrides conflicting caller sups/subs values, and returns exact mode/scale/position/shift/source evidence through bounded-authored-font-baseline-v1. In vertical text, BaselineDirection=1 keeps every glyph upright, 2 applies Unicode 13 Vertical_Orientation U/Tu upright and R/Tr clockwise sideways shaping, and 3 composes the exact authored run as one atomic horizontal Tate-Chu-Yoko em cell with deterministic fit; horizontal text is an explicit no-op. Exact per-glyph class/orientation/direction/rotation and per-block range/raw/fitted/cell advance/scale evidence is returned through bounded-authored-baseline-direction-v1, and unknown values reject. ProportionalMetrics executes exact HarfBuzz GPOS palt=0/1, overrides conflicting caller palt values, reports whether the project font exposes the feature, and returns bounded-authored-proportional-metrics-v1 evidence without fallback. Kana executes exact HarfBuzz GSUB hkna=0/1, overrides conflicting caller hkna values, reports project-font support, and returns bounded-authored-kana-v1 evidence without fallback. Ruby executes exact HarfBuzz GSUB ruby=0/1, overrides conflicting caller values, reports project-font support, and returns bounded-authored-ruby-v1 evidence without guessed scaling or positioning. JapaneseAlternateFeature executes exact Photoshop modes 0 Normal, 1 Traditional, 2 Expert, and 3 JIS78 by forcing mutually exclusive HarfBuzz GSUB trad/expt/jp78 states, overrides all three conflicting caller values, reports the selected and every available project-font tag, rejects unknown values, and returns bounded-authored-japanese-alternate-feature-v1 evidence without fallback. Tsume preserves glyph geometry while reducing the positive font-ink sidebearings equally on both sides in horizontal or vertical layout, returns exact per-glyph before/after advance and leading/trailing trim evidence through bounded-authored-tsume-v1, and rejects values outside 0-1. StyleRunAlignment aligns every smaller rendered character to the largest character on its composed line using exact em geometry or exact OpenType BASE icfb/icft/vertical-romn coordinates; missing required BASE metrics reject instead of being guessed, and per-glyph reference size/coordinate/shift/script/tag/format evidence is returned through bounded-authored-style-run-alignment-v1. Character leading uses explicit point values when AutoLeading=false, otherwise the paragraph auto-leading percentage (120% by default); the largest character leading on each composed line governs baseline spacing and returns exact per-line/source/model evidence through bounded-authored-character-leading-v1. Manual kerning executes additively at the exact leading UTF-16 style boundary and splits shaping there; authored OpenType switches automatically execute HarfBuzz kern/liga/dlig/palt/hkna/ruby/trad/expt/jp78 behavior and override conflicting caller feature values. Paragraph execution includes all seven justifications, first/start/end indents, before/after spacing, auto-leading, and exact hyphenation/composer settings. With authored box layout, no-break enforcement, enabled automatic hyphenation, and every-line composition execute instead of remaining evidence-only. Both run tables must cover the original UTF-16 text exactly; replacement text is rejected."
			),
		styleRunFontBindings: z
			.array(
				z
					.object({
						fontIndex: z.number().int().min(0).max(1023).describe("Exact TySh FontSet index referenced by one or more decoded style runs."),
						fontPath: z.string().trim().min(1).max(1024).describe("Explicit project-relative TTF, OTF, or WOFF asset for this font index."),
					})
					.strict()
			)
			.max(64)
			.refine((value) => new Set(value.map((entry) => entry.fontIndex)).size === value.length, "styleRunFontBindings fontIndex values must be unique.")
			.optional()
			.describe("Optional exact per-FontSet project-font bindings. Unbound indices use fontPath; system fonts and guessed substitution are never used."),
		applyAuthoredWarp: z
			.boolean()
			.optional()
			.describe(
				"Explicitly execute the TySh layer's authored Photoshop warp after project-font rasterization. Standard presets preserve strength, dual perspective, and orientation; exact tensor and piecewise-quilt custom envelopes preserve orders, complete control lattice, patch counts, source slices, tessellation, and expanded bounds. All evidence participates in the lease; malformed or unsupported warps block."
			),
		applyAuthoredBoxLayout: z
			.boolean()
			.optional()
			.describe(
				"Explicitly execute exact Photoshop box-text ShapeType/BoxBounds geometry with bounded whitespace/authored-hyphen wrapping, authored no-break spans, language-dictionary automatic hyphenation, and single-line or globally optimized every-line composition across legacy-codepoint, HarfBuzz, BiDi, cross-style, horizontal, and vertical paths. Requires the original authored style/paragraph runs and no replacement text. Returns exact box, logical line ranges/advances/spans, authored/composed lines, prevented no-break opportunities, inserted hyphens, dictionary languages, soft breaks, overflow, wrap/composer/no-break models, and paragraph evidence; unsupported language indices, point text, and malformed bounds block instead of falling back."
			),
		shaping: psdTextShapingSchema
			.optional()
			.describe(
				"Opt-in HarfBuzz GSUB/GPOS complex-script shaping using only bound project fonts; exact authored AutoKerning/Ligatures/DLigatures switches also require and automatically activate it. Vertical TySh always uses HarfBuzz top-to-bottom shaping and vertical metrics/features, with authored columns ordered right-to-left. Authored matching-font runs can join across compatible kern/liga/dlig style boundaries with cluster-owned painting; incompatible feature states split exactly. Optional bidirectional mode resolves exact UAX #9 visual runs, controls, isolates, and mirrored characters first without splitting supplementary Unicode code points. Returns orientation, boundary and per-run feature models, BiDi levels/ranges/counts, glyph IDs, UTF-16 clusters, advances, offsets, flags, engine versions, and execution models."
			),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.styleRunFontBindings !== undefined && value.useAuthoredStyleRuns !== true) {
			context.addIssue({ code: z.ZodIssueCode.custom, path: ["styleRunFontBindings"], message: "styleRunFontBindings requires useAuthoredStyleRuns=true." });
		}
		if (value.useAuthoredStyleRuns === true && value.text !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["text"],
				message: "useAuthoredStyleRuns requires omitting replacement text so exact TySh run lengths remain valid.",
			});
		}
		if (value.shaping?.joinAcrossStyleRuns === true && value.useAuthoredStyleRuns !== true) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["shaping", "joinAcrossStyleRuns"],
				message: "joinAcrossStyleRuns requires useAuthoredStyleRuns=true.",
			});
		}
		if (value.applyAuthoredBoxLayout === true && value.useAuthoredStyleRuns !== true) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["applyAuthoredBoxLayout"],
				message: "applyAuthoredBoxLayout requires useAuthoredStyleRuns=true.",
			});
		}
	});
const psdTextRendersSchema = z
	.array(psdTextRenderSchema)
	.max(128)
	.superRefine((value, context) => {
		if (new Set(value.map((entry) => entry.layerIndex)).size !== value.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "textRenders layerIndex values must be unique." });
		}
	});
const psdSmartObjectPayloadReplacementSchema = z
	.array(
		z
			.object({
				resourceIndex: z.number().int().min(0).max(1023).optional().describe("Backward-compatible exact top-level embedded liFD resource index."),
				resourcePath: z
					.array(z.number().int().min(0).max(1023))
					.min(1)
					.max(8)
					.optional()
					.describe("Exact 1-8-level embedded liFD ancestry returned by nested PSD inspection; use this instead of resourceIndex for recursive editing."),
				sourcePath: z
					.string()
					.trim()
					.min(1)
					.max(4096)
					.refine((value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value), "sourcePath must be an absolute local file path.")
					.describe("Absolute local replacement file explicitly selected by the user. PSD-stored paths are never followed."),
			})
			.strict()
			.superRefine((value, context) => {
				if ((value.resourceIndex === undefined) === (value.resourcePath === undefined)) {
					context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide exactly one of resourceIndex or resourcePath." });
				}
			})
	)
	.min(1)
	.max(128)
	.superRefine((value, context) => {
		const paths = value.map((entry) => (entry.resourcePath ?? [entry.resourceIndex!]).join("/"));
		if (new Set(paths).size !== value.length) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "replacement resource paths must be unique." });
		}
		for (let left = 0; left < paths.length; ++left) {
			for (let right = left + 1; right < paths.length; ++right) {
				if (paths[left].startsWith(`${paths[right]}/`) || paths[right].startsWith(`${paths[left]}/`)) {
					context.addIssue({ code: z.ZodIssueCode.custom, message: "replacement resource paths cannot overlap as ancestor and descendant." });
				}
			}
		}
	});
const psdSmartObjectPayloadReplacementOptionsSchema = {
	path: z.string().min(1).max(1024).describe("Project-relative PSD-v1 source asset. The source is never modified."),
	destinationPath: z
		.string()
		.min(1)
		.max(1024)
		.optional()
		.describe("Project-relative .psd output path; defaults to a sibling <name>-smart-objects.psd and never overwrites different bytes."),
	replacements: psdSmartObjectPayloadReplacementSchema,
};
const psdLayerExtractionOptionsSchema = {
	path: z.string().min(1).max(1024).describe("Project-relative layered PSD-v1 or PSB-v2 file asset path."),
	destinationFolder: z.string().min(1).max(1024).optional().describe("Project-relative output folder; defaults to a sibling <PSD name>_layers folder."),
	includeHidden: z.boolean().optional().describe("Include selected hidden pixel layers; false by default."),
	applyOpacity: z.boolean().optional().describe("Bake each layer's 0-255 opacity into PNG alpha; true by default."),
	applyLayerEffects: z
		.boolean()
		.optional()
		.describe(
			"Bake supported primary channel -2 and extended-record real-user channel -3 masks into layer alpha, plus enabled legacy lrFX effects and bounded-shadow-v2 modern lfx2/lmfx Drop/Inner Shadows with pixel choke, deterministic percent noise, antialiased or hard custom contours, and bounded-glow-v2 Inner/Outer Glows with pixel choke, deterministic noise/jitter, 1-100% range, arbitrary valid contours, edge/center Inner source, and softer/precise techniques; bounded-bevel-v2 covers all five Bevel/Emboss styles with smooth/chisel techniques, gloss/shape contours, range, and resolved embedded textures, and bounded-satin-v1 covers Satin with valid custom contours. Also bakes percent-opacity RGB Color Overlays, bounded-solid-v2/bounded-seeded-v1 Gradient Overlays, solid/gradient/pattern Strokes, and Pattern Overlays in descriptor order. The five valid lmfx list families—dropShadowMulti, innerShadowMulti, solidFillMulti, gradientFillMulti, and frameFXMulti—retain exact descriptor keys and zero-based list positions. Pattern execution is deterministic bounded-pattern-v1 with exact settings evidence; outer effects expand output bounds; true by default."
		),
	applyAdjustments: z
		.boolean()
		.optional()
		.describe(
			"Apply visible bounded RGB Brightness/Contrast, Curves, linear-sRGB Exposure, descriptor-backed Vibrance/Saturation, master or colorize Hue/Saturation, Levels, Invert, Posterize, and Threshold adjustment layers in bottom-to-top stack order to extracted layers beneath them; clipped adjustments affect only their clipping base. Bounded primary/real-user/vector adjustment masks execute per pixel with exact coverage evidence. Adjustments propagate through pass-through groups with exact crossed-group evidence; isolated groups, non-normal, Lab-only, or unsupported adjustments remain explicit evidence; true by default."
		),
	compositeClippingGroups: z
		.boolean()
		.optional()
		.describe(
			"Composite supported normal/multiply/screen/overlay/darken/lighten/dodge/burn/hard-light/soft-light/difference/exclusion/linear/subtract/divide plus non-separable Hue/Saturation/Color/Luminosity clipped layers into their base sprite; true by default."
		),
	compositeGroups: z
		.boolean()
		.optional()
		.describe(
			"Also extract supported PSD groups. Isolated groups recursively execute through bounded-isolated-group-v1/bounded-nested-isolated-group-v1 with child/group blend and opacity, clipping, effects, bounded-group-mask-v1 masks, and scoped adjustments. Backdrop-independent pass-through groups recursively flatten through bounded-pass-through-flatten-v1 when group opacity is full. A reduced-opacity root pass-through group with bounded normal raster children and a bounded raster document backdrop executes through bounded-backdrop-pass-through-opacity-v1: children interact with the real outside backdrop first, then the whole result is premultiplied-interpolated by exact group opacity. Supported primary/real-user/vector group masks execute through bounded-backdrop-pass-through-mask-v1 by multiplying that interpolation amount per pixel instead of incorrectly masking flattened alpha. Supported group styles execute on the composed group shape through bounded-backdrop-pass-through-effects-v1 before the styled result is blended with the exact backdrop and modulated by group opacity. A supported group mask plus supported style stack executes through bounded-backdrop-pass-through-mask-effects-v1: styles bake on the composed group shape and exact per-pixel mask coverage multiplies the final backdrop interpolation amount. Supported free adjustment children execute through bounded-backdrop-pass-through-adjustments-v1 after the exact backdrop initializes the authored child stack; group opacity follows internal composition and outside adjustments follow interpolation. Supported non-normal child and backdrop blend stacks execute through bounded-backdrop-pass-through-blends-v1 with the exact precomposed backdrop as the initial canvas. An exact group mask can combine with that stack through bounded-backdrop-pass-through-blends-mask-v1: authored blends execute first, then mask coverage multiplies group opacity only during final backdrop interpolation. Fully executable foreground/inside group styles combine with non-normal child blends through bounded-backdrop-pass-through-blends-effects-v1: an independent transparent group shape drives styles over the exact backdrop-aware base before group-opacity interpolation. Behind-the-layer Drop Shadows/Outer Glows, outside/center Strokes, and outer/mixed Bevel portions combine with non-normal child blends through bounded-backdrop-pass-through-blends-effects-behind-v1: the behind phase modifies the exact backdrop before child blending, the foreground phase follows child composition, and group opacity interpolates the complete result against the untouched original backdrop. Supported free adjustment children combine with non-normal child blends through bounded-backdrop-pass-through-blends-adjustments-v1: the exact backdrop and lower child blends initialize the authored stack, free adjustments execute in order, group opacity follows, and outside adjustments remain afterward. Bounded normal nested Pass Through trees execute through bounded-nested-backdrop-pass-through-v1: each nested group receives the exact parent canvas at its authored stack position, applies its children, and interpolates by its own opacity before the parent continues. Supported non-normal child and document-backdrop blends execute through bounded-nested-backdrop-pass-through-blends-v1 with the same per-boundary parent-canvas capture and opacity order. Exact primary/real-user/closed-vector masks on any nested boundary execute through bounded-nested-backdrop-pass-through-mask-v1 by multiplying that boundary's opacity only during interpolation against its captured parent canvas. Parent-dependent nested boundaries are evidence-only when requested alone. These outputs explicitly include and identify backdrop layer indices and blend modes. TySh text and smart-object children use their embedded preview pixels while preserving bounded semantic/placement evidence. Plans retain exact direct-child/nested/pass-through/order/depth/opacity/backdrop/blend/mask/effect/adjustment evidence; clipped groups, unsupported mask/effect combinations, unsupported free adjustments, unsupported blend modes, missing mask channels, unbounded vector masks, live smart-object content/filter/warp rendering, and unsupported children remain explicit non-executable evidence; false by default." +
				" Supported group styles on any nested boundary execute through bounded-nested-backdrop-pass-through-effects-v1: an independent transparent group shape drives behind and foreground phases around child blending against the exact captured parent canvas, then that boundary's opacity interpolates the complete styled result." +
				" Exact group masks and supported styles can coexist across any bounded nested boundary through bounded-nested-backdrop-pass-through-mask-effects-v1: behind and foreground effect phases execute against the captured parent canvas, then exact per-pixel mask coverage multiplies only that boundary's final opacity interpolation." +
				" Exact group masks and supported free adjustment children can coexist across any bounded nested boundary through bounded-nested-backdrop-pass-through-mask-adjustments-v1: lower child blends and free adjustments execute against the captured parent canvas in authored order, then exact per-pixel mask coverage multiplies only that boundary's final opacity interpolation." +
				" Supported group styles and free adjustment children can coexist across any bounded nested boundary through bounded-nested-backdrop-pass-through-effects-adjustments-v1: behind effects modify the captured parent before child and adjustment execution, foreground effects follow the adjusted result, and boundary opacity interpolates the complete result last." +
				" Exact group masks, supported group styles, and supported free adjustment children can coexist across any bounded nested boundary through bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1: behind effects precede child and adjustment execution, foreground effects follow, exact mask coverage multiplies final boundary opacity interpolation, and outside adjustments remain after outer interpolation." +
				" Photoshop lmgm Layer Mask Hides Effects is preserved and executed for bounded raster layers through bounded-layer-mask-hides-effects-v1: raster layer-mask coverage is deferred until after the complete style stack and then masks the final layer-and-effects result, with exact flag/application/coverage evidence." +
				" Photoshop vmgm Vector Mask Hides Effects is preserved and executed for supported bounded vector masks through bounded-vector-mask-hides-effects-v1: vector coverage is deferred until after the complete style stack and then masks the final layer-and-effects result, with exact flag/application/coverage evidence." +
				" Photoshop infx Blend Interior Effects as Group is preserved and executes both explicit backdrop orders through bounded-blend-interior-effects-as-group-v1: grouped interior effects precede the layer blend, while independent interior effects follow it using their own modes; behind effects and overall layer opacity retain their authored scope, with exact flag/order/effect/blend evidence." +
				" Photoshop clbl Blend Clipped Layers as Group is preserved and executes both explicit bounded-backdrop orders through bounded-blend-clipped-layers-as-group-v1: grouped clipping composites clipped pixels before the base blend, while independent clipping blends the base first and each clipped layer afterward in its own mode; exact base/clipped indices, names, modes, order, and model are returned." +
				" Photoshop tsly Transparency Shapes Layer and iOpa fill opacity are preserved; bounded-transparency-shapes-layer-v1 either retains layer transparency as the effect shape or uses the full layer bounds while treating transparency as fill opacity, returning exact raw state, fill opacity, effect types, application, and model." +
				" Photoshop knko Knockout is preserved as the exact three-state absent/none, zero/shallow, or one/deep setting. bounded-knockout-v1 executes fill-opacity-shaped Shallow restoration to the containing-group boundary or clipping-mask base, standalone Shallow/Deep restoration through an exact flat document stack, and Deep restoration to an exact protected full-document Background layer or transparency. Applied evidence returns the stopping boundary, destination layers, and model; clbl-disabled clipping, combined infx, nested/unbounded standalone backdrops, and unsupported combined advanced-style ordering reject without approximation." +
				" Photoshop lspf Protected Settings preserve exact transparency, composite, position, and artboard_autonest protection flags plus the raw unsigned 32-bit value and every unknown future bit through psd-protected-settings-v1; absent records remain distinguishable from an explicit unlocked record, malformed lengths and duplicates reject, and Inspector/MCP evidence never normalizes unknown flags away." +
				" Photoshop lclr Sheet Color records preserve exact none/red/orange/yellow/green/blue/violet/gray label codes, the raw 16-bit color code, all three reserved 16-bit values, and psd-sheet-color-v1 evidence; absent records remain distinguishable from explicit none, unknown future codes and non-zero reserved values remain diagnostic evidence, and malformed lengths or duplicates reject without changing extracted pixels." +
				" Photoshop fxrp Effects Reference Point records preserve the exact finite X-then-Y 64-bit coordinates through psd-effects-reference-point-v1; absent records remain distinguishable from an explicit origin, while malformed lengths, duplicates, NaN, and infinities reject without changing extracted pixels." +
				" Photoshop brst Channel Blending Restrictions preserve signed 32-bit channel ids in authored order, keep explicit-empty distinct from absent, diagnose duplicate and unsupported ids, and execute supported RGB/Grayscale exclusions through bounded-channel-blending-restrictions-v1 whenever a bounded layer, clipping stack, isolated group, or pass-through group is composited; malformed non-four-byte lengths and duplicate brst blocks reject." +
				" Photoshop SoCo Solid Color Fill layers preserve the exact version-16 descriptor class, entry keys, native color model/values, converted RGBA, generated bounds, and coverage source. RGB, float-RGB, HSB, CMYK, Gray, and Lab descriptors execute through bounded-solid-color-fill-layer-v1: stale raster RGB is replaced while authored transparency and existing raster/vector masks remain authoritative, and zero-raster fills generate document-bounded opaque coverage. Unsupported color descriptors remain explicit non-extractable evidence; malformed versions, required fields, ranges, trailing bytes, and duplicate SoCo blocks reject." +
				" Photoshop PtFl Pattern Fill layers preserve the exact version-16 root/pattern descriptor classes, authored keys/types, name/ID, scale, angle, alignment, linking, phase, generated bounds, coverage source, and every matching embedded Patt/Pat2/Pat3 index. Exactly one bounded embedded pattern executes through bounded-pattern-fill-layer-v1: stale raster RGB is replaced, tile alpha multiplies authored transparency coverage, existing raster/vector masks remain authoritative, and zero-raster fills generate document-bounded coverage. Missing, ambiguous, or unsupported pattern payloads remain explicit non-extractable evidence; malformed versions, object classes/types, values, duplicate keys/blocks, trailing bytes, and mixed SoCo/PtFl fills reject." +
				" Photoshop GdFl Gradient Fill layers preserve the exact version-16 root/Grdn descriptor classes, authored keys/types, solid color/opacity stops or seeded-noise ranges, interpolation, style, scale, angle, offset, alignment, reversal, dithering, generated bounds, and coverage source. Bounded solid and noise gradients execute through bounded-gradient-fill-layer-v1: stale raster RGB is replaced, gradient alpha multiplies authored transparency coverage, existing raster/vector masks remain authoritative, and zero-raster fills generate document-bounded coverage. Unsupported gradient descriptors remain explicit non-extractable evidence; malformed versions, classes/types/units/stops/ranges, duplicate keys/blocks, invalid trailing bytes, and mixed SoCo/PtFl/GdFl fills reject." +
				" Photoshop vscg/vstk Vector Stroke layers preserve the exact fill-content key, version-16 descriptor classes, authored keys/types/padding, stroke/fill enablement, physical-unit width and dash offset, DPI conversion, miter limit, cap/join/alignment, scale lock, stroke adjustment, dash sequence, blend mode, opacity, solid/gradient/pattern stroke content, and vector paths. Bounded closed-path fill plus closed/open-path stroke rasterization executes through bounded-vector-fill-v1 and bounded-vector-stroke-v1 over document bounds with deterministic antialiasing, dashes, caps, joins, alignment, content sampling, and compositing. Malformed versions/classes/types/units/ranges/padding, duplicates, orphaned settings, missing paths, mixed standalone/vector fills, unresolved patterns, and unsupported content reject or remain explicit non-extractable evidence." +
				" Photoshop vogk Vector Origination preserves exact record/descriptor versions, root/item classes, authored keys/types/padding, unique origin indices, raw origin types, invalidation state, DPI, mixed numeric/unit bounding boxes with bounded pixel conversion, rounded-rectangle radii, four authored box corners, affine transforms, unknown future keys, and vector-mask versus metadata-only association through psd-vector-origination-v1. Malformed versions/classes/types/ranges/quads/corners/transforms, duplicate blocks/keys/indices, non-zero padding, changed bytes, and stale plans reject without changing extracted pixels or guessing an origin-type meaning." +
				" Photoshop vowv Vector Rendering Version preserves the exact unsigned 32-bit value through psd-vector-rendering-version-v1, distinguishes the observed value 2 from unrecognized future values without guessing their semantics, and rejects malformed lengths or duplicate records without changing extracted pixels." +
				" Photoshop pths Path List preserves the exact version-16 pathsDataClass descriptor, authored keys/types/padding, bounded pathInfoClass items, Unicode path names, enum or text pathSymmetryMode values, unknown future keys, and empty-versus-absent state through psd-path-list-v1. Malformed versions/classes/types/lists/padding and duplicate blocks or keys reject without changing extracted pixels or inventing path geometry." +
				" Supported free adjustment children on any nested boundary execute through bounded-nested-backdrop-pass-through-adjustments-v1 after the exact captured parent canvas and lower authored child blends initialize that boundary; boundary opacity follows, and outside adjustments remain after the outer interpolation."
		),
	layerIndices: psdLayerIndicesSchema.optional().describe("Optional exact PSD layer indices to extract; omit to select every visible supported pixel layer."),
	textRenders: psdTextRendersSchema
		.optional()
		.describe(
			"Optional exact TySh replacement/rerasterization requests. Uniform mode uses one explicit contained TTF/OTF/WOFF asset; authored mode preserves exact UTF-16 style and paragraph runs. Character execution includes FontSet identity, dictionary language, font, size, exact FontCaps, FontBaseline, BaselineDirection upright/mixed/tate-chu-yoko, ProportionalMetrics OpenType palt, Kana OpenType hkna, Ruby OpenType ruby, JapaneseAlternateFeature Normal/Traditional/Expert/JIS78, Tsume, StyleRunAlignment em-box/ICF/Roman alignment, tracking, pair-specific manual Kerning in 1/1000 em, RGBA, faux styles, horizontal/vertical scale, baseline shift, underline, strikethrough, no-break spans, and AutoKerning/Ligatures/DLigatures. FontBaseline executes project-font sups/subs substitutions when available or exact ResourceDict size/position faux geometry otherwise; explicit BaselineShift remains additive, conflicting caller sups/subs values are overridden, and exact scale/shift/source/model evidence is returned through bounded-authored-font-baseline-v1. In vertical text, BaselineDirection=1 keeps glyphs upright, 2 uses Unicode 13 Vertical_Orientation U/Tu upright and R/Tr clockwise sideways shaping, and 3 composes the exact run as one protected horizontal Tate-Chu-Yoko em cell with bounded fit. Horizontal text records an explicit no-op; unknown values reject. Per-glyph class/orientation/direction/rotation and per-block range/advance/fit evidence is returned through bounded-authored-baseline-direction-v1. ProportionalMetrics executes exact HarfBuzz GPOS palt=0/1 with caller-feature precedence and reports project-font support through bounded-authored-proportional-metrics-v1. Kana executes exact HarfBuzz GSUB hkna=0/1 with caller-feature precedence and support evidence through bounded-authored-kana-v1. Ruby executes exact HarfBuzz GSUB ruby=0/1 with caller-feature precedence and support evidence through bounded-authored-ruby-v1, without guessed annotation layout. JapaneseAlternateFeature executes Photoshop 0/1/2/3 as mutually exclusive HarfBuzz GSUB trad/expt/jp78 states, overrides conflicting caller values for all three tags, reports selected/available project-font support, rejects unknown values, and returns bounded-authored-japanese-alternate-feature-v1 evidence without fallback. Exact authored Tsume preserves glyph geometry while reducing positive font-ink sidebearings equally on both sides in horizontal or vertical layout, returns bounded per-glyph and aggregate trim/advance evidence through bounded-authored-tsume-v1, and rejects values outside 0-1. StyleRunAlignment aligns smaller rendered characters to the largest character on each composed line using exact em geometry or project-font OpenType BASE icfb/icft/vertical-romn coordinates, rejects missing metrics without approximation, and returns per-glyph reference size/coordinate/shift/script/tag/format evidence through bounded-authored-style-run-alignment-v1. Manual kerning executes additively at the exact leading UTF-16 style boundary, splits shaping there, and returns boundary/pixel/model evidence through bounded-authored-manual-kerning-v1. Exact authored switches automatically execute HarfBuzz kern/liga/dlig/palt/hkna/ruby/trad/expt/jp78 behavior, override conflicting caller values, split incompatible cross-style feature boundaries, and return per-run effective feature/model evidence. Paragraph execution uses all seven justifications, first/start/end indents, before/after spacing, auto-leading, minimum word/prefix/suffix lengths, consecutive-hyphen limit, hyphenation zone, and composer choice through bounded-authored-paragraph-run-layout-v1. Authored breaks remain exact by default; applyAuthoredBoxLayout=true executes exact ShapeType/BoxBounds wrapping, bounded-authored-no-break-v1 suppression at authored style boundaries/spans, enabled Liang-pattern language-dictionary hyphenation, and bounded single-line or every-line composition with exact line ranges/advances/spans, prevented no-break opportunities, inserted-hyphen/language, soft-break, overflow, and model evidence across legacy, HarfBuzz, BiDi, cross-style, horizontal, and vertical paths. Horizontal text supports legacy codepoint layout or optional/automatically-required HarfBuzz GSUB/GPOS. Vertical TySh always shapes top-to-bottom with HarfBuzz vertical metrics/features and orders newline-separated columns right-to-left. Bidirectional=true first resolves Unicode 13 UAX #9 visual runs, embedding levels, isolates, controls, mirrored characters, and supplementary-plane-safe logical UTF-16 ranges. Exact orientation, glyph IDs, clusters, advances, offsets, flags, engine versions, clipping, hashes, and models are returned. Authored standard presets and exact tensor/piecewise-quilt custom envelopes require applyAuthoredWarp=true and execute afterward with complete lattice/slice/tessellation evidence; there is no system fallback, guessed font substitution, unsupported-dictionary guessing, malformed-envelope approximation, or hidden layout fallback."
		),
	extractSmartObjectPayloads: z
		.boolean()
		.optional()
		.describe(
			"Also plan publication of embedded liFD payload bytes discovered in bounded lnk2/lnkD/lnk3/lnkE records under a collision-safe smart-objects subfolder. False by default. External liFE paths and liFA aliases are evidence-only and are never resolved, read, or copied."
		),
	smartObjectResourceIds: z
		.array(z.string().trim().min(1).max(255))
		.max(128)
		.refine((value) => new Set(value).size === value.length, "smartObjectResourceIds must be unique.")
		.optional()
		.describe("Optional exact linked-resource IDs to publish; requires extractSmartObjectPayloads=true. Omit to select every embedded liFD resource."),
	smartObjectExternalBindings: z
		.array(
			z
				.object({
					resourceIndex: z.number().int().min(0).max(1023).describe("Exact external liFE resource index returned by inspection."),
					sourcePath: z
						.string()
						.trim()
						.min(1)
						.max(4096)
						.describe("Absolute local file path supplied explicitly by the user. PSD-embedded path strings are never used automatically."),
					allowSizeMismatch: z
						.boolean()
						.optional()
						.describe("Allow a reviewed selected file whose byte length differs from the PSD's recorded external file size; false by default."),
				})
				.strict()
		)
		.max(128)
		.refine((value) => new Set(value.map((entry) => entry.resourceIndex)).size === value.length, "smartObjectExternalBindings resourceIndex values must be unique.")
		.optional()
		.describe(
			"Explicit external liFE bindings to inspect, optionally render, and optionally publish under the same exact lease. The server reads only these supplied absolute paths, never the PSD's stored full/original/relative paths."
		),
	shapeBlurKernelBindings: z
		.array(
			z
				.object({
					shapeId: z
						.string()
						.trim()
						.min(1)
						.max(1024)
						.refine((value) => !value.includes("\0"), "shapeId cannot contain NUL bytes.")
						.describe("Exact unresolved customShape Idnt returned by PSD inspection."),
					sourcePath: z
						.string()
						.trim()
						.min(1)
						.max(1024)
						.refine(
							(value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes(".."),
							"sourcePath must be project-relative and contained."
						)
						.describe("Contained project raster asset used as the exact Shape Blur kernel source."),
					coverageSource: z
						.enum(["auto", "alpha", "luminance"])
						.optional()
						.describe("Coverage channel. Auto uses alpha when any sample is translucent, otherwise luminance."),
					invert: z.boolean().optional().describe("Invert the selected 0-255 coverage before constructing the scaled blur kernel."),
				})
				.strict()
		)
		.max(128)
		.refine((value) => new Set(value.map((entry) => entry.shapeId)).size === value.length, "shapeBlurKernelBindings shapeId values must be unique.")
		.optional()
		.describe(
			"Explicit exact bindings for unresolved Photoshop Shape Blur presets. The project raster bytes/hash, dimensions, effective alpha/luminance channel, inversion, coverage range/count, and bounded custom-raster algorithm enter the extraction lease."
		),
	inspectNestedSmartObjects: z
		.boolean()
		.optional()
		.describe(
			"Recursively inspect embedded liFD payloads that are valid PSD-v1 or PSB-v2 documents through bounded-nested-smart-object-v1. Returns exact resource-index/id ancestry, nested document/layer/resource metadata, and explicit unsupported, malformed, or depth-limit blockers. False by default; external paths are never followed."
		),
	nestedSmartObjectMaximumDepth: z
		.number()
		.int()
		.min(1)
		.max(8)
		.optional()
		.describe(
			"Maximum embedded PSD-v1/PSB-v2 traversal depth; defaults to 4 and requires inspectNestedSmartObjects=true. At most 128 resources and 256 MiB aggregate payload bytes are inspected."
		),
	renderEmbeddedSmartObjects: z
		.boolean()
		.optional()
		.describe(
			"Opt in to live rendering for selected raster smart-object layers backed by exactly one embedded PSD-v1 or PSB-v2 liFD merged composite. Authored affine/non-affine corners use bounded-projective-smart-object-v1; Arc/Arc Lower/Arc Upper/Arch/Bulge/Shell Lower/Shell Upper/Flag/Wave/Fish/Rise/Fisheye/Inflate/Squeeze/Twist/Cylinder presets use bounded-analytical-preset-smart-object-warp-v1 with authored -100..100 strength, dual perspective, and horizontal/vertical orientation; exact tensor and piecewise-quilt custom envelopes use their bounded Bezier models. Forty-five ordered smart-filter types execute first through explicit bounded algorithms and 20 supported Photoshop blend modes, including exact seeded Add Noise, thresholded-median Dust & Scratches, full-parameter Reduce Noise, CMYK-screen Color Halftone, seeded Voronoi Crystallize, seeded ten-mode Mezzotint, exact-cell Mosaic, seeded Pointillize, seeded Clouds, seeded Difference Clouds, seeded four-mode Diffuse, directional color Emboss, seeded cell-relief Extrude, seeded offset Tiles, per-channel threshold Trace Contour, directional Wind, field-selective De-Interlace, seeded Fibers, parameterized Lens Flare, full-parameter Smart Sharpen, exact-parameter Unsharp Mask, parameterized Motion/Radial/Smart/Surface Blur, and built-in Heart Card or explicitly bound custom-raster Shape Blur. Add Noise preserves exact percent amount, Uniform/Gaussian distribution, monochromatic state, and signed 32-bit seed through a disclosed deterministic model; Dust & Scratches preserves exact integer radius 1-100 pixels and threshold 0-255 levels through bounded-thresholded-median-dust-and-scratches-smart-filter-v1; Reduce Noise preserves preset, JPEG-artifact state, 0-100% color-noise/sharpen settings, and unique per-channel/composite amount 0-10 plus preserve-details controls through bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1; Color Halftone preserves integer maximum radius 4-127 pixels and four integer CMYK screen angles from -360 to 360 degrees through bounded-cmyk-screen-color-halftone-smart-filter-v1; Crystallize preserves integer cell size 3-300 pixels and an exact signed 32-bit seed through bounded-seeded-voronoi-crystallize-smart-filter-v1; Mezzotint preserves one of ten exact dot/line/stroke modes and an exact signed 32-bit seed through bounded-seeded-mezzotint-smart-filter-v1; Mosaic preserves integer pixel cell size 2-200 through bounded-premultiplied-mosaic-smart-filter-v1; Pointillize preserves integer cell size 3-300, signed 32-bit seed, and exact authored RGB background through bounded-seeded-authored-canvas-pointillize-smart-filter-v2; Clouds preserves its signed 32-bit seed plus exact authored RGB foreground/background colors through bounded-seeded-fractal-clouds-smart-filter-v1; Difference Clouds preserves the same seed/colors and applies exact per-channel Difference composition through bounded-seeded-difference-clouds-smart-filter-v1; Diffuse preserves one exact Normal/Darken Only/Lighten Only/Anisotropic mode and a signed 32-bit seed through bounded-seeded-four-mode-diffuse-smart-filter-v1; Emboss preserves exact angle, height, and amount through bounded-directional-color-emboss-smart-filter-v1; Extrude preserves Blocks/Pyramids, integer 2-255px size, integer 1-255 depth, Random/Level-based depth, signed 32-bit seed, solid-front-face state, and incomplete-block mask state through bounded-seeded-cell-relief-extrude-smart-filter-v1; Tiles preserves integer 1-99 tile count, integer 1-99% maximum offset, exact background/foreground/inverse/unaltered fill, signed 32-bit seed, and required authored fill color through bounded-seeded-offset-tiles-smart-filter-v1; Trace Contour preserves exact integer level 0-255 and Lower/Upper edge mode through bounded-per-channel-threshold-trace-contour-smart-filter-v1; Wind preserves exact Wind/Blast/Stagger method and Left/Right direction through bounded-directional-horizontal-wind-smart-filter-v1; De-Interlace preserves exact odd/even field elimination and duplication/interpolation reconstruction through bounded-field-reconstruction-de-interlace-smart-filter-v1; Fibers preserves integer variance/strength 1-64, a signed 32-bit seed, and exact authored RGB foreground/background colors through bounded-seeded-anisotropic-fibers-smart-filter-v1; Lens Flare preserves exact 10-300% brightness, bounded pixel center, and one of four exact lens profiles through bounded-parameterized-lens-flare-smart-filter-v1; Smart Sharpen preserves exact amount/radius/threshold/angle/more-accurate/blur/preset and shadow/highlight controls through bounded-adaptive-smart-sharpen-v1; Unsharp Mask preserves exact percent amount, pixel radius, and integer threshold through bounded-thresholded-gaussian-unsharp-mask-v1; parameterized descriptors require exact units/ranges and a 64M sample-visit ceiling. An enabled document-space FEid/FXid smart-filter mask then interpolates the unfiltered and filtered placements with exact 8/16/32-bit raw/RLE/ZIP/ZIP-predicted coverage, linked/extend state, and bounded-smart-filter-mask-v1 evidence. Existing layer masks then execute before effects, clipping, adjustments, and groups. Unknown warps, unsupported filters/blends, missing or malformed filter masks, and malformed or excessive parameters/lattices/slices block explicitly."
		),
	renderExternalSmartObjects: z
		.boolean()
		.optional()
		.describe(
			"Opt in to live rendering for external raster smart-object layers. Every source must be supplied through an exact smartObjectExternalBindings entry; PSD-stored paths are never followed. PNG, JPEG, WebP, GIF, TIFF, BMP, SVG, TGA, PSD-v1, and PSB-v2 sources decode under strict limits; the 45-type ordered smart-filter subset, including seeded Add Noise, thresholded-median Dust & Scratches, full-parameter Reduce Noise, CMYK-screen Color Halftone, seeded Voronoi Crystallize, seeded ten-mode Mezzotint, exact-cell Mosaic, authored-background seeded Pointillize, authored-color seeded Clouds, authored-color seeded Difference Clouds, seeded four-mode Diffuse, directional color Emboss, seeded cell-relief Extrude, seeded offset Tiles, per-channel threshold Trace Contour, directional Wind, field-selective De-Interlace, authored-color parameterized seeded Fibers, parameterized Lens Flare, full-parameter Smart Sharpen, exact-parameter Unsharp Mask, the built-in Heart Card, and explicitly bound arbitrary raster Shape Blur kernels, executes through explicit bounded algorithms, exact parameter/work limits, and 20 supported blend modes, filtered and unfiltered sources traverse the same authored projective/preset/tensor/quilt placement, and optional exact document-space FEid/FXid mask coverage interpolates those placements before layer masks and the existing composition pipeline."
		),
	smartObjectRenderLayerIndices: psdLayerIndicesSchema
		.refine((value) => value.length <= 128, "smartObjectRenderLayerIndices supports at most 128 layers.")
		.optional()
		.describe(
			"Optional exact smart-object layer indices to render from enabled embedded or explicitly bound external sources; requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true. Omit to render every matching contributing smart-object layer."
		),
};
function validatePsdLayerExtractionOptions(value: Record<string, unknown>, context: z.RefinementCtx): void {
	if (value.smartObjectRenderLayerIndices !== undefined && value.renderEmbeddedSmartObjects !== true && value.renderExternalSmartObjects !== true) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["smartObjectRenderLayerIndices"],
			message: "smartObjectRenderLayerIndices requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true.",
		});
	}
	if (value.nestedSmartObjectMaximumDepth !== undefined && value.inspectNestedSmartObjects !== true) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["nestedSmartObjectMaximumDepth"],
			message: "nestedSmartObjectMaximumDepth requires inspectNestedSmartObjects=true.",
		});
	}
	if (value.shapeBlurKernelBindings !== undefined && value.renderEmbeddedSmartObjects !== true && value.renderExternalSmartObjects !== true) {
		context.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["shapeBlurKernelBindings"],
			message: "shapeBlurKernelBindings requires renderEmbeddedSmartObjects=true or renderExternalSmartObjects=true.",
		});
	}
}
const importerSettingsSchema = z
	.record(z.string().min(1).max(64), z.union([z.boolean(), z.number().finite(), z.string().max(65_536)]))
	.refine((value) => Object.keys(value).length <= 64, "Importer settings support at most 64 fields.");
const modelAnimationClipSchema = z
	.object({
		name: z.string().trim().min(1).max(128).describe("Unique output AnimationGroup name."),
		sourceAnimationGroup: z.string().trim().min(1).max(256).describe("Exact imported source AnimationGroup name."),
		from: z.number().finite().min(-10_000_000).max(10_000_000).describe("Inclusive source start frame."),
		to: z.number().finite().min(-10_000_000).max(10_000_000).describe("Inclusive source end frame; must be greater than from."),
		loopTime: z.boolean().optional().describe("Mark the generated AnimationGroup as looping."),
		loopPose: z.boolean().optional().describe("Make the generated final key match its first pose; requires loopTime=true."),
		rootMotionNode: z.string().trim().max(256).optional().describe("Optional exact animated target name or id used for root-motion validation/metadata."),
		rootMotionPosition: z.enum(["none", "xz", "xyz"]).optional().describe("Position components requested from rootMotionNode."),
		rootMotionRotationY: z.boolean().optional().describe("Request Y-rotation root motion from rootMotionNode."),
		targetMask: z
			.array(z.string().trim().min(1).max(256))
			.max(256)
			.optional()
			.describe("Optional exact target names/ids retained in this clip; omitted or empty retains every source track."),
	})
	.strict();
const modelMaterialRemapSchema = z
	.object({
		sourceMaterial: z.string().trim().min(1).max(512).describe("Exact case-sensitive material name discovered by get_model_material_remaps."),
		materialPath: z
			.string()
			.trim()
			.min(10)
			.max(1024)
			.refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes("..") && value.toLowerCase().endsWith(".material"), {
				message: "materialPath must be a contained project-relative .material asset path.",
			})
			.describe("Contained project-relative .material replacement path, for example assets/materials/hero-body.material."),
	})
	.strict();
const modelGeneratedLodSchema = z
	.object({
		quality: z.number().finite().min(0.01).max(0.99).describe("Target retained triangle ratio; later levels must use a strictly lower value."),
		distance: z.number().finite().gt(0).max(1_000_000_000).describe("Camera transition distance in editor centimeters; levels must be strictly increasing."),
	})
	.strict();
const modelAuthoredLodLevelSchema = z
	.object({
		mesh: z.string().trim().min(1).max(512).describe("Exact case-sensitive imported mesh name used for this lower-detail level."),
		distance: z.number().finite().gt(0).max(1_000_000_000).describe("Camera transition distance in editor centimeters; levels must be strictly increasing."),
	})
	.strict();
const modelAuthoredLodGroupSchema = z
	.object({
		sourceMesh: z.string().trim().min(1).max(512).describe("Exact case-sensitive highest-detail imported mesh name (LOD0)."),
		levels: z.array(modelAuthoredLodLevelSchema).min(1).max(8).describe("Ordered existing lower-detail meshes and increasing transition distances."),
	})
	.strict();
const modelPlatformOverrideSchema = z
	.object({
		enabled: z.boolean().describe("Whether this target uses the supplied values instead of Default model settings."),
		scaleFactor: z.number().finite().min(0.0001).max(100000).optional(),
		convertUnits: z.boolean().optional(),
		importMaterials: z.boolean().optional(),
		generatedLods: z.array(modelGeneratedLodSchema).max(8).optional(),
		importTextures: z.boolean().optional(),
		importAnimations: z.boolean().optional(),
		animationType: z.enum(["none", "generic", "humanoid"]).optional(),
		optimizeGameObjects: z.boolean().optional(),
		generateColliders: z.boolean().optional(),
		meshCompression: z.enum(["none", "low", "medium", "high"]).optional(),
		optimizeMesh: z.boolean().optional(),
		weldVertices: z.boolean().optional(),
		normals: z.enum(["import", "calculate", "none"]).optional(),
		tangents: z.enum(["import", "calculate", "none"]).optional(),
	})
	.strict();
const texturePlatformOverrideSchema = z
	.object({
		enabled: z.boolean().describe("Whether this target uses the supplied values instead of Default texture settings."),
		maxSize: z
			.union([
				z.literal(32),
				z.literal(64),
				z.literal(128),
				z.literal(256),
				z.literal(512),
				z.literal(1024),
				z.literal(2048),
				z.literal(4096),
				z.literal(8192),
				z.literal(16384),
			])
			.optional(),
		resizeAlgorithm: z.enum(["nearest", "bilinear", "bicubic", "lanczos3"]).optional(),
		compression: z.enum(["none", "low", "normal", "high"]).optional(),
		generateMipmaps: z.boolean().optional(),
		readable: z.boolean().optional(),
	})
	.strict();

export function registerAssetTools(server: McpServer): void {
	server.registerTool(
		"list_asset_importer_types",
		{
			title: "List asset importer types",
			description:
				"List the versioned texture, model, audio, video, font, material, animation, and custom importer contracts with supported extensions, bounded field descriptors, enum/range constraints, and effective defaults.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_asset_importer_types", {})
	);
	server.registerTool(
		"get_asset_importer",
		{
			title: "Get asset importer",
			description: "Read one existing file asset's inferred importer kind and effective versioned settings after legacy metadata migration.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_importer", args)
	);
	server.registerTool(
		"open_asset_inspector",
		{
			title: "Open asset Inspector",
			description:
				"Open the editor's normal File Inspector for one indexed project asset and browse its containing folder. This exposes organization, import health, type-specific importer controls, dependency evidence, and specialized preview UI without modifying the asset.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_asset_inspector", args)
	);
	server.registerTool(
		"validate_asset_importer_settings",
		{
			title: "Validate asset importer settings",
			description:
				"Validate a bounded type-specific importer settings patch against one existing asset without changing the project. Returns the complete effective configuration or an actionable range/enum/type error.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				settings: importerSettingsSchema,
				replace: z.boolean().optional().describe("Reset unspecified fields to type defaults before validation."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("validate_asset_importer_settings", args)
	);
	server.registerTool(
		"set_asset_importer_settings",
		{
			title: "Set asset importer settings",
			description:
				"Validate every target, then apply one bounded importer settings patch to up to 100 compatible file assets. All paths are validated before any sidecar is written. includeInBuild is honored for every packaged asset; executed texture, audio, video, font, material, and animation changes are previewed and applied through their get_*_importer_result then apply_*_importer tools.",
			inputSchema: z.object({
				paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
				settings: importerSettingsSchema,
				replace: z.boolean().optional().describe("Reset unspecified fields to type defaults before applying."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_importer_settings", args)
	);
	server.registerTool(
		"get_texture_importer_result",
		{
			title: "Get texture importer result",
			description:
				"Inspect one PNG/JPEG/BMP/WebP/GIF/TIFF/TGA/PSD/PSB/SVG/Radiance-HDR/OpenEXR texture under its exact source/settings fingerprint without modifying files. TGA, PSD-v1, and PSB-v2 use bounded shared decoders; Photoshop 8-bit channels retain identity-uint8, big-endian 16-bit samples use bounded-uint16-to-rgba8-v1, and big-endian IEEE-754 32-bit linear-float raw/RLE/ZIP/byte-planar ZIP-predicted samples use bounded-linear-float32-to-rgba8-v1 with exact depth/model evidence and non-finite rejection. HDR/EXR use bounded linear-float decoding, format-preserving resized output, exact range/non-finite evidence, ACES preview, RGBA32F readable data, and six face previews for valid 2:1 equirectangular panoramas; tiled/deep/multipart EXR is rejected explicitly. Returns current/stale state, all portable artifact paths, mip evidence, color-space overrides, warnings, and source/output probes.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative supported texture asset path, including .hdr or .exr.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_texture_importer_result", args)
	);
	server.registerTool(
		"apply_texture_importer",
		{
			title: "Apply texture importer",
			description:
				"After confirm=true, execute one supported texture's current importer under the exact fingerprint returned by get_texture_importer_result. Atomically publishes project-local preview artifacts, applies max-size/aspect-safe kernel resizing, alpha handling, deterministic encoding, texture-type color-space semantics, two runtime mip variants, and optional bounded CPU-readable output. HDR/EXR stay linear and high dynamic in format-preserving runtime output while adding ACES and cubemap-face previews. TGA, 8/16/32-bit PSD-v1, 8/16/32-bit PSB-v2, HDR, and EXR use the same bounded shared backends in editor and CLI builds; builds publish the same portable .bjstexture.json redirect contract.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative supported texture asset path, including .hdr or .exr."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_texture_importer_result."),
					confirm: z.boolean().describe("Must be true to publish or replace imported preview artifacts."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_texture_importer", args)
	);
	server.registerTool(
		"inspect_psd_layer_extraction",
		{
			title: "Inspect layered Photoshop extraction",
			description:
				"Authored TySh FillFlag, StrokeFlag, FillFirst, FillColor, StrokeColor, and OutlineWidth are decoded per style run and executed through bounded-authored-text-fill-stroke-v1 using a bounded centered MSDF outline. The plan returns raw and normalized paint state, exact order, fill/stroke sample counts, and stroke-raster evidence; missing enabled colors and unsafe widths reject. " +
				"Document-global Txt2 EngineData2 is decoded through its numeric editor/style hierarchy, associated by exact TySh TextIndex, and union-split with TySh style boundaries. Fractions, Ordinals, and StylisticAlternates execute exact HarfBuzz frac/ordn/salt=0/1 with raw source-run, font-support, effective-feature, and bounded-global-txt2-engine-data2-v1 evidence; duplicate indices, mismatched text, unsafe coverage, and surrogate splits remain explicit warnings instead of guessed associations. Authored TySh Language indices use the bounded Photoshop mapping to exact BCP47 tags, override a caller shaping language per style run, and drive HarfBuzz/OpenType localized forms (including locl) through the same language used for dictionary hyphenation; raw index, mapped tag, effective language, source, and bounded-authored-photoshop-language-v1 evidence are returned, while unknown indices reject. Authored TySh Wari-chu preserves exact EnableWariChu, line count, line gap, subline scale, widow/orphan minima, and all eight justification modes; enabled runs execute as atomic balanced horizontal sublines or right-to-left vertical subcolumns with exact per-block/per-row range, cluster, glyph, advance, alignment, spacing, and bounded-authored-wari-chu-v1 evidence. Unknown values, unsafe bounds, impossible break constraints, changed bytes, and stale plans reject. " +
				"Authored TySh OldStyle, Swash, Titling, Ornaments, and SlashedZero are decoded as exact Booleans and execute through the leased project font as HarfBuzz onum/swsh/titl/ornm/zero=0/1. The plan reports every raw state, effective feature, exact GSUB support flag, and bounded-authored-character-opentype-v1 evidence; malformed values reject and unsupported tags remain explicit without fallback. " +
				"Authored TySh FigureStyle decodes exact integer modes 0 Default, 1 Tabular Lining, 2 Proportional Oldstyle, 3 Proportional Lining, and 4 Tabular Oldstyle, forces all four lnum/onum/pnum/tnum values, overrides conflicting caller values and the narrower OldStyle switch, and returns exact support plus bounded-authored-figure-style-v1 evidence. Non-integers and unknown modes reject. " +
				"Authored TySh ConnectionForms decodes as an exact Boolean and executes HarfBuzz calt=0/1 contextual alternates through bounded-authored-connection-forms-v1. The plan reports the raw state, effective value, exact GSUB support, glyph evidence, and no-fallback boundary; malformed values reject. " +
				"Authored TySh ContextualLigatures decodes as an exact Boolean and executes HarfBuzz clig=0/1 contextual ligatures through bounded-authored-contextual-ligatures-v1. The plan reports the raw state, effective value, exact GSUB support, glyph evidence, and no-fallback boundary; malformed values reject. " +
				"Authored TySh HindiNumbers decodes as an exact Boolean and deterministically preserves Arabic/Western digits when false or substitutes Hindi/Arabic-Indic digits when true before shaping; the plan reports effective digit type and changed-character count. " +
				"Authored TySh Kashida decodes exact integer states 0 Off and 1 On. On fully justified Arabic box-text lines, Unicode 13 joining eligibility drives bounded contextual U+0640 insertion and complete HarfBuzz reshaping without word-space expansion; exact eligible/inserted/advance/model evidence is returned, while non-integers and unknown modes reject. " +
				"Authored TySh DiacriticPos decodes exact integer modes 0 OpenType, 1 Loose, 2 Medium, and 3 Tight. In horizontal text HarfBuzz supplies exact OpenType mark/mkmk placement and bounded-authored-diacritic-position-v1 adds explicit above/below em-relative preset shifts; vertical text reports inactive-vertical-text. Every affected horizontal glyph reports its original/effective offset and pixel adjustment without claiming Photoshop pixel identity. Non-integers and unknown modes reject. " +
				"Authored TySh CharacterDirection decodes exact integer modes 0 Default, 1 Left-to-Right, and 2 Right-to-Left, forces per-run UAX #9 direction without replacing paragraph base direction, and reports raw mode, overridden-character count, resolved embedding levels, and bounded-authored-character-direction-v1 evidence; non-integers and unknown modes reject. " +
				"Inspect bounded Photoshop PSD-v1 or Large Document PSB-v2 layers and plan PNG extraction without writing files. PSB-v2 uses exact 64-bit layer/mask, layer-info, channel, 8B64, and specification-defined 8BIM tagged-block lengths plus 32-bit RLE row sizes under the same bounded byte, dimension, pixel, layer, and allocation limits; document version, format, and primary/Layr/Lr16/Lr32 layer-info source are returned explicitly. Big-endian 16-bit channels convert through bounded-uint16-to-rgba8-v1; big-endian IEEE-754 32-bit linear-float raw, RLE, ZIP, and byte-planar ZIP-predicted color/transparency/mask/pattern channels convert through bounded-linear-float32-to-rgba8-v1 with non-finite rejection. Document and channel depth, sample-byte length, compression, and conversion model are returned exactly. TySh text includes exact authored BaselineDirection upright/mixed/Tate-Chu-Yoko semantics, ProportionalMetrics OpenType palt state, Kana OpenType hkna state, Ruby OpenType ruby state, JapaneseAlternateFeature Normal/Traditional/Expert/JIS78 state, and bounded glyph/block/feature execution evidence when authored rerasterization is requested. Placement, linked resources, nested embedded documents, groups, masks, effects, adjustments, patterns, and payload publication retain exact evidence. Enabled embedded or explicitly bound external rasters execute the 45 supported ordered smart-filter types through their explicit bounded algorithm models, exact radius, threshold, angle, distance, amount, distribution, monochromatic state, random seed, authored RGB foreground/background colors, Reduce Noise preset/JPEG/color/sharpen/channel/preserve-details controls, Color Halftone maximum radius/four CMYK angles, Crystallize cell size/seed, Mezzotint pattern/seed, Mosaic cell size/units, Pointillize cell size/seed/background, Clouds seed/foreground/background, Difference Clouds seed/foreground/background, Diffuse mode/seed, Emboss angle/height/amount, Extrude type/size/depth/depth-mode/seed/solid-front/mask-incomplete controls, Tiles count/maximum-offset/fill/seed/foreground/background controls, Trace Contour level/edge controls, Wind method/direction controls, De-Interlace eliminate/reconstruction controls, Fibers variance/strength/seed/foreground/background, Lens Flare brightness/pixel center/lens type, Smart Sharpen amount/radius/threshold/angle/accuracy/blur/preset/shadow/highlight controls, Unsharp Mask amount/radius/threshold controls, method, mode, quality, custom-shape name/identifier/kernel, and work limits, and 20 exact blend modes; Add Noise executes exact signed-seed Uniform or Gaussian sampling through bounded-seeded-add-noise-smart-filter-v1, Dust & Scratches executes exact integer radius/threshold through bounded-thresholded-median-dust-and-scratches-smart-filter-v1, Reduce Noise executes bounded channel/chroma/deblock/sharpen processing through bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1, Color Halftone executes four-angle CMYK dot screens through bounded-cmyk-screen-color-halftone-smart-filter-v1, Crystallize executes deterministic Voronoi cells through bounded-seeded-voronoi-crystallize-smart-filter-v1, Mezzotint executes deterministic seeded dot/line/stroke patterns through bounded-seeded-mezzotint-smart-filter-v1, Mosaic executes premultiplied cell averaging through bounded-premultiplied-mosaic-smart-filter-v1, Pointillize executes seeded random dots over the exact authored RGB background through bounded-seeded-authored-canvas-pointillize-smart-filter-v2, Clouds executes seeded five-octave value noise between the exact authored RGB foreground/background colors through bounded-seeded-fractal-clouds-smart-filter-v1, Difference Clouds applies exact per-channel Difference composition between the source and that authored-color field through bounded-seeded-difference-clouds-smart-filter-v1, Diffuse executes seeded Normal/Darken Only/Lighten Only/Anisotropic redistribution through bounded-seeded-four-mode-diffuse-smart-filter-v1, Emboss executes directional centered color-detail relief through bounded-directional-color-emboss-smart-filter-v1, Extrude executes deterministic seeded cell depth plus block-face or pyramid-relief shading through bounded-seeded-cell-relief-extrude-smart-filter-v1, Tiles executes deterministic seeded per-tile displacement over the exact fill through bounded-seeded-offset-tiles-smart-filter-v1, Trace Contour executes per-channel Lower/Upper threshold boundaries through bounded-per-channel-threshold-trace-contour-smart-filter-v1, Wind executes deterministic directional horizontal streak extension through bounded-directional-horizontal-wind-smart-filter-v1, De-Interlace executes deterministic field-line duplication/interpolation through bounded-field-reconstruction-de-interlace-smart-filter-v1, Fibers executes seeded anisotropic vertical value fields between exact authored colors through bounded-seeded-anisotropic-fibers-smart-filter-v1, Lens Flare executes bounded core/halo/ray/ghost profiles at the exact pixel center through bounded-parameterized-lens-flare-smart-filter-v1, Smart Sharpen executes adaptive Gaussian/Lens/Motion deconvolution with threshold and tonal protection through bounded-adaptive-smart-sharpen-v1, Unsharp Mask executes thresholded Gaussian detail recovery through bounded-thresholded-gaussian-unsharp-mask-v1, and Shape Blur executes the built-in Heart Card or an exact explicitly bound project-raster alpha/luminance kernel whose bytes and coverage evidence enter the lease. Filtered and unfiltered sources traverse identical authored corners, standard presets, exact tensor grids, or exact piecewise quilt lattices; then optional document-space FEid/FXid 8/16/32-bit raw/RLE/ZIP/ZIP-predicted mask coverage interpolates the two placements with premultiplied bilinear sampling and bounded tessellation. PSD-stored external paths are never followed. Unknown baseline-direction or JapaneseAlternateFeature values, warps, unsupported filters/blends, missing kernel bindings or malformed filter masks, malformed parameters/lattices/slices or sources, ambiguity, excessive bounds/work, stale files, and conflicts block explicitly. The lease includes source kind/path/format/depth/conversion/layer-info source, bytes/hashes, dimensions, filter type/order/parameters/algorithm/blend/mask provenance and coverage, Shape Blur kernel source/hash/channel/inversion/coverage, transform, preset style/value/perspective/orientation, mesh order/patches/points/slices/tessellation, bounds, sampling, actions, and all existing evidence.",
			inputSchema: z
				.object({
					...psdLayerExtractionOptionsSchema,
					offset: z.number().int().min(0).max(4095).optional().describe("First Photoshop layer record returned; defaults to 0."),
					limit: z.number().int().min(1).max(100).optional().describe("Maximum layer records returned; defaults to 50."),
				})
				.strict()
				.superRefine(validatePsdLayerExtractionOptions),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_psd_layer_extraction", args)
	);
	server.registerTool(
		"extract_psd_layers",
		{
			title: "Extract layered Photoshop sprites",
			description:
				"After confirm=true, reproduce the exact bounded 8/16/32-bit PSD-v1 or PSB-v2 source format, including PSB 64-bit section/channel/tagged-block lengths, primary/Layr/Lr16/Lr32 layer-info selection, 32-bit RLE row tables, and the inspected channel conversion model, before publishing any output. " +
				"After confirm=true, authored TySh fill/stroke fields are re-decoded from the leased bytes and rendered with the same exact colors, enabled states, centered outline width, paint order, sample evidence, and bounded-authored-text-fill-stroke-v1 model; missing enabled colors, unsafe widths, changed bytes, and stale plans reject before publication. " +
				"Global Txt2 EngineData2 TextIndex association, union boundaries, and frac/ordn/salt states are re-decoded from the leased bytes and exact project font before deterministic publication; ambiguity, mismatched coverage/text, changed bytes, and stale plans reject. " +
				"Authored TySh OldStyle, Swash, Titling, Ornaments, and SlashedZero are re-decoded from the leased bytes and execute as exact onum/swsh/titl/ornm/zero values through the exact leased project font with support and bounded-authored-character-opentype-v1 evidence; malformed values, changed fonts, changed bytes, and stale plans reject. " +
				"Authored TySh FigureStyle is re-decoded from the leased bytes and deterministically republishes the exact mutually explicit lnum/onum/pnum/tnum mode through bounded-authored-figure-style-v1; unknown modes, changed fonts/bytes, and stale plans reject. " +
				"Authored TySh ConnectionForms is re-decoded from the leased bytes and deterministically republishes exact calt=0/1 contextual alternates through bounded-authored-connection-forms-v1; malformed values, changed fonts/bytes, and stale plans reject. " +
				"Authored TySh ContextualLigatures is re-decoded from the leased bytes and deterministically republishes exact clig=0/1 contextual ligatures through bounded-authored-contextual-ligatures-v1; malformed values, changed fonts/bytes, and stale plans reject. " +
				"Authored TySh HindiNumbers is re-decoded from the leased bytes and republishes its exact per-run Arabic/Western or Hindi/Arabic-Indic digit choice through bounded-authored-hindi-numbers-v1; malformed values and missing transformed glyphs reject without fallback. " +
				"Authored TySh Kashida is re-decoded from leased bytes and republishes exact Off/On character eligibility, Unicode 13 join selection, contextual HarfBuzz reshaping, inserted-Tatweel counts, and advance evidence through bounded-authored-kashida-justification-v1; malformed or unknown modes, missing glyphs, changed bytes/fonts, and stale plans reject. " +
				"Authored TySh DiacriticPos is re-decoded from leased bytes and republishes exact OpenType/Loose/Medium/Tight state, affected horizontal combining-mark glyphs, above/below placement, original/effective HarfBuzz offsets, pixel shifts, and bounded-authored-diacritic-position-v1 evidence; vertical text reports inactive-vertical-text, while malformed or unknown modes, changed bytes/fonts, and stale plans reject. " +
				"Authored TySh CharacterDirection is re-decoded from leased bytes and republishes exact Default/Left-to-Right/Right-to-Left per-run UAX #9 behavior through bounded-authored-character-direction-v1; malformed or unknown modes, changed bytes/fonts, and stale plans reject. " +
				"After confirm=true, authored TySh Language indices are revalidated from the leased PSD and project font, mapped to exact BCP47 tags, and applied per style run to HarfBuzz/OpenType localized forms and dictionary hyphenation with exact raw/mapped/effective/source execution evidence; unknown indices, changed bytes, and stale plans reject before publication. Authored TySh Wari-chu is likewise revalidated and publishes the same atomic balanced horizontal sublines or right-to-left vertical subcolumns with exact seven-field and per-row execution evidence; unknown values and impossible breaks reject before publication. " +
				"After confirm=true, reproduce the exact inspected plan and atomically publish deterministic RGBA PNGs plus selected smart-object payloads. Authored TySh BaselineDirection is revalidated and executes upright, Unicode-orientation-aware mixed, or atomic horizontal Tate-Chu-Yoko layout; ProportionalMetrics, Kana, Ruby, and JapaneseAlternateFeature revalidate and execute exact HarfBuzz palt=0/1, hkna=0/1, ruby=0/1, and mutually exclusive trad/expt/jp78 states through the same inspected project-font lease. Enabled embedded or explicitly bound external rasters are re-decoded; the 45 supported smart-filter types re-execute in order through their exact bounded algorithm, authored parameters/work, blend, and opacity settings, including exact signed-seed Uniform/Gaussian Add Noise, exact integer-radius/threshold Dust & Scratches, full-parameter Reduce Noise through bounded-channel-chroma-deblock-reduce-noise-smart-filter-v1, exact-radius/four-angle Color Halftone through bounded-cmyk-screen-color-halftone-smart-filter-v1, exact-cell/seed Crystallize through bounded-seeded-voronoi-crystallize-smart-filter-v1, exact-pattern/seed Mezzotint through bounded-seeded-mezzotint-smart-filter-v1, exact-cell Mosaic through bounded-premultiplied-mosaic-smart-filter-v1, exact-cell/seed/authored-background Pointillize through bounded-seeded-authored-canvas-pointillize-smart-filter-v2, exact-seed/authored-foreground/background Clouds through bounded-seeded-fractal-clouds-smart-filter-v1, exact-seed/authored-foreground/background Difference Clouds through bounded-seeded-difference-clouds-smart-filter-v1, exact-mode/seed Diffuse through bounded-seeded-four-mode-diffuse-smart-filter-v1, exact-angle/height/amount Emboss through bounded-directional-color-emboss-smart-filter-v1, exact-type/size/depth/depth-mode/seed/solid-front/mask-incomplete Extrude through bounded-seeded-cell-relief-extrude-smart-filter-v1, exact-count/maximum-offset/fill/seed/authored-color Tiles through bounded-seeded-offset-tiles-smart-filter-v1, exact-level/edge Trace Contour through bounded-per-channel-threshold-trace-contour-smart-filter-v1, exact-method/direction Wind through bounded-directional-horizontal-wind-smart-filter-v1, exact-field/method De-Interlace through bounded-field-reconstruction-de-interlace-smart-filter-v1, exact-variance/strength/seed/authored-foreground/background Fibers through bounded-seeded-anisotropic-fibers-smart-filter-v1, exact-brightness/pixel-center/lens-type Lens Flare through bounded-parameterized-lens-flare-smart-filter-v1, full-parameter Smart Sharpen through bounded-adaptive-smart-sharpen-v1, exact-parameter Unsharp Mask through bounded-thresholded-gaussian-unsharp-mask-v1, and exact Heart Card identity or leased custom-raster Shape Blur kernel source/hash/channel/inversion/coverage evidence; enabled FEid/FXid masks re-decode and interpolate unfiltered/filtered placements through their exact depth/compression/bounds/linked/extend evidence; then projective, analytical preset, or exact tensor/piecewise-quilt custom-Bezier placement enters layer masks, effects, clipping, adjustments, and groups. Every current selected file must reproduce the lease; PSD-stored paths are never used. Exact hashes, filter parameter/color/algorithm/blend/mask evidence, baseline-direction, proportional-metrics, Kana, Ruby, and Japanese-alternate evidence, preset/mesh evidence, collision-safe paths, no-overwrite protection, temporary publication, and rollback cover every output. Unknown baseline-direction or JapaneseAlternateFeature values, warps, unsupported filters/blends/sources, missing Shape Blur bindings or malformed masks, excessive work, and aliases remain explicit boundaries.",
			inputSchema: z
				.object({
					...psdLayerExtractionOptionsSchema,
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact SHA-256 fingerprint returned by inspect_psd_layer_extraction."),
					confirm: z.literal(true).describe("Explicit confirmation required to publish extracted PNG assets."),
				})
				.strict()
				.superRefine(validatePsdLayerExtractionOptions),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("extract_psd_layers", args)
	);
	server.registerTool(
		"inspect_psd_smart_object_payload_replacement",
		{
			title: "Inspect PSD smart-object payload replacement",
			description:
				"Plan exact replacement of 1-128 non-overlapping embedded liFD smart-object payloads in one project PSD-v1 asset without writing files. A backward-compatible resourceIndex selects a top-level record; resourcePath selects exact 1-8-level embedded PSD-v1 ancestry for recursive editing. Every replacement binds that exact location to an absolute local file explicitly selected by the user; PSD-stored paths and aliases are never followed. The plan recursively rebuilds every containing PSD record, re-reads and hashes source/replacement/output bytes, validates every rewritten PSD, and returns a leased create/reuse/conflict action for a new contained project .psd. The source PSD and different destination bytes are never overwritten.",
			inputSchema: z.object(psdSmartObjectPayloadReplacementOptionsSchema).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_psd_smart_object_payload_replacement", args)
	);
	server.registerTool(
		"replace_psd_smart_object_payloads",
		{
			title: "Replace PSD smart-object payloads",
			description:
				"After confirm=true, reproduce the exact lease from inspect_psd_smart_object_payload_replacement and atomically create or reuse a contained project PSD copy with the selected top-level or recursively nested embedded liFD payload bytes. Every containing embedded PSD-v1 document is rebuilt and validated. The project source and every explicit absolute replacement file are re-read; any same-size or different-size change invalidates the lease. The source PSD is never modified, PSD-stored paths are never followed, and different destination bytes are never overwritten.",
			inputSchema: z
				.object({
					...psdSmartObjectPayloadReplacementOptionsSchema,
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact SHA-256 fingerprint returned by inspect_psd_smart_object_payload_replacement."),
					confirm: z.literal(true).describe("Explicit confirmation required to create or reuse the replacement PSD copy."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("replace_psd_smart_object_payloads", args)
	);
	server.registerTool(
		"get_texture_platform_overrides",
		{
			title: "Get texture platform overrides",
			description:
				"Read one texture asset's complete Web/Desktop override map, exact importer fingerprint, and resolved effective settings for both targets. Web builds execute Web values; Electron/Desktop builds execute Desktop values; disabled or absent targets inherit Default settings. Target selection participates in editor/CLI cache keys and result evidence.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative texture asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_texture_platform_overrides", args)
	);
	server.registerTool(
		"set_texture_platform_overrides",
		{
			title: "Set texture platform overrides",
			description:
				"Atomically replace the complete closed Web/Desktop texture override map under the exact fingerprint from get_texture_platform_overrides. Each enabled target may override max size, resize kernel, compression quality, mip generation, and CPU readability. Send an empty map to inherit Default settings everywhere, then run the matching Web or Electron build profile.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative texture asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_texture_platform_overrides."),
					overrides: z
						.object({ web: texturePlatformOverrideSchema.optional(), desktop: texturePlatformOverrideSchema.optional() })
						.strict()
						.describe("Complete replacement map; omission of a target removes its stored override."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_texture_platform_overrides", args)
	);
	server.registerTool(
		"get_audio_importer_result",
		{
			title: "Get audio importer result",
			description:
				"Inspect one audio asset's exact source/settings fingerprint and deterministic project-local imported artifact. Returns current/stale state plus source/output codec, container, duration, sample rate, channel count, bit rate, byte size, transcode status, and effective runtime load type without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative MP3/OGG/WAV/FLAC/M4A asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_audio_importer_result", args)
	);
	server.registerTool(
		"apply_audio_importer",
		{
			title: "Apply audio importer",
			description:
				"After confirm=true, apply one audio asset's current importer under the exact fingerprint returned by get_audio_importer_result. Uses bounded shell-free FFmpeg/FFprobe execution to preserve or transcode the container, set sample rate, downmix mono, normalize loudness, apply quality, and atomically publish the preview/runtime artifact with probe evidence.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_audio_importer", args)
	);
	server.registerTool(
		"get_video_importer_result",
		{
			title: "Get video importer result",
			description:
				"Inspect one video asset's exact source/settings fingerprint and deterministic project-local imported artifact. Returns current/stale state plus container, duration, dimensions, frame rate, video/audio codecs, bit rates, byte sizes, transcode status, and the effective output path without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative MP4/WebM/OGV/MOV asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_video_importer_result", args)
	);
	server.registerTool(
		"apply_video_importer",
		{
			title: "Apply video importer",
			description:
				"After confirm=true, apply one video's importer under the exact fingerprint returned by get_video_importer_result. Uses bounded shell-free FFmpeg/FFprobe execution to preserve or transcode MP4/WebM/OGV/MOV, cap dimensions without stretching, map quality, optionally remove audio, and atomically publish the preview/runtime artifact with probe evidence.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_video_importer", args)
	);
	server.registerTool(
		"get_font_importer_result",
		{
			title: "Get font importer result",
			description:
				"Inspect one font asset's exact source/settings fingerprint and deterministic imported artifacts. Reports dynamic/bitmap/SDF/MSDF mode, family, glyph and missing-codepoint counts, atlas pages and dimensions, byte sizes, and portable manifest paths without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative TTF/OTF/WOFF/WOFF2 font asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_font_importer_result", args)
	);
	server.registerTool(
		"apply_font_importer",
		{
			title: "Apply font importer",
			description:
				"After confirm=true, apply one font's importer under the exact fingerprint returned by get_font_importer_result. Dynamic mode publishes the source font and browser FontFace metadata; bitmap, SDF, and genuine MSDF modes generate packed Unicode glyph pages, metrics, kerning, and a portable runtime manifest using a bundled WASM atlas generator.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_font_importer", args)
	);
	server.registerTool(
		"get_material_importer_result",
		{
			title: "Get material importer result",
			description:
				"Inspect one .material or Wavefront .mtl asset's exact source/settings fingerprint and current imported evidence. Reports Babylon/Node/MTL type, project/embedded/remote texture references, missing textures, extracted PNG/JPEG files, Node Material compile errors/warnings/statistics, and overall validity without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative .material or .mtl asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_material_importer_result", args)
	);
	server.registerTool(
		"apply_material_importer",
		{
			title: "Apply material importer",
			description:
				"After confirm=true, apply one material's importer under the exact fingerprint returned by get_material_importer_result. Validates project texture references, extracts bounded embedded PNG/JPEG data into deterministic files when enabled, compiles Babylon Node Material graphs when enabled, and atomically publishes the preview/report artifact.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_material_importer", args)
	);
	server.registerTool(
		"get_model_importer_result",
		{
			title: "Get model importer result",
			description:
				"Inspect one GLB, glTF, Babylon, OBJ, STL, FBX, DAE, 3DS, MS3D, B3D, uncompressed DirectX .x, LightWave LWO, ASCII AutoCAD DXF, or Blender `.blend` asset under its exact source/settings/dependency fingerprint. Returns current/stale artifact status; a missing or stale artifact has result=null and must be executed with apply_model_importer using the returned fingerprint. A current result reports native, Assimp-to-GLB2, or Blender-to-GLB2 conversion evidence, tracked dependencies, unit scaling, geometry/resources, Humanoid/Generic rig validation, Optimize Game Object candidates/removals, retargeted animation tracks, requested/automatic/missing exposed transforms, warnings, errors, and validity. Binary DXF is rejected explicitly. Blender 3.0+/Zstandard sources require an installed Blender executable configured through BJS_EDITOR_BLENDER_EXECUTABLE.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_importer_result", args)
	);
	server.registerTool(
		"set_model_rig_optimization",
		{
			title: "Set model rig optimization",
			description:
				"Configure Unity-style Optimize Game Object for one model asset. When enabled on a Generic or Humanoid rig, importer execution removes skeleton-only Transform nodes, retargets their animation tracks to internal Babylon bones, flattens the retained hierarchy, and preserves requested hierarchy paths or unique bone names as synchronized script/attachment proxies. Returns a new exact importer fingerprint; inspect it with get_model_importer_result before apply_model_importer.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
				enabled: z.boolean(),
				exposedTransforms: z
					.array(z.string().min(1).max(512))
					.max(128)
					.optional()
					.describe("Full hierarchy paths or unique bone names to keep available for scripts, IK targets, sockets, and attachments."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_rig_optimization", args)
	);
	server.registerTool(
		"get_model_animation_clips",
		{
			title: "Get model animation clips",
			description:
				"Read one model asset's exact importer fingerprint, persisted Unity-style clip definitions, and latest processed source/output AnimationGroup evidence. Source evidence includes group names, ranges, FPS, track/key counts, and targets; generated evidence includes rebased ranges, loop controls, target masks, and root-motion resolution. Apply an unconfigured Model Importer once when no source evidence exists.",
			inputSchema: z
				.object({
					path: z
						.string()
						.min(1)
						.max(1024)
						.describe(
							"Project-relative GLB, glTF, Babylon, OBJ, STL, FBX, DAE, 3DS, MS3D, B3D, DirectX .x, LightWave LWO, ASCII AutoCAD DXF, or Blender `.blend` asset path."
						),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_animation_clips", args)
	);
	server.registerTool(
		"set_model_animation_clips",
		{
			title: "Set model animation clips",
			description:
				"Atomically replace up to 64 per-model animation clip definitions under the exact fingerprint from get_model_animation_clips. Each clip slices one imported AnimationGroup by frame range, rebases it to frame zero, optionally closes the loop pose, filters exact animated targets, and validates selected position/Y-rotation root-motion tracks. This updates importer metadata only; inspect and apply the returned model-importer fingerprint to publish the processed Babylon model.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_animation_clips."),
					clips: z.array(modelAnimationClipSchema).max(64).describe("Complete replacement clip set; send an empty array to preserve source groups unchanged."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_animation_clips", args)
	);
	server.registerTool(
		"get_model_material_remaps",
		{
			title: "Get model material remaps",
			description:
				"Read one model asset's exact importer fingerprint, complete persisted material-remap table, and latest executed source-material evidence. Evidence reports exact source names, duplicate material-object counts, mesh/submesh reference counts, texture counts, replacement resolution, warnings, and errors. Apply an unconfigured Model Importer once when source evidence is empty.",
			inputSchema: z
				.object({
					path: z
						.string()
						.min(1)
						.max(1024)
						.describe(
							"Project-relative GLB, glTF, Babylon, OBJ, STL, FBX, DAE, 3DS, MS3D, B3D, DirectX .x, LightWave LWO, ASCII AutoCAD DXF, or Blender `.blend` asset path."
						),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_material_remaps", args)
	);
	server.registerTool(
		"set_model_material_remaps",
		{
			title: "Set model material remaps",
			description:
				"Atomically replace up to 128 exact source-material to project .material mappings under the fingerprint from get_model_material_remaps. The importer resolves contained replacement assets, supports direct and MultiMaterial/submesh references, records replacement assets as build dependencies, and invalidates its exact lease when they change. This updates metadata only; inspect and apply the returned fingerprint to publish the processed model.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_material_remaps."),
					remaps: z.array(modelMaterialRemapSchema).max(128).describe("Complete replacement table; send an empty array to remove every remap."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_material_remaps", args)
	);
	server.registerTool(
		"get_model_material_search",
		{
			title: "Get model material search",
			description:
				"Read one model asset's exact importer fingerprint, Unity-style material naming/search configuration, explicit-remap priority, and latest deterministic match evidence. The result reports the generated candidate name, searched material count, ordered candidate paths, unique match, and ambiguity for every imported source material.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_material_search", args)
	);
	server.registerTool(
		"set_model_material_search",
		{
			title: "Set model material search",
			description:
				"Atomically replace one model's automatic material naming and search configuration under the exact fingerprint from get_model_material_search. Search can be disabled, limited to the adjacent Materials folder, walk parent Materials folders nearest-first, or cover the project. Naming can use the source material, first base-texture name with source fallback, or model-plus-material. Explicit material remaps always take priority; ambiguous best-rank matches are never guessed.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_material_search."),
					naming: z.enum(["sourceMaterial", "baseTextureName", "modelAndMaterial"]).describe("Complete automatic naming mode."),
					search: z.enum(["none", "local", "recursiveUp", "projectWide"]).describe("Complete automatic search scope."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_material_search", args)
	);
	server.registerTool(
		"get_model_platform_overrides",
		{
			title: "Get model platform overrides",
			description:
				"Read one model asset's complete Web/Desktop override map, exact importer fingerprint, and fully resolved effective settings for both targets. Web build profiles execute Web values; Electron profiles execute Desktop values; disabled or absent targets inherit Default settings. The selected target participates in editor/CLI cache keys and result evidence.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_platform_overrides", args)
	);
	server.registerTool(
		"set_model_platform_overrides",
		{
			title: "Set model platform overrides",
			description:
				"Atomically replace the complete closed Web/Desktop model-import override map under the exact fingerprint from get_model_platform_overrides. Each enabled target may override scale/unit conversion, material/texture/animation inclusion, rig optimization, collider generation, mesh compression/optimization/welding, normals/tangents, and up to eight generated LOD levels. Send an empty overrides object to inherit Default settings everywhere; then run the matching Web or Electron build profile.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_platform_overrides."),
					overrides: z
						.object({ web: modelPlatformOverrideSchema.optional(), desktop: modelPlatformOverrideSchema.optional() })
						.strict()
						.describe("Complete replacement map; omission of a target removes its stored override."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_platform_overrides", args)
	);
	server.registerTool(
		"inspect_model_material_extraction",
		{
			title: "Inspect model material extraction",
			description:
				"Plan Unity-style extraction of every embedded model material into editable project .material assets without modifying files. The bounded plan uses the sibling Materials folder by default, sanitizes portable filenames, reports create/reuse/conflict decisions, reuses only content-equivalent assets, and never overwrites an existing file.",
			inputSchema: z
				.object({
					path: z
						.string()
						.min(1)
						.max(1024)
						.describe(
							"Project-relative GLB, glTF, Babylon, OBJ, STL, FBX, DAE, 3DS, MS3D, B3D, DirectX .x, LightWave LWO, ASCII AutoCAD DXF, or Blender `.blend` model path."
						),
					destinationFolder: z.string().min(6).max(1024).optional().describe("Optional contained project Assets folder; defaults to a sibling Materials folder."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_model_material_extraction", args)
	);
	server.registerTool(
		"extract_model_materials",
		{
			title: "Extract model materials",
			description:
				"After confirm=true, execute the exact collision-safe plan from inspect_model_material_extraction. Atomically creates new editable .material assets, reuses only equivalent existing assets, rolls back newly created files on failure, and persists exact source-material remaps so editor preview and editor/CLI builds use the extracted assets. Existing files are never overwritten.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					destinationFolder: z
						.string()
						.min(6)
						.max(1024)
						.optional()
						.describe("Must match the optional destinationFolder used while inspecting; omission uses the same sibling Materials default."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by inspect_model_material_extraction."),
					confirm: z.boolean().describe("Must be true to create material assets and update the model importer remaps."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("extract_model_materials", args)
	);
	server.registerTool(
		"inspect_model_texture_extraction",
		{
			title: "Inspect model texture extraction",
			description:
				"After embedded materials have been extracted, plan Unity-style extraction of their embedded PNG/JPEG payloads into editable project textures without modifying files. The exact bounded plan deduplicates identical images, validates signatures and size limits, defaults to a sibling Textures folder, reports create/reuse/conflict decisions, and lists every editable material that will be rewritten.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path whose exact material remaps identify editable materials."),
					destinationFolder: z.string().min(6).max(1024).optional().describe("Optional contained project Assets folder; defaults to a sibling Textures folder."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_model_texture_extraction", args)
	);
	server.registerTool(
		"extract_model_textures",
		{
			title: "Extract model textures",
			description:
				"After confirm=true, execute the exact plan from inspect_model_texture_extraction. Atomically creates or content-reuses editable PNG/JPEG assets and rewrites the model's extracted .material files from embedded data to project texture paths. Existing textures are never overwritten, material originals are transactionally backed up, and all created files/material changes roll back on failure.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					destinationFolder: z.string().min(6).max(1024).optional().describe("Must match inspection; omission uses the sibling Textures default."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by inspect_model_texture_extraction."),
					confirm: z.boolean().describe("Must be true to create textures and rewrite editable material files."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("extract_model_textures", args)
	);
	server.registerTool(
		"get_model_authored_lods",
		{
			title: "Get authored model LODs",
			description:
				"Read one model asset's exact importer fingerprint, complete artist-authored LOD group table, latest applied geometry/deformation evidence, and deterministic suggestions for exact Name_LOD0/Name_LOD1/... mesh conventions. Apply an unconfigured Model Importer once when mesh-name suggestions are empty.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_authored_lods", args)
	);
	server.registerTool(
		"set_model_authored_lods",
		{
			title: "Set authored model LODs",
			description:
				"Atomically replace up to 128 explicit imported-mesh LOD groups under the exact fingerprint from get_model_authored_lods. Each mesh may appear once, every group has one exact LOD0 source and up to eight existing lower-detail meshes, and transition distances strictly increase. The next importer application validates all names before mutation, attaches Babylon runtime LOD switching, disables collisions on lower levels, preserves authored geometry/materials/skin/morph data, excludes assigned meshes from generated simplification, and serializes the links for editor and CLI builds.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_authored_lods."),
					groups: z.array(modelAuthoredLodGroupSchema).max(128).describe("Complete ordered replacement table; send an empty array to clear authored assignments."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_authored_lods", args)
	);
	server.registerTool(
		"get_model_generated_lods",
		{
			title: "Get generated model LODs",
			description:
				"Read one model asset's exact importer fingerprint, complete generated-LOD level table, and latest per-source execution evidence. Evidence includes deformation mode, source/output vertices and triangles, exact provenance count, preserved vertex/skin streams, reconstructed morph targets and animation tracks, actual reduction, transition distance, authored-LOD skips, bounded-processing errors, and warnings. Apply an unconfigured Model Importer once when generated evidence is empty.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative model asset path.") }).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_model_generated_lods", args)
	);
	server.registerTool(
		"set_model_generated_lods",
		{
			title: "Set generated model LODs",
			description:
				"Atomically replace up to eight ordered quadratic-error LOD definitions under the exact fingerprint from get_model_generated_lods. Distances must strictly increase and retained quality must strictly decrease. The next importer application generates bounded static, skinned, and morph-target LOD geometry; reconstructs bone streams and morph deltas from exact source-vertex provenance; preserves morph animation bindings, transforms, materials, and MultiMaterial slots; serializes runtime switching and influence synchronization metadata; and skips already-authored LOD meshes with diagnostics.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative model asset path."),
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by get_model_generated_lods."),
					levels: z.array(modelGeneratedLodSchema).max(8).describe("Complete ordered replacement level table; send an empty array to disable generation."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_model_generated_lods", args)
	);
	server.registerTool(
		"apply_model_importer",
		{
			title: "Apply model importer",
			description:
				"After confirm=true, execute one model asset's importer under the exact fingerprint from get_model_importer_result and atomically publish a processed Babylon model. Applies scale/unit conversion, Unity-style deterministic material search plus exact project-material remaps including MultiMaterial/submesh slots, bounded deformation-safe generated static/skinned/morph LODs, material/texture/animation inclusion, Humanoid/Generic rig analysis, Optimize Game Object with synchronized exposed attachment transforms, collision flags, welding, index optimization, normals/tangents policy, and bounded vertex quantization. Native formats, bounded Assimp-converted legacy formats, and Blender-converted modern `.blend` sources use the same processor. Modern Blender conversion uses exact argv, a bounded timeout/output/log contract, and BJS_EDITOR_BLENDER_EXECUTABLE discovery.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024),
					expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
					confirm: z.boolean(),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_model_importer", args)
	);
	server.registerTool(
		"get_animation_importer_result",
		{
			title: "Get animation importer result",
			description:
				"Inspect one .animation/.animations clip asset or .animator/.controller state-machine asset under its exact source/settings fingerprint. Reports source format, clip/track timing, source/output frame rates, source/resampled/output key counts, loop state, root-motion resolution, and Unity YAML controller layer/parameter/state/transition/Blend Tree/reference-binding diagnostics without modifying files.",
			inputSchema: z.object({ path: z.string().min(1).max(1024).describe("Project-relative .animation, .animations, .animator, or .controller asset path.") }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_animation_importer_result", args)
	);
	server.registerTool(
		"apply_animation_importer",
		{
			title: "Apply animation importer",
			description:
				"After confirm=true, execute one animation asset's importer under the exact fingerprint from get_animation_importer_result. Resamples clip curves or converts bounded Unity multi-document YAML Animator Controllers into portable editor-controller artifacts with explicit Motion/AvatarMask binding requirements, diagnostics, and unsupported-feature evidence, then publishes atomically.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024),
				expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
				confirm: z.boolean(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_animation_importer", args)
	);

	server.registerTool(
		"get_asset_registry_status",
		{
			title: "Get asset registry status",
			description: "Report the persistent GUID-first asset registry version, entry/hash counts, generation time, and duplicate GUID conflicts.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_asset_registry_status", {})
	);
	server.registerTool(
		"get_asset_indexing_status",
		{
			title: "Get background asset indexing status",
			description:
				"Read isolated-worker availability/runtime, default concurrency, the active background rebuild/refresh phase and file progress, plus up to 20 recent completed, cancelled, or failed jobs. This never starts a scan.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_asset_indexing_status", {})
	);
	server.registerTool(
		"start_asset_indexing",
		{
			title: "Start background asset indexing",
			description:
				"Start one non-blocking worker-backed asset registry job. Rebuild discovers the complete contained project index; refresh rescans exactly 1-100 contained paths. Returns a job id immediately; poll get_asset_indexing_status for authoritative completion. The previous registry remains authoritative until atomic publication.",
			inputSchema: z.object({
				mode: z.enum(["rebuild", "refresh"]).optional().describe("Full rebuild by default, or bounded path refresh."),
				paths: z.array(z.string().min(1).max(1024)).min(1).max(100).optional().describe("Required only for refresh mode; project-relative files or folders."),
				workerCount: z.number().int().min(1).max(8).optional().describe("Bounded isolated-worker concurrency; defaults to min(4, logical CPUs minus one)."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("start_asset_indexing", args)
	);
	server.registerTool(
		"cancel_asset_indexing",
		{
			title: "Cancel background asset indexing",
			description:
				"Request cooperative cancellation of the active queued/running asset-indexing job by exact UUID. Workers terminate before publication, so the last complete registry remains authoritative. Poll status until the job reports cancelled.",
			inputSchema: z.object({ jobId: z.string().uuid() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("cancel_asset_indexing", args)
	);
	server.registerTool(
		"query_asset_registry",
		{
			title: "Query asset registry",
			description:
				"Query the persistent assets/src registry by stable GUID, path text, type, folder, label, tag, favorite state, or import status with bounded pagination and content fingerprints.",
			inputSchema: z.object({
				guid: z.string().min(1).optional(),
				query: z.string().optional(),
				type: z.string().min(1).optional(),
				folder: z.string().optional(),
				recursive: z.boolean().optional().describe("Include nested descendants of folder. Defaults to true; false returns direct file children only."),
				label: z.string().optional(),
				tag: z.string().min(1).max(64).optional(),
				favorite: z.boolean().optional(),
				importStatus: z.enum(["native", "unchecked", "current", "stale", "missing", "error"]).optional(),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("query_asset_registry", args)
	);
	server.registerTool(
		"rebuild_asset_registry",
		{
			title: "Rebuild asset registry",
			description:
				"Atomically rebuild the persistent registry and missing GUID sidecars. Duplicate GUIDs are diagnostic-only unless repairDuplicateGuids and confirmRepair are both true; repair preserves the first sorted path and regenerates later identities.",
			inputSchema: z.object({
				repairDuplicateGuids: z.boolean().optional(),
				confirmRepair: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("rebuild_asset_registry", args)
	);
	server.registerTool(
		"refresh_asset_registry_paths",
		{
			title: "Refresh asset registry paths",
			description: "Incrementally remove or rescan bounded project-contained files/folders in the persistent asset registry after external changes.",
			inputSchema: z.object({ paths: z.array(z.string().min(1)).min(1).max(100) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_asset_registry_paths", args)
	);

	server.registerTool(
		"get_asset_watch_status",
		{
			title: "Get asset watch status",
			description:
				"Report whether automatic local watching of the active project's assets/src folders is running, together with the detected change count and latest external file event.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("get_asset_watch_status", {})
	);
	server.registerTool(
		"refresh_watched_assets",
		{
			title: "Refresh watched assets",
			description: "Force the Assets Browser to immediately rebuild its watched project asset tree/items. Automatic watching normally does this after a short debounce.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("refresh_watched_assets", {})
	);
	server.registerTool(
		"inspect_auto_reimport",
		{
			title: "Inspect Auto Reimport",
			description:
				"Return the project Auto Reimport settings/lease, active or persisted job evidence, and an exact bounded plan. With paths, includes each changed source plus recursively affected reverse-dependency importers; without paths, inspects all supported importer assets. Dependency-triggered candidates rebuild even when their own source fingerprint is current.",
			inputSchema: z
				.object({
					paths: autoReimportPathsSchema.optional().describe("Optional changed project paths; omit to inspect every supported importer asset."),
					force: z.boolean().optional().describe("Plan every candidate for rebuild even when current."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_auto_reimport", args)
	);
	server.registerTool(
		"set_auto_reimport_settings",
		{
			title: "Set Auto Reimport settings",
			description:
				"Atomically replace the complete project Auto Reimport configuration under the exact settings fingerprint returned by inspect_auto_reimport. Reconfigures optional external-origin watches immediately.",
			inputSchema: z
				.object({
					expectedSettingsFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact settings fingerprint returned by inspect_auto_reimport."),
					settings: autoReimportSettingsSchema,
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_auto_reimport_settings", args)
	);
	server.registerTool(
		"run_auto_reimport",
		{
			title: "Run Auto Reimport",
			description:
				"After confirm=true, execute the exact plan from inspect_auto_reimport. Revalidates every importer fingerprint, atomically rebuilds supported texture/model/audio/video/font/material/animation artifacts, preserves authored sources, and returns per-asset applied/current/unsupported/failure evidence.",
			inputSchema: z
				.object({
					expectedFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact plan fingerprint returned by inspect_auto_reimport."),
					confirm: z.literal(true),
					paths: autoReimportPathsSchema.optional().describe("Must match the optional paths used to inspect the plan."),
					force: z.boolean().optional().describe("Must match the force value used to inspect the plan."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("run_auto_reimport", args)
	);

	server.registerTool(
		"list_assets",
		{
			title: "List assets",
			description:
				"List the project's assets, optionally filtered by `type` and/or `folder`. Each entry reports `hasPreview` indicating whether the containing folder has an `editor_preview` image. " +
				"Always check existing assets BEFORE downloading from the marketplace — reuse what is already in the project when it fits the request.",
			inputSchema: z.object({
				type: z
					.enum([
						"texture",
						"cube-texture",
						"mesh",
						"sound",
						"video",
						"material",
						"particle",
						"gui",
						"navmesh",
						"scene",
						"prefab",
						"animation",
						"shader",
						"script",
						"style",
						"markup",
						"font",
						"data",
						"other",
					])
					.optional()
					.describe("Filter by asset type."),
				folder: z.string().optional().describe("Project-relative folder to list. Defaults to the whole assets tree."),
				recursive: z.boolean().optional().describe("Include nested descendants of folder. Defaults to true; false returns direct file children only."),
				query: z.string().optional().describe("Case-insensitive text to search in project-relative asset paths."),
				label: z.string().optional().describe("Return only assets with this persisted label."),
				tag: z.string().min(1).max(64).optional().describe("Return only assets with this project tag."),
				favorite: z.boolean().optional().describe("Filter by project-local favorite state."),
				importStatus: z.enum(["native", "unchecked", "current", "stale", "missing", "error"]).optional(),
				offset: z.number().int().min(0).optional().describe("Zero-based result offset. Defaults to 0."),
				limit: z.number().int().min(1).max(500).optional().describe("Maximum results to return. Defaults to 100."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_assets", args)
	);

	server.registerTool(
		"list_asset_dependency_scanners",
		{
			title: "List asset dependency scanners",
			description:
				"Discover persistent dependency scanner kinds, supported extensions, byte limits, and parsing scope for editor/source text, GLB, FBX, 3DS, MS3D, B3D, uncompressed DirectX .x, LightWave LWOB/LWO2/LWO3/LXOB, ASCII AutoCAD DXF, raw/GZip/Zstandard Blender SDNA external paths, and bounded ZIP/TAR/TAR-GZip/Unity-package compound assets.",
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("list_asset_dependency_scanners", {})
	);
	server.registerTool(
		"get_asset_dependencies",
		{
			title: "Get asset dependencies",
			description:
				"Read one asset's persistent indexed direct dependencies or reverse references without rescanning the project. Archive results include bounded member inventory plus internal, missing, and project-external references. Every result reports complete, deferred, malformed, or not-applicable scanner status.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative file asset path."),
					direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Dependencies by default; referencedBy finds text files that mention this asset path."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_dependencies", args)
	);
	server.registerTool(
		"get_asset_dependency_graph",
		{
			title: "Get asset dependency graph",
			description:
				"Traverse persistent asset dependency or reverse-reference edges from one indexed project file. Archive roots expand into virtual member and internal-reference nodes. Returns bounded nodes/edges, stable GUIDs/types, missing targets, cycles, containment relationships, and truncation state.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative root asset path."),
				direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Traverse forward dependencies by default or reverse references."),
				depth: z.number().int().min(1).max(16).optional().describe("Maximum traversal depth. Defaults to 1."),
				includeMissing: z.boolean().optional().describe("Include missing forward targets. Defaults to true."),
				limit: z.number().int().min(1).max(1000).optional().describe("Maximum returned edges. Defaults to 200."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_dependency_graph", args)
	);
	server.registerTool(
		"export_asset_dependency_graph",
		{
			title: "Export asset dependency graph",
			description:
				"Format one bounded persistent asset dependency or reverse-reference graph as structured JSON, Graphviz DOT, or Mermaid text. Returns the complete content plus node/edge/cycle counts and a suggested filename without writing a file.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative root asset path."),
				direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Traverse forward dependencies by default or reverse references."),
				depth: z.number().int().min(1).max(16).optional().describe("Maximum traversal depth. Defaults to 1."),
				includeMissing: z.boolean().optional().describe("Include missing forward targets. Defaults to true."),
				limit: z.number().int().min(1).max(1000).optional().describe("Maximum returned edges. Defaults to 200."),
				format: z.enum(["json", "dot", "mermaid"]).optional().describe("JSON by default, Graphviz DOT, or Mermaid flowchart text."),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("export_asset_dependency_graph", args)
	);
	server.registerTool(
		"open_asset_dependency_graph",
		{
			title: "Open asset dependency graph",
			description:
				"Open the editor's interactive visual dependency canvas for one indexed asset after validating the requested bounded graph. The canvas supports Uses/Used By traversal, missing and cycle highlighting, search, zoom, rerooting, and Inspector navigation.",
			inputSchema: z.object({
				path: z.string().min(1).max(1024).describe("Project-relative root asset path."),
				direction: z.enum(["dependencies", "referencedBy"]).optional().describe("Initial traversal direction. Defaults to dependencies."),
				depth: z.number().int().min(1).max(16).optional().describe("Initial bounded traversal depth. Defaults to 1."),
				includeMissing: z.boolean().optional().describe("Include missing forward targets. Defaults to true."),
				limit: z.number().int().min(1).max(1000).optional().describe("Validation edge limit. Defaults to 200."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("open_asset_dependency_graph", args)
	);
	server.registerTool(
		"get_asset_dependency_diagnostics",
		{
			title: "Get asset dependency diagnostics",
			description:
				"List persistent project and inside-archive missing-reference diagnostics, dependency cycles, deferred size-bounded scans, and malformed GLB/FBX/3DS/MS3D/B3D/DirectX-X/LightWave/DXF/Blender/archive dependency sources.",
			inputSchema: z.object({
				query: z.string().max(512).optional().describe("Case-insensitive source/target path filter."),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_dependency_diagnostics", args)
	);
	server.registerTool(
		"rebuild_asset_dependency_index",
		{
			title: "Rebuild asset dependency index",
			description:
				"Atomically rescan bounded project text, binary models, and compound archives, then rebuild forward/reverse/missing dependency edges and container-member evidence together with registry fingerprints.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (): Promise<CallToolResult> => callTextTool("rebuild_asset_dependency_index", {})
	);
	server.registerTool(
		"get_asset_by_guid",
		{
			title: "Get asset by GUID",
			description:
				"Resolve a persisted Babylon.js Editor asset GUID to its current project-relative path and metadata. Use this after an asset may have been renamed or moved.",
			inputSchema: z.object({ guid: z.string().min(1) }),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_by_guid", args)
	);
	server.registerTool(
		"get_asset_details",
		{
			title: "Get asset details",
			description: "Get an asset's path, type, file size, timestamps, directory status, and preview availability.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Project-relative asset or folder path."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_details", args)
	);

	server.registerTool(
		"import_asset",
		{
			title: "Import local asset",
			description:
				"Copy a local file or folder into the open project. The source must be an absolute local path; the destination must stay inside the project and defaults to `assets/<source name>`. This does not alter the source file.",
			inputSchema: z.object({
				sourcePath: z.string().min(1).describe("Absolute local file or folder path to copy into the project."),
				destinationPath: z.string().optional().describe("Project-relative destination path. Defaults to `assets/<source name>`."),
				labels: z.array(z.string().min(1)).optional().describe("Persisted asset labels to assign on import."),
				importer: z.record(z.string(), z.any()).optional().describe("Importer settings to persist in the asset sidecar."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("import_asset", args)
	);

	server.registerTool(
		"get_asset_preview",
		{
			title: "Get asset preview",
			description:
				"Return the preview image for an asset/folder (the folder's `editor_preview.png/jpg/bmp`, or a generated thumbnail) as an image. " +
				"BEFORE using an existing asset in the scene, view its preview here to confirm it visually matches the user's description.",
			inputSchema: z.object({
				path: z.string().describe("Project-relative or absolute path to the asset (or its folder)."),
			}),
			annotations: { readOnlyHint: true },
		},
		async (args): Promise<CallToolResult> => callImageTool("get_asset_preview", args)
	);

	server.registerTool(
		"convert_image_asset",
		{
			title: "Convert image asset",
			description:
				"Convert and optionally resize a project raster, SVG, Radiance HDR, or OpenEXR image. SVG is rasterized deterministically; HDR/EXR sources use the bounded shared linear-float decoder and an ACES tone-mapped preview conversion. `png`, `jpeg`, and `webp` create standard texture assets. `bitmap` creates an uncompressed `.rgba` RGBA8 pixel buffer plus a JSON descriptor for custom game/runtime asset pipelines.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).max(1024).describe("Project-relative source raster, SVG, Radiance HDR, or OpenEXR image path."),
					outputPath: z.string().min(1).max(1024).describe("New project-relative output path; use .png, .jpg/.jpeg, .webp, or .rgba according to format."),
					format: z.enum(["png", "jpeg", "webp", "bitmap"]),
					width: z.number().int().min(1).max(16384).optional(),
					height: z.number().int().min(1).max(16384).optional(),
					fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).optional(),
					withoutEnlargement: z.boolean().optional(),
					quality: z.number().int().min(1).max(100).optional().describe("JPEG/WebP quality. Defaults to 90."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("convert_image_asset", args)
	);

	server.registerTool(
		"set_asset_metadata",
		{
			title: "Set asset metadata",
			description:
				"Persist labels, separate project tags, favorite state, and importer settings in an atomic sidecar without changing source asset bytes. Importer settings are arbitrary JSON used by editor/build workflows.",
			inputSchema: z.object({
				path: z.string().min(1),
				labels: z.array(z.string().min(1)).max(64).optional(),
				tags: z.array(z.string().min(1).max(64)).max(64).optional(),
				favorite: z.boolean().optional(),
				importer: z.record(z.string(), z.any()).optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_metadata", args)
	);
	server.registerTool(
		"set_asset_organization",
		{
			title: "Set asset tags and favorites",
			description:
				"Atomically replace separate project tags and/or project-local favorite state for up to 100 existing file assets while preserving GUIDs, labels, importer settings, and source bytes.",
			inputSchema: z.object({
				paths: z.array(z.string().min(1).max(1024)).min(1).max(100),
				tags: z.array(z.string().min(1).max(64)).max(64).optional(),
				favorite: z.boolean().optional(),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_organization", args)
	);
	server.registerTool(
		"get_asset_import_status",
		{
			title: "Get asset import status",
			description:
				"Read one indexed asset's stable GUID, tags, favorite state, recorded source path, and persisted native/unchecked/current/stale/missing/error import state without touching the external source.",
			inputSchema: z.object({ path: z.string().min(1).max(1024) }),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("get_asset_import_status", args)
	);
	server.registerTool(
		"refresh_asset_import_states",
		{
			title: "Refresh asset import states",
			description:
				"Recheck bounded recorded source fingerprints for selected assets, or up to 500 imported assets, then atomically persist current, stale, missing, or error status. This reads recorded local source paths but never changes them.",
			inputSchema: z.object({ paths: z.array(z.string().min(1).max(1024)).min(1).max(100).optional() }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("refresh_asset_import_states", args)
	);
	server.registerTool(
		"list_asset_import_diagnostics",
		{
			title: "List asset import diagnostics",
			description:
				"List persisted unchecked, stale, missing-source, or failed-import diagnostics with bounded filtering and pagination. This does not access external sources; refresh first when current source state is required.",
			inputSchema: z.object({
				status: z.enum(["unchecked", "stale", "missing", "error"]).optional(),
				query: z.string().max(512).optional(),
				offset: z.number().int().min(0).optional(),
				limit: z.number().int().min(1).max(500).optional(),
			}),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("list_asset_import_diagnostics", args)
	);
	server.registerTool(
		"list_asset_importer_presets",
		{
			title: "List asset importer presets",
			description: "List project-persisted named importer presets, including settings, labels, and extension filters.",
			inputSchema: z.object({}),
			annotations: { readOnlyHint: true },
		},
		async (): Promise<CallToolResult> => callTextTool("list_asset_importer_presets", {})
	);
	server.registerTool(
		"set_asset_importer_preset",
		{
			title: "Set asset importer preset",
			description: "Create or replace a named project importer preset. The preset is saved under .bjseditor and does not modify assets until applied.",
			inputSchema: z.object({
				name: z.string().min(1),
				kind: importerKindSchema.optional(),
				importer: importerSettingsSchema,
				labels: z.array(z.string().min(1)).optional(),
				extensions: z.array(z.string().min(1)).optional(),
			}),
			annotations: { idempotentHint: true },
		},
		async (args): Promise<CallToolResult> => callTextTool("set_asset_importer_preset", args)
	);
	server.registerTool(
		"apply_asset_importer_preset",
		{
			title: "Apply asset importer preset",
			description:
				"Apply a named importer preset to project file assets. Importer settings and labels merge by default; set replaceImporter or mergeLabels false for replacement behavior.",
			inputSchema: z.object({
				name: z.string().min(1),
				paths: z.array(z.string().min(1)).min(1),
				replaceImporter: z.boolean().optional(),
				mergeLabels: z.boolean().optional(),
			}),
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_asset_importer_preset", args)
	);
	server.registerTool(
		"delete_asset_importer_preset",
		{
			title: "Delete asset importer preset",
			description: "Delete a named importer preset without modifying any existing asset sidecars.",
			inputSchema: z.object({ name: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_asset_importer_preset", args)
	);
	server.registerTool(
		"reimport_asset",
		{
			title: "Reimport asset",
			description:
				"Replace an imported project asset with its recorded original source while retaining GUID, labels, and importer settings. Fails safely when no accessible source was recorded.",
			inputSchema: z.object({ path: z.string().min(1) }),
		},
		async (args): Promise<CallToolResult> => callTextTool("reimport_asset", args)
	);
	server.registerTool(
		"instantiate_mesh_asset",
		{
			title: "Instantiate mesh asset",
			description:
				"Load a supported mesh asset (`.glb/.gltf/.babylon/.fbx/.obj/.stl/.dae/.3ds/.ms3d/.b3d/.x/.lwo/.dxf/.blend`) into the scene — the equivalent of drag'n'dropping it in the editor preview. This is the main way to bring in rich, hand-editable content: trees, rocks, buildings, props, characters, vehicles, weapons, etc. glTF/glb assets are auto-scaled (x100) to editor units; do NOT re-apply scaling. Binary DXF is not supported. Blender 3.0+ or Zstandard `.blend` sources require an installed Blender executable configured through `BJS_EDITOR_BLENDER_EXECUTABLE`; legacy files use the bundled Assimp converter. " +
				"IMPORTANT for performance: import a mesh ONCE, then use `create_instance` to place many copies (e.g. a forest of trees, a street of identical buildings, a crowd). Importing the same asset repeatedly duplicates the geometry and is wasteful. " +
				"Find assets with `list_assets`, or download new ones via the visible marketplace tools. Returns `{ rootNodeId, createdNodes[] }`. Some assets ship multiple LOD meshes named `name_LOD0`, `name_LOD1`, ...; the editor does not wire LODs automatically.",
			inputSchema: z
				.object({
					path: z.string().min(1).max(1024).describe("Project-relative or absolute path to the mesh asset."),
					name: z.string().min(1).max(256).optional().describe("Name for the instantiated root node."),
					parentId: z.string().min(1).max(256).optional().describe("Id of the parent node. Omit to add at the scene root."),
					position: z.array(z.number().finite()).length(3).optional().describe("World position `[x,y,z]` in centimeters."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("instantiate_mesh_asset", args)
	);

	server.registerTool(
		"create_asset_folder",
		{
			title: "Create asset folder",
			description: "Create a folder inside the currently open Babylon.js Editor project. The path must be project-relative and cannot escape the project directory.",
			inputSchema: z.object({ path: z.string().min(1).describe("Project-relative path of the new folder.") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("create_asset_folder", args)
	);

	server.registerTool(
		"inspect_asset_move",
		{
			title: "Inspect semantic asset move",
			description:
				"Dry-run an asset or folder move using the persistent dependency index. Returns the stable source GUID, exact source/file leases, semantic text/GLB/ASCII-or-binary-FBX/3DS/MS3D/B3D/uncompressed-text-or-binary-DirectX-X/LightWave-LWO/ASCII-DXF/Blender-SDNA and bounded ZIP/TAR/TAR.GZ/Unity-package member rewrites, member/format evidence, malformed/oversized/semantic blockers, replacement counts, and a plan fingerprint without changing the project.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).max(1024).describe("Existing project-relative asset or folder path."),
					destinationPath: z.string().min(1).max(1024).describe("Unoccupied project-relative destination path."),
				})
				.strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("inspect_asset_move", args)
	);

	server.registerTool(
		"apply_asset_move",
		{
			title: "Apply semantic asset move",
			description:
				"Apply an exact inspect_asset_move plan. Preserves the sidecar GUID; atomically rewrites indexed text, GLB, ASCII/binary FBX, 3DS, MS3D, B3D, uncompressed text/binary DirectX .x, LightWave LWO, ASCII DXF, Blender SDNA paths, and bounded ZIP/TAR/TAR.GZ/Unity-package members; verifies the plan fingerprint; and rolls back rebuilt archives, other rewritten files, and the move if any write fails. Malformed, oversized, or semantically unsafe referencers block by default.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).max(1024),
					destinationPath: z.string().min(1).max(1024),
					expectedPlanFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.describe("Exact fingerprint returned by inspect_asset_move."),
					allowUnsupportedReferences: z
						.boolean()
						.optional()
						.describe("Allow the move while leaving explicitly reported malformed, oversized, or semantically unsafe references unchanged. Defaults to false."),
					updateReferences: z
						.boolean()
						.optional()
						.describe(
							"Apply planned semantic text/GLB/FBX/3DS/MS3D/B3D/DirectX-X/LightWave-LWO/ASCII-DXF/Blender-SDNA/archive rewrites. Defaults to true; false performs an identity-preserving filesystem move only."
						),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("apply_asset_move", args)
	);

	server.registerTool(
		"move_asset",
		{
			title: "Move or rename asset",
			description:
				"Convenience move/rename using the same GUID-preserving semantic transaction as inspect_asset_move/apply_asset_move. Rewrites indexed relative/root text, GLB, ASCII/binary FBX, 3DS, MS3D, B3D, uncompressed text/binary DirectX .x, LightWave LWO, ASCII DXF, Blender SDNA paths, and bounded ZIP/TAR/TAR.GZ/Unity-package members with rollback; malformed or unsafe sources block unless explicitly allowed. Prefer inspect then apply when concurrency safety matters.",
			inputSchema: z
				.object({
					sourcePath: z.string().min(1).describe("Existing project-relative asset or folder path."),
					destinationPath: z.string().min(1).describe("New project-relative asset or folder path."),
					expectedPlanFingerprint: z
						.string()
						.regex(/^[a-f0-9]{64}$/)
						.optional()
						.describe("Optional exact dry-run fingerprint; stale plans are rejected."),
					allowUnsupportedReferences: z.boolean().optional(),
					updateReferences: z
						.boolean()
						.optional()
						.describe("Apply semantic reference rewrites. Defaults to true; set false for an identity-preserving filesystem-only move."),
					updateTextReferences: z.boolean().optional().describe("Deprecated alias for updateReferences retained for older clients."),
				})
				.strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("move_asset", args)
	);

	server.registerTool(
		"delete_asset",
		{
			title: "Delete asset",
			description: "Permanently delete an asset or folder inside the open project. You must set confirm to true after checking the path. The project root cannot be deleted.",
			inputSchema: z.object({
				path: z.string().min(1).describe("Project-relative asset or folder path to delete."),
				confirm: z.literal(true).describe("Explicit confirmation for this destructive operation."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (args): Promise<CallToolResult> => callTextTool("delete_asset", args)
	);
}
