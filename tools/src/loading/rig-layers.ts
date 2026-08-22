import { Bone } from "@babylonjs/core/Bones/bone";
import { Skeleton } from "@babylonjs/core/Bones/skeleton";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

const configuredScenes = new WeakSet<Scene>();
const dampedTransformStates = new WeakMap<Scene, Map<string, { signature: string; position: Vector3; rotation: Quaternion }>>();
const animationRigJobDefinitions = new Map<string, IAnimationRigJobDefinition>();
const animationRigJobStates = new WeakMap<Scene, Map<string, IAnimationRigJobRuntimeState>>();
const animationRigProfilerStates = new WeakMap<Scene, IAnimationRigProfilerState>();

const maximumAnimationRigProfileLayers = 64;
const maximumAnimationRigProfileConstraints = 256;

export interface IAnimationRigProfilerSettings {
	enabled: boolean;
	sampleCapacity: number;
	sampleEveryNEvaluations: number;
}

export type AnimationRigProfileStatus = "applied" | "failed" | "disabled" | "zeroWeight" | "invalidConstraints";

export interface IAnimationRigConstraintProfileSample {
	constraintId: string;
	name: string;
	type: string;
	enabled: boolean;
	status: "applied" | "failed" | "disabled";
	durationMilliseconds: number;
}

export interface IAnimationRigLayerProfileSample {
	layerId: string;
	name: string;
	skeletonId: string;
	enabled: boolean;
	weight: number;
	status: AnimationRigProfileStatus;
	durationMilliseconds: number;
	constraintCount: number;
	appliedConstraintCount: number;
	failedConstraintCount: number;
	disabledConstraintCount: number;
	constraints: IAnimationRigConstraintProfileSample[];
	truncatedConstraintCount: number;
}

export interface IAnimationRigProfileSample {
	evaluationIndex: number;
	capturedAt: string;
	deltaTimeSeconds: number;
	durationMilliseconds: number;
	layerCount: number;
	constraintCount: number;
	appliedConstraintCount: number;
	failedConstraintCount: number;
	disabledConstraintCount: number;
	skippedLayerCount: number;
	failedConstraintIds: string[];
	layers: IAnimationRigLayerProfileSample[];
	truncatedLayerCount: number;
	truncatedConstraintCount: number;
	selection: {
		skeletonId: string | null;
		layerIds: string[] | null;
		constraintRefs: Array<{ layerId: string; constraintId: string }> | null;
		fixedDeltaTimeSeconds: number | null;
		resetTemporalState: boolean;
	};
}

interface IAnimationRigTimingAccumulator {
	sampleCount: number;
	totalDurationMilliseconds: number;
	minimumDurationMilliseconds: number;
	maximumDurationMilliseconds: number;
	lastDurationMilliseconds: number;
	appliedCount: number;
	failedCount: number;
	skippedCount: number;
	lastStatus: string | null;
}

interface IAnimationRigProfileEntitySummary extends IAnimationRigTimingAccumulator {
	id: string;
	name: string;
	type: string | null;
	skeletonId: string;
	layerId: string | null;
}

interface IAnimationRigProfilerState {
	settings: IAnimationRigProfilerSettings;
	evaluationCount: number;
	capturedSampleCount: number;
	droppedSampleCount: number;
	suppressedLayerSummaryUpdateCount: number;
	suppressedConstraintSummaryUpdateCount: number;
	startedAt: string;
	clearedAt: string | null;
	samples: IAnimationRigProfileSample[];
	sceneSummary: IAnimationRigTimingAccumulator;
	layerSummaries: Map<string, IAnimationRigProfileEntitySummary>;
	constraintSummaries: Map<string, IAnimationRigProfileEntitySummary>;
}

export interface IAnimationRigJobContext<TData extends Record<string, unknown> = Record<string, unknown>> {
	readonly scene: Scene;
	readonly skeleton: Skeleton;
	readonly mesh: TransformNode | undefined;
	readonly layerId: string;
	readonly constraintId: string;
	readonly jobType: string;
	readonly jobVersion: number;
	readonly weight: number;
	readonly deltaTimeSeconds: number;
	readonly data: TData;
	readonly bones: readonly Bone[];
	readonly nodes: readonly TransformNode[];
}

/**
 * Project-script implementation of a Unity-style weighted animation job.
 * Definitions are registered once at module load and are resolved by the serialized custom constraint's `jobType`.
 */
export interface IAnimationRigJobDefinition<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown> {
	readonly id: string;
	readonly displayName?: string;
	readonly description?: string;
	readonly dataVersion: number;
	setDefaultValues?(): TData;
	validate?(context: IAnimationRigJobContext<TData>): true | string;
	create?(context: IAnimationRigJobContext<TData>): TState;
	update?(context: IAnimationRigJobContext<TData>, state: TState): void;
	processRootMotion?(context: IAnimationRigJobContext<TData>, state: TState): void | boolean;
	processAnimation(context: IAnimationRigJobContext<TData>, state: TState): void | boolean;
	destroy?(state: TState): void;
}

interface IAnimationRigJobRuntimeState {
	definition: IAnimationRigJobDefinition;
	state: unknown;
	createCount: number;
	updateCount: number;
	processRootMotionCount: number;
	processAnimationCount: number;
	errorCount: number;
	lastError: string | null;
	lastDurationMilliseconds: number;
	lastWeight: number;
	lastSucceeded: boolean;
}

function validateAnimationRigJobDefinition(definition: IAnimationRigJobDefinition): void {
	if (!definition || typeof definition !== "object") {
		throw new Error("Animation Rig job definition must be an object.");
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(definition.id)) {
		throw new Error("Animation Rig job id must contain 1 through 128 safe identifier characters.");
	}
	if (!Number.isInteger(definition.dataVersion) || definition.dataVersion < 1 || definition.dataVersion > 100000) {
		throw new Error("Animation Rig job dataVersion must be an integer from 1 through 100000.");
	}
	if (typeof definition.processAnimation !== "function") {
		throw new Error(`Animation Rig job "${definition.id}" must implement processAnimation.`);
	}
}

/** Registers or hot-replaces one project-defined weighted Animation Rig job type. */
export function registerAnimationRigJob<TData extends Record<string, unknown> = Record<string, unknown>, TState = unknown>(
	definition: IAnimationRigJobDefinition<TData, TState>
): () => void {
	validateAnimationRigJobDefinition(definition as IAnimationRigJobDefinition);
	animationRigJobDefinitions.set(definition.id, definition as IAnimationRigJobDefinition);
	return () => {
		if (animationRigJobDefinitions.get(definition.id) === definition) {
			animationRigJobDefinitions.delete(definition.id);
		}
	};
}

/** Lists registered custom job types without exposing executable callbacks. */
export function listAnimationRigJobTypes(): Array<{
	id: string;
	displayName: string;
	description: string;
	dataVersion: number;
	hasRootMotion: boolean;
	defaultData: Record<string, unknown>;
}> {
	return [...animationRigJobDefinitions.values()]
		.map((definition) => ({
			id: definition.id,
			displayName: definition.displayName?.trim() || definition.id,
			description: definition.description?.trim() || "",
			dataVersion: definition.dataVersion,
			hasRootMotion: typeof definition.processRootMotion === "function",
			defaultData: structuredClone(definition.setDefaultValues?.() ?? {}),
		}))
		.sort((left, right) => left.id.localeCompare(right.id));
}

/** Returns non-executable metadata for one registered custom job type. */
export function getAnimationRigJobType(jobType: string): ReturnType<typeof listAnimationRigJobTypes>[number] | null {
	return listAnimationRigJobTypes().find((definition) => definition.id === jobType) ?? null;
}

