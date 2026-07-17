import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { QuadraticErrorSimplification } from "@babylonjs/core/Meshes/meshSimplification";
import { MorphTarget } from "@babylonjs/core/Morph/morphTarget";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager";

export interface IModelLodDefinition {
	quality: number;
	distance: number;
}

export interface IModelAuthoredLodLevelDefinition {
	mesh: string;
	distance: number;
}

export interface IModelAuthoredLodGroupDefinition {
	sourceMesh: string;
	levels: IModelAuthoredLodLevelDefinition[];
}

export type ModelLodDeformationMode = "static" | "skinned" | "morph" | "skinnedMorph";

export interface IModelGeneratedLodLevelResult extends IModelLodDefinition {
	level: number;
	meshName: string;
	vertexCount: number;
	triangleCount: number;
	reduction: number;
	provenanceVertexCount: number;
	preservedVertexStreams: string[];
	skinInfluenceStreamsPreserved: boolean;
	morphTargetCount: number;
	morphAnimationTrackCount: number;
}

export interface IModelGeneratedLodMeshResult {
	sourceMesh: string;
	sourceVertexCount: number;
	sourceTriangleCount: number;
	deformationMode: ModelLodDeformationMode;
	skinInfluenceStreams: string[];
	morphTargetCount: number;
	levels: IModelGeneratedLodLevelResult[];
}

export interface IModelAuthoredLodLevelResult extends IModelAuthoredLodLevelDefinition {
	level: number;
	vertexCount: number;
	triangleCount: number;
	deformationMode: ModelLodDeformationMode;
}

export interface IModelAuthoredLodGroupResult {
	sourceMesh: string;
	sourceVertexCount: number;
	sourceTriangleCount: number;
	levels: IModelAuthoredLodLevelResult[];
}

export interface IModelAuthoredLodApplication {
	groups: IModelAuthoredLodGroupResult[];
	levelMeshes: Set<any>;
	rollback: () => void;
}

export interface IModelLodSimplificationResult {
	mesh: any;
	provenanceVertexCount: number;
	preservedVertexStreams: string[];
	skinInfluenceStreamsPreserved: boolean;
	morphTargetCount: number;
	morphAnimationTrackCount: number;
	rollback: () => void;
}

const MAX_MODEL_LOD_LEVELS = 8;
const MAX_MODEL_AUTHORED_LOD_GROUPS = 128;
const MODEL_LOD_METADATA_KEY = "babylonEditorModelGeneratedLod";
const MODEL_AUTHORED_LOD_METADATA_KEY = "babylonEditorModelAuthoredLod";
const SKIN_INFLUENCE_KINDS = [VertexBuffer.MatricesIndicesKind, VertexBuffer.MatricesWeightsKind, VertexBuffer.MatricesIndicesExtraKind, VertexBuffer.MatricesWeightsExtraKind];

interface IVertexStreamSnapshot {
	kind: string;
	stride: number;
	data: number[];
}

interface IMorphLink {
	source: any;
	observer: any;
}

const morphLinks = new WeakMap<object, IMorphLink>();

function deformationMode(mesh: any): ModelLodDeformationMode {
	const skinned = !!mesh.skeleton;
	const morphed = (mesh.morphTargetManager?.numTargets ?? 0) > 0;
	return skinned && morphed ? "skinnedMorph" : skinned ? "skinned" : morphed ? "morph" : "static";
}

/** Returns the deformation class used by generated-LOD reporting and MCP evidence. */
export function getModelLodDeformationMode(mesh: any): ModelLodDeformationMode {
	return deformationMode(mesh);
}

/** Lists the complete bone index/weight streams present on a generated-LOD source. */
export function getModelLodSkinInfluenceStreams(mesh: any): string[] {
	return SKIN_INFLUENCE_KINDS.filter((kind) => mesh.isVerticesDataPresent?.(kind));
}

