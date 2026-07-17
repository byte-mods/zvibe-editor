import { Scene, Tools } from "babylonjs";
import {
	defaultHumanoidBodyParts,
	HUMANOID_BODY_PARTS,
	HumanoidBodyPart,
	IHumanoidAvatar,
	IHumanoidAvatarMask,
	normalizeHumanoidBodyParts,
	resolveHumanoidAvatarMaskTargetNames,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

function avatars(scene: Scene): IHumanoidAvatar[] {
	return Array.isArray(scene.metadata?.babylonEditorHumanoidAvatars) ? scene.metadata.babylonEditorHumanoidAvatars : [];
}

function masks(scene: Scene): IHumanoidAvatarMask[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorHumanoidAvatarMasks ??= []);
}

function resolveAvatar(scene: Scene, avatarId: string): IHumanoidAvatar {
	const avatar = avatars(scene).find((candidate) => candidate.id === avatarId);
	if (!avatar) {
		throw new Error(`Humanoid Avatar "${avatarId}" was not found.`);
	}
	if (avatar.animationType !== "humanoid") {
		throw new Error(`Avatar "${avatar.name}" must use Humanoid animation type for body-part masks.`);
	}
	return avatar;
}

function resolveMask(scene: Scene, maskId: string): IHumanoidAvatarMask {
	const mask = masks(scene).find((candidate) => candidate.id === maskId);
	if (!mask) {
		throw new Error(`Humanoid Avatar Mask "${maskId}" was not found.`);
	}
	return mask;
}

function normalizeTransformNames(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const names = value.map((name) => String(name).trim()).filter(Boolean);
	if (names.length > 512) {
		throw new Error("Avatar Masks support at most 512 additional transform names.");
	}
	if (names.some((name) => name.length > 512)) {
		throw new Error("Avatar Mask transform names are limited to 512 characters.");
	}
	return [...new Set(names)].sort();
}

function describeMask(scene: Scene, mask: IHumanoidAvatarMask): any {
	const avatar = resolveAvatar(scene, mask.avatarId);
	const targetNames = resolveHumanoidAvatarMaskTargetNames(avatar, mask.bodyParts, mask.transformNames);
	const enabledBodyParts = HUMANOID_BODY_PARTS.filter((part) => mask.bodyParts[part]);
	return { ...structuredClone(mask), enabledBodyParts, targetNames, targetCount: targetNames.length };
}

/** Lists reusable humanoid body-part Avatar Masks and their resolved animation targets. */
export function listHumanoidAvatarMasks(scene: Scene): any {
	return { masks: masks(scene).map((mask) => describeMask(scene, mask)) };
}

/** Creates a reusable Avatar Mask for Animator states/layers. */
export function createHumanoidAvatarMask(scene: Scene, data: any, options: IMCPActionOptions): any {
	const avatar = resolveAvatar(scene, data.avatarId);
	const id = String(data.id ?? Tools.RandomId()).trim();
	const name = String(data.name ?? `${avatar.name} Mask`).trim();
	if (!id || id.length > 256 || !name || name.length > 256) {
		throw new Error("Avatar Mask id and name must contain 1 through 256 characters.");
	}
	if (masks(scene).some((candidate) => candidate.id === id)) {
		throw new Error(`Humanoid Avatar Mask "${id}" already exists.`);
	}
	const mask: IHumanoidAvatarMask = {
		version: 1,
		id,
		name,
		avatarId: avatar.id,
		bodyParts: data.bodyParts === undefined ? defaultHumanoidBodyParts(true) : normalizeHumanoidBodyParts(data.bodyParts),
		transformNames: normalizeTransformNames(data.transformNames),
	};
	masks(scene).push(mask);
	options.editor.layout.inspector.forceUpdate();
	return describeMask(scene, mask);
}

/** Updates a mask name, Avatar, enabled body parts, or additional transform names. */
export function setHumanoidAvatarMask(scene: Scene, data: any, options: IMCPActionOptions): any {
	const mask = resolveMask(scene, data.maskId);
	if (data.name !== undefined) {
		const name = String(data.name).trim();
		if (!name || name.length > 256) {
			throw new Error("Avatar Mask name must contain 1 through 256 characters.");
		}
		mask.name = name;
	}
	if (data.avatarId !== undefined) {
		mask.avatarId = resolveAvatar(scene, data.avatarId).id;
	}
	if (data.bodyParts !== undefined) {
		const patch = data.bodyParts as Record<string, unknown>;
		const next = { ...mask.bodyParts };
		for (const part of HUMANOID_BODY_PARTS) {
			if (part in patch) {
				if (typeof patch[part] !== "boolean") {
					throw new Error(`${part} must be a boolean.`);
				}
				next[part] = patch[part] as boolean;
			}
		}
		mask.bodyParts = next;
	}
	if (data.transformNames !== undefined) {
		mask.transformNames = normalizeTransformNames(data.transformNames);
	}
	options.editor.layout.inspector.forceUpdate();
	return describeMask(scene, mask);
}

/** Deletes a mask unless an Animator state/layer still references it. */
export function deleteHumanoidAvatarMask(scene: Scene, data: any, options: IMCPActionOptions): any {
	const mask = resolveMask(scene, data.maskId);
	const references = (scene.metadata?.babylonEditorAnimatorControllers ?? []).flatMap((controller: any) => [
		...(controller.states ?? []).filter((state: any) => state.avatarMaskId === mask.id).map((state: any) => `${controller.name}/state:${state.name}`),
		...(controller.layers ?? []).flatMap((layer: any) => [
			...(layer.avatarMaskId === mask.id ? [`${controller.name}/layer:${layer.name}`] : []),
			...(layer.states ?? []).filter((state: any) => state.avatarMaskId === mask.id).map((state: any) => `${controller.name}/layer:${layer.name}/state:${state.name}`),
		]),
	]);
	if (references.length && data.force !== true) {
		throw new Error(`Avatar Mask "${mask.name}" is referenced by ${references.join(", ")}. Clear those references or use force=true.`);
	}
	const index = masks(scene).indexOf(mask);
	masks(scene).splice(index, 1);
	if (data.force === true) {
		for (const controller of scene.metadata?.babylonEditorAnimatorControllers ?? []) {
			for (const state of controller.states ?? []) {
				if (state.avatarMaskId === mask.id) {
					delete state.avatarMaskId;
				}
			}
			for (const layer of controller.layers ?? []) {
				if (layer.avatarMaskId === mask.id) {
					delete layer.avatarMaskId;
				}
				for (const state of layer.states ?? []) {
					if (state.avatarMaskId === mask.id) {
						delete state.avatarMaskId;
					}
				}
			}
		}
	}
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, maskId: mask.id, clearedReferences: data.force === true ? references : [] };
}

export type { HumanoidBodyPart };
