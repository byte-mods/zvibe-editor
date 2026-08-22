import { createRequire } from "node:module";

import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";

import { getNetworkComponentData } from "../loading/game-object-components";
import {
	createNetworkWireMessage,
	INetworkInputMessage,
	INetworkRpcMessage,
	INetworkSnapshotEntity,
	NetworkWireMessage,
	parseNetworkWireMessage,
} from "../loading/networking-model";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as { WebSocketServer: new (options: Record<string, unknown>) => any };

export interface IProductionSessionHostOptions {
	joinCode: string;
	maximumPlayers: number;
	maximumMessageBytes?: number;
	reconnectGraceMs?: number;
	onRpc?: (message: INetworkRpcMessage & { senderId: string }) => void;
}

interface IProductionPlayer {
	id: string;
	clientId: string;
	displayName: string;
	reconnectToken: string;
	socket: any | null;
	connectedAt: string;
	lastSeenAt: string;
	disconnectedAt: number | null;
	alive: boolean;
	windowStartedAt: number;
	windowMessages: number;
	windowBytes: number;
}

interface INetworkNode {
	node: Node;
	authority: "server" | "owner";
	syncTransform: boolean;
	syncAnimation: boolean;
	sendRateHz: number;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const joinCodePattern = /^[A-Z0-9]{6,12}$/;
const tokenPattern = /^[A-Za-z0-9_-]{24,256}$/;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function token(): string {
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

function playerId(): string {
	return `server-player-${globalThis.crypto.randomUUID()}`.slice(0, 128);
}

function transform(node: Node): INetworkSnapshotEntity["transform"] {
	const candidate = node as any;
	if (!candidate.position || !candidate.scaling) {
		return null;
	}
	const rotation = candidate.rotationQuaternion
		? (candidate.rotationQuaternion as Quaternion).clone().normalize()
		: Quaternion.FromEulerAngles(candidate.rotation?.x ?? 0, candidate.rotation?.y ?? 0, candidate.rotation?.z ?? 0);
	return {
		position: [candidate.position.x, candidate.position.y, candidate.position.z],
		rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w],
		scaling: [candidate.scaling.x, candidate.scaling.y, candidate.scaling.z],
	};
}

function applyInput(node: Node, message: INetworkInputMessage): void {
	const candidate = node as any;
	if (!candidate.position) {
		return;
	}
	candidate.position.addInPlace(Vector3.FromArray(message.translation));
	const rotation = Quaternion.FromEulerAngles(...(message.rotationDegrees.map((value) => (value * Math.PI) / 180) as [number, number, number]));
	candidate.rotationQuaternion ??= Quaternion.FromEulerAngles(candidate.rotation?.x ?? 0, candidate.rotation?.y ?? 0, candidate.rotation?.z ?? 0);
	candidate.rotationQuaternion.multiplyInPlace(rotation).normalize();
}

/**
 * Server-authoritative WebSocket host for exported `NullEngine` scenes. Unlike
 * the editor lobby relay, authority never migrates to a player process.
 */
export class ProductionSessionHost {
	private readonly _scene: Scene;
	private readonly _options: Required<Omit<IProductionSessionHostOptions, "onRpc">> & Pick<IProductionSessionHostOptions, "onRpc">;
	private readonly _players = new Map<string, IProductionPlayer>();
	private readonly _ownership = new Map<string, string>();
	private readonly _acknowledgedInputs = new Map<string, number>();
	private readonly _lastEntitySend = new Map<string, number>();
	private readonly _networkNodes = new Map<string, INetworkNode>();
	private _server: any | null = null;
	private _sequence = 0;
	private _tick = 0;
	private _startedAt = new Date().toISOString();
	private _metrics = {
		connections: 0,
		messagesReceived: 0,
		messagesSent: 0,
		bytesReceived: 0,
		bytesSent: 0,
		rejectedMessages: 0,
		snapshotsSent: 0,
		inputsApplied: 0,
		rpcsReceived: 0,
	};

