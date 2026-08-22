import { dirname, isAbsolute, join, relative } from "path/posix";

import { pathExists, remove } from "fs-extra";
import { PBRMaterial, Scene, Texture, Tools } from "babylonjs";
import {
	configureSubsurfaceScattering,
	diffusionProfileAssetExtension,
	diffusionProfilePreset,
	getSubsurfaceMaterialMetadata,
	getSubsurfaceMaskTexture,
	getSubsurfaceRuntime,
	getSubsurfaceRuntimeSettings,
	IDiffusionProfileAsset,
	ISubsurfaceMaterialMetadata,
	setSubsurfaceMaterialMetadata,
	setSubsurfaceMaskTexture,
	serializeSubsurfaceMaskTexture,
	subsurfaceMaterialMetadataKey,
	subsurfaceRuntimeSettingsMetadataKey,
	validateDiffusionProfileAsset,
	validateSubsurfaceRuntimeSettings,
} from "babylonjs-editor-tools";

import { normalizedGlob } from "../../tools/fs";
import { configureImportedTexture } from "../../editor/layout/preview/import/import";
import { getProjectAssetsRootUrl, projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";
import { ASSET_META_SUFFIX, refreshAssetRegistryPaths } from "../assets/registry";
import { getOrApplyTextureImporterArtifact, requiresDecodedTextureImporterArtifact } from "../assets/texture-importer";
import { resolveMaterial } from "../tools/resolve";
import {
	readBoundedRenderingAsset,
	renderingAssetHash,
	renderingAssetProjectDirectory,
	renderingAssetRelativePath,
	secureRenderingAssetPath,
	writeAtomicRenderingAsset,
} from "../rendering/rendering-asset-file";

const maximumAssetBytes = 64 * 1024;
const maximumListedAssets = 512;
const ownedSubsurfaceMaskTextures = new WeakSet<object>();

interface IReadProfileResult {
	asset: IDiffusionProfileAsset;
	absolutePath: string;
	relativePath: string;
	contentRevision: string;
}

function projectDirectory(): string {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	return dirname(projectConfiguration.path);
}

function configureSubsurfaceRuntime(scene: Scene): ReturnType<typeof configureSubsurfaceScattering> {
	return configureSubsurfaceScattering(scene as any, getProjectAssetsRootUrl() ?? "");
}

function summary(value: IReadProfileResult): any {
	return {
		path: value.relativePath,
		id: value.asset.id,
		name: value.asset.name,
		version: value.asset.version,
		assetRevision: value.asset.revision,
		contentRevision: value.contentRevision,
		scatteringDistance: [...value.asset.scatteringDistance],
		transmissionTint: [...value.asset.transmissionTint],
		thicknessRemap: [...value.asset.thicknessRemap],
		worldScale: value.asset.worldScale,
		indexOfRefraction: value.asset.indexOfRefraction,
	};
}

async function readProfile(path: unknown): Promise<IReadProfileResult> {
	const value = await readBoundedRenderingAsset(path, diffusionProfileAssetExtension, "Diffusion profile", maximumAssetBytes);
	const asset = validateDiffusionProfileAsset(value.source);
	return { asset, absolutePath: value.absolutePath, relativePath: value.relativePath, contentRevision: renderingAssetHash(asset) };
}

async function writeProfile(absolutePath: string, asset: IDiffusionProfileAsset): Promise<void> {
	await writeAtomicRenderingAsset(absolutePath, asset, maximumAssetBytes, (source) => validateDiffusionProfileAsset(source));
}

async function allProfiles(): Promise<IReadProfileResult[]> {
	const root = renderingAssetProjectDirectory();
	const paths = (await normalizedGlob(join(root, `**/*${diffusionProfileAssetExtension}`), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] })) as string[];
	const results: IReadProfileResult[] = [];
	for (const path of paths.sort().slice(0, maximumListedAssets)) {
		results.push(await readProfile(relative(root, path)));
	}
	return results;
}

function pbrMaterial(scene: Scene, materialId: string): PBRMaterial {
	const material = resolveMaterial({ scene, materialId });
	if (!(material instanceof PBRMaterial)) {
		throw new Error(`Material "${material.name}" (${material.getClassName()}) does not support Babylon's native subsurface-scattering pre-pass. Use a PBRMaterial.`);
	}
	return material;
}

