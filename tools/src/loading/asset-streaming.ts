export const assetStreamingSettingsVersion = 1 as const;
export const assetStreamingRuntimeBackend = "zvibe-portable-async-asset-streaming-v1" as const;

export const assetStreamingPriorities = ["critical", "high", "normal", "low", "background"] as const;

export type AssetStreamingPriority = (typeof assetStreamingPriorities)[number];
export type AssetStreamingHost = "darwin" | "linux" | "win32" | "unknown";
export type AssetStreamingEventState = "queued" | "started" | "completed" | "cancelled" | "timed-out" | "failed";

export interface IWindowsAssetStreamingSettings {
	enableDirectStorage: boolean;
	maximumConcurrentReads: number;
	maximumQueuedRequests: number;
	requestTimeoutMs: number;
	chunkSizeBytes: number;
	maximumAssetBytes: number;
}

export interface IAssetStreamingSettings {
	version: typeof assetStreamingSettingsVersion;
	windows: IWindowsAssetStreamingSettings;
}

export interface IAssetStreamingBuildPlan {
	model: typeof assetStreamingRuntimeBackend;
	platform: AssetStreamingHost;
	settings: IAssetStreamingSettings;
	requested: boolean;
	enabled: boolean;
	backend: "disabled" | "electron-asynchronous-file-streams";
	directStorage: {
		settingLabel: "Enable Direct Storage";
		nativeAdapterAvailable: false;
		nativeBackendUsed: false;
		portableFallbackUsed: boolean;
	};
	warnings: string[];
	limitations: string[];
}

export interface IAssetStreamingRequest {
	key: string;
	url: string;
	priority?: AssetStreamingPriority;
	expectedSizeBytes?: number;
	signal?: AbortSignal;
}

export interface IAssetStreamingSource {
	stream: ReadableStream<Uint8Array>;
	sizeBytes: number;
	contentType?: string;
	status?: number;
	headers?: Record<string, string>;
}

export interface IAssetStreamingResponse extends Omit<IAssetStreamingSource, "stream"> {
	requestId: string;
	stream: ReadableStream<Uint8Array>;
}

export type AssetStreamingSourceOpener = (request: Readonly<IAssetStreamingRequest>, signal: AbortSignal) => Promise<IAssetStreamingSource>;

export interface IQueuedAssetStreamingRequest {
	requestId: string;
	response: Promise<IAssetStreamingResponse>;
}

export interface IAssetStreamingEvent {
	sequence: number;
	requestId: string;
	key: string;
	url: string;
	priority: AssetStreamingPriority;
	state: AssetStreamingEventState;
	queuedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	bytesRead: number;
	chunkCount: number;
	error: string | null;
}

export interface IAssetStreamingRuntimeSnapshot {
	backend: typeof assetStreamingRuntimeBackend;
	revision: number;
	platform: AssetStreamingHost;
	configured: boolean;
	settings: IAssetStreamingSettings;
	plan: IAssetStreamingBuildPlan;
	queued: Array<Pick<IAssetStreamingEvent, "requestId" | "key" | "url" | "priority" | "queuedAt">>;
	active: Array<Pick<IAssetStreamingEvent, "requestId" | "key" | "url" | "priority" | "queuedAt" | "startedAt" | "bytesRead" | "chunkCount">>;
	events: IAssetStreamingEvent[];
	totals: { queued: number; started: number; completed: number; cancelled: number; timedOut: number; failed: number; bytesRead: number; chunkCount: number };
	limits: { maximumEvents: number };
}

interface IRuntimeEntry {
	requestId: string;
	request: Readonly<IAssetStreamingRequest>;
	priority: AssetStreamingPriority;
	priorityIndex: number;
	order: number;
	queuedAtMs: number;
	startedAtMs: number | null;
	bytesRead: number;
	chunkCount: number;
	opener: AssetStreamingSourceOpener;
	resolve: (response: IAssetStreamingResponse) => void;
	reject: (error: Error) => void;
	settled: boolean;
	terminal: boolean;
	timeout: ReturnType<typeof setTimeout>;
	abortController: AbortController;
	sourceReader: ReadableStreamDefaultReader<Uint8Array> | null;
	streamController: ReadableStreamDefaultController<Uint8Array> | null;
	externalAbortListener: (() => void) | null;
}

const maximumEvents = 256;
const priorityIndex = new Map<AssetStreamingPriority, number>(assetStreamingPriorities.map((priority, index) => [priority, index]));

