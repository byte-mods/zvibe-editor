import { Scene } from "babylonjs";
import {
	configureVisualScriptGraphs,
	createVisualScriptId,
	getGraphToolkitDataTypeStyle,
	getGraphToolkitNodePresentation,
	getGraphToolkitPortPresentation,
	getVisualScriptNodePorts,
	getVisualScriptVariableNodes,
	getDefaultVisualScriptValue,
	IVisualScriptEdgeDefinition,
	IVisualScriptGraphDefinition,
	IVisualScriptGroupDefinition,
	IVisualScriptNodeDefinition,
	IVisualScriptStateDefinition,
	IVisualScriptTransitionDefinition,
	IVisualScriptVariableDefinition,
	normalizeVisualScriptGraph,
	normalizeVisualScriptGraphs,
	isVisualScriptNodeConnected,
	removeVisualScriptVariable,
	trySetVisualScriptConstantValue,
	trySetVisualScriptPortValue,
	validateVisualScriptGraphs,
	VisualScriptRuntime,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

export interface IVisualScriptAuthoringSnapshot {
	hadMetadata: boolean;
	hadGraphs: boolean;
	graphs: unknown;
}

export function getVisualScriptAuthoringSnapshot(scene: Scene): IVisualScriptAuthoringSnapshot {
	return {
		hadMetadata: scene.metadata !== null && scene.metadata !== undefined,
		hadGraphs: Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorVisualScriptGraphs"),
		graphs: structuredClone(scene.metadata?.babylonEditorVisualScriptGraphs),
	};
}

export function restoreVisualScriptAuthoringSnapshot(scene: Scene, snapshot: IVisualScriptAuthoringSnapshot, options: IMCPActionOptions): void {
	if (!snapshot.hadMetadata) {
		scene.metadata = null;
	} else {
		scene.metadata ??= {};
		if (snapshot.hadGraphs) {
			scene.metadata.babylonEditorVisualScriptGraphs = structuredClone(snapshot.graphs);
		} else {
			delete scene.metadata.babylonEditorVisualScriptGraphs;
		}
	}
	if ((scene as any).visualScripts) {
		configureVisualScriptGraphs(scene as any);
	}
	refresh(options);
}

function authored(scene: Scene): IVisualScriptGraphDefinition[] {
	return normalizeVisualScriptGraphs(scene.metadata?.babylonEditorVisualScriptGraphs);
}

function findGraph(values: IVisualScriptGraphDefinition[], data: any): IVisualScriptGraphDefinition {
	if (!!data.id === !!data.name) {
		throw new Error("Provide exactly one visual script graph id or name.");
	}
	const graph = values.find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!graph) {
		throw new Error("Visual script graph not found.");
	}
	return graph;
}

function assertRevision(graph: IVisualScriptGraphDefinition, expected: unknown): void {
	if (!Number.isInteger(expected)) {
		throw new Error(`Visual script graph "${graph.name}" requires expectedRevision.`);
	}
	if (graph.revision !== expected) {
		throw new Error(`Visual script graph "${graph.name}" revision is stale: expected ${expected}, current ${graph.revision}.`);
	}
}

function refresh(options: IMCPActionOptions): void {
	options.editor.layout.inspector.forceUpdate();
}

function publish(scene: Scene, next: IVisualScriptGraphDefinition[]): void {
	validateVisualScriptGraphs(next);
	const hadMetadata = scene.metadata !== null && scene.metadata !== undefined;
	const hadGraphs = Object.prototype.hasOwnProperty.call(scene.metadata ?? {}, "babylonEditorVisualScriptGraphs");
	const previousRaw = structuredClone(scene.metadata?.babylonEditorVisualScriptGraphs);
	scene.metadata ??= {};
	const hadRuntime = !!(scene as any).visualScripts;
	scene.metadata.babylonEditorVisualScriptGraphs = next;
	if (!hadRuntime) {
		return;
	}
	try {
		configureVisualScriptGraphs(scene as any);
	} catch (error) {
		if (!hadMetadata) {
			scene.metadata = null;
		} else if (hadGraphs) {
			scene.metadata.babylonEditorVisualScriptGraphs = previousRaw;
		} else {
			delete scene.metadata.babylonEditorVisualScriptGraphs;
		}
		configureVisualScriptGraphs(scene as any);
		throw error;
	}
}

