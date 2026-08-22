import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Material } from "@babylonjs/core/Materials/material";
import { Scene } from "@babylonjs/core/scene";
import { AdvancedDynamicTexture } from "@babylonjs/gui/2D/advancedDynamicTexture";

import { IGUIPanelRendererSettings, normalizeGUIToolkitState } from "./gui-toolkit";

interface IGUIPanelMaterialOwnership {
	mesh: AbstractMesh;
	originalMaterial: Material | null;
	generatedMaterial: Material | null;
}

interface IGUIPanelTextureLike {
	name: string;
	_isFullscreen: boolean;
	rootContainer: { children: unknown[]; clearControls(): void };
	getSize(): { width: number; height: number };
	dispose(): void;
}

const materialOwnership = new WeakMap<object, IGUIPanelMaterialOwnership>();

function findPanelMesh(scene: Scene, targetMeshId: string): AbstractMesh {
	const mesh = scene.getMeshById(targetMeshId) ?? scene.getMeshByName(targetMeshId);
	if (!mesh) {
		throw new Error(`GUI PanelRenderer target mesh "${targetMeshId}" was not found.`);
	}
	return mesh;
}

/** Creates the real Babylon overlay or mesh-backed texture described by one normalized PanelRenderer setting. */
export function createGUIPanelRendererTexture<T = AdvancedDynamicTexture>(sceneValue: unknown, name: string, settingsValue: IGUIPanelRendererSettings): T {
	const scene = sceneValue as Scene;
	const settings = normalizeGUIToolkitState({
		model: "unity-ui-toolkit-65-portable-v1",
		panelRenderer: settingsValue,
		references: [],
		attributeOverrides: [],
		animations: [],
		stylesheetStage: { contextId: "root", activeStylesheetPath: null, stylesheetOrder: [] },
	}).panelRenderer;
	if (settings.renderMode === "overlay") {
		return AdvancedDynamicTexture.CreateFullscreenUI(name, settings.foreground, scene) as T;
	}
	const mesh = findPanelMesh(scene, settings.targetMeshId!);
	const originalMaterial = mesh.material;
	const texture = AdvancedDynamicTexture.CreateForMesh(
		mesh,
		settings.textureWidth,
		settings.textureHeight,
		settings.supportPointerMove,
		settings.onlyAlphaTesting,
		settings.invertY
	);
	texture.name = name;
	materialOwnership.set(texture, { mesh, originalMaterial, generatedMaterial: mesh.material });
	return texture as T;
}

/** Returns honest native attachment evidence without mutating the renderer. */
export function getGUIPanelRendererEvidence(gui: IGUIPanelTextureLike, settings: IGUIPanelRendererSettings): Record<string, unknown> {
	const ownership = materialOwnership.get(gui as object);
	const size = gui.getSize();
	return {
		renderMode: settings.renderMode,
		targetMeshId: settings.targetMeshId,
		textureSize: { width: size.width, height: size.height },
		nativeFullscreen: gui._isFullscreen,
		nativeMeshAttached: !gui._isFullscreen && Boolean(ownership?.mesh),
		materialOwned: Boolean(ownership?.generatedMaterial),
		resourcesReleased: gui.rootContainer.children.length === 0,
	};
}

/** Releases a PanelRenderer root and restores a mesh's previous material before disposing generated material/texture ownership. */
export function releaseGUIPanelRendererTexture(gui: IGUIPanelTextureLike, releaseRoot: boolean): { restoredMaterial: boolean; releasedControlCount: number } {
	const releasedControlCount = gui.rootContainer.children.length;
	if (releaseRoot) {
		gui.rootContainer.clearControls();
	}
	const ownership = materialOwnership.get(gui as object);
	if (ownership && ownership.mesh.material === ownership.generatedMaterial) {
		ownership.mesh.material = ownership.originalMaterial;
	}
	ownership?.generatedMaterial?.dispose(false, true);
	materialOwnership.delete(gui as object);
	gui.dispose();
	return { restoredMaterial: Boolean(ownership), releasedControlCount };
}
