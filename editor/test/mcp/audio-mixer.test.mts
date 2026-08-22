import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, NullEngine, Scene, Vector3 } from "babylonjs";

import { SoundNode } from "../../src/editor/nodes/sound";
import {
	assignSoundNodeToAudioBus,
	applyAudioMixerSnapshot,
	clearAudioMixerProfile,
	createAudioBus,
	createAudioEffect,
	createAudioMixerSnapshot,
	createAudioReverbZone,
	createAudioSend,
	deleteAudioSend,
	deleteAudioEffect,
	deleteAudioReverbZone,
	getAudioMixerRuntime,
	getAudioMixerProfile,
	listAudioBuses,
	listAudioMixerSnapshots,
	listAudioReverbZones,
	listAudioRuntimeDiagnostics,
	setAudioBus,
	setAudioMixerProfile,
	setAudioEffect,
	setAudioReverbZone,
	setAudioSend,
} from "../../src/mcp/sounds/sounds";

describe("mcp/audio mixer", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists bus gain and recalls it through a named snapshot", () => {
		const bus = createAudioBus(scene, { name: "Music", gain: 0.6 }, options);
		const snapshot = createAudioMixerSnapshot(scene, { name: "Quiet" }, options);
		setAudioBus(scene, { busId: bus.id, gain: 1, muted: true }, options);
		const applied = applyAudioMixerSnapshot(scene, { id: snapshot.id }, options);

		expect(listAudioBuses(scene).buses).toEqual([expect.objectContaining({ id: bus.id, gain: 0.6, muted: false })]);
		expect(listAudioMixerSnapshots(scene).snapshots).toEqual([
			expect.objectContaining({ id: snapshot.id, name: "Quiet", gains: { [bus.id]: 0.6 }, mutes: { [bus.id]: false } }),
		]);
		expect(applied).toMatchObject({ id: snapshot.id, appliedBusCount: 1 });
	});

	test("assigns a SoundNode exclusively to a bus and restores its base volume when cleared", () => {
		const sound = new SoundNode("Music", scene);
		sound.volume = 0.8;
		const music = createAudioBus(scene, { name: "Music", gain: 0.5, soundNodeIds: [sound.id] }, options);
		const ambience = createAudioBus(scene, { name: "Ambience", gain: 0.25 }, options);

		expect(sound.volume).toBeCloseTo(0.4);
		expect(assignSoundNodeToAudioBus(scene, { nodeId: sound.id, busId: ambience.id }, options)).toEqual({ nodeId: sound.id, busId: ambience.id });
		expect(listAudioBuses(scene).buses).toEqual([
			expect.objectContaining({ id: music.id, soundNodeIds: [] }),
			expect.objectContaining({ id: ambience.id, soundNodeIds: [sound.id] }),
		]);
		expect(sound.volume).toBeCloseTo(0.2);
		assignSoundNodeToAudioBus(scene, { nodeId: sound.id, busId: null }, options);
		expect(sound.volume).toBeCloseTo(0.8);
	});

	test("reports actual playback, effective mixer volume, and missing bus assignments", () => {
		const music = new SoundNode("Music", scene);
		music.volume = 0.8;
		music.soundRelativePath = "assets/music.ogg";
		music.sound = { isPlaying: true, state: "started", dispose: vi.fn() } as any;
		const bus = createAudioBus(scene, { name: "Music", gain: 0.5, soundNodeIds: [music.id] }, options);
		(scene.metadata as any).babylonEditorAudioBuses[0].soundNodeIds.push("missing-node");

		const diagnostics = listAudioRuntimeDiagnostics(scene);
		expect(diagnostics.summary).toMatchObject({ soundCount: 1, loadedCount: 1, playingCount: 1, busCount: 1 });
		expect(diagnostics.sounds[0]).toMatchObject({
			nodeId: music.id,
			loaded: true,
			isPlaying: true,
			baseVolume: 0.8,
			effectiveVolume: 0.4,
			bus: { id: bus.id, name: "Music" },
		});
		expect(diagnostics.missingBusSoundNodeIds).toEqual(["missing-node"]);
	});

	test("authors hierarchical Master routing with inherited gain and pitch", () => {
		const sound = new SoundNode("Combat Music", scene);
		sound.volume = 0.8;
		(sound as any).playbackRate = 1;
		const music = createAudioBus(scene, { name: "Music", gain: 0.5, pitch: 0.5 }, options);
		const combat = createAudioBus(scene, { name: "Combat", gain: 0.5, pitch: 2, parentBusId: music.id, soundNodeIds: [sound.id] }, options);

		const runtime = getAudioMixerRuntime(scene);
		expect(runtime.buses.find((bus: any) => bus.id === combat.id)).toMatchObject({
			path: "Master/Music/Combat",
			depth: 2,
			effectiveGain: 0.25,
			effectivePitch: 1,
		});
		expect(sound.volume).toBeCloseTo(0.2);
	});

	test("rejects routing cycles atomically and blends snapshot gain and pitch", () => {
		const music = createAudioBus(scene, { name: "Music", gain: 1, pitch: 1 }, options);
		const combat = createAudioBus(scene, { name: "Combat", parentBusId: music.id }, options);
		expect(() => setAudioBus(scene, { busId: music.id, parentBusId: combat.id }, options)).toThrow(/routing cycle/i);
		expect(listAudioBuses(scene).buses.find((bus: any) => bus.id === music.id)?.parentBusId).toBeNull();

		const snapshot = createAudioMixerSnapshot(scene, { name: "Default" }, options);
		setAudioBus(scene, { busId: music.id, gain: 0.25, pitch: 2 }, options);
		const result = applyAudioMixerSnapshot(scene, { id: snapshot.id, durationSeconds: 1, shape: "linear" }, options);
		expect(result.transition).toMatchObject({ snapshotId: snapshot.id });
		expect(result.transition.progress).toBeLessThan(0.01);
		(scene as any).audioMixer.update(0.5);
		const blendedMusic = listAudioBuses(scene).buses.find((bus: any) => bus.id === music.id)!;
		expect(blendedMusic.gain).toBeCloseTo(0.625, 3);
		expect(blendedMusic.pitch).toBeCloseTo(1.5, 3);
		const progress = getAudioMixerRuntime(scene).transition.progress;
		expect(progress).toBeGreaterThanOrEqual(0.5);
		expect(progress).toBeLessThan(0.51);
	});

	test("authors sidechain ducking, reports runtime envelope evidence, and deletes it", () => {
		const voice = new SoundNode("Voice", scene);
		voice.volume = 1;
		voice.sound = { isPlaying: true, state: "started", dispose: vi.fn() } as any;
		const musicSound = new SoundNode("Music", scene);
		musicSound.volume = 1;
		const voiceBus = createAudioBus(scene, { name: "Voice", soundNodeIds: [voice.id] }, options);
		const musicBus = createAudioBus(scene, { name: "Music", soundNodeIds: [musicSound.id] }, options);
		const send = createAudioSend(
			scene,
			{
				sourceBusId: voiceBus.id,
				targetBusId: musicBus.id,
				name: "Duck Music",
				kind: "sidechain",
				ducking: { threshold: 0.1, ratio: 4, attackSeconds: 0, releaseSeconds: 0.5, maxReductionDb: 20 },
			},
			options
		);

		(scene as any).audioMixer.update(0.1);
		const runtime = getAudioMixerRuntime(scene);
		expect(runtime.buses.find((bus: any) => bus.id === voiceBus.id).sends[0]).toMatchObject({ id: send.id, kind: "sidechain", signalLevel: 1 });
		expect(runtime.buses.find((bus: any) => bus.id === musicBus.id).duckGain).toBeLessThan(0.2);
		expect(musicSound.volume).toBeLessThan(0.2);

		expect(deleteAudioSend(scene, { sourceBusId: voiceBus.id, sendId: send.id }, options)).toMatchObject({ deleted: true, id: send.id });
		expect(listAudioBuses(scene).buses.find((bus: any) => bus.id === voiceBus.id).sends).toEqual([]);
	});

	test("rejects return feedback atomically and snapshots send levels", () => {
		const music = createAudioBus(scene, { name: "Music" }, options);
		const child = createAudioBus(scene, { name: "Child", parentBusId: music.id }, options);
		expect(() => createAudioSend(scene, { sourceBusId: music.id, targetBusId: child.id, name: "Feedback", kind: "return" }, options)).toThrow(/return-routing cycle/i);
		expect(listAudioBuses(scene).buses.find((bus: any) => bus.id === music.id).sends).toEqual([]);

		const returnBus = createAudioBus(scene, { name: "Return" }, options);
		const send = createAudioSend(scene, { sourceBusId: music.id, targetBusId: returnBus.id, name: "Verb", kind: "return", gain: 0.75 }, options);
		const snapshot = createAudioMixerSnapshot(scene, { name: "Wet" }, options);
		expect(snapshot.sendGains).toEqual({ [send.id]: 0.75 });
		setAudioSend(scene, { sourceBusId: music.id, sendId: send.id, gain: 0.25 }, options);
		const applied = applyAudioMixerSnapshot(scene, { id: snapshot.id, durationSeconds: 1 }, options);
		expect(applied.transition).toMatchObject({ elapsedSeconds: 0, progress: 0 });
		(scene as any).audioMixer.update(0.5);
		expect(listAudioBuses(scene).buses.find((bus: any) => bus.id === music.id).sends[0].gain).toBeCloseTo(0.5, 3);
	});

	test("creates, retunes, bypasses, reorders, and deletes ordered DSP effects", () => {
		const bus = createAudioBus(scene, { name: "Music" }, options);
		const filter = createAudioEffect(scene, { busId: bus.id, name: "Low Pass", type: "lowpass", parameters: { frequency: 8000 } }, options);
		const compressor = createAudioEffect(scene, { busId: bus.id, name: "Compressor", type: "compressor" }, options);
		expect(getAudioMixerRuntime(scene).buses[0].effects).toEqual([
			expect.objectContaining({ id: filter.id, index: 0, type: "lowpass", parameters: { frequency: 8000, q: 0.707 } }),
			expect.objectContaining({ id: compressor.id, index: 1, type: "compressor" }),
		]);

		setAudioEffect(scene, { busId: bus.id, effectId: compressor.id, index: 0, enabled: false, wet: 0.5, parameters: { ratio: 6 } }, options);
		const effects = listAudioBuses(scene).buses[0].effects;
		expect(effects[0]).toMatchObject({ id: compressor.id, enabled: false, wet: 0.5, parameters: { ratio: 6 } });
		expect(() => setAudioEffect(scene, { busId: bus.id, effectId: filter.id, parameters: { frequency: 0 } }, options)).toThrow(/frequency.*between 20 and 20000/i);
		expect(listAudioBuses(scene).buses[0].effects[1].parameters.frequency).toBe(8000);
		expect(deleteAudioEffect(scene, { busId: bus.id, effectId: filter.id }, options)).toMatchObject({ deleted: true, id: filter.id });
		expect(listAudioBuses(scene).buses[0].effects).toHaveLength(1);
	});

	test("captures and continuously recalls DSP wet mix and numeric parameters", () => {
		const bus = createAudioBus(scene, { name: "Music" }, options);
		const effect = createAudioEffect(scene, { busId: bus.id, name: "Underwater", type: "lowpass", wet: 0.5, parameters: { frequency: 1000, q: 2 } }, options);
		const snapshot = createAudioMixerSnapshot(scene, { name: "Underwater" }, options);
		expect(snapshot).toMatchObject({
			effectWets: { [effect.id]: 0.5 },
			effectEnabled: { [effect.id]: true },
			effectParameters: { [effect.id]: { frequency: 1000, q: 2 } },
		});
		setAudioEffect(scene, { busId: bus.id, effectId: effect.id, wet: 1, parameters: { frequency: 12000, q: 1 } }, options);
		applyAudioMixerSnapshot(scene, { id: snapshot.id, durationSeconds: 1 }, options);
		(scene as any).audioMixer.update(0.5);
		const blended = listAudioBuses(scene).buses[0].effects[0];
		expect(blended.wet).toBeCloseTo(0.75, 3);
		expect(blended.parameters.frequency).toBeCloseTo(6500, 0);
	});

	test("authors sphere and box reverb zones with live listener blending", () => {
		const camera = new FreeCamera("Listener", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		const bus = createAudioBus(scene, { name: "Environment" }, options);
		const effect = createAudioEffect(
			scene,
			{ busId: bus.id, name: "Cave Reverb", type: "convolutionReverb", wet: 0.6, parameters: { decaySeconds: 2, preDelaySeconds: 0.02, dampingHz: 6000 } },
			options
		);
		const zone = createAudioReverbZone(
			scene,
			{ name: "Cave", effectId: effect.id, shape: "sphere", position: [0, 0, 0], innerRadius: 100, outerRadius: 300, priority: 5 },
			options
		);
		expect(listAudioReverbZones(scene).runtime[0]).toMatchObject({ id: zone.id, active: true, weight: 1, targetBusId: bus.id });

		camera.position.x = 200;
		const halfway = getAudioMixerRuntime(scene).reverbZones[0];
		expect(halfway.weight).toBeCloseTo(0.5);
		setAudioReverbZone(scene, { id: zone.id, shape: "box", size: [100, 100, 100], blendDistance: 100 }, options);
		expect(getAudioMixerRuntime(scene).reverbZones[0]).toMatchObject({ shape: "box", weight: 0 });
		camera.position.x = 75;
		expect(getAudioMixerRuntime(scene).reverbZones[0].weight).toBeCloseTo(0.75);
		expect(deleteAudioReverbZone(scene, { id: zone.id }, options)).toMatchObject({ deleted: true, id: zone.id });
		expect(listAudioReverbZones(scene).zones).toEqual([]);
	});

	test("rejects non-reverb targets atomically and cascades zones with effect deletion", () => {
		const bus = createAudioBus(scene, { name: "Environment" }, options);
		const filter = createAudioEffect(scene, { busId: bus.id, name: "Filter", type: "lowpass" }, options);
		expect(() => createAudioReverbZone(scene, { name: "Rejected", effectId: filter.id }, options)).toThrow(/must target.*convolutionReverb/i);
		expect(listAudioReverbZones(scene).zones).toEqual([]);
		const reverb = createAudioEffect(scene, { busId: bus.id, name: "Reverb", type: "convolutionReverb" }, options);
		const zone = createAudioReverbZone(scene, { name: "Room", effectId: reverb.id }, options);
		expect(deleteAudioEffect(scene, { busId: bus.id, effectId: reverb.id }, options)).toMatchObject({ removedReverbZoneIds: [zone.id] });
		expect(listAudioReverbZones(scene).zones).toEqual([]);
	});

	test("controls and reads bounded Audio Mixer CPU, voice, signal, clipping, and bus profile evidence", () => {
		const sound = new SoundNode("Loud Dialogue", scene);
		sound.volume = 1.25;
		sound.isSpatial = true;
		(sound as any).streaming = true;
		sound.sound = { isPlaying: true, state: "started", dispose: vi.fn() } as any;
		const bus = createAudioBus(scene, { name: "Dialogue", soundNodeIds: [sound.id] }, options);
		const started = setAudioMixerProfile(scene, { enabled: true, sampleCapacity: 2, sampleEveryNUpdates: 1 }, options);
		expect(started).toMatchObject({ settings: { enabled: true, sampleCapacity: 2, sampleEveryNUpdates: 1 } });
		for (let index = 0; index < 3; index++) {
			(scene as any).audioMixer.update(1 / 60);
		}

		const profile = getAudioMixerProfile(scene, { busId: bus.id, includeSamples: true, sampleLimit: 1 });
		expect(profile).toMatchObject({
			updateCount: 3,
			capturedSampleCount: 3,
			retainedSampleCount: 2,
			droppedSampleCount: 1,
			pagination: { total: 2, count: 1, hasMore: true, nextOffset: 1 },
		});
		expect(profile.summary).toMatchObject({ sampleCount: 3, maximumVoiceCount: 1, maximumPlayingVoiceCount: 1, maximumEstimatedPeakLevel: 1.25, clippedSampleCount: 3 });
		expect(profile.samples[0]).toMatchObject({
			voiceCount: 1,
			playingVoiceCount: 1,
			spatialVoiceCount: 1,
			streamingVoiceCount: 1,
			estimatedPeakLevel: 1.25,
			estimatedClippedBusCount: 1,
			buses: [expect.objectContaining({ busId: bus.id, estimatedClipping: true, playingVoiceCount: 1 })],
		});
		expect(profile.busSummaries[0]).toMatchObject({ busId: bus.id, sampleCount: 3, clippedSampleCount: 3 });
		const cleared = clearAudioMixerProfile(scene, {}, options);
		expect(cleared).toMatchObject({ settings: { enabled: true, sampleCapacity: 2, sampleEveryNUpdates: 1 }, updateCount: 0, retainedSampleCount: 0 });
	});

	test("rejects empty Audio Mixer profile configuration and unknown bus filters", () => {
		expect(() => setAudioMixerProfile(scene, {}, options)).toThrow(/Provide enabled, sampleCapacity, or sampleEveryNUpdates/);
		expect(() => getAudioMixerProfile(scene, { busId: "missing" })).toThrow(/bus.*was not found/i);
	});
});
