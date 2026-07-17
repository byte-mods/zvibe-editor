import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";

import { autoMapHumanoidBones, HumanBone, IHumanoidAvatarValidation, validateHumanoidAvatar } from "./humanoid-avatar";
import {
	executeModelAnimationClipDefinitions,
	IModelAnimationClipDefinition,
	IModelAnimationClipResult,
	IModelAnimationSourceGroupResult,
	normalizeModelAnimationClipDefinitions,
} from "./model-animation-clips";
import { IModelMaterialRemapDefinition, IModelMaterialRemapResult, IModelSourceMaterialResult, normalizeModelMaterialRemaps } from "./model-material-remaps";
import { IModelMaterialSearchResult, ModelMaterialNaming, ModelMaterialSearch } from "./model-material-search";
import {
	applyModelAuthoredLodGroups,
	getModelLodDeformationMode,
	getModelLodSkinInfluenceStreams,
	IModelAuthoredLodGroupDefinition,
	IModelAuthoredLodGroupResult,
	IModelGeneratedLodMeshResult,
	IModelLodDefinition,
	normalizeModelAuthoredLodGroups,
	normalizeModelLodDefinitions,
	simplifyModelMeshPreservingDeformation,
} from "./model-lods";
import { IModelImporterPlatformOverrides, ModelImporterPlatform, normalizeModelImporterPlatformOverrides } from "./model-platform-overrides";
import { executeModelRigOptimization, IModelRigOptimizationResult, normalizeModelExposedTransforms } from "./model-rig-optimizer";

export interface IModelImporterSettings {
	scaleFactor: number;
	convertUnits: boolean;
	importMaterials: boolean;
	materialNaming: ModelMaterialNaming;
	materialSearch: ModelMaterialSearch;
	materialRemaps: IModelMaterialRemapDefinition[];
	authoredLods: IModelAuthoredLodGroupDefinition[];
	generatedLods: IModelLodDefinition[];
	platformOverrides: IModelImporterPlatformOverrides;
	importTextures: boolean;
	importAnimations: boolean;
	animationClips: IModelAnimationClipDefinition[];
	animationType: "none" | "generic" | "humanoid";
	optimizeGameObjects: boolean;
	exposedTransforms: string[];
	generateColliders: boolean;
	meshCompression: "none" | "low" | "medium" | "high";
	optimizeMesh: boolean;
	weldVertices: boolean;
	normals: "import" | "calculate" | "none";
	tangents: "import" | "calculate" | "none";
}

export interface IModelImporterSceneEntries {
	meshes: any[];
	transformNodes?: any[];
	materials?: any[];
	multiMaterials?: any[];
	materialRemapMaterials?: Record<string, any>;
	materialSearch?: IModelMaterialSearchResult;
	textures?: any[];
	animationGroups?: any[];
	skeletonCount?: number;
	skeletons?: any[];
}

export interface IModelImporterRigResult {
	animationType: IModelImporterSettings["animationType"];
	skeletonName: string | null;
	boneCount: number;
	mapping: Partial<Record<HumanBone, string>>;
	validation: IHumanoidAvatarValidation | null;
}

export interface IModelImporterMeshResult {
	name: string;
	vertexCount: number;
	indexCount: number;
	triangleCount: number;
	hasNormals: boolean;
	hasTangents: boolean;
	hasUVs: boolean;
	skinned: boolean;
	morphTargetCount: number;
	collider: boolean;
	welded: boolean;
	optimized: boolean;
	quantized: boolean;
}

