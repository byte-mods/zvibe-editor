import { Scene } from "babylonjs";
import {
	configureInputActions,
	createInputId,
	IInputActionDefinition,
	IInputActionMapDefinition,
	IInputBindingDefinition,
	IInputControlSchemeDefinition,
	IInputSystemSettings,
	InputActionValue,
	InputActions,
	normalizeInputActionMap,
	normalizeInputActionMaps,
	normalizeInputSystemSettings,
	validateInputActionMaps,
	validateInputSystemSettings,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

export interface IInputAuthoringSnapshot {
	hasMaps: boolean;
	maps: unknown;
	hasSettings: boolean;
	settings: unknown;
}

/** Captures exact raw metadata, including key absence, for editor Undo/Redo. */
export function getInputAuthoringSnapshot(scene: Scene): IInputAuthoringSnapshot {
	return {
		hasMaps: Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorInputActionMaps"),
		maps: structuredClone(scene.metadata?.babylonEditorInputActionMaps),
		hasSettings: Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorInputSystemSettings"),
		settings: structuredClone(scene.metadata?.babylonEditorInputSystemSettings),
	};
}

/** Restores one exact raw authoring snapshot and resynchronizes an already-active preview runtime. */
export function restoreInputAuthoringSnapshot(scene: Scene, snapshot: IInputAuthoringSnapshot, options: IMCPActionOptions): void {
	scene.metadata ??= {};
	if (snapshot.hasMaps) {
		scene.metadata.babylonEditorInputActionMaps = structuredClone(snapshot.maps);
	} else {
		delete scene.metadata.babylonEditorInputActionMaps;
	}
	if (snapshot.hasSettings) {
		scene.metadata.babylonEditorInputSystemSettings = structuredClone(snapshot.settings);
	} else {
		delete scene.metadata.babylonEditorInputSystemSettings;
	}
	if ((scene as any).inputActions) {
		configureInputActions(scene as any);
	}
	refreshInspector(scene, options);
}

function authoredMaps(scene: Scene): IInputActionMapDefinition[] {
	return normalizeInputActionMaps(scene.metadata?.babylonEditorInputActionMaps);
}

function authoredSettings(scene: Scene): IInputSystemSettings {
	return normalizeInputSystemSettings(scene.metadata?.babylonEditorInputSystemSettings);
}

function findMap(values: IInputActionMapDefinition[], data: any): IInputActionMapDefinition {
	if (!!data.mapId === !!data.mapName) {
		throw new Error("Provide exactly one mapId or mapName.");
	}
	const map = values.find((candidate) => candidate.id === data.mapId || candidate.name === data.mapName);
	if (!map) {
		throw new Error("Input Action Map not found.");
	}
	return map;
}

function findAction(map: IInputActionMapDefinition, data: any): IInputActionDefinition {
	if (!!data.actionId === !!data.actionName) {
		throw new Error("Provide exactly one actionId or actionName.");
	}
	const action = map.actions.find((candidate) => candidate.id === data.actionId || candidate.name === data.actionName);
	if (!action) {
		throw new Error(`Input Action was not found in map "${map.name}".`);
	}
	return action;
}

function findBinding(action: IInputActionDefinition, data: any): IInputBindingDefinition {
	const binding = data.bindingId ? action.bindings.find((candidate) => candidate.id === data.bindingId) : action.bindings[data.bindingIndex ?? 0];
	if (!binding) {
		throw new Error(`Input binding was not found on action "${action.name}".`);
	}
	return binding;
}

function findScheme(map: IInputActionMapDefinition, data: any): IInputControlSchemeDefinition {
	if (!!data.schemeId === !!data.schemeName) {
		throw new Error("Provide exactly one schemeId or schemeName.");
	}
	const scheme = map.controlSchemes.find((candidate) => candidate.id === data.schemeId || candidate.name === data.schemeName);
	if (!scheme) {
		throw new Error(`Input control scheme was not found in map "${map.name}".`);
	}
	return scheme;
}

function assertRevision(actual: number, expected: unknown, label: string): void {
	if (!Number.isInteger(expected)) {
		throw new Error(`${label} requires expectedRevision.`);
	}
	if (expected !== actual) {
		throw new Error(`${label} revision is stale: expected ${expected}, current ${actual}.`);
	}
}

function refreshInspector(scene: Scene, options: IMCPActionOptions): void {
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
}

function publishMaps(scene: Scene, next: IInputActionMapDefinition[], previous: IInputActionMapDefinition[]): void {
	validateInputActionMaps(next);
	scene.metadata ??= {};
	const hadRuntime = !!(scene as any).inputActions;
	scene.metadata.babylonEditorInputActionMaps = next;
	if (!hadRuntime) {
		return;
	}
	try {
		configureInputActions(scene as any);
	} catch (error) {
		scene.metadata.babylonEditorInputActionMaps = previous;
		configureInputActions(scene as any);
		throw error;
	}
}

function publishSettings(scene: Scene, next: IInputSystemSettings, previous: IInputSystemSettings): void {
	validateInputSystemSettings(next);
	scene.metadata ??= {};
	const hadRuntime = !!(scene as any).inputActions;
	scene.metadata.babylonEditorInputSystemSettings = next;
	if (!hadRuntime) {
		return;
	}
	try {
		configureInputActions(scene as any);
	} catch (error) {
		scene.metadata.babylonEditorInputSystemSettings = previous;
		configureInputActions(scene as any);
		throw error;
	}
}

function mutateMap(scene: Scene, data: any, mutation: (map: IInputActionMapDefinition) => void): IInputActionMapDefinition {
	const previous = authoredMaps(scene);
	const next = structuredClone(previous);
	const map = findMap(next, data);
	assertRevision(map.revision, data.expectedRevision, `Input Action Map "${map.name}"`);
	mutation(map);
	map.revision++;
	publishMaps(scene, next, previous);
	return structuredClone(map);
}

function runtime(scene: Scene): InputActions {
	const input = (scene as any).inputActions as InputActions | undefined;
	if (!input) {
		throw new Error("Input Actions runtime is not active in this scene. Start preview/runtime first.");
	}
	return input;
}

function identifier(value: string): string {
	const result = value.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^([^A-Za-z_$])/, "_$1");
	if (!result) {
		throw new Error("Input Action names must contain identifier characters to generate a wrapper.");
	}
	return result;
}

