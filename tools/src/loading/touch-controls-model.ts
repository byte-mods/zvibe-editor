export const TOUCH_CONTROLS_VERSION = 1 as const;
export const MAX_TOUCH_CONTROLS = 32;

export type TouchControlType = "button" | "stick";
export type TouchStickAxis = "both" | "horizontal" | "vertical";

export interface ITouchControlRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ITouchControlDefinition {
	id: string;
	name: string;
	type: TouchControlType;
	controlPath: string;
	label: string;
	rect: ITouchControlRect;
	backgroundColor: string;
	pressedColor: string;
	buttonValue: number;
	stickDeadzone: number;
	stickAxis: TouchStickAxis;
}

export interface ITouchControlsConfiguration {
	version: typeof TOUCH_CONTROLS_VERSION;
	revision: number;
	enabled: boolean;
	visibleInEditor: boolean;
	respectSafeArea: boolean;
	opacity: number;
	controls: ITouchControlDefinition[];
}

let fallbackId = 0;

/** Creates a stable authoring id without requiring a Babylon scene. */
export function createTouchControlId(): string {
	const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
	return `touch-${randomUUID ? randomUUID() : `${Date.now().toString(36)}-${(++fallbackId).toString(36)}`}`;
}

/** Returns the non-authoring default; controls become active only after explicit configuration. */
export function createDefaultTouchControlsConfiguration(): ITouchControlsConfiguration {
	return {
		version: TOUCH_CONTROLS_VERSION,
		revision: 1,
		enabled: false,
		visibleInEditor: true,
		respectSafeArea: true,
		opacity: 0.75,
		controls: [],
	};
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function finite(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeControl(value: unknown, index: number): ITouchControlDefinition {
	const source = asRecord(value);
	const rect = asRecord(source.rect);
	const type: TouchControlType = source.type === "stick" ? "stick" : "button";
	return {
		id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : `legacy-touch-${index + 1}`,
		name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : `${type === "stick" ? "Stick" : "Button"} ${index + 1}`,
		type,
		controlPath:
			typeof source.controlPath === "string" && source.controlPath.trim()
				? source.controlPath.trim()
				: type === "stick"
					? `<touch>/onScreenStick${index + 1}`
					: `<touch>/onScreenButton${index + 1}`,
		label: typeof source.label === "string" ? source.label.slice(0, 32) : type === "stick" ? "" : "Action",
		rect: {
			x: finite(rect.x, type === "stick" ? 0.05 : 0.78),
			y: finite(rect.y, 0.7),
			width: finite(rect.width, type === "stick" ? 0.22 : 0.16),
			height: finite(rect.height, type === "stick" ? 0.22 : 0.16),
		},
		backgroundColor: typeof source.backgroundColor === "string" ? source.backgroundColor : "#20242dcc",
		pressedColor: typeof source.pressedColor === "string" ? source.pressedColor : "#5b8cffdd",
		buttonValue: finite(source.buttonValue, 1),
		stickDeadzone: finite(source.stickDeadzone, 0.125),
		stickAxis: source.stickAxis === "horizontal" || source.stickAxis === "vertical" ? source.stickAxis : "both",
	};
}

/** Migrates absent/legacy records into one versioned shape without mutating authored metadata. */
export function normalizeTouchControlsConfiguration(value: unknown): ITouchControlsConfiguration {
	const source = asRecord(value);
	const defaults = createDefaultTouchControlsConfiguration();
	return {
		version: TOUCH_CONTROLS_VERSION,
		revision: Number.isSafeInteger(source.revision) && Number(source.revision) >= 1 ? Number(source.revision) : defaults.revision,
		enabled: source.enabled === true,
		visibleInEditor: source.visibleInEditor !== false,
		respectSafeArea: source.respectSafeArea !== false,
		opacity: finite(source.opacity, defaults.opacity),
		controls: Array.isArray(source.controls) ? source.controls.slice(0, MAX_TOUCH_CONTROLS + 1).map(normalizeControl) : [],
	};
}

function assertBoundedText(value: string, label: string, maximum: number): void {
	if (!value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1 through ${maximum} characters.`);
	}
}

/** Rejects ambiguous paths and layouts that cannot be rendered inside the normalized viewport. */
export function validateTouchControlsConfiguration(configuration: ITouchControlsConfiguration): void {
	if (configuration.version !== TOUCH_CONTROLS_VERSION || !Number.isSafeInteger(configuration.revision) || configuration.revision < 1) {
		throw new Error("Touch Controls requires version 1 and a positive safe-integer revision.");
	}
	if (typeof configuration.enabled !== "boolean" || typeof configuration.visibleInEditor !== "boolean" || typeof configuration.respectSafeArea !== "boolean") {
		throw new Error("Touch Controls enabled, visibleInEditor, and respectSafeArea must be Boolean.");
	}
	if (!Number.isFinite(configuration.opacity) || configuration.opacity < 0.05 || configuration.opacity > 1) {
		throw new Error("Touch Controls opacity must be from 0.05 through 1.");
	}
	if (configuration.controls.length > MAX_TOUCH_CONTROLS) {
		throw new Error(`Touch Controls supports at most ${MAX_TOUCH_CONTROLS} controls.`);
	}
	const ids = new Set<string>();
	const names = new Set<string>();
	const paths = new Set<string>();
	for (const control of configuration.controls) {
		assertBoundedText(control.id, "Touch Control id", 128);
		assertBoundedText(control.name, "Touch Control name", 128);
		if (ids.has(control.id) || names.has(control.name.toLowerCase())) {
			throw new Error("Touch Control ids and names must be unique.");
		}
		ids.add(control.id);
		names.add(control.name.toLowerCase());
		if (!/^<touch>\/[A-Za-z0-9][A-Za-z0-9_./-]{0,111}$/.test(control.controlPath) || paths.has(control.controlPath.toLowerCase())) {
			throw new Error(`Touch Control path must be a unique bounded <touch>/ path: ${control.controlPath}`);
		}
		paths.add(control.controlPath.toLowerCase());
		if (!/^(?:#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/.test(control.backgroundColor) || !/^(?:#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8})$/.test(control.pressedColor)) {
			throw new Error(`Touch Control "${control.name}" colors must use #RRGGBB or #RRGGBBAA.`);
		}
		if (control.label.length > 32 || !["button", "stick"].includes(control.type) || !["both", "horizontal", "vertical"].includes(control.stickAxis)) {
			throw new Error(`Touch Control "${control.name}" type, label, or stick axis is invalid.`);
		}
		const { x, y, width, height } = control.rect;
		if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width < 0.03 || height < 0.03 || x + width > 1 || y + height > 1) {
			throw new Error(`Touch Control "${control.name}" rect must stay inside normalized viewport bounds with a minimum 0.03 size.`);
		}
		if (!Number.isFinite(control.buttonValue) || control.buttonValue <= 0 || control.buttonValue > 1) {
			throw new Error(`Touch Control "${control.name}" buttonValue must be greater than 0 through 1.`);
		}
		if (!Number.isFinite(control.stickDeadzone) || control.stickDeadzone < 0 || control.stickDeadzone >= 1) {
			throw new Error(`Touch Control "${control.name}" stickDeadzone must be from 0 through less than 1.`);
		}
	}
}
