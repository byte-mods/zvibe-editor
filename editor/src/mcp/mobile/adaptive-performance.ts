import { Scene } from "babylonjs";

import {
	adaptivePerformanceMetadataKey,
	adaptivePerformanceScalerIds,
	adaptivePerformanceThermalStates,
	configureAdaptivePerformance,
	getAdaptivePerformanceCapabilities as getSharedAdaptivePerformanceCapabilities,
	getAdaptivePerformanceRuntime as getSharedAdaptivePerformanceRuntime,
	IAdaptivePerformanceConfiguration,
	resetAdaptivePerformanceRuntime as resetSharedAdaptivePerformanceRuntime,
	sampleAdaptivePerformanceFrame,
	simulateAdaptivePerformanceThermalState as simulateSharedAdaptivePerformanceThermalState,
	validateAdaptivePerformanceConfiguration,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";

interface IAdaptivePerformanceSnapshot {
	hadMetadata: boolean;
	hadConfiguration: boolean;
	configuration: unknown;
}

const configurationFields = [
	"enabled",
	"provider",
	"platform",
	"targetFrameRate",
	"sampleFrames",
	"thermalActionDelaySeconds",
	"performanceActionDelaySeconds",
	"downscaleFrameTimeRatio",
	"upscaleFrameTimeRatio",
	"scalers",
];
const scalerFields = ["id", "enabled", "minimumScale", "maximumScale", "maximumLevel", "visualImpact", "target"];

function assertRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

function validateChanges(value: unknown): asserts value is Record<string, unknown> {
	assertRecord(value, configurationFields, "Adaptive Performance changes");
	if (!Object.keys(value).length) {
		throw new Error("Adaptive Performance changes must contain at least one field.");
	}
	if (value.scalers !== undefined) {
		if (!Array.isArray(value.scalers) || !value.scalers.length || value.scalers.length > adaptivePerformanceScalerIds.length) {
			throw new Error(`Adaptive Performance scaler changes must contain 1 through ${adaptivePerformanceScalerIds.length} entries.`);
		}
		for (const [index, scaler] of value.scalers.entries()) {
			assertRecord(scaler, scalerFields, `Adaptive Performance scaler change ${index}`);
			if (!adaptivePerformanceScalerIds.includes(scaler.id as (typeof adaptivePerformanceScalerIds)[number])) {
				throw new Error(`Adaptive Performance scaler change ${index} requires a valid id.`);
			}
		}
		if (new Set(value.scalers.map((scaler) => (scaler as Record<string, unknown>).id)).size !== value.scalers.length) {
			throw new Error("Adaptive Performance scaler change ids must be unique.");
		}
	}
}

function snapshot(scene: Scene): IAdaptivePerformanceSnapshot {
	return {
		hadMetadata: Boolean(scene.metadata),
		hadConfiguration: Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, adaptivePerformanceMetadataKey)),
		configuration: structuredClone(scene.metadata?.[adaptivePerformanceMetadataKey]),
	};
}

function refresh(scene: Scene, options: IMCPActionOptions): void {
	options.editor.layout.inspector?.setEditedObject?.(scene);
	options.editor.layout.inspector?.forceUpdate?.();
	(options.editor.layout as any).mobile?.forceUpdate?.();
}

function restore(scene: Scene, value: IAdaptivePerformanceSnapshot, options: IMCPActionOptions): void {
	if (value.hadConfiguration) {
		scene.metadata ??= {};
		scene.metadata[adaptivePerformanceMetadataKey] = structuredClone(value.configuration);
	} else if (scene.metadata) {
		delete scene.metadata[adaptivePerformanceMetadataKey];
		if (!value.hadMetadata && Object.keys(scene.metadata).length === 0) {
			scene.metadata = null;
		}
	}
	configureAdaptivePerformance(scene as any);
	refresh(scene, options);
}

function runtimeForConfiguration(scene: Scene, configuration: IAdaptivePerformanceConfiguration): ReturnType<typeof getSharedAdaptivePerformanceRuntime> {
	const runtime = getSharedAdaptivePerformanceRuntime(scene as any);
	return runtime.configurationRevision === configuration.revision ? runtime : configureAdaptivePerformance(scene as any, configuration);
}

/** Reads the normalized exact-revision configuration without persisting defaults. */
export function getAdaptivePerformanceConfiguration(scene: Scene): object {
	const configuration = validateAdaptivePerformanceConfiguration(scene.metadata?.[adaptivePerformanceMetadataKey]);
	return { configuration: structuredClone(configuration), runtime: structuredClone(runtimeForConfiguration(scene, configuration)) };
}

/** Publishes provider/scaler discovery and explicit native-hardware boundaries. */
export function getAdaptivePerformanceCapabilities(): object {
	return {
		...getSharedAdaptivePerformanceCapabilities(),
		mcpTools: [
			"get_adaptive_performance_capabilities",
			"get_adaptive_performance_configuration",
			"set_adaptive_performance_configuration",
			"get_adaptive_performance_runtime",
			"simulate_adaptive_performance_state",
			"reset_adaptive_performance_runtime",
		],
		editorSimulation: { thermalStates: adaptivePerformanceThermalStates, hardwareEvidence: false },
	};
}

