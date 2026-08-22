import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { AnimationKeyInterpolation } from "@babylonjs/core/Animations/animationKey";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";

export const UNITY_ANIMATION_CLIP_METADATA_KEY = "babylonEditorUnityAnimationClip";
export const UNITY_ANIMATION_ACTIVE_STATE_PROPERTY = "__babylonEditorUnityActiveState";
export const UNITY_ANIMATION_OBJECT_REFERENCE_PROPERTY_PREFIX = "__babylonEditorUnityObjectReference_";
export const UNITY_ANIMATION_RUNTIME_EVIDENCE_KEY = "babylonEditorUnityAnimationRuntimeEvidence";

export interface IUnityAnimationObjectReference {
	key: string;
	fileId: string;
	guid: string | null;
	type: number;
}

export interface IUnityAnimationObjectReferenceCurve {
	id: string;
	target: string;
	attribute: string;
	trackProperty: string;
	references: IUnityAnimationObjectReference[];
	keys: Array<{ frame: number; referenceKey: string }>;
}

export type UnityAnimationObjectReferenceBindingValue =
	| { kind: "null" }
	| { kind: "number"; value: number }
	| { kind: "boolean"; value: boolean }
	| { kind: "string"; value: string }
	| { kind: "node"; id: string }
	| { kind: "material"; id: string }
	| { kind: "texture"; path: string };

export interface IUnityAnimationObjectReferenceBinding {
	curveId: string;
	propertyPath: string;
	references: Array<{ referenceKey: string; value: UnityAnimationObjectReferenceBindingValue }>;
}

export interface IUnityAnimationClipRuntimeEvidence {
	configured: boolean;
	activeStateTrackCount: number;
	objectReferenceTrackCount: number;
	boundObjectReferenceCurveCount: number;
	unresolvedObjectReferenceCurveIds: string[];
	lastAppliedActiveState: { targetName: string; enabled: boolean } | null;
	lastAppliedObjectReference: { curveId: string; targetName: string; propertyPath: string; referenceKey: string; valueKind: string } | null;
	lastError: string | null;
}

interface IRuntimeProperty {
	value: number;
	apply: (value: number) => void;
}

const runtimeProperties = new WeakMap<object, Map<string, IRuntimeProperty>>();
const textureCaches = new WeakMap<Scene, Map<string, Texture>>();

/** Validates the bounded dotted destination property path used by Unity object-reference curves. */
export function validateUnityAnimationDestinationPropertyPath(value: string): string {
	const path = value.trim();
	if (!/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*){0,15}$/.test(path)) {
		throw new Error("Unity object-reference destination properties must be safe dotted paths with at most 16 segments.");
	}
	if (path.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment))) {
		throw new Error("Unity object-reference destination properties cannot contain prototype-related segments.");
	}
	return path;
}

function targetName(target: any): string {
	return typeof target?.name === "string" && target.name ? target.name : typeof target?.id === "string" && target.id ? target.id : "unnamed target";
}

function installRuntimeProperty(target: object, property: string, apply: (value: number) => void): void {
	let properties = runtimeProperties.get(target);
	if (!properties) {
		properties = new Map();
		runtimeProperties.set(target, properties);
	}
	const existing = properties.get(property);
	if (existing) {
		existing.apply = apply;
		return;
	}
	const descriptor = Object.getOwnPropertyDescriptor(target, property);
	if (descriptor && !descriptor.configurable) {
		throw new Error(`Unity animation runtime property "${property}" conflicts with a non-configurable target property.`);
	}
	const runtime: IRuntimeProperty = { value: 0, apply };
	properties.set(property, runtime);
	Object.defineProperty(target, property, {
		configurable: true,
		enumerable: false,
		get: () => runtime.value,
		set: (value: unknown) => {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return;
			}
			runtime.value = value;
			runtime.apply(value);
		},
	});
}

function textureUrl(rootUrl: string, path: string): string {
	if (/^(?:data:|blob:|https?:\/\/|file:|\/)/i.test(path)) {
		return path;
	}
	return `${rootUrl}${rootUrl && !rootUrl.endsWith("/") ? "/" : ""}${path}`;
}

