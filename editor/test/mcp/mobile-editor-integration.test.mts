import { describe, expect, test } from "vitest";
import { NullEngine, Scene } from "babylonjs";

import layout from "../../src/editor/layout.json";
import { configureTouchControlsExportMetadata } from "../../src/project/export/touch-controls";

function tabs(value: any): any[] {
	return [value, ...(value?.children ?? []).flatMap(tabs)];
}

describe("mobile editor/export integration", () => {
	test("ships a permanent Mobile workspace in the versioned default layout", () => {
		const mobile = tabs(layout.layout).find((entry) => entry.id === "mobile");
		expect(mobile).toMatchObject({ type: "tab", name: "Mobile", component: "mobile", enableClose: false, enableRenderOnDemand: false });
	});

	test("exports canonical Touch Controls while stripping editor-only deployment references", () => {
		const scene = new Scene(new NullEngine());
		scene.metadata = {
			babylonEditorTouchControls: {
				revision: 7,
				enabled: true,
				visibleInEditor: false,
				respectSafeArea: true,
				opacity: 0.8,
				controls: [
					{
						id: "jump",
						name: "Jump",
						type: "button",
						controlPath: "<touch>/jump",
						label: "Jump",
						rect: { x: 0.8, y: 0.7, width: 0.15, height: 0.15 },
					},
				],
			},
			babylonEditorMobileDeployment: { android: { signing: { keystorePasswordEnvironment: "ANDROID_PASSWORD" } } },
			babylonEditorAdaptivePerformance: {
				version: 1,
				revision: 3,
				enabled: true,
				provider: "basic",
				platform: "web",
				targetFrameRate: 60,
				sampleFrames: 30,
				thermalActionDelaySeconds: 1,
				performanceActionDelaySeconds: 1,
				downscaleFrameTimeRatio: 1.1,
				upscaleFrameTimeRatio: 0.8,
				scalers: [],
			},
		};
		const data: any = { metadata: structuredClone(scene.metadata) };
		configureTouchControlsExportMetadata(data, scene);
		expect(data.metadata.babylonEditorTouchControls).toMatchObject({
			version: 1,
			revision: 7,
			enabled: true,
			visibleInEditor: false,
			controls: [{ id: "jump", controlPath: "<touch>/jump" }],
		});
		expect(data.metadata).not.toHaveProperty("babylonEditorMobileDeployment");
		expect(data.metadata.babylonEditorAdaptivePerformance).toMatchObject({ revision: 3, enabled: true, provider: "basic" });
		expect(scene.metadata).toHaveProperty("babylonEditorMobileDeployment");
		scene.dispose();
	});

	test("fails export rather than normalizing an authored invalid viewport layout silently", () => {
		const scene = new Scene(new NullEngine());
		scene.metadata = {
			babylonEditorTouchControls: {
				enabled: true,
				controls: [{ id: "bad", name: "Bad", type: "button", controlPath: "<touch>/bad", rect: { x: 0.95, y: 0.9, width: 0.2, height: 0.2 } }],
			},
		};
		expect(() => configureTouchControlsExportMetadata({}, scene)).toThrow("viewport bounds");
		scene.dispose();
	});
});
