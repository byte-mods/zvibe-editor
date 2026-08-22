import { Scene } from "babylonjs";
import {
	BehaviorGraphRuntime,
	configureBehaviorTrees,
	createBehaviorGraphId,
	findBehaviorNode,
	getBehaviorGraphRuntime,
	getDefaultBehaviorBlackboardValue,
	IBehaviorBlackboardVariable,
	IBehaviorGraphDefinition,
	IBehaviorNodeDefinition,
	normalizeBehaviorGraph,
	normalizeBehaviorGraphs,
	validateBehaviorGraphs,
	visitBehaviorNodes,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

export interface IBehaviorGraphAuthoringSnapshot {
	hadMetadata: boolean;
	hadGraphs: boolean;
	graphs: unknown;
}

export function getBehaviorGraphAuthoringSnapshot(scene: Scene): IBehaviorGraphAuthoringSnapshot {
	return {
		hadMetadata: scene.metadata !== null && scene.metadata !== undefined,
		hadGraphs: Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorBehaviorTrees"),
		graphs: structuredClone(scene.metadata?.babylonEditorBehaviorTrees),
	};
}

export function restoreBehaviorGraphAuthoringSnapshot(scene: Scene, snapshot: IBehaviorGraphAuthoringSnapshot, options: IMCPActionOptions): void {
	if (!snapshot.hadMetadata) {
		scene.metadata = null;
	} else {
		scene.metadata ??= {};
		if (snapshot.hadGraphs) {
			scene.metadata.babylonEditorBehaviorTrees = structuredClone(snapshot.graphs);
		} else {
			delete scene.metadata.babylonEditorBehaviorTrees;
		}
	}
	if (getBehaviorGraphRuntime(scene as any)) {
		configureBehaviorTrees(scene as any);
	}
	refresh(options);
}

function authored(scene: Scene): IBehaviorGraphDefinition[] {
	return normalizeBehaviorGraphs(scene.metadata?.babylonEditorBehaviorTrees);
}

function graph(values: IBehaviorGraphDefinition[], data: any): IBehaviorGraphDefinition {
	if (!!data.id === !!data.name) {
		throw new Error("Provide exactly one behavior graph id or name.");
	}
	const result = values.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!result) {
		throw new Error("Behavior graph not found.");
	}
	return result;
}

function assertRevision(value: IBehaviorGraphDefinition, expected: unknown): void {
	if (!Number.isInteger(expected)) {
		throw new Error(`Behavior graph "${value.name}" requires expectedRevision.`);
	}
	if (value.revision !== expected) {
		throw new Error(`Behavior graph "${value.name}" revision is stale: expected ${expected}, current ${value.revision}.`);
	}
}

function refresh(options: IMCPActionOptions): void {
	options.editor.layout.inspector.forceUpdate();
}

function publish(scene: Scene, next: IBehaviorGraphDefinition[]): void {
	validateBehaviorGraphs(next);
	const hadMetadata = scene.metadata !== null && scene.metadata !== undefined;
	const hadGraphs = Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorBehaviorTrees");
	const previousRaw = structuredClone(scene.metadata?.babylonEditorBehaviorTrees);
	const hadRuntime = !!getBehaviorGraphRuntime(scene as any);
	scene.metadata ??= {};
	scene.metadata.babylonEditorBehaviorTrees = next;
	if (!hadRuntime) {
		return;
	}
	try {
		configureBehaviorTrees(scene as any);
	} catch (error) {
		if (!hadMetadata) {
			scene.metadata = null;
		} else if (hadGraphs) {
			scene.metadata.babylonEditorBehaviorTrees = previousRaw;
		} else {
			delete scene.metadata.babylonEditorBehaviorTrees;
		}
		configureBehaviorTrees(scene as any);
		throw error;
	}
}

