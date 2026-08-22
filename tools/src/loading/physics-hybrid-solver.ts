import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Scene } from "@babylonjs/core/scene";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

export const hybridPhysicsSolverModel = "bounded-hybrid-direct-iterative-solver-v1" as const;

export interface IHybridPhysicsGearCoupling {
	id: string;
	name: string;
	enabled: boolean;
	bodyANodeId: string;
	bodyBNodeId: string;
	axisA: [number, number, number];
	axisB: [number, number, number];
	ratio: number;
	targetVelocity: number;
	maximumImpulse: number;
}

export interface IHybridPhysicsSolverConfiguration {
	version: 1;
	revision: number;
	enabled: boolean;
	positionErrorBias: number;
	regularization: number;
	maximumImpulse: number;
	maximumRows: number;
	gearCouplings: IHybridPhysicsGearCoupling[];
}

export interface IHybridPhysicsLinearBody {
	id: string;
	inverseMass: number;
	inverseInertia: number;
	linearVelocity: [number, number, number];
	angularVelocity: [number, number, number];
}

export interface IHybridPhysicsLinearRow {
	id: string;
	bodyAId: string;
	bodyBId: string;
	linearA: [number, number, number];
	angularA: [number, number, number];
	linearB: [number, number, number];
	angularB: [number, number, number];
	targetVelocity: number;
	positionError: number;
	maximumImpulse?: number;
}

export interface IHybridPhysicsLinearSolveResult {
	rowCount: number;
	maximumResidualBefore: number;
	maximumResidualAfter: number;
	impulses: number[];
	bodies: IHybridPhysicsLinearBody[];
}

export interface IHybridPhysicsRuntimeEvidence {
	model: typeof hybridPhysicsSolverModel;
	attached: boolean;
	frames: number;
	processedFrames: number;
	skippedFrames: number;
	directConstraintCount: number;
	gearCouplingCount: number;
	rowCount: number;
	truncatedRows: number;
	maximumResidualBefore: number;
	maximumResidualAfter: number;
	lastSolveDurationMs: number;
	lastDeltaSeconds: number;
	lastSkippedReason: string | null;
	iterativeCollisionSolver: "native-babylon-havok";
	directSolver: "bounded-dense-pivoted-linear-impulse";
}

interface IHybridPhysicsRuntimeOwner {
	observer: any | null;
	evidence: IHybridPhysicsRuntimeEvidence;
}

const owners = new WeakMap<Scene, IHybridPhysicsRuntimeOwner>();
const defaultConfiguration: IHybridPhysicsSolverConfiguration = {
	version: 1,
	revision: 1,
	enabled: true,
	positionErrorBias: 0.2,
	regularization: 0.000001,
	maximumImpulse: 100000,
	maximumRows: 128,
	gearCouplings: [],
};

