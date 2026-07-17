import { Animation, AnimationGroup, BoneIKController, BoneLookController, Scene, Tools, TransformNode, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";
import { isAbstractMesh, isTransformNode } from "../../tools/guards/nodes";

type IRuntimeIKController = { controller: BoneIKController; observer: any };
type IRuntimeLookAtConstraint = { controller: BoneLookController; observer: any };
type IRuntimeSpriteIKController = { observer: any };

const runtimeControllers = new WeakMap<Scene, Map<string, IRuntimeIKController>>();
const runtimeLookAtConstraints = new WeakMap<Scene, Map<string, IRuntimeLookAtConstraint>>();
const runtimeSpriteIKControllers = new WeakMap<Scene, Map<string, IRuntimeSpriteIKController>>();

function configs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorIKControllers ??= []);
}

function runtime(scene: Scene): Map<string, IRuntimeIKController> {
	let controllers = runtimeControllers.get(scene);
	if (!controllers) runtimeControllers.set(scene, (controllers = new Map()));
	return controllers;
}
function lookAtConfigs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorLookAtConstraints ??= []);
}
function lookAtRuntime(scene: Scene): Map<string, IRuntimeLookAtConstraint> {
	let constraints = runtimeLookAtConstraints.get(scene);
	if (!constraints) runtimeLookAtConstraints.set(scene, (constraints = new Map()));
	return constraints;
}
function spriteIKConfigs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorSpriteIKControllers ??= []);
}
function spriteIKRuntime(scene: Scene): Map<string, IRuntimeSpriteIKController> {
	let controllers = runtimeSpriteIKControllers.get(scene);
	if (!controllers) runtimeSpriteIKControllers.set(scene, (controllers = new Map()));
	return controllers;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Applies a planar two-bone cutout/sprite rig. The chain is root -> joint -> tip and points along local +X at rest. */
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

function createRuntimeSpriteIKController(scene: Scene, config: any): IRuntimeSpriteIKController {
	if (!applySpriteIKController(scene, config))
		throw new Error("A Sprite IK chain requires TransformNodes parented root -> joint -> tip, non-zero XY segment lengths, and a TransformNode target.");
	const observer = scene.onBeforeRenderObservable.add(() => {
		if (config.enabled !== false) applySpriteIKController(scene, config);
	});
	return { observer };
}

function createRuntimeController(scene: Scene, config: any): IRuntimeIKController {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === config.skeletonId);
	if (!skeleton) throw new Error(`Skeleton "${config.skeletonId}" was not found.`);
	const bone = skeleton.bones.find((candidate) => candidate.name === config.boneName);
	if (!bone) throw new Error(`Bone "${config.boneName}" was not found in skeleton "${skeleton.name}".`);
	if (!bone.getParent()) throw new Error(`Bone "${bone.name}" needs a parent bone for two-bone IK.`);
	const mesh = scene.meshes.find((candidate) => candidate.id === config.meshId && candidate.skeleton === skeleton);
	if (!mesh) throw new Error("The IK controller mesh was not found or no longer uses the selected skeleton.");
	const target = resolveNode({ scene, nodeId: config.targetNodeId });
	if (!isTransformNode(target) && !isAbstractMesh(target)) throw new Error("The IK target must be a mesh or transform node.");
	const poleTarget = config.poleTargetNodeId ? resolveNode({ scene, nodeId: config.poleTargetNodeId }) : undefined;
	if (poleTarget && !isTransformNode(poleTarget) && !isAbstractMesh(poleTarget)) throw new Error("The IK pole target must be a mesh or transform node.");
	const controller = new BoneIKController(mesh as TransformNode, bone, {
		targetMesh: target,
		poleTargetMesh: poleTarget,
		poleAngle: config.poleAngle,
		bendAxis: config.bendAxis ? Vector3.FromArray(config.bendAxis) : undefined,
		maxAngle: config.maxAngle,
		slerpAmount: config.slerpAmount,
	});
	const observer = scene.onBeforeRenderObservable.add(() => {
		if (config.enabled !== false) controller.update();
	});
	return { controller, observer };
}

