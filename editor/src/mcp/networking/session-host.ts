import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { networkInterfaces } from "os";

import {
	createNetworkWireMessage,
	INetworkHelloMessage,
	INetworkInputMessage,
	INetworkManifestMessage,
	INetworkRpcMessage,
	INetworkSnapshotMessage,
	NetworkWireMessage,
	NetworkingPeerRole,
	parseNetworkWireMessage,
} from "babylonjs-editor-tools";

declare const require: (id: string) => any;

export type GameplaySessionHostState = "stopped" | "starting" | "listening" | "stopping" | "error";

export interface IGameplaySessionHostStartOptions {
	host?: string;
	advertisedHost?: string;
	port?: number;
	confirm?: boolean;
}

export interface IGameplaySessionCreateOptions {
	name: string;
	maximumPlayers: number;
	publicLobby: boolean;
	allowHostMigration: boolean;
	reconnectGraceMs: number;
}

export interface IGameplaySessionDescription {
	id: string;
	revision: number;
	name: string;
	joinCode: string | null;
	publicLobby: boolean;
	maximumPlayers: number;
	allowHostMigration: boolean;
	reconnectGraceMs: number;
	state: "waiting" | "active" | "degraded";
	hostPlayerId: string | null;
	createdAt: string;
	updatedAt: string;
	playerCount: number;
	connectedPlayerCount: number;
	ownershipCount: number;
	manifestObjectCount: number;
	metrics: {
		messagesRelayed: number;
		bytesReceived: number;
		bytesSent: number;
		rejectedMessages: number;
		reconnects: number;
		hostMigrations: number;
	};
	players: Array<{
		playerId: string;
		clientId: string;
		displayName: string;
		role: NetworkingPeerRole;
		connected: boolean;
		connectedAt: string;
		lastSeenAt: string;
		disconnectedAt: string | null;
	}>;
}

interface IGameplayPlayer {
	playerId: string;
	clientId: string;
	displayName: string;
	role: NetworkingPeerRole;
	socket: any | null;
	reconnectToken: string;
	connectedAt: string;
	lastSeenAt: string;
	disconnectedAt: string | null;
	alive: boolean;
	windowStartedAt: number;
	windowMessages: number;
	windowBytes: number;
}

interface IGameplaySession {
	id: string;
	revision: number;
	name: string;
	joinCode: string;
	hostToken: string;
	hostTokenConsumed: boolean;
	publicLobby: boolean;
	maximumPlayers: number;
	allowHostMigration: boolean;
	reconnectGraceMs: number;
	hostPlayerId: string | null;
	createdAt: string;
	updatedAt: string;
	players: Map<string, IGameplayPlayer>;
	ownership: Map<string, string>;
	manifest: Map<string, "server" | "owner">;
	metrics: IGameplaySessionDescription["metrics"];
}

interface IConnectionContext {
	session: IGameplaySession;
	player: IGameplayPlayer;
}

const maximumSessions = 32;
const maximumFrameBytes = 262_144;
const maximumMessagesPerSecond = 240;
const maximumBytesPerSecond = 4 * 1024 * 1024;
const maximumConnections = 256;
const joinAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function boundedText(value: unknown, maximum: number): string {
	const text = String(value ?? "");
	return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function constantTimeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackHost(host: string): boolean {
	return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

function firstLanAddress(): string | null {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) {
				return entry.address;
			}
		}
	}
	return null;
}

function formatHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function createJoinCode(): string {
	const bytes = randomBytes(8);
	return Array.from(bytes, (value) => joinAlphabet[value % joinAlphabet.length]).join("");
}

