import { basename, dirname, join } from "path/posix";

import { Component, MouseEvent, ReactNode } from "react";

import { Editor } from "../../main";
import { projectConfiguration } from "../../../project/configuration";
import { AssetDependencyGraphDirection, IAssetDependencyGraph, IAssetDependencyGraphNode } from "../../../mcp/assets/dependency-graph";
import { getAssetDependencyGraph } from "../../../mcp/assets/registry";
import { Button } from "../../../ui/shadcn/ui/button";
import { Input } from "../../../ui/shadcn/ui/input";
import { FileInspectorObject } from "../inspector/file";

export interface IAssetDependencyGraphProps {
	editor: Editor;
	rootPath: string;
	direction?: AssetDependencyGraphDirection;
	depth?: number;
	includeMissing?: boolean;
}

interface IAssetDependencyGraphPosition {
	node: IAssetDependencyGraphNode;
	x: number;
	y: number;
}

interface IAssetDependencyGraphState {
	graph: IAssetDependencyGraph | null;
	direction: AssetDependencyGraphDirection;
	depth: number;
	includeMissing: boolean;
	zoom: number;
	query: string;
	selectedPath: string | null;
	loading: boolean;
	error: string | null;
}

const nodeWidth = 250;
const nodeHeight = 64;
const columnGap = 110;
const rowGap = 30;
const canvasPadding = 55;

export class EditorAssetDependencyGraph extends Component<IAssetDependencyGraphProps, IAssetDependencyGraphState> {
	public state: IAssetDependencyGraphState = {
		graph: null,
		direction: this.props.direction ?? "dependencies",
		depth: this.props.depth ?? 4,
		includeMissing: this.props.includeMissing !== false,
		zoom: 1,
		query: "",
		selectedPath: null,
		loading: true,
		error: null,
	};

	public componentDidMount(): void {
		void this._loadGraph();
	}

	public componentDidUpdate(previousProps: IAssetDependencyGraphProps): void {
		if (previousProps.rootPath !== this.props.rootPath) {
			void this._loadGraph();
		}
	}

