import {
	AbstractMesh,
	Animation,
	AnimationGroup,
	BaseTexture,
	Camera,
	Geometry,
	IParticleSystem,
	IShadowGenerator,
	Light,
	Material,
	MorphTargetManager,
	MultiMaterial,
	Node,
	Scene,
	Skeleton,
	TransformNode,
} from "babylonjs";

import { SceneLinkNode } from "../../editor/nodes/scene-link";
import { SoundNode } from "../../editor/nodes/sound";
import { SpriteMapNode } from "../../editor/nodes/sprite-map";
import { SpriteManagerNode } from "../../editor/nodes/sprite-manager";

/** Every object and resource created by one authored scene load. */
export type SceneLoadResult = {
	configuration: any | null;
	/** Lazily parsed environment texture retained by this authored scene's lighting configuration. */
	environmentTexture: BaseTexture | null | undefined;
	lights: Light[];
	cameras: Camera[];
	meshes: AbstractMesh[];
	sceneLinks: SceneLinkNode[];
	transformNodes: TransformNode[];
	animationGroups: AnimationGroup[];
	particleSystems: IParticleSystem[];
	soundNodes: SoundNode[];
	spriteMaps: SpriteMapNode[];
	spriteManagers: SpriteManagerNode[];
	shadowGenerators: IShadowGenerator[];
	materials: Material[];
	textures: BaseTexture[];
	geometries: Geometry[];
	skeletons: Skeleton[];
	morphTargetManagers: MorphTargetManager[];
	sceneAnimations: Animation[];
};

export interface ISceneResourceSnapshot {
	materials: Set<Material>;
	textures: Set<BaseTexture>;
	geometries: Set<Geometry>;
	skeletons: Set<Skeleton>;
	morphTargetManagers: Set<MorphTargetManager>;
	sceneAnimations: Set<Animation>;
}

/** Creates an empty result before the loader starts mutating the shared Babylon scene. */
export function createSceneLoadResult(): SceneLoadResult {
	return {
		configuration: null,
		environmentTexture: undefined,
		lights: [],
		cameras: [],
		meshes: [],
		sceneLinks: [],
		transformNodes: [],
		animationGroups: [],
		particleSystems: [],
		soundNodes: [],
		spriteMaps: [],
		spriteManagers: [],
		shadowGenerators: [],
		materials: [],
		textures: [],
		geometries: [],
		skeletons: [],
		morphTargetManagers: [],
		sceneAnimations: [],
	};
}

/** Captures shared-scene collections so a later delta belongs to this load only. */
export function snapshotSceneResources(scene: Scene): ISceneResourceSnapshot {
	return {
		materials: new Set([...scene.materials, ...scene.multiMaterials]),
		textures: new Set(scene.textures),
		geometries: new Set(scene.geometries),
		skeletons: new Set(scene.skeletons),
		morphTargetManagers: new Set(scene.morphTargetManagers),
		sceneAnimations: new Set(scene.animations),
	};
}

/** Records only resources introduced by this load, excluding nested read-only SceneLink content. */
export function captureAddedSceneResources(scene: Scene, snapshot: ISceneResourceSnapshot, result: SceneLoadResult, excludedObjects: ReadonlySet<object> = new Set()): void {
	result.materials.push(
		...[...scene.materials, ...scene.multiMaterials].filter(
			(resource) => !snapshot.materials.has(resource) && !excludedObjects.has(resource) && !result.materials.includes(resource)
		)
	);
	result.textures.push(...scene.textures.filter((resource) => !snapshot.textures.has(resource) && !excludedObjects.has(resource) && !result.textures.includes(resource)));
	result.geometries.push(...scene.geometries.filter((resource) => !snapshot.geometries.has(resource) && !excludedObjects.has(resource) && !result.geometries.includes(resource)));
	result.skeletons.push(...scene.skeletons.filter((resource) => !snapshot.skeletons.has(resource) && !excludedObjects.has(resource) && !result.skeletons.includes(resource)));
	result.morphTargetManagers.push(
		...scene.morphTargetManagers.filter(
			(resource) => !snapshot.morphTargetManagers.has(resource) && !excludedObjects.has(resource) && !result.morphTargetManagers.includes(resource)
		)
	);
	result.sceneAnimations.push(
		...scene.animations.filter((resource) => !snapshot.sceneAnimations.has(resource) && !excludedObjects.has(resource) && !result.sceneAnimations.includes(resource))
	);
}

/** Returns the direct nodes in one authored scene; nested SceneLink descendants remain separately owned. */
export function getSceneLoadResultNodes(result: SceneLoadResult): Node[] {
	return [
		...new Set<Node>([
			...result.transformNodes,
			...result.meshes,
			...result.lights,
			...result.cameras,
			...result.sceneLinks,
			...result.soundNodes,
			...result.spriteMaps,
			...result.spriteManagers,
		]),
	];
}

/** Returns every claimable object in a result for ownership, status, and MCP reporting. */
export function getSceneLoadResultObjects(result: SceneLoadResult): object[] {
	return [
		...new Set<object>([
			...getSceneLoadResultNodes(result),
			...result.animationGroups,
			...result.particleSystems,
			...result.shadowGenerators,
			...result.materials,
			...result.textures,
			...result.geometries,
			...result.skeletons,
			...result.morphTargetManagers,
			...result.sceneAnimations,
		]),
	];
}

