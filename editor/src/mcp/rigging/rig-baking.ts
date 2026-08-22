import { createHash } from "node:crypto";

import { Animation, AnimationGroup, Bone, Matrix, Quaternion, Scene, Skeleton, Space, TransformNode, Vector3 } from "babylonjs";
import { applyRigLayers, getAnimationRigJobType, resetRigLayerTemporalState } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { evaluateIKController, rebuildIKControllerRuntime } from "./ik";

const maximumBakeSamples = 4096;
const maximumBakedBones = 256;
const maximumBakedKeys = 1000000;
const safePropertySegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const forbiddenPropertySegments = new Set(["__proto__", "prototype", "constructor"]);

interface IRigBakeRequest {
	skeletonId: string;
	sourceAnimationGroupName: string;
	layerIds?: string[];
	from?: number;
	to?: number;
	sampleRate?: number;
}

interface IRigBakePlan {
	skeleton: Skeleton;
	group: AnimationGroup;
	layers: any[];
	drivenBones: Bone[];
	sourceFramesPerSecond: number;
	from: number;
	to: number;
	sampleRate: number;
	frames: number[];
	temporalConstraintCount: number;
	constraintCount: number;
	invalidConstraintIds: string[];
	fingerprint: string;
	errors: string[];
	warnings: string[];
}

interface IBonePose {
	bone: Bone;
	target: Bone | TransformNode;
	bonePosition: Vector3;
	boneRotationQuaternion: Quaternion;
	boneScaling: Vector3;
	targetPosition?: Vector3;
	targetRotation?: Vector3;
	targetRotationQuaternion?: Quaternion | null;
	targetScaling?: Vector3;
}

interface IPropertySnapshot {
	target: any;
	property: string;
	value: any;
}

function cloneValue(value: any): any {
	return value?.clone?.() ?? value;
}

function serializedValue(value: any): unknown {
	if (value?.asArray) {
		return value.asArray();
	}
	if (Array.isArray(value)) {
		return value.map(serializedValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, serializedValue(child)])
		);
	}
	return value;
}

function validatedPropertySegments(property: string): string[] {
	const segments = property.split(".");
	if (!property || property.length > 512 || segments.length > 16 || segments.some((segment) => !safePropertySegment.test(segment) || forbiddenPropertySegments.has(segment))) {
		throw new Error(`Source animation property path "${property}" is invalid or unsafe.`);
	}
	return segments;
}

function readProperty(target: any, property: string): any {
	let current = target;
	for (const segment of validatedPropertySegments(property)) {
		if (current === null || current === undefined) {
			return undefined;
		}
		current = current[segment];
	}
	return current;
}

function fingerprintPropertyValue(target: any, property: string): unknown {
	try {
		return serializedValue(readProperty(target, property));
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function writeProperty(target: any, property: string, value: any): void {
	if (target instanceof Bone && property === "position") {
		target.setPosition(cloneValue(value), Space.LOCAL);
		return;
	}
	if (target instanceof Bone && property === "rotationQuaternion") {
		target.setRotationQuaternion(cloneValue(value), Space.LOCAL);
		return;
	}
	if (target instanceof Bone && property === "rotation") {
		target.setRotation(cloneValue(value), Space.LOCAL);
		return;
	}
	if (target instanceof Bone && property === "scaling") {
		target.setScale(cloneValue(value));
		return;
	}
	const segments = validatedPropertySegments(property);
	let owner = target;
	for (const segment of segments.slice(0, -1)) {
		owner = owner?.[segment];
		if (owner === null || owner === undefined) {
			throw new Error(`Source animation property "${property}" no longer resolves on target "${target?.name ?? target?.id ?? "unknown"}".`);
		}
	}
	const key = segments[segments.length - 1];
	const current = owner[key];
	if (current?.copyFrom && value && typeof value === "object") {
		current.copyFrom(value);
	} else {
		owner[key] = cloneValue(value);
	}
	if (target instanceof TransformNode) {
		target.computeWorldMatrix(true);
	}
}

function resolveSkeleton(scene: Scene, skeletonId: string): Skeleton {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === skeletonId);
	if (!skeleton) {
		throw new Error(`Skeleton "${skeletonId}" was not found.`);
	}
	return skeleton;
}

function resolveChain(skeleton: Skeleton, rootBoneName: string, tipBoneName: string): Bone[] {
	const root = skeleton.bones.find((bone) => bone.name === rootBoneName);
	let current: Bone | null | undefined = skeleton.bones.find((bone) => bone.name === tipBoneName);
	if (!root || !current) {
		return [];
	}
	const reverse: Bone[] = [];
	while (current && reverse.length < 64) {
		reverse.push(current);
		if (current === root) {
			return reverse.reverse();
		}
		current = current.getParent();
	}
	return [];
}

function drivenBoneNames(skeleton: Skeleton, constraint: any): string[] {
	if (["multiParent", "multiPosition", "multiAim", "overrideTransform", "dampedTransform", "blendTransform"].includes(constraint.type)) {
		return constraint.boneName ? [constraint.boneName] : [];
	}
	if (constraint.type === "twist") {
		return Array.isArray(constraint.twistBones) ? constraint.twistBones.map((item: any) => item.boneName) : [];
	}
	if (constraint.type === "chainIk") {
		return resolveChain(skeleton, constraint.rootBoneName, constraint.tipBoneName).map((bone) => bone.name);
	}
	if (constraint.type === "fullBodyIk" && Array.isArray(constraint.effectors)) {
		const names = constraint.effectors.flatMap((effector: any): string[] => resolveChain(skeleton, constraint.rootBoneName, effector.boneName).map((bone) => bone.name));
		return [...new Set<string>(names)];
	}
	if (constraint.type === "customJob" && Array.isArray(constraint.boneNames)) {
		return constraint.boneNames;
	}
	return [];
}

function constraintReferencesValid(scene: Scene, skeleton: Skeleton, constraint: any): boolean {
	const boneExists = (name: unknown): boolean => typeof name === "string" && skeleton.bones.some((bone) => bone.name === name);
	const transformExists = (id: unknown): boolean => typeof id === "string" && scene.getNodeById(id) instanceof TransformNode;
	if (constraint.type === "multiParent" || constraint.type === "multiPosition" || constraint.type === "multiAim") {
		return (
			boneExists(constraint.boneName) &&
			Array.isArray(constraint.sources) &&
			constraint.sources.some((source: any) => Number(source.weight ?? 0) > 0) &&
			constraint.sources.every((source: any) => transformExists(source.nodeId))
		);
	}
	if (constraint.type === "twist") {
		return (
			boneExists(constraint.sourceBoneName) &&
			Array.isArray(constraint.twistBones) &&
			constraint.twistBones.length > 0 &&
			constraint.twistBones.every((item: any) => boneExists(item.boneName))
		);
	}
	if (constraint.type === "chainIk") {
		return resolveChain(skeleton, constraint.rootBoneName, constraint.tipBoneName).length >= 2 && transformExists(constraint.targetNodeId);
	}
	if (constraint.type === "fullBodyIk") {
		return (
			boneExists(constraint.rootBoneName) &&
			Array.isArray(constraint.effectors) &&
			constraint.effectors.length > 0 &&
			constraint.effectors.every(
				(effector: any) =>
					resolveChain(skeleton, constraint.rootBoneName, effector.boneName).length >= 2 &&
					transformExists(effector.targetNodeId) &&
					(Number(effector.positionWeight ?? 0) > 0 || Number(effector.rotationWeight ?? 0) > 0)
			)
		);
	}
	if (constraint.type === "overrideTransform" || constraint.type === "dampedTransform") {
		return boneExists(constraint.boneName) && transformExists(constraint.sourceNodeId);
	}
	if (constraint.type === "blendTransform") {
		return boneExists(constraint.boneName) && transformExists(constraint.sourceNodeIdA) && transformExists(constraint.sourceNodeIdB);
	}
	if (constraint.type === "customJob") {
		const jobType = getAnimationRigJobType(String(constraint.jobType));
		return (
			!!jobType &&
			jobType.dataVersion === constraint.jobVersion &&
			Array.isArray(constraint.boneNames) &&
			constraint.boneNames.every(boneExists) &&
			Array.isArray(constraint.nodeIds) &&
			constraint.nodeIds.every(transformExists)
		);
	}
	return false;
}

function sourceFramesPerSecond(group: AnimationGroup): { value: number; mixed: boolean } {
	const values = [...new Set(group.targetedAnimations.map((targeted) => targeted.animation.framePerSecond))];
	return { value: values[0] ?? 60, mixed: values.length > 1 };
}

function sampledFrames(from: number, to: number, sourceFps: number, sampleRate: number): number[] {
	const frameStep = sourceFps / sampleRate;
	const count = Math.ceil((to - from) / frameStep) + 1;
	const frames = Array.from({ length: count }, (_, index) => Math.min(to, from + index * frameStep));
	frames[frames.length - 1] = to;
	return frames;
}

function planFingerprint(plan: Omit<IRigBakePlan, "fingerprint">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				skeletonId: plan.skeleton.id,
				sourceAnimationGroupName: plan.group.name,
				from: plan.from,
				to: plan.to,
				sampleRate: plan.sampleRate,
				invalidConstraintIds: plan.invalidConstraintIds,
				layers: plan.layers.map((layer) => serializedValue(layer)),
				tracks: plan.group.targetedAnimations.map((targeted) => ({
					targetId: targeted.target?.id ?? null,
					targetName: targeted.target?.name ?? null,
					property: targeted.animation.targetProperty,
					framePerSecond: targeted.animation.framePerSecond,
					dataType: targeted.animation.dataType,
					loopMode: targeted.animation.loopMode,
					keys: targeted.animation.getKeys().map((key) => ({ frame: key.frame, value: serializedValue(key.value), interpolation: key.interpolation ?? null })),
				})),
			})
		)
		.digest("hex");
}