function createRuntimeLookAtConstraint(scene: Scene, config: any): IRuntimeLookAtConstraint {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === config.skeletonId);
	if (!skeleton) throw new Error(`Skeleton "${config.skeletonId}" was not found.`);
	const bone = skeleton.bones.find((candidate) => candidate.name === config.boneName);
	if (!bone) throw new Error(`Bone "${config.boneName}" was not found in skeleton "${skeleton.name}".`);
	const mesh = scene.meshes.find((candidate) => candidate.id === config.meshId && candidate.skeleton === skeleton);
	if (!mesh) throw new Error("The look-at constraint mesh was not found or no longer uses the selected skeleton.");
	const target = resolveNode({ scene, nodeId: config.targetNodeId });
	if (!isTransformNode(target) && !isAbstractMesh(target)) throw new Error("The look-at target must be a mesh or transform node.");
	const controller = new BoneLookController(mesh as TransformNode, bone, target.getAbsolutePosition().clone(), {
		minYaw: config.minYaw,
		maxYaw: config.maxYaw,
		minPitch: config.minPitch,
		maxPitch: config.maxPitch,
		slerpAmount: config.slerpAmount ?? 1,
		adjustYaw: config.adjustYaw,
		adjustPitch: config.adjustPitch,
		adjustRoll: config.adjustRoll,
	});
	const observer = scene.onBeforeRenderObservable.add(() => {
		if (config.enabled === false) return;
		controller.target.copyFrom(target.getAbsolutePosition());
		controller.update();
	});
	return { controller, observer };
}

/** Restores serialized IK controls after the skeletons and meshes have loaded. */
export function restoreIKControllers(scene: Scene): void {
	for (const config of configs(scene)) {
		if (runtime(scene).has(config.id)) continue;
		try {
			runtime(scene).set(config.id, createRuntimeController(scene, config));
		} catch (error) {
			console.warn(`Failed to restore IK controller ${config.id}:`, error);
		}
	}
}

/** Restores persisted bone look-at constraints once skeletons and target nodes have loaded. */
export function restoreLookAtConstraints(scene: Scene): void {
	for (const config of lookAtConfigs(scene)) {
		if (lookAtRuntime(scene).has(config.id)) continue;
		try {
			lookAtRuntime(scene).set(config.id, createRuntimeLookAtConstraint(scene, config));
		} catch (error) {
			console.warn(`Failed to restore look-at constraint ${config.id}:`, error);
		}
	}
}

/** Lists a skeleton's hierarchy so agents can safely choose an IK-compatible bone. */
export function getSkeletonBones(scene: Scene, data: any): any {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === data.skeletonId);
	if (!skeleton) throw new Error(`Skeleton "${data.skeletonId}" was not found.`);
	return {
		skeletonId: skeleton.id,
		bones: skeleton.bones.map((bone, index) => ({
			index,
			name: bone.name,
			parentIndex: bone.getParent() ? skeleton.bones.indexOf(bone.getParent()!) : null,
			childCount: bone.children.length,
			length: bone.length,
		})),
	};
}

/** Lists persisted two-bone IK controllers and their live status. */
export function listIKControllers(scene: Scene): any {
	return { controllers: structuredClone(configs(scene)).map((config) => ({ ...config, active: runtime(scene).has(config.id) })) };
}

/** Creates a persistent Babylon BoneIKController driven each render frame. */
export function createIKController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = {
		id: data.id ?? Tools.RandomId(),
		skeletonId: data.skeletonId,
		boneName: data.boneName,
		meshId: data.meshId,
		targetNodeId: data.targetNodeId,
		poleTargetNodeId: data.poleTargetNodeId,
		poleAngle: data.poleAngle,
		bendAxis: data.bendAxis,
		maxAngle: data.maxAngle,
		slerpAmount: data.slerpAmount ?? 1,
		enabled: data.enabled ?? true,
	};
	if (configs(scene).some((candidate) => candidate.id === config.id)) throw new Error(`IK controller "${config.id}" already exists.`);
	const controller = createRuntimeController(scene, config);
	configs(scene).push(config);
	runtime(scene).set(config.id, controller);
	options.editor.layout.inspector.forceUpdate();
	return { ...config, active: true };
}

