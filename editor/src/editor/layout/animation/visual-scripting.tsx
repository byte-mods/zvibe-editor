import { ReactNode, useMemo, useState } from "react";

import { Scene } from "babylonjs";
import {
	getGraphToolkitDataTypeStyle,
	getGraphToolkitNodePresentation,
	getVisualScriptNodePorts,
	getDefaultVisualScriptValue,
	IVisualScriptEdgeDefinition,
	IVisualScriptGraphDefinition,
	IVisualScriptNodeDefinition,
	IGraphToolkitPortPresentation,
	visualScriptNodeTypes,
	VisualScriptCollectionKind,
	VisualScriptNodeType,
	VisualScriptValueType,
} from "babylonjs-editor-tools";
import { toast } from "sonner";

import { Button } from "../../../ui/shadcn/ui/button";
import { Checkbox } from "../../../ui/shadcn/ui/checkbox";
import { Input } from "../../../ui/shadcn/ui/input";
import { Textarea } from "../../../ui/shadcn/ui/textarea";

import {
	continueVisualScriptGraph,
	createVisualScriptEdge,
	createVisualScriptGraph,
	createVisualScriptGroup,
	createVisualScriptNode,
	createVisualScriptState,
	createVisualScriptTransition,
	createVisualScriptVariable,
	deleteVisualScriptEdge,
	deleteVisualScriptGraph,
	deleteVisualScriptGroup,
	deleteVisualScriptNode,
	deleteVisualScriptState,
	deleteVisualScriptTransition,
	deleteVisualScriptVariable,
	dispatchVisualScriptEvent,
	getVisualScriptAuthoringSnapshot,
	getVisualScriptRuntime,
	listVisualScriptGraphs,
	restoreVisualScriptAuthoringSnapshot,
	restoreVisualScriptGraphs,
	runVisualScriptGraph,
	setVisualScriptBreakpoints,
	setVisualScriptGraph,
	setVisualScriptGroup,
	setVisualScriptNode,
	setVisualScriptNodePosition,
	setVisualScriptState,
	setVisualScriptTransition,
	setVisualScriptVariable,
	startVisualScriptRuntimeGraph,
	stepVisualScriptGraph,
	stopVisualScriptRuntimeGraph,
} from "../../../mcp/visual-scripting/graphs";
import { registerUndoRedo } from "../../../tools/undoredo";

import { Editor } from "../../main";

export interface IEditorVisualScriptingPanelProps {
	editor: Editor;
}

interface IDragState {
	graphId: string;
	nodeId: string;
	offset: [number, number];
	position: [number, number];
}

const sceneNodeTypes = new Set<VisualScriptNodeType>(["get-position", "set-position", "translate", "set-enabled"]);
const variableNodeTypes = new Set<VisualScriptNodeType>(["get-variable", "set-variable"]);

function defaultNode(graph: IVisualScriptGraphDefinition, scene: Scene, type: VisualScriptNodeType): Partial<IVisualScriptNodeDefinition> {
	const value: Partial<IVisualScriptNodeDefinition> = { type, position: [20 + (graph.nodes.length % 4) * 180, 20 + Math.floor(graph.nodes.length / 4) * 90] };
	if (sceneNodeTypes.has(type)) {
		value.nodeId = scene.getNodes().find((node: any) => node.position)?.id;
	}
	if (variableNodeTypes.has(type)) {
		value.variableId = graph.variables[0]?.id;
	}
	if (type === "event-custom" || type === "trigger-custom-event") {
		value.eventName = "Custom Event";
	}
	if (type === "subgraph") {
		value.subgraphId = listVisualScriptGraphs(scene).graphs.find((candidate: IVisualScriptGraphDefinition) => candidate.kind === "flow" && candidate.id !== graph.id)?.id;
	}
	if (type === "graph-input" || type === "graph-output") {
		value.portName = "value";
	}
	if (type === "compare") {
		value.operator = "equal";
	}
	if (type === "expression") {
		value.expression = "x";
		value.expressionInputs = ["x"];
		value.settings = { inputValues: { x: 0 } };
		value.presentation = { category: "Math", subtitle: "Expression", icon: "sigma", color: "#16a34a", optionEditors: { expression: "textarea" } };
	}
	if (type === "custom") {
		value.unitId = "custom.unit";
		value.ports = { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: [], valueOutputs: [] };
		value.settings = {};
	}
	if (["constant", "set-variable", "set-position", "translate", "set-enabled", "log"].includes(type)) {
		value.value = type === "set-enabled" ? true : type === "set-position" || type === "translate" ? [0, 0, 0] : 0;
	}
	return value;
}

function jsonText(value: unknown): string {
	return JSON.stringify(value ?? null);
}

function parseJsonInput(source: string, label: string): unknown | undefined {
	try {
		return JSON.parse(source);
	} catch {
		toast.error(`${label} must be valid JSON.`);
		return undefined;
	}
}

function ValueEditor(props: { value: unknown; collection?: VisualScriptCollectionKind; label: string; onCommit: (value: unknown) => void }): ReactNode {
	if (!props.collection) {
		return (
			<Textarea
				className="min-h-8 py-1 font-mono"
				defaultValue={jsonText(props.value)}
				onBlur={(event) => {
					const value = parseJsonInput(event.currentTarget.value, props.label);
					value !== undefined && props.onCommit(value);
				}}
			/>
		);
	}
	const values = Array.isArray(props.value) ? props.value : [];
	return (
		<div className="space-y-1 rounded border border-border/60 p-1">
			<div className="flex items-center text-[10px] text-muted-foreground">
				<span className="mr-auto">
					{props.collection} · {values.length}/50 elements
				</span>
				<Button size="sm" variant="ghost" disabled={values.length >= 50} onClick={() => props.onCommit([...values, null])}>
					Add element
				</Button>
			</div>
			{values.map((entry, index) => (
				<div key={index} className="flex gap-1">
					<Input
						className="font-mono"
						defaultValue={jsonText(entry)}
						onBlur={(event) => {
							const value = parseJsonInput(event.currentTarget.value, `${props.label} element ${index}`);
							if (value !== undefined) {
								const next = [...values];
								next[index] = value;
								props.onCommit(next);
							}
						}}
					/>
					<Button size="sm" variant="ghost" onClick={() => props.onCommit(values.filter((_, candidate) => candidate !== index))}>
						×
					</Button>
				</div>
			))}
		</div>
	);
}