function buildRigBakePlan(scene: Scene, data: IRigBakeRequest): IRigBakePlan {
	const skeleton = resolveSkeleton(scene, data.skeletonId);
	const group = scene.animationGroups.find((candidate) => candidate.name === data.sourceAnimationGroupName);
	if (!group) {
		throw new Error(`AnimationGroup "${data.sourceAnimationGroupName}" was not found.`);
	}
	if (!group.targetedAnimations.length) {
		throw new Error(`AnimationGroup "${group.name}" has no tracks to sample.`);
	}
	const allLayers = Array.isArray(scene.metadata?.babylonEditorRigLayers) ? scene.metadata.babylonEditorRigLayers : [];
	const requestedIds = data.layerIds ? [...new Set(data.layerIds)] : null;
	if (data.layerIds && requestedIds!.length !== data.layerIds.length) {
		throw new Error("layerIds must not contain duplicates.");
	}
	if (requestedIds) {
		for (const layerId of requestedIds) {
			const layer = allLayers.find((candidate: any) => candidate.id === layerId);
			if (!layer) {
				throw new Error(`Rig layer "${layerId}" was not found.`);
			}
			if (layer.skeletonId !== skeleton.id) {
				throw new Error(`Rig layer "${layerId}" does not belong to skeleton "${skeleton.id}".`);
			}
		}
	}
	const layers = allLayers
		.filter((layer: any) => layer.skeletonId === skeleton.id && (!requestedIds || requestedIds.includes(layer.id)))
		.sort((left: any, right: any) => Number(left.order ?? 0) - Number(right.order ?? 0) || String(left.id).localeCompare(String(right.id)));
	const fps = sourceFramesPerSecond(group);
	const from = data.from ?? group.from;
	const to = data.to ?? group.to;
	const sampleRate = data.sampleRate ?? fps.value;
	if (!Number.isFinite(from) || !Number.isFinite(to) || from < group.from || to > group.to || from >= to) {
		throw new Error(`Rig bake range must be finite, increasing, and contained within source frames ${group.from} through ${group.to}.`);
	}
	if (!Number.isFinite(sampleRate) || sampleRate < 1 || sampleRate > 120) {
		throw new Error("Rig bake sampleRate must be a finite value from 1 through 120 samples per second.");
	}
	const frames = sampledFrames(from, to, fps.value, sampleRate);
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!layers.length) {
		errors.push(`Skeleton "${skeleton.name}" has no matching rig layers.`);
	}
	if (fps.mixed) {
		errors.push("The source AnimationGroup uses mixed track frame rates; normalize it to one clip frame rate before rig baking.");
	}
	if (frames.length > maximumBakeSamples) {
		errors.push(`The requested range produces ${frames.length} samples; the bounded maximum is ${maximumBakeSamples}.`);
	}
	const enabledLayers = layers.filter((layer: any) => layer.enabled !== false && Number(layer.weight ?? 1) > 0);
	const constraints = enabledLayers.flatMap((layer: any) =>
		Array.isArray(layer.constraints) ? layer.constraints.filter((constraint: any) => constraint.enabled !== false) : []
	);
	const boneNames = [...new Set(constraints.flatMap((constraint: any) => drivenBoneNames(skeleton, constraint)))];
	const drivenBones = boneNames.flatMap((name) => {
		const bone = skeleton.bones.find((candidate) => candidate.name === name);
		return bone ? [bone] : [];
	});
	const invalidConstraintIds = constraints
		.filter((constraint: any) => !constraintReferencesValid(scene, skeleton, constraint))
		.map((constraint: any) => String(constraint.id ?? ""));
	if (invalidConstraintIds.length) {
		errors.push(`${invalidConstraintIds.length} enabled constraint(s) have unresolved bone, source-node, or IK-chain references.`);
	}
	if (!drivenBones.length) {
		errors.push("No enabled weighted rig constraints drive a resolvable bone.");
	}
	if (drivenBones.length > maximumBakedBones) {
		errors.push(`The rig drives ${drivenBones.length} bones; the bounded maximum is ${maximumBakedBones}.`);
	}
	const keyCount = drivenBones.length * 3 * frames.length;
	if (keyCount > maximumBakedKeys) {
		errors.push(`The bake would create ${keyCount} keys; the bounded maximum is ${maximumBakedKeys}.`);
	}
	for (const targeted of group.targetedAnimations) {
		try {
			const current = readProperty(targeted.target, targeted.animation.targetProperty);
			if (current === undefined) {
				errors.push(`Track "${targeted.animation.name}" property "${targeted.animation.targetProperty}" does not resolve on its target.`);
			}
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (layers.some((layer: any) => layer.enabled === false || Number(layer.weight ?? 1) <= 0)) {
		warnings.push("Disabled or zero-weight selected layers do not contribute to the baked result.");
	}
	const temporalConstraintCount = constraints.filter((constraint: any) => constraint.type === "dampedTransform" || constraint.type === "customJob").length;
	const partialPlan = {
		skeleton,
		group,
		layers,
		drivenBones,
		sourceFramesPerSecond: fps.value,
		from,
		to,
		sampleRate,
		frames,
		temporalConstraintCount,
		constraintCount: constraints.length,
		invalidConstraintIds,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
	return { ...partialPlan, fingerprint: planFingerprint(partialPlan) };
}

function publicPlan(plan: IRigBakePlan): any {
	return {
		algorithm: "bounded-rig-to-skeleton-bake-v1",
		fingerprint: plan.fingerprint,
		skeletonId: plan.skeleton.id,
		skeletonName: plan.skeleton.name,
		sourceAnimationGroupName: plan.group.name,
		layerIds: plan.layers.map((layer) => layer.id),
		layerCount: plan.layers.length,
		constraintCount: plan.constraintCount,
		temporalConstraintCount: plan.temporalConstraintCount,
		drivenBoneCount: plan.drivenBones.length,
		drivenBoneNames: plan.drivenBones.map((bone) => bone.name),
		from: plan.from,
		to: plan.to,
		sourceFramesPerSecond: plan.sourceFramesPerSecond,
		sampleRate: plan.sampleRate,
		sampleCount: plan.frames.length,
		trackCount: plan.drivenBones.length * 3,
		keyCount: plan.drivenBones.length * 3 * plan.frames.length,
		invalidConstraintIds: plan.invalidConstraintIds,
		canBake: plan.errors.length === 0,
		errors: plan.errors,
		warnings: plan.warnings,
	};
}

/** Inspects a bounded Unity-style transfer of evaluated rig motion back onto skeleton curves. */
export function inspectRigToSkeletonBake(scene: Scene, data: IRigBakeRequest): any {
	return publicPlan(buildRigBakePlan(scene, data));
}

function captureBonePose(bone: Bone): IBonePose {
	const target = bone.getTransformNode() ?? bone;
	return {
		bone,
		target,
		bonePosition: bone.getPosition(Space.LOCAL),
		boneRotationQuaternion: bone.getRotationQuaternion(Space.LOCAL),
		boneScaling: bone.getScale(),
		...(target instanceof TransformNode
			? {
					targetPosition: target.position.clone(),
					targetRotation: target.rotation.clone(),
					targetRotationQuaternion: target.rotationQuaternion?.clone() ?? null,
					targetScaling: target.scaling.clone(),
				}
			: {}),
	};
}

function restoreBonePose(pose: IBonePose): void {
	pose.bone.setPosition(pose.bonePosition, Space.LOCAL);
	pose.bone.setRotationQuaternion(pose.boneRotationQuaternion, Space.LOCAL);
	pose.bone.setScale(pose.boneScaling);
	if (pose.target instanceof TransformNode) {
		pose.target.position.copyFrom(pose.targetPosition!);
		pose.target.rotation.copyFrom(pose.targetRotation!);
		pose.target.rotationQuaternion = pose.targetRotationQuaternion?.clone() ?? null;
		pose.target.scaling.copyFrom(pose.targetScaling!);
		pose.target.computeWorldMatrix(true);
	}
}

function sampledBonePose(bone: Bone): { target: Bone | TransformNode; position: Vector3; rotationQuaternion: Quaternion; scaling: Vector3 } {
	const target = bone.getTransformNode() ?? bone;
	return {
		target,
		position: bone.getPosition(Space.LOCAL),
		rotationQuaternion: bone.getRotationQuaternion(Space.LOCAL),
		scaling: bone.getScale(),
	};
}

function captureSourceProperties(group: AnimationGroup): IPropertySnapshot[] {
	const snapshots: IPropertySnapshot[] = [];
	const seen = new Map<any, Set<string>>();
	for (const targeted of group.targetedAnimations) {
		let properties = seen.get(targeted.target);
		if (!properties) {
			properties = new Set();
			seen.set(targeted.target, properties);
		}
		const property = targeted.animation.targetProperty;
		if (!properties.has(property)) {
			properties.add(property);
			snapshots.push({ target: targeted.target, property, value: cloneValue(readProperty(targeted.target, property)) });
		}
	}
	return snapshots;
}

function restoreSourceProperties(snapshots: IPropertySnapshot[]): void {
	for (const snapshot of snapshots) {
		writeProperty(snapshot.target, snapshot.property, snapshot.value);
	}
}

/** Bakes evaluated source animation plus selected rig layers into a new ordinary editable AnimationGroup. */
export function bakeRigToSkeletonAnimation(scene: Scene, data: IRigBakeRequest & { outputName: string; expectedFingerprint: string }, options: IMCPActionOptions): any {
	const plan = buildRigBakePlan(scene, data);
	if (data.expectedFingerprint !== plan.fingerprint) {
		throw new Error("Rig bake inputs changed after inspection. Call inspect_rig_to_skeleton_bake again and use its exact fingerprint.");
	}
	if (plan.errors.length) {
		throw new Error(`Rig bake is blocked: ${plan.errors.join(" ")}`);
	}
	const outputName = String(data.outputName).trim();
	if (!outputName || outputName.length > 256) {
		throw new Error("outputName must contain 1 through 256 characters.");
	}
	if (scene.animationGroups.some((group) => group.name === outputName)) {
		throw new Error(`AnimationGroup "${outputName}" already exists.`);
	}
	const allBonePoses = plan.skeleton.bones.map(captureBonePose);
	const sourceSnapshots = captureSourceProperties(plan.group);
	const samples = new Map<string, { bone: Bone; target: Bone | TransformNode; position: any[]; rotationQuaternion: any[]; scaling: any[] }>();
	for (const bone of plan.drivenBones) {
		const pose = sampledBonePose(bone);
		samples.set(bone.name, { bone, target: pose.target, position: [], rotationQuaternion: [], scaling: [] });
	}
	let failedConstraintIds: string[] = [];
	try {
		resetRigLayerTemporalState(scene as any);
		plan.frames.forEach((frame, sampleIndex) => {
			allBonePoses.forEach(restoreBonePose);
			restoreSourceProperties(sourceSnapshots);
			for (const targeted of plan.group.targetedAnimations) {
				writeProperty(targeted.target, targeted.animation.targetProperty, targeted.animation.evaluate(frame));
			}
			const evaluation = applyRigLayers(scene as any, {
				skeletonId: plan.skeleton.id,
				layerIds: plan.layers.map((layer) => layer.id),
				deltaTimeSeconds: 1 / plan.sampleRate,
				resetTemporalState: sampleIndex === 0,
			});
			if (evaluation.failedConstraintIds.length) {
				failedConstraintIds = [...new Set([...failedConstraintIds, ...evaluation.failedConstraintIds])];
			}
			for (const sample of samples.values()) {
				const pose = sampledBonePose(sample.bone);
				const previousRotation = sample.rotationQuaternion.at(-1)?.value as Quaternion | undefined;
				let rotationQuaternion = pose.rotationQuaternion.normalize();
				if (previousRotation && Quaternion.Dot(previousRotation, rotationQuaternion) < 0) {
					rotationQuaternion = rotationQuaternion.scale(-1);
				}
				sample.position.push({ frame, value: pose.position });
				sample.rotationQuaternion.push({ frame, value: rotationQuaternion });
				sample.scaling.push({ frame, value: pose.scaling });
			}
		});
	} finally {
		restoreSourceProperties(sourceSnapshots);
		allBonePoses.forEach(restoreBonePose);
		resetRigLayerTemporalState(scene as any);
		plan.skeleton.computeAbsoluteMatrices(true);
	}
	if (failedConstraintIds.length) {
		throw new Error(`Rig bake evaluation failed for constraint ids: ${failedConstraintIds.join(", ")}. The original pose was restored and no clip was created.`);
	}
	const output = new AnimationGroup(outputName, scene);
	try {
		for (const sample of samples.values()) {
			for (const [property, keys, dataType] of [
				["position", sample.position, Animation.ANIMATIONTYPE_VECTOR3],
				["rotationQuaternion", sample.rotationQuaternion, Animation.ANIMATIONTYPE_QUATERNION],
				["scaling", sample.scaling, Animation.ANIMATIONTYPE_VECTOR3],
			] as const) {
				const animation = new Animation(`${sample.bone.name} Rig Bake ${property}`, property, plan.sourceFramesPerSecond, dataType, Animation.ANIMATIONLOOPMODE_CYCLE);
				animation.setKeys(keys);
				output.addTargetedAnimation(animation, sample.target);
			}
		}
		output.metadata = {
			babylonEditorRigBake: {
				algorithm: "bounded-rig-to-skeleton-bake-v1",
				fingerprint: plan.fingerprint,
				skeletonId: plan.skeleton.id,
				sourceAnimationGroupName: plan.group.name,
				layerIds: plan.layers.map((layer) => layer.id),
				from: plan.from,
				to: plan.to,
				sampleRate: plan.sampleRate,
			},
		};
	} catch (error) {
		output.dispose();
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.animations?.forceUpdate?.();
	return {
		created: true,
		name: output.name,
		...publicPlan(plan),
		trackCount: output.targetedAnimations.length,
		failedConstraintIds: [],
		poseRestored: true,
		temporalStateReset: true,
	};
}

interface IConstraintBakeRequest extends IRigBakeRequest {
	constraintRefs?: Array<{ layerId: string; constraintId: string }>;
}

interface IInverseConstraintBinding {
	layer: any;
	constraint: any;
	bone: Bone;
	position: boolean;
	rotation: boolean;
	controls: Array<{ node: TransformNode; position: boolean; rotation: boolean; positionOffset?: number[]; rotationOffset?: number[] }>;
}

interface IConstraintBakePlan {
	skeleton: Skeleton;
	group: AnimationGroup;
	layers: any[];
	bindings: IInverseConstraintBinding[];
	controls: Array<{ node: TransformNode; position: boolean; rotation: boolean }>;
	keptAnimations: AnimationGroup["targetedAnimations"];
	transferredTrackCount: number;
	unsupportedConstraintRefs: Array<{ layerId: string; constraintId: string; type: string }>;
	sourceFramesPerSecond: number;
	from: number;
	to: number;
	sampleRate: number;
	frames: number[];
	fingerprint: string;
	errors: string[];
	warnings: string[];
}

interface ITransformNodePose {
	node: TransformNode;
	position: Vector3;
	rotation: Vector3;
	rotationQuaternion: Quaternion | null;
	scaling: Vector3;
}

const inverseBakeConstraintTypes = new Set(["multiParent", "multiPosition", "multiAim"]);
const constraintBakePositionTolerance = 0.05;
const constraintBakeRotationToleranceDegrees = 0.25;

function channelForProperty(property: string): "position" | "rotation" | "scaling" | null {
	const root = property.split(".")[0];
	if (root === "position") {
		return "position";
	}
	if (root === "rotation" || root === "rotationQuaternion") {
		return "rotation";
	}
	if (root === "scaling") {
		return "scaling";
	}
	return null;
}

function bindingKey(layerId: string, constraintId: string): string {
	return `${layerId}\u0000${constraintId}`;
}

function inverseBinding(scene: Scene, skeleton: Skeleton, layer: any, constraint: any): IInverseConstraintBinding | null {
	const bone = skeleton.bones.find((candidate) => candidate.name === constraint.boneName);
	if (!bone || !inverseBakeConstraintTypes.has(constraint.type)) {
		return null;
	}
	if (constraint.type === "multiParent") {
		return {
			layer,
			constraint,
			bone,
			position: true,
			rotation: true,
			controls: constraint.sources.map((source: any) => ({
				node: scene.getNodeById(source.nodeId) as TransformNode,
				position: true,
				rotation: true,
				positionOffset: source.positionOffset,
				rotationOffset: source.rotationOffset,
			})),
		};
	}
	if (constraint.type === "multiPosition") {
		return {
			layer,
			constraint,
			bone,
			position: true,
			rotation: false,
			controls: constraint.sources.map((source: any) => ({
				node: scene.getNodeById(source.nodeId) as TransformNode,
				position: true,
				rotation: false,
				positionOffset: constraint.maintainOffset === false ? [0, 0, 0] : source.positionOffset,
			})),
		};
	}
	return {
		layer,
		constraint,
		bone,
		position: false,
		rotation: true,
		controls: constraint.sources.map((source: any) => ({ node: scene.getNodeById(source.nodeId) as TransformNode, position: true, rotation: false })),
	};
}

function matchesBoneTarget(target: any, bone: Bone): boolean {
	return target === bone || target === bone.getTransformNode();
}

function controlNodeState(node: TransformNode): any {
	const parentChain: any[] = [];
	let parent = node.parent;
	while (parent instanceof TransformNode && parentChain.length < 64) {
		parentChain.push({
			id: parent.id,
			parentId: parent.parent?.id ?? null,
			position: parent.position.asArray(),
			rotation: parent.rotation.asArray(),
			rotationQuaternion: parent.rotationQuaternion?.asArray() ?? null,
			scaling: parent.scaling.asArray(),
		});
		parent = parent.parent;
	}
	return {
		id: node.id,
		name: node.name,
		parentId: node.parent?.id ?? null,
		position: node.position.asArray(),
		rotation: node.rotation.asArray(),
		rotationQuaternion: node.rotationQuaternion?.asArray() ?? null,
		scaling: node.scaling.asArray(),
		parentChain,
	};
}

function constraintBakeFingerprint(plan: Omit<IConstraintBakePlan, "fingerprint">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				algorithm: "bounded-skeleton-to-rig-controls-bake-v1",
				skeletonId: plan.skeleton.id,
				sourceAnimationGroupName: plan.group.name,
				from: plan.from,
				to: plan.to,
				sampleRate: plan.sampleRate,
				groupSettings: {
					isAdditive: plan.group.isAdditive,
					loopAnimation: plan.group.loopAnimation,
					speedRatio: plan.group.speedRatio,
					weight: plan.group.weight,
					playOrder: plan.group.playOrder,
				},
				layers: plan.layers.map((layer) => serializedValue(layer)),
				constraintRefs: plan.bindings.map((binding) => ({ layerId: binding.layer.id, constraintId: binding.constraint.id })),
				controls: plan.controls.map((control) => ({ ...controlNodeState(control.node), usePosition: control.position, useRotation: control.rotation })),
				sourceValues: plan.group.targetedAnimations.map((targeted) => ({
					targetId: targeted.target?.id ?? null,
					targetName: targeted.target?.name ?? null,
					property: targeted.animation.targetProperty,
					value: fingerprintPropertyValue(targeted.target, targeted.animation.targetProperty),
				})),
				baselineBones: plan.skeleton.bones.map((bone) => ({
					name: bone.name,
					position: bone.getPosition(Space.LOCAL).asArray(),
					rotationQuaternion: bone.getRotationQuaternion(Space.LOCAL).asArray(),
					scaling: bone.getScale().asArray(),
					linkedTransform: bone.getTransformNode() ? controlNodeState(bone.getTransformNode()!) : null,
				})),
				tracks: plan.group.targetedAnimations.map((targeted) => ({
					targetId: targeted.target?.id ?? null,
					targetName: targeted.target?.name ?? null,
					property: targeted.animation.targetProperty,
					framePerSecond: targeted.animation.framePerSecond,
					dataType: targeted.animation.dataType,
					loopMode: targeted.animation.loopMode,
					keys: targeted.animation.getKeys().map((key) => ({ frame: key.frame, value: serializedValue(key.value), interpolation: key.interpolation ?? null })),
				})),
			})
		)
		.digest("hex");
}

