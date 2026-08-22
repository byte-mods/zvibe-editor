import { createHash, randomBytes, randomUUID } from "crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { lstat, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";

import { Scene } from "babylonjs";
import { ProjectServiceCategory, ProjectServiceJson, ProjectServiceScalar } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../../action";
import { getProjectPackageContext } from "../package-manager/context";
import { ensureProjectStoreDirectory } from "../project-store";
import { getProjectServicesConfiguration } from "./configuration";
import { IProjectServiceEmulatorEvent, IProjectServiceEnvironment } from "./types";

const maximumBodyBytes = 1024 * 1024;
const maximumStateBytes = 16 * 1024 * 1024;
const maximumAnalyticsEvents = 10_000;
const maximumAuditEvents = 2_000;
const maximumTransactionEntries = 10_000;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const profilePattern = /^[A-Za-z0-9_-]{1,64}$/;

interface IEmulatorCloudSaveItem {
	key: string;
	value: ProjectServiceJson;
	revision: number;
	updatedAt: string;
}

interface IEmulatorPurchase {
	id: string;
	playerId: string;
	productId: string;
	idempotencyKey: string;
	purchasedAt: string;
	payouts: Array<{ id: string; quantity: number }>;
}

interface IEmulatorTicket {
	id: string;
	queue: string;
	playerId: string;
	status: "searching" | "matched" | "canceled" | "timed-out";
	createdAt: string;
	customData: ProjectServiceJson;
	idempotencyKey?: string;
	match?: { id: string; playerIds: string[]; assignment: ProjectServiceJson };
}

interface IEmulatorLeaderboardScore {
	playerId: string;
	score: number;
	metadata: ProjectServiceJson;
	updatedAt: string;
}

interface IEmulatorFunctionExecution {
	id: string;
	functionId: string;
	playerId: string | null;
	idempotencyKey: string | null;
	result: ProjectServiceJson;
	executedAt: string;
}

interface IProjectServicesEmulatorState {
	version: 2;
	environmentId: string;
	sequence: number;
	profiles: Record<string, string>;
	externalIdentities: Record<string, string>;
	cloudSave: Record<string, Record<string, IEmulatorCloudSaveItem>>;
	analytics: Array<{ id: string; playerId: string; name: string; parameters: Record<string, ProjectServiceScalar>; timestamp: string }>;
	purchases: IEmulatorPurchase[];
	adImpressions: Array<{ id: string; playerId: string; placementId: string; shownAt: string; reward: { id: string; quantity: number } | null }>;
	tickets: IEmulatorTicket[];
	leaderboardScores: Record<string, Record<string, IEmulatorLeaderboardScore>>;
	functionExecutions: IEmulatorFunctionExecution[];
	events: IProjectServiceEmulatorEvent[];
}

class EmulatorHttpError extends Error {
	public constructor(
		public readonly status: number,
		public readonly code: string,
		message: string
	) {
		super(message);
	}
}

function emptyState(environmentId: string): IProjectServicesEmulatorState {
	return {
		version: 2,
		environmentId,
		sequence: 0,
		profiles: {},
		externalIdentities: {},
		cloudSave: {},
		analytics: [],
		purchases: [],
		adImpressions: [],
		tickets: [],
		leaderboardScores: {},
		functionExecutions: [],
		events: [],
	};
}

function assertIdentifier(value: unknown, label: string): string {
	if (typeof value !== "string" || !identifierPattern.test(value)) {
		throw new EmulatorHttpError(400, "invalid_argument", `${label} must be a valid 1–128 character identifier.`);
	}
	return value;
}

function object(value: unknown, label: string): Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new EmulatorHttpError(400, "invalid_argument", `${label} must be an object.`);
	}
	return value as Record<string, any>;
}

function jsonValue(value: unknown, label: string): ProjectServiceJson {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new EmulatorHttpError(400, "invalid_argument", `${label} must be JSON-serializable.`);
	}
	if (serialized === undefined || Buffer.byteLength(serialized) > maximumBodyBytes) {
		throw new EmulatorHttpError(400, "invalid_argument", `${label} exceeds the JSON size limit.`);
	}
	return JSON.parse(serialized) as ProjectServiceJson;
}

