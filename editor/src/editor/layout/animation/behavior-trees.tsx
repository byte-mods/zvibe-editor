import { Component, ReactNode } from "react";

import { Scene } from "babylonjs";
import {
	behaviorNodeTypes,
	BehaviorBlackboardValueType,
	BehaviorNodeStatus,
	BehaviorNodeType,
	createBehaviorGraphId,
	findBehaviorNode,
	getDefaultBehaviorBlackboardValue,
	IBehaviorBlackboardVariable,
	IBehaviorGraphDefinition,
	IBehaviorGraphRuntimeState,
	IBehaviorNodeDefinition,
	isBehaviorComposite,
	visitBehaviorNodes,
} from "babylonjs-editor-tools";

import { Button } from "../../../ui/shadcn/ui/button";
import { Checkbox } from "../../../ui/shadcn/ui/checkbox";
import { Input } from "../../../ui/shadcn/ui/input";
import {
	clearBehaviorTreeTrace,
	continueBehaviorTree,
	createBehaviorBlackboardVariable,
	createBehaviorTree,
	createBehaviorTreeNode,
	deleteBehaviorBlackboardVariable,
	deleteBehaviorTree,
	deleteBehaviorTreeNode,
	dispatchBehaviorTreeEvent,
	getBehaviorGraphAuthoringSnapshot,
	getBehaviorTreeRuntime,
	listBehaviorTrees,
	reloadBehaviorTreeRuntime,
	restoreBehaviorGraphAuthoringSnapshot,
	setBehaviorBlackboardVariable,
	setBehaviorTree,
	setBehaviorTreeBreakpoints,
	setBehaviorTreeNode,
	startBehaviorTree,
	stepBehaviorTree,
	stopBehaviorTree,
	tickBehaviorTree,
	IBehaviorGraphAuthoringSnapshot,
} from "../../../mcp/ai/behavior-trees";

import { Editor } from "../../main";

export interface IEditorBehaviorTreesPanelProps {
	editor: Editor;
}

export interface IEditorBehaviorTreesPanelState {
	selectedTreeId: string | null;
	selectedNodeId: string | null;
	eventName: string;
}

interface IBehaviorCanvasNode {
	node: IBehaviorNodeDefinition;
	parent: IBehaviorNodeDefinition | null;
}

const nodeLabels: Record<BehaviorNodeType, string> = {
	sequence: "Sequence",
	selector: "Try In Order",
	random: "Random",
	"parallel-all": "Run In Parallel (All)",
	"parallel-any": "Run In Parallel (Any)",
	"utility-selector": "Utility Selector",
	inverter: "Inverter",
	succeeder: "Succeeder",
	repeat: "Repeat",
	"condition-node-enabled": "Node Enabled?",
	"condition-variable": "Blackboard Condition",
	"condition-distance": "Distance Condition",
	"condition-nav-arrived": "Navigation Arrived?",
	"action-set-enabled": "Set Node Enabled",
	"action-set-position": "Set Node Position",
	"action-set-variable": "Set Blackboard",
	"action-wait": "Wait",
	"action-log": "Log",
	"action-send-event": "Send Event",
	"action-nav-set-destination": "Set Nav Destination",
	"action-nav-start": "Start Nav Agent",
	"action-nav-stop": "Stop Nav Agent",
	"action-nav-move-to": "Navigate To",
	"wait-event": "Wait For Event",
	subgraph: "Subgraph",
	custom: "Custom Code Node",
};

/** Unity-style Behavior Graph canvas, Blackboard, agent runtime, events, and live debugger backed by the exact MCP actions. */
export class EditorBehaviorTreesPanel extends Component<IEditorBehaviorTreesPanelProps, IEditorBehaviorTreesPanelState> {
	private _undo: IBehaviorGraphAuthoringSnapshot[] = [];
	private _redo: IBehaviorGraphAuthoringSnapshot[] = [];
	private _poll: ReturnType<typeof setInterval> | null = null;

	public constructor(props: IEditorBehaviorTreesPanelProps) {
		super(props);
		this.state = { selectedTreeId: null, selectedNodeId: null, eventName: "Alert" };
	}

