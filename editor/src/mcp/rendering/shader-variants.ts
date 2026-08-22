import { Scene } from "babylonjs";
import {
	configureShaderVariantCollection,
	createDefaultShaderVariantCollectionConfiguration,
	disposeShaderVariantCollection,
	getShaderVariantCollectionConfiguration,
	getShaderVariantCollectionFingerprint,
	getShaderVariantCollectionRuntimeStatus,
	IShaderVariantCollectionConfiguration,
	normalizeShaderVariantCollectionConfiguration,
	prewarmShaderVariantCollection,
	shaderVariantCollectionMetadataKey,
	traceShaderVariantFrame,
	validateShaderVariantCollection,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";

const inputKeys = ["expectedRevision", "expectedFingerprint", "enabled", "automaticTracing", "automaticPrewarming", "maximumVariants", "maximumPrewarmPerLoad"];
const transportKeys = ["endpoint", "collaborationToken"];

function assertInput(data: unknown, allowed: string[], label: string): asserts data is Record<string, any> {
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error(`${label} input must be an object.`);
	}
	const unknown = Object.keys(data).filter((key) => !allowed.includes(key) && !transportKeys.includes(key));
	if (unknown.length) {
		throw new Error(`${label} input contains unknown field(s): ${unknown.join(", ")}.`);
	}
}

function current(scene: Scene): IShaderVariantCollectionConfiguration {
	return getShaderVariantCollectionConfiguration(scene as any);
}

function state(scene: Scene): any {
	const configuration = current(scene);
	return {
		configuration,
		fingerprint: getShaderVariantCollectionFingerprint(configuration),
		validation: validateShaderVariantCollection(scene as any, configuration),
		runtime: getShaderVariantCollectionRuntimeStatus(scene as any),
	};
}

function assertLease(scene: Scene, data: Record<string, any>): IShaderVariantCollectionConfiguration {
	const configuration = current(scene);
	const fingerprint = getShaderVariantCollectionFingerprint(configuration);
	if (data.expectedRevision !== configuration.revision || data.expectedFingerprint !== fingerprint) {
		throw new Error(`Shader Variant Collection changed. Read it again and use expectedRevision ${configuration.revision} with expectedFingerprint "${fingerprint}".`);
	}
	return configuration;
}

function refresh(options: IMCPActionOptions): void {
	options.editor.layout.inspector?.forceUpdate?.();
	options.editor.layout.preview?.setRenderScene?.(true);
}

function install(scene: Scene, configuration: IShaderVariantCollectionConfiguration | null): void {
	if (configuration) {
		scene.metadata ??= {};
		scene.metadata[shaderVariantCollectionMetadataKey] = structuredClone(configuration);
	} else {
		delete scene.metadata?.[shaderVariantCollectionMetadataKey];
	}
	void configureShaderVariantCollection(scene as any);
}

async function publish(scene: Scene, next: IShaderVariantCollectionConfiguration, options: IMCPActionOptions): Promise<any> {
	const previous = scene.metadata?.[shaderVariantCollectionMetadataKey]
		? normalizeShaderVariantCollectionConfiguration(structuredClone(scene.metadata[shaderVariantCollectionMetadataKey]))
		: null;
	const normalized = normalizeShaderVariantCollectionConfiguration(next);
	scene.metadata ??= {};
	scene.metadata[shaderVariantCollectionMetadataKey] = normalized;
	try {
		await configureShaderVariantCollection(scene as any);
	} catch (error) {
		install(scene, previous);
		throw error;
	}
	registerUndoRedo({
		undo: () => install(scene, previous),
		redo: () => install(scene, normalized),
		action: () => refresh(options),
	});
	refresh(options);
	return state(scene);
}

/** Reads exact Graphics settings, collection validation, and live tracing/prewarm evidence. */
export function getShaderVariants(scene: Scene, data: unknown = {}): any {
	assertInput(data, [], "get_shader_variant_collection");
	return state(scene);
}