	public constructor(scene: Scene, options: IProductionSessionHostOptions) {
		if (!joinCodePattern.test(options.joinCode)) {
			throw new Error("Production session joinCode must contain 6-12 uppercase letters or digits.");
		}
		if (!Number.isSafeInteger(options.maximumPlayers) || options.maximumPlayers < 1 || options.maximumPlayers > 256) {
			throw new Error("Production session maximumPlayers must be an integer from 1 to 256.");
		}
		this._scene = scene;
		this._options = {
			joinCode: options.joinCode,
			maximumPlayers: options.maximumPlayers,
			maximumMessageBytes: options.maximumMessageBytes ?? 262_144,
			reconnectGraceMs: options.reconnectGraceMs ?? 15_000,
			onRpc: options.onRpc,
		};
		this._refreshNetworkNodes();
	}

	/** Attaches the `/session` upgrade path to an existing Node HTTP server. */
	public attach(httpServer: any): void {
		if (this._server) {
			throw new Error("Production session host is already attached.");
		}
		const server = new WebSocketServer({ server: httpServer, path: "/session", maxPayload: this._options.maximumMessageBytes, perMessageDeflate: false, clientTracking: true });
		server.on("connection", (socket: any) => this._onConnection(socket));
		server.on("error", () => undefined);
		this._server = server;
	}

	/** Advances authoritative time and publishes one bounded snapshot. */
	public tick(): void {
		this._tick++;
		this._refreshNetworkNodes();
		this._expirePlayers();
		const now = Date.now();
		const entities: INetworkSnapshotEntity[] = [];
		for (const [networkId, entry] of this._networkNodes) {
			const previous = this._lastEntitySend.get(networkId) ?? Number.NEGATIVE_INFINITY;
			if (now - previous < 1_000 / entry.sendRateHz) {
				continue;
			}
			this._lastEntitySend.set(networkId, now);
			entities.push({
				networkId,
				ownerId: this._ownership.get(networkId) ?? null,
				transform: entry.syncTransform ? transform(entry.node) : null,
				animations: entry.syncAnimation
					? this._scene.animationGroups
							.filter((group) => group.targetedAnimations.some((animation) => animation.target === entry.node))
							.slice(0, 128)
							.map((group) => ({
								name: group.name,
								playing: group.isStarted,
								loop: group.loopAnimation,
								currentFrame: Number.isFinite(group.animatables[0]?.masterFrame) ? group.animatables[0].masterFrame : group.from,
								speedRatio: group.speedRatio,
							}))
					: [],
			});
		}
		if (entities.length && this._connectedPlayers().length) {
			this._broadcast(
				createNetworkWireMessage({
					type: "snapshot",
					sequence: ++this._sequence,
					tick: this._tick,
					serverTime: now,
					acknowledgedInputs: Object.fromEntries(this._acknowledgedInputs),
					entities,
				})
			);
			this._metrics.snapshotsSent++;
		}
	}

	/** Returns bounded credential-free fleet health and replication metrics. */
	public status(): Record<string, unknown> {
		return {
			state: this._server ? "listening" : "stopped",
			startedAt: this._startedAt,
			tick: this._tick,
			connectedPlayers: this._connectedPlayers().length,
			retainedPlayers: this._players.size,
			maximumPlayers: this._options.maximumPlayers,
			networkObjectCount: this._networkNodes.size,
			ownershipCount: this._ownership.size,
			joinCodeRequired: true,
			metrics: clone(this._metrics),
		};
	}

	/** Stops accepting clients and releases all transient state. */
	public async close(): Promise<void> {
		const server = this._server;
		this._server = null;
		for (const player of this._players.values()) {
			player.socket?.close(1001, "Dedicated server stopped");
		}
		this._players.clear();
		this._ownership.clear();
		if (server) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}