/** Resolves serialized parent IDs only inside the current authored scene. */
export function resolveSceneLoadResultParents(result: SceneLoadResult): void {
	const nodes = getSceneLoadResultNodes(result);
	const nodesByUniqueId = new Map<number, Node>();
	for (const node of nodes) {
		if (!nodesByUniqueId.has(node.uniqueId)) {
			nodesByUniqueId.set(node.uniqueId, node);
		}
	}

	for (const node of nodes) {
		const waitingParentId = node.metadata?._waitingParentId;
		if (waitingParentId !== undefined && waitingParentId !== null) {
			const parent = nodesByUniqueId.get(Number(waitingParentId));
			if (parent && parent !== node) {
				node.parent = parent;
			}
		}
		if (node.metadata) {
			delete node.metadata._waitingParentId;
		}
	}
}

/** Finds one node by its serialized local ID without consulting previously loaded scenes. */
export function findSceneLoadResultNodeById(result: SceneLoadResult, id: unknown): Node | null {
	return getSceneLoadResultNodes(result).find((node) => node.id === id) ?? null;
}

/**
 * Provides Babylon parsers a read-only lookup façade whose IDs and collections are local to one
 * authored scene. Returned nodes still belong to the real shared Scene used by the renderer.
 */
export function createSceneLoadLookupScope(scene: Scene, result: SceneLoadResult): Scene {
	const nodes = getSceneLoadResultNodes(result);
	const byId = (id: unknown) => nodes.find((node) => node.id === id) ?? null;
	const byUniqueId = (uniqueId: unknown) => nodes.find((node) => node.uniqueId === Number(uniqueId)) ?? null;
	return new Proxy(scene, {
		get(target, property, receiver) {
			switch (property) {
				case "meshes":
					return result.meshes;
				case "lights":
					return result.lights;
				case "cameras":
					return result.cameras;
				case "transformNodes":
					return result.transformNodes;
				case "getNodeById":
					return byId;
				case "getMeshById":
				case "getLastMeshById":
					return (id: unknown) => result.meshes.find((mesh) => mesh.id === id) ?? null;
				case "getLightById":
					return (id: unknown) => result.lights.find((light) => light.id === id) ?? null;
				case "getCameraById":
					return (id: unknown) => result.cameras.find((camera) => camera.id === id) ?? null;
				case "getTransformNodeById":
					return (id: unknown) => result.transformNodes.find((node) => node.id === id) ?? null;
				case "getNodeByUniqueId":
					return byUniqueId;
				case "getMeshByUniqueId":
					return (id: unknown) => result.meshes.find((mesh) => mesh.uniqueId === Number(id)) ?? null;
				case "getLightByUniqueId":
					return (id: unknown) => result.lights.find((light) => light.uniqueId === Number(id)) ?? null;
				case "getCameraByUniqueId":
					return (id: unknown) => result.cameras.find((camera) => camera.uniqueId === Number(id)) ?? null;
				case "getTransformNodeByUniqueId":
					return (id: unknown) => result.transformNodes.find((node) => node.uniqueId === Number(id)) ?? null;
				default:
					return Reflect.get(target, property, receiver);
			}
		},
	}) as Scene;
}

/** Disposes one authored load while retaining resources referenced by another loaded scene. */
export function disposeSceneLoadResult(scene: Scene, result: SceneLoadResult): void {
	const ownedNodes = new Set(getSceneLoadResultNodes(result));
	const materialsToDispose = new Set<Material>();

	result.sceneLinks.forEach((sceneLink) => sceneLink.dispose());
	result.shadowGenerators.forEach((shadowGenerator) => shadowGenerator.dispose());
	result.particleSystems.forEach((particleSystem) => particleSystem.dispose());
	result.animationGroups.forEach((animationGroup) => animationGroup.dispose());

	// Dispose each direct node without recursion because every direct node is handled exactly once.
	ownedNodes.forEach((node) => {
		if (!result.sceneLinks.includes(node as SceneLinkNode)) {
			node.dispose(true, false);
		}
	});

	result.sceneAnimations.forEach((animation) => {
		const index = scene.animations.indexOf(animation);
		if (index !== -1) {
			scene.animations.splice(index, 1);
		}
	});
	result.morphTargetManagers.forEach((manager) => {
		if (!scene.meshes.some((mesh) => mesh.morphTargetManager === manager)) {
			manager.dispose();
		}
	});
	result.skeletons.forEach((skeleton) => {
		if (!scene.meshes.some((mesh) => mesh.skeleton === skeleton)) {
			skeleton.dispose();
		}
	});
	result.geometries.forEach((geometry) => {
		if (!scene.meshes.some((mesh) => mesh.geometry === geometry)) {
			geometry.dispose();
		}
	});

	result.materials.forEach((material) => {
		const referenced = scene.meshes.some((mesh) => {
			if (ownedNodes.has(mesh) || !mesh.material) {
				return false;
			}
			return mesh.material === material || (mesh.material instanceof MultiMaterial && mesh.material.subMaterials.includes(material));
		});
		if (!referenced) {
			materialsToDispose.add(material);
		}
	});
	materialsToDispose.forEach((material) => material.dispose(false, false));

	result.textures.forEach((texture) => {
		const referencedByMaterial = scene.materials.some((material) => !materialsToDispose.has(material) && material.getActiveTextures().includes(texture));
		const referencedByScene = scene.environmentTexture === texture;
		if (!referencedByMaterial && !referencedByScene) {
			texture.dispose();
		}
	});
}
