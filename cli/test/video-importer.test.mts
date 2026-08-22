import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { normalizeVideoImporterSettings, serializeVideoImporterPlatformOverrides } from "babylonjs-editor-tools";

import { getExportedVideoEncoderCapabilities, processExportedVideo } from "../src/pack/assets/video.mjs";

const ffmpeg = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobe = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
const mediaToolsAvailable = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0 && spawnSync(ffprobe, ["-version"], { stdio: "ignore" }).status === 0;

function createVideo(path: string): void {
	const result = spawnSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30", "-t", "0.25", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", path], {
		encoding: "utf-8",
	});
	if (result.status !== 0) throw new Error(result.stderr);
}

describe.runIf(mediaToolsAvailable)("CLI video importer", () => {
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(join(tmpdir(), "babylon-cli-video-"));
	});

	afterEach(async () => {
		await fs.remove(directory);
	});

	test("detects encoders and executes the selected target override", async () => {
		const capabilities = await getExportedVideoEncoderCapabilities();
		expect(capabilities.ffmpegEncoders).toContain("libvpx-vp9");
		const source = join(directory, "clip.mp4");
		const requestedOutput = join(directory, "build", "clip.mp4");
		createVideo(source);
		await fs.ensureDir(join(directory, "build"));
		const settings = normalizeVideoImporterSettings({
			transcode: "preserve",
			quality: 0.8,
			maxWidth: 1920,
			maxHeight: 1080,
			includeAudio: true,
			platformOverrides: serializeVideoImporterPlatformOverrides({
				web: { enabled: true, transcode: "webm", videoCodec: "vp9", encoder: "software", maxWidth: 320, maxHeight: 180, includeAudio: false, colorDefinition: "rec709" },
			}),
		});
		const result = await processExportedVideo(source, requestedOutput, settings, "web");
		expect(result).toMatchObject({
			platform: "web",
			transcoded: true,
			encoder: { backend: "software", ffmpegName: "libvpx-vp9", hardware: false },
			compatibility: { status: "supported" },
			output: { width: 320, height: 180, videoCodec: "vp9", colorSpace: "bt709", colorRange: "tv" },
		});
		expect(result.outputPath).toMatch(/clip\.webm$/);
		expect(await fs.pathExists(result.outputPath)).toBe(true);
	});
});
