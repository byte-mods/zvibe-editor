import { Animation } from "@babylonjs/core/Animations/animation";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";

export type ModelAnimationClipRootPosition = "none" | "xz" | "xyz";

export interface IModelAnimationClipDefinition {
	name: string;
	sourceAnimationGroup: string;
	from: number;
	to: number;
	loopTime: boolean;
	loopPose: boolean;
	rootMotionNode: string;
	rootMotionPosition: ModelAnimationClipRootPosition;
	rootMotionRotationY: boolean;
	targetMask: string[];
}

export interface IModelAnimationSourceGroupResult {
	name: string;
	from: number;
	to: number;
	framePerSecond: number;
	trackCount: number;
	keyCount: number;
	targets: string[];
}

export interface IModelAnimationClipRootMotionResult {
	requestedNode: string;
	resolved: boolean;
	positionMode: ModelAnimationClipRootPosition;
	rotationY: boolean;
	properties: string[];
}

export interface IModelAnimationClipResult {
	name: string;
	sourceAnimationGroup: string;
	sourceFrom: number;
	sourceTo: number;
	from: number;
	to: number;
	durationSeconds: number;
	framePerSecond: number;
	trackCount: number;
	keyCount: number;
	loopTime: boolean;
	loopPose: boolean;
	targets: string[];
	targetMask: string[];
	rootMotion: IModelAnimationClipRootMotionResult | null;
}

export interface IExecutedModelAnimationClips {
	animationGroups: AnimationGroup[];
	sourceGroups: IModelAnimationSourceGroupResult[];
	clips: IModelAnimationClipResult[];
	replacedAnimationGroupCount: number;
	errors: string[];
	warnings: string[];
}

