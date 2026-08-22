import { Scene } from "@babylonjs/core/scene";

import { InputActionValue, InputActions } from "./input-actions";
import { ITouchControlDefinition, ITouchControlsConfiguration, normalizeTouchControlsConfiguration, validateTouchControlsConfiguration } from "./touch-controls-model";

export * from "./touch-controls-model";

export interface ITouchControlInputSink {
	simulateControl(path: string, value: InputActionValue): boolean;
	clearSimulatedControl(path: string): boolean;
}

export interface ITouchControlRuntimeState {
	id: string;
	name: string;
	type: ITouchControlDefinition["type"];
	controlPath: string;
	active: boolean;
	pointerId: number | null;
	value: InputActionValue;
}

interface IActivePointer {
	pointerId: number;
	value: InputActionValue;
}

function cloneValue(value: InputActionValue): InputActionValue {
	return Array.isArray(value) ? ([...value] as [number, number] | [number, number, number]) : value;
}

/** Owns multi-pointer state and translates normalized button/stick gestures into existing Input Actions controls. */
export class TouchControlInputController {
	private readonly _configuration: ITouchControlsConfiguration;
	private readonly _sink: ITouchControlInputSink;
	private readonly _active = new Map<string, IActivePointer>();

	public constructor(configuration: ITouchControlsConfiguration, sink: ITouchControlInputSink) {
		validateTouchControlsConfiguration(configuration);
		this._configuration = structuredClone(configuration);
		this._sink = sink;
	}

	/** Claims one free authored control for a pointer and immediately publishes its value. */
	public begin(controlId: string, pointerId: number, x: number, y: number): boolean {
		const control = this._control(controlId);
		if (!control || !Number.isSafeInteger(pointerId) || this._active.has(controlId) || [...this._active.values()].some((entry) => entry.pointerId === pointerId)) {
			return false;
		}
		const value = this._value(control, x, y);
		if (!this._sink.simulateControl(control.controlPath, value)) {
			return false;
		}
		this._active.set(controlId, { pointerId, value });
		return true;
	}

	/** Updates only the pointer that currently owns the control. */
	public move(controlId: string, pointerId: number, x: number, y: number): boolean {
		const control = this._control(controlId);
		const active = this._active.get(controlId);
		if (!control || !active || active.pointerId !== pointerId || control.type !== "stick") {
			return false;
		}
		const value = this._value(control, x, y);
		if (!this._sink.simulateControl(control.controlPath, value)) {
			return false;
		}
		active.value = value;
		return true;
	}

	/** Releases one exact pointer and removes its transient simulated control. */
	public end(controlId: string, pointerId: number): boolean {
		const control = this._control(controlId);
		const active = this._active.get(controlId);
		if (!control || !active || active.pointerId !== pointerId) {
			return false;
		}
		this._active.delete(controlId);
		this._sink.clearSimulatedControl(control.controlPath);
		return true;
	}

	/** Clears every pressed control so disposal, blur, and scene reload cannot leave stuck input. */
	public cancelAll(): number {
		const controls = new Map(this._configuration.controls.map((control) => [control.id, control]));
		const count = this._active.size;
		for (const id of this._active.keys()) {
			const control = controls.get(id);
			if (control) {
				this._sink.clearSimulatedControl(control.controlPath);
			}
		}
		this._active.clear();
		return count;
	}

	/** Returns bounded runtime evidence without exposing DOM nodes or event objects. */
	public status(): ITouchControlRuntimeState[] {
		return this._configuration.controls.map((control) => {
			const active = this._active.get(control.id);
			return {
				id: control.id,
				name: control.name,
				type: control.type,
				controlPath: control.controlPath,
				active: Boolean(active),
				pointerId: active?.pointerId ?? null,
				value: cloneValue(active?.value ?? (control.type === "stick" ? [0, 0] : 0)),
			};
		});
	}

	private _control(id: string): ITouchControlDefinition | undefined {
		return this._configuration.controls.find((control) => control.id === id);
	}

	private _value(control: ITouchControlDefinition, x: number, y: number): InputActionValue {
		if (control.type === "button") {
			return control.buttonValue;
		}
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			return [0, 0];
		}
		let dx = (Math.min(1, Math.max(0, x)) - 0.5) * 2;
		let dy = (0.5 - Math.min(1, Math.max(0, y))) * 2;
		if (control.stickAxis === "horizontal") {
			dy = 0;
		} else if (control.stickAxis === "vertical") {
			dx = 0;
		}
		const magnitude = Math.hypot(dx, dy);
		if (magnitude <= control.stickDeadzone) {
			return [0, 0];
		}
		const normalizedMagnitude = Math.min(1, (magnitude - control.stickDeadzone) / (1 - control.stickDeadzone));
		return [Number(((dx / magnitude) * normalizedMagnitude).toFixed(6)), Number(((dy / magnitude) * normalizedMagnitude).toFixed(6))];
	}
}

function pointerPosition(element: HTMLElement, event: PointerEvent): [number, number] {
	const rect = element.getBoundingClientRect();
	return [rect.width ? (event.clientX - rect.left) / rect.width : 0.5, rect.height ? (event.clientY - rect.top) / rect.height : 0.5];
}

/** DOM overlay bound to one scene/canvas and disposed with that scene. */
export class TouchControls {
	private readonly _scene: Scene;
	private readonly _configuration: ITouchControlsConfiguration;
	private readonly _controller: TouchControlInputController;
	private readonly _root: HTMLDivElement;
	private readonly _elements = new Map<string, HTMLButtonElement>();
	private readonly _beforeRenderObserver: unknown;
	private readonly _disposeObserver: unknown;
	private _disposed = false;