export interface IApplyRigLayersOptions {
	/** Evaluates only layers owned by this skeleton. Omit to evaluate every persisted layer. */
	skeletonId?: string;
	/** Evaluates only these layer ids. Omit to evaluate every matching persisted layer. */
	layerIds?: string[];
	/** Evaluates only these exact layer/constraint pairs. Omit to evaluate every constraint in matching layers. */
	constraintRefs?: Array<{ layerId: string; constraintId: string }>;
	/** Fixed temporal step used by Damped Transform. Omit to use the render engine delta. */
	deltaTimeSeconds?: number;
	/** Clears temporal constraint history before this evaluation. */
	resetTemporalState?: boolean;
}

function clamp01(value: unknown, fallback = 1): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function rotationOfNode(node: TransformNode): Quaternion {
	node.computeWorldMatrix(true);
	if (node.absoluteRotationQuaternion) {
		return node.absoluteRotationQuaternion.clone();
	}
	const rotation = Quaternion.Identity();
	node.getWorldMatrix().decompose(undefined, rotation, undefined);
	return rotation;
}

function rotationOfTarget(target: Bone | TransformNode): Quaternion {
	return target.rotationQuaternion?.clone() ?? Quaternion.FromEulerAngles(target.rotation.x, target.rotation.y, target.rotation.z);
}

function setTargetRotation(target: Bone | TransformNode, rotation: Quaternion): void {
	if (target.rotationQuaternion) {
		target.rotationQuaternion.copyFrom(rotation);
	} else {
		target.rotation.copyFrom(rotation.toEulerAngles());
	}
}

function maskedPosition(current: Vector3, desired: Vector3, axes: any): Vector3 {
	const mask = Array.isArray(axes) ? axes : [true, true, true];
	return new Vector3(mask[0] === false ? current.x : desired.x, mask[1] === false ? current.y : desired.y, mask[2] === false ? current.z : desired.z);
}

function maskedRotation(current: Quaternion, desired: Quaternion, axes: any): Quaternion {
	const mask = Array.isArray(axes) ? axes : [true, true, true];
	if (mask.every((axis: unknown) => axis !== false)) {
		return desired;
	}
	const currentEuler = current.toEulerAngles();
	const desiredEuler = desired.toEulerAngles();
	return Quaternion.FromEulerAngles(
		mask[0] === false ? currentEuler.x : desiredEuler.x,
		mask[1] === false ? currentEuler.y : desiredEuler.y,
		mask[2] === false ? currentEuler.z : desiredEuler.z
	);
}

function sourceTransform(scene: Scene, sourceNodeId: string, positionOffset: any, rotationOffset: any): { node: TransformNode; position: Vector3; rotation: Quaternion } | null {
	const node = scene.getNodeById(sourceNodeId);
	if (!node || typeof (node as TransformNode).computeWorldMatrix !== "function") {
		return null;
	}
	const transformNode = node as TransformNode;
	return {
		node: transformNode,
		position: Vector3.TransformCoordinates(Vector3.FromArray(positionOffset ?? [0, 0, 0]), transformNode.computeWorldMatrix(true)),
		rotation: rotationOfNode(transformNode)
			.multiply(Quaternion.FromArray(rotationOffset ?? [0, 0, 0, 1]))
			.normalize(),
	};
}

function resolveBone(scene: Scene, skeletonId: string, boneName: string): { bone: Bone; mesh: TransformNode | undefined } | null {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === skeletonId);
	const bone = skeleton?.bones.find((candidate) => candidate.name === boneName);
	if (!skeleton || !bone) {
		return null;
	}
	return { bone, mesh: scene.meshes.find((candidate) => candidate.skeleton === skeleton) };
}

function weightedQuaternion(values: Array<{ value: Quaternion; weight: number }>): Quaternion | null {
	const active = values.filter((value) => value.weight > 0);
	if (!active.length) {
		return null;
	}
	let result = active[0].value.clone().normalize();
	let total = active[0].weight;
	for (const item of active.slice(1)) {
		let next = item.value.clone().normalize();
		if (Quaternion.Dot(result, next) < 0) {
			next = next.scale(-1);
		}
		const nextTotal = total + item.weight;
		result = Quaternion.Slerp(result, next, item.weight / nextTotal).normalize();
		total = nextTotal;
	}
	return result;
}

function applyMultiParent(scene: Scene, layer: any, constraint: any): boolean {
	const resolved = resolveBone(scene, layer.skeletonId, constraint.boneName);
	if (!resolved || !Array.isArray(constraint.sources)) {
		return false;
	}
	const positionValues: Array<{ value: Vector3; weight: number }> = [];
	const rotationValues: Array<{ value: Quaternion; weight: number }> = [];
	for (const source of constraint.sources.slice(0, 8)) {
		const node = scene.getNodeById(source.nodeId);
		if (!node || typeof (node as TransformNode).computeWorldMatrix !== "function") {
			continue;
		}
		const transformNode = node as TransformNode;
		const weight = clamp01(source.weight);
		const desiredPosition = Vector3.TransformCoordinates(Vector3.FromArray(source.positionOffset ?? [0, 0, 0]), transformNode.computeWorldMatrix(true));
		const desiredRotation = rotationOfNode(transformNode)
			.multiply(Quaternion.FromArray(source.rotationOffset ?? [0, 0, 0, 1]))
			.normalize();
		positionValues.push({ value: desiredPosition, weight });
		rotationValues.push({ value: desiredRotation, weight });
	}
	const totalWeight = positionValues.reduce((total, value) => total + value.weight, 0);
	const desiredRotation = weightedQuaternion(rotationValues);
	if (totalWeight <= 1e-6 || !desiredRotation) {
		return false;
	}
	const desiredPosition = positionValues.reduce((result, value) => result.addInPlace(value.value.scale(value.weight / totalWeight)), Vector3.Zero());
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	if (influence <= 0) {
		return true;
	}
	const currentPosition = resolved.bone.getPosition(Space.WORLD, resolved.mesh);
	const currentRotation = resolved.bone.getRotationQuaternion(Space.WORLD, resolved.mesh);
	resolved.bone.setPosition(Vector3.Lerp(currentPosition, desiredPosition, influence), Space.WORLD, resolved.mesh);
	resolved.bone.setRotationQuaternion(Quaternion.Slerp(currentRotation, desiredRotation, influence).normalize(), Space.WORLD, resolved.mesh);
	return true;
}

function weightedSourcePosition(scene: Scene, sources: any[], useOffset: boolean): { position: Vector3; activeSourceCount: number } | null {
	const values: Array<{ value: Vector3; weight: number }> = [];
	for (const source of sources.slice(0, 8)) {
		const node = scene.getNodeById(source.nodeId);
		if (!node || typeof (node as TransformNode).computeWorldMatrix !== "function") {
			continue;
		}
		const transformNode = node as TransformNode;
		const weight = clamp01(source.weight);
		if (weight <= 0) {
			continue;
		}
		const localPosition = useOffset ? Vector3.FromArray(source.positionOffset ?? [0, 0, 0]) : Vector3.Zero();
		values.push({ value: Vector3.TransformCoordinates(localPosition, transformNode.computeWorldMatrix(true)), weight });
	}
	const totalWeight = values.reduce((total, value) => total + value.weight, 0);
	if (totalWeight <= 1e-6) {
		return null;
	}
	return {
		position: values.reduce((result, value) => result.addInPlace(value.value.scale(value.weight / totalWeight)), Vector3.Zero()),
		activeSourceCount: values.length,
	};
}

function applyMultiPosition(scene: Scene, layer: any, constraint: any): boolean {
	const resolved = resolveBone(scene, layer.skeletonId, constraint.boneName);
	if (!resolved || !Array.isArray(constraint.sources)) {
		return false;
	}
	const weighted = weightedSourcePosition(scene, constraint.sources, constraint.maintainOffset !== false);
	if (!weighted) {
		return false;
	}
	const current = resolved.bone.getPosition(Space.WORLD, resolved.mesh);
	const axes = Array.isArray(constraint.positionAxes) ? constraint.positionAxes : [true, true, true];
	const desired = new Vector3(
		axes[0] === false ? current.x : weighted.position.x,
		axes[1] === false ? current.y : weighted.position.y,
		axes[2] === false ? current.z : weighted.position.z
	);
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	resolved.bone.setPosition(Vector3.Lerp(current, desired, influence), Space.WORLD, resolved.mesh);
	return true;
}

