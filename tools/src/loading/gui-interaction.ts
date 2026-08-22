export const guiCanvasGroupMetadataKey = "zvibeGuiCanvasGroup" as const;
export const guiRaycastReceiverMetadataKey = "zvibeGuiRaycastReceiver" as const;

export interface IGUICanvasGroupAssignment {
	controlId: string;
	alpha: number;
	interactable: boolean;
	blocksRaycasts: boolean;
	ignoreParentGroups: boolean;
}

export interface IGUIRaycastReceiverAssignment {
	controlId: string;
	enabled: boolean;
}

export interface IGUIUsageTrackingSettings {
	enabled: boolean;
	maxRecentEvents: number;
}

export type GUIUsageEventKind =
	| "layout"
	| "render"
	| "pointerClick"
	| "pointerDown"
	| "pointerUp"
	| "pointerEnter"
	| "pointerOut"
	| "valueChanged"
	| "textChanged"
	| "focus"
	| "blur";

export interface IGUIUsageEvent {
	sequence: number;
	kind: GUIUsageEventKind;
	controlId: string | null;
	timestampMs: number;
}

export interface IGUIUsageTrackingEvidence {
	enabled: boolean;
	controlCount: number;
	typeCounts: Record<string, number>;
	canvasGroupCount: number;
	raycastReceiverCount: number;
	counters: {
		layouts: number;
		renders: number;
		pointerEvents: number;
		valueEvents: number;
		focusEvents: number;
	};
	recentEvents: {
		total: number;
		count: number;
		offset: number;
		hasMore: boolean;
		items: IGUIUsageEvent[];
	};
}

export interface IGUIInteractionControlDescription {
	id: string;
	parentId: string | null;
	type: string;
}

export interface IGUIInteractionObservableLike {
	add?(callback: (value: unknown) => void): { remove(): void };
	notifyObservers?(value: unknown): void;
}

export interface IGUIInteractionControlLike {
	alpha: number;
	isEnabled?: boolean;
	isHitTestVisible?: boolean;
	isPointerBlocker?: boolean;
	children?: IGUIInteractionControlLike[];
	onPointerClickObservable?: IGUIInteractionObservableLike;
	onPointerDownObservable?: IGUIInteractionObservableLike;
	onPointerUpObservable?: IGUIInteractionObservableLike;
	onPointerEnterObservable?: IGUIInteractionObservableLike;
	onPointerOutObservable?: IGUIInteractionObservableLike;
	onValueChangedObservable?: IGUIInteractionObservableLike;
	onTextChangedObservable?: IGUIInteractionObservableLike;
	onFocusObservable?: IGUIInteractionObservableLike;
	onBlurObservable?: IGUIInteractionObservableLike;
}

export interface IGUIInteractionTextureLike {
	rootContainer: unknown;
	onBeginLayoutObservable?: IGUIInteractionObservableLike;
	onBeginRenderObservable?: IGUIInteractionObservableLike;
}

interface IGUIUsageState {
	enabled: boolean;
	maximum: number;
	sequence: number;
	controlCount: number;
	typeCounts: Record<string, number>;
	canvasGroupCount: number;
	raycastReceiverCount: number;
	counters: IGUIUsageTrackingEvidence["counters"];
	events: IGUIUsageEvent[];
}

interface IGUIInteractionRegistration {
	cleanup: Array<() => void>;
}

const registrations = new WeakMap<IGUIInteractionTextureLike, IGUIInteractionRegistration>();
const usageStates = new WeakMap<IGUIInteractionTextureLike, IGUIUsageState>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function assertControlId(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw new Error(`${label} must contain 1-128 letters, digits, dots, underscores, colons, or hyphens.`);
	}
}

/** Returns the default local-only GUI usage-tracking policy. */
export function createDefaultGUIUsageTrackingSettings(): IGUIUsageTrackingSettings {
	return { enabled: false, maxRecentEvents: 128 };
}

