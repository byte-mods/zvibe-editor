import { Scene } from "@babylonjs/core/scene";

import { IAnimatorGraphState } from "./animator-graph";

export interface IAnimatorWriteDefaultsController {
	id: string;
}

export interface IAnimatorWriteDefaultsAnimationGroup {
	targetedAnimations: Array<{ target: any; animation: { targetProperty: string } }>;
	mask: { disabled: boolean; retainsTarget(name: string): boolean } | null;
}

export interface IAnimatorWriteDefaultsDiagnostics {
	controllerId: string;
	enabled: boolean;
	invocations: number;
	resetCount: number;
	knownPropertyCount: number;
	activePropertyCount: number;
	lastStateName: string | null;
	lastLayerName: string | null;
	lastResetProperties: string[];
	warnings: string[];
	algorithm: "bounded-controller-default-snapshot-v1";
}

interface IPropertySnapshot {
	target: any;
	targetName: string;
	propertyPath: string;
	value: any;
}

interface IControllerDefaults {
	properties: IPropertySnapshot[];
	diagnostics: IAnimatorWriteDefaultsDiagnostics;
}

const defaultsByScene = new WeakMap<Scene, Map<string, IControllerDefaults>>();
const maximumKnownProperties = 4096;
const maximumReportedProperties = 128;

function cloneValue(value: any): any {
	if (value === null || value === undefined || typeof value !== "object") {
		return value;
	}
	if (typeof value.clone === "function") {
		return value.clone();
	}
	if (ArrayBuffer.isView(value)) {
		return new (value.constructor as any)(value);
	}
	return structuredClone(value);
}

