import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { createRequire } from "module";

const require = createRequire(`${process.cwd()}/package.json`);
const { WebSocketServer } = require("ws");

const relayProtocol = "babylon-editor-collaboration-relay";
const relayVersion = 1;
const maximumBodyBytes = 1024 * 1024;
const maximumPendingRequestsPerEditor = 128;

export interface IManagedRelayServerOptions {
	host?: string;
	port?: number;
	publicBaseUrl?: string;
	projectAccessTokens: Record<string, string>;
	requestTimeoutMs?: number;
	requestLimitPerMinute?: number;
}

export interface IManagedRelayServer {
	host: string;
	port: number;
	baseUrl: string;
	status(): { registeredProjects: number; pendingRequests: number; acceptedRequests: number; rejectedRequests: number };
	close(): Promise<void>;
}

interface IRegisteredEditor {
	projectSlug: string;
	clientInstanceId: string;
	connectionId: string;
	socket: any;
}

interface IPendingRequest {
	projectSlug: string;
	socket: any;
	response: ServerResponse;
	timeout: ReturnType<typeof setTimeout>;
}

function safeEqual(left: string, right: string): boolean {
	const leftHash = createHash("sha256").update(left).digest();
	const rightHash = createHash("sha256").update(right).digest();
	return timingSafeEqual(leftHash, rightHash);
}

function validateOptions(options: IManagedRelayServerOptions): Required<IManagedRelayServerOptions> {
	const host = options.host ?? "127.0.0.1";
	const port = options.port ?? 0;
	const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	const requestLimitPerMinute = options.requestLimitPerMinute ?? 120;
	let publicBaseUrl = "";
	if (options.publicBaseUrl) {
		let url: URL;
		try {
			url = new URL(options.publicBaseUrl);
		} catch {
			throw new Error("Managed relay publicBaseUrl must be a valid HTTPS URL.");
		}
		const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
		if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
			throw new Error("Managed relay publicBaseUrl must use HTTPS; HTTP is allowed only for loopback development.");
		}
		if (url.username || url.password || url.search || url.hash) {
			throw new Error("Managed relay publicBaseUrl must not contain credentials, query parameters, or fragments.");
		}
		publicBaseUrl = url.toString().replace(/\/$/, "");
	}
	if (!Number.isInteger(port) || port < 0 || port > 65535) {
		throw new Error("Managed relay port must be an integer from 0 through 65535.");
	}
	if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120_000) {
		throw new Error("Managed relay requestTimeoutMs must be an integer from 1000 through 120000.");
	}
	if (!Number.isInteger(requestLimitPerMinute) || requestLimitPerMinute < 1 || requestLimitPerMinute > 10000) {
		throw new Error("Managed relay requestLimitPerMinute must be an integer from 1 through 10000.");
	}
	const projectAccessTokens: Record<string, string> = {};
	for (const [slug, token] of Object.entries(options.projectAccessTokens ?? {})) {
		if (!/^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])?$/.test(slug) || typeof token !== "string" || token.length < 16 || token.length > 512 || /[\s\0]/.test(token)) {
			throw new Error("Managed relay project tokens require valid 3–80-character slugs and 16–512-character non-whitespace secrets.");
		}
		projectAccessTokens[slug] = token;
	}
	return { host, port, publicBaseUrl, projectAccessTokens, requestTimeoutMs, requestLimitPerMinute };
}

function readJsonBody(request: IncomingMessage): Promise<any> {
	return new Promise((resolveBody, rejectBody) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
			if (Buffer.byteLength(body) > maximumBodyBytes) {
				rejectBody(new Error(`Relay request bodies are limited to ${maximumBodyBytes} bytes.`));
				request.destroy();
			}
		});
		request.on("end", () => {
			try {
				resolveBody(body ? JSON.parse(body) : {});
			} catch {
				rejectBody(new Error("Relay request body must be valid JSON."));
			}
		});
		request.on("error", rejectBody);
	});
}

