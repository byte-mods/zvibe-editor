import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

type ICollisionPlane = { position: number[]; normal: number[]; restitution: number };
type ICollisionSphere = { center: number[]; radius: number; restitution: number };

/** Restores persisted CPU particle collision planes. GPU particle systems are intentionally excluded. */
export function configureParticleCollisions(scene: Scene): void {
	const configurations = scene.metadata?.babylonEditorParticleCollisionPlanes as Record<string, ICollisionPlane[]> | undefined;
	const sphereConfigurations = scene.metadata?.babylonEditorParticleCollisionSpheres as Record<string, ICollisionSphere[]> | undefined;
	if (!configurations && !sphereConfigurations) return;
	scene.onBeforeRenderObservable.add(() => {
		for (const system of scene.particleSystems as any[]) {
			if (system.getClassName?.() === "GPUParticleSystem") continue;
			for (const plane of configurations?.[system.id] ?? []) {
				const normal = Vector3.FromArray(plane.normal).normalize();
				const origin = Vector3.FromArray(plane.position);
				for (const particle of system.particles ?? []) {
					const position = particle.position as Vector3;
					const direction = particle.direction as Vector3;
					if (!position || !direction) continue;
					const signedDistance = Vector3.Dot(position.subtract(origin), normal);
					const speedTowardPlane = Vector3.Dot(direction, normal);
					if (signedDistance >= 0 || speedTowardPlane >= 0) continue;
					position.subtractInPlace(normal.scale(signedDistance));
					direction.subtractInPlace(normal.scale((1 + plane.restitution) * speedTowardPlane));
				}
			}
			for (const sphere of sphereConfigurations?.[system.id] ?? [])
				for (const particle of system.particles ?? []) {
					const position = particle.position as Vector3;
					const direction = particle.direction as Vector3;
					if (!position || !direction) continue;
					const delta = position.subtract(Vector3.FromArray(sphere.center));
					const distance = delta.length();
					if (distance >= sphere.radius) continue;
					const normal = distance > 0.000001 ? delta.scale(1 / distance) : Vector3.Up();
					position.copyFrom(Vector3.FromArray(sphere.center).add(normal.scale(sphere.radius)));
					const velocity = Vector3.Dot(direction, normal);
					if (velocity < 0) direction.subtractInPlace(normal.scale((1 + sphere.restitution) * velocity));
				}
		}
	});
}