function snapshotVertexStreams(mesh: any): IVertexStreamSnapshot[] {
	const vertexCount = mesh.getTotalVertices();
	return mesh
		.getVerticesDataKinds()
		.filter((kind: string) => kind !== VertexBuffer.PositionKind && !mesh.getVertexBuffer(kind)?.getIsInstanced?.())
		.map((kind: string) => {
			const buffer = mesh.getVertexBuffer(kind);
			const stride = buffer?.getSize?.() ?? 0;
			const data = Array.from(mesh.getVerticesData(kind, false) ?? []) as number[];
			if (!Number.isInteger(stride) || stride <= 0 || data.length !== vertexCount * stride || data.some((value) => !Number.isFinite(value))) {
				throw new Error(`Mesh "${mesh.name}" vertex stream "${kind}" is not a finite ${vertexCount}-vertex buffer.`);
			}
			return { kind, stride, data };
		});
}

function encodeVertexProvenance(vertexCount: number): number[] {
	if (!Number.isInteger(vertexCount) || vertexCount < 1 || vertexCount > 0xffffffff) {
		throw new Error("Generated LOD provenance supports between 1 and 4294967295 source vertices.");
	}
	const colors = new Array<number>(vertexCount * 4);
	for (let index = 0; index < vertexCount; index++) {
		colors[index * 4] = (index & 0xff) / 255;
		colors[index * 4 + 1] = ((index >>> 8) & 0xff) / 255;
		colors[index * 4 + 2] = ((index >>> 16) & 0xff) / 255;
		colors[index * 4 + 3] = ((index >>> 24) & 0xff) / 255;
	}
	return colors;
}

function decodeVertexProvenance(mesh: any, sourceVertexCount: number): number[] {
	const colors = Array.from(mesh.getVerticesData(VertexBuffer.ColorKind, false) ?? []) as number[];
	const vertexCount = mesh.getTotalVertices();
	if (colors.length !== vertexCount * 4) {
		throw new Error(`Generated mesh "${mesh.name}" did not preserve the exact RGBA provenance stream.`);
	}
	const result = new Array<number>(vertexCount);
	for (let index = 0; index < vertexCount; index++) {
		const bytes = [0, 1, 2, 3].map((component) => Math.round(colors[index * 4 + component] * 255));
		if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
			throw new Error(`Generated mesh "${mesh.name}" contains invalid vertex provenance at output vertex ${index}.`);
		}
		const sourceIndex = (bytes[0] + bytes[1] * 0x100 + bytes[2] * 0x10000 + bytes[3] * 0x1000000) >>> 0;
		if (sourceIndex >= sourceVertexCount) {
			throw new Error(`Generated mesh "${mesh.name}" references missing source vertex ${sourceIndex}.`);
		}
		result[index] = sourceIndex;
	}
	return result;
}

function remapVertexData(data: ArrayLike<number>, stride: number, provenance: number[], label: string, sourceVertexCount: number): number[] {
	if (data.length !== sourceVertexCount * stride) {
		throw new Error(`${label} must contain exactly ${sourceVertexCount} vertices with stride ${stride}.`);
	}
	const result = new Array<number>(provenance.length * stride);
	for (let outputIndex = 0; outputIndex < provenance.length; outputIndex++) {
		const sourceOffset = provenance[outputIndex] * stride;
		const outputOffset = outputIndex * stride;
		for (let component = 0; component < stride; component++) {
			const value = data[sourceOffset + component];
			if (!Number.isFinite(value)) {
				throw new Error(`${label} contains a non-finite value at source vertex ${provenance[outputIndex]}.`);
			}
			result[outputOffset + component] = value;
		}
	}
	return result;
}

function remapMorphPositions(sourceBase: number[], targetPositions: ArrayLike<number>, outputBase: number[], provenance: number[], label: string): number[] {
	if (targetPositions.length !== sourceBase.length) {
		throw new Error(`${label} position count does not match its source mesh.`);
	}
	const result = new Array<number>(outputBase.length);
	for (let outputIndex = 0; outputIndex < provenance.length; outputIndex++) {
		const sourceOffset = provenance[outputIndex] * 3;
		const outputOffset = outputIndex * 3;
		for (let component = 0; component < 3; component++) {
			const delta = targetPositions[sourceOffset + component] - sourceBase[sourceOffset + component];
			if (!Number.isFinite(delta) || !Number.isFinite(outputBase[outputOffset + component])) {
				throw new Error(`${label} contains non-finite position data.`);
			}
			result[outputOffset + component] = outputBase[outputOffset + component] + delta;
		}
	}
	return result;
}

