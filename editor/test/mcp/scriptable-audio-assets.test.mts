import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdir, mkdtemp, pathExists, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path";

import { createDefaultScriptableAudioGeneratorGraph, IScriptableAudioGeneratorGraph } from "babylonjs-editor-tools";

import { getIndexedAssetDependencies, queryAssetRegistry, refreshAssetRegistryPaths } from "../../src/mcp/assets/registry";
import { deleteScriptableAudioAsset, readScriptableAudioAsset, resolveScriptableAudioAssetPath, writeScriptableAudioAsset } from "../../src/mcp/assets/scriptable-audio-assets";
import { projectConfiguration } from "../../src/project/configuration";

function clipGraph(path: string): IScriptableAudioGeneratorGraph {
	return {
		...createDefaultScriptableAudioGeneratorGraph("Clip Generator"),
		sampleRate: 8_000,
		channels: 1,
		nodes: [
			{ id: "clip", name: "Clip", type: "audioClip", position: [80, 120], enabled: true, data: { path, loop: false, gain: 1 } },
			{ id: "output", name: "Output", type: "output", position: [420, 120], enabled: true, data: {} },
		],
		edges: [{ id: "clip-output", sourceNodeId: "clip", targetNodeId: "output", order: 0, gain: 1 }],
	};
}

describe("scriptable audio project assets", () => {
	let directory: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-scriptable-audio-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(directory, "assets"));
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("persists a canonical first-class asset and indexes exact runtime dependencies", async () => {
		const clipPath = join(directory, "assets", "tone.wav");
		await writeFile(clipPath, "tone-v1");
		const created = await writeScriptableAudioAsset("assets/tone.audio-generator.json", clipGraph("assets/tone.wav"));

		expect(created).toMatchObject({ path: "assets/tone.audio-generator.json", revision: 1, dependencies: [{ path: "assets/tone.wav", status: "current", sizeBytes: 7 }] });
		expect(created.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(created.runtimeFingerprint).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(await readFile(created.absolutePath, "utf-8"))).toMatchObject({ version: 1, revision: 1, name: "Clip Generator" });

		const indexed = await getIndexedAssetDependencies(created.path);
		expect(indexed).toMatchObject({
			type: "audio-generator",
			dependencies: ["assets/tone.wav"],
			missingDependencies: [],
			dependencyScanKind: "text",
			dependencyScanStatus: "complete",
			dependencyFingerprint: created.runtimeFingerprint,
			dependencyHashDeferred: false,
		});
		expect((await queryAssetRegistry({ type: "audio-generator" })).entries).toHaveLength(1);
	});

	test("invalidates the runtime fingerprint when only a nested clip changes", async () => {
		const clipPath = join(directory, "assets", "tone.wav");
		await writeFile(clipPath, "tone-v1");
		const created = await writeScriptableAudioAsset("assets/tone.audio-generator.json", clipGraph("assets/tone.wav"));
		const initialRuntimeFingerprint = created.runtimeFingerprint;

		await writeFile(clipPath, "tone-v2");
		await refreshAssetRegistryPaths([clipPath]);
		const current = await readScriptableAudioAsset(created.path);
		const indexed = await getIndexedAssetDependencies(created.path);

		expect(current.fingerprint).toBe(created.fingerprint);
		expect(current.runtimeFingerprint).not.toBe(initialRuntimeFingerprint);
		expect(indexed.dependencyFingerprint).toBe(current.runtimeFingerprint);
	});

	test("requires exact stale-write leases, increments revisions, and leaves invalid updates untouched", async () => {
		await writeFile(join(directory, "assets", "tone.wav"), "tone");
		const created = await writeScriptableAudioAsset("assets/tone.audio-generator.json", clipGraph("assets/tone.wav"));
		const renamed = { ...created.graph, name: "Renamed" };

		await expect(writeScriptableAudioAsset(created.path, renamed)).rejects.toThrow(/inspect it again/);
		await expect(writeScriptableAudioAsset(created.path, renamed, "0".repeat(64))).rejects.toThrow(created.fingerprint);
		const updated = await writeScriptableAudioAsset(created.path, renamed, created.fingerprint);
		expect(updated).toMatchObject({ revision: 2, graph: { revision: 2, name: "Renamed" } });

		await expect(writeScriptableAudioAsset(created.path, { ...updated.graph, nodes: [] }, updated.fingerprint)).rejects.toThrow(/1 through 128 nodes/);
		expect(await readScriptableAudioAsset(created.path)).toMatchObject({ fingerprint: updated.fingerprint, revision: 2, graph: { name: "Renamed" } });
		await expect(writeScriptableAudioAsset(created.path, renamed, created.fingerprint)).rejects.toThrow(/inspect it again/);
	});

	test("reports missing leaves and malformed graphs without inventing an exact runtime fingerprint", async () => {
		const missing = await writeScriptableAudioAsset("assets/missing.audio-generator.json", clipGraph("assets/not-there.wav"));
		expect(missing).toMatchObject({ runtimeFingerprint: null, dependencies: [{ path: "assets/not-there.wav", status: "missing" }] });
		expect(await getIndexedAssetDependencies(missing.path)).toMatchObject({ missingDependencies: ["assets/not-there.wav"], dependencyFingerprint: null });

		const malformedPath = join(directory, "assets", "broken.audio-generator.json");
		await writeFile(malformedPath, JSON.stringify({ version: 1, nodes: [] }));
		await refreshAssetRegistryPaths([malformedPath]);
		expect(await getIndexedAssetDependencies("assets/broken.audio-generator.json")).toMatchObject({
			type: "audio-generator",
			dependencyScanStatus: "malformed",
			dependencyFingerprint: null,
			dependencies: [],
		});
		await expect(readScriptableAudioAsset("assets/broken.audio-generator.json")).rejects.toThrow(/streaming|nodes and edges/);
	});

	test("rejects traversal, wrong suffixes, backslashes, and missing parent directories before writing", async () => {
		expect(() => resolveScriptableAudioAssetPath("../escape.audio-generator.json")).toThrow(/inside the open project/);
		expect(() => resolveScriptableAudioAssetPath("assets/tone.json")).toThrow(/must end with/);
		expect(() => resolveScriptableAudioAssetPath("assets\\tone.audio-generator.json")).toThrow(/forward slashes/);
		await expect(writeScriptableAudioAsset("assets/missing/folder/tone.audio-generator.json", createDefaultScriptableAudioGeneratorGraph())).rejects.toThrow(
			/parent directory must already exist/
		);
	});

	test("deletes only under an exact fingerprint lease and removes the indexed asset", async () => {
		const created = await writeScriptableAudioAsset("assets/delete.audio-generator.json", createDefaultScriptableAudioGeneratorGraph());
		await expect(deleteScriptableAudioAsset(created.path, "0".repeat(64))).rejects.toThrow(created.fingerprint);
		expect(await pathExists(created.absolutePath)).toBe(true);
		expect(await deleteScriptableAudioAsset(created.path, created.fingerprint)).toEqual({
			path: created.path,
			revision: 1,
			fingerprint: created.fingerprint,
			deleted: true,
		});
		expect(await pathExists(created.absolutePath)).toBe(false);
		expect((await queryAssetRegistry({ type: "audio-generator" })).entries).toEqual([]);
	});
});
