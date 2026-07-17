import { basename, extname } from "path/posix";

import { parseAllDocuments } from "yaml";

import {
	IAnimatorBlendTreeChild,
	IAnimatorGraphEntryTransition,
	IAnimatorGraphMachine,
	IAnimatorGraphState,
	IAnimatorGraphTransition,
	IAnimatorSubgraphDefinition,
} from "../loading/animator-graph";

export type AnimatorControllerImportFormat = "babylon-json" | "unity-yaml";

export interface IAnimatorControllerMotionBinding {
	key: string;
	fileId: string;
	guid: string | null;
	type: number | null;
	suggestedAnimationGroup: string;
	usedBy: string[];
}

export interface IAnimatorControllerAvatarMaskBinding {
	key: string;
	fileId: string;
	guid: string | null;
	type: number | null;
	suggestedAvatarMask: string;
	usedBy: string[];
}

export interface IAnimatorControllerImportedLayer extends IAnimatorGraphMachine {
	name: string;
	weight?: number;
	blendingMode?: "override" | "additive";
	referencePose?: { normalizedTime: number };
	avatarMaskId?: string;
	synchronizedLayer?: "$base" | string;
	synchronizedTiming?: boolean;
	synchronizedStateMap?: Record<string, string>;
	synchronizedMotionOverrides?: Record<string, Pick<IAnimatorGraphState, "animationGroup" | "blendTree">>;
	synchronizedBehaviourOverrides?: Record<string, NonNullable<IAnimatorGraphState["behaviours"]>>;
	ikPass?: boolean;
}

export interface IAnimatorControllerImportedData extends IAnimatorGraphMachine {
	name: string;
	baseIKPass?: boolean;
	parameters: Record<string, string | number | boolean>;
	parameterTypes: Record<string, "float" | "int" | "bool" | "trigger">;
	subgraphs: IAnimatorSubgraphDefinition[];
	layers: IAnimatorControllerImportedLayer[];
}

export interface IImportedAnimatorControllerDocument {
	format: "babylonjs-editor-animator-controller";
	version: 1;
	sourceFormat: AnimatorControllerImportFormat;
	controller: IAnimatorControllerImportedData;
	motionBindings: IAnimatorControllerMotionBinding[];
	avatarMaskBindings: IAnimatorControllerAvatarMaskBinding[];
	unsupportedFeatures: string[];
}

export interface IUnityAnimatorControllerConversion {
	document: IImportedAnimatorControllerDocument;
	stateCount: number;
	transitionCount: number;
	blendTreeCount: number;
	layerCount: number;
	parameterCount: number;
	errors: string[];
	warnings: string[];
}

interface IUnityObjectReference {
	fileId: string;
	guid: string | null;
	type: number | null;
}

interface IUnitySerializedObject {
	classId: number;
	fileId: string;
	typeName: string;
	data: Record<string, unknown>;
}

interface IConvertedMachine extends IAnimatorGraphMachine {
	stateNames: Map<string, string>;
	statePaths: Map<string, string>;
	childMachineNames: Map<string, string>;
}

const MAX_UNITY_OBJECTS = 16_384;
const MAX_LAYERS = 32;
const MAX_PARAMETERS = 256;
const MAX_STATES = 512;
const MAX_TRANSITIONS = 4096;
const MAX_BLEND_TREES = 1024;
const MAX_BLEND_CHILDREN = 64;
const MAX_NESTING_DEPTH = 6;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function entries(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record).filter((entry): entry is Record<string, unknown> => entry !== null) : [];
}

function textValue(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
	const converted = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(converted) ? converted : fallback;
}

function booleanValue(value: unknown): boolean {
	return value === true || value === 1 || value === "1" || value === "true";
}

function reference(value: unknown): IUnityObjectReference | null {
	const valueRecord = record(value);
	if (!valueRecord) {
		return null;
	}
	const fileId = textValue(valueRecord.fileID);
	if (!fileId || fileId === "0") {
		return null;
	}
	const guid = typeof valueRecord.guid === "string" && valueRecord.guid && !/^0+$/.test(valueRecord.guid) ? valueRecord.guid.toLowerCase() : null;
	const type = valueRecord.type === undefined ? null : numberValue(valueRecord.type, Number.NaN);
	return { fileId, guid, type: Number.isFinite(type) ? type : null };
}