/** Rejects arrays/null so schema errors stay deterministic before nested normalization. */
function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

/** Keeps persisted and MCP-authored settings closed against silently ignored typos. */
function assertKnownFields(source: Record<string, unknown>, fields: readonly string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !fields.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

/** Applies one inclusive integer bound without lossy coercion from strings or floating-point input. */
function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const normalized = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(normalized) || Number(normalized) < minimum || Number(normalized) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum.toLocaleString()} through ${maximum.toLocaleString()}.`);
	}
	return Number(normalized);
}

/** Strictly normalizes the opt-in Windows policy; upgraded and new projects remain disabled until explicitly enabled. */
export function normalizeAssetStreamingSettings(value: unknown = {}): IAssetStreamingSettings {
	const source = asRecord(value, "Asset streaming settings");
	assertKnownFields(source, ["version", "windows"], "Asset streaming settings");
	if (source.version !== undefined && source.version !== assetStreamingSettingsVersion) {
		throw new Error(`Asset streaming settings version must be ${assetStreamingSettingsVersion}.`);
	}
	const windows = source.windows === undefined ? {} : asRecord(source.windows, "Windows asset streaming settings");
	assertKnownFields(
		windows,
		["enableDirectStorage", "maximumConcurrentReads", "maximumQueuedRequests", "requestTimeoutMs", "chunkSizeBytes", "maximumAssetBytes"],
		"Windows asset streaming settings"
	);
	return {
		version: assetStreamingSettingsVersion,
		windows: {
			enableDirectStorage: windows.enableDirectStorage === true,
			maximumConcurrentReads: boundedInteger(windows.maximumConcurrentReads, 8, 1, 64, "Windows maximumConcurrentReads"),
			maximumQueuedRequests: boundedInteger(windows.maximumQueuedRequests, 4_096, 1, 10_000, "Windows maximumQueuedRequests"),
			requestTimeoutMs: boundedInteger(windows.requestTimeoutMs, 30_000, 1_000, 120_000, "Windows requestTimeoutMs"),
			chunkSizeBytes: boundedInteger(windows.chunkSizeBytes, 256 * 1024, 64 * 1024, 4 * 1024 * 1024, "Windows chunkSizeBytes"),
			maximumAssetBytes: boundedInteger(windows.maximumAssetBytes, 2 * 1024 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024, "Windows maximumAssetBytes"),
		},
	};
}

/** Produces an explicit native-boundary plan instead of presenting portable Electron streams as Microsoft DirectStorage. */
export function getAssetStreamingBuildPlan(value: unknown, platform: AssetStreamingHost): IAssetStreamingBuildPlan {
	const settings = normalizeAssetStreamingSettings(value);
	const requested = settings.windows.enableDirectStorage;
	const enabled = platform === "win32" && requested;
	const warnings: string[] = [];
	if (requested && platform !== "win32") {
		warnings.push("Enable Direct Storage applies only to Windows Electron builds; this target keeps the standard Chromium asset path.");
	}
	if (enabled) {
		warnings.push("The bundled backend uses bounded asynchronous Electron file streams; a verified native Microsoft DirectStorage adapter is not installed.");
	}
	return {
		model: assetStreamingRuntimeBackend,
		platform,
		settings,
		requested,
		enabled,
		backend: enabled ? "electron-asynchronous-file-streams" : "disabled",
		directStorage: {
			settingLabel: "Enable Direct Storage",
			nativeAdapterAvailable: false,
			nativeBackendUsed: false,
			portableFallbackUsed: enabled,
		},
		warnings,
		limitations: [
			"Microsoft DirectStorage, GPU decompression, IO rings, and native Windows binary/API identity require a separately verified host adapter.",
			"The portable backend accelerates project-contained packaged asset reads; remote HTTP assets remain owned by Chromium networking.",
		],
	};
}

/** Rewrites only packaged file URLs below the loaded document root; remote/data/blob URLs and traversal remain untouched. */
export function rewriteAssetUrlForStreaming(url: string, documentUrl: string, plan: IAssetStreamingBuildPlan): string {
	if (!plan.enabled) {
		return url;
	}
	let resolved: URL;
	let document: URL;
	try {
		resolved = new URL(url, documentUrl);
		document = new URL(documentUrl);
	} catch {
		return url;
	}
	if (resolved.protocol !== "file:" || document.protocol !== "file:") {
		return url;
	}
	const root = document.pathname.slice(0, document.pathname.lastIndexOf("/") + 1);
	if (!resolved.pathname.startsWith(root)) {
		return url;
	}
	const relativePath = resolved.pathname.slice(root.length);
	if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
		return url;
	}
	return `zvibe-asset://local/${relativePath}${resolved.search}`;
}

