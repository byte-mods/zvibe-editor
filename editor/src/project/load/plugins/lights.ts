import { join } from "path/posix";
import { readSerializedJSON as readJSON } from "../../serialization-session";

import { Scene, Light, Texture } from "babylonjs";
import { configureAreaLights, getLightCookieMetadata, setLightCookie } from "babylonjs-editor-tools";

import { Editor } from "../../../editor/main";

import { ISceneLoaderPluginOptions } from "../scene";

export async function loadLights(editor: Editor, lightsFiles: string[], scene: Scene, options: ISceneLoaderPluginOptions) {
	const loadedLights = await Promise.all(
		lightsFiles.map(async (file) => {
			if (file.startsWith(".")) {
				return;
			}

			try {
				const data = await readJSON(join(options.scenePath, "lights", file), "utf-8");

				if (options?.asLink && data.metadata?.doNotSerialize) {
					return;
				}

				const light = Light.Parse(data, scene);
				if (light) {
					configureAreaLights(scene as any, [light as any]);
					const cookie = getLightCookieMetadata(light as any);
					if (cookie?.texture) {
						const texture = Texture.Parse(structuredClone(cookie.texture), scene, join(options.projectPath, "/"));
						if (texture) {
							setLightCookie(light as any, texture as any, { ...cookie, revision: cookie.revision });
						}
					}
					light.uniqueId = data.uniqueId;
					light.metadata ??= {};
					light.metadata._waitingParentId = data.metadata?.parentId;

					options.loadResult.lights.push(light);

					return light;
				}
			} catch (e) {
				editor.layout.console.error(`Failed to load light file "${file}": ${e.message}`);
			}

			options.progress.step(options.progressStep);
		})
	);

	// Re-add lights to keep correct order
	loadedLights.forEach((light) => {
		if (light) {
			scene.removeLight(light);
			scene.addLight(light);
		}
	});
}
