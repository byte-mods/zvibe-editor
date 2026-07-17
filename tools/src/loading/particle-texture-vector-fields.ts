import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

type ITextureVectorField = { min: number[]; max: number[]; strength: number; width: number; height: number; depth?: number; vectors: number[]; enabled?: boolean };

/** Restores persistent image-sampled 2D XZ vector fields for CPU particle systems in exported games. */
export function configureParticleTextureVectorFields(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorParticleTextureVectorFields as Record<string, ITextureVectorField[]> | undefined;
	if (!configurations) return;
	scene.onBeforeRenderObservable.add(() => {
		const deltaSeconds = scene.getEngine().getDeltaTime() / 1000;
		if (!deltaSeconds) return;
		for (const system of scene.particleSystems as any[]) {
			if (system.getClassName?.() === "GPUParticleSystem") continue;
			for (const field of configurations[system.id] ?? []) {
				if (field.enabled === false) continue;
				const min = Vector3.FromArray(field.min),
					max = Vector3.FromArray(field.max);
				for (const particle of system.particles ?? []) {
					const position = particle.position as Vector3,
						direction = particle.direction as Vector3;
					if (!position || !direction || position.x < min.x || position.x > max.x || position.y < min.y || position.y > max.y || position.z < min.z || position.z > max.z)
						continue;
					const x = Math.min(field.width - 1, Math.max(0, Math.round(((position.x - min.x) / (max.x - min.x)) * (field.width - 1))));
					const y = Math.min(field.height - 1, Math.max(0, Math.round(((position.y - min.y) / (max.y - min.y)) * (field.height - 1))));
					const z = Math.min((field.depth ?? 1) - 1, Math.max(0, Math.round(((position.z - min.z) / (max.z - min.z)) * ((field.depth ?? 1) - 1))));
					const offset = ((z * field.height + y) * field.width + x) * 3;
					direction.addInPlace(new Vector3(field.vectors[offset], field.vectors[offset + 1], field.vectors[offset + 2]).scale(field.strength * deltaSeconds));
				}
			}
		}
	});
}
