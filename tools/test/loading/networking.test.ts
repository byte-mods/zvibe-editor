import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import "@babylonjs/core/Materials/standardMaterial";

import { Buffer } from "node:buffer";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { SceneSerializer } from "@babylonjs/core/Misc/sceneSerializer";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureGameObjectComponents } from "../../src/loading/game-object-components";
import {
	configureNetworking,
	createDefaultNetworkingConfiguration,
	createNetworkWireMessage,
	INetworkingSocket,
	INetworkingSocketEvent,
	NetworkingRuntime,
	getNetworkingRuntime,
} from "../../src/loading/networking";
import { loadScene } from "../../src/loading/loader";
import { loadSceneAdditive } from "../../src/loading/additive-scene";

class FakeSocket implements INetworkingSocket {
	public readyState = 0;
	public readonly sent: string[] = [];
	private _listeners = new Map<string, Array<(event: INetworkingSocketEvent) => void>>();

	public addEventListener(type: "open" | "message" | "close" | "error", listener: (event: INetworkingSocketEvent) => void): void {
		const listeners = this._listeners.get(type) ?? [];
		listeners.push(listener);
		this._listeners.set(type, listeners);
	}

	public send(data: string): void {
		if (this.readyState !== 1) {
			throw new Error("Socket is not open.");
		}
		this.sent.push(data);
	}

	public close(code = 1000, reason = "closed"): void {
		if (this.readyState === 3) {
			return;
		}
		this.readyState = 3;
		this._emit("close", { code, reason });
	}

	public open(): void {
		this.readyState = 1;
		this._emit("open", {});
	}

	public receive(message: unknown): void {
		this._emit("message", { data: JSON.stringify(message) });
	}