/** Lists fully normalized, revisioned Input Action Maps without dirtying legacy metadata. */
export function listInputActionMaps(scene: Scene): any {
	return { maps: structuredClone(authoredMaps(scene)) };
}

/** Creates a version-2 Input Action Map with stable action/binding/scheme ids. */
export function createInputActionMap(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = authoredMaps(scene);
	if (previous.some((map) => map.name.trim().toLowerCase() === data.name.trim().toLowerCase())) {
		throw new Error(`Input Action Map "${data.name}" already exists.`);
	}
	const map = normalizeInputActionMap({
		version: 2,
		revision: 1,
		id: data.id ?? createInputId("map"),
		name: data.name.trim(),
		enabled: data.enabled ?? true,
		actions: data.actions ?? [],
		controlSchemes: data.controlSchemes ?? [],
	});
	const next = [...previous, map];
	publishMaps(scene, next, previous);
	refreshInspector(scene, options);
	return structuredClone(map);
}

/** Atomically updates map-level fields or replaces complete action/scheme collections. */
export function setInputActionMap(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = mutateMap(scene, data, (map) => {
		const normalized = normalizeInputActionMap({
			...map,
			...(data.name !== undefined ? { name: data.name.trim() } : {}),
			...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
			...(data.actions !== undefined ? { actions: data.actions } : {}),
			...(data.controlSchemes !== undefined ? { controlSchemes: data.controlSchemes } : {}),
		});
		Object.assign(map, normalized, { revision: map.revision });
	});
	refreshInspector(scene, options);
	return result;
}

/** Deletes one exact-revision map and all of its authored actions/bindings/schemes. */
export function deleteInputActionMap(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = authoredMaps(scene);
	const map = findMap(previous, data);
	assertRevision(map.revision, data.expectedRevision, `Input Action Map "${map.name}"`);
	const next = previous.filter((candidate) => candidate.id !== map.id);
	publishMaps(scene, next, previous);
	refreshInspector(scene, options);
	return { deleted: true, id: map.id, revision: map.revision };
}

