import { tmpdir } from "os";
import { join } from "path/posix";

import { ensureDir, remove, writeFile } from "fs-extra";
import { FreeCamera, NullEngine, Scene, TransformNode, Vector3 } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
	controlCinematicPreview,
	createCinematic,
	createCinematicDocumentClip,
	createCinematicDocumentKey,
	createCinematicDocumentMarker,
	createCinematicDocumentRecorderProfile,
	createCinematicDocumentTrack,
	deleteCinematic,
	deleteCinematicDocumentClip,
	deleteCinematicDocumentKey,
	deleteCinematicDocumentMarker,
	forkCinematic,
	getCinematic,
	getCinematicCapabilities,
	getCinematicPreview,
	inspectCinematicAudioCapturePlan,
	moveCinematicDocumentTrack,
	replaceCinematic,
	setCinematicDocumentKey,
	setCinematicDocumentClip,
	setCinematicDocumentSettings,
	setCinematicDocumentTrack,
	startCinematicCapture,
	validateCinematic,
} from "../../src/mcp/cinematic/cinematic";
import { getEditorCapabilities } from "../../src/mcp/editor";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { projectConfiguration } from "../../src/project/configuration";

interface ICinematicResult {
	path: string;
	document: Record<string, any>;
	fingerprint: string;
}

