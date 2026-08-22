import { Scene } from "@babylonjs/core/scene";

import { configureGpuParticleCollisionEvents, IGpuParticleCollisionEventConfiguration } from "./gpu-particle-collision-events";

/** Restores persisted native GPU collision-triggered secondary-particle outputs. */
export function configureParticleCollisionEvents(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorGpuParticleCollisionEvents as Record<string, IGpuParticleCollisionEventConfiguration> | undefined;
	if (!configurations) {
		return;
	}
	for (const system of scene.particleSystems as any[]) {
		if (system.getClassName?.() === "GPUParticleSystem" && configurations[system.id]) {
			configureGpuParticleCollisionEvents(system, configurations[system.id]);
		}
	}
}
