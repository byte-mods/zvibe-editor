import { INavMeshParametersV2 } from "babylonjs-addons/navigation/types";

export interface INavMeshConfiguration {
	navMeshParameters: INavMeshParametersV2;

	staticMeshes: INavMeshStaticMeshConfiguration[];
	obstacleMeshes: INavMeshObstacleConfiguration[];
	areas?: INavMeshAreaConfiguration[];
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
}
