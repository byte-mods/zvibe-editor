import { createHash } from "node:crypto";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

const maximumGraphCoordinate = 100000;
const maximumGraphNodes = 512;

type RigGraphLane = "input" | "constraint" | "output";

interface IRigGraphNode {
	id: string;
	kind: "bone" | "constraint" | "transform";
	label: string;
	subtitle: string;
	lane: RigGraphLane;
	constraintId?: string;
	valid: boolean;
	position: [number, number];
}

interface IRigGraphEdge {
	id: string;
	from: string;
	to: string;
	label: string;
}

interface IRigGraphBuild {
	layer: any;
	nodes: IRigGraphNode[];
	edges: IRigGraphEdge[];
	defaultPositions: Record<string, [number, number]>;
}

function resolveLayer(scene: Scene, layerId: string): any {
	const layer = (scene.metadata?.babylonEditorRigLayers ?? []).find((candidate: any) => candidate.id === layerId);
	if (!layer) {
		throw new Error(`Rig layer "${layerId}" was not found.`);
	}
	return layer;
}

function normalizePosition(value: unknown, label: string): [number, number] {
	const position = validPosition(value);
	if (!position) {
		throw new Error(`${label} must contain two finite coordinates from 0 through ${maximumGraphCoordinate}.`);
	}
	return position;
}

function validPosition(value: unknown): [number, number] | null {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate) || coordinate < 0 || coordinate > maximumGraphCoordinate)
	) {
		return null;
	}
	return [value[0], value[1]];
}

function graphFingerprint(layerId: string, nodes: IRigGraphNode[], edges: IRigGraphEdge[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				layerId,
				nodes: nodes.map((node) => ({
					id: node.id,
					kind: node.kind,
					label: node.label,
					subtitle: node.subtitle,
					lane: node.lane,
					constraintId: node.constraintId,
					valid: node.valid,
					position: node.position,
				})),
				edges,
			})
		)
		.digest("hex");
}

function transformLabel(scene: Scene, nodeId: string): string {
	return scene.getNodeById(nodeId)?.name || nodeId;
}

function buildRigConstraintGraph(scene: Scene, layerId: string, ignoreStoredPositions = false): IRigGraphBuild {
	const layer = resolveLayer(scene, layerId);
	const skeleton = scene.skeletons.find((candidate) => candidate.id === layer.skeletonId);
	const nodes = new Map<string, Omit<IRigGraphNode, "position">>();
	const edges: IRigGraphEdge[] = [];
	let edgeIndex = 0;

	const addNode = (node: Omit<IRigGraphNode, "position">): void => {
		const existing = nodes.get(node.id);
		if (!existing) {
			if (nodes.size >= maximumGraphNodes) {
				throw new Error(`Rig constraint graphs support at most ${maximumGraphNodes} nodes.`);
			}
			nodes.set(node.id, node);
		} else if (existing.lane === "input" && node.lane === "output") {
			nodes.set(node.id, { ...existing, lane: "output", valid: existing.valid && node.valid });
		} else {
			existing.valid &&= node.valid;
		}
	};
	const addBone = (boneName: string, lane: "input" | "output"): string => {
		const id = `bone:${boneName}`;
		addNode({
			id,
			kind: "bone",
			label: boneName,
			subtitle: lane === "output" ? "Driven bone" : "Rig bone",
			lane,
			valid: !!skeleton?.bones.some((bone) => bone.name === boneName),
		});
		return id;
	};
	const addTransform = (nodeId: string): string => {
		const id = `transform:${nodeId}`;
		addNode({
			id,
			kind: "transform",
			label: transformLabel(scene, nodeId),
			subtitle: "Transform source",
			lane: "input",
			valid: !!scene.getNodeById(nodeId),
		});
		return id;
	};
	const addEdge = (from: string, to: string, label: string): void => {
		edges.push({ id: `edge:${edgeIndex++}`, from, to, label });
	};

	for (const constraint of layer.constraints ?? []) {
		const constraintNodeId = `constraint:${constraint.id}`;
		addNode({
			id: constraintNodeId,
			kind: "constraint",
			label: constraint.name || constraint.id,
			subtitle: constraint.type,
			lane: "constraint",
			constraintId: constraint.id,
			valid: true,
		});
		const sourceToConstraint = (nodeId: string, label: string): void => addEdge(addTransform(nodeId), constraintNodeId, label);
		const boneToConstraint = (boneName: string, label: string): void => addEdge(addBone(boneName, "input"), constraintNodeId, label);
		const constraintToBone = (boneName: string, label: string): void => addEdge(constraintNodeId, addBone(boneName, "output"), label);

		if (constraint.type === "multiParent" || constraint.type === "multiPosition" || constraint.type === "multiAim") {
			for (const [index, source] of (constraint.sources ?? []).entries()) {
				sourceToConstraint(source.nodeId, `Source ${index + 1}`);
			}
			constraintToBone(constraint.boneName, "Drives");
		} else if (constraint.type === "twist") {
			boneToConstraint(constraint.sourceBoneName, "Twist source");
			for (const twistBone of constraint.twistBones ?? []) {
				constraintToBone(twistBone.boneName, "Distributes");
			}
		} else if (constraint.type === "chainIk") {
			boneToConstraint(constraint.rootBoneName, "Chain root");
			sourceToConstraint(constraint.targetNodeId, "IK target");
			constraintToBone(constraint.tipBoneName, "Chain tip");
		} else if (constraint.type === "fullBodyIk") {
			boneToConstraint(constraint.rootBoneName, "Solver root");
			for (const effector of constraint.effectors ?? []) {
				sourceToConstraint(effector.targetNodeId, `${effector.boneName} target`);
				constraintToBone(effector.boneName, "Effector");
			}
		} else if (constraint.type === "overrideTransform" || constraint.type === "dampedTransform") {
			sourceToConstraint(constraint.sourceNodeId, "Source");
			constraintToBone(constraint.boneName, "Drives");
		} else if (constraint.type === "blendTransform") {
			sourceToConstraint(constraint.sourceNodeIdA, "Source A");
			sourceToConstraint(constraint.sourceNodeIdB, "Source B");
			constraintToBone(constraint.boneName, "Drives");
		} else if (constraint.type === "customJob") {
			for (const [index, nodeId] of (constraint.nodeIds ?? []).entries()) {
				sourceToConstraint(nodeId, `Node handle ${index + 1}`);
			}
			for (const [index, boneName] of (constraint.boneNames ?? []).entries()) {
				constraintToBone(boneName, `Bone handle ${index + 1}`);
			}
		}
	}
	for (const node of nodes.values()) {
		if (node.kind !== "constraint") {
			continue;
		}
		const connectedNodeIds = edges.flatMap((edge) => (edge.from === node.id ? [edge.to] : edge.to === node.id ? [edge.from] : []));
		node.valid = connectedNodeIds.length > 0 && connectedNodeIds.every((nodeId) => nodes.get(nodeId)?.valid === true);
	}

	const laneX: Record<RigGraphLane, number> = { input: 32, constraint: 320, output: 608 };
	const defaultPositions: Record<string, [number, number]> = {};
	for (const lane of ["input", "constraint", "output"] as RigGraphLane[]) {
		[...nodes.values()]
			.filter((node) => node.lane === lane)
			.sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
			.forEach((node, index) => {
				defaultPositions[node.id] = [laneX[lane], 32 + index * 92];
			});
	}
	const storedPositions = !ignoreStoredPositions && layer.graphPositions && typeof layer.graphPositions === "object" ? layer.graphPositions : {};
	const resultNodes = [...nodes.values()]
		.map((node) => ({
			...node,
			position: validPosition(storedPositions[node.id]) ?? defaultPositions[node.id],
		}))
		.sort((left, right) => left.lane.localeCompare(right.lane) || left.position[1] - right.position[1] || left.id.localeCompare(right.id));
	return { layer, nodes: resultNodes, edges, defaultPositions };
}

