import { describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PointerEventTypes, PointerInfo } from "@babylonjs/core/Events/pointerEvents";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Observable } from "@babylonjs/core/Misc/observable";
import { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
import { Scene } from "@babylonjs/core/scene";
import { WebXRDefaultExperience, WebXRDefaultExperienceOptions } from "@babylonjs/core/XR/webXRDefaultExperience";
import { WebXRInputSource } from "@babylonjs/core/XR/webXRInputSource";
import { WebXRState } from "@babylonjs/core/XR/webXRTypes";

import { configureXR, createXRExperienceOptions, enterXRSession, exitXRSession, getXRRuntime, getXRRuntimeSnapshot } from "../../src/loading/xr";
import { createDefaultXRConfiguration, setSceneXRConfiguration } from "../../src/loading/xr-model";

interface IFakeExperience {
	experience: WebXRDefaultExperience;
	state: Observable<WebXRState>;
	controllerAdded: Observable<WebXRInputSource>;
	controllerRemoved: Observable<WebXRInputSource>;
	dispose: ReturnType<typeof vi.fn>;
	enter: ReturnType<typeof vi.fn>;
	exit: ReturnType<typeof vi.fn>;
	movementOptions: unknown[];
	sessionManager: { worldScalingFactor: number };
	teleportation: { rotationAngle: number };
}

function createFakeExperience(): IFakeExperience {
	const state = new Observable<WebXRState>();
	const controllerAdded = new Observable<WebXRInputSource>();
	const controllerRemoved = new Observable<WebXRInputSource>();
	const dispose = vi.fn();
	const movementOptions: unknown[] = [];
	const sessionManager = { worldScalingFactor: 0 };
	const teleportation = { rotationAngle: 0 };
	const enter = vi.fn(async () => {
		state.notifyObservers(WebXRState.ENTERING_XR);
		state.notifyObservers(WebXRState.IN_XR);
	});
	const exit = vi.fn(async () => {
		state.notifyObservers(WebXRState.EXITING_XR);
		state.notifyObservers(WebXRState.NOT_IN_XR);
	});
	const experience = {
		baseExperience: {
			state: WebXRState.NOT_IN_XR,
			onStateChangedObservable: state,
			sessionManager,
			featuresManager: {
				getEnabledFeatures: () => (movementOptions.length ? ["xr-controller-movement"] : []),
				enableFeature: (_name: string, _version: string, options: unknown) => {
					movementOptions.push(options);
					return {};
				},
			},
			enterXRAsync: enter,
			exitXRAsync: exit,
		},
		input: { controllers: [], onControllerAddedObservable: controllerAdded, onControllerRemovedObservable: controllerRemoved },
		pointerSelection: { getXRControllerByPointerId: () => null },
		teleportation,
		renderTarget: {},
		dispose,
	} as unknown as WebXRDefaultExperience;
	return { experience, state, controllerAdded, controllerRemoved, dispose, enter, exit, movementOptions, sessionManager, teleportation };
}

function createScene(): { engine: NullEngine; scene: Scene } {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	new FreeCamera("camera", Vector3.Zero(), scene);
	return { engine, scene };
}

describe("loading/xr", () => {
	test("maps canonical session, interaction, locomotion, and floor authoring into Babylon options", () => {
		const { engine, scene } = createScene();
		const floor = MeshBuilder.CreateGround("floor", { width: 10, height: 10 }, scene);
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.session.mode = "immersive-ar";
		configuration.session.requiredFeatures = ["hit-test"];
		configuration.session.optionalFeatures = ["hand-tracking"];
		configuration.origin.floorMeshIds = [floor.id];
		configuration.interaction.preferredHandedness = "right";
		configuration.interaction.maxPointerDistance = 42;
		configuration.locomotion.snapPoints = [[1, 2, 3]];

		const options = createXRExperienceOptions(scene, configuration);
		expect(options).toMatchObject({
			floorMeshes: [floor],
			disablePointerSelection: false,
			disableTeleportation: false,
			disableNearInteraction: false,
			disableHandTracking: false,
			optionalFeatures: ["hand-tracking"],
			pointerSelectionOptions: { preferredHandedness: "right", maxPointerDistance: 42 },
			teleportationOptions: { forceHandedness: "right", snapPointsOnly: false },
			uiOptions: { sessionMode: "immersive-ar", referenceSpaceType: "local-floor", requiredFeatures: ["hit-test"] },
		});
		expect(options.teleportationOptions?.snapPositions?.[0].asArray()).toEqual([1, 2, 3]);
		scene.dispose();
		engine.dispose();
	});

	test("initializes once, enters and exits explicitly, and exposes bounded runtime evidence", async () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.origin.worldScale = 100;
		configuration.locomotion.continuousMove = true;
		configuration.maxTraceEvents = 16;
		setSceneXRConfiguration(scene, configuration);
		const fake = createFakeExperience();
		const factory = vi.fn(async (_scene: Scene, _options: WebXRDefaultExperienceOptions) => fake.experience);

		const runtime = await configureXR(scene, { experienceFactory: factory, now: () => 123 });
		expect(runtime?.snapshot()).toMatchObject({ phase: "ready", configurationRevision: 1, experienceInitialized: true, inSession: false, lastError: null });
		expect(factory).toHaveBeenCalledTimes(1);
		expect(fake.sessionManager.worldScalingFactor).toBe(100);
		expect(fake.movementOptions).toHaveLength(1);
		expect(fake.teleportation.rotationAngle).toBeCloseTo(Math.PI / 8);
		await runtime?.initialize();
		expect(factory).toHaveBeenCalledTimes(1);

		await enterXRSession(scene);
		expect(getXRRuntimeSnapshot(scene)).toMatchObject({ phase: "in-xr", inSession: true });
		expect(fake.enter).toHaveBeenCalledWith("immersive-vr", "local-floor", fake.experience.renderTarget, { requiredFeatures: [], optionalFeatures: [] });
		await exitXRSession(scene);
		expect(getXRRuntimeSnapshot(scene)).toMatchObject({ phase: "ready", inSession: false });
		expect(fake.exit).toHaveBeenCalledTimes(1);
		expect(getXRRuntimeSnapshot(scene)?.trace.map((entry) => entry.timestamp)).toEqual([123, 123, 123, 123, 123, 123]);

		scene.dispose();
		expect(fake.dispose).toHaveBeenCalledTimes(1);
		expect(getXRRuntime(scene)).toBeNull();
		engine.dispose();
	});

	test("applies select and grab affordances, records pointer evidence, and restores exact mesh state", async () => {
		const { engine, scene } = createScene();
		const mesh = MeshBuilder.CreateBox("box", {}, scene);
		mesh.isPickable = false;
		mesh.isNearPickable = false;
		mesh.isNearGrabbable = false;
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.interactables = [
			{
				id: "box-interaction",
				name: "Box Interaction",
				meshId: mesh.id,
				enabled: true,
				modes: ["select", "grab"],
				interactionLayers: ["default"],
				rotateWithController: true,
				dragSmoothing: 0.35,
				hapticAmplitude: 0,
				hapticDurationMs: 0,
			},
		];
		setSceneXRConfiguration(scene, configuration);
		const fake = createFakeExperience();
		const runtime = await configureXR(scene, { experienceFactory: async () => fake.experience });

		expect(mesh).toMatchObject({ isPickable: true, isNearPickable: true, isNearGrabbable: true });
		expect(mesh.behaviors.some((behavior) => behavior.name === "SixDofDrag")).toBe(true);
		const pick = new PickingInfo();
		pick.pickedMesh = mesh;
		scene.onPointerObservable.notifyObservers(new PointerInfo(PointerEventTypes.POINTERMOVE, { pointerId: 7 } as never, pick));
		scene.onPointerObservable.notifyObservers(new PointerInfo(PointerEventTypes.POINTERDOWN, { pointerId: 7 } as never, pick));
		expect(runtime?.snapshot().trace.map((entry) => entry.type)).toContain("hover");
		expect(runtime?.snapshot().trace.map((entry) => entry.type)).toContain("select");

		runtime?.dispose();
		expect(mesh).toMatchObject({ isPickable: false, isNearPickable: false, isNearGrabbable: false });
		expect(mesh.behaviors.some((behavior) => behavior.name === "SixDofDrag")).toBe(false);
		scene.dispose();
		engine.dispose();
	});

	test("turns initialization rejection into inspectable error state without an unhandled exception", async () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		setSceneXRConfiguration(scene, configuration);
		const warn = vi.fn();

		const runtime = await configureXR(scene, {
			experienceFactory: async () => {
				throw new Error("WebXR unavailable");
			},
			warn,
		});
		expect(runtime?.snapshot()).toMatchObject({
			phase: "error",
			experienceInitialized: false,
			lastError: "Unable to initialize the exported XR experience: WebXR unavailable",
		});
		expect(warn).toHaveBeenCalledTimes(1);
		await expect(runtime?.enterSession()).rejects.toThrow("WebXR unavailable");
		scene.dispose();
		engine.dispose();
	});

	test("reconfiguration disposes the previous helper and a disabled scene retains no runtime", async () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		setSceneXRConfiguration(scene, configuration);
		const first = createFakeExperience();
		const second = createFakeExperience();
		await configureXR(scene, { experienceFactory: async () => first.experience });
		await configureXR(scene, { experienceFactory: async () => second.experience });
		expect(first.dispose).toHaveBeenCalledTimes(1);

		configuration.enabled = false;
		configuration.revision = 2;
		setSceneXRConfiguration(scene, configuration);
		expect(await configureXR(scene, { experienceFactory: async () => second.experience })).toBeNull();
		expect(second.dispose).toHaveBeenCalledTimes(1);
		expect(getXRRuntime(scene)).toBeNull();
		scene.dispose();
		engine.dispose();
	});

	test("keeps a working lease when replacement metadata is malformed", async () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		setSceneXRConfiguration(scene, configuration);
		const fake = createFakeExperience();
		const runtime = await configureXR(scene, { experienceFactory: async () => fake.experience });
		scene.metadata!.babylonEditorXR = { version: 2, revision: 2, enabled: "invalid" };

		await expect(configureXR(scene, { experienceFactory: async () => fake.experience })).rejects.toThrow("XR enabled must be a boolean");
		expect(fake.dispose).not.toHaveBeenCalled();
		expect(getXRRuntime(scene)).toBe(runtime);
		runtime?.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("disposes a helper when post-creation feature setup fails", async () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		configuration.locomotion.continuousMove = true;
		setSceneXRConfiguration(scene, configuration);
		const fake = createFakeExperience();
		(fake.experience.baseExperience.featuresManager.enableFeature as unknown as ReturnType<typeof vi.fn>) = vi.fn(() => {
			throw new Error("movement conflict");
		});

		const runtime = await configureXR(scene, { experienceFactory: async () => fake.experience, warn: vi.fn() });
		expect(runtime?.snapshot()).toMatchObject({ phase: "error", experienceInitialized: false, lastError: expect.stringContaining("movement conflict") });
		expect(fake.dispose).toHaveBeenCalledTimes(1);
		expect(scene.xrExperience).toBeUndefined();
		scene.dispose();
		engine.dispose();
	});

	test("does not resurrect an asynchronously disposed initialization", async () => {
		const { engine, scene } = createScene();
		const configuration = createDefaultXRConfiguration();
		configuration.enabled = true;
		setSceneXRConfiguration(scene, configuration);
		let rejectFactory: (error: Error) => void = () => undefined;
		const factoryPromise = new Promise<WebXRDefaultExperience>((_resolve, reject) => {
			rejectFactory = reject;
		});
		const warning = vi.fn();
		const configuring = configureXR(scene, { experienceFactory: async () => factoryPromise, warn: warning });
		const runtime = getXRRuntime(scene);
		runtime?.dispose();
		rejectFactory(new Error("late failure"));

		const result = await configuring;
		expect(result?.snapshot()).toMatchObject({ phase: "disposed", lastError: null });
		expect(warning).not.toHaveBeenCalled();
		expect(getXRRuntime(scene)).toBeNull();
		scene.dispose();
		engine.dispose();
	});
});
