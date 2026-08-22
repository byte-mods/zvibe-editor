import { createHash, randomUUID } from "crypto";
import { realpath } from "fs/promises";
import { dirname, extname, isAbsolute, join, relative } from "path/posix";

import { ensureDir, lstat, move, pathExists, remove, writeFile } from "fs-extra";

import { Scene } from "babylonjs";

import type { IScriptSourceCoverageSnapshot, IScriptSourceDebuggerSnapshot } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../project/configuration";
import { IMCPActionOptions } from "../action";

function playBridge(options: IMCPActionOptions): any {
	const play = options.editor.layout.preview?.play;
	if (!play) {
		throw new Error("The editor Play bridge is unavailable.");
	}
	return play;
}

function inspectExactDebugger(data: any, options: IMCPActionOptions): { play: any; snapshot: IScriptSourceDebuggerSnapshot } {
	const play = playBridge(options);
	const snapshot = play.getScriptSourceDebuggerSnapshot(data.traceOffset ?? 0, data.traceLimit ?? 100) as IScriptSourceDebuggerSnapshot;
	if (data.expectedManifestFingerprint !== undefined && data.expectedManifestFingerprint !== snapshot.manifestFingerprint) {
		throw new Error("The Debug Play source manifest changed. Inspect the script debugger again before mutating it.");
	}
	if (data.expectedConfigurationRevision !== undefined && data.expectedConfigurationRevision !== snapshot.configurationRevision) {
		throw new Error("The script debugger configuration changed. Inspect it again before mutating it.");
	}
	return { play, snapshot };
}

function debuggerState(options: IMCPActionOptions, traceOffset = 0, traceLimit = 100): any {
	const play = playBridge(options);
	const snapshot = play.getScriptSourceDebuggerSnapshot(traceOffset, traceLimit);
	return { debugger: snapshot, simulation: play.getScriptSimulationControl(), play: { playing: play.state.playing, ready: play.canPlayScene } };
}

/** Describes the source-debugging contract without starting or recompiling Play. */
export function getScriptDebuggerCapabilities(_scene: Scene, _data: any, options: IMCPActionOptions): any {
	const play = playBridge(options);
	return {
		backend: "instrumented-debug-play-safe-boundary-v1",
		debuggingEnabled: play.scriptSourceDebuggingEnabled,
		play: { playing: play.state.playing, preparing: play.state.preparingPlay, loading: play.state.loading, ready: play.canPlayScene },
		breakpoints: { maximum: 64, resolution: "next-executable-point-in-file", hitCondition: "pause-from-nth-hit", persisted: "editor-session" },
		coverage: { kinds: ["lines", "statements", "functions", "branches"], maximumPoints: 100_000, exportFormats: ["json", "lcov"] },
		variables: { source: "own-enumerable-data-fields", expressionEvaluation: false, invokesGetters: false, maximumFields: 32, maximumDepth: 2 },
		pauseSemantics: "The synchronous JavaScript callback that reaches a probe completes; subsequent attached-script lifecycle delivery remains paused.",
		limitations: [
			"No JavaScript VM mid-statement suspension.",
			"No arbitrary expression evaluation.",
			"Asynchronous callbacks outside attached-script lifecycle may have no script/object context.",
		],
	};
}

/** Enables or disables source instrumentation and rebuilds/restarts Play when required. */
export async function prepareScriptDebugger(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const play = playBridge(options);
	await play.setScriptSourceDebuggingEnabled(data.enabled);
	options.editor.layout.selectTab("script-debugger");
	return data.enabled ? debuggerState(options) : { debuggingEnabled: false, play: { playing: play.state.playing, ready: play.canPlayScene } };
}

/** Reads bounded breakpoints, current hit, retained trace, and attached-script pause state. */
export function getScriptDebugger(_scene: Scene, data: any, options: IMCPActionOptions): any {
	return debuggerState(options, data.traceOffset ?? 0, data.traceLimit ?? 100);
}

/** Replaces all runtime breakpoints under an exact manifest/configuration lease. */
export function setScriptDebuggerBreakpoints(_scene: Scene, data: any, options: IMCPActionOptions): any {
	const { play } = inspectExactDebugger(data, options);
	play.setScriptSourceBreakpoints(data.breakpoints);
	return debuggerState(options, 0, data.traceLimit ?? 100);
}

/** Pauses, resumes, steps, or clears trace evidence under exact expected state. */
export function controlScriptDebugger(_scene: Scene, data: any, options: IMCPActionOptions): any {
	const { play } = inspectExactDebugger(data, options);
	const simulation = play.getScriptSimulationControl();
	if (simulation.paused !== data.expectedPaused) {
		throw new Error("Attached-script pause state changed. Inspect the script debugger again before controlling it.");
	}
	let step: any = null;
	if (data.action === "pause") {
		play.setScriptSimulationPaused(true);
	} else if (data.action === "resume") {
		play.setScriptSimulationPaused(false);
	} else if (data.action === "step") {
		step = play.stepPausedScriptSimulation(data.deltaSeconds ?? 1 / 60);
	} else {
		play.clearScriptSourceDebuggerTrace();
	}
	return { ...debuggerState(options), step };
}

/** Reads bounded source coverage from the exact instrumented Play scene. */
export function getScriptSourceCoverageReport(_scene: Scene, data: any, options: IMCPActionOptions): any {
	const play = playBridge(options);
	return play.getScriptSourceCoverage({ path: data.path, offset: data.offset ?? 0, limit: data.limit ?? 500 });
}

