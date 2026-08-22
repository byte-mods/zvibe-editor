import { Observable } from "@babylonjs/core/Misc/observable";

import { ILoadedImportedFont, installImportedFontAsset, loadImportedFontAsset } from "./fonts";
import {
	IGUIAtlasTextAssignment,
	IGUIAtlasTextLayoutEvidence,
	IGUIAtlasTextRenderResult,
	guiAtlasTextRuntimeMetadataKey,
	normalizeGUIAtlasTextAssignment,
	renderGUIAtlasText,
} from "./gui-atlas-text";
import { scriptsDictionary } from "./script/apply";
import { GUIRetainedPseudoState, IGUIRetainedControlProperties, IGUIRetainedDocumentState, normalizeGUIRetainedDocumentState } from "./gui-retained-ui";
import { createDefaultGUIToolkitState, IGUIToolkitState, normalizeGUIToolkitState, sampleGUIAnimation } from "./gui-toolkit";
import { applyGUILocalizationBindings, IGUILocalizationBinding, IGUILocalizationEvidence, normalizeGUILocalizationBinding } from "./gui-localization";
import { LocalizationManager } from "./localization";
import {
	applyGUIAccessibilityRuntime,
	createDefaultGUIAccessibilityState,
	IGUIAccessibilityRuntimeEvidence,
	IGUIAccessibilityState,
	IGUISystemAccessibilityPreferences,
	normalizeGUIAccessibilityState,
	updateGUIAccessibilityDirection,
} from "./gui-accessibility";
import {
	applyGUIInteractionRuntime,
	createDefaultGUIUsageTrackingSettings,
	detachGUIInteractionRuntime,
	getGUIUsageTrackingEvidence,
	guiCanvasGroupMetadataKey,
	guiRaycastReceiverMetadataKey,
	IGUICanvasGroupAssignment,
	IGUIRaycastReceiverAssignment,
	IGUIUsageTrackingEvidence,
	IGUIUsageTrackingSettings,
	normalizeGUICanvasGroupAssignment,
	normalizeGUIRaycastReceiverAssignment,
	normalizeGUIUsageTrackingSettings,
} from "./gui-interaction";

export const guiAuthoringModel = "unity-ui-canvas-authoring-v1" as const;
export const guiControlIdentityMetadataKey = "zvibeGuiControlId" as const;
export const guiInternalControlMetadataKey = "zvibeGuiInternalControl" as const;

export type GUIJsonValue = null | boolean | number | string | GUIJsonValue[] | { [key: string]: GUIJsonValue };
export type GUICanvasScaleMode = "constantPixelSize" | "scaleWithScreenSize" | "constantPhysicalSize";
export type GUIScreenMatchMode = "matchWidthOrHeight" | "expand" | "shrink";
export type GUIEventName = "pointerClick" | "pointerDown" | "pointerUp" | "pointerEnter" | "pointerOut" | "valueChanged" | "textChanged" | "focus" | "blur" | "enterPressed";

