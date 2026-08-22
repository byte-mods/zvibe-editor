import { Scene } from "@babylonjs/core/scene";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";

import { configureLightCookies, getLightCookieMetadata } from "./light-cookies";
import { configureAreaLights, isAreaLight } from "./area-lights";

export function configureLights(scene: Scene, clusteredLightContainer?: ClusteredLightContainer, rootUrl = "") {
	clusteredLightContainer ??= new ClusteredLightContainer("Clustered Light Container", [], scene);
	configureAreaLights(scene);
	configureLightCookies(scene, rootUrl);

	const clusteredLight = scene.metadata?.clusteredLight;
	if (clusteredLight) {
		if (clusteredLight.lights.length > 0) {
			clusteredLightContainer.horizontalTiles = clusteredLight.horizontalTiles;
			clusteredLightContainer.verticalTiles = clusteredLight.verticalTiles;
			clusteredLightContainer.depthSlices = clusteredLight.depthSlices;
			clusteredLightContainer.maxRange = clusteredLight.maxRange;
		}

		clusteredLight.lights.forEach((lightId: any) => {
			const light = scene.getLightById(lightId);
			if (light && !getLightCookieMetadata(light) && !isAreaLight(light)) {
				clusteredLightContainer?.addLight(light);
			}
		});
	}

	return clusteredLightContainer;
}
