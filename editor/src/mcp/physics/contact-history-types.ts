export const physicsContactEventTypes = ["COLLISION_STARTED", "COLLISION_CONTINUED", "COLLISION_FINISHED"] as const;
export const physicsContactHistoryAssetType = "babylon-editor-physics-contact-history" as const;
export const physicsContactHistoryExtension = ".physicscontacts.json" as const;
export const physicsContactHistoryVersion = 1 as const;
export const maximumPhysicsContactHistoryEvents = 1000;
export const maximumPhysicsContactHistoryBytes = 2 * 1024 * 1024;
export const maximumPhysicsContactHistoryDurationMs = 24 * 60 * 60 * 1000;
export const maximumListedPhysicsContactHistories = 512;

export type PhysicsContactEventType = (typeof physicsContactEventTypes)[number];
export type PhysicsContactTarget = "editor" | "play";

/** Detached collision evidence shared by live capture, persisted histories, filters, and replay. */
export interface IPhysicsContactEvent {
	sequence: number;
	elapsedMs: number;
	type: PhysicsContactEventType;
	colliderNodeId: string | null;
	colliderName: string | null;
	colliderIndex: number;
	collidedAgainstNodeId: string | null;
	collidedAgainstName: string | null;
	collidedAgainstIndex: number;
	point: [number, number, number] | null;
	normal: [number, number, number] | null;
	distance: number | null;
	impulse: number | null;
}

/** Records capture policy and provenance without retaining live scene or body references. */
export interface IPhysicsContactHistorySource {
	target: PhysicsContactTarget;
	scenePath: string | null;
	includeContinued: boolean;
	droppedEvents: number;
	capturedBodyCount: number;
	maxEvents: number;
}

/** Immutable project asset; updates create a new integer revision and content hash. */
export interface IPhysicsContactHistoryAsset {
	version: typeof physicsContactHistoryVersion;
	type: typeof physicsContactHistoryAssetType;
	id: string;
	name: string;
	revision: number;
	createdAt: string;
	durationMs: number;
	source: IPhysicsContactHistorySource;
	events: IPhysicsContactEvent[];
}
