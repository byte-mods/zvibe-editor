import { Component, ReactNode } from "react";

import { Scene, Tools } from "babylonjs";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { Checkbox } from "../../../ui/shadcn/ui/checkbox";
import {
	createVisualScriptGraph,
	deleteVisualScriptGraph,
	listVisualScriptGraphs,
	runVisualScriptGraph,
	setVisualScriptGraph,
	setVisualScriptNodePosition,
} from "../../../mcp/visual-scripting/graphs";

import { Editor } from "../../main";

type VisualScriptNodeType = "event-start" | "set-variable" | "set-position" | "translate" | "set-enabled";

interface IVisualScriptNode {
	id: string;
	type: VisualScriptNodeType;
	nodeId?: string;
	variable?: string;
	value?: any;
	position?: [number, number];
}

interface IVisualScriptGraph {
	id: string;
	name: string;
	autoRun: boolean;
	variables: Record<string, any>;
	nodes: IVisualScriptNode[];
	edges: { from: string; to: string }[];
	lastExecution?: { nodes: string[] };
}

export interface IEditorVisualScriptingPanelProps {
	editor: Editor;
}

export interface IEditorVisualScriptingPanelState {
	selectedGraphId: string | null;
	newVariableName: string;
	graphDrag: { graphId: string; nodeId: string; offset: [number, number] } | null;
}

/**
 * A compact in-editor authoring surface for persisted visual-script graphs. It deliberately
 * calls the same MCP action implementations that external agents use, so both workflows
 * share validation, scene persistence, and runtime behavior.
 */
