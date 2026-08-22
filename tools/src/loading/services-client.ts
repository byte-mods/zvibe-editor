import { IProjectServiceSettings, IProjectServicesConfiguration, ProjectServiceCategory, normalizeProjectServicesConfiguration } from "./services";

export type ProjectServiceScalar = string | number | boolean | null;
export type ProjectServiceJson = ProjectServiceScalar | ProjectServiceJson[] | { [key: string]: ProjectServiceJson };

export interface IProjectServiceSession {
	playerId: string;
	profile: string;
	expiresAt: string;
}

export interface IProjectCloudSaveItem {
	key: string;
	value: ProjectServiceJson;
	revision: number;
	updatedAt: string;
}

export interface IProjectAnalyticsEvent {
	name: string;
	parameters?: Record<string, ProjectServiceScalar>;
	timestamp?: string;
	eventId?: string;
}

export interface IProjectIapProduct {
	id: string;
	type: "consumable" | "non-consumable" | "subscription";
	title: string;
	description: string;
	currency: string;
	priceMicros: number;
}

export interface IProjectAdPlacement {
	id: string;
	type: "rewarded" | "interstitial" | "banner";
	reward?: { id: string; quantity: number };
}

export interface IProjectMatchTicket {
	id: string;
	queue: string;
	status: "searching" | "matched" | "canceled" | "timed-out";
	createdAt: string;
	match?: { id: string; playerIds: string[]; assignment: ProjectServiceJson | null };
}

export interface IProjectLeaderboardEntry {
	playerId: string;
	score: number;
	rank: number;
	metadata: ProjectServiceJson;
	updatedAt: string;
}

export interface IProjectLeaderboardPage {
	leaderboardId: string;
	offset: number;
	limit: number;
	total: number;
	entries: IProjectLeaderboardEntry[];
}

export interface IProjectRemoteConfigResult {
	revision: string;
	values: Record<string, ProjectServiceJson>;
}

export interface IProjectContentDeliveryEntry {
	key: string;
	url: string;
	sha256: string;
	bytes: number;
	contentType: string;
}

export interface IProjectContentDeliveryManifest {
	bucketId: string;
	badge: string;
	releaseId: string;
	entries: IProjectContentDeliveryEntry[];
}

export interface IProjectCloudFunctionResult {
	functionId: string;
	executionId: string;
	result: ProjectServiceJson;
}

export interface IProjectServicesClientOptions {
	fetch?: typeof fetch;
	timeoutMs?: number;
	maximumResponseBytes?: number;
}

export class ProjectServiceError extends Error {
	public constructor(
		message: string,
		public readonly category: ProjectServiceCategory,
		public readonly status: number | null,
		public readonly code: string
	) {
		super(message);
		this.name = "ProjectServiceError";
	}
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const eventNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const maximumRequestBytes = 1024 * 1024;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return result;
}

function validateIdentifier(value: string, label: string): string {
	if (!identifierPattern.test(value)) {
		throw new Error(`${label} must be 1–128 characters using letters, numbers, dot, colon, underscore, or hyphen.`);
	}
	return value;
}

function serializedBody(value: unknown): string {
	const result = JSON.stringify(value);
	if (result === undefined || new TextEncoder().encode(result).byteLength > maximumRequestBytes) {
		throw new Error(`Project service request bodies must serialize to at most ${maximumRequestBytes} bytes.`);
	}
	return result;
}

