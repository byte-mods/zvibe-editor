import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Observer } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";

import { getNavigationCrowdController, INavAgentDefinition } from "./nav-agents";
import {
	BehaviorNodeStatus,
	findBehaviorNode,
	IBehaviorBlackboardVariable,
	IBehaviorGraphDefinition,
	IBehaviorNodeDefinition,
	normalizeBehaviorGraphs,
	validateBehaviorBlackboardValue,
	validateBehaviorGraphs,
	visitBehaviorNodes,
} from "./behavior-graph-model";

export * from "./behavior-graph-model";

export type BehaviorGraphRuntimeStatus = "stopped" | "running" | "paused" | "succeeded" | "failed" | "error";

export interface IBehaviorGraphTraceEvent {
	sequence: number;
	time: number;
	graphId: string;
	graphName: string;
	nodeId: string | null;
	phase: "start" | "enter" | "status" | "event" | "breakpoint" | "stop" | "error";
	status?: BehaviorNodeStatus;
	detail?: string;
}

export interface IBehaviorGraphRuntimeState {
	graphId: string;
	graphName: string;
	status: BehaviorGraphRuntimeStatus;
	currentNodeId: string | null;
	nodeStatuses: Record<string, BehaviorNodeStatus>;
	blackboard: Record<string, unknown>;
	breakpoints: string[];
	steps: number;
	lastEvent: string | null;
	error: string | null;
}

export interface IBehaviorCustomNodeContext {
	scene: Scene;
	graph: IBehaviorGraphDefinition;
	node: IBehaviorNodeDefinition;
	deltaSeconds: number;
	settings: Record<string, unknown>;
	getBlackboard: (identifier: string) => unknown;
	setBlackboard: (identifier: string, value: unknown) => void;
	dispatchEvent: (name: string, payload?: unknown) => void;
}

export interface IBehaviorCustomNodeDefinition {
	id: string;
	tick: (context: IBehaviorCustomNodeContext) => BehaviorNodeStatus;
	stop?: (context: Omit<IBehaviorCustomNodeContext, "deltaSeconds">) => void;
}

interface IBehaviorEvent {
	sequence: number;
	payload: unknown;
}

interface IBehaviorGraphWork {
	graphId: string;
	memory: Map<string, Record<string, unknown>>;
	nodeStatuses: Map<string, BehaviorNodeStatus>;
	eventBaselines: Map<string, number>;
	steps: number;
	currentNodeId: string | null;
	ignoreBreakpointNodeId: string | null;
}

const customNodes = new Map<string, IBehaviorCustomNodeDefinition>();
const runtimes = new WeakMap<Scene, BehaviorGraphRuntime>();

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function vector3Value(value: unknown, label: string): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || !value.every((component) => typeof component === "number" && Number.isFinite(component))) {
		throw new Error(`${label} requires a finite [x, y, z] value.`);
	}
	return [value[0], value[1], value[2]];
}

/** Registers a code-defined behavior node shared by editor preview and exported games. */
export function registerBehaviorNode(definition: IBehaviorCustomNodeDefinition): () => void {
	if (!definition.id.trim() || definition.id.length > 128) {
		throw new Error("Custom behavior node id must contain from 1 through 128 characters.");
	}
	if (customNodes.has(definition.id)) {
		throw new Error(`Custom behavior node "${definition.id}" is already registered.`);
	}
	customNodes.set(definition.id, definition);
	return () => {
		if (customNodes.get(definition.id) === definition) {
			customNodes.delete(definition.id);
		}
	};
}

export function listBehaviorNodes(): string[] {
	return [...customNodes.keys()].sort();
}

/** Shared editor/export runtime for bounded Behavior Graphs, Blackboard data, events, subgraphs, navigation, utility selection, and live debugging. */
export class BehaviorGraphRuntime {
	private _graphs: IBehaviorGraphDefinition[];
	private _graphValues = new Map<string, Map<string, unknown>>();
	private _sceneValues = new Map<string, unknown>();
	private _states = new Map<string, IBehaviorGraphRuntimeState>();
	private _works = new Map<string, IBehaviorGraphWork>();
	private _events = new Map<string, IBehaviorEvent>();
	private _trace: IBehaviorGraphTraceEvent[] = [];
	private _breakpoints = new Map<string, Set<string>>();
	private _time = 0;
	private _sequence = 0;
	private _eventSequence = 0;
	private _nodeBudget = Number.POSITIVE_INFINITY;
	private _stepTargetNodeId: string | null = null;
	private _tickEvaluations = 0;
	private _halted = false;
	private _disposed = false;
	private _observer: Observer<Scene> | null = null;