/** Priority-ordered stream scheduler that holds a slot until the consumer finishes, cancels, times out, or fails. */
export class AssetStreamingRuntime {
	private readonly _platform: AssetStreamingHost;
	private readonly _settings: IAssetStreamingSettings;
	private readonly _plan: IAssetStreamingBuildPlan;
	private readonly _queued: IRuntimeEntry[] = [];
	private readonly _active = new Map<string, IRuntimeEntry>();
	private readonly _events: IAssetStreamingEvent[] = [];
	private readonly _totals = { queued: 0, started: 0, completed: 0, cancelled: 0, timedOut: 0, failed: 0, bytesRead: 0, chunkCount: 0 };
	private _revision = 1;
	private _order = 0;
	private _disposed = false;

	public constructor(value: unknown, platform: AssetStreamingHost) {
		this._platform = platform;
		this._settings = normalizeAssetStreamingSettings(value);
		this._plan = getAssetStreamingBuildPlan(this._settings, platform);
	}

	/** Enqueues without hiding the request id so external controllers can cancel queued or active work. */
	public enqueue(request: IAssetStreamingRequest, opener: AssetStreamingSourceOpener): IQueuedAssetStreamingRequest {
		if (this._disposed) {
			throw new Error("Asset streaming runtime is disposed.");
		}
		if (!this._plan.enabled) {
			throw new Error("Asset streaming runtime is disabled for this platform/profile.");
		}
		if (!request.key || request.key.length > 2_048 || !request.url || request.url.length > 8_192) {
			throw new Error("Asset streaming request key/url must be non-empty and within 2,048/8,192 characters.");
		}
		if (request.priority !== undefined && !assetStreamingPriorities.includes(request.priority)) {
			throw new Error(`Asset streaming priority must be one of: ${assetStreamingPriorities.join(", ")}.`);
		}
		if (
			request.expectedSizeBytes !== undefined &&
			(!Number.isSafeInteger(request.expectedSizeBytes) || request.expectedSizeBytes < 0 || request.expectedSizeBytes > this._settings.windows.maximumAssetBytes)
		) {
			throw new Error(`Asset streaming expectedSizeBytes must be between 0 and ${this._settings.windows.maximumAssetBytes.toLocaleString()}.`);
		}
		if (this._queued.length >= this._settings.windows.maximumQueuedRequests) {
			throw new Error(`Asset streaming queue is full at ${this._settings.windows.maximumQueuedRequests.toLocaleString()} waiting requests.`);
		}
		const priority = request.priority ?? "normal";
		const requestId = `asset-stream-${++this._order}`;
		let resolveResponse: (response: IAssetStreamingResponse) => void = () => undefined;
		let rejectResponse: (error: Error) => void = () => undefined;
		const response = new Promise<IAssetStreamingResponse>((resolve, reject) => {
			resolveResponse = resolve;
			rejectResponse = reject;
		});
		const entry: IRuntimeEntry = {
			requestId,
			request: Object.freeze({ ...request, signal: request.signal }),
			priority,
			priorityIndex: priorityIndex.get(priority) ?? 2,
			order: this._order,
			queuedAtMs: Date.now(),
			startedAtMs: null,
			bytesRead: 0,
			chunkCount: 0,
			opener,
			resolve: resolveResponse,
			reject: rejectResponse,
			settled: false,
			terminal: false,
			timeout: setTimeout(
				() => this._abort(entry, "timed-out", `Asset streaming request timed out after ${this._settings.windows.requestTimeoutMs} ms.`),
				this._settings.windows.requestTimeoutMs
			),
			abortController: new AbortController(),
			sourceReader: null,
			streamController: null,
			externalAbortListener: null,
		};
		if (request.signal) {
			entry.externalAbortListener = () => this._abort(entry, "cancelled", "Asset streaming request was cancelled by its caller.");
			request.signal.addEventListener("abort", entry.externalAbortListener, { once: true });
			if (request.signal.aborted) {
				entry.externalAbortListener();
				return { requestId, response };
			}
		}
		this._queued.push(entry);
		this._queued.sort((left, right) => left.priorityIndex - right.priorityIndex || left.order - right.order);
		this._totals.queued++;
		this._record(entry, "queued", null);
		this._pump();
		return { requestId, response };
	}