/** Updates automatic tracing/prewarming policy under the exact collection lease. */
export async function setShaderVariants(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertInput(data, inputKeys, "set_shader_variant_collection");
	const previous = assertLease(scene, data);
	const settingKeys = ["enabled", "automaticTracing", "automaticPrewarming", "maximumVariants", "maximumPrewarmPerLoad"];
	const patch = Object.fromEntries(settingKeys.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
	if (!Object.keys(patch).length) {
		throw new Error("Provide at least one Shader Variant Collection setting to change.");
	}
	return publish(scene, { ...previous, ...patch, revision: previous.revision + 1, variants: structuredClone(previous.variants) }, options);
}

/** Removes all retained variants under literal confirmation while preserving the policy. */
export async function clearShaderVariants(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertInput(data, ["expectedRevision", "expectedFingerprint", "confirm"], "clear_shader_variant_collection");
	const previous = assertLease(scene, data);
	if (data.confirm !== true) {
		throw new Error("Clearing the Shader Variant Collection requires confirm: true.");
	}
	return publish(scene, { ...previous, revision: previous.revision + 1, variants: [] }, options);
}

/** Captures actual current rendered effects into authored collection metadata with Undo/Redo. */
export async function traceShaderVariants(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertInput(data, ["expectedRevision", "expectedFingerprint"], "trace_shader_variant_frame");
	const previous = assertLease(scene, data);
	if (!previous.enabled) {
		throw new Error("Enable the Shader Variant Collection before tracing a frame.");
	}
	const runtime = getShaderVariantCollectionRuntimeStatus(scene as any);
	if (!runtime || runtime.configurationRevision !== previous.revision) {
		await configureShaderVariantCollection(scene as any);
	}
	traceShaderVariantFrame(scene as any);
	const next = current(scene);
	if (next.revision !== previous.revision) {
		const retained = structuredClone(next);
		registerUndoRedo({
			undo: () => install(scene, previous),
			redo: () => install(scene, retained),
			action: () => refresh(options),
		});
		refresh(options);
	}
	return state(scene);
}

/** Compiles the exact retained portable variants without changing authored state. */
export async function prewarmShaderVariants(scene: Scene, data: unknown): Promise<any> {
	assertInput(data, ["expectedRevision", "expectedFingerprint"], "prewarm_shader_variant_collection");
	const configuration = assertLease(scene, data);
	if (!configuration.enabled) {
		throw new Error("Enable the Shader Variant Collection before prewarming it.");
	}
	let runtime = getShaderVariantCollectionRuntimeStatus(scene as any);
	if (!runtime || runtime.configurationRevision !== configuration.revision) {
		runtime = await configureShaderVariantCollection(scene as any);
		if (configuration.automaticPrewarming) {
			return { configurationRevision: configuration.revision, fingerprint: getShaderVariantCollectionFingerprint(configuration), runtime };
		}
	}
	runtime = await prewarmShaderVariantCollection(scene as any);
	return { configurationRevision: configuration.revision, fingerprint: getShaderVariantCollectionFingerprint(configuration), runtime };
}

/** Performs a no-write resource/backend audit. */
export function validateShaderVariants(scene: Scene, data: unknown = {}): any {
	assertInput(data, [], "validate_shader_variant_collection");
	return validateShaderVariantCollection(scene as any, current(scene));
}

/** Reads current runtime evidence without tracing, compiling, or creating a runtime. */
export function getShaderVariantsRuntime(scene: Scene, data: unknown = {}): any {
	assertInput(data, [], "get_shader_variant_collection_runtime");
	return getShaderVariantCollectionRuntimeStatus(scene as any);
}

/** Removes runtime observers without changing authored graphics settings. */
export function disposeShaderVariantsRuntime(scene: Scene): void {
	disposeShaderVariantCollection(scene as any);
}

/** Returns an unpersisted default for editor surfaces with no authored policy. */
export function defaultShaderVariants(): IShaderVariantCollectionConfiguration {
	return createDefaultShaderVariantCollectionConfiguration();
}
