import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

type IVectorField = { min: number[]; max: number[]; direction: number[]; strength: number; enabled?: boolean };

/** Restores bounded directional CPU-particle vector fields from exported scene metadata. */
export function configureParticleVectorFields(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorParticleVectorFields as Record<string, IVectorField[]> | undefined;
	if (!configurations) {
		return;
	}
	scene.onBeforeRenderObservable.add(() => {
		const deltaSeconds = scene.getEngine().getDeltaTime() / 1000;
		if (!deltaSeconds) {
			return;
		}
		for (const system of scene.particleSystems as any[]) {
			if (system.getClassName?.() === "GPUParticleSystem") {
				continue;
			}
			for (const field of configurations[system.id] ?? []) {
				if (field.enabled === false) {
					continue;
				}
				const min = Vector3.FromArray(field.min),
					max = Vector3.FromArray(field.max),
					force = Vector3.FromArray(field.direction).scale(field.strength * deltaSeconds);
				for (const particle of system.particles ?? []) {
					const position = particle.position as Vector3,
						direction = particle.direction as Vector3;
					if (
						position &&
						direction &&
						position.x >= min.x &&
						position.y >= min.y &&
						position.z >= min.z &&
						position.x <= max.x &&
						position.y <= max.y &&
						position.z <= max.z
					) {
						direction.addInPlace(force);
					}
				}
			}
		}
	});
}
