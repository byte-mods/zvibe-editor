import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Constants } from "@babylonjs/core/Engines/constants";
import { AppendSceneAsync } from "@babylonjs/core/Loading/sceneLoader";
import { SceneLoaderFlags } from "@babylonjs/core/Loading/sceneLoaderFlags";
import { ClusteredLightContainer } from "@babylonjs/core/Lights/Clustered/clusteredLightContainer";
import { Tools } from "@babylonjs/core/Misc/tools";

import { isMesh } from "../tools/guards";
import { applyMeshesLODQuality, configureMeshDistanceOrScreenCoverage } from "../tools/mesh";
import { configureShadowMapRefreshRate, configureShadowMapRenderListPredicate } from "../tools/light";

import { IScript } from "../script";

import { applyRenderingConfigurationForCamera, IApplyRenderingConfigurationOptions } from "../rendering/tools";

import { configurePhysicsAggregate, configurePhysicsConstraints } from "./physics";
import { configureVehicles } from "./vehicles";
import { configureIKControllers, configureLookAtConstraints, configureSpriteIKControllers } from "./rigging";
import { configureRigLayers } from "./rig-layers";
import { configureHumanoidAvatars } from "./humanoid-avatar";
import { configureOptimizedModelRigExposedTransforms } from "../assets/model-rig-optimizer";
import { configureGeneratedModelLodDeformations } from "../assets/model-lods";
import { configureCloths } from "./cloth";
import { configureAnimationEvents } from "./animation-events";
import { configureUnityAnimationClipRuntime } from "./unity-animation-clip-runtime";
import { configurePhysics2D } from "./physics2d";
import { configureNavAgents } from "./nav-agents";
import { configureLocalization } from "./localization";
import { configureAddressables } from "./addressables";
import { configureAdaptivePerformance } from "./adaptive-performance";
import { configureMobileSystemRuntime } from "./mobile-system-runtime";
import { configureGrpcTransport } from "./grpc-transport";
import { configureBehaviorTrees } from "./behavior-trees";
import { configureMlTrainingRuntime } from "../ai/ml-training";
import { configureInputActions } from "./input-actions";
import { configureTouchControls } from "./touch-controls";
import { configureAudioMixer } from "./audio-mixer";
import { configureAnimators } from "./animator";
import { configureSplineFollowers } from "./splines";
import { configureVirtualCameras } from "./virtual-cameras";
import { configureCameraImpulses } from "./camera-impulses";
import { configureTerrainStreaming } from "./terrain-streaming";
import { configureOcclusionCulling } from "./occlusion-culling";
import { configureParticleCollisions } from "./particle-collisions";
import { configureParticleCollisionEvents } from "./particle-collision-events";
import { configureParticleInteractions } from "./particle-interactions";
import { configureParticleVectorFields } from "./particle-vector-fields";
import { configureParticleTextureVectorFields } from "./particle-texture-vector-fields";
import { configureParticleProximityEvents } from "./particle-proximity-events";
import { configureVisualScriptGraphs } from "./visual-scripting";
import { configureXR } from "./xr";
import { configureVideoPlayers } from "./videos";
import { configureAlembicPlayers } from "./alembic";
import { configureAnimatedTiles } from "./animated-tiles";
import { applyRenderingConfigurations } from "./rendering";
import { configureRenderingVolumes } from "./rendering-volumes";
import { configureActiveRenderingProfile } from "./rendering-profiles";
import { configureRendererDataSelections } from "./renderer-data";
import { configureSubsurfaceScattering } from "../rendering/subsurface-scattering";
import { configureCameraStacks } from "./camera-stacks";
import { configureRendererLists } from "../rendering/renderer-lists";
import { configureCustomRenderPassGraph } from "../rendering/custom-render-pass-graph";
import { configureOnTileRendering } from "../rendering/on-tile-rendering";
import { configureLightingScenarios } from "./lighting-scenarios";
import { configureLightProbeVolumes } from "./light-probes";
import { configureReflectionProbes } from "./reflection-probes";
import { configureDeviceLabFromLocation } from "./device-lab";
import { configureShaderVariantCollection } from "./shader-variant-collection";

import { _applyScriptsForObjects } from "./script/apply";
import { _preloadScriptsAssets } from "./script/preload";

import { registerAudioParser } from "./sound";
import { configureImportedTextures, registerTextureParser } from "./texture";
import { registerShadowGeneratorParser } from "./shadows";
import { registerMorphTargetManagerParser } from "./morph-target-manager";

