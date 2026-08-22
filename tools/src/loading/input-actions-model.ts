export type InputDeviceType = "keyboard" | "mouse" | "gamepad" | "touch";
export type InputActionType = "button" | "value" | "passThrough";
export type InputControlType = "button" | "axis" | "vector2" | "vector3";
export type InputActionPhase = "disabled" | "waiting" | "started" | "performed" | "canceled";
export type InputActionValue = number | [number, number] | [number, number, number];

export type InputProcessorType = "invert" | "scale" | "clamp" | "normalize" | "axisDeadzone" | "stickDeadzone";

export interface IInputProcessorDefinition {
	type: InputProcessorType;
	factor?: number;
	x?: number;
	y?: number;
	z?: number;
	min?: number;
	max?: number;
	zero?: number;
}

export type InputInteractionType = "press" | "hold" | "tap" | "slowTap" | "multiTap";

export interface IInputInteractionDefinition {
	type: InputInteractionType;
	pressPoint?: number;
	behavior?: "pressOnly" | "releaseOnly" | "pressAndRelease";
	duration?: number;
	tapCount?: number;
	tapDelay?: number;
}

export type InputCompositeType = "axis1d" | "vector2" | "vector3" | "oneModifier" | "twoModifiers";

export interface IInputCompositePartDefinition {
	name: string;
	path: string;
}

export interface IInputCompositeDefinition {
	type: InputCompositeType;
	normalize?: boolean;
	parts: IInputCompositePartDefinition[];
}

export interface IInputBindingDefinition {
	id: string;
	name?: string;
	path?: string;
	groups?: string[];
	processors?: IInputProcessorDefinition[];
	interactions?: IInputInteractionDefinition[];
	composite?: IInputCompositeDefinition;
}

export interface IInputActionDefinition {
	id: string;
	name: string;
	type: InputActionType;
	expectedControlType: InputControlType;
	enabled: boolean;
	initialStateCheck: boolean;
	processors: IInputProcessorDefinition[];
	interactions: IInputInteractionDefinition[];
	bindings: IInputBindingDefinition[];
}

export interface IInputControlSchemeDefinition {
	id: string;
	name: string;
	devices: InputDeviceType[];
}

export interface IInputActionMapDefinition {
	version: 2;
	revision: number;
	id: string;
	name: string;
	enabled: boolean;
	actions: IInputActionDefinition[];
	controlSchemes: IInputControlSchemeDefinition[];
}

export interface IInputSystemSettings {
	version: 2;
	revision: number;
	updateMode: "dynamic" | "fixed" | "manual";
	defaultDeadzoneMin: number;
	defaultDeadzoneMax: number;
	defaultButtonPressPoint: number;
	defaultTapTime: number;
	defaultSlowTapTime: number;
	defaultHoldTime: number;
	defaultMultiTapDelay: number;
	autoSwitchControlScheme: boolean;
	maxTraceEvents: number;
}

export const defaultInputSystemSettings: IInputSystemSettings = {
	version: 2,
	revision: 1,
	updateMode: "dynamic",
	defaultDeadzoneMin: 0.125,
	defaultDeadzoneMax: 0.925,
	defaultButtonPressPoint: 0.5,
	defaultTapTime: 0.2,
	defaultSlowTapTime: 0.5,
	defaultHoldTime: 0.4,
	defaultMultiTapDelay: 0.75,
	autoSwitchControlScheme: false,
	maxTraceEvents: 256,
};

let fallbackId = 0;

/** Creates a stable persisted identifier without requiring a Babylon scene. */
export function createInputId(prefix: string): string {
	const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
	return `${prefix}-${randomUUID ? randomUUID() : `${Date.now().toString(36)}-${(++fallbackId).toString(36)}`}`;
}

function createLegacyInputId(prefix: string, index: number, seed: string): string {
	let hash = 2166136261;
	for (let offset = 0; offset < seed.length; offset++) {
		hash ^= seed.charCodeAt(offset);
		hash = Math.imul(hash, 16777619);
	}
	return `legacy-${prefix}-${index}-${(hash >>> 0).toString(36)}`;
}

function normalizeProcessors(value: unknown): IInputProcessorDefinition[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((processor: any) => ({
		type: processor?.type,
		...(processor?.factor !== undefined ? { factor: processor.factor } : {}),
		...(processor?.x !== undefined ? { x: processor.x } : {}),
		...(processor?.y !== undefined ? { y: processor.y } : {}),
		...(processor?.z !== undefined ? { z: processor.z } : {}),
		...(processor?.min !== undefined ? { min: processor.min } : {}),
		...(processor?.max !== undefined ? { max: processor.max } : {}),
		...(processor?.zero !== undefined ? { zero: processor.zero } : {}),
	}));
}

