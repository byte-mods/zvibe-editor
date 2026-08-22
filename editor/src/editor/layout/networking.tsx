import { Component, ReactNode } from "react";

import { IEditorNetworkingConfiguration } from "babylonjs-editor-tools";

import { showConfirm } from "../../ui/dialog";
import { Button } from "../../ui/shadcn/ui/button";
import { Input } from "../../ui/shadcn/ui/input";
import {
	createGameplaySession,
	deleteGameplaySession,
	getGameplaySessionHostStatus,
	getMultiplayerPlayMode,
	getNetworkingCapabilities,
	getNetworkingConfiguration,
	getNetworkingRuntimeState,
	listGameplaySessions,
	setNetworkingConfiguration,
	startGameplaySessionHost,
	startMultiplayerPlayMode,
	stopGameplaySessionHost,
	stopMultiplayerPlayMode,
	validateNetworkingTarget,
} from "../../mcp/networking/networking";

import { Editor } from "../main";

interface IEditorNetworkingProps {
	editor: Editor;
}

interface IEditorNetworkingState {
	busy: boolean;
	error: string | null;
	hostPort: number;
	playerCount: number;
	sessionName: string;
	createdConnection: { sessionId: string; joinCode: string; hostToken: string } | null;
}

interface INumberFieldProps {
	label: string;
	value: number;
	minimum: number;
	maximum: number;
	step?: number;
	onCommit(value: number): void;
}

function NumberField(props: INumberFieldProps): ReactNode {
	return (
		<label className="grid grid-cols-[minmax(150px,1fr)_minmax(100px,180px)] items-center gap-2 text-xs">
			<span>{props.label}</span>
			<Input
				key={props.value}
				type="number"
				min={props.minimum}
				max={props.maximum}
				step={props.step}
				defaultValue={props.value}
				className="h-8"
				onBlur={(event) => {
					const value = Number(event.currentTarget.value);
					if (Number.isFinite(value) && value !== props.value) {
						props.onCommit(value);
					}
				}}
			/>
		</label>
	);
}

function ToggleField(props: { label: string; checked: boolean; onCommit(value: boolean): void }): ReactNode {
	return (
		<label className="flex items-center justify-between gap-2 text-xs">
			<span>{props.label}</span>
			<input type="checkbox" checked={props.checked} onChange={(event) => props.onCommit(event.currentTarget.checked)} />
		</label>
	);
}

function Panel(props: { title: string; children: ReactNode }): ReactNode {
	return (
		<section className="rounded border border-border bg-background/60 p-3">
			<div className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.title}</div>
			<div className="flex flex-col gap-2">{props.children}</div>
		</section>
	);
}

/** Unity-style network manager, session host, multiplayer Play Mode, and diagnostics workspace. */
export class EditorNetworking extends Component<IEditorNetworkingProps, IEditorNetworkingState> {
	private _refreshTimer: ReturnType<typeof setInterval> | null = null;

	public constructor(props: IEditorNetworkingProps) {
		super(props);
		this.state = { busy: false, error: null, hostPort: 0, playerCount: 2, sessionName: "Zvibe Session", createdConnection: null };
	}

	public componentDidMount(): void {
		this._refreshTimer = setInterval(() => this.forceUpdate(), 500);
	}