function finiteNumber(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function vector3(value: unknown): value is [number, number, number] {
	return Array.isArray(value) && value.length === 3 && value.every((coordinate) => finiteNumber(coordinate, -1_000_000, 1_000_000));
}

function normalizedAxis(value: unknown): value is [number, number, number] {
	if (!vector3(value)) {
		return false;
	}
	const length = Math.hypot(value[0], value[1], value[2]);
	return length >= 0.999 && length <= 1.001;
}

function normalizeGearCoupling(value: unknown): IHybridPhysicsGearCoupling | null {
	const candidate = value as Partial<IHybridPhysicsGearCoupling> | null;
	if (
		!candidate ||
		typeof candidate.id !== "string" ||
		candidate.id.length < 1 ||
		candidate.id.length > 128 ||
		typeof candidate.name !== "string" ||
		candidate.name.length < 1 ||
		candidate.name.length > 128 ||
		typeof candidate.enabled !== "boolean" ||
		typeof candidate.bodyANodeId !== "string" ||
		!candidate.bodyANodeId ||
		typeof candidate.bodyBNodeId !== "string" ||
		!candidate.bodyBNodeId ||
		candidate.bodyANodeId === candidate.bodyBNodeId ||
		!normalizedAxis(candidate.axisA) ||
		!normalizedAxis(candidate.axisB) ||
		!finiteNumber(candidate.ratio, -100, 100) ||
		Math.abs(candidate.ratio) < 0.01 ||
		!finiteNumber(candidate.targetVelocity, -1000, 1000) ||
		!finiteNumber(candidate.maximumImpulse, 0.000001, 1_000_000)
	) {
		return null;
	}
	return {
		id: candidate.id,
		name: candidate.name,
		enabled: candidate.enabled,
		bodyANodeId: candidate.bodyANodeId,
		bodyBNodeId: candidate.bodyBNodeId,
		axisA: [...candidate.axisA],
		axisB: [...candidate.axisB],
		ratio: candidate.ratio,
		targetVelocity: candidate.targetVelocity,
		maximumImpulse: candidate.maximumImpulse,
	};
}

/** Returns one detached strict configuration, migrating absence to bounded v1 defaults without mutating source data. */
export function normalizeHybridPhysicsSolverConfiguration(value: unknown): { ok: true; value: IHybridPhysicsSolverConfiguration } | { ok: false; error: string } {
	if (value === undefined || value === null) {
		return { ok: true, value: structuredClone(defaultConfiguration) };
	}
	const candidate = value as Partial<IHybridPhysicsSolverConfiguration>;
	if (candidate.version !== undefined && candidate.version !== 1) {
		return { ok: false, error: "Hybrid physics solver version must be 1." };
	}
	if (candidate.revision !== undefined && (!Number.isInteger(candidate.revision) || candidate.revision < 1)) {
		return { ok: false, error: "Hybrid physics solver revision must be a positive integer." };
	}
	if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
		return { ok: false, error: "Hybrid physics solver enabled must be a boolean." };
	}
	if (candidate.positionErrorBias !== undefined && !finiteNumber(candidate.positionErrorBias, 0, 1)) {
		return { ok: false, error: "Hybrid physics positionErrorBias must be from 0 through 1." };
	}
	if (candidate.regularization !== undefined && !finiteNumber(candidate.regularization, 0.000000001, 0.1)) {
		return { ok: false, error: "Hybrid physics regularization must be from 1e-9 through 0.1." };
	}
	if (candidate.maximumImpulse !== undefined && !finiteNumber(candidate.maximumImpulse, 0.000001, 1_000_000)) {
		return { ok: false, error: "Hybrid physics maximumImpulse must be from 1e-6 through 1,000,000." };
	}
	if (candidate.maximumRows !== undefined && (!Number.isInteger(candidate.maximumRows) || candidate.maximumRows < 1 || candidate.maximumRows > 256)) {
		return { ok: false, error: "Hybrid physics maximumRows must be an integer from 1 through 256." };
	}
	if (candidate.gearCouplings !== undefined && (!Array.isArray(candidate.gearCouplings) || candidate.gearCouplings.length > 64)) {
		return { ok: false, error: "Hybrid physics gearCouplings must contain at most 64 entries." };
	}
	const gearCouplings: IHybridPhysicsGearCoupling[] = [];
	const ids = new Set<string>();
	for (const source of candidate.gearCouplings ?? []) {
		const coupling = normalizeGearCoupling(source);
		if (!coupling) {
			return { ok: false, error: "Hybrid physics gear coupling data is malformed or outside its bounds." };
		}
		if (ids.has(coupling.id)) {
			return { ok: false, error: `Hybrid physics gear coupling id "${coupling.id}" is duplicated.` };
		}
		ids.add(coupling.id);
		gearCouplings.push(coupling);
	}
	return {
		ok: true,
		value: {
			version: 1,
			revision: candidate.revision ?? 1,
			enabled: candidate.enabled ?? defaultConfiguration.enabled,
			positionErrorBias: candidate.positionErrorBias ?? defaultConfiguration.positionErrorBias,
			regularization: candidate.regularization ?? defaultConfiguration.regularization,
			maximumImpulse: candidate.maximumImpulse ?? defaultConfiguration.maximumImpulse,
			maximumRows: candidate.maximumRows ?? defaultConfiguration.maximumRows,
			gearCouplings,
		},
	};
}