function normalizedAimBasis(aimAxis: Vector3, upAxis: Vector3): { aim: Vector3; up: Vector3; side: Vector3 } | null {
	if (aimAxis.lengthSquared() <= 1e-8 || upAxis.lengthSquared() <= 1e-8) {
		return null;
	}
	const aim = aimAxis.normalize();
	const up = upAxis.subtract(aim.scale(Vector3.Dot(upAxis, aim)));
	if (up.lengthSquared() <= 1e-8) {
		return null;
	}
	up.normalize();
	return { aim, up, side: Vector3.Cross(aim, up).normalize() };
}

function aimRotation(aimAxis: Vector3, upAxis: Vector3, direction: Vector3, worldUpAxis: Vector3): Quaternion | null {
	const local = normalizedAimBasis(aimAxis, upAxis);
	if (!local || direction.lengthSquared() <= 1e-8 || worldUpAxis.lengthSquared() <= 1e-8) {
		return null;
	}
	const aim = direction.normalize();
	let up = worldUpAxis.subtract(aim.scale(Vector3.Dot(worldUpAxis, aim)));
	if (up.lengthSquared() <= 1e-8) {
		const fallback = Math.abs(aim.y) < 0.99 ? Vector3.Up() : Vector3.Right();
		up = fallback.subtract(aim.scale(Vector3.Dot(fallback, aim)));
	}
	up.normalize();
	const worldBasis = Quaternion.RotationQuaternionFromAxis(aim, up, Vector3.Cross(aim, up).normalize());
	const localBasis = Quaternion.RotationQuaternionFromAxis(local.aim, local.up, local.side);
	return worldBasis.multiply(localBasis.conjugate()).normalize();
}

function applyMultiAim(scene: Scene, layer: any, constraint: any): boolean {
	const resolved = resolveBone(scene, layer.skeletonId, constraint.boneName);
	if (!resolved || !Array.isArray(constraint.sources)) {
		return false;
	}
	const weighted = weightedSourcePosition(scene, constraint.sources, false);
	if (!weighted) {
		return false;
	}
	const position = resolved.bone.getPosition(Space.WORLD, resolved.mesh);
	const base = aimRotation(
		Vector3.FromArray(constraint.aimAxis ?? [1, 0, 0]),
		Vector3.FromArray(constraint.upAxis ?? [0, 1, 0]),
		weighted.position.subtract(position),
		Vector3.FromArray(constraint.worldUpAxis ?? [0, 1, 0])
	);
	if (!base) {
		return false;
	}
	const desired = base.multiply(Quaternion.FromArray(constraint.rotationOffset ?? [0, 0, 0, 1])).normalize();
	const current = resolved.bone.getRotationQuaternion(Space.WORLD, resolved.mesh);
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	resolved.bone.setRotationQuaternion(Quaternion.Slerp(current, desired, influence).normalize(), Space.WORLD, resolved.mesh);
	return true;
}

function applyOverrideTransform(scene: Scene, layer: any, constraint: any): boolean {
	const resolved = resolveBone(scene, layer.skeletonId, constraint.boneName);
	const source = sourceTransform(scene, constraint.sourceNodeId, constraint.positionOffset, constraint.rotationOffset);
	if (!resolved || !source) {
		return false;
	}
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	const currentPosition = resolved.bone.getPosition(Space.WORLD, resolved.mesh);
	const desiredPosition = maskedPosition(currentPosition, source.position, constraint.positionAxes);
	resolved.bone.setPosition(Vector3.Lerp(currentPosition, desiredPosition, influence * clamp01(constraint.positionWeight)), Space.WORLD, resolved.mesh);
	const currentRotation = resolved.bone.getRotationQuaternion(Space.WORLD, resolved.mesh);
	const desiredRotation = maskedRotation(currentRotation, source.rotation, constraint.rotationAxes);
	resolved.bone.setRotationQuaternion(Quaternion.Slerp(currentRotation, desiredRotation, influence * clamp01(constraint.rotationWeight)).normalize(), Space.WORLD, resolved.mesh);
	return true;
}

function applyBlendTransform(scene: Scene, layer: any, constraint: any): boolean {
	const resolved = resolveBone(scene, layer.skeletonId, constraint.boneName);
	const sourceA = sourceTransform(scene, constraint.sourceNodeIdA, constraint.positionOffsetA, constraint.rotationOffsetA);
	const sourceB = sourceTransform(scene, constraint.sourceNodeIdB, constraint.positionOffsetB, constraint.rotationOffsetB);
	if (!resolved || !sourceA || !sourceB) {
		return false;
	}
	const blend = clamp01(constraint.blend, 0.5);
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	const currentPosition = resolved.bone.getPosition(Space.WORLD, resolved.mesh);
	const desiredPosition = maskedPosition(currentPosition, Vector3.Lerp(sourceA.position, sourceB.position, blend), constraint.positionAxes);
	resolved.bone.setPosition(Vector3.Lerp(currentPosition, desiredPosition, influence * clamp01(constraint.positionWeight)), Space.WORLD, resolved.mesh);
	const currentRotation = resolved.bone.getRotationQuaternion(Space.WORLD, resolved.mesh);
	const blendedRotation = Quaternion.Slerp(sourceA.rotation, sourceB.rotation, blend).normalize();
	const desiredRotation = maskedRotation(currentRotation, blendedRotation, constraint.rotationAxes);
	resolved.bone.setRotationQuaternion(Quaternion.Slerp(currentRotation, desiredRotation, influence * clamp01(constraint.rotationWeight)).normalize(), Space.WORLD, resolved.mesh);
	return true;
}

function applyDampedTransform(scene: Scene, layer: any, constraint: any, deltaTimeSeconds?: number): boolean {
	const resolved = resolveBone(scene, layer.skeletonId, constraint.boneName);
	const source = sourceTransform(scene, constraint.sourceNodeId, constraint.positionOffset, constraint.rotationOffset);
	if (!resolved || !source) {
		return false;
	}
	let states = dampedTransformStates.get(scene);
	if (!states) {
		states = new Map();
		dampedTransformStates.set(scene, states);
	}
	const signature = `${layer.skeletonId}:${constraint.boneName}:${constraint.sourceNodeId}`;
	const currentPosition = resolved.bone.getPosition(Space.WORLD, resolved.mesh);
	const currentRotation = resolved.bone.getRotationQuaternion(Space.WORLD, resolved.mesh);
	let state = states.get(constraint.id);
	if (!state || state.signature !== signature) {
		state = { signature, position: currentPosition.clone(), rotation: currentRotation.clone() };
		states.set(constraint.id, state);
	}
	const requestedDelta = deltaTimeSeconds ?? (scene.getEngine().getDeltaTime() / 1000 || 1 / 60);
	const deltaTime = Math.min(1 / 15, Math.max(1 / 240, requestedDelta));
	const positionSpeed = 1 + (1 - clamp01(constraint.positionDamping, 0.5)) * 59;
	const rotationSpeed = 1 + (1 - clamp01(constraint.rotationDamping, 0.5)) * 59;
	state.position = Vector3.Lerp(state.position, source.position, 1 - Math.exp(-positionSpeed * deltaTime));
	state.rotation = Quaternion.Slerp(state.rotation, source.rotation, 1 - Math.exp(-rotationSpeed * deltaTime)).normalize();
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	const desiredPosition = maskedPosition(currentPosition, state.position, constraint.positionAxes);
	resolved.bone.setPosition(Vector3.Lerp(currentPosition, desiredPosition, influence * clamp01(constraint.positionWeight)), Space.WORLD, resolved.mesh);
	const desiredRotation = maskedRotation(currentRotation, state.rotation, constraint.rotationAxes);
	resolved.bone.setRotationQuaternion(Quaternion.Slerp(currentRotation, desiredRotation, influence * clamp01(constraint.rotationWeight)).normalize(), Space.WORLD, resolved.mesh);
	return true;
}

