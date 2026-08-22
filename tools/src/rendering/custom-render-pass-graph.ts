import { Camera } from "@babylonjs/core/Cameras/camera";
import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Material } from "@babylonjs/core/Materials/material";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { MultiRenderTarget } from "@babylonjs/core/Materials/Textures/multiRenderTarget";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Logger } from "@babylonjs/core/Misc/logger";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";
import { rendererDataAllowsFeature } from "../loading/renderer-data";
import { RenderingGroup } from "@babylonjs/core/Rendering/renderingGroup";
import { Scene } from "@babylonjs/core/scene";

import { IComputeNodeGraph } from "./compute-node-graph";
import { acquireGeometryBufferLease, releaseGeometryBufferLease } from "./geometry-buffer-lease";
import { IRendererListDefinition, RenderingQueue, rendererListsMetadataKey, resolveRendererList, validateRendererLists } from "./renderer-lists";

import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";
import "@babylonjs/core/Engines/Extensions/engine.query";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.computeShader";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";

export type CustomRenderPassSamplingMode = "nearest" | "bilinear" | "trilinear";
export type CustomRenderPassOutputType = "uint8" | "halfFloat" | "float";
export type CustomRenderPassOutputFormat = "r" | "rg" | "rgba";
export type CustomRenderPassUniformValue = number | number[];
export type CustomRenderPassResourceSource = "depth" | "normal" | "texture" | "pass";
export type CustomRenderPassType = "shader" | "copy" | "raster" | "compute";
export type CustomRenderPassInjectionPoint = "beforeRendering" | "afterRenderingPrePasses" | "beforeRenderingPostProcessing" | "afterRenderingPostProcessing";
export type CustomRenderPassCopySourceType = "screen" | CustomRenderPassResourceSource;

export interface ICustomRenderPassResourceInput {
	source: CustomRenderPassResourceSource;
	path?: string;
	output?: string;
	group?: number;
	binding?: number;
}

export interface ICustomRenderPassCopySource {
	source: CustomRenderPassCopySourceType;
	path?: string;
	output?: string;
}

export interface ICustomRenderPassRasterSettings {
	rendererListId?: string | null;
	cameraId: string | null;
	meshIds: string[];
	includeDescendants: boolean;
	layerMask: number | null;
	materialId: string | null;
	clearColor: [number, number, number, number];
	clearMode: "colorDepth" | "depthOnly" | "none";
	depthTest: boolean;
	depthWrite: boolean;
	cullMode: "back" | "front" | "none";
	blendMode: "opaque" | "alpha" | "additive" | "multiply" | "premultiplied";
	renderParticles: boolean;
	renderSprites: boolean;
	useCameraPostProcesses: boolean;
	refreshRate: "once" | "everyFrame" | "everyTwoFrames";
}

export interface ICustomRenderPassComputeSettings {
	wgsl: string;
	entryPoint: string;
	outputBindingName: string;
	outputGroup: number;
	outputBinding: number;
	dispatch: [number, number, number];
	dispatchMode: "once" | "everyFrame";
	dispatchType: "direct" | "indirect";
	indirectBuffer: string | null;
	indirectOffset: number;
	uniformBuffers: ICustomRenderPassComputeUniformBuffer[];
	storageBuffers: ICustomRenderPassComputeStorageBuffer[];
	submitAfterDispatch: boolean;
	nodeGraph: IComputeNodeGraph | null;
}

export type CustomRenderPassComputeUniformType = "float" | "vec2" | "vec3" | "vec4" | "int" | "uint";

export interface ICustomRenderPassComputeUniform {
	name: string;
	type: CustomRenderPassComputeUniformType;
	value: number[];
}

export interface ICustomRenderPassComputeUniformBuffer {
	name: string;
	group: number;
	binding: number;
	uniforms: ICustomRenderPassComputeUniform[];
}

export interface ICustomRenderPassComputeStorageBuffer {
	name: string;
	group: number;
	binding: number;
	dataType: "float32" | "int32" | "uint32";
	data: number[];
	indirect: boolean;
	sharedResource: string | null;
	access: "read" | "write" | "readWrite";
}

export interface ICustomRenderPassAdditionalOutput {
	name: string;
	outputType: CustomRenderPassOutputType;
	outputFormat: CustomRenderPassOutputFormat;
	outputSamples: number;
}

export interface ICustomRenderPassDefinition {
	id: string;
	name: string;
	passType: CustomRenderPassType;
	injectionPoint: CustomRenderPassInjectionPoint;
	rendererFeature: {
		instanceId: string;
		assetId: string;
		assetPath: string;
		assetRevision: string;
		sourcePassId: string;
		sourceEnabled: boolean;
		sourceOrder: number;
		cameraFilter: {
			cameraIds: string[];
			excludeCameraIds: string[];
			projection: "any" | "perspective" | "orthographic";
			layerMask: number | null;
		};
	} | null;
	copySource: ICustomRenderPassCopySource;
	rasterSettings: ICustomRenderPassRasterSettings;
	computeSettings: ICustomRenderPassComputeSettings;
	enabled: boolean;
	order: number;
	dependencies: string[];
	fragmentShader: string;
	uniforms: Record<string, CustomRenderPassUniformValue>;
	inputs: Record<string, ICustomRenderPassResourceInput>;
	output: string | null;
	outputType: CustomRenderPassOutputType;
	outputFormat: CustomRenderPassOutputFormat;
	outputSamples: number;
	additionalOutputs: ICustomRenderPassAdditionalOutput[];
	ratio: number;
	samplingMode: CustomRenderPassSamplingMode;
}

export interface ICustomRenderPassOutputSchedule {
	name: string;
	producerId: string;
	producerName: string;
	firstUse: number;
	lastUse: number;
	consumerIds: string[];
	allocationSlot: number;
	ratio: number;
	samplingMode: CustomRenderPassSamplingMode;
	outputType: CustomRenderPassOutputType;
	outputFormat: CustomRenderPassOutputFormat;
	outputSamples: number;
	attachmentIndex: number;
	multiTarget: boolean;
	sceneRaster: boolean;
	compute: boolean;
}

export interface ICustomRenderPassSchedule {
	executionOrder: string[];
	outputs: ICustomRenderPassOutputSchedule[];
	allocationCount: number;
	sharedComputeResources: Array<{
		name: string;
		dataType: "float32" | "int32" | "uint32";
		elementCount: number;
		indirect: boolean;
		synchronization: "implicitWebGPUCommandOrder";
		usages: Array<{ passId: string; passName: string; bufferName: string; access: "read" | "write" | "readWrite" }>;
	}>;
}

export interface ICustomRenderPassFramePass {
	id: string;
	name: string;
	passType: CustomRenderPassType;
	injectionPoint: CustomRenderPassInjectionPoint;
	rendererFeatureInstanceId: string | null;
	phase: "beforeRendering" | "afterRenderingPrePasses" | "beforeRenderingPostProcessing" | "afterRenderingPostProcessing";
	enabled: boolean;
	active: boolean;
	isolated: boolean;
	culledReason: "disabled" | "debugIsolation" | "cameraFilter" | "cameraFilterDependency" | null;
	executionIndex: number | null;
	dependencies: string[];
	reads: Array<{ name: string; source: string; path: string | null; output: string | null }>;
	writes: string[];
	ready: boolean;
	error: string | null;
	executionCount: number;
	lastExecutionFrame: number | null;
	executedInCapturedFrame: boolean;
	lastCpuDurationMs: number | null;
	averageCpuDurationMs: number | null;
	gpuDurationMs: number | null;
	gpuTimingSource: string | null;
}

export interface ICustomRenderPassFrameResource {
	name: string;
	producerId: string;
	producerName: string;
	consumerIds: string[];
	firstUse: number;
	lastUse: number;
	allocationSlot: number;
	attachmentIndex: number;
	outputType: CustomRenderPassOutputType;
	outputFormat: CustomRenderPassOutputFormat;
	samples: number;
	ratio: number;
	allocated: boolean;
	ready: boolean;
	width: number | null;
	height: number | null;
	textureClass: string | null;
}

export interface ICustomRenderPassFrameSnapshot {
	version: 1;
	captureId: number;
	capturedAt: string;
	frameId: number;
	backend: string;
	cameraId: string;
	cameraName: string;
	renderWidth: number;
	renderHeight: number;
	isolationPassId: string | null;
	authoredPassCount: number;
	activePassCount: number;
	culledPassCount: number;
	resourceCount: number;
	allocationCount: number;
	passes: ICustomRenderPassFramePass[];
	resources: ICustomRenderPassFrameResource[];
}

export const defaultCustomRenderPassFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
void main(void) {
	gl_FragColor = texture2D(textureSampler, vUV);
}
`.trim();

export const defaultCustomRenderPassComputeShader = `
@group(0) @binding(0) var outputTexture : texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id : vec3<u32>) {
	let size = textureDimensions(outputTexture);
	if (id.x >= size.x || id.y >= size.y) {
		return;
	}
	let uv = vec2<f32>(id.xy) / vec2<f32>(size);
	textureStore(outputTexture, vec2<i32>(id.xy), vec4<f32>(uv, 0.5, 1.0));
}
`.trim();

const copyScreenFragmentShader = defaultCustomRenderPassFragmentShader;
const copyResourceFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D copySampler;
void main(void) {
	gl_FragColor = texture2D(copySampler, vUV);
}
`.trim();

const postProcesses = new WeakMap<Camera, PostProcess[]>();
const ownedTextures = new WeakMap<Camera, Texture[]>();
const configuredSignatures = new WeakMap<Camera, string>();
const appliedDefinitions = new WeakMap<Camera, ICustomRenderPassDefinition[]>();
const authoredDefinitionsByCamera = new WeakMap<Camera, ICustomRenderPassDefinition[]>();
const failedSignatures = new WeakMap<Camera, string>();
const runtimeErrors = new WeakMap<Camera, string>();
const debugIsolationPassIds = new WeakMap<Camera, string>();
const frameSnapshots = new WeakMap<Camera, ICustomRenderPassFrameSnapshot>();
const frameCaptureSequences = new WeakMap<Camera, number>();
const passCpuMetrics = new WeakMap<
	Camera,
	Map<string, { executionCount: number; lastExecutionFrame: number | null; lastCpuDurationMs: number | null; totalCpuDurationMs: number; startedAt: number | null }>
>();
const multiRenderTargets = new WeakMap<Camera, Array<{ target: MultiRenderTarget; restorePrimary: () => void }>>();
const singleOutputTargets = new WeakMap<
	Camera,
	Array<{
		id: string;
		name: string;
		output: string;
		passType: "shader" | "copy";
		target: RenderTargetTexture;
		capture: PostProcess;
		rendered: boolean;
	}>
>();
interface ICustomRenderPassRasterRuntime {
	id: string;
	name: string;
	output: string;
	target: RenderTargetTexture;
	meshIds: string[];
	cameraId: string;
	overrideMaterial: Material | null;
	settings: ICustomRenderPassRasterSettings;
	rendererList: IRendererListDefinition | null;
	resolutionObserver: any | null;
	resolutionError: string | null;
	overrideMeshes: Set<AbstractMesh>;
}

const sceneRasterTargets = new WeakMap<Camera, ICustomRenderPassRasterRuntime[]>();
const computeTargets = new WeakMap<
	Camera,
	Array<{
		id: string;
		name: string;
		output: string;
		target: RenderTargetTexture;
		shader: ComputeShader;
		observer: any;
		error: string | null;
		dispatched: boolean;
		dispatchCount: number;
		lastCpuDispatchDurationMs: number | null;
		totalCpuDispatchDurationMs: number;
		submitAfterDispatch: boolean;
		resources: Array<{ name: string; source: string; path: string | null; output: string | null; texture: BaseTexture }>;
		uniformBuffers: Array<{ definition: ICustomRenderPassComputeUniformBuffer; buffer: UniformBuffer }>;
		storageBuffers: Array<{ definition: ICustomRenderPassComputeStorageBuffer; buffer: StorageBuffer }>;
	}>
>();
const depthStates = new WeakMap<Camera, { renderer: any; previousEnabled: boolean }>();

type CustomRenderPassGpuProfilingMode = "webgpu-timestamp" | "webgl-timestamp" | "unavailable";

interface ICustomRenderPassGpuProfileRecord {
	id: string;
	name: string;
	passType: CustomRenderPassType;
	source: "renderTarget" | "computeShader" | "timerQuery" | "unavailable";
	samplesNs: number[];
	lastSampleFrame: number | null;
	droppedSampleCount: number;
	getCounter: (() => any) | null;
	lastCounterCount: number;
}

interface ICustomRenderPassGpuProfileRuntime {
	scene: Scene;
	camera: Camera;
	mode: CustomRenderPassGpuProfilingMode;
	supported: boolean;
	reason: string | null;
	sampleCapacity: number;
	records: ICustomRenderPassGpuProfileRecord[];
	observer: any;
	observable: any;
	activeToken: any;
	activeRecord: ICustomRenderPassGpuProfileRecord | null;
	activeEnded: boolean;
	nextRecordIndex: number;
}

const gpuProfileConfigurations = new WeakMap<Camera, { enabled: boolean; sampleCapacity: number }>();
const gpuProfileRuntimes = new WeakMap<Camera, ICustomRenderPassGpuProfileRuntime>();

function appendGpuProfileSample(runtime: ICustomRenderPassGpuProfileRuntime, record: ICustomRenderPassGpuProfileRecord, durationNs: number): void {
	if (!Number.isFinite(durationNs) || durationNs < 0) {
		return;
	}
	record.samplesNs.push(durationNs);
	if (record.samplesNs.length > runtime.sampleCapacity) {
		record.samplesNs.splice(0, record.samplesNs.length - runtime.sampleCapacity);
	}
	record.lastSampleFrame = runtime.scene.getEngine().frameId;
}

function finishWebGlGpuProfileSample(runtime: ICustomRenderPassGpuProfileRuntime, durationNs: number): void {
	if (runtime.activeRecord) {
		appendGpuProfileSample(runtime, runtime.activeRecord, durationNs);
	}
	const recordIndex = runtime.activeRecord ? runtime.records.indexOf(runtime.activeRecord) : runtime.nextRecordIndex;
	runtime.activeToken = null;
	runtime.activeRecord = null;
	runtime.activeEnded = false;
	if (runtime.records.length) {
		runtime.nextRecordIndex = (Math.max(0, recordIndex) + 1) % runtime.records.length;
	}
}

function pollGpuProfiler(runtime: ICustomRenderPassGpuProfileRuntime): void {
	const engine = runtime.scene.getEngine() as any;
	if (runtime.mode === "webgl-timestamp") {
		if (!runtime.activeToken || !runtime.activeEnded) {
			return;
		}
		const durationNs = engine.endTimeQuery(runtime.activeToken);
		if (durationNs >= 0) {
			finishWebGlGpuProfileSample(runtime, durationNs);
		}
		return;
	}
	if (runtime.mode !== "webgpu-timestamp") {
		return;
	}
	for (const record of runtime.records) {
		let gpuCounter: any = null;
		try {
			gpuCounter = record.getCounter?.()?.counter ?? null;
		} catch {
			gpuCounter = null;
		}
		if (!gpuCounter || gpuCounter.count <= record.lastCounterCount) {
			continue;
		}
		record.lastCounterCount = gpuCounter.count;
		appendGpuProfileSample(runtime, record, gpuCounter.current);
	}
}

function createGpuProfileRuntime(scene: Scene, camera: Camera, previous: ICustomRenderPassGpuProfileRuntime | undefined): ICustomRenderPassGpuProfileRuntime | null {
	const configuration = gpuProfileConfigurations.get(camera);
	if (!configuration?.enabled) {
		return null;
	}
	const engine = scene.getEngine() as any;
	const capabilities = engine.getCaps();
	let mode: CustomRenderPassGpuProfilingMode = "unavailable";
	let reason: string | null = null;
	if (engine.isWebGPU) {
		if (!capabilities.timerQuery || !("enableGPUTimingMeasurements" in engine)) {
			reason = "This WebGPU device was not created with the timestamp-query feature enabled.";
		} else {
			try {
				engine.enableGPUTimingMeasurements = true;
				if (engine.enableGPUTimingMeasurements) {
					mode = "webgpu-timestamp";
				} else {
					reason = "WebGPU timestamp queries could not be enabled on this device.";
				}
			} catch (error) {
				reason = error instanceof Error ? error.message : String(error);
			}
		}
	} else if (capabilities.timerQuery && capabilities.canUseTimestampForTimerQuery && typeof engine.startTimeQuery === "function" && typeof engine.endTimeQuery === "function") {
		mode = "webgl-timestamp";
	} else if (capabilities.timerQuery) {
		reason = "This WebGL backend exposes only a shared elapsed-time query, so isolated pass timing would conflict with frame profiling.";
	} else {
		reason = "The active rendering backend does not expose GPU timestamp queries.";
	}
	const runtime: ICustomRenderPassGpuProfileRuntime = {
		scene,
		camera,
		mode,
		supported: mode !== "unavailable",
		reason,
		sampleCapacity: configuration.sampleCapacity,
		records: [],
		observer: null,
		observable: null,
		activeToken: null,
		activeRecord: null,
		activeEnded: false,
		nextRecordIndex: previous?.nextRecordIndex ?? 0,
	};
	return runtime;
}