function unlinkMorphTarget(target: any): void {
	const existing = morphLinks.get(target);
	if (existing) {
		existing.source.onInfluenceChanged.remove(existing.observer);
		morphLinks.delete(target);
	}
}

function linkMorphTarget(source: any, target: any): void {
	const existing = morphLinks.get(target);
	if (existing?.source === source) {
		target.influence = source.influence;
		return;
	}
	unlinkMorphTarget(target);
	target.influence = source.influence;
	const observer = source.onInfluenceChanged.add(() => {
		target.influence = source.influence;
	});
	morphLinks.set(target, { source, observer });
}

function configureMorphTargets(
	source: any,
	generated: any,
	provenance: number[],
	animationGroups: any[]
): { targetCount: number; animationTrackCount: number; rollback: () => void } {
	const sourceManager = source.morphTargetManager;
	if (!sourceManager?.numTargets) {
		return { targetCount: 0, animationTrackCount: 0, rollback: () => undefined };
	}
	const sourceVertexCount = source.getTotalVertices();
	const sourceBase = Array.from(source.getVerticesData(VertexBuffer.PositionKind, false) ?? []) as number[];
	const outputBase = Array.from(generated.getVerticesData(VertexBuffer.PositionKind, false) ?? []) as number[];
	if (sourceBase.length !== sourceVertexCount * 3 || outputBase.length !== provenance.length * 3) {
		throw new Error(`Mesh "${source.name}" has incompatible base positions for morph-target LOD generation.`);
	}
	const manager = new MorphTargetManager(source.getScene(), generated.name);
	manager.areUpdatesFrozen = true;
	const targets: any[] = [];
	const addedAnimations: Array<{ group: any; animation: any }> = [];
	try {
		for (let index = 0; index < sourceManager.numTargets; index++) {
			const sourceTarget = sourceManager.getTarget(index);
			if (!sourceTarget || sourceTarget.vertexCount !== sourceVertexCount) {
				throw new Error(`Morph target ${index + 1} on mesh "${source.name}" does not match the source vertex count.`);
			}
			const target = new MorphTarget(sourceTarget.name, sourceTarget.influence, source.getScene(), manager);
			target.id = `${sourceTarget.id ?? sourceTarget.name}@${generated.id}`;
			const positions = sourceTarget.getPositions?.();
			if (positions) {
				target.setPositions(remapMorphPositions(sourceBase, positions, outputBase, provenance, `Morph target "${sourceTarget.name}"`));
			}
			const normals = sourceTarget.getNormals?.();
			if (normals) {
				target.setNormals(remapVertexData(normals, 3, provenance, `Morph target "${sourceTarget.name}" normals`, sourceVertexCount));
			}
			const tangents = sourceTarget.getTangents?.();
			if (tangents) {
				target.setTangents(remapVertexData(tangents, 3, provenance, `Morph target "${sourceTarget.name}" tangents`, sourceVertexCount));
			}
			const uvs = sourceTarget.getUVs?.();
			if (uvs) {
				target.setUVs(remapVertexData(uvs, 2, provenance, `Morph target "${sourceTarget.name}" UV0`, sourceVertexCount));
			}
			const uv2s = sourceTarget.getUV2s?.();
			if (uv2s) {
				target.setUV2s(remapVertexData(uv2s, 2, provenance, `Morph target "${sourceTarget.name}" UV1`, sourceVertexCount));
			}
			const colors = sourceTarget.getColors?.();
			if (colors) {
				target.setColors(remapVertexData(colors, 4, provenance, `Morph target "${sourceTarget.name}" colors`, sourceVertexCount));
			}
			target.animations = (sourceTarget.animations ?? []).map((animation: any) => animation.clone());
			manager.addTarget(target);
			targets.push(target);
			for (const group of animationGroups) {
				for (const targeted of group.targetedAnimations.slice()) {
					if (targeted.target !== sourceTarget) {
						continue;
					}
					const animation = targeted.animation.clone();
					group.addTargetedAnimation(animation, target);
					addedAnimations.push({ group, animation });
				}
			}
		}
		manager.enablePositionMorphing = sourceManager.enablePositionMorphing;
		manager.enableNormalMorphing = sourceManager.enableNormalMorphing;
		manager.enableTangentMorphing = sourceManager.enableTangentMorphing;
		manager.enableUVMorphing = sourceManager.enableUVMorphing;
		manager.enableUV2Morphing = sourceManager.enableUV2Morphing;
		manager.enableColorMorphing = sourceManager.enableColorMorphing;
		manager.optimizeInfluencers = sourceManager.optimizeInfluencers;
		manager.numMaxInfluencers = sourceManager.numMaxInfluencers;
		manager.useTextureToStoreTargets = sourceManager.useTextureToStoreTargets;
		manager.metadata = {
			...(sourceManager.metadata ?? {}),
			babylonEditorModelLodMorphSource: { meshId: source.id, meshName: source.name, targetIds: targets.map((_target, index) => sourceManager.getTarget(index).id) },
		};
		manager.areUpdatesFrozen = false;
		generated.morphTargetManager = manager;
		targets.forEach((target, index) => linkMorphTarget(sourceManager.getTarget(index), target));
		return {
			targetCount: targets.length,
			animationTrackCount: addedAnimations.length,
			rollback: () => {
				for (const entry of addedAnimations) {
					entry.group.removeTargetedAnimation(entry.animation);
				}
				for (const target of targets) {
					unlinkMorphTarget(target);
				}
				if (generated.morphTargetManager === manager) {
					generated.morphTargetManager = null;
				}
				manager.dispose();
			},
		};
	} catch (error) {
		for (const entry of addedAnimations) {
			entry.group.removeTargetedAnimation(entry.animation);
		}
		for (const target of targets) {
			unlinkMorphTarget(target);
		}
		manager.areUpdatesFrozen = false;
		manager.dispose();
		throw error;
	}
}

