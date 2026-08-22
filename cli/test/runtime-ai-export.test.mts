import { tmpdir } from "node:os";
import { join } from "node:path/posix";

import { ensureDir, mkdtemp, pathExists, readFile, readJSON, remove, writeFile, writeJSON } from "fs-extra";
import { onnx } from "onnx-proto";
import { afterEach, describe, expect, test } from "vitest";

import { getDefaultAssetImporterConfiguration } from "babylonjs-editor-tools";

import { processAssetFile, supportedExtensions } from "../src/pack/assets/process.mjs";

const liteRtModel = Buffer.from(
	"HAAAAFRGTDMUACAAHAAYABQAEAAMAAAACAAEABQAAAAcAAAAHAAAAHQAAAAgAQAAMAEAAHQCAAADAAAAAAAAAAIAAAA0AAAABAAAANz///8FAAAABAAAABMAAABDT05WRVJTSU9OX01FVEFEQVRBAAgADAAIAAQACAAAAAQAAAAEAAAAEwAAAG1pbl9ydW50aW1lX3ZlcnNpb24ABgAAAKgAAACgAAAAmAAAAJAAAABwAAAABAAAAJ7///8EAAAAVAAAAAwAAAAIAA4ACAAEAAgAAAAQAAAAJAAAAAAABgAIAAQABgAAAAQAAAAAAAAAAAAKABAADAAIAAQACgAAAAMAAAACAAAABAAAAAYAAAAyLjE2LjEAAAAABgAIAAQABgAAAAQAAAAQAAAAMS41LjAAAAAAAAAAAAAAAIz+//+Q/v//lP7//5j+//8PAAAATUxJUiBDb252ZXJ0ZWQuAAEAAAAUAAAAAAAOABgAFAAQAAwACAAEAA4AAAAUAAAAHAAAAFwAAABgAAAAaAAAAAQAAABtYWluAAAAAAEAAAAUAAAAAAAOABQAAAAQAAwACwAEAA4AAAAQAAAAAAAACwwAAAAQAAAAGP///wEAAAACAAAAAgAAAAAAAAABAAAAAQAAAAIAAAACAAAAAAAAAAEAAAADAAAAhAAAADwAAAAEAAAAnv///wAAAAEQAAAAEAAAAAMAAAAYAAAAbP///wgAAABJZGVudGl0eQAAAAABAAAABwAAANL///8AAAABEAAAABAAAAACAAAAEAAAAKD///8BAAAAeQAAAAEAAAAHAAAAAAAWABgAFAAAABAADAAIAAAAAAAAAAcAFgAAAAAAAAEQAAAAEAAAAAEAAAAQAAAA5P///wEAAAB4AAAAAQAAAAEAAAABAAAACAAAAAQABAAEAAAA",
	"base64"
);

function onnxExternalModel(): Buffer {
	const model = onnx.ModelProto.create({
		irVersion: 8,
		producerName: "Zvibe CLI test",
		opsetImport: [{ domain: "", version: 18 }],
		graph: {
			name: "External weights",
			input: [{ name: "input", type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: 1 }] } } } }],
			output: [{ name: "output", type: { tensorType: { elemType: 1, shape: { dim: [{ dimValue: 1 }] } } } }],
			node: [{ name: "Add", opType: "Add", input: ["input", "weight"], output: ["output"] }],
			initializer: [
				{
					name: "weight",
					dataType: 1,
					dims: [1],
					dataLocation: 1,
					externalData: [{ key: "location", value: "weights/weight.bin" }],
				},
			],
		},
	});
	const verification = onnx.ModelProto.verify(model);
	if (verification) throw new Error(verification);
	return Buffer.from(onnx.ModelProto.encode(model).finish());
}

