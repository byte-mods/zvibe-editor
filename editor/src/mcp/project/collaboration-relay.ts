import { randomUUID } from "crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Scene } from "babylonjs";

import type { Editor } from "../../editor/main";
import { IMCPActionOptions } from "../action";
import { resolveProjectCollaborationActor } from "./collaboration";

const relayProtocol = "babylon-editor-collaboration-relay";
const relayVersion = 1;
const maximumFrameBytes = 1024 * 1024;
const maximumConfigBytes = 64 * 1024;
const maximumConcurrentRequests = 64;
const registrationTimeoutMilliseconds = 10_000;
const heartbeatMilliseconds = 15_000;

interface IRemoteCollaborationRelayConfig {
	version: 1;
	enabled: boolean;
	relayUrl: string;
	projectSlug: string;
	clientInstanceId: string;
	tokenEnvironmentVariable: string;
	reconnectMinimumMs: number;
	reconnectMaximumMs: number;
}

interface IRelayRequest {
	type: "request";
	requestId: string;
	kind: "action" | "presence" | "events" | "lock";
	token: string;
	body: unknown;
}

type RelayRequestHandler = (request: IRelayRequest) => Promise<unknown>;

function projectDirectory(editor: Editor): string {
	if (!editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(editor.state.projectPath);
}

function configPath(editor: Editor): string {
	return join(projectDirectory(editor), ".babylon-editor", "remote-collaboration-relay.json");
}

function defaultConfig(): IRemoteCollaborationRelayConfig {
	return {
		version: relayVersion,
		enabled: false,
		relayUrl: "",
		projectSlug: "",
		clientInstanceId: randomUUID(),
		tokenEnvironmentVariable: "BABYLON_EDITOR_RELAY_TOKEN",
		reconnectMinimumMs: 1000,
		reconnectMaximumMs: 30_000,
	};
}

function validateRelayUrl(value: unknown, required: boolean): string {
	if (!value && !required) {
		return "";
	}
	if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value)) {
		throw new Error("relayUrl must be a non-empty WebSocket URL of at most 2048 characters.");
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("relayUrl must be a valid WebSocket URL.");
	}
	const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
	if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
		throw new Error("relayUrl must use wss://; insecure ws:// is allowed only for a loopback development relay.");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("relayUrl must not contain credentials, query parameters, or fragments.");
	}
	return url.toString();
}

function validateProjectSlug(value: unknown, required: boolean): string {
	if (!value && !required) {
		return "";
	}
	if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/.test(value)) {
		throw new Error("projectSlug must be 3–80 lowercase letters, numbers, or internal hyphens.");
	}
	return value;
}

function validateEnvironmentVariable(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]{0,127}$/.test(value)) {
		throw new Error("tokenEnvironmentVariable must be an uppercase environment-variable name of at most 128 characters.");
	}
	return value;
}