function propertyOwner(target: any, propertyPath: string): { owner: any; key: string } | null {
	const segments = propertyPath.split(".");
	if (!segments.length || segments.some((segment) => !segment || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
		return null;
	}
	let owner = target;
	for (const segment of segments.slice(0, -1)) {
		owner = owner?.[segment];
		if (owner === null || owner === undefined) {
			return null;
		}
	}
	return { owner, key: segments[segments.length - 1]! };
}

function readProperty(target: any, propertyPath: string): any {
	const resolved = propertyOwner(target, propertyPath);
	return resolved ? resolved.owner[resolved.key] : undefined;
}

function writeProperty(snapshot: IPropertySnapshot): boolean {
	const resolved = propertyOwner(snapshot.target, snapshot.propertyPath);
	if (!resolved) {
		return false;
	}
	const current = resolved.owner[resolved.key];
	const replacement = cloneValue(snapshot.value);
	if (current && replacement && typeof current.copyFrom === "function") {
		current.copyFrom(replacement);
	} else if (ArrayBuffer.isView(current) && ArrayBuffer.isView(replacement) && typeof (current as any).set === "function") {
		(current as any).set(replacement as any);
	} else {
		resolved.owner[resolved.key] = replacement;
	}
	return true;
}

function animationGroupNames(value: unknown, names = new Set<string>(), visited = new Set<object>()): Set<string> {
	if (!value || typeof value !== "object" || visited.has(value as object)) {
		return names;
	}
	visited.add(value as object);
	if (Array.isArray(value)) {
		value.forEach((entry) => animationGroupNames(entry, names, visited));
		return names;
	}
	for (const [key, entry] of Object.entries(value)) {
		if (key === "animationGroup" && typeof entry === "string") {
			names.add(entry);
		} else {
			animationGroupNames(entry, names, visited);
		}
	}
	return names;
}

function targetedAnimations(groups: IAnimatorWriteDefaultsAnimationGroup[]): Array<{ target: any; animation: { targetProperty: string } }> {
	return groups.flatMap(
		(group) =>
			group.targetedAnimations.filter((targeted) => {
				const targetName = String(targeted.target?.name ?? "");
				return !group.mask || group.mask.disabled || group.mask.retainsTarget(targetName);
			}) as Array<{ target: any; animation: { targetProperty: string } }>
	);
}

function captureControllerDefaults(scene: Scene, controller: IAnimatorWriteDefaultsController): IControllerDefaults {
	let sceneDefaults = defaultsByScene.get(scene);
	if (!sceneDefaults) {
		sceneDefaults = new Map();
		defaultsByScene.set(scene, sceneDefaults);
	}
	const existing = sceneDefaults.get(controller.id);
	if (existing) {
		return existing;
	}
	const warnings: string[] = [];
	const groups = [...animationGroupNames(controller)].map((name) => scene.getAnimationGroupByName(name)).filter((group): group is NonNullable<typeof group> => !!group);
	const properties: IPropertySnapshot[] = [];
	for (const targeted of targetedAnimations(groups)) {
		const propertyPath = targeted.animation.targetProperty;
		if (properties.some((snapshot) => snapshot.target === targeted.target && snapshot.propertyPath === propertyPath)) {
			continue;
		}
		if (properties.length >= maximumKnownProperties) {
			warnings.push(`Write Defaults captures at most ${maximumKnownProperties} animated properties per controller.`);
			break;
		}
		try {
			const value = readProperty(targeted.target, propertyPath);
			if (value === undefined) {
				warnings.push(`Could not capture ${String(targeted.target?.name ?? "unnamed")}.${propertyPath}.`);
				continue;
			}
			properties.push({ target: targeted.target, targetName: String(targeted.target?.name ?? targeted.target?.id ?? "unnamed"), propertyPath, value: cloneValue(value) });
		} catch {
			warnings.push(`Could not clone ${String(targeted.target?.name ?? "unnamed")}.${propertyPath}.`);
		}
	}
	const captured: IControllerDefaults = {
		properties,
		diagnostics: {
			controllerId: controller.id,
			enabled: false,
			invocations: 0,
			resetCount: 0,
			knownPropertyCount: properties.length,
			activePropertyCount: 0,
			lastStateName: null,
			lastLayerName: null,
			lastResetProperties: [],
			warnings: warnings.slice(0, maximumReportedProperties),
			algorithm: "bounded-controller-default-snapshot-v1",
		},
	};
	sceneDefaults.set(controller.id, captured);
	return captured;
}

/** Restores the controller's captured defaults for bindings not written by the entering state. */
export function applyAnimatorWriteDefaults(
	scene: Scene,
	controller: IAnimatorWriteDefaultsController,
	layerName: string,
	state: IAnimatorGraphState,
	activeGroups: IAnimatorWriteDefaultsAnimationGroup[]
): IAnimatorWriteDefaultsDiagnostics {
	const captured = captureControllerDefaults(scene, controller);
	const diagnostics = captured.diagnostics;
	diagnostics.enabled = state.writeDefaultValues === true;
	diagnostics.lastStateName = state.name;
	diagnostics.lastLayerName = layerName;
	diagnostics.lastResetProperties = [];
	const active = targetedAnimations(activeGroups);
	diagnostics.activePropertyCount = new Set(
		active.map((targeted) => `${String(targeted.target?.uniqueId ?? targeted.target?.id ?? targeted.target?.name)}:${targeted.animation.targetProperty}`)
	).size;
	if (!diagnostics.enabled) {
		return structuredClone(diagnostics);
	}
	diagnostics.invocations++;
	for (const snapshot of captured.properties) {
		if (active.some((targeted) => targeted.target === snapshot.target && targeted.animation.targetProperty === snapshot.propertyPath)) {
			continue;
		}
		try {
			if (writeProperty(snapshot)) {
				diagnostics.resetCount++;
				if (diagnostics.lastResetProperties.length < maximumReportedProperties) {
					diagnostics.lastResetProperties.push(`${snapshot.targetName}.${snapshot.propertyPath}`);
				}
			}
		} catch {
			const warning = `Could not restore ${snapshot.targetName}.${snapshot.propertyPath}.`;
			if (!diagnostics.warnings.includes(warning) && diagnostics.warnings.length < maximumReportedProperties) {
				diagnostics.warnings.push(warning);
			}
		}
	}
	return structuredClone(diagnostics);
}

export function getAnimatorWriteDefaultsDiagnostics(scene: Scene, controllerId: string): IAnimatorWriteDefaultsDiagnostics {
	return structuredClone(
		defaultsByScene.get(scene)?.get(controllerId)?.diagnostics ?? {
			controllerId,
			enabled: false,
			invocations: 0,
			resetCount: 0,
			knownPropertyCount: 0,
			activePropertyCount: 0,
			lastStateName: null,
			lastLayerName: null,
			lastResetProperties: [],
			warnings: [],
			algorithm: "bounded-controller-default-snapshot-v1",
		}
	);
}

export function deleteAnimatorWriteDefaults(scene: Scene, controllerId: string): void {
	defaultsByScene.get(scene)?.delete(controllerId);
}
