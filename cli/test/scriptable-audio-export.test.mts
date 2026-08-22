import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import fs from "fs-extra";
import { afterEach, describe, expect, test } from "vitest";
import { normalizeScriptableAudioGeneratorGraph } from "babylonjs-editor-tools";

import { processAssetFile } from "../src/pack/assets/process.mjs";
import { createAssets } from "../src/pack/assets/assets.mjs";

function graph(path: string): Record<string, unknown> {
	return {
		version: 1,
		revision: 1,
		name: "CLI Generator",
		sampleRate: 48000,
		channels: 1,
		durationSeconds: 0.1,
		streaming: false,
		seed: 7,
		outputNodeId: "output",
		nodes: [
			{ id: "clip", name: "Clip", type: "audioClip", position: [0, 0], enabled: true, data: { path, loop: false, gain: 1, startSeconds: 0 } },
			{ id: "output", name: "Output", type: "output", position: [300, 0], enabled: true, data: {} },
		],
		edges: [{ id: "clip-output", sourceNodeId: "clip", targetNodeId: "output", order: 0, gain: 1 }],
	};
}

describe("CLI Scriptable Audio export", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function setup(): Promise<{ root: string; assets: string; publicDir: string; options: any }> {
		const root = await mkdtemp(join(tmpdir(), "zvibe-cli-audio-generator-"));
		roots.push(root);
		const assets = join(root, "assets");
		const publicDir = join(root, "public", "scene");
		await fs.ensureDir(assets);
		await fs.ensureDir(join(publicDir, "assets"));
		return {
			root,
			assets,
			publicDir,
			options: {
				projectDir: root,
				publicDir,
				baseAssetsDir: assets,
				outputAssetsDir: join(publicDir, "assets"),
				optimize: false,
				exportedAssets: [],
				cache: {},
				compressedTexturesEnabled: false,
			},
		};
	}

	test("exports a canonical graph and invalidates its cache from exact clip bytes", async () => {
		const { assets, publicDir, options } = await setup();
		const clip = join(assets, "tone.wav");
		const source = join(assets, "music.audio-generator.json");
		await fs.writeFile(clip, Buffer.from([1, 2, 3, 4]));
		await fs.writeFile(source, JSON.stringify(graph("assets/tone.wav")));
		await processAssetFile(source, options);
		const output = join(publicDir, "assets", "music.audio-generator.json");
		expect(JSON.parse(await fs.readFile(output, "utf-8"))).toEqual(normalizeScriptableAudioGeneratorGraph(graph("assets/tone.wav")));
		expect((await fs.readFile(output, "utf-8")).startsWith('{\n\t"version"')).toBe(true);
		expect(options.exportedAssets).toEqual([output]);
		const first = options.cache["assets/music.audio-generator.json"];
		await fs.writeFile(clip, Buffer.from([1, 2, 3, 5]));
		await processAssetFile(source, { ...options, exportedAssets: [] });
		expect(options.cache["assets/music.audio-generator.json"]).not.toBe(first);
	});

	test("rejects missing and excluded clip dependencies", async () => {
		const { assets, options } = await setup();
		const source = join(assets, "blocked.audio-generator.json");
		await fs.writeFile(source, JSON.stringify(graph("assets/missing.wav")));
		await expect(processAssetFile(source, options)).rejects.toThrow(/missing from the build asset scope/);

		const clip = join(assets, "missing.wav");
		await fs.writeFile(clip, Buffer.from([1, 2, 3]));
		await fs.writeJSON(`${clip}.bjsmeta.json`, { importer: { version: 1, kind: "audio", settings: { includeInBuild: false } } });
		await expect(processAssetFile(source, options)).rejects.toThrow(/excluded from the build/);
	});

	test("propagates dependency validation failures from the concurrent asset packer", async () => {
		const { assets, options } = await setup();
		await fs.writeFile(join(assets, "blocked.audio-generator.json"), JSON.stringify(graph("assets/missing.wav")));
		await expect(createAssets(options)).rejects.toThrow(/missing from the build asset scope/);
	});
});
