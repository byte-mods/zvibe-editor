import { Scene, Tools } from "babylonjs";
import {
	configureXR,
	createDefaultXRConfiguration,
	enterXRSession,
	exitXRSession,
	getSceneXRConfiguration,
	getXRRuntime,
	getXRRuntimeSnapshot,
	getXRSimulationSnapshot,
	IEditorXRConfiguration,
	IXRInteractableDefinition,
	IXRSimulationInput,
	normalizeXRConfiguration,
	reconfigureXR,
	setSceneXRConfiguration,
	simulateXRInput,
	startXRSimulation,
	stopXRSimulation,
	validateXRTarget,
	XR_SESSION_FEATURES,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

export interface IXRAuthoringSnapshot {
	configuration: IEditorXRConfiguration;
}

const configurationChangeKeys = ["enabled", "session", "origin", "interaction", "locomotion", "simulation", "maxTraceEvents"];
const nestedChangeKeys: Record<string, string[]> = {
	session: ["mode", "referenceSpaceType", "initializeOnStartup", "showEnterExitUI", "requiredFeatures", "optionalFeatures"],
	origin: ["originNodeId", "cameraId", "floorMeshIds", "worldScale"],
	interaction: ["pointerSelection", "nearInteraction", "handTracking", "gazeMode", "preferredHandedness", "maxPointerDistance", "gazeSelectionTimeMs"],
	locomotion: ["teleportation", "continuousMove", "continuousTurn", "movementSpeed", "rotationSpeed", "rotationAngleDegrees", "snapPointsOnly", "snapPoints", "snapRadius"],
	simulation: ["enabled", "environmentMeshIds", "headset", "leftController", "rightController", "maxRayDistance"],
	headset: ["position", "rotation"],
	leftController: ["enabled", "position", "rotation"],
	rightController: ["enabled", "position", "rotation"],
};
const interactableKeys = ["id", "name", "meshId", "enabled", "modes", "interactionLayers", "rotateWithController", "dragSmoothing", "hapticAmplitude", "hapticDurationMs"];
const interactableChangeKeys = interactableKeys.filter((key) => key !== "id");

/** Rejects surplus action fields so direct editor calls retain the same exactness as strict MCP schemas. */
function assertExactRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length) {
		throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
	}
}

/** Admits only editor-owned request routing fields in addition to the public tool schema. */
function assertActionRecord(value: unknown, allowed: string[], label: string): asserts value is Record<string, unknown> {
	assertExactRecord(value, [...allowed, "endpoint", "collaborationToken"], label);
}

/** Applies recursive exact-key checks before canonical normalization handles values and cross-field rules. */
function assertConfigurationChanges(value: unknown): asserts value is Record<string, unknown> {
	assertExactRecord(value, configurationChangeKeys, "XR configuration changes");
	if (!Object.keys(value).length) {
		throw new Error("XR configuration changes must contain at least one field.");
	}
	for (const block of ["session", "origin", "interaction", "locomotion", "simulation"]) {
		if (value[block] !== undefined) {
			assertExactRecord(value[block], nestedChangeKeys[block], `XR ${block} changes`);
		}
	}
	const simulation = value.simulation as Record<string, unknown> | undefined;
	for (const pose of ["headset", "leftController", "rightController"]) {
		if (simulation?.[pose] !== undefined) {
			assertExactRecord(simulation[pose], nestedChangeKeys[pose], `XR simulation ${pose} changes`);
		}
	}
}

/** Keeps stale external clients from overwriting newer authoring revisions. */
function assertRevision(configuration: IEditorXRConfiguration, expectedRevision: unknown): void {
	if (!Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 1) {
		throw new Error("XR mutation requires expectedRevision as a positive safe integer.");
	}
	if (expectedRevision !== configuration.revision) {
		throw new Error(`XR configuration revision is stale: expected ${String(expectedRevision)}, current ${configuration.revision}.`);
	}
}

/** Bounds diagnostic requests before they allocate or serialize runtime traces. */
function traceLimit(value: unknown): number {
	if (value === undefined) {
		return 64;
	}
	if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4096) {
		throw new Error("XR traceLimit must be an integer between 0 and 4096.");
	}
	return value as number;
}

/** Refreshes both the object lease and visible inspector after outside-editor mutations. */
function refreshInspector(scene: Scene, options: IMCPActionOptions): void {
	options.editor.layout.inspector.setEditedObject?.(scene);
	options.editor.layout.inspector.forceUpdate();
}

