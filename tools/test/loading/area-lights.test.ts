import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Light } from "@babylonjs/core/Lights/light";
import { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import {
	areaLightBackend,
	configureAreaLights,
	createAreaLight,
	getAreaLightBasis,
	getAreaLightEvidence,
	getAreaLightMetadata,
	setAreaLightProperties,
} from "../../src/loading/area-lights";

describe("loading/area-lights", () => {
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

	test("creates oriented rectangle and disc lights with versioned bounded evidence", () => {
		const rectangle = createAreaLight("Rectangle", new Vector3(10, 20, 30), "rectangle", scene, {
			width: 400,
			height: 200,
			direction: [0, -1, 0],
			upDirection: [0, 0, 1],
		});
		rectangle.intensity = 2.5;
		rectangle.range = 1500;
		expect(getAreaLightEvidence(rectangle)).toMatchObject({
			backend: areaLightBackend,
			version: 1,
			revision: 1,
			shape: "rectangle",
			width: 400,
			height: 200,
			position: [10, 20, 30],
			worldDirection: [0, -1, 0],
			worldRight: [-1, 0, 0],
			worldUp: [0, 0, 1],
			worldHalfWidth: [-200, 0, 0],
			worldHalfHeight: [0, 0, 100],
			area: 80_000,
			intensity: 2.5,
			range: 1500,
			nativeForwardModel: "babylon-ltc-rectangle",
			deferredModel: "babylon-ltc-rectangle",
			bakedModel: "deterministic-stratified-rectangle",
			oneSided: true,
			castsRealtimeShadows: false,
		});

		const disc = createAreaLight("Disc", Vector3.Zero(), "disc", scene, { radius: 75 });
		expect(getAreaLightEvidence(disc)).toMatchObject({
			revision: 1,
			shape: "disc",
			radius: 75,
			area: Math.PI * 75 * 75,
			nativeForwardModel: "bounded-ltc-disc-rectangle",
			deferredModel: "bounded-ltc-disc-16-gon",
			bakedModel: "deterministic-concentric-disc",
		});
		const changed = setAreaLightProperties(disc, { radius: 100, direction: [0, 0, 1] });
		expect(changed).toMatchObject({ revision: 2, radius: 100, worldDirection: [0, 0, 1] });
	});

	test("preserves the local authoring basis through parent transforms and scene serialization", () => {
		const parent = new TransformNode("Parent", scene);
		parent.position.set(100, 0, 0);
		parent.rotationQuaternion = Quaternion.FromEulerAngles(0, Math.PI / 2, 0);
		const light = createAreaLight("Serialized Area", new Vector3(0, 0, 50), "rectangle", scene, {
			width: 300,
			height: 120,
			direction: [0, 0, -1],
			upDirection: [0, 1, 0],
		});
		light.parent = parent;
		parent.computeWorldMatrix(true);
		const basis = getAreaLightBasis(light);
		expect(basis.position.asArray()[0]).toBeCloseTo(150, 5);
		expect(basis.direction.x).toBeCloseTo(-1, 5);

		const serialized = light.serialize();
		light.dispose();
		const parsed = Light.Parse(serialized, scene) as RectAreaLight;
		expect(parsed).toBeInstanceOf(RectAreaLight);
		const configured = configureAreaLights(scene, [parsed]);
		expect(configured).toHaveLength(1);
		expect(getAreaLightMetadata(parsed)).toMatchObject({
			version: 1,
			revision: 1,
			shape: "rectangle",
			width: 300,
			height: 120,
			direction: [0, 0, -1],
			upDirection: [0, 1, 0],
		});
	});

	test("adopts imported native rectangles without misclassifying them as discs", () => {
		const native = new RectAreaLight("Native", Vector3.Zero(), 240, 80, scene);
		delete native.metadata?.babylonEditorAreaLight;
		const evidence = configureAreaLights(scene, [native]);
		expect(evidence).toEqual([expect.objectContaining({ shape: "rectangle", width: 240, height: 80, revision: 1, nativeForwardModel: "babylon-ltc-rectangle" })]);
		expect(native.metadata.babylonEditorAreaLight).toMatchObject({ shape: "rectangle", width: 240, height: 80 });
	});
});
