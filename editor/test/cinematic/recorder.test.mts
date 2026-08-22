import { NullEngine, Scene } from "babylonjs";
import { afterEach, describe, expect, test } from "vitest";

import { createCinematicDocument, createCinematicRecorderProfile } from "babylonjs-editor-tools";

import { CinematicDocumentRecorder, ICinematicCaptureSink } from "../../src/editor/layout/cinematic/v2/recorder";

const resources: { scene: Scene; engine: NullEngine }[] = [];

function setup() {
	const engine = new NullEngine();
	const scene = new Scene(engine);
	resources.push({ scene, engine });
	let document = { ...createCinematicDocument("Capture", "capture"), framesPerSecond: 30, durationMode: "fixed" as const, durationFrames: 2 };
	document = createCinematicRecorderProfile(document, document.revision, {
		id: "frames",
		name: "Frames",
		format: "png",
		width: 320,
		height: 180,
		framesPerSecond: 60,
		quality: 1,
		includeAudio: false,
	});
	return { scene, document };
}

afterEach(() => {
	for (const resource of resources.splice(0)) {
		resource.scene.dispose();
		resource.engine.dispose();
	}
});

describe("cinematic document recorder", () => {
	test("serializes deterministic seek, render, write, and progress operations", async () => {
		const { scene, document } = setup();
		const events: string[] = [];
		const sink: ICinematicCaptureSink<string> = {
			supportsAudio: false,
			begin: async (plan) => void events.push(`begin:${plan.frameCount}`),
			write: async (sample) => void events.push(`write:${sample.index}:${sample.timelineFrame}`),
			complete: async () => "destination",
			abort: async () => void events.push("abort"),
		};
		const recorder = new CinematicDocumentRecorder(document, scene);
		const result = await recorder.record("frames", sink, {
			onRenderFrame: async (sample) => void events.push(`render:${sample.index}:${sample.timelineFrame}`),
			onProgress: (completed, total) => events.push(`progress:${completed}/${total}`),
		});

		expect(result.output).toBe("destination");
		expect(events).toEqual([
			"begin:4",
			"render:0:0",
			"write:0:0",
			"progress:1/4",
			"render:1:0.5",
			"write:1:0.5",
			"progress:2/4",
			"render:2:1",
			"write:2:1",
			"progress:3/4",
			"render:3:1.5",
			"write:3:1.5",
			"progress:4/4",
		]);
	});

	test("aborts the sink, restores the scene lease, and rejects unsupported audio", async () => {
		const { scene, document } = setup();
		let aborted = false;
		const sink: ICinematicCaptureSink<void> = {
			supportsAudio: false,
			begin: async () => undefined,
			write: async () => {
				throw new Error("encoder failed");
			},
			complete: async () => undefined,
			abort: async () => void (aborted = true),
		};
		const recorder = new CinematicDocumentRecorder(document, scene);
		await expect(recorder.record("frames", sink, { onRenderFrame: async () => undefined })).rejects.toThrow("encoder failed");
		expect(aborted).toBe(true);
		await expect(recorder.record("frames", { ...sink, write: async () => undefined }, { onRenderFrame: async () => undefined })).resolves.toBeDefined();

		const audioDocument = { ...document, recorderProfiles: [{ ...document.recorderProfiles[0], includeAudio: true }] };
		await expect(new CinematicDocumentRecorder(audioDocument, scene).record("frames", sink, { onRenderFrame: async () => undefined })).rejects.toThrow(
			"does not support audio"
		);
	});

	test("yields between frames so external cancellation can interrupt a fast sink", async () => {
		const { scene, document } = setup();
		const controller = new AbortController();
		let writes = 0;
		let aborted = false;
		const sink: ICinematicCaptureSink<void> = {
			supportsAudio: false,
			begin: async () => void setTimeout(() => controller.abort(new Error("external cancellation")), 0),
			write: async () => void writes++,
			complete: async () => undefined,
			abort: async () => void (aborted = true),
		};

		await expect(new CinematicDocumentRecorder(document, scene).record("frames", sink, { signal: controller.signal, onRenderFrame: async () => undefined })).rejects.toThrow(
			"external cancellation"
		);
		expect(writes).toBeLessThan(4);
		expect(aborted).toBe(true);
	});
});
