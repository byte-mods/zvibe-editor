import { tmpdir } from "os";
import { join } from "path/posix";
import { symlink } from "fs/promises";

import { mkdtemp, mkdir, remove, writeFile, writeJSON } from "fs-extra";
import { NullEngine, Scene } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { getDefaultAssetImporterConfiguration, validateAssetImporterConfiguration } from "babylonjs-editor-tools";

import {
	createRuntimeAiSession,
	disposeRuntimeAiSession,
	getRuntimeAiCapabilities,
	getRuntimeAiSession,
	inspectRuntimeAiModel,
	listRuntimeAiSessions,
	resetRuntimeAiRuntime,
	runRuntimeAiInference,
	shutdownRuntimeAi,
} from "../../src/mcp/ai/runtime-inference";
import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { projectConfiguration } from "../../src/project/configuration";

const identityModel = Buffer.from(
	"CAgSCVp2aWJlVGVzdDpjCicKBWlucHV0EgZvdXRwdXQaDElkZW50aXR5Tm9kZSIISWRlbnRpdHkSDUlkZW50aXR5R3JhcGhaEwoFaW5wdXQSCgoICAESBAoCCAFiFAoGb3V0cHV0EgoKCAgBEgQKAggBQgIQDQ==",
	"base64"
);

