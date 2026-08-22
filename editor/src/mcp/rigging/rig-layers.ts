import { Bone, Quaternion, Scene, Skeleton, Space, Tools, TransformNode, Vector3 } from "babylonjs";
import {
	applyRigLayers,
	clearAnimationRigProfile as clearRuntimeAnimationRigProfile,
	configureAnimationRigProfiler,
	configureRigLayers,
	getAnimationRigProfile as getRuntimeAnimationRigProfile,
	getAnimationRigJobRuntimeDiagnostics,
	getAnimationRigJobType,
	listAnimationRigJobTypes as listRegisteredAnimationRigJobTypes,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

function layers(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorRigLayers ??= []);
}

function resolveLayer(scene: Scene, layerId: string): any {
	const layer = layers(scene).find((candidate) => candidate.id === layerId);
	if (!layer) {
		throw new Error(`Rig layer "${layerId}" was not found.`);
	}
	return layer;
}

function resolveSkeleton(scene: Scene, skeletonId: string): Skeleton {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === skeletonId);
	if (!skeleton) {
		throw new Error(`Skeleton "${skeletonId}" was not found.`);
	}
	return skeleton;
}

function resolveBone(skeleton: Skeleton, boneName: string): Bone {
	const bone = skeleton.bones.find((candidate) => candidate.name === boneName);
	if (!bone) {
		throw new Error(`Bone "${boneName}" was not found in skeleton "${skeleton.name}".`);
	}
	return bone;
}

function boundMesh(scene: Scene, skeleton: Skeleton): TransformNode | undefined {
	return scene.meshes.find((candidate) => candidate.skeleton === skeleton);
}

function nodeRotation(node: TransformNode): Quaternion {
	node.computeWorldMatrix(true);
	if (node.absoluteRotationQuaternion) {
		return node.absoluteRotationQuaternion.clone();
	}
	const rotation = Quaternion.Identity();
	node.getWorldMatrix().decompose(undefined, rotation, undefined);
	return rotation;
}

function targetRotation(target: Bone | TransformNode): Quaternion {
	return target.rotationQuaternion?.clone() ?? Quaternion.FromEulerAngles(target.rotation.x, target.rotation.y, target.rotation.z);
}

function normalizeWeight(value: unknown, fallback = 1): number {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("Rig weights must be finite numbers from 0 through 1.");
	}
	return value;
}

function validateCustomJobJson(value: unknown, path = "jobData", depth = 0, state = { entries: 0 }): void {
	if (depth > 16) {
		throw new Error(`${path} exceeds the maximum JSON depth of 16.`);
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error(`${path} contains a non-finite number.`);
		}
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 1024) {
			throw new Error(`${path} contains more than 1024 array entries.`);
		}
		value.forEach((entry, index) => {
			state.entries++;
			validateCustomJobJson(entry, `${path}[${index}]`, depth + 1, state);
		});
		return;
	}
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error(`${path} must contain only JSON-compatible values.`);
	}
	for (const [key, entry] of Object.entries(value)) {
		if (!key || key.length > 128 || key === "__proto__" || key === "prototype" || key === "constructor") {
			throw new Error(`${path} contains an unsafe or oversized property name.`);
		}
		state.entries++;
		if (state.entries > 4096) {
			throw new Error("jobData contains more than 4096 values.");
		}
		validateCustomJobJson(entry, `${path}.${key}`, depth + 1, state);
	}
}

function normalizeCustomJobData(value: unknown): Record<string, unknown> {
	const data = value ?? {};
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("Custom Animation Rig jobData must be a JSON object.");
	}
	validateCustomJobJson(data);
	const serialized = JSON.stringify(data);
	if (serialized.length > 65536) {
		throw new Error("Custom Animation Rig jobData exceeds 64 KiB.");
	}
	return JSON.parse(serialized);
}

function normalizeCustomJobBindings(values: unknown, label: string, maximum: number): string[] {
	if (values === undefined) {
		return [];
	}
	if (!Array.isArray(values) || values.length > maximum || values.some((value) => typeof value !== "string" || !value.trim() || value.length > 512)) {
		throw new Error(`${label} must contain at most ${maximum} non-empty strings of at most 512 characters.`);
	}
	const normalized = values.map((value) => value.trim());
	if (new Set(normalized).size !== normalized.length) {
		throw new Error(`${label} must not contain duplicates.`);
	}
	return normalized;
}

function createCustomJobConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const jobType = String(data.jobType ?? "").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(jobType)) {
		throw new Error("Custom Animation Rig jobType must contain 1 through 128 safe identifier characters.");
	}
	const registered = getAnimationRigJobType(jobType);
	const jobVersion = data.jobVersion ?? registered?.dataVersion ?? 1;
	if (!Number.isInteger(jobVersion) || jobVersion < 1 || jobVersion > 100000) {
		throw new Error("Custom Animation Rig jobVersion must be an integer from 1 through 100000.");
	}
	const boneNames = normalizeCustomJobBindings(data.boneNames, "boneNames", 64);
	for (const boneName of boneNames) {
		resolveBone(skeleton, boneName);
	}
	const nodeIds = normalizeCustomJobBindings(data.nodeIds, "nodeIds", 64);
	for (const nodeId of nodeIds) {
		if (!(scene.getNodeById(nodeId) instanceof TransformNode)) {
			throw new Error(`Custom Animation Rig node binding "${nodeId}" was not found or is not a TransformNode.`);
		}
	}
	const jobData = normalizeCustomJobData(data.jobData ?? registered?.defaultData ?? {});
	return { jobType, jobVersion, boneNames, nodeIds, jobData };
}

function createMultiParentConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const bone = resolveBone(skeleton, data.boneName);
	const mesh = boundMesh(scene, skeleton);
	if (!mesh) {
		throw new Error(`Skeleton "${skeleton.name}" needs a bound mesh before authoring a multi-parent constraint.`);
	}
	const targetPosition = bone.getPosition(Space.WORLD, mesh);
	const targetWorldRotation = bone.getRotationQuaternion(Space.WORLD, mesh);
	if (!Array.isArray(data.sources) || data.sources.length < 1 || data.sources.length > 8) {
		throw new Error("A multi-parent constraint requires 1 through 8 source nodes.");
	}
	const sources = data.sources.map((source: any) => {
		const node = scene.getNodeById(source.nodeId);
		if (!(node instanceof TransformNode)) {
			throw new Error(`Multi-parent source node "${source.nodeId}" was not found or is not a TransformNode.`);
		}
		const inverse = node.computeWorldMatrix(true).clone().invert();
		const positionOffset = Vector3.TransformCoordinates(targetPosition, inverse);
		const rotationOffset = nodeRotation(node).conjugate().multiply(targetWorldRotation).normalize();
		return {
			nodeId: node.id,
			weight: normalizeWeight(source.weight),
			positionOffset: positionOffset.asArray(),
			rotationOffset: rotationOffset.asArray(),
		};
	});
	if (sources.every((source: any) => source.weight <= 0)) {
		throw new Error("At least one multi-parent source weight must be greater than zero.");
	}
	return { boneName: bone.name, sources };
}

function createTwistConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const sourceBone = resolveBone(skeleton, data.sourceBoneName);
	if (!Array.isArray(data.twistBones) || data.twistBones.length < 1 || data.twistBones.length > 16) {
		throw new Error("A twist constraint requires 1 through 16 twist bone entries.");
	}
	const axis = Array.isArray(data.axis) ? Vector3.FromArray(data.axis) : Vector3.Right();
	if (axis.lengthSquared() <= 1e-8) {
		throw new Error("Twist axis must be a non-zero XYZ vector.");
	}
	const sourceTarget = sourceBone.getTransformNode() ?? sourceBone;
	const twistBones = data.twistBones.map((item: any) => {
		const bone = resolveBone(skeleton, item.boneName);
		if (bone === sourceBone) {
			throw new Error("The twist source bone cannot also be a distributed twist bone.");
		}
		return {
			boneName: bone.name,
			weight: normalizeWeight(item.weight),
			restRotation: targetRotation(bone.getTransformNode() ?? bone).asArray(),
		};
	});
	if (twistBones.every((item: any) => item.weight <= 0)) {
		throw new Error("At least one distributed twist-bone weight must be greater than zero.");
	}
	return {
		sourceBoneName: sourceBone.name,
		sourceRestRotation: targetRotation(sourceTarget).asArray(),
		axis: axis.normalize().asArray(),
		twistBones,
	};
}

function resolveChain(skeleton: Skeleton, rootBoneName: string, tipBoneName: string): Bone[] {
	const root = resolveBone(skeleton, rootBoneName);
	let current: Bone | null = resolveBone(skeleton, tipBoneName);
	const reverse: Bone[] = [];
	while (current && reverse.length < 64) {
		reverse.push(current);
		if (current === root) {
			return reverse.reverse();
		}
		current = current.getParent();
	}
	throw new Error(`Chain IK root "${rootBoneName}" must be an ancestor of tip "${tipBoneName}", with at most 64 bones in the chain.`);
}

function normalizeIterations(value: unknown, fallback = 15): number {
	const normalized = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(normalized) || normalized < 1 || normalized > 64) {
		throw new Error("Chain IK maximum iterations must be an integer from 1 through 64.");
	}
	return normalized;
}

function normalizeTolerance(value: unknown, fallback = 0.01): number {
	const normalized = value === undefined ? fallback : Number(value);
	if (!Number.isFinite(normalized) || normalized < 0.0001 || normalized > 100) {
		throw new Error("Chain IK tolerance must be a finite distance from 0.0001 through 100 centimeters.");
	}
	return normalized;
}

function createChainIkConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const chain = resolveChain(skeleton, data.rootBoneName, data.tipBoneName);
	if (chain.length < 2) {
		throw new Error("A Chain IK constraint requires at least two bones from root through tip.");
	}
	const mesh = boundMesh(scene, skeleton);
	if (!mesh) {
		throw new Error(`Skeleton "${skeleton.name}" needs a bound mesh before authoring a Chain IK constraint.`);
	}
	const target = scene.getNodeById(data.targetNodeId);
	if (!(target instanceof TransformNode)) {
		throw new Error(`Chain IK target node "${data.targetNodeId}" was not found or is not a TransformNode.`);
	}
	skeleton.computeAbsoluteMatrices(true);
	const positions = chain.map((bone) => bone.getPosition(Space.WORLD, mesh));
	const lengths = positions.slice(0, -1).map((position, index) => Vector3.Distance(position, positions[index + 1]));
	if (lengths.some((length) => length <= 1e-6)) {
		throw new Error("Chain IK cannot use consecutive bones at the same world position.");
	}
	return {
		rootBoneName: chain[0].name,
		tipBoneName: chain[chain.length - 1].name,
		targetNodeId: target.id,
		maxIterations: normalizeIterations(data.maxIterations),
		tolerance: normalizeTolerance(data.tolerance),
		chainRotationWeight: normalizeWeight(data.chainRotationWeight),
		tipRotationWeight: normalizeWeight(data.tipRotationWeight, 0),
	};
}

function normalizeAxes(value: unknown): [boolean, boolean, boolean] {
	if (value === undefined) {
		return [true, true, true];
	}
	if (!Array.isArray(value) || value.length !== 3 || value.some((axis) => typeof axis !== "boolean") || value.every((axis) => axis === false)) {
		throw new Error("Position axes must contain three booleans with at least one enabled axis.");
	}
	return [value[0], value[1], value[2]];
}

function createWeightedSources(scene: Scene, sourcesData: any, targetPosition?: Vector3, maintainOffset = false): any[] {
	if (!Array.isArray(sourcesData) || sourcesData.length < 1 || sourcesData.length > 8) {
		throw new Error("A weighted rig constraint requires 1 through 8 source nodes.");
	}
	const sources = sourcesData.map((source: any) => {
		const node = scene.getNodeById(source.nodeId);
		if (!(node instanceof TransformNode)) {
			throw new Error(`Weighted source node "${source.nodeId}" was not found or is not a TransformNode.`);
		}
		const result: any = { nodeId: node.id, weight: normalizeWeight(source.weight) };
		if (targetPosition) {
			result.positionOffset = maintainOffset ? Vector3.TransformCoordinates(targetPosition, node.computeWorldMatrix(true).clone().invert()).asArray() : [0, 0, 0];
		}
		return result;
	});
	if (sources.every((source: any) => source.weight <= 0)) {
		throw new Error("At least one weighted source must have a weight greater than zero.");
	}
	return sources;
}

