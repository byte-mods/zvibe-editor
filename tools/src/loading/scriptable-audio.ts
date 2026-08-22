/**
 * Portable Scriptable Audio Generator graph, project-script registry, and deterministic block renderer.
 * The renderer has no DOM dependency; browser playback adapters build on this contract in `sound.ts`.
 */

export const SCRIPTABLE_AUDIO_GRAPH_VERSION = 1;
export const SCRIPTABLE_AUDIO_GRAPH_SUFFIX = ".audio-generator.json";

export const SCRIPTABLE_AUDIO_LIMITS = {
	maximumNodes: 128,
	maximumEdges: 256,
	maximumChannels: 8,
	maximumDurationSeconds: 3_600,
	maximumStaticSampleValues: 16_777_216,
	maximumDataBytes: 65_536,
	maximumDataEntries: 4_096,
	maximumDataDepth: 16,
	maximumSourceSampleValues: 134_217_728,
	maximumBlockFrames: 16_384,
} as const;

export type ScriptableAudioGeneratorNodeType = "output" | "audioClip" | "oscillator" | "noise" | "gain" | "mix" | "sequence" | "random" | "custom";
export type ScriptableAudioOscillatorWaveform = "sine" | "square" | "sawtooth" | "triangle";

/** One persisted graph node; `data` is normalized according to `type`. */
export interface IScriptableAudioGeneratorNode {
	id: string;
	name: string;
	type: ScriptableAudioGeneratorNodeType;
	position: [number, number];
	enabled: boolean;
	data: Record<string, unknown>;
}

/** One ordered, gain-adjustable audio connection; timing is used by sequence nodes. */
export interface IScriptableAudioGeneratorEdge {
	id: string;
	sourceNodeId: string;
	targetNodeId: string;
	order: number;
	gain: number;
	startSeconds?: number;
	durationSeconds?: number;
}

/** Canonical version-1 Audio Generator asset shared by editor preview and exported players. */
export interface IScriptableAudioGeneratorGraph {
	version: 1;
	revision: number;
	name: string;
	sampleRate: number;
	channels: number;
	durationSeconds: number;
	streaming: boolean;
	seed: number;
	outputNodeId: string;
	nodes: IScriptableAudioGeneratorNode[];
	edges: IScriptableAudioGeneratorEdge[];
}

/** Exact leaf evidence used by asset registries and build caches. */
export interface IScriptableAudioRuntimeFingerprintDependency {
	path: string;
	contentHash: string;
	sizeBytes: number;
}

/** Decoded planar PCM supplied by the browser-specific clip loader. */
export interface IScriptableAudioClipSource {
	sampleRate: number;
	channels: readonly Float32Array[];
}

/** Immutable output format supplied to project generator callbacks. */
export interface IScriptableAudioGeneratorFormat {
	sampleRate: number;
	channels: number;
}

/** Validation/create context containing only authored custom parameters and the output format. */
export interface IScriptableAudioGeneratorValidationContext<TData extends Record<string, unknown> = Record<string, unknown>> {
	readonly nodeId: string;
	readonly format: IScriptableAudioGeneratorFormat;
	readonly data: TData;
}

/** One synchronous block-processing request with copied inputs and caller-owned output channels. */
export interface IScriptableAudioGeneratorProcessContext<
	TData extends Record<string, unknown> = Record<string, unknown>,
> extends IScriptableAudioGeneratorValidationContext<TData> {
	readonly startFrame: number;
	readonly frameCount: number;
	readonly inputs: readonly (readonly Float32Array[])[];
	readonly output: readonly Float32Array[];
}

/** Optional custom callback result used to publish partial completion without sentinel samples. */
export interface IScriptableAudioGeneratorProcessResult {
	processedFrames?: number;
	isFinished?: boolean;
}

/** Project TypeScript implements this lifecycle to provide a custom graph node without serializing executable code. */
export interface IScriptableAudioGeneratorDefinition<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown> {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly dataVersion: number;
	setDefaultValues?(): TData;
	validate?(context: IScriptableAudioGeneratorValidationContext<TData>): true | string;
	create?(context: IScriptableAudioGeneratorValidationContext<TData>): TState;
	process(context: IScriptableAudioGeneratorProcessContext<TData>, state: TState): void | IScriptableAudioGeneratorProcessResult;
	setPosition?(frame: number, context: IScriptableAudioGeneratorValidationContext<TData>, state: TState): void;
	destroy?(state: TState): void;
}

/** Non-executable generator metadata safe to expose through the editor and MCP. */
export interface IScriptableAudioGeneratorTypeSummary {
	id: string;
	displayName: string;
	description: string;
	dataVersion: number;
	builtIn: boolean;
	supportsSeeking: boolean;
	defaultData: Record<string, unknown>;
}

/** Bounded runtime warning/error tied to the exact graph node and source frame. */
export interface IScriptableAudioRuntimeDiagnostic {
	nodeId: string;
	severity: "warning" | "error";
	message: string;
	frame: number;
}

/** Fully materialized non-streaming planar PCM plus completion and diagnostic evidence. */
export interface IScriptableAudioRenderResult {
	sampleRate: number;
	channels: Float32Array[];
	frameCount: number;
	durationSeconds: number;
	finishedNodeIds: string[];
	diagnostics: IScriptableAudioRuntimeDiagnostic[];
}

/** Host dependency used to resolve project-relative AudioClip leaves before playback publication. */
export interface ICreateScriptableAudioRuntimeOptions {
	loadAudioClip(path: string): Promise<IScriptableAudioClipSource>;
}

/** Private lifecycle state for one initialized project generator node. */
interface ICustomRuntimeState {
	definition: IScriptableAudioGeneratorDefinition;
	state: unknown;
	positionFrame: number;
	finished: boolean;
}

const definitions = new Map<string, IScriptableAudioGeneratorDefinition>();
const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Requires a non-array object before any property access. */
function asRecord(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(message);
	}
	return value as Record<string, unknown>;
}

/** Applies the common finite/range/integer contract used by every numeric asset field. */
function finiteNumber(value: unknown, name: string, minimum: number, maximum: number, integer = false): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
		throw new Error(`${name} must be ${integer ? "an integer" : "a finite number"} from ${minimum} through ${maximum}.`);
	}
	return value;
}

