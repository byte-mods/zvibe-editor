import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";

export const MODEL_RIG_EXPOSURE_METADATA_KEY = "babylonEditorOptimizedRigExposure";

export interface IModelRigExposureMetadata {
	version: 1;
	sourcePath: string;
	skeletonId: string;
	skeletonName: string;
	boneName: string;
	automatic: boolean;
	reason: "requested" | "attachment";
}

export interface IModelRigOptimizationResult {
	enabled: boolean;
	requestedExposedTransforms: string[];
	resolvedExposedTransforms: string[];
	missingExposedTransforms: string[];
	automaticallyExposedTransforms: string[];
	candidateTransformCount: number;
	optimizedTransformCount: number;
	exposedTransformCount: number;
	retargetedAnimationTrackCount: number;
	movedDirectAnimationCount: number;
	warnings: string[];
}

export interface IModelRigOptimizationEntries {
	transformNodes?: any[];
	animationGroups?: any[];
	skeletons?: any[];
}

interface ILinkedBone {
	node: any;
	bone: any;
	skeleton: any;
	path: string;
}

interface IExposedBinding {
	node: TransformNode;
	bone: any;
}

interface ISceneOptimizationState {
	bindings: Map<TransformNode, any>;
}

const configuredScenes = new WeakMap<Scene, ISceneOptimizationState>();

/** Parses the importer text field used to persist Unity-style transform paths. */
export function normalizeModelExposedTransforms(value: unknown): string[] {
	if (typeof value !== "string") {
		return [];
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const entry of value.split(/[\n,;]+/)) {
		const normalized = entry
			.trim()
			.replace(/\\/g, "/")
			.replace(/^\/+|\/+$/g, "")
			.replace(/\/{2,}/g, "/");
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(normalized.slice(0, 512));
		if (result.length === 128) {
			break;
		}
	}
	return result;
}

function transformPath(node: any): string {
	const names: string[] = [];
	const visited = new Set<any>();
	let current = node;
	while (current && names.length < 256 && !visited.has(current)) {
		visited.add(current);
		names.unshift(String(current.name || current.id || "Transform"));
		current = current.parent;
	}
	return names.join("/");
}

function transformDepth(node: any): number {
	let depth = 0;
	let current = node?.parent;
	const visited = new Set<any>();
	while (current && depth < 256 && !visited.has(current)) {
		visited.add(current);
		depth++;
		current = current.parent;
	}
	return depth;
}

function isRequestedPath(requestedPath: string, binding: ILinkedBone): boolean {
	if (requestedPath.includes("/")) {
		return binding.path === requestedPath || binding.path.endsWith(`/${requestedPath}`);
	}
	return binding.node.name === requestedPath;
}

function copyNodeTransformToBone(node: any, bone: any): void {
	const position = node.position?.clone?.();
	const scaling = node.scaling?.clone?.();
	const rotation = node.rotationQuaternion?.clone?.() ?? Quaternion.FromEulerAngles(Number(node.rotation?.x ?? 0), Number(node.rotation?.y ?? 0), Number(node.rotation?.z ?? 0));
	bone.linkTransformNode(null);
	if (position) {
		bone.position = position;
	}
	if (rotation) {
		bone.rotationQuaternion = rotation;
	}
	if (scaling) {
		bone.scaling = scaling;
	}
}

function exposureMetadata(node: any): IModelRigExposureMetadata | null {
	const metadata = node?.metadata?.[MODEL_RIG_EXPOSURE_METADATA_KEY];
	if (
		!metadata ||
		metadata.version !== 1 ||
		typeof metadata.sourcePath !== "string" ||
		typeof metadata.skeletonId !== "string" ||
		typeof metadata.skeletonName !== "string" ||
		typeof metadata.boneName !== "string"
	) {
		return null;
	}
	return metadata as IModelRigExposureMetadata;
}

function setExposureMetadata(binding: ILinkedBone, automatic: boolean): void {
	const existing = binding.node.metadata && typeof binding.node.metadata === "object" && !Array.isArray(binding.node.metadata) ? binding.node.metadata : {};
	binding.node.metadata = {
		...existing,
		[MODEL_RIG_EXPOSURE_METADATA_KEY]: {
			version: 1,
			sourcePath: binding.path,
			skeletonId: String(binding.skeleton.id),
			skeletonName: String(binding.skeleton.name),
			boneName: String(binding.bone.name),
			automatic,
			reason: automatic ? "attachment" : "requested",
		} satisfies IModelRigExposureMetadata,
	};
}