function dot(a: readonly number[], b: readonly number[]): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function rowVelocity(row: IHybridPhysicsLinearRow, bodies: Map<string, IHybridPhysicsLinearBody>): number {
	const bodyA = bodies.get(row.bodyAId);
	const bodyB = bodies.get(row.bodyBId);
	return (
		(bodyA ? dot(row.linearA, bodyA.linearVelocity) + dot(row.angularA, bodyA.angularVelocity) : 0) +
		(bodyB ? dot(row.linearB, bodyB.linearVelocity) + dot(row.angularB, bodyB.angularVelocity) : 0)
	);
}

function rowMassContribution(first: IHybridPhysicsLinearRow, second: IHybridPhysicsLinearRow, body: IHybridPhysicsLinearBody, sideFirst: "A" | "B", sideSecond: "A" | "B"): number {
	return (
		body.inverseMass * dot(sideFirst === "A" ? first.linearA : first.linearB, sideSecond === "A" ? second.linearA : second.linearB) +
		body.inverseInertia * dot(sideFirst === "A" ? first.angularA : first.angularB, sideSecond === "A" ? second.angularA : second.angularB)
	);
}

function effectiveMass(first: IHybridPhysicsLinearRow, second: IHybridPhysicsLinearRow, bodies: Map<string, IHybridPhysicsLinearBody>): number {
	let result = 0;
	for (const [firstId, firstSide] of [
		[first.bodyAId, "A"],
		[first.bodyBId, "B"],
	] as const) {
		const body = bodies.get(firstId);
		if (!body) {
			continue;
		}
		if (second.bodyAId === firstId) {
			result += rowMassContribution(first, second, body, firstSide, "A");
		}
		if (second.bodyBId === firstId) {
			result += rowMassContribution(first, second, body, firstSide, "B");
		}
	}
	return result;
}

function solvePivoted(matrix: number[][], right: number[]): number[] {
	const size = right.length;
	const augmented = matrix.map((row, index) => [...row, right[index]]);
	for (let column = 0; column < size; column++) {
		let pivot = column;
		for (let row = column + 1; row < size; row++) {
			if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
				pivot = row;
			}
		}
		if (pivot !== column) {
			[augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
		}
		const divisor = augmented[column][column];
		if (Math.abs(divisor) < 1e-12) {
			continue;
		}
		for (let index = column; index <= size; index++) {
			augmented[column][index] /= divisor;
		}
		for (let row = 0; row < size; row++) {
			if (row === column) {
				continue;
			}
			const factor = augmented[row][column];
			if (Math.abs(factor) < 1e-15) {
				continue;
			}
			for (let index = column; index <= size; index++) {
				augmented[row][index] -= factor * augmented[column][index];
			}
		}
	}
	return augmented.map((row) => (Number.isFinite(row[size]) ? row[size] : 0));
}

