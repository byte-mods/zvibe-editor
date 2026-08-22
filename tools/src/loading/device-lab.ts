import type { Scene } from "@babylonjs/core/scene";

import { normalizePortableTestingState, runPortableTestSuites } from "../testing/testing";
import { capturePortableProfilerMemorySnapshot, PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS, startPortableProfilerCapture } from "../profiling/profiling";
import { IPortableProfilerCapture, IPortableProfilerSession } from "../profiling/types";

export const DEVICE_LAB_PROTOCOL_VERSION = 1 as const;

export interface IDeviceLabClientOptions {
	url: string;
	pairingToken: string;
	name?: string;
	metricsIntervalMs?: number;
}

export interface IDeviceLabClientStatus {
	connected: boolean;
	connecting: boolean;
	deviceId: string;
	url: string;
	logsSent: number;
	metricsSent: number;
	commandsHandled: number;
	lastError: string | null;
}

export interface IDeviceLabClient {
	status(): IDeviceLabClientStatus;
	disconnect(): void;
}

const clients = new WeakMap<Scene, IDeviceLabClient>();
const maximumLogArgumentLength = 4_096;
const maximumScreenshotBytes = 4 * 1024 * 1024;
const maximumTestingCommandBytes = 1024 * 1024;
const testingControllers = new Map<string, AbortController>();

function jsonByteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function boundedString(value: unknown, maximum = maximumLogArgumentLength): string {
	const text = String(value ?? "");
	return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function safeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
		return value ?? null;
	}
	if (typeof value === "string" || typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
		return boundedString(value);
	}
	if (value instanceof Error) {
		return { name: boundedString(value.name, 128), message: boundedString(value.message), stack: boundedString(value.stack, 16_384) };
	}
	if (depth >= 3 || typeof value !== "object") {
		return boundedString(value);
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value.slice(0, 32).map((entry) => safeValue(entry, depth + 1, seen));
	}
	const entries = Object.entries(value as Record<string, unknown>).slice(0, 32);
	return Object.fromEntries(entries.map(([key, entry]) => [boundedString(key, 128), safeValue(entry, depth + 1, seen)]));
}

function validateOptions(options: IDeviceLabClientOptions): Required<IDeviceLabClientOptions> {
	let url: URL;
	try {
		url = new URL(options.url);
	} catch {
		throw new Error("Device Lab URL must be an absolute ws:// or wss:// URL.");
	}
	if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
		throw new Error("Device Lab URL must use ws:// or wss:// without credentials or a fragment.");
	}
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.pairingToken)) {
		throw new Error("Device Lab pairingToken must be 32-128 URL-safe characters.");
	}
	const metricsIntervalMs = options.metricsIntervalMs ?? 500;
	if (!Number.isSafeInteger(metricsIntervalMs) || metricsIntervalMs < 100 || metricsIntervalMs > 10_000) {
		throw new Error("Device Lab metricsIntervalMs must be an integer from 100 to 10000.");
	}
	url.searchParams.set("token", options.pairingToken);
	return { url: url.toString(), pairingToken: options.pairingToken, name: boundedString(options.name || "Zvibe Player", 80), metricsIntervalMs };
}

function stableDeviceId(): string {
	const storageKey = "zvibe-device-lab-id";
	try {
		const existing = globalThis.sessionStorage?.getItem(storageKey);
		if (existing && /^[A-Za-z0-9_-]{8,128}$/.test(existing)) {
			return existing;
		}
		const id = globalThis.crypto?.randomUUID?.() ?? `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		globalThis.sessionStorage?.setItem(storageKey, id);
		return id;
	} catch {
		return `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}
}

