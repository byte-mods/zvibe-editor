import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureDir, mkdtemp, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";
import { NullEngine, Scene } from "babylonjs";

import {
	authorizeProjectCollaborationRequest,
	configureProjectCollaboration,
	createProjectCollaborationMember,
	deleteProjectCollaborationMember,
	getProjectCollaborationStatus,
	heartbeatProjectCollaborationSession,
	joinProjectCollaborationSession,
	leaveProjectCollaborationSession,
	listProjectCollaborationMembers,
	listProjectCollaborationPresence,
	setProjectCollaborationMember,
} from "../../src/mcp/project/collaboration";

describe("mcp/project/collaboration", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { state: { projectPath: "" } } } as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-collaboration-"));
		options.editor.state.projectPath = join(directory, "Game.bjseditor");
		await writeJSON(options.editor.state.projectPath, {});
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		await remove(directory);
	});

	async function bootstrapAdmin(): Promise<{ memberId: string; accessKey: string; token: string }> {
		const configured = await configureProjectCollaboration(scene, { enabled: true, bootstrapAdminName: "Owner" }, options);
		const joined = await joinProjectCollaborationSession(
			scene,
			{ memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, clientName: "Admin Test" },
			options
		);
		return { memberId: configured.bootstrap.member.id, accessKey: configured.bootstrap.accessKey, token: joined.session.token };
	}

	test("keeps legacy access until enabled, then centrally enforces admin/editor/viewer roles", async () => {
		await expect(authorizeProjectCollaborationRequest("create_primitive_mesh", {}, options)).resolves.toBeUndefined();
		const admin = await bootstrapAdmin();
		await expect(authorizeProjectCollaborationRequest("get_project_collaboration_capabilities", {}, options)).resolves.toBeUndefined();
		await expect(authorizeProjectCollaborationRequest("validate_project_collaboration_readiness", {}, options)).resolves.toBeUndefined();
		await expect(authorizeProjectCollaborationRequest("create_primitive_mesh", { collaborationToken: admin.token }, options)).resolves.toBeUndefined();

		const viewer = await createProjectCollaborationMember(scene, { name: "Reviewer", role: "viewer", collaborationToken: admin.token }, options);
		const viewerSession = await joinProjectCollaborationSession(
			scene,
			{ memberId: viewer.member.id, accessKey: viewer.accessKey, clientName: "Review Client", state: "inspecting scene" },
			options
		);
		await expect(authorizeProjectCollaborationRequest("get_scene_hierarchy", { collaborationToken: viewerSession.session.token }, options)).resolves.toBeUndefined();
		await expect(authorizeProjectCollaborationRequest("list_assets", { collaborationToken: viewerSession.session.token }, options)).resolves.toBeUndefined();
		await expect(authorizeProjectCollaborationRequest("create_primitive_mesh", { collaborationToken: viewerSession.session.token }, options)).rejects.toThrow(
			"viewer cannot call mutating endpoint"
		);
		await expect(authorizeProjectCollaborationRequest("execute_batch", { collaborationToken: viewerSession.session.token }, options)).rejects.toThrow("viewer cannot call");

		await setProjectCollaborationMember(scene, { id: viewer.member.id, role: "editor", collaborationToken: admin.token }, options);
		await expect(authorizeProjectCollaborationRequest("create_primitive_mesh", { collaborationToken: viewerSession.session.token }, options)).resolves.toBeUndefined();
	});

	test("tracks bounded presence heartbeats and rejects expired or left sessions", async () => {
		const admin = await bootstrapAdmin();
		const heartbeat = await heartbeatProjectCollaborationSession(scene, { collaborationToken: admin.token, state: "editing terrain", ttlSeconds: 60 }, options);
		expect(heartbeat.session).toMatchObject({ memberName: "Owner", role: "admin", clientName: "Admin Test", state: "editing terrain" });
		expect((await listProjectCollaborationPresence(scene, { collaborationToken: admin.token }, options)).presence).toHaveLength(1);

		const storePath = join(directory, ".babylon-editor", "collaboration.json");
		const store = await readJSON(storePath);
		store.sessions[0].expiresAt = new Date(Date.now() - 1000).toISOString();
		await writeJSON(storePath, store);
		await expect(authorizeProjectCollaborationRequest("get_scene_hierarchy", { collaborationToken: admin.token }, options)).rejects.toThrow("missing or expired");

		const rejoined = await joinProjectCollaborationSession(scene, { memberId: admin.memberId, accessKey: admin.accessKey, clientName: "Rejoined" }, options);
		expect(await leaveProjectCollaborationSession(scene, { collaborationToken: rejoined.session.token }, options)).toMatchObject({ left: true });
		await expect(heartbeatProjectCollaborationSession(scene, { collaborationToken: rejoined.session.token }, options)).rejects.toThrow("missing or expired");
	});

	test("tracks bounded rich multi-viewport presence while preserving legacy cursor clients", async () => {
		const admin = await bootstrapAdmin();
		const rich = await heartbeatProjectCollaborationSession(
			scene,
			{
				collaborationToken: admin.token,
				state: "painting terrain",
				color: "#12abef",
				toolMode: "terrain",
				selectionNodeIds: ["terrain", "tree"],
				primarySelectionNodeId: "terrain",
				hoveredNodeId: "tree",
				pointers: [
					{ id: "mouse", viewport: "scene", x: 0.25, y: 0.75, pointerType: "mouse", buttons: 1, pressure: 0.5, worldPosition: [1, 2, 3] },
					{ id: "pen", viewport: "material", x: 0.5, y: 0.4, pointerType: "pen", pressure: 0.8, worldRay: { origin: [0, 1, 2], direction: [0, 0, -1], length: 500 } },
				],
				camera: { viewport: "scene", position: [10, 20, 30], target: [0, 0, 0], up: [0, 1, 0], fovDegrees: 60 },
			},
			options
		);
		expect(rich.session).toMatchObject({
			color: "#12ABEF",
			toolMode: "terrain",
			selectionNodeIds: ["terrain", "tree"],
			primarySelectionNodeId: "terrain",
			hoveredNodeId: "tree",
			pointers: [
				expect.objectContaining({ id: "mouse", worldPosition: [1, 2, 3] }),
				expect.objectContaining({ id: "pen", worldRay: { origin: [0, 1, 2], direction: [0, 0, -1], length: 500 } }),
			],
			camera: expect.objectContaining({ position: [10, 20, 30], fovDegrees: 60 }),
		});

		const legacy = await heartbeatProjectCollaborationSession(scene, { collaborationToken: admin.token, cursor: { x: 0.1, y: 0.2, viewport: "preview" } }, options);
		expect(legacy.session).toMatchObject({
			cursor: { x: 0.1, y: 0.2, viewport: "preview" },
			pointers: [expect.objectContaining({ id: "legacy", viewport: "preview", x: 0.1, y: 0.2 })],
		});

		await expect(
			heartbeatProjectCollaborationSession(scene, { collaborationToken: admin.token, selectionNodeIds: ["tree"], primarySelectionNodeId: "terrain" }, options)
		).rejects.toThrow("must be included");
		await expect(
			heartbeatProjectCollaborationSession(
				scene,
				{ collaborationToken: admin.token, pointers: [{ id: "ray", viewport: "scene", x: 0.5, y: 0.5, worldRay: { origin: [0, 0, 0], direction: [0, 0, 0] } }] },
				options
			)
		).rejects.toThrow("non-zero");
		await expect(heartbeatProjectCollaborationSession(scene, { collaborationToken: admin.token, color: "red" }, options)).rejects.toThrow("#RRGGBB");
		await expect(
			heartbeatProjectCollaborationSession(scene, { collaborationToken: admin.token, camera: { position: [0, 0, 0], target: [0, 0, 1], fovDegrees: 180 } }, options)
		).rejects.toThrow("1 through 179");

		const cleared = await heartbeatProjectCollaborationSession(
			scene,
			{ collaborationToken: admin.token, selectionNodeIds: [], primarySelectionNodeId: null, hoveredNodeId: null, pointers: [], camera: null },
			options
		);
		expect(cleared.session).toMatchObject({ selectionNodeIds: [], primarySelectionNodeId: null, hoveredNodeId: null, pointers: [], camera: null });
	});

	test("protects admin invariants, rotates credentials, and redacts all stored secrets", async () => {
		const admin = await bootstrapAdmin();
		const editor = await createProjectCollaborationMember(scene, { name: "Builder", role: "editor", collaborationToken: admin.token }, options);
		const editorSession = await joinProjectCollaborationSession(scene, { memberId: editor.member.id, accessKey: editor.accessKey, clientName: "Builder CLI" }, options);
		await expect(setProjectCollaborationMember(scene, { id: admin.memberId, role: "viewer", collaborationToken: admin.token }, options)).rejects.toThrow("last enabled");
		await expect(deleteProjectCollaborationMember(scene, { id: admin.memberId, collaborationToken: admin.token }, options)).rejects.toThrow("own active");

		const rotated = await setProjectCollaborationMember(scene, { id: editor.member.id, rotateAccessKey: true, collaborationToken: admin.token }, options);
		expect(rotated.accessKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
		await expect(authorizeProjectCollaborationRequest("get_scene_hierarchy", { collaborationToken: editorSession.session.token }, options)).rejects.toThrow(
			"missing or expired"
		);
		const members = await listProjectCollaborationMembers(scene, { collaborationToken: admin.token }, options);
		expect(JSON.stringify(members)).not.toContain("accessKeyHash");
		expect(JSON.stringify(await getProjectCollaborationStatus(scene, { collaborationToken: admin.token }, options))).not.toContain(admin.token);
	});

	test("serializes concurrent member creation and rejects malformed persisted stores", async () => {
		const admin = await bootstrapAdmin();
		const created = await Promise.all([
			createProjectCollaborationMember(scene, { name: "One", role: "editor", collaborationToken: admin.token }, options),
			createProjectCollaborationMember(scene, { name: "Two", role: "viewer", collaborationToken: admin.token }, options),
		]);
		expect(created).toHaveLength(2);
		expect((await listProjectCollaborationMembers(scene, { collaborationToken: admin.token }, options)).members).toHaveLength(3);

		await ensureDir(join(directory, ".babylon-editor"));
		await writeFile(join(directory, ".babylon-editor", "collaboration.json"), "{broken", "utf-8");
		await expect(getProjectCollaborationStatus(scene, {}, options)).rejects.toThrow("invalid JSON");
	});
});