function signedTwistAngle(delta: Quaternion, axis: Vector3): number {
	const normalizedAxis = axis.normalize();
	const projection = delta.x * normalizedAxis.x + delta.y * normalizedAxis.y + delta.z * normalizedAxis.z;
	const twist = new Quaternion(normalizedAxis.x * projection, normalizedAxis.y * projection, normalizedAxis.z * projection, delta.w).normalize();
	let angle = 2 * Math.atan2(twist.x * normalizedAxis.x + twist.y * normalizedAxis.y + twist.z * normalizedAxis.z, twist.w);
	if (angle > Math.PI) {
		angle -= Math.PI * 2;
	} else if (angle < -Math.PI) {
		angle += Math.PI * 2;
	}
	return angle;
}

function applyTwist(scene: Scene, layer: any, constraint: any): boolean {
	const source = resolveBone(scene, layer.skeletonId, constraint.sourceBoneName);
	if (!source || !Array.isArray(constraint.twistBones) || !constraint.twistBones.length) {
		return false;
	}
	const sourceTarget = source.bone.getTransformNode() ?? source.bone;
	const sourceRest = Quaternion.FromArray(constraint.sourceRestRotation ?? [0, 0, 0, 1]);
	const sourceDelta = sourceRest.conjugate().multiply(rotationOfTarget(sourceTarget)).normalize();
	const axis = Vector3.FromArray(constraint.axis ?? [1, 0, 0]);
	if (axis.lengthSquared() <= 1e-8) {
		return false;
	}
	const angle = signedTwistAngle(sourceDelta, axis);
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	let applied = false;
	for (const item of constraint.twistBones.slice(0, 16)) {
		const resolved = resolveBone(scene, layer.skeletonId, item.boneName);
		if (!resolved) {
			continue;
		}
		const target = resolved.bone.getTransformNode() ?? resolved.bone;
		const rest = Quaternion.FromArray(item.restRotation ?? [0, 0, 0, 1]);
		const desired = rest.multiply(Quaternion.RotationAxis(axis.normalize(), angle * clamp01(item.weight))).normalize();
		setTargetRotation(target, Quaternion.Slerp(rotationOfTarget(target), desired, influence).normalize());
		applied = true;
	}
	return applied;
}

function resolveChain(scene: Scene, skeletonId: string, rootBoneName: string, tipBoneName: string): { bones: Bone[]; mesh: TransformNode | undefined } | null {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === skeletonId);
	const root = skeleton?.bones.find((candidate) => candidate.name === rootBoneName);
	let current: Bone | null | undefined = skeleton?.bones.find((candidate) => candidate.name === tipBoneName);
	if (!skeleton || !root || !current) {
		return null;
	}
	const reverse: Bone[] = [];
	while (current && reverse.length < 64) {
		reverse.push(current);
		if (current === root) {
			return {
				bones: reverse.reverse(),
				mesh: scene.meshes.find((candidate) => candidate.skeleton === skeleton),
			};
		}
		current = current.getParent();
	}
	return null;
}

function solveFabrik(positions: Vector3[], lengths: number[], target: Vector3, maximumIterations: number, tolerance: number): Vector3[] {
	const solved = positions.map((position) => position.clone());
	const root = solved[0].clone();
	const totalLength = lengths.reduce((total, length) => total + length, 0);
	if (Vector3.Distance(root, target) >= totalLength) {
		const direction = target.subtract(root).normalize();
		for (let index = 1; index < solved.length; index++) {
			solved[index] = solved[index - 1].add(direction.scale(lengths[index - 1]));
		}
		return solved;
	}
	for (let iteration = 0; iteration < maximumIterations; iteration++) {
		solved[solved.length - 1].copyFrom(target);
		for (let index = solved.length - 2; index >= 0; index--) {
			const direction = solved[index].subtract(solved[index + 1]).normalize();
			solved[index] = solved[index + 1].add(direction.scale(lengths[index]));
		}
		solved[0].copyFrom(root);
		for (let index = 1; index < solved.length; index++) {
			const direction = solved[index].subtract(solved[index - 1]).normalize();
			solved[index] = solved[index - 1].add(direction.scale(lengths[index - 1]));
		}
		if (Vector3.Distance(solved[solved.length - 1], target) <= tolerance) {
			break;
		}
	}
	return solved;
}

function applyChainIk(scene: Scene, layer: any, constraint: any): boolean {
	const resolved = resolveChain(scene, layer.skeletonId, constraint.rootBoneName, constraint.tipBoneName);
	const target = scene.getNodeById(constraint.targetNodeId);
	if (!resolved || resolved.bones.length < 2 || !target || typeof (target as TransformNode).computeWorldMatrix !== "function") {
		return false;
	}
	const targetNode = target as TransformNode;
	const skeleton = resolved.bones[0].getSkeleton();
	skeleton.computeAbsoluteMatrices(true);
	const positions = resolved.bones.map((bone) => bone.getPosition(Space.WORLD, resolved.mesh));
	const lengths = positions.slice(0, -1).map((position, index) => Vector3.Distance(position, positions[index + 1]));
	if (lengths.some((length) => length <= 1e-6)) {
		return false;
	}
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	const chainInfluence = influence * clamp01(constraint.chainRotationWeight);
	const targetPosition = Vector3.Lerp(positions[positions.length - 1], targetNode.getAbsolutePosition(), chainInfluence);
	const solved = solveFabrik(
		positions,
		lengths,
		targetPosition,
		Math.min(64, Math.max(1, Number.isInteger(constraint.maxIterations) ? constraint.maxIterations : 15)),
		typeof constraint.tolerance === "number" && Number.isFinite(constraint.tolerance) ? Math.min(100, Math.max(0.0001, constraint.tolerance)) : 0.01
	);
	for (let index = 0; index < resolved.bones.length - 1; index++) {
		skeleton.computeAbsoluteMatrices(true);
		const bone = resolved.bones[index];
		const child = resolved.bones[index + 1];
		const currentDirection = child.getPosition(Space.WORLD, resolved.mesh).subtract(bone.getPosition(Space.WORLD, resolved.mesh));
		const desiredDirection = solved[index + 1].subtract(solved[index]);
		if (currentDirection.lengthSquared() <= 1e-10 || desiredDirection.lengthSquared() <= 1e-10) {
			continue;
		}
		const delta = Quaternion.Identity();
		Quaternion.FromUnitVectorsToRef(currentDirection.normalize(), desiredDirection.normalize(), delta);
		const currentRotation = bone.getRotationQuaternion(Space.WORLD, resolved.mesh);
		bone.setRotationQuaternion(delta.multiply(currentRotation).normalize(), Space.WORLD, resolved.mesh);
	}
	const tipRotationInfluence = influence * clamp01(constraint.tipRotationWeight, 0);
	if (tipRotationInfluence > 0) {
		skeleton.computeAbsoluteMatrices(true);
		const tip = resolved.bones[resolved.bones.length - 1];
		const currentRotation = tip.getRotationQuaternion(Space.WORLD, resolved.mesh);
		tip.setRotationQuaternion(Quaternion.Slerp(currentRotation, rotationOfNode(targetNode), tipRotationInfluence).normalize(), Space.WORLD, resolved.mesh);
	}
	return true;
}