function weightedNodePosition(scene: Scene, sources: any[], useOffsets = false): Vector3 {
	const values = sources
		.map((source) => ({ node: scene.getNodeById(source.nodeId) as TransformNode | null, weight: source.weight, positionOffset: source.positionOffset }))
		.filter((source) => source.node && source.weight > 0) as Array<{ node: TransformNode; weight: number; positionOffset?: number[] }>;
	const total = values.reduce((sum, source) => sum + source.weight, 0);
	return values.reduce((position, source) => {
		const value = useOffsets
			? Vector3.TransformCoordinates(Vector3.FromArray(source.positionOffset ?? [0, 0, 0]), source.node.computeWorldMatrix(true))
			: source.node.getAbsolutePosition();
		return position.addInPlace(value.scale(source.weight / total));
	}, Vector3.Zero());
}

function aimRotation(aimAxis: Vector3, upAxis: Vector3, direction: Vector3, worldUpAxis: Vector3): Quaternion {
	if (aimAxis.lengthSquared() <= 1e-8 || upAxis.lengthSquared() <= 1e-8 || direction.lengthSquared() <= 1e-8 || worldUpAxis.lengthSquared() <= 1e-8) {
		throw new Error("Multi-Aim axes and target direction must be non-zero.");
	}
	const localAim = aimAxis.normalize();
	const localUp = upAxis.subtract(localAim.scale(Vector3.Dot(upAxis, localAim)));
	if (localUp.lengthSquared() <= 1e-8) {
		throw new Error("Multi-Aim local aim and up axes cannot be parallel.");
	}
	localUp.normalize();
	const worldAim = direction.normalize();
	let worldUp = worldUpAxis.subtract(worldAim.scale(Vector3.Dot(worldUpAxis, worldAim)));
	if (worldUp.lengthSquared() <= 1e-8) {
		const fallback = Math.abs(worldAim.y) < 0.99 ? Vector3.Up() : Vector3.Right();
		worldUp = fallback.subtract(worldAim.scale(Vector3.Dot(fallback, worldAim)));
	}
	worldUp.normalize();
	const localBasis = Quaternion.RotationQuaternionFromAxis(localAim, localUp, Vector3.Cross(localAim, localUp).normalize());
	const worldBasis = Quaternion.RotationQuaternionFromAxis(worldAim, worldUp, Vector3.Cross(worldAim, worldUp).normalize());
	return worldBasis.multiply(localBasis.conjugate()).normalize();
}

function createMultiPositionConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const bone = resolveBone(skeleton, data.boneName);
	const mesh = boundMesh(scene, skeleton);
	if (!mesh) {
		throw new Error(`Skeleton "${skeleton.name}" needs a bound mesh before authoring a Multi-Position constraint.`);
	}
	const maintainOffset = data.maintainOffset !== false;
	const targetPosition = bone.getPosition(Space.WORLD, mesh);
	return {
		boneName: bone.name,
		maintainOffset,
		positionAxes: normalizeAxes(data.positionAxes),
		sources: createWeightedSources(scene, data.sources, targetPosition, maintainOffset),
	};
}

function createMultiAimConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const bone = resolveBone(skeleton, data.boneName);
	const mesh = boundMesh(scene, skeleton);
	if (!mesh) {
		throw new Error(`Skeleton "${skeleton.name}" needs a bound mesh before authoring a Multi-Aim constraint.`);
	}
	const sources = createWeightedSources(scene, data.sources);
	const aimAxis = Array.isArray(data.aimAxis) ? Vector3.FromArray(data.aimAxis) : Vector3.Right();
	const upAxis = Array.isArray(data.upAxis) ? Vector3.FromArray(data.upAxis) : Vector3.Up();
	const worldUpAxis = Array.isArray(data.worldUpAxis) ? Vector3.FromArray(data.worldUpAxis) : Vector3.Up();
	const position = bone.getPosition(Space.WORLD, mesh);
	const base = aimRotation(aimAxis, upAxis, weightedNodePosition(scene, sources).subtract(position), worldUpAxis);
	const maintainOffset = data.maintainOffset !== false;
	const currentRotation = bone.getRotationQuaternion(Space.WORLD, mesh);
	return {
		boneName: bone.name,
		maintainOffset,
		aimAxis: aimAxis.normalize().asArray(),
		upAxis: upAxis.normalize().asArray(),
		worldUpAxis: worldUpAxis.normalize().asArray(),
		rotationOffset: (maintainOffset ? base.conjugate().multiply(currentRotation).normalize() : Quaternion.Identity()).asArray(),
		sources,
	};
}

function createFullBodyIkConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const root = resolveBone(skeleton, data.rootBoneName);
	const mesh = boundMesh(scene, skeleton);
	if (!mesh) {
		throw new Error(`Skeleton "${skeleton.name}" needs a bound mesh before authoring Full-Body IK.`);
	}
	if (!Array.isArray(data.effectors) || data.effectors.length < 1 || data.effectors.length > 8) {
		throw new Error("Full-Body IK requires 1 through 8 effector entries.");
	}
	const usedBones = new Set<string>();
	skeleton.computeAbsoluteMatrices(true);
	const effectors = data.effectors.map((item: any) => {
		if (usedBones.has(item.boneName)) {
			throw new Error(`Full-Body IK effector bone "${item.boneName}" is duplicated.`);
		}
		usedBones.add(item.boneName);
		let path: Bone[];
		try {
			path = resolveChain(skeleton, root.name, item.boneName);
		} catch {
			throw new Error(`Full-Body IK root "${root.name}" must be an ancestor of effector bone "${item.boneName}", with at most 64 bones in the path.`);
		}
		if (path.length < 2) {
			throw new Error("A Full-Body IK effector cannot target the solver root itself.");
		}
		const positions = path.map((bone) => bone.getPosition(Space.WORLD, mesh));
		if (positions.slice(0, -1).some((position, index) => Vector3.Distance(position, positions[index + 1]) <= 1e-6)) {
			throw new Error(`Full-Body IK effector path to "${item.boneName}" contains consecutive bones at the same world position.`);
		}
		const target = scene.getNodeById(item.targetNodeId);
		if (!(target instanceof TransformNode)) {
			throw new Error(`Full-Body IK target node "${item.targetNodeId}" was not found or is not a TransformNode.`);
		}
		const positionWeight = normalizeWeight(item.positionWeight);
		const rotationWeight = normalizeWeight(item.rotationWeight, 0);
		if (positionWeight <= 0 && rotationWeight <= 0) {
			throw new Error(`Full-Body IK effector "${item.boneName}" needs a position or rotation weight greater than zero.`);
		}
		return { boneName: path[path.length - 1].name, targetNodeId: target.id, positionWeight, rotationWeight };
	});
	const maxIterations = data.maxIterations === undefined ? 12 : Number(data.maxIterations);
	if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 64) {
		throw new Error("Full-Body IK maximum iterations must be an integer from 1 through 64.");
	}
	const tolerance = data.tolerance === undefined ? 0.1 : Number(data.tolerance);
	if (!Number.isFinite(tolerance) || tolerance < 0.0001 || tolerance > 100) {
		throw new Error("Full-Body IK tolerance must be a finite distance from 0.0001 through 100 centimeters.");
	}
	return { rootBoneName: root.name, maxIterations, tolerance, effectors };
}

