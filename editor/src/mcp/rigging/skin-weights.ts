import { createHash } from "crypto";

import { Mesh, Scene, Vector3, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

interface ISkinInfluence {
	boneIndex: number;
	weight: number;
}

interface ISkinWeightBuffers {
	mesh: Mesh;
	vertexCount: number;
	positions: number[];
	indices: number[];
	influences: ISkinInfluence[][];
}

export interface IMeshSkinWeightSnapshot {
	nodeId: string;
	numBoneInfluencers: number;
	influences: ISkinInfluence[][];
}

const WeightEpsilon = 0.00001;

function resolveSkinnedMesh(scene: Scene, data: any): Mesh {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	if (!node.skeleton) {
		throw new Error(`Mesh "${node.name}" is not bound to a skeleton.`);
	}

	const positions = node.getVerticesData(VertexBuffer.PositionKind, false);
	if (!positions?.length || positions.length % 3 !== 0) {
		throw new Error(`Mesh "${node.name}" has no complete editable position buffer.`);
	}

	return node;
}

function finiteArray(data: ArrayLike<number> | null, expectedLength: number, label: string): number[] | null {
	if (!data) {
		return null;
	}
	if (data.length !== expectedLength) {
		throw new Error(`${label} must contain exactly ${expectedLength} values for this mesh, but contains ${data.length}.`);
	}
	return Array.from(data);
}

function readSkinWeightBuffers(mesh: Mesh): ISkinWeightBuffers {
	const positions = Array.from(mesh.getVerticesData(VertexBuffer.PositionKind, false) ?? []);
	const vertexCount = positions.length / 3;
	const valueCount = vertexCount * 4;
	const mainIndices = finiteArray(mesh.getVerticesData(VertexBuffer.MatricesIndicesKind, false), valueCount, "matricesIndices");
	const mainWeights = finiteArray(mesh.getVerticesData(VertexBuffer.MatricesWeightsKind, false), valueCount, "matricesWeights");
	const extraIndices = finiteArray(mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind, false), valueCount, "matricesIndicesExtra");
	const extraWeights = finiteArray(mesh.getVerticesData(VertexBuffer.MatricesWeightsExtraKind, false), valueCount, "matricesWeightsExtra");
	if ((mainIndices === null) !== (mainWeights === null)) {
		throw new Error(`Mesh "${mesh.name}" has only one of its main skin index/weight buffers.`);
	}
	if ((extraIndices === null) !== (extraWeights === null)) {
		throw new Error(`Mesh "${mesh.name}" has only one of its extra skin index/weight buffers.`);
	}

	const influences: ISkinInfluence[][] = [];
	for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex++) {
		const result: ISkinInfluence[] = [];
		for (let offset = 0; offset < 4; offset++) {
			if (mainIndices && mainWeights) {
				result.push({ boneIndex: mainIndices[vertexIndex * 4 + offset], weight: mainWeights[vertexIndex * 4 + offset] });
			}
			if (extraIndices && extraWeights) {
				result.push({ boneIndex: extraIndices[vertexIndex * 4 + offset], weight: extraWeights[vertexIndex * 4 + offset] });
			}
		}
		influences.push(result);
	}

	return {
		mesh,
		vertexCount,
		positions,
		indices: Array.from(mesh.getIndices(false) ?? []),
		influences,
	};
}

function fingerprintSkinWeights(buffers: ISkinWeightBuffers): string {
	const skeleton = buffers.mesh.skeleton!;
	return createHash("sha256")
		.update(
			JSON.stringify({
				meshId: buffers.mesh.id,
				skeletonId: skeleton.id,
				bones: skeleton.bones.map((bone) => bone.name),
				vertexCount: buffers.vertexCount,
				influences: buffers.influences,
			})
		)
		.digest("hex");
}

function verifyFingerprint(buffers: ISkinWeightBuffers, value: unknown): void {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error("expectedFingerprint must be the exact lowercase SHA-256 returned by get_mesh_skin_weights.");
	}
	const current = fingerprintSkinWeights(buffers);
	if (current !== value) {
		throw new Error(`Skin weights changed after inspection. Inspect the mesh again and use current fingerprint ${current}.`);
	}
}