/** Complete normal editor surface for versioned Flow/State authoring and live debugger control. */
export function EditorVisualScriptingPanel(props: IEditorVisualScriptingPanelProps): ReactNode {
	const scene = props.editor.layout.preview.scene;
	const [version, setVersion] = useState(0);
	const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
	const [newGraphKind, setNewGraphKind] = useState<"flow" | "state">("flow");
	const [newVariableName, setNewVariableName] = useState("");
	const [unitSearch, setUnitSearch] = useState("");
	const [selectedUnit, setSelectedUnit] = useState<VisualScriptNodeType>("set-position");
	const [edgeKind, setEdgeKind] = useState<"control" | "value">("control");
	const [edgeFromNode, setEdgeFromNode] = useState("");
	const [edgeFromPort, setEdgeFromPort] = useState("");
	const [edgeToNode, setEdgeToNode] = useState("");
	const [edgeToPort, setEdgeToPort] = useState("");
	const [eventName, setEventName] = useState("Custom Event");
	const [drag, setDrag] = useState<IDragState | null>(null);
	const graphs = listVisualScriptGraphs(scene).graphs as IVisualScriptGraphDefinition[];
	const graph = graphs.find((candidate) => candidate.id === selectedGraphId) ?? graphs[0] ?? null;
	const options = { editor: props.editor } as any;
	const units = useMemo(() => visualScriptNodeTypes.filter((type) => type.includes(unitSearch.trim().toLowerCase())), [unitSearch]);

	const rerender = (): void => setVersion((value) => value + 1);
	const mutate = (operation: () => void): void => {
		const before = getVisualScriptAuthoringSnapshot(scene);
		try {
			operation();
			const after = getVisualScriptAuthoringSnapshot(scene);
			registerUndoRedo({
				undo: () => restoreVisualScriptAuthoringSnapshot(scene, before, options),
				redo: () => restoreVisualScriptAuthoringSnapshot(scene, after, options),
			});
			rerender();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Visual scripting authoring failed.");
		}
	};
	const runtimeAction = (operation: () => void): void => {
		try {
			if (!(scene as any).visualScripts) {
				restoreVisualScriptGraphs(scene);
			}
			operation();
			rerender();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Visual scripting runtime action failed.");
		}
	};
	let runtime: any = null;
	try {
		runtime = getVisualScriptRuntime(scene, { limit: 24 });
	} catch {
		// Authoring is usable while runtime is stopped.
	}
	const graphRuntime = runtime?.graphs.find((candidate: any) => candidate.graphId === graph?.id);

	const createGraph = (): void => {
		mutate(() => {
			const created = createVisualScriptGraph(scene, { name: `${newGraphKind === "flow" ? "Flow" : "State"} Graph ${graphs.length + 1}`, kind: newGraphKind }, options);
			setSelectedGraphId(created.id);
		});
	};

	return (
		<div key={version} className="flex h-full flex-col gap-3 overflow-auto p-3 text-xs">
			<div className="flex items-center justify-between gap-2">
				<div>
					<div className="font-semibold">Visual Scripting</div>
					<div className="text-muted-foreground">
						Flow and State graphs with expressions, typed or untyped ports, editable collections, custom type styling, subgraphs, and live debugging.
					</div>
				</div>
				<div className="flex gap-1">
					<select className="h-8 rounded bg-input px-2" value={newGraphKind} onChange={(event) => setNewGraphKind(event.currentTarget.value as "flow" | "state")}>
						<option value="flow">Flow Graph</option>
						<option value="state">State Graph</option>
					</select>
					<Button size="sm" onClick={createGraph}>
						Create
					</Button>
				</div>
			</div>

			{graphs.length > 0 && (
				<select className="h-9 rounded bg-input px-2" value={graph?.id ?? ""} onChange={(event) => setSelectedGraphId(event.currentTarget.value)}>
					{graphs.map((candidate) => (
						<option key={candidate.id} value={candidate.id}>
							{candidate.name} · {candidate.kind} · r{candidate.revision}
						</option>
					))}
				</select>
			)}

			{!graph ? (
				<div className="flex flex-1 items-center justify-center text-muted-foreground">Create a Flow Graph or State Graph to begin.</div>
			) : (
				<>
					<section className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-1 rounded border border-border p-2">
						<Input
							defaultValue={graph.name}
							onBlur={(event) =>
								event.currentTarget.value.trim() !== graph.name &&
								mutate(
									() =>
										void setVisualScriptGraph(scene, { id: graph.id, expectedRevision: graph.revision, changes: { name: event.currentTarget.value } }, options)
								)
							}
						/>
						<Button
							size="sm"
							variant={graph.enabled ? "secondary" : "ghost"}
							onClick={() =>
								mutate(() => void setVisualScriptGraph(scene, { id: graph.id, expectedRevision: graph.revision, changes: { enabled: !graph.enabled } }, options))
							}
						>
							{graph.enabled ? "Enabled" : "Disabled"}
						</Button>
						<Button
							size="sm"
							variant={graph.autoStart ? "secondary" : "ghost"}
							onClick={() =>
								mutate(
									() => void setVisualScriptGraph(scene, { id: graph.id, expectedRevision: graph.revision, changes: { autoStart: !graph.autoStart } }, options)
								)
							}
						>
							Auto Start
						</Button>
						<Button
							size="sm"
							variant="destructive"
							onClick={() =>
								mutate(() => {
									deleteVisualScriptGraph(scene, { id: graph.id, expectedRevision: graph.revision }, options);
									setSelectedGraphId(null);
								})
							}
						>
							Delete
						</Button>
					</section>

					<section className="space-y-2 rounded border border-border p-2">
						<div className="flex flex-wrap items-center gap-1">
							<span className="mr-auto font-medium">Runtime Debugger</span>
							<Button size="sm" onClick={() => runtimeAction(() => void startVisualScriptRuntimeGraph(scene, { id: graph.id }, options))}>
								Start
							</Button>
							<Button
								size="sm"
								variant="secondary"
								onClick={() => {
									try {
										runVisualScriptGraph(scene, { id: graph.id }, options);
										rerender();
									} catch (error) {
										toast.error(String(error));
									}
								}}
							>
								Run Once
							</Button>
							<Button size="sm" variant="secondary" onClick={() => runtimeAction(() => void stopVisualScriptRuntimeGraph(scene, { id: graph.id }, options))}>
								Stop
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={graphRuntime?.status !== "paused"}
								onClick={() => runtimeAction(() => void continueVisualScriptGraph(scene, { id: graph.id }, options))}
							>
								Continue
							</Button>
							<Button
								size="sm"
								variant="secondary"
								disabled={graphRuntime?.status !== "paused"}
								onClick={() => runtimeAction(() => void stepVisualScriptGraph(scene, { id: graph.id }, options))}
							>
								Step
							</Button>
						</div>
						<div className="flex gap-1">
							<Input value={eventName} onChange={(event) => setEventName(event.currentTarget.value)} placeholder="Custom event" />
							<Button size="sm" onClick={() => runtimeAction(() => void dispatchVisualScriptEvent(scene, { id: graph.id, event: eventName }, options))}>
								Dispatch
							</Button>
						</div>
						<div className="text-muted-foreground">
							Status: {graphRuntime?.status ?? "runtime stopped"} · State: {graphRuntime?.activeStateId ?? "none"} · Node: {graphRuntime?.currentNodeId ?? "none"} ·
							Steps: {graphRuntime?.steps ?? 0}
						</div>
						{graphRuntime?.error && <div className="text-destructive">{graphRuntime.error}</div>}
						{runtime?.trace?.events?.slice(-8).map((entry: any) => (
							<div key={entry.sequence} className="font-mono text-[10px]">
								#{entry.sequence} {entry.graphName} · {entry.event} · {entry.phase} · {entry.nodeId ?? entry.detail ?? "graph"}
							</div>
						))}
					</section>

					<VariableEditor graph={graph} scene={scene} options={options} newName={newVariableName} setNewName={setNewVariableName} mutate={mutate} />
					<TypeStyleEditor graph={graph} scene={scene} options={options} mutate={mutate} />

					{graph.kind === "flow" ? (
						<>
							<section className="space-y-2 rounded border border-border p-2">
								<div className="flex items-center gap-1">
									<span className="mr-auto font-medium">Unit Library</span>
									<Input className="max-w-56" value={unitSearch} onChange={(event) => setUnitSearch(event.currentTarget.value)} placeholder="Search units" />
									<select
										className="h-8 rounded bg-input px-2"
										value={selectedUnit}
										onChange={(event) => setSelectedUnit(event.currentTarget.value as VisualScriptNodeType)}
									>
										{units.map((type) => (
											<option key={type}>{type}</option>
										))}
									</select>
									<Button
										size="sm"
										onClick={() =>
											mutate(
												() =>
													void createVisualScriptNode(
														scene,
														{ id: graph.id, expectedRevision: graph.revision, node: defaultNode(graph, scene, selectedUnit) },
														options
													)
											)
										}
									>
										Add Unit
									</Button>
								</div>
								<GraphCanvas
									graph={graph}
									drag={drag}
									setDrag={setDrag}
									onCommit={(nodeId, position) =>
										mutate(() => void setVisualScriptNodePosition(scene, { id: graph.id, expectedRevision: graph.revision, nodeId, position }, options))
									}
								/>
								<div className="grid gap-2">
									{graph.nodes.map((node) => (
										<NodeEditor
											key={node.id}
											graph={graph}
											node={node}
											scene={scene}
											graphs={graphs}
											runtimeState={graphRuntime}
											mutate={mutate}
											runtimeAction={runtimeAction}
											options={options}
										/>
									))}
								</div>
							</section>
							<EdgeEditor
								graph={graph}
								kind={edgeKind}
								setKind={setEdgeKind}
								fromNode={edgeFromNode}
								setFromNode={setEdgeFromNode}
								fromPort={edgeFromPort}
								setFromPort={setEdgeFromPort}
								toNode={edgeToNode}
								setToNode={setEdgeToNode}
								toPort={edgeToPort}
								setToPort={setEdgeToPort}
								mutate={mutate}
								scene={scene}
								options={options}
							/>
							<GroupEditor graph={graph} mutate={mutate} scene={scene} options={options} />
						</>
					) : (
						<StateEditor graph={graph} graphs={graphs} mutate={mutate} scene={scene} options={options} />
					)}
				</>
			)}
		</div>
	);
}

