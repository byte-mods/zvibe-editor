import { once } from "node:events";

import { afterEach, describe, expect, test } from "vitest";
import WebSocket from "ws";

import { createNetworkWireMessage } from "babylonjs-editor-tools";

import { GameplaySessionHost } from "../../src/mcp/networking/session-host";

class MessageQueue {
	private _messages: any[] = [];

	public constructor(socket: WebSocket) {
		socket.on("message", (bytes) => this._messages.push(JSON.parse(bytes.toString())));
	}

	public async next(type: string, timeoutMs = 2_000): Promise<any> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const index = this._messages.findIndex((message) => message.type === type);
			if (index !== -1) {
				return this._messages.splice(index, 1)[0];
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`Timed out waiting for gameplay ${type} frame.`);
	}
}

async function connect(endpoint: string, hello: Record<string, unknown>): Promise<{ socket: WebSocket; queue: MessageQueue; welcome: any }> {
	const socket = new WebSocket(endpoint);
	const queue = new MessageQueue(socket);
	await once(socket, "open");
	socket.send(JSON.stringify(createNetworkWireMessage({ type: "hello", clientId: String(hello.clientId), displayName: String(hello.displayName), ...hello } as any)));
	return { socket, queue, welcome: await queue.next("welcome") };
}

describe("mcp/networking session host", () => {
	let host: GameplaySessionHost | null = null;

	afterEach(async () => {
		await host?.stop(true);
		host = null;
	});

	test("hosts lobby, authority, input, snapshots, rpc, reconnect, and deterministic host migration", async () => {
		host = new GameplaySessionHost();
		const started = await host.start({ port: 0 });
		expect(started).toMatchObject({ listening: true, security: { loopbackOnly: true, secretsPersisted: false, tls: false } });
		const endpoint = String(started.endpoint);
		const created = host.createSession({ name: "Four-player QA", maximumPlayers: 4, publicLobby: true, allowHostMigration: true, reconnectGraceMs: 5_000 }) as any;
		expect(created.connection.hostToken).toMatch(/^[A-Za-z0-9_-]{24,256}$/);
		expect(created.connection.joinCode).toMatch(/^[A-Z0-9]{6,12}$/);
		expect(JSON.stringify(host.status())).not.toContain(created.connection.hostToken);
		expect(JSON.stringify(host.getSession(created.session.id))).not.toContain(created.connection.hostToken);

		const hostClient = await connect(endpoint, { clientId: "host-client", displayName: "Host", hostToken: created.connection.hostToken });
		expect(hostClient.welcome).toMatchObject({ role: "host", sessionId: created.session.id });
		const playerClient = await connect(endpoint, { clientId: "player-client", displayName: "Player", joinCode: created.connection.joinCode });
		expect(playerClient.welcome).toMatchObject({ role: "client", sessionId: created.session.id });
		await hostClient.queue.next("peer-joined");

		hostClient.socket.send(
			JSON.stringify(
				createNetworkWireMessage({
					type: "manifest",
					objects: [
						{ networkId: "player-body", authority: "owner" },
						{ networkId: "world", authority: "server" },
					],
				})
			)
		);
		playerClient.socket.send(JSON.stringify(createNetworkWireMessage({ type: "claim-ownership", networkId: "player-body" })));
		const ownership = await playerClient.queue.next("ownership");
		expect(ownership).toMatchObject({ networkId: "player-body", playerId: playerClient.welcome.playerId });
		await hostClient.queue.next("ownership");

		playerClient.socket.send(
			JSON.stringify(createNetworkWireMessage({ type: "input", sequence: 7, tick: 3, networkId: "player-body", translation: [2, 0, 0], rotationDegrees: [0, 5, 0] }))
		);
		expect(await hostClient.queue.next("input")).toMatchObject({ sequence: 7, networkId: "player-body", senderId: playerClient.welcome.playerId });

		hostClient.socket.send(
			JSON.stringify(
				createNetworkWireMessage({
					type: "snapshot",
					sequence: 8,
					tick: 4,
					serverTime: Date.now(),
					acknowledgedInputs: { [playerClient.welcome.playerId]: 7 },
					entities: [
						{
							networkId: "player-body",
							ownerId: "wrong-owner",
							transform: { position: [2, 0, 0], rotationQuaternion: [0, 0, 0, 1], scaling: [1, 1, 1] },
							animations: [],
						},
					],
				})
			)
		);
		expect(await playerClient.queue.next("snapshot")).toMatchObject({ entities: [{ ownerId: playerClient.welcome.playerId }] });

		playerClient.socket.send(
			JSON.stringify(createNetworkWireMessage({ type: "rpc", sequence: 9, name: "ready", target: "all", channel: "reliable", payload: { ready: true } }))
		);
		expect(await playerClient.queue.next("rpc")).toMatchObject({ name: "ready", senderId: playerClient.welcome.playerId });
		expect(await hostClient.queue.next("rpc")).toMatchObject({ name: "ready", senderId: playerClient.welcome.playerId });

		hostClient.socket.close(1000, "migration test");
		const role = await playerClient.queue.next("role");
		expect(role).toMatchObject({ playerId: playerClient.welcome.playerId, role: "host" });
		expect(host.getSession(created.session.id)).toMatchObject({ hostPlayerId: playerClient.welcome.playerId, metrics: { hostMigrations: 1 } });

		const reconnected = await connect(endpoint, {
			clientId: "host-client-reconnected",
			displayName: "Former Host",
			reconnectToken: hostClient.welcome.reconnectToken,
		});
		expect(reconnected.welcome).toMatchObject({ playerId: hostClient.welcome.playerId, role: "client" });
		expect(host.listSessions({ publicOnly: true })).toMatchObject({ total: 1, sessions: [{ joinCode: created.connection.joinCode, connectedPlayerCount: 2 }] });

		const currentRevision = host.getSession(created.session.id).revision;
		expect(() => host?.deleteSession(created.session.id, currentRevision - 1, true)).toThrow(/revision is stale/);
		const updated = host.updateSession(created.session.id, currentRevision, { name: "Updated QA" });
		expect(updated).toMatchObject({ revision: currentRevision + 1, name: "Updated QA" });
		expect(() => host?.deleteSession(created.session.id, updated.revision, false)).toThrow(/confirm=true/);
		expect(host.deleteSession(created.session.id, updated.revision, true)).toEqual({ deleted: true, sessionId: created.session.id });
		playerClient.socket.close();
		reconnected.socket.close();
	});

	test("rejects invalid credentials, server-object claims, client snapshots, and host token reuse", async () => {
		host = new GameplaySessionHost();
		const started = await host.start({ port: 0 });
		const endpoint = String(started.endpoint);
		const created = host.createSession({ name: "Security QA", maximumPlayers: 3, publicLobby: false, allowHostMigration: false, reconnectGraceMs: 0 }) as any;

		const rejected = new WebSocket(endpoint);
		await once(rejected, "open");
		rejected.send(JSON.stringify(createNetworkWireMessage({ type: "hello", clientId: "bad-client", displayName: "Bad", hostToken: "x".repeat(32) })));
		const [rejectedCode] = (await once(rejected, "close")) as [number, Buffer];
		expect(rejectedCode).toBe(4401);

		const hostClient = await connect(endpoint, { clientId: "host-client", displayName: "Host", hostToken: created.connection.hostToken });
		const reused = new WebSocket(endpoint);
		await once(reused, "open");
		reused.send(JSON.stringify(createNetworkWireMessage({ type: "hello", clientId: "host-two", displayName: "Host Two", hostToken: created.connection.hostToken })));
		const [reusedCode] = (await once(reused, "close")) as [number, Buffer];
		expect(reusedCode).toBe(4401);

		const playerClient = await connect(endpoint, { clientId: "player-client", displayName: "Player", joinCode: created.connection.joinCode });
		await hostClient.queue.next("peer-joined");
		hostClient.socket.send(JSON.stringify(createNetworkWireMessage({ type: "manifest", objects: [{ networkId: "world", authority: "server" }] })));
		playerClient.socket.send(JSON.stringify(createNetworkWireMessage({ type: "claim-ownership", networkId: "world" })));
		expect(await playerClient.queue.next("error")).toMatchObject({ code: "not_owner_authority" });

		playerClient.socket.send(
			JSON.stringify(createNetworkWireMessage({ type: "snapshot", sequence: 1, tick: 1, serverTime: Date.now(), acknowledgedInputs: {}, entities: [] }))
		);
		expect(await playerClient.queue.next("error")).toMatchObject({ code: "host_required" });
		expect(host.getSession(created.session.id)).toMatchObject({ metrics: { rejectedMessages: 2 }, manifestObjectCount: 1 });
		hostClient.socket.close();
		playerClient.socket.close();
	});

	test("never grants host authority to a join-code client before the host credential is consumed", async () => {
		host = new GameplaySessionHost();
		const started = await host.start({ port: 0 });
		const created = host.createSession({ name: "Ordered Join QA", maximumPlayers: 2, publicLobby: true, allowHostMigration: true, reconnectGraceMs: 1_000 }) as any;
		const earlyClient = await connect(String(started.endpoint), { clientId: "early-client", displayName: "Early Client", joinCode: created.connection.joinCode });
		expect(earlyClient.welcome.role).toBe("client");
		expect(host.getSession(created.session.id)).toMatchObject({ hostPlayerId: null, state: "degraded" });

		const realHost = await connect(String(started.endpoint), { clientId: "real-host", displayName: "Real Host", hostToken: created.connection.hostToken });
		expect(realHost.welcome.role).toBe("host");
		expect(host.getSession(created.session.id)).toMatchObject({ hostPlayerId: realHost.welcome.playerId, state: "active", metrics: { hostMigrations: 0 } });
		earlyClient.socket.close();
		realHost.socket.close();
	});
});
