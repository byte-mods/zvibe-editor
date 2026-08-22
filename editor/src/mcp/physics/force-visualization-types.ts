/** Closed debug-vector categories shared by editor controls, MCP schemas, and tests. */
export const physicsForceVectorCategories = [
	"gravity-force",
	"net-force",
	"linear-velocity",
	"angular-velocity",
	"contact-normal",
	"contact-impulse",
	"constraint-axis",
	"constraint-separation",
] as const;

export type PhysicsForceVectorCategory = (typeof physicsForceVectorCategories)[number];
export type PhysicsForceVectorProvenance = "live" | "derived" | "captured" | "authored";

/** One detached world-space vector; raw values remain unscaled for exact inspection. */
export interface IPhysicsForceDebugVector {
	id: string;
	category: PhysicsForceVectorCategory;
	label: string;
	nodeId: string | null;
	nodeName: string | null;
	relatedNodeId: string | null;
	origin: [number, number, number];
	vector: [number, number, number];
	magnitude: number;
	unit: string;
	provenance: PhysicsForceVectorProvenance;
}

/** Persisted only in scene-local diagnostic state; never serialized into the project. */
export interface IPhysicsForceVisualizationSettings {
	categories: PhysicsForceVectorCategory[];
	bodyNodeIds: string[];
	maximumVectors: number;
	refreshIntervalMs: number;
	forceScale: number;
	impulseScale: number;
	velocityScale: number;
	angularVelocityScale: number;
	directionScale: number;
	separationScale: number;
	pointSize: number;
}

export const defaultPhysicsForceVisualizationSettings: Readonly<IPhysicsForceVisualizationSettings> = {
	categories: [...physicsForceVectorCategories],
	bodyNodeIds: [],
	maximumVectors: 256,
	refreshIntervalMs: 100,
	forceScale: 0.05,
	impulseScale: 10,
	velocityScale: 0.2,
	angularVelocityScale: 50,
	directionScale: 100,
	separationScale: 1,
	pointSize: 12,
};

/** Avoids accepting arbitrary strings in the editor bridge even when MCP validation is bypassed. */
export function isPhysicsForceVectorCategory(value: unknown): value is PhysicsForceVectorCategory {
	return typeof value === "string" && physicsForceVectorCategories.includes(value as PhysicsForceVectorCategory);
}