function normalizeInfluences(influences: ISkinInfluence[], boneCount: number, maxInfluences: number, minimumWeight: number, fallbackBoneIndex: number): ISkinInfluence[] {
	const combined = new Map<number, number>();
	influences.forEach((influence) => {
		if (!Number.isInteger(influence.boneIndex) || influence.boneIndex < 0 || influence.boneIndex >= boneCount) {
			return;
		}
		if (!Number.isFinite(influence.weight) || influence.weight <= minimumWeight) {
			return;
		}
		combined.set(influence.boneIndex, (combined.get(influence.boneIndex) ?? 0) + influence.weight);
	});

	const result = [...combined.entries()]
		.map(([boneIndex, weight]) => ({ boneIndex, weight }))
		.sort((first, second) => second.weight - first.weight || first.boneIndex - second.boneIndex)
		.slice(0, maxInfluences);
	const sum = result.reduce((total, influence) => total + influence.weight, 0);
	if (sum <= WeightEpsilon) {
		return [{ boneIndex: fallbackBoneIndex, weight: 1 }];
	}
	result.forEach((influence) => (influence.weight /= sum));
	return result;
}

function writeSkinWeightBuffers(buffers: ISkinWeightBuffers): void {
	const mainIndices = new Array<number>(buffers.vertexCount * 4).fill(0);
	const mainWeights = new Array<number>(buffers.vertexCount * 4).fill(0);
	const extraIndices = new Array<number>(buffers.vertexCount * 4).fill(0);
	const extraWeights = new Array<number>(buffers.vertexCount * 4).fill(0);
	let maximumInfluences = 1;

	buffers.influences.forEach((influences, vertexIndex) => {
		maximumInfluences = Math.max(maximumInfluences, influences.length);
		influences.forEach((influence, influenceIndex) => {
			const offset = vertexIndex * 4 + (influenceIndex % 4);
			if (influenceIndex < 4) {
				mainIndices[offset] = influence.boneIndex;
				mainWeights[offset] = influence.weight;
			} else {
				extraIndices[offset] = influence.boneIndex;
				extraWeights[offset] = influence.weight;
			}
		});
	});

	buffers.mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, mainIndices, true, 4);
	buffers.mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, mainWeights, true, 4);
	if (maximumInfluences > 4) {
		buffers.mesh.setVerticesData(VertexBuffer.MatricesIndicesExtraKind, extraIndices, true, 4);
		buffers.mesh.setVerticesData(VertexBuffer.MatricesWeightsExtraKind, extraWeights, true, 4);
	} else {
		buffers.mesh.removeVerticesData(VertexBuffer.MatricesIndicesExtraKind);
		buffers.mesh.removeVerticesData(VertexBuffer.MatricesWeightsExtraKind);
	}
	buffers.mesh.numBoneInfluencers = maximumInfluences;
}

function validateVertexIndices(values: unknown, vertexCount: number, required = false): number[] {
	const indices = values === undefined ? [] : [...new Set(values as number[])].sort((first, second) => first - second);
	if (required && indices.length === 0) {
		throw new Error("Provide at least one vertex index.");
	}
	if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
		throw new Error(`Vertex indices must be unique integers from 0 to ${vertexCount - 1}.`);
	}
	return indices;
}

function boneIndex(mesh: Mesh, boneName: unknown): number {
	if (typeof boneName !== "string" || !boneName.trim()) {
		throw new Error("boneName is required.");
	}
	const index = mesh.skeleton!.bones.findIndex((bone) => bone.name === boneName);
	if (index === -1) {
		throw new Error(`Bone "${boneName}" was not found in skeleton "${mesh.skeleton!.name}".`);
	}
	return index;
}

