import { AssetContainer } from "@babylonjs/core/assetContainer";
import { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { Material } from "@babylonjs/core/Materials/material";
import { Node } from "@babylonjs/core/node";
import { LoadAssetContainerFromSerializedScene } from "@babylonjs/core/Loading/Plugins/babylonFileLoader.pure";
import { SceneLoaderFlags } from "@babylonjs/core/Loading/sceneLoaderFlags";
import { Tools } from "@babylonjs/core/Misc/tools";
import { Scene } from "@babylonjs/core/scene";

import { configureGeneratedModelLodDeformations } from "../assets/model-lods";
import { configureOptimizedModelRigExposedTransforms } from "../assets/model-rig-optimizer";
import { applyMeshesLODQuality, configureMeshDistanceOrScreenCoverage } from "../tools/mesh";
import { isMesh } from "../tools/guards";
import { configureShadowMapRefreshRate, configureShadowMapRenderListPredicate } from "../tools/light";

import { configureAddressables } from "./addressables";
import { configureAdaptivePerformance } from "./adaptive-performance";
import { configureMobileSystemRuntime } from "./mobile-system-runtime";
import { configureGrpcTransport } from "./grpc-transport";
import { configureAnimatedTiles } from "./animated-tiles";
import { configureAnimationEvents } from "./animation-events";
import { configureUnityAnimationClipRuntime } from "./unity-animation-clip-runtime";
import { configureAnimators } from "./animator";
import { configureAudioMixer } from "./audio-mixer";
import { configureBehaviorTrees } from "./behavior-trees";
import { configureMlTrainingRuntime } from "../ai/ml-training";
import { configureCameraImpulses } from "./camera-impulses";
import { configureCameraStacks } from "./camera-stacks";
import { configureRendererLists } from "../rendering/renderer-lists";
import { configureCloths } from "./cloth";
import { configureHumanoidAvatars } from "./humanoid-avatar";
import { configureInputActions } from "./input-actions";
import { configureLights } from "./light";
import { configureLightCookies, getLightCookieTexture } from "./light-cookies";
import { configureLightingScenarios } from "./lighting-scenarios";
import { configureLightProbeVolumes } from "./light-probes";
import { configureReflectionProbes } from "./reflection-probes";
import { configureLocalization } from "./localization";
import { SceneLoaderOptions, ScriptMap } from "./loader";
import { configureNavAgents } from "./nav-agents";
import { configureParticleCollisions } from "./particle-collisions";
import { configureParticleCollisionEvents } from "./particle-collision-events";
import { configureParticleInteractions } from "./particle-interactions";
import { configureParticleProximityEvents } from "./particle-proximity-events";
import { configureParticleTextureVectorFields } from "./particle-texture-vector-fields";
import { configureParticleVectorFields } from "./particle-vector-fields";
import { configurePhysicsAggregate, configurePhysicsConstraints } from "./physics";
import { configurePhysics2D } from "./physics2d";
import { configureRenderingVolumes } from "./rendering-volumes";
import { configureActiveRenderingProfile } from "./rendering-profiles";
import { configureRendererDataSelections } from "./renderer-data";
import { configureSubsurfaceScattering } from "../rendering/subsurface-scattering";
import { configureRigLayers } from "./rig-layers";
import { configureIKControllers, configureLookAtConstraints, configureSpriteIKControllers } from "./rigging";
import { _applyScriptsForObjects, _removeRegisteredScriptInstance, IRegisteredScript, scriptsDictionary } from "./script/apply";
import { _preloadScriptsAssets } from "./script/preload";
import { configureSplineFollowers } from "./splines";
import { configureTerrainStreaming } from "./terrain-streaming";
import { configureOcclusionCulling, occlusionCullingMetadataKey, occlusionCullingSetsMetadataKey } from "./occlusion-culling";
import { configureImportedTextures, registerTextureParser } from "./texture";
import { configureTransformNodes } from "./transform-node";
import { clearRuntimeGameObjectComponents, configureGameObjectComponents } from "./game-object-components";
import { configureLighting2D } from "./lighting-2d";
import { configureVehicles } from "./vehicles";
import { configureVideoPlayers } from "./videos";
import { configureAlembicPlayers } from "./alembic";
import { configureVirtualCameras } from "./virtual-cameras";
import { configureVisualScriptGraphs } from "./visual-scripting";
import { refreshAuthoredECSRuntime } from "../ecs/runtime";
import { getECSStableHash } from "../ecs/hash";

import { registerAudioParser } from "./sound";
import { registerShadowGeneratorParser } from "./shadows";
import { registerMorphTargetManagerParser } from "./morph-target-manager";
import { registerSpriteMapParser } from "./sprite-map";
import { registerSpriteManagerParser } from "./sprite-manager";
import { registerNodeParticleSystemSetParser } from "./node-particle-system-set";

export type AdditiveSceneState = "loaded" | "unloading" | "unloaded";

export interface ILoadSceneAdditiveOptions extends SceneLoaderOptions {
	/** Applies editor-authored runtime systems and scripts to the loaded content. @default true */
	configureRuntime?: boolean;
}

export interface IAdditiveSceneResourceCounts {
	rootNodes: number;
	transformNodes: number;
	meshes: number;
	lights: number;
	cameras: number;
	materials: number;
	textures: number;
	skeletons: number;
	animationGroups: number;
	particleSystems: number;
	spriteManagers: number;
}

export interface IUnloadSceneAdditiveResult {
	unloaded: boolean;
	retainedSharedResources: number;
}

export interface IAdditiveSceneRuntimeServices {
	alembicPlayers?: unknown;
	addressables?: unknown;
	animators?: unknown;
	audioMixer?: unknown;
	humanoidAvatarValidation?: unknown;
	inputActions?: unknown;
	lightingScenarios?: unknown;
	localization?: unknown;
	videoPlayers?: unknown;
}

type ITrackedScript = { object: any; script: IRegisteredScript };
type ITrackedObserver = { remove: () => void };
type IServiceKey = keyof IAdditiveSceneRuntimeServices;
type IServiceValues = Partial<Record<IServiceKey, any>>;

const serviceKeys: IServiceKey[] = [
	"alembicPlayers",
	"addressables",
	"animators",
	"audioMixer",
	"humanoidAvatarValidation",
	"inputActions",
	"lightingScenarios",
	"localization",
	"videoPlayers",
];

const containerCollectionKeys = [
	"cameras",
	"lights",
	"meshes",
	"skeletons",
	"particleSystems",
	"animationGroups",
	"multiMaterials",
	"materials",
	"morphTargetManagers",
	"geometries",
	"transformNodes",
	"textures",
	"postProcesses",
	"effectLayers",
	"layers",
	"reflectionProbes",
	"lensFlareSystems",
	"proceduralTextures",
	"spriteManagers",
] as const;

interface ISceneRegistry {
	scene: Scene;
	baseMetadata: any;
	baseServices: IServiceValues;
	handles: AdditiveSceneHandle[];
}

interface IAdditiveSceneHandleInitialization {
	rootUrl: string;
	sceneFilename: string;
	scene: Scene;
	container: AssetContainer;
	metadata: Record<string, any>;
	services: IServiceValues;
	trackedScripts: ITrackedScript[];
	trackedObservers: ITrackedObserver[];
	clusteredLights: { container: any; lights: any[] } | null;
}

const registries = new WeakMap<Scene, ISceneRegistry>();
const operationLanes = new WeakMap<Scene, Promise<void>>();
const additiveClusteredLightContainers = new WeakSet<object>();

function enqueueSceneOperation<T>(scene: Scene, operation: () => Promise<T>): Promise<T> {
	const previous = operationLanes.get(scene) ?? Promise.resolve();
	const result = previous.catch(() => undefined).then(operation);
	operationLanes.set(
		scene,
		result.then(
			() => undefined,
			() => undefined
		)
	);
	return result;
}

function getRegistry(scene: Scene): ISceneRegistry {
	let registry = registries.get(scene);
	if (!registry) {
		const baseServices: IServiceValues = {};
		serviceKeys.forEach((key) => (baseServices[key] = (scene as any)[key]));
		registry = { scene, baseMetadata: scene.metadata, baseServices, handles: [] };
		registries.set(scene, registry);
	}
	return registry;
}

function isPlainObject(value: any): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeMetadataValue(base: any, incoming: any): any {
	if (Array.isArray(base) && Array.isArray(incoming)) {
		return [...base, ...incoming];
	}
	if (base === undefined) {
		return incoming;
	}
	if (isPlainObject(base) && isPlainObject(incoming)) {
		const result = { ...base };
		Object.entries(incoming).forEach(([key, value]) => (result[key] = mergeMetadataValue(result[key], value)));
		return result;
	}
	return base;
}

function composeRuntimeMetadata(registry: ISceneRegistry): void {
	if (!registry.handles.length) {
		registry.scene.metadata = registry.baseMetadata;
		if (registry.scene.metadata && typeof registry.scene.metadata === "object") {
			delete registry.scene.metadata[occlusionCullingSetsMetadataKey];
		}
		return;
	}
	let metadata = isPlainObject(registry.baseMetadata) ? { ...registry.baseMetadata } : {};
	registry.handles.forEach((handle) => (metadata = mergeMetadataValue(metadata, handle.metadata)));
	const ecsConfiguration = registry.baseMetadata?.babylonEditorECS ?? registry.handles.find((handle) => handle.metadata.babylonEditorECS)?.metadata.babylonEditorECS;
	if (ecsConfiguration !== undefined) {
		// ECS configuration is one exact scene-wide contract. Generic array
		// merging would duplicate built-ins and corrupt cross-references.
		metadata.babylonEditorECS = ecsConfiguration;
	} else {
		delete metadata.babylonEditorECS;
	}
	const occlusionConfigurations = [registry.baseMetadata, ...registry.handles.map((handle) => handle.metadata)]
		.map((value) => value?.[occlusionCullingMetadataKey])
		.filter((value) => value !== undefined);
	if (occlusionConfigurations.length) {
		metadata[occlusionCullingSetsMetadataKey] = occlusionConfigurations;
	} else {
		delete metadata[occlusionCullingSetsMetadataKey];
	}
	registry.scene.metadata = metadata;
}

function validateECSConfigurationCompatibility(registry: ISceneRegistry, metadata: Record<string, any>): void {
	const incoming = metadata.babylonEditorECS;
	if (incoming === undefined) {
		return;
	}
	const existing = registry.baseMetadata?.babylonEditorECS ?? registry.handles.find((handle) => handle.metadata.babylonEditorECS)?.metadata.babylonEditorECS;
	if (existing !== undefined && getECSStableHash(existing) !== getECSStableHash(incoming)) {
		throw new Error("Cannot load additive scene because its ECS configuration differs from the running scene contract.");
	}
}

function isolateRuntimeServices(scene: Scene): void {
	serviceKeys.forEach((key) => ((scene as any)[key] = undefined));
}

function captureRuntimeServices(scene: Scene): IServiceValues {
	const result: IServiceValues = {};
	serviceKeys.forEach((key) => {
		const value = (scene as any)[key];
		if (value !== undefined) {
			result[key] = value;
		}
	});
	return result;
}

function composeRuntimeServices(registry: ISceneRegistry): void {
	for (const key of serviceKeys) {
		if (key === "alembicPlayers" || key === "animators" || key === "videoPlayers") {
			const maps = [registry.baseServices[key], ...registry.handles.map((handle) => handle._services[key])].filter((value): value is Map<any, any> => value instanceof Map);
			if (maps.length) {
				const combined = new Map<any, any>();
				maps.forEach((map) => map.forEach((value, id) => combined.set(id, value)));
				(registry.scene as any)[key] = combined;
			} else {
				(registry.scene as any)[key] = undefined;
			}
			continue;
		}
		const additive = [...registry.handles].reverse().find((handle) => handle._services[key] !== undefined)?._services[key];
		(registry.scene as any)[key] = additive ?? registry.baseServices[key];
	}
}

function validateServiceCollisions(registry: ISceneRegistry, services: IServiceValues): void {
	for (const key of ["alembicPlayers", "animators", "videoPlayers"] as const) {
		const incoming = services[key];
		if (!(incoming instanceof Map)) {
			continue;
		}
		const existingMaps = [registry.baseServices[key], ...registry.handles.map((handle) => handle._services[key])].filter(
			(value): value is Map<any, any> => value instanceof Map
		);
		for (const id of incoming.keys()) {
			if (existingMaps.some((map) => map.has(id))) {
				throw new Error(`Cannot load additive scene because runtime ${key} id "${String(id)}" is already registered.`);
			}
		}
	}
}

function disposeRuntimeServices(services: IServiceValues): void {
	const alembicPlayers = services.alembicPlayers;
	if (alembicPlayers instanceof Map) {
		alembicPlayers.forEach((runtime) => runtime?.dispose?.());
	}
	const animators = services.animators;
	if (animators instanceof Map) {
		animators.forEach((runtime) => runtime?.dispose?.());
	}
	services.inputActions?.dispose?.();
	services.lightingScenarios?.dispose?.();
}

function registerParsers(): void {
	registerAudioParser();
	registerTextureParser();
	registerShadowGeneratorParser();
	registerMorphTargetManagerParser();
	registerSpriteMapParser();
	registerSpriteManagerParser();
	registerNodeParticleSystemSetParser();
}

async function readSerializedScene(rootUrl: string, sceneFilename: string): Promise<Record<string, any>> {
	const source = sceneFilename.startsWith("data:") || /^(?:blob:|https?:\/\/|file:)/i.test(sceneFilename) ? sceneFilename : `${rootUrl}${sceneFilename}`;
	const text = source.startsWith("data:") ? await (await fetch(source)).text() : await Tools.LoadFileAsync(source, false);
	const parsed = JSON.parse(text);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("The additive scene source must contain a serialized Babylon scene object.");
	}
	return parsed;
}