/** Solves all selected joint/gear scalar rows together, then applies one globally coupled velocity impulse. */
export function solveHybridPhysicsLinearSystem(
	inputBodies: IHybridPhysicsLinearBody[],
	rows: IHybridPhysicsLinearRow[],
	deltaSeconds: number,
	settings: Pick<IHybridPhysicsSolverConfiguration, "positionErrorBias" | "regularization" | "maximumImpulse">
): IHybridPhysicsLinearSolveResult {
	const bodies = new Map(inputBodies.map((body) => [body.id, structuredClone(body)]));
	if (!rows.length) {
		return { rowCount: 0, maximumResidualBefore: 0, maximumResidualAfter: 0, impulses: [], bodies: [...bodies.values()] };
	}
	const safeDelta = Math.max(0.000001, deltaSeconds);
	const desired = rows.map((row) => row.targetVelocity - (settings.positionErrorBias * row.positionError) / safeDelta);
	const before = rows.map((row, index) => desired[index] - rowVelocity(row, bodies));
	const matrix = rows.map((first, row) => rows.map((second, column) => effectiveMass(first, second, bodies) + (row === column ? settings.regularization : 0)));
	const impulses = solvePivoted(matrix, before).map((impulse, index) => {
		const maximum = Math.min(settings.maximumImpulse, rows[index].maximumImpulse ?? settings.maximumImpulse);
		return Math.max(-maximum, Math.min(maximum, impulse));
	});
	for (const [rowIndex, row] of rows.entries()) {
		const impulse = impulses[rowIndex];
		for (const [bodyId, linear, angular] of [
			[row.bodyAId, row.linearA, row.angularA],
			[row.bodyBId, row.linearB, row.angularB],
		] as const) {
			const body = bodies.get(bodyId);
			if (!body) {
				continue;
			}
			for (let axis = 0; axis < 3; axis++) {
				body.linearVelocity[axis] += linear[axis] * impulse * body.inverseMass;
				body.angularVelocity[axis] += angular[axis] * impulse * body.inverseInertia;
			}
		}
	}
	const after = rows.map((row, index) => desired[index] - rowVelocity(row, bodies));
	return {
		rowCount: rows.length,
		maximumResidualBefore: Math.max(0, ...before.map(Math.abs)),
		maximumResidualAfter: Math.max(0, ...after.map(Math.abs)),
		impulses,
		bodies: [...bodies.values()],
	};
}

function initialEvidence(): IHybridPhysicsRuntimeEvidence {
	return {
		model: hybridPhysicsSolverModel,
		attached: true,
		frames: 0,
		processedFrames: 0,
		skippedFrames: 0,
		directConstraintCount: 0,
		gearCouplingCount: 0,
		rowCount: 0,
		truncatedRows: 0,
		maximumResidualBefore: 0,
		maximumResidualAfter: 0,
		lastSolveDurationMs: 0,
		lastDeltaSeconds: 0,
		lastSkippedReason: "No physics step has completed.",
		iterativeCollisionSolver: "native-babylon-havok",
		directSolver: "bounded-dense-pivoted-linear-impulse",
	};
}

function localVector(value: unknown, fallback: [number, number, number]): Vector3 {
	return Vector3.FromArray(vector3(value) ? value : fallback);
}

function array(vector: Vector3): [number, number, number] {
	return [vector.x, vector.y, vector.z];
}

function inverseInertia(body: any, inverseMass: number): number {
	const inertia = body.getMassProperties?.().inertia;
	if (!inertia) {
		return inverseMass;
	}
	const finite = [inertia.x, inertia.y, inertia.z].filter((value) => Number.isFinite(value) && value > 0);
	return finite.length ? finite.reduce((sum, value) => sum + 1 / value, 0) / finite.length : inverseMass;
}

