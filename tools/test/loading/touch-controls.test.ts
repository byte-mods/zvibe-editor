import { describe, expect, test } from "vitest";
import { NullEngine, Scene } from "babylonjs";

import { InputActionValue } from "../../src/loading/input-actions";
import { normalizeTouchControlsConfiguration } from "../../src/loading/touch-controls-model";
import { configureTouchControls, ITouchControlInputSink, TouchControlInputController } from "../../src/loading/touch-controls";

class Sink implements ITouchControlInputSink {
	public readonly values = new Map<string, InputActionValue>();
	public readonly cleared: string[] = [];

	public simulateControl(path: string, value: InputActionValue): boolean {
		this.values.set(path, value);
		return true;
	}

	public clearSimulatedControl(path: string): boolean {
		this.cleared.push(path);
		return this.values.delete(path);
	}
}

function controller(): { controller: TouchControlInputController; sink: Sink } {
	const sink = new Sink();
	const configuration = normalizeTouchControlsConfiguration({
		enabled: true,
		controls: [
			{ id: "move", name: "Move", type: "stick", controlPath: "<touch>/move", rect: { x: 0.05, y: 0.65, width: 0.25, height: 0.25 } },
			{ id: "jump", name: "Jump", type: "button", controlPath: "<touch>/jump", rect: { x: 0.8, y: 0.7, width: 0.15, height: 0.2 } },
		],
	});
	return { controller: new TouchControlInputController(configuration, sink), sink };
}

describe("touch controls runtime", () => {
	test("maps independent button and stick pointers into existing Input Actions paths", () => {
		const { controller: runtime, sink } = controller();
		expect(runtime.begin("move", 1, 1, 0.5)).toBe(true);
		expect(runtime.begin("jump", 2, 0.5, 0.5)).toBe(true);
		expect(sink.values.get("<touch>/move")).toEqual([1, 0]);
		expect(sink.values.get("<touch>/jump")).toBe(1);
		expect(runtime.status()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "move", active: true, pointerId: 1 })]));
	});

	test("applies radial deadzone, clamps range, and preserves upward-positive axes", () => {
		const { controller: runtime, sink } = controller();
		runtime.begin("move", 7, 0.5, 0.5);
		expect(sink.values.get("<touch>/move")).toEqual([0, 0]);
		runtime.move("move", 7, 2, -2);
		const value = sink.values.get("<touch>/move") as [number, number];
		expect(Math.hypot(...value)).toBeCloseTo(1, 5);
		expect(value[0]).toBeGreaterThan(0);
		expect(value[1]).toBeGreaterThan(0);
	});

	test("rejects pointer theft and clears every simulated path on release or disposal", () => {
		const { controller: runtime, sink } = controller();
		expect(runtime.begin("move", 1, 1, 0.5)).toBe(true);
		expect(runtime.begin("move", 2, 0, 0.5)).toBe(false);
		expect(runtime.begin("jump", 1, 0.5, 0.5)).toBe(false);
		expect(runtime.end("move", 2)).toBe(false);
		expect(runtime.end("move", 1)).toBe(true);
		expect(runtime.begin("jump", 3, 0.5, 0.5)).toBe(true);
		expect(runtime.cancelAll()).toBe(1);
		expect(sink.values.size).toBe(0);
		expect(sink.cleared).toEqual(["<touch>/move", "<touch>/jump"]);
	});

	test("leaves headless scenes unchanged when a DOM canvas is unavailable", () => {
		const scene = new Scene(new NullEngine());
		scene.metadata = { babylonEditorTouchControls: { enabled: true, controls: [] } };
		expect(configureTouchControls(scene as any)).toBeUndefined();
		expect((scene as any).touchControls).toBeUndefined();
		scene.dispose();
	});
});
