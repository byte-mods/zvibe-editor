import { extnamePortablePath as extname } from "./portable-path";
import {
	evaluateVideoPlatformCompatibility,
	IVideoImporterPlatformOverrides,
	IVideoPlatformCompatibility,
	normalizeVideoImporterPlatformOverrides,
	VideoImporterPlatform,
} from "./video-platform-overrides";

export type VideoImporterTranscode = "preserve" | "webm" | "mp4";
export type VideoImporterCodec = "auto" | "h264" | "h265" | "vp8" | "vp9";
export type VideoImporterEncoder = "auto" | "software" | "videotoolbox" | "nvenc" | "qsv" | "amf";
export type VideoImporterColorDefinition = "preserve" | "rec709";
export type VideoResolvedCodec = Exclude<VideoImporterCodec, "auto"> | "theora";

export interface IVideoImporterSettings {
	transcode: VideoImporterTranscode;
	videoCodec: VideoImporterCodec;
	encoder: VideoImporterEncoder;
	quality: number;
	maxWidth: number;
	maxHeight: number;
	includeAudio: boolean;
	colorDefinition: VideoImporterColorDefinition;
	platformOverrides: IVideoImporterPlatformOverrides;
}

export interface IVideoImportProbe {
	container: string;
	durationSeconds: number;
	width: number;
	height: number;
	frameRate: number;
	videoCodec: string;
	videoProfile: string | null;
	videoLevel: number | null;
	pixelFormat: string;
	colorSpace: string | null;
	colorPrimaries: string | null;
	colorTransfer: string | null;
	colorRange: string | null;
	hasAlpha: boolean;
	videoStreamCount: number;
	videoBitRate: number;
	audioCodec: string | null;
	audioChannels: number | null;
	audioSampleRate: number | null;
	audioStreamCount: number;
}

export interface IVideoEncoderSelection {
	requested: VideoImporterEncoder;
	backend: Exclude<VideoImporterEncoder, "auto">;
	codec: VideoResolvedCodec;
	ffmpegName: string;
	hardware: boolean;
}

export interface IVideoEncoderCapabilities {
	ffmpegEncoders: string[];
	availableBackends: Array<Exclude<VideoImporterEncoder, "auto">>;
	availableSelections: IVideoEncoderSelection[];
}

export interface IVideoImportResult {
	sourcePath: string;
	outputPath: string;
	transcoded: boolean;
	settings: IVideoImporterSettings;
	source: IVideoImportProbe;
	output: IVideoImportProbe;
	sourceBytes: number;
	outputBytes: number;
	platform: VideoImporterPlatform;
	compatibility: IVideoPlatformCompatibility;
	encoder: IVideoEncoderSelection | null;
}

export function normalizeVideoImporterSettings(settings: Record<string, unknown>): IVideoImporterSettings {
	const transcode = settings.transcode ?? "preserve";
	const videoCodec = settings.videoCodec ?? "auto";
	const encoder = settings.encoder ?? "auto";
	const colorDefinition = settings.colorDefinition ?? "preserve";
	if (!["preserve", "webm", "mp4"].includes(String(transcode))) {
		throw new Error("Video transcode must be preserve, webm, or mp4.");
	}
	if (!["auto", "h264", "h265", "vp8", "vp9"].includes(String(videoCodec))) {
		throw new Error("Video codec must be auto, h264, h265, vp8, or vp9.");
	}
	if (!["auto", "software", "videotoolbox", "nvenc", "qsv", "amf"].includes(String(encoder))) {
		throw new Error("Video encoder must be auto, software, videotoolbox, nvenc, qsv, or amf.");
	}
	if (colorDefinition !== "preserve" && colorDefinition !== "rec709") {
		throw new Error("Video color definition must be preserve or rec709.");
	}
	const quality = Number(settings.quality ?? 0.8);
	const maxWidth = Number(settings.maxWidth ?? 1920);
	const maxHeight = Number(settings.maxHeight ?? 1080);
	if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
		throw new Error("Video quality must be between 0 and 1.");
	}
	for (const [label, value] of [
		["maxWidth", maxWidth],
		["maxHeight", maxHeight],
	] as const) {
		if (!Number.isInteger(value) || value < 64 || value > 8192 || value % 2 !== 0) {
			throw new Error(`Video ${label} must be an even integer from 64 through 8192.`);
		}
	}
	return {
		transcode: transcode as VideoImporterTranscode,
		videoCodec: videoCodec as VideoImporterCodec,
		encoder: encoder as VideoImporterEncoder,
		quality,
		maxWidth,
		maxHeight,
		includeAudio: settings.includeAudio === undefined ? true : Boolean(settings.includeAudio),
		colorDefinition: colorDefinition as VideoImporterColorDefinition,
		platformOverrides: normalizeVideoImporterPlatformOverrides(settings.platformOverrides),
	};
}