function registerGpuProfileRecord(
	runtime: ICustomRenderPassGpuProfileRuntime | null,
	pass: ICustomRenderPassDefinition,
	configuration: {
		source: ICustomRenderPassGpuProfileRecord["source"];
		getCounter: (() => any) | null;
		beforeObservable?: any;
		afterObservable?: any;
		previous?: ICustomRenderPassGpuProfileRuntime;
	}
): void {
	if (!runtime) {
		return;
	}
	const oldRecord = configuration.previous?.records.find((candidate) => candidate.id === pass.id);
	const record: ICustomRenderPassGpuProfileRecord = {
		id: pass.id,
		name: pass.name,
		passType: pass.passType,
		source: runtime.mode === "webgl-timestamp" ? "timerQuery" : runtime.supported ? configuration.source : "unavailable",
		samplesNs: oldRecord?.samplesNs.slice(-runtime.sampleCapacity) ?? [],
		lastSampleFrame: oldRecord?.lastSampleFrame ?? null,
		droppedSampleCount: oldRecord?.droppedSampleCount ?? 0,
		getCounter: configuration.getCounter,
		lastCounterCount: 0,
	};
	runtime.records.push(record);
	if (runtime.mode !== "webgl-timestamp" || !configuration.beforeObservable || !configuration.afterObservable) {
		return;
	}
	configuration.beforeObservable.add(() => {
		if (runtime.activeToken || runtime.records[runtime.nextRecordIndex] !== record) {
			return;
		}
		const token = (runtime.scene.getEngine() as any).startTimeQuery();
		if (!token) {
			record.droppedSampleCount++;
			runtime.nextRecordIndex = runtime.records.length ? (runtime.nextRecordIndex + 1) % runtime.records.length : 0;
			return;
		}
		runtime.activeToken = token;
		runtime.activeRecord = record;
		runtime.activeEnded = false;
	});
	configuration.afterObservable.add(() => {
		if (runtime.activeRecord !== record || !runtime.activeToken || runtime.activeEnded) {
			return;
		}
		const durationNs = (runtime.scene.getEngine() as any).endTimeQuery(runtime.activeToken);
		runtime.activeEnded = true;
		if (durationNs >= 0) {
			finishWebGlGpuProfileSample(runtime, durationNs);
		}
	});
}

function startGpuProfilePolling(runtime: ICustomRenderPassGpuProfileRuntime | null): void {
	if (!runtime?.supported) {
		return;
	}
	runtime.observable = runtime.mode === "webgpu-timestamp" ? runtime.scene.onAfterRenderObservable : runtime.scene.onBeforeRenderObservable;
	runtime.observer = runtime.observable.add(() => pollGpuProfiler(runtime));
}

interface ICustomRenderPassOutputResource {
	bind(effect: Effect, samplerName: string): void;
	isReady(): boolean;
	texture?: BaseTexture;
}

function samplingMode(mode: CustomRenderPassSamplingMode): number {
	switch (mode) {
		case "nearest":
			return Constants.TEXTURE_NEAREST_SAMPLINGMODE;
		case "trilinear":
			return Constants.TEXTURE_TRILINEAR_SAMPLINGMODE;
		default:
			return Constants.TEXTURE_BILINEAR_SAMPLINGMODE;
	}
}

function outputTextureType(type: CustomRenderPassOutputType): number {
	if (type === "float") {
		return Constants.TEXTURETYPE_FLOAT;
	}
	if (type === "halfFloat") {
		return Constants.TEXTURETYPE_HALF_FLOAT;
	}
	return Constants.TEXTURETYPE_UNSIGNED_BYTE;
}

function outputTextureFormat(format: CustomRenderPassOutputFormat): number {
	if (format === "r") {
		return Constants.TEXTUREFORMAT_R;
	}
	if (format === "rg") {
		return Constants.TEXTUREFORMAT_RG;
	}
	return Constants.TEXTUREFORMAT_RGBA;
}

function passOutputs(pass: ICustomRenderPassDefinition): ICustomRenderPassAdditionalOutput[] {
	if (!pass.output) {
		return [];
	}
	return [{ name: pass.output, outputType: pass.outputType, outputFormat: pass.outputFormat, outputSamples: pass.outputSamples }, ...pass.additionalOutputs];
}

function multiTargetFragmentShader(source: string, outputCount: number): string {
	if (outputCount < 2) {
		return source;
	}
	const precision = source.match(/precision\s+(?:lowp|mediump|highp)\s+float\s*;/)?.[0];
	if (!precision) {
		throw new Error("MRT fragment shaders must declare float precision before writing multiple attachments.");
	}
	const extension = `#if !defined(WEBGL2) && !defined(WEBGPU) && !defined(NATIVE)
#extension GL_EXT_draw_buffers : require
#endif`;
	const declaration = `#if defined(WEBGL2) || defined(WEBGPU) || defined(NATIVE)
layout(location=0) out vec4 glFragData[${outputCount}];
#endif`;
	return `${extension}\n${source.replace(precision, `${precision}\n${declaration}\n`)}`;
}

function shaderHash(source: string): string {
	let hash = 2166136261;
	for (let index = 0; index < source.length; index++) {
		hash ^= source.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16);
}

function validateUniforms(uniforms: Record<string, CustomRenderPassUniformValue>): void {
	if (!uniforms || typeof uniforms !== "object" || Array.isArray(uniforms)) {
		throw new Error("Custom render-pass uniforms must be an object.");
	}
	for (const [name, value] of Object.entries(uniforms)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "textureSampler") {
			throw new Error(`Invalid custom render-pass uniform name "${name}".`);
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) {
				throw new Error(`Custom render-pass uniform "${name}" must be finite.`);
			}
		} else if (!Array.isArray(value) || value.length < 2 || value.length > 4 || !value.every(Number.isFinite)) {
			throw new Error(`Custom render-pass uniform "${name}" must be a finite number or a 2–4 number vector.`);
		}
	}
}

function validateInputs(pass: ICustomRenderPassDefinition): void {
	if (!pass.inputs || typeof pass.inputs !== "object" || Array.isArray(pass.inputs)) {
		throw new Error(`Custom render-pass "${pass.name}" inputs must be an object.`);
	}
	const entries = Object.entries(pass.inputs);
	if (entries.length > 16) {
		throw new Error(`Custom render-pass "${pass.name}" supports at most 16 resource inputs.`);
	}
	for (const [name, input] of entries) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "textureSampler" || name in pass.uniforms) {
			throw new Error(`Invalid or duplicated custom render-pass resource sampler name "${name}".`);
		}
		if (!input || !["depth", "normal", "texture", "pass"].includes(input.source)) {
			throw new Error(`Custom render-pass resource "${name}" must use source depth, normal, texture, or pass.`);
		}
		if (input.source === "texture" && (!input.path?.trim() || input.path.length > 4096)) {
			throw new Error(`Custom render-pass texture resource "${name}" requires a project-relative path.`);
		}
		if (input.source === "pass" && !input.output?.trim()) {
			throw new Error(`Custom render-pass resource "${name}" requires a named pass output.`);
		}
		if (!new RegExp(`\\b${name}\\b`).test(pass.fragmentShader)) {
			throw new Error(`Custom render-pass "${pass.name}" fragmentShader does not reference resource sampler "${name}".`);
		}
	}
}

function validateCopySource(pass: ICustomRenderPassDefinition): void {
	const source = pass.copySource;
	if (!source || !["screen", "depth", "normal", "texture", "pass"].includes(source.source)) {
		throw new Error(`Copy pass "${pass.name}" source must be screen, depth, normal, texture, or pass.`);
	}
	if (source.source === "texture" && (!source.path?.trim() || source.path.length > 4096)) {
		throw new Error(`Copy pass "${pass.name}" texture source requires a project-relative path.`);
	}
	if (source.source === "pass" && !source.output?.trim()) {
		throw new Error(`Copy pass "${pass.name}" requires a named pass output source.`);
	}
}

function defaultRasterSettings(): ICustomRenderPassRasterSettings {
	return {
		rendererListId: null,
		cameraId: null,
		meshIds: [],
		includeDescendants: false,
		layerMask: null,
		materialId: null,
		clearColor: [0, 0, 0, 0],
		clearMode: "colorDepth",
		depthTest: true,
		depthWrite: true,
		cullMode: "back",
		blendMode: "opaque",
		renderParticles: false,
		renderSprites: false,
		useCameraPostProcesses: false,
		refreshRate: "everyFrame",
	};
}

function defaultComputeSettings(): ICustomRenderPassComputeSettings {
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

export const customRenderPassInjectionPoints: CustomRenderPassInjectionPoint[] = [
	"beforeRendering",
	"afterRenderingPrePasses",
	"beforeRenderingPostProcessing",
	"afterRenderingPostProcessing",
];

export function defaultCustomRenderPassInjectionPoint(passType: CustomRenderPassType): CustomRenderPassInjectionPoint {
	return passType === "raster" ? "beforeRendering" : passType === "compute" ? "afterRenderingPrePasses" : "afterRenderingPostProcessing";
}

function injectionPointIndex(value: CustomRenderPassInjectionPoint): number {
	return customRenderPassInjectionPoints.indexOf(value);
}

function validateRendererFeatureReference(pass: ICustomRenderPassDefinition): void {
	const feature = pass.rendererFeature;
	if (feature === null) {
		return;
	}
	if (
		!feature ||
		![feature.instanceId, feature.assetId, feature.assetPath, feature.assetRevision, feature.sourcePassId].every(
			(value) => typeof value === "string" && value.trim() && value.length <= 4096
		)
	) {
		throw new Error(`Custom render-pass "${pass.name}" has invalid renderer-feature identity metadata.`);
	}
	if (typeof feature.sourceEnabled !== "boolean" || !Number.isFinite(feature.sourceOrder)) {
		throw new Error(`Custom render-pass "${pass.name}" has invalid renderer-feature source state.`);
	}
	const filter = feature.cameraFilter;
	if (!filter || !Array.isArray(filter.cameraIds) || !Array.isArray(filter.excludeCameraIds)) {
		throw new Error(`Custom render-pass "${pass.name}" has an invalid renderer-feature camera filter.`);
	}
	for (const [label, values] of [
		["cameraIds", filter.cameraIds],
		["excludeCameraIds", filter.excludeCameraIds],
	] as const) {
		if (values.length > 64 || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 256) || new Set(values).size !== values.length) {
			throw new Error(`Custom render-pass "${pass.name}" renderer-feature ${label} must contain at most 64 unique bounded camera ids.`);
		}
	}
	if (!["any", "perspective", "orthographic"].includes(filter.projection)) {
		throw new Error(`Custom render-pass "${pass.name}" renderer-feature projection filter is invalid.`);
	}
	if (filter.layerMask !== null && (!Number.isInteger(filter.layerMask) || filter.layerMask < 0 || filter.layerMask > 4_294_967_295)) {
		throw new Error(`Custom render-pass "${pass.name}" renderer-feature layerMask must be null or an unsigned 32-bit integer.`);
	}
}

function passMatchesCamera(pass: ICustomRenderPassDefinition, camera: Camera): boolean {
	const filter = pass.rendererFeature?.cameraFilter;
	if (!filter) {
		return true;
	}
	if (!rendererDataAllowsFeature(camera.getScene(), camera, pass.rendererFeature!.instanceId)) {
		return false;
	}
	if (filter.cameraIds.length && !filter.cameraIds.includes(camera.id)) {
		return false;
	}
	if (filter.excludeCameraIds.includes(camera.id)) {
		return false;
	}
	if (filter.projection === "orthographic" && camera.mode !== Camera.ORTHOGRAPHIC_CAMERA) {
		return false;
	}
	if (filter.projection === "perspective" && camera.mode === Camera.ORTHOGRAPHIC_CAMERA) {
		return false;
	}
	if (filter.layerMask !== null && (camera.layerMask & filter.layerMask) === 0) {
		return false;
	}
	return true;
}

function cameraEligibleDefinitions(passes: ICustomRenderPassDefinition[], camera: Camera): ICustomRenderPassDefinition[] {
	const eligibleIds = new Set(passes.filter((pass) => passMatchesCamera(pass, camera)).map((pass) => pass.id));
	let changed = true;
	while (changed) {
		changed = false;
		for (const pass of passes) {
			if (eligibleIds.has(pass.id) && pass.dependencies.some((dependency) => !eligibleIds.has(dependency))) {
				eligibleIds.delete(pass.id);
				changed = true;
			}
		}
	}
	return passes.filter((pass) => eligibleIds.has(pass.id));
}

function validateRasterSettings(pass: ICustomRenderPassDefinition): void {
	const settings = pass.rasterSettings;
	if (settings && settings.rendererListId !== null && (typeof settings.rendererListId !== "string" || !settings.rendererListId.trim() || settings.rendererListId.length > 128)) {
		throw new Error(`Raster pass "${pass.name}" rendererListId must be null or a bounded non-empty renderer-list id.`);
	}
	if (!settings || (settings.cameraId !== null && (typeof settings.cameraId !== "string" || !settings.cameraId.trim()))) {
		throw new Error(`Raster pass "${pass.name}" cameraId must be null or a non-empty camera id.`);
	}
	if (
		!Array.isArray(settings.meshIds) ||
		settings.meshIds.length > 4096 ||
		settings.meshIds.some((id) => typeof id !== "string" || !id.trim()) ||
		new Set(settings.meshIds).size !== settings.meshIds.length
	) {
		throw new Error(`Raster pass "${pass.name}" meshIds must contain at most 4096 unique non-empty mesh ids.`);
	}
	if (typeof settings.includeDescendants !== "boolean") {
		throw new Error(`Raster pass "${pass.name}" includeDescendants must be boolean.`);
	}
	if (settings.rendererListId !== null && (settings.cameraId !== null || settings.meshIds.length || settings.includeDescendants || settings.layerMask !== null)) {
		throw new Error(`Raster pass "${pass.name}" must leave cameraId, meshIds, includeDescendants, and layerMask at their defaults when rendererListId is assigned.`);
	}
	if (settings.layerMask !== null && (!Number.isInteger(settings.layerMask) || settings.layerMask < 0 || settings.layerMask > 4_294_967_295)) {
		throw new Error(`Raster pass "${pass.name}" layerMask must be null or an unsigned 32-bit integer.`);
	}
	if (settings.materialId !== null && (typeof settings.materialId !== "string" || !settings.materialId.trim())) {
		throw new Error(`Raster pass "${pass.name}" materialId must be null or a non-empty material id.`);
	}
	if (!Array.isArray(settings.clearColor) || settings.clearColor.length !== 4 || settings.clearColor.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
		throw new Error(`Raster pass "${pass.name}" clearColor must contain four values from 0 through 1.`);
	}
	if (!["colorDepth", "depthOnly", "none"].includes(settings.clearMode)) {
		throw new Error(`Raster pass "${pass.name}" has an unsupported clearMode.`);
	}
	if (!["back", "front", "none"].includes(settings.cullMode)) {
		throw new Error(`Raster pass "${pass.name}" has an unsupported cullMode.`);
	}
	if (!["opaque", "alpha", "additive", "multiply", "premultiplied"].includes(settings.blendMode)) {
		throw new Error(`Raster pass "${pass.name}" has an unsupported blendMode.`);
	}
	if (!["once", "everyFrame", "everyTwoFrames"].includes(settings.refreshRate)) {
		throw new Error(`Raster pass "${pass.name}" has an unsupported refreshRate.`);
	}
	for (const property of ["depthTest", "depthWrite", "renderParticles", "renderSprites", "useCameraPostProcesses"] as const) {
		if (typeof settings[property] !== "boolean") {
			throw new Error(`Raster pass "${pass.name}" ${property} must be boolean.`);
		}
	}
}