import { configureLights } from "./light";
import { configureLightCookies } from "./light-cookies";
import { registerSpriteMapParser } from "./sprite-map";
import { configureTransformNodes } from "./transform-node";
import { configureGameObjectComponents } from "./game-object-components";
import { configureLighting2D } from "./lighting-2d";
import { configureNetworking, getSceneNetworkingConfiguration } from "./networking";
import { configureAuthoredECSRuntime } from "../ecs/runtime";
import { registerSpriteManagerParser } from "./sprite-manager";
import { registerNodeParticleSystemSetParser } from "./node-particle-system-set";

/**
 * Defines the possible output type of a script.
 * `default` is a class that will be instantiated with the object as parameter.
 * `onStart` is a function that will be called once before the first render passing the reference to the object the script is attached to.
 * `onUpdate` is a function that will be called every frame passing the reference to the object the script is attached to
 */
export type ScriptMap = Record<
	string,
	{
		default?: new (object: any) => IScript;
	} & IScript
>;

/**
 * Defines the overall desired quality of the scene.
 * In other words, defines the quality of textures that will be loaded in terms of dimensions.
 * The editor computes automatic "high (untouched)", "medium (half)", and "low (quarter)" quality levels for textures.
 * Using "medium" or "low" quality levels will reduce the memory usage and improve the performance of the scene
 * especially on mobiles where memory is limited.
 */
export type SceneLoaderQualitySelector = "very-low" | "low" | "medium" | "high";

export type SceneLoaderOptions = {
	/**
	 * Defines the quality of the scene.
	 * This will affect the quality of textures that will be loaded in terms of dimensions.
	 * The editor computes automatic "high (untouched)", "medium (half)", and "low (quarter)" quality levels for textures.
	 * Using "medium" or "low" quality levels will reduce the memory usage and improve the performance of the scene
	 * especially on mobiles where memory is limited. The "very-low" quality level is even more aggressive with shadows quality.
	 */
	quality?: SceneLoaderQualitySelector;

	/**
	 * Same as "quality" but only applied to textures. If set, this has priority over "quality".
	 */
	texturesQuality?: SceneLoaderQualitySelector;
	/**
	 * Same as "quality" but only applied to shadows. If set, this has priority over "quality".
	 */
	shadowsQuality?: SceneLoaderQualitySelector;
	/**
	 * Sames as "quality" but only applied to LODs. If set, this has priority over "quality".
	 * This will affect the screen coverage or distance used to switch between LODs. The "very-low" quality level is even more aggressive with LODs.
	 */
	lodsQuality?: SceneLoaderQualitySelector;

	/**
	 * Defines the optional configuration to apply when applying the rendering configuration for a camera.
	 * This allows to selectively disable some post-processes when applying the rendering configuration for a camera.
	 * This is particularly useful for when your game provides options to enable/disable post-processes.
	 */
	postProcessConfiguration?: IApplyRenderingConfigurationOptions;

	/**
	 * Defines the function called to notify the loading progress in interval [0, 1]
	 */
	onProgress?: (value: number) => void;

	/**
	 * Defines whether to skip the preloading of assets linked to scripts.
	 * To ensure all resources are loaded before resolving loadScene promise, all resources linked to scripts are preloaded after the scene is loaded.
	 * To bypass this behavior, you can set this flag to true.
	 * @default false
	 */
	skipAssetsPreload?: boolean;

	/**
	 * Loads a gameplay-complete scene without window/GPU-only render products.
	 * Used by isolated Multiplayer Play clients running on a NullEngine. The
	 * serialized source file is never changed.
	 * @default false
	 */
	headless?: boolean;

	/**
	 * Transient connection override used by isolated editor Play clients. It is
	 * never written back to scene metadata or exported project configuration.
	 */
	networking?: {
		autoConnect?: boolean;
		endpoint?: string | null;
	};
};

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		loadingQuality: SceneLoaderQualitySelector;
		loadingTexturesQuality: SceneLoaderQualitySelector;
		loadingShadowsQuality: SceneLoaderQualitySelector;
		loadingLodsQuality: SceneLoaderQualitySelector;
	}
}

const sceneConfigurationMap: Map<
	Scene,
	{
		clusteredLightContainer?: ClusteredLightContainer;
	}
> = new Map();

