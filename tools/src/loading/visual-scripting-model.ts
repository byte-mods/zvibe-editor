import { validateVisualScriptExpression } from "./visual-scripting-expression";

export type VisualScriptGraphKind = "flow" | "state";
export type VisualScriptVariableScope = "flow" | "graph" | "object" | "scene" | "application" | "saved";
export type VisualScriptValueType = "any" | "untyped" | "boolean" | "number" | "string" | "vector2" | "vector3" | "node";
export type VisualScriptCollectionKind = "list" | "array";
export type VisualScriptEdgeKind = "control" | "value";

export interface IGraphToolkitDataTypeStyle {
	typeId: string;
	label: string;
	color: string;
	icon: string;
}

export interface IGraphToolkitPortPresentation {
	port: string;
	type: VisualScriptValueType;
	collection?: VisualScriptCollectionKind;
	dataType?: string;
	tooltip?: string;
	multiline?: boolean;
}

export interface IGraphToolkitNodePresentation {
	title?: string;
	category?: string;
	subtitle?: string;
	tooltip?: string;
	icon?: string;
	color?: string;
	portLayout?: "horizontal" | "vertical";
	optionEditors?: Record<string, "text" | "textarea">;
}

export type VisualScriptNodeType =
	| "event-start"
	| "event-update"
	| "event-fixed-update"
	| "event-custom"
	| "branch"
	| "sequence"
	| "trigger-custom-event"
	| "subgraph"
	| "graph-input"
	| "graph-output"
	| "constant"
	| "expression"
	| "get-variable"
	| "set-variable"
	| "add"
	| "subtract"
	| "multiply"
	| "divide"
	| "compare"
	| "and"
	| "or"
	| "not"
	| "vector3"
	| "get-position"
	| "set-position"
	| "translate"
	| "set-enabled"
	| "log"
	| "custom";

export interface IVisualScriptVariableDefinition {
	id: string;
	name: string;
	scope: VisualScriptVariableScope;
	type: VisualScriptValueType;
	defaultValue: unknown;
	collection?: VisualScriptCollectionKind;
	dataType?: string;
}

export interface IVisualScriptNodeDefinition {
	id: string;
	type: VisualScriptNodeType;
	name?: string;
	position: [number, number];
	enabled: boolean;
	nodeId?: string;
	variableId?: string;
	value?: unknown;
	collection?: VisualScriptCollectionKind;
	dataType?: string;
	expression?: string;
	expressionInputs?: string[];
	eventName?: string;
	subgraphId?: string;
	portName?: string;
	operator?: "equal" | "notEqual" | "less" | "lessOrEqual" | "greater" | "greaterOrEqual";
	unitId?: string;
	ports?: IVisualScriptNodePorts;
	portPresentation?: IGraphToolkitPortPresentation[];
	presentation?: IGraphToolkitNodePresentation;
	settings?: Record<string, unknown>;
}

export interface IVisualScriptPortReference {
	nodeId: string;
	port: string;
}

export interface IVisualScriptEdgeDefinition {
	id: string;
	kind: VisualScriptEdgeKind;
	from: IVisualScriptPortReference;
	to: IVisualScriptPortReference;
	order: number;
}

export interface IVisualScriptGroupDefinition {
	id: string;
	name: string;
	color: string;
	nodeIds: string[];
}

export interface IVisualScriptStateDefinition {
	id: string;
	name: string;
	position: [number, number];
	initial: boolean;
	onEnterGraphId?: string;
	onUpdateGraphId?: string;
	onExitGraphId?: string;
}

export interface IVisualScriptTransitionDefinition {
	id: string;
	fromStateId: string;
	toStateId: string;
	eventName: string;
	conditionVariableId?: string;
	invertCondition: boolean;
	priority: number;
}

export interface IVisualScriptGraphDefinition {
	version: 2;
	revision: number;
	id: string;
	name: string;
	kind: VisualScriptGraphKind;
	enabled: boolean;
	autoStart: boolean;
	targetNodeId?: string;
	variables: IVisualScriptVariableDefinition[];
	nodes: IVisualScriptNodeDefinition[];
	edges: IVisualScriptEdgeDefinition[];
	groups: IVisualScriptGroupDefinition[];
	states: IVisualScriptStateDefinition[];
	transitions: IVisualScriptTransitionDefinition[];
	typeStyles?: IGraphToolkitDataTypeStyle[];
	lastExecution?: {
		at: string;
		event: string;
		nodes: string[];
		variables: Record<string, unknown>;
		error?: string;
	};
}

export interface IVisualScriptNodePorts {
	controlInputs: string[];
	controlOutputs: string[];
	valueInputs: string[];
	valueOutputs: string[];
}

export const visualScriptNodeTypes: VisualScriptNodeType[] = [
	"event-start",
	"event-update",
	"event-fixed-update",
	"event-custom",
	"branch",
	"sequence",
	"trigger-custom-event",
	"subgraph",
	"graph-input",
	"graph-output",
	"constant",
	"expression",
	"get-variable",
	"set-variable",
	"add",
	"subtract",
	"multiply",
	"divide",
	"compare",
	"and",
	"or",
	"not",
	"vector3",
	"get-position",
	"set-position",
	"translate",
	"set-enabled",
	"log",
	"custom",
];

let fallbackId = 0;

