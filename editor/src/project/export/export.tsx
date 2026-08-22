import { join, dirname, basename, extname } from "path/posix";
import { createHash } from "crypto";
import { pathExists, readFile, readJSON, readdir, remove, writeJSON } from "fs-extra";

import { RenderTargetTexture, SceneSerializer } from "babylonjs";
import { configureTerrainStreamingExport, ITerrainStreamingExportArtifact, ModelImporterPlatform, TextureImporterPlatform } from "babylonjs-editor-tools";

import { toast } from "sonner";

import { isNodeMaterial } from "../../tools/guards/material";
import { isEXRCubeTexture, isHDRCubeTexture } from "../../tools/guards/texture";
import { getCollisionMeshFor } from "../../tools/mesh/collision";
import { storeTexturesBaseSize } from "../../tools/material/texture";
import { extractNodeMaterialTextures } from "../../tools/material/extract";
import { createDirectoryIfNotExist, normalizedGlob } from "../../tools/fs";
import { isCollisionMesh, isEditorCamera, isMesh } from "../../tools/guards/nodes";
import { extractNodeParticleSystemSetTextures, extractParticleSystemTextures } from "../../tools/particles/extract";

import { taaPipelineCameraConfigurations } from "../../editor/rendering/taa";
import { vlsPostProcessCameraConfigurations } from "../../editor/rendering/vls";
import { saveRenderingConfigurationForCamera } from "../../editor/rendering/tools";
import { ssrRenderingPipelineCameraConfigurations } from "../../editor/rendering/ssr";
import { ssaoRenderingPipelineCameraConfigurations } from "../../editor/rendering/ssao";
import { defaultPipelineCameraConfigurations } from "../../editor/rendering/default-pipeline";
import { motionBlurPostProcessCameraConfigurations } from "../../editor/rendering/motion-blur";
import { customColorPostProcessCameraConfigurations } from "../../editor/rendering/custom-color";
import {
	applyGeneratedEditableMeshToSerializedData,
	buildGeneratedEditableMeshGeometry,
	getEditableMeshSourceManifest,
	stripEditableSourceMetadataForRuntime,
} from "../../mcp/meshes/editable-source";

import { Editor } from "../../editor/main";

import { writeBinaryGeometry } from "../tools/geometry";

import { processAssetFile } from "./assets";
import { configureMeshesLODs } from "./lod";
import { handleExportScripts } from "./scripts";
import { configureMaterials } from "./materials";
import { configureMeshesPhysics } from "./physics";
import { configureClusteredLights } from "./light";
import { configureParticleSystems } from "./particles";
import { configurePhysics2DExportMetadata } from "./physics2d";
import { configureMlTrainingExportMetadata } from "./ml-training";
import { configureInputActionsExportMetadata } from "./input-actions";
import { configureTouchControlsExportMetadata } from "./touch-controls";
import { configureVisualScriptingExportMetadata } from "./visual-scripting";
import { configureBehaviorGraphExportMetadata } from "./behavior-graphs";
import { exportAddressables } from "./addressables";
import { EditorExportProjectProgressComponent } from "./progress";
import { ExportSceneProgressComponent, showExportSceneProgressDialog } from "./dialog";

/** Removes editor-only profiling evidence from generated runtime scenes without mutating the authored editor scene. */
export function stripProfilerStateFromRuntimeSceneData(data: any): void {
	if (data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)) {
		data.metadata = { ...data.metadata };
		delete data.metadata.babylonEditorProfilerState;
	}
}

/** Removes server deployment/provider authoring; the exported server consumes generated build/deploy descriptors instead. */
export function stripConsoleServerStateFromRuntimeSceneData(data: any): void {
	if (data?.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)) {
		data.metadata = { ...data.metadata };
		delete data.metadata.babylonEditorConsoleServer;
	}
}