async function waitForSceneReady(scene: Scene, onProgress?: (value: number) => void): Promise<void> {
	const initialWaitingItems = scene.getWaitingItemsCount();
	if (scene.isReady() && initialWaitingItems === 0) {
		onProgress?.(1);
		return;
	}
	while (!scene.isDisposed && (!scene.isReady() || scene.getWaitingItemsCount() > 0)) {
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		const remaining = scene.getWaitingItemsCount();
		onProgress?.(initialWaitingItems > 0 ? Math.max(0, Math.min(1, (initialWaitingItems - remaining) / initialWaitingItems)) : scene.isReady() ? 1 : 0);
	}
	if (scene.isDisposed) {
		throw new Error("The target scene was disposed while additive content was loading.");
	}
}

function snapshotSceneCollections(scene: Scene): Map<string, Set<any>> {
	const result = new Map<string, Set<any>>();
	containerCollectionKeys.forEach((key) => result.set(key, new Set(Array.isArray((scene as any)[key]) ? (scene as any)[key] : [])));
	return result;
}

function addRuntimeCreatedResources(container: AssetContainer, scene: Scene, before: Map<string, Set<any>>): void {
	for (const key of containerCollectionKeys) {
		const target = (container as any)[key];
		const values = (scene as any)[key];
		if (!Array.isArray(target) || !Array.isArray(values)) {
			continue;
		}
		const previous = before.get(key) ?? new Set();
		values.forEach((value: any) => {
			if (!previous.has(value) && !target.includes(value)) {
				target.push(value);
			}
		});
	}
	container.populateRootNodes();
}