function connectionIdentity(name: string, deviceId: string): any {
	const navigatorValue = globalThis.navigator as any;
	const screenValue = globalThis.screen as any;
	return {
		deviceId,
		name,
		platform: boundedString(navigatorValue?.userAgentData?.platform ?? navigatorValue?.platform ?? "unknown", 80),
		userAgent: boundedString(navigatorValue?.userAgent ?? "unknown", 1_024),
		language: boundedString(navigatorValue?.language ?? "unknown", 32),
		hardwareConcurrency: Number.isSafeInteger(navigatorValue?.hardwareConcurrency) ? navigatorValue.hardwareConcurrency : null,
		deviceMemoryGB: Number.isFinite(navigatorValue?.deviceMemory) ? navigatorValue.deviceMemory : null,
		touchPoints: Number.isSafeInteger(navigatorValue?.maxTouchPoints) ? navigatorValue.maxTouchPoints : null,
		screen: {
			width: Number.isFinite(screenValue?.width) ? screenValue.width : null,
			height: Number.isFinite(screenValue?.height) ? screenValue.height : null,
			devicePixelRatio: Number.isFinite(globalThis.devicePixelRatio) ? globalThis.devicePixelRatio : 1,
		},
	};
}

/** Connects one running exported player to an explicitly paired editor Device Lab. */
export function connectDeviceLab(scene: Scene, rawOptions: IDeviceLabClientOptions): IDeviceLabClient {
	const existing = clients.get(scene);
	if (existing) {
		return existing;
	}
	if (typeof WebSocket === "undefined") {
		throw new Error("Device Lab requires a browser-compatible WebSocket runtime.");
	}
	const options = validateOptions(rawOptions);
	const deviceId = stableDeviceId();
	let socket: WebSocket | null = null;
	let disposed = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let metricsTimer: ReturnType<typeof setInterval> | null = null;
	let reconnectAttempt = 0;
	let logsSent = 0;
	let metricsSent = 0;
	let commandsHandled = 0;
	let lastError: string | null = null;
	let connecting = false;
	const originals = new Map<"debug" | "info" | "log" | "warn" | "error", (...args: unknown[]) => void>();
	const clientTestingTokens = new Set<string>();
	const profilerSessions = new Map<string, IPortableProfilerSession>();
	const profilerCaptures = new Map<string, IPortableProfilerCapture>();
	const releasedProfilerTokens = new Set<string>();

	const send = (message: Record<string, unknown>): boolean => {
		if (!socket || socket.readyState !== WebSocket.OPEN) {
			return false;
		}
		try {
			socket.send(JSON.stringify({ protocol: "zvibe-device-lab", version: DEVICE_LAB_PROTOCOL_VERSION, ...message }));
			return true;
		} catch (error) {
			lastError = boundedString(error instanceof Error ? error.message : error);
			return false;
		}
	};

	const restoreConsole = (): void => {
		for (const [level, original] of originals) {
			console[level] = original;
		}
		originals.clear();
	};

	const installConsole = (): void => {
		if (originals.size) {
			return;
		}
		for (const level of ["debug", "info", "log", "warn", "error"] as const) {
			const original = console[level].bind(console);
			originals.set(level, console[level]);
			console[level] = (...args: unknown[]): void => {
				original(...args);
				if (send({ type: "logs", entries: [{ capturedAt: new Date().toISOString(), level, arguments: args.slice(0, 8).map((entry) => safeValue(entry)) }] })) {
					logsSent++;
				}
			};
		}
	};

	const metrics = (): any => {
		const engine = scene.getEngine();
		const memory = (globalThis.performance as any)?.memory;
		return {
			capturedAt: new Date().toISOString(),
			frameRate: engine.getFps(),
			frameTimeMs: engine.getDeltaTime(),
			drawCalls: (engine as any)._drawCalls?.current ?? null,
			activeMeshes: scene.getActiveMeshes().length,
			totalVertices: scene.getTotalVertices(),
			meshes: scene.meshes.length,
			materials: scene.materials.length,
			textures: scene.textures.length,
			particles: scene.particleSystems.length,
			usedHeapBytes: Number.isFinite(memory?.usedJSHeapSize) ? memory.usedJSHeapSize : null,
			totalHeapBytes: Number.isFinite(memory?.totalJSHeapSize) ? memory.totalJSHeapSize : null,
		};
	};

	const dispatchPointer = (command: any): void => {
		const canvas = scene.getEngine().getRenderingCanvas();
		if (!canvas || typeof PointerEvent === "undefined") {
			throw new Error("The player has no pointer-capable rendering canvas.");
		}
		const x = Math.min(1, Math.max(0, Number(command.x)));
		const y = Math.min(1, Math.max(0, Number(command.y)));
		const rect = canvas.getBoundingClientRect();
		const event = new PointerEvent(`pointer${command.action}`, {
			bubbles: true,
			cancelable: true,
			pointerId: 1,
			pointerType: "touch",
			isPrimary: true,
			clientX: rect.left + x * rect.width,
			clientY: rect.top + y * rect.height,
			button: 0,
			buttons: command.action === "up" ? 0 : 1,
		});
		canvas.dispatchEvent(event);
	};

	const waitTestFrames = async (_targetScene: any, frames: number, signal?: AbortSignal): Promise<void> => {
		for (let index = 0; index < frames; index++) {
			if (signal?.aborted) {
				throw new Error(typeof signal.reason === "string" ? signal.reason : "Connected-player test canceled.");
			}
			await new Promise<void>((resolve, reject) => {
				let observer: any = null;
				const onAbort = (): void => {
					if (observer) {
						scene.onAfterRenderObservable.remove(observer);
					}
					reject(new Error(typeof signal?.reason === "string" ? signal.reason : "Connected-player test canceled."));
				};
				observer = scene.onAfterRenderObservable.addOnce(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				});
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
	};

	const onCommand = async (message: any): Promise<void> => {
		if (message?.type !== "command" || typeof message.requestId !== "string") {
			return;
		}
		commandsHandled++;
		try {
			if (message.command === "screenshot") {
				const canvas = scene.getEngine().getRenderingCanvas();
				if (!canvas) {
					throw new Error("The player has no rendering canvas.");
				}
				const dataUrl = canvas.toDataURL("image/png");
				if (dataUrl.length > maximumScreenshotBytes * 1.4) {
					throw new Error("The player screenshot exceeds the 4 MiB Device Lab limit.");
				}
				send({ type: "response", requestId: message.requestId, ok: true, result: { dataUrl, width: canvas.width, height: canvas.height } });
			} else if (message.command === "input") {
				dispatchPointer(message);
				send({ type: "response", requestId: message.requestId, ok: true, result: { action: message.action, x: message.x, y: message.y } });
			} else if (message.command === "ping") {
				send({ type: "response", requestId: message.requestId, ok: true, result: { pongAt: new Date().toISOString() } });
			} else if (message.command === "run-tests") {
				if (typeof message.runToken !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(message.runToken)) {
					throw new Error("Connected-player test runToken is invalid.");
				}
				if (testingControllers.has(message.runToken)) {
					throw new Error("Connected-player test runToken is already active.");
				}
				const state = normalizePortableTestingState(message.state);
				const caseCount = state.suites.reduce((total, suite) => total + suite.tests.length, 0);
				const measurementFrames = state.suites.reduce(
					(total, suite) => total + suite.tests.reduce((caseTotal, test) => caseTotal + (test.performance?.measurementFrames ?? 0), 0),
					0
				);
				if (caseCount > 64 || measurementFrames > 4_096) {
					throw new Error("Connected-player test request exceeds the 64-case or 4096-measurement-frame transport cap.");
				}
				const controller = new AbortController();
				testingControllers.set(message.runToken, controller);
				clientTestingTokens.add(message.runToken);
				try {
					const report = await runPortableTestSuites(scene as any, state, message.request ?? {}, {
						target: "connected-player",
						sequence: Number.isSafeInteger(message.sequence) ? message.sequence : 1,
						signal: controller.signal,
						supportedModes: ["play"],
						waitFrames: waitTestFrames,
						dispatchPointer: (_targetScene, step) => dispatchPointer({ action: step.phase, x: step.x, y: step.y }),
						measureMetrics: () => metrics(),
					});
					if (jsonByteLength(report) > 5 * 1024 * 1024) {
						throw new Error("Connected-player test report exceeds the 5 MiB response cap.");
					}
					send({ type: "response", requestId: message.requestId, ok: true, result: report });
				} finally {
					testingControllers.delete(message.runToken);
					clientTestingTokens.delete(message.runToken);
				}
			} else if (message.command === "cancel-tests") {
				const controller = typeof message.runToken === "string" ? testingControllers.get(message.runToken) : null;
				controller?.abort("Connected-player test canceled by editor.");
				send({ type: "response", requestId: message.requestId, ok: true, result: { canceled: Boolean(controller), runToken: message.runToken } });
			} else if (message.command === "start-profiler") {
				if (typeof message.runToken !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(message.runToken)) {
					throw new Error("Connected-player profiler runToken is invalid.");
				}
				if (profilerSessions.has(message.runToken) || profilerCaptures.has(message.runToken)) {
					throw new Error("Connected-player profiler runToken is already active or retained.");
				}
				releasedProfilerTokens.delete(message.runToken);
				if (profilerSessions.size + profilerCaptures.size >= 8) {
					throw new Error("Connected-player profiler has reached its eight-session evidence limit; release a completed capture before starting another.");
				}
				const requested = message.options ?? {};
				if (!Number.isSafeInteger(requested.maximumFrames) || requested.maximumFrames < 1 || requested.maximumFrames > 3_600) {
					throw new Error("Connected-player profiling requires maximumFrames from 1 to 3600.");
				}
				if (!Number.isSafeInteger(requested.maximumDurationMs) || requested.maximumDurationMs < 100 || requested.maximumDurationMs > 600_000) {
					throw new Error("Connected-player profiling requires maximumDurationMs from 100 to 600000.");
				}
				const session = startPortableProfilerCapture(
					scene,
					{ ...requested, id: message.runToken, target: "connected-player" },
					{
						onStopped: (capture) => {
							profilerSessions.delete(message.runToken);
							profilerCaptures.set(message.runToken, capture);
						},
					}
				);
				profilerSessions.set(message.runToken, session);
				send({
					type: "response",
					requestId: message.requestId,
					ok: true,
					result: { runToken: message.runToken, status: session.capture.status, startedAt: session.capture.startedAt, maximumFrames: session.capture.maximumFrames },
				});
			} else if (message.command === "profiler-status") {
				const active = typeof message.runToken === "string" ? profilerSessions.get(message.runToken) : null;
				const capture = typeof message.runToken === "string" ? profilerCaptures.get(message.runToken) : null;
				const value = active?.capture ?? capture;
				if (!value) {
					throw new Error("Connected-player profiler capture was not found.");
				}
				send({
					type: "response",
					requestId: message.requestId,
					ok: true,
					result: {
						runToken: message.runToken,
						status: value.status,
						startedAt: value.startedAt,
						finishedAt: value.finishedAt,
						failure: value.failure,
						frameCount: value.frames.length,
						markerCount: value.markers.length,
						assetEventCount: value.assetEvents.length,
						summary: { ...value.summary, markers: [] },
					},
				});
			} else if (message.command === "capture-profiler-snapshot") {
				const active = typeof message.runToken === "string" ? profilerSessions.get(message.runToken) : null;
				if (!active) {
					throw new Error("Connected-player profiler capture is not active.");
				}
				if (active.capture.memorySnapshots.length >= PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS) {
					throw new Error(`Connected-player profiler captures retain at most ${PORTABLE_PROFILER_MAXIMUM_MEMORY_SNAPSHOTS} memory snapshots.`);
				}
				const snapshot = capturePortableProfilerMemorySnapshot(scene, String(message.name ?? "Memory Snapshot"), active.capture.id, active.capture.frames.length);
				active.capture.memorySnapshots.push(snapshot);
				send({ type: "response", requestId: message.requestId, ok: true, result: snapshot });
			} else if (message.command === "stop-profiler" || message.command === "cancel-profiler") {
				const active = typeof message.runToken === "string" ? profilerSessions.get(message.runToken) : null;
				if (active) {
					active.stop(message.command === "cancel-profiler" ? "canceled" : "completed", message.command === "cancel-profiler" ? "Canceled by editor." : undefined);
				}
				const capture = typeof message.runToken === "string" ? profilerCaptures.get(message.runToken) : null;
				if (!capture) {
					throw new Error("Connected-player profiler capture was not found.");
				}
				send({
					type: "response",
					requestId: message.requestId,
					ok: true,
					result: {
						runToken: message.runToken,
						status: capture.status,
						frameCount: capture.frames.length,
						markerCount: capture.markers.length,
						assetEventCount: capture.assetEvents.length,
					},
				});
			} else if (message.command === "get-profiler-data") {
				const capture = typeof message.runToken === "string" ? profilerCaptures.get(message.runToken) : null;
				if (!capture) {
					throw new Error("Completed connected-player profiler capture was not found.");
				}
				const kind = message.kind;
				const offset = Number.isSafeInteger(message.offset) ? Math.max(0, message.offset) : 0;
				// These per-kind ceilings include the worst-case UTF-8 expansion of every bounded text field, keeping one valid page below the 5 MiB response envelope.
				const maximum = kind === "description" ? 1 : kind === "memory-snapshots" ? 4 : kind === "markers" || kind === "asset-events" ? 200 : 500;
				const limit = Number.isSafeInteger(message.limit) ? Math.min(maximum, Math.max(1, message.limit)) : maximum;
				let result: any;
				if (kind === "description") {
					const { frames, markers, assetEvents, memorySnapshots, ...description } = capture;
					result = {
						description: { ...description, memorySnapshots: [], summary: { ...description.summary, markers: [] } },
						totals: { frames: frames.length, markers: markers.length, assetEvents: assetEvents.length, memorySnapshots: memorySnapshots.length },
					};
				} else if (kind === "frames") {
					result = { total: capture.frames.length, offset, limit, entries: capture.frames.slice(offset, offset + limit) };
				} else if (kind === "markers") {
					result = { total: capture.markers.length, offset, limit, entries: capture.markers.slice(offset, offset + limit) };
				} else if (kind === "asset-events") {
					result = { total: capture.assetEvents.length, offset, limit, entries: capture.assetEvents.slice(offset, offset + limit) };
				} else if (kind === "memory-snapshots") {
					result = { total: capture.memorySnapshots.length, offset, limit, entries: capture.memorySnapshots.slice(offset, offset + limit) };
				} else {
					throw new Error("Profiler data kind must be description, frames, markers, asset-events, or memory-snapshots.");
				}
				if (jsonByteLength(result) > 5 * 1024 * 1024) {
					throw new Error("Connected-player profiler data page exceeds the 5 MiB response cap; request a smaller limit.");
				}
				send({ type: "response", requestId: message.requestId, ok: true, result });
			} else if (message.command === "release-profiler") {
				const released = typeof message.runToken === "string" && (profilerCaptures.delete(message.runToken) || releasedProfilerTokens.has(message.runToken));
				if (released && typeof message.runToken === "string") {
					releasedProfilerTokens.add(message.runToken);
					while (releasedProfilerTokens.size > 32) {
						releasedProfilerTokens.delete(releasedProfilerTokens.values().next().value!);
					}
				}
				send({ type: "response", requestId: message.requestId, ok: true, result: { released, runToken: message.runToken } });
			} else {
				throw new Error("Unsupported Device Lab command.");
			}
		} catch (error) {
			send({ type: "response", requestId: message.requestId, ok: false, error: boundedString(error instanceof Error ? error.message : error) });
		}
	};

	const scheduleReconnect = (): void => {
		if (disposed || reconnectTimer) {
			return;
		}
		const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempt++, 5));
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			open();
		}, delay);
	};

	function open(): void {
		if (disposed || socket) {
			return;
		}
		connecting = true;
		try {
			const candidate = new WebSocket(options.url);
			socket = candidate;
			candidate.addEventListener("open", () => {
				if (socket !== candidate || disposed) {
					return;
				}
				connecting = false;
				reconnectAttempt = 0;
				lastError = null;
				send({
					type: "hello",
					identity: connectionIdentity(options.name, deviceId),
					capabilities: ["logs", "metrics", "screenshot", "pointer-input", "portable-tests", "portable-profiler"],
				});
				installConsole();
				metricsTimer ??= setInterval(() => {
					if (send({ type: "metrics", sample: metrics() })) {
						metricsSent++;
					}
				}, options.metricsIntervalMs);
			});
			candidate.addEventListener("message", (event) => {
				if (socket !== candidate || typeof event.data !== "string" || event.data.length > maximumTestingCommandBytes) {
					return;
				}
				try {
					void onCommand(JSON.parse(event.data));
				} catch {
					lastError = "Device Lab sent malformed JSON.";
				}
			});
			candidate.addEventListener("error", () => {
				lastError = "Device Lab WebSocket connection failed.";
			});
			candidate.addEventListener("close", () => {
				if (socket === candidate) {
					socket = null;
					connecting = false;
					if (metricsTimer) {
						clearInterval(metricsTimer);
						metricsTimer = null;
					}
					restoreConsole();
					for (const token of clientTestingTokens) {
						testingControllers.get(token)?.abort("Device Lab transport disconnected.");
						testingControllers.delete(token);
					}
					clientTestingTokens.clear();
					for (const session of profilerSessions.values()) {
						session.stop("canceled", "Device Lab transport disconnected.");
					}
					profilerSessions.clear();
					// The editor discards ownership on transport loss, so disconnected evidence must not orphan one of the player's eight profiler slots across reconnects.
					profilerCaptures.clear();
					releasedProfilerTokens.clear();
					scheduleReconnect();
				}
			});
		} catch (error) {
			socket = null;
			connecting = false;
			lastError = boundedString(error instanceof Error ? error.message : error);
			scheduleReconnect();
		}
	}

	const client: IDeviceLabClient = {
		status: (): IDeviceLabClientStatus => ({
			connected: socket?.readyState === WebSocket.OPEN,
			connecting,
			deviceId,
			url: options.url.replace(/([?&]token=)[^&]+/, "$1<redacted>"),
			logsSent,
			metricsSent,
			commandsHandled,
			lastError,
		}),
		disconnect: (): void => {
			if (disposed) {
				return;
			}
			disposed = true;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
			}
			if (metricsTimer) {
				clearInterval(metricsTimer);
			}
			restoreConsole();
			for (const token of clientTestingTokens) {
				testingControllers.get(token)?.abort("Device Lab client disconnected.");
				testingControllers.delete(token);
			}
			clientTestingTokens.clear();
			for (const session of profilerSessions.values()) {
				session.stop("canceled", "Device Lab client disconnected.");
			}
			profilerSessions.clear();
			profilerCaptures.clear();
			releasedProfilerTokens.clear();
			socket?.close(1000, "Player disposed");
			socket = null;
			clients.delete(scene);
		},
	};
	clients.set(scene, client);
	scene.onDisposeObservable.addOnce(() => client.disconnect());
	open();
	return client;
}

/** Auto-connects only when an explicit ephemeral pairing URL and token are present. */
export function configureDeviceLabFromLocation(scene: Scene): IDeviceLabClient | null {
	if (typeof globalThis.location === "undefined") {
		return null;
	}
	const parameters = new URLSearchParams(globalThis.location.search);
	const url = parameters.get("zvibeDeviceLab");
	const pairingToken = parameters.get("zvibePairingToken");
	if (!url || !pairingToken) {
		return null;
	}
	return connectDeviceLab(scene, { url, pairingToken, name: parameters.get("zvibeDeviceName") ?? undefined });
}

export function getDeviceLabClient(scene: Scene): IDeviceLabClient | null {
	return clients.get(scene) ?? null;
}