function endpointUrl(settings: IProjectServiceSettings, path: string): URL {
	if (!settings.endpoint) {
		throw new Error("The enabled service does not define a generic REST endpoint.");
	}
	let endpoint: URL;
	try {
		endpoint = new URL(settings.endpoint.endsWith("/") ? settings.endpoint : `${settings.endpoint}/`);
	} catch {
		throw new Error("The enabled service endpoint must be an absolute HTTP(S) URL.");
	}
	const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
	if (
		!["http:", "https:"].includes(endpoint.protocol) ||
		(endpoint.protocol === "http:" && !loopback) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	) {
		throw new Error("The enabled service endpoint must use HTTPS, or loopback HTTP, without credentials, query parameters, or a fragment.");
	}
	return new URL(path.replace(/^\//, ""), endpoint);
}

/**
 * Portable REST client shared by exported Web and desktop games. Provider SDKs can coexist with this client;
 * only services carrying a generic endpoint are routed here, and authentication material stays in memory.
 */
export class ProjectServicesClient {
	private readonly _configuration: IProjectServicesConfiguration;
	private readonly _fetch: typeof fetch;
	private readonly _timeoutMs: number;
	private readonly _maximumResponseBytes: number;
	private _accessToken: string | null = null;
	private _session: IProjectServiceSession | null = null;

	public constructor(configuration: unknown, options: IProjectServicesClientOptions = {}) {
		this._configuration = normalizeProjectServicesConfiguration(configuration);
		const fetchImplementation = options.fetch ?? globalThis.fetch;
		if (typeof fetchImplementation !== "function") {
			throw new Error("Project services require a Fetch API implementation.");
		}
		this._fetch = fetchImplementation.bind(globalThis);
		this._timeoutMs = boundedInteger(options.timeoutMs, 15_000, 100, 120_000, "timeoutMs");
		this._maximumResponseBytes = boundedInteger(options.maximumResponseBytes, 4 * 1024 * 1024, 1024, 16 * 1024 * 1024, "maximumResponseBytes");
	}

	public get configuration(): IProjectServicesConfiguration {
		return normalizeProjectServicesConfiguration(this._configuration);
	}

	public get session(): IProjectServiceSession | null {
		return this._session ? { ...this._session } : null;
	}

	public isEnabled(category: ProjectServiceCategory): boolean {
		return this._configuration[category].enabled;
	}

	/** Restores a provider-issued session without persisting its bearer token in project or scene metadata. */
	public adoptSession(session: IProjectServiceSession, accessToken: string): void {
		const expiry = Date.parse(session.expiresAt);
		if (
			!identifierPattern.test(session.playerId) ||
			typeof session.profile !== "string" ||
			!/^[A-Za-z0-9_-]{1,64}$/.test(session.profile) ||
			!Number.isFinite(expiry) ||
			expiry <= Date.now()
		) {
			throw new Error("The project service session is malformed.");
		}
		if (typeof accessToken !== "string" || accessToken.length < 16 || accessToken.length > 4096 || /\s/.test(accessToken)) {
			throw new Error("The project service access token must contain 16–4096 non-whitespace characters.");
		}
		this._session = { playerId: session.playerId, profile: session.profile, expiresAt: session.expiresAt };
		this._accessToken = accessToken;
	}

	public signOut(): void {
		this._accessToken = null;
		this._session = null;
	}

	public async signInAnonymously(profile = "default"): Promise<IProjectServiceSession> {
		if (typeof profile !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
			throw new Error("Anonymous profile must contain 1–64 letters, numbers, underscores, or hyphens.");
		}
		return this._signIn("v1/auth/anonymous", { profile });
	}

	public async signInWithCustomIdentity(externalId: string, credential: string): Promise<IProjectServiceSession> {
		validateIdentifier(externalId, "externalId");
		if (typeof credential !== "string" || credential.length < 1 || credential.length > 4096) {
			throw new Error("Custom identity credential must contain 1–4096 characters.");
		}
		return this._signIn("v1/auth/custom", { externalId, credential });
	}

	public async readCloudSave(keys: string[] = []): Promise<IProjectCloudSaveItem[]> {
		const validated = keys.map((key) => validateIdentifier(key, "Cloud Save key"));
		if (validated.length > 100 || new Set(validated).size !== validated.length) {
			throw new Error("Cloud Save reads accept at most 100 unique keys.");
		}
		const query = validated.length ? `?keys=${encodeURIComponent(validated.join(","))}` : "";
		const result = await this._request<{ items: IProjectCloudSaveItem[] }>("cloudSave", `v1/cloud-save${query}`, { method: "GET" }, true);
		return result.items;
	}

	public async writeCloudSave(items: Array<{ key: string; value: ProjectServiceJson; expectedRevision?: number }>): Promise<IProjectCloudSaveItem[]> {
		if (!items.length || items.length > 100) {
			throw new Error("Cloud Save writes require 1–100 items.");
		}
		const normalized = items.map((item) => ({
			key: validateIdentifier(item.key, "Cloud Save key"),
			value: item.value,
			...(item.expectedRevision === undefined ? {} : { expectedRevision: boundedInteger(item.expectedRevision, 0, 0, Number.MAX_SAFE_INTEGER, "expectedRevision") }),
		}));
		if (new Set(normalized.map((item) => item.key)).size !== normalized.length) {
			throw new Error("Cloud Save writes cannot contain duplicate keys.");
		}
		const result = await this._request<{ items: IProjectCloudSaveItem[] }>("cloudSave", "v1/cloud-save", { method: "PUT", body: serializedBody({ items: normalized }) }, true);
		return result.items;
	}

	public async deleteCloudSave(items: Array<{ key: string; expectedRevision?: number }>): Promise<{ deleted: string[] }> {
		if (!items.length || items.length > 100) {
			throw new Error("Cloud Save deletes require 1–100 items.");
		}
		const normalized = items.map((item) => ({
			key: validateIdentifier(item.key, "Cloud Save key"),
			...(item.expectedRevision === undefined ? {} : { expectedRevision: boundedInteger(item.expectedRevision, 0, 0, Number.MAX_SAFE_INTEGER, "expectedRevision") }),
		}));
		if (new Set(normalized.map((item) => item.key)).size !== normalized.length) {
			throw new Error("Cloud Save deletes cannot contain duplicate keys.");
		}
		return this._request("cloudSave", "v1/cloud-save", { method: "DELETE", body: serializedBody({ items: normalized }) }, true);
	}

	public async recordAnalyticsEvents(events: IProjectAnalyticsEvent[]): Promise<{ accepted: number; rejected: number }> {
		if (!events.length || events.length > 100) {
			throw new Error("Analytics batches require 1–100 events.");
		}
		for (const event of events) {
			if (!eventNamePattern.test(event.name)) {
				throw new Error("Analytics event names must start with a letter and contain at most 64 alphanumeric or underscore characters.");
			}
			if (event.parameters && (Object.keys(event.parameters).length > 100 || Object.keys(event.parameters).some((name) => !eventNamePattern.test(name)))) {
				throw new Error("Analytics event parameters require at most 100 valid names.");
			}
			if (
				event.parameters &&
				Object.values(event.parameters).some(
					(value) =>
						value !== null && typeof value !== "boolean" && (typeof value !== "number" || !Number.isFinite(value)) && (typeof value !== "string" || value.length > 1024)
				)
			) {
				throw new Error("Analytics parameters must be finite scalar values and strings may contain at most 1024 characters.");
			}
			if (event.timestamp !== undefined && (!Number.isFinite(Date.parse(event.timestamp)) || event.timestamp.length > 64)) {
				throw new Error("Analytics timestamps must be bounded ISO-compatible dates.");
			}
			if (event.eventId !== undefined) {
				validateIdentifier(event.eventId, "Analytics eventId");
			}
		}
		return this._request("analytics", "v1/analytics/events", { method: "POST", body: serializedBody({ events }) }, true);
	}

	public async listIapProducts(): Promise<IProjectIapProduct[]> {
		const result = await this._request<{ products: IProjectIapProduct[] }>("iap", "v1/iap/products", { method: "GET" }, false);
		return result.products;
	}

	public async purchaseProduct(productId: string, idempotencyKey: string): Promise<ProjectServiceJson> {
		validateIdentifier(productId, "productId");
		if (!/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
			throw new Error("idempotencyKey must contain 8–128 URL-safe characters.");
		}
		return this._request("iap", "v1/iap/purchases", { method: "POST", body: serializedBody({ productId }), headers: { "X-Idempotency-Key": idempotencyKey } }, true);
	}

	public async restorePurchases(): Promise<ProjectServiceJson> {
		return this._request("iap", "v1/iap/purchases", { method: "GET" }, true);
	}

	public async listAdPlacements(): Promise<IProjectAdPlacement[]> {
		const result = await this._request<{ placements: IProjectAdPlacement[] }>("ads", "v1/ads/placements", { method: "GET" }, false);
		return result.placements;
	}

	public async showAd(placementId: string): Promise<ProjectServiceJson> {
		validateIdentifier(placementId, "placementId");
		return this._request("ads", `v1/ads/placements/${encodeURIComponent(placementId)}/show`, { method: "POST" }, true);
	}

	public async createMatchTicket(queue: string, customData: ProjectServiceJson = null, idempotencyKey?: string): Promise<IProjectMatchTicket> {
		validateIdentifier(queue, "queue");
		if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
			throw new Error("idempotencyKey must contain 8–128 URL-safe characters.");
		}
		return this._request(
			"matchmaking",
			"v1/matchmaking/tickets",
			{ method: "POST", body: serializedBody({ queue, customData }), ...(idempotencyKey ? { headers: { "X-Idempotency-Key": idempotencyKey } } : {}) },
			true
		);
	}

	public async getMatchTicket(ticketId: string): Promise<IProjectMatchTicket> {
		validateIdentifier(ticketId, "ticketId");
		return this._request("matchmaking", `v1/matchmaking/tickets/${encodeURIComponent(ticketId)}`, { method: "GET" }, true);
	}

	public async cancelMatchTicket(ticketId: string): Promise<IProjectMatchTicket> {
		validateIdentifier(ticketId, "ticketId");
		return this._request("matchmaking", `v1/matchmaking/tickets/${encodeURIComponent(ticketId)}`, { method: "DELETE" }, true);
	}

	public async getLeaderboardScores(leaderboardId: string, offset = 0, limit = 20): Promise<IProjectLeaderboardPage> {
		validateIdentifier(leaderboardId, "leaderboardId");
		const validatedOffset = boundedInteger(offset, 0, 0, 1_000_000, "offset");
		const validatedLimit = boundedInteger(limit, 20, 1, 100, "limit");
		return this._request(
			"leaderboards",
			`v1/leaderboards/${encodeURIComponent(leaderboardId)}/scores?offset=${validatedOffset}&limit=${validatedLimit}`,
			{ method: "GET" },
			true
		);
	}

	public async submitLeaderboardScore(leaderboardId: string, score: number, metadata: ProjectServiceJson = null): Promise<IProjectLeaderboardEntry> {
		validateIdentifier(leaderboardId, "leaderboardId");
		if (typeof score !== "number" || !Number.isFinite(score) || Math.abs(score) > Number.MAX_SAFE_INTEGER) {
			throw new Error("Leaderboard score must be a finite safe-range number.");
		}
		return this._request("leaderboards", `v1/leaderboards/${encodeURIComponent(leaderboardId)}/score`, { method: "POST", body: serializedBody({ score, metadata }) }, true);
	}

	public async fetchRemoteConfig(keys: string[] = []): Promise<IProjectRemoteConfigResult> {
		const validated = keys.map((key) => validateIdentifier(key, "Remote Config key"));
		if (validated.length > 100 || new Set(validated).size !== validated.length) {
			throw new Error("Remote Config reads accept at most 100 unique keys.");
		}
		const query = validated.length ? `?keys=${encodeURIComponent(validated.join(","))}` : "";
		return this._request("remoteConfig", `v1/remote-config${query}`, { method: "GET" }, true);
	}

	public async getContentDeliveryManifest(bucketId: string, badge = "latest"): Promise<IProjectContentDeliveryManifest> {
		validateIdentifier(bucketId, "bucketId");
		validateIdentifier(badge, "badge");
		return this._request("contentDelivery", `v1/content-delivery/${encodeURIComponent(bucketId)}/${encodeURIComponent(badge)}`, { method: "GET" }, false);
	}

	public async callCloudFunction(functionId: string, payload: ProjectServiceJson = null, idempotencyKey?: string): Promise<IProjectCloudFunctionResult> {
		validateIdentifier(functionId, "functionId");
		if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
			throw new Error("idempotencyKey must contain 8–128 URL-safe characters.");
		}
		return this._request(
			"cloudFunctions",
			`v1/cloud-functions/${encodeURIComponent(functionId)}`,
			{
				method: "POST",
				body: serializedBody({ payload }),
				...(idempotencyKey ? { headers: { "X-Idempotency-Key": idempotencyKey } } : {}),
			},
			true
		);
	}

	private async _signIn(path: string, body: Record<string, string>): Promise<IProjectServiceSession> {
		const result = await this._request<IProjectServiceSession & { accessToken: string }>("auth", path, { method: "POST", body: serializedBody(body) }, false);
		this.adoptSession(result, result.accessToken);
		return this.session!;
	}

	/** Executes one bounded request and converts transport/provider failures into a stable category-aware error. */
	private async _request<T>(category: ProjectServiceCategory, path: string, init: RequestInit, authenticated: boolean): Promise<T> {
		const service = this._configuration[category];
		if (!service.enabled) {
			throw new ProjectServiceError(`${category} is disabled for environment ${this._configuration.environment}.`, category, null, "service_disabled");
		}
		if (authenticated && !this._accessToken) {
			throw new ProjectServiceError(`Authenticate before calling ${category}.`, category, null, "authentication_required");
		}
		let url: URL;
		try {
			url = endpointUrl(service, path);
		} catch (error) {
			throw new ProjectServiceError(error instanceof Error ? error.message : String(error), category, null, "invalid_endpoint");
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeoutMs);
		try {
			const response = await this._fetch(url, {
				...init,
				signal: controller.signal,
				headers: {
					Accept: "application/json",
					...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
					"X-Zvibe-Environment": this._configuration.environment,
					...(authenticated && this._accessToken ? { Authorization: `Bearer ${this._accessToken}` } : {}),
					...(init.headers ?? {}),
				},
			});
			const declaredLength = Number(response.headers.get("content-length"));
			if (Number.isFinite(declaredLength) && declaredLength > this._maximumResponseBytes) {
				throw new ProjectServiceError("Project service response exceeded the configured byte limit.", category, response.status, "response_too_large");
			}
			const text = await response.text();
			if (new TextEncoder().encode(text).byteLength > this._maximumResponseBytes) {
				throw new ProjectServiceError("Project service response exceeded the configured byte limit.", category, response.status, "response_too_large");
			}
			let payload: any = {};
			if (text) {
				try {
					payload = JSON.parse(text);
				} catch {
					throw new ProjectServiceError("Project service returned malformed JSON.", category, response.status, "malformed_response");
				}
			}
			if (!response.ok) {
				const message = typeof payload?.error === "string" ? payload.error.slice(0, 1024) : `Project service request failed with HTTP ${response.status}.`;
				const code = typeof payload?.code === "string" && identifierPattern.test(payload.code) ? payload.code : "provider_error";
				throw new ProjectServiceError(message, category, response.status, code);
			}
			return payload as T;
		} catch (error) {
			if (error instanceof ProjectServiceError) {
				throw error;
			}
			const timedOut = controller.signal.aborted;
			throw new ProjectServiceError(
				timedOut ? "Project service request timed out." : "Project service request could not reach its provider.",
				category,
				null,
				timedOut ? "timeout" : "network_error"
			);
		} finally {
			clearTimeout(timer);
		}
	}
}