/** Enables/disables or clears source coverage under an exact debugger lease. */
export function configureScriptSourceCoverage(_scene: Scene, data: any, options: IMCPActionOptions): any {
	const { play } = inspectExactDebugger(data, options);
	play.setScriptSourceCoverage(data.enabled, data.clear ?? false);
	return debuggerState(options);
}

function lcovReport(coverage: IScriptSourceCoverageSnapshot): string {
	const byPath = new Map<string, typeof coverage.points>();
	for (const point of coverage.points) {
		const entries = byPath.get(point.path) ?? [];
		entries.push(point);
		byPath.set(point.path, entries);
	}
	const lines: string[] = [];
	for (const [path, points] of [...byPath.entries()].sort(([left], [right]) => left.localeCompare(right))) {
		lines.push(`SF:${path}`);
		const functions = points.filter((point) => point.kind === "function");
		functions.forEach((point, index) => lines.push(`FN:${point.line},${(point.functionName ?? `anonymous-${index + 1}`).replace(/[\r\n,]/g, "_")}`));
		functions.forEach((point, index) => lines.push(`FNDA:${point.hits},${(point.functionName ?? `anonymous-${index + 1}`).replace(/[\r\n,]/g, "_")}`));
		lines.push(`FNF:${functions.length}`, `FNH:${functions.filter((point) => point.hits > 0).length}`);
		const lineHits = new Map<number, number>();
		points.forEach((point) => lineHits.set(point.line, Math.max(lineHits.get(point.line) ?? 0, point.hits)));
		for (const [line, hits] of [...lineHits.entries()].sort(([left], [right]) => left - right)) {
			lines.push(`DA:${line},${hits}`);
		}
		lines.push(`LF:${lineHits.size}`, `LH:${[...lineHits.values()].filter((hits) => hits > 0).length}`);
		const branches = points.filter((point) => point.kind === "branch");
		branches.forEach((point, index) => lines.push(`BRDA:${point.line},0,${index},${point.hits || "-"}`));
		lines.push(`BRF:${branches.length}`, `BRH:${branches.filter((point) => point.hits > 0).length}`, "end_of_record");
	}
	return `${lines.join("\n")}\n`;
}

async function resolveCoverageOutput(path: string, format: "json" | "lcov"): Promise<string> {
	if (!projectConfiguration.path) {
		throw new Error("No project is currently open.");
	}
	if (typeof path !== "string" || !path.trim() || isAbsolute(path)) {
		throw new Error("Coverage output path must be project-relative.");
	}
	const projectRoot = dirname(projectConfiguration.path);
	const directory = join(projectRoot, ".bjseditor/script-coverage");
	const output = join(projectRoot, path);
	const relativeOutput = relative(directory, output);
	if (!relativeOutput || relativeOutput.startsWith("../") || isAbsolute(relativeOutput)) {
		throw new Error('Coverage reports must be written below ".bjseditor/script-coverage/".');
	}
	const expectedExtension = format === "json" ? ".json" : ".lcov";
	if (extname(output).toLowerCase() !== expectedExtension) {
		throw new Error(`${format} coverage reports must use the ${expectedExtension} extension.`);
	}
	await ensureDir(dirname(output));
	const canonicalProject = (await realpath(projectRoot)).replace(/\\/g, "/");
	const canonicalParent = (await realpath(dirname(output))).replace(/\\/g, "/");
	if (!canonicalParent.startsWith(`${canonicalProject}/.bjseditor/script-coverage/`) && canonicalParent !== `${canonicalProject}/.bjseditor/script-coverage`) {
		throw new Error("Coverage output parent resolves outside project report storage.");
	}
	if (await pathExists(output)) {
		const stats = await lstat(output);
		if (stats.isSymbolicLink() || !stats.isFile()) {
			throw new Error("Coverage output must be a regular file, not a symlink.");
		}
	}
	return output;
}

/** Exports exact source coverage as deterministic JSON or LCOV under project report storage. */
export async function exportScriptSourceCoverage(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { play, snapshot } = inspectExactDebugger(data, options);
	if (snapshot.coverageRevision !== data.expectedCoverageRevision) {
		throw new Error("Source coverage changed. Inspect coverage again before exporting it.");
	}
	const coverage = play.getScriptSourceCoverage({ limit: 100_000 }) as IScriptSourceCoverageSnapshot;
	const output = await resolveCoverageOutput(data.path, data.format);
	const content =
		data.format === "json" ? `${JSON.stringify({ version: 1, backend: "instrumented-debug-play-safe-boundary-v1", coverage }, null, "\t")}\n` : lcovReport(coverage);
	const temporary = join(dirname(output), `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, content, "utf8");
		await move(temporary, output, { overwrite: true });
	} finally {
		if (await pathExists(temporary)) {
			await remove(temporary);
		}
	}
	return {
		path: relative(dirname(projectConfiguration.path!), output),
		format: data.format,
		bytes: Buffer.byteLength(content, "utf8"),
		sha256: createHash("sha256").update(content).digest("hex"),
		manifestFingerprint: coverage.manifestFingerprint,
		coverageRevision: coverage.coverageRevision,
		summary: coverage.summary,
	};
}
