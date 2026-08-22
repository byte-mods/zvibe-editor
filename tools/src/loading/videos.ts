import { Layer } from "@babylonjs/core/Layers/layer";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2 } from "@babylonjs/core/Maths/math.vector";
import { VideoTexture } from "@babylonjs/core/Materials/Textures/videoTexture";
import { Scene } from "@babylonjs/core/scene";

export const videoPlayerConfigurationVersion = 2 as const;

export type VideoPlayerSourceType = "asset" | "url";
export type VideoPlayerTargetMode = "material" | "renderTexture" | "cameraNearPlane" | "cameraFarPlane" | "apiOnly";
export type VideoPlayerUpdateMode = "audioTime" | "gameTime" | "unscaledGameTime";
export type VideoPlayerAspectRatio = "noScaling" | "fitVertically" | "fitHorizontally" | "fitInside" | "fitOutside" | "stretch";
export type VideoPlayerStereoLayout = "none" | "sideBySide" | "overUnder";
export type VideoPlayerStereoEye = "left" | "right";
export type VideoPlayerColorSpace = "auto" | "srgb" | "linear";
export type VideoPlayerAudioOutputMode = "direct" | "none";

export interface IVideoPlayerConfiguration {
	version: typeof videoPlayerConfigurationVersion;
	id: string;
	name: string;
	sourceType: VideoPlayerSourceType;
	path: string;
	targetMode: VideoPlayerTargetMode;
	materialId: string | null;
	textureSlot: "diffuseTexture" | "albedoTexture" | "emissiveTexture" | "opacityTexture";
	cameraId: string | null;
	playOnAwake: boolean;
	waitForFirstFrame: boolean;
	loop: boolean;
	skipOnDrop: boolean;
	playbackSpeed: number;
	updateMode: VideoPlayerUpdateMode;
	muted: boolean;
	volume: number;
	audioOutputMode: VideoPlayerAudioOutputMode;
	startTime: number;
	aspectRatio: VideoPlayerAspectRatio;
	alpha: number;
	stereoLayout: VideoPlayerStereoLayout;
	stereoEye: VideoPlayerStereoEye;
	colorSpace: VideoPlayerColorSpace;
}

export type VideoPlayerRuntimeStatus = "loading" | "ready" | "playing" | "paused" | "ended" | "error" | "disposed";

export interface IVideoPlayerRuntime {
	configuration: IVideoPlayerConfiguration;
	texture: VideoTexture;
	layer: Layer | null;
	status: VideoPlayerRuntimeStatus;
	error: string | null;
	manualPlaying: boolean;
	manualTime: number;
	resolvedSource: string;
	dispose: () => void;
}

export interface IResolvedImportedVideoSource {
	path: string;
	metadata: Record<string, unknown> | null;
}

declare module "@babylonjs/core/scene" {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface Scene {
		videoPlayers?: Map<string, VideoTexture>;
		videoRenderTextures?: Map<string, VideoTexture>;
		videoPlayerRuntimes?: Map<string, IVideoPlayerRuntime>;
	}
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const assetExtensions = new Set(["mp4", "webm", "ogv", "mov"]);
const textureSlots = new Set<IVideoPlayerConfiguration["textureSlot"]>(["diffuseTexture", "albedoTexture", "emissiveTexture", "opacityTexture"]);
const targetModes = new Set<VideoPlayerTargetMode>(["material", "renderTexture", "cameraNearPlane", "cameraFarPlane", "apiOnly"]);
const updateModes = new Set<VideoPlayerUpdateMode>(["audioTime", "gameTime", "unscaledGameTime"]);
const aspectRatios = new Set<VideoPlayerAspectRatio>(["noScaling", "fitVertically", "fitHorizontally", "fitInside", "fitOutside", "stretch"]);
const stereoLayouts = new Set<VideoPlayerStereoLayout>(["none", "sideBySide", "overUnder"]);
const stereoEyes = new Set<VideoPlayerStereoEye>(["left", "right"]);
const colorSpaces = new Set<VideoPlayerColorSpace>(["auto", "srgb", "linear"]);
const audioOutputModes = new Set<VideoPlayerAudioOutputMode>(["direct", "none"]);

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) {
		throw new Error(`${label} must contain 1-${maximum} characters without control line breaks.`);
	}
	return value.trim();
}

