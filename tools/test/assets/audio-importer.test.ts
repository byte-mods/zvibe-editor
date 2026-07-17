import { describe, expect, test } from "vitest";

import {
	audioImportRequiresTranscode,
	createAudioProbeArguments,
	createAudioTranscodeArguments,
	normalizeAudioImporterSettings,
	parseAudioProbe,
} from "../../src/assets/audio-importer";

describe("audio importer", () => {
	test("builds bounded shell-free transcode arguments for mono normalized browser audio", () => {
		const settings = normalizeAudioImporterSettings({
			loadType: "streaming",
			compressionFormat: "browser",
			quality: 0.5,
			sampleRate: "22050",
			forceMono: true,
			normalize: true,
		});
		expect(audioImportRequiresTranscode(settings)).toBe(true);
		expect(createAudioTranscodeArguments("/source file.wav", "/output file.ogg", settings)).toEqual([
			"-hide_banner",
			"-loglevel",
			"error",
			"-nostdin",
			"-y",
			"-i",
			"/source file.wav",
			"-map_metadata",
			"-1",
			"-vn",
			"-ac",
			"1",
			"-ar",
			"22050",
			"-af",
			"loudnorm=I=-16:TP=-1.5:LRA=11",
			"-c:a",
			"libvorbis",
			"-q:a",
			"5",
			"/output file.ogg",
		]);
		expect(createAudioTranscodeArguments("source.wav", "output.m4a", { ...settings, quality: 1 })).toContain("320k");
		expect(() => createAudioTranscodeArguments("source.wav", "output.bin", settings)).toThrow("does not support");
	});

	test("preserves audio when no processing field requires transcoding and parses probe evidence", () => {
		const settings = normalizeAudioImporterSettings({
			loadType: "compressedInMemory",
			compressionFormat: "preserve",
			quality: 0.8,
			sampleRate: "preserve",
			forceMono: false,
			normalize: false,
		});
		expect(audioImportRequiresTranscode(settings)).toBe(false);
		expect(createAudioProbeArguments("sound.wav")).toContain("stream=codec_name,sample_rate,channels,bit_rate:format=format_name,duration,bit_rate");
		expect(
			parseAudioProbe({
				streams: [{ codec_name: "pcm_s16le", sample_rate: "48000", channels: 2, bit_rate: "1536000" }],
				format: { format_name: "wav", duration: "1.25" },
			})
		).toEqual({ codec: "pcm_s16le", container: "wav", durationSeconds: 1.25, sampleRate: 48000, channels: 2, bitRate: 1536000 });
	});
});
