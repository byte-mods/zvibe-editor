import { writeFile } from "fs-extra";

import { Scene, ISize } from "babylonjs";

import { saveSingleFileDialog } from "../dialog";

/**
 * Takes a screenshot of the scene and returns its base64 value.
 * @param scene defines the reference to the scene to take a screenshot.
 * @param size defines the optional size of the screenshot. If not provided, the current canvas size will be used.
 */
export function getBase64SceneScreenshot(scene: Scene, size?: ISize): Promise<string | undefined> {
	return new Promise<string | undefined>((resolve) => {
		let completed = false;
		let animationFrame = 0;
		let timeout = 0;
		const finish = (): void => {
			if (completed) {
				return;
			}
			completed = true;
			if (animationFrame && typeof cancelAnimationFrame === "function") {
				cancelAnimationFrame(animationFrame);
			}
			clearTimeout(timeout);
			const source = scene.getEngine().getRenderingCanvas();
			if (!source) {
				resolve(undefined);
				return;
			}
			if (!size || (source.width === size.width && source.height === size.height)) {
				resolve(source.toDataURL("image/png"));
				return;
			}
			const output = document.createElement("canvas");
			output.width = size.width;
			output.height = size.height;
			const context = output.getContext("2d");
			if (!context) {
				resolve(undefined);
				return;
			}
			context.drawImage(source, 0, 0, output.width, output.height);
			resolve(output.toDataURL("image/png"));
		};
		scene.onAfterRenderObservable.addOnce(() => finish());
		if (completed) {
			return;
		}
		// The authoring scene does not render while Play mode owns the canvas. A
		// browser frame therefore provides the authoritative fallback instead of
		// waiting forever for this scene's onAfterRenderObservable.
		if (typeof requestAnimationFrame === "function") {
			animationFrame = requestAnimationFrame(() => finish());
		}
		timeout = setTimeout(() => finish(), 1_000) as unknown as number;
	});
}

/**
 * Takes a screenshot of the scene and returns its buffer value.
 * @param scene defines the reference to the scene to take a screenshot.
 * @param size defines the optional size of the screenshot. If not provided, the current canvas size will be used.
 */
export async function getBufferSceneScreenshot(scene: Scene, size?: ISize) {
	const base64 = await getBase64SceneScreenshot(scene, size);
	if (!base64) {
		return null;
	}

	return Buffer.from(base64?.split(",")[1], "base64");
}

/**
 * Takes a screenshot of the scene and asks the user to save the generate PNG file.
 * @param scene defines the reference to the scene to take a screenshot.
 * @param size defines the optional size of the screenshot. If not provided, the current canvas size will be used.
 */
export async function saveSceneScreenshot(scene: Scene, size?: ISize) {
	const buffer = await getBufferSceneScreenshot(scene, size);
	if (!buffer) {
		return;
	}

	const filepath = saveSingleFileDialog({
		title: "Save scene screenshot",
		filters: [{ name: "PNG Image", extensions: ["png"] }],
	});

	if (filepath) {
		await writeFile(filepath, buffer);
	}
}
