import { NullEngine, Scene } from "babylonjs";
import { IEditorNetworkingConfiguration, INetworkingSimulationConfiguration, NetworkingRuntime } from "babylonjs-editor-tools";

import { GameplaySessionHost } from "./session-host";

export interface IMultiplayerPlayStartOptions {
	playerCount: number;
	playerNames?: string[];
	assignments?: Array<string | null>;
	simulations?: Array<Partial<INetworkingSimulationConfiguration> | null>;
}

export type MultiplayerPlayCommand = "pause" | "resume" | "render-frames" | "input" | "rpc" | "ownership" | "set-simulation" | "disconnect-player" | "reconnect-player";

interface IMultiplayerPlayer {
	index: number;
	name: string;
	role: "host" | "client";
	primary: boolean;
	engine: NullEngine | null;
	scene: Scene;
	runtime: NetworkingRuntime;
	timer: ReturnType<typeof setInterval> | null;
	paused: boolean;
	assignedNetworkId: string | null;
	lastError: string | null;
}

interface IMultiplayerRun {
	id: string;
	revision: number;
	state: "starting" | "running" | "stopping" | "failed";
	configurationRevision: number;
	startedAt: string;
	finishedAt: string | null;
	playerCount: number;
	sessionId: string | null;
	startedHost: boolean;
	startedPlay: boolean;
	players: IMultiplayerPlayer[];
	lastError: string | null;
}

function boundedError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error ?? "Unknown Multiplayer Play Mode error.");
	return message.length <= 2_048 ? message : `${message.slice(0, 2_048)}…`;
}

