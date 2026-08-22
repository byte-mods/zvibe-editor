import { Scene } from "babylonjs";
import {
	configureInputActions,
	configureTouchControls,
	createTouchControlId,
	InputActionValue,
	ITouchControlDefinition,
	ITouchControlsConfiguration,
	normalizeInputActionMaps,
	normalizeTouchControlsConfiguration,
	validateTouchControlsConfiguration,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";

const configurationFields = ["enabled", "visibleInEditor", "respectSafeArea", "opacity"];
const controlFields = ["name", "type", "controlPath", "label", "rect", "backgroundColor", "pressedColor", "buttonValue", "stickDeadzone", "stickAxis"];
const rectFields = ["x", "y", "width", "height"];

interface ITouchControlsSnapshot {
	hadMetadata: boolean;
	hadConfiguration: boolean;
	configuration: unknown;
}

function assertRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function assertControlChanges(value: unknown, label: string): asserts value is Record<string, unknown> {
	assertRecord(value, controlFields, label);
	if (!Object.keys(value).length) {
		throw new Error(`${label} must contain at least one field.`);
	}
	if (value.rect !== undefined) {
		assertRecord(value.rect, rectFields, `${label} rect`);
		for (const [key, entry] of Object.entries(value.rect)) {
			if (typeof entry !== "number" || !Number.isFinite(entry)) {
				throw new Error(`${label} rect.${key} must be a finite number.`);
			}
		}
	}
	for (const key of ["name", "controlPath", "label", "backgroundColor", "pressedColor"] as const) {
		if (value[key] !== undefined && typeof value[key] !== "string") {
			throw new Error(`${label} ${key} must be a string.`);
		}
	}
	for (const key of ["buttonValue", "stickDeadzone"] as const) {
		if (value[key] !== undefined && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
			throw new Error(`${label} ${key} must be a finite number.`);
		}
	}
	if (value.type !== undefined && value.type !== "button" && value.type !== "stick") {
		throw new Error(`${label} type must be button or stick.`);
	}
	if (value.stickAxis !== undefined && !["both", "horizontal", "vertical"].includes(String(value.stickAxis))) {
		throw new Error(`${label} stickAxis must be both, horizontal, or vertical.`);
	}
}

function assertRevision(configuration: ITouchControlsConfiguration, expectedRevision: unknown): void {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== configuration.revision) {
		throw new Error(`Touch Controls revision is stale: expected ${String(expectedRevision)}, current ${configuration.revision}.`);
	}
}

function snapshot(scene: Scene): ITouchControlsSnapshot {
	return {
		hadMetadata: Boolean(scene.metadata),
		hadConfiguration: Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, "babylonEditorTouchControls")),
		configuration: structuredClone(scene.metadata?.babylonEditorTouchControls),
	};
}

function runtimeScene(scene: Scene): Parameters<typeof configureTouchControls>[0] {
	return scene as unknown as Parameters<typeof configureTouchControls>[0];
}

function inputRuntime(scene: Scene): import("babylonjs-editor-tools").InputActions | undefined {
	return (scene as any).inputActions;
}

function refresh(scene: Scene, options: IMCPActionOptions): void {
	if (inputRuntime(scene)) {
		configureTouchControls(runtimeScene(scene), { editor: true });
	}
	options.editor.layout.inspector?.setEditedObject?.(scene);
	options.editor.layout.inspector?.forceUpdate?.();
	(options.editor.layout as any).mobile?.forceUpdate?.();
}

function restore(scene: Scene, value: ITouchControlsSnapshot, options: IMCPActionOptions): void {
	if (value.hadConfiguration) {
		scene.metadata ??= {};
		scene.metadata.babylonEditorTouchControls = structuredClone(value.configuration);
	} else if (scene.metadata) {
		delete scene.metadata.babylonEditorTouchControls;
		if (!value.hadMetadata && Object.keys(scene.metadata).length === 0) {
			scene.metadata = null;
		}
	}
	refresh(scene, options);
}

function publish(scene: Scene, previous: ITouchControlsSnapshot, next: ITouchControlsConfiguration, options: IMCPActionOptions): ITouchControlsConfiguration {
	validateTouchControlsConfiguration(next);
	scene.metadata ??= {};
	scene.metadata.babylonEditorTouchControls = structuredClone(next);
	try {
		refresh(scene, options);
	} catch (error) {
		restore(scene, previous, options);
		throw error;
	}
	registerUndoRedo({
		undo: () => restore(scene, previous, options),
		redo: () => {
			scene.metadata ??= {};
			scene.metadata.babylonEditorTouchControls = structuredClone(next);
			refresh(scene, options);
		},
	});
	return structuredClone(next);
}