async function waitForWaitingItems(scene: Scene, onProgress: (value: number) => void) {
	const waitingItemsCount = scene.getWaitingItemsCount();

	while (!scene.isDisposed && (!scene.isReady() || scene.getWaitingItemsCount() > 0)) {
		await new Promise<void>((resolve) => setTimeout(resolve, 150));

		const loadedItemsCount = waitingItemsCount - scene.getWaitingItemsCount();

		if (loadedItemsCount === waitingItemsCount) {
			scene.textures.forEach((texture) => {
				if (texture.delayLoadState === Constants.DELAYLOADSTATE_NONE) {
					texture.delayLoadState = Constants.DELAYLOADSTATE_LOADED;
				}
			});
		}

		onProgress(loadedItemsCount / waitingItemsCount);
	}
}

async function createHeadlessSceneSource(rootUrl: string, sceneFilename: string): Promise<string> {
	const source = sceneFilename.startsWith("data:") || /^(?:blob:|https?:\/\/|file:)/i.test(sceneFilename) ? sceneFilename : `${rootUrl}${sceneFilename}`;
	const text = source.startsWith("data:") ? await (await fetch(source)).text() : await Tools.LoadFileAsync(source, false);
	if (typeof text !== "string") {
		throw new Error("Headless scene loading requires a UTF-8 serialized Babylon scene.");
	}
	const serialized = JSON.parse(text) as Record<string, unknown>;
	if (!serialized || typeof serialized !== "object" || Array.isArray(serialized)) {
		throw new Error("Headless scene loading requires a serialized Babylon scene object.");
	}

	// Shadow generators require a render-target implementation and can fail
	// before their associated light is available on a NullEngine. Multiplayer
	// simulation retains lights/materials and every gameplay system, but does
	// not allocate window/GPU-only render products for isolated clients.
	serialized.shadowGenerators = [];
	serialized.reflectionProbes = [];
	serialized.renderTargetTextures = [];
	delete serialized.environmentTexture;

	return `data:${JSON.stringify(serialized)}`;
}