function createToken(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * Development-grade gameplay session host shared by normal editor controls and
 * MCP. It relays validated state but never owns or persists game simulation.
 */
export class GameplaySessionHost {
	private _state: GameplaySessionHostState = "stopped";
	private _server: any = null;
	private _host = "127.0.0.1";
	private _advertisedHost = "127.0.0.1";
	private _port = 0;
	private _startedAt: string | null = null;
	private _lastError: string | null = null;
	private _heartbeat: ReturnType<typeof setInterval> | null = null;
	private _cleanup: ReturnType<typeof setInterval> | null = null;
	private _sessions = new Map<string, IGameplaySession>();
	private _connections = new Set<any>();
	private _onChanged: (() => void) | null;

	public constructor(onChanged?: () => void) {
		this._onChanged = onChanged ?? null;
	}

	/** Starts one bounded WebSocket listener; non-loopback exposure is opt-in. */
	public async start(options: IGameplaySessionHostStartOptions = {}): Promise<Record<string, unknown>> {
		if (!["stopped", "error"].includes(this._state)) {
			throw new Error("Gameplay session host is already active or changing state.");
		}
		const host = options.host ?? "127.0.0.1";
		if (!/^[A-Za-z0-9.:-]{1,255}$/.test(host)) {
			throw new Error("Gameplay session host must be a simple hostname or IP address.");
		}
		if (!isLoopbackHost(host) && options.confirm !== true) {
			throw new Error("Listening beyond loopback exposes multiplayer traffic on the network and requires confirm=true.");
		}
		const port = options.port ?? 0;
		if (!Number.isSafeInteger(port) || port < 0 || port > 65_535 || (port > 0 && port < 1_024)) {
			throw new Error("Gameplay session port must be 0 or an integer from 1024 to 65535.");
		}
		const advertisedHost = options.advertisedHost ?? (isLoopbackHost(host) ? "127.0.0.1" : firstLanAddress());
		if (typeof advertisedHost !== "string" || !/^[A-Za-z0-9.:-]{1,255}$/.test(advertisedHost) || ["0.0.0.0", "::"].includes(advertisedHost)) {
			throw new Error("Gameplay sessions require a concrete advertisedHost.");
		}

		this._state = "starting";
		this._lastError = null;
		this._host = host;
		this._advertisedHost = advertisedHost;
		const { WebSocketServer } = require("ws");
		try {
			const server = new WebSocketServer({ host, port, maxPayload: maximumFrameBytes, perMessageDeflate: false, clientTracking: true });
			this._server = server;
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => reject(error);
				const onListening = (): void => {
					server.off("error", onError);
					resolve();
				};
				server.once("error", onError);
				server.once("listening", onListening);
			});
			const address = server.address();
			this._port = typeof address === "object" && address ? address.port : port;
			this._state = "listening";
			this._startedAt = new Date().toISOString();
			server.on("connection", (socket: any) => this._onConnection(socket));
			server.on("error", (error: Error) => {
				this._lastError = boundedText(error.message, 1_024);
				this._state = "error";
				this._notify();
			});
			this._heartbeat = setInterval(() => this._heartbeatConnections(), 15_000);
			this._cleanup = setInterval(() => this._cleanupDisconnectedPlayers(), 1_000);
			this._notify();
			return this.status();
		} catch (error) {
			this._lastError = boundedText(error instanceof Error ? error.message : error, 1_024);
			await this.stop(true);
			this._state = "error";
			throw new Error(`Gameplay session host failed to listen: ${this._lastError}`);
		}
	}

	/** Stops the listener and destroys transient sessions only after confirmation. */
	public async stop(confirm: boolean): Promise<Record<string, unknown>> {
		if ((this._connections.size || this._sessions.size) && !confirm) {
			throw new Error("Stopping the gameplay session host destroys active sessions and requires confirm=true.");
		}
		if (!this._server) {
			this._state = "stopped";
			return { stopped: false, ...this.status() };
		}
		this._state = "stopping";
		if (this._heartbeat) {
			clearInterval(this._heartbeat);
			this._heartbeat = null;
		}
		if (this._cleanup) {
			clearInterval(this._cleanup);
			this._cleanup = null;
		}
		for (const socket of this._connections) {
			socket.close(1001, "Gameplay session host stopped");
		}
		this._connections.clear();
		this._sessions.clear();
		const server = this._server;
		this._server = null;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		this._state = "stopped";
		this._port = 0;
		this._startedAt = null;
		this._notify();
		return { stopped: true, ...this.status() };
	}

	/** Returns listener health without exposing any join or reconnect secret. */
	public status(): Record<string, unknown> {
		return {
			state: this._state,
			listening: this._state === "listening",
			host: this._host,
			advertisedHost: this._advertisedHost,
			port: this._port,
			endpoint: this._state === "listening" ? `ws://${formatHost(this._advertisedHost)}:${this._port}` : null,
			startedAt: this._startedAt,
			sessionCount: this._sessions.size,
			connectionCount: this._connections.size,
			lastError: this._lastError,
			security: {
				loopbackOnly: isLoopbackHost(this._host),
				secretsPersisted: false,
				tls: false,
				warning: isLoopbackHost(this._host) ? null : "LAN gameplay sessions use ws://; run only on a trusted network or behind a TLS terminator.",
			},
		};
	}

	/** Creates one transient lobby and returns its one-time host credential. */
	public createSession(options: IGameplaySessionCreateOptions): Record<string, unknown> {
		this._requireListening();
		if (this._sessions.size >= maximumSessions) {
			throw new Error(`Gameplay session host retains at most ${maximumSessions} sessions.`);
		}
		if (typeof options.name !== "string" || !options.name.trim() || options.name.length > 80) {
			throw new Error("Gameplay session name must contain 1-80 characters.");
		}
		if (!Number.isSafeInteger(options.maximumPlayers) || options.maximumPlayers < 1 || options.maximumPlayers > 64) {
			throw new Error("Gameplay session maximumPlayers must be an integer from 1 to 64.");
		}
		if (typeof options.publicLobby !== "boolean" || typeof options.allowHostMigration !== "boolean") {
			throw new Error("Gameplay session publicLobby and allowHostMigration must be booleans.");
		}
		if (!Number.isSafeInteger(options.reconnectGraceMs) || options.reconnectGraceMs < 0 || options.reconnectGraceMs > 300_000) {
			throw new Error("Gameplay session reconnectGraceMs must be an integer from 0 to 300000.");
		}
		let joinCode = createJoinCode();
		while ([...this._sessions.values()].some((session) => session.joinCode === joinCode)) {
			joinCode = createJoinCode();
		}
		const now = new Date().toISOString();
		const session: IGameplaySession = {
			id: randomUUID(),
			revision: 1,
			name: options.name.trim(),
			joinCode,
			hostToken: createToken(),
			hostTokenConsumed: false,
			publicLobby: options.publicLobby,
			maximumPlayers: options.maximumPlayers,
			allowHostMigration: options.allowHostMigration,
			reconnectGraceMs: options.reconnectGraceMs,
			hostPlayerId: null,
			createdAt: now,
			updatedAt: now,
			players: new Map(),
			ownership: new Map(),
			manifest: new Map(),
			metrics: { messagesRelayed: 0, bytesReceived: 0, bytesSent: 0, rejectedMessages: 0, reconnects: 0, hostMigrations: 0 },
		};
		this._sessions.set(session.id, session);
		this._notify();
		return {
			session: this._describeSession(session, true),
			connection: { endpoint: `ws://${formatHost(this._advertisedHost)}:${this._port}`, joinCode: session.joinCode, hostToken: session.hostToken },
		};
	}

	/** Lists public browseable or editor-visible lobbies with stable pagination. */
	public listSessions(options: { publicOnly?: boolean; offset?: number; limit?: number } = {}): {
		total: number;
		offset: number;
		limit: number;
		sessions: IGameplaySessionDescription[];
	} {
		const offset = options.offset ?? 0;
		const limit = options.limit ?? 50;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Gameplay session offset/limit is invalid.");
		}
		const sessions = [...this._sessions.values()]
			.filter((session) => options.publicOnly !== true || session.publicLobby)
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
		return {
			total: sessions.length,
			offset,
			limit,
			sessions: sessions.slice(offset, offset + limit).map((session) => this._describeSession(session, options.publicOnly !== true)),
		};
	}

	/** Reads one session with editor-owned join information but never host/reconnect tokens. */
	public getSession(sessionId: string): IGameplaySessionDescription {
		return this._describeSession(this._requireSession(sessionId), true);
	}

	/** Updates documented lobby settings under an exact transient revision. */
	public updateSession(sessionId: string, expectedRevision: number, changes: Partial<IGameplaySessionCreateOptions>): IGameplaySessionDescription {
		const session = this._requireSession(sessionId);
		this._assertSessionRevision(session, expectedRevision);
		const unknown = Object.keys(changes).filter((key) => !["name", "maximumPlayers", "publicLobby", "allowHostMigration", "reconnectGraceMs"].includes(key));
		if (unknown.length || !Object.keys(changes).length) {
			throw new Error(
				unknown.length ? `Gameplay session changes contain unsupported fields: ${unknown.join(", ")}.` : "Gameplay session changes must contain at least one field."
			);
		}
		const candidate: IGameplaySessionCreateOptions = {
			name: changes.name ?? session.name,
			maximumPlayers: changes.maximumPlayers ?? session.maximumPlayers,
			publicLobby: changes.publicLobby ?? session.publicLobby,
			allowHostMigration: changes.allowHostMigration ?? session.allowHostMigration,
			reconnectGraceMs: changes.reconnectGraceMs ?? session.reconnectGraceMs,
		};
		if (typeof candidate.name !== "string" || !candidate.name.trim() || candidate.name.length > 80) {
			throw new Error("Gameplay session name must contain 1-80 characters.");
		}
		if (!Number.isSafeInteger(candidate.maximumPlayers) || candidate.maximumPlayers < session.players.size || candidate.maximumPlayers > 64) {
			throw new Error(`Gameplay session maximumPlayers must be an integer from ${Math.max(1, session.players.size)} to 64.`);
		}
		if (typeof candidate.publicLobby !== "boolean" || typeof candidate.allowHostMigration !== "boolean") {
			throw new Error("Gameplay session publicLobby and allowHostMigration must be booleans.");
		}
		if (!Number.isSafeInteger(candidate.reconnectGraceMs) || candidate.reconnectGraceMs < 0 || candidate.reconnectGraceMs > 300_000) {
			throw new Error("Gameplay session reconnectGraceMs must be an integer from 0 to 300000.");
		}
		session.name = candidate.name.trim();
		session.maximumPlayers = candidate.maximumPlayers;
		session.publicLobby = candidate.publicLobby;
		session.allowHostMigration = candidate.allowHostMigration;
		session.reconnectGraceMs = candidate.reconnectGraceMs;
		this._touch(session);
		this._ensureHost(session);
		this._notify();
		return this._describeSession(session, true);
	}

	/** Destroys one lobby; connected players require an explicit destructive confirmation. */
	public deleteSession(sessionId: string, expectedRevision: number, confirm: boolean): { deleted: boolean; sessionId: string } {
		const session = this._requireSession(sessionId);
		this._assertSessionRevision(session, expectedRevision);
		if ([...session.players.values()].some((player) => player.socket) && !confirm) {
			throw new Error("Deleting an active gameplay session requires confirm=true.");
		}
		for (const player of session.players.values()) {
			player.socket?.close(4001, "Gameplay session deleted");
		}
		this._sessions.delete(sessionId);
		this._notify();
		return { deleted: true, sessionId };
	}

	private _onConnection(socket: any): void {
		if (this._connections.size >= maximumConnections) {
			socket.close(4429, "Gameplay host connection limit reached");
			return;
		}
		this._connections.add(socket);
		let context: IConnectionContext | null = null;
		const handshakeTimer = setTimeout(() => socket.close(4408, "Gameplay hello timeout"), 5_000);
		socket.on("pong", () => {
			if (context) {
				context.player.alive = true;
				context.player.lastSeenAt = new Date().toISOString();
			}
		});
		socket.on("message", (bytes: Buffer, isBinary: boolean) => {
			if (isBinary || bytes.byteLength > maximumFrameBytes) {
				socket.close(4409, "Invalid gameplay frame");
				return;
			}
			let message: NetworkWireMessage;
			try {
				message = parseNetworkWireMessage(bytes.toString("utf8"), maximumFrameBytes);
			} catch (error) {
				socket.close(4402, boundedText(error instanceof Error ? error.message : error, 120));
				return;
			}
			if (!context) {
				if (message.type !== "hello") {
					socket.close(4401, "Expected authenticated gameplay hello");
					return;
				}
				try {
					context = this._acceptHello(socket, message);
					clearTimeout(handshakeTimer);
				} catch (error) {
					socket.close(4401, boundedText(error instanceof Error ? error.message : error, 120));
				}
				return;
			}
			if (!this._consumeRateBudget(context, bytes.byteLength)) {
				socket.close(4429, "Gameplay message rate exceeded");
				return;
			}
			if (context.player.socket !== socket) {
				socket.close(4002, "Gameplay connection was superseded by reconnect");
				return;
			}
			context.session.metrics.bytesReceived += bytes.byteLength;
			context.player.lastSeenAt = new Date().toISOString();
			this._handleMessage(context, message);
		});
		socket.on("close", () => {
			clearTimeout(handshakeTimer);
			this._connections.delete(socket);
			const active = context;
			if (active && active.player.socket === socket) {
				this._disconnectPlayer(active.session, active.player);
			}
			this._notify();
		});
		socket.on("error", () => undefined);
	}

	private _acceptHello(socket: any, hello: INetworkHelloMessage): IConnectionContext {
		const reconnect = hello.reconnectToken ? this._findReconnect(hello.reconnectToken) : null;
		if (reconnect) {
			if (reconnect.player.socket && reconnect.player.socket !== socket) {
				reconnect.player.socket.close(4002, "Gameplay player reconnected elsewhere");
			}
			reconnect.player.socket = socket;
			reconnect.player.clientId = hello.clientId;
			reconnect.player.displayName = hello.displayName.trim();
			reconnect.player.lastSeenAt = new Date().toISOString();
			reconnect.player.disconnectedAt = null;
			reconnect.player.alive = true;
			reconnect.player.windowStartedAt = Date.now();
			reconnect.player.windowMessages = 0;
			reconnect.player.windowBytes = 0;
			reconnect.session.metrics.reconnects++;
			this._touch(reconnect.session);
			this._ensureHost(reconnect.session);
			this._sendWelcome(reconnect.session, reconnect.player);
			this._broadcast(
				reconnect.session,
				createNetworkWireMessage({ type: "peer-joined", playerId: reconnect.player.playerId, displayName: reconnect.player.displayName, role: reconnect.player.role }),
				reconnect.player.playerId
			);
			this._notify();
			return reconnect;
		}

		let session: IGameplaySession | null = null;
		let role: NetworkingPeerRole = "client";
		if (hello.hostToken) {
			session = [...this._sessions.values()].find((candidate) => !candidate.hostTokenConsumed && constantTimeEquals(candidate.hostToken, hello.hostToken!)) ?? null;
			role = "host";
		} else if (hello.joinCode) {
			session = [...this._sessions.values()].find((candidate) => candidate.joinCode === hello.joinCode) ?? null;
		}
		if (!session) {
			throw new Error("Gameplay session credential is invalid or expired.");
		}
		if (session.players.size >= session.maximumPlayers) {
			throw new Error("Gameplay session is full.");
		}
		if (role === "host" && session.hostPlayerId) {
			throw new Error("Gameplay session already has a host.");
		}
		const now = new Date().toISOString();
		const player: IGameplayPlayer = {
			playerId: randomUUID(),
			clientId: hello.clientId,
			displayName: hello.displayName.trim(),
			role,
			socket,
			reconnectToken: createToken(),
			connectedAt: now,
			lastSeenAt: now,
			disconnectedAt: null,
			alive: true,
			windowStartedAt: Date.now(),
			windowMessages: 0,
			windowBytes: 0,
		};
		if (role === "host") {
			session.hostTokenConsumed = true;
			session.hostPlayerId = player.playerId;
		}
		session.players.set(player.playerId, player);
		this._touch(session);
		this._ensureHost(session);
		this._sendWelcome(session, player);
		this._broadcast(session, createNetworkWireMessage({ type: "peer-joined", playerId: player.playerId, displayName: player.displayName, role: player.role }), player.playerId);
		this._notify();
		return { session, player };
	}

	private _handleMessage(context: IConnectionContext, message: NetworkWireMessage): void {
		const { session, player } = context;
		switch (message.type) {
			case "manifest":
				this._handleManifest(session, player, message);
				break;
			case "claim-ownership":
				this._claimOwnership(session, player, message.networkId);
				break;
			case "release-ownership":
				this._releaseOwnership(session, player, message.networkId);
				break;
			case "input":
				this._relayInput(session, player, message);
				break;
			case "snapshot":
				this._relaySnapshot(session, player, message);
				break;
			case "rpc":
				this._relayRpc(session, player, message);
				break;
			case "ping":
				this._send(session, player, createNetworkWireMessage({ type: "pong", sequence: message.sequence, sentAt: message.sentAt, serverTime: Date.now() }));
				break;
			case "pong":
				break;
			default:
				this._reject(session, player, "unsupported_frame", `Clients cannot send ${message.type} frames.`);
				break;
		}
	}

	private _handleManifest(session: IGameplaySession, player: IGameplayPlayer, message: INetworkManifestMessage): void {
		if (player.playerId !== session.hostPlayerId || player.role !== "host") {
			this._reject(session, player, "host_required", "Only the current host can publish the network object manifest.");
			return;
		}
		const next = new Map(message.objects.map((entry) => [entry.networkId, entry.authority]));
		for (const networkId of session.ownership.keys()) {
			if (next.get(networkId) !== "owner") {
				session.ownership.delete(networkId);
				this._broadcast(session, createNetworkWireMessage({ type: "ownership", networkId, playerId: null }));
			}
		}
		session.manifest = next;
		this._touch(session);
	}

	private _claimOwnership(session: IGameplaySession, player: IGameplayPlayer, networkId: string): void {
		if (session.manifest.get(networkId) !== "owner") {
			this._reject(session, player, "not_owner_authority", `Network object ${networkId} is not owner-authoritative.`);
			return;
		}
		const current = session.ownership.get(networkId);
		if (current && current !== player.playerId) {
			this._reject(session, player, "ownership_conflict", `Network object ${networkId} is already owned.`);
			return;
		}
		session.ownership.set(networkId, player.playerId);
		this._touch(session);
		this._broadcast(session, createNetworkWireMessage({ type: "ownership", networkId, playerId: player.playerId }));
	}

	private _releaseOwnership(session: IGameplaySession, player: IGameplayPlayer, networkId: string): void {
		if (session.ownership.get(networkId) !== player.playerId && player.playerId !== session.hostPlayerId) {
			this._reject(session, player, "ownership_required", `Player does not own network object ${networkId}.`);
			return;
		}
		session.ownership.delete(networkId);
		this._touch(session);
		this._broadcast(session, createNetworkWireMessage({ type: "ownership", networkId, playerId: null }));
	}

	private _relayInput(session: IGameplaySession, player: IGameplayPlayer, message: INetworkInputMessage): void {
		if (session.manifest.get(message.networkId) !== "owner" || session.ownership.get(message.networkId) !== player.playerId) {
			this._reject(session, player, "ownership_required", `Player does not own network object ${message.networkId}.`);
			return;
		}
		const host = session.hostPlayerId ? session.players.get(session.hostPlayerId) : null;
		if (!host?.socket) {
			this._reject(session, player, "host_unavailable", "Gameplay session host is unavailable.");
			return;
		}
		this._send(session, host, createNetworkWireMessage({ ...message, senderId: player.playerId }));
	}

	private _relaySnapshot(session: IGameplaySession, player: IGameplayPlayer, message: INetworkSnapshotMessage): void {
		if (player.playerId !== session.hostPlayerId || player.role !== "host") {
			this._reject(session, player, "host_required", "Only the current host can publish snapshots.");
			return;
		}
		const entities = message.entities.filter((entity) => session.manifest.has(entity.networkId));
		const normalized = createNetworkWireMessage({
			...message,
			entities: entities.map((entity) => ({ ...entity, ownerId: session.ownership.get(entity.networkId) ?? null })),
		});
		this._broadcast(session, normalized, player.playerId);
	}

	private _relayRpc(session: IGameplaySession, player: IGameplayPlayer, message: INetworkRpcMessage): void {
		const relay = createNetworkWireMessage({ ...message, senderId: player.playerId });
		if (message.target === "all") {
			this._broadcast(session, relay);
			return;
		}
		if (message.target === "server") {
			const host = session.hostPlayerId ? session.players.get(session.hostPlayerId) : null;
			if (host?.socket) {
				this._send(session, host, relay);
			} else {
				this._reject(session, player, "host_unavailable", "Gameplay session host is unavailable.");
			}
			return;
		}
		if (!message.networkId) {
			this._reject(session, player, "network_id_required", "Owner-targeted RPC requires networkId.");
			return;
		}
		const ownerId = session.ownership.get(message.networkId);
		const owner = ownerId ? session.players.get(ownerId) : null;
		if (owner?.socket) {
			this._send(session, owner, relay);
		} else {
			this._reject(session, player, "owner_unavailable", `Network object ${message.networkId} has no connected owner.`);
		}
	}

	private _sendWelcome(session: IGameplaySession, player: IGameplayPlayer): void {
		this._send(
			session,
			player,
			createNetworkWireMessage({
				type: "welcome",
				sessionId: session.id,
				playerId: player.playerId,
				role: player.role,
				reconnectToken: player.reconnectToken,
				serverTime: Date.now(),
				peers: [...session.players.values()]
					.filter((candidate) => candidate.socket)
					.map((candidate) => ({ playerId: candidate.playerId, displayName: candidate.displayName, role: candidate.role })),
				ownership: Object.fromEntries(session.ownership),
			})
		);
	}

	private _send(session: IGameplaySession, player: IGameplayPlayer, message: NetworkWireMessage): void {
		if (!player.socket || player.socket.readyState !== 1) {
			return;
		}
		const data = JSON.stringify(message);
		try {
			player.socket.send(data);
			session.metrics.messagesRelayed++;
			session.metrics.bytesSent += Buffer.byteLength(data, "utf8");
		} catch {
			player.socket.close(1011, "Gameplay relay send failed");
		}
	}

	private _broadcast(session: IGameplaySession, message: NetworkWireMessage, exceptPlayerId?: string): void {
		for (const player of session.players.values()) {
			if (player.playerId !== exceptPlayerId) {
				this._send(session, player, message);
			}
		}
	}

	private _reject(session: IGameplaySession, player: IGameplayPlayer, code: string, message: string): void {
		session.metrics.rejectedMessages++;
		this._send(session, player, createNetworkWireMessage({ type: "error", code, message }));
	}

	private _consumeRateBudget(context: IConnectionContext, bytes: number): boolean {
		const now = Date.now();
		if (now - context.player.windowStartedAt >= 1_000) {
			context.player.windowStartedAt = now;
			context.player.windowMessages = 0;
			context.player.windowBytes = 0;
		}
		context.player.windowMessages++;
		context.player.windowBytes += bytes;
		return context.player.windowMessages <= maximumMessagesPerSecond && context.player.windowBytes <= maximumBytesPerSecond;
	}

	private _disconnectPlayer(session: IGameplaySession, player: IGameplayPlayer): void {
		player.socket = null;
		player.disconnectedAt = new Date().toISOString();
		player.lastSeenAt = player.disconnectedAt;
		this._touch(session);
		this._broadcast(session, createNetworkWireMessage({ type: "peer-left", playerId: player.playerId, displayName: player.displayName, role: player.role }));
		if (player.playerId === session.hostPlayerId) {
			this._ensureHost(session);
		}
	}

	private _ensureHost(session: IGameplaySession): void {
		// A join code never grants host authority before the one-time host credential is consumed.
		if (!session.hostTokenConsumed) {
			return;
		}
		const current = session.hostPlayerId ? session.players.get(session.hostPlayerId) : null;
		if (current?.socket) {
			return;
		}
		if (!session.allowHostMigration) {
			return;
		}
		const candidate = [...session.players.values()]
			.filter((player) => player.socket && player.playerId !== session.hostPlayerId)
			.sort((left, right) => left.connectedAt.localeCompare(right.connectedAt) || left.playerId.localeCompare(right.playerId))[0];
		if (!candidate) {
			return;
		}
		if (current) {
			current.role = "client";
		}
		candidate.role = "host";
		session.hostPlayerId = candidate.playerId;
		session.metrics.hostMigrations++;
		session.manifest.clear();
		this._touch(session);
		this._broadcast(session, createNetworkWireMessage({ type: "role", playerId: candidate.playerId, role: "host" }));
	}

	private _findReconnect(token: string): IConnectionContext | null {
		for (const session of this._sessions.values()) {
			for (const player of session.players.values()) {
				if (constantTimeEquals(player.reconnectToken, token)) {
					if (player.disconnectedAt && Date.now() - Date.parse(player.disconnectedAt) >= session.reconnectGraceMs) {
						this._expirePlayer(session, player);
						return null;
					}
					return { session, player };
				}
			}
		}
		return null;
	}

	private _cleanupDisconnectedPlayers(): void {
		const now = Date.now();
		let changed = false;
		for (const session of this._sessions.values()) {
			for (const player of session.players.values()) {
				if (player.socket || !player.disconnectedAt || now - Date.parse(player.disconnectedAt) < session.reconnectGraceMs) {
					continue;
				}
				this._expirePlayer(session, player);
				changed = true;
			}
		}
		if (changed) {
			this._notify();
		}
	}

	/** Expires one reconnect lease and releases every owner-authority assignment. */
	private _expirePlayer(session: IGameplaySession, player: IGameplayPlayer): void {
		session.players.delete(player.playerId);
		if (session.hostPlayerId === player.playerId) {
			session.hostPlayerId = null;
		}
		for (const [networkId, ownerId] of session.ownership) {
			if (ownerId === player.playerId) {
				session.ownership.delete(networkId);
				this._broadcast(session, createNetworkWireMessage({ type: "ownership", networkId, playerId: null }));
			}
		}
		this._touch(session);
		this._ensureHost(session);
	}

	private _heartbeatConnections(): void {
		for (const session of this._sessions.values()) {
			for (const player of session.players.values()) {
				if (!player.socket) {
					continue;
				}
				if (!player.alive) {
					player.socket.terminate();
					continue;
				}
				player.alive = false;
				player.socket.ping();
			}
		}
	}

	private _describeSession(session: IGameplaySession, includeJoinCode: boolean): IGameplaySessionDescription {
		const connectedPlayers = [...session.players.values()].filter((player) => player.socket);
		const host = session.hostPlayerId ? session.players.get(session.hostPlayerId) : null;
		return {
			id: session.id,
			revision: session.revision,
			name: session.name,
			joinCode: includeJoinCode || session.publicLobby ? session.joinCode : null,
			publicLobby: session.publicLobby,
			maximumPlayers: session.maximumPlayers,
			allowHostMigration: session.allowHostMigration,
			reconnectGraceMs: session.reconnectGraceMs,
			state: host?.socket ? "active" : connectedPlayers.length ? "degraded" : "waiting",
			hostPlayerId: session.hostPlayerId,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			playerCount: session.players.size,
			connectedPlayerCount: connectedPlayers.length,
			ownershipCount: session.ownership.size,
			manifestObjectCount: session.manifest.size,
			metrics: { ...session.metrics },
			players: [...session.players.values()]
				.sort((left, right) => left.connectedAt.localeCompare(right.connectedAt) || left.playerId.localeCompare(right.playerId))
				.map((player) => ({
					playerId: player.playerId,
					clientId: player.clientId,
					displayName: player.displayName,
					role: player.role,
					connected: Boolean(player.socket),
					connectedAt: player.connectedAt,
					lastSeenAt: player.lastSeenAt,
					disconnectedAt: player.disconnectedAt,
				})),
		};
	}

	private _touch(session: IGameplaySession): void {
		session.revision++;
		session.updatedAt = new Date().toISOString();
	}

	private _requireSession(sessionId: string): IGameplaySession {
		if (typeof sessionId !== "string") {
			throw new Error("Gameplay sessionId is required.");
		}
		const session = this._sessions.get(sessionId);
		if (!session) {
			throw new Error(`Gameplay session not found: ${sessionId}`);
		}
		return session;
	}

	/** Applies compare-and-swap semantics to every transient lobby mutation. */
	private _assertSessionRevision(session: IGameplaySession, expectedRevision: number): void {
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
			throw new Error("Gameplay session mutation requires expectedRevision as a positive safe integer.");
		}
		if (session.revision !== expectedRevision) {
			throw new Error(`Gameplay session revision is stale: expected ${expectedRevision}, current ${session.revision}.`);
		}
	}

	private _requireListening(): void {
		if (this._state !== "listening") {
			throw new Error("Gameplay session host is not listening.");
		}
	}

	private _notify(): void {
		try {
			this._onChanged?.();
		} catch {
			// UI notification failures must never break the gameplay relay.
		}
	}
}
