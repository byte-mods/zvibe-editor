import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { networkInterfaces } from "os";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

declare const require: (id: string) => any;

export const DEVICE_LAB_PROTOCOL_VERSION = 1 as const;

type DeviceLabState = "stopped" | "starting" | "listening" | "stopping" | "error";

interface IDeviceLogEntry {
	sequence: number;
	capturedAt: string;
	receivedAt: string;
	level: "debug" | "info" | "log" | "warn" | "error";
	arguments: unknown[];
}

interface IDeviceMetricSample {
	sequence: number;
	receivedAt: string;
	[key: string]: unknown;
}

interface IConnectedDevice {
	connectionId: string;
	socket: any;
	identity: any;
	capabilities: string[];
	connectedAt: string;
	lastSeenAt: string;
	logs: IDeviceLogEntry[];
	metrics: IDeviceMetricSample[];
	latestScreenshot: { imageBase64: string; mimeType: "image/png"; width: number; height: number; capturedAt: string } | null;
	nextLogSequence: number;
	nextMetricSequence: number;
	alive: boolean;
}

interface IPendingRequest {
	connectionId: string;
	command: string;
	timer: ReturnType<typeof setTimeout>;
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

const maximumFrameBytes = 6 * 1024 * 1024;
const maximumLogEntries = 2_000;
const maximumMetricSamples = 1_200;
const maximumScreenshotBase64Length = Math.ceil((4 * 1024 * 1024 * 4) / 3) + 128;
const maximumTestCommandBytes = 1024 * 1024;
const maximumTestReportBytes = 5 * 1024 * 1024;
const deviceIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const capabilityPattern = /^[a-z][a-z0-9-]{0,63}$/;

function boundedText(value: unknown, maximum: number): string {
	const text = String(value ?? "");
	return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

function safeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined || typeof value === "boolean") {
		return value ?? null;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (["string", "bigint", "symbol", "function"].includes(typeof value)) {
		return boundedText(value, 4_096);
	}
	if (depth >= 3 || typeof value !== "object") {
		return boundedText(value, 4_096);
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value.slice(0, 32).map((entry) => safeValue(entry, depth + 1, seen));
	}
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.slice(0, 32)
			.map(([key, entry]) => [boundedText(key, 128), safeValue(entry, depth + 1, seen)])
	);
}

function exactRecord(value: any, keys: string[]): boolean {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Reflect.ownKeys(value).length === keys.length &&
		Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key))
	);
}

