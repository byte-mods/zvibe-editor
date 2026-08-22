import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { getPhysics2DSimulationControl } from "babylonjs-editor-tools";

import { runPhysics2DJointTransaction } from "../../src/editor/layout/inspector/scene/physics2d-joint-transaction";
import {
	capturePhysics2DJointSnapshot,
	createPhysics2DJoint,
	deletePhysics2DJoint,
	restorePhysics2DJointSnapshot,
	setPhysics2DBody,
	setPhysics2DJoint,
} from "../../src/mcp/physics2d/physics2d";
import { clearUndoRedo, getUndoRedoState, redo, undo } from "../../src/tools/undoredo";

describe("mcp/physics2d joint authoring transactions", () => {
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

	function createBodies(): [TransformNode, TransformNode] {
		const first = new TransformNode("First", scene);
		const second = new TransformNode("Second", scene);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, bodyType: "static", collider: { shape: "box", size: [20, 20] } }, { editor });
		return [first, second];
	}

	test("restores exact raw create update and delete collections through Undo and Redo", () => {
		const [first, second] = createBodies();
		const changed = vi.fn();
		expect(capturePhysics2DJointSnapshot(scene)).toEqual({ present: false, value: [] });

		const joint = runPhysics2DJointTransaction(
			scene,
			editor,
			() => createPhysics2DJoint(scene, { id: "hinge", type: "hinge", firstNodeId: first.id, secondNodeId: second.id, useMotor: true }, { editor }),
			changed
		);
		const createdRaw = capturePhysics2DJointSnapshot(scene);
		expect(createdRaw).toMatchObject({ present: true, value: [{ version: 2, revision: 1, id: "hinge", type: "hinge" }] });
		expect(getPhysics2DSimulationControl(scene).registeredJoints).toBe(1);

		undo();
		expect(capturePhysics2DJointSnapshot(scene)).toEqual({ present: false, value: [] });
		expect(getPhysics2DSimulationControl(scene).registeredJoints).toBe(0);
		redo();
		expect(capturePhysics2DJointSnapshot(scene)).toEqual(createdRaw);
		expect(getPhysics2DSimulationControl(scene).registeredJoints).toBe(1);

		runPhysics2DJointTransaction(scene, editor, () => setPhysics2DJoint(scene, { id: joint.id, expectedRevision: 1, motorSpeed: 3, maxMotorTorque: 25 }, { editor }), changed);
		const updatedRaw = capturePhysics2DJointSnapshot(scene);
		expect(updatedRaw).toMatchObject({ value: [{ revision: 2, motorSpeed: 3, maxMotorTorque: 25 }] });
		undo();
		expect(capturePhysics2DJointSnapshot(scene)).toEqual(createdRaw);
		redo();
		expect(capturePhysics2DJointSnapshot(scene)).toEqual(updatedRaw);

		runPhysics2DJointTransaction(scene, editor, () => deletePhysics2DJoint(scene, { id: joint.id, expectedRevision: 2 }, { editor }), changed);
		expect(capturePhysics2DJointSnapshot(scene)).toEqual({ present: true, value: [] });
		undo();
		expect(capturePhysics2DJointSnapshot(scene)).toEqual(updatedRaw);
		redo();
		expect(capturePhysics2DJointSnapshot(scene)).toEqual({ present: true, value: [] });
		expect(changed).toHaveBeenCalled();
	});

	test("preserves detached legacy fields and collection-key presence", () => {
		const [first, second] = createBodies();
		const legacy = [{ id: "legacy", type: "distance", firstNodeId: first.id, secondNodeId: second.id, customLegacyEvidence: { retained: true } }];
		scene.metadata.babylonEditorPhysics2DJoints = structuredClone(legacy);
		const snapshot = capturePhysics2DJointSnapshot(scene);
		(scene.metadata.babylonEditorPhysics2DJoints[0].customLegacyEvidence as any).retained = false;

		restorePhysics2DJointSnapshot(scene, snapshot, { editor });
		expect(scene.metadata.babylonEditorPhysics2DJoints).toEqual(legacy);
		restorePhysics2DJointSnapshot(scene, { present: false, value: [] }, { editor });
		expect(scene.metadata).not.toHaveProperty("babylonEditorPhysics2DJoints");
	});

	test("rejects malformed or dangling restores atomically", () => {
		const [first, second] = createBodies();
		createPhysics2DJoint(scene, { id: "safe", type: "fixed", firstNodeId: first.id, secondNodeId: second.id }, { editor });
		const before = capturePhysics2DJointSnapshot(scene);

		expect(() => restorePhysics2DJointSnapshot(scene, { present: false, value: before.value }, { editor })).toThrow("cannot contain hidden");
		expect(() => restorePhysics2DJointSnapshot(scene, { present: true, value: [...before.value, ...before.value] }, { editor })).toThrow("duplicated");
		expect(() =>
			restorePhysics2DJointSnapshot(scene, { present: true, value: [{ id: "dangling", type: "target", firstNodeId: "missing", target: [0, 0] }] }, { editor })
		).toThrow("authored 2D bodies");
		expect(capturePhysics2DJointSnapshot(scene)).toEqual(before);
	});

	test("does not register Undo for a no-op mutation", () => {
		createBodies();
		runPhysics2DJointTransaction(scene, editor, () => undefined);
		expect(getUndoRedoState().undoCount).toBe(0);
	});
});
