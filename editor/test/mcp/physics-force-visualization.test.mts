import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Constants, MeshBuilder, NullEngine, Observable, PhysicsMotionType, Scene, Vector3 } from "babylonjs";

import { collectPhysicsBodyForceVectors, createPhysicsForceBodySamplingState, samplePhysicsBodyNetForces } from "../../src/mcp/physics/force-body-vectors";
import { collectPhysicsConstraintVectors, collectPhysicsContactForceVectors } from "../../src/mcp/physics/force-scene-vectors";
import { collectPhysicsForceVectors } from "../../src/mcp/physics/force-vector-collector";
import { createPhysicsForceVectorOverlay } from "../../src/mcp/physics/force-vector-renderer";
import { getPhysicsForceVisualization, setPhysicsForceVisualization } from "../../src/mcp/physics/force-visualization";
import { defaultPhysicsForceVisualizationSettings, isPhysicsForceVectorCategory, physicsForceVectorCategories } from "../../src/mcp/physics/force-visualization-types";
import { startPhysicsContactCapture, stopPhysicsContactCapture } from "../../src/mcp/physics/contacts";
import { isNodeSerializable, isNodeVisibleInGraph } from "../../src/tools/node/metadata";

describe("mcp/physics force visualization", () => {
	const activeObserverCount = (observable: Observable<any>): number => observable.observers.filter((observer: any) => !observer._willBeUnregistered).length;

	test("keeps the public vector categories closed and enables every category by default", () => {
		expect(new Set(physicsForceVectorCategories).size).toBe(physicsForceVectorCategories.length);
		expect(defaultPhysicsForceVisualizationSettings.categories).toEqual(physicsForceVectorCategories);
		expect(physicsForceVectorCategories.every(isPhysicsForceVectorCategory)).toBe(true);
		expect(isPhysicsForceVectorCategory("applied-force-that-the-engine-did-not-retain")).toBe(false);
	});

	describe("body sampling", () => {
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

		test("derives bounded net force from completed velocity samples without mutating the body", () => {
			let linearVelocity = new Vector3(1, 2, 3);
			const body = {
				getMotionType: vi.fn(() => PhysicsMotionType.DYNAMIC),
				getMassProperties: vi.fn(() => ({ mass: 2 })),
				getLinearVelocity: vi.fn(() => linearVelocity.clone()),
				getAngularVelocity: vi.fn(() => new Vector3(0, 1, 0)),
				setLinearVelocity: vi.fn(),
				applyForce: vi.fn(),
			};
			const mesh = MeshBuilder.CreateBox("Body", {}, scene);
			(mesh as any).physicsAggregate = { body };
			const unavailable = MeshBuilder.CreateBox("Unavailable Velocity", {}, scene);
			(unavailable as any).physicsAggregate = { body: { getMassProperties: () => ({ mass: 5 }) } };
			vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ gravity: new Vector3(0, -981, 0), getTimeStep: () => 0.5 } as any);
			const sampling = createPhysicsForceBodySamplingState();

			samplePhysicsBodyNetForces(scene, sampling);
			linearVelocity = new Vector3(11, 2, 3);
			samplePhysicsBodyNetForces(scene, sampling);
			const vectors = collectPhysicsBodyForceVectors(scene, sampling);

			expect(Object.fromEntries(vectors.map((vector) => [vector.category, vector.vector]))).toMatchObject({
				"gravity-force": [0, -1962, 0],
				"net-force": [40, 0, 0],
				"linear-velocity": [11, 2, 3],
				"angular-velocity": [0, 1, 0],
			});
			expect(sampling).toMatchObject({ sampleCount: 2, lastDeltaSeconds: 0.5 });
			expect(vectors.some((vector) => vector.nodeId === unavailable.id)).toBe(false);
			expect(body.setLinearVelocity).not.toHaveBeenCalled();
			expect(body.applyForce).not.toHaveBeenCalled();
			const bounded = collectPhysicsForceVectors(scene, sampling, {
				...defaultPhysicsForceVisualizationSettings,
				categories: ["gravity-force", "linear-velocity"],
				bodyNodeIds: [mesh.id],
				maximumVectors: 1,
			});
			expect(bounded).toMatchObject({
				availableVectorCount: 2,
				truncatedVectorCount: 1,
				visibleVectorCount: 1,
				page: { count: 1, total: 1, hasMore: false },
			});
			expect(bounded.vectors[0]).toMatchObject({ category: "gravity-force", nodeId: mesh.id });

			samplePhysicsBodyNetForces(scene, sampling, 0);
			expect(collectPhysicsBodyForceVectors(scene, sampling).some((vector) => vector.category === "net-force")).toBe(false);
		});

		test("converts captured contacts and authored constraint frames without fabricating reaction forces", () => {
			const contacts = new Observable<any>();
			const parent = MeshBuilder.CreateBox("Parent", {}, scene);
			const child = MeshBuilder.CreateBox("Child", {}, scene);
			child.position.x = 25;
			const parentBody = { _collisionCBEnabled: false, setCollisionCallbackEnabled: vi.fn() };
			const childBody = { _collisionCBEnabled: false, setCollisionCallbackEnabled: vi.fn() };
			(parent as any).physicsAggregate = { body: parentBody };
			(child as any).physicsAggregate = { body: childBody };
			scene.metadata = {
				babylonEditorPhysicsConstraints: [
					{ id: "joint", type: "hinge", parentNodeId: parent.id, childNodeId: child.id, pivotA: [0, 0, 0], pivotB: [0, 0, 0], axisA: [0, 1, 0] },
				],
			};
			vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ getPhysicsPlugin: () => ({ onCollisionObservable: contacts }) } as any);
			const options = { editor: { layout: { preview: { play: null }, inspector: { forceUpdate: vi.fn() } } } } as any;

			startPhysicsContactCapture(scene, { maxEvents: 4 }, options);
			contacts.notifyObservers({
				type: "COLLISION_STARTED",
				collider: { transformNode: parent },
				collidedAgainst: { transformNode: child },
				point: new Vector3(1, 2, 3),
				normal: new Vector3(0, 2, 0),
				impulse: 7,
			});
			const vectors = [...collectPhysicsContactForceVectors(scene), ...collectPhysicsConstraintVectors(scene)];

			expect(Object.fromEntries(vectors.map((value) => [value.category, value.vector]))).toMatchObject({
				"contact-normal": [0, 1, 0],
				"contact-impulse": [0, 7, 0],
				"constraint-axis": [0, 1, 0],
				"constraint-separation": [25, 0, 0],
			});
			expect(vectors.every((value) => value.category !== ("constraint-reaction" as any))).toBe(true);
			stopPhysicsContactCapture(scene, {}, options);
			expect(parentBody.setCollisionCallbackEnabled).toHaveBeenLastCalledWith(false);
			expect(childBody.setCollisionCallbackEnabled).toHaveBeenLastCalledWith(false);
		});
	});

	test("renders every finite non-zero vector into one temporary bounded line system", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const overlay = createPhysicsForceVectorOverlay(
			scene,
			[
				{
					id: "body:gravity",
					category: "gravity-force",
					label: "Gravity force",
					nodeId: "body",
					nodeName: "Body",
					relatedNodeId: null,
					origin: [0, 0, 0],
					vector: [0, -981, 0],
					magnitude: 981,
					unit: "kg·cm/s²",
					provenance: "live",
				},
				{
					id: "body:velocity",
					category: "linear-velocity",
					label: "Linear velocity",
					nodeId: "body",
					nodeName: "Body",
					relatedNodeId: null,
					origin: [0, 0, 0],
					vector: [10, 0, 0],
					magnitude: 10,
					unit: "cm/s",
					provenance: "live",
				},
				{
					id: "zero",
					category: "constraint-separation",
					label: "Zero",
					nodeId: null,
					nodeName: null,
					relatedNodeId: null,
					origin: [0, 0, 0],
					vector: [0, 0, 0],
					magnitude: 0,
					unit: "cm",
					provenance: "live",
				},
			],
			{ ...defaultPhysicsForceVisualizationSettings }
		);

		expect(overlay).not.toBeNull();
		expect(scene.meshes.filter((mesh) => mesh.name === "Physics Force Vectors")).toHaveLength(1);
		expect(overlay).toMatchObject({ isPickable: false, alwaysSelectAsActiveMesh: true, renderingGroupId: 3 });
		expect(overlay?.material).toMatchObject({ disableDepthWrite: true, depthFunction: Constants.ALWAYS });
		expect(overlay?.getTotalVertices()).toBe(12);
		expect(isNodeSerializable(overlay!)).toBe(false);
		expect(isNodeVisibleInGraph(overlay!)).toBe(false);

		overlay?.dispose(false, true);
		scene.dispose();
		engine.dispose();
	});

	test("owns one exact-revision visualization lifecycle without advancing or mutating physics", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const time = vi.spyOn(performance, "now").mockReturnValue(1000);
		let linearVelocity = new Vector3(1, 0, 0);
		const body = {
			getMotionType: vi.fn(() => PhysicsMotionType.DYNAMIC),
			getMassProperties: vi.fn(() => ({ mass: 2 })),
			getLinearVelocity: vi.fn(() => linearVelocity.clone()),
			getAngularVelocity: vi.fn(() => Vector3.Zero()),
			setLinearVelocity: vi.fn(),
			setAngularVelocity: vi.fn(),
			applyForce: vi.fn(),
			applyImpulse: vi.fn(),
		};
		const physics = { gravity: new Vector3(0, -981, 0), getTimeStep: () => 0.5, _step: vi.fn() };
		const mesh = MeshBuilder.CreateBox("Body", {}, scene);
		(mesh as any).physicsAggregate = { body };
		(scene as any).onAfterPhysicsObservable = new Observable<Scene>();
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue(physics as any);
		const forceUpdate = vi.fn();
		const options = { editor: { layout: { preview: { play: null }, inspector: { forceUpdate } } } } as any;
		const beforeRenderObservers = activeObserverCount(scene.onBeforeRenderObservable);
		const afterPhysicsObservers = activeObserverCount(scene.onAfterPhysicsObservable);

		expect(getPhysicsForceVisualization(scene, {}, options)).toMatchObject({ target: "editor", revision: 1, enabled: false, physicsAdvanced: false, bodiesMutated: false });
		const enabled = setPhysicsForceVisualization(
			scene,
			{
				expectedRevision: 1,
				enabled: true,
				categories: ["gravity-force", "net-force", "linear-velocity"],
				maximumVectors: 8,
				refreshIntervalMs: 16,
			},
			options
		);
		expect(enabled).toMatchObject({ revision: 2, enabled: true, activeOverlayCount: 1, renderedVectorCount: 2, renderedLineCount: 6, sampling: { sampleCount: 1 } });
		expect(activeObserverCount(scene.onBeforeRenderObservable)).toBe(beforeRenderObservers + 1);
		expect(activeObserverCount(scene.onAfterPhysicsObservable)).toBe(afterPhysicsObservers + 1);

		linearVelocity = new Vector3(11, 0, 0);
		scene.onAfterPhysicsObservable.notifyObservers(scene);
		time.mockReturnValue(1020);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const sampled = getPhysicsForceVisualization(scene, { limit: 10 }, options);
		expect(sampled).toMatchObject({ revision: 2, enabled: true, renderedVectorCount: 3, renderedLineCount: 9, sampling: { sampleCount: 2, derivedNetForceCount: 1 } });
		expect(sampled.vectors.find((vector: any) => vector.category === "net-force")).toMatchObject({ vector: [40, 0, 0], provenance: "derived" });
		expect(physics._step).not.toHaveBeenCalled();
		expect(body.setLinearVelocity).not.toHaveBeenCalled();
		expect(body.setAngularVelocity).not.toHaveBeenCalled();
		expect(body.applyForce).not.toHaveBeenCalled();
		expect(body.applyImpulse).not.toHaveBeenCalled();

		expect(() => setPhysicsForceVisualization(scene, { expectedRevision: 1, forceScale: 1 }, options)).toThrow(/revision is stale/i);
		expect(() => setPhysicsForceVisualization(scene, { expectedRevision: 2, categories: ["reaction-force"] }, options)).toThrow(/supported force-vector categories/i);
		expect(getPhysicsForceVisualization(scene, {}, options)).toMatchObject({ revision: 2, enabled: true, settings: { forceScale: 0.05 } });

		const disabled = setPhysicsForceVisualization(scene, { expectedRevision: 2, enabled: false }, options);
		expect(disabled).toMatchObject({ revision: 3, enabled: false, activeOverlayCount: 0, renderedVectorCount: 0, renderedLineCount: 0, sampling: { sampleCount: 0 } });
		expect(activeObserverCount(scene.onBeforeRenderObservable)).toBe(beforeRenderObservers);
		expect(activeObserverCount(scene.onAfterPhysicsObservable)).toBe(afterPhysicsObservers);
		expect(scene.meshes.some((value) => value.name === "Physics Force Vectors")).toBe(false);

		time.mockRestore();
		scene.dispose();
		engine.dispose();
	});

	test("keeps an enabled Play visualization owner-stable and releases it on Play disposal", () => {
		const engine = new NullEngine();
		const editScene = new Scene(engine);
		const playScene = new Scene(engine);
		const play = { canPlayScene: true, scene: playScene };
		const options = { editor: { layout: { preview: { play }, inspector: { forceUpdate: vi.fn() } } } } as any;

		const enabled = setPhysicsForceVisualization(editScene, { expectedRevision: 1, enabled: true, categories: ["constraint-axis"] }, options);
		expect(enabled).toMatchObject({ target: "play", revision: 2, enabled: true });
		play.canPlayScene = false;
		expect(getPhysicsForceVisualization(editScene, {}, options)).toMatchObject({ target: "play", revision: 2, enabled: true });

		playScene.dispose();
		expect(getPhysicsForceVisualization(editScene, {}, options)).toMatchObject({ target: "editor", revision: 1, enabled: false });

		editScene.dispose();
		engine.dispose();
	});

	test("rejects malformed updates and queries atomically at the editor bridge", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const options = { editor: { layout: { preview: { play: null }, inspector: { forceUpdate: vi.fn() } } } } as any;
		const invalidUpdates = [
			{ expectedRevision: 1 },
			{ expectedRevision: 1, unknown: true },
			{ expectedRevision: 1, enabled: "true" },
			{ expectedRevision: 1, clear: 1 },
			{ expectedRevision: 1, categories: [] },
			{ expectedRevision: 1, categories: ["net-force", "net-force"] },
			{ expectedRevision: 1, bodyNodeIds: [" body"] },
			{ expectedRevision: 1, bodyNodeIds: ["body", "body"] },
			{ expectedRevision: 1, maximumVectors: 0 },
			{ expectedRevision: 1, refreshIntervalMs: 15 },
			{ expectedRevision: 1, forceScale: 0 },
			{ expectedRevision: 1, impulseScale: Number.NaN },
			{ expectedRevision: 1, pointSize: 1001 },
		];
		for (const update of invalidUpdates) {
			expect(() => setPhysicsForceVisualization(scene, update, options)).toThrow();
		}
		expect(() => getPhysicsForceVisualization(scene, { unknown: true }, options)).toThrow(/unknown/i);
		expect(() => getPhysicsForceVisualization(scene, { categories: [] }, options)).toThrow(/categories/i);
		expect(() => getPhysicsForceVisualization(scene, { bodyNodeIds: ["body", "body"] }, options)).toThrow(/bodyNodeIds/i);
		expect(() => getPhysicsForceVisualization(scene, { offset: -1 }, options)).toThrow(/offset/i);
		expect(() => getPhysicsForceVisualization(scene, { limit: 101 }, options)).toThrow(/limit/i);
		expect(getPhysicsForceVisualization(scene, { endpoint: "get_physics_force_visualization", collaborationToken: "transport-only", limit: 1 }, options)).toMatchObject({
			revision: 1,
			enabled: false,
		});
		expect(
			setPhysicsForceVisualization(
				scene,
				{ endpoint: "set_physics_force_visualization", collaborationToken: "transport-only", expectedRevision: 1, maximumVectors: 32 },
				options
			)
		).toMatchObject({ revision: 2, enabled: false, settings: { maximumVectors: 32 } });
		expect(getPhysicsForceVisualization(scene, {}, options)).toMatchObject({
			revision: 2,
			enabled: false,
			settings: { ...defaultPhysicsForceVisualizationSettings, maximumVectors: 32 },
		});
		expect(scene.meshes.some((mesh) => mesh.name === "Physics Force Vectors")).toBe(false);

		scene.dispose();
		engine.dispose();
	});

	test("releases observers and temporary geometry when the active authored scene changes even if the Inspector is unmounting", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		let activeScene = "scene-a";
		const listeners = new Set<() => void>();
		const forceUpdate = vi.fn(() => {
			throw new Error("Inspector unmounted");
		});
		const options = {
			editor: {
				layout: { preview: { play: null }, inspector: { forceUpdate } },
				sceneWorkspace: {
					getSettings: () => ({ activeScene }),
					subscribe: (listener: () => void) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
			},
		} as any;
		const initialObservers = activeObserverCount(scene.onBeforeRenderObservable);

		const enabled = setPhysicsForceVisualization(scene, { expectedRevision: 1, enabled: true, categories: ["constraint-axis"] }, options);
		expect(enabled.lastError?.message).toMatch(/Inspector refresh failed: Inspector unmounted/);
		expect(activeObserverCount(scene.onBeforeRenderObservable)).toBe(initialObservers + 1);
		expect(listeners.size).toBe(1);
		activeScene = "scene-b";
		expect(() => [...listeners].forEach((listener) => listener())).not.toThrow();

		expect(activeObserverCount(scene.onBeforeRenderObservable)).toBe(initialObservers);
		expect(listeners.size).toBe(0);
		expect(forceUpdate).toHaveBeenCalled();
		expect(scene.meshes.some((mesh) => mesh.name === "Physics Force Vectors")).toBe(false);
		expect(getPhysicsForceVisualization(scene, {}, options)).toMatchObject({ revision: 1, enabled: false, activeOverlayCount: 0 });

		scene.dispose();
		engine.dispose();
	});
});
