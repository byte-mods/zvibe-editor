import { Scene } from "babylonjs";
import { analyzeComputeNodeGraph, compileComputeNodeGraph, evaluateComputeNodeGraphPreview, ICustomRenderPassDefinition } from "babylonjs-editor-tools";

import { getSceneDiagnostics } from "../editor";
import { getCustomComputeNodeGraph } from "./compute-graph";
import { getCustomRenderPassGpuProfiling, getCustomRenderPassGraphDiagnostics, listCustomRenderPasses } from "./custom-passes";

function computePass(scene: Scene, data: any): ICustomRenderPassDefinition {
	const passes = listCustomRenderPasses(scene).passes as ICustomRenderPassDefinition[];
	const pass = passes.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!pass) {
		throw new Error("Compute pass not found. Provide id (preferred) or name.");
	}
	if (pass.passType !== "compute") {
		throw new Error(`Custom render pass "${pass.name}" is not a compute pass.`);
	}
	return pass;
}

function previewOptions(scene: Scene, pass: ICustomRenderPassDefinition, data: any): any {
	const engine = scene.getEngine();
	return {
		invocationId: data.invocationId ?? [0, 0, 0],
		outputSize: data.outputSize ?? [Math.max(1, Math.round(engine.getRenderWidth() * pass.ratio)), Math.max(1, Math.round(engine.getRenderHeight() * pass.ratio))],
		textureSamples: data.textureSamples ?? {},
		uniformValues: Object.fromEntries(
			pass.computeSettings.uniformBuffers.map((buffer) => [buffer.name, Object.fromEntries(buffer.uniforms.map((uniform) => [uniform.name, uniform.value]))])
		),
		storageBuffers: Object.fromEntries(pass.computeSettings.storageBuffers.map((buffer) => [buffer.name, { dataType: buffer.dataType, data: buffer.data }])),
	};
}

function compileOptions(pass: ICustomRenderPassDefinition): any {
	return {
		outputBindingName: pass.computeSettings.outputBindingName,
		outputGroup: pass.computeSettings.outputGroup,
		outputBinding: pass.computeSettings.outputBinding,
		outputType: pass.outputType,
		textureInputs: Object.entries(pass.inputs).map(([name, input]) => ({ name, group: input.group!, binding: input.binding! })),
		uniformBuffers: pass.computeSettings.uniformBuffers,
		storageBuffers: pass.computeSettings.storageBuffers,
	};
}

/** Evaluates one representative CPU invocation for deterministic per-node previews without mutating GPU resources. */
export function previewCustomComputeNodeGraph(scene: Scene, data: any): any {
	const pass = computePass(scene, data);
	const graph = getCustomComputeNodeGraph(scene, { id: pass.id }).graph;
	if (!graph) {
		throw new Error(`Compute pass "${pass.name}" has no node graph.`);
	}
	const result = evaluateComputeNodeGraphPreview(graph, previewOptions(scene, pass, data));
	const nodeIds = data.nodeIds ? new Set<string>(data.nodeIds) : null;
	return { passId: pass.id, passName: pass.name, ...result, entries: nodeIds ? result.entries.filter((entry) => nodeIds.has(entry.nodeId)) : result.entries };
}

