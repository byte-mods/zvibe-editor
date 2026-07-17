import { Scene, Tools, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";

type IBehaviorNode = { id: string; type: string; nodeId?: string; value?: any; children?: IBehaviorNode[] };

function trees(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorBehaviorTrees ??= []);
}
function tree(scene: Scene, data: any): any {
	const value = trees(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) throw new Error("Behavior tree not found. Provide id (preferred) or name.");
	return value;
}
function validate(node: IBehaviorNode, ids = new Set<string>()): void {
	if (ids.has(node.id)) throw new Error(`Behavior node ID "${node.id}" is duplicated.`);
	ids.add(node.id);
	if (!["sequence", "selector", "inverter", "condition-node-enabled", "action-set-enabled", "action-set-position"].includes(node.type))
		throw new Error(`Unsupported behavior node type "${node.type}".`);
	if (["sequence", "selector", "inverter"].includes(node.type) && !node.children?.length) throw new Error(`${node.type} requires child nodes.`);
	if (node.type === "inverter" && node.children!.length !== 1) throw new Error("inverter requires exactly one child node.");
	if (node.type.startsWith("condition-") || node.type.startsWith("action-")) if (!node.nodeId) throw new Error(`${node.type} requires nodeId.`);
	node.children?.forEach((child) => validate(child, ids));
}
function executeNode(scene: Scene, node: IBehaviorNode, visited: string[]): boolean {
	visited.push(node.id);
	if (node.type === "sequence") return node.children!.every((child) => executeNode(scene, child, visited));
	if (node.type === "selector") return node.children!.some((child) => executeNode(scene, child, visited));
	if (node.type === "inverter") return !executeNode(scene, node.children![0], visited);
	const target = scene.getNodeById(node.nodeId!) as any;
	if (!target) return false;
	if (node.type === "condition-node-enabled") return target.isEnabled?.() === (node.value ?? true);
	if (node.type === "action-set-enabled") {
		target.setEnabled?.(node.value === true);
		return true;
	}
	if (!target.position) return false;
	target.position.copyFrom(Vector3.FromArray(node.value ?? [0, 0, 0]));
	return true;
}
export function restoreBehaviorTrees(scene: Scene): void {
	for (const value of trees(scene)) if (value.autoRun) executeBehaviorTree(scene, value);
}
export function executeBehaviorTree(scene: Scene, value: any): any {
	const visited: string[] = [];
	const success = executeNode(scene, value.root, visited);
	value.lastExecution = { at: new Date().toISOString(), success, nodeIds: visited };
	return { id: value.id, success, executedNodeIds: visited };
}
export function listBehaviorTrees(scene: Scene): any {
	return { trees: structuredClone(trees(scene)) };
}
export function createBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (trees(scene).some((value) => value.name === data.name)) throw new Error(`Behavior tree "${data.name}" already exists.`);
	const value = { id: data.id ?? Tools.RandomId(), name: data.name, root: data.root, autoRun: data.autoRun ?? false };
	validate(value.root);
	trees(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
export function setBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = tree(scene, data);
	if (data.name !== undefined) value.name = data.name;
	if (data.root !== undefined) value.root = data.root;
	if (data.autoRun !== undefined) value.autoRun = data.autoRun;
	validate(value.root);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
export function runBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = executeBehaviorTree(scene, tree(scene, data));
	options.editor.layout.inspector.forceUpdate();
	return result;
}
export function deleteBehaviorTree(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = tree(scene, data);
	trees(scene).splice(trees(scene).indexOf(value), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}
