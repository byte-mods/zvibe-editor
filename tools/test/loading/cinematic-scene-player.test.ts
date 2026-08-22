import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { afterEach, describe, expect, test, vi } from "vitest";

import { CinematicScenePlayer, createCinematicDocument, normalizeCinematicDocument } from "../../src";

function trackBase(id: string, type: string, order: number) {
	return { id, name: id, type, order, parentId: null, muted: false, solo: false, locked: false, color: "#334455" };
}

function clipBase(id: string, type: string) {
	return {
		id,
		type,
		name: id,
		startFrame: 0,
		durationFrames: 10,
		clipInFrame: 0,
		timeScale: 1,
		enabled: true,
		blendInFrames: 0,
		blendOutFrames: 0,
		easeIn: "linear",
		easeOut: "linear",
		preExtrapolation: "none",
		postExtrapolation: "none",
	};
}

const resources: { scene: Scene; engine: NullEngine }[] = [];

function scene(): { scene: Scene; engine: NullEngine } {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	resources.push({ scene, engine });
	return { scene, engine };
}

afterEach(() => {
	for (const resource of resources.splice(0)) {
		resource.scene.dispose();
		resource.engine.dispose();
	}
});

describe("cinematic Babylon scene player", () => {
	test("applies typed tracks, dispatches lifecycle callbacks, and restores preview state", () => {
		const { scene: value } = scene();
		const hero = new TransformNode("Hero", value);
		hero.id = "hero";
		const shot = new FreeCamera("Shot", new Vector3(10, 0, 0), value);
		shot.id = "shot-camera";
		const original = new FreeCamera("Original", Vector3.Zero(), value);
		value.activeCamera = original;

		const document = normalizeCinematicDocument({
			...createCinematicDocument("Scene", "scene"),
			framesPerSecond: 10,
			outputFramesPerSecond: 10,
			durationMode: "fixed",
			durationFrames: 10,
			recorderProfiles: [{ id: "capture", name: "Capture", format: "webm", width: 1280, height: 720, framesPerSecond: 30, quality: 1, includeAudio: false }],
			tracks: [
				{
					...trackBase("property", "property", 0),
					type: "property",
					targetType: "node",
					targetId: "hero",
					propertyPath: "position.x",
					keys: [
						{ id: "p0", type: "key", frame: 0, value: 0, interpolation: "linear" },
						{ id: "p1", type: "key", frame: 10, value: 10, interpolation: "linear" },
					],
				},
				{
					...trackBase("activation", "activation", 1),
					type: "activation",
					clips: [{ ...clipBase("disable", "activation"), type: "activation", nodeId: "hero", active: false }],
				},
				{ ...trackBase("camera", "camera", 2), type: "camera", clips: [{ ...clipBase("shot", "camera"), type: "camera", cameraId: "shot-camera", blendMode: "cut" }] },
				{
					...trackBase("control", "control", 3),
					type: "control",
					clips: [{ ...clipBase("child", "control"), type: "control", targetType: "cinematic", targetId: "assets/child.cinematic", action: "play" }],
				},
				{ ...trackBase("recorder", "recorder", 4), type: "recorder", clips: [{ ...clipBase("record", "recorder"), type: "recorder", profileId: "capture" }] },
				{
					...trackBase("signal", "signal", 5),
					type: "signal",
					markers: [{ id: "ready", name: "Ready", type: "signal", frame: 3, emitOnce: false, retroactive: true, payload: null }],
				},
			],
		});
		const controls: boolean[] = [];
		const recorders: boolean[] = [];
		const signals: string[] = [];
		const player = new CinematicScenePlayer(document, value, {
			ignoreSounds: true,
			onControl: (_sample, entering) => controls.push(entering),
			onRecorder: (_sample, entering) => recorders.push(entering),
			onSignal: (occurrence) => signals.push(occurrence.marker.id),
		});

		expect(player.seek(5, true).map((occurrence) => occurrence.marker.id)).toEqual(["ready"]);
		expect(hero.position.x).toBe(5);
		expect(hero.isEnabled()).toBe(false);
		expect(value.activeCamera).toBe(shot);
		expect(controls).toEqual([true]);
		expect(recorders).toEqual([true]);
		expect(signals).toEqual(["ready"]);

		player.seek(10);
		expect(hero.position.x).toBe(10);
		expect(hero.isEnabled()).toBe(true);
		expect(value.activeCamera).toBe(original);
		expect(controls).toEqual([true, false]);
		expect(recorders).toEqual([true, false]);

		player.stop();
		expect(hero.position.x).toBe(0);
		expect(hero.isEnabled()).toBe(true);
		expect(value.activeCamera).toBe(original);
		player.dispose();
		expect(() => player.apply()).toThrow("disposed");
	});

	test("blends overlapping camera clips through an isolated temporary camera", () => {
		const { scene: value } = scene();
		const left = new FreeCamera("Left", Vector3.Zero(), value);
		left.id = "left";
		const right = new FreeCamera("Right", new Vector3(10, 0, 0), value);
		right.id = "right";
		value.activeCamera = left;
		const document = normalizeCinematicDocument({
			...createCinematicDocument("Blend", "blend"),
			durationMode: "fixed",
			durationFrames: 10,
			tracks: [
				{
					...trackBase("camera", "camera", 0),
					type: "camera",
					clips: [
						{ ...clipBase("left-shot", "camera"), type: "camera", cameraId: "left", blendMode: "crossFade", blendOutFrames: 10 },
						{ ...clipBase("right-shot", "camera"), type: "camera", cameraId: "right", blendMode: "crossFade", blendInFrames: 10 },
					],
				},
			],
		});
		const player = new CinematicScenePlayer(document, value, { ignoreSounds: true });
		player.seek(5);
		expect(value.activeCamera?.name).toBe("__zvibeCinematicBlendCamera");
		expect(value.activeCamera?.globalPosition.x).toBeCloseTo(5);
		const competing = new CinematicScenePlayer(document, value, { ignoreSounds: true });
		expect(() => competing.seek(5)).toThrow("already controlled");
		player.dispose();
		expect(value.activeCamera).toBe(left);
		expect(() => competing.seek(5)).not.toThrow();
		competing.dispose();
	});

	test("drives a persistent Video Player from Timeline time and restores its standalone state", () => {
		const { scene: value } = scene();
		const video: any = { currentTime: 2, duration: 20, paused: true, loop: true, muted: false, volume: 0.8, playbackRate: 1 };
		video.pause = vi.fn(() => (video.paused = true));
		video.play = vi.fn(async () => {
			video.paused = false;
		});
		const updateTexture = vi.fn();
		const runtime: any = {
			configuration: { id: "intro-player", volume: 0.8, alpha: 0.75, playbackSpeed: 1, muted: false, audioOutputMode: "direct" },
			texture: { video, level: 0.75, updateTexture },
			manualTime: 2,
			manualPlaying: false,
			status: "ready",
			error: null,
		};
		(value as any).videoPlayerRuntimes = new Map([["intro-player", runtime]]);
		const document = normalizeCinematicDocument({
			...createCinematicDocument("Video", "video"),
			framesPerSecond: 10,
			outputFramesPerSecond: 10,
			durationMode: "fixed",
			durationFrames: 10,
			tracks: [
				{
					...trackBase("video", "video", 0),
					type: "video",
					clips: [{ ...clipBase("intro", "video"), type: "video", videoPlayerId: "intro-player", volume: 0.5, loop: false, muteAudio: true }],
				},
			],
		});
		const player = new CinematicScenePlayer(document, value, { ignoreSounds: true });
		player.seek(5);
		expect(video.currentTime).toBe(0.5);
		expect(video.loop).toBe(false);
		expect(video.muted).toBe(true);
		expect(video.volume).toBeCloseTo(0.4);
		expect(runtime.texture.level).toBeCloseTo(0.75);
		expect(runtime.manualPlaying).toBe(false);
		expect(updateTexture).toHaveBeenCalledWith(true);

		player.play();
		player.advance(0.1);
		expect(video.play).toHaveBeenCalledTimes(1);
		expect(runtime.status).toBe("playing");

		player.seek(10);
		expect(video.currentTime).toBe(2);
		expect(video.loop).toBe(true);
		expect(video.muted).toBe(false);
		expect(video.volume).toBe(0.8);
		expect(runtime.texture.level).toBe(0.75);
		expect(runtime.manualTime).toBe(2);
		expect(runtime.status).toBe("ready");
		player.dispose();
	});
});