function snapshotObservers(scene: Scene): Map<any, Set<any>> {
	const result = new Map<any, Set<any>>();
	for (const key of Object.keys(scene as any)) {
		if (key === "onDisposeObservable") {
			continue;
		}
		const observable = (scene as any)[key];
		if (observable && Array.isArray(observable.observers)) {
			result.set(observable, new Set(observable.observers));
		}
	}
	return result;
}

function addedObservers(scene: Scene, before: Map<any, Set<any>>): ITrackedObserver[] {
	const result: ITrackedObserver[] = [];
	for (const key of Object.keys(scene as any)) {
		if (key === "onDisposeObservable") {
			continue;
		}
		const observable = (scene as any)[key];
		if (!observable || !Array.isArray(observable.observers)) {
			continue;
		}
		const previous = before.get(observable) ?? new Set();
		observable.observers.forEach((observer: ITrackedObserver) => {
			if (!previous.has(observer) && !result.includes(observer)) {
				result.push(observer);
			}
		});
	}
	return result;
}

function scriptObjects(scene: Scene, container: AssetContainer): any[] {
	return [scene, ...container.getNodes(), ...container.particleSystems, ...(container.spriteManagers?.flatMap((manager) => manager.sprites) ?? [])];
}

function snapshotScripts(objects: any[]): Map<any, Set<IRegisteredScript>> {
	return new Map(objects.map((object) => [object, new Set(scriptsDictionary.get(object) ?? [])]));
}

