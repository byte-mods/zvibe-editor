import type { Node } from "@babylonjs/core/node";

// Babylon's monolithic and modular packages expose the same runtime Scene but incompatible augmented declaration identities.
// Keep the portable runner boundary structural so editor, CLI, and exported players can share one implementation.
export type PortableTestingScene = any;

export const PORTABLE_TESTING_VERSION = 2;
export const MAX_TEST_SUITES = 128;
export const MAX_TEST_CASES = 1024;
export const MAX_TEST_STEPS = 128;
export const MAX_TEST_ASSERTIONS = 128;
export const MAX_TEST_RUNS = 20;

export type PortableTestMode = "edit" | "play";
export type PortableTestTarget = "editor-edit" | "editor-play" | "editor-mixed" | "connected-player" | "headless" | "project-code";
export type PortableTestStatus = "passed" | "failed" | "skipped" | "canceled" | "timed-out";
export type PortablePerformanceMetric =
	| "frameRate"
	| "frameTimeMs"
	| "drawCalls"
	| "activeMeshes"
	| "totalVertices"
	| "meshes"
	| "materials"
	| "textures"
	| "lights"
	| "cameras"
	| "particleSystems"
	| "gpuFrameTimeMs"
	| "gpuFrameTimeAverageMs";
export type PortablePerformanceStatistic = "minimum" | "maximum" | "mean" | "median" | "p95";

export interface IPortableTestSettings {
	defaultTimeoutMs: number;
	playPreparationTimeoutMs: number;
	maximumRetainedRuns: number;
}

export type PortableTestStep =
	| { type: "wait-frames"; frames: number }
	| { type: "wait-ms"; milliseconds: number }
	| { type: "set-node-enabled"; nodeId: string; enabled: boolean }
	| { type: "set-node-position"; nodeId: string; value: [number, number, number] }
	| { type: "set-node-rotation"; nodeId: string; value: [number, number, number] }
	| { type: "set-node-scaling"; nodeId: string; value: [number, number, number] }
	| { type: "dispatch-pointer"; phase: "down" | "move" | "up"; x: number; y: number; button?: number };

export type PortableTestAssertion =
	| { type: "node-exists"; nodeId: string; exists: boolean }
	| { type: "node-enabled"; nodeId: string; equals: boolean }
	| { type: "node-position"; nodeId: string; equals: [number, number, number]; epsilon?: number }
	| { type: "node-rotation"; nodeId: string; equals: [number, number, number]; epsilon?: number }
	| { type: "node-scaling"; nodeId: string; equals: [number, number, number]; epsilon?: number }
	| {
			type: "node-property";
			nodeId: string;
			path: string;
			operator: "equals" | "not-equals" | "greater-than" | "greater-than-or-equal" | "less-than" | "less-than-or-equal" | "contains";
			expected: unknown;
			epsilon?: number;
	  }
	| {
			type: "scene-count";
			collection: "nodes" | "meshes" | "materials" | "textures" | "lights" | "cameras" | "particleSystems" | "animationGroups";
			operator: "equals" | "greater-than-or-equal" | "less-than-or-equal";
			expected: number;
	  };

export interface IPortablePerformanceThreshold {
	metric: PortablePerformanceMetric;
	statistic: PortablePerformanceStatistic;
	operator: "less-than-or-equal" | "greater-than-or-equal";
	value: number;
	allowUnavailable?: boolean;
}

export interface IPortablePerformanceConfiguration {
	warmupFrames: number;
	measurementFrames: number;
	thresholds: IPortablePerformanceThreshold[];
}

export interface IPortableVisualConfiguration {
	baselinePath: string;
	tolerance: number;
	maximumDifferingPixels: number;
	diffPath?: string;
}

export interface IPortableTestCase {
	id: string;
	name: string;
	enabled: boolean;
	kind: "scene" | "performance" | "visual";
	categories: string[];
	timeoutMs?: number;
	repeat: number;
	setup: PortableTestStep[];
	steps: PortableTestStep[];
	teardown: PortableTestStep[];
	assertions: PortableTestAssertion[];
	performance?: IPortablePerformanceConfiguration;
	visual?: IPortableVisualConfiguration;
}

export interface IPortableTestSuite {
	id: string;
	name: string;
	enabled: boolean;
	mode: PortableTestMode;
	categories: string[];
	timeoutMs?: number;
	beforeEach: PortableTestStep[];
	afterEach: PortableTestStep[];
	tests: IPortableTestCase[];
}

export interface IPortableTestingState {
	version: typeof PORTABLE_TESTING_VERSION;
	revision: number;
	settings: IPortableTestSettings;
	suites: IPortableTestSuite[];
	runs: IPortableTestRunReport[];
}

export interface IPortableAssertionResult {
	assertion: PortableTestAssertion;
	passed: boolean;
	actual?: unknown;
	message: string;
}

export interface IPortablePerformanceSummary {
	available: boolean;
	sampleCount: number;
	minimum: number | null;
	maximum: number | null;
	mean: number | null;
	median: number | null;
	p95: number | null;
}

export interface IPortablePerformanceThresholdResult {
	threshold: IPortablePerformanceThreshold;
	actual: number | null;
	available: boolean;
	passed: boolean;
	message: string;
}

export interface IPortableVisualResult {
	passed: boolean;
	baselinePath: string;
	candidatePath?: string;
	diffPath?: string | null;
	differingPixels?: number;
	totalPixels?: number;
	reason?: string;
}