	public constructor(scene: Scene, configuration: ITouchControlsConfiguration, input: InputActions, canvas: HTMLCanvasElement) {
		this._scene = scene;
		this._configuration = structuredClone(configuration);
		this._controller = new TouchControlInputController(configuration, input);
		this._root = document.createElement("div");
		this._root.dataset.zvibeTouchControls = "v1";
		Object.assign(this._root.style, {
			position: "fixed",
			pointerEvents: "none",
			zIndex: "30",
			overflow: "hidden",
			boxSizing: "border-box",
			opacity: String(configuration.opacity),
			touchAction: "none",
			...(configuration.respectSafeArea ? { padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)" } : {}),
		});
		document.body.appendChild(this._root);
		for (const control of configuration.controls) {
			this._createElement(control);
		}
		this._syncCanvas(canvas);
		this._beforeRenderObserver = scene.onBeforeRenderObservable.add(() => this._syncCanvas(canvas));
		this._disposeObserver = scene.onDisposeObservable.add(() => this.dispose());
	}

	/** Returns authored/runtime state for diagnostics and editor previews. */
	public status(): { revision: number; enabled: boolean; controls: ITouchControlRuntimeState[] } {
		return { revision: this._configuration.revision, enabled: !this._disposed, controls: this._controller.status() };
	}

	/** Removes listeners/DOM and clears every simulated path exactly once. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._controller.cancelAll();
		this._scene.onBeforeRenderObservable.remove(this._beforeRenderObserver as never);
		this._scene.onDisposeObservable.remove(this._disposeObserver as never);
		this._elements.clear();
		this._root.remove();
		if (this._scene.touchControls === this) {
			delete this._scene.touchControls;
		}
	}

	private _createElement(control: ITouchControlDefinition): void {
		const element = document.createElement("button");
		element.type = "button";
		element.dataset.touchControlId = control.id;
		element.setAttribute("aria-label", control.name);
		element.textContent = control.type === "button" ? control.label : "";
		Object.assign(element.style, {
			position: "absolute",
			left: `${control.rect.x * 100}%`,
			top: `${control.rect.y * 100}%`,
			width: `${control.rect.width * 100}%`,
			height: `${control.rect.height * 100}%`,
			borderRadius: control.type === "stick" ? "50%" : "22%",
			border: "1px solid rgba(255,255,255,0.7)",
			background: control.backgroundColor,
			color: "white",
			font: "600 12px system-ui, sans-serif",
			pointerEvents: "auto",
			touchAction: "none",
			userSelect: "none",
			WebkitUserSelect: "none",
		});
		const end = (event: PointerEvent): void => {
			if (this._controller.end(control.id, event.pointerId)) {
				element.style.background = control.backgroundColor;
			}
		};
		element.addEventListener("pointerdown", (event) => {
			event.preventDefault();
			const [x, y] = pointerPosition(element, event);
			if (this._controller.begin(control.id, event.pointerId, x, y)) {
				element.setPointerCapture?.(event.pointerId);
				element.style.background = control.pressedColor;
			}
		});
		element.addEventListener("pointermove", (event) => {
			if (event.buttons) {
				const [x, y] = pointerPosition(element, event);
				this._controller.move(control.id, event.pointerId, x, y);
			}
		});
		element.addEventListener("pointerup", end);
		element.addEventListener("pointercancel", end);
		element.addEventListener("lostpointercapture", end);
		this._root.appendChild(element);
		this._elements.set(control.id, element);
	}

	private _syncCanvas(canvas: HTMLCanvasElement): void {
		const rect = canvas.getBoundingClientRect();
		const runtimeInsets = this._scene.mobileSystemRuntime;
		const padding =
			this._configuration.respectSafeArea && runtimeInsets && runtimeInsets.windowInsetsSource !== "none"
				? `${runtimeInsets.windowInsets.top}px ${runtimeInsets.windowInsets.right}px ${runtimeInsets.windowInsets.bottom}px ${runtimeInsets.windowInsets.left}px`
				: this._configuration.respectSafeArea
					? "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
					: "0px";
		Object.assign(this._root.style, {
			left: `${rect.left}px`,
			top: `${rect.top}px`,
			width: `${rect.width}px`,
			height: `${rect.height}px`,
			display: rect.width && rect.height ? "block" : "none",
			padding,
		});
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		touchControls?: TouchControls;
	}
}

/** Replaces one scene-owned overlay, or removes it when authoring is disabled/unavailable. */
export function configureTouchControls(scene: Scene, options?: { editor?: boolean }): TouchControls | undefined {
	const configuration = normalizeTouchControlsConfiguration(scene.metadata?.babylonEditorTouchControls);
	validateTouchControlsConfiguration(configuration);
	const previous = scene.touchControls;
	if (!configuration.enabled || (options?.editor && !configuration.visibleInEditor) || !configuration.controls.length || !scene.inputActions || typeof document === "undefined") {
		previous?.dispose();
		return undefined;
	}
	const canvas = scene.getEngine().getRenderingCanvas();
	if (typeof HTMLCanvasElement === "undefined" || !(canvas instanceof HTMLCanvasElement)) {
		previous?.dispose();
		return undefined;
	}
	const runtime = new TouchControls(scene, configuration, scene.inputActions, canvas);
	scene.touchControls = runtime;
	previous?.dispose();
	return runtime;
}