function validateComputeSettings(pass: ICustomRenderPassDefinition): void {
	const settings = pass.computeSettings;
	if (!settings || typeof settings.wgsl !== "string" || settings.wgsl.length > 100_000 || !/@compute\b/.test(settings.wgsl)) {
		throw new Error(`Compute pass "${pass.name}" WGSL must contain @compute and be at most 100000 characters.`);
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.entryPoint) || !new RegExp(`\\bfn\\s+${settings.entryPoint}\\s*\\(`).test(settings.wgsl)) {
		throw new Error(`Compute pass "${pass.name}" entryPoint must name a WGSL function.`);
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.outputBindingName) || !new RegExp(`\\b${settings.outputBindingName}\\b`).test(settings.wgsl)) {
		throw new Error(`Compute pass "${pass.name}" outputBindingName must name a WGSL storage texture.`);
	}
	for (const [label, value] of [
		["outputGroup", settings.outputGroup],
		["outputBinding", settings.outputBinding],
	] as const) {
		if (!Number.isInteger(value) || value < 0 || value > 15) {
			throw new Error(`Compute pass "${pass.name}" ${label} must be an integer from 0 through 15.`);
		}
	}
	if (!Array.isArray(settings.dispatch) || settings.dispatch.length !== 3 || settings.dispatch.some((value) => !Number.isInteger(value) || value < 1 || value > 65535)) {
		throw new Error(`Compute pass "${pass.name}" dispatch must contain three integers from 1 through 65535.`);
	}
	if (!["once", "everyFrame"].includes(settings.dispatchMode)) {
		throw new Error(`Compute pass "${pass.name}" has an unsupported dispatchMode.`);
	}
	if (!["direct", "indirect"].includes(settings.dispatchType)) {
		throw new Error(`Compute pass "${pass.name}" has an unsupported dispatchType.`);
	}
	if (typeof settings.submitAfterDispatch !== "boolean") {
		throw new Error(`Compute pass "${pass.name}" submitAfterDispatch must be boolean.`);
	}
	if (!Number.isInteger(settings.indirectOffset) || settings.indirectOffset < 0 || settings.indirectOffset > 1_048_576 || settings.indirectOffset % 4) {
		throw new Error(`Compute pass "${pass.name}" indirectOffset must be a 4-byte-aligned integer from 0 through 1048576.`);
	}
	if (pass.outputFormat !== "rgba") {
		throw new Error(`Compute pass "${pass.name}" currently requires an RGBA storage-texture output.`);
	}
	if (pass.outputSamples !== 1) {
		throw new Error(`Compute pass "${pass.name}" storage-texture output cannot use MSAA.`);
	}
	const occupied = new Set([`${settings.outputGroup}:${settings.outputBinding}`]);
	const resourceNames = new Set([settings.outputBindingName]);
	for (const [name, input] of Object.entries(pass.inputs)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !new RegExp(`\\b${name}\\b`).test(settings.wgsl)) {
			throw new Error(`Compute pass "${pass.name}" has an invalid or unused WGSL input binding "${name}".`);
		}
		if (!["texture", "pass"].includes(input.source)) {
			throw new Error(`Compute pass "${pass.name}" input "${name}" must use a project texture or named pass output.`);
		}
		if (input.source === "texture" && (!input.path?.trim() || input.path.length > 4096)) {
			throw new Error(`Compute pass "${pass.name}" input "${name}" requires a project-relative path.`);
		}
		if (input.source === "pass" && !input.output?.trim()) {
			throw new Error(`Compute pass "${pass.name}" input "${name}" requires a named pass output.`);
		}
		if (!Number.isInteger(input.group) || input.group! < 0 || input.group! > 15 || !Number.isInteger(input.binding) || input.binding! < 0 || input.binding! > 15) {
			throw new Error(`Compute pass "${pass.name}" input "${name}" requires group and binding integers from 0 through 15.`);
		}
		const location = `${input.group}:${input.binding}`;
		if (occupied.has(location)) {
			throw new Error(`Compute pass "${pass.name}" duplicates binding location ${location}.`);
		}
		occupied.add(location);
		if (resourceNames.has(name)) {
			throw new Error(`Compute pass "${pass.name}" duplicates resource binding name "${name}".`);
		}
		resourceNames.add(name);
	}
	if (!Array.isArray(settings.uniformBuffers) || settings.uniformBuffers.length > 16) {
		throw new Error(`Compute pass "${pass.name}" supports at most 16 uniform buffers.`);
	}
	for (const buffer of settings.uniformBuffers) {
		validateComputeBufferBinding(pass, buffer, occupied, resourceNames, "uniform");
		if (!Array.isArray(buffer.uniforms) || !buffer.uniforms.length || buffer.uniforms.length > 64) {
			throw new Error(`Compute pass "${pass.name}" uniform buffer "${buffer.name}" requires 1 through 64 uniforms.`);
		}
		const uniformNames = new Set<string>();
		for (const uniform of buffer.uniforms) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(uniform.name) || uniformNames.has(uniform.name)) {
				throw new Error(`Compute pass "${pass.name}" uniform buffer "${buffer.name}" has an invalid or duplicated uniform name.`);
			}
			uniformNames.add(uniform.name);
			const expectedLength = uniform.type === "vec2" ? 2 : uniform.type === "vec3" ? 3 : uniform.type === "vec4" ? 4 : 1;
			if (!Array.isArray(uniform.value) || uniform.value.length !== expectedLength || !uniform.value.every(Number.isFinite)) {
				throw new Error(`Compute pass "${pass.name}" uniform "${uniform.name}" requires ${expectedLength} finite value(s).`);
			}
			if (["int", "uint"].includes(uniform.type) && (!uniform.value.every(Number.isInteger) || (uniform.type === "uint" && uniform.value.some((value) => value < 0)))) {
				throw new Error(`Compute pass "${pass.name}" uniform "${uniform.name}" requires ${uniform.type === "uint" ? "non-negative " : ""}integer data.`);
			}
			if (uniform.type === "int" && uniform.value.some((value) => value < -2_147_483_648 || value > 2_147_483_647)) {
				throw new Error(`Compute pass "${pass.name}" uniform "${uniform.name}" exceeds the int32 range.`);
			}
			if (uniform.type === "uint" && uniform.value.some((value) => value > 4_294_967_295)) {
				throw new Error(`Compute pass "${pass.name}" uniform "${uniform.name}" exceeds the uint32 range.`);
			}
		}
	}
	if (!Array.isArray(settings.storageBuffers) || settings.storageBuffers.length > 16) {
		throw new Error(`Compute pass "${pass.name}" supports at most 16 storage buffers.`);
	}
	for (const buffer of settings.storageBuffers) {
		validateComputeBufferBinding(pass, buffer, occupied, resourceNames, "storage");
		if (!["float32", "int32", "uint32"].includes(buffer.dataType)) {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" has an unsupported dataType.`);
		}
		if (!Array.isArray(buffer.data) || !buffer.data.length || buffer.data.length > 262_144 || !buffer.data.every(Number.isFinite)) {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" requires 1 through 262144 finite values.`);
		}
		if (buffer.dataType !== "float32" && (!buffer.data.every(Number.isInteger) || (buffer.dataType === "uint32" && buffer.data.some((value) => value < 0)))) {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" requires ${buffer.dataType === "uint32" ? "non-negative " : ""}integer data.`);
		}
		if (typeof buffer.indirect !== "boolean") {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" indirect must be boolean.`);
		}
		if (buffer.sharedResource !== null && (typeof buffer.sharedResource !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(buffer.sharedResource))) {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" sharedResource must be null or a shader-style identifier.`);
		}
		if (!["read", "write", "readWrite"].includes(buffer.access)) {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" has an unsupported access mode.`);
		}
		if (buffer.dataType === "int32" && buffer.data.some((value) => value < -2_147_483_648 || value > 2_147_483_647)) {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" exceeds the int32 range.`);
		}
		if (buffer.dataType === "uint32" && buffer.data.some((value) => value > 4_294_967_295)) {
			throw new Error(`Compute pass "${pass.name}" storage buffer "${buffer.name}" exceeds the uint32 range.`);
		}
		if (buffer.indirect && buffer.dataType !== "uint32") {
			throw new Error(`Compute pass "${pass.name}" indirect storage buffer "${buffer.name}" must use uint32 data.`);
		}
	}
	if (settings.dispatchType === "indirect") {
		const indirect = settings.storageBuffers.find((buffer) => buffer.name === settings.indirectBuffer);
		if (!indirect?.indirect) {
			throw new Error(`Compute pass "${pass.name}" indirect dispatch requires indirectBuffer to name a storage buffer with indirect enabled.`);
		}
		if (indirect.dataType !== "uint32") {
			throw new Error(`Compute pass "${pass.name}" indirect dispatch buffer must use uint32 data.`);
		}
		if (settings.indirectOffset + 12 > indirect.data.length * 4) {
			throw new Error(`Compute pass "${pass.name}" indirect dispatch requires three uint32 values at indirectOffset.`);
		}
		const workgroups = indirect.data.slice(settings.indirectOffset / 4, settings.indirectOffset / 4 + 3);
		if (workgroups.some((value) => value > 65535)) {
			throw new Error(`Compute pass "${pass.name}" indirect workgroup counts must not exceed 65535.`);
		}
	}
}

function validateComputeBufferBinding(
	pass: ICustomRenderPassDefinition,
	buffer: { name: string; group: number; binding: number },
	occupied: Set<string>,
	resourceNames: Set<string>,
	kind: "uniform" | "storage"
): void {
	if (!buffer || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(buffer.name) || !new RegExp(`\\b${buffer.name}\\b`).test(pass.computeSettings.wgsl)) {
		throw new Error(`Compute pass "${pass.name}" has an invalid or unused WGSL ${kind} buffer binding.`);
	}
	if (!Number.isInteger(buffer.group) || buffer.group < 0 || buffer.group > 15 || !Number.isInteger(buffer.binding) || buffer.binding < 0 || buffer.binding > 15) {
		throw new Error(`Compute pass "${pass.name}" ${kind} buffer "${buffer.name}" requires group and binding integers from 0 through 15.`);
	}
	const location = `${buffer.group}:${buffer.binding}`;
	if (occupied.has(location)) {
		throw new Error(`Compute pass "${pass.name}" duplicates binding location ${location}.`);
	}
	if (resourceNames.has(buffer.name)) {
		throw new Error(`Compute pass "${pass.name}" duplicates resource binding name "${buffer.name}".`);
	}
	occupied.add(location);
	resourceNames.add(buffer.name);
}

function runtimeInputs(pass: ICustomRenderPassDefinition): Record<string, ICustomRenderPassResourceInput> {
	if (pass.passType === "raster") {
		return {};
	}
	if (pass.passType !== "copy" || pass.copySource.source === "screen") {
		return pass.passType === "copy" ? {} : pass.inputs;
	}
	return { copySampler: { source: pass.copySource.source, path: pass.copySource.path, output: pass.copySource.output } as ICustomRenderPassResourceInput };
}

function dependsOnPass(pass: ICustomRenderPassDefinition, dependencyId: string, byId: Map<string, ICustomRenderPassDefinition>, visited = new Set<string>()): boolean {
	if (pass.dependencies.includes(dependencyId)) {
		return true;
	}
	if (visited.has(pass.id)) {
		return false;
	}
	visited.add(pass.id);
	return pass.dependencies.some((id) => dependsOnPass(byId.get(id)!, dependencyId, byId, visited));
}

function validateSharedComputeResources(ordered: ICustomRenderPassDefinition[], byId: Map<string, ICustomRenderPassDefinition>): void {
	const resources = new Map<string, Array<{ pass: ICustomRenderPassDefinition; buffer: ICustomRenderPassComputeStorageBuffer }>>();
	for (const pass of ordered.filter((candidate) => candidate.passType === "compute")) {
		const localNames = new Set<string>();
		for (const buffer of pass.computeSettings.storageBuffers.filter((candidate) => candidate.sharedResource)) {
			if (localNames.has(buffer.sharedResource!)) {
				throw new Error(`Compute pass "${pass.name}" binds shared resource "${buffer.sharedResource}" more than once.`);
			}
			localNames.add(buffer.sharedResource!);
			const usages = resources.get(buffer.sharedResource!) ?? [];
			usages.push({ pass, buffer });
			resources.set(buffer.sharedResource!, usages);
		}
	}
	for (const [name, usages] of resources) {
		const first = usages[0].buffer;
		for (const { pass, buffer } of usages.slice(1)) {
			if (
				buffer.dataType !== first.dataType ||
				buffer.data.length !== first.data.length ||
				buffer.indirect !== first.indirect ||
				buffer.data.some((value, index) => value !== first.data[index])
			) {
				throw new Error(
					`Shared compute resource "${name}" must use identical dataType, element count, initial data, and indirect usage in every pass; mismatch found in "${pass.name}".`
				);
			}
		}
		for (let laterIndex = 1; laterIndex < usages.length; laterIndex++) {
			const later = usages[laterIndex];
			for (let earlierIndex = 0; earlierIndex < laterIndex; earlierIndex++) {
				const earlier = usages[earlierIndex];
				if (earlier.buffer.access === "read" && later.buffer.access === "read") {
					continue;
				}
				if (!dependsOnPass(later.pass, earlier.pass.id, byId)) {
					throw new Error(
						`Shared compute resource "${name}" has an unordered ${earlier.buffer.access}→${later.buffer.access} hazard between "${earlier.pass.name}" and "${later.pass.name}"; add a dependency path.`
					);
				}
			}
		}
	}
}

