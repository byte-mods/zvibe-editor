import { Scene } from "@babylonjs/core/scene";

export type ScriptSourcePointKind = "statement" | "function" | "branch";
export type ScriptSourceLifecycle = "onStart" | "onUpdate" | "onStop";

export interface IScriptSourcePoint {
	id: string;
	path: string;
	line: number;
	column: number;
	kind: ScriptSourcePointKind;
	functionName: string | null;
}

export interface IScriptSourceManifest {
	version: 1;
	fingerprint: string;
	points: IScriptSourcePoint[];
}

export interface IScriptSourceBreakpointInput {
	id?: string;
	path: string;
	line: number;
	column?: number;
	enabled?: boolean;
	hitCondition?: number;
}

export interface IScriptSourceBreakpoint {
	id: string;
	path: string;
	line: number;
	column: number | null;
	enabled: boolean;
	hitCondition: number;
	resolvedPointId: string | null;
	resolvedLine: number | null;
	resolvedColumn: number | null;
	hits: number;
}

export interface IScriptSourceHit {
	sequence: number;
	timestamp: number;
	breakpointId: string;
	point: IScriptSourcePoint;
	scriptKey: string | null;
	lifecycle: ScriptSourceLifecycle | null;
	object: { id: string | null; name: string } | null;
	fields: Record<string, unknown>;
}

export interface IScriptSourceDebuggerSnapshot {
	instrumented: boolean;
	manifestFingerprint: string;
	configurationRevision: number;
	coverageRevision: number;
	coverageEnabled: boolean;
	pointCount: number;
	fileCount: number;
	breakpoints: IScriptSourceBreakpoint[];
	currentHit: IScriptSourceHit | null;
	hitSequence: number;
	traceCount: number;
	droppedTraceCount: number;
	trace: IScriptSourceHit[];
}

export interface IScriptSourceCoverageMetric {
	total: number;
	covered: number;
	percent: number;
}

export interface IScriptSourceCoverageFile {
	path: string;
	lines: IScriptSourceCoverageMetric;
	statements: IScriptSourceCoverageMetric;
	functions: IScriptSourceCoverageMetric;
	branches: IScriptSourceCoverageMetric;
	uncoveredLines: number[];
	uncoveredLineCount: number;
}

export interface IScriptSourceCoverageSnapshot {
	manifestFingerprint: string;
	coverageRevision: number;
	coverageEnabled: boolean;
	summary: {
		files: IScriptSourceCoverageMetric;
		lines: IScriptSourceCoverageMetric;
		statements: IScriptSourceCoverageMetric;
		functions: IScriptSourceCoverageMetric;
		branches: IScriptSourceCoverageMetric;
	};
	files: IScriptSourceCoverageFile[];
	points: Array<IScriptSourcePoint & { hits: number }>;
	pagination: { offset: number; limit: number; total: number; hasMore: boolean; nextOffset: number | null };
}

interface IScriptSourceInvocation {
	scene: Scene;
	scriptKey: string;
	lifecycle: ScriptSourceLifecycle;
	object: any;
	instance: any;
}

interface IScriptSourceRuntime {
	manifest: IScriptSourceManifest;
	points: Map<string, IScriptSourcePoint>;
	fileCount: number;
	breakpoints: IScriptSourceBreakpoint[];
	breakpointsByPoint: Map<string, IScriptSourceBreakpoint[]>;
	coverageEnabled: boolean;
	coverageHits: Map<string, number>;
	configurationRevision: number;
	coverageRevision: number;
	hitSequence: number;
	currentHit: IScriptSourceHit | null;
	trace: IScriptSourceHit[];
	droppedTraceCount: number;
	pause: () => void;
}

const maximumSourcePoints = 100_000;
const maximumSourceFiles = 1_024;
const maximumBreakpoints = 64;
const maximumTraceEntries = 512;
const maximumSnapshotFields = 32;
const maximumSnapshotArrayItems = 16;
const maximumSnapshotStringLength = 1_024;

