import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

type IParticleProximityEvent = { targetParticleSystemId: string; radius: number; count: number; cooldownMs?: number; enabled?: boolean };

/** Restores bounded CPU particle-to-particle proximity bursts in exported games. */
export function configureParticleProximityEvents(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorParticleProximityEvents as Record<string, IParticleProximityEvent[]> | undefined;
	if (!configurations) return;
	const triggers = new Map<string, number>();
	scene.onBeforeRenderObservable.add(() => {
		const now = Date.now();
		for (const source of scene.particleSystems as any[]) {
			if (source.getClassName?.() === "GPUParticleSystem") continue;
			for (const [index, event] of (configurations[source.id] ?? []).entries()) {
				if (event.enabled === false) continue;
				const target = scene.particleSystems.find((candidate) => candidate.id === event.targetParticleSystemId) as any;
				if (!target || now - (triggers.get(`${source.id}:${index}`) ?? -Infinity) < (event.cooldownMs ?? 100)) continue;
				if (
					!(source.particles ?? []).some((left: any) =>
						(target.particles ?? []).some((right: any) => Vector3.DistanceSquared(left.position, right.position) <= event.radius * event.radius)
					)
				)
					continue;
				if (!target.isStarted()) target.start();
				target.manualEmitCount = Math.max(0, target.manualEmitCount ?? 0) + event.count;
				triggers.set(`${source.id}:${index}`, now);
			}
		}
	});
}
