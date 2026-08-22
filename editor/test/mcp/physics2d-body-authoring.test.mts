import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { getPhysics2DSimulationControl } from "babylonjs-editor-tools";

import { runPhysics2DBodyAsyncTransaction, runPhysics2DBodyTransaction } from "../../src/editor/layout/inspector/mesh/physics2d-body-transaction";
import { capturePhysics2DBodySnapshot, listPhysics2D, removePhysics2DBody, restorePhysics2DBodySnapshot, setPhysics2DBody } from "../../src/mcp/physics2d/physics2d";
import { clearUndoRedo, getUndoRedoState, redo, undo } from "../../src/tools/undoredo";

describe("mcp/physics2d body authoring transactions", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = { layout: { inspector: { forceUpdate: vi.fn() } } };
		clearUndoRedo();
	});

	afterEach(() => {
		clearUndoRedo();
		scene.dispose();
		engine.dispose();
	});

	test("restores exact raw create update and delete collections through Undo and Redo", () => {
		const node = new TransformNode("Body", scene);
		const changed = vi.fn();
		expect(capturePhysics2DBodySnapshot(scene)).toEqual({ present: false, value: [] });

		runPhysics2DBodyTransaction(
			scene,
			editor,
			() => setPhysics2DBody(scene, { nodeId: node.id, bodyType: "kinematic", collider: { shape: "capsule", size: [40, 100] } }, { editor }),
			changed
		);
		const createdRaw = capturePhysics2DBodySnapshot(scene);
		expect(createdRaw).toMatchObject({ present: true, value: [{ version: 3, revision: 1, nodeId: node.id, bodyType: "kinematic" }] });

		undo();
		expect(capturePhysics2DBodySnapshot(scene)).toEqual({ present: false, value: [] });
		expect(getPhysics2DSimulationControl(scene).registeredBodies).toBe(0);
		redo();
		expect(capturePhysics2DBodySnapshot(scene)).toEqual(createdRaw);
		expect(getPhysics2DSimulationControl(scene).kinematicBodies).toBe(1);

		runPhysics2DBodyTransaction(
			scene,
			editor,
			() => setPhysics2DBody(scene, { nodeId: node.id, expectedRevision: 1, mass: 8, velocity: [12, -4], freezeRotation: true }, { editor }),
			changed
		);
		const updatedRaw = capturePhysics2DBodySnapshot(scene);
		expect(updatedRaw).toMatchObject({ value: [{ revision: 2, mass: 8, velocity: [12, -4], freezeRotation: true }] });
		undo();
		expect(capturePhysics2DBodySnapshot(scene)).toEqual(createdRaw);
		redo();
		expect(capturePhysics2DBodySnapshot(scene)).toEqual(updatedRaw);

		runPhysics2DBodyTransaction(scene, editor, () => removePhysics2DBody(scene, { nodeId: node.id, expectedRevision: 2 }, { editor }), changed);
		expect(capturePhysics2DBodySnapshot(scene)).toEqual({ present: true, value: [] });
		expect(getPhysics2DSimulationControl(scene).registeredBodies).toBe(0);
		undo();
		expect(capturePhysics2DBodySnapshot(scene)).toEqual(updatedRaw);
		redo();
		expect(capturePhysics2DBodySnapshot(scene)).toEqual({ present: true, value: [] });
		expect(changed).toHaveBeenCalled();
	});

	test("rejects stale deletion and malformed restores without mutation or Undo entries", () => {
		const node = new TransformNode("Guarded", scene);
		setPhysics2DBody(scene, { nodeId: node.id, collider: { shape: "circle", radius: 10 } }, { editor });
		const before = capturePhysics2DBodySnapshot(scene);

		expect(() => removePhysics2DBody(scene, { nodeId: node.id }, { editor })).toThrow("expected revision missing");
		expect(() => runPhysics2DBodyTransaction(scene, editor, () => removePhysics2DBody(scene, { nodeId: node.id, expectedRevision: 99 }, { editor }))).toThrow(
			"current revision is 1"
		);
		expect(getUndoRedoState().undoCount).toBe(0);
		expect(capturePhysics2DBodySnapshot(scene)).toEqual(before);

		expect(() => restorePhysics2DBodySnapshot(scene, { present: true, value: [...before.value, ...before.value] }, { editor })).toThrow("duplicate nodeId");
		expect(() => restorePhysics2DBodySnapshot(scene, { present: false, value: before.value }, { editor })).toThrow("cannot contain hidden");
		expect(() => restorePhysics2DBodySnapshot(scene, { present: true, value: [{ nodeId: "missing", collider: { shape: "circle", radius: 5 } }] }, { editor })).toThrow(
			"not found"
		);
		expect(() =>
			restorePhysics2DBodySnapshot(
				scene,
				{ present: true, value: [{ nodeId: node.id, collider: { shape: "circle", radius: 5 }, materialId: "missing-material" }] },
				{ editor }
			)
		).toThrow("material");
		expect(capturePhysics2DBodySnapshot(scene)).toEqual(before);
		expect(listPhysics2D(scene).bodies[0]).toMatchObject({ nodeId: node.id, revision: 1, active: true });
	});

	test("preserves detached legacy bytes and collection-key presence", () => {
		const node = new TransformNode("Legacy", scene);
		const legacy = [{ nodeId: node.id, bodyType: "static", collider: { shape: "box", size: [20, 30] }, customLegacyEvidence: { retained: true } }];
		scene.metadata = { babylonEditorPhysics2D: structuredClone(legacy) };
		const snapshot = capturePhysics2DBodySnapshot(scene);
		(scene.metadata.babylonEditorPhysics2D[0].customLegacyEvidence as any).retained = false;

		restorePhysics2DBodySnapshot(scene, snapshot, { editor });
		expect(scene.metadata.babylonEditorPhysics2D).toEqual(legacy);
		restorePhysics2DBodySnapshot(scene, { present: false, value: [] }, { editor });
		expect(scene.metadata).not.toHaveProperty("babylonEditorPhysics2D");
	});

	test("captures an awaited authoring result before registering Undo", async () => {
		const node = new TransformNode("Async", scene);
		await runPhysics2DBodyAsyncTransaction(scene, editor, async () => setPhysics2DBody(scene, { nodeId: node.id, collider: { shape: "circle", radius: 5 } }, { editor }));
		expect(getUndoRedoState().undoCount).toBe(1);
		expect(getPhysics2DSimulationControl(scene).registeredBodies).toBe(1);
		undo();
		expect(getPhysics2DSimulationControl(scene).registeredBodies).toBe(0);
	});
});