/** Changes enabled state, pole target, or numerical IK properties without recreating the scene. */
export function setIKController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = configs(scene).find((candidate) => candidate.id === data.id);
	if (!config) throw new Error(`IK controller "${data.id}" was not found.`);
	const next = { ...config };
	for (const key of ["enabled", "poleTargetNodeId", "poleAngle", "maxAngle", "slerpAmount"] as const) if (data[key] !== undefined) next[key] = data[key];
	if (data.bendAxis !== undefined) next.bendAxis = data.bendAxis;
	const active = runtime(scene).get(config.id);
	if (active && next.poleTargetNodeId !== config.poleTargetNodeId) {
		const replacement = createRuntimeController(scene, next);
		scene.onBeforeRenderObservable.remove(active.observer);
		runtime(scene).set(config.id, replacement);
	} else if (active) {
		active.controller.poleAngle = next.poleAngle ?? active.controller.poleAngle;
		active.controller.maxAngle = next.maxAngle ?? active.controller.maxAngle;
		active.controller.slerpAmount = next.slerpAmount ?? active.controller.slerpAmount;
	}
	Object.assign(config, next);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(config), active: !!runtime(scene).get(config.id) };
}

/** Stops and removes a persistent IK controller. */
export function deleteIKController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = configs(scene).findIndex((candidate) => candidate.id === data.id);
	if (index === -1) throw new Error(`IK controller "${data.id}" was not found.`);
	const active = runtime(scene).get(data.id);
	if (active) scene.onBeforeRenderObservable.remove(active.observer);
	runtime(scene).delete(data.id);
	configs(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Lists persisted bone look-at constraints and whether they are active in the preview. */
export function listLookAtConstraints(scene: Scene): any {
	return { constraints: structuredClone(lookAtConfigs(scene)).map((config) => ({ ...config, active: lookAtRuntime(scene).has(config.id) })) };
}

/** Creates a persistent constrained bone that tracks a transform/mesh target every frame. */
export function createLookAtConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = {
		id: data.id ?? Tools.RandomId(),
		skeletonId: data.skeletonId,
		boneName: data.boneName,
		meshId: data.meshId,
		targetNodeId: data.targetNodeId,
		minYaw: data.minYaw,
		maxYaw: data.maxYaw,
		minPitch: data.minPitch,
		maxPitch: data.maxPitch,
		slerpAmount: data.slerpAmount ?? 1,
		adjustYaw: data.adjustYaw,
		adjustPitch: data.adjustPitch,
		adjustRoll: data.adjustRoll,
		enabled: data.enabled ?? true,
	};
	if (lookAtConfigs(scene).some((candidate) => candidate.id === config.id)) throw new Error(`Look-at constraint "${config.id}" already exists.`);
	const active = createRuntimeLookAtConstraint(scene, config);
	lookAtConfigs(scene).push(config);
	lookAtRuntime(scene).set(config.id, active);
	options.editor.layout.inspector.forceUpdate();
	return { ...config, active: true };
}

/** Updates look-at constraint limits, adjustments, target, or enabled state without recreating it. */
export function setLookAtConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = lookAtConfigs(scene).find((candidate) => candidate.id === data.id);
	if (!config) throw new Error(`Look-at constraint "${data.id}" was not found.`);
	const next = { ...config };
	for (const key of ["targetNodeId", "enabled", "minYaw", "maxYaw", "minPitch", "maxPitch", "slerpAmount", "adjustYaw", "adjustPitch", "adjustRoll"] as const)
		if (data[key] !== undefined) next[key] = data[key];
	const current = lookAtRuntime(scene).get(config.id);
	if (current && next.targetNodeId !== config.targetNodeId) {
		const replacement = createRuntimeLookAtConstraint(scene, next);
		scene.onBeforeRenderObservable.remove(current.observer);
		lookAtRuntime(scene).set(config.id, replacement);
	} else if (current) {
		for (const key of ["minYaw", "maxYaw", "minPitch", "maxPitch", "slerpAmount", "adjustYaw", "adjustPitch", "adjustRoll"] as const)
			if (next[key] !== undefined) current.controller[key] = next[key];
	}
	Object.assign(config, next);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(config), active: !!current };
}