function findControl(configuration: ITouchControlsConfiguration, id: unknown): ITouchControlDefinition {
	if (typeof id !== "string" || !id.trim()) {
		throw new Error("Touch Control id must be a non-empty string.");
	}
	const control = configuration.controls.find((candidate) => candidate.id === id);
	if (!control) {
		throw new Error(`Touch Control was not found: ${id}`);
	}
	return control;
}

function controlCandidate(value: unknown, index: number): ITouchControlDefinition {
	assertControlChanges(value, "Touch Control");
	const source = value as Record<string, unknown>;
	const type = source.type === "stick" ? "stick" : "button";
	const fallback =
		type === "stick"
			? { x: 0.05, y: 0.68, width: 0.24, height: 0.24 }
			: { x: Math.max(0.55, 0.82 - (index % 3) * 0.18), y: Math.max(0.5, 0.78 - Math.floor(index / 3) * 0.18), width: 0.14, height: 0.14 };
	return normalizeTouchControlsConfiguration({
		controls: [
			{
				id: createTouchControlId(),
				name: type === "stick" ? "Movement Stick" : `Action Button ${index + 1}`,
				type,
				controlPath: type === "stick" ? "<touch>/onScreenStick" : `<touch>/onScreenButton${index + 1}`,
				rect: fallback,
				...structuredClone(source),
			},
		],
	}).controls[0];
}

/** Reads normalized Touch Controls without dirtying absent/legacy scene metadata. */
export function getTouchControlsConfiguration(scene: Scene): ITouchControlsConfiguration {
	return normalizeTouchControlsConfiguration(scene.metadata?.babylonEditorTouchControls);
}

/** Patches global overlay behavior under one exact revision lease. */
export function setTouchControlsConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): ITouchControlsConfiguration {
	assertRecord(data, ["expectedRevision", "changes", "endpoint", "collaborationToken"], "set_touch_controls_configuration input");
	assertRecord(data.changes, configurationFields, "Touch Controls changes");
	if (!Object.keys(data.changes).length) {
		throw new Error("Touch Controls changes must contain at least one field.");
	}
	for (const key of ["enabled", "visibleInEditor", "respectSafeArea"] as const) {
		if (data.changes[key] !== undefined && typeof data.changes[key] !== "boolean") {
			throw new Error(`Touch Controls ${key} must be Boolean.`);
		}
	}
	if (data.changes.opacity !== undefined && (typeof data.changes.opacity !== "number" || !Number.isFinite(data.changes.opacity))) {
		throw new Error("Touch Controls opacity must be a finite number.");
	}
	const current = getTouchControlsConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	const next = normalizeTouchControlsConfiguration({ ...current, ...structuredClone(data.changes), revision: current.revision + 1 });
	return publish(scene, snapshot(scene), next, options);
}

/** Adds one button or fixed-center stick to the normalized overlay. */
export function createTouchControl(scene: Scene, data: unknown, options: IMCPActionOptions): { configuration: ITouchControlsConfiguration; control: ITouchControlDefinition } {
	assertRecord(data, ["expectedRevision", "control", "endpoint", "collaborationToken"], "create_touch_control input");
	const current = getTouchControlsConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	const control = controlCandidate(data.control, current.controls.length);
	const next = normalizeTouchControlsConfiguration({ ...current, revision: current.revision + 1, controls: [...current.controls, control] });
	return { configuration: publish(scene, snapshot(scene), next, options), control: structuredClone(control) };
}

/** Updates one exact-id control while preserving its identity. */
export function setTouchControl(scene: Scene, data: unknown, options: IMCPActionOptions): { configuration: ITouchControlsConfiguration; control: ITouchControlDefinition } {
	assertRecord(data, ["expectedRevision", "id", "changes", "endpoint", "collaborationToken"], "set_touch_control input");
	assertControlChanges(data.changes, "Touch Control changes");
	const current = getTouchControlsConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	const next = structuredClone(current);
	const control = findControl(next, data.id);
	const changes = structuredClone(data.changes);
	const normalized = normalizeTouchControlsConfiguration({
		controls: [{ ...control, ...changes, ...(changes.rect ? { rect: { ...control.rect, ...(changes.rect as Record<string, number>) } } : {}), id: control.id }],
	}).controls[0];
	next.controls[next.controls.indexOf(control)] = normalized;
	next.revision++;
	return { configuration: publish(scene, snapshot(scene), next, options), control: structuredClone(normalized) };
}