const runtimes = new WeakMap<Scene, IScriptSourceRuntime>();
const activeScenes: Scene[] = [];
const invocationStack: IScriptSourceInvocation[] = [];

function metric(total: number, covered: number): IScriptSourceCoverageMetric {
	return { total, covered, percent: total ? Number(((covered / total) * 100).toFixed(2)) : 100 };
}

function increment(value: number): number {
	return value < Number.MAX_SAFE_INTEGER ? value + 1 : value;
}

function normalizeSourcePath(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 1_024) {
		throw new Error("Script source paths must be non-empty strings of at most 1024 characters.");
	}
	const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!normalized.startsWith("src/") || normalized.includes("../") || !/\.(?:ts|tsx)$/.test(normalized)) {
		throw new Error(`Script source path must be a project-relative TypeScript file under src/: ${value}`);
	}
	return normalized;
}

function normalizePoint(value: IScriptSourcePoint, index: number): IScriptSourcePoint {
	if (!value || typeof value !== "object") {
		throw new Error(`Script source point ${index} must be an object.`);
	}
	if (typeof value.id !== "string" || !value.id || value.id.length > 256) {
		throw new Error(`Script source point ${index} has an invalid id.`);
	}
	if (!Number.isInteger(value.line) || value.line < 1 || value.line > 1_000_000 || !Number.isInteger(value.column) || value.column < 1 || value.column > 1_000_000) {
		throw new Error(`Script source point ${index} has an invalid source location.`);
	}
	if (!["statement", "function", "branch"].includes(value.kind)) {
		throw new Error(`Script source point ${index} has an invalid kind.`);
	}
	if (value.functionName !== null && (typeof value.functionName !== "string" || value.functionName.length > 256)) {
		throw new Error(`Script source point ${index} has an invalid functionName.`);
	}
	return { ...value, path: normalizeSourcePath(value.path) };
}

function runtimeFor(scene: Scene): IScriptSourceRuntime {
	const runtime = runtimes.get(scene);
	if (!runtime) {
		throw new Error("Script source debugging is not instrumented for this scene. Prepare instrumented Play mode first.");
	}
	return runtime;
}

function activeRuntime(): { scene: Scene; runtime: IScriptSourceRuntime } | null {
	const invocation = invocationStack[invocationStack.length - 1];
	if (invocation) {
		const runtime = runtimes.get(invocation.scene);
		return runtime ? { scene: invocation.scene, runtime } : null;
	}
	let candidate: Scene | null = null;
	for (const scene of activeScenes) {
		if (scene.isDisposed || !runtimes.has(scene)) {
			continue;
		}
		if (candidate) {
			return null;
		}
		candidate = scene;
	}
	return candidate ? { scene: candidate, runtime: runtimes.get(candidate)! } : null;
}

function describeObject(value: any): { id: string | null; name: string } | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	let descriptors: PropertyDescriptorMap;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return { id: null, name: "Uninspectable object" };
	}
	const id = descriptors.id && "value" in descriptors.id && typeof descriptors.id.value === "string" ? descriptors.id.value : null;
	const name = descriptors.name && "value" in descriptors.name && typeof descriptors.name.value === "string" && descriptors.name.value.trim() ? descriptors.name.value : "Object";
	return {
		id,
		name,
	};
}

function snapshotValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "number") {
		return Number.isFinite(value as number) || typeof value !== "number" ? value : String(value);
	}
	if (typeof value === "string") {
		return value.length <= maximumSnapshotStringLength ? value : `${value.slice(0, maximumSnapshotStringLength)}…`;
	}
	if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === undefined) {
		return String(value);
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	seen.add(value);
	const described = describeObject(value);
	if (depth >= 2) {
		return described ?? "[Object]";
	}
	let descriptors: PropertyDescriptorMap;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		return "[Uninspectable]";
	}
	if (Array.isArray(value)) {
		const length =
			descriptors.length && "value" in descriptors.length && typeof descriptors.length.value === "number" ? Math.min(descriptors.length.value, maximumSnapshotArrayItems) : 0;
		return Array.from({ length }, (_, index) => {
			const descriptor = descriptors[index];
			return descriptor && "value" in descriptor ? snapshotValue(descriptor.value, depth + 1, seen) : "[Accessor or empty]";
		});
	}
	const entries = Object.entries(descriptors)
		.filter(([, descriptor]) => descriptor.enumerable && "value" in descriptor)
		.slice(0, maximumSnapshotFields)
		.map(([key, descriptor]) => [key, snapshotValue(descriptor.value, depth + 1, seen)] as const);
	return described ? { ...described, fields: Object.fromEntries(entries) } : Object.fromEntries(entries);
}

