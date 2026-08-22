export const Physics2DSettingsContractVersion = 3;
export const MinPhysics2DSolverIterations = 1;
export const MaxPhysics2DSolverIterations = 16;
export const MaxPhysics2DWorlds = 8;
export const DefaultPhysics2DWorldId = "default";

export type Physics2DTransformPlaneMode = "xy" | "xz" | "yz" | "custom";
export type Physics2DTransformReadMode = "authoring" | "runtime";
export type Physics2DTransformWriteMode = "direct" | "interpolate" | "tween";
export type Physics2DContactFilterMode = "layers" | "all" | "none";

export interface IPhysics2DTransformPlaneConfiguration {
	mode: Physics2DTransformPlaneMode;
	origin: [number, number, number];
	xAxis: [number, number, number];
	yAxis: [number, number, number];
}

export interface IPhysics2DWorldConfiguration {
	id: string;
	name: string;
	enabled: boolean;
	worldDrawing: boolean;
	alwaysDraw: boolean;
	velocityIterations: number;
	positionIterations: number;
	transformPlane: IPhysics2DTransformPlaneConfiguration;
	transformWriteMode: Physics2DTransformWriteMode;
	tweenDurationSeconds: number;
	syncInterpolation: boolean;
	contactFilterMode: Physics2DContactFilterMode;
	debugCameraIds: string[];
}

/** Canonical scene-level world settings shared by authoring, preview, and exported games. */
export interface IPhysics2DSettingsConfiguration {
	version: typeof Physics2DSettingsContractVersion;
	revision: number;
	maximumWorlds: number;
	globalTransformReadMode: Physics2DTransformReadMode;
	renderingAvailableInRelease: boolean;
	worlds: IPhysics2DWorldConfiguration[];
	/** Compatibility mirrors for the default world's solver values. */
	velocityIterations: number;
	positionIterations: number;
}

export type IPhysics2DSettingsValidationResult = { ok: true; value: IPhysics2DSettingsConfiguration } | { ok: false; error: string };

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function iterations(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value >= MinPhysics2DSolverIterations && value <= MaxPhysics2DSolverIterations ? value : null;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
	const candidate = value === undefined ? fallback : value;
	return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= minimum && candidate <= maximum ? candidate : null;
}

function finite(value: unknown, fallback: number, minimum: number, maximum: number): number | null {
	const candidate = value === undefined ? fallback : value;
	return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum ? candidate : null;
}

function vector3(value: unknown, fallback: [number, number, number]): [number, number, number] | null {
	const candidate = value === undefined ? fallback : value;
	if (
		!Array.isArray(candidate) ||
		candidate.length !== 3 ||
		candidate.some((component) => typeof component !== "number" || !Number.isFinite(component) || Math.abs(component) > 1_000_000)
	) {
		return null;
	}
	return [candidate[0], candidate[1], candidate[2]];
}

function axis(value: unknown, fallback: [number, number, number]): [number, number, number] | null {
	const candidate = vector3(value, fallback);
	if (!candidate) {
		return null;
	}
	const length = Math.hypot(...candidate);
	if (length < 0.999 || length > 1.001) {
		return null;
	}
	return candidate;
}

function defaultPlane(mode: Physics2DTransformPlaneMode): IPhysics2DTransformPlaneConfiguration {
	if (mode === "xz") {
		return { mode, origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 0, 1] };
	}
	if (mode === "yz") {
		return { mode, origin: [0, 0, 0], xAxis: [0, 1, 0], yAxis: [0, 0, 1] };
	}
	return { mode, origin: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0] };
}

function plane(value: unknown): IPhysics2DTransformPlaneConfiguration | null {
	const source = value === undefined ? {} : record(value);
	const mode = source?.mode ?? "xy";
	if (!source || !["xy", "xz", "yz", "custom"].includes(mode as string)) {
		return null;
	}
	const defaults = defaultPlane(mode as Physics2DTransformPlaneMode);
	const origin = vector3(source.origin, defaults.origin);
	const xAxis = axis(source.xAxis, defaults.xAxis);
	const yAxis = axis(source.yAxis, defaults.yAxis);
	if (!origin || !xAxis || !yAxis || Math.abs(xAxis[0] * yAxis[0] + xAxis[1] * yAxis[1] + xAxis[2] * yAxis[2]) > 0.001) {
		return null;
	}
	return { mode: mode as Physics2DTransformPlaneMode, origin, xAxis, yAxis };
}

