export type BehaviorNodeStatus = "uninitialized" | "running" | "waiting" | "succeeded" | "failed";
export type BehaviorBlackboardScope = "graph" | "scene";
export type BehaviorBlackboardValueType = "boolean" | "number" | "string" | "vector3" | "node";
export type BehaviorComparisonOperator = "equal" | "notEqual" | "less" | "lessOrEqual" | "greater" | "greaterOrEqual";

export type BehaviorNodeType =
	| "sequence"
	| "selector"
	| "random"
	| "parallel-all"
	| "parallel-any"
	| "utility-selector"
	| "inverter"
	| "succeeder"
	| "repeat"
	| "condition-node-enabled"
	| "condition-variable"
	| "condition-distance"
	| "condition-nav-arrived"
	| "action-set-enabled"
	| "action-set-position"
	| "action-set-variable"
	| "action-wait"
	| "action-log"
	| "action-send-event"
	| "action-nav-set-destination"
	| "action-nav-start"
	| "action-nav-stop"
	| "action-nav-move-to"
	| "wait-event"
	| "subgraph"
	| "custom";

export interface IBehaviorBlackboardVariable {
	id: string;
	name: string;
	type: BehaviorBlackboardValueType;
	scope: BehaviorBlackboardScope;
	exposed: boolean;
	defaultValue: unknown;
}

export interface IBehaviorUtilityDefinition {
	variableId?: string;
	constant?: number;
	weight: number;
	invert: boolean;
}

export interface IBehaviorNodeDefinition {
	id: string;
	type: BehaviorNodeType;
	name?: string;
	position: [number, number];
	enabled: boolean;
	children: IBehaviorNodeDefinition[];
	nodeId?: string;
	navAgentId?: string;
	variableId?: string;
	value?: unknown;
	eventName?: string;
	duration?: number;
	repeatCount?: number;
	subgraphId?: string;
	operator?: BehaviorComparisonOperator;
	utility?: IBehaviorUtilityDefinition;
	unitId?: string;
	settings?: Record<string, unknown>;
}

export interface IBehaviorGraphDefinition {
	version: 2;
	revision: number;
	id: string;
	name: string;
	enabled: boolean;
	autoStart: boolean;
	startEvent?: string;
	agentNodeId?: string;
	blackboard: IBehaviorBlackboardVariable[];
	root: IBehaviorNodeDefinition;
}

export const behaviorNodeTypes: BehaviorNodeType[] = [
	"sequence",
	"selector",
	"random",
	"parallel-all",
	"parallel-any",
	"utility-selector",
	"inverter",
	"succeeder",
	"repeat",
	"condition-node-enabled",
	"condition-variable",
	"condition-distance",
	"condition-nav-arrived",
	"action-set-enabled",
	"action-set-position",
	"action-set-variable",
	"action-wait",
	"action-log",
	"action-send-event",
	"action-nav-set-destination",
	"action-nav-start",
	"action-nav-stop",
	"action-nav-move-to",
	"wait-event",
	"subgraph",
	"custom",
];

const compositeTypes = new Set<BehaviorNodeType>(["sequence", "selector", "random", "parallel-all", "parallel-any", "utility-selector"]);
const modifierTypes = new Set<BehaviorNodeType>(["inverter", "succeeder", "repeat"]);
let fallbackId = 0;

export function createBehaviorGraphId(prefix: string): string {
	const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
	return `${prefix}-${randomUUID ? randomUUID() : `${Date.now().toString(36)}-${(++fallbackId).toString(36)}`}`;
}

function legacyId(prefix: string, seed: string): string {
	let hash = 2166136261;
	for (let index = 0; index < seed.length; index++) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `legacy-${prefix}-${(hash >>> 0).toString(36)}`;
}

export function getDefaultBehaviorBlackboardValue(type: BehaviorBlackboardValueType): unknown {
	if (type === "boolean") {
		return false;
	}
	if (type === "number") {
		return 0;
	}
	if (type === "string") {
		return "";
	}
	if (type === "vector3") {
		return [0, 0, 0];
	}
	return null;
}