	public componentWillUnmount(): void {
		if (this._refreshTimer) {
			clearInterval(this._refreshTimer);
		}
		this._refreshTimer = null;
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview?.scene;
		if (!scene) {
			return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Open a scene to configure Networking.</div>;
		}
		let configuration: IEditorNetworkingConfiguration;
		let host: any;
		let multiplayer: any;
		let sessions: any;
		let runtime: any;
		let validation: any;
		try {
			configuration = getNetworkingConfiguration(scene);
			host = getGameplaySessionHostStatus();
			multiplayer = getMultiplayerPlayMode();
			sessions = listGameplaySessions(scene, { limit: 100 });
			runtime = getNetworkingRuntimeState(scene, { limit: 25 }, { editor: this.props.editor });
			validation = validateNetworkingTarget(scene, { target: "authoring", checkRuntime: true });
		} catch (error) {
			return <div className="p-3 text-sm text-destructive">{this._error(error)}</div>;
		}

		const run = multiplayer.run;
		return (
			<div className="flex h-full min-h-0 flex-col bg-background text-foreground">
				<div className="flex flex-wrap items-center gap-2 border-b border-border bg-input p-2">
					<span className="text-xs font-semibold">Networking · revision {configuration.revision}</span>
					<span className={`text-xs ${validation.valid ? "text-emerald-400" : "text-destructive"}`}>
						{validation.valid ? `${validation.networkComponentCount} replicated objects` : `${validation.errors.length} validation errors`}
					</span>
					<span className="ml-auto text-[10px] text-muted-foreground">Client/server · authenticated WebSocket v1 · credentials remain memory-only</span>
				</div>
				{this.state.error && <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{this.state.error}</div>}
				<div className="min-h-0 flex-1 overflow-auto p-3">
					<div className="grid gap-3 xl:grid-cols-2">
						<Panel title="Network Manager">
							<ToggleField label="Networking enabled" checked={configuration.enabled} onCommit={(enabled) => this._patch(configuration, { enabled })} />
							<label className="grid grid-cols-[minmax(150px,1fr)_minmax(180px,2fr)] items-center gap-2 text-xs">
								<span>WebSocket endpoint</span>
								<Input
									key={`${configuration.revision}:${configuration.transport.endpoint}`}
									className="h-8 font-mono text-[11px]"
									defaultValue={configuration.transport.endpoint ?? ""}
									placeholder="wss://game.example.com/session"
									onBlur={(event) => {
										const endpoint = event.currentTarget.value.trim() || null;
										if (endpoint !== configuration.transport.endpoint) {
											this._patch(configuration, { transport: { endpoint } });
										}
									}}
								/>
							</label>
							<ToggleField
								label="Auto-connect exported game"
								checked={configuration.transport.autoConnect}
								onCommit={(autoConnect) => this._patch(configuration, { transport: { autoConnect } })}
							/>
							<ToggleField
								label="Automatic reconnect"
								checked={configuration.transport.reconnect}
								onCommit={(reconnect) => this._patch(configuration, { transport: { reconnect } })}
							/>
							<NumberField
								label="Connection timeout (ms)"
								value={configuration.transport.connectionTimeoutMs}
								minimum={250}
								maximum={120_000}
								onCommit={(connectionTimeoutMs) => this._patch(configuration, { transport: { connectionTimeoutMs } })}
							/>
							<NumberField
								label="Maximum message bytes"
								value={configuration.transport.maximumMessageBytes}
								minimum={1_024}
								maximum={4_194_304}
								onCommit={(maximumMessageBytes) => this._patch(configuration, { transport: { maximumMessageBytes } })}
							/>
						</Panel>

						<Panel title="Gameplay Session Host">
							<div className="flex flex-wrap items-center gap-2">
								<Input
									type="number"
									min={0}
									max={65535}
									value={this.state.hostPort}
									className="h-8 w-28"
									onChange={(event) => this.setState({ hostPort: Number(event.currentTarget.value) })}
								/>
								{host.listening ? (
									<Button size="sm" variant="destructive" disabled={this.state.busy} onClick={() => void this._stopHost()}>
										Stop Host
									</Button>
								) : (
									<Button
										size="sm"
										disabled={this.state.busy}
										onClick={() => this._run(() => startGameplaySessionHost(scene, { port: this.state.hostPort }, { editor: this.props.editor }))}
									>
										Start Loopback Host
									</Button>
								)}
								<span className="text-[11px] text-muted-foreground">{host.listening ? host.endpoint : "Stopped"}</span>
							</div>
							<div className="flex flex-wrap gap-2">
								<Input
									className="h-8 min-w-48 flex-1"
									value={this.state.sessionName}
									maxLength={80}
									onChange={(event) => this.setState({ sessionName: event.currentTarget.value })}
								/>
								<Button
									size="sm"
									variant="secondary"
									disabled={this.state.busy || !host.listening || !this.state.sessionName.trim()}
									onClick={() => this._createSession(scene, configuration)}
								>
									Create Session
								</Button>
							</div>
							{this.state.createdConnection && (
								<div className="rounded border border-amber-400/40 bg-amber-400/10 p-2 text-[10px]">
									<div className="font-semibold text-amber-300">One-time connection credentials — copy now</div>
									<div>Join code: {this.state.createdConnection.joinCode}</div>
									<div className="break-all font-mono">Host token: {this.state.createdConnection.hostToken}</div>
								</div>
							)}
							{sessions.sessions.map((session: any) => (
								<div key={session.id} className="flex items-center gap-2 rounded border border-border p-2 text-[11px]">
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium">{session.name}</div>
										<div className="text-muted-foreground">
											{session.connectedPlayers}/{session.maximumPlayers} players · {session.publicLobby ? "public" : "private"} · revision {session.revision}
										</div>
									</div>
									<Button
										size="sm"
										variant="ghost"
										className="h-7 text-destructive"
										disabled={this.state.busy}
										onClick={() => void this._deleteSession(scene, session)}
									>
										Delete
									</Button>
								</div>
							))}
							{!sessions.total && <div className="text-[11px] text-muted-foreground">No transient gameplay sessions.</div>}
						</Panel>

						<Panel title="Replication">
							<NumberField
								label="Fixed tick rate (Hz)"
								value={configuration.replication.tickRateHz}
								minimum={1}
								maximum={240}
								onCommit={(tickRateHz) => this._patch(configuration, { replication: { tickRateHz } })}
							/>
							<NumberField
								label="Snapshot rate (Hz)"
								value={configuration.replication.snapshotRateHz}
								minimum={1}
								maximum={120}
								onCommit={(snapshotRateHz) => this._patch(configuration, { replication: { snapshotRateHz } })}
							/>
							<NumberField
								label="Interpolation delay (ms)"
								value={configuration.replication.interpolationDelayMs}
								minimum={0}
								maximum={2_000}
								onCommit={(interpolationDelayMs) => this._patch(configuration, { replication: { interpolationDelayMs } })}
							/>
							<NumberField
								label="Maximum extrapolation (ms)"
								value={configuration.replication.maximumExtrapolationMs}
								minimum={0}
								maximum={2_000}
								onCommit={(maximumExtrapolationMs) => this._patch(configuration, { replication: { maximumExtrapolationMs } })}
							/>
							<NumberField
								label="Position epsilon"
								value={configuration.replication.positionEpsilon}
								minimum={0}
								maximum={1_000}
								step={0.001}
								onCommit={(positionEpsilon) => this._patch(configuration, { replication: { positionEpsilon } })}
							/>
							<NumberField
								label="Rotation epsilon (degrees)"
								value={configuration.replication.rotationEpsilonDegrees}
								minimum={0}
								maximum={180}
								step={0.01}
								onCommit={(rotationEpsilonDegrees) => this._patch(configuration, { replication: { rotationEpsilonDegrees } })}
							/>
						</Panel>

						<Panel title="Prediction and Reconciliation">
							<ToggleField
								label="Client prediction"
								checked={configuration.prediction.enabled}
								onCommit={(enabled) => this._patch(configuration, { prediction: { enabled } })}
							/>
							<ToggleField
								label="Rollback and replay"
								checked={configuration.prediction.rollbackReplay}
								onCommit={(rollbackReplay) => this._patch(configuration, { prediction: { rollbackReplay } })}
							/>
							<NumberField
								label="Input history"
								value={configuration.prediction.historySize}
								minimum={8}
								maximum={2_048}
								onCommit={(historySize) => this._patch(configuration, { prediction: { historySize } })}
							/>
							<NumberField
								label="Reconciliation threshold"
								value={configuration.prediction.reconciliationThreshold}
								minimum={0}
								maximum={10_000}
								step={0.01}
								onCommit={(reconciliationThreshold) => this._patch(configuration, { prediction: { reconciliationThreshold } })}
							/>
						</Panel>

						<Panel title="Multiplayer Play Mode (1–4 players)">
							<div className="flex flex-wrap items-center gap-2">
								<label className="flex items-center gap-2 text-xs">
									Players
									<Input
										type="number"
										min={1}
										max={4}
										value={this.state.playerCount}
										className="h-8 w-20"
										onChange={(event) => this.setState({ playerCount: Number(event.currentTarget.value) })}
									/>
								</label>
								{multiplayer.active ? (
									<Button
										size="sm"
										variant="destructive"
										disabled={this.state.busy || run?.state === "starting"}
										onClick={() => this._run(() => stopMultiplayerPlayMode(scene, { confirm: true }, { editor: this.props.editor }))}
									>
										Stop Players
									</Button>
								) : (
									<Button
										size="sm"
										disabled={this.state.busy || !configuration.enabled || this.state.playerCount < 1 || this.state.playerCount > 4}
										onClick={() =>
											this._run(() =>
												startMultiplayerPlayMode(
													scene,
													{ expectedRevision: configuration.revision, playerCount: this.state.playerCount },
													{ editor: this.props.editor }
												)
											)
										}
									>
										Start Players
									</Button>
								)}
							</div>
							{run ? (
								<>
									<div className="text-[11px] text-muted-foreground">
										{run.state} · run revision {run.revision} · {run.players.length}/{run.playerCount} players
									</div>
									{run.players.map((player: any) => (
										<div key={player.index} className="rounded border border-border p-2 text-[11px]">
											<div className="font-medium">
												Player {player.index + 1} · {player.name} · {player.role}
											</div>
											<div className="text-muted-foreground">
												{player.primary ? "Editor Play" : "Isolated headless scene"} · {player.runtime.state} · {player.runtime.peerCount} peers ·{" "}
												{player.assignedNetworkId ?? "unassigned"}
											</div>
										</div>
									))}
								</>
							) : (
								<div className="text-[11px] text-muted-foreground">
									The first player uses compiled Play; additional players use isolated compiled scenes and engines.
								</div>
							)}
						</Panel>

						<Panel title="Network Simulation">
							<ToggleField
								label="Simulation enabled"
								checked={configuration.simulation.enabled}
								onCommit={(enabled) => this._patch(configuration, { simulation: { enabled } })}
							/>
							<NumberField
								label="Latency (ms)"
								value={configuration.simulation.latencyMs}
								minimum={0}
								maximum={10_000}
								onCommit={(latencyMs) => this._patch(configuration, { simulation: { latencyMs } })}
							/>
							<NumberField
								label="Jitter (ms)"
								value={configuration.simulation.jitterMs}
								minimum={0}
								maximum={10_000}
								onCommit={(jitterMs) => this._patch(configuration, { simulation: { jitterMs } })}
							/>
							<NumberField
								label="Packet loss (%)"
								value={configuration.simulation.packetLossPercent}
								minimum={0}
								maximum={100}
								step={0.1}
								onCommit={(packetLossPercent) => this._patch(configuration, { simulation: { packetLossPercent } })}
							/>
							<NumberField
								label="Packet reorder (%)"
								value={configuration.simulation.packetReorderPercent}
								minimum={0}
								maximum={100}
								step={0.1}
								onCommit={(packetReorderPercent) => this._patch(configuration, { simulation: { packetReorderPercent } })}
							/>
							<NumberField
								label="Deterministic seed"
								value={configuration.simulation.seed}
								minimum={0}
								maximum={2_147_483_647}
								onCommit={(seed) => this._patch(configuration, { simulation: { seed } })}
							/>
						</Panel>

						<Panel title="Session Policy and Diagnostics">
							<NumberField
								label="Maximum players"
								value={configuration.session.maximumPlayers}
								minimum={1}
								maximum={64}
								onCommit={(maximumPlayers) => this._patch(configuration, { session: { maximumPlayers } })}
							/>
							<NumberField
								label="Reconnect grace (ms)"
								value={configuration.session.reconnectGraceMs}
								minimum={0}
								maximum={300_000}
								onCommit={(reconnectGraceMs) => this._patch(configuration, { session: { reconnectGraceMs } })}
							/>
							<ToggleField
								label="Host migration"
								checked={configuration.session.allowHostMigration}
								onCommit={(allowHostMigration) => this._patch(configuration, { session: { allowHostMigration } })}
							/>
							<ToggleField
								label="Public lobby"
								checked={configuration.session.publicLobby}
								onCommit={(publicLobby) => this._patch(configuration, { session: { publicLobby } })}
							/>
							<NumberField
								label="Maximum trace events"
								value={configuration.maximumTraceEvents}
								minimum={16}
								maximum={10_000}
								onCommit={(maximumTraceEvents) => this._patch(configuration, { maximumTraceEvents })}
							/>
							<div className="rounded bg-muted/30 p-2 text-[10px] text-muted-foreground">
								Runtime: {runtime.runtime?.state ?? "inactive"} · role {runtime.runtime?.role ?? "—"} · messages {runtime.runtime?.metrics?.messagesSent ?? 0} sent
								/ {runtime.runtime?.metrics?.messagesReceived ?? 0} received
							</div>
							<div className="text-[10px] text-amber-400">{getNetworkingCapabilities(scene).transport.limitations[0]}</div>
							{validation.errors.map((entry: any) => (
								<div key={`${entry.code}:${entry.message}`} className="text-[10px] text-destructive">
									{entry.code}: {entry.message}
								</div>
							))}
						</Panel>
					</div>
				</div>
			</div>
		);
	}