export interface IExecutedModelImport {
	settings: IModelImporterSettings;
	unitScale: number;
	meshes: IModelImporterMeshResult[];
	meshCount: number;
	vertexCount: number;
	indexCount: number;
	triangleCount: number;
	materialCount: number;
	sourceMaterials: IModelSourceMaterialResult[];
	materialRemaps: IModelMaterialRemapResult[];
	remappedMaterialCount: number;
	remappedMeshCount: number;
	missingMaterialRemapCount: number;
	materialSearch: IModelMaterialSearchResult;
	authoredLods: IModelAuthoredLodGroupResult[];
	authoredLodSourceMeshCount: number;
	authoredLodMeshCount: number;
	generatedLods: IModelGeneratedLodMeshResult[];
	lodSourceMeshCount: number;
	generatedLodMeshCount: number;
	skippedLodMeshCount: number;
	textureCount: number;
	animationGroupCount: number;
	sourceAnimationGroups: IModelAnimationSourceGroupResult[];
	animationClips: IModelAnimationClipResult[];
	skeletonCount: number;
	rig: IModelImporterRigResult;
	rigOptimization: IModelRigOptimizationResult;
	colliderCount: number;
	weldedMeshCount: number;
	optimizedMeshCount: number;
	quantizedMeshCount: number;
	calculatedNormalMeshCount: number;
	calculatedTangentMeshCount: number;
	removedMaterialCount: number;
	removedTextureCount: number;
	removedAnimationGroupCount: number;
	replacedAnimationGroupCount: number;
	errors: string[];
	warnings: string[];
}

export interface IModelImporterResult extends IExecutedModelImport {
	baseSettings: IModelImporterSettings;
	platform: ModelImporterPlatform;
	platformOverrideApplied: boolean;
	sourcePath: string;
	outputPath: string | null;
	sourceFormat: string;
	sourceBytes: number;
	supported: boolean;
	embeddedResourceCount: number;
	dependencyPaths: string[];
	legacyConversion: {
		engine: "assimp";
		inputFileCount: number;
		inputBytes: number;
		outputBytes: number;
	} | null;
	valid: boolean;
}

const MAX_REPORTED_MESHES = 500;
const MAX_GENERATED_LOD_MESHES = 512;
const MAX_LOD_SOURCE_TRIANGLES = 1_000_000;

export function normalizeModelImporterSettings(settings: Record<string, unknown>): IModelImporterSettings {
	const scaleFactor = typeof settings.scaleFactor === "number" && Number.isFinite(settings.scaleFactor) ? settings.scaleFactor : 1;
	return {
		scaleFactor: Math.min(100000, Math.max(0.0001, scaleFactor)),
		convertUnits: settings.convertUnits !== false,
		importMaterials: settings.importMaterials !== false,
		materialNaming: settings.materialNaming === "baseTextureName" || settings.materialNaming === "modelAndMaterial" ? settings.materialNaming : "sourceMaterial",
		materialSearch:
			settings.materialSearch === "local" || settings.materialSearch === "recursiveUp" || settings.materialSearch === "projectWide" ? settings.materialSearch : "none",
		materialRemaps: normalizeModelMaterialRemaps(settings.materialRemaps),
		authoredLods: normalizeModelAuthoredLodGroups(settings.authoredLods),
		generatedLods: normalizeModelLodDefinitions(settings.generatedLods),
		platformOverrides: normalizeModelImporterPlatformOverrides(settings.platformOverrides),
		importTextures: settings.importTextures !== false,
		importAnimations: settings.importAnimations !== false,
		animationClips: normalizeModelAnimationClipDefinitions(settings.animationClips),
		animationType: settings.animationType === "none" || settings.animationType === "humanoid" ? settings.animationType : "generic",
		optimizeGameObjects: settings.optimizeGameObjects === true,
		exposedTransforms: normalizeModelExposedTransforms(settings.exposedTransforms),
		generateColliders: settings.generateColliders === true,
		meshCompression: settings.meshCompression === "low" || settings.meshCompression === "medium" || settings.meshCompression === "high" ? settings.meshCompression : "none",
		optimizeMesh: settings.optimizeMesh !== false,
		weldVertices: settings.weldVertices !== false,
		normals: settings.normals === "calculate" || settings.normals === "none" ? settings.normals : "import",
		tangents: settings.tangents === "calculate" || settings.tangents === "none" ? settings.tangents : "import",
	};
}