function normalizeInteractions(value: unknown): IInputInteractionDefinition[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((interaction: any) => ({
		type: interaction?.type,
		...(interaction?.pressPoint !== undefined ? { pressPoint: interaction.pressPoint } : {}),
		...(interaction?.behavior !== undefined ? { behavior: interaction.behavior } : {}),
		...(interaction?.duration !== undefined ? { duration: interaction.duration } : {}),
		...(interaction?.tapCount !== undefined ? { tapCount: interaction.tapCount } : {}),
		...(interaction?.tapDelay !== undefined ? { tapDelay: interaction.tapDelay } : {}),
	}));
}

function normalizeBinding(value: unknown, fallbackId?: string): IInputBindingDefinition {
	if (typeof value === "string") {
		return { id: fallbackId ?? createInputId("binding"), path: value, groups: [], processors: [], interactions: [] };
	}
	const binding = (value ?? {}) as any;
	const composite = binding.composite
		? {
				type: binding.composite.type,
				normalize: binding.composite.normalize ?? true,
				parts: Array.isArray(binding.composite.parts) ? binding.composite.parts.map((part: any) => ({ name: part?.name ?? "", path: part?.path ?? "" })) : [],
			}
		: undefined;
	return {
		id: binding.id ?? fallbackId ?? createInputId("binding"),
		...(binding.name !== undefined ? { name: binding.name } : {}),
		...(binding.path !== undefined ? { path: binding.path } : {}),
		groups: Array.isArray(binding.groups) ? [...binding.groups] : [],
		processors: normalizeProcessors(binding.processors),
		interactions: normalizeInteractions(binding.interactions),
		...(composite ? { composite } : {}),
	};
}

function normalizeAction(value: unknown, fallbackId?: string): IInputActionDefinition {
	const action = (value ?? {}) as any;
	const type = action.type ?? "button";
	const id = action.id ?? fallbackId ?? createInputId("action");
	return {
		id,
		name: action.name ?? "",
		type,
		expectedControlType: action.expectedControlType ?? (type === "button" ? "button" : "axis"),
		enabled: action.enabled ?? true,
		initialStateCheck: action.initialStateCheck ?? type === "value",
		processors: normalizeProcessors(action.processors),
		interactions: normalizeInteractions(action.interactions),
		bindings: Array.isArray(action.bindings)
			? action.bindings.map((binding: unknown, index: number) => normalizeBinding(binding, fallbackId ? createLegacyInputId("binding", index, `${id}|${index}`) : undefined))
			: [],
	};
}

/** Migrates a legacy string-binding map into the complete version-2 authoring contract. */
export function normalizeInputActionMap(value: unknown, legacyIndex?: number): IInputActionMapDefinition {
	const map = (value ?? {}) as any;
	const id = map.id ?? (legacyIndex !== undefined ? createLegacyInputId("map", legacyIndex, `${map.name ?? ""}|${legacyIndex}`) : createInputId("map"));
	return {
		version: 2,
		revision: Number.isInteger(map.revision) && map.revision >= 1 ? map.revision : 1,
		id,
		name: map.name ?? "",
		enabled: map.enabled ?? true,
		actions: Array.isArray(map.actions)
			? map.actions.map((action: unknown, index: number) =>
					normalizeAction(action, legacyIndex !== undefined ? createLegacyInputId("action", index, `${id}|${(action as any)?.name ?? ""}|${index}`) : undefined)
				)
			: [],
		controlSchemes: Array.isArray(map.controlSchemes)
			? map.controlSchemes.map((scheme: any, index: number) => ({
					id: scheme?.id ?? (legacyIndex !== undefined ? createLegacyInputId("scheme", index, `${id}|${scheme?.name ?? ""}|${index}`) : createInputId("scheme")),
					name: scheme?.name ?? "",
					devices: Array.isArray(scheme?.devices) ? [...scheme.devices] : [],
				}))
			: [],
	};
}

/** Migrates every authored map while preserving declaration order. */
export function normalizeInputActionMaps(value: unknown): IInputActionMapDefinition[] {
	return Array.isArray(value) ? value.map((map, index) => normalizeInputActionMap(map, index)) : [];
}

/** Applies defaults to legacy project settings without mutating the source object. */
export function normalizeInputSystemSettings(value: unknown): IInputSystemSettings {
	const settings = (value ?? {}) as any;
	return {
		...defaultInputSystemSettings,
		...settings,
		version: 2,
		revision: Number.isInteger(settings.revision) && settings.revision >= 1 ? settings.revision : 1,
	};
}

function assertName(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > 128) {
		throw new Error(`${label} must contain from 1 through 128 characters.`);
	}
}

function assertUnique(values: string[], label: string): void {
	const normalized = values.map((value) => value.trim().toLowerCase());
	if (new Set(normalized).size !== normalized.length) {
		throw new Error(`${label} must be unique (case-insensitive).`);
	}
}