function buildRuntimeRows(
	scene: Scene,
	configuration: IHybridPhysicsSolverConfiguration
): { rows: IHybridPhysicsLinearRow[]; directConstraintCount: number; gearCouplingCount: number } {
	const rows: IHybridPhysicsLinearRow[] = [];
	const constraints = Array.isArray(scene.metadata?.babylonEditorPhysicsConstraints) ? scene.metadata.babylonEditorPhysicsConstraints : [];
	const directConstraints = constraints.filter((constraint: any) => constraint?.solverMode === "direct");
	const axes = [Vector3.Right(), Vector3.Up(), Vector3.Forward()];
	for (const constraint of directConstraints) {
		const meshA = scene.getMeshById(constraint.parentNodeId);
		const meshB = scene.getMeshById(constraint.childNodeId);
		if (!meshA?.physicsAggregate || !meshB?.physicsAggregate) {
			continue;
		}
		meshA.computeWorldMatrix(true);
		meshB.computeWorldMatrix(true);
		const pivotA = Vector3.TransformCoordinates(localVector(constraint.pivotA, [0, 0, 0]), meshA.getWorldMatrix());
		const pivotB = Vector3.TransformCoordinates(localVector(constraint.pivotB, [0, 0, 0]), meshB.getWorldMatrix());
		const centerA = meshA.getAbsolutePosition();
		const centerB = meshB.getAbsolutePosition();
		const leverA = pivotA.subtract(centerA);
		const leverB = pivotB.subtract(centerB);
		if (constraint.type === "distance") {
			const separation = pivotB.subtract(pivotA);
			const distance = separation.length();
			const target = finiteNumber(constraint.maxDistance, 0, 1_000_000) ? constraint.maxDistance : 0;
			const direction = distance > 0.000001 ? separation.scale(1 / distance) : Vector3.Right();
			rows.push({
				id: `${constraint.id}:distance`,
				bodyAId: meshA.id,
				bodyBId: meshB.id,
				linearA: array(direction.scale(-1)),
				angularA: array(Vector3.Cross(leverA, direction).scale(-1)),
				linearB: array(direction),
				angularB: array(Vector3.Cross(leverB, direction)),
				targetVelocity: 0,
				positionError: distance - target,
			});
		} else if (["ball", "hinge", "lock"].includes(constraint.type)) {
			const error = pivotB.subtract(pivotA);
			for (const [axisIndex, axis] of axes.entries()) {
				rows.push({
					id: `${constraint.id}:pivot-${axisIndex}`,
					bodyAId: meshA.id,
					bodyBId: meshB.id,
					linearA: array(axis.scale(-1)),
					angularA: array(Vector3.Cross(leverA, axis).scale(-1)),
					linearB: array(axis),
					angularB: array(Vector3.Cross(leverB, axis)),
					targetVelocity: 0,
					positionError: Vector3.Dot(error, axis),
				});
			}
		}
	}
	const enabledCouplings = configuration.gearCouplings.filter((coupling) => coupling.enabled);
	for (const coupling of enabledCouplings) {
		const meshA = scene.getMeshById(coupling.bodyANodeId);
		const meshB = scene.getMeshById(coupling.bodyBNodeId);
		if (!meshA?.physicsAggregate || !meshB?.physicsAggregate) {
			continue;
		}
		meshA.computeWorldMatrix(true);
		meshB.computeWorldMatrix(true);
		const axisA = Vector3.TransformNormal(Vector3.FromArray(coupling.axisA), meshA.getWorldMatrix()).normalize();
		const axisB = Vector3.TransformNormal(Vector3.FromArray(coupling.axisB), meshB.getWorldMatrix()).normalize();
		rows.push({
			id: `${coupling.id}:gear`,
			bodyAId: meshA.id,
			bodyBId: meshB.id,
			linearA: [0, 0, 0],
			angularA: array(axisA),
			linearB: [0, 0, 0],
			angularB: array(axisB.scale(coupling.ratio)),
			targetVelocity: coupling.targetVelocity,
			positionError: 0,
			maximumImpulse: coupling.maximumImpulse,
		});
	}
	return { rows, directConstraintCount: directConstraints.length, gearCouplingCount: enabledCouplings.length };
}