	public render(): ReactNode {
		const layout = this._getLayout();
		const graph = this.state.graph;
		const selected = graph?.nodes.find((node) => node.path === this.state.selectedPath) ?? null;
		return (
			<div className="flex flex-col w-full h-full bg-background text-foreground">
				<div className="flex items-center gap-2 min-h-11 px-2 border-b border-border bg-input">
					<div className="font-semibold mr-2">Asset Dependency Graph</div>
					<select
						className="h-8 rounded border border-border bg-background px-2"
						value={this.state.direction}
						onChange={(event) => this.setState({ direction: event.target.value as AssetDependencyGraphDirection }, () => void this._loadGraph())}
					>
						<option value="dependencies">Uses</option>
						<option value="referencedBy">Used By</option>
					</select>
					<label className="flex items-center gap-1 text-xs">
						Depth
						<input
							type="number"
							min={1}
							max={16}
							className="w-14 h-8 rounded border border-border bg-background px-2"
							value={this.state.depth}
							onChange={(event) => this.setState({ depth: Math.min(16, Math.max(1, Number(event.target.value) || 1)) })}
							onBlur={() => void this._loadGraph()}
						/>
					</label>
					<label className="flex items-center gap-1 text-xs whitespace-nowrap">
						<input
							type="checkbox"
							checked={this.state.includeMissing}
							onChange={(event) => this.setState({ includeMissing: event.target.checked }, () => void this._loadGraph())}
						/>
						Missing
					</label>
					<Input placeholder="Highlight path" className="h-8 max-w-56" value={this.state.query} onChange={(event) => this.setState({ query: event.target.value })} />
					<Button variant="outline" className="h-8 px-2" disabled={this.state.loading} onClick={() => void this._loadGraph()}>
						{this.state.loading ? "Loading…" : "Refresh"}
					</Button>
					<div className="ml-auto flex items-center gap-1">
						<Button variant="ghost" className="h-8 w-8 p-0" onClick={() => this._setZoom(this.state.zoom - 0.1)}>
							−
						</Button>
						<div className="w-12 text-center text-xs">{Math.round(this.state.zoom * 100)}%</div>
						<Button variant="ghost" className="h-8 w-8 p-0" onClick={() => this._setZoom(this.state.zoom + 0.1)}>
							+
						</Button>
						<Button variant="ghost" className="h-8 px-2" onClick={() => this.setState({ zoom: 1 })}>
							Reset
						</Button>
					</div>
				</div>
				{this.state.error && <div className="p-3 text-sm text-red-400">{this.state.error}</div>}
				{graph && (
					<div className="flex min-h-0 flex-1">
						<div className="relative min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle,#3f3f46_1px,transparent_1px)] bg-[size:20px_20px]">
							<svg
								width={layout.width * this.state.zoom}
								height={layout.height * this.state.zoom}
								viewBox={`0 0 ${layout.width} ${layout.height}`}
								onClick={() => this.setState({ selectedPath: null })}
							>
								<defs>
									<marker id="asset-dependency-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
										<path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
									</marker>
								</defs>
								{graph.edges.map((edge) => {
									const source = layout.positions.get(edge.sourcePath);
									const target = layout.positions.get(edge.targetPath);
									if (!source || !target) {
										return null;
									}
									const reverse = source.x > target.x;
									const startX = source.x + (reverse ? 0 : nodeWidth);
									const endX = target.x + (reverse ? nodeWidth : 0);
									const startY = source.y + nodeHeight / 2;
									const endY = target.y + nodeHeight / 2;
									const control = Math.abs(endX - startX) * 0.5;
									const color = edge.relationship === "contains" ? "#38bdf8" : edge.missing ? "#ef4444" : edge.cyclic ? "#f59e0b" : "#64748b";
									return (
										<path
											key={`${edge.sourcePath}\0${edge.targetPath}`}
											d={`M ${startX} ${startY} C ${startX + (reverse ? -control : control)} ${startY}, ${endX + (reverse ? control : -control)} ${endY}, ${endX} ${endY}`}
											fill="none"
											stroke={color}
											strokeWidth={edge.cyclic ? 3 : 2}
											strokeDasharray={edge.relationship === "contains" ? "2 6" : edge.missing ? "7 5" : undefined}
											markerEnd="url(#asset-dependency-arrow)"
										/>
									);
								})}
								{layout.items.map(({ node, x, y }) => this._renderNode(node, x, y))}
							</svg>
						</div>
						<div className="w-72 shrink-0 overflow-auto border-l border-border bg-secondary/30 p-3 text-xs">
							<div className="font-semibold text-sm mb-2">Graph Summary</div>
							<div>{graph.nodes.length} nodes</div>
							<div>{graph.edges.length} references</div>
							<div className={graph.cycles.length ? "text-amber-400" : ""}>{graph.cycles.length} cycles</div>
							<div className={graph.edges.some((edge) => edge.missing) ? "text-red-400" : ""}>{graph.edges.filter((edge) => edge.missing).length} missing</div>
							{graph.truncated && <div className="mt-2 text-amber-400">Graph reached the {graph.limit}-edge safety limit.</div>}
							<div className="mt-4 font-semibold text-sm">Selection</div>
							{!selected && <div className="mt-1 text-muted-foreground">Click a graph node to inspect it.</div>}
							{selected && (
								<div className="mt-2 flex flex-col gap-2">
									<div className="break-all">{selected.path}</div>
									<div className="text-muted-foreground">
										{selected.missing ? "Missing reference" : `${selected.virtual ? "Archive member" : (selected.type ?? "asset")} · depth ${selected.depth}`}
									</div>
									{selected.guid && <div className="break-all text-muted-foreground">GUID: {selected.guid}</div>}
									{!selected.missing && !selected.virtual && (
										<>
											<Button variant="outline" className="h-7 px-2" onClick={() => this._inspectPath(selected.path)}>
												Open Inspector
											</Button>
											<Button className="h-7 px-2" onClick={() => this._reroot(selected.path)}>
												Make Root
											</Button>
										</>
									)}
								</div>
							)}
							{graph.cycles.length > 0 && (
								<>
									<div className="mt-4 font-semibold text-sm">Cycles</div>
									{graph.cycles.slice(0, 20).map((cycle) => (
										<div key={cycle.join("\0")} className="mt-2 break-all text-amber-400">
											{cycle.join(" → ")}
										</div>
									))}
								</>
							)}
						</div>
					</div>
				)}
			</div>
		);
	}

