import { describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { getAssetWatchStatus, refreshWatchedAssets } from "../../src/mcp/assets/assets";
import { getProjectAssetWatchPaths } from "../../src/tools/assets/watch";

describe("mcp/asset watch", () => {
	test("normalizes relative project roots before Chokidar can emit registry-incompatible paths", () => {
		const paths = getProjectAssetWatchPaths("../templates/vanillajs");
		expect(paths).toHaveLength(2);
		expect(paths.every((path) => path.startsWith("/"))).toBe(true);
		expect(paths[0]).toMatch(/\/templates\/vanillajs\/assets$/);
		expect(paths[1]).toMatch(/\/templates\/vanillajs\/src$/);
	});

	test("reports and manually refreshes the editor asset watcher through the shared asset-browser path", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		try {
			const status = { watching: true, changeCount: 3, lastChange: { event: "change", path: "/project/assets/tree.glb", at: "2026-07-14T00:00:00.000Z" } };
			const refreshWatchedAssetsBrowser = vi.fn();
			const getAssetWatchStatusBrowser = vi.fn(() => status);
			const options = { editor: { layout: { assets: { refreshWatchedAssets: refreshWatchedAssetsBrowser, getAssetWatchStatus: getAssetWatchStatusBrowser } } } } as any;

			expect(getAssetWatchStatus(scene, {}, options)).toEqual(status);
			expect(refreshWatchedAssets(scene, {}, options)).toEqual(status);
			expect(refreshWatchedAssetsBrowser).toHaveBeenCalledOnce();
		} finally {
			scene.dispose();
			engine.dispose();
		}
	});
});