/** Validates and returns the deterministic dependency order for a custom full-screen pass graph. */
export function sortCustomRenderPassGraph(passes: ICustomRenderPassDefinition[]): ICustomRenderPassDefinition[] {
	if (!Array.isArray(passes)) {
		throw new Error("Custom render passes must be an array.");
	}
	if (passes.length > 64) {
		throw new Error("A custom render-pass graph supports at most 64 passes.");
	}
	const byId = new Map<string, ICustomRenderPassDefinition>();
	passes.forEach((pass) => {
		pass.passType ??= "shader";
		pass.injectionPoint ??= defaultCustomRenderPassInjectionPoint(pass.passType);
		pass.rendererFeature ??= null;
		pass.copySource ??= { source: "screen" };
		pass.rasterSettings = {
			...defaultRasterSettings(),
			...(pass.rasterSettings ?? {}),
			meshIds: [...(pass.rasterSettings?.meshIds ?? [])],
			clearColor: [...(pass.rasterSettings?.clearColor ?? [0, 0, 0, 0])],
		};
		pass.computeSettings = {
			...defaultComputeSettings(),
			...(pass.computeSettings ?? {}),
			dispatch: [...(pass.computeSettings?.dispatch ?? [1, 1, 1])],
			uniformBuffers: [...(pass.computeSettings?.uniformBuffers ?? [])],
			storageBuffers: (pass.computeSettings?.storageBuffers ?? []).map((buffer) => ({
				...buffer,
				indirect: buffer.indirect ?? false,
				sharedResource: buffer.sharedResource ?? null,
				access: buffer.access ?? "readWrite",
			})),
		};
		pass.inputs ??= {};
		pass.output ??= null;
		pass.outputType ??= "uint8";
		pass.outputFormat ??= "rgba";
		pass.outputSamples ??= 1;
		pass.additionalOutputs ??= [];
		if (!pass.id?.trim() || byId.has(pass.id)) {
			throw new Error(`Custom render-pass id "${pass.id}" is empty or duplicated.`);
		}
		if (!pass.name?.trim()) {
			throw new Error("Custom render-pass name is required.");
		}
		if (!["shader", "copy", "raster", "compute"].includes(pass.passType)) {
			throw new Error(`Custom render-pass "${pass.name}" has an unsupported passType.`);
		}
		if (!customRenderPassInjectionPoints.includes(pass.injectionPoint)) {
			throw new Error(`Custom render-pass "${pass.name}" has an unsupported injectionPoint.`);
		}
		if (pass.passType === "raster" && pass.injectionPoint !== "beforeRendering") {
			throw new Error(`Raster pass "${pass.name}" must use beforeRendering because Babylon custom render targets execute before the camera scene draw.`);
		}
		if (pass.passType === "compute" && pass.injectionPoint !== "afterRenderingPrePasses") {
			throw new Error(`Compute pass "${pass.name}" must use afterRenderingPrePasses because its dispatch consumes completed render targets before camera post-processing.`);
		}
		if (["shader", "copy"].includes(pass.passType) && !["beforeRenderingPostProcessing", "afterRenderingPostProcessing"].includes(pass.injectionPoint)) {
			throw new Error(`Shader/copy pass "${pass.name}" must use beforeRenderingPostProcessing or afterRenderingPostProcessing.`);
		}
		validateRendererFeatureReference(pass);
		if (!Number.isFinite(pass.order)) {
			throw new Error(`Custom render-pass "${pass.name}" order must be finite.`);
		}
		if (!Number.isFinite(pass.ratio) || pass.ratio <= 0 || pass.ratio > 1) {
			throw new Error(`Custom render-pass "${pass.name}" ratio must be greater than 0 and at most 1.`);
		}
		if (!["nearest", "bilinear", "trilinear"].includes(pass.samplingMode)) {
			throw new Error(`Custom render-pass "${pass.name}" has an unsupported sampling mode.`);
		}
		if (!["uint8", "halfFloat", "float"].includes(pass.outputType)) {
			throw new Error(`Custom render-pass "${pass.name}" has an unsupported outputType.`);
		}
		if (!["r", "rg", "rgba"].includes(pass.outputFormat)) {
			throw new Error(`Custom render-pass "${pass.name}" has an unsupported outputFormat.`);
		}
		if (!Number.isInteger(pass.outputSamples) || pass.outputSamples < 1 || pass.outputSamples > 8) {
			throw new Error(`Custom render-pass "${pass.name}" outputSamples must be an integer from 1 through 8.`);
		}
		if (!Array.isArray(pass.additionalOutputs) || pass.additionalOutputs.length > 3) {
			throw new Error(`Custom render-pass "${pass.name}" supports at most 3 additional MRT outputs.`);
		}
		if (pass.passType === "copy" && !pass.output) {
			throw new Error(`Copy pass "${pass.name}" requires a named output destination.`);
		}
		if (pass.passType === "copy" && pass.additionalOutputs.length) {
			throw new Error(`Copy pass "${pass.name}" cannot publish additional MRT outputs.`);
		}
		if (pass.passType === "raster" && !pass.output) {
			throw new Error(`Raster pass "${pass.name}" requires a named output destination.`);
		}
		if (pass.passType === "raster" && pass.additionalOutputs.length) {
			throw new Error(`Raster pass "${pass.name}" cannot publish additional MRT outputs.`);
		}
		if (pass.passType === "compute" && !pass.output) {
			throw new Error(`Compute pass "${pass.name}" requires a named output destination.`);
		}
		if (pass.passType === "compute" && pass.additionalOutputs.length) {
			throw new Error(`Compute pass "${pass.name}" cannot publish additional MRT outputs.`);
		}
		if (pass.additionalOutputs.length && !pass.output) {
			throw new Error(`Custom render-pass "${pass.name}" requires a primary output before additional MRT outputs.`);
		}
		pass.additionalOutputs.forEach((output, index) => {
			if (!output?.name?.trim()) {
				throw new Error(`Custom render-pass "${pass.name}" additional output ${index + 1} requires a name.`);
			}
			if (!["uint8", "halfFloat", "float"].includes(output.outputType)) {
				throw new Error(`Custom render-pass "${pass.name}" additional output "${output.name}" has an unsupported outputType.`);
			}
			if (!["r", "rg", "rgba"].includes(output.outputFormat)) {
				throw new Error(`Custom render-pass "${pass.name}" additional output "${output.name}" has an unsupported outputFormat.`);
			}
			if (!Number.isInteger(output.outputSamples) || output.outputSamples < 1 || output.outputSamples > 8) {
				throw new Error(`Custom render-pass "${pass.name}" additional output "${output.name}" outputSamples must be an integer from 1 through 8.`);
			}
			if (output.outputSamples !== pass.outputSamples) {
				throw new Error(`Custom render-pass "${pass.name}" MRT outputs must use the same outputSamples value.`);
			}
		});
		if (!Array.isArray(pass.dependencies) || new Set(pass.dependencies).size !== pass.dependencies.length) {
			throw new Error(`Custom render-pass "${pass.name}" dependencies must be unique.`);
		}
		if (pass.passType === "shader") {
			if (typeof pass.fragmentShader !== "string" || pass.fragmentShader.length > 100_000 || !/void\s+main\s*\(/.test(pass.fragmentShader)) {
				throw new Error(`Custom render-pass "${pass.name}" fragmentShader must contain void main() and be at most 100000 characters.`);
			}
			if (!/\btextureSampler\b/.test(pass.fragmentShader)) {
				throw new Error(`Custom render-pass "${pass.name}" fragmentShader must sample textureSampler.`);
			}
			validateUniforms(pass.uniforms);
			validateInputs(pass);
		} else if (pass.passType === "copy") {
			validateCopySource(pass);
		} else if (pass.passType === "raster") {
			validateRasterSettings(pass);
		} else {
			validateComputeSettings(pass);
		}
		if (pass.passType === "shader" && pass.additionalOutputs.length) {
			passOutputs(pass).forEach((_output, index) => {
				if (!new RegExp(`\\bgl_FragData\\s*\\[\\s*${index}\\s*\\]`).test(pass.fragmentShader)) {
					throw new Error(`Custom render-pass "${pass.name}" fragmentShader must write gl_FragData[${index}] for its MRT attachment.`);
				}
			});
		}
		byId.set(pass.id, pass);
	});
	const outputs = new Map<string, ICustomRenderPassDefinition>();
	for (const pass of passes) {
		for (const output of passOutputs(pass)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(output.name)) {
				throw new Error(`Custom render-pass "${pass.name}" output must be a shader-style identifier.`);
			}
			if (outputs.has(output.name)) {
				throw new Error(`Custom render-pass output "${output.name}" is duplicated.`);
			}
			outputs.set(output.name, pass);
		}
	}
	for (const pass of passes) {
		for (const dependency of pass.dependencies) {
			if (dependency === pass.id) {
				throw new Error(`Custom render-pass "${pass.name}" cannot depend on itself.`);
			}
			if (!byId.has(dependency)) {
				throw new Error(`Custom render-pass "${pass.name}" references missing dependency "${dependency}".`);
			}
			if (pass.passType === "raster" && byId.get(dependency)!.passType !== "raster") {
				throw new Error(`Raster pass "${pass.name}" can depend only on other raster passes because offscreen scene draws execute before camera post-processes.`);
			}
			if (pass.passType === "compute" && !["raster", "compute"].includes(byId.get(dependency)!.passType)) {
				throw new Error(`Compute pass "${pass.name}" can depend only on raster or compute passes because GPU dispatches execute before camera post-processes.`);
			}
			if (injectionPointIndex(byId.get(dependency)!.injectionPoint) > injectionPointIndex(pass.injectionPoint)) {
				throw new Error(`Custom render-pass "${pass.name}" cannot depend on later injection point ${byId.get(dependency)!.injectionPoint}.`);
			}
		}
		for (const input of Object.values(runtimeInputs(pass)).filter((candidate) => candidate.source === "pass")) {
			const producer = outputs.get(input.output!);
			if (!producer) {
				throw new Error(`Custom render-pass "${pass.name}" references missing pass output "${input.output}".`);
			}
			if (!pass.dependencies.includes(producer.id)) {
				throw new Error(`Custom render-pass "${pass.name}" must directly depend on output producer "${producer.name}".`);
			}
			if (pass.enabled && !producer.enabled) {
				throw new Error(`Enabled custom render-pass "${pass.name}" cannot consume disabled producer "${producer.name}".`);
			}
			if (pass.passType === "compute" && !["raster", "compute"].includes(producer.passType)) {
				throw new Error(`Compute pass "${pass.name}" can sample only raster or compute outputs produced before camera post-processes.`);
			}
		}
	}
	const indegree = new Map(passes.map((pass) => [pass.id, pass.dependencies.length]));
	const dependents = new Map(passes.map((pass) => [pass.id, [] as string[]]));
	for (const pass of passes) {
		for (const dependency of pass.dependencies) {
			dependents.get(dependency)!.push(pass.id);
		}
	}
	const compare = (first: ICustomRenderPassDefinition, second: ICustomRenderPassDefinition): number =>
		injectionPointIndex(first.injectionPoint) - injectionPointIndex(second.injectionPoint) ||
		first.order - second.order ||
		first.name.localeCompare(second.name) ||
		first.id.localeCompare(second.id);
	const ready = passes.filter((pass) => indegree.get(pass.id) === 0).sort(compare);
	const result: ICustomRenderPassDefinition[] = [];
	while (ready.length) {
		const pass = ready.shift()!;
		result.push(pass);
		for (const dependentId of dependents.get(pass.id)!) {
			indegree.set(dependentId, indegree.get(dependentId)! - 1);
			if (indegree.get(dependentId) === 0) {
				ready.push(byId.get(dependentId)!);
				ready.sort(compare);
			}
		}
	}
	if (result.length !== passes.length) {
		throw new Error("Custom render-pass dependencies contain a cycle.");
	}
	validateSharedComputeResources(result, byId);
	return result;
}

/** Computes named-output lifetimes and compatible transient allocation slots. */
export function getCustomRenderPassSchedule(passes: ICustomRenderPassDefinition[]): ICustomRenderPassSchedule {
	const ordered = sortCustomRenderPassGraph(passes);
	const indexById = new Map(ordered.map((pass, index) => [pass.id, index]));
	const outputs = ordered
		.flatMap((producer) => passOutputs(producer).map((output, attachmentIndex) => ({ producer, output, attachmentIndex })))
		.filter(({ producer }) => producer.enabled)
		.map(({ producer, output, attachmentIndex }) => {
			const consumers = ordered.filter((pass) => pass.enabled && Object.values(runtimeInputs(pass)).some((input) => input.source === "pass" && input.output === output.name));
			return {
				name: output.name,
				producerId: producer.id,
				producerName: producer.name,
				firstUse: indexById.get(producer.id)!,
				lastUse: Math.max(indexById.get(producer.id)!, ...consumers.map((pass) => indexById.get(pass.id)!)),
				consumerIds: consumers.map((pass) => pass.id),
				allocationSlot: -1,
				ratio: producer.ratio,
				samplingMode: producer.samplingMode,
				outputType: output.outputType,
				outputFormat: output.outputFormat,
				outputSamples: output.outputSamples,
				attachmentIndex,
				multiTarget: producer.additionalOutputs.length > 0,
				sceneRaster: producer.passType === "raster",
				compute: producer.passType === "compute",
			};
		});
	const slots: Array<{
		slot: number;
		lastUse: number;
		ratio: number;
		samplingMode: CustomRenderPassSamplingMode;
		outputType: CustomRenderPassOutputType;
		outputFormat: CustomRenderPassOutputFormat;
		outputSamples: number;
	}> = [];
	for (const output of outputs) {
		const reusable =
			output.multiTarget || output.sceneRaster || output.compute
				? undefined
				: slots
						.filter(
							(slot) =>
								slot.lastUse < output.firstUse &&
								slot.ratio === output.ratio &&
								slot.samplingMode === output.samplingMode &&
								slot.outputType === output.outputType &&
								slot.outputFormat === output.outputFormat &&
								slot.outputSamples === output.outputSamples
						)
						.sort((first, second) => first.slot - second.slot)[0];
		if (reusable) {
			output.allocationSlot = reusable.slot;
			reusable.lastUse = output.lastUse;
		} else {
			output.allocationSlot = slots.length;
			slots.push({
				slot: output.allocationSlot,
				lastUse: output.lastUse,
				ratio: output.ratio,
				samplingMode: output.samplingMode,
				outputType: output.outputType,
				outputFormat: output.outputFormat,
				outputSamples: output.outputSamples,
			});
		}
	}
	const shared = new Map<string, ICustomRenderPassSchedule["sharedComputeResources"][number]>();
	for (const pass of ordered.filter((candidate) => candidate.enabled && candidate.passType === "compute")) {
		for (const buffer of pass.computeSettings.storageBuffers.filter((candidate) => candidate.sharedResource)) {
			const resource = shared.get(buffer.sharedResource!) ?? {
				name: buffer.sharedResource!,
				dataType: buffer.dataType,
				elementCount: buffer.data.length,
				indirect: buffer.indirect,
				synchronization: "implicitWebGPUCommandOrder" as const,
				usages: [],
			};
			resource.usages.push({ passId: pass.id, passName: pass.name, bufferName: buffer.name, access: buffer.access });
			shared.set(resource.name, resource);
		}
	}
	return { executionOrder: ordered.map((pass) => pass.id), outputs, allocationCount: slots.length, sharedComputeResources: [...shared.values()] };
}

function setUniform(effect: Effect, name: string, value: CustomRenderPassUniformValue): void {
	if (typeof value === "number") {
		effect.setFloat(name, value);
	} else if (value.length === 2) {
		effect.setFloat2(name, value[0], value[1]);
	} else if (value.length === 3) {
		effect.setFloat3(name, value[0], value[1], value[2]);
	} else {
		effect.setFloat4(name, value[0], value[1], value[2], value[3]);
	}
}

function computeStorageData(definition: ICustomRenderPassComputeStorageBuffer): Float32Array | Int32Array | Uint32Array {
	if (definition.dataType === "float32") {
		return new Float32Array(definition.data);
	}
	if (definition.dataType === "int32") {
		return new Int32Array(definition.data);
	}
	return new Uint32Array(definition.data);
}

function updateComputeUniform(buffer: UniformBuffer, uniform: ICustomRenderPassComputeUniform): void {
	const [x, y = 0, z = 0, w = 0] = uniform.value;
	if (uniform.type === "float") {
		buffer.updateFloat(uniform.name, x);
	} else if (uniform.type === "vec2") {
		buffer.updateFloat2(uniform.name, x, y);
	} else if (uniform.type === "vec3") {
		buffer.updateFloat3(uniform.name, x, y, z);
	} else if (uniform.type === "vec4") {
		buffer.updateFloat4(uniform.name, x, y, z, w);
	} else if (uniform.type === "int") {
		buffer.updateInt(uniform.name, x);
	} else {
		buffer.updateUInt(uniform.name, x);
	}
}

function cpuMetric(
	camera: Camera,
	passId: string
): { executionCount: number; lastExecutionFrame: number | null; lastCpuDurationMs: number | null; totalCpuDurationMs: number; startedAt: number | null } {
	const metrics = passCpuMetrics.get(camera) ?? new Map();
	passCpuMetrics.set(camera, metrics);
	let metric = metrics.get(passId);
	if (!metric) {
		metric = { executionCount: 0, lastExecutionFrame: null, lastCpuDurationMs: null, totalCpuDurationMs: 0, startedAt: null };
		metrics.set(passId, metric);
	}
	return metric;
}

function beginCpuMetric(camera: Camera, passId: string): void {
	cpuMetric(camera, passId).startedAt = globalThis.performance?.now?.() ?? Date.now();
}

function endCpuMetric(camera: Camera, passId: string): void {
	const metric = cpuMetric(camera, passId);
	if (metric.startedAt === null) {
		return;
	}
	metric.lastCpuDurationMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - metric.startedAt);
	metric.totalCpuDurationMs += metric.lastCpuDurationMs;
	metric.executionCount++;
	metric.lastExecutionFrame = camera.getScene().getEngine().frameId;
	metric.startedAt = null;
}

function isolatedDefinitions(camera: Camera, definitions: ICustomRenderPassDefinition[]): ICustomRenderPassDefinition[] {
	const passId = debugIsolationPassIds.get(camera);
	if (!passId) {
		return definitions;
	}
	const byId = new Map(definitions.map((pass) => [pass.id, pass]));
	const target = byId.get(passId);
	if (!target) {
		throw new Error(`Debug-isolated custom render pass "${passId}" no longer exists. Clear isolation or select another pass.`);
	}
	if (!target.enabled) {
		throw new Error(`Debug-isolated custom render pass "${target.name}" is disabled. Enable it or clear isolation.`);
	}
	const required = new Set<string>();
	const visit = (id: string): void => {
		if (required.has(id)) {
			return;
		}
		required.add(id);
		byId.get(id)?.dependencies.forEach(visit);
	};
	visit(passId);
	return definitions.map((pass) => ({ ...structuredClone(pass), enabled: pass.enabled && required.has(pass.id) }));
}

function configuredSignature(camera: Camera, definitions: ICustomRenderPassDefinition[]): string {
	return JSON.stringify({
		isolationPassId: debugIsolationPassIds.get(camera) ?? null,
		camera: { id: camera.id, mode: camera.mode, layerMask: camera.layerMask },
		definitions,
	});
}

function tileOnlyRuntimeDefinitions(scene: Scene, definitions: ICustomRenderPassDefinition[]): ICustomRenderPassDefinition[] {
	const policy = scene.metadata?.babylonEditorOnTileRendering as { version?: unknown; enabled?: unknown; validationMode?: unknown; tileOnlyMode?: unknown } | undefined;
	if (policy?.version !== 1 || policy.enabled !== true || policy.tileOnlyMode !== true || policy.validationMode !== "enforce") {
		return definitions;
	}
	return definitions.map((definition) => ({ ...definition, enabled: false }));
}

/** Disposes every custom pass currently attached to a camera. */
export function disposeCustomRenderPassGraph(camera: Camera): void {
	const gpuProfile = gpuProfileRuntimes.get(camera);
	if (gpuProfile?.observer && gpuProfile.observable) {
		gpuProfile.observable.remove(gpuProfile.observer);
	}
	gpuProfileRuntimes.delete(camera);
	for (const postProcess of [...(postProcesses.get(camera) ?? [])].reverse()) {
		postProcess.dispose(camera);
	}
	const disposedComputeUniformBuffers = new Set<UniformBuffer>();
	const disposedComputeStorageBuffers = new Set<StorageBuffer>();
	for (const value of computeTargets.get(camera) ?? []) {
		camera.getScene().onAfterRenderTargetsRenderObservable.remove(value.observer);
		value.uniformBuffers.forEach(({ buffer }) => {
			if (!disposedComputeUniformBuffers.has(buffer)) {
				buffer.dispose();
			}
			disposedComputeUniformBuffers.add(buffer);
		});
		value.storageBuffers.forEach(({ buffer }) => {
			if (!disposedComputeStorageBuffers.has(buffer)) {
				buffer.dispose();
			}
			disposedComputeStorageBuffers.add(buffer);
		});
		value.target.dispose();
	}
	for (const value of sceneRasterTargets.get(camera) ?? []) {
		if (value.resolutionObserver) {
			camera.getScene().onBeforeRenderObservable.remove(value.resolutionObserver);
		}
		if (value.overrideMaterial) {
			for (const mesh of value.overrideMeshes) {
				value.target.setMaterialForRendering(mesh, undefined);
			}
		}
		value.target.dispose();
		value.overrideMaterial?.dispose();
	}
	for (const value of multiRenderTargets.get(camera) ?? []) {
		value.restorePrimary();
		value.target.dispose();
	}
	for (const value of singleOutputTargets.get(camera) ?? []) {
		value.target.dispose();
	}
	for (const texture of ownedTextures.get(camera) ?? []) {
		texture.dispose();
	}
	releaseRenderResources(camera);
	postProcesses.delete(camera);
	ownedTextures.delete(camera);
	multiRenderTargets.delete(camera);
	singleOutputTargets.delete(camera);
	sceneRasterTargets.delete(camera);
	computeTargets.delete(camera);
	passCpuMetrics.delete(camera);
	configuredSignatures.delete(camera);
	appliedDefinitions.delete(camera);
	authoredDefinitionsByCamera.delete(camera);
	failedSignatures.delete(camera);
	runtimeErrors.delete(camera);
}