export interface IGUISafeAreaSettings {
	enabled: boolean;
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface IGUICanvasSettings {
	referenceWidth: number;
	referenceHeight: number;
	scaleMode: GUICanvasScaleMode;
	screenMatchMode: GUIScreenMatchMode;
	matchWidthOrHeight: number;
	referencePixelsPerUnit: number;
	fallbackScreenDpi: number;
	defaultSpriteDpi: number;
	safeArea: IGUISafeAreaSettings;
}

export interface IGUIScriptMethodEventTarget {
	kind: "scriptMethod";
	targetNodeId: string;
	scriptKey: string;
	method: string;
	arguments: GUIJsonValue[];
	passEventData: boolean;
}

export interface IGUICustomEventTarget {
	kind: "customEvent";
	eventName: string;
	detail: GUIJsonValue;
}

export type GUIEventTarget = IGUIScriptMethodEventTarget | IGUICustomEventTarget;

export interface IGUIEventBinding {
	id: string;
	controlId: string;
	event: GUIEventName;
	enabled: boolean;
	target: GUIEventTarget;
}

export interface IGUIFontAssignment {
	controlId: string;
	assetPaths: string[];
	fontStyle: "normal" | "italic";
	fontWeight: string;
}

export interface IGUIAuthoringState {
	model: typeof guiAuthoringModel;
	revision: number;
	canvas: IGUICanvasSettings;
	bindings: IGUIEventBinding[];
	fonts: IGUIFontAssignment[];
	atlasTexts: IGUIAtlasTextAssignment[];
	localizations: IGUILocalizationBinding[];
	accessibility: IGUIAccessibilityState;
	canvasGroups: IGUICanvasGroupAssignment[];
	raycastReceivers: IGUIRaycastReceiverAssignment[];
	usageTracking: IGUIUsageTrackingSettings;
	retainedDocument: IGUIRetainedDocumentState | null;
	toolkit: IGUIToolkitState;
}

export interface IGUIControlDescription {
	id: string;
	parentId: string | null;
	name: string;
	type: string;
	path: string;
	childCount: number;
}

export interface IGUIEventInvocation {
	guiName: string;
	bindingId: string;
	controlId: string;
	event: GUIEventName;
	targetKind: GUIEventTarget["kind"];
	eventData: unknown;
}

export interface IApplyGUIAuthoringOptions {
	rootUrl: string;
	scene: IGUISceneLike;
	loadFontFamily?: (rootUrl: string, authoredPath: string) => Promise<string>;
	loadFontAsset?: (rootUrl: string, authoredPath: string) => Promise<ILoadedImportedFont>;
	renderAtlasText?: (assignment: IGUIAtlasTextAssignment, fonts: ILoadedImportedFont[]) => Promise<IGUIAtlasTextRenderResult>;
	onCustomEvent?: (event: IGUIEventInvocation & { eventName: string; detail: GUIJsonValue }) => void;
	localization?: LocalizationManager;
	accessibilityPreferences?: IGUISystemAccessibilityPreferences;
}

export interface IGUIRuntimeEvidence {
	model: typeof guiAuthoringModel;
	revision: number;
	controlCount: number;
	boundEventCount: number;
	fontAssignmentCount: number;
	loadedFontCount: number;
	atlasTextCount: number;
	atlasTextReadyCount: number;
	atlasFontCount: number;
	atlasTexts: Array<IGUIAtlasTextLayoutEvidence & { controlId: string }>;
	retainedDocumentReady: boolean;
	retainedControlCount: number;
	retainedPseudoBindingCount: number;
	retainedSourceFingerprint: string | null;
	localizationBindingCount: number;
	localizations: IGUILocalizationEvidence[];
	accessibility: IGUIAccessibilityRuntimeEvidence;
	canvasGroupCount: number;
	raycastReceiverCount: number;
	usageTracking: IGUIUsageTrackingEvidence;
	panelRenderer: IGUIToolkitState["panelRenderer"];
	visualElementReferenceCount: number;
	resolvedVisualElementReferenceCount: number;
	attributeOverrideCount: number;
	animationCount: number;
	autoplayAnimationCount: number;
	canvasScale: number;
	missingControlIds: string[];
}

export interface IInvokeGUIEventBindingOptions {
	gui: IGUIAdvancedDynamicTextureLike;
	scene: IGUISceneLike;
	binding: IGUIEventBinding;
	eventData: unknown;
	onCustomEvent?: IApplyGUIAuthoringOptions["onCustomEvent"];
}

export interface IGUIControlLike {
	name?: string;
	metadata: unknown;
	children?: IGUIControlLike[];
	getClassName?: () => string;
	fontFamily: string;
	fontStyle: string;
	fontWeight: string;
	text?: string;
	source?: string;
	textHorizontalAlignment?: number;
	fontSize?: number | string;
	isEnabled?: boolean;
	isVisible?: boolean;
	alpha: number;
	isHitTestVisible: boolean;
	isPointerBlocker?: boolean;
	value?: number;
	minimum?: number;
	maximum?: number;
	step?: number;
	onPointerClickObservable?: { notifyObservers(value: unknown): void };
	onValueChangedObservable?: { notifyObservers(value: unknown): void };
	onFocusObservable?: { notifyObservers(value: unknown): void };
	onBlurObservable?: { notifyObservers(value: unknown): void };
}

export interface IGUIContainerLike extends IGUIControlLike {
	children: IGUIControlLike[];
	paddingLeft: string | number;
	paddingTop: string | number;
	paddingRight: string | number;
	paddingBottom: string | number;
}

export interface IGUIAdvancedDynamicTextureLike {
	name: string;
	metadata: unknown;
	rootContainer: IGUIContainerLike;
	idealWidth: number;
	idealHeight: number;
}

export interface IGUIEngineLike {
	getRenderWidth: () => number;
	getRenderHeight: () => number;
	getDeltaTime?: () => number;
	onResizeObservable: { add: (callback: () => void) => { remove: () => void } };
}

export interface IGUISceneLike {
	getEngine: () => IGUIEngineLike;
	getNodeById: (id: string) => object | null;
	getNodeByName: (name: string) => object | null;
	onBeforeRenderObservable?: { add: (callback: () => void) => { remove: () => void } };
	localization?: LocalizationManager;
}

interface IGUIRuntimeRegistration {
	observers: Array<{ remove: () => void }>;
	canvasScale: number;
	atlasTexts: Array<IGUIAtlasTextLayoutEvidence & { controlId: string }>;
	cleanup: Array<() => void>;
}

const runtimeRegistrations = new WeakMap<IGUIAdvancedDynamicTextureLike, IGUIRuntimeRegistration>();

export const onGUIEventObservable = new Observable<IGUIEventInvocation>();

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertFiniteRange(value: number, minimum: number, maximum: number, label: string): void {
	if (!Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
	}
}

function assertIdentifier(value: string, label: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${label} must contain 1-128 letters, digits, dots, underscores, colons, or hyphens.`);
	}
}

function assertAssetPath(value: string): void {
	if (!value || value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === "")) {
		throw new Error(`GUI font asset path "${value}" must be a normalized project-relative path without traversal.`);
	}
}

function assertJsonValue(value: unknown, depth = 0): void {
	if (depth > 12) {
		throw new Error("GUI event arguments are limited to 12 nested JSON levels.");
	}
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("GUI event arguments cannot contain non-finite numbers.");
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) {
			throw new Error("A GUI event JSON array is limited to 64 values.");
		}
		value.forEach((entry) => assertJsonValue(entry, depth + 1));
		return;
	}
	if (isPlainObject(value)) {
		const entries = Object.entries(value);
		if (entries.length > 64) {
			throw new Error("A GUI event JSON object is limited to 64 fields.");
		}
		entries.forEach(([key, entry]) => {
			if (!key || key.length > 128) {
				throw new Error("GUI event JSON field names must contain 1-128 characters.");
			}
			assertJsonValue(entry, depth + 1);
		});
		return;
	}
	throw new Error("GUI event arguments must contain JSON values only.");
}

/** Creates the canonical Unity-style UI canvas authoring state used by editor and runtime. */
export function createDefaultGUIAuthoringState(): IGUIAuthoringState {
	return {
		model: guiAuthoringModel,
		revision: 0,
		canvas: {
			referenceWidth: 1920,
			referenceHeight: 1080,
			scaleMode: "scaleWithScreenSize",
			screenMatchMode: "matchWidthOrHeight",
			matchWidthOrHeight: 0.5,
			referencePixelsPerUnit: 100,
			fallbackScreenDpi: 96,
			defaultSpriteDpi: 96,
			safeArea: { enabled: false, left: 0, top: 0, right: 0, bottom: 0 },
		},
		bindings: [],
		fonts: [],
		atlasTexts: [],
		localizations: [],
		accessibility: createDefaultGUIAccessibilityState(),
		canvasGroups: [],
		raycastReceivers: [],
		usageTracking: createDefaultGUIUsageTrackingSettings(),
		retainedDocument: null,
		toolkit: createDefaultGUIToolkitState(),
	};
}

/** Validates and clones a complete GUI authoring state before atomic publication. */
export function normalizeGUIAuthoringState(value: unknown, controlIds?: ReadonlySet<string>): IGUIAuthoringState {
	if (!isPlainObject(value)) {
		throw new Error("GUI authoring state must be an object.");
	}
	const state = clone(value) as unknown as IGUIAuthoringState;
	if (state.model !== guiAuthoringModel) {
		throw new Error(`GUI authoring model must be "${guiAuthoringModel}".`);
	}
	if (!Number.isInteger(state.revision) || state.revision < 0) {
		throw new Error("GUI authoring revision must be a non-negative integer.");
	}
	if (!isPlainObject(state.canvas)) {
		throw new Error("GUI canvas settings are required.");
	}
	assertFiniteRange(state.canvas.referenceWidth, 1, 16384, "GUI reference width");
	assertFiniteRange(state.canvas.referenceHeight, 1, 16384, "GUI reference height");
	if (!(["constantPixelSize", "scaleWithScreenSize", "constantPhysicalSize"] as unknown[]).includes(state.canvas.scaleMode)) {
		throw new Error("Unknown GUI canvas scale mode.");
	}
	if (!(["matchWidthOrHeight", "expand", "shrink"] as unknown[]).includes(state.canvas.screenMatchMode)) {
		throw new Error("Unknown GUI screen match mode.");
	}
	assertFiniteRange(state.canvas.matchWidthOrHeight, 0, 1, "GUI width/height match");
	assertFiniteRange(state.canvas.referencePixelsPerUnit, 1, 1000, "GUI reference pixels per unit");
	assertFiniteRange(state.canvas.fallbackScreenDpi, 1, 1000, "GUI fallback screen DPI");
	assertFiniteRange(state.canvas.defaultSpriteDpi, 1, 1000, "GUI default sprite DPI");
	if (!isPlainObject(state.canvas.safeArea) || typeof state.canvas.safeArea.enabled !== "boolean") {
		throw new Error("GUI safe-area settings are required.");
	}
	for (const edge of ["left", "top", "right", "bottom"] as const) {
		assertFiniteRange(state.canvas.safeArea[edge], 0, 0.99, `GUI safe-area ${edge}`);
	}
	if (state.canvas.safeArea.left + state.canvas.safeArea.right >= 1 || state.canvas.safeArea.top + state.canvas.safeArea.bottom >= 1) {
		throw new Error("GUI safe-area opposing insets must leave a positive canvas area.");
	}
	if (!Array.isArray(state.bindings) || state.bindings.length > 4096) {
		throw new Error("GUI authoring supports at most 4,096 event bindings.");
	}
	if (!Array.isArray(state.fonts) || state.fonts.length > 2048) {
		throw new Error("GUI authoring supports at most 2,048 font assignments.");
	}
	state.atlasTexts ??= [];
	if (!Array.isArray(state.atlasTexts) || state.atlasTexts.length > 2048) {
		throw new Error("GUI authoring supports at most 2,048 atlas text assignments.");
	}
	state.retainedDocument ??= null;
	state.toolkit = normalizeGUIToolkitState(state.toolkit ?? createDefaultGUIToolkitState(), state.retainedDocument?.compiled ?? null);
	state.localizations ??= [];
	if (!Array.isArray(state.localizations) || state.localizations.length > 2048) {
		throw new Error("GUI authoring supports at most 2,048 localization bindings.");
	}
	state.accessibility = normalizeGUIAccessibilityState(state.accessibility ?? createDefaultGUIAccessibilityState(), controlIds);
	state.canvasGroups ??= [];
	if (!Array.isArray(state.canvasGroups) || state.canvasGroups.length > 2048) {
		throw new Error("GUI authoring supports at most 2,048 CanvasGroup assignments.");
	}
	state.canvasGroups = state.canvasGroups.map((assignment) => normalizeGUICanvasGroupAssignment(assignment, controlIds));
	if (new Set(state.canvasGroups.map((assignment) => assignment.controlId)).size !== state.canvasGroups.length) {
		throw new Error("A GUI control can have at most one CanvasGroup assignment.");
	}
	state.raycastReceivers ??= [];
	if (!Array.isArray(state.raycastReceivers) || state.raycastReceivers.length > 2048) {
		throw new Error("GUI authoring supports at most 2,048 RaycastReceiver assignments.");
	}
	state.raycastReceivers = state.raycastReceivers.map((assignment) => normalizeGUIRaycastReceiverAssignment(assignment, controlIds));
	if (new Set(state.raycastReceivers.map((assignment) => assignment.controlId)).size !== state.raycastReceivers.length) {
		throw new Error("A GUI control can have at most one RaycastReceiver assignment.");
	}
	state.usageTracking = normalizeGUIUsageTrackingSettings(state.usageTracking ?? createDefaultGUIUsageTrackingSettings());

	const bindingIds = new Set<string>();
	state.bindings.forEach((binding, index) => {
		if (!isPlainObject(binding)) {
			throw new Error(`GUI binding ${index} must be an object.`);
		}
		assertIdentifier(binding.id, `GUI binding ${index} id`);
		assertIdentifier(binding.controlId, `GUI binding ${index} controlId`);
		if (bindingIds.has(binding.id)) {
			throw new Error(`GUI binding id "${binding.id}" is duplicated.`);
		}
		bindingIds.add(binding.id);
		if (controlIds && !controlIds.has(binding.controlId)) {
			throw new Error(`GUI binding "${binding.id}" references unknown control "${binding.controlId}".`);
		}
		if (
			!(["pointerClick", "pointerDown", "pointerUp", "pointerEnter", "pointerOut", "valueChanged", "textChanged", "focus", "blur", "enterPressed"] as unknown[]).includes(
				binding.event
			)
		) {
			throw new Error(`GUI binding "${binding.id}" has an unsupported event.`);
		}
		if (typeof binding.enabled !== "boolean" || !isPlainObject(binding.target)) {
			throw new Error(`GUI binding "${binding.id}" must define enabled and target.`);
		}
		if (binding.target.kind === "scriptMethod") {
			if (!binding.target.targetNodeId || binding.target.targetNodeId.length > 256) {
				throw new Error(`GUI binding "${binding.id}" targetNodeId must contain 1-256 characters.`);
			}
			if (!binding.target.scriptKey || binding.target.scriptKey.length > 512) {
				throw new Error(`GUI binding "${binding.id}" scriptKey must contain 1-512 characters.`);
			}
			if (!/^[A-Za-z_$][\w$]{0,127}$/.test(binding.target.method)) {
				throw new Error(`GUI binding "${binding.id}" method must be a JavaScript identifier.`);
			}
			if (!Array.isArray(binding.target.arguments) || binding.target.arguments.length > 16) {
				throw new Error(`GUI binding "${binding.id}" supports at most 16 static arguments.`);
			}
			binding.target.arguments.forEach((argument) => assertJsonValue(argument));
			if (typeof binding.target.passEventData !== "boolean") {
				throw new Error(`GUI binding "${binding.id}" passEventData must be boolean.`);
			}
		} else if (binding.target.kind === "customEvent") {
			assertIdentifier(binding.target.eventName, `GUI binding ${binding.id} custom event name`);
			assertJsonValue(binding.target.detail);
		} else {
			throw new Error(`GUI binding "${binding.id}" has an unsupported target kind.`);
		}
	});

	const fontControlIds = new Set<string>();
	state.fonts.forEach((font, index) => {
		if (!isPlainObject(font)) {
			throw new Error(`GUI font assignment ${index} must be an object.`);
		}
		assertIdentifier(font.controlId, `GUI font assignment ${index} controlId`);
		if (fontControlIds.has(font.controlId)) {
			throw new Error(`GUI control "${font.controlId}" has more than one font assignment.`);
		}
		fontControlIds.add(font.controlId);
		if (controlIds && !controlIds.has(font.controlId)) {
			throw new Error(`GUI font assignment references unknown control "${font.controlId}".`);
		}
		if (!Array.isArray(font.assetPaths) || !font.assetPaths.length || font.assetPaths.length > 8) {
			throw new Error("A GUI font fallback chain must contain 1-8 project font assets.");
		}
		font.assetPaths.forEach(assertAssetPath);
		if (!(["normal", "italic"] as unknown[]).includes(font.fontStyle)) {
			throw new Error("GUI font style must be normal or italic.");
		}
		if (!/^(normal|bold|[1-9]00)$/.test(font.fontWeight)) {
			throw new Error("GUI font weight must be normal, bold, or a 100-900 numeric weight.");
		}
	});
	const atlasTextControlIds = new Set<string>();
	state.atlasTexts = state.atlasTexts.map((value) => normalizeGUIAtlasTextAssignment(value));
	state.atlasTexts.forEach((assignment) => {
		if (atlasTextControlIds.has(assignment.controlId)) {
			throw new Error(`GUI control "${assignment.controlId}" has more than one atlas text assignment.`);
		}
		atlasTextControlIds.add(assignment.controlId);
		if (controlIds && !controlIds.has(assignment.controlId)) {
			throw new Error(`GUI atlas text assignment references unknown control "${assignment.controlId}".`);
		}
	});
	state.localizations = state.localizations.map((value) => normalizeGUILocalizationBinding(value, controlIds));
	const localizedProperties = new Set<string>();
	state.localizations.forEach((binding) => {
		const key = `${binding.controlId}:${binding.property}`;
		if (localizedProperties.has(key)) {
			throw new Error(`GUI control "${binding.controlId}" has more than one ${binding.property} localization binding.`);
		}
		localizedProperties.add(key);
		if (binding.property === "source" && atlasTextControlIds.has(binding.controlId)) {
			throw new Error(`GUI control "${binding.controlId}" cannot use localized source and atlas text together.`);
		}
	});
	if (state.retainedDocument !== null) {
		state.retainedDocument = normalizeGUIRetainedDocumentState(state.retainedDocument, controlIds);
	}
	return state;
}

function controlMetadata(control: IGUIControlLike): Record<string, unknown> {
	if (!isPlainObject(control.metadata)) {
		control.metadata = {};
	}
	return control.metadata as Record<string, unknown>;
}

function controlChildren(control: IGUIControlLike): IGUIControlLike[] {
	return Array.isArray(control.children) ? control.children.filter((child) => !(isPlainObject(child.metadata) && child.metadata[guiInternalControlMetadataKey] === true)) : [];
}

/** Assigns persistent identities to every control lacking one and returns the complete hierarchy. */
export function describeGUIControls(gui: IGUIAdvancedDynamicTextureLike): IGUIControlDescription[] {
	const controls: IGUIControlDescription[] = [];
	const usedIds = new Set<string>();
	const allControls: IGUIControlLike[] = [];
	const collect = (control: IGUIControlLike): void => {
		allControls.push(control);
		controlChildren(control).forEach(collect);
	};
	gui.rootContainer.children.forEach(collect);
	allControls.forEach((control) => {
		const id = controlMetadata(control)[guiControlIdentityMetadataKey];
		if (typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id) && !usedIds.has(id)) {
			usedIds.add(id);
		} else {
			delete controlMetadata(control)[guiControlIdentityMetadataKey];
		}
	});
	let nextId = 1;
	const ensureId = (control: IGUIControlLike): string => {
		const metadata = controlMetadata(control);
		if (typeof metadata[guiControlIdentityMetadataKey] === "string") {
			return metadata[guiControlIdentityMetadataKey] as string;
		}
		while (usedIds.has(`control-${nextId}`)) {
			nextId++;
		}
		const id = `control-${nextId++}`;
		metadata[guiControlIdentityMetadataKey] = id;
		usedIds.add(id);
		return id;
	};
	const visit = (control: IGUIControlLike, parentId: string | null, parentPath: string, index: number): void => {
		const id = ensureId(control);
		const metadata = controlMetadata(control);
		const type =
			metadata[guiCanvasGroupMetadataKey] === true
				? "CanvasGroup"
				: metadata[guiRaycastReceiverMetadataKey] === true
					? "RaycastReceiver"
					: (control.getClassName?.() ?? "Control");
		const name = typeof control.name === "string" && control.name.trim() ? control.name.trim() : `${type} ${index + 1}`;
		const path = parentPath ? `${parentPath} / ${name}` : name;
		const children = controlChildren(control);
		controls.push({ id, parentId, name, type, path, childCount: children.length });
		children.forEach((child, childIndex) => visit(child, id, path, childIndex));
	};
	gui.rootContainer.children.forEach((control, index) => visit(control, null, "", index));
	return controls;
}

/** Returns the validated state attached to a GUI, creating default metadata when absent. */
export function getGUIAuthoringState(gui: IGUIAdvancedDynamicTextureLike): IGUIAuthoringState {
	const controls = describeGUIControls(gui);
	const metadata = isPlainObject(gui.metadata) ? gui.metadata : {};
	gui.metadata = metadata;
	const raw = metadata.zvibeGUIAuthoring ?? createDefaultGUIAuthoringState();
	const state = normalizeGUIAuthoringState(raw, new Set(controls.map((control) => control.id)));
	metadata.zvibeGUIAuthoring = clone(state);
	return clone(state);
}

/** Atomically replaces GUI authoring metadata under an exact revision lease. */
export function setGUIAuthoringState(gui: IGUIAdvancedDynamicTextureLike, expectedRevision: number, nextState: IGUIAuthoringState): IGUIAuthoringState {
	const current = getGUIAuthoringState(gui);
	if (current.revision !== expectedRevision) {
		throw new Error(`GUI authoring revision changed. Inspect again and use expectedRevision ${current.revision}.`);
	}
	const controls = describeGUIControls(gui);
	const normalized = normalizeGUIAuthoringState({ ...nextState, revision: current.revision + 1 }, new Set(controls.map((control) => control.id)));
	const metadata = isPlainObject(gui.metadata) ? gui.metadata : {};
	gui.metadata = metadata;
	metadata.zvibeGUIAuthoring = clone(normalized);
	return clone(normalized);
}

export function findGUIControlById(gui: IGUIAdvancedDynamicTextureLike, controlId: string): IGUIControlLike | null {
	describeGUIControls(gui);
	let match: IGUIControlLike | null = null;
	const visit = (control: IGUIControlLike): void => {
		if (match) {
			return;
		}
		if (controlMetadata(control)[guiControlIdentityMetadataKey] === controlId) {
			match = control;
		} else {
			controlChildren(control).forEach(visit);
		}
	};
	gui.rootContainer.children.forEach(visit);
	return match;
}

function calculateCanvasScale(gui: IGUIAdvancedDynamicTextureLike, canvas: IGUICanvasSettings, scene: IGUISceneLike): number {
	const engine = scene.getEngine();
	const width = Math.max(1, engine.getRenderWidth());
	const height = Math.max(1, engine.getRenderHeight());
	let scale = 1;
	if (canvas.scaleMode === "scaleWithScreenSize") {
		const widthScale = width / canvas.referenceWidth;
		const heightScale = height / canvas.referenceHeight;
		if (canvas.screenMatchMode === "expand") {
			scale = Math.min(widthScale, heightScale);
		} else if (canvas.screenMatchMode === "shrink") {
			scale = Math.max(widthScale, heightScale);
		} else {
			scale = Math.pow(widthScale, 1 - canvas.matchWidthOrHeight) * Math.pow(heightScale, canvas.matchWidthOrHeight);
		}
	} else if (canvas.scaleMode === "constantPhysicalSize") {
		const ratio = typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : canvas.fallbackScreenDpi / 96;
		scale = (96 * ratio) / canvas.defaultSpriteDpi;
	}
	scale = Math.max(0.01, Math.min(100, scale));
	if (canvas.scaleMode === "constantPixelSize") {
		gui.idealWidth = 0;
		gui.idealHeight = 0;
	} else {
		gui.idealWidth = width / scale;
		gui.idealHeight = 0;
	}
	const safeArea = canvas.safeArea;
	gui.rootContainer.paddingLeft = safeArea.enabled ? `${(width * safeArea.left) / scale}px` : "0px";
	gui.rootContainer.paddingTop = safeArea.enabled ? `${(height * safeArea.top) / scale}px` : "0px";
	gui.rootContainer.paddingRight = safeArea.enabled ? `${(width * safeArea.right) / scale}px` : "0px";
	gui.rootContainer.paddingBottom = safeArea.enabled ? `${(height * safeArea.bottom) / scale}px` : "0px";
	return scale;
}

function observableForEvent(control: IGUIControlLike, event: GUIEventName): { add: (callback: (value: unknown) => void) => { remove: () => void } } | null {
	const record = control as unknown as Record<string, unknown>;
	const property =
		event === "pointerClick"
			? "onPointerClickObservable"
			: event === "pointerDown"
				? "onPointerDownObservable"
				: event === "pointerUp"
					? "onPointerUpObservable"
					: event === "pointerEnter"
						? "onPointerEnterObservable"
						: event === "pointerOut"
							? "onPointerOutObservable"
							: event === "valueChanged"
								? "onValueChangedObservable"
								: event === "textChanged"
									? "onTextChangedObservable"
									: event === "focus"
										? "onFocusObservable"
										: event === "blur"
											? "onBlurObservable"
											: "onEnterPressedObservable";
	const observable = record[property];
	return isPlainObject(observable) && typeof observable.add === "function"
		? (observable as unknown as { add: (callback: (value: unknown) => void) => { remove: () => void } })
		: null;
}

function observableForProperty(control: IGUIControlLike, property: string): { add: (callback: (value: unknown) => void) => { remove: () => void } } | null {
	const observable = (control as unknown as Record<string, unknown>)[property];
	return isPlainObject(observable) && typeof observable.add === "function"
		? (observable as unknown as { add: (callback: (value: unknown) => void) => { remove: () => void } })
		: null;
}

function applyRetainedRuntimeProperties(control: IGUIControlLike, properties: IGUIRetainedControlProperties): void {
	const target = control as unknown as Record<string, unknown>;
	const metadata = isPlainObject(control.metadata) ? control.metadata : {};
	for (const [property, value] of Object.entries(properties)) {
		if (metadata[guiCanvasGroupMetadataKey] === true && ["alpha", "interactable", "blocksRaycasts", "ignoreParentGroups"].includes(property)) {
			continue;
		}
		if (property === "horizontalAlignment" || property === "verticalAlignment" || !(property in target)) {
			continue;
		}
		target[property] = value;
	}
}

function installRetainedPseudoStates(
	control: IGUIControlLike,
	definition: NonNullable<IGUIRetainedDocumentState>["compiled"]["controls"][number],
	registration: IGUIRuntimeRegistration,
	finalOverrides: IGUIRetainedControlProperties = {}
): number {
	if (!definition.pseudoCascade.length) {
		applyRetainedRuntimeProperties(control, finalOverrides);
		return 0;
	}
	const active = new Set<GUIRetainedPseudoState>();
	const dynamic = control as unknown as Record<string, unknown>;
	if (dynamic.isEnabled === false) {
		active.add("disabled");
	}
	if (dynamic.isChecked === true) {
		active.add("checked");
	}
	const render = (): void => {
		applyRetainedRuntimeProperties(control, definition.properties);
		for (const rule of definition.pseudoCascade) {
			if (active.has(rule.state)) {
				applyRetainedRuntimeProperties(control, rule.properties);
			}
		}
		applyRetainedRuntimeProperties(control, finalOverrides);
	};
	const bind = (observable: string, state: GUIRetainedPseudoState, enabled: boolean): void => {
		const source = observableForProperty(control, observable);
		if (!source) {
			return;
		}
		registration.observers.push(
			source.add(() => {
				if (enabled) {
					active.add(state);
				} else {
					active.delete(state);
				}
				if (dynamic.isEnabled === false) {
					active.add("disabled");
				} else {
					active.delete("disabled");
				}
				render();
			})
		);
	};
	bind("onPointerEnterObservable", "hover", true);
	bind("onPointerOutObservable", "hover", false);
	bind("onPointerDownObservable", "active", true);
	bind("onPointerUpObservable", "active", false);
	bind("onFocusObservable", "focus", true);
	bind("onBlurObservable", "focus", false);
	const checked = observableForProperty(control, "onIsCheckedChangedObservable");
	if (checked) {
		registration.observers.push(
			checked.add((value) => {
				if (value === true) {
					active.add("checked");
				} else {
					active.delete("checked");
				}
				render();
			})
		);
	}
	render();
	return definition.pseudoCascade.length;
}

/** Invokes one validated binding against the runtime script registry or the shared custom-event observable. */
export function invokeGUIEventBinding(options: IInvokeGUIEventBindingOptions): unknown {
	const { gui, scene, binding, eventData, onCustomEvent } = options;
	const invocation: IGUIEventInvocation = {
		guiName: gui.name,
		bindingId: binding.id,
		controlId: binding.controlId,
		event: binding.event,
		targetKind: binding.target.kind,
		eventData,
	};
	onGUIEventObservable.notifyObservers(invocation);
	if (binding.target.kind === "customEvent") {
		onCustomEvent?.({ ...invocation, eventName: binding.target.eventName, detail: clone(binding.target.detail) });
		return { emitted: true, eventName: binding.target.eventName };
	}
	const targetDefinition = binding.target;
	const target = targetDefinition.targetNodeId === "scene" ? scene : (scene.getNodeById(targetDefinition.targetNodeId) ?? scene.getNodeByName(targetDefinition.targetNodeId));
	if (!target) {
		throw new Error(`GUI binding "${binding.id}" target node "${targetDefinition.targetNodeId}" was not found at runtime.`);
	}
	const scriptRegistry = scriptsDictionary as unknown as Map<object, Array<{ key: string; instance: object }>>;
	const script = scriptRegistry.get(target)?.find((candidate) => candidate.key === targetDefinition.scriptKey);
	if (!script) {
		throw new Error(`GUI binding "${binding.id}" script "${targetDefinition.scriptKey}" is not running on target "${targetDefinition.targetNodeId}".`);
	}
	const method = (script.instance as unknown as Record<string, unknown>)[targetDefinition.method];
	if (typeof method !== "function") {
		throw new Error(`GUI binding "${binding.id}" method "${targetDefinition.method}" is not callable on script "${targetDefinition.scriptKey}".`);
	}
	const args: unknown[] = clone(targetDefinition.arguments);
	if (targetDefinition.passEventData) {
		args.push(eventData);
	}
	return method.apply(script.instance, args);
}

/** Removes canvas, font, and event observers previously installed by this module. */
export function detachGUIAuthoringRuntime(gui: IGUIAdvancedDynamicTextureLike): void {
	detachGUIInteractionRuntime(gui);
	const registration = runtimeRegistrations.get(gui);
	registration?.observers.forEach((observer) => observer.remove());
	registration?.cleanup.forEach((cleanup) => cleanup());
	runtimeRegistrations.delete(gui);
}

/** Returns the last successfully rendered atlas-text evidence for one live GUI. */
export function getGUIAtlasTextRuntimeEvidence(gui: IGUIAdvancedDynamicTextureLike): Array<IGUIAtlasTextLayoutEvidence & { controlId: string }> {
	return clone(runtimeRegistrations.get(gui)?.atlasTexts ?? []);
}

/** Applies persisted canvas scaling, font fallbacks, and event bindings to one live GUI. */
export async function applyGUIAuthoringRuntime(gui: IGUIAdvancedDynamicTextureLike, authoredState: unknown, options: IApplyGUIAuthoringOptions): Promise<IGUIRuntimeEvidence> {
	detachGUIAuthoringRuntime(gui);
	const controls = describeGUIControls(gui);
	const controlsById = new Map(controls.map((description) => [description.id, findGUIControlById(gui, description.id)!]));
	const state = normalizeGUIAuthoringState(authoredState, new Set(controlsById.keys()));
	const activeAtlasControlIds = new Set(state.atlasTexts.map((assignment) => assignment.controlId));
	for (const [controlId, control] of controlsById) {
		const controlMetadata = isPlainObject(control.metadata) ? control.metadata : null;
		if (!controlMetadata || !(guiAtlasTextRuntimeMetadataKey in controlMetadata) || activeAtlasControlIds.has(controlId)) {
			continue;
		}
		delete controlMetadata[guiAtlasTextRuntimeMetadataKey];
		const imageControl = control as unknown as { domImage?: unknown };
		if ("domImage" in imageControl && typeof document !== "undefined") {
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			imageControl.domImage = canvas;
		}
	}
	const metadata = isPlainObject(gui.metadata) ? gui.metadata : {};
	gui.metadata = metadata;
	metadata.zvibeGUIAuthoring = clone(state);
	const registration: IGUIRuntimeRegistration = { observers: [], canvasScale: calculateCanvasScale(gui, state.canvas, options.scene), atlasTexts: [], cleanup: [] };
	const resizeObserver = options.scene.getEngine().onResizeObservable.add(() => {
		registration.canvasScale = calculateCanvasScale(gui, state.canvas, options.scene);
	});
	registration.observers.push(resizeObserver);
	const localization = options.localization ?? options.scene.localization;
	if (state.localizations.length && !localization) {
		throw new Error("GUI localization bindings require a configured scene LocalizationManager.");
	}
	const localizations = localization
		? await applyGUILocalizationBindings({
				bindings: state.localizations,
				controls: controlsById,
				localization,
				rootUrl: options.rootUrl,
				onObserver: (observer) => registration.observers.push(observer),
				onCleanup: (cleanup) => registration.cleanup.push(cleanup),
			})
		: [];
	const accessibility = applyGUIAccessibilityRuntime({
		gui,
		guiName: gui.name,
		state: state.accessibility,
		descriptions: controls,
		controls: controlsById,
		direction: localization?.direction ?? "ltr",
		platformPreferences: options.accessibilityPreferences,
		onCleanup: (cleanup) => registration.cleanup.push(cleanup),
	});
	if (localization) {
		registration.observers.push(localization.onLocaleChangedObservable.add(() => updateGUIAccessibilityDirection(gui, localization.direction)));
	}
	let retainedPseudoBindingCount = 0;
	if (state.retainedDocument) {
		const definitions = new Map(state.retainedDocument.compiled.controls.map((control) => [control.id, control]));
		for (const [controlId, control] of controlsById) {
			const definition = definitions.get(controlId);
			if (definition) {
				const overrides = Object.fromEntries(
					state.toolkit.attributeOverrides.filter((override) => override.controlId === controlId).map((override) => [override.property, override.value])
				);
				retainedPseudoBindingCount += installRetainedPseudoStates(control, definition, registration, overrides);
			}
		}
	}
	let animationElapsedMs = 0;
	const autoplayAnimations = state.toolkit.animations.filter((animation) => animation.autoplay);
	if (autoplayAnimations.length && options.scene.onBeforeRenderObservable) {
		registration.observers.push(
			options.scene.onBeforeRenderObservable.add(() => {
				animationElapsedMs += Math.max(0, Math.min(1000, options.scene.getEngine().getDeltaTime?.() ?? 16.6667));
				for (const animation of autoplayAnimations) {
					const control = controlsById.get(animation.controlId);
					if (!control) {
						continue;
					}
					const sample = sampleGUIAnimation(animation, animationElapsedMs);
					const value = ["left", "top", "width", "height"].includes(animation.property) ? `${sample.value}px` : sample.value;
					(control as unknown as Record<string, unknown>)[animation.property] = value;
				}
			})
		);
	}
	applyGUIInteractionRuntime(gui, controls, controlsById, state.canvasGroups, state.raycastReceivers, state.usageTracking);

	let loadedFontCount = 0;
	const loadFontFamily = options.loadFontFamily ?? installImportedFontAsset;
	const loadedFamilies = new Map<string, Promise<string>>();
	const familyFor = (path: string): Promise<string> => {
		let promise = loadedFamilies.get(path);
		if (!promise) {
			promise = loadFontFamily(options.rootUrl, path);
			loadedFamilies.set(path, promise);
			loadedFontCount++;
		}
		return promise;
	};
	for (const assignment of state.fonts) {
		const control = controlsById.get(assignment.controlId);
		if (!control) {
			continue;
		}
		const families: string[] = [];
		for (const path of assignment.assetPaths) {
			families.push(await familyFor(path));
		}
		control.fontFamily = families.map((family) => JSON.stringify(family)).join(", ");
		control.fontStyle = assignment.fontStyle;
		control.fontWeight = assignment.fontWeight;
	}

	const loadFontAsset = options.loadFontAsset ?? loadImportedFontAsset;
	const renderAtlasText = options.renderAtlasText ?? renderGUIAtlasText;
	const loadedAtlasFonts = new Map<string, Promise<ILoadedImportedFont>>();
	const assetFor = (path: string): Promise<ILoadedImportedFont> => {
		let promise = loadedAtlasFonts.get(path);
		if (!promise) {
			promise = loadFontAsset(options.rootUrl, path);
			loadedAtlasFonts.set(path, promise);
		}
		return promise;
	};
	for (const assignment of state.atlasTexts) {
		const control = controlsById.get(assignment.controlId);
		if (!control) {
			continue;
		}
		const imageControl = control as unknown as { domImage?: unknown; stretch?: number; metadata: unknown };
		if (!("domImage" in imageControl)) {
			throw new Error(`GUI atlas text control "${assignment.controlId}" must be a Babylon Image control.`);
		}
		const fonts: ILoadedImportedFont[] = [];
		for (const path of assignment.fontAssetPaths) {
			await familyFor(path);
			fonts.push(await assetFor(path));
		}
		const rendered = await renderAtlasText(assignment, fonts);
		imageControl.domImage = rendered.canvas;
		imageControl.stretch = 1;
		const controlMetadata = isPlainObject(imageControl.metadata) ? imageControl.metadata : {};
		imageControl.metadata = controlMetadata;
		controlMetadata[guiAtlasTextRuntimeMetadataKey] = clone(rendered.layout.evidence);
		registration.atlasTexts.push({ controlId: assignment.controlId, ...clone(rendered.layout.evidence) });
	}

	let boundEventCount = 0;
	const missingControlIds: string[] = [];
	for (const binding of state.bindings) {
		if (!binding.enabled) {
			continue;
		}
		const control = controlsById.get(binding.controlId);
		if (!control) {
			missingControlIds.push(binding.controlId);
			continue;
		}
		const observable = observableForEvent(control, binding.event);
		if (!observable) {
			throw new Error(`GUI control "${binding.controlId}" does not expose the "${binding.event}" event required by binding "${binding.id}".`);
		}
		registration.observers.push(
			observable.add((eventData) => {
				try {
					invokeGUIEventBinding({ gui, scene: options.scene, binding, eventData, onCustomEvent: options.onCustomEvent });
				} catch (error) {
					console.error(error instanceof Error ? error.message : String(error));
				}
			})
		);
		boundEventCount++;
	}
	runtimeRegistrations.set(gui, registration);
	return {
		model: guiAuthoringModel,
		revision: state.revision,
		controlCount: controls.length,
		boundEventCount,
		fontAssignmentCount: state.fonts.length,
		loadedFontCount,
		atlasTextCount: state.atlasTexts.length,
		atlasTextReadyCount: registration.atlasTexts.length,
		atlasFontCount: loadedAtlasFonts.size,
		atlasTexts: clone(registration.atlasTexts),
		retainedDocumentReady: state.retainedDocument !== null,
		retainedControlCount: state.retainedDocument?.compiled.controls.length ?? 0,
		retainedPseudoBindingCount,
		retainedSourceFingerprint: state.retainedDocument?.compiled.sourceFingerprint ?? null,
		localizationBindingCount: state.localizations.length,
		localizations,
		accessibility,
		canvasGroupCount: state.canvasGroups.length,
		raycastReceiverCount: state.raycastReceivers.filter((receiver) => receiver.enabled).length,
		usageTracking: getGUIUsageTrackingEvidence(gui),
		panelRenderer: clone(state.toolkit.panelRenderer),
		visualElementReferenceCount: state.toolkit.references.length,
		resolvedVisualElementReferenceCount: state.toolkit.references.filter((reference) => controlsById.has(reference.controlId)).length,
		attributeOverrideCount: state.toolkit.attributeOverrides.length,
		animationCount: state.toolkit.animations.length,
		autoplayAnimationCount: autoplayAnimations.length,
		canvasScale: registration.canvasScale,
		missingControlIds,
	};
}
