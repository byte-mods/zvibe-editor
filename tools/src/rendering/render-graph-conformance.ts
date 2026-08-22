import type { Camera } from "@babylonjs/core/Cameras/camera";
import type { Scene } from "@babylonjs/core/scene";

import {
	captureCustomRenderPassFrame,
	getCustomRenderPassComputeTargets,
	getCustomRenderPassMultiRenderTargets,
	getCustomRenderPassRuntimeError,
	getCustomRenderPassSceneRasterTargets,
	getCustomRenderPassSchedule,
	ICustomRenderPassDefinition,
} from "./custom-render-pass-graph";

export const renderGraphConformanceMetadataKey = "babylonEditorRenderGraphConformance";
export const renderGraphConformanceBackend = "bounded-render-graph-cross-backend-conformance-v1";

export type RenderGraphConformanceTarget = "webgl2" | "webgpu";

export interface IRenderGraphConformanceRequirements {
	passCount: number;
	enabledPassCount: number;
	outputCount: number;
	shaderPassCount: number;
	copyPassCount: number;
	rasterPassCount: number;
	computePassCount: number;
	mrtPassCount: number;
	maximumColorAttachments: number;
	floatOutputCount: number;
	halfFloatOutputCount: number;
	maximumMsaaSamples: number;
	depthInputCount: number;
	normalInputCount: number;
	projectTextureInputCount: number;
	passOutputInputCount: number;
}

export interface IRenderGraphConformanceCapabilities {
	backend: RenderGraphConformanceTarget | "webgl1" | "null" | "unknown";
	webgl2: boolean;
	webgpu: boolean;
	computeShaders: boolean;
	drawBuffers: boolean;
	maximumDrawBuffers: number;
	floatRenderTargets: boolean;
	halfFloatRenderTargets: boolean;
	floatLinearFiltering: boolean;
	halfFloatLinearFiltering: boolean;
	depthTexture: boolean;
	maximumMsaaSamples: number;
}

export interface IRenderGraphConformanceTargetPlan {
	target: RenderGraphConformanceTarget;
	apiCompatible: boolean;
	blockers: string[];
	deviceChecks: string[];
}

export interface IRenderGraphConformanceRun {
	version: 1;
	backend: RenderGraphConformanceTarget;
	graphSignature: string;
	capturedAt: string;
	frameCount: number;
	frameId: number | null;
	cameraId: string;
	cameraName: string;
	passed: boolean;
	error: string | null;
	capabilities: IRenderGraphConformanceCapabilities;
	requirements: IRenderGraphConformanceRequirements;
	passEvidence: Array<{
		id: string;
		name: string;
		passType: string;
		enabled: boolean;
		active: boolean;
		culledReason: string | null;
		ready: boolean;
		error: string | null;
		executionCount: number;
	}>;
	resourceEvidence: Array<{
		name: string;
		producerId: string;
		allocated: boolean;
		ready: boolean;
		width: number | null;
		height: number | null;
		outputType: string;
		outputFormat: string;
		samples: number;
	}>;
	runtimeTargets: {
		multiRenderTargets: number;
		rasterTargets: number;
		computeTargets: number;
		readyTargets: number;
		dispatchedComputeTargets: number;
	};
}