function mutate(scene: Scene, data: any, callback: (value: IBehaviorGraphDefinition, all: IBehaviorGraphDefinition[]) => void): IBehaviorGraphDefinition {
	const next = structuredClone(authored(scene));
	const value = graph(next, data);
	assertRevision(value, data.expectedRevision);
	callback(value, next);
	value.revision++;
	publish(scene, next);
	return structuredClone(value);
}

function runtime(scene: Scene): BehaviorGraphRuntime {
	const result = getBehaviorGraphRuntime(scene as any);
	if (!result) {
		throw new Error("Behavior Graph runtime is not active. Reload it before using runtime or debugger controls.");
	}
	return result;
}

function identifier(data: any): string {
	if (!!data.id === !!data.name) {
		throw new Error("Provide exactly one behavior graph id or name.");
	}
	return data.id ?? data.name;
}

function findParent(root: IBehaviorNodeDefinition, nodeId: string): IBehaviorNodeDefinition | null {
	let parent: IBehaviorNodeDefinition | null = null;
	visitBehaviorNodes(root, (node) => {
		if (node.children.some((child) => child.id === nodeId)) {
			parent = node;
		}
	});
	return parent;
}

function normalizedNode(value: unknown): IBehaviorNodeDefinition {
	return normalizeBehaviorGraph({ id: "node-normalization", name: "Node Normalization", root: value }).root;
}

/** Restores normalized Behavior Graph authoring and starts the shared preview runtime. */
export function restoreBehaviorTrees(scene: Scene): void {
	const values = authored(scene);
	validateBehaviorGraphs(values);
	scene.metadata ??= {};
	scene.metadata.babylonEditorBehaviorTrees = values;
	configureBehaviorTrees(scene as any);
}

export function listBehaviorTrees(scene: Scene): any {
	return { trees: structuredClone(authored(scene)) };
}

export function getBehaviorTree(scene: Scene, data: any): any {
	return { tree: structuredClone(graph(authored(scene), data)) };
}

export function createBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = authored(scene);
	if (previous.some((value) => value.name.trim().toLowerCase() === data.name.trim().toLowerCase())) {
		throw new Error(`Behavior graph "${data.name}" already exists.`);
	}
	const value = normalizeBehaviorGraph({
		version: 2,
		revision: 1,
		id: data.id ?? createBehaviorGraphId("behavior"),
		name: data.name.trim(),
		enabled: data.enabled ?? true,
		autoStart: data.autoStart ?? data.autoRun ?? false,
		startEvent: data.startEvent,
		agentNodeId: data.agentNodeId,
		blackboard: data.blackboard ?? [],
		root:
			data.root ??
			({
				id: createBehaviorGraphId("node"),
				type: "sequence",
				position: [40, 40],
				enabled: true,
				children: [{ id: createBehaviorGraphId("node"), type: "action-log", position: [260, 40], enabled: true, children: [], value: "Behavior Graph started" }],
			} satisfies Partial<IBehaviorNodeDefinition>),
	});
	publish(scene, [...previous, value]);
	refresh(options);
	return structuredClone(value);
}

export function setBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = mutate(scene, data, (value) => {
		const changes = data.changes ?? data;
		const normalized = normalizeBehaviorGraph({ ...value, ...changes, id: value.id, revision: value.revision, version: 2 });
		Object.assign(value, normalized, { revision: value.revision });
	});
	refresh(options);
	return result;
}

export function deleteBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = authored(scene);
	const value = graph(previous, data);
	assertRevision(value, data.expectedRevision);
	for (const candidate of previous) {
		let referenced = false;
		visitBehaviorNodes(candidate.root, (node) => {
			if (node.subgraphId === value.id) {
				referenced = true;
			}
		});
		if (referenced) {
			throw new Error(`Behavior graph "${value.name}" is referenced by "${candidate.name}".`);
		}
	}
	publish(
		scene,
		previous.filter((candidate) => candidate.id !== value.id)
	);
	refresh(options);
	return { deleted: true, id: value.id, revision: value.revision };
}

