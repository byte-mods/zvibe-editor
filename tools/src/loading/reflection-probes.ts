import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import type { Scene } from "@babylonjs/core/scene";

export const reflectionProbeMetadataKey = "babylonEditorReflectionProbe";
export const reflectionProbeBlendModel = "unity-priority-box-blend-skybox-v1";

export interface IReflectionProbeRuntimeMetadata {
	version?: number;
	id?: string;
	revision?: number;
	intensity?: number;
	boxProjection?: boolean;
	influencePosition?: [number, number, number];
	influenceSize?: [number, number, number];
	importance?: number;
	blendDistance?: number;
	assignedMaterialIds?: string[];
}

function validVector(value: unknown, positive: boolean): value is [number, number, number] {
	return Array.isArray(value) && value.length === 3 && value.every((component) => Number.isFinite(component) && (!positive || component > 0));
}

/** Returns the Unity-style box influence weight: zero outside, one past the inner blend boundary, and a linear edge fade in between. */
export function getReflectionProbeInfluenceWeight(
	position: [number, number, number],
	influencePosition: [number, number, number],
	influenceSize: [number, number, number],
	blendDistance: number
): number {
	const halfSize = influenceSize.map((value) => value * 0.5);
	const edgeDistance = Math.min(...position.map((value, axis) => halfSize[axis] - Math.abs(value - influencePosition[axis])));
	if (edgeDistance < 0) {
		return 0;
	}
	return blendDistance <= 0 ? 1 : Math.max(0, Math.min(1, edgeDistance / blendDistance));
}

/** Validates the authored fade against the influence box so every axis retains a non-negative inner volume. */
export function validateReflectionProbeBlendDistance(influenceSize: [number, number, number], blendDistance: number): void {
	if (!Number.isFinite(blendDistance) || blendDistance < 0 || blendDistance > Math.min(...influenceSize) * 0.5) {
		throw new Error("Reflection-probe blendDistance must be finite, non-negative, and no greater than half the smallest influenceSize component.");
	}
}

/** Restores serialized Unity-style reflection-probe influence bounds to Babylon cube textures. */
export function configureReflectionProbes(scene: Scene): number {
	const probes = (scene as Scene & { reflectionProbes?: ReflectionProbe[] }).reflectionProbes ?? [];
	let configured = 0;
	for (const probe of probes) {
		const metadata = probe.metadata?.[reflectionProbeMetadataKey] as IReflectionProbeRuntimeMetadata | undefined;
		if (!metadata) {
			continue;
		}
		const influenceSize = validVector(metadata.influenceSize, true) ? metadata.influenceSize : ([1000, 1000, 1000] as [number, number, number]);
		validateReflectionProbeBlendDistance(influenceSize, Number.isFinite(metadata.blendDistance) ? metadata.blendDistance! : Math.min(100, Math.min(...influenceSize) * 0.5));
		if (metadata.boxProjection) {
			const position = validVector(metadata.influencePosition, false) ? metadata.influencePosition : (probe.position.asArray() as [number, number, number]);
			probe.cubeTexture.boundingBoxPosition = Vector3.FromArray(position);
			probe.cubeTexture.boundingBoxSize = Vector3.FromArray(influenceSize);
		} else {
			(probe.cubeTexture as unknown as { boundingBoxPosition: Vector3 | null }).boundingBoxPosition = null;
			(probe.cubeTexture as unknown as { boundingBoxSize: Vector3 | null }).boundingBoxSize = null;
		}
		configured++;
	}
	return configured;
}