function mutateGraph(scene: Scene, data: any, mutation: (graph: IVisualScriptGraphDefinition, all: IVisualScriptGraphDefinition[]) => void): IVisualScriptGraphDefinition {
	const previous = authored(scene);
	const next = structuredClone(previous);
	const graph = findGraph(next, data);
	assertRevision(graph, data.expectedRevision);
	mutation(graph, next);
	graph.revision++;
	publish(scene, next);
	return structuredClone(graph);
}

function runtime(scene: Scene): VisualScriptRuntime {
	const value = (scene as any).visualScripts as VisualScriptRuntime | undefined;
	if (!value) {
		throw new Error("Visual scripting runtime is not active. Start or restore the scene runtime first.");
	}
	return value;
}

function runtimeGraphIdentifier(data: any): string {
	if (!!data.id === !!data.name) {
		throw new Error("Provide exactly one visual script graph id or name.");
	}
	return data.id ?? data.name;
}

function findNode(graph: IVisualScriptGraphDefinition, nodeId: string): IVisualScriptNodeDefinition {
	const value = graph.nodes.find((candidate) => candidate.id === nodeId);
	if (!value) {
		throw new Error(`Visual script node "${nodeId}" was not found.`);
	}
	return value;
}

function replaceById<T extends { id: string }>(values: T[], id: string, changes: Partial<T>, label: string): T {
	const index = values.findIndex((candidate) => candidate.id === id);
	if (index < 0) {
		throw new Error(`${label} "${id}" was not found.`);
	}
	values[index] = { ...values[index], ...structuredClone(changes), id };
	return values[index];
}

/** Lists normalized version-2 Flow and State graph authoring without dirtying legacy metadata. */
export function listVisualScriptGraphs(scene: Scene): any {
	return { graphs: structuredClone(authored(scene)) };
}

export function getVisualScriptGraph(scene: Scene, data: any): any {
	return { graph: structuredClone(findGraph(authored(scene), data)) };
}

/** Advertises the complete reusable graph-authoring contract to external clients. */
export function getGraphToolkitCapabilities(_scene: Scene): any {
	return {
		version: 1,
		expression: { maximumCharacters: 2048, maximumInputs: 16, operators: ["+", "-", "*", "/", "%", "^", "==", "!=", "<", "<=", ">", ">=", "&&", "||", "?:"] },
		valueTypes: ["untyped", "any", "boolean", "number", "string", "vector2", "vector3", "node"],
		collections: { kinds: ["list", "array"], maximumEditableElements: 50 },
		presentation: {
			customTypeStyles: true,
			nodeTitles: true,
			categories: true,
			subtitles: true,
			tooltips: true,
			icons: true,
			colors: true,
			multilinePorts: true,
			multilineOptions: true,
			verticalPorts: true,
		},
		queries: { nodeConnectivity: true, orderedVariableNodes: true },
		mutations: { exactRevision: true, constantValues: true, portFallbackValues: true, removeUnreferencedVariables: true, subgraphOptions: true },
	};
}

/** Resolves presentation and connection facts for one authored node without mutating the graph. */
export function inspectGraphToolkitNode(scene: Scene, data: any): any {
	const graph = findGraph(authored(scene), data);
	const node = findNode(graph, data.nodeId);
	const ports = getVisualScriptNodePorts(node);
	return {
		graphId: graph.id,
		graphRevision: graph.revision,
		node: structuredClone(node),
		connected: isVisualScriptNodeConnected(graph, node.id),
		presentation: getGraphToolkitNodePresentation(node),
		ports,
		portPresentation: Object.values(ports)
			.flat()
			.map((port) => {
				const detail = getGraphToolkitPortPresentation(node, port);
				return { ...detail, style: getGraphToolkitDataTypeStyle(graph, detail.dataType ?? detail.type) };
			}),
	};
}

