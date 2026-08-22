import { describe, expect, test, vi } from "vitest";

import { NullEngine, Ray, Scene, TransformNode, Vector3 } from "babylonjs";

import { buildPhysics2DJointViewportModel, EditorPhysics2DJointViewport, getPhysics2DJointHandlePatch } from "../../src/editor/layout/preview/physics2d-joints";
import { createPhysics2DJoint, listPhysics2DJoints, setPhysics2DBody } from "../../src/mcp/physics2d/physics2d";
import { clearUndoRedo, getUndoRedoState, redo, undo } from "../../src/tools/undoredo";

describe("editor/physics2d-joint-viewport", () => {
	test("builds all nine joint families in their solver frames with editable family handles", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const first = new TransformNode("First", scene);
		const second = new TransformNode("Second", scene);
		first.position.set(10, 20, 0);
		first.rotation.z = Math.PI / 2;
		second.position.set(110, 20, 0);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 }, centerOfMass: [5, 0], useAutoCenterOfMass: false }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		for (const type of ["distance", "fixed", "friction", "hinge", "relative", "slider", "spring", "wheel"]) {
			createPhysics2DJoint(
				scene,
				{
					id: `viewport-${type}`,
					type,
					firstNodeId: first.id,
					secondNodeId: second.id,
					...(type === "hinge" ? { useLimits: true, minAngle: -Math.PI / 4, maxAngle: Math.PI / 4 } : {}),
					...(type === "slider" ? { useLimits: true, lowerTranslation: -25, upperTranslation: 40 } : {}),
				},
				{ editor }
			);
		}
		createPhysics2DJoint(scene, { id: "viewport-target", type: "target", firstNodeId: first.id, target: [60, 80] }, { editor });

		const model = buildPhysics2DJointViewportModel(scene, first.id)!;
		expect(model.jointCount).toBe(9);
		expect(model.truncated).toBe(false);
		expect(model.lines.length).toBeGreaterThan(20);
		for (const kind of [
			"first-anchor",
			"second-anchor",
			"rest-length",
			"hinge-min-angle",
			"hinge-max-angle",
			"relative-offset",
			"relative-angle",
			"slider-axis",
			"slider-lower-limit",
			"slider-upper-limit",
			"target",
			"wheel-axis",
		]) {
			expect(
				model.handles.some((handle) => handle.kind === kind),
				kind
			).toBe(true);
		}
		const target = model.handles.find((handle) => handle.kind === "target")!.point;
		expect(target.asArray()).toEqual([60, 80, -4]);
		const relative = model.handles.find((handle) => handle.kind === "relative-offset")!.point;
		expect(relative.x).toBeCloseTo(110, 5);
		// Relative constraints originate at the first body's authored center of mass, not its TransformNode origin.
		expect(relative.y).toBeCloseTo(25, 5);
		expect(model.key).toContain("viewport-hinge:1");

		scene.dispose();
		engine.dispose();
	});

	test("uses fixed-world anchors and fails closed on malformed metadata without mutation", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const body = new TransformNode("World Body", scene);
		body.position.set(10, 20, 0);
		setPhysics2DBody(scene, { nodeId: body.id, collider: { shape: "box", size: [20, 20] } }, { editor });
		createPhysics2DJoint(scene, { id: "world", type: "hinge", firstNodeId: body.id, anchor: [30, 50] }, { editor });
		const before = structuredClone(scene.metadata);
		const model = buildPhysics2DJointViewportModel(scene, body.id)!;
		expect(model.handles.find((handle) => handle.kind === "second-anchor")!.point.asArray()).toEqual([30, 50, -4]);
		expect(scene.metadata).toEqual(before);

		scene.metadata.babylonEditorPhysics2DJoints = "invalid";
		expect(buildPhysics2DJointViewportModel(scene, body.id)).toBeNull();
		scene.dispose();
		engine.dispose();
	});

	test("caps attached joint work deterministically", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const first = new TransformNode("Bounded First", scene);
		const second = new TransformNode("Bounded Second", scene);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		for (let index = 0; index < 140; index++) {
			createPhysics2DJoint(scene, { id: `bounded-${index}`, type: "fixed", firstNodeId: first.id, secondNodeId: second.id }, { editor });
		}
		const model = buildPhysics2DJointViewportModel(scene, first.id)!;
		expect(model.truncated).toBe(true);
		expect(model.jointCount).toBeLessThanOrEqual(128);
		expect(model.lines.flat().length).toBeLessThanOrEqual(4096);
		expect(model.handles.length).toBeLessThanOrEqual(512);
		scene.dispose();
		engine.dispose();
	});

	test("creates reusable graph-hidden visuals with only explicit handles pickable and disposes them", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const first = new TransformNode("Lifecycle First", scene);
		const second = new TransformNode("Lifecycle Second", scene);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		createPhysics2DJoint(scene, { id: "lifecycle", type: "slider", firstNodeId: first.id, secondNodeId: second.id, useLimits: true }, { editor });

		const viewport = new EditorPhysics2DJointViewport();
		viewport.sync(scene, first);
		const initial = scene.meshes.filter((mesh) => mesh.name.startsWith("Physics 2D Joint"));
		expect(initial.length).toBeGreaterThan(1);
		expect(initial.every((mesh) => mesh.metadata?.doNotSerialize === true && mesh.metadata?.notVisibleInGraph === true)).toBe(true);
		expect(initial.filter((mesh) => mesh.metadata?.babylonEditorPhysics2DJointHandle).every((mesh) => mesh.isPickable)).toBe(true);
		expect(initial.find((mesh) => mesh.name === "Physics 2D Joint Visuals")?.isPickable).toBe(false);

		viewport.sync(scene, first);
		expect(scene.meshes.filter((mesh) => mesh.name.startsWith("Physics 2D Joint"))).toEqual(initial);
		viewport.sync(scene, new TransformNode("Unconnected", scene));
		expect(scene.meshes.some((mesh) => mesh.name.startsWith("Physics 2D Joint"))).toBe(false);

		viewport.sync(scene, first);
		expect(scene.materials.some((material) => material.name === "Physics 2D Joint Handle Material")).toBe(true);
		viewport.dispose(true);
		expect(scene.meshes.some((mesh) => mesh.name.startsWith("Physics 2D Joint"))).toBe(false);
		expect(scene.materials.some((material) => material.name === "Physics 2D Joint Handle Material")).toBe(false);
		scene.dispose();
		engine.dispose();
	});

	test("converts every handle family into bounded local or world canonical fields", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const first = new TransformNode("Patch First", scene);
		const second = new TransformNode("Patch Second", scene);
		first.position.set(10, 20, 0);
		first.rotation.z = Math.PI / 2;
		second.position.set(100, 50, 0);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 }, centerOfMass: [5, 0], useAutoCenterOfMass: false }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		createPhysics2DJoint(
			scene,
			{ id: "patch-distance", type: "distance", firstNodeId: first.id, secondNodeId: second.id, firstAnchor: [0, 0], secondAnchor: [0, 0] },
			{ editor }
		);
		createPhysics2DJoint(
			scene,
			{ id: "patch-hinge", type: "hinge", firstNodeId: first.id, secondNodeId: second.id, firstAnchor: [0, 0], secondAnchor: [0, 0], useLimits: true },
			{ editor }
		);
		createPhysics2DJoint(scene, { id: "patch-relative", type: "relative", firstNodeId: first.id, secondNodeId: second.id }, { editor });
		createPhysics2DJoint(
			scene,
			{ id: "patch-slider", type: "slider", firstNodeId: first.id, secondNodeId: second.id, firstAnchor: [0, 0], secondAnchor: [0, 0], useLimits: true },
			{ editor }
		);
		createPhysics2DJoint(scene, { id: "patch-wheel", type: "wheel", firstNodeId: first.id, secondNodeId: second.id, firstAnchor: [0, 0], secondAnchor: [0, 0] }, { editor });
		createPhysics2DJoint(scene, { id: "patch-target", type: "target", firstNodeId: first.id }, { editor });

		const firstAnchor = getPhysics2DJointHandlePatch(scene, "patch-distance", "first-anchor", [10, 30]) as { firstAnchor: [number, number] };
		expect(firstAnchor.firstAnchor[0]).toBeCloseTo(10, 10);
		expect(firstAnchor.firstAnchor[1]).toBeCloseTo(0, 10);
		const secondAnchor = getPhysics2DJointHandlePatch(scene, "patch-distance", "second-anchor", [110, 50]) as { secondAnchor: [number, number] };
		expect(secondAnchor.secondAnchor[0]).toBeCloseTo(10, 10);
		expect(secondAnchor.secondAnchor[1]).toBeCloseTo(0, 10);
		expect(getPhysics2DJointHandlePatch(scene, "patch-distance", "rest-length", [10, 70])).toEqual({ distance: 50 });
		expect(getPhysics2DJointHandlePatch(scene, "patch-hinge", "hinge-min-angle", [10, -30])).toMatchObject({ minAngle: expect.any(Number) });
		expect(getPhysics2DJointHandlePatch(scene, "patch-hinge", "hinge-max-angle", [10, 70])).toMatchObject({ maxAngle: expect.any(Number) });
		const relativeOffset = getPhysics2DJointHandlePatch(scene, "patch-relative", "relative-offset", [110, 25]) as { linearOffset: [number, number] };
		expect(relativeOffset.linearOffset[0]).toBeCloseTo(0, 10);
		expect(relativeOffset.linearOffset[1]).toBeCloseTo(-100, 10);
		expect(getPhysics2DJointHandlePatch(scene, "patch-relative", "relative-angle", [65, 25])).toMatchObject({ angularOffset: expect.any(Number) });
		expect(getPhysics2DJointHandlePatch(scene, "patch-slider", "slider-axis", [10, 70])).toEqual({ angle: 0 });
		expect(getPhysics2DJointHandlePatch(scene, "patch-slider", "slider-lower-limit", [10, -10])).toEqual({ lowerTranslation: -30 });
		expect(getPhysics2DJointHandlePatch(scene, "patch-slider", "slider-upper-limit", [10, 80])).toEqual({ upperTranslation: 60 });
		expect(getPhysics2DJointHandlePatch(scene, "patch-wheel", "wheel-axis", [60, 20])).toMatchObject({ angle: expect.any(Number) });
		expect(getPhysics2DJointHandlePatch(scene, "patch-target", "target", [1e9, -1e9])).toEqual({ target: [1e6, -1e6] });
		expect(getPhysics2DJointHandlePatch(scene, "patch-target", "first-anchor", [0, 0])).toBeNull();
		first.position.x = 2_000_000;
		const translatedAnchor = getPhysics2DJointHandlePatch(scene, "patch-distance", "first-anchor", [2_000_000, 30]) as { firstAnchor: [number, number] };
		expect(translatedAnchor.firstAnchor[0]).toBeCloseTo(10, 10);
		expect(translatedAnchor.firstAnchor[1]).toBeCloseTo(0, 10);
		scene.dispose();
		engine.dispose();
	});

	test("suppresses no-op drag revisions caused only by rotated-frame floating-point noise", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const first = new TransformNode("No-op First", scene);
		const second = new TransformNode("No-op Second", scene);
		first.rotation.z = Math.PI / 3;
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		createPhysics2DJoint(scene, { id: "no-op", type: "distance", firstNodeId: first.id, secondNodeId: second.id, firstAnchor: [10, 0] }, { editor });
		clearUndoRedo();

		const viewport = new EditorPhysics2DJointViewport();
		viewport.sync(scene, first);
		const handle = scene.meshes.find((mesh) => mesh.metadata?.babylonEditorPhysics2DJointHandle?.kind === "first-anchor")!;
		vi.spyOn(scene, "pick").mockReturnValue({ pickedMesh: handle } as any);
		expect(viewport.begin(scene, 0, 0)).toBe(true);
		vi.spyOn(scene, "createPickingRay").mockReturnValue(new Ray(new Vector3(handle.position.x, handle.position.y, 10), new Vector3(0, 0, -1)));
		expect(viewport.move(scene, {} as any, 0, 0, editor)).toBe(true);
		expect(viewport.finish(scene, editor)).toBe(true);
		expect(listPhysics2DJoints(scene).joints[0]).toMatchObject({ revision: 1, firstAnchor: [10, 0] });
		expect(getUndoRedoState().undoCount).toBe(0);

		clearUndoRedo();
		viewport.dispose(true);
		scene.dispose();
		engine.dispose();
	});

	test("applies many live drag revisions as one exact Undo and Redo transaction", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const first = new TransformNode("Drag First", scene);
		const second = new TransformNode("Drag Second", scene);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		createPhysics2DJoint(scene, { id: "drag", type: "distance", firstNodeId: first.id, secondNodeId: second.id }, { editor });
		clearUndoRedo();

		const viewport = new EditorPhysics2DJointViewport();
		viewport.sync(scene, first);
		const handle = scene.meshes.find((mesh) => mesh.metadata?.babylonEditorPhysics2DJointHandle?.kind === "first-anchor")!;
		vi.spyOn(scene, "pick").mockReturnValue({ pickedMesh: handle } as any);
		expect(viewport.begin(scene, 0, 0)).toBe(true);
		const ray = vi.spyOn(scene, "createPickingRay");
		ray.mockReturnValueOnce(new Ray(new Vector3(20, 30, 10), new Vector3(0, 0, -1)));
		expect(viewport.move(scene, {} as any, 0, 0, editor)).toBe(true);
		ray.mockReturnValueOnce(new Ray(new Vector3(25, 35, 10), new Vector3(0, 0, -1)));
		expect(viewport.move(scene, {} as any, 0, 0, editor)).toBe(true);
		expect(viewport.finish(scene, editor)).toBe(true);
		expect(getUndoRedoState().undoCount).toBe(1);
		expect(listPhysics2DJoints(scene).joints[0]).toMatchObject({ revision: 3, firstAnchor: [25, 35] });
		undo();
		expect(listPhysics2DJoints(scene).joints[0]).toMatchObject({ revision: 1, firstAnchor: [0, 0] });
		redo();
		expect(listPhysics2DJoints(scene).joints[0]).toMatchObject({ revision: 3, firstAnchor: [25, 35] });
		clearUndoRedo();
		viewport.dispose(true);
		scene.dispose();
		engine.dispose();
	});

	test("keeps pointer-captured visuals on their original selection and rolls reset cancellation back exactly", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const first = new TransformNode("Captured First", scene);
		const second = new TransformNode("Captured Second", scene);
		const unrelated = new TransformNode("New Selection", scene);
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		createPhysics2DJoint(scene, { id: "captured", type: "distance", firstNodeId: first.id, secondNodeId: second.id }, { editor });
		clearUndoRedo();

		const viewport = new EditorPhysics2DJointViewport();
		viewport.sync(scene, first);
		const handle = scene.meshes.find((mesh) => mesh.metadata?.babylonEditorPhysics2DJointHandle?.kind === "first-anchor")!;
		vi.spyOn(scene, "pick").mockReturnValue({ pickedMesh: handle } as any);
		expect(viewport.begin(scene, 0, 0)).toBe(true);
		vi.spyOn(scene, "createPickingRay").mockReturnValue(new Ray(new Vector3(40, 50, 10), new Vector3(0, 0, -1)));
		expect(viewport.move(scene, {} as any, 0, 0, editor)).toBe(true);

		viewport.sync(scene, unrelated);
		expect(scene.meshes.some((mesh) => mesh.metadata?.babylonEditorPhysics2DJointHandle?.selectedNodeId === first.id)).toBe(true);
		expect(viewport.cancel(scene, editor)).toBe(true);
		expect(listPhysics2DJoints(scene).joints[0]).toMatchObject({ revision: 1, firstAnchor: [0, 0] });
		expect(getUndoRedoState().undoCount).toBe(0);
		expect(viewport.cancel(scene, editor)).toBe(false);

		clearUndoRedo();
		viewport.dispose(true);
		scene.dispose();
		engine.dispose();
	});
});
