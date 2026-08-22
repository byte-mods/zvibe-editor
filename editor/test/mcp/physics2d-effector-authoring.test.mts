import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { getPhysics2DSimulationControl, setPhysics2DSimulationPaused, stepPausedPhysics2DSimulation } from "babylonjs-editor-tools";

import {
	capturePhysics2DEffectorSnapshot,
	createPhysics2DEffector,
	deletePhysics2DEffector,
	listPhysics2D,
	listPhysics2DEffectors,
	restorePhysics2DEffectorSnapshot,
	setPhysics2DBody,
	setPhysics2DEffector,
} from "../../src/mcp/physics2d/physics2d";
import { runPhysics2DEffectorTransaction } from "../../src/editor/layout/inspector/mesh/physics2d-effector-transaction";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

describe("mcp/physics2d-effector-authoring", () => {
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

	test("restores exact raw create, type-change, and delete transactions through Undo/Redo", () => {
		const source = new TransformNode("Source", scene);
		const changed = vi.fn();
		expect(listPhysics2DEffectors(scene).effectors).toEqual([]);
		expect(capturePhysics2DEffectorSnapshot(scene)).toEqual({ present: false, value: [] });
		const created = runPhysics2DEffectorTransaction(
			scene,
			editor,
			() => createPhysics2DEffector(scene, { id: "authoring-effector", nodeId: source.id, type: "point", forceMagnitude: 25 }, { editor }),
			changed
		) as any;
		expect(capturePhysics2DEffectorSnapshot(scene)).toMatchObject({ present: true, value: [{ id: created.id, revision: 1, type: "point" }] });

		undo();
		expect(capturePhysics2DEffectorSnapshot(scene)).toEqual({ present: false, value: [] });
		redo();
		expect(listPhysics2DEffectors(scene).effectors[0]).toMatchObject({ id: created.id, revision: 1, type: "point", forceMagnitude: 25 });

		const pointRaw = structuredClone(scene.metadata.babylonEditorPhysics2DEffectors);
		runPhysics2DEffectorTransaction(
			scene,
			editor,
			() => setPhysics2DEffector(scene, { id: created.id, expectedRevision: 1, type: "area", forceAngle: 30 }, { editor }),
			changed
		);
		const areaRaw = structuredClone(scene.metadata.babylonEditorPhysics2DEffectors);
		expect(areaRaw[0]).toMatchObject({ revision: 2, type: "area", forceAngle: 30 });
		undo();
		expect(scene.metadata.babylonEditorPhysics2DEffectors).toEqual(pointRaw);
		redo();
		expect(scene.metadata.babylonEditorPhysics2DEffectors).toEqual(areaRaw);

		runPhysics2DEffectorTransaction(scene, editor, () => deletePhysics2DEffector(scene, { id: created.id, expectedRevision: 2 }, { editor }), changed);
		expect(listPhysics2DEffectors(scene).effectors).toEqual([]);
		undo();
		expect(scene.metadata.babylonEditorPhysics2DEffectors).toEqual(areaRaw);
		redo();
		expect(listPhysics2DEffectors(scene).effectors).toEqual([]);
		expect(changed).toHaveBeenCalled();
	});

	test("resynchronizes the live controller immediately and rejects malformed restore snapshots atomically", () => {
		const source = new TransformNode("Area", scene);
		const target = new TransformNode("Target", scene);
		setPhysics2DBody(scene, { nodeId: source.id, bodyType: "static", collider: { shape: "box", size: [100, 100] }, usedByEffector: true }, { editor });
		setPhysics2DBody(scene, { nodeId: target.id, collider: { shape: "circle", radius: 10 }, gravity: [0, 0] }, { editor });
		createPhysics2DEffector(scene, { id: "live-area", nodeId: source.id, type: "area", forceMagnitude: 100, forceAngle: 0 }, { editor });
		setPhysics2DSimulationPaused(scene, true);
		stepPausedPhysics2DSimulation(scene, 0.1);
		expect(listPhysics2D(scene).bodies.find((body: any) => body.nodeId === target.id).velocity[0]).toBeGreaterThan(0);
		expect(getPhysics2DSimulationControl(scene).lastSteppedBodies).toBe(2);

		const before = capturePhysics2DEffectorSnapshot(scene);
		expect(() => restorePhysics2DEffectorSnapshot(scene, { present: true, value: [{ id: "broken" }] }, { editor })).toThrow("requires valid identity");
		expect(capturePhysics2DEffectorSnapshot(scene)).toEqual(before);
	});
});
