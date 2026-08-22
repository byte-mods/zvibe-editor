import { Scene, Tools } from "babylonjs";
import { IPortableTestSuite, retainPortableTestRun, runPortableTestSuites } from "babylonjs-editor-tools";

import { IMCPActionOptions } from "../action";
import { getSceneDiagnostics } from "../editor";

import { getSupportedTestingPerformanceMetrics, persistTestingState, testingState } from "./state";

export { compareVisualRegressionImages } from "./visual";

type PortableRunnerScene = Parameters<typeof runPortableTestSuites>[0];

function portableScene(scene: Scene): PortableRunnerScene {
	return scene as unknown as PortableRunnerScene;
}

function compatibilitySceneSuite(scene: Scene): IPortableTestSuite {
	const state = testingState(scene);
	let suite = state.suites.find((candidate) => candidate.id === "compatibility-scene-tests");
	if (!suite) {
		suite = {
			id: "compatibility-scene-tests",
			name: "Scene Tests",
			enabled: true,
			mode: "play",
			categories: ["scene"],
			beforeEach: [],
			afterEach: [],
			tests: [],
		};
		state.suites.push(suite);
		persistTestingState(scene, state);
	}
	return suite;
}

function compatibilityPerformanceSuite(scene: Scene): IPortableTestSuite {
	const state = testingState(scene);
	let suite = state.suites.find((candidate) => candidate.id === "compatibility-performance-budgets");
	if (!suite) {
		suite = {
			id: "compatibility-performance-budgets",
			name: "Performance Budgets",
			enabled: true,
			mode: "play",
			categories: ["performance"],
			beforeEach: [],
			afterEach: [],
			tests: [],
		};
		state.suites.push(suite);
		persistTestingState(scene, state);
	}
	return suite;
}

function sceneTest(scene: Scene, data: any): any {
	const tests = listSceneTests(scene).tests;
	const value = tests.find((candidate: any) => candidate.id === data.id || candidate.name === data.name);
	if (!value) {
		throw new Error("Scene test not found.");
	}
	return value;
}

function budget(scene: Scene, data: any): any {
	const budgets = listPerformanceBudgets(scene).budgets;
	const value = budgets.find((candidate: any) => candidate.id === data.id || candidate.name === data.name);
	if (!value) {
		throw new Error("Performance budget not found.");
	}
	return value;
}

function validateLimits(limits: any): void {
	if (!limits || typeof limits !== "object" || Array.isArray(limits) || !Object.keys(limits).length) {
		throw new Error("Performance budgets require one or more metric limits.");
	}
	const supported = new Set(getSupportedTestingPerformanceMetrics());
	for (const [metric, value] of Object.entries(limits)) {
		if (!supported.has(metric as any)) {
			throw new Error(`Unsupported performance metric "${metric}".`);
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new Error(`Performance limit for "${metric}" must be a finite number greater than or equal to zero.`);
		}
	}
}

function updateState(scene: Scene, updater: (state: ReturnType<typeof testingState>) => void, options: IMCPActionOptions): any {
	const state = structuredClone(testingState(scene));
	updater(state);
	state.revision++;
	const result = persistTestingState(scene, state);
	options.editor.layout.inspector.forceUpdate();
	return result;
}

/** Lists compatibility scene tests backed by the version-2 suite model. */
export function listSceneTests(scene: Scene): any {
	const state = testingState(scene);
	const tests = state.suites.flatMap((suite) =>
		suite.tests
			.filter((test) => test.kind === "scene")
			.map((test) => {
				const latest = state.runs.flatMap((run) => run.results).find((result) => result.id === test.id);
				return {
					id: test.id,
					name: test.name,
					assertions: structuredClone(test.assertions),
					...(latest ? { lastRun: { at: latest.finishedAt, passed: latest.status === "passed", assertions: structuredClone(latest.assertions) } } : {}),
				};
			})
	);
	return { tests };
}

export function createSceneTest(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.name?.trim()) {
		throw new Error("Scene tests require a non-empty name.");
	}
	if (!Array.isArray(data.assertions)) {
		throw new Error("Scene-test assertions must be an array.");
	}
	const id = data.id ?? Tools.RandomId();
	const suiteId = compatibilitySceneSuite(scene).id;
	updateState(
		scene,
		(state) => {
			const suite = state.suites.find((candidate) => candidate.id === suiteId)!;
			if (state.suites.some((candidate) => candidate.tests.some((test) => test.id === id || test.name === data.name))) {
				throw new Error(`Scene test "${data.name}" already exists.`);
			}
			suite.tests.push({
				id,
				name: data.name.trim(),
				enabled: true,
				kind: "scene",
				categories: [],
				repeat: 1,
				setup: [],
				steps: [],
				teardown: [],
				assertions: structuredClone(data.assertions),
			});
		},
		options
	);
	return sceneTest(scene, { id });
}

export function setSceneTest(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = sceneTest(scene, data);
	updateState(
		scene,
		(state) => {
			const test = state.suites.flatMap((suite) => suite.tests).find((candidate) => candidate.id === current.id)!;
			if (data.name !== undefined) {
				test.name = data.name;
			}
			if (data.assertions !== undefined) {
				test.assertions = structuredClone(data.assertions);
			}
		},
		options
	);
	return sceneTest(scene, { id: current.id });
}

