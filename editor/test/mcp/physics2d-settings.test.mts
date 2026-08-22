import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { getPhysics2DSettings, setPhysics2DSettings } from "../../src/mcp/physics2d/physics2d";

describe("mcp/physics2d settings contract", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("reads defaults and legacy settings without dirtying scene metadata", () => {
		expect(getPhysics2DSettings(scene)).toMatchObject({ version: 3, revision: 1, velocityIterations: 1, positionIterations: 1, worlds: [{ id: "default" }] });
		expect(scene.metadata).toBeNull();

		scene.metadata = { babylonEditorPhysics2DSettings: { solverIterations: 6 } };
		expect(getPhysics2DSettings(scene)).toMatchObject({
			version: 3,
			revision: 1,
			velocityIterations: 6,
			positionIterations: 6,
			worlds: [{ id: "default", velocityIterations: 6 }],
		});
		expect(scene.metadata.babylonEditorPhysics2DSettings).toEqual({ solverIterations: 6 });
	});

	test("atomically persists split controls and supports exact revision leases", () => {
		scene.metadata = { babylonEditorPhysics2DSettings: { solverIterations: 4 } };
		const updated = setPhysics2DSettings(scene, { expectedRevision: 1, velocityIterations: 8, positionIterations: 3 }, options);

		expect(updated).toMatchObject({
			version: 3,
			revision: 2,
			velocityIterations: 8,
			positionIterations: 3,
			worlds: [{ id: "default", velocityIterations: 8, positionIterations: 3 }],
		});
		expect(scene.metadata.babylonEditorPhysics2DSettings).toEqual(updated);
		expect(() => setPhysics2DSettings(scene, { expectedRevision: 1, velocityIterations: 2 }, options)).toThrow("current revision is 2");
		expect(scene.metadata.babylonEditorPhysics2DSettings).toEqual(updated);
	});

	test("keeps the complete value unchanged when any field or key is invalid", () => {
		const before = setPhysics2DSettings(scene, { solverIterations: 5 }, options);

		expect(() => setPhysics2DSettings(scene, { expectedRevision: before.revision, velocityIterations: 7, positionIterations: 17 }, options)).toThrow("positionIterations");
		expect(() => setPhysics2DSettings(scene, { expectedRevision: before.revision, velocityIterations: null }, options)).toThrow("velocityIterations");
		expect(() => setPhysics2DSettings(scene, { expectedRevision: before.revision, mystery: 2 }, options)).toThrow("not supported");
		expect(getPhysics2DSettings(scene)).toEqual(before);
	});
});