export function createVisualScriptId(prefix: string): string {
	const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
	return `${prefix}-${randomUUID ? randomUUID() : `${Date.now().toString(36)}-${(++fallbackId).toString(36)}`}`;
}

function legacyId(prefix: string, index: number, seed: string): string {
	let hash = 2166136261;
	for (let offset = 0; offset < seed.length; offset++) {
		hash ^= seed.charCodeAt(offset);
		hash = Math.imul(hash, 16777619);
	}
	return `legacy-${prefix}-${index}-${(hash >>> 0).toString(36)}`;
}

/** Infers a portable built-in type without treating arbitrary arrays as vectors. */
export function inferVisualScriptValueType(value: unknown): VisualScriptValueType {
	if (typeof value === "boolean") {
		return "boolean";
	}
	if (typeof value === "number") {
		return "number";
	}
	if (typeof value === "string") {
		return "string";
	}
	if (Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)) {
		return "vector2";
	}
	if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
		return "vector3";
	}
	return "any";
}

export function getDefaultVisualScriptValue(type: VisualScriptValueType): unknown {
	switch (type) {
		case "boolean":
			return false;
		case "number":
			return 0;
		case "string":
			return "";
		case "vector2":
			return [0, 0];
		case "vector3":
			return [0, 0, 0];
		case "node":
		case "untyped":
		case "any":
			return null;
	}
}

function defaultNodePosition(index: number): [number, number] {
	return [20 + (index % 4) * 180, 20 + Math.floor(index / 4) * 90];
}

function normalizeVariables(value: unknown, graphId: string, deterministic: boolean): IVisualScriptVariableDefinition[] {
	if (Array.isArray(value)) {
		return value.map((variable: any, index) => {
			const type = variable?.type ?? inferVisualScriptValueType(variable?.defaultValue);
			return {
				id: variable?.id ?? (deterministic ? legacyId("variable", index, `${graphId}|${variable?.name ?? ""}|${index}`) : createVisualScriptId("variable")),
				name: variable?.name ?? "",
				scope: variable?.scope ?? "graph",
				type,
				defaultValue: structuredClone(variable?.defaultValue === undefined ? getDefaultVisualScriptValue(type) : variable.defaultValue),
				...(variable?.collection !== undefined ? { collection: variable.collection } : {}),
				...(variable?.dataType !== undefined ? { dataType: variable.dataType } : {}),
			};
		});
	}
	if (!value || typeof value !== "object") {
		return [];
	}
	return Object.entries(value as Record<string, unknown>).map(([name, defaultValue], index) => ({
		id: deterministic ? legacyId("variable", index, `${graphId}|${name}|${index}`) : createVisualScriptId("variable"),
		name,
		scope: "graph",
		type: inferVisualScriptValueType(defaultValue),
		defaultValue: structuredClone(defaultValue),
	}));
}

function variableIdFromLegacy(reference: unknown, variables: IVisualScriptVariableDefinition[]): string | undefined {
	if (typeof reference !== "string") {
		return undefined;
	}
	return variables.find((candidate) => candidate.id === reference || candidate.name === reference)?.id ?? reference;
}

function normalizeNodes(value: unknown, graphId: string, variables: IVisualScriptVariableDefinition[], deterministic: boolean): IVisualScriptNodeDefinition[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((node: any, index) => {
		const id = node?.id ?? (deterministic ? legacyId("node", index, `${graphId}|${node?.type ?? ""}|${index}`) : createVisualScriptId("node"));
		const legacyVariable =
			node?.variableId ?? node?.variable ?? (node?.value && typeof node.value === "object" && !Array.isArray(node.value) ? node.value.variable : undefined);
		const migratedValue =
			node?.value && typeof node.value === "object" && !Array.isArray(node.value) && "variable" in node.value
				? { variableId: variableIdFromLegacy(node.value.variable, variables) }
				: structuredClone(node?.value);
		return {
			id,
			type: node?.type,
			...(node?.name !== undefined ? { name: node.name } : {}),
			position: Array.isArray(node?.position) && node.position.length === 2 ? [node.position[0], node.position[1]] : defaultNodePosition(index),
			enabled: node?.enabled ?? true,
			...(node?.nodeId !== undefined ? { nodeId: node.nodeId } : {}),
			...(legacyVariable !== undefined ? { variableId: variableIdFromLegacy(legacyVariable, variables) } : {}),
			...(node?.value !== undefined ? { value: migratedValue } : {}),
			...(node?.collection !== undefined ? { collection: node.collection } : {}),
			...(node?.dataType !== undefined ? { dataType: node.dataType } : {}),
			...(node?.expression !== undefined ? { expression: node.expression } : {}),
			...(node?.expressionInputs !== undefined ? { expressionInputs: [...node.expressionInputs] } : {}),
			...(node?.eventName !== undefined ? { eventName: node.eventName } : {}),
			...(node?.subgraphId !== undefined ? { subgraphId: node.subgraphId } : {}),
			...(node?.portName !== undefined ? { portName: node.portName } : {}),
			...(node?.operator !== undefined ? { operator: node.operator } : {}),
			...(node?.unitId !== undefined ? { unitId: node.unitId } : {}),
			...(node?.ports !== undefined ? { ports: structuredClone(node.ports) } : {}),
			...(node?.portPresentation !== undefined ? { portPresentation: structuredClone(node.portPresentation) } : {}),
			...(node?.presentation !== undefined ? { presentation: structuredClone(node.presentation) } : {}),
			...(node?.settings !== undefined ? { settings: structuredClone(node.settings) } : {}),
		};
	});
}

