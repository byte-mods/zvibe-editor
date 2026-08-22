import { describe, expect, test } from "vitest";

import { AudioMixer, IAudioMixerBus, validateAudioMixerConfiguration, validateAudioReverbZones } from "../../src/loading/audio-mixer";

describe("loading/audio mixer", () => {
	test("applies exported bus gains and recalls snapshots", () => {
		const sound = { volume: 1, metadata: {} as any };
		const scene = { getNodeById: (id: string) => (id === "sound" ? sound : null) } as any;
		const mixer = new AudioMixer(
			scene,
			[{ id: "music", name: "Music", gain: 0.5, soundNodeIds: ["sound"] }],
			[{ id: "quiet", name: "Quiet", gains: { music: 0.25 }, mutes: { music: true } }]
		);

		mixer.apply();
		expect(sound.volume).toBe(0.5);
		expect(mixer.applySnapshot("quiet")).toBe(true);
		expect(sound.volume).toBe(0);
	});

	test("mutes non-solo buses while any exported mixer bus is soloed", () => {
		const music = { volume: 1, metadata: {} as any };
		const ambience = { volume: 1, metadata: {} as any };
		const scene = { getNodeById: (id: string) => (id === "music" ? music : id === "ambience" ? ambience : null) } as any;
		const mixer = new AudioMixer(
			scene,
			[
				{ id: "music", name: "Music", gain: 0.5, solo: true, soundNodeIds: ["music"] },
				{ id: "ambience", name: "Ambience", gain: 0.5, soundNodeIds: ["ambience"] },
			],
			[]
		);

		mixer.apply();
		expect(music.volume).toBe(0.5);
		expect(ambience.volume).toBe(0);
	});

	test("resolves Master hierarchy paths and inherited gain and pitch", () => {
		const sound = { id: "sound", volume: 1, playbackRate: 1, metadata: {} as any };
		const scene = { getNodeById: (id: string) => (id === sound.id ? sound : null), transformNodes: [sound] } as any;
		const mixer = new AudioMixer(
			scene,
			[
				{ id: "music", name: "Music", gain: 0.5, pitch: 0.5, soundNodeIds: [] },
				{ id: "combat", name: "Combat", gain: 0.5, pitch: 2, parentBusId: "music", soundNodeIds: [sound.id] },
			],
			[]
		);

		mixer.apply();
		const runtime = mixer.getRuntimeState();
		expect(runtime.buses[1]).toMatchObject({ path: "Master/Music/Combat", depth: 2, effectiveGain: 0.25, effectivePitch: 1, audible: true });
		expect(sound.volume).toBe(0.25);
		expect(sound.playbackRate).toBe(1);
	});

	test("blends snapshot gain and pitch while deferring discrete mute state", () => {
		const bus = { id: "music", name: "Music", gain: 1, pitch: 1, muted: false, soundNodeIds: [] };
		const scene = { getNodeById: () => null, transformNodes: [] } as any;
		const mixer = new AudioMixer(scene, [bus], [{ id: "quiet", name: "Quiet", gains: { music: 0.25 }, pitches: { music: 2 }, mutes: { music: true } }]);

		expect(mixer.applySnapshot("quiet", 1, "linear")).toBe(true);
		mixer.update(0.5);
		expect(bus).toMatchObject({ gain: 0.625, pitch: 1.5, muted: false });
		expect(mixer.getRuntimeState().transition).toMatchObject({ snapshotId: "quiet", progress: 0.5 });

		mixer.update(0.5);
		expect(bus).toMatchObject({ gain: 0.25, pitch: 2, muted: true });
		expect(mixer.getRuntimeState().transition).toBeNull();
	});

	test("routes bounded returns without allowing an audible feedback cycle", () => {
		const buses = [
			{ id: "music", name: "Music", gain: 1, soundNodeIds: [], sends: [{ id: "send", name: "Verb", targetBusId: "fx", kind: "return" as const, gain: 0.5 }] },
			{ id: "fx", name: "FX", gain: 1, parentBusId: "music", soundNodeIds: [] },
		];
		expect(validateAudioMixerConfiguration(buses)).toContain('Audio bus "Music" creates an audible return-routing cycle.');
		buses[1].parentBusId = undefined;
		expect(validateAudioMixerConfiguration(buses)).toEqual([]);
	});

	test("applies sidechain threshold, ratio, attack, and release to the target hierarchy", () => {
		const source = { id: "voice", volume: 1, metadata: {} as any, isPlaying: () => true };
		const target = { id: "music-sound", volume: 1, metadata: {} as any };
		const scene = { getNodeById: (id: string) => (id === source.id ? source : id === target.id ? target : null), transformNodes: [source, target] } as any;
		const mixer = new AudioMixer(
			scene,
			[
				{
					id: "voice-bus",
					name: "Voice",
					gain: 1,
					soundNodeIds: [source.id],
					sends: [
						{
							id: "duck",
							name: "Duck Music",
							targetBusId: "music",
							kind: "sidechain",
							gain: 1,
							ducking: { threshold: 0.1, ratio: 4, attackSeconds: 0, releaseSeconds: 0.5, maxReductionDb: 20 },
						},
					],
				},
				{ id: "music", name: "Music", gain: 1, soundNodeIds: [target.id] },
			],
			[]
		);

		mixer.update(0.1);
		const ducked = mixer.getRuntimeState();
		expect(ducked.buses[0].sends[0]).toMatchObject({ kind: "sidechain", signalLevel: 1, duckGain: expect.any(Number) });
		expect(ducked.buses[1].duckGain).toBeCloseTo(10 ** (-15 / 20));
		expect(target.volume).toBeCloseTo(10 ** (-15 / 20));

		source.isPlaying = () => false;
		mixer.update(0.5);
		expect(mixer.getRuntimeState().buses[1].duckGain).toBeGreaterThan(10 ** (-15 / 20));
	});

	test("blends persisted send levels with mixer snapshots", () => {
		const bus: IAudioMixerBus = {
			id: "music",
			name: "Music",
			gain: 1,
			soundNodeIds: [],
			sends: [{ id: "verb", name: "Verb", targetBusId: "return", kind: "return" as const, gain: 1 }],
		};
		const returnBus = { id: "return", name: "Return", gain: 1, soundNodeIds: [] };
		const mixer = new AudioMixer({ getNodeById: () => null, transformNodes: [] } as any, [bus, returnBus], [{ id: "dry", name: "Dry", gains: {}, sendGains: { verb: 0.25 } }]);
		expect(mixer.applySnapshot("dry", 1)).toBe(true);
		mixer.update(0.5);
		expect(bus.sends![0].gain).toBeCloseTo(0.625);
	});

	test("validates ordered DSP chains and exact type parameters", () => {
		const bus: IAudioMixerBus = {
			id: "music",
			name: "Music",
			gain: 1,
			soundNodeIds: [],
			effects: [
				{ id: "filter", name: "Low Pass", type: "lowpass" as const, wet: 1, parameters: { frequency: 8000, q: 0.7 } },
				{
					id: "compressor",
					name: "Compressor",
					type: "compressor" as const,
					wet: 1,
					parameters: { thresholdDb: -20, kneeDb: 20, ratio: 4, attackSeconds: 0.01, releaseSeconds: 0.2 },
				},
			],
		};
		expect(validateAudioMixerConfiguration([bus])).toEqual([]);
		bus.effects![0].parameters = { frequency: 8000, q: 0.7, unknown: 1 } as any;
		expect(validateAudioMixerConfiguration([bus])).toContain('Audio effect "Low Pass" contains unknown parameter "unknown".');
	});

	test("blends numeric DSP snapshot values and defers bypass state", () => {
		const effect = { id: "filter", name: "Low Pass", type: "lowpass" as const, enabled: true, wet: 1, parameters: { frequency: 12000, q: 1 } };
		const bus = { id: "music", name: "Music", gain: 1, soundNodeIds: [], effects: [effect] };
		const mixer = new AudioMixer(
			{ getNodeById: () => null, transformNodes: [] } as any,
			[bus],
			[
				{
					id: "underwater",
					name: "Underwater",
					gains: {},
					effectWets: { filter: 0.5 },
					effectEnabled: { filter: false },
					effectParameters: { filter: { frequency: 1000, q: 2 } },
				},
			]
		);
		expect(mixer.applySnapshot("underwater", 1)).toBe(true);
		mixer.update(0.5);
		expect(effect.wet).toBeCloseTo(0.75);
		expect(effect.parameters).toMatchObject({ frequency: 6500, q: 1.5 });
		expect(effect.enabled).toBe(true);
		mixer.update(0.5);
		expect(effect).toMatchObject({ enabled: false, wet: 0.5, parameters: { frequency: 1000, q: 2 } });
	});

	test("validates reverb-zone geometry and exact convolution targets", () => {
		const buses: IAudioMixerBus[] = [
			{
				id: "environment",
				name: "Environment",
				gain: 1,
				soundNodeIds: [],
				effects: [
					{
						id: "reverb",
						name: "Cave Reverb",
						type: "convolutionReverb",
						parameters: { decaySeconds: 2, preDelaySeconds: 0.02, dampingHz: 6000 },
					},
				],
			},
		];
		const zones = [
			{ id: "cave", name: "Cave", effectId: "reverb", shape: "sphere" as const, position: [0, 0, 0] as [number, number, number], innerRadius: 100, outerRadius: 500 },
		];
		expect(validateAudioReverbZones(buses, zones)).toEqual([]);
		zones[0].innerRadius = 600;
		expect(validateAudioReverbZones(buses, zones)).toContain('Audio reverb zone "Cave" requires 0 <= innerRadius <= outerRadius <= 100000000 cm.');
	});

	test("evaluates listener distance, sphere blending, and overlap priority", () => {
		const camera = { position: { x: 0, y: 0, z: 0 } };
		const scene = {
			activeCamera: camera,
			metadata: {
				babylonEditorAudioReverbZones: [
					{ id: "low", name: "Low", effectId: "reverb", shape: "sphere", position: [0, 0, 0], innerRadius: 100, outerRadius: 300, priority: 0 },
					{ id: "high", name: "High", effectId: "reverb", shape: "sphere", position: [0, 0, 0], innerRadius: 0, outerRadius: 400, priority: 10 },
				],
			},
			getNodeById: () => null,
			transformNodes: [],
		} as any;
		const mixer = new AudioMixer(
			scene,
			[
				{
					id: "environment",
					name: "Environment",
					gain: 1,
					soundNodeIds: [],
					effects: [
						{
							id: "reverb",
							name: "Reverb",
							type: "convolutionReverb",
							wet: 0.5,
							parameters: { decaySeconds: 2, preDelaySeconds: 0.02, dampingHz: 6000 },
						},
					],
				},
			],
			[]
		);
		let runtime = mixer.getRuntimeState();
		expect(runtime.reverbZones.find((zone) => zone.id === "high")).toMatchObject({ active: true, weight: 1 });
		expect(runtime.reverbZones.find((zone) => zone.id === "low")?.active).toBe(false);
		camera.position.x = 200;
		mixer.apply();
		runtime = mixer.getRuntimeState();
		expect(runtime.listenerPosition).toEqual([200, 0, 0]);
		expect(runtime.reverbZones.find((zone) => zone.id === "high")?.weight).toBeCloseTo(0.5);
	});

	test("profiles bounded mixer CPU, voices, latency evidence, estimated peaks, clipping, and per-bus summaries", () => {
		const sound = {
			id: "voice",
			volume: 1.5,
			metadata: {},
			isSpatial: true,
			streaming: true,
			isPlaying: () => true,
		};
		const scene = { getNodeById: (id: string) => (id === sound.id ? sound : null), transformNodes: [sound] } as any;
		const mixer = new AudioMixer(scene, [{ id: "dialogue", name: "Dialogue", gain: 1, soundNodeIds: [sound.id] }], []);
		mixer.configureProfiler({ enabled: true, sampleCapacity: 3, sampleEveryNUpdates: 2 });
		for (let index = 0; index < 5; index++) {
			mixer.update(1 / 60);
		}

		let profile = mixer.getProfile({ includeSamples: true, sampleLimit: 2 });
		expect(profile).toMatchObject({
			settings: { enabled: true, sampleCapacity: 3, sampleEveryNUpdates: 2 },
			updateCount: 5,
			capturedSampleCount: 3,
			retainedSampleCount: 3,
			droppedSampleCount: 0,
			pagination: { total: 3, count: 2, offset: 0, hasMore: true, nextOffset: 2 },
		});
		expect(profile.summary).toMatchObject({ sampleCount: 3, maximumVoiceCount: 1, maximumPlayingVoiceCount: 1, maximumEstimatedPeakLevel: 1.5, clippedSampleCount: 3 });
		expect(profile.samples[0]).toMatchObject({
			updateIndex: 5,
			voiceCount: 1,
			playingVoiceCount: 1,
			spatialVoiceCount: 1,
			streamingVoiceCount: 1,
			estimatedPeakLevel: 1.5,
			estimatedClippedBusCount: 1,
			audioContext: { available: false },
			buses: [expect.objectContaining({ busId: "dialogue", playingVoiceCount: 1, estimatedPeakLevel: 1.5, estimatedClipping: true })],
		});
		expect(profile.busSummaries[0]).toMatchObject({ busId: "dialogue", sampleCount: 3, maximumPlayingVoiceCount: 1, clippedSampleCount: 3 });
		expect(profile.measurement.cpu).toMatch(/WebAudio does not expose native DSP-thread CPU time/);

		mixer.configureProfiler({ sampleCapacity: 2 });
		profile = mixer.getProfile({ busId: "dialogue", includeSamples: true, sampleLimit: 10 });
		expect(profile).toMatchObject({ retainedSampleCount: 2, droppedSampleCount: 1, pagination: { total: 2, count: 2 } });
		mixer.configureProfiler({ enabled: false });
		mixer.update(1 / 60);
		expect(mixer.getProfile().updateCount).toBe(5);
		const cleared = mixer.clearProfile();
		expect(cleared).toMatchObject({ settings: { enabled: false, sampleCapacity: 2, sampleEveryNUpdates: 2 }, updateCount: 0, capturedSampleCount: 0, retainedSampleCount: 0 });
	});

	test("rejects invalid Audio Mixer profiler bounds", () => {
		const mixer = new AudioMixer({ getNodeById: () => null, transformNodes: [] } as any, [], []);
		expect(() => mixer.configureProfiler({ sampleCapacity: 0 })).toThrow(/sampleCapacity.*1 through 256/i);
		expect(() => mixer.configureProfiler({ sampleEveryNUpdates: 121 })).toThrow(/sampleEveryNUpdates.*1 through 120/i);
		expect(() => mixer.configureProfiler({ enabled: "yes" as any })).toThrow(/enabled must be a boolean/i);
	});
});
