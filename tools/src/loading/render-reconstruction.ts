import { Camera } from "@babylonjs/core/Cameras/camera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RenderTargetWrapper } from "@babylonjs/core/Engines/renderTargetWrapper";
import "@babylonjs/core/Engines/Extensions/engine.multiRender";
import "@babylonjs/core/Engines/WebGPU/Extensions/engine.multiRender";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Halton2DSequence } from "@babylonjs/core/Maths/halton2DSequence";
import { Observer } from "@babylonjs/core/Misc/observable";
import { PassPostProcess } from "@babylonjs/core/PostProcesses/passPostProcess";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";
import { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Rendering/geometryBufferRendererSceneComponent";

import { registerDynamicResolutionScaleConsumer } from "./dynamic-resolution";
import { acquireGeometryBufferLease, releaseGeometryBufferLease } from "../rendering/geometry-buffer-lease";

export const renderReconstructionRuntimeBackend = "bounded-full-resolution-reconstruction-v1";
export const renderReconstructionModes = ["disabled", "spatial", "temporal"] as const;
export type RenderReconstructionMode = (typeof renderReconstructionModes)[number];

export interface IRenderReconstructionConfiguration {
	version: 1;
	mode: RenderReconstructionMode;
	sharpness: number;
	edgeThreshold: number;
	historyWeight: number;
	disocclusionThreshold: number;
	jitterSamples: number;
	clampHistory: boolean;
	reprojectHistory: boolean;
	resetOnCameraCut: boolean;
	cameraCutPositionThreshold: number;
	cameraCutRotationThreshold: number;
}

export interface IRenderReconstructionRuntimeEvidence {
	backend: typeof renderReconstructionRuntimeBackend;
	configured: boolean;
	running: boolean;
	profileId: string | null;
	profileRevision: number | null;
	mode: RenderReconstructionMode;
	spatialAlgorithm: "bounded-edge-adaptive-spatial-v1" | null;
	temporalAlgorithm: "bounded-history-clamped-temporal-v1" | "bounded-velocity-reprojected-temporal-v1" | null;
	jitterBackend: "bounded-babylon-halton-projection-jitter-v1" | null;
	cameraId: string | null;
	backendName: string;
	sourceScale: number;
	effectiveSourceScale: number;
	sourceSize: { width: number; height: number } | null;
	outputSize: { width: number; height: number };
	spatialReady: boolean;
	temporalReady: boolean | null;
	presentationReady: boolean;
	velocityRequested: boolean;
	velocityAvailable: boolean;
	historyValid: boolean;
	historyFrames: number;
	historyResets: number;
	lastHistoryResetReason: string | null;
	pingPongIndex: number;
	jitterFrame: number;
	postProcessOrder: string[];
	warnings: string[];
	errors: string[];
}

interface IReconstructionState {
	scene: Scene;
	camera: Camera;
	configuration: IRenderReconstructionConfiguration;
	runtime: IRenderReconstructionRuntimeEvidence;
	spatial: PostProcess;
	boundary: PassPostProcess | null;
	temporal: PostProcess | null;
	present: PassPostProcess | null;
	ping: RenderTargetWrapper | null;
	pong: RenderTargetWrapper | null;
	pingPong: number;
	jitter: IReconstructionJitter | null;
	geometryBuffer: GeometryBufferRenderer | null;
	geometryBufferLeaseHolder: string | null;
	previousPosition: Vector3 | null;
	previousForward: Vector3 | null;
	disposeObserver: Observer<Scene> | null;
	cameraDisposeObserver: Observer<Camera> | null;
}

interface IReconstructionJitter {
	sequence: Halton2DSequence;
	width: number;
	height: number;
}

const states = new WeakMap<Scene, IReconstructionState>();
const spatialShaderName = "babylonEditorEdgeAdaptiveReconstruction";
const temporalShaderName = "babylonEditorTemporalReconstruction";
const scaleConsumerId = "render-reconstruction-source";

const spatialFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform vec2 sourceTexelSize;
uniform float sharpness;
uniform float edgeThreshold;

float reconstructionLuma(vec3 color) {
	return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main(void) {
	vec2 texel = sourceTexelSize;
	vec4 center = texture2D(textureSampler, vUV);
	vec4 north = texture2D(textureSampler, vUV + vec2(0.0, texel.y));
	vec4 south = texture2D(textureSampler, vUV - vec2(0.0, texel.y));
	vec4 east = texture2D(textureSampler, vUV + vec2(texel.x, 0.0));
	vec4 west = texture2D(textureSampler, vUV - vec2(texel.x, 0.0));
	float gradientX = reconstructionLuma(east.rgb) - reconstructionLuma(west.rgb);
	float gradientY = reconstructionLuma(north.rgb) - reconstructionLuma(south.rgb);
	float edge = length(vec2(gradientX, gradientY));
	vec2 tangent = normalize(vec2(-gradientY, gradientX) + vec2(0.000001));
	vec4 alongA = texture2D(textureSampler, vUV + tangent * texel * 0.5);
	vec4 alongB = texture2D(textureSampler, vUV - tangent * texel * 0.5);
	float edgeBlend = clamp(edge / max(edgeThreshold, 0.000001), 0.0, 1.0);
	vec4 reconstructed = mix(center, (alongA + alongB) * 0.5, edgeBlend * 0.35);
	vec4 minimumColor = min(center, min(min(north, south), min(east, west)));
	vec4 maximumColor = max(center, max(max(north, south), max(east, west)));
	vec4 unsharp = reconstructed * 5.0 - north - south - east - west;
	vec4 sharpened = clamp(mix(reconstructed, unsharp, sharpness * (0.25 + edgeBlend * 0.5)), minimumColor, maximumColor);
	gl_FragColor = vec4(sharpened.rgb, center.a);
}`;

const temporalFragmentShader = `
precision highp float;
varying vec2 vUV;
uniform sampler2D textureSampler;
uniform sampler2D historySampler;
#ifdef RECONSTRUCTION_VELOCITY
uniform sampler2D velocitySampler;
#endif
uniform vec2 outputTexelSize;
uniform float historyWeight;
uniform float disocclusionThreshold;
uniform float historyValid;
uniform float clampHistory;

float reconstructionLuma(vec3 color) {
	return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main(void) {
	vec4 current = texture2D(textureSampler, vUV);
	vec2 historyUv = vUV;
#ifdef RECONSTRUCTION_VELOCITY
	historyUv += texture2D(velocitySampler, vUV).xy;
#endif
	bool historyOutside = historyUv.x < 0.0 || historyUv.x > 1.0 || historyUv.y < 0.0 || historyUv.y > 1.0;
	vec4 history = texture2D(historySampler, clamp(historyUv, 0.0, 1.0));
	vec4 minimumColor = vec4(1.0);
	vec4 maximumColor = vec4(0.0);
	for (int x = -1; x <= 1; ++x) {
		for (int y = -1; y <= 1; ++y) {
			vec4 neighbor = texture2D(textureSampler, vUV + vec2(float(x), float(y)) * outputTexelSize);
			minimumColor = min(minimumColor, neighbor);
			maximumColor = max(maximumColor, neighbor);
		}
	}
	vec4 clampedHistory = clamp(history, minimumColor, maximumColor);
	history = mix(history, clampedHistory, clampHistory);
	float difference = abs(reconstructionLuma(current.rgb) - reconstructionLuma(history.rgb));
	float rejection = smoothstep(disocclusionThreshold, disocclusionThreshold * 2.0, difference);
	float weight = historyOutside ? 0.0 : historyWeight * (1.0 - rejection) * historyValid;
	gl_FragColor = mix(current, history, clamp(weight, 0.0, 0.98));
}`;

const spatialFragmentShaderWGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
uniform sourceTexelSize: vec2f;
uniform sharpness: f32;
uniform edgeThreshold: f32;

fn reconstructionLuma(color: vec3f) -> f32 {
	return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
	let texel = uniforms.sourceTexelSize;
	let center = textureSample(textureSampler, textureSamplerSampler, input.vUV);
	let north = textureSample(textureSampler, textureSamplerSampler, input.vUV + vec2f(0.0, texel.y));
	let south = textureSample(textureSampler, textureSamplerSampler, input.vUV - vec2f(0.0, texel.y));
	let east = textureSample(textureSampler, textureSamplerSampler, input.vUV + vec2f(texel.x, 0.0));
	let west = textureSample(textureSampler, textureSamplerSampler, input.vUV - vec2f(texel.x, 0.0));
	let gradientX = reconstructionLuma(east.rgb) - reconstructionLuma(west.rgb);
	let gradientY = reconstructionLuma(north.rgb) - reconstructionLuma(south.rgb);
	let edge = length(vec2f(gradientX, gradientY));
	let tangent = normalize(vec2f(-gradientY, gradientX) + vec2f(0.000001));
	let alongA = textureSample(textureSampler, textureSamplerSampler, input.vUV + tangent * texel * 0.5);
	let alongB = textureSample(textureSampler, textureSamplerSampler, input.vUV - tangent * texel * 0.5);
	let edgeBlend = clamp(edge / max(uniforms.edgeThreshold, 0.000001), 0.0, 1.0);
	let reconstructed = mix(center, (alongA + alongB) * 0.5, edgeBlend * 0.35);
	let minimumColor = min(center, min(min(north, south), min(east, west)));
	let maximumColor = max(center, max(max(north, south), max(east, west)));
	let unsharp = reconstructed * 5.0 - north - south - east - west;
	let sharpened = clamp(mix(reconstructed, unsharp, uniforms.sharpness * (0.25 + edgeBlend * 0.5)), minimumColor, maximumColor);
	fragmentOutputs.color = vec4f(sharpened.rgb, center.a);
}`;

const temporalFragmentShaderWGSL = `
varying vUV: vec2f;
var textureSamplerSampler: sampler;
var textureSampler: texture_2d<f32>;
var historySamplerSampler: sampler;
var historySampler: texture_2d<f32>;
#ifdef RECONSTRUCTION_VELOCITY
var velocitySamplerSampler: sampler;
var velocitySampler: texture_2d<f32>;
#endif
uniform outputTexelSize: vec2f;
uniform historyWeight: f32;
uniform disocclusionThreshold: f32;
uniform historyValid: f32;
uniform clampHistory: f32;

fn reconstructionLuma(color: vec3f) -> f32 {
	return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
	let current = textureSample(textureSampler, textureSamplerSampler, input.vUV);
	var historyUv = input.vUV;
#ifdef RECONSTRUCTION_VELOCITY
	historyUv += textureSample(velocitySampler, velocitySamplerSampler, input.vUV).xy;
#endif
	let historyOutside = historyUv.x < 0.0 || historyUv.x > 1.0 || historyUv.y < 0.0 || historyUv.y > 1.0;
	var history = textureSample(historySampler, historySamplerSampler, clamp(historyUv, vec2f(0.0), vec2f(1.0)));
	var minimumColor = vec4f(1.0);
	var maximumColor = vec4f(0.0);
	for (var x = -1; x <= 1; x += 1) {
		for (var y = -1; y <= 1; y += 1) {
			let neighbor = textureSample(textureSampler, textureSamplerSampler, input.vUV + vec2f(f32(x), f32(y)) * uniforms.outputTexelSize);
			minimumColor = min(minimumColor, neighbor);
			maximumColor = max(maximumColor, neighbor);
		}
	}
	let clampedHistory = clamp(history, minimumColor, maximumColor);
	history = mix(history, clampedHistory, uniforms.clampHistory);
	let difference = abs(reconstructionLuma(current.rgb) - reconstructionLuma(history.rgb));
	let rejection = smoothstep(uniforms.disocclusionThreshold, uniforms.disocclusionThreshold * 2.0, difference);
	var weight = uniforms.historyWeight * (1.0 - rejection) * uniforms.historyValid;
	if (historyOutside) {
		weight = 0.0;
	}
	fragmentOutputs.color = mix(current, history, clamp(weight, 0.0, 0.98));
}`;

function object(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, minimum: number, maximum: number, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
		throw new Error(`${label} must be ${integer ? "an integer" : "a finite number"} from ${minimum} through ${maximum}.`);
	}
	return value;
}

function rounded(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

export function renderReconstructionPreset(): IRenderReconstructionConfiguration {
	return {
		version: 1,
		mode: "disabled",
		sharpness: 0.35,
		edgeThreshold: 0.08,
		historyWeight: 0.9,
		disocclusionThreshold: 0.12,
		jitterSamples: 8,
		clampHistory: true,
		reprojectHistory: true,
		resetOnCameraCut: true,
		cameraCutPositionThreshold: 100,
		cameraCutRotationThreshold: 30,
	};
}

export function validateRenderReconstructionConfiguration(value: unknown): IRenderReconstructionConfiguration {
	if (value === undefined || value === null) {
		return renderReconstructionPreset();
	}
	const source = object(value, "Render reconstruction configuration");
	const allowed = [
		"version",
		"mode",
		"sharpness",
		"edgeThreshold",
		"historyWeight",
		"disocclusionThreshold",
		"jitterSamples",
		"clampHistory",
		"reprojectHistory",
		"resetOnCameraCut",
		"cameraCutPositionThreshold",
		"cameraCutRotationThreshold",
	];
	const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`Unknown render reconstruction field: ${unknown.join(", ")}.`);
	}
	if (source.version !== undefined && source.version !== 1) {
		throw new Error("Render reconstruction configuration version must be 1.");
	}
	const fallback = renderReconstructionPreset();
	const mode = (source.mode ?? fallback.mode) as RenderReconstructionMode;
	if (!renderReconstructionModes.includes(mode)) {
		throw new Error("Render reconstruction mode is invalid.");
	}
	for (const property of ["clampHistory", "reprojectHistory", "resetOnCameraCut"] as const) {
		if (source[property] !== undefined && typeof source[property] !== "boolean") {
			throw new Error(`Render reconstruction ${property} must be boolean.`);
		}
	}
	return {
		version: 1,
		mode,
		sharpness: finite(source.sharpness ?? fallback.sharpness, "Render reconstruction sharpness", 0, 1),
		edgeThreshold: finite(source.edgeThreshold ?? fallback.edgeThreshold, "Render reconstruction edgeThreshold", 0.001, 1),
		historyWeight: finite(source.historyWeight ?? fallback.historyWeight, "Render reconstruction historyWeight", 0, 0.98),
		disocclusionThreshold: finite(source.disocclusionThreshold ?? fallback.disocclusionThreshold, "Render reconstruction disocclusionThreshold", 0.001, 1),
		jitterSamples: finite(source.jitterSamples ?? fallback.jitterSamples, "Render reconstruction jitterSamples", 2, 32, true),
		clampHistory: (source.clampHistory ?? fallback.clampHistory) as boolean,
		reprojectHistory: (source.reprojectHistory ?? fallback.reprojectHistory) as boolean,
		resetOnCameraCut: (source.resetOnCameraCut ?? fallback.resetOnCameraCut) as boolean,
		cameraCutPositionThreshold: finite(
			source.cameraCutPositionThreshold ?? fallback.cameraCutPositionThreshold,
			"Render reconstruction cameraCutPositionThreshold",
			0,
			1_000_000
		),
		cameraCutRotationThreshold: finite(source.cameraCutRotationThreshold ?? fallback.cameraCutRotationThreshold, "Render reconstruction cameraCutRotationThreshold", 0, 180),
	};
}

function outputSize(scene: Scene): { width: number; height: number } {
	return { width: scene.getEngine().getRenderWidth(), height: scene.getEngine().getRenderHeight() };
}

function emptyRuntime(scene: Scene): IRenderReconstructionRuntimeEvidence {
	return {
		backend: renderReconstructionRuntimeBackend,
		configured: false,
		running: false,
		profileId: null,
		profileRevision: null,
		mode: "disabled",
		spatialAlgorithm: null,
		temporalAlgorithm: null,
		jitterBackend: null,
		cameraId: null,
		backendName: scene.getEngine().isWebGPU ? "WebGPU" : scene.getEngine().getClassName(),
		sourceScale: 1,
		effectiveSourceScale: 1,
		sourceSize: null,
		outputSize: outputSize(scene),
		spatialReady: false,
		temporalReady: null,
		presentationReady: false,
		velocityRequested: false,
		velocityAvailable: false,
		historyValid: false,
		historyFrames: 0,
		historyResets: 0,
		lastHistoryResetReason: null,
		pingPongIndex: 0,
		jitterFrame: 0,
		postProcessOrder: [],
		warnings: [],
		errors: [],
	};
}

function disposeTargets(state: IReconstructionState): void {
	state.ping?.dispose();
	state.pong?.dispose();
	state.ping = null;
	state.pong = null;
}

function textureType(scene: Scene): number {
	const caps = scene.getEngine().getCaps();
	return caps.textureHalfFloat && caps.textureHalfFloatRender ? Constants.TEXTURETYPE_HALF_FLOAT : Constants.TEXTURETYPE_UNSIGNED_BYTE;
}

function createHistoryTargets(state: IReconstructionState): void {
	disposeTargets(state);
	const engine = state.scene.getEngine();
	const size = outputSize(state.scene);
	const options = {
		generateMipMaps: false,
		generateDepthBuffer: false,
		generateStencilBuffer: false,
		type: textureType(state.scene),
		samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
	};
	state.ping = engine.createRenderTargetTexture(size, options);
	state.pong = engine.createRenderTargetTexture(size, options);
	state.runtime.outputSize = size;
	state.runtime.pingPongIndex = 0;
	state.pingPong = 0;
}

function resetHistory(state: IReconstructionState, reason: string): void {
	state.runtime.historyValid = false;
	state.runtime.historyFrames = 0;
	state.runtime.historyResets++;
	state.runtime.lastHistoryResetReason = reason;
	state.pingPong = 0;
	state.runtime.pingPongIndex = 0;
	if (state.jitter) {
		state.jitter.sequence.regenerate(state.configuration.jitterSamples);
		state.jitter.width = 0;
		state.jitter.height = 0;
		state.camera.getProjectionMatrix(true);
	}
}

function updateJitter(state: IReconstructionState): void {
	const jitter = state.jitter;
	if (!jitter) {
		return;
	}
	const width = Math.max(1, state.spatial.width);
	const height = Math.max(1, state.spatial.height);
	if (jitter.width !== width || jitter.height !== height) {
		jitter.width = width;
		jitter.height = height;
		jitter.sequence.setDimensions(width / 2, height / 2);
		jitter.sequence.regenerate(state.configuration.jitterSamples);
	}
	jitter.sequence.next();
	if (state.camera.mode === Camera.PERSPECTIVE_CAMERA) {
		const projection = state.camera.getProjectionMatrix();
		projection.setRowFromFloats(2, jitter.sequence.x, jitter.sequence.y, projection.m[10], projection.m[11]);
	} else {
		const projection = state.camera.getProjectionMatrix(true);
		projection.setRowFromFloats(3, jitter.sequence.x + projection.m[12], jitter.sequence.y + projection.m[13], projection.m[14], projection.m[15]);
	}
	state.runtime.jitterFrame++;
}

function updateSizes(state: IReconstructionState): void {
	state.runtime.outputSize = outputSize(state.scene);
	if (state.spatial.width > 0 && state.spatial.height > 0) {
		state.runtime.sourceSize = { width: state.spatial.width, height: state.spatial.height };
		state.runtime.effectiveSourceScale = rounded(state.spatial.width / Math.max(1, state.runtime.outputSize.width));
	}
}

function applySourceScale(state: IReconstructionState, scale: number): { effectiveScale: number; warnings: string[] } {
	const value = rounded(Math.min(2, Math.max(0.25, scale)));
	const allocated = state.spatial.width > 0 && state.spatial.height > 0;
	state.runtime.sourceScale = value;
	(state.spatial as unknown as { _options: number })._options = value;
	state.spatial.markTextureDirty();
	if (allocated) {
		const size = outputSize(state.scene);
		state.spatial.resize(Math.max(1, Math.round(size.width * value)), Math.max(1, Math.round(size.height * value)), state.camera);
		updateSizes(state);
	} else {
		state.runtime.effectiveSourceScale = value;
	}
	return { effectiveScale: state.runtime.effectiveSourceScale, warnings: [] };
}

function forward(camera: Camera): Vector3 {
	return camera.getDirection(Vector3.Forward()).normalize();
}

function angleDegrees(left: Vector3, right: Vector3): number {
	return (Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(left, right)))) * 180) / Math.PI;
}

