import { BoneIKController } from "@babylonjs/core/Bones/boneIKController";
import { BoneLookController } from "@babylonjs/core/Bones/boneLookController";
import { Bone } from "@babylonjs/core/Bones/bone";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function nodeWorldRotation(node: TransformNode): Quaternion {
	const rotation = Quaternion.Identity();
	node.computeWorldMatrix(true).decompose(undefined, rotation);
	return rotation.normalize();
}

function syncLinkedBoneRotation(bone: Bone): void {
	const node = bone.getTransformNode();
	if (!node) {
		return;
	}
	node.rotationQuaternion ??= Quaternion.Identity();
	bone.getRotationQuaternionToRef(Space.LOCAL, null, node.rotationQuaternion);
}

function rotationsMatch(left: Quaternion, right: Quaternion): boolean {
	return Math.abs(Quaternion.Dot(left.clone().normalize(), right.clone().normalize())) >= 1 - 1e-8;
}

function restoreTwoBoneIKSourcePose(controller: any, mesh: any, rootBone: any, midBone: any): { root: Quaternion; mid: Quaternion; state: any } {
	const currentRoot = rootBone.getRotationQuaternion(Space.WORLD, mesh);
	const currentMid = midBone.getRotationQuaternion(Space.WORLD, mesh);
	let state = controller.__babylonEditorSourcePose;
	if (!state || !rotationsMatch(currentRoot, state.lastRoot) || !rotationsMatch(currentMid, state.lastMid)) {
		state = controller.__babylonEditorSourcePose = { inputRoot: currentRoot.clone(), inputMid: currentMid.clone(), lastRoot: currentRoot.clone(), lastMid: currentMid.clone() };
	}
	rootBone.setRotationQuaternion(state.inputRoot, Space.WORLD, mesh);
	midBone.setRotationQuaternion(state.inputMid, Space.WORLD, mesh);
	syncLinkedBoneRotation(rootBone);
	syncLinkedBoneRotation(midBone);
	rootBone.getSkeleton().computeAbsoluteMatrices(true);
	return { root: state.inputRoot.clone(), mid: state.inputMid.clone(), state };
}

function getTwoBoneIKSegmentLengths(mesh: any, midBone: any): [number, number] {
	const rootBone = midBone.getParent();
	if (!rootBone) {
		return [0, 0];
	}
	let rootLength: number;
	let midLength: number;
	if (rootBone.length && midBone.length) {
		rootLength = rootBone.length * rootBone.getScale().y * mesh.scaling.y;
		midLength = midBone.length * midBone.getScale().y * mesh.scaling.y;
	} else {
		const rootPosition = rootBone.getPosition(Space.WORLD, mesh);
		const midPosition = midBone.getPosition(Space.WORLD, mesh);
		rootLength = Vector3.Distance(rootPosition, midPosition);
		midLength = midBone.children[0]
			? Vector3.Distance(midPosition, midBone.children[0].getPosition(Space.WORLD, mesh))
			: midBone.length * midBone.getScale().y * mesh.scaling.y;
	}
	return [rootLength, midLength];
}

/** Returns the effective joint used by Babylon's BoneIKController, including explicit imported bone lengths. */
export function getTwoBoneIKJointPosition(mesh: any, midBone: any): any {
	const rootBone = midBone.getParent();
	if (!rootBone) {
		return midBone.getPosition(Space.WORLD, mesh);
	}
	const [rootLength] = getTwoBoneIKSegmentLengths(mesh, midBone);
	const rootPosition = rootBone.getPosition(Space.WORLD, mesh);
	const rootDirection = Vector3.Up().applyRotationQuaternion(rootBone.getRotationQuaternion(Space.WORLD, mesh));
	return rootPosition.add(rootDirection.scale(rootLength));
}

/** Returns the effective endpoint used by Babylon's BoneIKController, including explicit imported bone lengths. */
export function getTwoBoneIKEndpoint(mesh: any, midBone: any): any {
	const rootBone = midBone.getParent();
	if (!rootBone) {
		return midBone.getPosition(Space.WORLD, mesh);
	}
	const [, midLength] = getTwoBoneIKSegmentLengths(mesh, midBone);
	const jointPosition = getTwoBoneIKJointPosition(mesh, midBone);
	const midDirection = Vector3.Up().applyRotationQuaternion(midBone.getRotationQuaternion(Space.WORLD, mesh));
	return jointPosition.addInPlace(midDirection.scale(midLength));
}

