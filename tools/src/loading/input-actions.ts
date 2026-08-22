import { Observable } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

import {
	IInputActionDefinition,
	IInputActionMapDefinition,
	IInputBindingDefinition,
	IInputCompositeDefinition,
	IInputInteractionDefinition,
	IInputProcessorDefinition,
	InputActionPhase,
	InputActionValue,
	InputControlType,
	InputDeviceType,
	normalizeInputActionMaps,
	normalizeInputSystemSettings,
	IInputSystemSettings,
	validateInputActionMaps,
	validateInputSystemSettings,
} from "./input-actions-model";

export * from "./input-actions-model";

export interface IInputActionEvent {
	sequence: number;
	time: number;
	mapId: string;
	mapName: string;
	actionId: string;
	actionName: string;
	phase: InputActionPhase;
	value: InputActionValue;
	controlPath: string | null;
	device: InputDeviceType | null;
	interaction: string | null;
}

export interface IInputActionRuntimeState {
	mapId: string;
	mapName: string;
	actionId: string;
	actionName: string;
	type: IInputActionDefinition["type"];
	expectedControlType: InputControlType;
	enabled: boolean;
	phase: InputActionPhase;
	value: InputActionValue;
	magnitude: number;
	isPressed: boolean;
	wasPressedThisUpdate: boolean;
	wasReleasedThisUpdate: boolean;
	wasPerformedThisUpdate: boolean;
	controlPath: string | null;
	device: InputDeviceType | null;
	interaction: string | null;
	startedAt: number | null;
	performedAt: number | null;
	canceledAt: number | null;
	triggerCount: number;
}

export interface IInputDeviceRuntimeState {
	id: string;
	device: InputDeviceType;
	displayName: string;
	connected: boolean;
	mapping?: string;
	buttonCount?: number;
	axisCount?: number;
}

interface IActionState extends IInputActionRuntimeState {
	initialized: boolean;
	suppressedUntilRelease: boolean;
	previousValue: InputActionValue;
	pressedAt: number | null;
	tapCount: number;
	lastTapAt: number | null;
	holdPerformed: boolean;
}

interface ISampledAction {
	value: InputActionValue;
	controlPath: string | null;
	device: InputDeviceType | null;
	interactions: IInputInteractionDefinition[];
}

interface IBindingOverrideRecord {
	mapId: string;
	actionId: string;
	bindingId: string;
	path: string;
}

const gamepadButtons: Record<string, number> = {
	buttonsouth: 0,
	buttoneast: 1,
	buttonwest: 2,
	buttonnorth: 3,
	leftshoulder: 4,
	rightshoulder: 5,
	lefttrigger: 6,
	righttrigger: 7,
	select: 8,
	start: 9,
	leftstickpress: 10,
	rightstickpress: 11,
	dpadup: 12,
	dpaddown: 13,
	dpadleft: 14,
	dpadright: 15,
};

function zeroValue(type: InputControlType): InputActionValue {
	return type === "vector2" ? [0, 0] : type === "vector3" ? [0, 0, 0] : 0;
}

function cloneValue(value: InputActionValue): InputActionValue {
	return Array.isArray(value) ? ([...value] as [number, number] | [number, number, number]) : value;
}

function magnitude(value: InputActionValue): number {
	return Array.isArray(value) ? Math.sqrt(value.reduce((sum, component) => sum + component * component, 0)) : Math.abs(value);
}

function valuesEqual(left: InputActionValue, right: InputActionValue): boolean {
	if (Array.isArray(left) !== Array.isArray(right)) {
		return false;
	}
	return Array.isArray(left) && Array.isArray(right) ? left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= 1e-6) : left === right;
}

function coerceValue(value: InputActionValue, type: InputControlType): InputActionValue {
	if (type === "vector2") {
		return Array.isArray(value) ? [value[0] ?? 0, value[1] ?? 0] : [value, 0];
	}
	if (type === "vector3") {
		return Array.isArray(value) ? [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0] : [value, 0, 0];
	}
	return Array.isArray(value) ? (type === "button" ? magnitude(value) : (value[0] ?? 0)) : value;
}

function scaleValue(value: InputActionValue, x: number, y = x, z = x): InputActionValue {
	if (Array.isArray(value)) {
		return value.length === 2 ? [value[0] * x, value[1] * y] : [value[0] * x, value[1] * y, value[2] * z];
	}
	return value * x;
}

function normalizeVector(value: InputActionValue): InputActionValue {
	const size = magnitude(value);
	return size > 1e-9 ? scaleValue(value, 1 / size) : cloneValue(value);
}

