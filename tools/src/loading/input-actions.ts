import { Scene } from "@babylonjs/core/scene";

export interface IInputActionDefinition {
	name: string;
	type?: "button" | "value" | "passThrough";
	bindings?: string[];
}

export interface IInputActionMapDefinition {
	id: string;
	name: string;
	actions: IInputActionDefinition[];
	controlSchemes?: Array<{ name: string; devices: Array<"keyboard" | "gamepad" | "touch"> }>;
}

function keyVariants(key: string): string[] {
	const upper = key.length === 1 ? key.toUpperCase() : key;
	return [key.toLowerCase(), `keyboard/${key.toLowerCase()}`, `keyboard/${upper.toLowerCase()}`, `<keyboard>/${upper.toLowerCase()}`];
}

const gamepadButtons: Record<string, number> = {
	buttonSouth: 0,
	buttonEast: 1,
	buttonWest: 2,
	buttonNorth: 3,
	leftShoulder: 4,
	rightShoulder: 5,
	leftTrigger: 6,
	rightTrigger: 7,
	select: 8,
	start: 9,
	leftStick: 10,
	rightStick: 11,
	dpadUp: 12,
	dpadDown: 13,
	dpadLeft: 14,
	dpadRight: 15,
};

function gamepadValue(binding: string): number {
	const path = binding
		.toLowerCase()
		.replace(/^<gamepad>\//, "")
		.replace(/^gamepad\//, "");
	const gamepads = typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
	let value = 0;
	for (const gamepad of Array.from(gamepads)) {
		if (!gamepad) continue;
		const buttonName = Object.keys(gamepadButtons).find((name) => name.toLowerCase() === path);
		if (buttonName) value = Math.max(value, gamepad.buttons[gamepadButtons[buttonName]]?.value ?? 0);
		else if (/^button\d+$/.test(path)) value = Math.max(value, gamepad.buttons[Number(path.slice(6))]?.value ?? 0);
		else if (/^(axis|leftstick\/x|leftstick\/y|rightstick\/x|rightstick\/y)/.test(path)) {
			const axis = path === "leftstick/x" ? 0 : path === "leftstick/y" ? 1 : path === "rightstick/x" ? 2 : path === "rightstick/y" ? 3 : Number(path.slice(4));
			value = Math.max(value, Math.abs(gamepad.axes[axis] ?? 0));
		}
	}
	return value;
}

function bindingDevice(binding: string): "keyboard" | "gamepad" | "touch" {
	const normalized = binding.toLowerCase();
	if (normalized.includes("gamepad")) return "gamepad";
	if (normalized.includes("touch")) return "touch";
	return "keyboard";
}

/** Runtime action-state API for input maps authored in the editor. */
export class InputActions {
	private _pressed = new Set<string>();
	private _activeSchemes = new Map<string, string>();
	private _target: EventTarget;
	private _touchPressed = false;
	private _touchX = 0;
	private _touchY = 0;

	public constructor(
		private _maps: IInputActionMapDefinition[],
		target: EventTarget
	) {
		this._target = target;
		target.addEventListener("keydown", (event: Event) => {
			const keyboard = event as KeyboardEvent;
			this._pressed.add(keyboard.code.toLowerCase());
			this._pressed.add(keyboard.key.toLowerCase());
		});
		target.addEventListener("keyup", (event: Event) => {
			const keyboard = event as KeyboardEvent;
			this._pressed.delete(keyboard.code.toLowerCase());
			this._pressed.delete(keyboard.key.toLowerCase());
		});
		target.addEventListener("pointerdown", (event: Event) => this._updateTouch(event, true));
		target.addEventListener("pointermove", (event: Event) => this._updateTouch(event, this._touchPressed));
		target.addEventListener("pointerup", (event: Event) => this._updateTouch(event, false));
		target.addEventListener("pointercancel", (event: Event) => this._updateTouch(event, false));
	}

	public isPressed(mapName: string, actionName: string): boolean {
		const map = this._maps.find((candidate) => candidate.name === mapName || candidate.id === mapName);
		const action = map?.actions.find((candidate) => candidate.name === actionName);
		return (
			action?.bindings?.some(
				(binding) =>
					this._bindingMatchesScheme(map, binding) &&
					(bindingDevice(binding) === "gamepad"
						? gamepadValue(binding) >= 0.5
						: bindingDevice(binding) === "touch"
							? this._touchValue(binding) >= 0.5
							: keyVariants(binding.split("/").pop() ?? binding).some((key) => this._pressed.has(key)))
			) ?? false
		);
	}

	/** Returns the strongest normalized value from keyboard/gamepad bindings for a value action. */
	public getValue(mapName: string, actionName: string): number {
		const map = this._maps.find((candidate) => candidate.name === mapName || candidate.id === mapName);
		const action = map?.actions.find((candidate) => candidate.name === actionName);
		if (!action) return 0;
		return Math.max(
			0,
			...(action.bindings ?? []).map((binding) =>
				this._bindingMatchesScheme(map, binding)
					? bindingDevice(binding) === "gamepad"
						? gamepadValue(binding)
						: bindingDevice(binding) === "touch"
							? this._touchValue(binding)
							: keyVariants(binding.split("/").pop() ?? binding).some((key) => this._pressed.has(key))
								? 1
								: 0
					: 0
			)
		);
	}

	/** Activates one persisted control scheme for an input map; returns false when either identifier is unknown. */
	public setControlScheme(mapName: string, schemeName: string): boolean {
		const map = this._maps.find((candidate) => candidate.name === mapName || candidate.id === mapName);
		if (!map?.controlSchemes?.some((scheme) => scheme.name === schemeName)) return false;
		this._activeSchemes.set(map.id, schemeName);
		return true;
	}

	public getControlScheme(mapName: string): string | null {
		const map = this._maps.find((candidate) => candidate.name === mapName || candidate.id === mapName);
		return map ? (this._activeSchemes.get(map.id) ?? map.controlSchemes?.[0]?.name ?? null) : null;
	}

	/** Captures the next keyboard key and replaces one action binding. The updated map remains available through getMaps(). */
	public rebindNextKey(mapName: string, actionName: string, bindingIndex?: number): Promise<string | null> {
		const map = this._maps.find((candidate) => candidate.name === mapName || candidate.id === mapName);
		const action = map?.actions.find((candidate) => candidate.name === actionName);
		if (!action) return Promise.resolve(null);
		return new Promise((resolve) => {
			const listener = (event: Event): void => {
				const keyboard = event as KeyboardEvent;
				const key = keyboard.code || keyboard.key;
				if (!key) return;
				const bindings = (action.bindings ??= []);
				const index = bindingIndex ?? bindings.findIndex((binding) => !binding.toLowerCase().includes("gamepad"));
				bindings[index < 0 ? bindings.length : index] = `<keyboard>/${key.toLowerCase()}`;
				this._target.removeEventListener("keydown", listener);
				resolve(`<keyboard>/${key.toLowerCase()}`);
			};
			this._target.addEventListener("keydown", listener);
		});
	}

	/** Captures the next gamepad button or axis over threshold and replaces one action binding. */
	public rebindNextGamepad(mapName: string, actionName: string, bindingIndex?: number, threshold: number = 0.5): Promise<string | null> {
		const map = this._maps.find((candidate) => candidate.name === mapName || candidate.id === mapName);
		const action = map?.actions.find((candidate) => candidate.name === actionName);
		if (!action || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1) return Promise.resolve(null);
		return new Promise((resolve) => {
			const interval = globalThis.setInterval(() => {
				const gamepads = typeof navigator !== "undefined" && typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
				let binding: string | null = null;
				for (const gamepad of Array.from(gamepads)) {
					if (!gamepad) continue;
					const button = gamepad.buttons.findIndex((value) => value.value >= threshold);
					if (button >= 0) binding = `<gamepad>/button${button}`;
					else {
						const axis = gamepad.axes.findIndex((value) => Math.abs(value) >= threshold);
						if (axis >= 0) binding = `<gamepad>/axis${axis}`;
					}
					if (binding) break;
				}
				if (!binding) return;
				const bindings = (action.bindings ??= []);
				const index = bindingIndex ?? bindings.findIndex((value) => value.toLowerCase().includes("gamepad"));
				bindings[index < 0 ? bindings.length : index] = binding;
				globalThis.clearInterval(interval);
				resolve(binding);
			}, 16);
		});
	}

	/** Captures the next touch and replaces one action binding with press or a normalized position axis. */
	public rebindNextTouch(mapName: string, actionName: string, bindingIndex?: number, binding: "press" | "position/x" | "position/y" = "press"): Promise<string | null> {
		const map = this._maps.find((candidate) => candidate.name === mapName || candidate.id === mapName);
		const action = map?.actions.find((candidate) => candidate.name === actionName);
		if (!action) return Promise.resolve(null);
		return new Promise((resolve) => {
			const listener = (event: Event): void => {
				const pointer = event as PointerEvent;
				if (pointer.pointerType !== "touch") return;
				const bindings = (action.bindings ??= []);
				const index = bindingIndex ?? bindings.findIndex((binding) => bindingDevice(binding) === "touch");
				const path = `<touch>/${binding}`;
				bindings[index < 0 ? bindings.length : index] = path;
				this._target.removeEventListener("pointerdown", listener);
				resolve(path);
			};
			this._target.addEventListener("pointerdown", listener);
		});
	}

	/** Injects a normalized touch state for preview/device simulation hosts. */
	public simulateTouch(pressed: boolean, x: number = this._touchX, y: number = this._touchY): boolean {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
		this._touchPressed = pressed;
		this._touchX = Math.min(1, Math.max(0, x));
		this._touchY = Math.min(1, Math.max(0, y));
		return true;
	}

	private _bindingMatchesScheme(map: IInputActionMapDefinition | undefined, binding: string): boolean {
		const active = map?.controlSchemes?.find((scheme) => scheme.name === (map ? (this._activeSchemes.get(map.id) ?? map.controlSchemes?.[0]?.name) : undefined));
		if (!active) return true;
		return active.devices.includes(bindingDevice(binding));
	}

	private _updateTouch(event: Event, pressed: boolean): void {
		const pointer = event as PointerEvent;
		if (pointer.pointerType !== "touch") return;
		this._touchPressed = pressed;
		const width = typeof globalThis.innerWidth === "number" && globalThis.innerWidth > 0 ? globalThis.innerWidth : 1;
		const height = typeof globalThis.innerHeight === "number" && globalThis.innerHeight > 0 ? globalThis.innerHeight : 1;
		this._touchX = Math.min(1, Math.max(0, pointer.clientX / width));
		this._touchY = Math.min(1, Math.max(0, pointer.clientY / height));
	}

	private _touchValue(binding: string): number {
		const path = binding
			.toLowerCase()
			.replace(/^<touch>\//, "")
			.replace(/^touch\//, "");
		if (path === "position/x" || path === "x") return this._touchX;
		if (path === "position/y" || path === "y") return this._touchY;
		return this._touchPressed ? 1 : 0;
	}

	public getMaps(): IInputActionMapDefinition[] {
		return this._maps;
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		inputActions?: InputActions;
	}
}

/** Attaches exported input maps to a scene when the host provides browser input events. */
export function configureInputActions(scene: Scene): void {
	const maps = scene.metadata?.babylonEditorInputActionMaps as IInputActionMapDefinition[] | undefined;
	if (maps && typeof globalThis.addEventListener === "function") scene.inputActions = new InputActions(maps, globalThis);
}
