import type { IVideoImporterSettings, IVideoImportProbe, VideoImporterCodec, VideoImporterColorDefinition, VideoImporterEncoder, VideoImporterTranscode } from "./video-importer";

export type VideoImporterPlatform = "default" | "web" | "desktop";
export type VideoImporterOverridePlatform = Exclude<VideoImporterPlatform, "default">;

export interface IVideoImporterPlatformOverride {
	enabled: boolean;
	transcode?: VideoImporterTranscode;
	videoCodec?: VideoImporterCodec;
	encoder?: VideoImporterEncoder;
	quality?: number;
	maxWidth?: number;
	maxHeight?: number;
	includeAudio?: boolean;
	colorDefinition?: VideoImporterColorDefinition;
}

export type IVideoImporterPlatformOverrides = Partial<Record<VideoImporterOverridePlatform, IVideoImporterPlatformOverride>>;

export interface IResolvedVideoImporterPlatformSettings {
	platform: VideoImporterPlatform;
	overrideApplied: boolean;
	override: IVideoImporterPlatformOverride | null;
	settings: IVideoImporterSettings;
}

export interface IVideoCodecMatrixEntry {
	container: "mp4" | "webm" | "ogv";
	videoCodec: "h264" | "h265" | "vp8" | "vp9" | "theora";
	audioCodecs: readonly string[];
	support: "supported" | "conditional";
	hardwareDecode: "common" | "deviceDependent" | "unlikely";
	notes: string;
}

export interface IVideoPlatformCodecMatrix {
	platform: VideoImporterPlatform;
	recommendedContainer: "mp4" | "webm";
	recommendedVideoCodec: "h264" | "vp9";
	entries: readonly IVideoCodecMatrixEntry[];
}

export interface IVideoPlatformCompatibility {
	platform: VideoImporterPlatform;
	container: string;
	videoCodec: string;
	audioCodec: string | null;
	status: "supported" | "conditional" | "unsupported" | "notEvaluated";
	hardwareDecode: IVideoCodecMatrixEntry["hardwareDecode"] | "unknown";
	recommendation: string;
}

const maximumJsonLength = 65_536;
const overrideKeys = new Set(["enabled", "transcode", "videoCodec", "encoder", "quality", "maxWidth", "maxHeight", "includeAudio", "colorDefinition"]);
const transcodes = ["preserve", "webm", "mp4"] as const;
const codecs = ["auto", "h264", "h265", "vp8", "vp9"] as const;
const encoders = ["auto", "software", "videotoolbox", "nvenc", "qsv", "amf"] as const;
const colorDefinitions = ["preserve", "rec709"] as const;

const matrices: Record<Exclude<VideoImporterPlatform, "default">, IVideoPlatformCodecMatrix> = {
	web: {
		platform: "web",
		recommendedContainer: "mp4",
		recommendedVideoCodec: "h264",
		entries: [
			{
				container: "mp4",
				videoCodec: "h264",
				audioCodecs: ["aac", "mp3"],
				support: "supported",
				hardwareDecode: "common",
				notes: "Most portable browser path; availability still follows the browser and operating-system codec build.",
			},
			{
				container: "mp4",
				videoCodec: "h265",
				audioCodecs: ["aac"],
				support: "conditional",
				hardwareDecode: "deviceDependent",
				notes: "HEVC browser support depends on operating-system media components and device licensing.",
			},
			{
				container: "webm",
				videoCodec: "vp8",
				audioCodecs: ["vorbis", "opus"],
				support: "supported",
				hardwareDecode: "deviceDependent",
				notes: "Portable WebM fallback with broader legacy browser support than VP9.",
			},
			{
				container: "webm",
				videoCodec: "vp9",
				audioCodecs: ["vorbis", "opus"],
				support: "supported",
				hardwareDecode: "deviceDependent",
				notes: "Modern browser WebM path; older devices can decode in software.",
			},
			{
				container: "ogv",
				videoCodec: "theora",
				audioCodecs: ["vorbis"],
				support: "conditional",
				hardwareDecode: "unlikely",
				notes: "Legacy browser path; prefer H.264 MP4 or VP8/VP9 WebM for production builds.",
			},
		],
	},
	desktop: {
		platform: "desktop",
		recommendedContainer: "mp4",
		recommendedVideoCodec: "h264",
		entries: [
			{
				container: "mp4",
				videoCodec: "h264",
				audioCodecs: ["aac", "mp3"],
				support: "supported",
				hardwareDecode: "common",
				notes: "Portable Electron/Chromium desktop path with common hardware decoding.",
			},
			{
				container: "mp4",
				videoCodec: "h265",
				audioCodecs: ["aac"],
				support: "conditional",
				hardwareDecode: "deviceDependent",
				notes: "HEVC depends on the packaged Chromium build and operating-system codec availability.",
			},
			{
				container: "webm",
				videoCodec: "vp8",
				audioCodecs: ["vorbis", "opus"],
				support: "supported",
				hardwareDecode: "deviceDependent",
				notes: "Bundled Chromium-compatible software fallback.",
			},
			{
				container: "webm",
				videoCodec: "vp9",
				audioCodecs: ["vorbis", "opus"],
				support: "supported",
				hardwareDecode: "deviceDependent",
				notes: "Bundled Chromium-compatible modern WebM path.",
			},
			{
				container: "ogv",
				videoCodec: "theora",
				audioCodecs: ["vorbis"],
				support: "conditional",
				hardwareDecode: "unlikely",
				notes: "Software-only legacy fallback; not recommended for shipped content.",
			},
		],
	},
};

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function optionalEnum<T extends string>(source: Record<string, unknown>, key: string, values: readonly T[]): T | undefined {
	const value = source[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`Video platform override ${key} must be one of: ${values.join(", ")}.`);
	}
	return value as T;
}