/** Pages variable-node references in stable graph order and reports connectivity. */
export function listVisualScriptVariableNodes(scene: Scene, data: any): any {
	const graph = findGraph(authored(scene), data);
	const variable = graph.variables.find((candidate) => candidate.id === data.variableId || candidate.name === data.variableName);
	if (!variable || !!data.variableId === !!data.variableName) {
		throw new Error("Provide exactly one existing visual script variableId or variableName.");
	}
	const values = getVisualScriptVariableNodes(graph, variable.id);
	const offset = Math.min(Math.max(data.offset ?? 0, 0), values.length);
	const limit = Math.min(Math.max(data.limit ?? 100, 1), 256);
	return {
		graphId: graph.id,
		graphRevision: graph.revision,
		variable: structuredClone(variable),
		offset,
		limit,
		total: values.length,
		hasMore: offset + limit < values.length,
		nodes: structuredClone(values.slice(offset, offset + limit)),
	};
}

/** Replaces the graph's bounded custom type-style map under exact revision control. */
export function setGraphToolkitTypeStyles(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => (value.typeStyles = structuredClone(data.typeStyles)));
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, typeStyles: structuredClone(graph.typeStyles) };
}

/** Updates one editable Constant value through the shared collection-aware helper. */
export function setVisualScriptConstantValue(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		if (!trySetVisualScriptConstantValue(value, data.nodeId, data.value)) {
			throw new Error(`Visual script Constant node "${data.nodeId}" was not found.`);
		}
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, node: structuredClone(findNode(graph, data.nodeId)) };
}

/** Sets an unconnected value-port fallback while rejecting connected or missing ports. */
export function setVisualScriptPortValue(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		if (!trySetVisualScriptPortValue(value, data.nodeId, data.port, data.value)) {
			throw new Error(`Visual script value port "${data.nodeId}.${data.port}" is missing or already connected.`);
		}
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, node: structuredClone(findNode(graph, data.nodeId)), port: data.port, value: structuredClone(data.value) };
}

/** Removes an unreferenced variable through the public Graph Toolkit convenience contract. */
export function removeVisualScriptVariableFromGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	let variableId = data.variableId;
	const graph = mutateGraph(scene, data, (value) => {
		const variable = value.variables.find((candidate) => candidate.id === data.variableId || candidate.name === data.variableName);
		if (!variable || !!data.variableId === !!data.variableName) {
			throw new Error("Provide exactly one existing visual script variableId or variableName.");
		}
		variableId = variable.id;
		if (!removeVisualScriptVariable(value, variable.id)) {
			throw new Error(`Visual script variable "${variable.name}" is still referenced.`);
		}
	});
	refresh(options);
	return { removed: true, graphId: graph.id, graphRevision: graph.revision, variableId };
}

export function createVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = authored(scene);
	if (previous.some((graph) => graph.name.trim().toLowerCase() === data.name.trim().toLowerCase())) {
		throw new Error(`Visual script graph "${data.name}" already exists.`);
	}
	const id = data.id ?? createVisualScriptId("graph");
	const kind = data.kind ?? "flow";
	const graph = normalizeVisualScriptGraph({
		version: 2,
		revision: 1,
		id,
		name: data.name.trim(),
		kind,
		enabled: data.enabled ?? true,
		autoStart: data.autoStart ?? data.autoRun ?? false,
		targetNodeId: data.targetNodeId,
		variables: data.variables ?? [],
		nodes: data.nodes ?? (kind === "flow" ? [{ id: "start", type: "event-start", position: [20, 20] }] : []),
		edges: data.edges ?? [],
		groups: data.groups ?? [],
		states: data.states ?? (kind === "state" ? [{ id: "initial", name: "Initial", position: [20, 20], initial: true }] : []),
		transitions: data.transitions ?? [],
		typeStyles: data.typeStyles ?? [],
	});
	const next = [...previous, graph];
	publish(scene, next);
	refresh(options);
	return structuredClone(graph);
}

export function setVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		const normalized = normalizeVisualScriptGraph({
			...value,
			...(data.changes ?? data),
			id: value.id,
			revision: value.revision,
			version: 2,
		});
		Object.assign(value, normalized, { revision: value.revision });
	});
	refresh(options);
	return graph;
}

