import { Tools, Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

export const DEVICE_SIMULATION_VERSION = 2 as const;
export const DEVICE_PROFILE_VERSION = 1 as const;

export type DeviceSimulationPlatform = "android" | "ios" | "tablet" | "desktop-browser";
export type DeviceOrientation = "portrait" | "landscape";

export interface IDeviceSimulatorProfile {
	id: string;
	name: string;
	platform: DeviceSimulationPlatform;
	width: number;
	height: number;
	dpi: number;
	devicePixelRatio: number;
	safeArea: [number, number, number, number];
	operatingSystem: string;
	deviceModel: string;
	cpuCores: number;
	memoryMB: number;
	graphicsApi: string;
	touchPoints: number;
	builtIn: boolean;
}

interface IDeviceSimulationState {
	version: typeof DEVICE_SIMULATION_VERSION;
	revision: number;
	enabled: boolean;
	profileId: string | null;
	width: number;
	height: number;
	dpi: number;
	devicePixelRatio: number;
	orientation: DeviceOrientation;
	safeArea: [number, number, number, number];
	platform: DeviceSimulationPlatform;
	operatingSystem: string;
	deviceModel: string;
	cpuCores: number;
	memoryMB: number;
	graphicsApi: string;
	touchPoints: number;
}

interface IDeviceProfileConfiguration {
	version: typeof DEVICE_PROFILE_VERSION;
	revision: number;
	profiles: IDeviceSimulatorProfile[];
}

const builtInProfiles: IDeviceSimulatorProfile[] = [
	{
		id: "generic-ios-phone",
		name: "Generic iOS Phone",
		platform: "ios",
		width: 1179,
		height: 2556,
		dpi: 460,
		devicePixelRatio: 3,
		safeArea: [141, 0, 102, 0],
		operatingSystem: "iOS 18",
		deviceModel: "Generic iOS Phone",
		cpuCores: 6,
		memoryMB: 6144,
		graphicsApi: "Metal",
		touchPoints: 5,
		builtIn: true,
	},
	{
		id: "generic-android-phone",
		name: "Generic Android Phone",
		platform: "android",
		width: 1080,
		height: 2400,
		dpi: 420,
		devicePixelRatio: 2.75,
		safeArea: [80, 0, 80, 0],
		operatingSystem: "Android 15",
		deviceModel: "Generic Android Phone",
		cpuCores: 8,
		memoryMB: 8192,
		graphicsApi: "Vulkan / OpenGL ES 3",
		touchPoints: 5,
		builtIn: true,
	},
	{
		id: "generic-tablet",
		name: "Generic Tablet",
		platform: "tablet",
		width: 2048,
		height: 2732,
		dpi: 264,
		devicePixelRatio: 2,
		safeArea: [48, 0, 40, 0],
		operatingSystem: "Tablet OS",
		deviceModel: "Generic Tablet",
		cpuCores: 8,
		memoryMB: 8192,
		graphicsApi: "Metal / Vulkan",
		touchPoints: 10,
		builtIn: true,
	},
	{
		id: "desktop-browser-1080p",
		name: "Desktop Browser 1080p",
		platform: "desktop-browser",
		width: 1920,
		height: 1080,
		dpi: 96,
		devicePixelRatio: 1,
		safeArea: [0, 0, 0, 0],
		operatingSystem: "Desktop Browser",
		deviceModel: "Desktop Browser",
		cpuCores: 8,
		memoryMB: 16384,
		graphicsApi: "WebGL2 / WebGPU",
		touchPoints: 0,
		builtIn: true,
	},
];

const profileKeys = new Set([
	"endpoint",
	"collaborationToken",
	"id",
	"name",
	"platform",
	"width",
	"height",
	"dpi",
	"devicePixelRatio",
	"safeArea",
	"operatingSystem",
	"deviceModel",
	"cpuCores",
	"memoryMB",
	"graphicsApi",
	"touchPoints",
	"expectedRevision",
]);
const simulationKeys = new Set([
	"endpoint",
	"collaborationToken",
	"enabled",
	"profileId",
	"width",
	"height",
	"dpi",
	"devicePixelRatio",
	"orientation",
	"safeArea",
	"platform",
	"operatingSystem",
	"deviceModel",
	"cpuCores",
	"memoryMB",
	"graphicsApi",
	"touchPoints",
	"expectedRevision",
]);

function cloneBuiltIns(): IDeviceSimulatorProfile[] {
	return builtInProfiles.map((profile) => structuredClone(profile));
}

function profileConfiguration(scene: Scene): IDeviceProfileConfiguration {
	scene.metadata ??= {};
	const raw = scene.metadata.babylonEditorDeviceSimulationProfiles;
	if (raw?.version === DEVICE_PROFILE_VERSION && Number.isSafeInteger(raw.revision) && Array.isArray(raw.profiles)) {
		return raw;
	}
	return (scene.metadata.babylonEditorDeviceSimulationProfiles = { version: DEVICE_PROFILE_VERSION, revision: 0, profiles: [] });
}

function simulationState(scene: Scene): IDeviceSimulationState {
	scene.metadata ??= {};
	const raw = scene.metadata.babylonEditorDeviceSimulation;
	if (raw?.version === DEVICE_SIMULATION_VERSION && Number.isSafeInteger(raw.revision)) {
		return raw;
	}
	const fallback = builtInProfiles[0];
	return (scene.metadata.babylonEditorDeviceSimulation = {
		version: DEVICE_SIMULATION_VERSION,
		revision: 0,
		enabled: raw?.enabled === true,
		profileId: raw?.profileId ?? null,
		width: Number.isSafeInteger(raw?.width) ? raw.width : fallback.width,
		height: Number.isSafeInteger(raw?.height) ? raw.height : fallback.height,
		dpi: Number.isFinite(raw?.dpi) ? raw.dpi : fallback.dpi,
		devicePixelRatio: Number.isFinite(raw?.devicePixelRatio) ? raw.devicePixelRatio : fallback.devicePixelRatio,
		orientation: (raw?.orientation === "landscape" ? "landscape" : "portrait") as DeviceOrientation,
		safeArea: (Array.isArray(raw?.safeArea) && raw.safeArea.length === 4 ? [...raw.safeArea] : [...fallback.safeArea]) as [number, number, number, number],
		platform: ["android", "ios", "tablet", "desktop-browser"].includes(raw?.platform) ? raw.platform : fallback.platform,
		operatingSystem: typeof raw?.operatingSystem === "string" ? raw.operatingSystem : fallback.operatingSystem,
		deviceModel: typeof raw?.deviceModel === "string" ? raw.deviceModel : fallback.deviceModel,
		cpuCores: Number.isSafeInteger(raw?.cpuCores) ? raw.cpuCores : fallback.cpuCores,
		memoryMB: Number.isSafeInteger(raw?.memoryMB) ? raw.memoryMB : fallback.memoryMB,
		graphicsApi: typeof raw?.graphicsApi === "string" ? raw.graphicsApi : fallback.graphicsApi,
		touchPoints: Number.isSafeInteger(raw?.touchPoints) ? raw.touchPoints : fallback.touchPoints,
	});
}

function allProfiles(scene: Scene): IDeviceSimulatorProfile[] {
	return [...cloneBuiltIns(), ...profileConfiguration(scene).profiles.map((profile) => structuredClone(profile))];
}

function findProfile(scene: Scene, id: string): IDeviceSimulatorProfile {
	const profile = allProfiles(scene).find((candidate) => candidate.id === id);
	if (!profile) {
		throw new Error(`Device Simulator profile not found: ${id}`);
	}
	return profile;
}

function validateSafeArea(safeArea: unknown, width: number, height: number): asserts safeArea is [number, number, number, number] {
	if (!Array.isArray(safeArea) || safeArea.length !== 4 || safeArea.some((value) => !Number.isFinite(value) || value < 0)) {
		throw new Error("safeArea must be [top, right, bottom, left] non-negative pixels in natural portrait orientation.");
	}
	const [top, right, bottom, left] = safeArea;
	if (top + bottom >= height || left + right >= width) {
		throw new Error("safeArea must leave a positive visible area.");
	}
}

function validateProfile(value: Omit<IDeviceSimulatorProfile, "builtIn">): void {
	if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) {
		throw new Error("Device profile id must use 1-64 lowercase letters, numbers, or hyphens.");
	}
	for (const [name, text, maximum] of [
		["name", value.name, 80],
		["operatingSystem", value.operatingSystem, 120],
		["deviceModel", value.deviceModel, 120],
		["graphicsApi", value.graphicsApi, 120],
	] as const) {
		if (typeof text !== "string" || !text.trim() || text.length > maximum) {
			throw new Error(`Device profile ${name} must be a non-empty string no longer than ${maximum} characters.`);
		}
	}
	if (!["android", "ios", "tablet", "desktop-browser"].includes(value.platform)) {
		throw new Error("Device profile platform is invalid.");
	}
	if (!Number.isSafeInteger(value.width) || value.width < 160 || value.width > 16384 || !Number.isSafeInteger(value.height) || value.height < 160 || value.height > 16384) {
		throw new Error("Device profile width and height must be integers from 160 to 16384 pixels.");
	}
	if (
		!Number.isFinite(value.dpi) ||
		value.dpi <= 0 ||
		value.dpi > 2000 ||
		!Number.isFinite(value.devicePixelRatio) ||
		value.devicePixelRatio <= 0 ||
		value.devicePixelRatio > 16
	) {
		throw new Error("Device profile DPI or devicePixelRatio is outside its supported range.");
	}
	for (const [name, numeric, minimum, maximum] of [
		["cpuCores", value.cpuCores, 1, 256],
		["memoryMB", value.memoryMB, 128, 1_048_576],
		["touchPoints", value.touchPoints, 0, 32],
	] as const) {
		if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
			throw new Error(`Device profile ${name} must be an integer from ${minimum} to ${maximum}.`);
		}
	}
	validateSafeArea(value.safeArea, value.width, value.height);
}

