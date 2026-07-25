import { basename } from "path/posix";

import { useEffect, useState } from "react";
import { AiFillPicture } from "react-icons/ai";

import { Divider } from "@blueprintjs/core";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../../ui/shadcn/ui/table";

import { FileInspectorObject } from "../file";
import {
	ITextureImporterPlatformOverride,
	ITextureImporterPlatformOverrides,
	ITextureImportResult,
	normalizeTextureImporterPlatformOverrides,
	serializeTextureImporterPlatformOverrides,
	IPsdLayerAdjustmentInfo,
	IPsdSmartFilterInfo,
	PsdLayerSheetColor,
} from "babylonjs-editor-tools";
import { openProjectImage, requiresDecodedProjectImage } from "../../../../tools/assets/image";
import {
	applyPsdLayerExtraction,
	getPsdLayerExtractionStatus,
	IPsdLayerExtractionStatus,
	IPsdShapeBlurKernelBindingRequest,
	IPsdSmartObjectExternalBindingRequest,
	IPsdTextRenderRequest,
} from "../../../../mcp/assets/psd-layers";
import {
	applyPsdSmartObjectPayloadReplacement,
	getPsdSmartObjectPayloadReplacementStatus,
	IPsdSmartObjectPayloadReplacementRequest,
	IPsdSmartObjectPayloadReplacementStatus,
} from "../../../../mcp/assets/psd-smart-object-replacement";
import { refreshAssetRegistryPaths } from "../../../../mcp/assets/registry";
import { openSingleFileDialog } from "../../../../tools/dialog";

export interface IEditorInspectorImageComponentProps {
	object: FileInspectorObject;
	importedPath?: string | null;
	importedCurrent?: boolean;
	result?: ITextureImportResult | null;
	settings?: Record<string, boolean | number | string> | null;
	onPlatformOverridesChange?: (value: string) => void;
	onAssetsChanged?: () => void;
}