function weightedTwoBoneIKPolePosition(mesh: any, midBone: any, poleTarget: any, targetPosition: Vector3, hintWeight: number): Vector3 {
	const rootBone = midBone.getParent();
	const rootPosition = rootBone.getPosition(Space.WORLD, mesh);
	const originalPosition = getTwoBoneIKJointPosition(mesh, midBone);
	const hintedPosition = poleTarget.getAbsolutePosition();
	if (hintWeight <= 0) {
		return originalPosition;
	}
	if (hintWeight >= 1) {
		return hintedPosition;
	}
	const axis = targetPosition.subtract(rootPosition);
	if (axis.lengthSquared() < 1e-10) {
		return Vector3.Lerp(originalPosition, hintedPosition, hintWeight);
	}
	axis.normalize();
	const originalDirection = originalPosition.subtract(rootPosition);
	originalDirection.subtractInPlace(axis.scale(Vector3.Dot(originalDirection, axis)));
	const hintedDirection = hintedPosition.subtract(rootPosition);
	hintedDirection.subtractInPlace(axis.scale(Vector3.Dot(hintedDirection, axis)));
	if (originalDirection.lengthSquared() < 1e-10) {
		originalDirection.copyFrom(Vector3.Cross(axis, Math.abs(Vector3.Dot(axis, Vector3.Up())) < 0.9 ? Vector3.Up() : Vector3.Right()));
	}
	if (hintedDirection.lengthSquared() < 1e-10) {
		return originalPosition;
	}
	const distance = Math.max(originalDirection.length(), hintedDirection.length(), 1);
	originalDirection.normalize();
	hintedDirection.normalize();
	const angle = Math.atan2(Vector3.Dot(Vector3.Cross(originalDirection, hintedDirection), axis), Vector3.Dot(originalDirection, hintedDirection));
	return rootPosition.add(originalDirection.applyRotationQuaternion(Quaternion.RotationAxis(axis, angle * hintWeight)).scale(distance));
}

/** Evaluates a persisted native Two-Bone IK controller with Unity-style position/rotation weights and maintained target offsets. */
export function updateConfiguredTwoBoneIKController(controller: any, mesh: any, midBone: any, target: any, config: any, poleTarget?: any): void {
	const rootBone = midBone.getParent();
	if (!rootBone) {
		return;
	}
	const positionWeight = clamp(Number(config.targetPositionWeight ?? 1), 0, 1);
	const sourcePose = restoreTwoBoneIKSourcePose(controller, mesh, rootBone, midBone);
	const rootBefore = sourcePose.root;
	const midBefore = sourcePose.mid;
	const targetPosition =
		config.maintainTargetPositionOffset && Array.isArray(config.targetPositionOffset)
			? Vector3.TransformCoordinates(Vector3.FromArray(config.targetPositionOffset), target.computeWorldMatrix(true))
			: target.getAbsolutePosition();
	controller.targetPosition.copyFrom(targetPosition);
	if (poleTarget) {
		controller.poleTargetBone = null;
		controller.poleTargetMesh = null;
		controller.poleTargetPosition.copyFrom(weightedTwoBoneIKPolePosition(mesh, midBone, poleTarget, targetPosition, clamp(Number(config.hintWeight ?? 1), 0, 1)));
	}
	if (positionWeight > 0) {
		controller.update();
		if (positionWeight < 1) {
			rootBone.setRotationQuaternion(Quaternion.Slerp(rootBefore, rootBone.getRotationQuaternion(Space.WORLD, mesh), positionWeight), Space.WORLD, mesh);
			midBone.setRotationQuaternion(Quaternion.Slerp(midBefore, midBone.getRotationQuaternion(Space.WORLD, mesh), positionWeight), Space.WORLD, mesh);
			syncLinkedBoneRotation(rootBone);
			syncLinkedBoneRotation(midBone);
		}
	}
	sourcePose.state.lastRoot = rootBone.getRotationQuaternion(Space.WORLD, mesh).clone();
	sourcePose.state.lastMid = midBone.getRotationQuaternion(Space.WORLD, mesh).clone();
	const tipBone = midBone.children[0];
	const rotationWeight = clamp(Number(config.targetRotationWeight ?? 0), 0, 1);
	if (!tipBone || rotationWeight <= 0) {
		return;
	}
	const current = tipBone.getRotationQuaternion(Space.WORLD, mesh);
	let desired = nodeWorldRotation(target);
	if (config.maintainTargetRotationOffset && Array.isArray(config.targetRotationOffset) && config.targetRotationOffset.length === 4) {
		desired = desired.multiply(Quaternion.FromArray(config.targetRotationOffset)).normalize();
	}
	tipBone.setRotationQuaternion(Quaternion.Slerp(current, desired, rotationWeight), Space.WORLD, mesh);
	syncLinkedBoneRotation(tipBone);
}