function graphPosition(value: unknown): [number, number] | undefined {
	const valueRecord = record(value);
	if (!valueRecord) {
		return undefined;
	}
	const x = numberValue(valueRecord.x, Number.NaN);
	const y = numberValue(valueRecord.y, Number.NaN);
	return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

function safeGraphName(value: string, fallback: string): string {
	const cleaned = (value.trim() || fallback).replaceAll("/", "／");
	return cleaned.startsWith("$") ? `Unity ${cleaned}` : cleaned;
}

function uniqueName(requested: string, used: Set<string>): string {
	let name = requested;
	let suffix = 2;
	while (used.has(name)) {
		name = `${requested} (${suffix++})`;
	}
	used.add(name);
	return name;
}

function parseUnityObjects(source: string): IUnitySerializedObject[] {
	const headers = [...source.matchAll(/^---\s+!u!(\d+)\s+&(-?\d+)\s*$/gm)].map((match) => ({ classId: Number(match[1]), fileId: match[2] }));
	// Unity identifiers are fixed-width scalar text. The failsafe schema prevents a
	// digits-only 32-character GUID from being rounded through JavaScript Number.
	const documents = parseAllDocuments(source, { logLevel: "silent", prettyErrors: true, schema: "failsafe" });
	if (!headers.length || headers.length !== documents.length) {
		throw new Error("Unity Animator Controller YAML must contain one !u! class header and fileID anchor per serialized object.");
	}
	if (documents.length > MAX_UNITY_OBJECTS) {
		throw new Error(`Unity Animator Controllers are limited to ${MAX_UNITY_OBJECTS.toLocaleString()} serialized objects.`);
	}
	return documents.map((document, index) => {
		if (document.errors.length) {
			throw new Error(`Unity Animator Controller YAML is malformed: ${document.errors[0].message}`);
		}
		const root = record(document.toJS({ maxAliasCount: 0 }));
		const typeName = root ? Object.keys(root)[0] : "";
		const data = typeName ? record(root?.[typeName]) : null;
		if (!typeName || !data) {
			throw new Error(`Unity serialized object ${headers[index].fileId} does not contain one typed object mapping.`);
		}
		return { ...headers[index], typeName, data };
	});
}

function bindingKey(kind: "motion" | "mask", value: IUnityObjectReference): string {
	return `@unity-${kind}:${value.guid ?? "local"}:${value.fileId}`;
}

function conditionFromUnity(value: Record<string, unknown>, unsupported: Set<string>): NonNullable<IAnimatorGraphTransition["conditions"]>[number] | null {
	const parameter = textValue(value.m_ConditionEvent).trim();
	if (!parameter) {
		unsupported.add("A transition condition without a parameter name was omitted.");
		return null;
	}
	const mode = numberValue(value.m_ConditionMode, 0);
	const threshold = numberValue(value.m_EventTreshold ?? value.m_EventThreshold, 0);
	switch (mode) {
		case 1:
			return { parameter, equals: true };
		case 2:
			return { parameter, equals: false };
		case 3:
			return { parameter, greaterThan: threshold };
		case 4:
			return { parameter, lessThan: threshold };
		case 6:
			return { parameter, equals: threshold };
		case 7:
			return { parameter, notEquals: threshold };
		default:
			unsupported.add(`Animator condition mode ${mode} is not supported and was omitted.`);
			return null;
	}
}

/** Converts Unity's multi-document YAML AnimatorController serialization into a portable editor controller plus explicit external-reference bindings. */
export function convertUnityAnimatorController(source: string, sourcePath: string): IUnityAnimatorControllerConversion {
	const objects = parseUnityObjects(source);
	const byId = new Map(objects.map((object) => [object.fileId, object]));
	const controllerObject = objects.find((object) => object.typeName === "AnimatorController");
	if (!controllerObject) {
		throw new Error("Unity YAML does not contain an AnimatorController object.");
	}
	const errors: string[] = [];
	const warnings: string[] = [];
	const unsupported = new Set<string>();
	const motionBindings = new Map<string, IAnimatorControllerMotionBinding>();
	const maskBindings = new Map<string, IAnimatorControllerAvatarMaskBinding>();
	const subgraphs = new Map<string, IAnimatorSubgraphDefinition>();
	const convertingMachines = new Set<string>();
	let stateCount = 0;
	let transitionCount = 0;
	let blendTreeCount = 0;

	const addMotionBinding = (value: IUnityObjectReference, suggestion: string, owner: string): string => {
		const key = bindingKey("motion", value);
		const existing = motionBindings.get(key);
		if (existing) {
			if (!existing.usedBy.includes(owner)) {
				existing.usedBy.push(owner);
			}
			return key;
		}
		motionBindings.set(key, {
			key,
			fileId: value.fileId,
			guid: value.guid,
			type: value.type,
			suggestedAnimationGroup: safeGraphName(suggestion, `Motion ${value.fileId}`),
			usedBy: [owner],
		});
		return key;
	};

	const addMaskBinding = (value: IUnityObjectReference, suggestion: string, owner: string): string => {
		const key = bindingKey("mask", value);
		const existing = maskBindings.get(key);
		if (existing) {
			if (!existing.usedBy.includes(owner)) {
				existing.usedBy.push(owner);
			}
			return key;
		}
		maskBindings.set(key, {
			key,
			fileId: value.fileId,
			guid: value.guid,
			type: value.type,
			suggestedAvatarMask: safeGraphName(suggestion, `Avatar Mask ${value.fileId}`),
			usedBy: [owner],
		});
		return key;
	};

	const convertMotion = (value: IUnityObjectReference, owner: string, suggestion: string, depth: number): Pick<IAnimatorGraphState, "animationGroup" | "blendTree"> | null => {
		const internal = value.guid ? null : byId.get(value.fileId);
		if (!internal || internal.typeName !== "BlendTree") {
			return { animationGroup: addMotionBinding(value, suggestion, owner) };
		}
		if (depth > MAX_NESTING_DEPTH) {
			errors.push(`Blend Tree used by ${owner} exceeds the ${MAX_NESTING_DEPTH}-level nesting limit.`);
			return null;
		}
		blendTreeCount++;
		if (blendTreeCount > MAX_BLEND_TREES) {
			errors.push(`Animator Controllers are limited to ${MAX_BLEND_TREES} Blend Trees.`);
			return null;
		}
		const blendType = numberValue(internal.data.m_BlendType, 0);
		if (![0, 1, 2, 3, 4].includes(blendType)) {
			errors.push(`Blend Tree "${textValue(internal.data.m_Name, owner)}" uses unsupported Unity blend type ${blendType}.`);
			return null;
		}
		const children = entries(internal.data.m_Childs);
		if (children.length < 2 || children.length > MAX_BLEND_CHILDREN) {
			errors.push(`Blend Tree "${textValue(internal.data.m_Name, owner)}" must contain between 2 and ${MAX_BLEND_CHILDREN} direct motion children.`);
			return null;
		}
		const convertedChildren: IAnimatorBlendTreeChild[] = [];
		for (const [index, child] of children.entries()) {
			const motion = reference(child.m_Motion);
			if (!motion) {
				errors.push(`Blend Tree "${textValue(internal.data.m_Name, owner)}" child ${index} has no Motion.`);
				continue;
			}
			const converted = convertMotion(motion, `${owner} / child ${index}`, `${suggestion} ${index + 1}`, depth + 1);
			if (!converted) {
				continue;
			}
			const position = graphPosition(child.m_Position);
			const timeScale = numberValue(child.m_TimeScale, 1);
			const cycleOffset = numberValue(child.m_CycleOffset, 0);
			const mirror = booleanValue(child.m_Mirror);
			const childMotion = {
				...(converted.animationGroup ? { animationGroup: converted.animationGroup } : { blendTree: converted.blendTree! }),
				...(timeScale !== 1 ? { timeScale } : {}),
				...(cycleOffset !== 0 ? { cycleOffset } : {}),
				...(mirror ? { mirror: true } : {}),
			};
			convertedChildren.push(
				blendType === 0
					? { ...childMotion, threshold: numberValue(child.m_Threshold, index) }
					: blendType === 4
						? { ...childMotion, directParameter: textValue(child.m_DirectBlendParameter).trim() }
						: { ...childMotion, position: position ?? [numberValue(child.m_Threshold, index), 0] }
			);
			if (blendType === 4 && !textValue(child.m_DirectBlendParameter).trim()) {
				errors.push(`Direct Blend Tree "${textValue(internal.data.m_Name, owner)}" child ${index} requires m_DirectBlendParameter.`);
			}
			if (!Number.isFinite(timeScale) || timeScale === 0 || cycleOffset < 0 || cycleOffset > 1) {
				errors.push(`Blend Tree "${textValue(internal.data.m_Name, owner)}" child ${index} has invalid time scale or cycle offset.`);
			}
		}
		if (convertedChildren.length < 2) {
			return null;
		}
		if (blendType === 0) {
			return { blendTree: { parameter: textValue(internal.data.m_BlendParameter, "Blend"), children: convertedChildren } };
		}
		if (blendType === 4) {
			return {
				blendTree: {
					blendMode: "direct",
					normalizeWeights: booleanValue(internal.data.m_NormalizedBlendValues),
					children: convertedChildren,
				},
			};
		}
		const blendMode = blendType === 1 ? "directional" : blendType === 2 ? "freeformDirectional" : "cartesian";
		return {
			blendTree: {
				parameterX: textValue(internal.data.m_BlendParameter, "Blend X"),
				parameterY: textValue(internal.data.m_BlendParameterY, "Blend Y"),
				blendMode,
				children: convertedChildren,
			},
		};
	};

	const convertMachine = (machineId: string, owner: string, depth: number): IConvertedMachine | null => {
		if (depth > MAX_NESTING_DEPTH) {
			errors.push(`State machine "${owner}" exceeds the ${MAX_NESTING_DEPTH}-level nesting limit.`);
			return null;
		}
		if (convertingMachines.has(machineId)) {
			errors.push(`State machine "${owner}" contains a cyclic child state-machine reference.`);
			return null;
		}
		const serialized = byId.get(machineId);
		if (!serialized || serialized.typeName !== "AnimatorStateMachine") {
			errors.push(`Animator layer or child state machine "${owner}" references missing AnimatorStateMachine fileID ${machineId}.`);
			return null;
		}
		convertingMachines.add(machineId);
		const usedNames = new Set<string>();
		const stateNames = new Map<string, string>();
		const statePaths = new Map<string, string>();
		const childMachineNames = new Map<string, string>();
		const childStateEntries = entries(serialized.data.m_ChildStates);
		const childMachineEntries = entries(serialized.data.m_ChildStateMachines);
		for (const [index, child] of childStateEntries.entries()) {
			const stateRef = reference(child.m_State);
			const stateObject = stateRef ? byId.get(stateRef.fileId) : null;
			if (!stateRef || !stateObject || stateObject.typeName !== "AnimatorState") {
				errors.push(`State machine "${owner}" child state ${index} has a missing AnimatorState reference.`);
				continue;
			}
			const stateName = uniqueName(safeGraphName(textValue(stateObject.data.m_Name), `State ${stateRef.fileId}`), usedNames);
			stateNames.set(stateRef.fileId, stateName);
			statePaths.set(stateRef.fileId, stateName);
		}
		for (const [index, child] of childMachineEntries.entries()) {
			const machineRef = reference(child.m_StateMachine);
			const machineObject = machineRef ? byId.get(machineRef.fileId) : null;
			if (!machineRef || !machineObject || machineObject.typeName !== "AnimatorStateMachine") {
				errors.push(`State machine "${owner}" child machine ${index} has a missing AnimatorStateMachine reference.`);
				continue;
			}
			childMachineNames.set(machineRef.fileId, uniqueName(safeGraphName(textValue(machineObject.data.m_Name), `State Machine ${machineRef.fileId}`), usedNames));
		}

		const destinationName = (transition: Record<string, unknown>): string | null => {
			if (booleanValue(transition.m_IsExit)) {
				return "$exit";
			}
			const stateRef = reference(transition.m_DstState);
			if (stateRef && stateNames.has(stateRef.fileId)) {
				return stateNames.get(stateRef.fileId)!;
			}
			const machineRef = reference(transition.m_DstStateMachine);
			if (machineRef && childMachineNames.has(machineRef.fileId)) {
				return childMachineNames.get(machineRef.fileId)!;
			}
			unsupported.add(`A cross-level or missing transition destination in state machine "${owner}" was omitted.`);
			return null;
		};

		const convertTransition = (transitionRef: IUnityObjectReference, from: string): IAnimatorGraphTransition | null => {
			const transitionObject = byId.get(transitionRef.fileId);
			if (!transitionObject || (transitionObject.typeName !== "AnimatorStateTransition" && transitionObject.typeName !== "AnimatorTransition")) {
				errors.push(`Animator transition from "${from}" references missing transition fileID ${transitionRef.fileId}.`);
				return null;
			}
			if (booleanValue(transitionObject.data.m_Mute)) {
				unsupported.add("Muted Animator transitions were omitted.");
				return null;
			}
			const to = destinationName(transitionObject.data);
			if (!to) {
				return null;
			}
			const conditions = entries(transitionObject.data.m_Conditions)
				.map((condition) => conditionFromUnity(condition, unsupported))
				.filter((condition): condition is NonNullable<IAnimatorGraphTransition["conditions"]>[number] => condition !== null);
			const duration = numberValue(transitionObject.data.m_TransitionDuration, 0);
			const converted: IAnimatorGraphTransition = {
				from,
				to,
				...(conditions.length ? { conditions } : {}),
				...(booleanValue(transitionObject.data.m_HasExitTime) ? { exitTime: Math.max(0, numberValue(transitionObject.data.m_ExitTime, 0)) } : {}),
				...(duration > 0 ? { duration, durationMode: booleanValue(transitionObject.data.m_HasFixedDuration) ? "seconds" : "normalized" } : {}),
				...(to !== "$exit" && transitionObject.data.m_TransitionOffset !== undefined
					? { offset: Math.min(1, Math.max(0, numberValue(transitionObject.data.m_TransitionOffset, 0))) }
					: {}),
				interruptionSource: (["none", "source", "destination", "sourceThenDestination", "destinationThenSource"] as const)[
					Math.min(4, Math.max(0, numberValue(transitionObject.data.m_InterruptionSource, 0)))
				],
				orderedInterruption: booleanValue(transitionObject.data.m_OrderedInterruption),
				canTransitionToSelf: booleanValue(transitionObject.data.m_CanTransitionToSelf),
			};
			transitionCount++;
			return converted;
		};

		const states: IAnimatorGraphState[] = [];
		const transitions: IAnimatorGraphTransition[] = [];
		const entryTransitions: IAnimatorGraphEntryTransition[] = [];
		for (const child of childStateEntries) {
			const stateRef = reference(child.m_State);
			const stateObject = stateRef ? byId.get(stateRef.fileId) : null;
			const stateName = stateRef ? stateNames.get(stateRef.fileId) : null;
			if (!stateRef || !stateObject || !stateName) {
				continue;
			}
			const motion = reference(stateObject.data.m_Motion);
			if (!motion) {
				errors.push(`Animator state "${owner}/${stateName}" has no Motion.`);
				continue;
			}
			const convertedMotion = convertMotion(motion, `${owner}/${stateName}`, stateName, 0);
			if (!convertedMotion) {
				continue;
			}
			const rawSpeed = numberValue(stateObject.data.m_Speed, 1);
			const state: IAnimatorGraphState = {
				name: stateName,
				...convertedMotion,
				loop: true,
				speed: rawSpeed > 0 ? rawSpeed : 1,
				...(graphPosition(child.m_Position) ? { graphPosition: graphPosition(child.m_Position) } : {}),
			};
			states.push(state);
			stateCount++;
			for (const transitionEntry of entries(stateObject.data.m_Transitions)) {
				const transitionRef = reference(transitionEntry);
				const converted = transitionRef ? convertTransition(transitionRef, stateName) : null;
				if (converted) {
					transitions.push(converted);
				}
			}
			if (rawSpeed <= 0 || booleanValue(stateObject.data.m_Mirror) || booleanValue(stateObject.data.m_FootIK) || entries(stateObject.data.m_StateMachineBehaviours).length) {
				unsupported.add("Negative/zero state speed, state mirroring, Foot IK, and StateMachineBehaviour callbacks are not executed yet.");
			}
			if (
				booleanValue(stateObject.data.m_SpeedParameterActive) ||
				booleanValue(stateObject.data.m_MirrorParameterActive) ||
				booleanValue(stateObject.data.m_CycleOffsetParameterActive) ||
				booleanValue(stateObject.data.m_TimeParameterActive)
			) {
				unsupported.add("Animator state speed, mirror, cycle-offset, and time parameter bindings are not executed yet.");
			}
		}
		for (const transitionEntry of entries(serialized.data.m_AnyStateTransitions)) {
			const transitionRef = reference(transitionEntry);
			const converted = transitionRef ? convertTransition(transitionRef, "$any") : null;
			if (converted) {
				transitions.push(converted);
			}
		}
		for (const transitionEntry of entries(serialized.data.m_EntryTransitions)) {
			const transitionRef = reference(transitionEntry);
			const converted = transitionRef ? convertTransition(transitionRef, "$entry") : null;
			if (converted && converted.to !== "$exit") {
				entryTransitions.push({ to: converted.to, ...(converted.conditions?.length ? { conditions: converted.conditions } : {}) });
			}
		}
		for (const [index, pair] of entries(serialized.data.m_StateMachineTransitions).entries()) {
			const sourceRef = reference(pair.first ?? pair.m_StateMachine);
			const sourceName = sourceRef ? childMachineNames.get(sourceRef.fileId) : null;
			if (!sourceRef || !sourceName) {
				errors.push(`State machine "${owner}" child-machine transition ${index} references a missing child state machine.`);
				continue;
			}
			const singleTransition = record(pair.second);
			const transitionEntries = Array.isArray(pair.second) ? entries(pair.second) : singleTransition ? [singleTransition] : entries(pair.m_Transitions);
			if (!transitionEntries.length) {
				errors.push(`State machine "${owner}" child-machine transition ${index} has no transition references.`);
				continue;
			}
			for (const transitionEntry of transitionEntries) {
				const transitionRef = reference(transitionEntry);
				const converted = transitionRef ? convertTransition(transitionRef, sourceName) : null;
				if (converted) {
					transitions.push(converted);
				}
			}
		}

		const subStateMachines: NonNullable<IAnimatorGraphMachine["subStateMachines"]> = [];
		for (const child of childMachineEntries) {
			const machineRef = reference(child.m_StateMachine);
			const name = machineRef ? childMachineNames.get(machineRef.fileId) : null;
			if (!machineRef || !name) {
				continue;
			}
			const converted = convertMachine(machineRef.fileId, `${owner}/${name}`, depth + 1);
			if (!converted) {
				continue;
			}
			const id = `unity-state-machine:${machineRef.fileId}`;
			if (!subgraphs.has(id)) {
				subgraphs.set(id, {
					id,
					name,
					states: converted.states,
					transitions: converted.transitions,
					subStateMachines: converted.subStateMachines,
					entryTransitions: converted.entryTransitions,
					entryState: converted.entryState,
				});
			}
			for (const [stateFileId, statePath] of converted.statePaths) {
				statePaths.set(stateFileId, `${name}/${statePath}`);
			}
			subStateMachines.push({ name, subgraphId: id, ...(graphPosition(child.m_Position) ? { graphPosition: graphPosition(child.m_Position) } : {}) });
		}
		if (entries(serialized.data.m_StateMachineBehaviours).length) {
			unsupported.add("State-machine behaviour callbacks are preserved only as import diagnostics and are not executed.");
		}
		const defaultState = reference(serialized.data.m_DefaultState);
		const entryState = (defaultState && stateNames.get(defaultState.fileId)) || states[0]?.name || subStateMachines[0]?.name;
		convertingMachines.delete(machineId);
		return { states, transitions, entryTransitions, subStateMachines, entryState, stateNames, statePaths, childMachineNames };
	};

	const parameters: IAnimatorControllerImportedData["parameters"] = {};
	const parameterTypes: IAnimatorControllerImportedData["parameterTypes"] = {};
	const parameterEntries = entries(controllerObject.data.m_AnimatorParameters);
	if (parameterEntries.length > MAX_PARAMETERS) {
		errors.push(`Animator Controllers are limited to ${MAX_PARAMETERS} parameters.`);
	}
	for (const parameter of parameterEntries.slice(0, MAX_PARAMETERS)) {
		const name = textValue(parameter.m_Name).trim();
		if (!name || Object.prototype.hasOwnProperty.call(parameters, name)) {
			errors.push("Unity Animator parameter names must be non-empty and unique.");
			continue;
		}
		const type = numberValue(parameter.m_Type, 0);
		if (type === 1) {
			parameters[name] = numberValue(parameter.m_DefaultFloat, 0);
			parameterTypes[name] = "float";
		} else if (type === 3) {
			parameters[name] = Math.trunc(numberValue(parameter.m_DefaultInt, 0));
			parameterTypes[name] = "int";
		} else if (type === 4 || type === 9) {
			parameters[name] = booleanValue(parameter.m_DefaultBool);
			parameterTypes[name] = type === 9 ? "trigger" : "bool";
		} else {
			errors.push(`Animator parameter "${name}" uses unsupported Unity type ${type}.`);
		}
	}

	const layerEntries = entries(controllerObject.data.m_AnimatorLayers);
	if (!layerEntries.length) {
		throw new Error("Unity Animator Controller contains no layers.");
	}
	if (layerEntries.length > MAX_LAYERS) {
		errors.push(`Animator Controllers are limited to ${MAX_LAYERS} layers.`);
	}
	const layerNames: string[] = [];
	const usedLayerNames = new Set<string>();
	for (const [index, layer] of layerEntries.slice(0, MAX_LAYERS).entries()) {
		layerNames.push(uniqueName(safeGraphName(textValue(layer.m_Name), index === 0 ? "Base Layer" : `Layer ${index + 1}`), usedLayerNames));
	}
	const convertedLayers: IAnimatorControllerImportedLayer[] = [];
	const convertedMachines: Array<IConvertedMachine | null> = [];
	let baseMachine: IConvertedMachine | null = null;
	for (const [index, layer] of layerEntries.slice(0, MAX_LAYERS).entries()) {
		const machineRef = reference(layer.m_StateMachine);
		const converted = machineRef ? convertMachine(machineRef.fileId, layerNames[index], 0) : null;
		if (!converted) {
			convertedMachines[index] = null;
			errors.push(`Animator layer "${layerNames[index]}" has no valid state machine.`);
			continue;
		}
		convertedMachines[index] = converted;
		if (!converted.states.length) {
			errors.push(`Animator layer "${layerNames[index]}" has no direct Motion state; the current graph model requires at least one direct state.`);
		}
		if (index === 0) {
			baseMachine = converted;
			continue;
		}
		const syncedLayerIndex = Math.trunc(numberValue(layer.m_SyncedLayerIndex, -1));
		const maskRef = reference(layer.m_Mask);
		const synchronizedMotionOverrides: NonNullable<IAnimatorControllerImportedLayer["synchronizedMotionOverrides"]> = {};
		if (syncedLayerIndex >= 0 && syncedLayerIndex < index) {
			const sourceMachine = convertedMachines[syncedLayerIndex];
			for (const [overrideIndex, override] of entries(layer.m_Motions).entries()) {
				const stateRef = reference(override.m_State);
				const motionRef = reference(override.m_Motion);
				const statePath = stateRef ? sourceMachine?.statePaths.get(stateRef.fileId) : null;
				if (!stateRef || !statePath) {
					errors.push(`Animator synchronized layer "${layerNames[index]}" motion override ${overrideIndex} references a missing source state.`);
					continue;
				}
				if (!motionRef) {
					continue;
				}
				const convertedMotion = convertMotion(motionRef, `${layerNames[index]} override ${statePath}`, `${statePath} Override`, 0);
				if (convertedMotion) {
					synchronizedMotionOverrides[statePath] = convertedMotion;
				}
			}
		}
		convertedLayers.push({
			name: layerNames[index],
			weight: Math.min(1, Math.max(0, numberValue(layer.m_DefaultWeight, 1))),
			blendingMode: numberValue(layer.m_BlendingMode, 0) === 1 ? "additive" : "override",
			...(numberValue(layer.m_BlendingMode, 0) === 1 ? { referencePose: { normalizedTime: 0 } } : {}),
			...(maskRef ? { avatarMaskId: addMaskBinding(maskRef, `${layerNames[index]} Mask`, layerNames[index]) } : {}),
			...(syncedLayerIndex >= 0 && syncedLayerIndex < index ? { synchronizedLayer: syncedLayerIndex === 0 ? "$base" : layerNames[syncedLayerIndex] } : {}),
			...(syncedLayerIndex >= 0 ? { synchronizedTiming: booleanValue(layer.m_SyncedLayerAffectsTiming) } : {}),
			...(Object.keys(synchronizedMotionOverrides).length ? { synchronizedMotionOverrides } : {}),
			ikPass: booleanValue(layer.m_IKPass),
			states: converted.states,
			transitions: syncedLayerIndex >= 0 ? [] : converted.transitions,
			entryTransitions: syncedLayerIndex >= 0 ? [] : converted.entryTransitions,
			subStateMachines: converted.subStateMachines,
			entryState: converted.entryState,
		});
		if (Array.isArray(layer.m_Behaviours) && layer.m_Behaviours.length) {
			unsupported.add(
				"Unity MonoBehaviour references used by synchronized-layer behaviour overrides require explicit Babylon script bindings and are not imported automatically."
			);
		}
	}
	if (!baseMachine) {
		throw new Error("Unity Animator Controller base layer could not be converted.");
	}
	if (stateCount > MAX_STATES) {
		errors.push(`Animator Controllers are limited to ${MAX_STATES} states across all layers and subgraphs.`);
	}
	if (transitionCount > MAX_TRANSITIONS) {
		errors.push(`Animator Controllers are limited to ${MAX_TRANSITIONS} transitions across all layers and subgraphs.`);
	}
	const controllerName = safeGraphName(textValue(controllerObject.data.m_Name), basename(sourcePath, extname(sourcePath)) || "Animator Controller");
	const unsupportedFeatures = [...unsupported].sort();
	warnings.push(
		"Unity AnimationClip and AvatarMask references are emitted as explicit bindings; importing into a scene requires mapping them to existing Animation Groups and Avatar Masks."
	);
	if (unsupportedFeatures.length) {
		warnings.push(...unsupportedFeatures);
	}
	const controller: IAnimatorControllerImportedData = {
		name: controllerName,
		baseIKPass: booleanValue(layerEntries[0]?.m_IKPass),
		parameters,
		parameterTypes,
		states: baseMachine.states,
		transitions: baseMachine.transitions,
		entryTransitions: baseMachine.entryTransitions,
		subStateMachines: baseMachine.subStateMachines,
		entryState: baseMachine.entryState,
		subgraphs: [...subgraphs.values()],
		layers: convertedLayers,
	};
	return {
		document: {
			format: "babylonjs-editor-animator-controller",
			version: 1,
			sourceFormat: "unity-yaml",
			controller,
			motionBindings: [...motionBindings.values()].map((binding) => ({ ...binding, usedBy: [...binding.usedBy].sort() })),
			avatarMaskBindings: [...maskBindings.values()].map((binding) => ({ ...binding, usedBy: [...binding.usedBy].sort() })),
			unsupportedFeatures,
		},
		stateCount,
		transitionCount,
		blendTreeCount,
		layerCount: layerEntries.length,
		parameterCount: parameterEntries.length,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
}

export function isImportedAnimatorControllerDocument(value: unknown): value is IImportedAnimatorControllerDocument {
	const valueRecord = record(value);
	return (
		valueRecord?.format === "babylonjs-editor-animator-controller" &&
		valueRecord.version === 1 &&
		record(valueRecord.controller) !== null &&
		Array.isArray(valueRecord.motionBindings) &&
		Array.isArray(valueRecord.avatarMaskBindings)
	);
}
