import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import { getDefaultFbxExportSettings } from "babylonjs-editor-tools";

import { showConfirm } from "../../src/ui/dialog";
import { FbxExportDialogContent, executeFbxExport } from "../../src/editor/layout/graph/fbx-export";
import { applyFbxExport, inspectFbxExport, roundTripFbxExport } from "../../src/mcp/assets/fbx-export";

vi.mock("../../src/ui/dialog", () => ({ showConfirm: vi.fn(), showDialog: vi.fn() }));
vi.mock("../../src/mcp/assets/fbx-export", () => ({ applyFbxExport: vi.fn(), inspectFbxExport: vi.fn(), roundTripFbxExport: vi.fn() }));

function editor(): any {
	return {
		layout: {
			preview: { scene: { id: "scene" } },
			console: { log: vi.fn(), error: vi.fn() },
		},
	};
}

describe("FBX export dialog", () => {
	afterEach(() => {
		vi.mocked(showConfirm).mockReset();
		vi.mocked(inspectFbxExport).mockReset();
		vi.mocked(applyFbxExport).mockReset();
		vi.mocked(roundTripFbxExport).mockReset();
	});

	test("renders the complete scene and node export settings surface", () => {
		const sceneMarkup = renderToStaticMarkup(createElement(FbxExportDialogContent, { editor: editor(), defaultPath: "/project/assets/scene.fbx", onClose: vi.fn() }));
		for (const text of [
			"live Babylon scene",
			"Global scale",
			"Forward axis",
			"Up axis",
			"Animation sampling",
			"Apply transforms",
			"Include materials",
			"Embed textures",
			"Include animations",
			"Include cameras",
			"Include lights",
			"Export tangents",
			"Custom properties",
			"Add leaf bones",
			"Only deform bones",
			"Reimport and instantiate",
			"Export FBX",
		]) {
			expect(sceneMarkup).toContain(text);
		}
		expect(sceneMarkup).not.toContain("Include descendants");
		const nodeMarkup = renderToStaticMarkup(
			createElement(FbxExportDialogContent, { editor: editor(), node: { id: "hero", name: "Hero" } as any, defaultPath: "/project/assets/Hero.fbx", onClose: vi.fn() })
		);
		expect(nodeMarkup).toContain("live Babylon selection");
		expect(nodeMarkup).toContain("Include descendants");
		expect(nodeMarkup).toContain('data-testid="fbx-destination"');
		expect(nodeMarkup).toContain('data-testid="fbx-round-trip"');
	});

	test("inspects first, requires overwrite confirmation, and forwards the exact lease to the shared owner", async () => {
		const instance = editor();
		const request = {
			path: "/project/assets/hero.fbx",
			settings: getDefaultFbxExportSettings(),
			rootNodeIds: ["hero"],
			includeDescendants: true,
			roundTrip: false,
		};
		vi.mocked(inspectFbxExport).mockResolvedValue({ exists: true, current: false, path: "assets/hero.fbx", fingerprint: "a".repeat(64) });
		vi.mocked(showConfirm).mockResolvedValueOnce(false);
		expect(await executeFbxExport(instance, request)).toBeNull();
		expect(applyFbxExport).not.toHaveBeenCalled();

		vi.mocked(showConfirm).mockResolvedValueOnce(true);
		vi.mocked(applyFbxExport).mockResolvedValue({ path: "assets/hero.fbx", current: true });
		expect(await executeFbxExport(instance, request)).toMatchObject({ current: true });
		expect(applyFbxExport).toHaveBeenCalledWith(
			instance.layout.preview.scene,
			{
				path: request.path,
				settings: request.settings,
				rootNodeIds: ["hero"],
				includeDescendants: true,
				expectedFingerprint: "a".repeat(64),
				confirm: true,
				name: undefined,
			},
			{ editor: instance }
		);
	});

	test("routes round-trip mode to export, normal model processing, and instantiation in one shared call", async () => {
		const instance = editor();
		vi.mocked(inspectFbxExport).mockResolvedValue({ exists: false, current: false, path: "assets/scene.fbx", fingerprint: "b".repeat(64) });
		vi.mocked(roundTripFbxExport).mockResolvedValue({ export: { path: "assets/scene.fbx" }, instance: { rootNodeId: "returned" } });
		const settings = getDefaultFbxExportSettings();
		const result = await executeFbxExport(instance, { path: "/project/assets/scene.fbx", settings, roundTrip: true, name: "Scene Round Trip" });
		expect(showConfirm).not.toHaveBeenCalled();
		expect(roundTripFbxExport).toHaveBeenCalledWith(
			instance.layout.preview.scene,
			{
				path: "/project/assets/scene.fbx",
				settings,
				rootNodeIds: undefined,
				includeDescendants: undefined,
				expectedFingerprint: "b".repeat(64),
				confirm: true,
				name: "Scene Round Trip",
			},
			{ editor: instance }
		);
		expect(result).toMatchObject({ instance: { rootNodeId: "returned" } });
	});
});
