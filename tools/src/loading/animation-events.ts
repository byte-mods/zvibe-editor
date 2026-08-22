import { AnimationEvent } from "@babylonjs/core/Animations/animationEvent";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Scene } from "@babylonjs/core/scene";

import { scriptsDictionary } from "./script/apply";

export const animationEventActions = ["log", "setEnabled", "playAnimationGroup", "stopAnimationGroup", "scriptMethod"] as const;
export const animationEventMissingMethodPolicies = ["error", "warning", "ignore"] as const;
export type AnimationEventAction = (typeof animationEventActions)[number];
export type AnimationEventMissingMethodPolicy = (typeof animationEventMissingMethodPolicies)[number];

/** Persisted, JSON-safe callback definition shared by editor preview and exported scenes. */
export interface IAnimationEventDefinition {
	frame: number;
	action: AnimationEventAction;
	nodeId?: string;
	nodeName?: string;
	enabled?: boolean;
	animationGroupName?: string;
	loop?: boolean;
	parameter?: string;
	onlyOnce?: boolean;
	methodName?: string;
	scriptKey?: string;
	arguments?: unknown[];
	missingMethodPolicy?: AnimationEventMissingMethodPolicy;
}

/** One animation group's bounded event collection. */
export interface IAnimationEventConfiguration {
	groupName: string;
	revision: number;
	events: IAnimationEventDefinition[];
}

/** Bounded runtime evidence that distinguishes successful, reported, and ignored dispatches. */
export interface IAnimationEventLogEntry {
	groupName: string;
	frame: number;
	action: AnimationEventAction;
	parameter: string | null;
	status: "executed" | "warning" | "error" | "ignored";
	invokedMethods: number;
	message: string | null;
}

const maximumConfigurations = 128;
const maximumEventsPerConfiguration = 4096;
const maximumArguments = 16;
const maximumArgumentNodes = 256;
const maximumArgumentStringLength = 2048;
const maximumArgumentBytes = 16 * 1024;
const maximumLogEntries = 128;
const methodNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const eventFields = [
	"frame",
	"action",
	"nodeId",
	"nodeName",
	"enabled",
	"animationGroupName",
	"loop",
	"parameter",
	"onlyOnce",
	"methodName",
	"scriptKey",
	"arguments",
	"missingMethodPolicy",
] as const;

/** Rejects arrays and primitives before field-level validation reads untrusted metadata. */
function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

/** Normalizes identity-like strings without retaining invisible edge whitespace. */
function boundedText(value: unknown, label: string, maximum = 1024): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum) {
		throw new Error(`${label} must be a non-empty string with at most ${maximum} characters.`);
	}
	return value.trim();
}

/** Clones JSON-like method arguments while rejecting executable, cyclic, non-finite, or excessively deep state. */
function normalizeArgument(value: unknown, budget: { nodes: number }, depth = 0): unknown {
	budget.nodes++;
	if (budget.nodes > maximumArgumentNodes || depth > 8) {
		throw new Error(`Animation Event arguments may contain at most ${maximumArgumentNodes} values and eight nested levels.`);
	}
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Animation Event numeric arguments must be finite.");
		}
		return value;
	}
	if (typeof value === "string") {
		if (value.length > maximumArgumentStringLength) {
			throw new Error(`Animation Event string arguments are limited to ${maximumArgumentStringLength} characters.`);
		}
		return value;
	}
	if (Array.isArray(value)) {
		if (value.length > 64) {
			throw new Error("Nested Animation Event argument arrays are limited to 64 entries.");
		}
		return value.map((entry) => normalizeArgument(entry, budget, depth + 1));
	}
	const source = record(value, "Animation Event argument");
	const prototype = Object.getPrototypeOf(source);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error("Animation Event argument objects must be plain JSON-like objects.");
	}
	const keys = Object.keys(source);
	if (keys.length > 64 || keys.some((key) => !key || key.length > 128 || ["__proto__", "constructor", "prototype"].includes(key))) {
		throw new Error("Animation Event argument objects require at most 64 safe keys of at most 128 characters.");
	}
	return Object.fromEntries(keys.map((key) => [key, normalizeArgument(source[key], budget, depth + 1)]));
}