function validateLoadedState(value: unknown, environmentId: string): IProjectServicesEmulatorState {
	const source = value as Partial<IProjectServicesEmulatorState> | null;
	if (
		!source ||
		typeof source !== "object" ||
		![1, 2].includes(source.version as number) ||
		source.environmentId !== environmentId ||
		!Number.isSafeInteger(source.sequence) ||
		!source.profiles ||
		typeof source.profiles !== "object" ||
		Array.isArray(source.profiles) ||
		!source.externalIdentities ||
		typeof source.externalIdentities !== "object" ||
		Array.isArray(source.externalIdentities) ||
		!source.cloudSave ||
		typeof source.cloudSave !== "object" ||
		Array.isArray(source.cloudSave) ||
		!Array.isArray(source.analytics) ||
		!Array.isArray(source.purchases) ||
		!Array.isArray(source.adImpressions) ||
		!Array.isArray(source.tickets) ||
		(source.leaderboardScores !== undefined && (!source.leaderboardScores || typeof source.leaderboardScores !== "object" || Array.isArray(source.leaderboardScores))) ||
		(source.functionExecutions !== undefined && !Array.isArray(source.functionExecutions)) ||
		!Array.isArray(source.events) ||
		source.analytics.length > maximumAnalyticsEvents ||
		source.purchases.length > maximumTransactionEntries ||
		source.adImpressions.length > maximumTransactionEntries ||
		source.tickets.length > maximumTransactionEntries ||
		(source.functionExecutions?.length ?? 0) > maximumTransactionEntries ||
		source.events.length > maximumAuditEvents
	) {
		throw new Error(`Project services emulator state for ${environmentId} is malformed.`);
	}
	const migrated = JSON.parse(JSON.stringify(source)) as IProjectServicesEmulatorState;
	migrated.version = 2;
	migrated.leaderboardScores ??= {};
	migrated.functionExecutions ??= [];
	let scoreCount = 0;
	for (const [leaderboardId, board] of Object.entries(migrated.leaderboardScores)) {
		if (!identifierPattern.test(leaderboardId) || !board || typeof board !== "object" || Array.isArray(board)) {
			throw new Error(`Project services emulator leaderboard ${leaderboardId} is malformed.`);
		}
		for (const [playerId, score] of Object.entries(board)) {
			scoreCount++;
			if (
				!identifierPattern.test(playerId) ||
				!score ||
				score.playerId !== playerId ||
				typeof score.score !== "number" ||
				!Number.isFinite(score.score) ||
				Math.abs(score.score) > Number.MAX_SAFE_INTEGER ||
				typeof score.updatedAt !== "string" ||
				!Number.isFinite(Date.parse(score.updatedAt))
			) {
				throw new Error(`Project services emulator leaderboard score ${leaderboardId}/${playerId} is malformed.`);
			}
			jsonValue(score.metadata, `leaderboard score ${leaderboardId}/${playerId} metadata`);
		}
	}
	if (scoreCount > maximumTransactionEntries) {
		throw new Error(`Project services emulator leaderboard state for ${environmentId} exceeds its capacity.`);
	}
	for (const execution of migrated.functionExecutions) {
		if (
			!execution ||
			!identifierPattern.test(execution.id) ||
			!identifierPattern.test(execution.functionId) ||
			(execution.playerId !== null && !identifierPattern.test(execution.playerId)) ||
			(execution.idempotencyKey !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(execution.idempotencyKey)) ||
			typeof execution.executedAt !== "string" ||
			!Number.isFinite(Date.parse(execution.executedAt))
		) {
			throw new Error("Project services emulator Cloud Function execution state is malformed.");
		}
		jsonValue(execution.result, `Cloud Function execution ${execution.id} result`);
	}
	return migrated;
}