export function videoImporterOutputExtension(sourcePath: string, settings: IVideoImporterSettings): string {
	if (settings.transcode === "webm") {
		return ".webm";
	}
	if (settings.transcode === "mp4") {
		return ".mp4";
	}
	return extname(sourcePath).toLowerCase();
}

export function videoImportRequiresTranscode(settings: IVideoImporterSettings, source: IVideoImportProbe): boolean {
	return (
		settings.transcode !== "preserve" ||
		settings.videoCodec !== "auto" ||
		settings.encoder !== "auto" ||
		settings.colorDefinition !== "preserve" ||
		!settings.includeAudio ||
		source.width > settings.maxWidth ||
		source.height > settings.maxHeight
	);
}

function qualityCrf(quality: number, minimum: number, maximum: number): string {
	return String(Math.round(maximum - Math.min(1, Math.max(0, quality)) * (maximum - minimum)));
}

function outputFamily(sourcePath: string, settings: IVideoImporterSettings): "mp4" | "webm" | "ogv" {
	if (settings.transcode === "mp4") {
		return "mp4";
	}
	if (settings.transcode === "webm") {
		return "webm";
	}
	const extension = extname(sourcePath).toLowerCase();
	if (extension === ".webm") {
		return "webm";
	}
	if (extension === ".ogv" || extension === ".ogg") {
		return "ogv";
	}
	return "mp4";
}

/** Resolves the codec implied by the output container while preserving compatible authored source codecs. */
export function resolveVideoCodec(sourcePath: string, settings: IVideoImporterSettings, source: IVideoImportProbe): VideoResolvedCodec {
	const family = outputFamily(sourcePath, settings);
	if (settings.videoCodec !== "auto") {
		const compatible = (family === "mp4" && ["h264", "h265"].includes(settings.videoCodec)) || (family === "webm" && ["vp8", "vp9"].includes(settings.videoCodec));
		if (!compatible) {
			throw new Error(`${settings.videoCodec} is incompatible with ${family} output.`);
		}
		return settings.videoCodec;
	}
	const sourceCodec = source.videoCodec.toLowerCase() === "hevc" ? "h265" : source.videoCodec.toLowerCase();
	if (family === "mp4") {
		return sourceCodec === "h265" ? "h265" : "h264";
	}
	if (family === "webm") {
		return sourceCodec === "vp8" ? "vp8" : "vp9";
	}
	return "theora";
}

const encoderNames: Record<VideoResolvedCodec, Partial<Record<Exclude<VideoImporterEncoder, "auto">, string>>> = {
	h264: { software: "libx264", videotoolbox: "h264_videotoolbox", nvenc: "h264_nvenc", qsv: "h264_qsv", amf: "h264_amf" },
	h265: { software: "libx265", videotoolbox: "hevc_videotoolbox", nvenc: "hevc_nvenc", qsv: "hevc_qsv", amf: "hevc_amf" },
	vp8: { software: "libvpx" },
	vp9: { software: "libvpx-vp9", qsv: "vp9_qsv" },
	theora: { software: "libtheora" },
};

