import { randomUUID } from "crypto";
import { closeSync, openSync, writeSync } from "fs";
import { basename, dirname, extname, join } from "path/posix";

import { ensureDir, move, pathExists, remove, writeFile } from "fs-extra";
import ffmpeg from "fluent-ffmpeg";
import { Muxer, StreamTarget } from "webm-muxer";

import { ICinematicCapturePlan, ICinematicCaptureSample } from "babylonjs-editor-tools";

import { Editor } from "../../../main";
import { resolveMediaExecutable } from "../../../../mcp/assets/media-executables";

import { encodeCinematicAudioWav, ICinematicRenderedAudio } from "./audio-capture";
import { ICinematicCaptureSink } from "./recorder";

/** Summarizes concrete files produced by a completed capture transaction. */
export interface ICinematicFileCaptureResult {
	destination: string;
	frameCount: number;
	format: ICinematicCapturePlan["profile"]["format"];
	audio: null | {
		mode: "offline-master-bus";
		codec: "opus" | "aac";
		sampleRate: number;
		channelCount: number;
		durationSeconds: number;
		sourceCount: number;
		busCount: number;
		effectCount: number;
		returnSendCount: number;
		sidechainSendCount: number;
	};
}

/** Describes one shell-free FFmpeg video conversion or audio mux operation. */
export interface ICinematicVideoTranscodeRequest {
	inputPath: string;
	outputPath: string;
	framesPerSecond: number;
	format: "webm" | "mp4";
	audioPath?: string;
}

/** Converts the temporary deterministic WebM stream into a requested final container. */
export type TCinematicVideoTranscoder = (request: ICinematicVideoTranscodeRequest) => Promise<void>;

/** Supplies the canvas, final destination, and optional MP4 conversion implementation. */
export interface ICinematicFileCaptureSinkOptions {
	canvas: HTMLCanvasElement;
	destination: string;
	transcodeToMp4?: TCinematicVideoTranscoder;
	renderAudio?: (plan: ICinematicCapturePlan) => Promise<ICinematicRenderedAudio>;
}

/** Adds the profile extension when the native save dialog returns a bare path. */
export function ensureCinematicCaptureExtension(destination: string, format: ICinematicCapturePlan["profile"]["format"]): string {
	return extname(destination).toLowerCase() === `.${format}` ? destination : `${destination}.${format}`;
}

/** Encodes rendered canvas frames into an atomic video file or an isolated image-sequence folder. */
export class CinematicFileCaptureSink implements ICinematicCaptureSink<ICinematicFileCaptureResult> {
	public readonly supportsAudio: boolean;

	private readonly _canvas: HTMLCanvasElement;
	private readonly _destination: string;
	private readonly _transcodeToMp4?: TCinematicVideoTranscoder;
	private readonly _renderAudio?: (plan: ICinematicCapturePlan) => Promise<ICinematicRenderedAudio>;
	private _plan: ICinematicCapturePlan | null = null;
	private _temporaryPath: string | null = null;
	private _outputPath: string | null = null;
	private _muxer: Muxer<StreamTarget> | null = null;
	private _encoder: VideoEncoder | null = null;
	private _encoderError: Error | null = null;
	private _fileDescriptor: number | null = null;
	private _temporaryAudioPath: string | null = null;
	private _renderedAudio: ICinematicRenderedAudio | null = null;

	public constructor(options: ICinematicFileCaptureSinkOptions) {
		this._canvas = options.canvas;
		this._destination = options.destination;
		this._transcodeToMp4 = options.transcodeToMp4;
		this._renderAudio = options.renderAudio;
		this.supportsAudio = !!options.transcodeToMp4 && !!options.renderAudio;
	}