function addedScripts(objects: any[], before: Map<any, Set<IRegisteredScript>>): ITrackedScript[] {
	return objects.flatMap((object) => (scriptsDictionary.get(object) ?? []).filter((script) => !before.get(object)?.has(script)).map((script) => ({ object, script })));
}

function removeTrackedRuntime(trackedScripts: ITrackedScript[], trackedObservers: ITrackedObserver[]): void {
	trackedScripts.forEach(({ object, script }) => _removeRegisteredScriptInstance(object, script));
	trackedObservers.forEach((observer) => observer.remove());
}

function materialTextures(material: Material): BaseTexture[] {
	try {
		return material.getActiveTextures();
	} catch {
		return [];
	}
}

function retainedSharedResources(scene: Scene, container: AssetContainer): Set<any> {
	const retained = new Set<any>();
	const ownedNodes = new Set(container.getNodes());
	const ownedMaterials = new Set<Material>([...container.materials, ...container.multiMaterials]);
	const externalMeshes = scene.meshes.filter((mesh) => !ownedNodes.has(mesh));
	const externallyReferencedMaterials = new Set<Material>();

	externalMeshes.forEach((mesh) => {
		if (mesh.material) {
			externallyReferencedMaterials.add(mesh.material);
			if ("subMaterials" in mesh.material && Array.isArray(mesh.material.subMaterials)) {
				mesh.material.subMaterials.forEach((material) => material && externallyReferencedMaterials.add(material));
			}
		}
		if (mesh.geometry && container.geometries.includes(mesh.geometry)) {
			retained.add(mesh.geometry);
		}
		if (mesh.skeleton && container.skeletons.includes(mesh.skeleton)) {
			retained.add(mesh.skeleton);
		}
		if (mesh.morphTargetManager && container.morphTargetManagers.includes(mesh.morphTargetManager)) {
			retained.add(mesh.morphTargetManager);
		}
	});
	externallyReferencedMaterials.forEach((material) => ownedMaterials.has(material) && retained.add(material));

	for (const multiMaterial of container.multiMaterials) {
		if (retained.has(multiMaterial)) {
			multiMaterial.subMaterials.forEach((material) => material && ownedMaterials.has(material) && retained.add(material));
		}
	}

	const externallyUsedTextures = new Set<BaseTexture>();
	[...scene.materials, ...scene.multiMaterials]
		.filter((material) => !ownedMaterials.has(material) || retained.has(material) || externallyReferencedMaterials.has(material))
		.forEach((material) => materialTextures(material).forEach((texture) => externallyUsedTextures.add(texture)));
	if (scene.environmentTexture) {
		externallyUsedTextures.add(scene.environmentTexture);
	}
	scene.particleSystems
		.filter((system) => !container.particleSystems.includes(system))
		.forEach((system: any) => {
			[system.particleTexture, system.noiseTexture].forEach((texture) => texture && externallyUsedTextures.add(texture));
		});
	container.textures.forEach((texture) => externallyUsedTextures.has(texture) && retained.add(texture));
	return retained;
}

