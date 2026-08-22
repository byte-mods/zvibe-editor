import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { createInputActionMap, setInputActionBinding } from "../../src/mcp/input/input";

describe("mcp/input-bindings", () => {
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

	test("sets one action binding without replacing its map", () => {
		const map = createInputActionMap(scene, { name: "Player", actions: [{ name: "Jump", bindings: ["<keyboard>/space"] }] }, options);
		const result = setInputActionBinding(
			scene,
			{ mapId: map.id, actionName: "Jump", bindingId: map.actions[0].bindings[0].id, expectedRevision: map.revision, changes: { path: "<keyboard>/keyq" } },
			options
		);
		expect(result.binding.path).toBe("<keyboard>/keyq");
		expect(result.mapRevision).toBe(2);
	});
});
