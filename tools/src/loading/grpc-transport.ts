import { Scene } from "@babylonjs/core/scene";

export const grpcTransportMetadataKey = "babylonEditorGrpcTransport";
export const grpcTransportVersion = 1 as const;
export const grpcTransportRuntimeBackend = "fetch-grpc-web-connect-v1";
export const grpcTransportProtocols = ["grpc-web-binary", "grpc-web-text", "connect"] as const;

export type GrpcTransportProtocol = (typeof grpcTransportProtocols)[number];

export interface IGrpcTransportConfiguration {
	version: typeof grpcTransportVersion;
	revision: number;
	enabled: boolean;
	endpoint: string;
	protocol: GrpcTransportProtocol;
	defaultTimeoutMs: number;
	maximumSendMessageBytes: number;
	maximumReceiveMessageBytes: number;
	credentials: RequestCredentials;
	defaultMetadata: Record<string, string>;
}

export interface IGrpcTransportRequest {
	service: string;
	method: string;
	payloadBase64: string;
	metadata?: Record<string, string>;
	timeoutMs?: number;
}

export interface IGrpcTransportResponse {
	protocol: GrpcTransportProtocol;
	httpStatus: number;
	grpcStatus: number;
	grpcMessage: string;
	messagesBase64: string[];
	headers: Record<string, string>;
	trailers: Record<string, string>;
	durationMs: number;
	requestBytes: number;
	responseBytes: number;
}

export interface IGrpcCallEvidence {
	sequence: number;
	service: string;
	method: string;
	kind: "unary" | "server-streaming";
	protocol: GrpcTransportProtocol;
	httpStatus: number | null;
	grpcStatus: number | null;
	requestBytes: number;
	responseBytes: number;
	messageCount: number;
	durationMs: number;
	succeeded: boolean;
	error: string | null;
}

export interface IGrpcTransportRuntimeEvidence {
	backend: typeof grpcTransportRuntimeBackend;
	configured: boolean;
	configurationRevision: number | null;
	enabled: boolean;
	activeCalls: number;
	calls: IGrpcCallEvidence[];
}

interface IParsedEnvelope {
	flag: number;
	payload: Uint8Array;
}

const maximumCalls = 32;
const maximumMessagesPerCall = 256;
const servicePattern = /^[A-Za-z_][A-Za-z0-9_.]{0,254}$/;
const methodPattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const metadataNamePattern = /^[0-9a-z][0-9a-z_.-]{0,126}$/;
const forbiddenPersistedMetadata = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie"]);
const redactedResponseMetadata = new Set(["authorization", "cookie", "proxy-authenticate", "proxy-authorization", "set-cookie"]);
const maximumResponseMetadataEntries = 64;
const maximumResponseMetadataValueLength = 8192;

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function assertKnown(source: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
	const result = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(result) || Number(result) < minimum || Number(result) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return Number(result);
}

function normalizeEndpoint(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 2048) {
		throw new Error("gRPC endpoint must be a non-empty URL no longer than 2048 characters.");
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error("gRPC endpoint must be an absolute http(s) URL.");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
		throw new Error("gRPC endpoint must be an absolute http(s) URL without credentials, query, or fragment.");
	}
	if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
		throw new Error("Plain HTTP gRPC endpoints are restricted to loopback; use HTTPS for remote services.");
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

function normalizeMetadata(value: unknown, persisted: boolean): Record<string, string> {
	if (value === undefined) {
		return {};
	}
	const source = record(value, "gRPC metadata");
	if (Object.keys(source).length > 32) {
		throw new Error("gRPC metadata supports at most 32 entries.");
	}
	const result: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(source)) {
		const name = rawName.toLowerCase();
		if (!metadataNamePattern.test(name) || name.startsWith("grpc-") || name.startsWith(":")) {
			throw new Error(`gRPC metadata name is invalid or reserved: ${rawName}`);
		}
		if (persisted && forbiddenPersistedMetadata.has(name)) {
			throw new Error(`${rawName} is secret-bearing metadata and must be supplied transiently per call.`);
		}
		if (typeof rawValue !== "string" || rawValue.length > 8192 || /[\r\n]/.test(rawValue)) {
			throw new Error(`gRPC metadata ${rawName} must be a single-line string no longer than 8192 characters.`);
		}
		result[name] = rawValue;
	}
	return result;
}

