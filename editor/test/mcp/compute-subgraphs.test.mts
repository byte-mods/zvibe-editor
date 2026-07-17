import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { disposeCustomRenderPassGraph } from "babylonjs-editor-tools";

import {
	addCustomComputeNode,
	compileCustomComputeNodeGraph,
	connectCustomComputeNodes,
	disconnectCustomComputeNodes,
	initializeCustomComputeNodeGraph,
	setCustomComputeNode,
} from "../../src/mcp/rendering/compute-graph";
import {
	deleteCustomComputeSubgraph,
	deleteCustomComputeSubgraphInstance,
	getCustomComputeSubgraph,
	getCustomComputeSubgraphDiagnostics,
	getCustomComputeSubgraphMigration,
	insertCustomComputeSubgraph,
	listCustomComputeSubgraphInstances,
	listCustomComputeSubgraphs,
	migrateCustomComputeSubgraph,
	refreshCustomComputeSubgraphInstance,
	saveCustomComputeSubgraph,
	setCustomComputeSubgraphInstance,
} from "../../src/mcp/rendering/compute-subgraphs";
import { createCustomRenderPass } from "../../src/mcp/rendering/custom-passes";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/compute-subgraphs", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	let directory: string;
	let previousPath: string | null;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, assets: { refresh: vi.fn() } } } } as any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		directory = await mkdtemp(join(tmpdir(), "babylon-compute-subgraph-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
	});

	afterEach(async () => {
		disposeCustomRenderPassGraph(camera as any);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await rm(directory, { recursive: true, force: true });
	});

	function pass(): any {
		const value = createCustomRenderPass(scene, { name: "Functions", passType: "compute", output: "functionOutput" }, options);
		initializeCustomComputeNodeGraph(scene, { id: value.id }, options);
		addCustomComputeNode(scene, { id: value.id, node: { id: "multiply", type: "multiply", position: [220, 220] } }, options);
		addCustomComputeNode(scene, { id: value.id, node: { id: "clamp", type: "clamp", position: [420, 220] } }, options);
		connectCustomComputeNodes(scene, { id: value.id, from: "multiply", to: "clamp", toPort: "value" }, options);
		return value;
	}

	test("saves, lists, reads, inserts, wires, compiles and deletes a reusable graph-function asset", async () => {
		const value = pass();
		const saved = await saveCustomComputeSubgraph(
			scene,
			{
				id: value.id,
				path: "assets/compute/saturate.computegraph.json",
				assetName: "Multiply Clamp",
				nodeIds: ["multiply", "clamp"],
				outputNodeId: "clamp",
				inputNames: { "multiply.a": "value", "multiply.b": "scale", "clamp.minimum": "minimum", "clamp.maximum": "maximum" },
			},
			options
		);
		expect(saved).toMatchObject({ name: "Multiply Clamp", path: "assets/compute/saturate.computegraph.json", nodeCount: 2, edgeCount: 1 });
		expect(saved.inputs.map((input: any) => input.name).sort()).toEqual(["maximum", "minimum", "scale", "value"]);
		expect((await listCustomComputeSubgraphs()).assets).toEqual([expect.objectContaining({ path: saved.path, name: "Multiply Clamp" })]);
		expect(await getCustomComputeSubgraph(scene, { path: saved.path })).toMatchObject({ asset: { version: 2, type: "babylon-editor-compute-subgraph" } });

		for (const [nodeId, port] of [
			["multiply", "a"],
			["multiply", "b"],
			["clamp", "minimum"],
			["clamp", "maximum"],
		] as const)
			connectCustomComputeNodes(scene, { id: value.id, from: "uvColor", to: nodeId, toPort: port }, options);
		const inserted = await insertCustomComputeSubgraph(scene, { id: value.id, path: saved.path, prefix: "fx", position: [620, 220] }, options);
		expect(inserted).toMatchObject({
			prefix: "fx",
			insertedNodeIds: ["fx_multiply", "fx_clamp"],
			output: { nodeId: "fx_clamp", type: "vec4f" },
			instance: { id: "fx", collapsed: true },
		});
		for (const input of inserted.inputs) connectCustomComputeNodes(scene, { id: value.id, from: "uvColor", to: input.nodeId, toPort: input.port }, options);
		disconnectCustomComputeNodes(scene, { id: value.id, from: "uvColor", to: "output", toPort: "color" }, options);
		connectCustomComputeNodes(scene, { id: value.id, from: inserted.output.nodeId, to: "output", toPort: "color" }, options);
		const compiled = compileCustomComputeNodeGraph(scene, { id: value.id }, options);
		expect(compiled.wgsl).toContain("let node_fx_multiply");
		expect(compiled.wgsl).toContain("let node_fx_clamp = clamp(");
		await expect(insertCustomComputeSubgraph(scene, { id: value.id, path: saved.path, prefix: "fx" }, options)).rejects.toThrow("already exists");
		expect(listCustomComputeSubgraphInstances(scene, { id: value.id }).instances).toEqual([expect.objectContaining({ id: "fx", assetRevision: saved.revision })]);
		expect(await getCustomComputeSubgraphDiagnostics(scene, { id: value.id })).toMatchObject({
			ready: true,
			diagnostics: [{ instanceId: "fx", status: "current", interfaceCompatible: true, refreshable: true, incomingConnectionCount: 4, outgoingConnectionCount: 1 }],
		});
		const moved = setCustomComputeSubgraphInstance(scene, { id: value.id, instanceId: "fx", collapsed: false, position: [700, 300] }, options);
		expect(moved.instance).toMatchObject({ collapsed: false, position: [700, 300] });
		setCustomComputeNode(scene, { id: value.id, nodeId: "clamp", update: { position: [520, 260] } }, options);
		const updatedAsset = await saveCustomComputeSubgraph(
			scene,
			{
				id: value.id,
				path: saved.path,
				assetName: "Multiply Clamp Updated",
				nodeIds: ["multiply", "clamp"],
				outputNodeId: "clamp",
				inputNames: { "multiply.a": "value", "multiply.b": "scale", "clamp.minimum": "minimum", "clamp.maximum": "maximum" },
				overwrite: true,
			},
			options
		);
		expect(updatedAsset.revision).not.toBe(saved.revision);
		expect(await getCustomComputeSubgraphDiagnostics(scene, { id: value.id })).toMatchObject({ ready: false, diagnostics: [{ status: "outdated", refreshable: true }] });
		const refreshed = await refreshCustomComputeSubgraphInstance(scene, { id: value.id, instanceId: "fx", compile: true }, options);
		expect(refreshed).toMatchObject({
			compiled: true,
			instance: { assetName: "Multiply Clamp Updated", assetRevision: updatedAsset.revision, collapsed: false, position: [700, 300] },
		});
		expect(await getCustomComputeSubgraphDiagnostics(scene, { id: value.id })).toMatchObject({ ready: true, diagnostics: [{ status: "current" }] });

		expect(await deleteCustomComputeSubgraph(scene, { path: saved.path }, options)).toMatchObject({ deleted: true, path: saved.path });
		expect((await listCustomComputeSubgraphs()).assets).toEqual([]);
		expect(await getCustomComputeSubgraphDiagnostics(scene, { id: value.id })).toMatchObject({ ready: false, diagnostics: [{ status: "missing", refreshable: false }] });
		expect(deleteCustomComputeSubgraphInstance(scene, { id: value.id, instanceId: "fx" }, options)).toMatchObject({
			deleted: true,
			removedNodeIds: ["fx_multiply", "fx_clamp"],
		});
		expect(listCustomComputeSubgraphInstances(scene, { id: value.id }).instances).toEqual([]);
		expect(options.editor.layout.assets.refresh).toHaveBeenCalledTimes(3);
	});

	test("dry-runs and atomically persists semantic v1-to-v2 migrations with stable interfaces and a backup", async () => {
		const path = "legacy-select.computegraph.json";
		const absolutePath = join(directory, path);
		const legacy = {
			version: 1,
			type: "babylon-editor-compute-subgraph",
			name: "Legacy Select",
			nodes: [
				{ id: "fallback", type: "constant-color", position: [0, 0], value: [0, 0, 0, 1] },
				{ id: "selected", type: "constant-color", position: [0, 80], value: [1, 1, 1, 1] },
				{ id: "choose", type: "select", position: [220, 40] },
			],
			edges: [
				{ from: "fallback", fromPort: "value", to: "choose", toPort: "whenFalse" },
				{ from: "selected", fromPort: "value", to: "choose", toPort: "whenTrue" },
			],
			inputs: [{ name: "condition", nodeId: "choose", port: "condition", type: "vec4f" }],
			output: { nodeId: "choose", port: "value", type: "vec4f" },
		};
		await writeFile(absolutePath, JSON.stringify(legacy, null, 2));

		const dryRun = await getCustomComputeSubgraphMigration(scene, { path });
		expect(dryRun).toMatchObject({
			sourceVersion: 1,
			targetVersion: 2,
			migrationRequired: true,
			steps: [{ id: "v1-select-to-typed-branch", changedNodeIds: ["choose"], createdNodeIds: ["choose__condition", "choose__threshold"] }],
		});
		const inMemory = await getCustomComputeSubgraph(scene, { path });
		expect(inMemory).toMatchObject({
			sourceVersion: 1,
			version: 2,
			migrationRequired: true,
			asset: {
				inputs: [{ name: "condition", nodeId: "choose__condition", port: "a", type: "vec4f" }],
				output: { nodeId: "choose", type: "vec4f" },
			},
		});
		expect(inMemory.asset.nodes).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "choose", type: "branch" }),
				expect.objectContaining({ id: "choose__condition", type: "compare", comparison: "greaterEqual" }),
				expect.objectContaining({ id: "choose__threshold", type: "constant-color", value: [0.5, 0.5, 0.5, 0.5] }),
			])
		);
		const value = pass();
		const inserted = await insertCustomComputeSubgraph(scene, { id: value.id, path, prefix: "legacyFx" }, options);
		expect(inserted).toMatchObject({
			instance: { assetVersion: 2, assetRevision: dryRun.targetRevision },
			inputs: [{ name: "condition", nodeId: "legacyFx_choose__condition", port: "a", type: "vec4f" }],
			output: { nodeId: "legacyFx_choose", type: "vec4f" },
		});
		expect(await getCustomComputeSubgraphDiagnostics(scene, { id: value.id })).toMatchObject({
			ready: true,
			diagnostics: [{ status: "current", assetMigrationRequired: true, interfaceCompatible: true, refreshable: true }],
		});

		const migrated = await migrateCustomComputeSubgraph(scene, { path }, options);
		expect(migrated).toMatchObject({ migrated: true, path, version: 2, backupPath: dryRun.backupPath });
		expect(JSON.parse(await readFile(absolutePath, "utf-8"))).toMatchObject({
			version: 2,
			nodes: expect.arrayContaining([expect.objectContaining({ id: "choose", type: "branch" })]),
		});
		expect(JSON.parse(await readFile(join(directory, dryRun.backupPath), "utf-8"))).toMatchObject({
			version: 1,
			nodes: expect.arrayContaining([expect.objectContaining({ id: "choose", type: "select" })]),
		});
		expect(await migrateCustomComputeSubgraph(scene, { path }, options)).toMatchObject({ migrated: false, version: 2, backupPath: null });
		expect((await listCustomComputeSubgraphs()).assets).toEqual([expect.objectContaining({ path, sourceVersion: 2, version: 2, migrationRequired: false })]);
		expect(await getCustomComputeSubgraphDiagnostics(scene, { id: value.id })).toMatchObject({
			ready: true,
			diagnostics: [{ status: "current", assetMigrationRequired: false, interfaceCompatible: true, refreshable: true }],
		});
	});

	test("rejects unsupported migration sources without changing their bytes", async () => {
		const path = "unsupported.computegraph.json";
		const absolutePath = join(directory, path);
		const source = JSON.stringify({ version: 99, type: "babylon-editor-compute-subgraph", name: "Future", nodes: [], edges: [], inputs: [], output: null });
		await writeFile(absolutePath, source);
		await expect(migrateCustomComputeSubgraph(scene, { path }, options)).rejects.toThrow("unsupported version");
		expect(await readFile(absolutePath, "utf-8")).toBe(source);
	});

	test("rejects unsafe paths, sinks, dead nodes, and accidental replacement", async () => {
		const value = pass();
		const request = { id: value.id, path: "functions/value.computegraph.json", nodeIds: ["multiply", "clamp"], outputNodeId: "clamp" };
		await saveCustomComputeSubgraph(scene, request, options);
		await expect(saveCustomComputeSubgraph(scene, request, options)).rejects.toThrow("Set overwrite: true");
		await expect(saveCustomComputeSubgraph(scene, { ...request, path: "../escape.computegraph.json" }, options)).rejects.toThrow("stay inside");
		await expect(saveCustomComputeSubgraph(scene, { ...request, path: "functions/value.json" }, options)).rejects.toThrow(".computegraph.json extension");
		await expect(
			saveCustomComputeSubgraph(scene, { ...request, path: "functions/names.computegraph.json", inputNames: { "missing.port": "Unknown" } }, options)
		).rejects.toThrow("unknown boundary input");
		await expect(
			saveCustomComputeSubgraph(scene, { ...request, path: "functions/sink.computegraph.json", nodeIds: ["output"], outputNodeId: "output" }, options)
		).rejects.toThrow("cannot contain storage-store or output-store");
		addCustomComputeNode(scene, { id: value.id, node: { id: "dead", type: "constant-color", position: [0, 300], value: [1, 1, 1, 1] } }, options);
		await expect(saveCustomComputeSubgraph(scene, { ...request, path: "functions/dead.computegraph.json", nodeIds: ["multiply", "clamp", "dead"] }, options)).rejects.toThrow(
			"do not contribute to its output"
		);
	});

	test("reports incompatible asset-interface revisions and refuses automatic refresh", async () => {
		const value = pass();
		const path = "functions/interface.computegraph.json";
		await saveCustomComputeSubgraph(
			scene,
			{
				id: value.id,
				path,
				nodeIds: ["multiply", "clamp"],
				outputNodeId: "clamp",
				inputNames: { "multiply.a": "value", "multiply.b": "scale", "clamp.minimum": "minimum", "clamp.maximum": "maximum" },
			},
			options
		);
		await insertCustomComputeSubgraph(scene, { id: value.id, path, prefix: "interfaceFx" }, options);
		await saveCustomComputeSubgraph(
			scene,
			{
				id: value.id,
				path,
				nodeIds: ["multiply", "clamp"],
				outputNodeId: "clamp",
				inputNames: { "multiply.a": "renamedValue", "multiply.b": "scale", "clamp.minimum": "minimum", "clamp.maximum": "maximum" },
				overwrite: true,
			},
			options
		);
		expect(await getCustomComputeSubgraphDiagnostics(scene, { id: value.id })).toMatchObject({
			ready: false,
			diagnostics: [{ status: "outdated", interfaceCompatible: false, refreshable: false }],
		});
		await expect(refreshCustomComputeSubgraphInstance(scene, { id: value.id, instanceId: "interfaceFx" }, options)).rejects.toThrow("interface changed incompatibly");
	});
});
