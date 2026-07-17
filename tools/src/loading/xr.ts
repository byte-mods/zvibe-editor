import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Scene } from "@babylonjs/core/scene";
import { WebXRDefaultExperience } from "@babylonjs/core/XR/webXRDefaultExperience";

export async function configureXR(scene: Scene): Promise<void> {
	const config = scene.metadata?.babylonEditorXR;
	if (!config?.enabled) return;
	try {
		const floorMeshes = (config.floorMeshIds ?? []).map((id: string) => scene.getMeshById(id)).filter((mesh: AbstractMesh | null): mesh is AbstractMesh => !!mesh);
		(scene as any).xrExperience = await WebXRDefaultExperience.CreateAsync(scene, {
			floorMeshes,
			disableTeleportation: !config.features?.includes("teleportation"),
			optionalFeatures: config.features,
			uiOptions: { sessionMode: "immersive-vr", referenceSpaceType: config.referenceSpaceType },
		});
	} catch (error) {
		console.warn("Unable to initialize exported XR experience:", error);
	}
}
