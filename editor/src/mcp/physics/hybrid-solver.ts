import { Color3, Mesh, MeshBuilder, PhysicsAggregate, PhysicsMotionType, PhysicsShapeType, Quaternion, Scene, StandardMaterial, Tools, Vector3 } from "babylonjs";
import {
	configureHybridPhysicsSolver,
	getHybridPhysicsSolverRuntime,
	hybridPhysicsSolverModel,
	IHybridPhysicsGearCoupling,
	IHybridPhysicsSolverConfiguration,
	normalizeHybridPhysicsSolverConfiguration,
	stepHybridPhysicsSolver,
} from "babylonjs-editor-tools";

import { registerUndoRedo } from "../../tools/undoredo";
import { IMCPActionOptions } from "../action";
import { createPhysicsConstraint, deletePhysicsConstraint, listPhysicsConstraints } from "./constraints";

interface IHybridPhysicsSampleRecord {
	id: string;
	name: string;
	revision: number;
	model: "bounded-chain-gears-sample-v1";
	nodeIds: string[];
	constraintIds: string[];
	couplingIds: string[];
	materialIds: string[];
}

interface IHybridPhysicsSnapshot {
	present: boolean;
	value?: unknown;
}

function readConfiguration(scene: Scene): IHybridPhysicsSolverConfiguration {
	const normalized = normalizeHybridPhysicsSolverConfiguration(scene.metadata?.babylonEditorHybridPhysicsSolver);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	return normalized.value;
}

function snapshot(scene: Scene): IHybridPhysicsSnapshot {
	return scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, "babylonEditorHybridPhysicsSolver")
		? { present: true, value: structuredClone(scene.metadata.babylonEditorHybridPhysicsSolver) }
		: { present: false };
}

function refresh(options: IMCPActionOptions): void {
	options.editor.layout.inspector.forceUpdate();
	options.editor.layout.preview.setRenderScene?.(true);
}

function restore(scene: Scene, value: IHybridPhysicsSnapshot, options: IMCPActionOptions): void {
	if (value.present) {
		scene.metadata ??= {};
		scene.metadata.babylonEditorHybridPhysicsSolver = structuredClone(value.value);
	} else if (scene.metadata) {
		delete scene.metadata.babylonEditorHybridPhysicsSolver;
	}
	configureHybridPhysicsSolver(scene as any);
	refresh(options);
}

function publish(scene: Scene, configuration: IHybridPhysicsSolverConfiguration, options: IMCPActionOptions, undoable = true): IHybridPhysicsSolverConfiguration {
	const normalized = normalizeHybridPhysicsSolverConfiguration(configuration);
	if (!normalized.ok) {
		throw new Error(normalized.error);
	}
	const before = snapshot(scene);
	scene.metadata ??= {};
	scene.metadata.babylonEditorHybridPhysicsSolver = structuredClone(normalized.value);
	const after = snapshot(scene);
	configureHybridPhysicsSolver(scene as any);
	if (undoable) {
		registerUndoRedo({ undo: () => restore(scene, before, options), redo: () => restore(scene, after, options) });
	}
	refresh(options);
	return normalized.value;
}

function assertRevision(scene: Scene, expectedRevision: unknown): IHybridPhysicsSolverConfiguration {
	const configuration = readConfiguration(scene);
	if (expectedRevision !== configuration.revision) {
		throw new Error(`Hybrid physics solver changed. Read it again and use expectedRevision ${configuration.revision}.`);
	}
	return configuration;
}

function samples(scene: Scene): IHybridPhysicsSampleRecord[] {
	return Array.isArray(scene.metadata?.babylonEditorHybridPhysicsSamples) ? scene.metadata.babylonEditorHybridPhysicsSamples : [];
}

function samplesForWrite(scene: Scene): IHybridPhysicsSampleRecord[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorHybridPhysicsSamples ??= []);
}

function getPhysicsMesh(scene: Scene, nodeId: string, label: string): Mesh {
	const mesh = scene.getMeshById(nodeId);
	if (!(mesh instanceof Mesh) || !mesh.physicsAggregate) {
		throw new Error(`${label} must reference a mesh with an enabled 3D physics body.`);
	}
	return mesh;
}

