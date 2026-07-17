export type AudioImporterLoadType = "decompressOnLoad" | "compressedInMemory" | "streaming";
export type AudioImporterCompressionFormat = "preserve" | "browser";
export type AudioImporterSampleRate = "preserve" | "22050" | "44100" | "48000";

export interface IAudioImporterSettings {
	loadType: AudioImporterLoadType;
	compressionFormat: AudioImporterCompressionFormat;
	quality: number;
	sampleRate: AudioImporterSampleRate;
	forceMono: boolean;
	normalize: boolean;
}

export interface IAudioImportProbe {
	codec: string | null;
	container: string | null;
	durationSeconds: number | null;
	sampleRate: number | null;
	channels: number | null;
	bitRate: number | null;
}

export interface IAudioImportResult {
	sourcePath: string;
	outputPath: string;
	transcoded: boolean;
	settings: IAudioImporterSettings;
	source: IAudioImportProbe;
	output: IAudioImportProbe;
	sourceBytes: number;
	outputBytes: number;
}

const browserCodecByExtension: Record<string, { codec: string; format?: string }> = {
	".mp3": { codec: "libmp3lame" },
	".ogg": { codec: "libvorbis" },
	".wav": { codec: "pcm_s16le", format: "wav" },
	".wave": { codec: "pcm_s16le", format: "wav" },
	".flac": { codec: "flac" },
	".m4a": { codec: "aac", format: "ipod" },
};

export function normalizeAudioImporterSettings(settings: Record<string, boolean | number | string>): IAudioImporterSettings {
	return {
		loadType: settings.loadType as AudioImporterLoadType,
		compressionFormat: settings.compressionFormat as AudioImporterCompressionFormat,
		quality: settings.quality as number,
		sampleRate: settings.sampleRate as AudioImporterSampleRate,
		forceMono: settings.forceMono as boolean,
		normalize: settings.normalize as boolean,
	};
}

export function audioImportRequiresTranscode(settings: IAudioImporterSettings): boolean {
	return settings.compressionFormat === "browser" || settings.sampleRate !== "preserve" || settings.forceMono || settings.normalize;
}

/** Builds a shell-free FFmpeg argument vector for one validated audio importer configuration. */
export function createAudioTranscodeArguments(sourcePath: string, outputPath: string, settings: IAudioImporterSettings): string[] {
	const extension = outputPath.match(/(\.[^./\\]+)$/)?.[1].toLowerCase() ?? "";
	const codec = browserCodecByExtension[extension];
	if (!codec) {
		throw new Error(`Audio transcoding does not support the ${extension || "extensionless"} output container.`);
	}
	const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", sourcePath, "-map_metadata", "-1", "-vn"];
	if (settings.forceMono) {
		args.push("-ac", "1");
	}
	if (settings.sampleRate !== "preserve") {
		args.push("-ar", settings.sampleRate);
	}
	if (settings.normalize) {
		args.push("-af", "loudnorm=I=-16:TP=-1.5:LRA=11");
	}
	args.push("-c:a", codec.codec);
	const quality = Math.min(1, Math.max(0, settings.quality));
	if (codec.codec === "libmp3lame" || codec.codec === "aac") {
		args.push("-b:a", `${Math.round(64 + quality * 256)}k`);
	} else if (codec.codec === "libvorbis") {
		args.push("-q:a", String(Number((quality * 10).toFixed(2))));
	} else if (codec.codec === "flac") {
		args.push("-compression_level", String(Math.round(quality * 12)));
	}
	if (codec.format) {
		args.push("-f", codec.format);
	}
	args.push(outputPath);
	return args;
}

export function createAudioProbeArguments(path: string): string[] {
	return ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name,sample_rate,channels,bit_rate:format=format_name,duration,bit_rate", "-of", "json", path];
}

export function parseAudioProbe(value: unknown): IAudioImportProbe {
	const data = value && typeof value === "object" ? (value as Record<string, any>) : {};
	const stream = Array.isArray(data.streams) && data.streams[0] && typeof data.streams[0] === "object" ? data.streams[0] : {};
	const format = data.format && typeof data.format === "object" ? data.format : {};
	const finite = (candidate: unknown): number | null => {
		const number = Number(candidate);
		return Number.isFinite(number) && number >= 0 ? number : null;
	};
	return {
		codec: typeof stream.codec_name === "string" ? stream.codec_name : null,
		container: typeof format.format_name === "string" ? format.format_name : null,
		durationSeconds: finite(format.duration),
		sampleRate: finite(stream.sample_rate),
		channels: finite(stream.channels),
		bitRate: finite(stream.bit_rate ?? format.bit_rate),
	};
}