function resolvedState(state: IDeviceSimulationState): any {
	const landscape = state.orientation === "landscape";
	const [top, right, bottom, left] = state.safeArea;
	const resolvedSafeArea: [number, number, number, number] = landscape ? [left, top, right, bottom] : [top, right, bottom, left];
	const width = landscape ? state.height : state.width;
	const height = landscape ? state.width : state.height;
	return {
		...structuredClone(state),
		resolved: {
			width,
			height,
			safeArea: resolvedSafeArea,
			application: { platform: state.platform, operatingSystem: state.operatingSystem, isMobile: state.platform !== "desktop-browser" },
			screen: { width, height, dpi: state.dpi, devicePixelRatio: state.devicePixelRatio, orientation: state.orientation, safeArea: resolvedSafeArea },
			systemInfo: {
				deviceModel: state.deviceModel,
				processorCount: state.cpuCores,
				systemMemoryMB: state.memoryMB,
				graphicsDeviceType: state.graphicsApi,
				maxTouchPoints: state.touchPoints,
				performanceSimulated: false,
			},
		},
		limitations: ["Hardware performance, rendering capability, native plugins, platform defines, and gyroscope behavior are not simulated."],
	};
}

function applySimulation(scene: Scene, options: IMCPActionOptions): any {
	const result = resolvedState(simulationState(scene));
	(globalThis as any).__ZVIBE_DEVICE_SIMULATION__ = result.enabled ? structuredClone(result.resolved) : null;
	options.editor?.layout?.preview?.setDeviceSimulation(
		result.enabled ? { width: result.resolved.width, height: result.resolved.height, dpi: result.dpi, safeArea: result.resolved.safeArea } : null
	);
	options.editor?.layout?.inspector?.forceUpdate();
	return result;
}

