import { Component, ReactNode } from "react";

import { Scene, Tools } from "babylonjs";

import { Button } from "../../../ui/shadcn/ui/button";
import { Checkbox } from "../../../ui/shadcn/ui/checkbox";
import { Input } from "../../../ui/shadcn/ui/input";
import { createBehaviorTree, deleteBehaviorTree, listBehaviorTrees, runBehaviorTree, setBehaviorTree } from "../../../mcp/ai/behavior-trees";

import { Editor } from "../../main";

type BehaviorNodeType = "sequence" | "selector" | "inverter" | "condition-node-enabled" | "action-set-enabled" | "action-set-position";

interface IBehaviorNode {
	id: string;
	type: BehaviorNodeType;
	nodeId?: string;
	value?: any;
	children?: IBehaviorNode[];
}

interface IBehaviorTree {
	id: string;
	name: string;
	root: IBehaviorNode;
	autoRun: boolean;
	lastExecution?: { at: string; success: boolean; nodeIds: string[] };
}

export interface IEditorBehaviorTreesPanelProps {
	editor: Editor;
}

export interface IEditorBehaviorTreesPanelState {
	selectedTreeId: string | null;
}

/** Authors persisted behavior trees through the exact MCP action implementations used by external agents. */
export class EditorBehaviorTreesPanel extends Component<IEditorBehaviorTreesPanelProps, IEditorBehaviorTreesPanelState> {
	public constructor(props: IEditorBehaviorTreesPanelProps) {
		super(props);
		this.state = { selectedTreeId: null };
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const trees = this._getTrees(scene);
		const tree = trees.find((candidate) => candidate.id === this.state.selectedTreeId) ?? trees[0] ?? null;
		const targets = this._targets(scene);

		return (
			<div className="flex h-full flex-col gap-3 overflow-auto p-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-semibold">Behavior Trees</div>
						<div className="text-xs text-muted-foreground">Author persisted AI behavior through the same MCP tools used by Codex and Claude.</div>
					</div>
					<Button size="sm" disabled={!targets.length} onClick={() => this._create(scene)}>
						Create Tree
					</Button>
				</div>

				{!targets.length && <div className="rounded border border-destructive/50 p-2 text-sm text-destructive">Add a scene node before creating a behavior tree.</div>}

				{trees.length > 0 && (
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={tree?.id ?? ""}
						onChange={(event) => this.setState({ selectedTreeId: event.target.value })}
					>
						{trees.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
					</select>
				)}

				{tree ? (
					this._renderTree(scene, tree)
				) : (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">Create a behavior tree to begin authoring AI logic.</div>
				)}
			</div>
		);
	}

	private _renderTree(scene: Scene, tree: IBehaviorTree): ReactNode {
		return (
			<>
				<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
					<Input value={tree.name} aria-label="Behavior tree name" onChange={(event) => this._set(scene, tree, { name: event.target.value })} />
					<label className="flex items-center gap-2 whitespace-nowrap text-sm">
						<Checkbox checked={tree.autoRun} onCheckedChange={(autoRun) => this._set(scene, tree, { autoRun: autoRun === true })} />
						Auto Run
					</label>
					<Button size="sm" variant="destructive" onClick={() => this._delete(scene, tree)}>
						Delete
					</Button>
				</div>
				<div className="flex items-center gap-2 rounded border border-input bg-secondary/25 p-2">
					<Button size="sm" onClick={() => this._run(scene, tree)}>
						Run Tree
					</Button>
					<div className="text-xs text-muted-foreground">
						{tree.lastExecution ? `Last run ${tree.lastExecution.success ? "succeeded" : "failed"}: ${tree.lastExecution.nodeIds.join(", ")}` : "Not run yet"}
					</div>
				</div>
				<section className="space-y-2">
					<div>
						<div className="font-medium">Tree Nodes</div>
						<div className="text-xs text-muted-foreground">
							Sequence succeeds when every child succeeds; Selector succeeds when any child succeeds; Inverter reverses one child result.
						</div>
					</div>
					{this._renderNode(scene, tree, tree.root, true)}
				</section>
			</>
		);
	}

	private _renderNode(scene: Scene, tree: IBehaviorTree, node: IBehaviorNode, root: boolean): ReactNode {
		const composite = this._isComposite(node);
		const targets = this._targets(scene);
		return (
			<div key={node.id} className="space-y-2 rounded border border-input bg-secondary/10 p-2">
				<div className="grid grid-cols-[minmax(10rem,1fr)_minmax(0,1fr)_auto] items-center gap-2">
					<select
						className="h-9 rounded-md border border-input bg-background px-2 text-sm"
						value={node.type}
						onChange={(event) => this._replaceNode(scene, tree, node.id, this._newNode(scene, event.target.value as BehaviorNodeType))}
					>
						<option value="sequence">Sequence</option>
						<option value="selector">Selector</option>
						<option value="inverter">Inverter</option>
						<option value="condition-node-enabled">Node Enabled Condition</option>
						<option value="action-set-enabled">Set Node Enabled</option>
						<option value="action-set-position">Set Node Position</option>
					</select>
					{composite ? (
						<div className="text-xs text-muted-foreground">
							{node.children?.length ?? 0} child node{node.children?.length === 1 ? "" : "s"}
						</div>
					) : (
						<select
							className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
							value={node.nodeId ?? ""}
							onChange={(event) => this._replaceNode(scene, tree, node.id, { ...node, nodeId: event.target.value })}
						>
							{targets.map((target) => (
								<option key={target.id} value={target.id}>
									{target.name}
								</option>
							))}
						</select>
					)}
					{!root && (
						<Button
							size="sm"
							variant="ghost"
							disabled={!this._canRemoveNode(tree.root, node.id)}
							className="!text-red-400"
							onClick={() => this._removeNode(scene, tree, node.id)}
						>
							Remove
						</Button>
					)}
				</div>

				{!composite && this._renderNodeValue(scene, tree, node)}
				{composite && (
					<div className="space-y-2 border-l border-input pl-3">
						{node.children?.map((child) => this._renderNode(scene, tree, child, false))}
						<Button
							size="sm"
							variant="secondary"
							disabled={node.type === "inverter" && (node.children?.length ?? 0) >= 1}
							onClick={() => this._addChild(scene, tree, node.id)}
						>
							Add Child
						</Button>
					</div>
				)}
			</div>
		);
	}

	private _renderNodeValue(scene: Scene, tree: IBehaviorTree, node: IBehaviorNode): ReactNode {
		if (node.type === "condition-node-enabled" || node.type === "action-set-enabled") {
			return (
				<label className="flex items-center gap-2 text-sm">
					<Checkbox checked={node.value ?? true} onCheckedChange={(value) => this._replaceNode(scene, tree, node.id, { ...node, value: value === true })} />
					{node.type === "condition-node-enabled" ? "Expected enabled state" : "Set enabled state"}
				</label>
			);
		}
		return (
			<Input
				value={JSON.stringify(node.value ?? [0, 0, 0])}
				aria-label={`${node.id} position`}
				onChange={(event) => {
					try {
						const value = JSON.parse(event.target.value);
						if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) this._replaceNode(scene, tree, node.id, { ...node, value });
					} catch {
						// Preserve the last valid position while the user types JSON.
					}
				}}
			/>
		);
	}

