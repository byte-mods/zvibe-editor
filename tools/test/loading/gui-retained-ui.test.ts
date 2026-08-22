import { describe, expect, test } from "vitest";

import { compileGUIRetainedDocument, guiRetainedCompilationModel, guiRetainedDocumentModel, normalizeGUIRetainedDocumentState } from "../../src/loading/gui-retained-ui";

describe("retained UXML/USS GUI compiler", () => {
	test("compiles templates, cascade specificity, variables, inline styles, and pseudo states deterministically", async () => {
		const options = {
			uxmlPath: "assets/ui/menu.uxml",
			uxml: `
				<ui:UXML xmlns:ui="UnityEngine.UIElements">
					<ui:Style src="menu.uss" />
					<ui:Template name="Card" src="card.uxml" />
					<ui:VisualElement name="screen" class="screen" width="100%" height="100%">
						<ui:Label name="title" class="title" text="Ready" style="color: #ffffff;" />
						<ui:Instance template="Card" name="primary" class="instance" />
					</ui:VisualElement>
				</ui:UXML>
			`,
			stylesheets: [
				{
					path: "assets/ui/menu.uss",
					source: `
						:root { --accent: #73a7ff; }
						VisualElement { flex-direction: column; gap: 12px; }
						.screen > .title { color: var(--accent); font-size: 36px; }
						#title { color: #ff0000; }
						Button.primary { width: 220px; height: 56px; background-color: #202840; }
						Button.primary:hover { background-color: var(--accent); opacity: 0.9; }
						#action:active { opacity: 0.7; }
					`,
				},
			],
			templates: [
				{
					path: "assets/ui/card.uxml",
					source: `<ui:UXML xmlns:ui="UnityEngine.UIElements"><ui:Button name="action" class="primary" text="Play" /></ui:UXML>`,
				},
			],
		};
		const first = await compileGUIRetainedDocument(options);
		const second = await compileGUIRetainedDocument(options);
		expect(first).toEqual(second);
		expect(first).toMatchObject({
			model: guiRetainedCompilationModel,
			styleRuleCount: 6,
			pseudoRuleCount: 2,
			templateCount: 1,
			generatedIdCount: 0,
			maximumDepth: 2,
			rootControlIds: ["screen"],
		});
		expect(first.selectorStatistics).toHaveLength(6);
		expect(first.selectorStatistics.find((entry) => entry.selector === "#title")).toMatchObject({ matchedControlCount: 1, specificity: 100, pseudoState: null });
		expect(first.sourceFingerprint).toMatch(/^[a-f\d]{64}$/);
		expect(first.sources).toHaveLength(3);
		expect(first.controls).toHaveLength(3);
		expect(first.controls.find((control) => control.id === "screen")).toMatchObject({
			kind: "stackPanel",
			properties: { width: "100%", height: "100%", isVertical: true, spacing: 12 },
		});
		expect(first.controls.find((control) => control.id === "title")).toMatchObject({
			parentId: "screen",
			properties: { text: "Ready", color: "#ffffff", fontSize: 36 },
			matchedRuleCount: 2,
			inlinePropertyCount: 2,
		});
		expect(first.controls.find((control) => control.id === "primary::action")).toMatchObject({
			sourceName: "action",
			parentId: "screen",
			classes: ["instance", "primary"],
			properties: { text: "Play", width: "220px", height: "56px", background: "#202840" },
			pseudoStyles: { hover: { background: "#73a7ff", alpha: 0.9 }, active: { alpha: 0.7 } },
		});
	});

	test("applies an explicit complete stylesheet staging order to cascade and statistics", async () => {
		const options = {
			uxmlPath: "assets/ui/stage.uxml",
			uxml: `<UXML><Style src="first.uss"/><Style src="second.uss"/><Label name="title" class="title" text="Ready"/></UXML>`,
			stylesheets: [
				{ path: "assets/ui/first.uss", source: `.title { color: #111111; }` },
				{ path: "assets/ui/second.uss", source: `.title { color: #222222; }` },
			],
		};
		const defaultOrder = await compileGUIRetainedDocument(options);
		const reversed = await compileGUIRetainedDocument({ ...options, stylesheetOrder: ["assets/ui/second.uss", "assets/ui/first.uss"] });
		expect(defaultOrder.controls[0].properties.color).toBe("#222222");
		expect(reversed.controls[0].properties.color).toBe("#111111");
		expect(reversed.sources.filter((source) => source.kind === "uss").map((source) => source.path)).toEqual(["assets/ui/second.uss", "assets/ui/first.uss"]);
		await expect(compileGUIRetainedDocument({ ...options, stylesheetOrder: ["assets/ui/first.uss"] })).rejects.toThrow(/every stylesheet exactly once/);
	});

	test("reports generated ids and changes its exact source fingerprint when source changes", async () => {
		const first = await compileGUIRetainedDocument({
			uxmlPath: "assets/ui/simple.uxml",
			uxml: `<UXML><VisualElement><Label text="One" /></VisualElement></UXML>`,
		});
		const second = await compileGUIRetainedDocument({
			uxmlPath: "assets/ui/simple.uxml",
			uxml: `<UXML><VisualElement><Label text="Two" /></VisualElement></UXML>`,
		});
		expect(first.generatedIdCount).toBe(2);
		expect(first.warnings[0]).toMatch(/stable name attributes/);
		expect(first.sourceFingerprint).not.toBe(second.sourceFingerprint);
	});

	test("compiles CanvasGroup interaction policy and invisible RaycastReceiver controls", async () => {
		const compiled = await compileGUIRetainedDocument({
			uxmlPath: "assets/ui/input.uxml",
			uxml: `<UXML><CanvasGroup name="fade" opacity="0.35" interactable="false" blocks-raycasts="true" ignore-parent-groups="true"><RaycastReceiver name="input" width="100%" height="100%"/></CanvasGroup></UXML>`,
		});
		expect(compiled.controls).toMatchObject([
			{
				id: "fade",
				kind: "canvasGroup",
				properties: { alpha: 0.35, interactable: false, blocksRaycasts: true, ignoreParentGroups: true },
			},
			{ id: "input", parentId: "fade", kind: "raycastReceiver", properties: { width: "100%", height: "100%" } },
		]);
		await expect(compileGUIRetainedDocument({ uxmlPath: "assets/ui/bad.uxml", uxml: `<UXML><Label name="bad" interactable="true"/></UXML>` })).rejects.toThrow(
			/only on <CanvasGroup>/
		);
	});

	test("validates persisted source ownership against the exact live control tree", async () => {
		const compiled = await compileGUIRetainedDocument({
			uxmlPath: "assets/ui/hud.uxml",
			uxml: `<UXML><Label name="score" text="0" /></UXML>`,
		});
		const state = normalizeGUIRetainedDocumentState(
			{
				model: guiRetainedDocumentModel,
				uxmlPath: "assets/ui/hud.uxml",
				stylesheetPaths: [],
				templatePaths: [],
				hotReload: true,
				sourceRevision: 1,
				compiled,
			},
			new Set(["score"])
		);
		expect(state).toMatchObject({ sourceRevision: 1, hotReload: true, compiled: { controls: [{ id: "score" }] } });
		expect(() => normalizeGUIRetainedDocumentState(state, new Set(["other"]))).toThrow(/no longer exactly owns/);
		expect(() =>
			normalizeGUIRetainedDocumentState({ ...state, compiled: { ...state.compiled, controls: [{ ...state.compiled.controls[0], properties: { mystery: 1 } }] } })
		).toThrow(/unknown property "mystery"/);
	});

	test("rejects unsafe XML, unknown declarations, malformed selectors, and missing template sources", async () => {
		await expect(
			compileGUIRetainedDocument({ uxmlPath: "assets/ui/bad.uxml", uxml: `<!DOCTYPE UXML [<!ENTITY x "unsafe">]><UXML><Label text="&x;" /></UXML>` })
		).rejects.toThrow(/DTD and entity/);
		await expect(
			compileGUIRetainedDocument({
				uxmlPath: "assets/ui/bad.uxml",
				uxml: `<UXML><Style src="assets/ui/bad.uss"/><Label name="title" /></UXML>`,
				stylesheets: [{ path: "assets/ui/bad.uss", source: `.title { position: absolute; }` }],
			})
		).rejects.toThrow(/unsupported retained-UI property "position"/);
		await expect(
			compileGUIRetainedDocument({
				uxmlPath: "assets/ui/bad.uxml",
				uxml: `<UXML><Style src="assets/ui/bad.uss"/><Label name="title" /></UXML>`,
				stylesheets: [{ path: "assets/ui/bad.uss", source: `.panel:hover .title { color: red; }` }],
			})
		).rejects.toThrow(/rightmost element/);
		await expect(
			compileGUIRetainedDocument({
				uxmlPath: "assets/ui/bad.uxml",
				uxml: `<UXML><Template name="Card" src="assets/ui/card.uxml"/><Instance template="Card" name="card"/></UXML>`,
			})
		).rejects.toThrow(/was not provided/);
	});
});