function validProfilerTimestamp(value: unknown, nullable = false): boolean {
	if (nullable && value === null) {
		return true;
	}
	if (typeof value !== "string" || value.length > 80) {
		return false;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validProfilerStatus(value: any, runToken: string): boolean {
	const numericSummary = (summary: any): boolean =>
		exactRecord(summary, ["minimum", "maximum", "average", "median", "p95", "latest", "samples"]) &&
		["minimum", "maximum", "average", "median", "p95", "latest"].every((key) => typeof summary[key] === "number" && Number.isFinite(summary[key]) && summary[key] >= 0) &&
		summary.minimum <= summary.median &&
		summary.median <= summary.p95 &&
		summary.p95 <= summary.maximum &&
		summary.average >= summary.minimum &&
		summary.average <= summary.maximum &&
		summary.latest >= summary.minimum &&
		summary.latest <= summary.maximum &&
		Number.isSafeInteger(summary.samples) &&
		summary.samples >= 1 &&
		summary.samples <= value.frameCount;
	const summary = value?.summary;
	const terminal = value?.status !== "recording";
	const coherentStatus =
		(value?.status === "recording" && value.finishedAt === null && value.failure === null) ||
		(value?.status === "completed" && typeof value.finishedAt === "string" && value.failure === null) ||
		(value?.status === "canceled" && typeof value.finishedAt === "string") ||
		(value?.status === "failed" && typeof value.finishedAt === "string" && typeof value.failure === "string" && Boolean(value.failure.trim()));
	return (
		exactRecord(value, ["runToken", "status", "startedAt", "finishedAt", "failure", "frameCount", "markerCount", "assetEventCount", "summary"]) &&
		value.runToken === runToken &&
		["recording", "completed", "canceled", "failed"].includes(value.status) &&
		coherentStatus &&
		validProfilerTimestamp(value.startedAt) &&
		validProfilerTimestamp(value.finishedAt, true) &&
		(value.finishedAt === null || Date.parse(value.finishedAt) >= Date.parse(value.startedAt)) &&
		(value.failure === null || (typeof value.failure === "string" && value.failure.length <= 2_048)) &&
		[value.frameCount, value.markerCount, value.assetEventCount].every((entry) => Number.isSafeInteger(entry) && entry >= 0) &&
		value.frameCount <= 3_600 &&
		value.markerCount <= 250_000 &&
		value.assetEventCount <= 50_000 &&
		exactRecord(summary, ["frames", "durationMs", "metrics", "markers", "assetRequests", "assetTransferBytes"]) &&
		Number.isSafeInteger(summary.frames) &&
		summary.frames >= 0 &&
		summary.frames <= value.frameCount &&
		(!terminal || summary.frames === value.frameCount) &&
		typeof summary.durationMs === "number" &&
		Number.isFinite(summary.durationMs) &&
		summary.durationMs >= 0 &&
		summary.durationMs <= 3_600_000 &&
		Boolean(summary.metrics) &&
		typeof summary.metrics === "object" &&
		!Array.isArray(summary.metrics) &&
		Object.keys(summary.metrics).length <= 256 &&
		Object.keys(summary.metrics).every((key) => /^[A-Za-z][A-Za-z0-9_.-]{0,239}$/.test(key) && numericSummary(summary.metrics[key])) &&
		Array.isArray(summary.markers) &&
		summary.markers.length === 0 &&
		Number.isSafeInteger(summary.assetRequests) &&
		summary.assetRequests <= value.assetEventCount &&
		(!terminal || summary.assetRequests === value.assetEventCount) &&
		(summary.assetTransferBytes === null || (typeof summary.assetTransferBytes === "number" && Number.isFinite(summary.assetTransferBytes) && summary.assetTransferBytes >= 0))
	);
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

function constantTimeTokenEquals(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}

function summarizeMetrics(samples: IDeviceMetricSample[]): Record<string, { min: number; max: number; average: number }> {
	const keys = new Set(samples.flatMap((sample) => Object.keys(sample)).filter((key) => !["sequence", "receivedAt", "capturedAt"].includes(key)));
	const result: Record<string, { min: number; max: number; average: number }> = {};
	for (const key of keys) {
		const values = samples.map((sample) => sample[key]).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
		if (values.length) {
			result[key] = { min: Math.min(...values), max: Math.max(...values), average: values.reduce((sum, value) => sum + value, 0) / values.length };
		}
	}
	return result;
}

class DeviceLabHub {
	private _state: DeviceLabState = "stopped";
	private _server: any = null;
	private _host = "127.0.0.1";
	private _advertisedHost = "127.0.0.1";
	private _port = 0;
	private _pairingToken: string | null = null;
	private _pairingExpiresAt = 0;
	private _startedAt: string | null = null;
	private _lastError: string | null = null;
	private _devices = new Map<string, IConnectedDevice>();
	private _pending = new Map<string, IPendingRequest>();
	private _profilerReservations = new Map<string, Set<string>>();
	private _profilerDisconnectCallbacks = new Map<string, Map<string, () => void>>();
	private _heartbeat: ReturnType<typeof setInterval> | null = null;
	private _notifyTimer: ReturnType<typeof setTimeout> | null = null;
	private _editor: any = null;

	public capabilities(): any {
		return {
			version: DEVICE_LAB_PROTOCOL_VERSION,
			simulator: {
				profiles: true,
				orientation: true,
				safeArea: true,
				touch: "single-primary-pointer",
				simulatedClasses: ["Application", "Screen", "SystemInfo"],
				limitations: ["Hardware performance, rendering capability, native plugins, platform defines, and gyroscope behavior are not simulated."],
			},
			remotePlayer: {
				transport: "authenticated-outbound-websocket-v1",
				capabilities: [
					"bounded logs",
					"bounded live metrics",
					"PNG screenshot",
					"acknowledged normalized pointer input",
					"portable Play test execution",
					"paged portable profiler captures",
				],
				platforms: ["Web", "Electron", "Android/iOS Capacitor WebView"],
				limitations: ["OS-wide logs, native deployment/signing, screen recording, and deep CPU/GPU profiling remain external or owned by other parity rows."],
			},
		};
	}

	public status(): any {
		return {
			state: this._state,
			listening: this._state === "listening",
			host: this._host,
			advertisedHost: this._advertisedHost,
			port: this._port,
			startedAt: this._startedAt,
			pairingExpiresAt: this._pairingExpiresAt ? new Date(this._pairingExpiresAt).toISOString() : null,
			pairingTokenAvailable: Boolean(this._pairingToken && Date.now() < this._pairingExpiresAt),
			connectionCount: this._devices.size,
			pendingRequestCount: this._pending.size,
			profilerReservationCount: [...this._profilerReservations.values()].reduce((total, entries) => total + entries.size, 0),
			lastError: this._lastError,
			security: {
				loopbackOnly: isLoopbackHost(this._host),
				tokenPersisted: false,
				tls: false,
				warning: isLoopbackHost(this._host) ? null : "LAN mode uses ws://; use only on a trusted network or place a TLS terminator in front of the Device Lab.",
			},
		};
	}

	public async start(data: any, options: IMCPActionOptions): Promise<any> {
		if (this._state !== "stopped" && this._state !== "error") {
			throw new Error("Device Lab is already active or changing state.");
		}
		const allowed = new Set(["endpoint", "collaborationToken", "host", "advertisedHost", "port", "pairingMinutes", "confirm"]);
		const unknown = Object.keys(data).filter((key) => !allowed.has(key));
		if (unknown.length) {
			throw new Error(`Unknown Device Lab start field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
		}
		const host = data.host ?? "127.0.0.1";
		if (typeof host !== "string" || !/^[A-Za-z0-9.:-]{1,255}$/.test(host)) {
			throw new Error("Device Lab host must be a simple hostname or IP address.");
		}
		if (!isLoopbackHost(host) && data.confirm !== true) {
			throw new Error("Listening beyond loopback exposes Device Lab on the network and requires confirm=true.");
		}
		const port = data.port ?? 0;
		if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) {
			throw new Error("Device Lab port must be 0 for automatic selection or an integer from 1024 to 65535.");
		}
		const pairingMinutes = data.pairingMinutes ?? 30;
		if (!Number.isSafeInteger(pairingMinutes) || pairingMinutes < 1 || pairingMinutes > 1_440) {
			throw new Error("Device Lab pairingMinutes must be an integer from 1 to 1440.");
		}
		const advertisedHost = data.advertisedHost ?? (isLoopbackHost(host) ? "127.0.0.1" : firstLanAddress());
		if (typeof advertisedHost !== "string" || !/^[A-Za-z0-9.:-]{1,255}$/.test(advertisedHost) || ["0.0.0.0", "::"].includes(advertisedHost)) {
			throw new Error("A concrete advertisedHost is required for Device Lab pairing.");
		}

		this._state = "starting";
		this._lastError = null;
		this._host = host;
		this._advertisedHost = advertisedHost;
		this._editor = options.editor;
		this._pairingToken = randomBytes(32).toString("base64url");
		this._pairingExpiresAt = Date.now() + pairingMinutes * 60_000;
		const { WebSocketServer } = require("ws");
		try {
			const server = new WebSocketServer({ host, port, maxPayload: maximumFrameBytes, perMessageDeflate: false, clientTracking: true });
			this._server = server;
			await new Promise<void>((resolve, reject) => {
				const onError = (error: Error): void => {
					reject(error);
				};
				const onListening = (): void => {
					server.off("error", onError);
					resolve();
				};
				server.once("listening", onListening);
				server.once("error", onError);
			});
			const address = server.address();
			this._port = typeof address === "object" && address ? address.port : port;
			this._state = "listening";
			this._startedAt = new Date().toISOString();
			server.on("connection", (socket: any, request: any) => this._onConnection(socket, request));
			server.on("error", (error: Error) => {
				this._lastError = boundedText(error.message, 1_024);
				this._state = "error";
				this._notify();
			});
			this._heartbeat = setInterval(() => this._heartbeatDevices(), 15_000);
			this._notify();
			const wsUrl = `ws://${this._formatHost(this._advertisedHost)}:${this._port}`;
			return {
				...this.status(),
				pairing: {
					wsUrl,
					pairingToken: this._pairingToken,
					queryParameters: { zvibeDeviceLab: wsUrl, zvibePairingToken: this._pairingToken },
				},
			};
		} catch (error) {
			this._lastError = boundedText(error instanceof Error ? error.message : error, 1_024);
			await this.stop(false);
			this._state = "error";
			throw new Error(`Device Lab failed to listen: ${this._lastError}`);
		}
	}

	public async stop(requireConfirmation: boolean): Promise<any> {
		if (requireConfirmation && this._devices.size > 0) {
			throw new Error("Stopping Device Lab disconnects active players and requires confirm=true.");
		}
		if (this._profilerReservations.size > 0) {
			throw new Error("Stop or cancel every connected-player profiler capture before stopping Device Lab.");
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
		for (const device of this._devices.values()) {
			device.socket.close(1001, "Device Lab stopped");
		}
		for (const [requestId, pending] of this._pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Device Lab stopped before the remote player responded."));
			this._pending.delete(requestId);
		}
		this._devices.clear();
		const server = this._server;
		this._server = null;
		await new Promise<void>((resolve) => server.close(() => resolve()));
		this._state = "stopped";
		this._port = 0;
		this._pairingToken = null;
		this._pairingExpiresAt = 0;
		this._startedAt = null;
		this._editor = null;
		this._notify();
		return { stopped: true, ...this.status() };
	}

	public devices(): any {
		return { devices: [...this._devices.values()].map((device) => this._describeDevice(device)) };
	}

	public logs(data: any): any {
		const device = this._requireDevice(data.connectionId);
		const offset = data.offset ?? 0;
		const limit = data.limit ?? 200;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error("Remote device log offset/limit is invalid.");
		}
		const levels = data.levels ? new Set(data.levels) : null;
		const query = typeof data.query === "string" ? data.query.toLowerCase() : null;
		const filtered = device.logs.filter((entry) => (!levels || levels.has(entry.level)) && (!query || JSON.stringify(entry.arguments).toLowerCase().includes(query)));
		return { device: this._describeDevice(device), total: filtered.length, offset, limit, entries: structuredClone(filtered.slice(offset, offset + limit)) };
	}

	public metrics(data: any): any {
		const device = this._requireDevice(data.connectionId);
		const offset = data.offset ?? 0;
		const limit = data.limit ?? 200;
		if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
			throw new Error("Remote device metric offset/limit is invalid.");
		}
		return {
			device: this._describeDevice(device),
			total: device.metrics.length,
			offset,
			limit,
			summary: summarizeMetrics(device.metrics),
			samples: structuredClone(device.metrics.slice(offset, offset + limit)),
		};
	}

	public async screenshot(data: any): Promise<any> {
		const device = this._requireDevice(data.connectionId);
		if (!device.capabilities.includes("screenshot")) {
			throw new Error("The selected remote player did not advertise screenshot support.");
		}
		const result = await this._request(device, { command: "screenshot" }, data.timeoutMs ?? 10_000);
		if (
			typeof result?.dataUrl !== "string" ||
			!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.dataUrl) ||
			result.dataUrl.length > maximumScreenshotBase64Length ||
			!Number.isSafeInteger(result.width) ||
			result.width < 1 ||
			result.width > 16_384 ||
			!Number.isSafeInteger(result.height) ||
			result.height < 1 ||
			result.height > 16_384
		) {
			throw new Error("Remote player returned an invalid or oversized PNG screenshot.");
		}
		device.latestScreenshot = {
			imageBase64: result.dataUrl.slice(result.dataUrl.indexOf(",") + 1),
			mimeType: "image/png",
			width: result.width,
			height: result.height,
			capturedAt: new Date().toISOString(),
		};
		this._notify();
		return structuredClone(device.latestScreenshot);
	}

	public async input(data: any): Promise<any> {
		if (data.confirm !== true) {
			throw new Error("Sending input to a remote player requires confirm=true.");
		}
		const device = this._requireDevice(data.connectionId);
		if (!device.capabilities.includes("pointer-input")) {
			throw new Error("The selected remote player did not advertise pointer-input support.");
		}
		if (!["down", "move", "up"].includes(data.action) || !Number.isFinite(data.x) || data.x < 0 || data.x > 1 || !Number.isFinite(data.y) || data.y < 0 || data.y > 1) {
			throw new Error("Remote pointer input requires action down/move/up and normalized x/y from 0 to 1.");
		}
		const result = await this._request(device, { command: "input", action: data.action, x: data.x, y: data.y }, data.timeoutMs ?? 5_000);
		return { sent: true, acknowledged: true, connectionId: device.connectionId, result };
	}

	public async tests(data: any): Promise<any> {
		if (data.confirm !== true) {
			throw new Error("Running tests on a connected player requires confirm=true.");
		}
		const device = this._requireDevice(data.connectionId);
		if (!device.capabilities.includes("portable-tests")) {
			throw new Error("The selected remote player did not advertise portable-tests support.");
		}
		if (typeof data.runToken !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(data.runToken)) {
			throw new Error("Connected-player test runToken is invalid.");
		}
		const command = { command: "run-tests", runToken: data.runToken, state: data.state, request: data.request ?? {}, sequence: data.sequence ?? 1 };
		if (Buffer.byteLength(JSON.stringify(command), "utf8") > maximumTestCommandBytes) {
			throw new Error("Connected-player test command exceeds the 1 MiB transport cap.");
		}
		const report = await this._request(device, command, data.timeoutMs ?? 120_000);
		if (
			!report ||
			typeof report !== "object" ||
			report.target !== "connected-player" ||
			!Array.isArray(report.results) ||
			Buffer.byteLength(JSON.stringify(report), "utf8") > maximumTestReportBytes
		) {
			throw new Error("Connected player returned an invalid or oversized test report.");
		}
		return structuredClone(report);
	}

	public async cancelTests(data: any): Promise<any> {
		const device = this._requireDevice(data.connectionId);
		if (typeof data.runToken !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(data.runToken)) {
			throw new Error("Connected-player test runToken is invalid.");
		}
		return this._request(device, { command: "cancel-tests", runToken: data.runToken }, data.timeoutMs ?? 5_000);
	}

	public async profiler(
		data: any,
		command: "start-profiler" | "profiler-status" | "capture-profiler-snapshot" | "stop-profiler" | "cancel-profiler" | "get-profiler-data" | "release-profiler"
	): Promise<any> {
		const mutating = command !== "profiler-status" && command !== "get-profiler-data";
		if (mutating && data.confirm !== true) {
			throw new Error(`Remote profiler command "${command}" requires confirm=true.`);
		}
		const device = this._requireDevice(data.connectionId);
		if (!device.capabilities.includes("portable-profiler")) {
			throw new Error("The selected remote player did not advertise portable-profiler support.");
		}
		if (typeof data.runToken !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(data.runToken)) {
			throw new Error("Connected-player profiler runToken is invalid.");
		}
		const payload: Record<string, unknown> = { command, runToken: data.runToken };
		if (command === "start-profiler") {
			payload.options = data.options;
		}
		if (command === "get-profiler-data") {
			payload.kind = data.kind;
			payload.offset = data.offset;
			payload.limit = data.limit;
		}
		if (command === "capture-profiler-snapshot") {
			payload.name = data.name;
		}
		if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maximumTestCommandBytes) {
			throw new Error("Connected-player profiler command exceeds the 1 MiB transport cap.");
		}
		const result = await this._request(device, payload, data.timeoutMs ?? (command === "start-profiler" ? 30_000 : 10_000));
		if (!result || typeof result !== "object" || Buffer.byteLength(JSON.stringify(result), "utf8") > maximumTestReportBytes) {
			throw new Error("Connected player returned invalid or oversized profiler data.");
		}
		if (command === "profiler-status" && !validProfilerStatus(result, data.runToken)) {
			throw new Error("Connected player returned invalid profiler status evidence.");
		}
		return structuredClone(result);
	}

	public disconnect(data: any): any {
		if (data.confirm !== true) {
			throw new Error("Disconnecting a remote player requires confirm=true.");
		}
		const device = this._requireDevice(data.connectionId);
		if (this._profilerReservations.has(device.connectionId)) {
			throw new Error("Stop or cancel the connected-player profiler capture before disconnecting this player.");
		}
		device.socket.close(4000, "Disconnected by editor");
		return { disconnected: true, connectionId: device.connectionId };
	}

	public clear(data: any): any {
		if (data.confirm !== true) {
			throw new Error("Clearing remote player evidence requires confirm=true.");
		}
		const device = this._requireDevice(data.connectionId);
		const cleared = { logs: device.logs.length, metrics: device.metrics.length, screenshot: Boolean(device.latestScreenshot) };
		device.logs.length = 0;
		device.metrics.length = 0;
		device.latestScreenshot = null;
		this._notify();
		return { cleared: true, connectionId: device.connectionId, removed: cleared };
	}

	public reserveProfiler(connectionId: unknown, runToken: unknown, onDisconnect?: () => void): () => void {
		const device = this._requireDevice(connectionId);
		if (typeof runToken !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(runToken)) {
			throw new Error("Connected-player profiler runToken is invalid.");
		}
		const reservations = this._profilerReservations.get(device.connectionId) ?? new Set<string>();
		if (reservations.has(runToken)) {
			throw new Error(`Connected-player profiler runToken is already reserved: ${runToken}`);
		}
		reservations.add(runToken);
		this._profilerReservations.set(device.connectionId, reservations);
		if (onDisconnect) {
			const callbacks = this._profilerDisconnectCallbacks.get(device.connectionId) ?? new Map<string, () => void>();
			callbacks.set(runToken, onDisconnect);
			this._profilerDisconnectCallbacks.set(device.connectionId, callbacks);
		}
		return (): void => {
			const current = this._profilerReservations.get(device.connectionId);
			current?.delete(runToken);
			if (!current?.size) {
				this._profilerReservations.delete(device.connectionId);
			}
			const callbacks = this._profilerDisconnectCallbacks.get(device.connectionId);
			callbacks?.delete(runToken);
			if (!callbacks?.size) {
				this._profilerDisconnectCallbacks.delete(device.connectionId);
			}
		};
	}

	private _formatHost(host: string): string {
		return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	}

	private _onConnection(socket: any, request: any): void {
		let token: string | null = null;
		try {
			token = new URL(request.url ?? "/", `ws://${request.headers.host ?? "localhost"}`).searchParams.get("token");
		} catch {
			// Rejected below.
		}
		if (!this._pairingToken || Date.now() >= this._pairingExpiresAt || !token || !constantTimeTokenEquals(token, this._pairingToken)) {
			socket.close(4401, "Invalid or expired pairing token");
			return;
		}
		const connectionId = randomUUID();
		const handshakeTimer = setTimeout(() => socket.close(4408, "Device hello timeout"), 5_000);
		socket.on("pong", () => {
			const device = this._devices.get(connectionId);
			if (device) {
				device.alive = true;
				device.lastSeenAt = new Date().toISOString();
			}
		});
		socket.on("message", (bytes: Buffer, isBinary: boolean) => {
			if (isBinary || bytes.byteLength > maximumFrameBytes) {
				socket.close(4409, "Invalid Device Lab frame");
				return;
			}
			let message: any;
			try {
				message = JSON.parse(bytes.toString("utf8"));
			} catch {
				socket.close(4402, "Malformed JSON");
				return;
			}
			if (!this._devices.has(connectionId)) {
				try {
					const device = this._acceptHello(connectionId, socket, message);
					clearTimeout(handshakeTimer);
					this._devices.set(connectionId, device);
					socket.send(JSON.stringify({ protocol: "zvibe-device-lab", version: DEVICE_LAB_PROTOCOL_VERSION, type: "welcome", connectionId }));
					this._notify();
				} catch (error) {
					socket.close(4402, boundedText(error instanceof Error ? error.message : error, 120));
				}
				return;
			}
			this._onMessage(this._devices.get(connectionId)!, message);
		});
		socket.on("close", () => {
			clearTimeout(handshakeTimer);
			this._rejectPendingForConnection(connectionId, "Remote player disconnected.");
			this._devices.delete(connectionId);
			const disconnectCallbacks = [...(this._profilerDisconnectCallbacks.get(connectionId)?.values() ?? [])];
			this._profilerDisconnectCallbacks.delete(connectionId);
			this._profilerReservations.delete(connectionId);
			for (const callback of disconnectCallbacks) {
				try {
					callback();
				} catch {
					// One scene cleanup must not prevent other reservations on the same player from releasing.
				}
			}
			this._notify();
		});
		socket.on("error", () => undefined);
	}

	private _acceptHello(connectionId: string, socket: any, message: any): IConnectedDevice {
		if (message?.protocol !== "zvibe-device-lab" || message.version !== DEVICE_LAB_PROTOCOL_VERSION || message.type !== "hello") {
			throw new Error("Expected Device Lab version-1 hello.");
		}
		const identity = safeValue(message.identity) as any;
		if (!identity || !deviceIdPattern.test(identity.deviceId) || typeof identity.name !== "string" || !identity.name.trim() || identity.name.length > 80) {
			throw new Error("Device identity is invalid.");
		}
		const capabilities: string[] = Array.isArray(message.capabilities)
			? [...new Set<string>(message.capabilities.filter((value: unknown): value is string => typeof value === "string" && capabilityPattern.test(value)))].slice(0, 32)
			: [];
		const now = new Date().toISOString();
		return {
			connectionId,
			socket,
			identity,
			capabilities,
			connectedAt: now,
			lastSeenAt: now,
			logs: [],
			metrics: [],
			latestScreenshot: null,
			nextLogSequence: 1,
			nextMetricSequence: 1,
			alive: true,
		};
	}

	private _onMessage(device: IConnectedDevice, message: any): void {
		if (message?.protocol !== "zvibe-device-lab" || message.version !== DEVICE_LAB_PROTOCOL_VERSION) {
			device.socket.close(4402, "Protocol mismatch");
			return;
		}
		device.lastSeenAt = new Date().toISOString();
		if (message.type === "logs" && Array.isArray(message.entries) && message.entries.length <= 64) {
			for (const raw of message.entries) {
				if (!["debug", "info", "log", "warn", "error"].includes(raw?.level) || !Array.isArray(raw?.arguments)) {
					continue;
				}
				device.logs.push({
					sequence: device.nextLogSequence++,
					capturedAt: typeof raw.capturedAt === "string" ? boundedText(raw.capturedAt, 64) : device.lastSeenAt,
					receivedAt: device.lastSeenAt,
					level: raw.level,
					arguments: raw.arguments.slice(0, 8).map((entry: unknown) => safeValue(entry)),
				});
			}
			device.logs.splice(0, Math.max(0, device.logs.length - maximumLogEntries));
			this._notify();
			return;
		}
		if (message.type === "metrics" && message.sample && typeof message.sample === "object" && !Array.isArray(message.sample)) {
			device.metrics.push({ ...(safeValue(message.sample) as Record<string, unknown>), sequence: device.nextMetricSequence++, receivedAt: device.lastSeenAt });
			device.metrics.splice(0, Math.max(0, device.metrics.length - maximumMetricSamples));
			this._notify();
			return;
		}
		if (message.type === "response" && typeof message.requestId === "string") {
			const pending = this._pending.get(message.requestId);
			if (!pending || pending.connectionId !== device.connectionId) {
				return;
			}
			clearTimeout(pending.timer);
			this._pending.delete(message.requestId);
			if (message.ok === true) {
				pending.resolve(
					["screenshot", "run-tests", "profiler-status", "capture-profiler-snapshot", "get-profiler-data"].includes(pending.command)
						? message.result
						: safeValue(message.result)
				);
			} else {
				pending.reject(new Error(boundedText(message.error || "Remote player command failed.", 1_024)));
			}
		}
	}

	private _request(device: IConnectedDevice, command: Record<string, unknown>, timeoutMs: number): Promise<any> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 600_000) {
			throw new Error("Remote device timeoutMs must be an integer from 250 to 600000.");
		}
		if (this._pending.size >= 64) {
			throw new Error("Device Lab has reached its 64-request in-flight limit.");
		}
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(requestId);
				reject(new Error("Remote player command timed out."));
			}, timeoutMs);
			this._pending.set(requestId, { connectionId: device.connectionId, command: String(command.command ?? "unknown"), timer, resolve, reject });
			try {
				device.socket.send(JSON.stringify({ protocol: "zvibe-device-lab", version: DEVICE_LAB_PROTOCOL_VERSION, type: "command", requestId, ...command }));
			} catch (error) {
				clearTimeout(timer);
				this._pending.delete(requestId);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private _requireDevice(connectionId: unknown): IConnectedDevice {
		if (typeof connectionId !== "string") {
			throw new Error("Remote device connectionId is required.");
		}
		const device = this._devices.get(connectionId);
		if (!device) {
			throw new Error(`Remote device connection not found: ${connectionId}`);
		}
		return device;
	}

	private _describeDevice(device: IConnectedDevice): any {
		return {
			connectionId: device.connectionId,
			identity: structuredClone(device.identity),
			capabilities: [...device.capabilities],
			connectedAt: device.connectedAt,
			lastSeenAt: device.lastSeenAt,
			logCount: device.logs.length,
			metricCount: device.metrics.length,
			latestLogSequence: device.nextLogSequence - 1,
			latestMetricSequence: device.nextMetricSequence - 1,
			screenshot: device.latestScreenshot ? { ...device.latestScreenshot, imageBase64: undefined } : null,
		};
	}

	private _rejectPendingForConnection(connectionId: string, reason: string): void {
		for (const [requestId, pending] of this._pending) {
			if (pending.connectionId === connectionId) {
				clearTimeout(pending.timer);
				pending.reject(new Error(reason));
				this._pending.delete(requestId);
			}
		}
	}

	private _heartbeatDevices(): void {
		for (const device of this._devices.values()) {
			if (!device.alive) {
				device.socket.terminate();
				continue;
			}
			device.alive = false;
			device.socket.ping();
		}
	}

	private _notify(): void {
		if (this._notifyTimer) {
			return;
		}
		this._notifyTimer = setTimeout(() => {
			this._notifyTimer = null;
			this._editor?.layout?.inspector?.forceUpdate?.();
			this._editor?.layout?.profiler?.forceUpdate?.();
		}, 100);
	}
}

