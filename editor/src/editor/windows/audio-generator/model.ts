import {
	IScriptableAudioGeneratorEdge,
	IScriptableAudioGeneratorGraph,
	IScriptableAudioGeneratorNode,
	IScriptableAudioGeneratorTypeSummary,
	normalizeScriptableAudioGeneratorDraftGraph,
	ScriptableAudioGeneratorNodeType,
} from "babylonjs-editor-tools";

export interface IAudioGeneratorHistoryState {
	graph: IScriptableAudioGeneratorGraph;
	canUndo: boolean;
	canRedo: boolean;
	dirty: boolean;
}

function cloneGraph(graph: IScriptableAudioGeneratorGraph): IScriptableAudioGeneratorGraph {
	return structuredClone(graph);
}

function nextId(prefix: string, values: Iterable<string>): string {
	const used = new Set(values);
	for (let index = 1; index <= 10_000; index++) {
		const candidate = `${prefix}-${index}`;
		if (!used.has(candidate)) {
			return candidate;
		}
	}
	throw new Error(`Audio Generator could not allocate a unique ${prefix} id.`);
}

/** Bounded document-local undo/redo history for exact graph snapshots. */
export class AudioGeneratorDocumentHistory {
	private readonly _undo: IScriptableAudioGeneratorGraph[] = [];
	private readonly _redo: IScriptableAudioGeneratorGraph[] = [];
	private _graph: IScriptableAudioGeneratorGraph;
	private _saved: string;

	public constructor(graph: IScriptableAudioGeneratorGraph) {
		this._graph = normalizeScriptableAudioGeneratorDraftGraph(graph);
		this._saved = JSON.stringify(this._graph);
	}

	public get graph(): IScriptableAudioGeneratorGraph {
		return cloneGraph(this._graph);
	}

	public get state(): IAudioGeneratorHistoryState {
		return { graph: this.graph, canUndo: this._undo.length > 0, canRedo: this._redo.length > 0, dirty: JSON.stringify(this._graph) !== this._saved };
	}

	/** Revalidates and commits one complete graph replacement. */
	public replace(graph: IScriptableAudioGeneratorGraph): IAudioGeneratorHistoryState {
		return this.commit((target) => {
			Object.assign(target, cloneGraph(graph));
		});
	}

	/** Validates and commits one complete mutation as one undo operation. */
	public commit(mutation: (graph: IScriptableAudioGeneratorGraph) => void): IAudioGeneratorHistoryState {
		const next = cloneGraph(this._graph);
		mutation(next);
		const normalized = normalizeScriptableAudioGeneratorDraftGraph(next);
		if (JSON.stringify(normalized) === JSON.stringify(this._graph)) {
			return this.state;
		}
		this._undo.push(this._graph);
		if (this._undo.length > 200) {
			this._undo.shift();
		}
		this._redo.splice(0);
		this._graph = normalized;
		return this.state;
	}

	public undo(): IAudioGeneratorHistoryState {
		const graph = this._undo.pop();
		if (graph) {
			this._redo.push(this._graph);
			this._graph = graph;
		}
		return this.state;
	}

	public redo(): IAudioGeneratorHistoryState {
		const graph = this._redo.pop();
		if (graph) {
			this._undo.push(this._graph);
			this._graph = graph;
		}
		return this.state;
	}

	/** Replaces history with the exact just-saved revision. */
	public reset(graph: IScriptableAudioGeneratorGraph): IAudioGeneratorHistoryState {
		this._graph = normalizeScriptableAudioGeneratorDraftGraph(graph);
		this._saved = JSON.stringify(this._graph);
		this._undo.splice(0);
		this._redo.splice(0);
		return this.state;
	}
}

