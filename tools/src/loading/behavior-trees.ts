import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

type IBehaviorNode = { id: string; type: string; nodeId?: string; value?: any; children?: IBehaviorNode[] };
function run(scene: Scene, node: IBehaviorNode): boolean {
	if (node.type === "sequence") return node.children?.every((child) => run(scene, child)) ?? false;
	if (node.type === "selector") return node.children?.some((child) => run(scene, child)) ?? false;
	if (node.type === "inverter") return !run(scene, node.children?.[0]!);
	const target = scene.getNodeById(node.nodeId!) as any;
	if (!target) return false;
	if (node.type === "condition-node-enabled") return target.isEnabled?.() === (node.value ?? true);
	if (node.type === "action-set-enabled") return (target.setEnabled?.(node.value === true), true);
	if (node.type === "action-set-position" && target.position) return (target.position.copyFrom(Vector3.FromArray(node.value ?? [0, 0, 0])), true);
	return false;
}
/** Runs exported auto-run behavior trees after scene loading. */
export function configureBehaviorTrees(scene: Scene): void {
	const trees = scene.metadata?.babylonEditorBehaviorTrees;
	if (Array.isArray(trees)) for (const tree of trees) if (tree.autoRun) run(scene, tree.root);
}