function normalizedAxis(value: number[], label: string): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3 || value.some((coordinate) => !Number.isFinite(coordinate))) {
		throw new Error(`${label} must contain three finite numbers.`);
	}
	const axis = Vector3.FromArray(value);
	if (axis.lengthSquared() < 0.000001) {
		throw new Error(`${label} must not be zero.`);
	}
	axis.normalize();
	return [axis.x, axis.y, axis.z];
}

function couplingFromData(data: any, id = data.id ?? Tools.RandomId()): IHybridPhysicsGearCoupling {
	return {
		id,
		name: data.name ?? "Gear Coupling",
		enabled: data.enabled ?? true,
		bodyANodeId: data.bodyANodeId,
		bodyBNodeId: data.bodyBNodeId,
		axisA: normalizedAxis(data.axisA ?? [0, 0, 1], "axisA"),
		axisB: normalizedAxis(data.axisB ?? [0, 0, 1], "axisB"),
		ratio: data.ratio ?? 1,
		targetVelocity: data.targetVelocity ?? 0,
		maximumImpulse: data.maximumImpulse ?? 100000,
	};
}

/** Reports the exact portable boundary and the automatic no-work fast path introduced for #750. */
export function getHybridPhysicsCapabilities(): any {
	return {
		model: hybridPhysicsSolverModel,
		configurationVersion: 1,
		maximumDirectRows: 256,
		maximumGearCouplings: 64,
		directJointTypes: ["ball", "distance", "hinge", "lock"],
		iterativeCollisionSolver: "Babylon/Havok",
		directSolver: "globally-coupled dense pivoted linear impulse solve",
		processingPolicy: "Direct processing runs only when an enabled direct joint or gear coupling produces a row.",
		samples: ["bounded-chain-gears-sample-v1"],
		sharedEditorAndExportRuntime: true,
		limitations: [
			"This is a portable supplemental solver and does not expose Unity Physics, Burst, ECS Jobs, package, binary, or numerical identity.",
			"Native Babylon/Havok remains responsible for contacts and the ordinary iterative joint pass; selected stiff rows receive a bounded coupled velocity correction afterward.",
		],
	};
}

/** Reads one detached exact configuration, all sample ownership records, and current non-mutating runtime evidence. */
export function getHybridPhysicsSolver(scene: Scene): any {
	return {
		persisted: Boolean(scene.metadata && Object.prototype.hasOwnProperty.call(scene.metadata, "babylonEditorHybridPhysicsSolver")),
		configuration: readConfiguration(scene),
		samples: structuredClone(samples(scene)),
		runtime: getHybridPhysicsSolverRuntime(scene as any),
	};
}

/** Applies one exact-revision solver patch with shared normalization and Undo/Redo. */
export function setHybridPhysicsSolver(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = assertRevision(scene, data.expectedRevision);
	const patch: Record<string, unknown> = {};
	for (const key of ["enabled", "positionErrorBias", "regularization", "maximumImpulse", "maximumRows"]) {
		if (data[key] !== undefined) {
			patch[key] = data[key];
		}
	}
	if (!Object.keys(patch).length) {
		throw new Error("Provide at least one hybrid physics solver setting to change.");
	}
	return { configuration: publish(scene, { ...current, ...patch, revision: current.revision + 1 }, options), runtime: getHybridPhysicsSolverRuntime(scene as any) };
}

/** Removes persisted solver settings only when no coupling or owned sample remains, restoring migration defaults on subsequent reads. */
export function resetHybridPhysicsSolver(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Resetting persisted hybrid physics solver settings is destructive. Retry with confirm: true.");
	}
	const current = assertRevision(scene, data.expectedRevision);
	if (current.gearCouplings.length || samples(scene).length) {
		throw new Error("Delete every hybrid gear coupling and owned Chain & Gears sample before resetting solver settings.");
	}
	const before = snapshot(scene);
	if (scene.metadata) {
		delete scene.metadata.babylonEditorHybridPhysicsSolver;
	}
	const after = snapshot(scene);
	registerUndoRedo({ undo: () => restore(scene, before, options), redo: () => restore(scene, after, options) });
	refresh(options);
	return { reset: true, persisted: false, configuration: readConfiguration(scene) };
}

