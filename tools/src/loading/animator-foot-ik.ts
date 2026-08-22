import { Bone } from "@babylonjs/core/Bones/bone";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Scene } from "@babylonjs/core/scene";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";

import { IHumanoidAvatar } from "../assets/humanoid-avatar";
import { IAnimatorGraphState } from "./animator-graph";

export interface IAnimatorFootIKController {
	id: string;
	name: string;
	humanoidAvatarId?: string;
}

export interface IAnimatorFootIKLayer {
	name: string;
	weight?: number;
}

export interface IAnimatorFootIKFootResult {
	role: "leftFoot" | "rightFoot";
	status: "solved" | "no-ground" | "missing-chain" | "unreachable";
	groundMeshName: string | null;
	correctionDistance: number;
	finalError: number | null;
}

export interface IAnimatorFootIKLayerDiagnostics {
	layerName: string;
	enabled: boolean;
	invocations: number;
	solvedFeet: number;
	failedFeet: number;
	avatarId: string | null;
	skeletonId: string | null;
	algorithm: "bounded-ground-ray-ccd-v1";
	lastFeet: IAnimatorFootIKFootResult[];
	warnings: string[];
}

export interface IAnimatorFootIKDiagnostics {
	controllerId: string;
	layers: IAnimatorFootIKLayerDiagnostics[];
}

const diagnosticsByScene = new WeakMap<Scene, Map<string, Map<string, IAnimatorFootIKLayerDiagnostics>>>();

function diagnosticsFor(scene: Scene, controller: IAnimatorFootIKController, layer: IAnimatorFootIKLayer): IAnimatorFootIKLayerDiagnostics {
	let sceneDiagnostics = diagnosticsByScene.get(scene);
	if (!sceneDiagnostics) {
		sceneDiagnostics = new Map();
		diagnosticsByScene.set(scene, sceneDiagnostics);
	}
	let controllerDiagnostics = sceneDiagnostics.get(controller.id);
	if (!controllerDiagnostics) {
		controllerDiagnostics = new Map();
		sceneDiagnostics.set(controller.id, controllerDiagnostics);
	}
	let diagnostics = controllerDiagnostics.get(layer.name);
	if (!diagnostics) {
		diagnostics = {
			layerName: layer.name,
			enabled: false,
			invocations: 0,
			solvedFeet: 0,
			failedFeet: 0,
			avatarId: controller.humanoidAvatarId ?? null,
			skeletonId: null,
			algorithm: "bounded-ground-ray-ccd-v1",
			lastFeet: [],
			warnings: [],
		};
		controllerDiagnostics.set(layer.name, diagnostics);
	}
	return diagnostics;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function resolveChain(scene: Scene, avatar: IHumanoidAvatar, side: "left" | "right"): { bones: [Bone, Bone, Bone]; mesh: AbstractMesh } | null {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === avatar.skeletonId);
	const mesh = skeleton ? scene.meshes.find((candidate) => candidate.skeleton === skeleton) : null;
	const names = [avatar.mapping[`${side}UpperLeg`], avatar.mapping[`${side}LowerLeg`], avatar.mapping[`${side}Foot`]];
	if (!skeleton || !mesh || names.some((name) => !name)) {
		return null;
	}
	const bones = names.map((name) => skeleton.bones.find((bone) => bone.name === name));
	return bones.every((bone): bone is Bone => !!bone) ? { bones: bones as [Bone, Bone, Bone], mesh } : null;
}