function updateCameraCut(state: IReconstructionState): void {
	const position = state.camera.globalPosition.clone();
	const direction = forward(state.camera);
	if (state.configuration.resetOnCameraCut && state.previousPosition && state.previousForward) {
		const distance = Vector3.Distance(position, state.previousPosition);
		const rotation = angleDegrees(direction, state.previousForward);
		if (distance > state.configuration.cameraCutPositionThreshold || rotation > state.configuration.cameraCutRotationThreshold) {
			resetHistory(state, `Camera cut detected (${rounded(distance)} position units, ${rounded(rotation)} degrees).`);
		}
	}
	state.previousPosition = position;
	state.previousForward = direction;
}

function attach(camera: Camera, postProcess: PostProcess, index: number): void {
	const currentIndex = ((camera as unknown as { _postProcesses?: Array<PostProcess | null> })._postProcesses ?? []).indexOf(postProcess);
	if (currentIndex !== index) {
		camera.detachPostProcess(postProcess);
		camera.attachPostProcess(postProcess, index);
	}
	postProcess.doNotSerialize = true;
	(postProcess as unknown as { _babylonEditorReconstruction?: boolean })._babylonEditorReconstruction = true;
}

function currentOrder(camera: Camera): string[] {
	return (((camera as unknown as { _postProcesses?: Array<PostProcess | null> })._postProcesses ?? []).filter(Boolean) as PostProcess[]).map((postProcess) => postProcess.name);
}

