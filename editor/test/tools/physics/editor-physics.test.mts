import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { readFile } from "fs-extra";
import { createRequire } from "module";
import { dirname, join } from "path";

import { MeshBuilder, NullEngine, PhysicsAggregate, PhysicsShapeType, Scene } from "babylonjs";
import HavokPhysics from "@babylonjs/havok";

import { EditorPhysicsMaxLinearVelocity, EditorPhysicsSubTimeStep, enableEditorPhysics } from "../../../src/tools/physics/init";

describe("tools/physics/enableEditorPhysics", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeAll(async () => {
		// Node has no fetch for local files, so hand Havok its WebAssembly binary from next to the resolved entry point.
		const wasmPath = join(dirname(createRequire(import.meta.url).resolve("@babylonjs/havok")), "HavokPhysics.wasm");
		globalThis.HK = await HavokPhysics({ wasmBinary: await readFile(wasmPath) } as any);
	});

	afterEach(() => {
		scene?.dispose();
		engine?.dispose();
	});

	test("uses centimeter gravity and does not cap falling bodies at Havok's meter-based 200 units/s", () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		const plugin = enableEditorPhysics(scene);

		expect(scene.getPhysicsEngine()!.gravity.y).toBe(-981);
		expect(plugin.getMaxLinearVelocity()).toBe(EditorPhysicsMaxLinearVelocity);
		expect(scene.getPhysicsEngine()!.getSubTimeStep()).toBe(EditorPhysicsSubTimeStep);

		const box = MeshBuilder.CreateBox("falling", { size: 100 }, scene);
		box.position.y = 10_000;
		const aggregate = new PhysicsAggregate(box, PhysicsShapeType.BOX, { mass: 1 }, scene);

		// One second of free fall: v ≈ 981 cm/s, well above the 200 cm/s default Havok limit.
		const physics = scene.getPhysicsEngine()!;
		for (let step = 0; step < 60; step++) {
			physics._step(1 / 60);
		}

		expect(-aggregate.body.getLinearVelocity().y).toBeGreaterThan(900);
	});
});
