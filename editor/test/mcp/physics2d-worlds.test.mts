import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";

import {
	createPhysics2DWorld,
	deletePhysics2DWorld,
	getPhysics2DDebugRendering,
	getPhysics2DSettings,
	removePhysics2DBody,
	setPhysics2DBody,
	setPhysics2DWorld,
} from "../../src/mcp/physics2d/physics2d";

describe("mcp/physics2d world authoring", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, exact-revision updates, guards, and deletes a bounded world", () => {
		const created = createPhysics2DWorld(scene, { id: "wall", name: "Wall", expectedRevision: 1 }, options);
		expect(created).toMatchObject({ id: "wall", transformPlane: { mode: "xy" } });
		const updated = setPhysics2DWorld(
			scene,
			{
				id: "wall",
				expectedRevision: 2,
				transformPlane: { mode: "custom", origin: [10, 20, 30], xAxis: [0, 1, 0], yAxis: [0, 0, 1] },
				transformWriteMode: "tween",
				contactFilterMode: "none",
				worldDrawing: true,
				alwaysDraw: true,
			},
			options
		);
		expect(updated).toMatchObject({ id: "wall", transformWriteMode: "tween", contactFilterMode: "none", transformPlane: { mode: "custom" } });
		expect(() => setPhysics2DWorld(scene, { id: "wall", expectedRevision: 2, enabled: false }, options)).toThrow("current revision is 3");
		expect(deletePhysics2DWorld(scene, { id: "wall", expectedRevision: 3 }, options)).toEqual({ deleted: true, id: "wall", settingsRevision: 4 });
	});

	test("assigns bodies to worlds, guards deletion, and returns paginated camera debug evidence", () => {
		new FreeCamera("debug-camera", Vector3.Zero(), scene);
		const node = new TransformNode("body", scene);
		createPhysics2DWorld(scene, { id: "floor", expectedRevision: 1, worldDrawing: true, alwaysDraw: true, debugCameraIds: ["debug-camera"] }, options);
		const body = setPhysics2DBody(
			scene,
			{ nodeId: node.id, expectedRevision: 0, worldId: "floor", worldDrawing: true, collider: { shape: "box", size: [10, 20], worldDrawing: true } },
			options
		);
		expect(body).toMatchObject({ worldId: "floor", worldDrawing: true, collider: { worldDrawing: true } });
		expect(() => deletePhysics2DWorld(scene, { id: "floor", expectedRevision: 2 }, options)).toThrow("still owns bodies");
		const debug = getPhysics2DDebugRendering(scene, {
			cameraIds: ["debug-camera"],
			limit: 1,
			customElements: [
				{
					id: "axis",
					worldId: "floor",
					points: [
						[0, 0],
						[1, 0],
					],
				},
			],
		});
		expect(debug).toMatchObject({ available: true, cameraIds: ["debug-camera"], cursor: 0, nextCursor: 1 });
		expect(debug.total).toBe(2);
		removePhysics2DBody(scene, { nodeId: node.id, expectedRevision: body.revision }, options);
		const revision = getPhysics2DSettings(scene).revision;
		expect(deletePhysics2DWorld(scene, { id: "floor", expectedRevision: revision }, options).deleted).toBe(true);
	});
});
