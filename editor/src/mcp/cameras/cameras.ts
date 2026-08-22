import { Scene, Camera, Tools, UniversalCamera, Vector3 } from "babylonjs";

import { isCamera } from "../../tools/guards/nodes";
import { UniqueNumber } from "../../tools/tools";

import { addFreeCamera, addArcRotateCamera } from "../../project/add/camera";

import { IMCPActionOptions } from "../action";
import { resolveNode, toNodeSummary, toVector3 } from "../tools/resolve";

/**
 * Creates a camera in the scene reusing the editor's "add" functions where available.
 */
export function createCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	const editor = options.editor;

	let camera: Camera;
	switch (data.type) {
		case "free":
			camera = addFreeCamera(editor);
			break;
		case "arcrotate":
			camera = addArcRotateCamera(editor);
			break;
		case "universal":
			const universal = new UniversalCamera("New Universal Camera", Vector3.Zero(), scene);
			universal.position.copyFrom(editor.layout.preview.camera.position);
			universal.setTarget(editor.layout.preview.camera.getTarget());
			universal.id = Tools.RandomId();
			universal.uniqueId = UniqueNumber.Get();
			editor.layout.graph.refresh().then(() => {
				editor.layout.graph.setSelectedNode(universal);
			});
			editor.layout.inspector.setEditedObject(universal);
			editor.layout.preview.gizmo.setAttachedObject(universal);
			camera = universal;
			break;
		default:
			throw new Error(`Unknown camera type: ${data.type}`);
	}

	if (data.name) {
		camera.name = data.name;
	}

	if (data.position && (camera as any).position) {
		(camera as any).position.copyFrom(toVector3(data.position));
	}

	if (data.target && (camera as any).setTarget) {
		(camera as any).setTarget(toVector3(data.target));
	}
	if (data.options) {
		Object.assign(camera, data.options);
	}

	options.editor.layout.inspector.forceUpdate();

	return toNodeSummary(camera);
}

/**
 * Sets the scene's active camera.
 */
export function setActiveCamera(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (scene.metadata?.babylonEditorActiveCameraStack) {
		throw new Error("An active camera stack owns the ordered camera selection. Clear the active camera stack before selecting one standalone active camera.");
	}
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	if (!isCamera(node)) {
		throw new Error(`Node "${node.name}" is not a camera.`);
	}

	// Switch through the preview so the per-camera rendering configurations (post-processes) are
	// saved for the previous camera and restored for the new one.
	options.editor.layout.preview.switchToCamera(node as Camera);

	options.editor.layout.inspector.forceUpdate();

	return { activeCamera: node.name };
}

export function getCamera(scene: Scene, data: any): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isCamera(node)) {
		throw new Error(`Node "${node.name}" is not a camera.`);
	}
	const camera = node as Camera;
	return {
		...toNodeSummary(camera),
		isActive: scene.activeCamera === camera,
		position: (camera as any).position?.asArray?.() ?? null,
		target: (camera as any).getTarget?.()?.asArray?.() ?? null,
		properties: {
			fov: camera.fov,
			minZ: camera.minZ,
			maxZ: camera.maxZ,
			mode: camera.mode,
			orthoLeft: camera.orthoLeft,
			orthoRight: camera.orthoRight,
			orthoTop: camera.orthoTop,
			orthoBottom: camera.orthoBottom,
			alpha: (camera as any).alpha,
			beta: (camera as any).beta,
			radius: (camera as any).radius,
			panningSensibility: (camera as any).panningSensibility,
		},
	};
}

/** Updates camera inspector properties including projection and ArcRotate pan controls. */
export function setCameraProperties(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });
	if (!isCamera(node)) {
		throw new Error(`Node "${node.name}" is not a camera.`);
	}
	const camera = node as any;
	if (data.position && camera.position) {
		camera.position.copyFrom(toVector3(data.position));
	}
	if (data.target && camera.setTarget) {
		camera.setTarget(toVector3(data.target));
	}
	Object.assign(camera, data.properties ?? {});
	options.editor.layout.inspector.setEditedObject(camera);
	options.editor.layout.inspector.forceUpdate();
	return getCamera(scene, { nodeId: camera.id });
}
