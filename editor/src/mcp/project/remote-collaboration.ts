import { createServer as createHttpServer, IncomingMessage, Server as HttpServer, ServerResponse } from "http";
import { createServer as createHttpsServer } from "https";
import { AddressInfo, isIP } from "net";
import { randomUUID } from "crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join, normalize, resolve } from "path/posix";

import { Scene } from "babylonjs";

import type { Editor } from "../../editor/main";
import { IMCPActionOptions } from "../action";
import { authorizeProjectCollaborationRequest, heartbeatProjectCollaborationSession, resolveProjectCollaborationActor } from "./collaboration";
import { initializeRemoteCollaborationDiscovery, shutdownRemoteCollaborationDiscovery, synchronizeRemoteCollaborationDiscovery } from "./collaboration-discovery";
import { initializeRemoteCollaborationRelay, shutdownRemoteCollaborationRelay } from "./collaboration-relay";

const configVersion = 1;
const defaultEventRetention = 1000;
const minimumEventRetention = 100;
const maximumEvents = 10000;
const maximumHistoryBytes = 32 * 1024 * 1024;
const maximumRequestBytes = 1024 * 1024;
const keepAliveMilliseconds = 15000;

type EndpointMap = Record<string, (scene: Scene, data: any, options: IMCPActionOptions) => any>;

export interface IRemoteCollaborationConfig {
	version: 1;
	enabled: boolean;
	bindAddress: string;
	port: number;
	allowedOrigins: string[];
	allowedHosts: string[];
	tlsCertificatePath: string | null;
	tlsPrivateKeyPath: string | null;
	eventHistoryEnabled: boolean;
	eventHistoryRetention: number;
}

export interface IRemoteCollaborationEvent {
	sequence: number;
	timestamp: string;
	type: "operation" | "presence" | "gateway" | "lock";
	source: "local" | "remote" | "system";
	endpoint: string | null;
	success: boolean;
	actor: { memberId: string; memberName: string; role: string; clientName: string } | null;
	details: string;
}

interface IRemoteCollaborationEventHistory {
	version: 1;
	nextSequence: number;
	events: IRemoteCollaborationEvent[];
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function configPath(root: string): string {
	return join(root, ".babylon-editor", "remote-collaboration.json");
}

function historyPath(root: string): string {
	return join(root, ".babylon-editor", "remote-collaboration-events.json");
}

function defaultConfig(): IRemoteCollaborationConfig {
	return {
		version: configVersion,
		enabled: false,
		bindAddress: "127.0.0.1",
		port: 3713,
		allowedOrigins: [],
		allowedHosts: ["127.0.0.1:3713", "localhost:3713"],
		tlsCertificatePath: null,
		tlsPrivateKeyPath: null,
		eventHistoryEnabled: true,
		eventHistoryRetention: defaultEventRetention,
	};
}

function isLoopback(address: string): boolean {
	return address === "127.0.0.1" || address === "::1";
}

function validateStringList(value: unknown, field: string, maximum: number): string[] {
	if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string" || !entry || entry.length > 256 || /[\r\n\0]/.test(entry))) {
		throw new Error(`${field} must contain at most ${maximum} non-empty strings of at most 256 characters without line breaks or null bytes.`);
	}
	return [...new Set(value.map((entry) => entry.trim()))];
}

