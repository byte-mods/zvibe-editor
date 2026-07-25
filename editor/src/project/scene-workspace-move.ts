import { AbstractMesh, AnimationGroup, BaseTexture, IShadowGenerator, Material, MorphTarget, MultiMaterial, Node, Scene, Skeleton } from "babylonjs";

import { isEditorCamera } from "../tools/guards/nodes";
import { isSceneLinkNode } from "../tools/guards/scene";

import { getEffectiveHierarchyOwner, ISceneHierarchyOwnershipReader } from "./scene-hierarchy";

export interface ISceneObjectMovePlan {
	rootNodes: Node[];
	objects: object[];
	previousOwners: Map<object, string>;
	sourceScenes: string[];
	targetScene: string;
}

/** Plans one lossless root transfer before any hierarchy or ownership state is mutated. */
export function planSceneObjectMove(scene: Scene, workspace: ISceneHierarchyOwnershipReader, selectedObjects: object[], targetScene: string): ISceneObjectMovePlan {
	if (!workspace.getSettings().loadedScenes?.includes(targetScene)) {
		throw new Error(`Scene is not loaded for authoring: ${targetScene}`);
	}

	const selectedNodes = [...new Set(selectedObjects.filter((object): object is Node => object instanceof Node && !isEditorCamera(object)))];
	const selectedSet = new Set(selectedNodes);
	const rootNodes = selectedNodes.filter((node) => !node.parent || !selectedSet.has(node.parent));
	if (!rootNodes.length) {
		throw new Error("Select at least one authored scene root to move.");
	}

	const sourceScenes = new Set<string>();
	for (const root of rootNodes) {
		if (isSceneLinkNode(root) && root.metadata?.doNotSerialize) {
			throw new Error(`Read-only linked scene content cannot be moved: ${root.name}`);
		}
		const source = getEffectiveHierarchyOwner(workspace, root);
		if (!source) {
			throw new Error(`Unable to resolve authored scene ownership for "${root.name}".`);
		}
		if (source === targetScene) {
			throw new Error(`"${root.name}" already belongs to scene "${targetScene}".`);
		}
		if (root.parent && getEffectiveHierarchyOwner(workspace, root.parent) === source) {
			throw new Error(`Only scene-root objects can move between scenes: ${root.name}`);
		}
		sourceScenes.add(source);
	}

	const movedNodes = new Set<Node>();
	for (const root of rootNodes) {
		const source = getEffectiveHierarchyOwner(workspace, root);
		movedNodes.add(root);
		root.getDescendants(false)
			.filter((node) => getEffectiveHierarchyOwner(workspace, node) === source)
			.forEach((node) => movedNodes.add(node));
	}

	const movedMeshes = new Set([...movedNodes].filter((node): node is AbstractMesh => node instanceof AbstractMesh));
	const skeletons = getExclusiveResources(scene.skeletons, scene.meshes, movedMeshes, (mesh, skeleton) => mesh.skeleton === skeleton);
	const morphTargetManagers = getExclusiveResources(scene.morphTargetManagers, scene.meshes, movedMeshes, (mesh, manager) => mesh.morphTargetManager === manager);
	const geometries = getExclusiveResources(scene.geometries, scene.meshes, movedMeshes, (mesh, geometry) => mesh.geometry === geometry);
	const movedMaterials = getExclusiveMaterials(scene, movedMeshes);
	const movedTextures = getExclusiveTextures(scene, movedMaterials);
	const movedMorphTargets = new Set<MorphTarget>();
	morphTargetManagers.forEach((manager) => {
		for (let index = 0; index < manager.numTargets; index++) {
			movedMorphTargets.add(manager.getTarget(index));
		}
	});

	const particleSystems = scene.particleSystems.filter((particleSystem) => particleSystem.emitter instanceof Node && movedNodes.has(particleSystem.emitter));
	const shadowGenerators = [...movedNodes]
		.map((node) => ("getShadowGenerator" in node ? (node as any).getShadowGenerator?.() : null))
		.filter((generator): generator is IShadowGenerator => !!generator);
	const animationGroups = getTransferableAnimationGroups(scene.animationGroups, movedNodes, skeletons, movedMorphTargets);

	const candidates: object[] = [
		...movedNodes,
		...particleSystems,
		...shadowGenerators,
		...skeletons,
		...morphTargetManagers,
		...geometries,
		...movedMaterials,
		...movedTextures,
		...animationGroups,
	];
	const objects: object[] = [];
	const previousOwners = new Map<object, string>();
	for (const object of new Set(candidates)) {
		const previousOwner = workspace.getOwner(object) ?? getEffectiveHierarchyOwner(workspace, object);
		if (previousOwner && previousOwner !== targetScene && sourceScenes.has(previousOwner)) {
			objects.push(object);
			previousOwners.set(object, previousOwner);
		}
	}

	return { rootNodes, objects, previousOwners, sourceScenes: [...sourceScenes], targetScene };
}

function getExclusiveResources<T>(resources: T[], meshes: AbstractMesh[], movedMeshes: Set<AbstractMesh>, uses: (mesh: AbstractMesh, resource: T) => boolean): T[] {
	return resources.filter((resource) => {
		const consumers = meshes.filter((mesh) => uses(mesh, resource));
		return consumers.length > 0 && consumers.every((mesh) => movedMeshes.has(mesh));
	});
}

function getMeshMaterials(mesh: AbstractMesh): Material[] {
	if (!mesh.material) {
		return [];
	}
	return mesh.material instanceof MultiMaterial ? [mesh.material, ...mesh.material.subMaterials.filter((material): material is Material => !!material)] : [mesh.material];
}

function getExclusiveMaterials(scene: Scene, movedMeshes: Set<AbstractMesh>): Material[] {
	const used = new Set([...movedMeshes].flatMap(getMeshMaterials));
	return [...scene.materials, ...scene.multiMaterials].filter((material) => {
		if (!used.has(material)) {
			return false;
		}
		return scene.meshes.filter((mesh) => getMeshMaterials(mesh).includes(material)).every((mesh) => movedMeshes.has(mesh));
	});
}

function getExclusiveTextures(scene: Scene, movedMaterials: Material[]): BaseTexture[] {
	const moved = new Set(movedMaterials);
	const used = new Set(movedMaterials.flatMap((material) => material.getActiveTextures()));
	return scene.textures.filter(
		(texture) => used.has(texture) && scene.materials.filter((material) => material.getActiveTextures().includes(texture)).every((material) => moved.has(material))
	);
}

function getTransferableAnimationGroups(
	animationGroups: AnimationGroup[],
	movedNodes: Set<Node>,
	movedSkeletons: Skeleton[],
	movedMorphTargets: Set<MorphTarget>
): AnimationGroup[] {
	return animationGroups.filter((group) => {
		const targetMoves = group.targetedAnimations.map(({ target }) => {
			if (target instanceof Node) {
				return movedNodes.has(target);
			}
			if (target instanceof MorphTarget) {
				return movedMorphTargets.has(target);
			}
			const skeleton = target?.getSkeleton?.();
			return skeleton ? movedSkeletons.includes(skeleton) : false;
		});
		if (!targetMoves.some(Boolean)) {
			return false;
		}
		if (!targetMoves.every(Boolean)) {
			throw new Error(`Animation Group "${group.name}" targets objects on both sides of the requested scene move.`);
		}
		return true;
	});
}