export async function runSceneTests(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const state = testingState(scene);
	const selected = data.id || data.name ? sceneTest(scene, data) : null;
	const report = await runPortableTestSuites(
		portableScene(scene),
		{ ...structuredClone(state), suites: state.suites.map((suite) => ({ ...suite, mode: "edit" as const, tests: suite.tests.filter((test) => test.kind === "scene") })) },
		selected ? { testIds: [selected.id], modes: ["edit"] } : { modes: ["edit"] },
		{ target: "editor-edit", supportedModes: ["edit"], measureMetrics: getSceneDiagnostics }
	);
	persistTestingState(scene, retainPortableTestRun(state, report));
	options.editor.layout.inspector.forceUpdate();
	return {
		passed: report.status === "passed",
		results: report.results.map((result) => ({ id: result.id, name: result.name, at: result.finishedAt, passed: result.status === "passed", assertions: result.assertions })),
	};
}

export function deleteSceneTest(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = sceneTest(scene, data);
	updateState(
		portableScene(scene),
		(state) => {
			for (const suite of state.suites) {
				suite.tests = suite.tests.filter((test) => test.id !== current.id);
			}
		},
		options
	);
	return { deleted: true, id: current.id };
}

export function listPerformanceBudgets(scene: Scene): any {
	const state = testingState(scene);
	const budgets = state.suites.flatMap((suite) =>
		suite.tests
			.filter((test) => test.kind === "performance")
			.map((test) => {
				const latest = state.runs.flatMap((run) => run.results).find((result) => result.id === test.id);
				return {
					id: test.id,
					name: test.name,
					limits: Object.fromEntries((test.performance?.thresholds ?? []).map((threshold) => [threshold.metric, threshold.value])),
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
	return { budgets, supportedMetrics: getSupportedTestingPerformanceMetrics() };
}

export function createPerformanceBudget(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.name?.trim()) {
		throw new Error("Performance budgets require a non-empty name.");
	}
	validateLimits(data.limits);
	const id = data.id ?? Tools.RandomId();
	const suiteId = compatibilityPerformanceSuite(scene).id;
	updateState(
		scene,
		(state) => {
			const suite = state.suites.find((candidate) => candidate.id === suiteId)!;
			if (state.suites.some((candidate) => candidate.tests.some((test) => test.id === id || test.name === data.name))) {
				throw new Error(`Performance budget "${data.name}" already exists.`);
			}
			suite.tests.push({
				id,
				name: data.name.trim(),
				enabled: true,
				kind: "performance",
				categories: ["performance"],
				repeat: 1,
				setup: [],
				steps: [],
				teardown: [],
				assertions: [],
				performance: {
					warmupFrames: 0,
					measurementFrames: 1,
					thresholds: Object.entries(data.limits).map(([metric, value]) => ({
						metric: metric as any,
						statistic: "maximum",
						operator: "less-than-or-equal",
						value: value as number,
						allowUnavailable: true,
					})),
				},
			});
		},
		options
	);
	return budget(scene, { id });
}

export function setPerformanceBudget(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = budget(scene, data);
	if (data.limits !== undefined) {
		validateLimits(data.limits);
	}
	updateState(
		scene,
		(state) => {
			const test = state.suites.flatMap((suite) => suite.tests).find((candidate) => candidate.id === current.id)!;
			if (data.name !== undefined) {
				test.name = data.name;
			}
			if (data.limits !== undefined && test.performance) {
				test.performance.thresholds = Object.entries(data.limits).map(([metric, value]) => ({
					metric: metric as any,
					statistic: "maximum",
					operator: "less-than-or-equal",
					value: value as number,
					allowUnavailable: true,
				}));
			}
		},
		options
	);
	return budget(scene, { id: current.id });
}

export async function runPerformanceBudgets(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const state = testingState(scene);
	const selected = data.id || data.name ? budget(scene, data) : null;
	const report = await runPortableTestSuites(
		portableScene(scene),
		{ ...structuredClone(state), suites: state.suites.map((suite) => ({ ...suite, mode: "edit" as const, tests: suite.tests.filter((test) => test.kind === "performance") })) },
		selected ? { testIds: [selected.id], modes: ["edit"] } : { modes: ["edit"] },
		{ target: "editor-edit", supportedModes: ["edit"], measureMetrics: getSceneDiagnostics }
	);
	persistTestingState(scene, retainPortableTestRun(state, report));
	options.editor.layout.inspector.forceUpdate();
	return {
		passed: report.status === "passed",
		diagnostics: getSceneDiagnostics(scene),
		results: report.results.map((result) => ({
			id: result.id,
			name: result.name,
			at: result.finishedAt,
			passed: result.status === "passed",
			limits: (result.performance?.thresholds ?? []).map((threshold) => ({
				metric: threshold.threshold.metric,
				limit: threshold.threshold.value,
				actual: threshold.actual,
				available: threshold.available,
				passed: threshold.passed,
			})),
		})),
	};
}

export function deletePerformanceBudget(scene: Scene, data: any, options: IMCPActionOptions): any {
	const current = budget(scene, data);
	updateState(
		scene,
		(state) => {
			for (const suite of state.suites) {
				suite.tests = suite.tests.filter((test) => test.id !== current.id);
			}
		},
		options
	);
	return { deleted: true, id: current.id };
}