export function validateBehaviorTreeCollection(scene: Scene): any {
	const values = authored(scene);
	validateBehaviorGraphs(values);
	return { valid: true, graphCount: values.length };
}

export function createBehaviorBlackboardVariable(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IBehaviorBlackboardVariable;
	const result = mutate(scene, data, (value) => {
		created = {
			id: data.variable.id ?? createBehaviorGraphId("blackboard"),
			name: data.variable.name.trim(),
			type: data.variable.type ?? "boolean",
			scope: data.variable.scope ?? "graph",
			exposed: data.variable.exposed ?? false,
			defaultValue: structuredClone(
				data.variable.defaultValue === undefined ? getDefaultBehaviorBlackboardValue(data.variable.type ?? "boolean") : data.variable.defaultValue
			),
		};
		value.blackboard.push(created);
	});
	refresh(options);
	return { graphId: result.id, graphRevision: result.revision, variable: structuredClone(created) };
}

export function setBehaviorBlackboardVariable(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IBehaviorBlackboardVariable;
	const result = mutate(scene, data, (value) => {
		const index = value.blackboard.findIndex((candidate) => candidate.id === data.variableId);
		if (index < 0) {
			throw new Error(`Behavior Blackboard variable "${data.variableId}" was not found.`);
		}
		updated = { ...value.blackboard[index], ...structuredClone(data.changes), id: value.blackboard[index].id };
		value.blackboard[index] = updated;
	});
	refresh(options);
	return { graphId: result.id, graphRevision: result.revision, variable: structuredClone(updated) };
}

export function deleteBehaviorBlackboardVariable(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = mutate(scene, data, (value) => {
		let referenced = false;
		visitBehaviorNodes(value.root, (node) => {
			if (node.variableId === data.variableId || node.utility?.variableId === data.variableId) {
				referenced = true;
			}
		});
		if (referenced) {
			throw new Error("Behavior Blackboard variable is still referenced by a node.");
		}
		const index = value.blackboard.findIndex((candidate) => candidate.id === data.variableId);
		if (index < 0) {
			throw new Error(`Behavior Blackboard variable "${data.variableId}" was not found.`);
		}
		value.blackboard.splice(index, 1);
	});
	refresh(options);
	return { deleted: true, graphId: result.id, graphRevision: result.revision, variableId: data.variableId };
}

export function createBehaviorTreeNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IBehaviorNodeDefinition;
	const result = mutate(scene, data, (value) => {
		const parent = findBehaviorNode(value.root, data.parentId);
		if (!parent) {
			throw new Error(`Behavior parent node "${data.parentId}" was not found.`);
		}
		created = normalizedNode({ ...data.node, id: data.node.id ?? createBehaviorGraphId("node"), children: data.node.children ?? [] });
		const index = data.index === undefined ? parent.children.length : data.index;
		if (!Number.isInteger(index) || index < 0 || index > parent.children.length) {
			throw new Error("Behavior child index is outside the parent range.");
		}
		parent.children.splice(index, 0, created);
	});
	refresh(options);
	return { graphId: result.id, graphRevision: result.revision, node: structuredClone(created) };
}

export function setBehaviorTreeNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IBehaviorNodeDefinition;
	const result = mutate(scene, data, (value) => {
		const current = findBehaviorNode(value.root, data.nodeId);
		if (!current) {
			throw new Error(`Behavior node "${data.nodeId}" was not found.`);
		}
		updated = normalizedNode({ ...current, ...structuredClone(data.changes), id: current.id });
		Object.assign(current, updated);
	});
	refresh(options);
	return { graphId: result.id, graphRevision: result.revision, node: structuredClone(updated) };
}