function VariableEditor(props: {
	graph: IVisualScriptGraphDefinition;
	scene: Scene;
	options: any;
	newName: string;
	setNewName: (value: string) => void;
	mutate: (operation: () => void) => void;
}): ReactNode {
	return (
		<section className="space-y-2 rounded border border-border p-2">
			<div className="flex gap-1">
				<span className="mr-auto font-medium">Blackboard Variables</span>
				<Input className="max-w-52" value={props.newName} onChange={(event) => props.setNewName(event.currentTarget.value)} placeholder="Variable name" />
				<Button
					size="sm"
					onClick={() => {
						const name = props.newName.trim();
						if (!name) {
							return;
						}
						props.mutate(
							() =>
								void createVisualScriptVariable(
									props.scene,
									{ id: props.graph.id, expectedRevision: props.graph.revision, variable: { name, scope: "graph", type: "number", defaultValue: 0 } },
									props.options
								)
						);
						props.setNewName("");
					}}
				>
					Add
				</Button>
			</div>
			{props.graph.variables.map((variable) => {
				const style = getGraphToolkitDataTypeStyle(props.graph, variable.dataType ?? variable.type);
				return (
					<div
						key={variable.id}
						className="grid grid-cols-[minmax(6rem,1fr)_7rem_7rem_6rem_minmax(7rem,1fr)_minmax(8rem,1fr)_auto] gap-1 border-l-2 pl-1"
						style={{ borderColor: style.color }}
						title={`${style.label} · ${style.icon}`}
					>
						<Input
							defaultValue={variable.name}
							onBlur={(event) =>
								event.currentTarget.value !== variable.name &&
								props.mutate(
									() =>
										void setVisualScriptVariable(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, variableId: variable.id, changes: { name: event.currentTarget.value } },
											props.options
										)
								)
							}
						/>
						<select
							className="rounded bg-input px-1"
							value={variable.scope}
							onChange={(event) =>
								props.mutate(
									() =>
										void setVisualScriptVariable(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, variableId: variable.id, changes: { scope: event.currentTarget.value } },
											props.options
										)
								)
							}
						>
							{["flow", "graph", "object", "scene", "application", "saved"].map((scope) => (
								<option key={scope}>{scope}</option>
							))}
						</select>
						<select
							className="rounded bg-input px-1"
							value={variable.type}
							onChange={(event) => {
								const type = event.currentTarget.value as VisualScriptValueType;
								props.mutate(
									() =>
										void setVisualScriptVariable(
											props.scene,
											{
												id: props.graph.id,
												expectedRevision: props.graph.revision,
												variableId: variable.id,
												changes: { type, defaultValue: variable.collection ? [] : getDefaultVisualScriptValue(type) },
											},
											props.options
										)
								);
							}}
						>
							{["untyped", "any", "boolean", "number", "string", "vector2", "vector3", "node"].map((type) => (
								<option key={type}>{type}</option>
							))}
						</select>
						<select
							className="rounded bg-input px-1"
							value={variable.collection ?? "scalar"}
							onChange={(event) => {
								const collection = event.currentTarget.value === "scalar" ? undefined : event.currentTarget.value;
								props.mutate(
									() =>
										void setVisualScriptVariable(
											props.scene,
											{
												id: props.graph.id,
												expectedRevision: props.graph.revision,
												variableId: variable.id,
												changes: { collection, defaultValue: collection ? [] : getDefaultVisualScriptValue(variable.type) },
											},
											props.options
										)
								);
							}}
						>
							<option value="scalar">scalar</option>
							<option value="list">list</option>
							<option value="array">array</option>
						</select>
						<Input
							defaultValue={variable.dataType ?? variable.type}
							title="Style type id"
							onBlur={(event) =>
								event.currentTarget.value !== (variable.dataType ?? variable.type) &&
								props.mutate(
									() =>
										void setVisualScriptVariable(
											props.scene,
											{
												id: props.graph.id,
												expectedRevision: props.graph.revision,
												variableId: variable.id,
												changes: { dataType: event.currentTarget.value },
											},
											props.options
										)
								)
							}
						/>
						<ValueEditor
							value={variable.defaultValue}
							collection={variable.collection}
							label="Variable default"
							onCommit={(defaultValue) =>
								props.mutate(
									() =>
										void setVisualScriptVariable(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, variableId: variable.id, changes: { defaultValue } },
											props.options
										)
								)
							}
						/>
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								props.mutate(
									() =>
										void deleteVisualScriptVariable(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, variableId: variable.id },
											props.options
										)
								)
							}
						>
							×
						</Button>
					</div>
				);
			})}
		</section>
	);
}