/** Validates one CanvasGroup assignment against the live stable-control identities. */
export function normalizeGUICanvasGroupAssignment(value: unknown, controlIds?: ReadonlySet<string>): IGUICanvasGroupAssignment {
	if (!isPlainObject(value)) {
		throw new Error("GUI CanvasGroup assignment must be an object.");
	}
	assertControlId(value.controlId, "GUI CanvasGroup controlId");
	if (controlIds && !controlIds.has(value.controlId)) {
		throw new Error(`GUI CanvasGroup references unknown control "${value.controlId}".`);
	}
	if (typeof value.alpha !== "number" || !Number.isFinite(value.alpha) || value.alpha < 0 || value.alpha > 1) {
		throw new Error("GUI CanvasGroup alpha must be between 0 and 1.");
	}
	for (const property of ["interactable", "blocksRaycasts", "ignoreParentGroups"] as const) {
		if (typeof value[property] !== "boolean") {
			throw new Error(`GUI CanvasGroup ${property} must be boolean.`);
		}
	}
	return {
		controlId: value.controlId,
		alpha: value.alpha,
		interactable: value.interactable as boolean,
		blocksRaycasts: value.blocksRaycasts as boolean,
		ignoreParentGroups: value.ignoreParentGroups as boolean,
	};
}

/** Validates one invisible RaycastReceiver assignment against the live stable-control identities. */
export function normalizeGUIRaycastReceiverAssignment(value: unknown, controlIds?: ReadonlySet<string>): IGUIRaycastReceiverAssignment {
	if (!isPlainObject(value)) {
		throw new Error("GUI RaycastReceiver assignment must be an object.");
	}
	assertControlId(value.controlId, "GUI RaycastReceiver controlId");
	if (controlIds && !controlIds.has(value.controlId)) {
		throw new Error(`GUI RaycastReceiver references unknown control "${value.controlId}".`);
	}
	if (typeof value.enabled !== "boolean") {
		throw new Error("GUI RaycastReceiver enabled must be boolean.");
	}
	return { controlId: value.controlId, enabled: value.enabled };
}

/** Validates bounded, local-only GUI usage tracking settings. */
export function normalizeGUIUsageTrackingSettings(value: unknown): IGUIUsageTrackingSettings {
	if (!isPlainObject(value) || typeof value.enabled !== "boolean" || typeof value.maxRecentEvents !== "number") {
		throw new Error("GUI usage tracking requires enabled and maxRecentEvents between 0 and 2,048.");
	}
	const maximum = value.maxRecentEvents;
	if (!Number.isInteger(maximum) || maximum < 0 || maximum > 2048) {
		throw new Error("GUI usage tracking requires enabled and maxRecentEvents between 0 and 2,048.");
	}
	return { enabled: value.enabled, maxRecentEvents: maximum };
}

function emptyCounters(): IGUIUsageTrackingEvidence["counters"] {
	return { layouts: 0, renders: 0, pointerEvents: 0, valueEvents: 0, focusEvents: 0 };
}

function usageStateFor(gui: IGUIInteractionTextureLike): IGUIUsageState {
	let state = usageStates.get(gui);
	if (!state) {
		state = {
			enabled: false,
			maximum: 128,
			sequence: 0,
			controlCount: 0,
			typeCounts: {},
			canvasGroupCount: 0,
			raycastReceiverCount: 0,
			counters: emptyCounters(),
			events: [],
		};
		usageStates.set(gui, state);
	}
	return state;
}

function recordUsage(state: IGUIUsageState, kind: GUIUsageEventKind, controlId: string | null): void {
	if (!state.enabled) {
		return;
	}
	if (kind === "layout") {
		state.counters.layouts++;
	} else if (kind === "render") {
		state.counters.renders++;
	} else if (kind === "valueChanged" || kind === "textChanged") {
		state.counters.valueEvents++;
	} else if (kind === "focus" || kind === "blur") {
		state.counters.focusEvents++;
	} else {
		state.counters.pointerEvents++;
	}
	if (!state.maximum) {
		return;
	}
	state.events.push({ sequence: ++state.sequence, kind, controlId, timestampMs: Date.now() });
	if (state.events.length > state.maximum) {
		state.events.splice(0, state.events.length - state.maximum);
	}
}