function optionalNumber(source: Record<string, unknown>, key: "quality" | "maxWidth" | "maxHeight"): number | undefined {
	const value = source[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`Video platform override ${key} must be a finite number.`);
	}
	if (key === "quality" && (value < 0 || value > 1)) {
		throw new Error("Video platform override quality must be between 0 and 1.");
	}
	if (key !== "quality" && (!Number.isInteger(value) || value < 64 || value > 8192 || value % 2 !== 0)) {
		throw new Error(`Video platform override ${key} must be an even integer from 64 through 8192.`);
	}
	return value;
}

function normalizeOverride(value: unknown): IVideoImporterPlatformOverride {
	const source = record(value, "Video platform override");
	const unknown = Object.keys(source).filter((key) => !overrideKeys.has(key));
	if (unknown.length) {
		throw new Error(`Unsupported video platform override setting(s): ${unknown.sort().join(", ")}.`);
	}
	if (typeof source.enabled !== "boolean") {
		throw new Error("Video platform override enabled must be a boolean.");
	}
	if (source.includeAudio !== undefined && typeof source.includeAudio !== "boolean") {
		throw new Error("Video platform override includeAudio must be a boolean.");
	}
	const transcode = optionalEnum(source, "transcode", transcodes);
	const videoCodec = optionalEnum(source, "videoCodec", codecs);
	const encoder = optionalEnum(source, "encoder", encoders);
	const quality = optionalNumber(source, "quality");
	const maxWidth = optionalNumber(source, "maxWidth");
	const maxHeight = optionalNumber(source, "maxHeight");
	const colorDefinition = optionalEnum(source, "colorDefinition", colorDefinitions);
	return {
		enabled: source.enabled,
		...(transcode !== undefined ? { transcode } : {}),
		...(videoCodec !== undefined ? { videoCodec } : {}),
		...(encoder !== undefined ? { encoder } : {}),
		...(quality !== undefined ? { quality } : {}),
		...(maxWidth !== undefined ? { maxWidth } : {}),
		...(maxHeight !== undefined ? { maxHeight } : {}),
		...(source.includeAudio !== undefined ? { includeAudio: source.includeAudio } : {}),
		...(colorDefinition !== undefined ? { colorDefinition } : {}),
	};
}

/** Parses the persisted, closed Web/Desktop video override map. */
export function normalizeVideoImporterPlatformOverrides(value: unknown): IVideoImporterPlatformOverrides {
	if (value === undefined || value === null || value === "") {
		return {};
	}
	let parsed = value;
	if (typeof parsed === "string") {
		if (parsed.length > maximumJsonLength) {
			throw new Error(`Video platform overrides JSON is limited to ${maximumJsonLength} characters.`);
		}
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error("Video platform overrides must be valid JSON.");
		}
	}
	const source = record(parsed, "Video platform overrides");
	const unknown = Object.keys(source).filter((key) => key !== "web" && key !== "desktop");
	if (unknown.length) {
		throw new Error(`Unsupported video importer platform(s): ${unknown.sort().join(", ")}.`);
	}
	return {
		...(source.web !== undefined ? { web: normalizeOverride(source.web) } : {}),
		...(source.desktop !== undefined ? { desktop: normalizeOverride(source.desktop) } : {}),
	};
}

