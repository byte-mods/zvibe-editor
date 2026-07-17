import { createRequire } from "module";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureDir, mkdtemp, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import { acquireProjectAssetLock, listProjectAssetLocks, refreshProjectAssetLock, releaseProjectAssetLock } from "../../src/mcp/project/asset-locks";
import { configureProjectCollaboration, createProjectCollaborationMember, joinProjectCollaborationSession } from "../../src/mcp/project/collaboration";
import { getRemoteCollaborationRelay, reconnectRemoteCollaborationRelay, setRemoteCollaborationRelay } from "../../src/mcp/project/collaboration-relay";
import { initializeRemoteCollaborationGateway, shutdownRemoteCollaborationGateway } from "../../src/mcp/project/remote-collaboration";
import { startManagedRelayServer } from "../../../mcp/src/relay-server.mjs";

const require = createRequire(`${process.cwd()}/package.json`);
const { WebSocketServer } = require("ws");

interface IRelayFixture {
	url: string;
	registrations: any[];
	messages: any[];
	connections: number;
	request(request: any): Promise<any>;
	send(message: any): Promise<void>;
	close(): Promise<void>;
}

async function waitFor<T>(read: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs = 4000): Promise<T> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = await read();
		if (value) {
			return value;
		}
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
	}
	throw new Error(`Timed out after ${timeoutMs}ms.`);
}

async function createRelayFixture(expectedAccessToken: string): Promise<IRelayFixture> {
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolveListen) => server.once("listening", resolveListen));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const registrations: any[] = [];
	const messages: any[] = [];
	const responses = new Map<string, any>();
	let socket: any = null;
	let connections = 0;
	server.on("connection", (client: any) => {
		socket = client;
		connections++;
		client.on("message", (buffer: Buffer) => {
			const message = JSON.parse(buffer.toString("utf-8"));
			messages.push(message);
			if (message.type === "register") {
				registrations.push(message);
				if (message.accessToken === expectedAccessToken) {
					client.send(JSON.stringify({ type: "registered", connectionId: `connection-${connections}`, publicUrl: "https://relay.example/projects/relay-room" }));
				} else {
					client.close(4001, "Unauthorized");
				}
			}
			if (message.type === "response") {
				responses.set(message.requestId, message);
			}
		});
	});
	return {
		url: `ws://127.0.0.1:${port}/v1/editor`,
		registrations,
		messages,
		get connections(): number {
			return connections;
		},
		async request(request: any): Promise<any> {
			const client = await waitFor(() => socket?.readyState === 1 && socket);
			client.send(JSON.stringify(request));
			return waitFor(() => responses.get(request.requestId));
		},
		async send(message: any): Promise<void> {
			const client = await waitFor(() => socket?.readyState === 1 && socket);
			client.send(JSON.stringify(message));
		},
		async close(): Promise<void> {
			for (const client of server.clients) {
				client.terminate();
			}
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		},
	};
}