function synchronizeBinding(binding: IExposedBinding): void {
	const matrix = binding.bone.getAbsoluteMatrix?.();
	if (!matrix || binding.node.isDisposed?.()) {
		return;
	}
	const scaling = binding.node.scaling;
	const position = binding.node.position;
	const rotation = binding.node.rotationQuaternion ?? Quaternion.Identity();
	if (matrix.decompose(scaling, rotation, position)) {
		if (!binding.node.rotationQuaternion) {
			binding.node.rotationQuaternion = rotation.clone();
		}
		binding.node.markAsDirty?.("position");
	}
}

/** Synchronizes all retained attachment/exposure proxies from their optimized bones once. */
export function synchronizeOptimizedModelRigExposedTransforms(scene: Scene): number {
	const state = configuredScenes.get(scene);
	if (!state) {
		return 0;
	}
	let synchronized = 0;
	for (const [node, bone] of state.bindings) {
		if (node.isDisposed?.()) {
			state.bindings.delete(node);
			continue;
		}
		synchronizeBinding({ node, bone });
		synchronized++;
	}
	return synchronized;
}

/**
 * Resolves serialized exposed-transform markers and keeps the flattened Transform proxies synchronized with their
 * internal Babylon bones after animation evaluation.
 */
export function configureOptimizedModelRigExposedTransforms(scene: Scene, nodes?: any[], skeletons?: any[]): number {
	let state = configuredScenes.get(scene);
	if (!state) {
		state = { bindings: new Map<TransformNode, any>() };
		configuredScenes.set(scene, state);
		scene.onBeforeRenderObservable.add(() => synchronizeOptimizedModelRigExposedTransforms(scene));
	}
	const candidates = nodes ?? scene.transformNodes;
	const candidateSkeletons = skeletons ?? scene.skeletons;
	let configured = 0;
	for (const candidate of candidates) {
		const marker = exposureMetadata(candidate);
		if (!marker) {
			continue;
		}
		const skeleton =
			candidateSkeletons.find((entry) => String(entry.id) === marker.skeletonId) ??
			candidateSkeletons.find((entry) => String(entry.name) === marker.skeletonName && entry.bones?.some((bone: any) => bone.name === marker.boneName));
		const bone = skeleton?.bones?.find((entry: any) => entry.name === marker.boneName);
		if (!bone) {
			continue;
		}
		state.bindings.set(candidate as TransformNode, bone);
		synchronizeBinding({ node: candidate as TransformNode, bone });
		configured++;
	}
	return configured;
}

/** Returns an exposed optimized-rig Transform by its original path or unique node name. */
export function getOptimizedModelRigExposedTransform(scene: Scene, pathOrName: string): TransformNode | null {
	const requested = pathOrName.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const matches = scene.transformNodes.filter((node) => {
		const marker = exposureMetadata(node);
		return marker && (marker.sourcePath === requested || marker.sourcePath.endsWith(`/${requested}`) || node.name === requested);
	});
	return matches.length === 1 ? matches[0] : null;
}

/** Keeps serialized exposure markers valid when an editor import assigns a collision-safe skeleton id. */
export function remapOptimizedModelRigExposureSkeletonId(nodes: any[], skeletonName: string, previousId: string, nextId: string): number {
	let remapped = 0;
	for (const node of nodes) {
		const marker = exposureMetadata(node);
		if (marker && marker.skeletonName === skeletonName && marker.skeletonId === previousId) {
			node.metadata[MODEL_RIG_EXPOSURE_METADATA_KEY] = { ...marker, skeletonId: nextId };
			remapped++;
		}
	}
	return remapped;
}

