export interface IRenderingVolumeBlendDefinition {
	center: number[];
	size: number[];
	priority: number;
	blendDistance?: number;
	weight?: number;
}

export interface IRenderingVolumeContribution<TVolume extends IRenderingVolumeBlendDefinition = IRenderingVolumeBlendDefinition> {
	volume: TVolume;
	blendFactor: number;
}

function cloneValue<T>(value: T): T {
	return value === undefined ? value : structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Returns an AABB volume's weighted influence at a world-space point. */
export function getRenderingVolumeBlendFactor(volume: IRenderingVolumeBlendDefinition, position: number[]): number {
	const distanceSquared = volume.center.reduce((sum, center, axis) => {
		const distanceOutside = Math.max(Math.abs(position[axis] - center) - volume.size[axis] / 2, 0);
		return sum + distanceOutside * distanceOutside;
	}, 0);
	const distance = Math.sqrt(distanceSquared);
	const blendDistance = volume.blendDistance ?? 0;
	const falloff = distance === 0 ? 1 : blendDistance > 0 ? Math.max(0, 1 - distance / blendDistance) : 0;
	return falloff * (volume.weight ?? 1);
}

/** Sorts all rendering volumes influencing a point from low to high priority. */
export function getRenderingVolumeContributions<TVolume extends IRenderingVolumeBlendDefinition>(volumes: TVolume[], position: number[]): IRenderingVolumeContribution<TVolume>[] {
	return volumes
		.map((volume, index) => ({ volume, blendFactor: getRenderingVolumeBlendFactor(volume, position), index }))
		.filter((entry) => entry.blendFactor > 0)
		.sort((first, second) => first.volume.priority - second.volume.priority || first.index - second.index)
		.map(({ volume, blendFactor }) => ({ volume, blendFactor }));
}

/** Recursively interpolates numeric rendering settings and selects discrete settings at the midpoint. */
export function blendRenderingConfiguration<T>(baseline: T, override: T, factor: number): T {
	const amount = Math.max(0, Math.min(1, factor));
	if (typeof baseline === "number" && typeof override === "number" && Number.isFinite(baseline) && Number.isFinite(override)) {
		return (baseline + (override - baseline) * amount) as T;
	}
	if (
		Array.isArray(baseline) &&
		Array.isArray(override) &&
		baseline.length === override.length &&
		baseline.every((value) => typeof value === "number" && Number.isFinite(value)) &&
		override.every((value) => typeof value === "number" && Number.isFinite(value))
	) {
		return baseline.map((value, index) => value + (override[index] - value) * amount) as T;
	}
	if (isRecord(baseline) && isRecord(override)) {
		const result: Record<string, unknown> = {};
		for (const key of new Set([...Object.keys(baseline), ...Object.keys(override)])) {
			if (!(key in override)) result[key] = cloneValue(baseline[key]);
			else if (!(key in baseline)) result[key] = amount >= 0.5 ? cloneValue(override[key]) : undefined;
			else result[key] = blendRenderingConfiguration(baseline[key], override[key], amount);
		}
		return result as T;
	}
	return cloneValue(amount >= 0.5 ? override : baseline);
}
