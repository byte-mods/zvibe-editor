import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { join } from "path/posix";
import { tmpdir } from "os";
import { mkdir, mkdtemp, remove, writeFile } from "fs-extra";
import { symlink } from "node:fs/promises";

import { NullEngine, Scene } from "babylonjs";
import { Button, Container } from "babylonjs-gui";
import { createDefaultGUIAuthoringState } from "babylonjs-editor-tools";

vi.mock("../../src/tools/gui/authoring", () => ({ installEditorGUIFontFamily: vi.fn(), loadEditorGUIFontAsset: vi.fn() }));

import {
	applyGUIUXMLUpgrades,
	deleteGUIAnimation,
	deleteGUIAttributeOverride,
	getGUIToolkitCapabilities,
	inspectGUIToolkitWorkspace,
	inspectGUIUXMLUpgrades,
	setGUIAnimation,
	setGUIAttributeOverride,
	setGUIRetainedDocument,
	setGUIStylesheetStage,
	setGUIVisualElementReference,
	simulateGUIWorldSpaceClick,
} from "../../src/mcp/gui/gui";
import { projectConfiguration } from "../../src/project/configuration";

describe("MCP portable UI Toolkit 6.5", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;
	let projectRoot: string;
	let previousProjectPath: string | null;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					preview: { scene },
					inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
					console: { error: vi.fn() },
					assets: { refresh: vi.fn() },
				},
			},
		};
		previousProjectPath = projectConfiguration.path;
		projectRoot = await mkdtemp(join(tmpdir(), "zvibe-ui-toolkit-65-"));
		projectConfiguration.path = join(projectRoot, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		await mkdir(join(projectRoot, "assets/ui"), { recursive: true });
		await writeFile(join(projectRoot, "assets/ui/hud.uxml"), `<UXML><Style src="base.uss"/><Style src="theme.uss"/><Button name="play" class="action" text="Play"/></UXML>`);
		await writeFile(join(projectRoot, "assets/ui/base.uss"), `.action { opacity: 0.5; color: #111111; }`);
		await writeFile(join(projectRoot, "assets/ui/theme.uss"), `.action { color: #222222; } .unused { opacity: 0.2; }`);
	});

	afterEach(async () => {
		projectConfiguration.path = previousProjectPath;
		await remove(projectRoot);
		scene.dispose();
		engine.dispose();
	});

	function installGUI(): any {
		const root = new Container("Root");
		const gui = {
			uniqueId: 749,
			name: "Toolkit HUD",
			_isFullscreen: true,
			layer: { isBackground: false },
			metadata: { zvibeGUIAuthoring: createDefaultGUIAuthoringState() },
			rootContainer: root,
			idealWidth: 0,
			idealHeight: 0,
			getClassName: () => "AdvancedDynamicTexture",
			getSize: () => ({ width: 1920, height: 1080 }),
			scaleTo: vi.fn(),
			serializeContent: () => ({ root: { className: "Container", name: "Root", children: [] }, width: 1920, height: 1080 }),
			parseSerializedObject: vi.fn(),
			dispose: vi.fn(),
		};
		scene.textures.push(gui as any);
		return gui;
	}

	test("authors hierarchy, USS stats/staging, references, overrides, animations, and exact upgrades", async () => {
		const gui = installGUI();
		expect(getGUIToolkitCapabilities()).toMatchObject({
			panelRenderer: { modes: ["overlay", "worldSpace"], nativeBabylonMeshTexture: true },
			testFramework: { worldSpaceSyntheticClick: true },
		});
		let result = await setGUIRetainedDocument(
			scene,
			{ guiId: "749", expectedRevision: 0, expectedSourceFingerprint: null, uxmlPath: "assets/ui/hud.uxml", hotReload: true },
			options
		);
		let workspace = inspectGUIToolkitWorkspace(scene, { guiId: "749", offset: 0, limit: 100 });
		expect(workspace).toMatchObject({
			revision: 1,
			hierarchy: { total: 1, items: [{ id: "play", typeName: "Button" }] },
			uss: { styleRuleCount: 3, unmatchedSelectorCount: 1 },
		});
		expect(workspace.uss.selectorStatistics.total).toBe(3);

		result = await setGUIVisualElementReference(
			scene,
			{ guiId: "749", expectedRevision: result.revision, reference: { id: "play-ref", controlId: "play", expectedTypeName: "Button" } },
			options
		);
		result = await setGUIAttributeOverride(scene, { guiId: "749", expectedRevision: result.revision, override: { controlId: "play", property: "alpha", value: 0.8 } }, options);
		expect((gui.rootContainer.children[0] as Button).alpha).toBeCloseTo(0.8);
		result = await setGUIAnimation(
			scene,
			{
				guiId: "749",
				expectedRevision: result.revision,
				animation: {
					id: "play-pulse",
					controlId: "play",
					property: "alpha",
					from: 0.2,
					to: 1,
					durationMs: 500,
					delayMs: 0,
					easing: "easeInOut",
					loop: true,
					autoplay: true,
				},
			},
			options
		);
		workspace = inspectGUIToolkitWorkspace(scene, { guiId: "749", offset: 0, limit: 100 });
		expect(workspace).toMatchObject({
			references: [{ id: "play-ref", resolved: true, typeName: "Button" }],
			attributeOverrides: [{ controlId: "play", baseValue: 0.5 }],
			animations: [{ id: "play-pulse" }],
		});

		result = await setGUIStylesheetStage(
			scene,
			{
				guiId: "749",
				expectedRevision: result.revision,
				expectedSourceFingerprint: workspace.sourceFingerprint,
				contextId: "prefab-stage",
				activeStylesheetPath: "assets/ui/base.uss",
				stylesheetOrder: ["assets/ui/theme.uss", "assets/ui/base.uss"],
			},
			options
		);
		expect(result.stylesheetStage).toEqual({
			contextId: "prefab-stage",
			activeStylesheetPath: "assets/ui/base.uss",
			stylesheetOrder: ["assets/ui/theme.uss", "assets/ui/base.uss"],
		});
		expect((gui.rootContainer.children[0] as Button).color).toBe("#111111");

		await writeFile(
			join(projectRoot, "assets/ui/hud.uxml"),
			`<UXML><Style src="base.uss"/><Style src="theme.uss"/><Button name="play" className="action" picking-mode="Position" focus-index="1" visible="true" text="Play"/></UXML>`
		);
		const upgrade = await inspectGUIUXMLUpgrades(scene, { guiId: "749" });
		expect(upgrade.plan.edits.map((edit: any) => edit.rule)).toEqual(["class-name", "picking-mode", "focus-index", "visible"]);
		await expect(
			applyGUIUXMLUpgrades(
				scene,
				{ guiId: "749", expectedRevision: result.revision, expectedSourceFingerprint: result.sourceFingerprint, expectedSourceRevision: "0".repeat(64) },
				options
			)
		).rejects.toThrow(/UXML source changed/);
		result = await applyGUIUXMLUpgrades(
			scene,
			{ guiId: "749", expectedRevision: result.revision, expectedSourceFingerprint: result.sourceFingerprint, expectedSourceRevision: upgrade.plan.sourceRevision },
			options
		);
		expect(result).toMatchObject({ changed: true, appliedEditCount: 4 });

		result = await deleteGUIAttributeOverride(scene, { guiId: "749", expectedRevision: result.revision, controlId: "play", property: "alpha", confirm: true }, options);
		result = await deleteGUIAnimation(scene, { guiId: "749", expectedRevision: result.revision, animationId: "play-pulse", confirm: true }, options);
		expect(inspectGUIToolkitWorkspace(scene, { guiId: "749", offset: 0, limit: 100 })).toMatchObject({ revision: result.revision, attributeOverrides: [], animations: [] });
	});

	test("simulates a guarded real control Click only for world-space PanelRenderer state", async () => {
		const gui = installGUI();
		await setGUIRetainedDocument(scene, { guiId: "749", expectedRevision: 0, expectedSourceFingerprint: null, uxmlPath: "assets/ui/hud.uxml", hotReload: true }, options);
		const button = gui.rootContainer.children[0] as Button;
		const click = vi.fn();
		button.onPointerClickObservable.add(click);
		gui._isFullscreen = false;
		gui.metadata.zvibeGUIAuthoring.toolkit.panelRenderer = {
			...gui.metadata.zvibeGUIAuthoring.toolkit.panelRenderer,
			renderMode: "worldSpace",
			targetMeshId: "panel-mesh",
		};
		expect(simulateGUIWorldSpaceClick(scene, { guiId: "749", expectedRevision: 1, controlId: "play", pointerId: 7, eventData: { test: "click" } })).toMatchObject({
			clicked: true,
			eventData: { worldSpace: true, pointerId: 7, test: "click" },
		});
		expect(click).toHaveBeenCalledOnce();
		button.isEnabled = false;
		expect(() => simulateGUIWorldSpaceClick(scene, { guiId: "749", expectedRevision: 1, controlId: "play" })).toThrow(/not visible, enabled/);
	});

	test("rejects symbolic-link source replacement before upgrade reads or writes", async () => {
		installGUI();
		await setGUIRetainedDocument(scene, { guiId: "749", expectedRevision: 0, expectedSourceFingerprint: null, uxmlPath: "assets/ui/hud.uxml", hotReload: true }, options);
		const outside = join(projectRoot, "outside.uxml");
		await writeFile(outside, `<UXML><Label name="outside"/></UXML>`);
		await remove(join(projectRoot, "assets/ui/hud.uxml"));
		await symlink(outside, join(projectRoot, "assets/ui/hud.uxml"));
		await expect(inspectGUIUXMLUpgrades(scene, { guiId: "749" })).rejects.toThrow(/symbolic links/);
	});
});
