import { NullEngine, Scene } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import { createCinematicDocument } from "babylonjs-editor-tools";

import { createDefaultCinematicClip, createDefaultCinematicTrack } from "../../src/editor/layout/cinematic/v2/defaults";

describe("cinematic Video authoring defaults", () => {
	let engine: NullEngine | null = null;
	let scene: Scene | null = null;

	afterEach(() => {
		scene?.dispose();
		engine?.dispose();
		scene = null;
		engine = null;
	});

	test("creates a Video track and binds its clip to an existing persistent player", () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		const document = createCinematicDocument("Intro", "intro");
		const track = createDefaultCinematicTrack(document, scene, "video");
		expect(track).toMatchObject({ type: "video", color: "#06B6D4", clips: [] });
		expect(() => createDefaultCinematicClip(document, scene!, track, 0)).toThrow("Create a persistent Video Player");

		scene.metadata = { babylonEditorVideoPlayers: [{ id: "intro-player", name: "Intro Player", loop: true }] };
		expect(createDefaultCinematicClip(document, scene, track, 12)).toMatchObject({
			type: "video",
			name: "Intro Player Clip",
			startFrame: 12,
			videoPlayerId: "intro-player",
			volume: 1,
			loop: true,
			muteAudio: false,
		});
	});
});