function existingTemporalConflict(camera: Camera): string | null {
	const names = currentOrder(camera).filter((name) => name === "TAA" || name === "TAAPass" || name.includes("Temporal Reconstruction"));
	return names[0] ?? null;
}

/** Removes the reconstruction stages while preserving every pre-existing camera post-process in its original relative order. */
export function stopRenderReconstruction(scene: Scene): IRenderReconstructionRuntimeEvidence {
	const state = states.get(scene);
	if (!state) {
		registerDynamicResolutionScaleConsumer(scene, null);
		return (scene.renderReconstructionRuntime = emptyRuntime(scene));
	}
	registerDynamicResolutionScaleConsumer(scene, null);
	state.disposeObserver?.remove();
	state.cameraDisposeObserver?.remove();
	for (const postProcess of [state.spatial, state.boundary, state.temporal, state.present]) {
		if (postProcess) {
			state.camera.detachPostProcess(postProcess);
			postProcess.dispose(state.camera);
		}
	}
	disposeTargets(state);
	if (state.geometryBufferLeaseHolder) {
		releaseGeometryBufferLease(state.scene, state.geometryBufferLeaseHolder);
	}
	state.camera.getProjectionMatrix(true);
	states.delete(scene);
	return (scene.renderReconstructionRuntime = emptyRuntime(scene));
}