function validateConfig(value: any): IRemoteCollaborationConfig {
	if (!value || value.version !== configVersion || typeof value.enabled !== "boolean" || typeof value.bindAddress !== "string" || isIP(value.bindAddress) === 0) {
		throw new Error("Remote collaboration configuration has an unsupported or malformed schema.");
	}
	if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) {
		throw new Error("Remote collaboration port must be an integer from 1024 through 65535.");
	}
	const allowedOrigins = validateStringList(value.allowedOrigins, "allowedOrigins", 32).map((origin) => {
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch {
			throw new Error(`Invalid allowed origin: ${origin}`);
		}
		if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
			throw new Error(`Allowed origins must be exact HTTP(S) origins without paths: ${origin}`);
		}
		return parsed.origin;
	});
	const allowedHosts = validateStringList(value.allowedHosts, "allowedHosts", 32).map((host) => host.toLowerCase());
	const tlsCertificatePath = value.tlsCertificatePath === null ? null : validateProjectRelativePath(value.tlsCertificatePath, "tlsCertificatePath");
	const tlsPrivateKeyPath = value.tlsPrivateKeyPath === null ? null : validateProjectRelativePath(value.tlsPrivateKeyPath, "tlsPrivateKeyPath");
	const eventHistoryEnabled = value.eventHistoryEnabled ?? true;
	const eventHistoryRetention = value.eventHistoryRetention ?? defaultEventRetention;
	if (typeof eventHistoryEnabled !== "boolean") {
		throw new Error("eventHistoryEnabled must be a boolean.");
	}
	if (!Number.isInteger(eventHistoryRetention) || eventHistoryRetention < minimumEventRetention || eventHistoryRetention > maximumEvents) {
		throw new Error(`eventHistoryRetention must be an integer from ${minimumEventRetention} through ${maximumEvents}.`);
	}
	if (Boolean(tlsCertificatePath) !== Boolean(tlsPrivateKeyPath)) {
		throw new Error("TLS certificate and private-key paths must be provided together.");
	}
	if (!isLoopback(value.bindAddress) && (!tlsCertificatePath || !allowedOrigins.length || !allowedHosts.length)) {
		throw new Error("Non-loopback remote collaboration requires TLS certificate/key paths plus explicit allowedOrigins and allowedHosts.");
	}
	return {
		version: configVersion,
		enabled: value.enabled,
		bindAddress: value.bindAddress,
		port: value.port,
		allowedOrigins,
		allowedHosts,
		tlsCertificatePath,
		tlsPrivateKeyPath,
		eventHistoryEnabled,
		eventHistoryRetention,
	};
}

