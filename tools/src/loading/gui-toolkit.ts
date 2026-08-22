import { IGUIRetainedCompilation, IGUIRetainedControlProperties } from "./gui-retained-ui";

export const guiToolkitModel = "unity-ui-toolkit-65-portable-v1" as const;

export type GUIPanelRenderMode = "overlay" | "worldSpace";
export type GUIAnimationProperty = "alpha" | "value" | "fontSize" | "left" | "top" | "width" | "height";
export type GUIAnimationEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";

export interface IGUIPanelRendererSettings {
	renderMode: GUIPanelRenderMode;
	targetMeshId: string | null;
	textureWidth: number;
	textureHeight: number;
	supportPointerMove: boolean;
	onlyAlphaTesting: boolean;
	invertY: boolean;
	foreground: boolean;
	releaseRootOnDispose: boolean;
}

export interface IGUIVisualElementReference {
	id: string;
	controlId: string;
	expectedTypeName: string | null;
}

export interface IGUIAttributeOverride {
	controlId: string;
	property: keyof IGUIRetainedControlProperties;
	value: string | number | boolean;
}

export interface IGUIAnimationTrack {
	id: string;
	controlId: string;
	property: GUIAnimationProperty;
	from: number;
	to: number;
	durationMs: number;
	delayMs: number;
	easing: GUIAnimationEasing;
	loop: boolean;
	autoplay: boolean;
}

export interface IGUIStylesheetStage {
	contextId: string;
	activeStylesheetPath: string | null;
	stylesheetOrder: string[];
}

export interface IGUIToolkitState {
	model: typeof guiToolkitModel;
	panelRenderer: IGUIPanelRendererSettings;
	references: IGUIVisualElementReference[];
	attributeOverrides: IGUIAttributeOverride[];
	animations: IGUIAnimationTrack[];
	stylesheetStage: IGUIStylesheetStage;
}

export interface IGUIUSSSelectorStatistic {
	sourcePath: string;
	selector: string;
	specificity: number;
	pseudoState: string | null;
	declarationCount: number;
	matchedControlCount: number;
}

export interface IGUIUXMLUpgradeEdit {
	rule: "legacy-namespace" | "class-name" | "picking-mode" | "focus-index" | "visible";
	start: number;
	end: number;
	before: string;
	after: string;
	message: string;
}

export interface IGUIUXMLUpgradePlan {
	model: "zvibe-uxml-upgrade-plan-v1";
	path: string;
	sourceRevision: string;
	edits: IGUIUXMLUpgradeEdit[];
	upgradedSource: string;
}

const identifierPattern = /^[A-Za-z_][\w.:-]{0,127}$/;
const retainedProperties = new Set<keyof IGUIRetainedControlProperties>([
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

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertFinite(value: number, minimum: number, maximum: number, label: string): void {
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
	}
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !identifierPattern.test(value)) {
		throw new Error(`${label} must be a stable 1-128 character identifier.`);
	}
}

function normalizeProjectPath(value: unknown, extension: ".uss", label: string): string {
	if (typeof value !== "string") {
		throw new Error(`${label} must be a project-relative ${extension} path.`);
	}
	const path = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
	if (!path || path.length > 1024 || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../") || !path.toLowerCase().endsWith(extension)) {
		throw new Error(`${label} must stay inside the project and end in ${extension}.`);
	}
	return path;
}

export function createDefaultGUIToolkitState(): IGUIToolkitState {
	return {
		model: guiToolkitModel,
		panelRenderer: {
			renderMode: "overlay",
			targetMeshId: null,
			textureWidth: 1024,
			textureHeight: 1024,
			supportPointerMove: true,
			onlyAlphaTesting: false,
			invertY: true,
			foreground: true,
			releaseRootOnDispose: true,
		},
		references: [],
		attributeOverrides: [],
		animations: [],
		stylesheetStage: { contextId: "root", activeStylesheetPath: null, stylesheetOrder: [] },
	};
}

