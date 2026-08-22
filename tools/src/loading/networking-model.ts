/**
 * Portable multiplayer authoring and wire contracts shared by the editor,
 * exported players, local session host, and external automation.
 */

export const NETWORKING_CONFIGURATION_VERSION = 1 as const;
export const NETWORKING_PROTOCOL_VERSION = 1 as const;
export const NETWORKING_PROTOCOL_NAME = "zvibe-gameplay" as const;

export type NetworkingTopology = "client-server";
export type NetworkingTransportMode = "websocket";
export type NetworkingPeerRole = "host" | "client";
export type NetworkingConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";
export type NetworkingChannel = "reliable" | "unreliable";
export type NetworkingRpcTarget = "server" | "all" | "owner";

export interface INetworkingTransportConfiguration {
	mode: NetworkingTransportMode;
	endpoint: string | null;
	autoConnect: boolean;
	reconnect: boolean;
	connectionTimeoutMs: number;
	maximumMessageBytes: number;
}

export interface INetworkingReplicationConfiguration {
	tickRateHz: number;
	snapshotRateHz: number;
	interpolationDelayMs: number;
	maximumExtrapolationMs: number;
	positionEpsilon: number;
	rotationEpsilonDegrees: number;
}

export interface INetworkingPredictionConfiguration {
	enabled: boolean;
	rollbackReplay: boolean;
	historySize: number;
	reconciliationThreshold: number;
}

export interface INetworkingSimulationConfiguration {
	enabled: boolean;
	latencyMs: number;
	jitterMs: number;
	packetLossPercent: number;
	packetReorderPercent: number;
	seed: number;
}

export interface INetworkingSessionConfiguration {
	maximumPlayers: number;
	reconnectGraceMs: number;
	allowHostMigration: boolean;
	publicLobby: boolean;
}

export interface IEditorNetworkingConfiguration {
	version: typeof NETWORKING_CONFIGURATION_VERSION;
	revision: number;
	enabled: boolean;
	topology: NetworkingTopology;
	transport: INetworkingTransportConfiguration;
	replication: INetworkingReplicationConfiguration;
	prediction: INetworkingPredictionConfiguration;
	simulation: INetworkingSimulationConfiguration;
	session: INetworkingSessionConfiguration;
	maximumTraceEvents: number;
}

export interface INetworkingConfigurationMigrationResult {
	configuration: IEditorNetworkingConfiguration;
	migrated: boolean;
	sourceVersion: number;
}

export interface INetworkingMetadataHost {
	metadata?: Record<string, unknown> | null;
}

export interface INetworkTransformState {
	position: [number, number, number];
	rotationQuaternion: [number, number, number, number];
	scaling: [number, number, number];
}

export interface INetworkAnimationState {
	name: string;
	playing: boolean;
	loop: boolean;
	currentFrame: number;
	speedRatio: number;
}

export interface INetworkSnapshotEntity {
	networkId: string;
	ownerId: string | null;
	transform: INetworkTransformState | null;
	animations: INetworkAnimationState[];
}

export interface INetworkHelloMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "hello";
	clientId: string;
	displayName: string;
	joinCode?: string;
	hostToken?: string;
	reconnectToken?: string;
}

export interface INetworkWelcomeMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "welcome";
	sessionId: string;
	playerId: string;
	role: NetworkingPeerRole;
	reconnectToken: string;
	serverTime: number;
	peers: Array<{ playerId: string; displayName: string; role: NetworkingPeerRole }>;
	ownership: Record<string, string>;
}

export interface INetworkPeerMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "peer-joined" | "peer-left";
	playerId: string;
	displayName: string;
	role: NetworkingPeerRole;
}

export interface INetworkRoleMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "role";
	playerId: string;
	role: NetworkingPeerRole;
}

export interface INetworkManifestMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "manifest";
	objects: Array<{ networkId: string; authority: "server" | "owner" }>;
}

export interface INetworkOwnershipMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "claim-ownership" | "release-ownership" | "ownership";
	networkId: string;
	playerId?: string | null;
}

