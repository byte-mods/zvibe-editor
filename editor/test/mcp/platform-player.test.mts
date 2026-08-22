import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { createBuildProfile, getBuildProfileEnvironment, getBuildProfilePlatformPlayerPlan, listBuildProfiles, setBuildProfile } from "../../src/mcp/project/export";
import {
	getPlatformPlayerCapabilities,
	getPlatformPlayerRuntime,
	preparePlatformPlayerRuntime,
	resetPlatformPlayerRuntime,
	samplePlatformPlayerFramePacing,
	shutdownPlatformPlayerRuntime,
	simulatePlatformPlayerIme,
} from "../../src/mcp/project/platform-player";

describe("mcp/platform player", () => {
	let engine: NullEngine;
	let scene: Scene;
	let timestamp: number;
	const options = { editor: { state: { projectPath: "/tmp/zvibe-platform-player/Game.bjseditor", sceneBuildSettings: {}, projectSettings: {} } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		timestamp = 0;
		(globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback): number => {
			const handle = Math.round(timestamp) + 1;
			timestamp += 16;
			queueMicrotask(() => callback(timestamp));
			return handle;
		};
		(globalThis as any).cancelAnimationFrame = vi.fn();
	});

	afterEach(() => {
		shutdownPlatformPlayerRuntime(scene);
		delete (globalThis as any).requestAnimationFrame;
		delete (globalThis as any).cancelAnimationFrame;
		delete (globalThis as any).zvibeMetalDisplayLink;
		scene.dispose();
		engine.dispose();
		vi.restoreAllMocks();
	});

	test("persists normalized version-1 platform defaults on Electron profiles", () => {
		const created = createBuildProfile(scene, { expectedRevision: 0, id: "desktop", name: "Desktop", target: "electron" });
		expect(created).toMatchObject({
			configuration: { revision: 1 },
			profile: {
				settings: { platformPlayer: { version: 1, linux: { variant: "desktop", lto: "thin", ime: "ibus" }, macos: { useDisplayLink: false, maximumQueuedFrames: 2 } } },
			},
		});
	});

	test("authors Full LTO and FCITX5 and projects exact Linux flags and environment", () => {
		createBuildProfile(scene, {
			expectedRevision: 0,
			id: "linux",
			name: "Linux",
			target: "electron",
			settings: { electronPlatform: "linux", platformPlayer: { linux: { variant: "desktop", lto: "full", ime: "fcitx5" } } },
		});
		const descriptor = getBuildProfilePlatformPlayerPlan(scene, { id: "linux" });
		expect(descriptor).toMatchObject({
			configurationRevision: 1,
			plan: {
				platform: "linux",
				lto: { mode: "full", compilerFlags: ["-flto=full"], scope: "project-native-dependencies" },
				ime: { mode: "fcitx5", environment: { GTK_IM_MODULE: "fcitx", XMODIFIERS: "@im=fcitx" } },
			},
		});
		const environment = getBuildProfileEnvironment(scene, { id: "linux" }, options).environment;
		expect(JSON.parse(environment.BJS_EDITOR_PLATFORM_PLAYER_SETTINGS)).toMatchObject({ linux: { lto: "full", ime: "fcitx5" } });
		expect(JSON.parse(environment.BJS_EDITOR_PLATFORM_PLAYER_PLAN)).toMatchObject({ platform: "linux", lto: { mode: "full" } });
	});

	test("rejects Embedded Linux with FCITX5 atomically without advancing the revision", () => {
		createBuildProfile(scene, { expectedRevision: 0, id: "linux", name: "Linux", target: "electron", settings: { electronPlatform: "linux" } });
		expect(() =>
			setBuildProfile(scene, {
				expectedRevision: 1,
				id: "linux",
				settings: { electronPlatform: "linux", platformPlayer: { linux: { variant: "embedded", ime: "fcitx5" } } },
			})
		).toThrow("desktop-only");
		expect(listBuildProfiles(scene)).toMatchObject({ revision: 1, profiles: [{ settings: { platformPlayer: { linux: { variant: "desktop", ime: "ibus" } } } }] });
	});

	test("authors optional macOS display-link and queue-depth policy without overclaiming the native adapter", () => {
		createBuildProfile(scene, {
			expectedRevision: 0,
			id: "mac",
			name: "Mac",
			target: "electron",
			settings: { electronPlatform: "darwin", platformPlayer: { macos: { useDisplayLink: true, maximumQueuedFrames: 1 } } },
		});
		expect(getBuildProfilePlatformPlayerPlan(scene, { id: "mac" }).plan).toMatchObject({
			framePacing: { requestedDisplayLink: true, maximumQueuedFrames: 1, nativeAdapterRequired: true, queueDepthEnforcement: "native-adapter-required" },
			warnings: [expect.stringContaining("Chromium")],
		});
	});

	test("keeps platform-player environment scoped to Electron and rejects plans for other targets", () => {
		createBuildProfile(scene, { expectedRevision: 0, id: "web", name: "Web", target: "web" });
		const environment = getBuildProfileEnvironment(scene, { id: "web" }, options).environment;
		expect(environment.BJS_EDITOR_PLATFORM_PLAYER_SETTINGS).toBeUndefined();
		expect(environment.BJS_EDITOR_PLATFORM_PLAYER_PLAN).toBeUndefined();
		expect(() => getBuildProfilePlatformPlayerPlan(scene, { id: "web" })).toThrow("require an Electron build profile");
	});

	test("exposes capabilities, editor feature flags, and all seven MCP endpoints", () => {
		expect(getPlatformPlayerCapabilities()).toMatchObject({
			buildProfiles: { target: "electron", linuxPlatforms: ["desktop", "embedded"], lto: ["thin", "full"] },
			linuxIme: { desktop: ["disabled", "ibus", "fcitx5"], embedded: ["disabled", "ibus"] },
		});
		expect(getEditorCapabilities(scene, {}, options).features).toMatchObject({
			linuxPlayerLtoModes: true,
			linuxPlayerIme: true,
			macosDisplayLinkFramePacing: true,
			platformPlayerRuntimeEvidence: true,
		});
		for (const endpoint of [
			"get_platform_player_capabilities",
			"get_build_profile_platform_player_plan",
			"prepare_platform_player_runtime",
			"get_platform_player_runtime",
			"simulate_platform_player_ime",
			"sample_platform_player_frame_pacing",
			"reset_platform_player_runtime",
		]) {
			expect(MCPEndpoints[endpoint]).toBeTypeOf("function");
		}
	});

	test("prepares a transient runtime only under the exact Build Profiles revision", () => {
		createBuildProfile(scene, { expectedRevision: 0, id: "mac", name: "Mac", target: "electron" });
		expect(() => preparePlatformPlayerRuntime(scene, { id: "mac", expectedBuildRevision: 0 }, options)).toThrow("expectedBuildRevision 1");
		const prepared = preparePlatformPlayerRuntime(scene, { id: "mac", expectedBuildRevision: 1 }, options);
		expect(prepared).toMatchObject({ prepared: true, profileId: "mac", configurationRevision: 1, runtime: { configured: true, revision: 2 } });
		expect(getPlatformPlayerRuntime(scene)).toMatchObject({ prepared: true, profileId: "mac" });
	});

	test("records explicitly labeled IME simulation under an exact transient revision", () => {
		createBuildProfile(scene, { expectedRevision: 0, id: "linux", name: "Linux", target: "electron", settings: { electronPlatform: "linux" } });
		const prepared = preparePlatformPlayerRuntime(scene, { id: "linux", expectedBuildRevision: 1 }, options);
		expect(() => simulatePlatformPlayerIme(scene, { expectedRuntimeRevision: prepared.runtime.revision + 1, events: [{ type: "start", text: "に" }] })).toThrow(
			"expectedRuntimeRevision 2"
		);
		const result = simulatePlatformPlayerIme(scene, {
			expectedRuntimeRevision: prepared.runtime.revision,
			events: [
				{ type: "start", text: "に" },
				{ type: "update", text: "日本" },
				{ type: "end", text: "日本語" },
			],
		});
		expect(result.runtime).toMatchObject({
			revision: 5,
			compositionEvents: [{ source: "editor-simulation" }, { source: "editor-simulation" }, { source: "editor-simulation" }],
		});
	});

	test("samples real renderer requestAnimationFrame deltas with effective-backend evidence", async () => {
		createBuildProfile(scene, {
			expectedRevision: 0,
			id: "mac",
			name: "Mac",
			target: "electron",
			settings: { electronPlatform: "darwin", platformPlayer: { macos: { useDisplayLink: true, maximumQueuedFrames: 2 } } },
		});
		const prepared = preparePlatformPlayerRuntime(scene, { id: "mac", expectedBuildRevision: 1 }, options);
		const result = await samplePlatformPlayerFramePacing(scene, { expectedRuntimeRevision: prepared.runtime.revision, sampleCount: 4 });
		expect(result.runtime.framePacing).toMatchObject({
			sampleCount: 4,
			minimumDeltaMs: 16,
			maximumDeltaMs: 16,
			averageDeltaMs: 16,
			backend: "chromium-request-animation-frame",
			requestedDisplayLink: true,
			queueDepthApplied: false,
		});
	});

	test("requires confirmation and exact revision to reset evidence, then releases the runtime", () => {
		createBuildProfile(scene, { expectedRevision: 0, id: "desktop", name: "Desktop", target: "electron" });
		const prepared = preparePlatformPlayerRuntime(scene, { id: "desktop", expectedBuildRevision: 1 }, options);
		const simulated = simulatePlatformPlayerIme(scene, { expectedRuntimeRevision: prepared.runtime.revision, events: [{ type: "start", text: "x" }] });
		expect(() => resetPlatformPlayerRuntime(scene, { expectedRuntimeRevision: simulated.runtime.revision, confirm: false })).toThrow("confirm=true");
		expect(() => resetPlatformPlayerRuntime(scene, { expectedRuntimeRevision: prepared.runtime.revision, confirm: true })).toThrow("expectedRuntimeRevision 3");
		expect(resetPlatformPlayerRuntime(scene, { expectedRuntimeRevision: simulated.runtime.revision, confirm: true })).toMatchObject({
			reset: true,
			runtime: { revision: 4, compositionEvents: [], framePacing: null },
		});
		shutdownPlatformPlayerRuntime(scene);
		expect(getPlatformPlayerRuntime(scene)).toEqual({ prepared: false, profileId: null, configurationRevision: null, runtime: null });
	});
});
