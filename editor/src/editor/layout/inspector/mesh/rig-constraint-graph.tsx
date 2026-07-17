import { MouseEvent as ReactMouseEvent, ReactNode, useState } from "react";

import { Scene } from "babylonjs";
import { toast } from "sonner";

import { Button } from "../../../../ui/shadcn/ui/button";
import { getRigConstraintGraph, setRigConstraintGraphLayout } from "../../../../mcp/rigging/rig-constraint-graph";

import { Editor } from "../../../main";

interface IEditorRigConstraintGraphProps {
	editor: Editor;
	scene: Scene;
	layerId: string;
	onChange: () => void;
}

interface IRigConstraintGraphDrag {
	nodeId: string;
	startPointer: [number, number];
	startPosition: [number, number];
	position: [number, number];
	fingerprint: string;
}

const nodeWidth = 184;
const nodeHeight = 62;

function pointerPosition(event: ReactMouseEvent<SVGElement>, svg: SVGSVGElement, width: number, height: number): [number, number] {
	const bounds = svg.getBoundingClientRect();
	return [(event.clientX - bounds.left) * (width / bounds.width), (event.clientY - bounds.top) * (height / bounds.height)];
}

function shortenedLabel(value: string, maximum = 25): string {
	return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

/** Interactive persisted data-flow canvas for one Animation Rig layer. */
export function EditorRigConstraintGraph(props: IEditorRigConstraintGraphProps): ReactNode {
	const [drag, setDrag] = useState<IRigConstraintGraphDrag | null>(null);
	const graph = getRigConstraintGraph(props.scene, { layerId: props.layerId });
	const positions = new Map<string, { x: number; y: number }>(
		graph.nodes.map((node: any) => [node.id, drag && drag.nodeId === node.id ? { x: drag.position[0], y: drag.position[1] } : { x: node.position[0], y: node.position[1] }])
	);
	const markerId = `rig-graph-arrow-${props.layerId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

	const beginDrag = (event: ReactMouseEvent<SVGGElement>, node: any): void => {
		event.preventDefault();
		event.stopPropagation();
		const svg = event.currentTarget.ownerSVGElement;
		if (!svg) {
			return;
		}
		setDrag({
			nodeId: node.id,
			startPointer: pointerPosition(event, svg, graph.bounds.width, graph.bounds.height),
			startPosition: [node.position[0], node.position[1]],
			position: [node.position[0], node.position[1]],
			fingerprint: graph.fingerprint,
		});
	};
	const moveDrag = (event: ReactMouseEvent<SVGSVGElement>): void => {
		if (!drag) {
			return;
		}
		const pointer = pointerPosition(event, event.currentTarget, graph.bounds.width, graph.bounds.height);
		setDrag({
			...drag,
			position: [Math.max(0, drag.startPosition[0] + pointer[0] - drag.startPointer[0]), Math.max(0, drag.startPosition[1] + pointer[1] - drag.startPointer[1])],
		});
	};
	const endDrag = (): void => {
		if (!drag) {
			return;
		}
		setDrag(null);
		try {
			setRigConstraintGraphLayout(
				props.scene,
				{ layerId: props.layerId, expectedFingerprint: drag.fingerprint, positions: [{ nodeId: drag.nodeId, position: drag.position }] },
				{ editor: props.editor }
			);
			props.onChange();
		} catch (error: any) {
			toast.error(error.message);
		}
	};
	const autoLayout = (): void => {
		try {
			setRigConstraintGraphLayout(props.scene, { layerId: props.layerId, expectedFingerprint: graph.fingerprint, autoLayout: true }, { editor: props.editor });
			props.onChange();
		} catch (error: any) {
			toast.error(error.message);
		}
	};

	return (
		<div className="space-y-1 rounded border border-border bg-background p-1">
			<div className="flex items-center justify-between gap-2 px-1">
				<div>
					<div className="text-xs font-medium">Constraint Graph</div>
					<div className="text-[10px] text-muted-foreground">
						{graph.nodeCount} nodes · {graph.edgeCount} connections · drag any node
					</div>
				</div>
				<Button size="sm" variant="outline" onClick={autoLayout}>
					Auto Layout
				</Button>
			</div>
			{graph.nodes.length === 0 ? (
				<div className="p-3 text-xs text-muted-foreground">Add a constraint to populate this data-flow graph.</div>
			) : (
				<div className="max-h-[28rem] overflow-auto rounded border border-input bg-muted/20">
					<svg
						className="block min-w-[52rem]"
						viewBox={`0 0 ${graph.bounds.width} ${graph.bounds.height}`}
						role="img"
						aria-label={`${graph.layerName} constraint graph`}
						onMouseMove={moveDrag}
						onMouseUp={endDrag}
						onMouseLeave={endDrag}
					>
						<defs>
							<marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
								<path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground" />
							</marker>
						</defs>
						{graph.edges.map((edge: any) => {
							const from = positions.get(edge.from);
							const to = positions.get(edge.to);
							if (!from || !to) {
								return null;
							}
							const x1 = from.x + nodeWidth;
							const y1 = from.y + nodeHeight / 2;
							const x2 = to.x;
							const y2 = to.y + nodeHeight / 2;
							const control = Math.max(40, Math.abs(x2 - x1) * 0.45);
							return (
								<g key={edge.id}>
									<path
										d={`M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`}
										fill="none"
										className="stroke-muted-foreground"
										strokeWidth="1.5"
										markerEnd={`url(#${markerId})`}
									/>
									<text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 5} textAnchor="middle" className="fill-muted-foreground text-[9px]">
										{shortenedLabel(edge.label, 22)}
									</text>
								</g>
							);
						})}
						{graph.nodes.map((node: any) => {
							const position = positions.get(node.id)!;
							const className =
								node.valid === false
									? "fill-destructive/25 stroke-destructive"
									: node.kind === "constraint"
										? "fill-primary/20 stroke-primary"
										: node.kind === "bone"
											? "fill-sky-500/15 stroke-sky-500"
											: "fill-amber-500/15 stroke-amber-500";
							return (
								<g key={node.id} className="cursor-grab active:cursor-grabbing" onMouseDown={(event) => beginDrag(event, node)}>
									<title>{`${node.label} · ${node.subtitle} · ${node.id}`}</title>
									<rect x={position.x} y={position.y} width={nodeWidth} height={nodeHeight} rx="7" className={className} strokeWidth="1.5" />
									<text x={position.x + 10} y={position.y + 25} className="fill-foreground text-xs font-medium">
										{shortenedLabel(node.label)}
									</text>
									<text x={position.x + 10} y={position.y + 44} className="fill-muted-foreground text-[10px]">
										{shortenedLabel(node.subtitle)}
									</text>
								</g>
							);
						})}
					</svg>
				</div>
			)}
		</div>
	);
}
