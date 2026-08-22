import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import { Color4, InputBlock, Mesh, NodeMaterialBlockConnectionPointTypes, NullEngine, Scene, Vector3 } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import {
	getNodeMaterialBlackboard,
	getNodeMaterialSubgraph,
	saveNodeMaterialSubgraph,
	setNodeMaterialBlackboard,
	setNodeMaterialBlackboardValues,
} from "../../src/mcp/materials/materials";
import {
	addShaderGraphReflectedFunction,
	applyShaderGraphTemplate,
	createShaderGraphFromTemplate,
	deleteShaderGraphSwitch,
	getShaderGraphCapabilities,
	getShaderGraphExtensions,
	inspectShaderGraphReflectedFunction,
	listShaderGraphTemplates,
	openShaderGraphInspector,
	setShaderGraphSubgraphInput,
	setShaderGraphSwitch,
	shaderGraphTemplateCatalogRevision,
} from "../../src/mcp/materials/shader-graph";
import { addNodeMaterial } from "../../src/project/add/material";
import { projectConfiguration } from "../../src/project/configuration";

async function buildNodeMaterial(material: any): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const built = material.onBuildObservable.addOnce(() => {
			material.onBuildErrorObservable.remove(failed);
			resolve();
		});
		const failed = material.onBuildErrorObservable.addOnce((message: string) => {
			material.onBuildObservable.remove(built);
			reject(new Error(message));
		});
		material.build(false, true, false);
		if (!material.buildIsInProgress) {
			material.onBuildObservable.remove(built);
			material.onBuildErrorObservable.remove(failed);
			resolve();
		}
	});
}