const MAX_MODEL_ANIMATION_CLIPS = 64;
const MAX_MODEL_ANIMATION_TARGETS = 256;
const MAX_MODEL_ANIMATION_FRAME = 10_000_000;
const definitionKeys = new Set(["name", "sourceAnimationGroup", "from", "to", "loopTime", "loopPose", "rootMotionNode", "rootMotionPosition", "rootMotionRotationY", "targetMask"]);

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function boundedName(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${label} is required.`);
	}
	const normalized = value.trim();
	if (normalized.length > maximum || [...normalized].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
		throw new Error(`${label} must be at most ${maximum} printable characters.`);
	}
	return normalized;
}

function boundedFrame(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAX_MODEL_ANIMATION_FRAME) {
		throw new Error(`${label} must be a finite frame between -${MAX_MODEL_ANIMATION_FRAME} and ${MAX_MODEL_ANIMATION_FRAME}.`);
	}
	return value;
}

function normalizeTargetMask(value: unknown): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > MAX_MODEL_ANIMATION_TARGETS) {
		throw new Error(`Model animation clip targetMask must contain at most ${MAX_MODEL_ANIMATION_TARGETS} target names or ids.`);
	}
	const result: string[] = [];
	for (const candidate of value) {
		const target = boundedName(candidate, "Model animation clip target", 256);
		if (!result.includes(target)) {
			result.push(target);
		}
	}
	return result;
}

function normalizeDefinition(value: unknown, index: number): IModelAnimationClipDefinition {
	const source = record(value);
	if (!source) {
		throw new Error(`Model animation clip ${index + 1} must be an object.`);
	}
	const unknown = Object.keys(source).filter((key) => !definitionKeys.has(key));
	if (unknown.length) {
		throw new Error(`Model animation clip ${index + 1} has unsupported field(s): ${unknown.sort().join(", ")}.`);
	}
	const from = boundedFrame(source.from, `Model animation clip ${index + 1} from`);
	const to = boundedFrame(source.to, `Model animation clip ${index + 1} to`);
	if (to <= from) {
		throw new Error(`Model animation clip ${index + 1} must end after it starts.`);
	}
	const loopTime = source.loopTime === true;
	const loopPose = source.loopPose === true;
	if (loopPose && !loopTime) {
		throw new Error(`Model animation clip ${index + 1} loopPose requires loopTime=true.`);
	}
	const rootMotionPosition =
		source.rootMotionPosition === "xz" || source.rootMotionPosition === "xyz"
			? source.rootMotionPosition
			: source.rootMotionPosition === undefined || source.rootMotionPosition === "none"
				? "none"
				: null;
	if (!rootMotionPosition) {
		throw new Error(`Model animation clip ${index + 1} rootMotionPosition must be none, xz, or xyz.`);
	}
	const rootMotionNode = typeof source.rootMotionNode === "string" ? source.rootMotionNode.trim() : "";
	if (rootMotionNode.length > 256) {
		throw new Error(`Model animation clip ${index + 1} rootMotionNode must be at most 256 characters.`);
	}
	const rootMotionRotationY = source.rootMotionRotationY === true;
	if (!rootMotionNode && (rootMotionPosition !== "none" || rootMotionRotationY)) {
		throw new Error(`Model animation clip ${index + 1} requires rootMotionNode when root motion is enabled.`);
	}
	return {
		name: boundedName(source.name, `Model animation clip ${index + 1} name`, 128),
		sourceAnimationGroup: boundedName(source.sourceAnimationGroup, `Model animation clip ${index + 1} sourceAnimationGroup`, 256),
		from,
		to,
		loopTime,
		loopPose,
		rootMotionNode,
		rootMotionPosition,
		rootMotionRotationY,
		targetMask: normalizeTargetMask(source.targetMask),
	};
}

/** Parses and strictly normalizes the bounded JSON contract persisted by the Model Importer. */
export function normalizeModelAnimationClipDefinitions(value: unknown): IModelAnimationClipDefinition[] {
	let parsed = value;
	if (typeof value === "string") {
		if (!value.trim()) {
			return [];
		}
		try {
			parsed = JSON.parse(value);
		} catch (error) {
			throw new Error(`Model animation clips must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (parsed === undefined || parsed === null) {
		return [];
	}
	if (!Array.isArray(parsed) || parsed.length > MAX_MODEL_ANIMATION_CLIPS) {
		throw new Error(`Model animation clips must be an array containing at most ${MAX_MODEL_ANIMATION_CLIPS} clips.`);
	}
	const definitions = parsed.map(normalizeDefinition);
	const names = new Set<string>();
	for (const definition of definitions) {
		const key = definition.name.toLocaleLowerCase();
		if (names.has(key)) {
			throw new Error(`Model animation clip names must be unique: "${definition.name}".`);
		}
		names.add(key);
	}
	return definitions;
}

/** Produces stable compact sidecar text after strict model-clip validation. */
export function serializeModelAnimationClipDefinitions(value: unknown): string {
	return JSON.stringify(normalizeModelAnimationClipDefinitions(value));
}

function targetName(target: any): string {
	return String(target?.name ?? target?.id ?? "");
}

function targetMatches(target: any, requested: string): boolean {
	return target?.name === requested || target?.id === requested;
}

function sourceResult(group: AnimationGroup): IModelAnimationSourceGroupResult {
	const animations = group.targetedAnimations.map((targeted) => targeted.animation);
	return {
		name: group.name,
		from: group.from,
		to: group.to,
		framePerSecond: animations[0]?.framePerSecond ?? 0,
		trackCount: animations.length,
		keyCount: animations.reduce((sum, animation) => sum + animation.getKeys().length, 0),
		targets: [...new Set(group.targetedAnimations.map((targeted) => targetName(targeted.target)).filter(Boolean))].sort(),
	};
}

function cloneValue<T>(value: T): T {
	if (value && typeof (value as { clone?: unknown }).clone === "function") {
		return (value as unknown as { clone: () => T }).clone();
	}
	return structuredClone(value);
}

