import { registerRuntimeAiBackends } from "./loading/runtime-ai-backends";

// Entry point of "babylonjs-editor-tools/runtime-ai-backends": importing it once enables Runtime AI sessions.
registerRuntimeAiBackends({
	loadOnnxRuntime: (backend) => {
		if (typeof window === "undefined") {
			return import("onnxruntime-web");
		}
		return backend === "webgpu" ? import("onnxruntime-web/webgpu") : import("onnxruntime-web/wasm");
	},
	loadLiteRt: () => import("@litertjs/core"),
});
