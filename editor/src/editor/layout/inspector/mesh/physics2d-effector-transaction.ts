import { Scene } from "babylonjs";

import { Editor } from "../../../main";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { capturePhysics2DEffectorSnapshot, IPhysics2DEffectorCollectionSnapshot, restorePhysics2DEffectorSnapshot } from "../../../../mcp/physics2d/physics2d";

function snapshotsMatch(first: IPhysics2DEffectorCollectionSnapshot, second: IPhysics2DEffectorCollectionSnapshot): boolean {
	return first.present === second.present && JSON.stringify(first.value) === JSON.stringify(second.value);
}

/** Registers one complete collection restore so type changes and deletes never produce partial Undo state. */
export function registerPhysics2DEffectorUndoRedo(
	scene: Scene,
	editor: Editor,
	before: IPhysics2DEffectorCollectionSnapshot,
	after: IPhysics2DEffectorCollectionSnapshot,
	onRestored?: () => void
): void {
	if (snapshotsMatch(before, after)) {
		return;
	}
	const restore = (snapshot: IPhysics2DEffectorCollectionSnapshot): void => {
		restorePhysics2DEffectorSnapshot(scene, snapshot, { editor });
		onRestored?.();
	};
	registerUndoRedo({
		undo: () => restore(before),
		redo: () => restore(after),
	});
}

/** Runs one canonical CRUD action and records its exact raw before/after collection. */
export function runPhysics2DEffectorTransaction<T>(scene: Scene, editor: Editor, mutation: () => T, onChanged?: () => void): T {
	const before = capturePhysics2DEffectorSnapshot(scene);
	const result = mutation();
	const after = capturePhysics2DEffectorSnapshot(scene);
	registerPhysics2DEffectorUndoRedo(scene, editor, before, after, onChanged);
	onChanged?.();
	return result;
}