describe("CLI Runtime AI model export", () => {
	const directories: string[] = [];

	afterEach(async () => {
		await Promise.all(directories.splice(0).map((directory) => remove(directory)));
	});

	test("exports ONNX companions, LiteRT runtime, and PT2 byte-exactly; repairs tampering and removes excluded owned outputs", async () => {
		const project = await mkdtemp(join(tmpdir(), "zvibe-cli-runtime-ai-"));
		directories.push(project);
		const assets = join(project, "assets", "models");
		const publicDir = join(project, "public", "scene");
		await ensureDir(join(assets, "weights"));
		const sources = {
			onnx: { path: join(assets, "external.onnx"), bytes: onnxExternalModel(), format: "onnx" },
			sharedOnnx: { path: join(assets, "shared.onnx"), bytes: onnxExternalModel(), format: "onnx" },
			litert: { path: join(assets, "identity.tflite"), bytes: liteRtModel, format: "litert" },
			pytorchExport: { path: join(assets, "network.pt2"), bytes: Buffer.from("PK\x03\x04bounded-pytorch-export"), format: "pytorchExport" },
		} as const;
		const weights = Buffer.from(new Float32Array([2.5]).buffer);
		await writeFile(join(assets, "weights", "weight.bin"), weights);
		for (const [index, source] of Object.values(sources).entries()) {
			await writeFile(source.path, source.bytes);
			await writeJSON(`${source.path}.bjsmeta.json`, { version: 1, guid: `runtime-ai-${index}`, importer: getDefaultAssetImporterConfiguration(source.path) });
		}
		const exportedAssets: string[] = [];
		const cache: Record<string, string> = {};
		const options = {
			projectDir: project,
			publicDir,
			baseAssetsDir: join(project, "assets"),
			outputAssetsDir: join(publicDir, "assets"),
			optimize: false,
			exportedAssets,
			cache,
			compressedTexturesEnabled: false,
		};

		expect(supportedExtensions).toEqual(expect.arrayContaining([".onnx", ".tflite", ".pt2"]));
		for (const source of Object.values(sources)) await processAssetFile(source.path, options);

		for (const source of Object.values(sources)) {
			const output = join(publicDir, source.path.slice(project.length + 1));
			expect(await readFile(output)).toEqual(source.bytes);
			const manifest = await readJSON(`${output}.bjsai.json`);
			expect(manifest).toMatchObject({ version: 3, format: source.format, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
			expect(exportedAssets).toEqual(expect.arrayContaining([output, `${output}.bjsai.json`]));
		}
		const onnxOutput = join(publicDir, "assets", "models", "external.onnx");
		const weightOutput = join(publicDir, "assets", "models", "weights", "weight.bin");
		expect(await readFile(weightOutput)).toEqual(weights);
		expect(await readJSON(`${onnxOutput}.bjsai.json`)).toMatchObject({ externalData: [{ path: "weights/weight.bin", bytes: weights.length }], runtimeFiles: [] });

		const liteRtOutput = join(publicDir, "assets", "models", "identity.tflite");
		const liteRtManifest = await readJSON(`${liteRtOutput}.bjsai.json`);
		expect(liteRtManifest.runtimeFiles.length).toBeGreaterThan(0);
		for (const runtimeFile of liteRtManifest.runtimeFiles) {
			expect(await pathExists(join(publicDir, runtimeFile.path))).toBe(true);
			expect(runtimeFile).toMatchObject({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
		}

		await writeFile(weightOutput, Buffer.from("tampered"));
		await processAssetFile(sources.onnx.path, { ...options, exportedAssets: [] });
		expect(await readFile(weightOutput)).toEqual(weights);
		const runtimeFile = liteRtManifest.runtimeFiles[0];
		await writeFile(join(publicDir, runtimeFile.path), Buffer.from("tampered"));
		await processAssetFile(sources.litert.path, { ...options, exportedAssets: [] });
		expect((await readFile(join(publicDir, runtimeFile.path))).length).toBe(runtimeFile.bytes);

		const onnxImporter = getDefaultAssetImporterConfiguration(sources.onnx.path);
		onnxImporter.settings.includeInBuild = false;
		await writeJSON(`${sources.onnx.path}.bjsmeta.json`, { version: 1, guid: "runtime-ai-0", importer: onnxImporter });
		await processAssetFile(sources.onnx.path, { ...options, exportedAssets: [] });
		expect(await pathExists(onnxOutput)).toBe(false);
		expect(await pathExists(`${onnxOutput}.bjsai.json`)).toBe(false);
		expect(await pathExists(weightOutput)).toBe(true);
		expect(cache["assets/models/external.onnx"]).toBeUndefined();

		const sharedOnnxOutput = join(publicDir, "assets", "models", "shared.onnx");
		const sharedOnnxImporter = getDefaultAssetImporterConfiguration(sources.sharedOnnx.path);
		sharedOnnxImporter.settings.includeInBuild = false;
		await writeJSON(`${sources.sharedOnnx.path}.bjsmeta.json`, { version: 1, guid: "runtime-ai-1", importer: sharedOnnxImporter });
		await processAssetFile(sources.sharedOnnx.path, { ...options, exportedAssets: [] });
		expect(await pathExists(sharedOnnxOutput)).toBe(false);
		expect(await pathExists(`${sharedOnnxOutput}.bjsai.json`)).toBe(false);
		expect(await pathExists(weightOutput)).toBe(false);
		expect(cache["assets/models/shared.onnx"]).toBeUndefined();
	});
});