function TypeStyleEditor(props: { graph: IVisualScriptGraphDefinition; scene: Scene; options: any; mutate: (operation: () => void) => void }): ReactNode {
	const styles = props.graph.typeStyles ?? [];
	const update = (typeStyles: typeof styles): void =>
		props.mutate(() => void setVisualScriptGraph(props.scene, { id: props.graph.id, expectedRevision: props.graph.revision, changes: { typeStyles } }, props.options));
	return (
		<section className="space-y-2 rounded border border-border p-2">
			<div className="flex items-center">
				<span className="mr-auto font-medium">Graph Toolkit Type Styles</span>
				<Button
					size="sm"
					onClick={() => update([...styles, { typeId: `custom-${styles.length + 1}`, label: `Custom ${styles.length + 1}`, color: "#64748b", icon: "circle" }])}
				>
					Add Style
				</Button>
			</div>
			{styles.map((style, index) => {
				const change = (changes: Partial<(typeof styles)[number]>): void =>
					update(styles.map((entry, candidate) => (candidate === index ? { ...entry, ...changes } : entry)));
				return (
					<div key={`${style.typeId}-${index}`} className="grid grid-cols-[minmax(7rem,1fr)_minmax(7rem,1fr)_5rem_minmax(7rem,1fr)_auto] gap-1">
						<Input
							defaultValue={style.typeId}
							placeholder="Type id"
							onBlur={(event) => event.currentTarget.value !== style.typeId && change({ typeId: event.currentTarget.value })}
						/>
						<Input
							defaultValue={style.label}
							placeholder="Label"
							onBlur={(event) => event.currentTarget.value !== style.label && change({ label: event.currentTarget.value })}
						/>
						<Input
							type="color"
							defaultValue={style.color}
							onBlur={(event) => event.currentTarget.value !== style.color && change({ color: event.currentTarget.value })}
						/>
						<Input
							defaultValue={style.icon}
							placeholder="Icon"
							onBlur={(event) => event.currentTarget.value !== style.icon && change({ icon: event.currentTarget.value })}
						/>
						<Button size="sm" variant="ghost" onClick={() => update(styles.filter((_, candidate) => candidate !== index))}>
							×
						</Button>
					</div>
				);
			})}
			<div className="text-[10px] text-muted-foreground">Variables and ports can reference a style type id for consistent colors and icons.</div>
		</section>
	);
}

function GraphCanvas(props: {
	graph: IVisualScriptGraphDefinition;
	drag: IDragState | null;
	setDrag: (value: IDragState | null) => void;
	onCommit: (nodeId: string, position: [number, number]) => void;
}): ReactNode {
	const width = 900;
	const height = Math.max(320, ...props.graph.nodes.map((node) => node.position[1] + 100));
	const position = (node: IVisualScriptNodeDefinition): [number, number] => (props.drag?.nodeId === node.id ? props.drag.position : node.position);
	return (
		<div className="overflow-auto rounded border border-border bg-muted/20">
			<svg
				width={width}
				height={height}
				className="min-w-[900px] select-none"
				onMouseMove={(event) => {
					if (!props.drag) {
						return;
					}
					const bounds = event.currentTarget.getBoundingClientRect();
					props.setDrag({
						...props.drag,
						position: [
							Math.max(0, Math.min(10000, event.clientX - bounds.left - props.drag.offset[0])),
							Math.max(0, Math.min(10000, event.clientY - bounds.top - props.drag.offset[1])),
						],
					});
				}}
				onMouseUp={() => {
					if (props.drag) {
						props.onCommit(props.drag.nodeId, props.drag.position);
					}
					props.setDrag(null);
				}}
				onMouseLeave={() => {
					if (props.drag) {
						props.onCommit(props.drag.nodeId, props.drag.position);
					}
					props.setDrag(null);
				}}
			>
				{props.graph.groups.map((group) => {
					const members = props.graph.nodes.filter((node) => group.nodeIds.includes(node.id));
					if (!members.length) {
						return null;
					}
					const xs = members.map((node) => position(node)[0]);
					const ys = members.map((node) => position(node)[1]);
					return (
						<rect
							key={group.id}
							x={Math.min(...xs) - 12}
							y={Math.min(...ys) - 28}
							width={Math.max(...xs) - Math.min(...xs) + 174}
							height={Math.max(...ys) - Math.min(...ys) + 96}
							rx="8"
							fill={group.color}
							opacity="0.12"
							stroke={group.color}
						/>
					);
				})}
				{props.graph.edges.map((edge) => {
					const fromNode = props.graph.nodes.find((node) => node.id === edge.from.nodeId);
					const toNode = props.graph.nodes.find((node) => node.id === edge.to.nodeId);
					if (!fromNode || !toNode) {
						return null;
					}
					const from = position(fromNode);
					const to = position(toNode);
					return (
						<g key={edge.id}>
							<line x1={from[0] + 150} y1={from[1] + 32} x2={to[0]} y2={to[1] + 32} stroke={edge.kind === "control" ? "#60a5fa" : "#f59e0b"} strokeWidth="2" />
							<text x={(from[0] + to[0] + 150) / 2} y={(from[1] + to[1] + 64) / 2 - 4} className="fill-muted-foreground text-[9px]">
								{edge.from.port} → {edge.to.port}
							</text>
						</g>
					);
				})}
				{props.graph.nodes.map((node) => {
					const point = position(node);
					const presentation = getGraphToolkitNodePresentation(node);
					return (
						<g
							key={node.id}
							transform={`translate(${point[0]},${point[1]})`}
							className="cursor-grab"
							onMouseDown={(event) => {
								event.preventDefault();
								const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
								props.setDrag({
									graphId: props.graph.id,
									nodeId: node.id,
									position: point,
									offset: [event.clientX - bounds.left - point[0], event.clientY - bounds.top - point[1]],
								});
							}}
						>
							<title>{presentation.tooltip || `${presentation.category} · ${presentation.portLayout} ports`}</title>
							<rect width="150" height="64" rx="6" fill={presentation.color} fillOpacity="0.12" stroke={presentation.color} strokeWidth="1" />
							<text x="9" y="21" className="fill-foreground text-[11px] font-medium">
								{presentation.icon} · {presentation.title}
							</text>
							<text x="9" y="39" className="fill-muted-foreground text-[9px]">
								{presentation.subtitle || presentation.category} · {presentation.portLayout}
							</text>
							<text x="9" y="54" className="fill-muted-foreground text-[9px]">
								{getVisualScriptNodePorts(node).valueInputs.join(",") || "–"} → {getVisualScriptNodePorts(node).valueOutputs.join(",") || "–"}
							</text>
						</g>
					);
				})}
			</svg>
		</div>
	);
}

