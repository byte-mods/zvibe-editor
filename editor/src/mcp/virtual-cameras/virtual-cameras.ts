import { Scene, Tools, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

interface IVirtualCamera {
	id: string;
	name: string;
	cameraId: string;
	followNodeId?: string;
	lookAtNodeId?: string;
	followTargetGroupId?: string;
	lookAtTargetGroupId?: string;
	offset: number[];
	priority: number;
	dolly?: {
		splineId: string;
		t: number;
		speed: number;
		loop: boolean;
		orientToPath: boolean;
	};
}

interface ITargetGroup {
	id: string;
	name: string;
	members: Array<{ nodeId: string; weight: number }>;
}

function controllers(scene: Scene): IVirtualCamera[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorVirtualCameras ??= [];
	return scene.metadata.babylonEditorVirtualCameras;
}

function targetGroups(scene: Scene): ITargetGroup[] {
	scene.metadata ??= {};
	scene.metadata.babylonEditorCameraTargetGroups ??= [];
	return scene.metadata.babylonEditorCameraTargetGroups;
}

function findTargetGroup(scene: Scene, data: any): ITargetGroup {
	const result = targetGroups(scene).find((value) => value.id === data.targetGroupId || value.name === data.targetGroupName);
	if (!result) throw new Error("Camera target group not found.");
	return result;
}

function getTargetGroupPosition(scene: Scene, groupId: string): Vector3 {
	const group = findTargetGroup(scene, { targetGroupId: groupId });
	let totalWeight = 0;
	const position = Vector3.Zero();
	for (const member of group.members) {
		const node = resolveNode({ scene, nodeId: member.nodeId }) as any;
		node.computeWorldMatrix?.(true);
		position.addInPlace(node.getAbsolutePosition().scale(member.weight));
		totalWeight += member.weight;
	}
	if (!totalWeight) throw new Error(`Camera target group \"${group.name}\" has no weighted members.`);
	return position.scale(1 / totalWeight);
}

function find(scene: Scene, data: any): IVirtualCamera {
	const result = controllers(scene).find((value) => value.id === data.virtualCameraId || value.name === data.virtualCameraName);
	if (!result) throw new Error("Virtual camera not found.");
	return result;
}

function apply(scene: Scene, value: IVirtualCamera): any {
	const camera = scene.cameras.find((candidate) => candidate.id === value.cameraId);
	if (!camera) throw new Error(`Camera \"${value.cameraId}\" was not found.`);
	if (value.dolly) applyDolly(scene, camera, value.dolly);
	if (value.followTargetGroupId) camera.position.copyFrom(getTargetGroupPosition(scene, value.followTargetGroupId).add(Vector3.FromArray(value.offset)));
	if (value.followNodeId) camera.position.copyFrom((resolveNode({ scene, nodeId: value.followNodeId }) as any).getAbsolutePosition().add(Vector3.FromArray(value.offset)));
	if (value.lookAtTargetGroupId) (camera as any).setTarget?.(getTargetGroupPosition(scene, value.lookAtTargetGroupId));
	if (value.lookAtNodeId) (camera as any).setTarget?.((resolveNode({ scene, nodeId: value.lookAtNodeId }) as any).getAbsolutePosition());
	scene.activeCamera = camera;
	scene.metadata ??= {};
	scene.metadata.babylonEditorActiveVirtualCameraId = value.id;
	return { ...structuredClone(value), activeCameraId: camera.id, position: camera.position.asArray() };
}

function applyDolly(scene: Scene, camera: any, dolly: NonNullable<IVirtualCamera["dolly"]>): void {
	const spline = resolveNode({ scene, nodeId: dolly.splineId }) as any;
	const points = spline.metadata?.points;
	if (!Array.isArray(points) || points.length < 2) throw new Error(`Spline \"${dolly.splineId}\" has no valid control points.`);
	const path = points.map((point: number[]) => Vector3.FromArray(point));
	if (spline.metadata?.closed) path.push(path[0].clone());
	const lengths = path.slice(0, -1).map((point: Vector3, index: number) => Vector3.Distance(point, path[index + 1]));
	const totalLength = lengths.reduce((total: number, length: number) => total + length, 0);
	if (!totalLength) throw new Error("Cannot dolly on a zero-length spline.");
	let remaining = Math.min(1, Math.max(0, dolly.t)) * totalLength;
	for (let index = 0; index < lengths.length; index++) {
		if (remaining <= lengths[index] || index === lengths.length - 1) {
			const amount = lengths[index] ? remaining / lengths[index] : 0;
			const position = Vector3.TransformCoordinates(Vector3.Lerp(path[index], path[index + 1], amount), spline.getWorldMatrix());
			camera.position.copyFrom(position);
			if (dolly.orientToPath) {
				const tangent = Vector3.TransformNormal(path[index + 1].subtract(path[index]).normalize(), spline.getWorldMatrix()).normalize();
				camera.setTarget?.(position.add(tangent));
			}
			return;
		}
		remaining -= lengths[index];
	}
}

/** Lists persisted virtual camera definitions. */
export function listVirtualCameras(scene: Scene): any {
	return { virtualCameras: structuredClone(controllers(scene)) };
}

/** Creates a follow/look-at virtual camera around an existing editor camera. */
export function createVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (controllers(scene).some((candidate) => candidate.name === data.name)) throw new Error(`Virtual camera \"${data.name}\" already exists.`);
	if (!scene.cameras.some((camera) => camera.id === data.cameraId)) throw new Error(`Camera \"${data.cameraId}\" was not found.`);
	const value: IVirtualCamera = {
		id: Tools.RandomId(),
		name: data.name,
		cameraId: data.cameraId,
		followNodeId: data.followNodeId,
		lookAtNodeId: data.lookAtNodeId,
		followTargetGroupId: data.followTargetGroupId,
		lookAtTargetGroupId: data.lookAtTargetGroupId,
		offset: data.offset ?? [0, 0, 0],
		priority: data.priority ?? 0,
	};
	if (value.offset.length !== 3 || !value.offset.every(Number.isFinite)) throw new Error("Offset must be finite [x, y, z].");
	if (value.followNodeId) resolveNode({ scene, nodeId: value.followNodeId });
	if (value.lookAtNodeId) resolveNode({ scene, nodeId: value.lookAtNodeId });
	if (value.followTargetGroupId) findTargetGroup(scene, { targetGroupId: value.followTargetGroupId });
	if (value.lookAtTargetGroupId) findTargetGroup(scene, { targetGroupId: value.lookAtTargetGroupId });
	controllers(scene).push(value);
	if (data.activate) apply(scene, value);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Lists persisted weighted camera target groups. */
export function listCameraTargetGroups(scene: Scene): any {
	return { targetGroups: structuredClone(targetGroups(scene)) };
}

/** Creates or replaces a weighted camera target group. */
export function setCameraTargetGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!Array.isArray(data.members) || !data.members.length) throw new Error("A camera target group requires at least one member.");
	const members = data.members.map((member: any) => {
		if (!Number.isFinite(member.weight) || member.weight <= 0) throw new Error("Target-group member weights must be greater than zero.");
		resolveNode({ scene, nodeId: member.nodeId });
		return { nodeId: member.nodeId, weight: member.weight };
	});
	const existing = data.targetGroupId || data.targetGroupName ? findTargetGroup(scene, data) : undefined;
	if (!existing && targetGroups(scene).some((candidate) => candidate.name === data.name)) throw new Error(`Camera target group \"${data.name}\" already exists.`);
	const value = existing ?? { id: Tools.RandomId(), name: data.name, members };
	value.name = data.name ?? value.name;
	value.members = members;
	if (!existing) targetGroups(scene).push(value);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Assigns weighted camera target groups to a virtual camera's follow and look-at behaviors. */