function validateReconnect(value: unknown, field: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${field} must be an integer from ${minimum} through ${maximum} milliseconds.`);
	}
	return value as number;
}

function validateConfig(value: any): IRemoteCollaborationRelayConfig {
	if (
		!value ||
		value.version !== relayVersion ||
		typeof value.enabled !== "boolean" ||
		typeof value.clientInstanceId !== "string" ||
		!/^[0-9a-f-]{36}$/i.test(value.clientInstanceId)
	) {
		throw new Error("Remote collaboration relay configuration has an unsupported or malformed schema.");
	}
	const reconnectMinimumMs = validateReconnect(value.reconnectMinimumMs, "reconnectMinimumMs", 500, 30_000);
	const reconnectMaximumMs = validateReconnect(value.reconnectMaximumMs, "reconnectMaximumMs", 1000, 120_000);
	if (reconnectMaximumMs < reconnectMinimumMs) {
		throw new Error("reconnectMaximumMs must be greater than or equal to reconnectMinimumMs.");
	}
	return {
		version: relayVersion,
		enabled: value.enabled,
		relayUrl: validateRelayUrl(value.relayUrl, value.enabled),
		projectSlug: validateProjectSlug(value.projectSlug, value.enabled),
		clientInstanceId: value.clientInstanceId,
		tokenEnvironmentVariable: validateEnvironmentVariable(value.tokenEnvironmentVariable),
		reconnectMinimumMs,
		reconnectMaximumMs,
	};
}

function validateAccessToken(value: unknown): string {
	if (typeof value !== "string" || value.length < 16 || value.length > 512 || /[\s\0]/.test(value)) {
		throw new Error("relayAccessToken must be 16–512 non-whitespace characters.");
	}
	return value;
}

async function readConfig(editor: Editor): Promise<IRemoteCollaborationRelayConfig> {
	const path = configPath(editor);
	try {
		const details = await stat(path);
		if (!details.isFile() || details.size > maximumConfigBytes) {
			throw new Error(`Remote collaboration relay configuration must be a file of at most ${maximumConfigBytes} bytes.`);
		}
		return validateConfig(JSON.parse(await readFile(path, "utf-8")));
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return defaultConfig();
		}
		if (error instanceof SyntaxError) {
			throw new Error("Remote collaboration relay configuration contains invalid JSON.");
		}
		throw error;
	}
}

async function writeConfig(editor: Editor, config: IRemoteCollaborationRelayConfig): Promise<void> {
	const path = configPath(editor);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function sanitizeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error))
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]")
		.replace(/[\r\n\0]+/g, " ")
		.trim()
		.slice(0, 256);
}

function validatePublicUrl(value: unknown): string | null {
	if (value === undefined) {
		return null;
	}
	if (typeof value !== "string" || value.length > 2048 || /[\r\n\0]/.test(value)) {
		throw new Error("Relay public URL is malformed.");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Relay public URL is malformed.");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
		throw new Error("Relay public URL must be credential-free HTTPS without query parameters or fragments.");
	}
	return url.toString();
}

function parseRelayRequest(value: any): IRelayRequest | null {
	if (
		!value ||
		value.type !== "request" ||
		typeof value.requestId !== "string" ||
		!/^[-A-Za-z0-9_:]{1,128}$/.test(value.requestId) ||
		!["action", "presence", "events", "lock"].includes(value.kind) ||
		typeof value.token !== "string" ||
		value.token.length < 16 ||
		value.token.length > 512 ||
		/[\s\0]/.test(value.token) ||
		value.body === undefined
	) {
		return null;
	}
	return value;
}

class RemoteCollaborationRelayRuntime {
	private _editor: Editor | null = null;
	private _handler: RelayRequestHandler | null = null;
	private _config: IRemoteCollaborationRelayConfig = defaultConfig();
	private _socket: WebSocket | null = null;
	private _runtimeToken: string | null = null;
	private _tokenSource: "live" | "environment" | null = null;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _registrationTimer: ReturnType<typeof setTimeout> | null = null;
	private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private _intentionalStop = false;
	private _state: "disabled" | "connecting" | "registering" | "connected" | "reconnecting" | "error" = "disabled";
	private _lastError: string | null = null;
	private _reconnectAttempt = 0;
	private _connectedAt: string | null = null;
	private _lastMessageAt: string | null = null;
	private _connectionId: string | null = null;
	private _publicUrl: string | null = null;
	private _activeRequests = 0;
	private _receivedRequests = 0;
	private _succeededRequests = 0;
	private _failedRequests = 0;
	private _bytesReceived = 0;
	private _bytesSent = 0;

	public async initialize(editor: Editor, handler: RelayRequestHandler): Promise<void> {
		await this.shutdown();
		this._editor = editor;
		this._handler = handler;
		try {
			this._config = await readConfig(editor);
			this._lastError = null;
		} catch (error) {
			this._config = defaultConfig();
			this._lastError = `Relay configuration was ignored: ${sanitizeError(error)}`;
		}
		if (this._config.enabled) {
			this._runtimeToken = this._environmentToken();
			if (this._runtimeToken) {
				this._tokenSource = "environment";
				this._connect();
			} else {
				this._state = "error";
				this._lastError = `Relay is enabled but ${this._config.tokenEnvironmentVariable} is not available. Provide relayAccessToken or set the environment variable.`;
			}
		}
	}

	public status(): any {
		const environmentTokenAvailable = Boolean(this._environmentToken());
		return {
			config: this._config,
			state: this._state,
			connected: this._state === "connected",
			connectedAt: this._connectedAt,
			lastMessageAt: this._lastMessageAt,
			connectionId: this._connectionId,
			publicUrl: this._publicUrl,
			lastError: this._lastError,
			reconnectAttempt: this._reconnectAttempt,
			activeRequests: this._activeRequests,
			receivedRequests: this._receivedRequests,
			succeededRequests: this._succeededRequests,
			failedRequests: this._failedRequests,
			bytesReceived: this._bytesReceived,
			bytesSent: this._bytesSent,
			authentication: {
				available: Boolean(this._runtimeToken) || environmentTokenAvailable,
				source: this._tokenSource ?? (environmentTokenAvailable ? "environment" : "missing"),
				environmentVariable: this._config.tokenEnvironmentVariable,
				persisted: false,
			},
			limits: { maximumFrameBytes, maximumConcurrentRequests, registrationTimeoutMilliseconds, heartbeatMilliseconds },
			protocol: { name: relayProtocol, version: relayVersion },
		};
	}

	public async configure(data: any): Promise<any> {
		if (!this._editor) {
			throw new Error("Remote collaboration relay is not initialized.");
		}
		const next = validateConfig({
			...this._config,
			enabled: data.enabled ?? this._config.enabled,
			relayUrl: data.relayUrl ?? this._config.relayUrl,
			projectSlug: data.projectSlug ?? this._config.projectSlug,
			tokenEnvironmentVariable: data.tokenEnvironmentVariable ?? this._config.tokenEnvironmentVariable,
			reconnectMinimumMs: data.reconnectMinimumMs ?? this._config.reconnectMinimumMs,
			reconnectMaximumMs: data.reconnectMaximumMs ?? this._config.reconnectMaximumMs,
			version: relayVersion,
			clientInstanceId: this._config.clientInstanceId,
		});
		if (data.relayAccessToken !== undefined) {
			this._runtimeToken = validateAccessToken(data.relayAccessToken);
			this._tokenSource = "live";
		}
		if (next.enabled && !this._runtimeToken && !process.env[next.tokenEnvironmentVariable]) {
			throw new Error(`Enabling the relay requires relayAccessToken or the ${next.tokenEnvironmentVariable} environment variable.`);
		}
		await this._stop(true);
		this._config = next;
		await writeConfig(this._editor, next);
		if (next.enabled) {
			if (!this._runtimeToken) {
				this._runtimeToken = this._environmentToken();
				this._tokenSource = this._runtimeToken ? "environment" : null;
			}
			this._connect();
		} else {
			this._runtimeToken = null;
			this._tokenSource = null;
			this._state = "disabled";
		}
		return this.status();
	}

	public async reconnect(relayAccessToken?: unknown): Promise<any> {
		if (!this._config.enabled) {
			throw new Error("Remote collaboration relay is disabled. Enable and configure it first.");
		}
		if (relayAccessToken !== undefined) {
			this._runtimeToken = validateAccessToken(relayAccessToken);
			this._tokenSource = "live";
		}
		if (!this._runtimeToken) {
			this._runtimeToken = this._environmentToken();
			this._tokenSource = this._runtimeToken ? "environment" : null;
		}
		if (!this._runtimeToken) {
			throw new Error(`Relay authentication is unavailable. Provide relayAccessToken or set ${this._config.tokenEnvironmentVariable}.`);
		}
		await this._stop(true);
		this._reconnectAttempt = 0;
		this._connect();
		return this.status();
	}

	public async shutdown(): Promise<void> {
		await this._stop(true);
		this._editor = null;
		this._handler = null;
		this._runtimeToken = null;
		this._tokenSource = null;
		this._state = "disabled";
	}

	private _environmentToken(): string | null {
		const value = process.env[this._config.tokenEnvironmentVariable];
		if (!value) {
			return null;
		}
		try {
			return validateAccessToken(value);
		} catch {
			return null;
		}
	}

	private _connect(): void {
		if (!this._config.enabled || !this._runtimeToken || this._socket) {
			return;
		}
		this._intentionalStop = false;
		this._state = this._reconnectAttempt ? "reconnecting" : "connecting";
		try {
			const socket = new WebSocket(this._config.relayUrl);
			this._socket = socket;
			socket.addEventListener("open", () => this._onOpen(socket));
			socket.addEventListener("message", (event) => void this._onMessage(socket, event));
			socket.addEventListener("error", () => {
				this._lastError = "Relay WebSocket connection failed.";
			});
			socket.addEventListener("close", () => this._onClose(socket));
		} catch (error) {
			this._lastError = sanitizeError(error);
			this._state = "error";
			this._scheduleReconnect();
		}
	}

	private _onOpen(socket: WebSocket): void {
		if (socket !== this._socket || !this._runtimeToken) {
			return;
		}
		this._state = "registering";
		this._send({
			protocol: relayProtocol,
			version: relayVersion,
			type: "register",
			projectSlug: this._config.projectSlug,
			clientInstanceId: this._config.clientInstanceId,
			accessToken: this._runtimeToken,
		});
		this._registrationTimer = setTimeout(() => {
			if (this._state === "registering" && this._socket === socket) {
				this._lastError = "Relay registration timed out.";
				socket.close(4000, "Registration timeout");
			}
		}, registrationTimeoutMilliseconds);
	}

	private async _onMessage(socket: WebSocket, event: MessageEvent): Promise<void> {
		if (socket !== this._socket || typeof event.data !== "string") {
			return;
		}
		const bytes = Buffer.byteLength(event.data);
		this._bytesReceived += bytes;
		this._lastMessageAt = new Date().toISOString();
		if (bytes > maximumFrameBytes) {
			this._lastError = `Relay frame exceeded ${maximumFrameBytes} bytes.`;
			socket.close(4009, "Frame too large");
			return;
		}
		let message: any;
		try {
			message = JSON.parse(event.data);
		} catch {
			this._lastError = "Relay sent invalid JSON.";
			socket.close(4002, "Invalid JSON");
			return;
		}
		if (message?.type === "registered") {
			this._acceptRegistration(message);
			return;
		}
		if (message?.type === "ping" && typeof message.nonce === "string" && message.nonce.length <= 128) {
			this._send({ type: "pong", nonce: message.nonce });
			return;
		}
		const request = parseRelayRequest(message);
		if (!request || this._state !== "connected") {
			this._lastError = "Relay sent a malformed or premature request.";
			if (message?.type === "request" && typeof message.requestId === "string" && /^[-A-Za-z0-9_:]{1,128}$/.test(message.requestId)) {
				this._send({ type: "response", requestId: message.requestId, success: false, status: 400, error: "Malformed or premature relay request." });
			}
			return;
		}
		await this._handleRequest(request);
	}

	private _acceptRegistration(message: any): void {
		let publicUrl: string | null;
		try {
			publicUrl = validatePublicUrl(message.publicUrl);
		} catch {
			publicUrl = null;
		}
		if (
			this._state !== "registering" ||
			typeof message.connectionId !== "string" ||
			!/^[-A-Za-z0-9_:]{1,128}$/.test(message.connectionId) ||
			(message.publicUrl !== undefined && !publicUrl)
		) {
			this._lastError = "Relay registration acknowledgement was malformed.";
			this._socket?.close(4003, "Malformed registration");
			return;
		}
		if (this._registrationTimer) {
			clearTimeout(this._registrationTimer);
			this._registrationTimer = null;
		}
		this._state = "connected";
		this._connectedAt = new Date().toISOString();
		this._connectionId = message.connectionId;
		this._publicUrl = publicUrl;
		this._lastError = null;
		this._reconnectAttempt = 0;
		this._heartbeatTimer = setInterval(() => this._send({ type: "heartbeat", timestamp: new Date().toISOString() }), heartbeatMilliseconds);
	}

	private async _handleRequest(request: IRelayRequest): Promise<void> {
		this._receivedRequests++;
		if (this._activeRequests >= maximumConcurrentRequests) {
			this._failedRequests++;
			this._send({ type: "response", requestId: request.requestId, success: false, status: 429, error: "Too many concurrent relay requests." });
			return;
		}
		this._activeRequests++;
		try {
			const body = await this._handler!(request);
			this._succeededRequests++;
			this._send({ type: "response", requestId: request.requestId, success: true, status: 200, body: body ?? null });
		} catch (error) {
			this._failedRequests++;
			this._send({ type: "response", requestId: request.requestId, success: false, status: 403, error: sanitizeError(error) });
		} finally {
			this._activeRequests--;
		}
	}

	private _send(value: unknown): void {
		if (!this._socket || this._socket.readyState !== WebSocket.OPEN) {
			return;
		}
		let serialized = JSON.stringify(value);
		if (Buffer.byteLength(serialized) > maximumFrameBytes) {
			const requestId = value && typeof value === "object" && "requestId" in value && typeof value.requestId === "string" ? value.requestId : null;
			serialized = JSON.stringify(
				requestId
					? { type: "response", requestId, success: false, status: 507, error: `Relay response exceeded ${maximumFrameBytes} bytes.` }
					: { type: "error", error: `Relay response exceeded ${maximumFrameBytes} bytes.` }
			);
		}
		this._bytesSent += Buffer.byteLength(serialized);
		this._socket.send(serialized);
	}

	private _onClose(socket: WebSocket): void {
		if (socket !== this._socket) {
			return;
		}
		this._socket = null;
		this._clearConnectionTimers();
		this._connectedAt = null;
		this._connectionId = null;
		this._publicUrl = null;
		if (!this._intentionalStop && this._config.enabled) {
			this._scheduleReconnect();
		}
	}

	private _scheduleReconnect(): void {
		if (this._intentionalStop || !this._config.enabled || this._reconnectTimer) {
			return;
		}
		this._reconnectAttempt++;
		const delay = Math.min(this._config.reconnectMaximumMs, this._config.reconnectMinimumMs * 2 ** Math.min(10, this._reconnectAttempt - 1));
		this._state = "reconnecting";
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null;
			this._connect();
		}, delay);
	}

	private _clearConnectionTimers(): void {
		if (this._registrationTimer) {
			clearTimeout(this._registrationTimer);
			this._registrationTimer = null;
		}
		if (this._heartbeatTimer) {
			clearInterval(this._heartbeatTimer);
			this._heartbeatTimer = null;
		}
	}

	private async _stop(intentional: boolean): Promise<void> {
		this._intentionalStop = intentional;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = null;
		}
		this._clearConnectionTimers();
		if (this._socket) {
			const socket = this._socket;
			this._socket = null;
			await new Promise<void>((resolveClose) => {
				if (socket.readyState === WebSocket.CLOSED) {
					resolveClose();
					return;
				}
				const timeout = setTimeout(resolveClose, 1000);
				socket.addEventListener(
					"close",
					() => {
						clearTimeout(timeout);
						resolveClose();
					},
					{ once: true }
				);
				socket.close(1000, "Editor relay stopped");
			});
		}
		this._connectedAt = null;
		this._connectionId = null;
		this._publicUrl = null;
	}
}

const relayRuntime = new RemoteCollaborationRelayRuntime();

export async function initializeRemoteCollaborationRelay(editor: Editor, handler: RelayRequestHandler): Promise<void> {
	await relayRuntime.initialize(editor, handler);
}

export async function shutdownRemoteCollaborationRelay(): Promise<void> {
	await relayRuntime.shutdown();
}

export async function getRemoteCollaborationRelay(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await resolveProjectCollaborationActor(data.collaborationToken, options);
	return relayRuntime.status();
}

export async function setRemoteCollaborationRelay(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Remote collaboration relay configuration requires the admin role.");
	}
	return relayRuntime.configure(data);
}

export async function reconnectRemoteCollaborationRelay(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Remote collaboration relay reconnection requires the admin role.");
	}
	return relayRuntime.reconnect(data.relayAccessToken);
}