/** Stops and removes a persistent bone look-at constraint. */
export function deleteLookAtConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = lookAtConfigs(scene).findIndex((candidate) => candidate.id === data.id);
	if (index === -1) throw new Error(`Look-at constraint "${data.id}" was not found.`);
	const current = lookAtRuntime(scene).get(data.id);
	if (current) scene.onBeforeRenderObservable.remove(current.observer);
	lookAtRuntime(scene).delete(data.id);
	lookAtConfigs(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Recreates planar cutout/sprite IK controllers after transform nodes load. */
export function restoreSpriteIKControllers(scene: Scene): void {
	for (const config of spriteIKConfigs(scene)) {
		if (spriteIKRuntime(scene).has(config.id)) continue;
		try {
			spriteIKRuntime(scene).set(config.id, createRuntimeSpriteIKController(scene, config));
		} catch (error) {
			console.warn(`Failed to restore Sprite IK controller ${config.id}:`, error);
		}
	}
}

/** Lists persisted 2D cutout/sprite IK controllers and preview activation state. */
export function listSpriteIKControllers(scene: Scene): any {
	return { controllers: structuredClone(spriteIKConfigs(scene)).map((config) => ({ ...config, active: spriteIKRuntime(scene).has(config.id) })) };
}

/** Creates a persistent planar root -> joint -> tip two-bone IK controller for cutout sprites. */
export function createSpriteIKController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = {
		id: data.id ?? Tools.RandomId(),
		rootNodeId: data.rootNodeId,
		jointNodeId: data.jointNodeId,
		tipNodeId: data.tipNodeId,
		targetNodeId: data.targetNodeId,
		bendDirection: data.bendDirection ?? "counterClockwise",
		enabled: data.enabled ?? true,
	};
	if (spriteIKConfigs(scene).some((candidate) => candidate.id === config.id)) throw new Error(`Sprite IK controller "${config.id}" already exists.`);
	const active = createRuntimeSpriteIKController(scene, config);
	spriteIKConfigs(scene).push(config);
	spriteIKRuntime(scene).set(config.id, active);
	options.editor.layout.inspector.forceUpdate();
	return { ...config, active: true };
}

/** Creates an editable planar Root -> Joint -> Tip transform hierarchy and its persisted Sprite IK controller. */
export function createSpriteIKRig(scene: Scene, data: any, options: IMCPActionOptions): any {
	const name = String(data.name ?? "Sprite Rig").trim();
	if (!name) throw new Error("Sprite IK rig name must not be empty.");
	const firstLength = Number(data.firstLength ?? 100);
	const secondLength = Number(data.secondLength ?? 100);
	if (!Number.isFinite(firstLength) || !Number.isFinite(secondLength) || firstLength <= 0 || secondLength <= 0) {
		throw new Error("Sprite IK segment lengths must be positive finite centimeters.");
	}
	const position = Array.isArray(data.position) ? Vector3.FromArray(data.position) : Vector3.Zero();
	const targetPosition = Array.isArray(data.targetPosition) ? Vector3.FromArray(data.targetPosition) : position.add(new Vector3(firstLength + secondLength, 0, 0));
	const root = new TransformNode(`${name} Root`, scene);
	root.position.copyFrom(position);
	const joint = new TransformNode(`${name} Joint`, scene);
	joint.parent = root;
	joint.position.x = firstLength;
	const tip = new TransformNode(`${name} Tip`, scene);
	tip.parent = joint;
	tip.position.x = secondLength;
	const target = new TransformNode(`${name} Target`, scene);
	target.position.copyFrom(targetPosition);
	try {
		const controller = createSpriteIKController(
			scene,
			{ id: data.id, rootNodeId: root.id, jointNodeId: joint.id, tipNodeId: tip.id, targetNodeId: target.id, bendDirection: data.bendDirection, enabled: data.enabled },
			options
		);
		return { rootNodeId: root.id, jointNodeId: joint.id, tipNodeId: tip.id, targetNodeId: target.id, controller };
	} catch (error) {
		root.dispose(false, true);
		target.dispose(false, true);
		throw error;
	}
}

