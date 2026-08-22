import { Scene } from "babylonjs";
import {
	AdaptivePerformanceThermalState,
	androidSystemBarsBehaviors,
	androidWindowInsetTypes,
	configureMobileSystemRuntime,
	getMobileSystemCapabilities as getSharedMobileSystemCapabilities,
	getMobileSystemRuntime as getSharedMobileSystemRuntime,
	IMobileSystemConfiguration,
	mobileSystemMetadataKey,
	mobileSystemPlatforms,
	resetMobileSystemRuntime as resetSharedMobileSystemRuntime,
	simulateMobileSystemState as simulateSharedMobileSystemState,
	validateMobileSystemConfiguration,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";

interface IMobileSystemSnapshot {
	hadMetadata: boolean;
	hadConfiguration: boolean;
	configuration: unknown;
}

function assertRecord(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function snapshot(scene: Scene): IMobileSystemSnapshot {
	return {
		hadMetadata: Boolean(scene.metadata),
		hadConfiguration: Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, mobileSystemMetadataKey)),
		configuration: structuredClone(scene.metadata?.[mobileSystemMetadataKey]),
	};
}

function runtimeScene(scene: Scene): Parameters<typeof configureMobileSystemRuntime>[0] {
	return scene as unknown as Parameters<typeof configureMobileSystemRuntime>[0];
}

function refresh(scene: Scene, options: IMCPActionOptions): void {
	configureMobileSystemRuntime(runtimeScene(scene));
	options.editor.layout.inspector?.setEditedObject?.(scene);
	options.editor.layout.inspector?.forceUpdate?.();
	(options.editor.layout as any).mobile?.forceUpdate?.();
}

function restore(scene: Scene, value: IMobileSystemSnapshot, options: IMCPActionOptions): void {
	if (value.hadConfiguration) {
		scene.metadata ??= {};
		scene.metadata[mobileSystemMetadataKey] = structuredClone(value.configuration);
	} else if (scene.metadata) {
		delete scene.metadata[mobileSystemMetadataKey];
		if (!value.hadMetadata && Object.keys(scene.metadata).length === 0) {
			scene.metadata = null;
		}
	}
	refresh(scene, options);
}

function publish(scene: Scene, previous: IMobileSystemSnapshot, next: IMobileSystemConfiguration, options: IMCPActionOptions): IMobileSystemConfiguration {
	scene.metadata ??= {};
	scene.metadata[mobileSystemMetadataKey] = structuredClone(next);
	try {
		refresh(scene, options);
	} catch (error) {
		restore(scene, previous, options);
		throw error;
	}
	registerUndoRedo({
		undo: () => restore(scene, previous, options),
		redo: () => {
			scene.metadata ??= {};
			scene.metadata[mobileSystemMetadataKey] = structuredClone(next);
			refresh(scene, options);
		},
	});
	return structuredClone(next);
}

export function getMobileSystemCapabilities(): object {
	return getSharedMobileSystemCapabilities();
}

export function getMobileSystemConfiguration(scene: Scene): { configuration: IMobileSystemConfiguration; runtime: object } {
	const configuration = validateMobileSystemConfiguration(scene.metadata?.[mobileSystemMetadataKey]);
	const runtime = getSharedMobileSystemRuntime(runtimeScene(scene));
	return { configuration: structuredClone(configuration), runtime: structuredClone(runtime) };
}