/** Returns current solver evidence without advancing physics. */
export function getHybridPhysicsRuntime(scene: Scene): any {
	return { configurationRevision: readConfiguration(scene).revision, runtime: getHybridPhysicsSolverRuntime(scene as any), physicsAdvanced: false };
}

/** Executes the supplemental solve without advancing Havok, intended for paused deterministic verification. */
export function solveHybridPhysicsNow(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = assertRevision(scene, data.expectedRevision);
	const runtime = stepHybridPhysicsSolver(scene as any, data.deltaSeconds ?? 1 / 60);
	refresh(options);
	return { configurationRevision: current.revision, runtime, havokAdvanced: false };
}

/** Creates one exact-revision angular coupling solved in the same global system as selected stiff joints. */
export function createHybridPhysicsGearCoupling(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = assertRevision(scene, data.expectedRevision);
	getPhysicsMesh(scene, data.bodyANodeId, "bodyANodeId");
	getPhysicsMesh(scene, data.bodyBNodeId, "bodyBNodeId");
	const coupling = couplingFromData(data);
	if (current.gearCouplings.some((candidate) => candidate.id === coupling.id)) {
		throw new Error(`Hybrid physics gear coupling "${coupling.id}" already exists.`);
	}
	const configuration = publish(scene, { ...current, revision: current.revision + 1, gearCouplings: [...current.gearCouplings, coupling] }, options);
	return { coupling: structuredClone(coupling), configurationRevision: configuration.revision };
}

/** Replaces bounded fields on one exact coupling under the current solver revision. */
export function setHybridPhysicsGearCoupling(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = assertRevision(scene, data.expectedRevision);
	const index = current.gearCouplings.findIndex((candidate) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`Hybrid physics gear coupling "${data.id}" was not found.`);
	}
	const original = current.gearCouplings[index];
	const patch: Record<string, unknown> = {};
	for (const key of ["name", "enabled", "bodyANodeId", "bodyBNodeId", "axisA", "axisB", "ratio", "targetVelocity", "maximumImpulse"]) {
		if (data[key] !== undefined) {
			patch[key] = data[key];
		}
	}
	if (!Object.keys(patch).length) {
		throw new Error("Provide at least one gear coupling field to change.");
	}
	const coupling = couplingFromData({ ...original, ...patch }, original.id);
	getPhysicsMesh(scene, coupling.bodyANodeId, "bodyANodeId");
	getPhysicsMesh(scene, coupling.bodyBNodeId, "bodyBNodeId");
	const gearCouplings = structuredClone(current.gearCouplings);
	gearCouplings[index] = coupling;
	const configuration = publish(scene, { ...current, revision: current.revision + 1, gearCouplings }, options);
	return { coupling: structuredClone(coupling), configurationRevision: configuration.revision };
}

/** Deletes one exact coupling after explicit confirmation. */
export function deleteHybridPhysicsGearCoupling(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (data.confirm !== true) {
		throw new Error("Deleting a hybrid physics gear coupling is destructive. Retry with confirm: true.");
	}
	const current = assertRevision(scene, data.expectedRevision);
	if (!current.gearCouplings.some((candidate) => candidate.id === data.id)) {
		throw new Error(`Hybrid physics gear coupling "${data.id}" was not found.`);
	}
	const configuration = publish(
		scene,
		{ ...current, revision: current.revision + 1, gearCouplings: current.gearCouplings.filter((candidate) => candidate.id !== data.id) },
		options
	);
	return { deleted: true, id: data.id, configurationRevision: configuration.revision };
}