function inferValueType(value: unknown): BehaviorBlackboardValueType {
	if (typeof value === "boolean") {
		return "boolean";
	}
	if (typeof value === "number") {
		return "number";
	}
	if (typeof value === "string") {
		return "string";
	}
	if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
		return "vector3";
	}
	return "node";
}

export function validateBehaviorBlackboardValue(type: BehaviorBlackboardValueType, value: unknown, label: string): void {
	const valid =
		(type === "boolean" && typeof value === "boolean") ||
		(type === "number" && typeof value === "number" && Number.isFinite(value)) ||
		(type === "string" && typeof value === "string" && value.length <= 4096) ||
		(type === "vector3" && Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component))) ||
		(type === "node" && (value === null || (typeof value === "string" && value.length <= 256)));
	if (!valid) {
		throw new Error(`${label} does not match Blackboard type "${type}".`);
	}
}

function normalizeVariable(value: any, graphId: string, index: number, deterministic: boolean): IBehaviorBlackboardVariable {
	const type = (value?.type ?? inferValueType(value?.defaultValue)) as BehaviorBlackboardValueType;
	return {
		id: value?.id ?? (deterministic ? legacyId("blackboard", `${graphId}|${value?.name ?? ""}|${index}`) : createBehaviorGraphId("blackboard")),
		name: value?.name ?? "",
		type,
		scope: value?.scope ?? "graph",
		exposed: value?.exposed ?? false,
		defaultValue: structuredClone(value?.defaultValue === undefined ? getDefaultBehaviorBlackboardValue(type) : value.defaultValue),
	};
}

function normalizeNode(value: any, graphId: string, path: number[], deterministic: boolean): IBehaviorNodeDefinition {
	const type = (behaviorNodeTypes.includes(value?.type) ? value.type : "sequence") as BehaviorNodeType;
	const seed = `${graphId}|${path.join(".")}|${type}`;
	return {
		id: value?.id ?? (deterministic ? legacyId("node", seed) : createBehaviorGraphId("node")),
		type,
		name: value?.name,
		position: Array.isArray(value?.position) && value.position.length === 2 ? [value.position[0], value.position[1]] : [40 + path.length * 220, 40 + (path.at(-1) ?? 0) * 110],
		enabled: value?.enabled ?? true,
		children: Array.isArray(value?.children) ? value.children.map((child: unknown, index: number) => normalizeNode(child, graphId, [...path, index], deterministic)) : [],
		nodeId: value?.nodeId,
		navAgentId: value?.navAgentId,
		variableId: value?.variableId,
		value: value?.value === undefined ? undefined : structuredClone(value.value),
		eventName: value?.eventName,
		duration: value?.duration,
		repeatCount: value?.repeatCount,
		subgraphId: value?.subgraphId,
		operator: value?.operator,
		utility: value?.utility
			? { variableId: value.utility.variableId, constant: value.utility.constant, weight: value.utility.weight ?? 1, invert: value.utility.invert ?? false }
			: undefined,
		unitId: value?.unitId,
		settings: value?.settings === undefined ? undefined : structuredClone(value.settings),
	};
}

export function normalizeBehaviorGraph(value: any, deterministic = false): IBehaviorGraphDefinition {
	const id = value?.id ?? (deterministic ? legacyId("graph", value?.name ?? "graph") : createBehaviorGraphId("graph"));
	const rawBlackboard = Array.isArray(value?.blackboard) ? value.blackboard : [];
	return {
		version: 2,
		revision: Number.isInteger(value?.revision) && value.revision > 0 ? value.revision : 1,
		id,
		name: value?.name ?? "Behavior Graph",
		enabled: value?.enabled ?? true,
		autoStart: value?.autoStart ?? value?.autoRun ?? false,
		startEvent: value?.startEvent,
		agentNodeId: value?.agentNodeId,
		blackboard: rawBlackboard.map((variable: unknown, index: number) => normalizeVariable(variable, id, index, deterministic || value?.version !== 2)),
		root: normalizeNode(value?.root ?? { type: "sequence", children: [] }, id, [0], deterministic || value?.version !== 2),
	};
}

export function normalizeBehaviorGraphs(value: unknown): IBehaviorGraphDefinition[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((graph) => normalizeBehaviorGraph(graph, (graph as any)?.version !== 2));
}

