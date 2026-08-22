import { Scene } from "@babylonjs/core/scene";

type IParticleEvent = { name: string; count: number; enabled?: boolean };

function configurations(scene: Scene): Record<string, IParticleEvent[]> {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorParticleEvents ??= {});
}

/** Fires a persisted named CPU/GPU particle burst event and returns its emitted particle count. */
export function triggerParticleEvent(
	scene: Scene,
	eventName: string,
	particleSystemId?: string
): { triggered: { particleSystemId: string; particleSystemName: string; count: number }[]; totalCount: number } {
	const triggered: { particleSystemId: string; particleSystemName: string; count: number }[] = [];
	for (const system of scene.particleSystems as any[]) {
		if (particleSystemId && system.id !== particleSystemId) {
			continue;
		}
		const event = (configurations(scene)[system.id] ?? []).find((candidate) => candidate.name === eventName);
		if (!event || event.enabled === false) {
			continue;
		}
		if (!system.isStarted()) {
			system.start();
		}
		system.manualEmitCount = Math.max(0, system.manualEmitCount ?? 0) + event.count;
		triggered.push({ particleSystemId: system.id, particleSystemName: system.name, count: event.count });
	}
	return { triggered, totalCount: triggered.reduce((total, event) => total + event.count, 0) };
}
