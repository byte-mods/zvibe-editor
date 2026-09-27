import type { RuntimeAiEffectiveBackend } from "./runtime-ai";

/**
 * Loads the inference runtimes behind Runtime AI sessions. They are registered by importing
 * "babylonjs-editor-tools/runtime-ai-backends" instead of being imported by the runtime itself: web bundlers emit every
 * WebAssembly payload of a dynamically imported package (~64 MB for ONNX Runtime alone), even when the game never
 * creates a session, so only projects that use Runtime AI should reference them.
 */
export interface IRuntimeAiBackendModules {
	/** Loads "onnxruntime-web" (or its "/wasm" or "/webgpu" build) for the given backend. */
	loadOnnxRuntime(backend: RuntimeAiEffectiveBackend): Promise<unknown>;
	/** Loads "@litertjs/core" for LiteRT (.tflite) models. */
	loadLiteRt(): Promise<unknown>;
}

// Kept on globalThis so the ESM and CommonJS builds of this package share one registration.
const registryKey = Symbol.for("babylonjs-editor-tools.runtimeAiBackends");

/**
 * Registers the modules Runtime AI sessions use to run models. Importing "babylonjs-editor-tools/runtime-ai-backends"
 * calls this with the default ONNX Runtime and LiteRT loaders; call it directly to provide custom builds.
 * @param modules defines the loaders of the inference runtimes.
 */
export function registerRuntimeAiBackends(modules: IRuntimeAiBackendModules): void {
	(globalThis as Record<symbol, unknown>)[registryKey] = modules;
}

/**
 * Returns the registered Runtime AI inference runtimes.
 * @throws when "babylonjs-editor-tools/runtime-ai-backends" has not been imported.
 */
export function getRuntimeAiBackends(): IRuntimeAiBackendModules {
	const modules = (globalThis as Record<symbol, unknown>)[registryKey] as IRuntimeAiBackendModules | undefined;
	if (!modules) {
		throw new Error(
			'Runtime AI is not enabled in this build. Add `import "babylonjs-editor-tools/runtime-ai-backends";` once to your game code (for example src/scripts.ts). It is opt-in so builds that do not use Runtime AI do not ship ~64 MB of ONNX Runtime WebAssembly.'
		);
	}
	return modules;
}