	public constructor(
		private _scene: Scene,
		graphs: unknown[]
	) {
		this._graphs = normalizeBehaviorGraphs(graphs);
		validateBehaviorGraphs(this._graphs);
		for (const graph of this._graphs) {
			const values = new Map<string, unknown>();
			for (const variable of graph.blackboard) {
				if (variable.scope === "graph") {
					values.set(variable.id, cloneValue(variable.defaultValue));
				} else if (!this._sceneValues.has(variable.name.toLowerCase())) {
					this._sceneValues.set(variable.name.toLowerCase(), cloneValue(variable.defaultValue));
				}
			}
			this._graphValues.set(graph.id, values);
			this._states.set(graph.id, this._newState(graph));
		}
		for (const graph of this._graphs) {
			this._syncState(graph);
		}
	}

	public attach(): void {
		if (this._observer || this._disposed) {
			return;
		}
		this._observer = this._scene.onBeforeRenderObservable.add(() => this.tick(Math.min(Math.max(this._scene.getEngine().getDeltaTime() / 1000, 0), 0.25)));
		this._scene.onDisposeObservable.addOnce(() => this.dispose());
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		for (const graph of this._graphs) {
			this._stopCustomNodes(graph);
		}
		if (this._observer) {
			this._scene.onBeforeRenderObservable.remove(this._observer);
		}
		this._observer = null;
		this._works.clear();
		this._disposed = true;
		if (runtimes.get(this._scene) === this) {
			runtimes.delete(this._scene);
		}
		if ((this._scene as any).behaviorGraphs === this) {
			delete (this._scene as any).behaviorGraphs;
		}
	}

	public startAutoGraphs(): void {
		for (const graph of this._graphs) {
			if (graph.enabled && graph.autoStart) {
				this.startGraph(graph.id);
			}
		}
	}

	public startGraph(identifier: string): IBehaviorGraphRuntimeState {
		const graph = this._graph(identifier);
		if (!graph.enabled) {
			throw new Error(`Behavior graph "${graph.name}" is disabled.`);
		}
		const state = this._states.get(graph.id)!;
		this._resetGraph(graph);
		state.status = "running";
		state.error = null;
		this._traceEvent(graph, null, "start");
		this.tickGraph(graph.id, 0);
		return this.getGraphState(graph.id);
	}

	public stopGraph(identifier: string): IBehaviorGraphRuntimeState {
		const graph = this._graph(identifier);
		this._stopCustomNodes(graph);
		this._works.delete(graph.id);
		const state = this._states.get(graph.id)!;
		state.status = "stopped";
		state.currentNodeId = null;
		this._traceEvent(graph, null, "stop");
		return this.getGraphState(graph.id);
	}

