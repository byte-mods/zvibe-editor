import { Scene } from "babylonjs";
import {
	configureNetworking,
	createDefaultNetworkingConfiguration,
	getNetworkingRuntime,
	getSceneNetworkingConfiguration,
	IEditorNetworkingConfiguration,
	normalizeNetworkingConfiguration,
	setSceneNetworkingConfiguration,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { registerUndoRedo } from "../../tools/undoredo";
import { GameplaySessionHost } from "./session-host";
import { MultiplayerPlayModeController } from "./play-mode";

const configurationChangeKeys = ["enabled", "topology", "transport", "replication", "prediction", "simulation", "session", "maximumTraceEvents"];
const nestedChangeKeys: Record<string, string[]> = {
	transport: ["mode", "endpoint", "autoConnect", "reconnect", "connectionTimeoutMs", "maximumMessageBytes"],
	replication: ["tickRateHz", "snapshotRateHz", "interpolationDelayMs", "maximumExtrapolationMs", "positionEpsilon", "rotationEpsilonDegrees"],
	prediction: ["enabled", "rollbackReplay", "historySize", "reconciliationThreshold"],
	simulation: ["enabled", "latencyMs", "jitterMs", "packetLossPercent", "packetReorderPercent", "seed"],
	session: ["maximumPlayers", "reconnectGraceMs", "allowHostMigration", "publicLobby"],
};

let activeEditor: any = null;
const gameplaySessionHost = new GameplaySessionHost(() => {
	activeEditor?.layout?.inspector?.forceUpdate?.();
	activeEditor?.layout?.networking?.forceUpdate?.();
});
const multiplayerPlayMode = new MultiplayerPlayModeController(gameplaySessionHost, () => {
	activeEditor?.layout?.inspector?.forceUpdate?.();
	activeEditor?.layout?.networking?.forceUpdate?.();
});

/** Rejects surplus direct-action fields just like the strict external schema. */
function assertExactRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

/** Allows only bridge-owned routing fields beyond the public request schema. */
function assertActionRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	assertExactRecord(value, [...allowed, "endpoint", "collaborationToken"], label);
}

function assertRevision(configuration: IEditorNetworkingConfiguration, expectedRevision: unknown): void {
	if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
		throw new Error("Networking mutation requires expectedRevision as a positive safe integer.");
	}
	if (configuration.revision !== expectedRevision) {
		throw new Error(`Networking configuration revision is stale: expected ${String(expectedRevision)}, current ${configuration.revision}.`);
	}
}

function assertConfigurationChanges(value: unknown): asserts value is Record<string, unknown> {
	assertExactRecord(value, configurationChangeKeys, "Networking configuration changes");
	if (!Object.keys(value).length) {
		throw new Error("Networking configuration changes must contain at least one field.");
	}
	for (const block of Object.keys(nestedChangeKeys)) {
		if (value[block] !== undefined) {
			assertExactRecord(value[block], nestedChangeKeys[block], `Networking ${block} changes`);
		}
	}
}

function configurationCandidate(current: IEditorNetworkingConfiguration, changes: Record<string, unknown>): IEditorNetworkingConfiguration {
	const candidate = structuredClone(current) as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(changes)) {
		candidate[key] = nestedChangeKeys[key]
			? { ...(candidate[key] as Record<string, unknown>), ...(structuredClone(value) as Record<string, unknown>) }
			: structuredClone(value);
	}
	candidate.revision = current.revision + 1;
	return normalizeNetworkingConfiguration(candidate).configuration;
}

function refresh(scene: Scene, options: IMCPActionOptions): void {
	activeEditor = options.editor;
	options.editor.layout.inspector.setEditedObject?.(scene);
	options.editor.layout.inspector.forceUpdate?.();
	(options.editor.layout as any).networking?.forceUpdate?.();
}

function runtimeScene(scene: Scene): Parameters<typeof getNetworkingRuntime>[0] {
	return scene as unknown as Parameters<typeof getNetworkingRuntime>[0];
}

function playScene(options: IMCPActionOptions): Scene {
	const play = options.editor.layout.preview.play;
	if (!play?.state?.playing || !play.scene) {
		throw new Error("Networking runtime controls require an active compiled Play Mode scene.");
	}
	return play.scene;
}

