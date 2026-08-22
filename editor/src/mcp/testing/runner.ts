import { Scene } from "babylonjs";
import {
	IPortableTestingState,
	IPortableTestRunReport,
	IPortableTestRunRequest,
	IPortableVisualResult,
	portableTestRunToJUnit,
	retainPortableTestRun,
	runPortableTestSuites,
} from "babylonjs-editor-tools";
import { dirname, relative } from "path/posix";
import { mkdir, writeFile } from "fs-extra";

import { getSceneDiagnostics } from "../editor";
import { getScreenshot } from "../screenshot";
import { IMCPActionOptions } from "../action";
import { projectConfiguration } from "../../project/configuration";
import { cancelRemoteDeviceTests, runRemoteDeviceTests } from "../device/device-lab";

import { compareVisualRegressionImages, projectTestingPath } from "./visual";
import { persistTestingState, testingState } from "./state";

interface IActiveTestingRun {
	id: string;
	controller: AbortController;
	startedAt: string;
	target: string;
	progress: { completed: number; total: number; currentSuiteId: string | null; currentTestId: string | null; status: string };
	cancelRemote?: () => Promise<void>;
}

const activeRuns = new WeakMap<Scene, IActiveTestingRun>();

type PortableRunnerScene = Parameters<typeof runPortableTestSuites>[0];

function portableScene(scene: Scene): PortableRunnerScene {
	return scene as unknown as PortableRunnerScene;
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120) || "test";
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error(typeof signal.reason === "string" ? signal.reason : "Test run canceled.");
	}
}