/** Combines static topology, compiler, CPU preview, live runtime, dependency, and frame-level GPU diagnostics. */
export function debugCustomComputeNodeGraph(scene: Scene, data: any): any {
	const pass = computePass(scene, data);
	const graph = getCustomComputeNodeGraph(scene, { id: pass.id }).graph;
	if (!graph) {
		throw new Error(`Compute pass "${pass.name}" has no node graph.`);
	}
	const analysis = analyzeComputeNodeGraph(graph);
	let compilation: any = null;
	let compilerError: string | null = null;
	let preview: any = null;
	let previewError: string | null = null;
	if (analysis.valid && analysis.complete) {
		try {
			compilation = compileComputeNodeGraph(graph, compileOptions(pass));
		} catch (error) {
			compilerError = error instanceof Error ? error.message : String(error);
		}
		try {
			preview = evaluateComputeNodeGraphPreview(graph, previewOptions(scene, pass, data));
		} catch (error) {
			previewError = error instanceof Error ? error.message : String(error);
		}
	}
	const runtimeGraph = getCustomRenderPassGraphDiagnostics(scene);
	const runtime = runtimeGraph.computeTargets.find((target: any) => target.id === pass.id) ?? null;
	const frame = getSceneDiagnostics(scene);
	const gpuProfile = getCustomRenderPassGpuProfiling(scene, {});
	const isolatedGpu = gpuProfile.passes.find((candidate: any) => candidate.id === pass.id) ?? null;
	return {
		passId: pass.id,
		passName: pass.name,
		analysis,
		compiler: {
			ready: Boolean(compilation) && !compilerError,
			error: compilerError,
			executionOrder: compilation?.executionOrder ?? [],
			diagnostics: compilation?.diagnostics ?? [],
			wgsl: data.includeWgsl ? (compilation?.wgsl ?? null) : undefined,
		},
		preview: { ready: Boolean(preview) && !previewError, error: previewError, entries: preview?.entries ?? [] },
		runtime: { graphReady: runtimeGraph.ready, graphError: runtimeGraph.error, target: runtime },
		profiling: {
			cpuDispatchScope: "per-pass CPU submission only",
			dispatchCount: runtime?.dispatchCount ?? 0,
			lastCpuDispatchDurationMs: runtime?.lastCpuDispatchDurationMs ?? null,
			averageCpuDispatchDurationMs: runtime?.averageCpuDispatchDurationMs ?? null,
			gpuTimingScope: "isolated custom compute pass hardware timestamp",
			gpuTimingSupported: gpuProfile.supported,
			gpuTimingReason: gpuProfile.reason,
			gpuSamplingStrategy: gpuProfile.samplingStrategy,
			gpuPassTimeMs: isolatedGpu?.lastMs ?? null,
			gpuPassTimeAverageMs: isolatedGpu?.averageMs ?? null,
			gpuPassSampleCount: isolatedGpu?.sampleCount ?? 0,
			gpuTimingAvailable: isolatedGpu?.available ?? false,
			gpuFrameContextMs: frame.gpuFrameTimeMs,
		},
	};
}

/** Returns focused live dispatch counters/timing and honest backend frame-GPU timing availability. */
export function getCustomComputeNodeProfile(scene: Scene, data: any): any {
	const pass = computePass(scene, data);
	const runtimeGraph = getCustomRenderPassGraphDiagnostics(scene);
	const runtime = runtimeGraph.computeTargets.find((target: any) => target.id === pass.id) ?? null;
	const frame = getSceneDiagnostics(scene);
	const gpuProfile = getCustomRenderPassGpuProfiling(scene, { includeSamples: data.includeSamples, sampleLimit: data.sampleLimit });
	const isolatedGpu = gpuProfile.passes.find((candidate: any) => candidate.id === pass.id) ?? null;
	return {
		passId: pass.id,
		passName: pass.name,
		backend: scene.getEngine().getClassName(),
		runtimeAvailable: Boolean(runtime),
		dispatch: runtime
			? {
					dispatched: runtime.dispatched,
					dispatchCount: runtime.dispatchCount,
					lastCpuSubmissionMs: runtime.lastCpuDispatchDurationMs,
					averageCpuSubmissionMs: runtime.averageCpuDispatchDurationMs,
					error: runtime.error,
				}
			: null,
		gpu: {
			scope: "isolated custom compute pass",
			supported: gpuProfile.supported,
			available: isolatedGpu?.available ?? false,
			mode: gpuProfile.mode,
			samplingStrategy: gpuProfile.samplingStrategy,
			reason: gpuProfile.reason,
			profile: isolatedGpu,
			frameContextMs: frame.gpuFrameTimeMs,
			note: "The pass duration comes only from a hardware timestamp counter; frameContextMs is reported separately and is never substituted.",
		},
	};
}