/** Selects which solver owns the supplemental stiff row while retaining the native Havok constraint for collision coupling. */
export function setPhysicsConstraintSolver(scene: Scene, data: any, options: IMCPActionOptions): any {
	const constraints = scene.metadata?.babylonEditorPhysicsConstraints;
	if (!Array.isArray(constraints)) {
		throw new Error(`Physics constraint "${data.id}" was not found.`);
	}
	const index = constraints.findIndex((candidate: any) => candidate.id === data.id);
	if (index === -1) {
		throw new Error(`Physics constraint "${data.id}" was not found.`);
	}
	const current = constraints[index];
	const revision = Number.isInteger(current.revision) && current.revision > 0 ? current.revision : 1;
	if (data.expectedRevision !== revision) {
		throw new Error(`Physics constraint changed. Read it again and use expectedRevision ${revision}.`);
	}
	if (data.solverMode === "direct" && !["ball", "distance", "hinge", "lock"].includes(current.type)) {
		throw new Error(`Direct supplemental solving supports ball, distance, hinge, and lock constraints; "${current.type}" remains iterative.`);
	}
	const before = structuredClone(current);
	const after = { ...current, solverMode: data.solverMode, revision: revision + 1 };
	constraints[index] = after;
	registerUndoRedo({
		undo: () => {
			constraints[index] = structuredClone(before);
		},
		redo: () => {
			constraints[index] = structuredClone(after);
		},
		action: () => refresh(options),
	});
	refresh(options);
	return { ...structuredClone(after), active: listPhysicsConstraints(scene).constraints.some((candidate: any) => candidate.id === data.id && candidate.active) };
}

function capsulePoint(index: number, count: number, halfStraight: number, radius: number): { position: Vector3; angle: number } {
	const perimeter = 4 * halfStraight + 2 * Math.PI * radius;
	let distance = (index / count) * perimeter;
	if (distance < 2 * halfStraight) {
		return { position: new Vector3(-halfStraight + distance, radius, 0), angle: 0 };
	}
	distance -= 2 * halfStraight;
	if (distance < Math.PI * radius) {
		const theta = Math.PI / 2 - distance / radius;
		return { position: new Vector3(halfStraight + Math.cos(theta) * radius, Math.sin(theta) * radius, 0), angle: theta - Math.PI / 2 };
	}
	distance -= Math.PI * radius;
	if (distance < 2 * halfStraight) {
		return { position: new Vector3(halfStraight - distance, -radius, 0), angle: Math.PI };
	}
	distance -= 2 * halfStraight;
	const theta = -Math.PI / 2 - distance / radius;
	return { position: new Vector3(-halfStraight + Math.cos(theta) * radius, Math.sin(theta) * radius, 0), angle: theta - Math.PI / 2 };
}

function makeMaterial(scene: Scene, name: string, color: Color3): StandardMaterial {
	const material = new StandardMaterial(name, scene);
	material.diffuseColor = color;
	material.specularColor = new Color3(0.15, 0.15, 0.15);
	return material;
}

function addAggregate(mesh: Mesh, shape: PhysicsShapeType, mass: number, motionType: PhysicsMotionType): void {
	const aggregate = new PhysicsAggregate(mesh, shape, { mass });
	aggregate.body.setMotionType(motionType);
	mesh.physicsAggregate = aggregate;
}

