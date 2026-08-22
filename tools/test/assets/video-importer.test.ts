import { describe, expect, test } from "vitest";

import {
	createVideoTranscodeArguments,
	parseVideoEncoderCapabilities,
	normalizeVideoImporterSettings,
	parseVideoProbe,
	resolveVideoCodec,
	selectVideoEncoder,
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
	videoProfile: "High",
	videoLevel: 40,
	pixelFormat: "yuv420p",
	colorSpace: "bt709",
	colorPrimaries: "bt709",
	colorTransfer: "bt709",
	colorRange: "tv",
	hasAlpha: false,
	videoStreamCount: 1,
	videoBitRate: 8_000_000,
	audioCodec: "aac",
	audioChannels: 2,
	audioSampleRate: 48000,
	audioStreamCount: 1,
};

describe("video importer", () => {
	test("normalizes settings and creates a bounded browser transcode", () => {
		const settings = normalizeVideoImporterSettings({ transcode: "webm", quality: 0.75, maxWidth: 1920, maxHeight: 1080, includeAudio: false });
		expect(settings).toMatchObject({ videoCodec: "auto", encoder: "auto", colorDefinition: "preserve", platformOverrides: {} });
		expect(videoImportRequiresTranscode(settings, source)).toBe(true);
		expect(videoImporterOutputExtension("assets/source.mov", settings)).toBe(".webm");
		const arguments_ = createVideoTranscodeArguments("assets/source.mov", "artifact.webm", settings, source);
		expect(arguments_).toContain("libvpx-vp9");
		expect(arguments_).toContain("-an");
		expect(arguments_.join(" ")).toContain("force_divisible_by=2");
		expect(arguments_.at(-1)).toBe("artifact.webm");
	});

	test("selects only codec-compatible software or explicitly available hardware encoders", () => {
		const capabilities = parseVideoEncoderCapabilities(`
 V....D libx264              H.264
 V....D h264_videotoolbox    VideoToolbox H.264
 V....D libvpx-vp9           VP9
`);
		expect(capabilities.availableBackends).toEqual(["software", "videotoolbox"]);
		expect(selectVideoEncoder("h264", "videotoolbox", capabilities)).toMatchObject({ ffmpegName: "h264_videotoolbox", hardware: true });
		expect(() => selectVideoEncoder("h265", "videotoolbox", capabilities)).toThrow("unavailable");
		expect(() => selectVideoEncoder("vp9", "nvenc", capabilities)).toThrow("does not provide");
	});

	test("validates explicit codec/container pairs and emits Rec.709 metadata", () => {
		const settings = normalizeVideoImporterSettings({
			transcode: "mp4",
			videoCodec: "h265",
			encoder: "software",
			quality: 0.8,
			maxWidth: 1920,
			maxHeight: 1080,
			includeAudio: true,
			colorDefinition: "rec709",
		});
		expect(resolveVideoCodec("source.mov", settings, source)).toBe("h265");
		const arguments_ = createVideoTranscodeArguments("source.mov", "output.mp4", settings, source);
		expect(arguments_).toEqual(expect.arrayContaining(["-c:v", "libx265", "-color_primaries", "bt709", "-color_range", "tv"]));
		const invalid = normalizeVideoImporterSettings({ ...settings, transcode: "webm" });
		expect(() => resolveVideoCodec("source.mov", invalid, source)).toThrow("incompatible");
	});

	test("parses video and audio stream evidence", () => {
		expect(
			parseVideoProbe({
				streams: [
					{
						codec_type: "video",
						codec_name: "vp9",
						profile: "Profile 0",
						level: 31,
						pix_fmt: "yuva420p",
						color_space: "bt709",
						color_primaries: "bt709",
						color_transfer: "bt709",
						color_range: "tv",
						width: 1280,
						height: 720,
						avg_frame_rate: "30000/1001",
						bit_rate: "1000000",
					},
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
			videoProfile: "Profile 0",
			videoLevel: 31,
			pixelFormat: "yuva420p",
			colorSpace: "bt709",
			hasAlpha: true,
			videoStreamCount: 1,
			audioCodec: "opus",
			audioChannels: 2,
			audioSampleRate: 48000,
			audioStreamCount: 1,
		});
	});
});