	private _getTrees(scene: Scene): IBehaviorTree[] {
		return listBehaviorTrees(scene).trees as IBehaviorTree[];
	}

	private _targets(scene: Scene): any[] {
		return scene.getNodes().filter((node: any) => Boolean(node.id));
	}

	private _newNode(scene: Scene, type: BehaviorNodeType = "action-set-enabled"): IBehaviorNode {
		if (type === "sequence" || type === "selector" || type === "inverter") return { id: Tools.RandomId(), type, children: [this._newNode(scene)] };
		const target = this._targets(scene)[0];
		return { id: Tools.RandomId(), type, nodeId: target?.id, value: type === "action-set-position" ? [0, 0, 0] : true };
	}

	private _create(scene: Scene): void {
		const tree = createBehaviorTree(
			scene,
			{ name: `Behavior Tree ${this._getTrees(scene).length + 1}`, root: this._newNode(scene), autoRun: false },
			{ editor: this.props.editor }
		) as IBehaviorTree;
		this.setState({ selectedTreeId: tree.id });
	}

	private _set(scene: Scene, tree: IBehaviorTree, update: Partial<IBehaviorTree>): void {
		setBehaviorTree(scene, { id: tree.id, ...update }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _run(scene: Scene, tree: IBehaviorTree): void {
		runBehaviorTree(scene, { id: tree.id }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _delete(scene: Scene, tree: IBehaviorTree): void {
		deleteBehaviorTree(scene, { id: tree.id }, { editor: this.props.editor });
		this.setState({ selectedTreeId: null });
	}

	private _isComposite(node: IBehaviorNode): boolean {
		return node.type === "sequence" || node.type === "selector" || node.type === "inverter";
	}

	private _replaceNode(scene: Scene, tree: IBehaviorTree, id: string, replacement: IBehaviorNode): void {
		const replace = (node: IBehaviorNode): IBehaviorNode => (node.id === id ? replacement : { ...node, children: node.children?.map((child) => replace(child)) });
		this._set(scene, tree, { root: replace(tree.root) });
	}

	private _addChild(scene: Scene, tree: IBehaviorTree, parentId: string): void {
		const append = (node: IBehaviorNode): IBehaviorNode =>
			node.id === parentId ? { ...node, children: [...(node.children ?? []), this._newNode(scene)] } : { ...node, children: node.children?.map((child) => append(child)) };
		this._set(scene, tree, { root: append(tree.root) });
	}

	private _removeNode(scene: Scene, tree: IBehaviorTree, id: string): void {
		const remove = (node: IBehaviorNode): IBehaviorNode => ({ ...node, children: node.children?.filter((child) => child.id !== id).map((child) => remove(child)) });
		this._set(scene, tree, { root: remove(tree.root) });
	}

	private _canRemoveNode(root: IBehaviorNode, id: string): boolean {
		const findParent = (node: IBehaviorNode): IBehaviorNode | null => {
			if (node.children?.some((child) => child.id === id)) return node;
			for (const child of node.children ?? []) {
				const parent = findParent(child);
				if (parent) return parent;
			}
			return null;
		};
		return (findParent(root)?.children?.length ?? 0) > 1;
	}
}