	public tick(deltaSeconds: number): void {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			throw new Error("Behavior runtime deltaSeconds must be from 0 through 1.");
		}
		this._time += deltaSeconds;
		for (const graph of this._graphs) {
			const state = this._states.get(graph.id)!;
			if (state.status === "running") {
				this.tickGraph(graph.id, deltaSeconds);
			}
		}
	}

	public tickGraph(identifier: string, deltaSeconds = 0): IBehaviorGraphRuntimeState {
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			throw new Error("Behavior graph deltaSeconds must be from 0 through 1.");
		}
		const graph = this._graph(identifier);
		const state = this._states.get(graph.id)!;
		if (state.status === "stopped" || state.status === "succeeded" || state.status === "failed" || state.status === "error") {
			return this.getGraphState(graph.id);
		}
		if (state.status === "paused") {
			return this.getGraphState(graph.id);
		}
		const work = this._works.get(graph.id)!;
		this._nodeBudget = Number.POSITIVE_INFINITY;
		this._stepTargetNodeId = null;
		this._tickEvaluations = 0;
		this._halted = false;
		try {
			const result = this._tickNode(graph, graph.root, work, graph.id, deltaSeconds, 0);
			if (!this._halted && (result === "succeeded" || result === "failed")) {
				state.status = result;
				state.currentNodeId = null;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state.status = "error";
			state.error = message;
			this._traceEvent(graph, state.currentNodeId, "error", undefined, message);
			throw error;
		}
		this._syncState(graph, work);
		return this.getGraphState(graph.id);
	}

	public dispatchEvent(name: string, payload?: unknown, identifier?: string): IBehaviorGraphRuntimeState[] {
		if (!name.trim() || name.length > 128) {
			throw new Error("Behavior event name must contain from 1 through 128 characters.");
		}
		this._emitEvent(name, payload);
		const candidates = identifier ? [this._graph(identifier)] : this._graphs;
		const results: IBehaviorGraphRuntimeState[] = [];
		for (const graph of candidates) {
			const state = this._states.get(graph.id)!;
			if (graph.enabled && graph.startEvent === name && ["stopped", "succeeded", "failed", "error"].includes(state.status)) {
				this.startGraph(graph.id);
			} else if (state.status === "running") {
				this.tickGraph(graph.id, 0);
			}
			results.push(this.getGraphState(graph.id));
		}
		return results;
	}

	public setBlackboardValue(identifier: string, variableIdentifier: string, value: unknown): IBehaviorGraphRuntimeState {
		const graph = this._graph(identifier);
		this._setBlackboard(graph, variableIdentifier, value);
		this._syncState(graph, this._works.get(graph.id));
		return this.getGraphState(graph.id);
	}

	public setBreakpoints(identifier: string, nodeIds: string[]): IBehaviorGraphRuntimeState {
		const graph = this._graph(identifier);
		if (nodeIds.length > 64 || new Set(nodeIds).size !== nodeIds.length) {
			throw new Error("Behavior breakpoints must be unique and contain at most 64 node ids.");
		}
		for (const id of nodeIds) {
			if (!findBehaviorNode(graph.root, id)) {
				throw new Error(`Behavior node "${id}" was not found.`);
			}
		}
		this._breakpoints.set(graph.id, new Set(nodeIds));
		this._syncState(graph, this._works.get(graph.id));
		return this.getGraphState(graph.id);
	}

	public continueGraph(identifier: string): IBehaviorGraphRuntimeState {
		const graph = this._graph(identifier);
		const state = this._states.get(graph.id)!;
		if (state.status !== "paused") {
			throw new Error(`Behavior graph "${graph.name}" is not paused.`);
		}
		const work = this._works.get(graph.id)!;
		work.ignoreBreakpointNodeId = work.currentNodeId;
		state.status = "running";
		return this.tickGraph(graph.id, 0);
	}

	public stepGraph(identifier: string, deltaSeconds = 0): IBehaviorGraphRuntimeState {
		const graph = this._graph(identifier);
		const state = this._states.get(graph.id)!;
		if (state.status !== "paused") {
			throw new Error(`Behavior graph "${graph.name}" must be paused before stepping.`);
		}
		if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			throw new Error("Behavior step deltaSeconds must be from 0 through 1.");
		}
		const work = this._works.get(graph.id)!;
		const targetNodeId = work.currentNodeId;
		work.ignoreBreakpointNodeId = targetNodeId;
		state.status = "running";
		this._nodeBudget = 1;
		this._stepTargetNodeId = targetNodeId;
		this._tickEvaluations = 0;
		this._halted = false;
		try {
			const result = this._tickNode(graph, graph.root, work, graph.id, deltaSeconds, 0);
			if (result === "succeeded" || result === "failed") {
				state.status = result;
			} else {
				state.status = "paused";
			}
		} catch (error) {
			state.status = "error";
			state.error = error instanceof Error ? error.message : String(error);
			throw error;
		}
		this._syncState(graph, work);
		return this.getGraphState(graph.id);
	}

	public getGraphState(identifier: string): IBehaviorGraphRuntimeState {
		const graph = this._graph(identifier);
		return cloneValue(this._states.get(graph.id)!);
	}

	public getStates(): IBehaviorGraphRuntimeState[] {
		return this._graphs.map((graph) => this.getGraphState(graph.id));
	}

	public getTrace(): IBehaviorGraphTraceEvent[] {
		return cloneValue(this._trace);
	}

	public clearTrace(): void {
		this._trace = [];
	}

	private _tickNode(
		graph: IBehaviorGraphDefinition,
		node: IBehaviorNodeDefinition,
		work: IBehaviorGraphWork,
		namespace: string,
		deltaSeconds: number,
		depth: number
	): BehaviorNodeStatus {
		if (depth > 32) {
			throw new Error("Behavior subgraph execution exceeds 32 nested calls.");
		}
		const key = `${namespace}:${node.id}`;
		if (this._tickEvaluations >= 4096) {
			throw new Error(`Behavior graph "${graph.name}" exceeded 4096 node evaluations in one tick.`);
		}
		if (this._nodeBudget <= 0) {
			this._halted = true;
			this._states.get(work.graphId)!.status = "paused";
			return work.nodeStatuses.get(key) ?? "running";
		}
		if (!Number.isFinite(this._nodeBudget) || this._stepTargetNodeId === null || this._stepTargetNodeId === node.id) {
			this._nodeBudget--;
			if (this._stepTargetNodeId === node.id) {
				this._stepTargetNodeId = null;
			}
		}
		work.steps++;
		this._tickEvaluations++;
		work.currentNodeId = node.id;
		const rootGraph = this._graph(work.graphId);
		const state = this._states.get(work.graphId)!;
		state.currentNodeId = node.id;
		if (this._breakpoints.get(work.graphId)?.has(node.id) && work.ignoreBreakpointNodeId !== node.id && (work.nodeStatuses.get(key) ?? "uninitialized") === "uninitialized") {
			state.status = "paused";
			this._halted = true;
			this._setNodeStatus(rootGraph, work, key, "running");
			this._traceEvent(rootGraph, node.id, "breakpoint");
			return "running";
		}
		if (work.ignoreBreakpointNodeId === node.id) {
			work.ignoreBreakpointNodeId = null;
		}
		this._traceEvent(rootGraph, node.id, "enter", work.nodeStatuses.get(key) ?? "uninitialized", graph.id === rootGraph.id ? undefined : `subgraph:${graph.name}`);
		if (!node.enabled) {
			return this._setNodeStatus(rootGraph, work, key, "succeeded");
		}

		let result: BehaviorNodeStatus;
		if (["sequence", "selector"].includes(node.type)) {
			result = this._tickOrdered(graph, node, work, namespace, deltaSeconds, depth);
		} else if (node.type === "random" || node.type === "utility-selector") {
			result = this._tickChosen(graph, node, work, namespace, deltaSeconds, depth);
		} else if (node.type === "parallel-all" || node.type === "parallel-any") {
			result = this._tickParallel(graph, node, work, namespace, deltaSeconds, depth);
		} else if (["inverter", "succeeder", "repeat"].includes(node.type)) {
			result = this._tickModifier(graph, node, work, namespace, deltaSeconds, depth);
		} else {
			result = this._tickLeaf(graph, node, work, namespace, deltaSeconds, depth);
		}
		if (this._halted) {
			return result;
		}
		return this._setNodeStatus(rootGraph, work, key, result);
	}

	private _tickOrdered(
		graph: IBehaviorGraphDefinition,
		node: IBehaviorNodeDefinition,
		work: IBehaviorGraphWork,
		namespace: string,
		deltaSeconds: number,
		depth: number
	): BehaviorNodeStatus {
		const memory = this._memory(work, `${namespace}:${node.id}`);
		let index = Number(memory.index ?? 0);
		while (index < node.children.length) {
			const child = node.children[index];
			const status = this._tickNode(graph, child, work, namespace, deltaSeconds, depth + 1);
			if (this._halted) {
				return "running";
			}
			if (node.type === "sequence") {
				if (status === "failed") {
					return "failed";
				}
				if (status === "running" || status === "waiting") {
					return status;
				}
			} else {
				if (status === "succeeded") {
					return "succeeded";
				}
				if (status === "running" || status === "waiting") {
					return status;
				}
			}
			memory.index = ++index;
		}
		return node.type === "sequence" ? "succeeded" : "failed";
	}

	private _tickChosen(
		graph: IBehaviorGraphDefinition,
		node: IBehaviorNodeDefinition,
		work: IBehaviorGraphWork,
		namespace: string,
		deltaSeconds: number,
		depth: number
	): BehaviorNodeStatus {
		const memory = this._memory(work, `${namespace}:${node.id}`);
		if (!Number.isInteger(memory.index)) {
			memory.index =
				node.type === "random"
					? Math.floor(Math.random() * node.children.length)
					: node.children.reduce((best, child, index) => (this._utilityScore(graph, child) > this._utilityScore(graph, node.children[best]) ? index : best), 0);
		}
		return this._tickNode(graph, node.children[memory.index as number], work, namespace, deltaSeconds, depth + 1);
	}

	private _tickParallel(
		graph: IBehaviorGraphDefinition,
		node: IBehaviorNodeDefinition,
		work: IBehaviorGraphWork,
		namespace: string,
		deltaSeconds: number,
		depth: number
	): BehaviorNodeStatus {
		const statuses = node.children.map((child) => {
			const existing = work.nodeStatuses.get(`${namespace}:${child.id}`);
			return existing === "succeeded" || existing === "failed" ? existing : this._tickNode(graph, child, work, namespace, deltaSeconds, depth + 1);
		});
		if (this._halted) {
			return "running";
		}
		if (node.type === "parallel-all") {
			if (statuses.includes("failed")) {
				return "failed";
			}
			return statuses.every((status) => status === "succeeded") ? "succeeded" : statuses.includes("waiting") ? "waiting" : "running";
		}
		if (statuses.includes("succeeded")) {
			return "succeeded";
		}
		return statuses.every((status) => status === "failed") ? "failed" : statuses.includes("waiting") ? "waiting" : "running";
	}

	private _tickModifier(
		graph: IBehaviorGraphDefinition,
		node: IBehaviorNodeDefinition,
		work: IBehaviorGraphWork,
		namespace: string,
		deltaSeconds: number,
		depth: number
	): BehaviorNodeStatus {
		const child = node.children[0];
		const status = this._tickNode(graph, child, work, namespace, deltaSeconds, depth + 1);
		if (this._halted || status === "running" || status === "waiting") {
			return status;
		}
		if (node.type === "inverter") {
			return status === "succeeded" ? "failed" : "succeeded";
		}
		if (node.type === "succeeder") {
			return "succeeded";
		}
		if (status === "failed") {
			return "failed";
		}
		const memory = this._memory(work, `${namespace}:${node.id}`);
		const count = Number(memory.count ?? 0) + 1;
		memory.count = count;
		if ((node.repeatCount ?? 0) > 0 && count >= (node.repeatCount ?? 0)) {
			return "succeeded";
		}
		this._resetNode(child, work, namespace);
		return "running";
	}

	private _tickLeaf(
		graph: IBehaviorGraphDefinition,
		node: IBehaviorNodeDefinition,
		work: IBehaviorGraphWork,
		namespace: string,
		deltaSeconds: number,
		depth: number
	): BehaviorNodeStatus {
		if (node.type === "condition-node-enabled") {
			const target = this._scene.getNodeById(node.nodeId!);
			return target && target.isEnabled() === (node.value ?? true) ? "succeeded" : "failed";
		}
		if (node.type === "condition-variable") {
			return this._compare(this._getBlackboard(graph, node.variableId!), node.value, node.operator!) ? "succeeded" : "failed";
		}
		if (node.type === "condition-distance") {
			const agent = graph.agentNodeId ? this._scene.getNodeById(graph.agentNodeId) : null;
			const target = this._scene.getNodeById(node.nodeId!);
			const agentPosition = (agent as any)?.getAbsolutePosition?.() ?? (agent as any)?.position;
			const targetPosition = (target as any)?.getAbsolutePosition?.() ?? (target as any)?.position;
			if (!agentPosition || !targetPosition) {
				return "failed";
			}
			return this._compare(Vector3.Distance(agentPosition, targetPosition), node.value ?? 0, node.operator!) ? "succeeded" : "failed";
		}
		if (node.type === "condition-nav-arrived") {
			const runtime = getNavigationCrowdController(this._scene)?.getAgentRuntime(node.navAgentId!);
			return runtime && (!runtime.isMoving || runtime.remainingDistance <= 0.001) ? "succeeded" : "failed";
		}
		if (node.type === "action-set-enabled") {
			const target = this._scene.getNodeById(node.nodeId!);
			if (!target) {
				return "failed";
			}
			target.setEnabled(node.value === true);
			return "succeeded";
		}
		if (node.type === "action-set-position") {
			const target = this._scene.getNodeById(node.nodeId!) as any;
			if (!target?.position) {
				return "failed";
			}
			target.position.copyFrom(Vector3.FromArray(vector3Value(this._nodeValue(graph, node), "action-set-position")));
			return "succeeded";
		}
		if (node.type === "action-set-variable") {
			this._setBlackboard(graph, node.variableId!, node.value);
			return "succeeded";
		}
		if (node.type === "action-wait") {
			const memory = this._memory(work, `${namespace}:${node.id}`);
			memory.elapsed = Number(memory.elapsed ?? 0) + deltaSeconds;
			return Number(memory.elapsed) >= (node.duration ?? 0) ? "succeeded" : "running";
		}
		if (node.type === "action-log") {
			this._traceEvent(this._graph(work.graphId), node.id, "status", "succeeded", String(this._nodeValue(graph, node) ?? ""));
			return "succeeded";
		}
		if (node.type === "action-send-event") {
			this._emitEvent(node.eventName!, this._nodeValue(graph, node));
			return "succeeded";
		}
		if (node.type === "wait-event") {
			const memory = this._memory(work, `${namespace}:${node.id}`);
			const baseline = Number(memory.sequence ?? work.eventBaselines.get(node.eventName!) ?? 0);
			const current = this._events.get(node.eventName!)?.sequence ?? 0;
			if (current <= baseline) {
				memory.sequence = baseline;
				return "waiting";
			}
			memory.sequence = current;
			if (node.variableId) {
				this._setBlackboard(graph, node.variableId, this._events.get(node.eventName!)!.payload);
			}
			return "succeeded";
		}
		if (["action-nav-set-destination", "action-nav-start", "action-nav-stop", "action-nav-move-to"].includes(node.type)) {
			return this._tickNavigation(graph, node, work, namespace);
		}
		if (node.type === "subgraph") {
			const subgraph = this._graph(node.subgraphId!);
			return this._tickNode(subgraph, subgraph.root, work, `${namespace}/${node.id}/${subgraph.id}`, deltaSeconds, depth + 1);
		}
		if (node.type === "custom") {
			const definition = customNodes.get(node.unitId!);
			if (!definition) {
				throw new Error(`Custom behavior node "${node.unitId}" is not registered.`);
			}
			const status = definition.tick(this._customContext(graph, node, deltaSeconds));
			if (!["running", "waiting", "succeeded", "failed"].includes(status)) {
				throw new Error(`Custom behavior node "${node.unitId}" returned invalid status "${status}".`);
			}
			return status;
		}
		return "failed";
	}

	private _tickNavigation(graph: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition, work: IBehaviorGraphWork, namespace: string): BehaviorNodeStatus {
		const definitions = this._scene.metadata?.babylonEditorNavAgents as INavAgentDefinition[] | undefined;
		const agent = definitions?.find((candidate) => candidate.id === node.navAgentId);
		const controller = getNavigationCrowdController(this._scene);
		if (!agent || !controller) {
			return "failed";
		}
		if (node.type === "action-nav-set-destination" || node.type === "action-nav-move-to") {
			agent.destination = vector3Value(this._nodeValue(graph, node), node.type);
			if (node.type === "action-nav-set-destination") {
				return "succeeded";
			}
			const memory = this._memory(work, `${namespace}:${node.id}`);
			if (!memory.started) {
				controller.startAgent(agent.id);
				memory.started = true;
			}
			const runtime = controller.getAgentRuntime(agent.id);
			return !runtime.isMoving || runtime.remainingDistance <= (agent.reachRadius ?? agent.radius) ? "succeeded" : "running";
		}
		if (node.type === "action-nav-start") {
			controller.startAgent(agent.id);
		} else {
			controller.stopAgent(agent.id);
		}
		return "succeeded";
	}

	private _nodeValue(graph: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition): unknown {
		return node.variableId ? this._getBlackboard(graph, node.variableId) : cloneValue(node.value);
	}

	private _utilityScore(graph: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition): number {
		const utility = node.utility;
		if (!utility) {
			return 0;
		}
		const raw = utility.variableId ? this._getBlackboard(graph, utility.variableId) : (utility.constant ?? 0);
		const numeric = typeof raw === "number" && Number.isFinite(raw) ? raw : typeof raw === "boolean" ? (raw ? 1 : 0) : 0;
		return (utility.invert ? 1 - numeric : numeric) * utility.weight;
	}

	private _compare(left: unknown, right: unknown, operator: string): boolean {
		if (operator === "equal") {
			return JSON.stringify(left) === JSON.stringify(right);
		}
		if (operator === "notEqual") {
			return JSON.stringify(left) !== JSON.stringify(right);
		}
		if (typeof left !== "number" || typeof right !== "number") {
			return false;
		}
		if (operator === "less") {
			return left < right;
		}
		if (operator === "lessOrEqual") {
			return left <= right;
		}
		if (operator === "greater") {
			return left > right;
		}
		return left >= right;
	}

	private _getBlackboard(graph: IBehaviorGraphDefinition, identifier: string): unknown {
		const variable = this._variable(graph, identifier);
		return cloneValue(variable.scope === "scene" ? this._sceneValues.get(variable.name.toLowerCase()) : this._graphValues.get(graph.id)?.get(variable.id));
	}

	private _setBlackboard(graph: IBehaviorGraphDefinition, identifier: string, value: unknown): void {
		const variable = this._variable(graph, identifier);
		validateBehaviorBlackboardValue(variable.type, value, `Blackboard variable "${variable.name}"`);
		if (variable.scope === "scene") {
			this._sceneValues.set(variable.name.toLowerCase(), cloneValue(value));
		} else {
			this._graphValues.get(graph.id)!.set(variable.id, cloneValue(value));
		}
	}

	private _variable(graph: IBehaviorGraphDefinition, identifier: string): IBehaviorBlackboardVariable {
		const variable = graph.blackboard.find((candidate) => candidate.id === identifier || candidate.name === identifier);
		if (!variable) {
			throw new Error(`Blackboard variable "${identifier}" was not found in "${graph.name}".`);
		}
		return variable;
	}

	private _graph(identifier: string): IBehaviorGraphDefinition {
		const graph = this._graphs.find((candidate) => candidate.id === identifier || candidate.name === identifier);
		if (!graph) {
			throw new Error(`Behavior graph "${identifier}" was not found.`);
		}
		return graph;
	}

	private _newState(graph: IBehaviorGraphDefinition): IBehaviorGraphRuntimeState {
		return {
			graphId: graph.id,
			graphName: graph.name,
			status: "stopped",
			currentNodeId: null,
			nodeStatuses: {},
			blackboard: {},
			breakpoints: [],
			steps: 0,
			lastEvent: null,
			error: null,
		};
	}

	private _resetGraph(graph: IBehaviorGraphDefinition): void {
		this._resetGraphValues(graph, new Set());
		const work: IBehaviorGraphWork = {
			graphId: graph.id,
			memory: new Map(),
			nodeStatuses: new Map(),
			eventBaselines: new Map([...this._events].map(([name, event]) => [name, event.sequence])),
			steps: 0,
			currentNodeId: null,
			ignoreBreakpointNodeId: null,
		};
		this._works.set(graph.id, work);
		const state = this._states.get(graph.id)!;
		state.currentNodeId = null;
		state.nodeStatuses = {};
		state.steps = 0;
		state.error = null;
	}

	private _resetNode(node: IBehaviorNodeDefinition, work: IBehaviorGraphWork, namespace: string): void {
		const key = `${namespace}:${node.id}`;
		work.memory.delete(key);
		work.nodeStatuses.delete(key);
		node.children.forEach((child) => this._resetNode(child, work, namespace));
		if (node.type === "subgraph" && node.subgraphId) {
			const prefix = `${namespace}/${node.id}/${node.subgraphId}:`;
			for (const candidate of [...work.memory.keys()]) {
				if (candidate.startsWith(prefix)) {
					work.memory.delete(candidate);
				}
			}
			for (const candidate of [...work.nodeStatuses.keys()]) {
				if (candidate.startsWith(prefix)) {
					work.nodeStatuses.delete(candidate);
				}
			}
		}
	}

	private _resetGraphValues(graph: IBehaviorGraphDefinition, visited: Set<string>): void {
		if (visited.has(graph.id)) {
			return;
		}
		visited.add(graph.id);
		const values = this._graphValues.get(graph.id)!;
		values.clear();
		for (const variable of graph.blackboard) {
			if (variable.scope === "graph") {
				values.set(variable.id, cloneValue(variable.defaultValue));
			}
		}
		visitBehaviorNodes(graph.root, (node) => {
			if (node.subgraphId) {
				this._resetGraphValues(this._graph(node.subgraphId), visited);
			}
		});
	}

	private _memory(work: IBehaviorGraphWork, key: string): Record<string, unknown> {
		let memory = work.memory.get(key);
		if (!memory) {
			memory = {};
			work.memory.set(key, memory);
		}
		return memory;
	}

	private _setNodeStatus(graph: IBehaviorGraphDefinition, work: IBehaviorGraphWork, key: string, status: BehaviorNodeStatus): BehaviorNodeStatus {
		if (work.nodeStatuses.get(key) !== status) {
			this._traceEvent(graph, key.slice(key.lastIndexOf(":") + 1), "status", status);
		}
		work.nodeStatuses.set(key, status);
		return status;
	}

	private _syncState(graph: IBehaviorGraphDefinition, work?: IBehaviorGraphWork): void {
		const state = this._states.get(graph.id)!;
		state.breakpoints = [...(this._breakpoints.get(graph.id) ?? [])];
		state.blackboard = Object.fromEntries(graph.blackboard.map((variable) => [variable.name, this._getBlackboard(graph, variable.id)]));
		if (work) {
			state.currentNodeId = work.currentNodeId;
			state.nodeStatuses = Object.fromEntries(work.nodeStatuses);
			state.steps = work.steps;
		}
	}

	private _traceEvent(graph: IBehaviorGraphDefinition, nodeId: string | null, phase: IBehaviorGraphTraceEvent["phase"], status?: BehaviorNodeStatus, detail?: string): void {
		this._trace.push({ sequence: ++this._sequence, time: this._time, graphId: graph.id, graphName: graph.name, nodeId, phase, status, detail });
		if (this._trace.length > 512) {
			this._trace.splice(0, this._trace.length - 512);
		}
	}

	private _emitEvent(name: string, payload?: unknown): void {
		this._events.set(name, { sequence: ++this._eventSequence, payload: cloneValue(payload ?? null) });
		for (const graph of this._graphs) {
			this._states.get(graph.id)!.lastEvent = name;
			this._traceEvent(graph, null, "event", undefined, name);
		}
	}

	private _customContext(graph: IBehaviorGraphDefinition, node: IBehaviorNodeDefinition, deltaSeconds: number): IBehaviorCustomNodeContext {
		return {
			scene: this._scene,
			graph,
			node,
			deltaSeconds,
			settings: cloneValue(node.settings ?? {}),
			getBlackboard: (identifier) => this._getBlackboard(graph, identifier),
			setBlackboard: (identifier, value) => this._setBlackboard(graph, identifier, value),
			dispatchEvent: (name, payload) => {
				this._emitEvent(name, payload);
			},
		};
	}

	private _stopCustomNodes(graph: IBehaviorGraphDefinition, visited = new Set<string>()): void {
		if (visited.has(graph.id)) {
			return;
		}
		visited.add(graph.id);
		visitBehaviorNodes(graph.root, (node) => {
			if (node.type === "custom") {
				customNodes.get(node.unitId!)?.stop?.(this._customContext(graph, node, 0));
			}
			if (node.subgraphId) {
				this._stopCustomNodes(this._graph(node.subgraphId), visited);
			}
		});
	}
}

/** Replaces the active scene Behavior Graph runtime atomically and starts enabled auto-start graphs. */
export function configureBehaviorTrees(scene: Scene): BehaviorGraphRuntime {
	const graphs = normalizeBehaviorGraphs(scene.metadata?.babylonEditorBehaviorTrees);
	validateBehaviorGraphs(graphs);
	const replacement = new BehaviorGraphRuntime(scene, graphs);
	const previous = runtimes.get(scene);
	previous?.dispose();
	runtimes.set(scene, replacement);
	(scene as any).behaviorGraphs = replacement;
	replacement.attach();
	replacement.startAutoGraphs();
	return replacement;
}

/** Gets the active editor/export Behavior Graph runtime, if configured. */
export function getBehaviorGraphRuntime(scene: Scene): BehaviorGraphRuntime | null {
	return runtimes.get(scene) ?? null;
}