	/** Allocates only temporary output so cancellation never leaves a partially valid destination. */
	public async begin(plan: ICinematicCapturePlan): Promise<void> {
		if (this._plan) {
			throw new Error("Cinematic file capture sink is already active.");
		}
		this._plan = structuredClone(plan);
		try {
			if (plan.profile.includeAudio && (plan.profile.format === "png" || plan.profile.format === "jpeg" || plan.profile.format === "webp")) {
				throw new Error("Cinematic offline audio can be muxed only into WebM or MP4 captures.");
			}
			if (plan.profile.includeAudio && (!this._renderAudio || !this._transcodeToMp4)) {
				throw new Error("Cinematic offline audio capture requires the editor audio renderer and FFmpeg muxer.");
			}
			if (plan.profile.format === "png" || plan.profile.format === "jpeg" || plan.profile.format === "webp") {
				const extension = extname(this._destination);
				const stem = basename(this._destination, extension);
				this._outputPath = join(dirname(this._destination), `${stem}-frames`);
				if (await pathExists(this._outputPath)) {
					throw new Error(`Cinematic image-sequence destination already exists: ${this._outputPath}`);
				}
				this._temporaryPath = join(dirname(this._destination), `.${stem}-frames-${randomUUID()}.tmp`);
				await ensureDir(this._temporaryPath);
				return;
			}
			if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") {
				throw new Error("This Electron renderer does not provide the WebCodecs API required for cinematic video capture.");
			}
			if (plan.profile.format === "mp4" && !this._transcodeToMp4) {
				throw new Error("MP4 cinematic capture requires the editor FFmpeg transcoder.");
			}
			await ensureDir(dirname(this._destination));
			this._outputPath = ensureCinematicCaptureExtension(this._destination, plan.profile.format);
			this._temporaryPath = join(dirname(this._outputPath), `.${basename(this._outputPath)}-${randomUUID()}.tmp.webm`);
			if (plan.profile.includeAudio) {
				this._renderedAudio = await this._renderAudio!(plan);
				this._temporaryAudioPath = `${this._temporaryPath}.wav`;
				await writeFile(this._temporaryAudioPath, encodeCinematicAudioWav(this._renderedAudio.buffer));
			}
			this._fileDescriptor = openSync(this._temporaryPath, "wx");
			this._muxer = new Muxer({
				target: new StreamTarget({
					chunked: true,
					chunkSize: 16 * 1024 * 1024,
					onData: (data, position) => writeSync(this._fileDescriptor!, data, 0, data.byteLength, position),
				}),
				video: { codec: "V_VP9", width: plan.profile.width, height: plan.profile.height, frameRate: plan.profile.framesPerSecond },
				firstTimestampBehavior: "offset",
			});
			this._encoder = new VideoEncoder({
				output: (chunk, metadata) => this._muxer?.addVideoChunk(chunk, metadata),
				error: (exception) => (this._encoderError = exception instanceof Error ? exception : new Error(String(exception))),
			});
			this._encoder.configure({
				codec: "vp09.00.10.08",
				width: plan.profile.width,
				height: plan.profile.height,
				framerate: plan.profile.framesPerSecond,
				bitrate: Math.round(
					Math.min(100_000_000, Math.max(1_000_000, plan.profile.width * plan.profile.height * plan.profile.framesPerSecond * 0.12 * plan.profile.quality))
				),
				latencyMode: "quality",
			});
		} catch (exception) {
			await this.abort(exception);
			throw exception;
		}
	}

	/** Copies one fully rendered canvas image before the recorder advances the scene. */
	public async write(sample: ICinematicCaptureSample): Promise<void> {
		const plan = this._requiredPlan();
		if (this._canvas.width !== plan.profile.width || this._canvas.height !== plan.profile.height) {
			throw new Error(`Cinematic canvas is ${this._canvas.width}x${this._canvas.height}; profile requires ${plan.profile.width}x${plan.profile.height}.`);
		}
		if (plan.profile.format === "png" || plan.profile.format === "jpeg" || plan.profile.format === "webp") {
			const blob = await new Promise<Blob | null>((resolve) => this._canvas.toBlob(resolve, `image/${plan.profile.format}`, plan.profile.quality));
			if (!blob) {
				throw new Error(`Failed to encode cinematic ${plan.profile.format} frame ${sample.index}.`);
			}
			const filename = `${String(sample.index + 1).padStart(8, "0")}.${plan.profile.format}`;
			await writeFile(join(this._temporaryPath!, filename), Buffer.from(await blob.arrayBuffer()));
			return;
		}
		if (this._encoderError) {
			throw this._encoderError;
		}
		const frame = new VideoFrame(this._canvas, {
			timestamp: sample.timestampMicroseconds,
			duration: Math.round(1_000_000 / plan.profile.framesPerSecond),
		});
		try {
			this._encoder!.encode(frame, { keyFrame: sample.index % Math.max(1, Math.round(plan.profile.framesPerSecond * 2)) === 0 });
		} finally {
			frame.close();
		}
		if (this._encoder!.encodeQueueSize > 120) {
			await this._encoder!.flush();
		}
	}

	/** Finalizes the encoder and publishes one complete destination atomically. */
	public async complete(): Promise<ICinematicFileCaptureResult> {
		const plan = this._requiredPlan();
		const temporaryPath = this._temporaryPath!;
		const outputPath = this._outputPath!;
		if (plan.profile.format === "png" || plan.profile.format === "jpeg" || plan.profile.format === "webp") {
			await move(temporaryPath, outputPath);
			this._reset();
			return { destination: outputPath, frameCount: plan.frameCount, format: plan.profile.format, audio: null };
		}
		await this._encoder!.flush();
		if (this._encoderError) {
			throw this._encoderError;
		}
		this._muxer!.finalize();
		this._closeFile();
		this._encoder!.close();
		this._encoder = null;
		if (plan.profile.format === "mp4" || plan.profile.includeAudio) {
			const temporaryOutput = `${temporaryPath}.${plan.profile.format}`;
			await this._transcodeToMp4!({
				inputPath: temporaryPath,
				outputPath: temporaryOutput,
				framesPerSecond: plan.profile.framesPerSecond,
				format: plan.profile.format,
				audioPath: this._temporaryAudioPath ?? undefined,
			});
			await move(temporaryOutput, outputPath, { overwrite: true });
			await remove(temporaryPath);
		} else {
			await move(temporaryPath, outputPath, { overwrite: true });
		}
		if (this._temporaryAudioPath) {
			await remove(this._temporaryAudioPath);
		}
		const renderedAudio = this._renderedAudio;
		this._reset();
		return {
			destination: outputPath,
			frameCount: plan.frameCount,
			format: plan.profile.format,
			audio: renderedAudio
				? {
						mode: renderedAudio.inspection.mode,
						codec: renderedAudio.inspection.audioCodec!,
						sampleRate: renderedAudio.inspection.sampleRate,
						channelCount: renderedAudio.inspection.channelCount,
						durationSeconds: renderedAudio.inspection.durationSeconds,
						sourceCount: renderedAudio.inspection.sources.length,
						busCount: renderedAudio.inspection.mixer.busCount,
						effectCount: renderedAudio.inspection.mixer.effectCount,
						returnSendCount: renderedAudio.inspection.mixer.returnSendCount,
						sidechainSendCount: renderedAudio.inspection.mixer.sidechainSendCount,
					}
				: null,
		};
	}

	/** Discards temporary encoder state and every unpublished file after failure or cancellation. */
	public async abort(_reason: unknown): Promise<void> {
		if (this._encoder?.state !== "closed") {
			this._encoder?.close();
		}
		this._closeFile();
		const temporaryPath = this._temporaryPath;
		const temporaryAudioPath = this._temporaryAudioPath;
		this._reset();
		if (temporaryPath) {
			await remove(temporaryPath);
			await remove(`${temporaryPath}.mp4`);
			await remove(`${temporaryPath}.webm`);
		}
		if (temporaryAudioPath) {
			await remove(temporaryAudioPath);
		}
	}

	/** Rejects write/finalize calls that are not inside one active capture transaction. */
	private _requiredPlan(): ICinematicCapturePlan {
		if (!this._plan || !this._temporaryPath || !this._outputPath) {
			throw new Error("Cinematic file capture sink has not begun.");
		}
		return this._plan;
	}

	/** Releases references after complete or abort so one accidental reuse cannot corrupt output. */
	private _reset(): void {
		this._plan = null;
		this._temporaryPath = null;
		this._outputPath = null;
		this._muxer = null;
		this._encoder = null;
		this._encoderError = null;
		this._fileDescriptor = null;
		this._temporaryAudioPath = null;
		this._renderedAudio = null;
	}

	/** Closes the temporary stream exactly once before publish, transcode, or removal. */
	private _closeFile(): void {
		if (this._fileDescriptor !== null) {
			closeSync(this._fileDescriptor);
			this._fileDescriptor = null;
		}
	}
}

/** Creates the editor's bundled, non-shell MP4 transcoder. */
export function createEditorMp4Transcoder(editor: Editor): TCinematicVideoTranscoder {
	return async (request) => {
		const [ffmpegPath, ffprobePath] = await Promise.all([resolveMediaExecutable(editor, "ffmpeg"), resolveMediaExecutable(editor, "ffprobe")]);
		await new Promise<void>((resolve, reject) => {
			const command = ffmpeg(request.inputPath);
			if (request.audioPath) {
				command.input(request.audioPath);
			}
			const outputOptions =
				request.format === "mp4"
					? [request.audioPath ? "-c:a aac" : "-an", "-c:v libx264", "-pix_fmt yuv420p", "-movflags +faststart", ...(request.audioPath ? ["-shortest"] : [])]
					: ["-c:v copy", "-c:a libopus", "-b:a 192k", "-shortest"];
			command
				.setFfmpegPath(ffmpegPath)
				.setFfprobePath(ffprobePath)
				.fpsOutput(request.framesPerSecond)
				.outputOptions(outputOptions)
				.on("end", () => resolve())
				.on("error", (exception) => reject(exception))
				.save(request.outputPath);
		});
	};
}
