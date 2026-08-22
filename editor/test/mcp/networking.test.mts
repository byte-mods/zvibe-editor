import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";

import { configureGameObjectComponents, configureNetworking, getNetworkingRuntime } from "babylonjs-editor-tools";

import {
	clearNetworkingEvidence,
	connectNetworkingRuntime,
	controlMultiplayerPlayMode,
	createGameplaySession,
	deleteGameplaySession,
	disconnectNetworkingRuntime,
	getGameplaySession,
	getGameplaySessionHostStatus,
	getNetworkingCapabilities,
	getNetworkingConfiguration,
	getNetworkingRuntimeState,
	getMultiplayerPlayMode,
	listGameplaySessions,
	setGameplaySession,
	setNetworkingConfiguration,
	shutdownNetworking,
	startMultiplayerPlayMode,
	startGameplaySessionHost,
	stopMultiplayerPlayMode,
	stopGameplaySessionHost,
	validateNetworkingTarget,
} from "../../src/mcp/networking/networking";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for networking state.");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function addNetworkNode(scene: Scene, id = "player-body"): TransformNode {
	const node = new TransformNode(`Node ${id}`, scene);
	node.id = `node-${id}`;
	node.metadata = {
		babylonEditorComponentStack: {
			version: 1,
			components: [
				{
					id: `component-${id}`,
					type: "network",
					enabled: true,
					data: { networkId: id, authority: "owner", syncTransform: true, syncAnimation: false, sendRateHz: 20, interpolate: true },
				},
			],
		},
	};
	configureGameObjectComponents(scene as any);
	return node;
}