const deviceLab = new DeviceLabHub();

export function getDeviceToolingCapabilities(): any {
	return deviceLab.capabilities();
}

export async function startDeviceLab(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	return deviceLab.start(data, options);
}

export async function stopDeviceLab(_scene: Scene, data: any): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Stopping Device Lab requires confirm=true.");
	}
	return deviceLab.stop(false);
}

export function getDeviceLabStatus(): any {
	return deviceLab.status();
}

export function listRemoteDevices(): any {
	return deviceLab.devices();
}

export function getRemoteDeviceLogs(_scene: Scene, data: any): any {
	return deviceLab.logs(data);
}

export function getRemoteDeviceMetrics(_scene: Scene, data: any): any {
	return deviceLab.metrics(data);
}

export async function captureRemoteDeviceScreenshot(_scene: Scene, data: any): Promise<any> {
	return deviceLab.screenshot(data);
}

export async function sendRemoteDeviceInput(_scene: Scene, data: any): Promise<any> {
	return deviceLab.input(data);
}

export async function runRemoteDeviceTests(_scene: Scene, data: any): Promise<any> {
	return deviceLab.tests(data);
}

export async function cancelRemoteDeviceTests(_scene: Scene, data: any): Promise<any> {
	return deviceLab.cancelTests(data);
}