function normalizeTransformAxes(value: unknown, label: string): [boolean, boolean, boolean] {
	if (value === undefined) {
		return [true, true, true];
	}
	if (!Array.isArray(value) || value.length !== 3 || value.some((axis) => typeof axis !== "boolean")) {
		throw new Error(`${label} axes must contain exactly three booleans for X, Y, and Z.`);
	}
	return [value[0], value[1], value[2]];
}

function captureTransformSource(scene: Scene, nodeId: string, targetPosition: Vector3, targetRotation: Quaternion, maintainOffset: boolean): any {
	const node = scene.getNodeById(nodeId);
	if (!(node instanceof TransformNode)) {
		throw new Error(`Transform constraint source node "${nodeId}" was not found or is not a TransformNode.`);
	}
	const positionOffset = maintainOffset ? Vector3.TransformCoordinates(targetPosition, node.computeWorldMatrix(true).clone().invert()) : Vector3.Zero();
	const rotationOffset = maintainOffset ? nodeRotation(node).conjugate().multiply(targetRotation).normalize() : Quaternion.Identity();
	return { nodeId: node.id, positionOffset: positionOffset.asArray(), rotationOffset: rotationOffset.asArray() };
}

function transformWeights(data: any): any {
	const positionWeight = normalizeWeight(data.positionWeight);
	const rotationWeight = normalizeWeight(data.rotationWeight);
	const positionAxes = normalizeTransformAxes(data.positionAxes, "Position");
	const rotationAxes = normalizeTransformAxes(data.rotationAxes, "Rotation");
	if (positionWeight > 0 && positionAxes.every((axis) => !axis)) {
		throw new Error("Position weight requires at least one enabled position axis.");
	}
	if (rotationWeight > 0 && rotationAxes.every((axis) => !axis)) {
		throw new Error("Rotation weight requires at least one enabled rotation axis.");
	}
	if (positionWeight <= 0 && rotationWeight <= 0) {
		throw new Error("A transform constraint needs a position or rotation weight greater than zero.");
	}
	return { positionWeight, rotationWeight, positionAxes, rotationAxes };
}

function createOverrideTransformConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const bone = resolveBone(skeleton, data.boneName);
	const mesh = boundMesh(scene, skeleton);
	if (!mesh) {
		throw new Error(`Skeleton "${skeleton.name}" needs a bound mesh before authoring an Override Transform constraint.`);
	}
	skeleton.computeAbsoluteMatrices(true);
	const maintainOffset = data.maintainOffset !== false;
	const source = captureTransformSource(scene, data.sourceNodeId, bone.getPosition(Space.WORLD, mesh), bone.getRotationQuaternion(Space.WORLD, mesh), maintainOffset);
	return {
		boneName: bone.name,
		sourceNodeId: source.nodeId,
		maintainOffset,
		positionOffset: source.positionOffset,
		rotationOffset: source.rotationOffset,
		...transformWeights(data),
	};
}

function createDampedTransformConfig(scene: Scene, layer: any, data: any): any {
	const result = createOverrideTransformConfig(scene, layer, data);
	const positionDamping = normalizeWeight(data.positionDamping, 0.5);
	const rotationDamping = normalizeWeight(data.rotationDamping, 0.5);
	return { ...result, positionDamping, rotationDamping };
}

function createBlendTransformConfig(scene: Scene, layer: any, data: any): any {
	const skeleton = resolveSkeleton(scene, layer.skeletonId);
	const bone = resolveBone(skeleton, data.boneName);
	const mesh = boundMesh(scene, skeleton);
	if (!mesh) {
		throw new Error(`Skeleton "${skeleton.name}" needs a bound mesh before authoring a Blend Transform constraint.`);
	}
	if (data.sourceNodeIdA === data.sourceNodeIdB) {
		throw new Error("Blend Transform requires two different source nodes.");
	}
	skeleton.computeAbsoluteMatrices(true);
	const maintainOffset = data.maintainOffset !== false;
	const position = bone.getPosition(Space.WORLD, mesh);
	const rotation = bone.getRotationQuaternion(Space.WORLD, mesh);
	const sourceA = captureTransformSource(scene, data.sourceNodeIdA, position, rotation, maintainOffset);
	const sourceB = captureTransformSource(scene, data.sourceNodeIdB, position, rotation, maintainOffset);
	return {
		boneName: bone.name,
		sourceNodeIdA: sourceA.nodeId,
		sourceNodeIdB: sourceB.nodeId,
		maintainOffset,
		positionOffsetA: sourceA.positionOffset,
		rotationOffsetA: sourceA.rotationOffset,
		positionOffsetB: sourceB.positionOffset,
		rotationOffsetB: sourceB.rotationOffset,
		blend: normalizeWeight(data.blend, 0.5),
		...transformWeights(data),
	};
}

function chainResult(scene: Scene, layer: any, constraint: any): any {
	try {
		const skeleton = resolveSkeleton(scene, layer.skeletonId);
		const chain = resolveChain(skeleton, constraint.rootBoneName, constraint.tipBoneName);
		const mesh = boundMesh(scene, skeleton);
		const target = scene.getNodeById(constraint.targetNodeId);
		if (!mesh || !(target instanceof TransformNode) || chain.length < 2) {
			return { valid: false, chainBoneCount: chain.length };
		}
		skeleton.computeAbsoluteMatrices(true);
		const positions = chain.map((bone) => bone.getPosition(Space.WORLD, mesh));
		const chainLength = positions.slice(0, -1).reduce((total, position, index) => total + Vector3.Distance(position, positions[index + 1]), 0);
		const targetDistance = Vector3.Distance(positions[0], target.getAbsolutePosition());
		return {
			valid: chainLength > 1e-6,
			chainBoneCount: chain.length,
			chainLength,
			targetDistance,
			targetReachable: targetDistance <= chainLength + constraint.tolerance,
			tipError: Vector3.Distance(positions[positions.length - 1], target.getAbsolutePosition()),
		};
	} catch {
		return { valid: false, chainBoneCount: 0 };
	}
}