async function waitFor(predicate: () => boolean, failure: () => string | null, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		const error = failure();
		if (error) {
			throw new Error(error);
		}
		if (Date.now() >= deadline) {
			throw new Error("Multiplayer Play Mode timed out waiting for a player connection.");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Owns one isolated 1-4-player compiled Play lease and all virtual engines. */
export class MultiplayerPlayModeController {
	private _run: IMultiplayerRun | null = null;
	private _lastRun: Record<string, unknown> | null = null;
	private _host: GameplaySessionHost;
	private _notify: (() => void) | null;

	public constructor(host: GameplaySessionHost, notify?: () => void) {
		this._host = host;
		this._notify = notify ?? null;
	}

	/** Builds/loads one primary player plus up to three isolated compiled clients. */
	public async start(editor: any, configuration: IEditorNetworkingConfiguration, options: IMultiplayerPlayStartOptions): Promise<Record<string, unknown>> {
		if (this._run && ["starting", "running", "stopping"].includes(this._run.state)) {
			throw new Error("Multiplayer Play Mode is already active or changing state.");
		}
		if (!configuration.enabled) {
			throw new Error("Networking must be enabled before starting Multiplayer Play Mode.");
		}
		if (!Number.isSafeInteger(options.playerCount) || options.playerCount < 1 || options.playerCount > 4) {
			throw new Error("Multiplayer Play Mode playerCount must be an integer from 1 to 4.");
		}
		const names = options.playerNames ?? Array.from({ length: options.playerCount }, (_, index) => (index === 0 ? "Host" : `Client ${index}`));
		if (names.length !== options.playerCount || names.some((name) => typeof name !== "string" || !name.trim() || name.length > 80)) {
			throw new Error("Multiplayer Play Mode playerNames must contain one 1-80 character name per player.");
		}
		if (options.assignments && options.assignments.length !== options.playerCount) {
			throw new Error("Multiplayer Play Mode assignments must contain one networkId or null per player.");
		}
		if (options.simulations && options.simulations.length !== options.playerCount) {
			throw new Error("Multiplayer Play Mode simulations must contain one settings object or null per player.");
		}

		const run: IMultiplayerRun = {
			id: globalThis.crypto?.randomUUID?.() ?? `multiplayer-${Date.now()}`,
			revision: 1,
			state: "starting",
			configurationRevision: configuration.revision,
			startedAt: new Date().toISOString(),
			finishedAt: null,
			playerCount: options.playerCount,
			sessionId: null,
			startedHost: false,
			startedPlay: false,
			players: [],
			lastError: null,
		};
		this._run = run;
		this._changed();

		try {
			let hostStatus = this._host.status() as any;
			if (!hostStatus.listening) {
				hostStatus = await this._host.start({ port: 0 });
				run.startedHost = true;
			}
			const endpoint = String(hostStatus.endpoint);
			const created = this._host.createSession({
				name: `Multiplayer Play ${run.id.slice(0, 8)}`,
				maximumPlayers: options.playerCount,
				publicLobby: false,
				allowHostMigration: configuration.session.allowHostMigration,
				reconnectGraceMs: configuration.session.reconnectGraceMs,
			}) as any;
			run.sessionId = created.session.id;

			const play = editor.layout.preview.play;
			if (!play.state.playing) {
				run.startedPlay = true;
				await play.play();
			}
			await waitFor(
				() => Boolean(play.canPlayScene && play.scene),
				() => null,
				120_000
			);

			const primaryScene = play.scene as Scene;
			let primaryRuntime = play.getCompiledNetworkingRuntime(primaryScene) as NetworkingRuntime | null;
			if (!primaryRuntime || primaryRuntime.status().configurationRevision !== configuration.revision) {
				primaryRuntime?.dispose();
				primaryRuntime = play.configureCompiledNetworking(primaryScene, configuration) as NetworkingRuntime | null;
			}
			if (!primaryRuntime) {
				throw new Error("Primary compiled Play scene did not create an enabled networking runtime.");
			}
			if (primaryRuntime.status().state !== "disconnected") {
				primaryRuntime.disconnect();
			}
			if (options.simulations?.[0]) {
				primaryRuntime.setSimulation(options.simulations[0]!);
			}
			primaryRuntime.connect({ endpoint, clientId: `${run.id}-player-0`, displayName: names[0], hostToken: created.connection.hostToken });
			const primary: IMultiplayerPlayer = {
				index: 0,
				name: names[0],
				role: "host",
				primary: true,
				engine: null,
				scene: primaryScene,
				runtime: primaryRuntime,
				timer: null,
				paused: false,
				assignedNetworkId: null,
				lastError: null,
			};
			run.players.push(primary);
			await this._waitConnected(primary, configuration.transport.connectionTimeoutMs);

			for (let index = 1; index < options.playerCount; index++) {
				const engine = new NullEngine({ renderWidth: 320, renderHeight: 180, textureSize: 512, deterministicLockstep: true, lockstepMaxSteps: 4 });
				let isolatedScene: Scene | null = null;
				try {
					const loadedScene = (await play.createIsolatedPlayerScene(engine)) as Scene;
					isolatedScene = loadedScene;
					let runtime = play.getCompiledNetworkingRuntime(loadedScene) as NetworkingRuntime | null;
					if (!runtime || runtime.status().configurationRevision !== configuration.revision) {
						runtime?.dispose();
						runtime = play.configureCompiledNetworking(loadedScene, configuration) as NetworkingRuntime | null;
					}
					if (!runtime) {
						throw new Error(`Virtual player ${index} did not create an enabled networking runtime.`);
					}
					if (options.simulations?.[index]) {
						runtime.setSimulation(options.simulations[index]!);
					}
					runtime.connect({ endpoint, clientId: `${run.id}-player-${index}`, displayName: names[index], joinCode: created.connection.joinCode });
					const player: IMultiplayerPlayer = {
						index,
						name: names[index],
						role: "client",
						primary: false,
						engine,
						scene: loadedScene,
						runtime,
						timer: null,
						paused: false,
						assignedNetworkId: null,
						lastError: null,
					};
					run.players.push(player);
					await this._waitConnected(player, configuration.transport.connectionTimeoutMs);
					this._startRenderTimer(player, configuration.replication.tickRateHz);
				} catch (error) {
					isolatedScene?.dispose();
					engine.dispose();
					throw error;
				}
			}

			const ownerIds = primaryScene
				.getNodes()
				.flatMap((node) => {
					const components = node.metadata?.babylonEditorComponentStack?.components;
					const component = Array.isArray(components)
						? components.find((entry: any) => entry?.type === "network" && entry.enabled !== false && entry.data?.authority === "owner")
						: null;
					return typeof component?.data?.networkId === "string" && component.data.networkId ? [component.data.networkId] : [];
				})
				.filter((networkId, index, values) => values.indexOf(networkId) === index)
				.sort();
			const assignments = options.assignments ?? run.players.map((_, index) => ownerIds[index] ?? null);
			const assigned = new Set<string>();
			for (const [index, networkId] of assignments.entries()) {
				if (networkId === null) {
					continue;
				}
				if (!ownerIds.includes(networkId)) {
					throw new Error(`Multiplayer assignment is not an owner-authority network object: ${networkId}.`);
				}
				if (assigned.has(networkId)) {
					throw new Error(`Multiplayer assignment is duplicated: ${networkId}.`);
				}
				assigned.add(networkId);
				run.players[index].runtime.setOwnership(networkId, true);
				run.players[index].assignedNetworkId = networkId;
			}
			for (const player of run.players.filter((entry) => entry.assignedNetworkId)) {
				await waitFor(
					() => player.runtime.status().ownedNetworkIds.includes(player.assignedNetworkId!),
					() => player.runtime.status().lastError,
					configuration.transport.connectionTimeoutMs
				);
			}
			run.state = "running";
			run.revision++;
			this._changed();
			return this.status();
		} catch (error) {
			run.state = "failed";
			run.lastError = boundedError(error);
			run.finishedAt = new Date().toISOString();
			await this._release(editor, run);
			this._lastRun = this._describeRun(run);
			this._run = null;
			this._changed();
			throw new Error(`Multiplayer Play Mode failed to start: ${run.lastError}`);
		}
	}

	/** Stops every runtime/scene/engine and restores Play/host ownership. */
	public async stop(editor: any, confirm: boolean): Promise<Record<string, unknown>> {
		if (!confirm) {
			throw new Error("Stopping Multiplayer Play Mode requires confirm=true.");
		}
		const run = this._run;
		if (!run) {
			return { stopped: false, active: false, lastRun: this._lastRun };
		}
		if (run.state === "starting") {
			throw new Error("Multiplayer Play Mode is still starting; wait for start to finish before stopping.");
		}
		run.state = "stopping";
		run.revision++;
		this._changed();
		await this._release(editor, run);
		run.finishedAt = new Date().toISOString();
		this._lastRun = this._describeRun(run, "stopped");
		this._run = null;
		this._changed();
		return { stopped: true, active: false, lastRun: this._lastRun };
	}

	/** Applies one exact-revision control to a selected or all virtual players. */
	public async control(_editor: any, data: Record<string, unknown>): Promise<Record<string, unknown>> {
		const run = this._requireRun(data.expectedRunRevision);
		const command = data.command as MultiplayerPlayCommand;
		const playerIndex = data.playerIndex as number | undefined;
		const players = playerIndex === undefined ? run.players : [this._requirePlayer(run, playerIndex)];
		if (["pause", "resume"].includes(command)) {
			const virtualPlayers = players.filter((player) => !player.primary);
			if (!virtualPlayers.length) {
				throw new Error("Multiplayer pause/resume controls target virtual players; use the editor Play controls for the primary player.");
			}
			for (const player of virtualPlayers) {
				player.paused = command === "pause";
			}
		} else if (command === "render-frames") {
			const frames = data.frames as number;
			if (!Number.isSafeInteger(frames) || frames < 1 || frames > 600) {
				throw new Error("Multiplayer render-frames requires frames from 1 to 600.");
			}
			for (const player of players) {
				if (player.primary) {
					throw new Error("Primary Play rendering is editor-owned; render-frames targets only virtual players.");
				}
				if (!player.paused) {
					throw new Error("Pause a virtual player before deterministic render-frames control.");
				}
				for (let frame = 0; frame < frames; frame++) {
					player.scene.render();
				}
			}
		} else if (command === "input") {
			const player = this._requireSinglePlayer(players, command);
			player.runtime.submitInput(data.networkId as string, data.translation as [number, number, number], data.rotationDegrees as [number, number, number]);
		} else if (command === "rpc") {
			const player = this._requireSinglePlayer(players, command);
			player.runtime.sendRpc(data.name as string, data.target as "server" | "all" | "owner", data.payload, {
				channel: data.channel as "reliable" | "unreliable" | undefined,
				networkId: data.networkId as string | undefined,
			});
		} else if (command === "ownership") {
			const player = this._requireSinglePlayer(players, command);
			if (typeof data.claim !== "boolean") {
				throw new Error("Multiplayer ownership control requires claim as a boolean.");
			}
			player.runtime.setOwnership(data.networkId as string, data.claim);
		} else if (command === "set-simulation") {
			for (const player of players) {
				player.runtime.setSimulation(data.simulation as Partial<INetworkingSimulationConfiguration>);
			}
		} else if (command === "disconnect-player") {
			this._requireSinglePlayer(players, command).runtime.disconnect();
		} else if (command === "reconnect-player") {
			const player = this._requireSinglePlayer(players, command);
			player.runtime.reconnect();
			await this._waitConnected(player, 120_000);
		} else {
			throw new Error(`Unsupported Multiplayer Play Mode command: ${String(command)}.`);
		}
		run.revision++;
		this._changed();
		return this.status();
	}

	/** Returns credential-free per-player scene/runtime evidence. */
	public status(): Record<string, unknown> {
		return { active: Boolean(this._run), run: this._run ? this._describeRun(this._run) : null, lastRun: this._lastRun };
	}

	private async _waitConnected(player: IMultiplayerPlayer, timeoutMs: number): Promise<void> {
		await waitFor(
			() => player.runtime.status().state === "connected",
			() => (player.runtime.status().state === "error" ? player.runtime.status().lastError : null),
			timeoutMs
		);
	}

	private _startRenderTimer(player: IMultiplayerPlayer, tickRateHz: number): void {
		player.timer = setInterval(
			() => {
				if (player.paused || player.scene.isDisposed) {
					return;
				}
				try {
					player.scene.render();
				} catch (error) {
					player.lastError = boundedError(error);
					if (player.timer) {
						clearInterval(player.timer);
						player.timer = null;
					}
					this._changed();
				}
			},
			Math.max(4, Math.round(1_000 / tickRateHz))
		);
	}

	private async _release(editor: any, run: IMultiplayerRun): Promise<void> {
		for (const player of [...run.players].reverse()) {
			if (player.timer) {
				clearInterval(player.timer);
				player.timer = null;
			}
			player.runtime.disconnect();
			if (!player.primary) {
				player.scene.dispose();
				player.engine?.dispose();
			}
		}
		if (run.startedPlay) {
			editor.layout.preview.play.stop();
		}
		if (run.sessionId) {
			try {
				const session = this._host.getSession(run.sessionId);
				this._host.deleteSession(run.sessionId, session.revision, true);
			} catch {
				// Failed startup may have already removed or never created the session.
			}
		}
		if (run.startedHost) {
			try {
				if (this._host.listSessions().total === 0) {
					await this._host.stop(true);
				}
			} catch {
				// Cleanup continues even if the listener has already failed or stopped.
			}
		}
	}

	private _requireRun(expectedRevision: unknown): IMultiplayerRun {
		const run = this._run;
		if (!run || run.state !== "running") {
			throw new Error("Multiplayer Play Mode is not running.");
		}
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== run.revision) {
			throw new Error(`Multiplayer Play Mode revision is stale: expected ${String(expectedRevision)}, current ${run.revision}.`);
		}
		return run;
	}

	private _requirePlayer(run: IMultiplayerRun, index: number): IMultiplayerPlayer {
		if (!Number.isSafeInteger(index) || index < 0 || index >= run.players.length) {
			throw new Error(`Multiplayer playerIndex must be from 0 to ${Math.max(0, run.players.length - 1)}.`);
		}
		return run.players[index];
	}

	private _requireSinglePlayer(players: IMultiplayerPlayer[], command: string): IMultiplayerPlayer {
		if (players.length !== 1) {
			throw new Error(`Multiplayer ${command} requires playerIndex.`);
		}
		return players[0];
	}

	private _describeRun(run: IMultiplayerRun, state: string = run.state): Record<string, unknown> {
		return {
			id: run.id,
			revision: run.revision,
			state,
			configurationRevision: run.configurationRevision,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			playerCount: run.playerCount,
			sessionId: run.sessionId,
			startedHost: run.startedHost,
			startedPlay: run.startedPlay,
			lastError: run.lastError,
			players: run.players.map((player) => ({
				index: player.index,
				name: player.name,
				role: player.runtime.status().role ?? player.role,
				primary: player.primary,
				paused: player.paused,
				assignedNetworkId: player.assignedNetworkId,
				lastError: player.lastError,
				scene: {
					disposed: player.scene.isDisposed,
					meshes: player.scene.meshes.length,
					transformNodes: player.scene.transformNodes.length,
					animationGroups: player.scene.animationGroups.length,
				},
				runtime: player.runtime.status(),
			})),
		};
	}

	private _changed(): void {
		try {
			this._notify?.();
		} catch {
			// UI observation never owns runtime correctness.
		}
	}
}