function validateProcessors(processors: IInputProcessorDefinition[], label: string): void {
	if (processors.length > 8) {
		throw new Error(`${label} supports at most 8 processors.`);
	}
	for (const processor of processors) {
		if (!["invert", "scale", "clamp", "normalize", "axisDeadzone", "stickDeadzone"].includes(processor.type)) {
			throw new Error(`${label} has an unsupported processor type.`);
		}
		for (const [key, value] of Object.entries(processor)) {
			if (key !== "type" && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1_000_000)) {
				throw new Error(`${label} processor ${processor.type}.${key} must be a finite bounded number.`);
			}
		}
		if ((processor.type === "clamp" || processor.type === "normalize" || processor.type.endsWith("Deadzone")) && (processor.min ?? 0) >= (processor.max ?? 1)) {
			throw new Error(`${label} processor ${processor.type} requires min less than max.`);
		}
	}
}

function validateInteractions(interactions: IInputInteractionDefinition[], label: string): void {
	if (interactions.length > 8) {
		throw new Error(`${label} supports at most 8 interactions.`);
	}
	for (const interaction of interactions) {
		if (!["press", "hold", "tap", "slowTap", "multiTap"].includes(interaction.type)) {
			throw new Error(`${label} has an unsupported interaction type.`);
		}
		if (interaction.behavior !== undefined && !["pressOnly", "releaseOnly", "pressAndRelease"].includes(interaction.behavior)) {
			throw new Error(`${label} interaction press behavior is unsupported.`);
		}
		if (interaction.pressPoint !== undefined && (!(interaction.pressPoint > 0) || interaction.pressPoint > 1 || !Number.isFinite(interaction.pressPoint))) {
			throw new Error(`${label} interaction pressPoint must be greater than 0 through 1.`);
		}
		if (interaction.duration !== undefined && (!(interaction.duration > 0) || interaction.duration > 60 || !Number.isFinite(interaction.duration))) {
			throw new Error(`${label} interaction duration must be greater than 0 through 60 seconds.`);
		}
		if (interaction.tapDelay !== undefined && (!(interaction.tapDelay > 0) || interaction.tapDelay > 60 || !Number.isFinite(interaction.tapDelay))) {
			throw new Error(`${label} multi-tap delay must be greater than 0 through 60 seconds.`);
		}
		if (interaction.tapCount !== undefined && (!Number.isInteger(interaction.tapCount) || interaction.tapCount < 2 || interaction.tapCount > 10)) {
			throw new Error(`${label} multi-tap count must be an integer from 2 through 10.`);
		}
	}
}