export function deleteVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const previous = authored(scene);
	const graph = findGraph(previous, data);
	assertRevision(graph, data.expectedRevision);
	for (const candidate of previous) {
		if (
			candidate.nodes.some((node) => node.subgraphId === graph.id) ||
			candidate.states.some((state) => [state.onEnterGraphId, state.onUpdateGraphId, state.onExitGraphId].includes(graph.id))
		) {
			throw new Error(`Visual script graph "${graph.name}" is referenced by graph "${candidate.name}".`);
		}
	}
	const next = previous.filter((candidate) => candidate.id !== graph.id);
	publish(scene, next);
	refresh(options);
	return { deleted: true, id: graph.id, revision: graph.revision };
}

export function createVisualScriptVariable(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IVisualScriptVariableDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		created = {
			id: data.variable.id ?? createVisualScriptId("variable"),
			name: data.variable.name.trim(),
			scope: data.variable.scope ?? "graph",
			type: data.variable.type ?? "any",
			defaultValue: structuredClone(data.variable.defaultValue === undefined ? getDefaultVisualScriptValue(data.variable.type ?? "any") : data.variable.defaultValue),
			...(data.variable.collection !== undefined ? { collection: data.variable.collection } : {}),
			...(data.variable.dataType !== undefined ? { dataType: data.variable.dataType } : {}),
		};
		value.variables.push(created);
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, variable: structuredClone(created) };
}

export function setVisualScriptVariable(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IVisualScriptVariableDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		updated = replaceById(value.variables, data.variableId, data.changes, "Visual script variable");
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, variable: structuredClone(updated) };
}

export function deleteVisualScriptVariable(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		if (value.nodes.some((node) => node.variableId === data.variableId) || value.transitions.some((transition) => transition.conditionVariableId === data.variableId)) {
			throw new Error("Visual script variable is still referenced.");
		}
		const index = value.variables.findIndex((candidate) => candidate.id === data.variableId);
		if (index < 0) {
			throw new Error(`Visual script variable "${data.variableId}" was not found.`);
		}
		value.variables.splice(index, 1);
	});
	refresh(options);
	return { deleted: true, graphId: graph.id, graphRevision: graph.revision, variableId: data.variableId };
}

export function createVisualScriptNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IVisualScriptNodeDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		created = {
			id: data.node.id ?? createVisualScriptId("node"),
			type: data.node.type,
			position: data.node.position ?? [20, 20],
			enabled: data.node.enabled ?? true,
			...structuredClone(data.node),
		};
		value.nodes.push(created);
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, node: structuredClone(created), ports: getVisualScriptNodePorts(created) };
}

export function setVisualScriptNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IVisualScriptNodeDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		updated = replaceById(value.nodes, data.nodeId, data.changes, "Visual script node");
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, node: structuredClone(updated), ports: getVisualScriptNodePorts(updated) };
}

export function deleteVisualScriptNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		const index = value.nodes.findIndex((candidate) => candidate.id === data.nodeId);
		if (index < 0) {
			throw new Error(`Visual script node "${data.nodeId}" was not found.`);
		}
		value.nodes.splice(index, 1);
		value.edges = value.edges.filter((edge) => edge.from.nodeId !== data.nodeId && edge.to.nodeId !== data.nodeId);
		for (const group of value.groups) {
			group.nodeIds = group.nodeIds.filter((id) => id !== data.nodeId);
		}
	});
	refresh(options);
	return { deleted: true, graphId: graph.id, graphRevision: graph.revision, nodeId: data.nodeId };
}

export function setVisualScriptNodePosition(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		findNode(value, data.nodeId).position = [Math.max(0, Math.min(10000, data.position[0])), Math.max(0, Math.min(10000, data.position[1]))];
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, nodeId: data.nodeId, position: [...findNode(graph, data.nodeId).position] };
}