export interface IPortableTestCaseResult {
	id: string;
	suiteId: string;
	name: string;
	suiteName: string;
	kind: IPortableTestCase["kind"];
	mode: PortableTestMode;
	repeatIndex: number;
	status: PortableTestStatus;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	assertions: IPortableAssertionResult[];
	performance?: {
		samples: Partial<Record<PortablePerformanceMetric, number>>[];
		summary: Partial<Record<PortablePerformanceMetric, IPortablePerformanceSummary>>;
		thresholds: IPortablePerformanceThresholdResult[];
	};
	visual?: IPortableVisualResult;
	errors: string[];
}

export interface IPortableTestRunReport {
	id: string;
	sequence: number;
	target: PortableTestTarget;
	status: PortableTestStatus;
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	filters: IPortableTestRunRequest;
	summary: { total: number; passed: number; failed: number; skipped: number; canceled: number; timedOut: number };
	results: IPortableTestCaseResult[];
	limitations: string[];
}

export interface IPortableTestRunRequest {
	suiteIds?: string[];
	testIds?: string[];
	modes?: PortableTestMode[];
	categories?: string[];
	search?: string;
	failedOnly?: boolean;
	failFast?: boolean;
	repeatOverride?: number;
}

export interface IPortableTestRunnerOptions {
	target: PortableTestTarget;
	sequence?: number;
	previousRun?: IPortableTestRunReport | null;
	signal?: AbortSignal;
	supportedModes?: PortableTestMode[];
	waitFrames?: (scene: PortableTestingScene, frames: number, signal?: AbortSignal) => Promise<void>;
	waitMilliseconds?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
	dispatchPointer?: (scene: PortableTestingScene, step: Extract<PortableTestStep, { type: "dispatch-pointer" }>) => Promise<void> | void;
	measureMetrics?: (scene: PortableTestingScene) => Partial<Record<PortablePerformanceMetric, number | null>>;
	runVisual?: (scene: PortableTestingScene, test: IPortableTestCase, runId: string, signal?: AbortSignal) => Promise<IPortableVisualResult>;
	onProgress?: (progress: { completed: number; total: number; currentSuiteId: string; currentTestId: string; status: PortableTestStatus | "running" }) => void;
}

const performanceMetrics = new Set<PortablePerformanceMetric>([
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
]);

const unsafePathSegments = new Set(["__proto__", "prototype", "constructor"]);

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string, maximumLength = 160): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximumLength) {
		throw new Error(`${label} must be a non-empty string no longer than ${maximumLength} characters.`);
	}
	return value.trim();
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
	}
	return value as number;
}