/** Validates action-specific fields while preserving legacy built-in callback behavior. */
function normalizeEvent(value: unknown, index: number): IAnimationEventDefinition {
	const source = record(value, `Animation Event ${index}`);
	const unknown = Object.keys(source).filter((key) => !eventFields.includes(key as (typeof eventFields)[number]));
	if (unknown.length) {
		throw new Error(`Animation Event ${index} has unknown fields: ${unknown.join(", ")}.`);
	}
	if (typeof source.frame !== "number" || !Number.isFinite(source.frame)) {
		throw new Error(`Animation Event ${index} frame must be finite.`);
	}
	if (!animationEventActions.includes(source.action as AnimationEventAction)) {
		throw new Error(`Animation Event ${index} action is unsupported.`);
	}
	const action = source.action as AnimationEventAction;
	const event: IAnimationEventDefinition = {
		frame: source.frame,
		action,
		...(source.nodeId !== undefined ? { nodeId: boundedText(source.nodeId, `Animation Event ${index} nodeId`) } : {}),
		...(source.nodeName !== undefined ? { nodeName: boundedText(source.nodeName, `Animation Event ${index} nodeName`) } : {}),
		...(source.enabled !== undefined ? { enabled: Boolean(source.enabled) } : {}),
		...(source.animationGroupName !== undefined ? { animationGroupName: boundedText(source.animationGroupName, `Animation Event ${index} animationGroupName`) } : {}),
		...(source.loop !== undefined ? { loop: Boolean(source.loop) } : {}),
		...(source.parameter !== undefined ? { parameter: boundedText(source.parameter, `Animation Event ${index} parameter`, 2048) } : {}),
		...(source.onlyOnce !== undefined ? { onlyOnce: Boolean(source.onlyOnce) } : {}),
	};
	for (const booleanField of ["enabled", "loop", "onlyOnce"] as const) {
		if (source[booleanField] !== undefined && typeof source[booleanField] !== "boolean") {
			throw new Error(`Animation Event ${index} ${booleanField} must be boolean.`);
		}
	}
	if (action === "setEnabled" && !event.nodeId && !event.nodeName) {
		throw new Error(`Animation Event ${index} setEnabled requires nodeId or nodeName.`);
	}
	if ((action === "playAnimationGroup" || action === "stopAnimationGroup") && !event.animationGroupName) {
		throw new Error(`Animation Event ${index} ${action} requires animationGroupName.`);
	}
	if (action === "scriptMethod") {
		const methodName = boundedText(source.methodName, `Animation Event ${index} methodName`, 128);
		if (!methodNamePattern.test(methodName)) {
			throw new Error(`Animation Event ${index} methodName must be a JavaScript identifier.`);
		}
		const missingMethodPolicy = (source.missingMethodPolicy ?? "error") as AnimationEventMissingMethodPolicy;
		if (!animationEventMissingMethodPolicies.includes(missingMethodPolicy)) {
			throw new Error(`Animation Event ${index} missingMethodPolicy must be error, warning, or ignore.`);
		}
		const inputArguments = source.arguments ?? [];
		if (!Array.isArray(inputArguments) || inputArguments.length > maximumArguments) {
			throw new Error(`Animation Event ${index} arguments must contain at most ${maximumArguments} entries.`);
		}
		const budget = { nodes: 0 };
		const args = inputArguments.map((argument) => normalizeArgument(argument, budget));
		if (new TextEncoder().encode(JSON.stringify(args)).byteLength > maximumArgumentBytes) {
			throw new Error(`Animation Event ${index} arguments exceed ${maximumArgumentBytes} serialized bytes.`);
		}
		event.methodName = methodName;
		event.missingMethodPolicy = missingMethodPolicy;
		event.arguments = args;
		if (source.scriptKey !== undefined) {
			event.scriptKey = boundedText(source.scriptKey, `Animation Event ${index} scriptKey`);
		}
	}
	return event;
}