function playRuntime(scene: Scene, options: IMCPActionOptions, create: boolean): NonNullable<ReturnType<typeof getNetworkingRuntime>> {
	const target = playScene(options);
	const play = options.editor.layout.preview.play;
	let runtime = play.getCompiledNetworkingRuntime?.(target) ?? getNetworkingRuntime(runtimeScene(target));
	const configuration = getSceneNetworkingConfiguration(scene, false);
	if (runtime && runtime.status().configurationRevision !== configuration.revision) {
		if (["connecting", "connected", "reconnecting"].includes(runtime.status().state)) {
			throw new Error(
				`Compiled Play networking revision ${runtime.status().configurationRevision} is stale against authored revision ${configuration.revision}; disconnect and restart Play Mode.`
			);
		}
		runtime.dispose();
		runtime = null;
	}
	if (!runtime && create) {
		runtime = play.configureCompiledNetworking?.(target, configuration) ?? configureNetworking(runtimeScene(target), { configuration });
	}
	if (!runtime) {
		throw new Error("The active Play Mode scene has no enabled networking runtime.");
	}
	return runtime;
}

/** Lists the bounded portable multiplayer scope and honest transport/service boundaries. */
export function getNetworkingCapabilities(scene: Scene): any {
	const configuration = getSceneNetworkingConfiguration(scene, false);
	return {
		configurationVersion: configuration.version,
		configurationRevision: configuration.revision,
		topology: ["client-server"],
		transport: {
			shipped: ["authenticated-websocket-v1", "loopback-session-host", "trusted-lan-session-host", "external-wss-endpoint"],
			channels: { reliable: "native WebSocket ordered/reliable", unreliable: "best-effort simulated loss over WebSocket" },
			limitations: ["Browser players do not expose raw UDP/DTLS; unreliable datagrams and Unity Transport protocol identity are not claimed."],
		},
		replication: ["server-authority", "owner-authority", "transform", "animation-group-state", "fixed-tick", "per-object-send-rate", "snapshot-chunking"],
		prediction: ["local-anticipation", "authoritative-reconciliation", "rollback-replay", "interpolation", "bounded-extrapolation"],
		sessions: ["private-join-code", "public-lobby-browse", "reconnect-lease", "host-migration", "authority-manifest", "bounded-relay"],
		playMode: { supportedPlayers: [1, 2, 3, 4], isolation: "separate compiled scene and engine per virtual player" },
		simulation: ["latency", "jitter", "loss", "reorder", "deterministic-seed"],
		integrations: ["Network Replication component", "Input Actions", "Project Services matchmaking adapter", "Build Profiles", "Device Lab"],
		providerBoundaries: [
			"Unity Netcode package/API identity",
			"Unity Transport protocol identity",
			"Unity Gaming Services account provisioning",
			"vendor-hosted relay capacity",
		],
	};
}

/** Returns the complete scene configuration without mutating absent metadata. */
export function getNetworkingConfiguration(scene: Scene): IEditorNetworkingConfiguration {
	return getSceneNetworkingConfiguration(scene, false);
}

/** Patches documented configuration blocks under an exact revision lease. */
export function setNetworkingConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): IEditorNetworkingConfiguration {
	assertActionRecord(data, ["expectedRevision", "changes"], "set_networking_configuration input");
	const hadMetadata = scene.metadata !== null && scene.metadata !== undefined;
	const hadAuthoredConfiguration = Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, "babylonEditorNetworking"));
	const authoredConfiguration = hadAuthoredConfiguration ? structuredClone(scene.metadata.babylonEditorNetworking) : undefined;
	const current = getSceneNetworkingConfiguration(scene, false);
	assertRevision(current, data.expectedRevision);
	assertConfigurationChanges(data.changes);
	if (multiplayerPlayMode.status().active) {
		throw new Error("Stop Multiplayer Play Mode before changing authored networking configuration.");
	}
	const runtime = getNetworkingRuntime(runtimeScene(scene));
	const activePlayScene = options.editor.layout.preview.play?.scene as Scene | null | undefined;
	const playNetworking = activePlayScene
		? (options.editor.layout.preview.play.getCompiledNetworkingRuntime?.(activePlayScene) ?? getNetworkingRuntime(runtimeScene(activePlayScene)))
		: null;
	if ([runtime, playNetworking].some((candidate) => candidate && ["connected", "connecting", "reconnecting"].includes(candidate.status().state))) {
		throw new Error("Disconnect the scene networking runtime before changing authored configuration.");
	}
	const next = configurationCandidate(current, data.changes);
	setSceneNetworkingConfiguration(scene, next);
	registerUndoRedo({
		undo: () => {
			if (hadAuthoredConfiguration) {
				scene.metadata ??= {};
				scene.metadata.babylonEditorNetworking = structuredClone(authoredConfiguration);
			} else if (scene.metadata) {
				delete scene.metadata.babylonEditorNetworking;
				if (!hadMetadata && Object.keys(scene.metadata).length === 0) {
					scene.metadata = null;
				}
			}
			refresh(scene, options);
		},
		redo: () => {
			setSceneNetworkingConfiguration(scene, next);
			refresh(scene, options);
		},
	});
	refresh(scene, options);
	return structuredClone(next);
}