export type IExportProjectOptions = {
	optimize: boolean;
	modelPlatform?: ModelImporterPlatform;
	assetPlatform?: TextureImporterPlatform;
	noDialog?: boolean;
	noProgress?: boolean;
	throwOnError?: boolean;
};

let exporting = false;

export async function exportProject(editor: Editor, options: IExportProjectOptions): Promise<boolean> {
	if (exporting || !editor.state.projectPath || !editor.state.lastOpenedScenePath) {
		return false;
	}

	exporting = true;

	if (options.optimize) {
		editor.layout.selectTab("console");
	}

	try {
		await _exportProject(editor, options);
		return true;
	} catch (e) {
		console.log(e);
		const message = e instanceof Error ? e.message : String(e);

		editor.layout.console.error(`Error exporting project:\n ${message}`);
		toast.error("Error exporting project");
		if (options.throwOnError) {
			throw e;
		}
		return false;
	} finally {
		exporting = false;
	}
}

async function _exportProject(editor: Editor, options: IExportProjectOptions): Promise<void> {
	let progress: EditorExportProjectProgressComponent | null = null;
	const toastId = toast(<EditorExportProjectProgressComponent ref={(r) => (progress = r)} />, {
		dismissible: false,
		duration: options.noProgress ? -1 : Infinity,
	});

	let dialog: ExportSceneProgressComponent | null = null;
	try {
		if (!options.noDialog) {
			dialog = await showExportSceneProgressDialog(editor, "Exporting scene...");
		}

		await _writeProjectExport(editor, options, (step) => {
			progress?.step(step);
			dialog?.step(step);
		});
	} finally {
		toast.dismiss(toastId);
		dialog?.dispose();
	}
}

