import { describe, expect, test } from "vitest";

import {
	createVideoTranscodeArguments,
	normalizeVideoImporterSettings,
	parseVideoProbe,
	videoImporterOutputExtension,
	videoImportRequiresTranscode,
} from "../../src/assets/video-importer";

const source = {
	container: "mov,mp4,m4a,3gp,3g2,mj2",
	durationSeconds: 2,
	width: 3840,
	height: 2160,
	frameRate: 30,
	videoCodec: "h264",
	videoBitRate: 8_000_000,
	audioCodec: "aac",
	audioChannels: 2,
	audioSampleRate: 48000,
};

describe("video importer", () => {
	test("normalizes settings and creates a bounded browser transcode", () => {
		const settings = normalizeVideoImporterSettings({ transcode: "webm", quality: 0.75, maxWidth: 1920, maxHeight: 1080, includeAudio: false });
		expect(videoImportRequiresTranscode(settings, source)).toBe(true);
		expect(videoImporterOutputExtension("assets/source.mov", settings)).toBe(".webm");
		const arguments_ = createVideoTranscodeArguments("assets/source.mov", "artifact.webm", settings, source);
		expect(arguments_).toContain("libvpx-vp9");
		expect(arguments_).toContain("-an");
		expect(arguments_.join(" ")).toContain("force_divisible_by=2");
		expect(arguments_.at(-1)).toBe("artifact.webm");
	});

	test("parses video and audio stream evidence", () => {
		expect(
			parseVideoProbe({
				streams: [
					{ codec_type: "video", codec_name: "vp9", width: 1280, height: 720, avg_frame_rate: "30000/1001", bit_rate: "1000000" },
					{ codec_type: "audio", codec_name: "opus", channels: 2, sample_rate: "48000" },
				],
				format: { format_name: "matroska,webm", duration: "1.5", bit_rate: "1200000" },
			})
		).toMatchObject({
			container: "matroska,webm",
			durationSeconds: 1.5,
			width: 1280,
			height: 720,
			videoCodec: "vp9",
			audioCodec: "opus",
			audioChannels: 2,
			audioSampleRate: 48000,
		});
	});
});