	private _onConnection(socket: any): void {
		let player: IProductionPlayer | null = null;
		const timer = setTimeout(() => socket.close(4408, "Gameplay hello timeout"), 5_000);
		socket.on("pong", () => {
			if (player) {
				player.alive = true;
			}
		});
		socket.on("message", (bytes: Buffer, isBinary: boolean) => {
			if (isBinary || bytes.byteLength > this._options.maximumMessageBytes) {
				socket.close(4409, "Invalid gameplay frame");
				return;
			}
			let message: NetworkWireMessage;
			try {
				message = parseNetworkWireMessage(bytes.toString("utf8"), this._options.maximumMessageBytes);
			} catch {
				socket.close(4402, "Invalid gameplay frame");
				return;
			}
			if (!player) {
				if (message.type !== "hello") {
					socket.close(4401, "Expected authenticated gameplay hello");
					return;
				}
				try {
					player = this._accept(socket, message);
					clearTimeout(timer);
				} catch (error) {
					socket.close(4401, error instanceof Error ? error.message.slice(0, 120) : "Authentication failed");
				}
				return;
			}
			this._handle(player, message, bytes.byteLength);
		});
		socket.on("close", () => {
			clearTimeout(timer);
			const disconnected = player;
			if (disconnected && disconnected.socket === socket) {
				disconnected.socket = null;
				disconnected.disconnectedAt = Date.now();
				this._broadcast(createNetworkWireMessage({ type: "peer-left", playerId: disconnected.id, displayName: disconnected.displayName, role: "client" }));
			}
		});
		socket.on("error", () => undefined);
	}

	private _accept(socket: any, hello: Extract<NetworkWireMessage, { type: "hello" }>): IProductionPlayer {
		if (hello.joinCode !== this._options.joinCode) {
			throw new Error("Gameplay join code is invalid.");
		}
		if (!identifierPattern.test(hello.clientId) || !hello.displayName.trim() || hello.displayName.length > 80) {
			throw new Error("Gameplay client identity is invalid.");
		}
		let player =
			hello.reconnectToken && tokenPattern.test(hello.reconnectToken)
				? [...this._players.values()].find((candidate) => candidate.reconnectToken === hello.reconnectToken)
				: undefined;
		if (!player && this._players.size >= this._options.maximumPlayers) {
			throw new Error("Dedicated server is full.");
		}
		const now = new Date().toISOString();
		if (player) {
			player.socket?.close(4002, "Gameplay player reconnected elsewhere");
			player.socket = socket;
			player.clientId = hello.clientId;
			player.displayName = hello.displayName.trim();
			player.lastSeenAt = now;
			player.disconnectedAt = null;
		} else {
			player = {
				id: playerId(),
				clientId: hello.clientId,
				displayName: hello.displayName.trim(),
				reconnectToken: token(),
				socket,
				connectedAt: now,
				lastSeenAt: now,
				disconnectedAt: null,
				alive: true,
				windowStartedAt: Date.now(),
				windowMessages: 0,
				windowBytes: 0,
			};
			this._players.set(player.id, player);
		}
		this._metrics.connections++;
		this._send(
			player,
			createNetworkWireMessage({
				type: "welcome",
				sessionId: "production",
				playerId: player.id,
				role: "client",
				reconnectToken: player.reconnectToken,
				serverTime: Date.now(),
				peers: this._connectedPlayers().map((candidate) => ({ playerId: candidate.id, displayName: candidate.displayName, role: "client" as const })),
				ownership: Object.fromEntries(this._ownership),
			})
		);
		this._broadcast(createNetworkWireMessage({ type: "peer-joined", playerId: player.id, displayName: player.displayName, role: "client" }), player.id);
		return player;
	}

