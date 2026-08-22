import { Observable } from "@babylonjs/core/Misc/observable";
import { SoundState } from "@babylonjs/core/AudioV2/soundState";
import { describe, expect, test } from "vitest";

import { createDefaultScriptableAudioGeneratorGraph, ScriptableAudioGeneratorRuntime } from "../../src/loading/scriptable-audio";
import {
	IScriptableAudioPlaybackState,
	isScriptableAudioGeneratorPath,
	SCRIPTABLE_AUDIO_WORKLET_SOURCE,
	ScriptableAudioStreamingSound,
} from "../../src/loading/scriptable-audio-playback";

class FakeWorkletPort {
	public onmessage: ((event: { data: unknown }) => void) | null = null;
	public readonly messages: Array<{ message: Record<string, unknown>; transfer?: Transferable[] }> = [];

	public postMessage(message: Record<string, unknown>, transfer?: Transferable[]): void {
		this.messages.push({ message, transfer });
	}

	public receive(data: unknown): void {
		this.onmessage?.({ data });
	}
}

class FakeWorklet {
	public readonly port = new FakeWorkletPort();
	public disconnectCount = 0;

	public disconnect(): void {
		this.disconnectCount++;
	}
}

function createFakeSource() {
	const onDisposeObservable = new Observable<unknown>();
	return {
		engine: {},
		onDisposeObservable,
		spatial: {
			attach: () => undefined,
			update: () => undefined,
			maxDistance: 100,
			panningModel: "equalpower" as PanningModelType,
			distanceModel: "linear" as DistanceModelType,
		},
		stereo: {},
		volume: 1,
		outBus: null,
		_isSpatial: false,
		setVolume(value: number) {
			this.volume = value;
		},
		dispose() {
			onDisposeObservable.notifyObservers(this);
		},
	};
}

async function createStreamingHarness(durationSeconds: number): Promise<{
	sound: ScriptableAudioStreamingSound;
	worklet: FakeWorklet;
	source: ReturnType<typeof createFakeSource>;
}> {
	const graph = { ...createDefaultScriptableAudioGeneratorGraph(), sampleRate: 8_000, channels: 1, durationSeconds, streaming: true };
	const runtime = await ScriptableAudioGeneratorRuntime.CreateAsync(graph, { loadAudioClip: async () => Promise.reject(new Error("unused")) });
	const worklet = new FakeWorklet();
	const source = createFakeSource();
	const Constructor = ScriptableAudioStreamingSound as unknown as new (
		name: string,
		runtime: ScriptableAudioGeneratorRuntime,
		worklet: FakeWorklet,
		source: ReturnType<typeof createFakeSource>,
		options: { loadAudioClip: () => Promise<never> }
	) => ScriptableAudioStreamingSound;
	const sound = new Constructor("generated", runtime, worklet, source, { loadAudioClip: async () => Promise.reject(new Error("unused")) });
	return { sound, worklet, source };
}

function state(sound: ScriptableAudioStreamingSound): IScriptableAudioPlaybackState {
	return sound.getPlaybackState();
}

describe("loading/scriptable audio playback", () => {
	test("selects generator assets case-insensitively without claiming ordinary JSON", () => {
		expect(isScriptableAudioGeneratorPath("audio/Ambience.audio-generator.json")).toBe(true);
		expect(isScriptableAudioGeneratorPath("AUDIO/TONE.AUDIO-GENERATOR.JSON")).toBe(true);
		expect(isScriptableAudioGeneratorPath("audio/tone.json")).toBe(false);
		expect(isScriptableAudioGeneratorPath(undefined)).toBe(false);
	});

	test("keeps the worklet transport bounded to one consumed message site per audio quantum", () => {
		expect(SCRIPTABLE_AUDIO_WORKLET_SOURCE).toContain('registerProcessor("babylonjs-editor-scriptable-audio-v1"');
		expect(SCRIPTABLE_AUDIO_WORKLET_SOURCE.match(/type: "consumed"/g)).toHaveLength(1);
		expect(SCRIPTABLE_AUDIO_WORKLET_SOURCE).toContain("let consumed = 0");
		expect(SCRIPTABLE_AUDIO_WORKLET_SOURCE).toContain('this.port.postMessage({ type: "underrun"');
	});

	test("prebuffers, refills, seeks, pauses, loops, and reports live playback evidence", async () => {
		const { sound, worklet, source } = await createStreamingHarness(4);
		sound.volume = 0.25;
		sound.playbackRate = 1.5;
		sound.play({ loop: true });

		const initialBlocks = worklet.port.messages.filter(({ message }) => message.type === "block");
		expect(initialBlocks).toHaveLength(8);
		expect(initialBlocks.every(({ transfer }) => transfer?.length === 1)).toBe(true);
		expect(state(sound)).toMatchObject({ state: "started", streaming: true, generatedFrames: 16_384, queuedBlocks: 8, loop: true, playbackRate: 1.5 });
		expect(source.volume).toBe(0.25);

		worklet.port.receive({ type: "consumed", frames: 4_096, queuedBlocks: 3 });
		await Promise.resolve();
		expect(state(sound)).toMatchObject({ consumedFrames: 4_096, queuedBlocks: 8, generatedFrames: 26_624 });

		sound.pause();
		expect(sound.state).toBe(SoundState.Paused);
		sound.resume();
		expect(sound.state).toBe(SoundState.Started);

		sound.seek(1);
		expect(sound.currentTime).toBe(1);
		expect(worklet.port.messages.some(({ message }) => message.type === "reset")).toBe(true);
		expect(() => sound.seek(5)).toThrow(/seek must be from 0 through 4/);

		worklet.port.receive({ type: "underrun", count: 3 });
		expect(state(sound).underrunCount).toBe(3);
		sound.dispose();
		sound.dispose();
		expect(worklet.disconnectCount).toBe(1);
		expect(state(sound).state).toBe("disposed");
		expect(() => sound.play()).toThrow(/disposed/);
	});

	test("restarts a completed finite generator from frame zero", async () => {
		const { sound, worklet } = await createStreamingHarness(0.01);
		let ended = 0;
		sound.onEndedObservable.add(() => ended++);
		sound.play();
		expect(state(sound)).toMatchObject({ generatedFrames: 80, queuedBlocks: 1, finished: false });
		expect(worklet.port.messages.at(-1)?.message.type).toBe("playing");

		worklet.port.receive({ type: "consumed", frames: 80, queuedBlocks: 0 });
		worklet.port.receive({ type: "ended" });
		expect(sound.state).toBe(SoundState.Stopped);
		expect(state(sound).finished).toBe(true);
		expect(ended).toBe(1);

		const resetsBeforeReplay = worklet.port.messages.filter(({ message }) => message.type === "reset").length;
		sound.play();
		expect(worklet.port.messages.filter(({ message }) => message.type === "reset")).toHaveLength(resetsBeforeReplay + 1);
		expect(state(sound)).toMatchObject({ state: "started", consumedFrames: 0, generatedFrames: 80, queuedBlocks: 1, finished: false });
		sound.dispose();
	});
});