/** Audits authored relations, object ids, target portability, and optional runtime readiness. */
export function validateNetworkingTarget(scene: Scene, data: unknown = {}): any {
	assertActionRecord(data, ["target", "requireEnabled", "checkRuntime"], "validate_networking_target input");
	const target = data.target ?? "authoring";
	if (!["authoring", "web", "electron", "headless"].includes(target as string)) {
		throw new Error(`Unsupported networking validation target: ${String(target)}.`);
	}
	for (const key of ["requireEnabled", "checkRuntime"] as const) {
		if (data[key] !== undefined && typeof data[key] !== "boolean") {
			throw new Error(`Networking validation ${key} must be a boolean.`);
		}
	}
	const configuration = getSceneNetworkingConfiguration(scene, false);
	const errors: Array<{ code: string; message: string }> = [];
	const warnings: Array<{ code: string; message: string }> = [];
	if (data.requireEnabled === true && !configuration.enabled) {
		errors.push({ code: "networking_disabled", message: "Networking is disabled for this scene." });
	}
	if (configuration.enabled && configuration.transport.autoConnect && !configuration.transport.endpoint) {
		errors.push({ code: "autoconnect_endpoint_missing", message: "Networking autoConnect requires a persisted endpoint." });
	}
	if (
		target === "headless" &&
		configuration.transport.endpoint?.startsWith("ws://") &&
		!configuration.transport.endpoint.includes("127.0.0.1") &&
		!configuration.transport.endpoint.includes("localhost")
	) {
		errors.push({ code: "insecure_headless_endpoint", message: "Headless remote networking endpoints must use wss://." });
	}
	const ids = new Map<string, string>();
	let networkComponentCount = 0;
	for (const node of scene.getNodes()) {
		const components = node.metadata?.babylonEditorComponentStack?.components;
		const component = Array.isArray(components) ? components.find((entry: any) => entry?.type === "network" && entry.enabled !== false) : null;
		if (!component) {
			continue;
		}
		networkComponentCount++;
		const networkId = component.data?.networkId;
		if (typeof networkId !== "string" || !networkId) {
			errors.push({ code: "network_id_missing", message: `Node ${node.name || node.id} has a Network Replication component without networkId.` });
		} else if (ids.has(networkId)) {
			errors.push({ code: "network_id_duplicate", message: `Nodes ${ids.get(networkId)} and ${node.id} share networkId ${networkId}.` });
		} else {
			ids.set(networkId, node.id);
		}
	}
	if (configuration.enabled && networkComponentCount === 0) {
		warnings.push({ code: "no_network_objects", message: "Networking is enabled but the scene has no enabled Network Replication components." });
	}
	if (configuration.transport.mode === "websocket") {
		warnings.push({
			code: "websocket_unreliable_boundary",
			message: "Unreliable channels use deterministic best-effort simulation over ordered WebSocket, not UDP datagrams.",
		});
	}
	const runtime = data.checkRuntime === true ? (getNetworkingRuntime(runtimeScene(scene))?.status() ?? null) : null;
	return {
		valid: errors.length === 0,
		ready: errors.length === 0 && configuration.enabled && networkComponentCount > 0,
		target,
		configurationRevision: configuration.revision,
		networkComponentCount,
		uniqueNetworkIdCount: ids.size,
		errors,
		warnings,
		runtime,
	};
}

/** Starts the local gameplay host used by Play Mode, LAN clients, and MCP. */
export async function startGameplaySessionHost(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["host", "advertisedHost", "port", "confirm"], "start_gameplay_session_host input");
	activeEditor = options.editor;
	return gameplaySessionHost.start(data);
}

/** Stops the host and every transient lobby with explicit confirmation. */
export async function stopGameplaySessionHost(_scene: Scene, data: unknown, options?: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["confirm"], "stop_gameplay_session_host input");
	if (data.confirm !== true) {
		throw new Error("Stopping the gameplay session host requires confirm=true.");
	}
	if (multiplayerPlayMode.status().active && options) {
		await multiplayerPlayMode.stop(options.editor, true);
	}
	const activePlayScene = options?.editor.layout.preview.play?.scene as Scene | null | undefined;
	const playRuntime = activePlayScene
		? (options?.editor.layout.preview.play.getCompiledNetworkingRuntime?.(activePlayScene) ?? getNetworkingRuntime(runtimeScene(activePlayScene)))
		: getNetworkingRuntime(runtimeScene(_scene));
	playRuntime?.disconnect();
	return gameplaySessionHost.stop(true);
}