describe("mcp/project/collaboration-relay", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;
	let options: any;
	let relay: IRelayFixture | null;
	let managedRelay: Awaited<ReturnType<typeof startManagedRelayServer>> | null;
	let value = 0;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-collaboration-relay-"));
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = {
			state: { projectPath: join(directory, "Relay Game.bjseditor") },
			layout: { preview: { scene }, console: { error: () => undefined, log: () => undefined } },
		};
		options = { editor };
		relay = null;
		managedRelay = null;
		value = 0;
		await writeJSON(editor.state.projectPath, {});
		await ensureDir(join(directory, "assets"));
		await writeFile(join(directory, "assets", "hero.glb"), "mesh", "utf-8");
		await initializeRemoteCollaborationGateway(editor, {
			get_test_value: async () => ({ value }),
			set_test_value: async (_scene, data) => ({ value: (value = data.value) }),
			list_project_asset_locks: listProjectAssetLocks,
			acquire_project_asset_lock: acquireProjectAssetLock,
			refresh_project_asset_lock: refreshProjectAssetLock,
			release_project_asset_lock: releaseProjectAssetLock,
		});
	});

	afterEach(async () => {
		await shutdownRemoteCollaborationGateway();
		await relay?.close();
		await managedRelay?.close();
		delete process.env.BABYLON_EDITOR_RELAY_TEST_TOKEN;
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	async function bootstrap(): Promise<{ adminToken: string; editorToken: string; viewerToken: string }> {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const admin = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Relay Admin" },
			options
		);
		const viewer = await createProjectCollaborationMember(scene, { name: "Viewer", role: "viewer", collaborationToken: admin.session.token }, options);
		const viewerSession = await joinProjectCollaborationSession(scene, { memberId: viewer.member.id, accessKey: viewer.accessKey, clientName: "Relay Viewer" }, options);
		const editorMember = await createProjectCollaborationMember(scene, { name: "Artist", role: "editor", collaborationToken: admin.session.token }, options);
		const editorSession = await joinProjectCollaborationSession(
			scene,
			{ memberId: editorMember.member.id, accessKey: editorMember.accessKey, clientName: "Relay Artist" },
			options
		);
		return { adminToken: admin.session.token, editorToken: editorSession.session.token, viewerToken: viewerSession.session.token };
	}

	test("registers outbound, tunnels every collaboration workflow, enforces RBAC, and never persists or returns the relay secret", async () => {
		const { adminToken, editorToken, viewerToken } = await bootstrap();
		const relayAccessToken = "relay-access-token-that-must-stay-secret";
		relay = await createRelayFixture(relayAccessToken);
		const configured = await setRemoteCollaborationRelay(
			scene,
			{ enabled: true, relayUrl: relay.url, projectSlug: "relay-room", relayAccessToken, reconnectMinimumMs: 500, reconnectMaximumMs: 1000, collaborationToken: adminToken },
			options
		);
		expect(configured).toMatchObject({ config: { enabled: true, projectSlug: "relay-room" }, authentication: { available: true, persisted: false } });
		await waitFor(() => relay!.registrations[0]);
		expect(relay.registrations[0]).toMatchObject({
			protocol: "babylon-editor-collaboration-relay",
			version: 1,
			type: "register",
			projectSlug: "relay-room",
			accessToken: relayAccessToken,
		});
		await waitFor(() => getRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options).then((status) => (status.connected ? status : null)));

		const action = await relay.request({
			type: "request",
			requestId: "action-1",
			kind: "action",
			token: adminToken,
			body: { endpoint: "set_test_value", data: { value: 42 } },
		});
		expect(action).toMatchObject({ success: true, status: 200, body: { value: 42 } });
		const denied = await relay.request({
			type: "request",
			requestId: "action-2",
			kind: "action",
			token: viewerToken,
			body: { endpoint: "set_test_value", data: { value: 99 } },
		});
		expect(denied).toMatchObject({ success: false, status: 403 });
		expect(value).toBe(42);

		const presence = await relay.request({ type: "request", requestId: "presence-1", kind: "presence", token: viewerToken, body: { state: "reviewing through relay" } });
		expect(presence).toMatchObject({ success: true, body: { session: { state: "reviewing through relay" } } });
		const events = await relay.request({ type: "request", requestId: "events-1", kind: "events", token: viewerToken, body: { afterSequence: 0, limit: 20 } });
		expect(events).toMatchObject({ success: true, body: { count: expect.any(Number), events: expect.any(Array) } });
		const lock = await relay.request({
			type: "request",
			requestId: "lock-1",
			kind: "lock",
			token: editorToken,
			body: { operation: "acquire", path: "assets/hero.glb", ttlSeconds: 60 },
		});
		expect(lock).toMatchObject({ success: true, body: { acquired: true, lock: { path: "assets/hero.glb" } } });
		await relay.send({ type: "ping", nonce: "relay-ping" });
		expect(await waitFor(() => relay!.messages.find((message) => message.type === "pong"))).toEqual({ type: "pong", nonce: "relay-ping" });

		const persisted = await readJSON(join(directory, ".babylon-editor", "remote-collaboration-relay.json"));
		expect(JSON.stringify(persisted)).not.toContain(relayAccessToken);
		const status = await getRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options);
		expect(status).toMatchObject({ connected: true, receivedRequests: 5, succeededRequests: 4, failedRequests: 1, publicUrl: "https://relay.example/projects/relay-room" });
		expect(JSON.stringify(status)).not.toContain(relayAccessToken);
		expect(JSON.stringify(status)).not.toContain(adminToken);
	});

	test("enforces administrator setup and secure URLs, then restores from an environment-only token and reconnects", async () => {
		const { adminToken, viewerToken } = await bootstrap();
		await expect(
			setRemoteCollaborationRelay(
				scene,
				{ enabled: true, relayUrl: "ws://127.0.0.1:9999", projectSlug: "relay-room", relayAccessToken: "long-enough-relay-token", collaborationToken: viewerToken },
				options
			)
		).rejects.toThrow("admin role");
		await expect(
			setRemoteCollaborationRelay(
				scene,
				{ enabled: true, relayUrl: "ws://example.com/relay", projectSlug: "relay-room", relayAccessToken: "long-enough-relay-token", collaborationToken: adminToken },
				options
			)
		).rejects.toThrow("wss://");
		await expect(
			setRemoteCollaborationRelay(
				scene,
				{
					enabled: true,
					relayUrl: "wss://user:password@example.com/relay",
					projectSlug: "relay-room",
					relayAccessToken: "long-enough-relay-token",
					collaborationToken: adminToken,
				},
				options
			)
		).rejects.toThrow("credentials");
		await expect(
			setRemoteCollaborationRelay(scene, { enabled: true, relayUrl: "wss://relay.example/relay", projectSlug: "relay-room", collaborationToken: adminToken }, options)
		).rejects.toThrow("requires relayAccessToken");

		const relayAccessToken = "environment-only-relay-token-secret";
		process.env.BABYLON_EDITOR_RELAY_TEST_TOKEN = relayAccessToken;
		relay = await createRelayFixture(relayAccessToken);
		await setRemoteCollaborationRelay(
			scene,
			{
				enabled: true,
				relayUrl: relay.url,
				projectSlug: "relay-room",
				tokenEnvironmentVariable: "BABYLON_EDITOR_RELAY_TEST_TOKEN",
				reconnectMinimumMs: 500,
				reconnectMaximumMs: 1000,
				collaborationToken: adminToken,
			},
			options
		);
		await waitFor(() => relay!.registrations.length === 1 && relay!.registrations[0]);
		await shutdownRemoteCollaborationGateway();
		await initializeRemoteCollaborationGateway(editor, {
			get_test_value: async () => ({ value }),
			set_test_value: async (_scene, data) => ({ value: (value = data.value) }),
		});
		await waitFor(() => relay!.registrations.length >= 2 && relay!.registrations[1]);
		const restored = await getRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options);
		expect(restored).toMatchObject({ config: { enabled: true, projectSlug: "relay-room" }, authentication: { source: "environment", persisted: false } });
		const connectionsBefore = relay.connections;
		await reconnectRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options);
		await waitFor(() => relay!.connections > connectionsBefore && relay!.registrations.length >= 3 && relay!.registrations.at(-1));
		expect((await getRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options)).connected).toBe(true);
	});

	test("rejects malformed and oversized relay frames and enters bounded reconnect state", async () => {
		const { adminToken } = await bootstrap();
		const relayAccessToken = "frame-validation-relay-token";
		relay = await createRelayFixture(relayAccessToken);
		await setRemoteCollaborationRelay(
			scene,
			{ enabled: true, relayUrl: relay.url, projectSlug: "relay-room", relayAccessToken, reconnectMinimumMs: 500, reconnectMaximumMs: 1000, collaborationToken: adminToken },
			options
		);
		await waitFor(() => relay!.registrations[0]);
		await relay.send({ type: "request", requestId: "bad", kind: "unknown", token: adminToken, body: {} });
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, 30));
		expect((await getRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options)).lastError).toContain("malformed");
		await relay.send({ type: "oversized", payload: "x".repeat(1024 * 1024) });
		await waitFor(() => relay!.connections >= 2);
		const status = await getRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options);
		expect(["registering", "connected", "reconnecting"]).toContain(status.state);
		expect(status.reconnectAttempt).toBeLessThanOrEqual(1);
	});

	test("routes public HTTP requests through the deployable managed relay service to the outbound editor", async () => {
		const { adminToken, viewerToken } = await bootstrap();
		const relayAccessToken = "deployable-managed-relay-token";
		managedRelay = await startManagedRelayServer({ host: "127.0.0.1", port: 0, projectAccessTokens: { "relay-room": relayAccessToken }, requestTimeoutMs: 2000 });
		await setRemoteCollaborationRelay(
			scene,
			{
				enabled: true,
				relayUrl: `ws://127.0.0.1:${managedRelay.port}/v1/editor`,
				projectSlug: "relay-room",
				relayAccessToken,
				collaborationToken: adminToken,
			},
			options
		);
		await waitFor(() => getRemoteCollaborationRelay(scene, { collaborationToken: adminToken }, options).then((status) => (status.connected ? status : null)));
		const request = async (token: string | null, body: any): Promise<Response> =>
			fetch(`${managedRelay!.baseUrl}/v1/projects/relay-room/request`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
				body: JSON.stringify(body),
			});
		const changed = await request(adminToken, { kind: "action", body: { endpoint: "set_test_value", data: { value: 73 } } });
		expect(changed.status).toBe(200);
		expect(await changed.json()).toEqual({ success: true, body: { value: 73 } });
		const denied = await request(viewerToken, { kind: "action", body: { endpoint: "set_test_value", data: { value: 99 } } });
		expect(denied.status).toBe(403);
		expect(await denied.json()).toMatchObject({ success: false, error: expect.any(String) });
		expect(value).toBe(73);
		const missingToken = await request(null, { kind: "events", body: { afterSequence: 0, limit: 10 } });
		expect(missingToken.status).toBe(400);
		const health = await fetch(`${managedRelay.baseUrl}/health`).then((response) => response.json());
		expect(health).toMatchObject({ ok: true, registeredProjects: 1, pendingRequests: 0 });
		expect(managedRelay.status()).toMatchObject({ registeredProjects: 1, acceptedRequests: 2, rejectedRequests: 1 });
	});
});