function skinWeightReport(buffers: ISkinWeightBuffers): any {
	const skeleton = buffers.mesh.skeleton!;
	let invalidBoneReferenceCount = 0;
	let invalidWeightCount = 0;
	let duplicateBoneInfluenceCount = 0;
	let unweightedVertexCount = 0;
	let unnormalizedVertexCount = 0;
	let overConfiguredInfluenceCount = 0;
	let maximumObservedInfluences = 0;
	let totalInfluenceCount = 0;

	buffers.influences.forEach((influences) => {
		const seen = new Set<number>();
		let validPositiveCount = 0;
		let sum = 0;
		influences.forEach((influence) => {
			if (!Number.isInteger(influence.boneIndex) || influence.boneIndex < 0 || influence.boneIndex >= skeleton.bones.length) {
				invalidBoneReferenceCount++;
			}
			if (!Number.isFinite(influence.weight) || influence.weight < 0) {
				invalidWeightCount++;
			}
			if (influence.weight > WeightEpsilon) {
				validPositiveCount++;
				sum += influence.weight;
				if (seen.has(influence.boneIndex)) {
					duplicateBoneInfluenceCount++;
				}
				seen.add(influence.boneIndex);
			}
		});
		if (validPositiveCount === 0) {
			unweightedVertexCount++;
		} else if (Math.abs(sum - 1) > 0.001) {
			unnormalizedVertexCount++;
		}
		if (validPositiveCount > buffers.mesh.numBoneInfluencers) {
			overConfiguredInfluenceCount++;
		}
		maximumObservedInfluences = Math.max(maximumObservedInfluences, validPositiveCount);
		totalInfluenceCount += validPositiveCount;
	});

	return {
		vertexCount: buffers.vertexCount,
		boneCount: skeleton.bones.length,
		configuredInfluencers: buffers.mesh.numBoneInfluencers,
		maximumObservedInfluences,
		totalInfluenceCount,
		unweightedVertexCount,
		unnormalizedVertexCount,
		invalidBoneReferenceCount,
		invalidWeightCount,
		duplicateBoneInfluenceCount,
		overConfiguredInfluenceCount,
		valid:
			unweightedVertexCount === 0 &&
			unnormalizedVertexCount === 0 &&
			invalidBoneReferenceCount === 0 &&
			invalidWeightCount === 0 &&
			duplicateBoneInfluenceCount === 0 &&
			overConfiguredInfluenceCount === 0,
	};
}

function skinWeightResult(buffers: ISkinWeightBuffers, data: any = {}): any {
	const skeleton = buffers.mesh.skeleton!;
	const requested = validateVertexIndices(data.vertexIndices, buffers.vertexCount);
	const filtered = requested.length > 0 ? requested : Array.from({ length: buffers.vertexCount }, (_, index) => index);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 100;
	const boneFilter = data.boneName === undefined ? -1 : boneIndex(buffers.mesh, data.boneName);
	const matches =
		boneFilter === -1
			? filtered
			: filtered.filter((vertexIndex) => buffers.influences[vertexIndex].some((influence) => influence.boneIndex === boneFilter && influence.weight > WeightEpsilon));
	const page = matches.slice(offset, offset + limit);

	return {
		node: toNodeSummary(buffers.mesh),
		skeleton: { id: skeleton.id, name: skeleton.name },
		fingerprint: fingerprintSkinWeights(buffers),
		report: skinWeightReport(buffers),
		total: matches.length,
		count: page.length,
		offset,
		hasMore: offset + page.length < matches.length,
		nextOffset: offset + page.length < matches.length ? offset + page.length : null,
		vertices: page.map((vertexIndex) => {
			const influences = buffers.influences[vertexIndex]
				.filter((influence) => influence.weight > WeightEpsilon)
				.sort((first, second) => second.weight - first.weight || first.boneIndex - second.boneIndex);
			return {
				vertexIndex,
				position: buffers.positions.slice(vertexIndex * 3, vertexIndex * 3 + 3),
				weightSum: influences.reduce((total, influence) => total + influence.weight, 0),
				influences: influences.map((influence) => ({
					boneIndex: influence.boneIndex,
					boneName: skeleton.bones[influence.boneIndex]?.name ?? null,
					weight: influence.weight,
				})),
			};
		}),
	};
}

