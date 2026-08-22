import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { mkdir, mkdtemp, pathExists, readFile, remove, writeFile } from "fs-extra";
import { NullEngine, Scene, SceneSerializer, TransformNode } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { convertAlembicFileToCache } from "babylonjs-editor-cli";
import { getDefaultAssetImporterConfiguration, parseAlembicCache } from "babylonjs-editor-tools";

import { createAlembicTestCache, rewriteAlembicManifest } from "../../../tools/test/assets/alembic-fixture";
import {
	configureEditorAlembicPlayers,
	controlAlembicPlayer,
	deleteAlembicPlayer,
	getAlembicCapabilities,
	getAlembicPlayerState,
	inspectAlembicImport,
	instantiateAlembicAsset,
	listAlembicPlayers,
	setAlembicPlayer,
} from "../../src/mcp/assets/alembic";
import { applyAlembicImporterArtifact, getAlembicImporterArtifactStatus } from "../../src/mcp/assets/alembic-importer";
import { getAssetTypeFromPath, readAssetMetadata } from "../../src/mcp/assets/registry";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { projectConfiguration } from "../../src/project/configuration";

vi.mock("babylonjs-editor-cli", () => ({ convertAlembicFileToCache: vi.fn() }));

describe("Alembic importer and editor lifecycle", () => {
	let directory: string;
	let sourcePath: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	async function exactConversion(path: string): Promise<any> {
		const source = await readFile(path);
		const fixture = createAlembicTestCache();
		const content = rewriteAlembicManifest(fixture.bytes, (manifest) => {
			manifest.source.name = basename(path);
			manifest.source.bytes = source.byteLength;
			manifest.source.sha256 = createHash("sha256").update(source).digest("hex");
		});
		return {
			content,
			manifest: parseAlembicCache(content).manifest,
			executable: "/mock/blender",
			outputBytes: content.byteLength,
			stdout: "mock conversion complete",
			stderr: "",
		};
	}

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-alembic-editor-"));
		await mkdir(join(directory, "assets", "caches"), { recursive: true });
		sourcePath = join(directory, "assets", "caches", "complex.abc");
		await writeFile(sourcePath, Buffer.from("real-alembic-source-for-editor-test"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await readAssetMetadata(sourcePath);
		vi.mocked(convertAlembicFileToCache).mockImplementation(exactConversion);
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					assets: { refresh: vi.fn() },
					graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
				},
			},
		};
	});

	afterEach(async () => {
		vi.mocked(convertAlembicFileToCache).mockReset();
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("registers the importer, asset type, capabilities, and all nine shared endpoints", () => {
		expect(getDefaultAssetImporterConfiguration(sourcePath).kind).toBe("alembic");
		expect(getAssetTypeFromPath(sourcePath)).toBe("alembic");
		expect(getAlembicCapabilities()).toMatchObject({ format: "zvibe-alembic-cache", objectKinds: ["mesh", "points", "curves", "camera"], runtimeDependency: "none" });
		for (const endpoint of [
			"get_alembic_capabilities",
			"inspect_alembic_import",
			"apply_alembic_import",
			"instantiate_alembic_asset",
			"list_alembic_players",
			"get_alembic_player",
			"set_alembic_player",
			"control_alembic_player",
			"delete_alembic_player",
		]) {
			expect(MCPEndpoints[endpoint]).toBeTypeOf("function");
		}
	});

	test("leases and atomically publishes only output tied to the exact source and settings", async () => {
		const planned = await getAlembicImporterArtifactStatus(sourcePath);
		expect(planned).toMatchObject({ current: false, exists: false, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
		const applied = await applyAlembicImporterArtifact(sourcePath, planned.fingerprint);
		expect(applied).toMatchObject({ current: true, result: { outputBytes: expect.any(Number), cacheSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
		expect(await pathExists(applied.result!.outputPath)).toBe(true);
		expect(parseAlembicCache(new Uint8Array(await readFile(applied.result!.outputPath))).manifest.source.sha256).toBe(
			createHash("sha256")
				.update(await readFile(sourcePath))
				.digest("hex")
		);
		await writeFile(sourcePath, Buffer.from("changed-source"));
		expect(await getAlembicImporterArtifactStatus(sourcePath)).toMatchObject({ current: false, exists: true, result: null });
		await expect(applyAlembicImporterArtifact(sourcePath, planned.fingerprint)).rejects.toThrow(/plan changed/i);
	});

	test("rejects converter evidence that is unrelated to the source and publishes no partial artifact", async () => {
		const planned = await getAlembicImporterArtifactStatus(sourcePath);
		const unrelated = createAlembicTestCache();
		vi.mocked(convertAlembicFileToCache).mockResolvedValue({
			content: unrelated.bytes,
			manifest: unrelated.manifest,
			executable: "/mock/blender",
			outputBytes: unrelated.bytes.byteLength,
			stdout: "",
			stderr: "",
		});
		await expect(applyAlembicImporterArtifact(sourcePath, planned.fingerprint)).rejects.toThrow(/does not match the exact source bytes/i);
		const status = await getAlembicImporterArtifactStatus(sourcePath);
		expect(status).toMatchObject({ current: false, exists: false, result: null });
	});

	test("instantiates, renames by id and current name, controls, serializes, rebinds, and deletes a complex cache", async () => {
		const planned = await getAlembicImporterArtifactStatus(sourcePath);
		await applyAlembicImporterArtifact(sourcePath, planned.fingerprint);
		const inspected = await inspectAlembicImport(scene, { path: "assets/caches/complex.abc" });
		expect(inspected).toMatchObject({ current: true, result: { manifest: { sampleCount: 3, objects: expect.any(Array) } } });
		const parent = new TransformNode("Parent", scene);
		const created = await instantiateAlembicAsset(
			scene,
			{ path: "assets/caches/complex.abc", id: "editor-cache", name: "Original", parentId: parent.id, position: [10, 20, 30], playOnAwake: false },
			options
		);
		expect(created).toMatchObject({ configuration: { id: "editor-cache", name: "Original", revision: 1 }, state: { objectCount: 4 }, cache: { sampleCount: 3 } });
		expect(scene.getTransformNodeById("editor-cache")?.parent).toBe(parent);
		expect(listAlembicPlayers(scene).players).toHaveLength(1);
		expect(getAlembicPlayerState(scene, { name: "Original" }).configuration.id).toBe("editor-cache");
		await expect(setAlembicPlayer(scene, { id: "editor-cache", expectedRevision: 2, speed: 2 }, options)).rejects.toThrow(/revision changed/i);
		const renamed = await setAlembicPlayer(scene, { id: "editor-cache", expectedRevision: 1, name: "Renamed", speed: -2, interpolation: "hold" }, options);
		expect(renamed.configuration).toMatchObject({ name: "Renamed", speed: -2, interpolation: "hold", revision: 2 });
		const renamedAgain = await setAlembicPlayer(scene, { currentName: "Renamed", expectedRevision: 2, name: "Final Name", pointSize: 8 }, options);
		expect(renamedAgain.configuration).toMatchObject({ name: "Final Name", pointSize: 8, revision: 3 });
		const sought = await controlAlembicPlayer(scene, { id: "editor-cache", action: "seek", timeSeconds: 0.75 }, options);
		expect(sought.state).toMatchObject({ currentTimeSeconds: 0.75, currentFrame: 1, nextFrame: 2 });
		const serialized = SceneSerializer.Serialize(scene);
		expect(JSON.stringify(serialized)).toContain("babylonEditorAlembicPlayer");

		const live = listAlembicPlayers(scene).players[0];
		const runtime = (scene as any).alembicPlayers.get(live.configuration.id);
		runtime.dispose(false);
		expect(listAlembicPlayers(scene).players).toHaveLength(0);
		expect(await configureEditorAlembicPlayers(scene)).toEqual({ configured: 1, errors: [] });
		expect(listAlembicPlayers(scene).players).toHaveLength(1);
		expect(() => deleteAlembicPlayer(scene, { id: "editor-cache", confirm: false }, options)).toThrow(/confirm=true/i);
		expect(deleteAlembicPlayer(scene, { id: "editor-cache", confirm: true }, options)).toEqual({ deleted: true, id: "editor-cache" });
		expect(listAlembicPlayers(scene).players).toHaveLength(0);
	});

	test("rejects traversal and reports stale artifacts during serialized-root recovery", async () => {
		await expect(inspectAlembicImport(scene, { path: "../outside.abc" })).rejects.toThrow(/inside the open project/i);
		const planned = await getAlembicImporterArtifactStatus(sourcePath);
		await applyAlembicImporterArtifact(sourcePath, planned.fingerprint);
		await instantiateAlembicAsset(scene, { path: "assets/caches/complex.abc", id: "stale-cache", playOnAwake: false }, options);
		(scene as any).alembicPlayers.get("stale-cache").dispose(false);
		await writeFile(sourcePath, Buffer.from("changed-after-instantiation"));
		const rebound = await configureEditorAlembicPlayers(scene);
		expect(rebound).toMatchObject({ configured: 0, errors: [{ id: "stale-cache", message: expect.stringMatching(/missing or stale/i) }] });
	});
});