/** Deletes one control and clears its transient simulated path through runtime replacement. */
export function deleteTouchControl(scene: Scene, data: unknown, options: IMCPActionOptions): { deleted: true; id: string; configuration: ITouchControlsConfiguration } {
	assertRecord(data, ["expectedRevision", "id", "confirm", "endpoint", "collaborationToken"], "delete_touch_control input");
	if (data.confirm !== true) {
		throw new Error("Deleting a Touch Control requires confirm=true.");
	}
	const current = getTouchControlsConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	const control = findControl(current, data.id);
	const next = normalizeTouchControlsConfiguration({ ...current, revision: current.revision + 1, controls: current.controls.filter((candidate) => candidate.id !== control.id) });
	return { deleted: true, id: control.id, configuration: publish(scene, snapshot(scene), next, options) };
}

/** Verifies layout plus Input Actions path bindings for authoring or mobile export. */
export function validateTouchControls(scene: Scene): {
	valid: boolean;
	configuration: ITouchControlsConfiguration;
	errors: Array<{ code: string; message: string }>;
	warnings: Array<{ code: string; message: string }>;
	boundControlCount: number;
} {
	const configuration = getTouchControlsConfiguration(scene);
	const errors: Array<{ code: string; message: string }> = [];
	const warnings: Array<{ code: string; message: string }> = [];
	try {
		validateTouchControlsConfiguration(configuration);
	} catch (error) {
		errors.push({ code: "invalid_configuration", message: error instanceof Error ? error.message : String(error) });
	}
	const bindingPaths = new Set<string>();
	for (const map of normalizeInputActionMaps(scene.metadata?.babylonEditorInputActionMaps)) {
		for (const action of map.actions) {
			for (const binding of action.bindings) {
				if (binding.path) {
					bindingPaths.add(binding.path.toLowerCase());
				}
				for (const part of binding.composite?.parts ?? []) {
					bindingPaths.add(part.path.toLowerCase());
				}
			}
		}
	}
	const unbound = configuration.controls.filter((control) => !bindingPaths.has(control.controlPath.toLowerCase()));
	for (const control of unbound) {
		errors.push({ code: "unbound_control_path", message: `Touch Control "${control.name}" path is not used by an Input Action binding: ${control.controlPath}` });
	}
	if (configuration.enabled && !configuration.controls.length) {
		warnings.push({ code: "no_controls", message: "Touch Controls is enabled but contains no controls." });
	}
	return { valid: errors.length === 0, configuration, errors, warnings, boundControlCount: configuration.controls.length - unbound.length };
}

/** Injects one authored control into the active preview without changing persisted state. */
export function simulateTouchControl(scene: Scene, data: unknown, options: IMCPActionOptions): { id: string; phase: string; path: string; value: InputActionValue } {
	assertRecord(data, ["id", "phase", "value", "endpoint", "collaborationToken"], "simulate_touch_control input");
	const control = findControl(getTouchControlsConfiguration(scene), data.id);
	const input = inputRuntime(scene) ?? configureInputActions(runtimeScene(scene));
	if (!input) {
		throw new Error("Touch Control simulation requires an active Input Actions preview runtime.");
	}
	if (!(scene as any).touchControls) {
		configureTouchControls(runtimeScene(scene), { editor: true });
	}
	if (!["press", "move", "release"].includes(String(data.phase))) {
		throw new Error("Touch Control phase must be press, move, or release.");
	}
	let value: InputActionValue = control.type === "stick" ? [0, 0] : control.buttonValue;
	if (data.phase === "release") {
		input.clearSimulatedControl(control.controlPath);
		value = control.type === "stick" ? [0, 0] : 0;
	} else {
		if (control.type === "stick") {
			if (
				!Array.isArray(data.value) ||
				data.value.length !== 2 ||
				!data.value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= 1)
			) {
				throw new Error("Stick simulation requires a finite [x, y] value with components from -1 through 1.");
			}
			value = [data.value[0], data.value[1]];
		} else if (data.phase === "move") {
			throw new Error("Button Touch Controls support press or release, not move.");
		}
		if (!input.simulateControl(control.controlPath, value)) {
			throw new Error("The Input Actions runtime rejected the Touch Control value.");
		}
	}
	(options.editor.layout as any).mobile?.forceUpdate?.();
	return { id: control.id, phase: String(data.phase), path: control.controlPath, value };
}

/** Reads transient overlay/control state without exposing DOM objects. */
export function getTouchControlsRuntime(scene: Scene): unknown {
	return (scene as any).touchControls?.status() ?? { revision: getTouchControlsConfiguration(scene).revision, enabled: false, controls: [] };
}