export function getGameplaySessionHostStatus(): any {
	return gameplaySessionHost.status();
}

/** Creates one transient lobby under the exact authored configuration revision. */
export function createGameplaySession(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["expectedRevision", "name", "maximumPlayers", "publicLobby", "allowHostMigration", "reconnectGraceMs"], "create_gameplay_session input");
	const configuration = getSceneNetworkingConfiguration(scene, false);
	assertRevision(configuration, data.expectedRevision);
	activeEditor = options.editor;
	return gameplaySessionHost.createSession({
		name: (data.name as string | undefined) ?? "Zvibe Session",
		maximumPlayers: (data.maximumPlayers as number | undefined) ?? configuration.session.maximumPlayers,
		publicLobby: (data.publicLobby as boolean | undefined) ?? configuration.session.publicLobby,
		allowHostMigration: (data.allowHostMigration as boolean | undefined) ?? configuration.session.allowHostMigration,
		reconnectGraceMs: (data.reconnectGraceMs as number | undefined) ?? configuration.session.reconnectGraceMs,
	});
}

export function listGameplaySessions(_scene: Scene, data: unknown = {}): any {
	assertActionRecord(data, ["publicOnly", "offset", "limit"], "list_gameplay_sessions input");
	return gameplaySessionHost.listSessions(data);
}

export function getGameplaySession(_scene: Scene, data: unknown): any {
	assertActionRecord(data, ["sessionId"], "get_gameplay_session input");
	return gameplaySessionHost.getSession(data.sessionId as string);
}

export function setGameplaySession(_scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["sessionId", "expectedRevision", "changes"], "set_gameplay_session input");
	assertExactRecord(data.changes, ["name", "maximumPlayers", "publicLobby", "allowHostMigration", "reconnectGraceMs"], "Gameplay session changes");
	activeEditor = options.editor;
	return gameplaySessionHost.updateSession(data.sessionId as string, data.expectedRevision as number, data.changes);
}

export function deleteGameplaySession(_scene: Scene, data: unknown, options?: IMCPActionOptions): any {
	assertActionRecord(data, ["sessionId", "expectedRevision", "confirm"], "delete_gameplay_session input");
	if (data.confirm !== true) {
		throw new Error("Deleting a gameplay session requires confirm=true.");
	}
	const multiplayerRun = multiplayerPlayMode.status().run as { sessionId?: string } | null;
	if (multiplayerRun?.sessionId === data.sessionId) {
		throw new Error("Stop Multiplayer Play Mode before deleting its gameplay session.");
	}
	const activePlayScene = options?.editor.layout.preview.play?.scene as Scene | null | undefined;
	const runtime = activePlayScene
		? (options?.editor.layout.preview.play.getCompiledNetworkingRuntime?.(activePlayScene) ?? getNetworkingRuntime(runtimeScene(activePlayScene)))
		: null;
	if (runtime && runtime.status().sessionId === data.sessionId) {
		runtime.disconnect();
	}
	return gameplaySessionHost.deleteSession(data.sessionId as string, data.expectedRevision as number, true);
}

/** Connects the exact compiled Play scene; credentials are never authored or returned. */
export function connectNetworkingRuntime(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["expectedRevision", "connection"], "connect_networking_runtime input");
	const configuration = getSceneNetworkingConfiguration(scene, false);
	assertRevision(configuration, data.expectedRevision);
	assertExactRecord(data.connection, ["endpoint", "clientId", "displayName", "joinCode", "hostToken", "reconnectToken"], "Networking runtime connection");
	const runtime = playRuntime(scene, options, true);
	return runtime.connect(data.connection);
}

export function disconnectNetworkingRuntime(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["confirm"], "disconnect_networking_runtime input");
	if (data.confirm !== true) {
		throw new Error("Disconnecting the Play networking runtime requires confirm=true.");
	}
	return playRuntime(scene, options, false).disconnect();
}

export function getNetworkingRuntimeState(scene: Scene, data: unknown = {}, options?: IMCPActionOptions): any {
	assertActionRecord(data, ["offset", "limit"], "get_networking_runtime input");
	const configuration = getSceneNetworkingConfiguration(scene, false);
	if (!options?.editor.layout.preview.play?.scene) {
		return { active: false, configurationRevision: configuration.revision, runtime: null, trace: { total: 0, offset: 0, limit: 0, events: [] } };
	}
	const runtime =
		options.editor.layout.preview.play.getCompiledNetworkingRuntime?.(options.editor.layout.preview.play.scene) ??
		getNetworkingRuntime(runtimeScene(options.editor.layout.preview.play.scene));
	return {
		active: Boolean(runtime),
		configurationRevision: configuration.revision,
		runtime: runtime?.status() ?? null,
		trace: runtime?.trace((data.offset as number | undefined) ?? 0, (data.limit as number | undefined) ?? 200) ?? { total: 0, offset: 0, limit: 200, events: [] },
	};
}