function simplifyMesh(mesh: any, definition: IModelLodDefinition): Promise<any> {
	return new Promise((resolve) => {
		new QuadraticErrorSimplification(mesh).simplify({ quality: definition.quality, distance: definition.distance, optimizeMesh: true }, resolve);
	});
}

/** Generates one reduced mesh while reconstructing every source vertex stream, skin binding, morph target, and morph animation binding from exact source-vertex provenance. */
export async function simplifyModelMeshPreservingDeformation(mesh: any, definition: IModelLodDefinition, animationGroups: any[] = []): Promise<IModelLodSimplificationResult> {
	const sourceVertexCount = mesh.getTotalVertices();
	const streams = snapshotVertexStreams(mesh);
	const temporary = mesh.clone(`${mesh.name}@generated-lod-source`, mesh.parent, true, false);
	if (!temporary) {
		throw new Error(`Mesh "${mesh.name}" could not be cloned for non-mutating LOD generation.`);
	}
	temporary.makeGeometryUnique();
	temporary.skeleton = null;
	temporary.morphTargetManager = null;
	temporary.isVisible = false;
	temporary.doNotSerialize = true;
	temporary.setVerticesData(VertexBuffer.ColorKind, encodeVertexProvenance(sourceVertexCount), false, 4);
	let generated: any = null;
	try {
		generated = await simplifyMesh(temporary, definition);
	} finally {
		temporary.dispose(false, false);
	}
	const provenance = decodeVertexProvenance(generated, sourceVertexCount);
	for (const stream of streams) {
		generated.setVerticesData(
			stream.kind,
			remapVertexData(stream.data, stream.stride, provenance, `Mesh "${mesh.name}" stream "${stream.kind}"`, sourceVertexCount),
			false,
			stream.stride
		);
	}
	if (!streams.some((stream) => stream.kind === VertexBuffer.ColorKind)) {
		generated.removeVerticesData(VertexBuffer.ColorKind);
	}
	const mainIndices = streams.some((stream) => stream.kind === VertexBuffer.MatricesIndicesKind);
	const mainWeights = streams.some((stream) => stream.kind === VertexBuffer.MatricesWeightsKind);
	const extraIndices = streams.some((stream) => stream.kind === VertexBuffer.MatricesIndicesExtraKind);
	const extraWeights = streams.some((stream) => stream.kind === VertexBuffer.MatricesWeightsExtraKind);
	if (mesh.skeleton && (!mainIndices || !mainWeights || extraIndices !== extraWeights)) {
		generated.dispose(false, false);
		throw new Error(`Skinned mesh "${mesh.name}" must provide paired main and optional extra bone index/weight streams.`);
	}
	generated.skeleton = mesh.skeleton;
	generated.numBoneInfluencers = mesh.numBoneInfluencers;
	let morph: ReturnType<typeof configureMorphTargets> | null = null;
	try {
		morph = configureMorphTargets(mesh, generated, provenance, animationGroups);
	} catch (error) {
		generated.dispose(false, false);
		throw error;
	}
	return {
		mesh: generated,
		provenanceVertexCount: provenance.length,
		preservedVertexStreams: streams.map((stream) => stream.kind).sort(),
		skinInfluenceStreamsPreserved: !!mesh.skeleton && mainIndices && mainWeights && extraIndices === extraWeights,
		morphTargetCount: morph.targetCount,
		morphAnimationTrackCount: morph.animationTrackCount,
		rollback: morph.rollback,
	};
}