function fullBodyIkResult(scene: Scene, layer: any, constraint: any): any {
	try {
		const skeleton = resolveSkeleton(scene, layer.skeletonId);
		const root = resolveBone(skeleton, constraint.rootBoneName);
		const mesh = boundMesh(scene, skeleton);
		if (!mesh || !Array.isArray(constraint.effectors)) {
			return { valid: false, effectorCount: 0, activeEffectorCount: 0, reachedEffectorCount: 0 };
		}
		skeleton.computeAbsoluteMatrices(true);
		const effectors = constraint.effectors.map((item: any) => {
			try {
				const path = resolveChain(skeleton, root.name, item.boneName);
				const target = scene.getNodeById(item.targetNodeId);
				if (path.length < 2 || !(target instanceof TransformNode)) {
					return { ...structuredClone(item), valid: false, error: null, reachable: false };
				}
				const positions = path.map((bone) => bone.getPosition(Space.WORLD, mesh));
				const chainLength = positions.slice(0, -1).reduce((total, position, index) => total + Vector3.Distance(position, positions[index + 1]), 0);
				const targetDistance = Vector3.Distance(positions[0], target.getAbsolutePosition());
				const error = Vector3.Distance(positions[positions.length - 1], target.getAbsolutePosition());
				return {
					...structuredClone(item),
					valid: chainLength > 1e-6,
					pathBoneCount: path.length,
					chainLength,
					targetDistance,
					reachable: targetDistance <= chainLength + constraint.tolerance,
					error,
					reached: error <= constraint.tolerance,
				};
			} catch {
				return { ...structuredClone(item), valid: false, error: null, reachable: false };
			}
		});
		const active = effectors.filter((item: any) => item.valid && (item.positionWeight > 0 || item.rotationWeight > 0));
		const errors = active.map((item: any) => item.error).filter((error: any) => typeof error === "number") as number[];
		return {
			valid: active.length === effectors.length && active.length > 0,
			effectorCount: effectors.length,
			activeEffectorCount: active.length,
			reachedEffectorCount: active.filter((item: any) => item.reached).length,
			averageError: errors.length ? errors.reduce((total, error) => total + error, 0) / errors.length : null,
			maximumError: errors.length ? Math.max(...errors) : null,
			effectors,
		};
	} catch {
		return { valid: false, effectorCount: 0, activeEffectorCount: 0, reachedEffectorCount: 0, effectors: [] };
	}
}

function transformConstraintResult(scene: Scene, layer: any, constraint: any): any {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === layer.skeletonId);
	const bone = skeleton?.bones.find((candidate) => candidate.name === constraint.boneName);
	const mesh = skeleton ? boundMesh(scene, skeleton) : undefined;
	if (!skeleton || !bone || !mesh) {
		return { valid: false, positionError: null, rotationErrorDegrees: null };
	}
	const resolveSource = (nodeId: string, positionOffset: any, rotationOffset: any): { position: Vector3; rotation: Quaternion } | null => {
		const node = scene.getNodeById(nodeId);
		if (!(node instanceof TransformNode)) {
			return null;
		}
		return {
			position: Vector3.TransformCoordinates(Vector3.FromArray(positionOffset ?? [0, 0, 0]), node.computeWorldMatrix(true)),
			rotation: nodeRotation(node)
				.multiply(Quaternion.FromArray(rotationOffset ?? [0, 0, 0, 1]))
				.normalize(),
		};
	};
	const sourceA = resolveSource(
		constraint.type === "blendTransform" ? constraint.sourceNodeIdA : constraint.sourceNodeId,
		constraint.type === "blendTransform" ? constraint.positionOffsetA : constraint.positionOffset,
		constraint.type === "blendTransform" ? constraint.rotationOffsetA : constraint.rotationOffset
	);
	const sourceB = constraint.type === "blendTransform" ? resolveSource(constraint.sourceNodeIdB, constraint.positionOffsetB, constraint.rotationOffsetB) : null;
	if (!sourceA || (constraint.type === "blendTransform" && !sourceB)) {
		return { valid: false, positionError: null, rotationErrorDegrees: null };
	}
	skeleton.computeAbsoluteMatrices(true);
	const desiredPosition = sourceB ? Vector3.Lerp(sourceA.position, sourceB.position, constraint.blend) : sourceA.position;
	const desiredRotation = sourceB ? Quaternion.Slerp(sourceA.rotation, sourceB.rotation, constraint.blend).normalize() : sourceA.rotation;
	const currentPosition = bone.getPosition(Space.WORLD, mesh);
	const delta = desiredPosition.subtract(currentPosition);
	const positionAxes = constraint.positionAxes ?? [true, true, true];
	if (!positionAxes[0]) {
		delta.x = 0;
	}
	if (!positionAxes[1]) {
		delta.y = 0;
	}
	if (!positionAxes[2]) {
		delta.z = 0;
	}
	const currentRotation = bone.getRotationQuaternion(Space.WORLD, mesh);
	const rotationErrorDegrees = Tools.ToDegrees(2 * Math.acos(Math.min(1, Math.abs(Quaternion.Dot(currentRotation.normalize(), desiredRotation.normalize())))));
	return {
		valid: true,
		positionError: delta.length(),
		rotationErrorDegrees,
		sourceCount: sourceB ? 2 : 1,
	};
}

