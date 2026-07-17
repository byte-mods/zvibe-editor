import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { validateNodeMaterialGraph } from "../../src/mcp/materials/materials";
import { addNodeMaterial } from "../../src/project/add/material";

describe("mcp/node-material-diagnostics", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("builds the default Node Material and returns graph statistics", () => {
		const material = addNodeMaterial(scene);
		const result = validateNodeMaterialGraph(scene, { materialId: material.id });

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.statistics.outputBlocks.length).toBeGreaterThan(0);
		expect(result.statistics.compiledShaderCharacters).toBeGreaterThan(0);
	});

	test("reports an actionable error when output blocks are removed", () => {
		const material = addNodeMaterial(scene);
		material._vertexOutputNodes = [];
		material._fragmentOutputNodes = [];

		const result = validateNodeMaterialGraph(scene, { materialId: material.id });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("no vertex or fragment output blocks");
	});
});
