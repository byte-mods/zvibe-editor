import { Color3, Mesh, Scene, StandardMaterial, VertexData } from "babylonjs";
import { getNavMeshAreaGeometry } from "babylonjs-editor-tools";
import { RecastNavigationJSPluginV2 } from "babylonjs-addons";

import { setNodeSerializable, setNodeVisibleInGraph } from "../../../tools/node/metadata";

import { INavMeshAreaConfiguration } from "./types";

export function getNavMeshAreaColor(area: number): Color3 {
	return Color3.FromHSV((area * 137.508 + 300) % 360, area === 0 ? 0.72 : 0.82, 1);
}

/** Builds one transparent debug mesh per Detour area so authored surfaces remain visually distinguishable. */
export function createNavMeshAreaDebugMeshes(plugin: RecastNavigationJSPluginV2, scene: Scene, areas: readonly INavMeshAreaConfiguration[]): Mesh[] {
	if (!plugin.navMesh) {
		return [];
	}
	const areaNames = new Map(areas.map((area) => [area.id, area.name]));
	return getNavMeshAreaGeometry(plugin.navMesh).map((geometry) => {
		const mesh = new Mesh(`navmesh-area-${geometry.area}-${areaNames.get(geometry.area) ?? "Unknown"}`, scene);
		const vertexData = new VertexData();
		vertexData.positions = geometry.positions;
		vertexData.indices = geometry.indices;
		vertexData.applyToMesh(mesh, false);
		setNodeSerializable(mesh, false);
		setNodeVisibleInGraph(mesh, false);

		const material = new StandardMaterial(`navmesh-area-${geometry.area}-debug-material`, scene);
		material.emissiveColor = getNavMeshAreaColor(geometry.area);
		material.disableLighting = true;
		material.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
		material.alpha = 0.42;
		material.zOffset = -10;
		mesh.material = material;
		return mesh;
	});
}