export function normalizeGUIToolkitState(value: unknown, compilation?: IGUIRetainedCompilation | null): IGUIToolkitState {
	const state = clone(value ?? createDefaultGUIToolkitState()) as IGUIToolkitState;
	if (!isPlainObject(state) || state.model !== guiToolkitModel) {
		throw new Error(`GUI Toolkit state must use model "${guiToolkitModel}".`);
	}
	const panel = state.panelRenderer;
	if (!isPlainObject(panel) || (panel.renderMode !== "overlay" && panel.renderMode !== "worldSpace")) {
		throw new Error("GUI PanelRenderer settings are invalid.");
	}
	if (panel.targetMeshId !== null && (typeof panel.targetMeshId !== "string" || !panel.targetMeshId.trim() || panel.targetMeshId.length > 256)) {
		throw new Error("GUI PanelRenderer targetMeshId must be null or contain 1-256 characters.");
	}
	if (panel.renderMode === "worldSpace" && !panel.targetMeshId) {
		throw new Error("World-space PanelRenderer requires targetMeshId.");
	}
	if (panel.renderMode === "overlay") {
		panel.targetMeshId = null;
	}
	assertFinite(panel.textureWidth, 64, 8192, "GUI PanelRenderer textureWidth");
	assertFinite(panel.textureHeight, 64, 8192, "GUI PanelRenderer textureHeight");
	if (!Number.isInteger(panel.textureWidth) || !Number.isInteger(panel.textureHeight)) {
		throw new Error("GUI PanelRenderer texture dimensions must be integers.");
	}
	for (const key of ["supportPointerMove", "onlyAlphaTesting", "invertY", "foreground", "releaseRootOnDispose"] as const) {
		if (typeof panel[key] !== "boolean") {
			throw new Error(`GUI PanelRenderer ${key} must be boolean.`);
		}
	}
	const controls = new Map(compilation?.controls.map((control) => [control.id, control]) ?? []);
	if (!Array.isArray(state.references) || state.references.length > 1024) {
		throw new Error("GUI Toolkit supports at most 1,024 VisualElement references.");
	}
	const referenceIds = new Set<string>();
	state.references.forEach((reference, index) => {
		if (!isPlainObject(reference)) {
			throw new Error(`GUI VisualElement reference ${index} must be an object.`);
		}
		assertIdentifier(reference.id, `GUI VisualElement reference ${index} id`);
		assertIdentifier(reference.controlId, `GUI VisualElement reference ${index} controlId`);
		if (referenceIds.has(reference.id)) {
			throw new Error(`GUI VisualElement reference id "${reference.id}" is duplicated.`);
		}
		referenceIds.add(reference.id);
		if (reference.expectedTypeName !== null && (typeof reference.expectedTypeName !== "string" || !/^[A-Za-z_][\w-]{0,63}$/.test(reference.expectedTypeName))) {
			throw new Error(`GUI VisualElement reference "${reference.id}" expectedTypeName is invalid.`);
		}
		const control = controls.get(reference.controlId);
		if (compilation && !control) {
			throw new Error(`GUI VisualElement reference "${reference.id}" targets unknown control "${reference.controlId}".`);
		}
		if (control && reference.expectedTypeName && control.typeName !== reference.expectedTypeName) {
			throw new Error(`GUI VisualElement reference "${reference.id}" expects ${reference.expectedTypeName}, but the control is ${control.typeName}.`);
		}
	});
	if (!Array.isArray(state.attributeOverrides) || state.attributeOverrides.length > 2048) {
		throw new Error("GUI Toolkit supports at most 2,048 attribute overrides.");
	}
	const overrideKeys = new Set<string>();
	state.attributeOverrides.forEach((override, index) => {
		if (!isPlainObject(override)) {
			throw new Error(`GUI attribute override ${index} must be an object.`);
		}
		assertIdentifier(override.controlId, `GUI attribute override ${index} controlId`);
		if (!retainedProperties.has(override.property)) {
			throw new Error(`GUI attribute override ${index} property is unsupported.`);
		}
		if (!["string", "number", "boolean"].includes(typeof override.value) || (typeof override.value === "number" && !Number.isFinite(override.value))) {
			throw new Error(`GUI attribute override ${index} value must be a finite scalar.`);
		}
		const key = `${override.controlId}:${override.property}`;
		if (overrideKeys.has(key)) {
			throw new Error(`GUI attribute override "${key}" is duplicated.`);
		}
		overrideKeys.add(key);
		if (compilation && !controls.has(override.controlId)) {
			throw new Error(`GUI attribute override targets unknown control "${override.controlId}".`);
		}
	});
	if (!Array.isArray(state.animations) || state.animations.length > 1024) {
		throw new Error("GUI Toolkit supports at most 1,024 animation tracks.");
	}
	const animationIds = new Set<string>();
	state.animations.forEach((animation, index) => {
		if (!isPlainObject(animation)) {
			throw new Error(`GUI animation ${index} must be an object.`);
		}
		assertIdentifier(animation.id, `GUI animation ${index} id`);
		assertIdentifier(animation.controlId, `GUI animation ${index} controlId`);
		if (animationIds.has(animation.id)) {
			throw new Error(`GUI animation id "${animation.id}" is duplicated.`);
		}
		animationIds.add(animation.id);
		if (
			!(
				animation.property === "alpha" ||
				animation.property === "value" ||
				animation.property === "fontSize" ||
				animation.property === "left" ||
				animation.property === "top" ||
				animation.property === "width" ||
				animation.property === "height"
			)
		) {
			throw new Error(`GUI animation "${animation.id}" property is unsupported.`);
		}
		assertFinite(animation.from, -1000000, 1000000, `GUI animation "${animation.id}" from`);
		assertFinite(animation.to, -1000000, 1000000, `GUI animation "${animation.id}" to`);
		assertFinite(animation.durationMs, 1, 3600000, `GUI animation "${animation.id}" durationMs`);
		assertFinite(animation.delayMs, 0, 3600000, `GUI animation "${animation.id}" delayMs`);
		if (!(animation.easing === "linear" || animation.easing === "easeIn" || animation.easing === "easeOut" || animation.easing === "easeInOut")) {
			throw new Error(`GUI animation "${animation.id}" easing is unsupported.`);
		}
		if (typeof animation.loop !== "boolean" || typeof animation.autoplay !== "boolean") {
			throw new Error(`GUI animation "${animation.id}" loop/autoplay must be boolean.`);
		}
		if (compilation && !controls.has(animation.controlId)) {
			throw new Error(`GUI animation "${animation.id}" targets unknown control "${animation.controlId}".`);
		}
	});
	if (!isPlainObject(state.stylesheetStage)) {
		throw new Error("GUI stylesheet staging settings are required.");
	}
	assertIdentifier(state.stylesheetStage.contextId, "GUI stylesheet staging contextId");
	if (!Array.isArray(state.stylesheetStage.stylesheetOrder) || state.stylesheetStage.stylesheetOrder.length > 128) {
		throw new Error("GUI stylesheet staging order supports at most 128 paths.");
	}
	state.stylesheetStage.stylesheetOrder = state.stylesheetStage.stylesheetOrder.map((path, index) => normalizeProjectPath(path, ".uss", `GUI stylesheet order ${index}`));
	if (new Set(state.stylesheetStage.stylesheetOrder).size !== state.stylesheetStage.stylesheetOrder.length) {
		throw new Error("GUI stylesheet staging order contains duplicates.");
	}
	state.stylesheetStage.activeStylesheetPath =
		state.stylesheetStage.activeStylesheetPath === null ? null : normalizeProjectPath(state.stylesheetStage.activeStylesheetPath, ".uss", "GUI active stylesheet");
	if (state.stylesheetStage.activeStylesheetPath && !state.stylesheetStage.stylesheetOrder.includes(state.stylesheetStage.activeStylesheetPath)) {
		throw new Error("GUI active stylesheet must be present in the staging order.");
	}
	if (compilation) {
		const paths = compilation.sources.filter((source) => source.kind === "uss").map((source) => source.path);
		if (
			state.stylesheetStage.stylesheetOrder.length &&
			(paths.length !== state.stylesheetStage.stylesheetOrder.length || paths.some((path) => !state.stylesheetStage.stylesheetOrder.includes(path)))
		) {
			throw new Error("GUI stylesheet staging order must contain exactly the retained document's stylesheets.");
		}
	}
	return state;
}

