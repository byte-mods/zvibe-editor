import { describe, expect, test } from "vitest";

import { AudioMixer } from "../../src/loading/audio-mixer";

describe("loading/audio mixer", () => {
	test("applies exported bus gains and recalls snapshots", () => {
		const sound = { volume: 1, metadata: {} as any };
		const scene = { getNodeById: (id: string) => (id === "sound" ? sound : null) } as any;
		const mixer = new AudioMixer(scene, [{ id: "music", name: "Music", gain: 0.5, soundNodeIds: ["sound"] }], [{ id: "quiet", name: "Quiet", gains: { music: 0.25 }, mutes: { music: true } }]);

		mixer.apply();
		expect(sound.volume).toBe(0.5);
		expect(mixer.applySnapshot("quiet")).toBe(true);
		expect(sound.volume).toBe(0);
	});

	test("mutes non-solo buses while any exported mixer bus is soloed", () => {
		const music = { volume: 1, metadata: {} as any };
		const ambience = { volume: 1, metadata: {} as any };
		const scene = { getNodeById: (id: string) => (id === "music" ? music : id === "ambience" ? ambience : null) } as any;
		const mixer = new AudioMixer(scene, [
			{ id: "music", name: "Music", gain: 0.5, solo: true, soundNodeIds: ["music"] },
			{ id: "ambience", name: "Ambience", gain: 0.5, soundNodeIds: ["ambience"] },
		], []);

		mixer.apply();
		expect(music.volume).toBe(0.5);
		expect(ambience.volume).toBe(0);
	});
});
