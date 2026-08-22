import { Scene } from "babylonjs";

import { Editor } from "../../../main";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { capturePhysics2DBodySnapshot, IPhysics2DBodyCollectionSnapshot, restorePhysics2DBodySnapshot } from "../../../../mcp/physics2d/physics2d";

/** Compares exact raw snapshots so no-op UI events do not consume Undo history. */
function snapshotsMatch(first: IPhysics2DBodyCollectionSnapshot, second: IPhysics2DBodyCollectionSnapshot): boolean {
	return first.present === second.present && JSON.stringify(first.value) === JSON.stringify(second.value);
}

/** Registers a whole-collection restore because collider type changes can replace every shape-specific field. */
export function registerPhysics2DBodyUndoRedo(
	scene: Scene,
	editor: Editor,
	before: IPhysics2DBodyCollectionSnapshot,
	after: IPhysics2DBodyCollectionSnapshot,
	onRestored?: () => void
): void {
	if (snapshotsMatch(before, after)) {
		return;
	}
	const restore = (snapshot: IPhysics2DBodyCollectionSnapshot): void => {
		restorePhysics2DBodySnapshot(scene, snapshot, { editor });
		onRestored?.();
	};
	registerUndoRedo({
		undo: () => restore(before),
		redo: () => restore(after),
	});
}

/** Executes one canonical mutation and registers its exact before/after persisted state. */
export function runPhysics2DBodyTransaction<T>(scene: Scene, editor: Editor, mutation: () => T, onChanged?: () => void): T {
	const before = capturePhysics2DBodySnapshot(scene);
	const result = mutation();
	const after = capturePhysics2DBodySnapshot(scene);
	registerPhysics2DBodyUndoRedo(scene, editor, before, after, onChanged);
	onChanged?.();
	return result;
}

/** Awaits image-derived authoring before capturing the post-state and exposing one Undo entry. */
export async function runPhysics2DBodyAsyncTransaction<T>(scene: Scene, editor: Editor, mutation: () => Promise<T>, onChanged?: () => void): Promise<T> {
	const before = capturePhysics2DBodySnapshot(scene);
	const result = await mutation();
	const after = capturePhysics2DBodySnapshot(scene);
	registerPhysics2DBodyUndoRedo(scene, editor, before, after, onChanged);
	onChanged?.();
	return result;
}