export function emptyExecutedModelImport(settings: IModelImporterSettings, errors: string[] = [], warnings: string[] = []): IExecutedModelImport {
	return {
		settings,
		unitScale: settings.scaleFactor * (settings.convertUnits ? 100 : 1),
		meshes: [],
		meshCount: 0,
		vertexCount: 0,
		indexCount: 0,
		triangleCount: 0,
		materialCount: 0,
		sourceMaterials: [],
		materialRemaps: [],
		remappedMaterialCount: 0,
		remappedMeshCount: 0,
		missingMaterialRemapCount: settings.materialRemaps.length,
		materialSearch: { naming: settings.materialNaming, search: settings.materialSearch, searchedMaterialCount: 0, matches: [] },
		authoredLods: [],
		authoredLodSourceMeshCount: 0,
		authoredLodMeshCount: 0,
		generatedLods: [],
		lodSourceMeshCount: 0,
		generatedLodMeshCount: 0,
		skippedLodMeshCount: 0,
		textureCount: 0,
		animationGroupCount: 0,
		sourceAnimationGroups: [],
		animationClips: [],
		skeletonCount: 0,
		rig: { animationType: settings.animationType, skeletonName: null, boneCount: 0, mapping: {}, validation: null },
		rigOptimization: executeModelRigOptimization(
			{},
			{ optimizeGameObjects: settings.optimizeGameObjects, animationType: settings.animationType, exposedTransforms: settings.exposedTransforms }
		),
		colliderCount: 0,
		weldedMeshCount: 0,
		optimizedMeshCount: 0,
		quantizedMeshCount: 0,
		calculatedNormalMeshCount: 0,
		calculatedTangentMeshCount: 0,
		removedMaterialCount: 0,
		removedTextureCount: 0,
		removedAnimationGroupCount: 0,
		replacedAnimationGroupCount: 0,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
}

function detachTexture(material: any, texture: any): boolean {
	let detached = false;
	for (const key of Object.keys(material)) {
		if ((material as Record<string, unknown>)[key] === texture) {
			(material as Record<string, unknown>)[key] = null;
			detached = true;
		}
	}
	return detached;
}

function leafMaterials(material: any): any[] {
	if (!material) {
		return [];
	}
	return Array.isArray(material.subMaterials) ? material.subMaterials.filter(Boolean) : [material];
}

function countMeshMaterialReferences(meshes: any[], material: any): number {
	return meshes.reduce((count, mesh) => count + leafMaterials(mesh.material).filter((candidate) => candidate === material).length, 0);
}

function replaceMeshMaterialReferences(meshes: any[], sources: Set<any>, replacement: any): { meshCount: number; referenceCount: number } {
	let referenceCount = 0;
	const changedMeshes = new Set<any>();
	for (const mesh of meshes) {
		if (sources.has(mesh.material)) {
			mesh.material = replacement;
			referenceCount++;
			changedMeshes.add(mesh);
			continue;
		}
		if (!Array.isArray(mesh.material?.subMaterials)) {
			continue;
		}
		mesh.material.subMaterials = mesh.material.subMaterials.map((candidate: any) => {
			if (!sources.has(candidate)) {
				return candidate;
			}
			referenceCount++;
			changedMeshes.add(mesh);
			return replacement;
		});
	}
	return { meshCount: changedMeshes.size, referenceCount };
}

function calculateTangents(positions: number[], normals: number[], uvs: number[], indices: number[]): number[] {
	const vertexCount = positions.length / 3;
	const tan1 = new Float64Array(vertexCount * 3);
	const tan2 = new Float64Array(vertexCount * 3);
	for (let offset = 0; offset + 2 < indices.length; offset += 3) {
		const i1 = indices[offset];
		const i2 = indices[offset + 1];
		const i3 = indices[offset + 2];
		if (i1 >= vertexCount || i2 >= vertexCount || i3 >= vertexCount) {
			continue;
		}
		const x1 = positions[i2 * 3] - positions[i1 * 3];
		const x2 = positions[i3 * 3] - positions[i1 * 3];
		const y1 = positions[i2 * 3 + 1] - positions[i1 * 3 + 1];
		const y2 = positions[i3 * 3 + 1] - positions[i1 * 3 + 1];
		const z1 = positions[i2 * 3 + 2] - positions[i1 * 3 + 2];
		const z2 = positions[i3 * 3 + 2] - positions[i1 * 3 + 2];
		const s1 = uvs[i2 * 2] - uvs[i1 * 2];
		const s2 = uvs[i3 * 2] - uvs[i1 * 2];
		const t1 = uvs[i2 * 2 + 1] - uvs[i1 * 2 + 1];
		const t2 = uvs[i3 * 2 + 1] - uvs[i1 * 2 + 1];
		const denominator = s1 * t2 - s2 * t1;
		if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) {
			continue;
		}
		const reciprocal = 1 / denominator;
		const sx = (t2 * x1 - t1 * x2) * reciprocal;
		const sy = (t2 * y1 - t1 * y2) * reciprocal;
		const sz = (t2 * z1 - t1 * z2) * reciprocal;
		const tx = (s1 * x2 - s2 * x1) * reciprocal;
		const ty = (s1 * y2 - s2 * y1) * reciprocal;
		const tz = (s1 * z2 - s2 * z1) * reciprocal;
		for (const index of [i1, i2, i3]) {
			tan1[index * 3] += sx;
			tan1[index * 3 + 1] += sy;
			tan1[index * 3 + 2] += sz;
			tan2[index * 3] += tx;
			tan2[index * 3 + 1] += ty;
			tan2[index * 3 + 2] += tz;
		}
	}
	const tangents = new Array<number>(vertexCount * 4);
	for (let index = 0; index < vertexCount; index++) {
		const nx = normals[index * 3];
		const ny = normals[index * 3 + 1];
		const nz = normals[index * 3 + 2];
		const tx = tan1[index * 3];
		const ty = tan1[index * 3 + 1];
		const tz = tan1[index * 3 + 2];
		const dot = nx * tx + ny * ty + nz * tz;
		let ox = tx - nx * dot;
		let oy = ty - ny * dot;
		let oz = tz - nz * dot;
		const length = Math.hypot(ox, oy, oz);
		if (length > 1e-12) {
			ox /= length;
			oy /= length;
			oz /= length;
		} else {
			ox = 1;
			oy = 0;
			oz = 0;
		}
		const crossX = ny * oz - nz * oy;
		const crossY = nz * ox - nx * oz;
		const crossZ = nx * oy - ny * ox;
		const handedness = crossX * tan2[index * 3] + crossY * tan2[index * 3 + 1] + crossZ * tan2[index * 3 + 2] < 0 ? -1 : 1;
		tangents[index * 4] = ox;
		tangents[index * 4 + 1] = oy;
		tangents[index * 4 + 2] = oz;
		tangents[index * 4 + 3] = handedness;
	}
	return tangents;
}