function refreshEditor(mesh: Mesh, options: IMCPActionOptions): void {
	options.editor.layout.inspector.setEditedObject(mesh);
	options.editor.layout.inspector.forceUpdate();
}

/** Captures exact in-memory skin buffers for editor Undo/Redo without publishing a large MCP response. */
export function captureMeshSkinWeightSnapshot(scene: Scene, data: any): IMeshSkinWeightSnapshot {
	const buffers = readSkinWeightBuffers(resolveSkinnedMesh(scene, data));
	return {
		nodeId: buffers.mesh.id,
		numBoneInfluencers: buffers.mesh.numBoneInfluencers,
		influences: buffers.influences.map((influences) => influences.map((influence) => ({ ...influence }))),
	};
}

/** Restores one exact editor-only skin-weight snapshot. */
export function restoreMeshSkinWeightSnapshot(scene: Scene, snapshot: IMeshSkinWeightSnapshot, options: IMCPActionOptions): any {
	const buffers = readSkinWeightBuffers(resolveSkinnedMesh(scene, { nodeId: snapshot.nodeId }));
	if (snapshot.influences.length !== buffers.vertexCount) {
		throw new Error(`Skin-weight snapshot contains ${snapshot.influences.length} vertices, but mesh "${buffers.mesh.name}" now contains ${buffers.vertexCount}.`);
	}
	buffers.influences = snapshot.influences.map((influences) => influences.map((influence) => ({ ...influence })));
	writeSkinWeightBuffers(buffers);
	buffers.mesh.numBoneInfluencers = snapshot.numBoneInfluencers;
	refreshEditor(buffers.mesh, options);
	return skinWeightResult(readSkinWeightBuffers(buffers.mesh), { limit: 1 });
}

function setBoneWeight(influences: ISkinInfluence[], targetBoneIndex: number, desiredWeight: number, fallbackBoneIndex: number): ISkinInfluence[] {
	const weights = new Map<number, number>();
	influences.forEach((influence) => {
		if (influence.weight > WeightEpsilon && Number.isFinite(influence.weight)) {
			weights.set(influence.boneIndex, (weights.get(influence.boneIndex) ?? 0) + influence.weight);
		}
	});
	weights.delete(targetBoneIndex);
	const others = [...weights.entries()].map(([boneIndex, weight]) => ({ boneIndex, weight }));
	const otherSum = others.reduce((sum, influence) => sum + influence.weight, 0);
	const clamped = Math.max(0, Math.min(1, desiredWeight));
	const result: ISkinInfluence[] = clamped > WeightEpsilon ? [{ boneIndex: targetBoneIndex, weight: clamped }] : [];
	if (clamped < 1 - WeightEpsilon) {
		if (otherSum > WeightEpsilon) {
			others.forEach((influence) => result.push({ boneIndex: influence.boneIndex, weight: (influence.weight / otherSum) * (1 - clamped) }));
		} else {
			result.push({ boneIndex: fallbackBoneIndex === targetBoneIndex && targetBoneIndex !== 0 ? 0 : fallbackBoneIndex, weight: 1 - clamped });
		}
	}
	return result;
}

function adjacency(buffers: ISkinWeightBuffers): Set<number>[] {
	const result = Array.from({ length: buffers.vertexCount }, () => new Set<number>());
	for (let index = 0; index + 2 < buffers.indices.length; index += 3) {
		const triangle = [buffers.indices[index], buffers.indices[index + 1], buffers.indices[index + 2]];
		for (let first = 0; first < 3; first++) {
			for (let second = 0; second < 3; second++) {
				if (first !== second && triangle[first] < buffers.vertexCount && triangle[second] < buffers.vertexCount) {
					result[triangle[first]].add(triangle[second]);
				}
			}
		}
	}
	return result;
}

function influenceWeight(influences: ISkinInfluence[], targetBoneIndex: number): number {
	return influences.filter((influence) => influence.boneIndex === targetBoneIndex && influence.weight > WeightEpsilon).reduce((sum, influence) => sum + influence.weight, 0);
}

