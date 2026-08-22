import {
	IPhysicsContactEvent,
	IPhysicsContactHistoryAsset,
	IPhysicsContactHistorySource,
	maximumPhysicsContactHistoryBytes,
	maximumPhysicsContactHistoryDurationMs,
	maximumPhysicsContactHistoryEvents,
	physicsContactEventTypes,
	physicsContactHistoryAssetType,
	physicsContactHistoryVersion,
	PhysicsContactEventType,
} from "./contact-history-types";

const assetKeys = ["version", "type", "id", "name", "revision", "createdAt", "durationMs", "source", "events"];
const sourceKeys = ["target", "scenePath", "includeContinued", "droppedEvents", "capturedBodyCount", "maxEvents"];
const eventKeys = [
	"sequence",
	"elapsedMs",
	"type",
	"colliderNodeId",
	"colliderName",
	"colliderIndex",
	"collidedAgainstNodeId",
	"collidedAgainstName",
	"collidedAgainstIndex",
	"point",
	"normal",
	"distance",
	"impulse",
];

/** Rejects arrays/null before any nested field access and gives every error an asset-local path. */
function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must be an object.`);
	}
	return value as Record<string, unknown>;
}

/** Enforces forward-compatible failure rather than silently discarding authored fields. */
function closed(source: Record<string, unknown>, keys: string[], path: string): void {
	const unknown = Object.keys(source).filter((key) => !keys.includes(key));
	if (unknown.length) {
		throw new Error(`${path} contains unknown fields: ${unknown.join(", ")}.`);
	}
}

function stringValue(value: unknown, path: string, maximum: number, nullable = false, allowEmpty = false): string | null {
	if (nullable && value === null) {
		return null;
	}
	if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum) {
		throw new Error(`${path} must be ${nullable ? "null or " : ""}a string containing ${allowEmpty ? `0–${maximum}` : `1–${maximum}`} characters.`);
	}
	return allowEmpty ? value : value.trim();
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${path} must be a safe integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function finite(value: unknown, path: string, nullable = false): number | null {
	if (nullable && value === null) {
		return null;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path} must be ${nullable ? "null or " : ""}a finite number.`);
	}
	return value;
}

/** Copies an exact finite XYZ tuple so validated assets never retain mutable input arrays. */
function vector(value: unknown, path: string): [number, number, number] | null {
	if (value === null) {
		return null;
	}
	if (!Array.isArray(value) || value.length !== 3 || !value.every((component) => typeof component === "number" && Number.isFinite(component))) {
		throw new Error(`${path} must be null or an exact three-component finite vector.`);
	}
	return [value[0], value[1], value[2]];
}

/** Validates one event independently before cross-event ordering checks run. */
function validateEvent(value: unknown, index: number): IPhysicsContactEvent {
	const path = `Physics contact history events[${index}]`;
	const source = record(value, path);
	closed(source, eventKeys, path);
	if (!physicsContactEventTypes.includes(source.type as PhysicsContactEventType)) {
		throw new Error(`${path}.type must be COLLISION_STARTED, COLLISION_CONTINUED, or COLLISION_FINISHED.`);
	}
	return {
		sequence: integer(source.sequence, `${path}.sequence`, 0, Number.MAX_SAFE_INTEGER),
		elapsedMs: finite(source.elapsedMs, `${path}.elapsedMs`)!,
		type: source.type as PhysicsContactEventType,
		colliderNodeId: stringValue(source.colliderNodeId, `${path}.colliderNodeId`, 256, true),
		colliderName: stringValue(source.colliderName, `${path}.colliderName`, 256, true, true),
		colliderIndex: integer(source.colliderIndex, `${path}.colliderIndex`, 0, 1_000_000),
		collidedAgainstNodeId: stringValue(source.collidedAgainstNodeId, `${path}.collidedAgainstNodeId`, 256, true),
		collidedAgainstName: stringValue(source.collidedAgainstName, `${path}.collidedAgainstName`, 256, true, true),
		collidedAgainstIndex: integer(source.collidedAgainstIndex, `${path}.collidedAgainstIndex`, 0, 1_000_000),
		point: vector(source.point, `${path}.point`),
		normal: vector(source.normal, `${path}.normal`),
		distance: finite(source.distance, `${path}.distance`, true),
		impulse: finite(source.impulse, `${path}.impulse`, true),
	};
}