describe("mcp/networking", () => {
	let scene: Scene;
	let playScene: Scene;
	let options: any;
	let originalWebSocket: unknown;

	beforeEach(() => {
		clearUndoRedo();
		scene = new Scene(new NullEngine());
		playScene = new Scene(new NullEngine());
		addNetworkNode(scene);
		addNetworkNode(playScene);
		originalWebSocket = (globalThis as any).WebSocket;
		(globalThis as any).WebSocket = WebSocket;
		options = {
			editor: {
				layout: {
					preview: {
						play: {
							state: { playing: true },
							canPlayScene: true,
							scene: playScene,
							play: vi.fn(),
							stop: vi.fn(),
							getCompiledNetworkingRuntime: (target: Scene) => getNetworkingRuntime(target as any),
							configureCompiledNetworking: (target: Scene, configuration: any) => configureNetworking(target as any, { configuration }),
							createIsolatedPlayerScene: vi.fn(async (engine: NullEngine) => {
								const target = new Scene(engine);
								const camera = new FreeCamera("Virtual player camera", Vector3.Zero(), target);
								target.activeCamera = camera;
								for (const source of playScene.getNodes()) {
									const networkId = source.metadata?.babylonEditorComponentStack?.components?.find((component: any) => component.type === "network")?.data
										?.networkId;
									if (networkId) {
										addNetworkNode(target, networkId);
									}
								}
								return target;
							}),
						},
					},
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				},
			},
		};
	});

	afterEach(async () => {
		await shutdownNetworking();
		clearUndoRedo();
		(globalThis as any).WebSocket = originalWebSocket;
		playScene.dispose();
		scene.dispose();
	});

	test("authors exact configuration and validates components and transport boundaries", () => {
		const metadataBeforeRead = scene.metadata;
		const defaults = getNetworkingConfiguration(scene);
		expect(defaults).toMatchObject({ version: 1, revision: 1, enabled: false, topology: "client-server" });
		expect(scene.metadata).toBe(metadataBeforeRead);
		expect(getNetworkingCapabilities(scene)).toMatchObject({ transport: { shipped: expect.arrayContaining(["authenticated-websocket-v1"]) } });

		const updated = setNetworkingConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: { enabled: true, transport: { endpoint: "ws://127.0.0.1:9000/game" }, simulation: { enabled: true, latencyMs: 50, seed: 7 } },
			},
			options
		);
		expect(updated).toMatchObject({ revision: 2, enabled: true, transport: { endpoint: "ws://127.0.0.1:9000/game" }, simulation: { enabled: true, latencyMs: 50, seed: 7 } });
		undo();
		expect(getNetworkingConfiguration(scene)).toMatchObject({ revision: 1, enabled: false, transport: { endpoint: null } });
		expect(scene.metadata).toBe(metadataBeforeRead);
		redo();
		expect(getNetworkingConfiguration(scene)).toMatchObject({ revision: 2, enabled: true, transport: { endpoint: "ws://127.0.0.1:9000/game" } });
		expect(() => setNetworkingConfiguration(scene, { expectedRevision: 1, changes: { enabled: false } }, options)).toThrow(/revision is stale/);
		expect(() => setNetworkingConfiguration(scene, { expectedRevision: 2, changes: { transport: { token: "secret" } } }, options)).toThrow(/unsupported fields/);
		expect(validateNetworkingTarget(scene, { target: "web", requireEnabled: true })).toMatchObject({
			valid: true,
			ready: true,
			networkComponentCount: 1,
			uniqueNetworkIdCount: 1,
		});

		addNetworkNode(scene, "player-body");
		expect(validateNetworkingTarget(scene)).toMatchObject({ valid: false, errors: [expect.objectContaining({ code: "network_id_duplicate" })] });
	});

	test("shares host, lobby, and compiled Play runtime actions with exact transient revisions", async () => {
		const started = await startGameplaySessionHost(scene, { port: 0 }, options);
		expect(started).toMatchObject({ listening: true, security: { secretsPersisted: false } });
		const configured = setNetworkingConfiguration(scene, { expectedRevision: 1, changes: { enabled: true, transport: { endpoint: started.endpoint } } }, options);
		const created = createGameplaySession(scene, { expectedRevision: configured.revision, name: "Action QA", publicLobby: true }, options);
		expect(created.session).toMatchObject({ revision: 1, name: "Action QA", maximumPlayers: 4, publicLobby: true });
		expect(JSON.stringify(getGameplaySessionHostStatus())).not.toContain(created.connection.hostToken);

		const current = getGameplaySession(scene, { sessionId: created.session.id });
		expect(() => setGameplaySession(scene, { sessionId: current.id, expectedRevision: current.revision + 1, changes: { name: "stale" } }, options)).toThrow(
			/revision is stale/
		);
		const changed = setGameplaySession(scene, { sessionId: current.id, expectedRevision: current.revision, changes: { name: "Renamed" } }, options);
		expect(changed).toMatchObject({ revision: current.revision + 1, name: "Renamed" });
		expect(listGameplaySessions(scene, { publicOnly: true })).toMatchObject({ total: 1, sessions: [{ id: current.id, joinCode: created.connection.joinCode }] });

		expect(
			connectNetworkingRuntime(
				scene,
				{
					expectedRevision: configured.revision,
					connection: { endpoint: started.endpoint, clientId: "play-host", displayName: "Play Host", hostToken: created.connection.hostToken },
				},
				options
			)
		).toMatchObject({ state: "connecting" });
		await waitFor(() => getNetworkingRuntimeState(scene, {}, options).runtime?.state === "connected");
		await waitFor(() => getGameplaySession(scene, { sessionId: current.id }).manifestObjectCount === 1);
		expect(getNetworkingRuntimeState(scene, { limit: 50 }, options)).toMatchObject({
			active: true,
			configurationRevision: configured.revision,
			runtime: { configurationRevision: configured.revision, role: "host", networkObjectCount: 1 },
		});
		expect(() => setNetworkingConfiguration(scene, { expectedRevision: configured.revision, changes: { simulation: { latencyMs: 5 } } }, options)).toThrow(/Disconnect/);

		expect(disconnectNetworkingRuntime(scene, { confirm: true }, options)).toMatchObject({ state: "disconnected" });
		expect(clearNetworkingEvidence(scene, { confirm: true }, options)).toMatchObject({ metrics: { messagesSent: 0, messagesReceived: 0 } });
		const finalSession = getGameplaySession(scene, { sessionId: current.id });
		expect(() => deleteGameplaySession(scene, { sessionId: current.id, expectedRevision: finalSession.revision, confirm: false })).toThrow(/confirm=true/);
		expect(deleteGameplaySession(scene, { sessionId: current.id, expectedRevision: finalSession.revision, confirm: true })).toEqual({ deleted: true, sessionId: current.id });
		expect(await stopGameplaySessionHost(scene, { confirm: true }, options)).toMatchObject({ stopped: true, state: "stopped" });
	});

	test("runs two isolated players with assignments, deterministic controls, reconnect, and complete cleanup", async () => {
		addNetworkNode(scene, "second-player");
		addNetworkNode(playScene, "second-player");
		const configured = setNetworkingConfiguration(
			scene,
			{
				expectedRevision: 1,
				changes: {
					enabled: true,
					transport: { connectionTimeoutMs: 2_000 },
					session: { reconnectGraceMs: 2_000 },
				},
			},
			options
		);

		let status: any = await startMultiplayerPlayMode(
			scene,
			{
				expectedRevision: configured.revision,
				playerCount: 2,
				playerNames: ["Host QA", "Client QA"],
				assignments: ["player-body", "second-player"],
				simulations: [null, { enabled: true, latencyMs: 1, seed: 11 }],
			},
			options
		);
		expect(status).toMatchObject({
			active: true,
			run: {
				state: "running",
				playerCount: 2,
				startedHost: true,
				players: [
					{ index: 0, role: "host", primary: true, assignedNetworkId: "player-body", runtime: { state: "connected", ownedNetworkIds: ["player-body"] } },
					{ index: 1, role: "client", primary: false, assignedNetworkId: "second-player", runtime: { state: "connected", ownedNetworkIds: ["second-player"] } },
				],
			},
		});
		expect(JSON.stringify(status)).not.toContain("hostToken");
		expect(options.editor.layout.preview.play.createIsolatedPlayerScene).toHaveBeenCalledTimes(1);

		status = await controlMultiplayerPlayMode(scene, { expectedRunRevision: status.run.revision, command: "pause", playerIndex: 1 }, options);
		expect(status.run.players[1].paused).toBe(true);
		status = await controlMultiplayerPlayMode(scene, { expectedRunRevision: status.run.revision, command: "render-frames", playerIndex: 1, frames: 2 }, options);
		status = await controlMultiplayerPlayMode(
			scene,
			{ expectedRunRevision: status.run.revision, command: "set-simulation", playerIndex: 1, simulation: { enabled: true, latencyMs: 5, seed: 99 } },
			options
		);
		expect(status.run.players[1].runtime.simulation).toMatchObject({ enabled: true, latencyMs: 5, seed: 99 });
		status = await controlMultiplayerPlayMode(scene, { expectedRunRevision: status.run.revision, command: "disconnect-player", playerIndex: 1 }, options);
		expect(status.run.players[1].runtime.state).toBe("disconnected");
		status = await controlMultiplayerPlayMode(scene, { expectedRunRevision: status.run.revision, command: "reconnect-player", playerIndex: 1 }, options);
		expect(status.run.players[1].runtime.state).toBe("connected");
		await expect(controlMultiplayerPlayMode(scene, { expectedRunRevision: status.run.revision - 1, command: "resume", playerIndex: 1 }, options)).rejects.toThrow(
			/revision is stale/
		);

		const stopped = await stopMultiplayerPlayMode(scene, { confirm: true }, options);
		expect(stopped).toMatchObject({ stopped: true, active: false, lastRun: { state: "stopped", playerCount: 2 } });
		expect(getMultiplayerPlayMode()).toMatchObject({ active: false, run: null });
		expect(getGameplaySessionHostStatus()).toMatchObject({ listening: false, sessionCount: 0, connectionCount: 0 });
	});
});
