import { NullEngine, Scene, TransformNode } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import { createCinematicCapturePlan, createCinematicDocument, normalizeCinematicDocument } from "babylonjs-editor-tools";

import { encodeCinematicAudioWav, inspectCinematicAudioCapture } from "../../src/editor/layout/cinematic/v2/audio-capture";

const resources: { scene: Scene; engine: NullEngine }[] = [];
const previousOfflineAudioContext = globalThis.OfflineAudioContext;

function document(format: "webm" | "png" = "webm") {
	return normalizeCinematicDocument({
		...createCinematicDocument("Audio Capture", "audio-capture"),
		framesPerSecond: 30,
		durationMode: "fixed",
		durationFrames: 30,
		recorderProfiles: [{ id: "output", name: "Output", format, width: 320, height: 180, framesPerSecond: 30, quality: 1, includeAudio: true }],
		tracks: [
			{
				id: "audio",
				name: "Voice",
				type: "audio",
				order: 0,
				parentId: null,
				muted: false,
				solo: false,
				locked: false,
				color: "#445566",
				volumeKeys: [],
				clips: [
					{
						id: "voice-clip",
						name: "Voice",
						type: "audio",
						startFrame: 0,
						durationFrames: 30,
						clipInFrame: 0,
						timeScale: 1,
						enabled: true,
						blendInFrames: 0,
						blendOutFrames: 0,
						easeIn: "linear",
						easeOut: "linear",
						preExtrapolation: "none",
						postExtrapolation: "none",
						soundId: "voice",
						volume: 0.75,
						loop: false,
					},
				],
			},
		],
	});
}

function setup(): Scene {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	resources.push({ scene, engine });
	const voice = new TransformNode("Voice", scene) as TransformNode & { sound: { buffer: { _audioBuffer: AudioBuffer } } };
	voice.id = "voice";
	voice.sound = {
		buffer: {
			_audioBuffer: {
				duration: 1,
				numberOfChannels: 1,
				sampleRate: 48_000,
				length: 48_000,
				getChannelData: () => new Float32Array(48_000),
			} as unknown as AudioBuffer,
		},
	};
	scene.metadata = {
		babylonEditorAudioBuses: [
			{
				id: "dialogue",
				name: "Dialogue",
				gain: 0.8,
				pitch: 1,
				muted: false,
				solo: false,
				parentBusId: null,
				soundNodeIds: ["voice"],
				sends: [],
				effects: [{ id: "dialogue-gain", name: "Dialogue Gain", type: "gain", enabled: true, wet: 1, parameters: { volumeDb: -3 } }],
			},
		],
		babylonEditorAudioMixerSnapshots: [],
	};
	return scene;
}

afterEach(() => {
	Object.defineProperty(globalThis, "OfflineAudioContext", { configurable: true, writable: true, value: previousOfflineAudioContext });
	for (const resource of resources.splice(0)) {
		resource.scene.dispose();
		resource.engine.dispose();
	}
});

describe("cinematic offline master audio capture", () => {
	test("preflights exact SoundNode routes, mixer DSP, codec, and image-sequence boundary", () => {
		Object.defineProperty(globalThis, "OfflineAudioContext", { configurable: true, writable: true, value: class {} });
		const scene = setup();
		const webm = document();
		const inspection = inspectCinematicAudioCapture(webm, scene, createCinematicCapturePlan(webm, "output"));
		expect(scene.audioMixer).toBeUndefined();
		expect(inspection).toMatchObject({
			ready: true,
			mode: "offline-master-bus",
			sampleRate: 48_000,
			channelCount: 2,
			container: "webm",
			audioCodec: "opus",
			mixer: { busCount: 1, effectCount: 1, returnSendCount: 0, sidechainMode: "captured-runtime-duck-gain" },
			sources: [{ clipId: "voice-clip", soundId: "voice", busId: "dialogue", busPath: "Master/Dialogue", loaded: true }],
			issues: [],
		});

		const images = document("png");
		expect(inspectCinematicAudioCapture(images, scene, createCinematicCapturePlan(images, "output"))).toMatchObject({
			ready: false,
			container: null,
			audioCodec: null,
			issues: [{ code: "AUDIO_CONTAINER_UNSUPPORTED" }],
		});
	});

	test("encodes interleaved little-endian stereo PCM WAV", () => {
		const left = new Float32Array([-1, 0.5]);
		const right = new Float32Array([1, -0.5]);
		const wav = encodeCinematicAudioWav({
			numberOfChannels: 2,
			length: 2,
			sampleRate: 48_000,
			getChannelData: (channel: number) => (channel === 0 ? left : right),
		} as AudioBuffer);
		expect(wav.subarray(0, 12).toString("ascii")).toBe("RIFF,\u0000\u0000\u0000WAVE");
		expect(wav.readUInt16LE(22)).toBe(2);
		expect(wav.readUInt32LE(24)).toBe(48_000);
		expect(wav.readUInt32LE(40)).toBe(8);
		expect([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48), wav.readInt16LE(50)]).toEqual([-32768, 32767, 16384, -16384]);
	});
});