function resolveBindingValue(scene: Scene, rootUrl: string, value: UnityAnimationObjectReferenceBindingValue): unknown {
	switch (value.kind) {
		case "null":
			return null;
		case "number":
		case "boolean":
		case "string":
			return value.value;
		case "node": {
			const node = scene.getNodeById(value.id);
			if (!node) {
				throw new Error(`Unity object-reference binding node id "${value.id}" is no longer available.`);
			}
			return node;
		}
		case "material": {
			const material = scene.getMaterialById(value.id);
			if (!material) {
				throw new Error(`Unity object-reference binding material id "${value.id}" is no longer available.`);
			}
			return material;
		}
		case "texture": {
			const url = textureUrl(rootUrl, value.path);
			let cache = textureCaches.get(scene);
			if (!cache) {
				cache = new Map();
				textureCaches.set(scene, cache);
			}
			let texture = cache.get(url);
			if (!texture) {
				texture = new Texture(url, scene, false, false);
				cache.set(url, texture);
			}
			return texture;
		}
	}
}

function assignProperty(target: any, propertyPath: string, value: unknown): void {
	const segments = validateUnityAnimationDestinationPropertyPath(propertyPath).split(".");
	let parent = target;
	for (const segment of segments.slice(0, -1)) {
		parent = parent?.[segment];
		if (parent === null || parent === undefined || (typeof parent !== "object" && typeof parent !== "function")) {
			throw new Error(`Unity object-reference destination "${propertyPath}" cannot resolve segment "${segment}" on ${targetName(target)}.`);
		}
	}
	const property = segments[segments.length - 1];
	if (typeof parent?.[property] === "function") {
		throw new Error(`Unity object-reference destination "${propertyPath}" cannot replace a method.`);
	}
	parent[property] = value;
}

function clipMetadata(group: AnimationGroup): Record<string, any> | null {
	const metadata = group.metadata?.[UNITY_ANIMATION_CLIP_METADATA_KEY];
	return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null;
}

function restoreMissingObjectReferenceTracks(group: AnimationGroup, scene: Scene, metadata: Record<string, any>, curves: IUnityAnimationObjectReferenceCurve[]): void {
	const importBindings = Array.isArray(group.metadata?.babylonEditorAnimationImportBindings) ? group.metadata.babylonEditorAnimationImportBindings : [];
	for (const curve of curves) {
		if (group.targetedAnimations.some((targeted) => targeted.animation.targetProperty === curve.trackProperty)) {
			continue;
		}
		const binding = importBindings.find((candidate: any) => candidate?.sourceTarget === curve.target && candidate?.kind === "sprite");
		if (!binding) {
			continue;
		}
		const managers = (scene.spriteManagers ?? []).filter((manager) => !binding.managerName || manager.name === binding.managerName);
		const sprites = managers.flatMap((manager) => manager.sprites.filter((sprite) => sprite.name === binding.targetName));
		if (sprites.length !== 1) {
			continue;
		}
		const referenceIndexes = new Map(curve.references.map((reference, index) => [reference.key, index]));
		const animation = new Animation(
			`${curve.target} ${curve.attribute}`,
			curve.trackProperty,
			Number.isFinite(metadata.sampleRate) ? metadata.sampleRate : 60,
			Animation.ANIMATIONTYPE_FLOAT,
			metadata.loopTime ? Animation.ANIMATIONLOOPMODE_CYCLE : Animation.ANIMATIONLOOPMODE_CONSTANT
		);
		animation.setKeys(
			curve.keys.map((key) => {
				const value = referenceIndexes.get(key.referenceKey);
				if (value === undefined) {
					throw new Error(`Unity object-reference curve "${curve.id}" contains unknown reference key "${key.referenceKey}".`);
				}
				return { frame: key.frame, value, interpolation: AnimationKeyInterpolation.STEP };
			})
		);
		group.addTargetedAnimation(animation, sprites[0]);
	}
}