function bearerToken(request: IncomingMessage): string {
	const header = request.headers.authorization;
	if (!header?.startsWith("Bearer ") || header.length < 23 || header.length > 519 || /[\s\0]/.test(header.slice(7))) {
		throw new Error("A collaboration-session bearer token is required.");
	}
	return header.slice(7);
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
	response.end(JSON.stringify(body));
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
}

export async function startManagedRelayServer(input: IManagedRelayServerOptions): Promise<IManagedRelayServer> {
	const options = validateOptions(input);
	const editors = new Map<string, IRegisteredEditor>();
	const pending = new Map<string, IPendingRequest>();
	const rateLimits = new Map<string, { windowStarted: number; count: number }>();
	let acceptedRequests = 0;
	let rejectedRequests = 0;
	const webSockets = new WebSocketServer({ noServer: true, maxPayload: maximumBodyBytes });

	function rejectPendingForSocket(socket: any, message: string): void {
		for (const [requestId, item] of pending) {
			if (item.socket === socket) {
				clearTimeout(item.timeout);
				pending.delete(requestId);
				json(item.response, 502, { error: message });
			}
		}
	}

	webSockets.on("connection", (socket: any) => {
		let registered: IRegisteredEditor | null = null;
		const registrationTimeout = setTimeout(() => socket.close(4000, "Registration timeout"), 10_000);
		socket.on("message", (buffer: Buffer) => {
			if (buffer.length > maximumBodyBytes) {
				socket.close(4009, "Frame too large");
				return;
			}
			let message: any;
			try {
				message = JSON.parse(buffer.toString("utf-8"));
			} catch {
				socket.close(4002, "Invalid JSON");
				return;
			}
			if (!registered) {
				const expected = typeof message?.projectSlug === "string" ? options.projectAccessTokens[message.projectSlug] : undefined;
				if (
					message?.protocol !== relayProtocol ||
					message.version !== relayVersion ||
					message.type !== "register" ||
					typeof message.clientInstanceId !== "string" ||
					!/^[0-9a-f-]{36}$/i.test(message.clientInstanceId) ||
					typeof message.accessToken !== "string" ||
					!expected ||
					!safeEqual(message.accessToken, expected)
				) {
					socket.close(4001, "Unauthorized");
					return;
				}
				clearTimeout(registrationTimeout);
				const previous = editors.get(message.projectSlug);
				if (previous) {
					previous.socket.close(4004, "Replaced by newer editor connection");
					rejectPendingForSocket(previous.socket, "The registered editor connection was replaced.");
				}
				registered = { projectSlug: message.projectSlug, clientInstanceId: message.clientInstanceId, connectionId: randomUUID(), socket };
				editors.set(message.projectSlug, registered);
				const baseUrl = options.publicBaseUrl.replace(/\/$/, "");
				socket.send(
					JSON.stringify({
						type: "registered",
						connectionId: registered.connectionId,
						...(baseUrl ? { publicUrl: `${baseUrl}/v1/projects/${message.projectSlug}` } : {}),
					})
				);
				return;
			}
			if (message?.type === "response" && typeof message.requestId === "string") {
				const item = pending.get(message.requestId);
				if (!item || item.socket !== socket) {
					return;
				}
				clearTimeout(item.timeout);
				pending.delete(message.requestId);
				const status = Number.isInteger(message.status) && message.status >= 200 && message.status <= 599 ? message.status : message.success ? 200 : 502;
				json(
					item.response,
					status,
					message.success ? { success: true, body: message.body ?? null } : { success: false, error: String(message.error ?? "Relayed request failed.").slice(0, 256) }
				);
			}
		});
		socket.on("close", () => {
			clearTimeout(registrationTimeout);
			if (registered && editors.get(registered.projectSlug)?.socket === socket) {
				editors.delete(registered.projectSlug);
			}
			rejectPendingForSocket(socket, "The registered editor disconnected before responding.");
		});
	});

	const server = createServer(async (request, response) => {
		try {
			if (request.method === "GET" && request.url === "/health") {
				json(response, 200, { ok: true, registeredProjects: editors.size, pendingRequests: pending.size });
				return;
			}
			const match = request.url?.match(/^\/v1\/projects\/([a-z0-9][a-z0-9-]{1,78}[a-z0-9])\/request$/);
			if (request.method !== "POST" || !match) {
				json(response, 404, { error: "Unknown managed relay route." });
				return;
			}
			const remoteAddress = request.socket.remoteAddress ?? "unknown";
			const now = Date.now();
			const rate = rateLimits.get(remoteAddress);
			if (!rate || now - rate.windowStarted >= 60_000) {
				rateLimits.set(remoteAddress, { windowStarted: now, count: 1 });
			} else if (++rate.count > options.requestLimitPerMinute) {
				rejectedRequests++;
				json(response, 429, { error: "Managed relay request rate exceeded." });
				return;
			}
			const token = bearerToken(request);
			const editor = editors.get(match[1]);
			if (!editor || editor.socket.readyState !== 1) {
				rejectedRequests++;
				json(response, 503, { error: "No editor is currently registered for this project." });
				return;
			}
			const projectPending = [...pending.values()].filter((item) => item.projectSlug === match[1]).length;
			if (projectPending >= maximumPendingRequestsPerEditor) {
				rejectedRequests++;
				json(response, 429, { error: "This project has too many pending relay requests." });
				return;
			}
			const body = await readJsonBody(request);
			if (!body || !["action", "presence", "events", "lock"].includes(body.kind) || body.body === undefined) {
				throw new Error("Relay request requires kind action, presence, events, or lock plus a body object.");
			}
			const requestId = randomUUID();
			const timeout = setTimeout(() => {
				if (pending.delete(requestId)) {
					rejectedRequests++;
					json(response, 504, { error: "The editor did not answer the relay request before its timeout." });
				}
			}, options.requestTimeoutMs);
			pending.set(requestId, { projectSlug: match[1], socket: editor.socket, response, timeout });
			editor.socket.send(JSON.stringify({ type: "request", requestId, kind: body.kind, token, body: body.body }));
			acceptedRequests++;
		} catch (error) {
			rejectedRequests++;
			if (!response.headersSent) {
				json(response, 400, { error: error instanceof Error ? error.message : "Invalid managed relay request." });
			}
		}
	});
	server.on("upgrade", (request, socket, head) => {
		if (request.url !== "/v1/editor") {
			socket.destroy();
			return;
		}
		webSockets.handleUpgrade(request, socket, head, (client: any) => webSockets.emit("connection", client, request));
	});
	await listen(server, options.port, options.host);
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : options.port;
	const baseUrl = options.publicBaseUrl || `http://${options.host}:${actualPort}`;
	return {
		host: options.host,
		port: actualPort,
		baseUrl,
		status: () => ({ registeredProjects: editors.size, pendingRequests: pending.size, acceptedRequests, rejectedRequests }),
		close: async (): Promise<void> => {
			for (const item of pending.values()) {
				clearTimeout(item.timeout);
				json(item.response, 503, { error: "Managed relay is shutting down." });
			}
			pending.clear();
			for (const editor of editors.values()) {
				editor.socket.close(1001, "Managed relay shutdown");
			}
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

async function runFromEnvironment(): Promise<void> {
	let projectAccessTokens: Record<string, string>;
	try {
		projectAccessTokens = JSON.parse(process.env.BABYLON_EDITOR_RELAY_PROJECT_TOKENS ?? "{}");
	} catch {
		throw new Error("BABYLON_EDITOR_RELAY_PROJECT_TOKENS must be a JSON object mapping project slugs to relay access tokens.");
	}
	const relay = await startManagedRelayServer({
		host: process.env.BABYLON_EDITOR_RELAY_HOST ?? "127.0.0.1",
		port: Number(process.env.BABYLON_EDITOR_RELAY_PORT ?? 8787),
		publicBaseUrl: process.env.BABYLON_EDITOR_RELAY_PUBLIC_BASE_URL,
		projectAccessTokens,
	});
	console.error(`[Babylon.js Editor Relay] Listening on ${relay.host}:${relay.port}`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/relay-server.mjs")) {
	void runFromEnvironment().catch((error) => {
		console.error(`[Babylon.js Editor Relay] ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