function clampScalar(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function applyProcessor(value: InputActionValue, processor: IInputProcessorDefinition, settings: IInputSystemSettings): InputActionValue {
	switch (processor.type) {
		case "invert":
			return scaleValue(value, processor.x ?? -1, processor.y ?? processor.x ?? -1, processor.z ?? processor.x ?? -1);
		case "scale":
			return scaleValue(value, processor.x ?? processor.factor ?? 1, processor.y ?? processor.factor ?? 1, processor.z ?? processor.factor ?? 1);
		case "clamp": {
			const min = processor.min ?? -1;
			const max = processor.max ?? 1;
			return Array.isArray(value)
				? (value.map((component) => clampScalar(component, min, max)) as [number, number] | [number, number, number])
				: clampScalar(value, min, max);
		}
		case "normalize": {
			if (Array.isArray(value)) {
				return normalizeVector(value);
			}
			const min = processor.min ?? -1;
			const max = processor.max ?? 1;
			const zero = processor.zero ?? 0;
			return value >= zero ? clampScalar((value - zero) / Math.max(1e-9, max - zero), 0, 1) : -clampScalar((zero - value) / Math.max(1e-9, zero - min), 0, 1);
		}
		case "axisDeadzone": {
			const min = processor.min ?? settings.defaultDeadzoneMin;
			const max = processor.max ?? settings.defaultDeadzoneMax;
			const apply = (component: number): number => {
				const size = Math.abs(component);
				return size <= min ? 0 : Math.sign(component) * clampScalar((size - min) / (max - min), 0, 1);
			};
			return Array.isArray(value) ? (value.map(apply) as [number, number] | [number, number, number]) : apply(value);
		}
		case "stickDeadzone": {
			const min = processor.min ?? settings.defaultDeadzoneMin;
			const max = processor.max ?? settings.defaultDeadzoneMax;
			const size = magnitude(value);
			if (size <= min) {
				return Array.isArray(value) ? (value.map(() => 0) as [number, number] | [number, number, number]) : 0;
			}
			return scaleValue(value, clampScalar((size - min) / (max - min), 0, 1) / Math.max(size, 1e-9));
		}
	}
}

function applyProcessors(value: InputActionValue, processors: readonly IInputProcessorDefinition[], settings: IInputSystemSettings): InputActionValue {
	return processors.reduce((current, processor) => applyProcessor(current, processor, settings), value);
}

/** Returns the portable browser device family addressed by one Unity-style control path. */
export function getInputBindingDevice(path: string): InputDeviceType {
	const normalized = path.trim().toLowerCase();
	if (normalized.includes("gamepad")) {
		return "gamepad";
	}
	if (normalized.includes("touch")) {
		return "touch";
	}
	if (normalized.includes("mouse") || normalized.includes("pointer")) {
		return "mouse";
	}
	return "keyboard";
}

function normalizedPath(path: string): string {
	const value = path.trim().toLowerCase();
	if (value.startsWith("<")) {
		return value.replace(/^<([^>]+)>?\/?/, "<$1>/");
	}
	if (value.includes("/")) {
		const [device, ...control] = value.split("/");
		return `<${device}>/${control.join("/")}`;
	}
	return `<keyboard>/${value}`;
}

/** Shared editor/export runtime for versioned Input Action Maps. */
export class InputActions {
	public readonly onActionObservable = new Observable<IInputActionEvent>();

	private _maps: IInputActionMapDefinition[];
	private _settings: IInputSystemSettings;
	private _target: EventTarget;
	private _pressed = new Set<string>();
	private _mouseButtons = new Set<number>();
	private _mousePosition: [number, number] = [0, 0];
	private _mouseDelta: [number, number] = [0, 0];
	private _mouseScroll: [number, number] = [0, 0];
	private _touchPressed = false;
	private _touchPosition: [number, number] = [0, 0];
	private _touchDelta: [number, number] = [0, 0];
	private _simulatedControls = new Map<string, InputActionValue>();
	private _activeSchemes = new Map<string, string>();
	private _mapEnableOverrides = new Map<string, boolean>();
	private _actionEnableOverrides = new Map<string, boolean>();
	private _bindingOverrides = new Map<string, string>();
	private _states = new Map<string, IActionState>();
	private _trace: IInputActionEvent[] = [];
	private _listeners: Array<{ type: string; listener: EventListener }> = [];
	private _disposeCallbacks: Array<() => void> = [];
	private _rebindCleanups = new Set<() => void>();
	private _time = 0;
	private _sequence = 0;
	private _lastUsedDevice: InputDeviceType | null = null;
	private _disposed = false;

	public constructor(maps: IInputActionMapDefinition[] | unknown[], target: EventTarget, settings?: Partial<IInputSystemSettings>) {
		this._maps = normalizeInputActionMaps(maps);
		this._settings = normalizeInputSystemSettings(settings);
		validateInputActionMaps(this._maps);
		validateInputSystemSettings(this._settings);
		this._target = target;
		this._installListeners();
		this._ensureStates();
		this.update(0);
	}

	/** Removes all host observers/listeners, pending rebinds, transient input, and trace subscribers. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._listeners.forEach(({ type, listener }) => this._target.removeEventListener(type, listener));
		this._listeners = [];
		for (const cleanup of [...this._rebindCleanups]) {
			cleanup();
		}
		this._disposeCallbacks.splice(0).forEach((callback) => callback());
		this._pressed.clear();
		this._mouseButtons.clear();
		this._simulatedControls.clear();
		this.onActionObservable.clear();
	}

	/** Registers scene-owned observer cleanup with the runtime lifecycle. */
	public addDisposeCallback(callback: () => void): void {
		this._disposeCallbacks.push(callback);
	}

	/** Polls devices and advances interaction timers by one deterministic update. */
	public update(deltaSeconds = 0): void {
		if (this._disposed || !Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			return;
		}
		this._time += deltaSeconds;
		for (const state of this._states.values()) {
			state.wasPressedThisUpdate = false;
			state.wasReleasedThisUpdate = false;
			state.wasPerformedThisUpdate = false;
		}
		for (const map of this._maps) {
			for (const action of map.actions) {
				this._evaluateAction(map, action);
			}
		}
		this._mouseDelta = [0, 0];
		this._mouseScroll = [0, 0];
		this._touchDelta = [0, 0];
	}

	/** Returns the scalar action value; vector actions return their magnitude for backward compatibility. */
	public getValue(mapName: string, actionName: string): number {
		const value = this.readValue(mapName, actionName);
		return Array.isArray(value) ? magnitude(value) : value;
	}

	/** Returns the exact scalar/Vector2/Vector3 value after composites and processors. */
	public readValue(mapName: string, actionName: string): InputActionValue {
		const found = this._findAction(mapName, actionName);
		const state = found ? this._states.get(found.action.id) : null;
		return state ? cloneValue(state.value) : 0;
	}

	public getVector2(mapName: string, actionName: string): [number, number] {
		const value = this.readValue(mapName, actionName);
		return coerceValue(value, "vector2") as [number, number];
	}

	public getVector3(mapName: string, actionName: string): [number, number, number] {
		const value = this.readValue(mapName, actionName);
		return coerceValue(value, "vector3") as [number, number, number];
	}

	public isPressed(mapName: string, actionName: string): boolean {
		const found = this._findAction(mapName, actionName);
		return found && this._isEnabled(found.map, found.action) ? (this._states.get(found.action.id)?.isPressed ?? false) : false;
	}

	public getActionState(mapName: string, actionName: string): IInputActionRuntimeState | null {
		const found = this._findAction(mapName, actionName);
		const state = found ? this._states.get(found.action.id) : null;
		if (!state) {
			return null;
		}
		const {
			initialized: _initialized,
			suppressedUntilRelease: _suppressedUntilRelease,
			previousValue: _previousValue,
			pressedAt: _pressedAt,
			tapCount: _tapCount,
			lastTapAt: _lastTapAt,
			holdPerformed: _holdPerformed,
			...publicState
		} = state;
		return structuredClone(publicState);
	}

	public listActionStates(): IInputActionRuntimeState[] {
		return this._maps.flatMap((map) => map.actions.map((action) => this.getActionState(map.id, action.id)!));
	}

	public setMapEnabled(mapName: string, enabled: boolean): boolean {
		const map = this._findMap(mapName);
		if (!map) {
			return false;
		}
		this._mapEnableOverrides.set(map.id, enabled);
		for (const action of map.actions) {
			if (enabled) {
				this._prepareForEnable(action);
			}
			this._evaluateAction(map, action);
		}
		return true;
	}

	public setActionEnabled(mapName: string, actionName: string, enabled: boolean): boolean {
		const found = this._findAction(mapName, actionName);
		if (!found) {
			return false;
		}
		this._actionEnableOverrides.set(found.action.id, enabled);
		if (enabled) {
			this._prepareForEnable(found.action);
		}
		this._evaluateAction(found.map, found.action);
		return true;
	}

	/** Activates one authored control scheme for a map. */
	public setControlScheme(mapName: string, schemeName: string): boolean {
		const map = this._findMap(mapName);
		const scheme = map?.controlSchemes.find((candidate) => candidate.name === schemeName || candidate.id === schemeName);
		if (!map || !scheme) {
			return false;
		}
		this._activeSchemes.set(map.id, scheme.id);
		this.update(0);
		return true;
	}

	public getControlScheme(mapName: string): string | null {
		const map = this._findMap(mapName);
		if (!map) {
			return null;
		}
		const id = this._activeSchemes.get(map.id) ?? map.controlSchemes[0]?.id;
		return map.controlSchemes.find((scheme) => scheme.id === id)?.name ?? null;
	}

	public getDevices(): IInputDeviceRuntimeState[] {
		const result: IInputDeviceRuntimeState[] = [
			{ id: "keyboard", device: "keyboard", displayName: "Keyboard", connected: true },
			{ id: "mouse", device: "mouse", displayName: "Mouse", connected: true },
			{ id: "touch", device: "touch", displayName: "Touchscreen", connected: typeof globalThis.TouchEvent !== "undefined" || this._touchPressed },
		];
		for (const gamepad of this._gamepads()) {
			result.push({
				id: `gamepad-${gamepad.index}`,
				device: "gamepad",
				displayName: gamepad.id || `Gamepad ${gamepad.index + 1}`,
				connected: gamepad.connected !== false,
				mapping: gamepad.mapping,
				buttonCount: gamepad.buttons.length,
				axisCount: gamepad.axes.length,
			});
		}
		return result;
	}

	public getLastUsedDevice(): InputDeviceType | null {
		return this._lastUsedDevice;
	}

	/** Injects a control path for deterministic previews/tests without modifying authored bindings. */
	public simulateControl(path: string, value: InputActionValue): boolean {
		if (!this._validValue(value)) {
			return false;
		}
		const key = normalizedPath(path);
		this._simulatedControls.set(key, cloneValue(value));
		this._notifyDeviceActivity(getInputBindingDevice(path));
		this.update(0);
		return true;
	}

	public clearSimulatedControl(path: string): boolean {
		const deleted = this._simulatedControls.delete(normalizedPath(path));
		if (deleted) {
			this.update(0);
		}
		return deleted;
	}

	/** Backward-compatible normalized primary-touch injection. */
	public simulateTouch(pressed: boolean, x = this._touchPosition[0], y = this._touchPosition[1]): boolean {
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			return false;
		}
		const previous = this._touchPosition;
		this._touchPressed = pressed;
		this._touchPosition = [clampScalar(x, 0, 1), clampScalar(y, 0, 1)];
		this._touchDelta = [this._touchPosition[0] - previous[0], this._touchPosition[1] - previous[1]];
		this._notifyDeviceActivity("touch");
		this.update(0);
		return true;
	}

	/** Applies a non-destructive runtime override identified by stable map/action/binding ids. */
	public applyBindingOverride(mapName: string, actionName: string, bindingId: string, path: string): boolean {
		const found = this._findAction(mapName, actionName);
		if (!found || !path.trim() || !found.action.bindings.some((binding) => binding.id === bindingId)) {
			return false;
		}
		this._bindingOverrides.set(bindingId, path.trim());
		this.update(0);
		return true;
	}

	public clearBindingOverride(mapName: string, actionName: string, bindingId?: string): boolean {
		const found = this._findAction(mapName, actionName);
		if (!found) {
			return false;
		}
		const ids = bindingId ? [bindingId] : found.action.bindings.map((binding) => binding.id);
		let changed = false;
		for (const id of ids) {
			changed = this._bindingOverrides.delete(id) || changed;
		}
		if (changed) {
			this.update(0);
		}
		return changed;
	}

	public saveBindingOverrides(): string {
		const overrides: IBindingOverrideRecord[] = [];
		for (const map of this._maps) {
			for (const action of map.actions) {
				for (const binding of action.bindings) {
					const path = this._bindingOverrides.get(binding.id);
					if (path) {
						overrides.push({ mapId: map.id, actionId: action.id, bindingId: binding.id, path });
					}
				}
			}
		}
		return JSON.stringify({ version: 1, overrides });
	}

	public loadBindingOverrides(json: string, replace = true): number {
		if (json.length > 1_048_576) {
			throw new Error("Input binding override JSON exceeds 1 MiB.");
		}
		let parsed: any;
		try {
			parsed = JSON.parse(json);
		} catch {
			throw new Error("Input binding overrides must be valid JSON.");
		}
		if (parsed?.version !== 1 || !Array.isArray(parsed.overrides) || parsed.overrides.length > 4096) {
			throw new Error("Input binding overrides require version 1 and at most 4,096 entries.");
		}
		const next = replace ? new Map<string, string>() : new Map(this._bindingOverrides);
		for (const override of parsed.overrides) {
			const map = this._maps.find((candidate) => candidate.id === override?.mapId);
			const action = map?.actions.find((candidate) => candidate.id === override?.actionId);
			const binding = action?.bindings.find((candidate) => candidate.id === override?.bindingId);
			if (!binding || typeof override.path !== "string" || !override.path.trim() || override.path.length > 512) {
				throw new Error("Input binding override references an unknown binding or invalid path.");
			}
			next.set(binding.id, override.path.trim());
		}
		this._bindingOverrides = next;
		this.update(0);
		return next.size;
	}

	public getTrace(offset = 0, limit = this._settings.maxTraceEvents): { total: number; offset: number; events: IInputActionEvent[] } {
		const safeOffset = Math.max(0, Math.min(this._trace.length, Math.floor(offset)));
		const safeLimit = Math.max(1, Math.min(this._settings.maxTraceEvents, Math.floor(limit)));
		return { total: this._trace.length, offset: safeOffset, events: structuredClone(this._trace.slice(safeOffset, safeOffset + safeLimit)) };
	}

	public clearTrace(): number {
		const count = this._trace.length;
		this._trace = [];
		return count;
	}

	public getMaps(): IInputActionMapDefinition[] {
		const result = structuredClone(this._maps);
		for (const map of result) {
			for (const action of map.actions) {
				for (const binding of action.bindings) {
					const override = this._bindingOverrides.get(binding.id);
					if (override) {
						binding.path = override;
					}
				}
			}
		}
		return result;
	}

	public getSettings(): IInputSystemSettings {
		return structuredClone(this._settings);
	}

	/** Captures the next keyboard key as a non-destructive binding override. */
	public rebindNextKey(mapName: string, actionName: string, bindingIndex?: number, timeoutSeconds = 10): Promise<string | null> {
		const found = this._findAction(mapName, actionName);
		if (!found) {
			return Promise.resolve(null);
		}
		return this._captureEventBinding(
			"keydown",
			found,
			bindingIndex,
			(event) => {
				const keyboard = event as KeyboardEvent;
				const key = keyboard.code || keyboard.key;
				return key ? `<keyboard>/${key.toLowerCase()}` : null;
			},
			timeoutSeconds
		);
	}

	/** Captures the next gamepad button or signed axis over threshold as a runtime override. */
	public rebindNextGamepad(mapName: string, actionName: string, bindingIndex?: number, threshold = 0.5, timeoutSeconds = 10): Promise<string | null> {
		const found = this._findAction(mapName, actionName);
		if (!found || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1 || !(timeoutSeconds > 0 && timeoutSeconds <= 60)) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			let finished = false;
			let interval: ReturnType<typeof globalThis.setInterval> | undefined;
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			let cleanup = (): void => undefined;
			const complete = (binding: string | null): void => {
				if (finished) {
					return;
				}
				finished = true;
				if (interval !== undefined) {
					globalThis.clearInterval(interval);
				}
				if (timeout !== undefined) {
					globalThis.clearTimeout(timeout);
				}
				this._rebindCleanups.delete(cleanup);
				resolve(binding && this._setOverrideByIndex(found, bindingIndex, "gamepad", binding) ? binding : null);
			};
			interval = globalThis.setInterval(() => {
				for (const gamepad of this._gamepads()) {
					const button = gamepad.buttons.findIndex((value) => value.value >= threshold);
					if (button >= 0) {
						return complete(`<gamepad>/button${button}`);
					}
					const axis = gamepad.axes.findIndex((value) => Math.abs(value) >= threshold);
					if (axis >= 0) {
						return complete(`<gamepad>/axis${axis}`);
					}
				}
			}, 16);
			timeout = globalThis.setTimeout(() => complete(null), timeoutSeconds * 1000);
			cleanup = (): void => complete(null);
			this._rebindCleanups.add(cleanup);
		});
	}

	/** Captures the next primary touch as a runtime override. */
	public rebindNextTouch(
		mapName: string,
		actionName: string,
		bindingIndex?: number,
		binding: "press" | "position/x" | "position/y" = "press",
		timeoutSeconds = 10
	): Promise<string | null> {
		const found = this._findAction(mapName, actionName);
		if (!found) {
			return Promise.resolve(null);
		}
		return this._captureEventBinding(
			"pointerdown",
			found,
			bindingIndex,
			(event) => ((event as PointerEvent).pointerType === "touch" ? `<touch>/${binding}` : null),
			timeoutSeconds
		);
	}

	private _installListeners(): void {
		this._listen("keydown", (event) => {
			const keyboard = event as KeyboardEvent;
			this._pressed.add(keyboard.code.toLowerCase());
			this._pressed.add(keyboard.key.toLowerCase());
			this._notifyDeviceActivity("keyboard");
			this.update(0);
		});
		this._listen("keyup", (event) => {
			const keyboard = event as KeyboardEvent;
			this._pressed.delete(keyboard.code.toLowerCase());
			this._pressed.delete(keyboard.key.toLowerCase());
			this._notifyDeviceActivity("keyboard");
			this.update(0);
		});
		this._listen("mousedown", (event) => {
			this._mouseButtons.add((event as MouseEvent).button);
			this._updateMouse(event as MouseEvent);
		});
		this._listen("mouseup", (event) => {
			this._mouseButtons.delete((event as MouseEvent).button);
			this._updateMouse(event as MouseEvent);
		});
		this._listen("mousemove", (event) => this._updateMouse(event as MouseEvent));
		this._listen("wheel", (event) => {
			const wheel = event as WheelEvent;
			this._mouseScroll = [this._mouseScroll[0] + wheel.deltaX, this._mouseScroll[1] + wheel.deltaY];
			this._notifyDeviceActivity("mouse");
			this.update(0);
		});
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
			this._listen(type, (event) =>
				this._updateTouch(event as PointerEvent, type !== "pointerup" && type !== "pointercancel" ? this._touchPressed || type === "pointerdown" : false)
			);
		}
	}

	private _updateMouse(event: MouseEvent): void {
		const width = typeof globalThis.innerWidth === "number" && globalThis.innerWidth > 0 ? globalThis.innerWidth : 1;
		const height = typeof globalThis.innerHeight === "number" && globalThis.innerHeight > 0 ? globalThis.innerHeight : 1;
		this._mousePosition = [clampScalar(event.clientX / width, 0, 1), clampScalar(event.clientY / height, 0, 1)];
		this._mouseDelta = [this._mouseDelta[0] + (event.movementX ?? 0), this._mouseDelta[1] + (event.movementY ?? 0)];
		this._notifyDeviceActivity("mouse");
		this.update(0);
	}

	private _updateTouch(event: PointerEvent, pressed: boolean): void {
		if (event.pointerType !== "touch") {
			return;
		}
		const width = typeof globalThis.innerWidth === "number" && globalThis.innerWidth > 0 ? globalThis.innerWidth : 1;
		const height = typeof globalThis.innerHeight === "number" && globalThis.innerHeight > 0 ? globalThis.innerHeight : 1;
		const next: [number, number] = [clampScalar(event.clientX / width, 0, 1), clampScalar(event.clientY / height, 0, 1)];
		this._touchDelta = [next[0] - this._touchPosition[0], next[1] - this._touchPosition[1]];
		this._touchPosition = next;
		this._touchPressed = pressed;
		this._notifyDeviceActivity("touch");
		this.update(0);
	}

	private _evaluateAction(map: IInputActionMapDefinition, action: IInputActionDefinition): void {
		const state = this._states.get(action.id)!;
		const enabled = this._isEnabled(map, action);
		if (!enabled) {
			if (state.isPressed) {
				this._emit(map, action, state, "canceled", state.value, state.controlPath, state.device, state.interaction);
			}
			state.enabled = false;
			state.phase = "disabled";
			state.value = zeroValue(action.expectedControlType);
			state.isPressed = false;
			return;
		}
		state.enabled = true;
		const sample = this._sampleAction(map, action);
		const value = sample.value;
		const pressPoint = this._pressPoint(sample.interactions);
		const active = magnitude(value) >= (action.type === "button" ? pressPoint : 1e-6);
		const wasActive = state.isPressed;
		state.value = cloneValue(value);
		state.magnitude = magnitude(value);
		state.controlPath = sample.controlPath;
		state.device = sample.device;
		state.interaction = sample.interactions[0]?.type ?? null;
		if (!state.initialized) {
			state.initialized = true;
			state.previousValue = cloneValue(value);
			state.isPressed = active;
			state.suppressedUntilRelease = active && !action.initialStateCheck;
			if (!action.initialStateCheck) {
				return;
			}
		}
		if (state.suppressedUntilRelease) {
			state.previousValue = cloneValue(value);
			state.isPressed = active;
			if (!active) {
				state.suppressedUntilRelease = false;
			}
			return;
		}

		if (sample.interactions.length) {
			this._evaluateInteractions(map, action, state, sample, active, wasActive);
		} else {
			this._evaluateDefaultInteraction(map, action, state, sample, active, wasActive);
		}
		state.previousValue = cloneValue(value);
		state.isPressed = active;
	}

	private _evaluateDefaultInteraction(
		map: IInputActionMapDefinition,
		action: IInputActionDefinition,
		state: IActionState,
		sample: ISampledAction,
		active: boolean,
		wasActive: boolean
	): void {
		const changed = !valuesEqual(sample.value, state.previousValue);
		if (action.type === "passThrough") {
			if (changed) {
				this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, null);
			} else if (state.phase === "canceled") {
				state.phase = "waiting";
			}
			return;
		}
		if (active && !wasActive) {
			state.pressedAt = this._time;
			this._emit(map, action, state, "started", sample.value, sample.controlPath, sample.device, null);
			this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, null);
		} else if (active && changed && action.type === "value") {
			this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, null);
		} else if (!active && wasActive) {
			this._emit(map, action, state, "canceled", sample.value, sample.controlPath, sample.device, null);
			state.pressedAt = null;
		} else if (!active && state.phase === "canceled") {
			state.phase = "waiting";
		}
	}

	private _evaluateInteractions(
		map: IInputActionMapDefinition,
		action: IInputActionDefinition,
		state: IActionState,
		sample: ISampledAction,
		active: boolean,
		wasActive: boolean
	): void {
		if (active && !wasActive) {
			state.pressedAt = this._time;
			state.holdPerformed = false;
			this._emit(map, action, state, "started", sample.value, sample.controlPath, sample.device, sample.interactions[0].type);
			for (const interaction of sample.interactions) {
				if (interaction.type === "press" && (interaction.behavior ?? "pressOnly") !== "releaseOnly") {
					this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, interaction.type);
				}
			}
		}
		if (active && state.pressedAt !== null) {
			for (const interaction of sample.interactions) {
				if (interaction.type === "hold" && !state.holdPerformed && this._time - state.pressedAt >= (interaction.duration ?? this._settings.defaultHoldTime)) {
					state.holdPerformed = true;
					this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, interaction.type);
				}
			}
		}
		if (!active && wasActive) {
			const held = this._time - (state.pressedAt ?? this._time);
			let performed = false;
			for (const interaction of sample.interactions) {
				if (interaction.type === "press" && (interaction.behavior === "releaseOnly" || interaction.behavior === "pressAndRelease")) {
					this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, interaction.type);
					performed = true;
				} else if (interaction.type === "tap" && held <= (interaction.duration ?? this._settings.defaultTapTime)) {
					this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, interaction.type);
					performed = true;
				} else if (interaction.type === "slowTap" && held >= (interaction.duration ?? this._settings.defaultSlowTapTime)) {
					this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, interaction.type);
					performed = true;
				} else if (interaction.type === "multiTap" && held <= (interaction.duration ?? this._settings.defaultTapTime)) {
					const delay = interaction.tapDelay ?? this._settings.defaultMultiTapDelay;
					state.tapCount = state.lastTapAt !== null && this._time - state.lastTapAt <= delay ? state.tapCount + 1 : 1;
					state.lastTapAt = this._time;
					if (state.tapCount >= (interaction.tapCount ?? 2)) {
						this._emit(map, action, state, "performed", sample.value, sample.controlPath, sample.device, interaction.type);
						state.tapCount = 0;
						performed = true;
					}
				}
			}
			this._emit(map, action, state, "canceled", sample.value, sample.controlPath, sample.device, performed ? state.interaction : sample.interactions[0].type);
			state.pressedAt = null;
			state.holdPerformed = false;
		} else if (!active && state.phase === "canceled") {
			state.phase = "waiting";
		}
	}

	private _sampleAction(map: IInputActionMapDefinition, action: IInputActionDefinition): ISampledAction {
		let winner: ISampledAction = { value: zeroValue(action.expectedControlType), controlPath: null, device: null, interactions: action.interactions };
		for (const binding of action.bindings) {
			if (!this._bindingMatchesScheme(map, binding)) {
				continue;
			}
			const sampled = binding.composite ? this._sampleComposite(binding.composite) : this._samplePath(this._bindingOverrides.get(binding.id) ?? binding.path ?? "");
			const processed = coerceValue(applyProcessors(sampled.value, binding.processors ?? [], this._settings), action.expectedControlType);
			if (magnitude(processed) > magnitude(winner.value) || winner.controlPath === null) {
				winner = {
					value: processed,
					controlPath: sampled.controlPath,
					device: sampled.device,
					interactions: [...(binding.interactions ?? []), ...action.interactions],
				};
			}
		}
		winner.value = coerceValue(applyProcessors(winner.value, action.processors, this._settings), action.expectedControlType);
		return winner;
	}

	private _sampleComposite(composite: IInputCompositeDefinition): ISampledAction {
		const parts = new Map(composite.parts.map((part) => [part.name.trim().toLowerCase(), this._samplePath(part.path)]));
		const scalar = (name: string): number => {
			const value = parts.get(name)?.value ?? 0;
			return Array.isArray(value) ? magnitude(value) : value;
		};
		let value: InputActionValue;
		switch (composite.type) {
			case "axis1d":
				value = scalar("positive") - scalar("negative");
				break;
			case "vector2":
				value = [scalar("right") - scalar("left"), scalar("up") - scalar("down")];
				break;
			case "vector3":
				value = [scalar("right") - scalar("left"), scalar("up") - scalar("down"), scalar("forward") - scalar("back")];
				break;
			case "oneModifier":
				value = magnitude(parts.get("modifier")?.value ?? 0) >= this._settings.defaultButtonPressPoint ? cloneValue(parts.get("binding")?.value ?? 0) : 0;
				break;
			case "twoModifiers":
				value =
					magnitude(parts.get("modifier1")?.value ?? 0) >= this._settings.defaultButtonPressPoint &&
					magnitude(parts.get("modifier2")?.value ?? 0) >= this._settings.defaultButtonPressPoint
						? cloneValue(parts.get("binding")?.value ?? 0)
						: 0;
				break;
		}
		if (composite.normalize !== false && Array.isArray(value) && magnitude(value) > 1) {
			value = normalizeVector(value);
		}
		const active = [...parts.entries()].sort((left, right) => magnitude(right[1].value) - magnitude(left[1].value))[0]?.[1];
		return { value, controlPath: active?.controlPath ?? null, device: active?.device ?? null, interactions: [] };
	}

	private _samplePath(path: string): { value: InputActionValue; controlPath: string | null; device: InputDeviceType | null } {
		if (!path) {
			return { value: 0, controlPath: null, device: null };
		}
		const normalized = normalizedPath(path);
		const simulated = this._simulatedControls.get(normalized);
		if (simulated !== undefined) {
			return { value: cloneValue(simulated), controlPath: path, device: getInputBindingDevice(path) };
		}
		const match = normalized.match(/^<([^>]+)>\/(.*)$/);
		const device = getInputBindingDevice(path);
		const control = match?.[2] ?? normalized;
		switch (device) {
			case "keyboard":
				return { value: this._readKeyboard(control), controlPath: path, device };
			case "mouse":
				return { value: this._readMouse(control), controlPath: path, device };
			case "touch":
				return { value: this._readTouch(control), controlPath: path, device };
			case "gamepad":
				return { value: this._readGamepad(control), controlPath: path, device };
		}
	}

	private _readKeyboard(control: string): number {
		const normalized = control.toLowerCase();
		if (normalized === "anykey") {
			return this._pressed.size ? 1 : 0;
		}
		const aliases = [normalized, normalized.replace(/^key/, ""), `key${normalized}`];
		if (normalized === "space") {
			aliases.push(" ");
		}
		return aliases.some((key) => this._pressed.has(key)) ? 1 : 0;
	}

	private _readMouse(control: string): InputActionValue {
		switch (control.toLowerCase()) {
			case "leftbutton":
				return this._mouseButtons.has(0) ? 1 : 0;
			case "middlebutton":
				return this._mouseButtons.has(1) ? 1 : 0;
			case "rightbutton":
				return this._mouseButtons.has(2) ? 1 : 0;
			case "position":
				return [...this._mousePosition];
			case "position/x":
				return this._mousePosition[0];
			case "position/y":
				return this._mousePosition[1];
			case "delta":
				return [...this._mouseDelta];
			case "delta/x":
				return this._mouseDelta[0];
			case "delta/y":
				return this._mouseDelta[1];
			case "scroll":
				return [...this._mouseScroll];
			case "scroll/x":
				return this._mouseScroll[0];
			case "scroll/y":
				return this._mouseScroll[1];
			default:
				return 0;
		}
	}

	private _readTouch(control: string): InputActionValue {
		switch (control.toLowerCase()) {
			case "position":
				return [...this._touchPosition];
			case "position/x":
			case "x":
				return this._touchPosition[0];
			case "position/y":
			case "y":
				return this._touchPosition[1];
			case "delta":
				return [...this._touchDelta];
			case "delta/x":
				return this._touchDelta[0];
			case "delta/y":
				return this._touchDelta[1];
			default:
				return this._touchPressed ? 1 : 0;
		}
	}

	private _readGamepad(control: string): InputActionValue {
		const path = control.toLowerCase();
		let winner: InputActionValue = path === "leftstick" || path === "rightstick" || path === "dpad" ? [0, 0] : 0;
		for (const gamepad of this._gamepads()) {
			let value: InputActionValue = 0;
			if (gamepadButtons[path] !== undefined) {
				value = gamepad.buttons[gamepadButtons[path]]?.value ?? 0;
			} else if (/^button\d+$/.test(path)) {
				value = gamepad.buttons[Number(path.slice(6))]?.value ?? 0;
			} else if (/^axis\d+$/.test(path)) {
				value = gamepad.axes[Number(path.slice(4))] ?? 0;
			} else if (path === "leftstick") {
				value = [gamepad.axes[0] ?? 0, gamepad.axes[1] ?? 0];
			} else if (path === "rightstick") {
				value = [gamepad.axes[2] ?? 0, gamepad.axes[3] ?? 0];
			} else if (path === "leftstick/x") {
				value = gamepad.axes[0] ?? 0;
			} else if (path === "leftstick/y") {
				value = gamepad.axes[1] ?? 0;
			} else if (path === "rightstick/x") {
				value = gamepad.axes[2] ?? 0;
			} else if (path === "rightstick/y") {
				value = gamepad.axes[3] ?? 0;
			} else if (path === "dpad") {
				value = [(gamepad.buttons[15]?.value ?? 0) - (gamepad.buttons[14]?.value ?? 0), (gamepad.buttons[12]?.value ?? 0) - (gamepad.buttons[13]?.value ?? 0)];
			}
			if (magnitude(value) > magnitude(winner)) {
				winner = value;
			}
		}
		return winner;
	}

	private _bindingMatchesScheme(map: IInputActionMapDefinition, binding: IInputBindingDefinition): boolean {
		const id = this._activeSchemes.get(map.id) ?? map.controlSchemes[0]?.id;
		const active = map.controlSchemes.find((scheme) => scheme.id === id);
		if (!active) {
			return true;
		}
		if (binding.groups?.length && !binding.groups.some((group) => group.toLowerCase() === active.name.toLowerCase() || group === active.id)) {
			return false;
		}
		const devices = binding.composite ? new Set(binding.composite.parts.map((part) => getInputBindingDevice(part.path))) : new Set([getInputBindingDevice(binding.path ?? "")]);
		return [...devices].some((device) => active.devices.includes(device));
	}

	private _pressPoint(interactions: readonly IInputInteractionDefinition[]): number {
		return interactions.find((interaction) => interaction.pressPoint !== undefined)?.pressPoint ?? this._settings.defaultButtonPressPoint;
	}

	// eslint-disable-next-line max-params -- action events preserve the complete authored/runtime identity at each call site.
	private _emit(
		map: IInputActionMapDefinition,
		action: IInputActionDefinition,
		state: IActionState,
		phase: InputActionPhase,
		value: InputActionValue,
		controlPath: string | null,
		device: InputDeviceType | null,
		interaction: string | null
	): void {
		state.phase = phase;
		if (phase === "started") {
			state.startedAt = this._time;
			state.wasPressedThisUpdate = true;
		} else if (phase === "performed") {
			state.performedAt = this._time;
			state.wasPerformedThisUpdate = true;
			state.triggerCount++;
		} else if (phase === "canceled") {
			state.canceledAt = this._time;
			state.wasReleasedThisUpdate = true;
		}
		const event: IInputActionEvent = {
			sequence: ++this._sequence,
			time: this._time,
			mapId: map.id,
			mapName: map.name,
			actionId: action.id,
			actionName: action.name,
			phase,
			value: cloneValue(value),
			controlPath,
			device,
			interaction,
		};
		this._trace.push(event);
		if (this._trace.length > this._settings.maxTraceEvents) {
			this._trace.splice(0, this._trace.length - this._settings.maxTraceEvents);
		}
		this.onActionObservable.notifyObservers(event);
	}

	private _ensureStates(): void {
		for (const map of this._maps) {
			for (const action of map.actions) {
				const value = zeroValue(action.expectedControlType);
				this._states.set(action.id, {
					initialized: false,
					suppressedUntilRelease: false,
					mapId: map.id,
					mapName: map.name,
					actionId: action.id,
					actionName: action.name,
					type: action.type,
					expectedControlType: action.expectedControlType,
					enabled: this._isEnabled(map, action),
					phase: this._isEnabled(map, action) ? "waiting" : "disabled",
					value,
					previousValue: cloneValue(value),
					magnitude: 0,
					isPressed: false,
					wasPressedThisUpdate: false,
					wasReleasedThisUpdate: false,
					wasPerformedThisUpdate: false,
					controlPath: null,
					device: null,
					interaction: null,
					startedAt: null,
					performedAt: null,
					canceledAt: null,
					triggerCount: 0,
					pressedAt: null,
					tapCount: 0,
					lastTapAt: null,
					holdPerformed: false,
				});
			}
		}
	}

	private _notifyDeviceActivity(device: InputDeviceType): void {
		this._lastUsedDevice = device;
		if (!this._settings.autoSwitchControlScheme) {
			return;
		}
		for (const map of this._maps) {
			const scheme = map.controlSchemes.find((candidate) => candidate.devices.includes(device));
			if (scheme) {
				this._activeSchemes.set(map.id, scheme.id);
			}
		}
	}

	private _captureEventBinding(
		type: string,
		found: { map: IInputActionMapDefinition; action: IInputActionDefinition },
		bindingIndex: number | undefined,
		read: (event: Event) => string | null,
		timeoutSeconds: number
	): Promise<string | null> {
		if (!(timeoutSeconds > 0 && timeoutSeconds <= 60)) {
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			let finished = false;
			let listener: EventListener = (): void => undefined;
			let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
			let cleanup = (): void => undefined;
			const complete = (binding: string | null): void => {
				if (finished) {
					return;
				}
				finished = true;
				this._target.removeEventListener(type, listener);
				if (timeout !== undefined) {
					globalThis.clearTimeout(timeout);
				}
				this._rebindCleanups.delete(cleanup);
				resolve(binding && this._setOverrideByIndex(found, bindingIndex, getInputBindingDevice(binding), binding) ? binding : null);
			};
			listener = (event: Event): void => {
				const binding = read(event);
				if (binding) {
					complete(binding);
				}
			};
			timeout = globalThis.setTimeout(() => complete(null), timeoutSeconds * 1000);
			cleanup = (): void => complete(null);
			this._rebindCleanups.add(cleanup);
			this._target.addEventListener(type, listener);
		});
	}

	private _setOverrideByIndex(
		found: { map: IInputActionMapDefinition; action: IInputActionDefinition },
		bindingIndex: number | undefined,
		device: InputDeviceType,
		path: string
	): boolean {
		const index =
			bindingIndex ??
			found.action.bindings.findIndex((binding) => !binding.composite && getInputBindingDevice(this._bindingOverrides.get(binding.id) ?? binding.path ?? "") === device);
		const fallbackIndex = found.action.bindings.findIndex((binding) => !binding.composite);
		const binding = found.action.bindings[index >= 0 ? index : fallbackIndex];
		if (!binding || binding.composite) {
			return false;
		}
		this._bindingOverrides.set(binding.id, path);
		this.update(0);
		return true;
	}

	private _prepareForEnable(action: IInputActionDefinition): void {
		const state = this._states.get(action.id);
		if (!state) {
			return;
		}
		state.initialized = false;
		state.suppressedUntilRelease = false;
		state.phase = "waiting";
		state.isPressed = false;
		state.previousValue = zeroValue(action.expectedControlType);
		state.pressedAt = null;
		state.holdPerformed = false;
	}

	private _isEnabled(map: IInputActionMapDefinition, action: IInputActionDefinition): boolean {
		return (this._mapEnableOverrides.get(map.id) ?? map.enabled) && (this._actionEnableOverrides.get(action.id) ?? action.enabled);
	}

	private _findMap(identifier: string): IInputActionMapDefinition | undefined {
		return this._maps.find((map) => map.id === identifier || map.name === identifier);
	}

	private _findAction(mapIdentifier: string, actionIdentifier: string): { map: IInputActionMapDefinition; action: IInputActionDefinition } | null {
		const map = this._findMap(mapIdentifier);
		const action = map?.actions.find((candidate) => candidate.id === actionIdentifier || candidate.name === actionIdentifier);
		return map && action ? { map, action } : null;
	}

	private _gamepads(): Gamepad[] {
		return typeof navigator !== "undefined" && typeof navigator.getGamepads === "function"
			? Array.from(navigator.getGamepads()).filter((gamepad): gamepad is Gamepad => !!gamepad)
			: [];
	}

	private _validValue(value: InputActionValue): boolean {
		return typeof value === "number" ? Number.isFinite(value) : (value.length === 2 || value.length === 3) && value.every(Number.isFinite);
	}

	private _listen(type: string, listener: EventListener): void {
		this._listeners.push({ type, listener });
		this._target.addEventListener(type, listener);
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		inputActions?: InputActions;
	}
}

