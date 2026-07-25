import { join } from "path/posix";
import { readJSON } from "fs-extra";

import { Scene, AnimationGroup } from "babylonjs";

import { Editor } from "../../../editor/main";

import { ISceneLoaderPluginOptions } from "../scene";
import { findSceneLoadResultNodeById } from "../result";

export async function loadAnimationGroups(editor: Editor, animationGroupFiles: string[], scene: Scene, options: ISceneLoaderPluginOptions) {
	const loadedAnimationGroups = await Promise.all(
		animationGroupFiles.map(async (file) => {
			if (file.startsWith(".")) {
				return;
			}

			try {
				const data = await readJSON(join(options.scenePath, "animationGroups", file), "utf-8");

				const animationGroup = AnimationGroup.Parse(data, scene, (targetedAnimation) => {
					if (targetedAnimation.animation.property === "influence") {
						for (const manager of options.loadResult.morphTargetManagers) {
							for (let index = 0; index < manager.numTargets; index++) {
								const target = manager.getTarget(index);
								if (target.id === targetedAnimation.targetId) {
									return target;
								}
							}
						}
						return null;
					}
					return findSceneLoadResultNodeById(options.loadResult, targetedAnimation.targetId);
				});
				animationGroup.uniqueId = data.uniqueId;

				if (animationGroup.targetedAnimations.length === 0) {
					animationGroup.dispose();
				} else {
					options.loadResult.animationGroups.push(animationGroup);
					return animationGroup;
				}
			} catch (e) {
				editor.layout.console.error(`Failed to load animation group file "${file}": ${e.message}`);
			}

			options.progress.step(options.progressStep);
		})
	);

	// Re-add lights to keep correct order
	loadedAnimationGroups.forEach((animationGroup) => {
		if (animationGroup) {
			scene.removeAnimationGroup(animationGroup);
			scene.addAnimationGroup(animationGroup);
		}
	});
}
