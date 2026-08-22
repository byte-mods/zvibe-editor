import { Component, ReactNode } from "react";
import { toast } from "sonner";

import { Scene } from "babylonjs";
import { IComputeNodeGraph, IComputeNodeGraphNode, IComputeNodeSubgraphInstance } from "babylonjs-editor-tools";

import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import {
	addCustomComputeNode,
	compileCustomComputeNodeGraph,
	connectCustomComputeNodes,
	deleteCustomComputeNode,
	disconnectCustomComputeNodes,
	initializeCustomComputeNodeGraph,
	setCustomComputeNode,
} from "../../../mcp/rendering/compute-graph";
import { listCustomRenderPasses, setCustomRenderPassGpuProfiling } from "../../../mcp/rendering/custom-passes";
import { debugCustomComputeNodeGraph } from "../../../mcp/rendering/compute-debug";
import { getCustomComputeTextureNodePreviews } from "../../../mcp/rendering/compute-texture-preview";
import { captureCustomRenderPassOutput } from "../../../mcp/rendering/render-output-preview";
import {
	deleteCustomComputeSubgraph,
	deleteCustomComputeSubgraphInstance,
	getCustomComputeSubgraphDiagnostics,
	insertCustomComputeSubgraph,
	listCustomComputeSubgraphs,
	migrateCustomComputeSubgraph,
	refreshCustomComputeSubgraphInstance,
	saveCustomComputeSubgraph,
	setCustomComputeSubgraphInstance,
} from "../../../mcp/rendering/compute-subgraphs";
import { Editor } from "../../main";

const ports: Record<string, string[]> = {
	"uv-color": ["id", "size"],
	"texture-load": ["id"],
	"storage-load": ["id"],
	"combine-vector": ["x", "y", "z", "w"],
	"split-component": ["value"],
	splat: ["value"],
	swizzle: ["value"],
	compare: ["a", "b"],
	"boolean-not": ["value"],
	"boolean-and": ["a", "b"],
	"boolean-or": ["a", "b"],
	branch: ["whenFalse", "whenTrue", "condition"],
	add: ["a", "b"],
	subtract: ["a", "b"],
	multiply: ["a", "b"],
	divide: ["a", "b"],
	minimum: ["a", "b"],
	maximum: ["a", "b"],
	lerp: ["a", "b", "factor"],
	clamp: ["value", "minimum", "maximum"],
	abs: ["value"],
	sin: ["value"],
	cos: ["value"],
	normalize: ["value"],
	dot: ["a", "b"],
	length: ["value"],
	select: ["whenFalse", "whenTrue", "condition"],
	"storage-store": ["id", "value"],
	"output-store": ["id", "color"],
};

const nodeTypes = [
	"global-id",
	"output-size",
	"constant-color",
	"constant-scalar",
	"uv-color",
	"texture-load",
	"uniform-color",
	"storage-load",
	"add",
	"subtract",
	"multiply",
	"divide",
	"minimum",
	"maximum",
	"lerp",
	"clamp",
	"abs",
	"sin",
	"cos",
	"normalize",
	"dot",
	"length",
	"select",
	"combine-vector",
	"split-component",
	"splat",
	"swizzle",
	"compare",
	"boolean-not",
	"boolean-and",
	"boolean-or",
	"branch",
	"storage-store",
] as const;

interface IComputeGraphPanelState {
	selectedPassId: string | null;
	drag: { nodeId: string; offset: [number, number] } | null;
	from: string;
	to: string;
	toPort: string;
	assetPath: string;
	assetName: string;
	assetNodeIds: string;
	assetOutputNodeId: string;
	subgraphs: any[];
	subgraphDiagnostics: any[];
	computeDebug: any | null;
	texturePreviews: any[];
	outputPreview: any | null;
}