function detachExternalChildren(scene: Scene, container: AssetContainer): void {
	const ownedNodes = new Set(container.getNodes());
	scene.getNodes().forEach((node) => {
		if (!ownedNodes.has(node) && node.parent && ownedNodes.has(node.parent)) {
			const transformNode = node as Node & { setParent?: (parent: Node | null) => void };
			if (transformNode.setParent) {
				transformNode.setParent(null);
			} else {
				node.parent = null;
			}
		}
	});
}

function pruneRetainedResources(container: AssetContainer, retained: Set<any>): void {
	for (const key of containerCollectionKeys) {
		const values = (container as any)[key];
		if (Array.isArray(values)) {
			(container as any)[key] = values.filter((value: any) => !retained.has(value));
		}
	}
}

function disposeContainer(scene: Scene, container: AssetContainer, retainShared: boolean): number {
	if (scene.isDisposed) {
		container.dispose();
		return 0;
	}
	detachExternalChildren(scene, container);
	const retained = retainShared ? retainedSharedResources(scene, container) : new Set<any>();
	pruneRetainedResources(container, retained);
	container.removeAllFromScene();
	container.dispose();
	return retained.size;
}

function configureClusteredLights(scene: Scene, rootUrl = ""): { container: any; lights: any[] } | null {
	const ids = Array.isArray(scene.metadata?.clusteredLight?.lights) ? scene.metadata.clusteredLight.lights : [];
	if (!ids.length) {
		return null;
	}
	const existing = scene.lights.find((light) => light.getClassName() === "ClusteredLightContainer") as any;
	const clustered = configureLights(scene, existing, rootUrl);
	if (!existing) {
		additiveClusteredLightContainers.add(clustered);
	}
	return { container: clustered, lights: ids.map((id: string) => scene.getLightById(id)).filter(Boolean) };
}

function releaseClusteredLights(configuration: { container: any; lights: any[] } | null): void {
	configuration?.lights.forEach((light) => configuration.container.removeLight(light));
	if (configuration && additiveClusteredLightContainers.has(configuration.container) && configuration.container.lights.length === 0) {
		configuration.container.dispose();
		additiveClusteredLightContainers.delete(configuration.container);
	}
}