/** Creates one stable-id action inside an exact-revision map. */
export function createInputAction(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IInputActionDefinition;
	const map = mutateMap(scene, data, (candidate) => {
		created = normalizeInputActionMap({ id: "temporary", name: "Temporary", actions: [{ id: data.action?.id ?? createInputId("action"), ...data.action }] }).actions[0];
		candidate.actions.push(created);
	});
	refreshInspector(scene, options);
	return { mapId: map.id, mapRevision: map.revision, action: structuredClone(created) };
}

/** Updates action type/value/phase semantics, processors, interactions, or complete bindings atomically. */
export function setInputAction(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IInputActionDefinition;
	const map = mutateMap(scene, data, (candidate) => {
		const action = findAction(candidate, data);
		updated = normalizeInputActionMap({
			id: "temporary",
			name: "Temporary",
			actions: [
				{
					...action,
					...(data.changes ?? {}),
					id: action.id,
				},
			],
		}).actions[0];
		candidate.actions[candidate.actions.indexOf(action)] = updated;
	});
	refreshInspector(scene, options);
	return { mapId: map.id, mapRevision: map.revision, action: structuredClone(updated) };
}

/** Deletes one action and its bindings from an exact-revision map. */
export function deleteInputAction(scene: Scene, data: any, options: IMCPActionOptions): any {
	let deletedId = "";
	const map = mutateMap(scene, data, (candidate) => {
		const action = findAction(candidate, data);
		deletedId = action.id;
		candidate.actions.splice(candidate.actions.indexOf(action), 1);
	});
	refreshInspector(scene, options);
	return { deleted: true, mapId: map.id, mapRevision: map.revision, actionId: deletedId };
}

/** Appends a path or composite binding to one action. */
export function createInputActionBinding(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IInputBindingDefinition;
	let actionId = "";
	const map = mutateMap(scene, data, (candidate) => {
		const action = findAction(candidate, data);
		actionId = action.id;
		created = normalizeInputActionMap({
			id: "temporary",
			name: "Temporary",
			actions: [{ name: "Temporary", bindings: [{ id: data.binding?.id ?? createInputId("binding"), ...data.binding }] }],
		}).actions[0].bindings[0];
		action.bindings.push(created);
	});
	refreshInspector(scene, options);
	return { mapId: map.id, mapRevision: map.revision, actionId, binding: structuredClone(created) };
}

/** Exact-revision update of one path/composite binding; legacy string replacement remains accepted internally. */
export function setInputActionBinding(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IInputBindingDefinition;
	let actionId = "";
	const map = mutateMap(scene, data, (candidate) => {
		const action = findAction(candidate, data);
		actionId = action.id;
		const binding = findBinding(action, data);
		const changes = typeof data.binding === "string" ? { path: data.binding } : (data.changes ?? data.binding ?? {});
		updated = normalizeInputActionMap({
			id: "temporary",
			name: "Temporary",
			actions: [{ name: "Temporary", bindings: [{ ...binding, ...changes, id: binding.id }] }],
		}).actions[0].bindings[0];
		action.bindings[action.bindings.indexOf(binding)] = updated;
	});
	refreshInspector(scene, options);
	return { mapId: map.id, mapRevision: map.revision, actionId, binding: structuredClone(updated) };
}

/** Deletes one exact stable-id binding. */
export function deleteInputActionBinding(scene: Scene, data: any, options: IMCPActionOptions): any {
	let bindingId = "";
	let actionId = "";
	const map = mutateMap(scene, data, (candidate) => {
		const action = findAction(candidate, data);
		actionId = action.id;
		const binding = findBinding(action, data);
		bindingId = binding.id;
		action.bindings.splice(action.bindings.indexOf(binding), 1);
	});
	refreshInspector(scene, options);
	return { deleted: true, mapId: map.id, mapRevision: map.revision, actionId, bindingId };
}

/** Adds a keyboard/mouse/gamepad/touch device requirement group. */
export function createInputControlScheme(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IInputControlSchemeDefinition;
	const map = mutateMap(scene, data, (candidate) => {
		created = { id: data.scheme?.id ?? createInputId("scheme"), name: data.scheme.name.trim(), devices: [...data.scheme.devices] };
		candidate.controlSchemes.push(created);
	});
	refreshInspector(scene, options);
	return { mapId: map.id, mapRevision: map.revision, scheme: structuredClone(created) };
}