/** Reconnects generated morph-target influences to their source targets after Babylon scene/container parsing or cloning. */
export function configureGeneratedModelLodDeformations(sceneOrContainer: any): number {
	const meshes = (sceneOrContainer.meshes ?? []).filter((mesh: any) => !!mesh);
	let linked = 0;
	for (const generated of meshes) {
		const metadata = generated.metadata?.[MODEL_LOD_METADATA_KEY];
		const manager = generated.morphTargetManager;
		if (!metadata?.sourceMeshId || !manager?.numTargets) {
			continue;
		}
		const source = meshes.find(
			(mesh: any) =>
				mesh !== generated &&
				(mesh.id === metadata.sourceMeshId || mesh.metadata?.originalId === metadata.sourceMeshId || (metadata.sourceMeshName && mesh.name === metadata.sourceMeshName))
		);
		const sourceManager = source?.morphTargetManager;
		if (!sourceManager || sourceManager.numTargets !== manager.numTargets) {
			continue;
		}
		for (let index = 0; index < manager.numTargets; index++) {
			const sourceTarget = sourceManager.getTarget(index);
			const target = manager.getTarget(index);
			if (sourceTarget && target) {
				linkMorphTarget(sourceTarget, target);
				linked++;
			}
		}
	}
	return linked;
}