/** Returns one persisted rig layer as a bounded visual data-flow graph with an exact layout lease. */
export function getRigConstraintGraph(scene: Scene, data: any): any {
	const graph = buildRigConstraintGraph(scene, data.layerId);
	const maximumX = Math.max(0, ...graph.nodes.map((node) => node.position[0]));
	const maximumY = Math.max(0, ...graph.nodes.map((node) => node.position[1]));
	return {
		layerId: graph.layer.id,
		layerName: graph.layer.name,
		skeletonId: graph.layer.skeletonId,
		fingerprint: graphFingerprint(graph.layer.id, graph.nodes, graph.edges),
		nodeCount: graph.nodes.length,
		edgeCount: graph.edges.length,
		bounds: { width: Math.max(840, maximumX + 240), height: Math.max(260, maximumY + 100) },
		nodes: graph.nodes,
		edges: graph.edges,
	};
}

/** Persists exact freeform graph-node positions or applies deterministic source/constraint/output auto-layout. */
export function setRigConstraintGraphLayout(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = getRigConstraintGraph(scene, { layerId: data.layerId });
	if (data.expectedFingerprint !== current.fingerprint) {
		throw new Error("Rig constraint graph changed after inspection. Call get_rig_constraint_graph again and use its exact fingerprint.");
	}
	if (data.autoLayout !== true && (!Array.isArray(data.positions) || data.positions.length === 0)) {
		throw new Error("Provide at least one graph-node position or set autoLayout=true.");
	}
	const graph = buildRigConstraintGraph(scene, data.layerId, data.autoLayout === true);
	const validNodeIds = new Set(graph.nodes.map((node) => node.id));
	let positions: Record<string, [number, number]>;
	if (data.autoLayout === true) {
		positions = structuredClone(graph.defaultPositions);
	} else {
		positions = data.replace === true ? {} : Object.fromEntries(graph.nodes.map((node) => [node.id, node.position]));
		const seen = new Set<string>();
		for (const item of data.positions) {
			if (seen.has(item.nodeId)) {
				throw new Error(`Graph node "${item.nodeId}" is duplicated in positions.`);
			}
			seen.add(item.nodeId);
			if (!validNodeIds.has(item.nodeId)) {
				throw new Error(`Graph node "${item.nodeId}" is not part of rig layer "${data.layerId}".`);
			}
			positions[item.nodeId] = normalizePosition(item.position, `Position for graph node "${item.nodeId}"`);
		}
		for (const node of graph.nodes) {
			positions[node.id] ??= graph.defaultPositions[node.id];
		}
	}
	graph.layer.graphPositions = Object.fromEntries(Object.entries(positions).sort(([left], [right]) => left.localeCompare(right)));
	options.editor.layout.inspector.forceUpdate();
	return getRigConstraintGraph(scene, { layerId: data.layerId });
}
