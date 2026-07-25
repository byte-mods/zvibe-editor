import { join } from "path/posix";

import { _GetAudioEngine, BaseTexture, Camera, Color3, Color4, Texture, Vector3 } from "babylonjs";

import type { Editor } from "../../editor/main";
import { EditorCamera } from "../../editor/nodes/camera";
import { customColorPostProcessCameraConfigurations, disposeCustomColorPostProcess, parseCustomColorPostProcess } from "../../editor/rendering/custom-color";
import { defaultPipelineCameraConfigurations, disposeDefaultRenderingPipeline, parseDefaultRenderingPipeline } from "../../editor/rendering/default-pipeline";
import { disposeIblShadowsRenderingPipeline, iblShadowsRenderingPipelineCameraConfigurations, parseIblShadowsRenderingPipeline } from "../../editor/rendering/ibl-shadows";
import { disposeMotionBlurPostProcess, motionBlurPostProcessCameraConfigurations, parseMotionBlurPostProcess } from "../../editor/rendering/motion-blur";
import { disposeSSAO2RenderingPipeline, parseSSAO2RenderingPipeline, ssaoRenderingPipelineCameraConfigurations } from "../../editor/rendering/ssao";
import { disposeSSRRenderingPipeline, parseSSRRenderingPipeline, ssrRenderingPipelineCameraConfigurations } from "../../editor/rendering/ssr";
import { disposeTAARenderingPipeline, parseTAARenderingPipeline, taaPipelineCameraConfigurations } from "../../editor/rendering/taa";
import { disposeVLSPostProcess, parseVLSPostProcess, vlsPostProcessCameraConfigurations } from "../../editor/rendering/vls";

import { IAssetCache } from "../../tools/assets/cache";
import { isCubeTexture, isEXRCubeTexture, isHDRCubeTexture } from "../../tools/guards/texture";

import { SceneLoadResult } from "./result";

const cameraConfigurationMaps = [
	ssaoRenderingPipelineCameraConfigurations,
	vlsPostProcessCameraConfigurations,
	ssrRenderingPipelineCameraConfigurations,
	motionBlurPostProcessCameraConfigurations,
	defaultPipelineCameraConfigurations,
	taaPipelineCameraConfigurations,
	customColorPostProcessCameraConfigurations,
	iblShadowsRenderingPipelineCameraConfigurations,
];

/** Applies the global non-node settings owned by the lighting scene. */
export function applySceneEnvironmentConfiguration(
	editor: Editor,
	projectPath: string,
	configuration: any,
	result: SceneLoadResult,
	assetsCache: Record<string, IAssetCache>
): object[] {
	const scene = editor.layout.preview.scene;
	const addedResources: object[] = [];

	scene.metadata = configuration.metadata;
	disposeEditorCameraRendering(editor);

	const previousCamera = editor.layout.preview.camera;
	const parsedCamera = configuration.editorCamera ? (Camera.Parse(configuration.editorCamera, scene) as EditorCamera | null) : null;
	if (parsedCamera) {
		previousCamera.dispose();
		editor.layout.preview.camera = parsedCamera;
		scene.activeCamera = parsedCamera;
		_GetAudioEngine(null).listener.attach(parsedCamera);
		parsedCamera.attachControl(true);
		parsedCamera.configureFromPreferences();
	}

	const environment = configuration.environment ?? {};
	scene.iblIntensity = environment.iblIntensity ?? 1;
	scene.environmentIntensity = environment.environmentIntensity ?? 1;
	if (environment.environmentTexture) {
		if (result.environmentTexture === undefined) {
			const serializedTexture = structuredClone(environment.environmentTexture);
			if (serializedTexture.name && assetsCache[serializedTexture.name]) {
				serializedTexture.name = assetsCache[serializedTexture.name].newRelativePath;
			}
			if (serializedTexture.url && assetsCache[serializedTexture.url]) {
				serializedTexture.url = assetsCache[serializedTexture.url].newRelativePath;
			}

			result.environmentTexture = Texture.Parse(serializedTexture, scene, join(projectPath, "/"));
			if (result.environmentTexture && !result.textures.includes(result.environmentTexture)) {
				result.textures.push(result.environmentTexture);
				addedResources.push(result.environmentTexture);
			}
			if (isCubeTexture(result.environmentTexture) || isHDRCubeTexture(result.environmentTexture) || isEXRCubeTexture(result.environmentTexture)) {
				result.environmentTexture.url = join(projectPath, result.environmentTexture.name);
			}
		}
		scene.environmentTexture = result.environmentTexture as BaseTexture | null;
	} else {
		result.environmentTexture = null;
		scene.environmentTexture = null;
	}

	const fog = configuration.fog ?? {};
	scene.fogEnabled = fog.fogEnabled ?? false;
	scene.fogMode = fog.fogMode ?? 0;
	scene.fogStart = fog.fogStart ?? 0;
	scene.fogEnd = fog.fogEnd ?? 1_000;
	scene.fogDensity = fog.fogDensity ?? 0.01;
	scene.fogColor = Color3.FromArray(fog.fogColor ?? [0.2, 0.2, 0.3]);

	if (configuration.clearColor) {
		scene.clearColor = Color4.FromArray(configuration.clearColor);
	}
	if (configuration.ambientColor) {
		scene.ambientColor = Color3.FromArray(configuration.ambientColor);
	}
	if (configuration.physics?.gravity) {
		scene.getPhysicsEngine()?.setGravity(Vector3.FromArray(configuration.physics.gravity));
	}

	const clusteredLight = configuration.clusteredLight;
	if (clusteredLight) {
		editor.layout.preview.clusteredLightContainer.horizontalTiles = clusteredLight.horizontalTiles;
		editor.layout.preview.clusteredLightContainer.verticalTiles = clusteredLight.verticalTiles;
		editor.layout.preview.clusteredLightContainer.depthSlices = clusteredLight.depthSlices;
		editor.layout.preview.clusteredLightContainer.maxRange = clusteredLight.maxRange;
	}

	return addedResources;
}