/** Applies a planar root -> joint -> tip cutout/sprite IK chain that points along local +X at rest. */
export function applySpriteIKController(scene: Scene, config: any): boolean {
	const root = scene.getTransformNodeById(config.rootNodeId);
	const joint = scene.getTransformNodeById(config.jointNodeId);
	const tip = scene.getTransformNodeById(config.tipNodeId);
	const target = scene.getTransformNodeById(config.targetNodeId);
	if (!root || !joint || !tip || !target || joint.parent !== root || tip.parent !== joint) {
		return false;
	}
	const firstLength = Math.hypot(joint.position.x, joint.position.y);
	const secondLength = Math.hypot(tip.position.x, tip.position.y);
	if (firstLength < 0.0001 || secondLength < 0.0001) {
		return false;
	}
	const rootPosition = root.getAbsolutePosition();
	const targetPosition = target.getAbsolutePosition();
	const dx = targetPosition.x - rootPosition.x;
	const dy = targetPosition.y - rootPosition.y;
	const distance = clamp(Math.hypot(dx, dy), Math.abs(firstLength - secondLength) + 0.0001, firstLength + secondLength - 0.0001);
	const baseAngle = Math.atan2(dy, dx);
	const bend = config.bendDirection === "clockwise" ? -1 : 1;
	const rootOffset = Math.atan2(joint.position.y, joint.position.x);
	const jointOffset = Math.atan2(tip.position.y, tip.position.x);
	const rootAngle = baseAngle + bend * Math.acos(clamp((firstLength * firstLength + distance * distance - secondLength * secondLength) / (2 * firstLength * distance), -1, 1));
	const jointAngle = -bend * Math.acos(clamp((firstLength * firstLength + secondLength * secondLength - distance * distance) / (2 * firstLength * secondLength), -1, 1));
	const parentRotation = root.parent instanceof TransformNode ? (root.parent.absoluteRotationQuaternion?.toEulerAngles().z ?? root.parent.rotation.z) : 0;
	root.rotation.z = rootAngle - rootOffset - parentRotation;
	joint.rotation.z = jointAngle - jointOffset;
	return true;
}

/** Recreates editor-authored two-bone IK controllers in generated projects. */
export function configureIKControllers(scene: Scene): void {
	const controllers = scene.metadata?.babylonEditorIKControllers;
	if (!Array.isArray(controllers)) {
		return;
	}

	for (const config of controllers) {
		const skeleton = scene.skeletons.find((candidate) => candidate.id === config.skeletonId);
		const bone = skeleton?.bones.find((candidate) => candidate.name === config.boneName);
		const mesh = scene.meshes.find((candidate) => candidate.id === config.meshId && candidate.skeleton === skeleton);
		const target = scene.getNodeById(config.targetNodeId);
		const poleTarget = config.poleTargetNodeId ? scene.getNodeById(config.poleTargetNodeId) : undefined;
		if (!bone?.getParent() || !mesh || !target || !(target instanceof TransformNode) || (poleTarget && !(poleTarget instanceof TransformNode))) {
			continue;
		}
		const controller = new BoneIKController(mesh, bone, {
			poleAngle: config.poleAngle,
			bendAxis: config.bendAxis ? Vector3.FromArray(config.bendAxis) : undefined,
			maxAngle: config.maxAngle,
			slerpAmount: config.slerpAmount,
		});
		scene.onBeforeRenderObservable.add(() => {
			if (config.enabled !== false) {
				updateConfiguredTwoBoneIKController(controller, mesh, bone, target, config, poleTarget);
			}
		});
	}
}

/** Recreates editor-authored bone look-at constraints in generated projects. */
export function configureLookAtConstraints(scene: Scene): void {
	const constraints = scene.metadata?.babylonEditorLookAtConstraints;
	if (!Array.isArray(constraints)) {
		return;
	}

	for (const config of constraints) {
		const skeleton = scene.skeletons.find((candidate) => candidate.id === config.skeletonId);
		const bone = skeleton?.bones.find((candidate) => candidate.name === config.boneName);
		const mesh = scene.meshes.find((candidate) => candidate.id === config.meshId && candidate.skeleton === skeleton);
		const target = scene.getNodeById(config.targetNodeId);
		if (!bone || !mesh || !target || !(target instanceof TransformNode)) {
			continue;
		}
		const controller = new BoneLookController(mesh, bone, target.getAbsolutePosition().clone(), {
			minYaw: config.minYaw,
			maxYaw: config.maxYaw,
			minPitch: config.minPitch,
			maxPitch: config.maxPitch,
			slerpAmount: config.slerpAmount,
			adjustYaw: config.adjustYaw,
			adjustPitch: config.adjustPitch,
			adjustRoll: config.adjustRoll,
		});
		scene.onBeforeRenderObservable.add(() => {
			if (config.enabled === false) {
				return;
			}
			controller.target.copyFrom(target.getAbsolutePosition());
			controller.update();
		});
	}
}

/** Restores editor-authored 2D cutout/sprite IK chains in generated projects. */
export function configureSpriteIKControllers(scene: Scene): void {
	const controllers = scene.metadata?.babylonEditorSpriteIKControllers;
	if (!Array.isArray(controllers)) {
		return;
	}
	for (const config of controllers) {
		if (!applySpriteIKController(scene, config)) {
			continue;
		}
		scene.onBeforeRenderObservable.add(() => {
			if (config.enabled !== false) {
				applySpriteIKController(scene, config);
			}
		});
	}
}