function snapshotFields(instance: any): Record<string, unknown> {
	if (!instance || typeof instance !== "object") {
		return {};
	}
	let descriptors: PropertyDescriptorMap;
	try {
		descriptors = Object.getOwnPropertyDescriptors(instance);
	} catch {
		return { snapshot: "[Uninspectable]" };
	}
	const seen = new WeakSet<object>();
	seen.add(instance);
	return Object.fromEntries(
		Object.entries(descriptors)
			.filter(([, descriptor]) => descriptor.enumerable && "value" in descriptor)
			.slice(0, maximumSnapshotFields)
			.map(([key, descriptor]) => [key, snapshotValue(descriptor.value, 0, seen)])
	);
}

function breakpointId(value: IScriptSourceBreakpointInput, index: number): string {
	const id = value.id ?? `breakpoint-${index + 1}`;
	if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(id)) {
		throw new Error(`Breakpoint ${index} id must contain only letters, numbers, dot, underscore, colon, or hyphen.`);
	}
	return id;
}

function resolveBreakpoint(runtime: IScriptSourceRuntime, value: IScriptSourceBreakpointInput, index: number): IScriptSourceBreakpoint {
	if (!value || typeof value !== "object") {
		throw new Error(`Breakpoint ${index} must be an object.`);
	}
	const path = normalizeSourcePath(value.path);
	if (!Number.isInteger(value.line) || value.line < 1 || value.line > 1_000_000) {
		throw new Error(`Breakpoint ${index} line must be a positive integer.`);
	}
	if (value.column !== undefined && (!Number.isInteger(value.column) || value.column < 1 || value.column > 1_000_000)) {
		throw new Error(`Breakpoint ${index} column must be a positive integer when provided.`);
	}
	const hitCondition = value.hitCondition ?? 1;
	if (!Number.isInteger(hitCondition) || hitCondition < 1 || hitCondition > 1_000_000) {
		throw new Error(`Breakpoint ${index} hitCondition must be an integer from 1 through 1000000.`);
	}
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
		throw new Error(`Breakpoint ${index} enabled must be a boolean when provided.`);
	}
	const candidates = [...runtime.points.values()]
		.filter((point) => point.path === path && (point.line > value.line || (point.line === value.line && point.column >= (value.column ?? 1))))
		.sort((left, right) => left.line - right.line || left.column - right.column || left.id.localeCompare(right.id));
	const resolved = candidates[0] ?? null;
	return {
		id: breakpointId(value, index),
		path,
		line: value.line,
		column: value.column ?? null,
		enabled: value.enabled ?? true,
		hitCondition,
		resolvedPointId: resolved?.id ?? null,
		resolvedLine: resolved?.line ?? null,
		resolvedColumn: resolved?.column ?? null,
		hits: 0,
	};
}

function rebuildBreakpointIndex(runtime: IScriptSourceRuntime): void {
	runtime.breakpointsByPoint.clear();
	for (const breakpoint of runtime.breakpoints) {
		if (!breakpoint.enabled || !breakpoint.resolvedPointId) {
			continue;
		}
		const entries = runtime.breakpointsByPoint.get(breakpoint.resolvedPointId) ?? [];
		entries.push(breakpoint);
		runtime.breakpointsByPoint.set(breakpoint.resolvedPointId, entries);
	}
}

