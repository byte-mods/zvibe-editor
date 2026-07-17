import { describe, expect, test } from "vitest";

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import { configureSplineFollowers } from "../../src/loading/splines";

describe("loading/splines-bezier", () => {
	test("advances exported followers along persisted Bezier knot paths", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const spline = new Mesh("Spline", scene);
		spline.metadata = {
			type: "Spline",
			knots: [
				{ position: [0, 0, 0], inTangent: [0, 0, 0], outTangent: [0, 10, 0] },
				{ position: [10, 0, 0], inTangent: [0, 10, 0], outTangent: [0, 0, 0] },
			],
		};
		const follower = new Mesh("Follower", scene);
		follower.metadata = { babylonEditorSplineFollower: { splineId: spline.id, speed: 100, t: 0, loop: false, orientToPath: true } };
		configureSplineFollowers(scene);
		engine.getDeltaTime = () => 100;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(follower.position.y).toBeGreaterThan(0);
		scene.dispose();
		engine.dispose();
	});
});