describe("Runtime AI multi-format editor owner", () => {
	let directory: string;
	let modelPath: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	let editor: any;
	let options: any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "zvibe-runtime-ai-"));
		await mkdir(join(directory, "assets", "models"), { recursive: true });
		modelPath = join(directory, "assets", "models", "identity.onnx");
		await writeFile(modelPath, identityModel);
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeJSON(projectConfiguration.path, {});
		engine = new NullEngine();
		scene = new Scene(engine);
		editor = {
			state: { projectPath: projectConfiguration.path, enableExperimentalFeatures: false },
			layout: { preview: { scene }, inspector: { forceUpdate: () => undefined } },
		};
		options = { editor };
	});

	afterEach(async () => {
		await shutdownRuntimeAi(editor);
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("infers and strictly validates the ONNX, LiteRT, and PyTorch Export AI Model Importer", () => {
		const importer = getDefaultAssetImporterConfiguration(modelPath);
		expect(importer).toMatchObject({ kind: "aiModel", settings: { backend: "automatic", wasmNumThreads: 1, maximumTensorElements: 1_048_576 } });
		expect(
			validateAssetImporterConfiguration(modelPath, { ...importer, settings: { ...importer.settings, backend: "wasm", wasmNumThreads: 4 } }).configuration.settings
		).toMatchObject({
			backend: "wasm",
			wasmNumThreads: 4,
		});
		expect(() => validateAssetImporterConfiguration(modelPath, { ...importer, settings: { ...importer.settings, wasmNumThreads: 17 } })).toThrow("at most 16");
		expect(getDefaultAssetImporterConfiguration("assets/model.tflite").kind).toBe("aiModel");
		expect(getDefaultAssetImporterConfiguration("assets/model.pt2").kind).toBe("aiModel");
	});

	test("compiles, inspects, retains, runs, revisions, lists, and disposes a real ONNX model", async () => {
		const inspection = await inspectRuntimeAiModel(scene, { modelPath: "assets/models/identity.onnx" }, options);
		expect(inspection).toMatchObject({
			modelPath: "assets/models/identity.onnx",
			modelBytes: identityModel.length,
			description: {
				backend: "wasm",
				modelFormat: "onnx",
				runtimeEngine: "onnxruntime-web",
				graph: { nodes: [{ operator: "Identity" }] },
				inputs: [{ name: "input", type: "float32", shape: [1] }],
				outputs: [{ name: "output", type: "float32", shape: [1] }],
			},
		});
		expect(inspection.modelSha256).toMatch(/^[a-f0-9]{64}$/);

		const created = await createRuntimeAiSession(scene, { modelPath: inspection.modelPath, expectedModelSha256: inspection.modelSha256 }, options);
		expect(created).toMatchObject({ id: "runtime-ai-1", revision: 1, runCount: 0, busy: false });
		expect(listRuntimeAiSessions(scene, { offset: 0, limit: 1 }, options)).toMatchObject({ total: 1, nextOffset: null, sessions: [{ id: created.id }] });
		expect(getRuntimeAiSession(scene, { id: created.id }, options).revision).toBe(1);

		const result = await runRuntimeAiInference(
			scene,
			{ id: created.id, expectedRevision: 1, inputs: { input: { type: "float32", dims: [1], data: [42.25] } }, outputNames: ["output"], maximumOutputValues: 1 },
			options
		);
		expect(result.outputs.output).toMatchObject({ type: "float32", dims: [1], totalValues: 1, truncated: false, data: [42.25] });
		expect(result.session).toMatchObject({ revision: 2, runCount: 1, busy: false });
		await expect(runRuntimeAiInference(scene, { id: created.id, expectedRevision: 1, inputs: {} }, options)).rejects.toThrow("revision is stale");
		await expect(disposeRuntimeAiSession(scene, { id: created.id, expectedRevision: 2, confirm: false }, options)).rejects.toThrow("confirm: true");
		expect(await disposeRuntimeAiSession(scene, { id: created.id, expectedRevision: 2, confirm: true }, options)).toMatchObject({ disposed: true, id: created.id });
		expect(listRuntimeAiSessions(scene, {}, options).total).toBe(0);
	});

	test("rejects traversal, unsupported files, symlinks, stale hashes, malformed feeds, and enforces reset confirmation", async () => {
		await writeFile(join(directory, "assets", "not-a-model.bin"), identityModel);
		await expect(inspectRuntimeAiModel(scene, { modelPath: "../outside.onnx" }, options)).rejects.toThrow("inside the open project");
		await expect(inspectRuntimeAiModel(scene, { modelPath: "assets/not-a-model.bin" }, options)).rejects.toThrow(".tflite");
		await symlink(modelPath, join(directory, "assets", "models", "linked.onnx"));
		await expect(inspectRuntimeAiModel(scene, { modelPath: "assets/models/linked.onnx" }, options)).rejects.toThrow("non-symbolic-link");
		await expect(createRuntimeAiSession(scene, { modelPath: "assets/models/identity.onnx", expectedModelSha256: "0".repeat(64) }, options)).rejects.toThrow(
			"fingerprint is stale"
		);
		const created = await createRuntimeAiSession(scene, { modelPath: "assets/models/identity.onnx" }, options);
		await expect(runRuntimeAiInference(scene, { id: created.id, expectedRevision: 1, inputs: { wrong: { type: "float32", dims: [1], data: [1] } } }, options)).rejects.toThrow(
			"Missing: input"
		);
		expect(getRuntimeAiSession(scene, { id: created.id }, options).revision).toBe(2);
		await expect(resetRuntimeAiRuntime(scene, { confirm: false }, options)).rejects.toThrow("confirm: true");
		expect(await resetRuntimeAiRuntime(scene, { confirm: true }, options)).toEqual({ reset: true, disposedSessions: 1 });
	});

	test("publishes truthful capabilities and all eight renderer endpoints", () => {
		const capabilities = getRuntimeAiCapabilities(scene, {}, options);
		expect(capabilities).toMatchObject({
			modelFormats: ["onnx", "litert", "pytorchExport"],
			features: { modelAssetImporter: true, wasm: true, liteRt: true, exportedPyTorch: true, modelGraphVisualization: true },
		});
		const features = getEditorCapabilities(scene, {}, options).features;
		expect(features).toMatchObject({
			runtimeAiInference: true,
			onnxModelAssets: true,
			liteRtModelAssets: true,
			pytorchExportModelAssets: true,
			runtimeAiWasm: true,
			runtimeAiLiteRt: true,
			runtimeAiExportedPyTorch: true,
			runtimeAiModelGraphs: true,
		});
		for (const endpoint of [
			"get_runtime_ai_capabilities",
			"inspect_runtime_ai_model",
			"create_runtime_ai_session",
			"list_runtime_ai_sessions",
			"get_runtime_ai_session",
			"run_runtime_ai_inference",
			"dispose_runtime_ai_session",
			"reset_runtime_ai_runtime",
		]) {
			expect(MCPEndpoints[endpoint]).toBeTypeOf("function");
		}
	});
});