async function loadState(path: string, environmentId: string): Promise<IProjectServicesEmulatorState> {
	let fileStat;
	try {
		fileStat = await lstat(path);
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return emptyState(environmentId);
		}
		throw error;
	}
	if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.size > maximumStateBytes) {
		throw new Error("Project services emulator state must be a bounded regular file and cannot be a symbolic link.");
	}
	try {
		return validateLoadedState(JSON.parse((await readFile(path)).toString("utf8")), environmentId);
	} catch (error) {
		throw new Error(`Could not load project services emulator state: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function persistState(path: string, state: IProjectServicesEmulatorState): Promise<void> {
	let targetStat;
	try {
		targetStat = await lstat(path);
	} catch (error: any) {
		if (error?.code !== "ENOENT") {
			throw error;
		}
	}
	if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
		throw new Error("Project services emulator state cannot replace a symbolic link or non-file path.");
	}
	const serialized = `${JSON.stringify(state, null, 2)}\n`;
	if (Buffer.byteLength(serialized) > maximumStateBytes) {
		throw new Error("Project services emulator state exceeded its 16 MiB limit.");
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function readBody(request: IncomingMessage): Promise<Record<string, any>> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > maximumBodyBytes) {
			throw new EmulatorHttpError(413, "request_too_large", "Request body exceeds 1 MiB.");
		}
		chunks.push(buffer);
	}
	if (!chunks.length) {
		return {};
	}
	try {
		return object(JSON.parse(Buffer.concat(chunks).toString("utf8")), "request body");
	} catch (error) {
		if (error instanceof EmulatorHttpError) {
			throw error;
		}
		throw new EmulatorHttpError(400, "malformed_json", "Request body is not valid JSON.");
	}
}

function sendJson(response: ServerResponse, status: number, payload: unknown, origin: string | null): void {
	const body = JSON.stringify(payload);
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	response.setHeader("Content-Length", Buffer.byteLength(body));
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	if (origin) {
		response.setHeader("Access-Control-Allow-Origin", origin);
		response.setHeader("Vary", "Origin");
	}
	response.end(body);
}

function allowedOrigin(request: IncomingMessage): string | null {
	const origin = request.headers.origin;
	if (!origin) {
		return null;
	}
	if (origin === "null") {
		return origin;
	}
	try {
		const url = new URL(origin);
		return ["localhost", "127.0.0.1", "::1"].includes(url.hostname) && ["http:", "https:"].includes(url.protocol) ? origin : null;
	} catch {
		return null;
	}
}

class ProjectServicesEmulator {
	private readonly _sessions = new Map<string, string>();
	private _writeChain: Promise<void> = Promise.resolve();
	private _startedAt = "";
	private _port = 0;
	private _server: Server | null = null;

	public constructor(
		private readonly _environment: IProjectServiceEnvironment,
		private _state: IProjectServicesEmulatorState,
		private readonly _statePath: string
	) {}

	public async start(port: number): Promise<void> {
		const server = createServer((request, response) => {
			void this._handle(request, response);
		});
		server.requestTimeout = 15_000;
		server.headersTimeout = 10_000;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		this._server = server;
		this._port = (server.address() as { port: number }).port;
		this._startedAt = new Date().toISOString();
		server.unref();
		await persistState(this._statePath, this._state);
	}

	public async stop(): Promise<void> {
		const server = this._server;
		this._server = null;
		this._sessions.clear();
		if (server) {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
		// Closing first prevents new requests; the chain then covers every mutation accepted before shutdown.
		await this._writeChain.catch(() => undefined);
	}

	public status(): any {
		return {
			running: this._server !== null,
			environmentId: this._environment.id,
			endpoint: `http://127.0.0.1:${this._port}`,
			host: "127.0.0.1",
			port: this._port,
			startedAt: this._startedAt,
			statePath: `.zvibe/services/emulator/${this._environment.id}.json`,
			counts: {
				players: new Set([...Object.values(this._state.profiles), ...Object.values(this._state.externalIdentities)]).size,
				cloudSaveItems: Object.values(this._state.cloudSave).reduce((sum, items) => sum + Object.keys(items).length, 0),
				analyticsEvents: this._state.analytics.length,
				purchases: this._state.purchases.length,
				adImpressions: this._state.adImpressions.length,
				matchTickets: this._state.tickets.length,
				leaderboardScores: Object.values(this._state.leaderboardScores).reduce((sum, board) => sum + Object.keys(board).length, 0),
				functionExecutions: this._state.functionExecutions.length,
				auditEvents: this._state.events.length,
			},
		};
	}

	public events(data: any): { events: IProjectServiceEmulatorEvent[]; nextSequence: number } {
		const limit = data?.limit ?? 100;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
			throw new Error("Emulator event limit must be an integer from 1 through 200.");
		}
		const afterSequence = data?.afterSequence ?? 0;
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
			throw new Error("afterSequence must be a non-negative safe integer.");
		}
		const filtered = this._state.events
			.filter((event) => event.sequence > afterSequence)
			.filter((event) => data.category === undefined || event.category === data.category)
			.filter((event) => data.action === undefined || event.action === data.action)
			.filter((event) => data.playerId === undefined || event.playerId === data.playerId)
			.slice(0, limit);
		return { events: JSON.parse(JSON.stringify(filtered)), nextSequence: filtered.at(-1)?.sequence ?? afterSequence };
	}

	public async reset(): Promise<void> {
		this._sessions.clear();
		await this._mutate(() => {
			this._state = emptyState(this._environment.id);
		});
	}

	private async _mutate<T>(operation: () => T): Promise<T> {
		let result!: T;
		const queued = this._writeChain
			.catch(() => undefined)
			.then(async () => {
				const before = JSON.parse(JSON.stringify(this._state)) as IProjectServicesEmulatorState;
				try {
					result = operation();
					await persistState(this._statePath, this._state);
				} catch (error) {
					this._state = before;
					throw error;
				}
			});
		this._writeChain = queued;
		await queued;
		return result;
	}

	private _audit(category: ProjectServiceCategory, action: string, playerId: string | null, details: Record<string, ProjectServiceScalar> = {}): void {
		this._state.events.push({ sequence: ++this._state.sequence, timestamp: new Date().toISOString(), category, action, playerId, details });
		if (this._state.events.length > maximumAuditEvents) {
			this._state.events.splice(0, this._state.events.length - maximumAuditEvents);
		}
	}

	private _player(request: IncomingMessage): string {
		const authorization = request.headers.authorization;
		const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
		const playerId = this._sessions.get(token);
		if (!playerId) {
			throw new EmulatorHttpError(401, "authentication_required", "Authenticate before using this route.");
		}
		return playerId;
	}

	private _session(playerId: string): { playerId: string; profile: string; expiresAt: string; accessToken: string } {
		const accessToken = randomBytes(32).toString("base64url");
		this._sessions.set(accessToken, playerId);
		return { playerId, profile: "local", expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), accessToken };
	}

	private _expireTicket(ticket: IEmulatorTicket): void {
		if (ticket.status !== "searching") {
			return;
		}
		const queue = this._environment.resources.matchmakingQueues.find((entry) => entry.id === ticket.queue);
		if (queue && Date.now() - Date.parse(ticket.createdAt) >= queue.ticketTimeoutSeconds * 1000) {
			ticket.status = "timed-out";
		}
	}

	private _match(queueId: string): void {
		const queue = this._environment.resources.matchmakingQueues.find((entry) => entry.id === queueId);
		if (!queue) {
			return;
		}
		const waiting = this._state.tickets.filter((ticket) => ticket.queue === queueId && ticket.status === "searching").slice(0, queue.maxPlayers);
		if (waiting.length < queue.minPlayers) {
			return;
		}
		const match = { id: randomUUID(), playerIds: waiting.map((ticket) => ticket.playerId), assignment: { provider: "local", endpoint: null } as ProjectServiceJson };
		waiting.forEach((ticket) => {
			ticket.status = "matched";
			ticket.match = match;
		});
	}

	private async _handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const origin = allowedOrigin(request);
		if (request.headers.origin && !origin) {
			sendJson(response, 403, { error: "Cross-origin access is limited to loopback development origins.", code: "origin_forbidden" }, null);
			return;
		}
		if (request.method === "OPTIONS") {
			response.statusCode = 204;
			if (origin) {
				response.setHeader("Access-Control-Allow-Origin", origin);
				response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
				response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Idempotency-Key, X-Zvibe-Environment");
				response.setHeader("Vary", "Origin");
			}
			response.end();
			return;
		}
		try {
			if (request.headers["x-zvibe-environment"] !== this._environment.id) {
				throw new EmulatorHttpError(409, "environment_mismatch", `Use X-Zvibe-Environment: ${this._environment.id}.`);
			}
			const url = new URL(request.url ?? "/", `http://127.0.0.1:${this._port}`);
			const payload = await this._route(request, url);
			sendJson(response, 200, payload, origin);
		} catch (error) {
			const status = error instanceof EmulatorHttpError ? error.status : 500;
			const code = error instanceof EmulatorHttpError ? error.code : "emulator_error";
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, status, { error: message.slice(0, 1024), code }, origin);
		}
	}

	private async _route(request: IncomingMessage, url: URL): Promise<unknown> {
		const method = request.method ?? "GET";
		const path = url.pathname;
		if (method === "POST" && path === "/v1/auth/anonymous") {
			const body = await readBody(request);
			if (typeof body.profile !== "string" || !profilePattern.test(body.profile)) {
				throw new EmulatorHttpError(400, "invalid_profile", "Anonymous profile is invalid.");
			}
			const playerId = await this._mutate(() => {
				const id = this._state.profiles[body.profile] ?? randomUUID();
				this._state.profiles[body.profile] = id;
				this._audit("auth", "sign-in-anonymous", id, { profile: body.profile });
				return id;
			});
			return this._session(playerId);
		}
		if (method === "POST" && path === "/v1/auth/custom") {
			const body = await readBody(request);
			const externalId = assertIdentifier(body.externalId, "externalId");
			if (typeof body.credential !== "string" || !body.credential || body.credential.length > 4096) {
				throw new EmulatorHttpError(400, "invalid_credential", "Local custom credential must contain 1–4096 characters.");
			}
			const playerId = await this._mutate(() => {
				const id = this._state.externalIdentities[externalId] ?? randomUUID();
				this._state.externalIdentities[externalId] = id;
				this._audit("auth", "sign-in-custom", id, { externalId });
				return id;
			});
			return this._session(playerId);
		}
		if (path === "/v1/cloud-save" && method === "GET") {
			const playerId = this._player(request);
			const keys =
				url.searchParams
					.get("keys")
					?.split(",")
					.filter(Boolean)
					.map((key) => assertIdentifier(key, "Cloud Save key")) ?? [];
			const items = this._state.cloudSave[playerId] ?? {};
			return { items: (keys.length ? keys.map((key) => items[key]).filter(Boolean) : Object.values(items)).map((item) => JSON.parse(JSON.stringify(item))) };
		}
		if (path === "/v1/cloud-save" && method === "PUT") {
			const playerId = this._player(request);
			const body = await readBody(request);
			if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) {
				throw new EmulatorHttpError(400, "invalid_items", "Cloud Save writes require 1–100 items.");
			}
			const entries = body.items.map((entry: unknown) => {
				const source = object(entry, "Cloud Save item");
				return { key: assertIdentifier(source.key, "Cloud Save key"), value: jsonValue(source.value, "Cloud Save value"), expectedRevision: source.expectedRevision };
			});
			if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
				throw new EmulatorHttpError(400, "duplicate_key", "Cloud Save writes cannot contain duplicate keys.");
			}
			return this._mutate(() => {
				const current = (this._state.cloudSave[playerId] ??= {});
				for (const entry of entries) {
					const revision = current[entry.key]?.revision ?? 0;
					if (entry.expectedRevision !== undefined && entry.expectedRevision !== revision) {
						throw new EmulatorHttpError(409, "revision_conflict", `Cloud Save key ${entry.key} expected revision ${revision}.`);
					}
				}
				const updated = entries.map((entry) => {
					const item = { key: entry.key, value: entry.value, revision: (current[entry.key]?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
					current[entry.key] = item;
					return item;
				});
				this._audit("cloudSave", "write", playerId, { itemCount: updated.length });
				return { items: updated };
			});
		}
		if (path === "/v1/cloud-save" && method === "DELETE") {
			const playerId = this._player(request);
			const body = await readBody(request);
			if (!Array.isArray(body.items) || !body.items.length || body.items.length > 100) {
				throw new EmulatorHttpError(400, "invalid_items", "Cloud Save deletes require 1–100 items.");
			}
			const entries = body.items.map((entry: unknown) => {
				const source = object(entry, "Cloud Save item");
				return { key: assertIdentifier(source.key, "Cloud Save key"), expectedRevision: source.expectedRevision };
			});
			if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
				throw new EmulatorHttpError(400, "duplicate_key", "Cloud Save deletes cannot contain duplicate keys.");
			}
			return this._mutate(() => {
				const current = (this._state.cloudSave[playerId] ??= {});
				for (const entry of entries) {
					const revision = current[entry.key]?.revision ?? 0;
					if (entry.expectedRevision !== undefined && entry.expectedRevision !== revision) {
						throw new EmulatorHttpError(409, "revision_conflict", `Cloud Save key ${entry.key} expected revision ${revision}.`);
					}
				}
				entries.forEach((entry) => delete current[entry.key]);
				this._audit("cloudSave", "delete", playerId, { itemCount: entries.length });
				return { deleted: entries.map((entry) => entry.key) };
			});
		}
		if (path === "/v1/analytics/events" && method === "POST") {
			const playerId = this._player(request);
			const body = await readBody(request);
			if (!Array.isArray(body.events) || !body.events.length || body.events.length > 100) {
				throw new EmulatorHttpError(400, "invalid_events", "Analytics batches require 1–100 events.");
			}
			return this._mutate(() => {
				let accepted = 0;
				let rejected = 0;
				for (const entry of body.events) {
					const source = object(entry, "Analytics event");
					const definition = this._environment.resources.analyticsEvents.find((candidate) => candidate.enabled && candidate.name === source.name);
					const parameters = source.parameters === undefined ? {} : object(source.parameters, "Analytics parameters");
					const valid =
						definition &&
						definition.parameters.every((parameter) => {
							const value = parameters[parameter.name];
							if (value === undefined) {
								return !parameter.required;
							}
							if (parameter.type === "integer") {
								return Number.isSafeInteger(value);
							}
							if (parameter.type === "number") {
								return typeof value === "number" && Number.isFinite(value);
							}
							if (parameter.type === "boolean") {
								return typeof value === "boolean";
							}
							if (parameter.type === "timestamp") {
								return typeof value === "string" && Number.isFinite(Date.parse(value));
							}
							return typeof value === "string";
						}) &&
						Object.keys(parameters).every((name) => definition.parameters.some((parameter) => parameter.name === name));
					if (!valid) {
						rejected++;
						continue;
					}
					this._state.analytics.push({
						id: typeof source.eventId === "string" ? source.eventId : randomUUID(),
						playerId,
						name: source.name,
						parameters,
						timestamp: typeof source.timestamp === "string" ? source.timestamp : new Date().toISOString(),
					});
					accepted++;
				}
				this._state.analytics.splice(0, Math.max(0, this._state.analytics.length - maximumAnalyticsEvents));
				this._audit("analytics", "record", playerId, { accepted, rejected });
				return { accepted, rejected };
			});
		}
		if (path === "/v1/iap/products" && method === "GET") {
			return { products: this._environment.resources.iapProducts.map(({ payouts: _payouts, ...product }) => product) };
		}
		if (path === "/v1/iap/purchases" && method === "POST") {
			const playerId = this._player(request);
			const body = await readBody(request);
			const productId = assertIdentifier(body.productId, "productId");
			const idempotencyKey = request.headers["x-idempotency-key"];
			if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
				throw new EmulatorHttpError(400, "invalid_idempotency_key", "A valid X-Idempotency-Key header is required.");
			}
			const product = this._environment.resources.iapProducts.find((entry) => entry.id === productId);
			if (!product) {
				throw new EmulatorHttpError(404, "product_not_found", `Unknown IAP product: ${productId}.`);
			}
			return this._mutate(() => {
				const existing = this._state.purchases.find((entry) => entry.playerId === playerId && entry.idempotencyKey === idempotencyKey);
				if (existing) {
					return existing;
				}
				if (this._state.purchases.length >= maximumTransactionEntries) {
					throw new EmulatorHttpError(429, "emulator_capacity", "The local purchase history reached its capacity; reset emulator data.");
				}
				const purchase: IEmulatorPurchase = { id: randomUUID(), playerId, productId, idempotencyKey, purchasedAt: new Date().toISOString(), payouts: product.payouts };
				this._state.purchases.push(purchase);
				this._audit("iap", "purchase", playerId, { productId });
				return purchase;
			});
		}
		if (path === "/v1/iap/purchases" && method === "GET") {
			const playerId = this._player(request);
			return { purchases: this._state.purchases.filter((entry) => entry.playerId === playerId) };
		}
		if (path === "/v1/ads/placements" && method === "GET") {
			return { placements: this._environment.resources.adPlacements.map((placement) => ({ ...placement, ...(placement.reward ? { reward: placement.reward } : {}) })) };
		}
		const adMatch = path.match(/^\/v1\/ads\/placements\/([^/]+)\/show$/);
		if (adMatch && method === "POST") {
			const playerId = this._player(request);
			const placementId = assertIdentifier(decodeURIComponent(adMatch[1]), "placementId");
			const placement = this._environment.resources.adPlacements.find((entry) => entry.id === placementId);
			if (!placement) {
				throw new EmulatorHttpError(404, "placement_not_found", `Unknown ad placement: ${placementId}.`);
			}
			return this._mutate(() => {
				const impression = { id: randomUUID(), playerId, placementId, shownAt: new Date().toISOString(), reward: placement.reward };
				this._state.adImpressions.push(impression);
				this._state.adImpressions.splice(0, Math.max(0, this._state.adImpressions.length - maximumTransactionEntries));
				this._audit("ads", "show", playerId, { placementId });
				return { completed: true, impressionId: impression.id, reward: impression.reward };
			});
		}
		if (path === "/v1/matchmaking/tickets" && method === "POST") {
			const playerId = this._player(request);
			const body = await readBody(request);
			const queueId = assertIdentifier(body.queue, "queue");
			if (!this._environment.resources.matchmakingQueues.some((entry) => entry.id === queueId)) {
				throw new EmulatorHttpError(404, "queue_not_found", `Unknown matchmaking queue: ${queueId}.`);
			}
			const customData = jsonValue(body.customData ?? null, "customData");
			const idempotencyKey = request.headers["x-idempotency-key"];
			if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))) {
				throw new EmulatorHttpError(400, "invalid_idempotency_key", "X-Idempotency-Key must contain 8–128 URL-safe characters.");
			}
			return this._mutate(() => {
				const existing = idempotencyKey ? this._state.tickets.find((ticket) => ticket.playerId === playerId && ticket.idempotencyKey === idempotencyKey) : undefined;
				if (existing) {
					return existing;
				}
				if (this._state.tickets.length >= maximumTransactionEntries) {
					throw new EmulatorHttpError(429, "emulator_capacity", "The local matchmaking history reached its capacity; reset emulator data.");
				}
				const ticket: IEmulatorTicket = {
					id: randomUUID(),
					queue: queueId,
					playerId,
					status: "searching",
					createdAt: new Date().toISOString(),
					customData,
					...(idempotencyKey ? { idempotencyKey } : {}),
				};
				this._state.tickets.push(ticket);
				this._match(queueId);
				this._audit("matchmaking", "create-ticket", playerId, { queue: queueId, status: ticket.status });
				return ticket;
			});
		}
		const ticketMatch = path.match(/^\/v1\/matchmaking\/tickets\/([^/]+)$/);
		if (ticketMatch && ["GET", "DELETE"].includes(method)) {
			const playerId = this._player(request);
			const ticketId = assertIdentifier(decodeURIComponent(ticketMatch[1]), "ticketId");
			return this._mutate(() => {
				const ticket = this._state.tickets.find((entry) => entry.id === ticketId && entry.playerId === playerId);
				if (!ticket) {
					throw new EmulatorHttpError(404, "ticket_not_found", `Unknown matchmaking ticket: ${ticketId}.`);
				}
				this._expireTicket(ticket);
				if (method === "DELETE" && ticket.status === "searching") {
					ticket.status = "canceled";
				}
				this._audit("matchmaking", method === "DELETE" ? "cancel-ticket" : "get-ticket", playerId, { status: ticket.status });
				return ticket;
			});
		}
		const leaderboardMatch = path.match(/^\/v1\/leaderboards\/([^/]+)\/(scores|score)$/);
		if (leaderboardMatch) {
			const playerId = this._player(request);
			const leaderboardId = assertIdentifier(decodeURIComponent(leaderboardMatch[1]), "leaderboardId");
			const definition = this._environment.resources.leaderboards.find((entry) => entry.id === leaderboardId);
			if (!definition) {
				throw new EmulatorHttpError(404, "leaderboard_not_found", `Unknown leaderboard: ${leaderboardId}.`);
			}
			const ranked = (): Array<IEmulatorLeaderboardScore & { rank: number }> => {
				const scores = Object.values(this._state.leaderboardScores[leaderboardId] ?? {});
				scores.sort((left, right) => {
					const delta = definition.sortOrder === "descending" ? right.score - left.score : left.score - right.score;
					return delta || left.updatedAt.localeCompare(right.updatedAt) || left.playerId.localeCompare(right.playerId);
				});
				return scores.slice(0, definition.maxEntries).map((entry, index) => ({ ...entry, rank: index + 1 }));
			};
			if (method === "GET" && leaderboardMatch[2] === "scores") {
				const offset = Number(url.searchParams.get("offset") ?? 0);
				const limit = Number(url.searchParams.get("limit") ?? 20);
				if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
					throw new EmulatorHttpError(400, "invalid_paging", "Leaderboard offset/limit is invalid.");
				}
				const entries = ranked();
				return this._mutate(() => {
					this._audit("leaderboards", "list-scores", playerId, { leaderboardId, offset, limit });
					return { leaderboardId, offset, limit, total: entries.length, entries: entries.slice(offset, offset + limit) };
				});
			}
			if (method === "POST" && leaderboardMatch[2] === "score") {
				const body = await readBody(request);
				if (typeof body.score !== "number" || !Number.isFinite(body.score) || Math.abs(body.score) > Number.MAX_SAFE_INTEGER) {
					throw new EmulatorHttpError(400, "invalid_score", "Leaderboard score must be a finite safe-range number.");
				}
				const metadata = jsonValue(body.metadata ?? null, "leaderboard metadata");
				return this._mutate(() => {
					const board = (this._state.leaderboardScores[leaderboardId] ??= {});
					const current = board[playerId];
					const improves = !current || !definition.keepBest || (definition.sortOrder === "descending" ? body.score > current.score : body.score < current.score);
					if (improves) {
						board[playerId] = { playerId, score: body.score, metadata, updatedAt: new Date().toISOString() };
					}
					const submitted = board[playerId] ?? current!;
					const entries = ranked();
					const retained = new Set(entries.map((entry) => entry.playerId));
					for (const id of Object.keys(board)) {
						if (!retained.has(id)) {
							delete board[id];
						}
					}
					const result = entries.find((entry) => entry.playerId === playerId) ?? { ...submitted, rank: definition.maxEntries + 1 };
					this._audit("leaderboards", "submit-score", playerId, { leaderboardId, score: body.score, retained: retained.has(playerId) });
					return result;
				});
			}
		}
		if (path === "/v1/remote-config" && method === "GET") {
			const playerId = this._player(request);
			const keys =
				url.searchParams
					.get("keys")
					?.split(",")
					.filter(Boolean)
					.map((key) => assertIdentifier(key, "Remote Config key")) ?? [];
			if (keys.length > 100 || new Set(keys).size !== keys.length) {
				throw new EmulatorHttpError(400, "invalid_keys", "Remote Config accepts at most 100 unique keys.");
			}
			const selected = this._environment.resources.remoteConfig.filter((entry) => !keys.length || keys.includes(entry.key));
			const values = Object.fromEntries(selected.map((entry) => [entry.key, entry.value]));
			const revision = createHash("sha256").update(JSON.stringify(this._environment.resources.remoteConfig)).digest("hex");
			return this._mutate(() => {
				this._audit("remoteConfig", "fetch", playerId, { keyCount: selected.length });
				return { revision, values };
			});
		}
		const contentMatch = path.match(/^\/v1\/content-delivery\/([^/]+)\/([^/]+)$/);
		if (contentMatch && method === "GET") {
			const bucketId = assertIdentifier(decodeURIComponent(contentMatch[1]), "bucketId");
			const badgeId = assertIdentifier(decodeURIComponent(contentMatch[2]), "badge");
			const bucket = this._environment.resources.contentDeliveryBuckets.find((entry) => entry.id === bucketId);
			const badge = bucket?.badges.find((entry) => entry.id === badgeId);
			const release = badge ? bucket?.releases.find((entry) => entry.id === badge.releaseId) : null;
			if (!bucket || !badge || !release) {
				throw new EmulatorHttpError(404, "content_release_not_found", `Unknown content bucket/badge: ${bucketId}/${badgeId}.`);
			}
			return this._mutate(() => {
				this._audit("contentDelivery", "get-manifest", null, { bucketId, badge: badgeId, entryCount: release.entries.length });
				return { bucketId, badge: badgeId, releaseId: release.id, entries: release.entries };
			});
		}
		const functionMatch = path.match(/^\/v1\/cloud-functions\/([^/]+)$/);
		if (functionMatch && method === "POST") {
			const functionId = assertIdentifier(decodeURIComponent(functionMatch[1]), "functionId");
			const definition = this._environment.resources.cloudFunctions.find((entry) => entry.id === functionId);
			if (!definition) {
				throw new EmulatorHttpError(404, "function_not_found", `Unknown Cloud Function: ${functionId}.`);
			}
			const playerId = definition.authenticated ? this._player(request) : null;
			const body = await readBody(request);
			jsonValue(body.payload ?? null, "Cloud Function payload");
			const idempotencyKey = request.headers["x-idempotency-key"];
			if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))) {
				throw new EmulatorHttpError(400, "invalid_idempotency_key", "X-Idempotency-Key must contain 8–128 URL-safe characters.");
			}
			return this._mutate(() => {
				const existing = idempotencyKey
					? this._state.functionExecutions.find((entry) => entry.functionId === functionId && entry.playerId === playerId && entry.idempotencyKey === idempotencyKey)
					: null;
				if (existing) {
					return { functionId, executionId: existing.id, result: existing.result };
				}
				const execution: IEmulatorFunctionExecution = {
					id: randomUUID(),
					functionId,
					playerId,
					idempotencyKey: typeof idempotencyKey === "string" ? idempotencyKey : null,
					result: definition.emulatorResponse,
					executedAt: new Date().toISOString(),
				};
				this._state.functionExecutions.push(execution);
				this._state.functionExecutions.splice(0, Math.max(0, this._state.functionExecutions.length - maximumTransactionEntries));
				this._audit("cloudFunctions", "invoke", playerId, { functionId });
				return { functionId, executionId: execution.id, result: execution.result };
			});
		}
		throw new EmulatorHttpError(404, "route_not_found", `No local project service route handles ${method} ${path}.`);
	}
}