async function configureRuntime(scene: Scene, container: AssetContainer, rootUrl: string, scriptsMap: ScriptMap, options: ILoadSceneAdditiveOptions): Promise<void> {
	const scope = { meshes: container.meshes };
	configureLightCookies(scene, rootUrl, container.lights);
	for (const light of container.lights) {
		const texture = getLightCookieTexture(light);
		if (texture && !container.textures.includes(texture)) {
			container.textures.push(texture);
		}
	}
	await configureImportedTextures(scene, rootUrl, container.textures);
	// Additive GUI/script preloading observes the same scene-level localization and Addressables services.
	configureAddressables(scene, rootUrl);
	configureLocalization(scene, rootUrl);
	await waitForSceneReady(scene, (progress) => options.onProgress?.(0.55 + progress * 0.2));
	if (!options.skipAssetsPreload) {
		let loadedAssetsCount = 0;
		do {
			loadedAssetsCount = await _preloadScriptsAssets(rootUrl, scene, scriptsMap);
		} while (loadedAssetsCount !== 0 && !scene.isDisposed);
	}
	if (SceneLoaderFlags.ForceFullSceneLoadingForIncremental) {
		container.meshes.forEach((mesh) => isMesh(mesh) && mesh._checkDelayState());
	}

	configureMeshDistanceOrScreenCoverage(scope);
	applyMeshesLODQuality(options.lodsQuality ?? options.quality ?? "high", scope);
	configureShadowMapRenderListPredicate(scene);
	configureShadowMapRefreshRate(scene);
	container.meshes.forEach((mesh) => configurePhysicsAggregate(mesh));
	configurePhysicsConstraints(scene);
	configureVehicles(scene);
	configureIKControllers(scene);
	configureLookAtConstraints(scene);
	configureSpriteIKControllers(scene);
	configureHumanoidAvatars(scene);
	configureGeneratedModelLodDeformations(container);
	configureCloths(scene);
	configurePhysics2D(scene);
	await configureNavAgents(scene, rootUrl);
	configureBehaviorTrees(scene);
	configureMlTrainingRuntime(scene);
	configureInputActions(scene);
	configureAudioMixer(scene);
	configureLightingScenarios(scene);
	configureLightProbeVolumes(scene);
	configureReflectionProbes(scene);
	configureAnimators(scene);
	configureAnimationEvents(scene);
	configureUnityAnimationClipRuntime(scene, rootUrl);
	configureSplineFollowers(scene);
	configureVirtualCameras(scene);
	configureTerrainStreaming(scene, rootUrl);
	configureParticleCollisions(scene);
	configureParticleCollisionEvents(scene);
	configureParticleInteractions(scene);
	configureParticleVectorFields(scene);
	configureParticleTextureVectorFields(scene);
	configureParticleProximityEvents(scene);
	configureVisualScriptGraphs(scene);
	configureRendererLists(scene);
	configureRenderingVolumes(scene, rootUrl);
	configureActiveRenderingProfile(scene, rootUrl);
	configureAdaptivePerformance(scene);
	configureMobileSystemRuntime(scene);
	configureGrpcTransport(scene);
	configureSubsurfaceScattering(scene, rootUrl);
	configureRendererDataSelections(scene);
	configureAnimatedTiles(scene);
	await configureAlembicPlayers(scene, rootUrl, container.transformNodes);
	await configureVideoPlayers(scene, rootUrl);
	configureTransformNodes(container);
	configureGameObjectComponents(container);
	configureLighting2D(scene);
	_applyScriptsForObjects(scene, scriptObjects(scene, container), scriptsMap, rootUrl);
	options.onProgress?.(1);
}

export class AdditiveSceneHandle {
	private _state: AdditiveSceneState = "loaded";
	private _unloadResult: IUnloadSceneAdditiveResult | null = null;

	/** Runtime services authored by this scene. Scene-level singleton properties expose the most recently loaded service, while this object always exposes the exact handle-local service. */
	public readonly runtime: Readonly<IAdditiveSceneRuntimeServices>;
	public readonly resourceCounts: Readonly<IAdditiveSceneResourceCounts>;
	public readonly metadata: Readonly<Record<string, any>>;

