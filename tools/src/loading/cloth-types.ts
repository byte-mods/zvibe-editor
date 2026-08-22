export const MaxClothTriangleColliders = 8;
export const MaxClothTrianglesPerCollider = 4096;
export const MaxClothTriangleCandidatesPerStep = 262144;

export interface IClothVertexConstraint {
	vertexIndex: number;
	maxDistance?: number;
	surfacePenetration?: number;
}

export interface IClothTriangleCollider {
	meshId: string;
	thickness: number;
	restitution: number;
	friction: number;
}

export interface IClothTriangleCollisionDiagnostics {
	configuredColliders: number;
	activeColliders: number;
	skippedColliders: number;
	triangles: number;
	candidateTests: number;
	contacts: number;
	workTruncated: boolean;
}

export interface IClothRuntimeDiagnostics extends IClothTriangleCollisionDiagnostics {
	clothId: string;
	vertexConstraints: number;
	maximumDistanceConstraints: number;
	surfacePenetrationConstraints: number;
}