export function createDefaultGrpcTransportConfiguration(): IGrpcTransportConfiguration {
	return {
		version: grpcTransportVersion,
		revision: 1,
		enabled: false,
		endpoint: "http://localhost:8080",
		protocol: "grpc-web-binary",
		defaultTimeoutMs: 10_000,
		maximumSendMessageBytes: 4 * 1024 * 1024,
		maximumReceiveMessageBytes: 4 * 1024 * 1024,
		credentials: "same-origin",
		defaultMetadata: {},
	};
}

/** Strictly validates the persisted portable transport without allowing secrets in scene metadata. */
export function validateGrpcTransportConfiguration(value: unknown): IGrpcTransportConfiguration {
	if (value === undefined || value === null) {
		return createDefaultGrpcTransportConfiguration();
	}
	const source = record(value, "gRPC transport configuration");
	assertKnown(
		source,
		["version", "revision", "enabled", "endpoint", "protocol", "defaultTimeoutMs", "maximumSendMessageBytes", "maximumReceiveMessageBytes", "credentials", "defaultMetadata"],
		"gRPC transport configuration"
	);
	if (source.version !== undefined && source.version !== grpcTransportVersion) {
		throw new Error("gRPC transport configuration version must be 1.");
	}
	const defaults = createDefaultGrpcTransportConfiguration();
	if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
		throw new Error("gRPC transport enabled must be Boolean.");
	}
	const protocol = (source.protocol ?? defaults.protocol) as GrpcTransportProtocol;
	if (!grpcTransportProtocols.includes(protocol)) {
		throw new Error("gRPC transport protocol is invalid.");
	}
	const credentials = (source.credentials ?? defaults.credentials) as RequestCredentials;
	if (!["omit", "same-origin", "include"].includes(credentials)) {
		throw new Error("gRPC credentials must be omit, same-origin, or include.");
	}
	return {
		version: grpcTransportVersion,
		revision: boundedInteger(source.revision, defaults.revision, 1, Number.MAX_SAFE_INTEGER, "gRPC transport revision"),
		enabled: source.enabled ?? defaults.enabled,
		endpoint: normalizeEndpoint(source.endpoint ?? defaults.endpoint),
		protocol,
		defaultTimeoutMs: boundedInteger(source.defaultTimeoutMs, defaults.defaultTimeoutMs, 1, 300_000, "gRPC defaultTimeoutMs"),
		maximumSendMessageBytes: boundedInteger(source.maximumSendMessageBytes, defaults.maximumSendMessageBytes, 1, 64 * 1024 * 1024, "gRPC maximumSendMessageBytes"),
		maximumReceiveMessageBytes: boundedInteger(source.maximumReceiveMessageBytes, defaults.maximumReceiveMessageBytes, 1, 64 * 1024 * 1024, "gRPC maximumReceiveMessageBytes"),
		credentials,
		defaultMetadata: normalizeMetadata(source.defaultMetadata, true),
	};
}

function decodeBase64(value: string, label: string): Uint8Array {
	if (value.length > 96 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
		throw new Error(`${label} must be canonical bounded base64.`);
	}
	try {
		const binary = atob(value);
		const result = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index++) {
			result[index] = binary.charCodeAt(index);
		}
		return result;
	} catch {
		throw new Error(`${label} must be valid base64.`);
	}
}

function encodeBase64(value: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < value.length; offset += 0x8000) {
		binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

export function encodeGrpcEnvelope(payload: Uint8Array, flag = 0): Uint8Array {
	if (!Number.isSafeInteger(flag) || flag < 0 || flag > 255 || payload.byteLength > 0xffffffff) {
		throw new Error("gRPC envelope flag or payload length is invalid.");
	}
	const result = new Uint8Array(payload.byteLength + 5);
	result[0] = flag;
	new DataView(result.buffer).setUint32(1, payload.byteLength, false);
	result.set(payload, 5);
	return result;
}

function requestBody(value: Uint8Array): ArrayBuffer {
	return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

export function decodeGrpcEnvelopes(value: Uint8Array, maximumMessageBytes: number): IParsedEnvelope[] {
	const result: IParsedEnvelope[] = [];
	let offset = 0;
	while (offset < value.byteLength) {
		if (value.byteLength - offset < 5) {
			throw new Error("gRPC response ended inside an envelope header.");
		}
		const length = new DataView(value.buffer, value.byteOffset + offset + 1, 4).getUint32(0, false);
		if (length > maximumMessageBytes) {
			throw new Error(`gRPC response message exceeds the ${maximumMessageBytes}-byte receive limit.`);
		}
		if (offset + 5 + length > value.byteLength) {
			throw new Error("gRPC response ended inside an envelope payload.");
		}
		result.push({ flag: value[offset], payload: value.slice(offset + 5, offset + 5 + length) });
		if (result.length > maximumMessagesPerCall + 1) {
			throw new Error(`gRPC response exceeds the ${maximumMessagesPerCall}-message bound.`);
		}
		offset += 5 + length;
	}
	return result;
}

function headerRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (Object.keys(result).length >= maximumResponseMetadataEntries) {
			return;
		}
		const name = key.toLowerCase();
		result[name] = redactedResponseMetadata.has(name) ? "[redacted]" : value.slice(0, maximumResponseMetadataValueLength);
	});
	return result;
}