/** Serializes overrides deterministically for sidecars and cache fingerprints. */
export function serializeVideoImporterPlatformOverrides(value: unknown): string {
	const overrides = normalizeVideoImporterPlatformOverrides(value);
	return JSON.stringify({ ...(overrides.web ? { web: overrides.web } : {}), ...(overrides.desktop ? { desktop: overrides.desktop } : {}) });
}

/** Maps existing build-profile target names to executable video families. */
export function normalizeVideoImporterPlatform(value: unknown): VideoImporterPlatform {
	if (value === "web" || value === "android" || value === "ios" || value === "webxr") {
		return "web";
	}
	if (value === "desktop" || value === "electron") {
		return "desktop";
	}
	return "default";
}

/** Resolves immutable effective settings for a target without losing authored overrides. */
export function resolveVideoImporterPlatformSettings(settings: IVideoImporterSettings, requestedPlatform: unknown): IResolvedVideoImporterPlatformSettings {
	const platform = normalizeVideoImporterPlatform(requestedPlatform);
	const override = platform === "default" ? undefined : settings.platformOverrides[platform];
	if (!override?.enabled) {
		return { platform, overrideApplied: false, override: override ?? null, settings: structuredClone(settings) };
	}
	const { enabled: _enabled, ...values } = override;
	return {
		platform,
		overrideApplied: true,
		override: structuredClone(override),
		settings: { ...structuredClone(settings), ...structuredClone(values), platformOverrides: structuredClone(settings.platformOverrides) },
	};
}

/** Returns a cloned codec policy so callers cannot mutate the shared compatibility contract. */
export function getVideoPlatformCodecMatrix(requestedPlatform: unknown): IVideoPlatformCodecMatrix {
	const platform = normalizeVideoImporterPlatform(requestedPlatform);
	const effective = platform === "default" ? matrices.web : matrices[platform];
	return {
		...effective,
		platform,
		entries: effective.entries.map((entry) => ({ ...entry, audioCodecs: [...entry.audioCodecs] })),
	};
}

function probeContainer(container: string): "mp4" | "webm" | "ogv" | "unknown" {
	const value = container.toLowerCase();
	if (value.includes("webm") || value.includes("matroska")) {
		return "webm";
	}
	if (value.includes("ogg")) {
		return "ogv";
	}
	if (value.includes("mp4") || value.includes("mov") || value.includes("3gp") || value.includes("mj2")) {
		return "mp4";
	}
	return "unknown";
}

function probeCodec(codec: string): IVideoCodecMatrixEntry["videoCodec"] | "unknown" {
	const value = codec.toLowerCase();
	if (value === "hevc") {
		return "h265";
	}
	if (value === "h264" || value === "h265" || value === "vp8" || value === "vp9" || value === "theora") {
		return value;
	}
	return "unknown";
}

/** Evaluates actual FFprobe evidence against the selected target policy. */
export function evaluateVideoPlatformCompatibility(probe: IVideoImportProbe, requestedPlatform: unknown): IVideoPlatformCompatibility {
	const matrix = getVideoPlatformCodecMatrix(requestedPlatform);
	const container = probeContainer(probe.container);
	const videoCodec = probeCodec(probe.videoCodec);
	if (matrix.platform === "default") {
		return {
			platform: "default",
			container,
			videoCodec,
			audioCodec: probe.audioCodec,
			status: "notEvaluated",
			hardwareDecode: "unknown",
			recommendation: "Choose a Web or Desktop asset platform to enforce a codec policy.",
		};
	}
	const entry = matrix.entries.find((candidate) => candidate.container === container && candidate.videoCodec === videoCodec);
	const audioCompatible = !probe.audioCodec || Boolean(entry?.audioCodecs.includes(probe.audioCodec.toLowerCase()));
	if (!entry || !audioCompatible) {
		return {
			platform: matrix.platform,
			container,
			videoCodec,
			audioCodec: probe.audioCodec,
			status: "unsupported",
			hardwareDecode: "unknown",
			recommendation: `Transcode to ${matrix.recommendedVideoCodec.toUpperCase()} ${matrix.recommendedContainer.toUpperCase()} for the ${matrix.platform} target.`,
		};
	}
	return {
		platform: matrix.platform,
		container,
		videoCodec,
		audioCodec: probe.audioCodec,
		status: entry.support,
		hardwareDecode: entry.hardwareDecode,
		recommendation: entry.notes,
	};
}