function normalizeEdges(value: unknown, graphId: string, deterministic: boolean): IVisualScriptEdgeDefinition[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((edge: any, index) => {
		const from = typeof edge?.from === "string" ? { nodeId: edge.from, port: "out" } : { nodeId: edge?.from?.nodeId ?? "", port: edge?.from?.port ?? "out" };
		const to = typeof edge?.to === "string" ? { nodeId: edge.to, port: "in" } : { nodeId: edge?.to?.nodeId ?? "", port: edge?.to?.port ?? "in" };
		return {
			id: edge?.id ?? (deterministic ? legacyId("edge", index, `${graphId}|${from.nodeId}|${from.port}|${to.nodeId}|${to.port}|${index}`) : createVisualScriptId("edge")),
			kind: edge?.kind ?? "control",
			from,
			to,
			order: Number.isInteger(edge?.order) ? edge.order : index,
		};
	});
}

/** Returns the fixed portable control and value ports exposed by one unit. */
export function getVisualScriptNodePorts(node: Pick<IVisualScriptNodeDefinition, "type" | "ports" | "expressionInputs">): IVisualScriptNodePorts {
	switch (node.type) {
		case "event-start":
		case "event-update":
		case "event-fixed-update":
		case "event-custom":
			return { controlInputs: [], controlOutputs: ["out"], valueInputs: [], valueOutputs: ["payload"] };
		case "branch":
			return { controlInputs: ["in"], controlOutputs: ["true", "false"], valueInputs: ["condition"], valueOutputs: [] };
		case "sequence":
			return { controlInputs: ["in"], controlOutputs: ["then0", "then1", "then2", "then3"], valueInputs: [], valueOutputs: [] };
		case "trigger-custom-event":
			return { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: ["payload"], valueOutputs: [] };
		case "subgraph":
			return { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: ["input"], valueOutputs: ["value"] };
		case "graph-input":
			return { controlInputs: [], controlOutputs: [], valueInputs: [], valueOutputs: ["value"] };
		case "graph-output":
			return { controlInputs: ["in"], controlOutputs: [], valueInputs: ["value"], valueOutputs: [] };
		case "constant":
		case "get-variable":
		case "get-position":
			return { controlInputs: [], controlOutputs: [], valueInputs: [], valueOutputs: ["value"] };
		case "expression":
			return { controlInputs: [], controlOutputs: [], valueInputs: [...(node.expressionInputs ?? node.ports?.valueInputs ?? [])], valueOutputs: ["value"] };
		case "add":
		case "subtract":
		case "multiply":
		case "divide":
		case "compare":
		case "and":
		case "or":
			return { controlInputs: [], controlOutputs: [], valueInputs: ["a", "b"], valueOutputs: ["value"] };
		case "not":
			return { controlInputs: [], controlOutputs: [], valueInputs: ["value"], valueOutputs: ["value"] };
		case "vector3":
			return { controlInputs: [], controlOutputs: [], valueInputs: ["x", "y", "z"], valueOutputs: ["value"] };
		case "set-variable":
		case "set-position":
		case "translate":
		case "set-enabled":
		case "log":
			return { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: ["value"], valueOutputs: [] };
		case "custom":
			return structuredClone(node.ports ?? { controlInputs: ["in"], controlOutputs: ["out"], valueInputs: [], valueOutputs: [] });
	}
}

const defaultTypeStyles: Record<string, IGraphToolkitDataTypeStyle> = {
	any: { typeId: "any", label: "Any", color: "#94a3b8", icon: "circle-help" },
	untyped: { typeId: "untyped", label: "Untyped", color: "#a1a1aa", icon: "circle-dashed" },
	boolean: { typeId: "boolean", label: "Boolean", color: "#ef4444", icon: "toggle-left" },
	number: { typeId: "number", label: "Number", color: "#22c55e", icon: "hash" },
	string: { typeId: "string", label: "String", color: "#f59e0b", icon: "text" },
	vector2: { typeId: "vector2", label: "Vector 2", color: "#06b6d4", icon: "move-diagonal" },
	vector3: { typeId: "vector3", label: "Vector 3", color: "#3b82f6", icon: "axis-3d" },
	node: { typeId: "node", label: "Scene Node", color: "#a855f7", icon: "box" },
};

/** Resolves a project-authored type style before falling back to the portable built-in palette. */
export function getGraphToolkitDataTypeStyle(graph: Pick<IVisualScriptGraphDefinition, "typeStyles">, typeId: string): IGraphToolkitDataTypeStyle {
	return structuredClone(
		(graph.typeStyles ?? []).find((style) => style.typeId === typeId) ?? defaultTypeStyles[typeId] ?? { typeId, label: typeId, color: "#64748b", icon: "circle" }
	);
}

