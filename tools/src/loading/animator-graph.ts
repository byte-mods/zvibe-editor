const ANIMATOR_ANY_STATE = "$any";
const ANIMATOR_EXIT_STATE = "$exit";

export interface IAnimatorBlendTreeChild {
	animationGroup?: string;
	blendTree?: IAnimatorBlendTree;
	threshold?: number;
	position?: [number, number];
	directParameter?: string;
	timeScale?: number;
	cycleOffset?: number;
	mirror?: boolean;
}

export interface IAnimatorBlendTree {
	parameter?: string;
	parameterX?: string;
	parameterY?: string;
	blendMode?: "cartesian" | "directional" | "freeformDirectional" | "direct";
	normalizeWeights?: boolean;
	children: IAnimatorBlendTreeChild[];
}

export interface IAnimatorGraphState {
	name: string;
	animationGroup?: string;
	loop?: boolean;
	speed?: number;
	/** Static normalized phase offset applied before this state's Motion is sampled. */
	cycleOffset?: number;
	/** Mirrors the complete state Motion through the current Humanoid Avatar mapping. */
	mirror?: boolean;
	/** Float parameter multiplied with the authored state speed at runtime. */
	speedParameter?: string | null;
	/** Bool parameter replacing the authored mirror toggle at runtime. */
	mirrorParameter?: string | null;
	/** Float parameter replacing the authored normalized cycle offset at runtime. */
	cycleOffsetParameter?: string | null;
	/** Float parameter directly driving normalized state time at runtime. */
	timeParameter?: string | null;
	/** Optional authoring/runtime tag retained from Unity AnimatorState assets. */
	tag?: string;
	/** Enables bounded automatic Humanoid ground-contact Foot IK after animation sampling. */
	footIK?: boolean;
	/** Restores captured controller defaults for properties not animated by this state when entering it. */
	writeDefaultValues?: boolean;
	/** Exact state-level Unity serialization evidence retained by controller import. */
	unitySource?: {
		fileId: string;
		serializedVersion: number | null;
		footIKField: "m_IKOnFeet" | "m_FootIK" | null;
		speedParameter: string | null;
		mirrorParameter: string | null;
		cycleOffsetParameter: string | null;
		timeParameter: string | null;
	};
	behaviours?: IAnimatorStateBehaviour[];
	maskTargetNames?: string[];
	avatarMaskId?: string;
	graphPosition?: [number, number];
	blendTree?: IAnimatorBlendTree;
}

export interface IAnimatorStatePlayback {
	speed: number;
	speedMultiplier: number;
	effectiveSpeed: number;
	cycleOffset: number;
	mirror: boolean;
	time: number | null;
	timeDriven: boolean;
	bindings: {
		speed: string | null;
		mirror: string | null;
		cycleOffset: string | null;
		time: string | null;
	};
}

/** Resolves Unity-compatible dynamic AnimatorState playback parameters without mutating authoring data. */
export function resolveAnimatorStatePlayback(state: IAnimatorGraphState, parameters: Record<string, string | number | boolean>): IAnimatorStatePlayback {
	const bindings = {
		speed: state.speedParameter === undefined ? (state.unitySource?.speedParameter ?? null) : state.speedParameter,
		mirror: state.mirrorParameter === undefined ? (state.unitySource?.mirrorParameter ?? null) : state.mirrorParameter,
		cycleOffset: state.cycleOffsetParameter === undefined ? (state.unitySource?.cycleOffsetParameter ?? null) : state.cycleOffsetParameter,
		time: state.timeParameter === undefined ? (state.unitySource?.timeParameter ?? null) : state.timeParameter,
	};
	const numberParameter = (name: string | null, fallback: number): number => {
		if (!name) {
			return fallback;
		}
		const value = parameters[name];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`Animator state parameter "${name}" requires a finite numeric value.`);
		}
		return value;
	};
	const booleanParameter = (name: string | null, fallback: boolean): boolean => {
		if (!name) {
			return fallback;
		}
		const value = parameters[name];
		if (typeof value !== "boolean") {
			throw new Error(`Animator state parameter "${name}" requires a boolean value.`);
		}
		return value;
	};
	const speed = state.speed ?? 1;
	const speedMultiplier = numberParameter(bindings.speed, 1);
	const effectiveSpeed = speed * speedMultiplier;
	const timeDriven = !!bindings.time;
	return {
		speed,
		speedMultiplier,
		effectiveSpeed: effectiveSpeed === 0 ? 0 : effectiveSpeed,
		cycleOffset: numberParameter(bindings.cycleOffset, timeDriven ? 0 : (state.cycleOffset ?? 0)),
		mirror: booleanParameter(bindings.mirror, state.mirror === true),
		time: bindings.time ? numberParameter(bindings.time, 0) : null,
		timeDriven,
		bindings,
	};
}