/** Parses FFmpeg's encoder listing without executing a shell or trusting localized descriptions. */
export function parseVideoEncoderCapabilities(output: string): IVideoEncoderCapabilities {
	const ffmpegEncoders = [
		...new Set(
			output
				.split(/\r?\n/)
				.map((line) => line.trim().split(/\s+/))
				.filter((parts) => /^V[.A-Z]{5}$/.test(parts[0] ?? "") && Boolean(parts[1]))
				.map((parts) => parts[1])
		),
	].sort();
	const names = new Set(ffmpegEncoders);
	const availableSelections: IVideoEncoderSelection[] = [];
	for (const codec of Object.keys(encoderNames) as VideoResolvedCodec[]) {
		for (const [backend, ffmpegName] of Object.entries(encoderNames[codec]) as Array<[Exclude<VideoImporterEncoder, "auto">, string]>) {
			if (names.has(ffmpegName)) {
				availableSelections.push({ requested: backend, backend, codec, ffmpegName, hardware: backend !== "software" });
			}
		}
	}
	return {
		ffmpegEncoders,
		availableBackends: [...new Set(availableSelections.map((selection) => selection.backend))],
		availableSelections,
	};
}

/** Uses deterministic software for auto and rejects unsupported or unavailable explicit hardware backends. */
export function selectVideoEncoder(
	codec: VideoResolvedCodec,
	requested: VideoImporterEncoder,
	capabilities?: Pick<IVideoEncoderCapabilities, "ffmpegEncoders">
): IVideoEncoderSelection {
	const backend = requested === "auto" ? "software" : requested;
	const ffmpegName = encoderNames[codec][backend];
	if (!ffmpegName) {
		throw new Error(`${backend} does not provide a supported ${codec} encoder.`);
	}
	if (capabilities && !capabilities.ffmpegEncoders.includes(ffmpegName)) {
		throw new Error(`FFmpeg encoder ${ffmpegName} is unavailable for the requested ${backend} ${codec} transcode.`);
	}
	return { requested, backend, codec, ffmpegName, hardware: backend !== "software" };
}

export function createVideoEncoderListArguments(): string[] {
	return ["-hide_banner", "-encoders"];
}

function targetBitRate(source: IVideoImportProbe, settings: IVideoImporterSettings): number {
	const width = Math.min(source.width, settings.maxWidth);
	const height = Math.min(source.height, settings.maxHeight);
	return Math.round(Math.min(100_000_000, Math.max(500_000, width * height * Math.max(1, source.frameRate) * (0.035 + settings.quality * 0.12))));
}