/** Creates a bounded editor-owned mechanism that combines direct stiff-link rows with native iterative contacts. */
export async function createChainGearsPhysicsSample(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const current = assertRevision(scene, data.expectedRevision);
	if (!scene.getPhysicsEngine()) {
		throw new Error("Enable the Babylon/Havok physics engine before creating the Chain & Gears sample.");
	}
	const id = data.id ?? Tools.RandomId();
	if (samples(scene).some((sample) => sample.id === id)) {
		throw new Error(`Hybrid physics sample "${id}" already exists.`);
	}
	const name = data.name ?? "Hybrid Chain & Gears";
	const linkCount = data.linkCount ?? 20;
	const center = Vector3.FromArray(data.position ?? [0, 220, 0]);
	const prefix = `Hybrid Chain Gears ${id}`;
	const nodeIds: string[] = [];
	const constraintIds: string[] = [];
	const couplingIds: string[] = [];
	const materialIds: string[] = [];
	const createdMeshes: Mesh[] = [];
	const createdMaterials: StandardMaterial[] = [];
	let publishedConfiguration: IHybridPhysicsSolverConfiguration | null = null;
	try {
		const chainMaterial = makeMaterial(scene, `${prefix} Chain Material`, new Color3(0.18, 0.48, 0.86));
		const gearMaterial = makeMaterial(scene, `${prefix} Gear Material`, new Color3(0.92, 0.48, 0.08));
		const frameMaterial = makeMaterial(scene, `${prefix} Frame Material`, new Color3(0.24, 0.25, 0.28));
		createdMaterials.push(chainMaterial, gearMaterial, frameMaterial);
		materialIds.push(...createdMaterials.map((material) => material.id));
		const gearPositions = [center.add(new Vector3(-120, 0, 0)), center.add(new Vector3(120, 0, 0))];
		const frames: Mesh[] = [];
		const gears: Mesh[] = [];
		for (let index = 0; index < 2; index++) {
			const frame = MeshBuilder.CreateBox(`${prefix} Frame ${index + 1}`, { size: 18 }, scene);
			frame.position.copyFrom(gearPositions[index]);
			frame.material = frameMaterial;
			frame.isVisible = data.showFrames === true;
			addAggregate(frame, PhysicsShapeType.BOX, 0, PhysicsMotionType.STATIC);
			const gear = MeshBuilder.CreateCylinder(`${prefix} Gear ${index + 1}`, { diameter: index === 0 ? 132 : 108, height: 30, tessellation: 24 }, scene);
			gear.position.copyFrom(gearPositions[index]);
			gear.rotationQuaternion = Quaternion.FromEulerAngles(Math.PI / 2, 0, 0);
			gear.material = gearMaterial;
			addAggregate(gear, PhysicsShapeType.CYLINDER, 45, PhysicsMotionType.DYNAMIC);
			frames.push(frame);
			gears.push(gear);
			createdMeshes.push(frame, gear);
			nodeIds.push(frame.id, gear.id);
			const constraint = createPhysicsConstraint(
				scene,
				{
					id: `${id}-gear-hinge-${index + 1}`,
					type: "hinge",
					parentNodeId: frame.id,
					childNodeId: gear.id,
					axisA: [0, 0, 1],
					axisB: [0, 1, 0],
					solverMode: "direct",
				},
				options
			);
			constraintIds.push(constraint.id);
		}
		const links: Mesh[] = [];
		const halfStraight = 120;
		const radius = 88;
		const perimeter = 4 * halfStraight + 2 * Math.PI * radius;
		const linkLength = Math.max(18, (perimeter / linkCount) * 0.82);
		for (let index = 0; index < linkCount; index++) {
			const sample = capsulePoint(index, linkCount, halfStraight, radius);
			const link = MeshBuilder.CreateBox(`${prefix} Link ${String(index + 1).padStart(2, "0")}`, { width: linkLength, height: 16, depth: 24 }, scene);
			link.position.copyFrom(center.add(sample.position));
			link.rotationQuaternion = Quaternion.RotationAxis(Vector3.Forward(), sample.angle);
			link.material = chainMaterial;
			addAggregate(link, PhysicsShapeType.BOX, 2.5, PhysicsMotionType.DYNAMIC);
			links.push(link);
			createdMeshes.push(link);
			nodeIds.push(link.id);
		}
		for (let index = 0; index < links.length; index++) {
			const first = links[index];
			const second = links[(index + 1) % links.length];
			first.computeWorldMatrix(true);
			second.computeWorldMatrix(true);
			const anchor = first.getAbsolutePosition().add(second.getAbsolutePosition()).scale(0.5);
			const pivotA = Vector3.TransformCoordinates(anchor, first.getWorldMatrix().clone().invert());
			const pivotB = Vector3.TransformCoordinates(anchor, second.getWorldMatrix().clone().invert());
			const constraint = createPhysicsConstraint(
				scene,
				{
					id: `${id}-chain-${String(index + 1).padStart(2, "0")}`,
					type: "ball",
					parentNodeId: first.id,
					childNodeId: second.id,
					pivotA: pivotA.asArray(),
					pivotB: pivotB.asArray(),
					collision: false,
					solverMode: "direct",
				},
				options
			);
			constraintIds.push(constraint.id);
		}
		const coupling = couplingFromData({
			id: `${id}-gear-coupling`,
			name: `${name} Gear Ratio`,
			bodyANodeId: gears[0].id,
			bodyBNodeId: gears[1].id,
			axisA: [0, 1, 0],
			axisB: [0, 1, 0],
			ratio: data.gearRatio ?? 1.22,
			targetVelocity: 0,
			maximumImpulse: data.maximumGearImpulse ?? 50000,
		});
		couplingIds.push(coupling.id);
		publishedConfiguration = publish(scene, { ...current, revision: current.revision + 1, gearCouplings: [...current.gearCouplings, coupling] }, options, false);
		gears[0].physicsAggregate!.body.setAngularVelocity(new Vector3(0, 0, data.driveVelocity ?? 1.5));
		const sample: IHybridPhysicsSampleRecord = {
			id,
			name,
			revision: 1,
			model: "bounded-chain-gears-sample-v1",
			nodeIds,
			constraintIds,
			couplingIds,
			materialIds,
		};
		samplesForWrite(scene).push(sample);
		await options.editor.layout.graph.refresh();
		options.editor.layout.inspector.setEditedObject(scene);
		return {
			created: true,
			sample: structuredClone(sample),
			configurationRevision: publishedConfiguration.revision,
			mechanism: { linkCount, gearCount: 2, directJointCount: constraintIds.length, iterativeContacts: true, automaticSolverCoupling: true },
		};
	} catch (error) {
		for (const constraintId of [...constraintIds].reverse()) {
			try {
				deletePhysicsConstraint(scene, { id: constraintId }, options);
			} catch {
				// Best-effort rollback continues so every remaining owned resource is attempted.
			}
		}
		if (publishedConfiguration) {
			scene.metadata!.babylonEditorHybridPhysicsSolver = structuredClone(current);
		}
		for (const mesh of [...createdMeshes].reverse()) {
			mesh.physicsAggregate?.dispose();
			mesh.dispose();
		}
		for (const material of createdMaterials) {
			material.dispose();
		}
		throw error;
	}
}