/** Adds one disconnected node with safe defaults and a stable unique id. */
export function addAudioGeneratorNode(
	history: AudioGeneratorDocumentHistory,
	type: ScriptableAudioGeneratorNodeType,
	position: [number, number],
	summary?: IScriptableAudioGeneratorTypeSummary
): IAudioGeneratorHistoryState {
	return history.commit((graph) => {
		const id = nextId(
			type === "custom" ? "custom" : type,
			graph.nodes.map((node) => node.id)
		);
		const data =
			type === "custom"
				? { generatorType: summary?.builtIn === false ? summary.id : "project.generator", dataVersion: summary?.dataVersion ?? 1, parameters: summary?.defaultData ?? {} }
				: structuredClone(summary?.defaultData ?? {});
		graph.nodes.push({ id, name: summary?.displayName ?? (type === "custom" ? "Project Generator" : type), type, position, enabled: true, data });
	});
}

/** Removes one non-output node and all of its incident connections atomically. */
export function removeAudioGeneratorNode(history: AudioGeneratorDocumentHistory, nodeId: string): IAudioGeneratorHistoryState {
	return history.commit((graph) => {
		if (nodeId === graph.outputNodeId) {
			throw new Error("The Audio Generator output node cannot be removed.");
		}
		if (!graph.nodes.some((node) => node.id === nodeId)) {
			throw new Error(`Audio Generator node was not found: ${nodeId}.`);
		}
		graph.nodes = graph.nodes.filter((node) => node.id !== nodeId);
		graph.edges = graph.edges.filter((edge) => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId);
	});
}

/** Connects exact ports and lets the shared topology validator reject cycles or illegal inputs. */
export function connectAudioGeneratorNodes(history: AudioGeneratorDocumentHistory, sourceNodeId: string, targetNodeId: string): IAudioGeneratorHistoryState {
	return history.commit((graph) => {
		if (!graph.nodes.some((node) => node.id === sourceNodeId) || !graph.nodes.some((node) => node.id === targetNodeId)) {
			throw new Error("Both Audio Generator connection nodes must exist.");
		}
		if (graph.edges.some((edge) => edge.sourceNodeId === sourceNodeId && edge.targetNodeId === targetNodeId)) {
			throw new Error("That Audio Generator connection already exists.");
		}
		const incoming = graph.edges.filter((edge) => edge.targetNodeId === targetNodeId);
		const id = nextId(
			"edge",
			graph.edges.map((edge) => edge.id)
		);
		const edge: IScriptableAudioGeneratorEdge = { id, sourceNodeId, targetNodeId, order: incoming.length, gain: 1 };
		const target = graph.nodes.find((node) => node.id === targetNodeId)!;
		if (target.type === "sequence") {
			edge.durationSeconds = 1;
		}
		graph.edges.push(edge);
	});
}

export function removeAudioGeneratorEdge(history: AudioGeneratorDocumentHistory, edgeId: string): IAudioGeneratorHistoryState {
	return history.commit((graph) => {
		if (!graph.edges.some((edge) => edge.id === edgeId)) {
			throw new Error(`Audio Generator edge was not found: ${edgeId}.`);
		}
		graph.edges = graph.edges.filter((edge) => edge.id !== edgeId);
	});
}

export function updateAudioGeneratorNode(
	history: AudioGeneratorDocumentHistory,
	nodeId: string,
	mutation: (node: IScriptableAudioGeneratorNode) => void
): IAudioGeneratorHistoryState {
	return history.commit((graph) => {
		const node = graph.nodes.find((candidate) => candidate.id === nodeId);
		if (!node) {
			throw new Error(`Audio Generator node was not found: ${nodeId}.`);
		}
		mutation(node);
	});
}

export function updateAudioGeneratorEdge(
	history: AudioGeneratorDocumentHistory,
	edgeId: string,
	mutation: (edge: IScriptableAudioGeneratorEdge) => void
): IAudioGeneratorHistoryState {
	return history.commit((graph) => {
		const edge = graph.edges.find((candidate) => candidate.id === edgeId);
		if (!edge) {
			throw new Error(`Audio Generator edge was not found: ${edgeId}.`);
		}
		mutation(edge);
	});
}