export function setVirtualCameraTargetGroups(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (data.followTargetGroupId !== undefined) {
		if (data.followTargetGroupId === null) delete value.followTargetGroupId;
		else {
			findTargetGroup(scene, { targetGroupId: data.followTargetGroupId });
			value.followTargetGroupId = data.followTargetGroupId;
		}
	}
	if (data.lookAtTargetGroupId !== undefined) {
		if (data.lookAtTargetGroupId === null) delete value.lookAtTargetGroupId;
		else {
			findTargetGroup(scene, { targetGroupId: data.lookAtTargetGroupId });
			value.lookAtTargetGroupId = data.lookAtTargetGroupId;
		}
	}
	apply(scene, value);
	options.editor.layout.inspector.setEditedObject(scene.activeCamera!);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Deletes a target group, clearing virtual-camera references without deleting scene nodes. */
export function deleteCameraTargetGroup(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = findTargetGroup(scene, data);
	targetGroups(scene).splice(targetGroups(scene).indexOf(value), 1);
	for (const camera of controllers(scene)) {
		if (camera.followTargetGroupId === value.id) delete camera.followTargetGroupId;
		if (camera.lookAtTargetGroupId === value.id) delete camera.lookAtTargetGroupId;
	}
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}

/** Activates a virtual camera and applies its current follow/look-at pose. */
export function activateVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	const result = apply(scene, find(scene, data));
	options.editor.layout.inspector.setEditedObject(scene.activeCamera!);
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Activates the highest-priority virtual camera. */
export function activateHighestPriorityVirtualCamera(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const value = [...controllers(scene)].sort((a, b) => b.priority - a.priority)[0];
	if (!value) throw new Error("No virtual cameras exist.");
	return activateVirtualCamera(scene, { virtualCameraId: value.id }, options);
}

/** Interpolates the active camera into a destination virtual camera before activating it. */
export function blendVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	const destination = find(scene, data);
	const source = scene.activeCamera;
	if (!source) throw new Error("No active camera is available to blend from.");
	apply(scene, destination);
	const destinationCamera = scene.activeCamera!;
	const start = source.position.clone(),
		end = destinationCamera.position.clone(),
		duration = Math.max(0, data.duration ?? 0.5);
	if (!duration) return activateVirtualCamera(scene, { virtualCameraId: destination.id }, options);
	scene.activeCamera = source;
	let elapsed = 0;
	const observer = scene.onBeforeRenderObservable.add(() => {
		elapsed += Math.min(scene.getEngine().getDeltaTime() / 1000, 1 / 30);
		const amount = Math.min(1, elapsed / duration);
		source.position.copyFrom(Vector3.Lerp(start, end, amount));
		if (amount >= 1) {
			scene.activeCamera = destinationCamera;
			scene.onBeforeRenderObservable.remove(observer);
		}
	});
	return { blending: true, fromCameraId: source.id, toVirtualCameraId: destination.id, duration };
}