function rendererListSortComparator(mode: IRendererListDefinition["sortMode"]): ((first: any, second: any) => number) | null {
	if (mode === "frontToBack") {
		return RenderingGroup.frontToBackSortCompare;
	}
	if (mode === "backToFront") {
		return RenderingGroup.backToFrontSortCompare;
	}
	if (mode === "material") {
		return RenderingGroup.PainterSortCompare;
	}
	if (mode === "defaultTransparent") {
		return RenderingGroup.defaultTransparentSortCompare;
	}
	return null;
}

function renderRendererListBuckets(scene: Scene, rasterCamera: Camera, definition: IRendererListDefinition, buckets: any[], beforeTransparents?: () => void): void {
	const queueNames: Exclude<RenderingQueue, "all">[] = ["opaque", "alphaTest", "transparent"];
	const comparator = rendererListSortComparator(definition.sortMode);
	const renderBucket = (bucket: any, queue: Exclude<RenderingQueue, "all">): void => {
		if (definition.queue !== "all" && definition.queue !== queue) {
			return;
		}
		const values = bucket.data.slice(0, bucket.length);
		if (comparator) {
			for (const subMesh of values) {
				const mesh = subMesh.getMesh();
				subMesh._alphaIndex = mesh.alphaIndex;
				const bounds = subMesh.getBoundingInfo();
				subMesh._distanceToCamera = bounds ? bounds.boundingSphere.centerWorld.subtract(rasterCamera.globalPosition).length() : 0;
			}
			values.sort(comparator);
		}
		for (const subMesh of values) {
			subMesh.render(queue === "transparent");
		}
	};
	const depthOnly = buckets[3];
	if ((definition.queue === "all" || definition.queue === "opaque") && depthOnly.length) {
		const engine = scene.getEngine();
		engine.setColorWrite(false);
		try {
			for (let index = 0; index < depthOnly.length; index++) {
				depthOnly.data[index].render(false);
			}
		} finally {
			engine.setColorWrite(true);
		}
	}
	renderBucket(buckets[0], queueNames[0]);
	renderBucket(buckets[1], queueNames[1]);
	beforeTransparents?.();
	renderBucket(buckets[2], queueNames[2]);
}

