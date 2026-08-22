import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ensureDir, mkdtemp, remove, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Observable, Scene } from "babylonjs";

import { readPhysicsContactHistoryAsset } from "../../src/mcp/physics/contact-history-assets";
import { controlPhysicsContactHistoryReplay, getPhysicsContactHistoryReplay, startPhysicsContactHistoryReplay } from "../../src/mcp/physics/contact-history-replay";
import { startPhysicsContactCapture, stopPhysicsContactCapture } from "../../src/mcp/physics/contacts";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/physics contact history replay", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let options: any;
	let activeScene: string;
	let workspaceListener: (() => void) | null;
	let physicsStep: ReturnType<typeof vi.fn>;
	let collisionObservable: Observable<any>;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-physics-contact-replay-"));
		projectConfiguration.path = join(directory, "project.bjseditor");
		await ensureDir(join(directory, "assets"));
		await writeJSON(join(directory, "assets", "impact.physicscontacts.json"), {
			version: 1,
			type: "babylon-editor-physics-contact-history",
			id: "history-1",
			name: "Impact",
			revision: 1,
			createdAt: "2026-07-30T00:00:00.000Z",
			durationMs: 400,
			source: { target: "play", scenePath: "assets/main.scene", includeContinued: true, droppedEvents: 0, capturedBodyCount: 2, maxEvents: 10 },
			events: [
				{
					sequence: 0,
					elapsedMs: 100,
					type: "COLLISION_STARTED",
					colliderNodeId: "body-a",
					colliderName: "Body A",
					colliderIndex: 0,
					collidedAgainstNodeId: "body-b",
					collidedAgainstName: "Body B",
					collidedAgainstIndex: 0,
					point: [1, 2, 3],
					normal: [0, 1, 0],
					distance: -1,
					impulse: 2,
				},
				{
					sequence: 1,
					elapsedMs: 200,
					type: "COLLISION_CONTINUED",
					colliderNodeId: "body-a",
					colliderName: "Body A",
					colliderIndex: 0,
					collidedAgainstNodeId: "body-b",
					collidedAgainstName: "Body B",
					collidedAgainstIndex: 0,
					point: [2, 2, 3],
					normal: [0, 1, 0],
					distance: -0.5,
					impulse: 5,
				},
				{
					sequence: 2,
					elapsedMs: 300,
					type: "COLLISION_FINISHED",
					colliderNodeId: "body-a",
					colliderName: "Body A",
					colliderIndex: 0,
					collidedAgainstNodeId: "body-b",
					collidedAgainstName: "Body B",
					collidedAgainstIndex: 0,
					point: [3, 2, 3],
					normal: [0, 1, 0],
					distance: 0,
					impulse: 0,
				},
			],
		});
		engine = new NullEngine();
		scene = new Scene(engine);
		physicsStep = vi.fn();
		collisionObservable = new Observable<any>();
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ _step: physicsStep, getPhysicsPlugin: () => ({ onCollisionObservable: collisionObservable }) } as any);
		activeScene = "assets/main.scene";
		workspaceListener = null;
		options = {
			editor: {
				layout: { inspector: { forceUpdate: vi.fn() }, preview: {} },
				sceneWorkspace: {
					getSettings: () => ({ activeScene }),
					subscribe: (listener: () => void) => {
						workspaceListener = listener;
						return () => {
							workspaceListener = null;
						};
					},
				},
			},
		};
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = null;
		await remove(directory);
	});

	async function revision(): Promise<string> {
		return (await readPhysicsContactHistoryAsset("assets/impact.physicscontacts.json")).contentRevision;
	}

	test("seeks, steps, configures, and stops under exact session revisions", async () => {
		const started = await startPhysicsContactHistoryReplay(
			scene,
			{ path: "assets/impact.physicscontacts.json", expectedRevision: await revision(), cursorMs: 200, trailMs: 200 },
			options
		);
		expect(started).toMatchObject({ active: true, sessionRevision: 1, cursorMs: 200, selectedEvent: { sequence: 1 }, activeOverlayCount: 2, physicsAdvanced: false });
		expect(scene.meshes.filter((mesh) => mesh.name === "Physics Contact Replay")).toHaveLength(2);

		expect(() => controlPhysicsContactHistoryReplay(scene, { command: "seek", sessionId: started.sessionId, expectedSessionRevision: 0, cursorMs: 100 }, options)).toThrow(
			"session is stale"
		);
		const seek = controlPhysicsContactHistoryReplay(scene, { command: "seek", sessionId: started.sessionId, expectedSessionRevision: 1, cursorMs: 100 }, options);
		expect(seek).toMatchObject({ sessionRevision: 2, cursorMs: 100, selectedEvent: { sequence: 0 }, activeOverlayCount: 1 });
		const step = controlPhysicsContactHistoryReplay(scene, { command: "step", sessionId: started.sessionId, expectedSessionRevision: 2, eventDelta: 1 }, options);
		expect(step).toMatchObject({ sessionRevision: 3, cursorMs: 200, selectedEvent: { sequence: 1 } });

		expect(() =>
			controlPhysicsContactHistoryReplay(scene, { command: "configure", sessionId: started.sessionId, expectedSessionRevision: 3, playbackRate: 2, loop: "yes" }, options)
		).toThrow("loop must be a boolean");
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ sessionRevision: 3, playbackRate: 1, loop: false });
		const configured = controlPhysicsContactHistoryReplay(
			scene,
			{ command: "configure", sessionId: started.sessionId, expectedSessionRevision: 3, playbackRate: 2, loop: true, pointSize: 20 },
			options
		);
		expect(configured).toMatchObject({ sessionRevision: 4, playbackRate: 2, loop: true, pointSize: 20 });
		const stopped = controlPhysicsContactHistoryReplay(scene, { command: "stop", sessionId: started.sessionId, expectedSessionRevision: 4 }, options);
		expect(stopped).toMatchObject({ active: false, stopped: true, sessionRevision: 5, physicsAdvanced: false, callbacksReexecuted: false });
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ active: false });
		expect(scene.meshes.filter((mesh) => mesh.name === "Physics Contact Replay")).toHaveLength(0);
	});

	test("plays and loops from render delta without advancing physics or invoking physics callbacks", async () => {
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(50);
		const beforePhysics = vi.fn();
		const afterPhysics = vi.fn();
		(scene as any).onBeforePhysicsObservable = new Observable<Scene>();
		(scene as any).onAfterPhysicsObservable = new Observable<Scene>();
		scene.onBeforePhysicsObservable?.add(beforePhysics);
		scene.onAfterPhysicsObservable?.add(afterPhysics);
		const physicsEnabled = scene.physicsEnabled;
		const started = await startPhysicsContactHistoryReplay(scene, { path: "assets/impact.physicscontacts.json", expectedRevision: await revision() }, options);
		const playing = controlPhysicsContactHistoryReplay(scene, { command: "play", sessionId: started.sessionId, expectedSessionRevision: 1 }, options);
		expect(playing).toMatchObject({ playing: true, sessionRevision: 2 });
		scene.onBeforeRenderObservable.notifyObservers(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ cursorMs: 150, selectedEvent: { sequence: 0 }, renderFrame: 3 });
		expect(physicsStep).not.toHaveBeenCalled();
		expect(beforePhysics).not.toHaveBeenCalled();
		expect(afterPhysics).not.toHaveBeenCalled();
		expect(scene.physicsEnabled).toBe(physicsEnabled);

		const paused = controlPhysicsContactHistoryReplay(scene, { command: "pause", sessionId: started.sessionId, expectedSessionRevision: 2 }, options);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ playing: false, cursorMs: 150, renderFrame: 3, sessionRevision: 3 });
		const configured = controlPhysicsContactHistoryReplay(
			scene,
			{ command: "configure", sessionId: started.sessionId, expectedSessionRevision: paused.sessionRevision, loop: true },
			options
		);
		const seek = controlPhysicsContactHistoryReplay(
			scene,
			{ command: "seek", sessionId: started.sessionId, expectedSessionRevision: configured.sessionRevision, cursorMs: 390 },
			options
		);
		controlPhysicsContactHistoryReplay(scene, { command: "play", sessionId: started.sessionId, expectedSessionRevision: seek.sessionRevision }, options);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ cursorMs: 40, playing: true });
		expect(physicsStep).not.toHaveBeenCalled();
	});

	test("cleans observers and overlays on workspace switch or scene disposal and rejects ambiguous capture ownership", async () => {
		const started = await startPhysicsContactHistoryReplay(
			scene,
			{ path: "assets/impact.physicscontacts.json", expectedRevision: await revision(), cursorMs: 200, trailMs: 200 },
			options
		);
		const overlays = scene.meshes.filter((mesh) => mesh.name === "Physics Contact Replay");
		expect(overlays).toHaveLength(2);
		activeScene = "assets/other.scene";
		workspaceListener?.();
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ active: false });
		expect(overlays.every((overlay) => overlay.isDisposed())).toBe(true);

		activeScene = "assets/main.scene";
		const restarted = await startPhysicsContactHistoryReplay(scene, { path: "assets/impact.physicscontacts.json", expectedRevision: await revision(), cursorMs: 100 }, options);
		scene.dispose();
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ active: false });
		expect(() => controlPhysicsContactHistoryReplay(scene, { command: "stop", sessionId: restarted.sessionId, expectedSessionRevision: 1 }, options)).toThrow(
			"No physics contact history replay is active"
		);

		const secondEngine = new NullEngine();
		const secondScene = new Scene(secondEngine);
		vi.spyOn(secondScene, "getPhysicsEngine").mockReturnValue({ getPhysicsPlugin: () => ({ onCollisionObservable: collisionObservable }) } as any);
		startPhysicsContactCapture(secondScene, {}, options);
		await expect(startPhysicsContactHistoryReplay(secondScene, { path: "assets/impact.physicscontacts.json", expectedRevision: await revision() }, options)).rejects.toThrow(
			"Stop the active physics contact capture"
		);
		stopPhysicsContactCapture(secondScene, {}, options);
		secondScene.dispose();
		secondEngine.dispose();
	});

	test("rejects stale asset revisions and invalid start settings before creating a session", async () => {
		await expect(startPhysicsContactHistoryReplay(scene, { path: "assets/impact.physicscontacts.json", expectedRevision: "stale" }, options)).rejects.toThrow(
			"revision is stale"
		);
		await expect(
			startPhysicsContactHistoryReplay(scene, { path: "assets/impact.physicscontacts.json", expectedRevision: await revision(), playing: "yes" }, options)
		).rejects.toThrow("playing and loop must be booleans");
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ active: false });
	});
});