/** Installs one immutable compiler manifest and a safe pause callback for a Play scene. */
export function configureScriptSourceDebugger(scene: Scene, manifest: IScriptSourceManifest, pause: () => void = () => undefined): IScriptSourceDebuggerSnapshot {
	if (manifest?.version !== 1 || !/^[a-f0-9]{64}$/.test(manifest.fingerprint) || !Array.isArray(manifest.points) || manifest.points.length > maximumSourcePoints) {
		throw new Error(`Script source manifest must be version 1 with a SHA-256 fingerprint and at most ${maximumSourcePoints} points.`);
	}
	const points = manifest.points.map(normalizePoint);
	const ids = new Set(points.map((point) => point.id));
	if (ids.size !== points.length) {
		throw new Error("Script source manifest point ids must be unique.");
	}
	if (new Set(points.map((point) => point.path)).size > maximumSourceFiles) {
		throw new Error(`Script source manifest contains more than ${maximumSourceFiles} files.`);
	}
	if (typeof pause !== "function") {
		throw new Error("Script source debugger pause must be a function.");
	}
	const normalizedManifest = { version: 1 as const, fingerprint: manifest.fingerprint, points };
	const runtime: IScriptSourceRuntime = {
		manifest: normalizedManifest,
		points: new Map(points.map((point) => [point.id, point])),
		fileCount: new Set(points.map((point) => point.path)).size,
		breakpoints: [],
		breakpointsByPoint: new Map(),
		coverageEnabled: false,
		coverageHits: new Map(),
		configurationRevision: 1,
		coverageRevision: 0,
		hitSequence: 0,
		currentHit: null,
		trace: [],
		droppedTraceCount: 0,
		pause,
	};
	runtimes.set(scene, runtime);
	if (!activeScenes.includes(scene)) {
		activeScenes.push(scene);
		scene.onDisposeObservable.addOnce(() => {
			const index = activeScenes.indexOf(scene);
			if (index !== -1) {
				activeScenes.splice(index, 1);
			}
			runtimes.delete(scene);
		});
	}
	return getScriptSourceDebuggerSnapshot(scene);
}

/** Marks the synchronous user-script call that owns subsequent compiler probes. */
export function beginScriptSourceInvocation(scene: Scene, scriptKey: string, lifecycle: ScriptSourceLifecycle, object: any, instance: any): () => void {
	const invocation = { scene, scriptKey, lifecycle, object, instance };
	invocationStack.push(invocation);
	return () => {
		const index = invocationStack.lastIndexOf(invocation);
		if (index !== -1) {
			invocationStack.splice(index, 1);
		}
	};
}

/** Compiler-injected, constant-time-when-disabled source probe. */
export function _zvibeEditorScriptProbeV1(path: string, pointId: string, line: number, column: number, kind: ScriptSourcePointKind, functionName: string | null): void {
	const active = activeRuntime();
	if (!active) {
		return;
	}
	const { runtime } = active;
	const point = runtime.points.get(pointId);
	if (!point || point.path !== path || point.line !== line || point.column !== column || point.kind !== kind || point.functionName !== functionName) {
		return;
	}
	if (runtime.coverageEnabled) {
		runtime.coverageHits.set(pointId, increment(runtime.coverageHits.get(pointId) ?? 0));
		runtime.coverageRevision = increment(runtime.coverageRevision);
	}
	const breakpoints = runtime.breakpointsByPoint.get(pointId);
	if (!breakpoints?.length) {
		return;
	}
	for (const breakpoint of breakpoints) {
		breakpoint.hits = increment(breakpoint.hits);
		if (breakpoint.hits < breakpoint.hitCondition) {
			continue;
		}
		const invocation = invocationStack[invocationStack.length - 1] ?? null;
		const hit: IScriptSourceHit = {
			sequence: (runtime.hitSequence = increment(runtime.hitSequence)),
			timestamp: Date.now(),
			breakpointId: breakpoint.id,
			point: { ...point },
			scriptKey: invocation?.scriptKey ?? null,
			lifecycle: invocation?.lifecycle ?? null,
			object: invocation ? describeObject(invocation.object) : null,
			fields: invocation ? snapshotFields(invocation.instance) : {},
		};
		runtime.currentHit = hit;
		runtime.trace.push(hit);
		if (runtime.trace.length > maximumTraceEntries) {
			runtime.trace.shift();
			runtime.droppedTraceCount = increment(runtime.droppedTraceCount);
		}
		try {
			runtime.pause();
		} catch {
			// Debugger plumbing must never turn a user-script breakpoint into a gameplay exception.
		}
		break;
	}
}

