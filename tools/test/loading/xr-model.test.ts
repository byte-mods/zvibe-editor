import { describe, expect, test } from "vitest";

import { createDefaultXRConfiguration, getSceneXRConfiguration, normalizeXRConfiguration, setSceneXRConfiguration, validateXRConfiguration } from "../../src/loading/xr-model";

describe("loading/xr-model", () => {
	test("migrates legacy WebXR metadata without mixing editor locomotion into native features", () => {
		const result = normalizeXRConfiguration({
			enabled: true,
			referenceSpaceType: "bounded-floor",
			floorMeshIds: ["floor"],
			features: ["teleportation", "hand-tracking", "hit-test"],
		});

		expect(result).toMatchObject({ migrated: true, sourceVersion: 1 });
		expect(result.configuration).toMatchObject({
			version: 2,
			revision: 1,
			enabled: true,
			session: { mode: "immersive-vr", referenceSpaceType: "bounded-floor", optionalFeatures: ["hand-tracking", "hit-test"] },
			origin: { floorMeshIds: ["floor"] },
			interaction: { handTracking: true },
			locomotion: { teleportation: true },
		});
	});

	test("returns independent complete defaults", () => {
		const first = createDefaultXRConfiguration();
		const second = createDefaultXRConfiguration();
		first.origin.floorMeshIds.push("floor");
		first.simulation.headset.position[1] = 99;

		expect(second.origin.floorMeshIds).toEqual([]);
		expect(second.origin.worldScale).toBe(100);
		expect(second.simulation.headset.position).toEqual([0, 1.7, 0]);
		expect(() => validateXRConfiguration(second)).not.toThrow();
	});

	test("rejects unknown, overlapping, and duplicate feature requests", () => {
		const unknown = createDefaultXRConfiguration();
		unknown.session.optionalFeatures = ["not-a-webxr-feature" as never];
		expect(() => validateXRConfiguration(unknown)).toThrow("Unsupported WebXR session feature");

		const overlap = createDefaultXRConfiguration();
		overlap.session.requiredFeatures = ["hand-tracking"];
		overlap.session.optionalFeatures = ["hand-tracking"];
		expect(() => validateXRConfiguration(overlap)).toThrow("both required and optional");

		const duplicate = createDefaultXRConfiguration();
		duplicate.session.optionalFeatures = ["hit-test", "hit-test"];
		expect(() => validateXRConfiguration(duplicate)).toThrow("unique");
	});

	test("rejects malformed version two values instead of silently resetting them", () => {
		expect(() => normalizeXRConfiguration({ version: 2, revision: 1, enabled: "yes" })).toThrow("XR enabled must be a boolean");
		expect(() => normalizeXRConfiguration({ version: 2, revision: 0 })).toThrow("positive safe integer");
		expect(() => normalizeXRConfiguration({ version: 2, revision: 1, locomotion: { snapPoints: [[0, 1]] } })).toThrow("exactly three");
		expect(() => normalizeXRConfiguration({ version: 3, revision: 1 })).toThrow("newer than supported");
		expect(() => normalizeXRConfiguration({ version: "2", revision: 1 })).toThrow("version must be a positive integer");
	});

	test("enforces bounded simulator and locomotion values", () => {
		const configuration = createDefaultXRConfiguration();
		configuration.simulation.maxRayDistance = 20_000;
		expect(() => validateXRConfiguration(configuration)).toThrow("maxRayDistance");
		configuration.simulation.maxRayDistance = 100;
		configuration.locomotion.rotationAngleDegrees = 0;
		expect(() => validateXRConfiguration(configuration)).toThrow("rotationAngleDegrees");
	});

	test("requires stable unique interactables and one record per mesh", () => {
		const configuration = createDefaultXRConfiguration();
		configuration.interactables = [
			{
				id: "grab-box",
				name: "Grab Box",
				meshId: "box",
				enabled: true,
				modes: ["select", "grab"],
				interactionLayers: ["default"],
				rotateWithController: true,
				dragSmoothing: 0.2,
				hapticAmplitude: 0.5,
				hapticDurationMs: 25,
			},
		];
		expect(() => validateXRConfiguration(configuration)).not.toThrow();

		configuration.interactables.push({ ...configuration.interactables[0], id: "grab-box-2" });
		expect(() => validateXRConfiguration(configuration)).toThrow("more than one XR interactable");
	});

	test("persists only validated clones on a scene metadata host", () => {
		const scene: { metadata?: Record<string, unknown> } = {
			metadata: { babylonEditorXR: { enabled: true, referenceSpaceType: "local-floor", floorMeshIds: ["floor"], features: ["teleportation"] } },
		};
		const migrated = getSceneXRConfiguration(scene);
		expect(migrated).toMatchObject({ version: 2, revision: 1, enabled: true });
		expect(scene.metadata?.babylonEditorXR).toEqual(migrated);

		const next = structuredClone(migrated);
		next.revision = 2;
		next.session.mode = "immersive-ar";
		const stored = setSceneXRConfiguration(scene, next);
		stored.session.mode = "immersive-vr";
		expect((scene.metadata?.babylonEditorXR as { session: { mode: string } }).session.mode).toBe("immersive-ar");
	});
});