export interface IRenderGraphConformanceManifest {
	version: 1;
	backend: typeof renderGraphConformanceBackend;
	revision: number;
	graphSignature: string;
	runs: Record<RenderGraphConformanceTarget, IRenderGraphConformanceRun | null>;
}

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	const source = value as Record<string, unknown>;
	return `{${Object.keys(source)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical(source[key])}`)
		.join(",")}}`;
}

/** Produces one deterministic browser-safe graph identity used to invalidate stale cross-backend evidence. */
export function getRenderGraphConformanceSignature(passes: ICustomRenderPassDefinition[]): string {
	const serialized = canonical(passes);
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < serialized.length; index++) {
		const code = serialized.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
	}
	return `fnv1a64-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}-${serialized.length}`;
}

function capabilities(scene: Scene): IRenderGraphConformanceCapabilities {
	const engine = scene.getEngine() as any;
	const caps = engine.getCaps?.() ?? {};
	const webgpu = engine.isWebGPU === true;
	const webglVersion = engine.webGLVersion ?? engine._webGLVersion ?? 0;
	const backend: IRenderGraphConformanceCapabilities["backend"] = webgpu
		? "webgpu"
		: webglVersion >= 2
			? "webgl2"
			: engine.getClassName?.() === "NullEngine"
				? "null"
				: webglVersion === 1
					? "webgl1"
					: "unknown";
	return {
		backend,
		webgl2: backend === "webgl2",
		webgpu,
		computeShaders: Boolean(caps.supportComputeShaders),
		drawBuffers: Boolean(caps.drawBuffersExtension),
		maximumDrawBuffers: Math.max(0, caps.maxDrawBuffers ?? 0),
		floatRenderTargets: Boolean(caps.textureFloatRender),
		halfFloatRenderTargets: Boolean(caps.textureHalfFloatRender),
		floatLinearFiltering: Boolean(caps.textureFloatLinearFiltering),
		halfFloatLinearFiltering: Boolean(caps.textureHalfFloatLinearFiltering),
		depthTexture: Boolean(caps.depthTextureExtension),
		maximumMsaaSamples: Math.max(1, caps.maxMSAASamples ?? 1),
	};
}

function requirements(passes: ICustomRenderPassDefinition[]): IRenderGraphConformanceRequirements {
	const schedule = getCustomRenderPassSchedule(passes);
	const enabled = passes.filter((pass) => pass.enabled);
	const inputs = enabled.flatMap((pass) => [pass.copySource, ...Object.values(pass.inputs)]).filter(Boolean) as Array<{ source: string }>;
	return {
		passCount: passes.length,
		enabledPassCount: enabled.length,
		outputCount: schedule.outputs.length,
		shaderPassCount: enabled.filter((pass) => pass.passType === "shader").length,
		copyPassCount: enabled.filter((pass) => pass.passType === "copy").length,
		rasterPassCount: enabled.filter((pass) => pass.passType === "raster").length,
		computePassCount: enabled.filter((pass) => pass.passType === "compute").length,
		mrtPassCount: enabled.filter((pass) => pass.additionalOutputs.length > 0).length,
		maximumColorAttachments: Math.max(1, ...enabled.map((pass) => (pass.output ? 1 + pass.additionalOutputs.length : 0))),
		floatOutputCount: schedule.outputs.filter((output) => output.outputType === "float").length,
		halfFloatOutputCount: schedule.outputs.filter((output) => output.outputType === "halfFloat").length,
		maximumMsaaSamples: Math.max(1, ...schedule.outputs.map((output) => output.outputSamples)),
		depthInputCount: inputs.filter((input) => input.source === "depth").length,
		normalInputCount: inputs.filter((input) => input.source === "normal").length,
		projectTextureInputCount: inputs.filter((input) => input.source === "texture").length,
		passOutputInputCount: inputs.filter((input) => input.source === "pass").length,
	};
}

function targetPlan(target: RenderGraphConformanceTarget, value: IRenderGraphConformanceRequirements): IRenderGraphConformanceTargetPlan {
	const blockers: string[] = [];
	const deviceChecks: string[] = [];
	if (target === "webgl2" && value.computePassCount) {
		blockers.push(`${value.computePassCount} native compute pass(es) require WebGPU.`);
	}
	if (value.maximumColorAttachments > 1) {
		deviceChecks.push(`At least ${value.maximumColorAttachments} simultaneous color attachments.`);
	}
	if (value.floatOutputCount) {
		deviceChecks.push("Renderable float textures and compatible filtering.");
	}
	if (value.halfFloatOutputCount) {
		deviceChecks.push("Renderable half-float textures and compatible filtering.");
	}
	if (value.maximumMsaaSamples > 1) {
		deviceChecks.push(`At least ${value.maximumMsaaSamples}x render-target MSAA.`);
	}
	if (value.depthInputCount) {
		deviceChecks.push("Sampleable depth textures.");
	}
	if (value.normalInputCount) {
		deviceChecks.push("Geometry-buffer normal textures.");
	}
	if (target === "webgpu" && value.computePassCount) {
		deviceChecks.push("Compute shaders and writable storage textures.");
	}
	return { target, apiCompatible: blockers.length === 0, blockers, deviceChecks };
}

/** Returns static requirements, target-level blockers, and exact current-device capabilities without mutating the graph. */
export function inspectRenderGraphConformance(
	scene: Scene,
	passes?: ICustomRenderPassDefinition[]
): {
	backend: typeof renderGraphConformanceBackend;
	graphSignature: string;
	requirements: IRenderGraphConformanceRequirements;
	capabilities: IRenderGraphConformanceCapabilities;
	targets: Record<RenderGraphConformanceTarget, IRenderGraphConformanceTargetPlan>;
} {
	const definitions = structuredClone(passes ?? ((scene.metadata?.babylonEditorCustomRenderPasses ?? []) as ICustomRenderPassDefinition[]));
	const value = requirements(definitions);
	return {
		backend: renderGraphConformanceBackend,
		graphSignature: getRenderGraphConformanceSignature(definitions),
		requirements: value,
		capabilities: capabilities(scene),
		targets: { webgl2: targetPlan("webgl2", value), webgpu: targetPlan("webgpu", value) },
	};
}

function onlyKeys(value: Record<string, unknown>, keys: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !keys.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function validateRun(value: unknown, target: RenderGraphConformanceTarget): IRenderGraphConformanceRun {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${target} conformance run must be an object.`);
	}
	const run = value as Record<string, unknown>;
	onlyKeys(
		run,
		[
			"version",
			"backend",
			"graphSignature",
			"capturedAt",
			"frameCount",
			"frameId",
			"cameraId",
			"cameraName",
			"passed",
			"error",
			"capabilities",
			"requirements",
			"passEvidence",
			"resourceEvidence",
			"runtimeTargets",
		],
		`${target} conformance run`
	);
	if (run.version !== 1 || run.backend !== target || typeof run.graphSignature !== "string" || !run.graphSignature) {
		throw new Error(`${target} conformance run identity is invalid.`);
	}
	if (
		typeof run.capturedAt !== "string" ||
		!Number.isInteger(run.frameCount) ||
		(run.frameCount as number) < 1 ||
		typeof run.cameraId !== "string" ||
		typeof run.cameraName !== "string"
	) {
		throw new Error(`${target} conformance run capture fields are invalid.`);
	}
	if (typeof run.passed !== "boolean" || (run.error !== null && typeof run.error !== "string") || !Array.isArray(run.passEvidence) || !Array.isArray(run.resourceEvidence)) {
		throw new Error(`${target} conformance run result fields are invalid.`);
	}
	if (JSON.stringify(run).length > 2_000_000) {
		throw new Error(`${target} conformance run exceeds the 2 MB evidence limit.`);
	}
	return structuredClone(run) as unknown as IRenderGraphConformanceRun;
}