/** Resolves node display metadata without requiring every graph to persist presentation defaults. */
export function getGraphToolkitNodePresentation(node: IVisualScriptNodeDefinition): Required<Omit<IGraphToolkitNodePresentation, "optionEditors">> & {
	optionEditors: Record<string, "text" | "textarea">;
} {
	return {
		title: node.presentation?.title ?? node.name ?? node.type,
		category: node.presentation?.category ?? (node.type === "expression" ? "Math" : node.type.startsWith("event-") ? "Events" : "Flow"),
		subtitle: node.presentation?.subtitle ?? (node.type === "expression" ? "Expression" : ""),
		tooltip: node.presentation?.tooltip ?? "",
		icon: node.presentation?.icon ?? (node.type === "expression" ? "sigma" : "box"),
		color: node.presentation?.color ?? "#64748b",
		portLayout: node.presentation?.portLayout ?? "horizontal",
		optionEditors: structuredClone(node.presentation?.optionEditors ?? (node.type === "expression" ? { expression: "textarea" } : {})),
	};
}

/** Returns the authored type/editor hints for one port, defaulting to an untyped scalar. */
export function getGraphToolkitPortPresentation(node: IVisualScriptNodeDefinition, port: string): IGraphToolkitPortPresentation {
	return structuredClone(node.portPresentation?.find((entry) => entry.port === port) ?? { port, type: "untyped" });
}

/** Reports whether a node has any value or control connection. */
export function isVisualScriptNodeConnected(graph: IVisualScriptGraphDefinition, nodeId: string): boolean {
	return graph.edges.some((edge) => edge.from.nodeId === nodeId || edge.to.nodeId === nodeId);
}

/** Returns variable nodes in stable graph order, matching Graph Toolkit's ordered variable query. */
export function getVisualScriptVariableNodes(graph: IVisualScriptGraphDefinition, variableId: string): IVisualScriptNodeDefinition[] {
	return graph.nodes.filter((node) => node.variableId === variableId);
}

/** Changes one variable value when it exists and the value satisfies its scalar/collection contract. */
export function trySetVisualScriptVariableValue(graph: IVisualScriptGraphDefinition, variableId: string, value: unknown): boolean {
	const variable = graph.variables.find((candidate) => candidate.id === variableId);
	if (!variable) {
		return false;
	}
	validateVisualScriptValue(value, variable.type, `Visual script variable "${variable.name}" default`, variable.collection);
	variable.defaultValue = structuredClone(value);
	return true;
}

/** Removes only unreferenced variables so graph integrity cannot be weakened by the convenience API. */
export function removeVisualScriptVariable(graph: IVisualScriptGraphDefinition, variableId: string): boolean {
	const index = graph.variables.findIndex((candidate) => candidate.id === variableId);
	if (index < 0 || getVisualScriptVariableNodes(graph, variableId).length || graph.transitions.some((transition) => transition.conditionVariableId === variableId)) {
		return false;
	}
	graph.variables.splice(index, 1);
	return true;
}

/** Changes a Constant node's scalar or collection value while preserving its declared authoring contract. */
export function trySetVisualScriptConstantValue(graph: IVisualScriptGraphDefinition, nodeId: string, value: unknown): boolean {
	const node = graph.nodes.find((candidate) => candidate.id === nodeId && candidate.type === "constant");
	if (!node) {
		return false;
	}
	validateVisualScriptValue(value, "untyped", `Constant node "${node.id}" value`, node.collection);
	node.value = structuredClone(value);
	return true;
}

/** Persists an unconnected value-input fallback in the node's bounded settings map. */
export function trySetVisualScriptPortValue(graph: IVisualScriptGraphDefinition, nodeId: string, port: string, value: unknown): boolean {
	const node = graph.nodes.find((candidate) => candidate.id === nodeId);
	if (
		!node ||
		!getVisualScriptNodePorts(node).valueInputs.includes(port) ||
		graph.edges.some((edge) => edge.kind === "value" && edge.to.nodeId === nodeId && edge.to.port === port)
	) {
		return false;
	}
	const presentation = getGraphToolkitPortPresentation(node, port);
	validateVisualScriptValue(value, presentation.type, `Visual script node "${node.id}" port "${port}"`, presentation.collection);
	const inputValues = { ...((node.settings?.inputValues as Record<string, unknown> | undefined) ?? {}), [port]: structuredClone(value) };
	node.settings = { ...(node.settings ?? {}), inputValues };
	return true;
}