// The instrumented bundle resolves this hook without importing editor-only code or shifting source lines.
(globalThis as any).__zvibeEditorScriptProbeV1 = _zvibeEditorScriptProbeV1;

/** Atomically replaces all runtime-only breakpoints after resolving them to executable points. */
export function setScriptSourceBreakpoints(scene: Scene, inputs: IScriptSourceBreakpointInput[]): IScriptSourceDebuggerSnapshot {
	if (!Array.isArray(inputs) || inputs.length > maximumBreakpoints) {
		throw new Error(`Script source breakpoints must contain at most ${maximumBreakpoints} entries.`);
	}
	const runtime = runtimeFor(scene);
	const breakpoints = inputs.map((input, index) => resolveBreakpoint(runtime, input, index));
	if (new Set(breakpoints.map((breakpoint) => breakpoint.id)).size !== breakpoints.length) {
		throw new Error("Script source breakpoint ids must be unique.");
	}
	runtime.breakpoints = breakpoints;
	rebuildBreakpointIndex(runtime);
	runtime.configurationRevision = increment(runtime.configurationRevision);
	return getScriptSourceDebuggerSnapshot(scene);
}

/** Enables/disables collection and optionally clears all accumulated source hit counts. */
export function setScriptSourceCoverage(scene: Scene, enabled: boolean, clear = false): IScriptSourceDebuggerSnapshot {
	const runtime = runtimeFor(scene);
	if (typeof enabled !== "boolean" || typeof clear !== "boolean") {
		throw new Error("Script source coverage enabled and clear values must be booleans.");
	}
	runtime.coverageEnabled = enabled;
	if (clear) {
		runtime.coverageHits.clear();
		runtime.coverageRevision = increment(runtime.coverageRevision);
	}
	runtime.configurationRevision = increment(runtime.configurationRevision);
	return getScriptSourceDebuggerSnapshot(scene);
}

/** Clears only retained breakpoint-hit evidence; authored breakpoints and coverage remain unchanged. */
export function clearScriptSourceDebuggerTrace(scene: Scene): IScriptSourceDebuggerSnapshot {
	const runtime = runtimeFor(scene);
	runtime.currentHit = null;
	runtime.trace = [];
	runtime.droppedTraceCount = 0;
	runtime.configurationRevision = increment(runtime.configurationRevision);
	return getScriptSourceDebuggerSnapshot(scene);
}

/** Returns one bounded immutable debugger snapshot. */
export function getScriptSourceDebuggerSnapshot(scene: Scene, traceOffset = 0, traceLimit = 100): IScriptSourceDebuggerSnapshot {
	const runtime = runtimeFor(scene);
	if (!Number.isInteger(traceOffset) || traceOffset < 0 || !Number.isInteger(traceLimit) || traceLimit < 1 || traceLimit > maximumTraceEntries) {
		throw new Error(`Script debugger trace pagination requires offset >= 0 and limit from 1 through ${maximumTraceEntries}.`);
	}
	return {
		instrumented: true,
		manifestFingerprint: runtime.manifest.fingerprint,
		configurationRevision: runtime.configurationRevision,
		coverageRevision: runtime.coverageRevision,
		coverageEnabled: runtime.coverageEnabled,
		pointCount: runtime.points.size,
		fileCount: runtime.fileCount,
		breakpoints: runtime.breakpoints.map((breakpoint) => ({ ...breakpoint })),
		currentHit: runtime.currentHit ? structuredClone(runtime.currentHit) : null,
		hitSequence: runtime.hitSequence,
		traceCount: runtime.trace.length,
		droppedTraceCount: runtime.droppedTraceCount,
		trace: structuredClone(runtime.trace.slice(traceOffset, traceOffset + traceLimit)),
	};
}