	private _handle(player: IProductionPlayer, message: NetworkWireMessage, bytes: number): void {
		const now = Date.now();
		if (now - player.windowStartedAt >= 1_000) {
			player.windowStartedAt = now;
			player.windowMessages = 0;
			player.windowBytes = 0;
		}
		player.windowMessages++;
		player.windowBytes += bytes;
		if (player.windowMessages > 240 || player.windowBytes > 4 * 1024 * 1024) {
			player.socket?.close(4429, "Gameplay message rate exceeded");
			return;
		}
		player.lastSeenAt = new Date().toISOString();
		this._metrics.messagesReceived++;
		this._metrics.bytesReceived += bytes;
		switch (message.type) {
			case "claim-ownership": {
				const entry = this._networkNodes.get(message.networkId);
				if (entry?.authority !== "owner" || (this._ownership.has(message.networkId) && this._ownership.get(message.networkId) !== player.id)) {
					this._reject(player, "ownership_conflict", `Network object ${message.networkId} cannot be claimed.`);
					break;
				}
				this._ownership.set(message.networkId, player.id);
				this._broadcast(createNetworkWireMessage({ type: "ownership", networkId: message.networkId, playerId: player.id }));
				break;
			}
			case "release-ownership":
				if (this._ownership.get(message.networkId) === player.id) {
					this._ownership.delete(message.networkId);
					this._broadcast(createNetworkWireMessage({ type: "ownership", networkId: message.networkId, playerId: null }));
				}
				break;
			case "input": {
				const entry = this._networkNodes.get(message.networkId);
				if (!entry || entry.authority !== "owner" || this._ownership.get(message.networkId) !== player.id) {
					this._reject(player, "ownership_required", `Player does not own network object ${message.networkId}.`);
					break;
				}
				applyInput(entry.node, message);
				this._acknowledgedInputs.set(player.id, Math.max(message.sequence, this._acknowledgedInputs.get(player.id) ?? 0));
				this._metrics.inputsApplied++;
				break;
			}
			case "rpc":
				this._metrics.rpcsReceived++;
				this._options.onRpc?.({ ...message, senderId: player.id });
				if (message.target === "all") {
					this._broadcast(createNetworkWireMessage({ ...message, senderId: player.id }));
				} else if (message.target === "owner" && message.networkId) {
					const owner = this._players.get(this._ownership.get(message.networkId) ?? "");
					if (owner) {
						this._send(owner, createNetworkWireMessage({ ...message, senderId: player.id }));
					}
				}
				break;
			case "ping":
				this._send(player, createNetworkWireMessage({ type: "pong", sequence: message.sequence, sentAt: message.sentAt, serverTime: Date.now() }));
				break;
			default:
				this._reject(player, "server_authority", `Clients cannot send ${message.type} to a production authority.`);
		}
	}

	private _refreshNetworkNodes(): void {
		this._networkNodes.clear();
		for (const node of this._scene.getNodes()) {
			const data = getNetworkComponentData(node);
			if (data && data.networkId && !this._networkNodes.has(data.networkId)) {
				this._networkNodes.set(data.networkId, {
					node,
					authority: data.authority,
					syncTransform: data.syncTransform,
					syncAnimation: data.syncAnimation,
					sendRateHz: data.sendRateHz,
				});
			}
		}
	}

	private _connectedPlayers(): IProductionPlayer[] {
		return [...this._players.values()].filter((player) => player.socket);
	}

	private _expirePlayers(): void {
		const now = Date.now();
		for (const [id, player] of this._players) {
			if (player.disconnectedAt !== null && now - player.disconnectedAt > this._options.reconnectGraceMs) {
				this._players.delete(id);
				for (const [networkId, ownerId] of this._ownership) {
					if (ownerId === id) {
						this._ownership.delete(networkId);
					}
				}
			}
		}
	}

	private _reject(player: IProductionPlayer, code: string, message: string): void {
		this._metrics.rejectedMessages++;
		this._send(player, createNetworkWireMessage({ type: "error", code, message }));
	}

	private _send(player: IProductionPlayer, message: NetworkWireMessage): void {
		if (!player.socket || player.socket.readyState !== 1) {
			return;
		}
		const data = JSON.stringify(message);
		player.socket.send(data);
		this._metrics.messagesSent++;
		this._metrics.bytesSent += Buffer.byteLength(data);
	}

	private _broadcast(message: NetworkWireMessage, exceptId?: string): void {
		for (const player of this._connectedPlayers()) {
			if (player.id !== exceptId) {
				this._send(player, message);
			}
		}
	}
}
