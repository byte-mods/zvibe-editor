import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observable } from "@babylonjs/core/Misc/observable";
import { Node } from "@babylonjs/core/node";
import { Scene } from "@babylonjs/core/scene";

import { getNetworkComponentData } from "./game-object-components";
import {
	createNetworkWireMessage,
	getSceneNetworkingConfiguration,
	IEditorNetworkingConfiguration,
	INetworkingSimulationConfiguration,
	INetworkInputMessage,
	INetworkRpcMessage,
	INetworkSnapshotEntity,
	INetworkSnapshotMessage,
	INetworkTransformState,
	NetworkClientMessage,
	NetworkingChannel,
	NetworkingConnectionState,
	NetworkingPeerRole,
	NetworkingRpcTarget,
	NetworkServerMessage,
	parseNetworkWireMessage,
	validateNetworkingConfiguration,
} from "./networking-model";

export * from "./networking-model";

export interface INetworkingConnectOptions {
	endpoint?: string;
	clientId?: string;
	displayName?: string;
	joinCode?: string;
	hostToken?: string;
	reconnectToken?: string;
}

export interface INetworkingSocketEvent {
	data?: unknown;
	code?: number;
	reason?: string;
}

export interface INetworkingSocket {
	readonly readyState: number;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: INetworkingSocketEvent) => void): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type NetworkingSocketFactory = (endpoint: string) => INetworkingSocket;

export interface INetworkingRuntimeOptions {
	configuration?: IEditorNetworkingConfiguration;
	socketFactory?: NetworkingSocketFactory;
	now?: () => number;
	random?: () => number;
}

export interface INetworkingRuntimeTraceEvent {
	sequence: number;
	capturedAt: string;
	direction: "in" | "out" | "runtime";
	type: string;
	detail: Record<string, unknown>;
}

export interface INetworkingRuntimeMetrics {
	messagesSent: number;
	messagesReceived: number;
	bytesSent: number;
	bytesReceived: number;
	snapshotsSent: number;
	snapshotsReceived: number;
	inputsSent: number;
	inputsReceived: number;
	rpcsSent: number;
	rpcsReceived: number;
	packetsSimulatedLost: number;
	reconciliations: number;
	reconnects: number;
	roundTripTimeMs: number | null;
}

export interface INetworkingRuntimeStatus {
	configurationRevision: number;
	state: NetworkingConnectionState;
	role: NetworkingPeerRole | null;
	sessionId: string | null;
	playerId: string | null;
	endpoint: string | null;
	peerCount: number;
	ownedNetworkIds: string[];
	networkObjectCount: number;
	tick: number;
	lastError: string | null;
	reconnectScheduled: boolean;
	metrics: INetworkingRuntimeMetrics;
	simulation: INetworkingSimulationConfiguration;
}

export interface INetworkingRpcEvent {
	sequence: number;
	name: string;
	target: NetworkingRpcTarget;
	channel: NetworkingChannel;
	networkId: string | null;
	payload: unknown;
	senderId: string | null;
}

interface IPendingInput {
	message: INetworkInputMessage;
}

interface IEntitySample {
	sequence: number;
	serverTime: number;
	entity: INetworkSnapshotEntity;
}

interface INetworkNode {
	node: Node;
	data: NonNullable<ReturnType<typeof getNetworkComponentData>>;
}

const socketOpen = 1;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const joinCodePattern = /^[A-Z0-9]{6,12}$/;
const tokenPattern = /^[A-Za-z0-9_-]{24,256}$/;
const maximumFixedStepsPerFrame = 8;

/** Default browser/Electron socket factory; tests can inject a deterministic transport. */
function createSocket(endpoint: string): INetworkingSocket {
	if (typeof WebSocket === "undefined") {
		throw new Error("Networking requires a browser-compatible WebSocket runtime or a custom socketFactory.");
	}
	return new WebSocket(endpoint) as unknown as INetworkingSocket;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? "Unknown networking error.");
	return message.length <= 1_024 ? message : `${message.slice(0, 1_024)}…`;
}