	private _renderNode(node: IAssetDependencyGraphNode, x: number, y: number): ReactNode {
		const selected = this.state.selectedPath === node.path;
		const matches = !!this.state.query.trim() && node.path.toLowerCase().includes(this.state.query.trim().toLowerCase());
		const fill = node.missing ? "#7f1d1d" : node.path === this.state.graph?.rootPath ? "#1d4ed8" : node.virtual ? "#164e63" : "#27272a";
		const stroke = selected ? "#f8fafc" : matches ? "#22d3ee" : node.missing ? "#ef4444" : node.virtual ? "#38bdf8" : "#52525b";
		return (
			<g
				key={node.path}
				transform={`translate(${x} ${y})`}
				className="cursor-pointer"
				onClick={(event: MouseEvent<SVGGElement>) => {
					event.stopPropagation();
					this.setState({ selectedPath: node.path });
				}}
				onDoubleClick={() => !node.missing && !node.virtual && this._inspectPath(node.path)}
			>
				<rect width={nodeWidth} height={nodeHeight} rx={8} fill={fill} stroke={stroke} strokeWidth={selected || matches ? 3 : 1.5} />
				<text x={12} y={25} fill="#ffffff" fontSize={13} fontWeight={600}>
					{this._truncate(basename(node.path), 30)}
				</text>
				<text x={12} y={46} fill={node.missing ? "#fecaca" : "#a1a1aa"} fontSize={10}>
					{node.missing ? "MISSING" : node.virtual ? "ARCHIVE MEMBER" : this._truncate(node.path, 39)}
				</text>
			</g>
		);
	}

	private _getLayout(): { items: IAssetDependencyGraphPosition[]; positions: Map<string, IAssetDependencyGraphPosition>; width: number; height: number } {
		const nodes = this.state.graph?.nodes ?? [];
		const columns = new Map<number, IAssetDependencyGraphNode[]>();
		for (const node of nodes) {
			const column = columns.get(node.depth) ?? [];
			column.push(node);
			columns.set(node.depth, column);
		}
		const items: IAssetDependencyGraphPosition[] = [];
		let maximumRows = 1;
		for (const [depth, column] of [...columns.entries()].sort(([a], [b]) => a - b)) {
			column.sort((a, b) => a.path.localeCompare(b.path));
			maximumRows = Math.max(maximumRows, column.length);
			column.forEach((node, row) => items.push({ node, x: canvasPadding + depth * (nodeWidth + columnGap), y: canvasPadding + row * (nodeHeight + rowGap) }));
		}
		return {
			items,
			positions: new Map(items.map((item) => [item.node.path, item])),
			width: Math.max(640, canvasPadding * 2 + (Math.max(0, ...columns.keys()) + 1) * nodeWidth + Math.max(0, columns.size - 1) * columnGap),
			height: Math.max(420, canvasPadding * 2 + maximumRows * nodeHeight + Math.max(0, maximumRows - 1) * rowGap),
		};
	}

	private async _loadGraph(): Promise<void> {
		this.setState({ loading: true, error: null });
		try {
			const graph = await getAssetDependencyGraph({
				path: this.props.rootPath,
				direction: this.state.direction,
				depth: this.state.depth,
				includeMissing: this.state.includeMissing,
				limit: 1000,
			});
			this.setState({ graph, selectedPath: graph.rootPath, loading: false });
		} catch (error) {
			this.setState({ graph: null, error: error instanceof Error ? error.message : String(error), loading: false });
		}
	}

	private _inspectPath(path: string): void {
		const absolutePath = join(dirname(projectConfiguration.path!), path);
		this.props.editor.layout.inspector.setEditedObject(new FileInspectorObject(absolutePath));
		void this.props.editor.layout.assets.setBrowsePath(dirname(absolutePath));
	}

	private _reroot(path: string): void {
		openAssetDependencyGraph(this.props.editor, path, {
			direction: this.state.direction,
			depth: this.state.depth,
			includeMissing: this.state.includeMissing,
		});
	}

	private _setZoom(zoom: number): void {
		this.setState({ zoom: Math.min(2, Math.max(0.5, Number(zoom.toFixed(1)))) });
	}

	private _truncate(value: string, length: number): string {
		return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
	}
}

export function openAssetDependencyGraph(
	editor: Editor,
	rootPath: string,
	options: { direction?: AssetDependencyGraphDirection; depth?: number; includeMissing?: boolean } = {}
): void {
	editor.layout.addLayoutTab(<EditorAssetDependencyGraph editor={editor} rootPath={rootPath} {...options} />, {
		id: "asset-dependency-graph",
		title: `Dependencies: ${basename(rootPath)}`,
		neighborId: "assets-browser",
		enableClose: true,
		setAsActiveTab: true,
	});
}