/** Validates detached capture provenance and its resource bounds. */
function validateSource(value: unknown): IPhysicsContactHistorySource {
	const source = record(value, "Physics contact history source");
	closed(source, sourceKeys, "Physics contact history source");
	if (source.target !== "editor" && source.target !== "play") {
		throw new Error("Physics contact history source.target must be editor or play.");
	}
	if (typeof source.includeContinued !== "boolean") {
		throw new Error("Physics contact history source.includeContinued must be a boolean.");
	}
	return {
		target: source.target,
		scenePath: stringValue(source.scenePath, "Physics contact history source.scenePath", 512, true),
		includeContinued: source.includeContinued,
		droppedEvents: integer(source.droppedEvents, "Physics contact history source.droppedEvents", 0, Number.MAX_SAFE_INTEGER),
		capturedBodyCount: integer(source.capturedBodyCount, "Physics contact history source.capturedBodyCount", 0, 10_000),
		maxEvents: integer(source.maxEvents, "Physics contact history source.maxEvents", 1, maximumPhysicsContactHistoryEvents),
	};
}

/** Produces a normalized detached version-1 asset or fails closed before persistence/replay can observe it. */
export function validatePhysicsContactHistoryAsset(value: unknown, path = "Physics contact history asset"): IPhysicsContactHistoryAsset {
	const source = record(value, path);
	closed(source, assetKeys, path);
	if (source.version !== physicsContactHistoryVersion || source.type !== physicsContactHistoryAssetType) {
		throw new Error(`${path} is invalid or uses an unsupported version.`);
	}
	const createdAt = stringValue(source.createdAt, `${path}.createdAt`, 64)!;
	if (Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
		throw new Error(`${path}.createdAt must be an exact ISO-8601 UTC timestamp.`);
	}
	const durationMs = finite(source.durationMs, `${path}.durationMs`)!;
	if (durationMs < 0 || durationMs > maximumPhysicsContactHistoryDurationMs) {
		throw new Error(`${path}.durationMs must be from 0 through ${maximumPhysicsContactHistoryDurationMs}.`);
	}
	if (!Array.isArray(source.events) || source.events.length > maximumPhysicsContactHistoryEvents) {
		throw new Error(`${path}.events must be an array containing at most ${maximumPhysicsContactHistoryEvents} events.`);
	}
	const captureSource = validateSource(source.source);
	const events = source.events.map(validateEvent);
	for (let index = 0; index < events.length; index++) {
		const previous = events[index - 1];
		if (events[index].elapsedMs < 0 || events[index].elapsedMs > durationMs) {
			throw new Error(`${path}.events[${index}].elapsedMs must be inside the history duration.`);
		}
		if (previous && (events[index].sequence <= previous.sequence || events[index].elapsedMs < previous.elapsedMs)) {
			throw new Error(`${path}.events must have strictly increasing sequences and non-decreasing elapsed times.`);
		}
		if (!captureSource.includeContinued && events[index].type === "COLLISION_CONTINUED") {
			throw new Error(`${path}.events[${index}] contradicts source.includeContinued=false.`);
		}
	}
	if (events.length > captureSource.maxEvents) {
		throw new Error(`${path}.events exceeds source.maxEvents.`);
	}
	const asset: IPhysicsContactHistoryAsset = {
		version: physicsContactHistoryVersion,
		type: physicsContactHistoryAssetType,
		id: stringValue(source.id, `${path}.id`, 128)!,
		name: stringValue(source.name, `${path}.name`, 128)!,
		revision: integer(source.revision, `${path}.revision`, 1, Number.MAX_SAFE_INTEGER),
		createdAt,
		durationMs,
		source: captureSource,
		events,
	};
	if (new TextEncoder().encode(JSON.stringify(asset)).byteLength > maximumPhysicsContactHistoryBytes) {
		throw new Error(`${path} exceeds ${maximumPhysicsContactHistoryBytes} bytes.`);
	}
	return asset;
}
