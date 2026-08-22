import { describe, expect, test } from "vitest";

import { ArcRotateCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { getArcRotateCameraAxisTransition } from "../../../src/editor/layout/preview/axis";

describe("preview axis helper", () => {
	test("maps cardinal positions to the closest ArcRotateCamera orbit", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new ArcRotateCamera("camera", 0.7, 1.1, 10, new Vector3(2, 3, 4), scene);

		expect(getArcRotateCameraAxisTransition(camera, camera.target.add(new Vector3(100, 0, 0)))).toEqual({ alpha: 0, beta: Math.PI / 2, radius: 100 });
		expect(getArcRotateCameraAxisTransition(camera, camera.target.add(new Vector3(0, 100, 0)))).toEqual({ alpha: 0.7, beta: 0, radius: 100 });
		expect(getArcRotateCameraAxisTransition(camera, camera.target.add(new Vector3(0, -100, 0)))).toEqual({ alpha: 0.7, beta: Math.PI, radius: 100 });

		camera.alpha = 3.1;
		const wrapped = getArcRotateCameraAxisTransition(camera, camera.target.add(new Vector3(Math.cos(-3.1), 0, Math.sin(-3.1)).scale(100)));
		expect(wrapped.alpha).toBeGreaterThan(Math.PI);
		expect(wrapped.alpha - camera.alpha).toBeLessThan(0.1);

		scene.dispose();
		engine.dispose();
	});
});