function buildConstraintBakePlan(scene: Scene, data: IConstraintBakeRequest): IConstraintBakePlan {
	const skeleton = resolveSkeleton(scene, data.skeletonId);
	const group = scene.animationGroups.find((candidate) => candidate.name === data.sourceAnimationGroupName);
	if (!group) {
		throw new Error(`AnimationGroup "${data.sourceAnimationGroupName}" was not found.`);
	}
	if (!group.targetedAnimations.length) {
		throw new Error(`AnimationGroup "${group.name}" has no tracks to transfer.`);
	}
	const allLayers = Array.isArray(scene.metadata?.babylonEditorRigLayers) ? scene.metadata.babylonEditorRigLayers : [];
	const requestedLayerIds = data.layerIds ? [...new Set(data.layerIds)] : null;
	if (data.layerIds && requestedLayerIds!.length !== data.layerIds.length) {
		throw new Error("layerIds must not contain duplicates.");
	}
	const layers = allLayers
		.filter((layer: any) => layer.skeletonId === skeleton.id && (!requestedLayerIds || requestedLayerIds.includes(layer.id)))
		.sort((left: any, right: any) => Number(left.order ?? 0) - Number(right.order ?? 0) || String(left.id).localeCompare(String(right.id)));
	if (requestedLayerIds) {
		for (const layerId of requestedLayerIds) {
			if (!layers.some((layer: any) => layer.id === layerId)) {
				throw new Error(`Rig layer "${layerId}" was not found on skeleton "${skeleton.id}".`);
			}
		}
	}
	const allConstraints = layers.flatMap((layer: any) => (Array.isArray(layer.constraints) ? layer.constraints.map((constraint: any) => ({ layer, constraint })) : []));
	const requestedRefs = data.constraintRefs ?? null;
	const requestedKeys = requestedRefs ? requestedRefs.map((reference) => bindingKey(reference.layerId, reference.constraintId)) : null;
	if (requestedKeys && new Set(requestedKeys).size !== requestedKeys.length) {
		throw new Error("constraintRefs must not contain duplicate layerId/constraintId pairs.");
	}
	if (requestedRefs) {
		for (const reference of requestedRefs) {
			if (!allConstraints.some(({ layer, constraint }: any) => layer.id === reference.layerId && constraint.id === reference.constraintId)) {
				throw new Error(`Rig constraint "${reference.layerId}/${reference.constraintId}" was not found in the selected skeleton and layers.`);
			}
		}
	}
	const candidates = allConstraints.filter(
		({ layer, constraint }: any) =>
			layer.enabled !== false &&
			Number(layer.weight ?? 1) > 0 &&
			constraint.enabled !== false &&
			(!requestedKeys || requestedKeys.includes(bindingKey(layer.id, constraint.id)))
	);
	const unsupportedConstraintRefs = candidates
		.filter(({ constraint }: any) => !inverseBakeConstraintTypes.has(constraint.type))
		.map(({ layer, constraint }: any) => ({ layerId: String(layer.id), constraintId: String(constraint.id), type: String(constraint.type) }));
	const selected = candidates.filter(({ constraint }: any) => inverseBakeConstraintTypes.has(constraint.type));
	const bindings = selected.flatMap(({ layer, constraint }: any) => {
		const binding = inverseBinding(scene, skeleton, layer, constraint);
		return binding ? [binding] : [];
	});
	const fps = sourceFramesPerSecond(group);
	const from = data.from ?? group.from;
	const to = data.to ?? group.to;
	const sampleRate = data.sampleRate ?? fps.value;
	if (!Number.isFinite(from) || !Number.isFinite(to) || from < group.from || to > group.to || from >= to) {
		throw new Error(`Constraint bake range must be finite, increasing, and contained within source frames ${group.from} through ${group.to}.`);
	}
	if (!Number.isFinite(sampleRate) || sampleRate < 1 || sampleRate > 120) {
		throw new Error("Constraint bake sampleRate must be a finite value from 1 through 120 samples per second.");
	}
	const frames = sampledFrames(from, to, fps.value, sampleRate);
	const errors: string[] = [];
	const warnings: string[] = [];
	if (!layers.length) {
		errors.push(`Skeleton "${skeleton.name}" has no matching rig layers.`);
	}
	if (!bindings.length) {
		errors.push("No enabled inverse-bake-capable Multi-Parent, Multi-Position, or Multi-Aim constraints are selected.");
	}
	if (requestedRefs && unsupportedConstraintRefs.length) {
		errors.push(`${unsupportedConstraintRefs.length} explicitly selected constraint(s) do not advertise inverse Bake To Constraint support.`);
	} else if (unsupportedConstraintRefs.length) {
		warnings.push(`${unsupportedConstraintRefs.length} enabled forward-only constraint(s) are excluded because they do not advertise inverse Bake To Constraint support.`);
	}
	if (fps.mixed) {
		errors.push("The source AnimationGroup uses mixed track frame rates; normalize it to one clip frame rate before constraint baking.");
	}
	if (group.isAdditive) {
		errors.push("Additive source AnimationGroups require base-pose composition and are not eligible for exact Bake To Constraint transfer.");
	}
	if (frames.length > maximumBakeSamples) {
		errors.push(`The requested range produces ${frames.length} samples; the bounded maximum is ${maximumBakeSamples}.`);
	}
	for (const binding of bindings) {
		if (!constraintReferencesValid(scene, skeleton, binding.constraint)) {
			errors.push(`Constraint "${binding.layer.id}/${binding.constraint.id}" has unresolved bone or source-node references.`);
		}
		if (Math.abs(Number(binding.layer.weight ?? 1) - 1) > 1e-6 || Math.abs(Number(binding.constraint.weight ?? 1) - 1) > 1e-6) {
			errors.push(`Constraint "${binding.layer.id}/${binding.constraint.id}" requires layer and constraint weights of 1 for exact inverse transfer.`);
		}
		if (binding.constraint.type === "multiPosition" && (binding.constraint.positionAxes ?? [true, true, true]).some((axis: boolean) => axis === false)) {
			errors.push(`Constraint "${binding.layer.id}/${binding.constraint.id}" requires all position axes enabled for exact inverse transfer.`);
		}
	}
	const duplicateDrivenBoneNames = bindings
		.map((binding) => binding.bone.name)
		.filter((boneName, index, all) => all.indexOf(boneName) !== index)
		.filter((boneName, index, all) => all.indexOf(boneName) === index);
	if (duplicateDrivenBoneNames.length) {
		errors.push(`Multiple selected constraints drive the same bone(s): ${duplicateDrivenBoneNames.join(", ")}. Exact inverse output would be order-dependent.`);
	}
	const controlsById = new Map<string, { node: TransformNode; position: boolean; rotation: boolean; owner: string }>();
	for (const binding of bindings) {
		for (const control of binding.controls) {
			const owner = `${binding.layer.id}/${binding.constraint.id}`;
			const existing = controlsById.get(control.node?.id);
			if (!control.node) {
				continue;
			}
			if (existing && existing.owner !== owner) {
				errors.push(`Control node "${control.node.id}" is shared by constraints "${existing.owner}" and "${owner}"; inverse output would be ambiguous.`);
			} else if (existing) {
				existing.position ||= control.position;
				existing.rotation ||= control.rotation;
			} else {
				controlsById.set(control.node.id, { node: control.node, position: control.position, rotation: control.rotation, owner });
			}
		}
	}
	const controls = [...controlsById.values()].map(({ node, position, rotation }) => ({ node, position, rotation }));
	if (controls.length > maximumBakedBones) {
		errors.push(`The inverse bake drives ${controls.length} control nodes; the bounded maximum is ${maximumBakedBones}.`);
	}
	const seenSourceProperties = new Map<any, Set<string>>();
	for (const targeted of group.targetedAnimations) {
		let targetProperties = seenSourceProperties.get(targeted.target);
		if (!targetProperties) {
			targetProperties = new Set();
			seenSourceProperties.set(targeted.target, targetProperties);
		}
		if (targetProperties.has(targeted.animation.targetProperty)) {
			errors.push(`Source target "${targeted.target?.name ?? targeted.target?.id ?? "unknown"}" has duplicate "${targeted.animation.targetProperty}" tracks.`);
		}
		targetProperties.add(targeted.animation.targetProperty);
		try {
			const current = readProperty(targeted.target, targeted.animation.targetProperty);
			if (current === undefined) {
				errors.push(`Track "${targeted.animation.name}" property "${targeted.animation.targetProperty}" does not resolve on its target.`);
			}
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		const control = controls.find((candidate) => candidate.node === targeted.target);
		const channel = channelForProperty(targeted.animation.targetProperty);
		if (control && ((channel === "position" && control.position) || (channel === "rotation" && control.rotation))) {
			errors.push(
				`Source track "${targeted.animation.name}" already animates inverse control "${control.node.name}"; bake from skeleton motion without pre-existing control curves.`
			);
		}
	}
	const transferredAnimations = group.targetedAnimations.filter((targeted) => {
		const channel = channelForProperty(targeted.animation.targetProperty);
		return bindings.some(
			(binding) => matchesBoneTarget(targeted.target, binding.bone) && ((channel === "position" && binding.position) || (channel === "rotation" && binding.rotation))
		);
	});
	const keptAnimations = group.targetedAnimations.filter((targeted) => !transferredAnimations.includes(targeted));
	const controlTrackCount = controls.reduce((count, control) => count + Number(control.position) + Number(control.rotation), 0);
	const keyCount = keptAnimations.reduce((count, targeted) => count + targeted.animation.getKeys().length, 0) + controlTrackCount * frames.length;
	if (keyCount > maximumBakedKeys) {
		errors.push(`The bake would create ${keyCount} keys; the bounded maximum is ${maximumBakedKeys}.`);
	}
	if (!transferredAnimations.length) {
		warnings.push("No direct driven-bone tracks are removed; the baked controls transfer inherited or parent-driven world motion only.");
	}
	const partialPlan = {
		skeleton,
		group,
		layers,
		bindings,
		controls,
		keptAnimations,
		transferredTrackCount: transferredAnimations.length,
		unsupportedConstraintRefs,
		sourceFramesPerSecond: fps.value,
		from,
		to,
		sampleRate,
		frames,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
	return { ...partialPlan, fingerprint: constraintBakeFingerprint(partialPlan) };
}

function publicConstraintBakePlan(plan: IConstraintBakePlan): any {
	const controlTrackCount = plan.controls.reduce((count, control) => count + Number(control.position) + Number(control.rotation), 0);
	const preservedKeyCount = plan.keptAnimations.reduce((count, targeted) => count + targeted.animation.getKeys().length, 0);
	return {
		algorithm: "bounded-skeleton-to-rig-controls-bake-v1",
		fingerprint: plan.fingerprint,
		skeletonId: plan.skeleton.id,
		skeletonName: plan.skeleton.name,
		sourceAnimationGroupName: plan.group.name,
		layerIds: plan.layers.map((layer) => layer.id),
		constraintRefs: plan.bindings.map((binding) => ({ layerId: binding.layer.id, constraintId: binding.constraint.id, type: binding.constraint.type })),
		constraintCount: plan.bindings.length,
		controlNodeCount: plan.controls.length,
		controlNodeIds: plan.controls.map((control) => control.node.id),
		transferredTrackCount: plan.transferredTrackCount,
		preservedTrackCount: plan.keptAnimations.length,
		controlTrackCount,
		trackCount: plan.keptAnimations.length + controlTrackCount,
		from: plan.from,
		to: plan.to,
		sourceFramesPerSecond: plan.sourceFramesPerSecond,
		sampleRate: plan.sampleRate,
		sampleCount: plan.frames.length,
		keyCount: preservedKeyCount + controlTrackCount * plan.frames.length,
		positionTolerance: constraintBakePositionTolerance,
		rotationToleranceDegrees: constraintBakeRotationToleranceDegrees,
		unsupportedConstraintRefs: plan.unsupportedConstraintRefs,
		canBake: plan.errors.length === 0,
		errors: plan.errors,
		warnings: plan.warnings,
	};
}

/** Inspects an exact inverse transfer of skeleton motion to inverse-capable rig controls. */
export function inspectRigToConstraintBake(scene: Scene, data: IConstraintBakeRequest): any {
	return publicConstraintBakePlan(buildConstraintBakePlan(scene, data));
}

function captureTransformNodePose(node: TransformNode): ITransformNodePose {
	return {
		node,
		position: node.position.clone(),
		rotation: node.rotation.clone(),
		rotationQuaternion: node.rotationQuaternion?.clone() ?? null,
		scaling: node.scaling.clone(),
	};
}

function restoreTransformNodePose(pose: ITransformNodePose): void {
	pose.node.position.copyFrom(pose.position);
	pose.node.rotation.copyFrom(pose.rotation);
	pose.node.rotationQuaternion = pose.rotationQuaternion?.clone() ?? null;
	pose.node.scaling.copyFrom(pose.scaling);
	pose.node.computeWorldMatrix(true);
}

function worldTransform(node: TransformNode): { position: Vector3; rotation: Quaternion; scaling: Vector3 } {
	const position = Vector3.Zero();
	const rotation = Quaternion.Identity();
	const scaling = Vector3.One();
	node.computeWorldMatrix(true).decompose(scaling, rotation, position);
	return { position, rotation: rotation.normalize(), scaling };
}

function setWorldTransform(node: TransformNode, position: Vector3, rotation?: Quaternion): void {
	const current = worldTransform(node);
	const world = Matrix.Compose(current.scaling, rotation ?? current.rotation, position);
	const local = node.parent?.getWorldMatrix ? world.multiply(node.parent.getWorldMatrix().clone().invert()) : world;
	const localPosition = Vector3.Zero();
	const localRotation = Quaternion.Identity();
	const localScaling = Vector3.One();
	if (!local.decompose(localScaling, localRotation, localPosition)) {
		throw new Error(`Unable to decompose inverse control transform for "${node.name}".`);
	}
	node.position.copyFrom(localPosition);
	node.rotationQuaternion = localRotation.normalize();
	node.computeWorldMatrix(true);
}

function nodeDepth(node: TransformNode): number {
	let depth = 0;
	let current = node.parent;
	while (current && depth < 256) {
		depth++;
		current = current.parent;
	}
	return depth;
}

function inverseSourcePosition(node: TransformNode, desiredPosition: Vector3, positionOffset: number[] | undefined, desiredRotation?: Quaternion): Vector3 {
	const transform = worldTransform(node);
	const offsetTransform = Matrix.Compose(transform.scaling, desiredRotation ?? transform.rotation, Vector3.Zero());
	const offset = Vector3.TransformCoordinates(Vector3.FromArray(positionOffset ?? [0, 0, 0]), offsetTransform);
	return desiredPosition.subtract(offset);
}

function setInverseControls(binding: IInverseConstraintBinding, desired: { position: Vector3; rotation: Quaternion }): void {
	const controls = [...binding.controls].sort((left, right) => nodeDepth(left.node) - nodeDepth(right.node));
	if (binding.constraint.type === "multiParent") {
		for (const control of controls) {
			const sourceRotation = desired.rotation.multiply(Quaternion.FromArray(control.rotationOffset ?? [0, 0, 0, 1]).conjugate()).normalize();
			setWorldTransform(control.node, inverseSourcePosition(control.node, desired.position, control.positionOffset, sourceRotation), sourceRotation);
		}
		return;
	}
	if (binding.constraint.type === "multiPosition") {
		for (const control of controls) {
			setWorldTransform(control.node, inverseSourcePosition(control.node, desired.position, control.positionOffset));
		}
		return;
	}
	const baseRotation = desired.rotation.multiply(Quaternion.FromArray(binding.constraint.rotationOffset ?? [0, 0, 0, 1]).conjugate()).normalize();
	const direction = Vector3.FromArray(binding.constraint.aimAxis ?? [1, 0, 0])
		.applyRotationQuaternion(baseRotation)
		.normalize();
	for (const control of controls) {
		const current = worldTransform(control.node);
		const distance = Math.max(1, Vector3.Distance(current.position, desired.position));
		setWorldTransform(control.node, desired.position.add(direction.scale(distance)));
	}
}

function rotationErrorDegrees(left: Quaternion, right: Quaternion): number {
	return (2 * Math.acos(Math.min(1, Math.abs(Quaternion.Dot(left.normalize(), right.normalize())))) * 180) / Math.PI;
}

/** Transfers skeleton curves into inverse-capable rig-control curves and validates the real forward evaluator before publication. */
export function bakeRigToConstraintAnimation(scene: Scene, data: IConstraintBakeRequest & { outputName: string; expectedFingerprint: string }, options: IMCPActionOptions): any {
	const plan = buildConstraintBakePlan(scene, data);
	if (data.expectedFingerprint !== plan.fingerprint) {
		throw new Error("Constraint bake inputs changed after inspection. Call inspect_rig_to_constraint_bake again and use its exact fingerprint.");
	}
	if (plan.errors.length) {
		throw new Error(`Constraint bake is blocked: ${plan.errors.join(" ")}`);
	}
	const outputName = String(data.outputName).trim();
	if (!outputName || outputName.length > 256) {
		throw new Error("outputName must contain 1 through 256 characters.");
	}
	if (scene.animationGroups.some((group) => group.name === outputName)) {
		throw new Error(`AnimationGroup "${outputName}" already exists.`);
	}
	const allBonePoses = plan.skeleton.bones.map(captureBonePose);
	const sourceSnapshots = captureSourceProperties(plan.group);
	const controlSnapshots = plan.controls.map((control) => captureTransformNodePose(control.node));
	const samples = new Map<string, { node: TransformNode; position: any[]; rotationQuaternion: any[]; usePosition: boolean; useRotation: boolean }>();
	for (const control of plan.controls) {
		samples.set(control.node.id, { node: control.node, position: [], rotationQuaternion: [], usePosition: control.position, useRotation: control.rotation });
	}
	let maximumPositionError = 0;
	let maximumRotationErrorDegrees = 0;
	const failedConstraintRefs: Array<{ layerId: string; constraintId: string }> = [];
	const restore = (): void => {
		allBonePoses.forEach(restoreBonePose);
		controlSnapshots.forEach(restoreTransformNodePose);
		restoreSourceProperties(sourceSnapshots);
		plan.skeleton.computeAbsoluteMatrices(true);
	};
	try {
		for (const frame of plan.frames) {
			restore();
			for (const targeted of plan.group.targetedAnimations) {
				writeProperty(targeted.target, targeted.animation.targetProperty, targeted.animation.evaluate(frame));
			}
			plan.skeleton.computeAbsoluteMatrices(true);
			const desiredByBone = new Map(
				plan.bindings.map((binding) => [
					binding.bone.name,
					{
						position: binding.bone.getPosition(
							Space.WORLD,
							scene.meshes.find((mesh) => mesh.skeleton === plan.skeleton)
						),
						rotation: binding.bone.getRotationQuaternion(
							Space.WORLD,
							scene.meshes.find((mesh) => mesh.skeleton === plan.skeleton)
						),
					},
				])
			);
			restore();
			for (const targeted of plan.keptAnimations) {
				writeProperty(targeted.target, targeted.animation.targetProperty, targeted.animation.evaluate(frame));
			}
			plan.skeleton.computeAbsoluteMatrices(true);
			for (const binding of plan.bindings) {
				const desired = desiredByBone.get(binding.bone.name)!;
				setInverseControls(binding, desired);
				const evaluation = applyRigLayers(scene as any, {
					skeletonId: plan.skeleton.id,
					layerIds: [binding.layer.id],
					constraintRefs: [{ layerId: binding.layer.id, constraintId: binding.constraint.id }],
					deltaTimeSeconds: 1 / plan.sampleRate,
					resetTemporalState: true,
				});
				if (evaluation.appliedConstraintCount !== 1 || evaluation.failedConstraintIds.length) {
					failedConstraintRefs.push({ layerId: binding.layer.id, constraintId: binding.constraint.id });
					continue;
				}
				plan.skeleton.computeAbsoluteMatrices(true);
				const mesh = scene.meshes.find((candidate) => candidate.skeleton === plan.skeleton);
				if (binding.position) {
					maximumPositionError = Math.max(maximumPositionError, Vector3.Distance(binding.bone.getPosition(Space.WORLD, mesh), desired.position));
				}
				if (binding.rotation) {
					maximumRotationErrorDegrees = Math.max(
						maximumRotationErrorDegrees,
						rotationErrorDegrees(binding.bone.getRotationQuaternion(Space.WORLD, mesh), desired.rotation)
					);
				}
			}
			for (const sample of samples.values()) {
				if (sample.usePosition) {
					sample.position.push({ frame, value: sample.node.position.clone() });
				}
				if (sample.useRotation) {
					let rotationQuaternion = (
						sample.node.rotationQuaternion ?? Quaternion.FromEulerAngles(sample.node.rotation.x, sample.node.rotation.y, sample.node.rotation.z)
					).normalize();
					const previous = sample.rotationQuaternion.at(-1)?.value as Quaternion | undefined;
					if (previous && Quaternion.Dot(previous, rotationQuaternion) < 0) {
						rotationQuaternion = rotationQuaternion.scale(-1);
					}
					sample.rotationQuaternion.push({ frame, value: rotationQuaternion });
				}
			}
		}
	} finally {
		restore();
		resetRigLayerTemporalState(scene as any);
	}
	if (failedConstraintRefs.length) {
		throw new Error(`Constraint bake evaluation failed for: ${JSON.stringify(failedConstraintRefs)}. The original pose was restored and no clip was created.`);
	}
	if (maximumPositionError > constraintBakePositionTolerance || maximumRotationErrorDegrees > constraintBakeRotationToleranceDegrees) {
		throw new Error(
			`Constraint bake forward validation exceeded tolerance (${maximumPositionError.toFixed(6)} cm, ${maximumRotationErrorDegrees.toFixed(6)} degrees). The original pose was restored and no clip was created.`
		);
	}
	const output = new AnimationGroup(outputName, scene, plan.group.weight, plan.group.playOrder);
	try {
		for (const targeted of plan.keptAnimations) {
			output.addTargetedAnimation(targeted.animation.clone(), targeted.target);
		}
		for (const sample of samples.values()) {
			if (sample.usePosition) {
				const animation = new Animation(
					`${sample.node.name} Constraint Bake position`,
					"position",
					plan.sourceFramesPerSecond,
					Animation.ANIMATIONTYPE_VECTOR3,
					Animation.ANIMATIONLOOPMODE_CYCLE
				);
				animation.setKeys(sample.position);
				output.addTargetedAnimation(animation, sample.node);
			}
			if (sample.useRotation) {
				const animation = new Animation(
					`${sample.node.name} Constraint Bake rotationQuaternion`,
					"rotationQuaternion",
					plan.sourceFramesPerSecond,
					Animation.ANIMATIONTYPE_QUATERNION,
					Animation.ANIMATIONLOOPMODE_CYCLE
				);
				animation.setKeys(sample.rotationQuaternion);
				output.addTargetedAnimation(animation, sample.node);
			}
		}
		output.loopAnimation = plan.group.loopAnimation;
		output.isAdditive = plan.group.isAdditive;
		output.speedRatio = plan.group.speedRatio;
		output.metadata = {
			babylonEditorConstraintBake: {
				algorithm: "bounded-skeleton-to-rig-controls-bake-v1",
				fingerprint: plan.fingerprint,
				skeletonId: plan.skeleton.id,
				sourceAnimationGroupName: plan.group.name,
				constraintRefs: plan.bindings.map((binding) => ({ layerId: binding.layer.id, constraintId: binding.constraint.id })),
				from: plan.from,
				to: plan.to,
				sampleRate: plan.sampleRate,
				maximumPositionError,
				maximumRotationErrorDegrees,
			},
		};
	} catch (error) {
		output.dispose();
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.animations?.forceUpdate?.();
	return {
		created: true,
		name: output.name,
		...publicConstraintBakePlan(plan),
		trackCount: output.targetedAnimations.length,
		maximumPositionError,
		maximumRotationErrorDegrees,
		failedConstraintRefs: [],
		poseRestored: true,
		temporalStateReset: true,
	};
}

interface ITwoBoneIKBakeRequest {
	skeletonId: string;
	sourceAnimationGroupName: string;
	ikControllerIds?: string[];
	from?: number;
	to?: number;
	sampleRate?: number;
}

interface ITwoBoneIKBakeBinding {
	config: any;
	rootBone: Bone;
	midBone: Bone;
	tipBone: Bone | null;
	mesh: TransformNode;
	target: TransformNode;
	poleTarget: TransformNode | null;
}

interface ITwoBoneIKBakePlan {
	skeleton: Skeleton;
	group: AnimationGroup;
	bindings: ITwoBoneIKBakeBinding[];
	controls: TransformNode[];
	rotationControls: TransformNode[];
	keptAnimations: any[];
	transferredTrackCount: number;
	sourceFramesPerSecond: number;
	from: number;
	to: number;
	sampleRate: number;
	frames: number[];
	errors: string[];
	warnings: string[];
	fingerprint: string;
}

const maximumTwoBoneIKControllers = 128;
const twoBoneIKPoleSolverEvaluationCount = 37;
const maximumTwoBoneIKPoleSolverEvaluations = 1_000_000;

function twoBoneIKTargetRotationWeight(binding: ITwoBoneIKBakeBinding): number {
	return Number(binding.config.targetRotationWeight ?? 0);
}

function twoBoneSegmentLengths(binding: ITwoBoneIKBakeBinding): [number, number] {
	if (binding.rootBone.length && binding.midBone.length) {
		return [binding.rootBone.length * binding.rootBone.getScale().y * binding.mesh.scaling.y, binding.midBone.length * binding.midBone.getScale().y * binding.mesh.scaling.y];
	}
	const rootPosition = binding.rootBone.getPosition(Space.WORLD, binding.mesh);
	const midPosition = binding.midBone.getPosition(Space.WORLD, binding.mesh);
	if (binding.tipBone) {
		return [Vector3.Distance(rootPosition, midPosition), Vector3.Distance(midPosition, binding.tipBone.getPosition(Space.WORLD, binding.mesh))];
	}
	return [Vector3.Distance(rootPosition, midPosition), binding.midBone.length * binding.midBone.getScale().y * binding.mesh.scaling.y];
}

function twoBoneJointAndTipPositions(binding: ITwoBoneIKBakeBinding): { jointPosition: Vector3; tipPosition: Vector3 } {
	const rootPosition = binding.rootBone.getPosition(Space.WORLD, binding.mesh);
	const [rootLength, midLength] = twoBoneSegmentLengths(binding);
	const rootDirection = Vector3.Up().applyRotationQuaternion(binding.rootBone.getRotationQuaternion(Space.WORLD, binding.mesh));
	const midDirection = Vector3.Up().applyRotationQuaternion(binding.midBone.getRotationQuaternion(Space.WORLD, binding.mesh));
	const jointPosition = rootPosition.add(rootDirection.scale(rootLength));
	return { jointPosition, tipPosition: jointPosition.add(midDirection.scale(midLength)) };
}

function twoBoneIKBakeFingerprint(plan: Omit<ITwoBoneIKBakePlan, "fingerprint">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				algorithm: "bounded-two-bone-ik-to-controls-bake-v1",
				skeletonId: plan.skeleton.id,
				sourceAnimationGroupName: plan.group.name,
				from: plan.from,
				to: plan.to,
				sampleRate: plan.sampleRate,
				groupSettings: {
					isAdditive: plan.group.isAdditive,
					loopAnimation: plan.group.loopAnimation,
					speedRatio: plan.group.speedRatio,
					weight: plan.group.weight,
					playOrder: plan.group.playOrder,
				},
				controllers: plan.bindings.map((binding) => serializedValue(binding.config)),
				controls: plan.controls.map(controlNodeState),
				meshes: plan.bindings.map((binding) => controlNodeState(binding.mesh)),
				// IK preview evaluates on every render frame. Fingerprint the authored bone
				// rest matrices instead of its transient solver output so an inspection
				// lease remains usable by the immediately following live bake.
				baselineBones: plan.skeleton.bones.map((bone) => ({ name: bone.name, baseMatrix: bone.getBaseMatrix().asArray() })),
				sourceValues: plan.group.targetedAnimations.map((targeted) => ({
					targetId: targeted.target?.id ?? null,
					targetName: targeted.target?.name ?? null,
					property: targeted.animation.targetProperty,
					// Bone values are also live solver outputs. Their authored animation
					// curves are fingerprinted below; non-bone targets retain current-value
					// stale detection.
					value: targeted.target instanceof Bone ? null : fingerprintPropertyValue(targeted.target, targeted.animation.targetProperty),
				})),
				tracks: plan.group.targetedAnimations.map((targeted) => ({
					targetId: targeted.target?.id ?? null,
					targetName: targeted.target?.name ?? null,
					property: targeted.animation.targetProperty,
					framePerSecond: targeted.animation.framePerSecond,
					dataType: targeted.animation.dataType,
					loopMode: targeted.animation.loopMode,
					keys: targeted.animation.getKeys().map((key) => ({ frame: key.frame, value: serializedValue(key.value), interpolation: key.interpolation ?? null })),
				})),
			})
		)
		.digest("hex");
}