/** Rebuilds a camera's custom full-screen pass graph and returns its resolved execution order. */
export function applyCustomRenderPassGraph(scene: Scene, camera: Camera, passes?: ICustomRenderPassDefinition[], rootUrl = ""): ICustomRenderPassDefinition[] {
	const authoredDefinitions = passes ?? ((camera.getScene().metadata?.babylonEditorCustomRenderPasses ?? []) as ICustomRenderPassDefinition[]);
	const normalizedAuthoredDefinitions = sortCustomRenderPassGraph(structuredClone(authoredDefinitions));
	const runtimeDefinitions = tileOnlyRuntimeDefinitions(scene, normalizedAuthoredDefinitions);
	const cameraDefinitions = cameraEligibleDefinitions(runtimeDefinitions, camera);
	const definitions = isolatedDefinitions(camera, cameraDefinitions);
	const ordered = sortCustomRenderPassGraph(definitions);
	const schedule = getCustomRenderPassSchedule(definitions);
	validateOutputCapabilities(scene, schedule);
	const previousGpuProfile = gpuProfileRuntimes.get(camera);
	disposeCustomRenderPassGraph(camera);
	passCpuMetrics.set(camera, new Map());
	const gpuProfile = createGpuProfileRuntime(scene, camera, previousGpuProfile);
	if (gpuProfile) {
		gpuProfileRuntimes.set(camera, gpuProfile);
	}
	const createdTextures: Texture[] = [];
	const createdRasterOverrideMaterials: Material[] = [];
	const created: PostProcess[] = [];
	const createdMultiRenderTargets: Array<{ target: MultiRenderTarget; restorePrimary: () => void }> = [];
	const createdSingleOutputTargets: Array<{
		id: string;
		name: string;
		output: string;
		passType: "shader" | "copy";
		target: RenderTargetTexture;
		capture: PostProcess;
		rendered: boolean;
	}> = [];
	const createdSceneRasterTargets: ICustomRenderPassRasterRuntime[] = [];
	const createdComputeTargets: Array<{
		id: string;
		name: string;
		output: string;
		target: RenderTargetTexture;
		shader: ComputeShader;
		observer: any;
		error: string | null;
		dispatched: boolean;
		dispatchCount: number;
		lastCpuDispatchDurationMs: number | null;
		totalCpuDispatchDurationMs: number;
		submitAfterDispatch: boolean;
		resources: Array<{ name: string; source: string; path: string | null; output: string | null; texture: BaseTexture }>;
		uniformBuffers: Array<{ definition: ICustomRenderPassComputeUniformBuffer; buffer: UniformBuffer }>;
		storageBuffers: Array<{ definition: ICustomRenderPassComputeStorageBuffer; buffer: StorageBuffer }>;
	}> = [];
	const createdComputeOutputTargets: RenderTargetTexture[] = [];
	const createdComputeUniformBuffers: UniformBuffer[] = [];
	const createdComputeStorageBuffers: StorageBuffer[] = [];
	const outputProducers = new Map<string, ICustomRenderPassOutputResource>();
	const sharedStorageBuffers = new Map<string, StorageBuffer>();
	const allocationOwners = new Map<number, PostProcess>();
	const outputSchedule = new Map(schedule.outputs.map((output) => [output.name, output]));
	try {
		for (const pass of ordered.filter((candidate) => candidate.enabled)) {
			const createdPassStart = created.length;
			const outputs = passOutputs(pass);
			if (pass.passType === "raster") {
				const rendererList = pass.rasterSettings.rendererListId
					? validateRendererLists(scene.metadata?.[rendererListsMetadataKey]).find((candidate) => candidate.id === pass.rasterSettings.rendererListId)
					: null;
				if (pass.rasterSettings.rendererListId && !rendererList) {
					throw new Error(`Raster pass "${pass.name}" references missing renderer list "${pass.rasterSettings.rendererListId}".`);
				}
				const resolvedRendererList = rendererList?.enabled ? resolveRendererList(scene, rendererList, camera) : null;
				const rasterCamera = resolvedRendererList?.camera ?? (pass.rasterSettings.cameraId ? scene.getCameraById(pass.rasterSettings.cameraId) : camera);
				if (!rasterCamera) {
					throw new Error(`Raster pass "${pass.name}" references missing camera "${pass.rasterSettings.cameraId}".`);
				}
				const missingMeshIds = pass.rasterSettings.meshIds.filter((id) => !scene.getMeshById(id));
				if (missingMeshIds.length) {
					throw new Error(`Raster pass "${pass.name}" references missing mesh ids: ${missingMeshIds.join(", ")}.`);
				}
				const selectedMeshes = rendererList
					? resolvedRendererList
						? [...resolvedRendererList.meshes]
						: []
					: pass.rasterSettings.meshIds.length
						? pass.rasterSettings.meshIds.map((id) => scene.getMeshById(id)!)
						: [...scene.meshes];
				if (pass.rasterSettings.includeDescendants && pass.rasterSettings.meshIds.length) {
					for (const mesh of [...selectedMeshes]) {
						selectedMeshes.push(...mesh.getChildMeshes(false));
					}
				}
				const renderList = [...new Map(selectedMeshes.map((mesh) => [mesh.id, mesh])).values()].filter(
					(mesh) => pass.rasterSettings.layerMask === null || (mesh.layerMask & pass.rasterSettings.layerMask) !== 0
				);
				let overrideMaterial: Material | null = null;
				if (pass.rasterSettings.materialId) {
					const sourceMaterial = scene.getMaterialById(pass.rasterSettings.materialId, true);
					if (!sourceMaterial) {
						throw new Error(`Raster pass "${pass.name}" references missing material "${pass.rasterSettings.materialId}".`);
					}
					overrideMaterial = sourceMaterial.clone(`${sourceMaterial.name} (${pass.name} graphics override)`);
					if (!overrideMaterial) {
						throw new Error(`Raster pass "${pass.name}" could not clone material "${pass.rasterSettings.materialId}" for isolated graphics state.`);
					}
					createdRasterOverrideMaterials.push(overrideMaterial);
					overrideMaterial.backFaceCulling = pass.rasterSettings.cullMode !== "none";
					overrideMaterial.cullBackFaces = pass.rasterSettings.cullMode !== "front";
					overrideMaterial.disableDepthWrite = !pass.rasterSettings.depthWrite;
					overrideMaterial.depthFunction = pass.rasterSettings.depthTest ? Constants.LEQUAL : Constants.ALWAYS;
					overrideMaterial.alphaMode =
						pass.rasterSettings.blendMode === "alpha"
							? Constants.ALPHA_COMBINE
							: pass.rasterSettings.blendMode === "additive"
								? Constants.ALPHA_ADD
								: pass.rasterSettings.blendMode === "multiply"
									? Constants.ALPHA_MULTIPLY
									: pass.rasterSettings.blendMode === "premultiplied"
										? Constants.ALPHA_PREMULTIPLIED
										: Constants.ALPHA_DISABLE;
				}
				const target = new RenderTargetTexture(`Raster ${pass.name}`, { ratio: pass.ratio }, scene, {
					generateMipMaps: false,
					doNotChangeAspectRatio: true,
					type: outputTextureType(pass.outputType),
					samplingMode: samplingMode(pass.samplingMode),
					generateDepthBuffer: true,
					format: outputTextureFormat(pass.outputFormat),
					samples: pass.outputSamples,
				});
				target.activeCamera = rasterCamera;
				target.renderList = renderList;
				target.clearColor = Color4.FromArray(pass.rasterSettings.clearColor);
				if (pass.rasterSettings.clearMode === "depthOnly") {
					target.onClearObservable.add((engine) => engine.clear(target.clearColor, false, true, true));
				} else if (pass.rasterSettings.clearMode === "none") {
					target.onClearObservable.add(() => undefined);
				}
				const overrideMeshes = new Set<AbstractMesh>();
				if (overrideMaterial) {
					target.setMaterialForRendering(renderList, overrideMaterial);
					renderList.forEach((mesh) => overrideMeshes.add(mesh));
				}
				target.renderParticles = pass.rasterSettings.renderParticles;
				target.renderSprites = pass.rasterSettings.renderSprites;
				target.useCameraPostProcesses = pass.rasterSettings.useCameraPostProcesses;
				if (rendererList) {
					target.customRenderFunction = (opaque, alphaTest, transparent, depthOnly, beforeTransparents) =>
						renderRendererListBuckets(scene, rasterCamera, rendererList, [opaque, alphaTest, transparent, depthOnly], beforeTransparents);
				}
				target.refreshRate =
					pass.rasterSettings.refreshRate === "once"
						? RenderTargetTexture.REFRESHRATE_RENDER_ONCE
						: pass.rasterSettings.refreshRate === "everyTwoFrames"
							? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYTWOFRAMES
							: RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
				target.onBeforeRenderObservable.add(() => beginCpuMetric(camera, pass.id));
				target.onAfterRenderObservable.add(() => endCpuMetric(camera, pass.id));
				const runtime: ICustomRenderPassRasterRuntime = {
					id: pass.id,
					name: pass.name,
					output: pass.output!,
					target,
					meshIds: renderList.map((mesh) => mesh.id),
					cameraId: rasterCamera.id,
					overrideMaterial,
					settings: structuredClone(pass.rasterSettings),
					rendererList: rendererList ? structuredClone(rendererList) : null,
					resolutionObserver: null,
					resolutionError: null,
					overrideMeshes,
				};
				if (rendererList) {
					runtime.resolutionObserver = scene.onBeforeRenderObservable.add(() => {
						try {
							const nextResolved = rendererList.enabled ? resolveRendererList(scene, rendererList, camera) : null;
							const nextMeshes = nextResolved ? [...nextResolved.meshes] : [];
							if (overrideMaterial) {
								const nextSet = new Set(nextMeshes);
								for (const mesh of runtime.overrideMeshes) {
									if (!nextSet.has(mesh)) {
										target.setMaterialForRendering(mesh, undefined);
									}
								}
								target.setMaterialForRendering(nextMeshes, overrideMaterial);
								runtime.overrideMeshes = nextSet;
							}
							target.activeCamera = nextResolved?.camera ?? camera;
							target.renderList = nextMeshes;
							runtime.cameraId = target.activeCamera.id;
							runtime.meshIds = nextMeshes.map((mesh) => mesh.id);
							runtime.resolutionError = null;
						} catch (error) {
							if (overrideMaterial) {
								for (const mesh of runtime.overrideMeshes) {
									target.setMaterialForRendering(mesh, undefined);
								}
								runtime.overrideMeshes.clear();
							}
							target.renderList = [];
							runtime.meshIds = [];
							runtime.resolutionError = error instanceof Error ? error.message : String(error);
						}
					});
				}
				scene.customRenderTargets.push(target);
				createdSceneRasterTargets.push(runtime);
				outputProducers.set(pass.output!, {
					bind: (effect, samplerName) => effect.setTexture(samplerName, target),
					isReady: () => target.isReadyForRendering(),
					texture: target,
				});
				registerGpuProfileRecord(gpuProfile, pass, {
					source: "renderTarget",
					getCounter: () => (target.renderTarget as any)?.gpuTimeInFrame,
					beforeObservable: target.onBeforeRenderObservable,
					afterObservable: target.onAfterRenderObservable,
					previous: previousGpuProfile,
				});
				continue;
			}
			if (pass.passType === "compute") {
				const engine = scene.getEngine();
				const target = new RenderTargetTexture(`Compute ${pass.name}`, { ratio: pass.ratio }, scene, {
					generateMipMaps: false,
					doNotChangeAspectRatio: true,
					type: outputTextureType(pass.outputType),
					samplingMode: samplingMode(pass.samplingMode),
					generateDepthBuffer: false,
					format: Constants.TEXTUREFORMAT_RGBA,
					samples: 1,
					creationFlags: Constants.TEXTURE_CREATIONFLAG_STORAGE,
				});
				createdComputeOutputTargets.push(target);
				const bindingsMapping: Record<string, { group: number; binding: number }> = {
					[pass.computeSettings.outputBindingName]: { group: pass.computeSettings.outputGroup, binding: pass.computeSettings.outputBinding },
				};
				Object.entries(pass.inputs).forEach(([name, input]) => (bindingsMapping[name] = { group: input.group!, binding: input.binding! }));
				pass.computeSettings.uniformBuffers.forEach((buffer) => (bindingsMapping[buffer.name] = { group: buffer.group, binding: buffer.binding }));
				pass.computeSettings.storageBuffers.forEach((buffer) => (bindingsMapping[buffer.name] = { group: buffer.group, binding: buffer.binding }));
				const shader = new ComputeShader(pass.name, engine, { computeSource: pass.computeSettings.wgsl }, { bindingsMapping, entryPoint: pass.computeSettings.entryPoint });
				shader.setStorageTexture(pass.computeSettings.outputBindingName, target);
				const computeResources: Array<{ name: string; source: string; path: string | null; output: string | null; texture: BaseTexture }> = [];
				for (const [name, input] of Object.entries(pass.inputs)) {
					const texture = input.source === "pass" ? outputProducers.get(input.output!)?.texture : resolveResourceTexture(scene, camera, input, rootUrl, createdTextures);
					if (!texture) {
						throw new Error(`Compute pass "${pass.name}" input "${name}" is not backed by a readable raster or compute texture.`);
					}
					shader.setTexture(name, texture, false);
					computeResources.push({ name, source: input.source, path: input.path ?? null, output: input.output ?? null, texture });
				}
				const uniformBuffers = pass.computeSettings.uniformBuffers.map((definition) => {
					const buffer = new UniformBuffer(engine, undefined, false, `Compute ${pass.name} ${definition.name}`);
					createdComputeUniformBuffers.push(buffer);
					definition.uniforms.forEach((uniform) =>
						buffer.addUniform(uniform.name, uniform.type === "vec2" ? 2 : uniform.type === "vec3" ? 3 : uniform.type === "vec4" ? 4 : 1)
					);
					definition.uniforms.forEach((uniform) => updateComputeUniform(buffer, uniform));
					buffer.update();
					shader.setUniformBuffer(definition.name, buffer);
					return { definition, buffer };
				});
				const storageBuffers = pass.computeSettings.storageBuffers.map((definition) => {
					let buffer = definition.sharedResource ? sharedStorageBuffers.get(definition.sharedResource) : undefined;
					if (!buffer) {
						const data = computeStorageData(definition);
						const flags = definition.indirect ? Constants.BUFFER_CREATIONFLAG_INDIRECT : 0;
						buffer = new StorageBuffer(engine as any, data.byteLength, flags, `Compute ${pass.name} ${definition.sharedResource ?? definition.name}`);
						createdComputeStorageBuffers.push(buffer);
						buffer.update(data);
						if (definition.sharedResource) {
							sharedStorageBuffers.set(definition.sharedResource, buffer);
						}
					}
					shader.setStorageBuffer(definition.name, buffer);
					return { definition, buffer };
				});
				const state = {
					id: pass.id,
					name: pass.name,
					output: pass.output!,
					target,
					shader,
					observer: null as any,
					error: null as string | null,
					dispatched: false,
					dispatchCount: 0,
					lastCpuDispatchDurationMs: null as number | null,
					totalCpuDispatchDurationMs: 0,
					submitAfterDispatch: pass.computeSettings.submitAfterDispatch,
					resources: computeResources,
					uniformBuffers,
					storageBuffers,
				};
				shader.onCompiled = () => (state.error = null);
				shader.onError = (_effect, errors) => (state.error = errors);
				state.observer = scene.onAfterRenderTargetsRenderObservable.add(() => {
					if (scene.activeCamera !== camera) {
						return;
					}
					if (state.dispatched && pass.computeSettings.dispatchMode === "once") {
						return;
					}
					try {
						const startedAt = globalThis.performance?.now?.() ?? Date.now();
						beginCpuMetric(camera, pass.id);
						if (pass.computeSettings.dispatchType === "indirect") {
							const indirect = storageBuffers.find(({ definition }) => definition.name === pass.computeSettings.indirectBuffer)!;
							state.dispatched = shader.dispatchIndirect(indirect.buffer, pass.computeSettings.indirectOffset);
						} else {
							state.dispatched = shader.dispatch(...pass.computeSettings.dispatch);
						}
						if (state.dispatched) {
							state.lastCpuDispatchDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
							state.totalCpuDispatchDurationMs += state.lastCpuDispatchDurationMs;
							state.dispatchCount++;
							endCpuMetric(camera, pass.id);
						} else {
							cpuMetric(camera, pass.id).startedAt = null;
						}
						if (state.dispatched && pass.computeSettings.submitAfterDispatch) {
							engine.flushFramebuffer();
						}
					} catch (error) {
						cpuMetric(camera, pass.id).startedAt = null;
						state.error = error instanceof Error ? error.message : String(error);
					}
				});
				createdComputeTargets.push(state);
				outputProducers.set(pass.output!, {
					bind: (effect, samplerName) => effect.setTexture(samplerName, target),
					isReady: () => shader.isReady() && target.isReady(),
					texture: target,
				});
				registerGpuProfileRecord(gpuProfile, pass, {
					source: "computeShader",
					getCounter: () => shader.gpuTimeInFrame,
					previous: previousGpuProfile,
				});
				continue;
			}
			const inputs = runtimeInputs(pass);
			const uniforms = pass.passType === "copy" ? {} : pass.uniforms;
			const sourceFragmentShader =
				pass.passType === "copy" ? (pass.copySource.source === "screen" ? copyScreenFragmentShader : copyResourceFragmentShader) : pass.fragmentShader;
			const fragmentShader = multiTargetFragmentShader(sourceFragmentShader, outputs.length);
			const shaderName = `babylonEditorCustomPass_${pass.id.replace(/[^A-Za-z0-9_]/g, "_")}_${shaderHash(fragmentShader)}`;
			Effect.ShadersStore[`${shaderName}FragmentShader`] = fragmentShader;
			const externalInputs = Object.entries(inputs).filter(([, input]) => input.source !== "pass");
			const resources = Object.fromEntries(externalInputs.map(([name, input]) => [name, resolveResourceTexture(scene, camera, input, rootUrl, createdTextures)])) as Record<
				string,
				BaseTexture
			>;
			const postProcess = new PostProcess(pass.name, shaderName, Object.keys(uniforms), Object.keys(inputs), pass.ratio, camera, samplingMode(pass.samplingMode));
			const postProcessIndex = created.length;
			let multiTargetForProfile: MultiRenderTarget | null = null;
			(postProcess as any)._babylonEditorCustomRenderPassId = pass.id;
			(postProcess as any)._babylonEditorCustomRenderPassType = pass.passType;
			(postProcess as any)._babylonEditorCustomRenderPassResources = Object.entries(inputs).map(([name, input]) => ({
				name,
				source: input.source,
				path: input.path ?? null,
				output: input.output ?? null,
				texture: resources[name],
				producer: input.source === "pass" ? outputProducers.get(input.output!) : null,
			}));
			postProcess.onBeforeRenderObservable.add(() => beginCpuMetric(camera, pass.id));
			postProcess.onAfterRenderObservable.add(() => endCpuMetric(camera, pass.id));
			postProcess.onApply = (effect) => {
				Object.entries(uniforms).forEach(([name, value]) => setUniform(effect, name, value));
				Object.entries(resources).forEach(([name, texture]) => effect.setTexture(name, texture));
				Object.entries(inputs)
					.filter(([, input]) => input.source === "pass")
					.forEach(([name, input]) => outputProducers.get(input.output!)!.bind(effect, name));
			};
			created.push(postProcess);
			const captureShaderName = "babylonEditorCustomPassOutputCapture";
			Effect.ShadersStore[`${captureShaderName}FragmentShader`] ??= defaultCustomRenderPassFragmentShader;
			if (!pass.output && gpuProfile?.mode === "webgpu-timestamp") {
				const timingBoundary = new PostProcess(`GPU Timing Boundary ${pass.name}`, captureShaderName, {
					uniforms: null,
					samplers: null,
					size: pass.ratio,
					camera,
					samplingMode: samplingMode(pass.samplingMode),
					textureType: outputTextureType(pass.outputType),
					textureFormat: outputTextureFormat(pass.outputFormat),
				});
				(timingBoundary as any)._babylonEditorInternalGpuTimingBoundary = pass.id;
				created.push(timingBoundary);
			}
			if (pass.output) {
				const capture = new PostProcess(`Capture ${pass.output}`, captureShaderName, {
					uniforms: null,
					samplers: null,
					size: pass.ratio,
					camera,
					samplingMode: samplingMode(pass.samplingMode),
					textureType: outputTextureType(pass.outputType),
					textureFormat: outputTextureFormat(pass.outputFormat),
				});
				capture.samples = pass.outputSamples;
				(capture as any)._babylonEditorInternalOutputCapture = pass.output;
				if (outputs.length === 1) {
					const allocationSlot = outputSchedule.get(pass.output)!.allocationSlot;
					const owner = allocationOwners.get(allocationSlot);
					if (owner) {
						capture.shareOutputWith(owner);
					} else {
						allocationOwners.set(allocationSlot, capture);
					}
				}
				created.push(capture);
				if (outputs.length === 1) {
					const engine = scene.getEngine();
					const target = new RenderTargetTexture(`Output ${pass.output}`, { ratio: pass.ratio }, scene, {
						generateMipMaps: false,
						doNotChangeAspectRatio: true,
						type: outputTextureType(pass.outputType),
						samplingMode: samplingMode(pass.samplingMode),
						generateDepthBuffer: false,
						format: outputTextureFormat(pass.outputFormat),
						samples: pass.outputSamples,
					});
					target.samples = pass.outputSamples;
					const state: (typeof createdSingleOutputTargets)[number] = {
						id: pass.id,
						name: pass.name,
						output: pass.output,
						passType: pass.passType,
						target,
						capture,
						rendered: false,
					};
					capture.onBeforeRenderObservable.add(() => {
						const nextTarget = (capture as any)._outputTexture?.texture;
						if (nextTarget) {
							const size = target.getSize();
							if (size.width !== nextTarget.width || size.height !== nextTarget.height) {
								target.resize({ width: nextTarget.width, height: nextTarget.height });
							}
						}
						if (target.renderTarget) {
							engine.bindFramebuffer(target.renderTarget);
						}
					});
					capture.onAfterRenderObservable.add(() => {
						if (target.renderTarget) {
							engine.unBindFramebuffer(target.renderTarget, true);
						}
						state.rendered = true;
					});
					createdSingleOutputTargets.push(state);
					const forward = new PostProcess(`Present ${pass.output}`, captureShaderName, {
						uniforms: null,
						samplers: null,
						size: pass.ratio,
						camera,
						samplingMode: samplingMode(pass.samplingMode),
						textureType: outputTextureType(pass.outputType),
						textureFormat: outputTextureFormat(pass.outputFormat),
					});
					forward.externalTextureSamplerBinding = true;
					forward.onApply = (effect) => effect.setTexture("textureSampler", target);
					(forward as any)._babylonEditorInternalOutputForward = pass.output;
					created.push(forward);
					outputProducers.set(pass.output, {
						bind: (effect, samplerName) => effect.setTexture(samplerName, target),
						isReady: () => postProcess.isReady() && target.isReady(),
						texture: target,
					});
				} else {
					const engine = scene.getEngine();
					const target = new MultiRenderTarget(
						`MRT ${pass.name}`,
						{ width: Math.max(1, Math.round(engine.getRenderWidth() * pass.ratio)), height: Math.max(1, Math.round(engine.getRenderHeight() * pass.ratio)) },
						outputs.length,
						scene,
						{
							generateMipMaps: false,
							generateDepthBuffer: false,
							types: outputs.map((output) => outputTextureType(output.outputType)),
							formats: outputs.map((output) => outputTextureFormat(output.outputFormat)),
							samplingModes: outputs.map(() => samplingMode(pass.samplingMode)),
							samples: pass.outputSamples,
						},
						outputs.map((output) => output.name)
					);
					multiTargetForProfile = target;
					target.samples = pass.outputSamples;
					let originalPrimary = target.textures[0].getInternalTexture();
					let attachedPrimary = originalPrimary;
					const restorePrimary = (): void => {
						if (originalPrimary && attachedPrimary !== originalPrimary) {
							target.setInternalTexture(originalPrimary, 0, false);
						}
						attachedPrimary = originalPrimary;
					};
					postProcess.onBeforeRenderObservable.add(() => {
						const nextTarget = (postProcess as any)._outputTexture?.texture;
						if (!nextTarget || !target.renderTarget) {
							return;
						}
						const size = target.getSize();
						if (size.width !== nextTarget.width || size.height !== nextTarget.height) {
							restorePrimary();
							target.resize({ width: nextTarget.width, height: nextTarget.height });
							originalPrimary = target.textures[0].getInternalTexture();
							attachedPrimary = originalPrimary;
						}
						if (attachedPrimary !== nextTarget) {
							target.setInternalTexture(nextTarget, 0, false);
							attachedPrimary = nextTarget;
						}
						engine.bindFramebuffer(target.renderTarget);
					});
					postProcess.onAfterRenderObservable.add(() => {
						if (target.renderTarget) {
							engine.unBindFramebuffer(target.renderTarget, true);
						}
					});
					createdMultiRenderTargets.push({ target, restorePrimary });
					outputs.forEach((output, index) => {
						outputProducers.set(output.name, {
							bind: (effect, samplerName) => effect.setTexture(samplerName, target.textures[index]),
							isReady: () => target.textures[index]?.isReady() ?? false,
						});
					});
				}
			}
			for (const value of created.slice(createdPassStart)) {
				(value as any)._babylonEditorCustomRenderPassInjectionPoint = pass.injectionPoint;
			}
			registerGpuProfileRecord(gpuProfile, pass, {
				source: "renderTarget",
				getCounter: () => (multiTargetForProfile?.renderTarget as any)?.gpuTimeInFrame ?? (created[postProcessIndex + 1]?.inputTexture as any)?.gpuTimeInFrame,
				beforeObservable: postProcess.onBeforeRenderObservable,
				afterObservable: postProcess.onAfterRenderObservable,
				previous: previousGpuProfile,
			});
		}
		for (const value of created) {
			camera.detachPostProcess(value);
		}
		let beforePostProcessIndex = 0;
		for (const value of created.filter((candidate) => (candidate as any)._babylonEditorCustomRenderPassInjectionPoint === "beforeRenderingPostProcessing")) {
			camera.attachPostProcess(value, beforePostProcessIndex++);
		}
		for (const value of created.filter((candidate) => (candidate as any)._babylonEditorCustomRenderPassInjectionPoint !== "beforeRenderingPostProcessing")) {
			camera.attachPostProcess(value);
		}
	} catch (error) {
		for (const postProcess of [...created].reverse()) {
			postProcess.dispose(camera);
		}
		for (const value of createdComputeTargets) {
			scene.onAfterRenderTargetsRenderObservable.remove(value.observer);
		}
		createdComputeUniformBuffers.forEach((buffer) => buffer.dispose());
		createdComputeStorageBuffers.forEach((buffer) => buffer.dispose());
		createdComputeOutputTargets.forEach((target) => target.dispose());
		for (const value of createdSceneRasterTargets) {
			if (value.resolutionObserver) {
				scene.onBeforeRenderObservable.remove(value.resolutionObserver);
			}
			if (value.overrideMaterial) {
				for (const mesh of value.overrideMeshes) {
					value.target.setMaterialForRendering(mesh, undefined);
				}
			}
			value.target.dispose();
		}
		createdRasterOverrideMaterials.forEach((material) => material.dispose());
		for (const value of createdMultiRenderTargets) {
			value.restorePrimary();
			value.target.dispose();
		}
		for (const value of createdSingleOutputTargets) {
			value.target.dispose();
		}
		for (const texture of createdTextures) {
			texture.dispose();
		}
		gpuProfileRuntimes.delete(camera);
		releaseRenderResources(camera);
		throw error;
	}
	postProcesses.set(camera, created);
	multiRenderTargets.set(camera, createdMultiRenderTargets);
	singleOutputTargets.set(camera, createdSingleOutputTargets);
	sceneRasterTargets.set(camera, createdSceneRasterTargets);
	computeTargets.set(camera, createdComputeTargets);
	ownedTextures.set(camera, createdTextures);
	configuredSignatures.set(camera, configuredSignature(camera, runtimeDefinitions));
	appliedDefinitions.set(
		camera,
		ordered.map((definition) => structuredClone(definition))
	);
	authoredDefinitionsByCamera.set(
		camera,
		normalizedAuthoredDefinitions.map((definition) => structuredClone(definition))
	);
	failedSignatures.delete(camera);
	runtimeErrors.delete(camera);
	startGpuProfilePolling(gpuProfile);
	return ordered;
}

function validateOutputCapabilities(scene: Scene, schedule: ICustomRenderPassSchedule): void {
	const capabilities = scene.getEngine().getCaps();
	if (schedule.outputs.some((output) => output.compute) && !capabilities.supportComputeShaders) {
		throw new Error("Compute render-graph passes require a WebGPU backend with compute-shader support.");
	}
	if (schedule.outputs.some((output) => output.multiTarget) && (!capabilities.drawBuffersExtension || (capabilities.maxDrawBuffers ?? 0) < 2)) {
		throw new Error("Multiple render-target outputs require draw-buffer support on the current backend.");
	}
	const maximumAttachmentCount = Math.max(0, capabilities.maxDrawBuffers ?? 0);
	for (const producerId of new Set(schedule.outputs.filter((output) => output.multiTarget).map((output) => output.producerId))) {
		const attachmentCount = schedule.outputs.filter((output) => output.producerId === producerId).length;
		if (attachmentCount > maximumAttachmentCount) {
			throw new Error(`Custom render pass requests ${attachmentCount} MRT attachments but the current backend supports at most ${maximumAttachmentCount}.`);
		}
	}
	for (const output of schedule.outputs) {
		if (output.outputType === "float" && !capabilities.textureFloatRender) {
			throw new Error(`Named output "${output.name}" requires float render-target support on the current backend.`);
		}
		if (output.outputType === "halfFloat" && !capabilities.textureHalfFloatRender) {
			throw new Error(`Named output "${output.name}" requires half-float render-target support on the current backend.`);
		}
		if (output.outputType === "float" && output.samplingMode !== "nearest" && !capabilities.textureFloatLinearFiltering) {
			throw new Error(`Named output "${output.name}" requires float linear filtering or nearest sampling on the current backend.`);
		}
		if (output.outputType === "halfFloat" && output.samplingMode !== "nearest" && !capabilities.textureHalfFloatLinearFiltering) {
			throw new Error(`Named output "${output.name}" requires half-float linear filtering or nearest sampling on the current backend.`);
		}
		if (output.outputSamples > capabilities.maxMSAASamples) {
			throw new Error(`Named output "${output.name}" requests ${output.outputSamples}x MSAA but the current backend supports at most ${capabilities.maxMSAASamples}x.`);
		}
	}
}

