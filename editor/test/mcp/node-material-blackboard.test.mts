import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { InputBlock, NodeMaterialBlockConnectionPointTypes, NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import {
	applyNodeMaterialSubgraph,
	applyNodeMaterialVariant,
	addNodeMaterialCustomBlock,
	deleteNodeMaterialCustomBlock,
	getNodeMaterialGraph,
	deleteNodeMaterialVariant,
	getNodeMaterialBlackboard,
	getNodeMaterialSubgraph,
	listNodeMaterialVariants,
	listNodeMaterialCustomBlocks,
	saveNodeMaterialSubgraph,
	setNodeMaterialBlackboard,
	setNodeMaterialBlackboardValues,
	setNodeMaterialVariant,
	stripNodeMaterialUnusedBlocks,
} from "../../src/mcp/materials/materials";
import { addNodeMaterial } from "../../src/project/add/material";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/node-material-blackboard", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() }, assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "babylon-shader-subgraph-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(projectDirectory, "Project.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await rm(projectDirectory, { recursive: true, force: true });
	});

	test("persists named blackboard parameters and writes the bound input block", () => {
		const material = addNodeMaterial(scene);
		const input = new InputBlock("Metallic", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		input.value = 0.2;
		material.attachedBlocks.push(input);
		const result = setNodeMaterialBlackboard(
			scene,
			{ materialId: material.id, parameters: [{ name: "Metallic", inputName: input.name, label: "Metallic", min: 0, max: 1, defaultValue: 0.2 }] },
			options
		);
		expect(result.parameters).toHaveLength(1);
		setNodeMaterialBlackboardValues(scene, { materialId: material.id, values: [{ name: "Metallic", value: 0.7 }] }, options);
		expect(input.value).toBe(0.7);
		expect(getNodeMaterialBlackboard(scene, { materialId: material.id }).parameters[0]).toMatchObject({ name: "Metallic", inputName: input.name, min: 0, max: 1 });
	});

	test("saves and reads a reusable project-local Shader Graph subgraph asset", async () => {
		const material = addNodeMaterial(scene);
		const input = new InputBlock("Tint", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		input.value = 0.4;
		material.attachedBlocks.push(input);
		setNodeMaterialBlackboard(scene, { materialId: material.id, parameters: [{ name: "Tint", inputName: "Tint", defaultValue: 0.4 }] }, options);
		const saved = await saveNodeMaterialSubgraph(scene, { materialId: material.id, name: "Reusable Tint", outputPath: "assets/shaders/tint.shadergraph.json" }, options);
		expect(saved).toMatchObject({ name: "Reusable Tint", path: "assets/shaders/tint.shadergraph.json", blackboardParameterCount: 1 });
		const loaded = await getNodeMaterialSubgraph(scene, { path: saved.path });
		expect(loaded).toMatchObject({ name: "Reusable Tint", path: saved.path, blackboard: [{ name: "Tint", inputName: "Tint" }] });
		const target = addNodeMaterial(scene);
		const applied = await applyNodeMaterialSubgraph(scene, { materialId: target.id, path: saved.path }, options);
		expect(applied).toMatchObject({ id: target.id, appliedSubgraph: { name: "Reusable Tint", path: saved.path } });
		expect(getNodeMaterialBlackboard(scene, { materialId: target.id }).parameters).toMatchObject([{ name: "Tint", inputName: "Tint" }]);
	});

	test("creates, applies, lists, and deletes named Shader Graph variants", () => {
		const material = addNodeMaterial(scene);
		const input = new InputBlock("Tint", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		input.value = 0.2;
		material.attachedBlocks.push(input);
		setNodeMaterialBlackboard(scene, { materialId: material.id, parameters: [{ name: "Tint", inputName: "Tint" }] }, options);
		setNodeMaterialVariant(scene, { materialId: material.id, name: "Night", values: [{ name: "Tint", value: 0.8 }] }, options);
		expect(listNodeMaterialVariants(scene, { materialId: material.id }).variants).toMatchObject([{ name: "Night", values: [{ name: "Tint", value: 0.8 }] }]);
		expect(applyNodeMaterialVariant(scene, { materialId: material.id, name: "Night" }, options).appliedVariant).toBe("Night");
		expect(input.value).toBe(0.8);
		expect(deleteNodeMaterialVariant(scene, { materialId: material.id, name: "Night" }, options)).toMatchObject({ deleted: true });
	});

	test("adds serializable graph-native CustomBlock GLSL and removes it by name", () => {
		const material = addNodeMaterial(scene);
		const added = addNodeMaterialCustomBlock(
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
		expect(added.block).toMatchObject({ name: "doubleValue", target: "Fragment", inParameters: [{ name: "value", type: "Float" }] });
		expect(listNodeMaterialCustomBlocks(scene, { materialId: material.id }).blocks).toHaveLength(1);
		expect(getNodeMaterialGraph(scene, { materialId: material.id }).graph.blocks).toEqual(
			expect.arrayContaining([expect.objectContaining({ customType: "BABYLON.CustomBlock" })])
		);
		expect(deleteNodeMaterialCustomBlock(scene, { materialId: material.id, name: "doubleValue" }, options)).toEqual({ deleted: true, name: "doubleValue" });
		expect(listNodeMaterialCustomBlocks(scene, { materialId: material.id }).blocks).toEqual([]);
	});

	test("strips blocks that cannot reach an output and reports each removal", () => {
		const material = addNodeMaterial(scene);
		material.attachedBlocks.push(new InputBlock("Unused", undefined, NodeMaterialBlockConnectionPointTypes.Float));
		const result = stripNodeMaterialUnusedBlocks(scene, { materialId: material.id }, options);
		expect(result).toMatchObject({ materialId: material.id, remainingBlockCount: 0, removed: [expect.objectContaining({ name: "Unused" })] });
		expect(material.attachedBlocks).toEqual([]);
	});
});