function applyFullBodyIk(scene: Scene, layer: any, constraint: any): boolean {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === layer.skeletonId);
	const root = skeleton?.bones.find((candidate) => candidate.name === constraint.rootBoneName);
	const mesh = skeleton ? scene.meshes.find((candidate) => candidate.skeleton === skeleton) : undefined;
	if (!skeleton || !root || !mesh || !Array.isArray(constraint.effectors)) {
		return false;
	}
	const influence = clamp01(layer.weight) * clamp01(constraint.weight);
	const effectors = constraint.effectors.slice(0, 8).flatMap((effector: any) => {
		const path = resolveChain(scene, layer.skeletonId, root.name, effector.boneName)?.bones;
		const target = scene.getNodeById(effector.targetNodeId);
		if (!path || path.length < 2 || !target || typeof (target as TransformNode).computeWorldMatrix !== "function") {
			return [];
		}
		const targetNode = target as TransformNode;
		const bone = path[path.length - 1];
		const positionWeight = clamp01(effector.positionWeight);
		const rotationWeight = clamp01(effector.rotationWeight, 0);
		const currentPosition = bone.getPosition(Space.WORLD, mesh);
		return [
			{
				path,
				bone,
				target: targetNode,
				targetPosition: Vector3.Lerp(currentPosition, targetNode.getAbsolutePosition(), influence * positionWeight),
				rotationWeight: influence * rotationWeight,
			},
		];
	});
	if (!effectors.length) {
		return false;
	}
	const maximumIterations = Math.min(64, Math.max(1, Number.isInteger(constraint.maxIterations) ? constraint.maxIterations : 12));
	const tolerance = typeof constraint.tolerance === "number" && Number.isFinite(constraint.tolerance) ? Math.min(100, Math.max(0.0001, constraint.tolerance)) : 0.1;
	for (let iteration = 0; iteration < maximumIterations; iteration++) {
		let maximumError = 0;
		for (const effector of effectors) {
			for (let index = effector.path.length - 2; index >= 0; index--) {
				skeleton.computeAbsoluteMatrices(true);
				const joint = effector.path[index];
				const jointPosition = joint.getPosition(Space.WORLD, mesh);
				const effectorPosition = effector.bone.getPosition(Space.WORLD, mesh);
				const currentDirection = effectorPosition.subtract(jointPosition);
				const desiredDirection = effector.targetPosition.subtract(jointPosition);
				if (currentDirection.lengthSquared() <= 1e-10 || desiredDirection.lengthSquared() <= 1e-10) {
					continue;
				}
				const delta = Quaternion.Identity();
				Quaternion.FromUnitVectorsToRef(currentDirection.normalize(), desiredDirection.normalize(), delta);
				const currentRotation = joint.getRotationQuaternion(Space.WORLD, mesh);
				joint.setRotationQuaternion(delta.multiply(currentRotation).normalize(), Space.WORLD, mesh);
			}
			skeleton.computeAbsoluteMatrices(true);
			maximumError = Math.max(maximumError, Vector3.Distance(effector.bone.getPosition(Space.WORLD, mesh), effector.targetPosition));
		}
		if (maximumError <= tolerance) {
			break;
		}
	}
	for (const effector of effectors) {
		if (effector.rotationWeight <= 0) {
			continue;
		}
		skeleton.computeAbsoluteMatrices(true);
		const currentRotation = effector.bone.getRotationQuaternion(Space.WORLD, mesh);
		effector.bone.setRotationQuaternion(Quaternion.Slerp(currentRotation, rotationOfNode(effector.target), effector.rotationWeight).normalize(), Space.WORLD, mesh);
	}
	return true;
}

function animationRigJobStateKey(layerId: string, constraintId: string): string {
	return `${layerId}\u0000${constraintId}`;
}

function animationRigJobElapsedStart(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function destroyAnimationRigJobState(state: IAnimationRigJobRuntimeState): void {
	try {
		state.definition.destroy?.(state.state);
	} catch {
		// Destruction must never break scene teardown or a later rig evaluation.
	}
}

function clearAnimationRigJobStates(scene: Scene): void {
	const states = animationRigJobStates.get(scene);
	if (!states) {
		return;
	}
	for (const state of states.values()) {
		destroyAnimationRigJobState(state);
	}
	animationRigJobStates.delete(scene);
}

function animationRigJobContext(scene: Scene, layer: any, constraint: any, deltaTimeSeconds?: number): IAnimationRigJobContext | null {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === layer.skeletonId);
	if (!skeleton || !Array.isArray(constraint.boneNames) || !Array.isArray(constraint.nodeIds)) {
		return null;
	}
	const bones = constraint.boneNames.map((name: unknown) => skeleton.bones.find((bone) => bone.name === name));
	const nodes = constraint.nodeIds.map((id: unknown) => scene.getNodeById(String(id)));
	if (bones.some((bone: Bone | undefined) => !bone) || nodes.some((node: any) => !node || typeof node.computeWorldMatrix !== "function")) {
		return null;
	}
	const requestedDelta = deltaTimeSeconds ?? (scene.getEngine().getDeltaTime() / 1000 || 1 / 60);
	return {
		scene,
		skeleton,
		mesh: scene.meshes.find((candidate) => candidate.skeleton === skeleton),
		layerId: String(layer.id),
		constraintId: String(constraint.id),
		jobType: String(constraint.jobType),
		jobVersion: Number(constraint.jobVersion),
		weight: clamp01(layer.weight) * clamp01(constraint.weight),
		deltaTimeSeconds: Math.min(1, Math.max(0, Number.isFinite(requestedDelta) ? requestedDelta : 1 / 60)),
		data: structuredClone(constraint.jobData ?? {}),
		bones: bones as Bone[],
		nodes: nodes as TransformNode[],
	};
}

function animationRigJobValidation(definition: IAnimationRigJobDefinition | undefined, context: IAnimationRigJobContext | null): { valid: boolean; message: string | null } {
	if (!definition) {
		return { valid: false, message: "The custom Animation Rig job type is not registered by a loaded project script." };
	}
	if (!context) {
		return { valid: false, message: "One or more serialized custom-job bone/node bindings are unresolved." };
	}
	if (definition.dataVersion !== context.jobVersion) {
		return { valid: false, message: `Registered data version ${definition.dataVersion} does not match serialized version ${context.jobVersion}.` };
	}
	try {
		const result = definition.validate?.(context) ?? true;
		return result === true ? { valid: true, message: null } : { valid: false, message: String(result).slice(0, 1024) };
	} catch (error) {
		return { valid: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 1024) };
	}
}

function applyAnimationRigJob(scene: Scene, layer: any, constraint: any, deltaTimeSeconds?: number): boolean {
	const definition = animationRigJobDefinitions.get(String(constraint.jobType));
	const context = animationRigJobContext(scene, layer, constraint, deltaTimeSeconds);
	const validation = animationRigJobValidation(definition, context);
	if (!definition || !context || !validation.valid) {
		return false;
	}
	let states = animationRigJobStates.get(scene);
	if (!states) {
		states = new Map();
		animationRigJobStates.set(scene, states);
	}
	const key = animationRigJobStateKey(context.layerId, context.constraintId);
	let runtime = states.get(key);
	if (runtime && runtime.definition !== definition) {
		destroyAnimationRigJobState(runtime);
		states.delete(key);
		runtime = undefined;
	}
	try {
		if (!runtime) {
			runtime = {
				definition,
				state: definition.create?.(context),
				createCount: 1,
				updateCount: 0,
				processRootMotionCount: 0,
				processAnimationCount: 0,
				errorCount: 0,
				lastError: null,
				lastDurationMilliseconds: 0,
				lastWeight: context.weight,
				lastSucceeded: false,
			};
			states.set(key, runtime);
		}
		const started = animationRigJobElapsedStart();
		definition.update?.(context, runtime.state);
		runtime.updateCount++;
		if (definition.processRootMotion) {
			const rootResult = definition.processRootMotion(context, runtime.state);
			runtime.processRootMotionCount++;
			if (rootResult === false) {
				throw new Error("processRootMotion returned false.");
			}
		}
		const animationResult = definition.processAnimation(context, runtime.state);
		runtime.processAnimationCount++;
		if (animationResult === false) {
			throw new Error("processAnimation returned false.");
		}
		runtime.lastDurationMilliseconds = Math.max(0, animationRigJobElapsedStart() - started);
		runtime.lastWeight = context.weight;
		runtime.lastError = null;
		runtime.lastSucceeded = true;
		return true;
	} catch (error) {
		if (runtime) {
			runtime.errorCount++;
			runtime.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1024);
			runtime.lastWeight = context.weight;
			runtime.lastSucceeded = false;
		}
		return false;
	}
}