export async function startRemoteDeviceProfiler(_scene: Scene, data: any): Promise<any> {
	return deviceLab.profiler(data, "start-profiler");
}

export async function getRemoteDeviceProfilerStatus(_scene: Scene, data: any): Promise<any> {
	return deviceLab.profiler(data, "profiler-status");
}

export async function captureRemoteDeviceProfilerSnapshot(_scene: Scene, data: any): Promise<any> {
	return deviceLab.profiler(data, "capture-profiler-snapshot");
}

export async function stopRemoteDeviceProfiler(_scene: Scene, data: any): Promise<any> {
	return deviceLab.profiler(data, data.cancel ? "cancel-profiler" : "stop-profiler");
}

export async function getRemoteDeviceProfilerData(_scene: Scene, data: any): Promise<any> {
	return deviceLab.profiler(data, "get-profiler-data");
}

export async function releaseRemoteDeviceProfiler(_scene: Scene, data: any): Promise<any> {
	return deviceLab.profiler(data, "release-profiler");
}

export function reserveRemoteDeviceProfiler(connectionId: unknown, runToken: unknown, onDisconnect?: () => void): () => void {
	return deviceLab.reserveProfiler(connectionId, runToken, onDisconnect);
}

export function disconnectRemoteDevice(_scene: Scene, data: any): any {
	return deviceLab.disconnect(data);
}

export function clearRemoteDeviceData(_scene: Scene, data: any): any {
	return deviceLab.clear(data);
}

export async function shutdownDeviceLab(): Promise<void> {
	await deviceLab.stop(false);
}
