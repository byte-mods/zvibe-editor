import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path/posix";

import { ensureDir, pathExists, readFile, remove } from "fs-extra";
import { afterEach, describe, expect, test } from "vitest";

import { createCinematicCapturePlan, createCinematicDocument, createCinematicRecorderProfile, getCinematicCaptureSample } from "babylonjs-editor-tools";

import { CinematicFileCaptureSink, createEditorMp4Transcoder } from "../../src/editor/layout/cinematic/v2/capture";

const ffmpeg = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
const mediaToolsAvailable = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0 && spawnSync(ffprobe, ["-version"], { stdio: "ignore" }).status === 0;

const temporaryPaths: string[] = [];

function plan() {
	let document = { ...createCinematicDocument("Capture", "capture"), durationMode: "fixed" as const, durationFrames: 2 };
	document = createCinematicRecorderProfile(document, document.revision, {
		id: "images",
		name: "Images",
		format: "png",
		width: 16,
		height: 16,
		framesPerSecond: 60,
		quality: 1,
		includeAudio: false,
	});
	return createCinematicCapturePlan(document, "images");
}

function canvas(): HTMLCanvasElement {
	return {
		width: 16,
		height: 16,
		toBlob: (callback: BlobCallback) => callback(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })),
	} as unknown as HTMLCanvasElement;
}

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => remove(path)));
});

describe("cinematic file capture sink", () => {
	test("publishes a zero-padded image sequence only after completion", async () => {
		const root = join(tmpdir(), `zvibe-capture-${crypto.randomUUID()}`);
		temporaryPaths.push(root);
		await ensureDir(root);
		const sink = new CinematicFileCaptureSink({ canvas: canvas(), destination: join(root, "shot.png") });
		const capturePlan = plan();
		await sink.begin(capturePlan);
		expect(await pathExists(join(root, "shot-frames"))).toBe(false);
		await sink.write(getCinematicCaptureSample(capturePlan, 0));
		await sink.write(getCinematicCaptureSample(capturePlan, 1));
		const result = await sink.complete();

		expect(result).toEqual({ destination: join(root, "shot-frames"), frameCount: 2, format: "png", audio: null });
		expect([...(await readFile(join(root, "shot-frames", "00000001.png")))]).toEqual([137, 80, 78, 71]);
		expect(await pathExists(join(root, "shot-frames", "00000002.png"))).toBe(true);
	});

	test("refuses an existing sequence destination without changing it", async () => {
		const root = join(tmpdir(), `zvibe-capture-${crypto.randomUUID()}`);
		temporaryPaths.push(root);
		await ensureDir(join(root, "shot-frames"));
		const sink = new CinematicFileCaptureSink({ canvas: canvas(), destination: join(root, "shot.png") });
		await expect(sink.begin(plan())).rejects.toThrow("already exists");
		expect(await pathExists(join(root, "shot-frames"))).toBe(true);
	});

	test.runIf(mediaToolsAvailable)("muxes deterministic WebM video and WAV audio into Opus through the resolved FFmpeg executable", async () => {
		const root = join(tmpdir(), `zvibe-capture-${crypto.randomUUID()}`);
		temporaryPaths.push(root);
		await ensureDir(root);
		const videoPath = join(root, "video.webm");
		const audioPath = join(root, "audio.wav");
		const outputPath = join(root, "muxed.webm");
		expect(spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2:d=1", "-an", "-c:v", "libvpx-vp9", videoPath], { stdio: "ignore" }).status).toBe(
			0
		);
		expect(spawnSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "1", audioPath], { stdio: "ignore" }).status).toBe(0);
		await createEditorMp4Transcoder({ path: null } as any)({ inputPath: videoPath, outputPath, framesPerSecond: 2, format: "webm", audioPath });
		const probe = spawnSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", outputPath], { encoding: "utf-8" });
		expect(probe.status).toBe(0);
		expect(JSON.parse(probe.stdout).streams).toEqual(
			expect.arrayContaining([
				{ codec_name: "vp9", codec_type: "video" },
				{ codec_name: "opus", codec_type: "audio" },
			])
		);
	});
});