function NodeEditor(props: {
	graph: IVisualScriptGraphDefinition;
	node: IVisualScriptNodeDefinition;
	scene: Scene;
	graphs: IVisualScriptGraphDefinition[];
	runtimeState: any;
	mutate: (operation: () => void) => void;
	runtimeAction: (operation: () => void) => void;
	options: any;
}): ReactNode {
	const update = (changes: Record<string, unknown>): void =>
		props.mutate(() => void setVisualScriptNode(props.scene, { id: props.graph.id, expectedRevision: props.graph.revision, nodeId: props.node.id, changes }, props.options));
	const targets = props.scene.getNodes();
	const breakpoints = props.runtimeState?.breakpoints ?? [];
	const ports = getVisualScriptNodePorts(props.node);
	const presentation = getGraphToolkitNodePresentation(props.node);
	const canBreakpoint = ports.controlInputs.length > 0 || ports.controlOutputs.length > 0;
	return (
		<div className="space-y-1 rounded bg-input/40 p-2">
			<div className="flex items-center gap-1">
				<span className="mr-auto font-medium">
					{props.node.type} · {props.node.id.slice(0, 8)}
				</span>
				<Button
					size="sm"
					variant={breakpoints.includes(props.node.id) ? "secondary" : "ghost"}
					disabled={!canBreakpoint}
					onClick={() =>
						props.runtimeAction(
							() =>
								void setVisualScriptBreakpoints(
									props.scene,
									{
										id: props.graph.id,
										nodeIds: breakpoints.includes(props.node.id) ? breakpoints.filter((id: string) => id !== props.node.id) : [...breakpoints, props.node.id],
									},
									props.options
								)
						)
					}
				>
					Breakpoint
				</Button>
				<Button size="sm" variant={props.node.enabled ? "secondary" : "ghost"} onClick={() => update({ enabled: !props.node.enabled })}>
					{props.node.enabled ? "On" : "Off"}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					onClick={() =>
						props.mutate(
							() => void deleteVisualScriptNode(props.scene, { id: props.graph.id, expectedRevision: props.graph.revision, nodeId: props.node.id }, props.options)
						)
					}
				>
					×
				</Button>
			</div>
			<div className="grid grid-cols-3 gap-1">
				{props.node.type === "constant" && (
					<>
						<select
							className="h-8 rounded bg-input px-1"
							value={props.node.collection ?? "scalar"}
							onChange={(event) => {
								const collection = event.currentTarget.value === "scalar" ? undefined : event.currentTarget.value;
								update({ collection, value: collection ? [] : 0 });
							}}
						>
							<option value="scalar">Scalar Constant</option>
							<option value="list">List Constant</option>
							<option value="array">Array Constant</option>
						</select>
						<Input defaultValue={props.node.dataType ?? "untyped"} placeholder="Style type id" onBlur={(event) => update({ dataType: event.currentTarget.value })} />
					</>
				)}
				{sceneNodeTypes.has(props.node.type) && (
					<select className="h-8 rounded bg-input px-1" value={props.node.nodeId ?? ""} onChange={(event) => update({ nodeId: event.currentTarget.value })}>
						{targets.map((target) => (
							<option key={target.id} value={target.id}>
								{target.name}
							</option>
						))}
					</select>
				)}
				{variableNodeTypes.has(props.node.type) && (
					<select className="h-8 rounded bg-input px-1" value={props.node.variableId ?? ""} onChange={(event) => update({ variableId: event.currentTarget.value })}>
						{props.graph.variables.map((variable) => (
							<option key={variable.id} value={variable.id}>
								{variable.name}
							</option>
						))}
					</select>
				)}
				{["event-custom", "trigger-custom-event"].includes(props.node.type) && (
					<Input defaultValue={props.node.eventName} onBlur={(event) => update({ eventName: event.currentTarget.value })} />
				)}
				{props.node.type === "subgraph" && (
					<select className="h-8 rounded bg-input px-1" value={props.node.subgraphId ?? ""} onChange={(event) => update({ subgraphId: event.currentTarget.value })}>
						{props.graphs
							.filter((graph) => graph.kind === "flow" && graph.id !== props.graph.id)
							.map((graph) => (
								<option key={graph.id} value={graph.id}>
									{graph.name}
								</option>
							))}
					</select>
				)}
				{["graph-input", "graph-output"].includes(props.node.type) && (
					<Input defaultValue={props.node.portName} onBlur={(event) => update({ portName: event.currentTarget.value })} />
				)}
				{props.node.type === "compare" && (
					<select className="h-8 rounded bg-input px-1" value={props.node.operator ?? "equal"} onChange={(event) => update({ operator: event.currentTarget.value })}>
						{["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual"].map((operator) => (
							<option key={operator}>{operator}</option>
						))}
					</select>
				)}
				{props.node.type === "expression" && (
					<>
						<Input
							className="col-span-3"
							defaultValue={(props.node.expressionInputs ?? []).join(", ")}
							placeholder="Input ports: x, y"
							onBlur={(event) =>
								update({
									expressionInputs: event.currentTarget.value
										.split(",")
										.map((value) => value.trim())
										.filter(Boolean),
								})
							}
						/>
						<Textarea
							className="col-span-3 min-h-24 font-mono"
							defaultValue={props.node.expression}
							placeholder="clamp(speed * delta, 0, 10)"
							onBlur={(event) => event.currentTarget.value !== props.node.expression && update({ expression: event.currentTarget.value })}
						/>
					</>
				)}
				{props.node.type === "custom" && (
					<>
						<Input
							defaultValue={props.node.unitId}
							onBlur={(event) => event.currentTarget.value !== props.node.unitId && update({ unitId: event.currentTarget.value })}
						/>
						<Textarea
							className="min-h-16 font-mono"
							defaultValue={jsonText(props.node.ports)}
							onBlur={(event) => {
								try {
									update({ ports: JSON.parse(event.currentTarget.value) });
								} catch {
									toast.error("Custom unit ports must be valid JSON.");
								}
							}}
						/>
						<Textarea
							className="min-h-16 font-mono"
							defaultValue={jsonText(props.node.settings)}
							onBlur={(event) => {
								try {
									update({ settings: JSON.parse(event.currentTarget.value) });
								} catch {
									toast.error("Custom unit settings must be valid JSON.");
								}
							}}
						/>
					</>
				)}
				{props.node.value !== undefined && props.node.type !== "expression" && (
					<ValueEditor value={props.node.value} collection={props.node.collection} label="Unit value" onCommit={(value) => update({ value })} />
				)}
			</div>
			<details className="rounded border border-border/60 p-1">
				<summary className="cursor-pointer text-[10px] font-medium">Presentation, multiline ports, and node options</summary>
				<div className="mt-1 grid grid-cols-4 gap-1">
					{Object.entries(presentation.optionEditors).map(([field, editor]) => {
						const value = props.node.settings?.[field];
						const change = (next: string): void => update({ settings: { ...(props.node.settings ?? {}), [field]: next } });
						return (
							<label key={field} className={editor === "textarea" ? "col-span-4 space-y-1" : "col-span-2 space-y-1"}>
								<span className="text-[10px] text-muted-foreground">{field} option</span>
								{editor === "textarea" ? (
									<Textarea
										className="min-h-20 font-mono"
										defaultValue={typeof value === "string" ? value : ""}
										onBlur={(event) => change(event.currentTarget.value)}
									/>
								) : (
									<Input defaultValue={typeof value === "string" ? value : ""} onBlur={(event) => change(event.currentTarget.value)} />
								)}
							</label>
						);
					})}
					<Input
						defaultValue={presentation.title}
						placeholder="Title"
						onBlur={(event) => update({ presentation: { ...props.node.presentation, title: event.currentTarget.value } })}
					/>
					<Input
						defaultValue={presentation.category}
						placeholder="Category"
						onBlur={(event) => update({ presentation: { ...props.node.presentation, category: event.currentTarget.value } })}
					/>
					<Input
						defaultValue={presentation.subtitle}
						placeholder="Subtitle"
						onBlur={(event) => update({ presentation: { ...props.node.presentation, subtitle: event.currentTarget.value } })}
					/>
					<Input
						defaultValue={presentation.icon}
						placeholder="Icon"
						onBlur={(event) => update({ presentation: { ...props.node.presentation, icon: event.currentTarget.value } })}
					/>
					<Input
						type="color"
						defaultValue={presentation.color}
						onBlur={(event) => update({ presentation: { ...props.node.presentation, color: event.currentTarget.value } })}
					/>
					<select
						className="rounded bg-input px-1"
						value={presentation.portLayout}
						onChange={(event) => update({ presentation: { ...props.node.presentation, portLayout: event.currentTarget.value } })}
					>
						<option value="horizontal">Horizontal ports</option>
						<option value="vertical">Vertical ports</option>
					</select>
					<Input
						className="col-span-2"
						defaultValue={presentation.tooltip}
						placeholder="Node tooltip"
						onBlur={(event) => update({ presentation: { ...props.node.presentation, tooltip: event.currentTarget.value } })}
					/>
					<div className="col-span-4 space-y-1 rounded border border-border/60 p-1">
						<div className="text-[10px] font-medium">Typed/untyped port styling and multiline fields</div>
						{[...new Set(Object.values(ports).flat())].map((port) => {
							const current: IGraphToolkitPortPresentation = props.node.portPresentation?.find((entry) => entry.port === port) ?? { port, type: "untyped" };
							const change = (changes: Partial<IGraphToolkitPortPresentation>): void => {
								const next = [...(props.node.portPresentation ?? []).filter((entry) => entry.port !== port), { ...current, ...changes }];
								update({ portPresentation: next });
							};
							return (
								<div key={port} className="space-y-1">
									<div className="grid grid-cols-[6rem_7rem_6rem_minmax(7rem,1fr)_minmax(8rem,1fr)_auto] items-center gap-1">
										<span className="font-mono">{port}</span>
										<select
											className="h-8 rounded bg-input px-1"
											value={current.type}
											onChange={(event) => change({ type: event.currentTarget.value as VisualScriptValueType })}
										>
											{["untyped", "any", "boolean", "number", "string", "vector2", "vector3", "node"].map((type) => (
												<option key={type}>{type}</option>
											))}
										</select>
										<select
											className="h-8 rounded bg-input px-1"
											value={current.collection ?? "scalar"}
											onChange={(event) =>
												change({
													collection: event.currentTarget.value === "scalar" ? undefined : (event.currentTarget.value as VisualScriptCollectionKind),
												})
											}
										>
											<option value="scalar">scalar</option>
											<option value="list">list</option>
											<option value="array">array</option>
										</select>
										<Input
											defaultValue={current.dataType ?? current.type}
											placeholder="Style type"
											onBlur={(event) => change({ dataType: event.currentTarget.value })}
										/>
										<Input defaultValue={current.tooltip ?? ""} placeholder="Tooltip" onBlur={(event) => change({ tooltip: event.currentTarget.value })} />
										<label className="flex items-center gap-1">
											<Checkbox checked={current.multiline ?? false} onCheckedChange={(checked) => change({ multiline: checked === true })} />
											Multiline
										</label>
									</div>
									{ports.valueInputs.includes(port) && current.multiline && (
										<Textarea
											className="min-h-16 font-mono"
											aria-label={`${port} multiline port fallback`}
											defaultValue={jsonText((props.node.settings?.inputValues as Record<string, unknown> | undefined)?.[port])}
											onBlur={(event) => {
												const value = parseJsonInput(event.currentTarget.value, `${port} port fallback`);
												value !== undefined &&
													update({
														settings: {
															...(props.node.settings ?? {}),
															inputValues: { ...((props.node.settings?.inputValues as Record<string, unknown> | undefined) ?? {}), [port]: value },
														},
													});
											}}
										/>
									)}
								</div>
							);
						})}
					</div>
					<Textarea
						className="col-span-2 min-h-20 font-mono"
						defaultValue={jsonText(props.node.settings ?? {})}
						placeholder='{"inputValues":{"x":0}}'
						onBlur={(event) => {
							try {
								update({ settings: JSON.parse(event.currentTarget.value) });
							} catch {
								toast.error("Node options must be valid JSON.");
							}
						}}
					/>
				</div>
			</details>
			<div className="text-[10px] text-muted-foreground">
				Control in/out: {getVisualScriptNodePorts(props.node).controlInputs.join(", ") || "none"} /{" "}
				{getVisualScriptNodePorts(props.node).controlOutputs.join(", ") || "none"} · Value in/out: {getVisualScriptNodePorts(props.node).valueInputs.join(", ") || "none"} /{" "}
				{getVisualScriptNodePorts(props.node).valueOutputs.join(", ") || "none"}
			</div>
		</div>
	);
}