/** Reads paginated per-vertex skin weights and a complete validation report. */
export function getMeshSkinWeights(scene: Scene, data: any): any {
	return skinWeightResult(readSkinWeightBuffers(resolveSkinnedMesh(scene, data)), data);
}

/** Replaces explicit per-vertex influences using bone names and an exact inspected-state lease. */
export function setMeshSkinWeights(scene: Scene, data: any, options: IMCPActionOptions): any {
	const buffers = readSkinWeightBuffers(resolveSkinnedMesh(scene, data));
	verifyFingerprint(buffers, data.expectedFingerprint);
	const maxInfluences = data.maxInfluences ?? 8;
	const minimumWeight = data.minimumWeight ?? 0;
	const fallbackBoneIndex = data.fallbackBoneName === undefined ? 0 : boneIndex(buffers.mesh, data.fallbackBoneName);
	if (!Array.isArray(data.vertices) || data.vertices.length === 0) {
		throw new Error("Provide at least one vertex skin-weight replacement.");
	}

	const seen = new Set<number>();
	data.vertices.forEach((vertex: any) => {
		const vertexIndex = vertex.vertexIndex;
		validateVertexIndices([vertexIndex], buffers.vertexCount, true);
		if (seen.has(vertexIndex)) {
			throw new Error(`Vertex ${vertexIndex} is duplicated in the replacement set.`);
		}
		seen.add(vertexIndex);
		if (!Array.isArray(vertex.influences) || vertex.influences.length === 0 || vertex.influences.length > 8) {
			throw new Error(`Vertex ${vertexIndex} must provide 1–8 influences.`);
		}
		const influences = vertex.influences.map((influence: any) => ({
			boneIndex: boneIndex(buffers.mesh, influence.boneName),
			weight: influence.weight,
		}));
		if (influences.some((influence: ISkinInfluence) => !Number.isFinite(influence.weight) || influence.weight < 0 || influence.weight > 1)) {
			throw new Error(`Vertex ${vertexIndex} influence weights must be finite values from 0 to 1.`);
		}
		buffers.influences[vertexIndex] = normalizeInfluences(influences, buffers.mesh.skeleton!.bones.length, maxInfluences, minimumWeight, fallbackBoneIndex);
	});

	writeSkinWeightBuffers(buffers);
	refreshEditor(buffers.mesh, options);
	return { ...skinWeightResult(readSkinWeightBuffers(buffers.mesh), { vertexIndices: [...seen], limit: Math.min(256, seen.size) }), changedVertexCount: seen.size };
}

