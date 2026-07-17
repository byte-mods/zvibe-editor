import { Scene, Tools } from "babylonjs";
import { dirname, isAbsolute, join, relative } from "path/posix";
import { mkdir, pathExists } from "fs-extra";
import sharp from "sharp";
import { IMCPActionOptions } from "../action";
import { getSceneDiagnostics } from "../editor";
import { projectConfiguration } from "../../project/configuration";

function projectImagePath(path: string): string {
	if (!projectConfiguration.path) throw new Error("No project is currently open.");
	const directory = dirname(projectConfiguration.path);
	const absolute = isAbsolute(path) ? path : join(directory, path);
	if (absolute !== directory && !absolute.startsWith(`${directory}/`)) throw new Error("Visual-regression image paths must stay inside the open project.");
	return absolute;
}

function tests(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorSceneTests ??= []);
}
function test(scene: Scene, data: any): any {
	const value = tests(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) throw new Error("Scene test not found.");
	return value;
}

const performanceMetrics = new Set([
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

function performanceBudgets(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPerformanceBudgets ??= []);
}

function performanceBudget(scene: Scene, data: any): any {
	const value = performanceBudgets(scene).find((candidate) => candidate.id === data.id || candidate.name === data.name);
	if (!value) throw new Error("Performance budget not found.");
	return value;
}

function validatePerformanceLimits(limits: any): void {
	if (!limits || typeof limits !== "object" || Array.isArray(limits) || !Object.keys(limits).length) throw new Error("Performance budgets require one or more metric limits.");
	for (const [metric, limit] of Object.entries(limits)) {
		if (!performanceMetrics.has(metric)) throw new Error(`Unsupported performance metric "${metric}".`);
		if (!Number.isFinite(limit) || (limit as number) < 0) throw new Error(`Performance limit for "${metric}" must be a finite number greater than or equal to zero.`);
	}
}
function validateAssertions(assertions: any): void {
	if (!Array.isArray(assertions)) throw new Error("Scene-test assertions must be an array.");
	for (const assertion of assertions) {
		if (!assertion?.nodeId) throw new Error("Every scene-test assertion requires a nodeId.");
		if (assertion.type === "node-enabled" && typeof assertion.equals !== "boolean") throw new Error("node-enabled assertions require a boolean equals value.");
		if (assertion.type === "node-position") {
			if (!Array.isArray(assertion.equals) || assertion.equals.length !== 3 || !assertion.equals.every(Number.isFinite))
				throw new Error("node-position assertions require three finite equals coordinates.");
			if (assertion.epsilon !== undefined && (!Number.isFinite(assertion.epsilon) || assertion.epsilon <= 0))
				throw new Error("node-position assertion epsilon must be a positive finite number.");
		}
		if (!["node-enabled", "node-position"].includes(assertion.type)) throw new Error(`Unsupported scene-test assertion type "${assertion.type}".`);
	}
}
function run(scene: Scene, value: any): any {
	const assertions = value.assertions.map((assertion: any) => {
		const node = scene.getNodeById(assertion.nodeId) as any;
		if (!node) return { ...assertion, passed: false, message: `Missing node ${assertion.nodeId}` };
		if (assertion.type === "node-enabled") return { ...assertion, passed: node.isEnabled() === assertion.equals, actual: node.isEnabled() };
		const actual = node.position?.asArray();
		const epsilon = assertion.epsilon ?? 0.001;
		const passed = !!actual && actual.every((component: number, index: number) => Math.abs(component - assertion.equals[index]) <= epsilon);
		return { ...assertion, passed, actual };
	});
	value.lastRun = { at: new Date().toISOString(), passed: assertions.every((assertion: any) => assertion.passed), assertions };
	return { id: value.id, name: value.name, ...value.lastRun };
}
export function listSceneTests(scene: Scene): any {
	return { tests: structuredClone(tests(scene)) };
}
export function createSceneTest(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (tests(scene).some((value) => value.name === data.name)) throw new Error(`Scene test "${data.name}" already exists.`);
	validateAssertions(data.assertions ?? []);
	const value = { id: data.id ?? Tools.RandomId(), name: data.name, assertions: data.assertions ?? [] };
	tests(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
/** Updates a persisted scene test's name and/or assertions. */
export function setSceneTest(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = test(scene, data);
	if (data.name !== undefined && data.name !== value.name && tests(scene).some((candidate) => candidate.name === data.name))
		throw new Error(`Scene test "${data.name}" already exists.`);
	if (data.assertions !== undefined) validateAssertions(data.assertions);
	if (data.name !== undefined) value.name = data.name;
	if (data.assertions !== undefined) value.assertions = structuredClone(data.assertions);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}
export function runSceneTests(scene: Scene, data: any, options: IMCPActionOptions): any {
	const results = data.id || data.name ? [run(scene, test(scene, data))] : tests(scene).map((value) => run(scene, value));
	options.editor.layout.inspector.forceUpdate();
	return { passed: results.every((result) => result.passed), results };
}
export function deleteSceneTest(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = test(scene, data);
	tests(scene).splice(tests(scene).indexOf(value), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}

/** Lists persisted performance budgets and their latest diagnostics result. */
export function listPerformanceBudgets(scene: Scene): any {
	return { budgets: structuredClone(performanceBudgets(scene)), supportedMetrics: [...performanceMetrics] };
}

/** Creates a named diagnostics threshold set for build/play-mode performance checks. */
export function createPerformanceBudget(scene: Scene, data: any, options: IMCPActionOptions): any {
	if (!data.name?.trim()) throw new Error("Performance budgets require a non-empty name.");
	if (performanceBudgets(scene).some((value) => value.name === data.name)) throw new Error(`Performance budget "${data.name}" already exists.`);
	validatePerformanceLimits(data.limits);
	const value = { id: data.id ?? Tools.RandomId(), name: data.name.trim(), limits: structuredClone(data.limits) };
	performanceBudgets(scene).push(value);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Updates the name and/or metric thresholds for an existing performance budget. */
export function setPerformanceBudget(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = performanceBudget(scene, data);
	if (data.name !== undefined) {
		if (!data.name.trim()) throw new Error("Performance budgets require a non-empty name.");
		if (data.name !== value.name && performanceBudgets(scene).some((candidate) => candidate.name === data.name))
			throw new Error(`Performance budget "${data.name}" already exists.`);
		value.name = data.name.trim();
	}
	if (data.limits !== undefined) {
		validatePerformanceLimits(data.limits);
		value.limits = structuredClone(data.limits);
	}
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(value);
}

/** Evaluates a budget against current renderer diagnostics and persists the result. */
export function runPerformanceBudgets(scene: Scene, data: any, options: IMCPActionOptions): any {
	const diagnostics = getSceneDiagnostics(scene);
	const values = data.id || data.name ? [performanceBudget(scene, data)] : performanceBudgets(scene);
	const results = values.map((budget) => {
		const limits = Object.entries(budget.limits as Record<string, number>).map(([metric, limit]) => {
			const actual = diagnostics[metric];
			return {
				metric,
				limit,
				actual,
				available: typeof actual === "number" && Number.isFinite(actual),
				passed: typeof actual !== "number" || !Number.isFinite(actual) || actual <= limit,
			};
		});
		budget.lastRun = { at: new Date().toISOString(), passed: limits.every((limit) => limit.passed), limits };
		return { id: budget.id, name: budget.name, ...budget.lastRun };
	});
	options.editor.layout.inspector.forceUpdate();
	return { passed: results.every((result) => result.passed), diagnostics, results };
}

/** Deletes a persisted diagnostics performance budget. */
export function deletePerformanceBudget(scene: Scene, data: any, options: IMCPActionOptions): any {
	const value = performanceBudget(scene, data);
	performanceBudgets(scene).splice(performanceBudgets(scene).indexOf(value), 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: value.id };
}

/** Compares two project raster images pixel-for-pixel with an optional per-channel tolerance. */
export async function compareVisualRegressionImages(_scene: Scene, data: any, _options: IMCPActionOptions): Promise<any> {
	const baselinePath = projectImagePath(data.baselinePath);
	const candidatePath = projectImagePath(data.candidatePath);
	if (!(await pathExists(baselinePath)) || !(await pathExists(candidatePath))) throw new Error("Both baselinePath and candidatePath must reference existing project images.");
	const tolerance = data.tolerance ?? 0;
	if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw new Error("tolerance must be an integer from 0 to 255.");
	const [baseline, candidate] = await Promise.all([
		sharp(baselinePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
		sharp(candidatePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
	]);
	if (baseline.info.width !== candidate.info.width || baseline.info.height !== candidate.info.height)
		return {
			passed: false,
			reason: "dimension-mismatch",
			baseline: { width: baseline.info.width, height: baseline.info.height },
			candidate: { width: candidate.info.width, height: candidate.info.height },
		};
	let differingPixels = 0;
	const diff = Buffer.alloc(baseline.data.length);
	for (let offset = 0; offset < baseline.data.length; offset += 4) {
		if ([0, 1, 2, 3].some((channel) => Math.abs(baseline.data[offset + channel] - candidate.data[offset + channel]) > tolerance)) {
			differingPixels++;
			diff[offset] = 255;
			diff[offset + 3] = 255;
		}
	}
	let diffPath: string | null = null;
	if (data.diffPath && differingPixels) {
		const output = projectImagePath(data.diffPath);
		if (!output.endsWith(".png")) throw new Error("diffPath must end in .png.");
		await mkdir(dirname(output), { recursive: true });
		await sharp(diff, { raw: { width: baseline.info.width, height: baseline.info.height, channels: 4 } })
			.png()
			.toFile(output);
		diffPath = relative(dirname(projectConfiguration.path!), output);
	}
	return {
		passed: differingPixels === 0,
		baselinePath: relative(dirname(projectConfiguration.path!), baselinePath),
		candidatePath: relative(dirname(projectConfiguration.path!), candidatePath),
		diffPath,
		width: baseline.info.width,
		height: baseline.info.height,
		differingPixels,
		totalPixels: baseline.info.width * baseline.info.height,
		tolerance,
	};
}