export function easeGUIAnimation(progress: number, easing: GUIAnimationEasing): number {
	const t = Math.max(0, Math.min(1, progress));
	if (easing === "easeIn") {
		return t * t;
	}
	if (easing === "easeOut") {
		return 1 - (1 - t) * (1 - t);
	}
	if (easing === "easeInOut") {
		return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
	}
	return t;
}

export function sampleGUIAnimation(animation: IGUIAnimationTrack, elapsedMs: number): { active: boolean; completed: boolean; value: number } {
	const local = elapsedMs - animation.delayMs;
	if (local <= 0) {
		return { active: false, completed: false, value: animation.from };
	}
	const raw = local / animation.durationMs;
	const completed = !animation.loop && raw >= 1;
	const progress = animation.loop ? raw % 1 : Math.min(1, raw);
	const value = animation.from + (animation.to - animation.from) * easeGUIAnimation(progress, animation.easing);
	return { active: !completed, completed, value };
}

function encodeHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function collectUpgradeEdits(source: string): IGUIUXMLUpgradeEdit[] {
	const edits: IGUIUXMLUpgradeEdit[] = [];
	const add = (pattern: RegExp, rule: IGUIUXMLUpgradeEdit["rule"], replace: (match: RegExpExecArray) => string, message: string): void => {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(source))) {
			edits.push({ rule, start: match.index, end: match.index + match[0].length, before: match[0], after: replace(match), message });
			if (!match[0].length) {
				pattern.lastIndex++;
			}
		}
	};
	add(
		/xmlns:ui\s*=\s*(["'])UnityEngine\.Experimental\.UIElements\1/g,
		"legacy-namespace",
		(match) => `xmlns:ui=${match[1]}UnityEngine.UIElements${match[1]}`,
		"Replace the experimental UIElements namespace."
	);
	add(/\bclassName\s*=/g, "class-name", () => "class=", "Rename deprecated className to class.");
	add(
		/\bpicking-mode\s*=\s*(["'])(Ignore|Position)\1/g,
		"picking-mode",
		(match) => `pointer-events=${match[1]}${match[2] === "Ignore" ? "none" : "auto"}${match[1]}`,
		"Convert legacy picking-mode to pointer-events."
	);
	add(/\bfocus-index\s*=/g, "focus-index", () => "tabindex=", "Rename legacy focus-index to tabindex.");
	add(
		/\bvisible\s*=\s*(["'])(true|false)\1/g,
		"visible",
		(match) => `display=${match[1]}${match[2] === "true" ? "flex" : "none"}${match[1]}`,
		"Convert legacy visible to display."
	);
	return edits.sort((left, right) => left.start - right.start);
}

export async function planGUIUXMLUpgrades(path: string, source: string): Promise<IGUIUXMLUpgradePlan> {
	if (!path.toLowerCase().endsWith(".uxml") || path.length > 1024) {
		throw new Error("UXML upgrade path must be a bounded .uxml path.");
	}
	if (new TextEncoder().encode(source).byteLength > 1024 * 1024) {
		throw new Error("UXML upgrade source exceeds 1 MiB.");
	}
	const edits = collectUpgradeEdits(source);
	let upgradedSource = source;
	for (const edit of edits.slice().reverse()) {
		upgradedSource = `${upgradedSource.slice(0, edit.start)}${edit.after}${upgradedSource.slice(edit.end)}`;
	}
	return { model: "zvibe-uxml-upgrade-plan-v1", path, sourceRevision: await sha256(source), edits, upgradedSource };
}