/** Bridges the monorepo's ESM declarations to the CJS runtime, whose build aliases core imports to the same babylonjs package. */
function runtimeScene(scene: Scene): Parameters<typeof getXRRuntime>[0] {
	return scene as unknown as Parameters<typeof getXRRuntime>[0];
}

/** Publishes one validated revision and refreshes an already-active runtime transactionally. */
async function publishConfiguration(scene: Scene, previous: IEditorXRConfiguration, next: IEditorXRConfiguration, options: IMCPActionOptions): Promise<IEditorXRConfiguration> {
	stopXRSimulation(runtimeScene(scene));
	const hadRuntime = getXRRuntime(runtimeScene(scene)) !== null;
	setSceneXRConfiguration(scene, next);
	try {
		if (hadRuntime) {
			await reconfigureXR(runtimeScene(scene));
		}
	} catch (error) {
		setSceneXRConfiguration(scene, previous);
		if (hadRuntime) {
			await reconfigureXR(runtimeScene(scene));
		}
		throw error;
	}
	refreshInspector(scene, options);
	return structuredClone(next);
}

/** Deep-merges only documented nested authoring blocks into a detached candidate. */
function configurationCandidate(current: IEditorXRConfiguration, changes: Record<string, unknown>): IEditorXRConfiguration {
	const candidate = structuredClone(current) as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(changes)) {
		if (["session", "origin", "interaction", "locomotion", "simulation"].includes(key)) {
			const block = structuredClone(value) as Record<string, unknown>;
			if (key === "simulation") {
				for (const pose of ["headset", "leftController", "rightController"]) {
					if (block[pose] !== undefined) {
						block[pose] = { ...((candidate[key] as Record<string, unknown>)[pose] as Record<string, unknown>), ...(block[pose] as Record<string, unknown>) };
					}
				}
			}
			candidate[key] = { ...(candidate[key] as Record<string, unknown>), ...block };
		} else {
			candidate[key] = structuredClone(value);
		}
	}
	candidate.revision = current.revision + 1;
	return normalizeXRConfiguration(candidate).configuration;
}

/** Captures the normalized canonical state used by editor Undo/Redo. */
export function getXRAuthoringSnapshot(scene: Scene): IXRAuthoringSnapshot {
	return { configuration: getSceneXRConfiguration(scene) };
}

/** Restores one canonical snapshot and resynchronizes active runtime/simulation leases. */
export async function restoreXRAuthoringSnapshot(scene: Scene, snapshot: IXRAuthoringSnapshot, options: IMCPActionOptions): Promise<IEditorXRConfiguration> {
	assertExactRecord(snapshot, ["configuration"], "XR authoring snapshot");
	const current = getSceneXRConfiguration(scene);
	const restored = normalizeXRConfiguration(snapshot.configuration).configuration;
	return publishConfiguration(scene, current, restored, options);
}

/** Lists the editor's portable WebXR scope and explicit native-provider boundary. */
export function getXRCapabilities(scene: Scene): any {
	const configuration = getSceneXRConfiguration(scene);
	return {
		configurationVersion: configuration.version,
		configurationRevision: configuration.revision,
		sessionModes: ["immersive-vr", "immersive-ar"],
		referenceSpaceTypes: ["local", "local-floor", "bounded-floor", "unbounded"],
		sessionFeatures: [...XR_SESSION_FEATURES],
		interactionModes: ["select", "grab", "teleport"],
		interactionSources: ["pointer", "near", "hand", "gaze"],
		locomotion: ["teleportation", "continuous-move", "continuous-turn", "snap-turn"],
		simulation: ["headset-pose", "controller-pose", "ray-select", "grab", "teleport", "layer-filtering", "bounded-trace", "exact-restoration"],
		portableTargets: ["web", "electron-web"],
		nativeProviderBoundary: ["native-openxr", "visionos", "arcore", "arkit"],
	};
}

/** Returns the complete canonical XR authoring configuration and migrates legacy metadata once. */
export function getXRConfiguration(scene: Scene): IEditorXRConfiguration {
	return getSceneXRConfiguration(scene);
}