/** Lists immutable built-in definitions and exact-revision project custom definitions. */
export function listDeviceSimulatorProfiles(scene: Scene): any {
	const configuration = profileConfiguration(scene);
	return { version: DEVICE_PROFILE_VERSION, revision: configuration.revision, activeProfileId: simulationState(scene).profileId, profiles: allProfiles(scene) };
}

/** Creates or exactly replaces one project custom device definition. */
export function setDeviceSimulatorProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	const configuration = profileConfiguration(scene);
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== configuration.revision) {
		throw new Error(`Stale Device Simulator profile revision ${data.expectedRevision}; current revision is ${configuration.revision}.`);
	}
	const unknown = Object.keys(data).filter((key) => !profileKeys.has(key));
	if (unknown.length) {
		throw new Error(`Unknown Device Simulator profile field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
	if (builtInProfiles.some((profile) => profile.id === data.id)) {
		throw new Error("Built-in Device Simulator profiles are immutable; create a custom id instead.");
	}
	const profile: IDeviceSimulatorProfile = {
		id: data.id,
		name: data.name,
		platform: data.platform,
		width: data.width,
		height: data.height,
		dpi: data.dpi,
		devicePixelRatio: data.devicePixelRatio,
		safeArea: data.safeArea,
		operatingSystem: data.operatingSystem,
		deviceModel: data.deviceModel,
		cpuCores: data.cpuCores,
		memoryMB: data.memoryMB,
		graphicsApi: data.graphicsApi,
		touchPoints: data.touchPoints,
		builtIn: false,
	};
	validateProfile(profile);
	const duplicateName = configuration.profiles.find((candidate) => candidate.name === profile.name && candidate.id !== profile.id);
	if (duplicateName) {
		throw new Error(`A custom Device Simulator profile named "${profile.name}" already exists.`);
	}
	const index = configuration.profiles.findIndex((candidate) => candidate.id === profile.id);
	if (index === -1) {
		configuration.profiles.push(profile);
	} else {
		configuration.profiles[index] = profile;
	}
	configuration.profiles.sort((left, right) => left.id.localeCompare(right.id));
	configuration.revision++;
	options.editor?.layout?.inspector?.forceUpdate();
	return { configuration: listDeviceSimulatorProfiles(scene), profile: structuredClone(profile) };
}

/** Deletes one custom definition under the exact catalog revision. */
export function deleteDeviceSimulatorProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a custom Device Simulator profile requires confirm=true.");
	}
	const configuration = profileConfiguration(scene);
	if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== configuration.revision) {
		throw new Error(`Stale Device Simulator profile revision ${data.expectedRevision}; current revision is ${configuration.revision}.`);
	}
	const index = configuration.profiles.findIndex((profile) => profile.id === data.id);
	if (index === -1) {
		throw new Error(`Custom Device Simulator profile not found: ${data.id}`);
	}
	configuration.profiles.splice(index, 1);
	configuration.revision++;
	const state = simulationState(scene);
	if (state.profileId === data.id) {
		state.profileId = null;
		state.revision++;
		applySimulation(scene, options);
	}
	options.editor?.layout?.inspector?.forceUpdate();
	return { deleted: true, id: data.id, configuration: listDeviceSimulatorProfiles(scene) };
}

/** Gets the migrated version-2 preview simulation and normalized simulated environment. */
export function getDeviceSimulation(scene: Scene): any {
	return resolvedState(simulationState(scene));
}

/** Sets exact simulation fields, optionally applying one built-in or custom definition. */
export function setDeviceSimulation(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = simulationState(scene);
	if (data.expectedRevision !== undefined && (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision !== state.revision)) {
		throw new Error(`Stale Device Simulator revision ${data.expectedRevision}; current revision is ${state.revision}.`);
	}
	const unknown = Object.keys(data).filter((key) => !simulationKeys.has(key));
	if (unknown.length) {
		throw new Error(`Unknown Device Simulator field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
	}
	const profile = data.profileId === undefined ? null : data.profileId === null ? null : findProfile(scene, data.profileId);
	const next: IDeviceSimulationState = {
		...state,
		...(profile
			? {
					profileId: profile.id,
					width: profile.width,
					height: profile.height,
					dpi: profile.dpi,
					devicePixelRatio: profile.devicePixelRatio,
					safeArea: [...profile.safeArea] as [number, number, number, number],
					platform: profile.platform,
					operatingSystem: profile.operatingSystem,
					deviceModel: profile.deviceModel,
					cpuCores: profile.cpuCores,
					memoryMB: profile.memoryMB,
					graphicsApi: profile.graphicsApi,
					touchPoints: profile.touchPoints,
				}
			: {}),
		...Object.fromEntries(
			Object.entries(data).filter(([key, value]) => !["endpoint", "collaborationToken", "expectedRevision", "profileId"].includes(key) && value !== undefined)
		),
		...(data.profileId !== undefined ? { profileId: data.profileId } : {}),
		revision: state.revision + 1,
	};
	validateProfile({
		id: "validation-profile",
		name: "Validation",
		platform: next.platform,
		width: next.width,
		height: next.height,
		dpi: next.dpi,
		devicePixelRatio: next.devicePixelRatio,
		safeArea: next.safeArea,
		operatingSystem: next.operatingSystem,
		deviceModel: next.deviceModel,
		cpuCores: next.cpuCores,
		memoryMB: next.memoryMB,
		graphicsApi: next.graphicsApi,
		touchPoints: next.touchPoints,
	});
	if (typeof next.enabled !== "boolean" || !["portrait", "landscape"].includes(next.orientation)) {
		throw new Error("Device simulation enabled/orientation values are invalid.");
	}
	scene.metadata.babylonEditorDeviceSimulation = next;
	return applySimulation(scene, options);
}

/** Activates one exact profile while preserving the authored orientation/enabled choice when supplied. */
export function activateDeviceSimulatorProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	return setDeviceSimulation(scene, { expectedRevision: data.expectedRevision, profileId: data.id, enabled: data.enabled ?? true, orientation: data.orientation }, options);
}

/** Creates a complete custom profile payload for callers that only need a stable id. */
export function createDefaultCustomDeviceProfile(id = `device-${Tools.RandomId().toLowerCase()}`): IDeviceSimulatorProfile {
	return { ...structuredClone(builtInProfiles[1]), id, name: "Custom Device", builtIn: false };
}