function sliceAnimation(source: Animation, from: number, to: number, loopPose: boolean): Animation {
	const animation = source.clone(true);
	const keys: ReturnType<Animation["getKeys"]> = source
		.getKeys()
		.filter((key) => key.frame >= from && key.frame <= to)
		.map((key) => ({ ...key, frame: key.frame - from, value: cloneValue(key.value), inTangent: cloneValue(key.inTangent), outTangent: cloneValue(key.outTangent) }));
	const duration = to - from;
	if (!keys.some((key) => key.frame === 0)) {
		keys.push({ frame: 0, value: cloneValue(source.evaluate(from)), inTangent: undefined, outTangent: undefined });
	}
	if (!keys.some((key) => key.frame === duration)) {
		keys.push({ frame: duration, value: cloneValue(source.evaluate(to)), inTangent: undefined, outTangent: undefined });
	}
	keys.sort((left, right) => left.frame - right.frame);
	if (loopPose && keys.length > 1) {
		keys[keys.length - 1] = { frame: duration, value: cloneValue(keys[0].value), inTangent: undefined, outTangent: undefined };
	}
	animation.setKeys(keys, true, true);
	return animation;
}

function rootMotionResult(group: AnimationGroup, definition: IModelAnimationClipDefinition): IModelAnimationClipRootMotionResult | null {
	if (!definition.rootMotionNode) {
		return null;
	}
	const properties = [
		...new Set(
			group.targetedAnimations
				.filter((targeted) => targetMatches(targeted.target, definition.rootMotionNode))
				.map((targeted) => targeted.animation.targetProperty)
				.filter((property) => property === "position" || property === "rotation" || property === "rotationQuaternion")
		),
	].sort();
	const positionResolved = definition.rootMotionPosition === "none" || properties.includes("position");
	const rotationResolved = !definition.rootMotionRotationY || properties.includes("rotation") || properties.includes("rotationQuaternion");
	return {
		requestedNode: definition.rootMotionNode,
		resolved: positionResolved && rotationResolved,
		positionMode: definition.rootMotionPosition,
		rotationY: definition.rootMotionRotationY,
		properties,
	};
}

function validateDefinitionAgainstGroup(definition: IModelAnimationClipDefinition, group: AnimationGroup): string[] {
	const errors: string[] = [];
	if (definition.from < group.from || definition.to > group.to) {
		errors.push(`Clip "${definition.name}" range ${definition.from}–${definition.to} must stay inside source group "${group.name}" range ${group.from}–${group.to}.`);
	}
	for (const target of definition.targetMask) {
		if (!group.targetedAnimations.some((targeted) => targetMatches(targeted.target, target))) {
			errors.push(`Clip "${definition.name}" target mask does not match source target "${target}".`);
		}
	}
	const retained = definition.targetMask.length
		? group.targetedAnimations.filter((targeted) => definition.targetMask.some((target) => targetMatches(targeted.target, target)))
		: group.targetedAnimations;
	if (!retained.length) {
		errors.push(`Clip "${definition.name}" target mask removes every animation track.`);
	}
	const root = rootMotionResult(group, definition);
	if (root && !root.resolved) {
		errors.push(
			`Clip "${definition.name}" root motion node "${definition.rootMotionNode}" does not provide the requested ${[
				definition.rootMotionPosition !== "none" ? "position" : "",
				definition.rootMotionRotationY ? "Y rotation" : "",
			]
				.filter(Boolean)
				.join(" and ")} track(s).`
		);
	}
	return errors;
}

