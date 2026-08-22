import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";
import { adaptivePerformancePreset, getAdaptivePerformanceRuntime, sampleAdaptivePerformanceFrame } from "babylonjs-editor-tools";

import {
	applyRenderingProfile,
	clearActiveRenderingProfile,
	createRenderingProfile,
	deleteRenderingProfile,
	getRenderingProfileRuntime,
	listRenderingProfiles,
	setRenderingProfile,
} from "../../src/mcp/rendering/profiles";

describe("mcp/rendering-profiles", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, preview: { scene: null } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		options.editor.layout.preview.scene = scene;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, updates, applies, lists, and deletes an explicit disabled profile", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const profile = createRenderingProfile(scene, { name: "Mobile", configurations }, options);
		expect(listRenderingProfiles(scene).profiles).toEqual([profile]);

		const updated = setRenderingProfile(scene, { id: profile.id, name: "Mobile Low", configurations }, options);
		expect(updated.name).toBe("Mobile Low");
		expect(applyRenderingProfile(scene, { id: profile.id, nodeId: camera.id }, options)).toMatchObject({
			id: profile.id,
			camera: "Camera",
			appliedTypes: ["default", "ssao", "ssr", "motionBlur", "vls", "taa", "customColor"],
		});
		expect(deleteRenderingProfile(scene, { id: profile.id, revision: updated.revision, confirm: true }, options)).toEqual({
			deleted: true,
			id: profile.id,
			revision: updated.revision,
		});
		expect(listRenderingProfiles(scene).profiles).toEqual([]);
	});

	test("rejects unsupported profile post-process types", () => {
		expect(() => createRenderingProfile(scene, { name: "Invalid", configurations: { unsupported: null } }, options)).toThrow("Unsupported rendering profile post-process type");
	});

	test("activates a target preset with exact runtime evidence and protects the active asset", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const created = createRenderingProfile(scene, { name: "Web Performance", target: "web-performance", configurations }, options);
		const applied = applyRenderingProfile(scene, { id: created.id, revision: created.revision, nodeId: camera.id, activateProject: true }, options);
		expect(applied).toMatchObject({ activeProjectProfile: true, runtime: { configured: true, compatible: true, activeProfileId: created.id } });
		expect(getRenderingProfileRuntime(scene)).toMatchObject({ applied: { renderScale: 0.75, hardwareScalingLevel: 1, performancePriority: "aggressive" } });
		expect(listRenderingProfiles(scene)).toMatchObject({ activeProfileId: created.id, profiles: [{ target: "web-performance", revision: 1 }] });
		expect(() => deleteRenderingProfile(scene, { id: created.id, revision: created.revision, confirm: true }, options)).toThrow("active project profile");
		expect(clearActiveRenderingProfile(scene, { id: created.id, revision: created.revision, confirm: true }, options)).toMatchObject({
			cleared: true,
			runtime: { configured: false, activeProfileId: null },
		});
		expect(deleteRenderingProfile(scene, { id: created.id, revision: created.revision, confirm: true }, options)).toMatchObject({ deleted: true });
	});

	test("rejects incompatible project activation and clears the failed active selection", () => {
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const created = createRenderingProfile(scene, { name: "WebGPU Only", target: "desktop", requirements: { webgpu: true }, configurations }, options);
		expect(() => applyRenderingProfile(scene, { id: created.id, revision: created.revision, nodeId: camera.id, activateProject: true }, options)).toThrow("incompatible");
		expect(listRenderingProfiles(scene).activeProfileId).toBeNull();
	});

	test("hands quality ownership between rendering profiles and Adaptive Performance without corrupting either baseline", () => {
		scene.metadata ??= {};
		scene.metadata.babylonEditorAdaptivePerformance = {
			...adaptivePerformancePreset(),
			enabled: true,
			provider: "basic",
			sampleFrames: 2,
			thermalActionDelaySeconds: 0,
			performanceActionDelaySeconds: 0,
		};
		const configurations = { default: null, ssao: null, ssr: null, motionBlur: null, vls: null, taa: null, customColor: null };
		const created = createRenderingProfile(scene, { name: "Adaptive Mobile", target: "mobile", configurations }, options);
		const applied = applyRenderingProfile(scene, { id: created.id, revision: created.revision, nodeId: camera.id, activateProject: true }, options) as any;
		expect(applied.adaptivePerformance).toMatchObject({ running: true, configurationRevision: 1 });
		sampleAdaptivePerformanceFrame(scene, 30);
		sampleAdaptivePerformanceFrame(scene, 30);
		expect(getAdaptivePerformanceRuntime(scene).actions).toHaveLength(1);

		const cleared = clearActiveRenderingProfile(scene, { id: created.id, revision: created.revision, confirm: true }, options) as any;
		expect(cleared.adaptivePerformance).toMatchObject({ running: true, qualityIndex: 1, actions: [] });
		expect(getAdaptivePerformanceRuntime(scene)).toMatchObject({ running: true, configurationRevision: 1 });
	});
});