/** Validates persisted cross-backend run evidence and rejects forward/unknown fields. */
export function validateRenderGraphConformanceManifest(value: unknown): IRenderGraphConformanceManifest | null {
	if (value === undefined || value === null) {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Render-graph conformance metadata must be an object.");
	}
	const manifest = value as Record<string, unknown>;
	onlyKeys(manifest, ["version", "backend", "revision", "graphSignature", "runs"], "Render-graph conformance metadata");
	if (manifest.version !== 1 || manifest.backend !== renderGraphConformanceBackend || !Number.isInteger(manifest.revision) || (manifest.revision as number) < 1) {
		throw new Error("Render-graph conformance metadata identity or revision is invalid.");
	}
	if (typeof manifest.graphSignature !== "string" || !manifest.graphSignature) {
		throw new Error("Render-graph conformance graphSignature is invalid.");
	}
	if (!manifest.runs || typeof manifest.runs !== "object" || Array.isArray(manifest.runs)) {
		throw new Error("Render-graph conformance runs must be an object.");
	}
	const runs = manifest.runs as Record<string, unknown>;
	onlyKeys(runs, ["webgl2", "webgpu"], "Render-graph conformance runs");
	return {
		version: 1,
		backend: renderGraphConformanceBackend,
		revision: manifest.revision as number,
		graphSignature: manifest.graphSignature,
		runs: {
			webgl2: runs.webgl2 === null || runs.webgl2 === undefined ? null : validateRun(runs.webgl2, "webgl2"),
			webgpu: runs.webgpu === null || runs.webgpu === undefined ? null : validateRun(runs.webgpu, "webgpu"),
		},
	};
}