/** Returns one custom constraint's registration, validation, and live lifecycle evidence. */
export function getAnimationRigJobRuntimeDiagnostics(scene: Scene, layer: any, constraint: any): any {
	const definition = animationRigJobDefinitions.get(String(constraint.jobType));
	const context = animationRigJobContext(scene, layer, constraint);
	const validation = animationRigJobValidation(definition, context);
	const runtime = animationRigJobStates.get(scene)?.get(animationRigJobStateKey(String(layer.id), String(constraint.id)));
	return {
		registered: !!definition,
		valid: validation.valid,
		validationMessage: validation.message,
		registeredDataVersion: definition?.dataVersion ?? null,
		hasRootMotion: typeof definition?.processRootMotion === "function",
		createCount: runtime?.createCount ?? 0,
		updateCount: runtime?.updateCount ?? 0,
		processRootMotionCount: runtime?.processRootMotionCount ?? 0,
		processAnimationCount: runtime?.processAnimationCount ?? 0,
		errorCount: runtime?.errorCount ?? 0,
		lastError: runtime?.lastError ?? null,
		lastDurationMilliseconds: runtime?.lastDurationMilliseconds ?? null,
		lastWeight: runtime?.lastWeight ?? null,
		lastSucceeded: runtime?.lastSucceeded ?? false,
	};
}

function createAnimationRigTimingAccumulator(): IAnimationRigTimingAccumulator {
	return {
		sampleCount: 0,
		totalDurationMilliseconds: 0,
		minimumDurationMilliseconds: 0,
		maximumDurationMilliseconds: 0,
		lastDurationMilliseconds: 0,
		appliedCount: 0,
		failedCount: 0,
		skippedCount: 0,
		lastStatus: null,
	};
}

function createAnimationRigProfilerState(): IAnimationRigProfilerState {
	return {
		settings: { enabled: false, sampleCapacity: 120, sampleEveryNEvaluations: 1 },
		evaluationCount: 0,
		capturedSampleCount: 0,
		droppedSampleCount: 0,
		suppressedLayerSummaryUpdateCount: 0,
		suppressedConstraintSummaryUpdateCount: 0,
		startedAt: new Date().toISOString(),
		clearedAt: null,
		samples: [],
		sceneSummary: createAnimationRigTimingAccumulator(),
		layerSummaries: new Map(),
		constraintSummaries: new Map(),
	};
}

function animationRigProfilerState(scene: Scene): IAnimationRigProfilerState {
	let state = animationRigProfilerStates.get(scene);
	if (!state) {
		state = createAnimationRigProfilerState();
		animationRigProfilerStates.set(scene, state);
	}
	return state;
}

function updateAnimationRigTimingAccumulator(accumulator: IAnimationRigTimingAccumulator, durationMilliseconds: number, status: string): void {
	const duration = Math.max(0, Number.isFinite(durationMilliseconds) ? durationMilliseconds : 0);
	accumulator.sampleCount++;
	accumulator.totalDurationMilliseconds += duration;
	accumulator.minimumDurationMilliseconds = accumulator.sampleCount === 1 ? duration : Math.min(accumulator.minimumDurationMilliseconds, duration);
	accumulator.maximumDurationMilliseconds = Math.max(accumulator.maximumDurationMilliseconds, duration);
	accumulator.lastDurationMilliseconds = duration;
	accumulator.lastStatus = status;
	if (status === "applied") {
		accumulator.appliedCount++;
	} else if (status === "failed") {
		accumulator.failedCount++;
	} else {
		accumulator.skippedCount++;
	}
}

function describeAnimationRigTiming(accumulator: IAnimationRigTimingAccumulator): any {
	return {
		sampleCount: accumulator.sampleCount,
		totalDurationMilliseconds: accumulator.totalDurationMilliseconds,
		minimumDurationMilliseconds: accumulator.minimumDurationMilliseconds,
		maximumDurationMilliseconds: accumulator.maximumDurationMilliseconds,
		averageDurationMilliseconds: accumulator.sampleCount ? accumulator.totalDurationMilliseconds / accumulator.sampleCount : 0,
		lastDurationMilliseconds: accumulator.lastDurationMilliseconds,
		appliedCount: accumulator.appliedCount,
		failedCount: accumulator.failedCount,
		skippedCount: accumulator.skippedCount,
		lastStatus: accumulator.lastStatus,
	};
}

function updateAnimationRigEntitySummary(
	summaries: Map<string, IAnimationRigProfileEntitySummary>,
	key: string,
	identity: Pick<IAnimationRigProfileEntitySummary, "id" | "name" | "type" | "skeletonId" | "layerId">,
	durationMilliseconds: number,
	status: string,
	maximumEntries: number
): boolean {
	let summary = summaries.get(key);
	if (!summary) {
		if (summaries.size >= maximumEntries) {
			return false;
		}
		summary = { ...identity, ...createAnimationRigTimingAccumulator() };
		summaries.set(key, summary);
	} else {
		summary.name = identity.name;
		summary.type = identity.type;
		summary.skeletonId = identity.skeletonId;
		summary.layerId = identity.layerId;
	}
	updateAnimationRigTimingAccumulator(summary, durationMilliseconds, status);
	return true;
}

function publishAnimationRigProfileSample(state: IAnimationRigProfilerState, sample: IAnimationRigProfileSample): void {
	state.capturedSampleCount++;
	updateAnimationRigTimingAccumulator(state.sceneSummary, sample.durationMilliseconds, sample.failedConstraintCount > 0 ? "failed" : "applied");
	for (const layer of sample.layers) {
		if (
			!updateAnimationRigEntitySummary(
				state.layerSummaries,
				layer.layerId,
				{ id: layer.layerId, name: layer.name, type: null, skeletonId: layer.skeletonId, layerId: null },
				layer.durationMilliseconds,
				layer.status === "applied" && layer.failedConstraintCount > 0 ? "failed" : layer.status,
				maximumAnimationRigProfileLayers
			)
		) {
			state.suppressedLayerSummaryUpdateCount++;
		}
		for (const constraint of layer.constraints) {
			if (
				!updateAnimationRigEntitySummary(
					state.constraintSummaries,
					`${layer.layerId}\u0000${constraint.constraintId}`,
					{
						id: constraint.constraintId,
						name: constraint.name,
						type: constraint.type,
						skeletonId: layer.skeletonId,
						layerId: layer.layerId,
					},
					constraint.durationMilliseconds,
					constraint.status,
					maximumAnimationRigProfileConstraints
				)
			) {
				state.suppressedConstraintSummaryUpdateCount++;
			}
		}
	}
	state.samples.push(sample);
	while (state.samples.length > state.settings.sampleCapacity) {
		state.samples.shift();
		state.droppedSampleCount++;
	}
}

/** Configures bounded CPU sampling around the exact shared Animation Rig evaluator. */
export function configureAnimationRigProfiler(scene: Scene, settings: Partial<IAnimationRigProfilerSettings>): ReturnType<typeof getAnimationRigProfile> {
	const state = animationRigProfilerState(scene);
	if (settings.enabled !== undefined) {
		if (typeof settings.enabled !== "boolean") {
			throw new Error("Animation Rig profiler enabled must be a boolean.");
		}
		state.settings.enabled = settings.enabled;
	}
	if (settings.sampleCapacity !== undefined) {
		if (!Number.isInteger(settings.sampleCapacity) || settings.sampleCapacity < 1 || settings.sampleCapacity > 256) {
			throw new Error("Animation Rig profiler sampleCapacity must be an integer from 1 through 256.");
		}
		state.settings.sampleCapacity = settings.sampleCapacity;
		while (state.samples.length > settings.sampleCapacity) {
			state.samples.shift();
			state.droppedSampleCount++;
		}
	}
	if (settings.sampleEveryNEvaluations !== undefined) {
		if (!Number.isInteger(settings.sampleEveryNEvaluations) || settings.sampleEveryNEvaluations < 1 || settings.sampleEveryNEvaluations > 120) {
			throw new Error("Animation Rig profiler sampleEveryNEvaluations must be an integer from 1 through 120.");
		}
		state.settings.sampleEveryNEvaluations = settings.sampleEveryNEvaluations;
	}
	return getAnimationRigProfile(scene);
}