/** Updates one exact-revision control-scheme name/device set. */
export function setInputControlScheme(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IInputControlSchemeDefinition;
	const map = mutateMap(scene, data, (candidate) => {
		const scheme = findScheme(candidate, data);
		if (data.changes?.name !== undefined) {
			scheme.name = data.changes.name.trim();
		}
		if (data.changes?.devices !== undefined) {
			scheme.devices = [...data.changes.devices];
		}
		updated = scheme;
	});
	refreshInspector(scene, options);
	return { mapId: map.id, mapRevision: map.revision, scheme: structuredClone(updated) };
}

/** Deletes one control scheme without deleting its bindings. */
export function deleteInputControlScheme(scene: Scene, data: any, options: IMCPActionOptions): any {
	let schemeId = "";
	const map = mutateMap(scene, data, (candidate) => {
		const scheme = findScheme(candidate, data);
		schemeId = scheme.id;
		candidate.controlSchemes.splice(candidate.controlSchemes.indexOf(scheme), 1);
	});
	refreshInspector(scene, options);
	return { deleted: true, mapId: map.id, mapRevision: map.revision, schemeId };
}

export function getInputSystemSettings(scene: Scene): any {
	return { settings: structuredClone(authoredSettings(scene)) };
}

/** Exact-revision update of thresholds, timing, trace capacity, update mode, and auto-switch behavior. */
export function setInputSystemSettings(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = authoredSettings(scene);
	assertRevision(previous.revision, data.expectedRevision, "Input system settings");
	const next = normalizeInputSystemSettings({ ...previous, ...data.changes, revision: previous.revision + 1 });
	publishSettings(scene, next, previous);
	refreshInspector(scene, options);
	return { settings: structuredClone(next) };
}

/** Returns devices, active schemes, exact action phases/values, and bounded trace evidence. */
export function getInputRuntime(scene: Scene, data: any): any {
	const input = runtime(scene);
	return {
		settings: input.getSettings(),
		devices: input.getDevices(),
		lastUsedDevice: input.getLastUsedDevice(),
		maps: input.getMaps().map((map) => ({ id: map.id, name: map.name, activeControlScheme: input.getControlScheme(map.id) })),
		actions: input.listActionStates(),
		trace: input.getTrace(data.offset ?? 0, data.limit ?? 100),
	};
}

export function setInputRuntimeMapEnabled(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!runtime(scene).setMapEnabled(data.mapId ?? data.mapName, data.enabled)) {
		throw new Error("Input Action Map not found in active runtime.");
	}
	options.editor.layout.inspector.forceUpdate();
	return { map: data.mapId ?? data.mapName, enabled: data.enabled };
}

export function setInputRuntimeActionEnabled(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!runtime(scene).setActionEnabled(data.mapId ?? data.mapName, data.actionId ?? data.actionName, data.enabled)) {
		throw new Error("Input Action not found in active runtime.");
	}
	options.editor.layout.inspector.forceUpdate();
	return { map: data.mapId ?? data.mapName, action: data.actionId ?? data.actionName, enabled: data.enabled };
}

export function setInputRuntimeControlScheme(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!runtime(scene).setControlScheme(data.mapId ?? data.mapName, data.schemeId ?? data.schemeName)) {
		throw new Error("Input control scheme was not found in active runtime.");
	}
	options.editor.layout.inspector.forceUpdate();
	return { map: data.mapId ?? data.mapName, controlScheme: runtime(scene).getControlScheme(data.mapId ?? data.mapName) };
}

export function readInputActionRuntime(scene: Scene, data: any): any {
	const input = runtime(scene);
	const state = input.getActionState(data.mapId ?? data.mapName, data.actionId ?? data.actionName);
	if (!state) {
		throw new Error("Input Action not found in active runtime.");
	}
	return state;
}

/** Advances manual-update interaction timers without advancing any game subsystem. */
export function updateInputRuntime(scene: Scene, data: any, options: IMCPActionOptions): any {
	const input = runtime(scene);
	if (input.getSettings().updateMode !== "manual") {
		throw new Error("Input runtime can be manually updated only when updateMode is manual.");
	}
	input.update(data.deltaSeconds ?? 0);
	options.editor.layout.inspector.forceUpdate();
	return { deltaSeconds: data.deltaSeconds ?? 0, actions: input.listActionStates(), trace: input.getTrace(0, data.limit ?? 100) };
}

