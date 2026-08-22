import { describe, expect, test } from "vitest";

import { normalizeVideoImporterSettings } from "../../src/assets/video-importer";
import {
	evaluateVideoPlatformCompatibility,
	getVideoPlatformCodecMatrix,
	normalizeVideoImporterPlatformOverrides,
	resolveVideoImporterPlatformSettings,
	serializeVideoImporterPlatformOverrides,
} from "../../src/assets/video-platform-overrides";

const probe = {
	container: "mov,mp4,m4a,3gp,3g2,mj2",
	durationSeconds: 1,
	width: 1920,
	height: 1080,
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
	videoBitRate: 4_000_000,
	audioCodec: "aac",
	audioChannels: 2,
	audioSampleRate: 48_000,
	audioStreamCount: 1,
};

describe("video platform overrides and codec policy", () => {
	test("normalizes closed overrides and resolves one immutable target", () => {
		const overrides = normalizeVideoImporterPlatformOverrides({
			web: { enabled: true, transcode: "webm", videoCodec: "vp9", encoder: "software", maxWidth: 1280, maxHeight: 720, includeAudio: false },
			desktop: { enabled: false },
		});
		const settings = normalizeVideoImporterSettings({
			transcode: "preserve",
			quality: 0.8,
			maxWidth: 1920,
			maxHeight: 1080,
			includeAudio: true,
			platformOverrides: serializeVideoImporterPlatformOverrides(overrides),
		});
		const resolved = resolveVideoImporterPlatformSettings(settings, "android");
		expect(resolved).toMatchObject({ platform: "web", overrideApplied: true, settings: { transcode: "webm", videoCodec: "vp9", maxWidth: 1280, includeAudio: false } });
		expect(settings.transcode).toBe("preserve");
		expect(() => normalizeVideoImporterPlatformOverrides({ web: { enabled: true, unknown: true } })).toThrow("Unsupported video platform override");
		expect(() => normalizeVideoImporterPlatformOverrides({ web: { enabled: true, maxWidth: 1279 } })).toThrow("even integer");
	});

	test("publishes and evaluates the Web/Desktop codec matrices from actual probe evidence", () => {
		expect(getVideoPlatformCodecMatrix("electron")).toMatchObject({ platform: "desktop", recommendedVideoCodec: "h264" });
		expect(evaluateVideoPlatformCompatibility(probe, "web")).toMatchObject({ platform: "web", status: "supported", hardwareDecode: "common" });
		expect(evaluateVideoPlatformCompatibility({ ...probe, videoCodec: "prores" }, "desktop")).toMatchObject({ status: "unsupported" });
		expect(evaluateVideoPlatformCompatibility(probe, "default")).toMatchObject({ status: "notEvaluated" });
	});
});