function EdgeEditor(props: {
	graph: IVisualScriptGraphDefinition;
	kind: "control" | "value";
	setKind: (value: "control" | "value") => void;
	fromNode: string;
	setFromNode: (value: string) => void;
	fromPort: string;
	setFromPort: (value: string) => void;
	toNode: string;
	setToNode: (value: string) => void;
	toPort: string;
	setToPort: (value: string) => void;
	mutate: (operation: () => void) => void;
	scene: Scene;
	options: any;
}): ReactNode {
	const from = props.graph.nodes.find((node) => node.id === props.fromNode) ?? props.graph.nodes[0];
	const to = props.graph.nodes.find((node) => node.id === props.toNode) ?? props.graph.nodes[1] ?? props.graph.nodes[0];
	const fromPorts = from ? getVisualScriptNodePorts(from)[props.kind === "control" ? "controlOutputs" : "valueOutputs"] : [];
	const toPorts = to ? getVisualScriptNodePorts(to)[props.kind === "control" ? "controlInputs" : "valueInputs"] : [];
	const create = (): void => {
		if (!from || !to || !fromPorts.length || !toPorts.length) {
			return;
		}
		props.mutate(
			() =>
				void createVisualScriptEdge(
					props.scene,
					{
						id: props.graph.id,
						expectedRevision: props.graph.revision,
						edge: {
							kind: props.kind,
							from: { nodeId: from.id, port: fromPorts.includes(props.fromPort) ? props.fromPort : fromPorts[0] },
							to: { nodeId: to.id, port: toPorts.includes(props.toPort) ? props.toPort : toPorts[0] },
						},
					},
					props.options
				)
		);
	};
	return (
		<section className="space-y-2 rounded border border-border p-2">
			<div className="flex gap-1">
				<span className="mr-auto font-medium">Port Connections</span>
				<select className="rounded bg-input px-1" value={props.kind} onChange={(event) => props.setKind(event.currentTarget.value as "control" | "value")}>
					<option value="control">Control</option>
					<option value="value">Value</option>
				</select>
				<select className="rounded bg-input px-1" value={from?.id ?? ""} onChange={(event) => props.setFromNode(event.currentTarget.value)}>
					{props.graph.nodes.map((node) => (
						<option key={node.id} value={node.id}>
							{node.type}
						</option>
					))}
				</select>
				<select
					className="rounded bg-input px-1"
					value={fromPorts.includes(props.fromPort) ? props.fromPort : (fromPorts[0] ?? "")}
					onChange={(event) => props.setFromPort(event.currentTarget.value)}
				>
					{fromPorts.map((port) => (
						<option key={port}>{port}</option>
					))}
				</select>
				<span>→</span>
				<select className="rounded bg-input px-1" value={to?.id ?? ""} onChange={(event) => props.setToNode(event.currentTarget.value)}>
					{props.graph.nodes.map((node) => (
						<option key={node.id} value={node.id}>
							{node.type}
						</option>
					))}
				</select>
				<select
					className="rounded bg-input px-1"
					value={toPorts.includes(props.toPort) ? props.toPort : (toPorts[0] ?? "")}
					onChange={(event) => props.setToPort(event.currentTarget.value)}
				>
					{toPorts.map((port) => (
						<option key={port}>{port}</option>
					))}
				</select>
				<Button size="sm" onClick={create}>
					Connect
				</Button>
			</div>
			{props.graph.edges.map((edge: IVisualScriptEdgeDefinition) => (
				<div key={edge.id} className="flex items-center gap-1 rounded bg-input/40 p-1">
					<span className="mr-auto">
						{edge.kind}: {edge.from.nodeId}.{edge.from.port} → {edge.to.nodeId}.{edge.to.port}
					</span>
					<Button
						size="sm"
						variant="ghost"
						onClick={() =>
							props.mutate(
								() => void deleteVisualScriptEdge(props.scene, { id: props.graph.id, expectedRevision: props.graph.revision, edgeId: edge.id }, props.options)
							)
						}
					>
						×
					</Button>
				</div>
			))}
		</section>
	);
}

