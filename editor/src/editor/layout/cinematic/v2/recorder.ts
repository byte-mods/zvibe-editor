import { Scene } from "@babylonjs/core/scene";

import {
	CinematicScenePlayer,
	ICinematicCapturePlan,
	ICinematicCaptureRange,
	ICinematicCaptureSample,
	ICinematicDocument,
	createCinematicCapturePlan,
	getCinematicCaptureSample,
} from "babylonjs-editor-tools";

/** Receives already-rendered frames and owns the destination-specific encoding transaction. */
export interface ICinematicCaptureSink<TResult> {
	readonly supportsAudio: boolean;
	begin(plan: ICinematicCapturePlan): Promise<void>;
	write(sample: ICinematicCaptureSample): Promise<void>;
	complete(): Promise<TResult>;
	abort(reason: unknown): Promise<void>;
}

/** Supplies rendering and progress hooks without coupling deterministic scheduling to the editor UI. */
export interface ICinematicRecorderOptions {
	range?: ICinematicCaptureRange;
	signal?: AbortSignal;
	onRenderFrame: (sample: ICinematicCaptureSample) => void | Promise<void>;
	onProgress?: (completedFrames: number, totalFrames: number) => void;
}

/** Reports the exact immutable plan alongside the backend's destination result. */
export interface ICinematicRecorderResult<TResult> {
	plan: ICinematicCapturePlan;
	output: TResult;
}

/** Drives a Babylon scene at exact output samples and restores all preview mutations transactionally. */
export class CinematicDocumentRecorder {
	private readonly _document: ICinematicDocument;
	private readonly _scene: Scene;
	private _recording = false;

	public constructor(document: ICinematicDocument, scene: Scene) {
		this._document = structuredClone(document);
		this._scene = scene;
	}

	/** Captures every planned frame serially so encoders observe stable scene state and timestamps. */
	public async record<TResult>(profileId: string, sink: ICinematicCaptureSink<TResult>, options: ICinematicRecorderOptions): Promise<ICinematicRecorderResult<TResult>> {
		if (this._recording) {
			throw new Error("This cinematic recorder is already capturing.");
		}
		const plan = createCinematicCapturePlan(this._document, profileId, options.range);
		if (plan.profile.includeAudio && !sink.supportsAudio) {
			throw new Error(`Cinematic capture backend does not support audio required by profile "${profileId}".`);
		}
		this._recording = true;
		const player = new CinematicScenePlayer(this._document, this._scene, { ignoreSounds: true });
		let began = false;
		try {
			this._assertNotCancelled(options.signal);
			await sink.begin(plan);
			began = true;
			for (let index = 0; index < plan.frameCount; ++index) {
				this._assertNotCancelled(options.signal);
				const sample = getCinematicCaptureSample(plan, index);
				player.seek(sample.timelineFrame);
				await options.onRenderFrame(sample);
				await sink.write(sample);
				options.onProgress?.(index + 1, plan.frameCount);
				// Let Electron service IPC/MCP requests run between frames so an AbortController
				// can actually stop fast synchronous image sinks before the full range completes.
				await new Promise<void>((resolve) => setTimeout(resolve, 10));
			}
			const output = await sink.complete();
			began = false;
			return { plan, output };
		} catch (exception) {
			if (began) {
				await sink.abort(exception).catch(() => undefined);
			}
			throw exception;
		} finally {
			player.dispose();
			this._recording = false;
		}
	}

	/** Converts cancellation into the same explicit failure path used by encoder errors. */
	private _assertNotCancelled(signal: AbortSignal | undefined): void {
		if (signal?.aborted) {
			throw signal.reason ?? new Error("Cinematic capture was cancelled.");
		}
	}
}