function weightedConstraintResult(scene: Scene, layer: any, constraint: any): any {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === layer.skeletonId);
	const bone = skeleton?.bones.find((candidate) => candidate.name === constraint.boneName);
	const mesh = skeleton ? boundMesh(scene, skeleton) : undefined;
	const activeSources = Array.isArray(constraint.sources)
		? constraint.sources.filter((source: any) => source.weight > 0 && scene.getNodeById(source.nodeId) instanceof TransformNode)
		: [];
	if (!bone || !mesh || !activeSources.length) {
		return { valid: false, sourceCount: Array.isArray(constraint.sources) ? constraint.sources.length : 0, activeSourceCount: activeSources.length };
	}
	skeleton!.computeAbsoluteMatrices(true);
	const sourcePosition = weightedNodePosition(scene, activeSources);
	if (constraint.type === "multiPosition") {
		const current = bone.getPosition(Space.WORLD, mesh);
		const desired = weightedNodePosition(scene, activeSources, constraint.maintainOffset !== false);
		const axes = constraint.positionAxes ?? [true, true, true];
		if (axes[0] === false) {
			desired.x = current.x;
		}
		if (axes[1] === false) {
			desired.y = current.y;
		}
		if (axes[2] === false) {
			desired.z = current.z;
		}
		return {
			valid: true,
			sourceCount: constraint.sources.length,
			activeSourceCount: activeSources.length,
			positionError: Vector3.Distance(current, desired),
		};
	}
	const position = bone.getPosition(Space.WORLD, mesh);
	const direction = sourcePosition.subtract(position);
	const aimAxis = Vector3.FromArray(constraint.aimAxis);
	const worldRotation = bone.getRotationQuaternion(Space.WORLD, mesh);
	const currentAim = aimAxis.applyRotationQuaternion(worldRotation).normalize();
	const aimErrorDegrees = direction.lengthSquared() <= 1e-8 ? 0 : Tools.ToDegrees(Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(currentAim, direction.normalize())))));
	return {
		valid: direction.lengthSquared() > 1e-8,
		sourceCount: constraint.sources.length,
		activeSourceCount: activeSources.length,
		targetDistance: direction.length(),
		aimErrorDegrees,
	};
}

function constraintResult(scene: Scene, layer: any, constraint: any): any {
	const skeleton = scene.skeletons.find((candidate) => candidate.id === layer.skeletonId);
	const boneNames = new Set(skeleton?.bones.map((bone) => bone.name) ?? []);
	const validation =
		constraint.type === "multiParent"
			? { valid: boneNames.has(constraint.boneName) && constraint.sources.every((source: any) => !!scene.getNodeById(source.nodeId)) }
			: constraint.type === "twist"
				? { valid: boneNames.has(constraint.sourceBoneName) && constraint.twistBones.every((item: any) => boneNames.has(item.boneName)) }
				: constraint.type === "chainIk"
					? chainResult(scene, layer, constraint)
					: constraint.type === "multiPosition" || constraint.type === "multiAim"
						? weightedConstraintResult(scene, layer, constraint)
						: constraint.type === "fullBodyIk"
							? fullBodyIkResult(scene, layer, constraint)
							: constraint.type === "overrideTransform" || constraint.type === "dampedTransform" || constraint.type === "blendTransform"
								? transformConstraintResult(scene, layer, constraint)
								: constraint.type === "customJob"
									? getAnimationRigJobRuntimeDiagnostics(scene as any, layer, constraint)
									: { valid: false };
	return { ...structuredClone(constraint), ...validation };
}

/** Lists custom Animation Rig job types registered by loaded project scripts. */
export function listAnimationRigJobTypes(): any {
	return { jobTypes: listRegisteredAnimationRigJobTypes() };
}

function validateAnimationRigProfileSelection(scene: Scene, data: any): void {
	if (data.skeletonId !== undefined) {
		resolveSkeleton(scene, data.skeletonId);
	}
	if (data.constraintId !== undefined && data.layerId === undefined) {
		throw new Error("Animation Rig profile constraintId requires layerId.");
	}
	if (data.layerId !== undefined) {
		const layer = resolveLayer(scene, data.layerId);
		if (data.skeletonId !== undefined && layer.skeletonId !== data.skeletonId) {
			throw new Error(`Rig layer "${data.layerId}" does not belong to skeleton "${data.skeletonId}".`);
		}
		if (data.constraintId !== undefined && !layer.constraints.some((constraint: any) => constraint.id === data.constraintId)) {
			throw new Error(`Rig constraint "${data.constraintId}" was not found in layer "${data.layerId}".`);
		}
	}
}

/** Reads bounded shared-runtime Animation Rig CPU samples and hierarchical summaries. */
export function getAnimationRigProfile(scene: Scene, data: any = {}): any {
	validateAnimationRigProfileSelection(scene, data);
	return getRuntimeAnimationRigProfile(scene as any, {
		skeletonId: data.skeletonId,
		layerId: data.layerId,
		constraintId: data.constraintId,
		includeSamples: data.includeSamples === true,
		sampleOffset: data.sampleOffset,
		sampleLimit: data.sampleLimit,
	});
}

