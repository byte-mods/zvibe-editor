import { Observable } from "@babylonjs/core/Misc/observable";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { evaluateVisualScriptExpression } from "./visual-scripting-expression";
import {
	IVisualScriptGraphDefinition,
	IVisualScriptNodeDefinition,
	IVisualScriptNodePorts,
	IVisualScriptTransitionDefinition,
	IVisualScriptVariableDefinition,
	normalizeVisualScriptGraphs,
	getVisualScriptNodePorts,
	validateVisualScriptValue,
	validateVisualScriptGraphs,
} from "./visual-scripting-model";

export * from "./visual-scripting-model";
export * from "./visual-scripting-expression";

export type VisualScriptRuntimeStatus = "stopped" | "running" | "paused" | "error";

export interface IVisualScriptTraceEvent {
	sequence: number;
	time: number;
	graphId: string;
	graphName: string;
	event: string;
	nodeId: string | null;
	phase: "dispatch" | "enter" | "exit" | "breakpoint" | "transition" | "error";
	detail?: string;
}

export interface IVisualScriptGraphRuntimeState {
	graphId: string;
	graphName: string;
	kind: "flow" | "state";
	status: VisualScriptRuntimeStatus;
	activeStateId: string | null;
	currentNodeId: string | null;
	lastEvent: string | null;
	executedNodeIds: string[];
	variables: Record<string, unknown>;
	error: string | null;
	steps: number;
	breakpoints: string[];
}

interface IVisualScriptWork {
	graph: IVisualScriptGraphDefinition;
	event: string;
	payload: unknown;
	queue: Array<{ nodeId: string; port: string }>;
	flowVariables: Map<string, unknown>;
	executed: string[];
	currentNodeId: string | null;
	steps: number;
	ignoreBreakpointNodeId: string | null;
	returnValue: unknown;
	customValues: Map<string, Record<string, unknown>>;
	subgraphValues: Map<string, unknown>;
}

const applicationVariables = new Map<string, unknown>();
const customUnits = new Map<string, IVisualScriptCustomUnitDefinition>();

export interface IVisualScriptCustomUnitContext {
	scene: Scene;
	graph: IVisualScriptGraphDefinition;
	node: IVisualScriptNodeDefinition;
	event: string;
	payload: unknown;
	input: (port: string) => unknown;
	getVariable: (identifier: string) => unknown;
	setVariable: (identifier: string, value: unknown) => void;
}

export interface IVisualScriptCustomUnitResult {
	controlOutputs?: string[];
	values?: Record<string, unknown>;
}

export interface IVisualScriptCustomUnitDefinition {
	id: string;
	ports: IVisualScriptNodePorts;
	execute?: (context: IVisualScriptCustomUnitContext) => IVisualScriptCustomUnitResult | void;
	evaluate?: (context: IVisualScriptCustomUnitContext) => Record<string, unknown>;
}

/** Registers a portable custom visual unit used by editor preview and exported games. */
export function registerVisualScriptUnit(definition: IVisualScriptCustomUnitDefinition): () => void {
	if (!definition.id.trim() || definition.id.length > 128) {
		throw new Error("Custom visual script unit id must contain from 1 through 128 characters.");
	}
	const probe = normalizeVisualScriptGraphs([
		{
			id: "custom-unit-validation",
			name: "Custom Unit Validation",
			kind: "flow",
			nodes: [{ id: "custom", type: "custom", unitId: definition.id, ports: definition.ports, settings: {} }],
		},
	]);
	validateVisualScriptGraphs(probe);
	customUnits.set(definition.id, definition);
	return () => {
		if (customUnits.get(definition.id) === definition) {
			customUnits.delete(definition.id);
		}
	};
}