/** Paints one bone weight over explicit vertices or a local-space spherical brush. */
export function paintMeshSkinWeights(scene: Scene, data: any, options: IMCPActionOptions): any {
	const buffers = readSkinWeightBuffers(resolveSkinnedMesh(scene, data));
	verifyFingerprint(buffers, data.expectedFingerprint);
	const targetBoneIndex = boneIndex(buffers.mesh, data.boneName);
	const fallbackBoneIndex = data.fallbackBoneName === undefined ? 0 : boneIndex(buffers.mesh, data.fallbackBoneName);
	const explicit = validateVertexIndices(data.vertexIndices, buffers.vertexCount);
	const center = data.center ? Vector3.FromArray(data.center) : null;
	const radius = data.radius ?? 0;
	if (explicit.length === 0 && (!center || !(radius > 0))) {
		throw new Error("Provide vertexIndices or a local-space center with radius greater than zero.");
	}
	const mode = data.mode ?? "replace";
	const weight = data.weight ?? 1;
	const opacity = data.opacity ?? 1;
	const maxInfluences = data.maxInfluences ?? 8;
	const minimumWeight = data.minimumWeight ?? 0;
	const neighbors = mode === "smooth" ? adjacency(buffers) : null;
	const beforeWeights = mode === "smooth" ? buffers.influences.map((influences) => influenceWeight(influences, targetBoneIndex)) : [];
	const candidates = explicit.length > 0 ? explicit : Array.from({ length: buffers.vertexCount }, (_, index) => index);
	const changed: number[] = [];

	candidates.forEach((vertexIndex) => {
		let falloff = 1;
		if (center) {
			const position = Vector3.FromArray(buffers.positions, vertexIndex * 3);
			const distance = Vector3.Distance(position, center);
			if (distance > radius) {
				return;
			}
			const linear = 1 - distance / radius;
			falloff = data.falloff === "linear" ? linear : linear * linear * (3 - 2 * linear);
		}
		const current = influenceWeight(buffers.influences[vertexIndex], targetBoneIndex);
		let desired = current;
		const amount = opacity * falloff;
		switch (mode) {
			case "add":
				desired = current + weight * amount;
				break;
			case "subtract":
				desired = current - weight * amount;
				break;
			case "replace":
				desired = current + (weight - current) * amount;
				break;
			case "smooth": {
				const adjacent = [...(neighbors![vertexIndex] ?? [])];
				const average = adjacent.length > 0 ? adjacent.reduce((sum, index) => sum + beforeWeights[index], 0) / adjacent.length : current;
				desired = current + (average - current) * amount;
				break;
			}
			default:
				throw new Error(`Unsupported skin-weight paint mode "${mode}".`);
		}
		buffers.influences[vertexIndex] = normalizeInfluences(
			setBoneWeight(buffers.influences[vertexIndex], targetBoneIndex, desired, fallbackBoneIndex),
			buffers.mesh.skeleton!.bones.length,
			maxInfluences,
			minimumWeight,
			fallbackBoneIndex
		);
		changed.push(vertexIndex);
	});
	if (changed.length === 0) {
		throw new Error("The skin-weight brush did not reach any vertices.");
	}

	writeSkinWeightBuffers(buffers);
	refreshEditor(buffers.mesh, options);
	return {
		...skinWeightResult(readSkinWeightBuffers(buffers.mesh), { vertexIndices: changed, boneName: data.boneName, limit: Math.min(256, changed.length) }),
		changedVertexCount: changed.length,
		mode,
		boneName: data.boneName,
	};
}

/** Normalizes, prunes, repairs, and limits influences on selected or all vertices. */
export function optimizeMeshSkinWeights(scene: Scene, data: any, options: IMCPActionOptions): any {
	const buffers = readSkinWeightBuffers(resolveSkinnedMesh(scene, data));
	verifyFingerprint(buffers, data.expectedFingerprint);
	const selected = validateVertexIndices(data.vertexIndices, buffers.vertexCount);
	const targets = selected.length > 0 ? selected : Array.from({ length: buffers.vertexCount }, (_, index) => index);
	const maxInfluences = data.maxInfluences ?? 4;
	const minimumWeight = data.minimumWeight ?? 0.001;
	const fallbackBoneIndex = data.fallbackBoneName === undefined ? 0 : boneIndex(buffers.mesh, data.fallbackBoneName);
	targets.forEach(
		(vertexIndex) =>
			(buffers.influences[vertexIndex] = normalizeInfluences(
				buffers.influences[vertexIndex],
				buffers.mesh.skeleton!.bones.length,
				maxInfluences,
				minimumWeight,
				fallbackBoneIndex
			))
	);
	writeSkinWeightBuffers(buffers);
	refreshEditor(buffers.mesh, options);
	return { ...skinWeightResult(readSkinWeightBuffers(buffers.mesh), { vertexIndices: selected, limit: Math.min(256, targets.length) }), changedVertexCount: targets.length };
}

function mirroredBoneName(name: string): string {
	const replacements: [RegExp, string][] = [
		[/Left/g, "__RIGHT__"],
		[/Right/g, "Left"],
		[/__RIGHT__/g, "Right"],
		[/left/g, "__right__"],
		[/right/g, "left"],
		[/__right__/g, "right"],
		[/(^|[_.-])L(?=$|[_.-])/g, "$1__R__"],
		[/(^|[_.-])R(?=$|[_.-])/g, "$1L"],
		[/__R__/g, "R"],
	];
	return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), name);
}

function positionCell(position: number[], tolerance: number): number[] {
	return position.map((value) => Math.round(value / tolerance));
}