export function deleteBehaviorTreeNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = mutate(scene, data, (value) => {
		if (value.root.id === data.nodeId) {
			throw new Error("The root behavior node cannot be deleted; replace it with set_behavior_tree.");
		}
		const parent = findParent(value.root, data.nodeId);
		if (!parent) {
			throw new Error(`Behavior node "${data.nodeId}" was not found.`);
		}
		parent.children.splice(
			parent.children.findIndex((child) => child.id === data.nodeId),
			1
		);
	});
	refresh(options);
	return { deleted: true, graphId: result.id, graphRevision: result.revision, nodeId: data.nodeId };
}

export function moveBehaviorTreeNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = mutate(scene, data, (value) => {
		if (value.root.id === data.nodeId) {
			throw new Error("The root behavior node cannot be moved.");
		}
		const sourceParent = findParent(value.root, data.nodeId);
		const current = findBehaviorNode(value.root, data.nodeId);
		const targetParent = findBehaviorNode(value.root, data.parentId);
		if (!sourceParent || !current || !targetParent) {
			throw new Error("Behavior source node or target parent was not found.");
		}
		let descendant = false;
		visitBehaviorNodes(current, (node) => {
			if (node.id === targetParent.id) {
				descendant = true;
			}
		});
		if (descendant) {
			throw new Error("A behavior node cannot be moved into its own descendant.");
		}
		sourceParent.children.splice(sourceParent.children.indexOf(current), 1);
		const index = data.index === undefined ? targetParent.children.length : data.index;
		if (!Number.isInteger(index) || index < 0 || index > targetParent.children.length) {
			throw new Error("Behavior child index is outside the target parent range.");
		}
		targetParent.children.splice(index, 0, current);
	});
	refresh(options);
	return { moved: true, graphId: result.id, graphRevision: result.revision, nodeId: data.nodeId, parentId: data.parentId };
}

export function runBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!getBehaviorGraphRuntime(scene as any)) {
		configureBehaviorTrees(scene as any);
	}
	const state = runtime(scene).startGraph(identifier(data));
	refresh(options);
	return { id: state.graphId, status: state.status, success: state.status === "succeeded", executedNodeIds: Object.keys(state.nodeStatuses), state };
}

export function reloadBehaviorTreeRuntime(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const value = configureBehaviorTrees(scene as any);
	refresh(options);
	return { reloaded: true, states: value.getStates() };
}

export function getBehaviorTreeRuntime(scene: Scene, data: any): any {
	const value = runtime(scene);
	return data.id || data.name ? { state: value.getGraphState(identifier(data)), trace: value.getTrace() } : { states: value.getStates(), trace: value.getTrace() };
}

export function startBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = runtime(scene).startGraph(identifier(data));
	refresh(options);
	return state;
}

export function stopBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = runtime(scene).stopGraph(identifier(data));
	refresh(options);
	return state;
}

export function tickBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = runtime(scene).tickGraph(identifier(data), data.deltaSeconds ?? 0);
	refresh(options);
	return state;
}

export function dispatchBehaviorTreeEvent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const states = runtime(scene).dispatchEvent(data.eventName, data.payload, data.id || data.name ? identifier(data) : undefined);
	refresh(options);
	return { eventName: data.eventName, states };
}

export function setBehaviorTreeRuntimeBlackboard(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!!data.variableId === !!data.variableName) {
		throw new Error("Provide exactly one Behavior Blackboard variableId or variableName.");
	}
	const state = runtime(scene).setBlackboardValue(identifier(data), data.variableId ?? data.variableName, data.value);
	refresh(options);
	return state;
}

export function setBehaviorTreeBreakpoints(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = runtime(scene).setBreakpoints(identifier(data), data.nodeIds);
	refresh(options);
	return state;
}

export function continueBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = runtime(scene).continueGraph(identifier(data));
	refresh(options);
	return state;
}

export function stepBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const state = runtime(scene).stepGraph(identifier(data), data.deltaSeconds ?? 0);
	refresh(options);
	return state;
}

export function clearBehaviorTreeTrace(scene: Scene, _data: any, options: IMCPActionOptions): any {
	runtime(scene).clearTrace();
	refresh(options);
	return { cleared: true };
}
