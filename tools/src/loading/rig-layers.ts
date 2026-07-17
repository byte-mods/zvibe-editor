import { Bone } from "@babylonjs/core/Bones/bone";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

const configuredScenes = new WeakSet<Scene>();
const dampedTransformStates = new WeakMap<Scene, Map<string, { signature: string; position: Vector3; rotation: Quaternion }>>();

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

function applyDampedTransform(scene: Scene, layer: any, constraint: any): boolean {
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
	const deltaTime = Math.min(1 / 15, Math.max(1 / 240, scene.getEngine().getDeltaTime() / 1000 || 1 / 60));
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

/** Evaluates enabled rig layers and constraints in deterministic layer/order sequence after animation. */
export function applyRigLayers(scene: Scene): { layerCount: number; constraintCount: number; appliedConstraintCount: number; failedConstraintIds: string[] } {
	const layers = Array.isArray(scene.metadata?.babylonEditorRigLayers) ? [...scene.metadata.babylonEditorRigLayers] : [];
	layers.sort((left, right) => Number(left.order ?? 0) - Number(right.order ?? 0) || String(left.id).localeCompare(String(right.id)));
	let constraintCount = 0;
	let appliedConstraintCount = 0;
	const failedConstraintIds: string[] = [];
	for (const layer of layers) {
		if (layer.enabled === false || clamp01(layer.weight) <= 0 || !Array.isArray(layer.constraints)) {
			continue;
		}
		for (const constraint of layer.constraints) {
			constraintCount++;
			if (constraint.enabled === false) {
				continue;
			}
			const applied =
				constraint.type === "multiParent"
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
												? applyDampedTransform(scene, layer, constraint)
												: constraint.type === "blendTransform"
													? applyBlendTransform(scene, layer, constraint)
													: false;
			if (applied) {
				appliedConstraintCount++;
			} else {
				failedConstraintIds.push(String(constraint.id ?? ""));
			}
		}
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