/** Removes linked character-only Transform nodes, retargets animation tracks to bones, and retains requested attachment proxies. */
export function executeModelRigOptimization(
	entries: IModelRigOptimizationEntries,
	settings: { optimizeGameObjects: boolean; animationType: "none" | "generic" | "humanoid"; exposedTransforms: string[] }
): IModelRigOptimizationResult {
	const warnings: string[] = [];
	const requestedExposedTransforms = [...settings.exposedTransforms];
	const result: IModelRigOptimizationResult = {
		enabled: settings.optimizeGameObjects && settings.animationType !== "none",
		requestedExposedTransforms,
		resolvedExposedTransforms: [],
		missingExposedTransforms: [],
		automaticallyExposedTransforms: [],
		candidateTransformCount: 0,
		optimizedTransformCount: 0,
		exposedTransformCount: 0,
		retargetedAnimationTrackCount: 0,
		movedDirectAnimationCount: 0,
		warnings,
	};
	if (!settings.optimizeGameObjects) {
		return result;
	}
	if (settings.animationType === "none") {
		warnings.push("Optimize Game Object requires a Generic or Humanoid animation rig.");
		return result;
	}

	const transformNodes = new Set(entries.transformNodes ?? []);
	const linked: ILinkedBone[] = [];
	const bindingByNode = new Map<any, ILinkedBone>();
	for (const skeleton of entries.skeletons ?? []) {
		for (const bone of skeleton.bones ?? []) {
			const node = bone.getTransformNode?.();
			if (!node || !transformNodes.has(node)) {
				continue;
			}
			if (bindingByNode.has(node)) {
				warnings.push(`Transform "${transformPath(node)}" is linked to multiple bones and was optimized through the first link only.`);
				continue;
			}
			const binding = { node, bone, skeleton, path: transformPath(node) };
			bindingByNode.set(node, binding);
			linked.push(binding);
		}
	}
	result.candidateTransformCount = linked.length;
	if (!linked.length) {
		warnings.push("Optimize Game Object found no skeleton-linked Transform nodes to optimize.");
		result.missingExposedTransforms = requestedExposedTransforms;
		return result;
	}

	const exposed = new Set<any>();
	for (const requestedPath of requestedExposedTransforms) {
		const matches = linked.filter((binding) => isRequestedPath(requestedPath, binding));
		if (!matches.length) {
			result.missingExposedTransforms.push(requestedPath);
			continue;
		}
		if (matches.length > 1) {
			warnings.push(`Exposed Transform "${requestedPath}" matched ${matches.length} linked nodes; use a longer hierarchy path to select one.`);
		}
		for (const match of matches) {
			exposed.add(match.node);
			result.resolvedExposedTransforms.push(match.path);
		}
	}
	for (const binding of linked) {
		const hasExternalChild = (binding.node.getChildren?.() ?? []).some((child: any) => !bindingByNode.has(child));
		if (hasExternalChild && !exposed.has(binding.node)) {
			exposed.add(binding.node);
			result.automaticallyExposedTransforms.push(binding.path);
		}
	}

	for (const group of entries.animationGroups ?? []) {
		for (const targeted of group.targetedAnimations ?? []) {
			const binding = bindingByNode.get(targeted.target);
			if (binding) {
				targeted.target = binding.bone;
				result.retargetedAnimationTrackCount++;
			}
		}
	}
	for (const binding of linked) {
		copyNodeTransformToBone(binding.node, binding.bone);
		const directAnimations = Array.isArray(binding.node.animations) ? binding.node.animations : [];
		for (const animation of directAnimations) {
			if (!binding.bone.animations.includes(animation)) {
				binding.bone.animations.push(animation);
				result.movedDirectAnimationCount++;
			}
		}
		binding.node.animations = [];
	}

	const exposedBindings: IExposedBinding[] = [];
	for (const binding of linked.filter((entry) => exposed.has(entry.node))) {
		let anchor = binding.node.parent;
		const visited = new Set<any>();
		while (anchor && bindingByNode.has(anchor) && !visited.has(anchor)) {
			visited.add(anchor);
			anchor = anchor.parent;
		}
		binding.node.setParent?.(anchor ?? null, true);
		const automatic = result.automaticallyExposedTransforms.includes(binding.path);
		setExposureMetadata(binding, automatic);
		exposedBindings.push({ node: binding.node as TransformNode, bone: binding.bone });
	}
	for (const binding of linked.filter((entry) => !exposed.has(entry.node)).sort((left, right) => transformDepth(right.node) - transformDepth(left.node))) {
		binding.node.dispose?.(true);
		result.optimizedTransformCount++;
	}
	if (Array.isArray(entries.transformNodes)) {
		entries.transformNodes.splice(0, entries.transformNodes.length, ...entries.transformNodes.filter((node) => !node.isDisposed?.()));
	}

	result.exposedTransformCount = exposedBindings.length;
	result.resolvedExposedTransforms = [...new Set(result.resolvedExposedTransforms)].sort();
	result.missingExposedTransforms = [...new Set(result.missingExposedTransforms)].sort();
	result.automaticallyExposedTransforms = [...new Set(result.automaticallyExposedTransforms)].sort();
	const scene = exposedBindings[0]?.node.getScene?.() as Scene | undefined;
	if (scene) {
		configureOptimizedModelRigExposedTransforms(
			scene,
			exposedBindings.map((binding) => binding.node),
			entries.skeletons
		);
	}
	return result;
}