function buildClip(group: AnimationGroup, definition: IModelAnimationClipDefinition): { group: AnimationGroup; result: IModelAnimationClipResult } {
	const output = new AnimationGroup(definition.name, group.getScene(), group.weight, group.playOrder);
	const targetedAnimations = definition.targetMask.length
		? group.targetedAnimations.filter((targeted) => definition.targetMask.some((target) => targetMatches(targeted.target, target)))
		: group.targetedAnimations;
	for (const targeted of targetedAnimations) {
		output.addTargetedAnimation(sliceAnimation(targeted.animation, definition.from, definition.to, definition.loopPose), targeted.target);
	}
	const duration = definition.to - definition.from;
	output.from = 0;
	output.to = duration;
	output.loopAnimation = definition.loopTime;
	output.isAdditive = group.isAdditive;
	output.speedRatio = group.speedRatio;
	const rootMotion = rootMotionResult(output, definition);
	output.metadata = {
		...(record(group.metadata) ?? {}),
		babylonEditorModelAnimationClip: {
			version: 1,
			sourceAnimationGroup: group.name,
			sourceFrom: definition.from,
			sourceTo: definition.to,
			loopTime: definition.loopTime,
			loopPose: definition.loopPose,
			targetMask: [...definition.targetMask],
			rootMotion,
		},
	};
	const framePerSecond = output.targetedAnimations[0]?.animation.framePerSecond ?? 0;
	return {
		group: output,
		result: {
			name: output.name,
			sourceAnimationGroup: group.name,
			sourceFrom: definition.from,
			sourceTo: definition.to,
			from: output.from,
			to: output.to,
			durationSeconds: framePerSecond > 0 ? duration / framePerSecond : 0,
			framePerSecond,
			trackCount: output.targetedAnimations.length,
			keyCount: output.targetedAnimations.reduce((sum, targeted) => sum + targeted.animation.getKeys().length, 0),
			loopTime: definition.loopTime,
			loopPose: definition.loopPose,
			targets: [...new Set(output.targetedAnimations.map((targeted) => targetName(targeted.target)).filter(Boolean))].sort(),
			targetMask: [...definition.targetMask],
			rootMotion,
		},
	};
}

/**
 * Applies Unity-style Model Importer clip slicing atomically. An empty definition set preserves the source groups.
 * Non-empty definitions replace imported source groups with rebased, independently named AnimationGroups.
 */
export function executeModelAnimationClipDefinitions(animationGroups: AnimationGroup[], requestedDefinitions: unknown): IExecutedModelAnimationClips {
	const definitions = normalizeModelAnimationClipDefinitions(requestedDefinitions);
	const sourceAnimationGroups = [...animationGroups];
	const sourceGroups = sourceAnimationGroups.map(sourceResult);
	if (!definitions.length) {
		return { animationGroups: sourceAnimationGroups, sourceGroups, clips: [], replacedAnimationGroupCount: 0, errors: [], warnings: [] };
	}
	const errors: string[] = [];
	const resolved: Array<{ definition: IModelAnimationClipDefinition; group: AnimationGroup }> = [];
	for (const definition of definitions) {
		const matches = sourceAnimationGroups.filter((group) => group.name === definition.sourceAnimationGroup);
		if (matches.length !== 1) {
			errors.push(
				matches.length === 0
					? `Clip "${definition.name}" source animation group "${definition.sourceAnimationGroup}" was not found.`
					: `Clip "${definition.name}" source animation group "${definition.sourceAnimationGroup}" is ambiguous.`
			);
			continue;
		}
		errors.push(...validateDefinitionAgainstGroup(definition, matches[0]));
		resolved.push({ definition, group: matches[0] });
	}
	if (errors.length) {
		return { animationGroups: sourceAnimationGroups, sourceGroups, clips: [], replacedAnimationGroupCount: 0, errors: [...new Set(errors)], warnings: [] };
	}
	const created: AnimationGroup[] = [];
	const clips: IModelAnimationClipResult[] = [];
	try {
		for (const entry of resolved) {
			const clip = buildClip(entry.group, entry.definition);
			created.push(clip.group);
			clips.push(clip.result);
		}
	} catch (error) {
		for (const group of created) {
			group.dispose();
		}
		return {
			animationGroups: sourceAnimationGroups,
			sourceGroups,
			clips: [],
			replacedAnimationGroupCount: 0,
			errors: [`Model animation clip creation failed: ${error instanceof Error ? error.message : String(error)}`],
			warnings: [],
		};
	}
	const replacedAnimationGroupCount = sourceAnimationGroups.length;
	for (const group of sourceAnimationGroups) {
		group.dispose();
	}
	return {
		animationGroups: created,
		sourceGroups,
		clips,
		replacedAnimationGroupCount,
		errors: [],
		warnings: [],
	};
}