/** Migrates one legacy graph to the canonical version-2 representation. */
export function normalizeVisualScriptGraph(value: unknown, legacyIndex?: number): IVisualScriptGraphDefinition {
	const graph = (value ?? {}) as any;
	const deterministic = legacyIndex !== undefined;
	const id = graph.id ?? (deterministic ? legacyId("graph", legacyIndex!, `${graph.name ?? ""}|${legacyIndex}`) : createVisualScriptId("graph"));
	const variables = normalizeVariables(graph.variables, id, deterministic);
	const nodes = normalizeNodes(graph.nodes, id, variables, deterministic);
	return {
		version: 2,
		revision: Number.isInteger(graph.revision) && graph.revision >= 1 ? graph.revision : 1,
		id,
		name: typeof graph.name === "string" && graph.name.trim() ? graph.name : deterministic ? (graph.id ?? `Visual Script ${legacyIndex! + 1}`) : "",
		kind: graph.kind ?? "flow",
		enabled: graph.enabled ?? true,
		autoStart: graph.autoStart ?? graph.autoRun ?? false,
		...(graph.targetNodeId !== undefined ? { targetNodeId: graph.targetNodeId } : {}),
		variables,
		nodes,
		edges: normalizeEdges(graph.edges, id, deterministic),
		groups: Array.isArray(graph.groups)
			? graph.groups.map((group: any, index: number) => ({
					id: group?.id ?? (deterministic ? legacyId("group", index, `${id}|${group?.name ?? ""}|${index}`) : createVisualScriptId("group")),
					name: group?.name ?? "",
					color: group?.color ?? "#64748b",
					nodeIds: Array.isArray(group?.nodeIds) ? [...group.nodeIds] : [],
				}))
			: [],
		states: Array.isArray(graph.states)
			? graph.states.map((state: any, index: number) => ({
					id: state?.id ?? (deterministic ? legacyId("state", index, `${id}|${state?.name ?? ""}|${index}`) : createVisualScriptId("state")),
					name: state?.name ?? "",
					position: Array.isArray(state?.position) && state.position.length === 2 ? [state.position[0], state.position[1]] : defaultNodePosition(index),
					initial: state?.initial ?? index === 0,
					...(state?.onEnterGraphId ? { onEnterGraphId: state.onEnterGraphId } : {}),
					...(state?.onUpdateGraphId ? { onUpdateGraphId: state.onUpdateGraphId } : {}),
					...(state?.onExitGraphId ? { onExitGraphId: state.onExitGraphId } : {}),
				}))
			: [],
		transitions: Array.isArray(graph.transitions)
			? graph.transitions.map((transition: any, index: number) => ({
					id:
						transition?.id ??
						(deterministic
							? legacyId("transition", index, `${id}|${transition?.fromStateId ?? ""}|${transition?.toStateId ?? ""}|${index}`)
							: createVisualScriptId("transition")),
					fromStateId: transition?.fromStateId ?? "",
					toStateId: transition?.toStateId ?? "",
					eventName: transition?.eventName ?? "update",
					...(transition?.conditionVariableId ? { conditionVariableId: variableIdFromLegacy(transition.conditionVariableId, variables) } : {}),
					invertCondition: transition?.invertCondition ?? false,
					priority: Number.isInteger(transition?.priority) ? transition.priority : index,
				}))
			: [],
		typeStyles: Array.isArray(graph.typeStyles)
			? graph.typeStyles.map((style: any) => ({ typeId: style?.typeId ?? "", label: style?.label ?? "", color: style?.color ?? "#64748b", icon: style?.icon ?? "circle" }))
			: [],
		...(graph.lastExecution ? { lastExecution: structuredClone(graph.lastExecution) } : {}),
	};
}

export function normalizeVisualScriptGraphs(value: unknown): IVisualScriptGraphDefinition[] {
	return Array.isArray(value) ? value.map((graph, index) => normalizeVisualScriptGraph(graph, index)) : [];
}

function assertName(value: unknown, label: string, max = 128): asserts value is string {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		throw new Error(`${label} must contain from 1 through ${max} characters.`);
	}
}

function assertUnique(values: string[], label: string): void {
	const normalized = values.map((value) => value.trim().toLowerCase());
	if (new Set(normalized).size !== normalized.length) {
		throw new Error(`${label} must be unique (case-insensitive).`);
	}
}

function validatePosition(value: unknown, label: string): void {
	if (!Array.isArray(value) || value.length !== 2 || value.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 10000)) {
		throw new Error(`${label} must be a finite [x,y] pair inside 0 through 10,000.`);
	}
}

function validateJson(value: unknown, label: string): void {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw new Error(`${label} must be JSON serializable.`);
	}
	if (encoded === undefined || encoded.length > 65_536) {
		throw new Error(`${label} exceeds the 64 KiB JSON limit.`);
	}
}

function validatePorts(value: unknown, label: string): void {
	if (!value || typeof value !== "object") {
		throw new Error(`${label} must define controlInputs, controlOutputs, valueInputs, and valueOutputs.`);
	}
	const all: string[] = [];
	for (const key of ["controlInputs", "controlOutputs", "valueInputs", "valueOutputs"] as const) {
		const ports = (value as any)[key];
		if (!Array.isArray(ports) || ports.length > 16) {
			throw new Error(`${label}.${key} must be an array capped at 16 ports.`);
		}
		for (const port of ports) {
			assertName(port, `${label}.${key} port`, 64);
			if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(port)) {
				throw new Error(`${label}.${key} port "${port}" has an invalid name.`);
			}
			all.push(`${key}:${port}`);
		}
		assertUnique(ports, `${label}.${key}`);
	}
	if (all.length > 32) {
		throw new Error(`${label} exposes more than 32 ports.`);
	}
}

function validateScalarVisualScriptValue(value: unknown, type: VisualScriptValueType, label: string): void {
	validateJson(value, label);
	const valid =
		type === "any" ||
		type === "untyped" ||
		(type === "boolean" && typeof value === "boolean") ||
		(type === "number" && typeof value === "number" && Number.isFinite(value)) ||
		(type === "string" && typeof value === "string") ||
		(type === "vector2" && Array.isArray(value) && value.length === 2 && value.every((component) => typeof component === "number" && Number.isFinite(component))) ||
		(type === "vector3" && Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component))) ||
		(type === "node" && (value === null || typeof value === "string"));
	if (!valid) {
		throw new Error(`${label} must match declared type "${type}".`);
	}
}