export async function loadScene(rootUrl: any, sceneFilename: string, scene: Scene, scriptsMap: ScriptMap, options?: SceneLoaderOptions) {
	scene.loadingQuality = options?.quality ?? "high";

	scene.loadingTexturesQuality = options?.texturesQuality ?? scene.loadingQuality;
	scene.loadingShadowsQuality = options?.shadowsQuality ?? scene.loadingQuality;
	scene.loadingLodsQuality = options?.lodsQuality ?? scene.loadingQuality;

	registerAudioParser();
	registerTextureParser();
	registerShadowGeneratorParser();

	registerMorphTargetManagerParser();

	registerSpriteMapParser();
	registerSpriteManagerParser();

	registerNodeParticleSystemSetParser();

	// Check configuration
	const configuration = sceneConfigurationMap.get(scene) ?? {};
	sceneConfigurationMap.set(scene, configuration);

	// Append to the given scene
	const source = options?.headless ? await createHeadlessSceneSource(String(rootUrl), sceneFilename) : `${rootUrl}${sceneFilename}`;
	await AppendSceneAsync(source, scene, {
		rootUrl: options?.headless ? String(rootUrl) : undefined,
		pluginExtension: ".babylon",
		onProgress: (event) => {
			const progress = Math.min((event.loaded / event.total) * 0.5);
			options?.onProgress?.(progress);
		},
	});
	configureLightCookies(scene, rootUrl);
	await configureImportedTextures(scene, rootUrl);
	// GUI/script asset preloading can resolve localized strings and Addressable-backed assets.
	configureAddressables(scene, rootUrl);
	configureLocalization(scene, rootUrl);

	// Wait until scene is ready.
	await waitForWaitingItems(scene, (progress) => {
		options?.onProgress?.(0.5 + progress * 0.25);
	});

	if (!options?.skipAssetsPreload) {
		// Loop until all assets are loaded.
		// This is required as some assets can be linked to scripts that are themselves linked to .scene files
		// that are not loaded at the time of the first call to _preloadScriptsAssets.
		let loadedAssetsCount = 0;
		do {
			loadedAssetsCount = await _preloadScriptsAssets(rootUrl, scene, scriptsMap);
		} while (loadedAssetsCount !== 0 && !scene.isDisposed);
	}

	// Ensure all meshes perform their delay state check
	if (SceneLoaderFlags.ForceFullSceneLoadingForIncremental) {
		scene.meshes.forEach((m) => isMesh(m) && m._checkDelayState());
	}

	// Configure clustered lights
	if (!options?.headless) {
		const clusteredLightContainer = configureLights(scene, configuration.clusteredLightContainer, rootUrl);
		configuration.clusteredLightContainer = clusteredLightContainer;
	}

	// Wait until scene is ready.
	await waitForWaitingItems(scene, (progress) => {
		options?.onProgress?.(0.75 + progress * 0.25);
	});

	options?.onProgress?.(1);

	configureMeshDistanceOrScreenCoverage(scene);
	applyMeshesLODQuality(scene.loadingLodsQuality, scene);

	if (!options?.headless) {
		configureShadowMapRenderListPredicate(scene);
		configureShadowMapRefreshRate(scene);
	}

	if (!options?.headless && scene.metadata?.rendering) {
		applyRenderingConfigurations(scene, scene.metadata.rendering);

		if (scene.activeCamera) {
			applyRenderingConfigurationForCamera(scene.activeCamera, rootUrl, options?.postProcessConfiguration);
		}
	}

	if (scene.metadata?.physicsGravity) {
		scene.getPhysicsEngine()?.setGravity(Vector3.FromArray(scene.metadata?.physicsGravity));
	}

	scene.meshes.forEach((mesh) => {
		configurePhysicsAggregate(mesh);
	});
	configurePhysicsConstraints(scene);
	configureVehicles(scene);
	configureIKControllers(scene);
	configureLookAtConstraints(scene);
	configureSpriteIKControllers(scene);
	configureRigLayers(scene);
	configureHumanoidAvatars(scene);
	configureOptimizedModelRigExposedTransforms(scene);
	configureGeneratedModelLodDeformations(scene);
	configureCloths(scene);
	configurePhysics2D(scene);
	await configureNavAgents(scene, rootUrl);
	configureBehaviorTrees(scene);
	configureMlTrainingRuntime(scene);
	configureInputActions(scene);
	if (!options?.headless) {
		configureTouchControls(scene);
	}
	configureAudioMixer(scene);
	if (!options?.headless) {
		configureLightingScenarios(scene);
		configureLightProbeVolumes(scene);
		configureReflectionProbes(scene);
	}
	configureAnimators(scene);
	configureAnimationEvents(scene);
	configureUnityAnimationClipRuntime(scene, rootUrl);
	configureSplineFollowers(scene);
	configureVirtualCameras(scene);
	configureCameraImpulses(scene);
	configureTerrainStreaming(scene, rootUrl);
	configureOcclusionCulling(scene);
	configureParticleCollisions(scene);
	configureParticleCollisionEvents(scene);
	configureParticleInteractions(scene);
	configureParticleVectorFields(scene);
	configureParticleTextureVectorFields(scene);
	configureParticleProximityEvents(scene);
	configureVisualScriptGraphs(scene);
	if (!options?.headless) {
		configureRendererLists(scene);
		configureCameraStacks(scene);
		configureRenderingVolumes(scene, rootUrl);
		configureActiveRenderingProfile(scene, rootUrl);
		configureAdaptivePerformance(scene);
		configureMobileSystemRuntime(scene);
		configureSubsurfaceScattering(scene, rootUrl);
		configureRendererDataSelections(scene);
		configureCustomRenderPassGraph(scene, rootUrl);
		configureOnTileRendering(scene, rootUrl);
	}
	configureAnimatedTiles(scene);
	await configureAlembicPlayers(scene, rootUrl);
	if (!options?.headless) {
		await configureVideoPlayers(scene, rootUrl);
		await configureXR(scene);
		configureDeviceLabFromLocation(scene);
		await configureShaderVariantCollection(scene);
	}

	configureTransformNodes(scene);
	configureGameObjectComponents(scene);
	configureLighting2D(scene);
	const networkingConfiguration = getSceneNetworkingConfiguration(scene, false);
	if (options?.networking) {
		networkingConfiguration.transport = { ...networkingConfiguration.transport, ...options.networking };
	}
	configureNetworking(scene, { configuration: networkingConfiguration });
	configureGrpcTransport(scene);
	configureAuthoredECSRuntime(scene);
	_applyScriptsForObjects(
		scene,
		[scene, ...scene.transformNodes, ...scene.meshes, ...scene.lights, ...scene.cameras, ...(scene.spriteManagers?.flatMap((spriteManager) => spriteManager.sprites) ?? [])],
		scriptsMap,
		rootUrl
	);
}