export class EditorComputeGraphPanel extends Component<{ editor: Editor }, IComputeGraphPanelState> {
	public constructor(props: { editor: Editor }) {
		super(props);
		this.state = {
			selectedPassId: null,
			drag: null,
			from: "",
			to: "",
			toPort: "",
			assetPath: "assets/compute/function.computegraph.json",
			assetName: "Compute Function",
			assetNodeIds: "",
			assetOutputNodeId: "",
			subgraphs: [],
			subgraphDiagnostics: [],
			computeDebug: null,
			texturePreviews: [],
			outputPreview: null,
		};
	}

	public componentDidMount(): void {
		void this._refreshSubgraphs();
	}

	public render(): ReactNode {
		const scene = this.props.editor.layout.preview.scene;
		const passes = (listCustomRenderPasses(scene).passes as any[]).filter((pass) => pass.passType === "compute");
		const pass = passes.find((candidate) => candidate.id === this.state.selectedPassId) ?? passes[0] ?? null;
		const graph = pass?.computeSettings.nodeGraph as IComputeNodeGraph | null;
		return (
			<div className="flex h-full flex-col gap-3 overflow-auto p-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="font-semibold">Compute Node Graph</div>
						<div className="text-xs text-muted-foreground">Typed nodes compile to complete WGSL and rebuild the selected WebGPU compute pass.</div>
					</div>
					{pass && (
						<div className="flex gap-2">
							<Button size="sm" variant="secondary" onClick={() => this._initialize(scene, pass.id, Boolean(graph))}>
								{graph ? "Reset Graph" : "Initialize Graph"}
							</Button>
							<Button size="sm" disabled={!graph} onClick={() => this._compile(scene, pass.id)}>
								Compile WGSL
							</Button>
							<Button size="sm" variant="secondary" disabled={!graph} onClick={() => void this._debug(scene, pass.id)}>
								Debug Graph
							</Button>
							<Button size="sm" variant="secondary" onClick={() => void this._enableGpuProfile(scene, pass.id)}>
								Enable GPU Profile
							</Button>
							<Button size="sm" variant="secondary" disabled={!pass.output} onClick={() => void this._captureOutput(scene, pass.output)}>
								Capture Output
							</Button>
						</div>
					)}
				</div>
				{passes.length ? (
					<select
						className="h-9 rounded-md border border-input bg-background px-3 text-sm"
						value={pass?.id ?? ""}
						onChange={(event) =>
							this.setState({
								selectedPassId: event.target.value,
								from: "",
								to: "",
								toPort: "",
								subgraphDiagnostics: [],
								computeDebug: null,
								texturePreviews: [],
								outputPreview: null,
							})
						}
					>
						{passes.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.name}
							</option>
						))}
					</select>
				) : (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">Create a compute render pass in the Scene Inspector first.</div>
				)}
				{pass && !graph && (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">Initialize a node graph to replace authored WGSL with generated WGSL.</div>
				)}
				{pass && graph && this._renderGraph(scene, pass, graph)}
			</div>
		);
	}

	private _renderGraph(scene: Scene, pass: any, graph: IComputeNodeGraph): ReactNode {
		const collapsedNodeIds = new Set((graph.subgraphInstances ?? []).filter((instance) => instance.collapsed).flatMap((instance) => instance.nodeIds));
		return (
			<>
				<div className="flex flex-wrap gap-1">
					{nodeTypes.map((type) => (
						<Button key={type} size="sm" variant="secondary" onClick={() => this._addNode(scene, pass, graph, type)}>
							{type}
						</Button>
					))}
				</div>
				{this._renderCanvas(scene, pass.id, graph)}
				{this._renderDebugSummary()}
				{this._renderOutputPreview()}
				<div className="grid gap-2">{graph.nodes.filter((node) => !collapsedNodeIds.has(node.id)).map((node) => this._renderNode(scene, pass, node))}</div>
				{this._renderConnections(scene, pass.id, graph)}
				{this._renderSubgraphs(scene, pass.id, graph)}
			</>
		);
	}

	private _renderSubgraphs(scene: Scene, passId: string, graph: IComputeNodeGraph): ReactNode {
		return (
			<section className="space-y-2 rounded border border-input p-3">
				<div>
					<div className="font-medium">Reusable Compute Subgraphs</div>
					<div className="text-xs text-muted-foreground">
						Save selected pure nodes as a project asset, then insert renamed graph-function instances into any compute pass.
					</div>
				</div>
				<div className="flex items-center justify-between">
					<div className="text-sm font-medium">Tracked Instances</div>
					<Button size="sm" variant="secondary" onClick={() => void this._refreshSubgraphDiagnostics(scene, passId)}>
						Check Updates
					</Button>
				</div>
				<div className="grid gap-2">
					{(graph.subgraphInstances ?? []).map((instance) => {
						const diagnostic = this.state.subgraphDiagnostics.find((entry) => entry.instanceId === instance.id);
						return (
							<div key={instance.id} className="flex items-center justify-between rounded border border-input p-2 text-xs">
								<div>
									<div className="font-medium">
										{instance.assetName} · {instance.id}
									</div>
									<div className="text-muted-foreground">
										{instance.nodeIds.length} nodes · revision {instance.assetRevision.slice(0, 8)} · {diagnostic?.status ?? "unchecked"}
									</div>
								</div>
								<div className="flex gap-1">
									<Button size="sm" variant="secondary" onClick={() => this._setSubgraphCollapsed(scene, passId, instance, !instance.collapsed)}>
										{instance.collapsed ? "Expand" : "Collapse"}
									</Button>
									<Button
										size="sm"
										variant="secondary"
										disabled={diagnostic?.refreshable === false}
										onClick={() => void this._refreshSubgraphInstance(scene, passId, instance.id)}
									>
										Refresh
									</Button>
									<Button size="sm" variant="ghost" onClick={() => this._deleteSubgraphInstance(scene, passId, instance.id)}>
										Remove
									</Button>
								</div>
							</div>
						);
					})}
					{!(graph.subgraphInstances ?? []).length && <div className="text-xs text-muted-foreground">No tracked subgraph instances in this pass.</div>}
				</div>
				<div className="grid grid-cols-2 gap-2">
					<Input value={this.state.assetName} aria-label="Compute subgraph asset name" onChange={(event) => this.setState({ assetName: event.target.value })} />
					<Input value={this.state.assetPath} aria-label="Compute subgraph asset path" onChange={(event) => this.setState({ assetPath: event.target.value })} />
					<Input
						value={this.state.assetNodeIds}
						aria-label="Compute subgraph node ids"
						placeholder="Node ids, comma separated"
						onChange={(event) => this.setState({ assetNodeIds: event.target.value })}
					/>
					<Input
						value={this.state.assetOutputNodeId}
						aria-label="Compute subgraph output node id"
						placeholder="Output node id"
						onChange={(event) => this.setState({ assetOutputNodeId: event.target.value })}
					/>
				</div>
				<div className="flex gap-2">
					<Button size="sm" onClick={() => void this._saveSubgraph(scene, passId)}>
						Save Selection
					</Button>
					<Button size="sm" variant="secondary" onClick={() => void this._refreshSubgraphs()}>
						Refresh Assets
					</Button>
				</div>
				<div className="grid gap-2">
					{this.state.subgraphs.map((asset) => (
						<div key={asset.path} className="flex items-center justify-between rounded border border-input p-2 text-xs">
							<div>
								<div className="font-medium">{asset.name}</div>
								<div className="text-muted-foreground">
									{asset.path} · {asset.nodeCount} nodes · {asset.inputs.length} inputs · v{asset.sourceVersion}
									{asset.migrationRequired ? ` → v${asset.version}` : ""}
								</div>
							</div>
							<div className="flex gap-1">
								{asset.migrationRequired && (
									<Button size="sm" variant="secondary" onClick={() => void this._migrateSubgraph(scene, asset.path)}>
										Migrate
									</Button>
								)}
								<Button size="sm" variant="secondary" onClick={() => void this._insertSubgraph(scene, passId, graph, asset.path)}>
									Insert
								</Button>
								<Button size="sm" variant="ghost" onClick={() => void this._deleteSubgraph(scene, asset.path)}>
									Delete
								</Button>
							</div>
						</div>
					))}
					{!this.state.subgraphs.length && <div className="text-xs text-muted-foreground">No valid .computegraph.json assets found.</div>}
				</div>
			</section>
		);
	}

	private _renderCanvas(scene: Scene, passId: string, graph: IComputeNodeGraph): ReactNode {
		const width = 170;
		const height = 54;
		const positions = new Map(graph.nodes.map((node) => [node.id, node.position]));
		const collapsedInstances = (graph.subgraphInstances ?? []).filter((instance) => instance.collapsed);
		const collapsedByNode = new Map<string, IComputeNodeSubgraphInstance>();
		collapsedInstances.forEach((instance) => instance.nodeIds.forEach((nodeId) => collapsedByNode.set(nodeId, instance)));
		const canvasHeight = Math.max(320, ...graph.nodes.map((node) => node.position[1] + 90), ...collapsedInstances.map((instance) => instance.position[1] + 100));
		return (
			<div className="overflow-auto rounded border border-input bg-muted/20">
				<svg
					className="min-h-[320px] min-w-[900px] select-none"
					width="900"
					height={canvasHeight}
					onMouseMove={(event) => this._move(scene, passId, event)}
					onMouseUp={() => this.setState({ drag: null })}
					onMouseLeave={() => this.setState({ drag: null })}
				>
					{graph.edges.map((edge, index) => {
						const fromInstance = collapsedByNode.get(edge.from);
						const toInstance = collapsedByNode.get(edge.to);
						if (fromInstance && fromInstance === toInstance) {
							return null;
						}
						const from = fromInstance?.position ?? positions.get(edge.from);
						const to = toInstance?.position ?? positions.get(edge.to);
						if (!from || !to) {
							return null;
						}
						return (
							<line
								key={`${edge.from}-${edge.to}-${edge.toPort}-${index}`}
								x1={from[0] + width}
								y1={from[1] + height / 2}
								x2={to[0]}
								y2={to[1] + height / 2}
								stroke="currentColor"
								opacity="0.5"
								strokeWidth="2"
							/>
						);
					})}
					{graph.nodes
						.filter((node) => !collapsedByNode.has(node.id))
						.map((node) => (
							<g
								key={node.id}
								transform={`translate(${node.position[0]}, ${node.position[1]})`}
								className="cursor-grab active:cursor-grabbing"
								onMouseDown={(event) => this._beginDrag(event, node)}
							>
								<rect width={width} height={height} rx="7" className="fill-background stroke-border" strokeWidth="1" />
								<circle cx="0" cy={height / 2} r="4" className="fill-muted-foreground" />
								<circle cx={width} cy={height / 2} r="4" className="fill-primary" />
								<text x="10" y="23" className="fill-foreground text-xs font-medium">
									{node.type}
								</text>
								<text x="10" y="42" className="fill-muted-foreground text-[10px]">
									{node.id.slice(0, 16)}
								</text>
							</g>
						))}
					{collapsedInstances.map((instance) => (
						<g key={`subgraph-${instance.id}`} transform={`translate(${instance.position[0]}, ${instance.position[1]})`}>
							<rect width={width} height="64" rx="9" className="fill-secondary stroke-primary" strokeWidth="2" />
							<circle cx="0" cy="32" r="5" className="fill-muted-foreground" />
							<circle cx={width} cy="32" r="5" className="fill-primary" />
							<text x="10" y="22" className="fill-foreground text-xs font-semibold">
								{instance.assetName}
							</text>
							<text x="10" y="41" className="fill-muted-foreground text-[10px]">
								Subgraph Call · {instance.inputs.length} inputs
							</text>
							<text x="10" y="56" className="fill-muted-foreground text-[9px]">
								{instance.id.slice(0, 20)}
							</text>
						</g>
					))}
				</svg>
			</div>
		);
	}

	private _renderDebugSummary(): ReactNode {
		const debug = this.state.computeDebug;
		if (!debug) {
			return null;
		}
		return (
			<section className="grid grid-cols-4 gap-2 rounded border border-input p-3 text-xs">
				<div>
					<div className="font-medium">Topology</div>
					<div className="text-muted-foreground">
						{debug.analysis.statistics.nodeCount} nodes · {debug.analysis.complete ? "complete" : `${debug.analysis.disconnectedInputs.length} missing inputs`}
					</div>
				</div>
				<div>
					<div className="font-medium">Compiler</div>
					<div className="text-muted-foreground">{debug.compiler.ready ? "WGSL ready" : (debug.compiler.error ?? "Not compiled")}</div>
				</div>
				<div>
					<div className="font-medium">Runtime</div>
					<div className="text-muted-foreground">
						{debug.runtime.target ? `${debug.profiling.dispatchCount} dispatches` : (debug.runtime.graphError ?? "No live WebGPU target")}
					</div>
				</div>
				<div>
					<div className="font-medium">GPU timing</div>
					<div className="text-muted-foreground">
						{debug.profiling.gpuTimingAvailable
							? `${debug.profiling.gpuPassTimeMs.toFixed(3)} ms pass · ${debug.profiling.gpuPassSampleCount} samples`
							: (debug.profiling.gpuTimingReason ?? "Enable profiling and render frames")}
					</div>
				</div>
				<div className="col-span-4 space-y-1">
					{debug.analysis.diagnostics.map((diagnostic: any, index: number) => (
						<div key={`${diagnostic.nodeId ?? "graph"}-${index}`} className={diagnostic.severity === "error" ? "text-destructive" : "text-muted-foreground"}>
							{diagnostic.nodeId ? `${diagnostic.nodeId}${diagnostic.port ? `.${diagnostic.port}` : ""}: ` : ""}
							{diagnostic.message}
						</div>
					))}
				</div>
			</section>
		);
	}

	private _renderOutputPreview(): ReactNode {
		const value = this.state.outputPreview;
		if (!value) {
			return null;
		}
		return (
			<section className="flex items-center gap-3 rounded border border-input p-3 text-xs">
				{value.preview.imageBase64 && (
					<img
						src={`data:${value.preview.mimeType};base64,${value.preview.imageBase64}`}
						className="max-h-40 max-w-40 rounded border border-input object-contain"
						alt={`${value.output} capture`}
					/>
				)}
				<div>
					<div className="font-medium">{value.output}</div>
					<div className="text-muted-foreground">
						{value.kind} · {value.source.width}×{value.source.height} → {value.preview.width}×{value.preview.height}
					</div>
					<div className={value.runtimeReady ? "text-emerald-500" : "text-amber-500"}>{value.runtimeReady ? "Runtime ready" : "Captured before runtime-ready state"}</div>
					{value.source.nonFiniteValueCount > 0 && <div className="text-destructive">{value.source.nonFiniteValueCount} non-finite channel values normalized</div>}
				</div>
			</section>
		);
	}

	private _renderNode(scene: Scene, pass: any, node: IComputeNodeGraphNode): ReactNode {
		const properties = {
			value: node.value,
			scalarValue: node.scalarValue,
			resourceName: node.resourceName,
			fieldName: node.fieldName,
			component: node.component,
			swizzle: node.swizzle,
			comparison: node.comparison,
		};
		const preview = this.state.computeDebug?.preview?.entries?.find((entry: any) => entry.nodeId === node.id);
		const texturePreview = this.state.texturePreviews.find((entry) => entry.nodeId === node.id);
		return (
			<div key={node.id} className="grid grid-cols-[10rem_minmax(0,1fr)_auto] items-center gap-2 rounded border border-input p-2">
				<div>
					<div className="text-sm font-medium">{node.type}</div>
					<div className="truncate text-[10px] text-muted-foreground">{node.id}</div>
					{preview && (
						<div className={`truncate text-[10px] ${preview.status === "warning" || preview.status === "unavailable" ? "text-amber-500" : "text-emerald-500"}`}>
							{preview.value
								? `Preview ${preview.value.map((value: number) => Number(value.toFixed(3))).join(", ")}`
								: preview.sideEffect
									? `${preview.sideEffect.kind} preview`
									: preview.message}
						</div>
					)}
					{texturePreview?.thumbnail?.imageBase64 && (
						<img
							src={`data:${texturePreview.thumbnail.mimeType};base64,${texturePreview.thumbnail.imageBase64}`}
							className="mt-1 max-h-24 max-w-24 rounded border border-input object-contain [image-rendering:auto]"
							alt={`${node.id} texture preview`}
						/>
					)}
					{texturePreview?.status === "unavailable" && <div className="truncate text-[10px] text-amber-500">{texturePreview.error}</div>}
				</div>
				<Input
					defaultValue={JSON.stringify(properties)}
					aria-label={`${node.id} compute node properties`}
					onBlur={(event) => this._setProperties(scene, pass.id, node, event.currentTarget.value)}
				/>
				<Button size="sm" variant="ghost" disabled={node.type === "output-store"} onClick={() => this._deleteNode(scene, pass.id, node.id)}>
					Remove
				</Button>
			</div>
		);
	}

	private _renderConnections(scene: Scene, passId: string, graph: IComputeNodeGraph): ReactNode {
		const sources = graph.nodes.filter((node) => node.type !== "storage-store" && node.type !== "output-store");
		const targets = graph.nodes.filter((node) => ports[node.type]?.length);
		const from = sources.find((node) => node.id === this.state.from)?.id ?? sources[0]?.id ?? "";
		const toNode = targets.find((node) => node.id === this.state.to) ?? targets[0];
		const toPort = toNode && ports[toNode.type].includes(this.state.toPort) ? this.state.toPort : toNode ? ports[toNode.type][0] : "";
		return (
			<section className="space-y-2">
				<div className="font-medium">Typed Connections</div>
				<div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
					<select className="h-9 rounded border border-input bg-background px-2" value={from} onChange={(event) => this.setState({ from: event.target.value })}>
						{sources.map((node) => (
							<option key={node.id} value={node.id}>
								{node.type} · {node.id.slice(0, 8)}
							</option>
						))}
					</select>
					<select
						className="h-9 rounded border border-input bg-background px-2"
						value={toNode?.id ?? ""}
						onChange={(event) => this.setState({ to: event.target.value, toPort: "" })}
					>
						{targets.map((node) => (
							<option key={node.id} value={node.id}>
								{node.type} · {node.id.slice(0, 8)}
							</option>
						))}
					</select>
					<select className="h-9 rounded border border-input bg-background px-2" value={toPort} onChange={(event) => this.setState({ toPort: event.target.value })}>
						{toNode &&
							ports[toNode.type].map((port) => (
								<option key={port} value={port}>
									{port}
								</option>
							))}
					</select>
					<Button variant="secondary" disabled={!from || !toNode || !toPort} onClick={() => this._connect(scene, passId, from, toNode!.id, toPort)}>
						Connect
					</Button>
				</div>
				{graph.edges.map((edge, index) => (
					<div key={`${edge.from}-${edge.to}-${edge.toPort}-${index}`} className="flex items-center justify-between rounded border border-input p-2 text-xs">
						<span>
							{edge.from} → {edge.to}.{edge.toPort}
						</span>
						<Button size="sm" variant="ghost" onClick={() => this._disconnect(scene, passId, edge)}>
							Remove
						</Button>
					</div>
				))}
			</section>
		);
	}

	private async _refreshSubgraphs(): Promise<void> {
		try {
			const result = await listCustomComputeSubgraphs();
			this.setState({ subgraphs: result.assets });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _migrateSubgraph(scene: Scene, path: string): Promise<void> {
		try {
			const result = await migrateCustomComputeSubgraph(scene, { path }, { editor: this.props.editor });
			toast.success(result.migrated ? `Migrated ${path} to v${result.version}` : `${path} is already current`);
			await this._refreshSubgraphs();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _refreshSubgraphDiagnostics(scene: Scene, passId: string): Promise<void> {
		try {
			const result = await getCustomComputeSubgraphDiagnostics(scene, { id: passId });
			this.setState({ subgraphDiagnostics: result.diagnostics });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setSubgraphCollapsed(scene: Scene, passId: string, instance: IComputeNodeSubgraphInstance, collapsed: boolean): void {
		try {
			setCustomComputeSubgraphInstance(scene, { id: passId, instanceId: instance.id, collapsed }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _refreshSubgraphInstance(scene: Scene, passId: string, instanceId: string): Promise<void> {
		try {
			await refreshCustomComputeSubgraphInstance(scene, { id: passId, instanceId }, { editor: this.props.editor });
			await this._refreshSubgraphDiagnostics(scene, passId);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _deleteSubgraphInstance(scene: Scene, passId: string, instanceId: string): void {
		try {
			deleteCustomComputeSubgraphInstance(scene, { id: passId, instanceId }, { editor: this.props.editor });
			this.setState({ subgraphDiagnostics: this.state.subgraphDiagnostics.filter((entry) => entry.instanceId !== instanceId) });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _saveSubgraph(scene: Scene, passId: string): Promise<void> {
		try {
			const nodeIds = this.state.assetNodeIds
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			const result = await saveCustomComputeSubgraph(
				scene,
				{ id: passId, path: this.state.assetPath, assetName: this.state.assetName, nodeIds, outputNodeId: this.state.assetOutputNodeId },
				{ editor: this.props.editor }
			);
			toast.success(`Saved ${result.name}`);
			await this._refreshSubgraphs();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _insertSubgraph(scene: Scene, passId: string, graph: IComputeNodeGraph, path: string): Promise<void> {
		try {
			const y = Math.max(40, ...graph.nodes.map((node) => node.position[1] + 90));
			const result = await insertCustomComputeSubgraph(scene, { id: passId, path, position: [40, y] }, { editor: this.props.editor });
			toast.success(`Inserted ${result.asset.name}; wire ${result.inputs.length} typed inputs and its output.`);
			await this._refreshSubgraphDiagnostics(scene, passId);
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _deleteSubgraph(scene: Scene, path: string): Promise<void> {
		try {
			await deleteCustomComputeSubgraph(scene, { path }, { editor: this.props.editor });
			await this._refreshSubgraphs();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _initialize(scene: Scene, passId: string, replace: boolean): void {
		try {
			const result = initializeCustomComputeNodeGraph(scene, { id: passId, replace }, { editor: this.props.editor });
			if (result.preview.error) {
				toast.warning(result.preview.error);
			}
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _compile(scene: Scene, passId: string): void {
		try {
			const result = compileCustomComputeNodeGraph(scene, { id: passId }, { editor: this.props.editor });
			if (result.preview.error) {
				toast.warning(result.preview.error);
			} else {
				toast.success(result.diagnostics[0].message);
			}
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _debug(scene: Scene, passId: string): Promise<void> {
		try {
			const result = debugCustomComputeNodeGraph(scene, { id: passId, invocationId: [0, 0, 0] });
			const textures = await getCustomComputeTextureNodePreviews(scene, { id: passId, width: 96, height: 96, includeImage: true });
			this.setState({ computeDebug: result, texturePreviews: textures.entries });
			if (!result.analysis.complete) {
				toast.warning("Compute graph has disconnected inputs. See the debug summary.");
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _enableGpuProfile(scene: Scene, passId: string): Promise<void> {
		try {
			const result = setCustomRenderPassGpuProfiling(scene, { enabled: true, sampleCapacity: 120 }, { editor: this.props.editor });
			if (result.supported) {
				toast.success(`GPU pass profiling enabled (${result.mode}). Render frames, then refresh Debug Graph.`);
			} else {
				toast.warning(result.reason);
			}
			await this._debug(scene, passId);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private async _captureOutput(scene: Scene, output: string): Promise<void> {
		try {
			const result = await captureCustomRenderPassOutput(scene, { output, width: 128, height: 128, includeImage: true });
			this.setState({ outputPreview: result });
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _addNode(scene: Scene, pass: any, graph: IComputeNodeGraph, type: (typeof nodeTypes)[number]): void {
		const node: any = { type, position: [40 + (graph.nodes.length % 4) * 190, 220 + Math.floor(graph.nodes.length / 4) * 90] };
		if (type === "constant-color") {
			node.value = [1, 1, 1, 1];
		}
		if (type === "constant-scalar") {
			node.scalarValue = 1;
		}
		if (type === "split-component") {
			node.component = "x";
		}
		if (type === "swizzle") {
			node.swizzle = "xyzw";
		}
		if (type === "compare") {
			node.comparison = "greater";
		}
		if (type === "texture-load") {
			node.resourceName = Object.keys(pass.inputs)[0] ?? "textureInput";
		}
		if (type === "storage-load" || type === "storage-store") {
			node.resourceName = pass.computeSettings.storageBuffers[0]?.name ?? "storageBuffer";
		}
		if (type === "uniform-color") {
			node.resourceName = pass.computeSettings.uniformBuffers[0]?.name ?? "params";
			node.fieldName = pass.computeSettings.uniformBuffers[0]?.uniforms.find((uniform: any) => uniform.type === "vec4")?.name ?? "color";
		}
		try {
			addCustomComputeNode(scene, { id: pass.id, node }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _setProperties(scene: Scene, passId: string, node: IComputeNodeGraphNode, raw: string): void {
		try {
			const properties = JSON.parse(raw);
			setCustomComputeNode(scene, { id: passId, nodeId: node.id, update: properties }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _deleteNode(scene: Scene, passId: string, nodeId: string): void {
		try {
			deleteCustomComputeNode(scene, { id: passId, nodeId }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _connect(scene: Scene, passId: string, from: string, to: string, toPort: string): void {
		try {
			connectCustomComputeNodes(scene, { id: passId, from, to, toPort }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _disconnect(scene: Scene, passId: string, edge: any): void {
		try {
			disconnectCustomComputeNodes(scene, { id: passId, ...edge }, { editor: this.props.editor });
			this.forceUpdate();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	}

	private _beginDrag(event: React.MouseEvent<SVGGElement>, node: IComputeNodeGraphNode): void {
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		const bounds = svg.getBoundingClientRect();
		this.setState({ drag: { nodeId: node.id, offset: [event.clientX - bounds.left - node.position[0], event.clientY - bounds.top - node.position[1]] } });
	}

	private _move(scene: Scene, passId: string, event: React.MouseEvent<SVGSVGElement>): void {
		if (!this.state.drag) {
			return;
		}
		const bounds = event.currentTarget.getBoundingClientRect();
		const position: [number, number] = [
			Math.max(0, event.clientX - bounds.left - this.state.drag.offset[0]),
			Math.max(0, event.clientY - bounds.top - this.state.drag.offset[1]),
		];
		setCustomComputeNode(scene, { id: passId, nodeId: this.state.drag.nodeId, update: { position } }, { editor: this.props.editor });
		this.forceUpdate();
	}
}