/** Injects any supported scalar/Vector2/Vector3 control path into the active preview. */
export function simulateInputControl(scene: Scene, data: any, options: IMCPActionOptions): any {
	const input = runtime(scene);
	const value = data.value as InputActionValue;
	if (!input.simulateControl(data.path, value)) {
		throw new Error("Input simulation value must be a finite scalar, Vector2, or Vector3.");
	}
	options.editor.layout.inspector.forceUpdate();
	return { simulated: true, path: data.path, value };
}

export function clearSimulatedInputControl(scene: Scene, data: any, options: IMCPActionOptions): any {
	const cleared = runtime(scene).clearSimulatedControl(data.path);
	options.editor.layout.inspector.forceUpdate();
	return { cleared, path: data.path };
}

/** Backward-compatible normalized touch injection routed through the complete runtime. */
export function simulateInputTouch(scene: Scene, data: any): any {
	const input = runtime(scene);
	const x = data.x ?? 0.5;
	const y = data.y ?? 0.5;
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error("Touch simulation x and y must be finite normalized numbers.");
	}
	return { simulated: input.simulateTouch(data.pressed ?? true, x, y), pressed: data.pressed ?? true, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export function applyInputBindingOverride(scene: Scene, data: any, options: IMCPActionOptions): any {
	const input = runtime(scene);
	if (!input.applyBindingOverride(data.mapId ?? data.mapName, data.actionId ?? data.actionName, data.bindingId, data.path)) {
		throw new Error("Input binding override target was not found.");
	}
	options.editor.layout.inspector.forceUpdate();
	return { applied: true, bindingId: data.bindingId, path: data.path, overridesJson: input.saveBindingOverrides() };
}

export function clearInputBindingOverride(scene: Scene, data: any, options: IMCPActionOptions): any {
	const input = runtime(scene);
	const cleared = input.clearBindingOverride(data.mapId ?? data.mapName, data.actionId ?? data.actionName, data.bindingId);
	options.editor.layout.inspector.forceUpdate();
	return { cleared, bindingId: data.bindingId ?? null, overridesJson: input.saveBindingOverrides() };
}

export function saveInputBindingOverrides(scene: Scene): any {
	const json = runtime(scene).saveBindingOverrides();
	return { json, byteLength: new TextEncoder().encode(json).byteLength };
}

export function loadInputBindingOverrides(scene: Scene, data: any, options: IMCPActionOptions): any {
	const count = runtime(scene).loadBindingOverrides(data.json, data.replace ?? true);
	options.editor.layout.inspector.forceUpdate();
	return { loaded: true, count, replace: data.replace ?? true };
}

export function getInputActionTrace(scene: Scene, data: any): any {
	return runtime(scene).getTrace(data.offset ?? 0, data.limit ?? 100);
}

export function clearInputActionTrace(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const cleared = runtime(scene).clearTrace();
	options.editor.layout.inspector.forceUpdate();
	return { cleared };
}

/** Generates deterministic TypeScript constants/types for one persisted map. */
export function generateInputActionWrapper(scene: Scene, data: any): any {
	const map = findMap(authoredMaps(scene), data);
	const mapIdentifier = identifier(map.name);
	const entries = map.actions.map((action) => ({ identifier: identifier(action.name), name: action.name, controlType: action.expectedControlType }));
	if (new Set(entries.map((entry) => entry.identifier)).size !== entries.length) {
		throw new Error("Input Action names collide after TypeScript identifier normalization.");
	}
	const source = [
		`/** Generated from Zvibe Editor Input Action Map "${map.name}" (revision ${map.revision}). */`,
		`export const ${mapIdentifier}Map = ${JSON.stringify(map.name)} as const;`,
		`export const ${mapIdentifier}Actions = {`,
		...entries.map((entry) => `\t${entry.identifier}: ${JSON.stringify(entry.name)},`),
		`} as const;`,
		`export type ${mapIdentifier}Action = (typeof ${mapIdentifier}Actions)[keyof typeof ${mapIdentifier}Actions];`,
		`export const ${mapIdentifier}ControlTypes = {`,
		...entries.map((entry) => `\t${entry.identifier}: ${JSON.stringify(entry.controlType)},`),
		`} as const;`,
	].join("\n");
	return { mapId: map.id, mapName: map.name, revision: map.revision, source };
}