	public readonly rootUrl: string;
	public readonly sceneFilename: string;
	public readonly scene: Scene;
	public readonly _services: IServiceValues;
	private _container: AssetContainer;
	private _trackedScripts: ITrackedScript[];
	private _trackedObservers: ITrackedObserver[];
	private _clusteredLights: { container: any; lights: any[] } | null;

	public constructor(initialization: IAdditiveSceneHandleInitialization) {
		this.rootUrl = initialization.rootUrl;
		this.sceneFilename = initialization.sceneFilename;
		this.scene = initialization.scene;
		this._container = initialization.container;
		this._services = initialization.services;
		this._trackedScripts = initialization.trackedScripts;
		this._trackedObservers = initialization.trackedObservers;
		this._clusteredLights = initialization.clusteredLights;
		this.metadata = initialization.metadata;
		this.runtime = initialization.services;
		this.resourceCounts = {
			rootNodes: this._container.rootNodes.length,
			transformNodes: this._container.transformNodes.length,
			meshes: this._container.meshes.length,
			lights: this._container.lights.length,
			cameras: this._container.cameras.length,
			materials: this._container.materials.length + this._container.multiMaterials.length,
			textures: this._container.textures.length,
			skeletons: this._container.skeletons.length,
			animationGroups: this._container.animationGroups.length,
			particleSystems: this._container.particleSystems.length,
			spriteManagers: this._container.spriteManagers.length,
		};
	}

	public get state(): AdditiveSceneState {
		return this._state;
	}

	public get rootNodes(): readonly Node[] {
		return this._container.rootNodes;
	}

	public getNodeById(id: string): Node | null {
		return this._container.getNodes().find((node) => node.id === id) ?? null;
	}

	public getNodeByName(name: string): Node | null {
		return this._container.getNodes().find((node) => node.name === name) ?? null;
	}

	public unload(): Promise<IUnloadSceneAdditiveResult> {
		return enqueueSceneOperation(this.scene, () => this._unload());
	}

	public async _unload(): Promise<IUnloadSceneAdditiveResult> {
		if (this._unloadResult) {
			return this._unloadResult;
		}
		this._state = "unloading";
		removeTrackedRuntime(this._trackedScripts, this._trackedObservers);
		this._trackedScripts = [];
		this._trackedObservers = [];
		clearRuntimeGameObjectComponents(this._container.getNodes());
		releaseClusteredLights(this._clusteredLights);
		disposeRuntimeServices(this._services);
		const retainedSharedResources = disposeContainer(this.scene, this._container, true);
		const registry = registries.get(this.scene);
		if (registry) {
			registry.handles = registry.handles.filter((handle) => handle !== this);
			composeRuntimeServices(registry);
			composeRuntimeMetadata(registry);
			configureCameraStacks(this.scene);
			configureRendererLists(this.scene);
			configureLightProbeVolumes(this.scene);
			configureReflectionProbes(this.scene);
			configureAdaptivePerformance(this.scene);
			configureMobileSystemRuntime(this.scene);
			configureGrpcTransport(this.scene);
			configureSubsurfaceScattering(this.scene);
			configureLighting2D(this.scene);
			configureOcclusionCulling(this.scene);
			refreshAuthoredECSRuntime(this.scene);
			if (!registry.handles.length) {
				registries.delete(this.scene);
			}
		}
		this._state = "unloaded";
		this._unloadResult = { unloaded: true, retainedSharedResources };
		return this._unloadResult;
	}
}