/** Applies a nested exact-revision patch without allowing prototype or schema expansion. */
export function setMobileSystemConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): { configuration: IMobileSystemConfiguration; runtime: object } {
	assertRecord(data, ["expectedRevision", "changes", "endpoint", "collaborationToken"], "set_mobile_system_configuration input");
	assertRecord(data.changes, ["platform", "android", "iosThermalFrameRate"], "Mobile System changes");
	if (!Object.keys(data.changes).length) {
		throw new Error("Mobile System changes must contain at least one field.");
	}
	if (data.changes.platform !== undefined && !mobileSystemPlatforms.includes(data.changes.platform as (typeof mobileSystemPlatforms)[number])) {
		throw new Error("Mobile System platform is invalid.");
	}
	if (data.changes.android !== undefined) {
		assertRecord(data.changes.android, ["enabled", "decorFitsSystemWindows", "requestedVisibleWindowInsets", "systemBarsBehavior"], "Android window-inset changes");
		const android = data.changes.android;
		if (
			android.requestedVisibleWindowInsets !== undefined &&
			(!Array.isArray(android.requestedVisibleWindowInsets) || android.requestedVisibleWindowInsets.some((value) => !androidWindowInsetTypes.includes(value)))
		) {
			throw new Error("requestedVisibleWindowInsets contains an unsupported type.");
		}
		if (android.systemBarsBehavior !== undefined && !androidSystemBarsBehaviors.includes(android.systemBarsBehavior as (typeof androidSystemBarsBehaviors)[number])) {
			throw new Error("Android systemBarsBehavior is invalid.");
		}
	}
	if (data.changes.iosThermalFrameRate !== undefined) {
		assertRecord(data.changes.iosThermalFrameRate, ["enabled", "seriousThermalStateFps", "criticalThermalStateFps"], "iOS thermal frame-rate changes");
	}
	const current = validateMobileSystemConfiguration(scene.metadata?.[mobileSystemMetadataKey]);
	if (data.expectedRevision !== current.revision) {
		throw new Error(`Mobile System revision is stale: expected ${String(data.expectedRevision)}, current ${current.revision}.`);
	}
	const changes = data.changes;
	const next = validateMobileSystemConfiguration({
		...current,
		...structuredClone(changes),
		android: { ...current.android, ...(changes.android as object | undefined) },
		iosThermalFrameRate: { ...current.iosThermalFrameRate, ...(changes.iosThermalFrameRate as object | undefined) },
		revision: current.revision + 1,
	});
	const configuration = publish(scene, snapshot(scene), next, options);
	return { configuration, runtime: structuredClone(getSharedMobileSystemRuntime(runtimeScene(scene))) };
}

export function getMobileSystemRuntime(scene: Scene): object {
	const configuration = validateMobileSystemConfiguration(scene.metadata?.[mobileSystemMetadataKey]);
	let runtime = getSharedMobileSystemRuntime(runtimeScene(scene));
	if (runtime.configurationRevision !== configuration.revision) {
		runtime = configureMobileSystemRuntime(runtimeScene(scene), configuration);
	}
	return { configurationRevision: configuration.revision, runtime: structuredClone(runtime) };
}

/** Injects labeled window-inset and/or thermal evidence under one exact configuration lease. */
export function simulateMobileSystemState(scene: Scene, data: unknown, options: IMCPActionOptions): object {
	assertRecord(data, ["expectedRevision", "windowInsets", "visibleWindowInsets", "thermalState", "endpoint", "collaborationToken"], "simulate_mobile_system_state input");
	if (data.windowInsets === undefined && data.visibleWindowInsets === undefined && data.thermalState === undefined) {
		throw new Error("Provide windowInsets, visibleWindowInsets, and/or thermalState.");
	}
	if (data.windowInsets !== undefined) {
		assertRecord(data.windowInsets, ["left", "top", "right", "bottom"], "Simulated windowInsets");
	}
	if (data.thermalState !== undefined && !["unknown", "nominal", "fair", "serious", "critical"].includes(String(data.thermalState))) {
		throw new Error("Simulated thermalState is invalid.");
	}
	const configuration = validateMobileSystemConfiguration(scene.metadata?.[mobileSystemMetadataKey]);
	if (data.expectedRevision !== configuration.revision) {
		throw new Error(`Mobile System revision is stale: expected ${String(data.expectedRevision)}, current ${configuration.revision}.`);
	}
	getMobileSystemRuntime(scene);
	const runtime = simulateSharedMobileSystemState(runtimeScene(scene), {
		windowInsets: data.windowInsets as any,
		visibleWindowInsets: data.visibleWindowInsets as any,
		thermalState: data.thermalState as AdaptivePerformanceThermalState | undefined,
	});
	(options.editor.layout as any).mobile?.forceUpdate?.();
	return { configurationRevision: configuration.revision, simulation: true, hardwareEvidence: false, runtime: structuredClone(runtime) };
}

export function resetMobileSystemRuntime(scene: Scene, data: unknown, options: IMCPActionOptions): object {
	assertRecord(data, ["expectedRevision", "endpoint", "collaborationToken"], "reset_mobile_system_runtime input");
	const configuration = validateMobileSystemConfiguration(scene.metadata?.[mobileSystemMetadataKey]);
	if (data.expectedRevision !== configuration.revision) {
		throw new Error(`Mobile System revision is stale: expected ${String(data.expectedRevision)}, current ${configuration.revision}.`);
	}
	getMobileSystemRuntime(scene);
	const runtime = resetSharedMobileSystemRuntime(runtimeScene(scene));
	(options.editor.layout as any).mobile?.forceUpdate?.();
	return { configurationRevision: configuration.revision, runtime: structuredClone(runtime) };
}