const maximumSizes = [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const compositedPsdBlendModes = new Set([
	"norm",
	"mul ",
	"scrn",
	"over",
	"dark",
	"lite",
	"div ",
	"idiv",
	"hLit",
	"sLit",
	"diff",
	"smud",
	"lddg",
	"lbrn",
	"fsub",
	"fdiv",
	"hue ",
	"sat ",
	"colr",
	"lum ",
]);
const sheetColorSwatches: Record<PsdLayerSheetColor, string> = {
	none: "transparent",
	red: "#ef4444",
	orange: "#f97316",
	yellow: "#eab308",
	green: "#22c55e",
	blue: "#3b82f6",
	violet: "#8b5cf6",
	gray: "#6b7280",
	unknown: "#111827",
};

function parsedOverrides(value: unknown): ITextureImporterPlatformOverrides {
	try {
		return normalizeTextureImporterPlatformOverrides(value);
	} catch {
		return {};
	}
}

function effectDescriptorLabel(effect: { descriptorKey?: string; descriptorListIndex?: number | null }): string {
	if (!effect.descriptorKey) {
		return "";
	}
	return ` · ${effect.descriptorKey}${effect.descriptorListIndex === null || effect.descriptorListIndex === undefined ? "" : `[${effect.descriptorListIndex}]`}`;
}

function smartFilterParameterLabel(filter: IPsdSmartFilterInfo): string {
	if (filter.addNoise) {
		return `${filter.type} ${filter.addNoise.amountPercent}%/${filter.addNoise.distribution}/${filter.addNoise.monochromatic ? "monochromatic" : "independent RGB"}/seed ${filter.addNoise.randomSeed}`;
	}
	if (filter.dustAndScratches) {
		return `${filter.type} ${filter.dustAndScratches.radius}px/threshold ${filter.dustAndScratches.threshold}`;
	}
	if (filter.colorHalftone) {
		return `${filter.type} max radius ${filter.colorHalftone.radius}px/CMYK ${filter.colorHalftone.anglesDegrees.map((angle) => `${angle}°`).join("/")}`;
	}
	if (filter.crystallize) {
		return `${filter.type} ${filter.crystallize.cellSize}px cells/seed ${filter.crystallize.randomSeed}`;
	}
	if (filter.mezzotint) {
		return `${filter.type} ${filter.mezzotint.pattern}/seed ${filter.mezzotint.randomSeed}`;
	}
	if (filter.mosaic) {
		return `${filter.type} ${filter.mosaic.cellSize}px cells`;
	}
	if (filter.pointillize) {
		return `${filter.type} ${filter.pointillize.cellSize}px cells/seed ${filter.pointillize.randomSeed}/BG ${filter.backgroundColor?.slice(0, 3).join(",") ?? "missing"}`;
	}
	if (filter.clouds) {
		return `${filter.type} seed ${filter.clouds.randomSeed}/FG ${filter.foregroundColor?.slice(0, 3).join(",") ?? "missing"}/BG ${filter.backgroundColor?.slice(0, 3).join(",") ?? "missing"}`;
	}
	if (filter.differenceClouds) {
		return `${filter.type} seed ${filter.differenceClouds.randomSeed}/FG ${filter.foregroundColor?.slice(0, 3).join(",") ?? "missing"}/BG ${filter.backgroundColor?.slice(0, 3).join(",") ?? "missing"}`;
	}
	if (filter.diffuse) {
		return `${filter.type} ${filter.diffuse.mode}/seed ${filter.diffuse.randomSeed}`;
	}
	if (filter.emboss) {
		return `${filter.type} angle ${filter.emboss.angleDegrees}°/height ${filter.emboss.heightPixels}px/amount ${filter.emboss.amountPercent}%`;
	}
	if (filter.extrude) {
		return `${filter.type} ${filter.extrude.type}/${filter.extrude.sizePixels}px/depth ${filter.extrude.depth} ${filter.extrude.depthMode}/seed ${filter.extrude.randomSeed}/solid fronts ${filter.extrude.solidFrontFaces ? "on" : "off"}/mask incomplete ${filter.extrude.maskIncompleteBlocks ? "on" : "off"}`;
	}
	if (filter.tiles) {
		return `${filter.type} count ${filter.tiles.numberOfTiles}/offset ${filter.tiles.maximumOffsetPercent}%/${filter.tiles.fillEmptyAreaWith}/seed ${filter.tiles.randomSeed}`;
	}
	if (filter.traceContour) {
		return `${filter.type} level ${filter.traceContour.level}/${filter.traceContour.edge}`;
	}
	if (filter.wind) {
		return `${filter.type} ${filter.wind.method}/${filter.wind.direction}`;
	}
	if (filter.deInterlace) {
		return `${filter.type} eliminate ${filter.deInterlace.eliminate}/${filter.deInterlace.newFieldsBy}`;
	}
	if (filter.fibers) {
		return `${filter.type} variance ${filter.fibers.variance}/strength ${filter.fibers.strength}/seed ${filter.fibers.randomSeed}/FG ${filter.foregroundColor?.slice(0, 3).join(",") ?? "missing"}/BG ${filter.backgroundColor?.slice(0, 3).join(",") ?? "missing"}`;
	}
	if (filter.lensFlare) {
		return `${filter.type} brightness ${filter.lensFlare.brightnessPercent}%/center ${filter.lensFlare.position.x},${filter.lensFlare.position.y}/lens ${filter.lensFlare.lensType}`;
	}
	if (filter.smartSharpen) {
		return `${filter.type} ${filter.smartSharpen.preset}/amount ${filter.smartSharpen.amountPercent}%/radius ${filter.smartSharpen.radius}px/threshold ${filter.smartSharpen.threshold}/blur ${filter.smartSharpen.blur}/angle ${filter.smartSharpen.angleDegrees}°/accurate ${filter.smartSharpen.moreAccurate ? "on" : "off"}/shadow ${filter.smartSharpen.shadow.fadeAmountPercent}%/${filter.smartSharpen.shadow.tonalWidthPercent}%/${filter.smartSharpen.shadow.radius}px/highlight ${filter.smartSharpen.highlight.fadeAmountPercent}%/${filter.smartSharpen.highlight.tonalWidthPercent}%/${filter.smartSharpen.highlight.radius}px`;
	}
	if (filter.unsharpMask) {
		return `${filter.type} amount ${filter.unsharpMask.amountPercent}%/radius ${filter.unsharpMask.radius}px/threshold ${filter.unsharpMask.threshold}`;
	}
	if (filter.reduceNoise) {
		const channels = filter.reduceNoise.channelDenoise
			.map((entry) => `${entry.channels.join("+")} ${entry.amount}/10${entry.preserveDetailsPercent === null ? "" : ` preserve ${entry.preserveDetailsPercent}%`}`)
			.join(", ");
		return `${filter.type} ${filter.reduceNoise.preset}/color ${filter.reduceNoise.reduceColorNoisePercent}%/sharpen ${filter.reduceNoise.sharpenDetailsPercent}%/JPEG ${filter.reduceNoise.removeJpegArtifact ? "on" : "off"}/${channels}`;
	}
	if (filter.motionBlur) {
		return `${filter.type} ${filter.motionBlur.angleDegrees}°/${filter.motionBlur.distance}px`;
	}
	if (filter.radialBlur) {
		return `${filter.type} ${filter.radialBlur.amount}%/${filter.radialBlur.method}/${filter.radialBlur.quality}`;
	}
	if (filter.smartBlur) {
		return `${filter.type} ${filter.radius}px/threshold ${filter.smartBlur.threshold}/${filter.smartBlur.quality}/${filter.smartBlur.mode}`;
	}
	if (filter.surfaceBlur) {
		return `${filter.type} ${filter.radius}px/threshold ${filter.surfaceBlur.threshold}`;
	}
	if (filter.shapeBlur) {
		return `${filter.type} ${filter.radius}px/${filter.shapeBlur.customShape.name} (${filter.shapeBlur.customShape.id})`;
	}
	return `${filter.type}${filter.radius === null ? "" : ` ${filter.radius}px`}`;
}

function adjustmentLabel(adjustment: IPsdLayerAdjustmentInfo): string {
	if (adjustment.key === "blwh") {
		return `Black & White · red ${adjustment.reds} · yellow ${adjustment.yellows} · green ${adjustment.greens} · cyan ${adjustment.cyans} · blue ${adjustment.blues} · magenta ${adjustment.magentas} · ${adjustment.useTint ? `tint ${adjustment.tintColor.rgba?.slice(0, 3).join("/") ?? "unsupported"}` : "no tint"} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "mixr") {
		const channel = (name: string, value: NonNullable<typeof adjustment.red>) =>
			`${name} ${value.red}/${value.green}/${value.blue} · constant ${value.constant} · total ${value.total}`;
		return adjustment.monochrome
			? `Channel Mixer · monochrome · ${channel("gray", adjustment.gray)} · ${adjustment.colorModel}`
			: `Channel Mixer · RGB · ${channel("red", adjustment.red!)} · ${channel("green", adjustment.green!)} · ${channel("blue", adjustment.blue!)} · gray preset ${adjustment.gray.red}/${adjustment.gray.green}/${adjustment.gray.blue} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "selc") {
		const range = (name: string, value: typeof adjustment.reds) => `${name} ${value.cyan}/${value.magenta}/${value.yellow}/${value.black}`;
		return `Selective Color · ${adjustment.mode} · ${range("reds", adjustment.reds)} · ${range("yellows", adjustment.yellows)} · ${range("greens", adjustment.greens)} · ${range("cyans", adjustment.cyans)} · ${range("blues", adjustment.blues)} · ${range("magentas", adjustment.magentas)} · ${range("whites", adjustment.whites)} · ${range("neutrals", adjustment.neutrals)} · ${range("blacks", adjustment.blacks)} · ${adjustment.rangeModel} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "grdm") {
		return `Gradient Map · ${adjustment.gradientType} · ${adjustment.name || "unnamed"} · ${adjustment.method} · ${adjustment.reverse ? "reversed" : "forward"} · ${adjustment.dither ? "dithered" : "no dither"} · ${adjustment.colorStops.length} color stops · ${adjustment.opacityStops.length} opacity stops · smoothness ${adjustment.smoothnessRaw}/4096${adjustment.gradientType === "noise" ? ` · ${adjustment.colorModel} · seed ${adjustment.randomSeed} · roughness ${adjustment.roughnessRaw}/4096 · ${adjustment.restrictColors ? "restrict colors" : "full colors"} · ${adjustment.addTransparency ? "transparency" : "opaque"} · ${adjustment.noiseModel}` : ""} · ${adjustment.gradientModel}`;
	}
	if (adjustment.key === "phfl") {
		return `Photo Filter · version ${adjustment.version} · color ${adjustment.color.rgba?.slice(0, 3).join("/") ?? "unsupported"} · density ${adjustment.density.toFixed(2)}% · ${adjustment.preserveLuminosity ? "preserve luminosity" : "do not preserve luminosity"}${adjustment.labColor ? ` · Lab ${adjustment.labColor.lightness}/${adjustment.labColor.a}/${adjustment.labColor.b}` : ""} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "clrL") {
		return `Color Lookup · ${adjustment.lookupType} · ${adjustment.name || "unnamed"} · ${adjustment.lutFormat.toUpperCase()} · ${adjustment.dataOrder}/${adjustment.tableOrder} · ${adjustment.lut3DFileName || "embedded profile"} · ${adjustment.lut3DFileBytes} bytes · ${adjustment.lutSize ? `${adjustment.lutSize}³/${adjustment.lutEntryCount} entries` : "not executable"} · ${adjustment.dither ? "dithered" : "no dither"} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "blnc") {
		const tone = (name: string, value: typeof adjustment.shadows) => `${name} ${value.cyanRed}/${value.magentaGreen}/${value.yellowBlue}`;
		return `Color Balance · ${tone("shadows", adjustment.shadows)} · ${tone("midtones", adjustment.midtones)} · ${tone("highlights", adjustment.highlights)} · ${adjustment.preserveLuminosity ? "preserve luminosity" : "do not preserve luminosity"} · ${adjustment.tonalModel} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "brit") {
		return `Brightness/Contrast · brightness ${adjustment.brightness} · contrast ${adjustment.contrast} · mean ${adjustment.mean}${adjustment.labOnly ? " · Lab only" : ""}`;
	}
	if (adjustment.key === "levl") {
		return `Levels · master ${adjustment.master.inputFloor}-${adjustment.master.inputCeiling} → ${adjustment.master.outputFloor}-${adjustment.master.outputCeiling} · gamma ${(
			adjustment.master.gamma / 100
		).toFixed(2)}`;
	}
	if (adjustment.key === "curv") {
		return `Curves · version ${adjustment.version} · ${adjustment.curves.length} channel curve(s) · ${adjustment.curves.reduce((count, curve) => count + curve.points.length, 0)} points`;
	}
	if (adjustment.key === "expA") {
		return `Exposure · exposure ${adjustment.exposure.toFixed(3)} · offset ${adjustment.offset.toFixed(3)} · gamma ${adjustment.gamma.toFixed(3)} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "hue " || adjustment.key === "hue2") {
		const settings = adjustment.colorize ? adjustment.colorization : adjustment.master;
		return `Hue/Saturation · ${adjustment.sourceModel} · ${adjustment.colorize ? "colorize" : "master"} · hue ${settings.hue} · saturation ${settings.saturation} · lightness ${settings.lightness}${adjustment.localAdjustmentsPresent ? ` · local ranges · ${adjustment.localRangeModel}` : ""} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "vibA") {
		return `Vibrance · vibrance ${adjustment.vibrance} · saturation ${adjustment.saturation} · ${adjustment.colorModel}`;
	}
	if (adjustment.key === "post") {
		return `Posterize · ${adjustment.levels} levels`;
	}
	if (adjustment.key === "thrs") {
		return `Threshold · ${adjustment.threshold}`;
	}
	return "Invert";
}

function PsdLayerExtractor(props: { path: string; onAssetsChanged?: () => void }) {
	const isPsb = props.path.toLowerCase().endsWith(".psb");
	const [destinationFolder, setDestinationFolder] = useState("");
	const [includeHidden, setIncludeHidden] = useState(false);
	const [applyOpacity, setApplyOpacity] = useState(true);
	const [applyLayerEffects, setApplyLayerEffects] = useState(true);
	const [applyAdjustments, setApplyAdjustments] = useState(true);
	const [compositeClippingGroups, setCompositeClippingGroups] = useState(true);
	const [compositeGroups, setCompositeGroups] = useState(false);
	const [extractSmartObjectPayloads, setExtractSmartObjectPayloads] = useState(false);
	const [inspectNestedSmartObjects, setInspectNestedSmartObjects] = useState(false);
	const [nestedSmartObjectMaximumDepth, setNestedSmartObjectMaximumDepth] = useState(4);
	const [renderEmbeddedSmartObjects, setRenderEmbeddedSmartObjects] = useState(false);
	const [renderExternalSmartObjects, setRenderExternalSmartObjects] = useState(false);
	const [smartObjectExternalBindings, setSmartObjectExternalBindings] = useState<Record<number, IPsdSmartObjectExternalBindingRequest>>({});
	const [shapeBlurKernelBindings, setShapeBlurKernelBindings] = useState<Record<string, IPsdShapeBlurKernelBindingRequest>>({});
	const [smartObjectReplacementSources, setSmartObjectReplacementSources] = useState<Record<string, IPsdSmartObjectPayloadReplacementRequest>>({});
	const [replacementDestinationPath, setReplacementDestinationPath] = useState("");
	const [replacementStatus, setReplacementStatus] = useState<IPsdSmartObjectPayloadReplacementStatus | null>(null);
	const [replacementMessage, setReplacementMessage] = useState<string | null>(null);
	const [replacementLoading, setReplacementLoading] = useState(false);
	const [replacementDirty, setReplacementDirty] = useState(false);
	const [layerIndices, setLayerIndices] = useState<number[] | null>(null);
	const [textRenders, setTextRenders] = useState<Record<number, IPsdTextRenderRequest>>({});
	const [status, setStatus] = useState<IPsdLayerExtractionStatus | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [planDirty, setPlanDirty] = useState(false);
	const options = () => ({
		destinationFolder: destinationFolder.trim() || undefined,
		includeHidden,
		applyOpacity,
		applyLayerEffects,
		applyAdjustments,
		compositeClippingGroups,
		compositeGroups,
		extractSmartObjectPayloads,
		inspectNestedSmartObjects,
		nestedSmartObjectMaximumDepth: inspectNestedSmartObjects ? nestedSmartObjectMaximumDepth : undefined,
		renderEmbeddedSmartObjects,
		renderExternalSmartObjects,
		smartObjectExternalBindings: Object.values(smartObjectExternalBindings).filter((binding) => binding.sourcePath.trim()).length
			? Object.values(smartObjectExternalBindings).filter((binding) => binding.sourcePath.trim())
			: undefined,
		shapeBlurKernelBindings: Object.values(shapeBlurKernelBindings).filter((binding) => binding.sourcePath.trim()).length
			? Object.values(shapeBlurKernelBindings).filter((binding) => binding.sourcePath.trim())
			: undefined,
		layerIndices: layerIndices ?? undefined,
		textRenders: Object.values(textRenders).length ? Object.values(textRenders) : undefined,
	});
	const inspect = async (): Promise<void> => {
		setLoading(true);
		setMessage(null);
		try {
			setStatus(await getPsdLayerExtractionStatus(props.path, options()));
			setPlanDirty(false);
		} catch (error) {
			setStatus(null);
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	};
	const extract = async (): Promise<void> => {
		if (!status) {
			return;
		}
		setLoading(true);
		setMessage(null);
		try {
			const applied = await applyPsdLayerExtraction(props.path, options(), status.fingerprint);
			await refreshAssetRegistryPaths([...applied.items, ...applied.smartObjectPayloads].map((item) => item.path));
			setStatus(applied);
			setMessage(
				`Extracted ${applied.createdCount} new and reused ${applied.reusedCount} PNG sprite asset(s); published ${applied.smartObjectPayloadCreatedCount} new and reused ${applied.smartObjectPayloadReusedCount} smart-object source payload(s).`
			);
			props.onAssetsChanged?.();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	};
	useEffect(() => {
		setShapeBlurKernelBindings({});
		setSmartObjectReplacementSources({});
		setReplacementDestinationPath("");
		setReplacementStatus(null);
		setReplacementMessage(null);
		setReplacementDirty(false);
		void inspect();
		// The source path is the only automatic trigger; option edits are explicitly replanned to avoid decoding a large PSD on every keypress.
	}, [props.path]);
	const toggleLayer = (index: number, checked: boolean): void => {
		const baseline =
			layerIndices ??
			status?.document.layers
				.filter(
					(layer) =>
						(layer.extractionSupported || (compositeGroups && status.groupComposites.some((group) => group.groupStartIndex === layer.index && group.supported))) &&
						(includeHidden || layer.visible)
				)
				.map((layer) => layer.index) ??
			[];
		setLayerIndices(checked ? [...new Set([...baseline, index])].sort((left, right) => left - right) : baseline.filter((value) => value !== index));
		setPlanDirty(true);
	};
	const updateTextRender = (layerIndex: number, patch: Partial<IPsdTextRenderRequest> | null, originalText = ""): void => {
		setTextRenders((current) => {
			if (patch === null) {
				const next = { ...current };
				delete next[layerIndex];
				return next;
			}
			const existing = current[layerIndex] ?? { layerIndex, text: originalText, fontPath: "" };
			return {
				...current,
				[layerIndex]: {
					...existing,
					...patch,
					layerIndex,
				},
			};
		});
		setPlanDirty(true);
	};
	const updateExternalBinding = (resourceIndex: number, patch: Partial<IPsdSmartObjectExternalBindingRequest> | null): void => {
		setSmartObjectExternalBindings((current) => {
			if (patch === null) {
				const next = { ...current };
				delete next[resourceIndex];
				return next;
			}
			return {
				...current,
				[resourceIndex]: { ...(current[resourceIndex] ?? { resourceIndex, sourcePath: "" }), ...patch, resourceIndex },
			};
		});
		setExtractSmartObjectPayloads(true);
		setPlanDirty(true);
	};
	const updateShapeBlurKernelBinding = (shapeId: string, patch: Partial<IPsdShapeBlurKernelBindingRequest> | null): void => {
		setShapeBlurKernelBindings((current) => {
			if (patch === null) {
				const next = { ...current };
				delete next[shapeId];
				return next;
			}
			const binding = { ...(current[shapeId] ?? { shapeId, sourcePath: "", coverageSource: "auto" as const, invert: false }), ...patch };
			binding.shapeId = shapeId;
			return { ...current, [shapeId]: binding };
		});
		setPlanDirty(true);
	};
	const replacementOptions = () => ({
		destinationPath: replacementDestinationPath.trim() || undefined,
		replacements: Object.values(smartObjectReplacementSources).filter((request) => request.sourcePath.trim()),
	});
	const updateSmartObjectReplacement = (resourcePath: number[], sourcePath: string | null): void => {
		const key = resourcePath.join("/");
		setSmartObjectReplacementSources((current) => {
			const next = { ...current };
			if (sourcePath === null) {
				delete next[key];
			} else {
				next[key] = resourcePath.length === 1 ? { resourceIndex: resourcePath[0], sourcePath } : { resourcePath: [...resourcePath], sourcePath };
			}
			return next;
		});
		setReplacementDirty(true);
	};
	const inspectReplacement = async (): Promise<void> => {
		setReplacementLoading(true);
		setReplacementMessage(null);
		try {
			setReplacementStatus(await getPsdSmartObjectPayloadReplacementStatus(props.path, replacementOptions()));
			setReplacementDirty(false);
		} catch (error) {
			setReplacementStatus(null);
			setReplacementMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setReplacementLoading(false);
		}
	};
	const createReplacement = async (): Promise<void> => {
		if (!replacementStatus) {
			return;
		}
		setReplacementLoading(true);
		setReplacementMessage(null);
		try {
			const applied = await applyPsdSmartObjectPayloadReplacement(props.path, replacementOptions(), replacementStatus.fingerprint);
			await refreshAssetRegistryPaths([applied.destinationPath]);
			setReplacementStatus(applied);
			setReplacementMessage(
				`${applied.action === "reuse" ? "Reused" : "Created"} ${applied.destinationPath} with ${applied.items.length} exact embedded payload replacement(s).`
			);
			props.onAssetsChanged?.();
		} catch (error) {
			setReplacementStatus(null);
			setReplacementMessage(error instanceof Error ? error.message : String(error));
		} finally {
			setReplacementLoading(false);
		}
	};
	const unresolvedShapeBlurPresets = [
		...new Map(
			(status?.document.layers ?? [])
				.flatMap((layer) => layer.smartObject?.smartFilters ?? [])
				.filter((filter) => filter.type === "shapeBlur" && filter.shapeBlur?.kernel === null)
				.map((filter) => [filter.shapeBlur!.customShape.id, filter.shapeBlur!.customShape] as const)
		).values(),
	];
	return (
		<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
			<div className="font-semibold">PSD Sprite Layers</div>
			<div className="text-xs text-muted-foreground">
				Extract deterministic named PNG assets. Primary, real-user, and vector masks with bounded density/feather execution, supported legacy effects, and modern
				Color/Gradient/Pattern Overlays plus solid, gradient, or embedded-pattern Strokes are baked; outer effects expand sprite bounds, and all 20 supported clipped blend
				modes can be composited into their base layer. Horizontal unwarped TySh layers can replace text through one explicit project TTF/OTF/WOFF font, or rerasterize exact
				authored style runs with per-FontSet project-font bindings, sizes, exact normal/all-caps/small-caps execution, exact normal/superscript/subscript baseline,
				BaselineDirection/Tate-Chu-Yoko, OpenType palt proportional metrics, OpenType hkna horizontal Kana alternates, OpenType ruby notation forms, Photoshop Japanese
				Alternate Normal/Traditional/Expert/JIS78 forms, exact Tsume sidebearing compression, Photoshop style-run em/ICF/Roman alignment, character auto/explicit leading,
				tracking, pair-specific manual kerning, RGBA fills, horizontal/vertical scale, baseline shift, underline, strikethrough, authored no-break spans, exact
				auto-kerning/standard-ligature/discretionary-ligature switches, and bounded faux bold/italic synthesis. Authored OpenType switches automatically execute
				project-font HarfBuzz GSUB/GPOS; shaping can also be configured explicitly with LTR/RTL direction, script, language, and additional OpenType features. Optional
				matching-font cross-style joining preserves contextual forms and ligatures only across compatible authored feature states while retaining cluster-owned styles;
				Unicode BiDi resolves mixed-direction visual runs before shaping. Authored mode also executes paragraph-run justification, first/start/end indents, and before/after
				spacing over exact authored paragraph breaks while preserving auto-leading, hyphenation, and composer evidence. Exact box-text ShapeType/BoxBounds can additionally
				drive bounded whitespace/authored-hyphen wrapping, authored no-break enforcement, dictionary hyphenation, and single-line or globally optimized every-line
				composition in legacy, HarfBuzz, BiDi, cross-style, horizontal, or vertical paths with explicit line, inserted-hyphen, language, soft-break, and overflow evidence.
				No mode uses system fallback or guessed font substitution.
			</div>
			<label className="flex flex-col gap-1 text-xs">
				Destination folder
				<input
					className="h-8 rounded border border-border bg-input px-2"
					value={destinationFolder}
					placeholder="Sibling <name>_layers folder"
					onChange={(event) => {
						setDestinationFolder(event.target.value);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Include hidden layers
				<input
					type="checkbox"
					checked={includeHidden}
					onChange={(event) => {
						setIncludeHidden(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Bake layer opacity into alpha
				<input
					type="checkbox"
					checked={applyOpacity}
					onChange={(event) => {
						setApplyOpacity(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Bake supported layer effects
				<input
					type="checkbox"
					checked={applyLayerEffects}
					onChange={(event) => {
						setApplyLayerEffects(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Apply supported adjustment layers
				<input
					type="checkbox"
					checked={applyAdjustments}
					onChange={(event) => {
						setApplyAdjustments(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Composite clipping groups
				<input
					type="checkbox"
					checked={compositeClippingGroups}
					onChange={(event) => {
						setCompositeClippingGroups(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Extract bounded isolated/nested/pass-through groups
				<input
					type="checkbox"
					checked={compositeGroups}
					onChange={(event) => {
						setCompositeGroups(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Render embedded PSD smart-object sources
				<input
					type="checkbox"
					checked={renderEmbeddedSmartObjects}
					onChange={(event) => {
						setRenderEmbeddedSmartObjects(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			{renderEmbeddedSmartObjects && (
				<div className="text-xs text-muted-foreground">
					Uses each contributing raster layer’s exact embedded PSD-v1 merged composite, authored corner transform, premultiplied bilinear sampling, and existing masks.
					Exact tensor and piecewise quilt custom Bezier envelopes execute. Forty-five ordered smart-filter types execute before placement: Add Noise, Dust & Scratches,
					Reduce Noise, Color Halftone, Crystallize, Mezzotint, Mosaic, Pointillize, Clouds, Difference Clouds, Diffuse, Emboss, Extrude, Tiles, Trace Contour, Wind,
					De-Interlace, Fibers, Lens Flare, Average, Blur, Blur More, Box Blur, Gaussian Blur, Median, Maximum, Minimum, High Pass, Motion Blur, Radial Blur, Despeckle,
					Facet, Fragment, Sharpen, Sharpen Edges, Sharpen More, Find Edges, Solarize, NTSC Colors, Smart Sharpen, Unsharp Mask, Smart Blur, Surface Blur, Heart Card
					Shape Blur, and Invert. All use explicit bounded algorithm evidence, 20 supported Photoshop blend modes, and bounded document-space FEid/FXid filter-mask
					coverage; standard preset, tensor, and quilt warps execute, while unknown warps, unsupported filters, malformed masks, and unsupported blends block explicitly.
				</div>
			)}
			{unresolvedShapeBlurPresets.length > 0 && (
				<div className="flex flex-col gap-2 rounded border border-border p-2 text-xs">
					<div className="font-medium">Custom Shape Blur kernels</div>
					<div className="text-muted-foreground">
						Bind each unresolved Photoshop custom-shape identifier to an explicit contained project raster. Auto uses alpha when transparency exists, otherwise
						luminance; the exact asset bytes, channel, inversion, dimensions, and coverage enter the extraction lease.
					</div>
					{unresolvedShapeBlurPresets.map((shape) => {
						const binding = shapeBlurKernelBindings[shape.id];
						const evidence = status?.shapeBlurKernelBindings.find((candidate) => candidate.shapeId === shape.id);
						return (
							<div key={shape.id} className="flex flex-col gap-1 rounded bg-background/40 p-2">
								<div className="break-all font-medium">
									{shape.name} · {shape.id}
								</div>
								<div className="grid grid-cols-[1fr_auto_auto] gap-1">
									<input
										className="h-7 rounded bg-input px-1"
										placeholder="assets/kernels/custom-shape.png"
										value={binding?.sourcePath ?? ""}
										onChange={(event) => updateShapeBlurKernelBinding(shape.id, { sourcePath: event.target.value })}
									/>
									<button
										type="button"
										className="h-7 rounded border border-border px-2"
										onClick={() => {
											const selected = openSingleFileDialog({ title: `Bind Shape Blur kernel ${shape.name}` });
											if (selected) {
												updateShapeBlurKernelBinding(shape.id, { sourcePath: selected });
											}
										}}
									>
										Choose…
									</button>
									<button type="button" className="h-7 px-2 underline" disabled={!binding} onClick={() => updateShapeBlurKernelBinding(shape.id, null)}>
										Clear
									</button>
								</div>
								<div className="flex flex-wrap items-center gap-3">
									<label className="flex items-center gap-1">
										Coverage
										<select
											className="h-7 rounded bg-input px-1"
											value={binding?.coverageSource ?? "auto"}
											onChange={(event) => updateShapeBlurKernelBinding(shape.id, { coverageSource: event.target.value as "auto" | "alpha" | "luminance" })}
										>
											<option value="auto">Auto</option>
											<option value="alpha">Alpha</option>
											<option value="luminance">Luminance</option>
										</select>
									</label>
									<label className="flex items-center gap-1">
										<input
											type="checkbox"
											checked={binding?.invert === true}
											onChange={(event) => updateShapeBlurKernelBinding(shape.id, { invert: event.target.checked })}
										/>
										Invert coverage
									</label>
								</div>
								{evidence && (
									<div className="break-all text-emerald-400">
										Bound {evidence.width}×{evidence.height} {evidence.effectiveCoverageSource} coverage {evidence.coverageMinimum}-{evidence.coverageMaximum} ·
										nonzero {evidence.nonZeroSampleCount} · SHA-256 {evidence.sourceHash} · {evidence.executionModel}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
			<label className="flex items-center justify-between text-xs">
				Render explicitly bound external smart-object sources
				<input
					type="checkbox"
					checked={renderExternalSmartObjects}
					onChange={(event) => {
						setRenderExternalSmartObjects(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			{renderExternalSmartObjects && (
				<div className="text-xs text-muted-foreground">
					Uses only the absolute files selected below for exact external resources; PSD-stored paths are never followed. Bounded RGBA8 decode, authored placement/custom
					Bezier envelope, and masks execute.
				</div>
			)}
			<label className="flex items-center justify-between text-xs">
				Publish embedded smart-object payloads
				<input
					type="checkbox"
					checked={extractSmartObjectPayloads}
					onChange={(event) => {
						setExtractSmartObjectPayloads(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			<label className="flex items-center justify-between text-xs">
				Inspect nested PSD smart objects
				<input
					type="checkbox"
					checked={inspectNestedSmartObjects}
					onChange={(event) => {
						setInspectNestedSmartObjects(event.target.checked);
						setPlanDirty(true);
					}}
				/>
			</label>
			{inspectNestedSmartObjects && (
				<label className="flex items-center justify-between gap-2 text-xs">
					Maximum nested depth
					<input
						className="h-7 w-20 rounded bg-input px-1"
						type="number"
						min={1}
						max={8}
						value={nestedSmartObjectMaximumDepth}
						onChange={(event) => {
							setNestedSmartObjectMaximumDepth(Number(event.target.value));
							setPlanDirty(true);
						}}
					/>
				</label>
			)}
			<div className="flex flex-wrap gap-2">
				<button type="button" className="h-8 rounded border border-border px-2" disabled={loading} onClick={() => void inspect()}>
					{loading ? "Working…" : "Inspect Plan"}
				</button>
				<button
					type="button"
					className="h-8 rounded border border-border px-2"
					disabled={loading || planDirty || !status || status.conflictCount + status.smartObjectPayloadConflictCount > 0}
					onClick={() => void extract()}
				>
					Extract Layers
				</button>
				<button
					type="button"
					className="h-8 px-2 text-xs underline"
					disabled={loading}
					onClick={() => {
						setLayerIndices(null);
						setPlanDirty(true);
					}}
				>
					Use all eligible
				</button>
			</div>
			{status && (
				<>
					{status.document.patterns.length > 0 && (
						<div className="text-xs text-muted-foreground">{status.document.patterns.length} embedded Patt/Pat2/Pat3 pattern tile(s) resolved from this PSD.</div>
					)}
					{status.document.smartObjectResources.length > 0 && (
						<div className="text-xs text-muted-foreground">
							{status.document.smartObjectResources.length} bounded smart-object linked resource(s):{" "}
							{status.document.smartObjectResources.filter((resource) => resource.type === "embedded").length} embedded,{" "}
							{status.document.smartObjectResources.filter((resource) => resource.type === "external").length} external,{" "}
							{status.document.smartObjectResources.filter((resource) => resource.type === "alias").length} alias.
						</div>
					)}
					<div className="text-xs">
						{status.document.format.toUpperCase()} · version {status.document.version} · {status.document.depth}-bit · {status.document.channelConversionModel} ·{" "}
						{status.document.layerInfoSource} layer info · {status.document.width}×{status.document.height} · {status.document.layerCount} record(s) ·{" "}
						{status.selectedLayerCount} selected · {status.createdCount} create · {status.reusedCount} reuse · {status.conflictCount} conflict
					</div>
					{isPsb && status.document.smartObjectResources.some((resource) => resource.type === "embedded" && resource.recordSignature === "liFD") && (
						<div className="text-xs text-amber-400">
							PSB-v2 inspection, extraction, and smart-object rendering are supported. Semantic embedded-payload replacement remains bounded to PSD-v1.
						</div>
					)}
					{status.smartObjectPayloads.length > 0 && (
						<div className="text-xs text-emerald-400">
							{status.smartObjectPayloads.length} smart-object source payload(s) planned · {status.smartObjectPayloadCreatedCount} create ·{" "}
							{status.smartObjectPayloadReusedCount} reuse · {status.smartObjectPayloadConflictCount} conflict · bounded-smart-object-payload-publication-v1
						</div>
					)}
					{status.inspectNestedSmartObjects && (
						<div className="text-xs text-muted-foreground">
							Nested smart objects · {status.nestedSmartObjectDocuments.length} embedded resource(s) traversed · {status.nestedSmartObjectInspectedCount} Photoshop
							document(s) inspected · {status.nestedSmartObjectBlockedCount} explicit blocker(s) · depth limit {status.nestedSmartObjectMaximumDepth} ·
							bounded-nested-smart-object-v1
						</div>
					)}
					{status.nestedSmartObjectDocuments.map((entry) => {
						const replacement = smartObjectReplacementSources[entry.resourcePath.join("/")];
						return (
							<div key={entry.resourcePath.join("/")} className={`text-xs ${entry.status === "inspected" ? "text-emerald-400" : "text-amber-400"}`}>
								Nested {entry.resourcePath.map((index) => `#${index}`).join("/")} · ids {entry.resourceIdPath.join("/") || "unnamed"} · depth {entry.depth} ·{" "}
								{entry.resourceName || "untitled"} · {entry.byteLength} byte(s) · {entry.format} · {entry.status}
								{entry.document
									? ` · ${entry.document.format.toUpperCase()} v${entry.document.version} · ${entry.document.depth}-bit · ${entry.document.channelConversionModel} · ${entry.document.layerInfoSource} layer info · ${entry.document.width}×${entry.document.height} · ${entry.document.layerCount} layer(s) · ${entry.document.smartObjectResourceCount} linked resource(s)`
									: ""}
								{entry.message ? ` · ${entry.message}` : ""} · {entry.executionModel}
								{!isPsb && entry.resourcePath.length > 1 && (
									<div className="mt-1 grid grid-cols-[1fr_auto_auto] gap-1 text-foreground">
										<input
											className="h-7 rounded bg-input px-1"
											placeholder={`Absolute replacement for ${entry.resourcePath.map((index) => `#${index}`).join("/")}`}
											value={replacement?.sourcePath ?? ""}
											onChange={(event) => updateSmartObjectReplacement(entry.resourcePath, event.target.value)}
										/>
										<button
											type="button"
											className="h-7 rounded border border-border px-2"
											onClick={() => {
												const selected = openSingleFileDialog({ title: `Replace nested ${entry.resourceName || entry.resourceId}` });
												if (selected) {
													updateSmartObjectReplacement(entry.resourcePath, selected);
												}
											}}
										>
											Choose…
										</button>
										<button
											type="button"
											className="h-7 px-2 underline"
											disabled={!replacement}
											onClick={() => updateSmartObjectReplacement(entry.resourcePath, null)}
										>
											Clear
										</button>
									</div>
								)}
							</div>
						);
					})}
					{status.document.smartObjectResources.map((resource) => {
						const binding = smartObjectExternalBindings[resource.index];
						const replacement = smartObjectReplacementSources[String(resource.index)];
						return (
							<div key={`${resource.sourceKey}-${resource.index}`} className={`text-xs ${resource.type === "embedded" ? "text-emerald-400" : "text-amber-400"}`}>
								Resource {resource.index} · {resource.type} · {resource.sourceKey}/{resource.recordSignature} v{resource.version} · {resource.id || "unnamed"} ·{" "}
								{resource.name || "untitled"} · {resource.dataBytes} byte(s) · {resource.executionModel}
								{resource.type === "external"
									? " · embedded paths are evidence only; choose a local file explicitly"
									: resource.type === "alias"
										? " · alias retained as evidence only"
										: ""}
								{resource.type === "external" && (
									<div className="mt-1 grid grid-cols-[1fr_auto_auto] gap-1 text-foreground">
										<input
											className="h-7 rounded bg-input px-1"
											placeholder="Choose an absolute replacement file"
											value={binding?.sourcePath ?? ""}
											onChange={(event) => updateExternalBinding(resource.index, { sourcePath: event.target.value })}
										/>
										<button
											type="button"
											className="h-7 rounded border border-border px-2"
											onClick={() => {
												const selected = openSingleFileDialog({ title: `Relink ${resource.name || resource.id}` });
												if (selected) {
													updateExternalBinding(resource.index, { sourcePath: selected });
												}
											}}
										>
											Choose…
										</button>
										<button type="button" className="h-7 px-2 underline" disabled={!binding} onClick={() => updateExternalBinding(resource.index, null)}>
											Clear
										</button>
										<label className="col-span-3 flex items-center gap-2">
											<input
												type="checkbox"
												checked={binding?.allowSizeMismatch === true}
												disabled={!binding}
												onChange={(event) => updateExternalBinding(resource.index, { allowSizeMismatch: event.target.checked })}
											/>
											Allow reviewed size mismatch (PSD recorded {resource.external?.fileSize ?? 0} bytes)
										</label>
									</div>
								)}
								{!isPsb && resource.type === "embedded" && resource.recordSignature === "liFD" && (
									<div className="mt-1 grid grid-cols-[1fr_auto_auto] gap-1 text-foreground">
										<input
											className="h-7 rounded bg-input px-1"
											placeholder="Absolute replacement payload file"
											value={replacement?.sourcePath ?? ""}
											onChange={(event) => updateSmartObjectReplacement([resource.index], event.target.value)}
										/>
										<button
											type="button"
											className="h-7 rounded border border-border px-2"
											onClick={() => {
												const selected = openSingleFileDialog({ title: `Replace embedded ${resource.name || resource.id}` });
												if (selected) {
													updateSmartObjectReplacement([resource.index], selected);
												}
											}}
										>
											Choose…
										</button>
										<button
											type="button"
											className="h-7 px-2 underline"
											disabled={!replacement}
											onClick={() => updateSmartObjectReplacement([resource.index], null)}
										>
											Clear
										</button>
										<span className="col-span-3 text-muted-foreground">
											Replace exact top-level liFD bytes in a new PSD copy; the source PSD remains unchanged.
										</span>
									</div>
								)}
							</div>
						);
					})}
					{!isPsb && status.document.smartObjectResources.some((resource) => resource.type === "embedded" && resource.recordSignature === "liFD") && (
						<div className="flex flex-col gap-2 rounded border border-border p-2">
							<div className="font-medium">Embedded Smart-Object Replacement</div>
							<div className="text-xs text-muted-foreground">
								Select exact top-level resources above or enable nested inspection and select an exact 1–8-level resource path. Replacement recursively rebuilds
								every containing PSD-v1 document into a separate project PSD, never rewrites the source, and never follows PSD-stored paths.
							</div>
							<label className="flex flex-col gap-1 text-xs">
								Destination PSD
								<input
									className="h-8 rounded border border-border bg-input px-2"
									value={replacementDestinationPath}
									placeholder="Sibling <name>-smart-objects.psd"
									onChange={(event) => {
										setReplacementDestinationPath(event.target.value);
										setReplacementDirty(true);
									}}
								/>
							</label>
							<div className="flex flex-wrap gap-2">
								<button
									type="button"
									className="h-8 rounded border border-border px-2"
									disabled={replacementLoading || Object.values(smartObjectReplacementSources).every((request) => !request.sourcePath.trim())}
									onClick={() => void inspectReplacement()}
								>
									{replacementLoading ? "Working…" : "Inspect Replacement"}
								</button>
								<button
									type="button"
									className="h-8 rounded border border-border px-2"
									disabled={replacementLoading || replacementDirty || !replacementStatus || replacementStatus.action === "conflict"}
									onClick={() => void createReplacement()}
								>
									Create Replacement PSD
								</button>
							</div>
							{replacementStatus && (
								<>
									<div className={`text-xs ${replacementStatus.action === "conflict" ? "text-red-400" : "text-emerald-400"}`}>
										{replacementStatus.destinationPath} · {replacementStatus.action} · {replacementStatus.outputByteLength} byte(s) · output SHA-256{" "}
										{replacementStatus.outputHash} · {replacementStatus.executionModel}
									</div>
									{replacementStatus.items.map((item) => (
										<div key={item.resourcePath.join("/")} className="text-xs text-muted-foreground break-all">
											Resource {item.resourcePath.map((index) => `#${index}`).join("/")} · ids {item.resourceIdPath.join("/") || "unnamed"} ·{" "}
											{item.resourceName || item.resourceId || "unnamed"} · {item.previousByteLength} → {item.replacementByteLength} byte(s) ·{" "}
											{item.sourcePath} · SHA-256 {item.sourceHash}
										</div>
									))}
									{replacementStatus.ancestorRebuilds.map((item) => (
										<div key={`ancestor-${item.resourcePath.join("/")}`} className="text-xs text-emerald-400">
											Rebuilt ancestor {item.resourcePath.map((index) => `#${index}`).join("/")} · {item.previousByteLength} → {item.replacementByteLength}{" "}
											byte(s)
										</div>
									))}
								</>
							)}
							{replacementDirty && replacementStatus && (
								<div className="text-xs text-amber-400">Replacement inputs changed. Inspect the exact plan again before creating the PSD.</div>
							)}
							{replacementMessage && <div className={`text-xs break-all ${replacementStatus ? "text-emerald-400" : "text-red-400"}`}>{replacementMessage}</div>}
						</div>
					)}
					{status.items.some((item) => item.clippedLayerIndices.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.clippedLayerIndices.length, 0)} clipped layer(s) will be composited into their base sprites.
						</div>
					)}
					{status.items.some((item) => item.appliedLayerEffects.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedLayerEffects.length, 0)} layer effect(s) will be baked into extracted sprites.
						</div>
					)}
					{status.items.some((item) => item.appliedAdjustments.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedAdjustments.length, 0)} adjustment layer application(s) will be baked into extracted sprites.
						</div>
					)}
					{status.items.some((item) => item.appliedGroupMasks.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedGroupMasks.length, 0)} group mask application(s) will be baked into extracted sprites.
						</div>
					)}
					{status.items.some((item) => item.appliedLayerStyleMask) && (
						<div className="text-xs text-emerald-400">
							{status.items.filter((item) => item.appliedLayerStyleMask).length} Layer Mask Hides Effects application(s) will mask the final styled layer.
						</div>
					)}
					{status.items.some((item) => item.appliedVectorStyleMask) && (
						<div className="text-xs text-emerald-400">
							{status.items.filter((item) => item.appliedVectorStyleMask).length} Vector Mask Hides Effects application(s) will mask the final styled layer.
						</div>
					)}
					{status.items.some((item) => item.appliedInteriorEffectBlending.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedInteriorEffectBlending.length, 0)} Blend Interior Effects as Group application(s) use exact
							backdrop order.
						</div>
					)}
					{status.items.some((item) => item.appliedClippedLayerBlending.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedClippedLayerBlending.length, 0)} Blend Clipped Layers as Group application(s) use exact
							backdrop order.
						</div>
					)}
					{status.items.some((item) => item.appliedTransparencyShaping.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedTransparencyShaping.length, 0)} Transparency Shapes Layer application(s) use exact effect
							shape and fill opacity.
						</div>
					)}
					{status.items.some((item) => item.appliedKnockouts.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedKnockouts.length, 0)} Knockout application(s) use exact shallow/deep stopping boundaries.
						</div>
					)}
					{status.document.layers.some((layer) => layer.protectedSettings) && (
						<div className="text-xs text-emerald-400">
							{status.document.layers.filter((layer) => layer.protectedSettings).length} layer(s) preserve exact lspf Protected Settings flags.
						</div>
					)}
					{status.document.layers.some((layer) => layer.sheetColor) && (
						<div
							className={
								status.document.layers.some((layer) => layer.sheetColor?.color === "unknown" || layer.sheetColor?.reservedNonZero)
									? "text-xs text-amber-400"
									: "text-xs text-emerald-400"
							}
						>
							{status.document.layers.filter((layer) => layer.sheetColor).length} layer(s) preserve exact lclr Sheet Color records.
						</div>
					)}
					{status.document.layers.some((layer) => layer.effectsReferencePoint) && (
						<div className="text-xs text-emerald-400">
							{status.document.layers.filter((layer) => layer.effectsReferencePoint).length} layer(s) preserve exact fxrp Effects Reference Points.
						</div>
					)}
					{status.document.layers.some((layer) => layer.channelBlendingRestrictions) && (
						<div
							className={
								status.document.layers.some(
									(layer) =>
										Boolean(layer.channelBlendingRestrictions?.unsupportedChannelIds.length) ||
										Boolean(layer.channelBlendingRestrictions?.duplicateChannelIds.length)
								)
									? "text-xs text-amber-400"
									: "text-xs text-emerald-400"
							}
						>
							{status.document.layers.filter((layer) => layer.channelBlendingRestrictions).length} layer(s) preserve and execute brst Channel Blending Restrictions.
						</div>
					)}
					{status.document.layers.some((layer) => layer.solidColorFill) && (
						<div
							className={
								status.document.layers.some((layer) => layer.solidColorFill?.bakeSupported === false) ? "text-xs text-amber-400" : "text-xs text-emerald-400"
							}
						>
							{status.document.layers.filter((layer) => layer.solidColorFill).length} layer(s) preserve and execute SoCo Solid Color Fill descriptors.
						</div>
					)}
					{status.document.layers.some((layer) => layer.patternFill) && (
						<div className={status.document.layers.some((layer) => layer.patternFill?.bakeSupported === false) ? "text-xs text-amber-400" : "text-xs text-emerald-400"}>
							{status.document.layers.filter((layer) => layer.patternFill).length} layer(s) preserve and execute PtFl Pattern Fill descriptors.
						</div>
					)}
					{status.document.layers.some((layer) => layer.gradientFill) && (
						<div
							className={status.document.layers.some((layer) => layer.gradientFill?.bakeSupported === false) ? "text-xs text-amber-400" : "text-xs text-emerald-400"}
						>
							{status.document.layers.filter((layer) => layer.gradientFill).length} layer(s) preserve and execute GdFl Gradient Fill descriptors.
						</div>
					)}
					{status.document.layers.some((layer) => layer.vectorStroke) && (
						<div
							className={status.document.layers.some((layer) => layer.vectorStroke?.bakeSupported === false) ? "text-xs text-amber-400" : "text-xs text-emerald-400"}
						>
							{status.document.layers.filter((layer) => layer.vectorFill).length} vscg vector fill(s) and{" "}
							{status.document.layers.filter((layer) => layer.vectorStroke).length} vstk vector stroke(s) preserve authored content and execute bounded paths.
						</div>
					)}
					{status.document.layers.some((layer) => layer.vectorOrigination) && (
						<div className="text-xs text-emerald-400">
							{status.document.layers.filter((layer) => layer.vectorOrigination).length} vogk Vector Origination record(s) preserve authored shape geometry and
							transforms.
						</div>
					)}
					{status.document.layers.some((layer) => layer.vectorRenderingVersion) && (
						<div
							className={
								status.document.layers.some((layer) => layer.vectorRenderingVersion?.observedPhotoshopValue === false)
									? "text-xs text-amber-400"
									: "text-xs text-emerald-400"
							}
						>
							{status.document.layers.filter((layer) => layer.vectorRenderingVersion).length} vowv Vector Rendering Version record(s) preserve authored values
							exactly.
						</div>
					)}
					{status.document.layers.some((layer) => layer.pathList) && (
						<div className="text-xs text-emerald-400">
							{status.document.layers.filter((layer) => layer.pathList).length} pths Path List record(s) preserve named path and symmetry descriptors exactly.
						</div>
					)}
					{status.items.some((item) => item.textLayer) && (
						<div className="text-xs text-emerald-400">
							{status.items.filter((item) => item.textLayer).length} Photoshop text layer(s) preserve TySh semantics and embedded raster pixels.
						</div>
					)}
					{status.items.some((item) => item.smartObjectLayer) && (
						<div className="text-xs text-emerald-400">
							{status.items.filter((item) => item.smartObjectLayer).length} Photoshop smart-object layer(s) preserve placement metadata ·{" "}
							{status.items.reduce((count, item) => count + item.appliedSmartObjectRenders.length, 0)} live smart-object source render(s).
						</div>
					)}
					{status.items.some((item) => item.appliedTextRenders.length) && (
						<div className="text-xs text-emerald-400">
							{status.items.reduce((count, item) => count + item.appliedTextRenders.length, 0)} text layer(s) will be deterministically rerasterized from project
							fonts.
						</div>
					)}
					<div className="max-h-64 overflow-auto rounded border border-border">
						{status.document.layers.map((layer) => {
							const solidColorFillItem = status.items.find((item) => item.layerIndex === layer.index && item.solidColorFill);
							const patternFillItem = status.items.find((item) => item.layerIndex === layer.index && item.patternFill);
							const gradientFillItem = status.items.find((item) => item.layerIndex === layer.index && item.gradientFill);
							const vectorFillItem = status.items.find((item) => item.layerIndex === layer.index && item.vectorFill);
							const vectorStrokeItem = status.items.find((item) => item.layerIndex === layer.index && item.vectorStroke);
							const vectorOriginationItem = status.items.find((item) => item.layerIndex === layer.index && item.vectorOrigination);
							const vectorRenderingVersionItem = status.items.find((item) => item.layerIndex === layer.index && item.vectorRenderingVersion);
							const pathListItem = status.items.find((item) => item.layerIndex === layer.index && item.pathList);
							const clippingHandled = compositeClippingGroups && layer.clipping && compositedPsdBlendModes.has(layer.blendMode);
							const bakedEffects = status.items.flatMap((item) => item.appliedLayerEffects).filter((effect) => effect.layerIndex === layer.index);
							const appliedAdjustment = status.items.flatMap((item) => item.appliedAdjustments).find((adjustment) => adjustment.layerIndex === layer.index);
							const appliedGroupMask = status.items.flatMap((item) => item.appliedGroupMasks).find((mask) => mask.groupIndex === layer.index);
							const appliedLayerStyleMask = status.items.find((item) => item.layerIndex === layer.index)?.appliedLayerStyleMask ?? null;
							const appliedVectorStyleMask = status.items.find((item) => item.layerIndex === layer.index)?.appliedVectorStyleMask ?? null;
							const appliedInteriorEffectBlending = status.items
								.flatMap((item) => item.appliedInteriorEffectBlending)
								.find((candidate) => candidate.layerIndex === layer.index);
							const appliedClippedLayerBlending = status.items
								.flatMap((item) => item.appliedClippedLayerBlending)
								.find((candidate) => candidate.baseLayerIndex === layer.index);
							const appliedTransparencyShaping = status.items
								.flatMap((item) => item.appliedTransparencyShaping)
								.find((candidate) => candidate.layerIndex === layer.index);
							const appliedKnockout = status.items.flatMap((item) => item.appliedKnockouts).find((candidate) => candidate.layerIndex === layer.index);
							const groupComposite = status.groupComposites.find((group) => group.groupStartIndex === layer.index);
							const groupCompositeItem = status.items.find((item) => item.layerIndex === layer.index)?.groupComposite;
							const containingBlendCompositeItem = status.items
								.map((item) => item.groupComposite)
								.find(
									(composite) =>
										(composite?.executionModel === "bounded-backdrop-pass-through-blends-v1" ||
											composite?.executionModel === "bounded-backdrop-pass-through-blends-mask-v1" ||
											composite?.executionModel === "bounded-backdrop-pass-through-blends-effects-v1" ||
											composite?.executionModel === "bounded-backdrop-pass-through-blends-effects-behind-v1" ||
											composite?.executionModel === "bounded-backdrop-pass-through-blends-adjustments-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-blends-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1" ||
											composite?.executionModel === "bounded-nested-backdrop-pass-through-adjustments-v1") &&
										(composite.childLayerIndices.includes(layer.index) ||
											composite.backdropLayerIndices.includes(layer.index) ||
											((composite.executionModel === "bounded-nested-backdrop-pass-through-blends-v1" ||
												composite.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
												composite.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
												composite.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
												composite.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
												composite.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
												composite.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1" ||
												composite.executionModel === "bounded-nested-backdrop-pass-through-adjustments-v1") &&
												composite.nestedGroupIndices.some((nestedIndex) =>
													status.groupComposites.find((group) => group.groupStartIndex === nestedIndex)?.childLayerIndices.includes(layer.index)
												)))
								);
							const textLayerItem = status.items.find((item) => item.layerIndex === layer.index)?.textLayer;
							const smartObjectLayerItem = status.items.find((item) => item.layerIndex === layer.index)?.smartObjectLayer;
							const textRender = textRenders[layer.index];
							const appliedTextRender = status.items.flatMap((item) => item.appliedTextRenders).find((render) => render.layerIndex === layer.index);
							const appliedSmartObjectRender = status.items.flatMap((item) => item.appliedSmartObjectRenders).find((render) => render.layerIndex === layer.index);
							const layerSelectable = layer.extractionSupported || (compositeGroups && groupComposite?.supported === true);
							return (
								<div key={layer.index} className="grid grid-cols-[20px_1fr_auto] items-start gap-2 border-b border-border p-2 text-xs last:border-b-0">
									<input
										type="checkbox"
										disabled={!layerSelectable}
										checked={layerIndices === null ? layerSelectable && (includeHidden || layer.visible) : layerIndices.includes(layer.index)}
										onChange={(event) => toggleLayer(layer.index, event.target.checked)}
									/>
									<span className="break-all">
										{layer.name} {!layer.visible && <span className="text-muted-foreground">(hidden)</span>}
										{clippingHandled && <span className="text-emerald-400"> (composited into base)</span>}
										{groupComposite && (
											<span
												className={
													groupCompositeItem
														? "block text-emerald-400"
														: groupComposite.supported
															? "block text-muted-foreground"
															: "block text-amber-400"
												}
											>
												{groupComposite.blendMode === "pass" ? "Pass-through Group" : "Isolated Group"} · {groupComposite.blendMode} · direct children{" "}
												{groupComposite.directChildLayerIndices.join("/")} · depth {groupComposite.maximumDepth}
												{groupComposite.nestedGroupIndices.length ? ` · nested ${groupComposite.nestedGroupIndices.join("/")}` : ""}
												{groupComposite.passThroughGroupIndices.length ? ` · pass-through ${groupComposite.passThroughGroupIndices.join("/")}` : ""}
												{groupComposite.backdropIncluded
													? ` · opacity ${groupComposite.groupOpacity}/255 · backdrop ${groupComposite.backdropLayerIndices.join("/")} (${groupComposite.backdropBlendModes.join("/")}) included`
													: ""}
												{groupCompositeItem
													? ` · ${groupCompositeItem.executionModel} · extracted composite`
													: groupComposite.warnings.length
														? ` · ${groupComposite.warnings.join(" ")}`
														: groupComposite.requiresParentBackdrop
															? " · composed only inside bounded parent Pass Through group"
															: " · available"}
											</span>
										)}
										{layer.text && (
											<span className={textLayerItem ? "block text-emerald-400" : "block text-muted-foreground"}>
												Text Layer · {JSON.stringify(layer.text.text.length > 80 ? `${layer.text.text.slice(0, 77)}...` : layer.text.text)} ·{" "}
												{layer.text.orientation} · {layer.text.antiAlias}
												{layer.text.fonts.length ? ` · fonts ${layer.text.fonts.map((font) => font.name).join("/")}` : ""} · styles{" "}
												{layer.text.styleRuns.length}
												{layer.text.styleRuns.some((run) => run.language !== null)
													? ` · authored language indices ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.language ?? "default"}`).join(" | ")}`
													: ""}{" "}
												{layer.text.styleRuns.some((run) => run.noBreak === true)
													? `· no-break styles ${layer.text.styleRuns
															.map((run, index) => (run.noBreak ? index + 1 : null))
															.filter((index) => index !== null)
															.join("/")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.autoLeading !== null || run.leading !== null)
													? `· character leading ${layer.text.styleRuns
															.map(
																(run, index) =>
																	`${index + 1}:${run.autoLeading === true ? "auto" : run.autoLeading === false ? `explicit ${run.leading}px` : run.leading === null ? "default" : `${run.leading}px`}`
															)
															.join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.fontCaps !== null)
													? `· font caps ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.fontCaps ?? "default"}`).join(" | ")} `
													: ""}
												{layer.text.smallCapSize !== null ? `· authored small-cap scale ${layer.text.smallCapSize} ` : ""}
												{layer.text.styleRuns.some((run) => run.fontBaseline !== null)
													? `· font baseline ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.fontBaseline ?? "default"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.baselineDirection !== null)
													? `· baseline direction ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.baselineDirection ?? "default"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.proportionalMetrics !== null)
													? `· proportional metrics ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.proportionalMetrics === null ? "default" : run.proportionalMetrics ? "on" : "off"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.kana !== null)
													? `· horizontal Kana ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.kana === null ? "default" : run.kana ? "on" : "off"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.ruby !== null)
													? `· ruby forms ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.ruby === null ? "default" : run.ruby ? "on" : "off"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.japaneseAlternateFeature !== null)
													? `· Japanese alternate ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.japaneseAlternateFeature ?? "default"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some(
													(run) =>
														run.oldStyle !== null || run.swash !== null || run.titling !== null || run.ornaments !== null || run.slashedZero !== null
												)
													? `· character OpenType ${layer.text.styleRuns
															.map(
																(run, index) =>
																	`${index + 1}:onum-${run.oldStyle === null ? "default" : run.oldStyle ? "on" : "off"}/swsh-${run.swash === null ? "default" : run.swash ? "on" : "off"}/titl-${run.titling === null ? "default" : run.titling ? "on" : "off"}/ornm-${run.ornaments === null ? "default" : run.ornaments ? "on" : "off"}/zero-${run.slashedZero === null ? "default" : run.slashedZero ? "on" : "off"}`
															)
															.join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.connectionForms !== null)
													? `· connection forms ${layer.text.styleRuns.map((run, index) => `${index + 1}:calt-${run.connectionForms === null ? "default" : run.connectionForms ? "on" : "off"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.contextualLigatures !== null)
													? `· contextual ligatures ${layer.text.styleRuns.map((run, index) => `${index + 1}:clig-${run.contextualLigatures === null ? "default" : run.contextualLigatures ? "on" : "off"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.hindiNumbers !== null)
													? `· digits ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.hindiNumbers === null ? "default" : run.hindiNumbers ? "hindi" : "arabic-western"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.kashida !== null)
													? `· Kashida ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.kashida ?? "unset"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.diacriticPosition !== null)
													? `· diacritics ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.diacriticPosition ?? "unset"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.characterDirection !== null)
													? `· character direction ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.characterDirection ?? "unset"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.figureStyle !== null)
													? `· figure style ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.figureStyle ?? "default"}`).join(" | ")} `
													: ""}
												{layer.text.engineData2Bytes
													? `· global Txt2 ${layer.text.engineData2Bytes} bytes/${layer.text.engineData2ExecutionModel} ${layer.text.styleRuns
															.map(
																(run, index) =>
																	`${index + 1}:engine-run-${run.engineData2StyleRunIndex === null ? "none" : run.engineData2StyleRunIndex + 1}/frac-${run.fractions === null ? "default" : run.fractions ? "on" : "off"}/ordn-${run.ordinals === null ? "default" : run.ordinals ? "on" : "off"}/salt-${run.stylisticAlternates === null ? "default" : run.stylisticAlternates ? "on" : "off"}`
															)
															.join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.wariChuEnabled !== null)
													? `· Wari-chu ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.wariChuEnabled === null ? "default" : run.wariChuEnabled ? "on" : "off"}/${run.wariChuLineCount ?? 2} lines/gap ${run.wariChuLineGap ?? 0}/scale ${run.wariChuScale ?? 0.5}/widow ${run.wariChuWidow ?? 2}/orphan ${run.wariChuOrphan ?? 2}/${run.wariChuJustification ?? "auto"}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some(
													(run) =>
														run.fillEnabled !== null ||
														run.strokeEnabled !== null ||
														run.fillFirst !== null ||
														run.strokeColor !== null ||
														run.outlineWidth !== null
												)
													? `· text paint ${layer.text.styleRuns.map((run, index) => `${index + 1}:fill-${run.fillEnabled === null ? "default" : run.fillEnabled ? "on" : "off"}/${run.fillColor?.join("/") ?? "missing"} stroke-${run.strokeEnabled === null ? "default" : run.strokeEnabled ? "on" : "off"}/${run.strokeColor?.join("/") ?? "missing"} ${run.fillFirst === null ? "default-order" : run.fillFirst ? "fill-first" : "stroke-first"} outline-${run.outlineWidth ?? "default"}px`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.tsume !== null)
													? `· tsume ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.tsume === null ? "default" : `${run.tsume * 100}%`}`).join(" | ")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.styleRunAlignment !== null)
													? `· style alignment ${layer.text.styleRuns.map((run, index) => `${index + 1}:${run.styleRunAlignment ?? "default"}`).join(" | ")} `
													: ""}
												{layer.text.superscriptSize !== null ||
												layer.text.superscriptPosition !== null ||
												layer.text.subscriptSize !== null ||
												layer.text.subscriptPosition !== null
													? `· super ${layer.text.superscriptSize ?? 0.583}/${layer.text.superscriptPosition ?? 0.333} sub ${layer.text.subscriptSize ?? 0.583}/${layer.text.subscriptPosition ?? 0.333} `
													: ""}
												{layer.text.styleRuns.some((run) => run.kerning !== null && run.kerning !== 0)
													? `· manual kerning ${layer.text.styleRuns
															.map((run, index) => (run.kerning !== null && run.kerning !== 0 ? `${index + 1}:${run.kerning}/1000em` : null))
															.filter(Boolean)
															.join("/")} `
													: ""}
												{layer.text.styleRuns.some((run) => run.autoKerning !== null || run.ligatures !== null || run.discretionaryLigatures !== null)
													? `· OpenType ${layer.text.styleRuns
															.map(
																(run, index) =>
																	`${index + 1}:kern${run.autoKerning === null ? "default" : Number(run.autoKerning)}/liga${run.ligatures === null ? "default" : Number(run.ligatures)}/dlig${run.discretionaryLigatures === null ? "default" : Number(run.discretionaryLigatures)}`
															)
															.join(" | ")} `
													: ""}
												· paragraphs {layer.text.paragraphRuns.length} · transform {layer.text.transform.join("/")} · {layer.text.executionModel}
												{layer.text.shapeType === "box" && layer.text.boxBounds
													? ` · box text ${layer.text.boxBounds.join("/")}`
													: layer.text.shapeType === "point" && layer.text.pointBase
														? ` · point text ${layer.text.pointBase.join("/")}`
														: " · text shape unknown"}
												{layer.text.paragraphRuns.length
													? ` · paragraph runs ${layer.text.paragraphRuns.map((run, index) => `${index + 1}:${run.justification} indent ${run.firstLineIndent ?? 0}/${run.startIndent ?? 0}/${run.endIndent ?? 0} space ${run.spaceBefore ?? 0}/${run.spaceAfter ?? 0} auto-leading ${run.autoLeading ?? "default"} ${run.autoHyphenate ? `hyphenate word/prefix/suffix/limit/zone ${run.hyphenatedWordSize ?? 5}/${run.preHyphen ?? 2}/${run.postHyphen ?? 2}/${run.consecutiveHyphens ?? 2}/${run.hyphenationZone ?? 36}` : "no-hyphenation"} ${run.everyLineComposer ? "every-line" : "single-line"}`).join(" | ")}`
													: ""}
												{textLayerItem ? ` · ${textLayerItem.rasterExecutionModel} · extracted sprite` : " · semantic metadata only"}
											</span>
										)}
										{layer.smartObject && (
											<span className={smartObjectLayerItem ? "block text-emerald-400" : "block text-muted-foreground"}>
												Smart Object · {layer.smartObject.type} · {layer.smartObject.sourceKey} v{layer.smartObject.version} · id{" "}
												{layer.smartObject.id || "unnamed"} · page {layer.smartObject.pageNumber}/{layer.smartObject.totalPages}
												{layer.smartObject.width !== null && layer.smartObject.height !== null
													? ` · source ${layer.smartObject.width}×${layer.smartObject.height}`
													: ""}{" "}
												· transform {layer.smartObject.transform.join("/")} · warp {layer.smartObject.warp.style} ({layer.smartObject.warp.value}%,
												perspective {layer.smartObject.warp.perspective}%/{layer.smartObject.warp.perspectiveOther}%, {layer.smartObject.warp.rotate}) ·{" "}
												{layer.smartObject.executionModel}
												{layer.smartObject.warp.meshPoints.length
													? ` · ${layer.smartObject.warp.meshExecutionModel ?? "unsupported"} mesh ${layer.smartObject.warp.uOrder}×${layer.smartObject.warp.vOrder}/${layer.smartObject.warp.meshPoints.length} point(s)${layer.smartObject.warp.meshExecutionModel === "quilt" ? ` · patches ${layer.smartObject.warp.deformNumCols}×${layer.smartObject.warp.deformNumRows} · slices X ${layer.smartObject.warp.quiltSliceX.join("/") || "uniform"}, Y ${layer.smartObject.warp.quiltSliceY.join("/") || "uniform"}` : ""}${layer.smartObject.warp.meshWarning ? ` · ${layer.smartObject.warp.meshWarning}` : ""}`
													: ""}
												{` · resource ${layer.smartObject.linkedResource.status}${layer.smartObject.linkedResource.resourceIndices.length ? ` #${layer.smartObject.linkedResource.resourceIndices.join("/#")}` : ""}`}
												{layer.smartObject.filterCount
													? ` · ${layer.smartObject.smartFilterState?.enabled === false ? "disabled" : "enabled"} smart-filter stack: ${layer.smartObject.smartFilters.map((filter) => `${filter.index + 1}. ${filter.name} (${smartFilterParameterLabel(filter)}, ${filter.opacity}%, blend ${filter.blendMode}${filter.normalizedBlendMode ? `→${filter.normalizedBlendMode}` : " unsupported"}${filter.algorithmExecutionModel ? `, ${filter.algorithmExecutionModel}` : ""}${filter.blendExecutionModel ? `, ${filter.blendExecutionModel}` : ""}, ${filter.enabled ? (filter.bakeSupported ? "ready" : filter.warning) : "disabled"})`).join(" → ")}`
													: " · no smart filters"}
												{layer.smartObject.smartFilterState?.maskEnabled
													? layer.smartObject.smartFilterMask
														? ` · smart-filter mask ${layer.smartObject.smartFilterMask.sourceKey} ${layer.smartObject.smartFilterMask.id} · ${layer.smartObject.smartFilterMask.width}×${layer.smartObject.smartFilterMask.height} at ${layer.smartObject.smartFilterMask.left}/${layer.smartObject.smartFilterMask.top} · ${layer.smartObject.smartFilterMask.depth}-bit ${layer.smartObject.smartFilterMask.compression} · ${layer.smartObject.smartFilterState.maskLinked ? "linked" : "unlinked"} · outside ${layer.smartObject.smartFilterState.maskExtendWithWhite ? "white" : "black"} · ${layer.smartObject.smartFilterMask.executionModel}`
														: ` · ${layer.smartObject.smartFilterMaskWarning ?? "smart-filter mask unavailable"}`
													: " · smart-filter mask disabled"}
												{smartObjectLayerItem
													? ` · ${smartObjectLayerItem.rasterExecutionModel} · ${appliedSmartObjectRender ? `rendered ${appliedSmartObjectRender.sourceKind} source` : "extracted preview"}`
													: " · semantic metadata only"}
											</span>
										)}
										{appliedSmartObjectRender && (
											<span className="block text-emerald-400">
												Live {appliedSmartObjectRender.sourceKind} {appliedSmartObjectRender.sourceFormat} source #{appliedSmartObjectRender.resourceIndex}{" "}
												· {appliedSmartObjectRender.resourceId || "unnamed"} · {appliedSmartObjectRender.sourceWidth}×
												{appliedSmartObjectRender.sourceHeight} → {appliedSmartObjectRender.width}×{appliedSmartObjectRender.height} at{" "}
												{appliedSmartObjectRender.left}/{appliedSmartObjectRender.top} · {appliedSmartObjectRender.transformSource} ·{" "}
												{appliedSmartObjectRender.sampling} · mask {appliedSmartObjectRender.maskCoverageMinimum}-
												{appliedSmartObjectRender.maskCoverageMaximum} · SHA-256 {appliedSmartObjectRender.resourceHash} ·{" "}
												{appliedSmartObjectRender.sourcePath ?? "embedded bytes"} · {appliedSmartObjectRender.executionModel}
												{appliedSmartObjectRender.executionModel === "bounded-piecewise-bezier-smart-object-quilt-warp-v1"
													? ` · quilt ${appliedSmartObjectRender.deformNumCols}×${appliedSmartObjectRender.deformNumRows} patches · local order ${appliedSmartObjectRender.uOrder}×${appliedSmartObjectRender.vOrder}/${appliedSmartObjectRender.meshPointCount} point(s) · slices X ${appliedSmartObjectRender.quiltSliceX.join("/") || "uniform"}, Y ${appliedSmartObjectRender.quiltSliceY.join("/") || "uniform"} · tessellation ${appliedSmartObjectRender.tessellation}`
													: appliedSmartObjectRender.executionModel === "bounded-analytical-preset-smart-object-warp-v1"
														? ` · preset ${appliedSmartObjectRender.warpStyle} ${appliedSmartObjectRender.warpValue}% · perspective ${appliedSmartObjectRender.warpPerspective}%/${appliedSmartObjectRender.warpPerspectiveOther}% · ${appliedSmartObjectRender.warpRotate} · tessellation ${appliedSmartObjectRender.tessellation}`
														: appliedSmartObjectRender.warpStyle === "warpCustom"
															? ` · custom mesh ${appliedSmartObjectRender.uOrder}×${appliedSmartObjectRender.vOrder}/${appliedSmartObjectRender.meshPointCount} point(s) · tessellation ${appliedSmartObjectRender.tessellation}`
															: ""}
												{appliedSmartObjectRender.filterCount
													? ` · filters ${appliedSmartObjectRender.smartFilterStackEnabled ? "enabled" : "disabled"}: ${appliedSmartObjectRender.appliedSmartFilters.map((filter) => `${filter.index + 1}. ${filter.name} (${smartFilterParameterLabel(filter)}, ${filter.opacity}%, ${filter.algorithmExecutionModel}, ${filter.blendMode}→${filter.normalizedBlendMode}, ${filter.blendExecutionModel})`).join(" → ") || "none applied"} · ${appliedSmartObjectRender.smartFilterExecutionModel}`
													: ""}
												{appliedSmartObjectRender.smartFilterMaskEnabled
													? ` · filter mask ${appliedSmartObjectRender.smartFilterMaskSourceKey} ${appliedSmartObjectRender.smartFilterMaskId} · ${appliedSmartObjectRender.smartFilterMaskWidth}×${appliedSmartObjectRender.smartFilterMaskHeight} at ${appliedSmartObjectRender.smartFilterMaskLeft}/${appliedSmartObjectRender.smartFilterMaskTop} · ${appliedSmartObjectRender.smartFilterMaskDepth}-bit ${appliedSmartObjectRender.smartFilterMaskCompression} · coverage ${appliedSmartObjectRender.smartFilterMaskCoverageMinimum}-${appliedSmartObjectRender.smartFilterMaskCoverageMaximum} · ${appliedSmartObjectRender.smartFilterMaskLinked ? "linked" : "unlinked"} · outside ${appliedSmartObjectRender.smartFilterMaskExtendWithWhite ? "white" : "black"} · ${appliedSmartObjectRender.smartFilterMaskExecutionModel}`
													: ""}
											</span>
										)}
										{layer.text && (
											<div className="mt-1 block">
												<label className="flex items-center gap-2">
													<input
														type="checkbox"
														checked={Boolean(textRender)}
														disabled={layer.text.orientation === "unknown"}
														onChange={(event) => updateTextRender(layer.index, event.target.checked ? {} : null, layer.text!.text)}
													/>
													Rerasterize with project font
												</label>
												{textRender && (
													<div className="mt-1 grid grid-cols-2 gap-1 rounded border border-border p-1">
														{layer.text.orientation === "vertical" && (
															<span className="col-span-2 text-xs text-muted-foreground">
																Vertical TySh uses HarfBuzz top-to-bottom metrics/features with authored columns ordered right-to-left.
															</span>
														)}
														<textarea
															className="col-span-2 min-h-14 rounded bg-input p-1"
															value={textRender.text ?? layer.text.text}
															disabled={textRender.useAuthoredStyleRuns === true}
															onChange={(event) => updateTextRender(layer.index, { text: event.target.value })}
														/>
														<input
															className="col-span-2 h-7 rounded bg-input px-1"
															placeholder="assets/fonts/MyFont.ttf"
															value={textRender.fontPath}
															onChange={(event) => updateTextRender(layer.index, { fontPath: event.target.value })}
														/>
														{layer.text.warp.style !== "warpNone" && (
															<label className="col-span-2 flex items-center gap-2">
																<input
																	type="checkbox"
																	checked={textRender.applyAuthoredWarp === true}
																	onChange={(event) => updateTextRender(layer.index, { applyAuthoredWarp: event.target.checked || undefined })}
																/>
																{layer.text.warp.meshExecutionModel
																	? `Apply authored ${layer.text.warp.meshExecutionModel} ${layer.text.warp.style} text envelope (${layer.text.warp.meshPoints.length} points)`
																	: `Apply authored ${layer.text.warp.style} text warp (${layer.text.warp.value}%)`}
															</label>
														)}
														<label className="col-span-2 flex items-center gap-2">
															<input
																type="checkbox"
																checked={textRender.useAuthoredStyleRuns === true}
																disabled={!layer.text.styleRuns.length}
																onChange={(event) =>
																	updateTextRender(layer.index, {
																		useAuthoredStyleRuns: event.target.checked,
																		text: undefined,
																		applyAuthoredBoxLayout: event.target.checked ? textRender.applyAuthoredBoxLayout : undefined,
																	})
																}
															/>
															Use authored style runs ({layer.text.styleRuns.length})
														</label>
														{layer.text.shapeType === "box" && layer.text.boxBounds && (
															<label className="col-span-2 flex items-center gap-2">
																<input
																	type="checkbox"
																	checked={textRender.applyAuthoredBoxLayout === true}
																	disabled={textRender.useAuthoredStyleRuns !== true}
																	onChange={(event) =>
																		updateTextRender(layer.index, { applyAuthoredBoxLayout: event.target.checked || undefined })
																	}
																/>
																Apply authored box wrapping ({layer.text.boxBounds.join("/")})
															</label>
														)}
														{textRender.useAuthoredStyleRuns &&
															[...new Set(layer.text.styleRuns.map((run) => run.fontIndex).filter((index): index is number => index !== null))].map(
																(fontIndex) => {
																	const font = layer.text!.fonts.find((candidate) => candidate.index === fontIndex);
																	const binding = textRender.styleRunFontBindings?.find((candidate) => candidate.fontIndex === fontIndex);
																	return (
																		<input
																			key={fontIndex}
																			className="col-span-2 h-7 rounded bg-input px-1"
																			placeholder={`Font ${fontIndex} ${font?.name ?? "unnamed"} · defaults to fontPath`}
																			value={binding?.fontPath ?? ""}
																			onChange={(event) => {
																				const remaining = (textRender.styleRunFontBindings ?? []).filter(
																					(candidate) => candidate.fontIndex !== fontIndex
																				);
																				updateTextRender(layer.index, {
																					styleRunFontBindings: event.target.value
																						? [...remaining, { fontIndex, fontPath: event.target.value }]
																						: remaining,
																				});
																			}}
																		/>
																	);
																}
															)}
														<label className="col-span-2 flex items-center gap-2">
															<input
																type="checkbox"
																checked={Boolean(textRender.shaping)}
																onChange={(event) =>
																	updateTextRender(layer.index, { shaping: event.target.checked ? { direction: "ltr" } : undefined })
																}
															/>
															HarfBuzz complex-script shaping
														</label>
														{textRender.shaping && (
															<>
																<select
																	className="h-7 rounded bg-input px-1"
																	value={textRender.shaping.direction}
																	onChange={(event) =>
																		updateTextRender(layer.index, {
																			shaping: { ...textRender.shaping!, direction: event.target.value as "ltr" | "rtl" },
																		})
																	}
																>
																	<option value="ltr">LTR</option>
																	<option value="rtl">RTL</option>
																</select>
																{textRender.useAuthoredStyleRuns === true && (
																	<label className="flex items-center gap-2">
																		<input
																			type="checkbox"
																			checked={Boolean(textRender.shaping.joinAcrossStyleRuns)}
																			onChange={(event) =>
																				updateTextRender(layer.index, {
																					shaping: { ...textRender.shaping!, joinAcrossStyleRuns: event.target.checked || undefined },
																				})
																			}
																		/>
																		Join across matching-font style runs
																	</label>
																)}
																<label className="flex items-center gap-2">
																	<input
																		type="checkbox"
																		checked={Boolean(textRender.shaping.bidirectional)}
																		onChange={(event) =>
																			updateTextRender(layer.index, {
																				shaping: { ...textRender.shaping!, bidirectional: event.target.checked || undefined },
																			})
																		}
																	/>
																	Unicode BiDi visual runs
																</label>
																<input
																	className="h-7 rounded bg-input px-1"
																	maxLength={4}
																	placeholder="Script: Arab"
																	value={textRender.shaping.script ?? ""}
																	onChange={(event) =>
																		updateTextRender(layer.index, {
																			shaping: { ...textRender.shaping!, script: event.target.value || undefined },
																		})
																	}
																/>
																<input
																	className="h-7 rounded bg-input px-1"
																	maxLength={35}
																	placeholder="Language: ar"
																	value={textRender.shaping.language ?? ""}
																	onChange={(event) =>
																		updateTextRender(layer.index, {
																			shaping: { ...textRender.shaping!, language: event.target.value || undefined },
																		})
																	}
																/>
																<input
																	key={`${layer.index}-${JSON.stringify(textRender.shaping.features ?? [])}`}
																	className="h-7 rounded bg-input px-1"
																	placeholder="Features: kern=1,liga=1"
																	defaultValue={(textRender.shaping.features ?? []).map((feature) => `${feature.tag}=${feature.value}`).join(",")}
																	title="Comma-separated four-character OpenType tags and integer values, for example kern=1,liga=1"
																	onBlur={(event) => {
																		const tokens = event.target.value
																			.split(",")
																			.map((token) => token.trim())
																			.filter(Boolean);
																		const features = tokens.map((token) => {
																			const [tag, rawValue] = token.split("=");
																			return { tag, value: Number(rawValue) };
																		});
																		if (
																			features.every((feature) => /^[\x20-\x7E]{4}$/.test(feature.tag) && Number.isSafeInteger(feature.value))
																		) {
																			updateTextRender(layer.index, { shaping: { ...textRender.shaping!, features } });
																		}
																	}}
																/>
															</>
														)}
														<input
															className="h-7 rounded bg-input px-1"
															type="number"
															min={1}
															max={512}
															placeholder="Font px"
															value={textRender.fontSize ?? ""}
															onChange={(event) =>
																updateTextRender(layer.index, { fontSize: event.target.value ? Number(event.target.value) : undefined })
															}
														/>
														<input
															className="h-7 rounded bg-input px-1"
															type="number"
															min={-1000}
															max={10000}
															placeholder="Tracking"
															value={textRender.tracking ?? ""}
															onChange={(event) =>
																updateTextRender(layer.index, { tracking: event.target.value ? Number(event.target.value) : undefined })
															}
														/>
														<select
															className="h-7 rounded bg-input px-1"
															value={textRender.justification ?? "left"}
															onChange={(event) =>
																updateTextRender(layer.index, { justification: event.target.value as "left" | "center" | "right" })
															}
														>
															<option value="left">{layer.text.orientation === "vertical" ? "Top" : "Left"}</option>
															<option value="center">Center</option>
															<option value="right">{layer.text.orientation === "vertical" ? "Bottom" : "Right"}</option>
														</select>
														<input
															className="h-7 rounded bg-input px-1"
															type="number"
															min={1}
															max={2048}
															placeholder={layer.text.orientation === "vertical" ? "Column advance" : "Line height"}
															value={textRender.lineHeight ?? ""}
															onChange={(event) =>
																updateTextRender(layer.index, { lineHeight: event.target.value ? Number(event.target.value) : null })
															}
														/>
														<input
															className="h-7 rounded bg-input px-1"
															type="number"
															min={-32768}
															max={32768}
															placeholder="Offset X"
															value={textRender.offsetX ?? ""}
															onChange={(event) =>
																updateTextRender(layer.index, { offsetX: event.target.value ? Number(event.target.value) : undefined })
															}
														/>
														<input
															className="h-7 rounded bg-input px-1"
															type="number"
															min={-32768}
															max={32768}
															placeholder="Offset Y"
															value={textRender.offsetY ?? ""}
															onChange={(event) =>
																updateTextRender(layer.index, { offsetY: event.target.value ? Number(event.target.value) : undefined })
															}
														/>
														<input
															className="h-7 rounded bg-input px-1"
															type="color"
															value={`#${(textRender.color ?? layer.text.styleRuns[0]?.fillColor ?? [255, 255, 255, 255])
																.slice(0, 3)
																.map((channel) => channel.toString(16).padStart(2, "0"))
																.join("")}`}
															onChange={(event) => {
																const value = event.target.value;
																const current = textRender.color ?? layer.text!.styleRuns[0]?.fillColor ?? [255, 255, 255, 255];
																updateTextRender(layer.index, {
																	color: [
																		Number.parseInt(value.slice(1, 3), 16),
																		Number.parseInt(value.slice(3, 5), 16),
																		Number.parseInt(value.slice(5, 7), 16),
																		current[3],
																	],
																});
															}}
														/>
														<input
															className="h-7 rounded bg-input px-1"
															type="number"
															min={0}
															max={255}
															placeholder="Alpha"
															value={(textRender.color ?? layer.text.styleRuns[0]?.fillColor ?? [255, 255, 255, 255])[3]}
															onChange={(event) => {
																const current = textRender.color ?? layer.text!.styleRuns[0]?.fillColor ?? [255, 255, 255, 255];
																updateTextRender(layer.index, { color: [current[0], current[1], current[2], Number(event.target.value)] });
															}}
														/>
														{appliedTextRender && (
															<span className="col-span-2 text-emerald-400">
																{appliedTextRender.fontPath} · {appliedTextRender.fontSize}px · {appliedTextRender.orientation} ·{" "}
																{appliedTextRender.justification} · ink{" "}
																{appliedTextRender.inkBounds
																	? `${appliedTextRender.inkBounds.left}/${appliedTextRender.inkBounds.top}/${appliedTextRender.inkBounds.right}/${appliedTextRender.inkBounds.bottom}`
																	: "none"}{" "}
																· clipped pixels {appliedTextRender.clippedPixelCount} · {appliedTextRender.executionModel} · fallback{" "}
																{appliedTextRender.fontFallback} · style synthesis {appliedTextRender.styleSynthesis}
																{appliedTextRender.shaping
																	? ` · ${appliedTextRender.shaping.engine} ${appliedTextRender.shaping.version} ${appliedTextRender.shaping.direction} ${appliedTextRender.shaping.script ?? "inferred script"} ${appliedTextRender.shaping.language ?? "default language"} · ${appliedTextRender.shaping.styleBoundaryModel}${appliedTextRender.shaping.bidirectional ? ` · ${appliedTextRender.shaping.bidirectional.executionModel} ${appliedTextRender.shaping.bidirectional.engine} ${appliedTextRender.shaping.bidirectional.version} Unicode ${appliedTextRender.shaping.bidirectional.unicodeVersion} · visual runs ${appliedTextRender.shaping.bidirectional.visualRuns.length} · controls ${appliedTextRender.shaping.bidirectional.controlCount} · mirrored ${appliedTextRender.shaping.bidirectional.mirroredCharacterCount}` : ""} · shaped glyphs ${appliedTextRender.shapedGlyphs.length}`
																	: " · simple codepoint layout"}
																{appliedTextRender.styleRuns.length
																	? ` · runs ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.fontName ?? `font ${run.fontIndex}`} ${run.fontSize}px ${run.color.join("/")} scale ${run.horizontalScale}%/${run.verticalScale}% baseline ${run.baselineShift}px${run.capsExecutionModel !== "disabled" ? ` caps ${run.fontCaps} affected ${run.capsAffectedCharacterCount} via ${run.capsGlyphSource} small-cap ${run.smallCapScale} applied ${run.capsAppliedScale} ${run.capsExecutionModel}` : ""}${run.fontBaselineExecutionModel !== "disabled" ? ` font-baseline ${run.fontBaseline} size/position ${run.fontBaselineScale}/${run.fontBaselinePosition} applied ${run.fontBaselineAppliedScale}/${run.fontBaselineAppliedShift}px via ${run.fontBaselineGlyphSource}${run.fontBaselineEffectiveFeature ? ` feature ${run.fontBaselineEffectiveFeature}=1` : ""} ${run.fontBaselineExecutionModel}` : ""}${run.baselineDirectionExecutionModel !== "disabled" ? ` baseline-direction ${run.baselineDirection} glyphs ${run.baselineDirectionGlyphs.map((glyph) => `g${glyph.glyphId}@${glyph.cluster}/line${glyph.lineIndex}:${glyph.unicodeVerticalOrientation ?? "horizontal"}->${glyph.renderedOrientation}/${glyph.shapingDirection}/${glyph.rotationDegrees}deg`).join(",")}${run.tateChuYokoBlocks.length ? ` blocks ${run.tateChuYokoBlocks.map((block) => `line${block.lineIndex}:${block.logicalStart}-${block.logicalEnd} glyphs${block.glyphCount} raw/fitted/cell ${block.rawAdvance}/${block.fittedAdvance}/${block.cellAdvance}px scale${block.fitScale}`).join(",")}` : ""} ${run.baselineDirectionExecutionModel}` : ""}${run.proportionalMetricsExecutionModel !== "disabled" ? ` proportional-metrics ${run.proportionalMetrics ? "on" : "off"} ${run.proportionalMetricsFeatureSupported ? "palt-supported" : "palt-unavailable"} ${run.proportionalMetricsExecutionModel}` : ""}${run.tsumeExecutionModel !== "disabled" ? ` tsume ${(run.tsume ?? 0) * 100}% glyphs ${run.tsumeAppliedGlyphCount} trim ${run.tsumeLeadingTrim}/${run.tsumeTrailingTrim}px reduction ${run.tsumeAdvanceReduction}px ${run.tsumeExecutionModel}` : ""}${run.styleRunAlignmentExecutionModel !== "disabled" ? ` style-align ${run.styleRunAlignment} ${run.styleRunAlignmentGlyphs.map((glyph) => `g${glyph.glyphId}@${glyph.cluster}/line${glyph.lineIndex}:em ${glyph.glyphEmSize}->${glyph.referenceEmSize} coord ${glyph.glyphCoordinate}->${glyph.referenceCoordinate} shift ${glyph.appliedShift}px ${glyph.metricSource}${glyph.baseTag ? ` ${glyph.baseScript}/${glyph.baseTag}/fmt${glyph.baseCoordinateFormat} ref ${glyph.referenceBaseScript}/fmt${glyph.referenceBaseCoordinateFormat}` : ""}`).join(",")} ${run.styleRunAlignmentExecutionModel}` : ""}${run.underline ? ` underline@${run.decorationThickness}px` : ""}${run.strikethrough ? ` strike@${run.decorationThickness}px` : ""}${run.noBreak ? ` no-break ${run.noBreakExecutionModel}` : ""}${run.leadingExecutionModel !== "disabled" ? ` leading ${run.autoLeading ? "auto" : `${run.leading}px`} lines ${run.leadingAppliedLineIndices.map((lineIndex, index) => `${lineIndex}:${run.leadingAppliedLineHeights[index]}px`).join("/") || "none"} ${run.leadingExecutionModel}` : ""}${run.manualKerningExecutionModel !== "disabled" ? ` kern ${run.kerning}/1000em@${run.manualKerningBoundaryUtf16}=${run.manualKerningPixels}px×${run.manualKerningAppliedBoundaryCount} ${run.manualKerningExecutionModel}` : ""}${run.openTypeFeatureExecutionModel !== "disabled" ? ` OpenType ${run.effectiveOpenTypeFeatures.map((feature) => `${feature.tag}=${feature.value}`).join(",")} ${run.openTypeFeatureExecutionModel}` : ""} ${run.fauxBold ? `bold+${run.fauxBoldPixels}px` : "regular"}${run.fauxItalic ? ` italic@${run.fauxItalicShear}` : ""} ${run.characterStyleExecutionModel} ${run.fontPath}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.kanaExecutionModel !== "disabled")
																	? ` · Kana ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.kana === null ? "default" : run.kana ? "on" : "off"}/${run.kanaFeatureSupported ? "hkna-supported" : "hkna-unavailable"}/${run.kanaExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.rubyExecutionModel !== "disabled")
																	? ` · Ruby ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.ruby === null ? "default" : run.ruby ? "on" : "off"}/${run.rubyFeatureSupported ? "ruby-supported" : "ruby-unavailable"}/${run.rubyExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.japaneseAlternateFeatureExecutionModel !== "disabled")
																	? ` · Japanese alternate ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.japaneseAlternateFeature ?? "default"}/${run.japaneseAlternateFeatureTag ?? "no-alternate"}/${run.japaneseAlternateFeatureSupported ? "supported" : "unavailable"}/available-${run.japaneseAlternateFeatureAvailableTags.join(",") || "none"}/${run.japaneseAlternateFeatureExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.stylisticOpenTypeExecutionModel !== "disabled")
																	? ` · global Txt2 OpenType ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:engine-run-${run.engineData2StyleRunIndex === null ? "none" : run.engineData2StyleRunIndex + 1}/frac-${run.fractions === null ? "default" : run.fractions ? "on" : "off"}-${run.fractionsFeatureSupported ? "supported" : "unavailable"}/ordn-${run.ordinals === null ? "default" : run.ordinals ? "on" : "off"}-${run.ordinalsFeatureSupported ? "supported" : "unavailable"}/salt-${run.stylisticAlternates === null ? "default" : run.stylisticAlternates ? "on" : "off"}-${run.stylisticAlternatesFeatureSupported ? "supported" : "unavailable"}/${run.engineData2ExecutionModel}/${run.stylisticOpenTypeExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.characterOpenTypeExecutionModel !== "disabled")
																	? ` · character OpenType ${appliedTextRender.styleRuns
																			.map(
																				(run) =>
																					`${run.sourceStyleRunIndex + 1}:onum-${run.oldStyle === null ? "default" : run.oldStyle ? "on" : "off"}-${run.oldStyleFeatureSupported ? "supported" : "unavailable"}/swsh-${run.swash === null ? "default" : run.swash ? "on" : "off"}-${run.swashFeatureSupported ? "supported" : "unavailable"}/titl-${run.titling === null ? "default" : run.titling ? "on" : "off"}-${run.titlingFeatureSupported ? "supported" : "unavailable"}/ornm-${run.ornaments === null ? "default" : run.ornaments ? "on" : "off"}-${run.ornamentsFeatureSupported ? "supported" : "unavailable"}/zero-${run.slashedZero === null ? "default" : run.slashedZero ? "on" : "off"}-${run.slashedZeroFeatureSupported ? "supported" : "unavailable"}/${run.characterOpenTypeExecutionModel}`
																			)
																			.join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.connectionFormsExecutionModel !== "disabled")
																	? ` · connection forms ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:calt-${run.connectionForms === null ? "default" : run.connectionForms ? "on" : "off"}-${run.connectionFormsFeatureSupported ? "supported" : "unavailable"}/${run.connectionFormsExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.contextualLigaturesExecutionModel !== "disabled")
																	? ` · contextual ligatures ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:clig-${run.contextualLigatures === null ? "default" : run.contextualLigatures ? "on" : "off"}-${run.contextualLigaturesFeatureSupported ? "supported" : "unavailable"}/${run.contextualLigaturesExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.hindiNumbersExecutionModel !== "disabled")
																	? ` · digits ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.hindiNumbersEffectiveDigits}/changed-${run.hindiNumbersAffectedCharacterCount}/${run.hindiNumbersExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.kashidaExecutionModel !== "disabled")
																	? ` · Kashida ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.kashida === null ? "unset" : run.kashida ? "on" : "off"}/eligible-${run.kashidaEligibleJoinCount}/inserted-${run.kashidaInsertedCount}/advance-${run.kashidaInsertedAdvance}/${run.kashidaExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.diacriticExecutionModel !== "disabled")
																	? ` · diacritics ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.diacriticPosition ?? "unset"}/glyphs-${run.diacriticAffectedGlyphCount}/shifts-${run.diacriticGlyphs.map((glyph) => `${glyph.cluster}:${glyph.placement}:${glyph.authoredVerticalShift}`).join(",") || "none"}/${run.diacriticExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.characterDirectionExecutionModel !== "disabled")
																	? ` · character direction ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.characterDirection ?? "unset"}/overridden-${run.characterDirectionOverrideCharacterCount}/levels-${run.characterDirectionResolvedEmbeddingLevels.join(",") || "none"}/${run.characterDirectionExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.figureStyleExecutionModel !== "disabled")
																	? ` · figure style ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.figureStyle ?? "default"}/lnum-${run.figureStyleLiningFeatureSupported ? "supported" : "unavailable"}/onum-${run.figureStyleOldStyleFeatureSupported ? "supported" : "unavailable"}/pnum-${run.figureStyleProportionalFeatureSupported ? "supported" : "unavailable"}/tnum-${run.figureStyleTabularFeatureSupported ? "supported" : "unavailable"}/${run.figureStyleExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.wariChuExecutionModel !== "disabled")
																	? ` · Wari-chu ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:${run.wariChuEnabled ? "on" : "off"}/${run.wariChuLineCount} lines/gap ${run.wariChuLineGap}/scale ${run.wariChuScale}/widow ${run.wariChuWidow}/orphan ${run.wariChuOrphan}/${run.wariChuJustification}/${run.wariChuBlocks.map((block) => `line${block.lineIndex}:${block.logicalStart}-${block.logicalEnd} cell/cross ${block.cellAdvance}/${block.crossSpan}px rows ${block.rows.map((row) => `${row.rowIndex}:${row.logicalStart}-${row.logicalEnd} c${row.clusterCount}/g${row.glyphCount} raw${row.rawAdvance} start${row.alignedStart} extra${row.extraClusterSpacing} ${row.resolvedJustification}`).join(",")}`).join(";") || "no-blocks"}/${run.wariChuExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.languageExecutionModel !== "disabled")
																	? ` · authored languages ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:index ${run.photoshopLanguageIndex ?? "default"}/${run.photoshopLanguage ?? "unmapped"}/effective ${run.effectiveShapingLanguage ?? "default"}/${run.languageSource}/${run.languageExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.styleRuns.some((run) => run.textPaintExecutionModel !== "disabled")
																	? ` · text paint ${appliedTextRender.styleRuns.map((run) => `${run.sourceStyleRunIndex + 1}:fill-${run.fillEnabled ? "on" : "off"}/${run.color.join("/")} samples-${run.fillPixelCount} stroke-${run.strokeEnabled ? "on" : "off"}/${run.strokeColor?.join("/") ?? "none"} samples-${run.strokePixelCount} ${run.fillFirst ? "fill-first" : "stroke-first"} outline-${run.outlineWidth}px/${run.strokeRasterModel}/${run.textPaintExecutionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.paragraphRuns.length
																	? ` · paragraphs ${appliedTextRender.paragraphRuns.map((run) => `${run.sourceParagraphRunIndex + 1}:${run.justification} lines ${run.lineIndices.join("/")} indent ${run.firstLineIndent}/${run.startIndent}/${run.endIndent} space ${run.spaceBefore}/${run.spaceAfter} line-height ${run.appliedLineHeight}px/${run.lineHeightSource} per-line ${run.lineHeights.map((height, index) => `${run.lineIndices[index]}:${height}px/${run.lineHeightSources[index]}`).join(",")} auto-leading ${run.autoLeading ?? "default"} ${run.autoHyphenate ? `hyphenate ${run.insertedHyphenCount} inserted (${run.hyphenationLanguages.join("/") || "no breaks"}) word/prefix/suffix/limit/zone ${run.hyphenatedWordSize}/${run.preHyphen}/${run.postHyphen}/${run.consecutiveHyphens}/${run.hyphenationZone}` : "no-hyphenation"} ${run.everyLineComposer ? "every-line" : "single-line"} ${run.hyphenationExecutionModel} ${run.composerExecutionModel} ${run.lineBreakModel} ${run.executionModel}`).join(" | ")}`
																	: ""}
																{appliedTextRender.boxLayout
																	? ` · box ${appliedTextRender.boxLayout.left}/${appliedTextRender.boxLayout.top}/${appliedTextRender.boxLayout.right}/${appliedTextRender.boxLayout.bottom} · authored/composed ${appliedTextRender.boxLayout.authoredLineCount}/${appliedTextRender.boxLayout.composedLineCount} · soft breaks ${appliedTextRender.boxLayout.softBreakCount} · inserted hyphens ${appliedTextRender.boxLayout.insertedHyphenCount} (${appliedTextRender.boxLayout.hyphenationLanguages.join("/") || "none"}) · no-break runs/prevented ${appliedTextRender.boxLayout.noBreakRunCount}/${appliedTextRender.boxLayout.noBreakPreventedBreakCount} ${appliedTextRender.boxLayout.noBreakExecutionModel} · overflow ${appliedTextRender.boxLayout.overflowLineCount} · lines ${appliedTextRender.boxLayout.lines.map((line) => `${line.lineIndex}:${line.logicalStart}-${line.logicalEnd}${line.insertedHyphen ? "-" : ""}@${line.advance.toFixed(2)}/${line.available.toFixed(2)} height ${line.lineHeight}px/${line.lineHeightSource}${line.leadingSourceStyleRunIndices.length ? ` runs ${line.leadingSourceStyleRunIndices.map((index) => index + 1).join("/")}` : ""}${line.overflow ? "!" : ""}`).join(" | ")} · ${appliedTextRender.boxLayout.wrapModel} · ${appliedTextRender.boxLayout.composerModel} · ${appliedTextRender.boxLayout.executionModel}`
																	: ""}
																{appliedTextRender.authoredWarp
																	? appliedTextRender.authoredWarp.type === "preset"
																		? ` · ${appliedTextRender.authoredWarp.style} ${appliedTextRender.authoredWarp.value}% ${appliedTextRender.authoredWarp.rotate} · perspective ${appliedTextRender.authoredWarp.perspective}/${appliedTextRender.authoredWarp.perspectiveOther} · bounds ${appliedTextRender.authoredWarp.left}/${appliedTextRender.authoredWarp.top}/${appliedTextRender.authoredWarp.width}/${appliedTextRender.authoredWarp.height} · tessellation ${appliedTextRender.authoredWarp.tessellation} · ${appliedTextRender.authoredWarp.executionModel}`
																		: appliedTextRender.authoredWarp.type === "tensor"
																			? ` · ${appliedTextRender.authoredWarp.style} tensor ${appliedTextRender.authoredWarp.uOrder}×${appliedTextRender.authoredWarp.vOrder}/${appliedTextRender.authoredWarp.meshPointCount} points · bounds ${appliedTextRender.authoredWarp.left}/${appliedTextRender.authoredWarp.top}/${appliedTextRender.authoredWarp.width}/${appliedTextRender.authoredWarp.height} · tessellation ${appliedTextRender.authoredWarp.tessellation} · ${appliedTextRender.authoredWarp.executionModel}`
																			: ` · ${appliedTextRender.authoredWarp.style} quilt ${appliedTextRender.authoredWarp.deformNumCols}×${appliedTextRender.authoredWarp.deformNumRows} patches · local ${appliedTextRender.authoredWarp.uOrder}×${appliedTextRender.authoredWarp.vOrder}/${appliedTextRender.authoredWarp.meshPointCount} points · slices X ${appliedTextRender.authoredWarp.quiltSliceX.join("/") || "uniform"}, Y ${appliedTextRender.authoredWarp.quiltSliceY.join("/") || "uniform"} · bounds ${appliedTextRender.authoredWarp.left}/${appliedTextRender.authoredWarp.top}/${appliedTextRender.authoredWarp.width}/${appliedTextRender.authoredWarp.height} · tessellation ${appliedTextRender.authoredWarp.tessellation} · ${appliedTextRender.authoredWarp.executionModel}`
																	: ""}
															</span>
														)}
													</div>
												)}
											</div>
										)}
										{appliedGroupMask && (
											<span className="block text-emerald-400">
												Group Mask · {appliedGroupMask.executionModel} · coverage {appliedGroupMask.maskCoverageMinimum}-
												{appliedGroupMask.maskCoverageMaximum} ·{" "}
												{appliedGroupMask.application === "backdrop-interpolation" ? "modulates backdrop interpolation" : "baked after group effects"}
											</span>
										)}
										{layer.advancedBlending.layerMaskAsGlobalMask !== null && (
											<span className={appliedLayerStyleMask ? "block text-emerald-400" : "block text-muted-foreground"}>
												Layer Mask Hides Effects · {layer.advancedBlending.layerMaskAsGlobalMask ? "on" : "off"} · lmgm ·{" "}
												{layer.advancedBlending.executionModel}
												{appliedLayerStyleMask
													? ` · coverage ${appliedLayerStyleMask.maskCoverageMinimum}-${appliedLayerStyleMask.maskCoverageMaximum} · ${appliedLayerStyleMask.application} · ${appliedLayerStyleMask.executionModel}`
													: ""}
											</span>
										)}
										{layer.advancedBlending.blendInteriorEffectsAsGroup !== null && (
											<span className={appliedInteriorEffectBlending ? "block text-emerald-400" : "block text-muted-foreground"}>
												Blend Interior Effects as Group · {layer.advancedBlending.blendInteriorEffectsAsGroup ? "on" : "off"} · infx ·{" "}
												{layer.advancedBlending.executionModel}
												{appliedInteriorEffectBlending
													? ` · ${appliedInteriorEffectBlending.layerBlendMode.trim() || "normal"} · ${appliedInteriorEffectBlending.application} · effects ${appliedInteriorEffectBlending.interiorEffectTypes.join("/")} · ${appliedInteriorEffectBlending.executionModel}`
													: ""}
											</span>
										)}
										{layer.advancedBlending.blendClippedLayersAsGroup !== null && (
											<span className={appliedClippedLayerBlending ? "block text-emerald-400" : "block text-muted-foreground"}>
												Blend Clipped Layers as Group · {layer.advancedBlending.blendClippedLayersAsGroup ? "on" : "off"} · clbl ·{" "}
												{layer.advancedBlending.executionModel}
												{appliedClippedLayerBlending
													? ` · ${appliedClippedLayerBlending.baseBlendMode.trim() || "normal"} · ${appliedClippedLayerBlending.application} · clipped ${appliedClippedLayerBlending.clippedLayerIndices.join("/")} · modes ${appliedClippedLayerBlending.clippedBlendModes.map((mode) => mode.trim() || "normal").join("/")} · ${appliedClippedLayerBlending.executionModel}`
													: ""}
											</span>
										)}
										{layer.advancedBlending.transparencyShapesLayer !== null && (
											<span className={appliedTransparencyShaping ? "block text-emerald-400" : "block text-muted-foreground"}>
												Transparency Shapes Layer · {layer.advancedBlending.transparencyShapesLayer ? "on" : "off"} · tsly · fill {layer.fillOpacity}/255 ·{" "}
												{layer.advancedBlending.executionModel}
												{appliedTransparencyShaping
													? ` · ${appliedTransparencyShaping.application} · effects ${appliedTransparencyShaping.effectTypes.join("/")} · ${appliedTransparencyShaping.executionModel}`
													: ""}
											</span>
										)}
										{layer.advancedBlending.knockout !== "none" && (
											<span className={appliedKnockout ? "block text-emerald-400" : "block text-muted-foreground"}>
												Knockout · {layer.advancedBlending.knockout} · knko · fill {layer.fillOpacity}/255 · {layer.advancedBlending.executionModel} ·
												{appliedKnockout
													? ` ${appliedKnockout.stoppingBoundary} · destination ${appliedKnockout.destinationLayerIndices.join("/") || "transparency"} · ${appliedKnockout.executionModel}`
													: " parsed; exact bounded stopping boundary unavailable for this selection"}
											</span>
										)}
										{layer.protectedSettings && (
											<span className={layer.protectedSettings.unknownFlags ? "block text-amber-400" : "block text-emerald-400"}>
												Protection · lspf ·{" "}
												{[
													layer.protectedSettings.transparency ? "transparency" : null,
													layer.protectedSettings.composite ? "composite" : null,
													layer.protectedSettings.position ? "position" : null,
													layer.protectedSettings.artboardAutonest ? "artboard-autonest" : null,
												]
													.filter(Boolean)
													.join("/") || "none"}{" "}
												· raw 0x{layer.protectedSettings.rawFlags.toString(16).padStart(8, "0")} · unknown 0x
												{layer.protectedSettings.unknownFlags.toString(16).padStart(8, "0")} · {layer.protectedSettings.executionModel}
											</span>
										)}
										{layer.sheetColor && (
											<span
												className={
													layer.sheetColor.color === "unknown" || layer.sheetColor.reservedNonZero ? "block text-amber-400" : "block text-emerald-400"
												}
											>
												<span
													className="mr-1 inline-block h-2.5 w-2.5 rounded-sm border border-border align-middle"
													style={{ backgroundColor: sheetColorSwatches[layer.sheetColor.color] }}
												/>
												Sheet Color · lclr · {layer.sheetColor.color} · code {layer.sheetColor.colorCode} · reserved{" "}
												{layer.sheetColor.reservedValues.join("/")} · {layer.sheetColor.executionModel}
											</span>
										)}
										{layer.effectsReferencePoint && (
											<span className="block text-emerald-400">
												Effects Reference Point · {layer.effectsReferencePoint.sourceKey} · X {layer.effectsReferencePoint.x} · Y{" "}
												{layer.effectsReferencePoint.y} · {layer.effectsReferencePoint.axisOrder} · {layer.effectsReferencePoint.executionModel}
											</span>
										)}
										{layer.channelBlendingRestrictions && (
											<span
												className={
													layer.channelBlendingRestrictions.unsupportedChannelIds.length || layer.channelBlendingRestrictions.duplicateChannelIds.length
														? "block text-amber-400"
														: "block text-emerald-400"
												}
											>
												Channel Blending Restrictions · {layer.channelBlendingRestrictions.sourceKey} · ids{" "}
												{layer.channelBlendingRestrictions.channelIds.join("/") || "empty"} · channels{" "}
												{layer.channelBlendingRestrictions.restrictedChannels.join("/") || "none"} · unsupported{" "}
												{layer.channelBlendingRestrictions.unsupportedChannelIds.join("/") || "none"} · duplicates{" "}
												{layer.channelBlendingRestrictions.duplicateChannelIds.join("/") || "none"} · {layer.channelBlendingRestrictions.executionModel}
											</span>
										)}
										{layer.solidColorFill && (
											<span
												className={
													solidColorFillItem
														? "block text-emerald-400"
														: layer.solidColorFill.bakeSupported
															? "block text-muted-foreground"
															: "block text-amber-400"
												}
											>
												<span
													className="mr-1 inline-block h-2.5 w-2.5 rounded-sm border border-border align-middle"
													style={{
														backgroundColor: layer.solidColorFill.rgba ? `rgb(${layer.solidColorFill.rgba.slice(0, 3).join(",")})` : "transparent",
													}}
												/>
												Solid Color Fill · {layer.solidColorFill.sourceKey} · {layer.solidColorFill.colorModel}{" "}
												{layer.solidColorFill.authoredValues.join("/") || "unsupported"} · RGBA {layer.solidColorFill.rgba?.join("/") ?? "unavailable"} ·{" "}
												{layer.solidColorFill.renderBounds} bounds · {layer.solidColorFill.coverageSource} · {layer.solidColorFill.conversionModel} ·{" "}
												{layer.solidColorFill.executionModel}
												{solidColorFillItem
													? " · generated pixels included in extraction"
													: layer.solidColorFill.bakeSupported
														? " · not selected"
														: " · evidence only"}
											</span>
										)}
										{layer.patternFill && (
											<span
												className={
													patternFillItem
														? "block text-emerald-400"
														: layer.patternFill.bakeSupported
															? "block text-muted-foreground"
															: "block text-amber-400"
												}
											>
												Pattern Fill · {layer.patternFill.sourceKey} · {layer.patternFill.pattern.name || "unnamed"} · ID{" "}
												{layer.patternFill.pattern.id || "missing"} · scale {layer.patternFill.pattern.scale}% · angle {layer.patternFill.pattern.angle}° ·{" "}
												{layer.patternFill.pattern.align ? "layer-aligned" : "document-aligned"} · phase {layer.patternFill.pattern.phaseX}/
												{layer.patternFill.pattern.phaseY} · {layer.patternFill.pattern.linked ? "linked" : "unlinked"} · resolution{" "}
												{layer.patternFill.pattern.resolutionStatus}
												{layer.patternFill.pattern.resolvedPatternIndices.length
													? ` [${layer.patternFill.pattern.resolvedPatternIndices.join(",")}]`
													: ""}{" "}
												· {layer.patternFill.renderBounds} bounds · {layer.patternFill.coverageSource} · {layer.patternFill.executionModel}
												{patternFillItem
													? " · generated pixels included in extraction"
													: layer.patternFill.bakeSupported
														? " · not selected"
														: " · evidence only"}
											</span>
										)}
										{layer.gradientFill && (
											<span
												className={
													gradientFillItem
														? "block text-emerald-400"
														: layer.gradientFill.bakeSupported
															? "block text-muted-foreground"
															: "block text-amber-400"
												}
											>
												Gradient Fill · {layer.gradientFill.sourceKey} · {layer.gradientFill.gradient.name || "unnamed"} ·{" "}
												{layer.gradientFill.gradient.type}/{layer.gradientFill.gradient.style}/{layer.gradientFill.gradient.interpolation} · scale{" "}
												{layer.gradientFill.gradient.scale}% · angle {layer.gradientFill.gradient.angle}° · offset {layer.gradientFill.gradient.offsetX}/
												{layer.gradientFill.gradient.offsetY}% · {layer.gradientFill.gradient.align ? "layer-aligned" : "document-aligned"} ·{" "}
												{layer.gradientFill.gradient.reverse ? "reversed" : "forward"} · {layer.gradientFill.gradient.dither ? "dithered" : "not dithered"}{" "}
												· {layer.gradientFill.renderBounds} bounds · {layer.gradientFill.coverageSource} · {layer.gradientFill.executionModel}
												{gradientFillItem
													? " · generated pixels included in extraction"
													: layer.gradientFill.bakeSupported
														? " · not selected"
														: " · evidence only"}
											</span>
										)}
										{layer.vectorFill && (
											<span
												className={
													vectorFillItem
														? "block text-emerald-400"
														: layer.vectorFill.bakeSupported
															? "block text-muted-foreground"
															: "block text-amber-400"
												}
											>
												Vector Fill · {layer.vectorFill.sourceKey}/{layer.vectorFill.contentKey} · {layer.vectorFill.content.type} · descriptor class{" "}
												{layer.vectorFill.content.descriptorClassId || "(empty)"} · padding {layer.vectorFill.descriptorPaddingBytes} ·{" "}
												{layer.vectorFill.executionModel}
												{vectorFillItem
													? " · generated pixels included in extraction"
													: layer.vectorFill.bakeSupported
														? " · not selected"
														: " · evidence only"}
											</span>
										)}
										{layer.vectorStroke && (
											<span
												className={
													vectorStrokeItem
														? "block text-emerald-400"
														: layer.vectorStroke.bakeSupported
															? "block text-muted-foreground"
															: "block text-amber-400"
												}
											>
												Vector Stroke · {layer.vectorStroke.sourceKey} · {layer.vectorStroke.strokeEnabled ? "stroke on" : "stroke off"} ·{" "}
												{layer.vectorStroke.fillEnabled ? "fill on" : "fill off"} · width {layer.vectorStroke.lineWidth.value}
												{layer.vectorStroke.lineWidth.units} ({layer.vectorStroke.lineWidth.pixels.toFixed(2)}px) · {layer.vectorStroke.lineAlignment} ·{" "}
												{layer.vectorStroke.lineCap} cap · {layer.vectorStroke.lineJoin} join · miter {layer.vectorStroke.miterLimit} · dash{" "}
												{layer.vectorStroke.lineDashSet.map((entry) => `${entry.value}${entry.units}`).join("/") || "solid"} · offset{" "}
												{layer.vectorStroke.lineDashOffset.value}
												{layer.vectorStroke.lineDashOffset.units} · {layer.vectorStroke.blendMode || "unsupported blend"} · opacity{" "}
												{layer.vectorStroke.opacity}% · {layer.vectorStroke.content.type} content · {layer.vectorStroke.resolution} DPI · padding{" "}
												{layer.vectorStroke.descriptorPaddingBytes} · {layer.vectorStroke.scaleLock ? "scale locked" : "scale unlocked"} ·{" "}
												{layer.vectorStroke.strokeAdjust ? "stroke adjusted" : "stroke unadjusted"} · {layer.vectorStroke.executionModel}
												{vectorStrokeItem
													? " · generated pixels included in extraction"
													: layer.vectorStroke.bakeSupported
														? " · not selected"
														: " · evidence only"}
											</span>
										)}
										{layer.vectorOrigination && (
											<span className={vectorOriginationItem ? "block text-emerald-400" : "block text-muted-foreground"}>
												Vector Origination · vogk · version {layer.vectorOrigination.recordVersion}/{layer.vectorOrigination.descriptorVersion} · class{" "}
												{layer.vectorOrigination.descriptorClassId} · padding {layer.vectorOrigination.descriptorPaddingBytes} ·{" "}
												{layer.vectorOrigination.entries.length} shape(s) ·{" "}
												{layer.vectorOrigination.entries
													.map((entry) => {
														const bounds = entry.shapeBoundingBox;
														const radii = entry.roundedRectangleRadii;
														return `#${entry.originIndex} type ${entry.originType ?? "unknown"} ${entry.originResolution ?? "unknown"} DPI${entry.shapeInvalidated === null ? "" : entry.shapeInvalidated ? " invalidated" : " valid"}${bounds ? ` bbox ${bounds.left.value}${bounds.left.units ?? ""},${bounds.top.value}${bounds.top.units ?? ""}-${bounds.right.value}${bounds.right.units ?? ""},${bounds.bottom.value}${bounds.bottom.units ?? ""}` : ""}${radii ? ` radii ${radii.topRight.value}/${radii.topLeft.value}/${radii.bottomLeft.value}/${radii.bottomRight.value}` : ""}${entry.boxCorners ? ` corners ${entry.boxCorners.corners.map((corner) => `${corner.x},${corner.y}`).join(";")}` : ""}${entry.transform ? ` transform ${entry.transform.matrix.join(",")}` : ""}${entry.unknownEntryKeys.length ? ` unknown ${entry.unknownEntryKeys.join(",")}` : ""}`;
													})
													.join(" · ")}{" "}
												· {layer.vectorOrigination.association} · {layer.vectorOrigination.executionModel}
												{vectorOriginationItem ? " · included in extraction evidence" : " · not selected"}
											</span>
										)}
										{layer.vectorRenderingVersion && (
											<span
												className={
													vectorRenderingVersionItem
														? "block text-emerald-400"
														: layer.vectorRenderingVersion.observedPhotoshopValue
															? "block text-muted-foreground"
															: "block text-amber-400"
												}
											>
												Vector Rendering Version · vowv · value {layer.vectorRenderingVersion.value} ·{" "}
												{layer.vectorRenderingVersion.observedPhotoshopValue
													? "observed Photoshop value"
													: "unrecognized value preserved without guessed semantics"}{" "}
												· {layer.vectorRenderingVersion.executionModel}
												{vectorRenderingVersionItem ? " · included in extraction evidence" : " · not selected"}
											</span>
										)}
										{layer.pathList && (
											<span className={pathListItem ? "block text-emerald-400" : "block text-muted-foreground"}>
												Photoshop Path List · pths · version {layer.pathList.descriptorVersion} · class {layer.pathList.descriptorClassId} · padding{" "}
												{layer.pathList.descriptorPaddingBytes} · {layer.pathList.paths.length} path(s)
												{layer.pathList.paths.length
													? ` · ${layer.pathList.paths
															.map(
																(path) =>
																	`#${path.listIndex} ${path.unicodeName || "(unnamed)"} ${path.symmetry.modeType}${path.symmetry.enumType ? ` ${path.symmetry.enumType}` : ""}.${path.symmetry.value}${path.unknownEntryKeys.length ? ` unknown ${path.unknownEntryKeys.join(",")}` : ""}${path.symmetry.unknownEntryKeys.length ? ` symmetry-unknown ${path.symmetry.unknownEntryKeys.join(",")}` : ""}`
															)
															.join("; ")}`
													: ""}{" "}
												· {layer.pathList.executionModel}
												{pathListItem ? " · included in extraction evidence" : " · not selected"}
											</span>
										)}
										{layer.advancedBlending.vectorMaskAsGlobalMask !== null && (
											<span className={appliedVectorStyleMask ? "block text-emerald-400" : "block text-muted-foreground"}>
												Vector Mask Hides Effects · {layer.advancedBlending.vectorMaskAsGlobalMask ? "on" : "off"} · vmgm ·{" "}
												{layer.advancedBlending.executionModel}
												{appliedVectorStyleMask
													? ` · coverage ${appliedVectorStyleMask.maskCoverageMinimum}-${appliedVectorStyleMask.maskCoverageMaximum} · ${appliedVectorStyleMask.application} · ${appliedVectorStyleMask.executionModel}`
													: ""}
											</span>
										)}
										{layer.adjustment && (
											<span className={appliedAdjustment ? "block text-emerald-400" : "block text-amber-400"}>
												{adjustmentLabel(layer.adjustment)} · {layer.opacity}/255 · {layer.clipping ? "clipped" : "affects layers beneath"} ·{" "}
												{layer.adjustment.executionModel}
												{appliedAdjustment?.maskExecutionModel
													? ` · ${appliedAdjustment.maskExecutionModel} · coverage ${appliedAdjustment.maskCoverageMinimum}-${appliedAdjustment.maskCoverageMaximum}`
													: ""}
												{appliedAdjustment?.groupExecutionModel
													? ` · ${appliedAdjustment.groupExecutionModel} · groups ${appliedAdjustment.crossedGroupIndices.join("/")}`
													: ""}
												{appliedAdjustment ? " · baked into extracted sprite" : layer.visible ? " · not baked" : " · hidden"}
											</span>
										)}
										{layer.mask && (
											<span className={layer.mask.disabled ? "block text-amber-400" : "block text-emerald-400"}>
												Primary Mask · ({layer.mask.left},{layer.mask.top}) {layer.mask.width}×{layer.mask.height} · default {layer.mask.defaultColor}
												{layer.mask.positionRelativeToLayer ? " · layer-relative" : " · document-relative"}
												{layer.mask.inverted ? " · inverted" : ""}
												{layer.mask.userDensity !== null ? ` · density ${layer.mask.userDensity}/255` : ""}
												{layer.mask.userFeather !== null ? ` · feather ${layer.mask.userFeather}px` : ""}
												{layer.mask.disabled
													? " · disabled"
													: appliedGroupMask?.application === "backdrop-interpolation"
														? " · modulates backdrop interpolation"
														: appliedLayerStyleMask
															? " · masks final layer and effects"
															: " · baked into alpha"}
											</span>
										)}
										{layer.vectorMask && (
											<span className={layer.vectorMask.disabled || !layer.vectorMask.bakeSupported ? "block text-amber-400" : "block text-emerald-400"}>
												Vector Mask · {layer.vectorMask.sourceKey} · {layer.vectorMask.subpaths.length} subpath(s) · {layer.vectorMask.knotCount} knots ·
												even-odd · initial {layer.vectorMask.initialFill ? "filled" : "clear"}
												{layer.vectorMask.inverted ? " · inverted" : ""}
												{layer.vectorMask.notLinked ? " · not linked" : " · linked"}
												{layer.mask?.vectorDensity !== null && layer.mask?.vectorDensity !== undefined ? ` · density ${layer.mask.vectorDensity}/255` : ""}
												{layer.mask?.vectorFeather !== null && layer.mask?.vectorFeather !== undefined ? ` · feather ${layer.mask.vectorFeather}px` : ""}
												{` · ${layer.vectorMask.executionModel}`}
												{layer.vectorMask.disabled
													? " · disabled"
													: layer.vectorMask.bakeSupported
														? appliedGroupMask?.application === "backdrop-interpolation"
															? " · modulates backdrop interpolation"
															: appliedVectorStyleMask
																? " · masks final layer and effects"
																: " · baked into alpha"
														: " · not baked"}
											</span>
										)}
										{layer.mask?.realUserMask && (
											<span className={layer.mask.realUserMask.disabled ? "block text-amber-400" : "block text-emerald-400"}>
												Real User Mask · ({layer.mask.realUserMask.left},{layer.mask.realUserMask.top}) {layer.mask.realUserMask.width}×
												{layer.mask.realUserMask.height} · default {layer.mask.realUserMask.defaultColor}
												{layer.mask.realUserMask.positionRelativeToLayer ? " · layer-relative" : " · document-relative"}
												{layer.mask.realUserMask.inverted ? " · inverted" : ""}
												{layer.mask.realUserMask.disabled
													? " · disabled"
													: appliedGroupMask?.application === "backdrop-interpolation"
														? " · modulates backdrop interpolation"
														: " · baked into alpha"}
											</span>
										)}
										{layer.effects?.solidFills.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "sofi" && candidate.effectIndex === effect.index);
											return (
												<span key={`sofi-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													{effect.source === "lfx2" ? "Color Overlay" : "Solid Fill"}
													{effectDescriptorLabel(effect)} · {effect.blendMode.trim() || "normal"} · {effect.opacity}
													{effect.source === "lfx2" ? "%" : "/255"}
													{effect.source === "lfx2"
														? ` · ${effect.present ? "present" : "not present"} · ${effect.showInDialog ? "shown in dialog" : "hidden in dialog"}`
														: ""}
													{baked ? " (baked into sprite)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.gradientOverlays.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "GrFl" && candidate.effectIndex === effect.index);
											return (
												<span key={`GrFl-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Gradient Overlay{effectDescriptorLabel(effect)} · {effect.blendMode.trim() || "normal"} · {effect.opacity}% ·{" "}
													{effect.gradient.name || "unnamed"} ·
													{effect.gradient.type === "noise"
														? ` noise ${effect.gradient.colorModel} · seed ${effect.gradient.randomSeed} · roughness ${Math.round((effect.gradient.roughness ?? 0) * 100)}%${effect.gradient.align ? " · layer-aligned" : " · document-aligned"}${effect.gradient.dither ? " · dithered" : ""}${effect.gradient.restrictColors ? " · restricted" : ""}${effect.gradient.addTransparency ? " · transparency" : ""}`
														: ` ${effect.gradient.style} · ${effect.gradient.interpolation} · ${effect.gradient.angle}° · ${effect.gradient.align ? "layer-aligned" : "document-aligned"}${effect.gradient.dither ? " · dithered" : ""} · ${effect.gradient.colorStops.length} color/${effect.gradient.opacityStops.length} opacity stops${effect.gradient.reverse ? " · reversed" : ""}`}
													{` · ${effect.present ? "present" : "not present"} · ${effect.showInDialog ? "shown in dialog" : "hidden in dialog"}`}
													{baked ? " (baked into sprite)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.innerShadows.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "isdw" && candidate.effectIndex === effect.index);
											return (
												<span key={`isdw-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Inner Shadow{effectDescriptorLabel(effect)} · {effect.blendMode.trim() || "normal"} · blur {effect.blur}px · {effect.opacity}%
													{effect.source === "lfx2"
														? ` · distance ${effect.distance}px · angle ${effect.angle}° · choke ${effect.choke ?? 0}px · noise ${effect.noise ?? 0}% · ${effect.contour?.name || "Linear"} contour · ${effect.useGlobalAngle ? "global angle" : "local angle"} · ${effect.present ? "present" : "not present"} · ${effect.showInDialog ? "shown in dialog" : "hidden in dialog"}${effect.antialiased ? " · antialiased" : " · hard contour"} · ${effect.executionModel}`
														: ""}
													{baked ? " (baked into sprite)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.innerGlows.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "iglw" && candidate.effectIndex === effect.index);
											return (
												<span key={`iglw-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Inner Glow{effectDescriptorLabel(effect)} · {effect.blendMode.trim() || "normal"} · blur {effect.blur}px · {effect.opacity}%
													{effect.source === "lfx2"
														? ` · ${effect.glowSource ?? "edge"} · ${effect.technique ?? "softer"} · choke ${effect.choke ?? 0}px · noise ${effect.noise ?? 0}% · range ${effect.range ?? 50}% · jitter ${effect.jitter ?? 0}% · ${effect.contour?.name || "Linear"} contour · ${effect.present ? "present" : "not present"} · ${effect.showInDialog ? "shown in dialog" : "hidden in dialog"} · ${effect.antialiased ? "antialiased" : "hard contour"} · ${effect.executionModel}`
														: effect.invert
															? " · inverted"
															: ""}
													{baked ? " (baked into sprite)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.dropShadows.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "dsdw" && candidate.effectIndex === effect.index);
											return (
												<span key={`dsdw-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Drop Shadow{effectDescriptorLabel(effect)} · {effect.blendMode.trim() || "normal"} · blur {effect.blur}px · distance{" "}
													{effect.distance}px · {effect.opacity}%
													{effect.source === "lfx2"
														? ` · angle ${effect.angle}° · choke ${effect.choke ?? 0}px · noise ${effect.noise ?? 0}% · ${effect.contour?.name || "Linear"} contour · ${effect.useGlobalAngle ? "global angle" : "local angle"} · ${effect.layerConceals ? "layer conceals" : "layer reveals"} · ${effect.present ? "present" : "not present"} · ${effect.showInDialog ? "shown in dialog" : "hidden in dialog"}${effect.antialiased ? " · antialiased" : " · hard contour"} · ${effect.executionModel}`
														: ""}
													{baked ? " (baked with expanded bounds)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.outerGlows.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "oglw" && candidate.effectIndex === effect.index);
											return (
												<span key={`oglw-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Outer Glow{effectDescriptorLabel(effect)} · {effect.blendMode.trim() || "normal"} · blur {effect.blur}px · {effect.opacity}%
													{effect.source === "lfx2"
														? ` · ${effect.glowSource ?? "edge"} · ${effect.technique ?? "softer"} · choke ${effect.choke ?? 0}px · noise ${effect.noise ?? 0}% · range ${effect.range ?? 50}% · jitter ${effect.jitter ?? 0}% · ${effect.contour?.name || "Linear"} contour · ${effect.present ? "present" : "not present"} · ${effect.showInDialog ? "shown in dialog" : "hidden in dialog"} · ${effect.antialiased ? "antialiased" : "hard contour"} · ${effect.executionModel}`
														: ""}
													{baked ? " (baked with expanded bounds)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.bevels.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "bevl" && candidate.effectIndex === effect.index);
											return (
												<span key={`bevl-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Bevel{effectDescriptorLabel(effect)} · {effect.styleName} ({effect.style}) ·{" "}
													{effect.source === "lfx2"
														? `size ${effect.size}px · depth ${effect.depth}% · soften ${effect.soften}px`
														: `strength ${effect.strength}px · blur ${effect.blur}px`}{" "}
													· {effect.direction === 0 ? "up" : "down"} · highlight {effect.highlightOpacity}% · shadow {effect.shadowOpacity}%
													{effect.source === "lfx2"
														? ` · ${effect.technique} · angle ${effect.angle}° · altitude ${effect.altitude}° · ${effect.useGlobalAngle ? "global angle" : "local angle"} · ${effect.contour?.name || "Linear"} gloss contour · ${effect.antialiasGloss ? "antialiased gloss" : "non-antialiased gloss"} · ${effect.useShape ? `${effect.shapeContour?.name || "Custom"} shape contour at ${effect.shapeRange}% range` : "no shape contour"} · ${effect.useTexture ? `${effect.texturePattern?.name || "embedded"} texture at ${effect.textureDepth}% depth${effect.textureInvert ? " (inverted)" : ""}` : "no texture"} · ${effect.present ? "present" : "not present"} · ${effect.showInDialog ? "shown in dialog" : "hidden in dialog"} · ${effect.executionModel}`
														: ""}
													{baked ? " (baked into sprite)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.satins.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "ChFX" && candidate.effectIndex === effect.index);
											return (
												<span key={`ChFX-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Satin{effectDescriptorLabel(effect)} · {effect.blendMode.trim() || "normal"} · {effect.opacity}% · angle {effect.angle}° ·
													distance {effect.distance}px · size {effect.size}px · {effect.contour?.name || "Linear"} contour
													{effect.invert ? " · inverted" : ""} · {effect.antialiased ? "antialiased" : "not antialiased"} ·{" "}
													{effect.present ? "present" : "not present"} · {effect.showInDialog ? "shown in dialog" : "hidden in dialog"} ·{" "}
													{effect.executionModel}
													{baked ? " (baked into sprite)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.strokes.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "FrFX" && candidate.effectIndex === effect.index);
											return (
												<span key={`FrFX-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Stroke{effectDescriptorLabel(effect)} · {effect.position} · {effect.fillType} · {effect.size}px ·{" "}
													{effect.blendMode.trim() || "normal"} · {effect.opacity}%
													{effect.gradient
														? effect.gradient.type === "noise"
															? ` · ${effect.gradient.name || "unnamed"} · noise ${effect.gradient.colorModel} · seed ${effect.gradient.randomSeed} · roughness ${Math.round((effect.gradient.roughness ?? 0) * 100)}%${effect.gradient.align ? " · layer-aligned" : " · document-aligned"}${effect.gradient.dither ? " · dithered" : ""}${effect.gradient.restrictColors ? " · restricted" : ""}${effect.gradient.addTransparency ? " · transparency" : ""}`
															: ` · ${effect.gradient.name || "unnamed"} · ${effect.gradient.style} · ${effect.gradient.interpolation} · ${effect.gradient.angle}° · ${effect.gradient.align ? "layer-aligned" : "document-aligned"}${effect.gradient.dither ? " · dithered" : ""} · ${effect.gradient.colorStops.length} color/${effect.gradient.opacityStops.length} opacity stops${effect.gradient.reverse ? " · reversed" : ""}`
														: ""}
													{effect.pattern
														? ` · ${effect.pattern.resolvedPatternName || effect.pattern.name || "unnamed"} [${effect.pattern.id}] · ${effect.pattern.resolvedWidth ?? "?"}×${effect.pattern.resolvedHeight ?? "?"} tile · ${effect.pattern.scale}% · ${effect.pattern.angle}° · ${effect.pattern.align ? "layer-aligned" : "document-aligned"} · phase ${effect.pattern.phaseX},${effect.pattern.phaseY}${effect.pattern.linked ? " · linked" : " · unlinked"} · ${effect.pattern.executionModel}`
														: ""}
													{baked
														? effect.position === "inside"
															? " (baked into sprite)"
															: " (baked with expanded bounds)"
														: effect.enabled
															? " (not baked)"
															: " (disabled)"}
												</span>
											);
										})}
										{layer.effects?.patternOverlays.map((effect) => {
											const baked = bakedEffects.some((candidate) => candidate.key === "patternFill" && candidate.effectIndex === effect.index);
											return (
												<span key={`patternFill-${effect.index}`} className={baked ? "block text-emerald-400" : "block text-amber-400"}>
													Pattern Overlay{effectDescriptorLabel(effect)} · {effect.pattern.resolvedPatternName || effect.pattern.name || "unnamed"} [
													{effect.pattern.id}] · {effect.pattern.resolvedWidth ?? "?"}×{effect.pattern.resolvedHeight ?? "?"} tile ·{" "}
													{effect.pattern.scale}% · {effect.pattern.angle}° · {effect.blendMode.trim() || "normal"} · {effect.opacity}% ·{" "}
													{effect.pattern.align ? "layer-aligned" : "document-aligned"} · phase {effect.pattern.phaseX},{effect.pattern.phaseY}
													{effect.pattern.linked ? " · linked" : " · unlinked"} · {effect.pattern.executionModel}
													{baked ? " (baked into sprite)" : effect.enabled ? " (not baked)" : " (disabled)"}
												</span>
											);
										})}
										{layer.warnings
											.filter((warning) => {
												if (
													appliedAdjustment &&
													warning === `Adjustment ${layer.adjustment?.key} is retained as metadata and is applied only while composing layers beneath it.`
												) {
													return false;
												}
												if (
													(groupCompositeItem?.executionModel === "bounded-pass-through-flatten-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-opacity-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-mask-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-mask-effects-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-effects-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-adjustments-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-blends-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-blends-mask-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-blends-effects-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-blends-effects-behind-v1" ||
														groupCompositeItem?.executionModel === "bounded-backdrop-pass-through-blends-adjustments-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-blends-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-mask-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-mask-adjustments-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-mask-effects-adjustments-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-effects-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-effects-adjustments-v1" ||
														groupCompositeItem?.executionModel === "bounded-nested-backdrop-pass-through-adjustments-v1") &&
													warning === "Blend mode pass is not composited into an isolated sprite."
												) {
													return false;
												}
												if (containingBlendCompositeItem && warning === `Blend mode ${layer.blendMode} is not composited into an isolated sprite.`) {
													return false;
												}
												if (clippingHandled && (warning.startsWith("Clipping-group composition") || warning.startsWith("Blend mode"))) {
													return false;
												}
												const match = /^Layer effect (sofi|GrFl|isdw|iglw|dsdw|oglw|bevl|FrFX|patternFill) #(\d+)/.exec(warning);
												return !match || !bakedEffects.some((effect) => effect.key === match[1] && effect.effectIndex === Number(match[2]) - 1);
											})
											.map((warning) => (
												<span key={warning} className="block text-amber-400">
													{warning}
												</span>
											))}
									</span>
									<span>
										{layer.width}×{layer.height}
									</span>
								</div>
							);
						})}
					</div>
				</>
			)}
			{planDirty && <div className="text-xs text-amber-400">Options changed. Inspect the exact plan again before extraction.</div>}
			{message && <div className={`text-xs break-all ${status ? "text-emerald-400" : "text-red-400"}`}>{message}</div>}
		</div>
	);
}

export function EditorInspectorImageComponent(props: IEditorInspectorImageComponentProps) {
	const [width, setWidth] = useState(0);
	const [height, setHeight] = useState(0);
	const source = props.importedCurrent && props.importedPath ? props.importedPath : props.object.absolutePath;
	const [previewSource, setPreviewSource] = useState(source);
	const overrides = parsedOverrides(props.settings?.platformOverrides);
	const updateOverride = (platform: "web" | "desktop", patch: Partial<ITextureImporterPlatformOverride>): void => {
		const current = overrides[platform] ?? { enabled: false };
		props.onPlatformOverridesChange?.(serializeTextureImporterPlatformOverrides({ ...overrides, [platform]: { ...current, ...patch } }));
	};
	const removeOverride = (platform: "web" | "desktop"): void => {
		const next = { ...overrides };
		delete next[platform];
		props.onPlatformOverridesChange?.(serializeTextureImporterPlatformOverrides(next));
	};

	useEffect(() => {
		let disposed = false;
		let objectUrl: string | null = null;
		setWidth(0);
		setHeight(0);
		if (!requiresDecodedProjectImage(source)) {
			setPreviewSource(source);
			return () => undefined;
		}
		void (async () => {
			try {
				const buffer = await (await openProjectImage(source)).png().toBuffer();
				if (disposed) {
					return;
				}
				objectUrl = URL.createObjectURL(new Blob([new Uint8Array(buffer)], { type: "image/png" }));
				setPreviewSource(objectUrl);
			} catch {
				if (!disposed) {
					setPreviewSource("");
				}
			}
		})();
		return () => {
			disposed = true;
			if (objectUrl) {
				URL.revokeObjectURL(objectUrl);
			}
		};
	}, [source]);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex gap-2 justify-center items-center text-xl font-bold">
				<AiFillPicture size="24px" />
				{basename(props.object.absolutePath)}
			</div>

			<Divider />
			{[".psd", ".psb"].some((extension) => props.object.absolutePath.toLowerCase().endsWith(extension)) && (
				<PsdLayerExtractor path={props.object.absolutePath} onAssetsChanged={props.onAssetsChanged} />
			)}
			{props.settings && props.onPlatformOverridesChange && (
				<div className="flex flex-col gap-2 rounded-lg bg-secondary dark:bg-secondary/35 p-3 text-sm">
					<div className="font-semibold">Platform Texture Settings</div>
					<div className="text-xs text-muted-foreground">Web and Desktop builds inherit Default values unless their override is enabled.</div>
					{(["web", "desktop"] as const).map((platform) => {
						const value = overrides[platform] ?? { enabled: false };
						return (
							<div key={platform} className="flex flex-col gap-2 rounded border border-border p-2">
								<div className="flex items-center justify-between">
									<span className="font-medium capitalize">{platform}</span>
									<label className="flex items-center gap-2 text-xs">
										Override
										<input type="checkbox" checked={value.enabled} onChange={(event) => updateOverride(platform, { enabled: event.target.checked })} />
									</label>
								</div>
								{value.enabled && (
									<>
										<label className="grid grid-cols-[1fr_140px] items-center gap-2">
											<span>Max Size</span>
											<select
												className="h-8 rounded border border-border bg-input px-2"
												value={value.maxSize ?? Number(props.settings?.maxSize ?? 4096)}
												onChange={(event) => updateOverride(platform, { maxSize: Number(event.target.value) })}
											>
												{maximumSizes.map((size) => (
													<option key={size} value={size}>
														{size}
													</option>
												))}
											</select>
										</label>
										<label className="grid grid-cols-[1fr_140px] items-center gap-2">
											<span>Resize</span>
											<select
												className="h-8 rounded border border-border bg-input px-2"
												value={value.resizeAlgorithm ?? String(props.settings?.resizeAlgorithm ?? "lanczos3")}
												onChange={(event) =>
													updateOverride(platform, { resizeAlgorithm: event.target.value as ITextureImporterPlatformOverride["resizeAlgorithm"] })
												}
											>
												{["nearest", "bilinear", "bicubic", "lanczos3"].map((algorithm) => (
													<option key={algorithm}>{algorithm}</option>
												))}
											</select>
										</label>
										<label className="grid grid-cols-[1fr_140px] items-center gap-2">
											<span>Compression</span>
											<select
												className="h-8 rounded border border-border bg-input px-2"
												value={value.compression ?? String(props.settings?.compression ?? "normal")}
												onChange={(event) =>
													updateOverride(platform, { compression: event.target.value as ITextureImporterPlatformOverride["compression"] })
												}
											>
												{["none", "low", "normal", "high"].map((compression) => (
													<option key={compression}>{compression}</option>
												))}
											</select>
										</label>
										<label className="flex items-center justify-between">
											<span>Generate Mipmaps</span>
											<input
												type="checkbox"
												checked={value.generateMipmaps ?? props.settings?.generateMipmaps === true}
												onChange={(event) => updateOverride(platform, { generateMipmaps: event.target.checked })}
											/>
										</label>
										<label className="flex items-center justify-between">
											<span>Read/Write</span>
											<input
												type="checkbox"
												checked={value.readable ?? props.settings?.readable === true}
												onChange={(event) => updateOverride(platform, { readable: event.target.checked })}
											/>
										</label>
									</>
								)}
								<button type="button" className="self-start text-xs text-muted-foreground underline" onClick={() => removeOverride(platform)}>
									Reset target
								</button>
							</div>
						);
					})}
				</div>
			)}
			<div className="px-5 text-xs text-muted-foreground">{props.importedCurrent ? "Imported preview artifact" : "Original source preview"}</div>

			<div className="w-full aspect-square p-5 rounded-lg bg-secondary dark:bg-secondary/35">
				<img
					key={previewSource}
					alt=""
					draggable={false}
					src={previewSource}
					className="w-full aspect-square object-contain"
					onLoad={(ev) => {
						setWidth(ev.currentTarget.naturalWidth);
						setHeight(ev.currentTarget.naturalHeight);
					}}
				/>
			</div>

			<div className="bg-secondary dark:bg-secondary/35 p-5 rounded-lg">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Property</TableHead>
							<TableHead>Value</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						<TableRow>
							<TableCell className="font-medium">Width</TableCell>
							<TableCell>{width}px</TableCell>
						</TableRow>
						<TableRow>
							<TableCell className="font-medium">Height</TableCell>
							<TableCell>{height}px</TableCell>
						</TableRow>
						{props.result && (
							<>
								<TableRow>
									<TableCell className="font-medium">Texture Type</TableCell>
									<TableCell>{props.result.settings.textureType}</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">Sampling</TableCell>
									<TableCell>{props.result.effectiveColorSpace}</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">Output</TableCell>
									<TableCell>
										{props.result.output.format.toUpperCase()} · {props.result.output.channels} channel(s)
									</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">Mip levels</TableCell>
									<TableCell>{props.result.mipmaps.length}</TableCell>
								</TableRow>
								<TableRow>
									<TableCell className="font-medium">CPU Readable</TableCell>
									<TableCell>{props.result.readableBitmapPath ? `${(props.result.readablePixelFormat ?? "rgba8").toUpperCase()} generated` : "No"}</TableCell>
								</TableRow>
								{props.result.highDynamicRange && (
									<>
										<TableRow>
											<TableCell className="font-medium">HDR pixels</TableCell>
											<TableCell>
												{props.result.highDynamicRange.pixelFormat} · {props.result.highDynamicRange.compression} · linear
											</TableCell>
										</TableRow>
										<TableRow>
											<TableCell className="font-medium">Preview</TableCell>
											<TableCell>ACES tone mapped · {props.result.highDynamicRange.exposure} EV</TableCell>
										</TableRow>
										<TableRow>
											<TableCell className="font-medium">Cubemap</TableCell>
											<TableCell>
												{props.result.highDynamicRange.equirectangular
													? `2:1 panorama · 6 × ${props.result.highDynamicRange.cubeFaceSize}px previews`
													: "Not a 2:1 panorama"}
											</TableCell>
										</TableRow>
										<TableRow>
											<TableCell className="font-medium">Linear range</TableCell>
											<TableCell>
												{props.result.output.minimum
													?.slice(0, 3)
													.map((value) => value.toPrecision(3))
													.join(", ")}{" "}
												→{" "}
												{props.result.output.maximum
													?.slice(0, 3)
													.map((value) => value.toPrecision(3))
													.join(", ")}
											</TableCell>
										</TableRow>
									</>
								)}
							</>
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
