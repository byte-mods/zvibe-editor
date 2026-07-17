import { Scene, Vector3 } from "babylonjs";
import { dirname, isAbsolute, join, relative } from "path/posix";
import { mkdir, writeFile } from "fs-extra";

import { isAbstractMesh } from "../tools/guards/nodes";
import { getBase64SceneScreenshot } from "../tools/scene/screenshot";

import { startProjectDevProcess } from "../project/run";
import { projectConfiguration } from "../project/configuration";

import { IMCPActionOptions } from "./action";
import { resolveNode } from "./tools/resolve";

/**
 * Strips the data-url prefix from a base64 data URL.
 */
function stripDataUrlPrefix(dataUrl: string): string {
	const commaIndex = dataUrl.indexOf(",");
	return commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

/**
 * Takes a screenshot of the preview for visual verification.
 */
export async function getScreenshot(scene: Scene, data: any): Promise<any> {
	const size = data.width && data.height ? { width: data.width, height: data.height } : undefined;

	const base64 = await getBase64SceneScreenshot(scene, size);
	if (!base64) {
		throw new Error("Failed to take a screenshot of the scene.");
	}

	return {
		imageBase64: stripDataUrlPrefix(base64),
		mimeType: "image/png",
	};
}

/** Captures the live editor viewport as a project PNG baseline for visual-regression comparison. */
export async function captureVisualRegressionBaseline(scene: Scene, data: any): Promise<any> {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	if (!data.path?.endsWith(".png")) throw new Error("path must be a project-relative .png file.");
	const directory = dirname(projectConfiguration.path);
	const output = isAbsolute(data.path) ? data.path : join(directory, data.path);
	if (output !== directory && !output.startsWith(`${directory}/`)) throw new Error("Baseline path must stay inside the open project.");
	const screenshot = await getScreenshot(scene, data);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, Buffer.from(screenshot.imageBase64, "base64"));
	return { captured: true, path: relative(directory, output), mimeType: screenshot.mimeType };
}

/**
 * Frames the editor camera on a node to help screenshots.
 */
export function focusNode(scene: Scene, data: any, options: IMCPActionOptions): any {
	const node = resolveNode({ scene, nodeId: data.nodeId, nodeName: data.nodeName });

	const camera = options.editor.layout.preview.camera;

	let center: Vector3;
	let radius = 100;

	if (isAbstractMesh(node)) {
		const bounds = node.getHierarchyBoundingVectors(true);
		center = bounds.max.add(bounds.min).scale(0.5);
		radius = Math.max(bounds.max.subtract(bounds.min).length() * 0.5, 10);
	} else if ((node as any).position) {
		center = (node as any).position.clone();
	} else {
		center = Vector3.Zero();
	}

	const distance = radius * 2.5;
	camera.position.copyFrom(center.add(new Vector3(distance, distance, distance)));
	camera.setTarget(center);

	return { ok: true };
}

/**
 * Starts the project dev/run process.
 */
export async function runProject(_scene: Scene, _data: any, options: IMCPActionOptions): Promise<any> {
	await startProjectDevProcess(options.editor);

	return { started: true };
}
