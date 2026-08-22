import { describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";

import { buildPhysics2DEffectorViewportModel, EditorPhysics2DEffectorViewport } from "../../src/editor/layout/preview/physics2d-effectors";
import { createPhysics2DEffector, setPhysics2DBody, setPhysics2DEffector } from "../../src/mcp/physics2d/physics2d";

describe("editor/physics2d-effector-viewport", () => {
	test("builds source volumes and editable directions, arcs, and world-Y Buoyancy surfaces in solver frames", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;

		const area = new TransformNode("Area", scene);
		area.position.set(10, 20, 0);
		area.rotation.z = Math.PI / 2;
		setPhysics2DBody(scene, { nodeId: area.id, bodyType: "static", collider: { shape: "box", size: [100, 100] }, usedByEffector: true }, { editor });
		const areaEffector = createPhysics2DEffector(scene, { id: "area-viewport", nodeId: area.id, type: "area", forceAngle: 0, useGlobalAngle: false }, { editor }) as any;
		const localArea = buildPhysics2DEffectorViewportModel(scene, area.id)!;
		const localDirection = localArea.handles.find((handle) => handle.kind === "area-angle")!.point;
		expect(localDirection.x).toBeCloseTo(10, 5);
		expect(localDirection.y).toBeGreaterThan(20);
		expect(localArea.lines[0]).toHaveLength(5);

		setPhysics2DEffector(scene, { id: areaEffector.id, expectedRevision: areaEffector.revision, useGlobalAngle: true }, { editor });
		const globalDirection = buildPhysics2DEffectorViewportModel(scene, area.id)!.handles.find((handle) => handle.kind === "area-angle")!.point;
		expect(globalDirection.x).toBeGreaterThan(10);
		expect(globalDirection.y).toBeCloseTo(20, 5);
		const resized = setPhysics2DBody(scene, { nodeId: area.id, expectedRevision: 1, collider: { shape: "box", size: [200, 100] } }, { editor }) as any;
		const resizedModel = buildPhysics2DEffectorViewportModel(scene, area.id)!;
		expect(resizedModel.bodyRevision).toBe(resized.revision);
		expect(resizedModel.handles.find((handle) => handle.kind === "area-angle")!.point.x).toBeGreaterThan(globalDirection.x);

		const platform = new TransformNode("Platform", scene);
		platform.rotation.z = Math.PI / 2;
		setPhysics2DBody(scene, { nodeId: platform.id, bodyType: "static", collider: { shape: "box", size: [120, 20] }, usedByEffector: true }, { editor });
		createPhysics2DEffector(scene, { id: "platform-viewport", nodeId: platform.id, type: "platform", rotationalOffset: 0, surfaceArc: 90, sideArc: 20 }, { editor });
		const platformModel = buildPhysics2DEffectorViewportModel(scene, platform.id)!;
		const platformDirection = platformModel.handles.find((handle) => handle.kind === "platform-angle")!.point;
		expect(platformDirection.x).toBeLessThan(0);
		expect(platformDirection.y).toBeCloseTo(0, 5);
		expect(platformModel.handles.some((handle) => handle.kind === "platform-arc")).toBe(true);

		const liquid = new TransformNode("Liquid", scene);
		liquid.position.set(100, 20, 0);
		liquid.scaling = new Vector3(1, 2, 1);
		setPhysics2DBody(scene, { nodeId: liquid.id, bodyType: "static", collider: { shape: "box", size: [200, 100] }, usedByEffector: true }, { editor });
		createPhysics2DEffector(scene, { id: "buoyancy-viewport", nodeId: liquid.id, type: "buoyancy", surfaceLevel: 5, flowAngle: 90 }, { editor });
		const buoyancyModel = buildPhysics2DEffectorViewportModel(scene, liquid.id)!;
		const surface = buoyancyModel.handles.find((handle) => handle.kind === "buoyancy-surface")!.point;
		const flow = buoyancyModel.handles.find((handle) => handle.kind === "buoyancy-flow")!.point;
		expect(surface.y).toBe(30);
		expect(flow.x).toBeCloseTo(100, 5);
		expect(flow.y).toBeGreaterThan(30);
		expect(buoyancyModel.truncated).toBe(false);

		scene.dispose();
		engine.dispose();
	});

	test("creates graph-hidden non-serializable meshes and disposes every visual resource", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const node = new TransformNode("Area", scene);
		setPhysics2DBody(scene, { nodeId: node.id, bodyType: "static", collider: { shape: "circle", radius: 50 }, usedByEffector: true }, { editor });
		createPhysics2DEffector(scene, { id: "viewport-lifecycle", nodeId: node.id, type: "area" }, { editor });
		const viewport = new EditorPhysics2DEffectorViewport();
		viewport.sync(scene, node);
		const visuals = scene.meshes.filter((mesh) => mesh.name.startsWith("Physics 2D"));
		expect(visuals.length).toBeGreaterThan(1);
		expect(visuals.every((mesh) => mesh.metadata?.doNotSerialize === true && mesh.metadata?.notVisibleInGraph === true)).toBe(true);
		expect(visuals.filter((mesh) => mesh.metadata?.babylonEditorPhysics2DEffectorHandle).every((mesh) => mesh.isPickable)).toBe(true);

		viewport.dispose(true);
		expect(scene.meshes.some((mesh) => mesh.name.startsWith("Physics 2D"))).toBe(false);
		scene.dispose();
		engine.dispose();
	});
});
