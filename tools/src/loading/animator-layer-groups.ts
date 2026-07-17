import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";

import { HumanBone, IHumanoidAvatar } from "../assets/humanoid-avatar";
import { IAnimatorBlendTreeMotion } from "./animator-blend-tree";

export type AnimatorLayerBlendingMode = "override" | "additive";

export interface IAnimatorLayerReferencePose {
	/**
	 * Normalized frame inside each layer clip used as the zero-delta pose.
	 * This mirrors Unity's reference-pose-frame behavior for additive clips.
	 */
	normalizedTime: number;
}

function oppositeRole(role: HumanBone): HumanBone | null {
	if (role.startsWith("left")) {
		return `right${role.slice(4)}` as HumanBone;
	}
	if (role.startsWith("right")) {
		return `left${role.slice(5)}` as HumanBone;
	}
	return null;
}

function mirroredTarget(scene: Scene, target: any): any {
	const targetName = typeof target?.name === "string" ? target.name : null;
	if (!targetName) {
		return target;
	}
	const avatars = (scene.metadata?.babylonEditorHumanoidAvatars ?? []) as IHumanoidAvatar[];
	for (const avatar of avatars) {
		const entry = Object.entries(avatar.mapping).find(([, boneName]) => boneName === targetName) as [HumanBone, string] | undefined;
		const opposite = entry ? oppositeRole(entry[0]) : null;
		const oppositeName = opposite ? avatar.mapping[opposite] : null;
		if (!oppositeName) {
			continue;
		}
		if (typeof target.getSkeleton === "function") {
			return target.getSkeleton()?.bones.find((bone: any) => bone.name === oppositeName) ?? target;
		}
		return scene.getNodeByName(oppositeName) ?? target;
	}
	return target;
}

function mirroredValue(property: string, value: any): any {
	if (value instanceof Matrix) {
		const reflection = Matrix.Scaling(-1, 1, 1);
		return reflection.multiply(value).multiply(reflection);
	}
	if (value instanceof Quaternion) {
		return new Quaternion(value.x, -value.y, -value.z, value.w);
	}
	if (value instanceof Vector3) {
		if (property === "position" || property.endsWith(".position")) {
			return new Vector3(-value.x, value.y, value.z);
		}
		if (property === "rotation" || property.endsWith(".rotation")) {
			return new Vector3(value.x, -value.y, -value.z);
		}
		return value.clone();
	}
	if (typeof value === "number") {
		if (
			property.endsWith("position.x") ||
			property.endsWith("rotation.y") ||
			property.endsWith("rotation.z") ||
			property.endsWith("rotationQuaternion.y") ||
			property.endsWith("rotationQuaternion.z")
		) {
			return -value;
		}
	}
	return value?.clone?.() ?? value;
}

function mirrorAnimationGroup(scene: Scene, group: AnimationGroup): void {
	for (const targeted of group.targetedAnimations) {
		targeted.target = mirroredTarget(scene, targeted.target);
		const animation = targeted.animation;
		animation.setKeys(
			animation.getKeys().map((key: any) => ({
				...key,
				value: mirroredValue(animation.targetProperty, key.value),
				...(key.inTangent !== undefined ? { inTangent: mirroredValue(animation.targetProperty, key.inTangent) } : {}),
				...(key.outTangent !== undefined ? { outTangent: mirroredValue(animation.targetProperty, key.outTangent) } : {}),
			}))
		);
	}
}

/**
 * Owns non-serialized additive Animation Group clones used by Animator layers.
 * Clones are removed from the Scene collection immediately so editor saves and
 * exports retain only authored Animation Groups.
 */
export class AnimatorLayerAnimationGroups {
	private _runtimeGroups = new Map<string, AnimationGroup>();

	public constructor(private _scene: Scene) {}

	public resolve(
		layerKey: string,
		animationGroupName: string,
		blendingMode: AnimatorLayerBlendingMode = "override",
		referencePose: IAnimatorLayerReferencePose = { normalizedTime: 0 },
		motion?: IAnimatorBlendTreeMotion
	): AnimationGroup | null {
		const source = this._scene.getAnimationGroupByName(animationGroupName);
		if (!source || (blendingMode !== "additive" && !motion)) {
			return source;
		}
		const normalizedTime = Math.min(1, Math.max(0, referencePose.normalizedTime));
		const key = `${layerKey}:${source.uniqueId}:${normalizedTime}:${motion?.key ?? "state"}:${motion?.mirror === true}`;
		const existing = this._runtimeGroups.get(key);
		if (existing) {
			return existing;
		}
		const cloneName = motion ? `__babylonEditorAnimatorMotion:${layerKey}:${source.uniqueId}:${motion.key}` : `__babylonEditorAnimatorAdditive:${layerKey}:${source.uniqueId}`;
		const clone = source.clone(cloneName, undefined, true, true);
		if (motion?.mirror) {
			mirrorAnimationGroup(this._scene, clone);
		}
		if (blendingMode === "additive") {
			AnimationGroup.MakeAnimationAdditive(clone, {
				referenceFrame: source.from + (source.to - source.from) * normalizedTime,
				cloneOriginalAnimationGroup: false,
			});
		}
		clone.metadata = {
			...(clone.metadata ?? {}),
			babylonEditorInternalAnimatorLayer: true,
			babylonEditorInternalAnimatorMotion: !!motion,
			sourceAnimationGroup: source.name,
			referenceNormalizedTime: normalizedTime,
			motionKey: motion?.key,
			mirrored: motion?.mirror === true,
		};
		this._scene.removeAnimationGroup(clone);
		this._runtimeGroups.set(key, clone);
		return clone;
	}

	public dispose(): void {
		for (const group of this._runtimeGroups.values()) {
			group.dispose();
		}
		this._runtimeGroups.clear();
	}
}
