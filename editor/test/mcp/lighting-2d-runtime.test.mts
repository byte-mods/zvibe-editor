import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";
import { configureLighting2D } from "babylonjs-editor-tools";

import { getLighting2DRuntime, listLighting2DProviderTypes } from "../../src/mcp/lights/lighting-2d";

describe("mcp/lighting-2d-runtime", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		configureLighting2D(scene as any);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("paginates the Edit registry and reports measured runtime evidence", () => {
		const options = { editor: { layout: { preview: { play: null } } } } as any;
		const first = listLighting2DProviderTypes(scene, { target: "edit", kind: "all", limit: 2 }, options) as any;
		expect(first).toMatchObject({ target: "edit", registryScope: "editor-tools-module", total: 6, nextCursor: "2" });
		expect(first.providers).toHaveLength(2);
		const second = listLighting2DProviderTypes(scene, { target: "edit", kind: "all", cursor: first.nextCursor, limit: 100 }, options) as any;
		expect(second.providers).toHaveLength(4);
		expect(new Set([...first.providers, ...second.providers].map((provider: any) => provider.kind))).toEqual(new Set(["light", "shadow"]));
		expect(getLighting2DRuntime(scene, { target: "edit" }, options)).toMatchObject({ target: "edit", registryScope: "editor-tools-module", configured: true, frameCount: 1 });
		expect(() => getLighting2DRuntime(scene, { target: "play" }, options)).toThrow("compiled Play scene is not ready");
		expect(() => listLighting2DProviderTypes(scene, { cursor: "bad" }, options)).toThrow("cursor");
	});

	test("uses exact compiled Play bridge methods instead of the editor module registry", () => {
		const playScene = new Scene(engine);
		const play = {
			canPlayScene: true,
			scene: playScene,
			listCompiledLight2DProviderTypes: vi.fn(() => [
				{ id: "project.light", displayName: "Project Light", description: "", dataVersion: 2, menuPriority: 10, usesNodeData: true, defaultData: {}, builtIn: false },
			]),
			listCompiledShadowShape2DProviderTypes: vi.fn(() => [
				{ id: "project.shadow", displayName: "Project Shadow", description: "", dataVersion: 3, menuPriority: 20, usesNodeData: true, defaultData: {}, builtIn: false },
			]),
			getCompiledLighting2DRuntimeEvidence: vi.fn(() => ({ configured: true, frameCount: 9, providers: [{ providerId: "project.light", valid: true }] })),
		};
		const options = { editor: { layout: { preview: { play } } } } as any;
		const providers = listLighting2DProviderTypes(scene, { target: "auto" }, options) as any;
		expect(providers).toMatchObject({ target: "play", registryScope: "compiled-game-script-bundle", total: 2 });
		expect(providers.providers.map((provider: any) => provider.id)).toEqual(["project.light", "project.shadow"]);
		expect(getLighting2DRuntime(scene, { target: "play" }, options)).toMatchObject({ target: "play", frameCount: 9 });
		expect(play.getCompiledLighting2DRuntimeEvidence).toHaveBeenCalledWith(playScene);
		playScene.dispose();
	});
});
