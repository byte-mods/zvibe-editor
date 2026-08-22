import { join, basename } from "path/posix";
import { readdir } from "fs-extra";

import { AnimationGroup, SceneLoaderFlags, Animation } from "babylonjs";

import { Editor } from "../../editor/main";

import { createDirectoryIfNotExist } from "../../tools/fs";

import { createSceneLink } from "../../tools/scene/scene-link";
import { updateIblShadowsRenderPipeline } from "../../tools/light/ibl";
import { forceCompileAllSceneMaterials } from "../../tools/scene/materials";
import { IAssetCache, loadSavedAssetsCache } from "../../tools/assets/cache";
import { checkProjectCachedCompressedTextures } from "../../tools/assets/ktx";
import { isAbstractMesh, isMesh } from "../../tools/guards/nodes";
import { isCubeTexture, isEXRCubeTexture, isHDRCubeTexture, isTexture } from "../../tools/guards/texture";
import { updateAllLights, updatePointLightShadowMapRenderListPredicate } from "../../tools/light/shadows";

import { registerTextureParser } from "./texture";
import { applyEditorCameraRenderingConfiguration, applySceneEnvironmentConfiguration, registerSceneCameraRenderingConfigurations } from "./configuration";
import { filterSerializedSceneObjectFiles } from "./files";
import { createNewSceneDefaultNodes } from "./default";
import { LoadSceneProgressComponent, showLoadSceneProgressDialog } from "./progress";

import { loadGuis } from "./plugins/gui";
import { loadMeshes } from "./plugins/meshes";
import { restorePhysicsConstraints } from "../../mcp/physics/constraints";
import { restoreVehicles } from "../../mcp/physics/vehicles";
import { restoreIKControllers, restoreLookAtConstraints, restoreSpriteIKControllers } from "../../mcp/rigging/ik";
import {
	configureHumanoidMuscleLimits,
	configureUnityAnimationClipRuntime,
	configureCameraStacks,
	configureLightingScenarios,
	configureLighting2D,
	configureLightProbeVolumes,
	configureParticleCollisionEvents,
	configureParticleCollisions,
	configureParticleInteractions,
	configureParticleTextureVectorFields,
	configureRendererLists,
	configureRigLayers,
	configureSubsurfaceScattering,
	configureVideoPlayers,
	configureShaderVariantCollection,
} from "babylonjs-editor-tools";
import { getProjectAssetsRootUrl } from "../configuration";
import { readSerializedJSON } from "../serialization-session";
import { restoreCloths } from "../../mcp/cloth/cloth";
import { restorePhysics2D } from "../../mcp/physics2d/physics2d";
import { restoreNavAgents } from "../../mcp/navmesh/navmesh";
import { restoreVisualScriptGraphs } from "../../mcp/visual-scripting/graphs";
import { restoreBehaviorTrees } from "../../mcp/ai/behavior-trees";
import { restoreAnimationEvents } from "../../mcp/animations/animations";
import { applyRenderingProfile } from "../../mcp/rendering/profiles";
import { loadLights } from "./plugins/lights";
import { loadCameras } from "./plugins/cameras";
import { loadSkeletons } from "./plugins/skeletons";
import { loadSpriteMaps } from "./plugins/sprite-maps";
import { loadSoundNodes } from "./plugins/sound-nodes";
import { loadSpriteManagers } from "./plugins/sprite-managers";
import { loadTransformNodes } from "./plugins/transform-nodes";
import { loadParticleSystems } from "./plugins/particle-systems";
import { loadAnimationGroups } from "./plugins/animation-groups";
import { loadMorphTargetManagers } from "./plugins/morph-targets";
import { loadShadowGenerators } from "./plugins/shadow-generators";
import { loadNodeParticleSystemSets } from "./plugins/node-particle-system-sets";
import { configureEditorLocalization } from "../../mcp/localization/localization";
import { configureEditorAlembicPlayers } from "../../mcp/assets/alembic";
import {
	captureAddedSceneResources,
	createSceneLoadResult,
	disposeSceneLoadResult,
	findSceneLoadResultNodeById,
	getSceneLoadResultNodes,
	resolveSceneLoadResultParents,
	SceneLoadResult,
	snapshotSceneResources,
} from "./result";

export type { SceneLoadResult } from "./result";

/**
 * Defines the list of all loaded scenes. This is used to detect cycle references
 * when computing scene links.
 */
const loadedScenes: string[] = [];

export type SceneLoaderOptions = {
	/**
	 * Defines wether or not the scene is being loaded as link.
	 */
	asLink?: boolean;
	/** Defines whether this scene supplies shared environment, fog, physics, and editor-camera settings. */
	applySceneConfiguration?: boolean;
	/** Keeps rendering suspended until a later workspace scene has finished loading. */
	deferReady?: boolean;
};