function solveFoot(scene: Scene, avatar: IHumanoidAvatar, side: "left" | "right", weight: number): IAnimatorFootIKFootResult {
	const role = `${side}Foot` as "leftFoot" | "rightFoot";
	const resolved = resolveChain(scene, avatar, side);
	if (!resolved) {
		return { role, status: "missing-chain", groundMeshName: null, correctionDistance: 0, finalError: null };
	}
	const [upper, lower, foot] = resolved.bones;
	const skeleton = upper.getSkeleton();
	skeleton.computeAbsoluteMatrices(true);
	const current = foot.getPosition(Space.WORLD, resolved.mesh);
	const scale = Math.max(0.01, avatar.humanScale || 1);
	const clearance = scale * 0.5;
	const ray = new Ray(current.add(Vector3.Up().scale(clearance)), Vector3.Down(), scale * 1.5);
	const pick = scene.pickWithRay(ray, (mesh) => mesh !== resolved.mesh && mesh.skeleton !== resolved.mesh.skeleton && mesh.isEnabled() && mesh.isPickable && mesh.isVisible);
	if (!pick?.hit || !pick.pickedPoint) {
		return { role, status: "no-ground", groundMeshName: null, correctionDistance: 0, finalError: null };
	}
	const normal = pick.getNormal(true)?.normalize() ?? Vector3.Up();
	const desiredRaw = pick.pickedPoint.add(normal.scale(scale * 0.01));
	const delta = desiredRaw.subtract(current);
	const maximumCorrection = scale * 0.5;
	const correctionDistance = Math.min(maximumCorrection, delta.length()) * clamp01(weight);
	const desired = current.add(delta.lengthSquared() > 1e-10 ? delta.normalize().scale(correctionDistance) : Vector3.Zero());
	const chainLength =
		Vector3.Distance(upper.getPosition(Space.WORLD, resolved.mesh), lower.getPosition(Space.WORLD, resolved.mesh)) +
		Vector3.Distance(lower.getPosition(Space.WORLD, resolved.mesh), current);
	if (Vector3.Distance(upper.getPosition(Space.WORLD, resolved.mesh), desired) > chainLength + scale * 0.01) {
		return { role, status: "unreachable", groundMeshName: pick.pickedMesh?.name ?? null, correctionDistance, finalError: null };
	}
	for (let iteration = 0; iteration < 8; iteration++) {
		for (const joint of [lower, upper]) {
			skeleton.computeAbsoluteMatrices(true);
			const jointPosition = joint.getPosition(Space.WORLD, resolved.mesh);
			const footPosition = foot.getPosition(Space.WORLD, resolved.mesh);
			const currentDirection = footPosition.subtract(jointPosition);
			const desiredDirection = desired.subtract(jointPosition);
			if (currentDirection.lengthSquared() <= 1e-10 || desiredDirection.lengthSquared() <= 1e-10) {
				continue;
			}
			const rotationDelta = Quaternion.Identity();
			Quaternion.FromUnitVectorsToRef(currentDirection.normalize(), desiredDirection.normalize(), rotationDelta);
			joint.setRotationQuaternion(rotationDelta.multiply(joint.getRotationQuaternion(Space.WORLD, resolved.mesh)).normalize(), Space.WORLD, resolved.mesh);
		}
		skeleton.computeAbsoluteMatrices(true);
		if (Vector3.Distance(foot.getPosition(Space.WORLD, resolved.mesh), desired) <= scale * 0.0025) {
			break;
		}
	}
	skeleton.computeAbsoluteMatrices(true);
	const currentUp = foot.getDirection(Vector3.Up(), resolved.mesh).normalize();
	if (currentUp.lengthSquared() > 1e-10 && normal.lengthSquared() > 1e-10) {
		const rotationDelta = Quaternion.Identity();
		Quaternion.FromUnitVectorsToRef(currentUp, normal, rotationDelta);
		const aligned = rotationDelta.multiply(foot.getRotationQuaternion(Space.WORLD, resolved.mesh)).normalize();
		foot.setRotationQuaternion(Quaternion.Slerp(foot.getRotationQuaternion(Space.WORLD, resolved.mesh), aligned, clamp01(weight)).normalize(), Space.WORLD, resolved.mesh);
	}
	skeleton.computeAbsoluteMatrices(true);
	return {
		role,
		status: "solved",
		groundMeshName: pick.pickedMesh?.name ?? null,
		correctionDistance,
		finalError: Vector3.Distance(foot.getPosition(Space.WORLD, resolved.mesh), desired),
	};
}

/** Applies bounded ground-contact stabilization for a Humanoid state's left and right leg chains. */
export function applyAnimatorFootIK(scene: Scene, controller: IAnimatorFootIKController, layer: IAnimatorFootIKLayer, state: IAnimatorGraphState): IAnimatorFootIKLayerDiagnostics {
	const diagnostics = diagnosticsFor(scene, controller, layer);
	diagnostics.enabled = state.footIK === true;
	diagnostics.avatarId = controller.humanoidAvatarId ?? null;
	diagnostics.lastFeet = [];
	diagnostics.warnings = [];
	if (!diagnostics.enabled) {
		return structuredClone(diagnostics);
	}
	diagnostics.invocations++;
	const avatar = ((scene.metadata?.babylonEditorHumanoidAvatars as IHumanoidAvatar[] | undefined) ?? []).find(
		(candidate) => candidate.id === controller.humanoidAvatarId && candidate.animationType === "humanoid"
	);
	if (!avatar) {
		diagnostics.failedFeet += 2;
		diagnostics.skeletonId = null;
		diagnostics.warnings = ["Foot IK requires the controller to reference an existing Humanoid Avatar."];
		return structuredClone(diagnostics);
	}
	diagnostics.skeletonId = avatar.skeletonId;
	diagnostics.lastFeet = [solveFoot(scene, avatar, "left", layer.weight ?? 1), solveFoot(scene, avatar, "right", layer.weight ?? 1)];
	diagnostics.solvedFeet += diagnostics.lastFeet.filter((result) => result.status === "solved").length;
	diagnostics.failedFeet += diagnostics.lastFeet.filter((result) => result.status !== "solved").length;
	return structuredClone(diagnostics);
}

/** Returns bounded non-mutating automatic Foot IK diagnostics for an Animator debugger. */
export function getAnimatorFootIKDiagnostics(scene: Scene, controller: IAnimatorFootIKController, layers: IAnimatorFootIKLayer[] = []): IAnimatorFootIKDiagnostics {
	const known = diagnosticsByScene.get(scene)?.get(controller.id);
	const names = new Set([...layers.map((layer) => layer.name), ...(known?.keys() ?? [])]);
	return {
		controllerId: controller.id,
		layers: [...names]
			.sort((first, second) => first.localeCompare(second))
			.map((name) => structuredClone(known?.get(name) ?? diagnosticsFor(scene, controller, layers.find((layer) => layer.name === name) ?? { name }))),
	};
}

export function deleteAnimatorFootIKDiagnostics(scene: Scene, controllerId: string): void {
	diagnosticsByScene.get(scene)?.delete(controllerId);
}
