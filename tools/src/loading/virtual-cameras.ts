import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

type IVirtualCameraDolly = { splineId: string; t: number; speed: number; loop: boolean; orientToPath: boolean };
type ITargetGroup = { id: string; members: Array<{ nodeId: string; weight: number }> };
type IVirtualCamera = {
	id: string;
	cameraId: string;
	followNodeId?: string;
	lookAtNodeId?: string;
	followTargetGroupId?: string;
	lookAtTargetGroupId?: string;
	offset: number[];
	priority: number;
	dolly?: IVirtualCameraDolly;
};

function getTargetGroupPosition(scene: Scene, groupId: string): Vector3 | null {
	const groups = scene.metadata?.babylonEditorCameraTargetGroups as ITargetGroup[] | undefined;
	const group = groups?.find((candidate) => candidate.id === groupId);
	if (!group) return null;
	let totalWeight = 0;
	const position = Vector3.Zero();
	for (const member of group.members) {
		const node = scene.getNodeById(member.nodeId) as any;
		if (!node?.getAbsolutePosition) continue;
		node.computeWorldMatrix?.(true);
		position.addInPlace(node.getAbsolutePosition().scale(member.weight));
		totalWeight += member.weight;
	}
	return totalWeight ? position.scale(1 / totalWeight) : null;
}

function applyDolly(scene: Scene, camera: any, dolly: IVirtualCameraDolly, elapsedSeconds: number): void {
	const spline = scene.getNodeById(dolly.splineId) as any;
	const sourcePoints = spline?.metadata?.points;
	if (!Array.isArray(sourcePoints) || sourcePoints.length < 2) return;
	const points = sourcePoints.map((point: number[]) => Vector3.FromArray(point));
	if (spline.metadata?.closed) points.push(points[0].clone());
	const lengths = points.slice(0, -1).map((point: Vector3, index: number) => Vector3.Distance(point, points[index + 1]));
	const length = lengths.reduce((total: number, segment: number) => total + segment, 0);
	if (!length) return;
	dolly.t = dolly.loop ? (dolly.t + (dolly.speed * elapsedSeconds) / length) % 1 : Math.min(1, dolly.t + (dolly.speed * elapsedSeconds) / length);
	let remaining = Math.min(1, Math.max(0, dolly.t)) * length;
	for (let index = 0; index < lengths.length; index++) {
		if (remaining <= lengths[index] || index === lengths.length - 1) {
			const amount = lengths[index] ? remaining / lengths[index] : 0;
			const position = Vector3.TransformCoordinates(Vector3.Lerp(points[index], points[index + 1], amount), spline.getWorldMatrix());
			camera.position.copyFrom(position);
			if (dolly.orientToPath)
				camera.setTarget?.(position.add(Vector3.TransformNormal(points[index + 1].subtract(points[index]).normalize(), spline.getWorldMatrix()).normalize()));
			return;
		}
		remaining -= lengths[index];
	}
}

/** Restores the active persisted virtual camera and evaluates its follow/look-at/dolly state every frame. */
export function configureVirtualCameras(scene: Scene): void {
	const cameras = scene.metadata?.babylonEditorVirtualCameras as IVirtualCamera[] | undefined;
	if (!cameras?.length) return;
	const activeId = scene.metadata?.babylonEditorActiveVirtualCameraId;
	const value = cameras.find((camera) => camera.id === activeId) ?? [...cameras].sort((a, b) => b.priority - a.priority)[0];
	const camera = scene.getCameraById(value.cameraId) as any;
	if (!camera) return;
	scene.activeCamera = camera;
	scene.onBeforeRenderObservable.add(() => {
		if (value.dolly) applyDolly(scene, camera, value.dolly, scene.getEngine().getDeltaTime() / 1000);
		if (value.followTargetGroupId) {
			const position = getTargetGroupPosition(scene, value.followTargetGroupId);
			if (position) camera.position.copyFrom(position.add(Vector3.FromArray(value.offset)));
		}
		if (value.followNodeId) {
			const follow = scene.getNodeById(value.followNodeId) as any;
			if (follow?.getAbsolutePosition) camera.position.copyFrom(follow.getAbsolutePosition().add(Vector3.FromArray(value.offset)));
		}
		if (value.lookAtTargetGroupId) {
			const position = getTargetGroupPosition(scene, value.lookAtTargetGroupId);
			if (position) camera.setTarget?.(position);
		}
		if (value.lookAtNodeId) {
			const target = scene.getNodeById(value.lookAtNodeId) as any;
			if (target?.getAbsolutePosition) camera.setTarget?.(target.getAbsolutePosition());
		}
	});
}
