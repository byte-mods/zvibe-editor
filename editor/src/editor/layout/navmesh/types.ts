import { INavMeshParametersV2 } from "babylonjs-addons/navigation/types";
import { INavMeshSurfaceAreaEncoding } from "babylonjs-editor-tools";

export interface INavMeshConfiguration {
	navMeshParameters: INavMeshParametersV2;

	staticMeshes: INavMeshStaticMeshConfiguration[];
	obstacleMeshes: INavMeshObstacleConfiguration[];
	areas?: INavMeshAreaConfiguration[];
	offMeshLinks?: INavMeshLinkConfiguration[];
	surfaceAreaEncoding?: INavMeshSurfaceAreaEncoding[];
}

/** A named Detour area and its traversal cost for path queries. Area 0 is always the walkable default. */
export interface INavMeshAreaConfiguration {
	id: number;
	name: string;
	cost: number;
}

export interface INavMeshStaticMeshConfiguration {
	id: string;
	enabled: boolean;
	/** Detour area id painted across this source surface. Defaults to Walkable area 0. */
	area?: number;
}

export interface INavMeshLinkConfiguration {
	id: string;
	start: number[];
	end: number[];
	radius: number;
	bidirectional: boolean;
	area: number;
	flags: number;
	userId?: number;
}

export interface INavMeshObstacleConfiguration {
	id: string;
	enabled: boolean;
	type: "box" | "cylinder";

	position?: number[];
	extent?: number[];
	angle?: number;
	radius?: number;
	height?: number;
	/** Whether this obstacle carves generated NavMesh tiles. Defaults to true. */
	carving?: boolean;
	/** Whether runtime transform changes are monitored. Defaults to true. */
	dynamic?: boolean;
	/** Remove the carving while moving and restore it after becoming stationary. Defaults to true. */
	carveOnlyStationary?: boolean;
	/** World-space movement required before the obstacle is considered changed. */
	moveThreshold?: number;
	/** Seconds without threshold movement before carving is restored. */
	timeToStationary?: number;
	/** Seconds between runtime transform samples. */
	updateInterval?: number;
}