/** Runs one bounded supplemental direct solve after Babylon/Havok's normal iterative collision step. */
export function stepHybridPhysicsSolver(scene: Scene, deltaSeconds?: number): IHybridPhysicsRuntimeEvidence {
	configureHybridPhysicsSolver(scene);
	const owner = owners.get(scene)!;
	const evidence = owner.evidence;
	evidence.frames++;
	const normalized = normalizeHybridPhysicsSolverConfiguration(scene.metadata?.babylonEditorHybridPhysicsSolver);
	if (!normalized.ok) {
		evidence.skippedFrames++;
		evidence.lastSkippedReason = normalized.error;
		return structuredClone(evidence);
	}
	const configuration = normalized.value;
	if (!configuration.enabled) {
		evidence.skippedFrames++;
		evidence.lastSkippedReason = "The hybrid direct solver is disabled.";
		return structuredClone(evidence);
	}
	const built = buildRuntimeRows(scene, configuration);
	evidence.directConstraintCount = built.directConstraintCount;
	evidence.gearCouplingCount = built.gearCouplingCount;
	if (!built.rows.length) {
		evidence.skippedFrames++;
		evidence.rowCount = 0;
		evidence.truncatedRows = 0;
		evidence.lastSkippedReason = "No active direct joint or gear row requires processing.";
		return structuredClone(evidence);
	}
	const rows = built.rows.slice(0, configuration.maximumRows);
	const meshes = new Set(rows.flatMap((row) => [row.bodyAId, row.bodyBId]));
	const bodies: IHybridPhysicsLinearBody[] = [];
	const runtimeBodies = new Map<string, any>();
	for (const id of meshes) {
		const mesh = scene.getMeshById(id);
		const body = mesh?.physicsAggregate?.body as any;
		if (!body) {
			continue;
		}
		const mass = body.getMassProperties?.().mass ?? 0;
		const dynamic = body.getMotionType?.() === PhysicsMotionType.DYNAMIC && finiteNumber(mass, 0.000001, 1_000_000_000);
		const inverseMass = dynamic ? 1 / mass : 0;
		const linearVelocity = body.getLinearVelocity?.() ?? Vector3.Zero();
		const angularVelocity = body.getAngularVelocity?.() ?? Vector3.Zero();
		bodies.push({
			id,
			inverseMass,
			inverseInertia: dynamic ? inverseInertia(body, inverseMass) : 0,
			linearVelocity: array(linearVelocity),
			angularVelocity: array(angularVelocity),
		});
		runtimeBodies.set(id, body);
	}
	const step = deltaSeconds ?? (scene.getPhysicsEngine() as any)?.getTimeStep?.() ?? 1 / 60;
	const started = globalThis.performance?.now?.() ?? Date.now();
	const result = solveHybridPhysicsLinearSystem(bodies, rows, step, configuration);
	for (const body of result.bodies) {
		const runtimeBody = runtimeBodies.get(body.id);
		if (!runtimeBody || body.inverseMass === 0) {
			continue;
		}
		runtimeBody.setLinearVelocity?.(Vector3.FromArray(body.linearVelocity));
		runtimeBody.setAngularVelocity?.(Vector3.FromArray(body.angularVelocity));
	}
	evidence.processedFrames++;
	evidence.rowCount = rows.length;
	evidence.truncatedRows = Math.max(0, built.rows.length - rows.length);
	evidence.maximumResidualBefore = result.maximumResidualBefore;
	evidence.maximumResidualAfter = result.maximumResidualAfter;
	evidence.lastSolveDurationMs = Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - started);
	evidence.lastDeltaSeconds = step;
	evidence.lastSkippedReason = null;
	return structuredClone(evidence);
}

/** Attaches one idempotent after-physics observer. It performs no direct-solver work unless selected rows exist. */
export function configureHybridPhysicsSolver(scene: Scene): void {
	if (owners.has(scene)) {
		return;
	}
	const evidence = initialEvidence();
	const observable = (scene as any).onAfterPhysicsObservable;
	const observer = observable?.add ? observable.add(() => stepHybridPhysicsSolver(scene)) : null;
	owners.set(scene, { observer, evidence });
	scene.onDisposeObservable.addOnce(() => releaseHybridPhysicsSolver(scene));
}

/** Returns detached runtime evidence without advancing physics. */
export function getHybridPhysicsSolverRuntime(scene: Scene): IHybridPhysicsRuntimeEvidence {
	configureHybridPhysicsSolver(scene);
	return structuredClone(owners.get(scene)!.evidence);
}

/** Releases only the observer owned by this portable hybrid solver. */
export function releaseHybridPhysicsSolver(scene: Scene): void {
	const owner = owners.get(scene);
	if (!owner) {
		return;
	}
	if (owner.observer) {
		(scene as any).onAfterPhysicsObservable?.remove?.(owner.observer);
	}
	owner.evidence.attached = false;
	owners.delete(scene);
}
