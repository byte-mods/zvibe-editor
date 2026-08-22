import { afterEach, describe, expect, test, vi } from "vitest";

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
				diagnostics: {
					onStartCalls: 1,
					onUpdateCalls: 12,
					onStopCalls: 0,
					manualOnStartCalls: 0,
					manualOnUpdateCalls: 3,
					lastManualDeltaSeconds: 0.02,
					errorCount: 1,
					lastError: { lifecycle: "onUpdate", message: "Boom", timestamp: 10 },
				},
			},
		]);

		const result = getScriptRuntimeDiagnostics(scene, { nodeId: mesh.id });
		expect(result.target).toBe("editor");
		expect(result.node.id).toBe(mesh.id);
		expect(result.scripts).toEqual([
			expect.objectContaining({
				path: "src/behavior.ts",
				diagnostics: expect.objectContaining({ onUpdateCalls: 12, errorCount: 1, lastError: expect.objectContaining({ message: "Boom" }) }),
			}),
		]);
	});

	test("resolves the corresponding runtime node while preview play mode is active", () => {
		const playEngine = new NullEngine();
		const playScene = new Scene(playEngine);
		const runtimeMesh = new Mesh("TelemetryNode", playScene);
		runtimeMesh.id = mesh.id;
		scriptsDictionary.set(runtimeMesh as any, [
			{
				key: "behavior.ts",
				instance: {} as any,
				observers: {},
				diagnostics: {
					onStartCalls: 1,
					onUpdateCalls: 3,
					onStopCalls: 0,
					manualOnStartCalls: 1,
					manualOnUpdateCalls: 3,
					lastManualDeltaSeconds: 0.02,
					errorCount: 0,
					lastError: null,
				},
			},
		]);

		const getScriptRuntimeRegistrations = vi.fn((node: Mesh) => scriptsDictionary.get(node as any) ?? []);
		const result = getScriptRuntimeDiagnostics(scene, { nodeId: mesh.id }, {
			editor: { layout: { preview: { play: { canPlayScene: true, scene: playScene, getScriptRuntimeRegistrations } } } },
		} as any);
		expect(result).toMatchObject({
			target: "play",
			node: { id: mesh.id },
			scripts: [{ key: "behavior.ts", diagnostics: { manualOnUpdateCalls: 3, lastManualDeltaSeconds: 0.02 } }],
		});
		expect(getScriptRuntimeRegistrations).toHaveBeenCalledWith(runtimeMesh);
		playScene.dispose();
		playEngine.dispose();
	});
});