function world(value: unknown, fallbackVelocity: number, fallbackPosition: number, index: number): IPhysics2DWorldConfiguration | null {
	const source = record(value);
	const id = source?.id ?? (index === 0 ? DefaultPhysics2DWorldId : undefined);
	const name = source?.name ?? (id === DefaultPhysics2DWorldId ? "Default" : id);
	const velocityIterations = iterations(source?.velocityIterations ?? fallbackVelocity);
	const positionIterations = iterations(source?.positionIterations ?? fallbackPosition);
	const normalizedPlane = plane(source?.transformPlane);
	const transformWriteMode = source?.transformWriteMode ?? "direct";
	const tweenDurationSeconds = finite(source?.tweenDurationSeconds, 0.1, 0, 10);
	const contactFilterMode = source?.contactFilterMode ?? "layers";
	const debugCameraIds = source?.debugCameraIds ?? [];
	if (
		!source ||
		typeof id !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) ||
		typeof name !== "string" ||
		!name.trim() ||
		name.length > 128 ||
		velocityIterations === null ||
		positionIterations === null ||
		!normalizedPlane ||
		!["direct", "interpolate", "tween"].includes(transformWriteMode as string) ||
		tweenDurationSeconds === null ||
		!["layers", "all", "none"].includes(contactFilterMode as string) ||
		!Array.isArray(debugCameraIds) ||
		debugCameraIds.length > 16 ||
		debugCameraIds.some((cameraId) => typeof cameraId !== "string" || !cameraId || cameraId.length > 256) ||
		new Set(debugCameraIds).size !== debugCameraIds.length ||
		["enabled", "worldDrawing", "alwaysDraw", "syncInterpolation"].some((key) => source[key] !== undefined && typeof source[key] !== "boolean")
	) {
		return null;
	}
	return {
		id,
		name: name.trim(),
		enabled: source.enabled !== false,
		worldDrawing: source.worldDrawing === true,
		alwaysDraw: source.alwaysDraw === true,
		velocityIterations,
		positionIterations,
		transformPlane: normalizedPlane,
		transformWriteMode: transformWriteMode as Physics2DTransformWriteMode,
		tweenDurationSeconds,
		syncInterpolation: source.syncInterpolation === true,
		contactFilterMode: contactFilterMode as Physics2DContactFilterMode,
		debugCameraIds: [...debugCameraIds] as string[],
	};
}

/** Produces a detached v3 view without mutating legacy v1/v2 metadata. */
export function normalizePhysics2DSettingsConfiguration(value: unknown): IPhysics2DSettingsValidationResult {
	const source = value === undefined ? {} : record(value);
	if (!source) {
		return { ok: false, error: "Physics 2D settings must be an object." };
	}
	const sourceVersion = source.version === undefined ? 1 : source.version;
	const revision = integer(source.revision, 1, 1, Number.MAX_SAFE_INTEGER);
	const legacyIterations = source.solverIterations === undefined ? MinPhysics2DSolverIterations : iterations(source.solverIterations);
	const velocityIterations = source.velocityIterations === undefined ? legacyIterations : iterations(source.velocityIterations);
	const positionIterations = source.positionIterations === undefined ? legacyIterations : iterations(source.positionIterations);
	if (!Number.isSafeInteger(sourceVersion) || (sourceVersion as number) < 1 || (sourceVersion as number) > Physics2DSettingsContractVersion) {
		return { ok: false, error: `Physics 2D settings version must be an integer from 1 to ${Physics2DSettingsContractVersion}.` };
	}
	if (revision === null) {
		return { ok: false, error: "Physics 2D settings revision must be a positive safe integer." };
	}
	if (legacyIterations === null) {
		return { ok: false, error: `Physics 2D solverIterations must be an integer from ${MinPhysics2DSolverIterations} to ${MaxPhysics2DSolverIterations}.` };
	}
	if (velocityIterations === null) {
		return { ok: false, error: `Physics 2D velocityIterations must be an integer from ${MinPhysics2DSolverIterations} to ${MaxPhysics2DSolverIterations}.` };
	}
	if (positionIterations === null) {
		return { ok: false, error: `Physics 2D positionIterations must be an integer from ${MinPhysics2DSolverIterations} to ${MaxPhysics2DSolverIterations}.` };
	}
	const maximumWorlds = integer(source.maximumWorlds, MaxPhysics2DWorlds, 1, MaxPhysics2DWorlds);
	const globalTransformReadMode = source.globalTransformReadMode ?? "authoring";
	const rawWorlds = source.worlds === undefined ? [{ id: DefaultPhysics2DWorldId, name: "Default" }] : source.worlds;
	if (
		maximumWorlds === null ||
		(globalTransformReadMode !== "authoring" && globalTransformReadMode !== "runtime") ||
		(source.renderingAvailableInRelease !== undefined && typeof source.renderingAvailableInRelease !== "boolean") ||
		!Array.isArray(rawWorlds) ||
		!rawWorlds.length ||
		rawWorlds.length > MaxPhysics2DWorlds ||
		rawWorlds.length > maximumWorlds
	) {
		return { ok: false, error: `Physics 2D settings require 1-${MaxPhysics2DWorlds} worlds within maximumWorlds and a valid global transform-read/release-rendering policy.` };
	}
	const worlds = rawWorlds.map((candidate, index) => world(candidate, velocityIterations, positionIterations, index));
	if (worlds.some((candidate) => candidate === null)) {
		return { ok: false, error: "Each Physics 2D world requires bounded identity, solver, plane, write, filter, drawing, and camera settings." };
	}
	const values = worlds as IPhysics2DWorldConfiguration[];
	if (new Set(values.map((candidate) => candidate.id)).size !== values.length || !values.some((candidate) => candidate.id === DefaultPhysics2DWorldId)) {
		return { ok: false, error: `Physics 2D world ids must be unique and include "${DefaultPhysics2DWorldId}".` };
	}
	const defaultWorld = values.find((candidate) => candidate.id === DefaultPhysics2DWorldId)!;
	return {
		ok: true,
		value: {
			version: Physics2DSettingsContractVersion,
			revision,
			maximumWorlds,
			globalTransformReadMode,
			renderingAvailableInRelease: source.renderingAvailableInRelease === true,
			worlds: values,
			velocityIterations: defaultWorld.velocityIterations,
			positionIterations: defaultWorld.positionIterations,
		},
	};
}
