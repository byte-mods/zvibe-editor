import { Scene, Tools, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";

function graphs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorVisualScriptGraphs ??= []);
}
function graph(scene: Scene, data: any): any {
	const value = graphs(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) throw new Error("Visual script graph not found. Provide id (preferred) or name.");
	return value;
}
function validate(value: any): void {
	const ids = new Set(value.nodes.map((node: any) => node.id));
	if (ids.size !== value.nodes.length) throw new Error("Visual script node IDs must be unique.");
	if (value.edges.some((edge: any) => !ids.has(edge.from) || !ids.has(edge.to))) throw new Error("Every visual script edge must connect existing nodes.");
	for (const node of value.nodes) {
		if (!["event-start", "set-position", "translate", "set-enabled", "set-variable"].includes(node.type))
			throw new Error(`Unsupported visual script node type "${node.type}".`);
		if (!["event-start", "set-variable"].includes(node.type) && !node.nodeId) throw new Error(`${node.type} nodes require nodeId.`);
		if (node.type === "set-variable" && typeof node.variable !== "string") throw new Error("set-variable nodes require a variable name.");
		if (node.type === "set-variable" && !(node.variable in value.variables)) throw new Error(`Visual script variable "${node.variable}" must be declared in graph.variables.`);
		if (node.value?.variable !== undefined && (!(typeof node.value.variable === "string") || !(node.value.variable in value.variables)))
			throw new Error(`Visual script node "${node.id}" references an undeclared variable.`);
		if (
			node.position !== undefined &&
			(!Array.isArray(node.position) || node.position.length !== 2 || node.position.some((coordinate: unknown) => !Number.isFinite(coordinate)))
		)
			throw new Error(`Visual script node "${node.id}" position must be a finite [x, y] pair.`);
	}
}
function resolveValue(value: any, variables: Record<string, any>): any {
	if (value && typeof value === "object" && !Array.isArray(value) && "variable" in value) return variables[value.variable];
	return value;
}
function execute(scene: Scene, value: any): any {
	const variables: Record<string, any> = structuredClone(value.variables ?? {});
	const nodes = new Map(value.nodes.map((node: any) => [node.id, node]));
	const outgoing = new Map<string, string[]>();
	for (const edge of value.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
	const queue = value.nodes.filter((node: any) => node.type === "event-start").map((node: any) => node.id);
	if (!queue.length) queue.push(...value.nodes.map((node: any) => node.id));
	const visited = new Set<string>();
	const executed: string[] = [];
	while (queue.length) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		const node: any = nodes.get(id)!;
		if (node.type === "set-variable") {
			variables[node.variable] = resolveValue(node.value, variables);
			executed.push(node.id);
		} else if (node.type !== "event-start") {
			const target = scene.getNodeById(node.nodeId) as any;
			if (!target?.position) throw new Error(`Visual script node "${node.id}" targets missing/non-transform node "${node.nodeId}".`);
			const actionValue = resolveValue(node.value, variables);
			if (node.type === "set-position") target.position.copyFrom(Vector3.FromArray(actionValue ?? [0, 0, 0]));
			if (node.type === "translate") target.position.addInPlace(Vector3.FromArray(actionValue ?? [0, 0, 0]));
			if (node.type === "set-enabled") target.setEnabled?.(actionValue === true);
			executed.push(node.id);
		}
		queue.push(...(outgoing.get(id) ?? []));
	}
	value.lastExecution = { at: new Date().toISOString(), nodes: executed, variables };
	return { id: value.id, executedNodeIds: executed };
}

/** Runs saved auto-run visual graphs once scene nodes have loaded. */
export function restoreVisualScriptGraphs(scene: Scene): void {
	for (const value of graphs(scene))
		if (value.autoRun) {
			try {
				execute(scene, value);
			} catch (error) {
				console.warn(`Failed to run visual graph ${value.id}:`, error);
			}
		}
}
export function listVisualScriptGraphs(scene: Scene): any {
	return { graphs: structuredClone(graphs(scene)) };
}
export function createVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (graphs(scene).some((value) => value.name === data.name)) throw new Error(`Visual script graph "${data.name}" already exists.`);
	const value = {
		id: data.id ?? Tools.RandomId(),
		name: data.name,
		variables: data.variables ?? {},
		nodes: data.nodes ?? [{ id: "start", type: "event-start" }],
		edges: data.edges ?? [],
		autoRun: data.autoRun ?? false,
	};
	validate(value);
	graphs(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
export function setVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = graph(scene, data);
	if (data.name !== undefined) value.name = data.name;
	if (data.nodes !== undefined) value.nodes = data.nodes;
	if (data.edges !== undefined) value.edges = data.edges;
	if (data.variables !== undefined) value.variables = data.variables;
	if (data.autoRun !== undefined) value.autoRun = data.autoRun;
	validate(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Persists a freeform canvas position for one visual-script node without replacing the graph. */
export function setVisualScriptNodePosition(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = graph(scene, data);
	const node = value.nodes.find((candidate: any) => candidate.id === data.nodeId);
	if (!node) throw new Error(`Visual script node "${data.nodeId}" was not found in graph "${value.name}".`);
	if (!Array.isArray(data.position) || data.position.length !== 2 || data.position.some((coordinate: unknown) => !Number.isFinite(coordinate)))
		throw new Error("Visual script node position must be a finite [x, y] pair.");
	node.position = [Math.max(0, Math.min(10000, data.position[0])), Math.max(0, Math.min(10000, data.position[1]))];
	options.editor.layout.inspector.forceUpdate();
	return { graphId: value.id, nodeId: node.id, position: [...node.position] };
}
export function runVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = execute(scene, graph(scene, data));
	options.editor.layout.inspector.forceUpdate();
	return result;
}
export function deleteVisualScriptGraph(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = graph(scene, data);
	graphs(scene).splice(graphs(scene).indexOf(value), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}