function GroupEditor(props: { graph: IVisualScriptGraphDefinition; mutate: (operation: () => void) => void; scene: Scene; options: any }): ReactNode {
	return (
		<section className="space-y-2 rounded border border-border p-2">
			<div className="flex items-center">
				<span className="mr-auto font-medium">Graph Groups</span>
				<Button
					size="sm"
					onClick={() =>
						props.mutate(
							() =>
								void createVisualScriptGroup(
									props.scene,
									{
										id: props.graph.id,
										expectedRevision: props.graph.revision,
										group: { name: `Group ${props.graph.groups.length + 1}`, color: "#64748b", nodeIds: [] },
									},
									props.options
								)
						)
					}
				>
					Add Group
				</Button>
			</div>
			{props.graph.groups.map((group) => (
				<div key={group.id} className="space-y-1 rounded bg-input/40 p-1">
					<div className="flex gap-1">
						<Input
							defaultValue={group.name}
							onBlur={(event) =>
								props.mutate(
									() =>
										void setVisualScriptGroup(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, groupId: group.id, changes: { name: event.currentTarget.value } },
											props.options
										)
								)
							}
						/>
						<Input
							type="color"
							defaultValue={group.color}
							onBlur={(event) =>
								props.mutate(
									() =>
										void setVisualScriptGroup(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, groupId: group.id, changes: { color: event.currentTarget.value } },
											props.options
										)
								)
							}
						/>
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								props.mutate(
									() =>
										void deleteVisualScriptGroup(props.scene, { id: props.graph.id, expectedRevision: props.graph.revision, groupId: group.id }, props.options)
								)
							}
						>
							×
						</Button>
					</div>
					<div className="flex flex-wrap gap-1">
						{props.graph.nodes.map((node) => (
							<label key={node.id} className="flex items-center gap-1">
								<Checkbox
									checked={group.nodeIds.includes(node.id)}
									onCheckedChange={(checked) =>
										props.mutate(
											() =>
												void setVisualScriptGroup(
													props.scene,
													{
														id: props.graph.id,
														expectedRevision: props.graph.revision,
														groupId: group.id,
														changes: { nodeIds: checked ? [...group.nodeIds, node.id] : group.nodeIds.filter((id) => id !== node.id) },
													},
													props.options
												)
										)
									}
								/>
								{node.type}
							</label>
						))}
					</div>
				</div>
			))}
		</section>
	);
}