async function waitMilliseconds(milliseconds: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout>;
		const onAbort = (): void => {
			clearTimeout(timeout);
			reject(new Error(typeof signal?.reason === "string" ? signal.reason : "Test run canceled."));
		};
		timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, milliseconds);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function waitFrames(scene: Scene, frames: number, signal?: AbortSignal): Promise<void> {
	for (let index = 0; index < frames; index++) {
		throwIfAborted(signal);
		await new Promise<void>((resolve, reject) => {
			let observer: any = null;
			const onAbort = (): void => {
				if (observer) {
					scene.onAfterRenderObservable.remove(observer);
				}
				reject(new Error(typeof signal?.reason === "string" ? signal.reason : "Test run canceled."));
			};
			observer = scene.onAfterRenderObservable.addOnce(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			});
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}

function dispatchPointer(options: IMCPActionOptions, step: { phase: "down" | "move" | "up"; x: number; y: number; button?: number }): void {
	const canvas = options.editor.layout.preview.canvas;
	if (!canvas) {
		throw new Error("The editor preview canvas is unavailable for pointer dispatch.");
	}
	const bounds = canvas.getBoundingClientRect();
	const event = new PointerEvent(`pointer${step.phase}`, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: "touch",
		isPrimary: true,
		button: step.button ?? 0,
		buttons: step.phase === "up" ? 0 : 1,
		clientX: bounds.left + step.x * bounds.width,
		clientY: bounds.top + step.y * bounds.height,
	});
	canvas.dispatchEvent(event);
}

async function runVisual(scene: Scene, test: any, runId: string, signal?: AbortSignal): Promise<IPortableVisualResult> {
	throwIfAborted(signal);
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	const visual = test.visual!;
	const directory = `.bjseditor/test-results/${safeSegment(runId)}`;
	const candidatePath = `${directory}/${safeSegment(test.id)}-candidate.png`;
	const diffPath = visual.diffPath ?? `${directory}/${safeSegment(test.id)}-diff.png`;
	const screenshot = await getScreenshot(scene, {});
	throwIfAborted(signal);
	const absoluteCandidate = projectTestingPath(candidatePath);
	await mkdir(dirname(absoluteCandidate), { recursive: true });
	await writeFile(absoluteCandidate, Buffer.from(screenshot.imageBase64, "base64"));
	throwIfAborted(signal);
	const comparison = await compareVisualRegressionImages(scene, {
		baselinePath: visual.baselinePath,
		candidatePath,
		tolerance: visual.tolerance,
		diffPath,
	});
	const differingPixels = typeof comparison.differingPixels === "number" ? comparison.differingPixels : undefined;
	return {
		passed: !comparison.reason && differingPixels !== undefined && differingPixels <= visual.maximumDifferingPixels,
		baselinePath: visual.baselinePath,
		candidatePath,
		diffPath: comparison.diffPath ?? null,
		...(differingPixels === undefined ? {} : { differingPixels }),
		...(typeof comparison.totalPixels === "number" ? { totalPixels: comparison.totalPixels } : {}),
		...(comparison.reason ? { reason: comparison.reason } : {}),
	};
}

async function waitForPlayScene(options: IMCPActionOptions, timeoutMs: number, signal: AbortSignal): Promise<Scene> {
	const play = options.editor.layout.preview.play;
	const started = Date.now();
	while (!play.canPlayScene) {
		throwIfAborted(signal);
		if (!play.state.playing && !play.state.preparingPlay && !play.state.loading) {
			throw new Error("Editor Play mode stopped before the test scene became ready.");
		}
		if (Date.now() - started > timeoutMs) {
			throw new Error(`Editor Play mode did not become ready within ${timeoutMs} ms.`);
		}
		await waitMilliseconds(25, signal);
	}
	if (!play.scene) {
		throw new Error("Editor Play mode reported ready without a scene.");
	}
	return play.scene;
}

function subset(state: IPortableTestingState, mode: "edit" | "play"): IPortableTestingState {
	return { ...structuredClone(state), suites: state.suites.filter((suite) => suite.mode === mode) };
}

function hasRunnableCase(state: IPortableTestingState, mode: "edit" | "play", request: IPortableTestRunRequest): boolean {
	const suiteIds = request.suiteIds ? new Set(request.suiteIds) : null;
	const testIds = request.testIds ? new Set(request.testIds) : null;
	const categories = request.categories ? new Set(request.categories) : null;
	const search = request.search?.toLowerCase();
	const failedIds = request.failedOnly ? new Set((state.runs[0]?.results ?? []).filter((result) => result.status !== "passed").map((result) => result.id)) : null;
	return state.suites.some(
		(suite) =>
			suite.enabled &&
			suite.mode === mode &&
			(!suiteIds || suiteIds.has(suite.id)) &&
			suite.tests.some(
				(test) =>
					test.enabled &&
					(!testIds || testIds.has(test.id)) &&
					(!failedIds || failedIds.has(test.id)) &&
					(!categories || [...suite.categories, ...test.categories].some((category) => categories.has(category))) &&
					(!search || `${suite.name} ${test.name} ${suite.categories.join(" ")} ${test.categories.join(" ")}`.toLowerCase().includes(search))
			)
	);
}

function mergeReports(id: string, started: number, reports: IPortableTestRunReport[], request: IPortableTestRunRequest): IPortableTestRunReport {
	const finished = Date.now();
	const results = reports.flatMap((report) => report.results);
	const summary = {
		total: results.length,
		passed: results.filter((result) => result.status === "passed").length,
		failed: results.filter((result) => result.status === "failed").length,
		skipped: results.filter((result) => result.status === "skipped").length,
		canceled: results.filter((result) => result.status === "canceled").length,
		timedOut: results.filter((result) => result.status === "timed-out").length,
	};
	const canceled = reports.some((report) => report.status === "canceled");
	return {
		id,
		sequence: Math.max(1, ...reports.map((report) => report.sequence)),
		target: reports.length > 1 ? "editor-mixed" : (reports[0]?.target ?? "editor-edit"),
		status: canceled ? "canceled" : summary.failed ? "failed" : summary.timedOut ? "timed-out" : "passed",
		startedAt: new Date(started).toISOString(),
		finishedAt: new Date(finished).toISOString(),
		durationMs: finished - started,
		filters: structuredClone(request),
		summary,
		results,
		limitations: [...new Set(reports.flatMap((report) => report.limitations))],
	};
}

/** Runs selected suites in the live Edit scene and/or the editor's real exported/compiled Play scene. */
export async function runTesting(scene: Scene, data: any, options: IMCPActionOptions): Promise<IPortableTestRunReport> {
	if (activeRuns.has(scene)) {
		throw new Error("A test run is already active for this scene.");
	}
	const state = testingState(scene);
	if (!Number.isInteger(data.expectedRevision) || data.expectedRevision !== state.revision) {
		throw new Error(`Testing state revision is ${state.revision}; received stale or missing expectedRevision ${String(data.expectedRevision)}.`);
	}
	const request: IPortableTestRunRequest = {
		...(data.suiteIds ? { suiteIds: data.suiteIds } : {}),
		...(data.testIds ? { testIds: data.testIds } : {}),
		...(data.modes ? { modes: data.modes } : {}),
		...(data.categories ? { categories: data.categories } : {}),
		...(data.search ? { search: data.search } : {}),
		...(data.failedOnly !== undefined ? { failedOnly: data.failedOnly } : {}),
		...(data.failFast !== undefined ? { failFast: data.failFast } : {}),
		...(data.repeatOverride !== undefined ? { repeatOverride: data.repeatOverride } : {}),
	};
	const started = Date.now();
	const runId = `test-run-${started}`;
	const controller = new AbortController();
	const active: IActiveTestingRun = {
		id: runId,
		controller,
		startedAt: new Date(started).toISOString(),
		target: "local",
		progress: { completed: 0, total: 0, currentSuiteId: null, currentTestId: null, status: "preparing" },
	};
	activeRuns.set(scene, active);
	const reports: IPortableTestRunReport[] = [];
	let startedPlay = false;
	try {
		const previousRun = state.runs[0] ?? null;
		if (data.target === "connected-player") {
			if (typeof data.connectionId !== "string" || !data.connectionId) {
				throw new Error("connectionId is required for connected-player testing.");
			}
			if (data.confirm !== true) {
				throw new Error("Running tests on a connected player requires confirm=true.");
			}
			if (request.modes?.some((mode) => mode !== "play")) {
				throw new Error("Connected players run Play suites only.");
			}
			const runToken = `remote-${started}-${Math.random().toString(36).slice(2, 10)}`;
			active.target = "connected-player";
			active.cancelRemote = async (): Promise<void> => {
				await cancelRemoteDeviceTests(scene, { connectionId: data.connectionId, runToken, timeoutMs: 5_000 }).then(() => undefined);
			};
			const remoteState = subset(state, "play");
			remoteState.runs = [];
			const report = (await runRemoteDeviceTests(scene, {
				connectionId: data.connectionId,
				runToken,
				state: remoteState,
				request: { ...request, modes: ["play"] },
				sequence: (state.runs[0]?.sequence ?? 0) + 1,
				timeoutMs: data.timeoutMs ?? state.settings.playPreparationTimeoutMs,
				confirm: true,
			})) as IPortableTestRunReport;
			report.id = runId;
			persistTestingState(scene, retainPortableTestRun(testingState(scene), report));
			active.progress.status = report.status;
			options.editor.layout.inspector.forceUpdate();
			return report;
		}
		const onProgress = (progress: any): void => {
			active.progress = {
				completed: progress.completed,
				total: progress.total,
				currentSuiteId: progress.currentSuiteId,
				currentTestId: progress.currentTestId,
				status: progress.status,
			};
			options.editor.layout.inspector.forceUpdate();
		};
		if ((!request.modes || request.modes.includes("edit")) && hasRunnableCase(state, "edit", request)) {
			reports.push(
				await runPortableTestSuites(
					portableScene(scene),
					subset(state, "edit"),
					{ ...request, modes: ["edit"] },
					{
						target: "editor-edit",
						sequence: (state.runs[0]?.sequence ?? 0) + 1,
						previousRun,
						signal: controller.signal,
						supportedModes: ["edit"],
						waitFrames,
						waitMilliseconds,
						dispatchPointer: (_target, step) => dispatchPointer(options, step),
						measureMetrics: getSceneDiagnostics,
						runVisual,
						onProgress,
					}
				)
			);
		}
		if ((!request.modes || request.modes.includes("play")) && hasRunnableCase(state, "play", request) && !controller.signal.aborted) {
			const play = options.editor.layout.preview.play;
			if (!play.state.playing) {
				startedPlay = true;
				await play.play();
			}
			const playScene = await waitForPlayScene(options, state.settings.playPreparationTimeoutMs, controller.signal);
			reports.push(
				await runPortableTestSuites(
					portableScene(playScene),
					subset(state, "play"),
					{ ...request, modes: ["play"] },
					{
						target: "editor-play",
						sequence: (state.runs[0]?.sequence ?? 0) + 1,
						previousRun,
						signal: controller.signal,
						supportedModes: ["play"],
						waitFrames,
						waitMilliseconds,
						dispatchPointer: (_target, step) => dispatchPointer(options, step),
						measureMetrics: getSceneDiagnostics,
						runVisual,
						onProgress,
					}
				)
			);
		}
		const report = mergeReports(runId, started, reports, request);
		persistTestingState(scene, retainPortableTestRun(testingState(scene), report));
		active.progress.status = report.status;
		options.editor.layout.inspector.forceUpdate();
		return report;
	} finally {
		if (startedPlay) {
			options.editor.layout.preview.play.stop();
		}
		activeRuns.delete(scene);
	}
}

export function getTestingRunStatus(scene: Scene): any {
	const state = testingState(scene);
	const active = activeRuns.get(scene);
	return {
		active: active ? { id: active.id, startedAt: active.startedAt, target: active.target, progress: structuredClone(active.progress) } : null,
		latest: state.runs[0] ? structuredClone(state.runs[0]) : null,
	};
}

export async function cancelTestingRun(scene: Scene, data: any): Promise<any> {
	const active = activeRuns.get(scene);
	if (!active) {
		return { canceled: false, reason: "no-active-run" };
	}
	if (data.confirm !== true) {
		throw new Error("Canceling an active test run requires confirm=true.");
	}
	if (data.runId && data.runId !== active.id) {
		throw new Error(`Active test run is "${active.id}", not "${data.runId}".`);
	}
	active.controller.abort("Canceled by user.");
	await active.cancelRemote?.().catch(() => undefined);
	return { canceled: true, runId: active.id };
}

export function listTestingRuns(scene: Scene, data: any): any {
	const state = testingState(scene);
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 20;
	return { revision: state.revision, total: state.runs.length, offset, limit, runs: structuredClone(state.runs.slice(offset, offset + limit)) };
}

export function getTestingRun(scene: Scene, data: any): IPortableTestRunReport {
	const report = testingState(scene).runs.find((candidate) => candidate.id === data.runId);
	if (!report) {
		throw new Error("Test run report not found.");
	}
	return structuredClone(report);
}

export async function exportTestingRunReport(scene: Scene, data: any): Promise<any> {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	const report = getTestingRun(scene, data);
	const format = data.format ?? "json";
	const extension = format === "junit" ? "xml" : "json";
	const path = data.path ?? `.bjseditor/test-results/${safeSegment(report.id)}.${extension}`;
	if (!path.toLowerCase().endsWith(`.${extension}`)) {
		throw new Error(`A ${format} report path must end in .${extension}.`);
	}
	const absolute = projectTestingPath(path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, format === "junit" ? portableTestRunToJUnit(report) : `${JSON.stringify(report, null, "\t")}\n`, "utf8");
	return { exported: true, runId: report.id, format, path: relative(dirname(projectConfiguration.path), absolute) };
}

/** Aborts transient test work when the editor MCP listener is disposed or reloaded. */
export function shutdownTesting(scene: Scene): void {
	const active = activeRuns.get(scene);
	active?.controller.abort("Editor testing service shut down.");
	void active?.cancelRemote?.().catch(() => undefined);
	activeRuns.delete(scene);
}