/** Applies one profile-owned low-resolution scene input plus full-resolution spatial or velocity-reprojected temporal reconstruction chain. */
export function configureRenderReconstruction(
	scene: Scene,
	camera: Camera | null,
	profileId: string,
	profileRevision: number,
	value: unknown,
	initialSourceScale: number
): IRenderReconstructionRuntimeEvidence {
	stopRenderReconstruction(scene);
	const configuration = validateRenderReconstructionConfiguration(value);
	if (configuration.mode === "disabled") {
		const runtime = emptyRuntime(scene);
		runtime.configured = true;
		runtime.profileId = profileId;
		runtime.profileRevision = profileRevision;
		return (scene.renderReconstructionRuntime = runtime);
	}
	if (!camera) {
		throw new Error("Render reconstruction requires an active camera.");
	}
	if (configuration.mode === "temporal") {
		const conflict = existingTemporalConflict(camera);
		if (conflict) {
			throw new Error(`Temporal reconstruction cannot be combined with the existing "${conflict}" temporal post-process.`);
		}
	}
	ShaderStore.ShadersStore[`${spatialShaderName}FragmentShader`] = spatialFragmentShader;
	ShaderStore.ShadersStore[`${temporalShaderName}FragmentShader`] = temporalFragmentShader;
	ShaderStore.ShadersStoreWGSL[`${spatialShaderName}FragmentShader`] = spatialFragmentShaderWGSL;
	ShaderStore.ShadersStoreWGSL[`${temporalShaderName}FragmentShader`] = temporalFragmentShaderWGSL;
	const engine = scene.getEngine();
	if (Math.abs(engine.getHardwareScalingLevel() - 1) > 0.0001) {
		engine.setHardwareScalingLevel(1);
	}
	const runtime: IRenderReconstructionRuntimeEvidence = {
		...emptyRuntime(scene),
		configured: true,
		running: true,
		profileId,
		profileRevision,
		mode: configuration.mode,
		spatialAlgorithm: "bounded-edge-adaptive-spatial-v1",
		temporalAlgorithm: configuration.mode === "temporal" ? "bounded-history-clamped-temporal-v1" : null,
		jitterBackend: configuration.mode === "temporal" ? "bounded-babylon-halton-projection-jitter-v1" : null,
		cameraId: camera.id,
		sourceScale: initialSourceScale,
		effectiveSourceScale: initialSourceScale,
		velocityRequested: configuration.mode === "temporal" && configuration.reprojectHistory,
	};
	const spatial = new PostProcess("Edge-Adaptive Spatial Reconstruction", spatialShaderName, {
		uniforms: ["sourceTexelSize", "sharpness", "edgeThreshold"],
		samplers: null,
		size: initialSourceScale,
		camera,
		engine,
		samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
		shaderLanguage: engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
	});
	const state: IReconstructionState = {
		scene,
		camera,
		configuration,
		runtime,
		spatial,
		boundary: null,
		temporal: null,
		present: null,
		ping: null,
		pong: null,
		pingPong: 0,
		jitter: null,
		geometryBuffer: null,
		geometryBufferLeaseHolder: null,
		previousPosition: null,
		previousForward: null,
		disposeObserver: null,
		cameraDisposeObserver: null,
	};
	states.set(scene, state);
	spatial.onApply = (effect) => {
		updateSizes(state);
		effect.setFloat2("sourceTexelSize", 1 / Math.max(1, spatial.width), 1 / Math.max(1, spatial.height));
		effect.setFloat("sharpness", configuration.sharpness);
		effect.setFloat("edgeThreshold", configuration.edgeThreshold);
	};
	spatial.onActivateObservable.add(() => {
		updateCameraCut(state);
		updateJitter(state);
	});
	spatial.onSizeChangedObservable.add(() => {
		updateSizes(state);
		resetHistory(state, "Source post-process allocation changed.");
	});
	attach(camera, spatial, 0);
	if (configuration.mode === "spatial") {
		state.boundary = new PassPostProcess("Full-Resolution Reconstruction Boundary", 1, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine);
		state.boundary.autoClear = false;
		attach(camera, state.boundary, 1);
	} else {
		if (configuration.reprojectHistory) {
			const holder = `render-reconstruction:${camera.uniqueId}`;
			try {
				state.geometryBuffer = acquireGeometryBufferLease(scene, holder, { velocityLinear: true });
				state.geometryBufferLeaseHolder = holder;
			} catch (error) {
				runtime.warnings.push(error instanceof Error ? error.message : String(error));
			}
		}
		const velocityIndex = state.geometryBuffer?.getTextureIndex(GeometryBufferRenderer.VELOCITY_LINEAR_TEXTURE_TYPE) ?? -1;
		const velocityConfigured = Boolean(state.geometryBuffer?.isSupported && velocityIndex >= 0);
		runtime.velocityAvailable = velocityConfigured;
		runtime.temporalAlgorithm = velocityConfigured ? "bounded-velocity-reprojected-temporal-v1" : "bounded-history-clamped-temporal-v1";
		runtime.jitterBackend = "bounded-babylon-halton-projection-jitter-v1";
		if (configuration.reprojectHistory && !velocityConfigured) {
			runtime.warnings.push("A linear-velocity geometry buffer is unavailable; temporal accumulation falls back to clamped non-reprojected history.");
		}
		const defines = velocityConfigured ? "#define RECONSTRUCTION_VELOCITY" : "";
		state.temporal = new PostProcess("Velocity-Reprojected Temporal Reconstruction", temporalShaderName, {
			uniforms: ["outputTexelSize", "historyWeight", "disocclusionThreshold", "historyValid", "clampHistory"],
			samplers: velocityConfigured ? ["textureSampler", "historySampler", "velocitySampler"] : ["textureSampler", "historySampler"],
			size: 1,
			camera,
			engine,
			samplingMode: Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
			defines,
			textureType: textureType(scene),
			shaderLanguage: engine.isWebGPU ? ShaderLanguage.WGSL : ShaderLanguage.GLSL,
		});
		state.temporal.autoClear = false;
		state.present = new PassPostProcess("Present Temporal Reconstruction History", 1, camera, Constants.TEXTURE_BILINEAR_SAMPLINGMODE, engine);
		state.present.autoClear = false;
		createHistoryTargets(state);
		state.jitter = { sequence: new Halton2DSequence(configuration.jitterSamples), width: 0, height: 0 };
		state.temporal.onActivateObservable.add(() => {
			const size = outputSize(scene);
			if (!state.ping || !state.pong || state.ping.width !== size.width || state.ping.height !== size.height) {
				createHistoryTargets(state);
				resetHistory(state, "Full-resolution history allocation changed.");
			}
			state.present!.inputTexture = state.pingPong ? state.ping! : state.pong!;
			state.pingPong ^= 1;
			runtime.pingPongIndex = state.pingPong;
		});
		state.temporal.onApply = (effect) => {
			const size = outputSize(scene);
			effect.setFloat2("outputTexelSize", 1 / Math.max(1, size.width), 1 / Math.max(1, size.height));
			effect.setFloat("historyWeight", configuration.historyWeight);
			effect.setFloat("disocclusionThreshold", configuration.disocclusionThreshold);
			effect.setFloat("historyValid", runtime.historyValid ? 1 : 0);
			effect.setFloat("clampHistory", configuration.clampHistory ? 1 : 0);
			(effect as unknown as { _bindTexture: (name: string, texture: unknown) => void })._bindTexture(
				"historySampler",
				state.pingPong ? state.ping!.texture : state.pong!.texture
			);
			if (velocityConfigured && state.geometryBuffer) {
				effect.setTexture("velocitySampler", state.geometryBuffer.getGBuffer().textures[velocityIndex]);
			}
		};
		state.temporal.onAfterRenderObservable.add(() => {
			runtime.historyValid = true;
			runtime.historyFrames++;
		});
		attach(camera, state.temporal, 1);
		attach(camera, state.present, 2);
	}
	state.disposeObserver = scene.onDisposeObservable.add(() => stopRenderReconstruction(scene));
	state.cameraDisposeObserver = camera.onDisposeObservable.add(() => stopRenderReconstruction(scene));
	registerDynamicResolutionScaleConsumer(scene, {
		id: scaleConsumerId,
		applyScale: (scale) => applySourceScale(state, scale),
	});
	applySourceScale(state, initialSourceScale);
	runtime.postProcessOrder = currentOrder(camera);
	runtime.spatialReady = spatial.isReady();
	runtime.temporalReady = state.temporal?.isReady() ?? null;
	runtime.presentationReady = (state.boundary ?? state.present)?.isReady() ?? false;
	return (scene.renderReconstructionRuntime = runtime);
}

