import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

export interface IPhysicsEditorTarget {
	scene: Scene;
	target: "editor" | "play";
	play: any | null;
}

/** Resolves the exact live scene owned by editor tooling without treating an unready Play scene as usable. */
export function resolvePhysicsEditorTarget(scene: Scene, options?: IMCPActionOptions): IPhysicsEditorTarget {
	const play = options?.editor.layout.preview?.play;
	if (play?.canPlayScene && play.scene && !play.scene.isDisposed) {
		return { scene: play.scene, target: "play", play };
	}
	return { scene, target: "editor", play: null };
}