export type ISceneLoaderPluginOptions = SceneLoaderOptions & {
	scenePath: string;
	relativeScenePath: string;
	projectPath: string;
	loadResult: SceneLoadResult;

	progress: LoadSceneProgressComponent;
	progressStep: number;

	assetsCache: Record<string, IAssetCache>;
};

export async function loadScene(editor: Editor, projectPath: string, scenePath: string, options?: SceneLoaderOptions): Promise<SceneLoadResult> {
	registerTextureParser(editor);

	const scene = editor.layout.preview.scene;
	const resourceSnapshot = snapshotSceneResources(scene);
	const relativeScenePath = scenePath.replace(join(projectPath, "/"), "");
	const loadResult = createSceneLoadResult();

	options ??= {};
	const applySceneConfiguration = options.applySceneConfiguration ?? !options.asLink;
	let progress: LoadSceneProgressComponent | null = null;

	try {
		editor.layout.preview.setRenderScene(false);
		editor.layout.console.log(`Loading scene "${relativeScenePath}"`);

		// Prepare directories
		await Promise.all([
			createDirectoryIfNotExist(join(scenePath, "nodes")),
			createDirectoryIfNotExist(join(scenePath, "meshes")),
			createDirectoryIfNotExist(join(scenePath, "lods")),
			createDirectoryIfNotExist(join(scenePath, "lights")),
			createDirectoryIfNotExist(join(scenePath, "cameras")),
			createDirectoryIfNotExist(join(scenePath, "geometries")),
			createDirectoryIfNotExist(join(scenePath, "skeletons")),
			createDirectoryIfNotExist(join(scenePath, "shadowGenerators")),
			createDirectoryIfNotExist(join(scenePath, "sceneLinks")),
			createDirectoryIfNotExist(join(scenePath, "gui")),
			createDirectoryIfNotExist(join(scenePath, "soundNodes")),
			createDirectoryIfNotExist(join(scenePath, "particleSystems")),
			createDirectoryIfNotExist(join(scenePath, "morphTargetManagers")),
			createDirectoryIfNotExist(join(scenePath, "morphTargets")),
			createDirectoryIfNotExist(join(scenePath, "animationGroups")),
			createDirectoryIfNotExist(join(scenePath, "sprite-maps")),
			createDirectoryIfNotExist(join(scenePath, "sprite-managers")),
			createDirectoryIfNotExist(join(scenePath, "nodeParticleSystemSets")),
		]);

		const sceneDirectoryEntries = await Promise.all([
			readdir(join(scenePath, "nodes")),
			readdir(join(scenePath, "meshes")),
			readdir(join(scenePath, "lods")),
			readdir(join(scenePath, "lights")),
			readdir(join(scenePath, "cameras")),
			readdir(join(scenePath, "skeletons")),
			readdir(join(scenePath, "shadowGenerators")),
			readdir(join(scenePath, "sceneLinks")),
			readdir(join(scenePath, "gui")),
			readdir(join(scenePath, "soundNodes")),
			readdir(join(scenePath, "particleSystems")),
			readdir(join(scenePath, "morphTargetManagers")),
			readdir(join(scenePath, "animationGroups")),
			readdir(join(scenePath, "sprite-maps")),
			readdir(join(scenePath, "sprite-managers")),
			readdir(join(scenePath, "nodeParticleSystemSets")),
		]);

		const [
			nodesFiles,
			meshesFiles,
			lodsFiles,
			lightsFiles,
			cameraFiles,
			skeletonFiles,
			shadowGeneratorFiles,
			sceneLinkFiles,
			guiFiles,
			soundNodeFiles,
			particleSystemFiles,
			morphTargetManagerFiles,
			animationGroupFiles,
			spriteMapFiles,
			spriteManagerFiles,
			nodeParticleSystemSetFiles,
		] = sceneDirectoryEntries.map(filterSerializedSceneObjectFiles);

		progress = await showLoadSceneProgressDialog(`Loading ${basename(scenePath)}...`);
		const progressStep =
			100 /
			(nodesFiles.length +
				meshesFiles.length +
				lodsFiles.length +
				lightsFiles.length +
				cameraFiles.length +
				skeletonFiles.length +
				shadowGeneratorFiles.length +
				sceneLinkFiles.length +
				guiFiles.length +
				soundNodeFiles.length +
				particleSystemFiles.length +
				morphTargetManagerFiles.length +
				animationGroupFiles.length +
				spriteMapFiles.length +
				spriteManagerFiles.length +
				nodeParticleSystemSetFiles.length);

		SceneLoaderFlags.ForceFullSceneLoadingForIncremental = true;

		const assetsCache = loadSavedAssetsCache();
		const config = await readSerializedJSON(join(scenePath, "config.json"), "utf-8");
		loadResult.configuration = config;

		if (applySceneConfiguration) {
			applySceneEnvironmentConfiguration(editor, projectPath, config, loadResult, assetsCache);
		}

		if (config.newScene) {
			createNewSceneDefaultNodes(editor, loadResult);
			delete config.newScene;
		}

		const pluginLoadOptions: ISceneLoaderPluginOptions = {
			projectPath,
			scenePath,
			relativeScenePath,
			loadResult,
			progress,
			progressStep,
			assetsCache,
			asLink: options.asLink,
		};

		await loadTransformNodes(editor, nodesFiles, scene, pluginLoadOptions);
		await loadSkeletons(editor, skeletonFiles, scene, pluginLoadOptions);
		await loadMeshes(meshesFiles, scene, pluginLoadOptions);
		restorePhysicsConstraints(scene);
		restoreVehicles(scene);
		restoreIKControllers(scene);
		restoreLookAtConstraints(scene);
		restoreSpriteIKControllers(scene);
		configureRigLayers(scene as any);
		configureHumanoidMuscleLimits(scene as any);
		restoreCloths(scene);
		restorePhysics2D(scene);
		await restoreNavAgents(scene);
		restoreVisualScriptGraphs(scene);
		restoreBehaviorTrees(scene);
		await loadMorphTargetManagers(editor, morphTargetManagerFiles, scene, pluginLoadOptions);
		await loadLights(editor, lightsFiles, scene, pluginLoadOptions);
		await loadCameras(editor, cameraFiles, scene, pluginLoadOptions);
		const alembic = await configureEditorAlembicPlayers(scene, editor);
		alembic.errors.forEach((error) => editor.layout.console.warn(`Alembic player ${error.id}: ${error.message}`));
		await configureVideoPlayers(scene as any, getProjectAssetsRootUrl() ?? "");

		if (!options?.asLink) {
			await loadShadowGenerators(editor, shadowGeneratorFiles, scene, pluginLoadOptions);
		}

		// Localized GUI bindings resolve while .gui assets are instantiated.
		await configureEditorLocalization(scene);
		await loadGuis(editor, guiFiles, pluginLoadOptions);
		await loadSoundNodes(editor, soundNodeFiles, scene, pluginLoadOptions);
		await loadParticleSystems(editor, particleSystemFiles, scene, pluginLoadOptions);
		configureParticleCollisions(scene as any);
		configureParticleCollisionEvents(scene as any);
		configureParticleInteractions(scene as any);
		configureParticleTextureVectorFields(scene as any);
		await loadSpriteMaps(editor, spriteMapFiles, scene, pluginLoadOptions);
		await loadSpriteManagers(editor, spriteManagerFiles, scene, pluginLoadOptions);
		await loadAnimationGroups(editor, animationGroupFiles, scene, pluginLoadOptions);
		restoreAnimationEvents(scene);
		configureUnityAnimationClipRuntime(scene as any, getProjectAssetsRootUrl() ?? "");
		await loadNodeParticleSystemSets(editor, nodeParticleSystemSetFiles, scene, pluginLoadOptions);
		configureLighting2D(scene as any);
		configureLightingScenarios(scene as any);
		configureLightProbeVolumes(scene as any);

		// Configure lights
		loadResult.lights.forEach((light) => {
			updatePointLightShadowMapRenderListPredicate(light);
		});

		// Configure LODs
		loadResult.meshes.forEach((mesh) => {
			if (!mesh._waitingData.lods || !isMesh(mesh)) {
				return;
			}

			const masterMesh = findSceneLoadResultNodeById(loadResult, mesh._waitingData.lods.masterMeshId);
			if (masterMesh && isMesh(masterMesh)) {
				mesh.material = masterMesh.material;
				masterMesh.addLODLevel(mesh._waitingData.lods.distanceOrScreenCoverage, mesh);
			}

			mesh._waitingData.lods = null;
		});

		// Scene animations
		scene.animations ??= [];
		config.animations?.forEach((data: any) => {
			scene.animations.push(Animation.Parse(data));
		});

		// Scene animation groups
		// TODO: legacy
		config.animationGroups?.forEach((data: any) => {
			const group = AnimationGroup.Parse(data, scene);
			if (group.targetedAnimations.length === 0) {
				group.dispose();
			} else {
				loadResult.animationGroups.push(group);
			}
		});

		// Load scene links
		loadedScenes.push(relativeScenePath);

		for (const file of sceneLinkFiles) {
			try {
				const data = await readSerializedJSON(join(scenePath, "sceneLinks", file), "utf-8");

				if (options?.asLink && data.metadata?.doNotSerialize) {
					continue;
				}

				if (loadedScenes.includes(data._relativePath)) {
					editor.layout.console.error(`Can't load scene "${data._relativePath}": cycle references detected.`);
					continue;
				}

				const sceneLink = await createSceneLink(editor, join(projectPath, data._relativePath));
				if (sceneLink) {
					sceneLink.parse(data);

					sceneLink.uniqueId = data.uniqueId;
					sceneLink.metadata ??= {};
					sceneLink.metadata._waitingParentId = data.metadata?.parentId ?? data.parentId;

					loadResult.sceneLinks.push(sceneLink);
				}
			} catch (e) {
				if (e instanceof Error) {
					editor.layout.console.error(`Failed to load scene link file "${file}": ${e.message}`);
				}
			}

			progress.step(progressStep);
		}

		loadedScenes.pop();

		// Parent identities are local to the authored scene, even though Babylon hosts all loaded content in one Scene.
		resolveSceneLoadResultParents(loadResult);
		const allNodes = getSceneLoadResultNodes(loadResult);

		// Configure clustered lights
		if (config.clusteredLight) {
			config.clusteredLight.lights.forEach((lightId: any) => {
				const light = loadResult.lights.find((candidate) => candidate.id === lightId);
				if (light) {
					editor.layout.preview.clusteredLightContainer.addLight(light);
				}
			});
		}

		if (!options?.asLink) {
			allNodes.forEach((n) => {
				if (n.metadata) {
					delete n.metadata._waitingParentId;
				}

				if (isAbstractMesh(n)) {
					n.refreshBoundingInfo(true, true);
				}
			});

			registerSceneCameraRenderingConfigurations(config, loadResult.cameras);
			if (applySceneConfiguration) {
				const subsurfaceRuntime = configureSubsurfaceScattering(scene as any, `${projectPath}/`);
				if (subsurfaceRuntime.errors.length) {
					editor.layout.console.warn(`Failed to restore subsurface scattering: ${subsurfaceRuntime.errors.join(" ")}`);
				}
				applyEditorCameraRenderingConfiguration(editor, config);
				const activeRenderingProfileId = scene.metadata?.babylonEditorActiveRenderingProfileId;
				if (typeof activeRenderingProfileId === "string") {
					try {
						applyRenderingProfile(scene, { id: activeRenderingProfileId, nodeId: editor.layout.preview.camera.id, activateProject: true }, { editor });
					} catch (error) {
						editor.layout.console.warn(`Failed to restore active rendering profile: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				try {
					configureRendererLists(scene as any);
				} catch (error) {
					editor.layout.console.warn(`Failed to restore renderer lists/layers: ${error instanceof Error ? error.message : String(error)}`);
				}
				const cameraStackRuntime = configureCameraStacks(scene as any);
				if (!cameraStackRuntime.valid) {
					editor.layout.console.warn(`Failed to restore active camera stack: ${cameraStackRuntime.error}`);
				}
			}
		}

		const linkedObjects = new Set(loadResult.sceneLinks.flatMap((sceneLink) => sceneLink.getLoadedObjects()));
		captureAddedSceneResources(scene, resourceSnapshot, loadResult, linkedObjects);
		loadResult.textures.forEach((texture) => {
			if (isTexture(texture) || isCubeTexture(texture) || isHDRCubeTexture(texture) || isEXRCubeTexture(texture)) {
				texture.url = texture.name;
			}
		});

		setTimeout(() => {
			updateAllLights(scene);
			updateIblShadowsRenderPipeline(scene, true);

			if (!options.asLink) {
				checkProjectCachedCompressedTextures(editor);
				if (!options.deferReady) {
					editor.layout.preview.setRenderScene(true);
				}
			}
		}, 150);

		if (!options?.asLink) {
			await configureShaderVariantCollection(scene as any);
			progress.setName("Compiling materials...");
			await forceCompileAllSceneMaterials(scene);
		}

		progress.dispose();

		editor.layout.console.log("Scene loaded and editor is ready.");

		return loadResult;
	} catch (error) {
		const linkedObjects = new Set(loadResult.sceneLinks.flatMap((sceneLink) => sceneLink.getLoadedObjects()));
		captureAddedSceneResources(scene, resourceSnapshot, loadResult, linkedObjects);
		disposeSceneLoadResult(scene, loadResult);
		progress?.dispose();
		if (!options.asLink && !options.deferReady) {
			editor.layout.preview.setRenderScene(true);
		}
		throw error;
	}
}