/** Enables/disables or bounds transient Animation Rig CPU sampling. */
export function setAnimationRigProfile(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.enabled === undefined && data.sampleCapacity === undefined && data.sampleEveryNEvaluations === undefined) {
		throw new Error("Provide enabled, sampleCapacity, or sampleEveryNEvaluations.");
	}
	const result = configureAnimationRigProfiler(scene as any, {
		enabled: data.enabled,
		sampleCapacity: data.sampleCapacity,
		sampleEveryNEvaluations: data.sampleEveryNEvaluations,
	});
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Clears transient Animation Rig profiler samples and summaries without changing its settings. */
export function clearAnimationRigProfile(scene: Scene, _data: any, options: IMCPActionOptions): any {
	const result = clearRuntimeAnimationRigProfile(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Lists deterministic rig layers, ordered constraints, reference validity, and current evaluator evidence. */
export function listRigLayers(scene: Scene, data: any = {}): any {
	const selected = data.skeletonId ? layers(scene).filter((layer) => layer.skeletonId === data.skeletonId) : layers(scene);
	const sorted = [...selected].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
	return {
		layers: sorted.map((layer) => ({
			...structuredClone(layer),
			constraints: layer.constraints.map((constraint: any) => constraintResult(scene, layer, constraint)),
		})),
	};
}

/** Creates a persisted weighted rig layer evaluated after animation in deterministic order. */
export function createRigLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const skeleton = resolveSkeleton(scene, data.skeletonId);
	const id = String(data.id ?? Tools.RandomId()).trim();
	if (!id || id.length > 256 || layers(scene).some((candidate) => candidate.id === id)) {
		throw new Error(`Rig layer id "${id}" is empty, too long, or already exists.`);
	}
	const layer = {
		id,
		name:
			String(data.name ?? `${skeleton.name} Rig`)
				.trim()
				.slice(0, 256) || `${skeleton.name} Rig`,
		skeletonId: skeleton.id,
		order: Number.isInteger(data.order) ? data.order : layers(scene).reduce((maximum, candidate) => Math.max(maximum, candidate.order ?? 0), -1) + 1,
		weight: normalizeWeight(data.weight),
		enabled: data.enabled !== false,
		constraints: [],
	};
	layers(scene).push(layer);
	configureRigLayers(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(layer);
}

/** Updates a rig layer's name, evaluation order, weight, or enabled state. */
export function setRigLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const layer = resolveLayer(scene, data.layerId);
	if (data.name !== undefined) {
		const name = String(data.name).trim();
		if (!name || name.length > 256) {
			throw new Error("Rig layer name must contain 1 through 256 characters.");
		}
		layer.name = name;
	}
	if (data.order !== undefined) {
		if (!Number.isInteger(data.order) || data.order < -1000 || data.order > 1000) {
			throw new Error("Rig layer order must be an integer from -1000 through 1000.");
		}
		layer.order = data.order;
	}
	if (data.weight !== undefined) {
		layer.weight = normalizeWeight(data.weight);
	}
	if (data.enabled !== undefined) {
		layer.enabled = data.enabled === true;
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(layer);
}

/** Deletes a rig layer and all constraints owned by that layer. */
export function deleteRigLayer(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = layers(scene).findIndex((candidate) => candidate.id === data.layerId);
	if (index === -1) {
		throw new Error(`Rig layer "${data.layerId}" was not found.`);
	}
	const [layer] = layers(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, layerId: layer.id, deletedConstraintCount: layer.constraints.length };
}

/** Creates an ordered multi-parent, twist-distribution, Chain IK, Multi-Position, Multi-Aim, or Full-Body IK constraint inside one rig layer. */
export function createRigConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const layer = resolveLayer(scene, data.layerId);
	const id = String(data.id ?? Tools.RandomId()).trim();
	if (!id || id.length > 256 || layer.constraints.some((candidate: any) => candidate.id === id)) {
		throw new Error(`Rig constraint id "${id}" is empty, too long, or already exists in this layer.`);
	}
	if (
		data.type !== "multiParent" &&
		data.type !== "twist" &&
		data.type !== "chainIk" &&
		data.type !== "multiPosition" &&
		data.type !== "multiAim" &&
		data.type !== "fullBodyIk" &&
		data.type !== "overrideTransform" &&
		data.type !== "dampedTransform" &&
		data.type !== "blendTransform" &&
		data.type !== "customJob"
	) {
		throw new Error("Unsupported rig constraint type.");
	}
	const typeConfig =
		data.type === "multiParent"
			? createMultiParentConfig(scene, layer, data)
			: data.type === "twist"
				? createTwistConfig(scene, layer, data)
				: data.type === "chainIk"
					? createChainIkConfig(scene, layer, data)
					: data.type === "multiPosition"
						? createMultiPositionConfig(scene, layer, data)
						: data.type === "multiAim"
							? createMultiAimConfig(scene, layer, data)
							: data.type === "fullBodyIk"
								? createFullBodyIkConfig(scene, layer, data)
								: data.type === "overrideTransform"
									? createOverrideTransformConfig(scene, layer, data)
									: data.type === "dampedTransform"
										? createDampedTransformConfig(scene, layer, data)
										: data.type === "blendTransform"
											? createBlendTransformConfig(scene, layer, data)
											: createCustomJobConfig(scene, layer, data);
	const constraint = {
		id,
		name: String(
			data.name ??
				(data.type === "multiParent"
					? "Multi-Parent"
					: data.type === "twist"
						? "Twist"
						: data.type === "chainIk"
							? "Chain IK"
							: data.type === "multiPosition"
								? "Multi-Position"
								: data.type === "multiAim"
									? "Multi-Aim"
									: data.type === "fullBodyIk"
										? "Full-Body IK"
										: data.type === "overrideTransform"
											? "Override Transform"
											: data.type === "dampedTransform"
												? "Damped Transform"
												: data.type === "blendTransform"
													? "Blend Transform"
													: "Custom Animation Job")
		)
			.trim()
			.slice(0, 256),
		type: data.type,
		weight: normalizeWeight(data.weight),
		enabled: data.enabled !== false,
		...typeConfig,
	};
	layer.constraints.push(constraint);
	configureRigLayers(scene as any);
	applyRigLayers(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return constraintResult(scene, layer, constraint);
}

/** Updates common weight/enabled/name fields or recaptures type-specific source/rest offsets. */
export function setRigConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const layer = resolveLayer(scene, data.layerId);
	const constraint = layer.constraints.find((candidate: any) => candidate.id === data.constraintId);
	if (!constraint) {
		throw new Error(`Rig constraint "${data.constraintId}" was not found in layer "${layer.id}".`);
	}
	if (data.name !== undefined) {
		const name = String(data.name).trim();
		if (!name || name.length > 256) {
			throw new Error("Rig constraint name must contain 1 through 256 characters.");
		}
		constraint.name = name;
	}
	if (data.weight !== undefined) {
		constraint.weight = normalizeWeight(data.weight);
	}
	if (data.enabled !== undefined) {
		constraint.enabled = data.enabled === true;
	}
	if (constraint.type === "multiParent" && data.sources !== undefined) {
		Object.assign(constraint, createMultiParentConfig(scene, layer, { boneName: constraint.boneName, sources: data.sources }));
	}
	if (constraint.type === "twist" && (data.axis !== undefined || data.twistBones !== undefined || data.sourceBoneName !== undefined)) {
		Object.assign(
			constraint,
			createTwistConfig(scene, layer, {
				sourceBoneName: data.sourceBoneName ?? constraint.sourceBoneName,
				axis: data.axis ?? constraint.axis,
				twistBones: data.twistBones ?? constraint.twistBones,
			})
		);
	}
	if (
		constraint.type === "chainIk" &&
		(data.rootBoneName !== undefined ||
			data.tipBoneName !== undefined ||
			data.targetNodeId !== undefined ||
			data.maxIterations !== undefined ||
			data.tolerance !== undefined ||
			data.chainRotationWeight !== undefined ||
			data.tipRotationWeight !== undefined)
	) {
		Object.assign(
			constraint,
			createChainIkConfig(scene, layer, {
				rootBoneName: data.rootBoneName ?? constraint.rootBoneName,
				tipBoneName: data.tipBoneName ?? constraint.tipBoneName,
				targetNodeId: data.targetNodeId ?? constraint.targetNodeId,
				maxIterations: data.maxIterations ?? constraint.maxIterations,
				tolerance: data.tolerance ?? constraint.tolerance,
				chainRotationWeight: data.chainRotationWeight ?? constraint.chainRotationWeight,
				tipRotationWeight: data.tipRotationWeight ?? constraint.tipRotationWeight,
			})
		);
	}
	if (
		constraint.type === "multiPosition" &&
		(data.sources !== undefined || data.positionAxes !== undefined || data.maintainOffset !== undefined || data.boneName !== undefined)
	) {
		Object.assign(
			constraint,
			createMultiPositionConfig(scene, layer, {
				boneName: data.boneName ?? constraint.boneName,
				sources: data.sources ?? constraint.sources,
				positionAxes: data.positionAxes ?? constraint.positionAxes,
				maintainOffset: data.maintainOffset ?? constraint.maintainOffset,
			})
		);
	}
	if (
		constraint.type === "multiAim" &&
		(data.sources !== undefined ||
			data.aimAxis !== undefined ||
			data.upAxis !== undefined ||
			data.worldUpAxis !== undefined ||
			data.maintainOffset !== undefined ||
			data.boneName !== undefined)
	) {
		Object.assign(
			constraint,
			createMultiAimConfig(scene, layer, {
				boneName: data.boneName ?? constraint.boneName,
				sources: data.sources ?? constraint.sources,
				aimAxis: data.aimAxis ?? constraint.aimAxis,
				upAxis: data.upAxis ?? constraint.upAxis,
				worldUpAxis: data.worldUpAxis ?? constraint.worldUpAxis,
				maintainOffset: data.maintainOffset ?? constraint.maintainOffset,
			})
		);
	}
	if (constraint.type === "fullBodyIk" && (data.rootBoneName !== undefined || data.effectors !== undefined || data.maxIterations !== undefined || data.tolerance !== undefined)) {
		Object.assign(
			constraint,
			createFullBodyIkConfig(scene, layer, {
				rootBoneName: data.rootBoneName ?? constraint.rootBoneName,
				effectors: data.effectors ?? constraint.effectors,
				maxIterations: data.maxIterations ?? constraint.maxIterations,
				tolerance: data.tolerance ?? constraint.tolerance,
			})
		);
	}
	if (
		(constraint.type === "overrideTransform" || constraint.type === "dampedTransform") &&
		(data.boneName !== undefined ||
			data.sourceNodeId !== undefined ||
			data.maintainOffset !== undefined ||
			data.positionWeight !== undefined ||
			data.rotationWeight !== undefined ||
			data.positionAxes !== undefined ||
			data.rotationAxes !== undefined ||
			data.positionDamping !== undefined ||
			data.rotationDamping !== undefined)
	) {
		const values = {
			boneName: data.boneName ?? constraint.boneName,
			sourceNodeId: data.sourceNodeId ?? constraint.sourceNodeId,
			maintainOffset: data.maintainOffset ?? constraint.maintainOffset,
			positionWeight: data.positionWeight ?? constraint.positionWeight,
			rotationWeight: data.rotationWeight ?? constraint.rotationWeight,
			positionAxes: data.positionAxes ?? constraint.positionAxes,
			rotationAxes: data.rotationAxes ?? constraint.rotationAxes,
			positionDamping: data.positionDamping ?? constraint.positionDamping,
			rotationDamping: data.rotationDamping ?? constraint.rotationDamping,
		};
		Object.assign(constraint, constraint.type === "dampedTransform" ? createDampedTransformConfig(scene, layer, values) : createOverrideTransformConfig(scene, layer, values));
	}
	if (
		constraint.type === "blendTransform" &&
		(data.boneName !== undefined ||
			data.sourceNodeIdA !== undefined ||
			data.sourceNodeIdB !== undefined ||
			data.maintainOffset !== undefined ||
			data.blend !== undefined ||
			data.positionWeight !== undefined ||
			data.rotationWeight !== undefined ||
			data.positionAxes !== undefined ||
			data.rotationAxes !== undefined)
	) {
		Object.assign(
			constraint,
			createBlendTransformConfig(scene, layer, {
				boneName: data.boneName ?? constraint.boneName,
				sourceNodeIdA: data.sourceNodeIdA ?? constraint.sourceNodeIdA,
				sourceNodeIdB: data.sourceNodeIdB ?? constraint.sourceNodeIdB,
				maintainOffset: data.maintainOffset ?? constraint.maintainOffset,
				blend: data.blend ?? constraint.blend,
				positionWeight: data.positionWeight ?? constraint.positionWeight,
				rotationWeight: data.rotationWeight ?? constraint.rotationWeight,
				positionAxes: data.positionAxes ?? constraint.positionAxes,
				rotationAxes: data.rotationAxes ?? constraint.rotationAxes,
			})
		);
	}
	if (
		constraint.type === "customJob" &&
		(data.jobType !== undefined || data.jobVersion !== undefined || data.boneNames !== undefined || data.nodeIds !== undefined || data.jobData !== undefined)
	) {
		Object.assign(
			constraint,
			createCustomJobConfig(scene, layer, {
				jobType: data.jobType ?? constraint.jobType,
				jobVersion: data.jobVersion ?? constraint.jobVersion,
				boneNames: data.boneNames ?? constraint.boneNames,
				nodeIds: data.nodeIds ?? constraint.nodeIds,
				jobData: data.jobData ?? constraint.jobData,
			})
		);
	}
	applyRigLayers(scene as any);
	options.editor.layout.inspector.forceUpdate();
	return constraintResult(scene, layer, constraint);
}

/** Deletes one ordered constraint from a rig layer. */
export function deleteRigConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const layer = resolveLayer(scene, data.layerId);
	const index = layer.constraints.findIndex((candidate: any) => candidate.id === data.constraintId);
	if (index === -1) {
		throw new Error(`Rig constraint "${data.constraintId}" was not found in layer "${layer.id}".`);
	}
	const [constraint] = layer.constraints.splice(index, 1);
	if (layer.graphPositions && typeof layer.graphPositions === "object") {
		delete layer.graphPositions[`constraint:${constraint.id}`];
	}
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, layerId: layer.id, constraintId: constraint.id };
}
