import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";

import { triggerParticleEvent } from "../../src/loading/particle-events";

describe("loading/particle-events", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		const particles = new ParticleSystem("Impact FX", 16, scene);
		particles.emitter = new Mesh("Emitter", scene);
		scene.metadata = { babylonEditorParticleEvents: { [particles.id]: [{ name: "Impact", count: 6 }] } };
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("fires persisted gameplay events for exported particle systems", () => {
		const particles = scene.particleSystems[0] as ParticleSystem;
		expect(triggerParticleEvent(scene, "Impact")).toEqual({ triggered: [{ particleSystemId: particles.id, particleSystemName: "Impact FX", count: 6 }], totalCount: 6 });
		expect(particles.manualEmitCount).toBe(6);
		expect(triggerParticleEvent(scene, "Missing")).toEqual({ triggered: [], totalCount: 0 });
	});
});
