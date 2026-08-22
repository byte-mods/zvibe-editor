export type GUIAccessibilityRole =
	| "button"
	| "header"
	| "image"
	| "keyboardKey"
	| "link"
	| "list"
	| "listItem"
	| "none"
	| "searchField"
	| "slider"
	| "staticText"
	| "tab"
	| "tabBar"
	| "textField"
	| "toggle";
export type GUIAccessibilityAction = "activate" | "decrement" | "increment";
export type GUIAccessibilityLive = "assertive" | "off" | "polite";

export interface IGUIAccessibilityNode {
	controlId: string;
	role: GUIAccessibilityRole;
	label: string;
	hint: string;
	value: string;
	focusOrder: number;
	allowsDirectInteraction: boolean;
	actions: GUIAccessibilityAction[];
	live: GUIAccessibilityLive;
}

export interface IGUIAccessibilitySettings {
	enabled: boolean;
	autoExposeText: boolean;
	textScale: number;
	boldText: boolean;
	captionsEnabled: boolean;
	usePlatformPreferences: boolean;
}

export interface IGUIAccessibilityState {
	settings: IGUIAccessibilitySettings;
	nodes: IGUIAccessibilityNode[];
}

export interface IGUISystemAccessibilityPreferences {
	textScale?: number;
	boldText?: boolean;
	captionsEnabled?: boolean;
}

export interface IGUIAccessibilityControlLike {
	name?: string;
	text?: string;
	fontSize?: number | string;
	fontWeight?: string;
	isEnabled?: boolean;
	isVisible?: boolean;
	value?: number;
	minimum?: number;
	maximum?: number;
	step?: number;
	onPointerClickObservable?: { notifyObservers(value: unknown): void };
	onValueChangedObservable?: { notifyObservers(value: unknown): void };
	onFocusObservable?: { notifyObservers(value: unknown): void };
	onBlurObservable?: { notifyObservers(value: unknown): void };
}

export interface IGUIAccessibilityControlDescription {
	id: string;
	parentId: string | null;
	name: string;
	type: string;
	path: string;
}

export interface IGUIAccessibilityRuntimeEvidence {
	enabled: boolean;
	bridgeAvailable: boolean;
	nodeCount: number;
	autoNodeCount: number;
	focusableNodeCount: number;
	direction: "ltr" | "rtl";
	preferences: Required<IGUISystemAccessibilityPreferences>;
}

export interface IApplyGUIAccessibilityOptions {
	gui: object;
	guiName: string;
	state: IGUIAccessibilityState;
	descriptions: IGUIAccessibilityControlDescription[];
	controls: ReadonlyMap<string, IGUIAccessibilityControlLike>;
	direction: "ltr" | "rtl";
	platformPreferences?: IGUISystemAccessibilityPreferences;
	onCleanup: (callback: () => void) => void;
}

interface IGUIAccessibilityRuntimeRegistration {
	elements: Map<string, HTMLElement>;
	liveRegion: HTMLElement | null;
	root: HTMLElement | null;
	nodes: Map<string, IGUIAccessibilityNode>;
	controls: ReadonlyMap<string, IGUIAccessibilityControlLike>;
	evidence: IGUIAccessibilityRuntimeEvidence;
	dispose: () => void;
}

export type GUIAccessibilityRGBA = [number, number, number, number];

export interface IGUIAccessibilityAuditControl extends IGUIAccessibilityControlDescription {
	text: string;
	fontSize: number | null;
	fontWeight: string;
	foreground: string | null;
	background: string | null;
	alpha: number;
	width: number | null;
	height: number | null;
	visible: boolean;
	enabled: boolean;
	hasImageBackground: boolean;
	backgroundSamples: GUIAccessibilityRGBA[] | null;
}

export interface IGUIAccessibilityAuditIssue {
	severity: "error" | "warning";
	code: string;
	path: string;
	controlId: string;
	controlType: string;
	message: string;
	contrastRatio?: number;
}