export function createVisualScriptEdge(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IVisualScriptEdgeDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		created = {
			id: data.edge.id ?? createVisualScriptId("edge"),
			kind: data.edge.kind,
			from: structuredClone(data.edge.from),
			to: structuredClone(data.edge.to),
			order: data.edge.order ?? value.edges.length,
		};
		value.edges.push(created);
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, edge: structuredClone(created) };
}

export function setVisualScriptEdge(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IVisualScriptEdgeDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		updated = replaceById(value.edges, data.edgeId, data.changes, "Visual script edge");
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, edge: structuredClone(updated) };
}

export function deleteVisualScriptEdge(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		const index = value.edges.findIndex((candidate) => candidate.id === data.edgeId);
		if (index < 0) {
			throw new Error(`Visual script edge "${data.edgeId}" was not found.`);
		}
		value.edges.splice(index, 1);
	});
	refresh(options);
	return { deleted: true, graphId: graph.id, graphRevision: graph.revision, edgeId: data.edgeId };
}

export function createVisualScriptGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IVisualScriptGroupDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		created = {
			id: data.group.id ?? createVisualScriptId("group"),
			name: data.group.name.trim(),
			color: data.group.color ?? "#64748b",
			nodeIds: [...(data.group.nodeIds ?? [])],
		};
		value.groups.push(created);
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, group: structuredClone(created) };
}

export function setVisualScriptGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IVisualScriptGroupDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		updated = replaceById(value.groups, data.groupId, data.changes, "Visual script group");
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, group: structuredClone(updated) };
}

export function deleteVisualScriptGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		const index = value.groups.findIndex((candidate) => candidate.id === data.groupId);
		if (index < 0) {
			throw new Error(`Visual script group "${data.groupId}" was not found.`);
		}
		value.groups.splice(index, 1);
	});
	refresh(options);
	return { deleted: true, graphId: graph.id, graphRevision: graph.revision, groupId: data.groupId };
}

export function createVisualScriptState(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IVisualScriptStateDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		if (value.kind !== "state") {
			throw new Error("States can only be added to a State graph.");
		}
		created = {
			id: data.state.id ?? createVisualScriptId("state"),
			name: data.state.name.trim(),
			position: data.state.position ?? [20, 20],
			initial: data.state.initial ?? !value.states.length,
			...structuredClone(data.state),
		};
		if (created.initial) {
			value.states.forEach((state) => (state.initial = false));
		}
		value.states.push(created);
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, state: structuredClone(created) };
}

export function setVisualScriptState(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IVisualScriptStateDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		if (data.changes.initial === true) {
			value.states.forEach((state) => (state.initial = false));
		}
		updated = replaceById(value.states, data.stateId, data.changes, "Visual script state");
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, state: structuredClone(updated) };
}

export function deleteVisualScriptState(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		const index = value.states.findIndex((candidate) => candidate.id === data.stateId);
		if (index < 0) {
			throw new Error(`Visual script state "${data.stateId}" was not found.`);
		}
		if (value.states[index].initial) {
			throw new Error("Assign another initial state before deleting this state.");
		}
		value.states.splice(index, 1);
		value.transitions = value.transitions.filter((transition) => transition.fromStateId !== data.stateId && transition.toStateId !== data.stateId);
	});
	refresh(options);
	return { deleted: true, graphId: graph.id, graphRevision: graph.revision, stateId: data.stateId };
}

export function createVisualScriptTransition(scene: Scene, data: any, options: IMCPActionOptions): any {
	let created!: IVisualScriptTransitionDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		if (value.kind !== "state") {
			throw new Error("Transitions can only be added to a State graph.");
		}
		created = {
			id: data.transition.id ?? createVisualScriptId("transition"),
			fromStateId: data.transition.fromStateId,
			toStateId: data.transition.toStateId,
			eventName: data.transition.eventName ?? "update",
			...(data.transition.conditionVariableId ? { conditionVariableId: data.transition.conditionVariableId } : {}),
			invertCondition: data.transition.invertCondition ?? false,
			priority: data.transition.priority ?? value.transitions.length,
		};
		value.transitions.push(created);
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, transition: structuredClone(created) };
}