/** Resets only temporal history/jitter while preserving the exact active reconstruction configuration and source scale. */
export function resetRenderReconstructionHistory(scene: Scene, reason = "History reset requested."): IRenderReconstructionRuntimeEvidence {
	const state = states.get(scene);
	if (!state || state.configuration.mode !== "temporal") {
		throw new Error("No active temporal reconstruction history is configured.");
	}
	resetHistory(state, reason);
	return state.runtime;
}

export function refreshRenderReconstructionRuntime(scene: Scene): IRenderReconstructionRuntimeEvidence {
	const state = states.get(scene);
	if (!state) {
		return scene.renderReconstructionRuntime ?? emptyRuntime(scene);
	}
	updateSizes(state);
	state.runtime.spatialReady = state.spatial.isReady();
	state.runtime.temporalReady = state.temporal?.isReady() ?? null;
	state.runtime.presentationReady = (state.boundary ?? state.present)?.isReady() ?? false;
	state.runtime.postProcessOrder = currentOrder(state.camera);
	if (scene.activeCamera !== state.camera) {
		state.runtime.warnings = [...new Set([...state.runtime.warnings, "The active camera changed after reconstruction was configured."])];
	}
	return state.runtime;
}

export function getRenderReconstructionRuntime(scene: Scene): IRenderReconstructionRuntimeEvidence {
	return refreshRenderReconstructionRuntime(scene);
}

declare module "@babylonjs/core/scene" {
	// Babylon module augmentation must retain the engine's public Scene name.
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		renderReconstructionRuntime?: IRenderReconstructionRuntimeEvidence;
	}
}