const runtimeRegistrations = new WeakMap<object, IGUIAccessibilityRuntimeRegistration>();
const roles = new Set<GUIAccessibilityRole>([
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
]);

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${label} must be a stable 1-128 character identifier.`);
	}
	return value;
}

function boundedText(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum || /\0/.test(value)) {
		throw new Error(`${label} must be a string with at most ${maximum} characters.`);
	}
	return value;
}

/** Returns the non-invasive default so legacy GUI assets do not acquire a DOM tree until enabled. */
export function createDefaultGUIAccessibilityState(): IGUIAccessibilityState {
	return { settings: { enabled: false, autoExposeText: true, textScale: 1, boldText: false, captionsEnabled: false, usePlatformPreferences: true }, nodes: [] };
}

/** Validates semantic nodes, actions, preferences, and exact hierarchy references. */
export function normalizeGUIAccessibilityState(value: unknown, controlIds?: ReadonlySet<string>): IGUIAccessibilityState {
	const source = object(value, "GUI accessibility state");
	const settingsSource = object(source.settings, "GUI accessibility settings");
	for (const key of ["enabled", "autoExposeText", "boldText", "captionsEnabled", "usePlatformPreferences"] as const) {
		if (typeof settingsSource[key] !== "boolean") {
			throw new Error(`GUI accessibility ${key} must be boolean.`);
		}
	}
	const textScale = Number(settingsSource.textScale);
	if (!Number.isFinite(textScale) || textScale < 0.5 || textScale > 3) {
		throw new Error("GUI accessibility textScale must be between 0.5 and 3.");
	}
	if (!Array.isArray(source.nodes) || source.nodes.length > 4096) {
		throw new Error("GUI accessibility supports at most 4,096 semantic nodes.");
	}
	const nodes = source.nodes.map((value, index): IGUIAccessibilityNode => {
		const node = object(value, `GUI accessibility node ${index}`);
		const controlId = identifier(node.controlId, `GUI accessibility node ${index} controlId`);
		if (controlIds && !controlIds.has(controlId)) {
			throw new Error(`GUI accessibility node references unknown control "${controlId}".`);
		}
		if (!roles.has(node.role as GUIAccessibilityRole)) {
			throw new Error(`GUI accessibility node ${controlId} has an unsupported role.`);
		}
		if (!Number.isSafeInteger(node.focusOrder) || Number(node.focusOrder) < -1 || Number(node.focusOrder) > 100_000) {
			throw new Error(`GUI accessibility node ${controlId} focusOrder must be -1 or 0-100000.`);
		}
		if (typeof node.allowsDirectInteraction !== "boolean") {
			throw new Error(`GUI accessibility node ${controlId} allowsDirectInteraction must be boolean.`);
		}
		if (!Array.isArray(node.actions) || node.actions.length > 3 || node.actions.some((action) => !["activate", "decrement", "increment"].includes(String(action)))) {
			throw new Error(`GUI accessibility node ${controlId} actions are invalid.`);
		}
		if (new Set(node.actions).size !== node.actions.length) {
			throw new Error(`GUI accessibility node ${controlId} actions cannot contain duplicates.`);
		}
		if (!["assertive", "off", "polite"].includes(String(node.live))) {
			throw new Error(`GUI accessibility node ${controlId} live mode is invalid.`);
		}
		return {
			controlId,
			role: node.role as GUIAccessibilityRole,
			label: boundedText(node.label, `GUI accessibility node ${controlId} label`, 512),
			hint: boundedText(node.hint, `GUI accessibility node ${controlId} hint`, 1024),
			value: boundedText(node.value, `GUI accessibility node ${controlId} value`, 512),
			focusOrder: Number(node.focusOrder),
			allowsDirectInteraction: node.allowsDirectInteraction,
			actions: [...node.actions] as GUIAccessibilityAction[],
			live: node.live as GUIAccessibilityLive,
		};
	});
	if (new Set(nodes.map((node) => node.controlId)).size !== nodes.length) {
		throw new Error("A GUI control can have only one accessibility node.");
	}
	return {
		settings: {
			enabled: settingsSource.enabled as boolean,
			autoExposeText: settingsSource.autoExposeText as boolean,
			textScale,
			boldText: settingsSource.boldText as boolean,
			captionsEnabled: settingsSource.captionsEnabled as boolean,
			usePlatformPreferences: settingsSource.usePlatformPreferences as boolean,
		},
		nodes,
	};
}

function ariaRole(role: GUIAccessibilityRole): string | null {
	return role === "staticText"
		? null
		: role === "searchField"
			? "searchbox"
			: role === "keyboardKey"
				? "button"
				: role === "tabBar"
					? "tablist"
					: role === "textField"
						? "textbox"
						: role === "toggle"
							? "checkbox"
							: role === "none"
								? null
								: role.toLowerCase();
}

/** Returns a detached copy of the active bridge evidence, or null before runtime application. */
export function getGUIAccessibilityRuntimeEvidence(gui: object): IGUIAccessibilityRuntimeEvidence | null {
	const evidence = runtimeRegistrations.get(gui)?.evidence;
	return evidence ? { ...evidence, preferences: { ...evidence.preferences } } : null;
}

function automaticNode(description: IGUIAccessibilityControlDescription, control: IGUIAccessibilityControlLike): IGUIAccessibilityNode | null {
	const text = typeof control.text === "string" ? control.text.replace(/[\u2066-\u2069]/g, "").trim() : "";
	if (!text) {
		return null;
	}
	return { controlId: description.id, role: "staticText", label: text, hint: "", value: "", focusOrder: -1, allowsDirectInteraction: false, actions: [], live: "off" };
}

function invokeAction(registration: IGUIAccessibilityRuntimeRegistration, controlId: string, action: GUIAccessibilityAction): void {
	const node = registration.nodes.get(controlId);
	const control = registration.controls.get(controlId);
	if (!node || !control || !node.actions.includes(action) || control.isEnabled === false) {
		throw new Error(`Accessibility action ${action} is unavailable for control ${controlId}.`);
	}
	if (action === "activate") {
		control.onPointerClickObservable?.notifyObservers(control);
	} else {
		const value = Number(control.value ?? 0);
		const step = Number.isFinite(control.step) && control.step! > 0 ? control.step! : 1;
		const minimum = Number.isFinite(control.minimum) ? control.minimum! : Number.NEGATIVE_INFINITY;
		const maximum = Number.isFinite(control.maximum) ? control.maximum! : Number.POSITIVE_INFINITY;
		control.value = Math.max(minimum, Math.min(maximum, value + (action === "increment" ? step : -step)));
		control.onValueChangedObservable?.notifyObservers(control.value);
	}
}

/** Creates a screen-reader hierarchy and applies authored/platform text preferences. */
export function applyGUIAccessibilityRuntime(options: IApplyGUIAccessibilityOptions): IGUIAccessibilityRuntimeEvidence {
	runtimeRegistrations.get(options.gui)?.dispose();
	const state = normalizeGUIAccessibilityState(options.state, new Set(options.descriptions.map((description) => description.id)));
	const preferences = {
		textScale: state.settings.usePlatformPreferences ? (options.platformPreferences?.textScale ?? state.settings.textScale) : state.settings.textScale,
		boldText: state.settings.usePlatformPreferences ? (options.platformPreferences?.boldText ?? state.settings.boldText) : state.settings.boldText,
		captionsEnabled: state.settings.usePlatformPreferences ? (options.platformPreferences?.captionsEnabled ?? state.settings.captionsEnabled) : state.settings.captionsEnabled,
	};
	if (!Number.isFinite(preferences.textScale) || preferences.textScale < 0.5 || preferences.textScale > 3) {
		throw new Error("Platform accessibility textScale must be between 0.5 and 3.");
	}
	const authored = new Map(state.nodes.map((node) => [node.controlId, node]));
	const nodes = new Map<string, IGUIAccessibilityNode>();
	let autoNodeCount = 0;
	for (const description of options.descriptions) {
		const control = options.controls.get(description.id);
		const node = authored.get(description.id) ?? (state.settings.autoExposeText && control ? automaticNode(description, control) : null);
		if (node) {
			nodes.set(description.id, node);
			if (!authored.has(description.id)) {
				autoNodeCount++;
			}
		}
	}
	const originalFonts = new Map<string, { size: number | string | undefined; weight: string | undefined }>();
	if (state.settings.enabled) {
		for (const [controlId, control] of options.controls) {
			if (control.fontSize === undefined && control.fontWeight === undefined) {
				continue;
			}
			originalFonts.set(controlId, { size: control.fontSize, weight: control.fontWeight });
			const fontSize = typeof control.fontSize === "number" ? control.fontSize : Number.parseFloat(String(control.fontSize));
			if (Number.isFinite(fontSize) && fontSize > 0) {
				control.fontSize = typeof control.fontSize === "number" ? fontSize * preferences.textScale : `${fontSize * preferences.textScale}px`;
			}
			if (preferences.boldText) {
				control.fontWeight = "bold";
			}
		}
	}
	let root: HTMLElement | null = null;
	const elements = new Map<string, HTMLElement>();
	let liveRegion: HTMLElement | null = null;
	if (state.settings.enabled && typeof document !== "undefined" && document.body) {
		root = document.createElement("div");
		root.setAttribute("data-zvibe-accessibility", options.guiName);
		root.setAttribute("dir", options.direction);
		root.style.cssText = "position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden;";
		for (const description of options.descriptions) {
			const node = nodes.get(description.id);
			if (!node || node.role === "none") {
				continue;
			}
			const element = document.createElement(node.role === "button" || node.role === "keyboardKey" ? "button" : "div");
			const role = ariaRole(node.role);
			if (role) {
				element.setAttribute("role", role);
			}
			if (node.label) {
				element.setAttribute("aria-label", node.label);
			}
			if (node.hint) {
				element.setAttribute("aria-description", node.hint);
			}
			if (node.value) {
				element.setAttribute("aria-valuetext", node.value);
			}
			if (node.live !== "off") {
				element.setAttribute("aria-live", node.live);
			}
			if (node.focusOrder >= 0) {
				element.tabIndex = node.focusOrder;
			}
			const control = options.controls.get(description.id);
			if (control?.isEnabled === false) {
				element.setAttribute("aria-disabled", "true");
			}
			if (control?.isVisible === false) {
				element.setAttribute("aria-hidden", "true");
			}
			element.addEventListener("focus", () => control?.onFocusObservable?.notifyObservers(control));
			element.addEventListener("blur", () => control?.onBlurObservable?.notifyObservers(control));
			if (node.actions.includes("activate")) {
				element.addEventListener("click", () => invokeAction(runtimeRegistrations.get(options.gui)!, description.id, "activate"));
			}
			elements.set(description.id, element);
			const parent = description.parentId ? elements.get(description.parentId) : null;
			(parent ?? root).appendChild(element);
		}
		liveRegion = document.createElement("div");
		liveRegion.setAttribute("aria-live", "polite");
		root.appendChild(liveRegion);
		document.body.appendChild(root);
	}
	const evidence: IGUIAccessibilityRuntimeEvidence = {
		enabled: state.settings.enabled,
		bridgeAvailable: root !== null,
		nodeCount: nodes.size,
		autoNodeCount,
		focusableNodeCount: [...nodes.values()].filter((node) => node.focusOrder >= 0).length,
		direction: options.direction,
		preferences,
	};
	let disposed = false;
	const registration: IGUIAccessibilityRuntimeRegistration = {
		elements,
		liveRegion,
		root,
		nodes,
		controls: options.controls,
		evidence,
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			root?.remove();
			for (const [controlId, font] of originalFonts) {
				const control = options.controls.get(controlId);
				if (control) {
					control.fontSize = font.size;
					control.fontWeight = font.weight;
				}
			}
			if (runtimeRegistrations.get(options.gui) === registration) {
				runtimeRegistrations.delete(options.gui);
			}
		},
	};
	runtimeRegistrations.set(options.gui, registration);
	options.onCleanup(registration.dispose);
	return evidence;
}

/** Keeps the active DOM hierarchy direction synchronized with live locale changes. */
export function updateGUIAccessibilityDirection(gui: object, direction: "ltr" | "rtl"): void {
	const registration = runtimeRegistrations.get(gui);
	if (!registration) {
		return;
	}
	registration.root?.setAttribute("dir", direction);
	registration.evidence.direction = direction;
}

/** Focuses one semantic node through the active platform bridge and Babylon focus observable. */
export function focusGUIAccessibilityNode(gui: object, controlId: string): void {
	const registration = runtimeRegistrations.get(gui);
	if (!registration?.nodes.has(controlId)) {
		throw new Error(`Accessibility node is not active: ${controlId}`);
	}
	const element = registration.elements.get(controlId);
	if (element) {
		element.focus();
	} else {
		registration.controls.get(controlId)?.onFocusObservable?.notifyObservers(registration.controls.get(controlId));
	}
}

/** Invokes a validated semantic action against its live Babylon control. */
export function invokeGUIAccessibilityAction(gui: object, controlId: string, action: GUIAccessibilityAction): void {
	const registration = runtimeRegistrations.get(gui);
	if (!registration) {
		throw new Error("GUI accessibility runtime is not active.");
	}
	invokeAction(registration, controlId, action);
}

/** Sends a bounded live-region announcement without mutating authored state. */
export function announceGUIAccessibility(gui: object, message: string, priority: Exclude<GUIAccessibilityLive, "off"> = "polite"): void {
	if (!message || message.length > 2048) {
		throw new Error("Accessibility announcement must contain 1-2,048 characters.");
	}
	const registration = runtimeRegistrations.get(gui);
	if (!registration) {
		throw new Error("GUI accessibility runtime is not active.");
	}
	if (registration.liveRegion) {
		registration.liveRegion.setAttribute("aria-live", priority);
		registration.liveRegion.textContent = message;
	}
}

/** Parses CSS hex/rgb/rgba colors into non-premultiplied sRGB channels. */
export function parseGUIAccessibilityColor(value: string | null): GUIAccessibilityRGBA | null {
	if (!value) {
		return null;
	}
	const text = value.trim();
	const hex = text.match(/^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
	if (hex) {
		const expanded =
			hex.length <= 4
				? hex
						.split("")
						.map((part) => `${part}${part}`)
						.join("")
				: hex;
		return [
			Number.parseInt(expanded.slice(0, 2), 16),
			Number.parseInt(expanded.slice(2, 4), 16),
			Number.parseInt(expanded.slice(4, 6), 16),
			expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
		];
	}
	const rgb = text.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i);
	if (!rgb) {
		return null;
	}
	const channels = rgb.slice(1, 4).map(Number);
	const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
	return channels.every((channel) => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1 ? [channels[0], channels[1], channels[2], alpha] : null;
}

function composite(foreground: GUIAccessibilityRGBA, background: GUIAccessibilityRGBA): GUIAccessibilityRGBA {
	const alpha = foreground[3] + background[3] * (1 - foreground[3]);
	if (alpha <= 0) {
		return [0, 0, 0, 0];
	}
	return [
		(foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
		(foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
		(foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
		alpha,
	];
}

function contrast(foreground: GUIAccessibilityRGBA, background: GUIAccessibilityRGBA): number {
	const luminance = (color: GUIAccessibilityRGBA): number => {
		const channels = color.slice(0, 3).map((channel) => {
			const normalized = channel / 255;
			return normalized <= 0.04045 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
	};
	const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

/** Audits the authored semantic hierarchy and resolved visual evidence without changing controls. */
export function auditGUIAccessibility(
	controls: IGUIAccessibilityAuditControl[],
	state: IGUIAccessibilityState
): { controlCount: number; errorCount: number; warningCount: number; issues: IGUIAccessibilityAuditIssue[] } {
	const normalized = normalizeGUIAccessibilityState(state, new Set(controls.map((control) => control.id)));
	const nodes = new Map(normalized.nodes.map((node) => [node.controlId, node]));
	const controlsById = new Map(controls.map((control) => [control.id, control]));
	const names = new Map<string, string>();
	const focusOrders = new Map<number, string>();
	const issues: IGUIAccessibilityAuditIssue[] = [];
	const add = (control: IGUIAccessibilityAuditControl, code: string, message: string, severity: "error" | "warning" = "warning", contrastRatio?: number): void => {
		issues.push({ severity, code, path: control.path, controlId: control.id, controlType: control.type, message, ...(contrastRatio === undefined ? {} : { contrastRatio }) });
	};
	const backgrounds = new Map<string, GUIAccessibilityRGBA[] | null>();
	const resolveBackgrounds = (control: IGUIAccessibilityAuditControl): GUIAccessibilityRGBA[] | null => {
		if (backgrounds.has(control.id)) {
			return backgrounds.get(control.id)!;
		}
		const parent = control.parentId ? controlsById.get(control.parentId) : null;
		let candidates = control.backgroundSamples?.length ? control.backgroundSamples : parent ? resolveBackgrounds(parent) : null;
		const authored = parseGUIAccessibilityColor(control.background);
		if (authored) {
			const adjusted: GUIAccessibilityRGBA = [authored[0], authored[1], authored[2], authored[3] * control.alpha];
			candidates = candidates?.length ? candidates.map((candidate) => composite(adjusted, candidate)) : adjusted[3] === 1 ? [adjusted] : null;
		}
		backgrounds.set(control.id, candidates);
		return candidates;
	};
	for (const control of controls) {
		const node = nodes.get(control.id);
		const interactive = /(Button|Checkbox|RadioButton|Slider|InputText|InputTextArea)/i.test(control.type);
		if (control.name) {
			const existing = names.get(control.name);
			if (existing) {
				add(control, "duplicateControlName", `Control name "${control.name}" is also used by ${existing}.`);
			} else {
				names.set(control.name, control.path);
			}
		}
		if (control.fontSize !== null && control.fontSize > 0 && control.fontSize * normalized.settings.textScale < 12) {
			add(control, "smallText", `Effective font size ${(control.fontSize * normalized.settings.textScale).toFixed(1)}px is below 12px.`);
		}
		if (interactive && (!node || !node.label.trim())) {
			add(control, "missingSemanticLabel", "Interactive control requires an authored semantic role and non-empty label.", "error");
		}
		if (/Image/i.test(control.type) && (!node || node.role !== "image" || !node.label.trim())) {
			add(control, "missingImageAlternative", "Image control requires an image semantic node with alternative text.");
		}
		if (node) {
			if (!control.visible) {
				add(control, "hiddenSemanticNode", "A hidden control remains present in the accessibility hierarchy.");
			}
			if (node.focusOrder >= 0) {
				const duplicate = focusOrders.get(node.focusOrder);
				if (duplicate) {
					add(control, "duplicateFocusOrder", `Focus order ${node.focusOrder} is also used by ${duplicate}.`, "error");
				} else {
					focusOrders.set(node.focusOrder, control.path);
				}
			}
			if (interactive && node.focusOrder < 0) {
				add(control, "interactiveNotFocusable", "Interactive semantic node is excluded from ordered keyboard/screen-reader focus.");
			}
		}
		if (interactive && control.enabled && control.width !== null && control.height !== null && (control.width < 44 || control.height < 44)) {
			add(control, "smallTarget", `Interactive target is ${control.width.toFixed(1)}×${control.height.toFixed(1)}px; target size should be at least 44×44px.`);
		}
		const foreground = parseGUIAccessibilityColor(control.foreground);
		const background = resolveBackgrounds(control);
		if (foreground && control.text) {
			if (background?.length) {
				const ratios = background.map((candidate) =>
					contrast(composite([foreground[0], foreground[1], foreground[2], foreground[3] * control.alpha], candidate), candidate)
				);
				const ratio = Math.min(...ratios);
				const large = (control.fontSize ?? 0) * normalized.settings.textScale >= (/bold|[7-9]00/.test(control.fontWeight) ? 14 : 18);
				const threshold = large ? 3 : 4.5;
				if (ratio < threshold) {
					add(control, "lowTextContrast", `Worst-case text contrast is ${ratio.toFixed(2)}:1; required ratio is ${threshold}:1.`, "error", Number(ratio.toFixed(2)));
				}
			} else if (control.hasImageBackground) {
				add(control, "unresolvedImageContrast", "Image-backed text contrast could not be sampled; make the image readable or provide explicit audit samples.");
			} else if (foreground[3] < 1 || parseGUIAccessibilityColor(control.background)?.[3] !== 1) {
				add(control, "unresolvedTransparentContrast", "Transparent text/background contrast cannot be resolved without an opaque ancestor or image sample.");
			}
		}
	}
	return {
		controlCount: controls.length,
		errorCount: issues.filter((issue) => issue.severity === "error").length,
		warningCount: issues.filter((issue) => issue.severity === "warning").length,
		issues,
	};
}