/** Bakes a sequence of planar Sprite IK target positions into editable root/joint rotation AnimationGroup tracks. */
export function bakeSpriteIKAnimation(scene: Scene, data: any, options: IMCPActionOptions): any {
	const controller = spriteIKConfigs(scene).find((candidate) => candidate.id === data.id);
	if (!controller) throw new Error(`Sprite IK controller "${data.id}" was not found.`);
	const name = String(data.name ?? "Sprite IK Pose").trim();
	if (!name) throw new Error("Animation name must not be empty.");
	if (scene.animationGroups.some((group) => group.name === name)) throw new Error(`Animation group "${name}" already exists.`);
	if (!Array.isArray(data.poses) || data.poses.length < 2) throw new Error("Provide at least two Sprite IK poses to bake an animation.");
	const root = scene.getTransformNodeById(controller.rootNodeId);
	const joint = scene.getTransformNodeById(controller.jointNodeId);
	const target = scene.getTransformNodeById(controller.targetNodeId);
	if (!root || !joint || !target) throw new Error("The Sprite IK controller references missing TransformNodes.");
	const originalTarget = target.position.clone();
	const originalRootRotation = root.rotation.z;
	const originalJointRotation = joint.rotation.z;
	try {
		const rootKeys: { frame: number; value: number }[] = [];
		const jointKeys: { frame: number; value: number }[] = [];
		let previousFrame = -Infinity;
		for (const pose of data.poses) {
			const frame = Number(pose.frame);
			if (!Number.isFinite(frame) || frame <= previousFrame || !Array.isArray(pose.targetPosition) || pose.targetPosition.length !== 3) {
				throw new Error("Sprite IK poses must have strictly increasing finite frames and three-number targetPosition arrays.");
			}
			previousFrame = frame;
			target.position.copyFromFloats(pose.targetPosition[0], pose.targetPosition[1], pose.targetPosition[2]);
			if (!applySpriteIKController(scene, controller)) throw new Error("Unable to solve the Sprite IK chain for a baked pose.");
			rootKeys.push({ frame, value: root.rotation.z });
			jointKeys.push({ frame, value: joint.rotation.z });
		}
		const framesPerSecond = Number(data.framesPerSecond ?? 60);
		if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) throw new Error("framesPerSecond must be a positive finite number.");
		const group = new AnimationGroup(name, scene);
		const rootAnimation = new Animation(`${name} Root Rotation`, "rotation.z", framesPerSecond, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		const jointAnimation = new Animation(`${name} Joint Rotation`, "rotation.z", framesPerSecond, Animation.ANIMATIONTYPE_FLOAT, Animation.ANIMATIONLOOPMODE_CYCLE);
		rootAnimation.setKeys(rootKeys);
		jointAnimation.setKeys(jointKeys);
		group.addTargetedAnimation(rootAnimation, root);
		group.addTargetedAnimation(jointAnimation, joint);
		options.editor.layout.inspector.forceUpdate();
		return { name: group.name, framesPerSecond, tracks: 2, frames: rootKeys.map((key) => key.frame) };
	} finally {
		target.position.copyFrom(originalTarget);
		root.rotation.z = originalRootRotation;
		joint.rotation.z = originalJointRotation;
	}
}

/** Updates a Sprite IK target, bend direction, or enabled state. */
export function setSpriteIKController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = spriteIKConfigs(scene).find((candidate) => candidate.id === data.id);
	if (!config) throw new Error(`Sprite IK controller "${data.id}" was not found.`);
	const next = { ...config };
	for (const key of ["targetNodeId", "bendDirection", "enabled"] as const) if (data[key] !== undefined) next[key] = data[key];
	const active = spriteIKRuntime(scene).get(config.id);
	if (active && next.targetNodeId !== config.targetNodeId) {
		const replacement = createRuntimeSpriteIKController(scene, next);
		scene.onBeforeRenderObservable.remove(active.observer);
		spriteIKRuntime(scene).set(config.id, replacement);
	}
	Object.assign(config, next);
	options.editor.layout.inspector.forceUpdate();
	return { ...structuredClone(config), active: !!spriteIKRuntime(scene).get(config.id) };
}

/** Stops and removes a persistent planar Sprite IK controller. */
export function deleteSpriteIKController(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = spriteIKConfigs(scene).findIndex((candidate) => candidate.id === data.id);
	if (index === -1) throw new Error(`Sprite IK controller "${data.id}" was not found.`);
	const active = spriteIKRuntime(scene).get(data.id);
	if (active) scene.onBeforeRenderObservable.remove(active.observer);
	spriteIKRuntime(scene).delete(data.id);
	spriteIKConfigs(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}