/** Clears captured Animation Rig timing history while retaining current profiler settings. */
export function clearAnimationRigProfile(scene: Scene): ReturnType<typeof getAnimationRigProfile> {
	const state = animationRigProfilerState(scene);
	state.evaluationCount = 0;
	state.capturedSampleCount = 0;
	state.droppedSampleCount = 0;
	state.suppressedLayerSummaryUpdateCount = 0;
	state.suppressedConstraintSummaryUpdateCount = 0;
	state.startedAt = new Date().toISOString();
	state.clearedAt = state.startedAt;
	state.samples = [];
	state.sceneSummary = createAnimationRigTimingAccumulator();
	state.layerSummaries.clear();
	state.constraintSummaries.clear();
	return getAnimationRigProfile(scene);
}

/** Reads bounded Animation Rig timeline samples plus hierarchical CPU timing/counter summaries. */
export function getAnimationRigProfile(
	scene: Scene,
	options: { skeletonId?: string; layerId?: string; constraintId?: string; includeSamples?: boolean; sampleOffset?: number; sampleLimit?: number } = {}
): any {
	const state = animationRigProfilerState(scene);
	const offset = Number.isInteger(options.sampleOffset) && Number(options.sampleOffset) >= 0 ? Number(options.sampleOffset) : 0;
	const limit = Number.isInteger(options.sampleLimit) ? Math.min(120, Math.max(1, Number(options.sampleLimit))) : 20;
	const matchesLayer = (layer: { id?: string; layerId: string | null; skeletonId: string }): boolean =>
		(!options.skeletonId || layer.skeletonId === options.skeletonId) && (!options.layerId || (layer.layerId ?? layer.id) === options.layerId);
	const matchesConstraint = (constraint: { id?: string; constraintId?: string; layerId: string | null; skeletonId: string }): boolean =>
		(!options.skeletonId || constraint.skeletonId === options.skeletonId) &&
		(!options.layerId || constraint.layerId === options.layerId) &&
		(!options.constraintId || (constraint.id ?? constraint.constraintId) === options.constraintId);
	const filteredSamples = [...state.samples]
		.reverse()
		.map((sample) => {
			const layers = sample.layers
				.filter(matchesLayer)
				.map((layer) => ({
					...structuredClone(layer),
					constraints: layer.constraints.filter((constraint) => matchesConstraint({ ...constraint, layerId: layer.layerId, skeletonId: layer.skeletonId })),
				}))
				.filter((layer) => !options.constraintId || layer.constraints.length > 0);
			if (!options.skeletonId && !options.layerId && !options.constraintId) {
				return { ...structuredClone(sample), layers };
			}
			const constraints = layers.flatMap((layer) => layer.constraints);
			return {
				...structuredClone(sample),
				durationMilliseconds: options.constraintId
					? constraints.reduce((total, constraint) => total + constraint.durationMilliseconds, 0)
					: layers.reduce((total, layer) => total + layer.durationMilliseconds, 0),
				layerCount: layers.length,
				constraintCount: constraints.length,
				appliedConstraintCount: constraints.filter((constraint) => constraint.status === "applied").length,
				failedConstraintCount: constraints.filter((constraint) => constraint.status === "failed").length,
				disabledConstraintCount: constraints.filter((constraint) => constraint.status === "disabled").length,
				skippedLayerCount: layers.filter((layer) => layer.status !== "applied").length,
				failedConstraintIds: constraints.filter((constraint) => constraint.status === "failed").map((constraint) => constraint.constraintId),
				layers,
			};
		})
		.filter((sample) => (!options.skeletonId && !options.layerId && !options.constraintId) || sample.layers.length > 0);
	const layerSummaries = [...state.layerSummaries.values()]
		.filter(matchesLayer)
		.map((summary) => ({ id: summary.id, name: summary.name, skeletonId: summary.skeletonId, ...describeAnimationRigTiming(summary) }))
		.sort((left, right) => right.averageDurationMilliseconds - left.averageDurationMilliseconds || left.id.localeCompare(right.id));
	const constraintSummaries = [...state.constraintSummaries.values()]
		.filter(matchesConstraint)
		.map((summary) => ({
			id: summary.id,
			name: summary.name,
			type: summary.type,
			skeletonId: summary.skeletonId,
			layerId: summary.layerId,
			...describeAnimationRigTiming(summary),
		}))
		.sort((left, right) => right.averageDurationMilliseconds - left.averageDurationMilliseconds || left.id.localeCompare(right.id));
	const returnedSamples = options.includeSamples === true ? filteredSamples.slice(offset, offset + limit) : [];
	return {
		settings: structuredClone(state.settings),
		startedAt: state.startedAt,
		clearedAt: state.clearedAt,
		evaluationCount: state.evaluationCount,
		capturedSampleCount: state.capturedSampleCount,
		retainedSampleCount: state.samples.length,
		droppedSampleCount: state.droppedSampleCount,
		suppressedLayerSummaryUpdateCount: state.suppressedLayerSummaryUpdateCount,
		suppressedConstraintSummaryUpdateCount: state.suppressedConstraintSummaryUpdateCount,
		detailBounds: { maximumLayersPerSample: maximumAnimationRigProfileLayers, maximumConstraintsPerSample: maximumAnimationRigProfileConstraints },
		sceneSummary: describeAnimationRigTiming(state.sceneSummary),
		layerSummaries,
		constraintSummaries,
		samples: returnedSamples,
		pagination: {
			total: filteredSamples.length,
			count: returnedSamples.length,
			offset,
			hasMore: options.includeSamples === true && offset + returnedSamples.length < filteredSamples.length,
			nextOffset: options.includeSamples === true && offset + returnedSamples.length < filteredSamples.length ? offset + returnedSamples.length : null,
		},
	};
}

/** Clears the temporal history retained by Damped Transform constraints for a scene. */
export function resetRigLayerTemporalState(scene: Scene): void {
	dampedTransformStates.delete(scene);
	clearAnimationRigJobStates(scene);
}

function applyRigConstraint(scene: Scene, layer: any, constraint: any, deltaTimeSeconds?: number): boolean {
	return constraint.type === "multiParent"
		? applyMultiParent(scene, layer, constraint)
		: constraint.type === "twist"
			? applyTwist(scene, layer, constraint)
			: constraint.type === "chainIk"
				? applyChainIk(scene, layer, constraint)
				: constraint.type === "multiPosition"
					? applyMultiPosition(scene, layer, constraint)
					: constraint.type === "multiAim"
						? applyMultiAim(scene, layer, constraint)
						: constraint.type === "fullBodyIk"
							? applyFullBodyIk(scene, layer, constraint)
							: constraint.type === "overrideTransform"
								? applyOverrideTransform(scene, layer, constraint)
								: constraint.type === "dampedTransform"
									? applyDampedTransform(scene, layer, constraint, deltaTimeSeconds)
									: constraint.type === "blendTransform"
										? applyBlendTransform(scene, layer, constraint)
										: constraint.type === "customJob"
											? applyAnimationRigJob(scene, layer, constraint, deltaTimeSeconds)
											: false;
}

