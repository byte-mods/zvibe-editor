import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene, TransformNode } from "babylonjs";

import { projectConfiguration } from "../../src/project/configuration";
import {
	attachScript,
	listAttachedScripts,
	listProjectScriptExecutionOrders,
	setAttachedScriptExecutionOrder,
	setProjectScriptExecutionOrder,
} from "../../src/mcp/scripts/scripts";

describe("mcp/script-execution-order", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-script-order-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("persists bounded execution order for one attached script", () => {
		const node = new TransformNode("Actor", scene);
		attachScript(scene, { nodeId: node.id, path: "src/movement.ts" }, options);
		setAttachedScriptExecutionOrder(scene, { nodeId: node.id, path: "src/movement.ts", executionOrder: -200 }, options);

		expect(listAttachedScripts(scene, { nodeId: node.id }).scripts).toEqual([{ path: "src/movement.ts", enabled: true, executionOrder: -200, exportedValues: {} }]);
		expect(() => setAttachedScriptExecutionOrder(scene, { nodeId: node.id, path: "src/movement.ts", executionOrder: 32001 }, options)).toThrow("between -32000 and 32000");
	});

	test("persists a project-level script-path override and allows clearing it", () => {
		setProjectScriptExecutionOrder(scene, { path: "src/bootstrap.ts", executionOrder: -1000 }, options);
		expect(listProjectScriptExecutionOrders(scene).orders).toEqual({ "bootstrap.ts": -1000 });
		setProjectScriptExecutionOrder(scene, { path: "src/bootstrap.ts", executionOrder: null }, options);
		expect(listProjectScriptExecutionOrders(scene).orders).toEqual({});
	});
});