export interface IAnimatorStateBehaviour {
	id: string;
	scriptKey: string;
	enabled?: boolean;
	/** Exact source evidence retained when this binding was imported from a Unity class-114 MonoBehaviour. */
	unitySource?: {
		bindingKey: string;
		behaviourFileId: string;
		behaviourGuid: string | null;
		scriptFileId: string | null;
		scriptGuid: string | null;
		scriptPath: string | null;
		scriptContentHash: string | null;
		scriptMetaHash: string | null;
		behaviourName: string;
		editorClassIdentifier: string;
		serializedFieldsJson: string;
	};
}

export interface IAnimatorGraphTransitionCondition {
	parameter: string;
	equals?: string | number | boolean;
	notEquals?: string | number | boolean;
	greaterThan?: number;
	lessThan?: number;
}

export interface IAnimatorGraphTransition {
	from: string;
	to: string;
	conditions?: IAnimatorGraphTransitionCondition[];
	exitTime?: number;
	duration?: number;
	durationMode?: "seconds" | "normalized";
	offset?: number;
	interruptionSource?: "none" | "source" | "destination" | "sourceThenDestination" | "destinationThenSource";
	orderedInterruption?: boolean;
	canTransitionToSelf?: boolean;
}

export interface IAnimatorGraphEntryTransition {
	to: string;
	conditions?: IAnimatorGraphTransitionCondition[];
}

export interface IAnimatorSubStateMachineInstance {
	name: string;
	subgraphId: string;
	graphPosition?: [number, number];
}

export interface IAnimatorGraphMachine {
	/** Ordered StateMachineBehaviour-style bindings for this machine boundary. */
	behaviours?: IAnimatorStateBehaviour[];
	states: IAnimatorGraphState[];
	transitions: IAnimatorGraphTransition[];
	entryTransitions?: IAnimatorGraphEntryTransition[];
	entryState?: string;
	activeState?: string;
	subStateMachines?: IAnimatorSubStateMachineInstance[];
}

export interface IAnimatorSubgraphDefinition extends IAnimatorGraphMachine {
	id: string;
	name: string;
}

export interface ICompiledAnimatorState extends IAnimatorGraphState {
	sourceStateName: string;
	machinePath: string[];
	subgraphId?: string;
}

export interface ICompiledAnimatorTransition extends IAnimatorGraphTransition {
	sourceMachinePath: string[];
	sourceTransitionIndex: number;
	sourceTransition: IAnimatorGraphTransition;
}

export interface ICompiledAnimatorEntryTransition extends IAnimatorGraphEntryTransition {
	to: string;
	sourceMachinePath: string[];
	sourceTransitionIndex: number | null;
	fallback: boolean;
}

export interface ICompiledAnimatorMachine {
	states: ICompiledAnimatorState[];
	transitions: ICompiledAnimatorTransition[];
	entryState: string;
	entryTransitions: ICompiledAnimatorEntryTransition[];
	nodeEntries: Record<string, string>;
	machineEntries: Record<string, string>;
	machineEntryTransitions: Record<string, ICompiledAnimatorEntryTransition[]>;
	machineLeaves: Record<string, string[]>;
	/** Machine-path keyed behaviour bindings, where the root machine uses an empty key. */
	machineBehaviours: Record<string, IAnimatorStateBehaviour[]>;
}

const MAX_SUBGRAPHS = 32;
const MAX_MACHINE_STATES = 64;
const MAX_MACHINE_INSTANCES = 16;
const MAX_NESTING_DEPTH = 6;
const MAX_COMPILED_STATES = 512;
const MAX_COMPILED_TRANSITIONS = 4096;

function pathKey(path: string[]): string {
	return path.join("/");
}

function qualify(path: string[], name: string): string {
	return [...path, name].join("/");
}

function assertGraphName(name: string, kind: string): void {
	if (!name || name.includes("/") || name.startsWith("$")) {
		throw new Error(`${kind} names must be non-empty, cannot contain "/", and cannot start with "$".`);
	}
}