/** Validates scalar or editable list/array values, with Unity-compatible 50-element authoring bounds. */
export function validateVisualScriptValue(value: unknown, type: VisualScriptValueType, label: string, collection?: VisualScriptCollectionKind): void {
	if (!collection) {
		validateScalarVisualScriptValue(value, type, label);
		return;
	}
	validateJson(value, label);
	if (!Array.isArray(value) || value.length > 50) {
		throw new Error(`${label} must be a ${collection} capped at 50 editable elements.`);
	}
	value.forEach((entry, index) => validateScalarVisualScriptValue(entry, type, `${label}[${index}]`));
}

/** Rejects ambiguous, dangling, recursive, unbounded, or unsafe graph authoring. */
export function validateVisualScriptGraphs(graphs: IVisualScriptGraphDefinition[]): void {
	if (graphs.length > 64) {
		throw new Error("A scene supports at most 64 visual script graphs.");
	}
	assertUnique(
		graphs.map((graph) => graph.id),
		"Visual script graph ids"
	);
	assertUnique(
		graphs.map((graph) => graph.name),
		"Visual script graph names"
	);
	const graphById = new Map(graphs.map((graph) => [graph.id, graph]));
	for (const graph of graphs) {
		assertName(graph.id, "Visual script graph id");
		assertName(graph.name, "Visual script graph name");
		if (graph.version !== 2 || !Number.isInteger(graph.revision) || graph.revision < 1) {
			throw new Error(`Visual script graph "${graph.name}" requires version 2 and a positive revision.`);
		}
		if (!["flow", "state"].includes(graph.kind) || typeof graph.enabled !== "boolean" || typeof graph.autoStart !== "boolean") {
			throw new Error(`Visual script graph "${graph.name}" has invalid kind or enable flags.`);
		}
		if (
			graph.nodes.length > 256 ||
			graph.edges.length > 512 ||
			graph.variables.length > 128 ||
			graph.groups.length > 64 ||
			graph.states.length > 64 ||
			graph.transitions.length > 256
		) {
			throw new Error(`Visual script graph "${graph.name}" exceeds a collection limit.`);
		}
		assertUnique(
			graph.variables.map((value) => value.id),
			`Variable ids in graph "${graph.name}"`
		);
		assertUnique(
			graph.variables.map((value) => value.name),
			`Variable names in graph "${graph.name}"`
		);
		const variableIds = new Set(graph.variables.map((value) => value.id));
		for (const variable of graph.variables) {
			assertName(variable.id, "Visual script variable id");
			assertName(variable.name, "Visual script variable name");
			if (
				!["flow", "graph", "object", "scene", "application", "saved"].includes(variable.scope) ||
				!["any", "untyped", "boolean", "number", "string", "vector2", "vector3", "node"].includes(variable.type)
			) {
				throw new Error(`Visual script variable "${variable.name}" has invalid scope or type.`);
			}
			if (variable.collection !== undefined && !["list", "array"].includes(variable.collection)) {
				throw new Error(`Visual script variable "${variable.name}" has an invalid collection kind.`);
			}
			if (variable.dataType !== undefined) {
				assertName(variable.dataType, `Visual script variable "${variable.name}" dataType`, 64);
			}
			validateVisualScriptValue(variable.defaultValue, variable.type, `Visual script variable "${variable.name}" default`, variable.collection);
		}
		assertUnique(
			graph.nodes.map((node) => node.id),
			`Node ids in graph "${graph.name}"`
		);
		const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
		for (const node of graph.nodes) {
			assertName(node.id, "Visual script node id");
			if (!visualScriptNodeTypes.includes(node.type) || typeof node.enabled !== "boolean") {
				throw new Error(`Visual script node "${node.id}" has invalid type or enabled state.`);
			}
			validatePosition(node.position, `Visual script node "${node.id}" position`);
			if (["set-variable", "get-variable"].includes(node.type) && (!node.variableId || !variableIds.has(node.variableId))) {
				throw new Error(`${node.type} node "${node.id}" requires a declared variableId.`);
			}
			if (["set-position", "translate", "set-enabled", "get-position"].includes(node.type) && !node.nodeId) {
				throw new Error(`${node.type} node "${node.id}" requires nodeId.`);
			}
			if (["event-custom", "trigger-custom-event"].includes(node.type)) {
				assertName(node.eventName, `${node.type} eventName`);
			}
			if (node.type === "subgraph" && (!node.subgraphId || node.subgraphId === graph.id || graphById.get(node.subgraphId)?.kind !== "flow")) {
				throw new Error(`Subgraph node "${node.id}" must reference another flow graph.`);
			}
			if (["graph-input", "graph-output"].includes(node.type)) {
				assertName(node.portName, `${node.type} portName`);
			}
			if (node.type === "compare" && node.operator !== undefined && !["equal", "notEqual", "less", "lessOrEqual", "greater", "greaterOrEqual"].includes(node.operator)) {
				throw new Error(`Compare node "${node.id}" has an invalid operator.`);
			}
			if (node.type === "expression") {
				assertName(node.name ?? "Expression", `Expression node "${node.id}" title`);
				const inputNames = node.expressionInputs ?? [];
				if (inputNames.length > 16) {
					throw new Error(`Expression node "${node.id}" is capped at 16 inputs.`);
				}
				inputNames.forEach((name) => {
					assertName(name, `Expression node "${node.id}" input`, 64);
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ["true", "false", "null"].includes(name)) {
						throw new Error(`Expression node "${node.id}" input "${name}" must be a reachable non-reserved identifier.`);
					}
				});
				assertUnique(inputNames, `Expression node "${node.id}" inputs`);
				validateVisualScriptExpression(node.expression ?? "", inputNames);
			}
			if (node.collection !== undefined) {
				if (node.type !== "constant" || !["list", "array"].includes(node.collection)) {
					throw new Error(`Only Constant nodes support list/array collections.`);
				}
				validateVisualScriptValue(node.value, "untyped", `Constant node "${node.id}" value`, node.collection);
			}
			if (node.dataType !== undefined) {
				assertName(node.dataType, `Visual script node "${node.id}" dataType`, 64);
			}
			if (node.portPresentation !== undefined) {
				if (!Array.isArray(node.portPresentation) || node.portPresentation.length > 32) {
					throw new Error(`Visual script node "${node.id}" port presentation is capped at 32 ports.`);
				}
				const portNames = Object.values(getVisualScriptNodePorts(node)).flat();
				for (const detail of node.portPresentation) {
					if (!portNames.includes(detail.port) || !["any", "untyped", "boolean", "number", "string", "vector2", "vector3", "node"].includes(detail.type)) {
						throw new Error(`Visual script node "${node.id}" has presentation for a missing or invalid port.`);
					}
					if (detail.collection !== undefined && !["list", "array"].includes(detail.collection)) {
						throw new Error(`Visual script node "${node.id}" has an invalid port collection kind.`);
					}
					if (detail.dataType !== undefined) {
						assertName(detail.dataType, `Visual script node "${node.id}" port "${detail.port}" dataType`, 64);
					}
					if (detail.tooltip !== undefined && (typeof detail.tooltip !== "string" || detail.tooltip.length > 512)) {
						throw new Error(`Visual script node "${node.id}" has an invalid port tooltip.`);
					}
					if (detail.multiline !== undefined && typeof detail.multiline !== "boolean") {
						throw new Error(`Visual script node "${node.id}" has an invalid multiline port setting.`);
					}
				}
				assertUnique(
					node.portPresentation.map((detail) => detail.port),
					`Visual script node "${node.id}" presented ports`
				);
			}
			if (node.presentation !== undefined) {
				validateJson(node.presentation, `Visual script node "${node.id}" presentation`);
				const fields = new Set(["title", "category", "subtitle", "tooltip", "icon", "color", "portLayout", "optionEditors"]);
				for (const [field, value] of Object.entries(node.presentation)) {
					if (!fields.has(field)) {
						throw new Error(`Visual script node "${node.id}" presentation field "${field}" is not supported.`);
					}
					if (field !== "optionEditors" && field !== "color" && field !== "portLayout" && (typeof value !== "string" || value.length > 512)) {
						throw new Error(`Visual script node "${node.id}" presentation field "${field}" must be a string capped at 512 characters.`);
					}
				}
				if (
					node.presentation.optionEditors !== undefined &&
					(!node.presentation.optionEditors || typeof node.presentation.optionEditors !== "object" || Array.isArray(node.presentation.optionEditors))
				) {
					throw new Error(`Visual script node "${node.id}" option editors must be an object.`);
				}
				for (const [field, value] of Object.entries(node.presentation.optionEditors ?? {})) {
					assertName(field, `Visual script node "${node.id}" option editor field`, 64);
					if (!["text", "textarea"].includes(value)) {
						throw new Error(`Visual script node "${node.id}" option editor must be text or textarea.`);
					}
				}
				if (node.presentation.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(node.presentation.color)) {
					throw new Error(`Visual script node "${node.id}" presentation color must be #RRGGBB.`);
				}
				if (node.presentation.portLayout !== undefined && !["horizontal", "vertical"].includes(node.presentation.portLayout)) {
					throw new Error(`Visual script node "${node.id}" has an invalid port layout.`);
				}
			}
			if (node.type === "custom") {
				assertName(node.unitId, `Custom node "${node.id}" unitId`);
				validatePorts(node.ports, `Custom node "${node.id}" ports`);
				validateJson(node.settings ?? {}, `Custom node "${node.id}" settings`);
			}
			if (node.settings !== undefined) {
				validateJson(node.settings, `Visual script node "${node.id}" settings`);
			}
			if (node.value !== undefined) {
				validateJson(node.value, `Visual script node "${node.id}" value`);
			}
		}
		assertUnique(
			graph.edges.map((edge) => edge.id),
			`Edge ids in graph "${graph.name}"`
		);
		const valueInputs = new Set<string>();
		for (const edge of graph.edges) {
			assertName(edge.id, "Visual script edge id");
			if (!["control", "value"].includes(edge.kind) || !Number.isInteger(edge.order) || edge.order < 0 || edge.order > 511) {
				throw new Error(`Visual script edge "${edge.id}" has invalid kind or order.`);
			}
			const from = nodeById.get(edge.from.nodeId);
			const to = nodeById.get(edge.to.nodeId);
			if (!from || !to) {
				throw new Error(`Visual script edge "${edge.id}" connects a missing node.`);
			}
			const fromPorts = getVisualScriptNodePorts(from);
			const toPorts = getVisualScriptNodePorts(to);
			if (edge.kind === "control" && (!fromPorts.controlOutputs.includes(edge.from.port) || !toPorts.controlInputs.includes(edge.to.port))) {
				throw new Error(`Visual script control edge "${edge.id}" connects incompatible ports.`);
			}
			if (edge.kind === "value" && (!fromPorts.valueOutputs.includes(edge.from.port) || !toPorts.valueInputs.includes(edge.to.port))) {
				throw new Error(`Visual script value edge "${edge.id}" connects incompatible ports.`);
			}
			const inputKey = `${edge.to.nodeId}:${edge.to.port}`;
			if (edge.kind === "value" && valueInputs.has(inputKey)) {
				throw new Error(`Visual script value input "${inputKey}" has more than one source.`);
			}
			if (edge.kind === "value") {
				valueInputs.add(inputKey);
			}
		}
		for (const group of graph.groups) {
			assertName(group.id, "Visual script group id");
			assertName(group.name, "Visual script group name");
			if (
				!/^#[0-9a-fA-F]{6}$/.test(group.color) ||
				group.nodeIds.length > 256 ||
				new Set(group.nodeIds).size !== group.nodeIds.length ||
				group.nodeIds.some((id) => !nodeById.has(id))
			) {
				throw new Error(`Visual script group "${group.name}" has invalid color or node membership.`);
			}
		}
		if (graph.kind === "flow" && (graph.states.length || graph.transitions.length)) {
			throw new Error(`Flow graph "${graph.name}" cannot contain states or transitions.`);
		}
		const typeStyles = graph.typeStyles ?? [];
		if (typeStyles.length > 32) {
			throw new Error(`Visual script graph "${graph.name}" supports at most 32 custom type styles.`);
		}
		assertUnique(
			typeStyles.map((style) => style.typeId),
			`Type style ids in graph "${graph.name}"`
		);
		for (const style of typeStyles) {
			assertName(style.typeId, `Type style id in graph "${graph.name}"`, 64);
			assertName(style.label, `Type style label in graph "${graph.name}"`, 64);
			assertName(style.icon, `Type style icon in graph "${graph.name}"`, 64);
			if (!/^#[0-9a-fA-F]{6}$/.test(style.color)) {
				throw new Error(`Type style "${style.typeId}" color must be #RRGGBB.`);
			}
		}
		if (graph.kind === "state" && (graph.nodes.length || graph.edges.length || graph.groups.length)) {
			throw new Error(`State graph "${graph.name}" cannot contain Flow nodes, edges, or groups.`);
		}
		if (graph.kind === "state") {
			if (!graph.states.length || graph.states.filter((state) => state.initial).length !== 1) {
				throw new Error(`State graph "${graph.name}" requires exactly one initial state.`);
			}
			assertUnique(
				graph.states.map((state) => state.id),
				`State ids in graph "${graph.name}"`
			);
			assertUnique(
				graph.states.map((state) => state.name),
				`State names in graph "${graph.name}"`
			);
			const stateIds = new Set(graph.states.map((state) => state.id));
			for (const state of graph.states) {
				assertName(state.id, "Visual script state id");
				assertName(state.name, "Visual script state name");
				validatePosition(state.position, `Visual script state "${state.name}" position`);
				for (const handler of [state.onEnterGraphId, state.onUpdateGraphId, state.onExitGraphId]) {
					if (handler && graphById.get(handler)?.kind !== "flow") {
						throw new Error(`State "${state.name}" references a missing non-flow handler graph.`);
					}
				}
			}
			assertUnique(
				graph.transitions.map((transition) => transition.id),
				`Transition ids in graph "${graph.name}"`
			);
			for (const transition of graph.transitions) {
				assertName(transition.id, "Visual script transition id");
				assertName(transition.eventName, "Visual script transition event");
				if (
					!stateIds.has(transition.fromStateId) ||
					!stateIds.has(transition.toStateId) ||
					!Number.isInteger(transition.priority) ||
					transition.priority < 0 ||
					transition.priority > 255 ||
					typeof transition.invertCondition !== "boolean"
				) {
					throw new Error(`Visual script transition "${transition.id}" is invalid.`);
				}
				if (transition.conditionVariableId && !variableIds.has(transition.conditionVariableId)) {
					throw new Error(`Visual script transition "${transition.id}" references a missing condition variable.`);
				}
				const condition = graph.variables.find((variable) => variable.id === transition.conditionVariableId);
				if (condition && (condition.type !== "boolean" || condition.scope === "flow")) {
					throw new Error(`Visual script transition "${transition.id}" requires a non-Flow boolean condition variable.`);
				}
			}
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) {
			throw new Error("Visual script subgraph references must be acyclic.");
		}
		if (visited.has(id)) {
			return;
		}
		visiting.add(id);
		for (const node of graphById.get(id)?.nodes ?? []) {
			if (node.type === "subgraph" && node.subgraphId) {
				visit(node.subgraphId);
			}
		}
		visiting.delete(id);
		visited.add(id);
	};
	for (const graph of graphs) {
		visit(graph.id);
	}
	validateJson(graphs, "Visual script graph collection");
}