function positionKey(cell: number[]): string {
	return cell.join(":");
}

/** Mirrors weights across one local-space axis with automatic or explicit left/right bone remapping. */
export function mirrorMeshSkinWeights(scene: Scene, data: any, options: IMCPActionOptions): any {
	const buffers = readSkinWeightBuffers(resolveSkinnedMesh(scene, data));
	verifyFingerprint(buffers, data.expectedFingerprint);
	const axis = data.axis ?? "x";
	const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
	const direction = data.direction ?? "negativeToPositive";
	const tolerance = data.tolerance ?? 0.001;
	const maxInfluences = data.maxInfluences ?? 8;
	const minimumWeight = data.minimumWeight ?? 0;
	const fallbackBoneIndex = data.fallbackBoneName === undefined ? 0 : boneIndex(buffers.mesh, data.fallbackBoneName);
	const explicitPairs = (data.bonePairs ?? {}) as Record<string, string>;
	const skeleton = buffers.mesh.skeleton!;
	const boneNameToIndex = new Map(skeleton.bones.map((bone, index) => [bone.name, index]));
	const sourceSign = direction === "negativeToPositive" ? -1 : 1;
	const buckets = new Map<string, number[]>();

	for (let vertexIndex = 0; vertexIndex < buffers.vertexCount; vertexIndex++) {
		const coordinate = buffers.positions[vertexIndex * 3 + axisIndex];
		if (coordinate * sourceSign < -tolerance) {
			continue;
		}
		const position = buffers.positions.slice(vertexIndex * 3, vertexIndex * 3 + 3);
		const key = positionKey(positionCell(position, tolerance));
		const bucket = buckets.get(key) ?? [];
		bucket.push(vertexIndex);
		buckets.set(key, bucket);
	}

	const changed: number[] = [];
	for (let destination = 0; destination < buffers.vertexCount; destination++) {
		const coordinate = buffers.positions[destination * 3 + axisIndex];
		if (coordinate * sourceSign >= -tolerance) {
			continue;
		}
		const mirrored = buffers.positions.slice(destination * 3, destination * 3 + 3);
		mirrored[axisIndex] *= -1;
		const cell = positionCell(mirrored, tolerance);
		const candidates: number[] = [];
		for (let x = -1; x <= 1; x++) {
			for (let y = -1; y <= 1; y++) {
				for (let z = -1; z <= 1; z++) {
					candidates.push(...(buckets.get(positionKey([cell[0] + x, cell[1] + y, cell[2] + z])) ?? []));
				}
			}
		}
		let source = -1;
		let bestDistance = Number.POSITIVE_INFINITY;
		candidates.forEach((candidate) => {
			const position = buffers.positions.slice(candidate * 3, candidate * 3 + 3);
			const distance = Vector3.DistanceSquared(Vector3.FromArray(position), Vector3.FromArray(mirrored));
			if (distance < bestDistance) {
				bestDistance = distance;
				source = candidate;
			}
		});
		if (source === -1 || Math.sqrt(bestDistance) > tolerance) {
			continue;
		}
		const remapped = buffers.influences[source].map((influence) => {
			const sourceName = skeleton.bones[influence.boneIndex]?.name ?? "";
			const targetName = explicitPairs[sourceName] ?? mirroredBoneName(sourceName);
			return { boneIndex: boneNameToIndex.get(targetName) ?? influence.boneIndex, weight: influence.weight };
		});
		buffers.influences[destination] = normalizeInfluences(remapped, skeleton.bones.length, maxInfluences, minimumWeight, fallbackBoneIndex);
		changed.push(destination);
	}
	if (changed.length === 0) {
		throw new Error(`No destination vertices found matching mirrored ${axis.toUpperCase()} positions within tolerance ${tolerance}.`);
	}

	writeSkinWeightBuffers(buffers);
	refreshEditor(buffers.mesh, options);
	return {
		...skinWeightResult(readSkinWeightBuffers(buffers.mesh), { vertexIndices: changed, limit: Math.min(256, changed.length) }),
		changedVertexCount: changed.length,
		axis,
		direction,
	};
}
