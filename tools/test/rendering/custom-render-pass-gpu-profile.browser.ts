import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import {
	applyCustomRenderPassGraph,
	configureCustomRenderPassGpuProfiling,
	defaultCustomRenderPassComputeShader,
	defaultCustomRenderPassFragmentShader,
	getCustomRenderPassComputeTargets,
	getCustomRenderPassGpuProfile,
	ICustomRenderPassDefinition,
} from "../../src/rendering/custom-render-pass-graph";

async function run(): Promise<void> {
	const gpu = (navigator as any).gpu;
	const adapter = await gpu?.requestAdapter();
	if (!adapter || !adapter.features.has("timestamp-query")) {
		document.body.dataset.result = "unavailable";
		document.body.dataset.details = JSON.stringify({
			webgpu: Boolean(gpu),
			adapter: Boolean(adapter),
			timestampQuery: adapter?.features.has("timestamp-query") ?? false,
		});
		return;
	}
	const canvas = document.createElement("canvas");
	canvas.width = 32;
	canvas.height = 32;
	document.body.appendChild(canvas);
	const engine = await WebGPUEngine.CreateAsync(canvas, { deviceDescriptor: { requiredFeatures: ["timestamp-query"] } });
	const scene = new Scene(engine);
	const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
	scene.activeCamera = camera;
	const compute: ICustomRenderPassDefinition = {
		id: "webgpu-profile",
		name: "WebGPU Profile",
		passType: "compute",
		copySource: { source: "screen" },
		rasterSettings: {
			cameraId: null,
			meshIds: [],
			clearColor: [0, 0, 0, 0],
			renderParticles: false,
			renderSprites: false,
			useCameraPostProcesses: false,
			refreshRate: "everyFrame",
		},
		computeSettings: {
			wgsl: defaultCustomRenderPassComputeShader,
			entryPoint: "main",
			outputBindingName: "outputTexture",
			outputGroup: 0,
			outputBinding: 0,
			dispatch: [4, 4, 1],
			dispatchMode: "everyFrame",
			dispatchType: "direct",
			indirectBuffer: null,
			indirectOffset: 0,
			uniformBuffers: [],
			storageBuffers: [],
			submitAfterDispatch: true,
			nodeGraph: null,
		},
		enabled: true,
		order: 0,
		dependencies: [],
		fragmentShader: defaultCustomRenderPassFragmentShader,
		uniforms: {},
		inputs: {},
		output: "profileOutput",
		outputType: "uint8",
		outputFormat: "rgba",
		outputSamples: 1,
		additionalOutputs: [],
		ratio: 1,
		samplingMode: "nearest",
	};
	const raster: ICustomRenderPassDefinition = {
		...compute,
		id: "webgpu-raster-profile",
		name: "WebGPU Raster Profile",
		passType: "raster",
		order: -1,
		output: "rasterProfileOutput",
		rasterSettings: { ...compute.rasterSettings, clearColor: [0.1, 0.2, 0.3, 1] },
	};
	configureCustomRenderPassGpuProfiling(camera, true, 32);
	applyCustomRenderPassGraph(scene, camera, [raster, compute]);
	for (let frame = 0; frame < 30; frame++) {
		engine.beginFrame();
		scene.render();
		scene.onAfterRenderTargetsRenderObservable.notifyObservers(scene);
		engine.endFrame();
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	const profile = getCustomRenderPassGpuProfile(camera, true, 32);
	document.body.dataset.result =
		profile.supported && profile.passes.length === 2 && profile.passes.every((pass: any) => pass.available && pass.sampleCount > 0 && pass.lastMs >= 0) ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify({ profile, computeTargets: getCustomRenderPassComputeTargets(camera) });
	scene.dispose();
	engine.dispose();
}

void run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
});
