import { Scene, Vector3 } from "babylonjs";

import { IMCPActionOptions } from "../action";

type ICollisionPlane = { position: number[]; normal: number[]; restitution: number };
type ICollisionSphere = { center: number[]; radius: number; restitution: number };
const configuredScenes = new WeakSet<Scene>();

function configurations(scene: Scene): Record<string, ICollisionPlane[]> {
	scene.metadata ??= {};
	scene.metadata.babylonEditorParticleCollisionPlanes ??= {};
	return scene.metadata.babylonEditorParticleCollisionPlanes;
}
function sphereConfigurations(scene: Scene): Record<string, ICollisionSphere[]> {
	scene.metadata ??= {};
	scene.metadata.babylonEditorParticleCollisionSpheres ??= {};
	return scene.metadata.babylonEditorParticleCollisionSpheres;
}

function resolve(scene: Scene, data: any): any {
	const system = scene.particleSystems.find((candidate) => candidate.id === data.particleSystemId || candidate.name === data.particleSystemName) as any;
	if (!system) throw new Error("Particle system not found. Provide particleSystemId (preferred) or particleSystemName.");
	if (system.getClassName() === "GPUParticleSystem") throw new Error("Particle collision planes currently support CPU particle systems only.");
	return system;
}

function apply(system: any, planes: ICollisionPlane[], spheres: ICollisionSphere[] = []): void {
	for (const particle of system.particles ?? []) {
		const position = particle.position as Vector3;
		const direction = particle.direction as Vector3;
		if (!position || !direction) continue;
		for (const plane of planes) {
			const normal = Vector3.FromArray(plane.normal).normalize();
			const signedDistance = Vector3.Dot(position.subtract(Vector3.FromArray(plane.position)), normal);
			const speedTowardPlane = Vector3.Dot(direction, normal);
			if (signedDistance >= 0 || speedTowardPlane >= 0) continue;
			position.subtractInPlace(normal.scale(signedDistance));
			direction.subtractInPlace(normal.scale((1 + plane.restitution) * speedTowardPlane));
		}
		for (const sphere of spheres) {
			const delta = position.subtract(Vector3.FromArray(sphere.center));
			const distance = delta.length();
			if (distance >= sphere.radius) continue;
			const normal = distance > 0.000001 ? delta.scale(1 / distance) : Vector3.Up();
			position.copyFrom(Vector3.FromArray(sphere.center).add(normal.scale(sphere.radius)));
			const velocity = Vector3.Dot(direction, normal);
			if (velocity < 0) direction.subtractInPlace(normal.scale((1 + sphere.restitution) * velocity));
		}
	}
}

function configure(scene: Scene): void {
	if (configuredScenes.has(scene)) return;
	configuredScenes.add(scene);
	scene.onBeforeRenderObservable.add(() => {
		for (const system of scene.particleSystems as any[]) {
			const planes = configurations(scene)[system.id] ?? [];
			const spheres = sphereConfigurations(scene)[system.id] ?? [];
			if (planes.length || spheres.length) apply(system, planes, spheres);
		}
	});
}

export function getParticleCollisionSpheres(scene: Scene, data: any): any {
	const system = resolve(scene, data);
	return { particleSystemId: system.id, particleSystemName: system.name, spheres: structuredClone(sphereConfigurations(scene)[system.id] ?? []) };
}
export function setParticleCollisionSpheres(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolve(scene, data);
	const spheres = data.spheres ?? [];
	if (!Array.isArray(spheres) || spheres.length > 8) throw new Error("Particle collision spheres must contain from zero to eight spheres.");
	for (const [index, sphere] of spheres.entries()) {
		if (!Array.isArray(sphere.center) || sphere.center.length !== 3 || sphere.center.some((value: any) => !Number.isFinite(value)))
			throw new Error(`Collision sphere ${index} center must be three finite numbers.`);
		if (!(sphere.radius > 0) || !Number.isFinite(sphere.radius)) throw new Error(`Collision sphere ${index} radius must be greater than zero.`);
		if (!Number.isFinite(sphere.restitution) || sphere.restitution < 0 || sphere.restitution > 1)
			throw new Error(`Collision sphere ${index} restitution must be between 0 and 1.`);
	}
	sphereConfigurations(scene)[system.id] = spheres.map((sphere: ICollisionSphere) => ({ center: [...sphere.center], radius: sphere.radius, restitution: sphere.restitution }));
	configure(scene);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleCollisionSpheres(scene, { particleSystemId: system.id });
}

/** Lists persisted CPU particle collision planes. */
export function getParticleCollisionPlanes(scene: Scene, data: any): any {
	const system = resolve(scene, data);
	return { particleSystemId: system.id, particleSystemName: system.name, planes: structuredClone(configurations(scene)[system.id] ?? []) };
}

/** Replaces persisted CPU particle collision planes used for bounce/reflection. */
export function setParticleCollisionPlanes(scene: Scene, data: any, options: IMCPActionOptions): any {
	const system = resolve(scene, data);
	const planes = data.planes ?? [];
	if (!Array.isArray(planes) || planes.length > 8) throw new Error("Particle collision planes must contain from zero to eight planes.");
	for (const [index, plane] of planes.entries()) {
		if (!Array.isArray(plane.position) || plane.position.length !== 3 || plane.position.some((value: any) => !Number.isFinite(value)))
			throw new Error(`Collision plane ${index} position must be three finite numbers.`);
		if (
			!Array.isArray(plane.normal) ||
			plane.normal.length !== 3 ||
			plane.normal.some((value: any) => !Number.isFinite(value)) ||
			!Vector3.FromArray(plane.normal).lengthSquared()
		)
			throw new Error(`Collision plane ${index} normal must be a non-zero finite vector.`);
		if (!Number.isFinite(plane.restitution) || plane.restitution < 0 || plane.restitution > 1) throw new Error(`Collision plane ${index} restitution must be between 0 and 1.`);
	}
	configurations(scene)[system.id] = planes.map((plane: ICollisionPlane) => ({
		position: [...plane.position],
		normal: Vector3.FromArray(plane.normal).normalize().asArray(),
		restitution: plane.restitution,
	}));
	configure(scene);
	options.editor.layout.inspector.setEditedObject(system);
	options.editor.layout.inspector.forceUpdate();
	return getParticleCollisionPlanes(scene, { particleSystemId: system.id });
}
