import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

import { configureNavAgents } from "../../src/loading/nav-agents";

describe("loading/nav agents", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("restores deterministic local avoidance while agents follow exported paths", () => {
		const first = new TransformNode("First", scene);
		const second = new TransformNode("Second", scene);
		second.position.y = 1;
		scene.metadata = {
			babylonEditorNavAgents: [
				{ id: "first", nodeId: first.id, path: [[0, 0, 0], [100, 0, 0]], pathIndex: 1, isMoving: true, maxSpeed: 1, radius: 10, avoidanceRadius: 20, avoidanceWeight: 1 },
				{ id: "second", nodeId: second.id, path: [[0, 1, 0], [100, 1, 0]], pathIndex: 1, isMoving: true, maxSpeed: 1, radius: 10, avoidanceRadius: 20, avoidanceWeight: 1 },
			],
		};

		configureNavAgents(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(first.position.x).toBeGreaterThan(0);
		expect(first.position.y).toBeLessThan(0);
	});
});