function materialSummary(scene: Scene, material: PBRMaterial): any {
	const metadata = getSubsurfaceMaterialMetadata(material as any);
	const runtime = getSubsurfaceRuntime(scene as any);
	const runtimeMaterial = runtime.materials.find((entry) => entry.materialId === material.id) ?? null;
	const portableMetadata = metadata
		? {
				...structuredClone(metadata),
				subsurfaceMaskTexture: undefined,
				subsurfaceMaskTextureAssigned: Boolean(metadata.subsurfaceMaskTexture),
				subsurfaceMaskTexturePath: runtimeMaterial?.subsurfaceMaskTextureUrl ?? runtimeMaterial?.subsurfaceMaskTextureName ?? null,
			}
		: null;
	return {
		materialId: material.id,
		materialName: material.name,
		configured: Boolean(metadata),
		metadata: portableMetadata,
		native: {
			scatteringEnabled: material.subSurface.isScatteringEnabled,
			transmissionEnabled: material.subSurface.isTranslucencyEnabled,
			profileIndex: (material.subSurface as any)._scatteringDiffusionProfileIndex,
			minimumThickness: material.subSurface.minimumThickness,
			maximumThickness: material.subSurface.maximumThickness,
			thicknessTextureName: material.subSurface.thicknessTexture?.name ?? null,
			thicknessTextureReady: material.subSurface.thicknessTexture?.isReadyOrNotBlocking() ?? true,
			subsurfaceMaskTextureName: runtimeMaterial?.subsurfaceMaskTextureName ?? null,
			subsurfaceMaskTextureReady: runtimeMaterial?.subsurfaceMaskTextureReady ?? true,
			subsurfaceMaskChannel: "red",
		},
		runtime,
	};
}

async function loadThicknessTexture(scene: Scene, path: string): Promise<Texture> {
	const root = projectDirectory();
	const absolutePath = isAbsolute(path) ? path : join(root, path);
	if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
		throw new Error("Subsurface thickness texture must stay inside the open project.");
	}
	if (!(await pathExists(absolutePath))) {
		throw new Error(`Subsurface thickness texture does not exist: ${path}.`);
	}
	let runtimePath = absolutePath;
	if (requiresDecodedTextureImporterArtifact(absolutePath)) {
		const imported = await getOrApplyTextureImporterArtifact(absolutePath);
		runtimePath = imported.result!.outputPath;
	}
	const texture = configureImportedTexture(new Texture(runtimePath, scene, false, false));
	const authoredPath = relative(root, absolutePath).replace(/\\/g, "/");
	texture.name = authoredPath;
	texture.url = authoredPath;
	texture.metadata = { ...(texture.metadata ?? {}), babylonEditorAuthoredTexturePath: authoredPath };
	return texture;
}

async function loadSubsurfaceMaskTexture(scene: Scene, path: string): Promise<Texture> {
	const texture = await loadThicknessTexture(scene, path);
	if (texture.isCube) {
		texture.dispose();
		throw new Error("Subsurface mask texture must be a 2D texture.");
	}
	texture.gammaSpace = false;
	ownedSubsurfaceMaskTextures.add(texture);
	return texture;
}

/** Creates a reusable Unity-style diffusion-profile asset. */
export async function createDiffusionProfile(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const absolutePath = await secureRenderingAssetPath(data.path, diffusionProfileAssetExtension, "Diffusion profile");
	if (await pathExists(absolutePath)) {
		throw new Error(`Diffusion profile already exists at ${data.path}. Use set_diffusion_profile with its exact content revision.`);
	}
	const preset = diffusionProfilePreset(data.name);
	const asset = validateDiffusionProfileAsset({
		...preset,
		id: data.id ?? Tools.RandomId(),
		name: data.name,
		scatteringDistance: data.scatteringDistance ?? preset.scatteringDistance,
		transmissionTint: data.transmissionTint ?? preset.transmissionTint,
		thicknessRemap: data.thicknessRemap ?? preset.thicknessRemap,
		worldScale: data.worldScale ?? preset.worldScale,
		indexOfRefraction: data.indexOfRefraction ?? preset.indexOfRefraction,
	});
	await writeProfile(absolutePath, asset);
	await refreshAssetRegistryPaths([absolutePath]);
	options.editor.layout.assets.refresh();
	return summary(await readProfile(renderingAssetRelativePath(absolutePath)));
}

