import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, pathExists, readJSON, remove, writeJSON } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { MeshBuilder, NullEngine, Observable, Scene, Vector3 } from "babylonjs";

import { getAssetTypeFromPath, queryAssetRegistry } from "../../src/mcp/assets/registry";
import {
	deletePhysicsContactHistory,
	getPhysicsContactHistory,
	listPhysicsContactHistories,
	readPhysicsContactHistoryAsset,
	savePhysicsContactHistory,
} from "../../src/mcp/physics/contact-history-assets";
import { getPhysicsContactHistoryReplay, startPhysicsContactHistoryReplay } from "../../src/mcp/physics/contact-history-replay";
import { startPhysicsContactCapture, stopPhysicsContactCapture } from "../../src/mcp/physics/contacts";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/physics contact history assets", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let observable: Observable<any>;
	let body: any;
	let options: any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-physics-contact-history-"));
		projectConfiguration.path = join(directory, "project.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
		const mesh = MeshBuilder.CreateBox("Body", {}, scene);
		body = {
			transformNode: mesh,
			_collisionCBEnabled: false,
			setCollisionCallbackEnabled(value: boolean) {
				this._collisionCBEnabled = value;
			},
		};
		(mesh as any).physicsAggregate = { body };
		observable = new Observable<any>();
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({ getPhysicsPlugin: () => ({ onCollisionObservable: observable }) } as any);
		options = {
			editor: {
				layout: { assets: { refresh: vi.fn() }, inspector: { forceUpdate: vi.fn() } },
				sceneWorkspace: { getSettings: () => ({ activeScene: "assets/main.scene" }) },
			},
		};
		startPhysicsContactCapture(scene, { maxEvents: 4, includeContinued: true }, options);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = null;
		await remove(directory);
	});

	function contact(impulse: number): void {
		observable.notifyObservers({
			collider: body,
			collidedAgainst: body,
			colliderIndex: 0,
			collidedAgainstIndex: 0,
			type: "COLLISION_STARTED",
			point: new Vector3(1, 2, 3),
			normal: Vector3.Up(),
			distance: -1,
			impulse,
		});
	}

	test("creates and exact-leased updates a detached active-capture snapshot", async () => {
		contact(3);
		const created = await savePhysicsContactHistory(scene, { path: "assets/captures/impact.physicscontacts.json", name: "Impact" }, options);
		expect(created).toMatchObject({ saved: true, created: true, assetRevision: 1, source: { target: "editor", scenePath: "assets/main.scene" }, summary: { eventCount: 1 } });
		contact(7);
		const updated = await savePhysicsContactHistory(scene, { path: created.path, expectedRevision: created.contentRevision, name: "Impact updated" }, options);
		expect(updated).toMatchObject({ saved: true, created: false, id: created.id, name: "Impact updated", assetRevision: 2, summary: { eventCount: 2, maximumImpulse: 7 } });
		const disk = await readPhysicsContactHistoryAsset(created.path);
		expect(disk.asset.events.map((event) => event.impulse)).toEqual([3, 7]);
		expect(await readJSON(join(directory, created.path))).toMatchObject({ version: 1, type: "babylon-editor-physics-contact-history", revision: 2 });
	});

	test("serializes concurrent updates so only one exact revision publishes", async () => {
		contact(1);
		const created = await savePhysicsContactHistory(scene, { path: "assets/concurrent.physicscontacts.json", name: "Concurrent" }, options);
		contact(2);
		const results = await Promise.allSettled([
			savePhysicsContactHistory(scene, { path: created.path, expectedRevision: created.contentRevision, name: "First" }, options),
			savePhysicsContactHistory(scene, { path: created.path, expectedRevision: created.contentRevision, name: "Second" }, options),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason.message).toContain("revision is stale");
		expect((await readPhysicsContactHistoryAsset(created.path)).asset.revision).toBe(2);

		const creates = await Promise.allSettled([
			savePhysicsContactHistory(scene, { path: "assets/create-race.physicscontacts.json", name: "Create A" }, options),
			savePhysicsContactHistory(scene, { path: "assets/create-race.physicscontacts.json", name: "Create B" }, options),
		]);
		expect(creates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(creates.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect((await readPhysicsContactHistoryAsset("assets/create-race.physicscontacts.json")).asset.revision).toBe(1);
	});

	test("rejects stale, revisioned creation, missing capture, and unsafe paths without mutation", async () => {
		contact(1);
		const created = await savePhysicsContactHistory(scene, { path: "assets/safe.physicscontacts.json", name: "Safe" }, options);
		await expect(savePhysicsContactHistory(scene, { path: created.path, expectedRevision: "0" }, options)).rejects.toThrow("revision is stale");
		await expect(savePhysicsContactHistory(scene, { path: "assets/new.physicscontacts.json", expectedRevision: "0", name: "New" }, options)).rejects.toThrow(
			"must not provide expectedRevision"
		);
		await expect(savePhysicsContactHistory(scene, { path: "../escape.physicscontacts.json", name: "Escape" }, options)).rejects.toThrow("stay inside");
		scene.dispose();
		await expect(savePhysicsContactHistory(scene, { path: "assets/stopped.physicscontacts.json", name: "Stopped" }, options)).rejects.toThrow(
			"No physics contact capture is active"
		);
		expect((await readPhysicsContactHistoryAsset(created.path)).asset.revision).toBe(1);
	});

	test("lists registry-classified assets and reads compound filters with bounded pagination", async () => {
		contact(2);
		const first = await savePhysicsContactHistory(scene, { path: "assets/first.physicscontacts.json", name: "First capture" }, options);
		contact(8);
		await savePhysicsContactHistory(scene, { path: "assets/second.physicscontacts.json", name: "Second capture" }, options);
		await writeJSON(join(directory, "assets", "broken.physicscontacts.json"), { version: 1, extra: true });
		expect(getAssetTypeFromPath(first.path)).toBe("physics-contact-history");
		expect((await queryAssetRegistry({ type: "physics-contact-history" })).entries.map((entry: { path: string }) => entry.path)).toEqual([
			"assets/first.physicscontacts.json",
			"assets/second.physicscontacts.json",
		]);

		const list = await listPhysicsContactHistories(scene, { search: "capture", offset: 1, limit: 1 });
		expect(list).toMatchObject({
			assets: [{ name: "Second capture" }],
			page: { total: 2, offset: 1, count: 1, hasMore: false },
			malformedCount: 1,
			errorsTruncated: false,
			truncated: false,
		});
		expect(list.errors).toEqual([expect.objectContaining({ path: "assets/broken.physicscontacts.json", error: expect.stringContaining("unknown fields") })]);
		await expect(listPhysicsContactHistories(scene, { search: 7 })).rejects.toThrow("search must be a string");

		const read = await getPhysicsContactHistory(scene, {
			path: "assets/second.physicscontacts.json",
			filter: { types: ["COLLISION_STARTED"], bodyNodeIds: [body.transformNode.id], minimumImpulse: 3 },
			offset: 0,
			limit: 1,
		});
		expect(read).toMatchObject({ matchedSummary: { eventCount: 1, maximumImpulse: 8 }, events: [{ impulse: 8 }], page: { total: 1, count: 1, hasMore: false } });
	});

	test("requires confirmation and an exact revision before deleting asset and sidecar", async () => {
		contact(4);
		const created = await savePhysicsContactHistory(scene, { path: "assets/delete.physicscontacts.json", name: "Delete" }, options);
		const sidecar = join(directory, `${created.path}.bjsmeta.json`);
		expect(await pathExists(sidecar)).toBe(true);
		await expect(deletePhysicsContactHistory(scene, { path: created.path, expectedRevision: "stale", confirm: true }, options)).rejects.toThrow("revision is stale");
		await expect(deletePhysicsContactHistory(scene, { path: created.path, expectedRevision: created.contentRevision }, options)).rejects.toThrow("requires confirm: true");
		stopPhysicsContactCapture(scene, {}, options);
		const replay = await startPhysicsContactHistoryReplay(
			scene,
			{ path: created.path, expectedRevision: created.contentRevision, cursorMs: created.durationMs, trailMs: created.durationMs },
			options
		);
		expect(replay).toMatchObject({ active: true, activeOverlayCount: 1 });
		expect(await deletePhysicsContactHistory(scene, { path: created.path, expectedRevision: created.contentRevision, confirm: true }, options)).toMatchObject({
			deleted: true,
			id: created.id,
			replayStopped: true,
			metadataDeleted: true,
		});
		expect(getPhysicsContactHistoryReplay(scene, {}, options)).toMatchObject({ active: false });
		expect(scene.meshes.filter((mesh) => mesh.name === "Physics Contact Replay")).toHaveLength(0);
		expect(await pathExists(join(directory, created.path))).toBe(false);
		expect(await pathExists(sidecar)).toBe(false);
		expect(await queryAssetRegistry({ type: "physics-contact-history" })).toMatchObject({ totalCount: 0, entries: [] });
		await expect(readPhysicsContactHistoryAsset(created.path)).rejects.toThrow("not found");
	});
});