function identifier(value: unknown, label: string): string {
	const result = text(value, label, 128);
	if (!identifierPattern.test(result)) {
		throw new Error(`${label} must be a portable identifier.`);
	}
	return result;
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean.`);
	}
	return value;
}

function finite(value: unknown, label: string, minimum: number, maximum: number, fallback: number): number {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isFinite(result) || result < minimum || result > maximum) {
		throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
	}
	return result;
}

function enumValue<T extends string>(value: unknown, values: ReadonlySet<T>, label: string, fallback: T): T {
	const result = value === undefined ? fallback : value;
	if (typeof result !== "string" || !values.has(result as T)) {
		throw new Error(`${label} must be one of: ${[...values].join(", ")}.`);
	}
	return result as T;
}

function assetPath(value: unknown): string {
	const path = text(value, "Video asset path", 1024).replace(/\\/g, "/");
	const extension = path.split(".").pop()?.toLowerCase() ?? "";
	if (path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || !assetExtensions.has(extension)) {
		throw new Error("Video asset path must be a normalized project-relative .mp4, .webm, .ogv, or .mov path.");
	}
	return path;
}

function remoteUrl(value: unknown): string {
	const source = text(value, "Video URL", 4096);
	let parsed: URL;
	try {
		parsed = new URL(source);
	} catch {
		throw new Error("Video URL must be an absolute HTTP or HTTPS URL.");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Video URL must use HTTP or HTTPS.");
	}
	return parsed.toString();
}

/** Migrates legacy material players and validates the complete persisted version-2 contract. */
export function normalizeVideoPlayerConfiguration(value: unknown): IVideoPlayerConfiguration {
	const source = record(value, "Video player");
	const sourceType = enumValue(source.sourceType, new Set<VideoPlayerSourceType>(["asset", "url"]), "Video sourceType", "asset");
	const targetMode = enumValue(source.targetMode, targetModes, "Video targetMode", "material");
	const materialId = source.materialId === null || source.materialId === undefined ? null : text(source.materialId, "Video materialId");
	const cameraId = source.cameraId === null || source.cameraId === undefined ? null : text(source.cameraId, "Video cameraId");
	if (targetMode === "material" && !materialId) {
		throw new Error("Material-targeted video players require materialId.");
	}
	return {
		version: videoPlayerConfigurationVersion,
		id: identifier(source.id, "Video player id"),
		name: text(source.name, "Video player name"),
		sourceType,
		path: sourceType === "asset" ? assetPath(source.path) : remoteUrl(source.path),
		targetMode,
		materialId,
		textureSlot: enumValue(source.textureSlot, textureSlots, "Video textureSlot", "diffuseTexture"),
		cameraId,
		playOnAwake: boolean(source.playOnAwake ?? source.autoPlay, "Video playOnAwake", true),
		waitForFirstFrame: boolean(source.waitForFirstFrame, "Video waitForFirstFrame", true),
		loop: boolean(source.loop, "Video loop", true),
		skipOnDrop: boolean(source.skipOnDrop, "Video skipOnDrop", true),
		playbackSpeed: finite(source.playbackSpeed, "Video playbackSpeed", 0.01, 10, 1),
		updateMode: enumValue(source.updateMode, updateModes, "Video updateMode", "audioTime"),
		muted: boolean(source.muted, "Video muted", true),
		volume: finite(source.volume, "Video volume", 0, 1, 1),
		audioOutputMode: enumValue(source.audioOutputMode, audioOutputModes, "Video audioOutputMode", "direct"),
		startTime: finite(source.startTime, "Video startTime", 0, 86_400, 0),
		aspectRatio: enumValue(source.aspectRatio, aspectRatios, "Video aspectRatio", "fitInside"),
		alpha: finite(source.alpha, "Video alpha", 0, 1, 1),
		stereoLayout: enumValue(source.stereoLayout, stereoLayouts, "Video stereoLayout", "none"),
		stereoEye: enumValue(source.stereoEye, stereoEyes, "Video stereoEye", "left"),
		colorSpace: enumValue(source.colorSpace, colorSpaces, "Video colorSpace", "auto"),
	};
}

/** Resolves the portable imported output and retains its probe/compatibility sidecar as evidence. */
export async function resolveImportedVideoSource(rootUrl: string, path: string): Promise<IResolvedImportedVideoSource> {
	try {
		const response = await fetch(`${rootUrl}${path}.bjsvideo.json`);
		if (!response.ok) {
			return { path, metadata: null };
		}
		const metadata = (await response.json()) as Record<string, unknown>;
		return { path: typeof metadata.outputPath === "string" && metadata.outputPath ? metadata.outputPath : path, metadata };
	} catch {
		return { path, metadata: null };
	}
}

export async function resolveImportedVideoPath(rootUrl: string, path: string): Promise<string> {
	return (await resolveImportedVideoSource(rootUrl, path)).path;
}

/** Resolves a complete player source while allowing authoring hosts to bypass runtime redirect probing with an already verified local artifact URL. */
export async function resolveConfiguredVideoPlayerSource(
	rootUrl: string,
	configuration: IVideoPlayerConfiguration,
	resolvedAssetSource?: string
): Promise<{ source: string; metadata: Record<string, unknown> | null }> {
	if (configuration.sourceType === "url") {
		return { source: configuration.path, metadata: null };
	}
	if (resolvedAssetSource) {
		return { source: resolvedAssetSource, metadata: null };
	}
	const imported = await resolveImportedVideoSource(rootUrl, configuration.path);
	return { source: `${rootUrl}${imported.path}`, metadata: imported.metadata };
}

function applyStereoLayout(texture: VideoTexture, configuration: IVideoPlayerConfiguration): void {
	texture.uScale = 1;
	texture.vScale = 1;
	texture.uOffset = 0;
	texture.vOffset = 0;
	if (configuration.stereoLayout === "sideBySide") {
		texture.uScale = 0.5;
		texture.uOffset = configuration.stereoEye === "right" ? 0.5 : 0;
	} else if (configuration.stereoLayout === "overUnder") {
		texture.vScale = 0.5;
		texture.vOffset = configuration.stereoEye === "right" ? 0.5 : 0;
	}
}

function applyLayerAspect(layer: Layer, texture: VideoTexture, configuration: IVideoPlayerConfiguration, scene: Scene): void {
	const width = texture.video.videoWidth;
	const height = texture.video.videoHeight;
	if (!width || !height) {
		return;
	}
	const engine = scene.getEngine();
	const targetWidth = Math.max(1, engine.getRenderWidth());
	const targetHeight = Math.max(1, engine.getRenderHeight());
	const sourceAspect = width / height;
	const targetAspect = targetWidth / targetHeight;
	let scale = Vector2.One();
	if (configuration.aspectRatio === "noScaling") {
		scale = new Vector2(Math.min(1, width / targetWidth), Math.min(1, height / targetHeight));
	} else if (configuration.aspectRatio === "fitHorizontally") {
		scale = new Vector2(1, Math.min(1, targetAspect / sourceAspect));
	} else if (configuration.aspectRatio === "fitVertically") {
		scale = new Vector2(Math.min(1, sourceAspect / targetAspect), 1);
	} else if (configuration.aspectRatio === "fitInside") {
		scale = sourceAspect > targetAspect ? new Vector2(1, targetAspect / sourceAspect) : new Vector2(sourceAspect / targetAspect, 1);
	} else if (configuration.aspectRatio === "fitOutside") {
		scale = sourceAspect > targetAspect ? new Vector2(sourceAspect / targetAspect, 1) : new Vector2(1, targetAspect / sourceAspect);
	}
	layer.scale.copyFrom(scale);
}

function waitUntilReady(video: HTMLVideoElement): Promise<void> {
	if (video.readyState >= video.HAVE_CURRENT_DATA) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		let timeout: ReturnType<typeof setTimeout>;
		let ready: EventListener;
		let failed: EventListener;
		const finish = (error?: Error): void => {
			clearTimeout(timeout);
			video.removeEventListener("canplay", ready);
			video.removeEventListener("error", failed);
			error ? reject(error) : resolve();
		};
		ready = (): void => finish();
		failed = (): void => finish(new Error(video.error?.message || "Video failed while waiting for its first frame."));
		timeout = setTimeout(() => finish(new Error("Video did not become ready within 10 seconds.")), 10_000);
		video.addEventListener("canplay", ready, { once: true });
		video.addEventListener("error", failed, { once: true });
	});
}

/** Creates one normalized runtime, including target attachment, exact cleanup, and manual clock modes. */
export async function configureVideoPlayer(scene: Scene, rootUrl: string, value: unknown, resolvedAssetSource?: string): Promise<IVideoPlayerRuntime> {
	const configuration = normalizeVideoPlayerConfiguration(value);
	disposeVideoPlayer(scene, configuration.id);
	const resolvedSource = (await resolveConfiguredVideoPlayerSource(rootUrl, configuration, resolvedAssetSource)).source;
	const manualClock = configuration.updateMode === "gameTime" || configuration.updateMode === "unscaledGameTime";
	const texture = new VideoTexture(configuration.name, resolvedSource, scene, false, true, undefined, {
		autoPlay: configuration.playOnAwake && !manualClock,
		loop: configuration.loop,
		muted: configuration.audioOutputMode === "none" || configuration.muted,
		autoUpdateTexture: true,
	});
	texture.video.volume = configuration.volume;
	texture.video.playbackRate = configuration.playbackSpeed;
	texture.video.preload = configuration.waitForFirstFrame ? "auto" : "metadata";
	texture.gammaSpace = configuration.colorSpace !== "linear";
	texture.hasAlpha = configuration.alpha < 1 || texture.hasAlpha;
	texture.level = configuration.alpha;
	applyStereoLayout(texture, configuration);

	let layer: Layer | null = null;
	let material: Record<string, unknown> | null = null;
	let previousMaterialTexture: unknown;
	if (configuration.targetMode === "material") {
		material = scene.getMaterialById(configuration.materialId!) as unknown as Record<string, unknown> | null;
		if (!material) {
			texture.dispose();
			throw new Error(`Video material "${configuration.materialId}" was not found.`);
		}
		previousMaterialTexture = material[configuration.textureSlot];
		material[configuration.textureSlot] = texture;
	} else if (configuration.targetMode === "cameraNearPlane" || configuration.targetMode === "cameraFarPlane") {
		const camera = configuration.cameraId ? scene.getCameraById(configuration.cameraId) : scene.activeCamera;
		if (!camera) {
			texture.dispose();
			throw new Error("Camera-targeted video players require an available camera.");
		}
		layer = new Layer(`__zvibeVideoLayer:${configuration.id}`, null, scene, configuration.targetMode === "cameraFarPlane", new Color4(1, 1, 1, configuration.alpha));
		layer.texture = texture;
		layer.layerMask = camera.layerMask;
		applyLayerAspect(layer, texture, configuration, scene);
	}

	const listenerDisposers: Array<() => void> = [];
	const runtime: IVideoPlayerRuntime = {
		configuration,
		texture,
		layer,
		status: "loading",
		error: null,
		manualPlaying: configuration.playOnAwake && manualClock,
		manualTime: configuration.startTime,
		resolvedSource,
		dispose: () => undefined,
	};
	const listen = (name: string, listener: EventListener): void => {
		texture.video.addEventListener(name, listener);
		listenerDisposers.push(() => texture.video.removeEventListener(name, listener));
	};
	listen("canplay", () => {
		runtime.status = runtime.manualPlaying || !texture.video.paused ? "playing" : "ready";
		if (layer) {
			applyLayerAspect(layer, texture, configuration, scene);
		}
	});
	listen("playing", () => (runtime.status = "playing"));
	listen("pause", () => {
		if (!runtime.manualPlaying && runtime.status !== "ended") {
			runtime.status = "paused";
		}
	});
	listen("ended", () => (runtime.status = "ended"));
	listen("error", () => {
		runtime.status = "error";
		runtime.error = texture.video.error?.message || "Video playback failed.";
	});
	if (configuration.startTime > 0) {
		listen("loadedmetadata", () => (texture.video.currentTime = Math.min(configuration.startTime, texture.video.duration || configuration.startTime)));
	}

	const observer = scene.onBeforeRenderObservable.add(() => {
		if (layer) {
			applyLayerAspect(layer, texture, configuration, scene);
		}
		if (!manualClock || !runtime.manualPlaying || texture.video.readyState < texture.video.HAVE_METADATA) {
			return;
		}
		const rawDelta = Math.max(0, scene.getEngine().getDeltaTime()) / 1000;
		const scaledDelta = configuration.updateMode === "gameTime" ? rawDelta * finite(scene.metadata?.babylonEditorTimeScale, "Scene time scale", 0, 100, 1) : rawDelta;
		runtime.manualTime += (configuration.skipOnDrop ? scaledDelta : Math.min(scaledDelta, 1 / 30)) * configuration.playbackSpeed;
		const duration = texture.video.duration;
		if (Number.isFinite(duration) && duration > 0 && runtime.manualTime >= duration) {
			if (configuration.loop) {
				runtime.manualTime %= duration;
			} else {
				runtime.manualTime = duration;
				runtime.manualPlaying = false;
				runtime.status = "ended";
			}
		}
		if (Math.abs(texture.video.currentTime - runtime.manualTime) > 0.0005) {
			texture.video.currentTime = runtime.manualTime;
		}
		texture.updateTexture(true);
	});

	scene.videoPlayers ??= new Map();
	scene.videoRenderTextures ??= new Map();
	scene.videoPlayerRuntimes ??= new Map();
	scene.videoPlayers.set(configuration.id, texture);
	if (configuration.targetMode === "renderTexture") {
		scene.videoRenderTextures.set(configuration.id, texture);
	}
	scene.videoPlayerRuntimes.set(configuration.id, runtime);
	runtime.dispose = (): void => {
		if (runtime.status === "disposed") {
			return;
		}
		runtime.status = "disposed";
		runtime.manualPlaying = false;
		scene.onBeforeRenderObservable.remove(observer);
		listenerDisposers.forEach((dispose) => dispose());
		if (material && material[configuration.textureSlot] === texture) {
			material[configuration.textureSlot] = previousMaterialTexture;
		}
		layer?.dispose();
		scene.videoPlayers?.delete(configuration.id);
		scene.videoRenderTextures?.delete(configuration.id);
		if (scene.videoPlayerRuntimes?.get(configuration.id) === runtime) {
			scene.videoPlayerRuntimes.delete(configuration.id);
		}
		texture.dispose();
	};
	return runtime;
}

/** Plays one runtime using either the browser media clock or its deterministic scene clock. */
export async function playConfiguredVideoPlayer(runtime: IVideoPlayerRuntime): Promise<void> {
	if (runtime.configuration.waitForFirstFrame) {
		await waitUntilReady(runtime.texture.video);
	}
	if (runtime.configuration.updateMode === "audioTime") {
		await runtime.texture.video.play();
	} else {
		runtime.texture.video.pause();
		runtime.manualPlaying = true;
		runtime.status = "playing";
	}
}

/** Pauses one runtime without losing its exact playback position. */
export function pauseConfiguredVideoPlayer(runtime: IVideoPlayerRuntime): void {
	runtime.manualPlaying = false;
	runtime.texture.video.pause();
	runtime.status = "paused";
}

/** Seeks one runtime and refreshes the GPU texture at the requested second. */
export function seekConfiguredVideoPlayer(runtime: IVideoPlayerRuntime, time: number): void {
	if (!Number.isFinite(time) || time < 0) {
		throw new Error("Video seek time must be a non-negative finite number.");
	}
	const duration = runtime.texture.video.duration;
	runtime.manualTime = Number.isFinite(duration) && duration > 0 ? Math.min(time, duration) : time;
	runtime.texture.video.currentTime = runtime.manualTime;
	runtime.texture.updateTexture(true);
}

/** Disposes one player and restores any material texture it temporarily replaced. */
export function disposeVideoPlayer(scene: Scene, playerId: string): boolean {
	const runtime = scene.videoPlayerRuntimes?.get(playerId);
	if (!runtime) {
		return false;
	}
	runtime.dispose();
	return true;
}

/** Recreates all persisted players after scene loading and migrates legacy entries in memory. */
export async function configureVideoPlayers(scene: Scene, rootUrl: string): Promise<void> {
	for (const runtime of [...(scene.videoPlayerRuntimes?.values() ?? [])]) {
		runtime.dispose();
	}
	const raw = scene.metadata?.babylonEditorVideoPlayers;
	if (!Array.isArray(raw) || !raw.length) {
		return;
	}
	const players = raw.map((value) => normalizeVideoPlayerConfiguration(value));
	scene.metadata.babylonEditorVideoPlayers = players;
	for (const player of players) {
		await configureVideoPlayer(scene, rootUrl, player);
	}
}
