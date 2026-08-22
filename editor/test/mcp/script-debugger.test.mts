import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, pathExists, readFile, remove, writeFile } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { NullEngine, Scene } from "babylonjs";
import {
	_removeRegisteredScriptInstance,
	_zvibeEditorScriptProbeV1,
	applyScriptOnObject,
	clearScriptSourceDebuggerTrace,
	configureScriptSourceDebugger,
	getScriptSimulationControl,
	getScriptSourceCoverage,
	getScriptSourceDebuggerSnapshot,
	scriptsDictionary,
	setScriptSimulationPaused,
	setScriptSourceBreakpoints,
	setScriptSourceCoverage,
	stepPausedScriptSimulation,
} from "babylonjs-editor-tools";

import { projectConfiguration } from "../../src/project/configuration";
import {
	configureScriptSourceCoverage,
	controlScriptDebugger,
	exportScriptSourceCoverage,
	getScriptDebugger,
	getScriptDebuggerCapabilities,
	getScriptSourceCoverageReport,
	prepareScriptDebugger,
	setScriptDebuggerBreakpoints,
} from "../../src/mcp/scripts/debugger";

const manifest = {
	version: 1 as const,
	fingerprint: "b".repeat(64),
	points: [{ id: "statement:4:3:0", path: "src/player.ts", line: 4, column: 3, kind: "statement" as const, functionName: "Player.onUpdate" }],
};

