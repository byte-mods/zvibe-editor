import { Mesh, Scene, VertexBuffer } from "babylonjs";

import { isMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary } from "../tools/resolve";

import { applyLoopCutMeshSnapshot, captureLoopCutMeshSnapshot, ILoopCutMeshSnapshot } from "./loop-cut";
import { getMeshTopologyFingerprint } from "./meshes";

const DETACH_MODEL = "stream-preserving-face-detach-v1";

type DetachMode = "gameObject" | "submesh";

function copySerializable(value: any): any {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function getPositionStream(snapshot: ILoopCutMeshSnapshot): ILoopCutMeshSnapshot["streams"][number] {
	const position = snapshot.streams.find((stream) => stream.kind === VertexBuffer.PositionKind);
	if (!position || position.stride !== 3) {
		throw new Error("Face detach requires a complete three-component position stream.");
	}
	return position;
}

function getFaceSubMeshes(snapshot: ILoopCutMeshSnapshot): number[] {
	const faceSubMeshes: number[] = [];
	snapshot.subMeshes.forEach((subMesh, subMeshIndex) => {
		for (let offset = subMesh.indexStart; offset < subMesh.indexStart + subMesh.indexCount; offset += 3) {
			faceSubMeshes[offset / 3] = subMeshIndex;
		}
	});
	if (faceSubMeshes.length !== snapshot.indices.length / 3 || faceSubMeshes.some((value) => value === undefined)) {
		throw new Error("Face detach requires submeshes to cover every triangle exactly once.");
	}
	return faceSubMeshes;
}

function buildFaceSubset(snapshot: ILoopCutMeshSnapshot, faceIds: number[], selection: any): ILoopCutMeshSnapshot {
	const faceSubMeshes = getFaceSubMeshes(snapshot);
	const facesBySubMesh = snapshot.subMeshes.map(() => [] as number[]);
	for (const face of faceIds) {
		facesBySubMesh[faceSubMeshes[face]].push(face);
	}
	const vertexMapping = new Map<number, number>();
	const outputStreams = new Map(snapshot.streams.map((stream) => [stream.kind, [] as number[]]));
	const outputIndices: number[] = [];
	const outputSubMeshes: ILoopCutMeshSnapshot["subMeshes"] = [];
	for (let subMeshIndex = 0; subMeshIndex < snapshot.subMeshes.length; subMeshIndex++) {
		const faces = facesBySubMesh[subMeshIndex].sort((first, second) => first - second);
		if (!faces.length) {
			continue;
		}
		const indexStart = outputIndices.length;
		for (const face of faces) {
			for (let corner = 0; corner < 3; corner++) {
				const source = snapshot.indices[face * 3 + corner];
				let target = vertexMapping.get(source);
				if (target === undefined) {
					target = outputStreams.get(VertexBuffer.PositionKind)!.length / 3;
					vertexMapping.set(source, target);
					for (const stream of snapshot.streams) {
						outputStreams.get(stream.kind)!.push(...stream.values.slice(source * stream.stride, source * stream.stride + stream.stride));
					}
				}
				outputIndices.push(target);
			}
		}
		outputSubMeshes.push({ materialIndex: snapshot.subMeshes[subMeshIndex].materialIndex, indexStart, indexCount: outputIndices.length - indexStart });
	}
	const streams = snapshot.streams.map((stream) => ({ ...stream, values: outputStreams.get(stream.kind)! }));
	const positions = streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values;
	const smoothingGroups =
		snapshot.smoothingGroups?.model === "coincident-face-smoothing-groups-v1" &&
		Array.isArray(snapshot.smoothingGroups.faceGroups) &&
		snapshot.smoothingGroups.faceGroups.length === snapshot.indices.length / 3
			? {
					...copySerializable(snapshot.smoothingGroups),
					faceGroups: faceIds.map((face) => snapshot.smoothingGroups.faceGroups[face]),
					topologyFingerprint: getMeshTopologyFingerprint(positions, outputIndices),
				}
			: undefined;
	return {
		streams,
		indices: outputIndices,
		subMeshes: outputSubMeshes,
		selection: copySerializable(selection),
		uvLayout: undefined,
		smoothingGroups,
		vertexColors: undefined,
		useVertexColors: snapshot.useVertexColors,
		hasVertexAlpha: snapshot.hasVertexAlpha,
	};
}

function combineDetachedSubmesh(source: ILoopCutMeshSnapshot, detached: ILoopCutMeshSnapshot): ILoopCutMeshSnapshot {
	const sourceVertexCount = getPositionStream(source).values.length / 3;
	const sourceFaceCount = source.indices.length / 3;
	const streams = source.streams.map((stream) => {
		const detachedStream = detached.streams.find((candidate) => candidate.kind === stream.kind);
		if (!detachedStream || detachedStream.stride !== stream.stride) {
			throw new Error(`Face detach lost the required vertex stream "${stream.kind}" while building the detached submesh.`);
		}
		return { ...stream, values: [...stream.values, ...detachedStream.values] };
	});
	const indices = [...source.indices, ...detached.indices.map((index) => index + sourceVertexCount)];
	const positions = streams.find((stream) => stream.kind === VertexBuffer.PositionKind)!.values;
	const smoothingGroups =
		source.smoothingGroups?.model === "coincident-face-smoothing-groups-v1" && detached.smoothingGroups?.model === "coincident-face-smoothing-groups-v1"
			? {
					...copySerializable(source.smoothingGroups),
					faceGroups: [...source.smoothingGroups.faceGroups, ...detached.smoothingGroups.faceGroups],
					topologyFingerprint: getMeshTopologyFingerprint(positions, indices),
				}
			: undefined;
	return {
		streams,
		indices,
		subMeshes: [
			...source.subMeshes.map((subMesh) => ({ ...subMesh })),
			...detached.subMeshes.map((subMesh) => ({ ...subMesh, indexStart: subMesh.indexStart + source.indices.length })),
		],
		selection: { mode: "face", indices: Array.from({ length: detached.indices.length / 3 }, (_, index) => sourceFaceCount + index) },
		uvLayout: undefined,
		smoothingGroups,
		vertexColors: undefined,
		useVertexColors: source.useVertexColors,
		hasVertexAlpha: source.hasVertexAlpha,
	};
}

function copyDetachedMeshState(source: Mesh, target: Mesh): void {
	target.parent = source.parent;
	target.position.copyFrom(source.position);
	target.rotation.copyFrom(source.rotation);
	target.rotationQuaternion = source.rotationQuaternion?.clone() ?? null;
	target.scaling.copyFrom(source.scaling);
	target.setPivotMatrix(source.getPivotMatrix().clone(), false);
	target.billboardMode = source.billboardMode;
	target.layerMask = source.layerMask;
	target.visibility = source.visibility;
	target.isVisible = source.isVisible;
	target.isPickable = source.isPickable;
	target.receiveShadows = source.receiveShadows;
	target.alwaysSelectAsActiveMesh = source.alwaysSelectAsActiveMesh;
	target.material = source.material;
	target.skeleton = source.skeleton;
}

function createDetachedMesh(source: Mesh, snapshot: ILoopCutMeshSnapshot, data: any): Mesh {
	if (data.detachedId && source.getScene().getNodeById(data.detachedId)) {
		throw new Error(`Cannot restore detached mesh id "${data.detachedId}" because another scene node already uses it.`);
	}
	const detached = new Mesh(data.name ?? `${source.name} Detached`, source.getScene());
	if (data.detachedId) {
		detached.id = data.detachedId;
	}
	copyDetachedMeshState(source, detached);
	detached.metadata = { babylonEditorMeshSelection: copySerializable(snapshot.selection), detachedFromNodeId: source.id, detachModel: DETACH_MODEL };
	applyLoopCutMeshSnapshot(detached, snapshot);
	return detached;
}

/** Detaches selected triangle faces to a new Game Object or a disconnected submesh in the source object. */
export function detachMeshFaces(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isMesh(node)) {
		throw new Error(`Node "${node.name}" is not a Mesh.`);
	}
	if (node.morphTargetManager?.numTargets) {
		throw new Error("Face detach cannot change vertex topology while morph targets are attached; bake or detach morph targets first.");
	}
	const mode = data.mode as DetachMode;
	if (mode !== "gameObject" && mode !== "submesh") {
		throw new Error('Face detach mode must be "gameObject" or "submesh".');
	}
	if (mode === "submesh" && data.name !== undefined) {
		throw new Error("A detached submesh remains in the source object and cannot be assigned a new object name.");
	}
	if (!Array.isArray(data.faceIndices) || !data.faceIndices.length || data.faceIndices.length > 4096 || new Set(data.faceIndices).size !== data.faceIndices.length) {
		throw new Error("faceIndices must contain 1 to 4,096 unique current triangle-face IDs.");
	}
	const original = captureLoopCutMeshSnapshot(scene, { nodeId: node.id });
	const position = getPositionStream(original);
	const fingerprint = getMeshTopologyFingerprint(position.values, original.indices);
	if (data.expectedTopologyFingerprint !== fingerprint) {
		throw new Error(`Mesh topology is stale: expected "${data.expectedTopologyFingerprint}", current fingerprint is "${fingerprint}". Call get_mesh_topology again.`);
	}
	const faceCount = original.indices.length / 3;
	const selectedFaces = [...data.faceIndices].sort((first: number, second: number) => first - second);
	if (selectedFaces.some((face: number) => !Number.isInteger(face) || face < 0 || face >= faceCount)) {
		throw new Error(`Face detach indices must be integers from 0 to ${faceCount - 1}.`);
	}
	if (selectedFaces.length === faceCount) {
		throw new Error("Face detach requires at least one unselected source face; duplicate the object instead when moving every face.");
	}
	if (faceCount > 100_000) {
		throw new Error("Face detach supports at most 100,000 source triangles per operation.");
	}
	const selected = new Set<number>(selectedFaces);
	const remainingFaces = Array.from({ length: faceCount }, (_, face) => face).filter((face) => !selected.has(face));
	const remaining = buildFaceSubset(original, remainingFaces, { mode: "face", indices: [] });
	const detachedSelection = { mode: "face", indices: Array.from({ length: selectedFaces.length }, (_, face) => face) };
	const detached = buildFaceSubset(original, selectedFaces, detachedSelection);
	let detachedMesh: Mesh | null = null;
	let sourceOutput: ILoopCutMeshSnapshot;
	try {
		if (mode === "submesh") {
			sourceOutput = combineDetachedSubmesh(remaining, detached);
			applyLoopCutMeshSnapshot(node, sourceOutput);
		} else {
			detachedMesh = createDetachedMesh(node, detached, data);
			sourceOutput = remaining;
			applyLoopCutMeshSnapshot(node, sourceOutput);
		}
	} catch (error) {
		detachedMesh?.dispose(false, false);
		applyLoopCutMeshSnapshot(node, original);
		throw error;
	}
	delete node.metadata?.babylonEditorUvLayout;
	if (detachedMesh) {
		void options.editor.layout.graph.refresh().then(() => options.editor.layout.graph.setSelectedNode(detachedMesh!));
		options.editor.layout.inspector.setEditedObject(detachedMesh);
	} else {
		options.editor.layout.inspector.setEditedObject(node);
		options.editor.layout.inspector.forceUpdate();
	}
	const sourcePosition = getPositionStream(sourceOutput);
	const detachedPosition = getPositionStream(detached);
	return {
		detachModel: DETACH_MODEL,
		mode,
		source: toNodeSummary(node),
		detachedMesh: detachedMesh ? toNodeSummary(detachedMesh) : null,
		topologyFingerprintBefore: fingerprint,
		topologyFingerprintAfter: getMeshTopologyFingerprint(sourcePosition.values, sourceOutput.indices),
		selectedFaceIndices: selectedFaces,
		detachedFaceCount: selectedFaces.length,
		remainingFaceCount: remainingFaces.length,
		sourceVertexCount: sourcePosition.values.length / 3,
		detachedVertexCount: detachedPosition.values.length / 3,
		detachedSubMeshCount: detached.subMeshes.length,
		sourceSubMeshes: sourceOutput.subMeshes,
		detachedSubMeshes: detached.subMeshes,
		preservedVertexStreams: original.streams.map((stream) => ({ kind: stream.kind, stride: stream.stride })),
	};
}