/** Restores the persisted custom render-pass graph for active cameras in exported games. */
export function configureCustomRenderPassGraph(scene: Scene, rootUrl = ""): void {
	const passes = scene.metadata?.babylonEditorCustomRenderPasses as ICustomRenderPassDefinition[] | undefined;
	if (!passes?.length) {
		return;
	}
	scene.onBeforeRenderObservable.add(() => {
		const camera = scene.activeCamera;
		if (!camera) {
			return;
		}
		const normalized = sortCustomRenderPassGraph(passes.map((pass) => structuredClone(pass)));
		const signature = configuredSignature(camera, tileOnlyRuntimeDefinitions(scene, normalized));
		if (configuredSignatures.get(camera) === signature || failedSignatures.get(camera) === signature) {
			return;
		}
		try {
			applyCustomRenderPassGraph(scene, camera, passes, rootUrl);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failedSignatures.set(camera, signature);
			runtimeErrors.set(camera, message);
			Logger.Error(`Failed to restore the custom render-pass graph: ${message}`);
		}
	});
}

/** Returns the last exported-runtime restoration error for a camera, if any. */
export function getCustomRenderPassRuntimeError(camera: Camera): string | null {
	return runtimeErrors.get(camera) ?? null;
}

/** Returns live post-process instances attached for a camera, primarily for diagnostics/tests. */
export function getCustomRenderPassPostProcesses(camera: Camera): readonly PostProcess[] {
	return postProcesses.get(camera) ?? [];
}

/** Reports the live real MRT allocations attached to custom full-screen passes. */
export function getCustomRenderPassMultiRenderTargets(camera: Camera): Array<{
	name: string;
	attachmentCount: number;
	width: number;
	height: number;
	samples: number;
	attachments: Array<{ name: string; ready: boolean }>;
}> {
	return (multiRenderTargets.get(camera) ?? []).map(({ target }) => {
		const size = target.getSize();
		return {
			name: target.name,
			attachmentCount: target.count,
			width: size.width,
			height: size.height,
			samples: target.samples,
			attachments: target.textures.slice(0, target.count).map((texture) => ({ name: texture.name, ready: texture.isReady() })),
		};
	});
}

/** Reports live offscreen scene-raster targets attached to the graph. */
export function getCustomRenderPassSceneRasterTargets(camera: Camera): Array<{
	id: string;
	name: string;
	output: string;
	cameraId: string;
	meshIds: string[];
	rendererListId: string | null;
	rendererListRevision: number | null;
	resolutionError: string | null;
	queue: RenderingQueue;
	sortMode: IRendererListDefinition["sortMode"] | null;
	materialId: string | null;
	clearMode: "colorDepth" | "depthOnly" | "none";
	depthTest: boolean;
	depthWrite: boolean;
	cullMode: "back" | "front" | "none";
	blendMode: "opaque" | "alpha" | "additive" | "multiply" | "premultiplied";
	layerMask: number | null;
	includeDescendants: boolean;
	width: number;
	height: number;
	samples: number;
	ready: boolean;
}> {
	return (sceneRasterTargets.get(camera) ?? []).map((value) => {
		const size = value.target.getSize();
		return {
			id: value.id,
			name: value.name,
			output: value.output,
			cameraId: value.cameraId,
			meshIds: [...value.meshIds],
			rendererListId: value.rendererList?.id ?? null,
			rendererListRevision: value.rendererList?.revision ?? null,
			resolutionError: value.resolutionError,
			queue: value.rendererList?.queue ?? "all",
			sortMode: value.rendererList?.sortMode ?? null,
			materialId: value.settings.materialId,
			clearMode: value.settings.clearMode,
			depthTest: value.settings.depthTest,
			depthWrite: value.settings.depthWrite,
			cullMode: value.settings.cullMode,
			blendMode: value.settings.blendMode,
			layerMask: value.settings.layerMask,
			includeDescendants: value.settings.includeDescendants,
			width: size.width,
			height: size.height,
			samples: value.target.samples,
			ready: value.target.isReadyForRendering(),
		};
	});
}

/** Returns the stable public texture backing a named graph output, or null when that output is not currently applied. */
export function getCustomRenderPassOutputTexture(camera: Camera, output: string): BaseTexture | null {
	const single = (singleOutputTargets.get(camera) ?? []).find((candidate) => candidate.output === output);
	if (single) {
		return single.target;
	}
	const raster = (sceneRasterTargets.get(camera) ?? []).find((candidate) => candidate.output === output);
	if (raster) {
		return raster.target;
	}
	const compute = (computeTargets.get(camera) ?? []).find((candidate) => candidate.output === output);
	if (compute) {
		return compute.target;
	}
	for (const { target } of multiRenderTargets.get(camera) ?? []) {
		const attachment = target.textures.slice(0, target.count).find((candidate) => candidate.name === output);
		if (attachment) {
			return attachment;
		}
	}
	return null;
}

function framePassReads(pass: ICustomRenderPassDefinition): Array<{ name: string; source: string; path: string | null; output: string | null }> {
	if (pass.passType === "copy") {
		return [
			{
				name: "copySource",
				source: pass.copySource.source,
				path: pass.copySource.path ?? null,
				output: pass.copySource.output ?? null,
			},
		];
	}
	if (pass.passType === "raster") {
		return [
			...pass.rasterSettings.meshIds.map((id) => ({ name: id, source: "mesh", path: null, output: null })),
			...(pass.rasterSettings.materialId ? [{ name: pass.rasterSettings.materialId, source: "material", path: null, output: null }] : []),
		];
	}
	return Object.entries(pass.inputs).map(([name, input]) => ({ name, source: input.source, path: input.path ?? null, output: input.output ?? null }));
}

/** Captures an immutable, bounded frame-level view of the authored and currently applied custom render graph. */
export function captureCustomRenderPassFrame(camera: Camera): ICustomRenderPassFrameSnapshot {
	const authored = authoredDefinitionsByCamera.get(camera);
	const applied = appliedDefinitions.get(camera);
	if (!authored || !applied) {
		throw new Error("The custom render-pass graph is not applied. Rebuild/evaluate it before capturing a frame.");
	}
	const scene = camera.getScene();
	const engine = scene.getEngine();
	const frameId = engine.frameId;
	const isolationPassId = debugIsolationPassIds.get(camera) ?? null;
	const authoredOrdered = sortCustomRenderPassGraph(authored.map((pass) => structuredClone(pass)));
	const cameraEligibleIds = new Set(cameraEligibleDefinitions(authoredOrdered, camera).map((pass) => pass.id));
	const schedule = getCustomRenderPassSchedule(authored.map((pass) => structuredClone(pass)));
	const activeById = new Map(applied.map((pass, index) => [pass.id, { pass, index }])) as Map<string, { pass: ICustomRenderPassDefinition; index: number }>;
	const diagnostics = new Map(getCustomRenderPassDiagnostics(camera).map((value) => [value.id, value]));
	const metrics = passCpuMetrics.get(camera) ?? new Map();
	const gpuProfile = getCustomRenderPassGpuProfile(camera, false);
	const gpuById = new Map((gpuProfile.passes as any[]).map((value) => [value.id, value]));
	const passes: ICustomRenderPassFramePass[] = authoredOrdered.map((pass) => {
		const activeEntry = activeById.get(pass.id);
		const active = Boolean(activeEntry?.pass.enabled);
		const diagnostic = diagnostics.get(pass.id);
		const metric = metrics.get(pass.id);
		const gpu = gpuById.get(pass.id) as any;
		return {
			id: pass.id,
			name: pass.name,
			passType: pass.passType,
			injectionPoint: pass.injectionPoint,
			rendererFeatureInstanceId: pass.rendererFeature?.instanceId ?? null,
			phase: pass.injectionPoint,
			enabled: pass.enabled,
			active,
			isolated: isolationPassId === pass.id,
			culledReason: !pass.enabled
				? "disabled"
				: !passMatchesCamera(pass, camera)
					? "cameraFilter"
					: !cameraEligibleIds.has(pass.id)
						? "cameraFilterDependency"
						: isolationPassId && !active
							? "debugIsolation"
							: null,
			executionIndex: active ? (activeEntry?.index ?? null) : null,
			dependencies: [...pass.dependencies],
			reads: framePassReads(pass),
			writes: passOutputs(pass).map((output) => output.name),
			ready: active ? Boolean(diagnostic?.ready) : false,
			error: active ? (diagnostic?.compilationError ?? null) : null,
			executionCount: metric?.executionCount ?? 0,
			lastExecutionFrame: metric?.lastExecutionFrame ?? null,
			executedInCapturedFrame: metric?.lastExecutionFrame === frameId,
			lastCpuDurationMs: metric?.lastCpuDurationMs ?? null,
			averageCpuDurationMs: metric?.executionCount ? metric.totalCpuDurationMs / metric.executionCount : null,
			gpuDurationMs: gpu?.available ? gpu.lastMs : null,
			gpuTimingSource: gpu?.available ? gpu.source : null,
		};
	});
	const resources: ICustomRenderPassFrameResource[] = schedule.outputs.map((output) => {
		const texture = getCustomRenderPassOutputTexture(camera, output.name);
		const size = texture?.getSize();
		return {
			name: output.name,
			producerId: output.producerId,
			producerName: output.producerName,
			consumerIds: [...output.consumerIds],
			firstUse: output.firstUse,
			lastUse: output.lastUse,
			allocationSlot: output.allocationSlot,
			attachmentIndex: output.attachmentIndex,
			outputType: output.outputType,
			outputFormat: output.outputFormat,
			samples: output.outputSamples,
			ratio: output.ratio,
			allocated: Boolean(texture),
			ready: texture?.isReady() ?? false,
			width: size?.width ?? null,
			height: size?.height ?? null,
			textureClass: texture?.getClassName() ?? null,
		};
	});
	const captureId = (frameCaptureSequences.get(camera) ?? 0) + 1;
	frameCaptureSequences.set(camera, captureId);
	const snapshot: ICustomRenderPassFrameSnapshot = {
		version: 1,
		captureId,
		capturedAt: new Date().toISOString(),
		frameId,
		backend: (engine as any).isWebGPU ? "WebGPU" : engine.getClassName(),
		cameraId: camera.id,
		cameraName: camera.name,
		renderWidth: engine.getRenderWidth(),
		renderHeight: engine.getRenderHeight(),
		isolationPassId,
		authoredPassCount: passes.length,
		activePassCount: passes.filter((pass) => pass.active).length,
		culledPassCount: passes.filter((pass) => !pass.active).length,
		resourceCount: resources.length,
		allocationCount: schedule.allocationCount,
		passes,
		resources,
	};
	frameSnapshots.set(camera, snapshot);
	return structuredClone(snapshot);
}

/** Returns the last immutable custom render-graph frame snapshot, if one has been captured. */
export function getCustomRenderPassFrameSnapshot(camera: Camera): ICustomRenderPassFrameSnapshot | null {
	const snapshot = frameSnapshots.get(camera);
	return snapshot ? structuredClone(snapshot) : null;
}

/** Applies or clears transient dependency-closure isolation without mutating persisted graph definitions. */
export function configureCustomRenderPassFrameIsolation(
	scene: Scene,
	camera: Camera,
	definitions: ICustomRenderPassDefinition[],
	passId: string | null,
	rootUrl = ""
): { isolationPassId: string | null; executionOrder: string[]; activePassCount: number } {
	const previous = debugIsolationPassIds.get(camera) ?? null;
	if (passId !== null) {
		const target = definitions.find((pass) => pass.id === passId);
		if (!target) {
			throw new Error(`Custom render pass "${passId}" was not found. List passes and select an existing id.`);
		}
		if (!target.enabled) {
			throw new Error(`Custom render pass "${target.name}" is disabled. Enable it before isolating it.`);
		}
		debugIsolationPassIds.set(camera, passId);
	} else {
		debugIsolationPassIds.delete(camera);
	}
	try {
		const ordered = applyCustomRenderPassGraph(scene, camera, definitions, rootUrl);
		frameSnapshots.delete(camera);
		return {
			isolationPassId: passId,
			executionOrder: ordered.filter((pass) => pass.enabled).map((pass) => pass.id),
			activePassCount: ordered.filter((pass) => pass.enabled).length,
		};
	} catch (error) {
		if (previous) {
			debugIsolationPassIds.set(camera, previous);
		} else {
			debugIsolationPassIds.delete(camera);
		}
		try {
			applyCustomRenderPassGraph(scene, camera, definitions, rootUrl);
		} catch {
			// Preserve the original isolation error; the normal graph diagnostics reports any rollback failure.
		}
		throw error;
	}
}

/** Returns the transient pass-isolation selection for a camera. */
export function getCustomRenderPassFrameIsolation(camera: Camera): string | null {
	return debugIsolationPassIds.get(camera) ?? null;
}

/** Configures transient hardware GPU timing for the camera's custom pass graph. Reapply the graph after enabling so WebGPU targets receive counters. */
export function configureCustomRenderPassGpuProfiling(camera: Camera, enabled: boolean, sampleCapacity = 120): { enabled: boolean; sampleCapacity: number } {
	if (!Number.isInteger(sampleCapacity) || sampleCapacity < 8 || sampleCapacity > 600) {
		throw new Error("GPU profile sampleCapacity must be an integer from 8 through 600.");
	}
	gpuProfileConfigurations.set(camera, { enabled, sampleCapacity });
	if (!enabled) {
		const runtime = gpuProfileRuntimes.get(camera);
		if (runtime?.observer && runtime.observable) {
			runtime.observable.remove(runtime.observer);
		}
		gpuProfileRuntimes.delete(camera);
	}
	return { enabled, sampleCapacity };
}

/** Returns isolated hardware GPU duration samples for every enabled custom pass without substituting CPU or whole-frame timing. */
export function getCustomRenderPassGpuProfile(camera: Camera, includeSamples = false, sampleLimit = 60): any {
	if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 120) {
		throw new Error("GPU profile sampleLimit must be an integer from 1 through 120.");
	}
	const configuration = gpuProfileConfigurations.get(camera) ?? { enabled: false, sampleCapacity: 120 };
	const runtime = gpuProfileRuntimes.get(camera);
	const frameId = camera.getScene().getEngine().frameId;
	const definitions = appliedDefinitions.get(camera) ?? ((camera.getScene().metadata?.babylonEditorCustomRenderPasses ?? []) as ICustomRenderPassDefinition[]);
	const records =
		runtime?.records ??
		definitions
			.filter((pass) => pass.enabled)
			.map((pass) => ({
				id: pass.id,
				name: pass.name,
				passType: pass.passType,
				source: "unavailable" as const,
				samplesNs: [] as number[],
				lastSampleFrame: null,
				droppedSampleCount: 0,
			}));
	return {
		enabled: configuration.enabled,
		backend: (camera.getScene().getEngine() as any).isWebGPU ? "WebGPU" : camera.getScene().getEngine().getClassName(),
		supported: runtime?.supported ?? false,
		mode: runtime?.mode ?? "unavailable",
		reason: runtime
			? runtime.reason
			: configuration.enabled
				? "The custom pass graph has not been applied since GPU profiling was enabled."
				: "GPU pass profiling is disabled.",
		sampleCapacity: configuration.sampleCapacity,
		samplingStrategy: runtime?.mode === "webgl-timestamp" ? "roundRobinAcrossFrames" : runtime?.mode === "webgpu-timestamp" ? "parallelPerResourceCounters" : "unavailable",
		pendingPassId: runtime?.activeRecord?.id ?? null,
		passes: records.map((record) => {
			const samplesMs = record.samplesNs.map((sample) => sample / 1_000_000);
			const lastMs = samplesMs.at(-1) ?? null;
			return {
				id: record.id,
				name: record.name,
				passType: record.passType,
				source: record.source,
				available: samplesMs.length > 0,
				sampleCount: samplesMs.length,
				lastMs,
				averageMs: samplesMs.length ? samplesMs.reduce((sum, sample) => sum + sample, 0) / samplesMs.length : null,
				minimumMs: samplesMs.length ? Math.min(...samplesMs) : null,
				maximumMs: samplesMs.length ? Math.max(...samplesMs) : null,
				lastSampleFrame: record.lastSampleFrame,
				sampleAgeFrames: record.lastSampleFrame === null ? null : Math.max(0, frameId - record.lastSampleFrame),
				droppedSampleCount: record.droppedSampleCount,
				...(includeSamples ? { samplesMs: samplesMs.slice(-sampleLimit) } : {}),
			};
		}),
	};
}

export interface ICustomRenderPassOutputPixels {
	passId: string;
	passName: string;
	output: string;
	kind: "shader" | "copy" | "raster" | "compute" | "mrt";
	width: number;
	height: number;
	outputType: CustomRenderPassOutputType;
	outputFormat: CustomRenderPassOutputFormat;
	runtimeReady: boolean;
	nonFiniteValueCount: number;
	pixels: Uint8Array;
}