export interface INetworkInputMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "input";
	sequence: number;
	tick: number;
	networkId: string;
	translation: [number, number, number];
	rotationDegrees: [number, number, number];
	/** Added by the trusted session host when relaying input to authority. */
	senderId?: string;
}

export interface INetworkSnapshotMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "snapshot";
	sequence: number;
	tick: number;
	serverTime: number;
	acknowledgedInputs: Record<string, number>;
	entities: INetworkSnapshotEntity[];
}

export interface INetworkRpcMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "rpc";
	sequence: number;
	name: string;
	target: NetworkingRpcTarget;
	channel: NetworkingChannel;
	networkId?: string;
	payload: unknown;
	senderId?: string;
}

export interface INetworkPingMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "ping" | "pong";
	sequence: number;
	sentAt: number;
	serverTime?: number;
}

export interface INetworkErrorMessage {
	protocol: typeof NETWORKING_PROTOCOL_NAME;
	version: typeof NETWORKING_PROTOCOL_VERSION;
	type: "error";
	code: string;
	message: string;
}

export type NetworkClientMessage =
	| INetworkHelloMessage
	| INetworkInputMessage
	| INetworkOwnershipMessage
	| INetworkRpcMessage
	| INetworkPingMessage
	| INetworkSnapshotMessage
	| INetworkManifestMessage;
export type NetworkServerMessage =
	| INetworkWelcomeMessage
	| INetworkPeerMessage
	| INetworkRoleMessage
	| INetworkOwnershipMessage
	| INetworkInputMessage
	| INetworkSnapshotMessage
	| INetworkRpcMessage
	| INetworkPingMessage
	| INetworkErrorMessage;
export type NetworkWireMessage = NetworkClientMessage | NetworkServerMessage;
export type NetworkWirePayload = NetworkWireMessage extends infer T ? (T extends NetworkWireMessage ? Omit<T, "protocol" | "version"> : never) : never;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const joinCodePattern = /^[A-Z0-9]{6,12}$/;
const tokenPattern = /^[A-Za-z0-9_-]{24,256}$/;

/** Returns a complete disabled configuration with conservative web defaults. */
export function createDefaultNetworkingConfiguration(): IEditorNetworkingConfiguration {
	return {
		version: NETWORKING_CONFIGURATION_VERSION,
		revision: 1,
		enabled: false,
		topology: "client-server",
		transport: { mode: "websocket", endpoint: null, autoConnect: false, reconnect: true, connectionTimeoutMs: 10_000, maximumMessageBytes: 262_144 },
		replication: { tickRateHz: 60, snapshotRateHz: 20, interpolationDelayMs: 100, maximumExtrapolationMs: 250, positionEpsilon: 0.01, rotationEpsilonDegrees: 0.1 },
		prediction: { enabled: true, rollbackReplay: true, historySize: 128, reconciliationThreshold: 2 },
		simulation: { enabled: false, latencyMs: 0, jitterMs: 0, packetLossPercent: 0, packetReorderPercent: 0, seed: 1 },
		session: { maximumPlayers: 4, reconnectGraceMs: 15_000, allowHostMigration: true, publicLobby: false },
		maximumTraceEvents: 2_000,
	};
}

/** Guards untrusted JSON objects without accepting arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prevents callers from mutating persisted configuration through aliases. */
function clone<T>(value: T): T {
	return structuredClone(value);
}

/** Requires exactly the documented fields for current-version nested data. */
function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !keys.includes(key));
	const missing = keys.filter((key) => !(key in value));
	if (unknown.length || missing.length) {
		throw new Error(`${label} fields are invalid${unknown.length ? `; unknown: ${unknown.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`);
	}
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean.`);
	}
}

function assertInteger(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
}

