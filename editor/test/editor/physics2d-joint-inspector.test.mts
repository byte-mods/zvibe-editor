import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import { Physics2DSceneInspector } from "../../src/editor/layout/inspector/scene/physics2d-joints";
import { createPhysics2DJoint, setPhysics2DBody, setPhysics2DSettings } from "../../src/mcp/physics2d/physics2d";

describe("editor Physics 2D joint Inspector", () => {
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = { layout: { inspector: { forceUpdate: vi.fn() } } };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("renders split solver settings and all nine creation choices", () => {
		const emptyMarkup = renderToStaticMarkup(createElement(Physics2DSceneInspector, { scene, editor, onChanged: vi.fn() }));
		expect(emptyMarkup).toContain("Velocity Iterations");
		expect(emptyMarkup).toContain("Position Iterations");
		expect(emptyMarkup).toContain("Add a Rigidbody 2D");
		expect(scene.metadata).toBeNull();

		const body = new TransformNode("Body", scene);
		setPhysics2DBody(scene, { nodeId: body.id, collider: { shape: "circle", radius: 10 } }, { editor });
		const markup = renderToStaticMarkup(createElement(Physics2DSceneInspector, { scene, editor, onChanged: vi.fn() }));
		for (const type of ["distance", "fixed", "friction", "hinge", "relative", "slider", "spring", "target", "wheel"]) {
			expect(markup).toContain(`value="${type}"`);
		}
	});

	test("renders every common and type-specific Joint2D property", () => {
		const first = new TransformNode("First Body", scene);
		const second = new TransformNode("Second Body", scene);
		second.position.x = 100;
		setPhysics2DBody(scene, { nodeId: first.id, collider: { shape: "circle", radius: 10 } }, { editor });
		setPhysics2DBody(scene, { nodeId: second.id, collider: { shape: "circle", radius: 10 } }, { editor });
		for (const type of ["distance", "fixed", "friction", "hinge", "relative", "slider", "spring", "wheel"]) {
			createPhysics2DJoint(scene, { id: `joint-${type}`, type, firstNodeId: first.id, secondNodeId: second.id }, { editor });
		}
		createPhysics2DJoint(scene, { id: "joint-target", type: "target", firstNodeId: first.id }, { editor });
		setPhysics2DSettings(scene, { expectedRevision: 1, velocityIterations: 11, positionIterations: 7 }, { editor });

		const markup = renderToStaticMarkup(createElement(Physics2DSceneInspector, { scene, editor, onChanged: vi.fn() }));
		for (const label of [
			"Enabled",
			"Connected Collision",
			"Break Action",
			"Break Force",
			"Break Torque",
			"Auto Connected Anchor",
			"Connected Anchor",
			"Max Distance Only",
			"Reference Angle",
			"Frequency",
			"Damping Ratio",
			"Maximum Force",
			"Maximum Torque",
			"Use Limits",
			"Minimum Angle",
			"Maximum Angle",
			"Use Motor",
			"Motor Speed",
			"Maximum Motor Torque",
			"Linear Offset",
			"Angular Offset",
			"Correction Scale",
			"Axis Angle",
			"Lower Translation",
			"Upper Translation",
			"Maximum Motor Force",
			"Target X",
			"Suspension Angle",
		]) {
			expect(markup).toContain(label);
		}
		expect(markup).toContain('value="11"');
		expect(markup).toContain('value="7"');
	});

	test("contains invalid persisted metadata instead of crashing the Scene Inspector", () => {
		scene.metadata = { babylonEditorPhysics2DJoints: "invalid" };
		const markup = renderToStaticMarkup(createElement(Physics2DSceneInspector, { scene, editor, onChanged: vi.fn() }));
		expect(markup).toContain("Physics 2D joints must be an array");
	});
});