export function setVisualScriptTransition(scene: Scene, data: any, options: IMCPActionOptions): any {
	let updated!: IVisualScriptTransitionDefinition;
	const graph = mutateGraph(scene, data, (value) => {
		updated = replaceById(value.transitions, data.transitionId, data.changes, "Visual script transition");
	});
	refresh(options);
	return { graphId: graph.id, graphRevision: graph.revision, transition: structuredClone(updated) };
}

export function deleteVisualScriptTransition(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graph = mutateGraph(scene, data, (value) => {
		const index = value.transitions.findIndex((candidate) => candidate.id === data.transitionId);
		if (index < 0) {
			throw new Error(`Visual script transition "${data.transitionId}" was not found.`);
		}
		value.transitions.splice(index, 1);
	});
	refresh(options);
	return { deleted: true, graphId: graph.id, graphRevision: graph.revision, transitionId: data.transitionId };
}

export function validateVisualScriptGraph(scene: Scene, data: any): any {
	const values = authored(scene);
	const graph = findGraph(values, data);
	validateVisualScriptGraphs(values);
	return {
		valid: true,
		id: graph.id,
		revision: graph.revision,
		kind: graph.kind,
		counts: {
			variables: graph.variables.length,
			nodes: graph.nodes.length,
			edges: graph.edges.length,
			groups: graph.groups.length,
			states: graph.states.length,
			transitions: graph.transitions.length,
			typeStyles: graph.typeStyles?.length ?? 0,
		},
	};
}

/** Replaces a scene runtime after loading authored graphs. */
export function restoreVisualScriptGraphs(scene: Scene): void {
	configureVisualScriptGraphs(scene as any);
}

/** Rebuilds the live debugger/runtime from authored metadata without changing graph revisions. */
export function reloadVisualScriptRuntime(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = configureVisualScriptGraphs(scene as any);
	if (!value) {
		throw new Error("Visual scripting authoring is not present in the active scene.");
	}
	refresh(options);
	return value.getRuntime(data.offset ?? 0, data.limit ?? 100);
}

export function runVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const values = authored(scene);
	const graph = findGraph(values, data);
	const active = (scene as any).visualScripts as VisualScriptRuntime | undefined;
	const controller = active ?? new VisualScriptRuntime(scene as any, values);
	try {
		const state = graph.kind === "flow" ? controller.runGraph(graph.id, data.event ?? "start", data.payload, true) : controller.startGraph(graph.id);
		refresh(options);
		return state;
	} finally {
		if (!active) {
			controller.dispose();
		}
	}
}

export function getVisualScriptRuntime(scene: Scene, data: any): any {
	return runtime(scene).getRuntime(data.offset ?? 0, data.limit ?? 100);
}

export function startVisualScriptRuntimeGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = runtime(scene).startGraph(runtimeGraphIdentifier(data));
	refresh(options);
	return result;
}

export function stopVisualScriptRuntimeGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = runtime(scene).stopGraph(runtimeGraphIdentifier(data));
	refresh(options);
	return result;
}

export function dispatchVisualScriptEvent(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = runtime(scene).dispatchEvent(runtimeGraphIdentifier(data), data.event, data.payload);
	refresh(options);
	return result;
}

export function setVisualScriptBreakpoints(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = runtime(scene).setBreakpoints(runtimeGraphIdentifier(data), data.nodeIds);
	refresh(options);
	return result;
}

export function continueVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = runtime(scene).continueGraph(runtimeGraphIdentifier(data));
	refresh(options);
	return result;
}

export function stepVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = runtime(scene).stepGraph(runtimeGraphIdentifier(data));
	refresh(options);
	return result;
}

export function setVisualScriptRuntimeVariable(scene: Scene, data: any, options: IMCPActionOptions): any {
	const graphIdentifier = runtimeGraphIdentifier(data);
	if (!!data.variableId === !!data.variableName) {
		throw new Error("Provide exactly one visual script variable id or name.");
	}
	const result = runtime(scene).setVariable(graphIdentifier, data.variableId ?? data.variableName, data.value);
	refresh(options);
	return result;
}

export function clearVisualScriptTrace(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const cleared = runtime(scene).clearTrace();
	refresh(options);
	return { cleared };
}