/** Removes only nodes, constraints, coupling, and materials owned by one exact sample record. */
export async function deleteChainGearsPhysicsSample(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	if (data.confirm !== true) {
		throw new Error("Deleting a Chain & Gears physics sample is destructive. Retry with confirm: true.");
	}
	const records = samplesForWrite(scene);
	const index = records.findIndex((sample) => sample.id === data.id);
	if (index === -1) {
		throw new Error(`Hybrid physics sample "${data.id}" was not found.`);
	}
	const sample = records[index];
	if (data.expectedRevision !== sample.revision) {
		throw new Error(`Hybrid physics sample changed. Read it again and use expectedRevision ${sample.revision}.`);
	}
	const current = assertRevision(scene, data.expectedConfigurationRevision);
	for (const constraintId of [...sample.constraintIds].reverse()) {
		if (scene.metadata?.babylonEditorPhysicsConstraints?.some((constraint: any) => constraint.id === constraintId)) {
			deletePhysicsConstraint(scene, { id: constraintId }, options);
		}
	}
	const configuration = publish(
		scene,
		{ ...current, revision: current.revision + 1, gearCouplings: current.gearCouplings.filter((coupling) => !sample.couplingIds.includes(coupling.id)) },
		options,
		false
	);
	for (const nodeId of [...sample.nodeIds].reverse()) {
		const mesh = scene.getMeshById(nodeId);
		mesh?.physicsAggregate?.dispose();
		mesh?.dispose();
	}
	for (const materialId of sample.materialIds) {
		const material = scene.getMaterialById(materialId);
		if (material && !scene.meshes.some((mesh) => mesh.material === material)) {
			material.dispose();
		}
	}
	records.splice(index, 1);
	await options.editor.layout.graph.refresh();
	options.editor.layout.inspector.setEditedObject(scene);
	return { deleted: true, id: sample.id, removedNodes: sample.nodeIds.length, removedConstraints: sample.constraintIds.length, configurationRevision: configuration.revision };
}
