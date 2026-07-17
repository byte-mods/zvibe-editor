import { Scene, Tools } from "babylonjs";
import { IMCPActionOptions } from "../action";

function maps(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorInputActionMaps ??= []);
}
function find(scene: Scene, data: any): any {
	const value = maps(scene).find((map) => map.id === data.mapId || map.name === data.mapName);
	if (!value) throw new Error("Input action map not found.");
	return value;
}
function identifier(value: string): string {
	const result = value.replace(/[^A-Za-z0-9_$]+/g, "_").replace(/^([^A-Za-z_$])/, "_$1");
	if (!result) throw new Error("Input action names must contain identifier characters to generate a wrapper.");
	return result;
}

/** Lists persisted input action maps. */
export function listInputActionMaps(scene: Scene): any {
	return { maps: structuredClone(maps(scene)) };
}
/** Creates a persisted input action map. */
export function createInputActionMap(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (maps(scene).some((map) => map.name === data.name)) throw new Error(`Input action map "${data.name}" already exists.`);
	const map = { id: Tools.RandomId(), name: data.name, actions: data.actions ?? [], controlSchemes: data.controlSchemes ?? [] };
	maps(scene).push(map);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(map);
}
/** Updates an input action map's action/binding definitions. */
export function setInputActionMap(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = find(scene, data);
	if (data.name !== undefined) map.name = data.name;
	if (data.actions !== undefined) map.actions = data.actions;
	if (data.controlSchemes !== undefined) map.controlSchemes = data.controlSchemes;
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(map);
}
/** Replaces or appends one persisted action binding without requiring the caller to rewrite the full map. */
export function setInputActionBinding(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = find(scene, data);
	const action = map.actions.find((candidate: any) => candidate.name === data.actionName);
	if (!action) throw new Error(`Input action \"${data.actionName}\" was not found in map \"${map.name}\".`);
	if (!data.binding?.trim()) throw new Error("Input binding must be a non-empty path.");
	const index = data.bindingIndex ?? 0;
	if (!Number.isInteger(index) || index < 0) throw new Error("bindingIndex must be a non-negative integer.");
	action.bindings ??= [];
	action.bindings[index] = data.binding;
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(map);
}
/** Deletes an input action map. */
export function deleteInputActionMap(scene: Scene, data: any, options: IMCPActionOptions): any {
	const map = find(scene, data);
	maps(scene).splice(maps(scene).indexOf(map), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: map.id };
}

/** Injects a normalized touch point into a running preview's InputActions runtime when available. */
export function simulateInputTouch(scene: Scene, data: any): any {
	const runtime = (scene as any).inputActions as { simulateTouch?: (pressed: boolean, x?: number, y?: number) => boolean } | undefined;
	if (!runtime?.simulateTouch) throw new Error("Input Actions runtime is not active in this scene. Start a preview/runtime scene before simulating touch.");
	const x = data.x ?? 0.5;
	const y = data.y ?? 0.5;
	if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Touch simulation x and y must be finite normalized numbers.");
	return { simulated: runtime.simulateTouch(data.pressed ?? true, x, y), pressed: data.pressed ?? true, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/** Generates deterministic TypeScript constants/types for one persisted input action map. */
export function generateInputActionWrapper(scene: Scene, data: any): any {
	const map = find(scene, data);
	const mapIdentifier = identifier(map.name);
	const entries = map.actions.map((action: any) => ({ identifier: identifier(action.name), name: action.name }));
	if (new Set(entries.map((entry: any) => entry.identifier)).size !== entries.length) throw new Error("Input action names collide after TypeScript identifier normalization.");
	const source = [
		`/** Generated from Babylon.js Editor Input Action Map \"${map.name}\". */`,
		`export const ${mapIdentifier}Map = ${JSON.stringify(map.name)} as const;`,
		`export const ${mapIdentifier}Actions = {`,
		...entries.map((entry: any) => `\t${entry.identifier}: ${JSON.stringify(entry.name)},`),
		`} as const;`,
		`export type ${mapIdentifier}Action = (typeof ${mapIdentifier}Actions)[keyof typeof ${mapIdentifier}Actions];`,
	].join("\n");
	return { mapId: map.id, mapName: map.name, source };
}