/** Atomically patches the provider/indexer/scalers under one exact scene revision with Undo/Redo. */
export function setAdaptivePerformanceConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): object {
	assertRecord(data, ["expectedRevision", "changes", "endpoint", "collaborationToken"], "set_adaptive_performance_configuration input");
	validateChanges(data.changes);
	const current = validateAdaptivePerformanceConfiguration(scene.metadata?.[adaptivePerformanceMetadataKey]);
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== current.revision) {
		throw new Error(`Adaptive Performance revision is stale: expected ${String(data.expectedRevision)}, current ${current.revision}.`);
	}
	const changes = structuredClone(data.changes);
	const scalerChanges = Array.isArray(changes.scalers) ? (changes.scalers as Array<Record<string, unknown>>) : [];
	const next = validateAdaptivePerformanceConfiguration({
		...current,
		...changes,
		revision: current.revision + 1,
		scalers: current.scalers.map((scaler) => ({ ...scaler, ...(scalerChanges.find((candidate) => candidate.id === scaler.id) ?? {}) })),
	});
	const previous = snapshot(scene);
	scene.metadata ??= {};
	scene.metadata[adaptivePerformanceMetadataKey] = structuredClone(next);
	configureAdaptivePerformance(scene as any, next);
	refresh(scene, options);
	registerUndoRedo({
		undo: () => restore(scene, previous, options),
		redo: () => {
			scene.metadata ??= {};
			scene.metadata[adaptivePerformanceMetadataKey] = structuredClone(next);
			configureAdaptivePerformance(scene as any, next);
			refresh(scene, options);
		},
	});
	return getAdaptivePerformanceConfiguration(scene);
}

/** Reads bounded transient provider, timing, thermal, indexer, scaler, warning, and action evidence. */
export function getAdaptivePerformanceRuntime(scene: Scene): object {
	const configuration = validateAdaptivePerformanceConfiguration(scene.metadata?.[adaptivePerformanceMetadataKey]);
	return { configurationRevision: configuration.revision, runtime: structuredClone(runtimeForConfiguration(scene, configuration)) };
}

/** Applies clearly labeled editor simulation and optional deterministic frame samples under the exact authored lease. */
export function simulateAdaptivePerformanceState(scene: Scene, data: unknown, options: IMCPActionOptions): object {
	assertRecord(
		data,
		["expectedRevision", "thermalState", "temperatureLevel", "lowPowerMode", "frameTimeMs", "cpuFrameTimeMs", "gpuFrameTimeMs", "repeat", "endpoint", "collaborationToken"],
		"simulate_adaptive_performance_state input"
	);
	const configuration = validateAdaptivePerformanceConfiguration(scene.metadata?.[adaptivePerformanceMetadataKey]);
	if (data.expectedRevision !== configuration.revision) {
		throw new Error(`Adaptive Performance revision is stale: expected ${String(data.expectedRevision)}, current ${configuration.revision}.`);
	}
	runtimeForConfiguration(scene, configuration);
	if (data.thermalState !== undefined) {
		if (!adaptivePerformanceThermalStates.includes(data.thermalState as (typeof adaptivePerformanceThermalStates)[number])) {
			throw new Error("Adaptive Performance thermalState is invalid.");
		}
		simulateSharedAdaptivePerformanceThermalState(
			scene as any,
			data.thermalState as (typeof adaptivePerformanceThermalStates)[number],
			(data.temperatureLevel as number | null | undefined) ?? null,
			(data.lowPowerMode as boolean | null | undefined) ?? null
		);
	}
	if (data.frameTimeMs !== undefined) {
		const repeat = data.repeat === undefined ? 1 : Number(data.repeat);
		for (let index = 0; index < repeat; index++) {
			sampleAdaptivePerformanceFrame(
				scene as any,
				Number(data.frameTimeMs),
				data.cpuFrameTimeMs === undefined ? null : Number(data.cpuFrameTimeMs),
				data.gpuFrameTimeMs === undefined ? null : Number(data.gpuFrameTimeMs)
			);
		}
	}
	refresh(scene, options);
	return getAdaptivePerformanceRuntime(scene);
}

/** Restores scaler baselines and clears transient evidence under the exact authored lease. */
export function resetAdaptivePerformanceRuntime(scene: Scene, data: unknown, options: IMCPActionOptions): object {
	assertRecord(data, ["expectedRevision", "endpoint", "collaborationToken"], "reset_adaptive_performance_runtime input");
	const configuration = validateAdaptivePerformanceConfiguration(scene.metadata?.[adaptivePerformanceMetadataKey]);
	if (data.expectedRevision !== configuration.revision) {
		throw new Error(`Adaptive Performance revision is stale: expected ${String(data.expectedRevision)}, current ${configuration.revision}.`);
	}
	runtimeForConfiguration(scene, configuration);
	const runtime = resetSharedAdaptivePerformanceRuntime(scene as any);
	refresh(scene, options);
	return { configurationRevision: configuration.revision, runtime: structuredClone(runtime) };
}