function parseTrailerBlock(payload: Uint8Array): Record<string, string> {
	const text = new TextDecoder().decode(payload);
	const result: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		if (!line) {
			continue;
		}
		const separator = line.indexOf(":");
		if (separator <= 0) {
			throw new Error("gRPC trailer block contains a malformed header line.");
		}
		const name = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (!metadataNamePattern.test(name) || /[\r\n]/.test(value)) {
			throw new Error("gRPC trailer block contains invalid metadata.");
		}
		if (Object.keys(result).length >= maximumResponseMetadataEntries) {
			throw new Error(`gRPC trailer block exceeds the ${maximumResponseMetadataEntries}-entry bound.`);
		}
		if (value.length > maximumResponseMetadataValueLength) {
			throw new Error(`gRPC trailer ${name} exceeds the ${maximumResponseMetadataValueLength}-character bound.`);
		}
		result[name] = redactedResponseMetadata.has(name) ? "[redacted]" : value;
	}
	return result;
}

function timeoutHeader(milliseconds: number): string {
	return `${Math.max(1, Math.min(99_999_999, Math.ceil(milliseconds)))}m`;
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
	if (!response.body) {
		return new Uint8Array();
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			length += value.byteLength;
			if (length > maximumBytes) {
				await reader.cancel("gRPC aggregate receive limit exceeded.");
				throw new Error(`gRPC response exceeds the ${maximumBytes}-byte aggregate receive limit.`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

function decodeGrpcMessage(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function validateRequest(value: unknown, configuration: IGrpcTransportConfiguration): { request: IGrpcTransportRequest; payload: Uint8Array; timeoutMs: number } {
	const source = record(value, "gRPC request");
	assertKnown(source, ["service", "method", "payloadBase64", "metadata", "timeoutMs"], "gRPC request");
	if (typeof source.service !== "string" || !servicePattern.test(source.service)) {
		throw new Error("gRPC service must be a bounded protobuf service name.");
	}
	if (typeof source.method !== "string" || !methodPattern.test(source.method)) {
		throw new Error("gRPC method must be a bounded protobuf method name.");
	}
	if (typeof source.payloadBase64 !== "string") {
		throw new Error("gRPC payloadBase64 must be a string.");
	}
	const payload = decodeBase64(source.payloadBase64, "gRPC payloadBase64");
	if (payload.byteLength > configuration.maximumSendMessageBytes) {
		throw new Error(`gRPC request exceeds the ${configuration.maximumSendMessageBytes}-byte send limit.`);
	}
	return {
		request: {
			service: source.service,
			method: source.method,
			payloadBase64: source.payloadBase64,
			metadata: normalizeMetadata(source.metadata, false),
			timeoutMs: source.timeoutMs === undefined ? undefined : boundedInteger(source.timeoutMs, configuration.defaultTimeoutMs, 1, 300_000, "gRPC timeoutMs"),
		},
		payload,
		timeoutMs: source.timeoutMs === undefined ? configuration.defaultTimeoutMs : Number(source.timeoutMs),
	};
}

function parseConnectEndStream(payload: Uint8Array): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		throw new Error("Connect end-stream envelope is not valid JSON.");
	}
	const source = record(parsed, "Connect end-stream envelope");
	const metadata = source.metadata === undefined ? {} : normalizeMetadata(source.metadata, false);
	if (source.error !== undefined) {
		const error = record(source.error, "Connect error");
		metadata["connect-error-code"] = typeof error.code === "string" ? error.code : "unknown";
		metadata["connect-error-message"] = typeof error.message === "string" ? error.message : "Connect call failed.";
	}
	return metadata;
}

/** Executes one bounded unary or server-streaming protobuf call through browser-compatible fetch. */
export async function executeGrpcTransportCall(
	configurationValue: unknown,
	requestValue: unknown,
	kind: "unary" | "server-streaming",
	fetchImplementation: typeof fetch = fetch
): Promise<IGrpcTransportResponse> {
	const configuration = validateGrpcTransportConfiguration(configurationValue);
	if (!configuration.enabled) {
		throw new Error("gRPC transport is authored but disabled.");
	}
	const { request, payload, timeoutMs } = validateRequest(requestValue, configuration);
	const path = `${configuration.endpoint}/${request.service}/${request.method}`;
	const metadata = { ...configuration.defaultMetadata, ...(request.metadata ?? {}) };
	const headers = new Headers(metadata);
	let body: BodyInit;
	if (configuration.protocol === "connect") {
		headers.set("content-type", kind === "unary" ? "application/proto" : "application/connect+proto");
		headers.set("connect-protocol-version", "1");
		headers.set("connect-timeout-ms", String(timeoutMs));
		body = requestBody(kind === "unary" ? payload : encodeGrpcEnvelope(payload));
	} else {
		headers.set("content-type", configuration.protocol === "grpc-web-text" ? "application/grpc-web-text+proto" : "application/grpc-web+proto");
		headers.set("x-grpc-web", "1");
		headers.set("grpc-timeout", timeoutHeader(timeoutMs));
		const envelope = encodeGrpcEnvelope(payload);
		body = configuration.protocol === "grpc-web-text" ? encodeBase64(envelope) : requestBody(envelope);
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`gRPC call exceeded its ${timeoutMs}ms deadline.`)), timeoutMs);
	const started = performance.now();
	try {
		const response = await fetchImplementation(path, { method: "POST", headers, body, credentials: configuration.credentials, signal: controller.signal });
		const maximumAggregateBytes = Math.min(128 * 1024 * 1024, configuration.maximumReceiveMessageBytes * maximumMessagesPerCall + 64 * 1024);
		const raw = await readResponseBody(response, maximumAggregateBytes);
		const responseHeaders = headerRecord(response.headers);
		let messages: Uint8Array[] = [];
		let trailers: Record<string, string> = {};
		if (configuration.protocol === "connect" && kind === "unary") {
			if (raw.byteLength > configuration.maximumReceiveMessageBytes) {
				throw new Error(`Connect response exceeds the ${configuration.maximumReceiveMessageBytes}-byte receive limit.`);
			}
			messages = raw.byteLength ? [raw] : [];
		} else {
			const binary = configuration.protocol === "grpc-web-text" ? decodeBase64(new TextDecoder().decode(raw).replace(/\s/g, ""), "gRPC-Web text response") : raw;
			for (const envelope of decodeGrpcEnvelopes(binary, configuration.maximumReceiveMessageBytes)) {
				if (configuration.protocol === "connect" && (envelope.flag & 0x02) !== 0) {
					trailers = { ...trailers, ...parseConnectEndStream(envelope.payload) };
				} else if ((envelope.flag & 0x80) !== 0) {
					trailers = { ...trailers, ...parseTrailerBlock(envelope.payload) };
				} else if ((envelope.flag & 0x01) !== 0) {
					throw new Error("Compressed gRPC messages are not supported by the portable transport.");
				} else {
					messages.push(envelope.payload);
				}
			}
		}
		if (kind === "unary" && messages.length > 1) {
			throw new Error("Unary gRPC response returned more than one message.");
		}
		const rawGrpcStatus = trailers["grpc-status"] ?? responseHeaders["grpc-status"];
		const grpcStatus = rawGrpcStatus === undefined || rawGrpcStatus === "" ? (response.ok ? 0 : 2) : Number(rawGrpcStatus);
		const grpcMessage = decodeGrpcMessage(trailers["grpc-message"] ?? responseHeaders["grpc-message"] ?? "");
		return {
			protocol: configuration.protocol,
			httpStatus: response.status,
			grpcStatus: Number.isSafeInteger(grpcStatus) ? grpcStatus : 2,
			grpcMessage,
			messagesBase64: messages.map(encodeBase64),
			headers: responseHeaders,
			trailers,
			durationMs: Math.round((performance.now() - started) * 1000) / 1000,
			requestBytes: payload.byteLength,
			responseBytes: raw.byteLength,
		};
	} catch (error) {
		if (controller.signal.aborted) {
			throw new Error(`gRPC call exceeded its ${timeoutMs}ms deadline.`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function emptyRuntime(): IGrpcTransportRuntimeEvidence {
	return { backend: grpcTransportRuntimeBackend, configured: false, configurationRevision: null, enabled: false, activeCalls: 0, calls: [] };
}

export function configureGrpcTransport(scene: Scene, value: unknown = scene.metadata?.[grpcTransportMetadataKey]): IGrpcTransportRuntimeEvidence {
	const configuration = validateGrpcTransportConfiguration(value);
	const previous = scene.grpcTransportRuntime;
	return (scene.grpcTransportRuntime = {
		backend: grpcTransportRuntimeBackend,
		configured: true,
		configurationRevision: configuration.revision,
		enabled: configuration.enabled,
		activeCalls: previous?.configurationRevision === configuration.revision ? previous.activeCalls : 0,
		calls: previous?.configurationRevision === configuration.revision ? previous.calls.slice(-maximumCalls) : [],
	});
}

async function invokeSceneCall(scene: Scene, request: unknown, kind: "unary" | "server-streaming"): Promise<IGrpcTransportResponse> {
	const configuration = validateGrpcTransportConfiguration(scene.metadata?.[grpcTransportMetadataKey]);
	const runtime = scene.grpcTransportRuntime?.configurationRevision === configuration.revision ? scene.grpcTransportRuntime : configureGrpcTransport(scene, configuration);
	const source = record(request, "gRPC request");
	const sequence = (runtime.calls.at(-1)?.sequence ?? 0) + 1;
	runtime.activeCalls++;
	try {
		const response = await executeGrpcTransportCall(configuration, request, kind);
		runtime.calls.push({
			sequence,
			service: String(source.service ?? ""),
			method: String(source.method ?? ""),
			kind,
			protocol: configuration.protocol,
			httpStatus: response.httpStatus,
			grpcStatus: response.grpcStatus,
			requestBytes: response.requestBytes,
			responseBytes: response.responseBytes,
			messageCount: response.messagesBase64.length,
			durationMs: response.durationMs,
			succeeded: response.httpStatus >= 200 && response.httpStatus < 300 && response.grpcStatus === 0,
			error: response.grpcStatus === 0 ? null : response.grpcMessage || `gRPC status ${response.grpcStatus}`,
		});
		return response;
	} catch (error) {
		runtime.calls.push({
			sequence,
			service: String(source.service ?? ""),
			method: String(source.method ?? ""),
			kind,
			protocol: configuration.protocol,
			httpStatus: null,
			grpcStatus: null,
			requestBytes: 0,
			responseBytes: 0,
			messageCount: 0,
			durationMs: 0,
			succeeded: false,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	} finally {
		runtime.activeCalls--;
		while (runtime.calls.length > maximumCalls) {
			runtime.calls.shift();
		}
	}
}

export function invokeGrpcUnary(scene: Scene, request: unknown): Promise<IGrpcTransportResponse> {
	return invokeSceneCall(scene, request, "unary");
}

export function invokeGrpcServerStream(scene: Scene, request: unknown): Promise<IGrpcTransportResponse> {
	return invokeSceneCall(scene, request, "server-streaming");
}

export function getGrpcTransportRuntime(scene: Scene): IGrpcTransportRuntimeEvidence {
	return scene.grpcTransportRuntime ?? emptyRuntime();
}

export function getGrpcTransportCapabilities(): object {
	return {
		version: grpcTransportVersion,
		backend: grpcTransportRuntimeBackend,
		protocols: grpcTransportProtocols,
		callKinds: ["unary", "server-streaming"],
		features: [
			"protobuf payloads",
			"binary/text gRPC-Web framing",
			"Connect framing",
			"response trailers",
			"deadlines",
			"cancellation",
			"bounded messages",
			"transient metadata",
		],
		boundaries: [
			"Browser fetch requires server CORS support and cannot provide unrestricted native HTTP/2 gRPC semantics.",
			"Client-streaming and bidirectional-streaming are not available through this portable fetch transport.",
			"Compressed message envelopes are rejected; configure the server for identity encoding.",
			"Authorization and cookie metadata are transient per call and are never persisted in scene configuration.",
		],
	};
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		grpcTransportRuntime?: IGrpcTransportRuntimeEvidence;
	}
}