/** Returns source-level line, statement, function, and branch coverage with bounded point pagination. */
export function getScriptSourceCoverage(scene: Scene, options: { path?: string; offset?: number; limit?: number } = {}): IScriptSourceCoverageSnapshot {
	const runtime = runtimeFor(scene);
	const path = options.path === undefined ? null : normalizeSourcePath(options.path);
	const offset = options.offset ?? 0;
	const limit = options.limit ?? 500;
	if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > maximumSourcePoints) {
		throw new Error(`Script source coverage pagination requires offset >= 0 and limit from 1 through ${maximumSourcePoints}.`);
	}
	const grouped = new Map<
		string,
		{
			lines: Map<number, boolean>;
			statements: { total: number; covered: number };
			functions: { total: number; covered: number };
			branches: { total: number; covered: number };
		}
	>();
	const selectedPoints: IScriptSourcePoint[] = [];
	for (const point of runtime.manifest.points) {
		if (path && point.path !== path) {
			continue;
		}
		selectedPoints.push(point);
		const hits = runtime.coverageHits.get(point.id) ?? 0;
		const entry = grouped.get(point.path) ?? {
			lines: new Map<number, boolean>(),
			statements: { total: 0, covered: 0 },
			functions: { total: 0, covered: 0 },
			branches: { total: 0, covered: 0 },
		};
		entry.lines.set(point.line, (entry.lines.get(point.line) ?? false) || hits > 0);
		const counter = point.kind === "statement" ? entry.statements : point.kind === "function" ? entry.functions : entry.branches;
		counter.total++;
		if (hits > 0) {
			counter.covered++;
		}
		grouped.set(point.path, entry);
	}
	const files = [...grouped.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([filePath, entry]) => {
			const uncoveredLines = [...entry.lines.entries()]
				.filter(([, covered]) => !covered)
				.map(([line]) => line)
				.sort((left, right) => left - right);
			const coveredLines = [...entry.lines.values()].filter(Boolean).length;
			return {
				path: filePath,
				lines: metric(entry.lines.size, coveredLines),
				statements: metric(entry.statements.total, entry.statements.covered),
				functions: metric(entry.functions.total, entry.functions.covered),
				branches: metric(entry.branches.total, entry.branches.covered),
				uncoveredLines: uncoveredLines.slice(0, 256),
				uncoveredLineCount: uncoveredLines.length,
			};
		});
	const aggregate = (selector: (file: IScriptSourceCoverageFile) => IScriptSourceCoverageMetric): IScriptSourceCoverageMetric => {
		const total = files.reduce((sum, file) => sum + selector(file).total, 0);
		const covered = files.reduce((sum, file) => sum + selector(file).covered, 0);
		return metric(total, covered);
	};
	return {
		manifestFingerprint: runtime.manifest.fingerprint,
		coverageRevision: runtime.coverageRevision,
		coverageEnabled: runtime.coverageEnabled,
		summary: {
			files: metric(files.length, files.filter((file) => file.lines.covered > 0).length),
			lines: aggregate((file) => file.lines),
			statements: aggregate((file) => file.statements),
			functions: aggregate((file) => file.functions),
			branches: aggregate((file) => file.branches),
		},
		files,
		points: selectedPoints.slice(offset, offset + limit).map((point) => ({ ...point, hits: runtime.coverageHits.get(point.id) ?? 0 })),
		pagination: {
			offset,
			limit,
			total: selectedPoints.length,
			hasMore: offset + limit < selectedPoints.length,
			nextOffset: offset + limit < selectedPoints.length ? offset + limit : null,
		},
	};
}

/** Returns the monotonically increasing breakpoint-hit sequence without allocating a snapshot. */
export function getScriptSourceDebuggerHitSequence(scene: Scene): number {
	return runtimes.get(scene)?.hitSequence ?? 0;
}