	public componentDidMount(): void {
		this._poll = setInterval(() => this.forceUpdate(), 500);
	}

	public componentWillUnmount(): void {
		if (this._poll) {
			clearInterval(this._poll);
		}
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const trees = this._trees(scene);
		const tree = trees.find((candidate) => candidate.id === this.state.selectedTreeId) ?? trees[0] ?? null;
		const selected = tree && this.state.selectedNodeId ? findBehaviorNode(tree.root, this.state.selectedNodeId) : (tree?.root ?? null);
		const runtime = tree ? this._runtime(scene, tree) : null;

		return (
			<div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3">
				<div className="flex flex-wrap items-center gap-2">
					<div className="mr-auto">
						<div className="font-semibold">Behavior Graphs</div>
						<div className="text-xs text-muted-foreground">Blackboard, subgraphs, events, utility AI, navigation, custom nodes, and live status debugging.</div>
					</div>
					<Button size="sm" variant="secondary" disabled={!this._undo.length} onClick={() => this._undoAuthoring(scene)}>
						Undo
					</Button>
					<Button size="sm" variant="secondary" disabled={!this._redo.length} onClick={() => this._redoAuthoring(scene)}>
						Redo
					</Button>
					<Button size="sm" onClick={() => this._createTree(scene)}>
						Create Graph
					</Button>
				</div>

				{tree ? (
					<>
						<div className="flex flex-wrap items-center gap-2 rounded border border-input bg-secondary/20 p-2">
							<select
								className="h-8 min-w-44 rounded border border-input bg-background px-2 text-sm"
								value={tree.id}
								onChange={(event) => this.setState({ selectedTreeId: event.target.value, selectedNodeId: null })}
							>
								{trees.map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.name}
									</option>
								))}
							</select>
							<Input
								className="h-8 max-w-52"
								value={tree.name}
								aria-label="Behavior graph name"
								onChange={(event) => this._setTree(scene, tree, { name: event.target.value })}
							/>
							<label className="flex items-center gap-1 text-xs">
								<Checkbox checked={tree.enabled} onCheckedChange={(value) => this._setTree(scene, tree, { enabled: value === true })} />
								Enabled
							</label>
							<label className="flex items-center gap-1 text-xs">
								<Checkbox checked={tree.autoStart} onCheckedChange={(value) => this._setTree(scene, tree, { autoStart: value === true })} />
								Auto Start
							</label>
							<Input
								className="h-8 max-w-36"
								placeholder="Start event"
								value={tree.startEvent ?? ""}
								onChange={(event) => this._setTree(scene, tree, { startEvent: event.target.value || undefined })}
							/>
							<select
								className="h-8 max-w-40 rounded border border-input bg-background px-2 text-xs"
								value={tree.agentNodeId ?? ""}
								onChange={(event) => this._setTree(scene, tree, { agentNodeId: event.target.value || undefined })}
							>
								<option value="">No agent object</option>
								{scene
									.getNodes()
									.filter((node) => Boolean(node.id))
									.map((node) => (
										<option key={node.id} value={node.id}>
											{node.name}
										</option>
									))}
							</select>
							<Button size="sm" variant="destructive" onClick={() => this._deleteTree(scene, tree)}>
								Delete
							</Button>
						</div>
						{this._renderRuntime(scene, tree, runtime)}
						<div className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(30rem,1fr)_18rem] gap-2 overflow-hidden">
							{this._renderBlackboard(scene, tree, runtime)}
							{this._renderCanvas(scene, tree, runtime)}
							{this._renderInspector(scene, tree, selected)}
						</div>
					</>
				) : (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">Create a Behavior Graph to author AI logic.</div>
				)}
			</div>
		);
	}

	private _renderRuntime(scene: Scene, tree: IBehaviorGraphDefinition, runtime: IBehaviorGraphRuntimeState | null): ReactNode {
		return (
			<div className="flex flex-wrap items-center gap-2 rounded border border-input p-2 text-xs">
				<Button size="sm" variant="secondary" onClick={() => this._runtimeAction(() => reloadBehaviorTreeRuntime(scene, {}, this._options()))}>
					Reload
				</Button>
				<Button size="sm" onClick={() => this._runtimeAction(() => startBehaviorTree(scene, { id: tree.id }, this._options()))}>
					Start
				</Button>
				<Button size="sm" variant="secondary" onClick={() => this._runtimeAction(() => stopBehaviorTree(scene, { id: tree.id }, this._options()))}>
					Stop
				</Button>
				<Button size="sm" variant="secondary" onClick={() => this._runtimeAction(() => tickBehaviorTree(scene, { id: tree.id, deltaSeconds: 1 / 60 }, this._options()))}>
					Tick 1/60
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={runtime?.status !== "paused"}
					onClick={() => this._runtimeAction(() => continueBehaviorTree(scene, { id: tree.id }, this._options()))}
				>
					Continue
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={runtime?.status !== "paused"}
					onClick={() => this._runtimeAction(() => stepBehaviorTree(scene, { id: tree.id, deltaSeconds: 1 / 60 }, this._options()))}
				>
					Step Node
				</Button>
				<Input
					className="h-8 max-w-32"
					value={this.state.eventName}
					aria-label="Behavior event name"
					onChange={(event) => this.setState({ eventName: event.target.value })}
				/>
				<Button
					size="sm"
					variant="secondary"
					disabled={!this.state.eventName.trim()}
					onClick={() => this._runtimeAction(() => dispatchBehaviorTreeEvent(scene, { id: tree.id, eventName: this.state.eventName }, this._options()))}
				>
					Send Event
				</Button>
				<Button size="sm" variant="ghost" onClick={() => this._runtimeAction(() => clearBehaviorTreeTrace(scene, {}, this._options()))}>
					Clear Trace
				</Button>
				<span className="ml-auto">
					Status: <span className="font-medium">{runtime?.status ?? "runtime not loaded"}</span>
					{runtime?.currentNodeId ? ` · ${runtime.currentNodeId}` : ""}
					{runtime?.error ? ` · ${runtime.error}` : ""}
				</span>
			</div>
		);
	}

	private _renderBlackboard(scene: Scene, tree: IBehaviorGraphDefinition, runtime: IBehaviorGraphRuntimeState | null): ReactNode {
		return (
			<section className="min-h-0 overflow-auto rounded border border-input p-2">
				<div className="mb-2 flex items-center justify-between">
					<div className="font-medium">Blackboard</div>
					<Button size="sm" variant="secondary" onClick={() => this._createVariable(scene, tree)}>
						Add
					</Button>
				</div>
				<div className="space-y-2">
					{tree.blackboard.map((variable) => (
						<div key={variable.id} className="space-y-1 rounded border border-input bg-secondary/10 p-2">
							<Input className="h-7" value={variable.name} onChange={(event) => this._setVariable(scene, tree, variable, { name: event.target.value })} />
							<div className="grid grid-cols-2 gap-1">
								<select
									className="h-7 rounded border border-input bg-background px-1 text-xs"
									value={variable.type}
									onChange={(event) =>
										this._setVariable(scene, tree, variable, {
											type: event.target.value,
											defaultValue: getDefaultBehaviorBlackboardValue(event.target.value as BehaviorBlackboardValueType),
										})
									}
								>
									{["boolean", "number", "string", "vector3", "node"].map((type) => (
										<option key={type}>{type}</option>
									))}
								</select>
								<select
									className="h-7 rounded border border-input bg-background px-1 text-xs"
									value={variable.scope}
									onChange={(event) => this._setVariable(scene, tree, variable, { scope: event.target.value })}
								>
									<option value="graph">Graph</option>
									<option value="scene">Scene</option>
								</select>
							</div>
							<Input
								className="h-7"
								value={JSON.stringify(variable.defaultValue)}
								onChange={(event) => this._setJsonVariable(scene, tree, variable, event.target.value)}
							/>
							<label className="flex items-center gap-1 text-[11px]">
								<Checkbox checked={variable.exposed} onCheckedChange={(value) => this._setVariable(scene, tree, variable, { exposed: value === true })} />
								Exposed override
							</label>
							<div className="flex items-center justify-between text-[11px]">
								<span>Live: {JSON.stringify(runtime?.blackboard[variable.name])}</span>
								<Button size="sm" variant="ghost" className="h-6 !text-red-400" onClick={() => this._deleteVariable(scene, tree, variable)}>
									Remove
								</Button>
							</div>
						</div>
					))}
				</div>
			</section>
		);
	}

	private _renderCanvas(scene: Scene, tree: IBehaviorGraphDefinition, runtime: IBehaviorGraphRuntimeState | null): ReactNode {
		const entries: IBehaviorCanvasNode[] = [];
		visitBehaviorNodes(tree.root, (node, parent) => entries.push({ node, parent }));
		return (
			<section
				className="relative min-h-0 overflow-auto rounded border border-input bg-[radial-gradient(circle_at_1px_1px,hsl(var(--border))_1px,transparent_0)] bg-[size:20px_20px]"
				aria-label="Behavior Graph canvas"
			>
				<div className="relative h-[900px] w-[1400px]">
					<svg className="pointer-events-none absolute inset-0 h-full w-full">
						{entries
							.filter((entry) => entry.parent)
							.map(({ node, parent }) => (
								<line
									key={`${parent!.id}-${node.id}`}
									x1={parent!.position[0] + 82}
									y1={parent!.position[1] + 42}
									x2={node.position[0] + 82}
									y2={node.position[1] + 10}
									stroke="currentColor"
									strokeOpacity="0.35"
									strokeWidth="2"
								/>
							))}
					</svg>
					{entries.map(({ node }) => this._renderCanvasNode(scene, tree, node, runtime))}
				</div>
			</section>
		);
	}

	private _renderCanvasNode(scene: Scene, tree: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition, runtime: IBehaviorGraphRuntimeState | null): ReactNode {
		const status = this._nodeStatus(runtime, node.id);
		const selected = (this.state.selectedNodeId ?? tree.root.id) === node.id;
		const breakpoint = runtime?.breakpoints.includes(node.id) ?? false;
		return (
			<button
				key={node.id}
				draggable
				onDragEnd={(event) => {
					const rect = event.currentTarget.parentElement!.getBoundingClientRect();
					this._setNode(scene, tree, node, { position: [Math.max(0, event.clientX - rect.left - 82), Math.max(0, event.clientY - rect.top - 21)] });
				}}
				onClick={() => this.setState({ selectedNodeId: node.id })}
				className={`absolute w-44 rounded border p-2 text-left text-xs shadow ${selected ? "border-primary bg-primary/15" : "border-input bg-background"}`}
				style={{ left: node.position[0], top: node.position[1] }}
			>
				<div className="flex items-center justify-between gap-1">
					<span className="truncate font-medium">{node.name || nodeLabels[node.type]}</span>
					<span
						title={status}
						className={`h-2.5 w-2.5 rounded-full ${status === "succeeded" ? "bg-green-500" : status === "failed" ? "bg-red-500" : status === "running" ? "bg-blue-500" : status === "waiting" ? "bg-amber-500" : "bg-muted"}`}
					/>
				</div>
				<div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
					<span>{node.type}</span>
					<span>{breakpoint ? "● breakpoint" : status}</span>
				</div>
			</button>
		);
	}

	private _renderInspector(scene: Scene, tree: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition | null): ReactNode {
		if (!node) {
			return <section className="rounded border border-input p-2 text-sm text-muted-foreground">Select a node.</section>;
		}
		const targets = scene.getNodes().filter((candidate) => Boolean(candidate.id));
		const agents = (scene.metadata?.babylonEditorNavAgents ?? []) as Array<{ id: string; nodeId: string }>;
		const parent = this._parent(tree.root, node.id);
		return (
			<section className="min-h-0 space-y-2 overflow-auto rounded border border-input p-2 text-xs">
				<div className="font-medium">Node Inspector</div>
				<Input
					className="h-8"
					value={node.name ?? ""}
					placeholder={nodeLabels[node.type]}
					onChange={(event) => this._setNode(scene, tree, node, { name: event.target.value || undefined })}
				/>
				<select
					className="h-8 w-full rounded border border-input bg-background px-2"
					value={node.type}
					onChange={(event) => this._changeNodeType(scene, tree, node, event.target.value as BehaviorNodeType)}
				>
					{behaviorNodeTypes.map((type) => (
						<option key={type} value={type}>
							{nodeLabels[type]}
						</option>
					))}
				</select>
				<label className="flex items-center gap-2">
					<Checkbox checked={node.enabled} onCheckedChange={(value) => this._setNode(scene, tree, node, { enabled: value === true })} />
					Enabled
				</label>
				{["condition-node-enabled", "condition-distance", "action-set-enabled", "action-set-position"].includes(node.type) && (
					<select
						className="h-8 w-full rounded border border-input bg-background px-2"
						value={node.nodeId ?? ""}
						onChange={(event) => this._setNode(scene, tree, node, { nodeId: event.target.value })}
					>
						{targets.map((target) => (
							<option key={target.id} value={target.id}>
								{target.name}
							</option>
						))}
					</select>
				)}
				{["condition-variable", "action-set-variable", "wait-event"].includes(node.type) && (
					<select
						className="h-8 w-full rounded border border-input bg-background px-2"
						value={node.variableId ?? ""}
						onChange={(event) => {
							const variable = tree.blackboard.find((candidate) => candidate.id === event.target.value);
							this._setNode(scene, tree, node, {
								variableId: event.target.value || undefined,
								value: variable ? structuredClone(variable.defaultValue) : node.value,
							});
						}}
					>
						{node.type === "wait-event" && <option value="">Do not store payload</option>}
						{tree.blackboard.map((variable) => (
							<option key={variable.id} value={variable.id}>
								{variable.name}
							</option>
						))}
					</select>
				)}
				{["condition-variable", "condition-distance"].includes(node.type) && (
					<select
						className="h-8 w-full rounded border border-input bg-background px-2"
						value={node.operator ?? "equal"}
						onChange={(event) => this._setNode(scene, tree, node, { operator: event.target.value })}
					>
						{["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual"].map((operator) => (
							<option key={operator}>{operator}</option>
						))}
					</select>
				)}
				{["condition-nav-arrived", "action-nav-set-destination", "action-nav-start", "action-nav-stop", "action-nav-move-to"].includes(node.type) && (
					<select
						className="h-8 w-full rounded border border-input bg-background px-2"
						value={node.navAgentId ?? ""}
						onChange={(event) => this._setNode(scene, tree, node, { navAgentId: event.target.value })}
					>
						{agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.id}
							</option>
						))}
					</select>
				)}
				{["action-send-event", "wait-event"].includes(node.type) && (
					<Input
						className="h-8"
						value={node.eventName ?? ""}
						placeholder="Event name"
						onChange={(event) => this._setNode(scene, tree, node, { eventName: event.target.value })}
					/>
				)}
				{node.type === "subgraph" && (
					<select
						className="h-8 w-full rounded border border-input bg-background px-2"
						value={node.subgraphId ?? ""}
						onChange={(event) => this._setNode(scene, tree, node, { subgraphId: event.target.value })}
					>
						{this._trees(scene)
							.filter((candidate) => candidate.id !== tree.id)
							.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									{candidate.name}
								</option>
							))}
					</select>
				)}
				{node.type === "custom" && (
					<>
						<Input
							className="h-8"
							value={node.unitId ?? ""}
							placeholder="Registered unit id"
							onChange={(event) => this._setNode(scene, tree, node, { unitId: event.target.value })}
						/>
						<Input
							className="h-8"
							value={JSON.stringify(node.settings ?? {})}
							onChange={(event) => this._setNodeJson(scene, tree, node, "settings", event.target.value)}
						/>
					</>
				)}
				{node.type === "action-wait" && (
					<Input
						className="h-8"
						type="number"
						min={0}
						max={86400}
						value={node.duration ?? 1}
						onChange={(event) => this._setNode(scene, tree, node, { duration: Number(event.target.value) })}
					/>
				)}
				{node.type === "repeat" && (
					<Input
						className="h-8"
						type="number"
						min={0}
						max={10000}
						value={node.repeatCount ?? 0}
						onChange={(event) => this._setNode(scene, tree, node, { repeatCount: Number(event.target.value) })}
					/>
				)}
				{this._usesValue(node) && (
					<Input
						className="h-8"
						value={JSON.stringify(node.value ?? this._defaultNodeValue(node.type))}
						aria-label="Behavior node JSON value"
						onChange={(event) => this._setNodeJson(scene, tree, node, "value", event.target.value)}
					/>
				)}
				{parent?.type === "utility-selector" && (
					<div className="space-y-1 rounded border border-input p-2">
						<div className="font-medium">Utility Score</div>
						<select
							className="h-8 w-full rounded border border-input bg-background px-2"
							value={node.utility?.variableId ?? ""}
							onChange={(event) =>
								this._setNode(scene, tree, node, {
									utility: {
										...node.utility,
										variableId: event.target.value || undefined,
										constant: event.target.value ? undefined : (node.utility?.constant ?? 0),
										weight: node.utility?.weight ?? 1,
										invert: node.utility?.invert ?? false,
									},
								})
							}
						>
							<option value="">Constant</option>
							{tree.blackboard
								.filter((variable) => variable.type === "number" || variable.type === "boolean")
								.map((variable) => (
									<option key={variable.id} value={variable.id}>
										{variable.name}
									</option>
								))}
						</select>
						{!node.utility?.variableId && (
							<Input
								className="h-8"
								type="number"
								value={node.utility?.constant ?? 0}
								onChange={(event) =>
									this._setNode(scene, tree, node, {
										utility: {
											...node.utility,
											constant: Number(event.target.value),
											weight: node.utility?.weight ?? 1,
											invert: node.utility?.invert ?? false,
										},
									})
								}
							/>
						)}
						<Input
							className="h-8"
							type="number"
							value={node.utility?.weight ?? 1}
							onChange={(event) =>
								this._setNode(scene, tree, node, { utility: { ...node.utility, weight: Number(event.target.value), invert: node.utility?.invert ?? false } })
							}
						/>
						<label className="flex items-center gap-2">
							<Checkbox
								checked={node.utility?.invert ?? false}
								onCheckedChange={(value) =>
									this._setNode(scene, tree, node, { utility: { ...node.utility, weight: node.utility?.weight ?? 1, invert: value === true } })
								}
							/>
							Invert score
						</label>
					</div>
				)}
				{isBehaviorComposite(node.type) && (
					<Button
						size="sm"
						variant="secondary"
						className="w-full"
						disabled={["inverter", "succeeder", "repeat"].includes(node.type) && node.children.length >= 1}
						onClick={() => this._addChild(scene, tree, node)}
					>
						Add Child
					</Button>
				)}
				<Button
					size="sm"
					variant={this._runtime(scene, tree)?.breakpoints.includes(node.id) ? "default" : "secondary"}
					className="w-full"
					onClick={() => this._toggleBreakpoint(scene, tree, node)}
				>
					Toggle Breakpoint
				</Button>
				{node.id !== tree.root.id && (
					<Button size="sm" variant="destructive" className="w-full" onClick={() => this._deleteNode(scene, tree, node)}>
						Delete Node
					</Button>
				)}
				<div className="break-all text-[10px] text-muted-foreground">{node.id}</div>
			</section>
		);
	}

	private _trees(scene: Scene): IBehaviorGraphDefinition[] {
		return listBehaviorTrees(scene).trees as IBehaviorGraphDefinition[];
	}

	private _runtime(scene: Scene, tree: IBehaviorGraphDefinition): IBehaviorGraphRuntimeState | null {
		try {
			return getBehaviorTreeRuntime(scene, { id: tree.id }).state as IBehaviorGraphRuntimeState;
		} catch {
			return null;
		}
	}

	private _nodeStatus(runtime: IBehaviorGraphRuntimeState | null, nodeId: string): BehaviorNodeStatus {
		const direct = runtime?.nodeStatuses[`${runtime.graphId}:${nodeId}`];
		if (direct) {
			return direct;
		}
		return (Object.entries(runtime?.nodeStatuses ?? {}).find(([key]) => key.endsWith(`:${nodeId}`))?.[1] as BehaviorNodeStatus | undefined) ?? "uninitialized";
	}

	private _parent(root: IBehaviorNodeDefinition, nodeId: string): IBehaviorNodeDefinition | null {
		let parent: IBehaviorNodeDefinition | null = null;
		visitBehaviorNodes(root, (candidate) => {
			if (candidate.children.some((child) => child.id === nodeId)) {
				parent = candidate;
			}
		});
		return parent;
	}

	private _options(): any {
		return { editor: this.props.editor };
	}

	private _record(scene: Scene, action: () => void): void {
		const snapshot = getBehaviorGraphAuthoringSnapshot(scene);
		this._undo.push(snapshot);
		if (this._undo.length > 100) {
			this._undo.shift();
		}
		this._redo = [];
		try {
			action();
		} catch (error) {
			this._undo.pop();
			throw error;
		}
		this.forceUpdate();
	}

	private _undoAuthoring(scene: Scene): void {
		const snapshot = this._undo.pop();
		if (!snapshot) {
			return;
		}
		this._redo.push(getBehaviorGraphAuthoringSnapshot(scene));
		restoreBehaviorGraphAuthoringSnapshot(scene, snapshot, this._options());
		this.forceUpdate();
	}

	private _redoAuthoring(scene: Scene): void {
		const snapshot = this._redo.pop();
		if (!snapshot) {
			return;
		}
		this._undo.push(getBehaviorGraphAuthoringSnapshot(scene));
		restoreBehaviorGraphAuthoringSnapshot(scene, snapshot, this._options());
		this.forceUpdate();
	}

	private _createTree(scene: Scene): void {
		this._record(scene, () => {
			const created = createBehaviorTree(scene, { name: `Behavior Graph ${this._trees(scene).length + 1}` }, this._options()) as IBehaviorGraphDefinition;
			this.setState({ selectedTreeId: created.id, selectedNodeId: created.root.id });
		});
	}

	private _setTree(scene: Scene, tree: IBehaviorGraphDefinition, changes: Record<string, unknown>): void {
		this._record(scene, () => setBehaviorTree(scene, { id: tree.id, expectedRevision: tree.revision, changes }, this._options()));
	}

	private _deleteTree(scene: Scene, tree: IBehaviorGraphDefinition): void {
		this._record(scene, () => deleteBehaviorTree(scene, { id: tree.id, expectedRevision: tree.revision }, this._options()));
		this.setState({ selectedTreeId: null, selectedNodeId: null });
	}

	private _createVariable(scene: Scene, tree: IBehaviorGraphDefinition): void {
		this._record(scene, () =>
			createBehaviorBlackboardVariable(
				scene,
				{ id: tree.id, expectedRevision: tree.revision, variable: { name: `Variable ${tree.blackboard.length + 1}`, type: "boolean" } },
				this._options()
			)
		);
	}

	private _setVariable(scene: Scene, tree: IBehaviorGraphDefinition, variable: IBehaviorBlackboardVariable, changes: Record<string, unknown>): void {
		this._record(scene, () => setBehaviorBlackboardVariable(scene, { id: tree.id, expectedRevision: tree.revision, variableId: variable.id, changes }, this._options()));
	}

	private _setJsonVariable(scene: Scene, tree: IBehaviorGraphDefinition, variable: IBehaviorBlackboardVariable, text: string): void {
		try {
			this._setVariable(scene, tree, variable, { defaultValue: JSON.parse(text) });
		} catch {
			/* Keep the last valid authored JSON while typing. */
		}
	}

	private _deleteVariable(scene: Scene, tree: IBehaviorGraphDefinition, variable: IBehaviorBlackboardVariable): void {
		this._record(scene, () => deleteBehaviorBlackboardVariable(scene, { id: tree.id, expectedRevision: tree.revision, variableId: variable.id }, this._options()));
	}

	private _setNode(scene: Scene, tree: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition, changes: Record<string, unknown>): void {
		this._record(scene, () => setBehaviorTreeNode(scene, { id: tree.id, expectedRevision: tree.revision, nodeId: node.id, changes }, this._options()));
	}

	private _setNodeJson(scene: Scene, tree: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition, key: "value" | "settings", text: string): void {
		try {
			this._setNode(scene, tree, node, { [key]: JSON.parse(text) });
		} catch {
			/* Keep the last valid authored JSON while typing. */
		}
	}

	private _changeNodeType(scene: Scene, tree: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition, type: BehaviorNodeType): void {
		const composite = isBehaviorComposite(type);
		const modifier = ["inverter", "succeeder", "repeat"].includes(type);
		const children = composite
			? node.children.length
				? modifier
					? [node.children[0]]
					: node.children
				: [this._newNode("action-log", node.position[0] + 220, node.position[1])]
			: [];
		const variable = tree.blackboard[0];
		const target = scene.getNodes().find((candidate) => Boolean(candidate.id));
		const agent = (scene.metadata?.babylonEditorNavAgents ?? [])[0] as { id?: string } | undefined;
		const subgraph = this._trees(scene).find((candidate) => candidate.id !== tree.id);
		this._setNode(scene, tree, node, {
			type,
			children,
			value: type === "action-set-variable" && variable ? variable.defaultValue : this._defaultNodeValue(type),
			operator: type.startsWith("condition-") ? "equal" : undefined,
			nodeId: ["condition-node-enabled", "condition-distance", "action-set-enabled", "action-set-position"].includes(type) ? target?.id : node.nodeId,
			variableId: ["condition-variable", "action-set-variable"].includes(type) ? variable?.id : node.variableId,
			navAgentId: ["condition-nav-arrived", "action-nav-set-destination", "action-nav-start", "action-nav-stop", "action-nav-move-to"].includes(type)
				? agent?.id
				: node.navAgentId,
			eventName: ["action-send-event", "wait-event"].includes(type) ? (node.eventName ?? "Event") : node.eventName,
			subgraphId: type === "subgraph" ? subgraph?.id : node.subgraphId,
			unitId: type === "custom" ? (node.unitId ?? "custom-node") : node.unitId,
			duration: type === "action-wait" ? (node.duration ?? 1) : node.duration,
		});
	}

	private _newNode(type: BehaviorNodeType, x: number, y: number): IBehaviorNodeDefinition {
		return { id: createBehaviorGraphId("node"), type, position: [x, y], enabled: true, children: [], value: this._defaultNodeValue(type) };
	}

	private _addChild(scene: Scene, tree: IBehaviorGraphDefinition, parent: IBehaviorNodeDefinition): void {
		this._record(scene, () =>
			createBehaviorTreeNode(
				scene,
				{
					id: tree.id,
					expectedRevision: tree.revision,
					parentId: parent.id,
					node: this._newNode("action-log", parent.position[0] + 220, parent.position[1] + parent.children.length * 100),
				},
				this._options()
			)
		);
	}

	private _deleteNode(scene: Scene, tree: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition): void {
		this._record(scene, () => deleteBehaviorTreeNode(scene, { id: tree.id, expectedRevision: tree.revision, nodeId: node.id }, this._options()));
		this.setState({ selectedNodeId: tree.root.id });
	}

	private _toggleBreakpoint(scene: Scene, tree: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition): void {
		const current = this._runtime(scene, tree)?.breakpoints ?? [];
		const nodeIds = current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id];
		this._runtimeAction(() => setBehaviorTreeBreakpoints(scene, { id: tree.id, nodeIds }, this._options()));
	}

	private _runtimeAction(action: () => unknown): void {
		action();
		this.forceUpdate();
	}

	private _usesValue(node: IBehaviorNodeDefinition): boolean {
		return [
			"condition-node-enabled",
			"condition-variable",
			"condition-distance",
			"action-set-enabled",
			"action-set-position",
			"action-set-variable",
			"action-log",
			"action-send-event",
			"action-nav-set-destination",
			"action-nav-move-to",
		].includes(node.type);
	}

	private _defaultNodeValue(type: BehaviorNodeType): unknown {
		if (["condition-node-enabled", "action-set-enabled"].includes(type)) {
			return true;
		}
		if (["action-set-position", "action-nav-set-destination", "action-nav-move-to"].includes(type)) {
			return [0, 0, 0];
		}
		if (["condition-variable", "condition-distance"].includes(type)) {
			return 0;
		}
		if (type === "action-log") {
			return "Behavior action";
		}
		return null;
	}
}