/** Captures exact applied-pass/resource readiness after the caller has submitted the requested live frames. */
export function captureRenderGraphConformanceRun(
	scene: Scene,
	camera: Camera,
	passes: ICustomRenderPassDefinition[],
	frameCount: number,
	runtimeErrorOverride: string | null = null
): IRenderGraphConformanceRun {
	const inspection = inspectRenderGraphConformance(scene, passes);
	if (inspection.capabilities.backend !== "webgl2" && inspection.capabilities.backend !== "webgpu") {
		throw new Error(`Render-graph conformance requires a live WebGL2 or WebGPU engine; current backend is ${inspection.capabilities.backend}.`);
	}
	let snapshot: ReturnType<typeof captureCustomRenderPassFrame> | null = null;
	let captureError = runtimeErrorOverride ?? getCustomRenderPassRuntimeError(camera);
	if (!captureError) {
		try {
			snapshot = captureCustomRenderPassFrame(camera);
		} catch (error) {
			captureError = error instanceof Error ? error.message : String(error);
		}
	}
	const passEvidence =
		snapshot?.passes.map((pass) => ({
			id: pass.id,
			name: pass.name,
			passType: pass.passType,
			enabled: pass.enabled,
			active: pass.active,
			culledReason: pass.culledReason,
			ready: pass.ready,
			error: pass.error,
			executionCount: pass.executionCount,
		})) ??
		passes.map((pass) => ({
			id: pass.id,
			name: pass.name,
			passType: pass.passType,
			enabled: pass.enabled,
			active: false,
			culledReason: null,
			ready: false,
			error: captureError,
			executionCount: 0,
		}));
	const resourceEvidence =
		snapshot?.resources.map((resource) => ({
			name: resource.name,
			producerId: resource.producerId,
			allocated: resource.allocated,
			ready: resource.ready,
			width: resource.width,
			height: resource.height,
			outputType: resource.outputType,
			outputFormat: resource.outputFormat,
			samples: resource.samples,
		})) ?? [];
	const multi = getCustomRenderPassMultiRenderTargets(camera);
	const rasters = getCustomRenderPassSceneRasterTargets(camera);
	const computes = getCustomRenderPassComputeTargets(camera);
	const readyTargets =
		multi.filter((target) => target.attachments.every((attachment) => attachment.ready)).length +
		rasters.filter((target) => target.ready && !target.resolutionError).length +
		computes.filter((target) => target.ready && !target.error).length;
	const activePasses = passEvidence.filter((pass) => pass.active);
	const activeResources = resourceEvidence.filter((resource) => resource.allocated);
	const passed =
		!captureError &&
		activePasses.every((pass) => pass.ready && !pass.error) &&
		activeResources.every((resource) => resource.ready) &&
		computes.every((target) => target.ready && !target.error && target.dispatched);
	return {
		version: 1,
		backend: inspection.capabilities.backend,
		graphSignature: inspection.graphSignature,
		capturedAt: new Date().toISOString(),
		frameCount,
		frameId: snapshot?.frameId ?? null,
		cameraId: camera.id,
		cameraName: camera.name,
		passed,
		error: captureError,
		capabilities: inspection.capabilities,
		requirements: inspection.requirements,
		passEvidence,
		resourceEvidence,
		runtimeTargets: {
			multiRenderTargets: multi.length,
			rasterTargets: rasters.length,
			computeTargets: computes.length,
			readyTargets,
			dispatchedComputeTargets: computes.filter((target) => target.dispatched).length,
		},
	};
}

/** Publishes one backend run, preserving only opposite-backend evidence for the exact same graph signature. */
export function recordRenderGraphConformanceRun(scene: Scene, run: IRenderGraphConformanceRun): IRenderGraphConformanceManifest {
	scene.metadata ??= {};
	const previous = validateRenderGraphConformanceManifest(scene.metadata[renderGraphConformanceMetadataKey]);
	const sameGraph = previous?.graphSignature === run.graphSignature;
	const manifest: IRenderGraphConformanceManifest = {
		version: 1,
		backend: renderGraphConformanceBackend,
		revision: (previous?.revision ?? 0) + 1,
		graphSignature: run.graphSignature,
		runs: {
			webgl2: sameGraph ? previous!.runs.webgl2 : null,
			webgpu: sameGraph ? previous!.runs.webgpu : null,
			[run.backend]: structuredClone(run),
		},
	};
	scene.metadata[renderGraphConformanceMetadataKey] = manifest;
	return structuredClone(manifest);
}