export function visitBehaviorNodes(root: IBehaviorNodeDefinition, callback: (node: IBehaviorNodeDefinition, parent: IBehaviorNodeDefinition | null) => void): void {
	const visit = (node: IBehaviorNodeDefinition, parent: IBehaviorNodeDefinition | null, depth: number): void => {
		if (depth > 64) {
			throw new Error("Behavior graph nesting exceeds 64 levels.");
		}
		callback(node, parent);
		node.children.forEach((child) => visit(child, node, depth + 1));
	};
	visit(root, null, 0);
}

export function findBehaviorNode(root: IBehaviorNodeDefinition, id: string): IBehaviorNodeDefinition | null {
	let result: IBehaviorNodeDefinition | null = null;
	visitBehaviorNodes(root, (node) => {
		if (node.id === id) {
			result = node;
		}
	});
	return result;
}

function validateFinitePosition(position: [number, number], label: string): void {
	if (!Array.isArray(position) || position.length !== 2 || !position.every((value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100000)) {
		throw new Error(`${label} position must contain two finite values from -100000 through 100000.`);
	}
}

function validateJson(value: unknown, label: string): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error(`${label} must be JSON-serializable.`);
	}
	if (serialized === undefined || serialized.length > 65536) {
		throw new Error(`${label} must be JSON-serializable and no larger than 65536 bytes.`);
	}
}