function randomIdentifier(prefix: string): string {
	const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `${prefix}-${id}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, 128);
}

/** Xorshift32 makes one authored simulation seed repeatable across runtimes. */
function seededRandom(seed: number): () => number {
	let state = seed || 0x6d2b79f5;
	return (): number => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4_294_967_296;
	};
}

function tuple3(vector: Vector3): [number, number, number] {
	return [vector.x, vector.y, vector.z];
}

function nodeTransform(node: Node): INetworkTransformState | null {
	const target = node as any;
	if (!target.position || !target.scaling) {
		return null;
	}
	const rotation = target.rotationQuaternion
		? (target.rotationQuaternion as Quaternion)
		: Quaternion.FromEulerAngles(target.rotation?.x ?? 0, target.rotation?.y ?? 0, target.rotation?.z ?? 0);
	const values = [target.position.x, target.position.y, target.position.z, target.scaling.x, target.scaling.y, target.scaling.z, rotation.x, rotation.y, rotation.z, rotation.w];
	if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
		return null;
	}
	const normalizedRotation = rotation.lengthSquared() >= 0.25 ? rotation.clone().normalize() : Quaternion.Identity();
	return {
		position: tuple3(target.position),
		rotationQuaternion: [normalizedRotation.x, normalizedRotation.y, normalizedRotation.z, normalizedRotation.w],
		scaling: tuple3(target.scaling),
	};
}

function setNodeTransform(node: Node, transform: INetworkTransformState): void {
	const target = node as any;
	if (!target.position || !target.scaling) {
		return;
	}
	target.position.copyFromFloats(...transform.position);
	target.scaling.copyFromFloats(...transform.scaling);
	target.rotationQuaternion ??= new Quaternion();
	target.rotationQuaternion.copyFromFloats(...transform.rotationQuaternion);
}

function applyInput(node: Node, message: INetworkInputMessage): void {
	const target = node as any;
	if (!target.position) {
		return;
	}
	target.position.addInPlace(Vector3.FromArray(message.translation));
	const rotation = Quaternion.FromEulerAngles(...(message.rotationDegrees.map((value) => (value * Math.PI) / 180) as [number, number, number]));
	target.rotationQuaternion ??= Quaternion.FromEulerAngles(target.rotation?.x ?? 0, target.rotation?.y ?? 0, target.rotation?.z ?? 0);
	target.rotationQuaternion.multiplyInPlace(rotation).normalize();
}

function interpolateTransform(left: INetworkTransformState, right: INetworkTransformState, amount: number): INetworkTransformState {
	const position = Vector3.Lerp(Vector3.FromArray(left.position), Vector3.FromArray(right.position), amount);
	const scaling = Vector3.Lerp(Vector3.FromArray(left.scaling), Vector3.FromArray(right.scaling), amount);
	const rotation = Quaternion.Slerp(Quaternion.FromArray(left.rotationQuaternion), Quaternion.FromArray(right.rotationQuaternion), amount).normalize();
	return { position: tuple3(position), rotationQuaternion: [rotation.x, rotation.y, rotation.z, rotation.w], scaling: tuple3(scaling) };
}

function extrapolateTransform(previous: IEntitySample, latest: IEntitySample, targetTime: number): INetworkTransformState | null {
	const left = previous.entity.transform;
	const right = latest.entity.transform;
	const elapsed = latest.serverTime - previous.serverTime;
	if (!left || !right || elapsed <= 0) {
		return right ? clone(right) : null;
	}
	const amount = (targetTime - latest.serverTime) / elapsed;
	const leftPosition = Vector3.FromArray(left.position);
	const velocity = Vector3.FromArray(right.position).subtract(leftPosition);
	const position = Vector3.FromArray(right.position).addInPlace(velocity.scale(amount));
	return { ...clone(right), position: tuple3(position) };
}

const runtimes = new WeakMap<Scene, NetworkingRuntime>();

/**
 * Scene-owned portable replication runtime. One instance owns every observer,
 * timer, socket, prediction history, and trace for deterministic cleanup.
 */
export class NetworkingRuntime {
	public readonly onRpcObservable = new Observable<INetworkingRpcEvent>();
	public readonly onStateChangedObservable = new Observable<INetworkingRuntimeStatus>();

	private readonly _scene: Scene;
	private readonly _configuration: IEditorNetworkingConfiguration;
	private readonly _socketFactory: NetworkingSocketFactory;
	private readonly _now: () => number;
	private readonly _usesCustomRandom: boolean;
	private _random: () => number;
	private readonly _observer: any;
	private readonly _metrics: INetworkingRuntimeMetrics = {
		messagesSent: 0,
		messagesReceived: 0,
		bytesSent: 0,
		bytesReceived: 0,
		snapshotsSent: 0,
		snapshotsReceived: 0,
		inputsSent: 0,
		inputsReceived: 0,
		rpcsSent: 0,
		rpcsReceived: 0,
		packetsSimulatedLost: 0,
		reconciliations: 0,
		reconnects: 0,
		roundTripTimeMs: null,
	};
	private _state: NetworkingConnectionState = "disconnected";
	private _role: NetworkingPeerRole | null = null;
	private _sessionId: string | null = null;
	private _playerId: string | null = null;
	private _endpoint: string | null = null;
	private _lastError: string | null = null;
	private _socket: INetworkingSocket | null = null;
	private _connectOptions: Required<Pick<INetworkingConnectOptions, "clientId" | "displayName">> & Omit<INetworkingConnectOptions, "clientId" | "displayName"> = {
		clientId: "",
		displayName: "Zvibe Player",
	};
	private _reconnectToken: string | null = null;
	private _reconnectAttempt = 0;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _connectionTimer: ReturnType<typeof setTimeout> | null = null;
	private _manualDisconnect = false;
	private _disposed = false;
	private _tick = 0;
	private _fixedAccumulator = 0;
	private _snapshotAccumulator = 0;
	private _outgoingSequence = 0;
	private _inputSequence = 0;
	private _traceSequence = 0;
	private _lastPingAt = 0;
	private _peers = new Map<string, { displayName: string; role: NetworkingPeerRole }>();
	private _ownership = new Map<string, string>();
	private _acknowledgedInputs = new Map<string, number>();
	private _pendingInputs = new Map<string, IPendingInput[]>();
	private _samples = new Map<string, IEntitySample[]>();
	private _lastEntitySend = new Map<string, number>();
	private _networkNodes = new Map<string, INetworkNode>();
	private _duplicateNetworkIds = new Set<string>();
	private _manifestFingerprint = "";
	private _trace: INetworkingRuntimeTraceEvent[] = [];
	private _simulationTimers = new Set<ReturnType<typeof setTimeout>>();

	public constructor(scene: Scene, options: INetworkingRuntimeOptions = {}) {
		this._scene = scene;
		this._configuration = clone(options.configuration ?? getSceneNetworkingConfiguration(scene, false));
		validateNetworkingConfiguration(this._configuration);
		this._socketFactory = options.socketFactory ?? createSocket;
		this._now = options.now ?? (() => Date.now());
		this._usesCustomRandom = Boolean(options.random);
		this._random = options.random ?? seededRandom(this._configuration.simulation.seed);
		this._refreshNetworkNodes();
		this._observer = scene.onBeforeRenderObservable.add(() => this.update(Math.min(Math.max(scene.getEngine().getDeltaTime() / 1000, 0), 0.25)));
		scene.onDisposeObservable.addOnce(() => this.dispose());
	}

	/** Opens one authenticated gameplay connection; credentials remain memory-only. */
	public connect(options: INetworkingConnectOptions = {}): INetworkingRuntimeStatus {
		if (this._disposed) {
			throw new Error("Networking runtime is disposed.");
		}
		if (!this._configuration.enabled) {
			throw new Error("Networking must be enabled in the scene configuration before connecting.");
		}
		if (this._socket || this._reconnectTimer || ["connecting", "connected", "reconnecting"].includes(this._state)) {
			throw new Error("Networking runtime is already connected or changing connection state.");
		}
		const endpoint = options.endpoint ?? this._configuration.transport.endpoint;
		if (!endpoint) {
			throw new Error("Networking connect requires an authored or explicit endpoint.");
		}
		const endpointCandidate = clone(this._configuration);
		endpointCandidate.transport.endpoint = endpoint;
		validateNetworkingConfiguration(endpointCandidate);
		const clientId = options.clientId ?? randomIdentifier("client");
		const displayName = options.displayName ?? "Zvibe Player";
		if (!identifierPattern.test(clientId) || !displayName.trim() || displayName.length > 80) {
			throw new Error("Networking clientId or displayName is invalid.");
		}
		if (options.joinCode !== undefined && !joinCodePattern.test(options.joinCode)) {
			throw new Error("Networking joinCode must contain 6-12 uppercase letters or digits.");
		}
		for (const [label, token] of [
			["hostToken", options.hostToken],
			["reconnectToken", options.reconnectToken],
		] as const) {
			if (token !== undefined && !tokenPattern.test(token)) {
				throw new Error(`Networking ${label} must contain 24-256 URL-safe characters.`);
			}
		}
		this._endpoint = endpoint;
		this._connectOptions = { ...options, endpoint, clientId, displayName };
		this._reconnectToken = options.reconnectToken ?? null;
		this._manualDisconnect = false;
		this._openSocket(false);
		return this.status();
	}

	/** Closes transport and cancels reconnect/simulation work without disposing authored state. */
	public disconnect(): INetworkingRuntimeStatus {
		this._manualDisconnect = true;
		this._clearConnectionTimer();
		this._clearReconnectTimer();
		this._clearSimulationTimers();
		const socket = this._socket;
		this._socket = null;
		if (socket) {
			socket.close(1000, "Player disconnected");
		}
		this._role = null;
		this._sessionId = null;
		this._playerId = null;
		this._peers.clear();
		this._ownership.clear();
		this._setState("disconnected");
		return this.status();
	}

	/** Reopens a deliberately disconnected player with its in-memory reconnect lease. */
	public reconnect(): INetworkingRuntimeStatus {
		if (!this._reconnectToken || !this._endpoint || !this._connectOptions.clientId) {
			throw new Error("Networking runtime has no reconnect lease.");
		}
		return this.connect({ ...this._connectOptions, reconnectToken: this._reconnectToken });
	}

	/** Advances fixed networking time; exposed for deterministic headless tests. */
	public update(deltaSeconds: number): void {
		if (this._disposed || !Number.isFinite(deltaSeconds) || deltaSeconds < 0) {
			return;
		}
		this._refreshNetworkNodes();
		this._fixedAccumulator += deltaSeconds;
		const fixedStep = 1 / this._configuration.replication.tickRateHz;
		let steps = 0;
		while (this._fixedAccumulator >= fixedStep && steps++ < maximumFixedStepsPerFrame) {
			this._fixedAccumulator -= fixedStep;
			this._tick++;
			this._snapshotAccumulator += fixedStep;
			if (this._role === "host" && this._state === "connected" && this._snapshotAccumulator >= 1 / this._configuration.replication.snapshotRateHz) {
				this._snapshotAccumulator %= 1 / this._configuration.replication.snapshotRateHz;
				this._sendSnapshot();
			}
		}
		if (steps > maximumFixedStepsPerFrame) {
			this._fixedAccumulator = 0;
			this._record("runtime", "fixed-step-clamped", { maximumSteps: maximumFixedStepsPerFrame });
		}
		if (this._role === "client" && this._state === "connected") {
			this._applyRemoteSamples();
		}
		if (this._state === "connected" && this._now() - this._lastPingAt >= 5_000) {
			this._lastPingAt = this._now();
			this._send(createNetworkWireMessage({ type: "ping", sequence: ++this._outgoingSequence, sentAt: this._lastPingAt }), false);
		}
	}

	/** Applies owner input immediately, retains it for replay, and sends it to authority. */
	public submitInput(networkId: string, translation: [number, number, number], rotationDegrees: [number, number, number]): INetworkInputMessage {
		this._requireConnected();
		const entry = this._requireNetworkNode(networkId);
		const ownedByLocal = this._ownership.get(networkId) === this._playerId;
		if (entry.data.authority === "owner" && !ownedByLocal) {
			throw new Error(`Local player does not own network object: ${networkId}.`);
		}
		if (this._role !== "host" && entry.data.authority === "server") {
			throw new Error(`Network object ${networkId} has server authority.`);
		}
		const message = createNetworkWireMessage({ type: "input", sequence: ++this._inputSequence, tick: this._tick, networkId, translation, rotationDegrees });
		applyInput(entry.node, message);
		if (this._role === "client" && this._configuration.prediction.enabled) {
			const history = this._pendingInputs.get(networkId) ?? [];
			history.push({ message });
			history.splice(0, Math.max(0, history.length - this._configuration.prediction.historySize));
			this._pendingInputs.set(networkId, history);
		}
		if (this._role === "client") {
			this._metrics.inputsSent++;
			this._send(message, true);
		}
		return clone(message);
	}

	/** Requests or releases one owner-authority object through the session host. */
	public setOwnership(networkId: string, claim: boolean): void {
		this._requireConnected();
		const entry = this._requireNetworkNode(networkId);
		if (entry.data.authority !== "owner") {
			throw new Error(`Network object ${networkId} uses server authority and cannot be claimed.`);
		}
		this._send(createNetworkWireMessage({ type: claim ? "claim-ownership" : "release-ownership", networkId }), false);
	}

	/** Sends one bounded game RPC; unreliable means simulation may drop it over ordered WebSocket. */
	public sendRpc(name: string, target: NetworkingRpcTarget, payload: unknown, options: { channel?: NetworkingChannel; networkId?: string } = {}): INetworkRpcMessage {
		this._requireConnected();
		if (target === "owner" && !options.networkId) {
			throw new Error("Owner-targeted networking RPCs require networkId.");
		}
		const message = createNetworkWireMessage({
			type: "rpc",
			sequence: ++this._outgoingSequence,
			name,
			target,
			channel: options.channel ?? "reliable",
			...(options.networkId ? { networkId: options.networkId } : {}),
			payload,
		});
		this._metrics.rpcsSent++;
		this._send(message, message.channel === "unreliable");
		return clone(message);
	}

	/** Returns credential-free connection, replication, and transport evidence. */
	public status(): INetworkingRuntimeStatus {
		return {
			configurationRevision: this._configuration.revision,
			state: this._state,
			role: this._role,
			sessionId: this._sessionId,
			playerId: this._playerId,
			endpoint: this._endpoint,
			peerCount: this._peers.size,
			ownedNetworkIds: this._playerId
				? [...this._ownership.entries()]
						.filter(([, ownerId]) => ownerId === this._playerId)
						.map(([networkId]) => networkId)
						.sort()
				: [],
			networkObjectCount: this._networkNodes.size,
			tick: this._tick,
			lastError: this._lastError,
			reconnectScheduled: Boolean(this._reconnectTimer),
			metrics: clone(this._metrics),
			simulation: clone(this._configuration.simulation),
		};
	}

	/** Applies transient per-player adverse-network settings without authoring metadata. */
	public setSimulation(changes: Partial<INetworkingSimulationConfiguration>): INetworkingSimulationConfiguration {
		if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
			throw new Error("Networking simulation changes must be an object.");
		}
		const allowed = ["enabled", "latencyMs", "jitterMs", "packetLossPercent", "packetReorderPercent", "seed"];
		const unknown = Object.keys(changes).filter((key) => !allowed.includes(key));
		if (unknown.length || !Object.keys(changes).length) {
			throw new Error(
				unknown.length
					? `Networking simulation changes contain unsupported fields: ${unknown.join(", ")}.`
					: "Networking simulation changes must contain at least one field."
			);
		}
		const candidate = clone(this._configuration);
		candidate.simulation = { ...candidate.simulation, ...clone(changes) };
		validateNetworkingConfiguration(candidate);
		this._configuration.simulation = candidate.simulation;
		if (!this._usesCustomRandom && changes.seed !== undefined) {
			this._random = seededRandom(candidate.simulation.seed);
		}
		this._clearSimulationTimers();
		this._record("runtime", "simulation-updated", { ...candidate.simulation });
		return clone(candidate.simulation);
	}

	/** Pages retained protocol evidence without exposing handshake credentials. */
	public trace(offset = 0, limit = 200): { total: number; offset: number; limit: number; events: INetworkingRuntimeTraceEvent[] } {
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error("Networking trace offset/limit is invalid.");
		}
		return { total: this._trace.length, offset, limit, events: clone(this._trace.slice(offset, offset + limit)) };
	}

	/** Clears only transient trace/metric evidence, preserving the active connection. */
	public clearEvidence(): void {
		this._trace.length = 0;
		this._traceSequence = 0;
		for (const key of Object.keys(this._metrics) as Array<keyof INetworkingRuntimeMetrics>) {
			(this._metrics as any)[key] = key === "roundTripTimeMs" ? null : 0;
		}
	}

	/** Releases every observer/socket/timer and makes later callbacks inert. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this.disconnect();
		this._disposed = true;
		this._scene.onBeforeRenderObservable.remove(this._observer);
		this.onRpcObservable.clear();
		this.onStateChangedObservable.clear();
		if (this._scene.networkingRuntime === this) {
			delete this._scene.networkingRuntime;
		}
		if (runtimes.get(this._scene) === this) {
			runtimes.delete(this._scene);
		}
	}

	private _openSocket(reconnecting: boolean): void {
		if (this._disposed || this._manualDisconnect || !this._endpoint) {
			return;
		}
		this._clearReconnectTimer();
		this._setState(reconnecting ? "reconnecting" : "connecting");
		let socket: INetworkingSocket;
		try {
			socket = this._socketFactory(this._endpoint);
		} catch (error) {
			this._lastError = safeError(error);
			this._setState("error");
			this._scheduleReconnect();
			return;
		}
		this._socket = socket;
		this._connectionTimer = setTimeout(() => {
			if (this._socket === socket && this._state !== "connected") {
				this._lastError = "Networking connection timed out.";
				socket.close(4408, "Connection timeout");
			}
		}, this._configuration.transport.connectionTimeoutMs);
		socket.addEventListener("open", () => {
			if (this._socket !== socket || this._disposed) {
				return;
			}
			const hello = createNetworkWireMessage({
				type: "hello",
				clientId: this._connectOptions.clientId,
				displayName: this._connectOptions.displayName,
				...(this._connectOptions.joinCode ? { joinCode: this._connectOptions.joinCode } : {}),
				...(this._connectOptions.hostToken ? { hostToken: this._connectOptions.hostToken } : {}),
				...(this._reconnectToken ? { reconnectToken: this._reconnectToken } : {}),
			});
			this._sendNow(hello);
		});
		socket.addEventListener("message", (event) => {
			if (this._socket !== socket || this._disposed || typeof event.data !== "string") {
				return;
			}
			this._receive(event.data);
		});
		socket.addEventListener("error", () => {
			if (this._socket === socket) {
				this._lastError = "Networking WebSocket connection failed.";
			}
		});
		socket.addEventListener("close", (event) => {
			if (this._socket !== socket) {
				return;
			}
			this._socket = null;
			this._clearConnectionTimer();
			this._role = null;
			this._sessionId = null;
			this._playerId = null;
			this._peers.clear();
			this._ownership.clear();
			if (!this._manualDisconnect && !this._disposed) {
				this._lastError ??= event.reason || "Networking connection closed.";
				this._setState("disconnected");
				this._scheduleReconnect();
			} else {
				this._setState("disconnected");
			}
		});
	}

	private _receive(raw: string): void {
		let message: NetworkServerMessage;
		try {
			message = parseNetworkWireMessage(raw, this._configuration.transport.maximumMessageBytes) as NetworkServerMessage;
		} catch (error) {
			this._lastError = safeError(error);
			this._record("runtime", "invalid-frame", { error: this._lastError });
			return;
		}
		this._metrics.messagesReceived++;
		this._metrics.bytesReceived += new TextEncoder().encode(raw).byteLength;
		const unreliable = message.type === "snapshot" || message.type === "input" || (message.type === "rpc" && message.channel === "unreliable");
		this._simulate(unreliable, () => this._handleMessage(message));
	}

	private _handleMessage(message: NetworkServerMessage): void {
		this._record("in", message.type, this._traceDetail(message));
		if (message.type === "welcome") {
			this._clearConnectionTimer();
			this._role = message.role;
			this._sessionId = message.sessionId;
			this._playerId = message.playerId;
			this._reconnectToken = message.reconnectToken;
			this._reconnectAttempt = 0;
			this._lastError = null;
			this._peers = new Map(message.peers.map((peer) => [peer.playerId, { displayName: peer.displayName, role: peer.role }]));
			this._ownership = new Map(Object.entries(message.ownership));
			this._setState("connected");
			if (this._role === "host") {
				this._sendManifest();
			}
			return;
		}
		if (this._state !== "connected") {
			this._record("runtime", "pre-welcome-frame-ignored", { type: message.type });
			return;
		}
		switch (message.type) {
			case "peer-joined":
				this._peers.set(message.playerId, { displayName: message.displayName, role: message.role });
				break;
			case "peer-left":
				this._peers.delete(message.playerId);
				break;
			case "role":
				if (message.playerId === this._playerId) {
					this._role = message.role;
					if (message.role === "host") {
						this._sendManifest();
					}
				}
				if (this._peers.has(message.playerId)) {
					this._peers.set(message.playerId, { ...this._peers.get(message.playerId)!, role: message.role });
				}
				break;
			case "ownership":
				if (message.playerId) {
					this._ownership.set(message.networkId, message.playerId);
				} else {
					this._ownership.delete(message.networkId);
				}
				break;
			case "input":
				this._handleAuthoritativeInput(message);
				break;
			case "snapshot":
				this._handleSnapshot(message);
				break;
			case "rpc":
				this._metrics.rpcsReceived++;
				this.onRpcObservable.notifyObservers({
					sequence: message.sequence,
					name: message.name,
					target: message.target,
					channel: message.channel,
					networkId: message.networkId ?? null,
					payload: clone(message.payload),
					senderId: message.senderId ?? null,
				});
				break;
			case "ping":
				this._send(createNetworkWireMessage({ type: "pong", sequence: message.sequence, sentAt: message.sentAt, serverTime: this._now() }), false);
				break;
			case "pong":
				this._metrics.roundTripTimeMs = Math.max(0, this._now() - message.sentAt);
				break;
			case "error":
				this._lastError = `${message.code}: ${message.message}`;
				break;
			case "claim-ownership":
			case "release-ownership":
				this._record("runtime", "unexpected-server-frame", { type: message.type });
				break;
		}
	}

	private _handleAuthoritativeInput(message: INetworkInputMessage): void {
		if (this._role !== "host" || !message.senderId) {
			return;
		}
		const entry = this._networkNodes.get(message.networkId);
		if (!entry || entry.data.authority !== "owner" || this._ownership.get(message.networkId) !== message.senderId) {
			this._record("runtime", "input-rejected", { networkId: message.networkId, senderId: message.senderId });
			return;
		}
		applyInput(entry.node, message);
		this._acknowledgedInputs.set(message.senderId, Math.max(message.sequence, this._acknowledgedInputs.get(message.senderId) ?? 0));
		this._metrics.inputsReceived++;
	}

	private _handleSnapshot(message: INetworkSnapshotMessage): void {
		if (this._role !== "client") {
			return;
		}
		this._metrics.snapshotsReceived++;
		for (const entity of message.entities) {
			const samples = this._samples.get(entity.networkId) ?? [];
			if (!samples.some((sample) => sample.sequence === message.sequence)) {
				samples.push({ sequence: message.sequence, serverTime: message.serverTime, entity: clone(entity) });
				samples.sort((left, right) => left.serverTime - right.serverTime || left.sequence - right.sequence);
				samples.splice(0, Math.max(0, samples.length - 64));
				this._samples.set(entity.networkId, samples);
			}
			if (entity.ownerId === this._playerId && entity.transform && this._configuration.prediction.enabled) {
				this._reconcile(entity, message.acknowledgedInputs[this._playerId ?? ""] ?? 0);
			}
		}
	}

	private _reconcile(entity: INetworkSnapshotEntity, acknowledgedSequence: number): void {
		const entry = this._networkNodes.get(entity.networkId);
		if (!entry || !entity.transform) {
			return;
		}
		const current = nodeTransform(entry.node);
		const distance = current ? Vector3.Distance(Vector3.FromArray(current.position), Vector3.FromArray(entity.transform.position)) : Number.POSITIVE_INFINITY;
		const history = (this._pendingInputs.get(entity.networkId) ?? []).filter((pending) => pending.message.sequence > acknowledgedSequence);
		this._pendingInputs.set(entity.networkId, history);
		if (distance <= this._configuration.prediction.reconciliationThreshold) {
			return;
		}
		setNodeTransform(entry.node, entity.transform);
		if (this._configuration.prediction.rollbackReplay) {
			for (const pending of history) {
				applyInput(entry.node, pending.message);
			}
		}
		this._metrics.reconciliations++;
		this._record("runtime", "reconciled", { networkId: entity.networkId, distance, acknowledgedSequence, replayedInputs: history.length });
	}

	private _applyRemoteSamples(): void {
		const targetTime = this._now() - this._configuration.replication.interpolationDelayMs;
		for (const [networkId, samples] of this._samples) {
			const entry = this._networkNodes.get(networkId);
			if (!entry || !samples.length || this._ownership.get(networkId) === this._playerId) {
				continue;
			}
			let left = samples[0];
			let right = samples[samples.length - 1];
			for (let index = 0; index < samples.length; index++) {
				if (samples[index].serverTime <= targetTime) {
					left = samples[index];
				}
				if (samples[index].serverTime >= targetTime) {
					right = samples[index];
					break;
				}
			}
			let transform: INetworkTransformState | null = right.entity.transform ? clone(right.entity.transform) : null;
			if (entry.data.interpolate && left !== right && left.entity.transform && right.entity.transform) {
				const amount = Math.min(1, Math.max(0, (targetTime - left.serverTime) / Math.max(1, right.serverTime - left.serverTime)));
				transform = interpolateTransform(left.entity.transform, right.entity.transform, amount);
			} else if (
				entry.data.interpolate &&
				targetTime > right.serverTime &&
				samples.length > 1 &&
				targetTime - right.serverTime <= this._configuration.replication.maximumExtrapolationMs
			) {
				transform = extrapolateTransform(samples[samples.length - 2], right, targetTime);
			}
			if (entry.data.syncTransform && transform) {
				setNodeTransform(entry.node, transform);
			}
			if (entry.data.syncAnimation) {
				this._applyAnimations(right.entity.animations);
			}
		}
	}

	private _sendSnapshot(): void {
		const now = this._now();
		const entities: INetworkSnapshotEntity[] = [];
		for (const [networkId, entry] of this._networkNodes) {
			const previous = this._lastEntitySend.get(networkId) ?? Number.NEGATIVE_INFINITY;
			if (now - previous < 1_000 / entry.data.sendRateHz) {
				continue;
			}
			this._lastEntitySend.set(networkId, now);
			entities.push({
				networkId,
				ownerId: this._ownership.get(networkId) ?? null,
				transform: entry.data.syncTransform ? nodeTransform(entry.node) : null,
				animations: entry.data.syncAnimation ? this._captureAnimations(entry.node) : [],
			});
		}
		if (!entities.length) {
			return;
		}
		const acknowledgements = Object.fromEntries(this._acknowledgedInputs);
		const maximumBytes = Math.min(262_144, this._configuration.transport.maximumMessageBytes);
		const envelopeBytes =
			new TextEncoder().encode(JSON.stringify({ type: "snapshot", tick: this._tick, serverTime: now, acknowledgedInputs: acknowledgements, entities: [] })).byteLength + 256;
		let chunk: INetworkSnapshotEntity[] = [];
		let chunkBytes = envelopeBytes;
		for (const entity of entities) {
			const entityBytes = new TextEncoder().encode(JSON.stringify(entity)).byteLength + 1;
			if (entityBytes + envelopeBytes > maximumBytes) {
				this._record("runtime", "snapshot-entity-skipped", { networkId: entity.networkId, bytes: entityBytes, maximumBytes });
				continue;
			}
			if (chunk.length && chunkBytes + entityBytes > maximumBytes) {
				this._sendSnapshotChunk(chunk, acknowledgements, now);
				chunk = [];
				chunkBytes = envelopeBytes;
			}
			chunk.push(entity);
			chunkBytes += entityBytes;
		}
		if (chunk.length) {
			this._sendSnapshotChunk(chunk, acknowledgements, now);
		}
	}

	/** Sends one pre-budgeted snapshot chunk without leaking validation failures into the render loop. */
	private _sendSnapshotChunk(entities: INetworkSnapshotEntity[], acknowledgedInputs: Record<string, number>, serverTime: number): void {
		try {
			const message = createNetworkWireMessage({
				type: "snapshot",
				sequence: ++this._outgoingSequence,
				tick: this._tick,
				serverTime,
				acknowledgedInputs,
				entities,
			});
			this._metrics.snapshotsSent++;
			this._send(message, true);
		} catch (error) {
			this._lastError = safeError(error);
			this._record("runtime", "snapshot-rejected", { entityCount: entities.length, error: this._lastError });
		}
	}

	private _captureAnimations(node: Node): INetworkSnapshotEntity["animations"] {
		return this._scene.animationGroups
			.filter((group) => Boolean(group.name.trim()) && group.name.length <= 256 && group.targetedAnimations.some((animation) => animation.target === node))
			.slice(0, 128)
			.map((group) => ({
				name: group.name,
				playing: group.isStarted,
				loop: group.loopAnimation,
				currentFrame: Number.isFinite(group.animatables[0]?.masterFrame) ? group.animatables[0].masterFrame : Number.isFinite(group.from) ? group.from : 0,
				speedRatio: Number.isFinite(group.speedRatio) ? group.speedRatio : 1,
			}));
	}

	private _applyAnimations(states: INetworkSnapshotEntity["animations"]): void {
		for (const state of states) {
			const group = this._scene.animationGroups.find((candidate) => candidate.name === state.name);
			if (!group) {
				continue;
			}
			group.speedRatio = state.speedRatio;
			group.loopAnimation = state.loop;
			if (state.playing && !group.isStarted) {
				group.start(state.loop, state.speedRatio, group.from, group.to);
			} else if (!state.playing && group.isStarted) {
				group.stop();
			}
			if (state.playing) {
				group.goToFrame(state.currentFrame);
			}
		}
	}

	private _send(message: NetworkClientMessage, unreliable: boolean): void {
		this._simulate(unreliable, () => this._sendNow(message));
	}

	private _sendNow(message: NetworkClientMessage): void {
		if (!this._socket || this._socket.readyState !== socketOpen) {
			this._record("runtime", "send-skipped", { type: message.type, reason: "socket-not-open" });
			return;
		}
		const data = JSON.stringify(message);
		const bytes = new TextEncoder().encode(data).byteLength;
		if (bytes > this._configuration.transport.maximumMessageBytes) {
			this._lastError = `Networking ${message.type} frame exceeds the configured byte limit.`;
			this._record("runtime", "send-rejected", { type: message.type, bytes });
			return;
		}
		try {
			this._socket.send(data);
			this._metrics.messagesSent++;
			this._metrics.bytesSent += bytes;
			this._record("out", message.type, this._traceDetail(message));
		} catch (error) {
			this._lastError = safeError(error);
			this._record("runtime", "send-failed", { type: message.type, error: this._lastError });
		}
	}

	private _simulate(unreliable: boolean, action: () => void): void {
		const simulation = this._configuration.simulation;
		if (!simulation.enabled) {
			action();
			return;
		}
		if (unreliable && this._random() * 100 < simulation.packetLossPercent) {
			this._metrics.packetsSimulatedLost++;
			return;
		}
		const jitter = simulation.jitterMs ? (this._random() * 2 - 1) * simulation.jitterMs : 0;
		const reorder = unreliable && this._random() * 100 < simulation.packetReorderPercent ? simulation.latencyMs + simulation.jitterMs : 0;
		const delay = Math.max(0, simulation.latencyMs + jitter + reorder);
		if (delay <= 0) {
			action();
			return;
		}
		const timer = setTimeout(() => {
			this._simulationTimers.delete(timer);
			if (!this._disposed) {
				action();
			}
		}, delay);
		this._simulationTimers.add(timer);
	}

	private _refreshNetworkNodes(): void {
		const nodes = new Map<string, INetworkNode>();
		const duplicateNetworkIds = new Set<string>();
		for (const node of this._scene.getNodes()) {
			const data = getNetworkComponentData(node);
			if (!data || !data.networkId || nodes.has(data.networkId)) {
				if (data?.networkId && nodes.has(data.networkId) && !this._duplicateNetworkIds.has(data.networkId)) {
					this._record("runtime", "duplicate-network-id", { networkId: data.networkId, nodeId: node.id });
				}
				if (data?.networkId && nodes.has(data.networkId)) {
					duplicateNetworkIds.add(data.networkId);
				}
				continue;
			}
			nodes.set(data.networkId, { node, data });
			if (nodes.size >= 4_096) {
				break;
			}
		}
		this._networkNodes = nodes;
		this._duplicateNetworkIds = duplicateNetworkIds;
		const fingerprint = [...nodes.entries()]
			.map(([networkId, entry]) => `${networkId}:${entry.data.authority}`)
			.sort()
			.join("|");
		if (fingerprint !== this._manifestFingerprint) {
			this._manifestFingerprint = fingerprint;
			if (this._role === "host" && this._state === "connected") {
				this._sendManifest();
			}
		}
		for (const networkId of this._samples.keys()) {
			if (!nodes.has(networkId)) {
				this._samples.delete(networkId);
				this._pendingInputs.delete(networkId);
				this._lastEntitySend.delete(networkId);
			}
		}
	}

	/** Publishes only object ids and authority modes so the relay can reject invalid claims. */
	private _sendManifest(): void {
		this._send(
			createNetworkWireMessage({
				type: "manifest",
				objects: [...this._networkNodes.entries()].map(([networkId, entry]) => ({ networkId, authority: entry.data.authority })),
			}),
			false
		);
	}

	private _requireNetworkNode(networkId: string): INetworkNode {
		if (!identifierPattern.test(networkId)) {
			throw new Error("Networking networkId is invalid.");
		}
		this._refreshNetworkNodes();
		const entry = this._networkNodes.get(networkId);
		if (!entry) {
			throw new Error(`Network object not found: ${networkId}.`);
		}
		return entry;
	}

	private _requireConnected(): void {
		if (this._state !== "connected" || !this._playerId || !this._role) {
			throw new Error("Networking runtime is not connected.");
		}
	}

	private _scheduleReconnect(): void {
		if (this._disposed || this._manualDisconnect || !this._configuration.transport.reconnect || this._reconnectTimer) {
			return;
		}
		const delay = Math.min(10_000, 500 * 2 ** Math.min(this._reconnectAttempt++, 5));
		this._setState("reconnecting");
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			this._metrics.reconnects++;
			this._openSocket(true);
		}, delay);
	}

	private _clearReconnectTimer(): void {
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
	}

	private _clearConnectionTimer(): void {
		if (this._connectionTimer) {
			clearTimeout(this._connectionTimer);
			this._connectionTimer = null;
		}
	}

	private _clearSimulationTimers(): void {
		for (const timer of this._simulationTimers) {
			clearTimeout(timer);
		}
		this._simulationTimers.clear();
	}

	private _setState(state: NetworkingConnectionState): void {
		this._state = state;
		this.onStateChangedObservable.notifyObservers(this.status());
	}

	private _traceDetail(message: NetworkClientMessage | NetworkServerMessage): Record<string, unknown> {
		switch (message.type) {
			case "hello":
				return {
					clientId: message.clientId,
					displayName: message.displayName,
					hasJoinCode: Boolean(message.joinCode),
					hasHostToken: Boolean(message.hostToken),
					reconnect: Boolean(message.reconnectToken),
				};
			case "welcome":
				return { sessionId: message.sessionId, playerId: message.playerId, role: message.role, peerCount: message.peers.length };
			case "snapshot":
				return { sequence: message.sequence, tick: message.tick, entityCount: message.entities.length };
			case "input":
				return { sequence: message.sequence, tick: message.tick, networkId: message.networkId, senderId: message.senderId ?? null };
			case "rpc":
				return {
					sequence: message.sequence,
					name: message.name,
					target: message.target,
					channel: message.channel,
					networkId: message.networkId ?? null,
					senderId: message.senderId ?? null,
				};
			case "ownership":
			case "claim-ownership":
			case "release-ownership":
				return { networkId: message.networkId, playerId: message.playerId ?? null };
			case "peer-joined":
			case "peer-left":
				return { playerId: message.playerId, displayName: message.displayName, role: message.role };
			case "role":
				return { playerId: message.playerId, role: message.role };
			case "manifest":
				return { objectCount: message.objects.length };
			case "ping":
			case "pong":
				return { sequence: message.sequence };
			case "error":
				return { code: message.code, message: message.message };
		}
	}

	private _record(direction: INetworkingRuntimeTraceEvent["direction"], type: string, detail: Record<string, unknown>): void {
		this._trace.push({ sequence: ++this._traceSequence, capturedAt: new Date(this._now()).toISOString(), direction, type, detail: clone(detail) });
		this._trace.splice(0, Math.max(0, this._trace.length - this._configuration.maximumTraceEvents));
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		networkingRuntime?: NetworkingRuntime;
	}
}

/** Creates one enabled scene runtime and replaces any prior runtime cleanly. */
export function configureNetworking(scene: Scene, options: INetworkingRuntimeOptions = {}): NetworkingRuntime | null {
	const configuration = options.configuration ?? getSceneNetworkingConfiguration(scene, false);
	const previous = runtimes.get(scene);
	previous?.dispose();
	if (!configuration.enabled) {
		runtimes.delete(scene);
		return null;
	}
	const runtime = new NetworkingRuntime(scene, { ...options, configuration });
	runtimes.set(scene, runtime);
	scene.networkingRuntime = runtime;
	if (configuration.transport.autoConnect && configuration.transport.endpoint) {
		runtime.connect();
	}
	return runtime;
}

/** Returns the current scene runtime without creating transport state. */
export function getNetworkingRuntime(scene: Scene): NetworkingRuntime | null {
	return runtimes.get(scene) ?? scene.networkingRuntime ?? null;
}
