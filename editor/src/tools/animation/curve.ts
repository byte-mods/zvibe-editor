import { AnimationKeyInterpolation, IAnimationKey } from "babylonjs";

function cloneValue(value: any): any {
	return value?.clone?.() ?? value;
}

/** Creates a mutation-safe copy of an animation key and its value/tangent objects. */
export function cloneAnimationCurveKey(key: IAnimationKey): IAnimationKey {
	return {
		...key,
		value: cloneValue(key.value),
		...(key.inTangent !== undefined ? { inTangent: cloneValue(key.inTangent) } : {}),
		...(key.outTangent !== undefined ? { outTangent: cloneValue(key.outTangent) } : {}),
	};
}

function getTangent(before: IAnimationKey, after: IAnimationKey): any {
	const duration = after.frame - before.frame;
	if (!Number.isFinite(duration) || duration <= 0) {
		return 0;
	}
	if (typeof before.value === "number" && typeof after.value === "number") {
		return (after.value - before.value) / duration;
	}
	const beforeValues = before.value?.asArray?.();
	const afterValues = after.value?.asArray?.();
	const tangent = before.value?.clone?.();
	if (!Array.isArray(beforeValues) || !Array.isArray(afterValues) || !tangent || typeof tangent.copyFromFloats !== "function") {
		return 0;
	}
	tangent.copyFromFloats(...beforeValues.map((value: number, index: number) => (afterValues[index] - value) / duration));
	return tangent;
}

/** Calculates centered (or one-sided endpoint) tangents for every non-stepped key in one track. */
export function getAutoSmoothedAnimationKeys(keys: IAnimationKey[]): IAnimationKey[] {
	const sorted = keys.slice().sort((first, second) => first.frame - second.frame);
	return sorted.map((key, index) => {
		const clone = cloneAnimationCurveKey(key);
		if (key.interpolation === AnimationKeyInterpolation.STEP) {
			return clone;
		}
		const before = sorted[index - 1] ?? key;
		const after = sorted[index + 1] ?? key;
		const tangent = getTangent(before, after);
		clone.inTangent = cloneValue(tangent);
		clone.outTangent = cloneValue(tangent);
		return clone;
	});
}