function validateTransitionConditions(conditions: IAnimatorGraphTransitionCondition[] | undefined, owner: string): void {
	for (const condition of conditions ?? []) {
		const operatorCount = [condition.equals, condition.notEquals, condition.greaterThan, condition.lessThan].filter((value) => value !== undefined).length;
		if (!condition.parameter || operatorCount !== 1) {
			throw new Error(`${owner} conditions require a parameter and exactly one equals, notEquals, greaterThan, or lessThan operator.`);
		}
	}
}

function validateMachineShape(machine: IAnimatorGraphMachine, owner: string): void {
	if (!Array.isArray(machine.states) || !machine.states.length || machine.states.length > MAX_MACHINE_STATES) {
		throw new Error(`${owner} must contain between 1 and ${MAX_MACHINE_STATES} direct states.`);
	}
	if ((machine.subStateMachines?.length ?? 0) > MAX_MACHINE_INSTANCES) {
		throw new Error(`${owner} cannot contain more than ${MAX_MACHINE_INSTANCES} direct sub-state-machine instances.`);
	}
	if ((machine.behaviours?.length ?? 0) > 16) {
		throw new Error(`${owner} cannot contain more than 16 state-machine behaviours.`);
	}
	const machineBehaviourIds = new Set<string>();
	for (const behaviour of machine.behaviours ?? []) {
		if (!behaviour.id || !behaviour.scriptKey) {
			throw new Error(`${owner} state-machine behaviours require non-empty id and scriptKey values.`);
		}
		if (machineBehaviourIds.has(behaviour.id)) {
			throw new Error(`${owner} state-machine behaviour ids must be unique.`);
		}
		machineBehaviourIds.add(behaviour.id);
	}
	const names = new Set<string>();
	for (const state of machine.states) {
		assertGraphName(state.name, "Animator state");
		if (state.speed !== undefined && (!Number.isFinite(state.speed) || state.speed === 0)) {
			throw new Error(`${owner} state "${state.name}" speed must be a finite non-zero number.`);
		}
		if (state.cycleOffset !== undefined && (!Number.isFinite(state.cycleOffset) || state.cycleOffset < 0 || state.cycleOffset > 1)) {
			throw new Error(`${owner} state "${state.name}" cycleOffset must be normalized between 0 and 1.`);
		}
		if (state.mirror !== undefined && typeof state.mirror !== "boolean") {
			throw new Error(`${owner} state "${state.name}" mirror must be a boolean.`);
		}
		for (const [label, parameter] of [
			["speedParameter", state.speedParameter],
			["mirrorParameter", state.mirrorParameter],
			["cycleOffsetParameter", state.cycleOffsetParameter],
			["timeParameter", state.timeParameter],
		] as const) {
			if (parameter !== undefined && parameter !== null && (!parameter || parameter.length > 256)) {
				throw new Error(`${owner} state "${state.name}" ${label} must contain 1 through 256 characters.`);
			}
		}
		if (state.tag !== undefined && (typeof state.tag !== "string" || state.tag.length > 256)) {
			throw new Error(`${owner} state "${state.name}" tag cannot exceed 256 characters.`);
		}
		if (state.unitySource) {
			const source = state.unitySource;
			if (!source.fileId || source.fileId.length > 64) {
				throw new Error(`${owner} state "${state.name}" Unity source requires a bounded fileId.`);
			}
			if (source.serializedVersion !== null && (!Number.isSafeInteger(source.serializedVersion) || source.serializedVersion < 0)) {
				throw new Error(`${owner} state "${state.name}" Unity source serializedVersion must be a non-negative integer or null.`);
			}
			if (source.footIKField !== null && source.footIKField !== "m_IKOnFeet" && source.footIKField !== "m_FootIK") {
				throw new Error(`${owner} state "${state.name}" Unity source has an unknown Foot IK field.`);
			}
			for (const parameter of [source.speedParameter, source.mirrorParameter, source.cycleOffsetParameter, source.timeParameter]) {
				if (parameter !== null && (!parameter || parameter.length > 256)) {
					throw new Error(`${owner} state "${state.name}" Unity source parameter names must contain 1 through 256 characters or be null.`);
				}
			}
		}
		if ((state.behaviours?.length ?? 0) > 16) {
			throw new Error(`${owner} state "${state.name}" cannot contain more than 16 state behaviours.`);
		}
		const behaviourIds = new Set<string>();
		for (const behaviour of state.behaviours ?? []) {
			if (!behaviour.id || !behaviour.scriptKey) {
				throw new Error(`${owner} state "${state.name}" behaviours require non-empty id and scriptKey values.`);
			}
			if (behaviourIds.has(behaviour.id)) {
				throw new Error(`${owner} state "${state.name}" behaviour ids must be unique.`);
			}
			behaviourIds.add(behaviour.id);
		}
		if (names.has(state.name)) {
			throw new Error(`${owner} state and sub-state-machine names must be unique.`);
		}
		names.add(state.name);
	}
	for (const instance of machine.subStateMachines ?? []) {
		assertGraphName(instance.name, "Animator sub-state-machine");
		if (!instance.subgraphId) {
			throw new Error(`${owner} sub-state-machine "${instance.name}" requires a reusable subgraph id.`);
		}
		if (instance.graphPosition !== undefined && (instance.graphPosition.length !== 2 || instance.graphPosition.some((value) => !Number.isFinite(value)))) {
			throw new Error(`${owner} sub-state-machine "${instance.name}" graphPosition must contain two finite numbers.`);
		}
		if (names.has(instance.name)) {
			throw new Error(`${owner} state and sub-state-machine names must be unique.`);
		}
		names.add(instance.name);
	}
	const entryState = machine.entryState ?? machine.activeState ?? machine.states[0]?.name;
	if (!entryState || !names.has(entryState)) {
		throw new Error(`${owner} entryState must reference a direct state or sub-state-machine instance.`);
	}
	if ((machine.entryTransitions?.length ?? 0) > MAX_MACHINE_STATES) {
		throw new Error(`${owner} cannot contain more than ${MAX_MACHINE_STATES} conditional Entry transitions.`);
	}
	for (const transition of machine.entryTransitions ?? []) {
		if (!names.has(transition.to)) {
			throw new Error(`${owner} Entry transition destination "${transition.to}" is not a direct state or sub-state-machine instance.`);
		}
		validateTransitionConditions(transition.conditions, `${owner} Entry transition`);
	}
	for (const transition of machine.transitions ?? []) {
		if (transition.from !== ANIMATOR_ANY_STATE && !names.has(transition.from)) {
			throw new Error(`${owner} transition source "${transition.from}" is not a direct state or sub-state-machine instance.`);
		}
		if (transition.to !== ANIMATOR_EXIT_STATE && !names.has(transition.to)) {
			throw new Error(`${owner} transition destination "${transition.to}" is not a direct state or sub-state-machine instance.`);
		}
		if (transition.from === ANIMATOR_ANY_STATE && transition.to === ANIMATOR_EXIT_STATE) {
			throw new Error(`${owner} cannot transition directly from Any State to Exit.`);
		}
		validateTransitionConditions(transition.conditions, `${owner} transition`);
	}
}