/** Normalizes persisted Animation Event metadata and migrates legacy built-in actions without changing their behavior. */
export function normalizeAnimationEventConfigurations(value: unknown): IAnimationEventConfiguration[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (!Array.isArray(value) || value.length > maximumConfigurations) {
		throw new Error(`Animation Event configurations must be an array with at most ${maximumConfigurations} groups.`);
	}
	const configurations = value.map((entry, configurationIndex) => {
		const source = record(entry, `Animation Event configuration ${configurationIndex}`);
		const unknown = Object.keys(source).filter((key) => !["groupName", "revision", "events"].includes(key));
		if (unknown.length) {
			throw new Error(`Animation Event configuration ${configurationIndex} has unknown fields: ${unknown.join(", ")}.`);
		}
		const groupName = boundedText(source.groupName, `Animation Event configuration ${configurationIndex} groupName`);
		const revision = source.revision ?? 1;
		if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
			throw new Error(`Animation Event configuration ${configurationIndex} revision must be a positive safe integer.`);
		}
		if (!Array.isArray(source.events) || source.events.length > maximumEventsPerConfiguration) {
			throw new Error(`Animation Event configuration ${configurationIndex} requires at most ${maximumEventsPerConfiguration} events.`);
		}
		return { groupName, revision: revision as number, events: source.events.map(normalizeEvent) };
	});
	if (new Set(configurations.map((configuration) => configuration.groupName)).size !== configurations.length) {
		throw new Error("Animation Event configuration group names must be unique.");
	}
	return configurations;
}

/** Uses Babylon's canonical name lookup so editor and exported runtime resolve the same group. */
function resolveGroup(scene: Scene, name: string): AnimationGroup | null {
	return scene.getAnimationGroupByName(name);
}

/** Keeps runtime evidence bounded even when looping clips dispatch indefinitely. */
function appendLog(scene: Scene, entry: IAnimationEventLogEntry): void {
	scene.metadata ??= {};
	const log = (scene.metadata.babylonEditorAnimationEventLog ??= []);
	log.push(entry);
	if (log.length > maximumLogEntries) {
		log.splice(0, log.length - maximumLogEntries);
	}
}

/** Resolves an explicit target or falls back to the first animated object, matching clip ownership. */
function eventTarget(scene: Scene, group: AnimationGroup, event: IAnimationEventDefinition): object | null {
	if (event.nodeId === "scene" || event.nodeName === "scene") {
		return scene;
	}
	if (event.nodeId) {
		return scene.getNodeById(event.nodeId);
	}
	if (event.nodeName) {
		return scene.getNodeByName(event.nodeName);
	}
	return (group.targetedAnimations[0]?.target as object | undefined) ?? null;
}

/** Applies the authored reporting policy without turning a missing receiver into a render-loop exception. */
function missingMethod(scene: Scene, groupName: string, event: IAnimationEventDefinition, message: string): void {
	const policy = event.missingMethodPolicy ?? "error";
	appendLog(scene, {
		groupName,
		frame: event.frame,
		action: event.action,
		parameter: event.parameter ?? null,
		status: policy === "ignore" ? "ignored" : policy,
		invokedMethods: 0,
		message,
	});
	if (policy === "error") {
		console.error(message);
	} else if (policy === "warning") {
		console.warn(message);
	}
}