export class EditorVisualScriptingPanel extends Component<IEditorVisualScriptingPanelProps, IEditorVisualScriptingPanelState> {
	public constructor(props: IEditorVisualScriptingPanelProps) {
		super(props);
		this.state = { selectedGraphId: null, newVariableName: "", graphDrag: null };
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const graphs = this._getGraphs(scene);
		const graph = graphs.find((candidate) => candidate.id === this.state.selectedGraphId) ?? graphs[0] ?? null;

		return (
			<div className="flex flex-col gap-3 h-full overflow-auto p-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-semibold">Visual Script Graphs</div>
						<div className="text-xs text-muted-foreground">Author persisted scene actions here or through the same MCP graph tools.</div>
					</div>
					<Button size="sm" onClick={() => this._createGraph(scene)}>
						Create Graph
					</Button>
				</div>

				{graphs.length > 0 && (
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={graph?.id ?? ""}
						onChange={(event) => this.setState({ selectedGraphId: event.target.value })}
					>
						{graphs.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
					</select>
				)}

				{graph ? (
					this._renderGraph(scene, graph)
				) : (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">Create a graph to begin authoring scene logic.</div>
				)}
			</div>
		);
	}

	private _renderGraph(scene: Scene, graph: IVisualScriptGraph): ReactNode {
		return (
			<>
				<div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
					<Input value={graph.name} aria-label="Visual script graph name" onChange={(event) => this._set(scene, graph, { name: event.target.value })} />
					<label className="flex items-center gap-2 text-sm whitespace-nowrap">
						<Checkbox checked={graph.autoRun} onCheckedChange={(autoRun) => this._set(scene, graph, { autoRun: autoRun === true })} />
						Auto Run
					</label>
					<Button size="sm" variant="destructive" onClick={() => this._delete(scene, graph)}>
						Delete
					</Button>
				</div>

				<div className="flex items-center gap-2 rounded border border-input bg-secondary/25 p-2">
					<Button size="sm" onClick={() => this._run(scene, graph)}>
						Run Graph
					</Button>
					<div className="text-xs text-muted-foreground">{graph.lastExecution ? `Last run: ${graph.lastExecution.nodes.join(", ") || "entry only"}` : "Not run yet"}</div>
				</div>

				<section className="space-y-2">
					<div className="font-medium">Variables</div>
					<div className="flex gap-2">
						<Input placeholder="Variable name" value={this.state.newVariableName} onChange={(event) => this.setState({ newVariableName: event.target.value })} />
						<Button size="sm" variant="secondary" onClick={() => this._addVariable(scene, graph)}>
							Add Variable
						</Button>
					</div>
					{Object.entries(graph.variables ?? {}).map(([name, value]) => (
						<div key={name} className="grid grid-cols-[minmax(8rem,1fr)_minmax(0,2fr)_auto] items-center gap-2 rounded border border-input p-2">
							<div className="text-sm">{name}</div>
							<Input
								value={JSON.stringify(value)}
								aria-label={`${name} default value`}
								onChange={(event) => this._setVariableValue(scene, graph, name, event.target.value)}
							/>
							<Button size="sm" variant="ghost" onClick={() => this._removeVariable(scene, graph, name)}>
								Remove
							</Button>
						</div>
					))}
					{!Object.keys(graph.variables ?? {}).length && (
						<div className="text-xs text-muted-foreground">No graph variables. Values may be scalars, booleans, arrays, or objects.</div>
					)}
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between gap-2">
						<div>
							<div className="font-medium">Graph Nodes</div>
							<div className="text-xs text-muted-foreground">
								Actions are connected in the graph below. An action value can reference a variable with {`{ "variable": "name" }`}.
							</div>
						</div>
						<div className="flex flex-wrap justify-end gap-1">
							<Button size="sm" variant="secondary" onClick={() => this._addNode(scene, graph, "set-variable")}>
								Set Variable
							</Button>
							<Button size="sm" variant="secondary" disabled={!this._targetNodes(scene).length} onClick={() => this._addNode(scene, graph, "set-position")}>
								Set Position
							</Button>
							<Button size="sm" variant="secondary" disabled={!this._targetNodes(scene).length} onClick={() => this._addNode(scene, graph, "translate")}>
								Translate
							</Button>
							<Button size="sm" variant="secondary" disabled={!this._targetNodes(scene).length} onClick={() => this._addNode(scene, graph, "set-enabled")}>
								Set Enabled
							</Button>
						</div>
					</div>
					{this._renderGraphCanvas(scene, graph)}
					<div className="grid gap-2">{graph.nodes.map((node) => this._renderNode(scene, graph, node))}</div>
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between">
						<div className="font-medium">Connections</div>
						<Button size="sm" variant="secondary" disabled={graph.nodes.length < 2} onClick={() => this._addEdge(scene, graph)}>
							Add Connection
						</Button>
					</div>
					{graph.edges.map((edge, index) => this._renderEdge(scene, graph, edge, index))}
					{!graph.edges.length && <div className="text-xs text-muted-foreground">No connections. Add an edge from the entry event to an action.</div>}
				</section>
			</>
		);
	}

	private _renderGraphCanvas(scene: Scene, graph: IVisualScriptGraph): ReactNode {
		const nodeWidth = 150;
		const nodeHeight = 52;
		const positionOf = (node: IVisualScriptNode, index: number): [number, number] => node.position ?? [20 + (index % 4) * 180, 20 + Math.floor(index / 4) * 90];
		const positions = new Map(graph.nodes.map((node, index) => [node.id, positionOf(node, index)]));
		return (
			<div className="overflow-auto rounded border border-input bg-muted/20">
				<svg
					className="min-h-[280px] min-w-[760px] select-none"
					width="760"
					height={Math.max(280, 40 + Math.ceil(graph.nodes.length / 4) * 90)}
					onMouseMove={(event) => this._moveGraphNode(scene, graph, event)}
					onMouseUp={() => this._endGraphDrag()}
					onMouseLeave={() => this._endGraphDrag()}
				>
					{graph.edges.map((edge, index) => {
						const from = positions.get(edge.from);
						const to = positions.get(edge.to);
						if (!from || !to) return null;
						return (
							<line
								key={`${edge.from}-${edge.to}-${index}`}
								x1={from[0] + nodeWidth}
								y1={from[1] + nodeHeight / 2}
								x2={to[0]}
								y2={to[1] + nodeHeight / 2}
								stroke="currentColor"
								opacity="0.45"
								strokeWidth="2"
							/>
						);
					})}
					{graph.nodes.map((node) => {
						const position = positions.get(node.id)!;
						return (
							<g
								key={node.id}
								transform={`translate(${position[0]}, ${position[1]})`}
								className="cursor-grab active:cursor-grabbing"
								onMouseDown={(event) => this._beginGraphDrag(event, graph, node, position)}
							>
								<rect width={nodeWidth} height={nodeHeight} rx="6" className="fill-background stroke-border" strokeWidth="1" />
								<text x="10" y="22" className="fill-foreground text-xs font-medium">
									{node.type}
								</text>
								<text x="10" y="40" className="fill-muted-foreground text-[10px]">
									{node.id.slice(0, 10)}
								</text>
							</g>
						);
					})}
				</svg>
			</div>
		);
	}

	private _beginGraphDrag(event: React.MouseEvent<SVGGElement>, graph: IVisualScriptGraph, node: IVisualScriptNode, position: [number, number]): void {
		event.preventDefault();
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) return;
		const bounds = svg.getBoundingClientRect();
		this.setState({ graphDrag: { graphId: graph.id, nodeId: node.id, offset: [event.clientX - bounds.left - position[0], event.clientY - bounds.top - position[1]] } });
	}