/**
 * Validates and flattens reusable Animator subgraphs into deterministic qualified
 * leaf states. Subgraphs are referenced by id, may be instantiated repeatedly,
 * and are cycle checked with a bounded nesting depth.
 */
export function compileAnimatorMachine(machine: IAnimatorGraphMachine, subgraphs: IAnimatorSubgraphDefinition[] = []): ICompiledAnimatorMachine {
	if (subgraphs.length > MAX_SUBGRAPHS) {
		throw new Error(`Animator controllers cannot contain more than ${MAX_SUBGRAPHS} reusable subgraphs.`);
	}
	const subgraphsById = new Map<string, IAnimatorSubgraphDefinition>();
	const subgraphNames = new Set<string>();
	for (const subgraph of subgraphs) {
		if (!subgraph.id || !subgraph.name) {
			throw new Error("Animator reusable subgraphs require non-empty id and name values.");
		}
		assertGraphName(subgraph.name, "Animator subgraph");
		if (subgraphsById.has(subgraph.id) || subgraphNames.has(subgraph.name)) {
			throw new Error("Animator reusable subgraph ids and names must be unique.");
		}
		validateMachineShape(subgraph, `Animator subgraph "${subgraph.name}"`);
		subgraphsById.set(subgraph.id, subgraph);
		subgraphNames.add(subgraph.name);
	}
	validateMachineShape(machine, "Animator state machine");

	const states: ICompiledAnimatorState[] = [];
	const transitions: ICompiledAnimatorTransition[] = [];
	const machineEntries: Record<string, string> = {};
	const machineEntryTransitions: Record<string, ICompiledAnimatorEntryTransition[]> = {};
	const machineLeaves: Record<string, string[]> = {};
	const machineBehaviours: Record<string, IAnimatorStateBehaviour[]> = {};
	const nodeEntries: Record<string, string> = {};
	const machineByPath = new Map<string, IAnimatorGraphMachine>();
	const subgraphIdByPath = new Map<string, string | undefined>();

	const visit = (current: IAnimatorGraphMachine, path: string[], ancestry: string[], subgraphId?: string): void => {
		if (path.length > MAX_NESTING_DEPTH) {
			throw new Error(`Animator sub-state-machine nesting cannot exceed ${MAX_NESTING_DEPTH} levels.`);
		}
		const key = pathKey(path);
		machineByPath.set(key, current);
		subgraphIdByPath.set(key, subgraphId);
		if (current.behaviours?.length) {
			machineBehaviours[key] = structuredClone(current.behaviours);
		}
		const leaves: string[] = [];
		for (const state of current.states) {
			const name = qualify(path, state.name);
			states.push({ ...state, name, sourceStateName: state.name, machinePath: [...path], subgraphId });
			leaves.push(name);
		}
		for (const instance of current.subStateMachines ?? []) {
			const subgraph = subgraphsById.get(instance.subgraphId);
			if (!subgraph) {
				throw new Error(`Animator sub-state-machine "${instance.name}" references missing subgraph "${instance.subgraphId}".`);
			}
			if (ancestry.includes(subgraph.id)) {
				throw new Error(`Animator reusable subgraph cycle detected through "${subgraph.name}".`);
			}
			const instancePath = [...path, instance.name];
			visit(subgraph, instancePath, [...ancestry, subgraph.id], subgraph.id);
			leaves.push(...(machineLeaves[pathKey(instancePath)] ?? []));
		}
		machineLeaves[key] = leaves;
		if (states.length > MAX_COMPILED_STATES) {
			throw new Error(`Animator compiled state count cannot exceed ${MAX_COMPILED_STATES}.`);
		}
	};
	visit(machine, [], []);

	const resolveEntry = (path: string[], resolving: Set<string>): string => {
		const key = pathKey(path);
		const cached = machineEntries[key];
		if (cached) {
			return cached;
		}
		if (resolving.has(key)) {
			throw new Error(`Animator entry resolution cycle detected at "${key || "root"}".`);
		}
		resolving.add(key);
		const current = machineByPath.get(key)!;
		const entry = current.entryState ?? current.activeState ?? current.states[0].name;
		const directState = current.states.find((state) => state.name === entry);
		const resolved = directState ? qualify(path, directState.name) : resolveEntry([...path, entry], resolving);
		machineEntries[key] = resolved;
		resolving.delete(key);
		return resolved;
	};
	for (const key of machineByPath.keys()) {
		resolveEntry(key ? key.split("/") : [], new Set());
	}

	const resolveEntryTransitions = (path: string[], resolving: Set<string>): ICompiledAnimatorEntryTransition[] => {
		const key = pathKey(path);
		const cached = machineEntryTransitions[key];
		if (cached) {
			return cached;
		}
		if (resolving.has(key)) {
			throw new Error(`Animator conditional Entry resolution cycle detected at "${key || "root"}".`);
		}
		resolving.add(key);
		const current = machineByPath.get(key)!;
		const targetRoutes = (target: string): ICompiledAnimatorEntryTransition[] => {
			if (current.states.some((state) => state.name === target)) {
				return [{ to: qualify(path, target), sourceMachinePath: [...path], sourceTransitionIndex: null, fallback: true }];
			}
			return resolveEntryTransitions([...path, target], resolving);
		};
		const routes: ICompiledAnimatorEntryTransition[] = [];
		for (const [index, transition] of (current.entryTransitions ?? []).entries()) {
			for (const targetRoute of targetRoutes(transition.to)) {
				routes.push({
					to: targetRoute.to,
					conditions: [...(transition.conditions ?? []), ...(targetRoute.conditions ?? [])],
					sourceMachinePath: [...path],
					sourceTransitionIndex: index,
					fallback: false,
				});
			}
		}
		const fallbackTarget = current.entryState ?? current.activeState ?? current.states[0].name;
		for (const targetRoute of targetRoutes(fallbackTarget)) {
			routes.push({ ...targetRoute, fallback: targetRoute.fallback });
		}
		machineEntryTransitions[key] = routes;
		resolving.delete(key);
		return routes;
	};
	for (const key of machineByPath.keys()) {
		resolveEntryTransitions(key ? key.split("/") : [], new Set());
	}

	const resolveNodeSources = (path: string[], node: string): string[] => {
		if (node === ANIMATOR_ANY_STATE) {
			return machineLeaves[pathKey(path)] ?? [];
		}
		const current = machineByPath.get(pathKey(path))!;
		if (current.states.some((state) => state.name === node)) {
			return [qualify(path, node)];
		}
		return machineLeaves[pathKey([...path, node])] ?? [];
	};
	const resolveNodeTargets = (path: string[], node: string): Array<{ to: string; conditions?: IAnimatorGraphTransitionCondition[] }> => {
		if (node === ANIMATOR_EXIT_STATE) {
			return [{ to: ANIMATOR_EXIT_STATE }];
		}
		const current = machineByPath.get(pathKey(path))!;
		return current.states.some((state) => state.name === node)
			? [{ to: qualify(path, node) }]
			: (machineEntryTransitions[pathKey([...path, node])] ?? []).map((route) => ({ to: route.to, ...(route.conditions?.length ? { conditions: route.conditions } : {}) }));
	};

	const exitRoutes = (path: string[], visited: Set<string>): Array<{ path: string[]; transition: IAnimatorGraphTransition }> => {
		if (!path.length) {
			return [{ path: [], transition: { from: ANIMATOR_ANY_STATE, to: ANIMATOR_EXIT_STATE } }];
		}
		const key = pathKey(path);
		if (visited.has(key)) {
			throw new Error(`Animator Exit routing cycle detected at "${key}".`);
		}
		visited.add(key);
		const parentPath = path.slice(0, -1);
		const instanceName = path[path.length - 1];
		const parent = machineByPath.get(pathKey(parentPath))!;
		const routes = parent.transitions.filter((transition) => transition.from === instanceName);
		if (!routes.length) {
			return exitRoutes(parentPath, visited);
		}
		return routes.flatMap((route) => {
			if (route.to !== ANIMATOR_EXIT_STATE) {
				return [{ path: parentPath, transition: { ...route, from: ANIMATOR_ANY_STATE } }];
			}
			return exitRoutes(parentPath, new Set(visited)).map((parentRoute) => ({
				path: parentRoute.path,
				transition: {
					...parentRoute.transition,
					conditions: [...(route.conditions ?? []), ...(parentRoute.transition.conditions ?? [])],
					exitTime: route.exitTime ?? parentRoute.transition.exitTime,
					duration: parentRoute.transition.duration ?? route.duration,
				},
			}));
		});
	};

	const compileTransitions = (path: string[]): void => {
		const current = machineByPath.get(pathKey(path))!;
		for (const instance of current.subStateMachines ?? []) {
			compileTransitions([...path, instance.name]);
		}
		for (let index = 0; index < current.transitions.length; index++) {
			const transition = current.transitions[index];
			if ((current.subStateMachines ?? []).some((instance) => instance.name === transition.from)) {
				continue;
			}
			const sources = resolveNodeSources(path, transition.from);
			const routes: Array<{ path: string[]; transition: IAnimatorGraphTransition }> =
				transition.to === ANIMATOR_EXIT_STATE
					? exitRoutes(path, new Set()).map((route) => ({
							path: route.path,
							transition: {
								...route.transition,
								conditions: [...(transition.conditions ?? []), ...(route.transition.conditions ?? [])],
								exitTime: transition.exitTime ?? route.transition.exitTime,
								duration: route.transition.duration ?? transition.duration,
							},
						}))
					: [{ path, transition }];
			for (const source of sources) {
				for (const route of routes) {
					for (const target of resolveNodeTargets(route.path, route.transition.to)) {
						transitions.push({
							...route.transition,
							to: target.to,
							conditions: [...(route.transition.conditions ?? []), ...(target.conditions ?? [])],
							from: source,
							sourceMachinePath: [...path],
							sourceTransitionIndex: index,
							sourceTransition: transition,
						});
					}
				}
			}
		}
	};
	compileTransitions([]);
	if (transitions.length > MAX_COMPILED_TRANSITIONS) {
		throw new Error(`Animator compiled transition count cannot exceed ${MAX_COMPILED_TRANSITIONS}.`);
	}

	const root = machineByPath.get("")!;
	for (const state of root.states) {
		nodeEntries[state.name] = state.name;
	}
	for (const instance of root.subStateMachines ?? []) {
		nodeEntries[instance.name] = machineEntries[instance.name];
	}
	return {
		states,
		transitions,
		entryState: machineEntries[""],
		entryTransitions: machineEntryTransitions[""],
		nodeEntries,
		machineEntries,
		machineEntryTransitions,
		machineLeaves,
		machineBehaviours,
	};
}
