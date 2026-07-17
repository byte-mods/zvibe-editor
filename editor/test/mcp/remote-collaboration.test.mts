import { createServer } from "net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readdir, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import {
	configureProjectCollaboration,
	createProjectCollaborationMember,
	joinProjectCollaborationSession,
	listProjectCollaborationPresence,
} from "../../src/mcp/project/collaboration";
import {
	clearRemoteCollaborationEventHistory,
	getRemoteCollaborationGateway,
	initializeRemoteCollaborationGateway,
	listRemoteCollaborationEvents,
	publishRemoteCollaborationOperation,
	setRemoteCollaborationEventHistory,
	setRemoteCollaborationGateway,
	shutdownRemoteCollaborationGateway,
} from "../../src/mcp/project/remote-collaboration";
import { acquireProjectAssetLock, listProjectAssetLocks, refreshProjectAssetLock, releaseProjectAssetLock } from "../../src/mcp/project/asset-locks";

describe("mcp/project/remote-collaboration", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;
	let options: any;
	let value = 0;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-remote-collaboration-"));
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = {
			state: { projectPath: join(directory, "Game.bjseditor") },
			layout: { preview: { scene }, console: { error: () => undefined, log: () => undefined } },
		};
		options = { editor };
		await writeJSON(editor.state.projectPath, {});
		await ensureDir(join(directory, "assets"));
		await writeFile(join(directory, "assets", "hero.glb"), "mesh", "utf-8");
		value = 0;
		await initializeRemoteCollaborationGateway(editor, {
			get_test_value: async () => ({ value }),
			set_test_value: async (_scene, data) => {
				value = data.value;
				return { value };
			},
			list_project_asset_locks: listProjectAssetLocks,
			acquire_project_asset_lock: acquireProjectAssetLock,
			refresh_project_asset_lock: refreshProjectAssetLock,
			release_project_asset_lock: releaseProjectAssetLock,
		});
	});

	afterEach(async () => {
		await shutdownRemoteCollaborationGateway();
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	async function freePort(): Promise<number> {
		const server = createServer();
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		return port;
	}

	async function bootstrap(): Promise<{ adminToken: string; editorToken: string; viewerToken: string }> {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const admin = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Admin Remote Test" },
			options
		);
		const viewer = await createProjectCollaborationMember(scene, { name: "Viewer", role: "viewer", collaborationToken: admin.session.token }, options);
		const viewerSession = await joinProjectCollaborationSession(scene, { memberId: viewer.member.id, accessKey: viewer.accessKey, clientName: "Viewer Browser" }, options);
		const editorMember = await createProjectCollaborationMember(scene, { name: "Remote Artist", role: "editor", collaborationToken: admin.session.token }, options);
		const editorSession = await joinProjectCollaborationSession(
			scene,
			{ memberId: editorMember.member.id, accessKey: editorMember.accessKey, clientName: "Artist Workstation" },
			options
		);
		return { adminToken: admin.session.token, editorToken: editorSession.session.token, viewerToken: viewerSession.session.token };
	}

	async function remoteRequest(port: number, path: string, token: string | null, init: RequestInit = {}): Promise<Response> {
		return fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			headers: {
				Origin: "http://allowed.test",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(init.headers ?? {}),
			},
		});
	}

	test("serves authenticated remote actions, enforces viewer RBAC, streams replay, and updates live presence", async () => {
		const { adminToken, viewerToken } = await bootstrap();
		const port = await freePort();
		const gateway = await setRemoteCollaborationGateway(
			scene,
			{
				enabled: true,
				bindAddress: "127.0.0.1",
				port,
				allowedOrigins: ["http://allowed.test"],
				allowedHosts: [`127.0.0.1:${port}`],
				collaborationToken: adminToken,
			},
			options
		);
		expect(gateway).toMatchObject({ running: true, actualPort: port, protocol: "http" });

		const adminAction = await remoteRequest(port, "/action", adminToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: "set_test_value", data: { value: 42 } }),
		});
		expect(adminAction.status).toBe(200);
		expect(await adminAction.json()).toEqual({ value: 42 });

		const denied = await remoteRequest(port, "/action", viewerToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: "set_test_value", data: { value: 99 } }),
		});
		expect(denied.status).toBe(403);
		expect(value).toBe(42);
		const allowed = await remoteRequest(port, "/action", viewerToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ endpoint: "get_test_value", data: {} }),
		});
		expect(allowed.status).toBe(200);

		const presence = await remoteRequest(port, "/presence", viewerToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				state: "reviewing camera",
				selectionNodeIds: ["camera-main"],
				primarySelectionNodeId: "camera-main",
				hoveredNodeId: "light-fill",
				color: "#FF8800",
				toolMode: "navigate",
				pointers: [{ id: "remote-mouse", x: 0.25, y: 0.75, viewport: "scene", worldRay: { origin: [0, 1, 2], direction: [0, 0, -1] } }],
				camera: { viewport: "scene", position: [10, 20, 30], target: [0, 0, 0], fovDegrees: 50 },
			}),
		});
		expect(presence.status).toBe(200);
		expect((await listProjectCollaborationPresence(scene, { collaborationToken: adminToken }, options)).presence).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					memberName: "Viewer",
					selectionNodeIds: ["camera-main"],
					primarySelectionNodeId: "camera-main",
					hoveredNodeId: "light-fill",
					color: "#FF8800",
					toolMode: "navigate",
					cursor: { x: 0.25, y: 0.75, viewport: "scene" },
					pointers: [expect.objectContaining({ id: "remote-mouse", worldRay: expect.objectContaining({ direction: [0, 0, -1] }) })],
					camera: expect.objectContaining({ position: [10, 20, 30], fovDegrees: 50 }),
				}),
			])
		);

		const controller = new AbortController();
		const stream = await remoteRequest(port, "/events", viewerToken, { signal: controller.signal, headers: { "Last-Event-ID": "0" } });
		expect(stream.status).toBe(200);
		const reader = stream.body!.getReader();
		let text = "";
		for (let index = 0; index < 10 && (!text.includes("set_test_value") || !text.includes("heartbeat_project_collaboration_session")); index++) {
			const chunk = await reader.read();
			text += new TextDecoder().decode(chunk.value);
		}
		expect(text).toContain("set_test_value");
		expect(text).toContain("heartbeat_project_collaboration_session");
		controller.abort();
		await reader.cancel().catch(() => undefined);

		const replay = await listRemoteCollaborationEvents(scene, { collaborationToken: adminToken, afterSequence: 0, limit: 100 }, options);
		expect(replay.events).toEqual(expect.arrayContaining([expect.objectContaining({ endpoint: "set_test_value", success: true, source: "remote" })]));
	});

	test("rejects missing bearer tokens, disallowed origins, and insecure non-loopback configuration", async () => {
		const { adminToken } = await bootstrap();
		const port = await freePort();
		await setRemoteCollaborationGateway(
			scene,
			{ enabled: true, bindAddress: "127.0.0.1", port, allowedOrigins: ["http://allowed.test"], allowedHosts: [`127.0.0.1:${port}`], collaborationToken: adminToken },
			options
		);
		expect((await remoteRequest(port, "/events", null)).status).toBe(403);
		const badOrigin = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Origin: "http://evil.test" } });
		expect(badOrigin.status).toBe(403);
		await expect(
			setRemoteCollaborationGateway(
				scene,
				{ enabled: true, bindAddress: "0.0.0.0", port, allowedOrigins: ["https://team.example"], allowedHosts: [`team.example:${port}`], collaborationToken: adminToken },
				options
			)
		).rejects.toThrow("requires TLS");
		expect((await getRemoteCollaborationGateway(scene, { collaborationToken: adminToken }, options)).running).toBe(true);
	});

	test("federates member-bound asset locks with secret redaction, RBAC, conflicts, and lock events", async () => {
		const { adminToken, editorToken, viewerToken } = await bootstrap();
		const port = await freePort();
		await setRemoteCollaborationGateway(
			scene,
			{ enabled: true, bindAddress: "127.0.0.1", port, allowedOrigins: ["http://allowed.test"], allowedHosts: [`127.0.0.1:${port}`], collaborationToken: adminToken },
			options
		);

		const acquiredResponse = await remoteRequest(port, "/locks/acquire", editorToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "assets/hero.glb", owner: "Spoofed Owner", note: "Editing skeleton", ttlSeconds: 60 }),
		});
		expect(acquiredResponse.status).toBe(200);
		const acquired = await acquiredResponse.json();
		expect(acquired).toMatchObject({ acquired: true, federated: true, lock: { owner: "Remote Artist", clientName: "Artist Workstation", canManage: true } });
		expect(acquired.lock.lockId).toMatch(/^[0-9a-f-]{36}$/i);

		const viewerListResponse = await remoteRequest(port, "/locks", viewerToken);
		expect(viewerListResponse.status).toBe(200);
		const viewerList = await viewerListResponse.json();
		expect(viewerList.locks[0]).toMatchObject({ owner: "Remote Artist", canManage: false });
		expect(viewerList.locks[0].lockId).toBeUndefined();

		const viewerMutation = await remoteRequest(port, "/locks/release", viewerToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "assets/hero.glb", force: true }),
		});
		expect(viewerMutation.status).toBe(403);

		const conflictResponse = await remoteRequest(port, "/locks/acquire", adminToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "assets/hero.glb", ttlSeconds: 60 }),
		});
		expect(conflictResponse.status).toBe(409);
		const conflict = await conflictResponse.json();
		expect(conflict).toMatchObject({ acquired: false, conflict: { owner: "Remote Artist", canManage: true } });

		const refreshedResponse = await remoteRequest(port, "/locks/refresh", editorToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "assets/hero.glb", lockId: acquired.lock.lockId, ttlSeconds: 120 }),
		});
		expect(refreshedResponse.status).toBe(200);
		expect(await refreshedResponse.json()).toMatchObject({ refreshed: true, federated: true });

		const events = await listRemoteCollaborationEvents(scene, { collaborationToken: adminToken, afterSequence: 0, limit: 100 }, options);
		expect(events.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "lock", endpoint: "acquire_project_asset_lock", success: true, actor: expect.objectContaining({ memberName: "Remote Artist" }) }),
				expect.objectContaining({ type: "lock", endpoint: "acquire_project_asset_lock", success: false }),
			])
		);
		expect(JSON.stringify(events)).not.toContain(acquired.lock.lockId);

		const releasedResponse = await remoteRequest(port, "/locks/release", editorToken, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: "assets/hero.glb", lockId: acquired.lock.lockId }),
		});
		expect(releasedResponse.status).toBe(200);
		expect(await releasedResponse.json()).toMatchObject({ released: true, federated: true });
	});

	test("retains a bounded replay window without storing action payloads or credentials", async () => {
		const { adminToken } = await bootstrap();
		for (let index = 0; index < 1005; index++) {
			await publishRemoteCollaborationOperation("set_secret_value", true, null, options, `event ${index}`);
		}
		const status = await getRemoteCollaborationGateway(scene, { collaborationToken: adminToken }, options);
		expect(status.eventCount).toBe(1000);
		const replay = await listRemoteCollaborationEvents(scene, { collaborationToken: adminToken, afterSequence: 0, limit: 500 }, options);
		expect(replay).toMatchObject({ truncated: true });
		expect(replay.events).toHaveLength(500);
		expect(JSON.stringify(replay)).not.toContain(adminToken);
	});

	test("restores durable sanitized history across restart and continues monotonic filtered pagination", async () => {
		const { adminToken } = await bootstrap();
		await publishRemoteCollaborationOperation("set_test_value", true, null, options, `Bearer ${adminToken}\ncompleted`);
		await publishRemoteCollaborationOperation("heartbeat_project_collaboration_session", true, null, options, "presence updated");
		const before = await listRemoteCollaborationEvents(scene, { collaborationToken: adminToken, afterSequence: 0, limit: 100 }, options);
		const latestBeforeRestart = before.latestSequence;
		expect(JSON.stringify(before)).not.toContain(adminToken);

		await shutdownRemoteCollaborationGateway();
		await initializeRemoteCollaborationGateway(editor, {
			get_test_value: async () => ({ value }),
			set_test_value: async (_scene, data) => ({ value: (value = data.value) }),
		});
		const restored = await listRemoteCollaborationEvents(
			scene,
			{ collaborationToken: adminToken, afterSequence: 0, limit: 1, type: "operation", success: true, endpoint: "set_test_value" },
			options
		);
		expect(restored).toMatchObject({ count: 1, hasMore: false, gap: false, latestSequence: latestBeforeRestart });
		expect(restored.events[0]).toMatchObject({ endpoint: "set_test_value", details: "Bearer [redacted] completed" });

		await publishRemoteCollaborationOperation("get_test_value", true, null, options, "read after restart");
		const continued = await listRemoteCollaborationEvents(scene, { collaborationToken: adminToken, afterSequence: latestBeforeRestart, limit: 10 }, options);
		expect(continued.events[0].sequence).toBe(latestBeforeRestart + 1);
	});

	test("quarantines malformed durable history and recovers without blocking the editor", async () => {
		const { adminToken } = await bootstrap();
		await publishRemoteCollaborationOperation("get_test_value", true, null, options, "before corruption");
		await shutdownRemoteCollaborationGateway();
		await writeFile(join(directory, ".babylon-editor", "remote-collaboration-events.json"), "{ invalid", "utf-8");
		await initializeRemoteCollaborationGateway(editor, { get_test_value: async () => ({ value }) });

		const recovered = await getRemoteCollaborationGateway(scene, { collaborationToken: adminToken }, options);
		expect(recovered).toMatchObject({ eventCount: 0, eventHistory: { healthy: true, recovery: expect.stringContaining("invalid JSON") } });
		expect(await readdir(join(directory, ".babylon-editor"))).toEqual(
			expect.arrayContaining([expect.stringMatching(/^remote-collaboration-events\.json\.corrupt-\d+\.json$/)])
		);
		await publishRemoteCollaborationOperation("get_test_value", true, null, options, "after recovery");
		expect((await getRemoteCollaborationGateway(scene, { collaborationToken: adminToken }, options)).eventCount).toBe(1);
	});

	test("enforces admin history controls, retention gaps, and explicit clearing", async () => {
		const { adminToken, viewerToken } = await bootstrap();
		await expect(setRemoteCollaborationEventHistory(scene, { retention: 100, collaborationToken: viewerToken }, options)).rejects.toThrow("admin role");
		await setRemoteCollaborationEventHistory(scene, { enabled: true, retention: 100, collaborationToken: adminToken }, options);
		for (let index = 0; index < 105; index++) {
			await publishRemoteCollaborationOperation("set_test_value", index % 2 === 0, null, options, `retained ${index}`);
		}
		const page = await listRemoteCollaborationEvents(scene, { collaborationToken: adminToken, afterSequence: 0, limit: 20, success: true }, options);
		expect(page).toMatchObject({ count: 20, hasMore: true, gap: true });
		expect(page.oldestSequence).toBeGreaterThan(1);
		await expect(clearRemoteCollaborationEventHistory(scene, { confirm: true, collaborationToken: viewerToken }, options)).rejects.toThrow("admin role");
		await expect(clearRemoteCollaborationEventHistory(scene, { confirm: false, collaborationToken: adminToken }, options)).rejects.toThrow("confirm must be true");
		const latestSequence = (await getRemoteCollaborationGateway(scene, { collaborationToken: adminToken }, options)).latestSequence;
		const cleared = await clearRemoteCollaborationEventHistory(scene, { confirm: true, collaborationToken: adminToken }, options);
		expect(cleared).toMatchObject({ eventCount: 0, latestSequence });
		await setRemoteCollaborationEventHistory(scene, { enabled: false, collaborationToken: adminToken }, options);
		await publishRemoteCollaborationOperation("set_test_value", true, null, options, "memory only");
		await shutdownRemoteCollaborationGateway();
		await initializeRemoteCollaborationGateway(editor, { get_test_value: async () => ({ value }) });
		expect(await getRemoteCollaborationGateway(scene, { collaborationToken: adminToken }, options)).toMatchObject({
			eventCount: 0,
			latestSequence: latestSequence + 1,
			eventHistory: { enabled: false, persistedEventCount: 0 },
		});
	});
});