	/** Cancels exactly one queued or active request and leaves completed evidence intact. */
	public cancel(requestId: string): IAssetStreamingRuntimeSnapshot {
		const entry = this._queued.find((candidate) => candidate.requestId === requestId) ?? this._active.get(requestId);
		if (!entry) {
			throw new Error(`Asset streaming request is not queued or active: ${requestId}`);
		}
		this._abort(entry, "cancelled", "Asset streaming request was cancelled explicitly.");
		return this.snapshot();
	}

	/** Clears completed evidence only when no work is in flight, preserving deterministic request ownership. */
	public reset(): IAssetStreamingRuntimeSnapshot {
		if (this._queued.length || this._active.size) {
			throw new Error("Asset streaming evidence cannot be reset while requests are queued or active.");
		}
		this._events.length = 0;
		Object.assign(this._totals, { queued: 0, started: 0, completed: 0, cancelled: 0, timedOut: 0, failed: 0, bytesRead: 0, chunkCount: 0 });
		this._revision++;
		return this.snapshot();
	}

	/** Returns immutable bounded diagnostics suitable for build UI and external MCP clients. */
	public snapshot(): IAssetStreamingRuntimeSnapshot {
		const entryView = (entry: IRuntimeEntry) => ({
			requestId: entry.requestId,
			key: entry.request.key,
			url: entry.request.url,
			priority: entry.priority,
			queuedAt: new Date(entry.queuedAtMs).toISOString(),
			startedAt: entry.startedAtMs === null ? null : new Date(entry.startedAtMs).toISOString(),
			bytesRead: entry.bytesRead,
			chunkCount: entry.chunkCount,
		});
		return {
			backend: assetStreamingRuntimeBackend,
			revision: this._revision,
			platform: this._platform,
			configured: !this._disposed,
			settings: structuredClone(this._settings),
			plan: structuredClone(this._plan),
			queued: this._queued.map(({ requestId, request, priority, queuedAtMs }) => ({
				requestId,
				key: request.key,
				url: request.url,
				priority,
				queuedAt: new Date(queuedAtMs).toISOString(),
			})),
			active: [...this._active.values()].map(entryView),
			events: structuredClone(this._events),
			totals: { ...this._totals },
			limits: { maximumEvents },
		};
	}

	/** Cancels every owned request and permanently rejects future work. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const entry of [...this._queued, ...this._active.values()]) {
			this._abort(entry, "cancelled", "Asset streaming runtime was disposed.");
		}
		this._revision++;
	}

	/** Starts only enough queued jobs to fill free read slots; each async start reserves its slot before yielding. */
	private _pump(): void {
		while (!this._disposed && this._active.size < this._settings.windows.maximumConcurrentReads && this._queued.length) {
			const entry = this._queued.shift();
			if (entry && !entry.terminal) {
				void this._start(entry);
			}
		}
	}