function assertNumber(value: unknown, minimum: number, maximum: number, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}.`);
	}
}

function validateEndpoint(value: unknown): void {
	if (value === null) {
		return;
	}
	if (typeof value !== "string" || value.length > 2_048) {
		throw new Error("Networking transport endpoint must be null or a URL no longer than 2048 characters.");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Networking transport endpoint must be an absolute ws:// or wss:// URL.");
	}
	if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("Networking transport endpoint must use ws:// or wss:// without credentials, query parameters, or a fragment.");
	}
	const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
	if (url.protocol === "ws:" && !loopback) {
		throw new Error("Insecure ws:// networking endpoints are allowed only on loopback; use wss:// for remote hosts.");
	}
}

/** Validates the complete current-version authoring state before persistence or runtime use. */
export function validateNetworkingConfiguration(configuration: IEditorNetworkingConfiguration): void {
	if (!isRecord(configuration)) {
		throw new Error("Networking configuration must be an object.");
	}
	assertExactKeys(
		configuration,
		["version", "revision", "enabled", "topology", "transport", "replication", "prediction", "simulation", "session", "maximumTraceEvents"],
		"Networking configuration"
	);
	if (configuration.version !== NETWORKING_CONFIGURATION_VERSION) {
		throw new Error(`Unsupported networking configuration version: ${String(configuration.version)}.`);
	}
	assertInteger(configuration.revision, 1, Number.MAX_SAFE_INTEGER, "Networking revision");
	assertBoolean(configuration.enabled, "Networking enabled");
	if (configuration.topology !== "client-server") {
		throw new Error("Networking topology must be client-server.");
	}

	if (!isRecord(configuration.transport)) {
		throw new Error("Networking transport must be an object.");
	}
	assertExactKeys(configuration.transport, ["mode", "endpoint", "autoConnect", "reconnect", "connectionTimeoutMs", "maximumMessageBytes"], "Networking transport");
	if (configuration.transport.mode !== "websocket") {
		throw new Error("Networking transport mode must be websocket.");
	}
	validateEndpoint(configuration.transport.endpoint);
	assertBoolean(configuration.transport.autoConnect, "Networking transport autoConnect");
	assertBoolean(configuration.transport.reconnect, "Networking transport reconnect");
	assertInteger(configuration.transport.connectionTimeoutMs, 250, 120_000, "Networking transport connectionTimeoutMs");
	assertInteger(configuration.transport.maximumMessageBytes, 1_024, 4 * 1024 * 1024, "Networking transport maximumMessageBytes");

	if (!isRecord(configuration.replication)) {
		throw new Error("Networking replication must be an object.");
	}
	assertExactKeys(
		configuration.replication,
		["tickRateHz", "snapshotRateHz", "interpolationDelayMs", "maximumExtrapolationMs", "positionEpsilon", "rotationEpsilonDegrees"],
		"Networking replication"
	);
	assertInteger(configuration.replication.tickRateHz, 1, 240, "Networking tickRateHz");
	assertInteger(configuration.replication.snapshotRateHz, 1, 120, "Networking snapshotRateHz");
	if (configuration.replication.snapshotRateHz > configuration.replication.tickRateHz) {
		throw new Error("Networking snapshotRateHz cannot exceed tickRateHz.");
	}
	assertInteger(configuration.replication.interpolationDelayMs, 0, 2_000, "Networking interpolationDelayMs");
	assertInteger(configuration.replication.maximumExtrapolationMs, 0, 2_000, "Networking maximumExtrapolationMs");
	assertNumber(configuration.replication.positionEpsilon, 0, 1_000, "Networking positionEpsilon");
	assertNumber(configuration.replication.rotationEpsilonDegrees, 0, 180, "Networking rotationEpsilonDegrees");

	if (!isRecord(configuration.prediction)) {
		throw new Error("Networking prediction must be an object.");
	}
	assertExactKeys(configuration.prediction, ["enabled", "rollbackReplay", "historySize", "reconciliationThreshold"], "Networking prediction");
	assertBoolean(configuration.prediction.enabled, "Networking prediction enabled");
	assertBoolean(configuration.prediction.rollbackReplay, "Networking prediction rollbackReplay");
	assertInteger(configuration.prediction.historySize, 8, 2_048, "Networking prediction historySize");
	assertNumber(configuration.prediction.reconciliationThreshold, 0, 10_000, "Networking prediction reconciliationThreshold");

	if (!isRecord(configuration.simulation)) {
		throw new Error("Networking simulation must be an object.");
	}
	assertExactKeys(configuration.simulation, ["enabled", "latencyMs", "jitterMs", "packetLossPercent", "packetReorderPercent", "seed"], "Networking simulation");
	assertBoolean(configuration.simulation.enabled, "Networking simulation enabled");
	assertInteger(configuration.simulation.latencyMs, 0, 10_000, "Networking simulation latencyMs");
	assertInteger(configuration.simulation.jitterMs, 0, 10_000, "Networking simulation jitterMs");
	assertNumber(configuration.simulation.packetLossPercent, 0, 100, "Networking simulation packetLossPercent");
	assertNumber(configuration.simulation.packetReorderPercent, 0, 100, "Networking simulation packetReorderPercent");
	assertInteger(configuration.simulation.seed, 0, 2_147_483_647, "Networking simulation seed");

	if (!isRecord(configuration.session)) {
		throw new Error("Networking session must be an object.");
	}
	assertExactKeys(configuration.session, ["maximumPlayers", "reconnectGraceMs", "allowHostMigration", "publicLobby"], "Networking session");
	assertInteger(configuration.session.maximumPlayers, 1, 64, "Networking session maximumPlayers");
	assertInteger(configuration.session.reconnectGraceMs, 0, 300_000, "Networking session reconnectGraceMs");
	assertBoolean(configuration.session.allowHostMigration, "Networking session allowHostMigration");
	assertBoolean(configuration.session.publicLobby, "Networking session publicLobby");
	assertInteger(configuration.maximumTraceEvents, 16, 10_000, "Networking maximumTraceEvents");
}

/** Reads absent metadata as defaults and rejects malformed or future persisted state. */
export function normalizeNetworkingConfiguration(value: unknown): INetworkingConfigurationMigrationResult {
	if (value === undefined || value === null) {
		return { configuration: createDefaultNetworkingConfiguration(), migrated: true, sourceVersion: 0 };
	}
	if (!isRecord(value)) {
		throw new Error("Persisted networking configuration must be an object.");
	}
	const candidate = clone(value) as unknown as IEditorNetworkingConfiguration;
	validateNetworkingConfiguration(candidate);
	return { configuration: candidate, migrated: false, sourceVersion: NETWORKING_CONFIGURATION_VERSION };
}

/** Reads and optionally persists the canonical scene networking configuration. */
export function getSceneNetworkingConfiguration(scene: INetworkingMetadataHost, persist = true): IEditorNetworkingConfiguration {
	const metadata = isRecord(scene.metadata) ? scene.metadata : {};
	const result = normalizeNetworkingConfiguration(metadata.babylonEditorNetworking);
	if (persist) {
		scene.metadata = metadata;
		metadata.babylonEditorNetworking = clone(result.configuration);
	}
	return clone(result.configuration);
}

/** Replaces scene networking metadata only after complete validation. */
export function setSceneNetworkingConfiguration(scene: INetworkingMetadataHost, configuration: IEditorNetworkingConfiguration): IEditorNetworkingConfiguration {
	validateNetworkingConfiguration(configuration);
	const metadata = isRecord(scene.metadata) ? scene.metadata : {};
	scene.metadata = metadata;
	metadata.babylonEditorNetworking = clone(configuration);
	return clone(configuration);
}

function validIdentifier(value: unknown): value is string {
	return typeof value === "string" && identifierPattern.test(value);
}

function validTuple(value: unknown, length: 3 | 4, maximumMagnitude = 1_000_000): boolean {
	return Array.isArray(value) && value.length === length && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && Math.abs(entry) <= maximumMagnitude);
}

function validTransform(value: unknown): value is INetworkTransformState {
	const rotation = isRecord(value) && validTuple(value.rotationQuaternion, 4) ? (value.rotationQuaternion as [number, number, number, number]) : null;
	const rotationMagnitude = rotation ? Math.sqrt(rotation.reduce((total, component) => total + component * component, 0)) : 0;
	return (
		isRecord(value) &&
		validTuple(value.position, 3) &&
		Boolean(rotation) &&
		rotationMagnitude >= 0.5 &&
		rotationMagnitude <= 1.5 &&
		validTuple(value.scaling, 3) &&
		Object.keys(value).every((key) => ["position", "rotationQuaternion", "scaling"].includes(key))
	);
}

function validJson(value: unknown, depth = 0, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return typeof value !== "string" || value.length <= 16_384;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (typeof value !== "object" || depth >= 8 || seen.has(value)) {
		return false;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value.length <= 256 && value.every((entry) => validJson(entry, depth + 1, seen));
	}
	const entries = Object.entries(value as Record<string, unknown>);
	return entries.length <= 256 && entries.every(([key, entry]) => key.length <= 256 && validJson(entry, depth + 1, seen));
}

/** Validates and parses one bounded protocol frame without trusting its sender. */
export function parseNetworkWireMessage(value: unknown, maximumBytes = 262_144): NetworkWireMessage {
	assertInteger(maximumBytes, 1_024, 4 * 1024 * 1024, "Networking maximum frame bytes");
	let message: unknown = value;
	if (typeof value === "string") {
		if (new TextEncoder().encode(value).byteLength > maximumBytes) {
			throw new Error("Networking frame exceeds the configured byte limit.");
		}
		try {
			message = JSON.parse(value);
		} catch {
			throw new Error("Networking frame contains malformed JSON.");
		}
	} else {
		let encoded: string;
		try {
			encoded = JSON.stringify(value);
		} catch {
			throw new Error("Networking frame must be JSON serializable.");
		}
		if (new TextEncoder().encode(encoded).byteLength > maximumBytes) {
			throw new Error("Networking frame exceeds the configured byte limit.");
		}
	}
	if (!isRecord(message) || message.protocol !== NETWORKING_PROTOCOL_NAME || message.version !== NETWORKING_PROTOCOL_VERSION || typeof message.type !== "string") {
		throw new Error("Networking frame protocol or version is invalid.");
	}
	const keys = Object.keys(message);
	const exact = (allowed: readonly string[]): void => {
		if (keys.some((key) => !allowed.includes(key))) {
			throw new Error(`Networking ${String(message && (message as Record<string, unknown>).type)} frame contains unknown fields.`);
		}
	};
	const sequence = (label: string): void => assertInteger(message && (message as Record<string, unknown>)[label], 0, Number.MAX_SAFE_INTEGER, `Networking ${label}`);
	const frame = message as Record<string, unknown>;
	switch (frame.type) {
		case "hello":
			exact(["protocol", "version", "type", "clientId", "displayName", "joinCode", "hostToken", "reconnectToken"]);
			if (!validIdentifier(frame.clientId) || typeof frame.displayName !== "string" || !frame.displayName.trim() || frame.displayName.length > 80) {
				throw new Error("Networking hello identity is invalid.");
			}
			if (frame.joinCode !== undefined && (typeof frame.joinCode !== "string" || !joinCodePattern.test(frame.joinCode))) {
				throw new Error("Networking joinCode is invalid.");
			}
			for (const key of ["hostToken", "reconnectToken"] as const) {
				if (frame[key] !== undefined && (typeof frame[key] !== "string" || !tokenPattern.test(frame[key] as string))) {
					throw new Error(`Networking ${key} is invalid.`);
				}
			}
			break;
		case "welcome":
			exact(["protocol", "version", "type", "sessionId", "playerId", "role", "reconnectToken", "serverTime", "peers", "ownership"]);
			if (
				!validIdentifier(frame.sessionId) ||
				!validIdentifier(frame.playerId) ||
				!["host", "client"].includes(String(frame.role)) ||
				typeof frame.reconnectToken !== "string" ||
				!tokenPattern.test(frame.reconnectToken)
			) {
				throw new Error("Networking welcome identity is invalid.");
			}
			assertNumber(frame.serverTime, 0, Number.MAX_SAFE_INTEGER, "Networking serverTime");
			if (
				!Array.isArray(frame.peers) ||
				frame.peers.length > 64 ||
				frame.peers.some(
					(peer) =>
						!isRecord(peer) ||
						!validIdentifier(peer.playerId) ||
						typeof peer.displayName !== "string" ||
						!peer.displayName.trim() ||
						peer.displayName.length > 80 ||
						!["host", "client"].includes(String(peer.role)) ||
						Object.keys(peer).some((key) => !["playerId", "displayName", "role"].includes(key))
				)
			) {
				throw new Error("Networking welcome peers are invalid.");
			}
			if (new Set((frame.peers as Array<{ playerId: string }>).map((peer) => peer.playerId)).size !== frame.peers.length) {
				throw new Error("Networking welcome peers contain duplicate player ids.");
			}
			if (
				!isRecord(frame.ownership) ||
				Object.keys(frame.ownership).length > 4_096 ||
				Object.entries(frame.ownership).some(([networkId, playerId]) => !identifierPattern.test(networkId) || !validIdentifier(playerId))
			) {
				throw new Error("Networking welcome ownership is invalid.");
			}
			break;
		case "peer-joined":
		case "peer-left":
			exact(["protocol", "version", "type", "playerId", "displayName", "role"]);
			if (
				!validIdentifier(frame.playerId) ||
				typeof frame.displayName !== "string" ||
				!frame.displayName.trim() ||
				frame.displayName.length > 80 ||
				!["host", "client"].includes(String(frame.role))
			) {
				throw new Error("Networking peer frame is invalid.");
			}
			break;
		case "role":
			exact(["protocol", "version", "type", "playerId", "role"]);
			if (!validIdentifier(frame.playerId) || !["host", "client"].includes(String(frame.role))) {
				throw new Error("Networking role frame is invalid.");
			}
			break;
		case "manifest":
			exact(["protocol", "version", "type", "objects"]);
			if (
				!Array.isArray(frame.objects) ||
				frame.objects.length > 4_096 ||
				frame.objects.some(
					(entry) =>
						!isRecord(entry) ||
						!validIdentifier(entry.networkId) ||
						!["server", "owner"].includes(String(entry.authority)) ||
						Object.keys(entry).some((key) => !["networkId", "authority"].includes(key))
				) ||
				new Set((frame.objects as Array<{ networkId: string }>).map((entry) => entry.networkId)).size !== frame.objects.length
			) {
				throw new Error("Networking manifest is invalid.");
			}
			break;
		case "claim-ownership":
		case "release-ownership":
		case "ownership":
			exact(["protocol", "version", "type", "networkId", "playerId"]);
			if (!validIdentifier(frame.networkId) || (frame.playerId !== undefined && frame.playerId !== null && !validIdentifier(frame.playerId))) {
				throw new Error("Networking ownership frame is invalid.");
			}
			break;
		case "input":
			exact(["protocol", "version", "type", "sequence", "tick", "networkId", "translation", "rotationDegrees", "senderId"]);
			sequence("sequence");
			sequence("tick");
			if (
				!validIdentifier(frame.networkId) ||
				!validTuple(frame.translation, 3, 100_000) ||
				!validTuple(frame.rotationDegrees, 3, 3_600) ||
				(frame.senderId !== undefined && !validIdentifier(frame.senderId))
			) {
				throw new Error("Networking input frame is invalid.");
			}
			break;
		case "snapshot":
			exact(["protocol", "version", "type", "sequence", "tick", "serverTime", "acknowledgedInputs", "entities"]);
			sequence("sequence");
			sequence("tick");
			assertNumber(frame.serverTime, 0, Number.MAX_SAFE_INTEGER, "Networking serverTime");
			if (
				!isRecord(frame.acknowledgedInputs) ||
				Object.keys(frame.acknowledgedInputs).length > 64 ||
				Object.entries(frame.acknowledgedInputs).some(
					([playerId, inputSequence]) => !identifierPattern.test(playerId) || !Number.isSafeInteger(inputSequence) || (inputSequence as number) < 0
				)
			) {
				throw new Error("Networking snapshot acknowledgements are invalid.");
			}
			if (
				!Array.isArray(frame.entities) ||
				frame.entities.length > 4_096 ||
				frame.entities.some(
					(entity) =>
						!isRecord(entity) ||
						!validIdentifier(entity.networkId) ||
						(entity.ownerId !== null && !validIdentifier(entity.ownerId)) ||
						(entity.transform !== null && !validTransform(entity.transform)) ||
						!Array.isArray(entity.animations) ||
						entity.animations.length > 128 ||
						entity.animations.some(
							(animation) =>
								!isRecord(animation) ||
								typeof animation.name !== "string" ||
								!animation.name.trim() ||
								animation.name.length > 256 ||
								typeof animation.playing !== "boolean" ||
								typeof animation.loop !== "boolean" ||
								typeof animation.currentFrame !== "number" ||
								!Number.isFinite(animation.currentFrame) ||
								typeof animation.speedRatio !== "number" ||
								!Number.isFinite(animation.speedRatio) ||
								Object.keys(animation).some((key) => !["name", "playing", "loop", "currentFrame", "speedRatio"].includes(key))
						) ||
						Object.keys(entity).some((key) => !["networkId", "ownerId", "transform", "animations"].includes(key))
				)
			) {
				throw new Error("Networking snapshot entities are invalid.");
			}
			if (new Set((frame.entities as INetworkSnapshotEntity[]).map((entity) => entity.networkId)).size !== frame.entities.length) {
				throw new Error("Networking snapshot contains duplicate network ids.");
			}
			break;
		case "rpc":
			exact(["protocol", "version", "type", "sequence", "name", "target", "channel", "networkId", "payload", "senderId"]);
			sequence("sequence");
			if (
				!validIdentifier(frame.name) ||
				!["server", "all", "owner"].includes(String(frame.target)) ||
				!["reliable", "unreliable"].includes(String(frame.channel)) ||
				(frame.networkId !== undefined && !validIdentifier(frame.networkId)) ||
				(frame.senderId !== undefined && !validIdentifier(frame.senderId)) ||
				!validJson(frame.payload)
			) {
				throw new Error("Networking RPC frame is invalid.");
			}
			break;
		case "ping":
		case "pong":
			exact(["protocol", "version", "type", "sequence", "sentAt", "serverTime"]);
			sequence("sequence");
			assertNumber(frame.sentAt, 0, Number.MAX_SAFE_INTEGER, "Networking sentAt");
			if (frame.serverTime !== undefined) {
				assertNumber(frame.serverTime, 0, Number.MAX_SAFE_INTEGER, "Networking serverTime");
			}
			break;
		case "error":
			exact(["protocol", "version", "type", "code", "message"]);
			if (!validIdentifier(frame.code) || typeof frame.message !== "string" || !frame.message.trim() || frame.message.length > 1_024) {
				throw new Error("Networking error frame is invalid.");
			}
			break;
		default:
			throw new Error(`Unsupported networking frame type: ${String(frame.type)}.`);
	}
	return clone(message) as unknown as NetworkWireMessage;
}

/** Adds the fixed protocol envelope without accepting caller overrides. */
export function createNetworkWireMessage<T extends NetworkWirePayload>(message: T): T & { protocol: typeof NETWORKING_PROTOCOL_NAME; version: typeof NETWORKING_PROTOCOL_VERSION } {
	const result = { protocol: NETWORKING_PROTOCOL_NAME, version: NETWORKING_PROTOCOL_VERSION, ...message };
	return parseNetworkWireMessage(result) as unknown as T & { protocol: typeof NETWORKING_PROTOCOL_NAME; version: typeof NETWORKING_PROTOCOL_VERSION };
}
