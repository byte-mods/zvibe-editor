import { Camera } from "@babylonjs/core/Cameras/camera";
import { Effect } from "@babylonjs/core/Materials/effect";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import { Logger } from "@babylonjs/core/Misc/logger";
import { Scene } from "@babylonjs/core/scene";

import { applyCustomRenderPassGraph, getCustomRenderPassPostProcesses, ICustomRenderPassDefinition } from "./custom-render-pass-graph";

export const onTileRenderingMetadataKey = "babylonEditorOnTileRendering";

export type OnTileValidationMode = "off" | "warn" | "enforce";

export interface IOnTilePostProcessingConfiguration {
	enabled: boolean;
	exposure: number;
	contrast: number;
	saturation: number;
	vignette: number;
	vignetteSmoothness: number;
}

export interface IOnTileRendererExtensionInstance {
	id: string;
	name: string;
	providerId: string;
	enabled: boolean;
	order: number;
	settings: Record<string, number>;
}

export interface IOnTileRenderingConfiguration {
	version: 1;
	revision: number;
	enabled: boolean;
	validationMode: OnTileValidationMode;
	tileOnlyMode: boolean;
	postProcessing: IOnTilePostProcessingConfiguration;
	extensions: IOnTileRendererExtensionInstance[];
}

export interface IOnTileRendererProviderParameter {
	defaultValue: number;
	minimum: number;
	maximum: number;
}

export interface IOnTileRendererProvider {
	id: string;
	displayName: string;
	version: number;
	description: string;
	parameters: Record<string, IOnTileRendererProviderParameter>;
	/** GLSL statements that may use `color`, `uv`, and `$parameterName` placeholders. */
	fragmentBody: string;
}

export interface IOnTileValidationIssue {
	code: string;
	severity: "warning" | "error";
	featureType: "configuration" | "backend" | "camera-post-process" | "custom-render-pass" | "extension";
	featureId: string | null;
	message: string;
	action: "none" | "suppress-at-runtime" | "register-provider" | "fix-configuration";
}

export interface IOnTileValidationResult {
	valid: boolean;
	compatible: boolean;
	configurationFingerprint: string;
	backend: string;
	nativeTileMemory: false;
	issues: IOnTileValidationIssue[];
	suppressibleFeatureIds: string[];
	activeExtensionCount: number;
	portableCompositePassCount: 0 | 1;
}

export interface IOnTileRuntimeEvidence {
	configurationFingerprint: string;
	configurationRevision: number;
	active: boolean;
	backend: string;
	cameraId: string | null;
	cameraName: string | null;
	portableCompositeAttached: boolean;
	portableCompositeReady: boolean;
	portableCompositePassCount: number;
	activeExtensionIds: string[];
	suppressedCustomPassIds: string[];
	suppressedCameraPostProcesses: string[];
	frameCount: number;
	lastFrameId: number | null;
	error: string | null;
	nativeTileMemory: false;
	nativeBandwidthMeasurement: null;
	boundary: string;
}

interface IOnTileRuntime {
	camera: Camera;
	postProcess: PostProcess | null;
	shaderName: string | null;
	suppressedPostProcesses: Array<{ postProcess: PostProcess; index: number }>;
	evidence: IOnTileRuntimeEvidence;
}

const providers = new Map<string, IOnTileRendererProvider>();
const runtimes = new WeakMap<Scene, IOnTileRuntime>();
const configuredSignatures = new WeakMap<Scene, string>();
const failedSignatures = new WeakMap<Scene, string>();
const runtimeErrors = new WeakMap<Scene, string>();
const shaderReferences = new Map<string, number>();

const defaultPostProcessing = (): IOnTilePostProcessingConfiguration => ({
	enabled: true,
	exposure: 0,
	contrast: 1,
	saturation: 1,
	vignette: 0,
	vignetteSmoothness: 0.5,
});

/** Returns a new default policy without mutating a scene. */
export function createDefaultOnTileRenderingConfiguration(): IOnTileRenderingConfiguration {
	return {
		version: 1,
		revision: 1,
		enabled: false,
		validationMode: "warn",
		tileOnlyMode: false,
		postProcessing: defaultPostProcessing(),
		extensions: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}.`);
	}
}

function finite(value: unknown, minimum: number, maximum: number, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function boundedText(value: unknown, maximum: number, label: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must contain 1–${maximum} characters.`);
	}
	return value.trim();
}

