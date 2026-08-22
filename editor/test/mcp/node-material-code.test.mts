import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AddBlock, Color4, InputBlock, MeshBuilder, NodeMaterialBlockConnectionPointTypes, NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { addNodeMaterialCustomBlock } from "../../src/mcp/materials/materials";
import {
	connectNodeMaterialBlocks,
	disconnectNodeMaterialBlocks,
	getNodeMaterialCodeGraph,
	inspectNodeMaterialOptimization,
	optimizeNodeMaterialGraph,
	setNodeMaterialCustomBlock,
} from "../../src/mcp/materials/node-material-code";
import { addNodeMaterial } from "../../src/project/add/material";

describe("mcp/node-material-code", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("returns a bounded paginated graph with typed ports, reachability, edges, and an exact fingerprint", () => {
		const material = addNodeMaterial(scene);
		const source = new InputBlock("Source", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		const target = new AddBlock("Target");
		material.attachedBlocks.push(source, target);
		source.output.connectTo(target.left);

		const first = getNodeMaterialCodeGraph(scene, { materialId: material.id, query: "Source", offset: 0, limit: 1 }) as any;
		expect(first).toMatchObject({ count: 1, offset: 0, limit: 1, hasMore: false, edgeCount: 1 });
		expect(first.nodes[0]).toMatchObject({ name: "Source", outputs: [expect.objectContaining({ name: "output", typeName: "Float" })] });
		expect(first.edges[0]).toMatchObject({ sourceBlockId: source.uniqueId, targetBlockId: target.uniqueId, targetInput: "left" });
		expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
	});

	test("connects and disconnects exact ports while rejecting occupied inputs, stale guards, and cycles", () => {
		const material = addNodeMaterial(scene);
		const first = new InputBlock("First", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		const second = new InputBlock("Second", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		const left = new AddBlock("Left");
		const right = new AddBlock("Right");
		material.attachedBlocks.push(first, second, left, right);

		expect(
			connectNodeMaterialBlocks(
				scene,
				{ materialId: material.id, sourceBlockId: first.uniqueId, sourceOutput: "output", targetBlockId: left.uniqueId, targetInput: "left" },
				options
			)
		).toMatchObject({ connected: true });
		expect(() =>
			connectNodeMaterialBlocks(
				scene,
				{ materialId: material.id, sourceBlockId: second.uniqueId, sourceOutput: "output", targetBlockId: left.uniqueId, targetInput: "left" },
				options
			)
		).toThrow(/already connected/);
		expect(
			connectNodeMaterialBlocks(
				scene,
				{ materialId: material.id, sourceBlockId: second.uniqueId, sourceOutput: "output", targetBlockId: left.uniqueId, targetInput: "left", replace: true },
				options
			)
		).toMatchObject({ connected: true, replaced: { sourceBlockId: first.uniqueId } });
		connectNodeMaterialBlocks(
			scene,
			{ materialId: material.id, sourceBlockId: left.uniqueId, sourceOutput: "output", targetBlockId: right.uniqueId, targetInput: "left" },
			options
		);
		expect(() =>
			connectNodeMaterialBlocks(
				scene,
				{ materialId: material.id, sourceBlockId: right.uniqueId, sourceOutput: "output", targetBlockId: left.uniqueId, targetInput: "right" },
				options
			)
		).toThrow(/cycle/);
		expect(() =>
			disconnectNodeMaterialBlocks(scene, { materialId: material.id, targetBlockId: left.uniqueId, targetInput: "left", sourceBlockId: first.uniqueId }, options)
		).toThrow(/not expected block/);
		expect(
			disconnectNodeMaterialBlocks(
				scene,
				{ materialId: material.id, targetBlockId: left.uniqueId, targetInput: "left", sourceBlockId: second.uniqueId, sourceOutput: "output" },
				options
			)
		).toMatchObject({ disconnected: true });
		expect(left.left.connectedPoint).toBeNull();
	});

	test("updates a CustomBlock atomically and preserves compatible upstream and downstream wiring", () => {
		const material = addNodeMaterial(scene);
		const source = new InputBlock("Source", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		const target = new AddBlock("Target");
		material.attachedBlocks.push(source, target);
		addNodeMaterialCustomBlock(
			scene,
			{
				materialId: material.id,
				name: "doubleValue",
				target: "Fragment",
				functionName: "void doubleValue(float value, out float result)",
				code: "void doubleValue(float value, out float result) { result = value * 2.0; }",
				inputs: [{ name: "value", type: "Float" }],
				outputs: [{ name: "result", type: "Float" }],
			},
			options
		);
		const original = material.attachedBlocks.find((block) => block.name === "doubleValue")!;
		source.output.connectTo(original.getInputByName("value")!);
		original.getOutputByName("result")!.connectTo(target.left);

		const result = setNodeMaterialCustomBlock(
			scene,
			{
				materialId: material.id,
				blockId: original.uniqueId,
				code: "void doubleValue(float value, out float result) {\n  // retained behavior\n  result = value * 2.0;\n}",
				target: "VertexAndFragment",
			},
			options
		) as any;
		const replacement = material.attachedBlocks.find((block) => block.name === "doubleValue")!;
		expect(replacement).not.toBe(original);
		expect(replacement.getInputByName("value")!.connectedPoint).toBe(source.output);
		expect(target.left.connectedPoint).toBe(replacement.getOutputByName("result"));
		expect(result.block.options).toMatchObject({ target: "VertexAndFragment", code: expect.arrayContaining([expect.stringContaining("retained behavior")]) });
	});

	test("dry-runs connected-code optimization, rejects a stale lease, then compiles and atomically swaps the optimized material", () => {
		const material = addNodeMaterial(scene);
		const fragmentOutput = material._fragmentOutputNodes[0];
		const fragmentInput = fragmentOutput.inputs.find((input) => input.connectedPoint)!;
		const originalSource = fragmentInput.connectedPoint!;
		originalSource.disconnectFrom(fragmentInput);

		const zero = new InputBlock("Zero", undefined, NodeMaterialBlockConnectionPointTypes.Color4);
		zero.isConstant = true;
		zero.value = new Color4(0, 0, 0, 0);
		const add = new AddBlock("Redundant Add");
		material.attachedBlocks.push(zero, add);
		originalSource.connectTo(add.left);
		zero.output.connectTo(add.right);
		addNodeMaterialCustomBlock(
			scene,
			{
				materialId: material.id,
				name: "passColor",
				target: "Fragment",
				functionName: "void passColor(vec4 value, out vec4 result)",
				code: "// remove this comment\nvoid passColor(vec4 value, out vec4 result) {\n    result = value;\n}",
				inputs: [{ name: "value", type: "Color4" }],
				outputs: [{ name: "result", type: "Color4" }],
			},
			options
		);
		const custom = material.attachedBlocks.find((block) => block.name === "passColor")!;
		add.output.connectTo(custom.getInputByName("value")!);
		custom.getOutputByName("result")!.connectTo(fragmentInput);
		const mesh = MeshBuilder.CreateBox("Material User", {}, scene);
		mesh.material = material;

		const plan = inspectNodeMaterialOptimization(scene, { materialId: material.id }) as any;
		expect(plan.after.valid).toBe(true);
		expect(plan.actions.map((action: any) => action.type)).toEqual(expect.arrayContaining(["simplifyIdentityMath", "minifyCustomCode", "removeUnreachable"]));
		expect(plan.after.blockCount).toBeLessThan(plan.before.blockCount);
		const mutation = new InputBlock("Stale Mutation", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		material.attachedBlocks.push(mutation);
		expect(() => optimizeNodeMaterialGraph(scene, { materialId: material.id, expectedFingerprint: plan.fingerprint, confirm: true }, options)).toThrow(
			/changed after inspection/
		);
		expect(mesh.material).toBe(material);
		material.attachedBlocks = material.attachedBlocks.filter((block) => block !== mutation);

		const freshPlan = inspectNodeMaterialOptimization(scene, { materialId: material.id }) as any;
		const result = optimizeNodeMaterialGraph(scene, { materialId: material.id, expectedFingerprint: freshPlan.fingerprint, confirm: true }, options) as any;
		const optimized = scene.getMaterialById(material.id)!;
		expect(result).toMatchObject({ optimized: true, actionCount: freshPlan.actionCount, materialId: material.id });
		expect(optimized).not.toBe(material);
		expect(mesh.material).toBe(optimized);
		expect(optimized.attachedBlocks.some((block: any) => block.name === "Redundant Add")).toBe(false);
		const optimizedCustom = optimized.attachedBlocks.find((block: any) => block.name === "passColor") as any;
		expect(optimizedCustom.options.code.join("\n")).not.toContain("comment");
	});

	test("folds finite constant arithmetic and merges duplicate connected constants in an isolated plan", () => {
		const material = addNodeMaterial(scene);
		const twoA = new InputBlock("Two A", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		const twoB = new InputBlock("Two B", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		const three = new InputBlock("Three", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		for (const input of [twoA, twoB, three]) input.isConstant = true;
		twoA.value = 2;
		twoB.value = 2;
		three.value = 3;
		const add = new AddBlock("Fold Six");
		const consumer = new AddBlock("Consumer");
		material.attachedBlocks.push(twoA, twoB, three, add, consumer);
		twoA.output.connectTo(add.left);
		three.output.connectTo(add.right);
		add.output.connectTo(consumer.left);
		twoB.output.connectTo(consumer.right);

		const plan = inspectNodeMaterialOptimization(scene, {
			materialId: material.id,
			settings: { stripUnreachable: false, simplifyIdentityMath: false, foldConstants: true, mergeDuplicateConstants: true, minifyCustomCode: false },
		}) as any;
		expect(plan.actions.map((action: any) => action.type)).toContain("foldConstants");
		expect(plan.actions.map((action: any) => action.type)).toContain("mergeDuplicateConstant");
	});
});
