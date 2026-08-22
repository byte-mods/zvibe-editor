import { Scene } from "@babylonjs/core/scene";

import { configureGpuParticleInteractions, IGpuParticleInteractionConfiguration } from "./gpu-particle-interactions";

/** Restores persisted bounded pairwise particle interactions on WebGPU systems. */
export function configureParticleInteractions(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorGpuParticleInteractions as Record<string, IGpuParticleInteractionConfiguration> | undefined;
	if (!configurations) {
		return;
	}
	for (const system of scene.particleSystems as any[]) {
		if (system.getClassName?.() === "GPUParticleSystem" && configurations[system.id]) {
			configureGpuParticleInteractions(system, configurations[system.id]);
		}
	}
}