/** Restores properties and removes observers installed by the GUI interaction runtime. */
export function detachGUIInteractionRuntime(gui: IGUIInteractionTextureLike): void {
	registrations.get(gui)?.cleanup.forEach((cleanup) => cleanup());
	registrations.delete(gui);
}

/**
 * Applies CanvasGroup hierarchy semantics, invisible RaycastReceiver hit targets, and bounded local usage tracking.
 * The effective alpha is written at draw-state time, so nested groups and ignoreParentGroups do not mutate authored child alpha values.
 */
export function applyGUIInteractionRuntime(
	gui: IGUIInteractionTextureLike,
	descriptions: IGUIInteractionControlDescription[],
	controls: ReadonlyMap<string, IGUIInteractionControlLike>,
	canvasGroups: IGUICanvasGroupAssignment[],
	raycastReceivers: IGUIRaycastReceiverAssignment[],
	usageSettings: IGUIUsageTrackingSettings
): void {
	detachGUIInteractionRuntime(gui);
	const cleanup: Array<() => void> = [];
	const groups = new Map(canvasGroups.map((group) => [group.controlId, group]));
	const receivers = new Map(raycastReceivers.map((receiver) => [receiver.controlId, receiver]));
	const descriptionsById = new Map(descriptions.map((description) => [description.id, description]));
	const effective = new Map<string, { alpha: number; interactable: boolean; blocksRaycasts: boolean }>();
	const resolveEffective = (controlId: string): { alpha: number; interactable: boolean; blocksRaycasts: boolean } => {
		const cached = effective.get(controlId);
		if (cached) {
			return cached;
		}
		const chain: string[] = [];
		let current: IGUIInteractionControlDescription | undefined = descriptionsById.get(controlId);
		while (current) {
			chain.unshift(current.id);
			current = current.parentId ? descriptionsById.get(current.parentId) : undefined;
		}
		const result = { alpha: 1, interactable: true, blocksRaycasts: true };
		for (const id of chain) {
			const group = groups.get(id);
			if (!group) {
				continue;
			}
			if (group.ignoreParentGroups) {
				result.alpha = 1;
				result.interactable = true;
				result.blocksRaycasts = true;
			}
			result.alpha *= group.alpha;
			result.interactable &&= group.interactable;
			result.blocksRaycasts &&= group.blocksRaycasts;
		}
		effective.set(controlId, result);
		return result;
	};

	for (const description of descriptions) {
		const control = controls.get(description.id);
		if (!control) {
			continue;
		}
		const resolved = resolveEffective(description.id);
		const parentResolved = description.parentId ? resolveEffective(description.parentId) : { alpha: 1 };
		const localGroupAlpha = parentResolved.alpha > 0 ? resolved.alpha / parentResolved.alpha : resolved.alpha;
		const originalPointerBlocker = control.isPointerBlocker;
		const dynamic = control as unknown as Record<string, unknown>;
		const originalApplyStates = typeof dynamic._applyStates === "function" ? (dynamic._applyStates as (context: { globalAlpha: number }) => void) : null;
		const originalProcessPicking = typeof dynamic._processPicking === "function" ? (dynamic._processPicking as (...args: unknown[]) => boolean) : null;
		if (originalApplyStates) {
			dynamic._applyStates = function (context: { globalAlpha: number }): void {
				const inheritedAlpha = context.globalAlpha;
				originalApplyStates.call(this, context);
				const expectedInheritedAlpha = inheritedAlpha * control.alpha;
				const keptInheritedAlpha = Math.abs(context.globalAlpha - expectedInheritedAlpha) <= 1e-9;
				context.globalAlpha *= keptInheritedAlpha ? localGroupAlpha : resolved.alpha;
			};
		}
		const receiver = receivers.get(description.id);
		if (originalProcessPicking) {
			dynamic._processPicking = function (...args: unknown[]): boolean {
				if (!resolved.interactable || !resolved.blocksRaycasts || (receiver && !receiver.enabled)) {
					return false;
				}
				return originalProcessPicking.apply(this, args);
			};
		}
		if (receiver?.enabled) {
			control.isPointerBlocker = receiver.enabled;
		}
		cleanup.push(() => {
			if (originalPointerBlocker !== undefined) {
				control.isPointerBlocker = originalPointerBlocker;
			}
			if (originalApplyStates) {
				dynamic._applyStates = originalApplyStates;
			}
			if (originalProcessPicking) {
				dynamic._processPicking = originalProcessPicking;
			}
		});
	}

	const usage = usageStateFor(gui);
	usage.enabled = usageSettings.enabled;
	usage.maximum = usageSettings.maxRecentEvents;
	usage.controlCount = descriptions.length;
	usage.typeCounts = descriptions.reduce<Record<string, number>>((counts, description) => {
		counts[description.type] = (counts[description.type] ?? 0) + 1;
		return counts;
	}, {});
	usage.canvasGroupCount = canvasGroups.length;
	usage.raycastReceiverCount = raycastReceivers.filter((receiver) => receiver.enabled).length;
	if (usage.events.length > usage.maximum) {
		usage.events.splice(0, usage.events.length - usage.maximum);
	}
	if (usage.enabled) {
		const bind = (observable: IGUIInteractionObservableLike | undefined, kind: GUIUsageEventKind, controlId: string | null): void => {
			if (!observable?.add) {
				return;
			}
			const observer = observable.add(() => recordUsage(usage, kind, controlId));
			cleanup.push(() => observer.remove());
		};
		bind(gui.onBeginLayoutObservable, "layout", null);
		bind(gui.onBeginRenderObservable, "render", null);
		for (const [controlId, control] of controls) {
			bind(control.onPointerClickObservable, "pointerClick", controlId);
			bind(control.onPointerDownObservable, "pointerDown", controlId);
			bind(control.onPointerUpObservable, "pointerUp", controlId);
			bind(control.onPointerEnterObservable, "pointerEnter", controlId);
			bind(control.onPointerOutObservable, "pointerOut", controlId);
			bind(control.onValueChangedObservable, "valueChanged", controlId);
			bind(control.onTextChangedObservable, "textChanged", controlId);
			bind(control.onFocusObservable, "focus", controlId);
			bind(control.onBlurObservable, "blur", controlId);
		}
	}
	registrations.set(gui, { cleanup });
}