export function createVideoTranscodeArguments(
	sourcePath: string,
	outputPath: string,
	settings: IVideoImporterSettings,
	source: IVideoImportProbe,
	selection = selectVideoEncoder(resolveVideoCodec(sourcePath, settings, source), settings.encoder)
): string[] {
	const family = outputFamily(sourcePath, settings);
	const arguments_: string[] = ["-y", "-i", sourcePath, "-map", "0:v:0", "-map_metadata", "-1"];
	if (source.width > settings.maxWidth || source.height > settings.maxHeight) {
		arguments_.push("-vf", `scale=w='min(iw,${settings.maxWidth})':h='min(ih,${settings.maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2`);
	}
	arguments_.push("-c:v", selection.ffmpegName);
	if (selection.codec === "vp8" || selection.codec === "vp9") {
		if (selection.backend === "software") {
			arguments_.push("-crf", qualityCrf(settings.quality, 18, 48), "-b:v", "0", "-deadline", "good");
		} else {
			arguments_.push("-b:v", String(targetBitRate(source, settings)));
		}
	} else if (selection.codec === "theora") {
		arguments_.push("-q:v", String(Math.round(2 + Math.min(1, Math.max(0, settings.quality)) * 8)));
	} else if (selection.backend === "software") {
		arguments_.push("-crf", qualityCrf(settings.quality, selection.codec === "h265" ? 20 : 18, selection.codec === "h265" ? 38 : 35), "-preset", "medium");
	} else {
		arguments_.push("-b:v", String(targetBitRate(source, settings)));
		if (selection.backend === "videotoolbox") {
			arguments_.push("-allow_sw", "0");
		}
	}
	if (family === "mp4") {
		arguments_.push("-pix_fmt", "yuv420p", "-movflags", "+faststart");
	}
	if (settings.colorDefinition === "rec709") {
		arguments_.push("-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv");
	}
	if (!settings.includeAudio || !source.audioCodec) {
		arguments_.push("-an");
	} else if (family === "webm") {
		arguments_.push("-map", "0:a:0?");
		arguments_.push("-c:a", "libopus", "-b:a", "128k");
	} else if (family === "ogv") {
		arguments_.push("-map", "0:a:0?");
		arguments_.push("-c:a", "libvorbis", "-q:a", "5");
	} else {
		arguments_.push("-map", "0:a:0?");
		arguments_.push("-c:a", "aac", "-b:a", "160k");
	}
	arguments_.push(outputPath);
	return arguments_;
}

export function createVideoProbeArguments(path: string): string[] {
	return ["-v", "error", "-show_streams", "-show_format", "-of", "json", path];
}

function frameRate(value: unknown): number {
	if (typeof value !== "string") {
		return 0;
	}
	const [numerator, denominator] = value.split("/").map(Number);
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
		return 0;
	}
	return numerator / denominator;
}

export function parseVideoProbe(value: unknown): IVideoImportProbe {
	const probe = value as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> };
	const videos = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
	const video = videos[0];
	if (!video) {
		throw new Error("Video asset has no video stream.");
	}
	const audios = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
	const audio = audios[0];
	const width = Number(video.width);
	const height = Number(video.height);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
		throw new Error("Video dimensions are unavailable.");
	}
	const duration = Number(probe.format?.duration ?? video.duration ?? 0);
	const pixelFormat = String(video.pix_fmt ?? "");
	return {
		container: String(probe.format?.format_name ?? ""),
		durationSeconds: Number.isFinite(duration) ? duration : 0,
		width,
		height,
		frameRate: frameRate(video.avg_frame_rate ?? video.r_frame_rate),
		videoCodec: String(video.codec_name ?? ""),
		videoProfile: video.profile === undefined ? null : String(video.profile),
		videoLevel: Number.isFinite(Number(video.level)) ? Number(video.level) : null,
		pixelFormat,
		colorSpace: video.color_space === undefined ? null : String(video.color_space),
		colorPrimaries: video.color_primaries === undefined ? null : String(video.color_primaries),
		colorTransfer: video.color_transfer === undefined ? null : String(video.color_transfer),
		colorRange: video.color_range === undefined ? null : String(video.color_range),
		hasAlpha: /(^|[^a-z])(yuva|rgba|argb|bgra|gbrap|ya)/i.test(pixelFormat),
		videoStreamCount: videos.length,
		videoBitRate: Number(video.bit_rate ?? probe.format?.bit_rate ?? 0) || 0,
		audioCodec: audio ? String(audio.codec_name ?? "") : null,
		audioChannels: audio ? Number(audio.channels ?? 0) || null : null,
		audioSampleRate: audio ? Number(audio.sample_rate ?? 0) || null : null,
		audioStreamCount: audios.length,
	};
}

/** Convenience wrapper for callers that already know the effective build target. */
export function evaluateImportedVideoCompatibility(probe: IVideoImportProbe, platform: VideoImporterPlatform): IVideoPlatformCompatibility {
	return evaluateVideoPlatformCompatibility(probe, platform);
}