function normalizeOutputPixels(source: ArrayBufferView, width: number, height: number, flipY: boolean): { pixels: Uint8Array; nonFiniteValueCount: number } {
	const values = source as unknown as ArrayLike<number>;
	const pixelCount = width * height;
	const channels = values.length / pixelCount;
	if (![1, 2, 3, 4].includes(channels) || !Number.isInteger(channels)) {
		throw new Error(`Render-graph output readback returned an unsupported ${channels}-channel pixel layout.`);
	}
	const byteValues = source instanceof Uint8Array || source instanceof Uint8ClampedArray;
	const result = new Uint8Array(pixelCount * 4);
	let nonFiniteValueCount = 0;
	for (let y = 0; y < height; y++) {
		const sourceY = flipY ? height - y - 1 : y;
		for (let x = 0; x < width; x++) {
			const sourceOffset = (sourceY * width + x) * channels;
			const targetOffset = (y * width + x) * 4;
			for (let channel = 0; channel < 4; channel++) {
				let value = channel < channels ? values[sourceOffset + channel] : channel === 3 ? (byteValues ? 255 : 1) : 0;
				if (!Number.isFinite(value)) {
					nonFiniteValueCount++;
					value = 0;
				}
				result[targetOffset + channel] = byteValues ? Math.max(0, Math.min(255, Math.round(value))) : Math.max(0, Math.min(255, Math.round(value * 255)));
			}
		}
	}
	return { pixels: result, nonFiniteValueCount };
}

/** Reads one texture-backed named graph output and normalizes byte/float channel layouts to upright RGBA8 pixels. */
export async function readCustomRenderPassOutputPixels(camera: Camera, output: string, flipY = true): Promise<ICustomRenderPassOutputPixels> {
	if (!output?.trim()) {
		throw new Error("Render-graph output capture requires a non-empty output name.");
	}
	const passes = appliedDefinitions.get(camera) ?? ((camera.getScene().metadata?.babylonEditorCustomRenderPasses ?? []) as ICustomRenderPassDefinition[]);
	const pass = passes.find((candidate) => passOutputs(candidate).some((candidateOutput) => candidateOutput.name === output));
	if (!pass) {
		throw new Error(`Named render-graph output was not found: ${output}`);
	}
	const definition = passOutputs(pass).find((candidate) => candidate.name === output)!;
	let texture: BaseTexture | null = null;
	let kind: ICustomRenderPassOutputPixels["kind"] | null = null;
	let runtimeReady = false;
	const single = (singleOutputTargets.get(camera) ?? []).find((candidate) => candidate.output === output);
	if (single) {
		texture = single.target;
		kind = single.passType;
		runtimeReady = single.target.isReady() && single.rendered;
	}
	const raster = (sceneRasterTargets.get(camera) ?? []).find((candidate) => candidate.output === output);
	if (!texture && raster) {
		texture = raster.target;
		kind = "raster";
		runtimeReady = raster.target.isReadyForRendering();
	}
	const compute = (computeTargets.get(camera) ?? []).find((candidate) => candidate.output === output);
	if (!texture && compute) {
		texture = compute.target;
		kind = "compute";
		runtimeReady = compute.shader.isReady() && compute.target.isReady() && compute.dispatched;
	}
	if (!texture) {
		for (const { target } of multiRenderTargets.get(camera) ?? []) {
			const attachment = target.textures.slice(0, target.count).find((candidate) => candidate.name === output);
			if (attachment) {
				texture = attachment;
				kind = "mrt";
				runtimeReady = attachment.isReady();
				break;
			}
		}
	}
	if (!texture || !kind) {
		throw new Error(`Named output "${output}" is not backed by an applied readable render-graph texture.`);
	}
	const size = texture.getSize();
	if (size.width < 1 || size.height < 1 || size.width * size.height > 16_777_216) {
		throw new Error(`Named output "${output}" dimensions ${size.width}×${size.height} are invalid or exceed the 16777216-pixel readback limit.`);
	}
	const pending = texture.readPixels(0, 0, null, true, false, 0, 0, size.width, size.height);
	if (!pending) {
		throw new Error(`Backend ${camera.getScene().getEngine().getClassName()} cannot read pixels from named output "${output}".`);
	}
	const source = await pending;
	const normalized = normalizeOutputPixels(source, size.width, size.height, flipY);
	return {
		passId: pass.id,
		passName: pass.name,
		output,
		kind,
		width: size.width,
		height: size.height,
		outputType: definition.outputType,
		outputFormat: definition.outputFormat,
		runtimeReady,
		nonFiniteValueCount: normalized.nonFiniteValueCount,
		pixels: normalized.pixels,
	};
}

function resolveComputeRuntime(camera: Camera, passReference: string): NonNullable<ReturnType<typeof computeTargets.get>>[number] {
	const value = (computeTargets.get(camera) ?? []).find((candidate) => candidate.id === passReference || candidate.name === passReference);
	if (!value) {
		throw new Error(`Compute pass "${passReference}" has no live WebGPU runtime. Rebuild the graph on a compute-capable backend first.`);
	}
	return value;
}

function validateRuntimeStorageData(definition: ICustomRenderPassComputeStorageBuffer, data: number[]): void {
	if (!Array.isArray(data) || !data.length || data.length > 262_144 || !data.every(Number.isFinite)) {
		throw new Error(`Compute storage buffer "${definition.name}" requires 1 through 262144 finite values.`);
	}
	if (definition.dataType !== "float32" && (!data.every(Number.isInteger) || (definition.dataType === "uint32" && data.some((value) => value < 0)))) {
		throw new Error(`Compute storage buffer "${definition.name}" requires ${definition.dataType === "uint32" ? "non-negative " : ""}integer data.`);
	}
	if (definition.dataType === "int32" && data.some((value) => value < -2_147_483_648 || value > 2_147_483_647)) {
		throw new Error(`Compute storage buffer "${definition.name}" exceeds the int32 range.`);
	}
	if (definition.dataType === "uint32" && data.some((value) => value > 4_294_967_295)) {
		throw new Error(`Compute storage buffer "${definition.name}" exceeds the uint32 range.`);
	}
}

/** Updates a typed live WebGPU storage buffer without rebuilding the render graph. */
export function updateCustomRenderPassComputeStorageBuffer(
	camera: Camera,
	passReference: string,
	bufferName: string,
	data: number[],
	elementOffset = 0,
	updateDefinition = false
): { passId: string; bufferName: string; dataType: string; elementOffset: number; elementCount: number; byteLength: number } {
	const runtime = resolveComputeRuntime(camera, passReference);
	const value = runtime.storageBuffers.find(({ definition }) => definition.name === bufferName);
	if (!value) {
		throw new Error(`Compute pass "${runtime.name}" has no live storage buffer named "${bufferName}".`);
	}
	if (!Number.isInteger(elementOffset) || elementOffset < 0 || elementOffset + data.length > value.definition.data.length) {
		throw new Error(`Storage-buffer update range must fit within ${value.definition.data.length} elements.`);
	}
	validateRuntimeStorageData(value.definition, data);
	const typed = computeStorageData({ ...value.definition, data });
	value.buffer.update(typed, elementOffset * 4, typed.byteLength);
	if (updateDefinition) {
		value.definition.data.splice(elementOffset, data.length, ...data);
	}
	return { passId: runtime.id, bufferName, dataType: value.definition.dataType, elementOffset, elementCount: data.length, byteLength: typed.byteLength };
}

/** Reads a typed range from a live WebGPU storage buffer. */
export async function readCustomRenderPassComputeStorageBuffer(
	camera: Camera,
	passReference: string,
	bufferName: string,
	elementOffset = 0,
	elementCount?: number,
	noDelay = false
): Promise<{ passId: string; bufferName: string; dataType: string; elementOffset: number; elementCount: number; data: number[] }> {
	const runtime = resolveComputeRuntime(camera, passReference);
	const value = runtime.storageBuffers.find(({ definition }) => definition.name === bufferName);
	if (!value) {
		throw new Error(`Compute pass "${runtime.name}" has no live storage buffer named "${bufferName}".`);
	}
	const count = elementCount ?? value.definition.data.length - elementOffset;
	if (!Number.isInteger(elementOffset) || elementOffset < 0 || !Number.isInteger(count) || count < 1 || elementOffset + count > value.definition.data.length) {
		throw new Error(`Storage-buffer read range must contain at least one element and fit within ${value.definition.data.length} elements.`);
	}
	const bytes = await value.buffer.read(elementOffset * 4, count * 4, undefined, noDelay);
	const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	const data =
		value.definition.dataType === "float32"
			? Array.from(new Float32Array(copy), (entry) => Number(entry))
			: value.definition.dataType === "int32"
				? Array.from(new Int32Array(copy), (entry) => Number(entry))
				: Array.from(new Uint32Array(copy), (entry) => Number(entry));
	return { passId: runtime.id, bufferName, dataType: value.definition.dataType, elementOffset, elementCount: count, data };
}

/** Updates selected fields in a live compute uniform buffer without rebuilding the graph. */
export function updateCustomRenderPassComputeUniformBuffer(
	camera: Camera,
	passReference: string,
	bufferName: string,
	values: Record<string, number[]>,
	updateDefinition = false
): { passId: string; bufferName: string; updatedUniforms: string[] } {
	const runtime = resolveComputeRuntime(camera, passReference);
	const value = runtime.uniformBuffers.find(({ definition }) => definition.name === bufferName);
	if (!value) {
		throw new Error(`Compute pass "${runtime.name}" has no live uniform buffer named "${bufferName}".`);
	}
	const entries = Object.entries(values);
	if (!entries.length) {
		throw new Error("Provide at least one compute uniform value to update.");
	}
	for (const [name, nextValue] of entries) {
		const uniform = value.definition.uniforms.find((candidate) => candidate.name === name);
		if (!uniform) {
			throw new Error(`Compute uniform buffer "${bufferName}" has no field named "${name}".`);
		}
		const candidate = { ...uniform, value: [...nextValue] };
		const expectedLength = candidate.type === "vec2" ? 2 : candidate.type === "vec3" ? 3 : candidate.type === "vec4" ? 4 : 1;
		if (candidate.value.length !== expectedLength || !candidate.value.every(Number.isFinite)) {
			throw new Error(`Compute uniform "${name}" requires ${expectedLength} finite value(s).`);
		}
		if (["int", "uint"].includes(candidate.type) && (!candidate.value.every(Number.isInteger) || (candidate.type === "uint" && candidate.value.some((item) => item < 0)))) {
			throw new Error(`Compute uniform "${name}" requires ${candidate.type === "uint" ? "non-negative " : ""}integer data.`);
		}
		if (candidate.type === "int" && candidate.value.some((item) => item < -2_147_483_648 || item > 2_147_483_647)) {
			throw new Error(`Compute uniform "${name}" exceeds the int32 range.`);
		}
		if (candidate.type === "uint" && candidate.value.some((item) => item > 4_294_967_295)) {
			throw new Error(`Compute uniform "${name}" exceeds the uint32 range.`);
		}
		updateComputeUniform(value.buffer, candidate);
		if (updateDefinition) {
			uniform.value = candidate.value;
		}
	}
	value.buffer.update();
	return { passId: runtime.id, bufferName, updatedUniforms: entries.map(([name]) => name) };
}

/** Reports live WebGPU compute outputs and dispatch/compiler state. */
export function getCustomRenderPassComputeTargets(camera: Camera): Array<{
	id: string;
	name: string;
	output: string;
	width: number;
	height: number;
	ready: boolean;
	dispatched: boolean;
	dispatchCount: number;
	lastCpuDispatchDurationMs: number | null;
	averageCpuDispatchDurationMs: number | null;
	error: string | null;
	submitAfterDispatch: boolean;
	uniformBuffers: Array<{ name: string; byteLength: number; uniformCount: number }>;
	storageBuffers: Array<{ name: string; byteLength: number; dataType: string; indirect: boolean; sharedResource: string | null; access: "read" | "write" | "readWrite" }>;
}> {
	return (computeTargets.get(camera) ?? []).map((value) => {
		const size = value.target.getSize();
		return {
			id: value.id,
			name: value.name,
			output: value.output,
			width: size.width,
			height: size.height,
			ready: value.shader.isReady() && value.target.isReady(),
			dispatched: value.dispatched,
			dispatchCount: value.dispatchCount,
			lastCpuDispatchDurationMs: value.lastCpuDispatchDurationMs,
			averageCpuDispatchDurationMs: value.dispatchCount ? value.totalCpuDispatchDurationMs / value.dispatchCount : null,
			error: value.error,
			submitAfterDispatch: value.submitAfterDispatch,
			uniformBuffers: value.uniformBuffers.map(({ definition, buffer }) => ({
				name: definition.name,
				byteLength: buffer.getData().byteLength,
				uniformCount: definition.uniforms.length,
			})),
			storageBuffers: value.storageBuffers.map(({ definition }) => ({
				name: definition.name,
				byteLength: definition.data.length * 4,
				dataType: definition.dataType,
				indirect: definition.indirect,
				sharedResource: definition.sharedResource,
				access: definition.access,
			})),
		};
	});
}

/** Reports live shader readiness and compilation errors for each attached custom pass. */
export function getCustomRenderPassDiagnostics(camera: Camera): Array<{
	id: string;
	name: string;
	passType: CustomRenderPassType;
	ready: boolean;
	compilationError: string | null;
	resources: Array<{ name: string; source: string; path: string | null; output: string | null; ready: boolean }>;
}> {
	const rasterDiagnostics = (sceneRasterTargets.get(camera) ?? []).map((value) => ({
		id: value.id,
		name: value.name,
		passType: "raster" as const,
		ready: value.target.isReadyForRendering(),
		compilationError: null,
		resources: value.meshIds.map((meshId) => ({ name: meshId, source: "mesh", path: null, output: null, ready: Boolean(camera.getScene().getMeshById(meshId)?.isReady()) })),
	}));
	const computeDiagnostics = (computeTargets.get(camera) ?? []).map((value) => ({
		id: value.id,
		name: value.name,
		passType: "compute" as const,
		ready: value.shader.isReady() && value.target.isReady(),
		compilationError: value.error,
		resources: value.resources.map((resource) => ({
			name: resource.name,
			source: resource.source,
			path: resource.path,
			output: resource.output,
			ready: resource.texture.isReady(),
		})),
	}));
	const fullscreenDiagnostics = (postProcesses.get(camera) ?? [])
		.filter(
			(postProcess) =>
				!(postProcess as any)._babylonEditorInternalOutputCapture &&
				!(postProcess as any)._babylonEditorInternalOutputForward &&
				!(postProcess as any)._babylonEditorInternalGpuTimingBoundary
		)
		.map((postProcess) => ({
			id: (postProcess as any)._babylonEditorCustomRenderPassId as string,
			name: postProcess.name,
			passType: ((postProcess as any)._babylonEditorCustomRenderPassType ?? "shader") as CustomRenderPassType,
			ready: postProcess.isReady(),
			compilationError: postProcess.getEffect()?.getCompilationError() || null,
			resources: ((postProcess as any)._babylonEditorCustomRenderPassResources ?? []).map((resource: any) => ({
				name: resource.name,
				source: resource.source,
				path: resource.path,
				output: resource.output,
				ready: resource.source === "pass" ? Boolean(resource.producer?.isReady()) : resource.texture.isReady(),
			})),
		}));
	return [...rasterDiagnostics, ...computeDiagnostics, ...fullscreenDiagnostics];
}

function resolveResourceTexture(scene: Scene, camera: Camera, input: ICustomRenderPassResourceInput, rootUrl: string, createdTextures: Texture[]): BaseTexture {
	if (input.source === "depth") {
		let state = depthStates.get(camera);
		if (!state) {
			const existing = (scene as any)._depthRenderer?.[camera.uniqueId];
			const renderer = scene.enableDepthRenderer(camera, false, true);
			state = { renderer, previousEnabled: existing?.enabled ?? false };
			depthStates.set(camera, state);
		}
		state.renderer.enabled = true;
		return state.renderer.getDepthMap();
	}
	if (input.source === "normal") {
		const renderer = acquireGeometryBufferLease(scene, `custom-render-pass-normal:${camera.uniqueId}`, { normal: true });
		const index = renderer.getTextureIndex(GeometryBufferRenderer.NORMAL_TEXTURE_TYPE);
		const texture = renderer.getGBuffer().textures[index];
		if (!texture) {
			throw new Error("Normal render-pass input could not resolve the geometry-buffer normal texture.");
		}
		return texture;
	}
	const path = input.path!;
	const existing = scene.textures.find((texture) => texture.name === path || (texture as any).url === path || (texture as any).url?.endsWith(`/${path}`));
	if (existing) {
		return existing;
	}
	const url = /^(?:[a-z]+:|\/|[A-Za-z]:[\\/])/.test(path) ? path : `${rootUrl}${path}`;
	const texture = new Texture(url, scene);
	texture.name = path;
	createdTextures.push(texture);
	return texture;
}

function releaseRenderResources(camera: Camera): void {
	const depthState = depthStates.get(camera);
	if (depthState) {
		depthState.renderer.enabled = depthState.previousEnabled;
		depthStates.delete(camera);
	}
	const scene = camera.getScene();
	releaseGeometryBufferLease(scene, `custom-render-pass-normal:${camera.uniqueId}`);
}
