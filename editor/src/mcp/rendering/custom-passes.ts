import { Scene, Tools } from "babylonjs";
import {
	applyCustomRenderPassGraph,
	configureCustomRenderPassGpuProfiling,
	defaultCustomRenderPassComputeShader,
	defaultCustomRenderPassFragmentShader,
	disposeCustomRenderPassGraph,
	getCustomRenderPassDiagnostics,
	getCustomRenderPassGpuProfile,
	getCustomRenderPassComputeTargets,
	getCustomRenderPassMultiRenderTargets,
	getCustomRenderPassSceneRasterTargets,
	getCustomRenderPassRuntimeError,
	getCustomRenderPassSchedule,
	ICustomRenderPassDefinition,
	sortCustomRenderPassGraph,
	readCustomRenderPassComputeStorageBuffer,
	updateCustomRenderPassComputeStorageBuffer,
	updateCustomRenderPassComputeUniformBuffer,
} from "babylonjs-editor-tools";

import { getProjectAssetsRootUrl } from "../../project/configuration";
import { IMCPActionOptions } from "../action";

function defaultRasterSettings(): any {
	return { cameraId: null, meshIds: [], clearColor: [0, 0, 0, 0], renderParticles: false, renderSprites: false, useCameraPostProcesses: false, refreshRate: "everyFrame" };
}

function defaultComputeSettings(): any {
	return {
		wgsl: defaultCustomRenderPassComputeShader,
		entryPoint: "main",
		outputBindingName: "outputTexture",
		outputGroup: 0,
		outputBinding: 0,
		dispatch: [1, 1, 1],
		dispatchMode: "everyFrame",
		dispatchType: "direct",
		indirectBuffer: null,
		indirectOffset: 0,
		uniformBuffers: [],
		storageBuffers: [],
		submitAfterDispatch: false,
		nodeGraph: null,
	};
}

function normalizeComputeSettings(value: any): any {
	const merged = { ...defaultComputeSettings(), ...structuredClone(value ?? {}) };
	merged.dispatch = [...(merged.dispatch ?? [1, 1, 1])];
	merged.uniformBuffers = structuredClone(merged.uniformBuffers ?? []);
	merged.storageBuffers = structuredClone(merged.storageBuffers ?? []).map((buffer: any) => ({
		...buffer,
		indirect: buffer.indirect ?? false,
		sharedResource: buffer.sharedResource ?? null,
		access: buffer.access ?? "readWrite",
	}));
	return merged;
}

function passes(scene: Scene): ICustomRenderPassDefinition[] {
	scene.metadata ??= {};
	const values = (scene.metadata.babylonEditorCustomRenderPasses ??= []) as ICustomRenderPassDefinition[];
	values.forEach((pass, index) => {
		pass.passType ??= "shader";
		pass.copySource ??= { source: "screen" };
		pass.rasterSettings = {
			...defaultRasterSettings(),
			...(pass.rasterSettings ?? {}),
			meshIds: [...(pass.rasterSettings?.meshIds ?? [])],
			clearColor: [...(pass.rasterSettings?.clearColor ?? [0, 0, 0, 0])],
		};
		pass.computeSettings = normalizeComputeSettings(pass.computeSettings);
		pass.enabled ??= true;
		pass.order ??= index;
		pass.dependencies ??= [];
		pass.uniforms ??= {};
		pass.inputs ??= {};
		pass.output ??= null;
		pass.outputType ??= "uint8";
		pass.outputFormat ??= "rgba";
		pass.outputSamples ??= 1;
		pass.additionalOutputs ??= [];
		pass.ratio ??= 1;
		pass.samplingMode ??= "bilinear";
	});
	return values;
}

function resolvePass(scene: Scene, data: any): ICustomRenderPassDefinition {
	const value = passes(scene).find((pass) => pass.id === data.id || pass.name === data.name);
	if (!value) throw new Error("Custom render pass not found. Provide id (preferred) or name.");
	return value;
}

