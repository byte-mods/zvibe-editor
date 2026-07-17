import { BoneIKController } from "@babylonjs/core/Bones/boneIKController";
import { BoneLookController } from "@babylonjs/core/Bones/boneLookController";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Applies a planar root -> joint -> tip cutout/sprite IK chain that points along local +X at rest. */
export function applySpriteIKController(scene: Scene, config: any): boolean {
	const root = scene.getTransformNodeById(config.rootNodeId);
	const joint = scene.getTransformNodeById(config.jointNodeId);
	const tip = scene.getTransformNodeById(config.tipNodeId);
	const target = scene.getTransformNodeById(config.targetNodeId);
	if (!root || !joint || !tip || !target || joint.parent !== root || tip.parent !== joint) return false;
	const firstLength = Math.hypot(joint.position.x, joint.position.y);
	const secondLength = Math.hypot(tip.position.x, tip.position.y);
	if (firstLength < 0.0001 || secondLength < 0.0001) return false;
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
	if (!Array.isArray(controllers)) return;

	for (const config of controllers) {
		const skeleton = scene.skeletons.find((candidate) => candidate.id === config.skeletonId);
		const bone = skeleton?.bones.find((candidate) => candidate.name === config.boneName);
		const mesh = scene.meshes.find((candidate) => candidate.id === config.meshId && candidate.skeleton === skeleton);
		const target = scene.getNodeById(config.targetNodeId);
		const poleTarget = config.poleTargetNodeId ? scene.getNodeById(config.poleTargetNodeId) : undefined;
		if (!bone?.getParent() || !mesh || !target || !(target instanceof TransformNode) || (poleTarget && !(poleTarget instanceof TransformNode))) continue;
		const controller = new BoneIKController(mesh, bone, {
			targetMesh: target,
			poleTargetMesh: poleTarget as TransformNode | undefined,
			poleAngle: config.poleAngle,
			bendAxis: config.bendAxis ? Vector3.FromArray(config.bendAxis) : undefined,
			maxAngle: config.maxAngle,
			slerpAmount: config.slerpAmount,
		});
		scene.onBeforeRenderObservable.add(() => {
			if (config.enabled !== false) controller.update();
		});
	}
}

/** Recreates editor-authored bone look-at constraints in generated projects. */
export function configureLookAtConstraints(scene: Scene): void {
	const constraints = scene.metadata?.babylonEditorLookAtConstraints;
	if (!Array.isArray(constraints)) return;

	for (const config of constraints) {
		const skeleton = scene.skeletons.find((candidate) => candidate.id === config.skeletonId);
		const bone = skeleton?.bones.find((candidate) => candidate.name === config.boneName);
		const mesh = scene.meshes.find((candidate) => candidate.id === config.meshId && candidate.skeleton === skeleton);
		const target = scene.getNodeById(config.targetNodeId);
		if (!bone || !mesh || !target || !(target instanceof TransformNode)) continue;
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
			if (config.enabled === false) return;
			controller.target.copyFrom(target.getAbsolutePosition());
			controller.update();
		});
	}
}

/** Restores editor-authored 2D cutout/sprite IK chains in generated projects. */
export function configureSpriteIKControllers(scene: Scene): void {
	const controllers = scene.metadata?.babylonEditorSpriteIKControllers;
	if (!Array.isArray(controllers)) return;
	for (const config of controllers) {
		if (!applySpriteIKController(scene, config)) continue;
		scene.onBeforeRenderObservable.add(() => {
			if (config.enabled !== false) applySpriteIKController(scene, config);
		});
	}
}
