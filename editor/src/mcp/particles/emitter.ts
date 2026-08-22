import { Node, Scene } from "babylonjs";

export const OWNED_PARTICLE_EMITTER_METADATA_KEY = "babylonEditorOwnedParticleEmitter";

/** Disposes an editor-generated particle emitter after its last owned consumer is gone. */
export function disposeOwnedParticleEmitterIfUnused(scene: Scene, node: Node | null | undefined): boolean {
	if (!node?.metadata?.[OWNED_PARTICLE_EMITTER_METADATA_KEY]) {
		return false;
	}
	if (node.getChildren().length || scene.particleSystems.some((system) => system.emitter === node)) {
		return false;
	}
	node.dispose(false, false);
	return true;
}