function requireFinite(value: unknown, label: string, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be a finite number from ${minimum} through ${maximum}.`);
	}
	return value;
}

function requireVector3(value: unknown, label: string): [number, number, number] {
	if (!Array.isArray(value) || value.length !== 3) {
		throw new Error(`${label} must contain exactly three finite numbers.`);
	}
	return value.map((component, index) => requireFinite(component, `${label}[${index}]`)) as [number, number, number];
}

function normalizeCategories(value: unknown, label: string): string[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > 32) {
		throw new Error(`${label} must be an array of at most 32 category names.`);
	}
	const normalized = value.map((entry, index) => requireString(entry, `${label}[${index}]`, 64));
	if (new Set(normalized).size !== normalized.length) {
		throw new Error(`${label} cannot contain duplicate category names.`);
	}
	return normalized;
}

function normalizeSteps(value: unknown, label: string): PortableTestStep[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > MAX_TEST_STEPS) {
		throw new Error(`${label} must be an array of at most ${MAX_TEST_STEPS} steps.`);
	}
	return value.map((entry, index) => {
		const step = requireObject(entry, `${label}[${index}]`);
		switch (step.type) {
			case "wait-frames":
				return { type: step.type, frames: requireInteger(step.frames, `${label}[${index}].frames`, 1, 600) };
			case "wait-ms":
				return { type: step.type, milliseconds: requireInteger(step.milliseconds, `${label}[${index}].milliseconds`, 0, 10_000) };
			case "set-node-enabled":
				if (typeof step.enabled !== "boolean") {
					throw new Error(`${label}[${index}].enabled must be boolean.`);
				}
				return { type: step.type, nodeId: requireString(step.nodeId, `${label}[${index}].nodeId`), enabled: step.enabled };
			case "set-node-position":
			case "set-node-rotation":
			case "set-node-scaling":
				return { type: step.type, nodeId: requireString(step.nodeId, `${label}[${index}].nodeId`), value: requireVector3(step.value, `${label}[${index}].value`) };
			case "dispatch-pointer":
				if (!["down", "move", "up"].includes(step.phase as string)) {
					throw new Error(`${label}[${index}].phase must be down, move, or up.`);
				}
				return {
					type: step.type,
					phase: step.phase as "down" | "move" | "up",
					x: requireFinite(step.x, `${label}[${index}].x`, 0, 1),
					y: requireFinite(step.y, `${label}[${index}].y`, 0, 1),
					...(step.button === undefined ? {} : { button: requireInteger(step.button, `${label}[${index}].button`, 0, 4) }),
				};
			default:
				throw new Error(`${label}[${index}] has unsupported step type "${String(step.type)}".`);
		}
	});
}

function normalizeAssertion(entry: unknown, label: string): PortableTestAssertion {
	const assertion = requireObject(entry, label);
	const nodeId = assertion.type === "scene-count" ? undefined : requireString(assertion.nodeId, `${label}.nodeId`);
	switch (assertion.type) {
		case "node-exists":
			if (typeof assertion.exists !== "boolean") {
				throw new Error(`${label}.exists must be boolean.`);
			}
			return { type: assertion.type, nodeId: nodeId!, exists: assertion.exists };
		case "node-enabled":
			if (typeof assertion.equals !== "boolean") {
				throw new Error(`${label}.equals must be boolean.`);
			}
			return { type: assertion.type, nodeId: nodeId!, equals: assertion.equals };
		case "node-position":
		case "node-rotation":
		case "node-scaling":
			return {
				type: assertion.type,
				nodeId: nodeId!,
				equals: requireVector3(assertion.equals, `${label}.equals`),
				...(assertion.epsilon === undefined ? {} : { epsilon: requireFinite(assertion.epsilon, `${label}.epsilon`, Number.EPSILON, 1_000_000) }),
			};
		case "node-property": {
			const path = requireString(assertion.path, `${label}.path`, 256);
			const segments = path.split(".");
			if (!segments.every((segment) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) && !unsafePathSegments.has(segment))) {
				throw new Error(`${label}.path contains an unsafe segment.`);
			}
			if (!["equals", "not-equals", "greater-than", "greater-than-or-equal", "less-than", "less-than-or-equal", "contains"].includes(assertion.operator as string)) {
				throw new Error(`${label}.operator is unsupported.`);
			}
			const encoded = JSON.stringify(assertion.expected);
			if (encoded === undefined || encoded.length > 16_384) {
				throw new Error(`${label}.expected must be bounded JSON data.`);
			}
			return {
				type: assertion.type,
				nodeId: nodeId!,
				path,
				operator: assertion.operator as Extract<PortableTestAssertion, { type: "node-property" }>["operator"],
				expected: structuredClone(assertion.expected),
				...(assertion.epsilon === undefined ? {} : { epsilon: requireFinite(assertion.epsilon, `${label}.epsilon`, Number.EPSILON, 1_000_000) }),
			};
		}
		case "scene-count":
			if (!["nodes", "meshes", "materials", "textures", "lights", "cameras", "particleSystems", "animationGroups"].includes(assertion.collection as string)) {
				throw new Error(`${label}.collection is unsupported.`);
			}
			if (!["equals", "greater-than-or-equal", "less-than-or-equal"].includes(assertion.operator as string)) {
				throw new Error(`${label}.operator is unsupported.`);
			}
			return {
				type: assertion.type,
				collection: assertion.collection as Extract<PortableTestAssertion, { type: "scene-count" }>["collection"],
				operator: assertion.operator as Extract<PortableTestAssertion, { type: "scene-count" }>["operator"],
				expected: requireInteger(assertion.expected, `${label}.expected`, 0, 1_000_000),
			};
		default:
			throw new Error(`${label} has unsupported assertion type "${String(assertion.type)}".`);
	}
}

function normalizeAssertions(value: unknown, label: string): PortableTestAssertion[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > MAX_TEST_ASSERTIONS) {
		throw new Error(`${label} must be an array of at most ${MAX_TEST_ASSERTIONS} assertions.`);
	}
	return value.map((entry, index) => normalizeAssertion(entry, `${label}[${index}]`));
}

function normalizePerformance(value: unknown, label: string): IPortablePerformanceConfiguration {
	const performance = requireObject(value, label);
	if (!Array.isArray(performance.thresholds) || !performance.thresholds.length || performance.thresholds.length > 32) {
		throw new Error(`${label}.thresholds must contain 1 through 32 thresholds.`);
	}
	return {
		warmupFrames: requireInteger(performance.warmupFrames ?? 3, `${label}.warmupFrames`, 0, 600),
		measurementFrames: requireInteger(performance.measurementFrames ?? 30, `${label}.measurementFrames`, 1, 600),
		thresholds: performance.thresholds.map((entry, index) => {
			const threshold = requireObject(entry, `${label}.thresholds[${index}]`);
			if (!performanceMetrics.has(threshold.metric as PortablePerformanceMetric)) {
				throw new Error(`${label}.thresholds[${index}].metric is unsupported.`);
			}
			if (!["minimum", "maximum", "mean", "median", "p95"].includes(threshold.statistic as string)) {
				throw new Error(`${label}.thresholds[${index}].statistic is unsupported.`);
			}
			if (!["less-than-or-equal", "greater-than-or-equal"].includes(threshold.operator as string)) {
				throw new Error(`${label}.thresholds[${index}].operator is unsupported.`);
			}
			if (threshold.allowUnavailable !== undefined && typeof threshold.allowUnavailable !== "boolean") {
				throw new Error(`${label}.thresholds[${index}].allowUnavailable must be boolean.`);
			}
			return {
				metric: threshold.metric as PortablePerformanceMetric,
				statistic: threshold.statistic as PortablePerformanceStatistic,
				operator: threshold.operator as IPortablePerformanceThreshold["operator"],
				value: requireFinite(threshold.value, `${label}.thresholds[${index}].value`),
				...(threshold.allowUnavailable === undefined ? {} : { allowUnavailable: threshold.allowUnavailable }),
			};
		}),
	};
}

function normalizeVisual(value: unknown, label: string): IPortableVisualConfiguration {
	const visual = requireObject(value, label);
	const baselinePath = requireString(visual.baselinePath, `${label}.baselinePath`, 512);
	if (!baselinePath.toLowerCase().endsWith(".png")) {
		throw new Error(`${label}.baselinePath must end in .png.`);
	}
	const diffPath = visual.diffPath === undefined ? undefined : requireString(visual.diffPath, `${label}.diffPath`, 512);
	if (diffPath && !diffPath.toLowerCase().endsWith(".png")) {
		throw new Error(`${label}.diffPath must end in .png.`);
	}
	return {
		baselinePath,
		tolerance: requireInteger(visual.tolerance ?? 0, `${label}.tolerance`, 0, 255),
		maximumDifferingPixels: requireInteger(visual.maximumDifferingPixels ?? 0, `${label}.maximumDifferingPixels`, 0, 100_000_000),
		...(diffPath ? { diffPath } : {}),
	};
}

function normalizeTestCase(value: unknown, label: string): IPortableTestCase {
	const test = requireObject(value, label);
	if (!["scene", "performance", "visual"].includes(test.kind as string)) {
		throw new Error(`${label}.kind must be scene, performance, or visual.`);
	}
	const kind = test.kind as IPortableTestCase["kind"];
	const result: IPortableTestCase = {
		id: requireString(test.id, `${label}.id`),
		name: requireString(test.name, `${label}.name`),
		enabled: test.enabled === undefined ? true : Boolean(test.enabled),
		kind,
		categories: normalizeCategories(test.categories, `${label}.categories`),
		...(test.timeoutMs === undefined ? {} : { timeoutMs: requireInteger(test.timeoutMs, `${label}.timeoutMs`, 100, 600_000) }),
		repeat: requireInteger(test.repeat ?? 1, `${label}.repeat`, 1, 100),
		setup: normalizeSteps(test.setup, `${label}.setup`),
		steps: normalizeSteps(test.steps, `${label}.steps`),
		teardown: normalizeSteps(test.teardown, `${label}.teardown`),
		assertions: normalizeAssertions(test.assertions, `${label}.assertions`),
	};
	if (kind === "performance") {
		result.performance = normalizePerformance(test.performance, `${label}.performance`);
	}
	if (kind === "visual") {
		result.visual = normalizeVisual(test.visual, `${label}.visual`);
	}
	return result;
}

function normalizeSuite(value: unknown, label: string): IPortableTestSuite {
	const suite = requireObject(value, label);
	if (!["edit", "play"].includes(suite.mode as string)) {
		throw new Error(`${label}.mode must be edit or play.`);
	}
	if (!Array.isArray(suite.tests) || suite.tests.length > MAX_TEST_CASES) {
		throw new Error(`${label}.tests must be an array of at most ${MAX_TEST_CASES} cases.`);
	}
	const tests = suite.tests.map((entry, index) => normalizeTestCase(entry, `${label}.tests[${index}]`));
	if (new Set(tests.map((test) => test.id)).size !== tests.length) {
		throw new Error(`${label} cannot contain duplicate test ids.`);
	}
	return {
		id: requireString(suite.id, `${label}.id`),
		name: requireString(suite.name, `${label}.name`),
		enabled: suite.enabled === undefined ? true : Boolean(suite.enabled),
		mode: suite.mode as PortableTestMode,
		categories: normalizeCategories(suite.categories, `${label}.categories`),
		...(suite.timeoutMs === undefined ? {} : { timeoutMs: requireInteger(suite.timeoutMs, `${label}.timeoutMs`, 100, 600_000) }),
		beforeEach: normalizeSteps(suite.beforeEach, `${label}.beforeEach`),
		afterEach: normalizeSteps(suite.afterEach, `${label}.afterEach`),
		tests,
	};
}

export function createPortableTestingState(): IPortableTestingState {
	return {
		version: PORTABLE_TESTING_VERSION,
		revision: 0,
		settings: { defaultTimeoutMs: 30_000, playPreparationTimeoutMs: 120_000, maximumRetainedRuns: MAX_TEST_RUNS },
		suites: [],
		runs: [],
	};
}

/** Validates and clones a complete portable testing state. */
export function normalizePortableTestingState(value: unknown): IPortableTestingState {
	const source = requireObject(value, "Testing state");
	if (source.version !== PORTABLE_TESTING_VERSION) {
		throw new Error(`Testing state version must be ${PORTABLE_TESTING_VERSION}.`);
	}
	if (!Array.isArray(source.suites) || source.suites.length > MAX_TEST_SUITES) {
		throw new Error(`Testing state suites must be an array of at most ${MAX_TEST_SUITES} suites.`);
	}
	const suites = source.suites.map((entry, index) => normalizeSuite(entry, `Testing state suites[${index}]`));
	if (new Set(suites.map((suite) => suite.id)).size !== suites.length) {
		throw new Error("Testing state cannot contain duplicate suite ids.");
	}
	if (suites.reduce((total, suite) => total + suite.tests.length, 0) > MAX_TEST_CASES) {
		throw new Error(`Testing state cannot contain more than ${MAX_TEST_CASES} total cases.`);
	}
	const settings = requireObject(source.settings ?? {}, "Testing state settings");
	const maximumRetainedRuns = requireInteger(settings.maximumRetainedRuns ?? MAX_TEST_RUNS, "Testing state settings.maximumRetainedRuns", 1, MAX_TEST_RUNS);
	const runs = Array.isArray(source.runs) ? (structuredClone(source.runs.slice(0, maximumRetainedRuns)) as IPortableTestRunReport[]) : [];
	return {
		version: PORTABLE_TESTING_VERSION,
		revision: requireInteger(source.revision ?? 0, "Testing state revision", 0, Number.MAX_SAFE_INTEGER),
		settings: {
			defaultTimeoutMs: requireInteger(settings.defaultTimeoutMs ?? 30_000, "Testing state settings.defaultTimeoutMs", 100, 600_000),
			playPreparationTimeoutMs: requireInteger(settings.playPreparationTimeoutMs ?? 120_000, "Testing state settings.playPreparationTimeoutMs", 1_000, 600_000),
			maximumRetainedRuns,
		},
		suites,
		runs,
	};
}

function abortError(signal?: AbortSignal): Error | null {
	return signal?.aborted ? new Error(typeof signal.reason === "string" ? signal.reason : "Test run canceled.") : null;
}

function nodeById(scene: PortableTestingScene, id: string): Node | null {
	return scene.getNodeById(id) ?? null;
}

function getPathValue(target: unknown, path: string): unknown {
	let value = target;
	for (const segment of path.split(".")) {
		if (!value || typeof value !== "object" || unsafePathSegments.has(segment)) {
			return undefined;
		}
		value = (value as Record<string, unknown>)[segment];
	}
	if (value && typeof value === "object" && typeof (value as { asArray?: unknown }).asArray === "function") {
		return (value as { asArray: () => unknown }).asArray();
	}
	return value;
}

function equalValue(actual: unknown, expected: unknown, epsilon = 0): boolean {
	if (typeof actual === "number" && typeof expected === "number") {
		return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= epsilon;
	}
	if (Array.isArray(actual) && Array.isArray(expected)) {
		return actual.length === expected.length && actual.every((value, index) => equalValue(value, expected[index], epsilon));
	}
	return JSON.stringify(actual) === JSON.stringify(expected);
}

function compareNumber(actual: number, operator: "equals" | "greater-than-or-equal" | "less-than-or-equal", expected: number): boolean {
	return operator === "equals" ? actual === expected : operator === "greater-than-or-equal" ? actual >= expected : actual <= expected;
}

function runAssertion(scene: PortableTestingScene, assertion: PortableTestAssertion): IPortableAssertionResult {
	if (assertion.type === "scene-count") {
		const collection = assertion.collection === "nodes" ? scene.getNodes?.() : scene[assertion.collection];
		if (!Array.isArray(collection)) {
			throw new Error(`Scene collection "${assertion.collection}" is unavailable on this target.`);
		}
		const actual = collection.length;
		const passed = compareNumber(actual, assertion.operator, assertion.expected);
		return {
			assertion,
			passed,
			actual,
			message: passed ? `${assertion.collection} count matched.` : `Expected ${assertion.collection} ${assertion.operator} ${assertion.expected}, received ${actual}.`,
		};
	}
	const node = nodeById(scene, assertion.nodeId);
	if (assertion.type === "node-exists") {
		const actual = Boolean(node);
		return {
			assertion,
			passed: actual === assertion.exists,
			actual,
			message: actual === assertion.exists ? "Node existence matched." : `Expected node existence ${assertion.exists}, received ${actual}.`,
		};
	}
	if (!node) {
		return { assertion, passed: false, message: `Node "${assertion.nodeId}" does not exist.` };
	}
	if (assertion.type === "node-enabled") {
		const actual = node.isEnabled();
		return {
			assertion,
			passed: actual === assertion.equals,
			actual,
			message: actual === assertion.equals ? "Node enabled state matched." : `Expected enabled ${assertion.equals}, received ${actual}.`,
		};
	}
	if (assertion.type === "node-position" || assertion.type === "node-rotation" || assertion.type === "node-scaling") {
		const property = assertion.type.slice("node-".length) as "position" | "rotation" | "scaling";
		const actual = (node as unknown as Record<string, { asArray?: () => number[] }>)[property]?.asArray?.();
		const passed = Array.isArray(actual) && equalValue(actual, assertion.equals, assertion.epsilon ?? 0.001);
		return {
			assertion,
			passed,
			actual,
			message: passed ? `Node ${property} matched.` : `Expected ${property} ${JSON.stringify(assertion.equals)}, received ${JSON.stringify(actual)}.`,
		};
	}
	const actual = getPathValue(node, assertion.path);
	let passed = false;
	if (assertion.operator === "equals" || assertion.operator === "not-equals") {
		passed = equalValue(actual, assertion.expected, assertion.epsilon ?? 0);
		if (assertion.operator === "not-equals") {
			passed = !passed;
		}
	} else if (assertion.operator === "contains") {
		passed =
			typeof actual === "string"
				? actual.includes(String(assertion.expected))
				: Array.isArray(actual)
					? actual.some((value) => equalValue(value, assertion.expected, assertion.epsilon ?? 0))
					: false;
	} else if (typeof actual === "number" && typeof assertion.expected === "number") {
		passed =
			assertion.operator === "greater-than"
				? actual > assertion.expected
				: assertion.operator === "greater-than-or-equal"
					? actual >= assertion.expected
					: assertion.operator === "less-than"
						? actual < assertion.expected
						: actual <= assertion.expected;
	}
	return { assertion, passed, actual, message: passed ? `Node property ${assertion.path} matched.` : `Node property ${assertion.path} did not satisfy ${assertion.operator}.` };
}

type INodeSnapshot = { enabled: boolean; position?: number[]; rotation?: number[]; scaling?: number[] };

async function defaultWaitMilliseconds(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (abortError(signal)) {
		throw abortError(signal)!;
	}
	await new Promise<void>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(abortError(signal)!);
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function defaultWaitFrames(scene: PortableTestingScene, frames: number, signal?: AbortSignal): Promise<void> {
	for (let index = 0; index < frames; index++) {
		if (abortError(signal)) {
			throw abortError(signal)!;
		}
		if (scene.activeCamera) {
			scene.render(false);
		} else {
			scene.onBeforeRenderObservable.notifyObservers(scene);
			scene.onAfterRenderObservable.notifyObservers(scene);
		}
		await Promise.resolve();
	}
}

function snapshotNode(snapshots: Map<Node, INodeSnapshot>, node: Node): void {
	if (snapshots.has(node)) {
		return;
	}
	const transform = node as unknown as Record<string, { asArray?: () => number[] }>;
	snapshots.set(node, {
		enabled: node.isEnabled(),
		...(transform.position?.asArray ? { position: transform.position.asArray() } : {}),
		...(transform.rotation?.asArray ? { rotation: transform.rotation.asArray() } : {}),
		...(transform.scaling?.asArray ? { scaling: transform.scaling.asArray() } : {}),
	});
}

function copyVector(node: Node, property: "position" | "rotation" | "scaling", value: number[]): void {
	const vector = (node as unknown as Record<string, { copyFromFloats?: (x: number, y: number, z: number) => void }>)[property];
	if (!vector?.copyFromFloats) {
		throw new Error(`Node "${node.id}" does not expose ${property}.`);
	}
	vector.copyFromFloats(value[0], value[1], value[2]);
}

async function runSteps(scene: PortableTestingScene, steps: PortableTestStep[], snapshots: Map<Node, INodeSnapshot>, options: IPortableTestRunnerOptions): Promise<void> {
	for (const step of steps) {
		if (abortError(options.signal)) {
			throw abortError(options.signal)!;
		}
		switch (step.type) {
			case "wait-frames":
				await (options.waitFrames ?? defaultWaitFrames)(scene, step.frames, options.signal);
				if (abortError(options.signal)) {
					throw abortError(options.signal)!;
				}
				break;
			case "wait-ms":
				await (options.waitMilliseconds ?? defaultWaitMilliseconds)(step.milliseconds, options.signal);
				if (abortError(options.signal)) {
					throw abortError(options.signal)!;
				}
				break;
			case "dispatch-pointer":
				if (!options.dispatchPointer) {
					throw new Error("This test target does not support pointer dispatch.");
				}
				await options.dispatchPointer(scene, step);
				break;
			case "set-node-enabled": {
				const node = nodeById(scene, step.nodeId);
				if (!node) {
					throw new Error(`Step node "${step.nodeId}" does not exist.`);
				}
				snapshotNode(snapshots, node);
				node.setEnabled(step.enabled);
				break;
			}
			case "set-node-position":
			case "set-node-rotation":
			case "set-node-scaling": {
				const node = nodeById(scene, step.nodeId);
				if (!node) {
					throw new Error(`Step node "${step.nodeId}" does not exist.`);
				}
				snapshotNode(snapshots, node);
				copyVector(node, step.type.slice("set-node-".length) as "position" | "rotation" | "scaling", step.value);
				break;
			}
		}
	}
}

function restoreSnapshots(snapshots: Map<Node, INodeSnapshot>): void {
	for (const [node, snapshot] of snapshots) {
		if (node.isDisposed()) {
			continue;
		}
		node.setEnabled(snapshot.enabled);
		if (snapshot.position) {
			copyVector(node, "position", snapshot.position);
		}
		if (snapshot.rotation) {
			copyVector(node, "rotation", snapshot.rotation);
		}
		if (snapshot.scaling) {
			copyVector(node, "scaling", snapshot.scaling);
		}
	}
}

function defaultMetrics(scene: PortableTestingScene): Partial<Record<PortablePerformanceMetric, number | null>> {
	const engine = scene.getEngine();
	return {
		frameRate: engine.getFps(),
		frameTimeMs: engine.getDeltaTime(),
		drawCalls: (engine as unknown as { _drawCalls?: { current?: number } })._drawCalls?.current ?? null,
		activeMeshes: scene.getActiveMeshes().length,
		totalVertices: scene.getTotalVertices(),
		meshes: scene.meshes.length,
		materials: scene.materials.length,
		textures: scene.textures.length,
		lights: scene.lights.length,
		cameras: scene.cameras.length,
		particleSystems: scene.particleSystems.length,
		gpuFrameTimeMs: null,
		gpuFrameTimeAverageMs: null,
	};
}

function summarize(values: number[]): IPortablePerformanceSummary {
	if (!values.length) {
		return { available: false, sampleCount: 0, minimum: null, maximum: null, mean: null, median: null, p95: null };
	}
	const sorted = [...values].sort((left, right) => left - right);
	const midpoint = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[midpoint] : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
	return {
		available: true,
		sampleCount: values.length,
		minimum: sorted[0],
		maximum: sorted[sorted.length - 1],
		mean: values.reduce((total, value) => total + value, 0) / values.length,
		median,
		p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
	};
}

async function runPerformance(scene: PortableTestingScene, test: IPortableTestCase, options: IPortableTestRunnerOptions): Promise<IPortableTestCaseResult["performance"]> {
	const configuration = test.performance!;
	if (configuration.warmupFrames) {
		await (options.waitFrames ?? defaultWaitFrames)(scene, configuration.warmupFrames, options.signal);
	}
	const samples: Partial<Record<PortablePerformanceMetric, number>>[] = [];
	for (let index = 0; index < configuration.measurementFrames; index++) {
		await (options.waitFrames ?? defaultWaitFrames)(scene, 1, options.signal);
		const current = (options.measureMetrics ?? defaultMetrics)(scene);
		const sample: Partial<Record<PortablePerformanceMetric, number>> = {};
		for (const [metric, value] of Object.entries(current) as [PortablePerformanceMetric, number | null][]) {
			if (typeof value === "number" && Number.isFinite(value)) {
				sample[metric] = value;
			}
		}
		samples.push(sample);
	}
	const summary: Partial<Record<PortablePerformanceMetric, IPortablePerformanceSummary>> = {};
	for (const metric of performanceMetrics) {
		summary[metric] = summarize(samples.map((sample) => sample[metric]).filter((value): value is number => typeof value === "number"));
	}
	const thresholds = configuration.thresholds.map((threshold) => {
		const metricSummary = summary[threshold.metric]!;
		const actual = metricSummary[threshold.statistic];
		const available = typeof actual === "number" && Number.isFinite(actual);
		const passed = !available ? threshold.allowUnavailable === true : threshold.operator === "less-than-or-equal" ? actual <= threshold.value : actual >= threshold.value;
		return {
			threshold,
			actual: available ? actual : null,
			available,
			passed,
			message: !available
				? threshold.allowUnavailable
					? `${threshold.metric} is unavailable and explicitly allowed.`
					: `${threshold.metric} is unavailable on this target.`
				: passed
					? `${threshold.metric} ${threshold.statistic} satisfied ${threshold.operator} ${threshold.value}.`
					: `${threshold.metric} ${threshold.statistic} was ${actual}, expected ${threshold.operator} ${threshold.value}.`,
		};
	});
	return { samples, summary, thresholds };
}

async function executeCase(
	scene: PortableTestingScene,
	suite: IPortableTestSuite,
	test: IPortableTestCase,
	repeatIndex: number,
	runId: string,
	options: IPortableTestRunnerOptions
): Promise<IPortableTestCaseResult> {
	const started = Date.now();
	const startedAt = new Date(started).toISOString();
	const snapshots = new Map<Node, INodeSnapshot>();
	const assertions: IPortableAssertionResult[] = [];
	const errors: string[] = [];
	let performance: IPortableTestCaseResult["performance"];
	let visual: IPortableVisualResult | undefined;
	let status: PortableTestStatus = "passed";
	let timedOut = false;
	const timeoutMs = test.timeoutMs ?? suite.timeoutMs;
	const caseController = new AbortController();
	const onRunAbort = (): void => caseController.abort(options.signal?.reason ?? "Test run canceled.");
	if (options.signal?.aborted) {
		onRunAbort();
	} else {
		options.signal?.addEventListener("abort", onRunAbort, { once: true });
	}
	const caseOptions: IPortableTestRunnerOptions = { ...options, signal: caseController.signal };
	const body = async (): Promise<void> => {
		await runSteps(scene, suite.beforeEach, snapshots, caseOptions);
		await runSteps(scene, test.setup, snapshots, caseOptions);
		await runSteps(scene, test.steps, snapshots, caseOptions);
		if (test.kind === "scene") {
			assertions.push(...test.assertions.map((assertion) => runAssertion(scene, assertion)));
		}
		if (test.kind === "performance") {
			performance = await runPerformance(scene, test, caseOptions);
		}
		if (test.kind === "visual") {
			if (!caseOptions.runVisual) {
				throw new Error("This test target does not support visual regression cases.");
			}
			visual = await caseOptions.runVisual(scene, test, runId, caseController.signal);
		}
	};
	try {
		if (timeoutMs) {
			let timer: ReturnType<typeof setTimeout> | null = null;
			await Promise.race([
				body(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						timedOut = true;
						caseController.abort(`Test exceeded its ${timeoutMs} ms timeout.`);
						reject(new Error(`Test exceeded its ${timeoutMs} ms timeout.`));
					}, timeoutMs);
				}),
			]).finally(() => timer && clearTimeout(timer));
		} else {
			await body();
		}
	} catch (error) {
		errors.push(error instanceof Error ? error.message : String(error));
		status = options.signal?.aborted ? "canceled" : timedOut ? "timed-out" : "failed";
	} finally {
		options.signal?.removeEventListener("abort", onRunAbort);
		const cleanupOptions: IPortableTestRunnerOptions = { ...options, signal: undefined };
		try {
			await runSteps(scene, test.teardown, snapshots, cleanupOptions);
			await runSteps(scene, suite.afterEach, snapshots, cleanupOptions);
		} catch (error) {
			errors.push(`Teardown: ${error instanceof Error ? error.message : String(error)}`);
			if (status === "passed") {
				status = "failed";
			}
		} finally {
			restoreSnapshots(snapshots);
		}
	}
	if (status === "passed" && assertions.some((assertion) => !assertion.passed)) {
		status = "failed";
	}
	if (status === "passed" && performance?.thresholds.some((threshold) => !threshold.passed)) {
		status = "failed";
	}
	if (status === "passed" && visual && !visual.passed) {
		status = "failed";
	}
	const finished = Date.now();
	return {
		id: test.id,
		suiteId: suite.id,
		name: test.name,
		suiteName: suite.name,
		kind: test.kind,
		mode: suite.mode,
		repeatIndex,
		status,
		startedAt,
		finishedAt: new Date(finished).toISOString(),
		durationMs: finished - started,
		assertions,
		...(performance ? { performance } : {}),
		...(visual ? { visual } : {}),
		errors,
	};
}

function selectedCases(
	state: IPortableTestingState,
	request: IPortableTestRunRequest,
	options: IPortableTestRunnerOptions
): { suite: IPortableTestSuite; test: IPortableTestCase }[] {
	const suiteIds = request.suiteIds ? new Set(request.suiteIds) : null;
	const testIds = request.testIds ? new Set(request.testIds) : null;
	const modes = new Set(request.modes ?? ["edit", "play"]);
	const supportedModes = new Set(options.supportedModes ?? ["edit", "play"]);
	const categories = request.categories ? new Set(request.categories) : null;
	const search = request.search?.trim().toLowerCase();
	const failedIds = request.failedOnly ? new Set((options.previousRun?.results ?? []).filter((result) => result.status !== "passed").map((result) => result.id)) : null;
	return state.suites.flatMap((suite) =>
		suite.tests
			.filter((test) => {
				if (!suite.enabled || !test.enabled || !modes.has(suite.mode) || !supportedModes.has(suite.mode)) {
					return false;
				}
				if (suiteIds && !suiteIds.has(suite.id)) {
					return false;
				}
				if (testIds && !testIds.has(test.id)) {
					return false;
				}
				if (failedIds && !failedIds.has(test.id)) {
					return false;
				}
				if (categories && ![...suite.categories, ...test.categories].some((category) => categories.has(category))) {
					return false;
				}
				if (search && !`${suite.name} ${test.name} ${suite.categories.join(" ")} ${test.categories.join(" ")}`.toLowerCase().includes(search)) {
					return false;
				}
				return true;
			})
			.map((test) => ({ suite, test }))
	);
}

/** Runs bounded declarative scene, performance, and visual cases against one live Babylon scene. */
export async function runPortableTestSuites(
	scene: PortableTestingScene,
	rawState: IPortableTestingState,
	rawRequest: IPortableTestRunRequest,
	options: IPortableTestRunnerOptions
): Promise<IPortableTestRunReport> {
	const state = normalizePortableTestingState(rawState);
	const request = structuredClone(rawRequest ?? {});
	if (request.repeatOverride !== undefined) {
		requireInteger(request.repeatOverride, "repeatOverride", 1, 100);
	}
	if (request.search !== undefined && (typeof request.search !== "string" || request.search.length > 256)) {
		throw new Error("search must be a string no longer than 256 characters.");
	}
	for (const [label, values] of [
		["suiteIds", request.suiteIds],
		["testIds", request.testIds],
		["categories", request.categories],
	] as const) {
		if (values !== undefined && (!Array.isArray(values) || values.length > MAX_TEST_CASES || !values.every((value) => typeof value === "string" && value.length > 0))) {
			throw new Error(`${label} must be an array of bounded non-empty strings.`);
		}
	}
	if (request.modes !== undefined && (!Array.isArray(request.modes) || !request.modes.every((mode) => mode === "edit" || mode === "play"))) {
		throw new Error("modes must contain edit and/or play.");
	}
	const started = Date.now();
	const id = `test-run-${started}-${Math.random().toString(36).slice(2, 10)}`;
	const cases = selectedCases(state, request, options);
	const total = cases.reduce((count, entry) => count + (request.repeatOverride ?? entry.test.repeat), 0);
	const results: IPortableTestCaseResult[] = [];
	let completed = 0;
	for (const { suite, test } of cases) {
		const repeat = request.repeatOverride ?? test.repeat;
		for (let repeatIndex = 0; repeatIndex < repeat; repeatIndex++) {
			if (options.signal?.aborted) {
				break;
			}
			options.onProgress?.({ completed, total, currentSuiteId: suite.id, currentTestId: test.id, status: "running" });
			const result = await executeCase(scene, suite, test, repeatIndex, id, options);
			results.push(result);
			completed++;
			options.onProgress?.({ completed, total, currentSuiteId: suite.id, currentTestId: test.id, status: result.status });
			if (request.failFast && result.status !== "passed") {
				break;
			}
		}
		if (options.signal?.aborted || (request.failFast && results.at(-1)?.status !== "passed")) {
			break;
		}
	}
	const finished = Date.now();
	const summary = {
		total: results.length,
		passed: results.filter((result) => result.status === "passed").length,
		failed: results.filter((result) => result.status === "failed").length,
		skipped: results.filter((result) => result.status === "skipped").length,
		canceled: results.filter((result) => result.status === "canceled").length,
		timedOut: results.filter((result) => result.status === "timed-out").length,
	};
	const status: PortableTestStatus = options.signal?.aborted ? "canceled" : summary.failed ? "failed" : summary.timedOut ? "timed-out" : "passed";
	return {
		id,
		sequence: options.sequence ?? 1,
		target: options.target,
		status,
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(finished).toISOString(),
		durationMs: finished - started,
		filters: request,
		summary,
		results,
		limitations: [
			"Portable tests do not claim NUnit, Unity assembly, coroutine, proprietary player-protocol, or binary compatibility.",
			"Performance samples describe the selected browser/engine/target and are not hardware-independent benchmarks.",
		],
	};
}

/** Adds one completed report to bounded newest-first history without changing suite revision. */
export function retainPortableTestRun(state: IPortableTestingState, report: IPortableTestRunReport): IPortableTestingState {
	const normalized = normalizePortableTestingState(state);
	normalized.runs = [structuredClone(report), ...normalized.runs.filter((run) => run.id !== report.id)].slice(0, normalized.settings.maximumRetainedRuns);
	return normalized;
}

/** Serializes a portable report as an NUnit-compatible subset accepted by common JUnit consumers. */
export function portableTestRunToJUnit(report: IPortableTestRunReport): string {
	const escape = (value: unknown): string => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	const cases = report.results
		.map((result) => {
			const failure = result.status === "passed" ? "" : `<failure message="${escape(result.errors[0] ?? result.status)}">${escape(result.errors.join("\n"))}</failure>`;
			return `<testcase classname="${escape(result.suiteName)}" name="${escape(result.name)}" time="${(result.durationMs / 1000).toFixed(6)}">${failure}</testcase>`;
		})
		.join("");
	return `<?xml version="1.0" encoding="UTF-8"?><testsuites tests="${report.summary.total}" failures="${report.summary.failed + report.summary.timedOut}" skipped="${report.summary.skipped + report.summary.canceled}" time="${(report.durationMs / 1000).toFixed(6)}"><testsuite name="Zvibe Editor" tests="${report.summary.total}" failures="${report.summary.failed + report.summary.timedOut}" skipped="${report.summary.skipped + report.summary.canceled}" time="${(report.durationMs / 1000).toFixed(6)}">${cases}</testsuite></testsuites>`;
}
