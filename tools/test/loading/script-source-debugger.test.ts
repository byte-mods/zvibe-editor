import { afterEach, describe, expect, test } from "vitest";

import { NullEngine, Scene } from "@babylonjs/core";

import { _removeRegisteredScriptInstance, applyScriptOnObject, scriptsDictionary, setScriptSimulationPaused, stepPausedScriptSimulation } from "../../src/loading/script/apply";
import {
	_zvibeEditorScriptProbeV1,
	clearScriptSourceDebuggerTrace,
	configureScriptSourceDebugger,
	getScriptSourceCoverage,
	getScriptSourceDebuggerSnapshot,
	setScriptSourceBreakpoints,
	setScriptSourceCoverage,
} from "../../src/loading/script/source-debugger";

const manifest = {
	version: 1 as const,
	fingerprint: "a".repeat(64),
	points: [
		{ id: "function:8:2:0", path: "src/player.ts", line: 8, column: 2, kind: "function" as const, functionName: "Player.onUpdate" },
		{ id: "statement:10:3:1", path: "src/player.ts", line: 10, column: 3, kind: "statement" as const, functionName: "Player.onUpdate" },
		{ id: "branch:11:4:2", path: "src/player.ts", line: 11, column: 4, kind: "branch" as const, functionName: "Player.onUpdate" },
		{ id: "statement:4:2:0", path: "src/idle.ts", line: 4, column: 2, kind: "statement" as const, functionName: "Idle.onUpdate" },
	],
};

describe("loading/script-source-debugger", () => {
	afterEach(() => {
		for (const [object, scripts] of scriptsDictionary) {
			scripts.slice().forEach((script) => _removeRegisteredScriptInstance(object, script));
			scriptsDictionary.delete(object);
		}
	});

	test("resolves breakpoints, pauses safe script delivery, snapshots fields, and records source coverage", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		configureScriptSourceDebugger(scene, manifest, () => setScriptSimulationPaused(scene, true));
		setScriptSourceBreakpoints(scene, [{ id: "player-line", path: "src/player.ts", line: 9, hitCondition: 1 }]);
		setScriptSourceCoverage(scene, true, true);

		const target = { id: "player-node", name: "Player", getScene: () => scene };
		let getterCalls = 0;
		applyScriptOnObject(
			target,
			class Player {
				public speed = 4;
				public circular: any = this;
				public get dangerous(): string {
					getterCalls++;
					return "must not run";
				}

				public onUpdate(): void {
					_zvibeEditorScriptProbeV1("src/player.ts", "function:8:2:0", 8, 2, "function", "Player.onUpdate");
					_zvibeEditorScriptProbeV1("src/player.ts", "statement:10:3:1", 10, 3, "statement", "Player.onUpdate");
					_zvibeEditorScriptProbeV1("src/player.ts", "branch:11:4:2", 11, 4, "branch", "Player.onUpdate");
				}
			}
		);

		scene.onBeforeRenderObservable.notifyObservers(scene);
		const snapshot = getScriptSourceDebuggerSnapshot(scene);
		expect(snapshot.breakpoints).toEqual([expect.objectContaining({ id: "player-line", line: 9, resolvedLine: 10, resolvedPointId: "statement:10:3:1", hits: 1 })]);
		expect(snapshot.currentHit).toMatchObject({
			breakpointId: "player-line",
			scriptKey: "runtime",
			lifecycle: "onUpdate",
			object: { id: "player-node", name: "Player" },
			fields: { speed: 4, circular: "[Circular]" },
		});
		expect(snapshot.trace).toHaveLength(1);
		expect(getterCalls).toBe(0);
		const coverage = getScriptSourceCoverage(scene, { path: "src/player.ts", limit: 10 });
		expect(coverage.summary).toMatchObject({
			lines: { total: 3, covered: 3, percent: 100 },
			statements: { total: 1, covered: 1, percent: 100 },
			functions: { total: 1, covered: 1, percent: 100 },
			branches: { total: 1, covered: 1, percent: 100 },
		});
		expect(coverage.points.map((point) => point.hits)).toEqual([1, 1, 1]);

		const stepped = stepPausedScriptSimulation(scene, 1 / 60);
		expect(stepped.breakpointHit).toBe(true);
		expect(stepped.updateCalls).toBe(1);
		expect(getScriptSourceDebuggerSnapshot(scene).hitSequence).toBe(2);
		expect(clearScriptSourceDebuggerTrace(scene)).toMatchObject({ currentHit: null, traceCount: 0, droppedTraceCount: 0 });

		scene.dispose();
		engine.dispose();
	});

	test("rejects malformed manifests and breakpoints without mutating a valid runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(() => configureScriptSourceDebugger(scene, { ...manifest, fingerprint: "bad" })).toThrow("SHA-256");
		configureScriptSourceDebugger(scene, manifest);
		expect(() => setScriptSourceBreakpoints(scene, [{ path: "../outside.ts", line: 1 }])).toThrow("under src");
		expect(() => setScriptSourceBreakpoints(scene, [{ path: "src/player.ts", line: 0 }])).toThrow("positive integer");
		expect(() => setScriptSourceBreakpoints(scene, [{ path: "src/player.ts", line: 1, enabled: "yes" as any }])).toThrow("enabled must be a boolean");
		expect(getScriptSourceDebuggerSnapshot(scene).breakpoints).toEqual([]);
		scene.dispose();
		engine.dispose();
	});
});