	private _emit(type: string, event: INetworkingSocketEvent): void {
		for (const listener of this._listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

function networkScene(authority: "server" | "owner" = "owner"): { engine: NullEngine; scene: Scene; node: TransformNode } {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const node = new TransformNode("Player", scene);
	node.id = "player-node";
	node.metadata = {
		babylonEditorComponentStack: {
			version: 1,
			components: [
				{
					id: "network-component",
					type: "network",
					enabled: true,
					data: { networkId: "player-body", authority, syncTransform: true, syncAnimation: false, sendRateHz: 20, interpolate: true },
				},
			],
		},
	};
	configureGameObjectComponents(scene);
	return { engine, scene, node };
}

function enabledConfiguration() {
	const configuration = createDefaultNetworkingConfiguration();
	configuration.enabled = true;
	configuration.transport.endpoint = "ws://127.0.0.1:9000/game";
	configuration.prediction.reconciliationThreshold = 0.1;
	return configuration;
}

function welcome(role: "host" | "client", playerId: string, ownership: Record<string, string> = {}) {
	return createNetworkWireMessage({
		type: "welcome",
		sessionId: "session-1",
		playerId,
		role,
		reconnectToken: "abcdefghijklmnopqrstuvwxyz123456",
		serverTime: 100,
		peers: [{ playerId, displayName: role === "host" ? "Host" : "Client", role }],
		ownership,
	});
}

afterEach(() => vi.useRealTimers());

describe("loading/networking", () => {
	it("predicts owner input and reconciles from authoritative acknowledgement with replay", () => {
		const { engine, scene, node } = networkScene("owner");
		const socket = new FakeSocket();
		const runtime = new NetworkingRuntime(scene, { configuration: enabledConfiguration(), socketFactory: () => socket, now: () => 1_000 });

		runtime.connect({ clientId: "client-1", displayName: "Player One", joinCode: "ABC123" });
		socket.open();
		expect(JSON.parse(socket.sent[0])).toMatchObject({ type: "hello", joinCode: "ABC123" });
		socket.receive(welcome("client", "player-1", { "player-body": "player-1" }));

		runtime.submitInput("player-body", [1, 0, 0], [0, 0, 0]);
		runtime.submitInput("player-body", [1, 0, 0], [0, 0, 0]);
		expect(node.position.x).toBe(2);

		socket.receive(
			createNetworkWireMessage({
				type: "snapshot",
				sequence: 1,
				tick: 2,
				serverTime: 900,
				acknowledgedInputs: { "player-1": 1 },
				entities: [
					{
						networkId: "player-body",
						ownerId: "player-1",
						transform: { position: [0.5, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] },
						animations: [],
					},
				],
			})
		);

		expect(node.position.x).toBe(1.5);
		expect(runtime.status().metrics).toMatchObject({ inputsSent: 2, snapshotsReceived: 1, reconciliations: 1 });
		expect(runtime.trace().events.some((event) => event.type === "reconciled")).toBe(true);
		runtime.dispose();
		engine.dispose();
	});

	it("accepts only owned client input on the host and acknowledges it in snapshots", () => {
		const { engine, scene, node } = networkScene("owner");
		const socket = new FakeSocket();
		let now = 1_000;
		const runtime = new NetworkingRuntime(scene, { configuration: enabledConfiguration(), socketFactory: () => socket, now: () => now });
		runtime.connect({ clientId: "host-1", displayName: "Host", hostToken: "abcdefghijklmnopqrstuvwxyz123456" });
		socket.open();
		socket.receive(welcome("host", "host-player", { "player-body": "remote-player" }));

		socket.receive(
			createNetworkWireMessage({
				type: "input",
				sequence: 7,
				tick: 1,
				networkId: "player-body",
				translation: [2, 0, 0],
				rotationDegrees: [0, 0, 0],
				senderId: "remote-player",
			})
		);
		socket.receive(
			createNetworkWireMessage({ type: "input", sequence: 8, tick: 1, networkId: "player-body", translation: [9, 0, 0], rotationDegrees: [0, 0, 0], senderId: "intruder" })
		);
		expect(node.position.x).toBe(2);

		now = 1_100;
		runtime.update(0.1);
		const snapshot = socket.sent.map((entry) => JSON.parse(entry)).find((entry) => entry.type === "snapshot");
		expect(snapshot).toMatchObject({ acknowledgedInputs: { "remote-player": 7 }, entities: [{ networkId: "player-body" }] });
		expect(runtime.trace().events.some((event) => event.type === "input-rejected")).toBe(true);
		runtime.dispose();
		engine.dispose();
	});

	it("interpolates and briefly extrapolates remote snapshots", () => {
		const { engine, scene, node } = networkScene("owner");
		const socket = new FakeSocket();
		let now = 200;
		const configuration = enabledConfiguration();
		configuration.replication.interpolationDelayMs = 100;
		configuration.replication.maximumExtrapolationMs = 200;
		const runtime = new NetworkingRuntime(scene, { configuration, socketFactory: () => socket, now: () => now });
		runtime.connect({ clientId: "client-1", displayName: "Client", joinCode: "ABC123" });
		socket.open();
		socket.receive(welcome("client", "player-1", { "player-body": "player-2" }));

		for (const [sequence, serverTime, x] of [
			[1, 0, 0],
			[2, 200, 20],
		] as const) {
			socket.receive(
				createNetworkWireMessage({
					type: "snapshot",
					sequence,
					tick: sequence,
					serverTime,
					acknowledgedInputs: {},
					entities: [
						{ networkId: "player-body", ownerId: "player-2", transform: { position: [x, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] }, animations: [] },
					],
				})
			);
		}
		runtime.update(0);
		expect(node.position.x).toBeCloseTo(10);
		now = 350;
		runtime.update(0);
		expect(node.position.x).toBeCloseTo(25);
		runtime.dispose();
		engine.dispose();
	});

	it("simulates unreliable loss, delivers reliable RPCs, reconnects, and disposes timers", () => {
		vi.useFakeTimers();
		const { engine, scene } = networkScene("owner");
		const sockets: FakeSocket[] = [];
		const configuration = enabledConfiguration();
		configuration.simulation = { enabled: true, latencyMs: 0, jitterMs: 0, packetLossPercent: 100, packetReorderPercent: 0, seed: 1 };
		const runtime = new NetworkingRuntime(scene, {
			configuration,
			socketFactory: () => {
				const socket = new FakeSocket();
				sockets.push(socket);
				return socket;
			},
			now: () => 1_000,
			random: () => 0,
		});
		runtime.connect({ clientId: "client-1", displayName: "Client", joinCode: "ABC123" });
		sockets[0].open();
		sockets[0].receive(welcome("client", "player-1", { "player-body": "player-1" }));
		const sentBefore = sockets[0].sent.length;
		runtime.sendRpc("unreliable-event", "all", { value: 1 }, { channel: "unreliable" });
		runtime.sendRpc("reliable-event", "all", { value: 2 }, { channel: "reliable" });
		expect(sockets[0].sent).toHaveLength(sentBefore + 1);
		expect(runtime.status().metrics.packetsSimulatedLost).toBe(1);

		sockets[0].close(1006, "lost");
		expect(runtime.status()).toMatchObject({ state: "reconnecting", reconnectScheduled: true });
		vi.advanceTimersByTime(500);
		expect(sockets).toHaveLength(2);
		runtime.dispose();
		vi.runOnlyPendingTimers();
		expect(sockets).toHaveLength(2);
		engine.dispose();
	});

	it("uses the authored simulation seed deterministically", () => {
		const capture = (seed: number): string[] => {
			const { engine, scene } = networkScene("owner");
			const socket = new FakeSocket();
			const configuration = enabledConfiguration();
			configuration.simulation = { enabled: true, latencyMs: 0, jitterMs: 0, packetLossPercent: 50, packetReorderPercent: 0, seed };
			const runtime = new NetworkingRuntime(scene, { configuration, socketFactory: () => socket, now: () => 1_000 });
			runtime.connect({ clientId: "client-1", displayName: "Client", joinCode: "ABC123" });
			socket.open();
			socket.receive(welcome("client", "player-1", { "player-body": "player-1" }));
			for (let index = 0; index < 24; index++) {
				runtime.sendRpc(`rpc-${index}`, "all", { index }, { channel: "unreliable" });
			}
			const names = socket.sent
				.map((entry) => JSON.parse(entry))
				.filter((entry) => entry.type === "rpc")
				.map((entry) => entry.name);
			runtime.dispose();
			engine.dispose();
			return names;
		};

		expect(capture(42)).toEqual(capture(42));
		expect(capture(42)).not.toEqual(capture(43));
	});

	it("rejects insecure endpoint overrides and incomplete owner RPCs", () => {
		const { engine, scene } = networkScene("owner");
		const socket = new FakeSocket();
		const runtime = new NetworkingRuntime(scene, { configuration: enabledConfiguration(), socketFactory: () => socket });
		expect(() => runtime.connect({ endpoint: "ws://example.com/game" })).toThrow(/only on loopback/);
		runtime.connect({ clientId: "client-1", displayName: "Client", joinCode: "ABC123" });
		socket.open();
		socket.receive(welcome("client", "player-1", { "player-body": "player-1" }));
		expect(() => runtime.sendRpc("damage", "owner", { amount: 1 })).toThrow(/require networkId/);
		runtime.dispose();
		engine.dispose();
	});

	it("configures only enabled scenes and releases the scene property", () => {
		const { engine, scene } = networkScene("server");
		expect(configureNetworking(scene, { configuration: createDefaultNetworkingConfiguration() })).toBeNull();
		const runtime = configureNetworking(scene, { configuration: enabledConfiguration(), socketFactory: () => new FakeSocket() });
		expect(scene.networkingRuntime).toBe(runtime);
		runtime?.dispose();
		expect(scene.networkingRuntime).toBeUndefined();
		expect(getNetworkingRuntime(scene)).toBeNull();
		engine.dispose();
	});

	it("discovers and removes additive network objects without replacing the base runtime", async () => {
		const { engine, scene } = networkScene("server");
		const runtime = configureNetworking(scene, { configuration: enabledConfiguration(), socketFactory: () => new FakeSocket() })!;
		expect(runtime.status().networkObjectCount).toBe(1);

		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		const additive = new TransformNode("Additive player", source);
		additive.id = "additive-player";
		additive.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "additive-network",
						type: "network",
						enabled: true,
						data: { networkId: "additive-player", authority: "owner", syncTransform: true, syncAnimation: false, sendRateHz: 20, interpolate: true },
					},
				],
			},
		};
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(SceneSerializer.Serialize(source))).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const handle = await loadSceneAdditive("", dataUrl, scene, {});
		runtime.update(0);
		expect(runtime.status().networkObjectCount).toBe(2);
		await handle.unload();
		runtime.update(0);
		expect(runtime.status().networkObjectCount).toBe(1);
		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	it("attaches one runtime after full exported loading materializes network components", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		const configuration = enabledConfiguration();
		configuration.transport.autoConnect = false;
		source.metadata = { babylonEditorNetworking: configuration };
		const node = new TransformNode("Exported player", source);
		node.id = "exported-player";
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "exported-network",
						type: "network",
						enabled: true,
						data: { networkId: "exported-player", authority: "server", syncTransform: true, syncAnimation: false, sendRateHz: 20, interpolate: true },
					},
				],
			},
		};
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(SceneSerializer.Serialize(source))).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const targetEngine = new NullEngine();
		const target = new Scene(targetEngine);
		await loadScene("", dataUrl, target, {}, { skipAssetsPreload: true });
		expect(getNetworkingRuntime(target)?.status()).toMatchObject({ state: "disconnected", configurationRevision: configuration.revision, networkObjectCount: 1 });
		target.dispose();
		targetEngine.dispose();
	});

	it("suppresses authored auto-connect transiently for isolated multiplayer clients", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		const configuration = enabledConfiguration();
		configuration.transport.autoConnect = true;
		source.metadata = { babylonEditorNetworking: configuration };
		const node = new TransformNode("Isolated player", source);
		node.id = "isolated-player";
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "isolated-network",
						type: "network",
						enabled: true,
						data: { networkId: "isolated-player", authority: "owner", syncTransform: true, syncAnimation: false, sendRateHz: 20, interpolate: true },
					},
				],
			},
		};
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(SceneSerializer.Serialize(source))).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const targetEngine = new NullEngine();
		const target = new Scene(targetEngine);
		await loadScene("", dataUrl, target, {}, { skipAssetsPreload: true, networking: { autoConnect: false } });
		expect(getNetworkingRuntime(target)?.status()).toMatchObject({ state: "disconnected", endpoint: null, networkObjectCount: 1 });
		expect((target.metadata as any).babylonEditorNetworking.transport.autoConnect).toBe(true);
		target.dispose();
		targetEngine.dispose();
	});

	it("loads isolated headless clients without allocating serialized GPU-only render products", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		const configuration = enabledConfiguration();
		configuration.transport.autoConnect = false;
		source.metadata = { babylonEditorNetworking: configuration };
		const node = new TransformNode("Headless player", source);
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "headless-network",
						type: "network",
						enabled: true,
						data: { networkId: "headless-player", authority: "owner", syncTransform: true, syncAnimation: false, sendRateHz: 20, interpolate: true },
					},
				],
			},
		};
		const serialized = SceneSerializer.Serialize(source) as any;
		serialized.shadowGenerators = [{ className: "ShadowGenerator", lightId: "missing-headless-light", mapSize: 128, renderList: [] }];
		serialized.environmentTexture = { name: "gpu-only.env", url: "gpu-only.env", isCube: true };
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const targetEngine = new NullEngine();
		const target = new Scene(targetEngine);
		await loadScene("", dataUrl, target, {}, { headless: true, skipAssetsPreload: true, networking: { autoConnect: false } });
		expect(getNetworkingRuntime(target)?.status()).toMatchObject({ state: "disconnected", networkObjectCount: 1 });
		expect(target.environmentTexture).toBeNull();
		target.dispose();
		targetEngine.dispose();
	});
});