describe("mcp/shader-graph-65", () => {
	let engine: NullEngine;
	let scene: Scene;
	let projectDirectory: string;
	let previousProjectPath: string | null;
	const options = {
		editor: {
			layout: {
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				assets: { refresh: vi.fn() },
			},
		},
	} as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		projectDirectory = await mkdtemp(join(tmpdir(), "zvibe-shader-graph-65-"));
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

	test("searches an exact template catalog and creates persisted fullscreen and decal graph assets", async () => {
		const capabilities = getShaderGraphCapabilities();
		expect(capabilities).toMatchObject({
			templateCatalogRevision: shaderGraphTemplateCatalogRevision,
			templates: { search: true, decalProjectorPortable: true, fullscreenRendererPortable: true },
			reflectedFunctions: { language: "GLSL", inout: false },
		});
		const rendering = listShaderGraphTemplates(scene, { query: "renderer", category: "Rendering", offset: 0, limit: 10 }) as any;
		expect(rendering.catalogRevision).toBe(shaderGraphTemplateCatalogRevision);
		expect(rendering.templates.map((template: any) => template.id)).toEqual(["urp-decal-projector-portable", "urp-fullscreen-renderer-portable"]);

		const fullscreen = await createShaderGraphFromTemplate(
			scene,
			{
				templateId: "urp-fullscreen-renderer-portable",
				expectedCatalogRevision: rendering.catalogRevision,
				name: "Fullscreen Bloom",
				folder: "assets/shaders",
			},
			options
		);
		expect(fullscreen).toMatchObject({ name: "Fullscreen Bloom", path: "assets/shaders/Fullscreen Bloom.material", template: { target: "fullscreen" } });
		const persisted = JSON.parse(await readFile(join(projectDirectory, fullscreen.path as string), "utf-8"));
		expect(persisted.mode).toBe(1);
		expect(persisted.metadata.babylonEditorShaderGraphTemplate.id).toBe("urp-fullscreen-renderer-portable");
		expect(openShaderGraphInspector(scene, { materialId: fullscreen.id }, options)).toMatchObject({ opened: true, materialId: fullscreen.id });
		expect(options.editor.layout.inspector.setEditedObject).toHaveBeenCalled();
		await symlink(join(projectDirectory, "assets"), join(projectDirectory, "linked-assets"));
		const materialCount = scene.materials.length;
		await expect(
			createShaderGraphFromTemplate(
				scene,
				{ templateId: "surface-unlit", expectedCatalogRevision: shaderGraphTemplateCatalogRevision, name: "Symlink", folder: "linked-assets" },
				options
			)
		).rejects.toThrow("regular project directories");
		expect(scene.materials).toHaveLength(materialCount);

		await expect(
			createShaderGraphFromTemplate(scene, { templateId: "surface-unlit", expectedCatalogRevision: "0".repeat(64), name: "Stale", folder: "assets" }, options)
		).rejects.toThrow("catalog changed");
	});

	test("applies a template only under exact graph and catalog revisions while retaining mesh assignments", async () => {
		const material = addNodeMaterial(scene);
		material.build(false, true, false);
		expect(material.getInputBlocks().length).toBeGreaterThan(0);
		const mesh = new Mesh("Template Target", scene);
		mesh.material = material;
		const inspected = getShaderGraphExtensions(scene, { materialId: material.id }) as any;
		await expect(
			applyShaderGraphTemplate(
				scene,
				{
					materialId: material.id,
					templateId: "procedural-texture",
					expectedCatalogRevision: shaderGraphTemplateCatalogRevision,
					expectedGraphRevision: "0".repeat(64),
					confirm: true,
				},
				options
			)
		).rejects.toThrow("changed after inspection");
		const applied = await applyShaderGraphTemplate(
			scene,
			{
				materialId: material.id,
				templateId: "procedural-texture",
				expectedCatalogRevision: shaderGraphTemplateCatalogRevision,
				expectedGraphRevision: inspected.graphRevision,
				confirm: true,
			},
			options
		);
		expect(applied).toMatchObject({ id: material.id, template: { id: "procedural-texture" } });
		expect(mesh.material.id).toBe(material.id);
		expect(mesh.material).not.toBe(material);
		expect((mesh.material as any).getInputBlocks().length).toBeGreaterThan(0);
	});

	test("creates, updates, stale-rejects, serializes, compiles, and deletes a multi-case enum Switch block", async () => {
		const material = addNodeMaterial(scene);
		const initial = getShaderGraphExtensions(scene, { materialId: material.id }) as any;
		const created = setShaderGraphSwitch(
			scene,
			{
				materialId: material.id,
				expectedGraphRevision: initial.graphRevision,
				name: "QualitySwitch",
				mode: "enum",
				valueType: "Color4",
				cases: [
					{ label: "Low", match: 0 },
					{ label: "Medium", match: 1 },
					{ label: "High", match: 2 },
				],
			},
			options
		) as any;
		expect(created.switch).toMatchObject({ name: "QualitySwitch", mode: "enum", valueType: "Color4" });
		const serialized = material.serialize().blocks.find((block: any) => block.customType === "BABYLON.CustomBlock" && block.name === "QualitySwitch");
		expect(serialized.options.inParameters.map((parameter: any) => parameter.name)).toEqual(["selector", "case0", "case1", "case2", "fallback"]);
		expect(serialized.options.code.join("\n")).toContain("int(floor(selector + 0.5))");
		expect(() =>
			setShaderGraphSwitch(
				scene,
				{
					materialId: material.id,
					expectedGraphRevision: initial.graphRevision,
					name: "StaleSwitch",
					mode: "float",
					valueType: "Float",
					cases: [
						{ label: "A", match: 0 },
						{ label: "B", match: 1 },
					],
				},
				options
			)
		).toThrow("changed after inspection");

		const updated = setShaderGraphSwitch(
			scene,
			{
				materialId: material.id,
				expectedGraphRevision: created.graphRevision,
				switchId: created.switch.id,
				name: "QualitySwitch",
				mode: "enum",
				valueType: "Color4",
				cases: [
					{ label: "Draft", match: 0 },
					{ label: "Preview", match: 1 },
					{ label: "Final", match: 2 },
				],
			},
			options
		) as any;
		expect(updated.switch.cases[2]).toEqual({ label: "Final", match: 2 });
		const switchBlock = material.attachedBlocks.find((block) => block.name === "QualitySwitch")!;
		const fragmentOutput = material._fragmentOutputNodes[0];
		const rgba = fragmentOutput.getInputByName("rgba")!;
		const originalColor = rgba.connectedPoint!;
		originalColor.disconnectFrom(rgba);
		const selector = new InputBlock("Quality Selector", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		selector.value = 2;
		const medium = new InputBlock("Medium Color", undefined, NodeMaterialBlockConnectionPointTypes.Color4);
		medium.value = new Color4(0.5, 0.5, 0.5, 1);
		const high = new InputBlock("High Color", undefined, NodeMaterialBlockConnectionPointTypes.Color4);
		high.value = new Color4(1, 1, 1, 1);
		const fallback = new InputBlock("Fallback Color", undefined, NodeMaterialBlockConnectionPointTypes.Color4);
		fallback.value = new Color4(1, 0, 1, 1);
		material.attachedBlocks.push(selector, medium, high, fallback);
		selector.output.connectTo(switchBlock.getInputByName("selector")!);
		originalColor.connectTo(switchBlock.getInputByName("case0")!);
		medium.output.connectTo(switchBlock.getInputByName("case1")!);
		high.output.connectTo(switchBlock.getInputByName("case2")!);
		fallback.output.connectTo(switchBlock.getInputByName("fallback")!);
		switchBlock.getOutputByName("result")!.connectTo(rgba);
		await buildNodeMaterial(material);
		expect(material.compiledShaders).toContain("zvibeSwitch_");
		const beforeDelete = getShaderGraphExtensions(scene, { materialId: material.id }) as any;
		const deleted = deleteShaderGraphSwitch(scene, { materialId: material.id, switchId: created.switch.id, expectedGraphRevision: beforeDelete.graphRevision }, options);
		expect(deleted).toMatchObject({ deleted: true, switchId: created.switch.id });
		expect((getShaderGraphExtensions(scene, { materialId: material.id }) as any).switches).toEqual([]);
	});

	test("reflects and inserts a project-contained GLSL return function under exact source and graph leases", async () => {
		await writeFile(join(projectDirectory, "blend.glsl"), "vec3 blendTint(vec3 color, float amount) { return color * amount; }\n");
		const inspected = (await inspectShaderGraphReflectedFunction(scene, { sourcePath: "blend.glsl", functionName: "blendTint" })) as any;
		expect(inspected).toMatchObject({
			supported: true,
			function: {
				name: "blendTint",
				returnType: "vec3",
				parameters: [
					{ name: "color", direction: "in", portType: "Vector3" },
					{ name: "amount", direction: "in", portType: "Float" },
				],
			},
		});
		const material = addNodeMaterial(scene);
		const graph = getShaderGraphExtensions(scene, { materialId: material.id }) as any;
		const added = (await addShaderGraphReflectedFunction(
			scene,
			{
				materialId: material.id,
				expectedGraphRevision: graph.graphRevision,
				sourcePath: "blend.glsl",
				expectedSourceRevision: inspected.sourceRevision,
				functionName: "blendTint",
				blockName: "Blend Tint",
				target: "Fragment",
			},
			options
		)) as any;
		expect(added.reflectedFunction).toMatchObject({ functionName: "blendTint", sourcePath: "blend.glsl", blockName: "Blend Tint" });
		const block = material.serialize().blocks.find((candidate: any) => candidate.name === "Blend Tint");
		expect(block.options.inParameters).toEqual([
			{ name: "color", type: "Vector3" },
			{ name: "amount", type: "Float" },
		]);
		expect(block.options.outParameters).toEqual([{ name: "returnValue", type: "Vector3" }]);
		expect(block.options.code.join("\n")).toContain("returnValue = blendTint(color, amount);");
		const reflectedBlock = material.attachedBlocks.find((candidate) => candidate.name === "Blend Tint")!;
		const fragmentOutput = material._fragmentOutputNodes[0];
		const rgba = fragmentOutput.getInputByName("rgba")!;
		const originalColor = rgba.connectedPoint!;
		originalColor.disconnectFrom(rgba);
		const color = new InputBlock("Reflected Color", undefined, NodeMaterialBlockConnectionPointTypes.Vector3);
		color.value = new Vector3(0.5, 0.5, 0.5);
		const amount = new InputBlock("Reflected Amount", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		amount.value = 0.5;
		material.attachedBlocks.push(color, amount);
		color.output.connectTo(reflectedBlock.getInputByName("color")!);
		amount.output.connectTo(reflectedBlock.getInputByName("amount")!);
		reflectedBlock.getOutputByName("returnValue")!.connectTo(fragmentOutput.getInputByName("rgb")!);
		await buildNodeMaterial(material);
		expect(material.compiledShaders).toContain("blendTint");

		await writeFile(join(projectDirectory, "blend.glsl"), "vec3 blendTint(vec3 color, float amount) { return color + amount; }\n");
		await expect(
			addShaderGraphReflectedFunction(
				scene,
				{
					materialId: material.id,
					expectedGraphRevision: (getShaderGraphExtensions(scene, { materialId: material.id }) as any).graphRevision,
					sourcePath: "blend.glsl",
					expectedSourceRevision: inspected.sourceRevision,
					functionName: "blendTint",
				},
				options
			)
		).rejects.toThrow("source changed after inspection");
		await expect(inspectShaderGraphReflectedFunction(scene, { sourcePath: "../outside.glsl", functionName: "bad" })).rejects.toThrow("stay inside");
	});

	test("persists v2 static and enum subgraph inputs and rejects runtime writes", async () => {
		const material = addNodeMaterial(scene);
		const quality = new InputBlock("Quality", undefined, NodeMaterialBlockConnectionPointTypes.Float);
		quality.value = 1;
		material.attachedBlocks.push(quality);
		setNodeMaterialBlackboard(
			scene,
			{
				materialId: material.id,
				parameters: [
					{
						name: "Quality",
						inputName: "Quality",
						defaultValue: 1,
						connectorEnabled: true,
						floatMode: "integer",
						description: "Render quality tier",
					},
				],
			},
			options
		);
		const saved = (await saveNodeMaterialSubgraph(scene, { materialId: material.id, name: "Quality", outputPath: "assets/quality.shadergraph.json" }, options)) as any;
		expect(saved).toMatchObject({ version: 2, blackboardParameterCount: 1 });
		await symlink(join(projectDirectory, "assets"), join(projectDirectory, "linked-subgraphs"));
		await expect(saveNodeMaterialSubgraph(scene, { materialId: material.id, name: "Unsafe", outputPath: "linked-subgraphs/unsafe.shadergraph.json" }, options)).rejects.toThrow(
			"regular project directories"
		);
		const updated = (await setShaderGraphSubgraphInput(
			scene,
			{
				path: saved.path,
				expectedRevision: saved.revision,
				parameterName: "Quality",
				connectorEnabled: false,
				floatMode: "enum",
				staticValue: 2,
				enumOptions: [
					{ label: "Low", value: 0 },
					{ label: "High", value: 2 },
				],
				description: "Statically compiled quality tier",
			},
			options
		)) as any;
		expect(updated).toMatchObject({ version: 2, parameter: { connectorEnabled: false, floatMode: "enum", staticValue: 2 } });
		const loaded = (await getNodeMaterialSubgraph(scene, { path: saved.path })) as any;
		expect(loaded.revision).toBe(updated.revision);
		expect(loaded.blackboard[0]).toMatchObject({ connectorEnabled: false, floatMode: "enum" });
		expect(loaded.blackboard[0].enumOptions).toEqual([
			{ label: "Low", value: 0 },
			{ label: "High", value: 2 },
		]);
		await expect(
			setShaderGraphSubgraphInput(
				scene,
				{
					path: saved.path,
					expectedRevision: saved.revision,
					parameterName: "Quality",
					connectorEnabled: true,
					floatMode: "default",
				},
				options
			)
		).rejects.toThrow("changed after inspection");

		setNodeMaterialBlackboard(
			scene,
			{
				materialId: material.id,
				parameters: [{ name: "Quality", inputName: "Quality", connectorEnabled: false, floatMode: "enum", staticValue: 2, enumOptions: [{ label: "High", value: 2 }] }],
			},
			options
		);
		expect(getNodeMaterialBlackboard(scene, { materialId: material.id }).parameters[0]).toMatchObject({ connectorEnabled: false, floatMode: "enum", staticValue: 2 });
		expect(quality.value).toBe(2);
		expect(quality.visibleInInspector).toBe(true);
		expect(() => setNodeMaterialBlackboardValues(scene, { materialId: material.id, values: [{ name: "Quality", value: 0 }] }, options)).toThrow("statically compiled");
	});
});
