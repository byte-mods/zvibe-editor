import { afterEach, describe, expect, test } from "vitest";

import { AnimationGroup, NullEngine, Scene } from "babylonjs";

import { resolveAnimationWindowGroupName } from "../../src/editor/layout/animation/window";

describe("editor/animation-window", () => {
	let engine: NullEngine | null = null;

	afterEach(() => {
		engine?.dispose();
		engine = null;
	});

	test("falls back safely when a requested group belonged to a disposed scene", () => {
		engine = new NullEngine();
		const scene = new Scene(engine);

		expect(resolveAnimationWindowGroupName(scene, "Disposed Scene Group")).toBe("");

		new AnimationGroup("Current Scene Group", scene);
		expect(resolveAnimationWindowGroupName(scene, "Disposed Scene Group")).toBe("Current Scene Group");
		expect(resolveAnimationWindowGroupName(scene, "Current Scene Group")).toBe("Current Scene Group");
	});
});