export function setNetworkingOwnership(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["networkId", "claim"], "set_networking_ownership input");
	if (typeof data.claim !== "boolean") {
		throw new Error("Networking ownership claim must be a boolean.");
	}
	const runtime = playRuntime(scene, options, false);
	runtime.setOwnership(data.networkId as string, data.claim);
	return runtime.status();
}

export function submitNetworkingInput(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["networkId", "translation", "rotationDegrees"], "submit_networking_input input");
	return playRuntime(scene, options, false).submitInput(data.networkId as string, data.translation as [number, number, number], data.rotationDegrees as [number, number, number]);
}

export function sendNetworkingRpc(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["name", "target", "channel", "networkId", "payload"], "send_networking_rpc input");
	return playRuntime(scene, options, false).sendRpc(data.name as string, data.target as "server" | "all" | "owner", data.payload, {
		channel: data.channel as "reliable" | "unreliable" | undefined,
		networkId: data.networkId as string | undefined,
	});
}

export function clearNetworkingEvidence(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["confirm"], "clear_networking_evidence input");
	if (data.confirm !== true) {
		throw new Error("Clearing networking metrics and trace requires confirm=true.");
	}
	const runtime = playRuntime(scene, options, false);
	runtime.clearEvidence();
	return runtime.status();
}

/** Starts one exact compiled 1-4-player local Play lease. */
export async function startMultiplayerPlayMode(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision", "playerCount", "playerNames", "assignments", "simulations"], "start_multiplayer_play_mode input");
	const configuration = getSceneNetworkingConfiguration(scene, false);
	assertRevision(configuration, data.expectedRevision);
	if (data.simulations !== undefined) {
		if (!Array.isArray(data.simulations)) {
			throw new Error("Multiplayer Play Mode simulations must be an array.");
		}
		for (const [index, simulation] of data.simulations.entries()) {
			if (simulation !== null) {
				assertExactRecord(simulation, nestedChangeKeys.simulation, `Multiplayer player ${index} simulation`);
			}
		}
	}
	activeEditor = options.editor;
	return multiplayerPlayMode.start(options.editor, configuration, {
		playerCount: data.playerCount as number,
		playerNames: data.playerNames as string[] | undefined,
		assignments: data.assignments as Array<string | null> | undefined,
		simulations: data.simulations as Array<Partial<IEditorNetworkingConfiguration["simulation"]> | null> | undefined,
	});
}

/** Returns per-player scenes, roles, assignments, runtime metrics, and errors. */
export function getMultiplayerPlayMode(): any {
	return multiplayerPlayMode.status();
}

/** Applies one exact-run input/RPC/ownership/simulation/render/lifecycle control. */
export async function controlMultiplayerPlayMode(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(
		data,
		["expectedRunRevision", "command", "playerIndex", "frames", "networkId", "translation", "rotationDegrees", "name", "target", "channel", "payload", "claim", "simulation"],
		"control_multiplayer_play_mode input"
	);
	if (data.simulation !== undefined) {
		assertExactRecord(data.simulation, nestedChangeKeys.simulation, "Multiplayer simulation changes");
	}
	return multiplayerPlayMode.control(options.editor, data);
}

/** Stops and disposes all virtual clients, then restores host and Play ownership. */
export async function stopMultiplayerPlayMode(_scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["confirm"], "stop_multiplayer_play_mode input");
	return multiplayerPlayMode.stop(options.editor, data.confirm === true);
}

/** Stops transient transport state during editor shutdown/reload. */
export async function shutdownNetworking(): Promise<void> {
	if (activeEditor && multiplayerPlayMode.status().active) {
		await multiplayerPlayMode.stop(activeEditor, true).catch(() => undefined);
	}
	const activePlayScene = activeEditor?.layout?.preview?.play?.scene as Scene | null | undefined;
	if (activePlayScene) {
		(activeEditor.layout.preview.play.getCompiledNetworkingRuntime?.(activePlayScene) ?? getNetworkingRuntime(runtimeScene(activePlayScene)))?.dispose();
	}
	activeEditor = null;
	await gameplaySessionHost.stop(true);
}

export function getDefaultNetworkingConfiguration(): IEditorNetworkingConfiguration {
	return createDefaultNetworkingConfiguration();
}