/** Stores authored per-camera settings without activating a scene camera. */
export function registerSceneCameraRenderingConfigurations(configuration: any, cameras: Camera[]): void {
	const renderingConfigurations = Array.isArray(configuration.rendering) ? configuration.rendering : [];
	for (const rendering of renderingConfigurations) {
		const camera = cameras.find((candidate) => candidate.id === rendering.cameraId);
		if (!camera) {
			continue;
		}
		ssaoRenderingPipelineCameraConfigurations.set(camera, rendering.ssao2RenderingPipeline);
		vlsPostProcessCameraConfigurations.set(camera, rendering.vlsPostProcess);
		ssrRenderingPipelineCameraConfigurations.set(camera, rendering.ssrRenderingPipeline);
		motionBlurPostProcessCameraConfigurations.set(camera, rendering.motionBlurPostProcess);
		defaultPipelineCameraConfigurations.set(camera, rendering.defaultRenderingPipeline);
		taaPipelineCameraConfigurations.set(camera, rendering.taaRenderingPipeline);
		customColorPostProcessCameraConfigurations.set(camera, rendering.customColorPostProcess);
		iblShadowsRenderingPipelineCameraConfigurations.set(camera, rendering.iblShadowsRenderPipeline);
	}
}

/** Activates the retained lighting scene's editor-camera rendering configuration. */
export function applyEditorCameraRenderingConfiguration(editor: Editor, configuration: any): void {
	const camera = editor.layout.preview.camera;
	const renderingConfigurations = Array.isArray(configuration.rendering) ? configuration.rendering : [];
	const rendering = renderingConfigurations.find((candidate: any) => candidate.cameraId === camera.id || candidate.cameraId === configuration.editorCamera?.id);
	if (!rendering) {
		return;
	}

	ssaoRenderingPipelineCameraConfigurations.set(camera, rendering.ssao2RenderingPipeline);
	vlsPostProcessCameraConfigurations.set(camera, rendering.vlsPostProcess);
	ssrRenderingPipelineCameraConfigurations.set(camera, rendering.ssrRenderingPipeline);
	motionBlurPostProcessCameraConfigurations.set(camera, rendering.motionBlurPostProcess);
	defaultPipelineCameraConfigurations.set(camera, rendering.defaultRenderingPipeline);
	taaPipelineCameraConfigurations.set(camera, rendering.taaRenderingPipeline);
	customColorPostProcessCameraConfigurations.set(camera, rendering.customColorPostProcess);
	iblShadowsRenderingPipelineCameraConfigurations.set(camera, rendering.iblShadowsRenderPipeline);

	if (rendering.iblShadowsRenderPipeline) {
		parseIblShadowsRenderingPipeline(editor, rendering.iblShadowsRenderPipeline);
	}
	if (rendering.ssao2RenderingPipeline) {
		parseSSAO2RenderingPipeline(editor, rendering.ssao2RenderingPipeline);
	}
	if (rendering.vlsPostProcess) {
		parseVLSPostProcess(editor, rendering.vlsPostProcess);
	}
	if (rendering.ssrRenderingPipeline) {
		parseSSRRenderingPipeline(editor, rendering.ssrRenderingPipeline);
	}
	if (rendering.motionBlurPostProcess) {
		parseMotionBlurPostProcess(editor, rendering.motionBlurPostProcess);
	}
	if (rendering.defaultRenderingPipeline) {
		parseDefaultRenderingPipeline(editor, rendering.defaultRenderingPipeline);
	}
	if (rendering.taaRenderingPipeline) {
		parseTAARenderingPipeline(editor, rendering.taaRenderingPipeline);
	}
	if (rendering.customColorPostProcess) {
		parseCustomColorPostProcess(editor, rendering.customColorPostProcess);
	}
}

/** Applies all retained global settings after a scene is already loaded additively. */
export function applyLoadedSceneGlobalConfiguration(editor: Editor, projectPath: string, result: SceneLoadResult, assetsCache: Record<string, IAssetCache>): object[] {
	const addedResources = applySceneEnvironmentConfiguration(editor, projectPath, result.configuration ?? {}, result, assetsCache);
	applyEditorCameraRenderingConfiguration(editor, result.configuration ?? {});
	return addedResources;
}

function disposeEditorCameraRendering(editor: Editor): void {
	const camera = editor.layout.preview.camera;
	cameraConfigurationMaps.forEach((map) => map.delete(camera));
	disposeSSAO2RenderingPipeline();
	disposeVLSPostProcess(editor);
	disposeSSRRenderingPipeline();
	disposeMotionBlurPostProcess();
	disposeDefaultRenderingPipeline();
	disposeTAARenderingPipeline();
	disposeCustomColorPostProcess();
	disposeIblShadowsRenderingPipeline();
}