	private _moveGraphNode(scene: Scene, graph: IVisualScriptGraph, event: React.MouseEvent<SVGSVGElement>): void {
		const drag = this.state.graphDrag;
		if (!drag || drag.graphId !== graph.id) return;
		const bounds = event.currentTarget.getBoundingClientRect();
		const position: [number, number] = [Math.max(0, event.clientX - bounds.left - drag.offset[0]), Math.max(0, event.clientY - bounds.top - drag.offset[1])];
		const node = graph.nodes.find((candidate) => candidate.id === drag.nodeId);
		if (!node) return;
		setVisualScriptNodePosition(scene, { id: graph.id, nodeId: node.id, position }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _endGraphDrag(): void {
		if (this.state.graphDrag) this.setState({ graphDrag: null });
	}

	private _renderNode(scene: Scene, graph: IVisualScriptGraph, node: IVisualScriptNode): ReactNode {
		const targetRequired = node.type !== "event-start" && node.type !== "set-variable";
		return (
			<div key={node.id} className="grid grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 rounded border border-input p-2">
				<div className="text-sm font-medium">{node.type}</div>
				{targetRequired ? (
					this._renderTargetPicker(scene, graph, node)
				) : node.type === "set-variable" ? (
					this._renderVariablePicker(scene, graph, node)
				) : (
					<div className="text-xs text-muted-foreground">Graph entry event</div>
				)}
				{node.type !== "event-start" ? (
					<Input
						value={node.value === undefined ? "" : JSON.stringify(node.value)}
						aria-label={`${node.id} action value`}
						onChange={(event) => this._setNodeValue(scene, graph, node, event.target.value)}
					/>
				) : (
					<div />
				)}
				<Button
					size="sm"
					variant="ghost"
					disabled={node.type === "event-start" && graph.nodes.filter((candidate) => candidate.type === "event-start").length === 1}
					onClick={() => this._removeNode(scene, graph, node.id)}
				>
					Remove
				</Button>
			</div>
		);
	}

	private _renderTargetPicker(scene: Scene, graph: IVisualScriptGraph, node: IVisualScriptNode): ReactNode {
		const targets = this._targetNodes(scene);
		return (
			<select
				className="h-9 rounded-md border border-input bg-background px-3 text-sm"
				value={node.nodeId ?? ""}
				onChange={(event) => this._replaceNode(scene, graph, node.id, { ...node, nodeId: event.target.value })}
			>
				{targets.map((target) => (
					<option key={target.id} value={target.id}>
						{target.name}
					</option>
				))}
			</select>
		);
	}

	private _renderVariablePicker(scene: Scene, graph: IVisualScriptGraph, node: IVisualScriptNode): ReactNode {
		const variables = Object.keys(graph.variables ?? {});
		return variables.length ? (
			<select
				className="h-9 rounded-md border border-input bg-background px-3 text-sm"
				value={node.variable ?? variables[0]}
				onChange={(event) => this._replaceNode(scene, graph, node.id, { ...node, variable: event.target.value })}
			>
				{variables.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</select>
		) : (
			<div className="text-xs text-destructive">Add a variable before using this node.</div>
		);
	}

	private _renderEdge(scene: Scene, graph: IVisualScriptGraph, edge: { from: string; to: string }, index: number): ReactNode {
		return (
			<div key={`${edge.from}-${edge.to}-${index}`} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 rounded border border-input p-2">
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={edge.from}
					onChange={(event) => this._replaceEdge(scene, graph, index, { ...edge, from: event.target.value })}
				>
					{graph.nodes.map((node) => (
						<option key={node.id} value={node.id}>
							{node.type} ({node.id.slice(0, 8)})
						</option>
					))}
				</select>
				<select
					className="h-8 rounded-md border border-input bg-background px-2 text-xs"
					value={edge.to}
					onChange={(event) => this._replaceEdge(scene, graph, index, { ...edge, to: event.target.value })}
				>
					{graph.nodes.map((node) => (
						<option key={node.id} value={node.id}>
							{node.type} ({node.id.slice(0, 8)})
						</option>
					))}
				</select>
				<Button size="sm" variant="ghost" onClick={() => this._set(scene, graph, { edges: graph.edges.filter((_, edgeIndex) => edgeIndex !== index) })}>
					Remove
				</Button>
			</div>
		);
	}

	private _getGraphs(scene: Scene): IVisualScriptGraph[] {
		return listVisualScriptGraphs(scene).graphs as IVisualScriptGraph[];
	}

	private _targetNodes(scene: Scene): any[] {
		return scene.getNodes().filter((node: any) => Boolean(node.position));
	}

	private _createGraph(scene: Scene): void {
		const graph = createVisualScriptGraph(scene, { name: `Visual Script ${this._getGraphs(scene).length + 1}` }, { editor: this.props.editor }) as IVisualScriptGraph;
		this.setState({ selectedGraphId: graph.id });
	}

	private _set(scene: Scene, graph: IVisualScriptGraph, update: Partial<IVisualScriptGraph>): void {
		setVisualScriptGraph(scene, { id: graph.id, ...update }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _delete(scene: Scene, graph: IVisualScriptGraph): void {
		deleteVisualScriptGraph(scene, { id: graph.id }, { editor: this.props.editor });
		this.setState({ selectedGraphId: null });
	}

	private _run(scene: Scene, graph: IVisualScriptGraph): void {
		runVisualScriptGraph(scene, { id: graph.id }, { editor: this.props.editor });
		this.forceUpdate();
	}

	private _addVariable(scene: Scene, graph: IVisualScriptGraph): void {
		const name = this.state.newVariableName.trim();
		const variables = graph.variables ?? {};
		if (!name || name in variables) return;
		this._set(scene, graph, { variables: { ...variables, [name]: 0 } });
		this.setState({ newVariableName: "" });
	}

	private _setVariableValue(scene: Scene, graph: IVisualScriptGraph, name: string, text: string): void {
		try {
			this._set(scene, graph, { variables: { ...graph.variables, [name]: JSON.parse(text) } });
		} catch {
			// Keep the current valid value while the user is typing JSON.
		}
	}

	private _removeVariable(scene: Scene, graph: IVisualScriptGraph, name: string): void {
		if (graph.nodes.some((node) => node.variable === name || node.value?.variable === name)) return;
		const variables = { ...graph.variables };
		delete variables[name];
		this._set(scene, graph, { variables });
	}

	private _addNode(scene: Scene, graph: IVisualScriptGraph, type: Exclude<VisualScriptNodeType, "event-start">): void {
		const target = this._targetNodes(scene)[0];
		const variable = Object.keys(graph.variables ?? {})[0];
		if (type === "set-variable" && !variable) return;
		const value = type === "set-enabled" ? true : type === "set-variable" ? 0 : [0, 0, 0];
		const node: IVisualScriptNode = { id: Tools.RandomId(), type, value, ...(type === "set-variable" ? { variable } : { nodeId: target.id }) };
		this._set(scene, graph, { nodes: [...graph.nodes, node] });
	}

	private _setNodeValue(scene: Scene, graph: IVisualScriptGraph, node: IVisualScriptNode, text: string): void {
		try {
			this._replaceNode(scene, graph, node.id, { ...node, value: JSON.parse(text) });
		} catch {
			// Keep the current valid value while the user is typing JSON.
		}
	}

	private _replaceNode(scene: Scene, graph: IVisualScriptGraph, id: string, replacement: IVisualScriptNode): void {
		this._set(scene, graph, { nodes: graph.nodes.map((node) => (node.id === id ? replacement : node)) });
	}

	private _removeNode(scene: Scene, graph: IVisualScriptGraph, id: string): void {
		this._set(scene, graph, { nodes: graph.nodes.filter((node) => node.id !== id), edges: graph.edges.filter((edge) => edge.from !== id && edge.to !== id) });
	}

	private _addEdge(scene: Scene, graph: IVisualScriptGraph): void {
		this._set(scene, graph, { edges: [...graph.edges, { from: graph.nodes[0].id, to: graph.nodes[1].id }] });
	}

	private _replaceEdge(scene: Scene, graph: IVisualScriptGraph, index: number, replacement: { from: string; to: string }): void {
		this._set(scene, graph, { edges: graph.edges.map((edge, edgeIndex) => (edgeIndex === index ? replacement : edge)) });
	}
}