const emulators = new WeakMap<Scene, ProjectServicesEmulator>();

function selectedEnvironment(scene: Scene, environmentId?: unknown): { revision: number; environment: IProjectServiceEnvironment } {
	const configuration = getProjectServicesConfiguration(scene, {});
	const id = environmentId ?? configuration.activeEnvironmentId;
	const environment = configuration.environments.find((entry) => entry.id === id);
	if (!environment) {
		throw new Error(`Unknown project service environment: ${String(id)}.`);
	}
	return { revision: configuration.revision, environment };
}

export async function startProjectServicesEmulator(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (emulators.has(scene)) {
		throw new Error("The project services emulator is already running for this scene.");
	}
	const selected = selectedEnvironment(scene, data?.environmentId);
	if (!Number.isSafeInteger(data?.expectedRevision) || data.expectedRevision !== selected.revision) {
		throw new Error(`expectedRevision must equal current project services revision ${selected.revision}.`);
	}
	const port = data.port ?? 0;
	if (!Number.isSafeInteger(port) || (port !== 0 && (port < 1024 || port > 65535))) {
		throw new Error("Project services emulator port must be 0 for automatic selection or an integer from 1024 through 65535.");
	}
	const context = await getProjectPackageContext(options);
	const directory = await ensureProjectStoreDirectory(context.projectRoot, ".zvibe", "services", "emulator");
	const statePath = join(directory, `${selected.environment.id}.json`);
	const emulator = new ProjectServicesEmulator(selected.environment, await loadState(statePath, selected.environment.id), statePath);
	try {
		await emulator.start(port);
		emulators.set(scene, emulator);
		return emulator.status();
	} catch (error) {
		await emulator.stop().catch(() => undefined);
		throw error;
	}
}

export async function stopProjectServicesEmulator(scene: Scene): Promise<any> {
	const emulator = emulators.get(scene);
	if (!emulator) {
		return { stopped: false, reason: "The project services emulator is not running." };
	}
	const status = emulator.status();
	await emulator.stop();
	emulators.delete(scene);
	return { stopped: true, environmentId: status.environmentId, port: status.port };
}

export function getProjectServicesEmulatorStatus(scene: Scene): any {
	return emulators.get(scene)?.status() ?? { running: false };
}

export function getProjectServicesEmulatorEvents(scene: Scene, data: any): any {
	const emulator = emulators.get(scene);
	if (!emulator) {
		throw new Error("Start the project services emulator before inspecting its events.");
	}
	return emulator.events(data);
}

export async function resetProjectServicesEmulator(scene: Scene, data: any): Promise<any> {
	if (data?.confirm !== true) {
		throw new Error("Resetting project services emulator data requires confirm=true.");
	}
	const emulator = emulators.get(scene);
	if (!emulator) {
		throw new Error("Start the project services emulator before resetting its data.");
	}
	await emulator.reset();
	return { reset: true, status: emulator.status() };
}