describe("mcp/cinematic version-2 actions", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(async () => {
		directory = join(tmpdir(), `zvibe-cinematic-mcp-${crypto.randomUUID()}`);
		await ensureDir(join(directory, "assets"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}\n");
		engine = new NullEngine();
		scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera.id = "camera";
		options = { editor: { layout: { assets: { refresh: vi.fn() } } } };
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	function lease(result: ICinematicResult) {
		return { path: result.path, expectedRevision: result.document.revision, expectedFingerprint: result.fingerprint };
	}

	test("creates and granularly authors settings, hierarchy, keys, clips, markers, and capture profiles", async () => {
		const target = new TransformNode("Hero", scene);
		target.id = "hero";
		let result = (await createCinematic(
			scene,
			{ path: "assets/intro.cinematic", name: "Intro", durationMode: "fixed", durationFrames: 120, framesPerSecond: 30, outputFramesPerSecond: 60 },
			options
		)) as ICinematicResult;
		expect(result).toMatchObject({ path: "assets/intro.cinematic", document: { version: 2, revision: 0, name: "Intro", durationFrames: 120 } });
		expect(result.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		const staleLease = lease(result);

		result = (await createCinematicDocumentTrack(
			scene,
			{
				...lease(result),
				track: { id: "group", name: "Actors", type: "group", order: 0, parentId: null, muted: false, solo: false, locked: false, color: "#445566", collapsed: false },
			},
			options
		)) as ICinematicResult;
		result = (await createCinematicDocumentTrack(
			scene,
			{
				...lease(result),
				track: {
					id: "position",
					name: "Position X",
					type: "property",
					order: 1,
					parentId: "group",
					muted: false,
					solo: false,
					locked: false,
					color: "#336699",
					targetType: "node",
					targetId: "hero",
					propertyPath: "position.x",
					keys: [],
				},
			},
			options
		)) as ICinematicResult;
		result = (await createCinematicDocumentKey(
			scene,
			{ ...lease(result), trackId: "position", lane: "property", key: { id: "start", type: "key", frame: 0, value: 0, interpolation: "linear" } },
			options
		)) as ICinematicResult;
		result = (await setCinematicDocumentKey(
			scene,
			{ ...lease(result), trackId: "position", lane: "property", keyId: "start", key: { id: "start", type: "cut", frame: 10, incomingValue: 1, outgoingValue: 2 } },
			options
		)) as ICinematicResult;

		result = (await createCinematicDocumentTrack(
			scene,
			{
				...lease(result),
				track: { id: "signals", name: "Signals", type: "signal", order: 2, parentId: null, muted: false, solo: false, locked: false, color: "#AA5500", markers: [] },
			},
			options
		)) as ICinematicResult;
		result = (await createCinematicDocumentMarker(
			scene,
			{
				...lease(result),
				trackId: "signals",
				marker: { id: "impact", name: "Impact", type: "event", frame: 20, emitOnce: true, retroactive: false, payload: { damage: 10 } },
			},
			options
		)) as ICinematicResult;

		result = (await createCinematicDocumentRecorderProfile(
			scene,
			{
				...lease(result),
				profile: { id: "preview", name: "Preview", format: "webm", width: 1280, height: 720, framesPerSecond: 60, quality: 0.8, includeAudio: false },
			},
			options
		)) as ICinematicResult;
		result = (await createCinematicDocumentTrack(
			scene,
			{
				...lease(result),
				track: { id: "capture", name: "Capture", type: "recorder", order: 3, parentId: null, muted: false, solo: false, locked: false, color: "#8844AA", clips: [] },
			},
			options
		)) as ICinematicResult;
		result = (await createCinematicDocumentClip(
			scene,
			{
				...lease(result),
				trackId: "capture",
				clip: {
					id: "capture-main",
					name: "Main",
					type: "recorder",
					startFrame: 0,
					durationFrames: 120,
					clipInFrame: 0,
					timeScale: 1,
					enabled: true,
					blendInFrames: 0,
					blendOutFrames: 0,
					easeIn: "linear",
					easeOut: "linear",
					preExtrapolation: "none",
					postExtrapolation: "none",
					profileId: "preview",
				},
			},
			options
		)) as ICinematicResult;

		expect(result.document).toMatchObject({ revision: 9, tracks: [{ id: "group" }, { id: "position" }, { id: "signals" }, { id: "capture" }] });
		expect((await validateCinematic(scene, { path: result.path })) as any).toMatchObject({ valid: true, errors: [] });
		result = (await moveCinematicDocumentTrack(scene, { ...lease(result), trackId: "capture", index: 2, parentId: null }, options)) as ICinematicResult;
		result = (await deleteCinematicDocumentClip(scene, { ...lease(result), trackId: "capture", clipId: "capture-main", confirm: true }, options)) as ICinematicResult;
		result = (await deleteCinematicDocumentKey(scene, { ...lease(result), trackId: "position", lane: "property", keyId: "start", confirm: true }, options)) as ICinematicResult;
		expect(result.document.revision).toBe(12);
		await expect(setCinematicDocumentSettings(scene, { ...staleLease, changes: { name: "Stale" } }, options)).rejects.toThrow("revision is stale");
		await expect(setCinematicDocumentTrack(scene, { ...lease(result), trackId: "position", changes: { unknown: true } }, options)).rejects.toThrow("unsupported fields");
		expect(options.editor.layout.assets.refresh).toHaveBeenCalledTimes(13);
	});

	test("confirmation-deletes items, forks identity, replaces exact documents, and rejects traversal", async () => {
		let result = (await createCinematic(scene, { path: "assets/source.cinematic", name: "Source", durationMode: "fixed", durationFrames: 10 }, options)) as ICinematicResult;
		result = (await createCinematicDocumentTrack(
			scene,
			{
				...lease(result),
				track: { id: "signals", name: "Signals", type: "signal", order: 0, parentId: null, muted: false, solo: false, locked: false, color: "#AA5500", markers: [] },
			},
			options
		)) as ICinematicResult;
		result = (await createCinematicDocumentMarker(
			scene,
			{ ...lease(result), trackId: "signals", marker: { id: "mark", name: "Mark", type: "signal", frame: 1, emitOnce: false, retroactive: false, payload: null } },
			options
		)) as ICinematicResult;
		await expect(deleteCinematicDocumentMarker(scene, { ...lease(result), trackId: "signals", markerId: "mark", confirm: false }, options)).rejects.toThrow("confirm=true");
		result = (await deleteCinematicDocumentMarker(scene, { ...lease(result), trackId: "signals", markerId: "mark", confirm: true }, options)) as ICinematicResult;

		const replacement = structuredClone(result.document);
		replacement.name = "Replaced";
		result = (await replaceCinematic(scene, { ...lease(result), document: replacement, confirm: true }, options)) as ICinematicResult;
		expect(result.document).toMatchObject({ name: "Replaced", revision: 4 });
		const forked = (await forkCinematic(scene, { ...lease(result), destinationPath: "assets/fork.cinematic" }, options)) as ICinematicResult;
		expect(forked.document.id).not.toBe(result.document.id);
		expect(forked.document.revision).toBe(0);
		await expect(deleteCinematic(scene, { ...lease(forked), confirm: false }, options)).rejects.toThrow("confirm=true");
		expect(await deleteCinematic(scene, { ...lease(forked), confirm: true }, options)).toMatchObject({ deleted: true, path: "assets/fork.cinematic" });
		await expect(getCinematic(scene, { path: "../outside.cinematic" })).rejects.toThrow("inside the open project");
	});

	test("plays, pauses, seeks, steps, and restores one scene preview", async () => {
		const result = (await createCinematic(
			scene,
			{ path: "assets/preview.cinematic", name: "Preview", durationMode: "fixed", durationFrames: 10 },
			options
		)) as ICinematicResult;
		expect(await controlCinematicPreview(scene, { action: "play", path: result.path, loop: false, speed: 2, ignoreSounds: true })).toMatchObject({ playing: true, speed: 2 });
		scene.render();
		expect(getCinematicPreview(scene)).toMatchObject({ path: result.path, revision: 0 });
		expect(await controlCinematicPreview(scene, { action: "pause" })).toMatchObject({ playing: false });
		expect(await controlCinematicPreview(scene, { action: "seek", frame: 4 })).toMatchObject({ frame: 4 });
		expect(await controlCinematicPreview(scene, { action: "step", frameCount: 2 })).toMatchObject({ frame: 6 });
		expect(await controlCinematicPreview(scene, { action: "play", path: result.path, loop: false, speed: 2, ignoreSounds: true })).toMatchObject({ playing: true });
		expect(await controlCinematicPreview(scene, { action: "seek", frame: 4 })).toMatchObject({ playing: false, frame: 4 });
		expect(await controlCinematicPreview(scene, { action: "step", frameCount: 2 })).toMatchObject({ playing: false, frame: 6 });
		expect(await controlCinematicPreview(scene, { action: "stop" })).toBeNull();
		expect(getCinematicPreview(scene)).toBeNull();
	});

	test("preflights offline audio container and renderer readiness before touching preview state", async () => {
		let result = (await createCinematic(scene, { path: "assets/audio-capture.cinematic", durationMode: "fixed", durationFrames: 10 }, options)) as ICinematicResult;
		result = (await createCinematicDocumentRecorderProfile(
			scene,
			{
				...lease(result),
				profile: { id: "audio", name: "Audio", format: "png", width: 1280, height: 720, framesPerSecond: 60, quality: 0.8, includeAudio: true },
			},
			options
		)) as ICinematicResult;
		const inspection = (await inspectCinematicAudioCapturePlan(scene, { ...lease(result), profileId: "audio" })) as any;
		expect(inspection).toMatchObject({ path: result.path, audio: { ready: false } });
		expect(inspection.audio.issues.map((issue: any) => issue.code)).toContain("AUDIO_CONTAINER_UNSUPPORTED");
		await expect(startCinematicCapture(scene, { ...lease(result), profileId: "audio", destination: "assets/audio-capture.png" }, options)).rejects.toThrow(
			"muxed only into WebM or MP4"
		);
	});

	test("authors and validates persistent Video Player Timeline clips", async () => {
		let result = (await createCinematic(scene, { path: "assets/video.cinematic", durationMode: "fixed", durationFrames: 60 }, options)) as ICinematicResult;
		result = (await createCinematicDocumentTrack(
			scene,
			{
				...lease(result),
				track: { id: "video", name: "Video", type: "video", order: 0, parentId: null, muted: false, solo: false, locked: false, color: "#336699", clips: [] },
			},
			options
		)) as ICinematicResult;
		result = (await createCinematicDocumentClip(
			scene,
			{
				...lease(result),
				trackId: "video",
				clip: {
					id: "intro-video",
					name: "Intro Video",
					type: "video",
					startFrame: 0,
					durationFrames: 30,
					clipInFrame: 0,
					timeScale: 1,
					enabled: true,
					blendInFrames: 2,
					blendOutFrames: 2,
					easeIn: "linear",
					easeOut: "linear",
					preExtrapolation: "none",
					postExtrapolation: "none",
					videoPlayerId: "intro-player",
					volume: 0.8,
					loop: false,
					muteAudio: false,
				},
			},
			options
		)) as ICinematicResult;
		result = (await setCinematicDocumentClip(
			scene,
			{ ...lease(result), trackId: "video", clipId: "intro-video", changes: { volume: 0.5, muteAudio: true, videoPlayerId: "intro-player" } },
			options
		)) as ICinematicResult;
		expect(result.document.tracks[0].clips[0]).toMatchObject({ type: "video", videoPlayerId: "intro-player", volume: 0.5, muteAudio: true });
		expect(await validateCinematic(scene, { path: result.path })).toMatchObject({ valid: false, errors: [{ code: "MISSING_VIDEO_PLAYER" }] });
		scene.metadata = { babylonEditorVideoPlayers: [{ id: "intro-player" }] };
		expect(await validateCinematic(scene, { path: result.path })).toMatchObject({
			valid: true,
			errors: [],
			warnings: [{ code: "VIDEO_PLAYER_PREVIEW_UNAVAILABLE" }],
		});
	});

	test("advertises and maps the complete cinematic MCP endpoint family", () => {
		expect(getCinematicCapabilities()).toMatchObject({
			documentVersion: 2,
			trackTypes: expect.arrayContaining(["video"]),
			clipTypes: expect.arrayContaining(["video"]),
			persistentVideoPlayerBinding: true,
			deterministicVisualCapture: true,
			builtInAudioCapture: true,
			offlineMasterBusAudioCapture: true,
		});
		for (const endpoint of [
			"list_cinematics",
			"get_cinematic_capabilities",
			"inspect_cinematic_audio_capture_plan",
			"get_cinematic",
			"create_cinematic",
			"fork_cinematic",
			"delete_cinematic",
			"replace_cinematic",
			"set_cinematic_settings",
			"create_cinematic_track",
			"set_cinematic_track",
			"move_cinematic_track",
			"delete_cinematic_track",
			"create_cinematic_clip",
			"set_cinematic_clip",
			"delete_cinematic_clip",
			"create_cinematic_key",
			"set_cinematic_key",
			"delete_cinematic_key",
			"create_cinematic_marker",
			"set_cinematic_marker",
			"delete_cinematic_marker",
			"create_cinematic_recorder_profile",
			"set_cinematic_recorder_profile",
			"delete_cinematic_recorder_profile",
			"validate_cinematic",
			"get_cinematic_preview",
			"control_cinematic_preview",
			"play_cinematic",
			"start_cinematic_capture",
			"get_cinematic_capture",
			"cancel_cinematic_capture",
		]) {
			expect(MCPEndpoints[endpoint], endpoint).toBeTypeOf("function");
		}
		const capabilities = getEditorCapabilities(scene, {}, { editor: { state: { projectPath: null, enableExperimentalFeatures: false } } } as any);
		expect(capabilities.features).toMatchObject({
			cinematic: true,
			cinematicTimelineV2: true,
			cinematicExactRevisionAuthoring: true,
			cinematicDeterministicPreview: true,
			cinematicDeterministicVisualCapture: true,
			cinematicBuiltInAudioCapture: true,
			cinematicOfflineMasterBusCapture: true,
		});
	});
});