/** Atomically patches documented XR blocks under one exact scene revision. */
export async function setXRConfiguration(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<IEditorXRConfiguration> {
	assertActionRecord(data, ["expectedRevision", "changes"], "set_xr_configuration input");
	const current = getSceneXRConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	assertConfigurationChanges(data.changes);
	const next = configurationCandidate(current, data.changes);
	return publishConfiguration(scene, current, next, options);
}

/** Creates one stable-id select/grab/teleport affordance under the scene revision lease. */
export async function createXRInteractable(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision", "interactable"], "create_xr_interactable input");
	const current = getSceneXRConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	assertExactRecord(data.interactable, interactableKeys, "XR interactable");
	const authored = data.interactable;
	const interactable: IXRInteractableDefinition = {
		id: (authored.id as string | undefined) ?? Tools.RandomId(),
		name: authored.name as string,
		meshId: authored.meshId as string,
		enabled: (authored.enabled as boolean | undefined) ?? true,
		modes: (authored.modes as IXRInteractableDefinition["modes"] | undefined) ?? ["select"],
		interactionLayers: (authored.interactionLayers as string[] | undefined) ?? ["default"],
		rotateWithController: (authored.rotateWithController as boolean | undefined) ?? true,
		dragSmoothing: (authored.dragSmoothing as number | undefined) ?? 0.2,
		hapticAmplitude: (authored.hapticAmplitude as number | undefined) ?? 0,
		hapticDurationMs: (authored.hapticDurationMs as number | undefined) ?? 0,
	};
	const next = normalizeXRConfiguration({ ...current, revision: current.revision + 1, interactables: [...current.interactables, interactable] }).configuration;
	await publishConfiguration(scene, current, next, options);
	return { configuration: structuredClone(next), interactable: structuredClone(interactable) };
}

/** Updates one authored affordance without allowing its stable id to change. */
export async function setXRInteractable(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision", "id", "changes"], "set_xr_interactable input");
	const current = getSceneXRConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	if (typeof data.id !== "string") {
		throw new Error("set_xr_interactable requires id.");
	}
	assertExactRecord(data.changes, interactableChangeKeys, "XR interactable changes");
	if (!Object.keys(data.changes).length) {
		throw new Error("XR interactable changes must contain at least one field.");
	}
	const index = current.interactables.findIndex((entry) => entry.id === data.id);
	if (index === -1) {
		throw new Error(`XR interactable was not found: ${data.id}.`);
	}
	const interactables = structuredClone(current.interactables);
	interactables[index] = { ...interactables[index], ...structuredClone(data.changes), id: interactables[index].id } as IXRInteractableDefinition;
	const next = normalizeXRConfiguration({ ...current, revision: current.revision + 1, interactables }).configuration;
	await publishConfiguration(scene, current, next, options);
	return { configuration: structuredClone(next), interactable: structuredClone(next.interactables[index]) };
}

/** Deletes one exact-id affordance only with literal confirmation. */
export async function deleteXRInteractable(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision", "id", "confirm"], "delete_xr_interactable input");
	const current = getSceneXRConfiguration(scene);
	assertRevision(current, data.expectedRevision);
	if (typeof data.id !== "string" || !current.interactables.some((entry) => entry.id === data.id)) {
		throw new Error(`XR interactable was not found: ${String(data.id)}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Deleting an XR interactable requires confirm=true.");
	}
	const next = normalizeXRConfiguration({
		...current,
		revision: current.revision + 1,
		interactables: current.interactables.filter((entry) => entry.id !== data.id),
	}).configuration;
	await publishConfiguration(scene, current, next, options);
	return { deleted: true, id: data.id, configuration: structuredClone(next) };
}

/** Runs scene/target validation with optional current-browser capability probing. */
export async function validateXRConfigurationTarget(scene: Scene, data: unknown = {}): Promise<any> {
	assertActionRecord(data, ["target", "checkCurrentDevice", "requireEnabled"], "validate_xr_target input");
	if (data.target !== undefined && !["authoring", "web", "electron-web"].includes(data.target as string)) {
		throw new Error(`Unsupported XR validation target: ${String(data.target)}.`);
	}
	for (const key of ["checkCurrentDevice", "requireEnabled"] as const) {
		if (data[key] !== undefined && typeof data[key] !== "boolean") {
			throw new Error(`XR validation ${key} must be a boolean.`);
		}
	}
	return validateXRTarget(scene, {
		target: data.target as "authoring" | "web" | "electron-web" | undefined,
		checkCurrentDevice: data.checkCurrentDevice as boolean | undefined,
		requireEnabled: data.requireEnabled as boolean | undefined,
	});
}

/** Returns runtime phase, controllers, features, errors, and bounded traces without creating a helper. */
export function getXRRuntimeState(scene: Scene, data: unknown = {}): any {
	assertActionRecord(data, ["traceLimit"], "get_xr_runtime input");
	return { configurationRevision: getSceneXRConfiguration(scene).revision, runtime: getXRRuntimeSnapshot(runtimeScene(scene), traceLimit(data.traceLimit)) };
}

/** Initializes the current authored runtime without entering a headset session. */
export async function initializeXRRuntime(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision"], "initialize_xr_runtime input");
	const configuration = getSceneXRConfiguration(scene);
	assertRevision(configuration, data.expectedRevision);
	if (!configuration.enabled) {
		throw new Error("XR is disabled for this scene.");
	}
	const runtime = getXRRuntime(runtimeScene(scene)) ?? (await configureXR(runtimeScene(scene)));
	const snapshot = runtime ? await runtime.initialize() : null;
	refreshInspector(scene, options);
	return snapshot;
}

/** Rebuilds an active/idle helper from the exact current authoring revision. */
export async function reconfigureXRRuntime(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision"], "reconfigure_xr_runtime input");
	const configuration = getSceneXRConfiguration(scene);
	assertRevision(configuration, data.expectedRevision);
	const runtime = await reconfigureXR(runtimeScene(scene));
	refreshInspector(scene, options);
	return runtime?.snapshot() ?? null;
}

/** Requests session entry; the calling browser still enforces real user activation. */
export async function enterXRRuntimeSession(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision"], "enter_xr_session input");
	assertRevision(getSceneXRConfiguration(scene), data.expectedRevision);
	try {
		const snapshot = await enterXRSession(runtimeScene(scene));
		refreshInspector(scene, options);
		return { ...snapshot, requestSucceeded: true, requestError: null };
	} catch (error) {
		const snapshot = getXRRuntimeSnapshot(runtimeScene(scene));
		refreshInspector(scene, options);
		return {
			...snapshot,
			requestSucceeded: false,
			requestError: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Exits a current headset session while leaving the helper reusable. */
export async function exitXRRuntimeSession(scene: Scene, data: unknown, options: IMCPActionOptions): Promise<any> {
	assertActionRecord(data, ["expectedRevision"], "exit_xr_session input");
	assertRevision(getSceneXRConfiguration(scene), data.expectedRevision);
	try {
		const snapshot = await exitXRSession(runtimeScene(scene));
		refreshInspector(scene, options);
		return { ...snapshot, requestSucceeded: true, requestError: null };
	} catch (error) {
		const snapshot = getXRRuntimeSnapshot(runtimeScene(scene));
		refreshInspector(scene, options);
		return {
			...snapshot,
			requestSucceeded: false,
			requestError: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Reads transient desktop simulator devices, rays, holds, and bounded trace evidence. */
export function getXRSimulationState(scene: Scene, data: unknown = {}): any {
	assertActionRecord(data, ["traceLimit"], "get_xr_simulation input");
	return {
		configurationRevision: getSceneXRConfiguration(scene).revision,
		simulation: getXRSimulationSnapshot(runtimeScene(scene), traceLimit(data.traceLimit)),
	};
}

/** Starts the authored deterministic desktop simulator under an exact revision. */
export function startXRDesktopSimulation(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["expectedRevision"], "start_xr_simulation input");
	assertRevision(getSceneXRConfiguration(scene), data.expectedRevision);
	const snapshot = startXRSimulation(runtimeScene(scene));
	refreshInspector(scene, options);
	return snapshot;
}

/** Applies one strict pose/select/grab/teleport input to the active desktop simulator. */
export function applyXRSimulationInput(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["expectedRevision", "input"], "simulate_xr_input input");
	assertRevision(getSceneXRConfiguration(scene), data.expectedRevision);
	const snapshot = simulateXRInput(runtimeScene(scene), data.input as IXRSimulationInput);
	refreshInspector(scene, options);
	return snapshot;
}

/** Stops simulation and restores all transient transforms. */
export function stopXRDesktopSimulation(scene: Scene, data: unknown, options: IMCPActionOptions): any {
	assertActionRecord(data, ["expectedRevision"], "stop_xr_simulation input");
	assertRevision(getSceneXRConfiguration(scene), data.expectedRevision);
	const snapshot = stopXRSimulation(runtimeScene(scene));
	refreshInspector(scene, options);
	return snapshot;
}

/** Returns defaults without mutating scene metadata, useful for new-scene setup and external discovery. */
export function getDefaultXRConfiguration(): IEditorXRConfiguration {
	return createDefaultXRConfiguration();
}
