import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";
import { Physics2DEffectorType } from "babylonjs-editor-tools";

import { Physics2DEffectorInspector } from "../../src/editor/layout/inspector/mesh/physics2d-effector";
import { createPhysics2DEffector, setPhysics2DBody } from "../../src/mcp/physics2d/physics2d";

describe("editor/physics2d-effector-inspector", () => {
	test("renders creation for all five families and complete type-specific authoring controls", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const editor = { layout: { inspector: { forceUpdate: vi.fn() } } } as any;
		const expected: Record<Physics2DEffectorType, string[]> = {
			point: ["Force Magnitude", "Force Variation", "Distance Scale", "Linear Drag", "Angular Drag", "Force Source", "Force Target", "Force Mode"],
			area: ["Force Magnitude", "Force Variation", "Force Angle", "Linear Drag", "Angular Drag", "Force Target", "Use Global Angle"],
			surface: ["Speed (cm/s)", "Speed Variation", "Force Scale", "Use Contact Force", "Use Friction", "Use Bounce"],
			platform: ["Rotational Offset", "Surface Arc", "Side Arc", "Use One Way", "Use One Way Grouping", "Use Side Friction", "Use Side Bounce"],
			buoyancy: ["Surface Level", "Density", "Linear Drag", "Angular Drag", "Flow Angle", "Flow Magnitude", "Flow Variation"],
		};

		const empty = new TransformNode("Empty", scene);
		setPhysics2DBody(scene, { nodeId: empty.id, bodyType: "static", collider: { shape: "box", size: [100, 100] }, usedByEffector: true }, { editor });
		const emptyMarkup = renderToStaticMarkup(createElement(Physics2DEffectorInspector, { mesh: empty as any, editor }));
		["Add Point", "Add Area", "Add Surface", "Add Platform", "Add Buoyancy"].forEach((label) => expect(emptyMarkup).toContain(label));

		(Object.keys(expected) as Physics2DEffectorType[]).forEach((type) => {
			const node = new TransformNode(type, scene);
			setPhysics2DBody(scene, { nodeId: node.id, bodyType: "static", collider: { shape: "box", size: [100, 100] }, usedByEffector: true }, { editor });
			createPhysics2DEffector(scene, { id: `${type}-inspector`, nodeId: node.id, type }, { editor });
			const markup = renderToStaticMarkup(createElement(Physics2DEffectorInspector, { mesh: node as any, editor }));
			expect(markup).toContain("Collider Mask");
			expect(markup).toContain("Contract v2");
			expected[type].forEach((label) => expect(markup).toContain(label));
		});

		scene.dispose();
		engine.dispose();
	});
});