export function validateBehaviorGraphs(graphs: IBehaviorGraphDefinition[]): void {
	if (graphs.length > 128) {
		throw new Error("A scene can contain at most 128 behavior graphs.");
	}
	const graphIds = new Set<string>();
	const graphNames = new Set<string>();
	const sceneVariables = new Map<string, { type: BehaviorBlackboardValueType; defaultValue: string }>();
	for (const graph of graphs) {
		if (graph.version !== 2 || !Number.isInteger(graph.revision) || graph.revision < 1) {
			throw new Error(`Behavior graph "${graph.name}" has an invalid version or revision.`);
		}
		if (typeof graph.enabled !== "boolean" || typeof graph.autoStart !== "boolean") {
			throw new Error(`Behavior graph "${graph.name}" has invalid enabled or auto-start flags.`);
		}
		if (!graph.id.trim() || graph.id.length > 256 || graphIds.has(graph.id)) {
			throw new Error(`Behavior graph id "${graph.id}" is empty, too long, or duplicated.`);
		}
		const nameKey = graph.name.trim().toLowerCase();
		if (!nameKey || graph.name.length > 256 || graphNames.has(nameKey)) {
			throw new Error(`Behavior graph name "${graph.name}" is empty, too long, or duplicated.`);
		}
		graphIds.add(graph.id);
		graphNames.add(nameKey);
		if (graph.startEvent !== undefined && (!graph.startEvent.trim() || graph.startEvent.length > 128)) {
			throw new Error(`Behavior graph "${graph.name}" has an invalid start event.`);
		}
		if (graph.agentNodeId !== undefined && (!graph.agentNodeId.trim() || graph.agentNodeId.length > 256)) {
			throw new Error(`Behavior graph "${graph.name}" has an invalid agent node id.`);
		}
		if (graph.blackboard.length > 128) {
			throw new Error(`Behavior graph "${graph.name}" exceeds 128 Blackboard variables.`);
		}
		const variableIds = new Set<string>();
		const variableNames = new Set<string>();
		for (const variable of graph.blackboard) {
			const variableName = variable.name.trim().toLowerCase();
			if (!variable.id.trim() || variable.id.length > 256 || variableIds.has(variable.id)) {
				throw new Error(`Behavior graph "${graph.name}" has an invalid or duplicated Blackboard id.`);
			}
			if (!variableName || variable.name.length > 128 || variableNames.has(variableName)) {
				throw new Error(`Behavior graph "${graph.name}" has an invalid or duplicated Blackboard name.`);
			}
			if (!["boolean", "number", "string", "vector3", "node"].includes(variable.type)) {
				throw new Error(`Blackboard variable "${variable.name}" has an unsupported type.`);
			}
			if (!["graph", "scene"].includes(variable.scope)) {
				throw new Error(`Blackboard variable "${variable.name}" has an unsupported scope.`);
			}
			if (typeof variable.exposed !== "boolean") {
				throw new Error(`Blackboard variable "${variable.name}" has an invalid exposed flag.`);
			}
			validateBehaviorBlackboardValue(variable.type, variable.defaultValue, `Blackboard variable "${variable.name}" default`);
			if (variable.scope === "scene") {
				const key = variable.name.trim().toLowerCase();
				const current = sceneVariables.get(key);
				const defaultValue = JSON.stringify(variable.defaultValue);
				if (current && (current.type !== variable.type || current.defaultValue !== defaultValue)) {
					throw new Error(`Scene Blackboard variable "${variable.name}" must use the same type and default in every graph.`);
				}
				sceneVariables.set(key, { type: variable.type, defaultValue });
			}
			variableIds.add(variable.id);
			variableNames.add(variableName);
		}

		const nodeIds = new Set<string>();
		let nodeCount = 0;
		visitBehaviorNodes(graph.root, (node) => {
			nodeCount++;
			if (nodeCount > 512) {
				throw new Error(`Behavior graph "${graph.name}" exceeds 512 nodes.`);
			}
			if (!node.id.trim() || node.id.length > 256 || nodeIds.has(node.id)) {
				throw new Error(`Behavior node id "${node.id}" is empty, too long, or duplicated.`);
			}
			if (!behaviorNodeTypes.includes(node.type)) {
				throw new Error(`Unsupported behavior node type "${node.type}".`);
			}
			if (typeof node.enabled !== "boolean" || (node.name !== undefined && (!node.name.trim() || node.name.length > 128))) {
				throw new Error(`Behavior node "${node.id}" has an invalid enabled flag or name.`);
			}
			validateFinitePosition(node.position, `Behavior node "${node.id}"`);
			nodeIds.add(node.id);
			if (compositeTypes.has(node.type) && node.children.length < 1) {
				throw new Error(`${node.type} requires at least one child node.`);
			}
			if (modifierTypes.has(node.type) && node.children.length !== 1) {
				throw new Error(`${node.type} requires exactly one child node.`);
			}
			if (!compositeTypes.has(node.type) && !modifierTypes.has(node.type) && node.children.length) {
				throw new Error(`${node.type} cannot contain child nodes.`);
			}
			if (["condition-node-enabled", "condition-distance", "action-set-enabled", "action-set-position"].includes(node.type) && !node.nodeId?.trim()) {
				throw new Error(`${node.type} requires nodeId.`);
			}
			if (
				["condition-nav-arrived", "action-nav-set-destination", "action-nav-start", "action-nav-stop", "action-nav-move-to"].includes(node.type) &&
				!node.navAgentId?.trim()
			) {
				throw new Error(`${node.type} requires navAgentId.`);
			}
			if (["condition-variable", "action-set-variable"].includes(node.type) && (!node.variableId || !variableIds.has(node.variableId))) {
				throw new Error(`${node.type} requires a Blackboard variable in the containing graph.`);
			}
			if (node.variableId !== undefined && !variableIds.has(node.variableId)) {
				throw new Error(`Behavior node "${node.id}" references an unknown Blackboard variable.`);
			}
			if (["action-set-variable", "condition-variable"].includes(node.type) && node.variableId) {
				const variable = graph.blackboard.find((candidate) => candidate.id === node.variableId)!;
				validateBehaviorBlackboardValue(variable.type, node.value, `Behavior node "${node.id}" value`);
			}
			if (["action-set-position", "action-nav-set-destination", "action-nav-move-to"].includes(node.type) && node.variableId) {
				const variable = graph.blackboard.find((candidate) => candidate.id === node.variableId)!;
				if (variable.type !== "vector3") {
					throw new Error(`${node.type} requires a vector3 Blackboard variable.`);
				}
			}
			if (["condition-variable", "condition-distance"].includes(node.type) && !node.operator) {
				throw new Error(`${node.type} requires a comparison operator.`);
			}
			if (["condition-node-enabled", "action-set-enabled"].includes(node.type) && typeof node.value !== "boolean") {
				throw new Error(`${node.type} requires a Boolean value.`);
			}
			if (node.type === "condition-distance" && (typeof node.value !== "number" || !Number.isFinite(node.value))) {
				throw new Error("condition-distance requires a finite numeric distance.");
			}
			if (["action-set-position", "action-nav-set-destination", "action-nav-move-to"].includes(node.type) && !node.variableId) {
				if (!Array.isArray(node.value) || node.value.length !== 3 || !node.value.every(Number.isFinite)) {
					throw new Error(`${node.type} requires a finite [x, y, z] value or Blackboard variable.`);
				}
			}
			if (["action-send-event", "wait-event"].includes(node.type) && (!node.eventName?.trim() || node.eventName.length > 128)) {
				throw new Error(`${node.type} requires an event name.`);
			}
			if (node.type === "action-wait" && (!(node.duration! >= 0) || node.duration! > 86400 || !Number.isFinite(node.duration))) {
				throw new Error("action-wait duration must be from 0 through 86400 seconds.");
			}
			if (node.type === "repeat" && (!Number.isInteger(node.repeatCount ?? 0) || (node.repeatCount ?? 0) < 0 || (node.repeatCount ?? 0) > 10000)) {
				throw new Error("repeatCount must be an integer from 0 through 10000; zero means indefinite.");
			}
			if (node.type === "subgraph" && !node.subgraphId?.trim()) {
				throw new Error("subgraph requires subgraphId.");
			}
			if (node.type === "custom" && (!node.unitId?.trim() || node.unitId.length > 128)) {
				throw new Error("custom requires a unitId from 1 through 128 characters.");
			}
			if (node.settings !== undefined && (typeof node.settings !== "object" || node.settings === null || Array.isArray(node.settings))) {
				throw new Error(`Behavior node "${node.id}" settings must be an object.`);
			}
			if (node.value !== undefined) {
				validateJson(node.value, `Behavior node "${node.id}" value`);
			}
			if (node.settings !== undefined) {
				validateJson(node.settings, `Behavior node "${node.id}" settings`);
			}
			if (node.utility) {
				if (node.utility.variableId !== undefined && !variableIds.has(node.utility.variableId)) {
					throw new Error(`Behavior node "${node.id}" utility references an unknown Blackboard variable.`);
				}
				if (
					node.utility.variableId !== undefined &&
					!["number", "boolean"].includes(graph.blackboard.find((candidate) => candidate.id === node.utility!.variableId)!.type)
				) {
					throw new Error(`Behavior node "${node.id}" utility requires a number or Boolean Blackboard variable.`);
				}
				if (node.utility.constant !== undefined && !Number.isFinite(node.utility.constant)) {
					throw new Error(`Behavior node "${node.id}" has an invalid utility constant.`);
				}
				if (!Number.isFinite(node.utility.weight) || Math.abs(node.utility.weight) > 100000) {
					throw new Error(`Behavior node "${node.id}" has an invalid utility weight.`);
				}
				if (typeof node.utility.invert !== "boolean") {
					throw new Error(`Behavior node "${node.id}" has an invalid utility invert flag.`);
				}
			}
		});
	}

	const graphById = new Map(graphs.map((graph) => [graph.id, graph]));
	const references = new Map<string, string[]>();
	for (const graph of graphs) {
		const targets: string[] = [];
		visitBehaviorNodes(graph.root, (node) => {
			if (node.subgraphId) {
				if (!graphById.has(node.subgraphId)) {
					throw new Error(`Behavior graph "${graph.name}" references missing subgraph "${node.subgraphId}".`);
				}
				targets.push(node.subgraphId);
			}
		});
		references.set(graph.id, targets);
	}
	const visited = new Set<string>();
	const active = new Set<string>();
	const visit = (id: string): void => {
		if (active.has(id)) {
			throw new Error(`Behavior subgraph references contain a cycle at "${graphById.get(id)?.name ?? id}".`);
		}
		if (visited.has(id)) {
			return;
		}
		active.add(id);
		for (const target of references.get(id) ?? []) {
			visit(target);
		}
		active.delete(id);
		visited.add(id);
	};
	for (const graph of graphs) {
		visit(graph.id);
	}
}

export function isBehaviorComposite(type: BehaviorNodeType): boolean {
	return compositeTypes.has(type) || modifierTypes.has(type);
}
