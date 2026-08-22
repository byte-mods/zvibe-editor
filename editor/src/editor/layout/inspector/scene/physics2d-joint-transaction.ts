import { Scene } from "babylonjs";

import { Editor } from "../../../main";

import { registerUndoRedo } from "../../../../tools/undoredo";
import { capturePhysics2DJointSnapshot, IPhysics2DJointCollectionSnapshot, restorePhysics2DJointSnapshot } from "../../../../mcp/physics2d/physics2d";

/** Compares exact raw collections so an unchanged Inspector commit never consumes Undo history. */
function snapshotsMatch(first: IPhysics2DJointCollectionSnapshot, second: IPhysics2DJointCollectionSnapshot): boolean {
	return first.present === second.present && JSON.stringify(first.value) === JSON.stringify(second.value);
}

/** Registers whole-collection restoration because joint type and connection changes replace multiple related fields. */
export function registerPhysics2DJointUndoRedo(
	scene: Scene,
	editor: Editor,
	before: IPhysics2DJointCollectionSnapshot,
	after: IPhysics2DJointCollectionSnapshot,
	onRestored?: () => void
): void {
	if (snapshotsMatch(before, after)) {
		return;
	}
	const restore = (snapshot: IPhysics2DJointCollectionSnapshot): void => {
		restorePhysics2DJointSnapshot(scene, snapshot, { editor });
		onRestored?.();
	};
	registerUndoRedo({
		undo: () => restore(before),
		redo: () => restore(after),
	});
}

/** Runs one canonical joint mutation and records its exact persisted before/after state. */
export function runPhysics2DJointTransaction<T>(scene: Scene, editor: Editor, mutation: () => T, onChanged?: () => void): T {
	const before = capturePhysics2DJointSnapshot(scene);
	const result = mutation();
	const after = capturePhysics2DJointSnapshot(scene);
	registerPhysics2DJointUndoRedo(scene, editor, before, after, onChanged);
	onChanged?.();
	return result;
}