async function loadSceneAdditiveInternal(
	rootUrl: string,
	sceneFilename: string,
	scene: Scene,
	scriptsMap: ScriptMap,
	options: ILoadSceneAdditiveOptions
): Promise<AdditiveSceneHandle> {
	if (scene.isDisposed) {
		throw new Error("Cannot load additive content into a disposed scene.");
	}
	scene.loadingQuality = options.quality ?? scene.loadingQuality ?? "high";
	scene.loadingTexturesQuality = options.texturesQuality ?? scene.loadingQuality;
	scene.loadingShadowsQuality = options.shadowsQuality ?? scene.loadingQuality;
	scene.loadingLodsQuality = options.lodsQuality ?? scene.loadingQuality;
	registerParsers();
	options.onProgress?.(0);
	const document = await readSerializedScene(rootUrl, sceneFilename);
	options.onProgress?.(0.25);
	const metadata = document.metadata && typeof document.metadata === "object" ? document.metadata : {};
	const existingNodeIds = new Set(scene.getNodes().map((node) => node.id));
	const container = LoadAssetContainerFromSerializedScene(scene, document, rootUrl);
	const loadedNodeIds = new Set<string>();
	for (const node of container.getNodes()) {
		if (existingNodeIds.has(node.id) || loadedNodeIds.has(node.id)) {
			container.dispose();
			throw new Error(`Cannot load additive scene because node id "${node.id}" is already present in the running scene.`);
		}
		loadedNodeIds.add(node.id);
	}
	container.addAllToScene();
	container.populateRootNodes();
	configureOptimizedModelRigExposedTransforms(scene, [...container.transformNodes, ...container.meshes], container.skeletons);
	configureRigLayers(scene);
	configureCameraImpulses(scene);
	options.onProgress?.(0.5);

	const registry = getRegistry(scene);
	const previousActiveCamera = scene.activeCamera;
	const observerBaseline = snapshotObservers(scene);
	const scriptBaseline = snapshotScripts(scriptObjects(scene, container));
	let collectionBaseline = snapshotSceneCollections(scene);
	let clusteredLights: { container: any; lights: any[] } | null = null;
	let services: IServiceValues = {};
	let trackedObservers: ITrackedObserver[] = [];
	let trackedScripts: ITrackedScript[] = [];
	let registeredHandle: AdditiveSceneHandle | null = null;

	try {
		scene.metadata = metadata;
		isolateRuntimeServices(scene);
		clusteredLights = configureClusteredLights(scene, rootUrl);
		collectionBaseline = snapshotSceneCollections(scene);
		if (options.configureRuntime !== false) {
			await configureRuntime(scene, container, rootUrl, scriptsMap, options);
		} else {
			await waitForSceneReady(scene, (progress) => options.onProgress?.(0.5 + progress * 0.5));
			options.onProgress?.(1);
		}
		services = captureRuntimeServices(scene);
		trackedObservers = addedObservers(scene, observerBaseline);
		trackedScripts = addedScripts(scriptObjects(scene, container), scriptBaseline);
		addRuntimeCreatedResources(container, scene, collectionBaseline);
		validateServiceCollisions(registry, services);
		validateECSConfigurationCompatibility(registry, metadata);
		const handle = new AdditiveSceneHandle({ rootUrl, sceneFilename, scene, container, metadata, services, trackedScripts, trackedObservers, clusteredLights });
		registry.handles.push(handle);
		registeredHandle = handle;
		composeRuntimeMetadata(registry);
		if (options.configureRuntime !== false) {
			configureOcclusionCulling(scene);
			refreshAuthoredECSRuntime(scene);
		}
		return handle;
	} catch (error) {
		if (registeredHandle) {
			registry.handles = registry.handles.filter((handle) => handle !== registeredHandle);
			registeredHandle = null;
		}
		trackedObservers = addedObservers(scene, observerBaseline);
		trackedScripts = addedScripts(scriptObjects(scene, container), scriptBaseline);
		removeTrackedRuntime(trackedScripts, trackedObservers);
		releaseClusteredLights(clusteredLights);
		services = captureRuntimeServices(scene);
		disposeRuntimeServices(services);
		addRuntimeCreatedResources(container, scene, collectionBaseline);
		disposeContainer(scene, container, false);
		throw error;
	} finally {
		if (!scene.isDisposed) {
			scene.activeCamera = previousActiveCamera;
			composeRuntimeServices(registry);
			composeRuntimeMetadata(registry);
			configureCameraStacks(scene);
			configureRendererLists(scene);
			configureLightProbeVolumes(scene);
			configureReflectionProbes(scene);
			configureAdaptivePerformance(scene);
			configureMobileSystemRuntime(scene);
			configureGrpcTransport(scene);
			configureSubsurfaceScattering(scene);
			configureOcclusionCulling(scene);
		}
		if (!registry.handles.length) {
			registries.delete(scene);
		}
	}
}

/** Loads a serialized Babylon scene into an existing running scene with exact, independently unloadable ownership. */
export function loadSceneAdditive(
	rootUrl: string,
	sceneFilename: string,
	scene: Scene,
	scriptsMap: ScriptMap,
	options: ILoadSceneAdditiveOptions = {}
): Promise<AdditiveSceneHandle> {
	return enqueueSceneOperation(scene, () => loadSceneAdditiveInternal(rootUrl, sceneFilename, scene, scriptsMap, options));
}

/** Unloads a previously returned additive scene handle. This operation is idempotent. */
export function unloadSceneAdditive(handle: AdditiveSceneHandle): Promise<IUnloadSceneAdditiveResult> {
	return handle.unload();
}