function stable(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(stable).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
		.join(",")}}`;
}

/** Produces the exact portable state fingerprint used by editor and MCP leases. */
export function getOnTileRenderingFingerprint(configuration: IOnTileRenderingConfiguration): string {
	const serialized = stable(configuration);
	let first = 0x811c9dc5;
	let second = 0x9e3779b9;
	for (let index = 0; index < serialized.length; index++) {
		const code = serialized.charCodeAt(index);
		first = Math.imul(first ^ code, 0x01000193) >>> 0;
		second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
	}
	return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

function normalizePostProcessing(value: unknown): IOnTilePostProcessingConfiguration {
	if (!isRecord(value)) {
		throw new Error("On-Tile postProcessing must be an object.");
	}
	assertKeys(value, ["enabled", "exposure", "contrast", "saturation", "vignette", "vignetteSmoothness"], "On-Tile postProcessing");
	if (typeof value.enabled !== "boolean") {
		throw new Error("On-Tile postProcessing.enabled must be a boolean.");
	}
	return {
		enabled: value.enabled,
		exposure: finite(value.exposure, -16, 16, "On-Tile exposure"),
		contrast: finite(value.contrast, 0, 4, "On-Tile contrast"),
		saturation: finite(value.saturation, 0, 4, "On-Tile saturation"),
		vignette: finite(value.vignette, 0, 1, "On-Tile vignette"),
		vignetteSmoothness: finite(value.vignetteSmoothness, 0.01, 1, "On-Tile vignette smoothness"),
	};
}

function normalizeSettings(value: unknown, providerId: string): Record<string, number> {
	if (!isRecord(value)) {
		throw new Error(`On-Tile extension provider "${providerId}" settings must be an object.`);
	}
	if (Object.keys(value).length > 16) {
		throw new Error("On-Tile extension settings support at most 16 values.");
	}
	const result: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
			throw new Error(`Invalid On-Tile extension setting name "${key}".`);
		}
		result[key] = finite(entry, -1_000_000, 1_000_000, `On-Tile extension setting "${key}"`);
	}
	return result;
}

function normalizeExtension(value: unknown): IOnTileRendererExtensionInstance {
	if (!isRecord(value)) {
		throw new Error("On-Tile extension entries must be objects.");
	}
	assertKeys(value, ["id", "name", "providerId", "enabled", "order", "settings"], "On-Tile extension");
	if (typeof value.enabled !== "boolean") {
		throw new Error("On-Tile extension enabled must be a boolean.");
	}
	return {
		id: boundedText(value.id, 128, "On-Tile extension id"),
		name: boundedText(value.name, 128, "On-Tile extension name"),
		providerId: boundedText(value.providerId, 128, "On-Tile provider id"),
		enabled: value.enabled,
		order: finite(value.order, -10_000, 10_000, "On-Tile extension order"),
		settings: normalizeSettings(value.settings, String(value.providerId)),
	};
}

/** Strictly validates and clones one current-version On-Tile policy. */
export function validateOnTileRenderingConfiguration(value: unknown): IOnTileRenderingConfiguration {
	if (!isRecord(value)) {
		throw new Error("On-Tile rendering configuration must be an object.");
	}
	assertKeys(value, ["version", "revision", "enabled", "validationMode", "tileOnlyMode", "postProcessing", "extensions"], "On-Tile rendering configuration");
	if (value.version !== 1) {
		throw new Error("On-Tile rendering configuration version must be 1.");
	}
	if (!Number.isInteger(value.revision) || (value.revision as number) < 1) {
		throw new Error("On-Tile rendering revision must be a positive integer.");
	}
	if (typeof value.enabled !== "boolean" || typeof value.tileOnlyMode !== "boolean") {
		throw new Error("On-Tile enabled and tileOnlyMode must be booleans.");
	}
	if (!(["off", "warn", "enforce"] as unknown[]).includes(value.validationMode)) {
		throw new Error("On-Tile validationMode must be off, warn, or enforce.");
	}
	if (!Array.isArray(value.extensions) || value.extensions.length > 32) {
		throw new Error("On-Tile extensions must be an array with at most 32 entries.");
	}
	const extensions = value.extensions.map(normalizeExtension);
	if (new Set(extensions.map((entry) => entry.id)).size !== extensions.length) {
		throw new Error("On-Tile extension ids must be unique.");
	}
	return {
		version: 1,
		revision: value.revision as number,
		enabled: value.enabled,
		validationMode: value.validationMode as OnTileValidationMode,
		tileOnlyMode: value.tileOnlyMode,
		postProcessing: normalizePostProcessing(value.postProcessing),
		extensions: extensions.sort((first, second) => first.order - second.order || first.id.localeCompare(second.id)),
	};
}

/** Reads a scene's policy, installing a disabled default only when requested. */
export function getOnTileRenderingConfiguration(scene: Scene, create = false): IOnTileRenderingConfiguration | null {
	scene.metadata ??= {};
	const value = scene.metadata[onTileRenderingMetadataKey];
	if (value === undefined || value === null) {
		if (!create) {
			return null;
		}
		const created = createDefaultOnTileRenderingConfiguration();
		scene.metadata[onTileRenderingMetadataKey] = created;
		return structuredClone(created);
	}
	const normalized = validateOnTileRenderingConfiguration(value);
	scene.metadata[onTileRenderingMetadataKey] = normalized;
	return structuredClone(normalized);
}

/** Replaces one exact policy. Revision must already be advanced by its editor-side owner. */
export function setOnTileRenderingConfiguration(scene: Scene, configuration: IOnTileRenderingConfiguration): IOnTileRenderingConfiguration {
	const normalized = validateOnTileRenderingConfiguration(configuration);
	scene.metadata ??= {};
	scene.metadata[onTileRenderingMetadataKey] = normalized;
	configuredSignatures.delete(scene);
	failedSignatures.delete(scene);
	runtimeErrors.delete(scene);
	return structuredClone(normalized);
}

function validateProvider(provider: IOnTileRendererProvider): IOnTileRendererProvider {
	if (!isRecord(provider)) {
		throw new Error("On-Tile renderer provider must be an object.");
	}
	assertKeys(provider as unknown as Record<string, unknown>, ["id", "displayName", "version", "description", "parameters", "fragmentBody"], "On-Tile provider");
	const id = boundedText(provider.id, 128, "On-Tile provider id");
	if (!/^[a-z][a-z0-9-]*$/.test(id)) {
		throw new Error("On-Tile provider id must use lowercase letters, numbers, and hyphens.");
	}
	if (!Number.isInteger(provider.version) || provider.version < 1 || provider.version > 1_000_000) {
		throw new Error("On-Tile provider version must be a positive bounded integer.");
	}
	if (!isRecord(provider.parameters) || Object.keys(provider.parameters).length > 16) {
		throw new Error("On-Tile provider parameters must be an object with at most 16 entries.");
	}
	const parameters: Record<string, IOnTileRendererProviderParameter> = {};
	for (const [name, parameter] of Object.entries(provider.parameters)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || !isRecord(parameter)) {
			throw new Error(`On-Tile provider parameter "${name}" is invalid.`);
		}
		assertKeys(parameter, ["defaultValue", "minimum", "maximum"], `On-Tile provider parameter "${name}"`);
		const minimum = finite(parameter.minimum, -1_000_000, 1_000_000, `${name}.minimum`);
		const maximum = finite(parameter.maximum, minimum, 1_000_000, `${name}.maximum`);
		parameters[name] = { minimum, maximum, defaultValue: finite(parameter.defaultValue, minimum, maximum, `${name}.defaultValue`) };
	}
	const fragmentBody = boundedText(provider.fragmentBody, 8_192, "On-Tile provider fragmentBody");
	if (/\b(?:void\s+main|uniform|sampler|gl_FragColor|#)\b/.test(fragmentBody)) {
		throw new Error("On-Tile provider fragmentBody must be composable statements without main, uniforms, samplers, gl_FragColor, or preprocessor directives.");
	}
	for (const token of fragmentBody.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
		if (!parameters[token[1]]) {
			throw new Error(`On-Tile provider fragmentBody references unknown parameter "$${token[1]}".`);
		}
	}
	return {
		id,
		displayName: boundedText(provider.displayName, 128, "On-Tile provider displayName"),
		version: provider.version,
		description: boundedText(provider.description, 512, "On-Tile provider description"),
		parameters,
		fragmentBody,
	};
}

/** Registers a trusted code provider shared by editor preview and exported runtime. */
export function registerOnTileRendererProvider(provider: IOnTileRendererProvider): () => void {
	const normalized = validateProvider(provider);
	if (providers.has(normalized.id)) {
		throw new Error(`On-Tile renderer provider "${normalized.id}" is already registered.`);
	}
	providers.set(normalized.id, normalized);
	return () => {
		if (providers.get(normalized.id) === normalized) {
			providers.delete(normalized.id);
		}
	};
}

/** Lists immutable registered provider descriptors without executable source. */
export function listOnTileRendererProviders(): Array<Omit<IOnTileRendererProvider, "fragmentBody"> & { builtIn: boolean }> {
	return [...providers.values()]
		.sort((first, second) => first.displayName.localeCompare(second.displayName) || first.id.localeCompare(second.id))
		.map(({ fragmentBody: _fragmentBody, ...provider }) => ({ ...structuredClone(provider), builtIn: provider.id.startsWith("builtin-") }));
}

function engineBackend(scene: Scene): string {
	const engine = scene.getEngine() as any;
	if (engine.isWebGPU === true) {
		return "webgpu";
	}
	const version = engine.webGLVersion ?? engine._webGLVersion ?? 0;
	if (version >= 2) {
		return "webgl2";
	}
	if (version === 1) {
		return "webgl1";
	}
	if (engine.getClassName?.() === "NullEngine") {
		return "null";
	}
	return "unknown";
}

function cameraPostProcesses(camera: Camera): PostProcess[] {
	return (((camera as any)._postProcesses ?? []) as Array<PostProcess | null>).filter((entry): entry is PostProcess => Boolean(entry));
}

function customPasses(scene: Scene): ICustomRenderPassDefinition[] {
	return structuredClone((scene.metadata?.babylonEditorCustomRenderPasses ?? []) as ICustomRenderPassDefinition[]);
}

/** Performs a no-write eligibility audit against the current camera, graph, providers, and backend. */
export function validateOnTileRendering(scene: Scene, configuration?: IOnTileRenderingConfiguration): IOnTileValidationResult {
	const value = validateOnTileRenderingConfiguration(configuration ?? getOnTileRenderingConfiguration(scene, false) ?? createDefaultOnTileRenderingConfiguration());
	const issues: IOnTileValidationIssue[] = [];
	const backend = engineBackend(scene);
	const camera = scene.activeCamera;
	const enabled = value.enabled && value.tileOnlyMode;
	if (enabled && !camera) {
		issues.push({
			code: "ONTILE1001",
			severity: "error",
			featureType: "configuration",
			featureId: null,
			message: "Tile-Only Mode requires an active camera.",
			action: "fix-configuration",
		});
	}
	if (enabled && !["webgl2", "webgpu", "null"].includes(backend)) {
		issues.push({
			code: "ONTILE1002",
			severity: "error",
			featureType: "backend",
			featureId: backend,
			message: `Backend ${backend} cannot run the portable On-Tile composite.`,
			action: "fix-configuration",
		});
	}
	if (enabled && camera) {
		const graphPostProcesses = new Set(getCustomRenderPassPostProcesses(camera));
		for (const postProcess of cameraPostProcesses(camera)) {
			if ((postProcess as any)._babylonEditorOnTileOwned !== true && !graphPostProcesses.has(postProcess)) {
				issues.push({
					code: "ONTILE2001",
					severity: "warning",
					featureType: "camera-post-process",
					featureId: postProcess.name,
					message: `Camera post-process "${postProcess.name}" requires another full-screen pass.`,
					action: value.validationMode === "enforce" ? "suppress-at-runtime" : "none",
				});
			}
		}
	}
	if (enabled) {
		for (const pass of customPasses(scene).filter((entry) => entry.enabled)) {
			issues.push({
				code: "ONTILE2002",
				severity: "warning",
				featureType: "custom-render-pass",
				featureId: pass.id,
				message: `Custom render pass "${pass.name}" (${pass.passType}) allocates or submits outside the fused portable composite.`,
				action: value.validationMode === "enforce" ? "suppress-at-runtime" : "none",
			});
		}
	}
	for (const extension of value.extensions.filter((entry) => entry.enabled)) {
		const provider = providers.get(extension.providerId);
		if (!provider) {
			issues.push({
				code: "ONTILE3001",
				severity: "error",
				featureType: "extension",
				featureId: extension.id,
				message: `Extension "${extension.name}" requires unregistered provider "${extension.providerId}".`,
				action: "register-provider",
			});
			continue;
		}
		const unknown = Object.keys(extension.settings).filter((key) => !provider.parameters[key]);
		if (unknown.length) {
			issues.push({
				code: "ONTILE3002",
				severity: "error",
				featureType: "extension",
				featureId: extension.id,
				message: `Extension "${extension.name}" has unknown setting(s): ${unknown.join(", ")}.`,
				action: "fix-configuration",
			});
		}
		for (const [name, parameter] of Object.entries(provider.parameters)) {
			const setting = extension.settings[name] ?? parameter.defaultValue;
			if (setting < parameter.minimum || setting > parameter.maximum) {
				issues.push({
					code: "ONTILE3003",
					severity: "error",
					featureType: "extension",
					featureId: extension.id,
					message: `Extension "${extension.name}" setting "${name}" must be ${parameter.minimum}–${parameter.maximum}.`,
					action: "fix-configuration",
				});
			}
		}
	}
	const errors = issues.filter((issue) => issue.severity === "error");
	return {
		valid: errors.length === 0,
		compatible: errors.length === 0 && issues.length === 0,
		configurationFingerprint: getOnTileRenderingFingerprint(value),
		backend,
		nativeTileMemory: false,
		issues,
		suppressibleFeatureIds: issues.filter((issue) => issue.action === "suppress-at-runtime" && issue.featureId).map((issue) => issue.featureId!),
		activeExtensionCount: value.extensions.filter((entry) => entry.enabled).length,
		portableCompositePassCount: enabled && (value.postProcessing.enabled || value.extensions.some((entry) => entry.enabled)) ? 1 : 0,
	};
}

function providerShader(configuration: IOnTileRenderingConfiguration): { name: string; uniforms: string[]; values: Record<string, number>; source: string } {
	const active = configuration.extensions.filter((entry) => entry.enabled);
	const uniforms = ["zExposure", "zContrast", "zSaturation", "zVignette", "zVignetteSmoothness"];
	const values: Record<string, number> = {};
	let extensionSource = "";
	active.forEach((extension, index) => {
		const provider = providers.get(extension.providerId)!;
		let body = provider.fragmentBody;
		for (const [name, parameter] of Object.entries(provider.parameters)) {
			const uniform = `zExt${index}_${name}`;
			uniforms.push(uniform);
			values[uniform] = extension.settings[name] ?? parameter.defaultValue;
			body = body.replace(new RegExp(`\\$${name}\\b`, "g"), uniform);
		}
		extensionSource += `\n${body}\n`;
	});
	const fingerprint = getOnTileRenderingFingerprint(configuration);
	const name = `zvibeOnTile_${fingerprint}`;
	const source = `
		precision highp float;
		varying vec2 vUV;
		uniform sampler2D textureSampler;
		uniform float ${uniforms.join("; uniform float ")};
		void main(void) {
			vec2 uv = vUV;
			vec4 color = texture2D(textureSampler, uv);
			color.rgb *= exp2(zExposure);
			float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
			color.rgb = mix(vec3(luminance), color.rgb, zSaturation);
			color.rgb = (color.rgb - 0.5) * zContrast + 0.5;
			float distanceFromCenter = length(uv - vec2(0.5)) * 1.41421356237;
			float vignetteFactor = smoothstep(1.0 - zVignetteSmoothness, 1.0, distanceFromCenter) * zVignette;
			color.rgb *= 1.0 - vignetteFactor;
			${extensionSource}
			gl_FragColor = color;
		}
	`;
	return { name, uniforms, values, source };
}

function restoreSuppressed(runtime: IOnTileRuntime): void {
	for (const entry of runtime.suppressedPostProcesses.sort((first, second) => first.index - second.index)) {
		try {
			runtime.camera.attachPostProcess(entry.postProcess, entry.index);
		} catch {
			// A separately disposed pipeline is not restored.
		}
	}
	runtime.suppressedPostProcesses = [];
}

/** Disposes the portable composite and restores runtime-suppressed camera features. */
export function disposeOnTileRendering(scene: Scene): void {
	const runtime = runtimes.get(scene);
	if (!runtime) {
		return;
	}
	runtime.postProcess?.dispose(runtime.camera);
	if (runtime.shaderName) {
		const remaining = (shaderReferences.get(runtime.shaderName) ?? 1) - 1;
		if (remaining > 0) {
			shaderReferences.set(runtime.shaderName, remaining);
		} else {
			shaderReferences.delete(runtime.shaderName);
			delete Effect.ShadersStore[`${runtime.shaderName}FragmentShader`];
		}
	}
	restoreSuppressed(runtime);
	runtimes.delete(scene);
	configuredSignatures.delete(scene);
}

/** Applies the exact current policy and returns observed portable runtime evidence. */
export function applyOnTileRendering(scene: Scene, configuration?: IOnTileRenderingConfiguration, rootUrl = ""): IOnTileRuntimeEvidence {
	const value = validateOnTileRenderingConfiguration(configuration ?? getOnTileRenderingConfiguration(scene, false) ?? createDefaultOnTileRenderingConfiguration());
	const validation = validateOnTileRendering(scene, value);
	if (!validation.valid) {
		throw new Error(
			`On-Tile validation failed: ${validation.issues
				.filter((issue) => issue.severity === "error")
				.map((issue) => issue.message)
				.join(" ")}`
		);
	}
	const camera = scene.activeCamera;
	disposeOnTileRendering(scene);
	const baseEvidence: IOnTileRuntimeEvidence = {
		configurationFingerprint: validation.configurationFingerprint,
		configurationRevision: value.revision,
		active: false,
		backend: validation.backend,
		cameraId: camera?.id ?? null,
		cameraName: camera?.name ?? null,
		portableCompositeAttached: false,
		portableCompositeReady: false,
		portableCompositePassCount: 0,
		activeExtensionIds: value.extensions.filter((entry) => entry.enabled).map((entry) => entry.id),
		suppressedCustomPassIds: [],
		suppressedCameraPostProcesses: [],
		frameCount: 0,
		lastFrameId: null,
		error: null,
		nativeTileMemory: false,
		nativeBandwidthMeasurement: null,
		boundary: "Portable single-composite WebGL/WebGPU execution; native tile-memory residency and platform GPU bandwidth are not exposed by Babylon/browser APIs.",
	};
	if (!value.enabled || !value.tileOnlyMode || !camera) {
		if (camera && customPasses(scene).length) {
			applyCustomRenderPassGraph(scene, camera, customPasses(scene), rootUrl);
		}
		configuredSignatures.set(scene, `${validation.configurationFingerprint}:${camera?.id ?? "none"}`);
		failedSignatures.delete(scene);
		runtimeErrors.delete(scene);
		return baseEvidence;
	}
	const runtime: IOnTileRuntime = { camera, postProcess: null, shaderName: null, suppressedPostProcesses: [], evidence: { ...baseEvidence, active: true } };
	try {
		if (value.validationMode === "enforce") {
			const graphPostProcesses = new Set(getCustomRenderPassPostProcesses(camera));
			const existing = cameraPostProcesses(camera).filter((entry) => (entry as any)._babylonEditorOnTileOwned !== true && !graphPostProcesses.has(entry));
			runtime.suppressedPostProcesses = existing.map((postProcess, index) => ({ postProcess, index }));
			for (const entry of runtime.suppressedPostProcesses) {
				camera.detachPostProcess(entry.postProcess);
			}
			const passes = customPasses(scene);
			runtime.evidence.suppressedCustomPassIds = passes.filter((entry) => entry.enabled).map((entry) => entry.id);
			if (passes.length) {
				applyCustomRenderPassGraph(scene, camera, passes, rootUrl);
			}
		}
		runtime.evidence.suppressedCameraPostProcesses = runtime.suppressedPostProcesses.map((entry) => entry.postProcess.name);
		if (validation.portableCompositePassCount) {
			const shader = providerShader(value);
			Effect.ShadersStore[`${shader.name}FragmentShader`] = shader.source;
			shaderReferences.set(shader.name, (shaderReferences.get(shader.name) ?? 0) + 1);
			runtime.shaderName = shader.name;
			const postProcess = new PostProcess("Zvibe On-Tile Composite", shader.name, shader.uniforms, null, 1, camera);
			(postProcess as any)._babylonEditorOnTileOwned = true;
			postProcess.onApply = (effect) => {
				effect.setFloat("zExposure", value.postProcessing.enabled ? value.postProcessing.exposure : 0);
				effect.setFloat("zContrast", value.postProcessing.enabled ? value.postProcessing.contrast : 1);
				effect.setFloat("zSaturation", value.postProcessing.enabled ? value.postProcessing.saturation : 1);
				effect.setFloat("zVignette", value.postProcessing.enabled ? value.postProcessing.vignette : 0);
				effect.setFloat("zVignetteSmoothness", value.postProcessing.vignetteSmoothness);
				for (const [name, setting] of Object.entries(shader.values)) {
					effect.setFloat(name, setting);
				}
				runtime.evidence.frameCount++;
				runtime.evidence.lastFrameId = scene.getEngine().frameId;
				runtime.evidence.portableCompositeReady = postProcess.isReady();
			};
			runtime.postProcess = postProcess;
			runtime.evidence.portableCompositeAttached = true;
			runtime.evidence.portableCompositeReady = postProcess.isReady();
			runtime.evidence.portableCompositePassCount = 1;
		}
		runtimes.set(scene, runtime);
		configuredSignatures.set(scene, `${validation.configurationFingerprint}:${camera.id}`);
		failedSignatures.delete(scene);
		runtimeErrors.delete(scene);
		return structuredClone(runtime.evidence);
	} catch (error) {
		runtime.evidence.error = error instanceof Error ? error.message : String(error);
		runtime.postProcess?.dispose(camera);
		if (runtime.shaderName) {
			const remaining = (shaderReferences.get(runtime.shaderName) ?? 1) - 1;
			if (remaining > 0) {
				shaderReferences.set(runtime.shaderName, remaining);
			} else {
				shaderReferences.delete(runtime.shaderName);
				delete Effect.ShadersStore[`${runtime.shaderName}FragmentShader`];
			}
		}
		restoreSuppressed(runtime);
		runtimeErrors.set(scene, runtime.evidence.error);
		throw error;
	}
}

/** Returns bounded live evidence without applying or advancing a frame. */
export function getOnTileRenderingRuntime(scene: Scene): IOnTileRuntimeEvidence {
	const runtime = runtimes.get(scene);
	if (runtime) {
		return structuredClone(runtime.evidence);
	}
	const value = getOnTileRenderingConfiguration(scene, false) ?? createDefaultOnTileRenderingConfiguration();
	return {
		configurationFingerprint: getOnTileRenderingFingerprint(value),
		configurationRevision: value.revision,
		active: false,
		backend: engineBackend(scene),
		cameraId: scene.activeCamera?.id ?? null,
		cameraName: scene.activeCamera?.name ?? null,
		portableCompositeAttached: false,
		portableCompositeReady: false,
		portableCompositePassCount: 0,
		activeExtensionIds: [],
		suppressedCustomPassIds: [],
		suppressedCameraPostProcesses: [],
		frameCount: 0,
		lastFrameId: null,
		error: runtimeErrors.get(scene) ?? null,
		nativeTileMemory: false,
		nativeBandwidthMeasurement: null,
		boundary: "Portable single-composite WebGL/WebGPU execution; native tile-memory residency and platform GPU bandwidth are not exposed by Babylon/browser APIs.",
	};
}

/** Restores a scene policy whenever it or the active camera changes. */
export function configureOnTileRendering(scene: Scene, rootUrl = ""): void {
	scene.onBeforeRenderObservable.add(() => {
		const value = getOnTileRenderingConfiguration(scene, false);
		if (!value) {
			return;
		}
		const signature = `${getOnTileRenderingFingerprint(value)}:${scene.activeCamera?.id ?? "none"}`;
		if (configuredSignatures.get(scene) === signature || failedSignatures.get(scene) === signature) {
			return;
		}
		try {
			applyOnTileRendering(scene, value, rootUrl);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			failedSignatures.set(scene, signature);
			runtimeErrors.set(scene, message);
			Logger.Error(`Failed to restore On-Tile rendering: ${message}`);
		}
	});
	scene.onDisposeObservable.addOnce(() => disposeOnTileRendering(scene));
}

// Built-in examples prove the same extension path used by trusted project registrations.
registerOnTileRendererProvider({
	id: "builtin-color-scale",
	displayName: "Color Scale",
	version: 1,
	description: "Multiplies the fused color by one bounded scalar.",
	parameters: { amount: { defaultValue: 1, minimum: 0, maximum: 4 } },
	fragmentBody: "color.rgb *= $amount;",
});

registerOnTileRendererProvider({
	id: "builtin-posterize",
	displayName: "Posterize",
	version: 1,
	description: "Quantizes fused color channels without another sampled texture.",
	parameters: { steps: { defaultValue: 8, minimum: 2, maximum: 64 } },
	fragmentBody: "color.rgb = floor(color.rgb * $steps) / max(1.0, $steps - 1.0);",
});
