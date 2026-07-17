import { extname } from "path/posix";

export type VideoImporterTranscode = "preserve" | "webm" | "mp4";

export interface IVideoImporterSettings {
	transcode: VideoImporterTranscode;
	quality: number;
	maxWidth: number;
	maxHeight: number;
	includeAudio: boolean;
}

export interface IVideoImportProbe {
	container: string;
	durationSeconds: number;
	width: number;
	height: number;
	frameRate: number;
	videoCodec: string;
	videoBitRate: number;
	audioCodec: string | null;
	audioChannels: number | null;
	audioSampleRate: number | null;
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
}

export function normalizeVideoImporterSettings(settings: Record<string, unknown>): IVideoImporterSettings {
	return {
		transcode: settings.transcode as VideoImporterTranscode,
		quality: Number(settings.quality),
		maxWidth: Number(settings.maxWidth),
		maxHeight: Number(settings.maxHeight),
		includeAudio: Boolean(settings.includeAudio),
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
	return settings.transcode !== "preserve" || !settings.includeAudio || source.width > settings.maxWidth || source.height > settings.maxHeight;
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

export function createVideoTranscodeArguments(sourcePath: string, outputPath: string, settings: IVideoImporterSettings, source: IVideoImportProbe): string[] {
	const family = outputFamily(sourcePath, settings);
	const arguments_: string[] = ["-y", "-i", sourcePath, "-map_metadata", "-1"];
	if (source.width > settings.maxWidth || source.height > settings.maxHeight) {
		arguments_.push("-vf", `scale=w='min(iw,${settings.maxWidth})':h='min(ih,${settings.maxHeight})':force_original_aspect_ratio=decrease:force_divisible_by=2`);
	}
	if (family === "webm") {
		arguments_.push("-c:v", "libvpx-vp9", "-crf", qualityCrf(settings.quality, 18, 48), "-b:v", "0", "-deadline", "good");
	} else if (family === "ogv") {
		arguments_.push("-c:v", "libtheora", "-q:v", String(Math.round(2 + Math.min(1, Math.max(0, settings.quality)) * 8)));
	} else {
		arguments_.push("-c:v", "libx264", "-crf", qualityCrf(settings.quality, 18, 35), "-preset", "medium", "-pix_fmt", "yuv420p", "-movflags", "+faststart");
	}
	if (!settings.includeAudio || !source.audioCodec) {
		arguments_.push("-an");
	} else if (family === "webm") {
		arguments_.push("-c:a", "libopus", "-b:a", "128k");
	} else if (family === "ogv") {
		arguments_.push("-c:a", "libvorbis", "-q:a", "5");
	} else {
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
	const video = probe.streams?.find((stream) => stream.codec_type === "video");
	if (!video) {
		throw new Error("Video asset has no video stream.");
	}
	const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
	const width = Number(video.width);
	const height = Number(video.height);
	if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
		throw new Error("Video dimensions are unavailable.");
	}
	const duration = Number(probe.format?.duration ?? video.duration ?? 0);
	return {
		container: String(probe.format?.format_name ?? ""),
		durationSeconds: Number.isFinite(duration) ? duration : 0,
		width,
		height,
		frameRate: frameRate(video.avg_frame_rate ?? video.r_frame_rate),
		videoCodec: String(video.codec_name ?? ""),
		videoBitRate: Number(video.bit_rate ?? probe.format?.bit_rate ?? 0) || 0,
		audioCodec: audio ? String(audio.codec_name ?? "") : null,
		audioChannels: audio ? Number(audio.channels ?? 0) || null : null,
		audioSampleRate: audio ? Number(audio.sample_rate ?? 0) || null : null,
	};
}