function quantize(values: number[], stride: number, bits: number): number[] {
	const levels = 2 ** bits - 1;
	const minima = new Array<number>(stride).fill(Number.POSITIVE_INFINITY);
	const maxima = new Array<number>(stride).fill(Number.NEGATIVE_INFINITY);
	for (let index = 0; index < values.length; index++) {
		const component = index % stride;
		minima[component] = Math.min(minima[component], values[index]);
		maxima[component] = Math.max(maxima[component], values[index]);
	}
	return values.map((value, index) => {
		const component = index % stride;
		const range = maxima[component] - minima[component];
		if (!Number.isFinite(range) || range <= 1e-12) {
			return value;
		}
		return minima[component] + (Math.round(((value - minima[component]) / range) * levels) / levels) * range;
	});
}

function meshData(mesh: any, kind: string): number[] {
	return Array.from(mesh.getVerticesData(kind, false) ?? []);
}

function compressionBits(level: IModelImporterSettings["meshCompression"]): number | null {
	if (level === "low") {
		return 16;
	}
	if (level === "medium") {
		return 14;
	}
	if (level === "high") {
		return 12;
	}
	return null;
}

/** Applies the executed Model Importer contract to one isolated imported model result. */
export async function executeModelImporterEntries(entries: IModelImporterSceneEntries, settings: IModelImporterSettings): Promise<IExecutedModelImport> {
	const errors: string[] = [];
	const warnings: string[] = [];
	const meshes = entries.meshes.filter(
		(mesh) => !!mesh?.geometry && typeof mesh.getVerticesData === "function" && typeof mesh.getIndices === "function" && typeof mesh.getTotalVertices === "function"
	);
	if (meshes.length > MAX_REPORTED_MESHES) {
		errors.push(`Model import reports are limited to ${MAX_REPORTED_MESHES} geometry meshes.`);
	}
	const multiMaterials = [...new Set(entries.multiMaterials ?? meshes.map((mesh) => mesh.material).filter((material) => Array.isArray(material?.subMaterials)))];
	const materials = [
		...new Set([...(entries.materials ?? meshes.flatMap((mesh) => leafMaterials(mesh.material))), ...multiMaterials.flatMap((material) => leafMaterials(material))]),
	].filter((material) => material && typeof material.getActiveTextures === "function");
	const textures = [...new Set(entries.textures ?? materials.flatMap((material) => material.getActiveTextures()))];
	const animationGroups = entries.animationGroups ?? [];
	const sourceMaterialCount = materials.length;
	const sourceTextureCount = textures.length;
	const skeleton = entries.skeletons?.[0];
	const bones = (skeleton?.bones ?? []).map((bone: any) => ({ name: String(bone.name), parentName: bone.getParent?.()?.name ?? null }));
	const mapping = settings.animationType === "humanoid" ? autoMapHumanoidBones(bones) : {};
	const rigValidation = settings.animationType === "humanoid" ? validateHumanoidAvatar(settings.animationType, mapping, bones) : null;
	if (settings.animationType === "humanoid" && !skeleton) {
		errors.push("Humanoid rig import requires at least one skeleton.");
	}
	if (rigValidation && !rigValidation.valid) {
		errors.push(...rigValidation.errors.map((message) => `Humanoid Avatar: ${message}`));
	}
	const roots = [...entries.meshes, ...(entries.transformNodes ?? [])].filter((node, index, all) => node.parent === null && all.indexOf(node) === index);
	const unitScale = settings.scaleFactor * (settings.convertUnits ? 100 : 1);
	for (const root of roots) {
		root.scaling.scaleInPlace(unitScale);
	}

	const sourceMaterials: IModelSourceMaterialResult[] = [...new Set(materials.map((material) => String(material.name ?? "")))]
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right))
		.map((name) => {
			const matching = materials.filter((material) => material.name === name);
			const definition = settings.materialRemaps.find((candidate) => candidate.sourceMaterial === name);
			return {
				name,
				materialObjectCount: matching.length,
				meshReferenceCount: matching.reduce((count, material) => count + countMeshMaterialReferences(meshes, material), 0),
				textureCount: new Set(matching.flatMap((material) => material.getActiveTextures())).size,
				remapPath: definition?.materialPath ?? null,
				remapped: false,
			};
		});
	const materialRemaps: IModelMaterialRemapResult[] = [];
	let remappedMaterialCount = 0;
	const remappedMeshes = new Set<any>();
	let missingMaterialRemapCount = 0;
	if (!settings.importMaterials && settings.materialRemaps.length) {
		warnings.push("Material remaps are ignored because Import Materials is disabled.");
	}
	if (settings.importMaterials) {
		for (const definition of settings.materialRemaps) {
			const matching = materials.filter((material) => material.name === definition.sourceMaterial);
			const replacement = entries.materialRemapMaterials?.[definition.materialPath] ?? null;
			let meshReferenceCount = 0;
			if (!matching.length) {
				warnings.push(`Material remap source "${definition.sourceMaterial}" does not exist in the imported model.`);
				missingMaterialRemapCount++;
			} else if (!replacement) {
				errors.push(`Material remap "${definition.sourceMaterial}" could not load project material "${definition.materialPath}".`);
				missingMaterialRemapCount++;
			} else {
				const changed = replaceMeshMaterialReferences(meshes, new Set(matching), replacement);
				meshReferenceCount = changed.referenceCount;
				for (const mesh of meshes) {
					if (leafMaterials(mesh.material).includes(replacement)) {
						remappedMeshes.add(mesh);
					}
				}
				remappedMaterialCount += matching.length;
				const sourceResult = sourceMaterials.find((candidate) => candidate.name === definition.sourceMaterial);
				if (sourceResult) {
					sourceResult.remapped = true;
				}
			}
			materialRemaps.push({
				...definition,
				matched: matching.length > 0 && replacement !== null,
				materialObjectCount: matching.length,
				meshReferenceCount,
				replacementMaterialName: replacement?.name ?? null,
			});
		}
	}

	let removedTextureCount = 0;
	if (!settings.importTextures || !settings.importMaterials) {
		for (const texture of textures) {
			if (materials.some((material) => detachTexture(material, texture))) {
				removedTextureCount++;
			}
		}
	}
	let removedMaterialCount = 0;
	if (!settings.importMaterials) {
		for (const mesh of meshes) {
			if (mesh.material) {
				mesh.material = null;
				removedMaterialCount++;
			}
		}
	}
	let removedAnimationGroupCount = 0;
	let replacedAnimationGroupCount = 0;
	let activeAnimationGroups = animationGroups;
	let sourceAnimationGroups: IModelAnimationSourceGroupResult[] = [];
	let animationClips: IModelAnimationClipResult[] = [];
	if (!settings.importAnimations) {
		sourceAnimationGroups = executeModelAnimationClipDefinitions(animationGroups, []).sourceGroups;
		for (const group of animationGroups.slice()) {
			group.dispose();
			removedAnimationGroupCount++;
		}
		activeAnimationGroups = [];
		for (const node of [...entries.meshes, ...(entries.transformNodes ?? [])]) {
			node.animations = [];
		}
	} else {
		const clipExecution = executeModelAnimationClipDefinitions(animationGroups, settings.animationClips);
		sourceAnimationGroups = clipExecution.sourceGroups;
		animationClips = clipExecution.clips;
		replacedAnimationGroupCount = clipExecution.replacedAnimationGroupCount;
		errors.push(...clipExecution.errors);
		warnings.push(...clipExecution.warnings);
		activeAnimationGroups = clipExecution.animationGroups;
	}
	const rigOptimization = executeModelRigOptimization(
		{ transformNodes: entries.transformNodes, animationGroups: activeAnimationGroups, skeletons: entries.skeletons },
		{ optimizeGameObjects: settings.optimizeGameObjects, animationType: settings.animationType, exposedTransforms: settings.exposedTransforms }
	);
	warnings.push(...rigOptimization.warnings);

	const bits = compressionBits(settings.meshCompression);
	let weldedMeshCount = 0;
	let optimizedMeshCount = 0;
	let quantizedMeshCount = 0;
	let calculatedNormalMeshCount = 0;
	let calculatedTangentMeshCount = 0;
	const results: IModelImporterMeshResult[] = [];
	for (const mesh of meshes) {
		let welded = false;
		let optimized = false;
		let quantized = false;
		const morphTargetCount = mesh.morphTargetManager?.numTargets ?? 0;
		const skinned = !!mesh.skeleton;
		if (settings.weldVertices) {
			if (skinned || morphTargetCount) {
				warnings.push(`Mesh "${mesh.name}" retained source vertices because welding skinned or morph-target geometry can change deformation.`);
			} else {
				try {
					mesh.forceSharedVertices();
					welded = true;
					weldedMeshCount++;
				} catch (error) {
					errors.push(`Mesh "${mesh.name}" vertex welding failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		if (settings.optimizeMesh) {
			try {
				await mesh.optimizeIndicesAsync();
				optimized = true;
				optimizedMeshCount++;
			} catch (error) {
				errors.push(`Mesh "${mesh.name}" index optimization failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const positions = meshData(mesh, VertexBuffer.PositionKind);
		const indices = Array.from(mesh.getIndices() ?? []) as number[];
		if (settings.normals === "none") {
			mesh.removeVerticesData(VertexBuffer.NormalKind);
		} else if (settings.normals === "calculate" && positions.length && indices.length) {
			const normals: number[] = [];
			VertexData.ComputeNormals(positions, indices, normals);
			mesh.setVerticesData(VertexBuffer.NormalKind, normals, false);
			calculatedNormalMeshCount++;
		}
		if (settings.tangents === "none") {
			mesh.removeVerticesData(VertexBuffer.TangentKind);
		} else if (settings.tangents === "calculate") {
			const normals = meshData(mesh, VertexBuffer.NormalKind);
			const uvs = meshData(mesh, VertexBuffer.UVKind);
			if (positions.length && indices.length && normals.length === positions.length && uvs.length === (positions.length / 3) * 2) {
				mesh.setVerticesData(VertexBuffer.TangentKind, calculateTangents(positions, normals, uvs, indices), false);
				calculatedTangentMeshCount++;
			} else {
				warnings.push(`Mesh "${mesh.name}" tangents require indexed positions, normals, and UV0; the tangent request was skipped.`);
			}
		}
		if (bits) {
			for (const [kind, stride] of [
				[VertexBuffer.PositionKind, 3],
				[VertexBuffer.NormalKind, 3],
				[VertexBuffer.TangentKind, 4],
				[VertexBuffer.UVKind, 2],
				[VertexBuffer.UV2Kind, 2],
			] as Array<[string, number]>) {
				const values = meshData(mesh, kind);
				if (values.length) {
					mesh.setVerticesData(kind, quantize(values, stride, bits), false);
				}
			}
			quantized = true;
			quantizedMeshCount++;
		}
		mesh.checkCollisions = settings.generateColliders;
		const vertexCount = mesh.getTotalVertices();
		const indexCount = mesh.getTotalIndices();
		if (results.length < MAX_REPORTED_MESHES) {
			results.push({
				name: mesh.name,
				vertexCount,
				indexCount,
				triangleCount: Math.floor(indexCount / 3),
				hasNormals: mesh.isVerticesDataPresent(VertexBuffer.NormalKind),
				hasTangents: mesh.isVerticesDataPresent(VertexBuffer.TangentKind),
				hasUVs: mesh.isVerticesDataPresent(VertexBuffer.UVKind),
				skinned,
				morphTargetCount,
				collider: mesh.checkCollisions,
				welded,
				optimized,
				quantized,
			});
		}
	}
	let authoredLods: IModelAuthoredLodGroupResult[] = [];
	let authoredLodLevelMeshes = new Set<any>();
	let authoredLodFailed = false;
	if (settings.authoredLods.length) {
		try {
			const application = applyModelAuthoredLodGroups(meshes, settings.authoredLods);
			authoredLods = application.groups;
			authoredLodLevelMeshes = application.levelMeshes;
		} catch (error) {
			authoredLodFailed = true;
			errors.push(`Authored LOD processing failed atomically: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	for (let index = 0; index < Math.min(meshes.length, results.length); index++) {
		if (authoredLodLevelMeshes.has(meshes[index])) {
			results[index].collider = false;
		}
	}
	let generatedLods: IModelGeneratedLodMeshResult[] = [];
	let skippedLodMeshCount = 0;
	if (settings.generatedLods.length && authoredLodFailed) {
		warnings.push("Generated LOD processing was skipped because authored LOD validation failed.");
	} else if (settings.generatedLods.length) {
		const eligible = meshes.filter((mesh) => {
			const reason = authoredLodLevelMeshes.has(mesh)
				? "is assigned as an authored LOD level"
				: typeof mesh.getLODLevels === "function" && mesh.getLODLevels().length
					? "already has authored LOD levels"
					: null;
			if (!reason) {
				return true;
			}
			warnings.push(`Mesh "${mesh.name}" skipped generated LODs because it ${reason}.`);
			skippedLodMeshCount++;
			return false;
		});
		const sourceTriangleCount = eligible.reduce((sum, mesh) => sum + Math.floor(mesh.getTotalIndices() / 3), 0);
		if (eligible.length * settings.generatedLods.length > MAX_GENERATED_LOD_MESHES) {
			errors.push(`Generated LOD import is limited to ${MAX_GENERATED_LOD_MESHES} output meshes.`);
		} else if (sourceTriangleCount > MAX_LOD_SOURCE_TRIANGLES) {
			errors.push(`Generated LOD import is limited to ${MAX_LOD_SOURCE_TRIANGLES} source triangles.`);
		} else {
			const generated: Array<{ source: any; mesh: any; rollback: () => void }> = [];
			try {
				for (const source of eligible) {
					const sourceVertexCount = source.getTotalVertices();
					const sourceTriangles = Math.floor(source.getTotalIndices() / 3);
					const deformationMode = getModelLodDeformationMode(source);
					const skinInfluenceStreams = getModelLodSkinInfluenceStreams(source);
					const morphTargetCount = source.morphTargetManager?.numTargets ?? 0;
					const levels: IModelGeneratedLodMeshResult["levels"] = [];
					for (let index = 0; index < settings.generatedLods.length; index++) {
						const definition = settings.generatedLods[index];
						const simplification = await simplifyModelMeshPreservingDeformation(source, definition, activeAnimationGroups);
						const simplified = simplification.mesh;
						generated.push({ source, mesh: simplified, rollback: simplification.rollback });
						const scene = source.getScene();
						if (!scene.meshes.includes(simplified)) {
							scene.addMesh(simplified);
						}
						simplified.name = `${source.name}_LOD${index + 1}`;
						simplified.id = `${source.id}_lod${index + 1}`;
						simplified.parent = source.parent;
						simplified.position.copyFrom(source.position);
						simplified.scaling.copyFrom(source.scaling);
						if (source.rotationQuaternion) {
							simplified.rotationQuaternion = source.rotationQuaternion.clone();
						} else {
							simplified.rotation.copyFrom(source.rotation);
						}
						simplified.material = source.material;
						simplified.checkCollisions = false;
						simplified.isVisible = false;
						simplified.metadata = {
							...(simplified.metadata ?? {}),
							babylonEditorModelGeneratedLod: {
								sourceMesh: source.name,
								sourceMeshId: source.id,
								sourceMeshName: source.name,
								level: index + 1,
								quality: definition.quality,
								distance: definition.distance,
								deformationMode,
							},
						};
						source.addLODLevel(definition.distance, simplified);
						const triangleCount = Math.floor(simplified.getTotalIndices() / 3);
						levels.push({
							...definition,
							level: index + 1,
							meshName: simplified.name,
							vertexCount: simplified.getTotalVertices(),
							triangleCount,
							reduction: sourceTriangles > 0 ? 1 - triangleCount / sourceTriangles : 0,
							provenanceVertexCount: simplification.provenanceVertexCount,
							preservedVertexStreams: simplification.preservedVertexStreams,
							skinInfluenceStreamsPreserved: simplification.skinInfluenceStreamsPreserved,
							morphTargetCount: simplification.morphTargetCount,
							morphAnimationTrackCount: simplification.morphAnimationTrackCount,
						});
					}
					generatedLods.push({
						sourceMesh: source.name,
						sourceVertexCount,
						sourceTriangleCount: sourceTriangles,
						deformationMode,
						skinInfluenceStreams,
						morphTargetCount,
						levels,
					});
				}
			} catch (error) {
				for (const entry of generated.reverse()) {
					entry.source.removeLODLevel(entry.mesh);
					entry.rollback();
					entry.mesh.dispose(false, false);
				}
				generatedLods = [];
				errors.push(`Generated LOD processing failed atomically: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0);
	const indexCount = meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices(), 0);
	return {
		settings,
		unitScale,
		meshes: results,
		meshCount: meshes.length,
		vertexCount,
		indexCount,
		triangleCount: Math.floor(indexCount / 3),
		materialCount: settings.importMaterials
			? sourceMaterialCount - remappedMaterialCount + new Set(materialRemaps.filter((remap) => remap.matched).map((remap) => remap.materialPath)).size
			: 0,
		sourceMaterials,
		materialRemaps,
		remappedMaterialCount,
		remappedMeshCount: remappedMeshes.size,
		missingMaterialRemapCount,
		materialSearch: entries.materialSearch ?? { naming: settings.materialNaming, search: settings.materialSearch, searchedMaterialCount: 0, matches: [] },
		authoredLods,
		authoredLodSourceMeshCount: authoredLods.length,
		authoredLodMeshCount: authoredLods.reduce((sum, group) => sum + group.levels.length, 0),
		generatedLods,
		lodSourceMeshCount: generatedLods.length,
		generatedLodMeshCount: generatedLods.reduce((sum, mesh) => sum + mesh.levels.length, 0),
		skippedLodMeshCount,
		textureCount: settings.importMaterials && settings.importTextures ? sourceTextureCount : 0,
		animationGroupCount: settings.importAnimations ? activeAnimationGroups.length : 0,
		sourceAnimationGroups,
		animationClips,
		skeletonCount: entries.skeletonCount ?? meshes.filter((mesh) => !!mesh.skeleton).length,
		rig: {
			animationType: settings.animationType,
			skeletonName: skeleton?.name ?? null,
			boneCount: bones.length,
			mapping,
			validation: rigValidation,
		},
		rigOptimization,
		colliderCount: meshes.filter((mesh) => mesh.checkCollisions).length,
		weldedMeshCount,
		optimizedMeshCount,
		quantizedMeshCount,
		calculatedNormalMeshCount,
		calculatedTangentMeshCount,
		removedMaterialCount,
		removedTextureCount,
		removedAnimationGroupCount,
		replacedAnimationGroupCount,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
}