function buildTwoBoneIKBakePlan(scene: Scene, data: ITwoBoneIKBakeRequest): ITwoBoneIKBakePlan {
	const skeleton = resolveSkeleton(scene, data.skeletonId);
	const group = scene.animationGroups.find((candidate) => candidate.name === data.sourceAnimationGroupName);
	if (!group) {
		throw new Error(`AnimationGroup "${data.sourceAnimationGroupName}" was not found.`);
	}
	if (!group.targetedAnimations.length) {
		throw new Error(`AnimationGroup "${group.name}" has no tracks to transfer.`);
	}
	const allConfigs = Array.isArray(scene.metadata?.babylonEditorIKControllers) ? scene.metadata.babylonEditorIKControllers : [];
	const requestedIds = data.ikControllerIds ? [...new Set(data.ikControllerIds)] : null;
	if (requestedIds && requestedIds.length !== data.ikControllerIds!.length) {
		throw new Error("ikControllerIds must not contain duplicates.");
	}
	if (requestedIds) {
		for (const id of requestedIds) {
			const config = allConfigs.find((candidate: any) => candidate.id === id);
			if (!config) {
				throw new Error(`IK controller "${id}" was not found.`);
			}
			if (config.skeletonId !== skeleton.id) {
				throw new Error(`IK controller "${id}" does not belong to skeleton "${skeleton.id}".`);
			}
		}
	}
	const configs = allConfigs.filter((config: any) => config.skeletonId === skeleton.id && config.enabled !== false && (!requestedIds || requestedIds.includes(config.id)));
	const errors: string[] = [];
	const warnings: string[] = [];
	const bindings: ITwoBoneIKBakeBinding[] = [];
	for (const config of configs) {
		const midBone = skeleton.bones.find((bone) => bone.name === config.boneName);
		const rootBone = midBone?.getParent() ?? null;
		const tipBone = midBone?.children[0] ?? null;
		const mesh = scene.meshes.find((candidate) => candidate.id === config.meshId && candidate.skeleton === skeleton);
		const target = scene.getNodeById(config.targetNodeId);
		const poleTarget = config.poleTargetNodeId ? scene.getNodeById(config.poleTargetNodeId) : null;
		if (!midBone || !rootBone || (!tipBone && !(midBone.length > 0)) || !(mesh instanceof TransformNode) || !(target instanceof TransformNode)) {
			errors.push(`IK controller "${config.id}" has an unresolved mesh, root/mid/tip chain, or target reference.`);
			continue;
		}
		if (config.poleTargetNodeId && !(poleTarget instanceof TransformNode)) {
			errors.push(`IK controller "${config.id}" has an unresolved pole target reference.`);
			continue;
		}
		if (Math.abs(Number(config.slerpAmount ?? 1) - 1) > 1e-6) {
			errors.push(`IK controller "${config.id}" requires slerpAmount 1 for deterministic exact inverse transfer.`);
		}
		const targetPositionWeight = Number(config.targetPositionWeight ?? 1);
		if (!Number.isFinite(targetPositionWeight) || targetPositionWeight < 0 || targetPositionWeight > 1) {
			errors.push(`IK controller "${config.id}" has an invalid targetPositionWeight; use a finite value from 0 through 1.`);
		} else if (Math.abs(targetPositionWeight - 1) > 1e-6) {
			errors.push(`IK controller "${config.id}" requires targetPositionWeight 1 for deterministic exact inverse transfer.`);
		}
		const targetRotationWeight = Number(config.targetRotationWeight ?? 0);
		if (!Number.isFinite(targetRotationWeight) || targetRotationWeight < 0 || targetRotationWeight > 1) {
			errors.push(`IK controller "${config.id}" has an invalid targetRotationWeight; use a finite value from 0 through 1.`);
		} else if (targetRotationWeight > 1e-6 && Math.abs(targetRotationWeight - 1) > 1e-6) {
			errors.push(`IK controller "${config.id}" requires targetRotationWeight 0 or 1 for deterministic exact inverse transfer.`);
		}
		if (targetRotationWeight > 1e-6 && !tipBone) {
			errors.push(`IK controller "${config.id}" requires a Tip child bone when targetRotationWeight is greater than zero.`);
		}
		const hintWeight = Number(config.hintWeight ?? 1);
		if (!Number.isFinite(hintWeight) || hintWeight < 0 || hintWeight > 1) {
			errors.push(`IK controller "${config.id}" has an invalid hintWeight; use a finite value from 0 through 1.`);
		} else if (poleTarget && Math.abs(hintWeight - 1) > 1e-6) {
			errors.push(`IK controller "${config.id}" requires hintWeight 1 for deterministic exact pole/hint inverse transfer.`);
		}
		if (config.maintainTargetPositionOffset && (!Array.isArray(config.targetPositionOffset) || config.targetPositionOffset.length !== 3)) {
			errors.push(`IK controller "${config.id}" has Maintain Target Position Offset enabled without a valid captured three-component offset.`);
		}
		if (config.maintainTargetRotationOffset && (!Array.isArray(config.targetRotationOffset) || config.targetRotationOffset.length !== 4)) {
			errors.push(`IK controller "${config.id}" has Maintain Target Rotation Offset enabled without a valid captured quaternion offset.`);
		}
		bindings.push({ config, rootBone, midBone, tipBone, mesh, target, poleTarget: poleTarget as TransformNode | null });
	}
	if (!bindings.length) {
		errors.push(`Skeleton "${skeleton.name}" has no enabled native Two-Bone IK controllers selected for baking.`);
	}
	if (bindings.length > maximumTwoBoneIKControllers) {
		errors.push(`The bake selects ${bindings.length} IK controllers; the bounded maximum is ${maximumTwoBoneIKControllers}.`);
	}
	const drivenBoneOwners = new Map<string, string>();
	const controlOwners = new Map<string, string>();
	for (const binding of bindings) {
		const drivenBones = [binding.rootBone, binding.midBone, ...(twoBoneIKTargetRotationWeight(binding) > 1e-6 && binding.tipBone ? [binding.tipBone] : [])];
		for (const bone of drivenBones) {
			const owner = drivenBoneOwners.get(bone.name);
			if (owner) {
				errors.push(`IK controllers "${owner}" and "${binding.config.id}" overlap on driven bone "${bone.name}".`);
			} else {
				drivenBoneOwners.set(bone.name, binding.config.id);
			}
		}
		for (const control of [binding.target, binding.poleTarget].filter((candidate): candidate is TransformNode => !!candidate)) {
			const owner = controlOwners.get(control.id);
			if (owner) {
				errors.push(`IK controllers "${owner}" and "${binding.config.id}" share control node "${control.id}".`);
			} else {
				controlOwners.set(control.id, binding.config.id);
			}
		}
		if (binding.target === binding.poleTarget) {
			errors.push(`IK controller "${binding.config.id}" cannot use the same node as target and pole target.`);
		}
	}
	const controls = [...new Map(bindings.flatMap((binding) => [binding.target, ...(binding.poleTarget ? [binding.poleTarget] : [])]).map((node) => [node.id, node])).values()];
	const rotationControls = [
		...new Map(
			bindings.filter((binding) => Math.abs(twoBoneIKTargetRotationWeight(binding) - 1) <= 1e-6).map((binding) => [binding.target.id, binding.target] as const)
		).values(),
	];
	const controlIds = new Set(controls.map((control) => control.id));
	const rotationControlIds = new Set(rotationControls.map((control) => control.id));
	for (const control of controls) {
		let parent = control.parent;
		while (parent instanceof TransformNode) {
			if (controlIds.has(parent.id)) {
				errors.push(`IK control "${control.id}" is parented below selected control "${parent.id}"; inverse output would be order-dependent.`);
				break;
			}
			parent = parent.parent;
		}
	}
	const fps = sourceFramesPerSecond(group);
	const from = data.from ?? group.from;
	const to = data.to ?? group.to;
	const sampleRate = data.sampleRate ?? fps.value;
	if (!Number.isFinite(from) || !Number.isFinite(to) || from < group.from || to > group.to || from >= to) {
		throw new Error(`Two-Bone IK bake range must be finite, increasing, and contained within source frames ${group.from} through ${group.to}.`);
	}
	if (!Number.isFinite(sampleRate) || sampleRate < 1 || sampleRate > 120) {
		throw new Error("Two-Bone IK bake sampleRate must be a finite value from 1 through 120.");
	}
	const frames = sampledFrames(from, to, fps.value, sampleRate);
	if (fps.mixed) {
		errors.push("The source AnimationGroup uses mixed track frame rates; normalize it before Two-Bone IK baking.");
	}
	if (group.isAdditive) {
		errors.push("Additive source AnimationGroups require base-pose composition and are not eligible for exact Two-Bone IK transfer.");
	}
	if (frames.length > maximumBakeSamples) {
		errors.push(`The requested range produces ${frames.length} samples; the bounded maximum is ${maximumBakeSamples}.`);
	}
	const seenSourceProperties = new Map<any, Set<string>>();
	const seenSourceChannels = new Map<any, Set<string>>();
	for (const targeted of group.targetedAnimations) {
		let properties = seenSourceProperties.get(targeted.target);
		if (!properties) {
			seenSourceProperties.set(targeted.target, (properties = new Set()));
		}
		if (properties.has(targeted.animation.targetProperty)) {
			errors.push(`Source target "${targeted.target?.name ?? targeted.target?.id ?? "unknown"}" has duplicate "${targeted.animation.targetProperty}" tracks.`);
		}
		properties.add(targeted.animation.targetProperty);
		const channel = channelForProperty(targeted.animation.targetProperty);
		if (channel) {
			let channels = seenSourceChannels.get(targeted.target);
			if (!channels) {
				seenSourceChannels.set(targeted.target, (channels = new Set()));
			}
			if (channels.has(channel)) {
				errors.push(`Source target "${targeted.target?.name ?? targeted.target?.id ?? "unknown"}" has multiple ${channel} representations.`);
			}
			channels.add(channel);
		}
		try {
			if (readProperty(targeted.target, targeted.animation.targetProperty) === undefined) {
				errors.push(`Track "${targeted.animation.name}" property "${targeted.animation.targetProperty}" does not resolve on its target.`);
			}
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
		if (controls.includes(targeted.target) && channel === "position") {
			errors.push(
				`Source track "${targeted.animation.name}" already animates IK control "${targeted.target.name}"; bake from skeleton motion without pre-existing control curves.`
			);
		}
		if (rotationControlIds.has(targeted.target?.id) && channel === "rotation") {
			errors.push(
				`Source track "${targeted.animation.name}" already animates target rotation on IK control "${targeted.target.name}"; bake from skeleton motion without pre-existing target rotation curves.`
			);
		}
	}
	const transferredAnimations = group.targetedAnimations.filter(
		(targeted) =>
			channelForProperty(targeted.animation.targetProperty) === "rotation" &&
			bindings.some(
				(binding) =>
					matchesBoneTarget(targeted.target, binding.rootBone) ||
					matchesBoneTarget(targeted.target, binding.midBone) ||
					(twoBoneIKTargetRotationWeight(binding) > 1e-6 && !!binding.tipBone && matchesBoneTarget(targeted.target, binding.tipBone))
			)
	);
	const keptAnimations = group.targetedAnimations.filter((targeted) => !transferredAnimations.includes(targeted));
	if (!transferredAnimations.length) {
		warnings.push("No direct root/mid rotation tracks are removed; the baked controls transfer inherited skeleton motion only.");
	}
	if (bindings.some((binding) => !binding.poleTarget)) {
		warnings.push("Controllers without a pole target bake target curves only and must pass exact forward validation using their configured ancestor pole behavior.");
	}
	const controlTrackCount = controls.length + rotationControls.length;
	const keyCount = keptAnimations.reduce((count, targeted) => count + targeted.animation.getKeys().length, 0) + controlTrackCount * frames.length;
	if (keyCount > maximumBakedKeys) {
		errors.push(`The bake would create ${keyCount} keys; the bounded maximum is ${maximumBakedKeys}.`);
	}
	const poleSolverEvaluationCount = frames.length * bindings.reduce((count, binding) => count + (binding.poleTarget ? twoBoneIKPoleSolverEvaluationCount : 1), 0);
	if (poleSolverEvaluationCount > maximumTwoBoneIKPoleSolverEvaluations) {
		errors.push(`The bake would run ${poleSolverEvaluationCount} native IK solver evaluations; the bounded maximum is ${maximumTwoBoneIKPoleSolverEvaluations}.`);
	}
	const partialPlan = {
		skeleton,
		group,
		bindings,
		controls,
		rotationControls,
		keptAnimations,
		transferredTrackCount: transferredAnimations.length,
		sourceFramesPerSecond: fps.value,
		from,
		to,
		sampleRate,
		frames,
		errors: [...new Set(errors)],
		warnings: [...new Set(warnings)],
	};
	return { ...partialPlan, fingerprint: twoBoneIKBakeFingerprint(partialPlan) };
}

function publicTwoBoneIKBakePlan(plan: ITwoBoneIKBakePlan): any {
	const preservedKeyCount = plan.keptAnimations.reduce((count, targeted) => count + targeted.animation.getKeys().length, 0);
	const controlTrackCount = plan.controls.length + plan.rotationControls.length;
	return {
		algorithm: "bounded-two-bone-ik-to-controls-bake-v1",
		fingerprint: plan.fingerprint,
		skeletonId: plan.skeleton.id,
		skeletonName: plan.skeleton.name,
		sourceAnimationGroupName: plan.group.name,
		ikControllerIds: plan.bindings.map((binding) => binding.config.id),
		controllerCount: plan.bindings.length,
		controllerEvidence: plan.bindings.map((binding) => ({
			id: binding.config.id,
			rootBoneName: binding.rootBone.name,
			midBoneName: binding.midBone.name,
			tipBoneName: binding.tipBone?.name ?? null,
			targetNodeId: binding.target.id,
			poleTargetNodeId: binding.poleTarget?.id ?? null,
			targetPositionWeight: Number(binding.config.targetPositionWeight ?? 1),
			targetRotationWeight: Number(binding.config.targetRotationWeight ?? 0),
			hintWeight: Number(binding.config.hintWeight ?? 1),
			maintainTargetPositionOffset: binding.config.maintainTargetPositionOffset === true,
			maintainTargetRotationOffset: binding.config.maintainTargetRotationOffset === true,
		})),
		controlNodeCount: plan.controls.length,
		controlNodeIds: plan.controls.map((control) => control.id),
		rotationControlNodeCount: plan.rotationControls.length,
		rotationControlNodeIds: plan.rotationControls.map((control) => control.id),
		transferredTrackCount: plan.transferredTrackCount,
		preservedTrackCount: plan.keptAnimations.length,
		controlTrackCount,
		trackCount: plan.keptAnimations.length + controlTrackCount,
		from: plan.from,
		to: plan.to,
		sourceFramesPerSecond: plan.sourceFramesPerSecond,
		sampleRate: plan.sampleRate,
		sampleCount: plan.frames.length,
		keyCount: preservedKeyCount + controlTrackCount * plan.frames.length,
		poleSolverEvaluationCount: plan.frames.length * plan.bindings.reduce((count, binding) => count + (binding.poleTarget ? twoBoneIKPoleSolverEvaluationCount : 1), 0),
		positionTolerance: constraintBakePositionTolerance,
		rotationToleranceDegrees: constraintBakeRotationToleranceDegrees,
		canBake: plan.errors.length === 0,
		errors: plan.errors,
		warnings: plan.warnings,
	};
}

/** Inspects native Two-Bone IK target/hint curve transfer without mutating the scene. */
export function inspectTwoBoneIKConstraintBake(scene: Scene, data: ITwoBoneIKBakeRequest): any {
	return publicTwoBoneIKBakePlan(buildTwoBoneIKBakePlan(scene, data));
}

function inversePoleTargetPosition(binding: ITwoBoneIKBakeBinding, rootPosition: Vector3, midPosition: Vector3, tipPosition: Vector3): Vector3 {
	let direction = rootPosition.subtract(midPosition);
	if (direction.lengthSquared() < 1e-8) {
		direction = Vector3.Up();
	}
	const targetAxis = tipPosition.subtract(rootPosition);
	const poleAngle = Number(binding.config.poleAngle ?? 0);
	if (Math.abs(poleAngle) > 1e-8 && targetAxis.lengthSquared() > 1e-8) {
		direction = direction.applyRotationQuaternion(Quaternion.RotationAxis(targetAxis.normalize(), -poleAngle));
	}
	return rootPosition.add(direction);
}

function solveTwoBoneIKPolePosition(
	scene: Scene,
	binding: ITwoBoneIKBakeBinding,
	desired: { rootPosition: Vector3; jointPosition: Vector3; tipPosition: Vector3; rootRotation: Quaternion; midRotation: Quaternion }
): boolean {
	if (!binding.poleTarget) {
		return evaluateIKController(scene, binding.config.id);
	}
	const axis = desired.tipPosition.subtract(desired.rootPosition);
	if (axis.lengthSquared() < 1e-10) {
		setWorldTransform(binding.poleTarget, inversePoleTargetPosition(binding, desired.rootPosition, desired.jointPosition, desired.tipPosition));
		return evaluateIKController(scene, binding.config.id);
	}
	axis.normalize();
	let initialDirection = desired.rootPosition.subtract(desired.jointPosition);
	initialDirection.subtractInPlace(axis.scale(Vector3.Dot(initialDirection, axis)));
	if (initialDirection.lengthSquared() < 1e-10) {
		initialDirection = Vector3.Cross(axis, Math.abs(Vector3.Dot(axis, Vector3.Up())) < 0.9 ? Vector3.Up() : Vector3.Right());
	}
	initialDirection.normalize();
	const poleDistance = Math.max(...twoBoneSegmentLengths(binding).map(Math.abs), 1);
	const evaluateAngle = (angle: number): number => {
		const direction = initialDirection.applyRotationQuaternion(Quaternion.RotationAxis(axis, angle));
		setWorldTransform(binding.poleTarget!, desired.rootPosition.add(direction.scale(poleDistance)));
		if (!evaluateIKController(scene, binding.config.id)) {
			return Number.POSITIVE_INFINITY;
		}
		binding.rootBone.getSkeleton().computeAbsoluteMatrices(true);
		return Math.max(
			rotationErrorDegrees(binding.rootBone.getRotationQuaternion(Space.WORLD, binding.mesh), desired.rootRotation),
			rotationErrorDegrees(binding.midBone.getRotationQuaternion(Space.WORLD, binding.mesh), desired.midRotation)
		);
	};
	const coarseCount = 16;
	let bestAngle = 0;
	let bestError = Number.POSITIVE_INFINITY;
	for (let index = 0; index < coarseCount; index++) {
		const angle = (index * Math.PI * 2) / coarseCount;
		const error = evaluateAngle(angle);
		if (error < bestError) {
			bestAngle = angle;
			bestError = error;
		}
	}
	let step = (Math.PI * 2) / coarseCount;
	for (let iteration = 0; iteration < 10; iteration++) {
		step *= 0.5;
		const leftAngle = bestAngle - step;
		const rightAngle = bestAngle + step;
		const leftError = evaluateAngle(leftAngle);
		const rightError = evaluateAngle(rightAngle);
		if (leftError < bestError && leftError <= rightError) {
			bestAngle = leftAngle;
			bestError = leftError;
		} else if (rightError < bestError) {
			bestAngle = rightAngle;
			bestError = rightError;
		}
	}
	return Number.isFinite(evaluateAngle(bestAngle));
}

/** Transfers native Two-Bone IK-driven skeleton rotations into target position/rotation and optional hint position curves with exact forward validation. */
export function bakeTwoBoneIKConstraintAnimation(scene: Scene, data: ITwoBoneIKBakeRequest & { outputName: string; expectedFingerprint: string }, options: IMCPActionOptions): any {
	const plan = buildTwoBoneIKBakePlan(scene, data);
	if (data.expectedFingerprint !== plan.fingerprint) {
		throw new Error("Two-Bone IK bake inputs changed after inspection. Call inspect_two_bone_ik_constraint_bake again and use its exact fingerprint.");
	}
	if (plan.errors.length) {
		throw new Error(`Two-Bone IK bake is blocked: ${plan.errors.join(" ")}`);
	}
	const outputName = String(data.outputName).trim();
	if (!outputName || outputName.length > 256) {
		throw new Error("outputName must contain 1 through 256 characters.");
	}
	if (scene.animationGroups.some((group) => group.name === outputName)) {
		throw new Error(`AnimationGroup "${outputName}" already exists.`);
	}
	const allBonePoses = plan.skeleton.bones.map(captureBonePose);
	const sourceSnapshots = captureSourceProperties(plan.group);
	const controlSnapshots = plan.controls.map(captureTransformNodePose);
	const rotationControlIds = new Set(plan.rotationControls.map((control) => control.id));
	const samples = new Map(
		plan.controls.map((control) => [control.id, { node: control, position: [] as any[], rotationQuaternion: [] as any[], useRotation: rotationControlIds.has(control.id) }])
	);
	let maximumPositionError = 0;
	let maximumRotationErrorDegrees = 0;
	let maximumTargetRotationErrorDegrees = 0;
	const failedControllerIds: string[] = [];
	const restore = (): void => {
		allBonePoses.forEach(restoreBonePose);
		controlSnapshots.forEach(restoreTransformNodePose);
		restoreSourceProperties(sourceSnapshots);
		plan.skeleton.computeAbsoluteMatrices(true);
	};
	try {
		for (const binding of plan.bindings) {
			if (!rebuildIKControllerRuntime(scene, binding.config.id)) {
				failedControllerIds.push(binding.config.id);
			}
		}
		if (failedControllerIds.length) {
			throw new Error(`Unable to initialize selected native IK controller(s): ${failedControllerIds.join(", ")}.`);
		}
		for (const frame of plan.frames) {
			restore();
			for (const targeted of plan.group.targetedAnimations) {
				writeProperty(targeted.target, targeted.animation.targetProperty, targeted.animation.evaluate(frame));
			}
			plan.skeleton.computeAbsoluteMatrices(true);
			const desired = plan.bindings.map((binding) => {
				const virtualChain = twoBoneJointAndTipPositions(binding);
				return {
					binding,
					rootPosition: binding.rootBone.getPosition(Space.WORLD, binding.mesh),
					...virtualChain,
					rootRotation: binding.rootBone.getRotationQuaternion(Space.WORLD, binding.mesh),
					midRotation: binding.midBone.getRotationQuaternion(Space.WORLD, binding.mesh),
					tipRotation: binding.tipBone?.getRotationQuaternion(Space.WORLD, binding.mesh) ?? null,
				};
			});
			restore();
			for (const targeted of plan.keptAnimations) {
				writeProperty(targeted.target, targeted.animation.targetProperty, targeted.animation.evaluate(frame));
			}
			plan.skeleton.computeAbsoluteMatrices(true);
			for (const sample of desired) {
				const rotationWeight = twoBoneIKTargetRotationWeight(sample.binding);
				const targetRotation =
					rotationWeight > 1e-6 && sample.tipRotation
						? sample.tipRotation
								.multiply(
									sample.binding.config.maintainTargetRotationOffset
										? Quaternion.FromArray(sample.binding.config.targetRotationOffset).conjugate()
										: Quaternion.Identity()
								)
								.normalize()
						: undefined;
				const targetPosition = inverseSourcePosition(
					sample.binding.target,
					sample.tipPosition,
					sample.binding.config.maintainTargetPositionOffset ? sample.binding.config.targetPositionOffset : undefined,
					targetRotation
				);
				setWorldTransform(sample.binding.target, targetPosition, targetRotation);
				if (!solveTwoBoneIKPolePosition(scene, sample.binding, sample)) {
					failedControllerIds.push(sample.binding.config.id);
					continue;
				}
				plan.skeleton.computeAbsoluteMatrices(true);
				maximumPositionError = Math.max(maximumPositionError, Vector3.Distance(twoBoneJointAndTipPositions(sample.binding).tipPosition, sample.tipPosition));
				maximumRotationErrorDegrees = Math.max(
					maximumRotationErrorDegrees,
					rotationErrorDegrees(sample.binding.rootBone.getRotationQuaternion(Space.WORLD, sample.binding.mesh), sample.rootRotation),
					rotationErrorDegrees(sample.binding.midBone.getRotationQuaternion(Space.WORLD, sample.binding.mesh), sample.midRotation)
				);
				if (rotationWeight > 1e-6 && sample.binding.tipBone && sample.tipRotation) {
					const tipRotationError = rotationErrorDegrees(sample.binding.tipBone.getRotationQuaternion(Space.WORLD, sample.binding.mesh), sample.tipRotation);
					maximumTargetRotationErrorDegrees = Math.max(maximumTargetRotationErrorDegrees, tipRotationError);
					maximumRotationErrorDegrees = Math.max(maximumRotationErrorDegrees, tipRotationError);
				}
			}
			for (const sample of samples.values()) {
				sample.position.push({ frame, value: sample.node.position.clone() });
				if (sample.useRotation) {
					let rotationQuaternion = (
						sample.node.rotationQuaternion ?? Quaternion.FromEulerAngles(sample.node.rotation.x, sample.node.rotation.y, sample.node.rotation.z)
					).normalize();
					const previous = sample.rotationQuaternion.at(-1)?.value as Quaternion | undefined;
					if (previous && Quaternion.Dot(previous, rotationQuaternion) < 0) {
						rotationQuaternion = rotationQuaternion.scale(-1);
					}
					sample.rotationQuaternion.push({ frame, value: rotationQuaternion });
				}
			}
		}
	} finally {
		restore();
	}
	if (failedControllerIds.length) {
		throw new Error(
			`Two-Bone IK bake evaluation failed for controller(s): ${[...new Set(failedControllerIds)].join(", ")}. Original state was restored and no clip was created.`
		);
	}
	if (maximumPositionError > constraintBakePositionTolerance || maximumRotationErrorDegrees > constraintBakeRotationToleranceDegrees) {
		throw new Error(
			`Two-Bone IK bake forward validation exceeded tolerance (${maximumPositionError.toFixed(6)} cm, ${maximumRotationErrorDegrees.toFixed(6)} degrees). Original state was restored and no clip was created.`
		);
	}
	const output = new AnimationGroup(outputName, scene, plan.group.weight, plan.group.playOrder);
	try {
		for (const targeted of plan.keptAnimations) {
			output.addTargetedAnimation(targeted.animation.clone(), targeted.target);
		}
		for (const sample of samples.values()) {
			const positionAnimation = new Animation(
				`${sample.node.name} Two-Bone IK Bake position`,
				"position",
				plan.sourceFramesPerSecond,
				Animation.ANIMATIONTYPE_VECTOR3,
				Animation.ANIMATIONLOOPMODE_CYCLE
			);
			positionAnimation.setKeys(sample.position);
			output.addTargetedAnimation(positionAnimation, sample.node);
			if (sample.useRotation) {
				const rotationAnimation = new Animation(
					`${sample.node.name} Two-Bone IK Bake rotationQuaternion`,
					"rotationQuaternion",
					plan.sourceFramesPerSecond,
					Animation.ANIMATIONTYPE_QUATERNION,
					Animation.ANIMATIONLOOPMODE_CYCLE
				);
				rotationAnimation.setKeys(sample.rotationQuaternion);
				output.addTargetedAnimation(rotationAnimation, sample.node);
			}
		}
		output.loopAnimation = plan.group.loopAnimation;
		output.isAdditive = plan.group.isAdditive;
		output.speedRatio = plan.group.speedRatio;
		output.metadata = {
			babylonEditorTwoBoneIKConstraintBake: {
				algorithm: "bounded-two-bone-ik-to-controls-bake-v1",
				fingerprint: plan.fingerprint,
				skeletonId: plan.skeleton.id,
				sourceAnimationGroupName: plan.group.name,
				ikControllerIds: plan.bindings.map((binding) => binding.config.id),
				from: plan.from,
				to: plan.to,
				sampleRate: plan.sampleRate,
				maximumPositionError,
				maximumRotationErrorDegrees,
				maximumTargetRotationErrorDegrees,
			},
		};
	} catch (error) {
		output.dispose();
		throw error;
	}
	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.animations?.forceUpdate?.();
	return {
		created: true,
		name: output.name,
		...publicTwoBoneIKBakePlan(plan),
		trackCount: output.targetedAnimations.length,
		maximumPositionError,
		maximumRotationErrorDegrees,
		maximumTargetRotationErrorDegrees,
		failedControllerIds: [],
		poseRestored: true,
		controlStateRestored: true,
	};
}
