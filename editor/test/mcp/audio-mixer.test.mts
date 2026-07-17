import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", () => ({}));

import { SoundNode } from "../../src/editor/nodes/sound";
import {
	assignSoundNodeToAudioBus,
	applyAudioMixerSnapshot,
	createAudioBus,
	createAudioMixerSnapshot,
	listAudioBuses,
	listAudioMixerSnapshots,
	listAudioRuntimeDiagnostics,
	setAudioBus,
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
		expect(diagnostics.summary).toEqual({ soundCount: 1, loadedCount: 1, playingCount: 1, busCount: 1 });
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
});