function StateEditor(props: {
	graph: IVisualScriptGraphDefinition;
	graphs: IVisualScriptGraphDefinition[];
	mutate: (operation: () => void) => void;
	scene: Scene;
	options: any;
}): ReactNode {
	const flowGraphs = props.graphs.filter((graph) => graph.kind === "flow");
	return (
		<>
			<section className="space-y-2 rounded border border-border p-2">
				<div className="flex items-center">
					<span className="mr-auto font-medium">States</span>
					<Button
						size="sm"
						onClick={() =>
							props.mutate(
								() =>
									void createVisualScriptState(
										props.scene,
										{ id: props.graph.id, expectedRevision: props.graph.revision, state: { name: `State ${props.graph.states.length + 1}` } },
										props.options
									)
							)
						}
					>
						Add State
					</Button>
				</div>
				{props.graph.states.map((state) => (
					<div key={state.id} className="grid grid-cols-[minmax(6rem,1fr)_8rem_auto_repeat(3,minmax(7rem,1fr))_auto] gap-1 rounded bg-input/40 p-1">
						<Input
							defaultValue={state.name}
							onBlur={(event) =>
								props.mutate(
									() =>
										void setVisualScriptState(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, stateId: state.id, changes: { name: event.currentTarget.value } },
											props.options
										)
								)
							}
						/>
						<div className="flex gap-1">
							{state.position.map((coordinate, index) => (
								<Input
									key={index}
									type="number"
									value={coordinate}
									onChange={(event) => {
										const position: [number, number] = [...state.position];
										position[index] = Number(event.currentTarget.value);
										props.mutate(
											() =>
												void setVisualScriptState(
													props.scene,
													{ id: props.graph.id, expectedRevision: props.graph.revision, stateId: state.id, changes: { position } },
													props.options
												)
										);
									}}
								/>
							))}
						</div>
						<Button
							size="sm"
							variant={state.initial ? "secondary" : "ghost"}
							onClick={() =>
								!state.initial &&
								props.mutate(
									() =>
										void setVisualScriptState(
											props.scene,
											{ id: props.graph.id, expectedRevision: props.graph.revision, stateId: state.id, changes: { initial: true } },
											props.options
										)
								)
							}
						>
							Initial
						</Button>
						{(["onEnterGraphId", "onUpdateGraphId", "onExitGraphId"] as const).map((field) => (
							<select
								key={field}
								className="rounded bg-input px-1"
								value={state[field] ?? ""}
								onChange={(event) =>
									props.mutate(
										() =>
											void setVisualScriptState(
												props.scene,
												{
													id: props.graph.id,
													expectedRevision: props.graph.revision,
													stateId: state.id,
													changes: { [field]: event.currentTarget.value || undefined },
												},
												props.options
											)
									)
								}
							>
								<option value="">{field.replace("GraphId", "")}: none</option>
								{flowGraphs.map((graph) => (
									<option key={graph.id} value={graph.id}>
										{graph.name}
									</option>
								))}
							</select>
						))}
						<Button
							size="sm"
							variant="ghost"
							disabled={state.initial}
							onClick={() =>
								props.mutate(
									() =>
										void deleteVisualScriptState(props.scene, { id: props.graph.id, expectedRevision: props.graph.revision, stateId: state.id }, props.options)
								)
							}
						>
							×
						</Button>
					</div>
				))}
			</section>
			<section className="space-y-2 rounded border border-border p-2">
				<div className="flex items-center">
					<span className="mr-auto font-medium">Transitions</span>
					<Button
						size="sm"
						disabled={!props.graph.states.length}
						onClick={() =>
							props.mutate(
								() =>
									void createVisualScriptTransition(
										props.scene,
										{
											id: props.graph.id,
											expectedRevision: props.graph.revision,
											transition: {
												fromStateId: props.graph.states[0].id,
												toStateId: props.graph.states[1]?.id ?? props.graph.states[0].id,
												eventName: "update",
											},
										},
										props.options
									)
							)
						}
					>
						Add Transition
					</Button>
				</div>
				{props.graph.transitions.map((transition) => {
					const update = (changes: Record<string, unknown>): void =>
						props.mutate(
							() =>
								void setVisualScriptTransition(
									props.scene,
									{ id: props.graph.id, expectedRevision: props.graph.revision, transitionId: transition.id, changes },
									props.options
								)
						);
					return (
						<div
							key={transition.id}
							className="grid grid-cols-[minmax(6rem,1fr)_auto_minmax(6rem,1fr)_minmax(7rem,1fr)_minmax(7rem,1fr)_auto_5rem_auto] items-center gap-1 rounded bg-input/40 p-1"
						>
							<select className="rounded bg-input px-1" value={transition.fromStateId} onChange={(event) => update({ fromStateId: event.currentTarget.value })}>
								{props.graph.states.map((state) => (
									<option key={state.id} value={state.id}>
										{state.name}
									</option>
								))}
							</select>
							<span>→</span>
							<select className="rounded bg-input px-1" value={transition.toStateId} onChange={(event) => update({ toStateId: event.currentTarget.value })}>
								{props.graph.states.map((state) => (
									<option key={state.id} value={state.id}>
										{state.name}
									</option>
								))}
							</select>
							<Input
								defaultValue={transition.eventName}
								onBlur={(event) => event.currentTarget.value !== transition.eventName && update({ eventName: event.currentTarget.value })}
							/>
							<select
								className="rounded bg-input px-1"
								value={transition.conditionVariableId ?? ""}
								onChange={(event) => update({ conditionVariableId: event.currentTarget.value || undefined })}
							>
								<option value="">No condition</option>
								{props.graph.variables
									.filter((variable) => variable.type === "boolean")
									.map((variable) => (
										<option key={variable.id} value={variable.id}>
											{variable.name}
										</option>
									))}
							</select>
							<label className="flex items-center gap-1">
								<Checkbox checked={transition.invertCondition} onCheckedChange={(checked) => update({ invertCondition: checked === true })} />
								Invert
							</label>
							<Input type="number" min={0} max={255} value={transition.priority} onChange={(event) => update({ priority: Number(event.currentTarget.value) })} />
							<Button
								size="sm"
								variant="ghost"
								onClick={() =>
									props.mutate(
										() =>
											void deleteVisualScriptTransition(
												props.scene,
												{ id: props.graph.id, expectedRevision: props.graph.revision, transitionId: transition.id },
												props.options
											)
									)
								}
							>
								×
							</Button>
						</div>
					);
				})}
			</section>
		</>
	);
}
