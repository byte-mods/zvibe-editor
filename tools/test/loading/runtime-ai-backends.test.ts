import { afterEach, describe, expect, test } from "vitest";

import { getRuntimeAiBackends, IRuntimeAiBackendModules, registerRuntimeAiBackends } from "../../src/loading/runtime-ai-backends";

const registryKey = Symbol.for("babylonjs-editor-tools.runtimeAiBackends");

describe("runtime AI backends", () => {
	afterEach(() => {
		delete (globalThis as Record<symbol, unknown>)[registryKey];
	});

	test("the runtime does not load ONNX Runtime or LiteRT until a build opts in", () => {
		delete (globalThis as Record<symbol, unknown>)[registryKey];
		expect(() => getRuntimeAiBackends()).toThrow('import "babylonjs-editor-tools/runtime-ai-backends"');
	});

	test("importing the opt-in entry registers the default ONNX Runtime and LiteRT loaders", async () => {
		await import("../../src/runtime-ai-backends");
		const backends = getRuntimeAiBackends();
		const onnxRuntime = (await backends.loadOnnxRuntime("wasm")) as { InferenceSession?: unknown };
		expect(onnxRuntime.InferenceSession).toBeDefined();
	});

	test("custom loaders can be registered for bespoke builds", () => {
		const custom: IRuntimeAiBackendModules = { loadOnnxRuntime: async () => ({}), loadLiteRt: async () => ({}) };
		registerRuntimeAiBackends(custom);
		expect(getRuntimeAiBackends()).toBe(custom);
	});
});