function refresh(scene: Scene, options: IMCPActionOptions): { applied: boolean; error: string | null } {
	let result = { applied: false, error: null as string | null };
	if (scene.activeCamera) {
		try {
			if (passes(scene).length) applyCustomRenderPassGraph(scene as any, scene.activeCamera as any, passes(scene), getProjectAssetsRootUrl() ?? "");
			else disposeCustomRenderPassGraph(scene.activeCamera as any);
			result = { applied: true, error: null };
		} catch (error) {
			result = { applied: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Lists persisted custom passes and their resolved dependency execution order. */
export function listCustomRenderPasses(scene: Scene): any {
	const values = passes(scene);
	const schedule = getCustomRenderPassSchedule(values);
	return { passes: structuredClone(values), executionOrder: schedule.executionOrder, schedule: structuredClone(schedule) };
}

/** Creates one arbitrary full-screen fragment pass in the persisted dependency graph. */
export function createCustomRenderPass(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = passes(scene);
	const value: ICustomRenderPassDefinition = {
		id: Tools.RandomId(),
		name: data.name,
		passType: data.passType ?? "shader",
		copySource: structuredClone(data.copySource ?? { source: "screen" }),
		rasterSettings: { ...defaultRasterSettings(), ...structuredClone(data.rasterSettings ?? {}) },
		computeSettings: normalizeComputeSettings(data.computeSettings),
		enabled: data.enabled ?? true,
		order: data.order ?? (values.length ? Math.max(...values.map((pass) => pass.order)) + 1 : 0),
		dependencies: structuredClone(data.dependencies ?? []),
		fragmentShader: data.fragmentShader ?? defaultCustomRenderPassFragmentShader,
		uniforms: structuredClone(data.uniforms ?? {}),
		inputs: structuredClone(data.inputs ?? {}),
		output: data.output ?? null,
		outputType: data.outputType ?? "uint8",
		outputFormat: data.outputFormat ?? "rgba",
		outputSamples: data.outputSamples ?? 1,
		additionalOutputs: structuredClone(data.additionalOutputs ?? []),
		ratio: data.ratio ?? 1,
		samplingMode: data.samplingMode ?? "bilinear",
	};
	if (values.some((pass) => pass.name === value.name)) throw new Error(`Custom render pass "${value.name}" already exists.`);
	sortCustomRenderPassGraph([...values, value]);
	values.push(value);
	const preview = refresh(scene, options);
	return { ...structuredClone(value), preview };
}

/** Updates shader source, uniforms, scheduling, dependencies, resolution, or sampling for one pass. */
export function setCustomRenderPass(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = passes(scene);
	const value = resolvePass(scene, data);
	const next = {
		...value,
		...data,
		id: value.id,
		dependencies: structuredClone(data.dependencies ?? value.dependencies),
		uniforms: structuredClone(data.uniforms ?? value.uniforms),
		inputs: structuredClone(data.inputs ?? value.inputs),
		copySource: structuredClone(data.copySource ?? value.copySource),
		rasterSettings: {
			...value.rasterSettings,
			...structuredClone(data.rasterSettings ?? {}),
			meshIds: structuredClone(data.rasterSettings?.meshIds ?? value.rasterSettings.meshIds),
			clearColor: structuredClone(data.rasterSettings?.clearColor ?? value.rasterSettings.clearColor),
		},
		computeSettings: normalizeComputeSettings({ ...value.computeSettings, ...structuredClone(data.computeSettings ?? {}) }),
		additionalOutputs: structuredClone(data.additionalOutputs ?? value.additionalOutputs),
	};
	if (data.name !== undefined && values.some((pass) => pass !== value && pass.name === data.name)) throw new Error(`Custom render pass "${data.name}" already exists.`);
	const previousOutputNames = [value.output, ...value.additionalOutputs.map((output) => output.name)];
	const nextOutputNames = [next.output, ...next.additionalOutputs.map((output) => output.name)];
	const renamedOutputs = new Map<string, string>();
	previousOutputNames.forEach((name, index) => {
		const nextName = nextOutputNames[index];
		if (name && nextName && name !== nextName) renamedOutputs.set(name, nextName);
	});
	const candidates = values.map((pass) => {
		if (pass === value) return next;
		if (!renamedOutputs.size) return pass;
		return {
			...pass,
			copySource:
				pass.passType === "copy" && pass.copySource.source === "pass" && pass.copySource.output && renamedOutputs.has(pass.copySource.output)
					? { ...pass.copySource, output: renamedOutputs.get(pass.copySource.output) }
					: pass.copySource,
			inputs: Object.fromEntries(
				Object.entries(pass.inputs).map(([name, input]) => [
					name,
					input.source === "pass" && input.output && renamedOutputs.has(input.output) ? { ...input, output: renamedOutputs.get(input.output) } : input,
				])
			),
		};
	});
	sortCustomRenderPassGraph(candidates);
	Object.assign(value, next);
	if (renamedOutputs.size) {
		for (const pass of values) {
			if (pass.passType === "copy" && pass.copySource.source === "pass" && pass.copySource.output && renamedOutputs.has(pass.copySource.output)) {
				pass.copySource = { ...pass.copySource, output: renamedOutputs.get(pass.copySource.output) };
			}
			pass.inputs = Object.fromEntries(
				Object.entries(pass.inputs).map(([name, input]) => [
					name,
					input.source === "pass" && input.output && renamedOutputs.has(input.output) ? { ...input, output: renamedOutputs.get(input.output) } : input,
				])
			);
		}
	}
	const preview = refresh(scene, options);
	return { ...structuredClone(value), preview };
}

/** Deletes one pass and removes its id from downstream dependency lists. */
export function deleteCustomRenderPass(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = passes(scene);
	const value = resolvePass(scene, data);
	const outputNames = new Set([value.output, ...value.additionalOutputs.map((output) => output.name)].filter(Boolean));
	values.splice(values.indexOf(value), 1);
	for (const pass of values) {
		pass.dependencies = pass.dependencies.filter((dependency) => dependency !== value.id);
		if (pass.passType === "copy" && pass.copySource.source === "pass" && pass.copySource.output && outputNames.has(pass.copySource.output))
			pass.copySource = { source: "screen" };
		pass.inputs = Object.fromEntries(Object.entries(pass.inputs).filter(([, input]) => input.source !== "pass" || !input.output || !outputNames.has(input.output)));
	}
	const preview = refresh(scene, options);
	return { deleted: true, id: value.id, preview };
}

/** Rebuilds the active camera's pass chain and reports the dependency-resolved execution order. */
export function evaluateCustomRenderPassGraph(scene: Scene, _data: any, options: IMCPActionOptions): any {
	if (!scene.activeCamera) throw new Error("No active camera. Set an active camera before evaluating custom render passes.");
	const ordered = applyCustomRenderPassGraph(scene as any, scene.activeCamera as any, passes(scene), getProjectAssetsRootUrl() ?? "");
	const schedule = getCustomRenderPassSchedule(passes(scene));
	options.editor.layout.inspector.forceUpdate();
	return {
		cameraId: scene.activeCamera.id,
		executionOrder: ordered.map((pass) => pass.id),
		passes: ordered.map((pass) => ({ id: pass.id, name: pass.name, enabled: pass.enabled })),
		activePassCount: ordered.filter((pass) => pass.enabled).length,
		schedule,
	};
}

/** Returns dependency order, named-output lifetimes, and aliased allocation slots without rebuilding preview. */
export function getCustomRenderPassGraphSchedule(scene: Scene): any {
	return structuredClone(getCustomRenderPassSchedule(passes(scene)));
}

/** Reports live readiness and shader compiler errors for the active camera's attached passes. */
export function getCustomRenderPassGraphDiagnostics(scene: Scene): any {
	if (!scene.activeCamera) throw new Error("No active camera. Set an active camera before reading custom render-pass diagnostics.");
	const diagnostics = getCustomRenderPassDiagnostics(scene.activeCamera as any);
	const runtimeError = getCustomRenderPassRuntimeError(scene.activeCamera as any);
	return {
		cameraId: scene.activeCamera.id,
		passes: diagnostics,
		multiRenderTargets: getCustomRenderPassMultiRenderTargets(scene.activeCamera as any),
		sceneRasterTargets: getCustomRenderPassSceneRasterTargets(scene.activeCamera as any),
		computeTargets: getCustomRenderPassComputeTargets(scene.activeCamera as any),
		runtimeError,
		ready: !runtimeError && diagnostics.every((pass) => pass.ready && !pass.compilationError && pass.resources.every((resource) => resource.ready)),
	};
}

/** Enables or disables transient isolated GPU timing and rebuilds the active graph so WebGPU resources receive counters. */
export function setCustomRenderPassGpuProfiling(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!scene.activeCamera) throw new Error("No active camera. Set an active camera before configuring custom render-pass GPU profiling.");
	configureCustomRenderPassGpuProfiling(scene.activeCamera as any, data.enabled, data.sampleCapacity ?? 120);
	const preview = refresh(scene, options);
	return { ...getCustomRenderPassGpuProfile(scene.activeCamera as any, data.includeSamples === true, data.sampleLimit ?? 60), preview };
}

/** Reads isolated per-pass hardware timestamp samples without substituting CPU or whole-frame timing. */
export function getCustomRenderPassGpuProfiling(scene: Scene, data: any): any {
	if (!scene.activeCamera) throw new Error("No active camera. Set an active camera before reading custom render-pass GPU profiling.");
	return getCustomRenderPassGpuProfile(scene.activeCamera as any, data.includeSamples === true, data.sampleLimit ?? 60);
}

function computePass(scene: Scene, data: any): ICustomRenderPassDefinition {
	const value = resolvePass(scene, data);
	if (value.passType !== "compute") throw new Error(`Custom render pass "${value.name}" is not a compute pass.`);
	return value;
}

/** Updates authored and/or live typed storage-buffer data without rebuilding the graph. */
export function setCustomComputeStorageBufferData(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const sourceBuffer = value.computeSettings.storageBuffers.find((candidate) => candidate.name === data.bufferName);
	const buffer = structuredClone(sourceBuffer);
	if (!buffer) throw new Error(`Compute pass "${value.name}" has no storage buffer named "${data.bufferName}".`);
	const elementOffset = data.elementOffset ?? 0;
	if (!Number.isInteger(elementOffset) || elementOffset < 0 || elementOffset + data.data.length > buffer.data.length)
		throw new Error(`Storage-buffer update range must fit within ${buffer.data.length} elements.`);
	const affectedSettings = new Map<ICustomRenderPassDefinition, any>();
	for (const pass of passes(scene)) {
		const settings = structuredClone(pass.computeSettings);
		const candidateBuffer = settings.storageBuffers.find((candidate: any) =>
			buffer.sharedResource ? candidate.sharedResource === buffer.sharedResource : pass === value && candidate.name === data.bufferName
		);
		if (!candidateBuffer) continue;
		candidateBuffer.data.splice(elementOffset, data.data.length, ...data.data);
		affectedSettings.set(pass, settings);
	}
	const candidates = passes(scene).map((pass) => (affectedSettings.has(pass) ? { ...pass, computeSettings: affectedSettings.get(pass) } : pass));
	sortCustomRenderPassGraph(candidates);
	const persist = data.persist ?? true;
	if (persist) affectedSettings.forEach((settings, pass) => (pass.computeSettings = settings));
	let runtime = { applied: false, error: "No active camera." } as any;
	if (scene.activeCamera) {
		try {
			runtime = {
				applied: true,
				error: null,
				...updateCustomRenderPassComputeStorageBuffer(scene.activeCamera as any, value.id, data.bufferName, data.data, elementOffset, false),
			};
		} catch (error) {
			runtime = { applied: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	if (!persist && !runtime.applied) throw new Error(runtime.error);
	options.editor.layout.inspector.forceUpdate();
	return {
		passId: value.id,
		bufferName: data.bufferName,
		sharedResource: buffer.sharedResource,
		affectedPassIds: [...affectedSettings.keys()].map((pass) => pass.id),
		elementOffset,
		elementCount: data.data.length,
		persisted: persist,
		runtime,
	};
}

/** Updates authored and/or live uniform-buffer fields without rebuilding the graph. */
export function setCustomComputeUniformBufferValues(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = computePass(scene, data);
	const settings = structuredClone(value.computeSettings);
	const buffer = settings.uniformBuffers.find((candidate: any) => candidate.name === data.bufferName);
	if (!buffer) throw new Error(`Compute pass "${value.name}" has no uniform buffer named "${data.bufferName}".`);
	for (const [name, nextValue] of Object.entries(data.values as Record<string, number[]>)) {
		const uniform = buffer.uniforms.find((candidate: any) => candidate.name === name);
		if (!uniform) throw new Error(`Compute uniform buffer "${data.bufferName}" has no field named "${name}".`);
		uniform.value = structuredClone(nextValue);
	}
	const candidate = { ...value, computeSettings: settings };
	sortCustomRenderPassGraph(passes(scene).map((pass) => (pass === value ? candidate : pass)));
	const persist = data.persist ?? true;
	if (persist) value.computeSettings = settings;
	let runtime = { applied: false, error: "No active camera." } as any;
	if (scene.activeCamera) {
		try {
			runtime = { applied: true, error: null, ...updateCustomRenderPassComputeUniformBuffer(scene.activeCamera as any, value.id, data.bufferName, data.values, false) };
		} catch (error) {
			runtime = { applied: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	if (!persist && !runtime.applied) throw new Error(runtime.error);
	options.editor.layout.inspector.forceUpdate();
	return { passId: value.id, bufferName: data.bufferName, updatedUniforms: Object.keys(data.values), persisted: persist, runtime };
}

/** Reads a bounded authored or live GPU storage-buffer range. */
export async function readCustomComputeStorageBuffer(scene: Scene, data: any): Promise<any> {
	const value = computePass(scene, data);
	if ((data.source ?? "runtime") === "runtime") {
		if (!scene.activeCamera) throw new Error("No active camera. Rebuild the compute graph before requesting live GPU readback.");
		return readCustomRenderPassComputeStorageBuffer(scene.activeCamera as any, value.id, data.bufferName, data.elementOffset ?? 0, data.elementCount, data.noDelay ?? false);
	}
	const buffer = value.computeSettings.storageBuffers.find((candidate) => candidate.name === data.bufferName);
	if (!buffer) throw new Error(`Compute pass "${value.name}" has no storage buffer named "${data.bufferName}".`);
	const elementOffset = data.elementOffset ?? 0;
	const elementCount = data.elementCount ?? buffer.data.length - elementOffset;
	if (!Number.isInteger(elementOffset) || elementOffset < 0 || !Number.isInteger(elementCount) || elementCount < 1 || elementOffset + elementCount > buffer.data.length)
		throw new Error(`Storage-buffer read range must contain at least one element and fit within ${buffer.data.length} elements.`);
	return {
		passId: value.id,
		bufferName: buffer.name,
		dataType: buffer.dataType,
		source: "authored",
		elementOffset,
		elementCount,
		data: buffer.data.slice(elementOffset, elementOffset + elementCount),
	};
}