describe("mcp/script-debugger", () => {
	let engine: NullEngine;
	let scene: Scene;
	let directory: string;
	let previousProjectPath: string | null;
	let play: any;
	let options: any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		directory = await mkdtemp(join(tmpdir(), "zvibe-script-debugger-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}\n");
		configureScriptSourceDebugger(scene, manifest, () => setScriptSimulationPaused(scene, true));
		play = {
			scene,
			state: { playing: true, preparingPlay: false, loading: false },
			canPlayScene: true,
			scriptSourceDebuggingEnabled: true,
			setScriptSourceDebuggingEnabled: vi.fn(async (enabled: boolean) => {
				play.scriptSourceDebuggingEnabled = enabled;
				return enabled ? getScriptSourceDebuggerSnapshot(scene) : null;
			}),
			getScriptSourceDebuggerSnapshot: (offset?: number, limit?: number) => getScriptSourceDebuggerSnapshot(scene, offset, limit),
			setScriptSourceBreakpoints: (breakpoints: any[]) => setScriptSourceBreakpoints(scene, breakpoints),
			setScriptSourceCoverage: (enabled: boolean, clear?: boolean) => setScriptSourceCoverage(scene, enabled, clear),
			clearScriptSourceDebuggerTrace: () => clearScriptSourceDebuggerTrace(scene),
			getScriptSourceCoverage: (query: any) => getScriptSourceCoverage(scene, query),
			getScriptSimulationControl: () => getScriptSimulationControl(scene),
			setScriptSimulationPaused: (paused: boolean) => setScriptSimulationPaused(scene, paused),
			stepPausedScriptSimulation: (deltaSeconds: number) => stepPausedScriptSimulation(scene, deltaSeconds),
		};
		options = { editor: { layout: { preview: { play }, selectTab: vi.fn() } } };
	});

	afterEach(async () => {
		for (const [object, scripts] of scriptsDictionary) {
			scripts.slice().forEach((script) => _removeRegisteredScriptInstance(object, script));
			scriptsDictionary.delete(object);
		}
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("publishes honest capabilities and prepares the visible debugger workspace", async () => {
		expect(getScriptDebuggerCapabilities(scene, {}, options)).toMatchObject({
			backend: "instrumented-debug-play-safe-boundary-v1",
			breakpoints: { maximum: 64, resolution: "next-executable-point-in-file" },
			variables: { expressionEvaluation: false, invokesGetters: false },
		});
		expect(await prepareScriptDebugger(scene, { enabled: true }, options)).toMatchObject({ debugger: { manifestFingerprint: manifest.fingerprint } });
		expect(play.setScriptSourceDebuggingEnabled).toHaveBeenCalledWith(true);
		expect(options.editor.layout.selectTab).toHaveBeenCalledWith("script-debugger");
	});

	test("stale-guards breakpoints/coverage, captures a hit, controls pause, and exports exact JSON plus LCOV", async () => {
		let state = getScriptDebugger(scene, {}, options);
		await expect(() =>
			setScriptDebuggerBreakpoints(
				scene,
				{
					expectedManifestFingerprint: "0".repeat(64),
					expectedConfigurationRevision: state.debugger.configurationRevision,
					breakpoints: [],
				},
				options
			)
		).toThrow("manifest changed");
		state = setScriptDebuggerBreakpoints(
			scene,
			{
				expectedManifestFingerprint: state.debugger.manifestFingerprint,
				expectedConfigurationRevision: state.debugger.configurationRevision,
				breakpoints: [{ id: "player", path: "src/player.ts", line: 4 }],
			},
			options
		);
		state = configureScriptSourceCoverage(
			scene,
			{
				expectedManifestFingerprint: state.debugger.manifestFingerprint,
				expectedConfigurationRevision: state.debugger.configurationRevision,
				enabled: true,
				clear: true,
			},
			options
		);

		const target = { id: "player", name: "Player", getScene: () => scene };
		applyScriptOnObject(
			target,
			class Player {
				public health = 3;
				public onUpdate(): void {
					_zvibeEditorScriptProbeV1("src/player.ts", "statement:4:3:0", 4, 3, "statement", "Player.onUpdate");
				}
			}
		);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		state = getScriptDebugger(scene, {}, options);
		expect(state).toMatchObject({ simulation: { paused: true }, debugger: { currentHit: { breakpointId: "player", fields: { health: 3 } } } });
		expect(getScriptSourceCoverageReport(scene, { limit: 10 }, options)).toMatchObject({ summary: { statements: { total: 1, covered: 1, percent: 100 } } });

		state = controlScriptDebugger(
			scene,
			{
				expectedManifestFingerprint: state.debugger.manifestFingerprint,
				expectedConfigurationRevision: state.debugger.configurationRevision,
				expectedPaused: true,
				action: "resume",
			},
			options
		);
		expect(state.simulation.paused).toBe(false);
		const snapshot = state.debugger;
		const coverage = getScriptSourceCoverageReport(scene, { limit: 10 }, options);
		const json = await exportScriptSourceCoverage(
			scene,
			{
				expectedManifestFingerprint: snapshot.manifestFingerprint,
				expectedConfigurationRevision: snapshot.configurationRevision,
				expectedCoverageRevision: coverage.coverageRevision,
				format: "json",
				path: ".bjseditor/script-coverage/report.json",
			},
			options
		);
		const lcov = await exportScriptSourceCoverage(
			scene,
			{
				expectedManifestFingerprint: snapshot.manifestFingerprint,
				expectedConfigurationRevision: snapshot.configurationRevision,
				expectedCoverageRevision: coverage.coverageRevision,
				format: "lcov",
				path: ".bjseditor/script-coverage/report.lcov",
			},
			options
		);
		expect(json).toMatchObject({ format: "json", coverageRevision: coverage.coverageRevision, summary: coverage.summary });
		expect(lcov).toMatchObject({ format: "lcov", coverageRevision: coverage.coverageRevision });
		expect(await pathExists(join(directory, json.path))).toBe(true);
		expect(JSON.parse(await readFile(join(directory, json.path), "utf8"))).toMatchObject({ version: 1, coverage: { manifestFingerprint: manifest.fingerprint } });
		expect(await readFile(join(directory, lcov.path), "utf8")).toContain("BRF:0\nBRH:0\nend_of_record");
	});
});