/** Rejects unsafe, ambiguous, or over-budget authoring before it reaches the runtime. */
export function validateInputActionMaps(maps: IInputActionMapDefinition[]): void {
	if (maps.length > 64) {
		throw new Error("A scene supports at most 64 Input Action Maps.");
	}
	assertUnique(
		maps.map((map) => map.id),
		"Input Action Map ids"
	);
	assertUnique(
		maps.map((map) => map.name),
		"Input Action Map names"
	);
	for (const map of maps) {
		assertName(map.id, "Input Action Map id");
		assertName(map.name, "Input Action Map name");
		if (map.version !== 2 || !Number.isInteger(map.revision) || map.revision < 1) {
			throw new Error(`Input Action Map "${map.name}" requires version 2 and a positive integer revision.`);
		}
		if (typeof map.enabled !== "boolean") {
			throw new Error(`Input Action Map "${map.name}" enabled must be Boolean.`);
		}
		if (map.actions.length > 128 || map.controlSchemes.length > 16) {
			throw new Error(`Input Action Map "${map.name}" exceeds 128 actions or 16 control schemes.`);
		}
		assertUnique(
			map.actions.map((action) => action.id),
			`Action ids in map "${map.name}"`
		);
		assertUnique(
			map.actions.map((action) => action.name),
			`Action names in map "${map.name}"`
		);
		assertUnique(
			map.controlSchemes.map((scheme) => scheme.id),
			`Control-scheme ids in map "${map.name}"`
		);
		assertUnique(
			map.controlSchemes.map((scheme) => scheme.name),
			`Control-scheme names in map "${map.name}"`
		);
		for (const scheme of map.controlSchemes) {
			assertName(scheme.id, "Control-scheme id");
			assertName(scheme.name, "Control-scheme name");
			if (!scheme.devices.length || scheme.devices.length > 4 || new Set(scheme.devices).size !== scheme.devices.length) {
				throw new Error(`Control scheme "${scheme.name}" requires 1 through 4 unique devices.`);
			}
			if (scheme.devices.some((device) => !["keyboard", "mouse", "gamepad", "touch"].includes(device))) {
				throw new Error(`Control scheme "${scheme.name}" contains an unsupported device.`);
			}
		}
		for (const action of map.actions) {
			assertName(action.id, "Input Action id");
			assertName(action.name, "Input Action name");
			if (!["button", "value", "passThrough"].includes(action.type) || !["button", "axis", "vector2", "vector3"].includes(action.expectedControlType)) {
				throw new Error(`Input Action "${action.name}" has an unsupported action or control type.`);
			}
			if (typeof action.enabled !== "boolean" || typeof action.initialStateCheck !== "boolean") {
				throw new Error(`Input Action "${action.name}" enabled and initialStateCheck must be Boolean.`);
			}
			if (action.bindings.length > 32) {
				throw new Error(`Input Action "${action.name}" supports at most 32 bindings.`);
			}
			validateProcessors(action.processors, `Input Action "${action.name}"`);
			validateInteractions(action.interactions, `Input Action "${action.name}"`);
			assertUnique(
				action.bindings.map((binding) => binding.id),
				`Binding ids on action "${action.name}"`
			);
			for (const binding of action.bindings) {
				assertName(binding.id, "Input binding id");
				if (binding.name !== undefined && (typeof binding.name !== "string" || binding.name.length > 128)) {
					throw new Error(`Binding "${binding.id}" name must contain at most 128 characters.`);
				}
				if (!!binding.path === !!binding.composite) {
					throw new Error(`Binding "${binding.id}" must define exactly one control path or composite.`);
				}
				if (binding.path !== undefined && (!binding.path.trim() || binding.path.length > 512)) {
					throw new Error(`Binding "${binding.id}" path must contain from 1 through 512 characters.`);
				}
				if ((binding.groups?.length ?? 0) > 16 || binding.groups?.some((group) => !group.trim() || group.length > 128)) {
					throw new Error(`Binding "${binding.id}" groups must contain at most 16 non-empty names.`);
				}
				if (binding.groups) {
					assertUnique(binding.groups, `Binding groups on "${binding.id}"`);
				}
				validateProcessors(binding.processors ?? [], `Binding "${binding.id}"`);
				validateInteractions(binding.interactions ?? [], `Binding "${binding.id}"`);
				if (binding.composite) {
					if (!["axis1d", "vector2", "vector3", "oneModifier", "twoModifiers"].includes(binding.composite.type)) {
						throw new Error(`Binding "${binding.id}" has an unsupported composite type.`);
					}
					if (!binding.composite.parts.length || binding.composite.parts.length > 8) {
						throw new Error(`Binding "${binding.id}" composite requires 1 through 8 parts.`);
					}
					assertUnique(
						binding.composite.parts.map((part) => part.name),
						`Composite part names on binding "${binding.id}"`
					);
					for (const part of binding.composite.parts) {
						assertName(part.name, "Composite part name");
						if (!part.path.trim() || part.path.length > 512) {
							throw new Error(`Composite part "${part.name}" requires a bounded control path.`);
						}
					}
				}
			}
		}
	}
}

/** Validates all project-level Input update, threshold, timing, and trace limits. */
export function validateInputSystemSettings(settings: IInputSystemSettings): void {
	if (settings.version !== 2 || !Number.isInteger(settings.revision) || settings.revision < 1) {
		throw new Error("Input settings require version 2 and a positive integer revision.");
	}
	if (!["dynamic", "fixed", "manual"].includes(settings.updateMode)) {
		throw new Error("Input update mode must be dynamic, fixed, or manual.");
	}
	if (typeof settings.autoSwitchControlScheme !== "boolean") {
		throw new Error("Input auto-switch control scheme must be Boolean.");
	}
	if (!(settings.defaultDeadzoneMin >= 0) || !(settings.defaultDeadzoneMax <= 1) || !(settings.defaultDeadzoneMin < settings.defaultDeadzoneMax)) {
		throw new Error("Input deadzone minimum and maximum must form an increasing range inside 0 through 1.");
	}
	if (!(settings.defaultButtonPressPoint > 0) || settings.defaultButtonPressPoint > 1) {
		throw new Error("Input button press point must be greater than 0 through 1.");
	}
	for (const [name, value] of [
		["tap time", settings.defaultTapTime],
		["slow-tap time", settings.defaultSlowTapTime],
		["hold time", settings.defaultHoldTime],
		["multi-tap delay", settings.defaultMultiTapDelay],
	] as const) {
		if (!(value > 0) || value > 60 || !Number.isFinite(value)) {
			throw new Error(`Input ${name} must be greater than 0 through 60 seconds.`);
		}
	}
	if (settings.defaultSlowTapTime < settings.defaultTapTime) {
		throw new Error("Input slow-tap time must be greater than or equal to tap time.");
	}
	if (!Number.isInteger(settings.maxTraceEvents) || settings.maxTraceEvents < 16 || settings.maxTraceEvents > 4096) {
		throw new Error("Input trace capacity must be an integer from 16 through 4096.");
	}
}