/** Attaches normalized authored maps to one scene using the selected update cadence. */
export function configureInputActions(scene: Scene): InputActions | undefined {
	const authored = scene.metadata?.babylonEditorInputActionMaps;
	if (!Array.isArray(authored) || typeof globalThis.addEventListener !== "function") {
		return undefined;
	}
	const maps = normalizeInputActionMaps(authored);
	const settings = normalizeInputSystemSettings(scene.metadata?.babylonEditorInputSystemSettings);
	validateInputActionMaps(maps);
	validateInputSystemSettings(settings);
	const runtime = new InputActions(maps, globalThis, settings);
	try {
		if (settings.updateMode !== "manual") {
			const observable =
				settings.updateMode === "fixed" ? ((scene as any).onBeforePhysicsObservable ?? scene.onBeforeAnimationsObservable) : scene.onBeforeAnimationsObservable;
			const observer = observable.add(() => runtime.update(Math.min(Math.max(scene.getEngine().getDeltaTime() / 1000, 0), 1)));
			runtime.addDisposeCallback(() => observable.remove(observer));
		}
		const disposeObserver = scene.onDisposeObservable.add(() => runtime.dispose());
		runtime.addDisposeCallback(() => scene.onDisposeObservable.remove(disposeObserver));
	} catch (error) {
		runtime.dispose();
		throw error;
	}
	const previous = scene.inputActions;
	scene.inputActions = runtime;
	previous?.dispose();
	return runtime;
}