/** Records receiver failures consistently and prevents user-code details from growing evidence without bound. */
function invocationFailure(scene: Scene, groupName: string, event: IAnimationEventDefinition, scriptKey: string, error: unknown, invokedMethods: number): string {
	const message = `Animation Event method "${event.methodName}" on script "${scriptKey}" failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2048);
	appendLog(scene, { groupName, frame: event.frame, action: event.action, parameter: event.parameter ?? null, status: "error", invokedMethods, message });
	console.error(message);
	return message;
}

/** Converts a missing built-in action target into bounded evidence instead of a render-loop exception or false success. */
function actionFailure(scene: Scene, groupName: string, event: IAnimationEventDefinition, message: string): void {
	appendLog(scene, { groupName, frame: event.frame, action: event.action, parameter: event.parameter ?? null, status: "error", invokedMethods: 0, message });
	console.error(message);
}

/** Executes one normalized event against the live scene and shared attached-script registry. */
export function executeAnimationEvent(scene: Scene, groupName: string, value: unknown): void {
	const event = normalizeEvent(value, 0);
	const group = resolveGroup(scene, groupName);
	if (!group) {
		missingMethod(scene, groupName, event, `Animation Event target group "${groupName}" is unavailable.`);
		return;
	}
	if (event.action === "scriptMethod") {
		const target = eventTarget(scene, group, event);
		const scripts = target ? ((scriptsDictionary as unknown as Map<object, Array<{ key: string; instance: object }>>).get(target) ?? []) : [];
		const candidates = scripts.filter((script) => !event.scriptKey || script.key === event.scriptKey);
		if (!target || candidates.length === 0) {
			missingMethod(
				scene,
				groupName,
				event,
				`Animation Event method "${event.methodName}"${event.scriptKey ? ` on script "${event.scriptKey}"` : ""} was not found on the target object.`
			);
			return;
		}
		let invokedMethods = 0;
		let callableMethods = 0;
		let synchronousFailures = 0;
		for (const receiver of candidates) {
			try {
				const method = (receiver.instance as Record<string, unknown>)[event.methodName!];
				if (typeof method !== "function") {
					continue;
				}
				callableMethods++;
				// Each receiver gets an isolated copy so one script cannot alter another script's event payload.
				const result = method.apply(receiver.instance, structuredClone(event.arguments ?? []));
				invokedMethods++;
				if (result && (typeof result === "object" || typeof result === "function")) {
					// Promise assimilation safely captures arbitrary thenables instead of leaking an unhandled rejection.
					void Promise.resolve(result).catch((error) => invocationFailure(scene, groupName, event, receiver.key, error, invokedMethods));
				}
			} catch (error) {
				synchronousFailures++;
				invocationFailure(scene, groupName, event, receiver.key, error, invokedMethods);
			}
		}
		if (callableMethods === 0 && synchronousFailures === 0) {
			missingMethod(
				scene,
				groupName,
				event,
				`Animation Event method "${event.methodName}"${event.scriptKey ? ` on script "${event.scriptKey}"` : ""} was not found on the target object.`
			);
		} else if (synchronousFailures === 0) {
			appendLog(scene, { groupName, frame: event.frame, action: event.action, parameter: event.parameter ?? null, status: "executed", invokedMethods, message: null });
		}
		return;
	}
	if (event.action === "setEnabled") {
		const node = event.nodeId ? scene.getNodeById(event.nodeId) : scene.getNodeByName(event.nodeName!);
		if (!node) {
			actionFailure(scene, groupName, event, `Animation Event node "${event.nodeId ?? event.nodeName}" is unavailable.`);
			return;
		}
		node.setEnabled(event.enabled ?? true);
	} else if (event.action === "playAnimationGroup") {
		const targetGroup = resolveGroup(scene, event.animationGroupName!);
		if (!targetGroup) {
			actionFailure(scene, groupName, event, `Animation Event group "${event.animationGroupName}" is unavailable.`);
			return;
		}
		targetGroup.play(event.loop ?? true);
	} else if (event.action === "stopAnimationGroup") {
		const targetGroup = resolveGroup(scene, event.animationGroupName!);
		if (!targetGroup) {
			actionFailure(scene, groupName, event, `Animation Event group "${event.animationGroupName}" is unavailable.`);
			return;
		}
		targetGroup.stop();
	}
	appendLog(scene, { groupName, frame: event.frame, action: event.action, parameter: event.parameter ?? null, status: "executed", invokedMethods: 0, message: null });
}

/** Installs normalized editor-authored AnimationEvent callbacks in preview, additive, headless, and exported scenes. */
export function configureAnimationEvents(scene: Scene): { configuredGroups: number; configuredEvents: number; warnings: string[] } {
	scene.metadata ??= {};
	const configurations = normalizeAnimationEventConfigurations(scene.metadata.babylonEditorAnimationEvents);
	scene.metadata.babylonEditorAnimationEvents = configurations;
	let configuredGroups = 0;
	let configuredEvents = 0;
	const warnings: string[] = [];
	for (const configuration of configurations) {
		const group = resolveGroup(scene, configuration.groupName);
		const animation = group?.targetedAnimations[0]?.animation;
		if (!group || !animation) {
			warnings.push(`Animation group "${configuration.groupName}" has no first track for Animation Events.`);
			continue;
		}
		for (const frame of new Set(animation.getEvents().map((event) => event.frame))) {
			animation.removeEvents(frame);
		}
		for (const event of configuration.events) {
			animation.addEvent(new AnimationEvent(event.frame, () => executeAnimationEvent(scene, group.name, event), event.onlyOnce ?? false));
		}
		configuredGroups++;
		configuredEvents += configuration.events.length;
	}
	return { configuredGroups, configuredEvents, warnings };
}
