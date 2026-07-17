import { afterEach, describe, expect, test } from "vitest";

import { Mesh, NullEngine, Scene } from "babylonjs";
import { scriptsDictionary } from "babylonjs-editor-tools";

import { getScriptRuntimeDiagnostics } from "../../src/mcp/scripts/scripts";

describe("mcp/script-runtime-diagnostics", () => {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	const mesh = new Mesh("TelemetryNode", scene);

	afterEach(() => {
		scriptsDictionary.clear();
	});

	test("returns live lifecycle telemetry for a resolved node", () => {
		scriptsDictionary.set(mesh as any, [
			{
				key: "behavior.ts",
				instance: {} as any,
				observers: {},
				diagnostics: { onStartCalls: 1, onUpdateCalls: 12, onStopCalls: 0, errorCount: 1, lastError: { lifecycle: "onUpdate", message: "Boom", timestamp: 10 } },
			},
		]);

		const result = getScriptRuntimeDiagnostics(scene, { nodeId: mesh.id });
		expect(result.node.id).toBe(mesh.id);
		expect(result.scripts).toEqual([
			expect.objectContaining({
				path: "src/behavior.ts",
				diagnostics: expect.objectContaining({ onUpdateCalls: 12, errorCount: 1, lastError: expect.objectContaining({ message: "Boom" }) }),
			}),
		]);
	});
});