	/** Opens a source and wraps it so the runtime—not the opener—owns byte accounting and terminal cleanup. */
	private async _start(entry: IRuntimeEntry): Promise<void> {
		entry.startedAtMs = Date.now();
		this._active.set(entry.requestId, entry);
		this._totals.started++;
		this._record(entry, "started", null);
		try {
			const source = await entry.opener(entry.request, entry.abortController.signal);
			if (entry.terminal) {
				await source.stream.cancel("request already terminated").catch(() => undefined);
				return;
			}
			if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0 || source.sizeBytes > this._settings.windows.maximumAssetBytes) {
				throw new Error(`Asset stream size must be between 0 and ${this._settings.windows.maximumAssetBytes.toLocaleString()} bytes.`);
			}
			if (entry.request.expectedSizeBytes !== undefined && source.sizeBytes !== entry.request.expectedSizeBytes) {
				throw new Error(`Asset stream expected ${entry.request.expectedSizeBytes.toLocaleString()} bytes, received ${source.sizeBytes.toLocaleString()}.`);
			}
			entry.sourceReader = source.stream.getReader();
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					entry.streamController = controller;
				},
				pull: async (controller) => {
					if (entry.terminal || !entry.sourceReader) {
						return;
					}
					try {
						const chunk = await entry.sourceReader.read();
						if (chunk.done) {
							if (entry.bytesRead !== source.sizeBytes) {
								throw new Error(`Asset stream declared ${source.sizeBytes.toLocaleString()} bytes but emitted ${entry.bytesRead.toLocaleString()}.`);
							}
							controller.close();
							this._complete(entry, "completed", null);
							return;
						}
						entry.bytesRead += chunk.value.byteLength;
						entry.chunkCount++;
						if (entry.bytesRead > this._settings.windows.maximumAssetBytes || entry.bytesRead > source.sizeBytes) {
							throw new Error("Asset stream emitted more bytes than its declared/bounded size.");
						}
						controller.enqueue(chunk.value);
					} catch (error) {
						const normalized = error instanceof Error ? error : new Error(String(error));
						controller.error(normalized);
						this._complete(entry, "failed", normalized.message);
					}
				},
				cancel: async () => {
					await entry.sourceReader?.cancel("consumer cancelled").catch(() => undefined);
					this._complete(entry, "cancelled", "Asset stream consumer cancelled before completion.");
				},
			});
			entry.settled = true;
			entry.resolve({
				requestId: entry.requestId,
				stream,
				sizeBytes: source.sizeBytes,
				contentType: source.contentType,
				status: source.status,
				headers: source.headers ? { ...source.headers } : undefined,
			});
		} catch (error) {
			if (!entry.terminal) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				this._complete(entry, entry.abortController.signal.aborted ? "cancelled" : "failed", normalized.message);
			}
		}
	}

	/** Propagates cancellation to both the opener and an already-open stream before releasing its slot. */
	private _abort(entry: IRuntimeEntry, state: "cancelled" | "timed-out", message: string): void {
		if (entry.terminal) {
			return;
		}
		entry.abortController.abort(new Error(message));
		void entry.sourceReader?.cancel(message).catch(() => undefined);
		entry.streamController?.error(new Error(message));
		this._complete(entry, state, message);
	}

	/** Performs terminal cleanup exactly once and immediately pumps the next priority-ordered request. */
	private _complete(entry: IRuntimeEntry, state: Exclude<AssetStreamingEventState, "queued" | "started">, error: string | null): void {
		if (entry.terminal) {
			return;
		}
		entry.terminal = true;
		clearTimeout(entry.timeout);
		const queuedIndex = this._queued.indexOf(entry);
		if (queuedIndex !== -1) {
			this._queued.splice(queuedIndex, 1);
		}
		this._active.delete(entry.requestId);
		if (entry.externalAbortListener && entry.request.signal) {
			entry.request.signal.removeEventListener("abort", entry.externalAbortListener);
		}
		if (!entry.settled) {
			entry.settled = true;
			entry.reject(new Error(error ?? `Asset streaming request ${state}.`));
		}
		this._totals.bytesRead += entry.bytesRead;
		this._totals.chunkCount += entry.chunkCount;
		if (state === "completed") {
			this._totals.completed++;
		}
		if (state === "cancelled") {
			this._totals.cancelled++;
		}
		if (state === "timed-out") {
			this._totals.timedOut++;
		}
		if (state === "failed") {
			this._totals.failed++;
		}
		this._record(entry, state, error);
		this._pump();
	}

	/** Retains only the newest bounded diagnostics while monotonic totals remain available for long sessions. */
	private _record(entry: IRuntimeEntry, state: AssetStreamingEventState, error: string | null): void {
		const completedAtMs = ["completed", "cancelled", "timed-out", "failed"].includes(state) ? Date.now() : null;
		this._events.push({
			sequence: this._revision,
			requestId: entry.requestId,
			key: entry.request.key,
			url: entry.request.url,
			priority: entry.priority,
			state,
			queuedAt: new Date(entry.queuedAtMs).toISOString(),
			startedAt: entry.startedAtMs === null ? null : new Date(entry.startedAtMs).toISOString(),
			completedAt: completedAtMs === null ? null : new Date(completedAtMs).toISOString(),
			durationMs: completedAtMs === null ? null : completedAtMs - (entry.startedAtMs ?? entry.queuedAtMs),
			bytesRead: entry.bytesRead,
			chunkCount: entry.chunkCount,
			error,
		});
		this._events.splice(0, Math.max(0, this._events.length - maximumEvents));
		this._revision++;
	}
}
