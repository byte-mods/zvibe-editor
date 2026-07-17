import { IAnimatorBlendTree } from "./animator-graph";

export interface IAnimatorBlendTreeMotion {
	key: string;
	animationGroup: string;
	timeScale: number;
	cycleOffset: number;
	mirror: boolean;
}

export interface IEvaluatedAnimatorBlendTreeMotion extends IAnimatorBlendTreeMotion {
	weight: number;
}

function childWeights(tree: IAnimatorBlendTree, parameters: Record<string, string | number | boolean>): number[] {
	if (tree.blendMode === "direct") {
		const weights = tree.children.map((child) => {
			const value = child.directParameter ? parameters[child.directParameter] : 0;
			return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
		});
		if (!tree.normalizeWeights) {
			return weights;
		}
		const total = weights.reduce((sum, current) => sum + current, 0);
		return total > 0 ? weights.map((weight) => weight / total) : weights;
	}
	if (tree.parameterX && tree.parameterY) {
		const x = typeof parameters[tree.parameterX] === "number" ? (parameters[tree.parameterX] as number) : 0;
		const y = typeof parameters[tree.parameterY] === "number" ? (parameters[tree.parameterY] as number) : 0;
		const distances = tree.children.map((child) => {
			const [childX, childY] = child.position!;
			return (childX - x) ** 2 + (childY - y) ** 2;
		});
		const exact = distances.findIndex((distance) => distance === 0);
		const magnitude = Math.hypot(x, y);
		const rawWeights =
			tree.blendMode === "freeformDirectional" && exact < 0 && magnitude > 0
				? tree.children.map((child) => {
						const [childX, childY] = child.position!;
						const childMagnitude = Math.hypot(childX, childY);
						if (childMagnitude === 0) {
							return 0;
						}
						const alignment = Math.max(0, (x * childX + y * childY) / (magnitude * childMagnitude));
						return alignment / (1 + Math.abs(magnitude - childMagnitude));
					})
				: tree.blendMode === "directional" && exact < 0 && magnitude > 0
					? tree.children.map((child) => {
							const [childX, childY] = child.position!;
							const childMagnitude = Math.hypot(childX, childY);
							return childMagnitude === 0 ? 0 : Math.max(0, (x * childX + y * childY) / (magnitude * childMagnitude));
						})
					: exact >= 0
						? distances.map((_, index) => (index === exact ? 1 : 0))
						: distances.map((distance) => 1 / distance);
		const fallbackWeights = distances.map((distance) => 1 / Math.max(distance, 0.00001));
		const weights = rawWeights.reduce((sum, current) => sum + current, 0) > 0 ? rawWeights : fallbackWeights;
		const total = weights.reduce((sum, current) => sum + current, 0);
		return weights.map((value) => value / total);
	}
	const value = parameters[tree.parameter!];
	const parameter = typeof value === "number" ? value : 0;
	const indexed = tree.children.map((child, index) => ({ child, index })).sort((first, second) => first.child.threshold! - second.child.threshold!);
	const weights = tree.children.map(() => 0);
	if (parameter <= indexed[0]!.child.threshold!) {
		weights[indexed[0]!.index] = 1;
	} else if (parameter >= indexed[indexed.length - 1]!.child.threshold!) {
		weights[indexed[indexed.length - 1]!.index] = 1;
	} else {
		for (let index = 0; index < indexed.length - 1; index++) {
			const first = indexed[index]!;
			const second = indexed[index + 1]!;
			if (parameter >= first.child.threshold! && parameter <= second.child.threshold!) {
				const amount = (parameter - first.child.threshold!) / (second.child.threshold! - first.child.threshold!);
				weights[first.index] = 1 - amount;
				weights[second.index] = amount;
				break;
			}
		}
	}
	return weights;
}

/** Returns every unique Animation Group leaf in deterministic depth-first order. */
export function getAnimatorBlendTreeAnimationGroups(tree: IAnimatorBlendTree): string[] {
	return [...new Set(getAnimatorBlendTreeMotions(tree).map((motion) => motion.animationGroup))];
}

/** Returns every Blend Tree leaf with a stable recursive identity and Unity child playback modifiers. */
export function getAnimatorBlendTreeMotions(tree: IAnimatorBlendTree): IAnimatorBlendTreeMotion[] {
	const motions: IAnimatorBlendTreeMotion[] = [];
	const visit = (current: IAnimatorBlendTree, path: number[]): void => {
		current.children.forEach((child, index) => {
			const childPath = [...path, index];
			if (child.animationGroup) {
				motions.push({
					key: childPath.join("."),
					animationGroup: child.animationGroup,
					timeScale: child.timeScale ?? 1,
					cycleOffset: child.cycleOffset ?? 0,
					mirror: child.mirror ?? false,
				});
			} else if (child.blendTree) {
				visit(child.blendTree, childPath);
			}
		});
	};
	visit(tree, []);
	return motions;
}

/** Returns every numeric parameter consumed by a recursive Blend Tree. */
export function getAnimatorBlendTreeParameters(tree: IAnimatorBlendTree): string[] {
	const parameters = new Set<string>();
	const visit = (current: IAnimatorBlendTree): void => {
		if (current.parameter) {
			parameters.add(current.parameter);
		}
		if (current.parameterX) {
			parameters.add(current.parameterX);
		}
		if (current.parameterY) {
			parameters.add(current.parameterY);
		}
		current.children.forEach((child) => child.directParameter && parameters.add(child.directParameter));
		current.children.forEach((child) => child.blendTree && visit(child.blendTree));
	};
	visit(tree);
	return [...parameters];
}

/** Evaluates a recursive Blend Tree into normalized leaf Animation Group weights. */
export function evaluateAnimatorBlendTreeWeights(tree: IAnimatorBlendTree, parameters: Record<string, string | number | boolean>): Map<string, number> {
	const result = new Map<string, number>();
	for (const motion of evaluateAnimatorBlendTreeMotions(tree, parameters)) {
		result.set(motion.animationGroup, (result.get(motion.animationGroup) ?? 0) + motion.weight);
	}
	return result;
}

/** Evaluates every recursive leaf independently so duplicate clips may use different playback modifiers. */
export function evaluateAnimatorBlendTreeMotions(tree: IAnimatorBlendTree, parameters: Record<string, string | number | boolean>): IEvaluatedAnimatorBlendTreeMotion[] {
	const result: IEvaluatedAnimatorBlendTreeMotion[] = [];
	const visit = (current: IAnimatorBlendTree, parentWeight: number, path: number[]): void => {
		const weights = childWeights(current, parameters);
		current.children.forEach((child, index) => {
			const weight = parentWeight * weights[index]!;
			const childPath = [...path, index];
			if (child.animationGroup) {
				result.push({
					key: childPath.join("."),
					animationGroup: child.animationGroup,
					timeScale: child.timeScale ?? 1,
					cycleOffset: child.cycleOffset ?? 0,
					mirror: child.mirror ?? false,
					weight,
				});
			} else if (child.blendTree) {
				visit(child.blendTree, weight, childPath);
			}
		});
	};
	visit(tree, 1, []);
	return result;
}
