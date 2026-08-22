import { Scene, Tools } from "babylonjs";
import {
	createPortableTestingState,
	IPortableTestingState,
	IPortableTestCase,
	IPortableTestSettings,
	IPortableTestSuite,
	normalizePortableTestingState,
	PortablePerformanceMetric,
} from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";

const supportedPerformanceMetrics: PortablePerformanceMetric[] = [
	"frameRate",
	"frameTimeMs",
	"drawCalls",
	"activeMeshes",
	"totalVertices",
	"meshes",
	"materials",
	"textures",
	"lights",
	"cameras",
	"particleSystems",
	"gpuFrameTimeMs",
	"gpuFrameTimeAverageMs",
];

function legacySceneSuite(scene: Scene): IPortableTestSuite | null {
	const tests = Array.isArray(scene.metadata?.babylonEditorSceneTests) ? scene.metadata.babylonEditorSceneTests : [];
	if (!tests.length) {
		return null;
	}
	return {
		id: "legacy-scene-tests",
		name: "Migrated Scene Tests",
		enabled: true,
		mode: "play",
		categories: ["migrated"],
		beforeEach: [],
		afterEach: [],
		tests: tests.map((test: any) => ({
			id: typeof test.id === "string" && test.id ? test.id : Tools.RandomId(),
			name: typeof test.name === "string" && test.name ? test.name : "Migrated Scene Test",
			enabled: true,
			kind: "scene",
			categories: [],
			repeat: 1,
			setup: [],
			steps: [],
			teardown: [],
			assertions: Array.isArray(test.assertions) ? structuredClone(test.assertions) : [],
		})),
	};
}

function legacyPerformanceSuite(scene: Scene): IPortableTestSuite | null {
	const budgets = Array.isArray(scene.metadata?.babylonEditorPerformanceBudgets) ? scene.metadata.babylonEditorPerformanceBudgets : [];
	if (!budgets.length) {
		return null;
	}
	return {
		id: "legacy-performance-budgets",
		name: "Migrated Performance Budgets",
		enabled: true,
		mode: "play",
		categories: ["performance", "migrated"],
		beforeEach: [],
		afterEach: [],
		tests: budgets.map((budget: any) => ({
			id: typeof budget.id === "string" && budget.id ? budget.id : Tools.RandomId(),
			name: typeof budget.name === "string" && budget.name ? budget.name : "Migrated Performance Budget",
			enabled: true,
			kind: "performance",
			categories: ["performance"],
			repeat: 1,
			setup: [],
			steps: [],
			teardown: [],
			assertions: [],
			performance: {
				warmupFrames: 3,
				measurementFrames: 30,
				thresholds: Object.entries(budget.limits ?? {}).map(([metric, value]) => ({
					metric: metric as PortablePerformanceMetric,
					statistic: "maximum" as const,
					operator: "less-than-or-equal" as const,
					value: value as number,
				})),
			},
		})),
	};
}

function compatibilitySceneTests(state: IPortableTestingState): any[] {
	return state.suites.flatMap((suite) =>
		suite.tests
			.filter((test) => test.kind === "scene")
			.map((test) => {
				const latest = state.runs.flatMap((run) => run.results).find((result) => result.id === test.id);
				return {
					id: test.id,
					name: test.name,
					assertions: structuredClone(test.assertions),
					...(latest
						? {
								lastRun: {
									at: latest.finishedAt,
									passed: latest.status === "passed",
									assertions: structuredClone(latest.assertions),
								},
							}
						: {}),
				};
			})
	);
}

function compatibilityBudgets(state: IPortableTestingState): any[] {
	return state.suites.flatMap((suite) =>
		suite.tests
			.filter((test) => test.kind === "performance")
			.map((test) => {
				const latest = state.runs.flatMap((run) => run.results).find((result) => result.id === test.id);
				const limits = Object.fromEntries(
					(test.performance?.thresholds ?? []).filter((threshold) => threshold.operator === "less-than-or-equal").map((threshold) => [threshold.metric, threshold.value])
				);
				return {
					id: test.id,
					name: test.name,
					limits,
					...(latest
						? {
								lastRun: {
									at: latest.finishedAt,
									passed: latest.status === "passed",
									limits: (latest.performance?.thresholds ?? []).map((threshold) => ({
										metric: threshold.threshold.metric,
										limit: threshold.threshold.value,
										actual: threshold.actual,
										available: threshold.available,
										passed: threshold.passed,
									})),
								},
							}
						: {}),
				};
			})
	);
}