/** Installs stepped active-state and exact object-reference execution for converted Unity AnimationClips. */
export function configureUnityAnimationClipRuntime(scene: Scene, rootUrl = ""): IUnityAnimationClipRuntimeEvidence[] {
	const results: IUnityAnimationClipRuntimeEvidence[] = [];
	for (const group of scene.animationGroups) {
		const metadata = clipMetadata(group);
		if (!metadata) {
			continue;
		}
		const curves = (Array.isArray(metadata.objectReferenceCurves) ? metadata.objectReferenceCurves : []) as IUnityAnimationObjectReferenceCurve[];
		restoreMissingObjectReferenceTracks(group, scene, metadata, curves);
		const bindings = (Array.isArray(metadata.objectReferenceBindings) ? metadata.objectReferenceBindings : []) as IUnityAnimationObjectReferenceBinding[];
		const bindingsByCurve = new Map(bindings.map((binding) => [binding.curveId, binding]));
		const evidence: IUnityAnimationClipRuntimeEvidence = {
			configured: true,
			activeStateTrackCount: 0,
			objectReferenceTrackCount: 0,
			boundObjectReferenceCurveCount: 0,
			unresolvedObjectReferenceCurveIds: [],
			lastAppliedActiveState: null,
			lastAppliedObjectReference: null,
			lastError: null,
		};
		for (const targeted of group.targetedAnimations) {
			const property = targeted.animation.targetProperty;
			if (property === UNITY_ANIMATION_ACTIVE_STATE_PROPERTY) {
				evidence.activeStateTrackCount++;
				const target = targeted.target as any;
				if (typeof target?.setEnabled !== "function") {
					evidence.lastError = `Unity active-state target "${targetName(target)}" does not expose setEnabled.`;
					continue;
				}
				installRuntimeProperty(target, property, (value) => {
					const enabled = value >= 0.5;
					target.setEnabled(enabled);
					evidence.lastAppliedActiveState = { targetName: targetName(target), enabled };
				});
				continue;
			}
			if (!property.startsWith(UNITY_ANIMATION_OBJECT_REFERENCE_PROPERTY_PREFIX)) {
				continue;
			}
			evidence.objectReferenceTrackCount++;
			const curve = curves.find((candidate) => candidate.trackProperty === property);
			const binding = curve ? bindingsByCurve.get(curve.id) : undefined;
			if (!curve || !binding) {
				const id = curve?.id ?? property;
				if (!evidence.unresolvedObjectReferenceCurveIds.includes(id)) {
					evidence.unresolvedObjectReferenceCurveIds.push(id);
				}
				continue;
			}
			evidence.boundObjectReferenceCurveCount++;
			const references = new Map(binding.references.map((reference) => [reference.referenceKey, reference.value]));
			const target = targeted.target as any;
			installRuntimeProperty(target, property, (value) => {
				try {
					const index = Math.round(value);
					const reference = curve.references[index];
					if (!reference) {
						throw new Error(`Unity object-reference curve "${curve.id}" produced invalid reference index ${index}.`);
					}
					const boundValue = references.get(reference.key);
					if (!boundValue) {
						throw new Error(`Unity object-reference curve "${curve.id}" has no binding for "${reference.key}".`);
					}
					assignProperty(target, binding.propertyPath, resolveBindingValue(scene, rootUrl, boundValue));
					evidence.lastAppliedObjectReference = {
						curveId: curve.id,
						targetName: targetName(target),
						propertyPath: binding.propertyPath,
						referenceKey: reference.key,
						valueKind: boundValue.kind,
					};
					evidence.lastError = null;
				} catch (error) {
					evidence.lastError = error instanceof Error ? error.message : String(error);
				}
			});
		}
		metadata.runtimeEvidence = evidence;
		group.metadata ??= {};
		group.metadata[UNITY_ANIMATION_RUNTIME_EVIDENCE_KEY] = evidence;
		results.push(evidence);
	}
	return results;
}

/** Returns the current persisted/runtime evidence for one converted Unity AnimationClip group. */
export function getUnityAnimationClipRuntimeEvidence(group: AnimationGroup): IUnityAnimationClipRuntimeEvidence | null {
	const evidence = group.metadata?.[UNITY_ANIMATION_RUNTIME_EVIDENCE_KEY];
	return evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : null;
}