/** Normalizes an ordered complete generated-LOD table. */
export function normalizeModelLodDefinitions(value: unknown): IModelLodDefinition[] {
	let input = value;
	if (typeof input === "string") {
		try {
			input = JSON.parse(input || "[]");
		} catch (error) {
			throw new Error(`Generated LODs must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (input === undefined || input === null) {
		return [];
	}
	if (!Array.isArray(input)) {
		throw new Error("Generated LODs must be an array.");
	}
	if (input.length > MAX_MODEL_LOD_LEVELS) {
		throw new Error(`Model importers support at most ${MAX_MODEL_LOD_LEVELS} generated LOD levels.`);
	}
	const result = input.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Generated LOD ${index + 1} must be an object.`);
		}
		const record = entry as Record<string, unknown>;
		const unknown = Object.keys(record).filter((key) => key !== "quality" && key !== "distance");
		if (unknown.length) {
			throw new Error(`Generated LOD ${index + 1} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
		}
		if (typeof record.quality !== "number" || !Number.isFinite(record.quality) || record.quality < 0.01 || record.quality > 0.99) {
			throw new Error(`Generated LOD ${index + 1} quality must be between 0.01 and 0.99.`);
		}
		if (typeof record.distance !== "number" || !Number.isFinite(record.distance) || record.distance <= 0 || record.distance > 1_000_000_000) {
			throw new Error(`Generated LOD ${index + 1} distance must be greater than 0 and at most 1000000000 centimeters.`);
		}
		return { quality: record.quality, distance: record.distance };
	});
	for (let index = 1; index < result.length; index++) {
		if (result[index].distance <= result[index - 1].distance) {
			throw new Error("Generated LOD distances must be strictly increasing.");
		}
		if (result[index].quality >= result[index - 1].quality) {
			throw new Error("Generated LOD quality must strictly decrease as distance increases.");
		}
	}
	return result;
}

export function serializeModelLodDefinitions(value: unknown): string {
	return JSON.stringify(normalizeModelLodDefinitions(value));
}

/** Normalizes exact artist-authored source/level mesh assignments without consulting a loaded scene. */
export function normalizeModelAuthoredLodGroups(value: unknown): IModelAuthoredLodGroupDefinition[] {
	let input = value;
	if (typeof input === "string") {
		try {
			input = JSON.parse(input || "[]");
		} catch (error) {
			throw new Error(`Authored LOD groups must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (input === undefined || input === null) {
		return [];
	}
	if (!Array.isArray(input)) {
		throw new Error("Authored LOD groups must be an array.");
	}
	if (input.length > MAX_MODEL_AUTHORED_LOD_GROUPS) {
		throw new Error(`Model importers support at most ${MAX_MODEL_AUTHORED_LOD_GROUPS} authored LOD groups.`);
	}
	const usedMeshes = new Set<string>();
	return input.map((entry, groupIndex) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`Authored LOD group ${groupIndex + 1} must be an object.`);
		}
		const group = entry as Record<string, unknown>;
		const unknown = Object.keys(group).filter((key) => key !== "sourceMesh" && key !== "levels");
		if (unknown.length) {
			throw new Error(`Authored LOD group ${groupIndex + 1} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
		}
		if (typeof group.sourceMesh !== "string" || !group.sourceMesh.trim() || group.sourceMesh.length > 512) {
			throw new Error(`Authored LOD group ${groupIndex + 1} sourceMesh must contain 1–512 characters.`);
		}
		if (!Array.isArray(group.levels) || !group.levels.length || group.levels.length > MAX_MODEL_LOD_LEVELS) {
			throw new Error(`Authored LOD group ${groupIndex + 1} must contain 1–${MAX_MODEL_LOD_LEVELS} levels.`);
		}
		const sourceMesh = group.sourceMesh.trim();
		if (usedMeshes.has(sourceMesh)) {
			throw new Error(`Mesh "${sourceMesh}" is assigned more than once across authored LOD groups.`);
		}
		usedMeshes.add(sourceMesh);
		const levels = group.levels.map((entry, levelIndex) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
				throw new Error(`Authored LOD group ${groupIndex + 1} level ${levelIndex + 1} must be an object.`);
			}
			const level = entry as Record<string, unknown>;
			const unknown = Object.keys(level).filter((key) => key !== "mesh" && key !== "distance");
			if (unknown.length) {
				throw new Error(`Authored LOD group ${groupIndex + 1} level ${levelIndex + 1} contains unsupported field(s): ${unknown.sort().join(", ")}.`);
			}
			if (typeof level.mesh !== "string" || !level.mesh.trim() || level.mesh.length > 512) {
				throw new Error(`Authored LOD group ${groupIndex + 1} level ${levelIndex + 1} mesh must contain 1–512 characters.`);
			}
			const mesh = level.mesh.trim();
			if (usedMeshes.has(mesh)) {
				throw new Error(`Mesh "${mesh}" is assigned more than once across authored LOD groups.`);
			}
			usedMeshes.add(mesh);
			if (typeof level.distance !== "number" || !Number.isFinite(level.distance) || level.distance <= 0 || level.distance > 1_000_000_000) {
				throw new Error(`Authored LOD group ${groupIndex + 1} level ${levelIndex + 1} distance must be greater than 0 and at most 1000000000 centimeters.`);
			}
			return { mesh, distance: level.distance };
		});
		for (let index = 1; index < levels.length; index++) {
			if (levels[index].distance <= levels[index - 1].distance) {
				throw new Error(`Authored LOD group ${groupIndex + 1} distances must be strictly increasing.`);
			}
		}
		return { sourceMesh, levels };
	});
}

export function serializeModelAuthoredLodGroups(value: unknown): string {
	return JSON.stringify(normalizeModelAuthoredLodGroups(value));
}

/** Suggests exact groups for the common artist naming convention Name_LOD0, Name_LOD1, and so on. */
export function suggestModelAuthoredLodGroups(meshNames: string[]): IModelAuthoredLodGroupDefinition[] {
	const grouped = new Map<string, Map<number, string[]>>();
	for (const meshName of meshNames) {
		const match = /^(.*?)[_. -]LOD(\d+)$/i.exec(meshName.trim());
		if (!match || !match[1] || Number(match[2]) > MAX_MODEL_LOD_LEVELS) {
			continue;
		}
		const levels = grouped.get(match[1]) ?? new Map<number, string[]>();
		const index = Number(match[2]);
		levels.set(index, [...(levels.get(index) ?? []), meshName]);
		grouped.set(match[1], levels);
	}
	const suggestions: IModelAuthoredLodGroupDefinition[] = [];
	for (const levels of grouped.values()) {
		if (levels.get(0)?.length !== 1 || [...levels.values()].some((names) => names.length !== 1)) {
			continue;
		}
		const lower = [...levels.entries()].filter(([index]) => index > 0).sort(([a], [b]) => a - b);
		if (!lower.length || lower.length > MAX_MODEL_LOD_LEVELS) {
			continue;
		}
		suggestions.push({
			sourceMesh: levels.get(0)![0],
			levels: lower.map(([index, names]) => ({ mesh: names[0], distance: 500 * 2 ** (index - 1) })),
		});
	}
	return suggestions.sort((a, b) => a.sourceMesh.localeCompare(b.sourceMesh));
}

/** Attaches existing imported meshes as LOD levels only after every group resolves uniquely, so failures remain atomic. */
export function applyModelAuthoredLodGroups(meshes: any[], definitions: IModelAuthoredLodGroupDefinition[]): IModelAuthoredLodApplication {
	const normalized = normalizeModelAuthoredLodGroups(definitions);
	const byName = new Map<string, any[]>();
	for (const mesh of meshes) {
		byName.set(mesh.name, [...(byName.get(mesh.name) ?? []), mesh]);
	}
	const resolveMesh = (name: string): any => {
		const matches = byName.get(name) ?? [];
		if (matches.length !== 1) {
			throw new Error(matches.length ? `Authored LOD mesh name "${name}" is ambiguous.` : `Authored LOD mesh "${name}" does not exist in the imported model.`);
		}
		return matches[0];
	};
	const resolved = normalized.map((definition) => ({
		definition,
		source: resolveMesh(definition.sourceMesh),
		levels: definition.levels.map((level) => ({ definition: level, mesh: resolveMesh(level.mesh) })),
	}));
	for (const group of resolved) {
		if (typeof group.source.addLODLevel !== "function" || typeof group.source.getLODLevels !== "function") {
			throw new Error(`Mesh "${group.source.name}" does not support Babylon LOD levels.`);
		}
		if (group.source.getLODLevels().length) {
			throw new Error(`Mesh "${group.source.name}" already contains authored LOD levels.`);
		}
		for (const level of group.levels) {
			if (typeof level.mesh.getLODLevels === "function" && level.mesh.getLODLevels().length) {
				throw new Error(`Authored LOD level mesh "${level.mesh.name}" cannot also own LOD levels.`);
			}
		}
	}
	const applied: Array<{ source: any; mesh: any; metadata: any; visible: boolean; collisions: boolean }> = [];
	try {
		const groups = resolved.map((group) => {
			const levels = group.levels.map((level, index) => {
				applied.push({ source: group.source, mesh: level.mesh, metadata: level.mesh.metadata, visible: level.mesh.isVisible, collisions: level.mesh.checkCollisions });
				level.mesh.metadata = {
					...(level.mesh.metadata && typeof level.mesh.metadata === "object" ? level.mesh.metadata : {}),
					[MODEL_AUTHORED_LOD_METADATA_KEY]: { sourceMesh: group.source.name, sourceMeshId: group.source.id, level: index + 1, distance: level.definition.distance },
				};
				level.mesh.isVisible = false;
				level.mesh.checkCollisions = false;
				group.source.addLODLevel(level.definition.distance, level.mesh);
				return {
					...level.definition,
					level: index + 1,
					vertexCount: level.mesh.getTotalVertices(),
					triangleCount: Math.floor(level.mesh.getTotalIndices() / 3),
					deformationMode: deformationMode(level.mesh),
				};
			});
			return {
				sourceMesh: group.source.name,
				sourceVertexCount: group.source.getTotalVertices(),
				sourceTriangleCount: Math.floor(group.source.getTotalIndices() / 3),
				levels,
			};
		});
		const rollback = (): void => {
			for (const entry of [...applied].reverse()) {
				entry.source.removeLODLevel(entry.mesh);
				entry.mesh.metadata = entry.metadata;
				entry.mesh.isVisible = entry.visible;
				entry.mesh.checkCollisions = entry.collisions;
			}
		};
		return { groups, levelMeshes: new Set(applied.map((entry) => entry.mesh)), rollback };
	} catch (error) {
		for (const entry of [...applied].reverse()) {
			entry.source.removeLODLevel(entry.mesh);
			entry.mesh.metadata = entry.metadata;
			entry.mesh.isVisible = entry.visible;
			entry.mesh.checkCollisions = entry.collisions;
		}
		throw error;
	}
}

/** Adds generated or artist-authored model LOD links and any non-enumerated generated meshes to Babylon serializer data. */
export function configureSerializedModelGeneratedLods(data: any, scene: any, serializeMeshes?: (meshes: any[]) => any): void {
	if (!Array.isArray(data?.meshes)) {
		return;
	}
	const generatedMeshes: any[] = [];
	for (const serializedSource of data.meshes) {
		const source = scene.getMeshById?.(serializedSource.id);
		if (!source || typeof source.getLODLevels !== "function") {
			continue;
		}
		const levels = source
			.getLODLevels()
			.filter((entry: any) => entry.mesh?.metadata?.[MODEL_LOD_METADATA_KEY] || entry.mesh?.metadata?.[MODEL_AUTHORED_LOD_METADATA_KEY])
			.sort((a: any, b: any) => {
				const aMetadata = a.mesh.metadata?.[MODEL_LOD_METADATA_KEY] ?? a.mesh.metadata?.[MODEL_AUTHORED_LOD_METADATA_KEY];
				const bMetadata = b.mesh.metadata?.[MODEL_LOD_METADATA_KEY] ?? b.mesh.metadata?.[MODEL_AUTHORED_LOD_METADATA_KEY];
				return (aMetadata?.level ?? Number.MAX_SAFE_INTEGER) - (bMetadata?.level ?? Number.MAX_SAFE_INTEGER);
			});
		if (!levels.length) {
			continue;
		}
		generatedMeshes.push(...levels.filter((entry: any) => entry.mesh.metadata?.[MODEL_LOD_METADATA_KEY]).map((entry: any) => entry.mesh));
		serializedSource.lodMeshIds = levels.map((entry: any) => entry.mesh.id);
		serializedSource.lodDistances = levels.map((entry: any) => entry.distanceOrScreenCoverage);
	}
	const serializedIds = new Set(data.meshes.map((mesh: any) => mesh.id));
	const missingMeshes = generatedMeshes.filter((mesh) => !serializedIds.has(mesh.id));
	if (!missingMeshes.length || !serializeMeshes) {
		return;
	}
	const extra = serializeMeshes(missingMeshes);
	data.geometries ??= {};
	data.morphTargetManagers ??= [];
	const serializedMorphManagerIds = new Set(data.morphTargetManagers.map((manager: any) => manager.id));
	for (const mesh of missingMeshes) {
		const manager = mesh.morphTargetManager;
		if (manager && !serializedMorphManagerIds.has(manager.uniqueId)) {
			data.morphTargetManagers.push(manager.serialize());
			serializedMorphManagerIds.add(manager.uniqueId);
		}
	}
	for (const mesh of extra.meshes ?? []) {
		if (!serializedIds.has(mesh.id)) {
			data.meshes.push(mesh);
			serializedIds.add(mesh.id);
		}
	}
	for (const [kind, geometries] of Object.entries(extra.geometries ?? {})) {
		const target = (data.geometries[kind] ??= []);
		const ids = new Set(target.map((geometry: any) => geometry.id ?? geometry.uniqueId));
		for (const geometry of geometries as any[]) {
			const id = geometry.id ?? geometry.uniqueId;
			if (!ids.has(id)) {
				target.push(geometry);
				ids.add(id);
			}
		}
	}
}