export function persistTestingState(scene: Scene, state: IPortableTestingState): IPortableTestingState {
	const normalized = normalizePortableTestingState(state);
	scene.metadata ??= {};
	scene.metadata.babylonEditorTesting = normalized;
	scene.metadata.babylonEditorSceneTests = compatibilitySceneTests(normalized);
	scene.metadata.babylonEditorPerformanceBudgets = compatibilityBudgets(normalized);
	return normalized;
}

export function testingState(scene: Scene): IPortableTestingState {
	scene.metadata ??= {};
	if (!scene.metadata.babylonEditorTesting) {
		const state = createPortableTestingState();
		const suites = [legacySceneSuite(scene), legacyPerformanceSuite(scene)].filter((suite): suite is IPortableTestSuite => Boolean(suite));
		state.suites = suites;
		return persistTestingState(scene, state);
	}
	return persistTestingState(scene, normalizePortableTestingState(scene.metadata.babylonEditorTesting));
}

function requireRevision(state: IPortableTestingState, value: unknown): void {
	if (!Number.isInteger(value)) {
		throw new Error("expectedRevision is required and must be an integer.");
	}
	if (value !== state.revision) {
		throw new Error(`Testing state revision is ${state.revision}; received stale expectedRevision ${value}.`);
	}
}

function changed(scene: Scene, state: IPortableTestingState, options: IMCPActionOptions): IPortableTestingState {
	state.revision++;
	const result = persistTestingState(scene, state);
	options.editor.layout.inspector.forceUpdate();
	return result;
}

function suiteBy(state: IPortableTestingState, data: any): IPortableTestSuite {
	const suite = state.suites.find((candidate) => candidate.id === data.suiteId || candidate.id === data.id || candidate.name === data.suiteName);
	if (!suite) {
		throw new Error("Test suite not found.");
	}
	return suite;
}

function testBy(suite: IPortableTestSuite, data: any): IPortableTestCase {
	const test = suite.tests.find((candidate) => candidate.id === data.testId || candidate.id === data.id || candidate.name === data.testName);
	if (!test) {
		throw new Error("Test case not found.");
	}
	return test;
}

export function getTestingCapabilities(scene: Scene): any {
	const state = testingState(scene);
	return {
		version: state.version,
		revision: state.revision,
		limits: { suites: 128, totalCases: 1024, stepsPerPhase: 128, assertionsPerCase: 128, retainedRuns: 20 },
		modes: ["edit", "play", "connected-player", "headless", "project-code"],
		caseKinds: ["scene", "performance", "visual"],
		steps: ["wait-frames", "wait-ms", "set-node-enabled", "set-node-position", "set-node-rotation", "set-node-scaling", "dispatch-pointer"],
		assertions: ["node-exists", "node-enabled", "node-position", "node-rotation", "node-scaling", "node-property", "scene-count"],
		performanceMetrics: supportedPerformanceMetrics,
		reports: ["json", "junit"],
		limitations: [
			"Project code tests use the project's configured package script and retain their native framework semantics.",
			"Headless scene tests do not execute browser-only rendering, audio, DOM, native plugins, or the project's compiled Play bundle.",
			"No NUnit, Unity assembly/coroutine, proprietary player protocol, binary, or numerical identity is claimed.",
		],
	};
}

export function getTestingState(scene: Scene): IPortableTestingState {
	return structuredClone(testingState(scene));
}

export function setTestingSettings(scene: Scene, data: { expectedRevision: number; settings: Partial<IPortableTestSettings> }, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	state.settings = { ...state.settings, ...structuredClone(data.settings) };
	return changed(scene, normalizePortableTestingState(state), options);
}