/** Reads a bounded page of local GUI usage evidence without transmitting telemetry outside the project process. */
export function getGUIUsageTrackingEvidence(gui: IGUIInteractionTextureLike, offset = 0, limit = 100): IGUIUsageTrackingEvidence {
	const state = usageStateFor(gui);
	const boundedOffset = Math.max(0, Math.min(state.events.length, Number.isInteger(offset) ? offset : 0));
	const boundedLimit = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 100));
	const items = state.events.slice(boundedOffset, boundedOffset + boundedLimit);
	return {
		enabled: state.enabled,
		controlCount: state.controlCount,
		typeCounts: clone(state.typeCounts),
		canvasGroupCount: state.canvasGroupCount,
		raycastReceiverCount: state.raycastReceiverCount,
		counters: { ...state.counters },
		recentEvents: { total: state.events.length, count: items.length, offset: boundedOffset, hasMore: boundedOffset + items.length < state.events.length, items: clone(items) },
	};
}

/** Clears transient usage counters/events while preserving the authored tracking policy. */
export function resetGUIUsageTrackingEvidence(gui: IGUIInteractionTextureLike): IGUIUsageTrackingEvidence {
	const state = usageStateFor(gui);
	state.counters = emptyCounters();
	state.events = [];
	state.sequence = 0;
	return getGUIUsageTrackingEvidence(gui);
}
