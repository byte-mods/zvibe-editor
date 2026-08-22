import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import { Physics2DBodyInspector } from "../../src/editor/layout/inspector/mesh/physics2d-body";
import { setPhysics2DBody } from "../../src/mcp/physics2d/physics2d";

describe("editor Physics 2D body Inspector", () => {
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

	test("renders every shared Rigidbody Collider motion mass constraint and layer control", () => {
		const node = new TransformNode("Complete Body", scene);
		setPhysics2DBody(scene, { nodeId: node.id, bodyType: "kinematic", collider: { shape: "capsule", size: [40, 100] } }, { editor });
		const markup = renderToStaticMarkup(createElement(Physics2DBodyInspector, { node, editor }));

		for (const label of [
			"Rigidbody 2D + Collider 2D",
			"Body Type",
			"kinematic",
			"Collision Detection",
			"continuous",
			"Enabled",
			"Is Trigger",
			"Used by Effector",
			"Shape",
			"box",
			"circle",
			"capsule",
			"polygon",
			"edge",
			"Offset X",
			"Density",
			"Capsule Direction",
			"Velocity",
			"Angular Velocity",
			"Gravity Scale",
			"Linear Damping",
			"Auto Mass",
			"Auto Inertia",
			"Auto Center",
			"Center of Mass",
			"Freeze Rotation",
			"Physics Material 2D",
			"Friction Override",
			"Restitution Override",
			"Collision Layer",
			"Override Priority",
			"Include Layers",
			"Exclude Layers",
			"Force Send Layers",
			"Force Receive Layers",
			"Callback Layers",
			"Contact Capture Layers",
		]) {
			expect(markup).toContain(label);
		}
	});

	test("renders polygon and edge authoring plus the empty add state", () => {
		const empty = new TransformNode("Empty", scene);
		expect(renderToStaticMarkup(createElement(Physics2DBodyInspector, { node: empty, editor }))).toContain("Add Rigidbody 2D");
		expect(scene.metadata).toBeNull();

		const polygon = new TransformNode("Polygon", scene);
		setPhysics2DBody(
			scene,
			{
				nodeId: polygon.id,
				collider: {
					shape: "polygon",
					points: [
						[-10, -10],
						[10, -10],
						[0, 10],
					],
				},
			},
			{ editor }
		);
		const polygonMarkup = renderToStaticMarkup(createElement(Physics2DBodyInspector, { node: polygon, editor }));
		expect(polygonMarkup).toContain("Polygon Points");
		expect(polygonMarkup).toContain("Compound Contours JSON");
		expect(polygonMarkup).toContain("Holes + Islands");

		const edge = new TransformNode("Edge", scene);
		setPhysics2DBody(
			scene,
			{
				nodeId: edge.id,
				collider: {
					shape: "edge",
					points: [
						[-10, 0],
						[10, 0],
					],
					parts: [
						[
							[-10, 1],
							[10, 1],
							[10, -1],
							[-10, -1],
						],
					],
					edgeRadius: 1,
				},
			},
			{ editor }
		);
		const edgeMarkup = renderToStaticMarkup(createElement(Physics2DBodyInspector, { node: edge, editor }));
		expect(edgeMarkup).toContain("Edge Radius");
		expect(edgeMarkup).toContain("Edge Points");
	});
});
