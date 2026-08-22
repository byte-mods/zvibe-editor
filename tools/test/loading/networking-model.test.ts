import { describe, expect, it } from "vitest";

import {
	createDefaultNetworkingConfiguration,
	createNetworkWireMessage,
	getSceneNetworkingConfiguration,
	normalizeNetworkingConfiguration,
	parseNetworkWireMessage,
	setSceneNetworkingConfiguration,
	validateNetworkingConfiguration,
} from "../../src/loading/networking-model";

describe("loading/networking-model", () => {
	it("creates and persists a complete versioned configuration without aliasing", () => {
		const scene: { metadata?: Record<string, unknown> } = {};
		const configuration = getSceneNetworkingConfiguration(scene);

		expect(configuration).toEqual(createDefaultNetworkingConfiguration());
		configuration.transport.autoConnect = true;
		expect((scene.metadata?.babylonEditorNetworking as any).transport.autoConnect).toBe(false);

		const replacement = createDefaultNetworkingConfiguration();
		replacement.enabled = true;
		replacement.revision = 2;
		setSceneNetworkingConfiguration(scene, replacement);
		replacement.enabled = false;
		expect(getSceneNetworkingConfiguration(scene, false).enabled).toBe(true);
	});

	it("rejects current-version unknown fields, impossible rates, and insecure remote endpoints", () => {
		const unknown = { ...createDefaultNetworkingConfiguration(), token: "must-not-persist" };
		expect(() => normalizeNetworkingConfiguration(unknown)).toThrow(/unknown: token/);

		const rates = createDefaultNetworkingConfiguration();
		rates.replication.snapshotRateHz = 120;
		rates.replication.tickRateHz = 60;
		expect(() => validateNetworkingConfiguration(rates)).toThrow(/cannot exceed/);

		const endpoint = createDefaultNetworkingConfiguration();
		endpoint.transport.endpoint = "ws://example.com/game";
		expect(() => validateNetworkingConfiguration(endpoint)).toThrow(/only on loopback/);
		endpoint.transport.endpoint = "ws://127.0.0.1:9000/game";
		expect(() => validateNetworkingConfiguration(endpoint)).not.toThrow();
		endpoint.transport.endpoint = "wss://game.example.com/connect?token=must-not-persist";
		expect(() => validateNetworkingConfiguration(endpoint)).toThrow(/query parameters/);
	});

	it("round-trips strict bounded handshake, input, snapshot, and rpc frames", () => {
		const hello = createNetworkWireMessage({ type: "hello", clientId: "client-1", displayName: "Player One", joinCode: "ABC123" });
		expect(parseNetworkWireMessage(JSON.stringify(hello))).toEqual(hello);

		const input = createNetworkWireMessage({ type: "input", sequence: 1, tick: 2, networkId: "player-body", translation: [1, 0, 0], rotationDegrees: [0, 5, 0] });
		expect(parseNetworkWireMessage(input).type).toBe("input");

		const snapshot = createNetworkWireMessage({
			type: "snapshot",
			sequence: 2,
			tick: 4,
			serverTime: 100,
			acknowledgedInputs: { "player-1": 1 },
			entities: [
				{
					networkId: "player-body",
					ownerId: "player-1",
					transform: { position: [1, 2, 3], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] },
					animations: [{ name: "Run", playing: true, loop: true, currentFrame: 4, speedRatio: 1 }],
				},
			],
		});
		expect(parseNetworkWireMessage(snapshot)).toEqual(snapshot);

		const rpc = createNetworkWireMessage({ type: "rpc", sequence: 3, name: "damage", target: "owner", channel: "reliable", networkId: "player-body", payload: { amount: 5 } });
		expect(parseNetworkWireMessage(rpc)).toEqual(rpc);
	});

	it("rejects oversized, unknown, malformed, and non-json protocol frames", () => {
		const hello = createNetworkWireMessage({ type: "hello", clientId: "client-1", displayName: "Player One" });
		expect(() => parseNetworkWireMessage(JSON.stringify({ ...hello, padding: "x".repeat(1_024) }), 1_024)).toThrow(/byte limit/);
		expect(() => parseNetworkWireMessage({ ...hello, padding: "x".repeat(1_024) }, 1_024)).toThrow(/byte limit/);
		expect(() => parseNetworkWireMessage({ ...hello, secret: "no" })).toThrow(/unknown fields/);
		expect(() => parseNetworkWireMessage("{")).toThrow(/malformed JSON/);
		expect(() =>
			parseNetworkWireMessage(
				createNetworkWireMessage({
					type: "snapshot",
					sequence: 1,
					tick: 1,
					serverTime: 1,
					acknowledgedInputs: {},
					entities: [{ networkId: "bad", ownerId: null, transform: { position: [0, 0, 0], rotationQuaternion: [0, 0, 0, 0], scaling: [1, 1, 1] }, animations: [] }],
				})
			)
		).toThrow(/snapshot entities/);
		expect(() =>
			parseNetworkWireMessage(createNetworkWireMessage({ type: "rpc", sequence: 1, name: "bad", target: "all", channel: "reliable", payload: { value: Number.NaN } }))
		).toThrow(/RPC frame/);
	});
});