export function listVisualScriptUnits(): Array<{ id: string; ports: IVisualScriptNodePorts }> {
	return [...customUnits.values()].map((definition) => ({ id: definition.id, ports: cloneValue(definition.ports) }));
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function vector3Value(value: unknown): [number, number, number] {
	return Array.isArray(value) && value.length >= 3 && value.slice(0, 3).every(Number.isFinite) ? [value[0], value[1], value[2]] : [0, 0, 0];
}

/** Shared editor/export runtime for bounded Flow Graphs, State Graphs, events, ports, variables, subgraphs, and debugging. */
export class VisualScriptRuntime {
	public readonly onTraceObservable = new Observable<IVisualScriptTraceEvent>();

	private _graphs: IVisualScriptGraphDefinition[];
	private _scene: Scene;
	private _graphVariables = new Map<string, Map<string, unknown>>();
	private _sceneVariables = new Map<string, unknown>();
	private _objectVariables = new Map<string, Map<string, unknown>>();
	private _states = new Map<string, IVisualScriptGraphRuntimeState>();
	private _work = new Map<string, IVisualScriptWork>();
	private _returnValues = new Map<string, unknown>();
	private _activeStates = new Map<string, string>();
	private _breakpoints = new Map<string, Set<string>>();
	private _trace: IVisualScriptTraceEvent[] = [];
	private _disposeCallbacks: Array<() => void> = [];
	private _time = 0;
	private _sequence = 0;
	private _disposed = false;
	private _callDepth = 0;

	public constructor(scene: Scene, graphs: unknown[]) {
		this._scene = scene;
		this._graphs = normalizeVisualScriptGraphs(graphs);
		validateVisualScriptGraphs(this._graphs);
		for (const graph of this._graphs) {
			const values = new Map<string, unknown>();
			for (const variable of graph.variables) {
				if (variable.scope === "graph") {
					values.set(variable.id, cloneValue(variable.defaultValue));
				}
			}
			this._graphVariables.set(graph.id, values);
			this._states.set(graph.id, this._createState(graph));
		}
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._disposeCallbacks.splice(0).forEach((callback) => callback());
		this._work.clear();
		this.onTraceObservable.clear();
	}

	public addDisposeCallback(callback: () => void): void {
		this._disposeCallbacks.push(callback);
	}

	public startAutoGraphs(): void {
		for (const graph of this._graphs) {
			if (graph.enabled && graph.autoStart) {
				this.startGraph(graph.id);
			}
		}
	}

	public startGraph(identifier: string): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		const state = this._states.get(graph.id)!;
		if (!graph.enabled) {
			throw new Error(`Visual script graph "${graph.name}" is disabled.`);
		}
		if (graph.kind === "state" && state.status === "running") {
			return this.getGraphState(graph.id);
		}
		state.status = "running";
		state.error = null;
		state.lastEvent = "start";
		if (graph.kind === "state") {
			try {
				this._enterInitialState(graph, undefined);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				state.status = "error";
				state.error = message;
				this._traceEvent(graph, "start", null, "error", message);
				throw error;
			}
		} else {
			this.runGraph(graph.id, "start", null, false);
		}
		return this.getGraphState(graph.id);
	}

	public stopGraph(identifier: string): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		const active = graph.kind === "state" ? graph.states.find((candidate) => candidate.id === this._activeStates.get(graph.id)) : null;
		if (active?.onExitGraphId) {
			this.runGraph(active.onExitGraphId, "state-exit", { stateId: active.id }, true);
		}
		this._activeStates.delete(graph.id);
		this._work.delete(graph.id);
		const state = this._states.get(graph.id)!;
		state.status = "stopped";
		state.activeStateId = null;
		state.currentNodeId = null;
		return this.getGraphState(graph.id);
	}

	public update(deltaSeconds: number): void {
		if (this._disposed || !Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			return;
		}
		this._time += deltaSeconds;
		for (const graph of this._graphs) {
			const state = this._states.get(graph.id)!;
			if (state.status !== "running") {
				continue;
			}
			if (graph.kind === "flow") {
				this.runGraph(graph.id, "update", { deltaSeconds }, false);
			} else {
				this._updateStateGraph(graph, "update", { deltaSeconds });
			}
		}
	}

	public fixedUpdate(deltaSeconds: number): void {
		if (this._disposed || !Number.isFinite(deltaSeconds) || deltaSeconds < 0 || deltaSeconds > 1) {
			return;
		}
		for (const graph of this._graphs) {
			if (graph.kind === "flow" && this._states.get(graph.id)?.status === "running") {
				this.runGraph(graph.id, "fixed-update", { deltaSeconds }, false);
			}
		}
	}

	public dispatchEvent(identifier: string, event: string, payload?: unknown): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		if (graph.kind === "state") {
			this._updateStateGraph(graph, event, payload);
		} else {
			this.runGraph(graph.id, event, payload, false);
		}
		return this.getGraphState(graph.id);
	}

	/** Executes one Flow graph event. Complete mode ignores breakpoints for deterministic manual runs and subgraphs. */
	public runGraph(identifier: string, event = "start", payload?: unknown, complete = true): IVisualScriptGraphRuntimeState {
		if (this._callDepth >= 32) {
			throw new Error("Visual script graph call depth exceeded 32 nested events/subgraphs.");
		}
		const graph = this._findGraph(identifier);
		if (graph.kind !== "flow") {
			throw new Error(`Visual script graph "${graph.name}" is not a Flow graph.`);
		}
		const previousWork = this._work.get(graph.id);
		const eventTypes: Record<string, string> = {
			start: "event-start",
			update: "event-update",
			"fixed-update": "event-fixed-update",
			"state-enter": "event-start",
			"state-update": "event-update",
			"state-exit": "event-start",
		};
		const entries = graph.nodes.filter((node) => node.enabled && (node.type === eventTypes[event] || (node.type === "event-custom" && node.eventName === event)));
		const work: IVisualScriptWork = {
			graph,
			event,
			payload: cloneValue(payload),
			queue: entries.map((node) => ({ nodeId: node.id, port: "out" })),
			flowVariables: new Map(graph.variables.filter((variable) => variable.scope === "flow").map((variable) => [variable.id, cloneValue(variable.defaultValue)])),
			executed: [],
			currentNodeId: null,
			steps: 0,
			ignoreBreakpointNodeId: null,
			returnValue: undefined,
			customValues: new Map(),
			subgraphValues: new Map(),
		};
		this._work.set(graph.id, work);
		const state = this._states.get(graph.id)!;
		const previousStatus = state.status;
		state.status = "running";
		state.lastEvent = event;
		state.error = null;
		this._traceEvent(graph, event, null, "dispatch");
		this._callDepth++;
		try {
			this._runWork(work, complete ? "complete" : "continue");
			if (complete && state.status === "running" && previousStatus === "stopped") {
				state.status = "stopped";
			}
			return this.getGraphState(graph.id);
		} finally {
			this._callDepth--;
			if (previousWork) {
				this._work.set(graph.id, previousWork);
			}
		}
	}

	public setBreakpoints(identifier: string, nodeIds: string[]): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		const valid = new Set(
			graph.nodes
				.filter((node) => {
					const ports = getVisualScriptNodePorts(node);
					return ports.controlInputs.length > 0 || ports.controlOutputs.length > 0;
				})
				.map((node) => node.id)
		);
		if (nodeIds.length > 64 || new Set(nodeIds).size !== nodeIds.length || nodeIds.some((id) => !valid.has(id))) {
			throw new Error("Visual script breakpoints must be unique existing control-node ids, capped at 64.");
		}
		this._breakpoints.set(graph.id, new Set(nodeIds));
		this._states.get(graph.id)!.breakpoints = [...nodeIds];
		return this.getGraphState(graph.id);
	}

	public continueGraph(identifier: string): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		const work = this._work.get(graph.id);
		if (!work || this._states.get(graph.id)?.status !== "paused") {
			throw new Error(`Visual script graph "${graph.name}" is not paused.`);
		}
		work.ignoreBreakpointNodeId = work.currentNodeId;
		this._states.get(graph.id)!.status = "running";
		this._runWork(work, "continue");
		return this.getGraphState(graph.id);
	}

	public stepGraph(identifier: string): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		const work = this._work.get(graph.id);
		if (!work || this._states.get(graph.id)?.status !== "paused") {
			throw new Error(`Visual script graph "${graph.name}" is not paused.`);
		}
		work.ignoreBreakpointNodeId = work.currentNodeId;
		this._states.get(graph.id)!.status = "running";
		this._runWork(work, "step");
		return this.getGraphState(graph.id);
	}

	public getGraphState(identifier: string): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		const state = this._states.get(graph.id)!;
		state.activeStateId = this._activeStates.get(graph.id) ?? null;
		state.variables = Object.fromEntries(graph.variables.map((variable) => [variable.name, cloneValue(this._getVariable(graph, variable, this._work.get(graph.id)))]));
		state.breakpoints = [...(this._breakpoints.get(graph.id) ?? [])];
		return cloneValue(state);
	}

	public getRuntime(offset = 0, limit = 100): { graphs: IVisualScriptGraphRuntimeState[]; trace: { total: number; offset: number; events: IVisualScriptTraceEvent[] } } {
		return { graphs: this._graphs.map((graph) => this.getGraphState(graph.id)), trace: this.getTrace(offset, limit) };
	}

	public getTrace(offset = 0, limit = 100): { total: number; offset: number; events: IVisualScriptTraceEvent[] } {
		const safeOffset = Math.max(0, Math.min(this._trace.length, Math.floor(offset)));
		const safeLimit = Math.max(1, Math.min(512, Math.floor(limit)));
		return { total: this._trace.length, offset: safeOffset, events: cloneValue(this._trace.slice(safeOffset, safeOffset + safeLimit)) };
	}

	public clearTrace(): number {
		const count = this._trace.length;
		this._trace = [];
		return count;
	}

	public setVariable(identifier: string, variableIdentifier: string, value: unknown): IVisualScriptGraphRuntimeState {
		const graph = this._findGraph(identifier);
		const variable = graph.variables.find((candidate) => candidate.id === variableIdentifier || candidate.name === variableIdentifier);
		if (!variable) {
			throw new Error(`Visual script variable "${variableIdentifier}" was not found.`);
		}
		validateVisualScriptValue(value, variable.type, `Visual script variable "${variable.name}" value`);
		this._setVariable(graph, variable, cloneValue(value), this._work.get(graph.id));
		return this.getGraphState(graph.id);
	}

	private _runWork(work: IVisualScriptWork, mode: "continue" | "step" | "complete"): void {
		const state = this._states.get(work.graph.id)!;
		let executedThisCall = 0;
		try {
			while (work.queue.length) {
				if (work.steps >= 1024) {
					throw new Error("Visual script execution exceeded 1,024 steps.");
				}
				const item = work.queue.shift()!;
				const node = work.graph.nodes.find((candidate) => candidate.id === item.nodeId);
				if (!node?.enabled) {
					continue;
				}
				const breakpoint = this._breakpoints.get(work.graph.id)?.has(node.id) && work.ignoreBreakpointNodeId !== node.id;
				if (mode !== "complete" && breakpoint) {
					work.queue.unshift(item);
					work.currentNodeId = node.id;
					state.currentNodeId = node.id;
					state.status = "paused";
					this._traceEvent(work.graph, work.event, node.id, "breakpoint");
					return;
				}
				work.ignoreBreakpointNodeId = null;
				work.currentNodeId = node.id;
				state.currentNodeId = node.id;
				this._traceEvent(work.graph, work.event, node.id, "enter");
				this._executeControlNode(work, node, item.port);
				work.executed.push(node.id);
				work.steps++;
				executedThisCall++;
				this._traceEvent(work.graph, work.event, node.id, "exit");
				if (mode === "step" && executedThisCall >= 1 && work.queue.length) {
					work.currentNodeId = work.queue[0].nodeId;
					state.currentNodeId = work.currentNodeId;
					state.status = "paused";
					return;
				}
			}
			state.status = "running";
			state.currentNodeId = null;
			state.executedNodeIds = [...work.executed];
			state.steps += work.steps;
			this._returnValues.set(work.graph.id, cloneValue(work.returnValue));
			this._work.delete(work.graph.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state.status = "error";
			state.error = message;
			state.currentNodeId = work.currentNodeId;
			state.executedNodeIds = [...work.executed];
			this._traceEvent(work.graph, work.event, work.currentNodeId, "error", message);
			this._work.delete(work.graph.id);
			throw error;
		}
	}

	private _executeControlNode(work: IVisualScriptWork, node: IVisualScriptNodeDefinition, _inputPort: string): void {
		let outputPorts = ["out"];
		switch (node.type) {
			case "branch":
				outputPorts = [this._valueInput(work, node, "condition") === true ? "true" : "false"];
				break;
			case "sequence":
				outputPorts = ["then0", "then1", "then2", "then3"];
				break;
			case "set-variable": {
				const variable = work.graph.variables.find((candidate) => candidate.id === node.variableId)!;
				this._setVariable(work.graph, variable, this._valueInput(work, node, "value"), work);
				break;
			}
			case "set-position":
				this._target(node, true).position.copyFrom(Vector3.FromArray(vector3Value(this._valueInput(work, node, "value"))));
				break;
			case "translate":
				this._target(node, true).position.addInPlace(Vector3.FromArray(vector3Value(this._valueInput(work, node, "value"))));
				break;
			case "set-enabled": {
				const target = this._target(node, false);
				if (typeof target.setEnabled !== "function") {
					throw new Error(`Visual script node "${node.id}" targets a node without setEnabled().`);
				}
				target.setEnabled(this._valueInput(work, node, "value") === true);
				break;
			}
			case "trigger-custom-event":
				for (const graph of this._graphs) {
					if (graph.kind === "flow" && graph.enabled) {
						this.runGraph(graph.id, node.eventName!, this._valueInput(work, node, "payload"), true);
					}
				}
				break;
			case "subgraph":
				this.runGraph(node.subgraphId!, "start", this._valueInput(work, node, "input"), true);
				work.subgraphValues.set(node.id, cloneValue(this._returnValues.get(node.subgraphId!)));
				break;
			case "graph-output":
				work.returnValue = this._valueInput(work, node, "value");
				outputPorts = [];
				break;
			case "log":
				console.info(`[Visual Script ${work.graph.name}]`, this._valueInput(work, node, "value"));
				break;
			case "custom": {
				const unit = this._customUnit(node);
				if (!unit.execute) {
					throw new Error(`Custom visual script unit "${node.unitId}" has no control executor.`);
				}
				const result = unit.execute(this._customContext(work, node)) ?? {};
				const values = result.values ?? {};
				this._validateCustomValues(node, values);
				work.customValues.set(node.id, cloneValue(values));
				outputPorts = result.controlOutputs ?? unit.ports.controlOutputs;
				if (outputPorts.length > 16 || outputPorts.some((port) => !unit.ports.controlOutputs.includes(port))) {
					throw new Error(`Custom visual script unit "${node.unitId}" returned an undeclared control output.`);
				}
				break;
			}
		}
		for (const port of outputPorts) {
			const outgoing = work.graph.edges
				.filter((edge) => edge.kind === "control" && edge.from.nodeId === node.id && edge.from.port === port)
				.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
			work.queue.push(...outgoing.map((edge) => ({ nodeId: edge.to.nodeId, port: edge.to.port })));
		}
	}

	private _valueInput(work: IVisualScriptWork, node: IVisualScriptNodeDefinition, port: string): unknown {
		const edge = work.graph.edges.find((candidate) => candidate.kind === "value" && candidate.to.nodeId === node.id && candidate.to.port === port);
		if (edge) {
			return this._valueOutput(work, edge.from.nodeId, edge.from.port, new Set());
		}
		const inputValues = node.settings?.inputValues as Record<string, unknown> | undefined;
		if (inputValues && Object.prototype.hasOwnProperty.call(inputValues, port)) {
			return this._resolveInlineValue(work, inputValues[port]);
		}
		if (port === "payload") {
			return cloneValue(work.payload);
		}
		if (port === "condition" && node.value !== undefined) {
			return this._resolveInlineValue(work, node.value);
		}
		if (port === "value" || port === "input") {
			return this._resolveInlineValue(work, node.value);
		}
		if (port === "a") {
			return this._resolveInlineValue(work, Array.isArray(node.value) ? node.value[0] : undefined);
		}
		if (port === "b") {
			return this._resolveInlineValue(work, Array.isArray(node.value) ? node.value[1] : undefined);
		}
		if (["x", "y", "z"].includes(port)) {
			return this._resolveInlineValue(work, (node.value as any)?.[port]);
		}
		return undefined;
	}

	private _valueOutput(work: IVisualScriptWork, nodeId: string, port: string, stack: Set<string>): unknown {
		const key = `${nodeId}:${port}`;
		if (stack.has(key)) {
			throw new Error(`Visual script value cycle detected at ${key}.`);
		}
		stack.add(key);
		const node = work.graph.nodes.find((candidate) => candidate.id === nodeId);
		if (!node?.enabled) {
			return undefined;
		}
		const input = (name: string): unknown => {
			const edge = work.graph.edges.find((candidate) => candidate.kind === "value" && candidate.to.nodeId === node.id && candidate.to.port === name);
			return edge ? this._valueOutput(work, edge.from.nodeId, edge.from.port, new Set(stack)) : this._valueInput(work, node, name);
		};
		let result: unknown;
		switch (node.type) {
			case "event-start":
			case "event-update":
			case "event-fixed-update":
			case "event-custom":
			case "graph-input":
				result = cloneValue(work.payload);
				break;
			case "constant":
				result = this._resolveInlineValue(work, node.value);
				break;
			case "expression":
				result = evaluateVisualScriptExpression(node.expression!, Object.fromEntries((node.expressionInputs ?? []).map((name) => [name, input(name)])));
				break;
			case "get-variable": {
				const variable = work.graph.variables.find((candidate) => candidate.id === node.variableId)!;
				result = this._getVariable(work.graph, variable, work);
				break;
			}
			case "get-position":
				result = this._target(node, true).position.asArray();
				break;
			case "add": {
				const left = input("a");
				const right = input("b");
				result = typeof left === "string" || typeof right === "string" ? `${left ?? ""}${right ?? ""}` : numberValue(left) + numberValue(right);
				break;
			}
			case "subtract":
				result = numberValue(input("a")) - numberValue(input("b"));
				break;
			case "multiply":
				result = numberValue(input("a")) * numberValue(input("b"));
				break;
			case "divide": {
				const divisor = numberValue(input("b"));
				if (Math.abs(divisor) < 1e-12) {
					throw new Error(`Visual script divide node "${node.id}" divided by zero.`);
				}
				result = numberValue(input("a")) / divisor;
				break;
			}
			case "compare":
				result = this._compare(input("a"), input("b"), node.operator ?? "equal");
				break;
			case "and":
				result = input("a") === true && input("b") === true;
				break;
			case "or":
				result = input("a") === true || input("b") === true;
				break;
			case "not":
				result = input("value") !== true;
				break;
			case "vector3":
				result = [numberValue(input("x")), numberValue(input("y")), numberValue(input("z"))];
				break;
			case "subgraph":
				result = work.subgraphValues.get(node.id);
				break;
			case "custom": {
				let values = work.customValues.get(node.id);
				if (!values) {
					const unit = this._customUnit(node);
					if (!unit.evaluate) {
						throw new Error(`Custom visual script unit "${node.unitId}" has no value evaluator.`);
					}
					values = unit.evaluate(this._customContext(work, node, stack));
					this._validateCustomValues(node, values);
					work.customValues.set(node.id, cloneValue(values));
				}
				result = values[port];
				break;
			}
			default:
				result = undefined;
		}
		return cloneValue(result);
	}

	private _resolveInlineValue(work: IVisualScriptWork, value: unknown): unknown {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const id = (value as any).variableId;
			if (typeof id === "string") {
				const variable = work.graph.variables.find((candidate) => candidate.id === id);
				if (!variable) {
					throw new Error(`Visual script value references missing variable "${id}".`);
				}
				return this._getVariable(work.graph, variable, work);
			}
		}
		return cloneValue(value);
	}

	private _customUnit(node: IVisualScriptNodeDefinition): IVisualScriptCustomUnitDefinition {
		const unit = customUnits.get(node.unitId!);
		if (!unit) {
			throw new Error(`Custom visual script unit "${node.unitId}" is not registered.`);
		}
		if (JSON.stringify(unit.ports) !== JSON.stringify(getVisualScriptNodePorts(node))) {
			throw new Error(`Custom visual script unit "${node.unitId}" registered ports do not match the authored node.`);
		}
		return unit;
	}

	private _customContext(work: IVisualScriptWork, node: IVisualScriptNodeDefinition, stack = new Set<string>()): IVisualScriptCustomUnitContext {
		return {
			scene: this._scene,
			graph: cloneValue(work.graph),
			node: cloneValue(node),
			event: work.event,
			payload: cloneValue(work.payload),
			input: (port) => {
				const edge = work.graph.edges.find((candidate) => candidate.kind === "value" && candidate.to.nodeId === node.id && candidate.to.port === port);
				return edge ? this._valueOutput(work, edge.from.nodeId, edge.from.port, new Set(stack)) : this._valueInput(work, node, port);
			},
			getVariable: (identifier) => {
				const variable = work.graph.variables.find((candidate) => candidate.id === identifier || candidate.name === identifier);
				if (!variable) {
					throw new Error(`Visual script variable "${identifier}" was not found.`);
				}
				return cloneValue(this._getVariable(work.graph, variable, work));
			},
			setVariable: (identifier, value) => {
				const variable = work.graph.variables.find((candidate) => candidate.id === identifier || candidate.name === identifier);
				if (!variable) {
					throw new Error(`Visual script variable "${identifier}" was not found.`);
				}
				this._setVariable(work.graph, variable, value, work);
			},
		};
	}

	private _validateCustomValues(node: IVisualScriptNodeDefinition, values: Record<string, unknown>): void {
		if (!values || typeof values !== "object" || Array.isArray(values)) {
			throw new Error(`Custom visual script unit "${node.unitId}" returned invalid values.`);
		}
		const ports = getVisualScriptNodePorts(node).valueOutputs;
		for (const [port, value] of Object.entries(values)) {
			if (!ports.includes(port)) {
				throw new Error(`Custom visual script unit "${node.unitId}" returned undeclared value output "${port}".`);
			}
			validateVisualScriptValue(value, "any", `Custom visual script unit "${node.unitId}" output "${port}"`);
		}
	}

	private _getVariable(graph: IVisualScriptGraphDefinition, variable: IVisualScriptVariableDefinition, work?: IVisualScriptWork): unknown {
		switch (variable.scope) {
			case "flow":
				return work?.flowVariables.get(variable.id) ?? cloneValue(variable.defaultValue);
			case "graph":
				return this._graphVariables.get(graph.id)?.get(variable.id) ?? cloneValue(variable.defaultValue);
			case "object": {
				const key = graph.targetNodeId ?? "scene";
				return this._objectVariables.get(key)?.get(variable.name) ?? cloneValue(variable.defaultValue);
			}
			case "scene":
				return this._sceneVariables.get(variable.name) ?? cloneValue(variable.defaultValue);
			case "application":
				return applicationVariables.get(variable.name) ?? cloneValue(variable.defaultValue);
			case "saved": {
				try {
					const encoded = globalThis.localStorage?.getItem(`zvibe:visual-script:${variable.name}`);
					return encoded === null || encoded === undefined ? cloneValue(variable.defaultValue) : JSON.parse(encoded);
				} catch {
					return cloneValue(variable.defaultValue);
				}
			}
		}
	}

	private _setVariable(graph: IVisualScriptGraphDefinition, variable: IVisualScriptVariableDefinition, value: unknown, work?: IVisualScriptWork): void {
		validateVisualScriptValue(value, variable.type, `Visual script variable "${variable.name}" value`, variable.collection);
		switch (variable.scope) {
			case "flow":
				if (!work) {
					throw new Error(`Flow variable "${variable.name}" can only be set during execution.`);
				}
				work.flowVariables.set(variable.id, cloneValue(value));
				break;
			case "graph":
				this._graphVariables.get(graph.id)!.set(variable.id, cloneValue(value));
				break;
			case "object": {
				const key = graph.targetNodeId ?? "scene";
				const values = this._objectVariables.get(key) ?? new Map<string, unknown>();
				values.set(variable.name, cloneValue(value));
				this._objectVariables.set(key, values);
				break;
			}
			case "scene":
				this._sceneVariables.set(variable.name, cloneValue(value));
				break;
			case "application":
				applicationVariables.set(variable.name, cloneValue(value));
				break;
			case "saved":
				globalThis.localStorage?.setItem(`zvibe:visual-script:${variable.name}`, JSON.stringify(value));
				break;
		}
	}

	private _updateStateGraph(graph: IVisualScriptGraphDefinition, event: string, payload: unknown): void {
		const state = this._states.get(graph.id)!;
		if (!graph.enabled) {
			return;
		}
		state.lastEvent = event;
		state.steps++;
		this._traceEvent(graph, event, null, "dispatch");
		try {
			if (state.status === "stopped") {
				state.status = "running";
				this._enterInitialState(graph, payload);
			}
			if (state.status === "error") {
				throw new Error(`Visual script State graph "${graph.name}" is in an error state; stop and start it before dispatching events.`);
			}
			const activeId = this._activeStates.get(graph.id)!;
			const active = graph.states.find((candidate) => candidate.id === activeId)!;
			if (event === "update" && active.onUpdateGraphId) {
				this.runGraph(active.onUpdateGraphId, "state-update", payload, true);
			}
			const transition = graph.transitions
				.filter((candidate) => candidate.fromStateId === activeId && candidate.eventName === event && this._transitionAllowed(graph, candidate))
				.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))[0];
			if (!transition) {
				return;
			}
			if (active.onExitGraphId) {
				this.runGraph(active.onExitGraphId, "state-exit", payload, true);
			}
			const next = graph.states.find((candidate) => candidate.id === transition.toStateId)!;
			this._activeStates.set(graph.id, next.id);
			state.activeStateId = next.id;
			if (next.onEnterGraphId) {
				this.runGraph(next.onEnterGraphId, "state-enter", payload, true);
			}
			this._traceEvent(graph, event, null, "transition", `${active.id}->${next.id}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			state.status = "error";
			state.error = message;
			this._traceEvent(graph, event, null, "error", message);
			throw error;
		}
	}

	private _enterInitialState(graph: IVisualScriptGraphDefinition, payload: unknown): void {
		const initial = graph.states.find((candidate) => candidate.initial)!;
		this._activeStates.set(graph.id, initial.id);
		this._states.get(graph.id)!.activeStateId = initial.id;
		if (initial.onEnterGraphId) {
			this.runGraph(initial.onEnterGraphId, "state-enter", payload ?? { stateId: initial.id }, true);
		}
		this._traceEvent(graph, "start", null, "transition", `entered:${initial.id}`);
	}

	private _transitionAllowed(graph: IVisualScriptGraphDefinition, transition: IVisualScriptTransitionDefinition): boolean {
		if (!transition.conditionVariableId) {
			return true;
		}
		const variable = graph.variables.find((candidate) => candidate.id === transition.conditionVariableId)!;
		const result = this._getVariable(graph, variable) === true;
		return transition.invertCondition ? !result : result;
	}

	private _target(node: IVisualScriptNodeDefinition, requirePosition: boolean): any {
		const target: any = this._scene.getNodeById(node.nodeId!);
		if (!target || (requirePosition && !target.position)) {
			throw new Error(`Visual script node "${node.id}" targets missing/incompatible scene node "${node.nodeId}".`);
		}
		return target;
	}

	private _compare(left: unknown, right: unknown, operator: NonNullable<IVisualScriptNodeDefinition["operator"]>): boolean {
		switch (operator) {
			case "equal":
				return JSON.stringify(left) === JSON.stringify(right);
			case "notEqual":
				return JSON.stringify(left) !== JSON.stringify(right);
			case "less":
				return numberValue(left) < numberValue(right);
			case "lessOrEqual":
				return numberValue(left) <= numberValue(right);
			case "greater":
				return numberValue(left) > numberValue(right);
			case "greaterOrEqual":
				return numberValue(left) >= numberValue(right);
		}
	}

	private _traceEvent(graph: IVisualScriptGraphDefinition, event: string, nodeId: string | null, phase: IVisualScriptTraceEvent["phase"], detail?: string): void {
		const value: IVisualScriptTraceEvent = {
			sequence: ++this._sequence,
			time: this._time,
			graphId: graph.id,
			graphName: graph.name,
			event,
			nodeId,
			phase,
			...(detail ? { detail } : {}),
		};
		this._trace.push(value);
		if (this._trace.length > 512) {
			this._trace.splice(0, this._trace.length - 512);
		}
		this.onTraceObservable.notifyObservers(value);
	}

	private _findGraph(identifier: string): IVisualScriptGraphDefinition {
		const graph = this._graphs.find((candidate) => candidate.id === identifier || candidate.name === identifier);
		if (!graph) {
			throw new Error(`Visual script graph "${identifier}" was not found.`);
		}
		return graph;
	}

	private _createState(graph: IVisualScriptGraphDefinition): IVisualScriptGraphRuntimeState {
		return {
			graphId: graph.id,
			graphName: graph.name,
			kind: graph.kind,
			status: "stopped",
			activeStateId: null,
			currentNodeId: null,
			lastEvent: null,
			executedNodeIds: [],
			variables: {},
			error: null,
			steps: 0,
			breakpoints: [],
		};
	}
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		visualScripts?: VisualScriptRuntime;
	}
}

/** Replaces the scene-owned visual runtime atomically and attaches update/disposal observers. */
export function configureVisualScriptGraphs(scene: Scene): VisualScriptRuntime | undefined {
	const authored = scene.metadata?.babylonEditorVisualScriptGraphs;
	if (!Array.isArray(authored)) {
		scene.visualScripts?.dispose();
		delete scene.visualScripts;
		return undefined;
	}
	const runtime = new VisualScriptRuntime(scene, authored);
	try {
		const updateObserver = scene.onBeforeAnimationsObservable.add(() => runtime.update(Math.min(Math.max(scene.getEngine().getDeltaTime() / 1000, 0), 1)));
		runtime.addDisposeCallback(() => scene.onBeforeAnimationsObservable.remove(updateObserver));
		const physicsObservable = (scene as any).onBeforePhysicsObservable;
		if (physicsObservable) {
			const fixedObserver = physicsObservable.add(() => runtime.fixedUpdate(Math.min(Math.max(scene.getEngine().getDeltaTime() / 1000, 0), 1)));
			runtime.addDisposeCallback(() => physicsObservable.remove(fixedObserver));
		}
		const disposeObserver = scene.onDisposeObservable.add(() => runtime.dispose());
		runtime.addDisposeCallback(() => scene.onDisposeObservable.remove(disposeObserver));
		runtime.startAutoGraphs();
	} catch (error) {
		runtime.dispose();
		throw error;
	}
	const previous = scene.visualScripts;
	scene.visualScripts = runtime;
	previous?.dispose();
	return runtime;
}