/** Rejects empty or excessive persisted identifiers and display strings. */
function boundedString(value: unknown, name: string, maximum = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${name} must contain 1 through ${maximum} characters.`);
	}
	return value;
}

/** Keeps version-1 records closed so misspelled authoring never becomes passive metadata. */
function assertAllowedKeys(source: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const unknown = Object.keys(source).find((key) => !allowed.includes(key));
	if (unknown) {
		throw new Error(`${name} contains unsupported field "${unknown}".`);
	}
}

/** Reads an optional bounded number while publishing a canonical default. */
function optionalNumber(source: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
	return source[key] === undefined ? fallback : finiteNumber(source[key], key, minimum, maximum);
}

/** Reads an optional boolean without truthy coercion. */
function optionalBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
	if (source[key] === undefined) {
		return fallback;
	}
	if (typeof source[key] !== "boolean") {
		throw new Error(`${key} must be a boolean.`);
	}
	return source[key];
}

/** Deep-clones safe JSON while bounding depth, entries, bytes, and prototype-sensitive keys. */
function cloneGeneratorData(value: unknown): Record<string, unknown> {
	let entries = 0;
	const visit = (candidate: unknown, depth: number): unknown => {
		if (depth > SCRIPTABLE_AUDIO_LIMITS.maximumDataDepth) {
			throw new Error(`Generator data is limited to ${SCRIPTABLE_AUDIO_LIMITS.maximumDataDepth} nested levels.`);
		}
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
			return candidate;
		}
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) {
				throw new Error("Generator data numbers must be finite.");
			}
			return candidate;
		}
		if (Array.isArray(candidate)) {
			entries += candidate.length;
			if (entries > SCRIPTABLE_AUDIO_LIMITS.maximumDataEntries) {
				throw new Error(`Generator data is limited to ${SCRIPTABLE_AUDIO_LIMITS.maximumDataEntries} entries.`);
			}
			return candidate.map((item) => visit(item, depth + 1));
		}
		if (candidate && typeof candidate === "object") {
			const result: Record<string, unknown> = {};
			for (const [key, item] of Object.entries(candidate)) {
				if (unsafeKeys.has(key)) {
					throw new Error(`Generator data key "${key}" is not allowed.`);
				}
				entries++;
				if (entries > SCRIPTABLE_AUDIO_LIMITS.maximumDataEntries) {
					throw new Error(`Generator data is limited to ${SCRIPTABLE_AUDIO_LIMITS.maximumDataEntries} entries.`);
				}
				result[key] = visit(item, depth + 1);
			}
			return result;
		}
		throw new Error("Generator data supports only JSON-compatible values.");
	};
	const result = visit(asRecord(value ?? {}, "Generator node data must be an object."), 0) as Record<string, unknown>;
	if (new TextEncoder().encode(JSON.stringify(result)).length > SCRIPTABLE_AUDIO_LIMITS.maximumDataBytes) {
		throw new Error(`Generator node data is limited to ${SCRIPTABLE_AUDIO_LIMITS.maximumDataBytes} UTF-8 bytes.`);
	}
	return result;
}

/** Restricts AudioClip leaves to portable project assets rather than URLs or traversal aliases. */
function normalizeProjectAudioPath(value: unknown): string {
	const path = boundedString(value, "AudioClip path", 1_024).replace(/\\/g, "/");
	if (
		path.startsWith("/") ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
		/%(?:2e|2f|5c)/i.test(path) ||
		path.split("/").includes("..") ||
		!/\.(?:mp3|ogg|wav|wave|flac|m4a)$/i.test(path)
	) {
		throw new Error("AudioClip paths must be project-relative supported audio assets without parent traversal.");
	}
	return path;
}

/** Canonicalizes the exact built-in/custom data shape for one node type. */
function normalizeNodeData(type: ScriptableAudioGeneratorNodeType, id: string, value: unknown): Record<string, unknown> {
	const source = cloneGeneratorData(value ?? {});
	switch (type) {
		case "audioClip": {
			assertAllowedKeys(source, ["path", "loop", "gain", "startSeconds", "endSeconds"], `AudioClip node "${id}" data`);
			const startSeconds = optionalNumber(source, "startSeconds", 0, 0, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds);
			const endSeconds = source.endSeconds === undefined ? undefined : finiteNumber(source.endSeconds, "endSeconds", 0.001, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds);
			if (endSeconds !== undefined && endSeconds <= startSeconds) {
				throw new Error(`AudioClip node "${id}" endSeconds must be greater than startSeconds.`);
			}
			return {
				path: normalizeProjectAudioPath(source.path),
				loop: optionalBoolean(source, "loop", false),
				gain: optionalNumber(source, "gain", 1, -16, 16),
				startSeconds,
				...(endSeconds === undefined ? {} : { endSeconds }),
			};
		}
		case "oscillator": {
			assertAllowedKeys(source, ["waveform", "frequency", "amplitude", "phase"], `Oscillator node "${id}" data`);
			const waveform = source.waveform ?? "sine";
			if (!["sine", "square", "sawtooth", "triangle"].includes(String(waveform))) {
				throw new Error(`Oscillator node "${id}" waveform must be sine, square, sawtooth, or triangle.`);
			}
			return {
				waveform,
				frequency: optionalNumber(source, "frequency", 440, 0, 96_000),
				amplitude: optionalNumber(source, "amplitude", 0.25, 0, 16),
				phase: optionalNumber(source, "phase", 0, -Math.PI * 2, Math.PI * 2),
			};
		}
		case "noise":
			assertAllowedKeys(source, ["amplitude", "seedOffset"], `Noise node "${id}" data`);
			return {
				amplitude: optionalNumber(source, "amplitude", 0.1, 0, 16),
				seedOffset: source.seedOffset === undefined ? 0 : finiteNumber(source.seedOffset, "seedOffset", 0, 0x7fffffff, true),
			};
		case "gain":
		case "output":
			assertAllowedKeys(source, ["gain"], `${type} node "${id}" data`);
			return { gain: optionalNumber(source, "gain", 1, -16, 16) };
		case "mix":
			assertAllowedKeys(source, ["normalize"], `Mix node "${id}" data`);
			return { normalize: optionalBoolean(source, "normalize", false) };
		case "sequence":
			assertAllowedKeys(source, [], `Sequence node "${id}" data`);
			return {};
		case "random": {
			assertAllowedKeys(source, ["intervalSeconds", "gainMin", "gainMax"], `Random node "${id}" data`);
			const gainMin = optionalNumber(source, "gainMin", 1, 0, 16);
			return {
				intervalSeconds: optionalNumber(source, "intervalSeconds", 1, 0.001, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds),
				gainMin,
				gainMax: optionalNumber(source, "gainMax", 1, gainMin, 16),
			};
		}
		case "custom": {
			assertAllowedKeys(source, ["generatorType", "dataVersion", "parameters"], `Custom node "${id}" data`);
			const generatorType = boundedString(source.generatorType, `Custom node "${id}" generatorType`, 128);
			if (!safeIdentifier.test(generatorType)) {
				throw new Error(`Custom node "${id}" generatorType contains unsupported characters.`);
			}
			return {
				generatorType,
				dataVersion: finiteNumber(source.dataVersion, `Custom node "${id}" dataVersion`, 1, 100_000, true),
				parameters: cloneGeneratorData(source.parameters ?? {}),
			};
		}
	}
}

/** Normalizes one closed graph node and its type-specific data. */
function normalizeNode(value: unknown): IScriptableAudioGeneratorNode {
	const source = asRecord(value, "Audio Generator nodes must be objects.");
	assertAllowedKeys(source, ["id", "name", "type", "position", "enabled", "data"], "Audio Generator node");
	const type = source.type;
	if (!["output", "audioClip", "oscillator", "noise", "gain", "mix", "sequence", "random", "custom"].includes(String(type))) {
		throw new Error(`Unknown Audio Generator node type "${String(type)}".`);
	}
	const id = boundedString(source.id, "Audio Generator node id", 128);
	if (!safeIdentifier.test(id)) {
		throw new Error(`Audio Generator node id "${id}" contains unsupported characters.`);
	}
	const position = source.position;
	if (!Array.isArray(position) || position.length !== 2) {
		throw new Error(`Audio Generator node "${id}" position must contain two numbers.`);
	}
	if (typeof source.enabled !== "boolean") {
		throw new Error(`Audio Generator node "${id}" enabled must be a boolean.`);
	}
	const data = normalizeNodeData(type as ScriptableAudioGeneratorNodeType, id, source.data);
	return {
		id,
		name: boundedString(source.name ?? id, `Audio Generator node "${id}" name`),
		type: type as ScriptableAudioGeneratorNodeType,
		position: [finiteNumber(position[0], `Node "${id}" position X`, -1_000_000, 1_000_000), finiteNumber(position[1], `Node "${id}" position Y`, -1_000_000, 1_000_000)],
		enabled: source.enabled,
		data,
	};
}

/** Normalizes one closed connection including optional sequence timing. */
function normalizeEdge(value: unknown, index: number): IScriptableAudioGeneratorEdge {
	const source = asRecord(value, "Audio Generator edges must be objects.");
	assertAllowedKeys(source, ["id", "sourceNodeId", "targetNodeId", "order", "gain", "startSeconds", "durationSeconds"], "Audio Generator edge");
	const edge: IScriptableAudioGeneratorEdge = {
		id: boundedString(source.id, "Audio Generator edge id", 128),
		sourceNodeId: boundedString(source.sourceNodeId, "Audio Generator edge sourceNodeId", 128),
		targetNodeId: boundedString(source.targetNodeId, "Audio Generator edge targetNodeId", 128),
		order: source.order === undefined ? index : finiteNumber(source.order, "Audio Generator edge order", 0, 255, true),
		gain: source.gain === undefined ? 1 : finiteNumber(source.gain, "Audio Generator edge gain", -16, 16),
	};
	if (source.startSeconds !== undefined) {
		edge.startSeconds = finiteNumber(source.startSeconds, "Audio Generator edge startSeconds", 0, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds);
	}
	if (source.durationSeconds !== undefined) {
		edge.durationSeconds = finiteNumber(source.durationSeconds, "Audio Generator edge durationSeconds", 0.001, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds);
	}
	return edge;
}

/** Enforces endpoint ownership, arity, one output, and acyclic audio flow. */
function validateTopology(graph: IScriptableAudioGeneratorGraph, allowIncomplete = false): void {
	const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
	if (nodes.size !== graph.nodes.length) {
		throw new Error("Audio Generator node ids must be unique.");
	}
	if (new Set(graph.edges.map((edge) => edge.id)).size !== graph.edges.length) {
		throw new Error("Audio Generator edge ids must be unique.");
	}
	const output = nodes.get(graph.outputNodeId);
	if (!output || output.type !== "output") {
		throw new Error("Audio Generator outputNodeId must identify an output node.");
	}
	if (graph.nodes.filter((node) => node.type === "output").length !== 1) {
		throw new Error("Audio Generator graphs require exactly one output node.");
	}
	const incoming = new Map<string, number>();
	const outgoing = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (!nodes.has(edge.sourceNodeId) || !nodes.has(edge.targetNodeId)) {
			throw new Error(`Audio Generator edge "${edge.id}" references an unknown node.`);
		}
		if (edge.sourceNodeId === edge.targetNodeId) {
			throw new Error(`Audio Generator edge "${edge.id}" cannot connect a node to itself.`);
		}
		incoming.set(edge.targetNodeId, (incoming.get(edge.targetNodeId) ?? 0) + 1);
		outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
	}
	for (const node of graph.nodes) {
		const count = incoming.get(node.id) ?? 0;
		if (["audioClip", "oscillator", "noise"].includes(node.type) && count > 0) {
			throw new Error(`Audio Generator ${node.type} node "${node.id}" cannot accept input edges.`);
		}
		if (["output", "gain"].includes(node.type) && (count > 1 || (!allowIncomplete && count !== 1))) {
			throw new Error(`Audio Generator ${node.type} node "${node.id}" requires exactly one input edge.`);
		}
		if (!allowIncomplete && ["mix", "sequence", "random"].includes(node.type) && count < 1) {
			throw new Error(`Audio Generator ${node.type} node "${node.id}" requires at least one input edge.`);
		}
		if (node.type === "output" && (outgoing.get(node.id)?.length ?? 0) > 0) {
			throw new Error("The Audio Generator output node cannot feed another node.");
		}
	}
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) {
			throw new Error("Audio Generator graphs cannot contain feedback cycles.");
		}
		if (visited.has(id)) {
			return;
		}
		visiting.add(id);
		for (const target of outgoing.get(id) ?? []) {
			visit(target);
		}
		visiting.delete(id);
		visited.add(id);
	};
	graph.nodes.forEach((node) => visit(node.id));
}

function normalizeGraph(value: unknown, allowIncomplete: boolean): IScriptableAudioGeneratorGraph {
	const source = asRecord(value, "Audio Generator asset must be an object.");
	assertAllowedKeys(
		source,
		["version", "revision", "name", "sampleRate", "channels", "durationSeconds", "streaming", "seed", "outputNodeId", "nodes", "edges"],
		"Audio Generator asset"
	);
	if (source.version !== SCRIPTABLE_AUDIO_GRAPH_VERSION) {
		throw new Error(`Audio Generator asset version must be ${SCRIPTABLE_AUDIO_GRAPH_VERSION}.`);
	}
	if (!Array.isArray(source.nodes) || !Array.isArray(source.edges)) {
		throw new Error("Audio Generator nodes and edges must be arrays.");
	}
	if (typeof source.streaming !== "boolean") {
		throw new Error("Audio Generator streaming must be a boolean.");
	}
	if (source.nodes.length < 1 || source.nodes.length > SCRIPTABLE_AUDIO_LIMITS.maximumNodes) {
		throw new Error(`Audio Generator graphs support 1 through ${SCRIPTABLE_AUDIO_LIMITS.maximumNodes} nodes.`);
	}
	if (source.edges.length > SCRIPTABLE_AUDIO_LIMITS.maximumEdges) {
		throw new Error(`Audio Generator graphs support at most ${SCRIPTABLE_AUDIO_LIMITS.maximumEdges} edges.`);
	}
	const graph: IScriptableAudioGeneratorGraph = {
		version: 1,
		revision: finiteNumber(source.revision, "Audio Generator revision", 1, Number.MAX_SAFE_INTEGER, true),
		name: boundedString(source.name, "Audio Generator name"),
		sampleRate: finiteNumber(source.sampleRate, "Audio Generator sampleRate", 8_000, 192_000, true),
		channels: finiteNumber(source.channels, "Audio Generator channels", 1, SCRIPTABLE_AUDIO_LIMITS.maximumChannels, true),
		durationSeconds: finiteNumber(source.durationSeconds, "Audio Generator durationSeconds", 0.001, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds),
		streaming: source.streaming,
		seed: finiteNumber(source.seed, "Audio Generator seed", 0, 0x7fffffff, true),
		outputNodeId: boundedString(source.outputNodeId, "Audio Generator outputNodeId", 128),
		nodes: source.nodes.map(normalizeNode),
		edges: source.edges.map(normalizeEdge),
	};
	if (!graph.streaming && Math.ceil(graph.durationSeconds * graph.sampleRate) * graph.channels > SCRIPTABLE_AUDIO_LIMITS.maximumStaticSampleValues) {
		throw new Error(
			`Non-streaming Audio Generator output is limited to ${SCRIPTABLE_AUDIO_LIMITS.maximumStaticSampleValues} sample values; enable streaming or reduce duration, rate, or channels.`
		);
	}
	validateTopology(graph, allowIncomplete);
	return graph;
}

/** Normalizes and strictly validates one persisted version-1 graph. */
export function normalizeScriptableAudioGeneratorGraph(value: unknown): IScriptableAudioGeneratorGraph {
	return normalizeGraph(value, false);
}

/** Normalizes an editor draft while retaining all safety checks except required-input completeness. */
export function normalizeScriptableAudioGeneratorDraftGraph(value: unknown): IScriptableAudioGeneratorGraph {
	return normalizeGraph(value, true);
}

/** Returns validation errors without mutating or throwing into editor inspection paths. */
export function validateScriptableAudioGeneratorGraph(value: unknown): { valid: boolean; errors: string[]; graph: IScriptableAudioGeneratorGraph | null } {
	try {
		return { valid: true, errors: [], graph: normalizeScriptableAudioGeneratorGraph(value) };
	} catch (error) {
		return { valid: false, errors: [error instanceof Error ? error.message : String(error)], graph: null };
	}
}

/** Returns the exact sorted project-relative AudioClip leaves that affect generated output. */
export function getScriptableAudioDependencyPaths(value: unknown): string[] {
	const graph = normalizeScriptableAudioGeneratorGraph(value);
	return [...new Set(graph.nodes.filter((node) => node.type === "audioClip").map((node) => String(node.data.path)))].sort((left, right) => left.localeCompare(right));
}

/** Serializes the canonical payload hashed by registries and both build pipelines. */
export function serializeScriptableAudioRuntimeFingerprintInput(contentHash: string, dependencies: readonly IScriptableAudioRuntimeFingerprintDependency[]): string {
	return JSON.stringify({
		version: 1,
		kind: "audio-generator",
		contentHash,
		dependencies: [...dependencies]
			.map((dependency) => ({ path: dependency.path, contentHash: dependency.contentHash, sizeBytes: dependency.sizeBytes }))
			.sort((left, right) => left.path.localeCompare(right.path)),
	});
}

/** Creates a small audible graph that is immediately editable and previewable. */
export function createDefaultScriptableAudioGeneratorGraph(name = "New Audio Generator"): IScriptableAudioGeneratorGraph {
	return {
		version: 1,
		revision: 1,
		name,
		sampleRate: 48_000,
		channels: 2,
		durationSeconds: 1,
		streaming: false,
		seed: 1,
		outputNodeId: "output",
		nodes: [
			{ id: "oscillator", name: "Sine Oscillator", type: "oscillator", position: [80, 120], enabled: true, data: { waveform: "sine", frequency: 440, amplitude: 0.25 } },
			{ id: "output", name: "Output", type: "output", position: [420, 120], enabled: true, data: {} },
		],
		edges: [{ id: "oscillator-output", sourceNodeId: "oscillator", targetNodeId: "output", order: 0, gain: 1 }],
	};
}

/** Validates project callback metadata and default JSON at registration time. */
function validateDefinition(definition: IScriptableAudioGeneratorDefinition): void {
	if (!definition || typeof definition !== "object" || !safeIdentifier.test(definition.id)) {
		throw new Error("Scriptable Audio generator ids must contain 1 through 128 safe identifier characters.");
	}
	finiteNumber(definition.dataVersion, `Scriptable Audio generator "${definition.id}" dataVersion`, 1, 100_000, true);
	if (definition.displayName !== undefined && (typeof definition.displayName !== "string" || definition.displayName.length > 256)) {
		throw new Error(`Scriptable Audio generator "${definition.id}" displayName must be at most 256 characters.`);
	}
	if (definition.description !== undefined && (typeof definition.description !== "string" || definition.description.length > 2_048)) {
		throw new Error(`Scriptable Audio generator "${definition.id}" description must be at most 2048 characters.`);
	}
	if (typeof definition.process !== "function") {
		throw new Error(`Scriptable Audio generator "${definition.id}" must implement process.`);
	}
	cloneGeneratorData(definition.setDefaultValues?.() ?? {});
}

/** Registers or hot-replaces one project-defined Scriptable Audio node type. */
export function registerScriptableAudioGenerator<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown>(
	definition: IScriptableAudioGeneratorDefinition<TData, TState>
): () => void {
	validateDefinition(definition as IScriptableAudioGeneratorDefinition);
	definitions.set(definition.id, definition as IScriptableAudioGeneratorDefinition);
	return () => {
		if (definitions.get(definition.id) === definition) {
			definitions.delete(definition.id);
		}
	};
}

/** Lists non-executable built-in and project generator metadata for editor and MCP discovery. */
export function listScriptableAudioGeneratorTypes(): IScriptableAudioGeneratorTypeSummary[] {
	const builtIns: Array<Omit<IScriptableAudioGeneratorTypeSummary, "builtIn" | "supportsSeeking" | "dataVersion">> = [
		{
			id: "audioClip",
			displayName: "Audio Clip",
			description: "Asynchronously decoded project AudioClip leaf.",
			defaultData: { path: "assets/audio.wav", loop: false, gain: 1 },
		},
		{
			id: "oscillator",
			displayName: "Oscillator",
			description: "Deterministic sine, square, sawtooth, or triangle source.",
			defaultData: { waveform: "sine", frequency: 440, amplitude: 0.25 },
		},
		{ id: "noise", displayName: "Noise", description: "Seek-stable deterministic white-noise source.", defaultData: { amplitude: 0.1, seedOffset: 0 } },
		{ id: "gain", displayName: "Gain", description: "Multiplies one nested generator input.", defaultData: { gain: 1 } },
		{ id: "mix", displayName: "Mix", description: "Sums nested inputs with optional normalization.", defaultData: { normalize: false } },
		{ id: "sequence", displayName: "Sequence", description: "Schedules nested inputs using ordered edge timing.", defaultData: {} },
		{
			id: "random",
			displayName: "Random Container",
			description: "Selects one nested input deterministically for each interval.",
			defaultData: { intervalSeconds: 1, gainMin: 1, gainMax: 1 },
		},
		{ id: "output", displayName: "Output", description: "The graph's single final output.", defaultData: { gain: 1 } },
	];
	return [
		...builtIns.map((summary) => ({ ...summary, dataVersion: 1, builtIn: true, supportsSeeking: true })),
		...[...definitions.values()].map((definition) => ({
			id: definition.id,
			displayName: definition.displayName?.trim() || definition.id,
			description: definition.description?.trim() || "",
			dataVersion: definition.dataVersion,
			builtIn: false,
			supportsSeeking: typeof definition.setPosition === "function",
			defaultData: cloneGeneratorData(definition.setDefaultValues?.() ?? {}),
		})),
	].sort((left, right) => Number(left.builtIn) - Number(right.builtIn) || left.id.localeCompare(right.id));
}

/** Reads already-normalized numeric data defensively for hot-reload compatibility. */
function readNumber(data: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

/** Allocates planar channels for one bounded render block. */
function allocateChannels(channels: number, frames: number): Float32Array[] {
	return Array.from({ length: channels }, () => new Float32Array(frames));
}

/** Produces a fast deterministic 32-bit mix suitable for seek-stable noise and selection. */
function stableHash(value: number): number {
	let result = value | 0;
	result = Math.imul(result ^ (result >>> 16), 0x45d9f3b);
	result = Math.imul(result ^ (result >>> 16), 0x45d9f3b);
	return (result ^ (result >>> 16)) >>> 0;
}

/** FNV-1a hashes stable node ids into deterministic generator seeds. */
function stringHash(value: string): number {
	let result = 2166136261;
	for (let index = 0; index < value.length; index++) {
		result = Math.imul(result ^ value.charCodeAt(index), 16777619);
	}
	return result >>> 0;
}

/** Prepared graph runtime. One instance owns custom-node state and must not be rendered concurrently. */
export class ScriptableAudioGeneratorRuntime {
	public readonly graph: IScriptableAudioGeneratorGraph;

	private readonly _nodes: Map<string, IScriptableAudioGeneratorNode>;
	private readonly _incoming: Map<string, IScriptableAudioGeneratorEdge[]>;
	private readonly _clips: Map<string, IScriptableAudioClipSource>;
	private readonly _custom = new Map<string, ICustomRuntimeState>();
	private readonly _diagnostics: IScriptableAudioRuntimeDiagnostic[] = [];
	private readonly _finishedNodeIds = new Set<string>();
	private _disposed = false;
	private _rendering = false;

	/** Builds immutable lookup tables and initializes every custom node transactionally. */
	private constructor(graph: IScriptableAudioGeneratorGraph, clips: Map<string, IScriptableAudioClipSource>) {
		this.graph = graph;
		this._clips = clips;
		this._nodes = new Map(graph.nodes.map((node) => [node.id, node]));
		this._incoming = new Map();
		for (const edge of graph.edges) {
			this._incoming.set(edge.targetNodeId, [...(this._incoming.get(edge.targetNodeId) ?? []), edge]);
		}
		for (const edges of this._incoming.values()) {
			edges.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
		}
		try {
			for (const node of graph.nodes.filter((candidate) => candidate.type === "custom")) {
				const generatorType = String(node.data.generatorType);
				const definition = definitions.get(generatorType);
				if (!definition) {
					throw new Error(`Custom Scriptable Audio generator "${generatorType}" is not registered.`);
				}
				if (node.data.dataVersion !== definition.dataVersion) {
					throw new Error(
						`Custom Scriptable Audio node "${node.id}" dataVersion ${String(node.data.dataVersion)} does not match registered generator version ${definition.dataVersion}.`
					);
				}
				const context = this._validationContext(node);
				const validation = definition.validate?.(context);
				if (validation !== undefined && validation !== true) {
					throw new Error(`Custom Scriptable Audio node "${node.id}" is invalid: ${validation}`);
				}
				this._custom.set(node.id, { definition, state: definition.create?.(context), positionFrame: 0, finished: false });
			}
		} catch (error) {
			for (const runtime of [...this._custom.values()].reverse()) {
				try {
					runtime.definition.destroy?.(runtime.state);
				} catch {
					// Cleanup errors never replace the actionable validation/create failure.
				}
			}
			this._custom.clear();
			throw error;
		}
	}

	/** Loads every nested AudioClip before publishing a playable runtime. */
	public static async CreateAsync(value: unknown, options: ICreateScriptableAudioRuntimeOptions): Promise<ScriptableAudioGeneratorRuntime> {
		const graph = normalizeScriptableAudioGeneratorGraph(value);
		const clips = new Map<string, IScriptableAudioClipSource>();
		for (const path of [...new Set(graph.nodes.filter((node) => node.type === "audioClip").map((node) => String(node.data.path)))]) {
			const clip = await options.loadAudioClip(path);
			if (!Number.isInteger(clip.sampleRate) || clip.sampleRate < 8_000 || clip.sampleRate > 384_000 || !clip.channels.length || clip.channels.length > 32) {
				throw new Error(`AudioClip "${path}" returned an unsupported sample rate or channel count.`);
			}
			const frameCount = clip.channels[0].length;
			if (
				frameCount < 1 ||
				clip.channels.some((channel) => channel.length !== frameCount) ||
				frameCount * clip.channels.length > SCRIPTABLE_AUDIO_LIMITS.maximumSourceSampleValues
			) {
				throw new Error(`AudioClip "${path}" has inconsistent channels or exceeds the decoded sample limit.`);
			}
			clips.set(path, clip);
		}
		return new ScriptableAudioGeneratorRuntime(graph, clips);
	}

	/** Total output frames after duration-to-rate ceiling. */
	public get frameCount(): number {
		return Math.ceil(this.graph.durationSeconds * this.graph.sampleRate);
	}

	/** Defensive copy of bounded runtime evidence. */
	public get diagnostics(): IScriptableAudioRuntimeDiagnostic[] {
		return this._diagnostics.map((diagnostic) => ({ ...diagnostic }));
	}

	/** Stable ids of nodes that most recently signaled completion. */
	public get finishedNodeIds(): string[] {
		return [...this._finishedNodeIds].sort();
	}

	/** Renders one bounded block at an exact position; repeated calls at the same position are deterministic for built-ins. */
	public renderFrames(startFrame: number, frameCount: number): Float32Array[] {
		if (this._disposed) {
			throw new Error("Scriptable Audio runtime is disposed.");
		}
		finiteNumber(startFrame, "Scriptable Audio startFrame", 0, this.frameCount, true);
		finiteNumber(frameCount, "Scriptable Audio frameCount", 1, SCRIPTABLE_AUDIO_LIMITS.maximumBlockFrames, true);
		const count = Math.min(frameCount, Math.max(0, this.frameCount - startFrame));
		if (count === 0) {
			return allocateChannels(this.graph.channels, 0);
		}
		if (this._rendering) {
			throw new Error("Scriptable Audio runtime does not allow reentrant rendering.");
		}
		this._rendering = true;
		try {
			return this._renderNode(this.graph.outputNodeId, startFrame, count, new Map());
		} finally {
			this._rendering = false;
		}
	}

	/** Materializes a non-streaming graph into channel arrays for exact AudioBuffer playback and offline tests. */
	public renderAll(blockSize = 2_048): IScriptableAudioRenderResult {
		if (this.graph.streaming) {
			throw new Error("Streaming Audio Generator graphs must be consumed in blocks instead of materialized.");
		}
		finiteNumber(blockSize, "Scriptable Audio blockSize", 128, SCRIPTABLE_AUDIO_LIMITS.maximumBlockFrames, true);
		const channels = allocateChannels(this.graph.channels, this.frameCount);
		for (let frame = 0; frame < this.frameCount; frame += blockSize) {
			const block = this.renderFrames(frame, Math.min(blockSize, this.frameCount - frame));
			for (let channel = 0; channel < channels.length; channel++) {
				channels[channel].set(block[channel], frame);
			}
		}
		return {
			sampleRate: this.graph.sampleRate,
			channels,
			frameCount: this.frameCount,
			durationSeconds: this.frameCount / this.graph.sampleRate,
			finishedNodeIds: this.finishedNodeIds,
			diagnostics: this.diagnostics,
		};
	}

	/** Releases every project generator state exactly once. */
	public dispose(): void {
		if (this._disposed) {
			return;
		}
		if (this._rendering) {
			throw new Error("Scriptable Audio runtime cannot be disposed while rendering.");
		}
		this._disposed = true;
		for (const runtime of this._custom.values()) {
			try {
				runtime.definition.destroy?.(runtime.state);
			} catch (error) {
				this._recordDiagnostic("$dispose", "warning", error, runtime.positionFrame);
			}
		}
		this._custom.clear();
	}

	/** Hides custom serialization headers from project callback data. */
	private _validationContext(node: IScriptableAudioGeneratorNode): IScriptableAudioGeneratorValidationContext {
		return {
			nodeId: node.id,
			format: { sampleRate: this.graph.sampleRate, channels: this.graph.channels },
			data: node.type === "custom" ? (node.data.parameters as Record<string, unknown>) : node.data,
		};
	}

	/** Recursively renders and memoizes one node for one exact block. */
	private _renderNode(nodeId: string, startFrame: number, frameCount: number, cache: Map<string, Float32Array[]>): Float32Array[] {
		const key = `${nodeId}:${startFrame}:${frameCount}`;
		const existing = cache.get(key);
		if (existing) {
			return existing;
		}
		const node = this._nodes.get(nodeId)!;
		const output = allocateChannels(this.graph.channels, frameCount);
		cache.set(key, output);
		if (!node.enabled) {
			return output;
		}
		try {
			switch (node.type) {
				case "audioClip":
					this._renderAudioClip(node, startFrame, frameCount, output);
					break;
				case "oscillator":
					this._renderOscillator(node, startFrame, frameCount, output);
					break;
				case "noise":
					this._renderNoise(node, startFrame, frameCount, output);
					break;
				case "sequence":
					this._renderSequence(node, startFrame, frameCount, output, cache);
					break;
				case "random":
					this._renderRandom(node, startFrame, frameCount, output, cache);
					break;
				case "custom":
					this._renderCustom(node, startFrame, frameCount, output, cache);
					break;
				default:
					this._renderCombined(node, startFrame, frameCount, output, cache);
			}
		} catch (error) {
			output.forEach((channel) => channel.fill(0));
			this._recordDiagnostic(node.id, "error", error, startFrame);
		}
		return output;
	}

	/** Reads, resamples, loops, maps channels, and gain-scales one decoded AudioClip leaf. */
	private _renderAudioClip(node: IScriptableAudioGeneratorNode, startFrame: number, frameCount: number, output: Float32Array[]): void {
		const source = this._clips.get(String(node.data.path))!;
		const sourceDurationSeconds = source.channels[0].length / source.sampleRate;
		const startSeconds = readNumber(node.data, "startSeconds", 0, 0, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds);
		if (startSeconds >= sourceDurationSeconds) {
			this._finishedNodeIds.add(node.id);
			return;
		}
		const endSeconds = Math.min(
			sourceDurationSeconds,
			readNumber(node.data, "endSeconds", sourceDurationSeconds, startSeconds, SCRIPTABLE_AUDIO_LIMITS.maximumDurationSeconds)
		);
		const sourceStart = Math.floor(startSeconds * source.sampleRate);
		const sourceEnd = Math.max(sourceStart + 1, Math.min(source.channels[0].length, Math.ceil(endSeconds * source.sampleRate)));
		const loop = node.data.loop === true;
		const gain = readNumber(node.data, "gain", 1, -16, 16);
		for (let frame = 0; frame < frameCount; frame++) {
			let sourcePosition = sourceStart + ((startFrame + frame) * source.sampleRate) / this.graph.sampleRate;
			if (loop) {
				sourcePosition = sourceStart + ((sourcePosition - sourceStart) % (sourceEnd - sourceStart));
			} else if (sourcePosition >= sourceEnd) {
				this._finishedNodeIds.add(node.id);
				break;
			}
			const left = Math.floor(sourcePosition);
			const right = Math.min(sourceEnd - 1, left + 1);
			const amount = sourcePosition - left;
			for (let channel = 0; channel < output.length; channel++) {
				if (output.length === 1 && source.channels.length > 1) {
					let value = 0;
					for (const sourceChannel of source.channels) {
						value += sourceChannel[left] + (sourceChannel[right] - sourceChannel[left]) * amount;
					}
					output[channel][frame] = (value / source.channels.length) * gain;
				} else {
					const sourceChannel = source.channels[source.channels.length === 1 ? 0 : channel % source.channels.length];
					output[channel][frame] = (sourceChannel[left] + (sourceChannel[right] - sourceChannel[left]) * amount) * gain;
				}
			}
		}
	}

	/** Evaluates a phase-stable analytic oscillator directly from absolute frame time. */
	private _renderOscillator(node: IScriptableAudioGeneratorNode, startFrame: number, frameCount: number, output: Float32Array[]): void {
		const waveform = ["sine", "square", "sawtooth", "triangle"].includes(String(node.data.waveform)) ? String(node.data.waveform) : "sine";
		const frequency = readNumber(node.data, "frequency", 440, 0, 96_000);
		const amplitude = readNumber(node.data, "amplitude", 0.25, 0, 16);
		const phase = readNumber(node.data, "phase", 0, -Math.PI * 2, Math.PI * 2);
		for (let frame = 0; frame < frameCount; frame++) {
			const cycle = (((((startFrame + frame) * frequency) / this.graph.sampleRate + phase / (Math.PI * 2)) % 1) + 1) % 1;
			const value =
				waveform === "square"
					? cycle < 0.5
						? 1
						: -1
					: waveform === "sawtooth"
						? cycle * 2 - 1
						: waveform === "triangle"
							? 1 - 4 * Math.abs(cycle - 0.5)
							: Math.sin(cycle * Math.PI * 2);
			for (const channel of output) {
				channel[frame] = value * amplitude;
			}
		}
	}

	/** Generates deterministic per-frame/channel white noise without temporal state. */
	private _renderNoise(node: IScriptableAudioGeneratorNode, startFrame: number, frameCount: number, output: Float32Array[]): void {
		const amplitude = readNumber(node.data, "amplitude", 0.1, 0, 16);
		const seed = this.graph.seed ^ Math.floor(readNumber(node.data, "seedOffset", 0, 0, 0x7fffffff)) ^ stringHash(node.id);
		for (let channel = 0; channel < output.length; channel++) {
			for (let frame = 0; frame < frameCount; frame++) {
				output[channel][frame] = ((stableHash(seed ^ Math.imul(startFrame + frame, 0x9e3779b1) ^ channel) / 0xffffffff) * 2 - 1) * amplitude;
			}
		}
	}

	/** Applies ordered edge and node gains for output, gain, and mix nodes. */
	private _renderCombined(node: IScriptableAudioGeneratorNode, startFrame: number, frameCount: number, output: Float32Array[], cache: Map<string, Float32Array[]>): void {
		const edges = this._incoming.get(node.id) ?? [];
		const nodeGain = readNumber(node.data, "gain", 1, -16, 16);
		const normalize = node.type === "mix" && node.data.normalize === true && edges.length > 0 ? 1 / edges.length : 1;
		for (const edge of edges) {
			const input = this._renderNode(edge.sourceNodeId, startFrame, frameCount, cache);
			for (let channel = 0; channel < output.length; channel++) {
				for (let frame = 0; frame < frameCount; frame++) {
					output[channel][frame] += input[channel][frame] * edge.gain * nodeGain * normalize;
				}
			}
		}
	}

	/** Intersects the requested block with explicit or consecutive child segments. */
	private _renderSequence(node: IScriptableAudioGeneratorNode, startFrame: number, frameCount: number, output: Float32Array[], cache: Map<string, Float32Array[]>): void {
		const edges = this._incoming.get(node.id) ?? [];
		let cursorSeconds = 0;
		for (const edge of edges) {
			const segmentStart = Math.floor((edge.startSeconds ?? cursorSeconds) * this.graph.sampleRate);
			const durationSeconds = edge.durationSeconds ?? Math.max(0.001, this.graph.durationSeconds / edges.length);
			const segmentEnd = segmentStart + Math.ceil(durationSeconds * this.graph.sampleRate);
			cursorSeconds = (edge.startSeconds ?? cursorSeconds) + durationSeconds;
			const intersectionStart = Math.max(startFrame, segmentStart);
			const intersectionEnd = Math.min(startFrame + frameCount, segmentEnd);
			if (intersectionStart >= intersectionEnd) {
				continue;
			}
			const input = this._renderNode(edge.sourceNodeId, intersectionStart - segmentStart, intersectionEnd - intersectionStart, cache);
			for (let channel = 0; channel < output.length; channel++) {
				for (let frame = 0; frame < intersectionEnd - intersectionStart; frame++) {
					output[channel][intersectionStart - startFrame + frame] += input[channel][frame] * edge.gain;
				}
			}
		}
	}

	/** Selects one child per deterministic interval and splits blocks at interval boundaries. */
	private _renderRandom(node: IScriptableAudioGeneratorNode, startFrame: number, frameCount: number, output: Float32Array[], cache: Map<string, Float32Array[]>): void {
		const edges = this._incoming.get(node.id) ?? [];
		const intervalFrames = Math.max(1, Math.round(readNumber(node.data, "intervalSeconds", 1, 0.001, this.graph.durationSeconds) * this.graph.sampleRate));
		const gainMin = readNumber(node.data, "gainMin", 1, 0, 16);
		const gainMax = readNumber(node.data, "gainMax", 1, gainMin, 16);
		let cursor = startFrame;
		while (cursor < startFrame + frameCount) {
			const slot = Math.floor(cursor / intervalFrames);
			const slotEnd = Math.min(startFrame + frameCount, (slot + 1) * intervalFrames);
			const choiceHash = stableHash(this.graph.seed ^ stringHash(node.id) ^ slot);
			const edge = edges[choiceHash % edges.length];
			const randomGain = gainMin + (gainMax - gainMin) * (stableHash(choiceHash ^ 0x51ed270b) / 0xffffffff);
			const input = this._renderNode(edge.sourceNodeId, cursor - slot * intervalFrames, slotEnd - cursor, cache);
			for (let channel = 0; channel < output.length; channel++) {
				for (let frame = 0; frame < slotEnd - cursor; frame++) {
					output[channel][cursor - startFrame + frame] += input[channel][frame] * edge.gain * randomGain;
				}
			}
			cursor = slotEnd;
		}
	}

	/** Runs a project callback with copied inputs and validates every control/sample result. */
	private _renderCustom(node: IScriptableAudioGeneratorNode, startFrame: number, frameCount: number, output: Float32Array[], cache: Map<string, Float32Array[]>): void {
		let runtime = this._custom.get(node.id)!;
		if (runtime.positionFrame !== startFrame) {
			if (runtime.definition.setPosition) {
				runtime.definition.setPosition(startFrame, this._validationContext(node), runtime.state);
				runtime.finished = false;
			} else {
				runtime.definition.destroy?.(runtime.state);
				runtime = { ...runtime, state: runtime.definition.create?.(this._validationContext(node)), finished: false };
				this._custom.set(node.id, runtime);
			}
			runtime.positionFrame = startFrame;
			this._finishedNodeIds.delete(node.id);
		}
		if (runtime.finished) {
			return;
		}
		const inputs = (this._incoming.get(node.id) ?? []).map((edge) => {
			const input = this._renderNode(edge.sourceNodeId, startFrame, frameCount, cache);
			return input.map((channel) => Float32Array.from(channel, (sample) => sample * edge.gain));
		});
		const result = runtime.definition.process({ ...this._validationContext(node), startFrame, frameCount, inputs, output }, runtime.state);
		if (result?.processedFrames !== undefined && (!Number.isInteger(result.processedFrames) || result.processedFrames < 0 || result.processedFrames > frameCount)) {
			throw new Error(`Custom Scriptable Audio node "${node.id}" returned an invalid processedFrames value.`);
		}
		if (result?.isFinished !== undefined && typeof result.isFinished !== "boolean") {
			throw new Error(`Custom Scriptable Audio node "${node.id}" returned a non-boolean isFinished value.`);
		}
		const processedFrames = result?.processedFrames ?? frameCount;
		let repairedSamples = 0;
		for (const channel of output) {
			for (let frame = 0; frame < processedFrames; frame++) {
				const sample = channel[frame];
				if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
					channel[frame] = Number.isFinite(sample) ? Math.min(1, Math.max(-1, sample)) : 0;
					repairedSamples++;
				}
			}
		}
		if (repairedSamples) {
			this._recordDiagnostic(node.id, "warning", `Clamped or silenced ${repairedSamples} invalid custom sample value(s).`, startFrame);
		}
		for (const channel of output) {
			for (let frame = processedFrames; frame < frameCount; frame++) {
				channel[frame] = 0;
			}
		}
		runtime.positionFrame = startFrame + processedFrames;
		runtime.finished = result?.isFinished === true;
		if (runtime.finished) {
			this._finishedNodeIds.add(node.id);
		}
	}

	/** Retains at most 256 bounded messages so broken generators cannot exhaust evidence memory. */
	private _recordDiagnostic(nodeId: string, severity: "warning" | "error", error: unknown, frame: number): void {
		if (this._diagnostics.length >= 256) {
			return;
		}
		this._diagnostics.push({ nodeId, severity, message: (error instanceof Error ? error.message : String(error)).slice(0, 2_048), frame });
	}
}