/** Configures a persisted spline dolly for a virtual camera. */
export function setVirtualCameraDolly(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	if (data.splineId === null) {
		delete value.dolly;
		options.editor.layout.inspector.setEditedObject(scene);
		options.editor.layout.inspector.forceUpdate();
		return structuredClone(value);
	}
	const spline = resolveNode({ scene, nodeId: data.splineId }) as any;
	if (spline.metadata?.type !== "Spline") throw new Error(`Node \"${spline.name}\" is not an editor spline.`);
	if (data.t !== undefined && (!Number.isFinite(data.t) || data.t < 0 || data.t > 1)) throw new Error("Dolly t must be between 0 and 1.");
	if (data.speed !== undefined && (!Number.isFinite(data.speed) || data.speed < 0)) throw new Error("Dolly speed must be zero or greater.");
	value.dolly = {
		splineId: spline.id,
		t: data.t ?? value.dolly?.t ?? 0,
		speed: data.speed ?? value.dolly?.speed ?? 100,
		loop: data.loop ?? value.dolly?.loop ?? true,
		orientToPath: data.orientToPath ?? value.dolly?.orientToPath ?? true,
	};
	const camera = scene.cameras.find((candidate) => candidate.id === value.cameraId);
	if (camera) applyDolly(scene, camera, value.dolly);
	options.editor.layout.inspector.setEditedObject(camera ?? scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Deletes a virtual camera definition without deleting its real camera. */
export function deleteVirtualCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = find(scene, data);
	controllers(scene).splice(controllers(scene).indexOf(value), 1);
	options.editor.layout.inspector.setEditedObject(scene);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}