/** Pages all valid project diffusion-profile assets and bounded validation errors. */
export async function listDiffusionProfiles(_scene: Scene, data: any): Promise<any> {
	const root = renderingAssetProjectDirectory();
	const paths = (await normalizedGlob(join(root, `**/*${diffusionProfileAssetExtension}`), { nodir: true, ignore: ["**/node_modules/**", "**/.git/**"] })) as string[];
	const assets: any[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const search = data.search?.toLowerCase();
	for (const path of paths.sort().slice(0, maximumListedAssets)) {
		try {
			const value = await readProfile(relative(root, path));
			const item = summary(value);
			if (!search || item.name.toLowerCase().includes(search) || item.path.toLowerCase().includes(search)) {
				assets.push(item);
			}
		} catch (error) {
			if (errors.length < 32) {
				errors.push({ path: relative(root, path).replace(/\\/g, "/"), error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 64;
	return {
		profiles: assets.slice(offset, offset + limit),
		page: { total: assets.length, offset, count: Math.max(0, Math.min(limit, assets.length - offset)), hasMore: offset + limit < assets.length },
		errors,
		truncated: paths.length > maximumListedAssets,
	};
}

/** Reads one exact diffusion-profile file. */
export async function getDiffusionProfile(_scene: Scene, data: any): Promise<any> {
	const value = await readProfile(data.path);
	return { ...summary(value), asset: structuredClone(value.asset) };
}

/** Exact-content-revision replacement of one diffusion profile; live material references are refreshed atomically. */
export async function setDiffusionProfile(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readProfile(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Diffusion profile revision is stale. Expected ${value.contentRevision}.`);
	}
	const asset = validateDiffusionProfileAsset({
		...value.asset,
		name: data.name ?? value.asset.name,
		revision: value.asset.revision + 1,
		scatteringDistance: data.scatteringDistance ?? value.asset.scatteringDistance,
		transmissionTint: data.transmissionTint ?? value.asset.transmissionTint,
		thicknessRemap: data.thicknessRemap ?? value.asset.thicknessRemap,
		worldScale: data.worldScale ?? value.asset.worldScale,
		indexOfRefraction: data.indexOfRefraction ?? value.asset.indexOfRefraction,
	});
	const references = scene.materials
		.filter((material): material is PBRMaterial => material instanceof PBRMaterial)
		.map((material) => ({ material, metadata: getSubsurfaceMaterialMetadata(material as any) }))
		.filter(
			(entry): entry is { material: PBRMaterial; metadata: ISubsurfaceMaterialMetadata } =>
				entry.metadata?.profile.id === asset.id && entry.metadata.profile.path === value.relativePath
		);
	let updated: IReadProfileResult;
	let runtime: ReturnType<typeof configureSubsurfaceScattering>;
	await writeProfile(value.absolutePath, asset);
	try {
		updated = await readProfile(value.relativePath);
		for (const { material, metadata } of references) {
			setSubsurfaceMaterialMetadata(material as any, {
				...metadata,
				revision: metadata.revision + 1,
				profile: { ...asset, path: updated.relativePath, contentRevision: updated.contentRevision },
			});
		}
		runtime = configureSubsurfaceRuntime(scene);
		if (runtime.errors.length) {
			throw new Error(`Updated diffusion profile could not be activated: ${runtime.errors.join(" ")}`);
		}
	} catch (error) {
		let rollbackError: unknown;
		try {
			await writeProfile(value.absolutePath, value.asset);
			for (const { material, metadata } of references) {
				setSubsurfaceMaterialMetadata(material as any, metadata);
			}
			configureSubsurfaceRuntime(scene);
		} catch (candidate) {
			rollbackError = candidate;
		}
		if (rollbackError) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)} Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
			);
		}
		throw error;
	}
	await refreshAssetRegistryPaths([value.absolutePath]);
	options.editor.layout.assets.refresh();
	options.editor.layout.inspector.forceUpdate();
	return { ...summary(updated), runtime };
}

/** Confirmation-gated deletion that refuses any live material reference. */
export async function deleteDiffusionProfile(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const value = await readProfile(data.path);
	if (data.expectedRevision !== value.contentRevision) {
		throw new Error(`Diffusion profile revision is stale. Expected ${value.contentRevision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Deleting a diffusion profile requires confirm: true.");
	}
	const references = scene.materials.filter((material) => material instanceof PBRMaterial && getSubsurfaceMaterialMetadata(material as any)?.profile.id === value.asset.id);
	if (references.length) {
		throw new Error(`Diffusion profile is still referenced by ${references.length} material(s): ${references.map((material) => material.name).join(", ")}.`);
	}
	await remove(value.absolutePath);
	const sidecarPath = `${value.absolutePath}${ASSET_META_SUFFIX}`;
	await remove(sidecarPath);
	await refreshAssetRegistryPaths([value.absolutePath, sidecarPath]);
	options.editor.layout.assets.refresh();
	return { deleted: true, path: value.relativePath, id: value.asset.id, name: value.asset.name };
}

/** Reads the exact portable assignment plus native runtime evidence for one PBR material. */
export function getSubsurfaceMaterial(scene: Scene, data: any): any {
	return materialSummary(scene, pbrMaterial(scene, data.materialId));
}

/** Exact-revision assignment/update of one diffusion profile and Unity-style material controls. */
export async function setSubsurfaceMaterial(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const material = pbrMaterial(scene, data.materialId);
	const previous = getSubsurfaceMaterialMetadata(material as any);
	const expected = previous?.revision ?? 0;
	if (data.expectedRevision !== expected) {
		throw new Error(`Subsurface material revision is stale. Expected ${expected}.`);
	}
	const profile = data.profilePath ? await readProfile(data.profilePath) : null;
	if (!profile && !previous) {
		throw new Error("First subsurface assignment requires profilePath and its exact expectedProfileRevision.");
	}
	if (profile && data.expectedProfileRevision !== profile.contentRevision) {
		throw new Error(`Diffusion profile revision is stale. Expected ${profile.contentRevision}.`);
	}
	const previousTexture = material.subSurface.thicknessTexture;
	const previousMaskTexture = getSubsurfaceMaskTexture(material as any);
	let nextTexture = previousTexture;
	if (data.thicknessTexturePath === null) {
		nextTexture = null;
	} else if (typeof data.thicknessTexturePath === "string") {
		nextTexture = await loadThicknessTexture(scene, data.thicknessTexturePath);
	}
	let nextMaskTexture: any = previousMaskTexture;
	if (Object.prototype.hasOwnProperty.call(data, "_subsurfaceMaskTexture")) {
		if (data._subsurfaceMaskTexture !== null && (typeof data._subsurfaceMaskTexture !== "object" || typeof data._subsurfaceMaskTexture.isReadyOrNotBlocking !== "function")) {
			throw new Error("Internal subsurface mask assignment must provide a Babylon BaseTexture or null.");
		}
		nextMaskTexture = data._subsurfaceMaskTexture;
	} else if (data.subsurfaceMaskTexturePath === null) {
		nextMaskTexture = null;
	} else if (typeof data.subsurfaceMaskTexturePath === "string") {
		nextMaskTexture = await loadSubsurfaceMaskTexture(scene, data.subsurfaceMaskTexturePath);
	}
	const profileSnapshot = profile ? { ...profile.asset, path: profile.relativePath, contentRevision: profile.contentRevision } : previous!.profile;
	const candidate: ISubsurfaceMaterialMetadata = {
		version: 3,
		revision: expected + 1,
		mode: data.mode ?? previous?.mode ?? "subsurface-scattering",
		profile: profileSnapshot,
		subsurfaceMask: data.subsurfaceMask ?? previous?.subsurfaceMask ?? 1,
		subsurfaceMaskTexture: serializeSubsurfaceMaskTexture(nextMaskTexture),
		transmissionEnabled: data.transmissionEnabled ?? previous?.transmissionEnabled ?? true,
		transmissionIntensity: data.transmissionIntensity ?? previous?.transmissionIntensity ?? 1,
		thicknessMultiplier: data.thicknessMultiplier ?? previous?.thicknessMultiplier ?? 1,
		useThicknessTexture: data.useThicknessTexture ?? previous?.useThicknessTexture ?? Boolean(nextTexture),
		transportCaches: previous?.transportCaches ?? [],
	};
	setSubsurfaceMaterialMetadata(material as any, candidate);
	setSubsurfaceMaskTexture(material as any, nextMaskTexture);
	material.subSurface.thicknessTexture = nextTexture;
	const runtime = configureSubsurfaceRuntime(scene);
	if (runtime.errors.length) {
		setSubsurfaceMaterialMetadata(material as any, previous);
		setSubsurfaceMaskTexture(material as any, previousMaskTexture);
		material.subSurface.thicknessTexture = previousTexture;
		configureSubsurfaceRuntime(scene);
		nextTexture !== previousTexture && nextTexture?.dispose();
		if (nextMaskTexture !== previousMaskTexture && nextMaskTexture && ownedSubsurfaceMaskTextures.has(nextMaskTexture)) {
			ownedSubsurfaceMaskTextures.delete(nextMaskTexture);
			nextMaskTexture.dispose();
		}
		throw new Error(`Subsurface material could not be activated: ${runtime.errors.join(" ")}`);
	}
	if (previousMaskTexture !== nextMaskTexture && previousMaskTexture && ownedSubsurfaceMaskTextures.has(previousMaskTexture)) {
		ownedSubsurfaceMaskTextures.delete(previousMaskTexture);
		previousMaskTexture.dispose();
	}
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return materialSummary(scene, material);
}

/** Confirmation-gated exact-revision removal of one portable subsurface assignment. */
export function clearSubsurfaceMaterial(scene: Scene, data: any, options: IMCPActionOptions): any {
	const material = pbrMaterial(scene, data.materialId);
	const previous = getSubsurfaceMaterialMetadata(material as any);
	const previousMaskTexture = getSubsurfaceMaskTexture(material as any);
	if (!previous) {
		throw new Error("Material has no portable subsurface assignment.");
	}
	if (data.expectedRevision !== previous.revision) {
		throw new Error(`Subsurface material revision is stale. Expected ${previous.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Clearing a subsurface material requires confirm: true.");
	}
	if (previous.transportCaches.length) {
		throw new Error(`Material has ${previous.transportCaches.length} generated subsurface transport cache(s). Clear them explicitly before removing the material assignment.`);
	}
	setSubsurfaceMaterialMetadata(material as any, null);
	if (previousMaskTexture && ownedSubsurfaceMaskTextures.has(previousMaskTexture)) {
		ownedSubsurfaceMaskTextures.delete(previousMaskTexture);
		previousMaskTexture.dispose();
	}
	material.subSurface.isScatteringEnabled = false;
	material.subSurface.isTranslucencyEnabled = false;
	configureSubsurfaceRuntime(scene);
	options.editor.layout.inspector.setEditedObject(material);
	options.editor.layout.inspector.forceUpdate();
	return { materialId: material.id, materialName: material.name, cleared: true, runtime: getSubsurfaceRuntime(scene as any) };
}

/** Reads scene-wide native pre-pass policy and exact execution evidence. */
export function getSubsurfaceRuntimeState(scene: Scene): any {
	return {
		hasExplicitSettings: scene.metadata?.[subsurfaceRuntimeSettingsMetadataKey] !== undefined,
		settings: getSubsurfaceRuntimeSettings(scene as any),
		runtime: getSubsurfaceRuntime(scene as any),
	};
}

/** Exact-revision update of scene-wide quality, sample budget, scale, and enabled state. */
export function setSubsurfaceRuntimeState(scene: Scene, data: any, options: IMCPActionOptions): any {
	const hadPrevious = scene.metadata?.[subsurfaceRuntimeSettingsMetadataKey] !== undefined;
	const previous = getSubsurfaceRuntimeSettings(scene as any);
	if (data.expectedRevision !== previous.revision) {
		throw new Error(`Subsurface runtime revision is stale. Expected ${previous.revision}.`);
	}
	const quality = data.quality ?? previous.quality;
	const qualityBudget = quality === "low" ? 24 : quality === "medium" ? 40 : quality === "high" ? 64 : (data.sampleBudget ?? previous.sampleBudget);
	const candidate = validateSubsurfaceRuntimeSettings({
		...previous,
		version: 2,
		revision: previous.revision + 1,
		enabled: data.enabled ?? previous.enabled,
		quality,
		sampleBudget: data.sampleBudget ?? qualityBudget,
		metersPerUnit: data.metersPerUnit ?? previous.metersPerUnit,
		transportMode: data.transportMode ?? previous.transportMode,
		transportIntensity: data.transportIntensity ?? previous.transportIntensity,
	});
	scene.metadata ??= {};
	scene.metadata[subsurfaceRuntimeSettingsMetadataKey] = candidate;
	const runtime = configureSubsurfaceRuntime(scene);
	if (runtime.errors.length) {
		if (hadPrevious) {
			scene.metadata[subsurfaceRuntimeSettingsMetadataKey] = previous;
		} else {
			delete scene.metadata[subsurfaceRuntimeSettingsMetadataKey];
		}
		configureSubsurfaceRuntime(scene);
		throw new Error(`Subsurface runtime settings could not be activated: ${runtime.errors.join(" ")}`);
	}
	options.editor.layout.inspector.forceUpdate();
	return { settings: candidate, runtime };
}

/** Confirmation-gated removal of an explicit scene policy, restoring portable defaults. */
export function clearSubsurfaceRuntimeState(scene: Scene, data: any, options: IMCPActionOptions): any {
	const source = scene.metadata?.[subsurfaceRuntimeSettingsMetadataKey];
	if (source === undefined) {
		throw new Error("Scene has no explicit subsurface runtime settings to clear.");
	}
	const previous = getSubsurfaceRuntimeSettings(scene as any);
	if (data.expectedRevision !== previous.revision) {
		throw new Error(`Subsurface runtime revision is stale. Expected ${previous.revision}.`);
	}
	if (data.confirm !== true) {
		throw new Error("Clearing subsurface runtime settings requires confirm: true.");
	}
	delete scene.metadata[subsurfaceRuntimeSettingsMetadataKey];
	const runtime = configureSubsurfaceRuntime(scene);
	if (runtime.errors.length) {
		scene.metadata[subsurfaceRuntimeSettingsMetadataKey] = previous;
		configureSubsurfaceRuntime(scene);
		throw new Error(`Default subsurface runtime settings could not be restored: ${runtime.errors.join(" ")}`);
	}
	options.editor.layout.inspector.forceUpdate();
	return { cleared: true, hasExplicitSettings: false, settings: getSubsurfaceRuntimeSettings(scene as any), runtime };
}

/** Refreshes live material snapshots after an external profile-file edit. */
export async function refreshSubsurfaceProfileAssignments(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const profile = await readProfile(data.path);
	if (data.expectedRevision !== profile.contentRevision) {
		throw new Error(`Diffusion profile revision is stale. Expected ${profile.contentRevision}.`);
	}
	const references: Array<{ material: PBRMaterial; metadata: ISubsurfaceMaterialMetadata }> = [];
	for (const material of scene.materials) {
		if (!(material instanceof PBRMaterial)) {
			continue;
		}
		const metadata = getSubsurfaceMaterialMetadata(material as any);
		if (metadata?.profile.id === profile.asset.id && metadata.profile.path === profile.relativePath && metadata.profile.contentRevision !== profile.contentRevision) {
			references.push({ material, metadata });
			setSubsurfaceMaterialMetadata(material as any, {
				...metadata,
				revision: metadata.revision + 1,
				profile: { ...profile.asset, path: profile.relativePath, contentRevision: profile.contentRevision },
			});
		}
	}
	const runtime = configureSubsurfaceRuntime(scene);
	if (runtime.errors.length) {
		for (const { material, metadata } of references) {
			setSubsurfaceMaterialMetadata(material as any, metadata);
		}
		configureSubsurfaceRuntime(scene);
		throw new Error(`Diffusion profile assignments could not be refreshed: ${runtime.errors.join(" ")}`);
	}
	options.editor.layout.inspector.forceUpdate();
	return { refreshed: references.length, profile: summary(profile), runtime };
}

export function isPortableSubsurfaceMaterial(material: PBRMaterial): boolean {
	return Boolean(material.metadata?.[subsurfaceMaterialMetadataKey]);
}

export async function listDiffusionProfileAssetsForInspector(): Promise<any[]> {
	return (await allProfiles()).map(summary);
}