/** Evaluates enabled rig layers and constraints in deterministic layer/order sequence after animation. */
export function applyRigLayers(
	scene: Scene,
	options: IApplyRigLayersOptions = {}
): { layerCount: number; constraintCount: number; appliedConstraintCount: number; failedConstraintIds: string[] } {
	if (options.resetTemporalState) {
		resetRigLayerTemporalState(scene);
	}
	const profiler = animationRigProfilerState(scene);
	const profilingEnabled = profiler.settings.enabled;
	if (profilingEnabled) {
		profiler.evaluationCount++;
	}
	const captureProfile = profilingEnabled && (profiler.evaluationCount - 1) % profiler.settings.sampleEveryNEvaluations === 0;
	const profileStarted = captureProfile ? animationRigJobElapsedStart() : 0;
	const selectedLayerIds = options.layerIds ? new Set(options.layerIds) : null;
	const selectedConstraintRefs = options.constraintRefs ? new Set(options.constraintRefs.map((reference) => `${reference.layerId}\u0000${reference.constraintId}`)) : null;
	const layers = Array.isArray(scene.metadata?.babylonEditorRigLayers)
		? [...scene.metadata.babylonEditorRigLayers].filter(
				(layer) => (!options.skeletonId || layer.skeletonId === options.skeletonId) && (!selectedLayerIds || selectedLayerIds.has(layer.id))
			)
		: [];
	layers.sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0) || String(left.id).localeCompare(String(right.id)));
	let constraintCount = 0;
	let appliedConstraintCount = 0;
	let disabledConstraintCount = 0;
	const failedConstraintIds: string[] = [];
	const visitedCustomJobs = new Set<string>();
	const profileLayers: IAnimationRigLayerProfileSample[] = [];
	let profileConstraintDetailCount = 0;
	let truncatedLayerCount = 0;
	let truncatedConstraintCount = 0;
	let skippedLayerCount = 0;
	for (const layer of layers) {
		const layerStarted = captureProfile ? animationRigJobElapsedStart() : 0;
		const profileLayer: IAnimationRigLayerProfileSample | null = captureProfile
			? {
					layerId: String(layer.id ?? ""),
					name: String(layer.name ?? layer.id ?? "Rig Layer"),
					skeletonId: String(layer.skeletonId ?? ""),
					enabled: layer.enabled !== false,
					weight: clamp01(layer.weight),
					status: "applied",
					durationMilliseconds: 0,
					constraintCount: 0,
					appliedConstraintCount: 0,
					failedConstraintCount: 0,
					disabledConstraintCount: 0,
					constraints: [],
					truncatedConstraintCount: 0,
				}
			: null;
		if (layer.enabled === false || clamp01(layer.weight) <= 0 || !Array.isArray(layer.constraints)) {
			if (captureProfile) {
				skippedLayerCount++;
			}
			if (profileLayer) {
				profileLayer.status = layer.enabled === false ? "disabled" : clamp01(layer.weight) <= 0 ? "zeroWeight" : "invalidConstraints";
				profileLayer.durationMilliseconds = Math.max(0, animationRigJobElapsedStart() - layerStarted);
				if (profileLayers.length < maximumAnimationRigProfileLayers) {
					profileLayers.push(profileLayer);
				} else {
					truncatedLayerCount++;
				}
			}
			continue;
		}
		for (const constraint of layer.constraints) {
			if (selectedConstraintRefs && !selectedConstraintRefs.has(`${layer.id}\u0000${constraint.id}`)) {
				continue;
			}
			constraintCount++;
			if (profileLayer) {
				profileLayer.constraintCount++;
			}
			const constraintStarted = captureProfile ? animationRigJobElapsedStart() : 0;
			if (constraint.enabled === false) {
				disabledConstraintCount++;
				if (profileLayer) {
					profileLayer.disabledConstraintCount++;
					if (profileConstraintDetailCount < maximumAnimationRigProfileConstraints) {
						profileLayer.constraints.push({
							constraintId: String(constraint.id ?? ""),
							name: String(constraint.name ?? constraint.id ?? "Constraint"),
							type: String(constraint.type ?? "unknown"),
							enabled: false,
							status: "disabled",
							durationMilliseconds: Math.max(0, animationRigJobElapsedStart() - constraintStarted),
						});
						profileConstraintDetailCount++;
					} else {
						profileLayer.truncatedConstraintCount++;
						truncatedConstraintCount++;
					}
				}
				continue;
			}
			if (constraint.type === "customJob") {
				visitedCustomJobs.add(animationRigJobStateKey(String(layer.id), String(constraint.id)));
			}
			const applied = applyRigConstraint(scene, layer, constraint, options.deltaTimeSeconds);
			if (applied) {
				appliedConstraintCount++;
				if (profileLayer) {
					profileLayer.appliedConstraintCount++;
				}
			} else {
				failedConstraintIds.push(String(constraint.id ?? ""));
				if (profileLayer) {
					profileLayer.failedConstraintCount++;
				}
			}
			if (profileLayer) {
				if (profileConstraintDetailCount < maximumAnimationRigProfileConstraints) {
					profileLayer.constraints.push({
						constraintId: String(constraint.id ?? ""),
						name: String(constraint.name ?? constraint.id ?? "Constraint"),
						type: String(constraint.type ?? "unknown"),
						enabled: true,
						status: applied ? "applied" : "failed",
						durationMilliseconds: Math.max(0, animationRigJobElapsedStart() - constraintStarted),
					});
					profileConstraintDetailCount++;
				} else {
					profileLayer.truncatedConstraintCount++;
					truncatedConstraintCount++;
				}
			}
		}
		if (profileLayer) {
			profileLayer.durationMilliseconds = Math.max(0, animationRigJobElapsedStart() - layerStarted);
			if (profileLayers.length < maximumAnimationRigProfileLayers) {
				profileLayers.push(profileLayer);
			} else {
				truncatedLayerCount++;
			}
		}
	}
	if (!options.skeletonId && !selectedLayerIds && !selectedConstraintRefs) {
		const states = animationRigJobStates.get(scene);
		if (states) {
			for (const [key, state] of states) {
				if (!visitedCustomJobs.has(key)) {
					destroyAnimationRigJobState(state);
					states.delete(key);
				}
			}
		}
	}
	if (captureProfile) {
		const requestedDelta = options.deltaTimeSeconds ?? (scene.getEngine().getDeltaTime() / 1000 || 1 / 60);
		publishAnimationRigProfileSample(profiler, {
			evaluationIndex: profiler.evaluationCount,
			capturedAt: new Date().toISOString(),
			deltaTimeSeconds: Math.min(1, Math.max(0, Number.isFinite(requestedDelta) ? requestedDelta : 1 / 60)),
			durationMilliseconds: Math.max(0, animationRigJobElapsedStart() - profileStarted),
			layerCount: layers.length,
			constraintCount,
			appliedConstraintCount,
			failedConstraintCount: failedConstraintIds.length,
			disabledConstraintCount,
			skippedLayerCount,
			failedConstraintIds: failedConstraintIds.slice(0, maximumAnimationRigProfileConstraints),
			layers: profileLayers,
			truncatedLayerCount,
			truncatedConstraintCount,
			selection: {
				skeletonId: options.skeletonId ?? null,
				layerIds: options.layerIds ? options.layerIds.slice(0, maximumAnimationRigProfileLayers) : null,
				constraintRefs: options.constraintRefs ? options.constraintRefs.slice(0, maximumAnimationRigProfileConstraints).map((reference) => ({ ...reference })) : null,
				fixedDeltaTimeSeconds: options.deltaTimeSeconds ?? null,
				resetTemporalState: options.resetTemporalState === true,
			},
		});
	}
	return { layerCount: layers.length, constraintCount, appliedConstraintCount, failedConstraintIds };
}

/** Configures the exported/editor runtime evaluator once; layer metadata remains live-editable. */
export function configureRigLayers(scene: Scene): void {
	if (configuredScenes.has(scene)) {
		return;
	}
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => applyRigLayers(scene));
}
