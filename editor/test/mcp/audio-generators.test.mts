import { mkdir, mkdtemp, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { NullEngine, Scene } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { projectConfiguration } from "../../src/project/configuration";
import {
	createAudioGenerator,
	deleteAudioGenerator,
	getAudioGenerator,
	listAudioGenerators,
	listAudioGeneratorTypes,
	setAudioGenerator,
	validateAudioGenerator,
} from "../../src/mcp/sounds/audio-generators";
import { listSoundAssets } from "../../src/mcp/sounds/sounds";

describe("Audio Generator MCP actions", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-audio-generator-mcp-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("exposes types and an exact CRUD/validate lifecycle", async () => {
		const types = listAudioGeneratorTypes();
		expect(types).toMatchObject({ version: 1, limits: { maximumNodes: 128 } });
		expect(types.types.map((type: any) => type.id)).toEqual(expect.arrayContaining(["audioClip", "oscillator", "output"]));

		const created = await createAudioGenerator(scene, { path: "assets/score.audio-generator.json", name: "Score" });
		expect(created).toMatchObject({ path: "assets/score.audio-generator.json", revision: 1, graph: { name: "Score" }, buildReady: true });
		expect(created).not.toHaveProperty("absolutePath");
		expect(await listSoundAssets()).toMatchObject({ assets: [{ path: created.path, type: "audio-generator" }] });
		expect(await listAudioGenerators(scene)).toMatchObject({ totalCount: 1, generators: [{ path: created.path, runtimeFingerprint: created.runtimeFingerprint }] });
		expect(await validateAudioGenerator(scene, { path: created.path })).toMatchObject({ valid: true, fingerprint: created.fingerprint });

		const changedGraph = { ...created.graph, name: "Updated Score" };
		await expect(setAudioGenerator(scene, { path: created.path, expectedFingerprint: "0".repeat(64), graph: changedGraph })).rejects.toThrow(created.fingerprint);
		const updated = await setAudioGenerator(scene, { path: created.path, expectedFingerprint: created.fingerprint, graph: changedGraph });
		expect(updated).toMatchObject({ revision: 2, graph: { revision: 2, name: "Updated Score" } });
		expect(await getAudioGenerator(scene, { path: created.path })).toMatchObject({ fingerprint: updated.fingerprint });

		await expect(deleteAudioGenerator(scene, { path: created.path, expectedFingerprint: created.fingerprint })).rejects.toThrow(updated.fingerprint);
		expect(await deleteAudioGenerator(scene, { path: created.path, expectedFingerprint: updated.fingerprint })).toMatchObject({ deleted: true, revision: 2 });
		expect(await listAudioGenerators(scene)).toMatchObject({ totalCount: 0, generators: [] });
	});

	test("returns candidate validation errors without persisting malformed graphs", async () => {
		const result = await validateAudioGenerator(scene, { graph: { version: 1, nodes: [] } });
		expect(result).toMatchObject({ valid: false });
		expect(result.errors[0]).toMatch(/nodes and edges|streaming/);
	});
});
