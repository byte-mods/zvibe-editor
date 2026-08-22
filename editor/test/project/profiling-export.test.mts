import { describe, expect, test } from "vitest";
import { NullEngine, Scene, SceneSerializer } from "babylonjs";

import { stripConsoleServerStateFromRuntimeSceneData, stripProfilerStateFromRuntimeSceneData } from "../../src/project/export/export";

describe("project/export profiling metadata", () => {
	test("removes retained editor evidence while preserving authored runtime metadata", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.metadata = {
			runtimeAuthored: { mode: "campaign" },
			babylonEditorProfilerState: { version: 1, captures: [{ id: "private-profile", markers: [{ scriptKey: "src/private.ts" }] }] },
		};
		try {
			const data = await SceneSerializer.SerializeAsync(scene);
			expect(data.metadata.babylonEditorProfilerState).toBeDefined();
			stripProfilerStateFromRuntimeSceneData(data);
			expect(data.metadata).toMatchObject({ runtimeAuthored: { mode: "campaign" } });
			expect(data.metadata).not.toHaveProperty("babylonEditorProfilerState");
			expect(scene.metadata.babylonEditorProfilerState).toBeDefined();
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});

	test("strips editor-only Console & Server deployment state from runtime data", () => {
		const data: any = { metadata: { keep: true, babylonEditorConsoleServer: { revision: 4, deployment: { provider: "console" } } } };
		stripConsoleServerStateFromRuntimeSceneData(data);
		expect(data.metadata).toEqual({ keep: true });
	});
});
