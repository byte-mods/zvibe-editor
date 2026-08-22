import { Scene, Tools } from "babylonjs";
import {
	applyOnTileRendering,
	createDefaultOnTileRenderingConfiguration,
	disposeOnTileRendering,
	getOnTileRenderingConfiguration,
	getOnTileRenderingFingerprint,
	getOnTileRenderingRuntime,
	IOnTileRendererExtensionInstance,
	IOnTileRenderingConfiguration,
	listOnTileRendererProviders,
	onTileRenderingMetadataKey,
	setOnTileRenderingConfiguration,
	validateOnTileRendering,
	validateOnTileRenderingConfiguration,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";
import { getProjectAssetsRootUrl } from "../../project/configuration";

function current(scene: Scene): IOnTileRenderingConfiguration {
	return getOnTileRenderingConfiguration(scene as any, false) ?? createDefaultOnTileRenderingConfiguration();
}

function state(scene: Scene): any {
	const configuration = current(scene);
	return {
		configuration,
		fingerprint: getOnTileRenderingFingerprint(configuration),
		validation: validateOnTileRendering(scene as any, configuration),
		runtime: getOnTileRenderingRuntime(scene as any),
	};
}

function assertLease(scene: Scene, data: any): IOnTileRenderingConfiguration {
	const value = current(scene);
	const fingerprint = getOnTileRenderingFingerprint(value);
	if (data.expectedRevision !== value.revision || data.expectedFingerprint !== fingerprint) {
		throw new Error(`On-Tile rendering state changed. Read it again and use expectedRevision ${value.revision} with expectedFingerprint "${fingerprint}".`);
	}
	return value;
}

function refresh(options: IMCPActionOptions): void {
	options.editor.layout.inspector?.forceUpdate?.();
	options.editor.layout.preview?.setRenderScene?.(true);
}

function publish(scene: Scene, next: IOnTileRenderingConfiguration, options: IMCPActionOptions): any {
	const previousRaw = scene.metadata?.[onTileRenderingMetadataKey] ? structuredClone(scene.metadata[onTileRenderingMetadataKey]) : null;
	const normalized = validateOnTileRenderingConfiguration(next);
	setOnTileRenderingConfiguration(scene as any, normalized);
	try {
		applyOnTileRendering(scene as any, normalized, getProjectAssetsRootUrl() ?? "");
	} catch (error) {
		if (previousRaw) {
			setOnTileRenderingConfiguration(scene as any, previousRaw);
			applyOnTileRendering(scene as any, previousRaw, getProjectAssetsRootUrl() ?? "");
		} else {
			delete scene.metadata?.[onTileRenderingMetadataKey];
			disposeOnTileRendering(scene as any);
		}
		throw error;
	}
	registerUndoRedo({
		undo: () => {
			if (previousRaw) {
				setOnTileRenderingConfiguration(scene as any, previousRaw);
				applyOnTileRendering(scene as any, previousRaw, getProjectAssetsRootUrl() ?? "");
			} else {
				delete scene.metadata?.[onTileRenderingMetadataKey];
				disposeOnTileRendering(scene as any);
			}
		},
		redo: () => {
			setOnTileRenderingConfiguration(scene as any, normalized);
			applyOnTileRendering(scene as any, normalized, getProjectAssetsRootUrl() ?? "");
		},
		action: () => refresh(options),
	});
	refresh(options);
	return state(scene);
}

function exactPatch(data: any): Record<string, unknown> {
	const keys = ["enabled", "validationMode", "tileOnlyMode", "postProcessing"];
	const patch: Record<string, unknown> = {};
	for (const key of keys) {
		if (data[key] !== undefined) {
			patch[key] = structuredClone(data[key]);
		}
	}
	if (!Object.keys(patch).length) {
		throw new Error("Provide at least one On-Tile rendering setting to change.");
	}
	return patch;
}

function resolveExtension(configuration: IOnTileRenderingConfiguration, data: any): IOnTileRendererExtensionInstance {
	if (!data.id && !data.name) {
		throw new Error("Provide an On-Tile extension id or name.");
	}
	if (data.id && data.name) {
		throw new Error("Provide an On-Tile extension id or name, not both.");
	}
	const extension = configuration.extensions.find((entry) => (data.id ? entry.id === data.id : entry.name === data.name));
	if (!extension) {
		throw new Error("On-Tile renderer extension was not found.");
	}
	return extension;
}

/** Reads exact policy, validation, and runtime evidence. */
export function getOnTileRendering(scene: Scene): any {
	return state(scene);
}

/** Updates the exact policy and reapplies the real preview runtime with Undo/Redo. */
export function setOnTileRendering(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = assertLease(scene, data);
	const patch = exactPatch(data);
	return publish(scene, { ...previous, ...patch, revision: previous.revision + 1, extensions: structuredClone(previous.extensions) } as IOnTileRenderingConfiguration, options);
}

/** Lists bounded provider descriptors registered by built-in or trusted project code. */
export function listOnTileProviders(): any {
	const providers = listOnTileRendererProviders();
	return { providers, count: providers.length, maximumExtensions: 32, maximumParametersPerProvider: 16 };
}

/** Creates one exact provider-backed extension instance. */
export function createOnTileExtension(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = assertLease(scene, data);
	if (previous.extensions.length >= 32) {
		throw new Error("On-Tile rendering supports at most 32 extension instances.");
	}
	if (!listOnTileRendererProviders().some((provider) => provider.id === data.providerId)) {
		throw new Error(`On-Tile renderer provider "${data.providerId}" is not registered.`);
	}
	const name = String(data.name).trim();
	if (previous.extensions.some((entry) => entry.name === name)) {
		throw new Error(`On-Tile renderer extension "${name}" already exists.`);
	}
	const extension: IOnTileRendererExtensionInstance = {
		id: Tools.RandomId(),
		name,
		providerId: data.providerId,
		enabled: data.enabled ?? true,
		order: data.order ?? (previous.extensions.length ? Math.max(...previous.extensions.map((entry) => entry.order)) + 1 : 0),
		settings: structuredClone(data.settings ?? {}),
	};
	const result = publish(scene, { ...previous, revision: previous.revision + 1, extensions: [...previous.extensions, extension] }, options);
	return { ...result, extension: result.configuration.extensions.find((entry: IOnTileRendererExtensionInstance) => entry.id === extension.id) };
}

/** Updates one exact extension instance without changing its identity. */
export function setOnTileExtension(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = assertLease(scene, data);
	const extension = resolveExtension(previous, data);
	const next = {
		...extension,
		...(data.newName !== undefined ? { name: data.newName } : {}),
		...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
		...(data.order !== undefined ? { order: data.order } : {}),
		...(data.settings !== undefined ? { settings: structuredClone(data.settings) } : {}),
	};
	if (!["newName", "enabled", "order", "settings"].some((key) => data[key] !== undefined)) {
		throw new Error("Provide at least one On-Tile extension field to change.");
	}
	if (previous.extensions.some((entry) => entry.id !== extension.id && entry.name === next.name)) {
		throw new Error(`On-Tile renderer extension "${next.name}" already exists.`);
	}
	return publish(scene, { ...previous, revision: previous.revision + 1, extensions: previous.extensions.map((entry) => (entry.id === extension.id ? next : entry)) }, options);
}

/** Deletes one exact extension under literal confirmation. */
export function deleteOnTileExtension(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = assertLease(scene, data);
	if (data.confirm !== true) {
		throw new Error("Deleting an On-Tile renderer extension requires confirm: true.");
	}
	const extension = resolveExtension(previous, data);
	const result = publish(scene, { ...previous, revision: previous.revision + 1, extensions: previous.extensions.filter((entry) => entry.id !== extension.id) }, options);
	return { ...result, deleted: true, id: extension.id, name: extension.name };
}

/** Performs a no-write eligibility audit. */
export function validateOnTile(scene: Scene): any {
	const configuration = current(scene);
	return {
		configurationRevision: configuration.revision,
		...validateOnTileRendering(scene as any, configuration),
	};
}

/** Rebuilds the real portable composite under an exact policy lease. */
export function applyOnTile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const configuration = assertLease(scene, data);
	const runtime = applyOnTileRendering(scene as any, configuration, getProjectAssetsRootUrl() ?? "");
	refresh(options);
	return { validation: validateOnTileRendering(scene as any, configuration), runtime };
}

/** Reads live composite/suppression/frame evidence without mutation. */
export function getOnTileRuntime(scene: Scene): any {
	return getOnTileRenderingRuntime(scene as any);
}