function validateProjectRelativePath(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${field} must be a non-empty project-relative path.`);
	}
	const path = normalize(value.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
	if (path === "." || path.startsWith("/") || path.split("/").includes("..") || path === ".babylon-editor" || path.startsWith(".babylon-editor/")) {
		throw new Error(`${field} must stay inside the project and outside editor metadata.`);
	}
	return path;
}

async function readConfig(root: string): Promise<IRemoteCollaborationConfig> {
	try {
		return validateConfig(JSON.parse(await readFile(configPath(root), "utf-8")));
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return defaultConfig();
		}
		if (error instanceof SyntaxError) {
			throw new Error("Remote collaboration configuration contains invalid JSON. Repair .babylon-editor/remote-collaboration.json before continuing.");
		}
		throw error;
	}
}

async function writeConfig(root: string, config: IRemoteCollaborationConfig): Promise<void> {
	await mkdir(join(root, ".babylon-editor"), { recursive: true });
	const path = configPath(root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function sanitizeEventDetails(value: unknown): string {
	const details = typeof value === "string" ? value : String(value ?? "");
	return details
		.replace(/[\r\n\0]+/g, " ")
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
		.trim()
		.slice(0, 256);
}

function validateHistoryEvent(value: any): IRemoteCollaborationEvent {
	if (
		!value ||
		!Number.isSafeInteger(value.sequence) ||
		value.sequence < 1 ||
		typeof value.timestamp !== "string" ||
		!Number.isFinite(Date.parse(value.timestamp)) ||
		!["operation", "presence", "gateway", "lock"].includes(value.type) ||
		!["local", "remote", "system"].includes(value.source) ||
		(value.endpoint !== null && (typeof value.endpoint !== "string" || !/^[A-Za-z0-9_:-]{1,128}$/.test(value.endpoint))) ||
		typeof value.success !== "boolean" ||
		typeof value.details !== "string" ||
		value.details.length > 256 ||
		/[\r\n\0]/.test(value.details)
	) {
		throw new Error("Remote collaboration event history contains a malformed event.");
	}
	let actor: IRemoteCollaborationEvent["actor"] = null;
	if (value.actor !== null) {
		if (
			!value.actor ||
			["memberId", "memberName", "role", "clientName"].some((field) => typeof value.actor[field] !== "string" || !value.actor[field] || value.actor[field].length > 256)
		) {
			throw new Error("Remote collaboration event history contains a malformed actor.");
		}
		actor = { memberId: value.actor.memberId, memberName: value.actor.memberName, role: value.actor.role, clientName: value.actor.clientName };
	}
	return {
		sequence: value.sequence,
		timestamp: new Date(value.timestamp).toISOString(),
		type: value.type,
		source: value.source,
		endpoint: value.endpoint,
		success: value.success,
		actor,
		details: value.details,
	};
}

async function readEventHistory(root: string, retention: number): Promise<IRemoteCollaborationEventHistory> {
	const path = historyPath(root);
	const details = await stat(path);
	if (details.size > maximumHistoryBytes) {
		throw new Error(`Remote collaboration event history exceeds ${maximumHistoryBytes} bytes.`);
	}
	let value: any;
	try {
		value = JSON.parse(await readFile(path, "utf-8"));
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error("Remote collaboration event history contains invalid JSON.");
		}
		throw error;
	}
	if (
		!value ||
		value.version !== 1 ||
		!Number.isSafeInteger(value.nextSequence) ||
		value.nextSequence < 1 ||
		!Array.isArray(value.events) ||
		value.events.length > maximumEvents
	) {
		throw new Error("Remote collaboration event history has an unsupported or malformed schema.");
	}
	const events = value.events.map(validateHistoryEvent);
	for (let index = 1; index < events.length; index++) {
		if (events[index].sequence <= events[index - 1].sequence) {
			throw new Error("Remote collaboration event history sequences must be strictly increasing.");
		}
	}
	if (events.length && value.nextSequence <= events.at(-1)!.sequence) {
		throw new Error("Remote collaboration event history nextSequence must follow the latest event.");
	}
	return { version: 1, nextSequence: value.nextSequence, events: events.slice(-retention) };
}

async function writeEventHistory(root: string, nextSequence: number, events: IRemoteCollaborationEvent[]): Promise<void> {
	await mkdir(join(root, ".babylon-editor"), { recursive: true });
	const path = historyPath(root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	const serialized = `${JSON.stringify({ version: 1, nextSequence, events }, null, "\t")}\n`;
	if (Buffer.byteLength(serialized) > maximumHistoryBytes) {
		throw new Error(`Remote collaboration event history exceeds ${maximumHistoryBytes} bytes.`);
	}
	await writeFile(temporary, serialized, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function readProjectTlsFile(root: string, path: string): Promise<Buffer> {
	const [realRoot, realFile] = await Promise.all([realpath(root), realpath(resolve(root, path))]);
	if (realFile !== realRoot && !realFile.startsWith(`${realRoot}/`)) {
		throw new Error(`TLS path must resolve inside the project: ${path}`);
	}
	return readFile(realFile);
}

function bearerToken(req: IncomingMessage): string {
	const header = req.headers.authorization;
	if (!header?.startsWith("Bearer ") || header.length > 160) {
		throw new Error("A collaboration session bearer token is required in the Authorization header.");
	}
	return header.slice(7);
}

async function readJsonBody(req: IncomingMessage): Promise<any> {
	return new Promise((resolveBody, rejectBody) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
			if (Buffer.byteLength(body) > maximumRequestBytes) {
				rejectBody(new Error(`Remote collaboration request bodies are limited to ${maximumRequestBytes} bytes.`));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolveBody(body ? JSON.parse(body) : {});
			} catch {
				rejectBody(new Error("Remote collaboration request body must be valid JSON."));
			}
		});
		req.on("error", rejectBody);
	});
}

class RemoteCollaborationRuntime {
	private _editor: Editor | null = null;
	private _endpoints: EndpointMap | null = null;
	private _server: HttpServer | null = null;
	private _config: IRemoteCollaborationConfig = defaultConfig();
	private _events: IRemoteCollaborationEvent[] = [];
	private _nextSequence = 1;
	private _subscribers = new Set<ServerResponse>();
	private _keepAlive: ReturnType<typeof setInterval> | null = null;
	private _actualPort: number | null = null;
	private _historyError: string | null = null;
	private _historyRecovery: string | null = null;
	private _durableEvents: IRemoteCollaborationEvent[] = [];
	private _publishQueue: Promise<void> = Promise.resolve();

	public async initialize(editor: Editor, endpoints: EndpointMap): Promise<void> {
		this._editor = editor;
		this._endpoints = endpoints;
		const root = projectDirectory({ editor });
		this._config = await readConfig(root);
		this._events = [];
		this._nextSequence = 1;
		this._durableEvents = [];
		this._historyError = null;
		this._historyRecovery = null;
		try {
			const history = await readEventHistory(root, this._config.eventHistoryRetention);
			this._durableEvents = history.events;
			this._nextSequence = history.nextSequence;
			if (this._config.eventHistoryEnabled) {
				this._events = history.events;
			}
		} catch (error: any) {
			if (error?.code !== "ENOENT") {
				const corruptPath = `${historyPath(root)}.corrupt-${Date.now()}.json`;
				await rename(historyPath(root), corruptPath).catch(() => undefined);
				this._historyRecovery = `${error instanceof Error ? error.message : String(error)} The invalid journal was quarantined as ${corruptPath.slice(root.length + 1)}.`;
			}
		}
		if (this._config.enabled) {
			await this._start(this._config);
		}
	}

	public status(): any {
		return {
			config: this._config,
			running: Boolean(this._server),
			actualPort: this._actualPort,
			protocol: this._config.tlsCertificatePath ? "https" : "http",
			assetLockFederation: {
				enabled: Boolean(this._server),
				identityMode: "collaboration-member",
				routes: ["GET /locks", "POST /locks/acquire", "POST /locks/refresh", "POST /locks/release"],
			},
			eventCount: this._events.length,
			latestSequence: this._nextSequence - 1,
			oldestSequence: this._events[0]?.sequence ?? null,
			subscriberCount: this._subscribers.size,
			eventHistory: {
				enabled: this._config.eventHistoryEnabled,
				retention: this._config.eventHistoryRetention,
				persistedEventCount: this._durableEvents.length,
				path: ".babylon-editor/remote-collaboration-events.json",
				healthy: this._historyError === null,
				error: this._historyError,
				recovery: this._historyRecovery,
			},
		};
	}

	public events(afterSequence: number, limit: number): any {
		const matching = this._events.filter((event) => event.sequence > afterSequence);
		const events = matching.slice(0, limit);
		const oldestSequence = this._events[0]?.sequence ?? null;
		return {
			events,
			count: events.length,
			latestSequence: this._nextSequence - 1,
			oldestSequence,
			requestedAfterSequence: afterSequence,
			gap: oldestSequence !== null && afterSequence < oldestSequence - 1,
			truncated: matching.length > limit,
			hasMore: matching.length > limit,
			nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
		};
	}

	public async configure(config: IRemoteCollaborationConfig): Promise<any> {
		if (!this._editor || !this._endpoints) {
			throw new Error("Remote collaboration runtime is not initialized.");
		}
		const previous = this._config;
		await this._stop();
		try {
			if (config.enabled) {
				await this._start(config);
			}
			await writeConfig(projectDirectory({ editor: this._editor }), config);
			this._config = config;
		} catch (error) {
			await this._stop();
			this._config = previous;
			if (previous.enabled) {
				await this._start(previous).catch(() => undefined);
			}
			throw error;
		}
		await this.publish({
			type: "gateway",
			source: "system",
			endpoint: null,
			success: true,
			actor: null,
			details: config.enabled ? "Remote collaboration gateway started." : "Remote collaboration gateway stopped.",
		});
		return this.status();
	}

	public async shutdown(): Promise<void> {
		await this._publishQueue;
		await this._stop();
	}

	public async publish(event: Omit<IRemoteCollaborationEvent, "sequence" | "timestamp">): Promise<IRemoteCollaborationEvent> {
		let result: IRemoteCollaborationEvent | null = null;
		const operation = this._publishQueue.then(async () => {
			const actor = event.actor
				? {
						memberId: String(event.actor.memberId).slice(0, 256),
						memberName: String(event.actor.memberName).slice(0, 256),
						role: String(event.actor.role).slice(0, 256),
						clientName: String(event.actor.clientName).slice(0, 256),
					}
				: null;
			const complete: IRemoteCollaborationEvent = {
				sequence: this._nextSequence++,
				timestamp: new Date().toISOString(),
				type: event.type,
				source: event.source,
				endpoint: event.endpoint,
				success: event.success,
				actor,
				details: sanitizeEventDetails(event.details),
			};
			this._events.push(complete);
			this._events = this._events.slice(-this._config.eventHistoryRetention);
			if (this._config.eventHistoryEnabled) {
				this._durableEvents = [...this._events];
			}
			if (this._editor) {
				try {
					await writeEventHistory(projectDirectory({ editor: this._editor }), this._nextSequence, this._durableEvents);
					this._historyError = null;
				} catch (error) {
					this._historyError = error instanceof Error ? error.message : String(error);
				}
			}
			const payload = `id: ${complete.sequence}\nevent: ${complete.type}\ndata: ${JSON.stringify(complete)}\n\n`;
			for (const subscriber of this._subscribers) {
				subscriber.write(payload);
			}
			result = complete;
		});
		this._publishQueue = operation.catch(() => undefined);
		await operation;
		return result!;
	}

	public async configureHistory(enabled: boolean, retention: number): Promise<any> {
		if (!this._editor) {
			throw new Error("Remote collaboration runtime is not initialized.");
		}
		this._config = validateConfig({ ...this._config, eventHistoryEnabled: enabled, eventHistoryRetention: retention });
		this._events = this._events.slice(-retention);
		this._durableEvents = (enabled ? this._events : this._durableEvents).slice(-retention);
		const root = projectDirectory({ editor: this._editor });
		await writeConfig(root, this._config);
		await writeEventHistory(root, this._nextSequence, this._durableEvents);
		this._historyError = null;
		return this.status();
	}

	public async clearHistory(): Promise<any> {
		if (!this._editor) {
			throw new Error("Remote collaboration runtime is not initialized.");
		}
		await this._publishQueue;
		this._events = [];
		this._durableEvents = [];
		this._historyError = null;
		this._historyRecovery = null;
		const root = projectDirectory({ editor: this._editor });
		if (this._config.eventHistoryEnabled) {
			await writeEventHistory(root, this._nextSequence, []);
		} else {
			await unlink(historyPath(root)).catch((error: any) => {
				if (error?.code !== "ENOENT") {
					throw error;
				}
			});
		}
		return this.status();
	}

	public async relayRequest(request: any): Promise<any> {
		if (!this._editor || !this._endpoints) {
			throw new Error("Remote collaboration runtime is not initialized.");
		}
		const options = { editor: this._editor };
		const actor = await resolveProjectCollaborationActor(request.token, options);
		const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body : {};
		if (request.kind === "events") {
			const afterSequence = body.afterSequence ?? 0;
			const limit = body.limit ?? 100;
			if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
				throw new Error("Relayed event reads require afterSequence >= 0 and limit from 1 through 500.");
			}
			const result = this.events(afterSequence, maximumEvents);
			const events = result.events.slice(0, limit);
			return { ...result, events, count: events.length, hasMore: result.events.length > limit, nextAfterSequence: events.at(-1)?.sequence ?? afterSequence };
		}
		if (request.kind === "presence") {
			const result = await heartbeatProjectCollaborationSession(this._editor.layout.preview.scene, { ...body, collaborationToken: request.token }, options);
			await this.publish({
				type: "presence",
				source: "remote",
				endpoint: "heartbeat_project_collaboration_session",
				success: true,
				actor,
				details: "Relayed presence heartbeat updated.",
			});
			return result;
		}
		if (request.kind === "lock") {
			const endpoint =
				body.operation === "list"
					? "list_project_asset_locks"
					: body.operation === "acquire"
						? "acquire_project_asset_lock"
						: body.operation === "refresh"
							? "refresh_project_asset_lock"
							: body.operation === "release"
								? "release_project_asset_lock"
								: null;
			if (!endpoint || !this._endpoints[endpoint]) {
				throw new Error("Relayed lock request operation must be list, acquire, refresh, or release.");
			}
			const data = { ...body, collaborationToken: request.token };
			delete data.operation;
			await authorizeProjectCollaborationRequest(endpoint, data, options);
			const result = await this._endpoints[endpoint](this._editor.layout.preview.scene, data, options);
			await this.publish({ type: "lock", source: "remote", endpoint, success: result?.acquired !== false, actor, details: "Relayed asset-lock operation completed." });
			return result;
		}
		if (request.kind === "action") {
			if (typeof body.endpoint !== "string" || !body.endpoint || !this._endpoints[body.endpoint]) {
				throw new Error("Relayed action endpoint is missing or unknown.");
			}
			const data = {
				...(body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {}),
				collaborationToken: request.token,
				endpoint: body.endpoint,
			};
			await authorizeProjectCollaborationRequest(body.endpoint, data, options);
			try {
				const result = await this._endpoints[body.endpoint](this._editor.layout.preview.scene, data, options);
				await this.publish({ type: "operation", source: "remote", endpoint: body.endpoint, success: true, actor, details: "Relayed editor action completed." });
				return result;
			} catch (error) {
				await this.publish({
					type: "operation",
					source: "remote",
					endpoint: body.endpoint,
					success: false,
					actor,
					details: error instanceof Error ? error.message : "Relayed editor action failed.",
				});
				throw error;
			}
		}
		throw new Error("Unsupported relay request kind.");
	}

	private async _start(config: IRemoteCollaborationConfig): Promise<void> {
		if (!this._editor || !this._endpoints) {
			throw new Error("Remote collaboration runtime is not initialized.");
		}
		const root = projectDirectory({ editor: this._editor });
		if (config.tlsCertificatePath && config.tlsPrivateKeyPath) {
			const [cert, key] = await Promise.all([readProjectTlsFile(root, config.tlsCertificatePath), readProjectTlsFile(root, config.tlsPrivateKeyPath)]);
			this._server = createHttpsServer({ cert, key }, (req, res) => void this._handle(req, res));
		} else {
			this._server = createHttpServer((req, res) => void this._handle(req, res));
		}
		await new Promise<void>((resolveListen, rejectListen) => {
			this._server!.once("error", rejectListen);
			this._server!.listen(config.port, config.bindAddress, () => {
				this._server!.off("error", rejectListen);
				resolveListen();
			});
		});
		this._actualPort = (this._server.address() as AddressInfo).port;
		this._config = config;
		this._keepAlive = setInterval(() => {
			for (const subscriber of this._subscribers) {
				subscriber.write(": keepalive\n\n");
			}
		}, keepAliveMilliseconds);
	}

	private async _stop(): Promise<void> {
		if (this._keepAlive) {
			clearInterval(this._keepAlive);
			this._keepAlive = null;
		}
		for (const subscriber of this._subscribers) {
			subscriber.end();
		}
		this._subscribers.clear();
		if (this._server) {
			const server = this._server;
			this._server = null;
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
		this._actualPort = null;
	}

	private _validateRequest(req: IncomingMessage): void {
		const host = req.headers.host?.toLowerCase() ?? "";
		if (!this._config.allowedHosts.includes(host)) {
			throw new Error("Remote collaboration request Host is not allowed.");
		}
		const origin = req.headers.origin;
		if (origin && !this._config.allowedOrigins.includes(origin)) {
			throw new Error("Remote collaboration request Origin is not allowed.");
		}
	}

	private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		try {
			this._validateRequest(req);
			const origin = req.headers.origin;
			if (origin && this._config.allowedOrigins.includes(origin)) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Vary", "Origin");
			}
			if (req.method === "OPTIONS") {
				res.writeHead(204, { "Access-Control-Allow-Headers": "Authorization, Content-Type, Last-Event-ID", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
				res.end();
				return;
			}
			if (req.method === "GET" && req.url === "/health") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, tls: Boolean(this._config.tlsCertificatePath) }));
				return;
			}
			const token = bearerToken(req);
			const options = { editor: this._editor! };
			const actor = await resolveProjectCollaborationActor(token, options);
			if (req.method === "GET" && req.url?.startsWith("/events")) {
				const lastEventId = Number(req.headers["last-event-id"] ?? 0);
				const after = Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
				for (const event of this.events(after, maximumEvents).events) {
					res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				}
				res.write(`event: connected\ndata: ${JSON.stringify({ actor, latestSequence: this._nextSequence - 1 })}\n\n`);
				this._subscribers.add(res);
				req.on("close", () => this._subscribers.delete(res));
				return;
			}
			if (req.method === "POST" && req.url === "/presence") {
				const body = await readJsonBody(req);
				const result = await heartbeatProjectCollaborationSession(this._editor!.layout.preview.scene, { ...body, collaborationToken: token }, options);
				await this.publish({
					type: "presence",
					source: "remote",
					endpoint: "heartbeat_project_collaboration_session",
					success: true,
					actor,
					details: "Presence heartbeat updated.",
				});
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
				return;
			}
			const lockEndpoint =
				req.method === "GET" && req.url?.startsWith("/locks")
					? "list_project_asset_locks"
					: req.method === "POST" && req.url === "/locks/acquire"
						? "acquire_project_asset_lock"
						: req.method === "POST" && req.url === "/locks/refresh"
							? "refresh_project_asset_lock"
							: req.method === "POST" && req.url === "/locks/release"
								? "release_project_asset_lock"
								: null;
			if (lockEndpoint) {
				if (!this._endpoints![lockEndpoint]) {
					throw new Error("Remote asset-lock federation is unavailable in this editor build.");
				}
				const body = req.method === "POST" ? await readJsonBody(req) : {};
				const data = { ...body, collaborationToken: token };
				await authorizeProjectCollaborationRequest(lockEndpoint, data, options);
				try {
					const result = await this._endpoints![lockEndpoint](this._editor!.layout.preview.scene, data, options);
					const outcome = result?.acquired === false ? "conflict" : "completed";
					await this.publish({
						type: "lock",
						source: "remote",
						endpoint: lockEndpoint,
						success: result?.acquired !== false,
						actor,
						details: `Remote asset-lock operation ${outcome}.`,
					});
					res.writeHead(result?.acquired === false ? 409 : 200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(result ?? null));
				} catch (error) {
					await this.publish({
						type: "lock",
						source: "remote",
						endpoint: lockEndpoint,
						success: false,
						actor,
						details: error instanceof Error ? error.message.slice(0, 256) : "Remote asset-lock operation failed.",
					});
					throw error;
				}
				return;
			}
			if (req.method === "POST" && req.url === "/action") {
				const body = await readJsonBody(req);
				if (typeof body.endpoint !== "string" || !body.endpoint || !this._endpoints![body.endpoint]) {
					throw new Error("Remote action endpoint is missing or unknown.");
				}
				const data = { ...(body.data ?? {}), collaborationToken: token, endpoint: body.endpoint };
				await authorizeProjectCollaborationRequest(body.endpoint, data, options);
				try {
					const result = await this._endpoints![body.endpoint](this._editor!.layout.preview.scene, data, options);
					await this.publish({ type: "operation", source: "remote", endpoint: body.endpoint, success: true, actor, details: "Remote editor action completed." });
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify(result ?? null));
				} catch (error) {
					await this.publish({
						type: "operation",
						source: "remote",
						endpoint: body.endpoint,
						success: false,
						actor,
						details: error instanceof Error ? error.message.slice(0, 256) : "Remote action failed.",
					});
					throw error;
				}
				return;
			}
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unknown remote collaboration route." }));
		} catch (error) {
			if (!res.headersSent) {
				res.writeHead(403, { "Content-Type": "application/json" });
			}
			res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		}
	}
}

const remoteRuntime = new RemoteCollaborationRuntime();

export async function initializeRemoteCollaborationGateway(editor: Editor, endpoints: EndpointMap): Promise<void> {
	await remoteRuntime.initialize(editor, endpoints);
	await initializeRemoteCollaborationDiscovery(editor, () => remoteRuntime.status());
	await initializeRemoteCollaborationRelay(editor, (request) => remoteRuntime.relayRequest(request));
}

export async function shutdownRemoteCollaborationGateway(): Promise<void> {
	await shutdownRemoteCollaborationRelay();
	await shutdownRemoteCollaborationDiscovery();
	await remoteRuntime.shutdown();
}

export async function publishRemoteCollaborationOperation(endpoint: string, success: boolean, token: unknown, options: IMCPActionOptions, details: string): Promise<void> {
	let actor: any = null;
	if (token) {
		actor = await resolveProjectCollaborationActor(token, options).catch(() => null);
	}
	await remoteRuntime.publish({
		type: endpoint === "heartbeat_project_collaboration_session" ? "presence" : "operation",
		source: "local",
		endpoint,
		success,
		actor,
		details: details.slice(0, 256),
	});
}

export async function getRemoteCollaborationGateway(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await resolveProjectCollaborationActor(data.collaborationToken, options);
	return remoteRuntime.status();
}

export async function setRemoteCollaborationGateway(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Remote collaboration gateway configuration requires the admin role.");
	}
	const current = remoteRuntime.status().config as IRemoteCollaborationConfig;
	const port = data.port ?? current.port;
	const bindAddress = data.bindAddress ?? current.bindAddress;
	const allowedHosts = data.allowedHosts ?? (data.port !== undefined || data.bindAddress !== undefined ? [`${bindAddress}:${port}`] : current.allowedHosts);
	const config = validateConfig({
		...current,
		...data,
		version: configVersion,
		allowedHosts,
		tlsCertificatePath: data.tlsCertificatePath === undefined ? current.tlsCertificatePath : data.tlsCertificatePath || null,
		tlsPrivateKeyPath: data.tlsPrivateKeyPath === undefined ? current.tlsPrivateKeyPath : data.tlsPrivateKeyPath || null,
	});
	const status = await remoteRuntime.configure(config);
	await synchronizeRemoteCollaborationDiscovery();
	return status;
}

export async function listRemoteCollaborationEvents(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await resolveProjectCollaborationActor(data.collaborationToken, options);
	const afterSequence = data.afterSequence ?? 0;
	const limit = data.limit ?? 100;
	if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
		throw new Error("afterSequence must be a non-negative safe integer.");
	}
	if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
		throw new Error("limit must be an integer from 1 through 500.");
	}
	const result = remoteRuntime.events(afterSequence, maximumEvents);
	const filtered = result.events.filter(
		(event: IRemoteCollaborationEvent) =>
			(data.type === undefined || event.type === data.type) &&
			(data.source === undefined || event.source === data.source) &&
			(data.success === undefined || event.success === data.success) &&
			(data.endpoint === undefined || event.endpoint === data.endpoint)
	);
	const events = filtered.slice(0, limit);
	return {
		...result,
		events,
		count: events.length,
		truncated: filtered.length > limit,
		hasMore: filtered.length > limit,
		nextAfterSequence: events.at(-1)?.sequence ?? afterSequence,
		filters: { type: data.type ?? null, source: data.source ?? null, success: data.success ?? null, endpoint: data.endpoint ?? null },
	};
}

export async function setRemoteCollaborationEventHistory(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Remote collaboration event-history configuration requires the admin role.");
	}
	const current = remoteRuntime.status().eventHistory;
	const enabled = data.enabled ?? current.enabled;
	const retention = data.retention ?? current.retention;
	if (typeof enabled !== "boolean") {
		throw new Error("enabled must be a boolean.");
	}
	if (!Number.isInteger(retention) || retention < minimumEventRetention || retention > maximumEvents) {
		throw new Error(`retention must be an integer from ${minimumEventRetention} through ${maximumEvents}.`);
	}
	return remoteRuntime.configureHistory(enabled, retention);
}

export async function clearRemoteCollaborationEventHistory(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Clearing remote collaboration event history requires the admin role.");
	}
	if (data.confirm !== true) {
		throw new Error("confirm must be true to clear remote collaboration event history.");
	}
	return remoteRuntime.clearHistory();
}

/** Reports the authenticated remote asset-lock federation surface and live gateway availability. */
export async function getProjectAssetLockFederation(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	const status = remoteRuntime.status();
	return {
		running: status.running,
		protocol: status.protocol,
		bindAddress: status.config.bindAddress,
		port: status.actualPort ?? status.config.port,
		allowedHosts: status.config.allowedHosts,
		identityMode: status.assetLockFederation.identityMode,
		routes: status.assetLockFederation.routes,
		permissions: {
			list: true,
			acquire: actor.role !== "viewer",
			refreshOwn: actor.role !== "viewer",
			releaseOwn: actor.role !== "viewer",
			forceRelease: actor.role === "admin",
		},
		actor,
	};
}
