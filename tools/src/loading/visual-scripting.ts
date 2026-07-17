import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

function execute(scene: Scene, graph: any): string[] {
	const variables: Record<string, any> = structuredClone(graph.variables ?? {});
	const nodes = new Map<string, any>((graph.nodes?.map((node: any) => [node.id, node]) ?? []) as Array<[string, any]>);
	const outgoing = new Map<string, string[]>();
	for (const edge of graph.edges ?? []) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
	const queue = (graph.nodes ?? []).filter((node: any) => node.type === "event-start").map((node: any) => node.id);
	if (!queue.length) queue.push(...nodes.keys());
	const visited = new Set<string>();
	const executed: string[] = [];
	while (queue.length) {
		const id = queue.shift()!;
		if (visited.has(id)) continue;
		visited.add(id);
		const node = nodes.get(id);
		if (node?.type === "set-variable") {
			variables[node.variable] = resolveValue(node.value, variables);
			executed.push(node.id);
		} else if (node?.type !== "event-start") {
			const target: any = scene.getNodeById(node.nodeId);
			if (!target?.position) throw new Error(`Visual script node "${node.id}" targets missing/non-transform node "${node.nodeId}".`);
			const actionValue = resolveValue(node.value, variables);
			if (node.type === "set-position") target.position.copyFrom(Vector3.FromArray(actionValue ?? [0, 0, 0]));
			if (node.type === "translate") target.position.addInPlace(Vector3.FromArray(actionValue ?? [0, 0, 0]));
			if (node.type === "set-enabled") target.setEnabled?.(actionValue === true);
			executed.push(node.id);
		}
		queue.push(...(outgoing.get(id) ?? []));
	}
	graph.lastExecution = { at: new Date().toISOString(), nodes: executed, variables };
	return executed;
}

function resolveValue(value: any, variables: Record<string, any>): any {
	if (value && typeof value === "object" && !Array.isArray(value) && "variable" in value) return variables[value.variable];
	return value;
}

/** Restores persisted auto-run visual script graphs in exported games. */
export function configureVisualScriptGraphs(scene: Scene): void {
	for (const graph of scene.metadata?.babylonEditorVisualScriptGraphs ?? []) {
		if (!graph.autoRun) continue;
		try {
			execute(scene, graph);
		} catch (error) {
			console.warn(`Failed to run visual graph ${graph.id}:`, error);
		}
	}
}