export function createTestSuite(scene: Scene, data: any, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	const id = data.id ?? Tools.RandomId();
	if (state.suites.some((suite) => suite.id === id || suite.name === data.name)) {
		throw new Error("Test suite id and name must be unique.");
	}
	state.suites.push({
		id,
		name: data.name,
		enabled: data.enabled ?? true,
		mode: data.mode,
		categories: data.categories ?? [],
		...(data.timeoutMs === undefined ? {} : { timeoutMs: data.timeoutMs }),
		beforeEach: data.beforeEach ?? [],
		afterEach: data.afterEach ?? [],
		tests: data.tests ?? [],
	});
	return changed(scene, normalizePortableTestingState(state), options);
}

export function setTestSuite(scene: Scene, data: any, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	const suite = suiteBy(state, data);
	for (const key of ["name", "enabled", "mode", "categories", "timeoutMs", "beforeEach", "afterEach"] as const) {
		if (data[key] !== undefined) {
			(suite as any)[key] = structuredClone(data[key]);
		}
	}
	if (state.suites.some((candidate) => candidate !== suite && candidate.name === suite.name)) {
		throw new Error("Test suite names must be unique.");
	}
	return changed(scene, normalizePortableTestingState(state), options);
}

export function deleteTestSuite(scene: Scene, data: any, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Deleting a test suite requires confirm=true.");
	}
	const suite = suiteBy(state, data);
	state.suites.splice(state.suites.indexOf(suite), 1);
	return changed(scene, state, options);
}

export function createTestCase(scene: Scene, data: any, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	const suite = suiteBy(state, data);
	const id = data.test?.id ?? Tools.RandomId();
	if (state.suites.some((candidate) => candidate.tests.some((test) => test.id === id))) {
		throw new Error("Test case ids must be unique across the testing state.");
	}
	if (suite.tests.some((test) => test.name === data.test?.name)) {
		throw new Error("Test case names must be unique inside a suite.");
	}
	suite.tests.push({ ...structuredClone(data.test), id });
	return changed(scene, normalizePortableTestingState(state), options);
}

export function setTestCase(scene: Scene, data: any, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	const suite = suiteBy(state, data);
	const test = testBy(suite, data);
	Object.assign(test, structuredClone(data.patch));
	if (suite.tests.some((candidate) => candidate !== test && candidate.name === test.name)) {
		throw new Error("Test case names must be unique inside a suite.");
	}
	return changed(scene, normalizePortableTestingState(state), options);
}

export function deleteTestCase(scene: Scene, data: any, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Deleting a test case requires confirm=true.");
	}
	const suite = suiteBy(state, data);
	const test = testBy(suite, data);
	suite.tests.splice(suite.tests.indexOf(test), 1);
	return changed(scene, state, options);
}

export function clearTestingRuns(scene: Scene, data: any, options: IMCPActionOptions): IPortableTestingState {
	const state = structuredClone(testingState(scene));
	requireRevision(state, data.expectedRevision);
	if (data.confirm !== true) {
		throw new Error("Clearing retained test runs requires confirm=true.");
	}
	if (data.runIds !== undefined) {
		if (!Array.isArray(data.runIds) || !data.runIds.length || data.runIds.length > 20 || !data.runIds.every((id: unknown) => typeof id === "string" && id.length > 0)) {
			throw new Error("runIds must contain 1 through 20 non-empty run ids.");
		}
		const selected = new Set(data.runIds);
		const missing = data.runIds.filter((id: string) => !state.runs.some((run) => run.id === id));
		if (missing.length) {
			throw new Error(`Test runs were not found: ${missing.join(", ")}.`);
		}
		state.runs = state.runs.filter((run) => !selected.has(run.id));
	} else {
		state.runs = [];
	}
	return changed(scene, state, options);
}

export function findTestSuite(scene: Scene, data: any): { state: IPortableTestingState; suite: IPortableTestSuite } {
	const state = testingState(scene);
	return { state, suite: suiteBy(state, data) };
}

export function findTestCase(scene: Scene, data: any): { state: IPortableTestingState; suite: IPortableTestSuite; test: IPortableTestCase } {
	const state = testingState(scene);
	const suite = suiteBy(state, data);
	return { state, suite, test: testBy(suite, data) };
}

export function getSupportedTestingPerformanceMetrics(): PortablePerformanceMetric[] {
	return [...supportedPerformanceMetrics];
}