	private _patch(configuration: IEditorNetworkingConfiguration, changes: Record<string, unknown>): void {
		this._run(() => setNetworkingConfiguration(this.props.editor.layout.preview.scene!, { expectedRevision: configuration.revision, changes }, { editor: this.props.editor }));
	}

	private _createSession(scene: any, configuration: IEditorNetworkingConfiguration): void {
		this._run(() => {
			const result = createGameplaySession(
				scene,
				{ expectedRevision: configuration.revision, name: this.state.sessionName, publicLobby: configuration.session.publicLobby },
				{ editor: this.props.editor }
			);
			this.setState({ createdConnection: { sessionId: result.session.id, joinCode: result.connection.joinCode, hostToken: result.connection.hostToken } });
			return result;
		});
	}

	private async _deleteSession(scene: any, session: any): Promise<void> {
		if (!(await showConfirm("Delete Gameplay Session?", `Disconnect every player and delete “${session.name}”?`, { confirmText: "Delete" }))) {
			return;
		}
		this._run(() => {
			const result = deleteGameplaySession(scene, { sessionId: session.id, expectedRevision: session.revision, confirm: true }, { editor: this.props.editor });
			if (this.state.createdConnection?.sessionId === session.id) {
				this.setState({ createdConnection: null });
			}
			return result;
		});
	}

	private async _stopHost(): Promise<void> {
		if (!(await showConfirm("Stop Gameplay Session Host?", "Disconnect every player and delete all transient sessions?", { confirmText: "Stop Host" }))) {
			return;
		}
		const scene = this.props.editor.layout.preview.scene!;
		this._run(async () => {
			const result = await stopGameplaySessionHost(scene, { confirm: true }, { editor: this.props.editor });
			this.setState({ createdConnection: null });
			return result;
		});
	}

	private _run(action: () => unknown | Promise<unknown>): void {
		if (this.state.busy) {
			return;
		}
		this.setState({ busy: true, error: null });
		Promise.resolve()
			.then(action)
			.then(() => this.setState({ busy: false, error: null }))
			.catch((error) => this.setState({ busy: false, error: this._error(error) }));
	}

	private _error(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