async function _writeProjectExport(editor: Editor, options: IExportProjectOptions, onProgress: (step: number) => void): Promise<void> {
	const { projectPath, lastOpenedScenePath } = editor.state;
	if (!projectPath || !lastOpenedScenePath) {
		throw new Error("No project scene is open to export.");
	}

	const scene = editor.layout.preview.scene;
	const editorCamera = scene.cameras.find((camera) => isEditorCamera(camera));
	const clusteredLightContainer = editor.layout.preview.clusteredLightContainer;

	if (scene.activeCamera) {
		saveRenderingConfigurationForCamera(scene.activeCamera);
	}

	const projectDir = dirname(projectPath);
	const publicPath = join(projectDir, "public");

	const sceneName = basename(lastOpenedScenePath).split(".").shift()!;

	const scenePath = join(publicPath, "scene");
	const extractedTexturesOutputPath = join(scenePath, "assets", "editor-generated_extracted-textures");

	await Promise.all([
		createDirectoryIfNotExist(publicPath),
		createDirectoryIfNotExist(scenePath),
		createDirectoryIfNotExist(join(scenePath, sceneName)),
		createDirectoryIfNotExist(extractedTexturesOutputPath),
	]);

	const exportedAssets: string[] = [];

	const savedGeometries: string[] = [];
	const savedGeometryIds: string[] = [];
	const terrainStreamingArtifacts: ITerrainStreamingExportArtifact[] = [];

	storeTexturesBaseSize(scene);

	scene.meshes.forEach((mesh) => (mesh.doNotSerialize = mesh.metadata?.doNotSerialize ?? false));
	scene.lights.forEach((light) => (light.doNotSerialize = light.metadata?.doNotSerialize ?? false));
	scene.cameras.forEach((camera) => (camera.doNotSerialize = camera.metadata?.doNotSerialize ?? false));
	scene.transformNodes.forEach((transformNode) => (transformNode.doNotSerialize = transformNode.metadata?.doNotSerialize ?? false));
	clusteredLightContainer.lights.forEach((light) => (light.doNotSerialize = light.metadata?.doNotSerialize ?? false));

	const data = await SceneSerializer.SerializeAsync(scene);
	stripProfilerStateFromRuntimeSceneData(data);
	stripConsoleServerStateFromRuntimeSceneData(data);

	scene.meshes.forEach((mesh) => (mesh.doNotSerialize = false));
	scene.lights.forEach((light) => (light.doNotSerialize = false));
	scene.cameras.forEach((camera) => (camera.doNotSerialize = false));
	scene.transformNodes.forEach((transformNode) => (transformNode.doNotSerialize = false));
	clusteredLightContainer.lights.forEach((light) => (light.doNotSerialize = false));

	const editorCameraIndex = data.cameras?.findIndex((camera) => camera.id === editorCamera?.id);
	if (editorCameraIndex !== -1) {
		data.cameras?.splice(editorCameraIndex, 1);
	}

	const clusteredLightContainerIndex = data.lights?.findIndex((light) => light.id === clusteredLightContainer.id);
	if (clusteredLightContainerIndex !== -1) {
		data.lights?.splice(clusteredLightContainerIndex, 1);
	}

	data.metadata ??= {};

	data.metadata.rendering = scene.cameras
		.filter((camera) => !isEditorCamera(camera))
		.map((camera) => ({
			cameraId: camera.id,
			ssao2RenderingPipeline: ssaoRenderingPipelineCameraConfigurations.get(camera),
			vlsPostProcess: vlsPostProcessCameraConfigurations.get(camera),
			ssrRenderingPipeline: ssrRenderingPipelineCameraConfigurations.get(camera),
			motionBlurPostProcess: motionBlurPostProcessCameraConfigurations.get(camera),
			defaultRenderingPipeline: defaultPipelineCameraConfigurations.get(camera),
			taaRenderingPipeline: taaPipelineCameraConfigurations.get(camera),
			customColorPostProcess: customColorPostProcessCameraConfigurations.get(camera),
		}));

	delete data.effectLayers;
	delete data.postProcesses;
	delete data.spriteManagers;

	data.metadata.physicsGravity = scene.getPhysicsEngine()?.gravity?.asArray();
	data.metadata.babylonEditorPhysicsConstraints = structuredClone(scene.metadata?.babylonEditorPhysicsConstraints ?? []);
	data.metadata.babylonEditorHybridPhysicsSolver = structuredClone(scene.metadata?.babylonEditorHybridPhysicsSolver ?? undefined);
	data.metadata.babylonEditorHybridPhysicsSamples = structuredClone(scene.metadata?.babylonEditorHybridPhysicsSamples ?? []);
	data.metadata.babylonEditorIKControllers = structuredClone(scene.metadata?.babylonEditorIKControllers ?? []);
	data.metadata.babylonEditorRigLayers = structuredClone(scene.metadata?.babylonEditorRigLayers ?? []);
	data.metadata.babylonEditorHumanoidAvatars = structuredClone(scene.metadata?.babylonEditorHumanoidAvatars ?? []);
	data.metadata.babylonEditorHumanoidAvatarMasks = structuredClone(scene.metadata?.babylonEditorHumanoidAvatarMasks ?? []);
	data.metadata.babylonEditorCloths = structuredClone(scene.metadata?.babylonEditorCloths ?? []);
	data.metadata.babylonEditorPhysics2D = structuredClone(scene.metadata?.babylonEditorPhysics2D ?? []);
	data.metadata.babylonEditorPhysics2DMaterials = structuredClone(scene.metadata?.babylonEditorPhysics2DMaterials ?? []);
	configurePhysics2DExportMetadata(data, scene);
	data.metadata.babylonEditorSpriteShapeProfiles = structuredClone(scene.metadata?.babylonEditorSpriteShapeProfiles ?? []);
	data.metadata.babylonEditorNavAgents = structuredClone(scene.metadata?.babylonEditorNavAgents ?? []);
	data.metadata.babylonEditorNavCrowds = structuredClone(scene.metadata?.babylonEditorNavCrowds ?? []);
	configureVisualScriptingExportMetadata(data, scene);
	configureBehaviorGraphExportMetadata(data, scene);
	configureMlTrainingExportMetadata(data, scene);
	configureInputActionsExportMetadata(data, scene);
	configureTouchControlsExportMetadata(data, scene);
	data.metadata.babylonEditorAudioBuses = structuredClone(scene.metadata?.babylonEditorAudioBuses ?? []);
	data.metadata.babylonEditorAudioMixerSnapshots = structuredClone(scene.metadata?.babylonEditorAudioMixerSnapshots ?? []);
	data.metadata.babylonEditorAnimatorControllers = structuredClone(scene.metadata?.babylonEditorAnimatorControllers ?? []);
	data.metadata.babylonEditorRenderingProfiles = structuredClone(scene.metadata?.babylonEditorRenderingProfiles ?? []);
	data.metadata.babylonEditorRenderingVolumes = structuredClone(scene.metadata?.babylonEditorRenderingVolumes ?? []);
	data.metadata.babylonEditorCameraStacks = structuredClone(scene.metadata?.babylonEditorCameraStacks ?? []);
	data.metadata.babylonEditorActiveCameraStack = structuredClone(scene.metadata?.babylonEditorActiveCameraStack ?? null);
	data.metadata.babylonEditorRenderingLayers = structuredClone(scene.metadata?.babylonEditorRenderingLayers ?? []);
	data.metadata.babylonEditorRenderingGroups = structuredClone(scene.metadata?.babylonEditorRenderingGroups ?? []);
	data.metadata.babylonEditorRendererLists = structuredClone(scene.metadata?.babylonEditorRendererLists ?? []);
	data.metadata.babylonEditorVideoPlayers = structuredClone(scene.metadata?.babylonEditorVideoPlayers ?? []);
	data.metadata.babylonEditorXR = structuredClone(scene.metadata?.babylonEditorXR ?? { enabled: false, referenceSpaceType: "local-floor", floorMeshIds: [], features: [] });
	const localizationPath = join(projectDir, "localization.json");
	if (await pathExists(localizationPath)) {
		data.metadata.babylonEditorLocalization = await readJSON(localizationPath);
	}
	const exportedAddressables = await exportAddressables(projectDir, scenePath);
	if (exportedAddressables.catalog) {
		data.metadata.babylonEditorAddressables = exportedAddressables.catalog;
	}
	exportedAssets.push(...exportedAddressables.files);

	configureMaterials(data);
	configureMeshesLODs(data, scene);
	configureMeshesPhysics(data, scene);
	configureParticleSystems(data, scene);
	configureClusteredLights(data, clusteredLightContainer);

	// Configure environment texture
	if (isHDRCubeTexture(scene.environmentTexture)) {
		data.environmentTextureSize = 512;
		data.environmentTextureType = "BABYLON.HDRCubeTexture";
		data.environmentTextureRotationY = scene.environmentTexture.rotationY;
	} else if (isEXRCubeTexture(scene.environmentTexture)) {
		data.environmentTexture = `${scene.environmentTexture.name}.environment.hdr`;
		data.environmentTextureSize = 512;
		data.environmentTextureType = "BABYLON.HDRCubeTexture";
		data.environmentTextureRotationY = scene.environmentTexture.rotationY;
	}

	// Write all geometries as incremental. This makes the scene way less heavy as binary saved geometry
	// is not stored in the JSON scene file. Moreover, this may allow to load geometries on the fly compared
	// to single JSON file.
	await Promise.all(
		data.meshes?.map(async (mesh: any) => {
			if (mesh.renderOverlay) {
				mesh.renderOverlay = false;
			}

			if (mesh.overlayAlpha) {
				mesh.overlayAlpha = 1;
			}

			if (mesh.overlayColor) {
				mesh.overlayColor = [0, 0, 0];
			}

			const instantiatedMesh = scene.getMeshById(mesh.id);

			if (instantiatedMesh) {
				if (isMesh(instantiatedMesh)) {
					const collisionMesh = getCollisionMeshFor(instantiatedMesh);
					if (collisionMesh) {
						mesh.isPickable = false;
						mesh.checkCollisions = false;

						mesh.instances?.forEach((instance) => {
							instance.isPickable = false;
							instance.checkCollisions = false;
						});
					}
				}

				if (isCollisionMesh(instantiatedMesh)) {
					if (mesh.materialId) {
						const materialIndex = data.materials.findIndex((material: any) => {
							return material.id === mesh.materialId;
						});

						if (materialIndex !== -1) {
							data.materials.splice(materialIndex);
						}
					}

					mesh.checkCollisions = true;
					mesh.instances?.forEach((instance) => {
						instance.checkCollisions = true;
					});
				}
			}

			const geometry = data.geometries?.vertexData?.find((v) => v.id === mesh.geometryId);

			if (geometry) {
				const geometryFileName = `${mesh.id}.babylonbinarymeshdata`;

				mesh.delayLoadingFile = `${sceneName}/${geometryFileName}`;
				mesh.boundingBoxMaximum = instantiatedMesh?.getBoundingInfo()?.maximum?.asArray() ?? [0, 0, 0];
				mesh.boundingBoxMinimum = instantiatedMesh?.getBoundingInfo()?.minimum?.asArray() ?? [0, 0, 0];
				mesh._binaryInfo = {};

				const geometryPath = join(scenePath, sceneName, geometryFileName);

				try {
					const geometryToWrite = { ...geometry };
					if (instantiatedMesh && isMesh(instantiatedMesh)) {
						const manifest = getEditableMeshSourceManifest(instantiatedMesh);
						const generated = buildGeneratedEditableMeshGeometry(instantiatedMesh, manifest.exportSettings);
						if (!generated.evidence.portableBinaryOutput) {
							throw new Error(
								`Mesh "${instantiatedMesh.name}" has unsupported generated binary streams: ${generated.evidence.unsupportedSerializedStreams.join(", ")}.`
							);
						}
						applyGeneratedEditableMeshToSerializedData(mesh, geometryToWrite, generated);
						stripEditableSourceMetadataForRuntime(mesh, generated.evidence, manifest.revision, manifest.exportSettingsRevision);
					}
					let writeGeometry = false;
					if (!savedGeometryIds.includes(mesh.id)) {
						writeGeometry = true;
						savedGeometryIds.push(mesh.id);
					}

					await writeBinaryGeometry({
						mesh,
						geometry: geometryToWrite,
						sourceMesh: instantiatedMesh,
						path: geometryPath,
						write: writeGeometry,
					});
					const geometryBytes = await readFile(geometryPath);
					terrainStreamingArtifacts.push({
						terrainId: mesh.id,
						url: `${sceneName}/${geometryFileName}`,
						sha256: createHash("sha256").update(geometryBytes).digest("hex"),
						byteLength: geometryBytes.byteLength,
						binaryInfo: JSON.parse(JSON.stringify(mesh._binaryInfo)),
					});

					let geometryIndex = -1;
					do {
						geometryIndex = data.geometries!.vertexData!.findIndex((g) => g.id === mesh.geometryId);
						if (geometryIndex !== -1) {
							data.geometries!.vertexData!.splice(geometryIndex, 1);
						}
					} while (geometryIndex !== -1);

					savedGeometries.push(geometryFileName);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					editor.layout.console.error(`Export: Failed to write geometry for mesh ${mesh.name}: ${message}`);
					throw e;
				}
			}
		})
	);

	configureTerrainStreamingExport(data, terrainStreamingArtifacts);

	// Configure lights
	data.shadowGenerators?.forEach((shadowGenerator) => {
		const instantiatedLight = scene.getLightById(shadowGenerator.lightId);
		const instantiatedShadowGenerator = instantiatedLight?.getShadowGenerator();

		const light = data.lights?.find((light) => light.id === shadowGenerator.lightId);
		if (light && instantiatedShadowGenerator) {
			light.metadata ??= {};
			light.metadata.refreshRate = instantiatedShadowGenerator?.getShadowMap()?.refreshRate ?? RenderTargetTexture.REFRESHRATE_RENDER_ONEVERYFRAME;
		}
	});

	// Extract textures from particle systems.
	await Promise.all(
		data.particleSystems?.map(async (particleSystemData: any) => {
			const result = await extractParticleSystemTextures(editor, particleSystemData, {
				assetsDirectory: extractedTexturesOutputPath,
			});

			if (result) {
				exportedAssets.push(join(scenePath, result.relativePath));
			}
		})
	);

	// Extract textures from node materials.
	const nodeMaterials = data.materials?.filter((materialData) => {
		const existingMaterial = scene.getMaterialById(materialData.id);
		return existingMaterial && isNodeMaterial(existingMaterial);
	});

	if (nodeMaterials.length) {
		await Promise.all(
			nodeMaterials.map(async (materialData) => {
				const relativePaths = await extractNodeMaterialTextures(editor, {
					materialData,
					assetsDirectory: extractedTexturesOutputPath,
				});

				exportedAssets.push(...relativePaths.map((path) => join(scenePath, path)));
			})
		);
	}

	// Extract texture from node particle systems.
	const nodeParticleSystems = data.meshes?.filter((meshData) => {
		return meshData.isNodeParticleSystemMesh && meshData.nodeParticleSystemSet;
	});

	if (nodeParticleSystems.length) {
		await Promise.all(
			nodeParticleSystems.map(async (meshData) => {
				const relativePaths = await extractNodeParticleSystemSetTextures(editor, {
					assetsDirectory: extractedTexturesOutputPath,
					particlesData: meshData.nodeParticleSystemSet,
				});

				exportedAssets.push(...relativePaths.map((path) => join(scenePath, path)));
			})
		);
	}

	// Write final scene file.
	await writeJSON(join(scenePath, `${sceneName}.babylon`), data);

	// Clear old geometries
	const geometriesDir = join(scenePath, sceneName);
	const geometriesFiles = await readdir(geometriesDir);

	await Promise.all(
		geometriesFiles.map(async (file) => {
			if (!savedGeometries.includes(file)) {
				await remove(join(geometriesDir, file));
			}
		})
	);

	// Copy files
	const files = await normalizedGlob(join(projectDir, "/assets/**/*"), {
		nodir: true,
		ignore: {
			childrenIgnored: (p) => extname(p.name) === ".scene",
		},
	});

	// Export scripts
	await handleExportScripts(editor);

	// Export assets
	const promises: Promise<void>[] = [];
	const progressStep = 100 / files.length;

	let cache: Record<string, string> = {};
	try {
		cache = await readJSON(join(projectDir, "assets/.export-cache.json"));
	} catch (e) {
		// Catch silently.
	}

	for (const file of files) {
		if (promises.length >= 5) {
			await Promise.all(promises);
			promises.length = 0;
		}

		promises.push(
			processAssetFile(editor, file.toString(), {
				cache,
				scenePath,
				projectDir,
				exportedAssets,
				optimize: options.optimize,
				modelPlatform: options.modelPlatform,
				assetPlatform: options.assetPlatform ?? options.modelPlatform,
			}).then(() => onProgress(progressStep))
		);
	}

	await Promise.all(promises);

	await writeJSON(join(projectDir, "assets/.export-cache.json"), cache, {
		encoding: "utf-8",
		spaces: "\t",
	});

	if (options.optimize) {
		toast.success("Project exported");

		const publicFiles = await normalizedGlob(join(projectDir, "/public/scene/assets/**/*"), {
			nodir: true,
		});

		publicFiles.forEach((file) => {
			if (!exportedAssets.includes(file.toString())) {
				remove(file);
			}
		});
	}
}
